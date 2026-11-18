/**
 * Temporal workflows — deterministic code only (no I/O, no Date.now, no imports with side effects).
 * Bundled by the worker from this file.
 */
import {
  ApplicationFailure,
  CancellationScope,
  isCancellation,
  ParentClosePolicy,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
  startChild,
  executeChild,
  type ActivityFailure,
} from "@temporalio/workflow";
import type { Activities } from "../activities.js";
import type { BrandActivities } from "../brand-activities.js";
import type { KnowledgeActivities } from "../knowledge-activities.js";
import type { StrategyActivities } from "../strategy-activities.js";
import type { ImageActivities } from "../image-activity.js";
import type { MediaActivities } from "../media-activities.js";
import type { PublishActivities } from "../publish-activities.js";
import type { AnalyticsActivities } from "../analytics-activities.js";
import type { RepurposeActivities } from "../repurpose-activities.js";
import type { BillingActivities } from "../billing.js";
import type { SeoActivities } from "../seo-activities.js";
import type { AdsActivities } from "../ads-activities.js";
import type { ServiceActivities } from "../service-activities.js";
import type {
  BrandAnalysisInput, BrandAnalysisResult, CampaignRunnerInput, GenerateContentInput, GenerateContentResult, GenerateImageInput, IngestSourceInput, IngestSourceResult,
  ImportDriveMediaInput, ProbeMediaInput, RenderVideoInput, RenderVideoResult, PublishScheduleInput, PublishScheduleResult, AnalyticsSyncInput, AnalyticsSyncResult, RepurposeInput, RepurposeResult,
  RunnerState, ScrapedPageRef, SelfTestInput, StrategyInput, WeeklyPlanInput, WeeklyPlanResult,
  CompetitorResearchInput, KeywordResearchInput, SeoArticleInput, SeoArticleResult, AdsDraftInput, AdActionInput,
} from "../contracts.js";

const bookkeeping = proxyActivities<Activities>({
  startToCloseTimeout: "30 seconds",
  retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumAttempts: 10 },
});

const model = proxyActivities<Pick<Activities, "generateContent">>({
  startToCloseTimeout: "5 minutes",
  heartbeatTimeout: "2 minutes",
  retry: { initialInterval: "5 seconds", backoffCoefficient: 2, maximumAttempts: 3, nonRetryableErrorTypes: ["validation_failed", "forbidden", "not_found"] },
});

const site = proxyActivities<Pick<BrandActivities, "discoverPages" | "scrapePage">>({
  startToCloseTimeout: "3 minutes",
  heartbeatTimeout: "90 seconds",
  retry: { initialInterval: "3 seconds", backoffCoefficient: 2, maximumAttempts: 3, nonRetryableErrorTypes: ["validation_failed", "forbidden", "not_found"] },
});

const analyst = proxyActivities<Pick<BrandActivities, "extractBrand">>({
  startToCloseTimeout: "10 minutes",
  retry: { initialInterval: "10 seconds", backoffCoefficient: 2, maximumAttempts: 3, nonRetryableErrorTypes: ["validation_failed", "forbidden", "not_found"] },
});

const NON_RETRYABLE = ["validation_failed", "forbidden", "not_found"];

const ingest = proxyActivities<Omit<KnowledgeActivities, "transcribeMediaSource" | "summarizeSource">>({
  startToCloseTimeout: "15 minutes",
  heartbeatTimeout: "3 minutes",
  retry: { initialInterval: "5 seconds", backoffCoefficient: 2, maximumAttempts: 4, nonRetryableErrorTypes: NON_RETRYABLE },
});

const transcription = proxyActivities<Pick<KnowledgeActivities, "transcribeMediaSource">>({
  startToCloseTimeout: "4 hours",
  heartbeatTimeout: "20 minutes",   // one 10-minute segment per heartbeat
  retry: { initialInterval: "30 seconds", backoffCoefficient: 2, maximumAttempts: 3, nonRetryableErrorTypes: NON_RETRYABLE },
});

const summarizer = proxyActivities<Pick<KnowledgeActivities, "summarizeSource">>({
  startToCloseTimeout: "3 minutes",
  retry: { maximumAttempts: 2, nonRetryableErrorTypes: NON_RETRYABLE },
});

const planner = proxyActivities<Pick<StrategyActivities, "generateStrategyDraft" | "planWeek">>({
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "5 minutes",
  retry: { initialInterval: "10 seconds", backoffCoefficient: 2, maximumAttempts: 3, nonRetryableErrorTypes: NON_RETRYABLE },
});

const runner = proxyActivities<Omit<StrategyActivities, "generateStrategyDraft" | "planWeek">>({
  startToCloseTimeout: "1 minute",
  retry: { initialInterval: "2 seconds", backoffCoefficient: 2, maximumAttempts: 10, nonRetryableErrorTypes: NON_RETRYABLE },
});

