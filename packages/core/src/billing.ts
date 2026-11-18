import type { CountedLimit, PlanLimits } from "./entitlements.js";

/**
 * Commercial rules (docs/18). Lago bills; Arcatic decides what a workspace may do and how many
 * credits a paid invoice is worth.
 */
export interface PlanRow {
  key: string;
  name: string;
  monthly_credits: number;
  price_minor: number | null;
  currency: string;
  limits: PlanLimits;
  lago_plan_code: string | null;
  features?: Record<string, unknown>;
  topups?: boolean;
  sort?: number;
}

export interface SubscriptionRow {
  plan_key: string;
  status: "trialing" | "incomplete" | "active" | "past_due" | "cancelled" | "paused";
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  pending_plan_key: string | null;
  past_due_since: string | null;
}

export const PAST_DUE_GRACE_DAYS = 7;

export type ChangeKind = "start" | "upgrade" | "downgrade" | "same";

/** Moving from one plan to another. Trial / cancelled → paid is a start. */
export function changeKind(from: PlanRow | null, to: PlanRow, sub: Pick<SubscriptionRow, "status"> | null): ChangeKind {
  if (!from || !sub || sub.status === "cancelled" || sub.status === "trialing" || !from.price_minor) return "start";
  if (from.key === to.key) return "same";
  return (to.price_minor ?? 0) >= (from.price_minor ?? 0) ? "upgrade" : "downgrade";
}

export interface Blocker { limit: CountedLimit; used: number; max: number; message: string }
const NOUN: Record<CountedLimit, string> = { max_brands: "brands", max_seats: "seats (members + pending invites)", max_connected_accounts: "switched-on connected accounts" };

/** What has to be removed before moving to a plan with smaller counted limits. */
export function downgradeBlockers(usage: Partial<Record<CountedLimit, number>>, target: PlanLimits): Blocker[] {
  const out: Blocker[] = [];
  for (const k of ["max_brands", "max_seats", "max_connected_accounts"] as const) {
    const max = target[k];
    const used = usage[k] ?? 0;
    if (max !== undefined && used > max) out.push({ limit: k, used, max, message: `You use ${used} ${NOUN[k]}; this plan allows ${max}. Remove ${used - max} first.` });
  }
  return out;
}

/**
 * Credits a paid subscription invoice is worth: the plan's monthly credits in proportion to the
 * plan fee billed (so Lago's prorated upgrade invoices grant prorated credits). Taxes don't count.
 */
export function creditsForInvoice(plan: Pick<PlanRow, "monthly_credits" | "price_minor">, feesAmountCents: number): number {
  if (!plan.price_minor || plan.price_minor <= 0 || feesAmountCents <= 0) return 0;
  return Math.floor(plan.monthly_credits * Math.min(1, feesAmountCents / plan.price_minor));
}

export interface BillingState {
  canSpend: boolean;
  reason?: string;
  warning?: string;
}

/** Whether paid work (anything that reserves credits) may start. Reading and editing always work. */
export function billingState(sub: SubscriptionRow | null, now = new Date()): BillingState {
  if (!sub) return { canSpend: false, reason: "This workspace has no plan. Choose one in Settings → Billing." };
  const end = Date.parse(sub.current_period_end);
  switch (sub.status) {
    case "active":
      return sub.cancel_at_period_end ? { canSpend: true, warning: `Your plan ends on ${new Date(end).toDateString()}.` } : { canSpend: true };
    case "trialing":
    case "incomplete":
      return now.getTime() <= end ? { canSpend: true, ...(sub.status === "incomplete" && { warning: "Waiting for your first payment." }) }
        : { canSpend: false, reason: "Your trial has ended. Choose a plan in Settings → Billing to keep creating." };
    case "past_due": {
      const since = sub.past_due_since ? Date.parse(sub.past_due_since) : now.getTime();
      const graceEnds = since + PAST_DUE_GRACE_DAYS * 86_400_000;
      return now.getTime() <= graceEnds
        ? { canSpend: true, warning: `A payment failed. Update your payment method by ${new Date(graceEnds).toDateString()} to avoid interruption.` }
        : { canSpend: false, reason: "A payment is overdue. Update your payment method in Settings → Billing to continue." };
    }
    case "cancelled":
      return { canSpend: false, reason: "Your plan was cancelled. Reactivate it in Settings → Billing." };
    case "paused":
    default:
      return { canSpend: false, reason: "Billing is paused for this workspace." };
  }
}
