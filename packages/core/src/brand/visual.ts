/**
 * Deterministic visual-identity signals from raw HTML (no LLM): colours, fonts, logo candidates.
 * Results are suggestions; people confirm them in the Brand Kit.
 */
export interface VisualSignals {
  colors: Array<{ hex: string; count: number; chromatic: boolean }>;
  themeColor?: string;
  fonts: Array<{ family: string; count: number }>;
  logoCandidates: Array<{ url: string; reason: "img-logo" | "svg-logo-link" | "og:image" | "apple-touch-icon" | "icon" }>;
}

const GENERIC_FONTS = new Set([
  "sans-serif", "serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace",
  "-apple-system", "blinkmacsystemfont", "segoe ui", "helvetica neue", "helvetica", "arial", "roboto", "noto sans",
  "apple color emoji", "segoe ui emoji", "segoe ui symbol", "noto color emoji", "inherit", "initial", "var", "emoji",
]);

const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

export function normalizeColor(c: string): string | undefined {
  const s = c.trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) return `#${m[1]!.split("").map((ch) => ch + ch).join("")}`;
  m = s.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);
  if (m) return m[2] === "00" ? undefined : `#${m[1]}`;
  m = s.match(/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return undefined;
    return `#${toHex(+m[1]!)}${toHex(+m[2]!)}${toHex(+m[3]!)}`;
  }
  return undefined;
}

/** Saturation/lightness check: greys, near-white and near-black are not brand colours. */
export function isChromatic(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return sat > 0.25 && l > 0.12 && l < 0.92;
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "is"))?.[2];

