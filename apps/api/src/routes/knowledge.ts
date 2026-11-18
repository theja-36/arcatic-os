import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  AppError, CreateSourceSchema, DriveImportSchema, PaginationSchema, SearchSchema, UpdateSourceSchema, assertSafeUrl, charsToPages,
  estimateCredits, fromDbError, isStale, type CreateSourceInput, type Estimate,
} from "@arcatic/core";
import { encryptSecret } from "@arcatic/database";
import { toPgVector } from "@arcatic/integrations";
import type { SourceKind } from "@arcatic/jobs";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { body, check, idempotencyKey, ok, parse } from "../http.js";
import { startCostedJob } from "../job-start.js";
import { requirePermission as can } from "../middleware/workspace.js";
import type { ApiDeps, AppEnv } from "../types.js";

const LIST_COLUMNS = "id, type, title, url, status, error, summary, tags, language, visibility, owner_id, parent_source_id, chunk_count, embedded_count, embedding_model, byte_size, duration_ms, parser, refresh_interval, last_ingested_at, last_job_id, media_asset_id, created_at, updated_at";
const ListSchema = PaginationSchema.extend({
  type: z.string().optional(), status: z.string().optional(), tag: z.string().optional(), q: z.string().max(100).optional(), parent: z.uuid().optional(),
});
const dns = async (h: string) => (await lookup(h, { all: true })).map((a) => a.address);
const round = (n: number) => Math.round(n * 1000) / 1000;
const intervalDays = (iv: string | null) => (iv ? Number(iv.match(/(\d+) days?/)?.[1] ?? 0) || null : null);

/** Reserve for the worst case; the workflow settles actual usage. */
export function sourceCost(input: CreateSourceInput | { type: "drive" }, assetBytes?: number): Estimate {
  switch (input.type) {
    case "url": return estimateCredits({ kind: "ingest.url" });
    case "crawl": return estimateCredits({ kind: "ingest.crawl_page", quantity: input.limit });
    case "text":
    case "social_reference": return estimateCredits({ kind: "ingest.document_page", quantity: charsToPages(input.body.length) });
    case "media": {
      const max = estimateCredits({ kind: "ingest.media_minute", quantity: input.maxMinutes });
      return { estimate: round(max.estimate / 2), max: max.max };
    }
    case "file":
    case "drive": {
      // pages unknown until parsed: assume ~20 KB/page, between 5 and 300 pages
      const pages = Math.min(300, Math.max(5, Math.ceil((assetBytes ?? 1_000_000) / 20_000)));
      return estimateCredits({ kind: "ingest.document_page", quantity: pages });
    }
  }
}

