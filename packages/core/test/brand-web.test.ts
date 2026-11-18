import { describe, expect, it } from "vitest";
import { classifyUrl, extractVisualSignals, isChromatic, normalizeColor, quoteAppears, selectPages, verifyCitations } from "../src/index.js";

describe("page selection", () => {
  const links = [
    { url: "https://www.annapurna.in/about-us" },
    { url: "https://annapurna.in/menu" },
    { url: "https://annapurna.in/menu/breakfast/idli" },
    { url: "https://annapurna.in/pricing?utm_source=x" },
    { url: "https://annapurna.in/blog" },
    { url: "https://annapurna.in/blog/2024/new-menu" },
    { url: "https://annapurna.in/contact" },
    { url: "https://annapurna.in/faq" },
    { url: "https://annapurna.in/reviews" },
    { url: "https://annapurna.in/wp-admin/x" },
    { url: "https://annapurna.in/logo.png" },
    { url: "https://evil.example/about" },
    { url: "https://annapurna.in/privacy-policy" },
  ];
  it("classifies by path and rejects other hosts, assets and admin pages", () => {
    expect(classifyUrl("https://annapurna.in/our-story", "annapurna.in")).toBe("about");
    expect(classifyUrl("https://evil.example/about", "annapurna.in")).toBeNull();
    expect(classifyUrl("https://annapurna.in/logo.png", "annapurna.in")).toBeNull();
    expect(classifyUrl("https://annapurna.in/wp-admin/x", "annapurna.in")).toBeNull();
  });
  it("selects home first, shallowest pages per type, one blog index, deterministically", () => {
    const sel = selectPages("https://annapurna.in", links, { max: 12 });
    expect(sel[0]).toMatchObject({ type: "home" });
    expect(sel.map((p) => p.type)).toEqual(["home", "about", "products", "products", "pricing", "testimonials", "faq", "contact", "blog"]);
    expect(sel.find((p) => p.type === "blog")?.url).toBe("https://annapurna.in/blog");
    expect(selectPages("https://annapurna.in", [...links].reverse(), { max: 12 })).toEqual(sel);
  });
  it("respects the page cap", () => expect(selectPages("https://annapurna.in", links, { max: 3 })).toHaveLength(3));
});

describe("visual signals", () => {
  const html = `
    <html><head>
      <meta name="theme-color" content="#E85D04">
      <link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple.png">
      <meta property="og:image" content="https://cdn.annapurna.in/og.jpg">
      <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;700&amp;family=Noto+Sans+Telugu&display=swap" rel="stylesheet">
      <style>:root{--brand:#e85d04;--ink:#1a1a1a} body{font-family:"Poppins", sans-serif;color:#222;background:#fff}
        .btn{background:rgb(232, 93, 4)} .muted{color:#888888} .accent{color:#2a9d8f}</style>
    </head><body>
      <img class="site-logo" src="/img/annapurna-logo.svg" alt="Annapurna"><img src="/hero.jpg" alt="Food">
      <p style="color:#2A9D8F">Fresh</p>
    </body></html>`;
  const v = extractVisualSignals(html, "https://annapurna.in/");

  it("ranks chromatic brand colours above greys", () => {
    expect(v.themeColor).toBe("#e85d04");
    expect(v.colors[0]).toMatchObject({ hex: "#e85d04", chromatic: true });
    expect(v.colors[1]).toMatchObject({ hex: "#2a9d8f", chromatic: true });
    expect(v.colors.find((c) => c.hex === "#888888")?.chromatic).toBe(false);
  });
  it("finds real fonts and skips generic families", () => {
    expect(v.fonts.map((f) => f.family)).toEqual(["Poppins", "Noto Sans Telugu"]);
  });
  it("orders logo candidates and resolves relative URLs", () => {
    expect(v.logoCandidates[0]).toEqual({ url: "https://annapurna.in/img/annapurna-logo.svg", reason: "img-logo" });
    expect(v.logoCandidates.map((l) => l.reason)).toEqual(["img-logo", "apple-touch-icon", "og:image", "icon"]);
  });
  it("normalises colour syntaxes", () => {
    expect(normalizeColor("#abc")).toBe("#aabbcc");
    expect(normalizeColor("rgba(0,0,0,0)")).toBeUndefined();
    expect(isChromatic("#ffffff")).toBe(false);
  });
});

describe("citations", () => {
  const pages = new Map([["p1", { sourceId: "s1", url: "https://annapurna.in/about-us", text: "Serving **home-style** tiffins in Hyderabad since 1998 — made fresh daily." }]]);
  it("keeps quotes that appear in the page (formatting-insensitive) and drops invented ones", () => {
    expect(quoteAppears(pages.get("p1")!.text, "home-style tiffins in Hyderabad since 1998")).toBe(true);
    const r = verifyCitations([
      { pageId: "p1", quote: "Serving home-style tiffins" },
      { pageId: "p1", quote: "Award-winning since 1990" },
      { pageId: "p9", quote: "Serving home-style tiffins" },
    ], pages);
    expect(r.verified).toHaveLength(1);
    expect(r.verified[0]).toMatchObject({ kind: "page", sourceId: "s1", url: "https://annapurna.in/about-us" });
    expect(r.dropped).toBe(2);
  });
  it("rejects trivially short quotes", () => expect(quoteAppears("since 1998", "1998")).toBe(false));
});

import { visualSuggestions } from "../src/index.js";
describe("visualSuggestions", () => {
  const signals = {
    colors: [{ hex: "#e85d04", count: 9, chromatic: true }, { hex: "#222222", count: 20, chromatic: false }, { hex: "#2a9d8f", count: 3, chromatic: true }],
    themeColor: "#e85d04",
    fonts: [{ family: "Poppins", count: 5 }, { family: "Noto Sans Telugu", count: 3 }],
    logoCandidates: [{ url: "https://x.in/logo.svg", reason: "img-logo" as const }],
  };
  it("builds colour roles from chromatic colours and trusts theme-color more", () => {
    const s = visualSuggestions(signals, "https://x.in/");
    expect(s["visual.colors"]).toMatchObject({ value: [{ hex: "#e85d04", role: "primary" }, { hex: "#2a9d8f", role: "secondary" }], confidence: 0.7 });
    expect(s["visual.fonts"]?.value).toEqual([{ family: "Poppins", role: "heading" }, { family: "Noto Sans Telugu", role: "body" }]);
    expect(s["visual.logoUrl"]).toMatchObject({ value: "https://x.in/logo.svg", confidence: 0.6 });
  });
  it("prefers Firecrawl branding when present", () => {
    const s = visualSuggestions(signals, "https://x.in/", { colors: { primary: "#112233" }, logo: "https://x.in/brand.png", typography: { fontFamilies: { heading: "Lora" } } });
    expect(s["visual.colors"]?.value).toEqual([{ hex: "#112233", role: "primary" }]);
    expect(s["visual.colors"]?.sources[0]?.kind).toBe("firecrawl_branding");
    expect(s["visual.fonts"]?.value).toEqual([{ family: "Lora", role: "heading" }]);
    expect(s["visual.logoUrl"]?.value).toBe("https://x.in/brand.png");
  });
});
