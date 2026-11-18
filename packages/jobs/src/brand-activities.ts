import { lookup } from "node:dns/promises";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { extractBrandFacts, type ExtractionPage, type LlmProvider } from "@arcatic/ai";
import {
  AppError, BrandKitSchema, OnboardingAnswersSchema, assertSafeUrl, emptyKit, extractVisualSignals, fromDbError,
  hostKey, kitCompleteness, mergeSuggestions, selectPages, sha256Hex, visualSuggestions,
  type BrandKit, type FirecrawlBranding, type SelectedPage, type VisualSignals,
} from "@arcatic/core";
import { jobsRepo, type Db } from "@arcatic/database";
import type { FirecrawlClient } from "@arcatic/integrations";
import type { BrandAnalysisInput, BrandAnalysisResult, ScrapedPageRef } from "./contracts.js";

export interface BrandActivityDeps {
  db: Db;
  llm: LlmProvider;
  firecrawl: FirecrawlClient;
  resolve?: (host: string) => Promise<string[]>;
  newId?: () => string;
}

const MAX_PAGE_CHARS = 200_000;
const dnsResolve = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) {
      throw ApplicationFailure.create({ type: err.code, message: err.message, nonRetryable: !err.retryable, details: [err.details ?? null] });
    }
    throw err;
  }
}

/** Latest kit version for a brand, or an empty kit. */
export async function loadLatestKit(db: Db, workspaceId: string, brandId: string): Promise<{ kit: BrandKit; version: number }> {
  const v = await db.from("brand_kit_versions").select("version, kit").eq("workspace_id", workspaceId).eq("brand_id", brandId)
    .order("version", { ascending: false }).limit(1).maybeSingle();
  if (v.error) throw fromDbError(v.error);
  if (v.data) return { kit: BrandKitSchema.parse(v.data.kit), version: v.data.version as number };
  const b = await db.from("brands").select("name, languages").eq("workspace_id", workspaceId).eq("id", brandId).single();
  if (b.error) throw fromDbError(b.error);
  return { kit: emptyKit(brandId, b.data.name as string, (b.data.languages as string[]) ?? ["en"]), version: 0 };
}

