import { ApplicationFailure, Context } from "@temporalio/activity";
import { digestSource, type LlmProvider } from "@arcatic/ai";
import {
  AppError, CONTENT_TYPE_DEFS, contentCost, estimateCredits, fromDbError, repurposeInput, repurposeOutputById,
  type ContentDoc, type Digest, type SourceRef,
} from "@arcatic/core";
import type { Db } from "@arcatic/database";
import { activeBrandContext } from "./content-activity.js";
import type { GenerateContentInput, RepurposeInput } from "./contracts.js";

/**
 * Repurposing: read the source once into a digest, then one child generation per requested
 * output. The parent job holds the credit reservation for the whole run; children are charged 0
 * and the parent settles digest + outputs that succeeded.
 */
export interface RepurposeDeps { db: Db; llm: LlmProvider }

type OutputRow = { outputId: string; type: string; channel?: string | null; status: "queued" | "running" | "succeeded" | "failed"; jobId?: string; contentItemId?: string; error?: string };
type Run = {
  id: string; workspace_id: string; brand_id: string; project_id: string | null; source_kind: "source" | "content"; source_id: string | null; source_item_id: string | null;
  source_ref: SourceRef; outputs: OutputRow[]; language: string; digest: Digest | null; status: string;
};

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw ApplicationFailure.create({ type: err.code, message: err.message, nonRetryable: !err.retryable });
    throw err;
  }
}

const CHUNK = 2000;
function docChunks(itemId: string, doc: ContentDoc): Array<{ chunkId: string; content: string }> {
  const out: Array<{ chunkId: string; content: string }> = [];
  let buf = "";
  for (const b of doc.blocks) {
    if (!b.text.trim() || ["alt_text", "image_prompt", "meta_description"].includes(b.kind)) continue;
    if (buf.length + b.text.length > CHUNK && buf) { out.push({ chunkId: `content:${itemId}:${out.length + 1}`, content: buf.trim() }); buf = ""; }
    buf += `${b.text}\n\n`;
  }
  if (buf.trim()) out.push({ chunkId: `content:${itemId}:${out.length + 1}`, content: buf.trim() });
  return out;
}

