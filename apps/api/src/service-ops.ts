import { fromDbError } from "@arcatic/core";
import type { Db } from "@arcatic/database";

/**
 * Operations snapshot for the service team: workload per specialist, SLA state of every open
 * request, credit holds (amount and earliest expiry) and holds that were lost. Read from the
 * service-role-only `service_ops` view.
 */
export async function serviceOps(db: Db) {
  const rows = await db.from("service_ops").select("*").order("due_at", { ascending: true }).limit(1000);
  if (rows.error) throw fromDbError(rows.error);
  const open = (rows.data ?? []) as Array<{ id: string; assignee_id: string | null; assignee_name: string | null; status: string; sla: string; credits_held: number; hold_expires_at: string | null; holds_lost: number; due_at: string | null; delivered_at: string | null }>;
  const staff = await db.from("service_staff").select("user_id, display_name, role, max_active, active, skills");
  if (staff.error) throw fromDbError(staff.error);
  const counts = (pred: (r: (typeof open)[number]) => boolean) => open.filter(pred).length;
  const workload = ((staff.data ?? []) as Array<{ user_id: string; display_name: string; role: string; max_active: number; active: boolean; skills: string[] }>).map((s) => {
    const mine = open.filter((r) => r.assignee_id === s.user_id && r.status !== "delivered");
    return { ...s, active_requests: mine.length, overdue: mine.filter((r) => r.sla === "overdue").length, utilisation: Math.round((mine.length / s.max_active) * 100) };
  });
  const soon = Date.now() + 7 * 86_400_000;
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      open: counts((r) => r.status !== "delivered"), unassigned: counts((r) => r.status === "submitted"), overdue: counts((r) => r.sla === "overdue"), dueSoon: counts((r) => r.sla === "due_soon"),
      awaitingCustomer: counts((r) => r.status === "delivered"), creditsHeld: open.reduce((t, r) => t + Number(r.credits_held), 0),
      holdsExpiringWithin7Days: counts((r) => !!r.hold_expires_at && Date.parse(r.hold_expires_at) < soon), holdsLost: open.reduce((t, r) => t + Number(r.holds_lost), 0),
    },
    workload, requests: open,
  };
}