export function extractVisualSignals(html: string, pageUrl: string): VisualSignals {
  const abs = (u: string | undefined) => {
    if (!u || u.startsWith("data:")) return undefined;
    try {
      const x = new URL(u, pageUrl);
      return /^https?:$/.test(x.protocol) ? x.toString() : undefined;
    } catch {
      return undefined;
    }
  };

  // colours: CSS in <style>, style="" attributes and CSS custom properties
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n") + "\n" +
    [...html.matchAll(/\sstyle\s*=\s*(["'])(.*?)\1/gis)].map((m) => m[2]).join(";");
  const counts = new Map<string, number>();
  for (const m of css.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)) {
    const hex = normalizeColor(m[0]);
    if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  const themeTag = html.match(/<meta[^>]+name\s*=\s*["']theme-color["'][^>]*>/i)?.[0];
  const themeColor = themeTag ? normalizeColor(attr(themeTag, "content") ?? "") : undefined;
  if (themeColor) counts.set(themeColor, (counts.get(themeColor) ?? 0) + 5);
  const colors = [...counts.entries()]
    .map(([hex, count]) => ({ hex, count, chromatic: isChromatic(hex) }))
    .sort((a, b) => Number(b.chromatic) - Number(a.chromatic) || b.count - a.count || a.hex.localeCompare(b.hex))
    .slice(0, 8);

  // fonts: font-family declarations + Google Fonts links
  const fontCounts = new Map<string, number>();
  const addFont = (name: string, w = 1) => {
    const fam = name.trim().replace(/^["']|["']$/g, "").trim();
    if (!fam || fam.startsWith("var(") || GENERIC_FONTS.has(fam.toLowerCase()) || fam.length > 60) return;
    fontCounts.set(fam, (fontCounts.get(fam) ?? 0) + w);
  };
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    m[1]!.split(",").forEach((f, i) => addFont(f, i === 0 ? 2 : 1));
  }
  for (const m of html.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'\s>]+)/gi)) {
    const params = new URLSearchParams(m[1]!.replace(/&amp;/g, "&"));
    for (const fam of params.getAll("family")) addFont(fam.split(":")[0]!.replace(/\+/g, " "), 3);
  }
  const fonts = [...fontCounts.entries()].map(([family, count]) => ({ family, count })).sort((a, b) => b.count - a.count || a.family.localeCompare(b.family)).slice(0, 4);

  // logo candidates, best first
  const logos: VisualSignals["logoCandidates"] = [];
  const push = (url: string | undefined, reason: VisualSignals["logoCandidates"][number]["reason"]) => {
    if (url && !logos.some((l) => l.url === url)) logos.push({ url, reason });
  };
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const hay = `${attr(tag, "src") ?? ""} ${attr(tag, "alt") ?? ""} ${attr(tag, "class") ?? ""} ${attr(tag, "id") ?? ""}`.toLowerCase();
    if (/logo/.test(hay)) push(abs(attr(tag, "src") ?? attr(tag, "data-src")), "img-logo");
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(m[0], "rel") ?? "").toLowerCase();
    if (rel.includes("apple-touch-icon")) push(abs(attr(m[0], "href")), "apple-touch-icon");
  }
  const og = html.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]*>/i)?.[0];
  if (og) push(abs(attr(og, "content")), "og:image");
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(m[0], "rel") ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("icon")) push(abs(attr(m[0], "href")), "icon");
  }

  return { colors, themeColor, fonts, logoCandidates: logos.slice(0, 6) };
}

/** Firecrawl `branding` format subset we use (firecrawl-main/apps/api/src/types/branding.ts). */
export interface FirecrawlBranding {
  logo?: string | null;
  colors?: { primary?: string; secondary?: string; accent?: string; [k: string]: string | undefined };
  fonts?: Array<{ family: string }>;
  typography?: { fontFamilies?: { primary?: string; heading?: string; [k: string]: string | undefined } };
}

/**
 * Turn visual signals into Brand Kit suggestions. Firecrawl branding (when the self-hosted
 * instance has it configured) is preferred; deterministic HTML signals are the fallback.
 */
export function visualSuggestions(
  signals: VisualSignals | undefined,
  pageUrl: string,
  branding?: FirecrawlBranding | null,
): Record<string, { value: unknown; confidence: number; sources: Array<{ kind: "html" | "firecrawl_branding"; url: string }> }> {
  const out: ReturnType<typeof visualSuggestions> = {};
  const src = (kind: "html" | "firecrawl_branding") => [{ kind, url: pageUrl }];

  const bColors = (["primary", "secondary", "accent"] as const)
    .map((role) => ({ role, hex: normalizeColor(branding?.colors?.[role] ?? "") }))
    .filter((c): c is { role: "primary" | "secondary" | "accent"; hex: string } => !!c.hex);
  if (bColors.length) out["visual.colors"] = { value: bColors, confidence: 0.7, sources: src("firecrawl_branding") };
  else if (signals) {
    const chroma = signals.colors.filter((c) => c.chromatic).slice(0, 3);
    if (chroma.length) {
      const roles = ["primary", "secondary", "accent"] as const;
      out["visual.colors"] = {
        value: chroma.map((c, i) => ({ hex: c.hex, role: roles[i]! })),
        confidence: signals.themeColor && chroma[0]?.hex === signals.themeColor ? 0.7 : 0.5,
        sources: src("html"),
      };
    }
  }

  const bFonts = [branding?.typography?.fontFamilies?.heading, branding?.typography?.fontFamilies?.primary, ...(branding?.fonts ?? []).map((f) => f.family)]
    .filter((f): f is string => !!f && !GENERIC_FONTS.has(f.toLowerCase()));
  const uniq = [...new Set(bFonts)];
  if (uniq.length) out["visual.fonts"] = { value: uniq.slice(0, 2).map((family, i) => ({ family, role: i === 0 ? "heading" : "body" })), confidence: 0.65, sources: src("firecrawl_branding") };
  else if (signals?.fonts.length) {
    out["visual.fonts"] = { value: signals.fonts.slice(0, 2).map((f, i) => ({ family: f.family, role: i === 0 ? "heading" : "body" })), confidence: 0.5, sources: src("html") };
  }

  const logo = branding?.logo || signals?.logoCandidates[0]?.url;
  if (logo) out["visual.logoUrl"] = { value: logo, confidence: branding?.logo ? 0.7 : signals?.logoCandidates[0]?.reason === "img-logo" ? 0.6 : 0.35, sources: src(branding?.logo ? "firecrawl_branding" : "html") };
  return out;
}
