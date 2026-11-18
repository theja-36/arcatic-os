import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { ApiDeps, Membership } from "../src/types.js";
import { fakeDb } from "./fake-db.js";

/**
 * Security of the services / mobile surface: IDOR, role escalation, cross-workspace access,
 * staff-only endpoints, attachment paths and notification leakage. RLS itself is proven against
 * Postgres in supabase/tests/smoke (§23–24) and on the local staging stack (scripts/e2e).
 */
const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "99999999-9999-4999-8999-999999999999";
const BRAND = "33333333-3333-4333-8333-333333333333";
const REQ = "44444444-4444-4444-8444-444444444444";
const ADMIN = "y".repeat(40);
const offering = { key: "expert_article", name: "Expert article", category: "writing", credits: 120, turnaround_hours: 120, included_revisions: 1, extra_revision_credits: 20, deliverable_type: "blog", deliverable_kind: "content", needs_source_content: false, qa_required: true, active: true, intake_fields: [] };
const doc = { format: 1, blocks: [{ id: "b1", kind: "paragraph", text: "Finished.", origin: "human" }] };
const request = (over: Record<string, unknown> = {}) => ({ id: REQ, workspace_id: WS, brand_id: BRAND, offering_key: "expert_article", title: "Tiffin guide", status: "delivered", intake: {}, credits: 120, reservation_id: "hold1", extra_reservation_ids: [], revisions_included: 1, revisions_used: 0, assignee_id: "spec1", due_at: null, lock_version: 3, created_by: "u1", reference_asset_ids: [], ...over });

function setup(role: Membership["role"] | null, tables: Record<string, unknown[]>, opts: { userId?: string; rpc?: Record<string, unknown> } = {}) {
  const all = { service_offerings: [offering], service_events: [{ id: 1 }], service_messages: [{ id: "m1" }], notifications: [{ id: "n1" }], ...tables };
  const svc = fakeDb(all, { reserve_credits: { id: "hold9", amount: 120, status: "held" }, settle_reservation: { id: "hold1", status: "settled" }, ...opts.rpc });
  const deps: ApiDeps = {
    corsOrigins: [], verifyJwt: async () => ({ sub: opts.userId ?? "u1" }), resolveApiKey: async () => null,
    resolveMembership: async (ws) => (role && ws === WS ? { role, brandRestricted: false } : null),
    userDb: () => fakeDb(all).db, serviceDb: () => svc.db, jobs: (async () => ({})) as never, adminToken: ADMIN,
  };
  const app = buildApp(deps);
  const req = (m: string, p: string, b?: unknown, auth = "Bearer t") => app.request(p, { method: m, body: b === undefined ? undefined : JSON.stringify(b), headers: { authorization: auth, "content-type": "application/json" } });
  return { req, svc, customer: (m: string, p: string, b?: unknown, ws = WS) => req(m, `/v1/workspaces/${ws}/brands/${BRAND}${p}`, b) };
}
const inserts = (s: ReturnType<typeof setup>["svc"], t: string) => s.ops.filter((o) => o.table === t && o.op === "insert").map((o) => o.payload as Record<string, unknown>);
const staffRow = (id: string, role: string) => ({ user_id: id, role, display_name: role, skills: ["writing"], active: true, max_active: 5 });

describe("IDOR and cross-workspace access", () => {
  it("a request id from another workspace is not found through this workspace", async () => {
    const t = { service_requests: [request({ workspace_id: OTHER_WS })] };
    for (const [m, p, b] of [["GET", `/services/${REQ}`], ["POST", `/services/${REQ}/approve`, {}], ["POST", `/services/${REQ}/cancel`], ["POST", `/services/${REQ}/messages`, { body: "hi" }]] as const) {
      expect((await setup("owner", t).customer(m, p, b)).status, `${m} ${p}`).toBe(404);
    }
  });
  it("non-members get 404 for the whole workspace (ids don't leak)", async () => {
    expect((await setup("owner", { service_requests: [request()] }).customer("GET", `/services/${REQ}`, undefined, OTHER_WS)).status).toBe(404);
    expect((await setup(null, { service_requests: [request()] }).req("GET", `/v1/workspaces/${WS}/inbox`)).status).toBe(404);
  });
  it("a specialist can't reach someone else's request, even by id, and isn't a workspace member", async () => {
    const t = { service_staff: [staffRow("u1", "specialist")], service_requests: [request({ status: "in_progress", assignee_id: "spec2" })] };
    for (const [m, p] of [["GET", ""], ["POST", "/start"], ["PUT", "/deliverable"], ["POST", "/submit"], ["POST", "/messages"]] as const) {
      expect((await setup(null, t).req(m, `/v1/desk/requests/${REQ}${p}`, m === "GET" ? undefined : { body: "x", doc: null })).status, p).toBe(404);
    }
    expect((await setup(null, t).customer("GET", `/services/${REQ}`)).status).toBe(404);   // the customer routes need membership
  });
  it("managers never see customer drafts", async () => {
    expect((await setup(null, { service_staff: [staffRow("u1", "manager")], service_requests: [request({ status: "draft" })] }).req("GET", `/v1/desk/requests/${REQ}`)).status).toBe(404);
  });
});

