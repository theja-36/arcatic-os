import {
  AppError, GenerateStrategySchema, OnboardingAnswersSchema, SaveStrategySchema, StrategyPlanSchema, WeeklyPlanRequestSchema, addDays,
  changedTopLevel, checkPlan, dayOfWeek, estimateCredits, fromDbError, nextMonday, weekStarts, type StrategyPlan,
} from "@arcatic/core";
import { Hono, type Context } from "hono";
import { body, check, idempotencyKey, parse } from "../http.js";
import { startCostedJob } from "../job-start.js";
import { requirePermission as can } from "../middleware/workspace.js";
import type { ApiDeps, AppEnv } from "../types.js";

const LIST = "id, title, status, starts_on, ends_on, revision, activated_at, created_at, updated_at, generation_job_id";

export const strategyRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  const actor = (c: Context<AppEnv>) => {
    const p = c.get("principal");
    return p.kind === "user" ? p.userId : null;
  };
  async function brand(c: Context<AppEnv>) {
    const res = await c.get("db").from("brands").select("id, active_kit_version_id").eq("workspace_id", c.get("workspaceId")).eq("id", c.req.param("brandId")!).is("deleted_at", null).maybeSingle();
    if (res.error) throw fromDbError(res.error);
    if (!res.data) throw new AppError("not_found", "Brand not found.");
    return res.data as { id: string; active_kit_version_id: string | null };
  }
  async function strategy(c: Context<AppEnv>) {
    const res = await c.get("db").from("strategies").select("*").eq("workspace_id", c.get("workspaceId")).eq("brand_id", c.req.param("brandId")!).eq("id", c.req.param("strategyId")!).maybeSingle();
    if (res.error) throw fromDbError(res.error);
    if (!res.data) throw new AppError("not_found", "Strategy not found.");
    return res.data as { id: string; status: string; revision: number; plan: StrategyPlan | null; starts_on: string; ends_on: string; title: string };
  }

  r.get("/brands/:brandId/strategies", can("campaign.read"), async (c) => {
    const b = await brand(c);
    const rows = check(await c.get("db").from("strategies").select(LIST).eq("workspace_id", c.get("workspaceId")).eq("brand_id", b.id).order("created_at", { ascending: false }).limit(50));
    return c.json({ data: rows });
  });

  /** Generate a strategy (async job). Dates and channels are decided here, not by the model. */
  r.post("/brands/:brandId/strategies", can("campaign.create"), async (c) => {
    const key = idempotencyKey(c);
    const input = await body(c, GenerateStrategySchema);
    const b = await brand(c);
    if (!b.active_kit_version_id) throw new AppError("validation_failed", "Approve a Brand Kit version before generating a strategy.");
    const ws = c.get("workspaceId");

    const prior = await deps.serviceDb().from("generation_jobs").select("id, kind, status, input").eq("workspace_id", ws).eq("idempotency_key", key).maybeSingle();
    if (prior.data) return c.json({ strategy: { id: (prior.data.input as { strategyId?: string }).strategyId }, job: prior.data }, 202);

    const tomorrow = addDays(new Date().toISOString().slice(0, 10), 1);
    const start = input.startsOn ? (dayOfWeek(input.startsOn) === 0 ? input.startsOn : nextMonday(input.startsOn)) : nextMonday(tomorrow);
    const weeks = weekStarts(start, input.weeks);
    const ob = await c.get("db").from("brand_onboarding").select("answers").eq("brand_id", b.id).maybeSingle();
    const answers = OnboardingAnswersSchema.safeParse(ob.data?.answers ?? {}).data ?? {};
    const channels = input.channels?.length ? input.channels : (answers.channels ?? []).filter((ch) => ch !== "website");
    if (!channels.length) throw new AppError("validation_failed", "Choose at least one channel.", { details: [{ path: "channels", message: "required" }] });

    const s = check(await deps.serviceDb().from("strategies").insert({
      workspace_id: ws, brand_id: b.id, title: input.title ?? `Plan ${weeks[0]} – ${addDays(weeks.at(-1)!, 6)}`, status: "generating",
      starts_on: weeks[0], ends_on: addDays(weeks.at(-1)!, 6), inputs: { ...input, channels }, created_by: actor(c),
    }).select(LIST).single());
    try {
      const res = await startCostedJob(deps, c, {
        idempotencyKey: key, kind: "strategy.generate", brandId: b.id, cost: estimateCredits({ kind: "strategy.generate" }),
        input: { strategyId: s.id, weeks: weeks.length },
        start: async (st, a) => {
          await deps.serviceDb().from("strategies").update({ generation_job_id: a.jobId }).eq("id", s.id);
          return st.strategy({ ...a, workspaceId: ws, brandId: b.id, strategyId: s.id, weekStarts: weeks, channels, goals: input.goals, constraints: input.constraints, focus: input.focus, requestedBy: actor(c) ?? undefined });
        },
      });
      return c.json({ strategy: s, job: res.job, credits: res.credits }, 202);
    } catch (e) {
      await deps.serviceDb().from("strategies").update({ status: "failed", validation: { error: e instanceof Error ? e.message : "could not start" } }).eq("id", s.id);
      throw e;
    }
  });

  r.get("/brands/:brandId/strategies/:strategyId", can("campaign.read"), async (c) => {
    const s = await strategy(c);
    const issues = s.plan ? checkPlan(StrategyPlanSchema.parse(s.plan), { startsOn: s.starts_on, endsOn: s.ends_on }) : [];
    return c.json({ ...s, issues });
  });

  /** Save an edited plan. Structure must be valid; cross-field problems block unless only pillar shares are off. */
  r.put("/brands/:brandId/strategies/:strategyId/plan", can("campaign.update"), async (c) => {
    const input = await body(c, SaveStrategySchema);
    const s = await strategy(c);
    const plan = parse(StrategyPlanSchema, input.plan);
    const issues = checkPlan(plan, { startsOn: s.starts_on, endsOn: s.ends_on });
    const blocking = issues.filter((i) => !i.startsWith("Pillar shares"));
    if (blocking.length) throw new AppError("validation_failed", "The plan has problems.", { details: blocking.map((m) => ({ path: "plan", message: m })) });
    if (input.title && input.title !== s.title) check(await deps.serviceDb().from("strategies").update({ title: input.title }).eq("id", s.id).select("id").single());
    const revision = check(await deps.serviceDb().rpc("save_strategy_plan", {
      p_strategy: s.id, p_base_revision: input.revision, p_plan: plan, p_origin: "human", p_changed: changedTopLevel(s.plan, plan), p_actor: actor(c),
    }));
    return c.json({ revision, warnings: issues });
  });

  r.get("/brands/:brandId/strategies/:strategyId/revisions", can("campaign.read"), async (c) => {
    const s = await strategy(c);
    const rows = check(await c.get("db").from("strategy_revisions").select("revision, origin, changed_paths, created_by, created_at").eq("strategy_id", s.id).order("revision", { ascending: false }).limit(100));
    return c.json({ data: rows });
  });

  r.get("/brands/:brandId/strategies/:strategyId/revisions/:revision", can("campaign.read"), async (c) => {
    const s = await strategy(c);
    const row = check(await c.get("db").from("strategy_revisions").select("revision, origin, plan, created_at").eq("strategy_id", s.id).eq("revision", Number(c.req.param("revision"))).single());
    return c.json(row);
  });

  /** Activate: becomes the brand's plan; its campaign briefs become campaign records (existing ones are kept as edited). */
  r.post("/brands/:brandId/strategies/:strategyId/activate", can("campaign.update"), async (c) => {
    const s = await strategy(c);
    if (!s.plan || s.status === "generating") throw new AppError("conflict", "The strategy isn't ready yet.");
    if (s.status === "archived") throw new AppError("conflict", "Archived strategies can't be activated.");
    const plan = StrategyPlanSchema.parse(s.plan);
    const blocking = checkPlan(plan, { startsOn: s.starts_on, endsOn: s.ends_on }).filter((i) => !i.startsWith("Pillar shares"));
    if (blocking.length) throw new AppError("validation_failed", "Fix the plan before activating.", { details: blocking.map((m) => ({ path: "plan", message: m })) });
    const svc = deps.serviceDb();
    const ws = c.get("workspaceId");
    if (s.status !== "active") {
      check(await svc.from("strategies").update({ status: "archived" }).eq("brand_id", c.req.param("brandId")!).eq("status", "active").select("id"));
      check(await svc.from("strategies").update({ status: "active", activated_at: new Date().toISOString(), activated_by: actor(c) }).eq("id", s.id).select("id").single());
    }
    const perWeek = Object.fromEntries(plan.channelMix.map((m) => [m.channel, { perWeek: m.postsPerWeek }]));
    let created = 0;
    let kept = 0;
    for (const pc of plan.campaigns) {
      const ins = await svc.from("campaigns").insert({
        workspace_id: ws, brand_id: c.req.param("brandId"), strategy_id: s.id, plan_key: pc.key, name: pc.name, goal: pc.goal || null,
        starts_on: pc.startsOn, ends_on: pc.endsOn, channels: pc.channels, content_types: pc.contentTypes, pillar: pc.pillar || null, status: "planned",
        frequency: Object.fromEntries(pc.channels.map((ch) => [ch, perWeek[ch] ?? { perWeek: 1 }])),
        brief: { theme: pc.theme, keyMessage: pc.keyMessage, offer: pc.offer, cta: pc.cta, audience: pc.audience, kpis: pc.kpis },
        generation_schedule: { mode: "scheduled", leadDays: 3, maxPerDay: 10 }, created_by: actor(c),
      });
      if (ins.error?.code === "23505") kept++;
      else if (ins.error) throw fromDbError(ins.error);
      else created++;
    }
    return c.json({ status: "active", campaigns: { created, kept } });
  });

  r.post("/brands/:brandId/strategies/:strategyId/archive", can("campaign.update"), async (c) => {
    const s = await strategy(c);
    if (s.status === "generating") throw new AppError("conflict", "Wait for generation to finish.");
    check(await deps.serviceDb().from("strategies").update({ status: "archived" }).eq("id", s.id).select("id").single());
    return c.json({ status: "archived" });
  });

  /** Weekly topic plan for 1–4 weeks (async job). */
  r.post("/brands/:brandId/strategies/:strategyId/weekly-plan", can("campaign.update"), async (c) => {
    const key = idempotencyKey(c);
    const input = await body(c, WeeklyPlanRequestSchema);
    const s = await strategy(c);
    if (!s.plan) throw new AppError("conflict", "The strategy has no plan yet.");
    if (dayOfWeek(input.weekStart) !== 0) throw new AppError("validation_failed", "weekStart must be a Monday.");
    const weeks = Array.from({ length: input.weeks }, (_, i) => addDays(input.weekStart, i * 7)).filter((w) => w >= s.starts_on && w <= s.ends_on);
    if (!weeks.length) throw new AppError("validation_failed", "Those weeks are outside the strategy period.");
    const ws = c.get("workspaceId");
    const brandId = c.req.param("brandId")!;
    const res = await startCostedJob(deps, c, {
      idempotencyKey: key, kind: "strategy.weekly_plan", brandId, cost: estimateCredits({ kind: "strategy.weekly_plan", quantity: weeks.length }),
      input: { strategyId: s.id, weeks, campaignId: input.campaignId ?? null },
      start: (st, a) => st.weeklyPlan({ ...a, workspaceId: ws, brandId, strategyId: s.id, weekStarts: weeks, autoApprove: input.autoApprove, campaignId: input.campaignId, requestedBy: actor(c) ?? undefined }),
    });
    return c.json({ job: res.job, credits: res.credits, weeks }, 202);
  });

  return r;
};
