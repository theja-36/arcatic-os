import { ApplicationFailure } from "@temporalio/activity";
import { AppError, classifyFailure, fromDbError } from "@arcatic/core";
import type { Db } from "@arcatic/database";
import type { PostizClient } from "@arcatic/integrations";
import {
  buildTargetPayload, mauticFor, postizFor, utmFor, wordpressFor,
  type AccountForPublish, type ContentForPublish, type TargetPayload,
} from "./publishing.js";

export interface PublishDeps {
  db: Db;
  encryptionKey?: string;
  fetchImpl?: typeof fetch;
  resolve?: (h: string) => Promise<string[]>;
  /** test seam */
  postiz?: (workspaceId: string) => Promise<PostizClient>;
}

export interface ScheduleState { status: string; revision: number; publishAt: string; enabled: boolean }
export interface PublishOutcome { outcome: "published" | "submitted"; externalId: string; url?: string | null }
export interface PostizCheck { state: "QUEUE" | "PUBLISHED" | "ERROR" | "MISSING"; url?: string | null; error?: string | null }
export interface FinishInput {
  scheduleId: string;
  status: "published" | "failed";
  externalId?: string | null;
  url?: string | null;
  error?: { message: string; kind?: string } | null;
}

/** Turn an error into a Temporal failure the workflow can act on (reconnect / rejected / retry). */
function toFailure(e: unknown): never {
  if (e instanceof ApplicationFailure) throw e;
  const msg = e instanceof Error ? e.message : String(e);
  const details = e instanceof AppError ? (e.details as { status?: number; body?: string } | undefined) : undefined;
  const text = [msg, details?.body].filter(Boolean).join(" — ");
  if (e instanceof AppError && e.code === "validation_failed") throw ApplicationFailure.create({ type: "publish_rejected", message: msg, nonRetryable: true });
  const c = classifyFailure(text, details?.status);
  if (c.kind === "auth") throw ApplicationFailure.create({ type: "reconnect_needed", message: text.slice(0, 500), nonRetryable: true });
  if (c.kind === "content") throw ApplicationFailure.create({ type: "publish_rejected", message: text.slice(0, 500), nonRetryable: true });
  throw ApplicationFailure.create({ type: "upstream_error", message: text.slice(0, 500), nonRetryable: false });
}

