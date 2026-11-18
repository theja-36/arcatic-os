import { describe, expect, it } from "vitest";
import { createAnalyticsActivities } from "../src/analytics-activities.js";
import { memDb } from "./mem-db.js";

const WS = "w1", BRAND = "b1";
const NOW = new Date("2026-11-17T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

/** 12 Instagram posts over the last month: videos short & engaging, images long & weaker. */
function seed() {
  const schedules = [], items = [], versions = [], metrics = [];
  for (let i = 0; i < 12; i++) {
    const video = i < 6;
    const text = video ? `Quick tip ${i} #hyd` : `${"Long story about our cafe and everything we do. ".repeat(12)} #a #b #c #d #e #f #g #h`;
    schedules.push({ id: `s${i}`, workspace_id: WS, brand_id: BRAND, content_item_id: `c${i}`, content_version_id: `v${i}`, connected_account_id: "acc", external_post_id: `pz${i}`, status: "published", published_at: day(4 + i), account: { channel: "instagram", transport: "postiz" } });
    items.push({ id: `c${i}`, workspace_id: WS, brand_id: BRAND, title: `Post ${i}`, type: "social_post", campaign_id: null, status: "published", current: { id: `v${i}`, prompt_template: "social.post@1", model: "claude-opus-5-5", generation_job_id: `job-${i}` } });
    versions.push({ id: `v${i}`, content_item_id: `c${i}`, version: 1, origin: "ai", generation_job_id: `job-${i}`, body: { doc: { format: 1, blocks: [{ id: "b1", kind: "body", text, origin: "ai" }] }, ...(video ? { video: { assetId: "m" } } : {}) }, media_asset_ids: video ? [] : ["img"] });
    metrics.push({ workspace_id: WS, kind: "post", schedule_id: `s${i}`, metric_date: "2026-11-16", impressions: 1000, engagements: video ? 70 + i : 20 + i, topic_id: null });
  }
  return memDb({ schedules, content_items: items, content_versions: versions, performance_metrics: metrics, learning_signals: [], insights: [], analytics_sync_runs: [], campaign_topics: [], brands: [{ id: BRAND, workspace_id: WS, active_kit_version_id: null }] });
}

describe("analytics activities", () => {
  it("stores today's lifetime snapshot per post from Postiz, flags posts deleted on the platform", async () => {
    const m = seed();
    m.tables.performance_metrics = [];
    const postiz = { postAnalytics: async (id: string) => (id === "pz1" ? { missing: true } : id === "pz2" ? [] : [{ label: "Views", data: [{ total: "900", date: "2026-11-17" }], percentageChange: 0 }, { label: "Likes", data: [{ total: 45, date: "2026-11-17" }], percentageChange: 0 }]) };
    const acts = createAnalyticsActivities({ db: m.db, now: () => NOW, postiz: async () => postiz as never });
    const res = await acts.syncPostMetrics({ workspaceId: WS });
    expect(res.find((r) => r.source === "postiz_posts")).toMatchObject({ status: "succeeded", rows: 11 });
    expect(res.find((r) => r.source === "mautic_emails")!.status).toBe("skipped");
    const row = m.tables.performance_metrics!.find((r) => r.schedule_id === "s0")!;
    expect(row).toMatchObject({ metric_key: "post:s0", metric_date: "2026-11-17", cumulative: true, video_views: 900, likes: 45, channel: "instagram", kind: "post" });
    expect(m.tables.performance_metrics!.find((r) => r.schedule_id === "s1")!.extra).toEqual({ missing: true });
    expect(m.tables.analytics_sync_runs!.map((r) => r.status)).toEqual(["succeeded", "skipped"]);
  });

  it("records one engagement outcome per matured post", async () => {
    const m = seed();
    const acts = createAnalyticsActivities({ db: m.db, now: () => NOW });
    expect(await acts.recordOutcomes({ workspaceId: WS })).toBe(12);
    const o = m.tables.learning_signals!.find((s) => s.schedule_id === "s0")!;
    expect(o).toMatchObject({ signal: "engagement_outcome", prompt_template: "social.post@1" });
    expect(Number(o.value)).toBeGreaterThan(0);
  });

  it("raises ranking + recommendation insights with evidence, and never re-raises a dismissed one", async () => {
    const m = seed();
    const acts = createAnalyticsActivities({ db: m.db, now: () => NOW });
    const r = await acts.generateInsights({ workspaceId: WS, brandId: BRAND });
    const fps = m.tables.insights!.map((i) => i.fingerprint);
    expect(fps).toContain("format:instagram:video");
    expect(fps).toContain("length:instagram:short");
    expect(r.kinds.recommendation).toBeGreaterThanOrEqual(2);
    const fmt = m.tables.insights!.find((i) => i.fingerprint === "format:instagram:video")!;
    expect(fmt.guidance).toMatch(/favour video/);
    expect((fmt.evidence as { counts: Record<string, number> }).counts).toEqual({ video: 6, image: 6 });

    fmt.status = "dismissed";
    const before = m.tables.insights!.length;
    await acts.generateInsights({ workspaceId: WS, brandId: BRAND });
    expect(m.tables.insights!.filter((i) => i.fingerprint === "format:instagram:video")).toHaveLength(1);
    expect(m.tables.insights!.length).toBe(before);   // the rest were updated in place
  });
});
