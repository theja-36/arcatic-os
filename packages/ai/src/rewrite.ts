import { mergeRewrites, regenerableIds, type BrandContext, type ContentDoc } from "@arcatic/core";
import { z } from "zod";
import { resolveModel } from "./models.js";
import type { GenerateUsage, LlmProvider } from "./provider.js";
import { renderSystem, renderUser, type KnowledgeSnippet } from "./templates.js";

/**
 * One rewrite path for regenerate / transform / translate. The model returns text per block id;
 * `mergeRewrites` decides what may change, so human/locked blocks are protected in code.
 */
export const RewriteSchema = z.object({ blocks: z.array(z.object({ id: z.string(), text: z.string() })) });

export type RewriteMode =
  | { kind: "regenerate"; focus?: string }
  | { kind: "transform"; transform: "improve" | "simplify" | "shorten" | "expand" | "rewrite" | "fix_grammar" | "tone"; tone?: string; instruction?: string }
  | { kind: "translate"; targetLanguage: string };

const LANG_NAMES: Record<string, string> = { en: "English", te: "Telugu", hi: "Hindi", ta: "Tamil", kn: "Kannada", ml: "Malayalam", mr: "Marathi", bn: "Bengali" };
const TRANSFORM_TEXT: Record<string, string> = {
  improve: "Make it clearer, more specific and more engaging while keeping the meaning and facts.",
  simplify: "Use simpler words and shorter sentences (reading age ~12) without losing meaning.",
  shorten: "Cut the length by about 40% keeping the key message and call to action.",
  expand: "Add helpful detail drawn only from the brand context and knowledge (about 50% longer).",
  rewrite: "Write it fresh with a different angle, same facts and call to action.",
  fix_grammar: "Fix grammar, spelling and punctuation only. Change nothing else.",
};

export const rewriteTemplateKey = (m: RewriteMode) =>
  m.kind === "regenerate" ? "content.regenerate@1" : m.kind === "translate" ? `content.translate@1:${m.targetLanguage}` : `content.transform@1:${m.transform}${m.tone ? `:${m.tone}` : ""}`;

export function renderRewriteTask(doc: ContentDoc, allowed: readonly string[], mode: RewriteMode, contentLabel: string): string {
  const ok = new Set(allowed);
  const blocks = doc.blocks.map((b) => ({ id: b.id, kind: b.kind, text: b.text, editable: ok.has(b.id) }));
  const what =
    mode.kind === "regenerate" ? `Write new text for every editable block of this ${contentLabel}. Keep non-editable blocks exactly as they are and make the new text fit with them.${mode.focus ? ` Direction from the editor: ${mode.focus}` : ""}`
    : mode.kind === "translate" ? `Transcreate the editable blocks into ${LANG_NAMES[mode.targetLanguage] ?? mode.targetLanguage}: natural, local phrasing (not word-for-word), same meaning, facts, prices and call to action. Keep hashtags that are brand names; translate descriptive hashtags. Use the native script.`
    : mode.transform === "tone" ? `Rewrite the editable blocks in a ${mode.tone ?? "friendlier"} tone, same facts and call to action.`
    : TRANSFORM_TEXT[mode.transform]!;
  return [
    what,
    mode.kind === "transform" && mode.instruction ? `Extra instruction: ${mode.instruction}` : "",
    "Return one entry per editable block id, in the same order. Do not add or remove blocks. Respect each block's kind (a subject line stays a subject line, a hashtag block stays hashtags).",
    "",
    "<content>",
    JSON.stringify(blocks, null, 1),
    "</content>",
  ].filter(Boolean).join("\n");
}

export async function runRewrite(
  provider: LlmProvider,
  args: { brand: BrandContext; doc: ContentDoc; mode: RewriteMode; contentLabel: string; blockIds?: string[]; knowledge?: KnowledgeSnippet[]; tier?: "economy" | "standard" | "premium" },
  meta: { workspaceId: string; jobId?: string; signal?: AbortSignal },
): Promise<{ doc: ContentDoc; rewritten: string[]; allowed: string[]; model: string; usage: GenerateUsage; template: string; prompt: { system: string; user: string } }> {
  // regenerate: unlocked AI blocks only. transform/translate: the user's selection (any unlocked block), default all unlocked.
  const allowed = args.mode.kind === "regenerate"
    ? regenerableIds(args.doc, args.blockIds)
    : args.doc.blocks.filter((b) => !b.locked && (!args.blockIds?.length || args.blockIds.includes(b.id))).map((b) => b.id);
  const template = rewriteTemplateKey(args.mode);
  const system = renderSystem(args.brand);
  const user = renderUser(renderRewriteTask(args.doc, allowed, args.mode, args.contentLabel), args.knowledge ?? []);
  if (!allowed.length) return { doc: args.doc, rewritten: [], allowed, model: "none", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, template, prompt: { system, user } };
  const choice = resolveModel(args.tier ?? (args.mode.kind === "transform" && args.mode.transform === "fix_grammar" ? "economy" : "standard"));
  const res = await provider.generateStructured({ model: choice.model, effort: choice.effort, system, user, schema: RewriteSchema, maxTokens: 12000, metadata: { workspaceId: meta.workspaceId, jobId: meta.jobId, template }, signal: meta.signal });
  const merged = mergeRewrites(args.doc, res.output.blocks, allowed);
  return { ...merged, allowed, model: res.model, usage: res.usage, template, prompt: { system, user } };
}