export const knowledgeRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  const resolve = deps.resolveHost ?? dns;
  const actor = (c: Context<AppEnv>) => {
    const p = c.get("principal");
    return p.kind === "user" ? p.userId : null;
  };

  async function loadBrand(c: Context<AppEnv>) {
    const res = await c.get("db").from("brands").select("id").eq("workspace_id", c.get("workspaceId")).eq("id", c.req.param("brandId")!).is("deleted_at", null).maybeSingle();
    if (res.error) throw fromDbError(res.error);
    if (!res.data) throw new AppError("not_found", "Brand not found.");
    return res.data.id as string;
  }
  async function loadSource(c: Context<AppEnv>, columns = "*") {
    const res = await c.get("db").from("sources").select(columns).eq("workspace_id", c.get("workspaceId")).eq("id", c.req.param("sourceId")!).maybeSingle();
    if (res.error) throw fromDbError(res.error);
    const row = res.data as unknown as Record<string, unknown> | null;
    // API keys use the service client: apply the private-source rule here too
    if (!row || (c.get("principal").kind === "api_key" && row.visibility === "private")) throw new AppError("not_found", "Source not found.");
    return row;
  }

  function startIngest(c: Context<AppEnv>, key: string, brandId: string, sourceId: string, kind: SourceKind, cost: Estimate, maxMinutes?: number) {
    const ws = c.get("workspaceId");
    const requestedBy = actor(c) ?? undefined;
    return startCostedJob(deps, c, {
      idempotencyKey: key, kind: `ingest.${kind}`, brandId, cost, input: { sourceId, kind, ...(maxMinutes && { maxMinutes }) },
      extra: { source_id: sourceId },
      start: (s, a) => s.ingestSource({ ...a, workspaceId: ws, brandId, sourceId, kind, maxMinutes, requestedBy }),
    });
  }

  // ---- list / read --------------------------------------------------------
  r.get("/brands/:brandId/sources", can("knowledge.read"), async (c) => {
    const brandId = await loadBrand(c);
    const q = parse(ListSchema, c.req.query());
    let query = c.get("db").from("sources").select(LIST_COLUMNS).eq("workspace_id", c.get("workspaceId")).eq("brand_id", brandId)
      .order("created_at", { ascending: false }).limit(q.limit + 1);
    query = q.parent ? query.eq("parent_source_id", q.parent) : query.is("parent_source_id", null);
    if (q.type) query = query.eq("type", q.type);
    if (q.status) query = query.eq("status", q.status);
    if (q.tag) query = query.contains("tags", [q.tag]);
    if (q.q) query = query.ilike("title", `%${q.q.replace(/[%_]/g, "")}%`);
    if (q.cursor) query = query.lt("created_at", q.cursor);
    if (c.get("principal").kind === "api_key") query = query.eq("visibility", "brand");
    const rows = check(await query) as unknown as Array<Record<string, unknown>>;
    const page = rows.slice(0, q.limit).map((s) => ({
      ...s, stale: isStale(s.last_ingested_at as string | null, intervalDays(s.refresh_interval as string | null)),
    }));
    return c.json({ data: page, next_cursor: rows.length > q.limit ? ((page.at(-1) as { created_at?: string } | undefined)?.created_at ?? null) : null });
  });

  r.get("/brands/:brandId/sources/:sourceId", can("knowledge.read"), async (c) => {
    await loadBrand(c);
    const s = await loadSource(c);
    const { body: text, ...rest } = s as { body?: string | null } & Record<string, unknown>;
    const children = await c.get("db").from("sources").select("id, title, url, status, chunk_count", { count: "exact" }).eq("parent_source_id", s.id as string).order("created_at").limit(50);
    return c.json({
      ...rest,
      metadata: { ...(rest.metadata as object), segments: undefined },
      preview: text ? text.slice(0, 5000) : null,
      previewTruncated: (text?.length ?? 0) > 5000,
      stale: isStale(rest.last_ingested_at as string | null, intervalDays(rest.refresh_interval as string | null)),
      children: { data: children.data ?? [], total: children.count ?? 0 },
    });
  });

  // ---- create -------------------------------------------------------------
  r.post("/brands/:brandId/sources", can("knowledge.create"), async (c) => {
    const key = idempotencyKey(c);
    const input = await body(c, CreateSourceSchema);
    const brandId = await loadBrand(c);
    const ws = c.get("workspaceId");

    // replay before any side effect
    const prior = await deps.serviceDb().from("generation_jobs").select("id, kind, status, source_id").eq("workspace_id", ws).eq("idempotency_key", key).maybeSingle();
    if (prior.data) return c.json({ source: { id: prior.data.source_id }, job: prior.data }, 202);

    let assetBytes: number | undefined;
    const row: Record<string, unknown> = {
      workspace_id: ws, brand_id: brandId, type: input.type, status: "pending", tags: input.tags, visibility: input.visibility, owner_id: actor(c),
    };
    if (input.type === "url" || input.type === "crawl") {
      const safe = await assertSafeUrl(input.url, { resolve });
      Object.assign(row, { url: safe.toString(), title: input.title ?? safe.toString() });
      if (input.refreshDays) row.refresh_interval = `${input.refreshDays} days`;
      if (input.type === "crawl") row.crawl_options = { limit: input.limit, includePaths: input.includePaths, excludePaths: input.excludePaths };
    } else if (input.type === "text") {
      Object.assign(row, { title: input.title, body: input.body, parser: "plain" });
    } else if (input.type === "social_reference") {
      Object.assign(row, { title: input.title ?? `${input.platform} post`, body: input.body, url: input.url ?? null, parser: "plain", metadata: { platform: input.platform } });
    } else {
      const asset = check(await c.get("db").from("media_assets").select("id, kind, status, bytes, title").eq("workspace_id", ws).eq("id", input.mediaAssetId).single());
      if (asset.status !== "ready") throw new AppError("validation_failed", "Finish the upload first.");
      const isMedia = asset.kind === "audio" || asset.kind === "video";
      if (input.type === "media" && !isMedia) throw new AppError("validation_failed", "That file isn't audio or video.");
      if (input.type === "file" && (isMedia || asset.kind === "image")) throw new AppError("validation_failed", "Use a document (PDF, DOCX, PPTX, XLSX, HTML, TXT, MD, CSV).");
      assetBytes = Number(asset.bytes ?? 0);
      Object.assign(row, { title: input.title ?? asset.title ?? "Upload", media_asset_id: asset.id, ...(input.type === "media" && input.language !== "auto" && { language: input.language }) });
    }

    const source = check(await c.get("db").from("sources").insert(row).select("id, type, title, status").single());
    const cost = sourceCost(input, assetBytes);
    try {
      const res = await startIngest(c, key, brandId, source.id, input.type, cost, input.type === "media" ? input.maxMinutes : undefined);
      return c.json({ source, job: res.job, credits: res.credits }, 202);
    } catch (e) {
      // no job was started (e.g. insufficient credits): don't leave an orphan pending source
      await deps.serviceDb().from("sources").delete().eq("id", source.id).eq("status", "pending");
      throw e;
    }
  });

  /** Google Drive (Picker + drive.file): token stored encrypted for ≤55 min, one job per file. */
  r.post("/brands/:brandId/sources/drive", can("knowledge.create"), async (c) => {
    const key = idempotencyKey(c);
    const input = await body(c, DriveImportSchema);
    const brandId = await loadBrand(c);
    const ws = c.get("workspaceId");
    if (!deps.encryptionKey) throw new AppError("internal", "Drive import is not configured (ENCRYPTION_KEY).");
    const secret = check(await deps.serviceDb().from("ephemeral_secrets").insert({
      workspace_id: ws, purpose: "drive_import", ciphertext: encryptSecret(input.accessToken, `${ws}:drive`, deps.encryptionKey), expires_at: new Date(Date.now() + 55 * 60_000).toISOString(),
    }).select("id").single());

    const results = [];
    for (const f of input.files) {
      const fileKey = `${key}:${f.id}`;
      const prior = await deps.serviceDb().from("generation_jobs").select("id, kind, status, source_id").eq("workspace_id", ws).eq("idempotency_key", fileKey).maybeSingle();
      if (prior.data) {
        results.push({ file: f.id, source: { id: prior.data.source_id }, job: prior.data });
        continue;
      }
      const source = check(await c.get("db").from("sources").insert({
        workspace_id: ws, brand_id: brandId, type: "drive", status: "pending", title: f.name, tags: input.tags, visibility: input.visibility, owner_id: actor(c),
        metadata: { drive_file_id: f.id, secret_id: secret.id },
      }).select("id, type, title, status").single());
      try {
        const res = await startIngest(c, fileKey, brandId, source.id, "drive", sourceCost({ type: "drive" }));
        results.push({ file: f.id, source, job: res.job });
      } catch (e) {
        await deps.serviceDb().from("sources").delete().eq("id", source.id).eq("status", "pending");
        results.push({ file: f.id, error: e instanceof AppError ? { code: e.code, message: e.message } : { code: "internal", message: "Could not start import" } });
      }
    }
    return c.json({ data: results }, 202);
  });

  // ---- update / refresh / delete -----------------------------------------
  r.patch("/brands/:brandId/sources/:sourceId", can("knowledge.update"), async (c) => {
    const input = await body(c, UpdateSourceSchema);
    await loadBrand(c);
    const s = await loadSource(c, "id, owner_id, visibility");
    if (input.visibility && input.visibility !== s.visibility && s.owner_id !== actor(c) && !["owner", "admin"].includes(c.get("role"))) {
      throw new AppError("forbidden", "Only the source's owner or an admin can change who sees it.");
    }
    const row = check(await c.get("db").from("sources").update({
      title: input.title, tags: input.tags, visibility: input.visibility,
      ...(input.refreshDays !== undefined && { refresh_interval: input.refreshDays ? `${input.refreshDays} days` : null }),
    }).eq("id", s.id as string).eq("workspace_id", c.get("workspaceId")).select(LIST_COLUMNS).single());
    return c.json(row);
  });

  r.post("/brands/:brandId/sources/:sourceId/refresh", can("knowledge.update"), async (c) => {
    const key = idempotencyKey(c);
    const brandId = await loadBrand(c);
    const s = await loadSource(c, "id, type, status, parent_source_id, crawl_options, media_asset_id, body, byte_size, duration_ms");
    if (s.type === "drive") throw new AppError("conflict", "Pick the file in Google Drive again to refresh it.");
    if (s.status === "processing" || s.status === "pending") throw new AppError("conflict", "This source is already being processed.");
    if (s.parent_source_id) throw new AppError("validation_failed", "Refresh the crawl instead of a single crawled page.");
    const kind = s.type as SourceKind;
    const cost =
      kind === "crawl" ? sourceCost({ type: "crawl", url: "https://x", limit: Number((s.crawl_options as { limit?: number })?.limit ?? 25), tags: [], visibility: "brand" })
      : kind === "media" ? sourceCost({ type: "media", mediaAssetId: randomUUID(), language: "auto", maxMinutes: Math.max(1, Math.ceil(Number(s.duration_ms ?? 3_600_000) / 60_000)), tags: [], visibility: "brand" })
      : kind === "url" ? sourceCost({ type: "url", url: "https://x", tags: [], visibility: "brand" })
      : kind === "file" ? sourceCost({ type: "drive" }, Number(s.byte_size ?? 0))
      : estimateCredits({ kind: "ingest.document_page", quantity: charsToPages(String(s.body ?? "").length) });
    const res = await startIngest(c, key, brandId, s.id as string, kind, cost, kind === "media" ? Math.ceil(Number(s.duration_ms ?? 3_600_000) / 60_000) : undefined);
    return c.json({ job: res.job, credits: res.credits }, 202);
  });

  r.delete("/brands/:brandId/sources/:sourceId", can("knowledge.delete"), async (c) => {
    await loadBrand(c);
    const s = await loadSource(c, "id, status");
    if (s.status === "processing") throw new AppError("conflict", "Wait for processing to finish, or cancel the job first.");
    ok(await c.get("db").from("sources").delete().eq("id", s.id as string).eq("workspace_id", c.get("workspaceId")));
    return c.body(null, 204);
  });

  // ---- search -------------------------------------------------------------
  r.post("/brands/:brandId/knowledge/search", can("knowledge.read"), async (c) => {
    const input = await body(c, SearchSchema);
    const brandId = await loadBrand(c);
    let embedding: string | null = null;
    let mode: "hybrid" | "keyword" = "keyword";
    if (deps.embedder) {
      try {
        embedding = toPgVector((await deps.embedder.embed([input.query], "query"))[0]!);
        mode = "hybrid";
      } catch {
        mode = "keyword";
      }
    }
    let rows = check(await c.get("db").rpc("search_knowledge", {
      p_brand: brandId, p_query: input.query, p_embedding: embedding, p_model: embedding ? deps.embedder!.model : null,
      p_limit: input.limit, p_source_types: input.sourceTypes ?? null, p_tags: input.tags ?? null,
    })) as Array<Record<string, unknown>>;
    if (c.get("principal").kind === "api_key" && rows.length) {
      const pub = check(await c.get("db").from("sources").select("id").in("id", [...new Set(rows.map((x) => x.source_id as string))]).eq("visibility", "brand"));
      const ok = new Set((pub as Array<{ id: string }>).map((x) => x.id));
      rows = rows.filter((x) => ok.has(x.source_id as string));
    }
    return c.json({ mode, data: rows });
  });

  return r;
};
