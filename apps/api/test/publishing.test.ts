import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { ApiDeps, Membership } from "../src/types.js";
import { fakeDb } from "./fake-db.js";

const WS = "11111111-1111-4111-8111-111111111111";
const BRAND = "33333333-3333-4333-8333-333333333333";
const OTHER_BRAND = "44444444-4444-4444-8444-444444444444";
const CI = "55555555-5555-4555-8555-555555555555";
const FB = "66666666-6666-4666-8666-666666666666";
const LI = "77777777-7777-4777-8777-777777777777";
const S1 = "88888888-8888-4888-8888-888888888888";
const KEY = randomBytes(32).toString("base64");

const doc = { format: 1, blocks: [{ id: "b1", kind: "body", text: "We open on Monday in Gachibowli!", origin: "human" }] };
const account = (id: string, channel: string, extra: Record<string, unknown> = {}) => ({
  id, workspace_id: WS, brand_id: null, channel, transport: "postiz", provider: `postiz:${channel}`, external_id: `pz-${channel}`, display_name: `@brand-${channel}`,
  status: "active", enabled: true, min_role: "editor", secret_id: null, settings: { identifier: channel }, ...extra,
});
const base = (accounts: unknown[], item: Record<string, unknown> = {}) => ({
  content_items: [{ id: CI, type: "social_post", title: "Opening", workspace_id: WS, brand_id: BRAND, status: "draft", approved_version_id: null, current_version_id: "v1", ...item }],
  content_versions: [{ id: "v1", body: { format: 1, doc }, media_asset_ids: [] }],
  connected_accounts: accounts,
  media_assets: [],
  schedules: [{ id: S1, revision: 0 }, { id: "s2", revision: 0 }],
  subscriptions: [{ plan: { limits: { max_connected_accounts: 5 } } }],
});

function setup(role: Membership["role"], tables: Record<string, unknown[]>, opts: { updates?: Record<string, unknown[]>; fetchImpl?: typeof fetch } = {}) {
  const user = fakeDb(tables, {}, opts.updates);
  const svc = fakeDb(tables, {}, opts.updates);
  const publishSchedule = vi.fn(async () => undefined);
  const deps: ApiDeps = {
    corsOrigins: [], verifyJwt: async () => ({ sub: "u1" }), resolveApiKey: async () => null, resolveMembership: async () => ({ role, brandRestricted: false }),
    userDb: () => user.db, serviceDb: () => svc.db, jobs: (async () => ({ publishSchedule })) as never,
    encryptionKey: KEY, postizUrl: "https://postiz.example.test/api", appUrl: "https://app.example.test", fetchImpl: opts.fetchImpl, resolveHost: async () => ["93.184.216.34"],
  };
  const app = buildApp(deps);
  const call = (method: string, path: string, payload?: unknown) =>
    app.request(`/v1/workspaces/${WS}${path}`, { method, body: payload === undefined ? undefined : JSON.stringify(payload), headers: { authorization: "Bearer t", "content-type": "application/json" } });
  return { call, svc, publishSchedule };
}
const at = () => new Date(Date.now() + 3_600_000).toISOString();

