import { describe, expect, it } from "vitest";
import {
  applyKitOps, compileBrandContext, CONTEXT_TOKEN_BUDGET, diffKits, emptyKit, estimateTokens, isAffectedByFactChange,
  kitCompleteness, mergeSuggestions, seedKitFromOnboarding, stableStringify, type BrandKit,
} from "../src/index.js";

let n = 0;
const ctx = { now: "2026-11-18T00:00:00Z", newId: () => `id${++n}` };
const base = () => emptyKit("b1", "Annapurna Tiffins", ["te", "en"]);

describe("applyKitOps", () => {
  it("sets, adds, updates and removes facts as approved human edits", () => {
    const { kit, touched } = applyKitOps(base(), [
      { op: "set", path: "voice.tone", value: ["warm", "simple"] },
      { op: "add", list: "offers", value: { name: "Breakfast tiffin", kind: "subscription", price: "₹1,499/month" } },
    ], ctx);
    expect(kit.facts["voice.tone"]).toMatchObject({ id: "voice.tone", status: "approved", origin: "human" });
    expect(kit.offers).toHaveLength(1);
    const offerId = kit.offers[0]!.id;
    expect(touched).toEqual(["voice.tone", offerId]);
    const k2 = applyKitOps(kit, [{ op: "update", id: offerId, value: { name: "Breakfast tiffin", kind: "subscription", price: "₹1,599/month" } }, { op: "clear", path: "voice.tone" }], ctx).kit;
    expect((k2.offers[0]!.value as { price: string }).price).toBe("₹1,599/month");
    expect(k2.facts["voice.tone"]).toBeUndefined();
    expect(applyKitOps(k2, [{ op: "remove", id: offerId }], ctx).kit.offers).toHaveLength(0);
  });

  it("rejects unknown paths and invalid values with field details", () => {
    expect(() => applyKitOps(base(), [{ op: "set", path: "secret.field", value: "x" }], ctx)).toThrow(/Unknown field/);
    expect(() => applyKitOps(base(), [{ op: "set", path: "visual.colors", value: [{ hex: "red" }] }], ctx)).toThrowError(
      expect.objectContaining({ code: "validation_failed" }),
    );
  });

  it("accepts arbitrary channel rule channels", () => {
    const { kit } = applyKitOps(base(), [{ op: "set", path: "channelRules.instagram", value: ["Max 5 hashtags"] }], ctx);
    expect(kit.facts["channelRules.instagram"]?.value).toEqual(["Max 5 hashtags"]);
  });
});

