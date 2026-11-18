import { randomBytes } from "node:crypto";

/**
 * Langfuse (langfuse-main): traces via OTLP/HTTP JSON at POST /api/public/otel/v1/traces
 * (the batch /api/public/ingestion API is deprecated for traces and only keeps score events);
 * scores via POST /api/public/scores. Both use Basic auth publicKey:secretKey.
 * Span attributes are the ones Langfuse's OtelIngestionProcessor reads (otel/attributes.ts):
 *   langfuse.trace.name, langfuse.observation.type, langfuse.observation.model.name,
 *   langfuse.observation.input/output, langfuse.observation.metadata.*, gen_ai.usage.input_tokens/output_tokens,
 *   langfuse.observation.prompt.name / .version, user.id / session.id, langfuse.trace.tags.
 */
export interface LangfuseConfig { host: string; publicKey: string; secretKey: string; fetchImpl?: typeof fetch; environment?: string }

/** Trace id for a job: the job's UUID as 32 hex chars, so scores can be attached later. */
export const traceIdForJob = (jobId: string) => jobId.replace(/-/g, "").toLowerCase().padEnd(32, "0").slice(0, 32);

type AttrValue = { stringValue: string } | { intValue: string } | { boolValue: boolean } | { doubleValue: number };
const attr = (key: string, v: string | number | boolean | undefined | null): { key: string; value: AttrValue } | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return { key, value: { boolValue: v } };
  if (typeof v === "number") return Number.isInteger(v) ? { key, value: { intValue: String(v) } } : { key, value: { doubleValue: v } };
  return { key, value: { stringValue: v } };
};
const nanos = (d: Date) => `${BigInt(d.getTime()) * 1_000_000n}`;
const clip = (s: string, n = 20_000) => (s.length > n ? `${s.slice(0, n)}…[truncated]` : s);

export class LangfuseClient {
  private readonly auth: string;
  constructor(private readonly cfg: LangfuseConfig) {
    this.auth = `Basic ${Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64")}`;
  }
  private async post(path: string, body: unknown) {
    const res = await (this.cfg.fetchImpl ?? fetch)(`${this.cfg.host.replace(/\/+$/, "")}${path}`, {
      method: "POST", headers: { authorization: this.auth, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`langfuse ${path} → ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }

  /** One generation as one OTLP span (its own trace when the job id is the trace). */
  async generation(e: {
    traceId: string; name: string; model: string; template: string; workspaceId: string; startedAt: Date; endedAt: Date;
    input?: unknown; output?: unknown; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }; error?: string;
  }) {
    const [prompt, version] = e.template.split("@");
    const attributes = [
      attr("langfuse.trace.name", e.name), attr("langfuse.observation.type", "generation"), attr("langfuse.observation.model.name", e.model),
      attr("gen_ai.request.model", e.model), attr("langfuse.environment", this.cfg.environment ?? "production"),
      attr("langfuse.observation.metadata.template", e.template), attr("langfuse.observation.metadata.workspace_id", e.workspaceId),
      attr("langfuse.trace.metadata.workspace_id", e.workspaceId), attr("session.id", e.workspaceId),
      attr("langfuse.observation.input", e.input === undefined ? undefined : clip(JSON.stringify(e.input))),
      attr("langfuse.observation.output", e.output === undefined ? undefined : clip(JSON.stringify(e.output))),
      attr("gen_ai.usage.input_tokens", e.usage?.inputTokens), attr("gen_ai.usage.output_tokens", e.usage?.outputTokens),
      e.usage ? attr("langfuse.observation.usage_details", JSON.stringify({ input: e.usage.inputTokens, output: e.usage.outputTokens, cache_read_input_tokens: e.usage.cacheReadTokens ?? 0, cache_creation_input_tokens: e.usage.cacheWriteTokens ?? 0 })) : null,
      attr("langfuse.observation.level", e.error ? "ERROR" : undefined), attr("langfuse.observation.status_message", e.error),
      attr("langfuse.trace.tags", JSON.stringify([prompt, e.model].filter(Boolean))),
      ...(version && /^\d+$/.test(version) ? [attr("langfuse.observation.prompt.name", prompt), attr("langfuse.observation.prompt.version", Number(version))] : []),
    ].filter((a): a is NonNullable<typeof a> => a !== null);
    await this.post("/api/public/otel/v1/traces", {
      resourceSpans: [{
        resource: { attributes: [attr("service.name", "arcatic-worker")!] },
        scopeSpans: [{
          scope: { name: "arcatic", version: "1" },
          spans: [{
            traceId: e.traceId, spanId: randomBytes(8).toString("hex"), name: e.name, kind: 1,
            startTimeUnixNano: nanos(e.startedAt), endTimeUnixNano: nanos(e.endedAt), attributes, status: { code: e.error ? 2 : 1 },
          }],
        }],
      }],
    });
  }

  /** Human / outcome feedback on a generation (NUMERIC or BOOLEAN 0/1). */
  score(s: { traceId: string; name: string; value: number; dataType?: "NUMERIC" | "BOOLEAN"; comment?: string; id?: string }) {
    return this.post("/api/public/scores", { id: s.id, traceId: s.traceId, name: s.name, value: s.value, dataType: s.dataType ?? "NUMERIC", comment: s.comment, environment: this.cfg.environment ?? "production" });
  }
}

/** Tracer for @arcatic/ai (structurally typed: Tracer.record). Never throws. */
export class LangfuseTracer {
  constructor(private readonly client: LangfuseClient) {}
  async record(e: { name: string; workspaceId: string; jobId?: string; template: string; model: string; input: { system: string; user: string }; output?: unknown; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }; error?: string; startedAt: Date; endedAt: Date }) {
    try {
      await this.client.generation({ ...e, traceId: e.jobId ? traceIdForJob(e.jobId) : randomBytes(16).toString("hex"), input: { user: e.input.user } });   // the cached system prompt (Brand Context) is left out
    } catch {
      /* tracing must never fail a generation */
    }
  }
}

export function langfuseFromEnv(env: NodeJS.ProcessEnv = process.env): LangfuseClient | null {
  if (!env.LANGFUSE_HOST || !env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return null;
  return new LangfuseClient({ host: env.LANGFUSE_HOST, publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY, environment: env.LANGFUSE_ENVIRONMENT || undefined });
}
