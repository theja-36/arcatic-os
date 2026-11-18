import { addClip, emptyTimeline } from "@arcatic/core";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { renderCost } from "../src/routes/video.js";
import type { ApiDeps, Membership } from "../src/types.js";
import { fakeDb } from "./fake-db.js";

const WS = "11111111-1111-4111-8111-111111111111";
const BRAND = "33333333-3333-4333-8333-333333333333";
const P = "99999999-9999-4999-8999-999999999999";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function setup(role: Membership["role"], tables: Record<string, unknown[]>, updates: Record<string, unknown[]> = {}) {
  const user = fakeDb(tables, {}, updates);
  const svc = fakeDb(tables, { reserve_credits: { id: "r1", amount: 0.75, status: "held" } }, updates);
  const renderVideo = vi.fn(async () => undefined);
  const deps: ApiDeps = {
    corsOrigins: [], verifyJwt: async () => ({ sub: "u1" }), resolveApiKey: async () => null, resolveMembership: async () => ({ role, brandRestricted: false }),
    userDb: () => user.db, serviceDb: () => svc.db, jobs: (async () => ({ renderVideo, probeMedia: vi.fn() })) as never,
  };
  const app = buildApp(deps);
  const call = (method: string, path: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.request(`/v1/workspaces/${WS}/brands/${BRAND}${path}`, { method, body: payload === undefined ? undefined : JSON.stringify(payload), headers: { authorization: "Bearer t", "content-type": "application/json", ...headers } });
  return { call, svc, renderVideo };
}
const tl = addClip(emptyTimeline("instagram-reel"), { assetId: A, kind: "video", inMs: 0, outMs: 30_000, sourceDurationMs: 30_000, hasAudio: true, volume: 1, muted: false, fit: "cover", fadeIn: false });

describe("video projects API", () => {
  it("costs: previews free, finals per started minute", () => {
    expect(renderCost(95_000, "preview")).toEqual({ estimate: 0, max: 0 });
    expect(renderCost(95_000, "final")).toEqual({ estimate: 1, max: 1.5 });
    expect(renderCost(10_000, "final")).toEqual({ estimate: 0.5, max: 0.75 });
  });
  it("won't render an empty or invalid timeline", async () => {
    const { call, renderVideo } = setup("editor", { video_projects: [{ id: P, status: "draft", revision: 1, timeline: emptyTimeline("instagram-reel"), title: "x" }] });
    const res = await call("POST", `/video-projects/${P}/render`, { mode: "final" }, { "idempotency-key": "render-0001" });
    expect(res.status).toBe(422);
    expect(renderVideo).not.toHaveBeenCalled();
  });
  it("rejects timelines that reference files from elsewhere", async () => {
    const { call } = setup("editor", { video_projects: [{ id: P, status: "draft", revision: 1, timeline: tl, title: "x" }], media_assets: [] });
    const res = await call("PUT", `/video-projects/${P}/timeline`, { revision: 1, timeline: tl });
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/aren't in this workspace/);
  });
  it("refuses a second render while one runs, and sending a stale render", async () => {
    const { call } = setup("editor", { video_projects: [{ id: P, status: "rendering", revision: 2, timeline: tl, title: "x" }] });
    expect((await call("POST", `/video-projects/${P}/render`, { mode: "preview" }, { "idempotency-key": "render-0002" })).status).toBe(409);
    const { call: c2 } = setup("editor", { video_projects: [{ id: P, status: "draft", revision: 3, rendered_revision: 2, output_asset_id: A, timeline: tl, title: "x" }] });
    expect((await c2("POST", `/video-projects/${P}/send-to-content`, { channel: "instagram" })).status).toBe(409);
  });
  it("starts a final render, marks the project rendering, viewers can't", async () => {
    const { call, svc, renderVideo } = setup("editor", { video_projects: [{ id: P, status: "draft", revision: 4, timeline: tl, title: "x" }] });
    expect((await call("POST", `/video-projects/${P}/render`, { mode: "final" }, { "idempotency-key": "render-0003" })).status).toBe(202);
    expect(renderVideo).toHaveBeenCalledWith(expect.objectContaining({ projectId: P, revision: 4, mode: "final" }));
    expect(svc.ops.find((o) => o.table === "video_projects" && o.op === "update")?.payload).toMatchObject({ status: "rendering" });
    const { call: viewer } = setup("viewer", { video_projects: [{ id: P, status: "draft", revision: 4, timeline: tl, title: "x" }] });
    expect((await viewer("POST", `/video-projects/${P}/render`, { mode: "final" }, { "idempotency-key": "render-0004" })).status).toBe(403);
  });
});
