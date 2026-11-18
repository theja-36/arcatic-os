import { z } from "zod";
import { AppError } from "../errors.js";
import { EXPORT_PRESETS, type ExportPreset } from "./presets.js";

/**
 * Timeline: a sequence of clips (video or still image) plus overlays and audio tracks laid on
 * top. All times are milliseconds on the output timeline unless named `in/out` (source time).
 */
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const frac = z.number().min(0).max(1);
const MIN_CLIP_MS = 200;

export const ClipSchema = z.object({
  id: z.string().min(1).max(40),
  assetId: z.string().min(1),
  kind: z.enum(["video", "image"]),
  inMs: z.number().int().min(0),
  outMs: z.number().int().positive(),
  sourceDurationMs: z.number().int().positive().nullable(),   // null for images
  hasAudio: z.boolean().default(false),
  volume: z.number().min(0).max(2).default(1),
  muted: z.boolean().default(false),
  fit: z.enum(["cover", "contain"]).default("cover"),
  fadeIn: z.boolean().default(false),
});
export type Clip = z.infer<typeof ClipSchema>;

export const OverlaySchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(["text", "image", "logo", "rect"]),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  x: frac, y: frac, w: frac, h: frac,
  opacity: z.number().min(0).max(1).default(1),
  // text
  text: z.string().max(500).optional(),
  fontSize: z.number().min(8).max(400).optional(),     // px at export size
  fontFamily: z.string().max(80).optional(),
  fontWeight: z.enum(["400", "600", "700", "800"]).optional(),
  color: hex.optional(),
  fill: hex.optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  /** browser-rendered PNG of the text at export size (correct shaping for Telugu etc.) */
  renderedAssetId: z.string().nullable().optional(),
  renderedKey: z.string().nullable().optional(),
  // image / logo
  assetId: z.string().nullable().optional(),
});
export type Overlay = z.infer<typeof OverlaySchema>;

export const AudioTrackSchema = z.object({
  id: z.string().min(1).max(40),
  assetId: z.string().min(1),
  startMs: z.number().int().min(0),
  inMs: z.number().int().min(0),
  outMs: z.number().int().positive(),
  sourceDurationMs: z.number().int().positive(),
  volume: z.number().min(0).max(2).default(1),
  fadeInMs: z.number().int().min(0).max(10_000).default(0),
  fadeOutMs: z.number().int().min(0).max(10_000).default(0),
});
export type AudioTrack = z.infer<typeof AudioTrackSchema>;

