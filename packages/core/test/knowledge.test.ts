import { describe, expect, it } from "vitest";
import {
  chunkCsv, chunkMarkdown, chunkTranscript, cleanMarkdown, csvToMarkdown, embeddingText, imageDimensions, isStale,
  parseCsv, removeCrossPageBoilerplate, sniffFile, CreateSourceSchema,
} from "../src/index.js";

const bytes = (...parts: Array<string | number[]>) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));

describe("cleanMarkdown", () => {
  it("drops images, nav link rows and cookie banners but keeps link text", () => {
    const md = [
      "[Home](/) | [About](/about) | [Menu](/menu)",
      "We use cookies to improve your experience. Accept all cookies",
      "![hero](https://x.in/hero.jpg)",
      "# Breakfast",
      "Fresh idli every morning. See our [full menu](https://x.in/menu) for more.",
      "",
      "",
      "",
      "Skip to content",
    ].join("\n");
    expect(cleanMarkdown(md)).toBe("# Breakfast\nFresh idli every morning. See our full menu for more.");
  });
  it("removes lines repeated across most crawled pages", () => {
    const footer = "Annapurna Tiffins · Gachibowli · +91 90000 00000";
    const pages = ["Idli and dosa", "Lunch boxes", "Catering", "Contact us"].map((b) => `${b}\n${footer}`);
    expect(removeCrossPageBoilerplate(pages)).toEqual(["Idli and dosa", "Lunch boxes", "Catering", "Contact us"]);
    expect(removeCrossPageBoilerplate(pages.slice(0, 2))).toEqual(pages.slice(0, 2));   // too few pages to judge
  });
});

