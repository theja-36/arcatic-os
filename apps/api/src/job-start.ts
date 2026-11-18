import { randomUUID } from "node:crypto";
import { AppError, fromDbError, type Estimate } from "@arcatic/core";
import { ledger } from "@arcatic/database";
import type { JobStarter } from "@arcatic/jobs";
import type { Context } from "hono";
import type { ApiDeps, AppEnv } from "./types.js";
import { assertCanSpend } from "./routes/billing.js";

type JobRow = { id: string; kind: string; status: string };

/**
 * The one way the API starts paid background work:
 * replay check → reserve credits (idempotent) → job row → Temporal start (workflowId = job id).
 * If the start fails, credits are released and the job is marked failed.
 */
export async function startCostedJob(
  deps: ApiDeps,
  c: Context<AppEnv>,
  opts: {
    idempotencyKey: string;
    kind: string;
    brandId?: string;
    input: Record<string, unknown>;
    cost: Estimate;
    extra?: Record<string, unknown>;
    start: (starter: JobStarter, args: { jobId: string; reservationId?: string; chargeCredits: number }) => Promise<unknown>;
  },
): Promise<{ job: JobRow; credits: { reserved: number; estimate: number } | null; replay: boolean }> {
  const ws = c.get("workspaceId");
  const svc = deps.serviceDb();
  const p = c.get("principal");
  const existing = async () => {
    const r = await svc.from("generation_jobs").select("id, kind, status").eq("workspace_id", ws).eq("idempotency_key", opts.idempotencyKey).maybeSingle();
    if (r.error) throw fromDbError(r.error);
    return r.data as JobRow | null;
  };

  const prior = await existing();
  if (prior) return { job: prior, credits: null, replay: true };
  if (opts.cost.max > 0) await assertCanSpend(deps, ws);   // trial ended / overdue / cancelled → no new paid work

  const jobId = randomUUID();
  const reservation = opts.cost.max > 0
    ? await ledger.reserve(svc, { workspaceId: ws, amount: opts.cost.max, idempotencyKey: `job:${opts.idempotencyKey}`, jobId, reason: opts.kind })
    : null;

  const ins = await svc.from("generation_jobs").insert({
    id: jobId,
    workspace_id: ws,
    brand_id: opts.brandId ?? null,
    kind: opts.kind,
    input: opts.input,
    idempotency_key: opts.idempotencyKey,
    requested_by: p.kind === "user" ? p.userId : null,
    credit_reservation_id: reservation?.id ?? null,
    estimated_credits: opts.cost.estimate,
    ...opts.extra,
  }).select("id, kind, status").single();
  if (ins.error?.code === "23505") return { job: (await existing())!, credits: null, replay: true };
  if (ins.error) throw fromDbError(ins.error);

  try {
    await opts.start(await deps.jobs(), { jobId, reservationId: reservation?.id, chargeCredits: opts.cost.estimate });
  } catch (e) {
    if (!(e instanceof Error && e.name === "WorkflowExecutionAlreadyStartedError")) {
      if (reservation) await ledger.release(svc, reservation.id, "start_failed").catch(() => undefined);
      await svc.from("generation_jobs").update({ status: "failed", error: { code: "upstream_error", message: "Could not start job", retryable: true } }).eq("id", jobId);
      throw new AppError("upstream_error", "Job queue unavailable; no credits were charged.", { cause: e });
    }
  }
  return { job: ins.data as JobRow, credits: reservation ? { reserved: opts.cost.max, estimate: opts.cost.estimate } : null, replay: false };
}
