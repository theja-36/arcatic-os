import { creditsForInvoice, fromDbError, type PlanRow } from "@arcatic/core";
import type { Db } from "@arcatic/database";
import type { LagoClient, LagoInvoice, LagoSubscription } from "@arcatic/integrations";

/**
 * Lago webhooks → Arcatic state. Idempotent: credits use (kind, reference) uniqueness, invoices
 * upsert on lago_invoice_id, and the API stores each delivery once (billing_events).
 * Arcatic is the system of record for credits; Lago for money.
 */
export interface WebhookResult { handled: boolean; workspaceId: string | null; actions: string[] }

const one = async <T>(q: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>): Promise<T> => {
  const r = await q;
  if (r.error) throw fromDbError(r.error as never);
  return r.data as T;
};

async function workspaceExists(db: Db, id: string | undefined | null) {
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await db.from("workspaces").select("id").eq("id", id).maybeSingle();
  if (r.error) throw fromDbError(r.error);
  return (r.data as { id: string } | null)?.id ?? null;
}
async function planByCode(db: Db, code: string | null | undefined): Promise<PlanRow | null> {
  if (!code) return null;
  return one<PlanRow | null>(db.from("plans").select("*").eq("lago_plan_code", code).maybeSingle());
}

function invoiceStatus(i: LagoInvoice) {
  if (i.payment_status === "succeeded") return "paid";
  if (i.status === "deleted") return "voided";
  if (i.payment_status === "failed" && i.status === "finalized") return "failed";
  return ["draft", "finalized", "pending", "voided", "failed"].includes(i.status) ? i.status : "pending";
}

export async function processLagoWebhook(db: Db, payload: { webhook_type: string; invoice?: LagoInvoice; subscription?: LagoSubscription }): Promise<WebhookResult> {
  const actions: string[] = [];
  const type = payload.webhook_type;

  if (payload.invoice && type.startsWith("invoice.")) {
    const inv = payload.invoice;
    const ws = await workspaceExists(db, inv.customer?.external_id);
    if (!ws) return { handled: false, workspaceId: null, actions: ["unknown customer"] };
    await one(db.from("invoices").upsert({
      workspace_id: ws, lago_invoice_id: inv.lago_id, number: inv.number, status: type === "invoice.voided" ? "voided" : invoiceStatus(inv), payment_status: inv.payment_status,
      invoice_type: inv.invoice_type, amount_minor: inv.total_amount_cents, total_paid_minor: inv.total_paid_amount_cents ?? null, currency: inv.currency, issued_at: inv.issuing_date, pdf_url: inv.file_url,
    }, { onConflict: "lago_invoice_id" }));
    actions.push("invoice saved");

    const topup = await one<{ id: string; credits: number; status: string } | null>(db.from("credit_topups").select("id, credits, status").eq("lago_invoice_id", inv.lago_id).maybeSingle());
    if (inv.payment_status === "succeeded") {
      if (topup && topup.status !== "paid") {
        const t = await one<{ id: number }>(db.rpc("grant_credits", { p_workspace: ws, p_amount: topup.credits, p_kind: "topup", p_reference: `topup:${inv.lago_id}`, p_actor: null }));
        await one(db.from("credit_topups").update({ status: "paid", paid_at: new Date().toISOString(), credit_transaction_id: t.id }).eq("id", topup.id));
        actions.push(`top-up credited ${topup.credits}`);
      } else if (inv.invoice_type === "subscription") {
        const sub = await one<{ plan_key: string } | null>(db.from("subscriptions").select("plan_key").eq("workspace_id", ws).maybeSingle());
        const plan = sub ? await one<PlanRow | null>(db.from("plans").select("*").eq("key", sub.plan_key).maybeSingle()) : null;
        const credits = plan ? creditsForInvoice(plan, inv.fees_amount_cents) : 0;
        if (credits > 0) {
          await one(db.rpc("grant_credits", { p_workspace: ws, p_amount: credits, p_kind: "grant", p_reference: `invoice:${inv.lago_id}`, p_actor: null }));
          actions.push(`plan credits granted ${credits}`);
        }
        const ends = (inv.fees ?? []).map((f) => f.to_date).filter((d): d is string => !!d).sort().at(-1);
        const starts = (inv.fees ?? []).map((f) => f.from_date).filter((d): d is string => !!d).sort()[0];
        await one(db.from("subscriptions").update({ status: "active", past_due_since: null, ...(starts && { current_period_start: starts }), ...(ends && { current_period_end: ends }) }).eq("workspace_id", ws).neq("status", "cancelled"));
      }
    } else if (inv.payment_status === "failed" || type === "invoice.payment_overdue" || type === "invoice.payment_failure") {
      if (topup) {
        await one(db.from("credit_topups").update({ status: "failed" }).eq("id", topup.id).eq("status", "pending"));
        actions.push("top-up failed");
      } else if (inv.invoice_type === "subscription") {
        const cur = await one<{ past_due_since: string | null; status: string } | null>(db.from("subscriptions").select("past_due_since, status").eq("workspace_id", ws).maybeSingle());
        if (cur && cur.status !== "cancelled") {
          await one(db.from("subscriptions").update({ status: "past_due", past_due_since: cur.past_due_since ?? new Date().toISOString() }).eq("workspace_id", ws));
          actions.push("subscription past due");
        }
      }
    }
    return { handled: true, workspaceId: ws, actions };
  }

  if (payload.subscription && type.startsWith("subscription.")) {
    const s = payload.subscription;
    const ws = await workspaceExists(db, s.external_customer_id);
    if (!ws) return { handled: false, workspaceId: null, actions: ["unknown customer"] };
    if (type === "subscription.terminated" || type === "subscription.canceled") {
      // a terminated plan replaced by a downgrade is followed by subscription.started for the new plan
      if (!s.next_plan_code) {
        await one(db.from("subscriptions").update({ status: "cancelled", cancelled_at: s.terminated_at ?? new Date().toISOString(), lago_status: s.status, cancel_at_period_end: false }).eq("workspace_id", ws));
        actions.push("subscription cancelled");
      }
      return { handled: true, workspaceId: ws, actions };
    }
    const plan = await planByCode(db, s.plan_code);
    if (!plan) return { handled: false, workspaceId: ws, actions: [`unknown plan ${s.plan_code}`] };
    const next = await planByCode(db, s.next_plan_code);
    await one(db.from("subscriptions").update({
      plan_key: plan.key, lago_subscription_id: s.lago_id, lago_status: s.status,
      ...(s.status === "active" && { status: "active" }), ...(s.status === "incomplete" && { status: "incomplete" }),
      pending_plan_key: next?.key ?? null, pending_change_at: next ? s.downgrade_plan_date ?? s.current_billing_period_ending_at ?? null : null,
      cancel_at_period_end: !!s.ending_at,
      ...(s.current_billing_period_started_at && { current_period_start: s.current_billing_period_started_at }),
      ...(s.current_billing_period_ending_at && { current_period_end: s.current_billing_period_ending_at }),
    }).eq("workspace_id", ws));
    actions.push(`plan ${plan.key}${next ? ` → ${next.key} later` : ""}`);
    return { handled: true, workspaceId: ws, actions };
  }
  return { handled: false, workspaceId: null, actions: ["ignored"] };
}

