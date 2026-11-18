import { AppError } from "@arcatic/core";
import { HttpClient } from "./http.js";

/**
 * Direct WordPress REST adapter (Application Passwords, HTTP Basic). Endpoints are the ones
 * Postiz's wordpress.provider.ts uses: /wp-json/wp/v2/users/me, /media, /<type>, /categories, /tags.
 * The site URL is user-supplied: callers must run assertSafeUrl() first; redirects are refused.
 */
export interface WordpressCreds {
  siteUrl: string;
  username: string;
  appPassword: string;
}

const noRedirect = (f: typeof fetch): typeof fetch => (input, init) => f(input, { ...init, redirect: "error" });

export class WordpressClient {
  private readonly http: HttpClient;
  private readonly base: string;
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;

  constructor(creds: WordpressCreds, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.base = creds.siteUrl.replace(/\/+$/, "");
    this.auth = `Basic ${Buffer.from(`${creds.username}:${creds.appPassword}`).toString("base64")}`;
    this.fetchImpl = noRedirect(opts.fetchImpl ?? fetch);
    this.http = new HttpClient({ baseUrl: `${this.base}/wp-json/wp/v2`, headers: { authorization: this.auth }, service: "wordpress", fetchImpl: this.fetchImpl, timeoutMs: opts.timeoutMs ?? 30_000 });
  }

  me() {
    return this.http.request<{ id: number; name: string }>("GET", "/users/me");
  }

  categories() {
    return this.http.request<Array<{ id: number; name: string }>>("GET", "/categories?per_page=100");
  }

  tags() {
    return this.http.request<Array<{ id: number; name: string }>>("GET", "/tags?per_page=100");
  }

  /** Raw upload (not retried: WordPress would keep duplicates). */
  async uploadMedia(bytes: Uint8Array, filename: string, contentType: string): Promise<{ id: number; source_url?: string }> {
    const res = await this.fetchImpl(`${this.base}/wp-json/wp/v2/media`, {
      method: "POST",
      headers: { authorization: this.auth, "content-type": contentType, "content-disposition": `attachment; filename="${filename.replace(/["\r\n]/g, "")}"` },
      body: new Blob([bytes.slice()], { type: contentType }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new AppError(res.status === 429 ? "rate_limited" : "upstream_error", `wordpress POST /media → ${res.status}`, { retryable: res.status >= 500 || res.status === 429, details: { status: res.status, body: (await res.text().catch(() => "")).slice(0, 500) } });
    return (await res.json()) as { id: number; source_url?: string };
  }

  createPost(body: { title: string; content: string; slug?: string; status: string; categories?: number[]; tags?: number[]; featured_media?: number }, type = "posts") {
    return this.http.request<{ id: number; link: string; status: string }>("POST", `/${encodeURIComponent(type)}`, body, { idempotent: false });
  }
}
