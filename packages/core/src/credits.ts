/**
 * Credit cost model (docs/05). Reservation = `max`; settlement = actual, capped at the reservation.
 */
export const BASE_COSTS = {
  "generate.social_post": 1,
  "generate.caption": 1,
  "generate.static_visual": 2,
  "generate.image": 4,
  "generate.email": 3,
  "generate.blog": 8,
  "generate.x_thread": 2,
  "generate.yt_script": 4,
  "generate.ad_copy": 2,
  "generate.newsletter": 3,
  "generate.press_release": 3,
  "generate.case_study": 5,
  "generate.brief": 2,
  "generate.landing_page": 4,
  "generate.sales_sheet": 3,
  "generate.product_copy": 2,
  "generate.brainstorm": 1,
  "generate.document": 4,
  "repurpose.digest": 2,
  "research.competitor": 3,
  "research.keywords": 2,
  "seo.brief": 3,
  "ads.draft": 3,
  "generate.translation": 1,
  "generate.transform": 0.5,
  "generate.video_per_second": 1,
  "ingest.url": 0.2,
  "ingest.crawl_page": 0.1,
  "ingest.document_page": 0.05,
  "ingest.media_minute": 0.5,
  "brand.extract": 5,
  "strategy.generate": 10,
  "strategy.weekly_plan": 1,
  "render.video_minute": 0.5,
  "system.self_test": 0,
} as const;
export type CostedKind = keyof typeof BASE_COSTS;

export const MODEL_TIER_MULTIPLIER = { economy: 0.5, standard: 1, premium: 3 } as const;
export type ModelTier = keyof typeof MODEL_TIER_MULTIPLIER;

export interface EstimateInput {
  kind: CostedKind;
  quantity?: number;          // images, seconds, pages, minutes, variants
  modelTier?: ModelTier;
}

export interface Estimate {
  estimate: number;
  max: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function estimateCredits({ kind, quantity = 1, modelTier = "standard" }: EstimateInput): Estimate {
  if (!(kind in BASE_COSTS)) throw new Error(`unknown kind ${kind}`);
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error("quantity must be >= 0");
  const estimate = round3(BASE_COSTS[kind] * quantity * MODEL_TIER_MULTIPLIER[modelTier]);
  // headroom for retries/longer outputs; settlement never exceeds this
  return { estimate, max: round3(estimate * 1.5) };
}