export function createRepurposeActivities({ db, llm }: RepurposeDeps) {
  const one = async <T>(q: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>): Promise<T> => {
    const r = await q;
    if (r.error) throw fromDbError(r.error as never);
    return r.data as T;
  };
  const load = (runId: string) => one<Run>(db.from("repurpose_runs").select("*").eq("id", runId).single());

  return {
    /** Idempotent: a run that already has a digest returns it. */
    async digestRun(input: RepurposeInput): Promise<{ points: number; truncated: boolean }> {
      return wrap(async () => {
        const run = await load(input.runId);
        if (run.digest) return { points: run.digest.key_points.length, truncated: false };
        await one(db.from("repurpose_runs").update({ status: "digesting", generation_job_id: input.jobId }).eq("id", run.id));
        let chunks: Array<{ chunkId: string; content: string }>;
        let kindLabel = "document";
        if (run.source_kind === "source") {
          const src = await one<{ id: string; status: string; type: string; title: string }>(db.from("sources").select("id, status, type, title").eq("id", run.source_id!).single());
          if (src.status !== "ready") throw new AppError("conflict", "The source is still being processed; try again when it's ready.");
          kindLabel = src.type === "media" ? "video transcript" : src.type === "url" || src.type === "crawl" ? "web page" : "document";
          const children = await one<Array<{ id: string }>>(db.from("sources").select("id").eq("parent_source_id", src.id).eq("status", "ready").limit(50));
          const ids = [src.id, ...children.map((c) => c.id)];
          const rows = await one<Array<{ id: string; source_id: string; ordinal: number; content: string }>>(db.from("knowledge_chunks").select("id, source_id, ordinal, content").in("source_id", ids).order("ordinal").limit(400));
          rows.sort((a, b) => ids.indexOf(a.source_id) - ids.indexOf(b.source_id) || a.ordinal - b.ordinal);
          chunks = rows.map((r) => ({ chunkId: r.id, content: r.content }));
        } else {
          const item = await one<{ id: string; current_version_id: string | null }>(db.from("content_items").select("id, current_version_id").eq("id", run.source_item_id!).single());
          const v = await one<{ body: { doc?: ContentDoc } }>(db.from("content_versions").select("body").eq("id", item.current_version_id!).single());
          chunks = docChunks(item.id, v.body.doc ?? { format: 1, blocks: [] });
          kindLabel = "article";
        }
        if (!chunks.length) throw new AppError("validation_failed", "The source has no text to work from.");
        Context.current().heartbeat();
        const brand = await activeBrandContext(db, run.workspace_id, run.brand_id);
        const r = await digestSource(llm, { brand, title: run.source_ref.title, kindLabel, chunks, language: run.language }, { workspaceId: run.workspace_id, jobId: input.jobId });
        await one(db.from("repurpose_runs").update({ digest: r.digest, status: "generating" }).eq("id", run.id));
        return { points: r.digest.key_points.length, truncated: r.truncated };
      });
    },

    /** One child job per output (job rows created once; retries reuse them). */
    async prepareOutputs(input: RepurposeInput): Promise<Array<{ index: number; input: GenerateContentInput }>> {
      return wrap(async () => {
        const run = await load(input.runId);
        if (!run.digest) throw new AppError("conflict", "Digest missing.");
        const outputs = [...run.outputs];
        const res: Array<{ index: number; input: GenerateContentInput }> = [];
        for (let i = 0; i < outputs.length; i++) {
          const o = outputs[i]!;
          if (o.status === "succeeded") continue;
          const def = repurposeOutputById(o.outputId);
          if (!def) { outputs[i] = { ...o, status: "failed", error: "Unknown output" }; continue; }
          const gen = repurposeInput(run.digest, def, { language: run.language, ref: run.source_ref, angleIndex: i });
          const key = `repurpose:${run.id}:${i}`;
          let jobId = o.jobId;
          if (!jobId) {
            jobId = crypto.randomUUID();
            const ins = await db.from("generation_jobs").insert({ id: jobId, workspace_id: run.workspace_id, brand_id: run.brand_id, kind: `generate.${def.type}`, idempotency_key: key, input: { repurposeRunId: run.id, output: def.id }, estimated_credits: 0 });
            if (ins.error?.code === "23505") jobId = (await one<{ id: string }>(db.from("generation_jobs").select("id").eq("workspace_id", run.workspace_id).eq("idempotency_key", key).single())).id;
            else if (ins.error) throw fromDbError(ins.error);
          }
          outputs[i] = { ...o, jobId, status: "running" };
          res.push({ index: i, input: {
            jobId, workspaceId: run.workspace_id, brandId: run.brand_id, chargeCredits: 0, templateKey: gen.templateKey, input: gen.input,
            referenceSourceIds: run.source_kind === "source" && run.source_id ? [run.source_id] : undefined,
            projectId: run.project_id ?? undefined, repurposeRunId: run.id, sourceRef: run.source_ref, requestedBy: input.requestedBy,
          } });
        }
        await one(db.from("repurpose_runs").update({ outputs }).eq("id", run.id));
        return res;
      });
    },

    async finishOutput(a: { runId: string; index: number; contentItemId?: string; error?: string }): Promise<void> {
      return wrap(async () => {
        const run = await load(a.runId);
        const outputs = [...run.outputs];
        outputs[a.index] = { ...outputs[a.index]!, status: a.contentItemId ? "succeeded" : "failed", contentItemId: a.contentItemId, error: a.error?.slice(0, 300) };
        await one(db.from("repurpose_runs").update({ outputs }).eq("id", run.id));
      });
    },

    /** Final status and the credits to charge: the digest + each output that was created. */
    async finishRun(a: { runId: string }): Promise<{ status: string; succeeded: number; failed: number; credits: number }> {
      return wrap(async () => {
        const run = await load(a.runId);
        const ok = run.outputs.filter((o) => o.status === "succeeded");
        const failed = run.outputs.length - ok.length;
        const status = !ok.length ? "failed" : failed ? "partial" : "succeeded";
        const credits = estimateCredits({ kind: "repurpose.digest" }).estimate
          + ok.reduce((s, o) => s + (o.type in CONTENT_TYPE_DEFS ? contentCost(o.type as never).estimate : 0), 0);
        await one(db.from("repurpose_runs").update({ status }).eq("id", run.id));
        return { status, succeeded: ok.length, failed, credits: Math.round(credits * 1000) / 1000 };
      });
    },

    async markRunFailed(a: { runId: string; message: string }): Promise<void> {
      await db.from("repurpose_runs").update({ status: "failed" }).eq("id", a.runId).in("status", ["queued", "digesting", "generating"]);
    },
  };
}

export type RepurposeActivities = ReturnType<typeof createRepurposeActivities>;
