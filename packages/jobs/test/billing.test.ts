import { describe, expect, it } from "vitest";
import { processLagoWebhook, reconcileTopups, syncUsageToLago } from "../src/billing.js";
import { memDb } from "./mem-db.js";

const WS = "11111111-1111-4111-8111-111111111111";
const plans = [
  { key: "starter", name: "Starter", monthly_credits: 300, price_minor: 149900, currency: "INR", limits: {}, lago_plan_code: "arcatic_starter" },
  { key: "growth", name: "Growth", monthly_credits: 1500, price_minor: 499900, currency: "INR", limits: {}, lago_plan_code: "arcatic_growth" },
];
function seed(sub: Record<string, unknown> = {}) {
  const grants: Array<Record<string, unknown>> = [];
  const m = memDb({
    workspaces: [{ id: WS }], plans, invoices: [], credit_topups: [{ id: "t1", workspace_id: WS, credits: 200, status: "pending", lago_invoice_id: "inv-topup" }],
    subscriptions: [{ workspace_id: WS, plan_key: "growth", status: "trialing", past_due_since: null, ...sub }],
  }, { grant_credits: (a) => { grants.push(a); return { id: grants.length }; } });
  return { ...m, grants };
}
const invoice = (o: Record<string, unknown>) => ({ lago_id: "inv-1", number: "ARC-001", invoice_type: "subscription", status: "finalized", payment_status: "succeeded", currency: "INR", fees_amount_cents: 499900, total_amount_cents: 589882, issuing_date: "2026-11-17", file_url: "https://lago.example/inv.pdf", customer: { external_id: WS }, fees: [{ from_date: "2026-11-17T00:00:00Z", to_date: "2026-12-16T23:59:59Z" }], ...o });

describe("Lago webhooks", () => {
  it("a paid subscription invoice grants the plan's credits (pre-tax fee share), activates and sets the period", async () => {
    const m = seed();
    const r = await processLagoWebhook(m.db, { webhook_type: "invoice.payment_status_updated", invoice: invoice({}) as never });
    expect(r.handled).toBe(true);
    expect(m.grants).toEqual([{ p_workspace: WS, p_amount: 1500, p_kind: "grant", p_reference: "invoice:inv-1", p_actor: null }]);
    expect(m.tables.subscriptions![0]).toMatchObject({ status: "active", current_period_end: "2026-12-16T23:59:59Z" });
    expect(m.tables.invoices![0]).toMatchObject({ status: "paid", amount_minor: 589882, pdf_url: "https://lago.example/inv.pdf" });
  });
  it("a prorated upgrade invoice grants prorated credits", async () => {
    const m = seed({ status: "active" });
    await processLagoWebhook(m.db, { webhook_type: "invoice.payment_status_updated", invoice: invoice({ lago_id: "inv-2", fees_amount_cents: 249950 }) as never });
    expect(m.grants[0]!.p_amount).toBe(750);
  });
  it("a paid top-up invoice credits the pack once; a failed one marks it failed", async () => {
    const m = seed();
    await processLagoWebhook(m.db, { webhook_type: "invoice.payment_status_updated", invoice: invoice({ lago_id: "inv-topup", invoice_type: "one_off", fees_amount_cents: 24900 }) as never });
    expect(m.grants).toEqual([{ p_workspace: WS, p_amount: 200, p_kind: "topup", p_reference: "topup:inv-topup", p_actor: null }]);
    expect(m.tables.credit_topups![0]).toMatchObject({ status: "paid", credit_transaction_id: 1 });
    await processLagoWebhook(m.db, { webhook_type: "invoice.payment_status_updated", invoice: invoice({ lago_id: "inv-topup", invoice_type: "one_off" }) as never });
    expect(m.grants).toHaveLength(1);
    const f = seed();
    await processLagoWebhook(f.db, { webhook_type: "invoice.payment_status_updated", invoice: invoice({ lago_id: "inv-topup", invoice_type: "one_off", payment_status: "failed" }) as never });
    expect(f.tables.credit_topups![0]!.status).toBe("failed");
  });
  it("a failed subscription payment starts the grace period", async () => {
    const m = seed({ status: "active" });
    await processLagoWebhook(m.db, { webhook_type: "invoice.payment_status_updated", invoice: invoice({ payment_status: "failed" }) as never });
    expect(m.tables.subscriptions![0]!.status).toBe("past_due");
    expect(m.tables.subscriptions![0]!.past_due_since).toBeTruthy();
    expect(m.grants).toEqual([]);
  });
  it("subscription events mirror plan, scheduled downgrade and cancellation", async () => {
    const m = seed({ status: "active" });
    await processLagoWebhook(m.db, { webhook_type: "subscription.updated", subscription: { lago_id: "s1", external_id: WS, external_customer_id: WS, plan_code: "arcatic_growth", status: "active", next_plan_code: "arcatic_starter", downgrade_plan_date: "2026-12-17" } });
    expect(m.tables.subscriptions![0]).toMatchObject({ plan_key: "growth", pending_plan_key: "starter", pending_change_at: "2026-12-17" });
    await processLagoWebhook(m.db, { webhook_type: "subscription.terminated", subscription: { lago_id: "s1", external_id: WS, external_customer_id: WS, plan_code: "arcatic_growth", status: "terminated", next_plan_code: "arcatic_starter" } });
    expect(m.tables.subscriptions![0]!.status).toBe("active");   // replaced by the downgrade, not cancelled
    await processLagoWebhook(m.db, { webhook_type: "subscription.terminated", subscription: { lago_id: "s2", external_id: WS, external_customer_id: WS, plan_code: "arcatic_starter", status: "terminated", terminated_at: "2026-12-30T00:00:00Z" } });
    expect(m.tables.subscriptions![0]).toMatchObject({ status: "cancelled", cancelled_at: "2026-12-30T00:00:00Z" });
  });
  it("ignores unknown customers and event types", async () => {
    const m = seed();
    expect((await processLagoWebhook(m.db, { webhook_type: "invoice.created", invoice: invoice({ customer: { external_id: "someone-else" } }) as never })).handled).toBe(false);
    expect((await processLagoWebhook(m.db, { webhook_type: "customer.updated" })).handled).toBe(false);
  });
});

