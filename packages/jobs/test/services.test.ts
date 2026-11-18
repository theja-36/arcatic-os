import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceActivities } from "../src/service-activities.js";
import { memDb } from "./mem-db.js";

const NOW = new Date("2026-11-18T12:00:00Z");
const req = (over: Record<string, unknown>) => ({ id: "r1", workspace_id: "w1", brand_id: "b1", title: "Tiffin guide", status: "in_progress", due_at: "2026-11-20T00:00:00Z", delivered_at: null, assignee_id: "spec1", created_by: "cust1", reservation_id: "h1", extra_reservation_ids: [], ...over });

function seed(reqs: Array<Record<string, unknown>>, holds: Array<Record<string, unknown>> = []) {
  const extended: string[] = [];
  const m = memDb({
    service_requests: reqs, credit_reservations: holds, service_staff: [{ user_id: "mgr1", role: "manager", active: true }],
    workspace_members: [{ workspace_id: "w1", user_id: "own1", role: "owner", status: "active" }], notifications: [],
  }, { extend_reservation: (a) => { extended.push(String(a.p_reservation)); return { id: a.p_reservation }; } });
  return { ...m, extended };
}

describe("service upkeep", () => {
  it("extends holds of open work that would expire within a week", async () => {
    const m = seed([req({}), req({ id: "r2", reservation_id: "h2" })], [
      { id: "h1", status: "held", expires_at: "2026-11-22T00:00:00Z" },
      { id: "h2", status: "held", expires_at: "2027-01-30T00:00:00Z" },
    ]);
    const r = await createServiceActivities({ db: m.db, now: () => NOW }).serviceMaintenance();
    expect(r.extended).toBe(1);
    expect(m.extended).toEqual(["h1"]);
  });

  it("reminds about overdue work once a day (assignee + managers), and slow approvals every 3 days", async () => {
    const m = seed([
      req({ due_at: "2026-11-17T00:00:00Z" }),
      req({ id: "r3", status: "delivered", due_at: "2026-11-10T00:00:00Z", delivered_at: "2026-11-14T00:00:00Z" }),
      req({ id: "r4", status: "delivered", delivered_at: "2026-11-17T00:00:00Z" }),
    ]);
    const acts = createServiceActivities({ db: m.db, now: () => NOW });
    const r = await acts.serviceMaintenance();
    expect(r).toMatchObject({ overdue: 1, reminded: 1 });   // delivered work is never "overdue"; r4 waited < 3 days
    const notes = m.tables.notifications as Array<{ user_id: string; kind: string; dedupe_key: string }>;
    expect(notes.filter((n) => n.kind === "staff.overdue").map((n) => n.user_id).sort()).toEqual(["mgr1", "spec1"]);
    expect(notes.filter((n) => n.kind === "customer.awaiting_approval").map((n) => n.user_id).sort()).toEqual(["cust1", "own1"]);
    expect(notes.find((n) => n.kind === "staff.overdue")!.dedupe_key).toBe("overdue:r1:2026-11-18");
  });
});

const run = process.env.SKIP_TEMPORAL_TESTS ? describe.skip : describe;
run("billing maintenance", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120_000);
  afterAll(async () => env?.teardown());
  it("extends service holds before expiring stale ones", async () => {
    const calls: string[] = [];
    const acts = {
      serviceMaintenance: async () => { calls.push("services"); return { extended: 1, overdue: 0, reminded: 0 }; },
      expireReservations: async () => { calls.push("expire"); return 0; },
      reconcileTopups: async () => 0, syncUsage: async () => ({ sent: 0 }),
    };
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "q-bill", activities: acts, workflowsPath: fileURLToPath(new URL("../src/workflows/index.ts", import.meta.url)) });
    const r = await worker.runUntil(env.client.workflow.execute("billingMaintenanceWorkflow", { taskQueue: "q-bill", workflowId: "bm-1", args: [] }));
    expect(calls).toEqual(["services", "expire"]);
    expect(r).toMatchObject({ services: { extended: 1 } });
  });
});
