import { compileBrandContext, docFrom, emptyKit } from "@arcatic/core";
import { encryptSecret } from "@arcatic/database";
import type { LlmProvider } from "@arcatic/ai";
import type { AdsSyncClient, FirecrawlClient } from "@arcatic/integrations";
import { describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/activity", async (orig) => ({
  ...(await orig<object>()),
  Context: { current: () => ({ heartbeat: () => undefined, cancelled: new Promise(() => undefined), cancellationSignal: new AbortController().signal, info: { attempt: 1 } }) },
}));
const { createAdsActivities } = await import("../src/ads-activities.js");
const { createSeoActivities } = await import("../src/seo-activities.js");
const { buildSeoReport } = await import("../src/seo-report.js");
const { memDb } = await import("./mem-db.js");

const IMG = "22222222-2222-4222-8222-222222222222";
const WS = "11111111-1111-4111-8111-111111111111", BRAND = "b1", CONN = "conn1", KEY = Buffer.alloc(32, 7).toString("base64");
const llm = (out: (template: string) => unknown): { p: LlmProvider; templates: string[] } => {
  const templates: string[] = [];
  return { templates, p: { async generateStructured(req) {
    templates.push(String(req.metadata?.template));
    return { output: req.schema.parse(out(String(req.metadata?.template))), model: req.model, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: "end_turn", servedByFallback: false };
  } } };
};
const fakeAds = () => {
  const calls: Array<{ fn: string; body: Record<string, unknown> }> = [];
  const rec = (fn: string, res: unknown) => async (body: Record<string, unknown>) => { calls.push({ fn, body }); return res; };
  const client = {
    googleCreate: rec("googleCreate", { campaignId: "987", campaignResourceName: "customers/1/campaigns/987", budgetResourceName: "customers/1/campaignBudgets/55", currency: "INR", reused: false }),
    metaCreate: rec("metaCreate", { campaignId: "m1", adSetId: "as1", creativeId: "cr1", adId: "ad1", currency: "INR", reused: false }),
    googleUpdate: rec("googleUpdate", { done: ["status:paused"] }),
    metaUpdate: rec("metaUpdate", { done: ["budget"] }),
    metaSearch: rec("metaSearch", { results: [{ id: "6003", name: "Healthy eating" }, { id: "1", name: "Healthy eating recipes" }] }),
    keywordIdeas: rec("keywordIdeas", { ideas: [{ keyword: "tiffin service pune", avgMonthlySearches: 2400, competition: "MEDIUM", competitionIndex: 40, lowBidMinor: 1200, highBidMinor: 4000 }] }),
  };
  return { calls, client: client as unknown as AdsSyncClient };
};

const campaign = (over: Record<string, unknown> = {}) => ({
  id: "camp1", workspace_id: WS, brand_id: BRAND, connection_id: CONN, platform: "google", name: "Tiffin search", objective: "website_traffic", status: "draft",
  brief: { offer: "First week free" }, audience: { locations: [{ key: "2356", name: "India", type: "country" }], keywords: [{ text: "tiffin service", match: "PHRASE" }] },
  creative: { headlines: ["A", "B", "C"], descriptions: ["D one", "D two"] }, landing_url: "https://annapurna.example/tiffin", daily_budget_minor: 50_000, currency: "INR",
  start_date: null, end_date: null, special_ad_categories: [], revision: 2, external: {}, source_content_item_id: null, ...over,
});
async function seed(over: { campaign?: Record<string, unknown>; action?: Record<string, unknown>; policy?: Record<string, unknown> | null; provider?: string } = {}) {
  const ctx = await compileBrandContext(emptyKit(BRAND, "Annapurna"));
  const purpose = over.provider === "meta_ads" ? "meta_access_token" : "google_ads_refresh_token";
  return memDb({
    brands: [{ id: BRAND, workspace_id: WS, name: "Annapurna", website_url: "https://annapurna.example", active_kit_version_id: "kv1" }],
    brand_contexts: [{ kit_version_id: "kv1", workspace_id: WS, context: ctx }],
    integration_secrets: [{ id: "sec1", workspace_id: WS, purpose, ciphertext: encryptSecret("token-123", `${WS}:${purpose}`, KEY) }],
    analytics_connections: [{ id: CONN, workspace_id: WS, provider: over.provider ?? "google_ads", account_ref: "1234567890", secret_id: "sec1", settings: {} }],
    ad_account_policies: over.policy === null ? [] : [{ connection_id: CONN, workspace_id: WS, manage_enabled: true, max_daily_budget_minor: 100_000, monthly_spend_cap_minor: 1_000_000, auto_pause_on_cap: true, page_id: "555", instagram_user_id: null, currency: "INR", ...over.policy }],
    ad_campaigns: [campaign(over.campaign)],
    ad_actions: [{ id: "act1", workspace_id: WS, campaign_id: "camp1", action: "launch", payload: { confirm: "Tiffin search" }, campaign_revision: 2, status: "approved", ...over.action }],
    media_assets: [{ id: IMG, workspace_id: WS, kind: "image", status: "ready", storage_path: "ws/img.jpg" }],
    performance_metrics: [], generation_jobs: [], keyword_sets: [], competitors: [], seo_reports: [],
  });
}