describe("usage sync", () => {
  it("sends unsynced credit usage in batches of 100 and marks it synced", async () => {
    const usage = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, workspace_id: WS, metric: "credits", quantity: 1.5, transaction_id: `reservation:${i}`, created_at: "2026-11-17T10:00:00Z", job_id: null, lago_synced_at: null }));
    const m = memDb({ subscriptions: [{ workspace_id: WS, lago_subscription_id: "s1" }], usage_events: usage });
    const batches: Array<Array<Record<string, unknown>>> = [];
    const lago = { sendEvents: async (e: Array<Record<string, unknown>>) => { batches.push(e); } };
    expect(await syncUsageToLago(m.db, lago as never)).toEqual({ sent: 150 });
    expect(batches.map((b) => b.length)).toEqual([100, 50]);
    expect(batches[0]![0]).toEqual({ transaction_id: "reservation:0", external_subscription_id: WS, code: "arcatic_credits", timestamp: Date.parse("2026-11-17T10:00:00Z") / 1000, properties: { credits: 1.5 } });
    expect(m.tables.usage_events!.every((u) => u.lago_synced_at)).toBe(true);
  });
});

describe("top-up reconciliation", () => {
  it("credits a pending top-up whose invoice is already paid in the mirror, once", async () => {
    const grants: unknown[] = [];
    const m = memDb({
      credit_topups: [{ id: "t1", workspace_id: WS, credits: 1000, status: "pending", lago_invoice_id: "inv-7" }, { id: "t2", workspace_id: WS, credits: 200, status: "pending", lago_invoice_id: "inv-8" }],
      invoices: [{ lago_invoice_id: "inv-7", status: "paid" }, { lago_invoice_id: "inv-8", status: "pending" }],
    }, { grant_credits: (a) => { grants.push(a); return { id: 3 }; } });
    expect(await reconcileTopups(m.db)).toBe(1);
    expect(grants).toEqual([{ p_workspace: WS, p_amount: 1000, p_kind: "topup", p_reference: "topup:inv-7", p_actor: null }]);
    expect(m.tables.credit_topups!.map((t) => t.status)).toEqual(["paid", "pending"]);
    expect(await reconcileTopups(m.db)).toBe(0);
  });
});