export function createPublishActivities(deps: PublishDeps) {
  const { db } = deps;
  const one = async <T>(q: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>): Promise<T> => {
    const r = await q;
    if (r.error) throw fromDbError(r.error as never);
    return r.data as T;
  };
  const postiz = (ws: string) => (deps.postiz ? deps.postiz(ws) : postizFor(db, ws, { key: deps.encryptionKey, fetchImpl: deps.fetchImpl }));

  type Sched = {
    id: string; workspace_id: string; brand_id: string; content_item_id: string; connected_account_id: string; content_version_id: string | null; publish_at: string;
    status: string; revision: number; attempts: number; text_override: string | null; media_asset_ids: string[] | null; channel_settings: Record<string, unknown>;
    external_post_id: string | null;
  };
  async function load(scheduleId: string) {
    const s = await one<Sched>(db.from("schedules").select("*").eq("id", scheduleId).single());
    const account = await one<AccountForPublish>(db.from("connected_accounts").select("*").eq("id", s.connected_account_id).single());
    const item = await one<ContentForPublish["item"]>(db.from("content_items").select("id, type, title, workspace_id, brand_id").eq("id", s.content_item_id).single());
    const version = await one<ContentForPublish["version"]>(db.from("content_versions").select("id, body, media_asset_ids").eq("id", s.content_version_id!).single());
    return { s, account, item, version };
  }

  /** The publishing_jobs row for this claim (attempts is bumped by each claim). */
  async function jobFor(s: Sched, account: AccountForPublish, payload: TargetPayload) {
    const key = `schedule:${s.id}:${s.attempts}`;
    const found = await one<Array<{ id: string; external_post_id: string | null; external_ref: Record<string, unknown> }>>(
      db.from("publishing_jobs").select("id, external_post_id, external_ref").eq("workspace_id", s.workspace_id).eq("idempotency_key", key));
    if (found[0]) return found[0];
    return one<{ id: string; external_post_id: string | null; external_ref: Record<string, unknown> }>(db.from("publishing_jobs").insert({
      workspace_id: s.workspace_id, brand_id: s.brand_id, schedule_id: s.id, content_item_id: s.content_item_id, content_version_id: s.content_version_id,
      connected_account_id: account.id, provider: account.provider, status: "publishing", idempotency_key: key, attempts: 1,
      validation_report: { passed: payload.report.passed, issues: payload.report.issues },
    }).select("id, external_post_id, external_ref").single());
  }
  const setJob = (id: string, patch: Record<string, unknown>) => one(db.from("publishing_jobs").update(patch).eq("id", id));

  async function signed(path: string) {
    const r = await db.storage.from("media").createSignedUrl(path, 900);
    if (r.error) throw new AppError("upstream_error", `Could not sign ${path}`, { retryable: true });
    return r.data.signedUrl;
  }

  return {
    async loadScheduleState(scheduleId: string): Promise<ScheduleState | null> {
      const r = await db.from("schedules").select("status, revision, publish_at, enabled").eq("id", scheduleId).maybeSingle();
      if (r.error) throw fromDbError(r.error);
      const s = r.data as { status: string; revision: number; publish_at: string; enabled: boolean } | null;
      return s && { status: s.status, revision: s.revision, publishAt: s.publish_at, enabled: s.enabled };
    },

    async claimSchedule(a: { scheduleId: string; revision: number }): Promise<{ ok: boolean; reason?: string; message?: string }> {
      return one(db.rpc("claim_schedule", { p_schedule: a.scheduleId, p_revision: a.revision }));
    },

    async publishTarget(a: { scheduleId: string }): Promise<PublishOutcome> {
      try {
        const { s, account, item, version } = await load(a.scheduleId);
        const payload = await buildTargetPayload(db, { item, version }, account, { textOverride: s.text_override, mediaAssetIds: s.media_asset_ids, settings: s.channel_settings, utm: await utmFor(db, item, s.id) });
        if (!payload.report.passed) throw new AppError("validation_failed", payload.report.issues.filter((i) => i.severity === "error").map((i) => i.message).join(" "));
        const job = await jobFor(s, account, payload);

        if (account.transport === "postiz") {
          const client = await postiz(s.workspace_id);
          // never post twice: a post in this group (= our job id) from an earlier try is reused
          const from = new Date(Date.now() - 2 * 86_400_000).toISOString();
          const to = new Date(Date.now() + 2 * 86_400_000).toISOString();
          const prior = (await client.listPosts({ startDate: from, endDate: to })).posts.filter((p) => p.group === job.id);
          const live = prior.find((p) => p.state !== "ERROR");
          if (live) return { outcome: "submitted", externalId: live.id };
          for (const p of prior) await client.deletePost(p.id).catch(() => undefined);   // errored try: replace it

          const uploaded: Array<{ id: string; path: string }> = [];
          for (const m of payload.media) uploaded.push(await client.uploadFromUrl(await signed(m.storagePath)));
          const posts = payload.thread ?? [payload.text];
          const created = await client.createPost({
            type: "now", date: new Date().toISOString(), shortLink: false, tags: [],
            posts: [{
              integration: { id: account.external_id }, group: job.id,
              value: posts.map((content, i) => ({ content, image: i === 0 ? uploaded.map((u) => ({ id: u.id, path: u.path })) : [] })),
              settings: { __type: payload.identifier, ...payload.settings },
            }],
          });
          const postId = created[0]?.postId;
          if (!postId) throw new AppError("upstream_error", "Postiz didn't return a post id.", { retryable: true });
          await setJob(job.id, { external_post_id: postId, external_ref: { postizGroup: job.id }, status: "publishing" });
          return { outcome: "submitted", externalId: postId };
        }

        if (account.transport === "wordpress") {
          if (job.external_post_id) return { outcome: "published", externalId: job.external_post_id, url: (job.external_ref.url as string) ?? null };
          if (job.external_ref.started) throw new AppError("conflict", "An earlier try may have created the post; check the site before retrying (WordPress has no duplicate check).");
          const wp = await wordpressFor(db, account as never, { key: deps.encryptionKey, fetchImpl: deps.fetchImpl, resolve: deps.resolve });
          let featured = job.external_ref.mediaId as number | undefined;
          const image = payload.media.find((m) => m.kind === "image");
          if (image && !featured) {
            const f = await db.storage.from("media").download(image.storagePath);
            if (f.error) throw new AppError("upstream_error", "Could not read the featured image.", { retryable: true });
            featured = (await wp.uploadMedia(new Uint8Array(await f.data.arrayBuffer()), image.storagePath.split("/").pop()!, image.mimeType ?? "image/jpeg")).id;
            await setJob(job.id, { external_ref: { ...job.external_ref, mediaId: featured } });
          }
          await setJob(job.id, { external_ref: { ...job.external_ref, mediaId: featured, started: true } });
          const st = payload.settings as { title: string; status: string; categories?: number[]; tags?: number[] };
          const post = await wp.createPost({ title: st.title, content: payload.html ?? "", status: st.status, categories: st.categories, tags: st.tags, ...(featured && { featured_media: featured }) });
          await setJob(job.id, { external_post_id: String(post.id), external_url: post.link, external_ref: { mediaId: featured, url: post.link } });
          return { outcome: "published", externalId: String(post.id), url: post.link };
        }

        // mautic: create the segment email once, then send (Mautic only sends to contacts not yet sent to)
        const m = await mauticFor(db, s.workspace_id, { key: deps.encryptionKey, fetchImpl: deps.fetchImpl, resolve: deps.resolve });
        let emailId = job.external_ref.emailId as number | undefined;
        if (!emailId) {
          const st = payload.settings as { subject: string; preheader?: string; fromName?: string; fromAddress?: string };
          emailId = (await m.createSegmentEmail({
            name: `${item.title ?? "Arcatic email"} · ${s.id.slice(0, 8)}`, subject: st.subject, preheaderText: st.preheader, customHtml: payload.html ?? "", plainText: payload.text,
            segmentIds: [Number(account.external_id)], fromName: st.fromName, fromAddress: st.fromAddress,
          })).email.id;
          await setJob(job.id, { external_post_id: String(emailId), external_ref: { emailId } });
        }
        const sent = await m.send(emailId);
        await setJob(job.id, { external_ref: { emailId, sentCount: sent.sentCount } });
        return { outcome: "published", externalId: String(emailId) };
      } catch (e) {
        toFailure(e);
      }
    },

    async checkPostiz(a: { scheduleId: string; postId: string }): Promise<PostizCheck> {
      try {
        const s = await one<{ workspace_id: string; publish_at: string }>(db.from("schedules").select("workspace_id, publish_at").eq("id", a.scheduleId).single());
        const client = await postiz(s.workspace_id);
        const from = new Date(Date.now() - 3 * 86_400_000).toISOString();
        const to = new Date(Date.now() + 2 * 86_400_000).toISOString();
        const p = (await client.listPosts({ startDate: from, endDate: to })).posts.find((x) => x.id === a.postId);
        if (!p) return { state: "MISSING" };
        return { state: p.state === "DRAFT" ? "QUEUE" : p.state, url: p.releaseURL, error: p.error };
      } catch (e) {
        toFailure(e);
      }
    },

    async finishTarget(f: FinishInput): Promise<void> {
      const s = await one<Sched>(db.from("schedules").select("*").eq("id", f.scheduleId).single());
      const now = new Date().toISOString();
      const reconnect = f.error?.kind === "reconnect_needed";
      await one(db.from("schedules").update(f.status === "published"
        ? { status: "published", external_post_id: f.externalId ?? null, external_url: f.url ?? null, published_at: now, last_error: null }
        : { status: "failed", last_error: { code: f.error?.kind ?? "failed", message: f.error?.message ?? "Publishing failed." } }).eq("id", s.id));
      await one(db.from("publishing_jobs").update(f.status === "published"
        ? { status: "published", external_post_id: f.externalId ?? null, external_url: f.url ?? null, published_at: now, error: null }
        : { status: "failed", error: { code: f.error?.kind ?? "failed", message: f.error?.message ?? "Publishing failed." } })
        .eq("workspace_id", s.workspace_id).eq("idempotency_key", `schedule:${s.id}:${s.attempts}`));
      if (f.status === "published") {
        await one(db.from("content_items").update({ status: "published" }).eq("id", s.content_item_id).eq("status", "approved"));
        await one(db.from("connected_accounts").update({ last_error: null }).eq("id", s.connected_account_id));
      } else if (reconnect) {
        await one(db.from("connected_accounts").update({ status: "refresh_needed", last_error: f.error?.message ?? null }).eq("id", s.connected_account_id));
      }
    },
  };
}

export type PublishActivities = ReturnType<typeof createPublishActivities>;