export const TimelineSchema = z.object({
  format: z.literal(1),
  preset: z.enum(Object.keys(EXPORT_PRESETS) as [ExportPreset, ...ExportPreset[]]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().min(12).max(60),
  background: hex.default("#000000"),
  clips: z.array(ClipSchema).max(200),
  overlays: z.array(OverlaySchema).max(100),
  audio: z.array(AudioTrackSchema).max(10),
});
export type Timeline = z.infer<typeof TimelineSchema>;

export function emptyTimeline(preset: ExportPreset): Timeline {
  const p = EXPORT_PRESETS[preset];
  return { format: 1, preset, width: p.width, height: p.height, fps: p.fps, background: "#000000", clips: [], overlays: [], audio: [] };
}

export const clipDuration = (c: Pick<Clip, "inMs" | "outMs">) => c.outMs - c.inMs;
export const timelineDuration = (t: Pick<Timeline, "clips">) => t.clips.reduce((s, c) => s + clipDuration(c), 0);
/** Start time of each clip on the output timeline. */
export const clipStarts = (t: Pick<Timeline, "clips">) => t.clips.reduce<number[]>((acc, c, i) => [...acc, i === 0 ? 0 : acc[i - 1]! + clipDuration(t.clips[i - 1]!)], []);

const nextId = (prefix: string, ids: string[]) => `${prefix}${ids.reduce((m, id) => Math.max(m, Number(id.replace(/^\D+/, "")) || 0), 0) + 1}`;
const notFound = (what: string) => new AppError("not_found", `${what} not found.`);

// ---------------------------------------------------------------- clip edits (pure)
export function addClip(t: Timeline, c: Omit<Clip, "id"> & { id?: string }, at = t.clips.length): Timeline {
  const clip = ClipSchema.parse({ ...c, id: c.id ?? nextId("c", t.clips.map((x) => x.id)) });
  if (clip.kind === "video" && clip.sourceDurationMs && clip.outMs > clip.sourceDurationMs) clip.outMs = clip.sourceDurationMs;
  const clips = [...t.clips];
  clips.splice(Math.max(0, Math.min(at, clips.length)), 0, clip);
  return { ...t, clips };
}

/** Trim a clip to [inMs, outMs) of its source; still images use outMs-inMs as display length. */
export function trimClip(t: Timeline, id: string, inMs: number, outMs: number): Timeline {
  const c = t.clips.find((x) => x.id === id);
  if (!c) throw notFound("Clip");
  const max = c.kind === "video" ? c.sourceDurationMs ?? outMs : 60_000;
  const lo = Math.max(0, Math.round(inMs));
  const hi = Math.min(max, Math.round(outMs));
  if (hi - lo < MIN_CLIP_MS) throw new AppError("validation_failed", "A clip must be at least 0.2 seconds long.");
  return { ...t, clips: t.clips.map((x) => (x.id === id ? { ...x, inMs: c.kind === "image" ? 0 : lo, outMs: c.kind === "image" ? hi - lo : hi } : x)) };
}

/** Split the clip under `atMs` (timeline time) into two clips. */
export function splitClip(t: Timeline, atMs: number): Timeline {
  const starts = clipStarts(t);
  const i = t.clips.findIndex((c, k) => atMs > starts[k]! && atMs < starts[k]! + clipDuration(c));
  if (i < 0) throw new AppError("validation_failed", "Move the playhead inside a clip to split it.");
  const c = t.clips[i]!;
  const local = atMs - starts[i]!;
  if (local < MIN_CLIP_MS || clipDuration(c) - local < MIN_CLIP_MS) throw new AppError("validation_failed", "Too close to the edge of the clip to split.");
  const cut = c.kind === "video" ? c.inMs + local : local;
  const first: Clip = c.kind === "video" ? { ...c, outMs: cut } : { ...c, inMs: 0, outMs: local };
  const second: Clip = c.kind === "video"
    ? { ...c, id: nextId("c", t.clips.map((x) => x.id)), inMs: cut, fadeIn: false }
    : { ...c, id: nextId("c", t.clips.map((x) => x.id)), inMs: 0, outMs: clipDuration(c) - local, fadeIn: false };
  const clips = [...t.clips];
  clips.splice(i, 1, first, second);
  return { ...t, clips };
}

export function moveClip(t: Timeline, id: string, toIndex: number): Timeline {
  const i = t.clips.findIndex((c) => c.id === id);
  if (i < 0) throw notFound("Clip");
  const clips = [...t.clips];
  const [c] = clips.splice(i, 1);
  clips.splice(Math.max(0, Math.min(toIndex, clips.length)), 0, c!);
  return { ...t, clips };
}

export const removeClip = (t: Timeline, id: string): Timeline => ({ ...t, clips: t.clips.filter((c) => c.id !== id) });

export function setClipAudio(t: Timeline, id: string, patch: { muted?: boolean; volume?: number }): Timeline {
  if (!t.clips.some((c) => c.id === id)) throw notFound("Clip");
  return { ...t, clips: t.clips.map((c) => (c.id === id ? ClipSchema.parse({ ...c, ...patch }) : c)) };
}

// ---------------------------------------------------------------- overlays
export function addOverlay(t: Timeline, o: Omit<Overlay, "id"> & { id?: string }): Timeline {
  const ov = OverlaySchema.parse({ ...o, id: o.id ?? nextId("o", t.overlays.map((x) => x.id)) });
  if (ov.endMs <= ov.startMs) throw new AppError("validation_failed", "An overlay must end after it starts.");
  return { ...t, overlays: [...t.overlays, ov] };
}
export function updateOverlay(t: Timeline, id: string, patch: Partial<Overlay>): Timeline {
  const o = t.overlays.find((x) => x.id === id);
  if (!o) throw notFound("Overlay");
  const textChanged = ["text", "fontSize", "fontFamily", "fontWeight", "color", "fill", "align", "w", "h"].some((k) => k in patch && (patch as Record<string, unknown>)[k] !== (o as Record<string, unknown>)[k]);
  const next = OverlaySchema.parse({ ...o, ...patch, ...(textChanged && !("renderedAssetId" in patch) && { renderedAssetId: null, renderedKey: null }) });
  if (next.endMs <= next.startMs) throw new AppError("validation_failed", "An overlay must end after it starts.");
  return { ...t, overlays: t.overlays.map((x) => (x.id === id ? next : x)) };
}
export const removeOverlay = (t: Timeline, id: string): Timeline => ({ ...t, overlays: t.overlays.filter((o) => o.id !== id) });

// ---------------------------------------------------------------- audio
export function addAudio(t: Timeline, a: Omit<AudioTrack, "id" | "inMs" | "outMs"> & { id?: string; inMs?: number; outMs?: number }): Timeline {
  const track = AudioTrackSchema.parse({ inMs: 0, outMs: a.sourceDurationMs, ...a, id: a.id ?? nextId("a", t.audio.map((x) => x.id)) });
  return { ...t, audio: [...t.audio, track] };
}
/** Trim (source in/out), align (timeline start), volume and fades. */
export function updateAudio(t: Timeline, id: string, patch: Partial<Omit<AudioTrack, "id" | "assetId" | "sourceDurationMs">>): Timeline {
  const a = t.audio.find((x) => x.id === id);
  if (!a) throw notFound("Audio track");
  const next = AudioTrackSchema.parse({ ...a, ...patch });
  next.outMs = Math.min(next.outMs, next.sourceDurationMs);
  if (next.outMs - next.inMs < MIN_CLIP_MS) throw new AppError("validation_failed", "Audio must be at least 0.2 seconds long.");
  return { ...t, audio: t.audio.map((x) => (x.id === id ? next : x)) };
}
export const removeAudio = (t: Timeline, id: string): Timeline => ({ ...t, audio: t.audio.filter((a) => a.id !== id) });
/** Replace all sound: mute every clip and use one new track from the start. */
export function replaceAudio(t: Timeline, a: { assetId: string; sourceDurationMs: number; volume?: number }): Timeline {
  const muted = { ...t, clips: t.clips.map((c) => ({ ...c, muted: true })), audio: [] };
  return addAudio(muted, { ...a, startMs: 0, volume: a.volume ?? 1, fadeInMs: 0, fadeOutMs: Math.min(1500, a.sourceDurationMs / 4) | 0 });
}

// ---------------------------------------------------------------- validation
export interface TimelineIssue {
  severity: "error" | "warning";
  message: string;
  ref?: string;
}

const NON_LATIN = /[^\u0000-\u024F\u2000-\u206F\u20A0-\u20CF]/;

/** Stable key of what a text overlay looks like; a rendered PNG is valid only for this key. */
export function overlayRenderKey(o: Overlay, t: Pick<Timeline, "width" | "height">): string {
  return [o.text, o.fontSize, o.fontFamily, o.fontWeight, o.color, o.fill, o.align, Math.round(o.w * t.width), Math.round(o.h * t.height)].join("|");
}

export function validateTimeline(t: Timeline): { passed: boolean; issues: TimelineIssue[]; durationMs: number } {
  const issues: TimelineIssue[] = [];
  const dur = timelineDuration(t);
  if (!t.clips.length) issues.push({ severity: "error", message: "Add at least one clip." });
  for (const c of t.clips) {
    if (clipDuration(c) < MIN_CLIP_MS) issues.push({ severity: "error", message: "A clip is shorter than 0.2 seconds.", ref: c.id });
    if (c.kind === "video" && c.sourceDurationMs && c.outMs > c.sourceDurationMs + 1) issues.push({ severity: "error", message: "A clip is trimmed past the end of its video.", ref: c.id });
  }
  for (const o of t.overlays) {
    if (o.startMs >= dur && dur > 0) issues.push({ severity: "warning", message: `An overlay starts after the video ends; it won't show.`, ref: o.id });
    if (o.x + o.w > 1.0001 || o.y + o.h > 1.0001) issues.push({ severity: "error", message: "An overlay goes outside the frame.", ref: o.id });
    if (o.kind === "text") {
      if (!o.text?.trim()) issues.push({ severity: "error", message: "A text overlay is empty.", ref: o.id });
      const rendered = o.renderedAssetId && o.renderedKey === overlayRenderKey(o, t);
      if (!rendered && o.text && NON_LATIN.test(o.text)) issues.push({ severity: "error", message: `Text "${o.text.slice(0, 20)}" needs rendering in the editor (non-Latin scripts are drawn in the browser).`, ref: o.id });
    }
    if ((o.kind === "image" || o.kind === "logo") && !o.assetId) issues.push({ severity: "error", message: "An image overlay has no image.", ref: o.id });
  }
  for (const a of t.audio) {
    if (a.startMs >= dur && dur > 0) issues.push({ severity: "warning", message: "An audio track starts after the video ends.", ref: a.id });
  }
  const max = EXPORT_PRESETS[t.preset].maxSeconds;
  if (max && dur > max * 1000) issues.push({ severity: "warning", message: `${EXPORT_PRESETS[t.preset].label} allows up to ${max}s; this is ${Math.round(dur / 1000)}s.` });
  return { passed: !issues.some((i) => i.severity === "error"), issues, durationMs: dur };
}
