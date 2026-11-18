import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { ApiDeps, Membership } from "../src/types.js";
import { ACTIVE_SUBSCRIPTION, fakeDb } from "./fake-db.js";

const WS = "11111111-1111-4111-8111-111111111111";
const BRAND = "33333333-3333-4333-8333-333333333333";
const plans = {
  starter: { key: "starter", name: "Starter", monthly_credits: 300, price_minor: 149900, currency: "INR", limits: { max_brands: 1, max_seats: 2, max_connected_accounts: 5, video: false }, lago_plan_code: "arcatic_starter", topups: true },
  growth: { key: "growth", name: "Growth", monthly_credits: 1500, price_minor: 499900, currency: "INR", limits: { max_brands: 3, max_seats: 5, max_connected_accounts: 15, video: true }, lago_plan_code: "arcatic_growth", topups: true },
};

function lagoMock() {
  return {
    upsertCustomer: vi.fn(async () => ({ customer: { lago_id: "c1", external_id: WS } })),
    assignPlan: vi.fn(async () => ({ subscription: { lago_id: "s1", external_id: WS, external_customer_id: WS, plan_code: "x", status: "active", downgrade_plan_date: "2026-12-01" } })),
    setEndingAt: vi.fn(async () => ({ subscription: {} })),
    oneOffInvoice: vi.fn(async () => ({ invoice: { lago_id: "inv-9", number: "ARC-9", payment_status: "pending" } })),
    checkoutUrl: vi.fn(async () => ({ customer: { checkout_url: "https://pay.example/checkout" } })),
    portalUrl: vi.fn(async () => ({ customer: { portal_url: "https://lago.example/portal" } })),
  };
}
function setup(role: Membership["role"], tables: Record<string, unknown[]>, opts: { rpc?: Record<string, unknown>; lago?: ReturnType<typeof lagoMock> | null; updates?: Record<string, unknown[]> } = {}) {
  const user = fakeDb(tables, opts.rpc ?? {}, opts.updates);
  const svc = fakeDb(tables, opts.rpc ?? {}, opts.updates);
  const lago = opts.lago === undefined ? lagoMock() : opts.lago;
  const deps: ApiDeps = {
    corsOrigins: [], verifyJwt: async () => ({ sub: "u1" }), resolveApiKey: async () => null, resolveMembership: async () => ({ role, brandRestricted: false }),
    userDb: () => user.db, serviceDb: () => svc.db, jobs: (async () => ({ repurpose: vi.fn() })) as never,
    lago: lago as never, lagoWebhookKey: "whsec-test-key", adminToken: "a".repeat(40),
  };
  const app = buildApp(deps);
  const call = (method: string, path: string, payload?: unknown, headers: Record<string, string> = {}) => app.request(/^\/(webhooks|admin)\//.test(path) ? path : `/v1/workspaces/${WS}${path}`, {
    method, body: payload === undefined ? undefined : typeof payload === "string" ? payload : JSON.stringify(payload), headers: { authorization: "Bearer t", "content-type": "application/json", "idempotency-key": "key-0000000001", ...headers },
  });
  return { call, svc, lago };
}
const sub = (o: Record<string, unknown> = {}) => ({ ...ACTIVE_SUBSCRIPTION, plan_key: "growth", lago_subscription_id: "s1", cancelled_at: null, ...o });

