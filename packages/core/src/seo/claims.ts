import type { ContentDoc } from "../content/doc.js";
import { contentWords, plainOf, sentences } from "./text.js";
import { normalizeLoose } from "../brand/util.js";

/**
 * Source-backed claims. A "claim" is a sentence that states a checkable fact or a promise:
 * figures, superlatives, attributions ("studies show"), guarantees, comparisons.
 * Each claim is matched against the evidence the content was generated from (knowledge
 * chunks, competitor / research pages). Matching is lexical and conservative: a figure must
 * appear in the evidence verbatim, and most of the claim's content words must too.
 * "unsupported" means "no evidence found here", not "false" — a person decides.
 */
export type ClaimKind = "statistic" | "superlative" | "attribution" | "guarantee" | "comparison";
export interface Claim { blockId: string; text: string; kinds: ClaimKind[]; figures: string[] }
export interface Evidence { id: string; kind: "chunk" | "page" | "fact"; text: string; url?: string | null; title?: string | null }
export interface ClaimCheck extends Claim {
  status: "supported" | "partial" | "unsupported";
  risk: "low" | "medium" | "high";
  evidence: Array<{ id: string; kind: Evidence["kind"]; url?: string | null; snippet: string; score: number }>;
}

const PATTERNS: Array<[ClaimKind, RegExp]> = [
  ["statistic", /\d[\d,.]*\s?(%|percent|x\b|times\b|lakh|crore|million|billion|k\b)|\b(19|20)\d{2}\b|[₹$€£]\s?\d|\b\d{2,}[\d,]*\+?\s+(customers|users|clients|people|brands|businesses|downloads|reviews|orders|stores|countries|cities)/i],
  ["superlative", /\b(best|#1|no\.?\s?1|number one|leading|largest|biggest|fastest|cheapest|only|first|most (popular|trusted|advanced|affordable)|world[- ]class|unbeatable|top[- ]rated)\b/i],
  ["attribution", /\b(studies|research|surveys?|reports?|experts?|scientists|doctors|data)\s+(show|shows|suggest|suggests|found|find|say|says|prove|proves|confirm)|\baccording to\b|\bclinically\b|\bscientifically\b/i],
  ["guarantee", /\b(guarantee[sd]?|100%|risk[- ]free|no risk|always works|never fails|cure[sd]?|permanent(ly)?|instant(ly)? results?|proven)\b/i],
  ["comparison", /\b(more|less|faster|cheaper|better|higher|lower)\s+than\b|\b\d+\s?x\s+(more|faster|better|cheaper)\b|\bvs\.?\b|\bcompared (to|with)\b/i],
];

const FIGURE = /[₹$€£]?\s?\d[\d,]*(\.\d+)?\s?(%|x|k|lakh|crore|million|billion)?/gi;
const normFigure = (f: string) => f.toLowerCase().replace(/[\s,]/g, "").replace(/percent$/, "%");

export function extractClaims(doc: ContentDoc): Claim[] {
  const out: Claim[] = [];
  for (const b of doc.blocks) {
    if (["meta_description", "hashtags", "alt_text", "image_prompt", "cta"].includes(b.kind)) continue;
    for (const s of sentences(b.text)) {
      const kinds = PATTERNS.filter(([, re]) => re.test(s)).map(([k]) => k);
      if (!kinds.length) continue;
      const figures = [...plainOf(s).matchAll(FIGURE)].map((m) => normFigure(m[0])).filter((f) => /\d/.test(f) && !/^\d$/.test(f));
      out.push({ blockId: b.id, text: s.slice(0, 600), kinds, figures: [...new Set(figures)] });
    }
  }
  return out;
}

function bestSnippet(text: string, terms: Set<string>): string {
  const ss = sentences(text);
  let best = ss[0] ?? text.slice(0, 200), bestN = -1;
  for (const s of ss) {
    const n = contentWords(s).filter((w) => terms.has(w)).length;
    if (n > bestN) [best, bestN] = [s, n];
  }
  return best.slice(0, 300);
}

export function checkClaims(claims: readonly Claim[], evidence: readonly Evidence[]): ClaimCheck[] {
  const ev = evidence.map((e) => ({ e, words: new Set(contentWords(e.text)), norm: normalizeLoose(e.text).replace(/[\s,]/g, "") }));
  return claims.map((c) => {
    const terms = [...new Set(contentWords(c.text))];
    const termSet = new Set(terms);
    const scored = ev.map(({ e, words, norm }) => {
      const cover = terms.length ? terms.filter((t) => words.has(t)).length / terms.length : 0;
      const figuresOk = c.figures.every((f) => norm.includes(f.replace(/^[₹$€£]/, "")));
      return { e, cover, figuresOk, score: figuresOk ? cover : cover * 0.3 };
    }).filter((s) => s.cover >= 0.3).sort((a, b) => b.score - a.score).slice(0, 3);
    const top = scored[0];
    const status: ClaimCheck["status"] = top && top.figuresOk && top.cover >= 0.6 ? "supported" : top && (top.figuresOk || top.cover >= 0.6) && top.cover >= 0.4 ? "partial" : "unsupported";
    const severe = c.kinds.includes("guarantee") || c.kinds.includes("attribution") || c.kinds.includes("superlative");
    const risk: ClaimCheck["risk"] = status === "supported" ? "low" : status === "partial" ? (severe ? "medium" : "low") : severe || c.figures.length ? "high" : "medium";
    return {
      ...c, status, risk,
      evidence: scored.map((s) => ({ id: s.e.id, kind: s.e.kind, url: s.e.url ?? null, snippet: bestSnippet(s.e.text, termSet), score: Math.round(s.score * 100) / 100 })),
    };
  });
}

export function claimsScore(checks: readonly ClaimCheck[]): { score: number; supported: number; partial: number; unsupported: number; highRisk: number } {
  const supported = checks.filter((c) => c.status === "supported").length;
  const partial = checks.filter((c) => c.status === "partial").length;
  const unsupported = checks.length - supported - partial;
  const highRisk = checks.filter((c) => c.risk === "high").length;
  const score = checks.length ? Math.round(((supported + partial * 0.5) / checks.length) * 100) : 100;
  return { score, supported, partial, unsupported, highRisk };
}
