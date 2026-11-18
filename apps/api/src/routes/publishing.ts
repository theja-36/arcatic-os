import { randomUUID } from "node:crypto";
import {
  AppError, CHANNEL_RULES, PUBLISH_CHANNELS, ROLE_RANK, assertSafeUrl, assertWithinLimit, buildCalendar, channelForIdentifier, channelsForContentType,
  fromDbError, isRole, type PlanLimits,
} from "@arcatic/core";
import { MauticClient, PostizClient, WordpressClient } from "@arcatic/integrations";
import {
  buildTargetPayload, mauticFor, postizFor, readSecret, storeSecret, syncPostizAccounts, utmFor,
  type AccountForPublish, type ContentForPublish,
} from "@arcatic/jobs/publishing";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { body, check, ok, parse } from "../http.js";
import { requirePermission as can } from "../middleware/workspace.js";
import type { ApiDeps, AppEnv } from "../types.js";

const ACCOUNT_COLS = "id, brand_id, provider, external_id, display_name, avatar_url, status, channel, transport, enabled, min_role, settings, last_synced_at, last_error, created_at";
const SCHEDULE_COLS = "id, group_id, content_item_id, connected_account_id, publish_at, timezone, status, enabled, text_override, media_asset_ids, channel_settings, validation_report, last_error, external_post_id, external_url, published_at, revision, attempts, created_at";

const TargetSchema = z.object({
  accountId: z.uuid(),
  text: z.string().max(100_000).nullable().optional(),
  mediaAssetIds: z.array(z.uuid()).max(20).nullable().optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
});
const PreviewSchema = z.object({ targets: z.array(TargetSchema).min(1).max(20) });
const ScheduleSchema = z.object({
  publishAt: z.union([z.literal("now"), z.iso.datetime({ offset: true })]),
  timezone: z.string().min(1).max(64).default("Asia/Kolkata"),
  targets: z.array(TargetSchema).min(1).max(20),
});
const PatchScheduleSchema = z.object({
  publishAt: z.union([z.literal("now"), z.iso.datetime({ offset: true })]).optional(),
  text: z.string().max(100_000).nullable().optional(),
  mediaAssetIds: z.array(z.uuid()).max(20).nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});
const RangeSchema = z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }), contentItemId: z.uuid().optional(), status: z.string().optional() });

type Item = ContentForPublish["item"] & { status: string; approved_version_id: string | null; current_version_id: string | null };
type Sched = { id: string; content_item_id: string; connected_account_id: string; publish_at: string; status: string; enabled: boolean; revision: number; text_override: string | null; media_asset_ids: string[] | null; channel_settings: Record<string, unknown> };

/** Like check(), but a missing row is null rather than a 404. */
function maybe<T>(res: { data: T; error: { message: string; code?: string } | null }): T | null {
  if (res.error) throw fromDbError(res.error);
  return res.data ?? null;
}

