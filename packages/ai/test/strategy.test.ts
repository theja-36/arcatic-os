import { builtInMoments, compileBrandContext, emptyKit, weekStarts, type StrategyPlan } from "@arcatic/core";
import { describe, expect, it } from "vitest";
import type { LlmProvider } from "../src/provider.js";
import { fillSlots, generateStrategy, renderStrategyTask, renderWeeklyTask } from "../src/strategy.js";

const brand = async () => compileBrandContext({
  ...emptyKit("b1", "Annapurna Tiffins"),
  facts: { "vocabulary.banned": { id: "vocabulary.banned", value: ["cheap"], status: "approved", origin: "human", sources: [] } },
});
const weeks = weekStarts("2027-01-04", 13);

describe("strategy prompt", () => {
  it("gives the model fixed weeks, channels, capacity and only the provided moments", async () => {
    const t = renderStrategyTask({ brand: await brand(), weekStarts: weeks, channels: ["instagram", "whatsapp"], maturity: "starting", moments: builtInMoments("2027-01-04", "2027-04-04"), knowledge: [] });
    expect(t).toContain("Week 1: 2027-01-04 to 2027-01-10");
    expect(t).toContain("Week 13: 2027-03-29 to 2027-04-04");
    expect(t).toContain("at most 5 posts per week");
    expect(t).toContain("Republic Day (2027-01-26)");
    expect(t).toContain("Channels to use (only these): instagram, whatsapp");
  });

  it("normalises the model's draft into a plan", async () => {
    const provider: LlmProvider = {
      async generateStructured(req) {
        expect(req.metadata.template).toBe("strategy.90day@1");
        return {
          output: req.schema.parse({
            summary: "s", positioning: "p", goals: [], audiences: [],
            pillars: [{ name: "A", description: "", share: 1, example_topics: [] }, { name: "B", description: "", share: 1, example_topics: [] }, { name: "C", description: "", share: 2, example_topics: [] }],
            channel_mix: [{ channel: "instagram", role: "", posts_per_week: 20, content_types: ["social_post"] }],
            offers: [], campaigns: [], weeks: [], metrics: [], assumptions: [], moments_used: [],
          }),
          model: req.model, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: "end_turn", servedByFallback: false,
        };
      },
    };
    const r = await generateStrategy(provider, { brand: await brand(), weekStarts: weeks, channels: ["instagram"], maturity: "starting", moments: [], knowledge: [{ chunkId: "c1", content: "x" }] }, { workspaceId: "w" });
    expect(r.plan.channelMix[0]!.postsPerWeek).toBe(5);
    expect(r.plan.pillars.map((p) => p.share)).toEqual([25, 25, 50]);
    expect(r.plan.weeks).toHaveLength(13);
    expect(r.sourceChunkIds).toEqual(["c1"]);
  });
});

describe("weekly topics", () => {
  const slots = [
    { slotKey: "2027-01-12:instagram:0", date: "2027-01-12", channel: "instagram", contentType: "social_post", campaignId: "c1" },
    { slotKey: "2027-01-14:instagram:0", date: "2027-01-14", channel: "instagram", contentType: "short_video", campaignId: "c1" },
  ];
  it("keeps one topic per known slot and flags banned words", () => {
    const { topics, unfilled } = fillSlots({
      topics: [
        { slot_key: "2027-01-12:instagram:0", title: "Cheap Sankranti hampers", angle: "a", pillar: "Offers", cta: "DM us", notes: "" },
        { slot_key: "2027-01-12:instagram:0", title: "duplicate", angle: "", pillar: "", cta: "", notes: "" },
        { slot_key: "made-up", title: "x", angle: "", pillar: "", cta: "", notes: "" },
      ],
    }, slots, ["cheap"]);
    expect(topics).toHaveLength(1);
    expect(topics[0]!.flagged).toEqual(['Contains banned word "cheap"']);
    expect(unfilled).toEqual(["2027-01-14:instagram:0"]);
  });
  it("renders slots with weekday, campaign and the week's moments", async () => {
    const plan = { pillars: [{ name: "Offers", share: 100 }], weeks: [{ weekStart: "2027-01-11", theme: "Sankranti", focus: "Gifting" }], moments: [{ name: "Makar Sankranti / Pongal", date: "2027-01-14" }] } as unknown as StrategyPlan;
    const t = renderWeeklyTask({ brand: await brand(), plan, weekStart: "2027-01-11", slots: slots.map((s) => ({ ...s, campaignName: "Sankranti Specials", campaignBrief: "Gift boxes" })), recentTitles: ["Old topic"], knowledge: [] });
    expect(t).toContain("- 2027-01-12:instagram:0 | Tue 2027-01-12 | instagram | social_post | campaign: Sankranti Specials — Gift boxes");
    expect(t).toContain("Seasonal moments this week: Makar Sankranti / Pongal (2027-01-14)");
    expect(t).toContain("- Old topic");
  });
});
