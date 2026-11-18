import { engagementRate, seen, type MetricValues } from "./metrics.js";

/**
 * Deterministic, evidence-backed insights. Nothing here changes generation by itself:
 * an insight's `guidance` reaches prompts only after a person accepts it (docs/16 §4).
 */
export interface PostFacts {
  scheduleId: string;
  contentItemId: string;
  title: string | null;
  channel: string;
  contentType: string;
  campaignId: string | null;
  topicId: string | null;
  publishedAt: string;
  textLength: number;
  hashtags: number;
  mediaKind: "video" | "image" | "text";
  metrics: MetricValues;
}

export interface RankedPost extends PostFacts { er: number; seen: number; score: number; channelMedian: number }

export interface InsightDraft {
  kind: "top_content" | "underperformer" | "recommendation" | "voice_refinement" | "trend";
  fingerprint: string;
  title: string;
  body: string;
  confidence: number;
  evidence: Record<string, unknown>;
  guidance?: string;
  appliesTo?: { channel?: string; contentType?: string };
}

const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const pct = (x: number) => `${Math.round(x * 100)}%`;
const times = (x: number) => `${x.toFixed(1)}×`;
const conf = (n: number, effect: number) => Math.max(0.2, Math.min(0.9, 0.3 + 0.04 * Math.min(n, 12) + Math.min(0.2, (effect - 1) * 0.2)));
const CH: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", linkedin: "LinkedIn", x: "X", tiktok: "TikTok", youtube: "YouTube", threads: "Threads", gbp: "Business Profile", wordpress: "the blog", email: "email" };
const label = (c: string) => CH[c] ?? c;

export interface RankOptions { now?: Date; minAgeHours?: number; minSeen?: number; limit?: number }

/** Posts old enough to judge, scored against their own channel (robust z: median / MAD). */
export function rankPosts(posts: PostFacts[], o: RankOptions = {}) {
  const now = (o.now ?? new Date()).getTime();
  const eligible: RankedPost[] = [];
  for (const p of posts) {
    const s = seen(p.metrics);
    const er = engagementRate(p.metrics);
    if (er == null || !s || s < (o.minSeen ?? 50) || now - Date.parse(p.publishedAt) < (o.minAgeHours ?? 48) * 3_600_000) continue;
    eligible.push({ ...p, er, seen: s, score: 0, channelMedian: 0 });
  }
  const byChannel = new Map<string, RankedPost[]>();
  for (const p of eligible) byChannel.set(p.channel, [...(byChannel.get(p.channel) ?? []), p]);
  const baselines: Record<string, { median: number; posts: number }> = {};
  for (const [ch, list] of byChannel) {
    const m = median(list.map((p) => p.er));
    const mad = median(list.map((p) => Math.abs(p.er - m))) * 1.4826;
    const scale = mad || m * 0.25 || 1e-6;
    for (const p of list) { p.channelMedian = m; p.score = list.length >= 3 ? (p.er - m) / scale : 0; }
    baselines[ch] = { median: m, posts: list.length };
  }
  const sorted = [...eligible].sort((a, b) => b.score - a.score);
  const limit = o.limit ?? 5;
  return {
    eligible: eligible.length,
    baselines,
    top: sorted.filter((p) => p.score >= 1).slice(0, limit),
    bottom: sorted.filter((p) => p.score <= -1).reverse().slice(0, limit),
  };
}

function spearman(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const rank = (a: number[]) => { const idx = a.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]); const r = new Array<number>(n); let i = 0; while (i < n) { let j = i; while (j + 1 < n && idx[j + 1]![0] === idx[i]![0]) j++; for (let k = i; k <= j; k++) r[idx[k]![1]] = (i + j) / 2; i = j + 1; } return r; };
  const rx = rank(xs), ry = rank(ys);
  const mx = (n - 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i]! - mx) * (ry[i]! - mx); dx += (rx[i]! - mx) ** 2; dy += (ry[i]! - mx) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function slot(iso: string, tzOffsetMinutes: number) {
  const d = new Date(Date.parse(iso) + tzOffsetMinutes * 60_000);
  const h = d.getUTCHours();
  const part = h < 6 ? "night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
  return { day: DAYS[d.getUTCDay()]!, part };
}

