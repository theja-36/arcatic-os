/**
 * Real FFmpeg through Docker (opt-in): ARCATIC_FFMPEG_DOCKER=1 TMPDIR=<shared dir> pnpm vitest run test/media-activities.docker.test.ts
 * Exercises renderVideo/probeMedia end to end: download → plan → ffmpeg with progress → upload → probe → poster → DB.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const enabled = process.env.ARCATIC_FFMPEG_DOCKER === "1";
const run = enabled ? describe : describe.skip;

vi.mock("@temporalio/activity", () => ({ ApplicationFailure: { create: (o: { message: string }) => new Error(o.message) }, Context: { current: () => ({ heartbeat: () => undefined, cancellationSignal: new AbortController().signal, cancelled: new Promise(() => undefined) }) } }));

run("media activities with real ffmpeg", () => {
  it("probes uploads and renders a project to a new media asset", async () => {
    const tmp = process.env.TMPDIR!.replace(/\/$/, "");
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    for (const tool of ["ffmpeg", "ffprobe"]) {
      writeFileSync(join(bin, tool), `#!/bin/sh\nexec docker run --rm -i -v "${tmp}:${tmp}" --entrypoint ${tool} arcatic-ffmpeg:test "$@"\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    const media = join(tmp, "src");
    mkdirSync(media, { recursive: true });
    const ff = (...a: string[]) => execFileSync(join(bin, "ffmpeg"), ["-hide_banner", "-loglevel", "error", "-y", ...a]);
    ff("-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=4", "-f", "lavfi", "-i", "sine=duration=4", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", join(media, "clip.mp4"));
    ff("-f", "lavfi", "-i", "sine=frequency=330:duration=10", "-c:a", "aac", join(media, "music.m4a"));

    const { memDb } = await import("./mem-db.js");
    const { createMediaActivities } = await import("../src/media-activities.js");
    const { addAudio, addClip, emptyTimeline } = await import("@arcatic/core");
    let t = addClip(emptyTimeline("square"), { assetId: "clip", kind: "video", inMs: 500, outMs: 3500, sourceDurationMs: 4000, hasAudio: true, volume: 1, muted: false, fit: "cover", fadeIn: false });
    t = addAudio(t, { assetId: "music", sourceDurationMs: 10_000, startMs: 0, volume: 0.5, fadeInMs: 0, fadeOutMs: 500 });
    const { db, tables, storage } = memDb({
      media_assets: [
        { id: "clip", workspace_id: "w", storage_path: "w/b/clip/clip.mp4", status: "processing", kind: "video", metadata: {} },
        { id: "music", workspace_id: "w", storage_path: "w/b/music/music.m4a", status: "ready", kind: "audio", metadata: {} },
      ],
      video_projects: [{ id: "p1", workspace_id: "w", brand_id: "b", title: "Square test", timeline: t, revision: 2, status: "rendering" }],
      job_events: [], generation_jobs: [{ id: "j1", workspace_id: "w" }],
    });
    storage.set("w/b/clip/clip.mp4", new Uint8Array(readFileSync(join(media, "clip.mp4"))));
    storage.set("w/b/music/music.m4a", new Uint8Array(readFileSync(join(media, "music.m4a"))));
    const acts = createMediaActivities({ db, ffmpegBin: join(bin, "ffmpeg"), ffprobeBin: join(bin, "ffprobe") });

    const probed = await acts.probeMedia({ jobId: "jp", workspaceId: "w", assetId: "clip", chargeCredits: 0 });
    expect(probed).toMatchObject({ hasAudio: true, hasVideo: true });
    expect(Math.abs(probed.durationMs - 4000)).toBeLessThan(100);
    expect(tables.media_assets![0]).toMatchObject({ status: "ready", width: 1280, height: 720 });
    expect(storage.has("w/b/clip/clip.mp4.poster.jpg")).toBe(true);

    const r = await acts.renderVideo({ jobId: "j1", workspaceId: "w", brandId: "b", projectId: "p1", revision: 2, mode: "final", chargeCredits: 0.5 });
    expect(r).toMatchObject({ durationMs: 3000, width: 1080, height: 1080 });
    const out = tables.media_assets!.find((a) => a.id === r.assetId)!;
    expect(out).toMatchObject({ kind: "video", status: "ready", source: "render", width: 1080, height: 1080 });
    expect(Math.abs((out.duration_ms as number) - 3000)).toBeLessThan(100);
    expect((out.metadata as { hasAudio: boolean }).hasAudio).toBe(true);
    expect(tables.video_projects![0]).toMatchObject({ status: "rendered", output_asset_id: r.assetId, rendered_revision: 2 });
  }, 180_000);
});
