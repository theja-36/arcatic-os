import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { repurposeCost } from "../src/routes/growth.js";
import type { ApiDeps, Membership } from "../src/types.js";
import { fakeDb } from "./fake-db.js";

const WS = "11111111-1111-4111-8111-111111111111";
const BRAND = "33333333-3333-4333-8333-333333333333";
const SRC = "44444444-4444-4444-8444-444444444444";
const CI = "55555555-5555-4555-8555-555555555555";
const PROJ = "66666666-6666-4666-8666-666666666666";

function setup(role: Membership["role"], tables: Record<string, unknown[]>) {
  const user = fakeDb(tables);
  const svc = fakeDb(tables, { reserve_credits: { id: "res1", amount: 20, status: "held" } });
  const repurpose = vi.fn(async () => undefined);
  const generateContent = vi.fn(async () => undefined);
  const deps: ApiDeps = {
    corsOrigins: [], verifyJwt: async () => ({ sub: "u1" }), resolveApiKey: async () => null, resolveMembership: async () => ({ role, brandRestricted: false }),
    userDb: () => user.db, serviceDb: () => svc.db, jobs: (async () => ({ repurpose, generateContent })) as never,
  };
  const app = buildApp(deps);
  const call = (method: string, path: string, payload?: unknown) => app.request(`/v1/workspaces/${WS}/brands/${BRAND}${path}`, {
    method, body: payload === undefined ? undefined : JSON.stringify(payload), headers: { authorization: "Bearer t", "content-type": "application/json", "idempotency-key": "key-0000000001" },
  });
  return { call, svc, repurpose, generateContent };
}

describe("repurposing API", () => {
  it("costs the digest plus each output at its normal price", () => {
    expect(repurposeCost(["instagram_post", "blog"])).toEqual({ estimate: 11, max: 16.5 });
  });

  it("starts one parent job for a ready source, with attribution recorded on the run", async () => {
    const { call, svc, repurpose } = setup("editor", {
      sources: [{ id: SRC, type: "media", title: "Kitchen tour", url: null, status: "ready" }], brands: [{ languages: ["te", "en"] }], repurpose_runs: [{ id: "run1" }],
    });
    const res = await call("POST", "/repurpose", { sourceId: SRC, outputs: ["instagram_post", "x_thread", "blog"] });
    expect(res.status).toBe(202);
    const run = svc.ops.find((o) => o.table === "repurpose_runs" && o.op === "insert")!.payload as Record<string, unknown>;
    expect(run).toMatchObject({ source_kind: "source", source_id: SRC, language: "te", source_ref: { kind: "source", id: SRC, title: "Kitchen tour", sourceType: "media" } });
    expect((run.outputs as Array<{ outputId: string; status: string }>).map((o) => o.outputId)).toEqual(["instagram_post", "x_thread", "blog"]);
    expect(repurpose).toHaveBeenCalledWith(expect.objectContaining({ runId: "run1", brandId: BRAND, chargeCredits: 13 }));
  });

  it("refuses a source that isn't ready, two sources at once, duplicate outputs, and viewers", async () => {
    const t = { sources: [{ id: SRC, type: "url", title: "Home", url: "https://x.test", status: "processing" }] };
    expect((await setup("editor", t).call("POST", "/repurpose", { sourceId: SRC, outputs: ["blog"] })).status).toBe(409);
    expect((await setup("editor", t).call("POST", "/repurpose", { sourceId: SRC, contentItemId: CI, outputs: ["blog"] })).status).toBe(422);
    expect((await setup("editor", { ...t, sources: [{ ...t.sources[0], status: "ready" }], repurpose_runs: [{ id: "r" }], brands: [{ languages: ["en"] }] }).call("POST", "/repurpose", { sourceId: SRC, outputs: ["blog", "blog"] })).status).toBe(422);
    expect((await setup("viewer", t).call("POST", "/repurpose", { sourceId: SRC, outputs: ["blog"] })).status).toBe(403);
  });
});

describe("ideas → drafts", () => {
  const ideasDoc = { format: 1, blocks: [
    { id: "b1", kind: "list_item", text: "Office Diwali boxes — gifting made easy", origin: "ai", meta: { index: 1, idea: { title: "Office Diwali boxes", angle: "gifting made easy", format: "carousel", channel: "linkedin", why: "B2B season" } } },
    { id: "b2", kind: "list_item", text: "Kitchen at 5am — behind the scenes", origin: "ai", meta: { index: 2, idea: { title: "Kitchen at 5am", angle: "behind the scenes", format: "short_video", channel: "instagram", why: "Trust" } } },
  ] };
  it("starts a draft per chosen idea with the right template and channel, filed in the list's project", async () => {
    const { call, generateContent } = setup("editor", {
      content_items: [{ id: CI, type: "brainstorm", language: "en", current_version_id: "v1", project_id: PROJ }], content_versions: [{ body: { doc: ideasDoc } }], projects: [{ id: PROJ, status: "active" }],
    });
    const res = await call("POST", `/content/${CI}/ideas/drafts`, { indexes: [1, 2, 9] });
    expect(res.status).toBe(202);
    const j = await res.json();
    expect(j.data.map((x: { type?: string; error?: unknown }) => x.type ?? "error")).toEqual(["carousel", "short_video", "error"]);
    expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({ templateKey: "social.carousel@1", projectId: PROJ, input: expect.objectContaining({ channel: "linkedin" }) }));
    expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({ templateKey: "video.script@1", input: expect.objectContaining({ format: "short" }) }));
  });
  it("only works on idea lists", async () => {
    const { call } = setup("editor", { content_items: [{ id: CI, type: "blog", language: "en", current_version_id: "v1" }] });
    expect((await call("POST", `/content/${CI}/ideas/drafts`, { indexes: [1] })).status).toBe(404);
  });
});

describe("projects", () => {
  it("editors create projects; viewers can't; generation into an unknown project is refused", async () => {
    const ok = setup("editor", { projects: [{ id: PROJ, name: "Diwali launch" }] });
    expect((await ok.call("POST", "/projects", { name: "Diwali launch" })).status).toBe(201);
    expect((await setup("viewer", {}).call("POST", "/projects", { name: "X" })).status).toBe(403);
    const gen = setup("editor", { projects: [] });
    expect((await gen.call("POST", "/content", { type: "document", input: { topic: "Return policy" }, projectId: PROJ })).status).toBe(404);
  });
});
