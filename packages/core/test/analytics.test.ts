import { describe, expect, it } from "vitest";
import {
  analyzeEdits, compareWindows, dayList, engagementRate, learningsBlock, normalizePostiz, normalizePostizDaily, periodRange, rankPosts, rankingInsights, recommend,
  slope, summarizeQuality, withUtm, utmCampaign, type PostFacts,
} from "../src/index.js";

describe("normalisation", () => {
  it("maps Postiz post labels, takes the latest point, keeps unknown labels aside", () => {
    const r = normalizePostiz([
      { label: "Impressions", data: [{ total: "120", date: "2026-11-10" }, { total: "300", date: "2026-11-12" }] },
      { label: "Replies", data: [{ total: 4, date: "2026-11-12" }] },
      { label: "Comments", data: [{ total: 2, date: "2026-11-12" }] },
      { label: "Retweets", data: [{ total: 3, date: "2026-11-12" }] },
      { label: "Quotes", data: [{ total: 1, date: "2026-11-12" }] },
    ]);
    expect(r.values).toEqual({ impressions: 300, comments: 6, shares: 3 });
    expect(r.extra).toEqual({ quotes: 1 });
  });
  it("account series by day; engagement rate falls back to views then reach", () => {
    const d = normalizePostizDaily([{ label: "Followers", data: [{ total: 10, date: "2026-11-01" }, { total: 12, date: "2026-11-02" }] }]);
    expect(d.get("2026-11-02")!.values.followers).toBe(12);
    expect(engagementRate({ video_views: 1000, likes: 40, comments: 10 })).toBe(0.05);
    expect(engagementRate({ likes: 4 })).toBeNull();
  });
});

describe("periods and trends", () => {
  it("windows are equal length", () => {
    const p = periodRange("7d", new Date("2026-11-17T15:30:00Z"));
    expect(p.from.toISOString()).toBe("2026-11-11T00:00:00.000Z");
    expect(p.prevFrom.toISOString()).toBe("2026-11-04T00:00:00.000Z");
    expect(dayList(p.from, p.to)).toHaveLength(7);
    expect(dayList(p.prevFrom, p.prevTo)).toHaveLength(7);
  });
  it("flags a real change and ignores noise / thin data", () => {
    const up = compareWindows("seen", [120, 130, 125, 140, 135, 150, 145], [100, 98, 102, 99, 101, 100, 97]);
    expect(up).toMatchObject({ direction: "up", significant: true });
    const noise = compareWindows("seen", [100, 130, 90, 120, 80, 110, 100], [110, 90, 120, 85, 100, 105, 95]);
    expect(noise.significant).toBe(false);
    expect(compareWindows("seen", [5, 9], [1, 1]).significant).toBe(false);
    expect(slope([1, 2, 3, 4])).toBeCloseTo(1);
  });
});

const now = new Date("2026-11-17T12:00:00Z");
function post(i: number, o: Partial<PostFacts> & { er: number; seen?: number }): PostFacts {
  const seenN = o.seen ?? 1000;
  return {
    scheduleId: `s${i}`, contentItemId: `c${i}`, title: `Post ${i}`, channel: o.channel ?? "instagram", contentType: "social_post", campaignId: null, topicId: null,
    publishedAt: o.publishedAt ?? new Date(now.getTime() - (5 + i) * 86_400_000).toISOString(), textLength: o.textLength ?? 300, hashtags: o.hashtags ?? 5,
    mediaKind: o.mediaKind ?? "image", metrics: { impressions: seenN, engagements: Math.round(o.er * seenN) },
  };
}

describe("ranking", () => {
  it("scores posts against their own channel and skips immature or tiny ones", () => {
    const posts = [0.02, 0.025, 0.03, 0.022, 0.028, 0.09, 0.004].map((er, i) => post(i, { er }));
    posts.push(post(20, { er: 0.5, publishedAt: new Date(now.getTime() - 3_600_000).toISOString() }));   // too new
    posts.push(post(21, { er: 0.5, seen: 10 }));                                                         // too small
    const r = rankPosts(posts, { now });
    expect(r.eligible).toBe(7);
    expect(r.top[0]!.scheduleId).toBe("s5");
    expect(r.bottom[0]!.scheduleId).toBe("s6");
    expect(rankingInsights(r).map((x) => x.kind)).toEqual(["top_content", "underperformer"]);
  });
});

