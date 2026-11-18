import { describe, expect, it } from "vitest";
import {
  actionSummary, AdAudienceSchema, allowedActions, campaignsToPause, checkBudget, checkCompliance, checkRsa, confirmPhrase, docFrom,
  googleLength, minorToMicros, personalAttributeRisk, projectedMonthlyMinor, seedGoogleCreative, seedMetaCreative, spendLevel, statusAfter,
  type ComplianceInput,
} from "../src/index.js";

const policy = { manageEnabled: true, maxDailyBudgetMinor: 200_000, monthlySpendCapMinor: 3_000_000, autoPauseOnCap: true };
const audience = AdAudienceSchema.parse({ locations: [{ key: "2356", name: "India", type: "country" }], keywords: [{ text: "diwali hampers", match: "PHRASE" }] });
const rsa = {
  headlines: ["Diwali Hampers for Teams", "Delivered Across India", "Order by 1 October", "Custom Branded Boxes", "Bulk Pricing Available", "Sweets and Dry Fruits", "Corporate Gifting Made Easy", "Free Gift Messages"],
  descriptions: ["Curated Diwali hampers with sweets, dry fruits and useful gifts.", "Bulk pricing for 50+ hampers. Delivery to every office in India."],
  path1: "diwali", path2: "hampers",
};
const base: ComplianceInput = { platform: "google", name: "Diwali search", objective: "website_traffic", audience, creative: rsa, landingUrl: "https://example.in/diwali", dailyBudgetMinor: 100_000, specialAdCategories: [], policy, today: "2026-11-17" };

describe("Google RSA rules", () => {
  it("accepts a valid ad", () => expect(checkRsa(rsa).filter((i) => i.severity === "error")).toEqual([]));
  it("enforces counts, lengths, paths and duplicates", () => {
    const codes = checkRsa({ headlines: ["A", "a", "This headline is definitely longer than thirty"], descriptions: ["One"], path1: null, path2: "x" }).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["rsa_descriptions_min", "rsa_headline_length", "rsa_path_order", "rsa_duplicate"]));
  });
  it("counts double-width characters as two", () => {
    expect(googleLength("日本語")).toBe(6);
    expect(googleLength("दिवाली")).toBe(6);
    expect(checkRsa({ ...rsa, headlines: [...rsa.headlines.slice(0, 2), "日本語日本語日本語日本語日本語日本"] }).some((i) => i.code === "rsa_headline_length")).toBe(true);
  });
  it("warns about editorial problems", () => {
    const codes = checkRsa({ ...rsa, headlines: ["Huge Sale!", "Shop TODAY Only", "Call +91 98765 43210"] }).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["editorial_exclamation", "editorial_caps", "editorial_phone"]));
  });
  it("converts minor units to micros", () => expect(minorToMicros(50_000)).toBe(500_000_000));
});

describe("compliance report", () => {
  it("passes a complete Google campaign", () => {
    const r = checkCompliance(base);
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.passed).toBe(true);
  });
  it("blocks missing pieces, http landing pages, past dates and political ads", () => {
    const r = checkCompliance({ ...base, name: "Vote for change", audience: { ...audience, keywords: [] }, landingUrl: "http://example.in", startDate: "2026-01-01" });
    expect(r.passed).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["keywords_min", "landing_https", "start_past", "political"]));
  });
  it("flags risky claims as warnings for the reviewer", () => {
    const r = checkCompliance({ ...base, creative: { ...rsa, descriptions: ["Guaranteed results or your money back, risk-free.", rsa.descriptions[1]] } });
    expect(r.passed).toBe(true);
    expect(r.issues.some((i) => i.code === "claim_guarantee" && i.severity === "warning")).toBe(true);
  });
  it("Meta: personal attributes are blocked, special categories restrict targeting, hints suggest a category", () => {
    const meta: ComplianceInput = { ...base, platform: "meta", objective: "traffic", hasImage: true, endDate: "2026-12-01", creative: { primaryText: "Struggling with your debt? Our loan helps.", headline: "Easy loans", cta: "LEARN_MORE" } };
    const r = checkCompliance(meta);
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["meta_personal_attributes", "special_category_hint"]));
    const r2 = checkCompliance({ ...meta, creative: { primaryText: "Flexible business loans with clear terms.", headline: "Business loans", cta: "LEARN_MORE" }, specialAdCategories: ["CREDIT"], audience: { ...audience, ageMin: 25, genders: ["male"] } });
    expect(r2.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["special_age", "special_gender"]));
    expect(r2.issues.some((i) => i.code === "special_category_hint")).toBe(false);
  });
  it("Meta: requires an image and warns about truncation", () => {
    const r = checkCompliance({ ...base, platform: "meta", hasImage: false, creative: { primaryText: "x".repeat(200), headline: "A headline that is far too long for most placements", cta: "SHOP_NOW" } });
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["meta_image", "meta_primary_long", "meta_headline_long", "no_end_date"]));
  });
  it("detects personal-attribute phrasing only with second person", () => {
    expect(personalAttributeRisk("Are you depressed? Try this.")).toBe("Are you depressed?");
    expect(personalAttributeRisk("Support for people living with diabetes.")).toBeNull();
  });
});