describe("chunkMarkdown", () => {
  it("never crosses headings and records heading paths", () => {
    const md = "# Menu\n\n## Breakfast\n\nIdli and vada.\n\n## Lunch\n\nMeals with sambar.\n\n# Contact\n\nCall us.";
    const c = chunkMarkdown(md, { pageUrl: "https://x.in/menu" });
    expect(c.map((x) => [x.headingPath, x.content])).toEqual([
      [["Menu", "Breakfast"], "Idli and vada."],
      [["Menu", "Lunch"], "Meals with sambar."],
      [["Contact"], "Call us."],
    ]);
    expect(c.every((x) => x.pageUrl === "https://x.in/menu")).toBe(true);
    expect(c.map((x) => x.ordinal)).toEqual([0, 1, 2]);
  });
  it("packs paragraphs up to the target and splits oversized paragraphs by sentence", () => {
    const para = "ఇది ఒక వాక్యం. ".repeat(400);   // Telugu sentences
    const c = chunkMarkdown(`# Long\n\n${para}\n\nShort tail.`, { targetTokens: 200, maxTokens: 300 });
    expect(c.length).toBeGreaterThan(3);
    expect(Math.max(...c.map((x) => x.tokenCount))).toBeLessThanOrEqual(300 + 50);
    expect(c.at(-1)!.content).toContain("Short tail.");
  });
  it("adds one overlap sentence between consecutive chunks", () => {
    const paras = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} first. Paragraph ${i} last sentence ${"x".repeat(300)}.`);
    const c = chunkMarkdown(paras.join("\n\n"), { targetTokens: 150 });
    expect(c[1]!.content.startsWith("Paragraph 0 last sentence") || c[1]!.content.includes("last sentence")).toBe(true);
  });
  it("embeddingText prefixes title and heading path", () => {
    expect(embeddingText({ content: "Idli", headingPath: ["Menu", "Breakfast"] }, "Menu page")).toBe("Menu page — Menu › Breakfast\nIdli");
    expect(embeddingText({ content: "Idli" })).toBe("Idli");
  });
});

describe("chunkTranscript", () => {
  it("keeps time ranges", () => {
    const segs = Array.from({ length: 40 }, (_, i) => ({ startMs: i * 5000, endMs: i * 5000 + 4800, text: `segment ${i} ${"word ".repeat(30)}` }));
    const c = chunkTranscript(segs, { targetTokens: 200 });
    expect(c.length).toBeGreaterThan(1);
    expect(c[0]!.startMs).toBe(0);
    expect(c[1]!.startMs).toBe(c[0]!.endMs! + 200);
    expect(c.at(-1)!.endMs).toBe(39 * 5000 + 4800);
  });
});

describe("csv", () => {
  it("parses quotes, escaped quotes, embedded newlines and semicolons", () => {
    const r = parseCsv('﻿Item;Price;Notes\r\nIdli;"₹40";"soft, fluffy"\r\nDosa;"₹60";"say ""crispy""\nline2"\r\n\r\n');
    expect(r.header).toEqual(["Item", "Price", "Notes"]);
    expect(r.rows).toEqual([["Idli", "₹40", "soft, fluffy"], ["Dosa", "₹60", 'say "crispy"\nline2']]);
  });
  it("chunks rows as self-describing lines with row ranges", () => {
    const rows = Array.from({ length: 100 }, (_, i) => [`Item ${i}`, `₹${i}`]);
    const c = chunkCsv(["Item", "Price"], rows, 100);
    expect(c[0]!.content.split("\n")[0]).toBe("Item: Item 0; Price: ₹0");
    expect(c[0]!.metadata).toMatchObject({ rowStart: 1 });
    expect(c.at(-1)!.metadata).toMatchObject({ rowEnd: 100 });
    expect(csvToMarkdown(["a|b"], [["x"]])).toBe("| a\\|b |\n| --- |\n| x |");
  });
  it("caps rows", () => {
    const text = "a\n" + Array.from({ length: 20 }, (_, i) => String(i)).join("\n");
    const r = parseCsv(text, 10);
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });
});

describe("sniffFile", () => {
  it.each([
    [bytes("%PDF-1.7\n"), "x.bin", "pdf"],
    [bytes([0x50, 0x4b, 0x03, 0x04], "....word/document.xml"), "a.zip", "docx"],
    [bytes([0x89], "PNG\r\n\x1a\n"), "a.jpg", "png"],
    [bytes([0xff, 0xd8, 0xff, 0xe0]), "a.png", "jpeg"],
    [bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "), "a", "webp"],
    [bytes("ID3", [3, 0]), "a", "audio"],
    [bytes([0, 0, 0, 0x18], "ftypisom"), "clip.mp4", "video"],
    [bytes("<!DOCTYPE html><html>"), "page.txt", "html"],
    [bytes("name,price\nidli,40"), "menu.csv", "csv"],
    [bytes("తెలుగు గమనికలు"), "notes.txt", "text"],
    [bytes([0, 1, 2, 3, 0]), "x.txt", "unknown"],
  ])("%#: detects %s from content, not the name", (b, name, kind) => {
    expect(sniffFile(b, name).kind).toBe(kind);
  });
  it("does not let an .svg disguise as an image to run scripts", () => {
    expect(sniffFile(bytes("<svg onload=alert(1)>"), "logo.png").kind).toBe("svg");
  });
});

describe("imageDimensions", () => {
  it("reads PNG and GIF headers", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(png.buffer).setUint32(16, 1080);
    new DataView(png.buffer).setUint32(20, 1350);
    expect(imageDimensions(png)).toEqual({ width: 1080, height: 1350 });
    const gif = bytes("GIF89a", [0x40, 0x01, 0xf0, 0x00]);
    expect(imageDimensions(gif)).toEqual({ width: 320, height: 240 });
  });
  it("reads a JPEG SOF0 marker", () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0xe0, 0x02, 0x80, 3, 0, 0, 0]);
    expect(imageDimensions(jpg)).toEqual({ width: 640, height: 480 });
  });
});

describe("source schema & freshness", () => {
  it("validates per type and applies defaults", () => {
    const s = CreateSourceSchema.parse({ type: "crawl", url: "https://x.in" });
    expect(s).toMatchObject({ limit: 25, visibility: "brand", tags: [] });
    expect(() => CreateSourceSchema.parse({ type: "text", body: "x" })).toThrow();   // title required
    expect(() => CreateSourceSchema.parse({ type: "crawl", url: "https://x.in", limit: 1000 })).toThrow();
  });
  it("computes staleness", () => {
    const now = new Date("2026-11-20T00:00:00Z");
    expect(isStale("2026-11-01T00:00:00Z", 7, now)).toBe(true);
    expect(isStale("2026-11-18T00:00:00Z", 7, now)).toBe(false);
    expect(isStale("2026-01-01T00:00:00Z", null, now)).toBe(false);
  });
});
