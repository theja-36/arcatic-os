import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { ApiDeps, Membership } from "../src/types.js";
import { fakeDb } from "./fake-db.js";

const WS = "11111111-1111-4111-8111-111111111111";
const BRAND = "33333333-3333-4333-8333-333333333333";
const REQ = "44444444-4444-4444-8444-444444444444";
const CI = "55555555-5555-4555-8555-555555555555";
const ADMIN = "x".repeat(40);

const offering = {
  key: "expert_article", name: "Expert-written article", description: "d", category: "writing", credits: 120, turnaround_hours: 120, included_revisions: 1, extra_revision_credits: 20,
  deliverable_type: "blog", deliverable_kind: "content", needs_source_content: false, qa_required: true, active: true,
  intake_fields: [{ key: "topic", label: "Topic", type: "text", required: true, max: 200 }, { key: "keyword", label: "Keyword", type: "text", required: false }],
};
const ctx = { context: { data: { name: "Annapurna", audiences: [], offers: [], voice: { tone: ["warm"], personality: [], emotions: [], syntax: [], do: [], dont: [] }, vocabulary: { preferred: [], banned: ["cheap"] }, visual: { colors: [], fonts: [], layoutRules: [] }, channelRules: {}, languages: { primary: "en", supported: ["en"] }, compliance: { disclaimers: [], claimsPolicy: "strict" }, differentiators: [], proofPoints: [], objections: [] } } };
const request = (over: Record<string, unknown> = {}) => ({
  id: REQ, workspace_id: WS, brand_id: BRAND, offering_key: "expert_article", title: "Tiffin guide", status: "draft", intake: { topic: "Tiffins in Pune" }, brief: null,
  source_content_item_id: null, source_version_id: null, reference_asset_ids: [], credits: null, reservation_id: null, extra_reservation_ids: [], revisions_included: 1, revisions_used: 0,
  assignee_id: null, due_at: null, lock_version: 0, created_by: "u1", ...over,
});
const doc = { format: 1, blocks: [{ id: "b1", kind: "title", text: "Tiffins in Pune", origin: "human" }, { id: "b2", kind: "paragraph", text: "A tiffin service delivers lunch.", origin: "human" }] };

function setup(role: Membership["role"], tables: Record<string, unknown[]>, opts: { userId?: string; rpc?: Record<string, unknown>; apiKey?: boolean } = {}) {
  const all = { service_offerings: [offering], brands: [{ id: BRAND, name: "Annapurna", active_kit_version_id: "kv1", languages: ["en"] }], brand_contexts: [ctx], service_events: [{ id: 1 }], service_messages: [{ id: "m1" }], notifications: [{ id: "n1" }], ...tables };
  const user = fakeDb(all);
  const svc = fakeDb(all, { reserve_credits: { id: "hold1", amount: 120, status: "held" }, settle_reservation: { id: "hold1", status: "settled" }, release_reservation: { id: "hold1", status: "released" }, ...opts.rpc });
  const deps: ApiDeps = {
    corsOrigins: [], verifyJwt: async () => ({ sub: opts.userId ?? "u1" }), resolveMembership: async () => ({ role, brandRestricted: false }),
    resolveApiKey: async () => (opts.apiKey ? { kind: "api_key", keyId: "k", workspaceId: WS, role, scopes: [] } : null),
    userDb: () => user.db, serviceDb: () => svc.db, jobs: (async () => ({})) as never, adminToken: ADMIN,
  };
  const app = buildApp(deps);
  const req = (method: string, path: string, payload?: unknown, auth = opts.apiKey ? "Bearer ak_live_x" : "Bearer t") => app.request(path, {
    method, body: payload === undefined ? undefined : JSON.stringify(payload), headers: { authorization: auth, ...(opts.apiKey && { "x-api-key": "ak_live_x" }), "content-type": "application/json", "idempotency-key": "key-0000000001" },
  });
  return { call: (m: string, p: string, b?: unknown) => req(m, `/v1/workspaces/${WS}/brands/${BRAND}${p}`, b), ws: (m: string, p: string, b?: unknown) => req(m, `/v1/workspaces/${WS}${p}`, b), v1: (m: string, p: string, b?: unknown) => req(m, `/v1${p}`, b), admin: (m: string, p: string, b?: unknown, t = ADMIN) => req(m, `/admin${p}`, b, `Bearer ${t}`), svc };
}
const ops = (s: ReturnType<typeof setup>["svc"], table: string, op = "update") => s.ops.filter((o) => o.table === table && o.op === op).map((o) => o.payload as Record<string, unknown>);

