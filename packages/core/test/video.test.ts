import { describe, expect, it } from "vitest";
import {
  addAudio, addClip, addOverlay, buildRenderPlan, clipStarts, emptyTimeline, moveClip, overlayRenderKey, parseProgress, previewSize,
  removeClip, replaceAudio, splitClip, timelineDuration, trimClip, updateAudio, updateOverlay, validateTimeline, type Timeline,
} from "../src/index.js";

const video = (assetId: string, ms: number, hasAudio = true) => ({ assetId, kind: "video" as const, inMs: 0, outMs: ms, sourceDurationMs: ms, hasAudio, volume: 1, muted: false, fit: "cover" as const, fadeIn: false });
const still = (assetId: string, ms: number) => ({ assetId, kind: "image" as const, inMs: 0, outMs: ms, sourceDurationMs: null, hasAudio: false, volume: 1, muted: false, fit: "contain" as const, fadeIn: true });
const base = (): Timeline => addClip(addClip(addClip(emptyTimeline("instagram-reel"), video("v1", 8000)), still("img", 3000)), video("v2", 5000, false));
const inputs = { path: (id: string) => `/tmp/r/${id}`, textFile: (id: string) => `/tmp/r/${id}.txt`, fontFile: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" };

describe("timeline edits", () => {
  it("computes durations and starts", () => {
    const t = base();
    expect(t.clips.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(timelineDuration(t)).toBe(16000);
    expect(clipStarts(t)).toEqual([0, 8000, 11000]);
  });
  it("trims within the source and refuses tiny clips", () => {
    const t = trimClip(base(), "c1", 1000, 99_000);
    expect(t.clips[0]).toMatchObject({ inMs: 1000, outMs: 8000 });
    expect(() => trimClip(base(), "c1", 1000, 1100)).toThrow(/0.2 seconds/);
    expect(trimClip(base(), "c2", 500, 4500).clips[1]).toMatchObject({ inMs: 0, outMs: 4000 });   // images: length only
  });
  it("splits the clip under the playhead into two contiguous parts", () => {
    const t = splitClip(base(), 5000);
    expect(t.clips.map((c) => [c.id, c.inMs, c.outMs])).toEqual([["c1", 0, 5000], ["c4", 5000, 8000], ["c2", 0, 3000], ["c3", 0, 5000]]);
    expect(timelineDuration(t)).toBe(16000);
    const img = splitClip(base(), 9000);
    expect(img.clips.slice(1, 3).map((c) => c.outMs)).toEqual([1000, 2000]);
    expect(() => splitClip(base(), 8050)).toThrow(/edge/);
    expect(() => splitClip(base(), 20_000)).toThrow(/playhead/);
  });
  it("reorders and removes", () => {
    expect(moveClip(base(), "c3", 0).clips.map((c) => c.id)).toEqual(["c3", "c1", "c2"]);
    expect(removeClip(base(), "c2").clips.map((c) => c.id)).toEqual(["c1", "c3"]);
  });
  it("audio: add, trim, align, replace", () => {
    let t = addAudio(base(), { assetId: "music", sourceDurationMs: 120_000, startMs: 2000, volume: 0.6, fadeInMs: 500, fadeOutMs: 1000 });
    t = updateAudio(t, "a1", { inMs: 10_000, outMs: 20_000, startMs: 1000 });
    expect(t.audio[0]).toMatchObject({ inMs: 10_000, outMs: 20_000, startMs: 1000 });
    const r = replaceAudio(t, { assetId: "voice", sourceDurationMs: 15_000 });
    expect(r.clips.every((c) => c.muted)).toBe(true);
    expect(r.audio.map((a) => a.assetId)).toEqual(["voice"]);
  });
  it("editing a text overlay invalidates its rendered PNG", () => {
    let t = addOverlay(base(), { kind: "text", text: "Fresh idli", startMs: 0, endMs: 3000, x: 0.1, y: 0.1, w: 0.8, h: 0.1, opacity: 1, fontSize: 64, color: "#ffffff" });
    t = updateOverlay(t, "o1", { renderedAssetId: "png1", renderedKey: overlayRenderKey(t.overlays[0]!, t) });
    expect(validateTimeline(t).passed).toBe(true);
    t = updateOverlay(t, "o1", { text: "తాజా ఇడ్లీ" });
    expect(t.overlays[0]!.renderedAssetId).toBeNull();
    expect(validateTimeline(t).issues[0]).toMatchObject({ severity: "error", ref: "o1" });
  });
  it("warns past the platform limit and errors on overflow and empty timelines", () => {
    expect(validateTimeline(emptyTimeline("x")).issues[0]!.message).toMatch(/Add at least one clip/);
    const long = addClip(emptyTimeline("x"), video("v", 200_000));
    expect(validateTimeline(long)).toMatchObject({ passed: true, issues: [expect.objectContaining({ severity: "warning" })] });
    expect(() => addOverlay(base(), { kind: "rect", startMs: 2, endMs: 1, x: 0, y: 0, w: 1, h: 1, opacity: 1 })).toThrow();
  });
});

describe("render plan", () => {
  it("normalises each clip, concatenates, overlays in order and mixes audio", () => {
    let t = base();
    t = addOverlay(t, { kind: "rect", startMs: 0, endMs: 16000, x: 0, y: 0.8, w: 1, h: 0.2, opacity: 0.5, fill: "#000000" });
    t = addOverlay(t, { kind: "logo", assetId: "logo", startMs: 0, endMs: 99_000, x: 0.05, y: 0.05, w: 0.2, h: 0.1, opacity: 1 });
    t = addOverlay(t, { kind: "text", text: "Order now", startMs: 12_000, endMs: 16_000, x: 0.1, y: 0.85, w: 0.8, h: 0.08, opacity: 1, fontSize: 72, color: "#ffffff", align: "center" });
    t = addAudio(t, { assetId: "music", sourceDurationMs: 60_000, startMs: 0, volume: 0.4, fadeInMs: 0, fadeOutMs: 2000 });
    const p = buildRenderPlan(t, inputs, "/tmp/r/out.mp4", "final");
    const fc = p.args[p.args.indexOf("-filter_complex") + 1]!;
    expect(p.args.slice(3, 9)).toEqual(["-ss", "0.000", "-t", "8.000", "-i", "/tmp/r/v1"]);
    expect(p.args).toContain("-loop");
    expect(fc).toContain("[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vc][ac]");
    expect(fc).toContain("aevalsrc=0:c=stereo:s=48000:d=3.000");          // still image → silence
    expect(fc).toContain("[1:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920");
    expect(fc).toContain("drawbox=x=0:y=1536:w=1080:h=384:color=0x000000@0.50:t=fill");
    expect(fc).toContain("overlay=x=54:y=96:enable='between(t,0.000,16.000)'");   // clamped to duration
    expect(fc).toContain("textfile='/tmp/r/o3.txt'");
    expect(fc).toContain("afade=t=out:st=14.000:d=2.000");
    expect(fc).toContain("amix=inputs=2:duration=first:normalize=0[aout]");
    expect(p.drawtextOverlays).toEqual(["o3"]);
    expect(p.args.slice(-8)).toEqual(["+faststart", "-t", "16.000", "-progress", "pipe:1", "-nostats", "/tmp/r/out.mp4"].length === 7 ? ["-movflags", "+faststart", "-t", "16.000", "-progress", "pipe:1", "-nostats", "/tmp/r/out.mp4"] : []);
    expect(p.args.at(-1)).toBe("/tmp/r/out.mp4");
  });
  it("uses the rendered PNG for text when it matches, and scales previews down", () => {
    let t = addOverlay(base(), { kind: "text", text: "తాజా ఇడ్లీ", startMs: 0, endMs: 2000, x: 0.1, y: 0.1, w: 0.8, h: 0.1, opacity: 1, fontSize: 64 });
    t = updateOverlay(t, "o1", { renderedAssetId: "png1", renderedKey: overlayRenderKey(t.overlays[0]!, t) });
    const p = buildRenderPlan(t, inputs, "/tmp/out.mp4", "preview");
    expect(p.drawtextOverlays).toEqual([]);
    expect(p.args).toContain("/tmp/r/png1");
    expect({ width: p.width, height: p.height }).toEqual(previewSize(1080, 1920));
    expect(p.args).toContain("ultrafast");
  });
  it("parses ffmpeg progress", () => {
    expect(parseProgress("frame=10\nout_time_us=2500000\nprogress=continue\n")).toEqual({ outTimeMs: 2500, done: false });
    expect(parseProgress("out_time_ms=16000000\nprogress=end\n")).toEqual({ outTimeMs: 16000, done: true });
  });
});
