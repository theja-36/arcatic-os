import {
  AppError, articleJsonLd, checkClaims, claimsScore, extractClaims, fromDbError, hostOf, scoreSeo, SeoSettingsSchema, suggestInternalLinks,
  type ContentDoc, type Evidence, type LinkTarget,
} from "@arcatic/core";
import type { Db } from "@arcatic/database";

/**
 * Deterministic SEO/AEO report for one content version: scores, source-backed claims and
 * internal-link suggestions. No AI and no credits; used by the API ("Analyse") and after an SEO
 * article is generated. Stored once per version in seo_reports.
 */
const LONG_FORM: Record<string, number> = { blog: 800, landing_page: 400, case_study: 600, press_release: 300, newsletter: 300, document: 600 };

const one = async <T>(q: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>): Promise<T> => {
  const r = await q;
  if (r.error) throw fromDbError(r.error as never);
  return r.data as T;
};

export async function buildSeoReport(db: Db, a: { workspaceId: string; contentItemId: string; versionId?: string | null }) {
  const item = await one<{ id: string; brand_id: string; type: string; title: string | null; seo: unknown; current_version_id: string | null } | null>(
    db.from("content_items").select("id, brand_id, type, title, seo, current_version_id").eq("id", a.contentItemId).eq("workspace_id", a.workspaceId).maybeSingle());
  if (!item) throw new AppError("not_found", "Content not found.");
  const versionId = a.versionId ?? item.current_version_id;
  if (!versionId) throw new AppError("conflict", "This content has no version yet.");
  const version = await one<{ id: string; body: { doc?: ContentDoc }; source_chunk_ids: string[] | null; created_at: string } | null>(
    db.from("content_versions").select("id, body, source_chunk_ids, created_at").eq("id", versionId).eq("content_item_id", item.id).maybeSingle());
  if (!version?.body?.doc) throw new AppError("conflict", "This version has no document.");
  const doc = version.body.doc;
  const seo = SeoSettingsSchema.safeParse(item.seo ?? {}).data ?? {};

  const brand = await one<{ name: string; website_url: string | null; active_kit_version_id: string | null }>(db.from("brands").select("name, website_url, active_kit_version_id").eq("id", item.brand_id).single());
  const siteHost = brand.website_url ? hostOf(brand.website_url) : null;
  const siteHosts = siteHost ? [siteHost] : [];

  // evidence: the knowledge the draft was generated from + the approved brand context
  const evidence: Evidence[] = [];
  const chunkIds = (version.source_chunk_ids ?? []).slice(0, 60);
  if (chunkIds.length) {
    const chunks = await one<Array<{ id: string; content: string; source_id: string }>>(db.from("knowledge_chunks").select("id, content, source_id").in("id", chunkIds));
    const srcs = chunks.length ? await one<Array<{ id: string; url: string | null; title: string }>>(db.from("sources").select("id, url, title").in("id", [...new Set(chunks.map((c) => c.source_id))])) : [];
    const byId = new Map(srcs.map((s) => [s.id, s]));
    for (const c of chunks) evidence.push({ id: c.id, kind: "chunk", text: c.content, url: byId.get(c.source_id)?.url ?? null, title: byId.get(c.source_id)?.title ?? null });
  }
  if (brand.active_kit_version_id) {
    const ctx = await one<{ context: { data?: unknown } } | null>(db.from("brand_contexts").select("context").eq("kit_version_id", brand.active_kit_version_id).maybeSingle());
    if (ctx?.context?.data) evidence.push({ id: "brand_context", kind: "fact", text: JSON.stringify(ctx.context.data).replace(/[{}"[\]]/g, " "), title: "Brand Kit" });
  }

  // internal link targets: this brand's published pages + crawled pages of its own site
  const targets: LinkTarget[] = [];
  if (siteHosts.length) {
    const published = await one<Array<{ content_item_id: string; external_url: string | null }>>(
      db.from("schedules").select("content_item_id, external_url").eq("brand_id", item.brand_id).eq("status", "published").not("external_url", "is", null).neq("content_item_id", item.id).limit(300));
    const ids = [...new Set(published.map((p) => p.content_item_id))];
    const titles = ids.length ? await one<Array<{ id: string; title: string | null; seo: { primary?: string; secondary?: string[] } | null }>>(db.from("content_items").select("id, title, seo").in("id", ids)) : [];
    const t = new Map(titles.map((x) => [x.id, x]));
    for (const p of published) {
      const it = t.get(p.content_item_id);
      if (p.external_url && it?.title) targets.push({ url: p.external_url, title: it.title, keywords: [it.seo?.primary, ...(it.seo?.secondary ?? [])].filter((k): k is string => !!k) });
    }
    const pages = await one<Array<{ url: string | null; title: string; summary: string | null }>>(
      db.from("sources").select("url, title, summary").eq("brand_id", item.brand_id).in("type", ["url", "crawl"]).eq("status", "ready").not("url", "is", null).limit(300));
    for (const p of pages) if (p.url) targets.push({ url: p.url, title: p.title, text: p.summary });
  }

  const target = { primary: seo.primary ?? null, secondary: seo.secondary ?? [], question: seo.question ?? null };
  const scored = scoreSeo(doc, target, { siteHosts, minWords: LONG_FORM[item.type] ?? 300 });
  const claims = checkClaims(extractClaims(doc), evidence);
  const cs = claimsScore(claims);
  const links = siteHosts.length ? suggestInternalLinks(doc, targets, { siteHosts, selfUrl: seo.canonicalUrl ?? null }) : [];
  const aeo = scored.checks.filter((c) => c.group === "aeo");
  const seoOnly = scored.checks.filter((c) => c.group === "seo");
  const pct = (cs2: typeof scored.checks) => {
    const tot = cs2.reduce((s, c) => s + c.weight, 0);
    return tot ? Math.round((cs2.reduce((s, c) => s + c.weight * (c.status === "pass" ? 1 : c.status === "warn" ? 0.5 : 0), 0) / tot) * 100) : 0;
  };
  const scores = {
    overall: Math.round(pct(seoOnly) * 0.45 + pct(aeo) * 0.35 + cs.score * 0.2),
    seo: { score: pct(seoOnly), checks: seoOnly },
    aeo: { score: pct(aeo), checks: aeo },
    claims: cs,
    evidenceCount: evidence.length,
  };
  const jsonld = articleJsonLd(doc, { publisher: brand.name, url: seo.canonicalUrl ?? null, dateModified: version.created_at });
  const row = { workspace_id: a.workspaceId, brand_id: item.brand_id, content_item_id: item.id, content_version_id: version.id, scores, claims, links, schema_jsonld: jsonld };
  const saved = await one<{ id: string; created_at: string }>(db.from("seo_reports").upsert(row, { onConflict: "content_version_id" }).select("id, created_at").single());
  return { id: saved.id, versionId: version.id, scores, claims, links, schemaJsonld: jsonld, createdAt: saved.created_at };
}
