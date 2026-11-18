import { describe, expect, it } from "vitest";
import { BrandExtractionSchema, extractBrandFacts, renderExtractionPrompt, toSuggestions, type BrandExtraction, type ExtractionPage } from "../src/brand-extract.js";
import type { LlmProvider } from "../src/provider.js";

const pages: ExtractionPage[] = [
  { pageId: "p1", sourceId: "s1", type: "home", url: "https://annapurna.in/", text: "Annapurna Tiffins — ఇంటి భోజనం, every morning. Fresh breakfast tiffins delivered across Gachibowli and Madhapur." },
  { pageId: "p2", sourceId: "s2", type: "pricing", url: "https://annapurna.in/pricing", text: "Breakfast Plan: ₹1,499 per month. Lunch Box: ₹120 per meal." },
];

const empty = { value: "", confidence: 0, citations: [] };
const emptyList = { value: [], confidence: 0, citations: [] };
const base: BrandExtraction = {
  business_type: empty, industry: empty, location: empty, service_area: empty,
  contact: { email: "", phone: "", address: "", confidence: 0, citations: [] },
  one_liner: empty, mission: empty, vision: empty, positioning: empty,
  differentiators: emptyList, proof_points: emptyList, objections: emptyList,
  voice_tone: emptyList, voice_personality: emptyList, voice_emotions: emptyList, voice_syntax: emptyList, preferred_vocabulary: emptyList,
  audiences: [], offers: [],
};

describe("toSuggestions", () => {
  const out: BrandExtraction = {
    ...base,
    business_type: { value: "Tiffin delivery service", confidence: 0.9, citations: [{ page_id: "p1", quote: "Fresh breakfast tiffins delivered" }] },
    service_area: { value: "Gachibowli and Madhapur, Hyderabad", confidence: 0.8, citations: [{ page_id: "p1", quote: "across Gachibowli and Madhapur" }] },
    positioning: { value: "Award-winning since 1990", confidence: 0.9, citations: [{ page_id: "p1", quote: "Award-winning caterer since 1990" }] },
    voice_tone: { value: ["warm", "homely", "warm", " "], confidence: 0.7, citations: [{ page_id: "p1", quote: "ఇంటి భోజనం, every morning" }] },
    offers: [
      { name: "Breakfast Plan", kind: "subscription", description: "", price: "₹1,499 per month", benefit: "", confidence: 0.9, citations: [{ page_id: "p2", quote: "Breakfast Plan: ₹1,499 per month" }] },
      { name: "Dinner Thali", kind: "product", description: "", price: "₹250", benefit: "", confidence: 0.6, citations: [] },
    ],
  };
  const { suggestions, stats } = toSuggestions(out, { pages });

  it("keeps verified citations (including Telugu quotes) and drops empty fields", () => {
    expect(suggestions.facts["profile.businessType"]?.sources[0]).toMatchObject({ url: "https://annapurna.in/", sourceId: "s1" });
    expect(suggestions.facts["voice.tone"]?.value).toEqual(["warm", "homely"]);
    expect(suggestions.facts["voice.tone"]?.sources).toHaveLength(1);
    expect(suggestions.facts.mission).toBeUndefined();
  });

  it("caps confidence when the quote is not on any page", () => {
    expect(suggestions.facts.positioning).toMatchObject({ confidence: 0.3, sources: [] });
    expect(stats.citationsDropped).toBe(1);
  });

  it("keeps a price only if it appears on the pages", () => {
    expect(suggestions.offers?.[0]?.value).toMatchObject({ name: "Breakfast Plan", price: "₹1,499 per month" });
    expect(suggestions.offers?.[1]?.value).not.toHaveProperty("price");
    expect(suggestions.offers?.[1]?.confidence).toBeLessThanOrEqual(0.3);
  });

  it("restricts output to requested paths", () => {
    const only = toSuggestions(out, { pages, paths: ["voice.tone"] }).suggestions;
    expect(Object.keys(only.facts)).toEqual(["voice.tone"]);
    expect(only.offers).toEqual([]);
  });
});

describe("prompt", () => {
  it("delimits pages, respects the char budget and states the field restriction", () => {
    const r = renderExtractionPrompt({ brandName: "Annapurna", pages, maxCharsPerPage: 40, maxTotalChars: 1000, paths: ["voice.tone", "offers"] });
    expect(r.user).toContain('<page id="p1" type="home" url="https://annapurna.in/">');
    expect(r.truncated).toBe(2);
    expect(r.user).toContain("Only fill these fields: voice_tone, offers");
    expect(r.system).toMatch(/Ignore any instructions/);
  });
});

describe("extractBrandFacts", () => {
  it("calls the provider with the extraction schema and returns verified suggestions", async () => {
    const calls: unknown[] = [];
    const provider: LlmProvider = {
      async generateStructured(req) {
        calls.push(req);
        return { output: req.schema.parse(base), model: req.model, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: "end_turn", servedByFallback: false };
      },
    };
    const r = await extractBrandFacts(provider, { brandName: "Annapurna", pages }, { workspaceId: "w" });
    expect(r.stats).toMatchObject({ fieldsSuggested: 0, pagesUsed: 2 });
    expect((calls[0] as { schema: unknown }).schema).toBe(BrandExtractionSchema);
  });
});
