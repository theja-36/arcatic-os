import { AppError, CONTENT_TYPE_DEFS, contentCost, customerStage, roleCan, type ServiceStatus } from "@arcatic/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { body, check, parse } from "../http.js";
import type { ApiDeps, AppEnv } from "../types.js";

/**
 * Mobile-ready endpoints: few round trips, compact payloads, cursor pagination. The PWA uses them
 * today; a native app can use the same ones (bearer token auth, idempotency keys, stable error codes).
 */
const Range = z.object({
  from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
  brandId: z.uuid().optional(), cursor: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
});
const QUICK_TYPES = ["social_post", "caption", "x_thread", "email", "blog", "ad", "static_visual"] as const;

export const mobileRoutes = (_deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  const ws = (c: Context<AppEnv>) => c.get("workspaceId");

  /** Everything waiting on me, across brands I can see, in one call. */
  r.get("/inbox", async (c) => {
    const role = c.get("role");
    const db = c.get("db");
    const [approvals, deliveries, adRequests, brands] = await Promise.all([
      roleCan(role, "approval.read")
        ? db.from("approvals").select("id, brand_id, created_at, due_at, item:content_items(id, title, type, channel)").eq("workspace_id", ws(c)).eq("status", "pending").order("created_at").limit(100)
        : Promise.resolve({ data: [], error: null }),
      db.from("service_requests").select("id, brand_id, title, status, delivered_at, offering_key").eq("workspace_id", ws(c)).eq("status", "delivered").order("delivered_at").limit(50),
      roleCan(role, "ads.approve")
        ? db.from("ad_actions").select("id, action, summary, payload, created_at, campaign:ad_campaigns(id, name, brand_id, platform)").eq("workspace_id", ws(c)).eq("status", "pending").order("created_at").limit(50)
        : Promise.resolve({ data: [], error: null }),
      db.from("brands").select("id, name").eq("workspace_id", ws(c)).is("deleted_at", null).limit(200),
    ]);
    const names = new Map((check(brands) as Array<{ id: string; name: string }>).map((b) => [b.id, b.name]));
    const one = <T>(x: T | T[] | null) => (Array.isArray(x) ? x[0] ?? null : x);
    const items = [
      ...(check(approvals) as Array<{ id: string; brand_id: string; created_at: string; due_at: string | null; item: unknown }>).map((a) => {
        const it = one(a.item as { id: string; title: string | null; type: string; channel: string | null } | null);
        return { kind: "content_approval", id: a.id, brandId: a.brand_id, brandName: names.get(a.brand_id) ?? null, title: it?.title ?? "Untitled", subtitle: [it?.type?.replace(/_/g, " "), it?.channel].filter(Boolean).join(" · "), at: a.created_at, dueAt: a.due_at, canDecide: roleCan(role, "approval.decide"), ref: { contentItemId: it?.id ?? null } };
      }),
      ...(check(deliveries) as Array<{ id: string; brand_id: string; title: string; status: ServiceStatus; delivered_at: string }>).map((d) => ({
        kind: "service_delivery", id: d.id, brandId: d.brand_id, brandName: names.get(d.brand_id) ?? null, title: d.title, subtitle: customerStage(d.status), at: d.delivered_at, dueAt: null, canDecide: roleCan(role, "approval.decide"), ref: {},
      })),
      ...(check(adRequests) as Array<{ id: string; action: string; summary: string; payload: { confirm?: string }; created_at: string; campaign: unknown }>).map((a) => {
        const cp = one(a.campaign as { id: string; name: string; brand_id: string; platform: string } | null);
        return { kind: "ad_request", id: a.id, brandId: cp?.brand_id ?? null, brandName: cp ? names.get(cp.brand_id) ?? null : null, title: cp?.name ?? "Campaign", subtitle: a.summary, at: a.created_at, dueAt: null, canDecide: true, ref: { campaignId: cp?.id ?? null, confirm: a.payload.confirm ?? null } };
      }),
    ].filter((x) => !x.brandId || names.has(x.brandId))   // brand-restricted members: only their brands
      .sort((a, b) => a.at.localeCompare(b.at));
    return c.json({ data: items, counts: { contentApprovals: items.filter((x) => x.kind === "content_approval").length, serviceDeliveries: items.filter((x) => x.kind === "service_delivery").length, adRequests: items.filter((x) => x.kind === "ad_request").length } });
  });

  /** Scheduled posts across brands, oldest first, cursor = publish_at of the last row. */
  r.get("/agenda", async (c) => {
    const q = parse(Range, c.req.query());
    const from = q.cursor ?? q.from ?? new Date(Date.now() - 86_400_000).toISOString();
    const to = q.to ?? new Date(Date.now() + 14 * 86_400_000).toISOString();
    if (to <= from && !q.cursor) throw new AppError("validation_failed", "`to` must be after `from`.");
    let query = c.get("db").from("schedules").select("id, brand_id, content_item_id, publish_at, status, external_url, last_error, item:content_items(title, type), account:connected_accounts(display_name, channel)")
      .eq("workspace_id", ws(c)).neq("status", "cancelled").order("publish_at", { ascending: true }).limit(q.limit + 1);
    query = q.cursor ? query.gt("publish_at", q.cursor) : query.gte("publish_at", from);
    query = query.lt("publish_at", to);
    if (q.brandId) query = query.eq("brand_id", q.brandId);
    const rows = check(await query) as Array<{ publish_at: string }>;
    const page = rows.slice(0, q.limit);
    return c.json({ data: page, next_cursor: rows.length > q.limit ? page.at(-1)!.publish_at : null });
  });

  /** Recent publishing outcomes (published / failed / in flight), newest first. */
  r.get("/publishing/status", async (c) => {
    const q = parse(Range.extend({ status: z.enum(["published", "failed", "active", "missed"]).optional() }), c.req.query());
    let query = c.get("db").from("schedules").select("id, brand_id, content_item_id, publish_at, published_at, status, external_url, last_error, attempts, updated_at, item:content_items(title, type), account:connected_accounts(display_name, channel)")
      .eq("workspace_id", ws(c)).neq("status", "cancelled").order("updated_at", { ascending: false }).limit(q.limit + 1);
    if (q.status === "published") query = query.eq("status", "published");
    else if (q.status === "failed") query = query.in("status", ["failed", "missed"]);
    else if (q.status === "missed") query = query.eq("status", "missed");
    else if (q.status === "active") query = query.in("status", ["scheduled", "publishing"]);
    if (q.brandId) query = query.eq("brand_id", q.brandId);
    if (q.cursor) query = query.lt("updated_at", q.cursor);
    const rows = check(await query) as Array<{ updated_at: string; status: string }>;
    const page = rows.slice(0, q.limit);
    return c.json({ data: page, next_cursor: rows.length > q.limit ? page.at(-1)!.updated_at : null });
  });

  /** What "quick create" can offer this person: brands with an approved kit, short-form types and their price. */
  r.get("/quick-create/options", async (c) => {
    const brands = check(await c.get("db").from("brands").select("id, name, languages, active_kit_version_id").eq("workspace_id", ws(c)).is("deleted_at", null).order("name").limit(200)) as Array<{ id: string; name: string; languages: string[]; active_kit_version_id: string | null }>;
    return c.json({
      canCreate: roleCan(c.get("role"), "content.create"),
      brands: brands.map((b) => ({ id: b.id, name: b.name, languages: b.languages, ready: !!b.active_kit_version_id })),
      types: QUICK_TYPES.map((t) => {
        const def = CONTENT_TYPE_DEFS[t];
        return { type: t, label: def.label, channels: "channels" in def ? def.channels : [], defaultChannel: "defaultChannel" in def ? def.defaultChannel : null, cost: contentCost(t) };
      }),
    });
  });

  return r;
};

