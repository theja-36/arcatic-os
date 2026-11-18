/** Workflow inputs. Keep JSON-serialisable and backwards compatible (in-flight workflows replay them). */
export interface BaseJobInput {
  jobId: string;          // = generation_jobs.id = Temporal workflowId
  workspaceId: string;
  reservationId?: string; // credit hold made by apps/api before start
  /** Credits charged on success; never above the reservation. */
  chargeCredits: number;
}

export interface SelfTestInput extends BaseJobInput {
  steps: number;
  failAtStep?: number;
}

export type GenerationMode = "create" | "regenerate" | "transform" | "translate";

export interface GenerateContentInput extends BaseJobInput {
  brandId: string;
  /** default "create"; the others work on contentItemId's current version */
  mode?: GenerationMode;
  focus?: string;
  transform?: "improve" | "simplify" | "shorten" | "expand" | "rewrite" | "fix_grammar" | "tone";
  tone?: string;
  instruction?: string;
  targetLanguage?: string;
  blockIds?: string[];
  modelTier?: "economy" | "standard" | "premium";
  /** knowledge sources to draw from (else the whole library) */
  referenceSourceIds?: string[];
  /** images shown to the model (captions) */
  referenceMediaIds?: string[];
  /** visual posts: canvas size, layout and optional background photo */
  visual?: { preset: string; template: string; imageAssetId?: string | null };
  /** set when generating a planned topic: the result is linked back to it */
  topicId?: string;
  campaignId?: string;
  templateKey: string;    // 'social.post@1'
  input: Record<string, unknown>;
  contentItemId?: string; // regenerate into an existing item
  requestedBy?: string;
  /** growth suite: file the new item in a project; repurposing lineage + attribution */
  projectId?: string;
  repurposeRunId?: string;
  sourceRef?: import("@arcatic/core").SourceRef;
}

export interface GenerateContentResult {
  contentItemId: string;
  contentVersionId: string;
  validationPassed: boolean;
}

export interface BrandAnalysisInput extends BaseJobInput {
  brandId: string;
  url: string;
  maxPages: number;
  /** re-run extraction for these kit paths only ("Suggest again") */
  paths?: string[];
  useFirecrawlBranding?: boolean;
  requestedBy?: string;
}

export interface ScrapedPageRef {
  sourceId: string;
  url: string;
  type: string;
  chars: number;
}

export interface BrandAnalysisResult {
  kitVersionId: string;
  version: number;
  pagesAnalysed: number;
  pagesFailed: number;
  fieldsSuggested: number;
  changedFactIds: string[];
  citationsKept: number;
  citationsDropped: number;
}

export type SourceKind = "url" | "crawl" | "file" | "drive" | "media" | "text" | "social_reference";

export interface IngestSourceInput extends BaseJobInput {
  brandId: string;
  sourceId: string;
  kind: SourceKind;
  maxMinutes?: number;   // media only
  requestedBy?: string;
  /** crawl status poll interval (default 15 s) */
  pollSeconds?: number;
}

export interface IngestSourceResult {
  sourceId: string;
  chunks: number;
  embedded: number;
  pages?: number;
  minutes?: number;
  unchanged?: boolean;
  charged: number;
}

export interface StrategyInput extends BaseJobInput {
  brandId: string;
  strategyId: string;
  weekStarts: string[];
  channels: string[];
  goals?: string[];
  constraints?: string;
  focus?: string;
  requestedBy?: string;
}

export interface WeeklyPlanInput extends BaseJobInput {
  brandId: string;
  strategyId: string;
  weekStarts: string[];
  autoApprove: boolean;
  campaignId?: string;
  requestedBy?: string;
}

export interface WeeklyPlanResult {
  created: number;
  flagged: number;
  unfilled: number;
  skippedExisting: number;
}

export interface CampaignRunnerInput {
  workspaceId: string;
  brandId: string;
  campaignId: string;
  /** carried across continue-as-new */
  generated?: number;
}

export interface RunnerState {
  paused: boolean;
  cancelled: boolean;
  generated: number;
  inFlight: number;
  lastEvent: string;
  nextCheckAt: string | null;
}