describe("services: customer side", () => {
  it("lists the catalogue and creates a draft with only known, valid fields", async () => {
    const a = setup("contributor", { service_requests: [request()] });
    expect((await a.ws("GET", "/services/offerings")).status).toBe(200);
    const res = await a.call("POST", "/services", { offeringKey: "expert_article", title: "Tiffin guide", intake: { topic: "Tiffins", sneaky: "x" } });
    expect(res.status).toBe(201);
    expect(ops(a.svc, "service_requests", "insert")[0]).toMatchObject({ intake: { topic: "Tiffins" }, revisions_included: 1, created_by: "u1" });
    expect(ops(a.svc, "service_requests", "insert")[0]!.intake).not.toHaveProperty("sneaky");
    expect((await setup("contributor", {}).call("POST", "/services", { offeringKey: "expert_article", title: "x", intake: { topic: "y".repeat(300) } })).status).toBe(422);
    expect((await setup("viewer", {}).call("POST", "/services", { offeringKey: "expert_article", title: "x" })).status).toBe(403);
    expect((await setup("editor", {}, { apiKey: true }).call("POST", "/services", { offeringKey: "expert_article", title: "x" })).status).toBe(403);
  });

  it("submit: freezes the brief, holds the price for 60 days, notifies managers", async () => {
    const a = setup("editor", { service_requests: [request()], service_staff: [{ user_id: "mgr1", role: "manager", active: true }] });
    const res = await a.call("POST", `/services/${REQ}/submit`);
    expect(res.status).toBe(200);
    const hold = a.svc.ops.find((o) => o.op === "rpc" && o.table === "reserve_credits")!.payload as Record<string, unknown>;
    expect(hold).toMatchObject({ p_amount: 120, p_idempotency_key: `service:${REQ}`, p_ttl: `${60 * 24 * 3600} seconds` });
    const up = ops(a.svc, "service_requests")[0]!;
    expect(up).toMatchObject({ status: "submitted", credits: 120, reservation_id: "hold1" });
    expect((up.brief as { brand: { bannedWords: string[] }; requirements: unknown[] }).brand.bannedWords).toContain("cheap");
    const sent = ops(a.svc, "notifications", "insert");
    expect(sent.find((n) => n.kind === "staff.new_request")).toMatchObject({ user_id: "mgr1", audience: "staff", link: `/desk/${REQ}` });
    expect(sent.find((n) => n.kind === "customer.received")).toMatchObject({ user_id: "u1", audience: "customer" });
    expect(String(sent.find((n) => n.kind === "customer.received")!.body)).toMatch(/120 credits on hold/);
  });

  it("submit refuses incomplete forms and non-drafts", async () => {
    expect((await setup("editor", { service_requests: [request({ intake: {} })] }).call("POST", `/services/${REQ}/submit`)).status).toBe(422);
    expect((await setup("editor", { service_requests: [request({ status: "delivered" })] }).call("POST", `/services/${REQ}/submit`)).status).toBe(409);
  });

  it("cancel releases every hold; refused once work has started", async () => {
    const a = setup("editor", { service_requests: [request({ status: "assigned", assignee_id: "spec1", reservation_id: "hold1", extra_reservation_ids: ["hold2"] })] });
    expect((await a.call("POST", `/services/${REQ}/cancel`)).status).toBe(200);
    expect(a.svc.ops.filter((o) => o.op === "rpc" && o.table === "release_reservation").map((o) => (o.payload as { p_reservation: string }).p_reservation)).toEqual(["hold1", "hold2"]);
    expect((await setup("editor", { service_requests: [request({ status: "in_progress" })] }).call("POST", `/services/${REQ}/cancel`)).status).toBe(409);
  });

  it("the customer never sees internal notes, holds or who exactly is assigned", async () => {
    const a = setup("viewer", { service_requests: [request({ status: "in_progress", reservation_id: "hold1", assignee_id: "spec1" })], service_deliverables: [] });
    const body = await (await a.call("GET", `/services/${REQ}`)).json() as Record<string, unknown>;
    expect(body).not.toHaveProperty("reservation_id");
    expect(body).not.toHaveProperty("assignee_id");
    expect(body).toMatchObject({ assigned: true, stage: "Being worked on" });
  });

  it("revise: included revisions are free, further ones hold extra credits", async () => {
    const free = setup("editor", { service_requests: [request({ status: "delivered", assignee_id: "spec1" })] });
    expect(await (await free.call("POST", `/services/${REQ}/revise`, { note: "Shorter intro please" })).json()).toMatchObject({ charged: 0 });
    expect(free.svc.ops.some((o) => o.op === "rpc" && o.table === "reserve_credits")).toBe(false);
    expect(ops(free.svc, "service_requests")[0]).toMatchObject({ status: "revision_requested", revisions_used: 1 });
    const paid = setup("editor", { service_requests: [request({ status: "delivered", revisions_used: 1, assignee_id: "spec1" })] });
    expect(await (await paid.call("POST", `/services/${REQ}/revise`, { note: "One more pass" })).json()).toMatchObject({ charged: 20 });
    expect(paid.svc.ops.find((o) => o.op === "rpc" && o.table === "reserve_credits")!.payload).toMatchObject({ p_amount: 20, p_idempotency_key: `service:${REQ}:rev:2` });
    expect((await setup("contributor", { service_requests: [request({ status: "delivered" })] }).call("POST", `/services/${REQ}/revise`, { note: "x y z w" })).status).toBe(403);
  });

  it("approve: lands the text in Content, then charges base + paid revisions", async () => {
    const a = setup("reviewer", {
      service_requests: [request({ status: "delivered", credits: 120, reservation_id: "hold1", extra_reservation_ids: ["hold2"], revisions_used: 2, assignee_id: "spec1" })],
      service_deliverables: [{ id: "d2", request_id: REQ, round: 3, doc, files: [], status: "delivered" }], content_items: [{ id: CI }], content_versions: [{ id: "v1" }],
      credit_reservations: [{ id: "hold1", status: "held" }, { id: "hold2", status: "held" }],
    });
    const res = await a.call("POST", `/services/${REQ}/approve`, { rating: 5 });
    expect(res.status).toBe(200);
    expect(ops(a.svc, "content_items", "insert")[0]).toMatchObject({ type: "blog", status: "draft", source_ref: { kind: "service", id: REQ } });
    expect(ops(a.svc, "content_versions", "insert")[0]).toMatchObject({ origin: "human", transform: "service", version: 1 });
    const settles = a.svc.ops.filter((o) => o.op === "rpc" && o.table === "settle_reservation").map((o) => o.payload as { p_reservation: string; p_actual: number });
    expect(settles).toEqual([{ p_reservation: "hold1", p_actual: 120, p_allow_overrun: false }, { p_reservation: "hold2", p_actual: 20, p_allow_overrun: false }]);
    expect(ops(a.svc, "service_requests")[0]).toMatchObject({ status: "approved", rating: 5, result_content_item_id: CI });
    expect((await setup("reviewer", { service_requests: [request({ status: "in_progress" })] }).call("POST", `/services/${REQ}/approve`, {})).status).toBe(409);
  });
});

