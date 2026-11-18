import type { ContentDoc } from "../content/doc.js";
import { contentWords, fold, isInternal, linksIn, words } from "./text.js";

/**
 * Internal link suggestions: pages on the brand's own site (published Arcatic content with a
 * URL, or crawled site pages from the knowledge base) that the draft could link to, with an
 * anchor phrase that already appears in a paragraph. Nothing is inserted until a person accepts.
 */
export interface LinkTarget { url: string; title: string; keywords?: readonly string[]; text?: string | null }
export interface LinkSuggestion { blockId: string; anchor: string; url: string; title: string; score: number; reason: string }

const LINKABLE = new Set(["paragraph", "body", "list_item"]);

/** Candidate anchor phrases for a target: its keywords, then 2–4 word runs from its title. */
function phrases(t: LinkTarget): string[] {
  const out = [...(t.keywords ?? [])].map((k) => k.trim()).filter((k) => words(k).length >= 1);
  const tw = words(t.title);
  for (let n = 4; n >= 2; n--) {
    for (let i = 0; i + n <= tw.length; i++) {
      const run = tw.slice(i, i + n);
      if (contentWords(run.join(" ")).length >= Math.min(2, n) && contentWords(run[0]!).length && contentWords(run[n - 1]!).length) out.push(run.join(" "));
    }
  }
  return [...new Set(out.map((p) => p.toLowerCase()))];
}

/** Locate a phrase in original text (case-insensitive, plural-tolerant); returns the exact substring. */
function locate(text: string, phrase: string): string | null {
  const parts = words(phrase).map((w) => fold(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!parts.length) return null;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${parts.map((p) => `${p}(?:s|es)?`).join("[\\s-]+")}(?![\\p{L}\\p{N}])`, "iu");
  return re.exec(text)?.[0] ?? null;
}

export function suggestInternalLinks(doc: ContentDoc, targets: readonly LinkTarget[], opts: { siteHosts: readonly string[]; selfUrl?: string | null; max?: number }): LinkSuggestion[] {
  const docWords = new Set(contentWords(doc.blocks.map((b) => b.text).join(" ")));
  const already = new Set(doc.blocks.flatMap((b) => linksIn(b.id, b.text)).map((l) => l.url.replace(/\/$/, "")));
  const totalWords = words(doc.blocks.map((b) => b.text).join(" ")).length;
  const max = opts.max ?? Math.max(2, Math.min(8, Math.round(totalWords / 250)));
  const blocks = doc.blocks.filter((b) => LINKABLE.has(b.kind));
  const candidates: LinkSuggestion[] = [];

  for (const t of targets) {
    const url = t.url.replace(/\/$/, "");
    if (!isInternal(t.url, opts.siteHosts) || already.has(url) || (opts.selfUrl && url === opts.selfUrl.replace(/\/$/, ""))) continue;
    const tw = [...new Set(contentWords(`${t.title} ${(t.keywords ?? []).join(" ")} ${(t.text ?? "").slice(0, 3000)}`))];
    const relevance = tw.length ? tw.filter((w) => docWords.has(w)).length / Math.min(tw.length, 40) : 0;
    if (relevance < 0.15) continue;
    for (const p of phrases(t)) {
      const hit = blocks.map((b) => ({ b, m: locate(b.text.replace(/\[[^\]]*\]\([^)]*\)/g, (s) => " ".repeat(s.length)), p) })).find((x) => x.m);
      if (!hit?.m) continue;
      const isKeyword = (t.keywords ?? []).some((k) => k.toLowerCase() === p);
      const score = Math.round(Math.min(1, relevance + (isKeyword ? 0.3 : 0) + words(p).length * 0.05) * 100) / 100;
      candidates.push({ blockId: hit.b.id, anchor: hit.m, url: t.url, title: t.title, score, reason: isKeyword ? `matches the page's keyword "${p}"` : `phrase from the page title` });
      break;
    }
  }
  // one link per target and per paragraph, best first
  const usedBlocks = new Set<string>();
  return candidates.sort((a, b) => b.score - a.score).filter((s) => (usedBlocks.has(s.blockId) ? false : (usedBlocks.add(s.blockId), true))).slice(0, max);
}

/** Apply an accepted suggestion: wrap the first occurrence of the anchor in a markdown link. */
export function applyLink(doc: ContentDoc, s: Pick<LinkSuggestion, "blockId" | "anchor" | "url">): ContentDoc {
  return {
    ...doc,
    blocks: doc.blocks.map((b) => {
      if (b.id !== s.blockId) return b;
      const i = b.text.indexOf(s.anchor);
      if (i < 0) return b;
      return { ...b, text: `${b.text.slice(0, i)}[${s.anchor}](${s.url})${b.text.slice(i + s.anchor.length)}`, origin: "human" as const };
    }),
  };
}
