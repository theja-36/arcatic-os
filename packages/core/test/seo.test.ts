import { describe, expect, it } from "vitest";
import {
  applyLink, articleJsonLd, checkClaims, claimsScore, classifyIntent, clusterKeywords, countPhrase, docFrom, docToHtml, extractClaims,
  faqPairs, isQuestion, mergeIdeas, postText, scoreSeo, suggestInternalLinks, type ContentDoc,
} from "../src/index.js";

const para = (n: number, extra = "") => `${extra}${Array.from({ length: n }, (_, i) => `Sentence ${i} explains diwali gift hampers for teams.`).join(" ")}`;

const good: ContentDoc = docFrom([
  ["title", "Diwali gift hampers: how to choose for your team"],
  ["meta_description", "Choosing diwali gift hampers for a team? Compare budgets, delivery times and what employees actually value in 2026."],
  ["paragraph", "Diwali gift hampers work best when they match your budget and arrive before the festival. Plan three weeks ahead."],
  ["heading", "What should a corporate Diwali hamper include?"],
  ["paragraph", "Sweets, dry fruits and one useful item. " + para(12)],
  ["heading", "How much should you spend per person?"],
  ["paragraph", "Most teams spend ₹800 to ₹1,500 per person. " + para(12)],
  ["heading", "When should you order?"],
  ["paragraph", "Order by 1 October for delivery across India. See our [delivery guide](https://example.in/delivery) and https://www.rbi.org.in/report."],
  ["list_item", "Set a budget"], ["list_item", "Pick 3 items"], ["list_item", "Confirm addresses"],
  ["heading", "FAQ"],
  ["paragraph", para(20, "More detail with [hamper ideas](https://example.in/blog/hamper-ideas). ")],
]);

describe("SEO / AEO scoring", () => {
  it("counts phrases with plural folding and word boundaries", () => {
    expect(countPhrase("Gift hampers and a gift hamper", "gift hamper")).toBe(2);
    expect(countPhrase("giftshampers", "gift hamper")).toBe(0);
  });

  it("scores a well-structured article high and explains each check", () => {
    const r = scoreSeo(good, { primary: "diwali gift hampers" }, { siteHosts: ["example.in"], minWords: 300 });
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
    expect(by.kw_title).toBe("pass");
    expect(by.kw_intro).toBe("pass");
    expect(by.answer_first).toBe("pass");
    expect(by.question_headings).toBe("pass");
    expect(by.internal_links).toBe("pass");
    expect(by.external_sources).toBe("pass");
    expect(by.faq).toBe("pass");
    expect(r.score).toBeGreaterThanOrEqual(75);
  });

  it("fails thin, unstructured, stuffed content", () => {
    const bad = docFrom([["title", "Hampers"], ["paragraph", "diwali gift hampers diwali gift hampers diwali gift hampers buy diwali gift hampers now"]]);
    const r = scoreSeo(bad, { primary: "diwali gift hampers" }, { siteHosts: ["example.in"] });
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
    expect(by.kw_title).toBe("fail");
    expect(by.kw_density).toBe("fail");
    expect(by.meta_length).toBe("fail");
    expect(by.question_headings).toBe("fail");
    expect(r.score).toBeLessThan(50);
  });

  it("skips keyword checks without a keyword but says so", () => {
    const r = scoreSeo(good, {});
    expect(r.checks.find((c) => c.id === "keyword_set")?.status).toBe("warn");
    expect(r.checks.some((c) => c.id === "kw_title")).toBe(false);
    expect(r.checks.find((c) => c.id === "internal_links")?.detail).toMatch(/brand kit/);
  });

  it("recognises question headings", () => {
    expect(isQuestion("How much should you spend?")).toBe(true);
    expect(isQuestion("Why it matters")).toBe(true);
    expect(isQuestion("Budget tips")).toBe(false);
  });
});

describe("source-backed claims", () => {
  const doc = docFrom([
    ["paragraph", "Our hampers reached 12,000 customers in 2025. We are the best gifting brand in India. Studies show employees prefer useful gifts. Delivery is guaranteed in 48 hours."],
  ]);
  const claims = extractClaims(doc);

  it("extracts checkable sentences with their kind and figures", () => {
    expect(claims.map((c) => c.kinds)).toEqual([["statistic"], ["superlative"], ["attribution"], ["guarantee"]]);
    expect(claims[0]!.figures).toEqual(expect.arrayContaining(["12000", "2025"]));
  });

  it("maps claims to evidence: figures must match, words must overlap", () => {
    const checks = checkClaims(claims, [
      { id: "c1", kind: "chunk", text: "In 2025 our gift hampers reached 12,000 customers across 40 cities." },
      { id: "c2", kind: "chunk", text: "A 2024 survey found that employees prefer useful gifts over sweets." },
    ]);
    expect(checks[0]).toMatchObject({ status: "supported", risk: "low" });
    expect(checks[0]!.evidence[0]!.id).toBe("c1");
    expect(checks[1]).toMatchObject({ status: "unsupported", risk: "high" });
    expect(checks[2]!.status).toBe("supported");   // the survey backs it
    expect(checks[3]).toMatchObject({ status: "unsupported", risk: "high" });
    const s = claimsScore(checks);
    expect(s.supported).toBe(2);
    expect(s.highRisk).toBeGreaterThanOrEqual(2);
  });

  it("does not accept a matching sentence with a different number", () => {
    const [c] = checkClaims([claims[0]!], [{ id: "x", kind: "chunk", text: "Our hampers reached 1,200 customers in 2025." }]);
    expect(c!.status).not.toBe("supported");
  });
});

