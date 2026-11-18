import {
  AD_OBJECTIVES, AdAudienceSchema, AdCampaignDraftSchema, AdPolicySchema, AppError, GoogleCreativeSchema, MetaCreativeSchema, actionSummary, allowedActions,
  canArchive, canEditCreative, checkCompliance, confirmPhrase, docFrom, estimateCredits, fromDbError, isoDay, projectedMonthlyMinor, seedGoogleCreative,
  seedMetaCreative, spendLevel, CRITICAL_ACTIONS, type AdAction, type AdStatus, type ComplianceReport, type ContentDoc,
} from "@arcatic/core";
import { readSecret } from "@arcatic/jobs/publishing";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { body, check, idempotencyKey, ok } from "../http.js";
import { startCostedJob } from "../job-start.js";
import { requirePermission as can } from "../middleware/workspace.js";
import type { ApiDeps, AppEnv } from "../types.js";

/**
 * Paid ads: HIGH RISK. Rules enforced here and again in the database and the worker:
 *  - nothing reaches an ad platform unless an owner switched on management for that ad account
 *  - every critical action (create, activate, raise or change budget) is a request that someone
 *    with ads.approve approves by typing a confirmation phrase; by default not the requester
 *  - any edit to the campaign cancels outstanding approvals (revision check)
 *  - campaigns are created PAUSED; budgets are capped per account; spend can auto-pause at a cap
 *  - pausing and ending are always allowed (they only reduce spend)
 */
const CAMPAIGN_COLS = "id, brand_id, connection_id, platform, name, objective, status, brief, audience, creative, landing_url, daily_budget_minor, currency, start_date, end_date, special_ad_categories, compliance, revision, external, source_content_item_id, last_error, created_by, created_at, updated_at";
const ACTION_COLS = "id, campaign_id, action, payload, campaign_revision, summary, status, requested_by, decided_by, decided_at, executed_at, result, error, created_at";

type Campaign = {
  id: string; brand_id: string; connection_id: string; platform: "google" | "meta"; name: string; objective: string; status: AdStatus; brief: Record<string, unknown>;
  audience: unknown; creative: Record<string, unknown>; landing_url: string | null; daily_budget_minor: number | null; currency: string; start_date: string | null; end_date: string | null;
  special_ad_categories: string[]; compliance: ComplianceReport | null; revision: number; external: Record<string, string>; source_content_item_id: string | null;
};
type Policy = { connection_id: string; manage_enabled: boolean; max_daily_budget_minor: number; monthly_spend_cap_minor: number | null; auto_pause_on_cap: boolean; require_separate_approver: boolean; page_id: string | null; instagram_user_id: string | null; currency: string };
type Conn = { id: string; provider: "google_ads" | "meta_ads"; account_ref: string; display_name: string | null; brand_id: string | null; status: string; secret_id: string | null; settings: { loginCustomerId?: string } };

function maybe<T>(res: { data: T; error: { message: string; code?: string } | null }): T | null {
  if (res.error) throw fromDbError(res.error);
  return res.data ?? null;
}
const platformOf = (provider: string) => (provider === "google_ads" ? "google" : "meta");

