import { emptyKit, compileBrandContext, docFrom } from "@arcatic/core";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { contentCost } from "../src/routes/content.js";
import type { ApiDeps, Membership } from "../src/types.js";
import { fakeDb } from "./fake-db.js";

const WS = "11111111-1111-4111-8111-111111111111";
const BRAND = "33333333-3333-4333-8333-333333333333";
const ITEM = "88888888-8888-4888-8888-888888888888";

function setup(role: Membership["role"], tables: Record<string, unknown[]> = {}, starter: Record<string, unknown> = {}) {
  const user = fakeDb(tables);
  const svc = fakeDb(tables);
  const generateContent = vi.fn(async () => undefined);
  const generateImage = vi.fn(async () => undefined);
  const deps: ApiDeps = {
    corsOrigins: [], verifyJwt: async () => ({ sub: "u1" }), resolveApiKey: async () => null,
    resolveMembership: async () => ({ role, brandRestricted: false }), userDb: () => user.db, serviceDb: () => svc.db,
    jobs: (async () => ({ generateContent, generateImage, ...starter })) as never,
  };
  const app = buildApp(deps);
  const call = (method: string, path: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.request(`/v1/workspaces/${WS}/brands/${BRAND}${path}`, { method, body: payload === undefined ? undefined : JSON.stringify(payload), headers: { authorization: "Bearer t", "content-type": "application/json", ...headers } });
  return { call, svc, generateContent, generateImage };
}
const idem = { "idempotency-key": "content-key-1" };

describe("content generation API", () => {
  it("validates template inputs before reserving credits", async () => {
    const { call, svc } = setup("editor");
    const res = await call("POST", "/content", { type: "email", input: { topic: "x" } }, idem);   // topic too short
    expect(res.status).toBe(422);
    expect((await res.json()).error.details[0].path).toBe("topic");
    expect(svc.ops.some((o) => o.op === "rpc")).toBe(false);
  });

  it("requires a size and layout for visual posts", async () => {
    const { call } = setup("editor");
    expect((await call("POST", "/content", { type: "static_visual", input: { topic: "Diwali sweets box" } }, idem)).status).toBe(422);
  });

  it("refuses unsafe or unlicensed image requests", async () => {
    const { call } = setup("editor", { ai_models: [{ key: "flux.1-dev", enabled: false, commercial_use: false, kind: "image" }] });
    const unsafe = await call("POST", "/content", { type: "image", image: { prompt: "nude model eating dosa" } }, idem);
    expect((await unsafe.json()).error.message).toMatch(/isn't allowed/);
    const unlicensed = await call("POST", "/content", { type: "image", image: { prompt: "idli on a banana leaf", modelKey: "flux.1-dev" } }, idem);
    expect((await unlicensed.json()).error.message).toMatch(/commercial use/);
  });

  it("viewers can't generate", async () => {
    const { call } = setup("viewer");
    expect((await call("POST", "/content", { type: "social_post", input: { topic: "Breakfast menu" } }, idem)).status).toBe(403);
  });

  it("previews costs by type, tier, count and mode", async () => {
    expect(contentCost("blog")).toEqual({ estimate: 8, max: 12 });
    expect(contentCost("blog", { modelTier: "premium" })).toEqual({ estimate: 24, max: 36 });
    expect(contentCost("image", { count: 3 })).toEqual({ estimate: 12, max: 18 });
    expect(contentCost("email", { mode: "transform" })).toEqual({ estimate: 0.5, max: 0.75 });
    const { call } = setup("viewer");
    const res = await call("POST", "/content/estimate", { type: "x_thread" });
    expect(await res.json()).toEqual({ estimate: 2, max: 3 });
  });
});

describe("editing & approvals API", () => {
  const item = { id: ITEM, brand_id: BRAND, type: "social_post", channel: "instagram", status: "draft", current_version_id: "v3", language: "en" };
  it("rejects saves based on an old version", async () => {
    const { call } = setup("editor", { content_items: [item], content_versions: [{ id: "v3", version: 3, body: { format: 1, doc: docFrom([["hook", "a"]]) } }] });
    const res = await call("POST", `/content/${ITEM}/versions`, { baseVersion: 2, doc: docFrom([["hook", "b"]]) });
    expect(res.status).toBe(409);
    expect((await res.json()).error.details.latestVersion).toBe(3);
  });

  it("validates human edits and records a learning signal", async () => {
    const brand = await compileBrandContext({ ...emptyKit(BRAND, "A"), facts: { "vocabulary.banned": { id: "vocabulary.banned", value: ["cheap"], status: "approved", origin: "human", sources: [] } } });
    const { call, svc } = setup("editor", {
      content_items: [item], content_versions: [{ id: "v3", version: 3, body: { format: 1, doc: docFrom([["hook", "Fresh idli"], ["cta", "Order now"]]) } }],
      brands: [{ active_kit_version_id: "kv" }], brand_contexts: [{ context: brand }],
    });
    const res = await call("POST", `/content/${ITEM}/versions`, { baseVersion: 3, doc: docFrom([["hook", "Cheap idli"], ["cta", "Order now"]]) });
    expect(res.status).toBe(201);
    const out = await res.json();
    expect(out.validation.passed).toBe(false);
    const inserted = svc.ops.find((o) => o.table === "content_versions" && o.op === "insert")!.payload as { origin: string; version: number; body: { doc: { blocks: Array<{ origin: string }> } } };
    expect(inserted).toMatchObject({ origin: "human", version: 4 });
    expect(inserted.body.doc.blocks[0]!.origin).toBe("human");
    expect(svc.ops.find((o) => o.table === "learning_signals")?.payload).toMatchObject({ signal: "edit", edit_class: "headline,wording" });
  });

  it("asks for a comment when requesting changes, and only reviewers can decide", async () => {
    const { call } = setup("reviewer", { approvals: [{ id: "a1", status: "pending" }], workspaces: [{ settings: {} }] });
    expect((await call("POST", "/approvals/a1/decide", { decision: "changes_requested" })).status).toBe(422);
    const { call: contributor } = setup("contributor", { approvals: [{ id: "a1", status: "pending" }] });
    expect((await contributor("POST", "/approvals/a1/decide", { decision: "approved" })).status).toBe(403);
  });

  it("won't rewrite images", async () => {
    const { call } = setup("editor", { content_items: [{ ...item, type: "image" }] });
    expect((await call("POST", `/content/${ITEM}/regenerate`, {}, idem)).status).toBe(422);
  });
});
