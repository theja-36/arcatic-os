import { describe, expect, it } from "vitest";
import { LangfuseClient, LangfuseTracer, MatomoClient, MauticClient, traceIdForJob } from "../src/index.js";

type Call = { url: string; init: RequestInit };
const recorder = (respond: (url: string) => Response) => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond(url); }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

describe("MatomoClient", () => {
  it("sends token_auth in the POST body, never in the URL, and reads per-day results", async () => {
    const r = recorder(() => new Response(JSON.stringify({ "2026-11-15": { nb_visits: 40, nb_uniq_visitors: 31 }, "2026-11-16": [] })));
    const m = new MatomoClient({ baseUrl: "https://stats.example.com/", token: "secret-token", siteId: "3", fetchImpl: r.fetchImpl });
    const v = await m.visits("2026-11-15", "2026-11-16");
    expect(v["2026-11-15"]).toMatchObject({ nb_visits: 40 });
    expect(r.calls[0]!.url).toContain("method=VisitsSummary.get");
    expect(r.calls[0]!.url).toContain("idSite=3");
    expect(r.calls[0]!.url).not.toContain("secret-token");
    expect(String(r.calls[0]!.init.body)).toBe("token_auth=secret-token");
    expect(r.calls[0]!.init.redirect).toBe("error");
  });
  it("turns Matomo's error JSON into a non-retryable error", async () => {
    const r = recorder(() => new Response(JSON.stringify({ result: "error", message: "You can't access this resource as it requires view access" })));
    await expect(new MatomoClient({ baseUrl: "https://s.example.com", token: "t", siteId: "1", fetchImpl: r.fetchImpl }).goals("2026-11-01", "2026-11-02")).rejects.toMatchObject({ retryable: false });
  });
});

describe("Langfuse", () => {
  it("exports a generation as an OTLP JSON span with Langfuse attributes and Basic auth", async () => {
    const r = recorder(() => new Response("{}", { status: 200 }));
    const lf = new LangfuseClient({ host: "https://langfuse.example.com", publicKey: "pk", secretKey: "sk", fetchImpl: r.fetchImpl });
    await new LangfuseTracer(lf).record({
      name: "social.post@1", workspaceId: "ws", jobId: "0b6d5c1e-6f2a-4d8b-9a1c-2f3e4d5c6b7a", template: "social.post@1", model: "claude-opus-5-5",
      input: { system: "BRAND CONTEXT", user: "Write a post" }, output: { hook: "Hi" }, usage: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 800, cacheWriteTokens: 0 },
      startedAt: new Date("2026-11-17T10:00:00Z"), endedAt: new Date("2026-11-17T10:00:03Z"),
    });
    expect(r.calls[0]!.url).toBe("https://langfuse.example.com/api/public/otel/v1/traces");
    expect((r.calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("pk:sk").toString("base64")}`);
    const span = JSON.parse(String(r.calls[0]!.init.body)).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toBe("0b6d5c1e6f2a4d8b9a1c2f3e4d5c6b7a");
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.startTimeUnixNano).toBe(`${Date.parse("2026-11-17T10:00:00Z")}000000`);
    const a = Object.fromEntries(span.attributes.map((x: { key: string; value: Record<string, unknown> }) => [x.key, Object.values(x.value)[0]]));
    expect(a).toMatchObject({ "langfuse.observation.type": "generation", "langfuse.observation.model.name": "claude-opus-5-5", "gen_ai.usage.input_tokens": "900", "langfuse.observation.prompt.name": "social.post", "langfuse.observation.prompt.version": "1" });
    expect(String(a["langfuse.observation.input"])).not.toContain("BRAND CONTEXT");
  });
  it("tracing failures never throw; scores go to /api/public/scores", async () => {
    const down = recorder(() => new Response("no", { status: 503 }));
    await expect(new LangfuseTracer(new LangfuseClient({ host: "https://l.example", publicKey: "p", secretKey: "s", fetchImpl: down.fetchImpl })).record({ name: "n", workspaceId: "w", template: "t", model: "m", input: { system: "", user: "" }, startedAt: new Date(), endedAt: new Date() })).resolves.toBeUndefined();
    const r = recorder(() => new Response("{}"));
    await new LangfuseClient({ host: "https://l.example", publicKey: "p", secretKey: "s", fetchImpl: r.fetchImpl }).score({ traceId: traceIdForJob("a-b"), name: "approved_first_pass", value: 1, dataType: "BOOLEAN" });
    expect(r.calls[0]!.url).toBe("https://l.example/api/public/scores");
    expect(JSON.parse(String(r.calls[0]!.init.body))).toMatchObject({ name: "approved_first_pass", value: 1, dataType: "BOOLEAN" });
  });
});

describe("Mautic email stats", () => {
  it("combines the email's counters with failed sends and link clicks from the stats API", async () => {
    const r = recorder((url) => {
      if (url.includes("/stats/email_stats")) return new Response(JSON.stringify({ total: "3", stats: [] }));
      if (url.includes("/stats/channel_url_trackables")) return new Response(JSON.stringify({ total: 2, stats: [{ hits: "10", unique_hits: "7" }, { hits: 4, unique_hits: 4 }] }));
      return new Response(JSON.stringify({ email: { id: 9, sentCount: 500, readCount: 210 } }));
    });
    const s = await new MauticClient({ baseUrl: "https://m.example.com", username: "u", password: "p" }, { fetchImpl: r.fetchImpl }).emailStats(9);
    expect(s).toEqual({ sent: 500, opens: 210, failed: 3, clicks: 14, uniqueClicks: 11 });
    const failedUrl = r.calls.find((c) => c.url.includes("email_stats"))!.url;
    expect(decodeURIComponent(failedUrl)).toContain("where[1][col]=is_failed&where[1][expr]=eq&where[1][val]=1");
  });
});
