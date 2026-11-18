import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { emptyKit } from "@arcatic/core";
import type { ApiDeps, Membership } from "../src/types.js";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/** Chainable stand-in for a supabase-js query builder that resolves to `result`. */
function fakeDb(result: unknown = { data: [], error: null }) {
  const builder: any = new Proxy(() => undefined, {
    get: (_t, prop) => (prop === "then" ? (res: (v: unknown) => void) => res(result) : () => builder),
    apply: () => builder,
  });
  return { from: () => builder, rpc: () => builder, storage: { from: () => builder } } as any;
}

function deps(over: Partial<ApiDeps> = {}, membership: Membership | null = { role: "viewer", brandRestricted: false }): ApiDeps {
  return {
    corsOrigins: ["http://localhost:3000"],
    verifyJwt: async (t) => (t === "good" ? { sub: "user-1" } : null),
    resolveApiKey: async (k) =>
      k === "ak_live_x.ok" ? { kind: "api_key", keyId: "k1", workspaceId: WS, role: "editor", scopes: ["brand.read"] } : null,
    resolveMembership: async (ws) => (ws === WS ? membership : null),
    userDb: () => fakeDb(),
    serviceDb: () => fakeDb(),
    jobs: vi.fn(async () => {
      throw new Error("not in tests");
    }),
    ...over,
  };
}

const call = (app: ReturnType<typeof buildApp>, path: string, init: RequestInit & { token?: string } = {}) =>
  app.request(path, { ...init, headers: { ...(init.token && { authorization: `Bearer ${init.token}` }), "content-type": "application/json", ...(init.headers ?? {}) } });

describe("api", () => {
  it("health is public", async () => {
    const res = await call(buildApp(deps()), "/health");
    expect(res.status).toBe(200);
  });

  it("rejects missing and invalid tokens with the error envelope", async () => {
    const app = buildApp(deps());
    const a = await call(app, "/v1/workspaces");
    expect(a.status).toBe(401);
    const body = await a.json();
    expect(body.error.code).toBe("unauthenticated");
    expect(body.error.request_id).toBeTruthy();
    expect((await call(app, "/v1/workspaces", { token: "bad" })).status).toBe(401);
  });

  it("hides workspaces the caller does not belong to (404, not 403)", async () => {
    const res = await call(buildApp(deps()), `/v1/workspaces/${OTHER}/brands`, { token: "good" });
    expect(res.status).toBe(404);
  });

  it("enforces role permissions", async () => {
    const app = buildApp(deps());
    expect((await call(app, `/v1/workspaces/${WS}/brands`, { token: "good" })).status).toBe(200);
    const res = await call(app, `/v1/workspaces/${WS}/brands`, { token: "good", method: "POST", body: JSON.stringify({ name: "X" }) });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
  });

  it("API keys are bound to their workspace and narrowed by scopes", async () => {
    const app = buildApp(deps());
    expect((await call(app, `/v1/workspaces/${WS}/brands`, { token: "ak_live_x.ok" })).status).toBe(200);
    expect((await call(app, `/v1/workspaces/${OTHER}/brands`, { token: "ak_live_x.ok" })).status).toBe(404);
    expect((await call(app, `/v1/workspaces/${WS}/members`, { token: "ak_live_x.ok" })).status).toBe(403);
    expect((await call(app, "/v1/me", { token: "ak_live_x.ok" })).status).toBe(403);
  });

  it("validates bodies with field-level details", async () => {
    const app = buildApp(deps({}, { role: "owner", brandRestricted: false }));
    const res = await call(app, `/v1/workspaces/${WS}/brands`, { token: "good", method: "POST", body: JSON.stringify({ name: "" }) });
    expect(res.status).toBe(422);
    expect((await res.json()).error.details[0].path).toBe("name");
  });

  it("requires an Idempotency-Key to start jobs", async () => {
    const app = buildApp(deps({}, { role: "editor", brandRestricted: false }));
    const res = await call(app, `/v1/workspaces/${WS}/jobs/self-test`, { token: "good", method: "POST", body: "{}" });
    expect(res.status).toBe(422);
  });

  it("does not let admins mint owner API keys", async () => {
    const app = buildApp(deps({}, { role: "admin", brandRestricted: false }));
    const res = await call(app, `/v1/workspaces/${WS}/api-keys`, { token: "good", method: "POST", body: JSON.stringify({ name: "ci", role: "owner" }) });
    expect(res.status).toBe(422);
  });

  it("returns the error envelope for unknown routes", async () => {
    const res = await call(buildApp(deps()), "/nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  describe("brand kit", () => {
    const BRAND = "33333333-3333-4333-8333-333333333333";
    // one fake row that satisfies both the brand lookup and the latest-version lookup
    const row = { id: BRAND, name: "Annapurna", languages: ["en"], website_url: null, active_kit_version_id: null, kit_completeness: 0, version: 3, status: "draft", kit: { ...emptyKit(BRAND, "Annapurna"), version: 3 } };
    const kitDeps = (role: Membership["role"]) =>
      deps({ userDb: () => fakeDb({ data: row, error: null }), resolveHost: async (h) => (h === "internal.example" ? ["10.0.0.4"] : ["93.184.216.34"]) }, { role, brandRestricted: false });
    const post = (app: ReturnType<typeof buildApp>, path: string, payload: unknown, headers: Record<string, string> = {}) =>
      call(app, `/v1/workspaces/${WS}/brands/${BRAND}${path}`, { token: "good", method: "POST", body: JSON.stringify(payload), headers });

    it("rejects edits based on a stale version with 409", async () => {
      const res = await post(buildApp(kitDeps("editor")), "/kit/ops", { baseVersion: 2, ops: [{ op: "set", path: "oneLiner", value: "Hi" }] });
      expect(res.status).toBe(409);
      expect((await res.json()).error.details.latestVersion).toBe(3);
    });

    it("rejects unknown kit fields before touching the database", async () => {
      const res = await post(buildApp(kitDeps("editor")), "/kit/ops", { baseVersion: 3, ops: [{ op: "set", path: "admin.flag", value: true }] });
      expect(res.status).toBe(422);
    });

    it("lets viewers read but not edit or approve", async () => {
      const app = buildApp(kitDeps("viewer"));
      expect((await call(app, `/v1/workspaces/${WS}/brands/${BRAND}/kit`, { token: "good" })).status).toBe(200);
      expect((await post(app, "/kit/ops", { baseVersion: 3, ops: [] })).status).toBe(403);
      expect((await post(app, "/kit/versions/3/approve", {})).status).toBe(403);
    });

    it("requires an ownership attestation before analysing a website", async () => {
      const res = await post(buildApp(kitDeps("editor")), "/kit/analyze-website", { url: "https://annapurna.in" }, { "idempotency-key": "abcdefgh1" });
      expect(res.status).toBe(422);
      expect(JSON.stringify(await res.json())).toMatch(/authorised to analyse/);
    });

    it("refuses to analyse internal addresses (SSRF)", async () => {
      const res = await post(buildApp(kitDeps("editor")), "/kit/analyze-website", { url: "https://internal.example", attestOwnership: true }, { "idempotency-key": "abcdefgh2" });
      expect(res.status).toBe(422);
      expect((await res.json()).error.message).toMatch(/private or reserved/);
    });

    it("returns the latest kit with completeness", async () => {
      const res = await call(buildApp(kitDeps("editor")), `/v1/workspaces/${WS}/brands/${BRAND}/kit`, { token: "good" });
      const body = await res.json();
      expect(body.version).toBe(3);
      expect(body.completeness).toMatchObject({ score: 0 });
    });
  });
});