export const publishingRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  const svc = () => deps.serviceDb();
  const ws = (c: Context<AppEnv>) => c.get("workspaceId");
  const actor = (c: Context<AppEnv>) => {
    const p = c.get("principal");
    return p.kind === "user" ? p.userId : null;
  };
  const resolve = deps.resolveHost;

  async function planLimits(workspaceId: string): Promise<PlanLimits> {
    const sub = maybe(await svc().from("subscriptions").select("plan:plans!subscriptions_plan_key_fkey(limits)").eq("workspace_id", workspaceId).maybeSingle()) as unknown as { plan: { limits: PlanLimits } | null } | null;
    return sub?.plan?.limits ?? {};
  }
  async function enabledCount(workspaceId: string) {
    const { count, error } = await svc().from("connected_accounts").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("enabled", true);
    if (error) throw fromDbError(error);
    return count ?? 0;
  }
  async function postiz(c: Context<AppEnv>) {
    return postizFor(svc(), ws(c), { key: deps.encryptionKey, fetchImpl: deps.fetchImpl });
  }
  async function upsertConnection(c: Context<AppEnv>, provider: "postiz" | "mautic", row: { base_url: string; username?: string | null; secret_id: string }) {
    const prior = maybe(await svc().from("publishing_connections").select("id, secret_id").eq("workspace_id", ws(c)).eq("provider", provider).maybeSingle()) as { id: string; secret_id: string | null } | null;
    const fields = { ...row, status: "active", last_checked_at: new Date().toISOString(), last_error: null, connected_by: actor(c) };
    if (prior) {
      ok(await svc().from("publishing_connections").update(fields).eq("id", prior.id));
      if (prior.secret_id) ok(await svc().from("integration_secrets").delete().eq("id", prior.secret_id));
    } else {
      ok(await svc().from("publishing_connections").insert({ workspace_id: ws(c), provider, ...fields }));
    }
  }
  async function syncMautic(c: Context<AppEnv>, client: MauticClient) {
    const segs = await client.segments();
    const existing = check(await svc().from("connected_accounts").select("id, external_id").eq("workspace_id", ws(c)).eq("transport", "mautic")) as Array<{ id: string; external_id: string }>;
    const byId = new Map(existing.map((e) => [e.external_id, e.id]));
    const now = new Date().toISOString();
    for (const s of segs) {
      const fields = { display_name: s.name, channel: "email", transport: "mautic", status: s.isPublished === false ? "disconnected" : "active", last_synced_at: now, settings: { alias: s.alias ?? null } };
      const id = byId.get(String(s.id));
      if (id) ok(await svc().from("connected_accounts").update(fields).eq("id", id));
      else ok(await svc().from("connected_accounts").insert({ workspace_id: ws(c), provider: "mautic", external_id: String(s.id), ...fields, enabled: false }));
    }
    return segs.length;
  }

  // ---------------------------------------------------------------- workspace: back-ends
  r.get("/publishing/connections", can("channel.read"), async (c) => {
    const rows = check(await c.get("db").from("publishing_connections").select("provider, base_url, username, status, last_checked_at, last_error, updated_at").eq("workspace_id", ws(c)));
    return c.json({ data: rows, postizConfigured: !!deps.postizUrl, channels: PUBLISH_CHANNELS.map((k) => ({ key: k, label: CHANNEL_RULES[k].label, transport: CHANNEL_RULES[k].transport, accountTypes: CHANNEL_RULES[k].accountTypes })) });
  });

  /** One Postiz organisation per workspace: the admin pastes that organisation's public API key. */
  r.put("/publishing/connections/postiz", can("channel.manage"), async (c) => {
    const i = await body(c, z.object({ apiKey: z.string().trim().min(10).max(500) }));
    if (!deps.postizUrl) throw new AppError("conflict", "Social publishing isn't available on this installation (POSTIZ_URL is not set).");
    const client = new PostizClient({ baseUrl: deps.postizUrl, apiKey: i.apiKey, fetchImpl: deps.fetchImpl });
    try {
      await client.isConnected();
    } catch {
      throw new AppError("validation_failed", "Postiz didn't accept that API key.");
    }
    const secretId = await storeSecret(svc(), { workspaceId: ws(c), purpose: "postiz_api_key", plaintext: i.apiKey, actor: actor(c), key: deps.encryptionKey });
    await upsertConnection(c, "postiz", { base_url: deps.postizUrl, secret_id: secretId });
    const limits = await planLimits(ws(c));
    const sync = await syncPostizAccounts(svc(), ws(c), client, limits.max_connected_accounts);
    return c.json({ ok: true, sync });
  });

  r.put("/publishing/connections/mautic", can("channel.manage"), async (c) => {
    const i = await body(c, z.object({ baseUrl: z.url().max(500), username: z.string().trim().min(1).max(200), password: z.string().min(1).max(500) }));
    const url = await assertSafeUrl(i.baseUrl, { resolve: resolve ?? (async () => []), allowedSchemes: ["https:"] });
    const baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    const client = new MauticClient({ baseUrl, username: i.username, password: i.password }, { fetchImpl: deps.fetchImpl });
    try {
      await client.segments();
    } catch {
      throw new AppError("validation_failed", "Couldn't sign in to Mautic. Check the URL and user, and that API + HTTP basic auth are enabled in Mautic's configuration.");
    }
    const secretId = await storeSecret(svc(), { workspaceId: ws(c), purpose: "mautic_password", plaintext: i.password, actor: actor(c), key: deps.encryptionKey });
    await upsertConnection(c, "mautic", { base_url: baseUrl, username: i.username, secret_id: secretId });
    return c.json({ ok: true, segments: await syncMautic(c, client) });
  });

  r.delete("/publishing/connections/:provider", can("channel.manage"), async (c) => {
    const provider = c.req.param("provider");
    if (provider !== "postiz" && provider !== "mautic") throw new AppError("not_found", "Unknown connection.");
    const conn = maybe(await svc().from("publishing_connections").select("id, secret_id").eq("workspace_id", ws(c)).eq("provider", provider).maybeSingle()) as { id: string; secret_id: string | null } | null;
    if (!conn) return c.body(null, 204);
    ok(await svc().from("publishing_connections").update({ status: "disconnected", secret_id: null }).eq("id", conn.id));
    if (conn.secret_id) ok(await svc().from("integration_secrets").delete().eq("id", conn.secret_id));
    ok(await svc().from("connected_accounts").update({ status: "disconnected" }).eq("workspace_id", ws(c)).eq("transport", provider));
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------- workspace: accounts
  r.get("/connected-accounts", can("channel.read"), async (c) => {
    let q = c.get("db").from("connected_accounts").select(ACCOUNT_COLS).eq("workspace_id", ws(c)).not("channel", "is", null).order("channel").order("display_name");
    const brandId = c.req.query("brandId");
    if (brandId) q = q.or(`brand_id.is.null,brand_id.eq.${z.uuid().parse(brandId)}`);
    return c.json({ data: check(await q) });
  });

  r.post("/connected-accounts/sync", can("channel.manage"), async (c) => {
    const limits = await planLimits(ws(c));
    const postizConn = maybe(await svc().from("publishing_connections").select("status").eq("workspace_id", ws(c)).eq("provider", "postiz").maybeSingle()) as { status: string } | null;
    const mauticConn = maybe(await svc().from("publishing_connections").select("status").eq("workspace_id", ws(c)).eq("provider", "mautic").maybeSingle()) as { status: string } | null;
    const out: Record<string, unknown> = {};
    if (postizConn?.status === "active") out.postiz = await syncPostizAccounts(svc(), ws(c), await postiz(c), limits.max_connected_accounts);
    if (mauticConn?.status === "active") out.mautic = await syncMautic(c, await mauticFor(svc(), ws(c), { key: deps.encryptionKey, fetchImpl: deps.fetchImpl, resolve }));
    return c.json(out);
  });

  /** Postiz-hosted connect page → the platform's OAuth → back to Arcatic, which then syncs. */
  r.post("/connected-accounts/connect", can("channel.manage"), async (c) => {
    const i = await body(c, z.object({ identifier: z.string().min(1).max(60) }));
    const channel = channelForIdentifier(i.identifier);
    if (!channel) throw new AppError("validation_failed", "That platform isn't supported.");
    assertWithinLimit(await planLimits(ws(c)), "max_connected_accounts", await enabledCount(ws(c)));
    const redirect = `${(deps.appUrl ?? "").replace(/\/$/, "")}/w/${ws(c)}/settings/channels?connected=${encodeURIComponent(i.identifier)}`;
    const link = await (await postiz(c)).createConnectLink(i.identifier, redirect);
    return c.json({ url: link.url });
  });

  r.post("/connected-accounts/wordpress", can("channel.manage"), async (c) => {
    const i = await body(c, z.object({ siteUrl: z.url().max(500), username: z.string().trim().min(1).max(200), appPassword: z.string().trim().min(8).max(200), brandId: z.uuid().nullable().optional() }));
    const url = await assertSafeUrl(i.siteUrl, { resolve: resolve ?? (async () => []), allowedSchemes: ["https:"] });
    const siteUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    assertWithinLimit(await planLimits(ws(c)), "max_connected_accounts", await enabledCount(ws(c)));
    let me: { name: string };
    try {
      me = await new WordpressClient({ siteUrl, username: i.username, appPassword: i.appPassword }, { fetchImpl: deps.fetchImpl }).me();
    } catch {
      throw new AppError("validation_failed", "WordPress rejected the login. Use an Application Password (Users → Profile), and check that a security plugin isn't blocking the REST API.");
    }
    const secretId = await storeSecret(svc(), { workspaceId: ws(c), purpose: "wordpress_app_password", plaintext: i.appPassword, actor: actor(c), key: deps.encryptionKey });
    const row = check(await svc().from("connected_accounts").upsert({
      workspace_id: ws(c), brand_id: i.brandId ?? null, provider: "wordpress", external_id: siteUrl, display_name: `${url.host} (${me.name})`, channel: "wordpress", transport: "wordpress",
      status: "active", enabled: true, secret_id: secretId, settings: { siteUrl, username: i.username }, connected_by: actor(c), last_synced_at: new Date().toISOString(),
    }, { onConflict: "workspace_id,provider,external_id" }).select(ACCOUNT_COLS).single());
    return c.json(row, 201);
  });

  r.get("/connected-accounts/:accountId/wordpress-terms", can("channel.read"), async (c) => {
    const a = check(await svc().from("connected_accounts").select("workspace_id, secret_id, settings, transport").eq("workspace_id", ws(c)).eq("id", c.req.param("accountId")).single()) as { workspace_id: string; secret_id: string | null; settings: { siteUrl: string; username: string }; transport: string };
    if (a.transport !== "wordpress") throw new AppError("validation_failed", "Not a WordPress site.");
    await assertSafeUrl(a.settings.siteUrl, { resolve: resolve ?? (async () => []), allowedSchemes: ["https:"] });
    const password = await readSecret(svc(), { workspaceId: ws(c), secretId: a.secret_id, purpose: "wordpress_app_password", key: deps.encryptionKey });
    const wp = new WordpressClient({ siteUrl: a.settings.siteUrl, username: a.settings.username, appPassword: password }, { fetchImpl: deps.fetchImpl });
    const [categories, tags] = await Promise.all([wp.categories(), wp.tags()]);
    return c.json({ categories: categories.map((x) => ({ id: x.id, name: x.name })), tags: tags.map((x) => ({ id: x.id, name: x.name })) });
  });

  r.patch("/connected-accounts/:accountId", can("channel.manage"), async (c) => {
    const i = await body(c, z.object({ brandId: z.uuid().nullable().optional(), enabled: z.boolean().optional(), minRole: z.enum(["owner", "admin", "editor"]).optional() }));
    const a = check(await svc().from("connected_accounts").select("id, enabled").eq("workspace_id", ws(c)).eq("id", c.req.param("accountId")).single()) as { id: string; enabled: boolean };
    if (i.enabled && !a.enabled) assertWithinLimit(await planLimits(ws(c)), "max_connected_accounts", await enabledCount(ws(c)));
    if (i.brandId) check(await c.get("db").from("brands").select("id").eq("workspace_id", ws(c)).eq("id", i.brandId).single());
    const row = check(await svc().from("connected_accounts").update({ brand_id: i.brandId, enabled: i.enabled, min_role: i.minRole }).eq("id", a.id).select(ACCOUNT_COLS).single());
    return c.json(row);
  });

  /** Disconnect: keeps history (posts already published), cancels what's still scheduled. */
  r.delete("/connected-accounts/:accountId", can("channel.manage"), async (c) => {
    const a = check(await svc().from("connected_accounts").select("id, transport, external_id, secret_id").eq("workspace_id", ws(c)).eq("id", c.req.param("accountId")).single()) as { id: string; transport: string; external_id: string; secret_id: string | null };
    if (a.transport === "postiz" && c.req.query("removeFromPostiz") === "1") await (await postiz(c)).deleteIntegration(a.external_id);
    ok(await svc().from("schedules").update({ status: "cancelled" }).eq("connected_account_id", a.id).eq("status", "scheduled"));
    ok(await svc().from("connected_accounts").update({ status: "disconnected", enabled: false, secret_id: null }).eq("id", a.id));
    if (a.secret_id) ok(await svc().from("integration_secrets").delete().eq("id", a.secret_id));
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------- brand: publish
  async function loadItem(c: Context<AppEnv>): Promise<{ item: Item; version: ContentForPublish["version"] }> {
    const item = maybe(await c.get("db").from("content_items").select("id, type, title, workspace_id, brand_id, status, approved_version_id, current_version_id")
      .eq("workspace_id", ws(c)).eq("brand_id", c.req.param("brandId")!).eq("id", c.req.param("contentId")!).maybeSingle()) as Item | null;
    if (!item) throw new AppError("not_found", "Content not found.");
    return { item, version: await versionOf(item) };
  }
  /** What will be published: the approved version, or the current one while it awaits approval. */
  async function versionOf(item: Item): Promise<ContentForPublish["version"]> {
    const vid = item.current_version_id ?? item.approved_version_id;
    if (!vid) throw new AppError("conflict", "This content has no version yet.");
    return check(await svc().from("content_versions").select("id, body, media_asset_ids").eq("id", vid).single()) as ContentForPublish["version"];
  }
  async function accountsFor(c: Context<AppEnv>, ids: string[]) {
    const rows = check(await svc().from("connected_accounts").select("*").eq("workspace_id", ws(c)).in("id", ids)) as AccountForPublish[];
    const byId = new Map(rows.map((a) => [a.id, a]));
    const role = c.get("role");
    return ids.map((id) => {
      const a = byId.get(id);
      if (!a || (a.brand_id && a.brand_id !== c.req.param("brandId"))) throw new AppError("validation_failed", "One of the accounts isn't available to this brand.");
      if (!a.enabled || a.status !== "active") throw new AppError("validation_failed", `${a.display_name ?? "An account"} is ${!a.enabled ? "turned off" : a.status.replace("_", " ")}.`);
      if (isRole(role) && isRole(a.min_role) && ROLE_RANK[role] < ROLE_RANK[a.min_role]) throw new AppError("forbidden", `Only ${a.min_role}s and above can publish to ${a.display_name ?? "this account"}.`);
      return a;
    });
  }
  async function preview(c: Context<AppEnv>, item: Item, version: ContentForPublish["version"], targets: z.infer<typeof TargetSchema>[]) {
    const accounts = await accountsFor(c, targets.map((t) => t.accountId));
    const allowed = channelsForContentType(item.type);
    return Promise.all(targets.map(async (t, k) => {
      const a = accounts[k]!;
      if (!allowed.includes(a.channel)) throw new AppError("validation_failed", `${CHANNEL_RULES[a.channel].label} can't publish this kind of content.`);
      const p = await buildTargetPayload(svc(), { item, version }, a, { textOverride: t.text, mediaAssetIds: t.mediaAssetIds, settings: t.settings, utm: await utmFor(svc(), item, "post") });
      return { accountId: a.id, account: a.display_name, channel: a.channel, text: p.text, thread: p.thread, title: p.settings.title ?? p.title ?? null, media: p.media.map((m) => ({ assetId: m.assetId, kind: m.kind, ext: m.ext, width: m.width, height: m.height })), settings: p.settings, report: p.report };
    }));
  }
  const when = (v: string) => (v === "now" ? new Date() : new Date(v));
  function checkTime(d: Date) {
    if (d.getTime() < Date.now() - 60_000) throw new AppError("validation_failed", "That time has passed; pick a time in the future or publish now.");
    if (d.getTime() > Date.now() + 400 * 86_400_000) throw new AppError("validation_failed", "Schedule at most 400 days ahead.");
  }
  const approvalNote = (item: Item) => (item.status === "approved" || item.status === "published" ? null : "Not approved yet: it will only publish if it's approved before the scheduled time.");

  r.get("/brands/:brandId/content/:contentId/publish-options", can("publish.read"), async (c) => {
    const { item } = await loadItem(c);
    const channels = channelsForContentType(item.type);
    const accounts = check(await c.get("db").from("connected_accounts").select(ACCOUNT_COLS).eq("workspace_id", ws(c)).or(`brand_id.is.null,brand_id.eq.${c.req.param("brandId")}`).in("channel", channels.length ? channels : ["-"]));
    return c.json({ channels, accounts, approval: approvalNote(item), status: item.status });
  });

  r.post("/brands/:brandId/content/:contentId/publish/preview", can("publish.read"), async (c) => {
    const i = await body(c, PreviewSchema);
    const { item, version } = await loadItem(c);
    return c.json({ data: await preview(c, item, version, i.targets), approval: approvalNote(item) });
  });

  /** Crosspost: one group, one target per account. Validated now; approval is re-checked at publish time. */
  r.post("/brands/:brandId/content/:contentId/publish", can("publish.execute"), async (c) => {
    const i = await body(c, ScheduleSchema);
    const { item, version } = await loadItem(c);
    if (["archived", "generating", "failed"].includes(item.status)) throw new AppError("conflict", `Content is ${item.status}.`);
    if (new Set(i.targets.map((t) => t.accountId)).size !== i.targets.length) throw new AppError("validation_failed", "Each account can be picked once.");
    const at = when(i.publishAt);
    checkTime(at);
    const targets = await preview(c, item, version, i.targets);
    const failing = targets.filter((t) => !t.report.passed);
    if (failing.length) {
      throw new AppError("validation_failed", "Fix the highlighted targets before scheduling.", {
        details: failing.flatMap((t) => t.report.issues.filter((x) => x.severity === "error").map((x) => ({ path: `${t.accountId}${x.field ? `.${x.field}` : ""}`, message: `${t.account ?? CHANNEL_RULES[t.channel].label}: ${x.message}` }))),
      });
    }
    const group = randomUUID();
    const ins = await svc().from("schedules").insert(i.targets.map((t, k) => ({
      workspace_id: ws(c), brand_id: item.brand_id, content_item_id: item.id, connected_account_id: t.accountId, publish_at: at.toISOString(), timezone: i.timezone,
      group_id: group, content_version_id: version.id, text_override: t.text ?? null, media_asset_ids: t.mediaAssetIds ?? null, channel_settings: targets[k]!.settings,
      validation_report: { passed: true, issues: targets[k]!.report.issues }, created_by: actor(c),
    }))).select("id, revision");
    if (ins.error?.code === "23505") throw new AppError("conflict", "This content is already scheduled to one of those accounts.");
    if (ins.error) throw fromDbError(ins.error);
    const rows = ins.data as Array<{ id: string; revision: number }>;
    try {
      const jobs = await deps.jobs();
      for (const s of rows) await jobs.publishSchedule(s.id, s.revision);
    } catch (e) {
      ok(await svc().from("schedules").delete().in("id", rows.map((s) => s.id)));
      throw new AppError("upstream_error", "The scheduler is unavailable; nothing was scheduled.", { cause: e });
    }
    return c.json({ groupId: group, scheduleIds: rows.map((s) => s.id), approval: approvalNote(item), targets }, 201);
  });

  r.get("/brands/:brandId/schedules", can("publish.read"), async (c) => {
    const q = parse(RangeSchema.partial({ from: true, to: true }), c.req.query());
    let query = c.get("db").from("schedules").select(`${SCHEDULE_COLS}, account:connected_accounts(display_name, channel, avatar_url)`).eq("workspace_id", ws(c)).eq("brand_id", c.req.param("brandId")!).order("publish_at").limit(500);
    if (q.contentItemId) query = query.eq("content_item_id", q.contentItemId);
    if (q.from) query = query.gte("publish_at", q.from);
    if (q.to) query = query.lt("publish_at", q.to);
    if (q.status) query = query.eq("status", q.status);
    return c.json({ data: check(await query) });
  });

  r.get("/brands/:brandId/schedules/:scheduleId/attempts", can("publish.read"), async (c) => {
    return c.json({ data: check(await c.get("db").from("publishing_jobs").select("id, status, external_post_id, external_url, error, attempts, published_at, created_at").eq("workspace_id", ws(c)).eq("schedule_id", c.req.param("scheduleId")!).order("created_at", { ascending: false })) });
  });

  async function loadSchedule(c: Context<AppEnv>): Promise<Sched> {
    const s = maybe(await c.get("db").from("schedules").select(SCHEDULE_COLS).eq("workspace_id", ws(c)).eq("brand_id", c.req.param("brandId")!).eq("id", c.req.param("scheduleId")!).maybeSingle()) as Sched | null;
    if (!s) throw new AppError("not_found", "Scheduled post not found.");
    return s;
  }
  async function restart(c: Context<AppEnv>, s: Sched, patch: Record<string, unknown>) {
    const next = check(await svc().from("schedules").update({ ...patch, revision: s.revision + 1 }).eq("id", s.id).eq("revision", s.revision).select(SCHEDULE_COLS)) as Sched[];
    if (!next[0]) throw new AppError("conflict", "This post changed meanwhile; reload.");
    if (next[0].status === "scheduled" && next[0].enabled) await (await deps.jobs()).publishSchedule(s.id, next[0].revision);
    return next[0];
  }

  /** Edit / reschedule / toggle one target (not while it's publishing or after it published). */
  r.patch("/brands/:brandId/schedules/:scheduleId", can("publish.execute"), async (c) => {
    const i = await body(c, PatchScheduleSchema);
    const s = await loadSchedule(c);
    if (!["scheduled", "missed", "failed"].includes(s.status)) throw new AppError("conflict", `This post is ${s.status}.`);
    const item = await itemOf(c, s);
    const version = await versionOf(item);
    const at = i.publishAt ? when(i.publishAt) : new Date(s.publish_at);
    if (i.publishAt) checkTime(at);
    const target = { accountId: s.connected_account_id, text: i.text !== undefined ? i.text : s.text_override, mediaAssetIds: i.mediaAssetIds !== undefined ? i.mediaAssetIds : s.media_asset_ids, settings: i.settings ?? s.channel_settings };
    const [p] = await preview(c, item, version, [target]);
    if (!p!.report.passed) throw new AppError("validation_failed", "Fix the target before saving.", { details: p!.report.issues.filter((x) => x.severity === "error").map((x) => ({ path: x.field ?? "target", message: x.message })) });
    if (at.getTime() < Date.now() - 60_000) throw new AppError("validation_failed", "Pick a new time; this one has passed.");
    return c.json(await restart(c, s, {
      publish_at: at.toISOString(), text_override: target.text ?? null, media_asset_ids: target.mediaAssetIds ?? null, channel_settings: p!.settings,
      enabled: i.enabled ?? s.enabled, status: "scheduled", last_error: null, validation_report: { passed: true, issues: p!.report.issues },
    }));
  });
  async function itemOf(c: Context<AppEnv>, s: Sched): Promise<Item> {
    return check(await c.get("db").from("content_items").select("id, type, title, workspace_id, brand_id, status, approved_version_id, current_version_id").eq("id", s.content_item_id).single()) as Item;
  }

  r.post("/brands/:brandId/schedules/:scheduleId/cancel", can("publish.execute"), async (c) => {
    const s = await loadSchedule(c);
    if (s.status !== "scheduled" && s.status !== "missed" && s.status !== "failed") throw new AppError("conflict", `This post is ${s.status}.`);
    const row = check(await svc().from("schedules").update({ status: "cancelled", revision: s.revision + 1 }).eq("id", s.id).eq("revision", s.revision).select(SCHEDULE_COLS));
    return c.json((row as Sched[])[0] ?? null);
  });

  /** Try a failed or missed post again (now, or at its time if that's still ahead). Approval is checked again. */
  r.post("/brands/:brandId/schedules/:scheduleId/retry", can("publish.execute"), async (c) => {
    const s = await loadSchedule(c);
    if (s.status !== "failed" && s.status !== "missed") throw new AppError("conflict", `This post is ${s.status}.`);
    const at = Math.max(Date.now(), Date.parse(s.publish_at));
    return c.json(await restart(c, s, { status: "scheduled", publish_at: new Date(at).toISOString(), last_error: null, enabled: true }));
  });

  // ---------------------------------------------------------------- calendar
  r.get("/brands/:brandId/calendar", can("publish.read"), async (c) => {
    const q = parse(RangeSchema.pick({ from: true, to: true }), c.req.query());
    if (Date.parse(q.to) - Date.parse(q.from) > 100 * 86_400_000) throw new AppError("validation_failed", "Pick a range of at most 100 days.");
    const db = c.get("db");
    const brand = c.req.param("brandId")!;
    const [topics, items, schedules] = await Promise.all([
      db.from("campaign_topics").select("id, title, planned_for, status, channel, campaign_id, content_item_id").eq("workspace_id", ws(c)).eq("brand_id", brand).gte("planned_for", q.from.slice(0, 10)).lte("planned_for", q.to.slice(0, 10)).limit(1000),
      db.from("content_items").select("id, title, status, channel, type, updated_at, campaign_id").eq("workspace_id", ws(c)).eq("brand_id", brand).in("status", ["draft", "in_review", "changes_requested", "approved", "published"]).order("updated_at", { ascending: false }).limit(500),
      db.from("schedules").select("id, group_id, content_item_id, publish_at, status, external_url, last_error, account:connected_accounts(display_name, channel)").eq("workspace_id", ws(c)).eq("brand_id", brand).gte("publish_at", q.from).lt("publish_at", q.to).limit(1000),
    ]);
    const sched = check(schedules) as unknown as Parameters<typeof buildCalendar>[0]["schedules"];
    // performance: whatever metrics exist for these posts (filled by Phase 8 ingestion)
    const metrics: Record<string, { impressions: number; engagements: number; clicks: number }> = {};
    if (sched.length) {
      const jobs = check(await db.from("publishing_jobs").select("id, schedule_id").eq("workspace_id", ws(c)).in("schedule_id", sched.map((s) => s.id))) as Array<{ id: string; schedule_id: string }>;
      if (jobs.length) {
        const m = check(await db.from("performance_metrics").select("publishing_job_id, impressions, engagements, clicks").eq("workspace_id", ws(c)).in("publishing_job_id", jobs.map((j) => j.id))) as Array<{ publishing_job_id: string; impressions: number | null; engagements: number | null; clicks: number | null }>;
        const sOf = new Map(jobs.map((j) => [j.id, j.schedule_id]));
        for (const row of m) {
          const k = sOf.get(row.publishing_job_id)!;
          const t = (metrics[k] ??= { impressions: 0, engagements: 0, clicks: 0 });
          t.impressions += Number(row.impressions ?? 0); t.engagements += Number(row.engagements ?? 0); t.clicks += Number(row.clicks ?? 0);
        }
      }
    }
    return c.json(buildCalendar({
      topics: check(topics) as Parameters<typeof buildCalendar>[0]["topics"],
      items: check(items) as Parameters<typeof buildCalendar>[0]["items"],
      schedules: sched, metrics,
    }));
  });

  return r;
};

