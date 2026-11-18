# 23 — Hosted staging: deployment checklist, verification plan, Android checklist

> **§1 (credentials list) and the hosting assumptions below are superseded by the internal staging plan (kept private)**, which has the full infrastructure inventory, sizing, costs, Supabase-key audit, migration procedure and the single ordered handoff. §2 onward (deployment order, scheduled-job verification, notification status, Android checklist, gates) still apply.

Status of this document: **prepared, not executed.** Nothing here has been run against a hosted environment — no hosted Supabase project, hosting, Temporal or email provider exists yet. What *has* been run is the same flow on the local-staging stack (docs/21). Environment names only appear below; **never paste secret values into chat** — put them in the host's secret manager and tell me when they are set.

Rules that apply to every step: no push, no deploy, no purchases, no email to real people and no production data without your explicit approval.

## 1. What I need from you (one consolidated list)

Items are **names / decisions only**. "Secret" values go straight into the host's secret manager (or a local, git-ignored env file); I never need to see them.

### A. Accounts and projects to create (you, or approve me to — creation can bill)

| # | Item | Why | Notes |
|---|---|---|---|
| A1 | **Hosted Supabase project for staging** (separate from any production project) | DB, Auth, Storage | Region near users. Provides `SUPABASE_URL`, anon key, service-role key (secret), JWT secret or JWKS |
| A2 | **Hosting for the API + worker** (container/Node host) and **for the web app** | the deployed stack | Must serve HTTPS. API needs a long-running process; the worker is a separate long-running process |
| A3 | **Temporal** — Cloud namespace (or a self-hosted server I can reach) | the worker + the 2 schedules | Gives `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY` (secret) |
| A4 | **Staging domain / subdomains** (web + API) with DNS control | HTTPS origin for service worker, Web Push, PWA install, CORS | e.g. `staging.<domain>`, `api-staging.<domain>` |
| A5 | **Email provider with a sandbox / test mode**, and a **test-only recipient domain or inbox** | staging email integration | Provides `SMTP_HOST/PORT/USER/PASS` (secret), a verified staging sender, SPF/DKIM DNS records |
| A6 | **An Android phone with Chrome** and a Google account on it | Android verification | Real device only; emulators do not prove push |

### B. Values I generate (no input needed from you beyond approving the secret store)

`ENCRYPTION_KEY`, `ADMIN_API_TOKEN`, `PUSH_RECEIPT_SECRET`, VAPID key pair (`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`). Never reused from local or production.

### C. Needed only for the areas that depend on external services (each is its own go/no-go)

| Area | Credentials / approval |
|---|---|
| AI generation, brand analysis, strategy, repurposing | `ANTHROPIC_API_KEY` (and a spend cap decision) |
| Website analysis | Firecrawl instance URL + `FIRECRAWL_API_KEY` |
| Embeddings | `VOYAGE_API_KEY` (or a self-hosted TEI endpoint) |
| Documents / transcription | Docling service URL + key; Whisper endpoint |
| Image / video | ComfyUI GPU host + shared secret; FFmpeg render host |
| Publishing | Postiz instance URL + admin key; sandbox accounts per channel (Instagram, Facebook, LinkedIn, GBP, WordPress) |
| Analytics | Matomo URL + token; Mautic URL + client id/secret; Langfuse keys |
| Billing | Lago URL, API key, webhook secret; payment provider **test-mode** account (Stripe/Cashfree) |
| Ads | Google Ads developer token + OAuth client + a Google Ads **test** account; Meta developer app + sandbox ad account; `ADS_SYNC_SECRET` |
| Drive import | Google OAuth client / API key / app id |
| Legal / policy | DPA and subprocessor review (Supabase, Temporal, email provider, Anthropic); privacy policy for push/email |

### D. Decisions

1. Which email domain(s) are **test-only** recipients for staging (the allowlist)?
2. Spend ceiling for any paid AI/render calls used during staging tests.
3. Approval to run the first hosted deploy once the preflight is green.

## 2. Deployment order (nothing below has been executed)

