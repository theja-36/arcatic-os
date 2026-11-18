import { HttpClient } from "./http.js";

/**
 * Client for services/ads-sync (Python sidecar using the official google-ads and facebook-business
 * SDKs from the project folder). Credentials are passed per call; the sidecar stores nothing.
 */
export interface AdCampaignDay {
  date: string;
  campaignId: string;
  campaignName: string;
  impressions: number;
  clicks: number;
  costMinor: number;          // currency minor units (micros/10_000 for Google; spend*100 for Meta)
  conversions: number;
  conversionValueMinor: number;
  videoViews: number;
  reach?: number | null;
}

export interface KeywordIdeaRow {
  keyword: string;
  avgMonthlySearches: number | null;
  competition: "LOW" | "MEDIUM" | "HIGH" | "UNSPECIFIED" | "UNKNOWN";
  competitionIndex: number | null;
  lowBidMinor: number | null;
  highBidMinor: number | null;
}
export interface GoogleAuth { customerId: string; loginCustomerId?: string | null; refreshToken: string }
export interface MetaAuth { accessToken: string }

/** Campaign as sent to the sidecar (validated by Arcatic first; the sidecar validates again). */
export interface SidecarCampaign {
  id: string;
  name: string;
  objective: string;
  currency: string;
  dailyBudgetMinor: number;
  landingUrl: string;
  startDate?: string | null;
  endDate?: string | null;
  audience: unknown;
  creative: unknown;
  specialAdCategories?: string[];
  pageId?: string | null;
  instagramUserId?: string | null;
  imageUrl?: string | null;
  timezoneOffset?: string;
}
export interface CreatedCampaign { campaignId: string; currency: string; reused: boolean; campaignResourceName?: string; budgetResourceName?: string; adSetId?: string; creativeId?: string; adId?: string }

export class AdsSyncClient {
  private readonly http: HttpClient;
  constructor(opts: { baseUrl: string; secret: string; fetchImpl?: typeof fetch }) {
    this.http = new HttpClient({ baseUrl: opts.baseUrl, headers: { "x-arcatic-secret": opts.secret }, service: "ads-sync", fetchImpl: opts.fetchImpl, timeoutMs: 120_000 });
  }
  googleAds(body: { customerId: string; loginCustomerId?: string | null; refreshToken: string; from: string; to: string }) {
    return this.http.request<{ rows: AdCampaignDay[]; currency: string | null }>("POST", "/google-ads/campaign-daily", body, { idempotent: true });
  }
  meta(body: { adAccountId: string; accessToken: string; from: string; to: string }) {
    return this.http.request<{ rows: AdCampaignDay[]; currency: string | null }>("POST", "/meta/campaign-daily", body, { idempotent: true });
  }

  // ---- research (read-only, safe to retry)
  keywordIdeas(body: GoogleAuth & { keywords: string[]; url?: string | null; locationIds: string[]; languageId?: string; limit?: number }) {
    return this.http.request<{ ideas: KeywordIdeaRow[] }>("POST", "/google-ads/keyword-ideas", body, { idempotent: true });
  }
  googleGeoSuggest(body: GoogleAuth & { query: string; countryCode?: string; locale?: string }) {
    return this.http.request<{ locations: Array<{ key: string; name: string; canonicalName: string; type: string; countryCode: string; reach: number }> }>("POST", "/google-ads/geo-suggest", body, { idempotent: true });
  }
  metaSearch(body: MetaAuth & { kind: "interest" | "geo"; q: string }) {
    return this.http.request<{ results: Array<Record<string, unknown>> }>("POST", "/meta/search", body, { idempotent: true });
  }

  // ---- campaign management: never retried at the HTTP layer (the sidecar's create is retry-safe by name,
  // but money-moving calls are retried only by the workflow, which records each attempt)
  googleCreate(body: GoogleAuth & { campaign: SidecarCampaign }) {
    return this.http.request<CreatedCampaign>("POST", "/google-ads/campaigns", body, { idempotent: false });
  }
  googleUpdate(body: GoogleAuth & { campaignId: string; budgetResourceName?: string; status?: "active" | "paused"; dailyBudgetMinor?: number }) {
    return this.http.request<{ done: string[] }>("POST", "/google-ads/campaigns/update", body, { idempotent: false });
  }
  metaCreate(body: MetaAuth & { adAccountId: string; campaign: SidecarCampaign }) {
    return this.http.request<CreatedCampaign>("POST", "/meta/campaigns", body, { idempotent: false });
  }
  metaUpdate(body: MetaAuth & { campaignId: string; adSetId?: string; status?: "active" | "paused"; dailyBudgetMinor?: number }) {
    return this.http.request<{ done: string[] }>("POST", "/meta/campaigns/update", body, { idempotent: false });
  }
}