describe("publishing API", () => {
  it("crossposts to several accounts in one group, one workflow per target, and says approval is pending", async () => {
    const { call, svc, publishSchedule } = setup("editor", base([account(FB, "facebook"), account(LI, "linkedin")]));
    const res = await call("POST", `/brands/${BRAND}/content/${CI}/publish`, { publishAt: at(), targets: [{ accountId: FB }, { accountId: LI, text: "Custom LinkedIn text" }] });
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.approval).toMatch(/approved before/);
    const ins = svc.ops.find((o) => o.table === "schedules" && o.op === "insert")!.payload as Array<Record<string, unknown>>;
    expect(ins).toHaveLength(2);
    expect(ins[0]!.group_id).toBe(ins[1]!.group_id);
    expect(ins[1]!.text_override).toBe("Custom LinkedIn text");
    expect(publishSchedule).toHaveBeenCalledTimes(2);
    expect(publishSchedule).toHaveBeenCalledWith(S1, 0);
  });

  it("refuses targets that fail platform checks, with per-target messages", async () => {
    const { call, publishSchedule } = setup("editor", base([account(FB, "instagram")]));
    const res = await call("POST", `/brands/${BRAND}/content/${CI}/publish`, { publishAt: at(), targets: [{ accountId: FB }] });
    expect(res.status).toBe(422);
    expect(JSON.stringify((await res.json()).error.details)).toMatch(/Instagram needs at least one image or video/);
    expect(publishSchedule).not.toHaveBeenCalled();
  });

  it("enforces account permissions: other brand's account, admin-only account, viewers", async () => {
    const other = setup("editor", base([account(FB, "facebook", { brand_id: OTHER_BRAND })]));
    expect((await other.call("POST", `/brands/${BRAND}/content/${CI}/publish`, { publishAt: at(), targets: [{ accountId: FB }] })).status).toBe(422);
    const adminOnly = setup("editor", base([account(FB, "facebook", { min_role: "admin" })]));
    expect((await adminOnly.call("POST", `/brands/${BRAND}/content/${CI}/publish`, { publishAt: at(), targets: [{ accountId: FB }] })).status).toBe(403);
    const viewer = setup("viewer", base([account(FB, "facebook")]));
    expect((await viewer.call("POST", `/brands/${BRAND}/content/${CI}/publish`, { publishAt: at(), targets: [{ accountId: FB }] })).status).toBe(403);
  });

  it("won't schedule into the past or content types the channel can't take", async () => {
    const past = setup("editor", base([account(FB, "facebook")]));
    expect((await past.call("POST", `/brands/${BRAND}/content/${CI}/publish`, { publishAt: "2020-01-01T00:00:00Z", targets: [{ accountId: FB }] })).status).toBe(422);
    const blog = setup("editor", base([account(FB, "facebook")], { type: "blog" }));
    const r = await blog.call("POST", `/brands/${BRAND}/content/${CI}/publish`, { publishAt: at(), targets: [{ accountId: FB }] });
    expect(r.status).toBe(422);
    expect((await r.json()).error.message).toMatch(/can't publish this kind/);
  });

  it("retries a failed post by bumping the revision and starting a new workflow", async () => {
    const tables = { schedules: [{ id: S1, content_item_id: CI, connected_account_id: FB, publish_at: "2026-01-01T00:00:00Z", status: "failed", enabled: true, revision: 2 }] };
    const { call, publishSchedule } = setup("editor", tables, { updates: { schedules: [{ id: S1, status: "scheduled", enabled: true, revision: 3 }] } });
    expect((await call("POST", `/brands/${BRAND}/schedules/${S1}/retry`)).status).toBe(200);
    expect(publishSchedule).toHaveBeenCalledWith(S1, 3);
    const live = setup("editor", { schedules: [{ id: S1, status: "published", revision: 1 }] });
    expect((await live.call("POST", `/brands/${BRAND}/schedules/${S1}/retry`)).status).toBe(409);
  });

  it("Postiz connection: checks the key, stores it encrypted, mirrors supported channels", async () => {
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization;
      if (auth !== "good-key-123456") return new Response("{}", { status: 401 });
      if (url.endsWith("/public/v1/is-connected")) return new Response(JSON.stringify({ connected: true }));
      if (url.endsWith("/public/v1/integrations")) return new Response(JSON.stringify([
        { id: "i1", name: "Brand IG", identifier: "instagram-standalone", picture: "", disabled: false },
        { id: "i2", name: "Fediverse", identifier: "mastodon", disabled: false },
      ]));
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const bad = setup("admin", { subscriptions: [{ plan: { limits: {} } }] }, { fetchImpl });
    expect((await bad.call("PUT", "/publishing/connections/postiz", { apiKey: "wrong-key-000000" })).status).toBe(422);

    const good = setup("admin", { subscriptions: [{ plan: { limits: {} } }], integration_secrets: [{ id: "sec1" }], connected_accounts: [] }, { fetchImpl });
    const res = await good.call("PUT", "/publishing/connections/postiz", { apiKey: "good-key-123456" });
    expect(res.status).toBe(200);
    expect((await res.json()).sync).toMatchObject({ added: 1, unsupported: ["mastodon"] });
    const secret = good.svc.ops.find((o) => o.table === "integration_secrets" && o.op === "insert")!.payload as { ciphertext: string; purpose: string };
    expect(secret.purpose).toBe("postiz_api_key");
    expect(secret.ciphertext).not.toContain("good-key");
    const acc = good.svc.ops.find((o) => o.table === "connected_accounts" && o.op === "insert")!.payload as Record<string, unknown>;
    expect(acc).toMatchObject({ channel: "instagram", provider: "postiz:instagram-standalone", external_id: "i1", transport: "postiz" });
    const editor = setup("editor", {}, { fetchImpl });
    expect((await editor.call("PUT", "/publishing/connections/postiz", { apiKey: "good-key-123456" })).status).toBe(403);
  });

  it("WordPress sites must be public HTTPS", async () => {
    const { call } = setup("admin", { subscriptions: [{ plan: { limits: {} } }] });
    expect((await call("POST", "/connected-accounts/wordpress", { siteUrl: "http://blog.example.com", username: "u", appPassword: "abcd efgh ijkl" })).status).toBe(422);
    const priv = setup("admin", { subscriptions: [{ plan: { limits: {} } }] });
    const r = await priv.call("POST", "/connected-accounts/wordpress", { siteUrl: "https://intranet.local", username: "u", appPassword: "abcd efgh ijkl" });
    expect(r.status).toBe(422);
  });
});