1. **Secrets.** Fill `.env.staging.example` into the host secret manager. Run `pnpm staging:preflight --offline` locally against the same file: all `config` and `safety` rows must pass (HTTPS, not-local, not-production, EMAIL_MODE ≠ all, allowlist has no public mailbox domains, CORS exact, secret lengths, VAPID shape).
2. **Database.** Apply migrations `20261117000001` … `20261130000019` in order to the hosted project (`supabase db push --linked`, or the SQL editor). Then run `supabase/tests/smoke/10_rls_smoke.sql` against a **throwaway copy** (the smoke test writes rows; do not run it on shared staging data).
3. **Storage.** Migrations create two **private** buckets: `media` (policies from migration 0006) and `service-files` (API-only, signed URLs, created by 0017). Confirm in the dashboard they are not public. Preflight checks this.
4. **Auth.** Set the site URL and redirect URLs to the staging web origin; enable email confirmation as intended; disable open signups if staging should be invite-only.
5. **Seed.** Staff are not workspace members: create staff with the admin endpoint `PUT /admin/service-staff` using `ADMIN_API_TOKEN` (never from the browser).
6. **API + worker.** Deploy both from the same commit. API env: everything in `.env.staging.example`; worker needs the same plus the AI/ingest keys it uses. On start the worker creates the schedules `billing-maintenance` (every 15 min) and `analytics-daily` (every 2 h). Set `API_PUBLIC_URL` to the public API origin (push receipts are posted to it).
7. **Web.** Build with `NEXT_PUBLIC_*` set to the staging values (they are baked in at build time).
8. **Preflight (live).** `pnpm staging:preflight` — all rows green except those for areas not yet provisioned (mark those SKIP/accepted explicitly in the report). It checks: Auth/REST reachable, migration markers, private buckets, anonymous reads blocked, `/health` + `/health/ready` (db + Temporal), CORS allows only the web origin, forged push receipt → 403, manifest/SW/offline/icon files served as correct types, both Temporal schedules exist and are not paused, SMTP connect+auth (nothing sent). It writes `docs/evidence/staging/preflight-<UTC>.json` containing names and verdicts only.
9. **Email check.** `pnpm staging:smtp` (connect/auth only). Sending one test message needs your approval: `pnpm staging:smtp -- --send <address on the allowlist>`; verify delivery, SPF/DKIM alignment and the `From` in the provider's sandbox log.
10. **Hosted E2E.** `E2E_TARGET=staging npx tsx --env-file=<staging env> scripts/e2e/services-staging.ts` (103 checks). It refuses unmarked or production-looking targets, uses only `@example.test`-style recipients, and (unlike local) has no mail catcher — email checks `E1–E4` need the provider's sandbox inbox/API and must be adapted to it before the first hosted run (the push checks `P1–P4` use a mock endpoint that is reachable only locally and are skipped on hosted; real push is verified manually, §4–5). The harness's recipients are `@example.test` (a reserved, undeliverable TLD): run it with `EMAIL_MODE=off` on the staging API so it can't generate bounces against the real provider, or point it at a provider sandbox that swallows mail.

## 3. Scheduled jobs — what exists and how each requirement is verified

| Requirement | Implementation | Verified how, where |
|---|---|---|
| Schedules exist | `ensureBillingSchedule` (15 min), `ensureAnalyticsSchedule` (2 h), created on worker start, idempotent | Unit/in-process Temporal; **hosted:** preflight checks both exist and are not paused. **Not verified against a real Temporal server yet** |
| Billing maintenance runs service upkeep **before** expiring stale holds | `billingMaintenanceWorkflow` calls `serviceMaintenance` first | `jobs/test/services.test.ts` (in-process Temporal, ordering asserted) |
| Hold extension (≤ 7 days left → +30 days) | `serviceMaintenance` → `extend_reservation` | **Real local DB:** E2E C1 (hold extended to ≈ 30 days); `jobs/test/services.test.ts` |
| Expired / failed hold policy: stale holds expire, loss is reported to managers, approval re-holds then charges | `expire_stale_reservations`; "hold_lost" notice (deduped per hold); `prepareHolds` in the approve route | **Real local DB:** E2E C2–C7 (expire → managers notified → approval re-holds and charges 30; wallet reconciles) |
| Overdue reminders — assignee + managers, once per day | dedupe key `overdue:<request>:<day>` | **Real local DB:** E2E C3–C5 (no duplicates on re-run) |
| Customer review reminders — after 3 days, then every 3 days | dedupe key `awaiting:<request>:<floor(days/3)>` | **Real local DB:** E2E D1–D5 (none at 1 day, one at 4 days, no duplicate on re-run, second at 7 days, deep link, nothing internal leaked) — added this cycle |
| Idempotency of the whole job | notification `dedupe_key` unique; extension is a no-op on non-expiring holds | E2E C5, D3; `jobs/test/notifier.test.ts` |
| A failing step doesn't stop billing maintenance | workflow catches the service step | `jobs/test/services.test.ts` |

