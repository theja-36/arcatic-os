import type { BrandKit } from "./kit.js";

/** What a usable Brand Kit needs, weighted. Only approved facts count. */
const CHECKS: Array<{ key: string; label: string; weight: number; ok: (k: BrandKit) => boolean }> = [
  { key: "profile.businessType", label: "Business type", weight: 5, ok: (k) => ap(k, "profile.businessType") },
  { key: "oneLiner", label: "One-line description", weight: 10, ok: (k) => ap(k, "oneLiner") },
  { key: "positioning", label: "Positioning", weight: 8, ok: (k) => ap(k, "positioning") },
  { key: "mission", label: "Mission", weight: 4, ok: (k) => ap(k, "mission") },
  { key: "audiences", label: "At least one audience", weight: 12, ok: (k) => k.audiences.some((f) => f.status === "approved") },
  { key: "offers", label: "At least one offer", weight: 12, ok: (k) => k.offers.some((f) => f.status === "approved") },
  { key: "differentiators", label: "Differentiators", weight: 8, ok: (k) => ap(k, "differentiators") },
  { key: "voice.tone", label: "Tone of voice", weight: 10, ok: (k) => ap(k, "voice.tone") },
  { key: "voice.personality", label: "Personality", weight: 5, ok: (k) => ap(k, "voice.personality") },
  { key: "voice.dont", label: "Voice don'ts or banned words", weight: 5, ok: (k) => ap(k, "voice.dont") || ap(k, "vocabulary.banned") },
  { key: "visual.colors", label: "Brand colours", weight: 7, ok: (k) => ap(k, "visual.colors") },
  { key: "visual.fonts", label: "Fonts", weight: 4, ok: (k) => ap(k, "visual.fonts") },
  { key: "visual.logo", label: "Logo", weight: 6, ok: (k) => ap(k, "visual.logoUrl") || ap(k, "visual.logoAssetId") },
  { key: "marketing.channels", label: "Channels", weight: 4, ok: (k) => ap(k, "marketing.channels") },
];
const TOTAL = CHECKS.reduce((s, c) => s + c.weight, 0);

function ap(k: BrandKit, path: string) {
  const f = k.facts[path];
  if (!f || f.status !== "approved") return false;
  return Array.isArray(f.value) ? f.value.length > 0 : f.value !== "" && f.value != null;
}

export function kitCompleteness(kit: BrandKit): { score: number; missing: Array<{ key: string; label: string }>; pendingSuggestions: number } {
  const missing = CHECKS.filter((c) => !c.ok(kit)).map(({ key, label }) => ({ key, label }));
  const got = CHECKS.filter((c) => c.ok(kit)).reduce((s, c) => s + c.weight, 0);
  const all = [...Object.values(kit.facts), ...kit.audiences, ...kit.offers];
  const pendingSuggestions = all.filter((f) => f.status === "suggested" || f.suggestion).length;
  return { score: Math.round((got / TOTAL) * 100), missing, pendingSuggestions };
}
