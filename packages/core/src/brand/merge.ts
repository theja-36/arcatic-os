import { BrandKitSchema, LIST_LIMITS, valueSchemaFor, type AnyFact, type BrandKit, type ListSection, type Source } from "./kit.js";
import { stableStringify } from "./util.js";

export interface Suggestion<V = unknown> {
  value: V;
  confidence: number;
  sources: Source[];
}

export interface KitSuggestions {
  facts: Record<string, Suggestion>;
  audiences?: Suggestion[];
  offers?: Suggestion[];
}

const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
const nameKey = (v: unknown) => String((v as { name?: string })?.name ?? "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();

/**
 * Merge AI suggestions into a kit without ever overwriting a person's decision:
 *  - no fact / suggested fact      → replaced by the new suggestion (status 'suggested')
 *  - approved fact, different value → suggestion attached for review; value untouched
 *  - rejected fact, same value      → ignored (never resurrect what was rejected)
 *  - rejected fact, new value       → becomes a fresh suggestion
 * Invalid suggestion values are dropped, not coerced.
 */
export function mergeSuggestions(input: BrandKit, s: KitSuggestions, ctx: { now: string; newId: () => string }): { kit: BrandKit; changed: string[] } {
  const kit = structuredClone(input);
  const changed: string[] = [];

  const consider = (path: string, current: AnyFact | undefined, sug: Suggestion, makeId: () => string): AnyFact | undefined => {
    const schema = valueSchemaFor(path);
    const parsed = schema?.safeParse(sug.value);
    if (!parsed?.success) return current;
    const value = parsed.data;
    const fresh: AnyFact = { id: current?.id ?? makeId(), value, status: "suggested", origin: "ai", confidence: sug.confidence, sources: sug.sources, unverified: sug.sources.length === 0 || undefined, updatedAt: ctx.now };
    if (!current || current.status === "suggested") {
      if (current && same(current.value, value) && same(current.sources, sug.sources)) return current;
      changed.push(fresh.id);
      return fresh;
    }
    if (current.status === "rejected") {
      if (same(current.value, value)) return current;
      changed.push(fresh.id);
      return fresh;
    }
    // approved
    if (same(current.value, value)) return current;
    changed.push(current.id);
    return { ...current, suggestion: { value, confidence: sug.confidence, sources: sug.sources, at: ctx.now } };
  };

  for (const [path, sug] of Object.entries(s.facts)) {
    if (path === "audiences" || path === "offers") continue;
    const next = consider(path, kit.facts[path] as AnyFact | undefined, sug, () => path);
    if (next) kit.facts[path] = next as never;
  }

  for (const list of ["audiences", "offers"] as ListSection[]) {
    const arr = kit[list] as AnyFact[];
    for (const sug of s[list] ?? []) {
      const idx = arr.findIndex((f) => nameKey(f.value) === nameKey(sug.value) && nameKey(sug.value) !== "");
      if (idx >= 0) {
        const next = consider(list, arr[idx], sug, () => arr[idx]!.id);
        if (next) arr[idx] = next;
      } else if (arr.length < LIST_LIMITS[list]) {
        const next = consider(list, undefined, sug, () => `${list}:${ctx.newId()}`);
        if (next) arr.push(next);
      }
    }
  }
  return { kit: BrandKitSchema.parse(kit), changed };
}
