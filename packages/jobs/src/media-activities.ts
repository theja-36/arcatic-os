import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationFailure, Context } from "@temporalio/activity";
import {
  AppError, IMAGE_KINDS, MEDIA_KINDS, TimelineSchema, buildRenderPlan, fromDbError, imageDimensions, parseProgress, posterArgs, sniffFile,
  validateTimeline, type Timeline,
} from "@arcatic/core";
import { decryptSecret, jobsRepo, type Db } from "@arcatic/database";
import { GoogleDriveClient, ffmpeg } from "@arcatic/integrations";
import type { ImportDriveMediaInput, ProbeMediaInput, RenderVideoInput, RenderVideoResult } from "./contracts.js";

export interface MediaDeps {
  db: Db;
  ffmpegBin?: string;
  ffprobeBin?: string;
  /** font for drawtext fallback (Latin) */
  fontFile?: string;
  encryptionKey?: string;
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw ApplicationFailure.create({ type: err.code, message: err.message, nonRetryable: !err.retryable });
    throw err;
  }
}

export function createMediaActivities({ db, ffmpegBin = "ffmpeg", ffprobeBin = "ffprobe", fontFile = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", encryptionKey }: MediaDeps) {
  async function download(storagePath: string, to: string) {
    const f = await db.storage.from("media").download(storagePath);
    if (f.error) throw new AppError("upstream_error", `Could not read ${storagePath}: ${f.error.message}`, { retryable: true });
    await writeFile(to, new Uint8Array(await f.data.arrayBuffer()));
  }

  /** ffprobe + poster frame; updates the asset row. Returns what it learned. */
  async function probeFile(workspaceId: string, asset: { id: string; storage_path: string; kind: string; metadata: Record<string, unknown> | null }, local: string, signal: AbortSignal) {
    const out = (await ffmpeg.run(ffprobeBin, ffmpeg.probeArgs(local), { signal })).stdout;
    const info = ffmpeg.parseProbe(out);
    const raw = JSON.parse(out) as { streams?: Array<{ codec_type?: string; width?: number; height?: number; codec_name?: string }> };
    const v = raw.streams?.find((s) => s.codec_type === "video");
    let posterPath: string | null = null;
    if (info.hasVideo && asset.kind === "video") {
      const poster = `${local}.poster.jpg`;
      await ffmpeg.run(ffmpegBin, posterArgs(local, poster, info.durationMs), { signal });
      posterPath = `${asset.storage_path}.poster.jpg`;
      const up = await db.storage.from("media").upload(posterPath, new Uint8Array(await readFile(poster)), { contentType: "image/jpeg", upsert: true });
      if (up.error) posterPath = null;
    }
    const upd = await db.from("media_assets").update({
      status: "ready", duration_ms: info.durationMs, width: v?.width ?? null, height: v?.height ?? null,
      metadata: { ...(asset.metadata ?? {}), hasAudio: info.hasAudio, hasVideo: info.hasVideo, videoCodec: v?.codec_name ?? null, format: info.formatName ?? null, ...(posterPath && { poster_path: posterPath }) },
    }).eq("id", asset.id).eq("workspace_id", workspaceId);
    if (upd.error) throw fromDbError(upd.error);
    return info;
  }

  return {
    /** Read duration, size and audio presence of an uploaded video/audio file; make a poster frame. */
    async probeMedia(input: ProbeMediaInput) {
      return wrap(async () => {
        const a = await db.from("media_assets").select("id, storage_path, kind, metadata, status").eq("workspace_id", input.workspaceId).eq("id", input.assetId).single();
        if (a.error) throw fromDbError(a.error);
        const dir = await mkdtemp(join(tmpdir(), "arcatic-probe-"));
        try {
          const local = join(dir, "in");
          await download(a.data.storage_path as string, local);
          try {
            const info = await probeFile(input.workspaceId, a.data as never, local, Context.current().cancellationSignal);
            return { durationMs: info.durationMs, hasAudio: info.hasAudio, hasVideo: info.hasVideo };
          } catch (e) {
            await db.from("media_assets").update({ status: "failed", metadata: { ...((a.data.metadata as object) ?? {}), error: "This file couldn't be read as audio/video." } }).eq("id", input.assetId);
            throw e instanceof AppError ? new AppError("validation_failed", e.message) : e;
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    },

    /**
     * Render a project revision with FFmpeg. Progress is reported from `-progress pipe:1`.
     * Preview: ~640 px, fast; final: export size. Output becomes a media asset.
     */
    async renderVideo(input: RenderVideoInput): Promise<RenderVideoResult> {
      return wrap(async () => {
        const proj = await db.from("video_projects").select("id, title, timeline, revision, brand_id").eq("workspace_id", input.workspaceId).eq("id", input.projectId).single();
        if (proj.error) throw fromDbError(proj.error);
        if (proj.data.revision !== input.revision) throw new AppError("conflict", "The project changed after the render was requested; render again.");
        const timeline: Timeline = TimelineSchema.parse(proj.data.timeline);
        const v = validateTimeline(timeline);
        if (!v.passed) throw new AppError("validation_failed", v.issues.filter((i) => i.severity === "error").map((i) => i.message).join(" "));

        const ctx = Context.current();
        const dir = await mkdtemp(join(tmpdir(), "arcatic-render-"));
        try {
          // fetch every referenced asset once
          const ids = new Set<string>([...timeline.clips.map((c) => c.assetId), ...timeline.audio.map((a) => a.assetId),
            ...timeline.overlays.flatMap((o) => [o.assetId, o.renderedAssetId].filter((x): x is string => !!x))]);
          const rows = await db.from("media_assets").select("id, storage_path, status").eq("workspace_id", input.workspaceId).in("id", [...ids]);
          if (rows.error) throw fromDbError(rows.error);
          const byId = new Map((rows.data ?? []).map((r) => [r.id as string, r]));
          for (const id of ids) {
            const r = byId.get(id);
            if (!r || r.status !== "ready") throw new AppError("validation_failed", "A file used in this video is missing or still processing.");
            await download(r.storage_path as string, join(dir, id));
            ctx.heartbeat({ phase: "download" });
          }
          const out = join(dir, `out-${input.mode}.mp4`);
          const plan = buildRenderPlan(timeline, { path: (id) => join(dir, id), textFile: (id) => join(dir, `${id}.txt`), fontFile }, out, input.mode);
          for (const id of plan.drawtextOverlays) await writeFile(join(dir, `${id}.txt`), timeline.overlays.find((o) => o.id === id)!.text ?? "");

          let last = 0;
          const t0 = Date.now();
          await ffmpeg.run(ffmpegBin, plan.args, {
            signal: ctx.cancellationSignal,
            timeoutMs: 60 * 60_000,
            onStdout: (chunk) => {
              const p = parseProgress(chunk);
              if (p.outTimeMs === undefined) return;
              const pct = Math.min(95, 10 + Math.round((p.outTimeMs / plan.durationMs) * 85));
              ctx.heartbeat({ pct });
              if (pct - last >= 10) {
                last = pct;
                void jobsRepo.progress(db, input.jobId, pct, `Rendering ${Math.round(p.outTimeMs / 1000)}s of ${Math.round(plan.durationMs / 1000)}s`).catch(() => undefined);
              }
            },
          });
          const seconds = (Date.now() - t0) / 1000;
          const bytes = new Uint8Array(await readFile(out));
          const id = crypto.randomUUID();
          const path = `${input.workspaceId}/${input.brandId}/${id}/${input.mode === "final" ? "video" : "preview"}.mp4`;
          const up = await db.storage.from("media").upload(path, bytes, { contentType: "video/mp4", upsert: true });
          if (up.error) throw new AppError("upstream_error", `Storage upload failed: ${up.error.message}`, { retryable: true });
          const ins = await db.from("media_assets").insert({
            id, workspace_id: input.workspaceId, brand_id: input.brandId, kind: "video", status: "processing", storage_path: path, source: "render",
            mime_type: "video/mp4", bytes: (await stat(out)).size, title: `${proj.data.title}${input.mode === "preview" ? " (preview)" : ""}`,
            generation_job_id: input.jobId, created_by: input.requestedBy ?? null,
            metadata: { projectId: input.projectId, revision: input.revision, mode: input.mode, renderSeconds: seconds, preset: timeline.preset },
          }).select("id, storage_path, kind, metadata").single();
          if (ins.error) throw fromDbError(ins.error);
          await probeFile(input.workspaceId, ins.data as never, out, ctx.cancellationSignal);

          const upd = await db.from("video_projects").update(input.mode === "final"
            ? { output_asset_id: id, status: "rendered", rendered_revision: input.revision }
            : { preview_asset_id: id, status: "draft" }).eq("id", input.projectId).eq("revision", input.revision);
          if (upd.error) throw fromDbError(upd.error);
          return { assetId: id, durationMs: plan.durationMs, width: plan.width, height: plan.height, seconds };
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    },

    async markRenderFailed(input: RenderVideoInput, message: string) {
      return wrap(async () => {
        const r = await db.from("video_projects").update({ status: "failed" }).eq("id", input.projectId).eq("status", "rendering");
        if (r.error) throw fromDbError(r.error);
        await jobsRepo.event(db, input.jobId, "error", message.slice(0, 500));
      });
    },

    /** Google Drive (picked file) → media library; video/audio are probed straight away. */
    async importDriveMedia(input: ImportDriveMediaInput): Promise<{ assetId: string }> {
      return wrap(async () => {
        const existing = await db.from("media_assets").select("id").eq("workspace_id", input.workspaceId).eq("generation_job_id", input.jobId).maybeSingle();
        if (existing.data) return { assetId: existing.data.id as string };
        const s = await db.from("ephemeral_secrets").select("ciphertext, expires_at").eq("id", input.secretId).eq("workspace_id", input.workspaceId).maybeSingle();
        if (!s.data || new Date(s.data.expires_at as string) < new Date()) throw new AppError("forbidden", "The Google Drive authorisation expired. Pick the file again.");
        const drive = new GoogleDriveClient(decryptSecret(s.data.ciphertext as string, `${input.workspaceId}:drive`, encryptionKey), { maxBytes: 500 * 1024 * 1024 });
        const meta = await drive.metadata(input.fileId, Context.current().cancellationSignal);
        if (meta.mimeType.startsWith("application/vnd.google-apps.")) throw new AppError("validation_failed", `${meta.name}: Google Docs/Sheets/Slides go to the knowledge library, not media.`);
        const file = await drive.download(meta, Context.current().cancellationSignal);
        const { kind, mime } = sniffFile(file.bytes, file.filename);
        if (kind === "svg" || !(IMAGE_KINDS.has(kind) || MEDIA_KINDS.has(kind))) throw new AppError("validation_failed", `${meta.name} isn't an image, video or audio file.`);
        const assetKind = IMAGE_KINDS.has(kind) ? "image" : (kind as "audio" | "video");
        const id = crypto.randomUUID();
        const path = `${input.workspaceId}/${input.brandId ?? "_"}/${id}/${file.filename.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 120)}`;
        const up = await db.storage.from("media").upload(path, file.bytes, { contentType: mime, upsert: true });
        if (up.error) throw new AppError("upstream_error", `Storage upload failed: ${up.error.message}`, { retryable: true });
        const dims = assetKind === "image" ? imageDimensions(file.bytes) : undefined;
        const ins = await db.from("media_assets").insert({
          id, workspace_id: input.workspaceId, brand_id: input.brandId ?? null, kind: assetKind, status: assetKind === "image" ? "ready" : "processing",
          storage_path: path, source: "drive", mime_type: mime, bytes: file.bytes.byteLength, width: dims?.width ?? null, height: dims?.height ?? null,
          title: meta.name, collection_id: input.collectionId ?? null, generation_job_id: input.jobId, created_by: input.requestedBy ?? null,
          metadata: { drive_file_id: meta.id, drive_modified_time: meta.modifiedTime ?? null },
        }).select("id, storage_path, kind, metadata").single();
        if (ins.error) throw fromDbError(ins.error);
        if (assetKind !== "image") {
          const dir = await mkdtemp(join(tmpdir(), "arcatic-drive-"));
          try {
            await writeFile(join(dir, "in"), file.bytes);
            await probeFile(input.workspaceId, ins.data as never, join(dir, "in"), Context.current().cancellationSignal);
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }
        return { assetId: id };
      });
    },
  };
}

export type MediaActivities = ReturnType<typeof createMediaActivities>;