const gpu = proxyActivities<ImageActivities>({
  startToCloseTimeout: "60 minutes",
  heartbeatTimeout: "2 minutes",
  retry: { initialInterval: "15 seconds", backoffCoefficient: 2, maximumAttempts: 3, nonRetryableErrorTypes: NON_RETRYABLE },
});

const media = proxyActivities<Omit<MediaActivities, "renderVideo" | "markRenderFailed">>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "5 minutes",
  retry: { initialInterval: "5 seconds", backoffCoefficient: 2, maximumAttempts: 3, nonRetryableErrorTypes: NON_RETRYABLE },
});

const renderer = proxyActivities<Pick<MediaActivities, "renderVideo" | "markRenderFailed">>({
  startToCloseTimeout: "90 minutes",
  heartbeatTimeout: "3 minutes",
  retry: { initialInterval: "10 seconds", backoffCoefficient: 2, maximumAttempts: 2, nonRetryableErrorTypes: [...NON_RETRYABLE, "conflict"] },
});

const steps = proxyActivities<Pick<Activities, "selfTestStep">>({
  startToCloseTimeout: "30 seconds",
  heartbeatTimeout: "20 seconds",
  retry: { maximumAttempts: 3 },
});

function toJobError(err: unknown) {
  const cause = (err as ActivityFailure)?.cause ?? err;
  if (cause instanceof ApplicationFailure) {
    return { code: cause.type ?? "internal", message: cause.message, retryable: !cause.nonRetryable };
  }
  return { code: "internal", message: err instanceof Error ? err.message : String(err), retryable: false };
}

/**
 * Shared lifecycle: running → work → settle credits → succeeded,
 * or on failure/cancel: release credits → failed/cancelled. Cleanup runs even when cancelled.
 */
async function runJob<T>(
  input: { jobId: string; reservationId?: string; chargeCredits: number },
  work: () => Promise<T>,
  /** actual credits from the result (capped at the reservation by settle_reservation) */
  charge: (result: T) => number = () => input.chargeCredits,
): Promise<T> {
  let settled = false;
  try {
    await bookkeeping.markRunning(input.jobId);
    const result = await work();
    const actual = Math.max(0, charge(result));
    if (input.reservationId) {
      await bookkeeping.settleCredits(input.reservationId, actual);
      settled = true;
    }
    await bookkeeping.completeJob(input.jobId, result, actual);
    return result;
  } catch (err) {
    await CancellationScope.nonCancellable(async () => {
      if (input.reservationId && !settled) {
        await bookkeeping.releaseCredits(input.reservationId, isCancellation(err) ? "cancelled" : "failed");
      }
      if (isCancellation(err)) await bookkeeping.cancelJob(input.jobId);
      else await bookkeeping.failJob(input.jobId, toJobError(err));
    });
    throw err;
  }
}

/** Exercises the whole job pipeline (DB mirror, events, credits, cancel) without external services. */
export async function selfTestWorkflow(input: SelfTestInput): Promise<{ steps: number }> {
  return runJob(input, async () => {
    for (let i = 1; i <= input.steps; i++) {
      await steps.selfTestStep(input.jobId, i, input.failAtStep);
      await bookkeeping.reportProgress(input.jobId, (i / input.steps) * 100, `step ${i}/${input.steps}`);
    }
    return { steps: input.steps };
  });
}

export async function generateContentWorkflow(input: GenerateContentInput): Promise<GenerateContentResult> {
  return runJob(input, async () => {
    await bookkeeping.reportProgress(input.jobId, 10, "Compiling brand context");
    const result = await model.generateContent(input);
    await bookkeeping.reportProgress(input.jobId, 90, result.validationPassed ? "Draft ready" : "Draft ready — needs fixes");
    return result;
  });
}

/**
 * Website → Brand Kit draft. Pages are scraped 4 at a time; a page that still fails after
 * retries is skipped (the analysis continues if at least one page was read).
 */
export async function brandAnalysisWorkflow(input: BrandAnalysisInput): Promise<BrandAnalysisResult> {
  return runJob(input, async () => {
    await bookkeeping.reportProgress(input.jobId, 5, "Finding the important pages");
    const pages = await site.discoverPages(input);

    const scraped: Array<Awaited<ReturnType<BrandActivities["scrapePage"]>>> = [];
    let failed = 0;
    for (let i = 0; i < pages.length; i += 4) {
      const batch = pages.slice(i, i + 4);
      const results = await Promise.allSettled(batch.map((p) => site.scrapePage(input, p)));
      for (const r of results) {
        if (r.status === "fulfilled") scraped.push(r.value);
        else if (isCancellation(r.reason)) throw r.reason;
        else failed++;
      }
      await bookkeeping.reportProgress(input.jobId, 10 + Math.round(((i + batch.length) / Math.max(1, pages.length)) * 55), `Read ${scraped.length} of ${pages.length} pages`);
    }
    if (scraped.length === 0) {
      throw ApplicationFailure.create({ type: "validation_failed", message: "None of the website's pages could be read.", nonRetryable: true });
    }

    await bookkeeping.reportProgress(input.jobId, 70, "Extracting brand facts and checking sources");
    const home = scraped.find((p) => p.type === "home");
    const refs: ScrapedPageRef[] = scraped.map(({ sourceId, url, type, chars }) => ({ sourceId, url, type, chars }));
    const result = await analyst.extractBrand(input, refs, home ? { signals: home.visual, branding: home.branding, url: home.url } : null);

    // the pages read for the Brand Kit also become searchable knowledge (best effort)
    await bookkeeping.reportProgress(input.jobId, 92, "Adding the pages to the knowledge library");
    await Promise.allSettled(refs.map((r) => ingest.indexSource(input.workspaceId, r.sourceId)));
    return { ...result, pagesFailed: failed };
  });
}

