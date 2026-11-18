import { customerNotice, fromDbError, isOverdue, staffNotice, type ServiceStatus } from "@arcatic/core";
import type { Db } from "@arcatic/database";
import { createNotifier, requestCustomers, serviceManagers, type Notifier } from "./notifier.js";

/**
 * Service upkeep, run with billing maintenance (every 15 minutes), BEFORE stale holds expire:
 *  - holds of open or delivered requests that would expire within 7 days are extended 30 days;
 *    a hold that can no longer be extended (already expired / released) is reported to managers
 *    ("hold lost"); approval will try to hold the credits again
 *  - overdue work: one reminder per day to the assignee and the managers
 *  - deliveries waiting on the customer: a reminder after 3 days, then every 3 days
 * Every hold change is a service event (→ audit log). Dedupe keys make repeated runs harmless.
 */
type Req = { id: string; workspace_id: string; brand_id: string; title: string; offering_key: string; status: ServiceStatus; due_at: string | null; delivered_at: string | null; assignee_id: string | null; created_by: string | null; reservation_id: string | null; extra_reservation_ids: string[] };
const DAY = 86_400_000;

export function createServiceActivities(deps: { db: Db; now?: () => Date; notifier?: Notifier; appUrl?: string }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const notifier = deps.notifier ?? createNotifier({ db, appUrl: deps.appUrl });
  const q = async <T>(p: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>): Promise<T> => {
    const r = await p;
    if (r.error) throw fromDbError(r.error as never);
    return r.data as T;
  };
  const event = (r: Req, kind: string, note: string) => db.from("service_events").insert({ request_id: r.id, workspace_id: r.workspace_id, brand_id: r.brand_id, kind, actor_kind: "system", note, visibility: "internal" }).then(() => undefined);

  return {
    async serviceMaintenance(): Promise<{ extended: number; lost: number; overdue: number; reminded: number }> {
      const t = now();
      const reqs = await q<Req[]>(db.from("service_requests").select("id, workspace_id, brand_id, title, offering_key, status, due_at, delivered_at, assignee_id, created_by, reservation_id, extra_reservation_ids")
        .in("status", ["submitted", "assigned", "in_progress", "in_review", "revision_requested", "delivered"]).limit(2000));
      const offerings = new Map((await q<Array<{ key: string; name: string }>>(db.from("service_offerings").select("key, name"))).map((o) => [o.key, o.name]));
      const managers = await serviceManagers(db);
      const name = (r: Req) => offerings.get(r.offering_key) ?? r.offering_key;

      // 1. keep holds alive (or report the ones that are gone)
      let extended = 0, lost = 0;
      const owner = new Map<string, Req>();
      for (const r of reqs) for (const h of [r.reservation_id, ...(r.extra_reservation_ids ?? [])]) if (h) owner.set(h, r);
      if (owner.size) {
        const holds = await q<Array<{ id: string; status: string; expires_at: string }>>(db.from("credit_reservations").select("id, status, expires_at").in("id", [...owner.keys()]));
        for (const h of holds) {
          const r = owner.get(h.id)!;
          if (h.status === "held" && Date.parse(h.expires_at) <= t.getTime() + 7 * DAY) {
            const res = await db.rpc("extend_reservation", { p_reservation: h.id, p_until: new Date(t.getTime() + 30 * DAY).toISOString() });
            if (!res.error) { extended++; await event(r, "hold_extended", "credit hold extended 30 days"); continue; }
          }
          if (h.status === "expired" || h.status === "released") {
            lost++;
            await event(r, "hold_lost", `credit hold ${h.status}`);
            await notifier.send(managers.map((u) => ({ to: { userId: u, audience: "staff" as const }, notice: staffNotice("hold_lost", { requestId: r.id, title: r.title, offeringName: name(r) }, deps.appUrl), dedupeKey: `hold_lost:${h.id}` })));
          }
        }
      }
      // 2. overdue work
      const day = t.toISOString().slice(0, 10);
      let overdue = 0;
      for (const r of reqs.filter((x) => isOverdue(x, t))) {
        overdue++;
        const to = [...new Set([r.assignee_id, ...managers].filter((x): x is string => !!x))];
        await notifier.send(to.map((u) => ({ to: { userId: u, audience: "staff" as const }, notice: staffNotice("overdue", { requestId: r.id, title: r.title, offeringName: name(r), dueAt: r.due_at }, deps.appUrl), dedupeKey: `overdue:${r.id}:${day}` })));
      }
      // 3. deliveries waiting on the customer
      let reminded = 0;
      for (const r of reqs.filter((x) => x.status === "delivered" && x.delivered_at)) {
        const waited = Math.floor((t.getTime() - Date.parse(r.delivered_at!)) / DAY);
        if (waited < 3) continue;
        const notice = customerNotice("awaiting_approval", { requestId: r.id, workspaceId: r.workspace_id, brandId: r.brand_id, title: r.title, offeringName: name(r), daysWaiting: waited }, deps.appUrl);
        await notifier.send((await requestCustomers(db, r)).map((u) => ({ to: { userId: u, audience: "customer" as const, workspaceId: r.workspace_id }, notice, dedupeKey: `awaiting:${r.id}:${Math.floor(waited / 3)}` })));
        reminded++;
      }
      return { extended, lost, overdue, reminded };
    },
  };
}
export type ServiceActivities = ReturnType<typeof createServiceActivities>;
