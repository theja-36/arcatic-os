import type { ContentRules, ValidationIssue, ValidationReport } from "../validation/validate.js";
import { validateContent } from "../validation/validate.js";
import { findTerm, graphemeLength, xWeightedLength } from "../validation/text.js";
import { docText, type BlockKind, type ContentDoc } from "./doc.js";
import { CONTENT_TYPE_DEFS, type ContentType } from "./types.js";

export interface DocIssue extends ValidationIssue {
  blockId?: string;
}
export interface DocReport {
  passed: boolean;
  issues: DocIssue[];
  stats: { length: number; limit?: number; blocks: number };
}

/** Per-block length rules (errors unless marked warning). Platform values as of 2026-11; re-verify in Phase 7. */
const BLOCK_LIMITS: Partial<Record<ContentType, Partial<Record<BlockKind, { max: number; severity: "error" | "warning"; label: string; weighted?: boolean }>>>> = {
  email: { subject: { max: 60, severity: "error", label: "Subject line" }, preheader: { max: 110, severity: "warning", label: "Preheader" } },
  blog: { title: { max: 70, severity: "warning", label: "Title" }, meta_description: { max: 160, severity: "error", label: "Meta description" } },
  x_thread: { tweet: { max: 280, severity: "error", label: "Post", weighted: true } },
  yt_script: { title: { max: 100, severity: "error", label: "Video title" }, description: { max: 5000, severity: "error", label: "Description" } },
  short_video: { title: { max: 100, severity: "warning", label: "Title" } },
  ad: { primary_text: { max: 125, severity: "warning", label: "Primary text (shown before 'See more')" }, headline: { max: 40, severity: "warning", label: "Headline" }, link_description: { max: 30, severity: "warning", label: "Description" } },
  carousel: { slide_headline: { max: 60, severity: "warning", label: "Slide headline" } },
  static_visual: { headline: { max: 60, severity: "warning", label: "Headline" }, subhead: { max: 120, severity: "warning", label: "Subhead" }, cta: { max: 30, severity: "warning", label: "Button text" } },
  newsletter: { subject: { max: 60, severity: "error", label: "Subject line" }, preheader: { max: 110, severity: "warning", label: "Preheader" } },
  press_release: { title: { max: 120, severity: "warning", label: "Headline" }, subhead: { max: 200, severity: "warning", label: "Sub-headline" } },
  case_study: { title: { max: 100, severity: "warning", label: "Title" }, meta_description: { max: 160, severity: "error", label: "Meta description" } },
  landing_page: { headline: { max: 70, severity: "warning", label: "Hero headline" }, subhead: { max: 160, severity: "warning", label: "Hero sub-headline" }, cta: { max: 30, severity: "warning", label: "Button text" }, meta_description: { max: 160, severity: "error", label: "Meta description" } },
  product_copy: { title: { max: 200, severity: "warning", label: "Product title" }, meta_description: { max: 160, severity: "error", label: "Meta description" }, list_item: { max: 250, severity: "warning", label: "Bullet" } },
  sales_sheet: { headline: { max: 80, severity: "warning", label: "Headline" } },
};

/** Which blocks count towards the channel's post-length limit. */
const POST_KINDS: readonly BlockKind[] = ["hook", "body", "cta", "hashtags", "caption"];

/**
 * Deterministic checklist for a content doc: per-block limits, channel limit for the post text,
 * banned words / disclaimers / uncited claims across all text. "passed" gates approval.
 */
export function validateDoc(type: ContentType, doc: ContentDoc, channel: string | null, rules: ContentRules = {}): DocReport {
  const def = CONTENT_TYPE_DEFS[type];
  const issues: DocIssue[] = [];
  if (!doc.blocks.length) issues.push({ code: "empty", severity: "error", message: "There's nothing here yet." });

  const limits = BLOCK_LIMITS[type] ?? {};
  for (const b of doc.blocks) {
    const l = limits[b.kind];
    if (!l) continue;
    const len = l.weighted ? xWeightedLength(b.text) : graphemeLength(b.text);
    if (len > l.max) issues.push({ code: "too_long", severity: l.severity, message: `${l.label}: ${len} characters (max ${l.max}).`, blockId: b.id });
  }
  if (type === "x_thread" && doc.blocks.filter((b) => b.kind === "tweet").length > 25) issues.push({ code: "too_long", severity: "warning", message: "Threads longer than 25 posts lose readers." });

  // 1) platform limits apply to the post text (hook, body, CTA, hashtags, caption)
  const limitChannel = "limitChannel" in def ? def.limitChannel?.(channel) : undefined;
  const postText = docText(doc, POST_KINDS);
  let stats = { length: graphemeLength(postText || docText(doc)), limit: undefined as number | undefined };
  if (limitChannel && postText) {
    const r = validateContent(postText, { channel: limitChannel, maxHashtagsOverride: rules.maxHashtagsOverride });
    stats = { length: r.stats.length, limit: r.stats.limit };
    issues.push(...r.issues.filter((x) => x.code !== "empty"));
  }
  // 2) banned words: checked per block so each hit points at its block
  for (const b of doc.blocks) {
    for (const w of rules.bannedWords ?? []) {
      if (findTerm(b.text, w).length) issues.push({ code: "banned_word", severity: "error", message: `Avoid "${w}".`, blockId: b.id });
    }
  }
  // 3) other brand rules apply to the whole text (disclaimers, CTA, links, claims)
  const allText = docText(doc);
  const brand = validateContent(allText, { ...rules, bannedWords: [], channel: undefined });
  for (const i of brand.issues) {
    if (i.code === "empty") continue;
    if (i.code === "uncited_claim") {
      const needle = (i.message.match(/"(.+?)"/)?.[1] ?? "").toLowerCase();
      issues.push({ ...i, blockId: doc.blocks.find((b) => b.text.toLowerCase().includes(needle))?.id, index: undefined, length: undefined });
    } else issues.push(i);
  }
  return { passed: !issues.some((i) => i.severity === "error"), issues, stats: { ...stats, blocks: doc.blocks.length } };
}
