import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  AppError, FinalizeUploadSchema, IMAGE_KINDS, ImportImageUrlSchema, KNOWLEDGE_DOC_KINDS, PaginationSchema, UpdateMediaSchema,
  fromDbError, imageDimensions, sniffFile, type FileKind,
} from "@arcatic/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { body, check, idempotencyKey, ok, parse } from "../http.js";
import { startCostedJob } from "../job-start.js";
import { encryptSecret } from "@arcatic/database";
import { requirePermission as can } from "../middleware/workspace.js";
import { safeFetchBytes } from "../safe-fetch.js";
import type { ApiDeps, AppEnv } from "../types.js";

const MAX_IMAGE_IMPORT = 20 * 1024 * 1024;
const COLUMNS = "id, brand_id, collection_id, kind, status, mime_type, bytes, width, height, duration_ms, title, alt_text, tags, source, source_url, metadata, created_at";
const ListSchema = PaginationSchema.extend({
  brandId: z.uuid().optional(), kind: z.string().optional(), tag: z.string().optional(), q: z.string().max(100).optional(),
  collectionId: z.union([z.uuid(), z.literal("none")]).optional(), source: z.string().optional(),
});
const CollectionSchema = z.object({ name: z.string().trim().min(1).max(120), parentId: z.uuid().nullable().optional(), brandId: z.uuid().nullable().optional() });
const MoveSchema = z.object({ ids: z.array(z.uuid()).min(1).max(200), collectionId: z.uuid().nullable() });
const ReplaceSchema = z.object({ filename: z.string().min(1).max(200), mimeType: z.string().min(3).max(120), bytes: z.number().int().positive().max(500 * 1024 * 1024) });
const DriveMediaSchema = z.object({
  accessToken: z.string().min(20).max(4096), files: z.array(z.object({ id: z.string().regex(/^[\w-]{10,200}$/), name: z.string().max(300) })).min(1).max(20),
  brandId: z.uuid().optional(), collectionId: z.uuid().optional(),
});
const dns = async (h: string) => (await lookup(h, { all: true })).map((a) => a.address);

/** Sniffed file kind → media_assets.kind. SVG is refused (it can carry scripts). */
function assetKind(kind: FileKind): "image" | "video" | "audio" | "document" {
  if (kind === "svg") throw new AppError("validation_failed", "SVG files aren't accepted; upload a PNG, JPEG or WebP.");
  if (IMAGE_KINDS.has(kind)) return "image";
  if (kind === "video") return "video";
  if (kind === "audio") return "audio";
  if (KNOWLEDGE_DOC_KINDS.has(kind)) return "document";
  throw new AppError("validation_failed", "Unsupported file type.");
}

