import { TEMPLATES } from "@arcatic/ai";
import {
  AppError, CONTENT_TYPE_DEFS, LANGUAGES, REPURPOSE_OUTPUTS, contentCost, estimateCredits, fromDbError, ideaToRequest, repurposeOutputById, sumEstimates,
  type ContentDoc, type ContentType, type Estimate, type Idea, type SourceRef,
} from "@arcatic/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { body, check, idempotencyKey, ok, parse } from "../http.js";
import { startCostedJob } from "../job-start.js";
import { requirePermission as can } from "../middleware/workspace.js";
import type { ApiDeps, AppEnv } from "../types.js";

const PROJECT_COLS = "id, name, description, status, created_at, updated_at";
const RUN_COLS = "id, project_id, source_kind, source_id, source_item_id, source_ref, outputs, language, digest, status, generation_job_id, created_at, updated_at";
const OUTPUT_IDS = REPURPOSE_OUTPUTS.map((o) => o.id) as [string, ...string[]];
const RepurposeSchema = z.object({
  sourceId: z.uuid().optional(),
  contentItemId: z.uuid().optional(),
  outputs: z.array(z.enum(OUTPUT_IDS)).min(1).max(12),
  language: z.enum(Object.keys(LANGUAGES) as [string, ...string[]]).optional(),
  projectId: z.uuid().nullable().optional(),
}).refine((x) => !!x.sourceId !== !!x.contentItemId, "Choose one source: a Knowledge source or a content item.");

function maybe<T>(res: { data: T; error: { message: string; code?: string } | null }): T | null {
  if (res.error) throw fromDbError(res.error);
  return res.data ?? null;
}

/** Repurpose cost: the digest plus each output at its normal price. */
export function repurposeCost(outputIds: string[]): Estimate {
  return sumEstimates([estimateCredits({ kind: "repurpose.digest" }), ...outputIds.map((id) => contentCost(repurposeOutputById(id)!.type))]);
}

