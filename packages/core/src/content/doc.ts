import { z } from "zod";

/**
 * Content document: an ordered list of blocks. Each block remembers who wrote it last
 * (`origin`) and can be locked. Regeneration rewrites only unlocked AI blocks, so human
 * edits survive — the core promise of selective regeneration.
 */
export const BLOCK_KINDS = [
  "title", "hook", "body", "cta", "hashtags", "alt_text", "caption",
  "subject", "preheader", "heading", "paragraph", "list_item", "quote", "meta_description",
  "tweet", "scene", "voiceover", "on_screen_text", "description", "chapter",
  "headline", "primary_text", "link_description", "slide_headline", "slide_body", "subhead", "image_prompt",
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const BlockSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(BLOCK_KINDS),
  text: z.string().max(20_000),
  origin: z.enum(["ai", "human"]),
  locked: z.boolean().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type Block = z.infer<typeof BlockSchema>;

export const ContentDocSchema = z.object({ format: z.literal(1), blocks: z.array(BlockSchema).max(400) });
export type ContentDoc = z.infer<typeof ContentDocSchema>;

/** Build a doc from (kind, text) pairs; ids are stable positions ("b1", "b2", …). */
export function docFrom(parts: Array<[BlockKind, string] | [BlockKind, string, Record<string, unknown>]>, origin: Block["origin"] = "ai"): ContentDoc {
  return {
    format: 1,
    blocks: parts
      .filter(([, t]) => t.trim().length > 0)
      .map(([kind, text, meta], i) => ({ id: `b${i + 1}`, kind, text: text.trim(), origin, ...(meta && { meta }) })),
  };
}

const JOIN: Partial<Record<BlockKind, string>> = { hashtags: "\n\n", list_item: "\n" };

/** Plain text of the whole doc (or a filter of kinds), for validation and previews. */
export function docText(doc: ContentDoc, kinds?: readonly BlockKind[]): string {
  const blocks = kinds ? doc.blocks.filter((b) => kinds.includes(b.kind)) : doc.blocks;
  return blocks.map((b, i) => (i === 0 ? "" : JOIN[b.kind] ?? "\n\n") + (b.kind === "list_item" ? `• ${b.text}` : b.text)).join("").trim();
}

/**
 * A person saved `next` on top of `prev`: every block whose text changed (or that is new)
 * becomes origin "human". Returns the doc and which blocks changed.
 */
export function markHumanEdits(prev: ContentDoc | null, next: ContentDoc): { doc: ContentDoc; changed: string[]; added: string[]; removed: string[] } {
  const before = new Map((prev?.blocks ?? []).map((b) => [b.id, b]));
  const changed: string[] = [];
  const added: string[] = [];
  const blocks = next.blocks.map((b) => {
    const old = before.get(b.id);
    if (!old) {
      added.push(b.id);
      return { ...b, origin: "human" as const };
    }
    if (old.text !== b.text || old.kind !== b.kind) {
      changed.push(b.id);
      return { ...b, origin: "human" as const };
    }
    return { ...b, origin: old.origin, locked: b.locked ?? old.locked };
  });
  const ids = new Set(next.blocks.map((b) => b.id));
  const removed = [...before.keys()].filter((id) => !ids.has(id));
  return { doc: { format: 1, blocks }, changed, added, removed };
}

/** Blocks the model may rewrite during selective regeneration. */
export const regenerableIds = (doc: ContentDoc, only?: readonly string[]) =>
  doc.blocks.filter((b) => !b.locked && b.origin === "ai" && (!only?.length || only.includes(b.id))).map((b) => b.id);

/**
 * Merge model rewrites into a doc. Only ids in `allowed` change; human and locked blocks are
 * copied byte-for-byte whatever the model returned. Unknown ids are ignored.
 */
export function mergeRewrites(doc: ContentDoc, rewrites: ReadonlyArray<{ id: string; text: string }>, allowed: readonly string[]): { doc: ContentDoc; rewritten: string[] } {
  const ok = new Set(allowed);
  const map = new Map(rewrites.filter((r) => ok.has(r.id) && r.text.trim()).map((r) => [r.id, r.text.trim()]));
  const rewritten: string[] = [];
  const blocks = doc.blocks.map((b) => {
    const t = map.get(b.id);
    if (t === undefined || b.locked || (b.origin === "human" && !ok.has(b.id))) return b;
    if (t !== b.text) rewritten.push(b.id);
    return { ...b, text: t, origin: "ai" as const };
  });
  return { doc: { format: 1, blocks }, rewritten };
}

/** Coarse classification of a human edit, recorded as a learning signal. */
export function classifyEdit(prev: ContentDoc, next: ContentDoc): string[] {
  const classes = new Set<string>();
  const a = new Map(prev.blocks.map((b) => [b.id, b]));
  for (const b of next.blocks) {
    const o = a.get(b.id);
    if (!o) { classes.add("added_block"); continue; }
    if (o.text === b.text) continue;
    if (b.kind === "cta") classes.add("cta");
    else if (b.kind === "hashtags") classes.add("hashtags");
    else if (b.kind === "subject" || b.kind === "title" || b.kind === "headline" || b.kind === "hook") classes.add("headline");
    const ratio = b.text.length / Math.max(1, o.text.length);
    if (ratio < 0.75) classes.add("shortened");
    else if (ratio > 1.33) classes.add("lengthened");
    else classes.add("wording");
  }
  if (prev.blocks.some((b) => !next.blocks.find((x) => x.id === b.id))) classes.add("removed_block");
  return [...classes].sort();
}

export const nextBlockId = (doc: ContentDoc) => `b${doc.blocks.reduce((m, b) => Math.max(m, Number(b.id.slice(1)) || 0), 0) + 1}`;
