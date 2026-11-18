import { customerNotice } from "@arcatic/core";
import type { Mailer, WebPushSender } from "@arcatic/integrations";
import { describe, expect, it } from "vitest";
import { createNotifier } from "../src/notifier.js";
import { createServiceActivities } from "../src/service-activities.js";
import { memDb } from "./mem-db.js";

const facts = { requestId: "r1", workspaceId: "w1", brandId: "b1", title: "Tiffin guide", offeringName: "Expert article", customerNote: "Here you go" };
const fakePush = (status: Record<string, number>) => {
  const sent: string[] = [], payloads: Array<{ link?: string; title: string; tag?: string; id?: string; receipt?: string; receiptUrl?: string }> = [];
  return { sent, payloads, push: { publicKey: "k", send: async (s: { endpoint: string }, p: { link?: string; title: string; tag?: string; id?: string; receipt?: string; receiptUrl?: string }) => { sent.push(s.endpoint); payloads.push(p); const st = status[s.endpoint] ?? 201; return st < 300 ? { ok: true, status: st } : { ok: false, status: st, expired: st === 410 || st === 404, message: "gone" }; } } as unknown as WebPushSender };
};
const fakeMail = (mode: "allowlist" | "throw" = "allowlist") => {
  const sent: string[] = [];
  return { sent, mailer: { send: async (m: { to: string }) => { if (mode === "throw") throw new Error("smtp down"); if (!m.to.endsWith("@example.test")) return { sent: false, reason: "recipient not on the staging allowlist" }; sent.push(m.to); return { sent: true, id: "1" }; } } as unknown as Mailer };
};

describe("notifier", () => {
  it("stores the notice, pushes to every device, emails critical events and records the outcome", async () => {
    const m = memDb({ notifications: [], users: [{ id: "u1", email: "owner@example.test" }], user_devices: [{ id: "d1", user_id: "u1", kind: "webpush", endpoint: "https://push/a", keys: { p256dh: "p", auth: "a" } }, { id: "d2", user_id: "u1", kind: "webpush", endpoint: "https://push/gone", keys: { p256dh: "p", auth: "a" } }] });
    const p = fakePush({ "https://push/gone": 410 }), e = fakeMail();
    const n = createNotifier({ db: m.db, push: p.push, mailer: e.mailer, appUrl: "https://app.example.test" });
    const [r] = await n.send([{ to: { userId: "u1", audience: "customer", workspaceId: "w1" }, notice: customerNotice("delivered", facts, "https://app.example.test"), dedupeKey: "delivered:r1:1" }]);
    expect(r!.push).toEqual([{ status: 201, ok: true }, { status: 410, ok: false, expired: true }]);
    expect(r!.email).toEqual({ sent: true });
    expect(e.sent).toEqual(["owner@example.test"]);
    expect(p.payloads.map((x) => x.link)).toEqual(["/m/w1?tab=inbox&service=r1&brand=b1", "/m/w1?tab=inbox&service=r1&brand=b1"]);   // push taps open the mobile hub
    expect((m.tables.user_devices as Array<{ id: string }>).map((d) => d.id)).toEqual(["d1"]);   // expired subscription removed
    const row = (m.tables.notifications as Array<Record<string, unknown>>)[0]!;
    expect(row).toMatchObject({ audience: "customer", kind: "customer.delivered", body: "Here you go", delivery: { email: { sent: true } } });
  });
  it("gives each push its own tag and a signed receipt (a shared tag silently replaced later notifications)", async () => {
    const m = memDb({ notifications: [], users: [{ id: "u1", email: "o@example.test" }], user_devices: [{ id: "d1", user_id: "u1", kind: "webpush", endpoint: "https://push/a", keys: { p256dh: "p", auth: "a" } }] });
    const p = fakePush({});
    const n = createNotifier({ db: m.db, push: p.push, receiptSecret: "s", receiptUrl: "https://api.example.test/push/receipt" });
    await n.send([{ to: { userId: "u1", audience: "customer" }, notice: customerNotice("delivered", facts), dedupeKey: "a" }, { to: { userId: "u1", audience: "customer" }, notice: customerNotice("delivered", facts), dedupeKey: "b" }]);
    const [x, y] = p.payloads;
    expect(x!.tag).not.toBe(y!.tag);
    expect(x!.tag).toBe(`n-${x!.id}`);
    expect(x!.receipt).toMatch(new RegExp(`^${x!.id}\\.`));
    expect(x!.receiptUrl).toBe("https://api.example.test/push/receipt");
  });
  it("never emails addresses outside the staging allowlist; email failure doesn't fail the action", async () => {
    const m = memDb({ notifications: [], users: [{ id: "u2", email: "real.person@gmail.com" }], user_devices: [] });
    const [r] = await createNotifier({ db: m.db, mailer: fakeMail().mailer }).send([{ to: { userId: "u2", audience: "customer" }, notice: customerNotice("delivered", facts) }]);
    expect(r!.email).toEqual({ sent: false, reason: "recipient not on the staging allowlist" });
    const m2 = memDb({ notifications: [], users: [{ id: "u1", email: "o@example.test" }], user_devices: [] });
    const [r2] = await createNotifier({ db: m2.db, mailer: fakeMail("throw").mailer }).send([{ to: { userId: "u1", audience: "customer" }, notice: customerNotice("delivered", facts) }]);
    expect(r2!.email).toEqual({ sent: false, reason: "smtp down" });
  });
  it("chatty events stay in-app (no email)", async () => {
    const m = memDb({ notifications: [], users: [{ id: "u1", email: "o@example.test" }], user_devices: [] });
    const e = fakeMail();
    await createNotifier({ db: m.db, mailer: e.mailer }).send([{ to: { userId: "u1", audience: "customer" }, notice: customerNotice("message", { ...facts, staffMessage: "hi" }) }]);
    expect(e.sent).toEqual([]);
  });
});

