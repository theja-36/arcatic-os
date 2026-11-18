/**
 * Real render check: generates test media, compiles timelines with @arcatic/core's
 * buildRenderPlan and runs FFmpeg in the worker-equivalent Docker image.
 *   pnpm verify:render            (needs Docker; builds arcatic-ffmpeg:test if missing)
 * Exits non-zero on any mismatch. Prints the 60 s 1080p final render time.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addAudio, addClip, addOverlay, buildRenderPlan, emptyTimeline, overlayRenderKey, splitClip, updateOverlay, validateTimeline, type Timeline,
} from "../packages/core/src/index.ts";

const IMAGE = "arcatic-ffmpeg:test";
const work = process.env.RENDER_WORKDIR ?? mkdtempSync(join(tmpdir(), "arcatic-render-"));
mkdirSync(work, { recursive: true });
const docker = (entry: "ffmpeg" | "ffprobe", args: string[]) =>
  execFileSync("docker", ["run", "--rm", "-v", `${work}:/work`, "--entrypoint", entry, IMAGE, ...args], { encoding: "latin1", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
const ff = (...args: string[]) => docker("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const probe = (file: string) => JSON.parse(docker("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", `/work/${file}`])) as {
  format: { duration: string }; streams: Array<{ codec_type: string; width?: number; height?: number; codec_name: string }>;
};
let failures = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
};

console.log(`work dir: ${work}`);
// ---- test media (made by ffmpeg itself) ----------------------------------------
ff("-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=12", "-f", "lavfi", "-i", "sine=frequency=440:duration=12", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "/work/landscape.mp4");
ff("-f", "lavfi", "-i", "testsrc=size=720x1280:rate=25:duration=6", "-c:v", "libx264", "-preset", "ultrafast", "/work/portrait-silent.mp4");
ff("-f", "lavfi", "-i", "color=c=0xe85d04:s=1200x800:d=1", "-frames:v", "1", "/work/still.png");
ff("-f", "lavfi", "-i", "color=c=0x2a9d8f:s=400x200,format=rgba", "-frames:v", "1", "/work/logo.png");
ff("-f", "lavfi", "-i", "color=c=0xffffff:s=864x192,format=rgba", "-frames:v", "1", "/work/text-rendered.png");
ff("-f", "lavfi", "-i", "sine=frequency=220:duration=40", "-c:a", "aac", "/work/music.m4a");
writeFileSync(join(work, "o4.txt"), "Order on WhatsApp");

const inputs = { path: (id: string) => `/work/${id}`, textFile: (id: string) => `/work/${id}.txt`, fontFile: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" };
const clip = (assetId: string, ms: number, kind: "video" | "image" = "video", hasAudio = true) =>
  ({ assetId, kind, inMs: 0, outMs: ms, sourceDurationMs: kind === "video" ? ms : null, hasAudio, volume: 1, muted: false, fit: "cover" as const, fadeIn: kind === "image" });

// ---- 1) mixed timeline: video+audio, still, silent portrait video, split, overlays, music, rendered Telugu text PNG
let t: Timeline = emptyTimeline("instagram-reel");
t = addClip(t, { ...clip("landscape.mp4", 12000), inMs: 2000, outMs: 9000 });   // trimmed 7 s
t = addClip(t, { ...clip("still.png", 2500, "image", false), fit: "contain" });
t = addClip(t, clip("portrait-silent.mp4", 6000, "video", false));
t = splitClip(t, 3000);                                                            // split first clip
t = addOverlay(t, { kind: "rect", startMs: 0, endMs: 99_000, x: 0, y: 0.82, w: 1, h: 0.18, opacity: 0.6, fill: "#000000" });
t = addOverlay(t, { kind: "logo", assetId: "logo.png", startMs: 0, endMs: 99_000, x: 0.05, y: 0.04, w: 0.3, h: 0.08, opacity: 1 });
t = addOverlay(t, { kind: "text", text: "తాజా ఇడ్లీ ప్రతి ఉదయం", startMs: 1000, endMs: 6000, x: 0.1, y: 0.4, w: 0.8, h: 0.1, opacity: 1, fontSize: 72, color: "#ffffff" });
t = updateOverlay(t, "o3", { renderedAssetId: "text-rendered.png", renderedKey: overlayRenderKey(t.overlays[2]!, t) });
t = addOverlay(t, { kind: "text", text: "Order on WhatsApp", startMs: 10_000, endMs: 15_500, x: 0.1, y: 0.86, w: 0.8, h: 0.08, opacity: 1, fontSize: 64, color: "#ffffff", align: "center", fill: "#e85d04" });
t = addAudio(t, { assetId: "music.m4a", sourceDurationMs: 40_000, startMs: 1500, volume: 0.35, fadeInMs: 500, fadeOutMs: 1500 });
const v = validateTimeline(t);
check(v.passed, `timeline valid (${v.durationMs} ms, ${v.issues.length} issue(s))`);

for (const mode of ["final", "preview"] as const) {
  const plan = buildRenderPlan(t, inputs, `/work/mixed-${mode}.mp4`, mode);
  const t0 = Date.now();
  docker("ffmpeg", plan.args);
  const secs = (Date.now() - t0) / 1000;
  const p = probe(`mixed-${mode}.mp4`);
  const vs = p.streams.find((s) => s.codec_type === "video");
  const as = p.streams.find((s) => s.codec_type === "audio");
  check(vs?.width === plan.width && vs?.height === plan.height, `${mode}: ${vs?.width}x${vs?.height} (expected ${plan.width}x${plan.height})`);
  check(Math.abs(Number(p.format.duration) * 1000 - plan.durationMs) < 150, `${mode}: duration ${p.format.duration}s (expected ${plan.durationMs / 1000}s)`);
  check(vs?.codec_name === "h264" && as?.codec_name === "aac", `${mode}: h264 + aac`);
  console.log(`  rendered in ${secs.toFixed(1)} s`);
}
// a frame where the drawtext CTA box and the rendered PNG would be visible
ff("-ss", "12", "-i", "/work/mixed-final.mp4", "-frames:v", "1", "/work/frame-12s.png");
ff("-ss", "3", "-i", "/work/mixed-final.mp4", "-frames:v", "1", "/work/frame-3s.png");
// pixel checks: logo (teal) top-left, rendered text image (white) mid-frame at 3 s
const px = (file: string, x: number, y: number) => docker("ffmpeg", ["-v", "error", "-i", `/work/${file}`, "-vf", `crop=1:1:${x}:${y},format=rgb24`, "-f", "rawvideo", "-"]);
const rgb = (s: string) => [...Buffer.from(s, "latin1")].slice(0, 3);
const near = (a: number[], b: number[], tol = 40) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
const logoPx = rgb(px("frame-3s.png", 150, 120));
check(near(logoPx, [0x2a, 0x9d, 0x8f]), `logo composited at top-left (got rgb ${logoPx.join(",")})`);
const textPx = rgb(px("frame-3s.png", 540, 850));
check(near(textPx, [255, 255, 255]), `rendered text image composited mid-frame (got rgb ${textPx.join(",")})`);
const ctaPx = rgb(px("frame-12s.png", 200, 1640));
check(near(ctaPx, [0xe8, 0x5d, 0x04], 50), `CTA brand-colour box at 12 s (got rgb ${ctaPx.join(",")})`);

// ---- 2) 60 s 1080p benchmark (acceptance: < 2 min on the GPU node; this machine is CPU-only)
let long: Timeline = emptyTimeline("youtube");
for (let i = 0; i < 5; i++) long = addClip(long, clip("landscape.mp4", 12000));
long = addOverlay(long, { kind: "logo", assetId: "logo.png", startMs: 0, endMs: 60_000, x: 0.02, y: 0.03, w: 0.15, h: 0.1, opacity: 0.9 });
long = addAudio(long, { assetId: "music.m4a", sourceDurationMs: 40_000, startMs: 0, volume: 0.3, fadeInMs: 0, fadeOutMs: 1000 });
const bench = buildRenderPlan(long, inputs, "/work/bench-60s.mp4", "final");
const b0 = Date.now();
docker("ffmpeg", bench.args);
const benchSecs = (Date.now() - b0) / 1000;
const bp = probe("bench-60s.mp4");
check(Math.abs(Number(bp.format.duration) - 60) < 0.2, `60 s 1080p: duration ${bp.format.duration}s`);
console.log(`  60 s 1080p final render: ${benchSecs.toFixed(1)} s (${benchSecs < 120 ? "within" : "OVER"} the 2-minute target on this machine)`);

console.log(failures ? `\n${failures} check(s) failed` : "\nALL RENDER CHECKS PASSED");
process.exit(failures ? 1 : 0);