/**
 * Every knowledge source: fetch/parse/transcribe → index (chunk + embed) → summarise.
 * Unchanged content (same hash, already indexed) is not re-indexed and costs nothing.
 */
export async function ingestSourceWorkflow(input: IngestSourceInput): Promise<IngestSourceResult> {
  return runJob(input, async () => {
    await ingest.markSourceProcessing(input);
    try {
      const usage: { chars?: number; pages?: number; minutes?: number; unchanged?: boolean } = {};
      let chunks = 0;
      let embedded = 0;

      if (input.kind === "crawl") {
        await bookkeeping.reportProgress(input.jobId, 5, "Starting crawl");
        const { crawlId } = await ingest.startCrawl(input);
        for (let i = 0; i < 480; i++) {   // ≤ 2 h
          const st = await ingest.collectCrawl(input, crawlId);
          await bookkeeping.reportProgress(input.jobId, 5 + Math.round((st.completed / Math.max(1, st.total)) * 45), `Crawled ${st.completed} of ${st.total || "?"} pages`);
          if (st.done) {
            if (st.failed) throw ApplicationFailure.create({ type: "upstream_error", message: "The crawl returned no pages.", nonRetryable: true });
            break;
          }
          await sleep(`${input.pollSeconds ?? 15} seconds`);
        }
        const children = await ingest.finalizeCrawl(input);
        let done = 0;
        for (let i = 0; i < children.length; i += 4) {
          const batch = children.slice(i, i + 4);
          const results = await Promise.allSettled(batch.map((id) => ingest.indexSource(input.workspaceId, id)));
          for (let j = 0; j < batch.length; j++) {
            const r = results[j]!;
            if (r.status === "fulfilled") {
              chunks += r.value.chunks;
              embedded += r.value.embedded;
              await ingest.setSourceStatus(batch[j]!, "ready");
            } else {
              if (isCancellation(r.reason)) throw r.reason;
              await ingest.setSourceStatus(batch[j]!, "failed", toJobError(r.reason).message);
            }
          }
          done += batch.length;
          await bookkeeping.reportProgress(input.jobId, 50 + Math.round((done / children.length) * 45), `Indexed ${done} of ${children.length} pages`);
        }
        usage.pages = children.length;
      } else {
        await bookkeeping.reportProgress(input.jobId, 10, input.kind === "media" ? "Transcribing" : "Reading");
        if (input.kind === "url") {
          const r = await ingest.fetchUrlSource(input);
          usage.pages = 1;
          if (!r.changed) usage.unchanged = true;
        } else if (input.kind === "file" || input.kind === "drive") {
          const r = await ingest.parseFileSource(input);
          usage.chars = r.chars;
        } else if (input.kind === "media") {
          const r = await transcription.transcribeMediaSource({ ...input, maxMinutes: input.maxMinutes ?? 60 });
          usage.minutes = r.minutes;
        }
        if (!usage.unchanged) {
          await bookkeeping.reportProgress(input.jobId, 60, "Indexing");
          const r = await ingest.indexSource(input.workspaceId, input.sourceId);
          chunks = r.chunks;
          embedded = r.embedded;
          if (input.kind === "text" || input.kind === "social_reference") usage.chars = r.chars;
        }
      }

      if (!usage.unchanged) {
        await bookkeeping.reportProgress(input.jobId, 95, "Summarising");
        try {
          await summarizer.summarizeSource(input.workspaceId, input.sourceId, input.jobId);
        } catch (e) {
          if (isCancellation(e)) throw e;   // a missing summary never fails ingestion
        }
      }
      const charged = await ingest.completeSource(input, usage);
      return { sourceId: input.sourceId, chunks, embedded, pages: usage.pages, minutes: usage.minutes, unchanged: usage.unchanged, charged };
    } catch (err) {
      await CancellationScope.nonCancellable(() => ingest.markSourceFailed(input, isCancellation(err) ? "Cancelled" : toJobError(err).message));
      throw err;
    }
  }, (r) => r.charged);
}

