import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { seoArticleCost } from "../src/routes/seo.js";
import type { ApiDeps, Membership } from "../src/types.js";
import { fakeDb } from "./fake-db.js";

const WS = "11111111-1111-4111-8111-111111111111";
const BRAND = "33333333-3333-4333-8333-333333333333";
const CONN = "44444444-4444-4444-8444-444444444444";
const CAMP = "55555555-5555-4555-8555-555555555555";
const ACT = "66666666-6666-4666-8666-666666666666";
const CI = "77777777-7777-4777-8777-777777777777";

function setup(role: Membership["role"], tables: Record<string, unknown[]>, opts: { rpc?: Record<string, unknown>; ads?: boolean; apiKey?: boolean; resolve?: string[] } = {}) {
  const user = fakeDb(tables);
  const svc = fakeDb(tables, { reserve_credits: { id: "res1", amount: 20, status: "held" }, ...opts.rpc });
  const starter = { keywordResearch: vi.fn(async () => undefined), competitorResearch: vi.fn(async () => undefined), seoArticle: vi.fn(async () => undefined), adsDraft: vi.fn(async () => undefined), adAction: vi.fn(async () => "wf") };
  const deps: ApiDeps = {
    corsOrigins: [], verifyJwt: async () => ({ sub: "u1" }), resolveMembership: async () => ({ role, brandRestricted: false }),
    resolveApiKey: async () => (opts.apiKey ? { kind: "api_key", keyId: "k", workspaceId: WS, role, scopes: [] } : null),
    userDb: () => user.db, serviceDb: () => svc.db, jobs: (async () => starter) as never, resolveHost: async () => opts.resolve ?? ["93.184.216.34"],
    ads: opts.ads ? ({ metaSearch: vi.fn(async () => ({ results: [{ id: "6003", name: "Cooking" }] })) } as never) : null, encryptionKey: Buffer.alloc(32, 1).toString("base64"),
  };
  const app = buildApp(deps);
  const call = (method: string, path: string, payload?: unknown, base = `/v1/workspaces/${WS}/brands/${BRAND}`) => app.request(`${base}${path}`, {
    method, body: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { authorization: opts.apiKey ? "Bearer ak_live_x" : "Bearer t", ...(opts.apiKey && { "x-api-key": "ak_live_x" }), "content-type": "application/json", "idempotency-key": "key-0000000001" },
  });
  return { call, svc, starter, wsCall: (m: string, p: string, b?: unknown) => call(m, p, b, `/v1/workspaces/${WS}`) };
}

const brand = { id: BRAND, name: "Annapurna", website_url: "https://annapurna.example", languages: ["en"] };
const google = { id: CONN, provider: "google_ads", account_ref: "123-456-7890", display_name: "Ads", brand_id: null, status: "active", secret_id: "s", settings: {} };
const policy = { connection_id: CONN, manage_enabled: true, max_daily_budget_minor: 100_000, monthly_spend_cap_minor: null, auto_pause_on_cap: true, require_separate_approver: true, page_id: null, instagram_user_id: null, currency: "INR" };
const campaign = (over: Record<string, unknown> = {}) => ({
  id: CAMP, workspace_id: WS, brand_id: BRAND, connection_id: CONN, platform: "google", name: "Tiffin search", objective: "website_traffic", status: "draft", brief: {},
  audience: { locations: [{ key: "2356", name: "India", type: "country" }], keywords: [{ text: "tiffin service", match: "PHRASE" }], ageMin: 18, ageMax: 65, genders: [], interests: [], negativeKeywords: [] },
  creative: { headlines: ["Home-style tiffins", "Delivered to your desk", "First week free"], descriptions: ["Fresh lunch every weekday in Pune.", "Veg and non-veg plans, pause anytime."] },
  landing_url: "https://annapurna.example/tiffin", daily_budget_minor: 50_000, currency: "INR", start_date: null, end_date: null, special_ad_categories: [], compliance: null, revision: 3, external: {}, source_content_item_id: null, ...over,
});

