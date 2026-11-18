import { z } from "zod";
import { addDays, clampDate, isISODate } from "./dates.js";
import type { SeasonalMoment } from "./seasonality.js";
import { CONTENT_TYPE_DEFS } from "../content/types.js";

export const CONTENT_TYPES = ["social_post", "carousel", "short_video", "story", "email", "blog", "ad", "live"] as const;
export type PlanContentType = (typeof CONTENT_TYPES)[number];

/** Planning format → generation template (via the content type registry). "live" is planned only. */
export const templateForContentType = (t: string): string | null =>
  t in CONTENT_TYPE_DEFS ? CONTENT_TYPE_DEFS[t as keyof typeof CONTENT_TYPE_DEFS].template : null;

/** Weekly posting capacity by marketing maturity (all channels together). */
export const WEEKLY_CAPACITY = { starting: 5, occasional: 8, consistent: 15, advanced: 30 } as const;
export type Maturity = keyof typeof WEEKLY_CAPACITY;
export const maturityFromLabel = (label: string | undefined): Maturity => {
  const l = (label ?? "").toLowerCase();
  if (l.includes("just starting") || l === "starting") return "starting";
  if (l.includes("occasional") || l.includes("now and then")) return "occasional";
  if (l.includes("planned multi-channel") || l.includes("advanced") || l.includes("campaign")) return "advanced";
  return "consistent";
};

const str = z.string().max(2000);
const shortStr = z.string().max(300);

/** The stored, user-editable plan. Every field here is editable in the UI. */
export const StrategyPlanSchema = z.object({
  version: z.literal(1).default(1),
  summary: str,
  positioning: str,
  goals: z.array(z.object({ id: z.string(), goal: shortStr, metric: shortStr, target: shortStr, timeframe: shortStr })).max(8),
  audiences: z.array(z.object({ id: z.string(), name: shortStr, insight: str, message: str })).max(6),
  pillars: z.array(z.object({ id: z.string(), name: shortStr, description: str, share: z.number().min(0).max(100), exampleTopics: z.array(shortStr).max(10) })).max(6),
  channelMix: z.array(z.object({ channel: z.string().max(40), role: shortStr, postsPerWeek: z.number().int().min(0).max(50), contentTypes: z.array(z.enum(CONTENT_TYPES)).max(8) })).max(13),
  offers: z.array(z.object({ id: z.string(), offer: shortStr, cta: shortStr, timing: shortStr })).max(10),
  campaigns: z.array(z.object({
    key: z.string().regex(/^[a-z0-9-]{1,60}$/), name: shortStr, theme: str, goal: shortStr, startsOn: z.string(), endsOn: z.string(),
    audience: shortStr, keyMessage: str, offer: shortStr, cta: shortStr, channels: z.array(z.string().max(40)).max(13),
    contentTypes: z.array(z.enum(CONTENT_TYPES)).max(8), pillar: shortStr, kpis: z.array(shortStr).max(6),
  })).max(6),
  weeks: z.array(z.object({ weekStart: z.string(), theme: shortStr, focus: str, pillars: z.array(shortStr).max(6), campaigns: z.array(z.string()).max(6) })).max(26),
  metrics: z.array(z.object({ metric: shortStr, target: shortStr, howMeasured: shortStr })).max(10),
  assumptions: z.array(shortStr).max(10),
  moments: z.array(z.object({ name: shortStr, date: z.string() })).max(40),
});
export type StrategyPlan = z.infer<typeof StrategyPlanSchema>;

/** Raw model draft (see packages/ai/src/strategy.ts): all fields required, weeks referenced by index. */
export interface StrategyDraft {
  summary: string;
  positioning: string;
  goals: Array<{ goal: string; metric: string; target: string; timeframe: string }>;
  audiences: Array<{ name: string; insight: string; message: string }>;
  pillars: Array<{ name: string; description: string; share: number; example_topics: string[] }>;
  channel_mix: Array<{ channel: string; role: string; posts_per_week: number; content_types: string[] }>;
  offers: Array<{ offer: string; cta: string; timing: string }>;
  campaigns: Array<{ name: string; theme: string; goal: string; start_week: number; end_week: number; audience: string; key_message: string; offer: string; cta: string; channels: string[]; content_types: string[]; pillar: string; kpis: string[] }>;
  weeks: Array<{ week: number; theme: string; focus: string; pillars: string[]; campaigns: string[] }>;
  metrics: Array<{ metric: string; target: string; how_measured: string }>;
  assumptions: string[];
  moments_used: string[];
}

export interface PlanContext {
  weekStarts: string[];       // computed Mondays
  channels: string[];         // allowed channels
  maturity: Maturity;
  moments: SeasonalMoment[];
}