// ---------------------------------------------------------------------------
// Phase 4: strategy, weekly plans, campaign runner
// ---------------------------------------------------------------------------
export async function strategyWorkflow(input: StrategyInput): Promise<{ revision: number; notes: string[] }> {
  return runJob(input, async () => {
    try {
      await bookkeeping.reportProgress(input.jobId, 10, "Reading the Brand Kit, knowledge and calendar");
      const r = await planner.generateStrategyDraft(input);
      return r;
    } catch (err) {
      await CancellationScope.nonCancellable(() => runner.markStrategyFailed(input, isCancellation(err) ? "Cancelled" : toJobError(err).message));
      throw err;
    }
  });
}

export async function weeklyPlanWorkflow(input: WeeklyPlanInput): Promise<WeeklyPlanResult> {
  const total: WeeklyPlanResult = { created: 0, flagged: 0, unfilled: 0, skippedExisting: 0 };
  return runJob(input, async () => {
    for (let i = 0; i < input.weekStarts.length; i++) {
      await bookkeeping.reportProgress(input.jobId, 5 + Math.round((i / input.weekStarts.length) * 90), `Planning week of ${input.weekStarts[i]}`);
      const r = await planner.planWeek(input, input.weekStarts[i]!);
      total.created += r.created;
      total.flagged += r.flagged;
      total.unfilled += r.unfilled;
      total.skippedExisting += r.skippedExisting;
    }
    return total;
  }, (r) => (r.created === 0 ? 0 : input.chargeCredits));
}

export const pauseSignal = defineSignal("pause");
export const resumeSignal = defineSignal("resume");
export const cancelSignal = defineSignal<[string?]>("cancel");
export const wakeSignal = defineSignal("wake");
export const runnerStateQuery = defineQuery<RunnerState>("state");

/**
 * One per active campaign. Generates approved topics when they're due (immediately, or
 * leadDays before their date), never more than maxPerDay. Pause/resume/cancel arrive as
 * signals and take effect at once; the DB status is re-read every tick as a backstop.
 */
export async function campaignRunnerWorkflow(input: CampaignRunnerInput): Promise<{ generated: number; reason: string }> {
  const state: RunnerState = { paused: false, cancelled: false, generated: input.generated ?? 0, inFlight: 0, lastEvent: "started", nextCheckAt: null };
  let woke = false;
  let batch: CancellationScope | undefined;
  setHandler(pauseSignal, () => {
    state.paused = true;
    state.lastEvent = "paused";
  });
  setHandler(resumeSignal, () => {
    state.paused = false;
    woke = true;
    state.lastEvent = "resumed";
  });
  setHandler(cancelSignal, (reason) => {
    state.cancelled = true;
    state.lastEvent = `cancelled${reason ? `: ${reason}` : ""}`;
    batch?.cancel();   // in-flight generations are cancelled and release their credits
  });
  setHandler(wakeSignal, () => {
    woke = true;
  });
  setHandler(runnerStateQuery, () => ({ ...state }));

  for (let tick = 0; tick < 100; tick++) {
    if (state.cancelled) return { generated: state.generated, reason: "cancelled" };
    if (state.paused) {
      await condition(() => !state.paused || state.cancelled);
      continue;
    }
    const t = await runner.runnerTick(input);
    if (t.stop) return { generated: state.generated, reason: "campaign closed" };
    if (t.paused) {
      state.paused = true;
      continue;
    }
    if (t.finished) {
      await runner.completeCampaign(input);
      return { generated: state.generated, reason: "completed" };
    }

    if (t.due.length) {
      batch = new CancellationScope();
      try {
        await batch.run(async () => {
          const started: Array<{ topicId: string; done: Promise<unknown> }> = [];
          for (const topicId of t.due) {
            if (state.paused || state.cancelled) break;
            const start = await runner.reserveTopicGeneration(input, topicId);
            if (!start) continue;
            const child = await startChild(generateContentWorkflow, {
              workflowId: start.jobId, args: [start.input], parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
            });
            state.inFlight++;
            started.push({ topicId, done: child.result() });
          }
          const results = await Promise.allSettled(started.map((s) => s.done));
          state.inFlight = 0;
          for (let i = 0; i < results.length; i++) {
            const r = results[i]!;
            if (r.status === "fulfilled") state.generated++;
            else await CancellationScope.nonCancellable(() => runner.markTopicFailed(started[i]!.topicId, isCancellation(r.reason) ? "Cancelled" : toJobError(r.reason).message));
          }
        });
      } catch (e) {
        if (!isCancellation(e)) throw e;
      } finally {
        batch = undefined;
        state.inFlight = 0;
      }
      if (state.cancelled) return { generated: state.generated, reason: "cancelled" };
      continue;   // more may be due right away
    }

    state.nextCheckAt = t.nextDueAt;
    state.lastEvent = t.nextDueAt ? `waiting until ${t.nextDueAt}` : "waiting for approved topics";
    await runner.recordRunnerEvent(input, { message: state.lastEvent, nextCheckAt: t.nextDueAt, generated: state.generated });
    woke = false;
    const waitMs = t.nextDueAt ? Math.max(60_000, Date.parse(t.nextDueAt) - Date.now()) : 6 * 3600_000;
    await condition(() => woke || state.paused || state.cancelled, waitMs);
  }
  // keep history small for long campaigns
  return continueAsNew<typeof campaignRunnerWorkflow>({ ...input, generated: state.generated });
}

