import { spawn } from "node:child_process";
import { AppError } from "@arcatic/core";

/**
 * FFmpeg is invoked as a CLI binary in the worker image (LGPL build; docs/00). These builders are
 * pure so they can be unit-tested without ffmpeg installed.
 */
export const probeArgs = (input: string) => ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input];

/** Mono 16 kHz Opus in 10-minute segments: small uploads, resumable transcription. */
export function audioSegmentArgs(input: string, outPattern: string, opts: { segmentSeconds?: number; maxSeconds?: number } = {}) {
  return [
    "-hide_banner", "-nostdin", "-y", "-i", input,
    ...(opts.maxSeconds ? ["-t", String(opts.maxSeconds)] : []),
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k",
    "-f", "segment", "-segment_time", String(opts.segmentSeconds ?? 600), "-reset_timestamps", "1",
    outPattern,
  ];
}

export function parseProbe(json: string): { durationMs: number; hasAudio: boolean; hasVideo: boolean; formatName?: string } {
  const p = JSON.parse(json) as { format?: { duration?: string; format_name?: string }; streams?: Array<{ codec_type?: string; duration?: string }> };
  const streams = p.streams ?? [];
  const dur = Number(p.format?.duration ?? streams.find((s) => s.duration)?.duration ?? NaN);
  if (!Number.isFinite(dur)) throw new AppError("validation_failed", "Could not read the media duration.");
  return { durationMs: Math.round(dur * 1000), hasAudio: streams.some((s) => s.codec_type === "audio"), hasVideo: streams.some((s) => s.codec_type === "video"), formatName: p.format?.format_name };
}

export function run(bin: string, args: string[], opts: { signal?: AbortSignal; timeoutMs?: number; onStdout?: (chunk: string) => void } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], signal: opts.signal, timeout: opts.timeoutMs ?? 30 * 60_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      const s = String(d);
      if (opts.onStdout) opts.onStdout(s);
      else stdout += s;
    });
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-8000)));
    child.on("error", (e) => reject(new AppError("upstream_error", `${bin} failed to start: ${e.message}`, { retryable: false, cause: e })));
    child.on("close", (code) =>
      code === 0 ? resolve({ stdout, stderr }) : reject(new AppError("validation_failed", `${bin} exited with ${code}: ${stderr.split("\n").slice(-3).join(" ")}`)));
  });
}