export const slugKey = (s: string) => s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "campaign";

/**
 * Turn a model draft into a valid plan, applying deterministic fixes and recording each one.
 * The model never decides dates or capacity: weeks come from `weekStarts`, posting volume is
 * capped by maturity, unknown channels/campaigns/content types are dropped.
 */
export function normalizeDraft(d: StrategyDraft, ctx: PlanContext): { plan: StrategyPlan; notes: string[] } {
  const notes: string[] = [];
  const startsOn = ctx.weekStarts[0]!;
  const endsOn = addDays(ctx.weekStarts.at(-1)!, 6);
  const allowed = new Set(ctx.channels);
  const ctSet = new Set<string>(CONTENT_TYPES);
  const id = (prefix: string, i: number) => `${prefix}-${i + 1}`;

  // pillars: 3–6, shares sum to 100
  let pillars = d.pillars.filter((p) => p.name.trim()).slice(0, 6);
  if (d.pillars.length > 6) notes.push(`Kept the first 6 of ${d.pillars.length} content pillars.`);
  if (pillars.length && pillars.length < 3) notes.push("Fewer than 3 content pillars; consider adding more variety.");
  const total = pillars.reduce((s, p) => s + Math.max(0, p.share || 0), 0);
  let shares = pillars.map((p) => (total > 0 ? (Math.max(0, p.share || 0) / total) * 100 : 100 / Math.max(1, pillars.length)));
  shares = shares.map((s) => Math.round(s));
  if (shares.length) shares[shares.length - 1]! += 100 - shares.reduce((a, b) => a + b, 0);
  if (total > 0 && Math.abs(total - 100) > 1) notes.push(`Pillar shares added up to ${Math.round(total)}%; scaled to 100%.`);

  // channel mix: allowed channels only, capacity by maturity
  let mix = d.channel_mix.filter((m) => {
    if (allowed.has(m.channel)) return true;
    notes.push(`Dropped channel "${m.channel}" (not one of the selected channels).`);
    return false;
  }).map((m) => ({
    channel: m.channel, role: m.role.slice(0, 300), postsPerWeek: Math.max(0, Math.min(50, Math.round(m.posts_per_week || 0))),
    contentTypes: [...new Set(m.content_types.filter((t) => ctSet.has(t)))] as StrategyPlan["channelMix"][number]["contentTypes"],
  }));
  mix = [...new Map(mix.map((m) => [m.channel, m])).values()];
  for (const m of mix) if (!m.contentTypes.length) m.contentTypes = ["social_post"];
  const cap = WEEKLY_CAPACITY[ctx.maturity];
  const planned = mix.reduce((s, m) => s + m.postsPerWeek, 0);
  if (planned > cap) {
    const scaled = mix.map((m) => Math.floor((m.postsPerWeek * cap) / planned));
    let left = cap - scaled.reduce((a, b) => a + b, 0);
    const order = mix.map((m, i) => ({ i, frac: (m.postsPerWeek * cap) / planned - scaled[i]! })).sort((a, b) => b.frac - a.frac);
    for (const o of order) if (left-- > 0) scaled[o.i]!++;
    mix.forEach((m, i) => (m.postsPerWeek = scaled[i]!));
    notes.push(`Reduced posting from ${planned} to ${cap} posts a week to match your current capacity (${ctx.maturity}).`);
  }

  // campaigns: ≤6, week indices → clamped dates, unique keys, allowed channels
  const usedKeys = new Set<string>();
  const campaigns = d.campaigns.slice(0, 6).map((c) => {
    let key = slugKey(c.name);
    for (let n = 2; usedKeys.has(key); n++) key = `${slugKey(c.name).slice(0, 56)}-${n}`;
    usedKeys.add(key);
    const w = (i: number) => Math.max(1, Math.min(ctx.weekStarts.length, Math.round(i || 1)));
    const sw = w(c.start_week);
    const ew = Math.max(sw, w(c.end_week));
    const channels = c.channels.filter((ch) => allowed.has(ch));
    return {
      key, name: c.name.slice(0, 300), theme: c.theme, goal: c.goal.slice(0, 300),
      startsOn: ctx.weekStarts[sw - 1]!, endsOn: addDays(ctx.weekStarts[ew - 1]!, 6),
      audience: c.audience.slice(0, 300), keyMessage: c.key_message, offer: c.offer.slice(0, 300), cta: c.cta.slice(0, 300),
      channels: channels.length ? channels : mix.map((m) => m.channel),
      contentTypes: ([...new Set(c.content_types.filter((t) => ctSet.has(t)))] as StrategyPlan["campaigns"][number]["contentTypes"]).slice(0, 8),
      pillar: c.pillar.slice(0, 300), kpis: c.kpis.slice(0, 6).map((k) => k.slice(0, 300)),
    };
  });
  if (d.campaigns.length > 6) notes.push(`Kept the first 6 of ${d.campaigns.length} campaigns.`);
  const keyByName = new Map<string, string>();
  for (const c of campaigns) if (!keyByName.has(c.name.toLowerCase())) keyByName.set(c.name.toLowerCase(), c.key);   // first wins
  for (const c of campaigns) if (!c.contentTypes.length) c.contentTypes = ["social_post"];

  // weeks: exactly the computed Mondays
  const byIndex = new Map(d.weeks.map((w) => [Math.round(w.week), w]));
  const weeks = ctx.weekStarts.map((weekStart, i) => {
    const w = byIndex.get(i + 1);
    return {
      weekStart, theme: (w?.theme ?? "").slice(0, 300), focus: w?.focus ?? "",
      pillars: (w?.pillars ?? []).slice(0, 6).map((p) => p.slice(0, 300)),
      campaigns: [...new Set((w?.campaigns ?? []).map((n) => keyByName.get(n.toLowerCase()) ?? (usedKeys.has(n) ? n : "")).filter(Boolean))],
    };
  });
  const missing = weeks.filter((w) => !w.theme).length;
  if (missing) notes.push(`${missing} week(s) had no theme; fill them in or regenerate.`);

  const momentNames = new Map(ctx.moments.map((m) => [m.name.toLowerCase(), m]));
  const moments = d.moments_used.map((n) => momentNames.get(n.toLowerCase())).filter((m): m is SeasonalMoment => !!m).map((m) => ({ name: m.name, date: m.date }));
  if (d.moments_used.length > moments.length) notes.push("Ignored seasonal moments that weren't in the provided calendar.");

  const plan = StrategyPlanSchema.parse({
    version: 1,
    summary: d.summary,
    positioning: d.positioning,
    goals: d.goals.slice(0, 8).map((g, i) => ({ id: id("goal", i), ...g })),
    audiences: d.audiences.slice(0, 6).map((a, i) => ({ id: id("aud", i), ...a })),
    pillars: pillars.map((p, i) => ({ id: id("pillar", i), name: p.name, description: p.description, share: shares[i]!, exampleTopics: p.example_topics.slice(0, 10) })),
    channelMix: mix,
    offers: d.offers.slice(0, 10).map((o, i) => ({ id: id("offer", i), ...o })),
    campaigns: campaigns.map((c) => ({ ...c, startsOn: clampDate(c.startsOn, startsOn, endsOn), endsOn: clampDate(c.endsOn, startsOn, endsOn) })),
    weeks,
    metrics: d.metrics.slice(0, 10).map((m) => ({ metric: m.metric, target: m.target, howMeasured: m.how_measured })),
    assumptions: d.assumptions.slice(0, 10),
    moments,
  });
  return { plan, notes };
}

