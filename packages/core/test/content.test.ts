import { describe, expect, it } from "vitest";
import {
  SIZE_PRESETS, VISUAL_TEMPLATES, classifyEdit, contrastRatio, docFrom, docText, fitFontSize, layoutScene, markHumanEdits, mergeRewrites,
  regenerableIds, topicGenerationInput, validateDoc, validateScene, type ContentDoc, type SizePreset, type VisualTemplate,
} from "../src/index.js";

const post = () => docFrom([["hook", "Fresh idli every morning"], ["body", "Soft, steaming and delivered by 7am in Gachibowli."], ["cta", "Order on WhatsApp"], ["hashtags", "#idli #hyderabad"]]);

describe("content doc", () => {
  it("builds blocks with stable ids and joins text", () => {
    const d = post();
    expect(d.blocks.map((b) => b.id)).toEqual(["b1", "b2", "b3", "b4"]);
    expect(docText(d)).toBe("Fresh idli every morning\n\nSoft, steaming and delivered by 7am in Gachibowli.\n\nOrder on WhatsApp\n\n#idli #hyderabad");
  });

  it("marks edited and added blocks as human", () => {
    const prev = post();
    const next: ContentDoc = { format: 1, blocks: [...prev.blocks.map((b) => (b.id === "b3" ? { ...b, text: "Message us to order" } : b)), { id: "b5", kind: "body", text: "New", origin: "ai" }] };
    const r = markHumanEdits(prev, next);
    expect(r.changed).toEqual(["b3"]);
    expect(r.added).toEqual(["b5"]);
    expect(r.doc.blocks.find((b) => b.id === "b3")!.origin).toBe("human");
    expect(r.doc.blocks.find((b) => b.id === "b1")!.origin).toBe("ai");
  });

  it("selective regeneration never touches human or locked blocks, whatever the model returns", () => {
    let d = markHumanEdits(post(), { format: 1, blocks: post().blocks.map((b) => (b.id === "b2" ? { ...b, text: "Our grandmother's recipe." } : b)) }).doc;
    d = { ...d, blocks: d.blocks.map((b) => (b.id === "b4" ? { ...b, locked: true } : b)) };
    const allowed = regenerableIds(d);
    expect(allowed).toEqual(["b1", "b3"]);
    const { doc, rewritten } = mergeRewrites(d, [
      { id: "b1", text: "Breakfast, sorted." },
      { id: "b2", text: "MODEL OVERWROTE HUMAN TEXT" },
      { id: "b4", text: "#changed" },
      { id: "b9", text: "unknown block" },
    ], allowed);
    expect(rewritten).toEqual(["b1"]);
    expect(doc.blocks.find((b) => b.id === "b2")!.text).toBe("Our grandmother's recipe.");
    expect(doc.blocks.find((b) => b.id === "b4")!.text).toBe("#idli #hyderabad");
    expect(doc.blocks).toHaveLength(4);
  });

  it("transforms may target human blocks when the user selects them", () => {
    const d = markHumanEdits(post(), { format: 1, blocks: post().blocks.map((b) => (b.id === "b2" ? { ...b, text: "Mine" } : b)) }).doc;
    expect(mergeRewrites(d, [{ id: "b2", text: "Polished" }], ["b2"]).doc.blocks[1]!.text).toBe("Polished");
  });

  it("classifies edits for learning", () => {
    const next: ContentDoc = { format: 1, blocks: post().blocks.map((b) => (b.id === "b3" ? { ...b, text: "Call us" } : b.id === "b2" ? { ...b, text: "Soft idli." } : b)) };
    expect(classifyEdit(post(), next)).toEqual(["cta", "shortened"]);
  });
});

