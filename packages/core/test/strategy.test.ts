import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  allocateWeekSlots, builtInMoments, canTransition, checkPlan, dayOfWeek, maturityFromLabel, mergeMoments, nextMonday, normalizeDraft,
  postingDays, regionsForLocation, templateForContentType, weekStarts, CAMPAIGN_STATUSES, type StrategyDraft,
} from "../src/index.js";

describe("dates", () => {
  it("computes Monday week starts", () => {
    expect(nextMonday("2027-01-01")).toBe("2027-01-04");   // Fri → Mon
    expect(nextMonday("2027-01-04")).toBe("2027-01-04");
    const w = weekStarts("2027-01-04", 13);
    expect(w).toHaveLength(13);
    expect(w.at(-1)).toBe("2027-03-29");
    expect(w.every((d) => dayOfWeek(d) === 0)).toBe(true);
    expect(() => weekStarts("2027-01-05")).toThrow();
  });
});

describe("seasonality", () => {
  it("computes rule-based dates", () => {
    const m = builtInMoments("2026-11-01", "2027-06-30");
    const at = (n: string) => m.find((x) => x.name === n)?.date;
    expect(at("Black Friday")).toBe("2026-11-27");
    expect(at("Mother's Day")).toBe("2027-05-09");
    expect(at("Father's Day")).toBe("2027-06-20");
    expect(at("Makar Sankranti / Pongal")).toBe("2027-01-14");
  });
  it("includes state days only for that region", () => {
    expect(builtInMoments("2027-06-01", "2027-06-03").map((x) => x.name)).toEqual([]);
    expect(builtInMoments("2027-06-01", "2027-06-03", regionsForLocation("Gachibowli, Hyderabad")).map((x) => x.name)).toEqual(["Telangana Formation Day"]);
  });
  it("merges workspace dates and de-duplicates", () => {
    const merged = mergeMoments(builtInMoments("2027-01-01", "2027-01-31"), [
      { name: "Store anniversary", date: "2027-01-20", region: "IN", kind: "business" },
      { name: "Republic Day", date: "2027-01-26", region: "IN", kind: "national" },
    ]);
    expect(merged.filter((x) => x.name === "Republic Day")).toHaveLength(1);
    expect(merged.map((x) => x.date)).toEqual([...merged.map((x) => x.date)].sort());
  });
});

const draft = (over: Partial<StrategyDraft> = {}): StrategyDraft => ({
  summary: "Grow breakfast subscriptions in Gachibowli.",
  positioning: "Home-style food, delivered hot.",
  goals: [{ goal: "More subscriptions", metric: "New subscribers", target: "120", timeframe: "90 days" }],
  audiences: [{ name: "IT professionals", insight: "No time to cook", message: "Breakfast handled" }],
  pillars: [
    { name: "Behind the kitchen", description: "", share: 50, example_topics: [] },
    { name: "Customer stories", description: "", share: 30, example_topics: [] },
    { name: "Offers", description: "", share: 40, example_topics: [] },
  ],
  channel_mix: [
    { channel: "instagram", role: "Discovery", posts_per_week: 7, content_types: ["social_post", "short_video", "podcast"] },
    { channel: "whatsapp", role: "Retention", posts_per_week: 4, content_types: ["social_post"] },
    { channel: "tiktok", role: "Reach", posts_per_week: 5, content_types: ["short_video"] },
  ],
  offers: [{ offer: "First week free", cta: "Order on WhatsApp", timing: "Weeks 1-4" }],
  campaigns: [
    { name: "Sankranti Specials", theme: "Festive", goal: "Orders", start_week: 2, end_week: 3, audience: "Families", key_message: "", offer: "", cta: "", channels: ["instagram", "tiktok"], content_types: ["social_post"], pillar: "Offers", kpis: [] },
    { name: "Sankranti Specials", theme: "dup name", goal: "", start_week: 20, end_week: 1, audience: "", key_message: "", offer: "", cta: "", channels: [], content_types: [], pillar: "", kpis: [] },
  ],
  weeks: [{ week: 1, theme: "Launch", focus: "Introduce the plan", pillars: ["Offers"], campaigns: [] }, { week: 2, theme: "Sankranti", focus: "", pillars: [], campaigns: ["Sankranti Specials", "unknown"] }],
  metrics: [{ metric: "Subscribers", target: "120", how_measured: "Orders sheet" }],
  assumptions: ["Owner can shoot 2 videos a week"],
  moments_used: ["Makar Sankranti / Pongal", "Made-up Festival"],
  ...over,
});
const ctx = {
  weekStarts: weekStarts("2027-01-04", 13),
  channels: ["instagram", "whatsapp", "facebook"],
  maturity: "occasional" as const,
  moments: builtInMoments("2027-01-04", "2027-04-04"),
};

