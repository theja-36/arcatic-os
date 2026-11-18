import { describe, expect, it } from "vitest";
import { billingState, changeKind, creditsForInvoice, downgradeBlockers, type PlanRow, type SubscriptionRow } from "../src/index.js";

const plan = (key: string, price: number | null, credits: number, limits = {}): PlanRow => ({ key, name: key, monthly_credits: credits, price_minor: price, currency: "INR", limits, lago_plan_code: `arcatic_${key}` });
const trial = plan("trial", 0, 100), starter = plan("starter", 149900, 300), growth = plan("growth", 499900, 1500, { max_brands: 3, max_seats: 5, max_connected_accounts: 15 });
const sub = (o: Partial<SubscriptionRow>): SubscriptionRow => ({ plan_key: "starter", status: "active", current_period_start: "2026-11-01T00:00:00Z", current_period_end: "2026-12-01T00:00:00Z", cancel_at_period_end: false, pending_plan_key: null, past_due_since: null, ...o });

describe("billing rules", () => {
  it("classifies plan changes", () => {
    expect(changeKind(trial, starter, sub({ status: "trialing" }))).toBe("start");
    expect(changeKind(starter, growth, sub({}))).toBe("upgrade");
    expect(changeKind(growth, starter, sub({}))).toBe("downgrade");
    expect(changeKind(growth, starter, sub({ status: "cancelled" }))).toBe("start");
    expect(changeKind(starter, starter, sub({}))).toBe("same");
  });
  it("lists what blocks a downgrade", () => {
    const b = downgradeBlockers({ max_brands: 3, max_seats: 2, max_connected_accounts: 9 }, { max_brands: 1, max_seats: 2, max_connected_accounts: 5 });
    expect(b.map((x) => [x.limit, x.used - x.max])).toEqual([["max_brands", 2], ["max_connected_accounts", 4]]);
    expect(downgradeBlockers({ max_brands: 1 }, {})).toEqual([]);
  });
  it("grants credits in proportion to the plan fee billed (prorated upgrades), never more than a month", () => {
    expect(creditsForInvoice(growth, 499900)).toBe(1500);
    expect(creditsForInvoice(growth, 249950)).toBe(750);
    expect(creditsForInvoice(growth, 999999)).toBe(1500);
    expect(creditsForInvoice(trial, 100)).toBe(0);
  });
  it("decides when paid work may start", () => {
    const now = new Date("2026-11-20T00:00:00Z");
    expect(billingState(sub({}), now).canSpend).toBe(true);
    expect(billingState(sub({ status: "trialing", current_period_end: "2026-11-10T00:00:00Z" }), now)).toMatchObject({ canSpend: false, reason: expect.stringMatching(/trial has ended/) });
    expect(billingState(sub({ status: "past_due", past_due_since: "2026-11-18T00:00:00Z" }), now)).toMatchObject({ canSpend: true, warning: expect.stringMatching(/payment failed/) });
    expect(billingState(sub({ status: "past_due", past_due_since: "2026-11-01T00:00:00Z" }), now).canSpend).toBe(false);
    expect(billingState(sub({ status: "cancelled" }), now).canSpend).toBe(false);
    expect(billingState(sub({ cancel_at_period_end: true }), now)).toMatchObject({ canSpend: true, warning: expect.stringMatching(/ends on/) });
    expect(billingState(null, now).canSpend).toBe(false);
  });
});