describe("validateDoc", () => {
  it("checks the post against the channel limit and brand rules across all blocks", () => {
    const d = docFrom([["hook", "Cheap breakfast"], ["body", "x".repeat(300)], ["alt_text", "A cheap plate"]]);
    const r = validateDoc("social_post", d, "x", { bannedWords: ["cheap"] });
    expect(r.passed).toBe(false);
    expect(r.issues.map((i) => i.code).sort()).toEqual(["banned_word", "banned_word", "too_long"]);
    expect(r.issues.filter((i) => i.code === "banned_word").map((i) => i.blockId)).toEqual(["b1", "b3"]);
  });
  it("applies per-block limits by type", () => {
    const email = docFrom([["subject", "S".repeat(70)], ["preheader", "p"], ["body", "Hello"]]);
    expect(validateDoc("email", email, "email").issues).toEqual([expect.objectContaining({ code: "too_long", severity: "error", blockId: "b1" })]);
    const thread = docFrom([["tweet", "a".repeat(281)], ["tweet", "ok"]]);
    expect(validateDoc("x_thread", thread, "x").issues[0]).toMatchObject({ blockId: "b1", severity: "error" });
    const ad = docFrom([["primary_text", "p".repeat(200)], ["headline", "Fresh"]]);
    const r = validateDoc("ad", ad, "facebook");
    expect(r.passed).toBe(true);   // Meta lengths are recommendations → warnings
    expect(r.issues[0]!.severity).toBe("warning");
  });
  it("requires disclaimers anywhere in the doc", () => {
    const d = docFrom([["body", "Great returns!"], ["cta", "T&C apply"]]);
    expect(validateDoc("social_post", d, "instagram", { requiredDisclaimers: ["T&C apply"] }).passed).toBe(true);
  });
});

describe("topics → generation", () => {
  it("routes formats to templates and explains unsupported combinations", () => {
    expect(topicGenerationInput({ title: "Diwali offer", channel: "email", content_type: "email" }, {}, "te")).toMatchObject({ templateKey: "email.campaign@1", input: { channel: "email", language: "te" } });
    expect(topicGenerationInput({ title: "x", channel: "whatsapp", content_type: "social_post" }, {}, "en")).toHaveProperty("unsupported");
    expect(topicGenerationInput({ title: "x", channel: "instagram", content_type: "live" }, {}, "en")).toHaveProperty("unsupported");
  });
});

describe("visual scenes", () => {
  const brand = { colors: [{ hex: "#e85d04", role: "primary" }, { hex: "#2a9d8f", role: "secondary" }], fonts: [{ family: "Poppins", role: "heading" }], logoUrl: "https://x.in/logo.png" };
  it("contrast maths matches WCAG reference values", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBe(21);
    expect(contrastRatio("#777777", "#ffffff")).toBe(4.48);
  });
  it("fits long headlines by shrinking, Telugu wider than Latin", () => {
    const short = fitFontSize("Idli", 900, 300, 120);
    const long = fitFontSize("Hyderabad's favourite home-style breakfast tiffins, delivered hot every morning", 900, 300, 120);
    expect(short).toBe(120);
    expect(long).toBeLessThan(short);
    // one line only (box height ≈ one line): Telugu glyph clusters are wider
    expect(fitFontSize("ఇంటి భోజనం", 300, 60, 50)).toBeLessThan(fitFontSize("Home food", 300, 60, 50));
  });
  it("every template × size lays out inside the canvas with readable text on solid colours", () => {
    for (const t of Object.keys(VISUAL_TEMPLATES) as VisualTemplate[]) {
      for (const p of Object.keys(SIZE_PRESETS) as SizePreset[]) {
        const s = layoutScene({ template: t, preset: p, copy: { headline: "Fresh idli every morning", subhead: "Delivered by 7am", cta: "Order now" }, brand, imageAssetId: "img-1" });
        for (const l of s.layers) {
          expect(l.x + l.w, `${t}/${p}/${l.id}`).toBeLessThanOrEqual(1.0001);
          expect(l.y + l.h, `${t}/${p}/${l.id}`).toBeLessThanOrEqual(1.0001);
        }
        const v = validateScene(s, brand);
        expect(v.issues.filter((i) => i.code === "low_contrast"), `${t}/${p}`).toEqual([]);
      }
    }
  });
  it("flags low contrast, safe-zone and missing photo problems", () => {
    const s = layoutScene({ template: "bold-headline", preset: "story", copy: { headline: "Hello" }, brand });
    const bad = { ...s, layers: s.layers.map((l) => (l.type === "text" ? { ...l, color: "#f08a4b", y: 0.02 } : l)) };
    const codes = validateScene(bad, brand).issues.map((i) => i.code);
    expect(codes).toContain("low_contrast");
    expect(codes).toContain("outside_safe_zone");
    const noPhoto = layoutScene({ template: "photo-overlay", preset: "instagram-square", copy: { headline: "x" }, brand });
    expect(validateScene(noPhoto, brand).issues.map((i) => i.code)).toContain("missing_image");
  });
});
