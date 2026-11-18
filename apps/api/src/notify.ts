import { customerNotice, staffNotice, type CustomerEvent, type CustomerFacts, type StaffEvent, type StaffFacts } from "@arcatic/core";
import { createNotifier, requestCustomers, serviceManagers } from "@arcatic/jobs/notifier";
import type { ApiDeps } from "./types.js";

export { serviceManagers };

/**
 * Service notifications for the API: wording from core (customer notices can only carry
 * customer-safe facts), delivery in-app + Web Push + email (critical events) via the notifier.
 */
export function serviceNotify(deps: ApiDeps) {
  const db = deps.serviceDb();
  const n = createNotifier({ db, push: deps.push ?? null, mailer: deps.mailer ?? null, appUrl: deps.appUrl });
  return {
    async customers(req: { workspace_id?: string; created_by: string | null }, event: CustomerEvent, facts: CustomerFacts, dedupeKey?: string) {
      const users = await requestCustomers(db, req);
      return n.send(users.map((u) => ({ to: { userId: u, audience: "customer" as const, workspaceId: facts.workspaceId }, notice: customerNotice(event, facts, deps.appUrl ?? ""), dedupeKey })));
    },
    async staff(userIds: Array<string | null | undefined>, event: StaffEvent, facts: StaffFacts, dedupeKey?: string) {
      const ids = [...new Set(userIds.filter((x): x is string => !!x))];
      return n.send(ids.map((u) => ({ to: { userId: u, audience: "staff" as const }, notice: staffNotice(event, facts, deps.appUrl ?? ""), dedupeKey })));
    },
    managers: () => serviceManagers(db),
  };
}
