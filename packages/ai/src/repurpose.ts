import type { BrandContext, Digest } from "@arcatic/core";
import { z } from "zod";
import { resolveModel } from "./models.js";
import type { GenerateUsage, LlmProvider } from "./provider.js";
import { renderSystem, renderUser, type KnowledgeSnippet } from "./templates.js";

export const DIGEST_TEMPLATE = "repurpose.digest@1";

const DigestSchema = z.object({
  title: z.string(),
  summary: z.string(),
  key_points: z.array(z.object({ point: z.string(), chunk_ids: z.array(z.string()) })).min(1),
  quotes: z.array(z.object({ text: z.string(), chunk_id: z.string() })),
  angles: z.array(z.object({ angle: z.string(), best_for: z.string() })),
});

/** At most this much source text goes into one digest call (≈ 12k tokens). */
export const DIGEST_CHAR_BUDGET = 48_000;

/**
 * Read a source once (in its original order) and extract what the outputs will be built from.
 * Quotes must be verbatim: any quote not found in its chunk is dropped; unknown chunk ids are removed.
 */
export async function digestSource(
  provider: LlmProvider,
  ctx: { brand: BrandContext; title: string; kindLabel: string; chunks: KnowledgeSnippet[]; language: string },
  meta: { workspaceId: string; jobId?: string; signal?: AbortSignal },
): Promise<{ digest: Digest; model: string; usage: GenerateUsage; prompt: { system: string; user: string }; truncated: boolean }> {
  let used = 0;
  const chunks: KnowledgeSnippet[] = [];
  for (const c of ctx.chunks) { if (used + c.content.length > DIGEST_CHAR_BUDGET) break; chunks.push(c); used += c.content.length; }
  const truncated = chunks.length < ctx.chunks.length;
  const choice = resolveModel("standard");
  const system = renderSystem(ctx.brand);
  const user = renderUser([
    `Read this ${ctx.kindLabel} ("${ctx.title}"), given in order as knowledge snippets${truncated ? " (the first part only)" : ""}, and prepare it for repurposing into social posts, emails, articles and scripts.`,
    "Return: a short title; a 3–4 sentence summary; 5–10 key points, each with the snippet ids it comes from; up to 3 short quotes copied word for word from the snippets (with their snippet id) — only real sentences from the source; and 3–5 angles (how to present it), each with the format it suits best.",
    `Write in ${ctx.language}. Use only what the source says.`,
  ].join("\n"), chunks);
  const res = await provider.generateStructured({
    model: choice.model, effort: choice.effort, system, user, schema: DigestSchema, maxTokens: 6000,
    metadata: { workspaceId: meta.workspaceId, jobId: meta.jobId, template: DIGEST_TEMPLATE }, signal: meta.signal,
  });
  const known = new Map(chunks.map((c) => [c.chunkId, c.content]));
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const out = res.output;
  const digest: Digest = {
    title: out.title.trim(),
    summary: out.summary.trim(),
    key_points: out.key_points.map((p) => ({ point: p.point.trim(), chunk_ids: p.chunk_ids.filter((id) => known.has(id)) })).filter((p) => p.point),
    quotes: out.quotes.filter((q) => known.has(q.chunk_id) && q.text.trim().length > 0 && norm(known.get(q.chunk_id)!).includes(norm(q.text))),
    angles: out.angles.filter((a) => a.angle.trim()),
  };
  return { digest, model: res.model, usage: res.usage, prompt: { system, user }, truncated };
}