describe("role escalation", () => {
  it("customers can't approve without approval.decide, and can't touch desk endpoints", async () => {
    const t = { service_requests: [request()], service_staff: [], credit_reservations: [{ id: "hold1", status: "held" }] };
    expect((await setup("contributor", t).customer("POST", `/services/${REQ}/approve`, {})).status).toBe(403);
    expect((await setup("viewer", t).customer("POST", `/services/${REQ}/revise`, { note: "please change" })).status).toBe(403);
    expect((await setup("reviewer", t).customer("POST", `/services/${REQ}/submit`)).status).toBe(403);
    for (const [m, p, b] of [["POST", `/v1/desk/requests/${REQ}/assign`, { userId: "77777777-7777-4777-8777-777777777777" }], ["POST", `/v1/desk/requests/${REQ}/qa`, { decision: "approve" }], ["GET", "/v1/desk/ops"], ["GET", "/v1/desk/staff"]] as const) {
      expect((await setup("owner", t).req(m, p, b)).status, p).toBe(404);   // the desk doesn't exist for customers
    }
  });
  it("specialists can't assign, run QA or see ops; only managers can", async () => {
    const t = { service_staff: [staffRow("u1", "specialist")], service_requests: [request({ status: "in_review", assignee_id: "u1" })], service_ops: [], service_deliverables: [{ id: "d1", request_id: REQ, round: 1, doc, files: [], status: "in_review" }] };
    expect((await setup(null, t).req("POST", `/v1/desk/requests/${REQ}/assign`, { userId: "77777777-7777-4777-8777-777777777777" })).status).toBe(403);
    expect((await setup(null, t).req("POST", `/v1/desk/requests/${REQ}/qa`, { decision: "approve" })).status).toBe(403);
    expect((await setup(null, t).req("GET", "/v1/desk/ops")).status).toBe(403);
    expect((await setup(null, { ...t, service_staff: [staffRow("u1", "manager")] }).req("GET", "/v1/desk/ops")).status).toBe(200);
  });
  it("only the admin token adds staff or reads ops (404 otherwise)", async () => {
    const t = { service_ops: [], service_staff: [] };
    expect((await setup("owner", t).req("GET", "/admin/service-ops", undefined, "Bearer t")).status).toBe(404);
    expect((await setup("owner", t).req("PUT", "/admin/service-staff", { email: "x@example.test", role: "manager", displayName: "x" }, "Bearer t")).status).toBe(404);
    expect((await setup("owner", t).req("GET", "/admin/service-ops", undefined, `Bearer ${ADMIN}`)).status).toBe(200);
  });
});

describe("attachments", () => {
  it("a specialist can only attach files uploaded into the current round of their own request", async () => {
    const t = { service_staff: [staffRow("u1", "specialist")], service_requests: [request({ status: "in_progress", assignee_id: "u1" })], service_deliverables: [{ id: "d1", request_id: REQ, round: 1, doc, files: [], status: "draft" }] };
    for (const path of [`${REQ}/r2/x.png`, `other-request/r1/x.png`, `../${REQ}/r1/x.png`]) {
      expect((await setup(null, t).req("POST", `/v1/desk/requests/${REQ}/files/confirm`, { path, name: "x.png", mime: "image/png", size: 10 })).status, path).toBe(409);
    }
  });
  it("confirming a file that was never uploaded is refused", async () => {
    const t = { service_staff: [staffRow("u1", "specialist")], service_requests: [request({ status: "in_progress", assignee_id: "u1" })], service_deliverables: [{ id: "d1", request_id: REQ, round: 1, doc, files: [], status: "draft" }], storage: [] };
    expect((await setup(null, t).req("POST", `/v1/desk/requests/${REQ}/files/confirm`, { path: `${REQ}/r1/x.png`, name: "x.png", mime: "image/png", size: 10 })).status).toBe(422);
  });
});

