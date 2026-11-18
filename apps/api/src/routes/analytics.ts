import {
  AppError, assertSafeUrl, compareWindows, dayList, fromDbError, interactions, isoDay, periodRange, rankPosts, seen,
  type MetricValues, type Period, type PostFacts,
} from "@arcatic/core";
import { MatomoClient } from "@arcatic/integrations";
import { qualitySummary } from "@arcatic/jobs/analytics-activities";
import { storeSecret } from "@arcatic/jobs/publishing";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { body, check, ok, parse } from "../http.js";
import { requirePermission as can } from "../middleware/workspace.js";
import type { ApiDeps, AppEnv } from "../types.js";

const PeriodSchema = z.object({ period: z.enum(["7d", "30d", "365d"]).default("30d") });
const BreakdownSchema = PeriodSchema.extend({ by: z.enum(["channel", "campaign", "content", "topic", "date", "content_type"]).default("channel") });
const CONN_COLS = "id, brand_id, provider, base_url, account_ref, display_name, settings, status, last_synced_at, last_error, created_at";
type PerfRow = {
  schedule_id: string; content_item_id: string; campaign_id: string | null; topic_id: string | null; channel: string; kind: string; published_at: string; external_url: string | null;
  impressions: number | null; reach: number | null; video_views: number | null; engagements: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null;
  clicks: number | null; unique_clicks: number | null; opens: number | null; sends: number | null; failed: number | null; conversions: number | null;
};

function maybe<T>(res: { data: T; error: { message: string; code?: string } | null }): T | null {
  if (res.error) throw fromDbError(res.error);
  return res.data ?? null;
}
const vals = (r: PerfRow): MetricValues => Object.fromEntries(Object.entries(r).filter(([k, v]) => v != null && ["impressions", "reach", "video_views", "engagements", "likes", "comments", "shares", "saves", "clicks", "opens", "sends", "failed", "conversions", "unique_clicks"].includes(k)).map(([k, v]) => [k, Number(v)]));
const sum = (rows: PerfRow[], f: (r: PerfRow) => number | null) => rows.reduce((s, r) => s + (f(r) ?? 0), 0);
const rate = (a: number, b: number) => (b > 0 ? a / b : null);

function socialSummary(rows: PerfRow[]) {
  const posts = rows.filter((r) => r.kind === "post");
  const s = sum(posts, (r) => seen(vals(r)));
  const i = sum(posts, (r) => interactions(vals(r)));
  return { posts: posts.length, seen: s, interactions: i, clicks: sum(posts, (r) => r.clicks), engagementRate: rate(i, s) };
}
function emailSummary(rows: PerfRow[]) {
  const e = rows.filter((r) => r.kind === "email");
  const sends = sum(e, (r) => r.sends), opens = sum(e, (r) => r.opens), clicks = sum(e, (r) => r.unique_clicks ?? r.clicks), failed = sum(e, (r) => r.failed);
  return { emails: e.length, sends, delivered: Math.max(0, sends - failed), opens, clicks, openRate: rate(opens, sends - failed), clickRate: rate(clicks, sends - failed) };
}

