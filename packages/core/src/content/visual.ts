import { z } from "zod";

/**
 * Visual composition model (rendered with Fabric.js in the browser, validated here).
 * Coordinates are fractions of the canvas so one layout works across sizes.
 */
export const SIZE_PRESETS = {
  "instagram-square": { w: 1080, h: 1080, label: "Instagram / Facebook square" },
  "instagram-portrait": { w: 1080, h: 1350, label: "Instagram portrait 4:5" },
  story: { w: 1080, h: 1920, label: "Story / Reel cover 9:16" },
  "facebook-post": { w: 1200, h: 630, label: "Facebook link post" },
  "linkedin-post": { w: 1200, h: 627, label: "LinkedIn post" },
  "x-post": { w: 1600, h: 900, label: "X post 16:9" },
  "youtube-thumbnail": { w: 1280, h: 720, label: "YouTube thumbnail" },
  "youtube-banner": { w: 2560, h: 1440, label: "YouTube channel art" },
  "facebook-cover": { w: 851, h: 315, label: "Facebook page cover" },
  "linkedin-banner": { w: 1584, h: 396, label: "LinkedIn page banner" },
  "profile-picture": { w: 400, h: 400, label: "Profile picture (shown round)" },
  sticker: { w: 512, h: 512, label: "Sticker (transparent)" },
} as const;
export type SizePreset = keyof typeof SIZE_PRESETS;
export const isSizePreset = (s: string): s is SizePreset => s in SIZE_PRESETS;

const Box = { x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) };
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const LayerSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string(), type: z.literal("text"), role: z.enum(["headline", "subhead", "cta", "body"]), text: z.string().max(500), ...Box, fontFamily: z.string().max(80), fontSize: z.number().min(6).max(400), fontWeight: z.enum(["400", "600", "700", "800"]), color: hex, align: z.enum(["left", "center", "right"]), fill: hex.optional(), radius: z.number().min(0).max(1).optional() }),
  z.object({ id: z.string(), type: z.literal("image"), assetId: z.string().nullable(), ...Box, fit: z.enum(["cover", "contain"]), radius: z.number().min(0).max(1).optional() }),
  z.object({ id: z.string(), type: z.literal("logo"), assetId: z.string().nullable(), url: z.string().nullable(), ...Box }),
  z.object({ id: z.string(), type: z.literal("rect"), ...Box, fill: hex, opacity: z.number().min(0).max(1), radius: z.number().min(0).max(1).optional() }),
]);
export type Layer = z.infer<typeof LayerSchema>;
export const SceneSchema = z.object({
  format: z.literal(1),
  preset: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  template: z.string(),
  background: z.object({ color: hex, imageAssetId: z.string().nullable(), overlay: z.object({ color: hex, opacity: z.number().min(0).max(1) }).nullable(), transparent: z.boolean().optional() }),
  layers: z.array(LayerSchema).max(30),
  exportAssetId: z.string().nullable().optional(),
});
export type Scene = z.infer<typeof SceneSchema>;

// ---------------------------------------------------------------- colour maths (WCAG 2.x)
const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export function luminance(h: string): number {
  const n = parseInt(h.slice(1), 16);
  return 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255);
}
export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
}
/** Composite an overlay colour at `opacity` over a base colour. */
export function blend(base: string, over: string, opacity: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [b, o] = [p(base), p(over)];
  return `#${b.map((c, i) => Math.round(c * (1 - opacity) + o[i]! * opacity).toString(16).padStart(2, "0")).join("")}`;
}
export const readableOn = (bg: string, candidates: readonly string[] = ["#ffffff", "#111111"]) =>
  [...candidates].sort((a, b) => contrastRatio(b, bg) - contrastRatio(a, bg))[0]!;

// ---------------------------------------------------------------- templates & layout
export interface BrandVisuals {
  colors: Array<{ hex: string; role: string }>;
  fonts: Array<{ family: string; role: string }>;
  logoAssetId?: string | null;
  logoUrl?: string | null;
}
export interface VisualCopy {
  headline: string;
  subhead?: string;
  cta?: string;
}

