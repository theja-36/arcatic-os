import { AppError, PaginationSchema, estimateCredits, fromDbError, JOB_STATUSES, type CostedKind } from "@arcatic/core";
import { Hono } from "hono";
import { z } from "zod";
import { body, check, idempotencyKey, parse } from "../http.js";
import { requirePermission as can } from "../middleware/workspace.js";
import { startCostedJob } from "../job-start.js";
import type { ApiDeps, AppEnv } from "../types.js";

const SelfTestSchema = z.object({ steps: z.number().int().min(1).max(20).default(3), failAtStep: z.number().int().optional() });
const GenerateSchema = z.object({
  brandId: z.uuid(),
  templateKey: z.string().regex(/^[a-z_.]+@\d+$/),
  input: z.record(z.string(), z.unknown()),
  contentItemId: z.uuid().optional(),
});
const ListSchema = PaginationSchema.extend({ status: z.enum(JOB_STATUSES).optional(), kind: z.string().optional() });

/** 'social.post@1' → 'generate.social_post' */
const costKindFor = (templateKey: string) => `generate.${templateKey.split("@")[0]!.replace(".", "_")}` as CostedKind;

export const jobRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();

  r.get("/jobs", can("job.read"), async (c) => {
    const q = parse(ListSchema, c.req.query());
    let query = c.get("db").from("generation_jobs")
      .select("id, kind, status, progress, brand_id, estimated_credits, actual_credits, error, created_at, started_at, finished_at")
      .eq("workspace_id", c.get("workspaceId")).order("created_at", { ascending: false }).limit(q.limit + 1);
    if (q.status) query = query.eq("status", q.status);
    if (q.kind) query = query.eq("kind", q.kind);
    if (q.cursor) query = query.lt("created_at", q.cursor);
    const rows = check(await query);
    const page = rows.slice(0, q.limit);
    return c.json({ data: page, next_cursor: rows.length > q.limit ? page.at(-1)?.created_at : null });
  });

  r.get("/jobs/:jobId", can("job.read"), async (c) => {
    const db = c.get("db");
    const ws = c.get("workspaceId");
    const job = check(await db.from("generation_jobs").select("*").eq("workspace_id", ws).eq("id", c.req.param("jobId")).single());
    const events = check(await db.from("job_events").select("id, type, message, data, created_at").eq("workspace_id", ws).eq("job_id", job.id).order("id").limit(200));
    return c.json({ ...job, events });
  });

  r.post("/jobs/:jobId/cancel", can("job.cancel"), async (c) => {
    const ws = c.get("workspaceId");
    const job = check(await c.get("db").from("generation_jobs").select("id, status").eq("workspace_id", ws).eq("id", c.req.param("jobId")).single());
    if (!["queued", "running"].includes(job.status)) throw new AppError("conflict", `Job is ${job.status}.`);
    check(await deps.serviceDb().from("generation_jobs").update({ status: "cancelling" }).eq("id", job.id).eq("workspace_id", ws).select("id").single());
    await (await deps.jobs()).cancel(job.id);  // workflow releases credits and sets 'cancelled'
    return c.json({ id: job.id, status: "cancelling" }, 202);
  });

  /** Pipeline smoke test: exercises DB mirror, events, Temporal, cancellation. Costs nothing. */
  r.post("/jobs/self-test", can("job.read"), async (c) => {
    const key = idempotencyKey(c);
    const input = await body(c, SelfTestSchema);
    const ws = c.get("workspaceId");
    const r = await startCostedJob(deps, c, {
      idempotencyKey: key, kind: "system.self_test", input, cost: { estimate: 0, max: 0 },
      start: (s, a) => s.selfTest({ ...a, workspaceId: ws, ...input }),
    });
    return c.json({ job: r.job }, 202);
  });

  /** Start a content generation: estimate → reserve credits → job row → workflow. */
  r.post("/generations", can("content.create"), async (c) => {
    const key = idempotencyKey(c);
    const input = await body(c, GenerateSchema);
    const ws = c.get("workspaceId");
    const brand = await c.get("db").from("brands").select("id").eq("workspace_id", ws).eq("id", input.brandId).is("deleted_at", null).maybeSingle();
    if (brand.error) throw fromDbError(brand.error);
    if (!brand.data) throw new AppError("not_found", "Brand not found.");

    let cost;
    try {
      cost = estimateCredits({ kind: costKindFor(input.templateKey) });
    } catch {
      throw new AppError("validation_failed", `Unknown template ${input.templateKey}.`);
    }
    const p = c.get("principal");
    const r = await startCostedJob(deps, c, {
      idempotencyKey: key, kind: costKindFor(input.templateKey), brandId: input.brandId, input, cost,
      extra: { content_item_id: input.contentItemId ?? null },
      start: (s, a) => s.generateContent({
        ...a, workspaceId: ws, brandId: input.brandId, templateKey: input.templateKey, input: input.input,
        contentItemId: input.contentItemId, requestedBy: p.kind === "user" ? p.userId : undefined,
      }),
    });
    return c.json({ job: r.job, credits: r.credits }, 202);
  });

  return r;
};
