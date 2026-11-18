import { createHash, timingSafeEqual } from "node:crypto";
import {
  AppError, billingState, changeKind, downgradeBlockers, fromDbError,
  type PlanRow, type SubscriptionRow,
} from "@arcatic/core";
import { verifyLagoHmac } from "@arcatic/integrations";
import { processLagoWebhook } from "@arcatic/jobs/billing";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { body, check, idempotencyKey, ok, parse } from "../http.js";
import { requirePermission as can } from "../middleware/workspace.js";
import { serviceOps } from "../service-ops.js";
import type { ApiDeps, AppEnv } from "../types.js";

function maybe<T>(res: { data: T; error: { message: string; code?: string } | null }): T | null {
  if (res.error) throw fromDbError(res.error);
  return res.data ?? null;
}

/** Shared by the job starter: paid work needs a plan in good standing. */
export async function assertCanSpend(deps: ApiDeps, workspaceId: string) {
  const sub = maybe(await deps.serviceDb().from("subscriptions").select("plan_key, status, current_period_start, current_period_end, cancel_at_period_end, pending_plan_key, past_due_since").eq("workspace_id", workspaceId).maybeSingle()) as SubscriptionRow | null;
  const s = billingState(sub);
  if (!s.canSpend) throw new AppError("plan_limit", s.reason ?? "Your plan doesn't allow this right now.");
}

/** Feature switches from the workspace's plan (e.g. video). */
export async function assertPlanFeature(deps: ApiDeps, workspaceId: string, feature: "video" | "client_reviewers") {
  const sub = maybe(await deps.serviceDb().from("subscriptions").select("plan:plans!subscriptions_plan_key_fkey(limits, name)").eq("workspace_id", workspaceId).maybeSingle()) as { plan: { limits: Record<string, unknown>; name: string } | null } | null;
  if (!sub?.plan?.limits?.[feature]) throw new AppError("plan_limit", `${feature === "video" ? "Final video renders" : "Client reviewers"} aren't included in the ${sub?.plan?.name ?? "current"} plan. Upgrade in Settings → Billing.`);
}