export interface GenerateImageInput extends BaseJobInput {
  brandId: string;
  contentType: "image" | "product_photo";
  prompt: string;
  preset: string;              // SIZE_PRESETS key → SDXL bucket
  count: number;               // 1–4
  modelKey: string;            // ai_models.key
  productAssetId?: string;     // img2img source (product photo)
  denoise?: number;
  seed?: number;
  contentItemId?: string;
  requestedBy?: string;
}

export interface ProbeMediaInput extends BaseJobInput {
  assetId: string;
}

export interface RenderVideoInput extends BaseJobInput {
  brandId: string;
  projectId: string;
  revision: number;
  mode: "preview" | "final";
  requestedBy?: string;
}

export interface RenderVideoResult {
  assetId: string;
  durationMs: number;
  width: number;
  height: number;
  seconds: number;
}

export interface ImportDriveMediaInput extends BaseJobInput {
  brandId?: string;
  secretId: string;
  fileId: string;
  name: string;
  collectionId?: string;
  requestedBy?: string;
}

/** Not a generation job: publishing costs no credits. workflowId = publish:<schedule>:<revision>. */
export interface PublishScheduleInput {
  scheduleId: string;
  revision: number;
}
export type PublishScheduleResult = "published" | "failed" | "superseded" | "not_found" | "not_scheduled" | "blocked";
export const publishWorkflowId = (scheduleId: string, revision: number) => `publish:${scheduleId}:${revision}`;

export interface AnalyticsSyncInput { workspaceId: string; brandId?: string; insightsOnly?: boolean; skipInsights?: boolean }
export interface AnalyticsSyncResult { sources: Array<{ source: string; status: string; rows: number; error?: string }>; outcomes: number; insights: Record<string, number> }
export const ANALYTICS_SCHEDULE_ID = "analytics-daily";
export const BILLING_SCHEDULE_ID = "billing-maintenance";

/** Parent job of a repurpose run: digest once, then one child generation per output. */
export interface RepurposeInput extends BaseJobInput {
  brandId: string;
  runId: string;
  requestedBy?: string;
}
export interface RepurposeResult { runId: string; status: string; succeeded: number; failed: number; credits: number }

// ---- Phase 11: SEO / AEO research and ads
export interface CompetitorResearchInput extends BaseJobInput { brandId: string; competitorId: string; maxPages?: number }
export interface KeywordResearchInput extends BaseJobInput { brandId: string; keywordSetId: string; connectionId?: string; locationIds?: string[]; languageId?: string }
export interface SeoArticleInput extends BaseJobInput {
  brandId: string; keyword: string; secondary: string[]; competitorIds: string[]; language: string; words?: number;
  keywordSetId?: string | null; projectId?: string; requestedBy?: string;
}
export interface SeoArticleResult { contentItemId: string; overall: number; credits: number }
export interface AdsDraftInput extends BaseJobInput { campaignId: string; requestedBy?: string }
export interface AdActionInput { actionId: string; workspaceId: string }
export const adActionWorkflowId = (actionId: string) => `ad-action:${actionId}`;

export const WORKFLOWS = {
  selfTest: "selfTestWorkflow",
  repurpose: "repurposeWorkflow",
  analyticsSync: "analyticsSyncWorkflow",
  analyticsDaily: "analyticsDailyWorkflow",
  billingMaintenance: "billingMaintenanceWorkflow",
  publishSchedule: "publishScheduleWorkflow",
  generateContent: "generateContentWorkflow",
  brandAnalysis: "brandAnalysisWorkflow",
  ingestSource: "ingestSourceWorkflow",
  strategy: "strategyWorkflow",
  weeklyPlan: "weeklyPlanWorkflow",
  campaignRunner: "campaignRunnerWorkflow",
  generateImage: "generateImageWorkflow",
  probeMedia: "probeMediaWorkflow",
  renderVideo: "renderVideoWorkflow",
  importDriveMedia: "importDriveMediaWorkflow",
  competitorResearch: "competitorResearchWorkflow",
  keywordResearch: "keywordResearchWorkflow",
  seoArticle: "seoArticleWorkflow",
  adsDraft: "adsDraftWorkflow",
  adAction: "adActionWorkflow",
} as const;

export const runnerWorkflowId = (campaignId: string) => `campaign-runner:${campaignId}`;