export const VISUAL_TEMPLATES = {
  "bold-headline": "Big headline on a brand colour",
  "photo-overlay": "Photo with a darkened overlay and headline",
  "split-offer": "Photo on one side, offer on the other",
  "quote-card": "Customer quote or tip card",
  "banner-wide": "Wide banner with logo and tagline",
  "profile-badge": "Logo on a brand colour (profile picture)",
} as const;
export type VisualTemplate = keyof typeof VISUAL_TEMPLATES;

/** Rough text width at a font size (avg glyph ≈ 0.55em Latin, 0.75em Indic). */
function textWidth(text: string, size: number) {
  let w = 0;
  for (const ch of text) w += /[ఀ-౿ऀ-ॿ஀-௿ಀ-೿]/.test(ch) ? 0.75 : /[A-Z]/.test(ch) ? 0.62 : 0.55;
  return w * size;
}
/** Largest font size (≤ max) at which `text` wraps into the box; deterministic word wrap. */
export function fitFontSize(text: string, boxW: number, boxH: number, max: number, min = 16, lineHeight = 1.15): number {
  for (let size = max; size >= min; size -= 2) {
    const words = text.split(/\s+/).filter(Boolean);
    let lines = 1;
    let cur = 0;
    let fits = true;
    for (const w of words) {
      const ww = textWidth(w, size);
      if (ww > boxW) { fits = false; break; }
      const space = cur ? textWidth(" ", size) : 0;
      if (cur + space + ww > boxW) { lines++; cur = ww; } else cur += space + ww;
    }
    if (fits && lines * size * lineHeight <= boxH) return size;
  }
  return min;
}