describe("internal links", () => {
  const doc = docFrom([
    ["title", "Corporate gifting guide"],
    ["paragraph", "Planning corporate gift hampers early saves money. Ask about bulk pricing before September."],
    ["paragraph", "Personalised packaging makes a hamper memorable."],
  ]);
  const targets = [
    { url: "https://example.in/bulk-pricing", title: "Bulk pricing for corporate gift hampers", keywords: ["bulk pricing"] },
    { url: "https://example.in/packaging", title: "Personalised packaging options" },
    { url: "https://other.com/hampers", title: "Corporate gift hampers" },
    { url: "https://example.in/recipes", title: "Kaju katli recipe", text: "sugar cashew ghee cardamom" },
  ];

  it("suggests relevant own-site pages with an anchor already in the text", () => {
    const s = suggestInternalLinks(doc, targets, { siteHosts: ["example.in"] });
    expect(s.map((x) => x.url).sort()).toEqual(["https://example.in/bulk-pricing", "https://example.in/packaging"]);
    expect(s.find((x) => x.url.endsWith("bulk-pricing"))!.anchor).toBe("bulk pricing");
    expect(new Set(s.map((x) => x.blockId)).size).toBe(s.length);
  });

  it("applies an accepted link as markdown, rendered as HTML and as plain text for social", () => {
    const s = suggestInternalLinks(doc, targets, { siteHosts: ["example.in"] })[0]!;
    const linked = applyLink(doc, s);
    const block = linked.blocks.find((b) => b.id === s.blockId)!;
    expect(block.text).toContain(`[${s.anchor}](${s.url})`);
    expect(block.origin).toBe("human");
    expect(docToHtml(linked)).toContain(`<a href="${s.url}">${s.anchor}</a>`);
    expect(postText("social_post", linked).text).toContain(`${s.anchor} (${s.url})`);
    expect(suggestInternalLinks(linked, targets, { siteHosts: ["example.in"] }).some((x) => x.url === s.url)).toBe(false);
  });

  it("escapes anchors and keeps bare URLs working", () => {
    const html = docToHtml(docFrom([["paragraph", "See [<b>x</b>](https://a.example/p?q=1) or https://b.example/x."]]));
    expect(html).toContain('<a href="https://a.example/p?q=1">&lt;b&gt;x&lt;/b&gt;</a>');
    expect(html).toContain('<a href="https://b.example/x.">');
  });
});

describe("keywords", () => {
  it("classifies search intent", () => {
    expect(classifyIntent("buy diwali hampers online")).toBe("transactional");
    expect(classifyIntent("best diwali hampers 2026")).toBe("commercial");
    expect(classifyIntent("how to pack a diwali hamper")).toBe("informational");
    expect(classifyIntent("arcatic hampers", ["Arcatic"])).toBe("navigational");
  });

  it("clusters by shared words with the highest-volume head", () => {
    const c = clusterKeywords(mergeIdeas([
      { keyword: "diwali gift hampers", avgMonthlySearches: 9000 },
      { keyword: "diwali gift hamper online", avgMonthlySearches: 1000 },
      { keyword: "corporate diwali gifts", avgMonthlySearches: 3000 },
      { keyword: "corporate diwali gifts for employees", avgMonthlySearches: 800 },
      { keyword: "kaju katli recipe" },
    ]));
    expect(c[0]).toMatchObject({ label: "diwali gift hampers", volume: 10000 });
    expect(c[0]!.keywords).toContain("diwali gift hamper online");
    expect(c.find((x) => x.label === "corporate diwali gifts")!.keywords).toHaveLength(2);
    expect(c.at(-1)).toMatchObject({ label: "kaju katli recipe", volume: null });
  });

  it("merges duplicates and keeps planner numbers", () => {
    const m = mergeIdeas([{ keyword: "Diwali Hampers", avgMonthlySearches: 500 }], [{ keyword: "diwali hampers" }]);
    expect(m).toHaveLength(1);
    expect(m[0]!.avgMonthlySearches).toBe(500);
  });
});

describe("structured data", () => {
  it("builds Article + FAQPage JSON-LD from question headings, inventing nothing", () => {
    expect(faqPairs(good)).toHaveLength(3);
    const ld = articleJsonLd(good, { url: "https://example.in/blog/hampers", publisher: "Example" });
    expect(ld[0]).toMatchObject({ "@type": "Article", headline: "Diwali gift hampers: how to choose for your team", publisher: { name: "Example" } });
    expect(ld[0]).not.toHaveProperty("author");
    expect(ld[1]).toMatchObject({ "@type": "FAQPage" });
    expect((ld[1]!.mainEntity as unknown[]).length).toBe(3);
  });
});
