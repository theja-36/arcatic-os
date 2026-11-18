import {
  AppError, CreateCampaignSchema, CreateTopicSchema, PaginationSchema, SeasonalEventSchema, UpdateCampaignSchema, UpdateTopicSchema,
  builtInMoments, canTransition, estimateCredits, fromDbError, mergeMoments, topicGenerationInput, type CampaignStatus, type SeasonalMoment,
} from "@arcatic/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { body, check, idempotencyKey, ok, parse } from "../http.js";
import { startCostedJob } from "../job-start.js";
import { requirePermission as can } from "../middleware/workspace.js";
import type { ApiDeps, AppEnv } from "../types.js";

const CAMPAIGN_COLUMNS = "id, brand_id, strategy_id, plan_key, name, goal, status, starts_on, ends_on, channels, content_types, frequency, volume_target, review_window_hours, generation_schedule, brief, pillar, context, reference_source_ids, revision, next_generation_at, paused_at, cancelled_at, last_runner_event, created_at, updated_at";
const TOPIC_COLUMNS = "id, campaign_id, strategy_id, title, angle, pillar, channel, content_type, planned_for, cta, notes, status, status_note, origin, slot_key, content_item_id, generation_job_id, generation_count, position, created_at, updated_at";
const RangeSchema = z.object({ from: z.iso.date(), to: z.iso.date() }).refine((r) => r.to >= r.from, "to must be after from");
const BulkSchema = z.object({ ids: z.array(z.uuid()).min(1).max(200), action: z.enum(["approve", "drop", "reset"]) });
const EDITABLE_TOPIC = ["idea", "approved", "failed", "blocked"];

/** Bound a Temporal call so the API stays responsive if the cluster is slow. */
async function withTimeout<T>(p: Promise<T>, ms = 3000): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