/** AI images / product photos on ComfyUI. Credits are charged per image actually produced. */
export async function generateImageWorkflow(input: GenerateImageInput): Promise<GenerateContentResult & { assetIds: string[] }> {
  return runJob(input, async () => {
    await bookkeeping.reportProgress(input.jobId, 5, "Queued on the image server");
    const r = await gpu.generateImage(input);
    await bookkeeping.reportProgress(input.jobId, 95, `${r.assetIds.length} image(s) ready`);
    return r;
  }, (r) => Math.min(input.chargeCredits, (input.chargeCredits / Math.max(1, input.count)) * r.assetIds.length));
}

// ---------------------------------------------------------------------------
// Phase 6: media processing and video rendering
// ---------------------------------------------------------------------------
export async function probeMediaWorkflow(input: ProbeMediaInput) {
  return runJob(input, () => media.probeMedia(input), () => 0);
}

export async function importDriveMediaWorkflow(input: ImportDriveMediaInput) {
  return runJob(input, async () => {
    await bookkeeping.reportProgress(input.jobId, 10, `Importing ${input.name}`);
    return media.importDriveMedia(input);
  }, () => 0);
}

/** Final renders are charged per started minute of output; previews are free. */
export async function renderVideoWorkflow(input: RenderVideoInput): Promise<RenderVideoResult> {
  return runJob(input, async () => {
    try {
      await bookkeeping.reportProgress(input.jobId, 5, input.mode === "final" ? "Preparing the final render" : "Preparing a preview");
      return await renderer.renderVideo(input);
    } catch (err) {
      if (input.mode === "final") await CancellationScope.nonCancellable(() => renderer.markRenderFailed(input, isCancellation(err) ? "Cancelled" : toJobError(err).message));
      throw err;
    }
  }, (r) => (input.mode === "final" ? Math.min(input.chargeCredits, Math.ceil(r.durationMs / 60_000) * 0.5) : 0));
}

// ---------------------------------------------------------------------------------------------
// Publishing: wait for the time, claim through the approval gate, publish, confirm.
// ---------------------------------------------------------------------------------------------
const publishBook = proxyActivities<Pick<PublishActivities, "loadScheduleState" | "claimSchedule" | "finishTarget">>({
  startToCloseTimeout: "30 seconds",
  retry: { initialInterval: "2 seconds", backoffCoefficient: 2, maximumAttempts: 10 },
});
/** Retries cover network/5xx/rate limits (30 s → 2 → 8 → 30 min); rejections and expired logins fail at once. */
const publisher = proxyActivities<Pick<PublishActivities, "publishTarget">>({
  startToCloseTimeout: "10 minutes",
  retry: { initialInterval: "30 seconds", backoffCoefficient: 4, maximumInterval: "30 minutes", maximumAttempts: 5, nonRetryableErrorTypes: ["publish_rejected", "reconnect_needed", ...NON_RETRYABLE] },
});
const publishCheck = proxyActivities<Pick<PublishActivities, "checkPostiz">>({
  startToCloseTimeout: "1 minute",
  retry: { initialInterval: "10 seconds", backoffCoefficient: 2, maximumAttempts: 5, nonRetryableErrorTypes: ["reconnect_needed"] },
});

const DAY = 86_400_000;
/** Postiz confirmation polling: fast at first (failures show within a minute), then slower, for 24 h. */
export function publishPollDelays(): number[] {
  const d: number[] = [10_000, 15_000, 15_000, 20_000, 30_000, 30_000];
  for (let t = 0; t < 2 * 3_600_000; t += 60_000) d.push(60_000);
  for (let t = 0; t < 22 * 3_600_000; t += 600_000) d.push(600_000);
  return d;
}

function failureOf(err: unknown): { kind: string; message: string } {
  const cause = (err as ActivityFailure)?.cause as { type?: string; message?: string } | undefined;
  return { kind: cause?.type ?? "failed", message: cause?.message ?? (err as Error)?.message ?? "Publishing failed." };
}