export const mediaRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  const resolve = deps.resolveHost ?? dns;
  const actor = (c: Context<AppEnv>) => {
    const p = c.get("principal");
    return p.kind === "user" ? p.userId : null;
  };
  const getAsset = async (c: Context<AppEnv>, id: string) =>
    check(await c.get("db").from("media_assets").select("id, brand_id, storage_path, status, kind, mime_type, title, bytes, metadata").eq("workspace_id", c.get("workspaceId")).eq("id", id).single());

  /** Video/audio need ffprobe (duration, size, audio, poster) — a free background job. */
  async function startProbe(c: Context<AppEnv>, assetId: string) {
    const ws = c.get("workspaceId");
    try {
      await startCostedJob(deps, c, { idempotencyKey: `probe:${assetId}:${Date.now()}`, kind: "media.probe", cost: { estimate: 0, max: 0 }, input: { assetId }, start: (s, a) => s.probeMedia({ ...a, workspaceId: ws, assetId }) });
    } catch {
      /* the asset stays "processing"; re-finalising retries */
    }
  }

  // ---- folders ----------------------------------------------------------------
  r.get("/media/collections", can("media.read"), async (c) => {
    const rows = check(await c.get("db").from("media_collections").select("id, name, parent_id, brand_id, created_at").eq("workspace_id", c.get("workspaceId")).order("name").limit(500));
    return c.json({ data: rows });
  });
  r.post("/media/collections", can("media.create"), async (c) => {
    const i = await body(c, CollectionSchema);
    const row = check(await c.get("db").from("media_collections").insert({ workspace_id: c.get("workspaceId"), name: i.name, parent_id: i.parentId ?? null, brand_id: i.brandId ?? null, created_by: actor(c) }).select("*").single());
    return c.json(row, 201);
  });
  r.patch("/media/collections/:collectionId", can("media.update"), async (c) => {
    const i = await body(c, CollectionSchema.partial());
    const row = check(await c.get("db").from("media_collections").update({ name: i.name, parent_id: i.parentId }).eq("workspace_id", c.get("workspaceId")).eq("id", c.req.param("collectionId")).select("*").single());
    return c.json(row);
  });
  r.delete("/media/collections/:collectionId", can("media.delete"), async (c) => {
    ok(await c.get("db").from("media_collections").delete().eq("workspace_id", c.get("workspaceId")).eq("id", c.req.param("collectionId")));
    return c.body(null, 204);   // files inside are kept (moved to "no folder")
  });
  r.post("/media/move", can("media.update"), async (c) => {
    const i = await body(c, MoveSchema);
    const rows = check(await c.get("db").from("media_assets").update({ collection_id: i.collectionId }).eq("workspace_id", c.get("workspaceId")).in("id", i.ids).select("id"));
    return c.json({ moved: (rows as unknown[]).length });
  });

  // ---- replace a file in place (same id → every reference keeps working) ----------
  r.post("/media/:assetId/replace", can("media.update"), async (c) => {
    const i = await body(c, ReplaceSchema);
    const asset = await getAsset(c, c.req.param("assetId"));
    const safe = i.filename.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 120);
    const path = `${c.get("workspaceId")}/${asset.brand_id ?? "_"}/${asset.id}/r${Date.now()}-${safe}`;
    const signed = check(await deps.serviceDb().storage.from("media").createSignedUploadUrl(path));
    return c.json({ path, uploadUrl: signed.signedUrl, token: signed.token }, 201);
  });
  r.post("/media/:assetId/replace/finalize", can("media.update"), async (c) => {
    const { path } = await body(c, z.object({ path: z.string().min(1).max(500) }));
    const asset = await getAsset(c, c.req.param("assetId"));
    if (!path.startsWith(`${c.get("workspaceId")}/`) || !path.includes(`/${asset.id}/`)) throw new AppError("validation_failed", "That upload doesn't belong to this file.");
    const svc = deps.serviceDb();
    const signed = check(await svc.storage.from("media").createSignedUrl(path, 60));
    const head = await (deps.fetchImpl ?? fetch)(signed.signedUrl, { headers: { range: "bytes=0-65535" } });
    if (!head.ok && head.status !== 206) throw new AppError("validation_failed", "The new upload wasn't found.");
    const bytes = new Uint8Array(await head.arrayBuffer());
    const s = sniffFile(bytes, path);
    const kind = assetKind(s.kind);
    if (kind !== asset.kind) {
      await svc.storage.from("media").remove([path]);
      throw new AppError("validation_failed", `Replace a ${asset.kind} with another ${asset.kind}.`);
    }
    const dims = kind === "image" ? imageDimensions(bytes) : undefined;
    const needsProbe = kind === "video" || kind === "audio";
    const row = check(await svc.from("media_assets").update({
      storage_path: path, mime_type: s.mime, width: dims?.width ?? null, height: dims?.height ?? null, status: needsProbe ? "processing" : "ready",
    }).eq("id", asset.id).eq("workspace_id", c.get("workspaceId")).select(COLUMNS).single());
    await svc.storage.from("media").remove([asset.storage_path as string]);
    if (needsProbe) await startProbe(c, asset.id);
    return c.json(row);
  });

  // ---- Google Drive → media (Picker, drive.file) ------------------------------------
  r.post("/media/import-drive", can("media.create"), async (c) => {
    const key = idempotencyKey(c);
    const i = await body(c, DriveMediaSchema);
    if (!deps.encryptionKey) throw new AppError("internal", "Drive import is not configured (ENCRYPTION_KEY).");
    const ws = c.get("workspaceId");
    const secret = check(await deps.serviceDb().from("ephemeral_secrets").insert({
      workspace_id: ws, purpose: "drive_media_import", ciphertext: encryptSecret(i.accessToken, `${ws}:drive`, deps.encryptionKey), expires_at: new Date(Date.now() + 55 * 60_000).toISOString(),
    }).select("id").single());
    const results = [];
    for (const f of i.files) {
      try {
        const res = await startCostedJob(deps, c, {
          idempotencyKey: `${key}:${f.id}`, kind: "media.import_drive", cost: { estimate: 0, max: 0 }, input: { fileId: f.id, name: f.name },
          start: (s, a) => s.importDriveMedia({ ...a, workspaceId: ws, brandId: i.brandId, secretId: secret.id as string, fileId: f.id, name: f.name, collectionId: i.collectionId, requestedBy: actor(c) ?? undefined }),
        });
        results.push({ file: f.id, job: res.job });
      } catch (e) {
        results.push({ file: f.id, error: e instanceof AppError ? { code: e.code, message: e.message } : { code: "internal", message: "could not start" } });
      }
    }
    return c.json({ data: results }, 202);
  });

  r.get("/media", can("media.read"), async (c) => {
    const q = parse(ListSchema, c.req.query());
    let query = c.get("db").from("media_assets").select(COLUMNS).eq("workspace_id", c.get("workspaceId")).neq("status", "deleted").order("created_at", { ascending: false }).limit(q.limit + 1);
    if (q.brandId) query = query.eq("brand_id", q.brandId);
    if (q.kind) query = query.eq("kind", q.kind);
    if (q.tag) query = query.contains("tags", [q.tag]);
    if (q.q) query = query.ilike("title", `%${q.q.replace(/[%_]/g, "")}%`);
    if (q.collectionId === "none") query = query.is("collection_id", null);
    else if (q.collectionId) query = query.eq("collection_id", q.collectionId);
    if (q.source) query = query.eq("source", q.source);
    if (q.cursor) query = query.lt("created_at", q.cursor);
    const rows = check(await query) as Array<{ created_at: string }>;
    const page = rows.slice(0, q.limit);
    return c.json({ data: page, next_cursor: rows.length > q.limit ? page.at(-1)?.created_at : null });
  });

  /** After the browser's signed upload: verify the bytes really are what was declared. */
  r.post("/media/finalize", can("media.create"), async (c) => {
    const { assetId } = await body(c, FinalizeUploadSchema);
    const asset = await getAsset(c, assetId);
    if (asset.status === "ready") return c.json(asset);
    const svc = deps.serviceDb();
    const signed = check(await svc.storage.from("media").createSignedUrl(asset.storage_path as string, 60));
    const head = await (deps.fetchImpl ?? fetch)(signed.signedUrl, { headers: { range: "bytes=0-65535" } });
    if (!head.ok && head.status !== 206) throw new AppError("validation_failed", "The upload wasn't found. Try uploading again.");
    const bytes = new Uint8Array(await head.arrayBuffer());
    let kind: ReturnType<typeof assetKind>;
    let mime: string;
    try {
      const s = sniffFile(bytes, String(asset.title ?? ""));
      kind = assetKind(s.kind);
      mime = s.mime;
    } catch (e) {
      await svc.storage.from("media").remove([asset.storage_path as string]);
      ok(await svc.from("media_assets").update({ status: "failed", metadata: { error: e instanceof Error ? e.message : "rejected" } }).eq("id", asset.id));
      throw e;
    }
    const dims = kind === "image" ? imageDimensions(bytes) : undefined;
    const needsProbe = kind === "video" || kind === "audio";
    const row = check(await svc.from("media_assets").update({ status: needsProbe ? "processing" : "ready", kind, mime_type: mime, width: dims?.width ?? null, height: dims?.height ?? null })
      .eq("id", asset.id).eq("workspace_id", c.get("workspaceId")).select(COLUMNS).single());
    if (needsProbe) await startProbe(c, asset.id as string);
    return c.json(row);
  });

  /** External image URL → validated, size-capped copy in our storage (never hot-linked). */
  r.post("/media/import-url", can("media.create"), async (c) => {
    const input = await body(c, ImportImageUrlSchema);
    const ws = c.get("workspaceId");
    if (input.brandId) check(await c.get("db").from("brands").select("id").eq("workspace_id", ws).eq("id", input.brandId).single());
    const fetched = await safeFetchBytes(input.url, { resolve, maxBytes: MAX_IMAGE_IMPORT, fetchImpl: deps.fetchImpl });
    const sniff = sniffFile(fetched.bytes, new URL(fetched.finalUrl).pathname);
    if (!IMAGE_KINDS.has(sniff.kind)) throw new AppError("validation_failed", sniff.kind === "svg" ? "SVG images aren't accepted." : "That URL isn't a PNG, JPEG, GIF or WebP image.");
    const dims = imageDimensions(fetched.bytes);
    const id = randomUUID();
    const ext = sniff.mime.split("/")[1]!.replace("jpeg", "jpg");
    const path = `${ws}/${input.brandId ?? "_"}/${id}/import.${ext}`;
    const up = await deps.serviceDb().storage.from("media").upload(path, fetched.bytes, { contentType: sniff.mime, upsert: false });
    if (up.error) throw new AppError("upstream_error", `Storage upload failed: ${up.error.message}`);
    const row = check(await c.get("db").from("media_assets").insert({
      id, workspace_id: ws, brand_id: input.brandId ?? null, kind: "image", status: "ready", storage_path: path, source: "url_import", source_url: fetched.finalUrl,
      mime_type: sniff.mime, bytes: fetched.bytes.byteLength, width: dims?.width ?? null, height: dims?.height ?? null,
      title: input.title ?? new URL(fetched.finalUrl).pathname.split("/").pop() ?? "image", tags: input.tags, created_by: actor(c),
    }).select(COLUMNS).single());
    return c.json(row, 201);
  });

  r.get("/media/:assetId/url", can("media.read"), async (c) => {
    const asset = await getAsset(c, c.req.param("assetId"));
    if (asset.status !== "ready") throw new AppError("conflict", "File isn't ready.");
    const poster = c.req.query("poster") === "1" ? (asset as { metadata?: { poster_path?: string } }).metadata?.poster_path : undefined;
    if (c.req.query("poster") === "1" && !poster) throw new AppError("not_found", "No poster frame for this file.");
    const signed = check(await deps.serviceDb().storage.from("media").createSignedUrl(poster ?? (asset.storage_path as string), 300, { download: c.req.query("download") === "1" }));
    return c.json({ url: signed.signedUrl, expiresIn: 300 });
  });

  r.patch("/media/:assetId", can("media.update"), async (c) => {
    const input = await body(c, UpdateMediaSchema.extend({ collectionId: z.uuid().nullable().optional() }));
    const row = check(await c.get("db").from("media_assets").update({ title: input.title, alt_text: input.altText, tags: input.tags, collection_id: input.collectionId })
      .eq("workspace_id", c.get("workspaceId")).eq("id", c.req.param("assetId")).select(COLUMNS).single());
    return c.json(row);
  });

  r.delete("/media/:assetId", can("media.delete"), async (c) => {
    const asset = await getAsset(c, c.req.param("assetId"));
    const used = await deps.serviceDb().from("sources").select("id", { count: "exact", head: true }).eq("media_asset_id", asset.id).in("status", ["pending", "processing"]);
    if (used.count) throw new AppError("conflict", "This file is being processed into the knowledge library.");
    await deps.serviceDb().storage.from("media").remove([asset.storage_path as string]);
    ok(await c.get("db").from("media_assets").delete().eq("workspace_id", c.get("workspaceId")).eq("id", asset.id));
    return c.body(null, 204);
  });

  return r;
};
