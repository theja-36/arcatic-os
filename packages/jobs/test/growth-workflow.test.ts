import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = process.env.SKIP_TEMPORAL_TESTS ? describe.skip : describe;
const workflowsPath = fileURLToPath(new URL("../src/workflows/index.ts", import.meta.url));

run("Phase 11 workflows", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120_000);
  afterAll(async () => env?.teardown());

  const book = (calls: string[]) => ({
    markRunning: async () => undefined, reportProgress: async () => undefined,
    completeJob: async (id: string, _r: unknown, c: number) => { calls.push(`complete:${id}:${c}`); },
    failJob: async (id: string) => { calls.push(`fail:${id}`); }, cancelJob: async () => undefined,
    settleCredits: async (r: string, a: number) => { calls.push(`settle:${r}:${a}`); }, releaseCredits: async (r: string) => { calls.push(`release:${r}`); },
  });

  it("SEO article: brief → child article (charged 0) → report, parent settles once", async () => {
    const calls: string[] = [];
    const acts = {
      ...book(calls),
      prepareSeoArticle: async () => ({ brief: { question: "Q?", intent: "commercial" }, child: { jobId: "child-1", workspaceId: "w", brandId: "b", chargeCredits: 0, templateKey: "blog.article@2", input: {} } }),
      generateContent: async (i: { jobId: string; chargeCredits: number }) => { calls.push(`gen:${i.jobId}:${i.chargeCredits}`); return { contentItemId: "item-1", contentVersionId: "v1", validationPassed: true }; },
      finishSeoArticle: async (a: { contentItemId: string; question: string }) => { calls.push(`finish:${a.contentItemId}:${a.question}`); return { overall: 72 }; },
    };
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "q-seo", activities: acts, workflowsPath });
    const input = { jobId: "seo-1", workspaceId: "w", brandId: "b", keyword: "k", secondary: [], competitorIds: [], language: "en", chargeCredits: 33, reservationId: "r1" };
    const r = await worker.runUntil(env.client.workflow.execute("seoArticleWorkflow", { taskQueue: "q-seo", workflowId: "seo-1", args: [input] }));
    expect(r).toEqual({ contentItemId: "item-1", overall: 72, credits: 33 });
    expect(calls).toEqual(expect.arrayContaining(["gen:child-1:0", "finish:item-1:Q?", "settle:r1:33", "complete:seo-1:33"]));
    expect(calls.filter((c) => c.startsWith("settle:"))).toHaveLength(1);
  });

  it("SEO article: a failed child releases the parent's hold", async () => {
    const calls: string[] = [];
    const { ApplicationFailure } = await import("@temporalio/common");
    const acts = {
      ...book(calls),
      prepareSeoArticle: async () => ({ brief: { question: "Q?" }, child: { jobId: "child-2", workspaceId: "w", brandId: "b", chargeCredits: 0, templateKey: "blog.article@2", input: {} } }),
      generateContent: async () => { throw ApplicationFailure.create({ type: "validation_failed", message: "no", nonRetryable: true }); },
      finishSeoArticle: async () => ({ overall: 0 }),
    };
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "q-seo2", activities: acts, workflowsPath });
    const input = { jobId: "seo-2", workspaceId: "w", brandId: "b", keyword: "k", secondary: [], competitorIds: [], language: "en", chargeCredits: 33, reservationId: "r2" };
    await expect(worker.runUntil(env.client.workflow.execute("seoArticleWorkflow", { taskQueue: "q-seo2", workflowId: "seo-2", args: [input] }))).rejects.toBeTruthy();
    expect(calls).toContain("release:r2");
    expect(calls).toContain("fail:seo-2");
  });

  it("ad action: a forbidden (non-retryable) refusal is not retried", async () => {
    let attempts = 0;
    const { ApplicationFailure } = await import("@temporalio/common");
    const acts = { executeAdAction: async () => { attempts++; throw ApplicationFailure.create({ type: "forbidden", message: "Campaign management is switched off", nonRetryable: false }); } };
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "q-ads", activities: acts, workflowsPath });
    await expect(worker.runUntil(env.client.workflow.execute("adActionWorkflow", { taskQueue: "q-ads", workflowId: "ad-action:a1", args: [{ actionId: "a1", workspaceId: "w" }] }))).rejects.toBeTruthy();
    expect(attempts).toBe(1);
  });
});
