import { z } from "zod";

/**
 * Ad campaign drafts. Arcatic supports a deliberately small, well-understood subset:
 *   Google: Search campaigns with one ad group, one responsive search ad and keywords.
 *   Meta:   one campaign → one ad set → one link ad (single image) for traffic or awareness.
 * Everything is created PAUSED; nothing spends until a second approval activates it.
 */
export const AD_PLATFORMS = ["google", "meta"] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

export const AD_OBJECTIVES = {
  google: { website_traffic: "Website traffic (Search)" },
  meta: { traffic: "Traffic (link clicks)", awareness: "Awareness (reach)" },
} as const;

/** Meta Campaign.SpecialAdCategories (facebook-business 26.0.4). Political ads are not supported here. */
export const META_SPECIAL_CATEGORIES = ["CREDIT", "EMPLOYMENT", "FINANCIAL_PRODUCTS_SERVICES", "HOUSING", "ONLINE_GAMBLING_AND_GAMING"] as const;
/** call_to_action types used here (all present in the SDK's CallToAction enum). */
export const META_CTAS = ["LEARN_MORE", "SHOP_NOW", "BOOK_NOW", "ORDER_NOW", "GET_OFFER", "CONTACT_US"] as const;

export const AdLocationSchema = z.object({
  key: z.string().min(1).max(64),            // Google geo target constant id · Meta country code / location key
  name: z.string().min(1).max(200),
  type: z.enum(["country", "region", "city", "geo_target"]),
});
export const AdKeywordSchema = z.object({ text: z.string().trim().min(1).max(80), match: z.enum(["BROAD", "PHRASE", "EXACT"]).default("PHRASE") });
export const AdInterestSchema = z.object({ id: z.string().min(1).max(40), name: z.string().min(1).max(200) });

export const AdAudienceSchema = z.object({
  locations: z.array(AdLocationSchema).max(25).default([]),
  languageIds: z.array(z.string().regex(/^\d+$/)).max(10).optional(),           // Google language constants
  ageMin: z.number().int().min(18).max(65).default(18),
  ageMax: z.number().int().min(18).max(65).default(65),
  genders: z.array(z.enum(["male", "female"])).max(2).default([]),               // empty = all
  interests: z.array(AdInterestSchema).max(25).default([]),
  keywords: z.array(AdKeywordSchema).max(50).default([]),
  negativeKeywords: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
});
export type AdAudience = z.infer<typeof AdAudienceSchema>;

export const GoogleCreativeSchema = z.object({
  headlines: z.array(z.string().trim().min(1)).max(15).default([]),
  descriptions: z.array(z.string().trim().min(1)).max(4).default([]),
  path1: z.string().trim().max(15).optional().nullable(),
  path2: z.string().trim().max(15).optional().nullable(),
});
export const MetaCreativeSchema = z.object({
  primaryText: z.string().trim().max(2000).default(""),
  headline: z.string().trim().max(255).default(""),
  description: z.string().trim().max(255).optional().nullable(),
  cta: z.enum(META_CTAS).default("LEARN_MORE"),
  mediaAssetId: z.string().uuid().optional().nullable(),
});
export type GoogleCreative = z.infer<typeof GoogleCreativeSchema>;
export type MetaCreative = z.infer<typeof MetaCreativeSchema>;

export const AdBriefSchema = z.object({
  offer: z.string().trim().max(1000).optional(),
  audience: z.string().trim().max(1000).optional(),
  goal: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const AdCampaignDraftSchema = z.object({
  connectionId: z.string().uuid(),
  platform: z.enum(AD_PLATFORMS),
  name: z.string().trim().min(1).max(200),
  objective: z.string().min(1).max(40),
  brief: AdBriefSchema.default({}),
  audience: AdAudienceSchema.default(() => AdAudienceSchema.parse({})),
  creative: z.record(z.string(), z.unknown()).default({}),
  landingUrl: z.string().url().max(2000).optional().nullable(),
  dailyBudgetMinor: z.number().int().positive().max(1_000_000_000).optional().nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  specialAdCategories: z.array(z.enum(META_SPECIAL_CATEGORIES)).max(5).default([]),
  sourceContentItemId: z.string().uuid().optional().nullable(),
});
export type AdCampaignDraft = z.infer<typeof AdCampaignDraftSchema>;

export const AdPolicySchema = z.object({
  manageEnabled: z.boolean(),
  maxDailyBudgetMinor: z.number().int().positive().max(1_000_000_000),
  monthlySpendCapMinor: z.number().int().positive().max(100_000_000_000).nullable().optional(),
  autoPauseOnCap: z.boolean().default(true),
  requireSeparateApprover: z.boolean().default(true),
  pageId: z.string().regex(/^\d+$/).max(40).nullable().optional(),
  instagramUserId: z.string().regex(/^\d+$/).max(40).nullable().optional(),
});
