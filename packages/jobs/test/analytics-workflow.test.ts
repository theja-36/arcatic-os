import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

const run = process.env.SKIP_TEMPORAL_TESTS ? describe.skip : describe;

run("analytics workflow", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120_000);
  afterAll(async () => env?.teardown());

  it("runs every source (a failing one doesn't stop the rest), then outcomes and insights per brand", async () => {
    const calls: string[] = [];
    const acts = {
      syncPostMetrics: async () => { calls.push("posts"); return [{ source: "postiz_posts", status: "succeeded", rows: 3 }]; },
      syncAccountMetrics: async () => { calls.push("accounts"); return { source: "postiz_accounts", status: "failed", rows: 0, error: "401" }; },
      syncSiteMetrics: async () => { calls.push("site"); return []; },
      syncAdMetrics: async () => { calls.push("ads"); return [{ source: "meta_ads:1", status: "skipped", rows: 0 }]; },
      recordOutcomes: async () => { calls.push("outcomes"); return 2; },
      listBrands: async () => ["b1", "b2"],
      generateInsights: async (a: { brandId: string }) => { calls.push(`insights:${a.brandId}`); return { written: 1, kinds: { recommendation: 1 } }; },
      listAnalyticsWorkspaces: async () => [],
    };
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "q-an", activities: acts, workflowsPath: fileURLToPath(new URL("../src/workflows/index.ts", import.meta.url)) });
    const r = await worker.runUntil(env.client.workflow.execute("analyticsSyncWorkflow", { taskQueue: "q-an", workflowId: "an-1", args: [{ workspaceId: "w" }] }));
    expect(calls).toEqual(["posts", "accounts", "site", "ads", "outcomes", "insights:b1", "insights:b2"]);
    expect(r).toMatchObject({ outcomes: 2, insights: { recommendation: 2 } });
    expect((r as { sources: Array<{ status: string }> }).sources.map((s) => s.status)).toEqual(["succeeded", "failed", "skipped"]);
  });
});