Remaining gap for these jobs: they have run against a real database, but **never inside a real Temporal server** on a schedule. That is the first hosted verification: after deploy, confirm in the Temporal UI that `billing-maintenance` fires every 15 minutes and completes, with `services` counts in the result; then force the conditions (shorten one hold's `expires_at`, back-date one delivery) on **staging test data only** and watch the next run.

## 4. Notification verification — recorded status

| Check | Status |
|---|---|
| Push-service acceptance (HTTP 201 from the browser vendor's service) | Verified (real desktop Chrome subscription, `real-push-chrome-desktop.json`) |
| Payload encryption/signing correct (RFC 8291 + VAPID) | Verified (independent decrypt in `push-email.test.ts`; E2E P1) |
| **Displayed** by desktop Chrome | Observed once while Chrome was running; after the unique-tag fix, display confirmed in the browser's own SW diagnostics |
| Click routing in the service worker (foreground, background, closed, uncontrolled client, same URL, postMessage fallback, hostile links) | Verified by `web/test/sw-click.test.ts` (13 tests) — simulated service-worker environment, **not** a real OS notification |
| Click → correct `/m` page, **foreground** and **background** tab, desktop Chrome | User-observed on two manual attempts; not captured as recorded evidence |
| **Closed-browser/app** delivery and click, desktop | **BLOCKED / UNVERIFIED — not passed.** Two manual attempts showed nothing; cause not isolated. Possible causes still open: OS notification settings/Focus mode for Chrome, Chrome not running, the push subscription being stale for the logged-in device. A hosted HTTPS origin plus the diagnostics below is a materially different test; no further local manual runs |
| Android Chrome (all of §5) | **UNVERIFIED** — no device test has been done |
| Delivery receipts (displayed/clicked reported to `/push/receipt`) | Mechanism verified (worker → API 204, stored in `notifications.receipts`, forged token → 403). A real push → real display → receipt round trip after the receipts-column fix has **not** been re-recorded |

Diagnostics already built in, to use on the hosted test: `notifications.delivery` (push-service status per device), `notifications.receipts` (`displayed`, `clicked` timestamps), and the SW diagnostics message `arcatic:diag`.

## 5. Android Chrome manual checklist (run on a real device against the hosted HTTPS staging URL)

Only mark an item PASS if you saw it. Record the Chrome version, Android version, device model and date. Report back **Pass / Fail / Not tried** per line; do not paraphrase.

Preparation (once): use a fresh Chrome profile or clear this site's data; battery saver **off**; Chrome notification permission and the Android app-notification toggle for Chrome **on**; Do Not Disturb **off**; stay on mobile data or Wi-Fi with a normal connection.

| # | Step | Pass looks like |
|---|---|---|
| 1 | Open `https://<staging web>/m/<workspace>` and sign in as the staging test customer | Mobile hub loads; bottom tabs visible; no console-style error text |
| 2 | Chrome menu → **Install app** (or the in-app Install button) | Prompt appears; after install an Arcatic icon is on the home screen/app drawer and opens full-screen (no browser bar) |
| 3 | In the app, open the bell → enable notifications → allow the permission prompt | Bell shows "enabled"; a device row exists (`user_devices` for this user) |
| 4 | Trigger one real push from the staging admin script `send-test-push.ts <customer email> <requestId> android-1` (I run it after you say you're ready) | Notification appears in the shade with the right title/body within ~30 s; `notifications.delivery` shows push status 201; `notifications.receipts.displayed` is set |
| 5 | **App open in foreground**, send another | Notification still shown (or in-app update); tap → lands on the Inbox with the service card |
| 6 | **App in background** (switched away), send another; tap it | App comes forward on `/m/…?tab=inbox&service=…`, card highlighted; `receipts.clicked` is set |
| 7 | **App closed** (swiped away from recents), send another; tap it | App opens on the same destination — **this is the case that was never verified on desktop** |
| 8 | Tap "Open full request" on the card | Opens `/w/<ws>/b/<brand>/services/<id>` |
| 9 | Airplane mode on → open the app | Branded **offline** page (not Chrome's dinosaur); no customer data visible |
| 10 | Airplane mode off → reload | App works again |
| 11 | On desktop (same Chrome profile sync not required) inspect **Application → Cache Storage** via Chrome remote debugging (`chrome://inspect`) | Cache holds only `/_next/static/*`, icons, manifest and `/offline`; **no** API responses, HTML pages, signed media URLs or customer text |
| 12 | Sign out in the app, send one push, check the shade | Policy check: note whether a notification still appears for the signed-out user (record the result; do not guess) |

If steps 4–7 fail: do not retest repeatedly. Send me the screenshot of the failing screen and the notification's row (`delivery`, `receipts`) and I diagnose from the server side first.

## 6. Go / no-go gates (in order)

1. Preflight live: no FAIL rows for provisioned areas.
2. Hosted E2E ≥ 103/103 (services loop, holds, audit, RLS, notifications in-app).
3. Temporal schedules observed firing and completing in the Temporal UI.
4. Email: one allowlisted test message delivered, SPF/DKIM aligned, nothing delivered to a non-allowlisted address.
5. Real push: display + click on desktop (foreground/background/closed) and Android (§5) each recorded.
6. Only then: external-service areas (AI, publishing, billing, ads) get their own sandbox runs, in the order they are provisioned.
7. "Launch ready" additionally needs: backups/PITR and a restore drill, error monitoring and alerts, rate limiting/WAF at the edge, load test on the hot paths, a security review of the admin endpoints, legal sign-off, and an approved production cutover plan. None of these exist yet.
