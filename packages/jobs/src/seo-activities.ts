import { ApplicationFailure, Context } from "@temporalio/activity";
import { analyzeCompetitor, seoBrief, suggestKeywords, type LlmProvider } from "@arcatic/ai";
import {
  AppError, assertSafeUrl, clusterKeywords, estimateCredits, fromDbError, hostKey, mergeIdeas, selectPages,
  type KeywordIdea,
} from "@arcatic/core";
import type { Db } from "@arcatic/database";
import type { AdsSyncClient, Embedder, FirecrawlClient } from "@arcatic/integrations";
import { activeBrandContext } from "./content-activity.js";
import type { CompetitorResearchInput, GenerateContentInput, KeywordResearchInput, SeoArticleInput } from "./contracts.js";
import { readSecret, resolveDns } from "./publishing.js";
import { retrieveForGeneration } from "./retrieval.js";
import { buildSeoReport } from "./seo-report.js";

/**
 * SEO / AEO research. Competitor pages are fetched through Firecrawl (SSRF-checked, own-site
 * only per competitor); keyword numbers come only from Google Keyword Planner via the ads-sync
 * sidecar when an Ads account is connected, otherwise keywords are AI suggestions without numbers.
 */
export interface SeoDeps { db: Db; llm: LlmProvider; firecrawl: FirecrawlClient; embedder?: Embedder | null; ads?: AdsSyncClient | null; encryptionKey?: string; resolve?: (h: string) => Promise<string[]> }

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw ApplicationFailure.create({ type: err.code, message: err.message, nonRetryable: !err.retryable });
    throw err;
  }
}

const PAGE_CHARS = 12_000;