export const growthRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  const ws = (c: Context<AppEnv>) => c.get("workspaceId");
  const brandId = (c: Context<AppEnv>) => c.req.param("brandId")!;
  const actor = (c: Context<AppEnv>) => { const p = c.get("principal"); return p.kind === "user" ? p.userId : null; };
  const svc = () => deps.serviceDb();
  async function activeProject(c: Context<AppEnv>, id: string | null | undefined) {
    if (!id) return null;
    const p = maybe(await c.get("db").from("projects").select("id, status").eq("brand_id", brandId(c)).eq("id", id).maybeSingle()) as { id: string; status: string } | null;
    if (!p) throw new AppError("not_found", "Project not found.");
    if (p.status !== "active") throw new AppError("conflict", "That project is archived.");
    return p.id;
  }
  async function brandLanguage(c: Context<AppEnv>) {
    const b = check(await c.get("db").from("brands").select("languages").eq("id", brandId(c)).single()) as { languages: string[] | null };
    return b.languages?.[0] ?? "en";
  }

  // ---------------------------------------------------------------- projects
  r.get("/brands/:brandId/projects", can("content.read"), async (c) => {
    const status = c.req.query("status") === "archived" ? "archived" : "active";
    const rows = check(await c.get("db").from("projects").select(PROJECT_COLS).eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).eq("status", status).order("updated_at", { ascending: false }).limit(200)) as Array<{ id: string }>;
    const counts = rows.length ? check(await c.get("db").from("content_items").select("project_id").in("project_id", rows.map((p) => p.id)).neq("status", "archived").limit(5000)) as Array<{ project_id: string }> : [];
    return c.json({ data: rows.map((p) => ({ ...p, items: counts.filter((x) => x.project_id === p.id).length })) });
  });

  r.post("/brands/:brandId/projects", can("content.create"), async (c) => {
    const i = await body(c, z.object({ name: z.string().trim().min(1).max(160), description: z.string().trim().max(2000).optional() }));
    const ins = await svc().from("projects").insert({ workspace_id: ws(c), brand_id: brandId(c), name: i.name, description: i.description ?? null, created_by: actor(c) }).select(PROJECT_COLS).single();
    if (ins.error?.code === "23505") throw new AppError("conflict", "A project with that name already exists.");
    if (ins.error) throw fromDbError(ins.error);
    return c.json(ins.data, 201);
  });

  r.get("/brands/:brandId/projects/:projectId", can("content.read"), async (c) => {
    const p = maybe(await c.get("db").from("projects").select(PROJECT_COLS).eq("brand_id", brandId(c)).eq("id", c.req.param("projectId")!).maybeSingle());
    if (!p) throw new AppError("not_found", "Project not found.");
    const [items, runs] = await Promise.all([
      c.get("db").from("content_items").select("id, type, channel, title, status, source_ref, repurpose_run_id, updated_at").eq("project_id", c.req.param("projectId")!).neq("status", "archived").order("updated_at", { ascending: false }).limit(500),
      c.get("db").from("repurpose_runs").select(RUN_COLS).eq("project_id", c.req.param("projectId")!).order("created_at", { ascending: false }).limit(50),
    ]);
    return c.json({ ...p, items: check(items), runs: check(runs) });
  });

  r.patch("/brands/:brandId/projects/:projectId", can("content.update"), async (c) => {
    const i = await body(c, z.object({ name: z.string().trim().min(1).max(160).optional(), description: z.string().trim().max(2000).nullable().optional(), status: z.enum(["active", "archived"]).optional() }));
    const up = await svc().from("projects").update(i).eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).eq("id", c.req.param("projectId")!).select(PROJECT_COLS).maybeSingle();
    if (up.error?.code === "23505") throw new AppError("conflict", "A project with that name already exists.");
    if (up.error) throw fromDbError(up.error);
    if (!up.data) throw new AppError("not_found", "Project not found.");
    return c.json(up.data);
  });

  /** Move content into / out of a project. */
  r.put("/brands/:brandId/content/:contentId/project", can("content.update"), async (c) => {
    const i = await body(c, z.object({ projectId: z.uuid().nullable() }));
    const projectId = await activeProject(c, i.projectId);
    const row = maybe(await c.get("db").from("content_items").update({ project_id: projectId }).eq("brand_id", brandId(c)).eq("id", c.req.param("contentId")!).select("id, project_id").maybeSingle());
    if (!row) throw new AppError("not_found", "Content not found.");
    return c.json(row);
  });

  // ---------------------------------------------------------------- repurposing
  r.get("/brands/:brandId/repurpose/options", can("content.read"), async (c) => {
    const sources = check(await c.get("db").from("sources").select("id, type, title, url, status, created_at").eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).is("parent_source_id", null).in("type", ["url", "crawl", "file", "text", "media", "drive"]).order("created_at", { ascending: false }).limit(200));
    const content = check(await c.get("db").from("content_items").select("id, type, title, status, updated_at").eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).in("type", ["blog", "case_study", "press_release", "newsletter", "document", "yt_script", "landing_page"]).neq("status", "archived").order("updated_at", { ascending: false }).limit(200));
    return c.json({ outputs: REPURPOSE_OUTPUTS.map((o) => ({ ...o, cost: contentCost(o.type) })), digestCost: estimateCredits({ kind: "repurpose.digest" }), sources, content });
  });

  r.post("/brands/:brandId/repurpose/estimate", can("content.read"), async (c) => {
    const i = await body(c, z.object({ outputs: z.array(z.enum(OUTPUT_IDS)).min(1).max(12) }));
    return c.json(repurposeCost(i.outputs));
  });

  r.post("/brands/:brandId/repurpose", can("content.create"), async (c) => {
    const key = idempotencyKey(c);
    const i = await body(c, RepurposeSchema);
    if (new Set(i.outputs).size !== i.outputs.length) throw new AppError("validation_failed", "Each output can be picked once.");
    const projectId = await activeProject(c, i.projectId);
    let ref: SourceRef;
    if (i.sourceId) {
      const s = maybe(await c.get("db").from("sources").select("id, type, title, url, status").eq("brand_id", brandId(c)).eq("id", i.sourceId).maybeSingle()) as { id: string; type: string; title: string; url: string | null; status: string } | null;
      if (!s) throw new AppError("not_found", "Source not found.");
      if (s.status !== "ready") throw new AppError("conflict", s.status === "failed" ? "That source couldn't be processed." : "That source is still being processed.");
      ref = { kind: "source", id: s.id, title: s.title, url: s.url, sourceType: s.type };
    } else {
      const it = maybe(await c.get("db").from("content_items").select("id, type, title, current_version_id").eq("brand_id", brandId(c)).eq("id", i.contentItemId!).maybeSingle()) as { id: string; type: string; title: string | null; current_version_id: string | null } | null;
      if (!it || !it.current_version_id) throw new AppError("not_found", "Content not found.");
      ref = { kind: "content", id: it.id, title: it.title ?? CONTENT_TYPE_DEFS[it.type as ContentType]?.label ?? "Content", url: null, sourceType: it.type };
    }
    const outputs = i.outputs.map((id) => { const o = repurposeOutputById(id)!; return { outputId: id, type: o.type, channel: o.channel ?? null, status: "queued" }; });
    const run = check(await svc().from("repurpose_runs").insert({
      workspace_id: ws(c), brand_id: brandId(c), project_id: projectId, source_kind: ref.kind, source_id: ref.kind === "source" ? ref.id : null, source_item_id: ref.kind === "content" ? ref.id : null,
      source_ref: ref, outputs, language: i.language ?? await brandLanguage(c), created_by: actor(c),
    }).select("id").single()) as { id: string };
    try {
      const res = await startCostedJob(deps, c, {
        idempotencyKey: key, kind: "repurpose", brandId: brandId(c), cost: repurposeCost(i.outputs), input: { runId: run.id, outputs: i.outputs, source: ref },
        start: (s, a) => s.repurpose({ ...a, workspaceId: ws(c), brandId: brandId(c), runId: run.id, requestedBy: actor(c) ?? undefined }),
      });
      if (res.replay) {
        // a retried request: drop the duplicate and answer with the first run
        ok(await svc().from("repurpose_runs").delete().eq("id", run.id));
        const first = maybe(await svc().from("repurpose_runs").select("id").eq("generation_job_id", res.job.id).maybeSingle()) as { id: string } | null;
        return c.json({ runId: first?.id ?? null, job: res.job, credits: null }, 202);
      }
      if (res.job) ok(await svc().from("repurpose_runs").update({ generation_job_id: res.job.id }).eq("id", run.id));
      return c.json({ runId: run.id, job: res.job, credits: res.credits }, 202);
    } catch (e) {
      ok(await svc().from("repurpose_runs").update({ status: "failed" }).eq("id", run.id));
      throw e;
    }
  });

  r.get("/brands/:brandId/repurpose", can("content.read"), async (c) => {
    return c.json({ data: check(await c.get("db").from("repurpose_runs").select(RUN_COLS).eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).order("created_at", { ascending: false }).limit(50)) });
  });

  r.get("/brands/:brandId/repurpose/:runId", can("content.read"), async (c) => {
    const run = maybe(await c.get("db").from("repurpose_runs").select(RUN_COLS).eq("brand_id", brandId(c)).eq("id", c.req.param("runId")!).maybeSingle());
    if (!run) throw new AppError("not_found", "Run not found.");
    const items = check(await c.get("db").from("content_items").select("id, type, channel, title, status").eq("repurpose_run_id", c.req.param("runId")!)) as unknown[];
    return c.json({ ...run, items });
  });

  // ---------------------------------------------------------------- brainstorm → drafts
  r.post("/brands/:brandId/content/:contentId/ideas/drafts", can("content.create"), async (c) => {
    const key = idempotencyKey(c);
    const i = await body(c, z.object({ indexes: z.array(z.number().int().min(1).max(30)).min(1).max(10), projectId: z.uuid().nullable().optional() }));
    const item = maybe(await c.get("db").from("content_items").select("id, type, language, current_version_id, project_id").eq("brand_id", brandId(c)).eq("id", c.req.param("contentId")!).maybeSingle()) as { id: string; type: string; language: string; current_version_id: string | null; project_id: string | null } | null;
    if (!item || item.type !== "brainstorm" || !item.current_version_id) throw new AppError("not_found", "Idea list not found.");
    const projectId = await activeProject(c, i.projectId === undefined ? item.project_id : i.projectId);
    const v = check(await c.get("db").from("content_versions").select("body").eq("id", item.current_version_id).single()) as { body: { doc?: ContentDoc } };
    const ideas = (v.body.doc?.blocks ?? []).filter((b) => b.kind === "list_item" && b.meta && "idea" in b.meta).map((b) => ({ index: Number(b.meta!.index), idea: b.meta!.idea as Idea, text: b.text }));
    const results = [];
    for (const n of [...new Set(i.indexes)]) {
      const found = ideas.find((x) => x.index === n);
      if (!found) { results.push({ index: n, error: { code: "not_found", message: "No idea with that number." } }); continue; }
      const req = ideaToRequest({ ...found.idea, title: found.text.split(" — ")[0] ?? found.idea.title }, item.language);
      const def = CONTENT_TYPE_DEFS[req.type];
      try {
        const input = parse(TEMPLATES[def.template!]!.input, req.input);
        const res = await startCostedJob(deps, c, {
          idempotencyKey: `${key}:${n}`, kind: `generate.${req.type}`, brandId: brandId(c), cost: contentCost(req.type), input: { type: req.type, mode: "create", ...input, fromIdeas: item.id },
          start: (s, a) => s.generateContent({ ...a, workspaceId: ws(c), brandId: brandId(c), templateKey: def.template!, input, projectId: projectId ?? undefined, requestedBy: actor(c) ?? undefined }),
        });
        results.push({ index: n, type: req.type, job: res.job });
      } catch (e) {
        results.push({ index: n, error: e instanceof AppError ? { code: e.code, message: e.message } : { code: "internal", message: "could not start" } });
      }
    }
    return c.json({ data: results }, 202);
  });

  return r;
};