describe("plans", () => {
  it("upgrading assigns the plan in Lago now; limits apply at once, credits come with the paid invoice", async () => {
    const { call, svc, lago } = setup("owner", { subscriptions: [sub({ plan_key: "starter" })], plans: [plans.starter, plans.growth], workspaces: [{ id: WS, name: "Annapurna" }], workspace_members: [{ user: { email: "owner@example.test" } }] });
    const res = await call("POST", "/billing/plan", { planKey: "growth" });
    expect(await res.json()).toEqual({ kind: "upgrade", plan: "growth", effective: "now" });
    expect(lago!.upsertCustomer).toHaveBeenCalledWith(expect.objectContaining({ external_id: WS, name: "Annapurna", email: "owner@example.test", currency: "INR" }));
    expect(lago!.assignPlan).toHaveBeenCalledWith({ external_customer_id: WS, external_id: WS, plan_code: "arcatic_growth" });
    expect(svc.ops.find((o) => o.table === "subscriptions" && o.op === "update")!.payload).toMatchObject({ plan_key: "growth", pending_plan_key: null });
  });
  it("a downgrade is refused while the workspace uses more than the smaller plan allows, and scheduled when it fits", async () => {
    const t = { subscriptions: [sub({})], plans: [plans.growth, plans.starter], workspaces: [{ id: WS, name: "A" }] };
    const blocked = setup("owner", t, { rpc: { entitlement_usage: { max_brands: 3, max_seats: 2, max_connected_accounts: 9 } } });
    const res = await blocked.call("POST", "/billing/plan", { planKey: "starter" });
    expect(res.status).toBe(402);
    expect(JSON.stringify((await res.json()).error.details)).toMatch(/max_brands.*Remove 2 first/);
    expect(blocked.lago!.assignPlan).not.toHaveBeenCalled();
    const fits = setup("owner", t, { rpc: { entitlement_usage: { max_brands: 1, max_seats: 2, max_connected_accounts: 3 } } });
    const ok = await fits.call("POST", "/billing/plan", { planKey: "starter" });
    expect(await ok.json()).toEqual({ kind: "downgrade", plan: "starter", effective: "period_end" });
    expect(fits.svc.ops.find((o) => o.table === "subscriptions" && o.op === "update")!.payload).toMatchObject({ pending_plan_key: "starter", pending_change_at: "2026-12-01" });
  });
  it("only owners manage billing; nothing works without Lago configured", async () => {
    expect((await setup("admin", { subscriptions: [sub({})], plans: [plans.growth] }).call("POST", "/billing/plan", { planKey: "growth" })).status).toBe(403);
    expect((await setup("owner", { subscriptions: [sub({ status: "trialing", plan_key: "trial" })], plans: [{ ...plans.starter, key: "trial", price_minor: 0, lago_plan_code: null }, plans.growth], workspaces: [{ id: WS, name: "A" }] }, { lago: null }).call("POST", "/billing/plan", { planKey: "growth" })).status).toBe(409);
  });
  it("cancel ends at period end in Lago; reactivate before then removes the end date", async () => {
    const c1 = setup("owner", { subscriptions: [sub({})], plans: [plans.growth] });
    expect((await c1.call("POST", "/billing/cancel")).status).toBe(200);
    expect(c1.lago!.setEndingAt).toHaveBeenCalledWith(WS, ACTIVE_SUBSCRIPTION.current_period_end);
    const c2 = setup("owner", { subscriptions: [sub({ cancel_at_period_end: true })], plans: [plans.growth] });
    expect(await (await c2.call("POST", "/billing/reactivate")).json()).toEqual({ reactivated: "kept" });
    expect(c2.lago!.setEndingAt).toHaveBeenCalledWith(WS, null);
  });
});

describe("downgrade blockers (direct)", () => {
  it("lists what to remove", async () => {
    const { downgradeBlockers } = await import("@arcatic/core");
    expect(downgradeBlockers({ max_brands: 3 }, plans.starter.limits)[0]!.message).toMatch(/Remove 2 first/);
  });
});

describe("top-ups", () => {
  it("trial workspaces can't buy packs; paid ones get a Lago invoice, credited later by webhook", async () => {
    expect((await setup("owner", { subscriptions: [sub({ status: "trialing", plan_key: "trial" })], plans: [{ ...plans.starter, key: "trial", topups: false }] }).call("POST", "/billing/topups", { packKey: "pack_200" })).status).toBe(402);
    const { call, lago, svc } = setup("owner", {
      subscriptions: [sub({})], plans: [plans.growth], credit_packs: [{ key: "pack_200", name: "200 credits", credits: 200, price_minor: 24900, currency: "INR", lago_add_on_code: "arcatic_credits_200" }],
      credit_topups: [{ id: "t-new", status: "pending", lago_invoice_id: null, idempotency_key: "some-other-request" }], workspaces: [{ id: WS, name: "A" }],
    });
    const res = await call("POST", "/billing/topups", { packKey: "pack_200" });
    expect(res.status).toBe(202);
    expect(lago!.oneOffInvoice).toHaveBeenCalledWith(expect.objectContaining({ add_on_code: "arcatic_credits_200", units: 1, unit_amount_cents: 24900 }));
    expect(svc.ops.find((o) => o.table === "credit_topups" && o.op === "insert")!.payload).toMatchObject({ credits: 200, idempotency_key: "key-0000000001" });
  });
  it("replaying the same request doesn't create a second invoice", async () => {
    const { call, lago } = setup("owner", { subscriptions: [sub({})], plans: [plans.growth], credit_packs: [{ key: "pack_200", credits: 200, price_minor: 24900, currency: "INR", lago_add_on_code: "x" }], credit_topups: [{ id: "t1", status: "pending", lago_invoice_id: "inv-1", idempotency_key: "key-0000000001" }] });
    expect((await call("POST", "/billing/topups", { packKey: "pack_200" })).status).toBe(202);
    expect(lago!.oneOffInvoice).not.toHaveBeenCalled();
  });
});