describe("executeAdAction: only approved, unchanged, in-limit actions reach the platform", () => {
  it("launches a Google campaign (created PAUSED by the sidecar) and records platform ids", async () => {
    const m = await seed();
    const ads = fakeAds();
    const r = await createAdsActivities({ db: m.db, llm: llm(() => ({})).p, ads: ads.client, encryptionKey: KEY }).executeAdAction({ actionId: "act1" });
    expect(r).toEqual({ status: "done", campaignStatus: "paused" });
    expect(ads.calls[0]!.fn).toBe("googleCreate");
    expect(ads.calls[0]!.body).toMatchObject({ customerId: "1234567890", refreshToken: "token-123", campaign: { id: "camp1", dailyBudgetMinor: 50_000, currency: "INR" } });
    expect(m.tables.ad_campaigns![0]).toMatchObject({ status: "paused", external: { campaignId: "987", budgetResourceName: "customers/1/campaignBudgets/55" } });
    expect(m.tables.ad_actions![0]).toMatchObject({ status: "done" });
  });

  it("refuses an action approved for an older revision (no platform call)", async () => {
    const m = await seed({ action: { campaign_revision: 1 } });
    const ads = fakeAds();
    await expect(createAdsActivities({ db: m.db, llm: llm(() => ({})).p, ads: ads.client, encryptionKey: KEY }).executeAdAction({ actionId: "act1" })).rejects.toMatchObject({ type: "conflict" });
    expect(ads.calls).toHaveLength(0);
    expect(m.tables.ad_actions![0]!.status).toBe("cancelled");
  });

  it("refuses when management is off, when the budget is over the limit, or when not approved", async () => {
    for (const over of [{ policy: { manage_enabled: false } }, { policy: null }, { campaign: { daily_budget_minor: 500_000 } }, { action: { status: "pending" } }]) {
      const m = await seed(over);
      const ads = fakeAds();
      await expect(createAdsActivities({ db: m.db, llm: llm(() => ({})).p, ads: ads.client, encryptionKey: KEY }).executeAdAction({ actionId: "act1" })).rejects.toBeTruthy();
      expect(ads.calls).toHaveLength(0);
    }
  });

  it("pausing is allowed even with management off; budget changes go to the Meta ad set", async () => {
    const paused = await seed({ policy: { manage_enabled: false }, campaign: { status: "active", external: { campaignId: "987", budgetResourceName: "b" } }, action: { action: "pause", payload: {} } });
    const a1 = fakeAds();
    expect(await createAdsActivities({ db: paused.db, llm: llm(() => ({})).p, ads: a1.client, encryptionKey: KEY }).executeAdAction({ actionId: "act1" })).toEqual({ status: "done", campaignStatus: "paused" });
    expect(a1.calls[0]).toMatchObject({ fn: "googleUpdate", body: { campaignId: "987", status: "paused" } });

    const meta = await seed({ provider: "meta_ads", campaign: { platform: "meta", objective: "traffic", status: "active", external: { campaignId: "m1", adSetId: "as1" } }, action: { action: "budget_change", payload: { dailyBudgetMinor: 80_000, confirm: "800.00" } } });
    const a2 = fakeAds();
    await createAdsActivities({ db: meta.db, llm: llm(() => ({})).p, ads: a2.client, encryptionKey: KEY }).executeAdAction({ actionId: "act1" });
    expect(a2.calls[0]).toMatchObject({ fn: "metaUpdate", body: { accessToken: "token-123", campaignId: "m1", adSetId: "as1", dailyBudgetMinor: 80_000 } });
    expect(meta.tables.ad_campaigns![0]).toMatchObject({ status: "active", daily_budget_minor: 80_000 });
  });

  it("Meta launch sends a signed image URL and the Page id from the account policy", async () => {
    const m = await seed({ provider: "meta_ads", campaign: { platform: "meta", objective: "traffic", creative: { primaryText: "P", headline: "H", cta: "LEARN_MORE", mediaAssetId: IMG } } });
    const ads = fakeAds();
    await createAdsActivities({ db: m.db, llm: llm(() => ({})).p, ads: ads.client, encryptionKey: KEY }).executeAdAction({ actionId: "act1" });
    expect(ads.calls[0]).toMatchObject({ fn: "metaCreate", body: { adAccountId: "1234567890", campaign: { pageId: "555", imageUrl: "https://storage.test/ws/img.jpg?token=t" } } });
  });
});

