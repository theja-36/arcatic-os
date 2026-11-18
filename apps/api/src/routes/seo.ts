import {
  AppError, LANGUAGES, SeoSettingsSchema, assertSafeUrl, contentCost, estimateCredits, fromDbError, hostKey, sumEstimates, type Estimate,
} from "@arcatic/core";
import { buildSeoReport } from "@arcatic/jobs/seo-report";
import { lookup } from "node:dns/promises";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { body, check, idempotencyKey, ok } from "../http.js";
import { startCostedJob } from "../job-start.js";
import { requirePermission as can } from "../middleware/workspace.js";
import type { ApiDeps, AppEnv } from "../types.js";

/**
 * SEO / AEO: keyword research (Keyword Planner numbers only when a Google Ads account is used,
 * otherwise AI suggestions without numbers), competitor research, research-backed articles and
 * per-version reports (scores, source-backed claims, internal links, JSON-LD).
 */
const SET_COLS = "id, name, seeds, seed_url, language, geo, source, status, ideas, clusters, error, generation_job_id, created_at, updated_at";
const COMP_COLS = "id, name, url, notes, status, analysis, analyzed_at, error, generation_job_id, created_at, updated_at";
const LANG = z.enum(Object.keys(LANGUAGES) as [string, ...string[]]);

export const seoArticleCost = (): Estimate => sumEstimates([estimateCredits({ kind: "seo.brief" }), contentCost("blog")]);

function maybe<T>(res: { data: T; error: { message: string; code?: string } | null }): T | null {
  if (res.error) throw fromDbError(res.error);
  return res.data ?? null;
}

