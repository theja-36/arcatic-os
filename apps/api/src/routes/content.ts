import { TEMPLATES, brandRules, checkImagePrompt } from "@arcatic/ai";
import {
  AppError, CONTENT_TYPE_DEFS, ContentDocSchema, LANGUAGES, PaginationSchema, SIZE_PRESETS, SceneSchema, TONE_OPTIONS, TRANSFORMS, VISUAL_TEMPLATES,
  canEditContent, classifyEdit, contentCost, fromDbError, isContentType, markHumanEdits, validateDoc, validateScene,
  type BrandContext, type ContentDoc, type ContentType, type Estimate, type ModelTier, type Scene,
} from "@arcatic/core";
import type { GenerateContentInput } from "@arcatic/jobs";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { body, check, idempotencyKey, ok, parse } from "../http.js";
import { startCostedJob } from "../job-start.js";
import { requirePermission as can } from "../middleware/workspace.js";
import type { ApiDeps, AppEnv } from "../types.js";

const ITEM_COLUMNS = "id, brand_id, campaign_id, topic_id, project_id, repurpose_run_id, source_ref, type, channel, language, title, status, current_version_id, approved_version_id, source_item_id, template, due_at, assignee_id, created_by, created_at, updated_at";
const VERSION_LIST = "id, version, origin, transform, base_version, model, prompt_template, credits_cost, created_by, created_at, validation_report, regenerated_block_ids";
const Tier = z.enum(["economy", "standard", "premium"]);
const TYPE_KEYS = Object.keys(CONTENT_TYPE_DEFS) as [ContentType, ...ContentType[]];

const GenerateSchema = z.object({
  type: z.enum(TYPE_KEYS),
  input: z.record(z.string(), z.unknown()).default({}),
  modelTier: Tier.optional(),
  referenceSourceIds: z.array(z.uuid()).max(10).optional(),
  referenceMediaIds: z.array(z.uuid()).max(4).optional(),
  projectId: z.uuid().optional(),
  visual: z.object({ preset: z.enum(Object.keys(SIZE_PRESETS) as [string, ...string[]]), template: z.enum(Object.keys(VISUAL_TEMPLATES) as [string, ...string[]]), imageAssetId: z.uuid().nullable().optional() }).optional(),
  image: z.object({
    prompt: z.string().trim().min(3).max(1000), preset: z.enum(Object.keys(SIZE_PRESETS) as [string, ...string[]]).default("instagram-square"),
    count: z.number().int().min(1).max(4).default(1), modelKey: z.string().max(60).default("sdxl-base-1.0"),
    productAssetId: z.uuid().optional(), denoise: z.number().min(0.2).max(0.9).optional(),
  }).optional(),
});
const EstimateSchema = z.object({ type: z.enum(TYPE_KEYS), modelTier: Tier.default("standard"), count: z.number().int().min(1).max(4).default(1), mode: z.enum(["create", "regenerate", "transform", "translate"]).default("create") });
const SaveSchema = z.object({ baseVersion: z.number().int().positive(), doc: ContentDocSchema, scene: SceneSchema.optional(), note: z.string().max(300).optional() });
const RegenerateSchema = z.object({ focus: z.string().max(1000).optional(), blockIds: z.array(z.string()).max(200).optional(), modelTier: Tier.optional() });
const TransformSchema = z.object({ transform: z.enum(TRANSFORMS), tone: z.enum(TONE_OPTIONS).optional(), instruction: z.string().max(500).optional(), blockIds: z.array(z.string()).max(200).optional() });
const TranslateSchema = z.object({ targetLanguage: z.enum(Object.keys(LANGUAGES) as [string, ...string[]]) });
const BulkSchema = z.object({ ids: z.array(z.uuid()).min(1).max(50), focus: z.string().max(1000).optional() });
const DecideSchema = z.object({ decision: z.enum(["approved", "rejected", "changes_requested"]), comment: z.string().max(2000).optional() });
const ListSchema = PaginationSchema.extend({ type: z.string().optional(), status: z.string().optional(), q: z.string().max(100).optional(), campaignId: z.uuid().optional(), projectId: z.uuid().optional() });

