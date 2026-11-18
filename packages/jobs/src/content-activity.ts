import { Context } from "@temporalio/activity";
import { TEMPLATES, brandRules, runRewrite, runTemplate, type LlmProvider } from "@arcatic/ai";
import {
  AppError, CONTENT_TYPE_DEFS, IMAGE_KINDS, SIZE_PRESETS, fromDbError, isContentType, isSizePreset, layoutScene, sniffFile, validateDoc, validateScene,
  type BrandContext, type ContentDoc, type ContentType, type Scene, type VisualTemplate,
  learningsBlock,
} from "@arcatic/core";
import type { Db } from "@arcatic/database";
import type { Embedder } from "@arcatic/integrations";
import { toPgVector } from "@arcatic/integrations";
import type { GenerateContentInput, GenerateContentResult } from "./contracts.js";
import { retrieveForGeneration, type RetrievedChunk } from "./retrieval.js";

const MAX_VISION_BYTES = 5 * 1024 * 1024;

export async function activeBrandContext(db: Db, workspaceId: string, brandId: string): Promise<BrandContext> {
  const brand = await db.from("brands").select("id, active_kit_version_id").eq("id", brandId).eq("workspace_id", workspaceId).single();
  if (brand.error) throw fromDbError(brand.error);
  if (!brand.data.active_kit_version_id) throw new AppError("validation_failed", "Approve a Brand Kit version before generating content.");
  const stored = await db.from("brand_contexts").select("context").eq("kit_version_id", brand.data.active_kit_version_id).eq("workspace_id", workspaceId).single();
  if (stored.error) throw fromDbError(stored.error);
  return stored.data.context as BrandContext;
}

async function knowledgeFor(db: Db, embedder: Embedder | null, input: GenerateContentInput, query: string, signal: AbortSignal): Promise<RetrievedChunk[]> {
  if (input.referenceSourceIds?.length) {
    let emb: string | null = null;
    if (embedder) emb = await embedder.embed([query], "query", signal).then((v) => toPgVector(v[0]!)).catch(() => null);
    const r = await db.rpc("search_knowledge_in", { p_brand: input.brandId, p_query: query, p_source_ids: input.referenceSourceIds, p_embedding: emb, p_model: emb ? embedder!.model : null, p_limit: 8 });
    if (r.error) throw fromDbError(r.error);
    return ((r.data ?? []) as Array<{ chunk_id: string; source_id: string; content: string; page_url: string | null; source_url: string | null; source_title: string }>)
      .map((x) => ({ chunkId: x.chunk_id, sourceId: x.source_id, content: x.content, url: x.page_url ?? x.source_url ?? undefined, title: x.source_title }));
  }
  return retrieveForGeneration(db, embedder, { brandId: input.brandId, query, requestedBy: input.requestedBy, signal });
}

async function visionImages(db: Db, workspaceId: string, ids: string[] | undefined) {
  if (!ids?.length) return undefined;
  const out: Array<{ mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string }> = [];
  for (const id of ids.slice(0, 4)) {
    const a = await db.from("media_assets").select("storage_path, kind, status").eq("workspace_id", workspaceId).eq("id", id).single();
    if (a.error) throw fromDbError(a.error);
    if (a.data.kind !== "image" || a.data.status !== "ready") throw new AppError("validation_failed", "Reference files must be ready images.");
    const f = await db.storage.from("media").download(a.data.storage_path as string);
    if (f.error) throw new AppError("upstream_error", "Could not read the reference image.", { retryable: true });
    const bytes = new Uint8Array(await f.data.arrayBuffer());
    if (bytes.byteLength > MAX_VISION_BYTES) throw new AppError("validation_failed", "Reference images must be under 5 MB.");
    const { kind, mime } = sniffFile(bytes, "ref");
    if (!IMAGE_KINDS.has(kind)) throw new AppError("validation_failed", "Reference must be a PNG, JPEG, GIF or WebP image.");
    out.push({ mediaType: mime as never, data: Buffer.from(bytes).toString("base64") });
  }
  return out;
}