export function createBrandActivities({ db, llm, firecrawl, resolve = dnsResolve, newId = () => crypto.randomUUID().slice(0, 8) }: BrandActivityDeps) {
  return {
    /** SSRF-checked site map → deterministic page selection. Falls back to the home page alone. */
    async discoverPages(input: BrandAnalysisInput): Promise<SelectedPage[]> {
      return wrap(async () => {
        const seed = await assertSafeUrl(input.url, { resolve });
        let links: Array<{ url: string; title?: string }> = [];
        try {
          const m = await firecrawl.map(seed.toString(), { limit: 300 });
          links = (m.links ?? []).map((l) => (typeof l === "string" ? { url: l } : { url: l.url, title: l.title }));
        } catch (e) {
          await jobsRepo.event(db, input.jobId, "log", "Site map unavailable; analysing the home page only", { error: String(e) });
        }
        const pages = selectPages(seed.toString(), links, { max: input.maxPages });
        await jobsRepo.event(db, input.jobId, "log", `Selected ${pages.length} pages`, { pages: pages.map((p) => ({ url: p.url, type: p.type })) });
        return pages;
      });
    },

    /** Scrape one page into `sources` (idempotent per brand+url). Home page also yields visual signals. */
    async scrapePage(input: BrandAnalysisInput, page: SelectedPage): Promise<ScrapedPageRef & { visual?: VisualSignals; branding?: FirecrawlBranding | null }> {
      return wrap(async () => {
        const safe = await assertSafeUrl(page.url, { resolve });
        if (hostKey(safe.hostname) !== hostKey(new URL(input.url).hostname)) throw new AppError("validation_failed", "Page is not on the brand's site.");
        const isHome = page.type === "home";
        const formats: Array<"markdown" | "rawHtml" | { type: "branding" }> = ["markdown"];
        if (isHome) formats.push("rawHtml");
        if (isHome && input.useFirecrawlBranding) formats.push({ type: "branding" });
        Context.current().heartbeat({ url: page.url });
        const res = await firecrawl.scrape(safe.toString(), { formats: formats as never, onlyMainContent: !isHome, timeout: 60_000 }, Context.current().cancellationSignal);
        if (!res.success || !res.data?.markdown) throw new AppError("upstream_error", `Could not read ${page.url}: ${res.error ?? "empty page"}`, { retryable: true });

        const markdown = res.data.markdown.slice(0, MAX_PAGE_CHARS);
        const meta = (res.data.metadata ?? {}) as Record<string, unknown>;
        const row = {
          workspace_id: input.workspaceId,
          brand_id: input.brandId,
          type: "url",
          title: String(meta.title ?? page.title ?? page.url).slice(0, 300),
          url: page.url,
          body: markdown,
          status: "ready",
          content_hash: await sha256Hex(markdown),
          last_ingested_at: new Date().toISOString(),
          language: typeof meta.language === "string" ? meta.language : null,
          metadata: { page_type: page.type, analysis_job_id: input.jobId, status_code: meta.statusCode ?? null, origin: "website_analysis" },
        };
        const existing = await db.from("sources").select("id").eq("workspace_id", input.workspaceId).eq("brand_id", input.brandId).eq("type", "url").eq("url", page.url).maybeSingle();
        if (existing.error) throw fromDbError(existing.error);
        const saved = existing.data
          ? await db.from("sources").update(row).eq("id", existing.data.id).select("id").single()
          : await db.from("sources").insert({ ...row, owner_id: input.requestedBy ?? null }).select("id").single();
        if (saved.error) throw fromDbError(saved.error);

        const rawHtml = (res.data as { rawHtml?: string }).rawHtml;
        return {
          sourceId: saved.data.id as string,
          url: page.url,
          type: page.type,
          chars: markdown.length,
          ...(isHome && rawHtml && { visual: extractVisualSignals(rawHtml, page.url) }),
          ...(isHome && { branding: ((res.data as { branding?: FirecrawlBranding }).branding ?? null) }),
        };
      });
    },

    /**
     * LLM extraction with citation verification + visual signals, merged into a NEW draft kit
     * version. Approved human facts are never overwritten. Idempotent per job.
     */
    async extractBrand(
      input: BrandAnalysisInput,
      pages: ScrapedPageRef[],
      visual: { signals?: VisualSignals; branding?: FirecrawlBranding | null; url: string } | null,
    ): Promise<BrandAnalysisResult> {
      return wrap(async () => {
        const done = await db.from("brand_kit_versions").select("id, version, changed_fact_ids").eq("workspace_id", input.workspaceId).eq("analysis_job_id", input.jobId).maybeSingle();
        if (done.error) throw fromDbError(done.error);
        if (done.data) {
          return { kitVersionId: done.data.id, version: done.data.version, pagesAnalysed: pages.length, pagesFailed: 0, fieldsSuggested: 0, changedFactIds: done.data.changed_fact_ids, citationsKept: 0, citationsDropped: 0 };
        }

        const bodies = await db.from("sources").select("id, url, body, metadata").eq("workspace_id", input.workspaceId).in("id", pages.map((p) => p.sourceId));
        if (bodies.error) throw fromDbError(bodies.error);
        const byId = new Map((bodies.data ?? []).map((r) => [r.id as string, r]));
        const extractionPages: ExtractionPage[] = pages.flatMap((p, i) => {
          const r = byId.get(p.sourceId);
          return r?.body ? [{ pageId: `p${i + 1}`, sourceId: p.sourceId, url: p.url, type: p.type, text: r.body as string }] : [];
        });
        if (extractionPages.length === 0) throw new AppError("validation_failed", "No readable pages to analyse.");

        const ob = await db.from("brand_onboarding").select("answers").eq("workspace_id", input.workspaceId).eq("brand_id", input.brandId).maybeSingle();
        if (ob.error) throw fromDbError(ob.error);
        const onboarding = ob.data ? OnboardingAnswersSchema.safeParse(ob.data.answers).data : undefined;

        const ac = new AbortController();
        Context.current().cancelled.catch(() => ac.abort());
        const latestForName = await loadLatestKit(db, input.workspaceId, input.brandId);
        const extraction = await extractBrandFacts(llm, { brandName: latestForName.kit.name, pages: extractionPages, onboarding, paths: input.paths }, {
          workspaceId: input.workspaceId, jobId: input.jobId, signal: ac.signal,
        });
        const visualFacts = !input.paths?.length || input.paths.some((p) => p.startsWith("visual."))
          ? visualSuggestions(visual?.signals, visual?.url ?? input.url, visual?.branding)
          : {};
        const suggestions = { ...extraction.suggestions, facts: { ...extraction.suggestions.facts, ...visualFacts } };

        // optimistic write: re-read + re-merge if someone saved a version meanwhile
        for (let attempt = 0; attempt < 3; attempt++) {
          const latest = attempt === 0 ? latestForName : await loadLatestKit(db, input.workspaceId, input.brandId);
          const now = new Date().toISOString();
          const merged = mergeSuggestions(latest.kit, suggestions, { now, newId });
          const version = latest.version + 1;
          const kit = { ...merged.kit, version };
          const ins = await db.from("brand_kit_versions").insert({
            workspace_id: input.workspaceId,
            brand_id: input.brandId,
            version,
            base_version: latest.version || null,
            status: "draft",
            origin: input.paths?.length ? "ai_suggestion" : "ai_analysis",
            kit,
            changed_fact_ids: merged.changed,
            completeness: kitCompleteness(kit).score,
            analysis_job_id: input.jobId,
            note: `Website analysis of ${new URL(input.url).hostname}: ${extraction.stats.fieldsSuggested} suggestions from ${extraction.stats.pagesUsed} pages`,
            created_by: input.requestedBy ?? null,
          }).select("id, version").single();
          if (ins.error?.code === "23505") continue;
          if (ins.error) throw fromDbError(ins.error);
          return {
            kitVersionId: ins.data.id as string,
            version,
            pagesAnalysed: extraction.stats.pagesUsed,
            pagesFailed: 0,
            fieldsSuggested: extraction.stats.fieldsSuggested + Object.keys(visualFacts).length,
            changedFactIds: merged.changed,
            citationsKept: extraction.stats.citationsKept,
            citationsDropped: extraction.stats.citationsDropped,
          };
        }
        throw new AppError("conflict", "Brand Kit kept changing during analysis; please retry.", { retryable: true });
      });
    },
  };
}

export type BrandActivities = ReturnType<typeof createBrandActivities>;