export function layoutScene(args: { template: VisualTemplate; preset: SizePreset; copy: VisualCopy; brand: BrandVisuals; imageAssetId?: string | null }): Scene {
  const { w, h } = SIZE_PRESETS[args.preset];
  const color = (role: string, fallback: string) => args.brand.colors.find((c) => c.role === role)?.hex ?? args.brand.colors[0]?.hex ?? fallback;
  const primary = color("primary", "#0f766e");
  const accent = args.brand.colors.find((c) => c.role === "accent" || c.role === "secondary")?.hex ?? primary;
  const heading = args.brand.fonts.find((f) => f.role === "heading")?.family ?? args.brand.fonts[0]?.family ?? "Inter";
  const bodyFont = args.brand.fonts.find((f) => f.role === "body")?.family ?? heading;
  const wide = w / h > 1.6;
  const tall = h / w > 1.4;
  const m = tall ? 0.08 : 0.07;   // safe margin
  const layers: Layer[] = [];
  const text = (id: string, role: "headline" | "subhead" | "cta", t: string | undefined, x: number, y: number, bw: number, bh: number, max: number, color: string, extra: Partial<Extract<Layer, { type: "text" }>> = {}) => {
    if (!t?.trim()) return;
    layers.push({
      id, type: "text", role, text: t.trim(), x, y, w: bw, h: bh, color, align: "left",
      fontFamily: role === "headline" ? heading : bodyFont, fontWeight: role === "headline" ? "800" : role === "cta" ? "700" : "400",
      fontSize: fitFontSize(t.trim(), bw * w, bh * h, max), ...extra,
    });
  };
  let background: Scene["background"] = { color: primary, imageAssetId: null, overlay: null };
  const logo = (x: number, y: number, s: number) => {
    if (!args.brand.logoAssetId && !args.brand.logoUrl) return;
    // square logo box: s is a fraction of the height; shrink to fit the width if needed
    let lh = Math.min(s, 1 - y);
    let lw = lh * (h / w);
    if (x + lw > 1 - 0.03) {
      lw = Math.max(0.02, 1 - 0.03 - x);
      lh = lw * (w / h);
    }
    layers.push({ id: "logo", type: "logo", assetId: args.brand.logoAssetId ?? null, url: args.brand.logoUrl ?? null, x, y, w: lw, h: lh });
  };
  const ink = readableOn(primary);
  const cta = (y: number) => {
    if (!args.copy.cta) return;
    const fill = contrastRatio(accent, primary) >= 1.5 ? accent : readableOn(primary);
    text("cta", "cta", args.copy.cta, m, y, wide ? 0.3 : 0.5, tall ? 0.05 : 0.08, Math.round(h * 0.045), readableOn(fill), { fill, radius: 0.3 });
  };

  switch (args.template) {
    case "photo-overlay":
      background = { color: "#111111", imageAssetId: args.imageAssetId ?? null, overlay: { color: "#000000", opacity: 0.45 } };
      text("headline", "headline", args.copy.headline, m, tall ? 0.55 : 0.45, 1 - 2 * m, tall ? 0.18 : 0.3, Math.round(h * 0.09), "#ffffff");
      text("subhead", "subhead", args.copy.subhead, m, tall ? 0.74 : 0.77, 1 - 2 * m, 0.08, Math.round(h * 0.04), "#ffffff");
      cta(tall ? 0.84 : 0.87);
      logo(m, m, tall ? 0.06 : 0.1);
      break;
    case "split-offer":
      layers.push({ id: "photo", type: "image", assetId: args.imageAssetId ?? null, x: 0, y: 0, w: wide ? 0.5 : 1, h: wide ? 1 : 0.5, fit: "cover" });
      text("headline", "headline", args.copy.headline, wide ? 0.54 : m, wide ? 0.18 : 0.55, wide ? 0.42 : 1 - 2 * m, wide ? 0.4 : 0.2, Math.round(h * 0.08), ink);
      text("subhead", "subhead", args.copy.subhead, wide ? 0.54 : m, wide ? 0.6 : 0.77, wide ? 0.42 : 1 - 2 * m, 0.1, Math.round(h * 0.035), ink);
      cta(wide ? 0.78 : 0.88);
      break;
    case "quote-card":
      background = { color: blend(primary, "#ffffff", 0.88), imageAssetId: null, overlay: null };
      text("headline", "headline", args.copy.headline ? `“${args.copy.headline}”` : "", m, 0.2, 1 - 2 * m, 0.45, Math.round(h * 0.07), readableOn(background.color, [primary, "#111111"]));
      text("subhead", "subhead", args.copy.subhead, m, 0.7, 1 - 2 * m, 0.08, Math.round(h * 0.035), readableOn(background.color));
      logo(1 - m - 0.1 * (h / w), 1 - m - 0.1, 0.1);
      break;
    case "banner-wide":
      logo(m * 0.6, 0.25, 0.5);
      text("headline", "headline", args.copy.headline, 0.32, 0.22, 0.62, 0.36, Math.round(h * 0.22), ink);
      text("subhead", "subhead", args.copy.subhead, 0.32, 0.62, 0.62, 0.2, Math.round(h * 0.1), ink);
      break;
    case "profile-badge":
      background = { color: primary, imageAssetId: null, overlay: null, transparent: args.preset === "sticker" };
      logo(0.2, 0.2, 0.6);
      if (!args.brand.logoAssetId && !args.brand.logoUrl) text("headline", "headline", args.copy.headline.slice(0, 3).toUpperCase(), 0.15, 0.3, 0.7, 0.4, Math.round(h * 0.3), ink, { align: "center" });
      break;
    default: // bold-headline
      text("headline", "headline", args.copy.headline, m, tall ? 0.3 : 0.2, 1 - 2 * m, tall ? 0.3 : 0.4, Math.round(h * 0.11), ink);
      text("subhead", "subhead", args.copy.subhead, m, tall ? 0.62 : 0.64, 1 - 2 * m, 0.1, Math.round(h * 0.04), ink);
      cta(tall ? 0.76 : 0.8);
      logo(m, tall ? 0.88 : 1 - m - 0.1, tall ? 0.05 : 0.1);
  }
  return SceneSchema.parse({ format: 1, preset: args.preset, width: w, height: h, template: args.template, background, layers });
}

// ---------------------------------------------------------------- brand-rule validation
export interface SceneIssue {
  code: "low_contrast" | "off_palette" | "outside_safe_zone" | "text_too_small" | "missing_logo" | "missing_image" | "text_on_photo";
  severity: "error" | "warning";
  message: string;
  layerId?: string;
}