describe("spend guard", () => {
  it("pauses active campaigns on an account over its monthly cap and records the action", async () => {
    const m = await seed({ campaign: { status: "active", external: { campaignId: "987" } }, action: { status: "done" } });
    const day = new Date().toISOString().slice(0, 10);
    m.tables.performance_metrics!.push({ workspace_id: WS, kind: "ad", metric_key: `ad:${CONN}:987`, metric_date: day, spend_minor: 1_200_000 });
    const ads = fakeAds();
    const r = await createAdsActivities({ db: m.db, llm: llm(() => ({})).p, ads: ads.client, encryptionKey: KEY }).adSpendGuard({ workspaceId: WS });
    expect(r.paused).toBe(1);
    expect(ads.calls[0]).toMatchObject({ fn: "googleUpdate", body: { status: "paused" } });
    expect(m.tables.ad_campaigns![0]).toMatchObject({ status: "paused" });
    expect(m.tables.ad_actions!.at(-1)).toMatchObject({ action: "pause", status: "done", payload: { reason: "spend_cap" } });
  });
  it("does nothing under the cap or with auto-pause off", async () => {
    for (const policy of [{}, { auto_pause_on_cap: false }]) {
      const m = await seed({ campaign: { status: "active", external: { campaignId: "987" } }, policy });
      m.tables.performance_metrics!.push({ workspace_id: WS, kind: "ad", metric_key: `ad:${CONN}:987`, metric_date: new Date().toISOString().slice(0, 10), spend_minor: policy.auto_pause_on_cap === false ? 5_000_000 : 10_000 });
      const ads = fakeAds();
      expect((await createAdsActivities({ db: m.db, llm: llm(() => ({})).p, ads: ads.client, encryptionKey: KEY }).adSpendGuard({ workspaceId: WS })).paused).toBe(0);
      expect(ads.calls).toHaveLength(0);
    }
  });
});