describe("SEO API", () => {
  it("prices a research-backed article as brief + blog", () => expect(seoArticleCost()).toEqual({ estimate: 11, max: 16.5 }));

  it("keyword research: AI suggestions by default; Keyword Planner only with a Google Ads account and the sidecar", async () => {
    const t = { brands: [brand], keyword_sets: [{ id: "ks1" }], analytics_connections: [google] };
    const a = setup("editor", t);
    expect((await a.call("POST", "/seo/keyword-sets", { name: "Tiffins", seeds: ["tiffin service"] })).status).toBe(202);
    expect(a.svc.ops.find((o) => o.table === "keyword_sets" && o.op === "insert")!.payload).toMatchObject({ source: "ai_suggested", language: "en" });
    expect(a.starter.keywordResearch).toHaveBeenCalledWith(expect.objectContaining({ keywordSetId: "ks1", chargeCredits: 2 }));

    expect((await setup("editor", t).call("POST", "/seo/keyword-sets", { name: "T", seeds: ["x"], connectionId: CONN })).status).toBe(409);   // no sidecar
    const b = setup("editor", t, { ads: true });
    expect((await b.call("POST", "/seo/keyword-sets", { name: "T", seeds: ["x"], connectionId: CONN, locationIds: ["2356"] })).status).toBe(202);
    expect(b.svc.ops.find((o) => o.table === "keyword_sets" && o.op === "insert")!.payload).toMatchObject({ source: "google_ads_keyword_planner" });
    const meta = setup("editor", { ...t, analytics_connections: [{ ...google, provider: "meta_ads" }] }, { ads: true });
    expect((await meta.call("POST", "/seo/keyword-sets", { name: "T", seeds: ["x"], connectionId: CONN })).status).toBe(422);
    expect((await setup("editor", t).call("POST", "/seo/keyword-sets", { name: "T", seeds: [] })).status).toBe(422);
    expect((await setup("viewer", t).call("POST", "/seo/keyword-sets", { name: "T", seeds: ["x"] })).status).toBe(403);
  });

  it("competitors: refuses your own site and private addresses, stores the origin", async () => {
    const t = { brands: [brand], competitors: [{ id: "c1", name: "Rival" }] };
    expect((await setup("editor", t).call("POST", "/seo/competitors", { name: "Me", url: "https://www.annapurna.example/about" })).status).toBe(422);
    expect((await setup("editor", t, { resolve: ["10.0.0.5"] }).call("POST", "/seo/competitors", { name: "Intranet", url: "https://intranet.example" })).status).toBe(422);
    const ok = setup("editor", t);
    expect((await ok.call("POST", "/seo/competitors", { name: "Rival", url: "https://rival.example/pricing?x=1" })).status).toBe(201);
    expect(ok.svc.ops.find((o) => o.table === "competitors" && o.op === "insert")!.payload).toMatchObject({ url: "https://rival.example" });
  });

  it("starts an SEO article job with the brand language and refuses viewers", async () => {
    const a = setup("contributor", { brands: [brand] });
    expect((await a.call("POST", "/seo/articles", { keyword: "tiffin service pune", secondary: ["tiffin price"] })).status).toBe(202);
    expect(a.starter.seoArticle).toHaveBeenCalledWith(expect.objectContaining({ keyword: "tiffin service pune", language: "en", chargeCredits: 11 }));
    expect((await setup("viewer", { brands: [brand] }).call("POST", "/seo/articles", { keyword: "x y" })).status).toBe(403);
  });

  it("stores per-content SEO settings and reports a stale analysis", async () => {
    const t = { content_items: [{ id: CI, type: "blog", seo: { primary: "tiffin" }, current_version_id: "v1" }], seo_reports: [] };
    const g = await setup("viewer", t).call("GET", `/content/${CI}/seo`);
    expect(await g.json()).toMatchObject({ settings: { primary: "tiffin" }, report: null, stale: true });
    const p = setup("editor", t);
    expect((await p.call("PUT", `/content/${CI}/seo`, { primary: "tiffin service pune", secondary: ["lunch box"] })).status).toBe(200);
    expect(p.svc.ops.find((o) => o.table === "content_items" && o.op === "update")!.payload).toMatchObject({ seo: { primary: "tiffin service pune" } });
    expect((await p.call("PUT", `/content/${CI}/seo`, { canonicalUrl: "not a url" })).status).toBe(422);
  });
});

