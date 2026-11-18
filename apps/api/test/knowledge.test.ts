import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { sourceCost } from "../src/routes/knowledge.js";
import { safeFetchBytes } from "../src/safe-fetch.js";
import type { ApiDeps, Membership } from "../src/types.js";

const WS = "11111111-1111-4111-8111-111111111111";
const BRAND = "33333333-3333-4333-8333-333333333333";

function fakeDb(result: unknown = { data: { id: BRAND }, error: null }) {
  const builder: any = new Proxy(() => undefined, {
    get: (_t, prop) => (prop === "then" ? (res: (v: unknown) => void) => res(result) : () => builder),
    apply: () => builder,
  });
  return { from: () => builder, rpc: () => builder, storage: { from: () => builder } } as any;
}

const resolveHost = async (h: string) => (h.endsWith(".internal.test") ? ["10.1.2.3"] : ["93.184.216.34"]);
const png = () => {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, 800);
  new DataView(b.buffer).setUint32(20, 600);
  return b;
};

function deps(role: Membership["role"], over: Partial<ApiDeps> = {}): ApiDeps {
  return {
    corsOrigins: [],
    verifyJwt: async () => ({ sub: "user-1" }),
    resolveApiKey: async () => null,
    resolveMembership: async () => ({ role, brandRestricted: false }),
    userDb: () => fakeDb(),
    serviceDb: () => fakeDb({ data: null, error: null }),
    jobs: vi.fn(async () => { throw new Error("no temporal in tests"); }),
    resolveHost,
    ...over,
  };
}
const req = (app: ReturnType<typeof buildApp>, path: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.request(`/v1/workspaces/${WS}${path}`, { method: "POST", body: JSON.stringify(payload), headers: { authorization: "Bearer t", "content-type": "application/json", ...headers } });

describe("knowledge routes", () => {
  it("requires an Idempotency-Key to add a source", async () => {
    const res = await req(buildApp(deps("editor")), `/brands/${BRAND}/sources`, { type: "text", title: "Notes", body: "hello" });
    expect(res.status).toBe(422);
  });
  it("refuses URLs that resolve to private addresses", async () => {
    const res = await req(buildApp(deps("editor")), `/brands/${BRAND}/sources`, { type: "url", url: "https://wiki.internal.test/page" }, { "idempotency-key": "k-0000001" });
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/private or reserved/);
  });
  it("blocks viewers from adding sources and validates per-type fields", async () => {
    expect((await req(buildApp(deps("viewer")), `/brands/${BRAND}/sources`, { type: "text", title: "x", body: "y" }, { "idempotency-key": "k-0000002" })).status).toBe(403);
    const bad = await req(buildApp(deps("editor")), `/brands/${BRAND}/sources`, { type: "crawl", url: "https://x.in", limit: 5000 }, { "idempotency-key": "k-0000003" });
    expect(bad.status).toBe(422);
  });
  it("reserves for the worst case per source type", () => {
    expect(sourceCost({ type: "crawl", url: "https://x.in", limit: 25, tags: [], visibility: "brand" })).toEqual({ estimate: 2.5, max: 3.75 });
    expect(sourceCost({ type: "media", mediaAssetId: BRAND, language: "auto", maxMinutes: 60, tags: [], visibility: "brand" })).toEqual({ estimate: 15, max: 45 });
    expect(sourceCost({ type: "drive" }, 100_000_000).max).toBe(22.5);   // capped at 300 pages
    expect(sourceCost({ type: "text", title: "t", body: "x".repeat(6001), tags: [], visibility: "brand" }).estimate).toBe(0.15);
  });
});

describe("media URL import", () => {
  it("re-checks every redirect hop (no SSRF via redirect)", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://metadata.internal.test/latest" } }));
    const res = await req(buildApp(deps("editor", { fetchImpl: fetchImpl as never })), "/media/import-url", { url: "https://cdn.example.com/logo.png" });
    expect(res.status).toBe(422);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects SVG and non-images by content, not extension", async () => {
    const svg = vi.fn(async () => new Response("<svg onload=alert(1)></svg>", { status: 200 }));
    expect((await (await req(buildApp(deps("editor", { fetchImpl: svg as never })), "/media/import-url", { url: "https://cdn.example.com/logo.png" })).json()).error.message).toMatch(/SVG/);
    const html = vi.fn(async () => new Response("<!doctype html><html></html>", { status: 200 }));
    expect((await req(buildApp(deps("editor", { fetchImpl: html as never })), "/media/import-url", { url: "https://cdn.example.com/a.jpg" })).status).toBe(422);
  });
  it("imports a real image with its dimensions", async () => {
    const f = vi.fn(async () => new Response(png(), { status: 200, headers: { "content-type": "image/png" } }));
    const res = await req(buildApp(deps("editor", { fetchImpl: f as never })), "/media/import-url", { url: "https://cdn.example.com/hero.png" });
    expect(res.status).toBe(201);
  });
});

describe("safeFetchBytes", () => {
  it("enforces the size cap while streaming even without content-length", async () => {
    const stream = new ReadableStream({ start(ctl) { for (let i = 0; i < 10; i++) ctl.enqueue(new Uint8Array(1000)); ctl.close(); } });
    const f = async () => new Response(stream, { status: 200 });
    await expect(safeFetchBytes("https://x.example.com/big", { resolve: resolveHost, maxBytes: 5000, fetchImpl: f as never })).rejects.toThrow(/larger than/);
  });
  it("follows safe redirects", async () => {
    let n = 0;
    const f = async () => (n++ === 0 ? new Response(null, { status: 301, headers: { location: "/final.png" } }) : new Response(png()));
    const r = await safeFetchBytes("https://x.example.com/a", { resolve: resolveHost, maxBytes: 10_000, fetchImpl: f as never });
    expect(r.finalUrl).toBe("https://x.example.com/final.png");
  });
});
