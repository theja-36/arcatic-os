# 15 — Phase 7: Publishing & calendar

Approved content goes out to connected accounts at a chosen time, with one approval gate enforced in the database, per-platform checks before scheduling, retries for transient failures, and a calendar that shows plans, drafts, reviews, scheduled, published and failed posts together.

## 1. What each channel goes through (verified from source)

| Channel | Route | Account types | Text limit | Media rules enforced before scheduling | Source |
|---|---|---|---|---|---|
| Instagram | Postiz | `instagram` (via Facebook Page), `instagram-standalone` | 2,200 | ≥ 1 item, ≤ 20; trial Reel = one video | `instagram.provider.ts` |
| Facebook Page | Postiz | `facebook` | 63,206 | story needs media | `facebook.provider.ts` |
| LinkedIn | Postiz | `linkedin`, `linkedin-page` | 3,000 | video → only 1 item; carousel ≥ 2 images, no video | `linkedin.provider.ts` |
| X | Postiz | `x` | 280 (weighted) per post; threads from `x_thread` content | — | `x.provider.ts` |
| TikTok | Postiz | `tiktok`, `tiktok-business` | 2,000 | ≥ 1; one video or several photos; photos ≤ 1080 px short side | `tiktok.provider.ts` |
| YouTube | Postiz | `youtube` | 5,000 | exactly one MP4; title 1–100; tags ≤ 500 chars | `youtube.provider.ts`, `youtube.settings.dto.ts` |
| Threads | Postiz | `threads` | 500 | — | `threads.provider.ts` |
| Google Business Profile | **own adapter** (`gbp` channel) over Postiz `gmb` | `gmb` | 1,500 | ≤ 1 image, no video; event needs title; button needs link | `gmb.provider.ts`, `gmb.settings.dto.ts` |
| WordPress | **own direct REST adapter** | site + Application Password | — | title ≥ 2; featured image = first image | endpoints as used by `wordpress.provider.ts` |
| Email | **own Mautic adapter** | one target per Mautic segment | — | subject + body; `{unsubscribe_text}` added | `mautic-7.x` EmailBundle API |

Every Postiz media file must end in `.png/.jpg/.jpeg/.gif/.webp/.mp4` (lower-case, `valid.url.path.ts`) and be fetched over public HTTPS. Settings forms mirror Postiz's settings DTOs field for field (`core/publishing/channels.ts`). The TikTok limit in `CHANNEL_LIMITS` was corrected from 2,200 to 2,000 to match what Postiz enforces.

**Not verified (platform-side)**: daily post quotas, upload size caps, and API-review status per platform aren't in the Postiz source. They surface as publish failures with the platform's message. Postiz's own per-provider concurrency (`maxConcurrentJob`, e.g. LinkedIn Page 2, GBP 3) is recorded in the registry.

## 2. How a post goes out

```
Content (any status) ── POST …/publish {publishAt, targets[]} ──► schedules rows (one group_id per crosspost)
   validateTarget() per target (422 with per-target messages)          └─ Temporal publishScheduleWorkflow(schedule, revision)
                                                                          sleep until publish_at (re-reads row: reschedule/cancel honoured)
claim_schedule(id, revision)  ◄── SQL approval gate ──────────────────────┘
   approved AND current version = approved version AND account active+on → status publishing (pins approved version)
   otherwise → status missed ("approve it and reschedule")
publishTarget: Postiz (upload media from 15-min signed URL, POST /posts type "now", group = publishing_jobs.id)
             | WordPress (upload featured image, POST /wp-json/wp/v2/posts) | Mautic (create segment email, send)
Postiz posts: poll GET /posts every 10–30 s for the first minute, then every minute for 2 h, then every 10 min to 24 h
   PUBLISHED → schedule published (+ URL), content item → published
   ERROR → transient? re-post (≤ 3 tries) : failed; "re-authenticate"-type errors → account refresh_needed
```

- **Approval before publishing** is enforced by `claim_schedule` in Postgres, not just the UI: an edit after approval puts content back to draft (Phase 5 trigger) and the claim refuses it.
- **No double posts**: each claim gets one `publishing_jobs` row (`schedule:<id>:<attempt>`). Postiz posts carry that id as their group; a retry first looks for a live post in the group. WordPress creation is never retried automatically after a request may have reached the site (it has no duplicate check). The person retries after checking the site. Mautic only sends to contacts not yet sent to.
- **Retries**: network, 5xx and rate-limit errors are retried 30 s → 2 → 8 → 30 min. Rejected content and expired logins fail at once with the platform's message.
- **Reschedule / turn off / cancel / retry** bump the schedule's revision. Older workflows wake, see a newer revision and exit.

## 3. Accounts, permissions, back-ends

