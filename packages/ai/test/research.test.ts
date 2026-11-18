import { compileBrandContext, emptyKit, faqPairs, scoreSeo } from "@arcatic/core";
import { describe, expect, it } from "vitest";
import { runTemplate } from "../src/generate.js";
import type { LlmProvider, StructuredRequest } from "../src/provider.js";
import { adsBrief, analyzeCompetitor, googleRsaCopy, metaAdCopy, seoBrief, suggestKeywords } from "../src/research.js";
import { blogV2 } from "../src/templates.js";

const brand = () => compileBrandContext(emptyKit("b1", "Annapurna Tiffins"));
const fake = (output: unknown) => {
  const calls: StructuredRequest<never>[] = [];
  const p: LlmProvider = {
    async generateStructured(req) {
      calls.push(req as never);
      return { output: req.schema.parse(output), model: req.model, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: "end_turn", servedByFallback: false };
    },
  };
  return { p, calls };
};
const meta = { workspaceId: "w" };

describe("blog.article@2 (SEO/AEO)", () => {
  it("puts the direct answer first, keeps bullets and builds a quotable FAQ", async () => {
    const { p, calls } = fake({
      title: "Tiffin service in Pune: what to expect", meta_description: "M", answer: "A tiffin service delivers home-style meals daily for a monthly fee.", intro: "Intro.",
      sections: [{ heading: "How much does a tiffin service cost?", paragraphs: ["Most plans cost ₹3,000 a month."], bullets: ["Veg", "Non-veg"] }],
      faqs: [{ question: "Can I pause my plan?", answer: "Yes, with a day's notice." }, { question: "Is delivery free?", answer: "Within 5 km." }], conclusion: "C", cited_chunk_ids: [],
    });
    const r = await runTemplate(p, blogV2, { brand: await brand(), knowledge: [], input: { topic: "Tiffin service Pune", keyword: "tiffin service pune", outline: [{ heading: "Cost", points: ["plans"] }], faqs: ["Can I pause my plan?"] } }, meta);
    const kinds = r.doc.blocks.map((b) => b.kind);
    expect(kinds.slice(0, 4)).toEqual(["title", "meta_description", "paragraph", "paragraph"]);
    expect(kinds.filter((k) => k === "list_item")).toHaveLength(2);
    expect(faqPairs(r.doc).map((f) => f.q)).toContain("Can I pause my plan?");
    expect(scoreSeo(r.doc, { primary: "tiffin service pune" }).checks.find((c) => c.id === "answer_first")?.status).toBe("pass");
    const user = (calls[0] as unknown as { user: string }).user;
    expect(user).toContain("Follow this researched outline");
    expect(user).toContain("Can I pause my plan?");
  });
});

describe("research helpers", () => {
  it("competitor analysis keeps only claims quoted verbatim from the crawled page", async () => {
    const { p } = fake({
      positioning: "Premium tiffins.", audiences: ["office workers"], topics: [{ topic: "Diet plans", page_ids: ["p1", "nope"] }], offers: ["₹2,999/month"],
      claims: [{ quote: "Pune's most loved tiffin service since 2015", page_id: "p1" }, { quote: "Voted #1 in India", page_id: "p1" }], gaps: [{ topic: "Jain meals", why: "Not covered" }],
    });
    const r = await analyzeCompetitor(p, { brand: await brand(), name: "Rival", language: "en", pages: [{ id: "p1", url: "https://rival.in", title: "Home", text: "Welcome. Pune's most loved tiffin service since 2015. Order today." }] }, meta);
    expect(r.output.claims).toEqual([{ text: "Pune's most loved tiffin service since 2015", url: "https://rival.in" }]);
    expect(r.output.topics[0]!.pageUrls).toEqual(["https://rival.in"]);
  });

  it("AI keywords carry no search volumes and are de-duplicated", async () => {
    const { p } = fake({ keywords: [{ keyword: "Tiffin Service Pune", intent: "commercial" }, { keyword: "tiffin  service pune", intent: "commercial" }, { keyword: "how to choose a tiffin service", intent: "informational" }] });
    const r = await suggestKeywords(p, { brand: await brand(), seeds: ["tiffin"], language: "en", geo: "India" }, meta);
    expect(r.output).toHaveLength(2);
    expect(r.output.every((k) => k.avgMonthlySearches === null)).toBe(true);
  });

  it("SEO brief drops unknown chunk ids and bounds the word count", async () => {
    const { p } = fake({ question: "Q?", intent: "informational", title_options: ["A"], outline: [{ heading: "H", points: ["p"] }], faqs: ["F?"], entities: ["e"], words: 7000, notes: "n", cited_chunk_ids: ["k1", "ghost"] });
    const r = await seoBrief(p, { brand: await brand(), keyword: "k", secondary: [], language: "en", competitors: [], knowledge: [{ chunkId: "k1", content: "x" }] }, meta);
    expect(r.output.words).toBe(3000);
    expect(r.output.citedChunkIds).toEqual(["k1"]);
  });

  it("ads brief: Google gets keywords only, Meta interest names only, ages clamped", async () => {
    const out = { summary: "S", angles: ["a"], audiences: [{ name: "Office", description: "d", interest_names: ["Healthy eating"], keywords: [{ text: "Tiffin Service", match: "PHRASE" }], negative_keywords: ["free"], age_min: 12, age_max: 80, location_hints: ["Pune"] }] };
    const g = await adsBrief(fake(out).p, { brand: await brand(), platform: "google", objective: "website_traffic", knowledge: [] }, meta);
    expect(g.output.audiences[0]).toMatchObject({ interestNames: [], keywords: [{ text: "tiffin service", match: "PHRASE" }], ageMin: 18, ageMax: 65 });
    const m = await adsBrief(fake(out).p, { brand: await brand(), platform: "meta", objective: "traffic", knowledge: [] }, meta);
    expect(m.output.audiences[0]).toMatchObject({ interestNames: ["Healthy eating"], keywords: [] });
  });

  it("RSA copy drops what breaks Google's limits instead of truncating", async () => {
    const { p } = fake({ headlines: ["Fresh tiffins daily!", "Fresh tiffins daily", "This headline is far too long for Google ads", "Home-style meals"], descriptions: ["Good food.", "x".repeat(95)], path1: "Tiffin Plans", path2: "pune", cited_chunk_ids: [] });
    const r = await googleRsaCopy(p, { brand: await brand(), brief: "b", keywords: [], language: "en", knowledge: [] }, meta);
    expect(r.output.headlines).toEqual(["Fresh tiffins daily", "Home-style meals"]);
    expect(r.output.descriptions).toEqual(["Good food."]);
    expect(r.output.path1).toBe("tiffin-plans");
  });

  it("Meta copy de-duplicates", async () => {
    const { p } = fake({ primary_texts: ["A", "A", "B"], headlines: ["H"], descriptions: ["D"], cited_chunk_ids: [] });
    const r = await metaAdCopy(p, { brand: await brand(), brief: "b", objective: "traffic", language: "en", knowledge: [] }, meta);
    expect(r.output.primaryTexts).toEqual(["A", "B"]);
  });
});
