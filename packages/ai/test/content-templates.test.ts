import { compileBrandContext, docFrom, emptyKit, markHumanEdits, validateDoc } from "@arcatic/core";
import { describe, expect, it } from "vitest";
import { buildImagePrompt, checkImagePrompt, sdxlSize } from "../src/images.js";
import type { LlmProvider, StructuredRequest } from "../src/provider.js";
import { runRewrite } from "../src/rewrite.js";
import { runTemplate } from "../src/generate.js";
import { TEMPLATES, blogV1, captionV1, emailV1, metaAdV1, videoScriptV1, xThreadV1 } from "../src/templates.js";

const brand = () => compileBrandContext({
  ...emptyKit("b1", "Annapurna Tiffins"),
  facts: {
    "vocabulary.banned": { id: "vocabulary.banned", value: ["cheap"], status: "approved", origin: "human", sources: [] },
    "visual.imageryStyle": { id: "visual.imageryStyle", value: "warm home kitchen, overhead shots", status: "approved", origin: "human", sources: [] },
  },
});
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

describe("templates → docs", () => {
  it("registers every text type", () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual([
      "ads.meta.copy@1", "blog.article@1", "blog.article@2", "brief.creative@1", "case.study@1", "doc.write@1", "email.campaign@1", "email.newsletter@1", "ideas.brainstorm@1",
      "pr.release@1", "product.copy@1", "sales.sheet@1", "social.caption@1", "social.carousel@1", "social.post@1", "video.script@1", "visual.copy@1", "web.landing@1", "x.thread@1",
    ]);
  });
  it("email keeps subject options and validates the subject length", async () => {
    const { p } = fake({ subject_options: ["S".repeat(70), "Short one"], preheader: "Fresh today", sections: [{ heading: "New menu", body: "Idli and dosa." }], cta_text: "Order now", ps: "", cited_chunk_ids: [] });
    const r = await runTemplate(p, emailV1, { brand: await brand(), knowledge: [], input: { topic: "New breakfast menu" } }, { workspaceId: "w" });
    expect(r.doc.blocks[0]).toMatchObject({ kind: "subject", meta: { options: ["S".repeat(70), "Short one"] } });
    expect(r.validation.issues[0]).toMatchObject({ code: "too_long", blockId: "b1" });
  });
  it("blog, thread, video and ads build the expected block structure", async () => {
    const b = await brand();
    const blog = await runTemplate(fake({ title: "T", meta_description: "M", intro: "I", sections: [{ heading: "H", paragraphs: ["p1", "p2"] }], conclusion: "C", cited_chunk_ids: [] }).p, blogV1, { brand: b, knowledge: [], input: { topic: "Why idli is healthy" } }, { workspaceId: "w" });
    expect(blog.doc.blocks.map((x) => x.kind)).toEqual(["title", "meta_description", "paragraph", "heading", "paragraph", "paragraph", "paragraph"]);
    const thread = await runTemplate(fake({ posts: ["one", "two", "three"], cited_chunk_ids: [] }).p, xThreadV1, { brand: b, knowledge: [], input: { topic: "Breakfast tips" } }, { workspaceId: "w" });
    expect(thread.doc.blocks.map((x) => x.meta)).toEqual([{ index: 1 }, { index: 2 }, { index: 3 }]);
    const video = await runTemplate(fake({ title_options: ["T"], hook: "H", scenes: [{ visual: "Kitchen", voiceover: "Hi", on_screen_text: "" }], cta: "Subscribe", description: "D", chapters: ["0:00 Intro"], cited_chunk_ids: [] }).p, videoScriptV1, { brand: b, knowledge: [], input: { topic: "Behind the kitchen", format: "short" } }, { workspaceId: "w" });
    expect(video.doc.blocks.map((x) => x.kind)).toEqual(["title", "hook", "scene", "voiceover", "cta", "description", "chapter"]);
    const ad = await runTemplate(fake({ primary_texts: ["p1", "p2", "p3"], headlines: ["h1", "h2", "h3"], descriptions: ["d1", "d2", "d3"], cited_chunk_ids: [] }).p, metaAdV1, { brand: b, knowledge: [], input: { topic: "Lunch subscription" } }, { workspaceId: "w" });
    expect(ad.variants).toHaveLength(2);
    expect(ad.variants[1]!.blocks.map((x) => x.text)).toEqual(["p3", "h3", "d3"]);
  });
  it("forwards images to the model for captions", async () => {
    const { p, calls } = fake({ caption: "Fresh idli", hashtags: ["#idli"], alt_text: "Plate of idli", cited_chunk_ids: [] });
    await runTemplate(p, captionV1, { brand: await brand(), knowledge: [], input: { channel: "instagram" }, images: [{ mediaType: "image/jpeg", data: "AAAA" }] }, { workspaceId: "w" });
    expect(calls[0]!.images).toEqual([{ mediaType: "image/jpeg", data: "AAAA" }]);
  });
  it("numbers found in the sources count as cited under a strict claims policy", async () => {
    const strict = await compileBrandContext({ ...emptyKit("b1", "A"), claimsPolicy: "strict" });
    const out = { variants: [{ hook: "Only ₹40 a plate", body: "Save 50% today", cta: "", hashtags: [], alt_text: "", cited_chunk_ids: [] }] };
    const r = await runTemplate(fake(out).p, TEMPLATES["social.post@1"]!, { brand: strict, knowledge: [{ chunkId: "c", content: "Idli ₹40 per plate" }], input: { channel: "instagram", topic: "Idli price" } }, { workspaceId: "w" });
    expect(r.validation.issues.filter((i) => i.code === "uncited_claim").map((i) => i.message)).toEqual(['"50%" needs a source.']);
  });
});