export const billingRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  const ws = (c: Context<AppEnv>) => c.get("workspaceId");
  const actor = (c: Context<AppEnv>) => { const p = c.get("principal"); return p.kind === "user" ? p.userId : null; };
  const svc = () => deps.serviceDb();
  const lago = () => {
    if (!deps.lago) throw new AppError("conflict", "Paid plans aren't available on this installation yet (billing isn't configured).");
    return deps.lago;
  };
  async function state(c: Context<AppEnv>) {
    const sub = maybe(await svc().from("subscriptions").select("*").eq("workspace_id", ws(c)).maybeSingle()) as (SubscriptionRow & { lago_subscription_id: string | null; cancelled_at: string | null }) | null;
    if (!sub) throw new AppError("not_found", "No subscription for this workspace.");
    const plan = check(await svc().from("plans").select("*").eq("key", sub.plan_key).single()) as PlanRow;
    return { sub, plan };
  }
  /** Lago customer = the workspace (external_id = workspace id), billed to the owner's email. */
  async function ensureCustomer(c: Context<AppEnv>) {
    const w = check(await svc().from("workspaces").select("id, name").eq("id", ws(c)).single()) as { id: string; name: string };
    const owner = maybe(await svc().from("workspace_members").select("user:users!workspace_members_user_id_fkey(email)").eq("workspace_id", ws(c)).eq("role", "owner").limit(1).maybeSingle()) as { user: { email: string } | null } | null;
    await lago().upsertCustomer({ external_id: w.id, name: w.name, email: owner?.user?.email ?? null, currency: "INR", payment_provider: deps.lagoPaymentProvider ?? null, payment_provider_code: deps.lagoPaymentProviderCode ?? null });
  }

  r.get("/billing", can("billing.read"), async (c) => {
    const { sub, plan } = await state(c);
    const [plans, packs, credits, usage, topups, invoices] = await Promise.all([
      svc().from("plans").select("key, name, monthly_credits, price_minor, currency, limits, features, sort").eq("is_public", true).order("sort"),
      svc().from("credit_packs").select("key, name, credits, price_minor, currency").eq("active", true).order("sort"),
      svc().from("credits").select("balance, held").eq("workspace_id", ws(c)).single(),
      svc().rpc("entitlement_usage", { p_workspace: ws(c) }),
      svc().from("credit_topups").select("id, pack_key, credits, amount_minor, currency, status, created_at, paid_at").eq("workspace_id", ws(c)).order("created_at", { ascending: false }).limit(10),
      svc().from("invoices").select("number, status, payment_status, invoice_type, amount_minor, currency, issued_at, pdf_url").eq("workspace_id", ws(c)).order("issued_at", { ascending: false }).limit(24),
    ]);
    const cr = check(credits) as { balance: number; held: number };
    return c.json({
      subscription: { plan_key: sub.plan_key, status: sub.status, current_period_start: sub.current_period_start, current_period_end: sub.current_period_end, cancel_at_period_end: sub.cancel_at_period_end, pending_plan_key: sub.pending_plan_key, past_due_since: sub.past_due_since, cancelled_at: sub.cancelled_at },
      plan, state: billingState(sub), usage: check(usage), plans: check(plans), packs: check(packs),
      credits: { balance: Number(cr.balance), held: Number(cr.held), available: Number(cr.balance) - Number(cr.held) },
      topups: check(topups), invoices: check(invoices), billingConfigured: !!deps.lago,
    });
  });

  /** Credits used per day and by kind of work. */
  r.get("/billing/usage", can("billing.read"), async (c) => {
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), c.req.query());
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const tx = check(await c.get("db").from("credit_transactions").select("delta, kind, reservation_id, created_at").eq("workspace_id", ws(c)).gte("created_at", since).order("created_at").limit(20_000)) as Array<{ delta: number; kind: string; reservation_id: string | null; created_at: string }>;
    const resIds = [...new Set(tx.filter((t) => t.kind === "debit" && t.reservation_id).map((t) => t.reservation_id!))];
    const res = resIds.length ? check(await svc().from("credit_reservations").select("id, reason").in("id", resIds)) as Array<{ id: string; reason: string | null }> : [];
    const reason = new Map(res.map((x) => [x.id, x.reason ?? "other"]));
    const byDay: Record<string, { used: number; added: number }> = {};
    const byKind: Record<string, number> = {};
    for (const t of tx) {
      const d = t.created_at.slice(0, 10);
      const e = (byDay[d] ??= { used: 0, added: 0 });
      if (Number(t.delta) < 0) { e.used += -Number(t.delta); const k = reason.get(t.reservation_id ?? "") ?? t.kind; byKind[k] = (byKind[k] ?? 0) + -Number(t.delta); }
      else e.added += Number(t.delta);
    }
    return c.json({ days, byDay: Object.entries(byDay).map(([date, v]) => ({ date, ...v })), byKind: Object.entries(byKind).map(([kind, used]) => ({ kind, used })).sort((a, b) => b.used - a.used) });
  });

  /** Start a paid plan, upgrade (now, prorated by Lago) or downgrade (at period end). */
  r.post("/billing/plan", can("billing.manage"), async (c) => {
    const i = await body(c, z.object({ planKey: z.string().min(1).max(40) }));
    const { sub, plan: from } = await state(c);
    const to = maybe(await svc().from("plans").select("*").eq("key", i.planKey).eq("is_public", true).maybeSingle()) as PlanRow | null;
    if (!to || !to.lago_plan_code || !to.price_minor) throw new AppError("validation_failed", "Choose one of the paid plans.");
    const kind = changeKind(from, to, sub);
    if (kind === "same") throw new AppError("conflict", "You're already on this plan.");
    if (kind === "downgrade") {
      const usage = check(await svc().rpc("entitlement_usage", { p_workspace: ws(c) })) as Record<string, number>;
      const blockers = downgradeBlockers(usage, to.limits);
      if (blockers.length) throw new AppError("plan_limit", "Remove some items before moving to this plan.", { details: blockers.map((b) => ({ path: b.limit, message: b.message })) });
    }
    await ensureCustomer(c);
    const res = await lago().assignPlan({ external_customer_id: ws(c), external_id: ws(c), plan_code: to.lago_plan_code });
    if (kind === "downgrade") {
      ok(await svc().from("subscriptions").update({ pending_plan_key: to.key, pending_change_at: res.subscription.downgrade_plan_date ?? sub.current_period_end }).eq("workspace_id", ws(c)));
    } else {
      // limits apply now; credits arrive with the paid invoice (webhook)
      ok(await svc().from("subscriptions").update({
        plan_key: to.key, pending_plan_key: null, pending_change_at: null, cancel_at_period_end: false, lago_subscription_id: res.subscription.lago_id ?? sub.lago_subscription_id,
        ...(kind === "start" && { status: "incomplete", cancelled_at: null }),
      }).eq("workspace_id", ws(c)));
    }
    return c.json({ kind, plan: to.key, effective: kind === "downgrade" ? "period_end" : "now" });
  });

  r.post("/billing/cancel", can("billing.manage"), async (c) => {
    const { sub } = await state(c);
    if (sub.status === "cancelled" || sub.status === "trialing") throw new AppError("conflict", "There's no paid plan to cancel.");
    await lago().setEndingAt(ws(c), sub.current_period_end);
    ok(await svc().from("subscriptions").update({ cancel_at_period_end: true }).eq("workspace_id", ws(c)));
    return c.json({ endsAt: sub.current_period_end });
  });

  /** Undo a scheduled cancellation, or start again after one took effect. */
  r.post("/billing/reactivate", can("billing.manage"), async (c) => {
    const { sub, plan } = await state(c);
    if (sub.cancel_at_period_end && sub.status !== "cancelled") {
      await lago().setEndingAt(ws(c), null);
      ok(await svc().from("subscriptions").update({ cancel_at_period_end: false }).eq("workspace_id", ws(c)));
      return c.json({ reactivated: "kept" });
    }
    if (sub.status !== "cancelled") throw new AppError("conflict", "Your plan is already active.");
    if (!plan.lago_plan_code || !plan.price_minor) throw new AppError("validation_failed", "Choose a plan to start again.");
    await ensureCustomer(c);
    const res = await lago().assignPlan({ external_customer_id: ws(c), external_id: ws(c), plan_code: plan.lago_plan_code });
    ok(await svc().from("subscriptions").update({ status: "incomplete", cancelled_at: null, cancel_at_period_end: false, lago_subscription_id: res.subscription.lago_id }).eq("workspace_id", ws(c)));
    return c.json({ reactivated: "new" });
  });

  r.post("/billing/payment-method", can("billing.manage"), async (c) => {
    await ensureCustomer(c);
    const res = await lago().checkoutUrl(ws(c));
    if (!res.customer.checkout_url) throw new AppError("conflict", "The payment provider didn't return a checkout page; try again shortly.");
    return c.json({ url: res.customer.checkout_url });
  });

  r.get("/billing/portal", can("billing.read"), async (c) => {
    await ensureCustomer(c);
    return c.json({ url: (await lago().portalUrl(ws(c))).customer.portal_url });
  });

  /** Buy a credit pack: a one-off Lago invoice; credits arrive when it's paid (webhook). */
  r.post("/billing/topups", can("billing.manage"), async (c) => {
    const key = idempotencyKey(c);
    const i = await body(c, z.object({ packKey: z.string().min(1).max(40) }));
    const { sub, plan } = await state(c);
    if (plan.topups === false || sub.status === "trialing") throw new AppError("plan_limit", "Credit packs are available on paid plans.");
    if (sub.status === "cancelled") throw new AppError("plan_limit", "Reactivate your plan to buy credits.");
    const pack = maybe(await svc().from("credit_packs").select("*").eq("key", i.packKey).eq("active", true).maybeSingle()) as { key: string; name: string; credits: number; price_minor: number; currency: string; lago_add_on_code: string } | null;
    if (!pack) throw new AppError("not_found", "Unknown credit pack.");
    // same request key → same top-up (no double invoice); the row exists before the invoice so the webhook always finds it
    const prior = maybe(await svc().from("credit_topups").select("id, status, lago_invoice_id").eq("workspace_id", ws(c)).eq("idempotency_key", key).maybeSingle()) as { id: string; lago_invoice_id: string | null } | null;
    if (prior?.lago_invoice_id) return c.json(prior, 202);
    const row = prior ?? check(await svc().from("credit_topups").insert({
      workspace_id: ws(c), pack_key: pack.key, credits: pack.credits, amount_minor: pack.price_minor, currency: pack.currency, idempotency_key: key, requested_by: actor(c),
    }).select("id, status, lago_invoice_id").single()) as { id: string };
    await ensureCustomer(c);
    let inv;
    try {
      inv = await lago().oneOffInvoice({ external_customer_id: ws(c), currency: pack.currency, add_on_code: pack.lago_add_on_code, units: 1, unit_amount_cents: pack.price_minor, description: pack.name });
    } catch (e) {
      ok(await svc().from("credit_topups").update({ status: "cancelled" }).eq("id", row.id));
      throw e;
    }
    ok(await svc().from("credit_topups").update({ lago_invoice_id: inv.invoice.lago_id, ...(inv.invoice.payment_status === "failed" && { status: "failed" }) }).eq("id", row.id));
    return c.json({ id: row.id, status: "pending", invoiceNumber: inv.invoice.number, note: "Credits are added as soon as the payment goes through. If you haven't added a payment method yet, pay the invoice from the billing portal." }, 202);
  });

  return r;
};

