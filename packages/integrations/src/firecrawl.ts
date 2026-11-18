import { HttpClient, type HttpOptions } from "./http.js";

/**
 * Firecrawl v2 client. Routes verified in firecrawl-main/apps/api/src/routes/v2.ts
 * (mounted at /v2): POST /scrape, POST /map, POST /crawl, GET /crawl/:id, DELETE /crawl/:id,
 * POST /batch/scrape, GET /batch/scrape/:id. Self-hosted Firecrawl is unauthenticated by
 * default → reach it only over the private network (docs/06).
 */
export interface ScrapeOptions {
  formats?: Array<"markdown" | "html" | "rawHtml" | "links" | { type: "json"; schema: Record<string, unknown>; prompt?: string } | { type: "branding" }>;
  onlyMainContent?: boolean;
  timeout?: number;
}

export interface ScrapeResult {
  success: boolean;
  data?: {
    markdown?: string;
    html?: string;
    rawHtml?: string;
    links?: string[];
    json?: unknown;
    /** `branding` format; needs a branding-capable Firecrawl configuration (TypeSafe key or LLM fallback) */
    branding?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
  error?: string;
}

export class FirecrawlClient {
  private readonly http: HttpClient;
  private readonly baseUrl: string;

  constructor(opts: { baseUrl: string; apiKey?: string } & Partial<Pick<HttpOptions, "fetchImpl" | "timeoutMs">>) {
    this.baseUrl = opts.baseUrl;
    this.http = new HttpClient({
      baseUrl: `${opts.baseUrl.replace(/\/$/, "")}/v2`,
      headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
      service: "firecrawl",
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
  }

  scrape(url: string, options: ScrapeOptions = {}, signal?: AbortSignal) {
    return this.http.request<ScrapeResult>("POST", "/scrape", { url, onlyMainContent: true, formats: ["markdown"], ...options }, { idempotent: true, signal });
  }

  map(url: string, opts: { limit?: number; search?: string } = {}) {
    return this.http.request<{ success: boolean; links: Array<{ url: string; title?: string; description?: string } | string> }>("POST", "/map", { url, ...opts }, { idempotent: true });
  }

  startCrawl(url: string, opts: { limit?: number; includePaths?: string[]; excludePaths?: string[]; scrapeOptions?: ScrapeOptions } = {}) {
    return this.http.request<{ success: boolean; id: string; url: string }>("POST", "/crawl", { url, ...opts }, { idempotent: false });
  }

  crawlStatus(id: string) {
    return this.http.request<{ status: "scraping" | "completed" | "failed" | "cancelled"; total: number; completed: number; data: ScrapeResult["data"][]; next?: string }>(
      "GET",
      `/crawl/${encodeURIComponent(id)}`,
    );
  }

  /** Follow a crawl-status `next` link. Only links back to this Firecrawl instance are accepted. */
  crawlNext(nextUrl: string) {
    const base = new URL(this.baseUrl);
    const next = new URL(nextUrl);
    if (next.origin !== base.origin || !next.pathname.startsWith("/v2/crawl/")) throw new Error("Refusing to follow a crawl link outside Firecrawl");
    return this.http.request<{ data?: ScrapeResult["data"][]; next?: string }>("GET", `${next.pathname.slice(3)}${next.search}`);
  }

  cancelCrawl(id: string) {
    return this.http.request<void>("DELETE", `/crawl/${encodeURIComponent(id)}`);
  }
}