/** Effective background colour behind a box (solid colour, overlay over photo, or rect fills). */
function bgUnder(scene: Scene, l: Layer): string | null {
  const cx = l.x + l.w / 2;
  const cy = l.y + l.h / 2;
  for (const r of [...scene.layers].reverse()) {
    if (r === l || r.id === l.id) continue;
    if (scene.layers.indexOf(r) > scene.layers.indexOf(l)) continue;
    if (cx < r.x || cx > r.x + r.w || cy < r.y || cy > r.y + r.h) continue;
    if (r.type === "rect") return r.opacity >= 0.85 ? r.fill : null;
    if (r.type === "image") return null;   // unknown photo pixels
  }
  if (scene.background.imageAssetId) return scene.background.overlay && scene.background.overlay.opacity >= 0.4 ? blend("#7f7f7f", scene.background.overlay.color, scene.background.overlay.opacity) : null;
  return scene.background.color;
}

export function validateScene(scene: Scene, brand: BrandVisuals, opts: { requireLogo?: boolean } = {}): { passed: boolean; issues: SceneIssue[] } {
  const issues: SceneIssue[] = [];
  const palette = new Set([...brand.colors.map((c) => c.hex.toLowerCase()), "#ffffff", "#111111", "#000000"]);
  const margin = scene.preset === "story" ? { x: 0.05, top: 0.12, bottom: 0.18 } : scene.preset === "profile-picture" ? { x: 0.15, top: 0.15, bottom: 0.15 } : { x: 0.03, top: 0.03, bottom: 0.03 };
  const minFont = Math.round(scene.width * 0.022);

  for (const l of scene.layers) {
    if (l.type === "text") {
      const bg = l.fill ?? bgUnder(scene, l);
      const large = l.fontSize >= scene.width * 0.04 || (l.fontSize >= scene.width * 0.03 && Number(l.fontWeight) >= 700);
      if (bg) {
        const ratio = contrastRatio(l.color, bg);
        const need = large ? 3 : 4.5;
        if (ratio < need) issues.push({ code: "low_contrast", severity: "error", message: `"${l.text.slice(0, 30)}" has contrast ${ratio}:1 (needs ${need}:1).`, layerId: l.id });
      } else issues.push({ code: "text_on_photo", severity: "warning", message: `"${l.text.slice(0, 30)}" sits on a photo; check it's readable or add an overlay.`, layerId: l.id });
      if (l.fontSize < minFont) issues.push({ code: "text_too_small", severity: "warning", message: `"${l.text.slice(0, 30)}" is ${Math.round(l.fontSize)}px; under ${minFont}px is hard to read on phones.`, layerId: l.id });
      for (const c of [l.color, l.fill].filter((x): x is string => !!x)) {
        if (!palette.has(c.toLowerCase()) && brand.colors.length) issues.push({ code: "off_palette", severity: "warning", message: `${c} isn't a brand colour.`, layerId: l.id });
      }
      if (l.x < margin.x - 1e-9 || l.y < margin.top - 1e-9 || l.x + l.w > 1 - margin.x + 1e-9 || l.y + l.h > 1 - margin.bottom + 1e-9) {
        issues.push({ code: "outside_safe_zone", severity: "error", message: `"${l.text.slice(0, 30)}" is too close to the edge; it may be cropped or covered.`, layerId: l.id });
      }
    }
    if (l.type === "image" && !l.assetId) issues.push({ code: "missing_image", severity: "error", message: "Choose an image for the photo area.", layerId: l.id });
  }
  if (scene.background.imageAssetId === null && scene.template === "photo-overlay") issues.push({ code: "missing_image", severity: "error", message: "Choose a background photo." });
  if (!scene.background.transparent && brand.colors.length && !palette.has(scene.background.color.toLowerCase()) && !scene.background.imageAssetId) {
    // tints of brand colours are fine; only flag colours far from every brand colour
    const near = brand.colors.some((c) => contrastRatio(c.hex, scene.background.color) < 1.3 || blend(c.hex, "#ffffff", 0.88).toLowerCase() === scene.background.color.toLowerCase());
    if (!near) issues.push({ code: "off_palette", severity: "warning", message: `Background ${scene.background.color} isn't a brand colour.` });
  }
  if (opts.requireLogo && !scene.layers.some((l) => l.type === "logo" && (l.assetId || l.url))) issues.push({ code: "missing_logo", severity: "warning", message: "Add your logo." });
  return { passed: !issues.some((i) => i.severity === "error"), issues };
}
