import { ApplicationFailure } from "@temporalio/activity";
import {
  AppError, analyzeEdits, assertSafeUrl, compareWindows, docText, engagementRate, extractHashtags, fromDbError, isoDay, normalizePostiz, normalizePostizDaily,
  postText, rankPosts, rankingInsights, recommend, summarizeQuality, utmCampaign,
  type ContentDoc, type InsightDraft, type MetricValues, type PostFacts, type QualityRow,
} from "@arcatic/core";
import type { Db } from "@arcatic/database";
import { AdsSyncClient, MatomoClient, type LangfuseClient, type PostizClient } from "@arcatic/integrations";
import { traceIdForJob } from "@arcatic/integrations";
import { mauticFor, postizFor, readSecret, resolveDns } from "./publishing.js";

/**
 * Analytics ingestion and insight generation. Every source writes normalised rows into
 * performance_metrics keyed (workspace, metric_key, day); re-running a sync overwrites the
 * same day, so it is idempotent. Sources that aren't connected are skipped, not failed.
 */
export interface AnalyticsDeps {
  db: Db;
  encryptionKey?: string;
  fetchImpl?: typeof fetch;
  resolve?: (h: string) => Promise<string[]>;
  ads?: AdsSyncClient | null;
  langfuse?: LangfuseClient | null;
  now?: () => Date;
  /** test seam */
  postiz?: (workspaceId: string) => Promise<PostizClient>;
}

export interface SyncResult { source: string; status: "succeeded" | "failed" | "skipped"; rows: number; error?: string }

const DAY = 86_400_000;
type Row = Record<string, unknown>;
const pick = (v: MetricValues) => Object.fromEntries(Object.entries(v).filter(([, x]) => x != null).map(([k, x]) => [k, Math.round(Number(x))]));

