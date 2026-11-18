import { numericClaims, stableStringify, validateDoc, type ContentDoc, type ContentRules, type DocReport } from "@arcatic/core";
import type { z } from "zod";
import { resolveModel } from "./models.js";
import type { GenerateUsage, LlmProvider } from "./provider.js";
import { type PromptTemplate, type TemplateContext, renderSystem, renderUser, templateKey } from "./templates.js";

export interface GenerationProvenance {
  promptTemplate: string;
  model: string;
  modelParams: { effort: string; tier: string };
  prompt: { system: string; user: string };
  brandContextVersion: number;
  brandContextHash: string;
  dependsOnFacts: string[];
  sourceChunkIds: string[];
  usage: GenerateUsage;
  servedByFallback: boolean;
}

export interface GenerationResult<O> {
  output: O;
  doc: ContentDoc;
  variants: ContentDoc[];
  validation: DocReport;
  provenance: GenerationProvenance;
}

/** Brand rules for deterministic validation; numbers present in the sources count as cited. */
export function brandRules(brand: import("@arcatic/core").BrandContext, knowledge: Array<{ content: string }>): ContentRules {
  const sources = [stableStringify(brand.data), ...knowledge.map((k) => k.content)].join("\n");
  return {
    bannedWords: brand.data.vocabulary.banned,
    requiredDisclaimers: brand.data.compliance.disclaimers,
    claimsPolicy: brand.data.compliance.claimsPolicy,
    citedClaims: numericClaims(sources),
  };
}

/**
 * One generation: render → model → deterministic validation.
 * Validation never silently edits text; the caller decides (auto-repair once, or surface issues).
 */
export async function runTemplate<I extends z.ZodType, O extends z.ZodType>(
  provider: LlmProvider,
  template: PromptTemplate<I, O>,
  ctx: Omit<TemplateContext<z.input<I>>, "input"> & { input: z.input<I>; images?: Array<{ mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string }> },
  meta: { workspaceId: string; jobId?: string; signal?: AbortSignal; rules?: ContentRules; tier?: "economy" | "standard" | "premium"; learnings?: string },
): Promise<GenerationResult<z.infer<O>>> {
  const input = template.input.parse(ctx.input);
  const choice = resolveModel(meta.tier ?? template.tier);
  const system = renderSystem(ctx.brand);
  const user = renderUser(template.render({ ...ctx, input }).task, ctx.knowledge, meta.learnings);

  const res = await provider.generateStructured({
    model: choice.model,
    effort: choice.effort,
    system,
    user,
    schema: template.output,
    images: ctx.images,
    maxTokens: template.maxTokens,
    metadata: { workspaceId: meta.workspaceId, jobId: meta.jobId, template: templateKey(template) },
    signal: meta.signal,
  });

  const { doc, variants = [] } = template.toDoc(res.output, input);
  const validation = validateDoc(template.contentType, doc, template.channel?.(input) ?? (input as { channel?: string }).channel ?? null, { ...brandRules(ctx.brand, ctx.knowledge), ...meta.rules });

  const knownChunks = new Set(ctx.knowledge.map((k) => k.chunkId));
  const cited = collectCitedChunkIds(res.output).filter((id) => knownChunks.has(id));

  return {
    output: res.output,
    doc,
    variants,
    validation,
    provenance: {
      promptTemplate: templateKey(template),
      model: res.model,
      modelParams: { effort: choice.effort, tier: choice.tier },
      prompt: { system, user },
      brandContextVersion: ctx.brand.version,
      brandContextHash: ctx.brand.hash,
      dependsOnFacts: ctx.brand.factIds,
      sourceChunkIds: [...new Set(cited)],
      usage: res.usage,
      servedByFallback: res.servedByFallback,
    },
  };
}

function collectCitedChunkIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectCitedChunkIds);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) =>
      k === "cited_chunk_ids" && Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : collectCitedChunkIds(v),
    );
  }
  return [];
}
