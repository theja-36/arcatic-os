import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AppError, CreateApiKeySchema, CreateBrandSchema, EstimateSchema, InviteSchema, PaginationSchema,
  UpdateBrandSchema, UpdateMemberSchema, UpdateWorkspaceSchema, UploadUrlSchema,
  assertWithinLimit, canAssignRole, estimateCredits, type PlanLimits,
} from "@arcatic/core";
import { Hono } from "hono";
import { body, check, ok, parse } from "../http.js";
import { requirePermission as can, workspaceContext } from "../middleware/workspace.js";
import type { ApiDeps, AppEnv } from "../types.js";
import { brandKitRoutes } from "./brand-kit.js";
import { jobRoutes } from "./jobs.js";
import { knowledgeRoutes } from "./knowledge.js";
import { mediaRoutes } from "./media.js";
import { campaignRoutes } from "./campaigns.js";
import { strategyRoutes } from "./strategy.js";
import { contentRoutes } from "./content.js";
import { videoRoutes } from "./video.js";
import { publishingRoutes } from "./publishing.js";
import { analyticsRoutes } from "./analytics.js";
import { growthRoutes } from "./growth.js";
import { seoRoutes } from "./seo.js";
import { adsRoutes } from "./ads.js";
import { serviceRoutes } from "./services.js";
import { mobileRoutes } from "./mobile.js";
import { billingRoutes } from "./billing.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const workspaceRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  r.use("/:workspaceId/*", workspaceContext(deps));
  r.use("/:workspaceId", workspaceContext(deps));

  const actorId = (c: { get: (k: "principal") => AppEnv["Variables"]["principal"] }) => {
    const p = c.get("principal");
    return p.kind === "user" ? p.userId : null;
  };

  async function planLimits(ws: string): Promise<PlanLimits> {
    const sub = check(await deps.serviceDb().from("subscriptions").select("plan:plans!subscriptions_plan_key_fkey(limits)").eq("workspace_id", ws).single()) as unknown as {
      plan: { limits: PlanLimits } | null;
    };
    return sub.plan?.limits ?? {};
  }

  // ---- workspace ----------------------------------------------------------
  r.get("/:workspaceId", can("workspace.read"), async (c) => {
    const ws = check(await c.get("db").from("workspaces").select("*").eq("id", c.get("workspaceId")).single());
    return c.json({ ...ws, role: c.get("role") });
  });

  r.patch("/:workspaceId", can("workspace.update"), async (c) => {
    const input = await body(c, UpdateWorkspaceSchema);
    const ws = check(
      await c.get("db").from("workspaces")
        .update({ name: input.name, default_language: input.defaultLanguage, settings: input.settings })
        .eq("id", c.get("workspaceId")).select("*").single(),
    );
    return c.json(ws);
  });

  // ---- members & invites --------------------------------------------------
  r.get("/:workspaceId/members", can("member.read"), async (c) => {
    const rows = check(
      await c.get("db").from("workspace_members")
        .select("user_id, role, status, brand_restricted, created_at, user:users(email, full_name, avatar_url)")
        .eq("workspace_id", c.get("workspaceId")).order("created_at"),
    );
    return c.json({ data: rows });
  });

  r.post("/:workspaceId/invites", can("member.invite"), async (c) => {
    const input = await body(c, InviteSchema);
    if (!canAssignRole(c.get("role"), input.role)) throw new AppError("forbidden", "You cannot invite above your own role.");
    const ws = c.get("workspaceId");
    const limits = await planLimits(ws);
    const { count } = await deps.serviceDb().from("workspace_members").select("user_id", { count: "exact", head: true }).eq("workspace_id", ws);
    assertWithinLimit(limits, "max_seats", count ?? 0);

    const token = randomBytes(32).toString("base64url");
    const invite = check(
      await deps.serviceDb().from("workspace_invites")
        .insert({ workspace_id: ws, email: input.email, role: input.role, brand_ids: input.brandIds ?? null, token_hash: sha256(token), invited_by: actorId(c) })
        .select("id, email, role, expires_at").single(),
    );
    // Email delivery is wired with the notification service; until then the inviter shares the link.
    return c.json({ ...invite, token }, 201);
  });

  r.patch("/:workspaceId/members/:userId", can("member.update"), async (c) => {
    const input = await body(c, UpdateMemberSchema);
    if (input.role && !canAssignRole(c.get("role"), input.role)) throw new AppError("forbidden", "You cannot grant a role above your own.");
    const row = check(
      await c.get("db").from("workspace_members")
        .update({ role: input.role, status: input.status, brand_restricted: input.brandRestricted })
        .eq("workspace_id", c.get("workspaceId")).eq("user_id", c.req.param("userId"))
        .select("user_id, role, status, brand_restricted").single(),
    );
    return c.json(row);
  });

  r.delete("/:workspaceId/members/:userId", async (c, next) => {
    // members may always leave; removing others needs member.remove
    if (actorId(c) === c.req.param("userId")) return next();
    return can("member.remove")(c, next);
  }, async (c) => {
    ok(await c.get("db").from("workspace_members").delete().eq("workspace_id", c.get("workspaceId")).eq("user_id", c.req.param("userId")));
    return c.body(null, 204);
  });

  // ---- brands -------------------------------------------------------------
  r.get("/:workspaceId/brands", can("brand.read"), async (c) => {
    const rows = check(
      await c.get("db").from("brands").select("id, name, website_url, industry, languages, status, logo_asset_id, active_kit_version_id, kit_completeness, created_at")
        .eq("workspace_id", c.get("workspaceId")).is("deleted_at", null).order("created_at"),
    );
    return c.json({ data: rows });
  });

  r.post("/:workspaceId/brands", can("brand.create"), async (c) => {
    const input = await body(c, CreateBrandSchema);
    const ws = c.get("workspaceId");
    const { count } = await deps.serviceDb().from("brands").select("id", { count: "exact", head: true }).eq("workspace_id", ws).is("deleted_at", null);
    assertWithinLimit(await planLimits(ws), "max_brands", count ?? 0);
    const brand = check(
      await c.get("db").from("brands")
        .insert({ workspace_id: ws, name: input.name, website_url: input.websiteUrl, industry: input.industry, languages: input.languages, created_by: actorId(c) })
        .select("*").single(),
    );
    return c.json(brand, 201);
  });

  r.get("/:workspaceId/brands/:brandId", can("brand.read"), async (c) => {
    const brand = check(await c.get("db").from("brands").select("*").eq("workspace_id", c.get("workspaceId")).eq("id", c.req.param("brandId")).is("deleted_at", null).single());
    return c.json(brand);
  });

  r.patch("/:workspaceId/brands/:brandId", can("brand.update"), async (c) => {
    const input = await body(c, UpdateBrandSchema);
    const brand = check(
      await c.get("db").from("brands")
        .update({ name: input.name, website_url: input.websiteUrl, industry: input.industry, languages: input.languages, status: input.status })
        .eq("workspace_id", c.get("workspaceId")).eq("id", c.req.param("brandId")).select("*").single(),
    );
    return c.json(brand);
  });

  r.delete("/:workspaceId/brands/:brandId", can("brand.delete"), async (c) => {
    // soft delete; purge job removes data after the retention window
    ok(await deps.serviceDb().from("brands").update({ deleted_at: new Date().toISOString(), status: "archived" })
      .eq("workspace_id", c.get("workspaceId")).eq("id", c.req.param("brandId")));
    return c.body(null, 204);
  });

  // ---- API keys -----------------------------------------------------------
  r.get("/:workspaceId/api-keys", can("apikey.manage"), async (c) => {
    const rows = check(
      await deps.serviceDb().from("api_keys").select("id, name, prefix, role, scopes, last_used_at, expires_at, revoked_at, created_at")
        .eq("workspace_id", c.get("workspaceId")).order("created_at", { ascending: false }),
    );
    return c.json({ data: rows });
  });

  r.post("/:workspaceId/api-keys", can("apikey.manage"), async (c) => {
    const input = await body(c, CreateApiKeySchema);
    if (!canAssignRole(c.get("role"), input.role)) throw new AppError("forbidden", "Key role cannot exceed your own.");
    const id = randomUUID();
    const prefix = `ak_live_${id.slice(0, 8)}`;
    const key = `${prefix}.${randomBytes(32).toString("base64url")}`;
    const row = check(
      await deps.serviceDb().from("api_keys")
        .insert({ id, workspace_id: c.get("workspaceId"), name: input.name, prefix, secret_hash: sha256(key), role: input.role, scopes: input.scopes, expires_at: input.expiresAt, created_by: actorId(c) })
        .select("id, name, prefix, role, scopes, expires_at, created_at").single(),
    );
    return c.json({ ...row, key }, 201);  // shown exactly once
  });

  r.delete("/:workspaceId/api-keys/:keyId", can("apikey.manage"), async (c) => {
    ok(await deps.serviceDb().from("api_keys").update({ revoked_at: new Date().toISOString() })
      .eq("workspace_id", c.get("workspaceId")).eq("id", c.req.param("keyId")).is("revoked_at", null));
    return c.body(null, 204);
  });

  // ---- media --------------------------------------------------------------
  r.post("/:workspaceId/media/upload-url", can("media.create"), async (c) => {
    const input = await body(c, UploadUrlSchema);
    const ws = c.get("workspaceId");
    const id = randomUUID();
    const safeName = input.filename.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 120);
    const path = `${ws}/${input.brandId ?? "_"}/${id}/${safeName}`;
    const kind = input.mimeType.startsWith("image/") ? "image" : input.mimeType.startsWith("video/") ? "video" : input.mimeType.startsWith("audio/") ? "audio" : "document";
    check(
      await c.get("db").from("media_assets")
        .insert({ id, workspace_id: ws, brand_id: input.brandId ?? null, collection_id: input.collectionId ?? null, kind, status: "pending", storage_path: path, mime_type: input.mimeType, bytes: input.bytes, title: input.filename, created_by: actorId(c) })
        .select("id").single(),
    );
    const signed = check(await deps.serviceDb().storage.from("media").createSignedUploadUrl(path));
    return c.json({ assetId: id, path, uploadUrl: signed.signedUrl, token: signed.token }, 201);
  });

  // ---- credits ------------------------------------------------------------
  r.get("/:workspaceId/credits", can("billing.read"), async (c) => {
    const w = check(await c.get("db").from("credits").select("balance, held, updated_at").eq("workspace_id", c.get("workspaceId")).single());
    const balance = Number(w.balance);
    const held = Number(w.held);
    return c.json({ balance, held, available: balance - held, updatedAt: w.updated_at });
  });

  r.get("/:workspaceId/credits/transactions", can("billing.read"), async (c) => {
    const q = parse(PaginationSchema, c.req.query());
    let query = c.get("db").from("credit_transactions").select("id, delta, kind, reference, balance_after, created_at")
      .eq("workspace_id", c.get("workspaceId")).order("id", { ascending: false }).limit(q.limit + 1);
    if (q.cursor) query = query.lt("id", Number(q.cursor));
    const rows = check(await query);
    const page = rows.slice(0, q.limit);
    return c.json({ data: page, next_cursor: rows.length > q.limit ? String(page.at(-1)?.id) : null });
  });

  r.post("/:workspaceId/credits/estimate", can("content.create"), async (c) => {
    return c.json(estimateCredits(await body(c, EstimateSchema)));
  });

  // ---- audit --------------------------------------------------------------
  r.get("/:workspaceId/audit-logs", can("audit.read"), async (c) => {
    const q = parse(PaginationSchema, c.req.query());
    let query = c.get("db").from("audit_logs").select("id, actor_id, actor_type, action, entity_type, entity_id, created_at")
      .eq("workspace_id", c.get("workspaceId")).order("id", { ascending: false }).limit(q.limit + 1);
    if (q.cursor) query = query.lt("id", Number(q.cursor));
    const rows = check(await query);
    const page = rows.slice(0, q.limit);
    return c.json({ data: page, next_cursor: rows.length > q.limit ? String(page.at(-1)?.id) : null });
  });

  r.route("/:workspaceId", jobRoutes(deps));
  r.route("/:workspaceId", brandKitRoutes(deps));
  r.route("/:workspaceId", knowledgeRoutes(deps));
  r.route("/:workspaceId", mediaRoutes(deps));
  r.route("/:workspaceId", strategyRoutes(deps));
  r.route("/:workspaceId", campaignRoutes(deps));
  r.route("/:workspaceId", contentRoutes(deps));
  r.route("/:workspaceId", videoRoutes(deps));
  r.route("/:workspaceId", publishingRoutes(deps));
  r.route("/:workspaceId", analyticsRoutes(deps));
  r.route("/:workspaceId", growthRoutes(deps));
  r.route("/:workspaceId", seoRoutes(deps));
  r.route("/:workspaceId", adsRoutes(deps));
  r.route("/:workspaceId", serviceRoutes(deps));
  r.route("/:workspaceId", mobileRoutes(deps));
  r.route("/:workspaceId", billingRoutes(deps));
  return r;
};
