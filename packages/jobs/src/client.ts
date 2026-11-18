import { Client, Connection, ScheduleAlreadyRunning, WorkflowIdReusePolicy, WorkflowNotFoundError } from "@temporalio/client";
import { TASK_QUEUES, type TaskQueue } from "@arcatic/core";
import { ANALYTICS_SCHEDULE_ID, BILLING_SCHEDULE_ID, WORKFLOWS, adActionWorkflowId, publishWorkflowId, runnerWorkflowId, type AdActionInput, type AdsDraftInput, type CompetitorResearchInput, type KeywordResearchInput, type SeoArticleInput, type BrandAnalysisInput, type CampaignRunnerInput, type GenerateContentInput, type IngestSourceInput, type RunnerState, type SelfTestInput, type StrategyInput, type WeeklyPlanInput, type GenerateImageInput, type ProbeMediaInput, type RenderVideoInput, type ImportDriveMediaInput, type RepurposeInput } from "./contracts.js";

export interface TemporalConfig {
  address: string;
  namespace: string;
  apiKey?: string;
}

export function temporalConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TemporalConfig {
  return { address: env.TEMPORAL_ADDRESS ?? "localhost:7233", namespace: env.TEMPORAL_NAMESPACE ?? "default", apiKey: env.TEMPORAL_API_KEY || undefined };
}

export async function connectTemporal(cfg: TemporalConfig): Promise<Client> {
  const connection = await Connection.connect({ address: cfg.address, ...(cfg.apiKey && { tls: true, apiKey: cfg.apiKey }) });
  return new Client({ connection, namespace: cfg.namespace });
}

/** workflowId = job id, and REJECT_DUPLICATE → starting a job twice can never run it twice. */
export class JobStarter {
  constructor(private readonly client: Client) {}

  private start(workflow: string, taskQueue: TaskQueue, jobId: string, args: unknown[]) {
    return this.client.workflow.start(workflow, {
      workflowId: jobId,
      taskQueue,
      args,
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    });
  }

  selfTest(input: SelfTestInput) {
    return this.start(WORKFLOWS.selfTest, TASK_QUEUES.default, input.jobId, [input]);
  }

  generateContent(input: GenerateContentInput) {
    return this.start(WORKFLOWS.generateContent, TASK_QUEUES.default, input.jobId, [input]);
  }

  brandAnalysis(input: BrandAnalysisInput) {
    return this.start(WORKFLOWS.brandAnalysis, TASK_QUEUES.default, input.jobId, [input]);
  }

  ingestSource(input: IngestSourceInput) {
    const queue = input.kind === "media" ? TASK_QUEUES.default : TASK_QUEUES.default;   // split to arcatic-ingest / arcatic-gpu when those workers exist
    return this.start(WORKFLOWS.ingestSource, queue, input.jobId, [input]);
  }

  generateImage(input: GenerateImageInput) {
    return this.start(WORKFLOWS.generateImage, (process.env.ARCATIC_GPU_TASK_QUEUE as TaskQueue | undefined) ?? TASK_QUEUES.default, input.jobId, [input]);
  }

  probeMedia(input: ProbeMediaInput) {
    return this.start(WORKFLOWS.probeMedia, TASK_QUEUES.default, input.jobId, [input]);
  }

  renderVideo(input: RenderVideoInput) {
    return this.start(WORKFLOWS.renderVideo, (process.env.ARCATIC_RENDER_TASK_QUEUE as TaskQueue | undefined) || TASK_QUEUES.default, input.jobId, [input]);
  }

  /** One workflow per schedule revision; starting the same revision twice is a no-op. */
  async publishSchedule(scheduleId: string, revision: number): Promise<void> {
    try {
      await this.client.workflow.start(WORKFLOWS.publishSchedule, {
        workflowId: publishWorkflowId(scheduleId, revision),
        taskQueue: TASK_QUEUES.default,
        args: [{ scheduleId, revision }],
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      });
    } catch (e) {
      if (!(e instanceof Error && e.name === "WorkflowExecutionAlreadyStartedError")) throw e;
    }
  }

  /** On-demand sync (or insights only). One per workspace at a time: a running one is reused. */
  async analyticsSync(input: { workspaceId: string; brandId?: string; insightsOnly?: boolean }, key: string): Promise<string> {
    const workflowId = `analytics-sync:${input.workspaceId}:${key}`;
    try {
      await this.client.workflow.start(WORKFLOWS.analyticsSync, { workflowId, taskQueue: TASK_QUEUES.default, args: [input], workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE });
    } catch (e) {
      if (!(e instanceof Error && e.name === "WorkflowExecutionAlreadyStartedError")) throw e;
    }
    return workflowId;
  }