export const adsRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  const ws = (c: Context<AppEnv>) => c.get("workspaceId");
  const brandId = (c: Context<AppEnv>) => c.req.param("brandId")!;
  const actor = (c: Context<AppEnv>) => { const p = c.get("principal"); return p.kind === "user" ? p.userId : null; };
  const svc = () => deps.serviceDb();
  const userOnly = (c: Context<AppEnv>) => {
    const a = actor(c);
    if (!a) throw new AppError("forbidden", "Ad campaign changes need a signed-in person, not an API key.");
    return a;
  };

  async function connection(c: Context<AppEnv>, id: string) {
    const conn = maybe(await c.get("db").from("analytics_connections").select("id, provider, account_ref, display_name, brand_id, status, secret_id, settings").eq("workspace_id", ws(c)).eq("id", id).maybeSingle()) as Conn | null;
    if (!conn || (conn.provider !== "google_ads" && conn.provider !== "meta_ads")) throw new AppError("not_found", "Ad account not found.");
    return conn;
  }
  const policyFor = async (connectionId: string) => maybe(await svc().from("ad_account_policies").select("*").eq("connection_id", connectionId).maybeSingle()) as Policy | null;
  async function campaign(c: Context<AppEnv>, id = c.req.param("campaignId")!) {
    const row = maybe(await c.get("db").from("ad_campaigns").select(CAMPAIGN_COLS).eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).eq("id", id).maybeSingle()) as Campaign | null;
    if (!row) throw new AppError("not_found", "Campaign not found.");
    return row;
  }
  async function hasImage(c: Context<AppEnv>, creative: Record<string, unknown>) {
    const id = (creative as { mediaAssetId?: string | null }).mediaAssetId;
    if (!id) return false;
    const a = maybe(await c.get("db").from("media_assets").select("id, kind, status").eq("workspace_id", ws(c)).eq("id", id).maybeSingle()) as { kind: string; status: string } | null;
    return !!a && a.kind === "image" && a.status === "ready";
  }
  async function compliance(c: Context<AppEnv>, k: Campaign): Promise<ComplianceReport> {
    const p = await policyFor(k.connection_id);
    return checkCompliance({
      platform: k.platform, name: k.name, objective: k.objective, audience: AdAudienceSchema.safeParse(k.audience ?? {}).data ?? AdAudienceSchema.parse({}), creative: k.creative,
      landingUrl: k.landing_url, dailyBudgetMinor: k.daily_budget_minor, startDate: k.start_date, endDate: k.end_date, specialAdCategories: k.special_ad_categories,
      hasImage: k.platform === "meta" ? await hasImage(c, k.creative) : undefined,
      policy: p && { manageEnabled: p.manage_enabled, maxDailyBudgetMinor: p.max_daily_budget_minor, monthlySpendCapMinor: p.monthly_spend_cap_minor, autoPauseOnCap: p.auto_pause_on_cap },
    });
  }
  const validCreative = (platform: "google" | "meta", raw: unknown) => {
    const p = (platform === "google" ? GoogleCreativeSchema : MetaCreativeSchema).safeParse(raw ?? {});
    if (!p.success) throw new AppError("validation_failed", "Creative fields are invalid.", { details: p.error.issues });
    return p.data as Record<string, unknown>;
  };

  // ---------------------------------------------------------------- ad accounts and their guardrails (workspace level)
  r.get("/ads/accounts", can("ads.read"), async (c) => {
    const conns = check(await c.get("db").from("analytics_connections").select("id, provider, account_ref, display_name, brand_id, status, last_synced_at").eq("workspace_id", ws(c)).in("provider", ["google_ads", "meta_ads"])) as Array<{ id: string }>;
    const pols = conns.length ? check(await c.get("db").from("ad_account_policies").select("*").in("connection_id", conns.map((x) => x.id))) as Policy[] : [];
    return c.json({ data: conns.map((x) => ({ ...x, policy: pols.find((p) => p.connection_id === x.id) ?? null })), sidecar: !!deps.ads });
  });

  /**
   * Turning management on, or raising a limit, needs the ad account id typed back. Owners and
   * admins only (ads.approve); the change is audited.
   */
  r.put("/ads/accounts/:connectionId/policy", can("ads.approve"), async (c) => {
    const i = await body(c, AdPolicySchema.extend({ confirm: z.string().trim().max(60).optional() }));
    const who = userOnly(c);
    const conn = await connection(c, c.req.param("connectionId")!);
    const prev = await policyFor(conn.id);
    const raises = (i.manageEnabled && !prev?.manage_enabled) || i.maxDailyBudgetMinor > (prev?.max_daily_budget_minor ?? 0)
      || (prev?.monthly_spend_cap_minor != null && (i.monthlySpendCapMinor == null || i.monthlySpendCapMinor > prev.monthly_spend_cap_minor))
      || (prev?.require_separate_approver !== false && i.requireSeparateApprover === false) || (prev?.auto_pause_on_cap !== false && i.autoPauseOnCap === false);
    if (raises && (i.confirm ?? "").replace(/\D/g, "") !== conn.account_ref.replace(/\D/g, "")) {
      throw new AppError("validation_failed", "Type the ad account id to confirm this change.", { details: { confirm: conn.account_ref } });
    }
    if (conn.provider === "meta_ads" && i.manageEnabled && !i.pageId) throw new AppError("validation_failed", "Choose the Facebook Page these ads run as.");
    const row = {
      connection_id: conn.id, workspace_id: ws(c), manage_enabled: i.manageEnabled, max_daily_budget_minor: i.maxDailyBudgetMinor, monthly_spend_cap_minor: i.monthlySpendCapMinor ?? null,
      auto_pause_on_cap: i.autoPauseOnCap, require_separate_approver: i.requireSeparateApprover, page_id: i.pageId ?? null, instagram_user_id: i.instagramUserId ?? null,
      updated_by: who, updated_at: new Date().toISOString(),
    };
    const saved = check(await svc().from("ad_account_policies").upsert(row, { onConflict: "connection_id" }).select("*").single());
    return c.json(saved);
  });

  // ---------------------------------------------------------------- research helpers (sidecar, read-only)
  r.get("/ads/accounts/:connectionId/search", can("ads.manage"), async (c) => {
    if (!deps.ads) throw new AppError("conflict", "The ads-sync service isn't configured.");
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    if (q.length < 2) return c.json({ data: [] });
    const kind = c.req.query("kind") === "interest" ? "interest" : "geo";
    const conn = await connection(c, c.req.param("connectionId")!);
    const secret = (purpose: "google_ads_refresh_token" | "meta_access_token") => readSecret(svc(), { workspaceId: ws(c), secretId: conn.secret_id, purpose, key: deps.encryptionKey });
    if (conn.provider === "google_ads") {
      if (kind === "interest") throw new AppError("validation_failed", "Interest search is for Meta accounts.");
      const res = await deps.ads.googleGeoSuggest({ customerId: conn.account_ref, loginCustomerId: conn.settings?.loginCustomerId ?? null, refreshToken: await secret("google_ads_refresh_token"), query: q, countryCode: c.req.query("country") || undefined });
      return c.json({ data: res.locations.map((l) => ({ key: l.key, name: l.canonicalName || l.name, type: "geo_target", reach: l.reach })) });
    }
    const res = await deps.ads.metaSearch({ accessToken: await secret("meta_access_token"), kind, q });
    return c.json({ data: res.results });
  });

  // ---------------------------------------------------------------- campaigns
  r.get("/brands/:brandId/ads/campaigns", can("ads.read"), async (c) => {
    const rows = check(await c.get("db").from("ad_campaigns").select(CAMPAIGN_COLS).eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).neq("status", "archived").order("updated_at", { ascending: false }).limit(200)) as Campaign[];
    const pending = rows.length ? check(await c.get("db").from("ad_actions").select("campaign_id, action, status").in("campaign_id", rows.map((x) => x.id)).in("status", ["pending", "approved", "executing"])) as Array<{ campaign_id: string; action: string; status: string }> : [];
    return c.json({ data: rows.map((x) => ({ ...x, openRequest: pending.find((p) => p.campaign_id === x.id) ?? null })), objectives: AD_OBJECTIVES });
  });

  r.post("/brands/:brandId/ads/campaigns", can("ads.manage"), async (c) => {
    const i = await body(c, AdCampaignDraftSchema);
    const who = userOnly(c);
    const conn = await connection(c, i.connectionId);
    if (platformOf(conn.provider) !== i.platform) throw new AppError("validation_failed", `Pick a ${i.platform === "google" ? "Google Ads" : "Meta"} ad account.`);
    if (conn.brand_id && conn.brand_id !== brandId(c)) throw new AppError("forbidden", "That ad account belongs to another brand.");
    if (!(i.objective in AD_OBJECTIVES[i.platform])) throw new AppError("validation_failed", "Unsupported objective.");
    if (i.sourceContentItemId) {
      const src = maybe(await c.get("db").from("content_items").select("id").eq("brand_id", brandId(c)).eq("id", i.sourceContentItemId).maybeSingle());
      if (!src) throw new AppError("not_found", "Source content not found.");
    }
    const pol = await policyFor(conn.id);
    const row = {
      workspace_id: ws(c), brand_id: brandId(c), connection_id: conn.id, platform: i.platform, name: i.name, objective: i.objective, brief: i.brief, audience: i.audience,
      creative: validCreative(i.platform, i.creative), landing_url: i.landingUrl ?? null, daily_budget_minor: i.dailyBudgetMinor ?? null, currency: pol?.currency ?? "INR",
      start_date: i.startDate ?? null, end_date: i.endDate ?? null, special_ad_categories: i.platform === "meta" ? i.specialAdCategories : [], source_content_item_id: i.sourceContentItemId ?? null, created_by: who,
    };
    const ins = check(await svc().from("ad_campaigns").insert(row).select(CAMPAIGN_COLS).single()) as Campaign;
    const report = await compliance(c, ins);
    ok(await svc().from("ad_campaigns").update({ compliance: report }).eq("id", ins.id));
    return c.json({ ...ins, compliance: report }, 201);
  });

  /** Organic → paid: a draft seeded from a post's current version (best: one that performed well). */
  r.post("/brands/:brandId/ads/promote", can("ads.manage"), async (c) => {
    const i = await body(c, z.object({ contentItemId: z.uuid(), connectionId: z.uuid(), dailyBudgetMinor: z.number().int().positive().optional() }));
    const who = userOnly(c);
    const conn = await connection(c, i.connectionId);
    if (conn.brand_id && conn.brand_id !== brandId(c)) throw new AppError("forbidden", "That ad account belongs to another brand.");
    const it = maybe(await c.get("db").from("content_items").select("id, title, current_version_id").eq("brand_id", brandId(c)).eq("id", i.contentItemId).maybeSingle()) as { id: string; title: string | null; current_version_id: string | null } | null;
    if (!it?.current_version_id) throw new AppError("not_found", "Content not found.");
    const v = check(await c.get("db").from("content_versions").select("body, media_asset_ids").eq("id", it.current_version_id).single()) as { body: { doc?: ContentDoc; images?: string[] }; media_asset_ids: string[] | null };
    const doc = v.body.doc ?? docFrom([]);
    const platform = platformOf(conn.provider);
    const published = maybe(await c.get("db").from("schedules").select("external_url").eq("content_item_id", it.id).eq("status", "published").not("external_url", "is", null).limit(1).maybeSingle()) as { external_url: string } | null;
    const image = [...(v.body.images ?? []), ...(v.media_asset_ids ?? [])][0] ?? null;
    const creative = platform === "google" ? seedGoogleCreative(doc) : { ...seedMetaCreative(doc), mediaAssetId: image };
    const pol = await policyFor(conn.id);
    const ins = check(await svc().from("ad_campaigns").insert({
      workspace_id: ws(c), brand_id: brandId(c), connection_id: conn.id, platform, name: `Promote: ${(it.title ?? "post").slice(0, 180)}`, objective: platform === "google" ? "website_traffic" : "traffic",
      brief: { goal: "Reach more people with a post that already performed well" }, audience: AdAudienceSchema.parse({}), creative, landing_url: published?.external_url?.startsWith("https://") ? published.external_url : null,
      daily_budget_minor: i.dailyBudgetMinor ?? null, currency: pol?.currency ?? "INR", source_content_item_id: it.id, created_by: who,
    }).select(CAMPAIGN_COLS).single()) as Campaign;
    return c.json(ins, 201);
  });

  r.get("/brands/:brandId/ads/campaigns/:campaignId", can("ads.read"), async (c) => {
    const k = await campaign(c);
    const actions = check(await c.get("db").from("ad_actions").select(ACTION_COLS).eq("campaign_id", k.id).order("created_at", { ascending: false }).limit(50));
    const pol = await policyFor(k.connection_id);
    return c.json({ ...k, actions, policy: pol, allowedActions: allowedActions(k.status), confirmFor: { launch: confirmPhrase("launch", k), activate: confirmPhrase("activate", k) } });
  });

  r.patch("/brands/:brandId/ads/campaigns/:campaignId", can("ads.manage"), async (c) => {
    const i = await body(c, AdCampaignDraftSchema.omit({ connectionId: true, platform: true, sourceContentItemId: true }).partial().extend({ status: z.literal("archived").optional() }));
    userOnly(c);
    const k = await campaign(c);
    if (i.status === "archived") {
      if (!canArchive(k.status)) throw new AppError("conflict", "End the campaign before archiving it.");
      ok(await svc().from("ad_campaigns").update({ status: "archived", revision: k.revision + 1 }).eq("id", k.id));
      return c.json({ id: k.id, status: "archived" });
    }
    if (!canEditCreative(k.status)) throw new AppError("conflict", "A campaign that exists on the platform can only be paused, ended or have its budget changed. Duplicate it to change the ads.");
    if (i.objective && !(i.objective in AD_OBJECTIVES[k.platform])) throw new AppError("validation_failed", "Unsupported objective.");
    const next: Campaign = {
      ...k, ...(i.name && { name: i.name }), ...(i.objective && { objective: i.objective }), ...(i.brief && { brief: i.brief }), ...(i.audience && { audience: i.audience }),
      ...(i.creative && { creative: validCreative(k.platform, i.creative) }), ...(i.landingUrl !== undefined && { landing_url: i.landingUrl }),
      ...(i.dailyBudgetMinor !== undefined && { daily_budget_minor: i.dailyBudgetMinor }), ...(i.startDate !== undefined && { start_date: i.startDate }),
      ...(i.endDate !== undefined && { end_date: i.endDate }), ...(i.specialAdCategories && { special_ad_categories: k.platform === "meta" ? i.specialAdCategories : [] }),
    };
    const report = await compliance(c, next);
    // revision bump: every outstanding approval for the old version is cancelled (DB trigger)
    const up = await svc().from("ad_campaigns").update({
      name: next.name, objective: next.objective, brief: next.brief, audience: next.audience, creative: next.creative, landing_url: next.landing_url, daily_budget_minor: next.daily_budget_minor,
      start_date: next.start_date, end_date: next.end_date, special_ad_categories: next.special_ad_categories, compliance: report, revision: k.revision + 1,
    }).eq("id", k.id).eq("revision", k.revision).select(CAMPAIGN_COLS).maybeSingle();
    if (up.error) throw fromDbError(up.error);
    if (!up.data) throw new AppError("conflict", "Someone else changed this campaign; reload and try again.");
    return c.json(up.data);
  });

  r.post("/brands/:brandId/ads/campaigns/:campaignId/check", can("ads.manage"), async (c) => {
    const k = await campaign(c);
    const report = await compliance(c, k);
    ok(await svc().from("ad_campaigns").update({ compliance: report }).eq("id", k.id).eq("revision", k.revision));
    return c.json(report);
  });

  r.post("/brands/:brandId/ads/campaigns/:campaignId/draft", can("ads.manage"), async (c) => {
    const k = await campaign(c);
    if (!canEditCreative(k.status)) throw new AppError("conflict", "Only draft campaigns can be drafted with AI.");
    const res = await startCostedJob(deps, c, {
      idempotencyKey: idempotencyKey(c), kind: "ads.draft", brandId: brandId(c), cost: estimateCredits({ kind: "ads.draft" }), input: { campaignId: k.id },
      start: (s, a) => s.adsDraft({ ...a, workspaceId: ws(c), campaignId: k.id, requestedBy: actor(c) ?? undefined }),
    });
    return c.json({ job: res.job, credits: res.credits }, 202);
  });

  // ---------------------------------------------------------------- requests and approvals
  r.post("/brands/:brandId/ads/campaigns/:campaignId/actions", can("ads.manage"), async (c) => {
    const i = await body(c, z.object({ action: z.enum(["launch", "activate", "pause", "budget_change", "end"]), dailyBudgetMinor: z.number().int().positive().max(1_000_000_000).optional() }));
    const who = userOnly(c);
    const k = await campaign(c);
    const action = i.action as AdAction;
    if (!allowedActions(k.status).includes(action)) throw new AppError("conflict", `A ${k.status} campaign can't be asked to ${action.replace("_", " ")}.`);
    const pol = await policyFor(k.connection_id);
    if (CRITICAL_ACTIONS.has(action) && !pol?.manage_enabled) throw new AppError("forbidden", "An owner must switch on campaign management for this ad account first.");
    const payload: Record<string, unknown> = {};
    if (action === "launch") {
      const report = await compliance(c, k);
      ok(await svc().from("ad_campaigns").update({ compliance: report }).eq("id", k.id).eq("revision", k.revision));
      if (!report.passed) throw new AppError("validation_failed", "Fix the blocking issues before requesting a launch.", { details: report.issues.filter((x) => x.severity === "error") });
    }
    if (action === "budget_change") {
      if (!i.dailyBudgetMinor) throw new AppError("validation_failed", "Give the new daily budget.");
      if (i.dailyBudgetMinor === k.daily_budget_minor) throw new AppError("validation_failed", "That's the current budget.");
      if (pol && i.dailyBudgetMinor > pol.max_daily_budget_minor) throw new AppError("validation_failed", "Above this ad account's daily budget limit.");
      payload.dailyBudgetMinor = i.dailyBudgetMinor;
      payload.previousMinor = k.daily_budget_minor;
      payload.projectedMonthlyMinor = projectedMonthlyMinor(i.dailyBudgetMinor);
    }
    const confirm = confirmPhrase(action, k, { dailyBudgetMinor: i.dailyBudgetMinor });
    if (confirm) payload.confirm = confirm;
    const ins = await svc().from("ad_actions").insert({
      workspace_id: ws(c), campaign_id: k.id, action, payload, campaign_revision: k.revision, requested_by: who,
      summary: actionSummary(action, { name: k.name, platform: k.platform, dailyBudgetMinor: k.daily_budget_minor, currency: k.currency }, { dailyBudgetMinor: i.dailyBudgetMinor }),
    }).select(ACTION_COLS).single();
    if (ins.error?.code === "23505") throw new AppError("conflict", "There's already an open request for this campaign.");
    if (ins.error) throw fromDbError(ins.error);
    const act = ins.data as { id: string };
    if (!CRITICAL_ACTIONS.has(action)) {
      // pause / end: the requester's own click is the approval; executes right away
      const d = await svc().rpc("decide_ad_action", { p_action: act.id, p_decision: "approved", p_actor: who, p_confirmation: null });
      if (d.error) throw fromDbError(d.error);
      await (await deps.jobs()).adAction({ actionId: act.id, workspaceId: ws(c) });
      return c.json({ ...ins.data, status: "approved" }, 202);
    }
    return c.json(ins.data, 201);
  });

  r.get("/brands/:brandId/ads/requests", can("ads.read"), async (c) => {
    const rows = check(await c.get("db").from("ad_actions").select(`${ACTION_COLS}, campaign:ad_campaigns(id, name, platform, brand_id, daily_budget_minor, currency)`).eq("workspace_id", ws(c)).eq("status", "pending").order("created_at", { ascending: true }).limit(100)) as unknown as Array<{ campaign: { brand_id: string } | Array<{ brand_id: string }> | null }>;
    const brandOf = (x: (typeof rows)[number]) => (Array.isArray(x.campaign) ? x.campaign[0]?.brand_id : x.campaign?.brand_id);
    return c.json({ data: rows.filter((x) => brandOf(x) === brandId(c)) });
  });

  r.post("/brands/:brandId/ads/requests/:actionId/decide", can("ads.approve"), async (c) => {
    const i = await body(c, z.object({ decision: z.enum(["approved", "rejected"]), confirmation: z.string().trim().max(200).optional() }));
    const who = userOnly(c);
    const act = maybe(await c.get("db").from("ad_actions").select("id, campaign_id, status").eq("workspace_id", ws(c)).eq("id", c.req.param("actionId")!).maybeSingle()) as { id: string; campaign_id: string; status: string } | null;
    if (!act) throw new AppError("not_found", "Request not found.");
    await campaign(c, act.campaign_id);   // brand scope
    const d = await svc().rpc("decide_ad_action", { p_action: act.id, p_decision: i.decision, p_actor: who, p_confirmation: i.confirmation ?? null });
    if (d.error) throw fromDbError(d.error);
    if (i.decision === "approved") await (await deps.jobs()).adAction({ actionId: act.id, workspaceId: ws(c) });
    return c.json(d.data, i.decision === "approved" ? 202 : 200);
  });

  r.post("/brands/:brandId/ads/requests/:actionId/cancel", can("ads.manage"), async (c) => {
    const who = userOnly(c);
    const act = maybe(await c.get("db").from("ad_actions").select("id, campaign_id, status, requested_by").eq("workspace_id", ws(c)).eq("id", c.req.param("actionId")!).maybeSingle()) as { id: string; campaign_id: string; status: string; requested_by: string | null } | null;
    if (!act) throw new AppError("not_found", "Request not found.");
    await campaign(c, act.campaign_id);
    if (act.status !== "pending") throw new AppError("conflict", `This request is ${act.status}.`);
    if (act.requested_by !== who && !["owner", "admin"].includes(c.get("role"))) throw new AppError("forbidden", "Only the requester or an admin can withdraw a request.");
    ok(await svc().from("ad_actions").update({ status: "cancelled", decided_by: who, decided_at: new Date().toISOString() }).eq("id", act.id).eq("status", "pending"));
    return c.json({ id: act.id, status: "cancelled" });
  });

  // ---------------------------------------------------------------- reporting (from the Phase 8 ad sync)
  r.get("/brands/:brandId/ads/campaigns/:campaignId/report", can("ads.read"), async (c) => {
    const k = await campaign(c);
    const days = Math.min(90, Math.max(7, Number(c.req.query("days") ?? 30) || 30));
    if (!k.external?.campaignId) return c.json({ days, series: [], totals: null, note: "Not on the platform yet." });
    const from = isoDay(new Date(Date.now() - (days - 1) * 86_400_000));
    const rows = check(await c.get("db").from("performance_metrics").select("metric_date, impressions, clicks, spend_minor, conversions, conversion_value_minor, reach")
      .eq("workspace_id", ws(c)).eq("kind", "ad").eq("metric_key", `ad:${k.connection_id}:${k.external.campaignId}`).gte("metric_date", from).order("metric_date", { ascending: true })) as Array<Record<string, number | string | null>>;
    const sum = (f: string) => rows.reduce((s, x) => s + Number(x[f] ?? 0), 0);
    const t = { impressions: sum("impressions"), clicks: sum("clicks"), spendMinor: sum("spend_minor"), conversions: sum("conversions"), conversionValueMinor: sum("conversion_value_minor") };
    const month = check(await c.get("db").from("performance_metrics").select("spend_minor").eq("workspace_id", ws(c)).eq("kind", "ad").like("metric_key", `ad:${k.connection_id}:%`).gte("metric_date", `${isoDay(new Date()).slice(0, 8)}01`)) as Array<{ spend_minor: number | null }>;
    const pol = await policyFor(k.connection_id);
    const accountMonthMinor = month.reduce((s, x) => s + Number(x.spend_minor ?? 0), 0);
    return c.json({
      days, currency: k.currency,
      series: rows.map((x) => ({ date: x.metric_date, impressions: Number(x.impressions ?? 0), clicks: Number(x.clicks ?? 0), spendMinor: Number(x.spend_minor ?? 0), conversions: Number(x.conversions ?? 0) })),
      totals: { ...t, ctr: t.impressions ? t.clicks / t.impressions : null, cpcMinor: t.clicks ? Math.round(t.spendMinor / t.clicks) : null, cpaMinor: t.conversions ? Math.round(t.spendMinor / t.conversions) : null, roas: t.spendMinor ? t.conversionValueMinor / t.spendMinor : null },
      account: { monthSpendMinor: accountMonthMinor, capMinor: pol?.monthly_spend_cap_minor ?? null, level: spendLevel(accountMonthMinor, pol?.monthly_spend_cap_minor) },
    });
  });

  return r;
};
