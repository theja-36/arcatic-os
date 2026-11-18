import { describe, expect, it } from "vitest";
import { AdsSyncClient } from "../src/index.js";

const recorder = (respond: (n: number) => Response) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond(calls.length); }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};
const auth = { customerId: "123-456-7890", refreshToken: "rt" };

describe("AdsSyncClient (Phase 11)", () => {
  it("sends the shared secret and retries read-only research on 5xx", async () => {
    const r = recorder((n) => (n === 1 ? new Response("busy", { status: 503 }) : new Response(JSON.stringify({ ideas: [{ keyword: "diwali hampers", avgMonthlySearches: 9000 }] }))));
    const c = new AdsSyncClient({ baseUrl: "http://ads-sync:8090", secret: "s3cret", fetchImpl: r.fetchImpl });
    const res = await c.keywordIdeas({ ...auth, keywords: ["diwali hampers"], locationIds: ["2356"] });
    expect(res.ideas[0]!.keyword).toBe("diwali hampers");
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0]!.url).toBe("http://ads-sync:8090/google-ads/keyword-ideas");
    expect((r.calls[0]!.init.headers as Record<string, string>)["x-arcatic-secret"]).toBe("s3cret");
  });

  it("never retries campaign creation or updates at the HTTP layer", async () => {
    const r = recorder(() => new Response("boom", { status: 502 }));
    const c = new AdsSyncClient({ baseUrl: "http://ads-sync:8090", secret: "s", fetchImpl: r.fetchImpl });
    const campaign = { id: "6f1c2a9e-0000-4000-8000-000000000001", name: "x", objective: "website_traffic", currency: "INR", dailyBudgetMinor: 1, landingUrl: "https://e.in", audience: {}, creative: {} };
    await expect(c.googleCreate({ ...auth, campaign })).rejects.toBeTruthy();
    await expect(c.metaUpdate({ accessToken: "t", campaignId: "1", status: "active" })).rejects.toBeTruthy();
    expect(r.calls.map((x) => x.url)).toEqual(["http://ads-sync:8090/google-ads/campaigns", "http://ads-sync:8090/meta/campaigns/update"]);
  });
});