describe("mergeSuggestions", () => {
  const sug = (value: unknown, confidence = 0.8) => ({ value, confidence, sources: [{ kind: "page" as const, url: "https://x.in/about", quote: "since 1998" }] });

  it("never overwrites an approved fact; attaches a suggestion instead", () => {
    const kit = applyKitOps(base(), [{ op: "set", path: "oneLiner", value: "Home-style tiffins" }], ctx).kit;
    const { kit: merged, changed } = mergeSuggestions(kit, { facts: { oneLiner: sug("Hyderabad's favourite tiffin service") } }, ctx);
    expect(merged.facts.oneLiner?.value).toBe("Home-style tiffins");
    expect(merged.facts.oneLiner?.suggestion?.value).toBe("Hyderabad's favourite tiffin service");
    expect(changed).toEqual(["oneLiner"]);
  });

  it("fills empty facts as suggested and does not resurrect rejected values", () => {
    let kit = mergeSuggestions(base(), { facts: { positioning: sug("Cheapest in town") } }, ctx).kit;
    expect(kit.facts.positioning).toMatchObject({ status: "suggested", origin: "ai" });
    kit = applyKitOps(kit, [{ op: "reject", id: "positioning" }], ctx).kit;
    const again = mergeSuggestions(kit, { facts: { positioning: sug("Cheapest in town") } }, ctx);
    expect(again.changed).toEqual([]);
    expect(again.kit.facts.positioning?.status).toBe("rejected");
  });

  it("matches list items by name and drops invalid values", () => {
    const kit = applyKitOps(base(), [{ op: "add", list: "offers", value: { name: "Lunch Box", kind: "service" } }], ctx).kit;
    const { kit: merged } = mergeSuggestions(kit, {
      facts: { "visual.colors": sug([{ hex: "not-a-colour" }]) },
      offers: [sug({ name: "lunch box", kind: "service", price: "₹120" }), sug({ name: "Dinner thali", kind: "product" })],
    }, ctx);
    expect(merged.facts["visual.colors"]).toBeUndefined();
    expect(merged.offers).toHaveLength(2);
    expect(merged.offers[0]!.status).toBe("approved");
    expect(merged.offers[0]!.suggestion?.value).toMatchObject({ price: "₹120" });
    expect(merged.offers[1]).toMatchObject({ status: "suggested" });
  });

  it("accept_suggestion promotes the AI value with its sources", () => {
    const kit = applyKitOps(base(), [{ op: "set", path: "oneLiner", value: "Old" }], ctx).kit;
    const merged = mergeSuggestions(kit, { facts: { oneLiner: sug("New line") } }, ctx).kit;
    const accepted = applyKitOps(merged, [{ op: "accept_suggestion", id: "oneLiner" }], ctx).kit;
    expect(accepted.facts.oneLiner).toMatchObject({ value: "New line", status: "approved", origin: "ai" });
    expect(accepted.facts.oneLiner?.suggestion).toBeUndefined();
    expect(accepted.facts.oneLiner?.sources[0]?.quote).toBe("since 1998");
  });
});

describe("diffKits", () => {
  it("reports only changes to approved values", () => {
    const a = applyKitOps(base(), [{ op: "set", path: "voice.tone", value: ["warm"] }], ctx).kit;
    const b = mergeSuggestions(a, { facts: { mission: { value: "Feed people well", confidence: 0.5, sources: [] } } }, ctx).kit;
    expect(diffKits(a, b)).toEqual([]);  // a suggestion changes nothing generation uses
    const c = applyKitOps(b, [{ op: "set", path: "voice.tone", value: ["warm", "bold"] }, { op: "approve", id: "mission" }], ctx).kit;
    expect(diffKits(b, c)).toEqual(["mission", "voice.tone"]);
  });
});

describe("onboarding seed", () => {
  it("seeds approved facts and is idempotent for list items", () => {
    const answers = {
      businessName: "Annapurna Tiffins", businessType: "Cloud kitchen", goals: ["sales", "retention"] as const,
      offers: [{ name: "Breakfast tiffin", kind: "subscription" as const }], tone: ["warm", "friendly"] as const,
      audience: { description: "Working professionals in Gachibowli" }, channels: ["instagram", "whatsapp"] as const,
      languages: { primary: "te", supported: ["te", "en"] }, maturity: "occasional" as const,
    };
    const once = seedKitFromOnboarding(base(), { ...answers, goals: [...answers.goals], tone: [...answers.tone], channels: [...answers.channels] }, ctx).kit;
    const twice = seedKitFromOnboarding(once, { ...answers, goals: [...answers.goals], tone: [...answers.tone], channels: [...answers.channels] }, ctx).kit;
    expect(twice.offers).toHaveLength(1);
    expect(twice.audiences).toHaveLength(1);
    expect(twice.facts["voice.tone"]).toMatchObject({ status: "approved", origin: "onboarding" });
    expect(twice.languages.primary).toBe("te");
  });

  it("does not overwrite values edited in the Brand Kit", () => {
    const edited = applyKitOps(base(), [{ op: "set", path: "voice.tone", value: ["bold"] }], ctx).kit;
    const seeded = seedKitFromOnboarding(edited, { tone: ["warm"] }, ctx).kit;
    expect(seeded.facts["voice.tone"]?.value).toEqual(["bold"]);
  });
});

