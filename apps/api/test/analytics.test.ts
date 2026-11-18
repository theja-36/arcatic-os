import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { ApiDeps, Membership } from "../src/types.js";
import { fakeDb } from "./fake-db.js";

const WS = "11111111-1111-4111-8111-111111111111";
const BRAND = "33333333-3333-4333-8333-333333333333";
const INS = "99999999-9999-4999-8999-999999999999";
const KEY = randomBytes(32).toString("base64");
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

function setup(role: Membership["role"], tables: Record<string, unknown[]>, rpc: Record<string, unknown> = {}, fetchImpl?: typeof fetch) {
  const user = fakeDb(tables, rpc);
  const svc = fakeDb(tables, rpc);
  const analyticsSync = vi.fn(async () => "wf");
  const deps: ApiDeps = {
    corsOrigins: [], verifyJwt: async () => ({ sub: "u1" }), resolveApiKey: async () => null, resolveMembership: async () => ({ role, brandRestricted: false }),
    userDb: () => user.db, serviceDb: () => svc.db, jobs: (async () => ({ analyticsSync })) as never, encryptionKey: KEY, fetchImpl, resolveHost: async () => ["93.184.216.34"],
  };
  const app = buildApp(deps);
  const call = (method: string, path: string, payload?: unknown) =>
    app.request(`/v1/workspaces/${WS}${path}`, { method, body: payload === undefined ? undefined : JSON.stringify(payload), headers: { authorization: "Bearer t", "content-type": "application/json" } });
  return { call, svc, analyticsSync };
}

const perf = (i: number, ch: string, er: number, seenN = 1000) => ({
  schedule_id: `00000000-0000-4000-8000-00000000000${i}`, content_item_id: `c${i}`, campaign_id: null, topic_id: null, channel: ch, kind: "post", published_at: ago(5 + i), external_url: `https://x.test/${i}`,
  impressions: seenN, reach: null, video_views: null, engagements: Math.round(er * seenN), likes: null, comments: null, shares: null, saves: null, clicks: 3, unique_clicks: null, opens: null, sends: null, failed: null, conversions: null,
});

describe("analytics API", () => {
  it("overview: per-channel totals, engagement rate, top and bottom posts within channel", async () => {
    const rows = [perf(1, "instagram", 0.03), perf(2, "instagram", 0.032), perf(3, "instagram", 0.028), perf(4, "instagram", 0.09), perf(5, "instagram", 0.005), perf(6, "x", 0.01)];
    const { call } = setup("viewer", { content_items: rows.map((r) => ({ id: r.content_item_id, title: `Post ${r.content_item_id}`, type: "social_post" })), performance_metrics: [] }, { post_performance: rows });
    const res = await call("GET", `/brands/${BRAND}/analytics/overview?period=30d`);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.social.current).toMatchObject({ posts: 6, seen: 6000, interactions: 195 });
    expect(j.social.byChannel.map((c: { channel: string }) => c.channel)).toEqual(["instagram", "x"]);
    expect(j.top[0]).toMatchObject({ title: "Post c4", channel: "instagram", url: "https://x.test/4" });
    expect(j.bottom[0].title).toBe("Post c5");
    expect(j.series).toHaveLength(30);
    expect(j.notes[0]).toMatch(/lifetime/);
  });

  it("breakdown by channel and rejects unknown dimensions", async () => {
    const rows = [perf(1, "instagram", 0.03), perf(2, "x", 0.01)];
    const { call } = setup("viewer", {}, { post_performance: rows });
    const j = await (await call("GET", `/brands/${BRAND}/analytics/breakdown?period=7d&by=channel`)).json();
    expect(j.data.map((d: { key: string; seen: number }) => [d.key, d.seen])).toEqual([["instagram", 1000], ["x", 1000]]);
    expect((await call("GET", `/brands/${BRAND}/analytics/breakdown?by=weather`)).status).toBe(422);
  });

  it("accepting a voice refinement returns merged Brand Kit ops to review; viewers can't decide; a dismissed one can't be accepted", async () => {
    const tables = {
      insights: [{ id: INS, kind: "voice_refinement", status: "new", guidance: null, evidence: { ops: { addBanned: ["unlock", "amazing"] } } }],
      brand_kit_versions: [{ version: 4, kit: { facts: { "vocabulary.banned": { value: ["cheap"] } } } }],
    };
    const { call, svc } = setup("editor", tables);
    const res = await call("POST", `/brands/${BRAND}/insights/${INS}/accept`);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.kit).toEqual({ baseVersion: 4, ops: [{ op: "set", path: "vocabulary.banned", value: ["cheap", "unlock", "amazing"] }] });
    expect(svc.ops.find((o) => o.table === "learning_signals")!.payload).toMatchObject({ signal: "insight_accept" });
    expect((await setup("viewer", tables).call("POST", `/brands/${BRAND}/insights/${INS}/accept`)).status).toBe(403);
    const dismissed = setup("editor", { insights: [{ id: INS, kind: "recommendation", status: "dismissed", evidence: {} }] });
    expect((await dismissed.call("POST", `/brands/${BRAND}/insights/${INS}/accept`)).status).toBe(409);
  });

  it("Matomo: HTTPS only, token checked, stored encrypted", async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const token = new URLSearchParams(String(init.body)).get("token_auth");
      return new Response(JSON.stringify(token === "good-token-1234567890" ? { "2026-11-17": { nb_visits: 3 } } : { result: "error", message: "token_auth is invalid" }));
    }) as unknown as typeof fetch;
    const tables = { integration_secrets: [{ id: "sec" }], analytics_connections: [], brands: [{ id: BRAND }] };
    expect((await setup("admin", tables, {}, fetchImpl).call("PUT", "/analytics/connections/matomo", { baseUrl: "http://stats.example.com", siteId: "1", token: "good-token-1234567890" })).status).toBe(422);
    expect((await setup("admin", tables, {}, fetchImpl).call("PUT", "/analytics/connections/matomo", { baseUrl: "https://stats.example.com", siteId: "1", token: "bad-token-12345678901" })).status).toBe(422);
    const ok = setup("admin", { ...tables, analytics_connections: [{ id: "conn", provider: "matomo" }] }, {}, fetchImpl);
    const res = await ok.call("PUT", "/analytics/connections/matomo", { baseUrl: "https://stats.example.com/index.php", siteId: "1", token: "good-token-1234567890" });
    expect(res.status).toBe(201);
    const secret = ok.svc.ops.find((o) => o.table === "integration_secrets" && o.op === "insert")!.payload as { ciphertext: string; purpose: string };
    expect(secret.purpose).toBe("matomo_token");
    expect(secret.ciphertext).not.toContain("good-token");
  });

  it("feedback becomes a learning signal; sync starts one workflow per hour", async () => {
    const { call, svc, analyticsSync } = setup("reviewer", { content_items: [{ id: "c1", current_version_id: "v1" }], content_versions: [{ prompt_template: "social.post@1", model: "claude-opus-5-5" }] });
    expect((await call("POST", `/brands/${BRAND}/content/c1/feedback`, {})).status).toBe(422);
    expect((await call("POST", `/brands/${BRAND}/content/c1/feedback`, { rating: 2, note: "Too salesy" })).status).toBe(201);
    expect(svc.ops.find((o) => o.table === "learning_signals")!.payload).toMatchObject({ signal: "rating", value: 2, prompt_template: "social.post@1" });
    expect((await call("POST", "/analytics/sync")).status).toBe(202);
    expect(analyticsSync).toHaveBeenCalledWith({ workspaceId: WS }, expect.stringMatching(/^\d{10}$/));
  });
});
