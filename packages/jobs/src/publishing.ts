import { lookup } from "node:dns/promises";
import {
  AppError, CHANNEL_RULES, assertSafeUrl, blogParts, channelForIdentifier, emailParts, fromDbError, postText, utmCampaign, validateTarget, withUtm,
  type ContentDoc, type MediaFacts, type PublishChannel, type TargetReport,
} from "@arcatic/core";
import { decryptSecret, encryptSecret, type Db } from "@arcatic/database";
import { MauticClient, PostizClient, WordpressClient } from "@arcatic/integrations";

/**
 * Shared by apps/api (connect, validate, schedule) and the worker (publish).
 * Secrets: integration_secrets rows, AES-GCM envelope bound to `${workspaceId}:${purpose}`.
 */
export type SecretPurpose = "postiz_api_key" | "wordpress_app_password" | "mautic_password" | "matomo_token" | "google_ads_refresh_token" | "meta_access_token";

export const resolveDns = async (h: string) => (await lookup(h, { all: true })).map((a) => a.address);

export async function storeSecret(db: Db, a: { workspaceId: string; purpose: SecretPurpose; plaintext: string; actor?: string | null; key?: string }) {
  const r = await db.from("integration_secrets").insert({
    workspace_id: a.workspaceId, purpose: a.purpose, ciphertext: encryptSecret(a.plaintext, `${a.workspaceId}:${a.purpose}`, a.key), created_by: a.actor ?? null,
  }).select("id").single();
  if (r.error) throw fromDbError(r.error);
  return (r.data as { id: string }).id;
}

export async function readSecret(db: Db, a: { workspaceId: string; secretId: string | null; purpose: SecretPurpose; key?: string }): Promise<string> {
  if (!a.secretId) throw new AppError("conflict", "This connection has no saved credentials; reconnect it.");
  const r = await db.from("integration_secrets").select("ciphertext, purpose, workspace_id").eq("id", a.secretId).maybeSingle();
  if (r.error) throw fromDbError(r.error);
  const row = r.data as { ciphertext: string; purpose: string; workspace_id: string } | null;
  if (!row || row.workspace_id !== a.workspaceId || row.purpose !== a.purpose) throw new AppError("conflict", "Saved credentials are missing; reconnect it.");
  return decryptSecret(row.ciphertext, `${a.workspaceId}:${a.purpose}`, a.key);
}

type Connection = { id: string; base_url: string; username: string | null; secret_id: string | null; status: string };
async function connection(db: Db, workspaceId: string, provider: "postiz" | "mautic"): Promise<Connection> {
  const r = await db.from("publishing_connections").select("id, base_url, username, secret_id, status").eq("workspace_id", workspaceId).eq("provider", provider).maybeSingle();
  if (r.error) throw fromDbError(r.error);
  if (!r.data) throw new AppError("conflict", provider === "postiz" ? "Social publishing isn't set up for this workspace yet (Settings → Channels)." : "Mautic isn't connected (Settings → Channels).");
  return r.data as Connection;
}

export async function postizFor(db: Db, workspaceId: string, opts: { key?: string; fetchImpl?: typeof fetch } = {}) {
  const c = await connection(db, workspaceId, "postiz");
  const apiKey = await readSecret(db, { workspaceId, secretId: c.secret_id, purpose: "postiz_api_key", key: opts.key });
  return new PostizClient({ baseUrl: c.base_url, apiKey, fetchImpl: opts.fetchImpl });
}

export async function mauticFor(db: Db, workspaceId: string, opts: { key?: string; fetchImpl?: typeof fetch; resolve?: (h: string) => Promise<string[]> } = {}) {
  const c = await connection(db, workspaceId, "mautic");
  await assertSafeUrl(c.base_url, { resolve: opts.resolve ?? resolveDns, allowedSchemes: ["https:"] });
  const password = await readSecret(db, { workspaceId, secretId: c.secret_id, purpose: "mautic_password", key: opts.key });
  return new MauticClient({ baseUrl: c.base_url, username: c.username ?? "", password }, { fetchImpl: opts.fetchImpl });
}