/** POST /webhooks/lago — signed with the endpoint's HMAC key; each delivery processed once. */
export const webhookRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  r.post("/lago", async (c) => {
    if (!deps.lagoWebhookKey) throw new AppError("not_found", "Route not found.");
    const raw = await c.req.text();
    if (raw.length > 2_000_000) throw new AppError("validation_failed", "Payload too large.");
    if (c.req.header("x-lago-signature-algorithm") !== "hmac" || !verifyLagoHmac(raw, c.req.header("x-lago-signature"), deps.lagoWebhookKey)) {
      throw new AppError("unauthenticated", "Bad signature.");
    }
    let payload: { webhook_type?: string };
    try { payload = JSON.parse(raw); } catch { throw new AppError("validation_failed", "Invalid JSON."); }
    const uniqueKey = c.req.header("x-lago-unique-key") ?? createHash("sha256").update(raw).digest("hex");
    const svc = deps.serviceDb();
    const ins = await svc.from("billing_events").insert({ unique_key: uniqueKey, webhook_type: payload.webhook_type ?? "unknown", payload }).select("id").single();
    if (ins.error?.code === "23505") {
      const prev = maybe(await svc.from("billing_events").select("id, processed_at").eq("provider", "lago").eq("unique_key", uniqueKey).maybeSingle()) as { id: number; processed_at: string | null } | null;
      if (prev?.processed_at) return c.json({ ok: true, duplicate: true });
    } else if (ins.error) throw fromDbError(ins.error);
    const id = (ins.data as { id: number } | null)?.id;
    try {
      const res = await processLagoWebhook(svc, payload as never);
      if (id) ok(await svc.from("billing_events").update({ processed_at: new Date().toISOString(), workspace_id: res.workspaceId, error: res.handled ? null : res.actions.join("; ") }).eq("id", id));
      return c.json({ ok: true, handled: res.handled });
    } catch (e) {
      if (id) await svc.from("billing_events").update({ error: (e as Error).message.slice(0, 500) }).eq("id", id);
      throw e;   // 5xx → Lago retries the delivery
    }
  });
  return r;
};

