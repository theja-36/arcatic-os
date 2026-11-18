import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

/** publishScheduleWorkflow with fake activities and skipped time. */
const run = process.env.SKIP_TEMPORAL_TESTS ? describe.skip : describe;

run("publish workflow", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120_000);
  afterAll(async () => env?.teardown());

  type Opts = {
    publishAt?: number; revision?: number; claim?: { ok: boolean; reason?: string };
    outcomes?: Array<"submitted" | "published" | "reject" | "reconnect">;
    checks?: Array<{ state: string; error?: string; url?: string }>;
  };
  function fakes(o: Opts) {
    const calls: string[] = [];
    const outcomes = [...(o.outcomes ?? ["submitted"])];
    const checks = [...(o.checks ?? [{ state: "PUBLISHED", url: "https://instagram.test/p/1" }])];
    const acts = {
      loadScheduleState: async () => ({ status: "scheduled", revision: o.revision ?? 1, publishAt: new Date(o.publishAt ?? 0).toISOString(), enabled: true }),
      claimSchedule: async () => { calls.push("claim"); return o.claim ?? { ok: true }; },
      publishTarget: async () => {
        const next = outcomes.shift() ?? "submitted";
        calls.push(`publish:${next}`);
        const { ApplicationFailure } = await import("@temporalio/common");
        if (next === "reject") throw ApplicationFailure.create({ type: "publish_rejected", message: "Instagram carousel only supports up to 20 media attachments", nonRetryable: true });
        if (next === "reconnect") throw ApplicationFailure.create({ type: "reconnect_needed", message: "Please re-authenticate", nonRetryable: true });
        return next === "published" ? { outcome: "published", externalId: "wp1", url: "https://blog.test/a" } : { outcome: "submitted", externalId: `p${calls.length}` };
      },
      checkPostiz: async () => { const c = checks.shift() ?? { state: "QUEUE" }; calls.push(`check:${c.state}`); return c; },
      finishTarget: async (f: { status: string; error?: { kind: string } | null; url?: string | null }) => { calls.push(`finish:${f.status}:${f.error?.kind ?? f.url ?? ""}`); },
    };
    return { calls, acts };
  }
  const exec = async (queue: string, acts: object, args: unknown) => {
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: queue, activities: acts, workflowsPath: fileURLToPath(new URL("../src/workflows/index.ts", import.meta.url)) });
    return worker.runUntil(env.client.workflow.execute("publishScheduleWorkflow", { taskQueue: queue, workflowId: `${queue}-wf`, args: [args] }));
  };

  it("waits for the publish time, claims, posts via Postiz and confirms", async () => {
    const f = fakes({ publishAt: Date.now() + 3 * 86_400_000, checks: [{ state: "QUEUE" }, { state: "PUBLISHED", url: "https://ig.test/1" }] });
    expect(await exec("q-pub1", f.acts, { scheduleId: "s", revision: 1 })).toBe("published");
    expect(f.calls).toEqual(["claim", "publish:submitted", "check:QUEUE", "check:PUBLISHED", "finish:published:https://ig.test/1"]);
  }, 60_000);

  it("stops when a newer revision exists or the approval gate blocks", async () => {
    const stale = fakes({ revision: 2 });
    expect(await exec("q-pub2", stale.acts, { scheduleId: "s", revision: 1 })).toBe("superseded");
    expect(stale.calls).toEqual([]);
    const blocked = fakes({ claim: { ok: false, reason: "blocked" } });
    expect(await exec("q-pub3", blocked.acts, { scheduleId: "s", revision: 1 })).toBe("blocked");
    expect(blocked.calls).toEqual(["claim"]);
  }, 60_000);

  it("re-posts after a transient platform error, fails on a rejection", async () => {
    const t = fakes({ checks: [{ state: "ERROR", error: "Service Unavailable, try again" }, { state: "PUBLISHED", url: "u" }] });
    expect(await exec("q-pub4", t.acts, { scheduleId: "s", revision: 1 })).toBe("published");
    expect(t.calls.filter((c) => c.startsWith("publish"))).toHaveLength(2);
    const r = fakes({ checks: [{ state: "ERROR", error: "Video aspect ratio is not supported" }] });
    expect(await exec("q-pub5", r.acts, { scheduleId: "s", revision: 1 })).toBe("failed");
    expect(r.calls.at(-1)).toBe("finish:failed:publish_rejected");
  }, 60_000);

  it("direct adapters finish at once; rejections and expired logins don't retry", async () => {
    const wp = fakes({ outcomes: ["published"] });
    expect(await exec("q-pub6", wp.acts, { scheduleId: "s", revision: 1 })).toBe("published");
    expect(wp.calls).toEqual(["claim", "publish:published", "finish:published:https://blog.test/a"]);
    const rej = fakes({ outcomes: ["reject"] });
    expect(await exec("q-pub7", rej.acts, { scheduleId: "s", revision: 1 })).toBe("failed");
    expect(rej.calls).toEqual(["claim", "publish:reject", "finish:failed:publish_rejected"]);
    const auth = fakes({ outcomes: ["reconnect"] });
    expect(await exec("q-pub8", auth.acts, { scheduleId: "s", revision: 1 })).toBe("failed");
    expect(auth.calls.at(-1)).toBe("finish:failed:reconnect_needed");
  }, 60_000);
});
