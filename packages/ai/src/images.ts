import type { BrandContext } from "@arcatic/core";

/**
 * Image prompt construction with a deterministic safety gate (before any GPU time is spent).
 * Platform-level moderation of the output image is still required before publishing (docs/06).
 */
const BLOCKED = [
  /\b(nude|naked|nsfw|porn\w*|sexual|sex|erotic|lingerie|topless|fetish)\b/i,
  /\b(gore|gory|beheading|dismember\w*|corpse|self[- ]harm|suicide)\b/i,
  /\b(child|kid|minor|teen|schoolgirl|boy|girl)s?\b.*\b(nude|naked|sexy|sexual|lingerie)\b/i,
  /\b(swastika|nazi|isis)\b/i,
  /\b(in the style of|by)\s+[A-Z][a-z]+\s+[A-Z][a-z]+/,                // living-artist style imitation
  /\b(logo|trademark) of\b|\b(nike|adidas|coca[- ]cola|pepsi|apple|google|amazon|disney|marvel)\b/i,
];

export function checkImagePrompt(prompt: string): { ok: true } | { ok: false; reason: string } {
  for (const re of BLOCKED) if (re.test(prompt)) return { ok: false, reason: "This image request isn't allowed (unsafe content, a real artist's style, or another company's brand)." };
  return { ok: true };
}

export const DEFAULT_NEGATIVE = "text, words, letters, watermark, signature, logo, blurry, lowres, jpeg artifacts, deformed hands, extra fingers, distorted face, nsfw, nude";

export function buildImagePrompt(brand: BrandContext, subject: string, opts: { style?: string; productShot?: boolean } = {}) {
  const style = opts.style ?? brand.data.visual.imageryStyle ?? "natural light, authentic, high quality photograph";
  const palette = brand.data.visual.colors.slice(0, 3).map((c) => c.hex).join(", ");
  const positive = [
    subject.trim().replace(/\s+/g, " "),
    opts.productShot ? "professional product photography, clean composition, soft shadows, sharp focus on the product" : "",
    style,
    palette ? `colour accents that harmonise with ${palette}` : "",
    "no text",
  ].filter(Boolean).join(", ");
  return { positive: positive.slice(0, 1500), negative: DEFAULT_NEGATIVE };
}

/** SDXL-friendly sizes (≈1 MP, multiples of 64) closest to an aspect ratio. */
const SDXL_BUCKETS: Array<[number, number]> = [[1024, 1024], [1152, 896], [896, 1152], [1216, 832], [832, 1216], [1344, 768], [768, 1344], [1536, 640], [640, 1536]];
export function sdxlSize(width: number, height: number): { width: number; height: number } {
  const r = width / height;
  const [w, h] = SDXL_BUCKETS.reduce((best, cur) => (Math.abs(Math.log(cur[0] / cur[1] / r)) < Math.abs(Math.log(best[0] / best[1] / r)) ? cur : best));
  return { width: w, height: h };
}
