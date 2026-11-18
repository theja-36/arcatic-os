import { ApplicationFailure, Context } from "@temporalio/activity";
import { generateStrategy, generateWeeklyTopics, type LlmProvider } from "@arcatic/ai";
import {
  AppError, OnboardingAnswersSchema, StrategyPlanSchema, allocateWeekSlots, builtInMoments, estimateCredits, fromDbError, maturityFromLabel,
  mergeMoments, regionsForLocation, topicGenerationInput, addDays, type BrandContext, type SeasonalMoment, type SlotCampaign, type StrategyPlan,
  GenerationScheduleSchema,
} from "@arcatic/core";
import { ledger, type Db } from "@arcatic/database";
import type { Embedder } from "@arcatic/integrations";
import type { CampaignRunnerInput, GenerateContentInput, StrategyInput, WeeklyPlanInput, WeeklyPlanResult } from "./contracts.js";
import { retrieveForGeneration } from "./retrieval.js";

export interface StrategyDeps {
  db: Db;
  llm: LlmProvider;
  embedder: Embedder | null;
  /** injectable clock for tests */
  now?: () => Date;
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw ApplicationFailure.create({ type: err.code, message: err.message, nonRetryable: !err.retryable });
    throw err;
  }
}

const today = (now: Date) => now.toISOString().slice(0, 10);