describe("webhooks and staff tooling", () => {
  const body = JSON.stringify({ webhook_type: "invoice.payment_status_updated", invoice: { lago_id: "inv-1", number: "A-1", invoice_type: "subscription", status: "finalized", payment_status: "succeeded", currency: "INR", fees_amount_cents: 499900, total_amount_cents: 589882, issuing_date: "2026-11-17", file_url: null, customer: { external_id: WS }, fees: [] } });
  const sig = createHmac("sha256", "whsec-test-key").update(body).digest("base64");
  it("rejects unsigned or wrongly signed deliveries", async () => {
    const { call } = setup("owner", {});
    expect((await call("POST", "/webhooks/lago", body, { "x-lago-signature-algorithm": "hmac", "x-lago-signature": "bad" })).status).toBe(401);
    expect((await call("POST", "/webhooks/lago", body, {})).status).toBe(401);
  });
  it("processes a signed delivery once: plan credits granted for a paid subscription invoice", async () => {
    const { call, svc } = setup("owner", { workspaces: [{ id: WS }], subscriptions: [sub({})], plans: [plans.growth], billing_events: [{ id: 1 }], credit_topups: [] }, { rpc: { grant_credits: { id: 7 } } });
    const res = await call("POST", "/webhooks/lago", body, { "x-lago-signature-algorithm": "hmac", "x-lago-signature": sig, "x-lago-unique-key": "evt-1" });
    expect(res.status).toBe(200);
    expect(svc.ops.find((o) => o.table === "grant_credits")!.payload).toMatchObject({ p_amount: 1500, p_kind: "grant", p_reference: "invoice:inv-1" });
    expect(svc.ops.find((o) => o.table === "billing_events" && o.op === "insert")!.payload).toMatchObject({ unique_key: "evt-1" });
  });
  it("admin refunds need the staff token; without it the route doesn't exist", async () => {
    const { call, svc } = setup("owner", {}, { rpc: { refund_credits: { id: 9, kind: "refund" } } });
    const path = `/admin/workspaces/${WS}/credits/refund`;
    expect((await call("POST", path, { reservationId: BRAND, amount: 2, reason: "bad output" })).status).toBe(404);
    expect((await call("POST", path, { reservationId: BRAND, amount: 2, reason: "bad output" }, { authorization: `Bearer ${"a".repeat(40)}` })).status).toBe(201);
    expect(svc.ops.find((o) => o.table === "refund_credits")!.payload).toMatchObject({ p_amount: 2, p_reason: "bad output" });
  });
});

describe("enforcement", () => {
  it("paid work stops when the trial has ended or the plan is cancelled", async () => {
    for (const s of [sub({ status: "trialing", current_period_end: "2020-01-01T00:00:00Z" }), sub({ status: "cancelled" })]) {
      const { call } = setup("editor", { subscriptions: [s], sources: [{ id: BRAND, type: "url", title: "Home", url: null, status: "ready" }], brands: [{ languages: ["en"] }], repurpose_runs: [{ id: "r" }] });
      const res = await call("POST", `/brands/${BRAND}/repurpose`, { sourceId: BRAND, outputs: ["blog"] });
      expect(res.status).toBe(402);
    }
  });
  it("final video renders need a plan with video", async () => {
    const { emptyTimeline, addClip } = await import("@arcatic/core");
    const tl = addClip(emptyTimeline("instagram-reel"), { assetId: "a", kind: "video", inMs: 0, outMs: 10_000, sourceDurationMs: 10_000, hasAudio: false, volume: 1, muted: false, fit: "cover", fadeIn: false });
    const { call } = setup("editor", { subscriptions: [{ ...sub({}), plan: { name: "Starter", limits: { video: false } } }], video_projects: [{ id: "99999999-9999-4999-8999-999999999999", status: "draft", revision: 1, timeline: tl, title: "x" }] });
    const res = await call("POST", `/brands/${BRAND}/video-projects/99999999-9999-4999-8999-999999999999/render`, { mode: "final" });
    expect(res.status).toBe(402);
    expect((await res.json()).error.message).toMatch(/aren't included in the Starter plan/);
  });
});