describe("budget guards", () => {
  it("requires management switched on and the account limit", () => {
    expect(checkBudget(100_000, { ...policy, manageEnabled: false }).map((i) => i.code)).toContain("manage_disabled");
    expect(checkBudget(300_000, policy).map((i) => i.code)).toContain("budget_over_limit");
    expect(checkBudget(null, policy).map((i) => i.code)).toEqual(["budget_missing"]);
    expect(checkBudget(150_000, policy).map((i) => i.code)).toContain("budget_over_cap");
  });
  it("projects a month at 30.4 days and pauses at the cap", () => {
    expect(projectedMonthlyMinor(100_000)).toBe(3_040_000);
    expect(spendLevel(2_500_000, 3_000_000)).toBe("near");
    expect(spendLevel(3_000_000, 3_000_000)).toBe("over");
    expect(campaignsToPause(3_100_000, policy, [{ id: "a" }, { id: "b" }])).toEqual(["a", "b"]);
    expect(campaignsToPause(3_100_000, { ...policy, autoPauseOnCap: false }, [{ id: "a" }])).toEqual([]);
    expect(campaignsToPause(100, policy, [{ id: "a" }])).toEqual([]);
  });
});

describe("campaign state machine", () => {
  it("only allows safe transitions", () => {
    expect(allowedActions("draft")).toEqual(["launch"]);
    expect(allowedActions("launching")).toEqual([]);
    expect(allowedActions("paused")).toContain("activate");
    expect(allowedActions("active")).not.toContain("launch");
    expect(statusAfter("launch", "draft")).toBe("paused");
    expect(statusAfter("budget_change", "active")).toBe("active");
  });
  it("asks for a typed confirmation on critical actions", () => {
    expect(confirmPhrase("launch", { name: " Diwali search " })).toBe("Diwali search");
    expect(confirmPhrase("budget_change", { name: "x" }, { dailyBudgetMinor: 75_000 })).toBe("750.00");
    expect(confirmPhrase("pause", { name: "x" })).toBeNull();
    expect(actionSummary("launch", { name: "Diwali search", platform: "google", dailyBudgetMinor: 50_000 })).toMatch(/PAUSED.*₹500\.00\/day/);
  });
});

describe("organic → paid", () => {
  const post = docFrom([["hook", "Diwali hampers your team will love."], ["body", "Sweets, dry fruits and a useful gift. Delivered anywhere in India. https://example.in #diwali"], ["hashtags", "#diwali #gifting"]]);
  it("seeds Google copy only from text that fits", () => {
    const c = seedGoogleCreative(post);
    expect(c.headlines.every((h) => googleLength(h) <= 30)).toBe(true);
    expect(c.descriptions.every((d) => googleLength(d) <= 90)).toBe(true);
    expect(c.descriptions.join(" ")).not.toMatch(/https?:|#diwali/);
  });
  it("seeds Meta copy", () => {
    const c = seedMetaCreative(post);
    expect(c.primaryText).toContain("Diwali hampers your team will love.");
    expect(c.headline.length).toBeLessThanOrEqual(40);
    expect(c.cta).toBe("LEARN_MORE");
  });
});