export function createAnalyticsActivities(deps: AnalyticsDeps) {
  const { db } = deps;
  const now = () => deps.now?.() ?? new Date();
  const q = async <T>(p: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>): Promise<T> => {
    const r = await p;
    if (r.error) throw fromDbError(r.error as never);
    return r.data as T;
  };
  const upsert = async (rows: Row[]) => {
    for (let i = 0; i < rows.length; i += 500) await q(db.from("performance_metrics").upsert(rows.slice(i, i + 500).map((r) => ({ ...r, updated_at: new Date().toISOString() })), { onConflict: "workspace_id,metric_key,metric_date" }));
    return rows.length;
  };
  const postiz = (ws: string) => (deps.postiz ? deps.postiz(ws) : postizFor(db, ws, { key: deps.encryptionKey, fetchImpl: deps.fetchImpl }));

  /** Records the run; a skipped or failed source never fails the whole sync. */
  async function run(workspaceId: string, source: string, fn: () => Promise<number | null>): Promise<SyncResult> {
    const started = await q<{ id: string }>(db.from("analytics_sync_runs").insert({ workspace_id: workspaceId, source }).select("id").single());
    try {
      const rows = await fn();
      const status = rows === null ? "skipped" : "succeeded";
      await q(db.from("analytics_sync_runs").update({ status, rows_written: rows ?? 0, finished_at: new Date().toISOString() }).eq("id", started.id));
      return { source, status, rows: rows ?? 0 };
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      await q(db.from("analytics_sync_runs").update({ status: "failed", error, finished_at: new Date().toISOString() }).eq("id", started.id));
      return { source, status: "failed", rows: 0, error };
    }
  }

  type Pub = { id: string; brand_id: string; content_item_id: string; connected_account_id: string; external_post_id: string | null; published_at: string; account: { channel: string; transport: string } | null };
  async function publishedSince(workspaceId: string, days: number) {
    return q<Pub[]>(db.from("schedules").select("id, brand_id, content_item_id, connected_account_id, external_post_id, published_at, account:connected_accounts(channel, transport)")
      .eq("workspace_id", workspaceId).eq("status", "published").gte("published_at", new Date(now().getTime() - days * DAY).toISOString()).limit(2000));
  }
  async function itemLinks(workspaceId: string, itemIds: string[]) {
    if (!itemIds.length) return { campaign: new Map<string, string | null>(), topic: new Map<string, string>() };
    const items = await q<Array<{ id: string; campaign_id: string | null }>>(db.from("content_items").select("id, campaign_id").eq("workspace_id", workspaceId).in("id", itemIds));
    const topics = await q<Array<{ id: string; content_item_id: string }>>(db.from("campaign_topics").select("id, content_item_id").eq("workspace_id", workspaceId).in("content_item_id", itemIds));
    return { campaign: new Map(items.map((i) => [i.id, i.campaign_id])), topic: new Map(topics.map((t) => [t.content_item_id, t.id])) };
  }

  return {
    async listAnalyticsWorkspaces(): Promise<string[]> {
      const a = await q<Array<{ workspace_id: string }>>(db.from("publishing_connections").select("workspace_id").eq("status", "active"));
      const b = await q<Array<{ workspace_id: string }>>(db.from("analytics_connections").select("workspace_id").eq("status", "active"));
      return [...new Set([...a, ...b].map((r) => r.workspace_id))];
    },

    async listBrands(workspaceId: string): Promise<string[]> {
      return (await q<Array<{ id: string }>>(db.from("brands").select("id").eq("workspace_id", workspaceId).is("deleted_at", null))).map((b) => b.id);
    },

    /** Lifetime totals of every post/email published in the last 90 days, as today's snapshot. */
    async syncPostMetrics(a: { workspaceId: string }): Promise<SyncResult[]> {
      const posts = await publishedSince(a.workspaceId, 90);
      const links = await itemLinks(a.workspaceId, [...new Set(posts.map((p) => p.content_item_id))]);
      const today = isoDay(now());
      const base = (p: Pub, kind: string, source: string) => ({
        workspace_id: a.workspaceId, brand_id: p.brand_id, content_item_id: p.content_item_id, schedule_id: p.id, connected_account_id: p.connected_account_id,
        campaign_id: links.campaign.get(p.content_item_id) ?? null, topic_id: links.topic.get(p.content_item_id) ?? null, channel: p.account?.channel ?? "unknown",
        kind, source, metric_key: `${kind}:${p.id}`, metric_date: today, cumulative: true, external_id: p.external_post_id,
      });
      const social = posts.filter((p) => p.account?.transport === "postiz" && p.external_post_id);
      const emails = posts.filter((p) => p.account?.transport === "mautic" && p.external_post_id);
      const out: SyncResult[] = [];
      out.push(await run(a.workspaceId, "postiz_posts", async () => {
        if (!social.length) return null;
        const client = await postiz(a.workspaceId);
        const rows: Row[] = [];
        for (const p of social) {
          const r = await client.postAnalytics(p.external_post_id!, 30).catch(() => null);
          if (!r) continue;
          if (!Array.isArray(r)) { rows.push({ ...base(p, "post", "postiz"), extra: { missing: true } }); continue; }
          if (!r.length) continue;   // the platform reports nothing for this post (e.g. Business Profile)
          const n = normalizePostiz(r);
          rows.push({ ...base(p, "post", "postiz"), ...pick(n.values), extra: n.extra });
        }
        return upsert(rows);
      }));
      out.push(await run(a.workspaceId, "mautic_emails", async () => {
        if (!emails.length) return null;
        const m = await mauticFor(db, a.workspaceId, { key: deps.encryptionKey, fetchImpl: deps.fetchImpl, resolve: deps.resolve });
        const rows: Row[] = [];
        for (const p of emails) {
          const s = await m.emailStats(Number(p.external_post_id));
          rows.push({ ...base(p, "email", "mautic"), sends: s.sent, opens: s.opens, failed: s.failed, clicks: s.clicks, unique_clicks: s.uniqueClicks });
        }
        return upsert(rows);
      }));
      return out;
    },

    /** Account-level daily series from Postiz (followers, page impressions … whatever the platform reports). */
    async syncAccountMetrics(a: { workspaceId: string }): Promise<SyncResult> {
      return run(a.workspaceId, "postiz_accounts", async () => {
        const accounts = await q<Array<{ id: string; brand_id: string | null; channel: string; external_id: string }>>(db.from("connected_accounts").select("id, brand_id, channel, external_id")
          .eq("workspace_id", a.workspaceId).eq("transport", "postiz").eq("enabled", true).eq("status", "active"));
        if (!accounts.length) return null;
        const client = await postiz(a.workspaceId);
        const rows: Row[] = [];
        for (const acc of accounts) {
          const series = await client.integrationAnalytics(acc.external_id, 30).catch(() => []);
          for (const [day, v] of normalizePostizDaily(Array.isArray(series) ? series : [])) {
            rows.push({ workspace_id: a.workspaceId, brand_id: acc.brand_id, connected_account_id: acc.id, channel: acc.channel, kind: "account", source: "postiz", metric_key: `account:${acc.id}`, metric_date: day, ...pick(v.values), extra: v.extra });
          }
        }
        return upsert(rows);
      });
    },

    /** Matomo: daily visits/conversions and utm_campaign rows (matched to Arcatic campaigns by slug). */
    async syncSiteMetrics(a: { workspaceId: string }): Promise<SyncResult[]> {
      const conns = await q<Array<{ id: string; brand_id: string | null; base_url: string; account_ref: string; secret_id: string | null }>>(db.from("analytics_connections").select("id, brand_id, base_url, account_ref, secret_id").eq("workspace_id", a.workspaceId).eq("provider", "matomo").eq("status", "active"));
      const campaigns = await q<Array<{ id: string; brand_id: string; name: string }>>(db.from("campaigns").select("id, brand_id, name").eq("workspace_id", a.workspaceId));
      const bySlug = new Map(campaigns.map((c) => [utmCampaign(c.name), c]));
      const from = isoDay(new Date(now().getTime() - 30 * DAY)), to = isoDay(now());
      const results: SyncResult[] = [];
      for (const c of conns) {
        results.push(await run(a.workspaceId, `matomo:${c.account_ref}`, async () => {
          await assertSafeUrl(c.base_url, { resolve: deps.resolve ?? resolveDns, allowedSchemes: ["https:"] });
          const token = await readSecret(db, { workspaceId: a.workspaceId, secretId: c.secret_id, purpose: "matomo_token", key: deps.encryptionKey });
          const m = new MatomoClient({ baseUrl: c.base_url, token, siteId: c.account_ref, fetchImpl: deps.fetchImpl });
          const [visits, goals, camps] = await Promise.all([m.visits(from, to), m.goals(from, to), m.campaigns(from, to)]);
          const rows: Row[] = [];
          for (const [day, v] of Object.entries(visits)) {
            if (Array.isArray(v)) continue;
            const g = goals[day];
            const goal = g && !Array.isArray(g) ? g : undefined;
            rows.push({ workspace_id: a.workspaceId, brand_id: c.brand_id, channel: "website", kind: "site", source: "matomo", metric_key: `site:${c.id}`, metric_date: day,
              visits: v.nb_visits ?? 0, visitors: v.nb_uniq_visitors ?? null, bounces: v.bounce_count ?? null, conversions: goal?.nb_conversions ?? v.nb_visits_converted ?? 0,
              conversion_value_minor: goal?.revenue != null ? Math.round(Number(goal.revenue) * 100) : null, extra: { actions: v.nb_actions ?? null, sum_visit_length: v.sum_visit_length ?? null } });
          }
          for (const [day, list] of Object.entries(camps)) {
            for (const r of Array.isArray(list) ? list : []) {
              const match = bySlug.get(utmCampaign(r.label));
              rows.push({ workspace_id: a.workspaceId, brand_id: match?.brand_id ?? c.brand_id, campaign_id: match?.id ?? null, channel: "website", kind: "utm", source: "matomo",
                metric_key: `utm:${c.id}:${r.label.toLowerCase().slice(0, 120)}`, metric_date: day, visits: r.nb_visits ?? 0, conversions: r.nb_conversions ?? 0,
                conversion_value_minor: r.revenue != null ? Math.round(Number(r.revenue) * 100) : null, extra: { label: r.label } });
            }
          }
          await q(db.from("analytics_connections").update({ last_synced_at: new Date().toISOString(), last_error: null, status: "active" }).eq("id", c.id));
          return upsert(rows);
        }));
      }
      return results;
    },

    /** Google Ads / Meta through the ads-sync sidecar (official SDKs). */
    async syncAdMetrics(a: { workspaceId: string }): Promise<SyncResult[]> {
      const conns = await q<Array<{ id: string; brand_id: string | null; provider: "google_ads" | "meta_ads"; account_ref: string; secret_id: string | null; settings: { loginCustomerId?: string } }>>(
        db.from("analytics_connections").select("id, brand_id, provider, account_ref, secret_id, settings").eq("workspace_id", a.workspaceId).in("provider", ["google_ads", "meta_ads"]).eq("status", "active"));
      const from = isoDay(new Date(now().getTime() - 30 * DAY)), to = isoDay(now());
      const results: SyncResult[] = [];
      for (const c of conns) {
        results.push(await run(a.workspaceId, `${c.provider}:${c.account_ref}`, async () => {
          if (!deps.ads) throw new AppError("conflict", "The ads-sync service isn't configured (ADS_SYNC_URL).");
          const res = c.provider === "google_ads"
            ? await deps.ads.googleAds({ customerId: c.account_ref, loginCustomerId: c.settings.loginCustomerId ?? null, refreshToken: await readSecret(db, { workspaceId: a.workspaceId, secretId: c.secret_id, purpose: "google_ads_refresh_token", key: deps.encryptionKey }), from, to })
            : await deps.ads.meta({ adAccountId: c.account_ref, accessToken: await readSecret(db, { workspaceId: a.workspaceId, secretId: c.secret_id, purpose: "meta_access_token", key: deps.encryptionKey }), from, to });
          const rows: Row[] = res.rows.map((r) => ({
            workspace_id: a.workspaceId, brand_id: c.brand_id, channel: c.provider === "google_ads" ? "google_ads" : "meta_ads", kind: "ad", source: c.provider,
            metric_key: `ad:${c.id}:${r.campaignId}`, metric_date: r.date, external_id: r.campaignId, impressions: r.impressions, clicks: r.clicks, spend_minor: r.costMinor,
            conversions: r.conversions, conversion_value_minor: r.conversionValueMinor, video_views: r.videoViews, reach: r.reach ?? null, extra: { campaignName: r.campaignName, currency: res.currency },
          }));
          await q(db.from("analytics_connections").update({ last_synced_at: new Date().toISOString(), last_error: null }).eq("id", c.id));
          return upsert(rows);
        }));
      }
      return results;
    },

    /** Once a post is ≥ 72 h old: its engagement relative to its channel becomes a learning signal (+ Langfuse score). */
    async recordOutcomes(a: { workspaceId: string }): Promise<number> {
      const facts = await postFacts(a.workspaceId, null, 90);
      const ranked = rankPosts(facts, { now: now(), minAgeHours: 72, limit: 10_000 });
      const all = new Map(facts.map((f) => [f.scheduleId, f]));
      const done = await q<Array<{ schedule_id: string }>>(db.from("learning_signals").select("schedule_id").eq("workspace_id", a.workspaceId).eq("signal", "engagement_outcome").in("schedule_id", [...all.keys()].length ? [...all.keys()] : ["00000000-0000-0000-0000-000000000000"]));
      const seenIds = new Set(done.map((d) => d.schedule_id));
      // score every eligible post (top/bottom lists only hold the extremes)
      let written = 0;
      for (const f of facts) {
        if (seenIds.has(f.scheduleId)) continue;
        const er = engagementRate(f.metrics);
        const base = ranked.baselines[f.channel];
        if (er == null || !base || base.posts < 3 || now().getTime() - Date.parse(f.publishedAt) < 72 * 3_600_000) continue;
        const score = base.median > 0 ? er / base.median - 1 : 0;
        const meta = await q<{ brand_id: string; current: { id: string; prompt_template: string | null; model: string | null; generation_job_id: string | null } | null }>(
          db.from("content_items").select("brand_id, current:content_versions!content_items_current_version_fk(id, prompt_template, model, generation_job_id)").eq("id", f.contentItemId).single());
        const ins = await db.from("learning_signals").insert({ workspace_id: a.workspaceId, brand_id: meta.brand_id, content_item_id: f.contentItemId, content_version_id: meta.current?.id ?? null, schedule_id: f.scheduleId,
          signal: "engagement_outcome", value: Number(score.toFixed(4)), details: { er, channelMedian: base.median, channel: f.channel }, prompt_template: meta.current?.prompt_template ?? null, model: meta.current?.model ?? null });
        if (ins.error?.code === "23505") continue;
        if (ins.error) throw fromDbError(ins.error);
        written++;
        const jobId = await firstAiJob(f.contentItemId);
        if (deps.langfuse && jobId) await deps.langfuse.score({ id: `${jobId}-engagement`, traceId: traceIdForJob(jobId), name: "engagement_vs_channel", value: Number(score.toFixed(4)), comment: `${f.channel}: ER ${(er * 100).toFixed(2)}% vs median ${(base.median * 100).toFixed(2)}%` }).catch(() => undefined);
      }
      return written;
    },

    async generateInsights(a: { workspaceId: string; brandId: string; tzOffsetMinutes?: number }): Promise<{ written: number; kinds: Record<string, number> }> {
      const drafts: InsightDraft[] = [];
      const facts = await postFacts(a.workspaceId, a.brandId, 90);
      const ranked = rankPosts(facts, { now: now() });
      drafts.push(...rankingInsights(ranked));
      const eligible = facts.flatMap((p) => { const er = engagementRate(p.metrics); const b = ranked.baselines[p.channel]; return er != null && b && now().getTime() - Date.parse(p.publishedAt) >= 48 * 3_600_000 ? [{ ...p, er, seen: 0, score: 0, channelMedian: b.median }] : []; });
      drafts.push(...recommend(eligible, { tzOffsetMinutes: a.tzOffsetMinutes ?? 330 }));
      drafts.push(...await siteTrends(a.workspaceId, a.brandId));
      const edits = await editLearning(a.workspaceId, a.brandId);
      drafts.push(...edits.proposals);
      await pushQualityScores(a.workspaceId, a.brandId);

      let written = 0;
      const kinds: Record<string, number> = {};
      for (const d of drafts) {
        const prior = await q<Array<{ id: string; status: string }>>(db.from("insights").select("id, status").eq("brand_id", a.brandId).eq("fingerprint", d.fingerprint).in("status", ["new", "accepted", "dismissed"]).order("created_at", { ascending: false }).limit(1));
        if (prior[0]?.status === "dismissed") continue;   // a dismissed insight isn't raised again
        const row = { title: d.title, body: d.body, evidence: d.evidence, confidence: Number(d.confidence.toFixed(2)), guidance: d.guidance ?? null, applies_to: d.appliesTo ?? {}, period_end: isoDay(now()), period_start: isoDay(new Date(now().getTime() - 90 * DAY)) };
        if (prior[0]) await q(db.from("insights").update(row).eq("id", prior[0].id));
        else await q(db.from("insights").insert({ workspace_id: a.workspaceId, brand_id: a.brandId, kind: d.kind, fingerprint: d.fingerprint, status: "new", ...row }));
        written++;
        kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
      }
      return { written, kinds };
    },
  };

  // ---------------------------------------------------------------- helpers
  async function postFacts(workspaceId: string, brandId: string | null, days: number): Promise<PostFacts[]> {
    let sq = db.from("schedules").select("id, brand_id, content_item_id, content_version_id, published_at, account:connected_accounts(channel)").eq("workspace_id", workspaceId).eq("status", "published")
      .gte("published_at", new Date(now().getTime() - days * DAY).toISOString()).limit(2000);
    if (brandId) sq = sq.eq("brand_id", brandId);
    const scheds = await q<Array<{ id: string; brand_id: string; content_item_id: string; content_version_id: string | null; published_at: string; account: { channel: string } | null }>>(sq);
    if (!scheds.length) return [];
    const metrics = await q<Array<Row & { schedule_id: string; metric_date: string }>>(db.from("performance_metrics").select("*").eq("workspace_id", workspaceId).eq("kind", "post").in("schedule_id", scheds.map((s) => s.id)));
    const latest = new Map<string, Row>();
    for (const m of metrics) { const cur = latest.get(m.schedule_id); if (!cur || String(cur.metric_date) < m.metric_date) latest.set(m.schedule_id, m); }
    const versions = await q<Array<{ id: string; body: { doc?: ContentDoc; video?: unknown; images?: string[]; scene?: { exportAssetId?: string } }; media_asset_ids: string[] | null }>>(
      db.from("content_versions").select("id, body, media_asset_ids").in("id", scheds.map((s) => s.content_version_id).filter((x): x is string => !!x)));
    const vById = new Map(versions.map((v) => [v.id, v]));
    const items = await q<Array<{ id: string; title: string | null; type: string; campaign_id: string | null }>>(db.from("content_items").select("id, title, type, campaign_id").in("id", [...new Set(scheds.map((s) => s.content_item_id))]));
    const iById = new Map(items.map((i) => [i.id, i]));
    const out: PostFacts[] = [];
    for (const s of scheds) {
      const m = latest.get(s.id);
      if (!m) continue;
      const v = s.content_version_id ? vById.get(s.content_version_id) : undefined;
      const item = iById.get(s.content_item_id);
      const doc = v?.body?.doc ?? { format: 1 as const, blocks: [] };
      const text = item ? postText(item.type, doc).text : docText(doc);
      const mediaKind = v?.body?.video ? "video" : (v?.body?.images?.length || v?.body?.scene?.exportAssetId || v?.media_asset_ids?.length) ? "image" : "text";
      const values: MetricValues = {};
      for (const k of ["impressions", "reach", "video_views", "engagements", "likes", "comments", "shares", "saves", "clicks"] as const) if (m[k] != null) values[k] = Number(m[k]);
      out.push({
        scheduleId: s.id, contentItemId: s.content_item_id, title: item?.title ?? null, channel: s.account?.channel ?? "unknown", contentType: item?.type ?? "social_post",
        campaignId: item?.campaign_id ?? null, topicId: (m.topic_id as string | null) ?? null, publishedAt: s.published_at, textLength: [...text].length, hashtags: extractHashtags(text).length, mediaKind, metrics: values,
      });
    }
    return out;
  }

  async function siteTrends(workspaceId: string, brandId: string): Promise<InsightDraft[]> {
    const since = isoDay(new Date(now().getTime() - 28 * DAY));
    const rows = await q<Array<{ metric_date: string; visits: number | null; conversions: number | null }>>(db.from("performance_metrics").select("metric_date, visits, conversions").eq("workspace_id", workspaceId).eq("brand_id", brandId).eq("kind", "site").gte("metric_date", since));
    const by = new Map<string, { visits: number; conversions: number }>();
    for (const r of rows) { const t = by.get(r.metric_date) ?? { visits: 0, conversions: 0 }; t.visits += r.visits ?? 0; t.conversions += r.conversions ?? 0; by.set(r.metric_date, t); }
    const days = Array.from({ length: 28 }, (_, i) => isoDay(new Date(now().getTime() - (27 - i) * DAY)));
    const out: InsightDraft[] = [];
    if (by.size < 10) return out;
    for (const metric of ["visits", "conversions"] as const) {
      const series = days.map((d) => by.get(d)?.[metric] ?? 0);
      const t = compareWindows(metric, series.slice(14), series.slice(0, 14));
      if (!t.significant || t.change === null) continue;
      out.push({
        kind: "trend", fingerprint: `trend:site:${metric}:${t.direction}:${isoDay(now()).slice(0, 7)}`, title: `Website ${metric} ${t.direction === "up" ? "up" : "down"} ${Math.abs(Math.round(t.change * 100))}% in the last two weeks`,
        body: `${t.current.toLocaleString("en-IN")} vs ${t.previous.toLocaleString("en-IN")} in the two weeks before (consistent across days, t = ${t.t?.toFixed(1)}).`,
        confidence: Math.min(0.9, 0.5 + Math.abs(t.t ?? 0) * 0.05), evidence: { metric, current: t.current, previous: t.previous, t: t.t },
      });
    }
    return out;
  }

  /** AI draft vs approved text for approved items of the last 180 days. */
  async function editLearning(workspaceId: string, brandId: string) {
    const items = await q<Array<{ id: string; type: string; channel: string | null; approved_version_id: string | null }>>(db.from("content_items").select("id, type, channel, approved_version_id").eq("workspace_id", workspaceId).eq("brand_id", brandId)
      .not("approved_version_id", "is", null).gte("updated_at", new Date(now().getTime() - 180 * DAY).toISOString()).limit(300));
    if (!items.length) return { proposals: [] as InsightDraft[] };
    const versions = await q<Array<{ id: string; content_item_id: string; version: number; origin: string; body: { doc?: ContentDoc } }>>(db.from("content_versions").select("id, content_item_id, version, origin, body").in("content_item_id", items.map((i) => i.id)).order("version"));
    const signals = await q<Array<{ content_item_id: string; edit_class: string | null }>>(db.from("learning_signals").select("content_item_id, edit_class").eq("workspace_id", workspaceId).eq("brand_id", brandId).eq("signal", "edit").in("content_item_id", items.map((i) => i.id)));
    const pairs = items.flatMap((it) => {
      const vs = versions.filter((v) => v.content_item_id === it.id);
      const ai = vs.find((v) => v.origin === "ai");
      const fin = vs.find((v) => v.id === it.approved_version_id);
      if (!ai?.body?.doc || !fin?.body?.doc) return [];
      return [{ contentItemId: it.id, channel: it.channel, aiText: postText(it.type, ai.body.doc).text, finalText: postText(it.type, fin.body.doc).text,
        editClasses: [...new Set(signals.filter((s) => s.content_item_id === it.id).flatMap((s) => (s.edit_class ?? "").split(",").filter(Boolean)))] }];
    });
    const brand = await q<{ active_kit_version_id: string | null }>(db.from("brands").select("active_kit_version_id").eq("id", brandId).single());
    const kit = brand.active_kit_version_id ? await q<{ kit: { facts?: Record<string, { value?: unknown }> } }>(db.from("brand_kit_versions").select("kit").eq("id", brand.active_kit_version_id).single()) : null;
    const list = (k: string) => (Array.isArray(kit?.kit?.facts?.[k]?.value) ? (kit!.kit.facts![k]!.value as string[]) : []);
    return analyzeEdits(pairs, { banned: list("vocabulary.banned"), preferred: list("vocabulary.preferred") });
  }

  async function firstAiJob(contentItemId: string): Promise<string | null> {
    const r = await q<Array<{ generation_job_id: string | null }>>(db.from("content_versions").select("generation_job_id").eq("content_item_id", contentItemId).eq("origin", "ai").order("version").limit(1));
    return r[0]?.generation_job_id ?? null;
  }

  /** Human-review outcomes as Langfuse scores on the generation's trace (idempotent score ids). */
  async function pushQualityScores(workspaceId: string, brandId: string) {
    if (!deps.langfuse) return;
    const rows = await qualityRows(db, workspaceId, brandId, 30);
    for (const r of rows) {
      if (!r.jobId || r.firstPassApproved === null) continue;
      await deps.langfuse.score({ id: `${r.jobId}-first-pass`, traceId: traceIdForJob(r.jobId), name: "approved_first_pass", value: r.firstPassApproved ? 1 : 0, dataType: "BOOLEAN" }).catch(() => undefined);
      await deps.langfuse.score({ id: `${r.jobId}-edited`, traceId: traceIdForJob(r.jobId), name: "human_edited", value: r.edited ? 1 : 0, dataType: "BOOLEAN" }).catch(() => undefined);
    }
  }
}

