import { normalizeLoose } from "./util.js";
import type { Source } from "./kit.js";

export interface PageText {
  sourceId: string;
  url: string;
  text: string;
}

/**
 * A model citation is kept only if its quote really appears in the cited page.
 * Deterministic guard against invented sources (docs/06 R6).
 */
export function quoteAppears(pageText: string, quote: string): boolean {
  const q = normalizeLoose(quote).replace(/^["'.…\s]+|["'.…\s]+$/g, "");
  if (q.length < 8) return false;
  return normalizeLoose(pageText).includes(q);
}

export interface RawCitation {
  pageId: string;
  quote: string;
}

export function verifyCitations(
  citations: readonly RawCitation[],
  pages: ReadonlyMap<string, PageText>,
): { verified: Source[]; dropped: number } {
  const verified: Source[] = [];
  let dropped = 0;
  for (const c of citations) {
    const page = pages.get(c.pageId);
    if (page && quoteAppears(page.text, c.quote)) {
      verified.push({ kind: "page", url: page.url, sourceId: page.sourceId, quote: c.quote.slice(0, 400) });
    } else dropped++;
  }
  return { verified, dropped };
}

/** Confidence after verification: no verified source caps confidence at 0.3. */
export const adjustedConfidence = (modelConfidence: number, verifiedCount: number) =>
  verifiedCount > 0 ? Math.min(1, Math.max(0, modelConfidence)) : Math.min(0.3, Math.max(0, modelConfidence));