export const campaignRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  const actor = (c: Context<AppEnv>) => {
    const p = c.get("principal");
    return p.kind === "user" ? p.userId : null;
  };
  const brandId = (c: Context<AppEnv>) => c.req.param("brandId")!;
  async function campaign(c: Context<AppEnv>) {
    const res = await c.get("db").from("campaigns").select(CAMPAIGN_COLUMNS).eq("workspace_id", c.get("workspaceId")).eq("brand_id", brandId(c)).eq("id", c.req.param("campaignId")!).maybeSingle();
    if (res.error) throw fromDbError(res.error);
    if (!res.data) throw new AppError("not_found", "Campaign not found.");
    return res.data as unknown as { id: string; status: CampaignStatus; revision: number; goal: string | null; brief: { cta?: string }; brand_id: string };
  }
  async function topic(c: Context<AppEnv>) {
    const res = await c.get("db").from("campaign_topics").select(TOPIC_COLUMNS).eq("workspace_id", c.get("workspaceId")).eq("brand_id", brandId(c)).eq("id", c.req.param("topicId")!).maybeSingle();
    if (res.error) throw fromDbError(res.error);
    if (!res.data) throw new AppError("not_found", "Topic not found.");
    return res.data as unknown as Record<string, unknown> & { id: string; campaign_id: string; status: string; generation_count: number; content_item_id: string | null };
  }
  const wake = async (campaignId: string) => {
    try {
      await withTimeout((await deps.jobs()).signalRunner(campaignId, "wake"));
    } catch {
      /* runner re-reads the DB on its next tick */
    }
  };

  // ---- campaigns ----------------------------------------------------------
  r.get("/brands/:brandId/campaigns", can("campaign.read"), async (c) => {
    const status = c.req.query("status");
    let q = c.get("db").from("campaigns").select(CAMPAIGN_COLUMNS).eq("workspace_id", c.get("workspaceId")).eq("brand_id", brandId(c)).order("starts_on", { ascending: true, nullsFirst: false }).limit(200);
    if (status) q = q.eq("status", status);
    const rows = check(await q) as unknown as Array<{ id: string }>;
    const counts = check(await c.get("db").from("campaign_topics").select("campaign_id, status").eq("brand_id", brandId(c)).limit(10000)) as Array<{ campaign_id: string; status: string }>;
    const by = new Map<string, Record<string, number>>();
    for (const t of counts) {
      const m = by.get(t.campaign_id) ?? {};
      m[t.status] = (m[t.status] ?? 0) + 1;
      by.set(t.campaign_id, m);
    }
    return c.json({ data: rows.map((x) => ({ ...x, topicCounts: by.get(x.id) ?? {} })) });
  });

  r.post("/brands/:brandId/campaigns", can("campaign.create"), async (c) => {
    const input = await body(c, CreateCampaignSchema);
    const row = check(await c.get("db").from("campaigns").insert({
      workspace_id: c.get("workspaceId"), brand_id: brandId(c), name: input.name, goal: input.goal ?? null, starts_on: input.startsOn ?? null, ends_on: input.endsOn ?? null,
      channels: input.channels, content_types: input.contentTypes, frequency: input.frequency, volume_target: input.volumeTarget ?? null,
      review_window_hours: input.reviewWindowHours, generation_schedule: input.generationSchedule, brief: input.brief, pillar: input.pillar ?? null,
      context: input.context ?? null, reference_source_ids: input.referenceSourceIds, status: "draft", created_by: actor(c),
    }).select(CAMPAIGN_COLUMNS).single());
    return c.json(row, 201);
  });

  r.get("/brands/:brandId/campaigns/:campaignId", can("campaign.read"), async (c) => {
    const cmp = await campaign(c);
    const topics = check(await c.get("db").from("campaign_topics").select(TOPIC_COLUMNS).eq("campaign_id", cmp.id).order("planned_for", { ascending: true, nullsFirst: false }).order("position").limit(500));
    let runner = null;
    try {
      runner = (await withTimeout((await deps.jobs()).runnerState(cmp.id))) ?? null;
    } catch {
      runner = null;
    }
    return c.json({ ...cmp, topics, runner });
  });

  r.patch("/brands/:brandId/campaigns/:campaignId", can("campaign.update"), async (c) => {
    const input = await body(c, UpdateCampaignSchema);
    const cmp = await campaign(c);
    if (cmp.status === "completed" || cmp.status === "cancelled") throw new AppError("conflict", `Campaign is ${cmp.status}.`);
    const res = await c.get("db").from("campaigns").update({
      name: input.name, goal: input.goal, starts_on: input.startsOn, ends_on: input.endsOn, channels: input.channels, content_types: input.contentTypes,
      frequency: input.frequency, volume_target: input.volumeTarget, review_window_hours: input.reviewWindowHours, generation_schedule: input.generationSchedule,
      brief: input.brief, pillar: input.pillar, context: input.context, reference_source_ids: input.referenceSourceIds, revision: input.revision + 1,
    }).eq("id", cmp.id).eq("revision", input.revision).select(CAMPAIGN_COLUMNS);
    if (res.error) throw fromDbError(res.error);
    if (!res.data?.length) throw new AppError("conflict", "Someone else changed this campaign. Reload and try again.", { details: { revision: cmp.revision } });
    if (cmp.status === "active") await wake(cmp.id);
    return c.json(res.data[0]);
  });

  /** Lifecycle actions. The DB enforces transitions; the runner gets a signal so changes apply at once. */
  r.post("/brands/:brandId/campaigns/:campaignId/:action{start|pause|resume|cancel|complete}", can("campaign.update"), async (c) => {
    const action = c.req.param("action") as "start" | "pause" | "resume" | "cancel" | "complete";
    const cmp = await campaign(c);
    const target: CampaignStatus = ({ start: "active", pause: "paused", resume: "active", cancel: "cancelled", complete: "completed" } as const)[action];
    if (!canTransition(cmp.status, target)) throw new AppError("conflict", `Can't ${action} a ${cmp.status} campaign.`);
    const starter = await deps.jobs().catch(() => null);
    if ((action === "start" || action === "resume") && !starter) throw new AppError("upstream_error", "The scheduler is unavailable; try again shortly.");

    if (action === "start" || action === "resume") {
      // runner first: if Temporal is down the campaign stays as it was
      await starter!.ensureRunner({ workspaceId: c.get("workspaceId"), brandId: brandId(c), campaignId: cmp.id });
      if (action === "resume") await withTimeout(starter!.signalRunner(cmp.id, "resume"));
    }
    const upd = await deps.serviceDb().from("campaigns").update({ status: target, runner_workflow_id: `campaign-runner:${cmp.id}` }).eq("id", cmp.id).eq("status", cmp.status).select(CAMPAIGN_COLUMNS);
    if (upd.error) throw fromDbError(upd.error);
    if (!upd.data?.length) throw new AppError("conflict", "The campaign changed; reload and try again.");

    let signalled = action === "start" || action === "resume";
    if (starter && (action === "pause" || action === "cancel" || action === "complete")) {
      signalled = (await withTimeout(starter.signalRunner(cmp.id, action === "pause" ? "pause" : "cancel", action === "complete" ? "completed" : undefined).catch(() => false))) ?? false;
    }
    if (action === "cancel") {
      await deps.serviceDb().from("campaign_topics").update({ status: "dropped", status_note: "Campaign cancelled" }).eq("campaign_id", cmp.id).in("status", ["idea", "approved", "blocked"]);
    }
    return c.json({ ...upd.data[0], runner: { signalled } });
  });

  // ---- topics -------------------------------------------------------------
  r.post("/brands/:brandId/campaigns/:campaignId/topics", can("campaign.update"), async (c) => {
    const input = await body(c, CreateTopicSchema);
    const cmp = await campaign(c);
    if (cmp.status === "completed" || cmp.status === "cancelled") throw new AppError("conflict", `Campaign is ${cmp.status}.`);
    const row = check(await c.get("db").from("campaign_topics").insert({
      campaign_id: cmp.id, title: input.title, angle: input.angle ?? null, pillar: input.pillar ?? null, channel: input.channel, channels: [input.channel],
      content_type: input.contentType, planned_for: input.plannedFor, cta: input.cta ?? null, notes: input.notes ?? null, status: input.status, origin: "human",
    }).select(TOPIC_COLUMNS).single());
    if (input.status === "approved" && cmp.status === "active") await wake(cmp.id);
    return c.json(row, 201);
  });

  r.patch("/brands/:brandId/topics/:topicId", can("campaign.update"), async (c) => {
    const input = await body(c, UpdateTopicSchema);
    const t = await topic(c);
    if (!EDITABLE_TOPIC.includes(t.status)) throw new AppError("conflict", `Topic is ${t.status.replace("_", " ")}; it can't be edited now.`);
    const row = check(await c.get("db").from("campaign_topics").update({
      title: input.title, angle: input.angle, pillar: input.pillar, channel: input.channel, ...(input.channel && { channels: [input.channel] }),
      content_type: input.contentType, planned_for: input.plannedFor, cta: input.cta, notes: input.notes, status: input.status,
      ...(input.status && { status_note: null }), ...((input.plannedFor || input.channel) && { slot_key: null }),
    }).eq("id", t.id).select(TOPIC_COLUMNS).single());
    if (input.status === "approved") await wake(t.campaign_id);
    return c.json(row);
  });

  r.post("/brands/:brandId/campaigns/:campaignId/topics/bulk", can("campaign.update"), async (c) => {
    const input = await body(c, BulkSchema);
    const cmp = await campaign(c);
    const from = { approve: ["idea"], drop: ["idea", "approved", "failed", "blocked"], reset: ["failed", "blocked"] }[input.action];
    const to = { approve: "approved", drop: "dropped", reset: "approved" }[input.action];
    const rows = check(await c.get("db").from("campaign_topics").update({ status: to, status_note: null }).eq("campaign_id", cmp.id).in("id", input.ids).in("status", from).select("id"));
    if (to === "approved" && cmp.status === "active") await wake(cmp.id);
    return c.json({ updated: (rows as unknown[]).length });
  });

  r.delete("/brands/:brandId/topics/:topicId", can("campaign.update"), async (c) => {
    const t = await topic(c);
    if (t.status === "in_production") throw new AppError("conflict", "This topic is being generated.");
    ok(await c.get("db").from("campaign_topics").delete().eq("id", t.id));
    return c.body(null, 204);
  });

  /** Generate (or regenerate into the same content item) one topic right now. */
  r.post("/brands/:brandId/topics/:topicId/generate", can("content.create"), async (c) => {
    const key = idempotencyKey(c);
    const t = await topic(c);
    if (t.status === "in_production") throw new AppError("conflict", "Already generating.");
    if (t.status === "dropped") throw new AppError("conflict", "This topic was dropped.");
    const cmp = check(await c.get("db").from("campaigns").select("id, goal, brief, status").eq("id", t.campaign_id).single());
    if (cmp.status === "cancelled") throw new AppError("conflict", "The campaign was cancelled.");
    const b = check(await c.get("db").from("brands").select("languages").eq("id", brandId(c)).single());
    const gen = topicGenerationInput(t as never, cmp as never, ((b.languages as string[]) ?? ["en"])[0] ?? "en");
    if ("unsupported" in gen) throw new AppError("validation_failed", gen.unsupported);
    const ws = c.get("workspaceId");
    const res = await startCostedJob(deps, c, {
      idempotencyKey: key, kind: "generate.social_post", brandId: brandId(c), cost: estimateCredits({ kind: "generate.social_post" }),
      input: { ...gen.input, topicId: t.id, campaignId: t.campaign_id }, extra: { content_item_id: t.content_item_id },
      start: async (st, a) => {
        await deps.serviceDb().from("campaign_topics").update({ status: "in_production", generation_job_id: a.jobId, generation_count: t.generation_count + 1, status_note: null }).eq("id", t.id);
        return st.generateContent({ ...a, workspaceId: ws, brandId: brandId(c), templateKey: gen.templateKey, input: gen.input, topicId: t.id, campaignId: t.campaign_id, contentItemId: t.content_item_id ?? undefined, requestedBy: actor(c) ?? undefined });
      },
    }).catch(async (e) => {
      await deps.serviceDb().from("campaign_topics").update({ status: t.status }).eq("id", t.id).eq("status", "in_production");
      throw e;
    });
    return c.json({ job: res.job, credits: res.credits }, 202);
  });

  // ---- planner view -------------------------------------------------------
  r.get("/brands/:brandId/plan", can("campaign.read"), async (c) => {
    const q = parse(RangeSchema, c.req.query());
    const ws = c.get("workspaceId");
    const topics = check(await c.get("db").from("campaign_topics").select(`${TOPIC_COLUMNS}, campaign:campaigns(name, status)`).eq("workspace_id", ws).eq("brand_id", brandId(c))
      .gte("planned_for", q.from).lte("planned_for", q.to).neq("status", "dropped").order("planned_for").limit(2000));
    const strat = await c.get("db").from("strategies").select("id, plan, title").eq("brand_id", brandId(c)).eq("status", "active").maybeSingle();
    const weeks = ((strat.data?.plan as { weeks?: Array<{ weekStart: string; theme: string; focus: string }> } | null)?.weeks ?? []).filter((w) => w.weekStart >= q.from && w.weekStart <= q.to);
    const ev = check(await c.get("db").from("seasonal_events").select("name, on_date, region, kind, note").gte("on_date", q.from).lte("on_date", q.to));
    const moments: SeasonalMoment[] = mergeMoments(builtInMoments(q.from, q.to, ["IN", "IN-TG", "IN-AP"]),
      (ev as Array<{ name: string; on_date: string; region: string; kind: SeasonalMoment["kind"]; note: string | null }>).map((e) => ({ name: e.name, date: e.on_date, region: e.region, kind: e.kind, note: e.note ?? undefined })));
    return c.json({ topics, weeks, moments, strategy: strat.data ? { id: strat.data.id, title: strat.data.title } : null });
  });

  // ---- seasonal events ----------------------------------------------------
  r.get("/seasonal-events", can("campaign.read"), async (c) => {
    const q = parse(PaginationSchema.extend({ from: z.iso.date().optional(), to: z.iso.date().optional() }), c.req.query());
    let query = c.get("db").from("seasonal_events").select("id, workspace_id, name, on_date, region, kind, note").order("on_date").limit(500);
    if (q.from) query = query.gte("on_date", q.from);
    if (q.to) query = query.lte("on_date", q.to);
    return c.json({ data: check(await query) });
  });
  r.post("/seasonal-events", can("campaign.update"), async (c) => {
    const input = await body(c, SeasonalEventSchema);
    const row = check(await c.get("db").from("seasonal_events").insert({ workspace_id: c.get("workspaceId"), name: input.name, on_date: input.onDate, region: input.region, kind: input.kind, note: input.note ?? null, created_by: actor(c) }).select("*").single());
    return c.json(row, 201);
  });
  r.delete("/seasonal-events/:eventId", can("campaign.update"), async (c) => {
    ok(await c.get("db").from("seasonal_events").delete().eq("workspace_id", c.get("workspaceId")).eq("id", c.req.param("eventId")));
    return c.body(null, 204);
  });

  return r;
};
