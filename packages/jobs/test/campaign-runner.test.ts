import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

/**
 * Strategy / weekly plan / campaign runner workflows with fake activities.
 * Each test uses its own task queue so a slow test can't steal another's tasks.
 */
const run = process.env.SKIP_TEMPORAL_TESTS ? describe.skip : describe;

run("phase 4 workflows", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120_000);
  afterAll(async () => env?.teardown());

  type Tick = { stop?: boolean; paused?: boolean; finished?: boolean; due?: string[]; nextDueAt?: string | null };

  function fakes(ticks: Tick[], opts: { blockGeneration?: boolean; unsupported?: string[] } = {}) {
    const calls: string[] = [];
    let n = 0;
    const acts = {
      // bookkeeping (generateContentWorkflow children + runJob)
      markRunning: async (id: string) => { calls.push(`running:${id}`); },
      reportProgress: async () => undefined,
      completeJob: async (id: string, _o: unknown, credits: number) => { calls.push(`complete:${id}:${credits}`); },
      failJob: async (id: string) => { calls.push(`fail:${id}`); },
      cancelJob: async (id: string) => { calls.push(`cancel:${id}`); },
      settleCredits: async (r: string, a: number) => { calls.push(`settle:${r}:${a}`); },
      releaseCredits: async (r: string, why: string) => { calls.push(`release:${r}:${why}`); },
      generateContent: async (i: { topicId?: string }) => {
        if (opts.blockGeneration) {
          const { Context } = await import("@temporalio/activity");
          for (;;) {
            Context.current().heartbeat();
            await Context.current().sleep(100);
          }
        }
        calls.push(`generated:${i.topicId}`);
        return { contentItemId: "ci", contentVersionId: "cv", validationPassed: true };
      },
      // strategy
      generateStrategyDraft: async (i: { strategyId: string }) => {
        if (i.strategyId === "bad") {
          const { ApplicationFailure } = await import("@temporalio/common");
          throw ApplicationFailure.create({ type: "validation_failed", message: "Approve a Brand Kit version before planning.", nonRetryable: true });
        }
        calls.push("draft");
        return { revision: 1, notes: [] };
      },
      markStrategyFailed: async (_i: unknown, msg: string) => { calls.push(`strategy-failed:${msg}`); },
      planWeek: async (_i: unknown, week: string) => { calls.push(`week:${week}`); return { created: week === "2027-01-11" ? 0 : 3, flagged: 0, unfilled: 0, skippedExisting: 0 }; },
      // runner
      runnerTick: async () => ticks[Math.min(n++, ticks.length - 1)]!,
      reserveTopicGeneration: async (_i: unknown, topicId: string) => {
        if (opts.unsupported?.includes(topicId)) { calls.push(`blocked:${topicId}`); return null; }
        return { jobId: `job-${topicId}`, input: { jobId: `job-${topicId}`, workspaceId: "w", brandId: "b", templateKey: "social.post@1", input: {}, reservationId: `res-${topicId}`, chargeCredits: 1, topicId } };
      },
      markTopicFailed: async (topicId: string, msg: string) => { calls.push(`topic-failed:${topicId}:${msg}`); },
      recordRunnerEvent: async (_i: unknown, e: { message: string }) => { calls.push(`event:${e.message}`); },
      completeCampaign: async () => { calls.push("campaign-completed"); },
      renderVideo: async (i: { mode: string; projectId: string }) => {
        if (i.projectId === "broken") {
          const { ApplicationFailure } = await import("@temporalio/common");
          throw ApplicationFailure.create({ type: "validation_failed", message: "A file used in this video is missing", nonRetryable: true });
        }
        return { assetId: "vid", durationMs: i.mode === "final" ? 95_000 : 95_000, width: 1080, height: 1920, seconds: 20 };
      },
      markRenderFailed: async (_i: unknown, msg: string) => { calls.push(`render-failed:${msg}`); },
      generateImage: async (i: { count: number }) => ({ contentItemId: "ci", contentVersionId: "cv", validationPassed: true, assetIds: Array.from({ length: Math.min(2, i.count) }, (_, n) => `a${n}`) }),
    };
    return { acts, calls };
  }

  async function withWorker<T>(queue: string, acts: object, fn: () => Promise<T>) {
    const worker = await Worker.create({
      connection: env.nativeConnection, taskQueue: queue, activities: acts,
      workflowsPath: fileURLToPath(new URL("../src/workflows/index.ts", import.meta.url)),
    });
    return worker.runUntil(fn());
  }
  const runnerArgs = [{ workspaceId: "w", brandId: "b", campaignId: "c1" }];

  it("strategy: saves the draft and charges on success; marks failure and releases otherwise", async () => {
    const ok = fakes([]);
    await withWorker("q-strat", ok.acts, () => env.client.workflow.execute("strategyWorkflow", {
      taskQueue: "q-strat", workflowId: "st-ok", args: [{ jobId: "st-ok", workspaceId: "w", brandId: "b", strategyId: "s", weekStarts: [], channels: [], reservationId: "r", chargeCredits: 10 }],
    }));
    expect(ok.calls).toEqual(["running:st-ok", "draft", "settle:r:10", "complete:st-ok:10"]);

    const bad = fakes([]);
    await expect(withWorker("q-strat2", bad.acts, () => env.client.workflow.execute("strategyWorkflow", {
      taskQueue: "q-strat2", workflowId: "st-bad", args: [{ jobId: "st-bad", workspaceId: "w", brandId: "b", strategyId: "bad", weekStarts: [], channels: [], reservationId: "r", chargeCredits: 10 }],
    }))).rejects.toThrow();
    expect(bad.calls).toEqual(["running:st-bad", "strategy-failed:Approve a Brand Kit version before planning.", "release:r:failed", "fail:st-bad"]);
  });

  it("weekly plan: plans every week; charges nothing when no topic was created", async () => {
    const f = fakes([]);
    const r = await withWorker("q-week", f.acts, () => env.client.workflow.execute("weeklyPlanWorkflow", {
      taskQueue: "q-week", workflowId: "wk", args: [{ jobId: "wk", workspaceId: "w", brandId: "b", strategyId: "s", weekStarts: ["2027-01-11"], autoApprove: false, reservationId: "r", chargeCredits: 1 }],
    }));
    expect(r).toMatchObject({ created: 0 });
    expect(f.calls).toEqual(["running:wk", "week:2027-01-11", "settle:r:0", "complete:wk:0"]);
  });

  it("runner: generates due topics as child jobs, skips unsupported ones, waits, completes when the campaign ends", async () => {
    const f = fakes([{ due: ["t1", "t2", "t3"] }, { due: [], nextDueAt: null }, { finished: true }], { unsupported: ["t2"] });
    const r = await withWorker("q-run1", f.acts, async () => {
      const h = await env.client.workflow.start("campaignRunnerWorkflow", { taskQueue: "q-run1", workflowId: "runner-1", args: runnerArgs });
      // after the batch the runner waits for approved topics; wake it so it sees "finished"
      while (!f.calls.some((x) => x.startsWith("event:"))) await new Promise((res) => setTimeout(res, 50));
      await h.signal("wake");
      return h.result();
    });
    expect(r).toEqual({ generated: 2, reason: "completed" });
    expect(f.calls).toContain("blocked:t2");
    expect(f.calls.filter((x) => x.startsWith("generated:")).sort()).toEqual(["generated:t1", "generated:t3"]);
    expect(f.calls).toContain("settle:res-t1:1");
    expect(f.calls.at(-1)).toBe("campaign-completed");
  });

  it("runner: pause and resume take effect immediately (signal → query)", async () => {
    const f = fakes([{ due: [], nextDueAt: null }]);
    await withWorker("q-run2", f.acts, async () => {
      const h = await env.client.workflow.start("campaignRunnerWorkflow", { taskQueue: "q-run2", workflowId: "runner-2", args: runnerArgs });
      while (!f.calls.some((x) => x.startsWith("event:"))) await new Promise((res) => setTimeout(res, 50));
      const t0 = Date.now();
      await h.signal("pause");
      expect((await h.query("state")) as { paused: boolean }).toMatchObject({ paused: true, lastEvent: "paused" });
      await h.signal("resume");
      expect(await h.query("state")).toMatchObject({ paused: false, lastEvent: "resumed" });
      expect(Date.now() - t0).toBeLessThan(5000);
      await h.signal("cancel", "owner stopped it");
      expect(await h.result()).toEqual({ generated: 0, reason: "cancelled" });
    });
  });

  it("runner: cancelling mid-generation cancels the child jobs and releases their credits", async () => {
    const f = fakes([{ due: ["t9"] }], { blockGeneration: true });
    const r = await withWorker("q-run3", f.acts, async () => {
      const h = await env.client.workflow.start("campaignRunnerWorkflow", { taskQueue: "q-run3", workflowId: "runner-3", args: runnerArgs });
      while (!f.calls.includes("running:job-t9")) await new Promise((res) => setTimeout(res, 50));
      await h.signal("cancel");
      return h.result();
    });
    expect(r).toEqual({ generated: 0, reason: "cancelled" });
    expect(f.calls).toContain("release:res-t9:cancelled");
    expect(f.calls).toContain("cancel:job-t9");
    expect(f.calls).toContain("topic-failed:t9:Cancelled");
  }, 30_000);

  it("runner: stops when the campaign was closed in the database", async () => {
    const f = fakes([{ stop: true }]);
    const r = await withWorker("q-run4", f.acts, () => env.client.workflow.execute("campaignRunnerWorkflow", { taskQueue: "q-run4", workflowId: "runner-4", args: runnerArgs }));
    expect(r).toEqual({ generated: 0, reason: "campaign closed" });
  });

  it("images: charges only for the images actually produced", async () => {
    const f = fakes([]);
    const r = await withWorker("q-img", f.acts, () => env.client.workflow.execute("generateImageWorkflow", {
      taskQueue: "q-img", workflowId: "img-1",
      args: [{ jobId: "img-1", workspaceId: "w", brandId: "b", contentType: "image", prompt: "idli", preset: "instagram-square", count: 4, modelKey: "sdxl-base-1.0", reservationId: "r", chargeCredits: 16 }],
    }));
    expect(r.assetIds).toEqual(["a0", "a1"]);
    expect(f.calls).toEqual(["running:img-1", "settle:r:8", "complete:img-1:8"]);
  });

  it("video render: final charged per started minute, preview free, failures marked on the project", async () => {
    const run = async (id: string, mode: "final" | "preview", projectId = "p1") => {
      const f = fakes([]);
      const r = await withWorker(`q-${id}`, f.acts, () => env.client.workflow.execute("renderVideoWorkflow", {
        taskQueue: `q-${id}`, workflowId: id, args: [{ jobId: id, workspaceId: "w", brandId: "b", projectId, revision: 3, mode, reservationId: "r", chargeCredits: 2 }],
      })).catch((e: Error) => e);
      return { r, calls: f.calls };
    };
    expect((await run("rv-final", "final")).calls).toContain("settle:r:1");      // 95 s → 2 minutes × 0.5
    expect((await run("rv-prev", "preview")).calls).toContain("settle:r:0");
    const bad = await run("rv-bad", "final", "broken");
    expect(bad.r).toBeInstanceOf(Error);
    expect(bad.calls).toEqual(["running:rv-bad", "render-failed:A file used in this video is missing", "release:r:failed", "fail:rv-bad"]);
  });
});