describe("notification leakage", () => {
  it("QA returns and internal notes reach staff only", async () => {
    const t = { service_staff: [staffRow("u1", "manager")], service_requests: [request({ status: "in_review", assignee_id: "spec1" })], service_deliverables: [{ id: "d1", request_id: REQ, round: 1, doc, files: [], status: "in_review" }], workspace_members: [{ user_id: "owner1", role: "owner" }] };
    const a = setup(null, t);
    expect((await a.req("POST", `/v1/desk/requests/${REQ}/qa`, { decision: "return", note: "QA-SECRET tone off" })).status).toBe(200);
    expect((await a.req("POST", `/v1/desk/requests/${REQ}/messages`, { body: "INTERNAL-SECRET", internal: true })).status).toBe(201);
    const sent = inserts(a.svc, "notifications");
    expect(sent.every((n) => n.audience === "staff")).toBe(true);
    expect(sent.filter((n) => JSON.stringify(n).includes("SECRET")).every((n) => n.user_id === "spec1")).toBe(true);
  });
  it("customer notices never include hold ids or the specialist's identity", async () => {
    const t = { service_staff: [staffRow("u1", "manager"), staffRow("77777777-7777-4777-8777-777777777777", "specialist")], service_requests: [request({ status: "submitted", assignee_id: null, reservation_id: "hold-SECRET-id" })], workspace_members: [{ user_id: "owner1", role: "owner" }] };
    const a = setup(null, t);
    expect((await a.req("POST", `/v1/desk/requests/${REQ}/assign`, { userId: "77777777-7777-4777-8777-777777777777" })).status).toBe(200);
    const customer = inserts(a.svc, "notifications").filter((n) => n.audience === "customer");
    expect(customer.length).toBeGreaterThan(0);
    for (const n of customer) expect(JSON.stringify(n)).not.toMatch(/hold-SECRET-id|specialist\b.*7777|display_name/);
  });
});

describe("credit hold failure paths", () => {
  const delivered = { service_requests: [request()], service_deliverables: [{ id: "d1", request_id: REQ, round: 1, doc, files: [], status: "delivered" }], content_items: [{ id: "c1" }], content_versions: [{ id: "v1" }] };
  it("an expired hold is held again before delivery, then charged", async () => {
    const a = setup("owner", { ...delivered, credit_reservations: [{ id: "hold1", status: "expired" }] });
    expect((await a.customer("POST", `/services/${REQ}/approve`, {})).status).toBe(200);
    const rpc = a.svc.ops.filter((o) => o.op === "rpc").map((o) => o.table);
    expect(rpc.indexOf("reserve_credits")).toBeLessThan(rpc.indexOf("settle_reservation"));
    expect(a.svc.ops.find((o) => o.op === "rpc" && o.table === "reserve_credits")!.payload).toMatchObject({ p_idempotency_key: `service:${REQ}:recharge:base`, p_amount: 120 });
    expect(a.svc.ops.find((o) => o.op === "rpc" && o.table === "settle_reservation")!.payload).toMatchObject({ p_reservation: "hold9", p_actual: 120 });
  });
  it("without enough credits the approval stops with 402 and nothing is delivered or charged", async () => {
    const a = setup("owner", { ...delivered, credit_reservations: [{ id: "hold1", status: "expired" }] }, { rpc: { reserve_credits: { __error: { message: "insufficient_credits: available 10, required 120", code: "P0001" } } } });
    expect((await a.customer("POST", `/services/${REQ}/approve`, {})).status).toBe(402);
    expect(inserts(a.svc, "content_versions")).toHaveLength(0);
    expect(inserts(a.svc, "content_items")).toHaveLength(0);
    expect(a.svc.ops.some((o) => o.op === "rpc" && o.table === "settle_reservation")).toBe(false);
    expect(a.svc.ops.some((o) => o.table === "service_requests" && o.op === "update")).toBe(false);
  });
});
