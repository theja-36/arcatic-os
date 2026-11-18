import { compileBrandContext, emptyKit } from "@arcatic/core";
import type { LlmProvider } from "@arcatic/ai";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/activity", async (orig) => ({ ...(await orig<object>()), Context: { current: () => ({ heartbeat: () => undefined, cancelled: new Promise(() => undefined) }) } }));
const { createRepurposeActivities } = await import("../src/repurpose-activities.js");
const { memDb } = await import("./mem-db.js");

const WS = "w1", BRAND = "b1";
const digestLlm = (): { p: LlmProvider; calls: string[] } => {
  const calls: string[] = [];
  return { calls, p: { async generateStructured(req) {
    calls.push(req.user);
    return { output: req.schema.parse({ title: "Idli story", summary: "How we make idli.", key_points: [{ point: "Batter ferments 8 hours", chunk_ids: ["k1"] }], quotes: [{ text: "ferments for 8 hours", chunk_id: "k1" }], angles: [{ angle: "Behind the scenes", best_for: "reel" }, { angle: "Health", best_for: "blog" }] }),
      model: "claude-opus-5-5", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: "end_turn", servedByFallback: false };
  } } };
};
async function seed(run: Record<string, unknown>) {
  const ctx = await compileBrandContext(emptyKit(BRAND, "Annapurna"));
  return memDb({
    brands: [{ id: BRAND, workspace_id: WS, active_kit_version_id: "kv1" }], brand_contexts: [{ kit_version_id: "kv1", workspace_id: WS, context: ctx }],
    sources: [{ id: "src1", status: "ready", type: "media", title: "Kitchen tour", parent_source_id: null }],
    knowledge_chunks: [{ id: "k2", source_id: "src1", ordinal: 2, content: "We grind rice and urad dal." }, { id: "k1", source_id: "src1", ordinal: 1, content: "Our batter ferments for 8 hours." }],
    repurpose_runs: [{ id: "run1", workspace_id: WS, brand_id: BRAND, project_id: "p1", source_kind: "source", source_id: "src1", source_item_id: null, language: "en", digest: null, status: "queued",
      source_ref: { kind: "source", id: "src1", title: "Kitchen tour", url: null, sourceType: "media" },
      outputs: [{ outputId: "instagram_post", type: "social_post", channel: "instagram", status: "queued" }, { outputId: "blog", type: "blog", channel: "blog", status: "queued" }], ...run }],
    generation_jobs: [],
  });
}
const input = { jobId: "parent", workspaceId: WS, brandId: BRAND, runId: "run1", chargeCredits: 20, reservationId: "r1" };

describe("repurpose activities", () => {
  it("digests the source in order once, then prepares one child job per output with attribution", async () => {
    const m = await seed({});
    const llm = digestLlm();
    const acts = createRepurposeActivities({ db: m.db, llm: llm.p });
    expect(await acts.digestRun(input)).toMatchObject({ points: 1 });
    expect(llm.calls[0]!.indexOf("ferments")).toBeLessThan(llm.calls[0]!.indexOf("grind"));   // ordinal order
    expect(llm.calls[0]).toContain("video transcript");
    await acts.digestRun(input);
    expect(llm.calls).toHaveLength(1);   // idempotent

    const todo = await acts.prepareOutputs(input);
    expect(todo).toHaveLength(2);
    expect(todo[0]!.input).toMatchObject({ templateKey: "social.post@1", chargeCredits: 0, referenceSourceIds: ["src1"], projectId: "p1", repurposeRunId: "run1", sourceRef: { kind: "source", id: "src1" } });
    expect(todo[0]!.input.input).toMatchObject({ channel: "instagram", language: "en" });
    expect(String(todo[0]!.input.input.topic)).toContain("Batter ferments 8 hours");
    expect(String(todo[0]!.input.input.topic)).toContain("our video");
    const again = await acts.prepareOutputs(input);
    expect(again.map((t) => t.input.jobId)).toEqual(todo.map((t) => t.input.jobId));   // job rows reused
    expect(m.tables.generation_jobs).toHaveLength(2);
  });

  it("charges the digest plus outputs that succeeded; partial when some fail", async () => {
    const m = await seed({ digest: { title: "t", summary: "s", key_points: [], quotes: [], angles: [] } });
    const acts = createRepurposeActivities({ db: m.db, llm: digestLlm().p });
    await acts.finishOutput({ runId: "run1", index: 0, contentItemId: "c1" });
    await acts.finishOutput({ runId: "run1", index: 1, error: "model refused" });
    expect(await acts.finishRun({ runId: "run1" })).toEqual({ status: "partial", succeeded: 1, failed: 1, credits: 3 });   // digest 2 + social post 1
  });

  it("won't digest a source that isn't ready", async () => {
    const m = await seed({});
    m.tables.sources![0]!.status = "processing";
    await expect(createRepurposeActivities({ db: m.db, llm: digestLlm().p }).digestRun(input)).rejects.toMatchObject({ type: "conflict", nonRetryable: true });
  });
});

const run = process.env.SKIP_TEMPORAL_TESTS ? describe.skip : describe;
run("repurpose workflow", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120_000);
  afterAll(async () => env?.teardown());

  it("generates every output as a child job, records each result and settles the actual credits", async () => {
    const calls: string[] = [];
    const acts = {
      markRunning: async () => undefined, reportProgress: async () => undefined, completeJob: async (id: string, _r: unknown, c: number) => { calls.push(`complete:${id}:${c}`); },
      failJob: async (id: string) => { calls.push(`fail:${id}`); }, cancelJob: async () => undefined,
      settleCredits: async (r: string, a: number) => { calls.push(`settle:${r}:${a}`); }, releaseCredits: async (r: string) => { calls.push(`release:${r}`); },
      digestRun: async () => ({ points: 3, truncated: false }),
      prepareOutputs: async () => [0, 1, 2, 3].map((i) => ({ index: i, input: { jobId: `child-${i}`, workspaceId: WS, brandId: BRAND, chargeCredits: 0, templateKey: "social.post@1", input: {} } })),
      generateContent: async (i: { jobId: string }) => {
        if (i.jobId === "child-2") { const { ApplicationFailure } = await import("@temporalio/common"); throw ApplicationFailure.create({ type: "validation_failed", message: "bad", nonRetryable: true }); }
        return { contentItemId: `item-${i.jobId}`, contentVersionId: "v", validationPassed: true };
      },
      finishOutput: async (a: { index: number; contentItemId?: string; error?: string }) => { calls.push(`out:${a.index}:${a.contentItemId ?? "failed"}`); },
      finishRun: async () => ({ status: "partial", succeeded: 3, failed: 1, credits: 5 }),
      markRunFailed: async () => { calls.push("runfailed"); },
    };
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "q-rep", activities: acts, workflowsPath: fileURLToPath(new URL("../src/workflows/index.ts", import.meta.url)) });
    const r = await worker.runUntil(env.client.workflow.execute("repurposeWorkflow", { taskQueue: "q-rep", workflowId: "parent", args: [input] }));
    expect(r).toMatchObject({ status: "partial", succeeded: 3, credits: 5 });
    expect(calls.filter((c) => c.startsWith("out:")).sort()).toEqual(["out:0:item-child-0", "out:1:item-child-1", "out:2:failed", "out:3:item-child-3"]);
    expect(calls).toContain("settle:r1:5");
    expect(calls).toContain("complete:parent:5");
    expect(calls).not.toContain("runfailed");
  });
});