export const seoRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  const ws = (c: Context<AppEnv>) => c.get("workspaceId");
  const brandId = (c: Context<AppEnv>) => c.req.param("brandId")!;
  const actor = (c: Context<AppEnv>) => { const p = c.get("principal"); return p.kind === "user" ? p.userId : null; };
  const svc = () => deps.serviceDb();
  const resolve = deps.resolveHost ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => a.address));
  /** Read through the caller's client so brand-restricted members only reach their brands. */
  async function brand(c: Context<AppEnv>) {
    const b = maybe(await c.get("db").from("brands").select("id, name, website_url, languages").eq("workspace_id", ws(c)).eq("id", brandId(c)).is("deleted_at", null).maybeSingle()) as { id: string; name: string; website_url: string | null; languages: string[] | null } | null;
    if (!b) throw new AppError("not_found", "Brand not found.");
    return b;
  }
  async function item(c: Context<AppEnv>) {
    const it = maybe(await c.get("db").from("content_items").select("id, type, title, seo, current_version_id").eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).eq("id", c.req.param("itemId")!).maybeSingle()) as { id: string; type: string; seo: unknown; current_version_id: string | null } | null;
    if (!it) throw new AppError("not_found", "Content not found.");
    return it;
  }

  // ---------------------------------------------------------------- keyword research
  r.get("/brands/:brandId/seo/keyword-sets", can("content.read"), async (c) => {
    return c.json({ data: check(await c.get("db").from("keyword_sets").select(SET_COLS).eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).order("created_at", { ascending: false }).limit(50)) });
  });
  r.get("/brands/:brandId/seo/keyword-sets/:setId", can("content.read"), async (c) => {
    const s = maybe(await c.get("db").from("keyword_sets").select(SET_COLS).eq("brand_id", brandId(c)).eq("id", c.req.param("setId")!).maybeSingle());
    if (!s) throw new AppError("not_found", "Keyword research not found.");
    return c.json(s);
  });

  r.post("/brands/:brandId/seo/keyword-sets", can("content.create"), async (c) => {
    const i = await body(c, z.object({
      name: z.string().trim().min(1).max(160),
      seeds: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
      seedUrl: z.string().url().max(2000).nullable().optional(),
      language: LANG.optional(), geo: z.string().trim().min(2).max(60).default("India"),
      connectionId: z.uuid().nullable().optional(),                     // Google Ads account → Keyword Planner numbers
      locationIds: z.array(z.string().regex(/^\d+$/)).max(10).optional(), languageId: z.string().regex(/^\d+$/).optional(),
    }).refine((x) => x.seeds.length || x.seedUrl, "Give at least one seed keyword or a page URL."));
    const b = await brand(c);
    if (i.seedUrl) await assertSafeUrl(i.seedUrl, { resolve });
    if (i.connectionId) {
      const conn = maybe(await c.get("db").from("analytics_connections").select("id, provider, brand_id, status").eq("workspace_id", ws(c)).eq("id", i.connectionId).maybeSingle()) as { provider: string; brand_id: string | null; status: string } | null;
      if (!conn || conn.provider !== "google_ads") throw new AppError("validation_failed", "Keyword Planner needs a connected Google Ads account.");
      if (conn.brand_id && conn.brand_id !== b.id) throw new AppError("forbidden", "That Google Ads account belongs to another brand.");
      if (!deps.ads) throw new AppError("conflict", "The ads-sync service isn't configured, so Keyword Planner is unavailable.");
    }
    const set = check(await svc().from("keyword_sets").insert({
      workspace_id: ws(c), brand_id: b.id, name: i.name, seeds: i.seeds, seed_url: i.seedUrl ?? null, language: i.language ?? b.languages?.[0] ?? "en", geo: i.geo,
      source: i.connectionId ? "google_ads_keyword_planner" : "ai_suggested", status: "running", created_by: actor(c),
    }).select("id").single()) as { id: string };
    const res = await startCostedJob(deps, c, {
      idempotencyKey: idempotencyKey(c), kind: "research.keywords", brandId: b.id, cost: estimateCredits({ kind: "research.keywords" }), input: { keywordSetId: set.id },
      start: (s, a) => s.keywordResearch({ ...a, workspaceId: ws(c), brandId: b.id, keywordSetId: set.id, connectionId: i.connectionId ?? undefined, locationIds: i.locationIds, languageId: i.languageId }),
    });
    if (res.replay) { ok(await svc().from("keyword_sets").delete().eq("id", set.id)); return c.json({ job: res.job }, 202); }
    if (res.job) ok(await svc().from("keyword_sets").update({ generation_job_id: res.job.id }).eq("id", set.id));
    return c.json({ id: set.id, job: res.job, credits: res.credits }, 202);
  });

  // ---------------------------------------------------------------- competitors
  r.get("/brands/:brandId/seo/competitors", can("content.read"), async (c) => {
    return c.json({ data: check(await c.get("db").from("competitors").select(COMP_COLS).eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).order("created_at", { ascending: true }).limit(50)) });
  });

  r.post("/brands/:brandId/seo/competitors", can("content.create"), async (c) => {
    const i = await body(c, z.object({ name: z.string().trim().min(1).max(160), url: z.string().url().max(2000), notes: z.string().trim().max(2000).optional() }));
    const b = await brand(c);
    const safe = await assertSafeUrl(i.url, { resolve });
    if (b.website_url && hostKey(new URL(b.website_url).hostname) === hostKey(safe.hostname)) throw new AppError("validation_failed", "That's your own website.");
    const ins = await svc().from("competitors").insert({ workspace_id: ws(c), brand_id: b.id, name: i.name, url: safe.origin, notes: i.notes ?? null, created_by: actor(c) }).select(COMP_COLS).single();
    if (ins.error?.code === "23505") throw new AppError("conflict", "That competitor is already on the list.");
    if (ins.error) throw fromDbError(ins.error);
    return c.json(ins.data, 201);
  });

  r.post("/brands/:brandId/seo/competitors/:competitorId/analyze", can("content.create"), async (c) => {
    const comp = maybe(await c.get("db").from("competitors").select("id, status").eq("brand_id", brandId(c)).eq("id", c.req.param("competitorId")!).maybeSingle()) as { id: string; status: string } | null;
    if (!comp) throw new AppError("not_found", "Competitor not found.");
    if (comp.status === "analyzing") throw new AppError("conflict", "Already being analysed.");
    const res = await startCostedJob(deps, c, {
      idempotencyKey: idempotencyKey(c), kind: "research.competitor", brandId: brandId(c), cost: estimateCredits({ kind: "research.competitor" }), input: { competitorId: comp.id },
      start: (s, a) => s.competitorResearch({ ...a, workspaceId: ws(c), brandId: brandId(c), competitorId: comp.id }),
    });
    return c.json({ job: res.job, credits: res.credits }, 202);
  });

  r.delete("/brands/:brandId/seo/competitors/:competitorId", can("content.delete"), async (c) => {
    await brand(c);
    const d = await svc().from("competitors").delete().eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).eq("id", c.req.param("competitorId")!).select("id");
    if (d.error) throw fromDbError(d.error);
    if (!d.data?.length) throw new AppError("not_found", "Competitor not found.");
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------- research-backed article
  r.post("/brands/:brandId/seo/articles", can("content.create"), async (c) => {
    const i = await body(c, z.object({
      keyword: z.string().trim().min(2).max(120), secondary: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
      competitorIds: z.array(z.uuid()).max(5).default([]), keywordSetId: z.uuid().nullable().optional(),
      words: z.number().int().min(300).max(3000).optional(), language: LANG.optional(), projectId: z.uuid().nullable().optional(),
    }));
    const b = await brand(c);
    if (i.projectId) {
      const p = maybe(await c.get("db").from("projects").select("id, status").eq("brand_id", b.id).eq("id", i.projectId).maybeSingle()) as { status: string } | null;
      if (!p || p.status !== "active") throw new AppError("not_found", "Project not found.");
    }
    const res = await startCostedJob(deps, c, {
      idempotencyKey: idempotencyKey(c), kind: "seo.article", brandId: b.id, cost: seoArticleCost(), input: { keyword: i.keyword, secondary: i.secondary },
      start: (s, a) => s.seoArticle({ ...a, workspaceId: ws(c), brandId: b.id, keyword: i.keyword, secondary: i.secondary, competitorIds: i.competitorIds, keywordSetId: i.keywordSetId ?? null, words: i.words, language: i.language ?? b.languages?.[0] ?? "en", projectId: i.projectId ?? undefined, requestedBy: actor(c) ?? undefined }),
    });
    return c.json({ job: res.job, credits: res.credits }, 202);
  });

  // ---------------------------------------------------------------- per-content settings and report
  r.get("/brands/:brandId/content/:itemId/seo", can("content.read"), async (c) => {
    const it = await item(c);
    const report = it.current_version_id
      ? maybe(await c.get("db").from("seo_reports").select("id, content_version_id, scores, claims, links, schema_jsonld, created_at").eq("content_version_id", it.current_version_id).maybeSingle())
      : null;
    return c.json({ settings: SeoSettingsSchema.safeParse(it.seo ?? {}).data ?? {}, report, stale: !report && !!it.current_version_id });
  });

  r.put("/brands/:brandId/content/:itemId/seo", can("content.update"), async (c) => {
    const i = await body(c, SeoSettingsSchema);
    const it = await item(c);
    ok(await svc().from("content_items").update({ seo: i }).eq("workspace_id", ws(c)).eq("id", it.id));
    return c.json({ settings: i });
  });

  /** Deterministic: no AI, no credits. */
  r.post("/brands/:brandId/content/:itemId/seo/analyze", can("content.update"), async (c) => {
    const it = await item(c);
    return c.json(await buildSeoReport(svc(), { workspaceId: ws(c), contentItemId: it.id }));
  });

  return r;
};
