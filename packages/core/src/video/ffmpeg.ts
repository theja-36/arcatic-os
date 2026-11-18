import { previewSize } from "./presets.js";
import { clipDuration, overlayRenderKey, timelineDuration, type Timeline } from "./timeline.js";

/**
 * Compile a timeline into one FFmpeg invocation (filter_complex). Pure: file paths come from
 * `inputs`, so it is unit-testable and runs unchanged in the worker.
 */
export interface RenderInputs {
  /** local path of a media asset */
  path: (assetId: string) => string;
  /** text file for a drawtext fallback (Latin text only) */
  textFile: (overlayId: string) => string;
  fontFile: string;
}

export interface RenderPlan {
  args: string[];
  durationMs: number;
  width: number;
  height: number;
  /** overlay ids drawn with drawtext (caller must write their text files) */
  drawtextOverlays: string[];
}

const sec = (ms: number) => (ms / 1000).toFixed(3);
const col = (hex: string, alpha?: number) => `0x${hex.slice(1)}${alpha !== undefined && alpha < 1 ? `@${alpha.toFixed(2)}` : ""}`;
const q = (p: string) => `'${p.replace(/\\/g, "\\\\").replace(/'/g, "'\\''").replace(/:/g, "\\:")}'`;
const between = (s: number, e: number) => `enable='between(t,${sec(s)},${sec(e)})'`;