describe("AI drafting", () => {
  it("Meta: resolves interest names to real ids by exact match, never inventing ids", async () => {
    const m = await seed({ provider: "meta_ads", campaign: { platform: "meta", objective: "traffic", creative: { mediaAssetId: IMG }, audience: { locations: [{ key: "IN", name: "India", type: "country" }] } } });
    const ads = fakeAds();
    const model = llm((t) => t === "ads.brief@1"
      ? { summary: "S", angles: ["a"], audiences: [{ name: "Office", description: "d", interest_names: ["Healthy eating", "Made up thing"], keywords: [], negative_keywords: [], age_min: 22, age_max: 40, location_hints: [] }] }
      : { primary_texts: ["Fresh tiffins at your desk."], headlines: ["Lunch, sorted"], descriptions: ["Free first week"], cited_chunk_ids: [] });
    m.db.rpc = async () => ({ data: [], error: null });
    const r = await createAdsActivities({ db: m.db, llm: model.p, ads: ads.client, encryptionKey: KEY }).draftAdCampaign({ jobId: "j", workspaceId: WS, campaignId: "camp1", chargeCredits: 3 });
    const c = m.tables.ad_campaigns![0] as { audience: { interests: unknown[]; ageMin: number }; creative: { primaryText: string; mediaAssetId: string }; revision: number; compliance: { passed: boolean } };
    expect(c.audience.interests).toEqual([{ id: "6003", name: "Healthy eating" }]);
    expect(c.audience.ageMin).toBe(22);
    expect(c.creative).toMatchObject({ primaryText: "Fresh tiffins at your desk.", mediaAssetId: IMG });
    expect(c.revision).toBe(3);   // edits invalidate earlier approvals
    expect(r.credits).toBe(3);
  });
});

describe("SEO research", () => {
  it("keyword research merges Keyword Planner numbers with AI ideas and clusters them", async () => {
    const m = await seed();
    m.tables.keyword_sets!.push({ id: "ks1", workspace_id: WS, brand_id: BRAND, seeds: ["tiffin service"], seed_url: null, language: "en", geo: "India", source: "google_ads_keyword_planner", status: "running" });
    const ads = fakeAds();
    const model = llm(() => ({ keywords: [{ keyword: "tiffin service pune", intent: "commercial" }, { keyword: "how to start a tiffin service", intent: "informational" }] }));
    const acts = createSeoActivities({ db: m.db, llm: model.p, firecrawl: {} as FirecrawlClient, ads: ads.client, encryptionKey: KEY });
    const r = await acts.keywordResearch({ jobId: "j", workspaceId: WS, brandId: BRAND, keywordSetId: "ks1", connectionId: CONN, locationIds: ["2356"], chargeCredits: 2 });
    expect(r).toMatchObject({ ideas: 2, source: "google_ads_keyword_planner" });
    const set = m.tables.keyword_sets![0] as { status: string; ideas: Array<{ keyword: string; avgMonthlySearches: number | null }> };
    expect(set.status).toBe("ready");
    expect(set.ideas.find((i) => i.keyword === "tiffin service pune")!.avgMonthlySearches).toBe(2400);
    expect(set.ideas.find((i) => i.keyword.startsWith("how"))!.avgMonthlySearches).toBeNull();
    expect(ads.calls[0]).toMatchObject({ fn: "keywordIdeas", body: { refreshToken: "token-123", keywords: ["tiffin service"], locationIds: ["2356"] } });
  });

  it("competitor research reads only the competitor's own pages and keeps verbatim claims", async () => {
    const m = await seed();
    m.tables.competitors!.push({ id: "c1", workspace_id: WS, brand_id: BRAND, name: "Rival", url: "https://rival.example", status: "new" });
    const scraped: string[] = [];
    const firecrawl = {
      map: async () => ({ links: ["https://rival.example/pricing", "https://elsewhere.example/x"] }),
      scrape: async (url: string) => { scraped.push(url); return { success: true, data: { markdown: "Tiffins from ₹99 a day. Pune's favourite lunch box.", metadata: { title: "Rival" } } }; },
    } as unknown as FirecrawlClient;
    const model = llm(() => ({ positioning: "Cheap lunches", audiences: [], topics: [{ topic: "Pricing", page_ids: ["p1"] }], offers: ["₹99/day"], claims: [{ quote: "Pune's favourite lunch box", page_id: "p1" }, { quote: "Award winning", page_id: "p1" }], gaps: [] }));
    const acts = createSeoActivities({ db: m.db, llm: model.p, firecrawl, resolve: async () => ["93.184.216.34"] });
    const r = await acts.competitorResearch({ jobId: "j", workspaceId: WS, brandId: BRAND, competitorId: "c1", chargeCredits: 3 });
    expect(scraped.every((u) => u.startsWith("https://rival.example"))).toBe(true);
    expect(r.claims).toBe(1);
    expect(m.tables.competitors![0]).toMatchObject({ status: "ready", analysis: { claims: [{ text: "Pune's favourite lunch box" }] } });
  });

  it("prepares an SEO article child job once (blog.article@2 with the researched outline)", async () => {
    const m = await seed();
    m.db.rpc = async () => ({ data: [], error: null });
    const model = llm(() => ({ question: "What does a tiffin service cost in Pune?", intent: "commercial", title_options: ["Tiffin service in Pune: prices"], outline: [{ heading: "How much does it cost?", points: ["plans"] }], faqs: ["Can I pause?"], entities: [], words: 1200, notes: "Compare plans", cited_chunk_ids: [] }));
    const acts = createSeoActivities({ db: m.db, llm: model.p, firecrawl: {} as FirecrawlClient });
    const input = { jobId: "seo1", workspaceId: WS, brandId: BRAND, keyword: "tiffin service pune", secondary: ["tiffin price"], competitorIds: [], language: "en", chargeCredits: 33 };
    const a = await acts.prepareSeoArticle(input);
    expect(a.child).toMatchObject({ templateKey: "blog.article@2", chargeCredits: 0, input: { keyword: "tiffin service pune", question: "What does a tiffin service cost in Pune?", words: 1200, outline: [{ heading: "How much does it cost?" }], faqs: ["Can I pause?"] } });
    const b = await acts.prepareSeoArticle(input);
    expect(b.child.jobId).toBe(a.child.jobId);
  });
});