- **Postiz organisation per workspace**: an owner/admin pastes the organisation's public API key (checked with `GET /is-connected`, stored AES-GCM-encrypted in `integration_secrets`, which has no client access at all). Creating the organisation itself is still manual (docs/00 gap #1: Postiz has no public provisioning API).
- **Connect**: `POST /connected-accounts/connect` → Postiz-hosted connect page → platform OAuth → back to Settings → Channels, which syncs. Postiz keeps the platform tokens; Arcatic mirrors id, name, avatar, status.
- **Account permissions**: each account is workspace-wide or tied to one brand (DB trigger refuses cross-brand/cross-workspace targets). It has an on/off switch and a minimum role to publish (editor / admin / owner). The plan's `max_connected_accounts` counts accounts that are switched on. Accounts beyond the limit are synced but left off.
- **Disconnect** keeps history, cancels scheduled targets, deletes the stored secret, and can optionally remove the channel from Postiz.

## 4. API (all under `/v1/workspaces/:ws`)

| Method | Path | Permission |
|---|---|---|
| GET | `/publishing/connections` | channel.read |
| PUT / DELETE | `/publishing/connections/postiz` `{apiKey}`, `/publishing/connections/mautic` `{baseUrl, username, password}` | channel.manage |
| GET | `/connected-accounts[?brandId]` | channel.read |
| POST | `/connected-accounts/sync`, `/connected-accounts/connect {identifier}`, `/connected-accounts/wordpress {siteUrl, username, appPassword, brandId?}` | channel.manage |
| PATCH / DELETE | `/connected-accounts/:id` `{brandId, enabled, minRole}` / `?removeFromPostiz=1` | channel.manage |
| GET | `/connected-accounts/:id/wordpress-terms` | channel.read |
| GET | `/brands/:b/content/:c/publish-options` | publish.read |
| POST | `/brands/:b/content/:c/publish/preview {targets[]}` | publish.read |
| POST | `/brands/:b/content/:c/publish {publishAt: ISO\|"now", timezone, targets[{accountId, text?, mediaAssetIds?, settings}]}` | publish.execute |
| GET | `/brands/:b/schedules?contentItemId&from&to&status`, `/brands/:b/schedules/:id/attempts` | publish.read |
| PATCH | `/brands/:b/schedules/:id {publishAt?, text?, mediaAssetIds?, settings?, enabled?}` | publish.execute |
| POST | `/brands/:b/schedules/:id/cancel`, `/brands/:b/schedules/:id/retry` | publish.execute |
| GET | `/brands/:b/calendar?from&to` (≤ 100 days) | publish.read |

## 5. UI

- **Settings → Channels**: Postiz key, one connect button per account type, sync, account list (on/off, brand, who can publish, reconnect, disconnect), WordPress form, Mautic form (segments arrive switched off).
- **Content → Publish panel**: pick targets (toggle per account), per-channel settings, optional per-account text, **Check** (exact text/media/settings + issues), schedule or publish now (approved only). It also lists existing targets with live status, link, error, reschedule / turn off / retry / cancel. Video content has a **Short-video set** button (Instagram, TikTok, YouTube, Facebook accounts with defaults).
- **Calendar tab**: month grid of plans (campaign topics), drafts/reviews, and posts by state, with channel and kind filters, a "Not scheduled yet" list, and impressions where metrics exist (ingestion is Phase 8).

## 6. Verification

| Check | Result |
|---|---|
| core | 144 tests: channel registry, per-channel validation, text/HTML/email builders, failure classification, calendar |
| integrations | WordPress client (Basic auth, no redirects, no retry on create), Mautic client (segments, segment email) |
| jobs | publish workflow under time-skipping Temporal: waits for the time, superseded revision, approval block, Postiz confirm, transient re-post, rejection, expired login. Activities: one Postiz post per job (group reuse), media upload, `__type` settings, finish → content published / account refresh_needed |
| api | 57 tests incl. crosspost group + one workflow per target, per-target 422s, brand/role/viewer permissions, past times, wrong content type, retry revision, Postiz key check + encrypted storage + sync, HTTPS-only WordPress |
| RLS smoke §18 | approval gate (unapproved → missed, stale revision, no double claim, edit after approval), cross-brand / cross-workspace accounts refused, secrets unreadable, schedules not writable by clients |
| `next build` | passes |

**Not verified**: no live Postiz, WordPress or Mautic instance and no real platform accounts were used. Real publishing, OAuth round-trips and platform rejections need a staging run (docs/07 "publishing sandbox suite").

## 7. Gaps and decisions

- **Postiz org provisioning** stays manual (create org, copy API key). Automating it needs an upstream Postiz change (AGPL: publish any patch).
- **Postiz `refreshNeeded`** isn't exposed by its public API, so expired logins are detected when a publish fails, not ahead of time.
- **Business Profile language**: Postiz sends `languageCode: "en"` for every GBP post (Telugu posts are labelled English). A direct GBP API adapter would need Google's GBP API access approval for Arcatic's own Cloud project.
- **Media formats**: `.mov`/`.heic` must be converted first (render videos in the video editor). HTTP-only or private storage URLs won't work with Postiz (it fetches over public HTTPS).
- **Mautic**: needs API + HTTP basic auth enabled. OAuth2 is not implemented. One Mautic instance per workspace (docs/00 decision (a)). Mailchimp is not built (not requested).
- **Calendar performance** shows metrics only once Phase 8 ingests them.