  /** Every 15 minutes: Lago usage sync + expiry of stale credit holds. */
  async ensureBillingSchedule(): Promise<void> {
    try {
      await this.client.schedule.create({
        scheduleId: BILLING_SCHEDULE_ID,
        spec: { intervals: [{ every: "15m" }] },
        action: { type: "startWorkflow", workflowType: WORKFLOWS.billingMaintenance, taskQueue: TASK_QUEUES.default, args: [] },
      });
    } catch (e) {
      if (!(e instanceof ScheduleAlreadyRunning)) throw e;
    }
  }

  /** Every 2 hours (metrics); insights are recalculated in the nightly run. Safe to call on every worker start. */
  async ensureAnalyticsSchedule(): Promise<void> {
    try {
      await this.client.schedule.create({
        scheduleId: ANALYTICS_SCHEDULE_ID,
        spec: { intervals: [{ every: "2h", offset: "15m" }] },
        action: { type: "startWorkflow", workflowType: WORKFLOWS.analyticsDaily, taskQueue: TASK_QUEUES.default, args: [] },
      });
    } catch (e) {
      if (!(e instanceof ScheduleAlreadyRunning)) throw e;
    }
  }

  competitorResearch(input: CompetitorResearchInput) {
    return this.start(WORKFLOWS.competitorResearch, TASK_QUEUES.default, input.jobId, [input]);
  }
  keywordResearch(input: KeywordResearchInput) {
    return this.start(WORKFLOWS.keywordResearch, TASK_QUEUES.default, input.jobId, [input]);
  }
  seoArticle(input: SeoArticleInput) {
    return this.start(WORKFLOWS.seoArticle, TASK_QUEUES.default, input.jobId, [input]);
  }
  adsDraft(input: AdsDraftInput) {
    return this.start(WORKFLOWS.adsDraft, TASK_QUEUES.default, input.jobId, [input]);
  }
  /** Executes one approved ad action. One workflow per action id: a second start is a no-op. */
  async adAction(input: AdActionInput): Promise<string> {
    const workflowId = adActionWorkflowId(input.actionId);
    try {
      await this.client.workflow.start(WORKFLOWS.adAction, { workflowId, taskQueue: TASK_QUEUES.default, args: [input], workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE });
    } catch (e) {
      if (!(e instanceof Error && e.name === "WorkflowExecutionAlreadyStartedError")) throw e;
    }
    return workflowId;
  }

  repurpose(input: RepurposeInput) {
    return this.start(WORKFLOWS.repurpose, TASK_QUEUES.default, input.jobId, [input]);
  }

  importDriveMedia(input: ImportDriveMediaInput) {
    return this.start(WORKFLOWS.importDriveMedia, TASK_QUEUES.default, input.jobId, [input]);
  }

  strategy(input: StrategyInput) {
    return this.start(WORKFLOWS.strategy, TASK_QUEUES.default, input.jobId, [input]);
  }

  weeklyPlan(input: WeeklyPlanInput) {
    return this.start(WORKFLOWS.weeklyPlan, TASK_QUEUES.default, input.jobId, [input]);
  }

  /** Starts the campaign's runner, or wakes it if it is already running. */
  async ensureRunner(input: CampaignRunnerInput) {
    await this.client.workflow.signalWithStart(WORKFLOWS.campaignRunner, {
      workflowId: runnerWorkflowId(input.campaignId),
      taskQueue: TASK_QUEUES.default,
      args: [input],
      signal: "wake",
      signalArgs: [],
    });
  }

  /** Signals the runner; a runner that isn't running is fine (the DB status still applies). */
  async signalRunner(campaignId: string, signal: "pause" | "resume" | "cancel" | "wake", reason?: string): Promise<boolean> {
    try {
      await this.client.workflow.getHandle(runnerWorkflowId(campaignId)).signal(signal, ...(reason ? [reason] : []));
      return true;
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) return false;
      throw e;
    }
  }

  async runnerState(campaignId: string): Promise<RunnerState | null> {
    try {
      return await this.client.workflow.getHandle(runnerWorkflowId(campaignId)).query<RunnerState>("state");
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) return null;
      throw e;
    }
  }

  async cancel(jobId: string) {
    await this.client.workflow.getHandle(jobId).cancel();
  }
}
