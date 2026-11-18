import { normalizeLoose } from "../brand/util.js";

/** Small English stop-word list: enough to keep keyword and overlap maths about content words. */
export const STOP_WORDS = new Set(
  ("a an and are as at be been but by can could do does did for from had has have how i if in into is it its " +
    "just more most my no not of on or our ours out so such than that the their them then there these they this " +
    "those to too up us very was we were what when where which who whom why will with would you your yours about " +
    "also any all each other some only own same both few over under again further once here off").split(" "),
);

const MD_LINK = /\[([^\]]{1,200})\]\((https?:\/\/[^\s)]+)\)/g;

/** Text with markdown links reduced to their anchors (for counting words, not for display). */
export const plainOf = (s: string) => s.replace(MD_LINK, "$1");

export function words(s: string): string[] {
  return normalizeLoose(plainOf(s)).replace(/https?:\/\/\S+/g, " ").match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
}

/** Light plural folding so "shoes" and "shoe" match; deliberately not a stemmer. */
export const fold = (w: string) => (w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

export const contentWords = (s: string) => words(s).filter((w) => !STOP_WORDS.has(w) && w.length > 1).map(fold);

export function sentences(s: string): string[] {
  return plainOf(s)
    .split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"“(])|\n+/u)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/** Occurrences of a phrase (word-boundary, folded) in a text. */
export function countPhrase(text: string, phrase: string): number {
  const p = words(phrase).map(fold);
  if (!p.length) return 0;
  const t = words(text).map(fold);
  let n = 0;
  for (let i = 0; i + p.length <= t.length; i++) if (p.every((w, j) => t[i + j] === w)) n++;
  return n;
}
export const hasPhrase = (text: string, phrase: string) => countPhrase(text, phrase) > 0;

export interface DocLink { url: string; anchor: string | null; blockId: string }

/** Links in block text: markdown `[anchor](url)` and bare URLs. */
export function linksIn(blockId: string, text: string): DocLink[] {
  const out: DocLink[] = [];
  for (const m of text.matchAll(MD_LINK)) out.push({ url: m[2]!, anchor: m[1]!, blockId });
  const rest = text.replace(MD_LINK, " ");
  for (const m of rest.matchAll(/\bhttps?:\/\/[^\s<>"')\]]+/g)) out.push({ url: m[0].replace(/[.,;:]+$/, ""), anchor: null, blockId });
  return out;
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Is `url` on the brand's own site (same host or a subdomain of it)? */
export function isInternal(url: string, siteHosts: readonly string[]): boolean {
  const h = hostOf(url);
  return !!h && siteHosts.some((s) => h === s || h.endsWith(`.${s}`));
}