/** Credits consumed → Lago usage events (billable metric `arcatic_credits`, sum of `credits`). */
export const USAGE_METRIC_CODE = "arcatic_credits";

export async function syncUsageToLago(db: Db, lago: LagoClient, limit = 1000): Promise<{ sent: number }> {
  const subs = await one<Array<{ workspace_id: string }>>(db.from("subscriptions").select("workspace_id").not("lago_subscription_id", "is", null));
  if (!subs.length) return { sent: 0 };
  const rows = await one<Array<{ id: number; workspace_id: string; quantity: number; transaction_id: string; created_at: string; job_id: string | null }>>(
    db.from("usage_events").select("id, workspace_id, quantity, transaction_id, created_at, job_id").is("lago_synced_at", null).eq("metric", "credits")
      .in("workspace_id", subs.map((s) => s.workspace_id)).order("id").limit(limit));
  let sent = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    await lago.sendEvents(batch.map((r) => ({
      transaction_id: r.transaction_id, external_subscription_id: r.workspace_id, code: USAGE_METRIC_CODE,
      timestamp: Math.floor(Date.parse(r.created_at) / 1000), properties: { credits: Number(r.quantity), ...(r.job_id && { job_id: r.job_id }) },
    })));
    await one(db.from("usage_events").update({ lago_synced_at: new Date().toISOString() }).in("id", batch.map((r) => r.id)));
    sent += batch.length;
  }
  return { sent };
}

/** Top-ups whose paid invoice arrived before the invoice id was saved: credit them from the invoice mirror. */
export async function reconcileTopups(db: Db): Promise<number> {
  const pending = await one<Array<{ id: string; workspace_id: string; credits: number; lago_invoice_id: string }>>(db.from("credit_topups").select("id, workspace_id, credits, lago_invoice_id").eq("status", "pending").not("lago_invoice_id", "is", null).limit(200));
  if (!pending.length) return 0;
  const paid = await one<Array<{ lago_invoice_id: string }>>(db.from("invoices").select("lago_invoice_id").eq("status", "paid").in("lago_invoice_id", pending.map((p) => p.lago_invoice_id)));
  const ids = new Set(paid.map((p) => p.lago_invoice_id));
  let n = 0;
  for (const t of pending.filter((p) => ids.has(p.lago_invoice_id))) {
    const tx = await one<{ id: number }>(db.rpc("grant_credits", { p_workspace: t.workspace_id, p_amount: t.credits, p_kind: "topup", p_reference: `topup:${t.lago_invoice_id}`, p_actor: null }));
    await one(db.from("credit_topups").update({ status: "paid", paid_at: new Date().toISOString(), credit_transaction_id: tx.id }).eq("id", t.id));
    n++;
  }
  return n;
}

export function createBillingActivities(deps: { db: Db; lago: LagoClient | null }) {
  return {
    async reconcileTopups(): Promise<number> {
      return reconcileTopups(deps.db);
    },
    async syncUsage(): Promise<{ sent: number }> {
      return deps.lago ? syncUsageToLago(deps.db, deps.lago) : { sent: 0 };
    },
    async expireReservations(): Promise<number> {
      return one<number>(deps.db.rpc("expire_stale_reservations", {}));
    },
  };
}
export type BillingActivities = ReturnType<typeof createBillingActivities>;