describe("service desk", () => {
  const staffRow = (role: string, id = "u1") => ({ user_id: id, role, display_name: role, skills: ["writing"], active: true, max_active: 5 });

  it("doesn't exist for people who aren't on the service team", async () => {
    expect((await setup("owner", { service_staff: [] }).v1("GET", "/desk/requests")).status).toBe(404);
  });

  it("specialists only reach requests assigned to them", async () => {
    const t = { service_staff: [staffRow("specialist")], service_requests: [request({ status: "assigned", assignee_id: "someone-else" })] };
    expect((await setup("viewer", t).v1("GET", `/desk/requests/${REQ}`)).status).toBe(404);
    expect((await setup("viewer", t).v1("POST", `/desk/requests/${REQ}/start`)).status).toBe(404);
  });

  it("managers assign; the specialist starts from the customer's draft and hands in to QA", async () => {
    const m = setup("viewer", { service_staff: [staffRow("manager", "u1"), staffRow("specialist", "77777777-7777-4777-8777-777777777777")], service_requests: [request({ status: "submitted" })] });
    expect((await m.v1("POST", `/desk/requests/${REQ}/assign`, { userId: "77777777-7777-4777-8777-777777777777" })).status).toBe(200);
    expect(ops(m.svc, "service_requests")[0]).toMatchObject({ status: "assigned" });
    expect(ops(m.svc, "notifications", "insert").find((n) => n.kind === "staff.assigned")).toMatchObject({ audience: "staff" });
    expect(ops(m.svc, "notifications", "insert").find((n) => n.kind === "customer.assigned")!.body).not.toMatch(/specialist/i);

    const s = setup("viewer", { service_staff: [staffRow("specialist")], service_requests: [request({ status: "assigned", assignee_id: "u1", source_version_id: "v0" })], service_deliverables: [], content_versions: [{ id: "v0", body: { doc } }] });
    expect((await s.v1("POST", `/desk/requests/${REQ}/start`)).status).toBe(200);
    expect(ops(s.svc, "service_deliverables", "insert")[0]).toMatchObject({ round: 1, doc });

    const h = setup("viewer", { service_staff: [staffRow("specialist")], service_requests: [request({ status: "in_progress", assignee_id: "u1" })], service_deliverables: [{ id: "d1", request_id: REQ, round: 1, doc, files: [], status: "draft" }] });
    expect((await h.v1("POST", `/desk/requests/${REQ}/submit`)).status).toBe(200);
    expect(ops(h.svc, "service_requests")[0]).toMatchObject({ status: "in_review" });
  });

  it("hand-in needs the finished work; specialists can't do QA", async () => {
    const empty = setup("viewer", { service_staff: [staffRow("specialist")], service_requests: [request({ status: "in_progress", assignee_id: "u1" })], service_deliverables: [{ id: "d1", request_id: REQ, round: 1, doc: { format: 1, blocks: [] }, files: [], status: "draft" }] });
    expect((await empty.v1("POST", `/desk/requests/${REQ}/submit`)).status).toBe(422);
    expect((await setup("viewer", { service_staff: [staffRow("specialist")], service_requests: [request({ status: "in_review", assignee_id: "u1" })] }).v1("POST", `/desk/requests/${REQ}/qa`, { decision: "approve" })).status).toBe(403);
  });

  it("QA approval delivers to the customer and notifies the requester and approvers", async () => {
    const m = setup("viewer", {
      service_staff: [staffRow("manager")], service_requests: [request({ status: "in_review", assignee_id: "spec1" })],
      service_deliverables: [{ id: "d1", request_id: REQ, round: 1, doc, files: [], status: "in_review", note: "Here you go" }], workspace_members: [{ user_id: "owner1", role: "owner" }],
    });
    expect((await m.v1("POST", `/desk/requests/${REQ}/qa`, { decision: "approve" })).status).toBe(200);
    expect(ops(m.svc, "service_requests")[0]).toMatchObject({ status: "delivered", qa_by: "u1" });
    const notes = ops(m.svc, "notifications", "insert").filter((n) => n.kind === "customer.delivered");
    expect(notes.map((n) => n.user_id).sort()).toEqual(["owner1", "u1"].sort());
    expect(notes[0]).toMatchObject({ audience: "customer", body: "Here you go", link: `/w/${WS}/b/${BRAND}/services/${REQ}` });
    expect((await setup("viewer", { service_staff: [staffRow("manager")], service_requests: [request({ status: "in_review" })], service_deliverables: [{ id: "d1", request_id: REQ, round: 1, doc, files: [], status: "in_review" }] }).v1("POST", `/desk/requests/${REQ}/qa`, { decision: "return" })).status).toBe(422);
  });

  it("uploads only accepted types into the current round", async () => {
    const s = setup("viewer", { service_staff: [staffRow("specialist")], service_requests: [request({ status: "in_progress", assignee_id: "u1" })] });
    expect((await s.v1("POST", `/desk/requests/${REQ}/files`, { name: "run.exe", mime: "application/x-msdownload", size: 10 })).status).toBe(422);
    expect((await s.v1("POST", `/desk/requests/${REQ}/files/confirm`, { path: `${REQ}/r9/x.png`, name: "x.png", mime: "image/png", size: 10 })).status).toBe(409);
  });

  it("staff are added through the admin API only", async () => {
    const a = setup("owner", { users: [{ id: "u9", email: "pat@example.test" }], service_staff: [{ user_id: "u9" }] });
    expect((await a.admin("PUT", "/service-staff", { email: "pat@example.test", role: "specialist", displayName: "Pat", skills: ["writing"] }, "wrong")).status).toBe(404);
    expect((await a.admin("PUT", "/service-staff", { email: "pat@example.test", role: "specialist", displayName: "Pat", skills: ["writing"] })).status).toBe(200);
    expect(ops(a.svc, "service_staff", "upsert")[0]).toMatchObject({ user_id: "u9", role: "specialist", skills: ["writing"] });
  });
});