export function createSeoActivities({ db, llm, firecrawl, embedder = null, ads = null, encryptionKey, resolve = resolveDns }: SeoDeps) {
  const one = async <T>(q: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>): Promise<T> => {
    const r = await q;
    if (r.error) throw fromDbError(r.error as never);
    return r.data as T;
  };

  return {
    async competitorResearch(input: CompetitorResearchInput): Promise<{ pages: number; claims: number; credits: number }> {
      return wrap(async () => {
        const c = await one<{ id: string; name: string; url: string; brand_id: string; workspace_id: string }>(db.from("competitors").select("id, name, url, brand_id, workspace_id").eq("id", input.competitorId).eq("workspace_id", input.workspaceId).single());
        await one(db.from("competitors").update({ status: "analyzing", generation_job_id: input.jobId, error: null }).eq("id", c.id));
        const seed = await assertSafeUrl(c.url, { resolve });
        let links: Array<{ url: string; title?: string }> = [];
        try {
          const m = await firecrawl.map(seed.toString(), { limit: 200 });
          links = (m.links ?? []).map((l) => (typeof l === "string" ? { url: l } : { url: l.url, title: l.title }));
        } catch { /* home page only */ }
        const chosen = selectPages(seed.toString(), links, { max: input.maxPages ?? 6 });
        const pages: Array<{ id: string; url: string; title: string; text: string }> = [];
        for (const p of chosen) {
          Context.current().heartbeat({ url: p.url });
          try {
            const safe = await assertSafeUrl(p.url, { resolve });
            if (hostKey(safe.hostname) !== hostKey(seed.hostname)) continue;
            const res = await firecrawl.scrape(safe.toString(), { formats: ["markdown"], onlyMainContent: true, timeout: 60_000 }, Context.current().cancellationSignal);
            if (res.success && res.data?.markdown) {
              const meta = (res.data.metadata ?? {}) as Record<string, unknown>;
              pages.push({ id: `p${pages.length + 1}`, url: safe.toString(), title: String(meta.title ?? p.title ?? p.url).slice(0, 200), text: res.data.markdown.slice(0, PAGE_CHARS) });
            }
          } catch { /* skip unreadable page */ }
        }
        if (!pages.length) throw new AppError("upstream_error", `Couldn't read ${c.url}.`);
        const brand = await activeBrandContext(db, c.workspace_id, c.brand_id);
        const r = await analyzeCompetitor(llm, { brand, name: c.name, pages, language: brand.data.languages.primary || "en" }, { workspaceId: c.workspace_id, jobId: input.jobId });
        await one(db.from("competitors").update({ status: "ready", analysis: r.output, analyzed_at: new Date().toISOString() }).eq("id", c.id));
        return { pages: pages.length, claims: r.output.claims.length, credits: estimateCredits({ kind: "research.competitor" }).estimate };
      });
    },

    async keywordResearch(input: KeywordResearchInput): Promise<{ ideas: number; clusters: number; source: string; credits: number }> {
      return wrap(async () => {
        const set = await one<{ id: string; brand_id: string; workspace_id: string; seeds: string[]; seed_url: string | null; language: string; geo: string; source: string }>(
          db.from("keyword_sets").select("id, brand_id, workspace_id, seeds, seed_url, language, geo, source").eq("id", input.keywordSetId).eq("workspace_id", input.workspaceId).single());
        await one(db.from("keyword_sets").update({ status: "running", generation_job_id: input.jobId, error: null }).eq("id", set.id));
        let planner: KeywordIdea[] = [];
        if (set.source === "google_ads_keyword_planner") {
          if (!ads) throw new AppError("conflict", "The ads-sync service isn't configured (ADS_SYNC_URL).");
          const conn = await one<{ account_ref: string; secret_id: string | null; settings: { loginCustomerId?: string } }>(
            db.from("analytics_connections").select("account_ref, secret_id, settings").eq("id", input.connectionId!).eq("workspace_id", set.workspace_id).eq("provider", "google_ads").single());
          const res = await ads.keywordIdeas({
            customerId: conn.account_ref, loginCustomerId: conn.settings.loginCustomerId ?? null,
            refreshToken: await readSecret(db, { workspaceId: set.workspace_id, secretId: conn.secret_id, purpose: "google_ads_refresh_token", key: encryptionKey }),
            keywords: set.seeds, url: set.seed_url, locationIds: input.locationIds ?? [], languageId: input.languageId,
          });
          planner = res.ideas.map((i) => ({ ...i, competition: i.competition ?? null }));
        }
        Context.current().heartbeat();
        const brand = await activeBrandContext(db, set.workspace_id, set.brand_id);
        const competitorTopics = (await one<Array<{ analysis: { topics?: Array<{ topic: string }> } | null }>>(db.from("competitors").select("analysis").eq("brand_id", set.brand_id).eq("status", "ready").limit(10)))
          .flatMap((c) => (c.analysis?.topics ?? []).map((t) => t.topic));
        const ai = await suggestKeywords(llm, { brand, seeds: set.seeds.length ? set.seeds : [brand.data.name], language: set.language, geo: set.geo, competitorTopics }, { workspaceId: set.workspace_id, jobId: input.jobId });
        const ideas = mergeIdeas(planner, ai.output).slice(0, 400);
        const clusters = clusterKeywords(ideas);
        await one(db.from("keyword_sets").update({ status: "ready", ideas, clusters }).eq("id", set.id));
        return { ideas: ideas.length, clusters: clusters.length, source: planner.length ? "google_ads_keyword_planner" : "ai_suggested", credits: estimateCredits({ kind: "research.keywords" }).estimate };
      });
    },

    /** Brief → child generation input (blog.article@2). The child job row is created once; retries reuse it. */
    async prepareSeoArticle(input: SeoArticleInput): Promise<{ child: GenerateContentInput; brief: unknown }> {
      return wrap(async () => {
        const brand = await activeBrandContext(db, input.workspaceId, input.brandId);
        const comps = input.competitorIds.length
          ? await one<Array<{ name: string; analysis: { topics?: Array<{ topic: string }>; gaps?: Array<{ topic: string }> } | null }>>(db.from("competitors").select("name, analysis").eq("brand_id", input.brandId).in("id", input.competitorIds).eq("status", "ready"))
          : [];
        const knowledge = (await retrieveForGeneration(db, embedder, { brandId: input.brandId, query: [input.keyword, ...input.secondary].join(" "), requestedBy: input.requestedBy, limit: 8 }))
          .map((k) => ({ chunkId: k.chunkId, content: k.content, url: k.url }));
        Context.current().heartbeat();
        const r = await seoBrief(llm, {
          brand, keyword: input.keyword, secondary: input.secondary, language: input.language, knowledge,
          competitors: comps.map((c) => ({ name: c.name, topics: (c.analysis?.topics ?? []).map((t) => t.topic), gaps: (c.analysis?.gaps ?? []).map((g) => g.topic) })),
        }, { workspaceId: input.workspaceId, jobId: input.jobId });
        const key = `seo-article:${input.jobId}`;
        const existing = await one<{ id: string } | null>(db.from("generation_jobs").select("id").eq("workspace_id", input.workspaceId).eq("idempotency_key", key).maybeSingle());
        let childId: string = existing?.id ?? crypto.randomUUID();
        if (!existing) {
          const ins = await db.from("generation_jobs").insert({ id: childId, workspace_id: input.workspaceId, brand_id: input.brandId, kind: "generate.blog", idempotency_key: key, input: { seoArticleJobId: input.jobId }, estimated_credits: 0 });
          if (ins.error?.code === "23505") childId = (await one<{ id: string }>(db.from("generation_jobs").select("id").eq("workspace_id", input.workspaceId).eq("idempotency_key", key).single())).id;
          else if (ins.error) throw fromDbError(ins.error);
        }
        const b = r.output;
        return {
          brief: b,
          child: {
            jobId: childId, workspaceId: input.workspaceId, brandId: input.brandId, chargeCredits: 0, templateKey: "blog.article@2", requestedBy: input.requestedBy,
            projectId: input.projectId,
            input: {
              channel: "blog", topic: b.titleOptions[0] ?? input.keyword, keyword: input.keyword, secondary: input.secondary.slice(0, 10), question: b.question.slice(0, 300),
              outline: b.outline, faqs: b.faqs, words: input.words ?? b.words, language: input.language, ...(b.notes && { focus: b.notes.slice(0, 1000) }),
            },
          },
        };
      });
    },

    async finishSeoArticle(a: { workspaceId: string; contentItemId: string; keyword: string; secondary: string[]; question: string; intent?: string | null; keywordSetId?: string | null }): Promise<{ overall: number }> {
      return wrap(async () => {
        await one(db.from("content_items").update({ seo: { primary: a.keyword, secondary: a.secondary, question: a.question, intent: a.intent ?? null, keywordSetId: a.keywordSetId ?? null } }).eq("id", a.contentItemId).eq("workspace_id", a.workspaceId));
        const rep = await buildSeoReport(db, { workspaceId: a.workspaceId, contentItemId: a.contentItemId });
        return { overall: rep.scores.overall };
      });
    },

    async markResearchFailed(a: { table: "competitors" | "keyword_sets"; id: string; message: string }): Promise<void> {
      await db.from(a.table).update({ status: "failed", error: a.message.slice(0, 500) }).eq("id", a.id);
    },
  };
}

export type SeoActivities = ReturnType<typeof createSeoActivities>;