/** Per-item quality facts for AI-generated content (shared with the API's learning summary). */
export async function qualityRows(db: Db, workspaceId: string, brandId: string, days: number): Promise<Array<QualityRow & { jobId: string | null; contentItemId: string }>> {
  const since = new Date(Date.now() - days * DAY).toISOString();
  const items = await db.from("content_items").select("id, status, approved_version_id").eq("workspace_id", workspaceId).eq("brand_id", brandId).gte("created_at", since).limit(1000);
  if (items.error) throw fromDbError(items.error);
  const ids = (items.data ?? []).map((i) => i.id as string);
  if (!ids.length) return [];
  const [versions, signals] = await Promise.all([
    db.from("content_versions").select("id, content_item_id, version, origin, prompt_template, model, generation_job_id").in("content_item_id", ids).order("version"),
    db.from("learning_signals").select("content_item_id, signal, value").eq("workspace_id", workspaceId).in("content_item_id", ids).in("signal", ["edit", "regenerate", "reject", "request_changes", "approve", "engagement_outcome"]),
  ]);
  if (versions.error) throw fromDbError(versions.error);
  if (signals.error) throw fromDbError(signals.error);
  const out: Array<QualityRow & { jobId: string | null; contentItemId: string }> = [];
  for (const it of items.data ?? []) {
    const vs = (versions.data ?? []).filter((v) => v.content_item_id === it.id);
    const ai = vs.find((v) => v.origin === "ai" && v.prompt_template);
    if (!ai) continue;
    const sig = (signals.data ?? []).filter((s) => s.content_item_id === it.id);
    const outcome = sig.find((s) => s.signal === "engagement_outcome");
    const reviewed = sig.some((s) => ["approve", "reject", "request_changes"].includes(s.signal as string));
    out.push({
      contentItemId: it.id as string, jobId: (ai.generation_job_id as string | null) ?? null, template: ai.prompt_template as string, model: (ai.model as string | null) ?? "unknown",
      firstPassApproved: reviewed ? it.approved_version_id === ai.id : null, edited: sig.some((s) => s.signal === "edit"), regenerations: sig.filter((s) => s.signal === "regenerate").length,
      rejected: sig.some((s) => s.signal === "reject"), engagementScore: outcome ? Number(outcome.value) : null,
    });
  }
  return out;
}

export const qualitySummary = async (db: Db, workspaceId: string, brandId: string, days: number) => summarizeQuality(await qualityRows(db, workspaceId, brandId, days));

export type AnalyticsActivities = ReturnType<typeof createAnalyticsActivities>;
export { ApplicationFailure };
