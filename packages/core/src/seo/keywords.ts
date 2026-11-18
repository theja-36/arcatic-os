import { z } from "zod";
import { contentWords, words } from "./text.js";

/**
 * Keyword research results. Volumes and competition come only from Google Ads Keyword
 * Planner (when an Ads account is connected); AI-suggested keywords carry no numbers,
 * and the UI says so.
 */
export const KeywordIdeaSchema = z.object({
  keyword: z.string().min(1).max(200),
  avgMonthlySearches: z.number().int().nonnegative().nullable().optional(),
  competition: z.enum(["LOW", "MEDIUM", "HIGH", "UNSPECIFIED", "UNKNOWN"]).nullable().optional(),
  competitionIndex: z.number().int().min(0).max(100).nullable().optional(),
  lowBidMinor: z.number().int().nonnegative().nullable().optional(),
  highBidMinor: z.number().int().nonnegative().nullable().optional(),
  intent: z.enum(["informational", "commercial", "transactional", "navigational"]).optional(),
});
export type KeywordIdea = z.infer<typeof KeywordIdeaSchema>;
export interface KeywordCluster { label: string; keywords: string[]; volume: number | null; intent: KeywordIdea["intent"] }

const TRANSACTIONAL = /\b(buy|price|prices|pricing|cost|cheap|deal|deals|discount|coupon|order|shop|near me|for sale|booking|book|hire|subscribe|free trial)\b/i;
const COMMERCIAL = /\b(best|top|vs|versus|review|reviews|compare|comparison|alternative|alternatives|recommended)\b/i;
const INFORMATIONAL = /\b(how|what|why|when|where|who|guide|tutorial|tips|ideas|examples|meaning|definition|learn|benefits|steps)\b/i;

export function classifyIntent(keyword: string, brandNames: readonly string[] = []): NonNullable<KeywordIdea["intent"]> {
  const k = keyword.toLowerCase();
  if (brandNames.some((b) => b && k.includes(b.toLowerCase())) && !TRANSACTIONAL.test(k) && !COMMERCIAL.test(k)) return "navigational";
  if (TRANSACTIONAL.test(k)) return "transactional";
  if (COMMERCIAL.test(k)) return "commercial";
  if (INFORMATIONAL.test(k) || k.endsWith("?")) return "informational";
  return words(k).length >= 4 ? "informational" : "commercial";
}

const jaccard = (a: Set<string>, b: Set<string>) => {
  const inter = [...a].filter((x) => b.has(x)).length;
  return inter / (a.size + b.size - inter || 1);
};

/**
 * Group keywords into topics: highest-volume keyword first becomes a cluster head; a keyword
 * joins the first head it shares most content words with. Deterministic and explainable.
 */
export function clusterKeywords(ideas: readonly KeywordIdea[], threshold = 0.6): KeywordCluster[] {
  const sorted = [...ideas].sort((a, b) => (b.avgMonthlySearches ?? -1) - (a.avgMonthlySearches ?? -1) || a.keyword.length - b.keyword.length || a.keyword.localeCompare(b.keyword));
  const clusters: Array<{ head: KeywordIdea; set: Set<string>; items: KeywordIdea[] }> = [];
  for (const k of sorted) {
    const set = new Set(contentWords(k.keyword));
    if (!set.size) continue;
    const home = clusters.find((c) => jaccard(c.set, set) >= threshold || ([...c.set].every((w) => set.has(w)) && c.set.size >= 2));
    if (home) home.items.push(k);
    else clusters.push({ head: k, set, items: [k] });
  }
  return clusters.map((c) => {
    const vols = c.items.map((i) => i.avgMonthlySearches).filter((v): v is number => typeof v === "number");
    return { label: c.head.keyword, keywords: c.items.map((i) => i.keyword), volume: vols.length ? vols.reduce((s, v) => s + v, 0) : null, intent: c.head.intent ?? classifyIntent(c.head.keyword) };
  }).sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1) || b.keywords.length - a.keywords.length);
}

/** Merge and de-duplicate ideas from several sources; numbers from Keyword Planner win. */
export function mergeIdeas(...lists: ReadonlyArray<readonly KeywordIdea[]>): KeywordIdea[] {
  const map = new Map<string, KeywordIdea>();
  for (const list of lists) for (const k of list) {
    const key = words(k.keyword).join(" ");
    if (!key) continue;
    const prev = map.get(key);
    map.set(key, prev ? { ...k, ...prev, avgMonthlySearches: prev.avgMonthlySearches ?? k.avgMonthlySearches ?? null } : { ...k, keyword: k.keyword.trim() });
  }
  return [...map.values()].map((k) => ({ ...k, intent: k.intent ?? classifyIntent(k.keyword) }));
}