/** Recommendations with their evidence. Each needs enough posts; none are produced from thin data. */
export function recommend(ranked: RankedPost[], o: { tzOffsetMinutes?: number } = {}): InsightDraft[] {
  const out: InsightDraft[] = [];
  const byChannel = new Map<string, RankedPost[]>();
  for (const p of ranked) byChannel.set(p.channel, [...(byChannel.get(p.channel) ?? []), p]);

  for (const [ch, list] of byChannel) {
    if (list.length < 8) continue;
    const base = median(list.map((p) => p.er));
    if (base <= 0) continue;

    // when
    const slots = new Map<string, RankedPost[]>();
    for (const p of list) { const s = slot(p.publishedAt, o.tzOffsetMinutes ?? 330); const k = `${s.day} ${s.part}`; slots.set(k, [...(slots.get(k) ?? []), p]); }
    const best = [...slots.entries()].filter(([, ps]) => ps.length >= 3).map(([k, ps]) => ({ k, ps, r: median(ps.map((p) => p.er)) / base })).sort((a, b) => b.r - a.r)[0];
    if (best && best.r >= 1.3) {
      out.push({
        kind: "recommendation", fingerprint: `time:${ch}:${best.k}`, title: `Post on ${label(ch)} on ${best.k}s`,
        body: `${best.ps.length} posts published on ${best.k}s got ${times(best.r)} the typical engagement rate on ${label(ch)} (${list.length} posts compared).`,
        confidence: conf(best.ps.length, best.r), evidence: { channel: ch, slot: best.k, posts: best.ps.map((p) => p.scheduleId), ratio: best.r, compared: list.length },
        appliesTo: { channel: ch },
      });
    }

    // format
    const kinds = (["video", "image", "text"] as const).map((k) => ({ k, ps: list.filter((p) => p.mediaKind === k) })).filter((x) => x.ps.length >= 3);
    if (kinds.length >= 2) {
      const scored = kinds.map((x) => ({ ...x, m: median(x.ps.map((p) => p.er)) })).sort((a, b) => b.m - a.m);
      const [a, b] = [scored[0]!, scored[scored.length - 1]!];
      if (b.m > 0 && a.m / b.m >= 1.3) {
        const name = { video: "Video", image: "Image", text: "Text-only" }[a.k];
        out.push({
          kind: "recommendation", fingerprint: `format:${ch}:${a.k}`, title: `${name} posts work best on ${label(ch)}`,
          body: `${name} posts had a median engagement rate of ${pct(a.m)} vs ${pct(b.m)} for ${b.k} posts (${a.ps.length} and ${b.ps.length} posts).`,
          confidence: conf(Math.min(a.ps.length, b.ps.length), a.m / b.m), evidence: { channel: ch, best: a.k, worst: b.k, medians: Object.fromEntries(scored.map((x) => [x.k, x.m])), counts: Object.fromEntries(scored.map((x) => [x.k, x.ps.length])) },
          guidance: `For ${label(ch)}, favour ${a.k === "text" ? "text-only" : a.k}-led ideas; they have performed better for this brand.`, appliesTo: { channel: ch },
        });
      }
    }

    // length
    const rhoLen = spearman(list.map((p) => p.textLength), list.map((p) => p.er));
    if (rhoLen !== null && Math.abs(rhoLen) >= 0.4) {
      const topHalf = [...list].sort((p, q) => q.er - p.er).slice(0, Math.ceil(list.length / 2));
      const target = Math.round(median(topHalf.map((p) => p.textLength)) / 10) * 10;
      const shorter = rhoLen < 0;
      out.push({
        kind: "recommendation", fingerprint: `length:${ch}:${shorter ? "short" : "long"}`, title: `${shorter ? "Shorter" : "Longer"} posts do better on ${label(ch)}`,
        body: `Across ${list.length} posts, ${shorter ? "shorter" : "longer"} text went with higher engagement (rank correlation ${rhoLen.toFixed(2)}). The better half averaged about ${target} characters.`,
        confidence: conf(list.length, 1 + Math.abs(rhoLen)), evidence: { channel: ch, rho: rhoLen, posts: list.length, targetLength: target },
        guidance: `Keep ${label(ch)} text around ${target} characters.`, appliesTo: { channel: ch },
      });
    }

    // hashtags
    const rhoTags = spearman(list.map((p) => p.hashtags), list.map((p) => p.er));
    if (rhoTags !== null && rhoTags <= -0.4) {
      const topHalf = [...list].sort((p, q) => q.er - p.er).slice(0, Math.ceil(list.length / 2));
      const k = Math.round(median(topHalf.map((p) => p.hashtags)));
      out.push({
        kind: "recommendation", fingerprint: `hashtags:${ch}:fewer`, title: `Fewer hashtags on ${label(ch)}`,
        body: `More hashtags went with lower engagement across ${list.length} posts (rank correlation ${rhoTags.toFixed(2)}). Better-performing posts used about ${k}.`,
        confidence: conf(list.length, 1 + Math.abs(rhoTags)), evidence: { channel: ch, rho: rhoTags, posts: list.length, typical: k },
        guidance: `Use at most ${Math.max(1, k)} hashtags on ${label(ch)}.`, appliesTo: { channel: ch },
      });
    }
  }

  // where: a channel that clearly outperforms but gets few posts
  const channels = [...byChannel.entries()].filter(([, l]) => l.length >= 5).map(([ch, l]) => ({ ch, n: l.length, m: median(l.map((p) => p.er)) }));
  if (channels.length >= 2) {
    const sorted = [...channels].sort((a, b) => b.m - a.m);
    const top = sorted[0]!;
    const rest = median(sorted.slice(1).map((c) => c.m));
    const avgN = channels.reduce((s, c) => s + c.n, 0) / channels.length;
    if (rest > 0 && top.m / rest >= 1.5 && top.n < avgN) {
      out.push({
        kind: "recommendation", fingerprint: `mix:${top.ch}`, title: `Post more on ${label(top.ch)}`,
        body: `${label(top.ch)} posts had ${times(top.m / rest)} the engagement rate of your other channels but only ${top.n} of ${channels.reduce((s, c) => s + c.n, 0)} posts.`,
        confidence: conf(top.n, top.m / rest), evidence: { channels },
      });
    }
  }
  return out;
}