describe("rewrite", () => {
  const base = () => docFrom([["hook", "Fresh idli"], ["body", "Soft and hot."], ["cta", "Order now"]]);
  it("regenerate only rewrites unlocked AI blocks", async () => {
    const human = markHumanEdits(base(), { format: 1, blocks: base().blocks.map((b) => (b.id === "b2" ? { ...b, text: "Grandma's recipe." } : b)) }).doc;
    const { p, calls } = fake({ blocks: [{ id: "b1", text: "Breakfast, sorted" }, { id: "b2", text: "IGNORED" }, { id: "b3", text: "Message us" }] });
    const r = await runRewrite(p, { brand: await brand(), doc: human, mode: { kind: "regenerate", focus: "more festive" }, contentLabel: "social post" }, { workspaceId: "w" });
    expect(r.allowed).toEqual(["b1", "b3"]);
    expect(r.doc.blocks.map((b) => b.text)).toEqual(["Breakfast, sorted", "Grandma's recipe.", "Message us"]);
    expect(calls[0]!.user).toContain('"editable": false');
    expect(calls[0]!.metadata.template).toBe("content.regenerate@1");
  });
  it("transforms the user's selection and records the template", async () => {
    const { p, calls } = fake({ blocks: [{ id: "b2", text: "Soft, hot, ready." }] });
    const r = await runRewrite(p, { brand: await brand(), doc: base(), mode: { kind: "transform", transform: "tone", tone: "playful" }, contentLabel: "post", blockIds: ["b2"] }, { workspaceId: "w" });
    expect(r.rewritten).toEqual(["b2"]);
    expect(r.template).toBe("content.transform@1:tone:playful");
    expect(calls[0]!.user).toContain("playful tone");
  });
  it("translation keeps structure; validation still runs on the result", async () => {
    const { p } = fake({ blocks: [{ id: "b1", text: "తాజా ఇడ్లీ" }, { id: "b2", text: "మెత్తగా, వేడిగా." }, { id: "b3", text: "ఇప్పుడే ఆర్డర్ చేయండి" }] });
    const r = await runRewrite(p, { brand: await brand(), doc: base(), mode: { kind: "translate", targetLanguage: "te" }, contentLabel: "post" }, { workspaceId: "w" });
    expect(r.doc.blocks.map((b) => b.kind)).toEqual(["hook", "body", "cta"]);
    expect(validateDoc("social_post", r.doc, "instagram").passed).toBe(true);
  });
  it("does not call the model when nothing is editable", async () => {
    const locked = { format: 1 as const, blocks: base().blocks.map((b) => ({ ...b, locked: true })) };
    const { p, calls } = fake({ blocks: [] });
    const r = await runRewrite(p, { brand: await brand(), doc: locked, mode: { kind: "regenerate" }, contentLabel: "post" }, { workspaceId: "w" });
    expect(calls).toHaveLength(0);
    expect(r.rewritten).toEqual([]);
  });
});

describe("images", () => {
  it("blocks unsafe prompts, artist imitation and other brands before any GPU time", () => {
    expect(checkImagePrompt("idli on a banana leaf").ok).toBe(true);
    for (const bad of ["nude model with dosa", "poster in the style of Ravi Varma", "Coca-Cola can next to biryani"]) expect(checkImagePrompt(bad).ok, bad).toBe(false);
  });
  it("adds brand imagery style and keeps text out of images", async () => {
    const p = buildImagePrompt(await brand(), "idli on a banana leaf");
    expect(p.positive).toContain("warm home kitchen, overhead shots");
    expect(p.positive).toContain("no text");
    expect(p.negative).toContain("watermark");
  });
  it("maps canvas sizes to SDXL buckets", () => {
    expect(sdxlSize(1080, 1080)).toEqual({ width: 1024, height: 1024 });
    expect(sdxlSize(1080, 1920)).toEqual({ width: 768, height: 1344 });
    expect(sdxlSize(1280, 720)).toEqual({ width: 1344, height: 768 });
  });
});
