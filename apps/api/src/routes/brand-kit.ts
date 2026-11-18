import { lookup } from "node:dns/promises";
import {
  AppError, BrandKitSchema, KitOpSchema, OnboardingAnswersSchema, applyKitOps, assertSafeUrl, compileBrandContext,
  diffKits, emptyKit, estimateCredits, fromDbError, kitCompleteness, seedKitFromOnboarding, type BrandKit,
} from "@arcatic/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { body, check, idempotencyKey } from "../http.js";
import { startCostedJob } from "../job-start.js";
import { requirePermission as can } from "../middleware/workspace.js";
import type { ApiDeps, AppEnv } from "../types.js";

const PutOnboardingSchema = z.object({
  answers: OnboardingAnswersSchema,
  step: z.string().max(40).optional(),
  complete: z.boolean().default(false),
});
const OpsSchema = z.object({ baseVersion: z.number().int().nonnegative(), ops: z.array(KitOpSchema).min(1).max(200), note: z.string().max(300).optional() });
const AnalyzeSchema = z.object({
  url: z.url().optional(),
  attestOwnership: z.literal(true, { message: "Confirm you own or are authorised to analyse this website." }),
  maxPages: z.number().int().min(1).max(25).default(12),
  paths: z.array(z.string()).max(40).optional(),
  useFirecrawlBranding: z.boolean().default(false),
});

const VERSION_LIST_COLUMNS = "id, version, base_version, status, origin, changed_fact_ids, completeness, analysis_job_id, note, created_by, approved_by, approved_at, created_at";
const dns = async (h: string) => (await lookup(h, { all: true })).map((a) => a.address);

