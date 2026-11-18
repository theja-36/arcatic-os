/**
 * Human-finished service requests. Mirrors app.guard_service_status() in migration 0017; the
 * database enforces the transitions, this module also says WHO may make each one.
 */
export const SERVICE_STATUSES = ["draft", "submitted", "assigned", "in_progress", "in_review", "delivered", "revision_requested", "approved", "cancelled"] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];
export type ServiceActor = "customer" | "manager" | "specialist" | "system";

const TRANSITIONS: Record<ServiceStatus, readonly ServiceStatus[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["assigned", "cancelled"],
  assigned: ["in_progress", "submitted", "cancelled"],
  in_progress: ["in_review", "delivered", "assigned"],
  in_review: ["delivered", "in_progress"],
  delivered: ["approved", "revision_requested"],
  revision_requested: ["in_progress", "assigned"],
  approved: [],
  cancelled: [],
};
export const canServiceTransition = (from: ServiceStatus, to: ServiceStatus) => TRANSITIONS[from].includes(to);

/** Who may move a request from → to. Specialists act only on requests assigned to them (checked by the API). */
const WHO: Partial<Record<`${ServiceStatus}>${ServiceStatus}`, readonly ServiceActor[]>> = {
  "draft>submitted": ["customer"],
  "draft>cancelled": ["customer"],
  "submitted>cancelled": ["customer", "manager"],
  "assigned>cancelled": ["customer", "manager"],          // before work starts: full release of the hold
  "submitted>assigned": ["manager"],
  "assigned>submitted": ["manager"],                      // unassign
  "in_progress>assigned": ["manager"],                    // reassign
  "revision_requested>assigned": ["manager"],
  "assigned>in_progress": ["specialist"],
  "revision_requested>in_progress": ["specialist"],
  "in_progress>in_review": ["specialist"],
  "in_progress>delivered": ["specialist"],                // offerings without QA only
  "in_review>delivered": ["manager"],
  "in_review>in_progress": ["manager"],                   // QA sends it back
  "delivered>approved": ["customer"],
  "delivered>revision_requested": ["customer"],
};
export function transitionAllowed(from: ServiceStatus, to: ServiceStatus, actor: ServiceActor): boolean {
  return canServiceTransition(from, to) && (WHO[`${from}>${to}`] ?? []).includes(actor);
}

/** Plain-language stage for customers (internal QA is not exposed as a separate step). */
export function customerStage(s: ServiceStatus): string {
  switch (s) {
    case "draft": return "Draft";
    case "submitted": return "Waiting for a specialist";
    case "assigned":
    case "in_progress":
    case "in_review": return "Being worked on";
    case "delivered": return "Ready for your review";
    case "revision_requested": return "Revision in progress";
    case "approved": return "Approved";
    case "cancelled": return "Cancelled";
  }
}

export const OPEN_STATUSES: ReadonlySet<ServiceStatus> = new Set(["submitted", "assigned", "in_progress", "in_review", "revision_requested"]);

const HOUR = 3_600_000;
export const dueAt = (from: Date, turnaroundHours: number) => new Date(from.getTime() + turnaroundHours * HOUR);
/** A revision gets half the original turnaround, at least 24 h and at most 72 h. */
export const revisionDueAt = (from: Date, turnaroundHours: number) => new Date(from.getTime() + Math.min(72, Math.max(24, Math.round(turnaroundHours / 2))) * HOUR);
export const isOverdue = (r: { status: ServiceStatus; due_at: string | null }, now = new Date()) => OPEN_STATUSES.has(r.status) && !!r.due_at && Date.parse(r.due_at) < now.getTime();

/** Credit holds for human work outlive the 2-hour default for AI jobs. */
export const SERVICE_HOLD_TTL_SECONDS = 60 * 24 * 3600;
export interface OfferingPrice { credits: number; included_revisions: number; extra_revision_credits: number }
/** Credits a further revision costs: included ones are free. */
export const revisionCost = (o: OfferingPrice, revisionsUsed: number) => (revisionsUsed < o.included_revisions ? 0 : o.extra_revision_credits);
/** Total charged on approval: the base price plus every paid revision. */
export const totalCharge = (o: OfferingPrice, revisionsUsed: number) => o.credits + Math.max(0, revisionsUsed - o.included_revisions) * o.extra_revision_credits;

/** Suggest specialists: right skill, active, under capacity; least loaded first. */
export function rankSpecialists<T extends { user_id: string; role: string; skills: string[]; active: boolean; max_active: number }>(staff: readonly T[], category: string, load: ReadonlyMap<string, number>): Array<T & { load: number }> {
  return staff
    .filter((s) => s.active && s.role === "specialist" && s.skills.includes(category))
    .map((s) => ({ ...s, load: load.get(s.user_id) ?? 0 }))
    .filter((s) => s.load < s.max_active)
    .sort((a, b) => a.load / a.max_active - b.load / b.max_active || a.load - b.load);
}