const docQuery = (doc: ContentDoc) => doc.blocks.slice(0, 4).map((b) => b.text).join(" ").slice(0, 400);

/**
 * All text generation: create / regenerate / transform / translate.
 * Idempotent per job: a retried activity returns the version it already wrote.
 */
export async function generateContentActivity(db: Db, llm: LlmProvider, embedder: Embedder | null, input: GenerateContentInput): Promise<GenerateContentResult> {
  const existing = await db.from("content_versions").select("id, content_item_id, validation_report").eq("workspace_id", input.workspaceId).eq("generation_job_id", input.jobId).maybeSingle();
  if (existing.error) throw fromDbError(existing.error);
  if (existing.data) return { contentItemId: existing.data.content_item_id, contentVersionId: existing.data.id, validationPassed: Boolean((existing.data.validation_report as { passed?: boolean } | null)?.passed) };

  const brand = await activeBrandContext(db, input.workspaceId, input.brandId);
  const ac = new AbortController();
  Context.current().cancelled.catch(() => ac.abort());
  const mode = input.mode ?? "create";

  let contentItemId = input.contentItemId;
  let type: ContentType;
  let channel: string | null;
  let language: string;
  let doc: ContentDoc;
  let variants: ContentDoc[] = [];
  let output: unknown;
  let scene: Scene | undefined;
  let baseVersion: number | null = null;
  let transformLabel: string | null = null;
  let regenerated: string[] = [];
  let prov: { template: string; model: string; prompt: string; usage: unknown; sourceChunkIds: string[]; brandFacts: string[]; tier?: string };
  let knowledge: RetrievedChunk[];
  let insightIds: string[] = [];

  if (mode === "create") {
    const template = TEMPLATES[input.templateKey];
    if (!template) throw new AppError("validation_failed", `Unknown template ${input.templateKey}`);
    type = template.contentType;
    const q = input.input as { topic?: string; goal?: string; focus?: string; channel?: string; language?: string };
    knowledge = await knowledgeFor(db, embedder, input, [q.topic, q.goal, q.focus].filter(Boolean).join(". "), ac.signal);
    const images = await visionImages(db, input.workspaceId, input.referenceMediaIds);
    if (type === "caption" && !images?.length) throw new AppError("validation_failed", "Choose the image to write a caption for.");
    Context.current().heartbeat();
    // performance learnings: only insights a person accepted (docs/16 §4)
    const acc = await db.from("insights").select("id, guidance, applies_to").eq("workspace_id", input.workspaceId).eq("brand_id", input.brandId).eq("status", "accepted").not("guidance", "is", null).order("decided_at", { ascending: false }).limit(20);
    if (acc.error) throw fromDbError(acc.error);
    const learned = learningsBlock((acc.data ?? []) as never, { channel: q.channel ?? null, contentType: template.contentType });
    insightIds = learned.ids;
    const r = await runTemplate(llm, template, { brand, input: input.input as never, images, knowledge: knowledge.map((k) => ({ chunkId: k.chunkId, content: k.content, url: k.url })) }, {
      workspaceId: input.workspaceId, jobId: input.jobId, signal: ac.signal, tier: input.modelTier, learnings: learned.text || undefined,
    });
    doc = r.doc;
    variants = r.variants;
    output = r.output;
    channel = q.channel ?? null;
    language = q.language ?? brand.data.languages.primary;
    if (input.visual) {
      const v = input.visual;
      if (!isSizePreset(v.preset)) throw new AppError("validation_failed", `Unknown size ${v.preset}`);
      const copy = (k: string) => doc.blocks.find((b) => b.kind === k)?.text;
      scene = layoutScene({
        template: v.template as VisualTemplate, preset: v.preset, imageAssetId: v.imageAssetId ?? null,
        copy: { headline: copy("headline") ?? "", subhead: copy("subhead"), cta: copy("cta") },
        brand: { colors: brand.data.visual.colors, fonts: brand.data.visual.fonts, logoUrl: null },
      });
      if (type === "static_visual" && !CONTENT_TYPE_DEFS.static_visual.channels.includes(channel as never)) channel = null;
      if (["profile-picture", "facebook-cover", "linkedin-banner", "youtube-banner", "youtube-thumbnail", "sticker"].includes(v.preset)) type = "profile_asset";
    }
    prov = { template: r.provenance.promptTemplate, model: r.provenance.model, prompt: `${r.provenance.prompt.system}\n\n---\n\n${r.provenance.prompt.user}`, usage: { ...r.provenance.usage, ...r.provenance.modelParams, servedByFallback: r.provenance.servedByFallback }, sourceChunkIds: r.provenance.sourceChunkIds, brandFacts: r.provenance.dependsOnFacts };
  } else {
    if (!contentItemId) throw new AppError("validation_failed", "contentItemId is required.");
    const item = await db.from("content_items").select("id, type, channel, language, current_version_id, status").eq("workspace_id", input.workspaceId).eq("id", contentItemId).single();
    if (item.error) throw fromDbError(item.error);
    if (!isContentType(item.data.type as string)) throw new AppError("validation_failed", `Unsupported content type ${item.data.type}.`);
    const cur = await db.from("content_versions").select("version, body").eq("id", item.data.current_version_id as string).single();
    if (cur.error) throw fromDbError(cur.error);
    const body = cur.data.body as { doc?: ContentDoc; scene?: Scene };
    if (!body.doc) throw new AppError("validation_failed", "This content has no editable text.");
    type = item.data.type as ContentType;
    channel = (item.data.channel as string | null) ?? null;
    language = mode === "translate" ? input.targetLanguage! : (item.data.language as string);
    baseVersion = cur.data.version as number;
    knowledge = mode === "translate" ? [] : await knowledgeFor(db, embedder, input, docQuery(body.doc), ac.signal);
    const rw = await runRewrite(llm, {
      brand, doc: body.doc, contentLabel: CONTENT_TYPE_DEFS[type].label.toLowerCase(), blockIds: input.blockIds, tier: input.modelTier,
      knowledge: knowledge.map((k) => ({ chunkId: k.chunkId, content: k.content, url: k.url })),
      mode: mode === "regenerate" ? { kind: "regenerate", focus: input.focus }
        : mode === "translate" ? { kind: "translate", targetLanguage: input.targetLanguage! }
        : { kind: "transform", transform: input.transform ?? "improve", tone: input.tone, instruction: input.instruction },
    }, { workspaceId: input.workspaceId, jobId: input.jobId, signal: ac.signal });
    doc = rw.doc;
    regenerated = rw.rewritten;
    transformLabel = rw.template.replace(/^content\./, "").replace("@1", "");
    if (body.scene) {
      // keep the canvas in step with edited copy
      const t = (k: string) => doc.blocks.find((b) => b.kind === k)?.text;
      scene = { ...body.scene, layers: body.scene.layers.map((l) => (l.type === "text" ? { ...l, text: t(l.role) ?? l.text } : l)), exportAssetId: null };
    }
    prov = { template: rw.template, model: rw.model, prompt: `${rw.prompt.system}\n\n---\n\n${rw.prompt.user}`, usage: rw.usage, sourceChunkIds: [], brandFacts: brand.factIds };
    if (mode === "translate") {
      // a translation is its own content item linked to the original
      const ins = await db.from("content_items").insert({
        workspace_id: input.workspaceId, brand_id: input.brandId, type, channel, language, status: "generating", template: prov.template,
        source_item_id: contentItemId, created_by: input.requestedBy ?? null, metadata: { translated_from_version: baseVersion },
      }).select("id").single();
      if (ins.error) throw fromDbError(ins.error);
      contentItemId = ins.data.id as string;
      baseVersion = null;
    }
  }

  const validation = validateDoc(type, doc, channel, brandRules(brand, knowledge));
  const sceneCheck = scene ? validateScene(scene, { colors: brand.data.visual.colors, fonts: brand.data.visual.fonts }) : undefined;
  const passed = validation.passed && (sceneCheck?.passed ?? true);

  if (!contentItemId) {
    const item = await db.from("content_items").insert({
      workspace_id: input.workspaceId, brand_id: input.brandId, type, channel, language, status: "generating", template: input.templateKey,
      created_by: input.requestedBy ?? null, topic_id: input.topicId ?? null, campaign_id: input.campaignId ?? null,
      project_id: input.projectId ?? null, repurpose_run_id: input.repurposeRunId ?? null, source_ref: input.sourceRef ?? null,
      ...(input.sourceRef?.kind === "content" && { source_item_id: input.sourceRef.id }),
      title: (type === "brainstorm" ? `Ideas: ${String((input.input as { topic?: string }).topic ?? "")}` : doc.blocks.find((b) => ["title", "subject", "headline", "hook", "slide_headline", "caption", "primary_text", "tweet"].includes(b.kind))?.text ?? "Untitled").slice(0, 200),
    }).select("id").single();
    if (item.error) throw fromDbError(item.error);
    contentItemId = item.data.id as string;
  }

  const last = await db.from("content_versions").select("version").eq("content_item_id", contentItemId).order("version", { ascending: false }).limit(1).maybeSingle();
  if (last.error) throw fromDbError(last.error);
  const version = await db.from("content_versions").insert({
    workspace_id: input.workspaceId, brand_id: input.brandId, content_item_id: contentItemId, version: (last.data?.version ?? 0) + 1,
    origin: mode === "create" || mode === "translate" ? "ai" : "ai_edit",
    body: { format: 1, doc, ...(output !== undefined && { output }), ...(variants.length && { variants }), ...(scene && { scene }) },
    plain_text: doc.blocks.map((b) => b.text).join("\n\n").slice(0, 50_000),
    prompt: prov.prompt, prompt_template: prov.template, model: prov.model, model_params: { usage: prov.usage, tier: input.modelTier ?? null },
    inputs: { ...input.input, mode, focus: input.focus ?? null, transform: input.transform ?? null, tone: input.tone ?? null, targetLanguage: input.targetLanguage ?? null, referenceSourceIds: input.referenceSourceIds ?? [], referenceMediaIds: input.referenceMediaIds ?? [] },
    brand_context_version: brand.version, brand_context_hash: brand.hash, depends_on_facts: prov.brandFacts, source_chunk_ids: prov.sourceChunkIds,
    generation_job_id: input.jobId, credits_cost: input.chargeCredits, validation_report: { passed, issues: validation.issues, stats: validation.stats, ...(sceneCheck && { scene: sceneCheck }) },
    base_version: baseVersion, transform: transformLabel, regenerated_block_ids: regenerated, insight_ids: insightIds,
  }).select("id").single();
  if (version.error) throw fromDbError(version.error);

  const upd = await db.from("content_items").update({ current_version_id: version.data.id, status: "draft" }).eq("id", contentItemId).eq("workspace_id", input.workspaceId);
  if (upd.error) throw fromDbError(upd.error);
  if (mode === "regenerate") {
    await db.from("learning_signals").insert({ workspace_id: input.workspaceId, brand_id: input.brandId, content_item_id: contentItemId, content_version_id: version.data.id, signal: "regenerate", details: { focus: input.focus ?? null, blocks: regenerated }, prompt_template: prov.template, model: prov.model, actor_id: input.requestedBy ?? null });
  }
  if (input.topicId) {
    const link = await db.from("campaign_topics").update({ status: "done", content_item_id: contentItemId, status_note: passed ? null : "Draft needs fixes before approval" }).eq("id", input.topicId).eq("workspace_id", input.workspaceId);
    if (link.error) throw fromDbError(link.error);
  }
  return { contentItemId, contentVersionId: version.data.id as string, validationPassed: passed };
}

export const presetSize = (preset: string) => (isSizePreset(preset) ? SIZE_PRESETS[preset] : SIZE_PRESETS["instagram-square"]);