describe("SEO report", () => {
  it("scores the version, checks claims against its knowledge and suggests own-site links", async () => {
    const m = await seed();
    const doc = docFrom([
      ["title", "Tiffin service in Pune: prices and plans"], ["meta_description", "What a tiffin service in Pune costs, what's included and how to choose a plan that fits your week."],
      ["paragraph", "A tiffin service in Pune costs ₹2,999 a month for daily lunch. Our menu plans change every week."],
      ["heading", "What is included?"], ["paragraph", "Rice, two sabzis, dal and rotis."],
    ]);
    m.tables.content_items = [{ id: "ci1", workspace_id: WS, brand_id: BRAND, type: "blog", title: "Tiffin prices", seo: { primary: "tiffin service in pune" }, current_version_id: "v1" }];
    m.tables.content_versions = [{ id: "v1", content_item_id: "ci1", body: { doc }, source_chunk_ids: ["k1"], created_at: "2026-11-17T00:00:00Z" }];
    m.tables.knowledge_chunks = [{ id: "k1", source_id: "s1", content: "Our tiffin service in Pune costs ₹2,999 a month for daily lunch." }];
    m.tables.sources = [{ id: "s1", brand_id: BRAND, type: "url", status: "ready", url: "https://annapurna.example/menu-plans", title: "Weekly menu plans", summary: "Our menu plans change every week." }];
    m.tables.schedules = [];
    const r = await buildSeoReport(m.db, { workspaceId: WS, contentItemId: "ci1" });
    expect(r.scores.overall).toBeGreaterThan(0);
    expect(r.claims[0]).toMatchObject({ status: "supported", evidence: [{ id: "k1" }] });
    expect(r.links.map((l) => l.url)).toContain("https://annapurna.example/menu-plans");
    expect(r.schemaJsonld[0]).toMatchObject({ "@type": "Article", publisher: { name: "Annapurna" } });
    expect(m.tables.seo_reports).toHaveLength(1);
  });
});