export function buildRenderPlan(t: Timeline, inputs: RenderInputs, outPath: string, mode: "preview" | "final"): RenderPlan {
  const { width: W, height: H } = mode === "preview" ? previewSize(t.width, t.height) : { width: t.width, height: t.height };
  const kx = W / t.width;
  const durationMs = timelineDuration(t);
  const args: string[] = ["-hide_banner", "-nostdin", "-y"];
  const f: string[] = [];
  let idx = 0;

  // 1) clips → normalised segments with exactly-sized audio
  const seg: string[] = [];
  t.clips.forEach((c, i) => {
    const d = clipDuration(c);
    if (c.kind === "video") args.push("-ss", sec(c.inMs), "-t", sec(d), "-i", inputs.path(c.assetId));
    else args.push("-loop", "1", "-framerate", String(t.fps), "-t", sec(d), "-i", inputs.path(c.assetId));
    const fit = c.fit === "contain"
      ? `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${col(t.background)}`
      : `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
    f.push(`[${idx}:v]${fit},setsar=1,fps=${t.fps},format=yuv420p${c.fadeIn ? `,fade=t=in:st=0:d=0.3` : ""},trim=duration=${sec(d)},setpts=PTS-STARTPTS[v${i}]`);
    if (c.kind === "video" && c.hasAudio && !c.muted && c.volume > 0) {
      f.push(`[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${c.volume.toFixed(2)},asetpts=PTS-STARTPTS,apad,atrim=0:${sec(d)}[a${i}]`);
    } else {
      f.push(`aevalsrc=0:c=stereo:s=48000:d=${sec(d)},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
    seg.push(`[v${i}][a${i}]`);
    idx++;
  });
  f.push(`${seg.join("")}concat=n=${t.clips.length}:v=1:a=1[vc][ac]`);

  // 2) overlays in order (later ones on top)
  let cur = "vc";
  const drawtextOverlays: string[] = [];
  t.overlays.forEach((o, j) => {
    const end = Math.min(o.endMs, durationMs);
    if (o.startMs >= end) return;
    const X = Math.round(o.x * W);
    const Y = Math.round(o.y * H);
    const w = Math.max(2, Math.round(o.w * W));
    const h = Math.max(2, Math.round(o.h * H));
    const out = `o${j}`;
    const rendered = o.kind === "text" && o.renderedAssetId && o.renderedKey === overlayRenderKey(o, t);
    if (o.kind === "rect") {
      f.push(`[${cur}]drawbox=x=${X}:y=${Y}:w=${w}:h=${h}:color=${col(o.fill ?? "#000000", o.opacity)}:t=fill:${between(o.startMs, end)}[${out}]`);
    } else if (o.kind === "image" || o.kind === "logo" || rendered) {
      const asset = rendered ? o.renderedAssetId! : o.assetId!;
      args.push("-loop", "1", "-t", sec(durationMs), "-i", inputs.path(asset));
      const scale = o.kind === "logo" ? `scale=${w}:${h}:force_original_aspect_ratio=decrease` : `scale=${w}:${h}`;
      const alpha = o.opacity < 1 ? `,format=rgba,colorchannelmixer=aa=${o.opacity.toFixed(2)}` : ",format=rgba";
      f.push(`[${idx}:v]${scale}${alpha}[ov${j}]`);
      f.push(`[${cur}][ov${j}]overlay=x=${X}:y=${Y}:${between(o.startMs, end)}[${out}]`);
      idx++;
    } else {
      // Latin-only fallback; non-Latin text is rejected by validateTimeline unless rendered.
      drawtextOverlays.push(o.id);
      const size = Math.max(8, Math.round((o.fontSize ?? 48) * kx));
      const box = o.fill ? `:box=1:boxcolor=${col(o.fill, o.opacity)}:boxborderw=${Math.round(size * 0.35)}` : "";
      const x = o.align === "center" ? `${X}+(${w}-text_w)/2` : o.align === "right" ? `${X}+${w}-text_w` : `${X}`;
      f.push(`[${cur}]drawtext=fontfile=${q(inputs.fontFile)}:textfile=${q(inputs.textFile(o.id))}:fontsize=${size}:fontcolor=${col(o.color ?? "#ffffff", o.opacity)}:x=${x}:y=${Y}:line_spacing=${Math.round(size * 0.15)}${box}:${between(o.startMs, end)}[${out}]`);
    }
    cur = out;
  });
  f.push(`[${cur}]format=yuv420p[vout]`);

  // 3) extra audio tracks mixed over the clips' sound
  const aux: string[] = [];
  t.audio.forEach((a, j) => {
    if (a.startMs >= durationMs) return;
    const len = Math.min(a.outMs - a.inMs, durationMs - a.startMs);
    args.push("-ss", sec(a.inMs), "-t", sec(len), "-i", inputs.path(a.assetId));
    const fades = [
      a.fadeInMs > 0 ? `afade=t=in:st=0:d=${sec(Math.min(a.fadeInMs, len))}` : "",
      a.fadeOutMs > 0 ? `afade=t=out:st=${sec(Math.max(0, len - a.fadeOutMs))}:d=${sec(Math.min(a.fadeOutMs, len))}` : "",
    ].filter(Boolean).join(",");
    f.push(`[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${a.volume.toFixed(2)}${fades ? `,${fades}` : ""},adelay=${a.startMs}|${a.startMs},apad[x${j}]`);
    aux.push(`[x${j}]`);
    idx++;
  });
  if (aux.length) f.push(`[ac]${aux.join("")}amix=inputs=${aux.length + 1}:duration=first:normalize=0[aout]`);

  args.push(
    "-filter_complex", f.join(";"),
    "-map", "[vout]", "-map", aux.length ? "[aout]" : "[ac]",
    "-c:v", "libx264", "-preset", mode === "final" ? "veryfast" : "ultrafast", "-crf", mode === "final" ? "21" : "30",
    "-pix_fmt", "yuv420p", "-r", String(t.fps),
    "-c:a", "aac", "-b:a", mode === "final" ? "160k" : "96k", "-ar", "48000",
    "-movflags", "+faststart", "-t", sec(durationMs),
    "-progress", "pipe:1", "-nostats",
    outPath,
  );
  return { args, durationMs, width: W, height: H, drawtextOverlays };
}

/** Parse `-progress pipe:1` output; returns the latest position and whether ffmpeg finished. */
export function parseProgress(chunk: string): { outTimeMs?: number; done: boolean } {
  let outTimeMs: number | undefined;
  for (const line of chunk.split("\n")) {
    const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
    if (m) outTimeMs = Math.round(Number(m[1]) / 1000);
  }
  return { outTimeMs, done: /progress=end/.test(chunk) };
}

/** Poster frame for a video (1s in, or the middle of short clips). */
export function posterArgs(input: string, out: string, durationMs: number) {
  return ["-hide_banner", "-nostdin", "-y", "-ss", sec(Math.min(1000, durationMs / 2)), "-i", input, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", out];
}
