import { ApplicationFailure, Context } from "@temporalio/activity";
import { buildImagePrompt, checkImagePrompt, sdxlSize } from "@arcatic/ai";
import { AppError, docFrom, fromDbError, imageDimensions, sniffFile, IMAGE_KINDS } from "@arcatic/core";
import type { Db } from "@arcatic/database";
import { ComfyUiClient, img2imgGraph, txt2imgGraph } from "@arcatic/integrations";
import type { GenerateContentResult, GenerateImageInput } from "./contracts.js";
import { activeBrandContext, presetSize } from "./content-activity.js";

export interface ImageDeps {
  db: Db;
  comfy: ComfyUiClient;
  pollMs?: number;
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw ApplicationFailure.create({ type: err.code, message: err.message, nonRetryable: !err.retryable });
    throw err;
  }
}

/** Deterministic seed from the job id (repeatable on retry, different per job). */
const seedFrom = (id: string) => [...id.replace(/-/g, "")].reduce((h, c) => (h * 31 + parseInt(c, 16)) % 2_147_483_647, 7);

export function createImageActivities({ db, comfy, pollMs = 3000 }: ImageDeps) {
  return {
    /**
     * Prompt check → licence check → ComfyUI (idempotent: the job id is the ComfyUI prompt id)
     * → poll with heartbeats → store outputs as media assets → content version.
     */
    async generateImage(input: GenerateImageInput): Promise<GenerateContentResult & { assetIds: string[] }> {
      return wrap(async () => {
        const done = await db.from("content_versions").select("id, content_item_id, body").eq("workspace_id", input.workspaceId).eq("generation_job_id", input.jobId).maybeSingle();
        if (done.data) return { contentItemId: done.data.content_item_id, contentVersionId: done.data.id, validationPassed: true, assetIds: (done.data.body as { images?: string[] }).images ?? [] };

        const safe = checkImagePrompt(input.prompt);
        if (!safe.ok) throw new AppError("validation_failed", safe.reason);
        const model = await db.from("ai_models").select("key, checkpoint, enabled, commercial_use, kind, default_params, license").eq("key", input.modelKey).single();
        if (model.error) throw new AppError("validation_failed", `Unknown image model ${input.modelKey}.`);
        if (model.data.kind !== "image" || !model.data.enabled || !model.data.commercial_use || !model.data.checkpoint) {
          throw new AppError("validation_failed", `${input.modelKey} isn't available for commercial use here.`);
        }
        const brand = await activeBrandContext(db, input.workspaceId, input.brandId);
        const isProduct = input.contentType === "product_photo";
        const p = buildImagePrompt(brand, input.prompt, { productShot: isProduct });
        const params = model.data.default_params as { steps?: number; cfg?: number; sampler?: string; scheduler?: string };
        const { w, h } = presetSize(input.preset);
        const size = sdxlSize(w, h);
        const seed = input.seed ?? seedFrom(input.jobId);
        const base = {
          checkpoint: model.data.checkpoint as string, positive: p.positive, negative: p.negative, seed,
          steps: params.steps ?? 30, cfg: params.cfg ?? 6.5, sampler: params.sampler ?? "dpmpp_2m", scheduler: params.scheduler ?? "karras",
          filenamePrefix: `arcatic/${input.workspaceId.slice(0, 8)}/${input.jobId}`,
        };

        const ctx = Context.current();
        let job = await comfy.job(input.jobId);
        if (!job) {
          let graph: Record<string, unknown>;
          if (isProduct) {
            if (!input.productAssetId) throw new AppError("validation_failed", "Choose the product photo to restyle.");
            const a = await db.from("media_assets").select("storage_path, kind, status").eq("workspace_id", input.workspaceId).eq("id", input.productAssetId).single();
            if (a.error || a.data.kind !== "image" || a.data.status !== "ready") throw new AppError("validation_failed", "The product photo must be a ready image.");
            const f = await db.storage.from("media").download(a.data.storage_path as string);
            if (f.error) throw new AppError("upstream_error", "Could not read the product photo.", { retryable: true });
            const up = await comfy.uploadImage(new Uint8Array(await f.data.arrayBuffer()), `${input.jobId}.png`);
            graph = img2imgGraph({ ...base, inputImage: up.subfolder ? `${up.subfolder}/${up.name}` : up.name, denoise: input.denoise ?? 0.55 });
          } else {
            graph = txt2imgGraph({ ...base, width: size.width, height: size.height, batch: Math.max(1, Math.min(4, input.count)) });
          }
          await comfy.submit(graph, input.jobId);
        }

        // poll until done; cancellation is passed on to ComfyUI
        const cancelled = ctx.cancelled.catch(() => comfy.cancel(input.jobId).catch(() => undefined));
        void cancelled;
        for (let i = 0; ; i++) {
          job = await comfy.job(input.jobId);
          ctx.heartbeat({ status: job?.status ?? "submitted", polls: i });
          if (job && ["completed", "failed", "cancelled"].includes(job.status)) break;
          if (i > 1200) throw new AppError("upstream_error", "Image generation timed out.", { retryable: false });
          await ctx.sleep(pollMs);
        }
        if (job!.status !== "completed") {
          throw new AppError(job!.status === "cancelled" ? "upstream_error" : "upstream_error", `Image generation ${job!.status}: ${job!.execution_error?.exception_message ?? "no details"}`, { retryable: false });
        }

        const refs = ComfyUiClient.outputImages(job!);
        if (!refs.length) throw new AppError("upstream_error", "ComfyUI returned no images.", { retryable: false });
        const assetIds: string[] = [];
        for (const [n, ref] of refs.entries()) {
          const img = await comfy.view(ref);
          const sniff = sniffFile(img.bytes, ref.filename);
          if (!IMAGE_KINDS.has(sniff.kind)) throw new AppError("upstream_error", "ComfyUI returned a file that isn't an image.", { retryable: false });
          const id = crypto.randomUUID();
          const path = `${input.workspaceId}/${input.brandId}/${id}/generated-${n + 1}.${sniff.mime.split("/")[1]!.replace("jpeg", "jpg")}`;
          const up = await db.storage.from("media").upload(path, img.bytes, { contentType: sniff.mime, upsert: true });
          if (up.error) throw new AppError("upstream_error", `Storage upload failed: ${up.error.message}`, { retryable: true });
          const dims = imageDimensions(img.bytes);
          const ins = await db.from("media_assets").insert({
            id, workspace_id: input.workspaceId, brand_id: input.brandId, kind: "image", status: "ready", storage_path: path, source: "generated",
            mime_type: sniff.mime, bytes: img.bytes.byteLength, width: dims?.width ?? null, height: dims?.height ?? null,
            title: `${input.prompt.slice(0, 60)} (${n + 1})`, generation_job_id: input.jobId, created_by: input.requestedBy ?? null,
            metadata: { model: input.modelKey, license: model.data.license, seed, prompt: p.positive },
          });
          if (ins.error) throw fromDbError(ins.error);
          assetIds.push(id);
          ctx.heartbeat({ stored: n + 1 });
        }

        let itemId = input.contentItemId;
        if (!itemId) {
          const item = await db.from("content_items").insert({
            workspace_id: input.workspaceId, brand_id: input.brandId, type: input.contentType, status: "generating", template: isProduct ? "image.product@1" : "image.generate@1",
            title: input.prompt.slice(0, 200), created_by: input.requestedBy ?? null, language: brand.data.languages.primary,
          }).select("id").single();
          if (item.error) throw fromDbError(item.error);
          itemId = item.data.id as string;
        }
        const last = await db.from("content_versions").select("version").eq("content_item_id", itemId).order("version", { ascending: false }).limit(1).maybeSingle();
        const v = await db.from("content_versions").insert({
          workspace_id: input.workspaceId, brand_id: input.brandId, content_item_id: itemId, version: (last.data?.version ?? 0) + 1, origin: "ai",
          body: { format: 1, doc: docFrom([["image_prompt", input.prompt]]), images: assetIds }, media_asset_ids: assetIds,
          prompt: `${p.positive}\n\nnegative: ${p.negative}`, prompt_template: isProduct ? "image.product@1" : "image.generate@1", model: input.modelKey,
          model_params: { ...base, width: size.width, height: size.height, denoise: input.denoise ?? null, license: model.data.license },
          inputs: { prompt: input.prompt, preset: input.preset, count: input.count, productAssetId: input.productAssetId ?? null },
          brand_context_version: brand.version, brand_context_hash: brand.hash, depends_on_facts: brand.factIds.filter((f) => f.startsWith("visual.")),
          generation_job_id: input.jobId, credits_cost: input.chargeCredits, validation_report: { passed: true, issues: [] },
        }).select("id").single();
        if (v.error) throw fromDbError(v.error);
        const u = await db.from("content_items").update({ current_version_id: v.data.id, status: "draft" }).eq("id", itemId);
        if (u.error) throw fromDbError(u.error);
        return { contentItemId: itemId, contentVersionId: v.data.id as string, validationPassed: true, assetIds };
      });
    },
  };
}

export type ImageActivities = ReturnType<typeof createImageActivities>;
