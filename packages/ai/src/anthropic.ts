import Anthropic from "@anthropic-ai/sdk";
import { AppError } from "@arcatic/core";
import { z } from "zod";
import type { LlmProvider, StructuredRequest, StructuredResult, Tracer } from "./provider.js";
import { noopTracer } from "./provider.js";

/**
 * Anthropic provider: structured JSON output (output_config.format = JSON schema derived
 * from the zod schema), validated again with zod on our side; server-side refusal
 * fallbacks enabled; stable system prompt marked for prompt caching.
 */
export class AnthropicProvider implements LlmProvider {
  private readonly client: Anthropic;

  constructor(opts: { apiKey?: string; client?: Anthropic; tracer?: Tracer } = {}) {
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.tracer = opts.tracer ?? noopTracer;
  }

  private readonly tracer: Tracer;

  async generateStructured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>> {
    const startedAt = new Date();
    const schema = z.toJSONSchema(req.schema, { target: "draft-2020-12" }) as Record<string, unknown>;
    delete schema.$schema;

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await this.client.beta.messages.create(
        {
          model: req.model,
          max_tokens: req.maxTokens ?? 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: req.effort, format: { type: "json_schema", schema } },
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: [{
            role: "user",
            content: req.images?.length
              ? [...req.images.map((im) => ({ type: "image" as const, source: { type: "base64" as const, media_type: im.mediaType, data: im.data } })), { type: "text" as const, text: req.user }]
              : req.user,
          }],
          metadata: { user_id: req.metadata.workspaceId },
        },
        { signal: req.signal },
      );
    } catch (err) {
      const mapped = mapSdkError(err);
      await this.trace(req, startedAt, { error: mapped.message });
      throw mapped;
    }

    const usage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    };
    const servedByFallback = (message.usage.iterations ?? []).some((i) => i.type === "fallback_message");

    if (message.stop_reason === "refusal") {
      const category = message.stop_details?.category ?? null;
      await this.trace(req, startedAt, { usage, error: `refusal:${category}` });
      throw new AppError("upstream_error", "The model declined this request.", {
        retryable: false,
        details: { stop_reason: "refusal", category },
      });
    }
    if (message.stop_reason === "max_tokens") {
      await this.trace(req, startedAt, { usage, error: "max_tokens" });
      throw new AppError("upstream_error", "Output was cut off (max_tokens).", { retryable: true });
    }

    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      await this.trace(req, startedAt, { usage, error: "invalid_json" });
      throw new AppError("upstream_error", "Model returned invalid JSON.", { retryable: true });
    }
    const result = req.schema.safeParse(parsed);
    if (!result.success) {
      await this.trace(req, startedAt, { usage, error: "schema_mismatch", output: parsed });
      throw new AppError("upstream_error", "Model output did not match schema.", {
        retryable: true,
        details: z.treeifyError(result.error),
      });
    }

    await this.trace(req, startedAt, { usage, output: result.data, model: message.model });
    return { output: result.data, model: message.model, usage, stopReason: message.stop_reason, servedByFallback };
  }

  private async trace(
    req: StructuredRequest<z.ZodType>,
    startedAt: Date,
    extra: { usage?: StructuredResult<unknown>["usage"]; output?: unknown; error?: string; model?: string },
  ) {
    try {
      await this.tracer.record({
        name: req.metadata.template,
        workspaceId: req.metadata.workspaceId,
        jobId: req.metadata.jobId,
        template: req.metadata.template,
        model: extra.model ?? req.model,
        input: { system: req.system, user: req.user },
        output: extra.output,
        usage: extra.usage,
        error: extra.error,
        startedAt,
        endedAt: new Date(),
      });
    } catch {
      // tracing must never fail a generation
    }
  }
}

function mapSdkError(err: unknown): AppError {
  if (err instanceof Anthropic.RateLimitError) return new AppError("rate_limited", "Model provider rate limit.", { cause: err });
  if (err instanceof Anthropic.BadRequestError) return new AppError("upstream_error", err.message, { retryable: false, cause: err });
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AppError("upstream_error", "Model provider credentials rejected.", { retryable: false, cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) return new AppError("upstream_error", "Model provider unreachable.", { cause: err });
  if (err instanceof Anthropic.APIError) {
    const retryable = (err.status ?? 500) >= 500;
    return new AppError("upstream_error", err.message, { retryable, cause: err });
  }
  if (err instanceof Error && err.name === "AbortError") return new AppError("upstream_error", "Cancelled.", { retryable: false, cause: err });
  return new AppError("internal", err instanceof Error ? err.message : "Unknown model error", { cause: err });
}
