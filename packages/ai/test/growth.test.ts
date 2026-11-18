import { CONTENT_TYPE_DEFS, WIZARDS, compileBrandContext, emptyKit, missingFields, wizardDefaults, wizardToRequest, type ContentType } from "@arcatic/core";
import { describe, expect, it } from "vitest";
import { TEMPLATES, digestSource, type LlmProvider } from "../src/index.js";

const filler: Record<string, unknown> = { topic: "Diwali gift boxes for offices", customer: "Annapurna Foods", challenge: "Orders by phone only", solution: "Online ordering", results: "Orders doubled in 3 months", product: "Kaju katli box 500 g" };

describe("wizards", () => {
  it("every wizard's request validates against its template input", () => {
    for (const w of WIZARDS.filter((x) => x.type && x.steps.length)) {
      const types = w.typeChoice?.map(([t]) => t) ?? [w.type!];
      for (const t of types) {
        const v: Record<string, unknown> = { ...wizardDefaults(w), __type: t };
        for (const s of w.steps) for (const k of missingFields(s, v)) v[k] = filler[k] ?? "x".repeat(5);
        const req = wizardToRequest(w, v);
        const def = CONTENT_TYPE_DEFS[req.type as ContentType];
        const tpl = TEMPLATES[def.template!];
        expect(tpl, `${w.id}/${t}`).toBeDefined();
        const parsed = tpl!.input.safeParse({ ...req.input, ...(def.channels && !req.input.channel && "defaultChannel" in def && { channel: def.defaultChannel }) });
        expect(parsed.success, `${w.id}/${t}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      }
    }
  });
  it("every generatable text type has a registered template", () => {
    for (const [k, d] of Object.entries(CONTENT_TYPE_DEFS)) if (d.category === "text") expect(TEMPLATES[d.template!], k).toBeDefined();
  });
});

describe("guardrails in toDoc", () => {
  const pr = TEMPLATES["pr.release@1"]!;
  const out = { headline: "Annapurna opens in Kondapur", subheadline: "Second outlet", lead: "Annapurna opened…", body_paragraphs: ["a", "b", "c"], boilerplate: "About", cited_chunk_ids: [] };
  it("press release uses the supplied quote verbatim, or a marked placeholder — never a model quote", () => {
    const withQuote = pr.toDoc(out, pr.input.parse({ topic: "New outlet opens", quote_text: "We're thrilled.", quote_person: "Ravi", quote_role: "Founder", location: "Hyderabad" })).doc;
    expect(withQuote.blocks.find((b) => b.kind === "quote")!.text).toBe("\"We're thrilled.\" — Ravi, Founder");
    expect(withQuote.blocks[2]!.text.startsWith("HYDERABAD — ")).toBe(true);
    const none = pr.toDoc(out, pr.input.parse({ topic: "New outlet opens", quote_person: "Ravi" })).doc;
    expect(none.blocks.find((b) => b.kind === "quote")!.text).toBe("[Add an approved quote from Ravi here]");
  });
  it("case study has no quote unless one was given", () => {
    const cs = TEMPLATES["case.study@1"]!;
    const o = { title: "t", meta_description: "m", summary: "s", challenge: ["c"], solution: ["s"], results: ["r"], highlights: ["h"], cta: "go", cited_chunk_ids: [] };
    const base = { customer: "A", challenge: "c", solution: "s", results: "r" };
    expect(cs.toDoc(o, cs.input.parse(base)).doc.blocks.some((b) => b.kind === "quote")).toBe(false);
    expect(cs.toDoc(o, cs.input.parse({ ...base, quote_text: "Great team" })).doc.blocks.find((b) => b.kind === "quote")!.text).toBe("\"Great team\"");
  });
  it("brainstorm keeps formats and channels to what was asked", () => {
    const b = TEMPLATES["ideas.brainstorm@1"]!;
    const i = b.input.parse({ topic: "Diwali", count: 5, formats: ["social_post", "email"], channels: ["linkedin"] });
    const doc = b.toDoc({ ideas: [{ title: "T", angle: "A", format: "podcast", channel: "myspace", why: "W" }] }, i).doc;
    expect(doc.blocks[0]!.meta).toMatchObject({ idea: { format: "social_post", channel: "linkedin" } });
  });
});

describe("digestSource", () => {
  it("keeps only verbatim quotes and known chunk ids, and reports truncation", async () => {
    const brand = await compileBrandContext(emptyKit("b1", "Annapurna"));
    const provider: LlmProvider = {
      async generateStructured(req) {
        return { output: req.schema.parse({
          title: "Our story", summary: "S",
          key_points: [{ point: "Founded 1998", chunk_ids: ["c1", "made-up"] }],
          quotes: [{ text: "We cook  every idli fresh", chunk_id: "c1" }, { text: "Best in the world", chunk_id: "c1" }, { text: "x", chunk_id: "nope" }],
          angles: [{ angle: "Heritage", best_for: "blog" }],
        }), model: "claude-opus-5-5", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: "end_turn", servedByFallback: false };
      },
    };
    const r = await digestSource(provider, { brand, title: "About", kindLabel: "web page", language: "en", chunks: [{ chunkId: "c1", content: "Since 1998 we cook every idli fresh each morning." }] }, { workspaceId: "w" });
    expect(r.digest.key_points[0]!.chunk_ids).toEqual(["c1"]);
    expect(r.digest.quotes.map((q) => q.text)).toEqual(["We cook  every idli fresh"]);
    expect(r.truncated).toBe(false);
  });
});
