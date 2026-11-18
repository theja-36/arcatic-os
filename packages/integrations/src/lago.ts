import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@arcatic/core";
import { HttpClient } from "./http.js";

/**
 * Lago REST client. Contract verified against Lago's published OpenAPI spec
 * (swagger.getlago.com/openapi.yaml) — the lago-main folder has an empty api/ submodule:
 *   POST /customers (upsert by external_id) · POST /customers/{id}/checkout_url · GET /customers/{id}/portal_url
 *   POST /subscriptions (same external_id + new plan_code = upgrade now / downgrade at period end)
 *   PUT /subscriptions/{external_id} {ending_at} · DELETE /subscriptions/{external_id}?status=
 *   POST /invoices (one-off, add-on fees) · POST /events/batch (≤ 100 events)
 *   POST /billable_metrics · POST /add_ons · POST /plans
 * Webhooks: X-Lago-Signature = base64(HMAC-SHA256(raw body, HMAC key)) when the endpoint uses `hmac`;
 *   X-Lago-Unique-Key identifies a delivery.
 */
export interface LagoInvoice {
  lago_id: string;
  number: string;
  invoice_type: "subscription" | "add_on" | "credit" | "one_off" | "advance_charges" | "progressive_billing";
  status: "draft" | "finalized" | "voided" | "failed" | "pending" | "deleted";
  payment_status: "pending" | "succeeded" | "failed";
  currency: string;
  fees_amount_cents: number;
  total_amount_cents: number;
  total_paid_amount_cents?: number;
  issuing_date: string | null;
  file_url: string | null;
  customer?: { external_id: string };
  fees?: Array<{ from_date?: string | null; to_date?: string | null; item?: { type?: string; code?: string } }>;
}
export interface LagoSubscription {
  lago_id: string;
  external_id: string;
  external_customer_id: string;
  plan_code: string;
  status: "active" | "canceled" | "incomplete" | "pending" | "terminated";
  current_billing_period_started_at?: string | null;
  current_billing_period_ending_at?: string | null;
  next_plan_code?: string | null;
  downgrade_plan_date?: string | null;
  ending_at?: string | null;
  terminated_at?: string | null;
}

export class LagoClient {
  private readonly http: HttpClient;
  constructor(opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }) {
    this.http = new HttpClient({ baseUrl: `${opts.baseUrl.replace(/\/+$/, "")}/api/v1`, headers: { authorization: `Bearer ${opts.apiKey}` }, service: "lago", fetchImpl: opts.fetchImpl });
  }

  upsertCustomer(c: { external_id: string; name: string; email?: string | null; currency: string; country?: string | null; payment_provider?: string | null; payment_provider_code?: string | null }) {
    return this.http.request<{ customer: { lago_id: string; external_id: string } }>("POST", "/customers", {
      customer: {
        external_id: c.external_id, name: c.name, email: c.email ?? undefined, currency: c.currency, country: c.country ?? undefined,
        ...(c.payment_provider && { billing_configuration: { payment_provider: c.payment_provider, ...(c.payment_provider_code && { payment_provider_code: c.payment_provider_code }), sync_with_provider: true } }),
      },
    }, { idempotent: true });
  }
  checkoutUrl(externalCustomerId: string) {
    return this.http.request<{ customer: { checkout_url: string | null } }>("POST", `/customers/${encodeURIComponent(externalCustomerId)}/checkout_url`, {}, { idempotent: true });
  }
  portalUrl(externalCustomerId: string) {
    return this.http.request<{ customer: { portal_url: string } }>("GET", `/customers/${encodeURIComponent(externalCustomerId)}/portal_url`);
  }
  /** New subscription, or plan change when external_id already exists. */
  assignPlan(s: { external_customer_id: string; external_id: string; plan_code: string }) {
    return this.http.request<{ subscription: LagoSubscription }>("POST", "/subscriptions", { subscription: { ...s, billing_time: "anniversary" } }, { idempotent: false });
  }
  setEndingAt(externalId: string, endingAt: string | null) {
    return this.http.request<{ subscription: LagoSubscription }>("PUT", `/subscriptions/${encodeURIComponent(externalId)}`, { subscription: { ending_at: endingAt } });
  }
  terminate(externalId: string, status: "active" | "pending" = "active") {
    return this.http.request<{ subscription: LagoSubscription }>("DELETE", `/subscriptions/${encodeURIComponent(externalId)}?status=${status}`);
  }
  oneOffInvoice(i: { external_customer_id: string; currency: string; add_on_code: string; units: number; unit_amount_cents: number; description: string }) {
    return this.http.request<{ invoice: LagoInvoice }>("POST", "/invoices", {
      invoice: { external_customer_id: i.external_customer_id, currency: i.currency, fees: [{ add_on_code: i.add_on_code, units: i.units, unit_amount_cents: i.unit_amount_cents, description: i.description }] },
    }, { idempotent: false });
  }
  sendEvents(events: Array<{ transaction_id: string; external_subscription_id: string; code: string; timestamp: number; properties: Record<string, unknown> }>) {
    if (events.length > 100) throw new AppError("validation_failed", "Lago accepts at most 100 events per batch.");
    return this.http.request<unknown>("POST", "/events/batch", { events }, { idempotent: true });   // transaction_id makes retries safe
  }
  // catalog setup (scripts/lago-setup.ts)
  createBillableMetric(m: { name: string; code: string; field_name: string }) {
    return this.http.request<unknown>("POST", "/billable_metrics", { billable_metric: { ...m, aggregation_type: "sum_agg" } }, { idempotent: false });
  }
  createAddOn(a: { name: string; code: string; amount_cents: number; amount_currency: string }) {
    return this.http.request<unknown>("POST", "/add_ons", { add_on: a }, { idempotent: false });
  }
  createPlan(p: { name: string; code: string; amount_cents: number; amount_currency: string; trial_period?: number }) {
    return this.http.request<unknown>("POST", "/plans", { plan: { ...p, interval: "monthly", pay_in_advance: true, trial_period: p.trial_period ?? 0 } }, { idempotent: false });
  }
}

/** Constant-time check of an `hmac` webhook signature. */
export function verifyLagoHmac(rawBody: string, signature: string | null | undefined, key: string): boolean {
  if (!signature || !key) return false;
  const expected = createHmac("sha256", key).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(expected), b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
