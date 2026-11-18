import {
  AppError, EXPORT_PRESETS, TimelineSchema, addClip, docFrom, emptyTimeline, estimateCredits, fromDbError, validateDoc, validateTimeline,
  type ExportPreset, type Timeline,
} from "@arcatic/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { body, check, idempotencyKey, ok } from "../http.js";
import { startCostedJob } from "../job-start.js";
import { assertPlanFeature } from "./billing.js";
import { requirePermission as can } from "../middleware/workspace.js";
import type { ApiDeps, AppEnv } from "../types.js";

const PRESETS = Object.keys(EXPORT_PRESETS) as [ExportPreset, ...ExportPreset[]];
const LIST = "id, title, export_preset, status, duration_ms, revision, rendered_revision, preview_asset_id, output_asset_id, content_item_id, last_render_job_id, updated_at, created_at";
const CreateSchema = z.object({ title: z.string().trim().min(1).max(200), preset: z.enum(PRESETS).default("instagram-reel"), assetIds: z.array(z.uuid()).max(50).default([]) });
const SaveSchema = z.object({ revision: z.number().int().nonnegative(), timeline: z.unknown(), title: z.string().trim().min(1).max(200).optional() });
const RenderSchema = z.object({ mode: z.enum(["preview", "final"]) });
const SendSchema = z.object({ channel: z.enum(["instagram", "facebook", "youtube", "tiktok", "linkedin", "x", "threads"]), caption: z.string().max(5000).default(""), hashtags: z.string().max(500).default("") });

type Asset = { id: string; kind: string; status: string; duration_ms: number | null; metadata: { hasAudio?: boolean } | null };

/** Render cost: final renders 0.5 credits per started minute; previews are free. */
export const renderCost = (durationMs: number, mode: "preview" | "final") =>
  mode === "preview" ? { estimate: 0, max: 0 } : estimateCredits({ kind: "render.video_minute", quantity: Math.max(1, Math.ceil(durationMs / 60_000)) });