describe("Ads API: high-risk, permission-controlled", () => {
  const base = { brands: [brand], analytics_connections: [google], ad_account_policies: [policy], ad_campaigns: [campaign()], ad_actions: [{ id: ACT, campaign_id: CAMP, status: "pending", requested_by: "u2" }], media_assets: [] };

  it("viewers can't see ads; reviewers can read but not change them", async () => {
    expect((await setup("viewer", base).call("GET", "/ads/campaigns")).status).toBe(403);
    expect((await setup("reviewer", base).call("GET", "/ads/campaigns")).status).toBe(200);
    expect((await setup("reviewer", base).call("POST", `/ads/campaigns/${CAMP}/actions`, { action: "launch" })).status).toBe(403);
  });

  it("API keys can't change campaigns (a signed-in person is required)", async () => {
    expect((await setup("admin", base, { apiKey: true }).call("POST", `/ads/campaigns/${CAMP}/actions`, { action: "pause" })).status).toBe(403);
  });

  it("creates drafts on a matching account and records the compliance check", async () => {
    const a = setup("editor", base);
    const res = await a.call("POST", "/ads/campaigns", { connectionId: CONN, platform: "google", name: "Tiffin search", objective: "website_traffic", dailyBudgetMinor: 50_000, landingUrl: "https://annapurna.example/tiffin" });
    expect(res.status).toBe(201);
    expect((await res.json()).compliance.passed).toBe(true);   // the canned row is complete
    expect((await setup("editor", base).call("POST", "/ads/campaigns", { connectionId: CONN, platform: "meta", name: "x", objective: "traffic" })).status).toBe(422);
    expect((await setup("editor", base).call("POST", "/ads/campaigns", { connectionId: CONN, platform: "google", name: "x", objective: "awareness" })).status).toBe(422);
  });

  it("account guardrails: only ads.approve; enabling or raising limits needs the account id typed", async () => {
    const off = { ...base, ad_account_policies: [{ ...policy, manage_enabled: false }] };
    expect((await setup("editor", off).wsCall("PUT", `/ads/accounts/${CONN}/policy`, { manageEnabled: true, maxDailyBudgetMinor: 100_000 })).status).toBe(403);
    expect((await setup("admin", off).wsCall("PUT", `/ads/accounts/${CONN}/policy`, { manageEnabled: true, maxDailyBudgetMinor: 100_000 })).status).toBe(422);
    const ok = setup("admin", off);
    expect((await ok.wsCall("PUT", `/ads/accounts/${CONN}/policy`, { manageEnabled: true, maxDailyBudgetMinor: 100_000, confirm: "1234567890" })).status).toBe(200);
    expect(ok.svc.ops.find((o) => o.table === "ad_account_policies" && o.op === "upsert")!.payload).toMatchObject({ manage_enabled: true, updated_by: "u1" });
    // lowering a limit / switching off needs no confirmation
    expect((await setup("admin", base).wsCall("PUT", `/ads/accounts/${CONN}/policy`, { manageEnabled: false, maxDailyBudgetMinor: 50_000 })).status).toBe(200);
    const meta = { ...off, analytics_connections: [{ ...google, provider: "meta_ads", account_ref: "act_99" }] };
    expect((await setup("owner", meta).wsCall("PUT", `/ads/accounts/${CONN}/policy`, { manageEnabled: true, maxDailyBudgetMinor: 1, confirm: "99" })).status).toBe(422);   // no Page
  });

  it("launch is a request with a typed phrase; nothing executes until approved", async () => {
    const a = setup("editor", base);
    const res = await a.call("POST", `/ads/campaigns/${CAMP}/actions`, { action: "launch" });
    expect(res.status).toBe(201);
    const ins = a.svc.ops.find((o) => o.table === "ad_actions" && o.op === "insert")!.payload as Record<string, unknown>;
    expect(ins).toMatchObject({ action: "launch", campaign_revision: 3, requested_by: "u1", payload: { confirm: "Tiffin search" } });
    expect(String(ins.summary)).toMatch(/PAUSED/);
    expect(a.starter.adAction).not.toHaveBeenCalled();
    expect(a.svc.ops.some((o) => o.op === "rpc" && o.table === "decide_ad_action")).toBe(false);
  });

  it("launch is refused when management is off or checks fail", async () => {
    expect((await setup("editor", { ...base, ad_account_policies: [{ ...policy, manage_enabled: false }] }).call("POST", `/ads/campaigns/${CAMP}/actions`, { action: "launch" })).status).toBe(403);
    const bad = await setup("editor", { ...base, ad_campaigns: [campaign({ landing_url: "http://insecure.example", creative: { headlines: ["One"], descriptions: [] } })] }).call("POST", `/ads/campaigns/${CAMP}/actions`, { action: "launch" });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(await bad.json())).toMatch(/landing_https|rsa_headlines_min/);
    expect((await setup("editor", { ...base, ad_campaigns: [campaign({ status: "active" })] }).call("POST", `/ads/campaigns/${CAMP}/actions`, { action: "launch" })).status).toBe(409);
  });

  it("budget changes: within the account limit, confirmed by typing the amount", async () => {
    const active = { ...base, ad_campaigns: [campaign({ status: "active", external: { campaignId: "987" } })] };
    expect((await setup("editor", active).call("POST", `/ads/campaigns/${CAMP}/actions`, { action: "budget_change", dailyBudgetMinor: 500_000 })).status).toBe(422);
    const a = setup("editor", active);
    expect((await a.call("POST", `/ads/campaigns/${CAMP}/actions`, { action: "budget_change", dailyBudgetMinor: 75_000 })).status).toBe(201);
    expect(a.svc.ops.find((o) => o.table === "ad_actions" && o.op === "insert")!.payload).toMatchObject({ payload: { confirm: "750.00", dailyBudgetMinor: 75_000, previousMinor: 50_000 } });
  });

  it("pausing runs right away, even with management off", async () => {
    const t = { ...base, ad_account_policies: [{ ...policy, manage_enabled: false }], ad_campaigns: [campaign({ status: "active", external: { campaignId: "987" } })], ad_actions: [{ id: ACT }] };
    const a = setup("editor", t, { rpc: { decide_ad_action: { id: ACT, status: "approved" } } });
    expect((await a.call("POST", `/ads/campaigns/${CAMP}/actions`, { action: "pause" })).status).toBe(202);
    expect(a.svc.ops.find((o) => o.op === "rpc" && o.table === "decide_ad_action")!.payload).toMatchObject({ p_decision: "approved", p_actor: "u1", p_confirmation: null });
    expect(a.starter.adAction).toHaveBeenCalledWith({ actionId: ACT, workspaceId: WS });
  });

  it("approvals: ads.approve only; the typed confirmation goes to the database check; approved → executes", async () => {
    expect((await setup("editor", base).call("POST", `/ads/requests/${ACT}/decide`, { decision: "approved", confirmation: "Tiffin search" })).status).toBe(403);
    const a = setup("admin", base, { rpc: { decide_ad_action: { id: ACT, status: "approved" } } });
    expect((await a.call("POST", `/ads/requests/${ACT}/decide`, { decision: "approved", confirmation: "Tiffin search" })).status).toBe(202);
    expect(a.svc.ops.find((o) => o.op === "rpc" && o.table === "decide_ad_action")!.payload).toEqual({ p_action: ACT, p_decision: "approved", p_actor: "u1", p_confirmation: "Tiffin search" });
    expect(a.starter.adAction).toHaveBeenCalledTimes(1);
    const r = setup("owner", base, { rpc: { decide_ad_action: { id: ACT, status: "rejected" } } });
    expect((await r.call("POST", `/ads/requests/${ACT}/decide`, { decision: "rejected" })).status).toBe(200);
    expect(r.starter.adAction).not.toHaveBeenCalled();
  });

  it("only drafts can be edited; an edit bumps the revision (cancelling approvals)", async () => {
    expect((await setup("editor", { ...base, ad_campaigns: [campaign({ status: "paused", external: { campaignId: "987" } })] }).call("PATCH", `/ads/campaigns/${CAMP}`, { name: "New" })).status).toBe(409);
    const a = setup("editor", base);
    expect((await a.call("PATCH", `/ads/campaigns/${CAMP}`, { name: "Tiffin search v2", dailyBudgetMinor: 60_000 })).status).toBe(200);
    expect(a.svc.ops.find((o) => o.table === "ad_campaigns" && o.op === "update")!.payload).toMatchObject({ name: "Tiffin search v2", daily_budget_minor: 60_000, revision: 4 });
  });

  it("organic → paid: seeds a draft from the post", async () => {
    const doc = { format: 1, blocks: [{ id: "b1", kind: "hook", text: "Lunch, sorted.", origin: "ai" }, { id: "b2", kind: "body", text: "Home-style tiffins delivered to your office every weekday.", origin: "ai" }] };
    const a = setup("editor", { ...base, content_items: [{ id: CI, title: "Lunch post", current_version_id: "v1" }], content_versions: [{ id: "v1", body: { doc }, media_asset_ids: [] }], schedules: [] });
    expect((await a.call("POST", "/ads/promote", { contentItemId: CI, connectionId: CONN })).status).toBe(201);
    const ins = a.svc.ops.find((o) => o.table === "ad_campaigns" && o.op === "insert")!.payload as { creative: { headlines: string[] }; source_content_item_id: string; name: string };
    expect(ins.creative.headlines).toContain("Lunch, sorted");
    expect(ins).toMatchObject({ source_content_item_id: CI, name: "Promote: Lunch post" });
  });

  it("reports nothing until the campaign exists on the platform", async () => {
    const res = await setup("reviewer", base).call("GET", `/ads/campaigns/${CAMP}/report`);
    expect(await res.json()).toMatchObject({ series: [], totals: null });
  });
});