export async function publishScheduleWorkflow(input: PublishScheduleInput): Promise<PublishScheduleResult> {
  // 1. wait until publish time (re-reading the row so reschedules and cancels are honoured)
  for (;;) {
    const s = await publishBook.loadScheduleState(input.scheduleId);
    if (!s) return "not_found";
    if (s.revision !== input.revision) return "superseded";
    if (s.status !== "scheduled" || !s.enabled) return "not_scheduled";
    const wait = Date.parse(s.publishAt) - Date.now();
    if (wait <= 0) break;
    await sleep(Math.min(wait, DAY));
  }
  // 2. approval gate (in SQL): approved, unchanged since approval, account active
  const claim = await publishBook.claimSchedule({ scheduleId: input.scheduleId, revision: input.revision });
  if (!claim.ok) return (claim.reason as PublishScheduleResult) ?? "blocked";

  // 3. publish; Postiz posts are confirmed by polling, and a transient Postiz error is retried by re-posting
  for (let attempt = 1; ; attempt++) {
    let out;
    try {
      out = await publisher.publishTarget({ scheduleId: input.scheduleId });
    } catch (err) {
      await publishBook.finishTarget({ scheduleId: input.scheduleId, status: "failed", error: failureOf(err) });
      return "failed";
    }
    if (out.outcome === "published") {
      await publishBook.finishTarget({ scheduleId: input.scheduleId, status: "published", externalId: out.externalId, url: out.url });
      return "published";
    }
    let retry = false;
    for (const delay of publishPollDelays()) {
      await sleep(delay);
      const c = await publishCheck.checkPostiz({ scheduleId: input.scheduleId, postId: out.externalId });
      if (c.state === "PUBLISHED") {
        await publishBook.finishTarget({ scheduleId: input.scheduleId, status: "published", externalId: out.externalId, url: c.url });
        return "published";
      }
      if (c.state === "ERROR" || c.state === "MISSING") {
        const message = c.state === "MISSING" ? "The post disappeared from Postiz (deleted there?)." : c.error || "The platform rejected the post.";
        const kind = classifyPublishMessage(message);
        if (kind === "transient" && attempt < 3) { retry = true; await sleep(attempt * 120_000); break; }
        await publishBook.finishTarget({ scheduleId: input.scheduleId, status: "failed", externalId: out.externalId, error: { kind: kind === "auth" ? "reconnect_needed" : "publish_rejected", message } });
        return "failed";
      }
    }
    if (!retry) {
      await publishBook.finishTarget({ scheduleId: input.scheduleId, status: "failed", externalId: out.externalId, error: { kind: "unconfirmed", message: "No confirmation from Postiz within 24 hours; check the post in Postiz." } });
      return "failed";
    }
  }
}

/** Workflow-safe copy of core classifyFailure (workflows can't import runtime packages with side effects). */
function classifyPublishMessage(m: string): "auth" | "transient" | "content" {
  if (/re-?authenticat|access token|token (?:has )?expired|revoked|invalid_grant|unauthori[sz]ed|reconnect/i.test(m)) return "auth";
  if (/rate.?limit|too many requests|temporar|unavailable|timed? ?out|try again|internal server error|bad gateway/i.test(m)) return "transient";
  return "content";
}

// ---------------------------------------------------------------------------------------------
// Analytics: pull every connected source, score matured posts, refresh insights per brand.
// ---------------------------------------------------------------------------------------------
const analytics = proxyActivities<AnalyticsActivities>({
  startToCloseTimeout: "15 minutes",
  retry: { initialInterval: "30 seconds", backoffCoefficient: 2, maximumAttempts: 3, nonRetryableErrorTypes: NON_RETRYABLE },
});

export async function analyticsSyncWorkflow(input: AnalyticsSyncInput): Promise<AnalyticsSyncResult> {
  const sources: AnalyticsSyncResult["sources"] = [];
  if (!input.insightsOnly) {
    sources.push(...await analytics.syncPostMetrics({ workspaceId: input.workspaceId }));
    sources.push(await analytics.syncAccountMetrics({ workspaceId: input.workspaceId }));
    sources.push(...await analytics.syncSiteMetrics({ workspaceId: input.workspaceId }));
    sources.push(...await analytics.syncAdMetrics({ workspaceId: input.workspaceId }));
    // fresh spend numbers → pause campaigns on accounts over their monthly cap (opt-in per account)
    const guard = await adsBook.adSpendGuard({ workspaceId: input.workspaceId }).catch(() => ({ paused: 0 }));
    if (guard.paused) sources.push({ source: "ads:spend_guard", status: "paused", rows: guard.paused });
  }
  const outcomes = await analytics.recordOutcomes({ workspaceId: input.workspaceId });
  const insights: Record<string, number> = {};
  if (input.skipInsights) return { sources, outcomes, insights };
  const brands = input.brandId ? [input.brandId] : await analytics.listBrands(input.workspaceId);
  for (const brandId of brands) {
    const r = await analytics.generateInsights({ workspaceId: input.workspaceId, brandId });
    for (const [k, n] of Object.entries(r.kinds)) insights[k] = (insights[k] ?? 0) + n;
  }
  return { sources, outcomes, insights };
}

