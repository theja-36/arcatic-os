import type { AdIssue } from "./google.js";

export interface BudgetPolicy { manageEnabled: boolean; maxDailyBudgetMinor: number; monthlySpendCapMinor?: number | null; autoPauseOnCap?: boolean }

/**
 * Google: a campaign can spend up to 2× its average daily budget on a given day but is never
 * charged more than 30.4× it in a month. Meta also lets daily spend vary. We plan with 30.4.
 */
export const MONTH_FACTOR = 30.4;
export const projectedMonthlyMinor = (dailyMinor: number) => Math.round(dailyMinor * MONTH_FACTOR);
export const formatMinor = (minor: number, currency = "INR") => `${currency === "INR" ? "₹" : `${currency} `}${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Amount a person must type to confirm a budget change: major units with two decimals. */
export const amountPhrase = (minor: number) => (minor / 100).toFixed(2);

export function checkBudget(dailyMinor: number | null, policy: BudgetPolicy | null): AdIssue[] {
  const out: AdIssue[] = [];
  if (!dailyMinor || dailyMinor <= 0) return [{ code: "budget_missing", severity: "error", field: "dailyBudgetMinor", message: "Set a daily budget." }];
  if (!policy?.manageEnabled) out.push({ code: "manage_disabled", severity: "error", field: "connectionId", message: "An owner must switch on campaign management for this ad account first." });
  if (policy && dailyMinor > policy.maxDailyBudgetMinor) out.push({ code: "budget_over_limit", severity: "error", field: "dailyBudgetMinor", message: `Daily budget is above this ad account's limit (${formatMinor(policy.maxDailyBudgetMinor)}).` });
  if (policy?.monthlySpendCapMinor && projectedMonthlyMinor(dailyMinor) > policy.monthlySpendCapMinor) out.push({ code: "budget_over_cap", severity: "warning", field: "dailyBudgetMinor", message: `At this budget a full month could spend ${formatMinor(projectedMonthlyMinor(dailyMinor))}, above the monthly cap of ${formatMinor(policy.monthlySpendCapMinor)}${policy.autoPauseOnCap ? "; campaigns will be paused at the cap" : ""}.` });
  return out;
}

export type SpendLevel = "ok" | "near" | "over";
export function spendLevel(spentMinor: number, capMinor: number | null | undefined): SpendLevel {
  if (!capMinor) return "ok";
  return spentMinor >= capMinor ? "over" : spentMinor >= capMinor * 0.8 ? "near" : "ok";
}

/** Which active campaigns the spend guard pauses: all active ones on an account over its cap (if auto-pause is on). */
export function campaignsToPause(spentMinor: number, policy: BudgetPolicy | null, active: ReadonlyArray<{ id: string }>): string[] {
  if (!policy?.autoPauseOnCap || spendLevel(spentMinor, policy.monthlySpendCapMinor) !== "over") return [];
  return active.map((c) => c.id);
}