export const analyticsRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  const svc = () => deps.serviceDb();
  const ws = (c: Context<AppEnv>) => c.get("workspaceId");
  const actor = (c: Context<AppEnv>) => { const p = c.get("principal"); return p.kind === "user" ? p.userId : null; };
  const brandId = (c: Context<AppEnv>) => c.req.param("brandId")!;
  const resolve = deps.resolveHost ?? (async () => []);

  // ---------------------------------------------------------------- sources
  r.get("/analytics/connections", can("analytics.read"), async (c) => {
    const rows = check(await c.get("db").from("analytics_connections").select(CONN_COLS).eq("workspace_id", ws(c)).order("created_at"));
    return c.json({ data: rows, adsSyncAvailable: !!deps.ads });
  });

  async function saveConnection(c: Context<AppEnv>, row: { provider: string; brand_id: string | null; base_url?: string | null; account_ref: string; display_name: string; settings?: Record<string, unknown> }, purpose: "matomo_token" | "google_ads_refresh_token" | "meta_access_token", secret: string) {
    if (row.brand_id) check(await c.get("db").from("brands").select("id").eq("workspace_id", ws(c)).eq("id", row.brand_id).single());
    const secretId = await storeSecret(svc(), { workspaceId: ws(c), purpose, plaintext: secret, actor: actor(c), key: deps.encryptionKey });
    const prior = maybe(await svc().from("analytics_connections").select("id, secret_id").eq("workspace_id", ws(c)).eq("provider", row.provider).eq("account_ref", row.account_ref).maybeSingle()) as { id: string; secret_id: string | null } | null;
    const fields = { ...row, settings: row.settings ?? {}, secret_id: secretId, status: "active", last_error: null, connected_by: actor(c) };
    const saved = prior
      ? check(await svc().from("analytics_connections").update(fields).eq("id", prior.id).select(CONN_COLS).single())
      : check(await svc().from("analytics_connections").insert({ workspace_id: ws(c), ...fields }).select(CONN_COLS).single());
    if (prior?.secret_id) ok(await svc().from("integration_secrets").delete().eq("id", prior.secret_id));
    return saved;
  }

  r.put("/analytics/connections/matomo", can("channel.manage"), async (c) => {
    const i = await body(c, z.object({ baseUrl: z.url().max(500), siteId: z.string().regex(/^\d{1,9}$/), token: z.string().trim().min(16).max(200), brandId: z.uuid().nullable().optional() }));
    const url = await assertSafeUrl(i.baseUrl, { resolve, allowedSchemes: ["https:"] });
    const baseUrl = `${url.origin}${url.pathname.replace(/\/(index\.php)?\/*$/, "")}`;
    const today = isoDay(new Date());
    try {
      await new MatomoClient({ baseUrl, token: i.token, siteId: i.siteId, fetchImpl: deps.fetchImpl }).visits(today, today);
    } catch (e) {
      throw new AppError("validation_failed", `Matomo didn't accept these details: ${(e as Error).message}`);
    }
    return c.json(await saveConnection(c, { provider: "matomo", brand_id: i.brandId ?? null, base_url: baseUrl, account_ref: i.siteId, display_name: `${url.host} · site ${i.siteId}` }, "matomo_token", i.token), 201);
  });

  r.put("/analytics/connections/google-ads", can("channel.manage"), async (c) => {
    const i = await body(c, z.object({ customerId: z.string().regex(/^\d{3}-?\d{3}-?\d{4}$/), loginCustomerId: z.string().regex(/^\d{3}-?\d{3}-?\d{4}$/).nullable().optional(), refreshToken: z.string().trim().min(20).max(1000), brandId: z.uuid().nullable().optional() }));
    const customerId = i.customerId.replace(/-/g, "");
    let verified = false;
    if (deps.ads) {
      const d = isoDay(new Date());
      try { await deps.ads.googleAds({ customerId, loginCustomerId: i.loginCustomerId?.replace(/-/g, "") ?? null, refreshToken: i.refreshToken, from: d, to: d }); verified = true; }
      catch (e) { throw new AppError("validation_failed", `Google Ads refused access: ${(e as Error).message}`); }
    }
    const row = await saveConnection(c, { provider: "google_ads", brand_id: i.brandId ?? null, account_ref: customerId, display_name: `Google Ads ${i.customerId}`, settings: { loginCustomerId: i.loginCustomerId?.replace(/-/g, "") ?? null } }, "google_ads_refresh_token", i.refreshToken);
    return c.json({ ...row, verified }, 201);
  });

  r.put("/analytics/connections/meta-ads", can("channel.manage"), async (c) => {
    const i = await body(c, z.object({ adAccountId: z.string().regex(/^(act_)?\d{5,20}$/), accessToken: z.string().trim().min(20).max(2000), brandId: z.uuid().nullable().optional() }));
    const account = i.adAccountId.startsWith("act_") ? i.adAccountId : `act_${i.adAccountId}`;
    let verified = false;
    if (deps.ads) {
      const d = isoDay(new Date());
      try { await deps.ads.meta({ adAccountId: account, accessToken: i.accessToken, from: d, to: d }); verified = true; }
      catch (e) { throw new AppError("validation_failed", `Meta refused access: ${(e as Error).message}`); }
    }
    const row = await saveConnection(c, { provider: "meta_ads", brand_id: i.brandId ?? null, account_ref: account, display_name: `Meta ${account}` }, "meta_access_token", i.accessToken);
    return c.json({ ...row, verified }, 201);
  });

  r.delete("/analytics/connections/:id", can("channel.manage"), async (c) => {
    const conn = maybe(await svc().from("analytics_connections").select("id, secret_id").eq("workspace_id", ws(c)).eq("id", c.req.param("id")).maybeSingle()) as { id: string; secret_id: string | null } | null;
    if (!conn) return c.body(null, 204);
    ok(await svc().from("analytics_connections").update({ status: "disconnected", secret_id: null }).eq("id", conn.id));
    if (conn.secret_id) ok(await svc().from("integration_secrets").delete().eq("id", conn.secret_id));
    return c.body(null, 204);   // collected metrics are kept
  });

  /** Sync now (at most one per workspace per hour; a running one is reused). */
  r.post("/analytics/sync", can("analytics.read"), async (c) => {
    const hour = new Date().toISOString().slice(0, 13).replace(/\D/g, "");
    const id = await (await deps.jobs()).analyticsSync({ workspaceId: ws(c) }, hour);
    return c.json({ workflowId: id }, 202);
  });

  r.get("/analytics/sync-runs", can("analytics.read"), async (c) => {
    return c.json({ data: check(await c.get("db").from("analytics_sync_runs").select("source, status, rows_written, error, started_at, finished_at").eq("workspace_id", ws(c)).order("started_at", { ascending: false }).limit(50)) });
  });

  // ---------------------------------------------------------------- brand dashboard
  async function perf(c: Context<AppEnv>, from: Date, to: Date): Promise<PerfRow[]> {
    return check(await c.get("db").rpc("post_performance", { p_brand: brandId(c), p_from: from.toISOString(), p_to: to.toISOString() })) as PerfRow[];
  }
  async function daily(c: Context<AppEnv>, kind: string, from: Date, to: Date) {
    return check(await c.get("db").from("performance_metrics").select("metric_key, metric_date, source, channel, campaign_id, impressions, clicks, spend_minor, conversions, conversion_value_minor, visits, visitors, bounces, followers, video_views, reach, extra")
      .eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).eq("kind", kind).gte("metric_date", isoDay(from)).lt("metric_date", isoDay(to)).limit(20_000)) as Array<Record<string, number | string | null> & { metric_date: string; metric_key: string }>;
  }

  r.get("/brands/:brandId/analytics/overview", can("analytics.read"), async (c) => {
    const { period } = parse(PeriodSchema, c.req.query());
    const p = periodRange(period as Period);
    const [cur, prev, siteCur, sitePrev, adsCur, adsPrev, accounts] = await Promise.all([
      perf(c, p.from, p.to), perf(c, p.prevFrom, p.prevTo), daily(c, "site", p.from, p.to), daily(c, "site", p.prevFrom, p.prevTo), daily(c, "ad", p.from, p.to), daily(c, "ad", p.prevFrom, p.prevTo), daily(c, "account", p.prevFrom, p.to),
    ]);
    const channels = [...new Set([...cur, ...prev].filter((r) => r.kind === "post").map((r) => r.channel))].sort();
    const byChannel = channels.map((ch) => ({ channel: ch, current: socialSummary(cur.filter((r) => r.channel === ch)), previous: socialSummary(prev.filter((r) => r.channel === ch)) }));

    const days = dayList(p.from, p.to);
    const dayOf = (iso: string) => iso.slice(0, 10);
    const series = days.map((d) => {
      const posts = cur.filter((r) => r.kind === "post" && dayOf(r.published_at) === d);
      return {
        date: d, posts: posts.length, seen: sum(posts, (r) => seen(vals(r))), interactions: sum(posts, (r) => interactions(vals(r))),
        visits: siteCur.filter((r) => r.metric_date === d).reduce((s, r) => s + Number(r.visits ?? 0), 0),
        adSpendMinor: adsCur.filter((r) => r.metric_date === d).reduce((s, r) => s + Number(r.spend_minor ?? 0), 0),
      };
    });
    const prevDays = dayList(p.prevFrom, p.prevTo);
    const siteSum = (rows: typeof siteCur, k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
    const adSum = (rows: typeof adsCur) => ({ spendMinor: siteSum(rows, "spend_minor"), impressions: siteSum(rows, "impressions"), clicks: siteSum(rows, "clicks"), conversions: siteSum(rows, "conversions"), conversionValueMinor: siteSum(rows, "conversion_value_minor"), currency: (rows.find((r) => r.extra && (r.extra as unknown as { currency?: string }).currency)?.extra as unknown as { currency?: string } | undefined)?.currency ?? null });
    const adsBySource = ["google_ads", "meta_ads"].map((src) => ({ source: src, current: adSum(adsCur.filter((r) => r.source === src)), previous: adSum(adsPrev.filter((r) => r.source === src)) })).filter((x) => x.current.impressions || x.previous.impressions);

    const followers = new Map<string, { first: number | null; last: number | null }>();
    for (const r of [...accounts].sort((a, b) => a.metric_date.localeCompare(b.metric_date))) {
      if (r.followers == null) continue;
      const f = followers.get(r.metric_key) ?? { first: null, last: null };
      if (r.metric_date >= isoDay(p.from)) { f.first ??= Number(r.followers); f.last = Number(r.followers); }
      followers.set(r.metric_key, f);
    }

    const trendOf = (metric: string, curSeries: number[], prevSeries: number[]) => compareWindows(metric, curSeries, prevSeries);
    const prevSeen = prevDays.map((d) => sum(prev.filter((r) => r.kind === "post" && dayOf(r.published_at) === d), (r) => seen(vals(r))));
    const trends = [
      trendOf("seen", series.map((s) => s.seen), prevSeen),
      trendOf("visits", series.map((s) => s.visits), prevDays.map((d) => sitePrev.filter((r) => r.metric_date === d).reduce((s, r) => s + Number(r.visits ?? 0), 0))),
    ].filter((t) => t.current || t.previous);

    // top / bottom of the period (scored within channel)
    const items = cur.length ? check(await c.get("db").from("content_items").select("id, title, type").in("id", [...new Set(cur.map((r) => r.content_item_id))])) as Array<{ id: string; title: string | null; type: string }> : [];
    const title = new Map(items.map((i) => [i.id, i]));
    const facts: PostFacts[] = cur.filter((r) => r.kind === "post").map((r) => ({
      scheduleId: r.schedule_id, contentItemId: r.content_item_id, title: title.get(r.content_item_id)?.title ?? null, channel: r.channel, contentType: title.get(r.content_item_id)?.type ?? "social_post",
      campaignId: r.campaign_id, topicId: r.topic_id, publishedAt: r.published_at, textLength: 0, hashtags: 0, mediaKind: "text", metrics: vals(r),
    }));
    const ranked = rankPosts(facts, { limit: 5 });
    const urls = new Map(cur.map((r) => [r.schedule_id, r.external_url]));
    const brief = (x: (typeof ranked.top)[number]) => ({ scheduleId: x.scheduleId, contentItemId: x.contentItemId, title: x.title, channel: x.channel, engagementRate: x.er, seen: x.seen, vsChannel: x.channelMedian ? x.er / x.channelMedian : null, url: urls.get(x.scheduleId) ?? null });

    return c.json({
      period, from: p.from, to: p.to,
      social: { current: socialSummary(cur), previous: socialSummary(prev), byChannel },
      email: { current: emailSummary(cur), previous: emailSummary(prev) },
      website: siteCur.length || sitePrev.length ? {
        current: { visits: siteSum(siteCur, "visits"), visitors: siteSum(siteCur, "visitors"), conversions: siteSum(siteCur, "conversions"), bounceRate: rate(siteSum(siteCur, "bounces"), siteSum(siteCur, "visits")) },
        previous: { visits: siteSum(sitePrev, "visits"), visitors: siteSum(sitePrev, "visitors"), conversions: siteSum(sitePrev, "conversions"), bounceRate: rate(siteSum(sitePrev, "bounces"), siteSum(sitePrev, "visits")) },
      } : null,
      ads: adsBySource,
      followers: [...followers.entries()].map(([key, f]) => ({ accountId: key.replace("account:", ""), start: f.first, end: f.last, change: f.first != null && f.last != null ? f.last - f.first : null })),
      series, trends, top: ranked.top.map(brief), bottom: ranked.bottom.map(brief), ranked: ranked.eligible,
      notes: [
        "Post totals are lifetime figures (latest snapshot) for posts published in this period; daily views by date are not available from every platform.",
        "“Seen” is impressions where the platform reports them, otherwise views, otherwise reach.",
      ],
    });
  });

  r.get("/brands/:brandId/analytics/breakdown", can("analytics.read"), async (c) => {
    const { period, by } = parse(BreakdownSchema, c.req.query());
    const p = periodRange(period as Period);
    const rows = await perf(c, p.from, p.to);
    const keyOf = (r: PerfRow): string | null => by === "channel" ? r.channel : by === "campaign" ? r.campaign_id : by === "content" ? r.content_item_id : by === "topic" ? r.topic_id : by === "date" ? r.published_at.slice(0, 10) : null;
    let typeOf = new Map<string, string>();
    if (by === "content_type" || by === "content") {
      const items = rows.length ? check(await c.get("db").from("content_items").select("id, type, title").in("id", [...new Set(rows.map((r) => r.content_item_id))])) as Array<{ id: string; type: string; title: string | null }> : [];
      typeOf = new Map(items.map((i) => [i.id, by === "content" ? i.title ?? "Untitled" : i.type]));
    }
    const groups = new Map<string, PerfRow[]>();
    for (const r of rows) {
      const k = by === "content_type" ? typeOf.get(r.content_item_id) ?? "unknown" : keyOf(r) ?? "none";
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    let names = new Map<string, string>();
    if (by === "campaign") names = new Map((check(await c.get("db").from("campaigns").select("id, name").eq("brand_id", brandId(c))) as Array<{ id: string; name: string }>).map((x) => [x.id, x.name]));
    if (by === "topic") { const ids = [...groups.keys()].filter((k) => k !== "none"); if (ids.length) names = new Map((check(await c.get("db").from("campaign_topics").select("id, title").in("id", ids)) as Array<{ id: string; title: string }>).map((x) => [x.id, x.title])); }
    if (by === "content") names = typeOf;
    let utm = new Map<string, { visits: number; conversions: number }>();
    if (by === "campaign") {
      const u = await daily(c, "utm", p.from, p.to);
      utm = u.reduce((m, r) => { if (r.campaign_id) { const t = m.get(String(r.campaign_id)) ?? { visits: 0, conversions: 0 }; t.visits += Number(r.visits ?? 0); t.conversions += Number(r.conversions ?? 0); m.set(String(r.campaign_id), t); } return m; }, new Map<string, { visits: number; conversions: number }>());
    }
    const out = [...groups.entries()].map(([key, g]) => ({
      key, label: by === "channel" || by === "date" || by === "content_type" ? key : names.get(key) ?? (key === "none" ? "Not linked" : key),
      ...socialSummary(g), ...(g.some((r) => r.kind === "email") && { email: emailSummary(g) }), ...(utm.has(key) && { website: utm.get(key) }),
    })).sort((a, b) => (by === "date" ? a.key.localeCompare(b.key) : b.seen - a.seen));
    return c.json({ period, by, data: out });
  });

  // ---------------------------------------------------------------- insights & learning
  r.get("/brands/:brandId/insights", can("analytics.read"), async (c) => {
    const q = parse(z.object({ status: z.enum(["new", "accepted", "dismissed", "applied"]).optional(), kind: z.string().optional() }), c.req.query());
    let query = c.get("db").from("insights").select("id, kind, title, body, evidence, confidence, guidance, applies_to, status, decided_at, created_at, updated_at").eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).order("updated_at", { ascending: false }).limit(200);
    query = q.status ? query.eq("status", q.status) : query.in("status", ["new", "accepted", "applied"]);
    if (q.kind) query = query.eq("kind", q.kind);
    return c.json({ data: check(await query) });
  });

  r.post("/brands/:brandId/insights/refresh", can("analytics.read"), async (c) => {
    const hour = new Date().toISOString().slice(0, 13).replace(/\D/g, "");
    return c.json({ workflowId: await (await deps.jobs()).analyticsSync({ workspaceId: ws(c), brandId: brandId(c), insightsOnly: true }, `insights-${brandId(c)}-${hour}`) }, 202);
  });

  async function decide(c: Context<AppEnv>, status: "accepted" | "dismissed" | "applied", from: string[]) {
    const id = c.req.param("insightId")!;
    const ins = maybe(await svc().from("insights").select("id, kind, status, evidence, guidance").eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).eq("id", id).maybeSingle()) as { id: string; kind: string; status: string; evidence: { ops?: { addBanned?: string[]; addPreferred?: string[] } }; guidance: string | null } | null;
    if (!ins) throw new AppError("not_found", "Insight not found.");
    if (!from.includes(ins.status)) throw new AppError("conflict", `This insight is ${ins.status}.`);
    ok(await svc().from("insights").update({ status, decided_by: actor(c), decided_at: new Date().toISOString() }).eq("id", ins.id));
    if (status !== "applied") ok(await svc().from("learning_signals").insert({ workspace_id: ws(c), brand_id: brandId(c), signal: status === "accepted" ? "insight_accept" : "insight_dismiss", details: { insightId: ins.id, kind: ins.kind }, actor_id: actor(c) }));
    return ins;
  }

  /** Accepting: guidance (if any) starts reaching generation; voice refinements also return Brand Kit ops to review. */
  r.post("/brands/:brandId/insights/:insightId/accept", can("brand.update"), async (c) => {
    const ins = await decide(c, "accepted", ["new"]);
    let kit: { baseVersion: number; ops: Array<{ op: "set"; path: string; value: string[] }> } | null = null;
    if (ins.kind === "voice_refinement" && (ins.evidence.ops?.addBanned?.length || ins.evidence.ops?.addPreferred?.length)) {
      const latest = maybe(await c.get("db").from("brand_kit_versions").select("version, kit").eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).order("version", { ascending: false }).limit(1).maybeSingle()) as { version: number; kit: { facts?: Record<string, { value?: unknown }> } } | null;
      if (latest) {
        const cur = (k: string) => (Array.isArray(latest.kit.facts?.[k]?.value) ? (latest.kit.facts![k]!.value as string[]) : []);
        const merge = (k: string, add: string[] = []) => [...new Set([...cur(k), ...add])];
        const ops: Array<{ op: "set"; path: string; value: string[] }> = [];
        if (ins.evidence.ops?.addBanned?.length) ops.push({ op: "set", path: "vocabulary.banned", value: merge("vocabulary.banned", ins.evidence.ops.addBanned) });
        if (ins.evidence.ops?.addPreferred?.length) ops.push({ op: "set", path: "vocabulary.preferred", value: merge("vocabulary.preferred", ins.evidence.ops.addPreferred) });
        kit = { baseVersion: latest.version, ops };
      }
    }
    return c.json({ status: "accepted", usedInGeneration: !!ins.guidance, kit });
  });

  r.post("/brands/:brandId/insights/:insightId/dismiss", can("brand.update"), async (c) => {
    await decide(c, "dismissed", ["new", "accepted"]);
    return c.json({ status: "dismissed" });
  });

  /** After the proposed Brand Kit change was saved as a draft version. */
  r.post("/brands/:brandId/insights/:insightId/applied", can("brand.update"), async (c) => {
    await decide(c, "applied", ["accepted"]);
    return c.json({ status: "applied" });
  });

  r.get("/brands/:brandId/learning", can("analytics.read"), async (c) => {
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const signals = check(await c.get("db").from("learning_signals").select("signal, edit_class").eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).gte("created_at", since).limit(10_000)) as Array<{ signal: string; edit_class: string | null }>;
    const counts: Record<string, number> = {}, editClasses: Record<string, number> = {};
    for (const s of signals) {
      counts[s.signal] = (counts[s.signal] ?? 0) + 1;
      for (const k of (s.edit_class ?? "").split(",").filter(Boolean)) editClasses[k] = (editClasses[k] ?? 0) + 1;
    }
    const inUse = check(await c.get("db").from("insights").select("id, title, guidance, applies_to, decided_at").eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).eq("status", "accepted").not("guidance", "is", null).order("decided_at", { ascending: false }));
    return c.json({ periodDays: 90, signals: counts, editClasses, quality: await qualitySummary(svc(), ws(c), brandId(c), 90), learningsInUse: inUse });
  });

  r.post("/brands/:brandId/content/:contentId/feedback", can("approval.read"), async (c) => {
    const i = await body(c, z.object({ rating: z.number().int().min(1).max(5).optional(), note: z.string().trim().min(1).max(2000).optional() }).refine((x) => x.rating || x.note, "Give a rating or a note."));
    const item = maybe(await c.get("db").from("content_items").select("id, current_version_id").eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).eq("id", c.req.param("contentId")!).maybeSingle()) as { id: string; current_version_id: string | null } | null;
    if (!item) throw new AppError("not_found", "Content not found.");
    const v = item.current_version_id ? maybe(await svc().from("content_versions").select("prompt_template, model").eq("id", item.current_version_id).maybeSingle()) as { prompt_template: string | null; model: string | null } | null : null;
    ok(await svc().from("learning_signals").insert({
      workspace_id: ws(c), brand_id: brandId(c), content_item_id: item.id, content_version_id: item.current_version_id, signal: i.rating ? "rating" : "manual_note",
      value: i.rating ?? null, details: { note: i.note ?? null }, prompt_template: v?.prompt_template ?? null, model: v?.model ?? null, actor_id: actor(c),
    }));
    return c.json({ ok: true }, 201);
  });

  return r;
};