/**
 * Started every 2 hours by the Temporal schedule "analytics-daily": one child sync per workspace
 * (metrics land within ~2 h of the platform reporting them). Insights are recalculated once a
 * night (the 20:00–22:00 UTC run, ≈ 02:00 IST).
 */
export async function analyticsDailyWorkflow(): Promise<number> {
  const workspaces = await analytics.listAnalyticsWorkspaces();
  const now = new Date(Date.now());
  const slot = now.toISOString().slice(0, 13);   // one run per workspace per hour
  const nightly = now.getUTCHours() >= 20 && now.getUTCHours() < 22;
  for (const workspaceId of workspaces) {
    await startChild(analyticsSyncWorkflow, {
      workflowId: `analytics-sync:${workspaceId}:${slot}`, args: [{ workspaceId, skipInsights: !nightly }], parentClosePolicy: ParentClosePolicy.ABANDON,
    }).catch(() => undefined);   // already running for this slot
  }
  return workspaces.length;
}

// ---------------------------------------------------------------------------------------------
// Repurposing: one source → digest → one child generation per output (3 at a time).
// ---------------------------------------------------------------------------------------------
const repurposeModel = proxyActivities<Pick<RepurposeActivities, "digestRun">>({
  startToCloseTimeout: "5 minutes", heartbeatTimeout: "2 minutes",
  retry: { initialInterval: "5 seconds", backoffCoefficient: 2, maximumAttempts: 3, nonRetryableErrorTypes: [...NON_RETRYABLE, "conflict"] },
});
const repurposeBook = proxyActivities<Omit<RepurposeActivities, "digestRun">>({
  startToCloseTimeout: "30 seconds",
  retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumAttempts: 10, nonRetryableErrorTypes: NON_RETRYABLE },
});

export async function repurposeWorkflow(input: RepurposeInput): Promise<RepurposeResult> {
  return runJob(input, async () => {
    try {
      await repurposeModel.digestRun(input);
      await bookkeeping.reportProgress(input.jobId, 15, "Read the source");
      const todo = await repurposeBook.prepareOutputs(input);
      let done = 0;
      for (let i = 0; i < todo.length; i += 3) {
        const batch = todo.slice(i, i + 3);
        const results = await Promise.allSettled(batch.map((t) => executeChild(generateContentWorkflow, { workflowId: t.input.jobId, args: [t.input], parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL })));
        for (let k = 0; k < batch.length; k++) {
          const r = results[k]!;
          await repurposeBook.finishOutput({ runId: input.runId, index: batch[k]!.index, ...(r.status === "fulfilled" ? { contentItemId: r.value.contentItemId } : { error: toJobError(r.reason).message }) });
          done++;
        }
        await bookkeeping.reportProgress(input.jobId, 15 + Math.round((done / Math.max(1, todo.length)) * 80), `${done} of ${todo.length} pieces written`);
      }
      const fin = await repurposeBook.finishRun({ runId: input.runId });
      if (!fin.succeeded) throw ApplicationFailure.create({ type: "upstream_error", message: "None of the pieces could be written.", nonRetryable: true });
      return { runId: input.runId, ...fin };
    } catch (err) {
      await CancellationScope.nonCancellable(() => repurposeBook.markRunFailed({ runId: input.runId, message: isCancellation(err) ? "Cancelled" : toJobError(err).message }));
      throw err;
    }
  }, (r) => Math.min(input.chargeCredits, r.credits));
}

// ---------------------------------------------------------------------------------------------
// Billing maintenance (every 15 min): usage events → Lago, expire stale credit holds.
// ---------------------------------------------------------------------------------------------
const billing = proxyActivities<BillingActivities>({ startToCloseTimeout: "5 minutes", retry: { initialInterval: "10 seconds", backoffCoefficient: 2, maximumAttempts: 3 } });

const services = proxyActivities<ServiceActivities>({ startToCloseTimeout: "5 minutes", retry: { initialInterval: "10 seconds", backoffCoefficient: 2, maximumAttempts: 3 } });

export async function billingMaintenanceWorkflow(): Promise<{ sent: number; expired: number; reconciled: number; services?: { extended: number; overdue: number; reminded: number } }> {
  // service holds are extended first, so long-running human work never loses its hold
  const svc = await services.serviceMaintenance().catch(() => undefined);
  const expired = await billing.expireReservations();
  const reconciled = await billing.reconcileTopups();
  const { sent } = await billing.syncUsage();
  return { sent, expired, reconciled, ...(svc && { services: svc }) };
}