/** Staff tooling (ADMIN_API_TOKEN): refunds and adjustments land in the same ledger, with a reason. */
export const adminRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  r.use(async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    const want = deps.adminToken ?? "";
    const a = Buffer.from(createHash("sha256").update(token).digest("hex")), b = Buffer.from(createHash("sha256").update(want).digest("hex"));
    if (!want || want.length < 32 || !timingSafeEqual(a, b)) throw new AppError("not_found", "Route not found.");
    await next();
  });
  r.post("/workspaces/:workspaceId/credits/refund", async (c) => {
    const i = await body(c, z.object({ reservationId: z.uuid(), amount: z.number().positive().max(100_000), reason: z.string().trim().min(3).max(500) }));
    const t = check(await deps.serviceDb().rpc("refund_credits", { p_reservation: i.reservationId, p_amount: i.amount, p_reason: i.reason, p_actor: null }));
    return c.json(t, 201);
  });
  r.post("/workspaces/:workspaceId/credits/adjust", async (c) => {
    const i = await body(c, z.object({ amount: z.number().positive().max(1_000_000), reference: z.string().trim().min(3).max(120), reason: z.string().trim().min(3).max(500) }));
    const t = check(await deps.serviceDb().rpc("grant_credits", { p_workspace: c.req.param("workspaceId"), p_amount: i.amount, p_kind: "adjustment", p_reference: `admin:${i.reference}`, p_actor: null }));
    return c.json({ ...t as object, reason: i.reason }, 201);
  });
  /** Service operations snapshot (same as the desk's Operations view). */
  r.get("/service-ops", async (c) => c.json(await serviceOps(deps.serviceDb())));
  /** Service team (Phase 12): add or update a manager / specialist by email. */
  r.put("/service-staff", async (c) => {
    const i = await body(c, z.object({
      email: z.email(), role: z.enum(["manager", "specialist"]), displayName: z.string().trim().min(1).max(120),
      skills: z.array(z.enum(["writing", "design", "video", "ads", "strategy"])).max(5).default([]), active: z.boolean().default(true), maxActive: z.number().int().min(1).max(50).default(5),
    }));
    const u = await deps.serviceDb().from("users").select("id").eq("email", i.email.toLowerCase()).maybeSingle();
    if (u.error) throw new AppError("internal", "Lookup failed.");
    if (!u.data) throw new AppError("not_found", "That person needs to sign up first.");
    const row = check(await deps.serviceDb().from("service_staff").upsert({ user_id: (u.data as { id: string }).id, role: i.role, display_name: i.displayName, skills: i.skills, active: i.active, max_active: i.maxActive }, { onConflict: "user_id" }).select("*").single());
    return c.json(row);
  });
  return r;
};
