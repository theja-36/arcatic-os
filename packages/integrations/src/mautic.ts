import { HttpClient } from "./http.js";

/**
 * Mautic REST adapter (mautic-7.x). Verified in source:
 *  - standard entity routes (CoreSubscriber): GET /api/segments, POST /api/emails/new, GET /api/emails/{id}
 *  - POST /api/emails/{id}/send (EmailApiController::sendAction → sendEmailToLists) → { success, sentCount, failedRecipients }
 *  - JSON bodies accepted (fos_rest body_listener); Email API fields include name, subject, preheaderText,
 *    customHtml, plainText, emailType, lists, fromName, fromAddress, publishUp
 * Auth: HTTP Basic — Mautic ships with api_enable_basic_auth = false; the admin must enable it.
 */
export interface MauticCreds {
  baseUrl: string;
  username: string;
  password: string;
}
export interface MauticSegment {
  id: number;
  name: string;
  alias?: string;
  isPublished?: boolean;
}

const noRedirect = (f: typeof fetch): typeof fetch => (input, init) => f(input, { ...init, redirect: "error" });

export class MauticClient {
  private readonly http: HttpClient;

  constructor(creds: MauticCreds, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.http = new HttpClient({
      baseUrl: `${creds.baseUrl.replace(/\/+$/, "")}/api`,
      headers: { authorization: `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}` },
      service: "mautic",
      fetchImpl: noRedirect(opts.fetchImpl ?? fetch),
      timeoutMs: opts.timeoutMs ?? 30_000,
    });
  }

  async segments(): Promise<MauticSegment[]> {
    const r = await this.http.request<{ lists?: Record<string, MauticSegment> | MauticSegment[] }>("GET", "/segments?limit=500&minimal=1");
    const lists = r?.lists ?? [];
    return (Array.isArray(lists) ? lists : Object.values(lists)).map((l) => ({ id: Number(l.id), name: l.name, alias: l.alias, isPublished: l.isPublished }));
  }

  createSegmentEmail(e: { name: string; subject: string; preheaderText?: string; customHtml: string; plainText?: string; segmentIds: number[]; fromName?: string; fromAddress?: string }) {
    return this.http.request<{ email: { id: number } }>("POST", "/emails/new", {
      name: e.name, subject: e.subject, preheaderText: e.preheaderText, customHtml: e.customHtml, plainText: e.plainText,
      emailType: "list", lists: e.segmentIds, isPublished: true, fromName: e.fromName, fromAddress: e.fromAddress,
    }, { idempotent: false });
  }

  /** Sends to the segment's contacts that haven't received this email yet. */
  send(emailId: number) {
    return this.http.request<{ success: number; sentCount: number; failedRecipients: number | unknown[] }>("POST", `/emails/${emailId}/send`, {}, { idempotent: false });
  }

  /**
   * Delivery and click counts for one email from the stats API (GET /api/stats/{table},
   * where[n][col|expr|val]; tables email_stats and channel_url_trackables, results under `stats`).
   */
  async emailStats(emailId: number): Promise<{ sent: number; opens: number; failed: number; clicks: number; uniqueClicks: number }> {
    const where = (conds: Array<[string, string]>) => conds.map(([col, val], i) => `where[${i}][col]=${col}&where[${i}][expr]=eq&where[${i}][val]=${encodeURIComponent(val)}`).join("&");
    const [e, failed, links] = await Promise.all([
      this.email(emailId),
      this.http.request<{ total: number | string }>("GET", `/stats/email_stats?${where([["email_id", String(emailId)], ["is_failed", "1"]])}&limit=1`),
      this.http.request<{ stats: Array<{ hits: number | string; unique_hits: number | string }> }>("GET", `/stats/channel_url_trackables?${where([["channel", "email"], ["channel_id", String(emailId)]])}&limit=200`),
    ]);
    return {
      sent: Number(e.email.sentCount ?? 0), opens: Number(e.email.readCount ?? 0), failed: Number(failed.total ?? 0),
      clicks: (links.stats ?? []).reduce((s, r) => s + Number(r.hits ?? 0), 0), uniqueClicks: (links.stats ?? []).reduce((s, r) => s + Number(r.unique_hits ?? 0), 0),
    };
  }

  email(emailId: number) {
    return this.http.request<{ email: { id: number; sentCount: number; readCount: number } }>("GET", `/emails/${emailId}`);
  }
}
