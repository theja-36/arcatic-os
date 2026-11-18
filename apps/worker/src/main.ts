import { createRequire } from "node:module";
import { AnthropicProvider } from "@arcatic/ai";
import { TASK_QUEUES } from "@arcatic/core";
import { dbConfigFromEnv, getServiceClient } from "@arcatic/database";
import { createActivities } from "@arcatic/jobs/activities";
import { createBrandActivities } from "@arcatic/jobs/brand-activities";
import { createKnowledgeActivities } from "@arcatic/jobs/knowledge-activities";
import { createStrategyActivities } from "@arcatic/jobs/strategy-activities";
import { createImageActivities } from "@arcatic/jobs/image-activity";
import { createMediaActivities } from "@arcatic/jobs/media-activities";
import { createPublishActivities } from "@arcatic/jobs/publish-activities";
import { createAnalyticsActivities } from "@arcatic/jobs/analytics-activities";
import { createRepurposeActivities } from "@arcatic/jobs/repurpose-activities";
import { createSeoActivities } from "@arcatic/jobs/seo-activities";
import { createAdsActivities } from "@arcatic/jobs/ads-activities";
import { createServiceActivities } from "@arcatic/jobs/service-activities";
import { createNotifier } from "@arcatic/jobs/notifier";
import { createBillingActivities } from "@arcatic/jobs/billing";
import { AdsSyncClient, LagoClient, mailerFromEnv, pushFromEnv, ComfyUiClient, DoclingClient, FirecrawlClient, LangfuseTracer, OpenAiCompatibleTranscriber, embedderFromEnv, langfuseFromEnv } from "@arcatic/integrations";
import { JobStarter, connectTemporal, temporalConfigFromEnv } from "@arcatic/jobs";
import { NativeConnection, Worker } from "@temporalio/worker";

/**
 * One process per task queue in production (scale ingest/gpu/publish independently);
 * locally a single worker serves arcatic-default. ARCATIC_TASK_QUEUE selects the queue.
 */
async function main() {
  const cfg = temporalConfigFromEnv();
  const connection = await NativeConnection.connect({
    address: cfg.address,
    ...(cfg.apiKey && { tls: true, apiKey: cfg.apiKey }),
  });

  const db = getServiceClient(dbConfigFromEnv());
  const langfuse = langfuseFromEnv();
  if (!langfuse) console.warn(JSON.stringify({ level: "warn", msg: "Langfuse not configured; AI runs are not traced" }));
  const llm = new AnthropicProvider(langfuse ? { tracer: new LangfuseTracer(langfuse) } : {});   // credentials resolved from ANTHROPIC_API_KEY / ant profile
  const ads = process.env.ADS_SYNC_URL && process.env.ADS_SYNC_SECRET ? new AdsSyncClient({ baseUrl: process.env.ADS_SYNC_URL, secret: process.env.ADS_SYNC_SECRET }) : null;
  const firecrawl = new FirecrawlClient({
    baseUrl: process.env.FIRECRAWL_URL ?? "http://localhost:3002",
    apiKey: process.env.FIRECRAWL_API_KEY || undefined,
  });
  const embedder = embedderFromEnv();
  if (!embedder) console.warn(JSON.stringify({ level: "warn", msg: "No embedding service configured; knowledge search will be keyword-only" }));
  const activities = {
    ...createActivities({ db, llm, embedder }),
    ...createBrandActivities({ db, llm, firecrawl }),
    ...createStrategyActivities({ db, llm, embedder }),
    ...createMediaActivities({ db, ffmpegBin: process.env.FFMPEG_PATH, ffprobeBin: process.env.FFPROBE_PATH, fontFile: process.env.RENDER_FONT_FILE, encryptionKey: process.env.ENCRYPTION_KEY }),
    ...createPublishActivities({ db, encryptionKey: process.env.ENCRYPTION_KEY }),
    ...createAnalyticsActivities({ db, encryptionKey: process.env.ENCRYPTION_KEY, ads, langfuse }),
    ...createRepurposeActivities({ db, llm }),
    ...createSeoActivities({ db, llm, firecrawl, embedder, ads, encryptionKey: process.env.ENCRYPTION_KEY }),
    ...createAdsActivities({ db, llm, ads, embedder, encryptionKey: process.env.ENCRYPTION_KEY }),
    ...createServiceActivities({ db, appUrl: process.env.APP_URL, notifier: createNotifier({ db, push: pushFromEnv(), mailer: mailerFromEnv(), appUrl: process.env.APP_URL }) }),
    ...createBillingActivities({ db, lago: process.env.LAGO_API_URL && process.env.LAGO_API_KEY ? new LagoClient({ baseUrl: process.env.LAGO_API_URL, apiKey: process.env.LAGO_API_KEY }) : null }),
    ...createImageActivities({ db, comfy: new ComfyUiClient({ baseUrl: process.env.COMFYUI_URL ?? "http://localhost:8188", sharedSecret: process.env.COMFYUI_SHARED_SECRET || undefined }) }),
    ...createKnowledgeActivities({
      db, llm, firecrawl, embedder,
      docling: new DoclingClient({ baseUrl: process.env.DOCLING_SERVICE_URL ?? "http://localhost:5001", apiKey: process.env.DOCLING_API_KEY || undefined }),
      transcriber: new OpenAiCompatibleTranscriber({ baseUrl: process.env.WHISPER_URL ?? "http://localhost:9000", model: process.env.WHISPER_MODEL, apiKey: process.env.WHISPER_API_KEY || undefined }),
      ffmpegBin: process.env.FFMPEG_PATH, ffprobeBin: process.env.FFPROBE_PATH,
      encryptionKey: process.env.ENCRYPTION_KEY,
    }),
  };

  const require = createRequire(import.meta.url);
  const worker = await Worker.create({
    connection,
    namespace: cfg.namespace,
    taskQueue: process.env.ARCATIC_TASK_QUEUE || TASK_QUEUES.default,
    workflowsPath: require.resolve("@arcatic/jobs/workflows"),
    activities,
    maxConcurrentActivityTaskExecutions: Number(process.env.WORKER_MAX_ACTIVITIES ?? 20),
  });

  if ((process.env.ARCATIC_TASK_QUEUE || TASK_QUEUES.default) === TASK_QUEUES.default) {
    const starter = new JobStarter(await connectTemporal(cfg));
    await starter.ensureAnalyticsSchedule().catch((e) => console.warn(JSON.stringify({ level: "warn", msg: "Could not create the analytics schedule", error: String(e) })));
    await starter.ensureBillingSchedule().catch((e) => console.warn(JSON.stringify({ level: "warn", msg: "Could not create the billing schedule", error: String(e) })));
  }

  const shutdown = () => worker.shutdown();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log(JSON.stringify({ level: "info", msg: "arcatic worker started", taskQueue: worker.options.taskQueue }));
  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