export const brandKitRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  const resolve = deps.resolveHost ?? dns;
  const actor = (c: Context<AppEnv>) => {
    const p = c.get("principal");
    return p.kind === "user" ? p.userId : null;
  };

  /** Reads through the caller's client so brand-restricted members only reach their brands. */
  async function loadBrand(c: Context<AppEnv>) {
    const res = await c.get("db").from("brands").select("id, name, website_url, languages, active_kit_version_id, kit_completeness")
      .eq("workspace_id", c.get("workspaceId")).eq("id", c.req.param("brandId")!).is("deleted_at", null).maybeSingle();
    if (res.error) throw fromDbError(res.error);
    if (!res.data) throw new AppError("not_found", "Brand not found.");
    return res.data as { id: string; name: string; website_url: string | null; languages: string[]; active_kit_version_id: string | null; kit_completeness: number };
  }

  async function latestVersion(c: Context<AppEnv>, brand: { id: string; name: string; languages: string[] }) {
    const res = await c.get("db").from("brand_kit_versions").select("*").eq("workspace_id", c.get("workspaceId")).eq("brand_id", brand.id)
      .order("version", { ascending: false }).limit(1).maybeSingle();
    if (res.error) throw fromDbError(res.error);
    if (res.data) return { row: res.data, kit: BrandKitSchema.parse(res.data.kit), version: res.data.version as number };
    return { row: null, kit: emptyKit(brand.id, brand.name, brand.languages), version: 0 };
  }

  async function getVersion(c: Context<AppEnv>, brandId: string, version: number) {
    const res = await c.get("db").from("brand_kit_versions").select("*").eq("workspace_id", c.get("workspaceId")).eq("brand_id", brandId).eq("version", version).maybeSingle();
    if (res.error) throw fromDbError(res.error);
    if (!res.data) throw new AppError("not_found", `Version ${version} not found.`);
    return res.data;
  }

  async function insertVersion(c: Context<AppEnv>, brandId: string, prev: { kit?: BrandKit; version: number }, kit: BrandKit, origin: string, note?: string) {
    const version = prev.version + 1;
    const stamped = BrandKitSchema.parse({ ...kit, version });
    const res = await c.get("db").from("brand_kit_versions").insert({
      workspace_id: c.get("workspaceId"), brand_id: brandId, version, base_version: prev.version || null, status: "draft", origin,
      kit: stamped, changed_fact_ids: diffKits(prev.kit, stamped), completeness: kitCompleteness(stamped).score, note: note ?? null, created_by: actor(c),
    }).select(VERSION_LIST_COLUMNS).single();
    if (res.error?.code === "23505") throw new AppError("conflict", "The Brand Kit changed while you were editing. Reload and try again.");
    if (res.error) throw fromDbError(res.error);
    return { ...res.data, kit: stamped, completeness: kitCompleteness(stamped) };
  }

  const versionParam = (c: Context<AppEnv>) => {
    const v = Number(c.req.param("version"));
    if (!Number.isInteger(v) || v < 1) throw new AppError("validation_failed", "Invalid version.");
    return v;
  };

  // ---- onboarding ---------------------------------------------------------
  r.get("/brands/:brandId/onboarding", can("brand.read"), async (c) => {
    const brand = await loadBrand(c);
    const res = await c.get("db").from("brand_onboarding").select("answers, step, completed_at, ownership_attested_at, updated_at").eq("brand_id", brand.id).maybeSingle();
    if (res.error) throw fromDbError(res.error);
    return c.json(res.data ?? { answers: {}, step: "business", completed_at: null, ownership_attested_at: null });
  });

  r.put("/brands/:brandId/onboarding", can("brand.update"), async (c) => {
    const input = await body(c, PutOnboardingSchema);
    const brand = await loadBrand(c);
    const saved = check(await c.get("db").from("brand_onboarding").upsert({
      brand_id: brand.id, workspace_id: c.get("workspaceId"), answers: input.answers, step: input.step ?? "business",
      updated_by: actor(c), ...(input.complete && { completed_at: new Date().toISOString() }),
    }).select("answers, step, completed_at").single());

    let kitVersion = null;
    if (input.complete) {
      // the owner's answers seed the Brand Kit as approved facts (a new draft version)
      const latest = await latestVersion(c, brand);
      const { kit } = seedKitFromOnboarding(latest.kit, input.answers, { now: new Date().toISOString(), newId: () => crypto.randomUUID().slice(0, 8) });
      if (input.answers.website && !brand.website_url) {
        await c.get("db").from("brands").update({ website_url: input.answers.website }).eq("id", brand.id);
      }
      if (JSON.stringify(kit) !== JSON.stringify(latest.kit)) {
        kitVersion = await insertVersion(c, brand.id, latest, kit, "onboarding", "From onboarding answers");
      }
    }
    return c.json({ onboarding: saved, kitVersion });
  });

  // ---- website analysis ---------------------------------------------------
  r.post("/brands/:brandId/kit/analyze-website", can("brand.update"), async (c) => {
    const key = idempotencyKey(c);
    const input = await body(c, AnalyzeSchema);
    const brand = await loadBrand(c);
    const url = input.url ?? brand.website_url;
    if (!url) throw new AppError("validation_failed", "Add the brand's website first.");
    const safe = await assertSafeUrl(url, { resolve });

    // record the ownership attestation (docs/06 scraping policy)
    const ob = await c.get("db").from("brand_onboarding").upsert(
      { brand_id: brand.id, workspace_id: c.get("workspaceId"), ownership_attested_at: new Date().toISOString(), ownership_attested_by: actor(c) },
      { onConflict: "brand_id" },
    );
    if (ob.error) throw fromDbError(ob.error);

    const pages = estimateCredits({ kind: "ingest.url", quantity: input.maxPages });
    const extract = estimateCredits({ kind: "brand.extract", quantity: input.paths?.length ? 0.5 : 1 });
    const cost = { estimate: Math.round((pages.estimate + extract.estimate) * 1000) / 1000, max: Math.round((pages.max + extract.max) * 1000) / 1000 };
    const ws = c.get("workspaceId");
    const requestedBy = actor(c) ?? undefined;
    const res = await startCostedJob(deps, c, {
      idempotencyKey: key, kind: "brand.extract", brandId: brand.id, cost,
      input: { url: safe.toString(), maxPages: input.maxPages, paths: input.paths ?? null, useFirecrawlBranding: input.useFirecrawlBranding },
      start: (s, a) => s.brandAnalysis({
        ...a, workspaceId: ws, brandId: brand.id, url: safe.toString(), maxPages: input.maxPages,
        paths: input.paths, useFirecrawlBranding: input.useFirecrawlBranding, requestedBy,
      }),
    });
    return c.json({ job: res.job, credits: res.credits }, 202);
  });

  // ---- kit ----------------------------------------------------------------
  r.get("/brands/:brandId/kit", can("brand.read"), async (c) => {
    const brand = await loadBrand(c);
    const latest = await latestVersion(c, brand);
    const active = brand.active_kit_version_id
      ? check(await c.get("db").from("brand_kit_versions").select("id, version, approved_at, approved_by").eq("id", brand.active_kit_version_id).single())
      : null;
    const analysis = await c.get("db").from("generation_jobs").select("id, status, progress, created_at").eq("workspace_id", c.get("workspaceId"))
      .eq("brand_id", brand.id).eq("kind", "brand.extract").in("status", ["queued", "running", "cancelling"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
    return c.json({
      brand: { id: brand.id, name: brand.name, websiteUrl: brand.website_url },
      version: latest.version,
      status: latest.row?.status ?? null,
      origin: latest.row?.origin ?? null,
      note: latest.row?.note ?? null,
      kit: latest.kit,
      completeness: kitCompleteness(latest.kit),
      active,
      runningAnalysis: analysis.data ?? null,
    });
  });

  r.post("/brands/:brandId/kit/ops", can("brand.update"), async (c) => {
    const input = await body(c, OpsSchema);
    const brand = await loadBrand(c);
    const latest = await latestVersion(c, brand);
    if (latest.version !== input.baseVersion) {
      throw new AppError("conflict", "The Brand Kit changed since you loaded it.", { details: { latestVersion: latest.version } });
    }
    const { kit, touched } = applyKitOps(latest.kit, input.ops, { now: new Date().toISOString(), newId: () => crypto.randomUUID().slice(0, 8) });
    if (touched.length === 0) throw new AppError("validation_failed", "Nothing to save.");
    return c.json(await insertVersion(c, brand.id, latest, kit, "manual", input.note), 201);
  });

  r.get("/brands/:brandId/kit/versions", can("brand.read"), async (c) => {
    const brand = await loadBrand(c);
    const rows = check(await c.get("db").from("brand_kit_versions").select(VERSION_LIST_COLUMNS).eq("workspace_id", c.get("workspaceId")).eq("brand_id", brand.id).order("version", { ascending: false }).limit(100));
    return c.json({ data: rows, activeVersionId: brand.active_kit_version_id });
  });

  r.get("/brands/:brandId/kit/versions/:version", can("brand.read"), async (c) => {
    const brand = await loadBrand(c);
    return c.json(await getVersion(c, brand.id, versionParam(c)));
  });

  /** Approve → becomes the active kit for generation; returns which drafts the change affects. */
  r.post("/brands/:brandId/kit/versions/:version/approve", can("brand.update"), async (c) => {
    const brand = await loadBrand(c);
    const row = await getVersion(c, brand.id, versionParam(c));
    const kit = BrandKitSchema.parse(row.kit);
    const pending = [...Object.values(kit.facts), ...kit.audiences, ...kit.offers].filter((f) => f.status === "suggested").length;
    const ctx = await compileBrandContext(kit);

    let previousKit: BrandKit | undefined;
    if (brand.active_kit_version_id && brand.active_kit_version_id !== row.id) {
      const prev = check(await c.get("db").from("brand_kit_versions").select("kit").eq("id", brand.active_kit_version_id).single());
      previousKit = BrandKitSchema.parse(prev.kit);
    }
    check(await deps.serviceDb().rpc("approve_brand_kit_version", {
      p_version_id: row.id, p_context: ctx, p_hash: ctx.hash, p_fact_ids: ctx.factIds, p_token_estimate: ctx.tokenEstimate, p_actor: actor(c),
    }));

    const changed = previousKit ? diffKits(previousKit, kit) : [];
    const affected = changed.length
      ? check(await c.get("db").rpc("content_affected_by_facts", { p_brand: brand.id, p_fact_ids: changed }))
      : [];
    return c.json({
      version: row.version,
      status: "approved",
      context: { hash: ctx.hash, tokenEstimate: ctx.tokenEstimate, factIds: ctx.factIds },
      unreviewedSuggestions: pending,   // suggested facts are not used until approved
      impact: { changedFactIds: changed, affectedContent: affected },
    });
  });

  r.post("/brands/:brandId/kit/versions/:version/restore", can("brand.update"), async (c) => {
    const brand = await loadBrand(c);
    const row = await getVersion(c, brand.id, versionParam(c));
    const latest = await latestVersion(c, brand);
    return c.json(await insertVersion(c, brand.id, latest, BrandKitSchema.parse(row.kit), "restore", `Restored from version ${row.version}`), 201);
  });

  r.get("/brands/:brandId/kit/impact", can("brand.read"), async (c) => {
    const brand = await loadBrand(c);
    const from = Number(c.req.query("from"));
    const to = Number(c.req.query("to"));
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw new AppError("validation_failed", "from and to versions are required.");
    const [a, b] = await Promise.all([getVersion(c, brand.id, from), getVersion(c, brand.id, to)]);
    const changed = diffKits(BrandKitSchema.parse(a.kit), BrandKitSchema.parse(b.kit));
    const affected = changed.length ? check(await c.get("db").rpc("content_affected_by_facts", { p_brand: brand.id, p_fact_ids: changed })) : [];
    return c.json({ changedFactIds: changed, affectedContent: affected });
  });

  /** The compiled Brand Context generation receives (active approved version). */
  r.get("/brands/:brandId/context", can("brand.read"), async (c) => {
    const brand = await loadBrand(c);
    if (!brand.active_kit_version_id) throw new AppError("not_found", "No approved Brand Kit yet.");
    const row = check(await c.get("db").from("brand_kit_versions").select("kit").eq("id", brand.active_kit_version_id).single());
    return c.json(await compileBrandContext(row.kit, { channel: c.req.query("channel") || undefined }));
  });

  return r;
};
