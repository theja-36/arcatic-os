import { amountPhrase } from "./budget.js";

/**
 * Campaign lifecycle. Platform objects are created PAUSED ("launch"); spending starts only with
 * a separate "activate". Critical actions (launch, activate, budget change) need an approval
 * from someone with ads.approve who types the confirmation phrase; any edit cancels approvals
 * granted for the previous revision. Pausing and ending reduce risk and run right away.
 */
export const AD_STATUSES = ["draft", "launching", "paused", "active", "ended", "failed", "archived"] as const;
export type AdStatus = (typeof AD_STATUSES)[number];
export const AD_ACTIONS = ["launch", "activate", "pause", "budget_change", "end"] as const;
export type AdAction = (typeof AD_ACTIONS)[number];

export const CRITICAL_ACTIONS: ReadonlySet<AdAction> = new Set(["launch", "activate", "budget_change"]);

const ALLOWED: Record<AdStatus, readonly AdAction[]> = {
  draft: ["launch"],
  failed: ["launch"],
  launching: [],
  paused: ["activate", "budget_change", "end"],
  active: ["pause", "budget_change", "end"],
  ended: [],
  archived: [],
};
export const allowedActions = (s: AdStatus): readonly AdAction[] => ALLOWED[s];
export const canEditCreative = (s: AdStatus) => s === "draft" || s === "failed";
export const canArchive = (s: AdStatus) => s === "draft" || s === "failed" || s === "ended";

/** Status after an action succeeds on the platform. */
export function statusAfter(action: AdAction, current: AdStatus): AdStatus {
  switch (action) {
    case "launch": return "paused";
    case "activate": return "active";
    case "pause": return "paused";
    case "end": return "ended";
    case "budget_change": return current;
  }
}

export function confirmPhrase(action: AdAction, campaign: { name: string }, payload: { dailyBudgetMinor?: number } = {}): string | null {
  if (action === "launch" || action === "activate") return campaign.name.trim();
  if (action === "budget_change" && payload.dailyBudgetMinor) return amountPhrase(payload.dailyBudgetMinor);
  return null;
}

export function actionSummary(action: AdAction, c: { name: string; platform: string; dailyBudgetMinor?: number | null; currency?: string }, payload: { dailyBudgetMinor?: number } = {}): string {
  const money = (m?: number | null) => (m ? `${c.currency === "INR" || !c.currency ? "₹" : `${c.currency} `}${amountPhrase(m)}/day` : "no budget");
  const where = c.platform === "google" ? "Google Ads" : "Meta";
  switch (action) {
    case "launch": return `Create "${c.name}" in ${where}, PAUSED, with a daily budget of ${money(c.dailyBudgetMinor)}. Nothing spends until it is activated.`;
    case "activate": return `Turn on "${c.name}" in ${where}. It starts spending up to ${money(c.dailyBudgetMinor)}.`;
    case "pause": return `Pause "${c.name}" in ${where}.`;
    case "end": return `End "${c.name}" in ${where} (paused permanently in Arcatic).`;
    case "budget_change": return `Change the daily budget of "${c.name}" from ${money(c.dailyBudgetMinor)} to ${money(payload.dailyBudgetMinor)}.`;
  }
}