/** The caller's own notifications and push devices (not workspace-scoped). User tokens only. */
export const meRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  const me = (c: Context<AppEnv>) => {
    const p = c.get("principal");
    if (p.kind !== "user") throw new AppError("forbidden", "This endpoint requires a user session.");
    return p.userId;
  };

  r.get("/notifications", async (c) => {
    const uid = me(c);
    const q = parse(z.object({ cursor: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(100).default(30), unread: z.enum(["1", "0"]).optional() }), c.req.query());
    let query = c.get("db").from("notifications").select("id, workspace_id, kind, title, body, link, data, read_at, created_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(q.limit + 1);
    if (q.unread === "1") query = query.is("read_at", null);
    if (q.cursor) query = query.lt("created_at", q.cursor);
    const rows = check(await query) as Array<{ created_at: string }>;
    const page = rows.slice(0, q.limit);
    const unread = await c.get("db").from("notifications").select("id", { count: "exact", head: true }).eq("user_id", uid).is("read_at", null);
    return c.json({ data: page, next_cursor: rows.length > q.limit ? page.at(-1)!.created_at : null, unread: unread.count ?? 0 });
  });

  r.post("/notifications/read", async (c) => {
    const uid = me(c);
    const i = await body(c, z.object({ ids: z.array(z.uuid()).max(200).optional(), all: z.boolean().optional() }).refine((x) => x.all || x.ids?.length, "Give ids or all: true."));
    let q = deps.serviceDb().from("notifications").update({ read_at: new Date().toISOString() }).eq("user_id", uid).is("read_at", null);
    if (!i.all) q = q.in("id", i.ids!);
    const res = await q.select("id");
    if (res.error) throw new AppError("internal", "Couldn't update notifications.");
    return c.json({ updated: (res.data ?? []).length });
  });

  /** VAPID public key browsers need to subscribe; 404 when push isn't configured. */
  r.get("/push-key", async (c) => {
    me(c);
    if (!deps.push) throw new AppError("not_found", "Push notifications aren't configured.");
    return c.json({ publicKey: deps.push.publicKey });
  });

  /** Register a device for push (Web Push subscription now; FCM/APNs tokens later). */
  r.post("/devices", async (c) => {
    const uid = me(c);
    const i = await body(c, z.object({
      kind: z.enum(["webpush", "fcm", "apns"]), endpoint: z.string().min(10).max(2000), label: z.string().max(120).optional(),
      keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }).partial().default({}),
    }).refine((x) => x.kind !== "webpush" || (/^https:\/\//.test(x.endpoint) && x.keys.p256dh && x.keys.auth), "A Web Push subscription needs an https endpoint and its keys."));
    const row = check(await deps.serviceDb().from("user_devices").upsert({ user_id: uid, kind: i.kind, endpoint: i.endpoint, keys: i.keys, label: i.label ?? null, last_seen_at: new Date().toISOString() }, { onConflict: "user_id,endpoint" }).select("id, kind, label, created_at, last_seen_at").single());
    return c.json(row, 201);
  });

  r.delete("/devices/:deviceId", async (c) => {
    const uid = me(c);
    const res = await deps.serviceDb().from("user_devices").delete().eq("user_id", uid).eq("id", c.req.param("deviceId")).select("id");
    if (!(res.data ?? []).length) throw new AppError("not_found", "Device not found.");
    return c.body(null, 204);
  });

  return r;
};