export async function wordpressFor(db: Db, account: { workspace_id: string; secret_id: string | null; settings: { siteUrl?: string; username?: string } }, opts: { key?: string; fetchImpl?: typeof fetch; resolve?: (h: string) => Promise<string[]> } = {}) {
  const siteUrl = account.settings.siteUrl ?? "";
  await assertSafeUrl(siteUrl, { resolve: opts.resolve ?? resolveDns, allowedSchemes: ["https:"] });
  const appPassword = await readSecret(db, { workspaceId: account.workspace_id, secretId: account.secret_id, purpose: "wordpress_app_password", key: opts.key });
  return new WordpressClient({ siteUrl, username: account.settings.username ?? "", appPassword }, { fetchImpl: opts.fetchImpl });
}

// ------------------------------------------------------------------ accounts sync (Postiz → Arcatic)
export interface SyncResult { added: number; updated: number; disconnected: number; unsupported: string[]; overLimit: number }

/** Mirror the Postiz organisation's channels as connected accounts. Postiz keeps the platform tokens. */
export async function syncPostizAccounts(db: Db, workspaceId: string, client: PostizClient, maxAccounts?: number): Promise<SyncResult> {
  const list = await client.listIntegrations();
  const existing = await db.from("connected_accounts").select("id, provider, external_id, enabled, status").eq("workspace_id", workspaceId).eq("transport", "postiz");
  if (existing.error) throw fromDbError(existing.error);
  const rows = (existing.data ?? []) as Array<{ id: string; provider: string; external_id: string; enabled: boolean; status: string }>;
  const known = new Map(rows.map((r) => [`${r.provider}|${r.external_id}`, r]));
  const allEnabled = await db.from("connected_accounts").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("enabled", true);
  let enabledCount = allEnabled.count ?? 0;
  const res: SyncResult = { added: 0, updated: 0, disconnected: 0, unsupported: [], overLimit: 0 };
  const seen = new Set<string>();
  const now = new Date().toISOString();

  for (const i of list) {
    const channel = channelForIdentifier(i.identifier);
    if (!channel) { res.unsupported.push(i.identifier); continue; }
    const provider = `postiz:${i.identifier}`;
    const k = `${provider}|${i.id}`;
    seen.add(k);
    const fields = {
      display_name: i.name, avatar_url: (i.picture as string | undefined) ?? null, channel, transport: "postiz", last_synced_at: now,
      status: i.disabled ? "disconnected" : "active", settings: { identifier: i.identifier, profile: (i as { profile?: string }).profile ?? null },
    };
    const prior = known.get(k);
    if (prior) {
      const u = await db.from("connected_accounts").update(fields).eq("id", prior.id);
      if (u.error) throw fromDbError(u.error);
      res.updated++;
    } else {
      const over = maxAccounts !== undefined && enabledCount >= maxAccounts;
      const ins = await db.from("connected_accounts").insert({ workspace_id: workspaceId, provider, external_id: i.id, ...fields, enabled: !over });
      if (ins.error) throw fromDbError(ins.error);
      if (over) res.overLimit++; else enabledCount++;
      res.added++;
    }
  }
  for (const r of rows) {
    if (!seen.has(`${r.provider}|${r.external_id}`) && r.status !== "disconnected") {
      const u = await db.from("connected_accounts").update({ status: "disconnected", last_synced_at: now }).eq("id", r.id);
      if (u.error) throw fromDbError(u.error);
      res.disconnected++;
    }
  }
  return res;
}

// ------------------------------------------------------------------ payload for one target
export interface ContentForPublish {
  item: { id: string; type: string; title: string | null; workspace_id: string; brand_id: string };
  version: { id: string; body: { doc?: ContentDoc; images?: string[]; scene?: { exportAssetId?: string | null }; video?: { assetId: string } }; media_asset_ids: string[] | null };
}
export interface AccountForPublish {
  id: string; workspace_id: string; brand_id: string | null; channel: PublishChannel; transport: "postiz" | "wordpress" | "mautic"; provider: string; external_id: string;
  display_name: string | null; status: string; enabled: boolean; min_role: string; secret_id: string | null; settings: Record<string, unknown>;
}
export interface TargetPayload {
  channel: PublishChannel;
  identifier: string;            // Postiz provider identifier (settings __type)
  text: string;
  thread?: string[];
  title?: string;
  html?: string;
  media: Array<MediaFacts & { storagePath: string; mimeType: string | null }>;
  settings: Record<string, unknown>;
  report: TargetReport;
}

