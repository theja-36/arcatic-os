import { describe, expect, it, vi } from "vitest";
import { FirecrawlClient } from "../src/firecrawl.js";
import { HttpClient } from "../src/http.js";
import { PostizClient } from "../src/postiz.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("HttpClient", () => {
  it("retries idempotent requests on 503 then succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(503, {})).mockResolvedValueOnce(json(200, { ok: 1 }));
    const c = new HttpClient({ baseUrl: "http://svc", service: "svc", fetchImpl: f as any });
    await expect(c.request("GET", "/x")).resolves.toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("does not retry non-idempotent POST", async () => {
    const f = vi.fn().mockResolvedValue(json(503, {}));
    const c = new HttpClient({ baseUrl: "http://svc", service: "svc", fetchImpl: f as any });
    await expect(c.request("POST", "/x", {}, { idempotent: false })).rejects.toMatchObject({ code: "upstream_error", retryable: true });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("maps 4xx to non-retryable errors", async () => {
    const f = vi.fn().mockResolvedValue(json(400, { msg: "bad" }));
    const c = new HttpClient({ baseUrl: "http://svc", service: "svc", fetchImpl: f as any });
    await expect(c.request("GET", "/x")).rejects.toMatchObject({ retryable: false });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("PostizClient", () => {
  it("uses the /public/v1 prefix and raw API key header", async () => {
    const f = vi.fn().mockResolvedValue(json(200, [{ id: "i1", name: "Shop", identifier: "instagram" }]));
    const c = new PostizClient({ baseUrl: "http://postiz/api", apiKey: "org-key", fetchImpl: f as any });
    await c.listIntegrations();
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("http://postiz/api/public/v1/integrations");
    expect(init.headers.authorization).toBe("org-key");
  });
});

describe("FirecrawlClient", () => {
  it("posts to /v2/scrape with markdown defaults", async () => {
    const f = vi.fn().mockResolvedValue(json(200, { success: true, data: { markdown: "# Hi" } }));
    const c = new FirecrawlClient({ baseUrl: "http://fc:3002", fetchImpl: f as any });
    const r = await c.scrape("https://example.com");
    expect(r.data?.markdown).toBe("# Hi");
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("http://fc:3002/v2/scrape");
    expect(JSON.parse(init.body)).toMatchObject({ url: "https://example.com", formats: ["markdown"], onlyMainContent: true });
  });
});

import { MauticClient, WordpressClient } from "../src/index.js";

describe("WordpressClient", () => {
  it("uses Basic auth, refuses redirects and posts JSON to /wp-json/wp/v2/posts", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 7, link: "https://blog.example.com/hello", status: "publish" }), { status: 201 });
    }) as unknown as typeof fetch;
    const wp = new WordpressClient({ siteUrl: "https://blog.example.com/", username: "editor", appPassword: "abcd efgh" }, { fetchImpl });
    const r = await wp.createPost({ title: "Hello", content: "<p>x</p>", status: "publish", featured_media: 3 });
    expect(r.link).toBe("https://blog.example.com/hello");
    expect(calls[0]!.url).toBe("https://blog.example.com/wp-json/wp/v2/posts");
    expect(calls[0]!.init.redirect).toBe("error");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("editor:abcd efgh").toString("base64")}`);
  });
  it("doesn't retry a failed post creation (would duplicate)", async () => {
    let n = 0;
    const fetchImpl = (async () => { n++; return new Response("oops", { status: 502 }); }) as unknown as typeof fetch;
    const wp = new WordpressClient({ siteUrl: "https://blog.example.com", username: "u", appPassword: "p" }, { fetchImpl });
    await expect(wp.createPost({ title: "T", content: "c", status: "publish" })).rejects.toMatchObject({ retryable: true });
    expect(n).toBe(1);
  });
});

describe("MauticClient", () => {
  it("reads segments keyed by id and creates a segment email", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as string | undefined });
      if (url.endsWith("/emails/new")) return new Response(JSON.stringify({ email: { id: 42 } }), { status: 201 });
      return new Response(JSON.stringify({ total: 1, lists: { "5": { id: 5, name: "Customers" } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const m = new MauticClient({ baseUrl: "https://mautic.example.com", username: "api", password: "pw" }, { fetchImpl });
    expect(await m.segments()).toEqual([{ id: 5, name: "Customers", alias: undefined, isPublished: undefined }]);
    const e = await m.createSegmentEmail({ name: "Diwali", subject: "Sale", customHtml: "<p>x</p>", segmentIds: [5] });
    expect(e.email.id).toBe(42);
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({ emailType: "list", lists: [5], isPublished: true });
    expect(calls[1]!.url).toBe("https://mautic.example.com/api/emails/new");
  });
});

import { createHmac } from "node:crypto";
import { LagoClient, verifyLagoHmac } from "../src/index.js";

describe("LagoClient", () => {
  it("uses Bearer auth under /api/v1 and the documented request shapes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ subscription: { external_id: "ws1", plan_code: "arcatic_growth", status: "active" } })); }) as unknown as typeof fetch;
    const lago = new LagoClient({ baseUrl: "https://lago.example.com/", apiKey: "k", fetchImpl });
    await lago.assignPlan({ external_customer_id: "ws1", external_id: "ws1", plan_code: "arcatic_growth" });
    await lago.setEndingAt("ws1", "2026-12-01T00:00:00Z");
    await lago.oneOffInvoice({ external_customer_id: "ws1", currency: "INR", add_on_code: "arcatic_credits_200", units: 1, unit_amount_cents: 24900, description: "200 credits" });
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual(["POST https://lago.example.com/api/v1/subscriptions", "PUT https://lago.example.com/api/v1/subscriptions/ws1", "POST https://lago.example.com/api/v1/invoices"]);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(JSON.parse(String(calls[2]!.init.body)).invoice.fees[0]).toEqual({ add_on_code: "arcatic_credits_200", units: 1, unit_amount_cents: 24900, description: "200 credits" });
    expect(() => lago.sendEvents(Array.from({ length: 101 }, (_, i) => ({ transaction_id: String(i), external_subscription_id: "ws1", code: "c", timestamp: 1, properties: {} })))).toThrow(/100/);
  });
  it("verifies HMAC webhook signatures in constant time", () => {
    const body = JSON.stringify({ webhook_type: "invoice.created" });
    const sig = createHmac("sha256", "secret").update(body).digest("base64");
    expect(verifyLagoHmac(body, sig, "secret")).toBe(true);
    expect(verifyLagoHmac(body + " ", sig, "secret")).toBe(false);
    expect(verifyLagoHmac(body, sig, "other")).toBe(false);
    expect(verifyLagoHmac(body, null, "secret")).toBe(false);
  });
});