// ---------------------------------------------------------------------------------------------
// Phase 11: SEO / AEO research, SEO articles, ads (drafting, approved actions, spend guard).
// ---------------------------------------------------------------------------------------------
const research = proxyActivities<Pick<SeoActivities, "competitorResearch" | "keywordResearch" | "prepareSeoArticle">>({
  startToCloseTimeout: "15 minutes", heartbeatTimeout: "3 minutes",
  retry: { initialInterval: "10 seconds", backoffCoefficient: 2, maximumAttempts: 3, nonRetryableErrorTypes: [...NON_RETRYABLE, "conflict"] },
});
const researchBook = proxyActivities<Pick<SeoActivities, "finishSeoArticle" | "markResearchFailed">>({
  startToCloseTimeout: "2 minutes", retry: { initialInterval: "2 seconds", backoffCoefficient: 2, maximumAttempts: 5, nonRetryableErrorTypes: NON_RETRYABLE },
});
const adsModel = proxyActivities<Pick<AdsActivities, "draftAdCampaign">>({
  startToCloseTimeout: "10 minutes", heartbeatTimeout: "3 minutes",
  retry: { initialInterval: "10 seconds", backoffCoefficient: 2, maximumAttempts: 2, nonRetryableErrorTypes: [...NON_RETRYABLE, "conflict"] },
});
// money-moving calls: few attempts; the sidecar's create is retry-safe by name and updates are idempotent
const adsExec = proxyActivities<Pick<AdsActivities, "executeAdAction">>({
  startToCloseTimeout: "5 minutes",
  retry: { initialInterval: "30 seconds", backoffCoefficient: 2, maximumAttempts: 3, nonRetryableErrorTypes: [...NON_RETRYABLE, "conflict", "forbidden"] },
});
const adsBook = proxyActivities<Pick<AdsActivities, "adSpendGuard" | "markAdsDraftFailed">>({
  startToCloseTimeout: "10 minutes", retry: { initialInterval: "30 seconds", backoffCoefficient: 2, maximumAttempts: 2, nonRetryableErrorTypes: NON_RETRYABLE },
});

export async function competitorResearchWorkflow(input: CompetitorResearchInput): Promise<{ pages: number; claims: number; credits: number }> {
  return runJob(input, async () => {
    try {
      await bookkeeping.reportProgress(input.jobId, 10, "Reading the competitor's site");
      return await research.competitorResearch(input);
    } catch (err) {
      await CancellationScope.nonCancellable(() => researchBook.markResearchFailed({ table: "competitors", id: input.competitorId, message: isCancellation(err) ? "Cancelled" : toJobError(err).message }));
      throw err;
    }
  }, (r) => Math.min(input.chargeCredits, r.credits));
}

export async function keywordResearchWorkflow(input: KeywordResearchInput): Promise<{ ideas: number; clusters: number; source: string; credits: number }> {
  return runJob(input, async () => {
    try {
      await bookkeeping.reportProgress(input.jobId, 10, "Finding keywords");
      return await research.keywordResearch(input);
    } catch (err) {
      await CancellationScope.nonCancellable(() => researchBook.markResearchFailed({ table: "keyword_sets", id: input.keywordSetId, message: isCancellation(err) ? "Cancelled" : toJobError(err).message }));
      throw err;
    }
  }, (r) => Math.min(input.chargeCredits, r.credits));
}

/** Brief (research) → article (blog.article@2, child job charged 0) → SEO/AEO report. */
export async function seoArticleWorkflow(input: SeoArticleInput): Promise<SeoArticleResult> {
  return runJob(input, async () => {
    await bookkeeping.reportProgress(input.jobId, 10, "Researching the brief");
    const { child, brief } = await research.prepareSeoArticle(input);
    await bookkeeping.reportProgress(input.jobId, 35, "Writing the article");
    const gen = await executeChild(generateContentWorkflow, { workflowId: child.jobId, args: [child], parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL });
    await bookkeeping.reportProgress(input.jobId, 90, "Scoring SEO and answer-readiness");
    const b = brief as { question: string; intent?: string };
    const rep = await researchBook.finishSeoArticle({ workspaceId: input.workspaceId, contentItemId: gen.contentItemId, keyword: input.keyword, secondary: input.secondary, question: b.question, intent: b.intent ?? null, keywordSetId: input.keywordSetId ?? null });
    return { contentItemId: gen.contentItemId, overall: rep.overall, credits: input.chargeCredits };
  }, (r) => r.credits);
}

export async function adsDraftWorkflow(input: AdsDraftInput): Promise<{ issues: number; credits: number }> {
  return runJob(input, async () => {
    try {
      await bookkeeping.reportProgress(input.jobId, 10, "Drafting brief, audience and copy");
      return await adsModel.draftAdCampaign(input);
    } catch (err) {
      await CancellationScope.nonCancellable(() => adsBook.markAdsDraftFailed({ campaignId: input.campaignId, message: isCancellation(err) ? "Cancelled" : toJobError(err).message }));
      throw err;
    }
  }, (r) => Math.min(input.chargeCredits, r.credits));
}

/** One approved ad action → platform call. No credits: spend happens on the ad platform's bill. */
export async function adActionWorkflow(input: AdActionInput): Promise<{ status: string; campaignStatus: string }> {
  return adsExec.executeAdAction({ actionId: input.actionId });
}