/** Media of a version, video first: rendered video, exported visual, generated images, attachments. */
export function contentMediaIds(version: ContentForPublish["version"]): string[] {
  const b = version.body ?? {};
  return [...new Set([b.video?.assetId, b.scene?.exportAssetId, ...(b.images ?? []), ...(version.media_asset_ids ?? [])].filter((x): x is string => !!x))];
}

export async function mediaFacts(db: Db, workspaceId: string, ids: string[]): Promise<TargetPayload["media"]> {
  if (!ids.length) return [];
  const r = await db.from("media_assets").select("id, kind, status, storage_path, mime_type, width, height, duration_ms").eq("workspace_id", workspaceId).in("id", ids);
  if (r.error) throw fromDbError(r.error);
  const byId = new Map(((r.data ?? []) as Array<{ id: string; kind: string; status: string; storage_path: string; mime_type: string | null; width: number | null; height: number | null; duration_ms: number | null }>).map((a) => [a.id, a]));
  return ids.map((id) => {
    const a = byId.get(id);
    if (!a || a.status !== "ready") throw new AppError("validation_failed", "A file in this post is missing or still processing.");
    if (a.kind !== "image" && a.kind !== "video") throw new AppError("validation_failed", "Only images and videos can be attached to posts.");
    const ext = (a.storage_path.split("/").pop() ?? "").split(".").pop()?.toLowerCase() ?? "";
    return { assetId: a.id, kind: a.kind, ext, width: a.width, height: a.height, durationMs: a.duration_ms, storagePath: a.storage_path, mimeType: a.mime_type };
  });
}

/** Text, media and settings exactly as they will be published, plus the deterministic checks. */
/**
 * Links in posts and emails get utm tags (source = channel, campaign = the content's campaign
 * name as a slug, content = target id) so website analytics can attribute visits. WordPress
 * articles live on the brand's own site and aren't tagged.
 */
export async function utmFor(db: Db, item: { workspace_id: string; id: string }, ref: string): Promise<{ campaign: string; content: string }> {
  const r = await db.from("content_items").select("campaign:campaigns(name)").eq("workspace_id", item.workspace_id).eq("id", item.id).maybeSingle();
  if (r.error) throw fromDbError(r.error);
  return { campaign: utmCampaign((r.data as { campaign: { name: string } | null } | null)?.campaign?.name ?? null), content: ref.replace(/-/g, "").slice(0, 12) };
}

export async function buildTargetPayload(db: Db, c: ContentForPublish, account: Pick<AccountForPublish, "channel" | "settings" | "transport">, target: { textOverride?: string | null; mediaAssetIds?: string[] | null; settings?: Record<string, unknown>; utm?: { campaign: string; content: string } | null }): Promise<TargetPayload> {
  const doc = c.version.body?.doc ?? { format: 1 as const, blocks: [] };
  const channel = account.channel;
  const media = await mediaFacts(db, c.item.workspace_id, target.mediaAssetIds ?? contentMediaIds(c.version));
  const base = postText(c.item.type, doc);
  let text = target.textOverride ?? base.text;
  let thread = target.textOverride == null && base.thread && base.thread.length > 1 && (channel === "x" || channel === "threads") ? base.thread : undefined;
  const settings: Record<string, unknown> = { ...(target.settings ?? {}) };
  let html: string | undefined;
  if (channel === "wordpress") {
    const b = blogParts(doc);
    html = b.html;
    settings.title ??= b.title || c.item.title || undefined;
    text = "";
  } else if (channel === "email") {
    const e = emailParts(doc);
    html = e.html;
    settings.subject ??= e.subject || c.item.title || undefined;
    settings.preheader ??= e.preheader;
    text = e.plainText;
  } else if (channel === "youtube") {
    settings.title ??= (base.title ?? c.item.title ?? "").slice(0, 100) || undefined;
  }
  if (target.utm && channel !== "wordpress") {
    const p = { source: channel, medium: channel === "email" ? "email" : "social", campaign: target.utm.campaign, content: target.utm.content };
    text = withUtm(text, p);
    if (thread) thread = thread.map((t) => withUtm(t, p));
    if (html) html = withUtm(html, p);
  }
  const report = validateTarget({ channel, text, thread, media, settings, html });
  const identifier = String(account.settings.identifier ?? CHANNEL_RULES[channel].accountTypes[0]?.identifier ?? channel);
  return { channel, identifier, text, thread, title: base.title, html, media, settings: report.settings, report };
}