describe("recommendations", () => {
  it("finds a format and length effect with enough posts, nothing from thin data", () => {
    const posts: PostFacts[] = [];
    for (let i = 0; i < 6; i++) posts.push(post(i, { er: 0.06 + i * 0.002, mediaKind: "video", textLength: 150 + i * 5, hashtags: 2 }));
    for (let i = 6; i < 12; i++) posts.push(post(i, { er: 0.02 + i * 0.001, mediaKind: "image", textLength: 700 + i * 10, hashtags: 12 }));
    const ranked = rankPosts(posts, { now });
    const recs = recommend([...rankedAll(ranked, posts)], {});
    const fps = recs.map((r) => r.fingerprint);
    expect(fps).toContain("format:instagram:video");
    expect(fps).toContain("length:instagram:short");
    expect(fps).toContain("hashtags:instagram:fewer");
    expect(recs.find((r) => r.fingerprint === "length:instagram:short")!.guidance).toMatch(/Keep Instagram text around \d+ characters/);
    expect(recommend(rankedAll(rankPosts(posts.slice(0, 4), { now }), posts.slice(0, 4)))).toEqual([]);
  });
});
// rankPosts returns only top/bottom; recommendations use every eligible post
function rankedAll(r: ReturnType<typeof rankPosts>, posts: PostFacts[]) {
  return posts.map((p) => ({ ...p, er: engagementRate(p.metrics)!, seen: 1000, score: 0, channelMedian: r.baselines[p.channel]?.median ?? 0 }));
}

describe("edit learning", () => {
  it("proposes shorter drafts and words to avoid / prefer only with repeated evidence", () => {
    const pairs = Array.from({ length: 6 }, (_, i) => ({
      contentItemId: `c${i}`, channel: "instagram", editClasses: ["length"],
      aiText: `Unlock amazing savings at our cafe this weekend with delicious filter coffee and more ${"x ".repeat(40)}`,
      finalText: `Weekend offer at our cafe: filter coffee, Hyderabad style.`,
    }));
    const r = analyzeEdits(pairs, { banned: ["delicious"] });
    expect(r.stats.edited).toBe(6);
    const fps = r.proposals.map((p) => p.fingerprint);
    expect(fps).toContain("voice:shorter");
    const avoid = r.proposals.find((p) => p.fingerprint.startsWith("voice:avoid"))!;
    expect((avoid.evidence.ops as { addBanned: string[] }).addBanned).toEqual(expect.arrayContaining(["unlock", "amazing"]));
    expect((avoid.evidence.ops as { addBanned: string[] }).addBanned).not.toContain("delicious");   // already banned
    expect(analyzeEdits(pairs.slice(0, 2)).proposals).toEqual([]);
  });
  it("summarises quality per template × model", () => {
    const s = summarizeQuality([
      { template: "social.post@1", model: "claude-opus-5-5", firstPassApproved: true, edited: false, regenerations: 0, rejected: false, engagementScore: 1 },
      { template: "social.post@1", model: "claude-opus-5-5", firstPassApproved: false, edited: true, regenerations: 2, rejected: false, engagementScore: null },
    ]);
    expect(s[0]).toMatchObject({ items: 2, firstPassApprovalRate: 0.5, editRate: 0.5, avgRegenerations: 1, avgEngagementScore: 1 });
  });
  it("only accepted guidance for the matching channel reaches the prompt", () => {
    const b = learningsBlock([
      { id: "a", guidance: "Keep Instagram text around 200 characters.", applies_to: { channel: "instagram" } },
      { id: "b", guidance: "Use at most 3 hashtags on X.", applies_to: { channel: "x" } },
      { id: "c", guidance: null, applies_to: {} },
    ], { channel: "instagram", contentType: "social_post" });
    expect(b.ids).toEqual(["a"]);
    expect(b.text).toMatch(/approved by the team/);
  });
});

describe("utm", () => {
  it("tags links once, keeps punctuation and existing utm links", () => {
    const t = withUtm("Order at https://cafe.example/menu. Or https://x.example/?utm_source=a", { source: "instagram", medium: "social", campaign: utmCampaign("Diwali Offer 2026"), content: "s1" });
    expect(t).toContain("https://cafe.example/menu?utm_source=instagram&utm_medium=social&utm_campaign=diwali-offer-2026&utm_content=s1.");
    expect(t).toContain("https://x.example/?utm_source=a");
  });
});
