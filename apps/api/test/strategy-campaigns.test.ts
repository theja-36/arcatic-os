import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { ApiDeps, Membership } from "../src/types.js";
import { fakeDb } from "./fake-db.js";

const WS = "11111111-1111-4111-8111-111111111111";
const BRAND = "33333333-3333-4333-8333-333333333333";
const CAMP = "55555555-5555-4555-8555-555555555555";
const STRAT = "66666666-6666-4666-8666-666666666666";
const TOPIC = "77777777-7777-4777-8777-777777777777";

function setup(role: Membership["role"], tables: Record<string, unknown[]>, starter: Partial<Record<string, unknown>> | null = {}, updates: Record<string, unknown[]> = {}) {
  const user = fakeDb(tables, {}, updates);
  const svc = fakeDb(tables);
  const jobs = starter === null
    ? vi.fn(async () => { throw new Error("temporal down"); })
    : vi.fn(async () => ({ signalRunner: vi.fn(async () => true), ensureRunner: vi.fn(async () => undefined), runnerState: vi.fn(async () => null), ...starter }));
  const deps: ApiDeps = {
    corsOrigins: [], verifyJwt: async () => ({ sub: "u1" }), resolveApiKey: async () => null,
    resolveMembership: async () => ({ role, brandRestricted: false }), userDb: () => user.db, serviceDb: () => svc.db, jobs: jobs as never,
  };
  const app = buildApp(deps);
  const call = (method: string, path: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.request(`/v1/workspaces/${WS}/brands/${BRAND}${path}`, { method, body: payload === undefined ? undefined : JSON.stringify(payload), headers: { authorization: "Bearer t", "content-type": "application/json", ...headers } });
  return { call, user, svc, jobs };
}

const campaign = (status: string) => ({ id: CAMP, brand_id: BRAND, status, revision: 2, goal: "Orders", brief: { cta: "Order on WhatsApp" } });

describe("strategies", () => {
  it("won't generate until the Brand Kit is approved", async () => {
    const { call } = setup("editor", { brands: [{ id: BRAND, active_kit_version_id: null }] });
    const res = await call("POST", "/strategies", { channels: ["instagram"] }, { "idempotency-key": "gen-00001" });
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/Approve a Brand Kit/);
  });

  it("rejects weekly plans that don't start on a Monday", async () => {
    const { call } = setup("editor", { strategies: [{ id: STRAT, status: "active", revision: 1, plan: {}, starts_on: "2027-01-04", ends_on: "2027-04-04" }] });
    const res = await call("POST", `/strategies/${STRAT}/weekly-plan`, { weekStart: "2027-01-06" }, { "idempotency-key": "wk-000001" });
    expect(res.status).toBe(422);
  });

  it("validates edited plans: structure and cross-field rules", async () => {
    const { call, svc } = setup("editor", { strategies: [{ id: STRAT, status: "draft", revision: 1, plan: null, starts_on: "2027-01-04", ends_on: "2027-04-04" }] });
    expect((await call("PUT", `/strategies/${STRAT}/plan`, { revision: 1, plan: { summary: 3 } })).status).toBe(422);
    const plan = {
      summary: "s", positioning: "p", goals: [], audiences: [], pillars: [], channelMix: [], offers: [], metrics: [], assumptions: [], moments: [],
      campaigns: [{ key: "a", name: "A", theme: "", goal: "", startsOn: "2027-05-01", endsOn: "2027-05-10", audience: "", keyMessage: "", offer: "", cta: "", channels: [], contentTypes: [], pillar: "", kpis: [] }],
      weeks: [],
    };
    const res = await call("PUT", `/strategies/${STRAT}/plan`, { revision: 1, plan });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toMatch(/outside the strategy period/);
    expect(svc.ops.some((o) => o.op === "rpc")).toBe(false);
  });
});

describe("campaign lifecycle", () => {
  it("pauses an active campaign and signals its runner immediately", async () => {
    const signalRunner = vi.fn(async () => true);
    const { call, svc } = setup("editor", { campaigns: [campaign("active")] }, { signalRunner });
    const res = await call("POST", `/campaigns/${CAMP}/pause`);
    expect(res.status).toBe(200);
    expect((await res.json()).runner.signalled).toBe(true);
    expect(signalRunner).toHaveBeenCalledWith(CAMP, "pause", undefined);
    expect(svc.ops.find((o) => o.op === "update" && o.table === "campaigns")?.payload).toMatchObject({ status: "paused" });
  });

  it("refuses transitions the lifecycle doesn't allow", async () => {
    const { call } = setup("editor", { campaigns: [campaign("cancelled")] });
    expect((await call("POST", `/campaigns/${CAMP}/start`)).status).toBe(409);
    const { call: call2 } = setup("editor", { campaigns: [campaign("draft")] });
    expect((await call2("POST", `/campaigns/${CAMP}/pause`)).status).toBe(409);
  });

  it("doesn't change the campaign if the scheduler is down when starting", async () => {
    const { call, svc } = setup("editor", { campaigns: [campaign("planned")] }, null);
    expect((await call("POST", `/campaigns/${CAMP}/start`)).status).toBe(502);
    expect(svc.ops.some((o) => o.op === "update")).toBe(false);
  });

  it("starts the runner before marking the campaign active", async () => {
    const order: string[] = [];
    const ensureRunner = vi.fn(async () => void order.push("runner"));
    const { call, svc } = setup("editor", { campaigns: [campaign("planned")] }, { ensureRunner });
    const origFrom = svc.db.from;
    svc.db.from = (t: string) => (order.push(`db:${t}`), origFrom(t));
    expect((await call("POST", `/campaigns/${CAMP}/start`)).status).toBe(200);
    expect(order.indexOf("runner")).toBeLessThan(order.indexOf("db:campaigns"));
  });

  it("only editors and above can run campaigns", async () => {
    const { call } = setup("contributor", { campaigns: [campaign("planned")] });
    expect((await call("POST", `/campaigns/${CAMP}/start`)).status).toBe(403);
  });

  it("rejects stale campaign edits", async () => {
    const { call } = setup("editor", { campaigns: [campaign("active")] }, {}, { campaigns: [] });   // revision filter matches no row
    const res = await call("PATCH", `/campaigns/${CAMP}`, { revision: 1, name: "New" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.details.revision).toBe(2);
  });
});

describe("topics", () => {
  it("explains when a topic's format or channel can't be generated yet", async () => {
    const { call } = setup("editor", {
      campaign_topics: [{ id: TOPIC, campaign_id: CAMP, status: "approved", title: "Weekly menu", channel: "whatsapp", content_type: "social_post", generation_count: 0, content_item_id: null }],
      campaigns: [campaign("active")],
      brands: [{ languages: ["te", "en"] }],
    });
    const res = await call("POST", `/topics/${TOPIC}/generate`, undefined, { "idempotency-key": "topic-gen-1" });
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/can't be generated for whatsapp/);
  });

  it("won't edit a topic that is being generated", async () => {
    const { call } = setup("editor", { campaign_topics: [{ id: TOPIC, campaign_id: CAMP, status: "in_production" }] });
    expect((await call("PATCH", `/topics/${TOPIC}`, { title: "x" })).status).toBe(409);
  });

  it("validates planner ranges", async () => {
    const { call } = setup("viewer", {});
    expect((await call("GET", "/plan?from=2027-02-01&to=2027-01-01")).status).toBe(422);
  });
});
