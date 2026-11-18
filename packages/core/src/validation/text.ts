/** Unicode-aware text helpers. Platform limits count user-perceived characters (graphemes). */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemeLength(text: string): number {
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/** NFKC + case fold; keeps combining marks (needed for Telugu and other Indic scripts). */
export function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase();
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Word-boundary match that works for scripts where \b fails (Telugu, Devanagari):
 * a match must not be preceded/followed by a letter, mark or number.
 */
export function findTerm(text: string, term: string): Array<{ index: number; length: number }> {
  const t = normalizeForMatch(term.trim());
  if (!t) return [];
  const haystack = normalizeForMatch(text);
  const re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escapeRegExp(t)}(?![\\p{L}\\p{M}\\p{N}])`, "gu");
  const hits: Array<{ index: number; length: number }> = [];
  for (const m of haystack.matchAll(re)) hits.push({ index: m.index ?? 0, length: m[0].length });
  return hits;
}

export const HASHTAG_RE = /(?<![\p{L}\p{N}_])#[\p{L}\p{M}\p{N}_]+/gu;
export const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/giu;

export const extractHashtags = (text: string) => [...text.matchAll(HASHTAG_RE)].map((m) => m[0]);
export const extractUrls = (text: string) => [...text.matchAll(URL_RE)].map((m) => m[0]);

/**
 * X counts characters with weights: URLs are always 23, CJK/most non-Latin code points weigh 2.
 * This is the documented twitter-text v3 config approximation; Phase 7 replaces it with the
 * official `twitter-text` package once platform specs are verified.
 */
export function xWeightedLength(text: string): number {
  let len = 0;
  const withoutUrls = text.replace(URL_RE, () => {
    len += 23;
    return "";
  });
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0) ?? 0;
    const light =
      (cp >= 0x0000 && cp <= 0x10ff) || (cp >= 0x2000 && cp <= 0x200d) ||
      (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
    len += light ? 1 : 2;
  }
  return len;
}