export function createStrategyActivities({ db, llm, embedder, now = () => new Date() }: StrategyDeps) {
  async function activeContext(workspaceId: string, brandId: string) {
    const b = await db.from("brands").select("id, active_kit_version_id").eq("workspace_id", workspaceId).eq("id", brandId).single();
    if (b.error) throw fromDbError(b.error);
    if (!b.data.active_kit_version_id) throw new AppError("validation_failed", "Approve a Brand Kit version before planning.");
    const c = await db.from("brand_contexts").select("context").eq("kit_version_id", b.data.active_kit_version_id).single();
    if (c.error) throw fromDbError(c.error);
    return { brand: c.data.context as BrandContext, kitVersionId: b.data.active_kit_version_id as string };
  }

  async function moments(workspaceId: string, from: string, to: string, location?: string): Promise<SeasonalMoment[]> {
    const regions = regionsForLocation(location);
    const rows = await db.from("seasonal_events").select("name, on_date, region, kind, note").or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`).gte("on_date", from).lte("on_date", to);
    if (rows.error) throw fromDbError(rows.error);
    const fromDb = (rows.data ?? []).filter((r) => r.region === "IN" || regions.includes(r.region as string) || !String(r.region).startsWith("IN"))
      .map((r) => ({ name: r.name as string, date: r.on_date as string, region: r.region as string, kind: r.kind as SeasonalMoment["kind"], note: (r.note as string) ?? undefined }));
    return mergeMoments(builtInMoments(from, to, regions), fromDb);
  }

  async function loadStrategy(workspaceId: string, id: string) {
    const s = await db.from("strategies").select("*").eq("workspace_id", workspaceId).eq("id", id).single();
    if (s.error) throw fromDbError(s.error);
    return s.data as { id: string; status: string; plan: unknown; revision: number; starts_on: string; ends_on: string; generation_job_id: string | null; brand_id: string };
  }

  return {
    /** 90-day strategy draft → saved as revision N+1 with provenance and the deterministic fixes applied. */
    async generateStrategyDraft(input: StrategyInput) {
      return wrap(async () => {
        const s = await loadStrategy(input.workspaceId, input.strategyId);
        if (s.plan && s.generation_job_id === input.jobId) return { revision: s.revision, notes: [] as string[] };   // idempotent retry
        const { brand, kitVersionId } = await activeContext(input.workspaceId, input.brandId);
        const ob = await db.from("brand_onboarding").select("answers").eq("brand_id", input.brandId).maybeSingle();
        const answers = OnboardingAnswersSchema.safeParse(ob.data?.answers ?? {}).data ?? {};
        const kitMaturity = (brand.data as unknown as { maturity?: string }).maturity;
        const maturity = maturityFromLabel(answers.maturity ?? kitMaturity);
        const from = input.weekStarts[0]!;
        const to = addDays(input.weekStarts.at(-1)!, 6);
        const ac = new AbortController();
        Context.current().cancelled.catch(() => ac.abort());
        const knowledge = await retrieveForGeneration(db, embedder, {
          brandId: input.brandId, query: "products services offers prices customers locations reviews", requestedBy: input.requestedBy, limit: 8, signal: ac.signal,
        });
        Context.current().heartbeat();
        const r = await generateStrategy(llm, {
          brand, weekStarts: input.weekStarts, channels: input.channels, maturity, moments: await moments(input.workspaceId, from, to, answers.location ?? brand.data.location),
          knowledge: knowledge.map((k) => ({ chunkId: k.chunkId, content: k.content, url: k.url })),
          goals: input.goals?.length ? input.goals : answers.goals, constraints: input.constraints, focus: input.focus,
        }, { workspaceId: input.workspaceId, jobId: input.jobId, signal: ac.signal });

        const upd = await db.from("strategies").update({
          plan: r.plan, revision: s.revision + 1, status: "draft", validation: { notes: r.notes }, model: r.model, prompt_template: r.template,
          source_chunk_ids: r.sourceChunkIds, brand_kit_version_id: kitVersionId,
        }).eq("id", s.id).eq("revision", s.revision).select("revision").single();
        if (upd.error) throw fromDbError(upd.error);
        const rev = await db.from("strategy_revisions").insert({ strategy_id: s.id, revision: s.revision + 1, origin: "ai", plan: r.plan, changed_paths: Object.keys(r.plan), created_by: input.requestedBy ?? null });
        if (rev.error && rev.error.code !== "23505") throw fromDbError(rev.error);
        return { revision: s.revision + 1, notes: r.notes };
      });
    },

    async markStrategyFailed(input: StrategyInput, message: string) {
      return wrap(async () => {
        const r = await db.from("strategies").update({ status: "failed", validation: { error: message.slice(0, 500) } }).eq("id", input.strategyId).eq("status", "generating");
        if (r.error) throw fromDbError(r.error);
      });
    },

    /** Allocate slots for one week, have the model write topics, insert them (idempotent per slot). */
    async planWeek(input: WeeklyPlanInput, weekStart: string): Promise<WeeklyPlanResult> {
      return wrap(async () => {
        const s = await loadStrategy(input.workspaceId, input.strategyId);
        const plan: StrategyPlan = StrategyPlanSchema.parse(s.plan);
        const { brand } = await activeContext(input.workspaceId, input.brandId);
        const weekEnd = addDays(weekStart, 6);

        // the strategy's always-on campaign catches slots no themed campaign covers
        let always = await db.from("campaigns").select("id").eq("strategy_id", s.id).eq("plan_key", "__always_on").maybeSingle();
        if (!always.data) {
          always = await db.from("campaigns").insert({
            workspace_id: input.workspaceId, brand_id: input.brandId, strategy_id: s.id, plan_key: "__always_on", name: "Always-on content",
            status: "planned", starts_on: s.starts_on, ends_on: s.ends_on, channels: plan.channelMix.map((m) => m.channel),
            content_types: [...new Set(plan.channelMix.flatMap((m) => m.contentTypes))], brief: { theme: "Evergreen pillar content", keyMessage: plan.positioning, offer: "", cta: "", audience: "", kpis: [] },
          }).select("id").single();
          if (always.error && always.error.code === "23505") always = await db.from("campaigns").select("id").eq("strategy_id", s.id).eq("plan_key", "__always_on").single();
          if (always.error) throw fromDbError(always.error);
        }
        const alwaysId = always.data!.id as string;

        const camps = await db.from("campaigns").select("id, plan_key, name, starts_on, ends_on, channels, content_types, brief, goal, status")
          .eq("workspace_id", input.workspaceId).eq("brand_id", input.brandId).in("status", ["planned", "active", "paused"])
          .or(`starts_on.is.null,starts_on.lte.${weekEnd}`).or(`ends_on.is.null,ends_on.gte.${weekStart}`);
        if (camps.error) throw fromDbError(camps.error);
        const rows = (camps.data ?? []) as Array<{ id: string; plan_key: string | null; name: string; starts_on: string | null; ends_on: string | null; channels: string[]; content_types: string[]; brief: { theme?: string; keyMessage?: string } }>;
        const themed: SlotCampaign[] = rows.filter((c) => c.id !== alwaysId).map((c) => ({ id: c.id, key: c.plan_key ?? undefined, name: c.name, startsOn: c.starts_on, endsOn: c.ends_on, channels: c.channels, contentTypes: c.content_types }));

        const existing = await db.from("campaign_topics").select("slot_key").eq("brand_id", input.brandId).gte("planned_for", weekStart).lte("planned_for", weekEnd).neq("status", "dropped").not("slot_key", "is", null);
        if (existing.error) throw fromDbError(existing.error);
        let slots = allocateWeekSlots({ weekStart, channelMix: plan.channelMix, campaigns: themed, fallbackCampaignId: alwaysId, existingSlotKeys: new Set((existing.data ?? []).map((r) => r.slot_key as string)) });
        if (input.campaignId) slots = slots.filter((x) => x.campaignId === input.campaignId);
        const skippedExisting = existing.data?.length ?? 0;
        if (!slots.length) return { created: 0, flagged: 0, unfilled: 0, skippedExisting };

        const byId = new Map(rows.map((c) => [c.id, c]));
        const recent = await db.from("campaign_topics").select("title").eq("brand_id", input.brandId).order("created_at", { ascending: false }).limit(40);
        const week = plan.weeks.find((w) => w.weekStart === weekStart);
        const knowledge = await retrieveForGeneration(db, embedder, { brandId: input.brandId, query: [week?.theme, week?.focus, ...themed.map((c) => c.name)].filter(Boolean).join(". "), requestedBy: input.requestedBy, limit: 6 });
        const res = await generateWeeklyTopics(llm, {
          brand, plan, weekStart, recentTitles: (recent.data ?? []).map((r) => r.title as string), knowledge: knowledge.map((k) => ({ chunkId: k.chunkId, content: k.content, url: k.url })),
          slots: slots.map((x) => {
            const c = byId.get(x.campaignId);
            return { ...x, campaignName: c?.name ?? "Always-on content", campaignBrief: [c?.brief?.theme, c?.brief?.keyMessage].filter(Boolean).join(" — ").slice(0, 300) };
          }),
        }, { workspaceId: input.workspaceId, jobId: input.jobId, signal: Context.current().cancellationSignal });

        let created = 0;
        let flagged = 0;
        const slotByKey = new Map(slots.map((x) => [x.slotKey, x]));
        for (const t of res.topics) {
          const slot = slotByKey.get(t.slotKey)!;
          const ins = await db.from("campaign_topics").insert({
            campaign_id: slot.campaignId, strategy_id: s.id, title: t.title, angle: t.angle, pillar: t.pillar || null, cta: t.cta || null, notes: t.notes || null,
            channel: slot.channel, content_type: slot.contentType, planned_for: slot.date, slot_key: slot.slotKey, origin: "ai",
            status: input.autoApprove && !t.flagged.length ? "approved" : "idea", status_note: t.flagged.join("; ") || null, channels: [slot.channel],
          });
          if (ins.error?.code === "23505") continue;
          if (ins.error) throw fromDbError(ins.error);
          created++;
          if (t.flagged.length) flagged++;
          Context.current().heartbeat({ created });
        }
        return { created, flagged, unfilled: res.unfilled.length, skippedExisting };
      });
    },

    // ---------------------------------------------------------------- campaign runner
    /** What should the runner do now? Reads the DB as the source of truth for status. */
    async runnerTick(input: CampaignRunnerInput): Promise<{ stop: boolean; paused: boolean; finished: boolean; due: string[]; nextDueAt: string | null }> {
      return wrap(async () => {
        const c = await db.from("campaigns").select("id, status, starts_on, ends_on, generation_schedule").eq("workspace_id", input.workspaceId).eq("id", input.campaignId).single();
        if (c.error) throw fromDbError(c.error);
        const status = c.data.status as string;
        if (status === "cancelled" || status === "completed") return { stop: true, paused: false, finished: false, due: [], nextDueAt: null };
        if (status === "paused") return { stop: false, paused: true, finished: false, due: [], nextDueAt: null };
        const sched = GenerationScheduleSchema.parse(c.data.generation_schedule ?? {});
        const t = now();
        const todayISO = today(t);

        const pending = await db.from("campaign_topics").select("id, planned_for, status").eq("campaign_id", input.campaignId).in("status", ["approved", "in_production"]).order("planned_for").limit(500);
        if (pending.error) throw fromDbError(pending.error);
        const approved = (pending.data ?? []).filter((x) => x.status === "approved");
        const ended = c.data.ends_on && (c.data.ends_on as string) < todayISO;
        if (ended && (pending.data ?? []).length === 0) return { stop: false, paused: false, finished: true, due: [], nextDueAt: null };
        if (sched.mode === "manual") return { stop: false, paused: false, finished: false, due: [], nextDueAt: null };

        const dueDate = (planned: string | null) => (planned ? addDays(planned, -sched.leadDays) : todayISO);
        const isDue = (x: { planned_for: string | null }) => sched.mode === "immediate" || dueDate(x.planned_for) <= todayISO;
        const doneToday = await db.from("generation_jobs").select("id", { count: "exact", head: true }).eq("workspace_id", input.workspaceId)
          .contains("input", { campaignId: input.campaignId }).gte("created_at", `${todayISO}T00:00:00Z`);
        const budget = Math.max(0, sched.maxPerDay - (doneToday.count ?? 0));
        const due = approved.filter(isDue).slice(0, Math.min(5, budget)).map((x) => x.id as string);
        const later = approved.filter((x) => !isDue(x)).map((x) => dueDate(x.planned_for as string)).sort()[0];
        // over today's budget → check again tomorrow
        const nextDueAt = later ? `${later}T03:30:00Z` : budget === 0 && approved.some(isDue) ? `${addDays(todayISO, 1)}T03:30:00Z` : null;
        return { stop: false, paused: false, finished: false, due, nextDueAt };
      });
    },

    /**
     * Reserve credits and create the job for one topic (idempotent per generation attempt).
     * Returns null when the topic can't be generated (unsupported or no credits) after marking why.
     */
    async reserveTopicGeneration(input: CampaignRunnerInput, topicId: string): Promise<{ jobId: string; input: GenerateContentInput } | null> {
      return wrap(async () => {
        const t = await db.from("campaign_topics").select("id, title, angle, channel, content_type, cta, notes, status, generation_count, generation_job_id, content_item_id").eq("id", topicId).eq("campaign_id", input.campaignId).single();
        if (t.error) throw fromDbError(t.error);
        const topic = t.data;
        if (topic.status === "in_production" && topic.generation_job_id) {
          const j = await db.from("generation_jobs").select("id, input, status").eq("id", topic.generation_job_id).single();
          if (j.data && !["failed", "cancelled"].includes(j.data.status as string)) return { jobId: j.data.id as string, input: (j.data.input as { __runner: GenerateContentInput }).__runner };
        }
        if (topic.status !== "approved" && topic.status !== "in_production") return null;
        const camp = await db.from("campaigns").select("goal, brief").eq("id", input.campaignId).single();
        const brand = await db.from("brands").select("languages").eq("id", input.brandId).single();
        const lang = ((brand.data?.languages as string[]) ?? ["en"])[0] ?? "en";
        const gen = topicGenerationInput(topic as never, (camp.data ?? {}) as never, lang);
        if ("unsupported" in gen) {
          await db.from("campaign_topics").update({ status: "blocked", status_note: gen.unsupported }).eq("id", topicId);
          return null;
        }
        const attempt = (topic.generation_count as number) + 1;
        const key = `topicgen:${topicId}:${attempt}`;
        const cost = estimateCredits({ kind: "generate.social_post" });
        const jobId = crypto.randomUUID();
        let reservation;
        try {
          reservation = await ledger.reserve(db, { workspaceId: input.workspaceId, amount: cost.max, idempotencyKey: key, jobId, reason: "campaign topic" });
        } catch (e) {
          if (e instanceof AppError && e.code === "insufficient_credits") {
            await db.from("campaign_topics").update({ status: "blocked", status_note: "Not enough credits. Top up, then resume the campaign." }).eq("id", topicId);
            return null;
          }
          throw e;
        }
        const runnerInput: GenerateContentInput = {
          jobId, workspaceId: input.workspaceId, brandId: input.brandId, templateKey: gen.templateKey, input: gen.input,
          reservationId: reservation.id, chargeCredits: cost.estimate, topicId, campaignId: input.campaignId,
        };
        const job = await db.from("generation_jobs").insert({
          id: jobId, workspace_id: input.workspaceId, brand_id: input.brandId, kind: "generate.social_post", idempotency_key: key,
          input: { ...gen.input, campaignId: input.campaignId, topicId, __runner: runnerInput }, credit_reservation_id: reservation.id, estimated_credits: cost.estimate,
        }).select("id, input").single();
        if (job.error?.code === "23505") {
          const prev = await db.from("generation_jobs").select("id, input").eq("workspace_id", input.workspaceId).eq("idempotency_key", key).single();
          return { jobId: prev.data!.id as string, input: (prev.data!.input as { __runner: GenerateContentInput }).__runner };
        }
        if (job.error) throw fromDbError(job.error);
        await db.from("campaign_topics").update({ status: "in_production", generation_job_id: jobId, generation_count: attempt, status_note: null }).eq("id", topicId);
        return { jobId, input: runnerInput };
      });
    },

    async markTopicFailed(topicId: string, message: string) {
      return wrap(async () => {
        const r = await db.from("campaign_topics").update({ status: "failed", status_note: message.slice(0, 500) }).eq("id", topicId).eq("status", "in_production");
        if (r.error) throw fromDbError(r.error);
      });
    },

    async recordRunnerEvent(input: CampaignRunnerInput, event: { message: string; nextCheckAt: string | null; generated: number }) {
      return wrap(async () => {
        const r = await db.from("campaigns").update({ last_runner_event: { ...event, at: now().toISOString() }, next_generation_at: event.nextCheckAt }).eq("id", input.campaignId);
        if (r.error) throw fromDbError(r.error);
      });
    },

    async completeCampaign(input: CampaignRunnerInput) {
      return wrap(async () => {
        const r = await db.from("campaigns").update({ status: "completed" }).eq("id", input.campaignId).in("status", ["active"]);
        if (r.error) throw fromDbError(r.error);
      });
    },
  };
}

export type StrategyActivities = ReturnType<typeof createStrategyActivities>;