export { contentCost };

export const contentRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  const actor = (c: Context<AppEnv>) => {
    const p = c.get("principal");
    return p.kind === "user" ? p.userId : null;
  };
  const brandId = (c: Context<AppEnv>) => c.req.param("brandId")!;

  async function item(c: Context<AppEnv>) {
    const res = await c.get("db").from("content_items").select(ITEM_COLUMNS).eq("workspace_id", c.get("workspaceId")).eq("brand_id", brandId(c)).eq("id", c.req.param("contentId")!).maybeSingle();
    if (res.error) throw fromDbError(res.error);
    if (!res.data) throw new AppError("not_found", "Content not found.");
    return res.data as unknown as { id: string; type: string; channel: string | null; status: string; current_version_id: string | null; language: string };
  }
  async function currentVersion(c: Context<AppEnv>, versionId: string | null) {
    if (!versionId) throw new AppError("conflict", "This content is still being generated.");
    return check(await c.get("db").from("content_versions").select("id, version, body, validation_report").eq("id", versionId).single()) as { id: string; version: number; body: { doc?: ContentDoc; scene?: Scene; variants?: ContentDoc[] }; validation_report: unknown };
  }
  async function brandContext(c: Context<AppEnv>): Promise<BrandContext> {
    const b = check(await c.get("db").from("brands").select("active_kit_version_id").eq("id", brandId(c)).single());
    if (!b.active_kit_version_id) throw new AppError("validation_failed", "Approve a Brand Kit version first.");
    return (check(await deps.serviceDb().from("brand_contexts").select("context").eq("kit_version_id", b.active_kit_version_id).single()) as { context: BrandContext }).context;
  }
  function startText(c: Context<AppEnv>, key: string, type: ContentType, cost: Estimate, input: Omit<GenerateContentInput, "jobId" | "workspaceId" | "brandId" | "chargeCredits" | "reservationId">, contentItemId?: string) {
    const ws = c.get("workspaceId");
    return startCostedJob(deps, c, {
      idempotencyKey: key, kind: `generate.${type}`, brandId: brandId(c), cost,
      input: { type, mode: input.mode ?? "create", ...input.input, contentItemId: contentItemId ?? null },
      extra: { content_item_id: contentItemId ?? null },
      start: (s, a) => s.generateContent({ ...a, ...input, workspaceId: ws, brandId: brandId(c), contentItemId, requestedBy: actor(c) ?? undefined }),
    });
  }
  /** Save a version written by a person (or derived without AI) and return its checklist. */
  async function saveHumanVersion(c: Context<AppEnv>, it: { id: string; type: string; channel: string | null }, prev: { version: number; body: { doc?: ContentDoc; scene?: Scene } }, doc: ContentDoc, scene: Scene | undefined, transform: string | null) {
    if (!isContentType(it.type)) throw new AppError("validation_failed", "Unsupported content type.");
    const brand = await brandContext(c);
    const marked = transform?.startsWith("restore") || transform?.startsWith("variant") ? { doc, changed: [], added: [], removed: [] } : markHumanEdits(prev.body.doc ?? null, doc);
    const validation = validateDoc(it.type, marked.doc, it.channel, brandRules(brand, []));
    const sceneCheck = scene ? validateScene(scene, { colors: brand.data.visual.colors, fonts: brand.data.visual.fonts }) : undefined;
    const passed = validation.passed && (sceneCheck?.passed ?? true);
    const svc = deps.serviceDb();
    const v = check(await svc.from("content_versions").insert({
      workspace_id: c.get("workspaceId"), brand_id: brandId(c), content_item_id: it.id, version: prev.version + 1, origin: transform ? "ai_edit" : "human",
      body: { ...prev.body, format: 1, doc: marked.doc, ...(scene && { scene }) }, plain_text: marked.doc.blocks.map((b) => b.text).join("\n\n").slice(0, 50_000),
      base_version: prev.version, transform, created_by: actor(c), brand_context_version: brand.version, brand_context_hash: brand.hash,
      validation_report: { passed, issues: validation.issues, stats: validation.stats, ...(sceneCheck && { scene: sceneCheck }) },
    }).select(VERSION_LIST).single());   // unique (item, version) turns a concurrent save into a 409
    ok(await svc.from("content_items").update({ current_version_id: v.id }).eq("id", it.id));
    if (!transform && prev.body.doc) {
      const classes = classifyEdit(prev.body.doc, marked.doc);
      if (classes.length) await svc.from("learning_signals").insert({ workspace_id: c.get("workspaceId"), brand_id: brandId(c), content_item_id: it.id, content_version_id: v.id, signal: "edit", edit_class: classes.join(","), details: { changed: marked.changed, added: marked.added, removed: marked.removed }, actor_id: actor(c) });
    }
    return { version: v, validation: { passed, issues: validation.issues, scene: sceneCheck } };
  }
  // ---- read -----------------------------------------------------------------
  r.get("/brands/:brandId/content", can("content.read"), async (c) => {
    const q = parse(ListSchema, c.req.query());
    let query = c.get("db").from("content_items").select(`${ITEM_COLUMNS}, current:content_versions!content_items_current_version_id_fkey(version, validation_report)`)
      .eq("workspace_id", c.get("workspaceId")).eq("brand_id", brandId(c)).order("updated_at", { ascending: false }).limit(q.limit + 1);
    if (q.type) query = query.eq("type", q.type);
    if (q.status) query = query.eq("status", q.status);
    else query = query.neq("status", "archived");
    if (q.campaignId) query = query.eq("campaign_id", q.campaignId);
    if (q.projectId) query = query.eq("project_id", q.projectId);
    if (q.q) query = query.ilike("title", `%${q.q.replace(/[%_]/g, "")}%`);
    if (q.cursor) query = query.lt("updated_at", q.cursor);
    const rows = check(await query) as Array<Record<string, unknown>>;
    const page = rows.slice(0, q.limit);
    return c.json({ data: page, next_cursor: rows.length > q.limit ? (page.at(-1)?.updated_at as string) : null });
  });

  r.get("/brands/:brandId/content/:contentId", can("content.read"), async (c) => {
    const it = await item(c);
    const version = it.current_version_id
      ? check(await c.get("db").from("content_versions").select(`${VERSION_LIST}, body, prompt, inputs, source_chunk_ids, depends_on_facts, brand_context_version, media_asset_ids`).eq("id", it.current_version_id).single())
      : null;
    const approvals = check(await c.get("db").from("approvals").select("id, status, comment, requested_by, reviewer_id, decided_at, created_at, content_version_id").eq("content_item_id", it.id).order("created_at", { ascending: false }).limit(10));
    const translations = check(await c.get("db").from("content_items").select("id, language, status").eq("source_item_id", it.id));
    return c.json({ ...it, version, approvals, translations, editable: canEditContent(it.status as never) });
  });

  r.get("/brands/:brandId/content/:contentId/versions", can("content.read"), async (c) => {
    const it = await item(c);
    return c.json({ data: check(await c.get("db").from("content_versions").select(VERSION_LIST).eq("content_item_id", it.id).order("version", { ascending: false }).limit(100)) });
  });

  r.get("/brands/:brandId/content/:contentId/versions/:version", can("content.read"), async (c) => {
    const it = await item(c);
    return c.json(check(await c.get("db").from("content_versions").select(`${VERSION_LIST}, body, prompt, inputs, source_chunk_ids`).eq("content_item_id", it.id).eq("version", Number(c.req.param("version"))).single()));
  });

  r.post("/brands/:brandId/content/estimate", can("content.read"), async (c) => {
    const i = await body(c, EstimateSchema);
    return c.json(contentCost(i.type, { modelTier: i.modelTier, count: i.count, mode: i.mode }));
  });

  // ---- generate ---------------------------------------------------------------
  r.post("/brands/:brandId/content", can("content.create"), async (c) => {
    const key = idempotencyKey(c);
    const g = await body(c, GenerateSchema);
    const def = CONTENT_TYPE_DEFS[g.type];
    const ws = c.get("workspaceId");
    if (def.category === "image") {
      if (!g.image) throw new AppError("validation_failed", "Describe the image to create.", { details: [{ path: "image.prompt", message: "required" }] });
      const im = g.image;
      const safe = checkImagePrompt(im.prompt);
      if (!safe.ok) throw new AppError("validation_failed", safe.reason);
      const model = check(await c.get("db").from("ai_models").select("key, enabled, commercial_use, kind").eq("key", im.modelKey).maybeSingle()) as { enabled: boolean; commercial_use: boolean; kind: string } | null;
      if (!model || model.kind !== "image" || !model.enabled || !model.commercial_use) throw new AppError("validation_failed", `${im.modelKey} isn't available for commercial use here.`);
      if (g.type === "product_photo" && !im.productAssetId) throw new AppError("validation_failed", "Choose the product photo to restyle.");
      const res = await startCostedJob(deps, c, {
        idempotencyKey: key, kind: `generate.${g.type}`, brandId: brandId(c), cost: contentCost(g.type, { count: g.type === "product_photo" ? 1 : im.count }),
        input: { ...im }, start: (s, a) => s.generateImage({ ...a, workspaceId: ws, brandId: brandId(c), contentType: g.type as "image" | "product_photo", ...im, count: g.type === "product_photo" ? 1 : im.count, requestedBy: actor(c) ?? undefined }),
      });
      return c.json({ job: res.job, credits: res.credits }, 202);
    }
    const template = def.template ? TEMPLATES[def.template] : undefined;
    if (!template) throw new AppError("validation_failed", def.category === "video" ? "Videos are made in the video editor." : `${def.label} can't be generated yet.`);
    const input = parse(template.input, { ...g.input, ...(def.channels && !g.input.channel && "defaultChannel" in def && { channel: def.defaultChannel }), ...(g.type === "short_video" && { format: "short" }) });
    if (def.category === "visual" && !g.visual) throw new AppError("validation_failed", "Choose a size and layout.", { details: [{ path: "visual", message: "required" }] });
    if (g.projectId) check(await c.get("db").from("projects").select("id").eq("brand_id", brandId(c)).eq("id", g.projectId).eq("status", "active").maybeSingle());
    const res = await startText(c, key, g.type, contentCost(g.type, { modelTier: g.modelTier }), {
      templateKey: def.template!, input, modelTier: g.modelTier, referenceSourceIds: g.referenceSourceIds, referenceMediaIds: g.referenceMediaIds, visual: g.visual, projectId: g.projectId,
    });
    return c.json({ job: res.job, credits: res.credits }, 202);
  });

  // ---- edit -------------------------------------------------------------------
  r.post("/brands/:brandId/content/:contentId/versions", can("content.update"), async (c) => {
    const i = await body(c, SaveSchema);
    const it = await item(c);
    if (!canEditContent(it.status as never)) throw new AppError("conflict", `Content is ${it.status}.`);
    const cur = await currentVersion(c, it.current_version_id);
    if (cur.version !== i.baseVersion) throw new AppError("conflict", "Someone else changed this content. Reload to see their version.", { details: { latestVersion: cur.version } });
    return c.json(await saveHumanVersion(c, it, cur, i.doc, i.scene, null), 201);
  });

  r.post("/brands/:brandId/content/:contentId/restore/:version", can("content.update"), async (c) => {
    const it = await item(c);
    const cur = await currentVersion(c, it.current_version_id);
    const old = check(await c.get("db").from("content_versions").select("version, body").eq("content_item_id", it.id).eq("version", Number(c.req.param("version"))).single()) as { version: number; body: { doc: ContentDoc; scene?: Scene } };
    return c.json(await saveHumanVersion(c, it, cur, old.body.doc, old.body.scene, `restore:${old.version}`), 201);
  });

  r.post("/brands/:brandId/content/:contentId/variants/:n/use", can("content.update"), async (c) => {
    const it = await item(c);
    const cur = await currentVersion(c, it.current_version_id);
    const n = Number(c.req.param("n"));
    const v = cur.body.variants?.[n];
    if (!v) throw new AppError("not_found", "Variant not found.");
    const variants = [cur.body.doc!, ...(cur.body.variants ?? []).filter((_, i) => i !== n)];
    const res = await saveHumanVersion(c, it, { ...cur, body: { ...cur.body, variants } as never }, v, cur.body.scene, `variant:${n + 1}`);
    return c.json(res, 201);
  });

  for (const action of ["regenerate", "transform", "translate"] as const) {
    r.post(`/brands/:brandId/content/:contentId/${action}`, can(action === "translate" ? "content.create" : "content.update"), async (c) => {
      const key = idempotencyKey(c);
      const it = await item(c);
      if (!isContentType(it.type) || !["text", "visual"].includes(CONTENT_TYPE_DEFS[it.type].category)) throw new AppError("validation_failed", "Only text content can be rewritten.");
      if (action !== "translate" && !canEditContent(it.status as never)) throw new AppError("conflict", `Content is ${it.status}.`);
      await currentVersion(c, it.current_version_id);
      const type = it.type as ContentType;
      const template = CONTENT_TYPE_DEFS[type].template!;
      if (action === "regenerate") {
        const i = await body(c, RegenerateSchema);
        const res = await startText(c, key, type, contentCost(type, { modelTier: i.modelTier, mode: "regenerate" }), { templateKey: template, input: {}, mode: "regenerate", focus: i.focus, blockIds: i.blockIds, modelTier: i.modelTier }, it.id);
        return c.json({ job: res.job, credits: res.credits }, 202);
      }
      if (action === "transform") {
        const i = await body(c, TransformSchema);
        if (i.transform === "tone" && !i.tone) throw new AppError("validation_failed", "Choose a tone.");
        const res = await startText(c, key, type, contentCost(type, { mode: "transform", modelTier: i.transform === "fix_grammar" ? "economy" : "standard" }), { templateKey: template, input: {}, mode: "transform", transform: i.transform, tone: i.tone, instruction: i.instruction, blockIds: i.blockIds }, it.id);
        return c.json({ job: res.job, credits: res.credits }, 202);
      }
      const i = await body(c, TranslateSchema);
      if (i.targetLanguage === it.language) throw new AppError("validation_failed", "That's already the content's language.");
      const res = await startText(c, key, type, contentCost(type, { mode: "translate" }), { templateKey: template, input: {}, mode: "translate", targetLanguage: i.targetLanguage }, it.id);
      return c.json({ job: res.job, credits: res.credits }, 202);
    });
  }

  /** Regenerate many drafts (e.g. after a Brand Kit change). Human edits are kept in each. */
  async function bulk(c: Context<AppEnv>, key: string, ids: string[], focus?: string) {
    const rows = check(await c.get("db").from("content_items").select("id, type, status, current_version_id").eq("workspace_id", c.get("workspaceId")).eq("brand_id", brandId(c)).in("id", ids)) as Array<{ id: string; type: string; status: string; current_version_id: string | null }>;
    const results = [];
    for (const row of rows) {
      if (!isContentType(row.type) || !["text", "visual"].includes(CONTENT_TYPE_DEFS[row.type].category) || !row.current_version_id || !canEditContent(row.status as never)) {
        results.push({ id: row.id, skipped: "not regenerable" });
        continue;
      }
      try {
        const res = await startText(c, `${key}:${row.id}`, row.type, contentCost(row.type, { mode: "regenerate" }), { templateKey: CONTENT_TYPE_DEFS[row.type].template!, input: {}, mode: "regenerate", focus }, row.id);
        results.push({ id: row.id, job: res.job });
      } catch (e) {
        results.push({ id: row.id, error: e instanceof AppError ? { code: e.code, message: e.message } : { code: "internal", message: "failed to start" } });
        if (e instanceof AppError && e.code === "insufficient_credits") break;
      }
    }
    return results;
  }

  r.post("/brands/:brandId/content/bulk-regenerate", can("content.update"), async (c) => {
    const key = idempotencyKey(c);
    const i = await body(c, BulkSchema);
    return c.json({ data: await bulk(c, key, i.ids, i.focus) }, 202);
  });

  r.post("/brands/:brandId/content/regenerate-affected", can("content.update"), async (c) => {
    const key = idempotencyKey(c);
    const i = await body(c, z.object({ factIds: z.array(z.string()).min(1).max(100), focus: z.string().max(500).optional() }));
    const affected = check(await c.get("db").rpc("content_affected_by_facts", { p_brand: brandId(c), p_fact_ids: i.factIds })) as Array<{ content_item_id: string }>;
    if (!affected.length) return c.json({ data: [] });
    return c.json({ data: await bulk(c, key, affected.map((a) => a.content_item_id).slice(0, 50), i.focus ?? "Update to match the latest Brand Kit.") }, 202);
  });

  r.post("/brands/:brandId/content/:contentId/:op{archive|unarchive}", can("content.update"), async (c) => {
    const it = await item(c);
    const to = c.req.param("op") === "archive" ? "archived" : "draft";
    if (to === "archived" && it.status === "generating") throw new AppError("conflict", "Wait for generation to finish.");
    ok(await deps.serviceDb().from("content_items").update({ status: to }).eq("id", it.id));
    return c.json({ status: to });
  });

  // ---- approvals ----------------------------------------------------------------
  r.post("/brands/:brandId/content/:contentId/submit", can("content.update"), async (c) => {
    const it = await item(c);
    const i = await body(c, z.object({ dueAt: z.iso.datetime().optional() }));
    const a = check(await deps.serviceDb().rpc("submit_for_approval", { p_item: it.id, p_version: it.current_version_id, p_actor: actor(c), p_due: i.dueAt ?? null }));
    return c.json(a, 201);
  });

  r.get("/brands/:brandId/approvals", can("approval.read"), async (c) => {
    const status = c.req.query("status") ?? "pending";
    const rows = check(await c.get("db").from("approvals").select("id, status, comment, requested_by, reviewer_id, due_at, decided_at, created_at, content_version_id, item:content_items(id, title, type, channel, language)")
      .eq("workspace_id", c.get("workspaceId")).eq("brand_id", brandId(c)).eq("status", status).order("created_at").limit(200));
    return c.json({ data: rows });
  });

  r.post("/brands/:brandId/approvals/:approvalId/decide", can("approval.decide"), async (c) => {
    const i = await body(c, DecideSchema);
    const a = check(await c.get("db").from("approvals").select("id, status").eq("workspace_id", c.get("workspaceId")).eq("brand_id", brandId(c)).eq("id", c.req.param("approvalId")).single());
    const ws = check(await c.get("db").from("workspaces").select("settings").eq("id", c.get("workspaceId")).single()) as { settings: { requireSeparateApprover?: boolean } | null };
    if (i.decision !== "approved" && !i.comment?.trim()) throw new AppError("validation_failed", "Say what needs to change.");
    const res = check(await deps.serviceDb().rpc("decide_approval", {
      p_approval: a.id, p_decision: i.decision, p_comment: i.comment ?? null, p_actor: actor(c), p_allow_self: !ws.settings?.requireSeparateApprover,
    }));
    return c.json(res);
  });

  return r;
};
