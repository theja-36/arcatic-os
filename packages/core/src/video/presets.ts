/**
 * Export presets. Durations are each platform's published upload limit as of 2026-11 and are
 * re-verified with the publishing integrations in Phase 7 — they produce warnings, not errors.
 */
export const EXPORT_PRESETS = {
  "instagram-reel": { label: "Instagram Reel", width: 1080, height: 1920, fps: 30, maxSeconds: 180 },
  "instagram-feed": { label: "Instagram feed video 4:5", width: 1080, height: 1350, fps: 30, maxSeconds: 60 },
  "facebook-reel": { label: "Facebook Reel", width: 1080, height: 1920, fps: 30, maxSeconds: 90 },
  "youtube-short": { label: "YouTube Short", width: 1080, height: 1920, fps: 30, maxSeconds: 180 },
  youtube: { label: "YouTube 16:9", width: 1920, height: 1080, fps: 30, maxSeconds: 12 * 3600 },
  tiktok: { label: "TikTok", width: 1080, height: 1920, fps: 30, maxSeconds: 600 },
  linkedin: { label: "LinkedIn 16:9", width: 1920, height: 1080, fps: 30, maxSeconds: 600 },
  x: { label: "X (Twitter) 16:9", width: 1280, height: 720, fps: 30, maxSeconds: 140 },
  square: { label: "Square 1:1", width: 1080, height: 1080, fps: 30, maxSeconds: null },
} as const;
export type ExportPreset = keyof typeof EXPORT_PRESETS;
export const isExportPreset = (s: string): s is ExportPreset => s in EXPORT_PRESETS;

/** Preview renders: same aspect, ~640px on the long side, even dimensions. */
export function previewSize(width: number, height: number, longSide = 640) {
  const k = longSide / Math.max(width, height);
  const even = (n: number) => Math.max(2, Math.round((n * k) / 2) * 2);
  return { width: even(width), height: even(height) };
}
