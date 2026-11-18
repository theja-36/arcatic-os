/** Contracts shared by apps/api, apps/worker and the UI. */
export const TASK_QUEUES = {
  default: "arcatic-default",
  ingest: "arcatic-ingest",
  gpu: "arcatic-gpu",
  publish: "arcatic-publish",
  analytics: "arcatic-analytics",
} as const;
export type TaskQueue = (typeof TASK_QUEUES)[keyof typeof TASK_QUEUES];

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelling", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(["succeeded", "failed", "cancelled"]);

export interface JobError {
  code: string;
  message: string;
  retryable: boolean;
}