/** Light validation for human edits (structure via schema, plus cross-field rules). */
export function checkPlan(plan: StrategyPlan, ctx: { startsOn: string; endsOn: string; channels?: string[] }): string[] {
  const issues: string[] = [];
  const share = plan.pillars.reduce((s, p) => s + p.share, 0);
  if (plan.pillars.length && Math.abs(share - 100) > 1) issues.push(`Pillar shares add up to ${share}% (should be 100%).`);
  const keys = new Set<string>();
  for (const c of plan.campaigns) {
    if (keys.has(c.key)) issues.push(`Duplicate campaign key "${c.key}".`);
    keys.add(c.key);
    if (!isISODate(c.startsOn) || !isISODate(c.endsOn)) issues.push(`Campaign "${c.name}" has an invalid date.`);
    else if (c.endsOn < c.startsOn) issues.push(`Campaign "${c.name}" ends before it starts.`);
    else if (c.startsOn < ctx.startsOn || c.endsOn > ctx.endsOn) issues.push(`Campaign "${c.name}" runs outside the strategy period.`);
  }
  for (const w of plan.weeks) for (const k of w.campaigns) if (!keys.has(k)) issues.push(`Week of ${w.weekStart} references unknown campaign "${k}".`);
  return issues;
}

/** Paths whose values differ — recorded on strategy_revisions for history. */
export function changedTopLevel(a: StrategyPlan | null | undefined, b: StrategyPlan): string[] {
  if (!a) return Object.keys(b);
  return (Object.keys(b) as Array<keyof StrategyPlan>).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}
