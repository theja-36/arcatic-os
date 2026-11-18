import { ApplicationFailure, Context } from "@temporalio/activity";
import type { LlmProvider } from "@arcatic/ai";
import { AppError, type JobError } from "@arcatic/core";
import { jobsRepo, ledger, type Db } from "@arcatic/database";
import type { Embedder } from "@arcatic/integrations";
import { generateContentActivity } from "./content-activity.js";
import type { GenerateContentInput, GenerateContentResult } from "./contracts.js";

export interface ActivityDeps {
  db: Db;                 // service-role client: every query filters by workspace_id explicitly
  llm: LlmProvider;
  embedder?: Embedder | null;
}

/** AppError → Temporal failure, preserving retryability so Temporal's retry policy does the right thing. */
async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) {
      throw ApplicationFailure.create({ type: err.code, message: err.message, nonRetryable: !err.retryable, details: [err.details ?? null] });
    }
    throw err;
  }
}

export function createActivities({ db, llm, embedder = null }: ActivityDeps) {
  return {
    async markRunning(jobId: string) {
      return wrap(() => jobsRepo.setStatus(db, jobId, "running"));
    },
    async reportProgress(jobId: string, progress: number, message?: string) {
      return wrap(() => jobsRepo.progress(db, jobId, progress, message));
    },
    async completeJob(jobId: string, output: unknown, actualCredits: number) {
      return wrap(() => jobsRepo.setStatus(db, jobId, "succeeded", { output, actualCredits }));
    },
    async failJob(jobId: string, error: JobError) {
      return wrap(() => jobsRepo.setStatus(db, jobId, "failed", { error }));
    },
    async cancelJob(jobId: string) {
      return wrap(() => jobsRepo.setStatus(db, jobId, "cancelled"));
    },
    async settleCredits(reservationId: string, actual: number) {
      return wrap(async () => {
        await ledger.settle(db, reservationId, actual);
      });
    },
    async releaseCredits(reservationId: string, reason: string) {
      return wrap(async () => {
        await ledger.release(db, reservationId, reason);
      });
    },
    async selfTestStep(jobId: string, step: number, failAtStep?: number) {
      if (failAtStep === step) {
        throw ApplicationFailure.create({ type: "self_test", message: `Self-test failed at step ${step}`, nonRetryable: true });
      }
      Context.current().heartbeat({ step });
      return wrap(() => jobsRepo.event(db, jobId, "log", `step ${step} ok`));
    },

    /** Generate / regenerate / transform / translate → validate → persist a version with provenance. */
    async generateContent(input: GenerateContentInput): Promise<GenerateContentResult> {
      return wrap(() => generateContentActivity(db, llm, embedder, input));
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