export function rankingInsights(r: ReturnType<typeof rankPosts>): InsightDraft[] {
  const out: InsightDraft[] = [];
  for (const p of r.top.slice(0, 3)) out.push({
    kind: "top_content", fingerprint: `top:${p.scheduleId}`, title: `Top post: ${p.title ?? "Untitled"}`,
    body: `${pct(p.er)} engagement on ${label(p.channel)}, ${times(p.channelMedian ? p.er / p.channelMedian : 1)} the channel's typical post (${p.seen.toLocaleString("en-IN")} seen).`,
    confidence: 0.8, evidence: { scheduleId: p.scheduleId, contentItemId: p.contentItemId, er: p.er, median: p.channelMedian, score: p.score }, appliesTo: { channel: p.channel },
  });
  for (const p of r.bottom.slice(0, 3)) out.push({
    kind: "underperformer", fingerprint: `bottom:${p.scheduleId}`, title: `Underperformed: ${p.title ?? "Untitled"}`,
    body: `${pct(p.er)} engagement on ${label(p.channel)} vs a typical ${pct(p.channelMedian)}.`,
    confidence: 0.7, evidence: { scheduleId: p.scheduleId, contentItemId: p.contentItemId, er: p.er, median: p.channelMedian, score: p.score }, appliesTo: { channel: p.channel },
  });
  return out;
}
