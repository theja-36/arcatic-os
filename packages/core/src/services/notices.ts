/**
 * Every service notification's wording, for in-app, push and email alike.
 *
 * Leak-proof by construction: customer notices are built from `CustomerFacts` only — title,
 * offering, dates, credit totals and the specialist's note *to the customer*. Internal notes,
 * QA comments, hold ids and staff identities are not fields of that type, so they cannot reach
 * a customer even by mistake. Staff notices may include customer text (that is what staff need).
 */
export interface CustomerFacts {
  requestId: string; workspaceId: string; brandId: string;
  title: string; offeringName: string;
  dueAt?: string | null;
  creditsHeld?: number; creditsCharged?: number; creditsReleased?: number;
  customerNote?: string | null;       // the specialist's note written for the customer
  staffMessage?: string | null;       // a message the team posted with visibility "all"
  daysWaiting?: number;
}
export interface StaffFacts { requestId: string; title: string; offeringName: string; brandName?: string | null; dueAt?: string | null; customerText?: string | null; qaNote?: string | null; rating?: number | null; specialistName?: string | null }

export type CustomerEvent = "received" | "assigned" | "delivered" | "approved" | "cancelled" | "message" | "awaiting_approval";
export type StaffEvent = "new_request" | "assigned" | "qa_ready" | "qa_returned" | "revision_requested" | "approved" | "cancelled" | "customer_message" | "overdue" | "hold_lost";

export interface NoticeContent { kind: string; title: string; body: string; link: string; email: { subject: string; text: string } | null }

const when = (iso?: string | null) => (iso ? new Date(iso).toUTCString().replace(/:\d\d GMT$/, " UTC") : "");
const clip = (s: string | null | undefined, n = 280) => (s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : "");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Events that also go out by email (the rest stay in-app / push only). */
export const EMAIL_EVENTS: ReadonlySet<string> = new Set([
  "customer.received", "customer.delivered", "customer.approved", "customer.cancelled", "customer.awaiting_approval",
  "staff.new_request", "staff.assigned", "staff.revision_requested", "staff.approved", "staff.cancelled", "staff.overdue", "staff.hold_lost",
]);

export function customerNotice(event: CustomerEvent, f: CustomerFacts, appUrl = ""): NoticeContent {
  const link = `/w/${f.workspaceId}/b/${f.brandId}/services/${f.requestId}`;
  let title: string, body: string;
  switch (event) {
    case "received":
      title = `We've got your request: ${f.title}`;
      body = `${f.offeringName}${f.dueAt ? ` · due ${when(f.dueAt)}` : ""}. ${f.creditsHeld != null ? `${plural(f.creditsHeld, "credit")} on hold; ` : ""}you're charged only when you approve the delivery.`;
      break;
    case "assigned": title = `A specialist is working on: ${f.title}`; body = f.dueAt ? `Expected by ${when(f.dueAt)}.` : "We'll let you know when it's ready."; break;
    case "delivered": title = `Ready for your review: ${f.title}`; body = clip(f.customerNote) || "Approve it, or ask for a revision."; break;
    case "approved": title = `Approved: ${f.title}`; body = `${f.creditsCharged != null ? `${plural(f.creditsCharged, "credit")} charged. ` : ""}It's in your library now.`; break;
    case "cancelled": title = `Cancelled: ${f.title}`; body = f.creditsReleased ? `${plural(f.creditsReleased, "credit")} released back to your wallet.` : "Nothing was charged."; break;
    case "message": title = `Message about: ${f.title}`; body = clip(f.staffMessage); break;
    case "awaiting_approval": title = `Waiting for your review: ${f.title}`; body = `Delivered ${plural(f.daysWaiting ?? 0, "day")} ago. Approve it or ask for a revision.`; break;
  }
  const kind = `customer.${event}`;
  return { kind, title, body, link, email: EMAIL_EVENTS.has(kind) ? { subject: title, text: `${body}\n\nOpen it: ${appUrl}${link}\n\n— Arcatic` } : null };
}

export function staffNotice(event: StaffEvent, f: StaffFacts, appUrl = ""): NoticeContent {
  const link = `/desk/${f.requestId}`;
  const due = f.dueAt ? ` · due ${when(f.dueAt)}` : "";
  let title: string, body: string;
  switch (event) {
    case "new_request": title = `New request: ${f.title}`; body = `${f.offeringName}${f.brandName ? ` for ${f.brandName}` : ""}${due}`; break;
    case "assigned": title = `Assigned to you: ${f.title}`; body = `${f.offeringName}${due}`; break;
    case "qa_ready": title = `Ready for QA: ${f.title}`; body = `${f.specialistName ? `${f.specialistName} handed it in. ` : ""}${f.offeringName}`; break;
    case "qa_returned": title = `QA returned: ${f.title}`; body = clip(f.qaNote); break;
    case "revision_requested": title = `Revision requested: ${f.title}`; body = clip(f.customerText) || "See the request."; break;
    case "approved": title = `Approved by the customer: ${f.title}`; body = `${f.rating ? `Rated ${f.rating}/5. ` : ""}${clip(f.customerText, 200)}`.trim(); break;
    case "cancelled": title = `Cancelled by the customer: ${f.title}`; body = "Stop work on this request."; break;
    case "customer_message": title = `Customer message: ${f.title}`; body = clip(f.customerText); break;
    case "overdue": title = `Overdue: ${f.title}`; body = `Was due ${when(f.dueAt)}.`; break;
    case "hold_lost": title = `Credit hold lost: ${f.title}`; body = "The customer's credit hold could not be kept; approval will try to hold the credits again."; break;
  }
  const kind = `staff.${event}`;
  return { kind, title, body, link, email: EMAIL_EVENTS.has(kind) ? { subject: title, text: `${body}\n\nOpen it: ${appUrl}${link}\n\n— Arcatic service desk` } : null };
}