describe("normalizeDraft", () => {
  const { plan, notes } = normalizeDraft(draft(), ctx);
  it("drops unselected channels and unknown content types", () => {
    expect(plan.channelMix.map((m) => m.channel)).toEqual(["instagram", "whatsapp"]);
    expect(plan.channelMix[0]!.contentTypes).toEqual(["social_post", "short_video"]);
    expect(notes.some((n) => n.includes('Dropped channel "tiktok"'))).toBe(true);
  });
  it("caps weekly volume at the maturity capacity, proportionally", () => {
    expect(plan.channelMix.reduce((s, m) => s + m.postsPerWeek, 0)).toBe(8);
    expect(plan.channelMix.map((m) => m.postsPerWeek)).toEqual([5, 3]);
  });
  it("normalises pillar shares to 100", () => {
    expect(plan.pillars.map((p) => p.share)).toEqual([42, 25, 33]);
  });
  it("derives campaign dates from week indices, de-duplicates keys, clamps bad ranges", () => {
    expect(plan.campaigns[0]).toMatchObject({ key: "sankranti-specials", startsOn: "2027-01-11", endsOn: "2027-01-24", channels: ["instagram"] });
    expect(plan.campaigns[1]).toMatchObject({ key: "sankranti-specials-2", startsOn: "2027-03-29", endsOn: "2027-04-04" });
    expect(plan.campaigns[1]!.channels).toEqual(["instagram", "whatsapp"]);   // none valid → all mix channels
  });
  it("always has exactly the computed weeks and only known campaign links", () => {
    expect(plan.weeks.map((w) => w.weekStart)).toEqual(ctx.weekStarts);
    expect(plan.weeks[1]!.campaigns).toEqual(["sankranti-specials"]);
    expect(notes.some((n) => n.includes("11 week(s) had no theme"))).toBe(true);
  });
  it("keeps only seasonal moments from the provided calendar", () => {
    expect(plan.moments).toEqual([{ name: "Makar Sankranti / Pongal", date: "2027-01-14" }]);
  });
  it("checkPlan flags human edits that break cross-field rules", () => {
    const broken = structuredClone(plan);
    broken.pillars[0]!.share = 90;
    broken.campaigns[0]!.endsOn = "2026-12-01";
    broken.weeks[0]!.campaigns = ["nope"];
    expect(checkPlan(broken, { startsOn: "2027-01-04", endsOn: "2027-04-04" })).toEqual([
      "Pillar shares add up to 148% (should be 100%).",
      'Campaign "Sankranti Specials" ends before it starts.',
      'Week of 2027-01-04 references unknown campaign "nope".',
    ]);
  });
});

describe("slot allocation", () => {
  const mix = [
    { channel: "instagram", role: "", postsPerWeek: 3, contentTypes: ["social_post", "short_video"] as never },
    { channel: "facebook", role: "", postsPerWeek: 1, contentTypes: ["social_post"] as never },
  ];
  const campaigns = [
    { id: "c-sank", name: "Sankranti", startsOn: "2027-01-11", endsOn: "2027-01-15", channels: ["instagram"], contentTypes: ["social_post"] },
    { id: "c-sub", name: "Subscriptions", startsOn: null, endsOn: null, channels: [], contentTypes: [] },
  ];
  it("spreads posts across the week deterministically", () => {
    expect(postingDays(3)).toEqual([1, 3, 5]);
    expect(postingDays(8)).toEqual([0, 1, 1, 2, 3, 4, 5, 6]);
    const a = allocateWeekSlots({ weekStart: "2027-01-11", channelMix: mix, campaigns, fallbackCampaignId: "c-ever" });
    expect(a.map((s) => s.slotKey)).toEqual(["2027-01-12:facebook:0", "2027-01-12:instagram:0", "2027-01-14:instagram:0", "2027-01-16:instagram:0"]);
    expect(allocateWeekSlots({ weekStart: "2027-01-11", channelMix: mix, campaigns, fallbackCampaignId: "c-ever" })).toEqual(a);
  });
  it("assigns running campaigns round-robin and respects campaign dates and channels", () => {
    const a = allocateWeekSlots({ weekStart: "2027-01-11", channelMix: mix, campaigns, fallbackCampaignId: "c-ever" });
    const ig = a.filter((s) => s.channel === "instagram");
    expect(ig.map((s) => s.campaignId)).toEqual(["c-sank", "c-sub", "c-sub"]);   // Sankranti ends Fri 15th
    expect(a.find((s) => s.channel === "facebook")!.campaignId).toBe("c-sub");
  });
  it("skips slots that already exist and falls back when nothing runs", () => {
    const a = allocateWeekSlots({ weekStart: "2027-01-11", channelMix: mix, campaigns: [], fallbackCampaignId: "c-ever", existingSlotKeys: new Set(["2027-01-12:instagram:0"]) });
    expect(a).toHaveLength(3);
    expect(a.every((s) => s.campaignId === "c-ever")).toBe(true);
  });
});

describe("campaign lifecycle", () => {
  it("matches the SQL transition guard", () => {
    const sql = readFileSync(fileURLToPath(new URL("../../../supabase/migrations/20261120000009_strategy_campaigns.sql", import.meta.url)), "utf8");
    for (const from of CAMPAIGN_STATUSES) {
      const m = sql.match(new RegExp(`old\\.status = '${from}'\\s+and new\\.status in \\(([^)]*)\\)`));
      const allowed = m ? [...m[1]!.matchAll(/'(\w+)'/g)].map((x) => x[1]) : [];
      for (const to of CAMPAIGN_STATUSES) if (to !== from) expect(canTransition(from, to), `${from}->${to}`).toBe(allowed.includes(to));
    }
  });
  it("maps content types to templates", () => {
    expect(templateForContentType("social_post")).toBe("social.post@1");
    expect(templateForContentType("email")).toBe("email.campaign@1");
    expect(templateForContentType("live")).toBeNull();
    expect(maturityFromLabel("Posts occasionally, no plan")).toBe("occasional");
    expect(maturityFromLabel(undefined)).toBe("consistent");
  });
});