export const videoRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  const actor = (c: Context<AppEnv>) => {
    const p = c.get("principal");
    return p.kind === "user" ? p.userId : null;
  };
  const brandId = (c: Context<AppEnv>) => c.req.param("brandId")!;
  async function project(c: Context<AppEnv>) {
    const res = await c.get("db").from("video_projects").select(`${LIST}, timeline, brand_id`).eq("workspace_id", c.get("workspaceId")).eq("brand_id", brandId(c)).eq("id", c.req.param("projectId")!).maybeSingle();
    if (res.error) throw fromDbError(res.error);
    if (!res.data) throw new AppError("not_found", "Video project not found.");
    return res.data as unknown as { id: string; title: string; status: string; revision: number; rendered_revision: number | null; output_asset_id: string | null; content_item_id: string | null; timeline: Timeline; duration_ms: number };
  }

  r.get("/brands/:brandId/video-projects", can("media.read"), async (c) => {
    return c.json({ data: check(await c.get("db").from("video_projects").select(LIST).eq("workspace_id", c.get("workspaceId")).eq("brand_id", brandId(c)).order("updated_at", { ascending: false }).limit(100)) });
  });

  /** New project, optionally pre-filled with clips in the order the files were picked. */
  r.post("/brands/:brandId/video-projects", can("media.create"), async (c) => {
    const i = await body(c, CreateSchema);
    let t = emptyTimeline(i.preset);
    if (i.assetIds.length) {
      const rows = check(await c.get("db").from("media_assets").select("id, kind, status, duration_ms, metadata").eq("workspace_id", c.get("workspaceId")).in("id", i.assetIds)) as Asset[];
      const byId = new Map(rows.map((a) => [a.id, a]));
      for (const id of i.assetIds) {
        const a = byId.get(id);
        if (!a || a.status !== "ready" || !["video", "image"].includes(a.kind)) throw new AppError("validation_failed", "Pick ready videos or images.");
        if (a.kind === "video" && !a.duration_ms) throw new AppError("validation_failed", "A video is still being processed.");
        t = addClip(t, a.kind === "video"
          ? { assetId: a.id, kind: "video", inMs: 0, outMs: a.duration_ms!, sourceDurationMs: a.duration_ms!, hasAudio: !!a.metadata?.hasAudio, volume: 1, muted: false, fit: "cover", fadeIn: false }
          : { assetId: a.id, kind: "image", inMs: 0, outMs: 3000, sourceDurationMs: null, hasAudio: false, volume: 1, muted: false, fit: "cover", fadeIn: true });
      }
    }
    const row = check(await c.get("db").from("video_projects").insert({
      workspace_id: c.get("workspaceId"), brand_id: brandId(c), title: i.title, export_preset: i.preset, timeline: t, duration_ms: t.clips.reduce((s, x) => s + x.outMs - x.inMs, 0), created_by: actor(c),
    }).select(LIST).single());
    return c.json(row, 201);
  });

  r.get("/brands/:brandId/video-projects/:projectId", can("media.read"), async (c) => {
    const p = await project(c);
    return c.json({ ...p, validation: validateTimeline(TimelineSchema.parse(p.timeline)) });
  });

  /** Save the timeline. Saving is allowed with problems; rendering requires a clean timeline. */
  r.put("/brands/:brandId/video-projects/:projectId/timeline", can("media.update"), async (c) => {
    const i = await body(c, SaveSchema);
    const p = await project(c);
    const parsed = TimelineSchema.safeParse(i.timeline);
    if (!parsed.success) throw new AppError("validation_failed", "The timeline is malformed.", { details: parsed.error.issues.slice(0, 10).map((x) => ({ path: x.path.join("."), message: x.message })) });
    const t = parsed.data;
    // every referenced file must belong to this workspace
    const ids = [...new Set([...t.clips.map((x) => x.assetId), ...t.audio.map((x) => x.assetId), ...t.overlays.flatMap((o) => [o.assetId, o.renderedAssetId].filter((x): x is string => !!x))])];
    if (ids.length) {
      const found = check(await c.get("db").from("media_assets").select("id").eq("workspace_id", c.get("workspaceId")).in("id", ids)) as Array<{ id: string }>;
      if (found.length !== ids.length) throw new AppError("validation_failed", "The timeline uses files that aren't in this workspace.");
    }
    const v = validateTimeline(t);
    const revision = check(await deps.serviceDb().rpc("save_video_timeline", { p_project: p.id, p_base_revision: i.revision, p_timeline: t, p_duration_ms: v.durationMs, p_title: i.title ?? null }));
    return c.json({ revision, validation: v });
  });

  r.post("/brands/:brandId/video-projects/:projectId/render", can("media.update"), async (c) => {
    const key = idempotencyKey(c);
    const i = await body(c, RenderSchema);
    const p = await project(c);
    if (p.status === "rendering") throw new AppError("conflict", "A render is already running.");
    const v = validateTimeline(TimelineSchema.parse(p.timeline));
    if (!v.passed) throw new AppError("validation_failed", "Fix the timeline before rendering.", { details: v.issues.filter((x) => x.severity === "error").map((x) => ({ path: x.ref ?? "timeline", message: x.message })) });
    const ws = c.get("workspaceId");
    if (i.mode === "final") await assertPlanFeature(deps, ws, "video");
    const res = await startCostedJob(deps, c, {
      idempotencyKey: key, kind: `render.${i.mode}`, brandId: brandId(c), cost: renderCost(v.durationMs, i.mode), input: { projectId: p.id, revision: p.revision, mode: i.mode },
      start: async (s, a) => {
        if (i.mode === "final") ok(await deps.serviceDb().from("video_projects").update({ status: "rendering", last_render_job_id: a.jobId }).eq("id", p.id).eq("revision", p.revision));
        return s.renderVideo({ ...a, workspaceId: ws, brandId: brandId(c), projectId: p.id, revision: p.revision, mode: i.mode, requestedBy: actor(c) ?? undefined });
      },
    }).catch(async (e) => {
      if (i.mode === "final") await deps.serviceDb().from("video_projects").update({ status: "draft" }).eq("id", p.id).eq("status", "rendering");
      throw e;
    });
    return c.json({ job: res.job, credits: res.credits }, 202);
  });

  /** Hand the finished video to the content flow (approval → scheduling in Phase 7). */
  r.post("/brands/:brandId/video-projects/:projectId/send-to-content", can("content.create"), async (c) => {
    const i = await body(c, SendSchema);
    const p = await project(c);
    if (!p.output_asset_id || p.rendered_revision !== p.revision) throw new AppError("conflict", "Render the latest version first.");
    const svc = deps.serviceDb();
    const brand = check(await c.get("db").from("brands").select("languages").eq("id", brandId(c)).single()) as { languages: string[] };
    const doc = docFrom([["caption", i.caption], ["hashtags", i.hashtags]], "human");
    const validation = validateDoc("video", doc, i.channel);
    const item = check(await svc.from("content_items").insert({
      workspace_id: c.get("workspaceId"), brand_id: brandId(c), type: "video", channel: i.channel, language: brand.languages[0] ?? "en", title: p.title,
      status: "draft", template: null, created_by: actor(c), metadata: { videoProjectId: p.id, revision: p.revision },
    }).select("id").single()) as { id: string };
    const v = check(await svc.from("content_versions").insert({
      workspace_id: c.get("workspaceId"), brand_id: brandId(c), content_item_id: item.id, version: 1, origin: "human",
      body: { format: 1, doc, video: { assetId: p.output_asset_id, projectId: p.id, revision: p.revision } }, media_asset_ids: [p.output_asset_id],
      plain_text: `${i.caption}\n\n${i.hashtags}`.trim(), created_by: actor(c), validation_report: { passed: validation.passed, issues: validation.issues, stats: validation.stats },
    }).select("id").single()) as { id: string };
    ok(await svc.from("content_items").update({ current_version_id: v.id }).eq("id", item.id));
    ok(await svc.from("video_projects").update({ content_item_id: item.id }).eq("id", p.id));
    return c.json({ contentItemId: item.id, validation }, 201);
  });

  r.delete("/brands/:brandId/video-projects/:projectId", can("media.delete"), async (c) => {
    const p = await project(c);
    if (p.status === "rendering") throw new AppError("conflict", "Wait for the render to finish.");
    ok(await deps.serviceDb().from("video_projects").delete().eq("id", p.id));
    return c.body(null, 204);   // rendered files stay in the media library
  });

  return r;
};
