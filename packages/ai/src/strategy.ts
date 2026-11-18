import {
  CONTENT_TYPES, WEEKLY_CAPACITY, addDays, dayOfWeek, findTerm, normalizeDraft, type BrandContext, type Maturity, type PlanContext,
  type SeasonalMoment, type Slot, type StrategyDraft, type StrategyPlan,
} from "@arcatic/core";
import { z } from "zod";
import { resolveModel } from "./models.js";
import type { GenerateUsage, LlmProvider } from "./provider.js";
import { renderSystem, renderUser, type KnowledgeSnippet } from "./templates.js";

// ---------------------------------------------------------------------------
// 90-day strategy
// ---------------------------------------------------------------------------
const S = z.string();
const L = z.array(z.string());
export const StrategyDraftSchema = z.object({
  summary: S,
  positioning: S,
  goals: z.array(z.object({ goal: S, metric: S, target: S, timeframe: S })),
  audiences: z.array(z.object({ name: S, insight: S, message: S })),
  pillars: z.array(z.object({ name: S, description: S, share: z.number(), example_topics: L })),
  channel_mix: z.array(z.object({ channel: S, role: S, posts_per_week: z.number(), content_types: L })),
  offers: z.array(z.object({ offer: S, cta: S, timing: S })),
  campaigns: z.array(z.object({
    name: S, theme: S, goal: S, start_week: z.number(), end_week: z.number(), audience: S, key_message: S, offer: S, cta: S,
    channels: L, content_types: L, pillar: S, kpis: L,
  })),
  weeks: z.array(z.object({ week: z.number(), theme: S, focus: S, pillars: L, campaigns: L })),
  metrics: z.array(z.object({ metric: S, target: S, how_measured: S })),
  assumptions: L,
  moments_used: L,
});

export const STRATEGY_TEMPLATE = "strategy.90day@1";

export interface StrategyRequest {
  brand: BrandContext;
  weekStarts: string[];
  channels: string[];
  maturity: Maturity;
  moments: SeasonalMoment[];
  knowledge: KnowledgeSnippet[];
  goals?: string[];
  constraints?: string;
  focus?: string;
}

export function renderStrategyTask(r: StrategyRequest): string {
  const weeks = r.weekStarts.map((w, i) => `Week ${i + 1}: ${w} to ${addDays(w, 6)}`).join("\n");
  const moments = r.moments.length ? r.moments.map((m) => `- ${m.name} (${m.date})${m.note ? ` — ${m.note}` : ""}`).join("\n") : "- none provided";
  return [
    `Create a ${r.weekStarts.length}-week marketing strategy for this brand.`,
    "",
    "Period (use these week numbers; never invent dates):",
    weeks,
    "",
    `Channels to use (only these): ${r.channels.join(", ")}`,
    `Team capacity: at most ${WEEKLY_CAPACITY[r.maturity]} posts per week in total across all channels (marketing maturity: ${r.maturity}). Plan less if quality would suffer.`,
    `Content types available: ${CONTENT_TYPES.join(", ")}.`,
    r.goals?.length ? `Goals from the owner: ${r.goals.join("; ")}` : "",
    r.constraints ? `Constraints: ${r.constraints}` : "",
    r.focus ? `Extra direction: ${r.focus}` : "",
    "",
    "Seasonal moments in this period (refer to them only by these exact names in moments_used; do not add others):",
    moments,
    "",
    "Rules:",
    "- 3 to 5 content pillars whose shares add up to 100.",
    "- 1 to 6 campaigns, each with start_week/end_week from the list above; tie campaigns to real offers and moments.",
    "- One entry in weeks for every week number, each with a theme and focus; list campaign names running that week.",
    "- Goals and metrics must be measurable; targets should be realistic for a small business at this maturity.",
    "- Only use facts from the brand context and knowledge; don't invent prices, awards or statistics.",
    "- assumptions: what must be true for this plan to work (e.g. who shoots videos).",
  ].filter((x) => x !== "").join("\n");
}

export async function generateStrategy(
  provider: LlmProvider,
  r: StrategyRequest,
  meta: { workspaceId: string; jobId?: string; signal?: AbortSignal },
): Promise<{ plan: StrategyPlan; notes: string[]; model: string; usage: GenerateUsage; template: string; sourceChunkIds: string[] }> {
  const choice = resolveModel("premium");
  const res = await provider.generateStructured({
    model: choice.model,
    effort: choice.effort,
    system: renderSystem(r.brand),
    user: renderUser(renderStrategyTask(r), r.knowledge),
    schema: StrategyDraftSchema,
    maxTokens: 16000,
    metadata: { workspaceId: meta.workspaceId, jobId: meta.jobId, template: STRATEGY_TEMPLATE },
    signal: meta.signal,
  });
  const ctx: PlanContext = { weekStarts: r.weekStarts, channels: r.channels, maturity: r.maturity, moments: r.moments };
  const { plan, notes } = normalizeDraft(res.output as StrategyDraft, ctx);
  return { plan, notes, model: res.model, usage: res.usage, template: STRATEGY_TEMPLATE, sourceChunkIds: r.knowledge.map((k) => k.chunkId) };
}

