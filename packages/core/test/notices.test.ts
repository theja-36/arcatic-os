import { describe, expect, it } from "vitest";
import { EMAIL_EVENTS, customerNotice, staffNotice, type CustomerEvent, type CustomerFacts, type StaffEvent } from "../src/index.js";

const SECRETS = { internal: "INTERNAL: client is difficult", qa: "QA-NOTE: tone is off", hold: "res_7f3a9", specialist: "Priya Specialist" };
const base: CustomerFacts = { requestId: "r1", workspaceId: "w1", brandId: "b1", title: "Tiffin guide", offeringName: "Expert article", dueAt: "2026-11-20T10:00:00Z", creditsHeld: 120, creditsCharged: 140, creditsReleased: 120, customerNote: "Here is your article.", staffMessage: "Quick question on tone?", daysWaiting: 4 };
const CUSTOMER: CustomerEvent[] = ["received", "assigned", "delivered", "approved", "cancelled", "message", "awaiting_approval"];
const STAFF: StaffEvent[] = ["new_request", "assigned", "qa_ready", "qa_returned", "revision_requested", "approved", "cancelled", "customer_message", "overdue", "hold_lost"];

describe("service notices", () => {
  it("customer notices can't carry internal notes, QA details, hold ids or staff names", () => {
    // smuggle secrets in as extra properties: the builder only reads customer-safe fields
    const smuggled = { ...base, internalNote: SECRETS.internal, qaNote: SECRETS.qa, reservationId: SECRETS.hold, specialistName: SECRETS.specialist } as unknown as CustomerFacts;
    for (const e of CUSTOMER) {
      const n = customerNotice(e, smuggled, "https://app.example.test");
      const all = JSON.stringify(n);
      for (const s of Object.values(SECRETS)) expect(all, `${e} leaked ${s}`).not.toContain(s);
      expect(n.link).toBe("/w/w1/b/b1/services/r1");
      expect(n.kind).toBe(`customer.${e}`);
    }
  });
  it("tapping a push goes to the mobile hub for customers and to the desk for staff", () => {
    for (const e of CUSTOMER) expect(customerNotice(e, base).pushLink, e).toBe("/m/w1?tab=inbox&service=r1&brand=b1");
    for (const e of STAFF) expect(staffNotice(e, { requestId: "r1", title: "t", offeringName: "o" }).pushLink, e).toBe("/desk/r1");
    expect(customerNotice("delivered", base).link).toBe("/w/w1/b/b1/services/r1");   // the in-app link is unchanged
  });
  it("says what customers need: holds, charges, releases", () => {
    expect(customerNotice("received", base).body).toMatch(/120 credits on hold; you're charged only when you approve/);
    expect(customerNotice("approved", base).body).toMatch(/140 credits charged/);
    expect(customerNotice("cancelled", base).body).toMatch(/120 credits released/);
    expect(customerNotice("cancelled", { ...base, creditsReleased: 0 }).body).toBe("Nothing was charged.");
    expect(customerNotice("delivered", base).body).toBe("Here is your article.");
  });
  it("critical events also go out by email with an absolute link; chatty ones don't", () => {
    const d = customerNotice("delivered", base, "https://app.example.test");
    expect(d.email?.text).toContain("https://app.example.test/w/w1/b/b1/services/r1");
    expect(customerNotice("message", base).email).toBeNull();
    expect(staffNotice("qa_ready", { requestId: "r1", title: "t", offeringName: "o" }).email).toBeNull();
    for (const k of EMAIL_EVENTS) expect(k).toMatch(/^(customer|staff)\./);
  });
  it("staff notices link to the desk and may carry customer text", () => {
    for (const e of STAFF) expect(staffNotice(e, { requestId: "r1", title: "t", offeringName: "o" }).link).toBe("/desk/r1");
    expect(staffNotice("revision_requested", { requestId: "r1", title: "t", offeringName: "o", customerText: "Shorter please" }).body).toBe("Shorter please");
    expect(staffNotice("qa_returned", { requestId: "r1", title: "t", offeringName: "o", qaNote: SECRETS.qa }).body).toBe(SECRETS.qa);
  });
});
