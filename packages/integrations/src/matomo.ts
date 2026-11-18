import { AppError } from "@arcatic/core";

/**
 * Matomo Reporting API (matomo-6.x): POST index.php?module=API&method=<Plugin.method>&format=JSON,
 * token_auth in the POST body (Matomo treats a token outside the URL as "provided securely").
 * Verified methods: VisitsSummary.get (nb_uniq_visitors, nb_visits, nb_actions, nb_visits_converted, bounce_count, sum_visit_length),
 * Goals.get (nb_conversions, revenue), Referrers.getCampaigns (label = utm_campaign, nb_visits, goals).
 * The URL is user-supplied: callers run assertSafeUrl() first; redirects are refused.
 */
export type MatomoDaily<T> = Record<string, T>;
export interface VisitsDay { nb_visits?: number; nb_uniq_visitors?: number; nb_actions?: number; nb_visits_converted?: number; bounce_count?: number; sum_visit_length?: number }
export interface GoalsDay { nb_conversions?: number; revenue?: number | string }
export interface CampaignRow { label: string; nb_visits?: number; nb_conversions?: number; revenue?: number | string; goals?: Record<string, { nb_conversions?: number; revenue?: number }> }

export class MatomoClient {
  private readonly endpoint: string;
  constructor(private readonly opts: { baseUrl: string; token: string; siteId: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.endpoint = `${opts.baseUrl.replace(/\/+$/, "")}/index.php`;
  }

  private async call<T>(method: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams({ module: "API", method, format: "JSON", idSite: this.opts.siteId, ...params });
    const res = await (this.opts.fetchImpl ?? fetch)(`${this.endpoint}?${qs}`, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ token_auth: this.opts.token }).toString(),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new AppError(res.status === 429 ? "rate_limited" : "upstream_error", `matomo ${method} → ${res.status}`, { retryable: res.status >= 500 || res.status === 429, details: { status: res.status, body: text.slice(0, 300) } });
    const data = JSON.parse(text) as T | { result: "error"; message: string };
    if (data && typeof data === "object" && (data as { result?: string }).result === "error") {
      const message = (data as { message: string }).message;
      throw new AppError("upstream_error", `Matomo: ${message}`, { retryable: false, details: { status: /token|access|permission/i.test(message) ? 401 : 400, body: message } });
    }
    return data as T;
  }

  /** period=day over a date range → one entry per day (YYYY-MM-DD). */
  visits(from: string, to: string) { return this.call<MatomoDaily<VisitsDay | []>>("VisitsSummary.get", { period: "day", date: `${from},${to}` }); }
  goals(from: string, to: string) { return this.call<MatomoDaily<GoalsDay | []>>("Goals.get", { period: "day", date: `${from},${to}` }); }
  campaigns(from: string, to: string) { return this.call<MatomoDaily<CampaignRow[]>>("Referrers.getCampaigns", { period: "day", date: `${from},${to}`, flat: "1" }); }
}