// ---------------------------------------------------------------------------
// Weekly plan: fill pre-allocated slots with topics
// ---------------------------------------------------------------------------
export const TopicFillSchema = z.object({
  topics: z.array(z.object({ slot_key: S, title: S, angle: S, pillar: S, cta: S, notes: S })),
});
export const WEEKLY_PLAN_TEMPLATE = "strategy.weekly_topics@1";

export interface SlotContext extends Slot {
  campaignName: string;
  campaignBrief: string;
}

export interface WeeklyPlanRequest {
  brand: BrandContext;
  plan: StrategyPlan;
  weekStart: string;
  slots: SlotContext[];
  recentTitles: string[];
  knowledge: KnowledgeSnippet[];
}

const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function renderWeeklyTask(r: WeeklyPlanRequest): string {
  const week = r.plan.weeks.find((w) => w.weekStart === r.weekStart);
  const moments = r.plan.moments.filter((m) => m.date >= r.weekStart && m.date <= addDays(r.weekStart, 6));
  return [
    `Write one content topic for each slot in the week of ${r.weekStart}.`,
    week ? `Week theme: ${week.theme}. Focus: ${week.focus}` : "",
    moments.length ? `Seasonal moments this week: ${moments.map((m) => `${m.name} (${m.date})`).join(", ")}` : "",
    `Content pillars (aim for these shares over time): ${r.plan.pillars.map((p) => `${p.name} ${p.share}%`).join(", ")}`,
    "",
    "Slots (return exactly one topic per slot_key):",
    ...r.slots.map((s) => `- ${s.slotKey} | ${WEEKDAY[dayOfWeek(s.date)]} ${s.date} | ${s.channel} | ${s.contentType} | campaign: ${s.campaignName}${s.campaignBrief ? ` — ${s.campaignBrief}` : ""}`),
    "",
    r.recentTitles.length ? `Recent topics (don't repeat them):\n${r.recentTitles.slice(0, 40).map((t) => `- ${t}`).join("\n")}` : "",
    "",
    "Each topic: a specific title (not generic), the angle (what the post says and why it matters to the audience), the pillar name, a CTA that fits the channel, and production notes (what to shoot or show).",
    "Only use facts from the brand context and knowledge; never invent prices or claims.",
  ].filter((x) => x !== "").join("\n");
}

export interface FilledTopic {
  slotKey: string;
  title: string;
  angle: string;
  pillar: string;
  cta: string;
  notes: string;
  flagged: string[];   // e.g. banned words found → never auto-approved
}

/** Deterministic post-check: one topic per known slot, banned words flagged. */
export function fillSlots(out: z.infer<typeof TopicFillSchema>, slots: readonly Slot[], bannedWords: readonly string[]): { topics: FilledTopic[]; unfilled: string[] } {
  const known = new Set(slots.map((s) => s.slotKey));
  const seen = new Set<string>();
  const topics: FilledTopic[] = [];
  for (const t of out.topics) {
    if (!known.has(t.slot_key) || seen.has(t.slot_key) || !t.title.trim()) continue;
    seen.add(t.slot_key);
    const text = `${t.title}\n${t.angle}\n${t.cta}`;
    const flagged = bannedWords.filter((w) => findTerm(text, w).length > 0).map((w) => `Contains banned word "${w}"`);
    topics.push({ slotKey: t.slot_key, title: t.title.trim().slice(0, 300), angle: t.angle.trim().slice(0, 2000), pillar: t.pillar.trim().slice(0, 300), cta: t.cta.trim().slice(0, 300), notes: t.notes.trim().slice(0, 2000), flagged });
  }
  return { topics, unfilled: slots.map((s) => s.slotKey).filter((k) => !seen.has(k)) };
}

export async function generateWeeklyTopics(
  provider: LlmProvider,
  r: WeeklyPlanRequest,
  meta: { workspaceId: string; jobId?: string; signal?: AbortSignal },
) {
  if (!r.slots.length) return { topics: [] as FilledTopic[], unfilled: [] as string[], model: null as string | null, usage: null as GenerateUsage | null };
  const choice = resolveModel("standard");
  const res = await provider.generateStructured({
    model: choice.model, effort: choice.effort, system: renderSystem(r.brand), user: renderUser(renderWeeklyTask(r), r.knowledge),
    schema: TopicFillSchema, maxTokens: 12000, metadata: { workspaceId: meta.workspaceId, jobId: meta.jobId, template: WEEKLY_PLAN_TEMPLATE }, signal: meta.signal,
  });
  return { ...fillSlots(res.output, r.slots, r.brand.data.vocabulary.banned), model: res.model, usage: res.usage };
}