describe("hold upkeep failure paths", () => {
  it("a hold that already expired is reported to managers and recorded as an event", async () => {
    const m = memDb({
      service_requests: [{ id: "r1", workspace_id: "w1", brand_id: "b1", title: "Tiffin guide", offering_key: "expert_article", status: "in_progress", due_at: "2099-01-01T00:00:00Z", delivered_at: null, assignee_id: "spec1", created_by: "c1", reservation_id: "h1", extra_reservation_ids: [] }],
      credit_reservations: [{ id: "h1", status: "expired", expires_at: "2026-11-01T00:00:00Z" }], service_offerings: [{ key: "expert_article", name: "Expert article" }],
      service_staff: [{ user_id: "mgr1", role: "manager", active: true }], service_events: [], notifications: [], workspace_members: [],
    }, { extend_reservation: () => { throw new Error("should not be called for an expired hold"); } });
    const r = await createServiceActivities({ db: m.db, now: () => new Date("2026-11-18T00:00:00Z") }).serviceMaintenance();
    expect(r).toMatchObject({ extended: 0, lost: 1 });
    expect(m.tables.service_events).toEqual([expect.objectContaining({ kind: "hold_lost", actor_kind: "system", note: "credit hold expired" })]);
    expect(m.tables.notifications).toEqual([expect.objectContaining({ user_id: "mgr1", kind: "staff.hold_lost", audience: "staff" })]);
  });
  it("an extended hold leaves an audit-trail event", async () => {
    const m = memDb({
      service_requests: [{ id: "r1", workspace_id: "w1", brand_id: "b1", title: "t", offering_key: "k", status: "delivered", due_at: null, delivered_at: "2026-11-17T00:00:00Z", assignee_id: null, created_by: "c1", reservation_id: "h1", extra_reservation_ids: [] }],
      credit_reservations: [{ id: "h1", status: "held", expires_at: "2026-11-20T00:00:00Z" }], service_offerings: [], service_staff: [], service_events: [], notifications: [], workspace_members: [],
    }, { extend_reservation: (a) => ({ id: a.p_reservation }) });
    expect((await createServiceActivities({ db: m.db, now: () => new Date("2026-11-18T00:00:00Z") }).serviceMaintenance()).extended).toBe(1);
    expect(m.tables.service_events).toEqual([expect.objectContaining({ kind: "hold_extended" })]);
  });
});
