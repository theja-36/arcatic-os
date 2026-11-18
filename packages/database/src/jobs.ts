import { fromDbError, type JobError, type JobStatus } from "@arcatic/core";
import type { Db } from "./clients.js";

/** Postgres mirror of Temporal executions (service role). */
export const jobsRepo = {
  async setStatus(db: Db, jobId: string, status: JobStatus, patch: { output?: unknown; error?: JobError; actualCredits?: number } = {}) {
    const { error } = await db
      .from("generation_jobs")
      .update({
        status,
        ...(patch.output !== undefined && { output: patch.output }),
        ...(patch.error && { error: patch.error }),
        ...(patch.actualCredits !== undefined && { actual_credits: patch.actualCredits }),
      })
      .eq("id", jobId);
    if (error) throw fromDbError(error);
    await jobsRepo.event(db, jobId, "status", status, patch.error ? { error: patch.error } : undefined);
  },
  async progress(db: Db, jobId: string, progress: number, message?: string) {
    const p = Math.max(0, Math.min(99, Math.round(progress)));
    const { error } = await db.from("generation_jobs").update({ progress: p }).eq("id", jobId);
    if (error) throw fromDbError(error);
    await jobsRepo.event(db, jobId, "progress", message, { progress: p });
  },
  async event(db: Db, jobId: string, type: "status" | "progress" | "log" | "error" | "retry", message?: string, data?: unknown) {
    const { error } = await db.from("job_events").insert({ job_id: jobId, type, message, data });
    if (error) throw fromDbError(error);
  },
  async get(db: Db, jobId: string) {
    const { data, error } = await db.from("generation_jobs").select("*").eq("id", jobId).single();
    if (error) throw fromDbError(error);
    return data as { id: string; workspace_id: string; status: JobStatus; credit_reservation_id: string | null; kind: string; input: unknown };
  },
};
