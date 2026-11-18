import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { Activities } from "../src/activities.js";

/**
 * Lifecycle tests with fake activities on Temporal's time-skipping test server.
 * The test server binary is downloaded on first run; set SKIP_TEMPORAL_TESTS=1 to skip offline.
 */
const run = process.env.SKIP_TEMPORAL_TESTS ? describe.skip : describe;

run("job lifecycle workflows", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120_000);
  afterAll(async () => env?.teardown());

  function fakeActivities() {
    const calls: string[] = [];
    const rec = (name: string) => async (...args: unknown[]) => {
      calls.push(`${name}:${args.slice(1).filter((a) => typeof a !== "object").join(",")}`);
    };
    const acts = {
      markRunning: rec("running"),
      reportProgress: async () => undefined,
      completeJob: rec("complete"),
      failJob: rec("fail"),
      cancelJob: rec("cancel"),
      settleCredits: rec("settle"),
      releaseCredits: rec("release"),
      selfTestStep: async (_job: string, step: number, failAt?: number) => {
        if (failAt === -1) {
          // block until cancelled; heartbeats let Temporal deliver the cancellation
          const { Context } = await import("@temporalio/activity");
          for (;;) {
            Context.current().heartbeat();
            await Context.current().sleep(200);
          }
        }
        if (step === failAt) {
          const { ApplicationFailure } = await import("@temporalio/common");
          throw ApplicationFailure.create({ type: "self_test", message: "boom", nonRetryable: true });
        }
      },
      generateContent: async () => ({ contentItemId: "c", contentVersionId: "v", validationPassed: true }),
      discoverPages: async () => [
        { url: "https://x.in/", type: "home" }, { url: "https://x.in/about", type: "about" },
        { url: "https://x.in/menu", type: "products" }, { url: "https://x.in/faq", type: "faq" }, { url: "https://x.in/contact", type: "contact" },
      ],
      scrapePage: async (input: { url: string }, page: { url: string; type: string }) => {
        const { ApplicationFailure } = await import("@temporalio/common");
        if (input.url === "https://down.in" || page.type === "faq") {
          throw ApplicationFailure.create({ type: "upstream_error", message: "unreadable", nonRetryable: true });
        }
        return { sourceId: `s-${page.type}`, url: page.url, type: page.type, chars: 100, ...(page.type === "home" && { visual: { colors: [], fonts: [], logoCandidates: [] }, branding: null }) };
      },
      // ---- knowledge ----
      markSourceProcessing: async () => { calls.push("processing"); },
      markSourceFailed: async (_i: unknown, msg: string) => { calls.push(`source-failed:${msg}`); },
      setSourceStatus: async (id: string, status: string) => { calls.push(`status:${id}:${status}`); },
      fetchUrlSource: async (i: { sourceId: string }) => ({ changed: i.sourceId !== "same", chars: 1000 }),
      parseFileSource: async (i: { sourceId: string }) => {
        if (i.sourceId === "broken") {
          const { ApplicationFailure } = await import("@temporalio/common");
          throw ApplicationFailure.create({ type: "validation_failed", message: "unsupported file", nonRetryable: true });
        }
        return { changed: true, chars: 9000 };
      },
      startCrawl: async () => ({ crawlId: "c1" }),
      collectCrawl: (() => {
        let n = 0;
        return async () => (++n < 3 ? { done: false, completed: n, total: 3, failed: false } : { done: true, completed: 3, total: 3, failed: false });
      })(),
      finalizeCrawl: async () => ["k1", "k2", "k3"],
      indexSource: async (_ws: string, id: string) => {
        if (id === "k2") {
          const { ApplicationFailure } = await import("@temporalio/common");
          throw ApplicationFailure.create({ type: "validation_failed", message: "No text to index.", nonRetryable: true });
        }
        calls.push(`index:${id}`);
        return { chunks: 4, embedded: 4, chars: 1000 };
      },
      summarizeSource: async (_ws: string, id: string) => {
        if (id === "nosummary") throw new Error("model down");
        calls.push(`summary:${id}`);
        return { skipped: false };
      },
      completeSource: async (_i: unknown, usage: { pages?: number; chars?: number; unchanged?: boolean }) => {
        calls.push(`ready:${JSON.stringify(usage)}`);
        return usage.unchanged ? 0 : (usage.pages ?? 0) * 0.1 + (usage.chars ? 0.15 : 0);
      },
      extractBrand: async (_i: unknown, refs: Array<{ sourceId: string }>, visual: { url: string } | null) => {
        calls.push(`extract:${refs.map((r) => r.sourceId).join("|")}:${visual?.url}`);
        return { kitVersionId: "kv", version: 2, pagesAnalysed: refs.length, pagesFailed: 0, fieldsSuggested: 7, changedFactIds: ["oneLiner"], citationsKept: 5, citationsDropped: 1 };
      },
    };
    return { acts, calls };
  }

  async function runWith(acts: object, fn: () => Promise<unknown>) {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "test",
      workflowsPath: fileURLToPath(new URL("../src/workflows/index.ts", import.meta.url)),
      activities: acts,
    });
    return worker.runUntil(fn());
  }

  it("settles credits and completes on success", async () => {
    const { acts, calls } = fakeActivities();
    const result = await runWith(acts, () =>
      env.client.workflow.execute("selfTestWorkflow", {
        taskQueue: "test", workflowId: "job-ok",
        args: [{ jobId: "job-ok", workspaceId: "w", reservationId: "r1", chargeCredits: 2, steps: 3 }],
      }));
    expect(result).toEqual({ steps: 3 });
    expect(calls).toEqual(["running:", "settle:2", "complete:2"]);
  });

  it("releases credits and marks failed on error", async () => {
    const { acts, calls } = fakeActivities();
    await expect(runWith(acts, () =>
      env.client.workflow.execute("selfTestWorkflow", {
        taskQueue: "test", workflowId: "job-fail",
        args: [{ jobId: "job-fail", workspaceId: "w", reservationId: "r2", chargeCredits: 2, steps: 3, failAtStep: 2 }],
      }))).rejects.toThrow();
    expect(calls).toEqual(["running:", "release:failed", "fail:"]);
  });

  it("releases credits and marks cancelled when the job is cancelled", async () => {
    const { acts, calls } = fakeActivities();
    await runWith(acts, async () => {
      const handle = await env.client.workflow.start("selfTestWorkflow", {
        taskQueue: "test", workflowId: "job-cancel",
        args: [{ jobId: "job-cancel", workspaceId: "w", reservationId: "r3", chargeCredits: 2, steps: 1, failAtStep: -1 }],
      });
      while (!calls.includes("running:")) await new Promise((r) => setTimeout(r, 50));
      await handle.cancel();
      await expect(handle.result()).rejects.toThrow();
    });
    expect(calls).toEqual(["running:", "release:cancelled", "cancel:"]);
  });

  it("brand analysis skips unreadable pages, extracts from the rest and settles credits", async () => {
    const { acts, calls } = fakeActivities();
    const result = await runWith(acts, () =>
      env.client.workflow.execute("brandAnalysisWorkflow", {
        taskQueue: "test", workflowId: "job-brand",
        args: [{ jobId: "job-brand", workspaceId: "w", brandId: "b", url: "https://x.in", maxPages: 12, reservationId: "r4", chargeCredits: 6 }],
      }));
    expect(result).toMatchObject({ kitVersionId: "kv", pagesFailed: 1, fieldsSuggested: 7 });
    expect(calls.slice(0, 2)).toEqual(["running:", "extract:s-home|s-about|s-products|s-contact:https://x.in/"]);
    expect(calls.slice(2, 6).sort()).toEqual(["index:s-about", "index:s-contact", "index:s-home", "index:s-products"]);   // indexed in parallel
    expect(calls.slice(6)).toEqual(["settle:6", "complete:6"]);
  });

  it("brand analysis fails and releases credits when no page can be read", async () => {
    const { acts, calls } = fakeActivities();
    await expect(runWith(acts, () =>
      env.client.workflow.execute("brandAnalysisWorkflow", {
        taskQueue: "test", workflowId: "job-brand-down",
        args: [{ jobId: "job-brand-down", workspaceId: "w", brandId: "b", url: "https://down.in", maxPages: 12, reservationId: "r5", chargeCredits: 6 }],
      }))).rejects.toThrow();
    expect(calls).toEqual(["running:", "release:failed", "fail:"]);
  });

  const ingest = (workflowId: string, args: Record<string, unknown>) => ({
    taskQueue: "test", workflowId,
    args: [{ jobId: workflowId, workspaceId: "w", brandId: "b", reservationId: "r", chargeCredits: 5, ...args }],
  });

  it("ingests a changed URL, charges actual usage", async () => {
    const { acts, calls } = fakeActivities();
    const r = await runWith(acts, () => env.client.workflow.execute("ingestSourceWorkflow", ingest("ing-url", { sourceId: "s1", kind: "url" })));
    expect(r).toMatchObject({ chunks: 4, embedded: 4, pages: 1, charged: 0.1 });
    expect(calls).toEqual(["running:", "processing", "index:s1", "summary:s1", 'ready:{"pages":1}', "settle:0.1", "complete:0.1"]);
  });

  it("skips re-indexing unchanged content and charges nothing", async () => {
    const { acts, calls } = fakeActivities();
    const r = await runWith(acts, () => env.client.workflow.execute("ingestSourceWorkflow", ingest("ing-same", { sourceId: "same", kind: "url" })));
    expect(r).toMatchObject({ unchanged: true, charged: 0 });
    expect(calls).toEqual(["running:", "processing", 'ready:{"pages":1,"unchanged":true}', "settle:0", "complete:0"]);
  });

  it("crawls until done, indexes pages, marks the failed page and continues", async () => {
    const { acts, calls } = fakeActivities();
    const r = await runWith(acts, () => env.client.workflow.execute("ingestSourceWorkflow", ingest("ing-crawl", { sourceId: "parent", kind: "crawl", pollSeconds: 1 })));
    expect(r).toMatchObject({ chunks: 8, pages: 3 });
    expect(calls).toContain("status:k2:failed");
    expect(calls).toContain("status:k1:ready");
    expect(calls.at(-2)).toMatch(/^settle:0\.3/);
  }, 60_000);

  it("does not fail ingestion when only the summary fails", async () => {
    const { acts, calls } = fakeActivities();
    await runWith(acts, () => env.client.workflow.execute("ingestSourceWorkflow", ingest("ing-nosum", { sourceId: "nosummary", kind: "text" })));
    expect(calls).toContain("index:nosummary");
    expect(calls.some((c) => c.startsWith("ready:"))).toBe(true);
  });

  it("marks the source failed and releases credits when parsing fails", async () => {
    const { acts, calls } = fakeActivities();
    await expect(runWith(acts, () => env.client.workflow.execute("ingestSourceWorkflow", ingest("ing-broken", { sourceId: "broken", kind: "file" })))).rejects.toThrow();
    expect(calls).toEqual(["running:", "processing", "source-failed:unsupported file", "release:failed", "fail:"]);
  });
});