describe("mobile-ready endpoints", () => {
  it("inbox gathers approvals, deliveries and ad requests the person can act on", async () => {
    const t = {
      approvals: [{ id: "ap1", brand_id: BRAND, created_at: "2026-11-17T09:00:00Z", due_at: null, item: { id: CI, title: "Diwali post", type: "social_post", channel: "instagram" } }],
      service_requests: [{ id: REQ, brand_id: BRAND, title: "Tiffin guide", status: "delivered", delivered_at: "2026-11-17T10:00:00Z" }],
      ad_actions: [{ id: "aa1", action: "launch", summary: "Create … PAUSED", payload: { confirm: "Tiffin search" }, created_at: "2026-11-17T08:00:00Z", campaign: { id: "c1", name: "Tiffin search", brand_id: BRAND, platform: "google" } }],
    };
    const owner = await (await setup("owner", t).ws("GET", "/inbox")).json() as { data: Array<{ kind: string }>; counts: Record<string, number> };
    expect(owner.data.map((x) => x.kind)).toEqual(["ad_request", "content_approval", "service_delivery"]);
    expect(owner.counts).toEqual({ contentApprovals: 1, serviceDeliveries: 1, adRequests: 1 });
    const viewer = await (await setup("viewer", t).ws("GET", "/inbox")).json() as { data: Array<{ kind: string; canDecide: boolean }> };
    expect(viewer.data.some((x) => x.kind === "ad_request")).toBe(false);
    expect(viewer.data.every((x) => !x.canDecide)).toBe(true);
  });

  it("agenda and publishing status page with cursors", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `s${i}`, publish_at: `2026-11-1${8 + i}T10:00:00Z`, updated_at: `2026-11-1${8 + i}T10:00:00Z`, status: "scheduled" }));
    const a = await (await setup("viewer", { schedules: rows }).ws("GET", "/agenda?limit=2")).json() as { data: unknown[]; next_cursor: string | null };
    expect(a.data).toHaveLength(2);
    expect(a.next_cursor).toBe("2026-11-19T10:00:00Z");
    const p = await (await setup("viewer", { schedules: rows }).ws("GET", "/publishing/status?limit=5&status=failed")).json() as { next_cursor: string | null };
    expect(p.next_cursor).toBeNull();
    expect((await setup("viewer", {}).ws("GET", "/agenda?from=2026-11-20T00:00:00Z&to=2026-11-19T00:00:00Z")).status).toBe(422);
  });

  it("quick-create options list short-form types with prices", async () => {
    const r = await (await setup("contributor", {}).ws("GET", "/quick-create/options")).json() as { canCreate: boolean; types: Array<{ type: string; cost: { estimate: number } }>; brands: Array<{ ready: boolean }> };
    expect(r.canCreate).toBe(true);
    expect(r.types.find((t) => t.type === "social_post")!.cost.estimate).toBe(1);
    expect(r.brands[0]!.ready).toBe(true);
  });

  it("notifications and devices belong to the signed-in person", async () => {
    const a = setup("viewer", { notifications: [{ id: "n1", created_at: "2026-11-17T10:00:00Z" }], user_devices: [{ id: "d1" }] });
    expect((await a.v1("GET", "/me/notifications")).status).toBe(200);
    expect((await a.v1("POST", "/me/notifications/read", { all: true })).status).toBe(200);
    expect(ops(a.svc, "notifications")[0]).toHaveProperty("read_at");
    expect((await a.v1("POST", "/me/devices", { kind: "webpush", endpoint: "http://insecure.example/push", keys: { p256dh: "k", auth: "a" } })).status).toBe(422);
    expect((await a.v1("POST", "/me/devices", { kind: "webpush", endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } })).status).toBe(201);
    expect(ops(a.svc, "user_devices", "upsert")[0]).toMatchObject({ user_id: "u1", kind: "webpush" });
    expect((await setup("viewer", {}, { apiKey: true }).v1("GET", "/me/notifications")).status).toBe(403);
  });
});