describe("compileBrandContext", () => {
  it("uses only approved facts, records ids, and hashes stably", async () => {
    let kit = applyKitOps(base(), [{ op: "set", path: "oneLiner", value: "Home-style tiffins" }, { op: "set", path: "vocabulary.banned", value: ["cheap"] }], ctx).kit;
    kit = mergeSuggestions(kit, { facts: { positioning: { value: "Cheapest", confidence: 0.9, sources: [] } } }, ctx).kit;
    const a = await compileBrandContext(kit);
    expect(a.data.positioning).toBeUndefined();
    expect(a.factIds).toEqual(["oneLiner", "vocabulary.banned"]);
    expect((await compileBrandContext(structuredClone(kit))).hash).toBe(a.hash);
  });

  it("filters channel rules to the requested channel", async () => {
    const kit = applyKitOps(base(), [
      { op: "set", path: "channelRules.instagram", value: ["Max 5 hashtags"] },
      { op: "set", path: "channelRules.linkedin", value: ["No emojis"] },
    ], ctx).kit;
    expect((await compileBrandContext(kit, { channel: "linkedin" })).data.channelRules).toEqual({ linkedin: ["No emojis"] });
  });

  it("stays within the token budget for a maximal kit and keeps every banned word", async () => {
    const long = "తెలుగు వంటకాలు ".repeat(80).trim().slice(0, 1900);
    const many = Array.from({ length: 30 }, (_, i) => `item ${i} ${"x".repeat(200)}`);
    const banned = Array.from({ length: 30 }, (_, i) => `banned${i}`);
    const ops = [
      ...["oneLiner"].map((p) => ({ op: "set" as const, path: p, value: long.slice(0, 200) })),
      ...["positioning", "mission", "vision", "visual.imageryStyle"].map((p) => ({ op: "set" as const, path: p, value: long })),
      ...["differentiators", "proofPoints", "objections", "voice.tone", "voice.personality", "voice.do", "voice.dont", "visual.layoutRules", "vocabulary.preferred"].map((p) => ({ op: "set" as const, path: p, value: many })),
      { op: "set" as const, path: "vocabulary.banned", value: banned },
      ...Array.from({ length: 8 }, (_, i) => ({ op: "add" as const, list: "audiences" as const, value: { name: `Audience ${i}`, description: long.slice(0, 900), pains: many.slice(0, 10), desires: many.slice(0, 10) } })),
      ...Array.from({ length: 30 }, (_, i) => ({ op: "add" as const, list: "offers" as const, value: { name: `Offer ${i}`, benefit: "y".repeat(290) } })),
    ];
    const kit = applyKitOps(base(), ops, ctx).kit;
    const c = await compileBrandContext(kit);
    expect(c.tokenEstimate).toBeLessThanOrEqual(CONTEXT_TOKEN_BUDGET);
    expect(estimateTokens(stableStringify(c.data))).toBe(c.tokenEstimate);
    expect(c.data.vocabulary.banned).toHaveLength(30);
  });

  it("detects affected content", () => {
    expect(isAffectedByFactChange(["oneLiner", "voice.tone"], ["voice.tone"])).toBe(true);
    expect(isAffectedByFactChange(["oneLiner"], ["visual.colors"])).toBe(false);
  });
});

describe("kitCompleteness", () => {
  it("scores approved essentials and counts pending suggestions", () => {
    const empty = kitCompleteness(base());
    expect(empty.score).toBe(0);
    let kit: BrandKit = applyKitOps(base(), [
      { op: "set", path: "oneLiner", value: "Home-style tiffins" },
      { op: "set", path: "voice.tone", value: ["warm"] },
      { op: "add", list: "offers", value: { name: "Tiffin" } },
    ], ctx).kit;
    kit = mergeSuggestions(kit, { facts: { positioning: { value: "x", confidence: 0.5, sources: [] } } }, ctx).kit;
    const c = kitCompleteness(kit);
    expect(c.score).toBeGreaterThan(0);
    expect(c.missing.map((m) => m.key)).toContain("positioning");
    expect(c.pendingSuggestions).toBe(1);
  });
});
