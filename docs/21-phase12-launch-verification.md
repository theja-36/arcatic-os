# 21 — Phase 12 hardening and launch verification

**Status: local-staging verified — not staging verified, not launch ready.**

No hosted staging environment exists yet, so every end-to-end result below comes from a **local staging stack**:
- real Supabase (CLI 2.122.1: Postgres 17, Auth, PostgREST, Storage, Realtime, Mailpit);
- the production API;
- the production web build;
- the user's real Chrome desktop.

The same harness runs unchanged against hosted staging (§6).

## 1. What changed in this pass

| Area | Change |
|---|---|
| **Notifications** | One notifier (`packages/jobs/src/notifier.ts`) writes the in-app row, sends **Web Push** (`web-push` 3.6.7, VAPID) to every registered device, and **emails** critical events (`nodemailer` 7.0.13 over SMTP). It prunes dead push endpoints (404 / 410) and records the outcome per notification (`notifications.delivery`).<br>Email has a staging guard: `EMAIL_MODE=allowlist` (default) sends only to `EMAIL_ALLOWLIST` domains (default `example.test`). |
| **Notification wording** | `packages/core/src/services/notices.ts`. Customer notices are built from a type that has **no fields** for internal notes, QA comments, hold ids or staff identity, so they can't leak even by mistake. |
| **Events covered** | request received, assigned, delivery ready, revision requested, approval received (customer receipt + staff), cancellation / refund (credits released), overdue (daily, deduped), awaiting approval (every 3 days), hold lost, QA ready / returned, messages |
| **Push on devices** | "Get push notifications on this device" in the bell (desktop sidebar and `/m`). `GET /v1/me/push-key` serves the VAPID public key. The service worker shows pushes and opens the linked page.<br>A browser that already has a subscription re-registers it when the bell opens. This was found during the real-Chrome test: after a sign-in (or a pruned device) the server didn't know the browser. |
| **Install** | `/m` shows "Install app" when Chrome fires `beforeinstallprompt`. |
| **Operations** | `service_ops` view (service role only):<br>- SLA state per open request: on track / due soon / overdue / awaiting customer;<br>- credits on hold and earliest expiry;<br>- holds lost;<br>- workload per person.<br>Exposed as the desk **Operations** tab (managers) and `GET /admin/service-ops` (admin token). |
| **Holds** | Upkeep extends holds that are within 7 days of expiry (unchanged). New: a hold that already expired or was released is reported to managers ("hold lost") and audited.<br>Approval now **re-holds** any lost hold *before* delivering anything; without enough credits it returns 402 and nothing is delivered or charged. |
| **Audit** | Every service event becomes an `audit_logs` row with the person who caused it (`service.<kind>[:<status>]`): status changes, assignment, holds, charges, releases, files, hold extension / loss. |
| **Security fixes found by this pass** | 1. **Column leak**: customers could read `reservation_id`, `extra_reservation_ids`, `assignee_id`, `qa_by` and `qa_note` through Supabase REST directly. These are now excluded with column-level grants.<br>2. **Timeline leak**: internal timeline entries (QA steps, who was assigned, hold upkeep, files) were readable by customers. They now have `visibility = 'internal'`, filtered by RLS.<br>3. Policies that checked `assignee_id` now use a security-definer helper (`app.is_service_assignee`). |
| **Pre-existing bug fixed** | Since Phase 10, `subscriptions → plans` has two foreign keys, so PostgREST rejected the `plan:plans(...)` embed. That broke: **creating a brand**, the plan-limit check when connecting publishing accounts, and the feature gate (`assertPlanFeature`).<br>Mocked tests could not catch it; real Supabase did. It is now pinned to `plans!subscriptions_plan_key_fkey`. |
| **UI fixes found on screenshots** | Notifications panel clipped off-screen on phones; delivered documents shown in the editor with misleading "yours" badges (now a read-only preview); file sizes shown as "0.0 MB"; "1 credits"; overlapping ops table headers. |

Migration: `supabase/migrations/20261129000018_services_hardening.sql`.

## 2. What was actually tested

### 2a. Automated suites (all on this machine)

| Suite | Result |
|---|---|
| core | 202 passed (incl. leakage test: secrets smuggled into customer notice inputs never appear) |
| integrations | 36 passed (incl. Web Push payload **decrypted with an independent RFC 8291 implementation**, VAPID JWT signature verified; email allowlist) |
| jobs | 71 passed, 1 skipped (Docker media). Covers: notifier delivery / pruning / email refusal; hold lost; hold extension event; maintenance order |
| api | 128 passed. 13 new security tests: IDOR across workspaces, staff vs customer routes, manager can't see drafts, role escalation, admin token only, attachment round / path checks, notification leakage, expired-hold re-hold, insufficient credits → 402 with no delivery |
| ai / database | 38 / 2 passed |
| RLS smoke (Postgres 17) | **ALL PASSED**, incl. new §24: customers can't approve, assign or forge timeline entries; can't become staff; can't read the ops view, hold ids, assignee or QA notes; specialists can't promote themselves or read holds, members or audit logs; audit rows carry the real actor |

### 2b. End-to-end on local staging — `scripts/e2e/services-staging.ts`

**98 / 98 checks passed** on a freshly reset database (`docs/evidence/phase12/local-staging-20261118105925/`). An earlier run on a non-reset database also passed 98 / 98 (`…/local-staging-20261118064126/`, which holds the customer and mobile screenshots).

Update 2026-11-18: the harness gained Flow D (3-day "waiting for your review" reminders: none at 1 day, one at 4 days, idempotent re-runs, second at 7 days, deep link, no internal text) and now has **103 checks**; it passed **103 / 103** on the same (non-reset) local stack — `docs/evidence/phase12/local-staging-20261118131932/`. Hosted-staging preparation (preflight, SMTP check, checklists, Android checklist) is in [23-hosted-staging.md](23-hosted-staging.md); the feature-by-feature status is in [22-capability-matrix.md](22-capability-matrix.md).

| Group | Checks | What is proven |
|---|---|---|
| Setup (15) | real Auth users (`@example.test`), workspace, brand, approved Brand Kit, 1000 test credits via admin API, reference image through Storage, service staff via admin API, push devices | the production API on real Supabase |
| Flow A: full path (47) | submit → brief frozen (brand + banned words + source draft) → **25 credits held ≈ 60 days** → wallet held +25 → manager triage and suggestions → assign → specialist starts from the customer's draft → file to private Storage → QA return (internal) → QA approve → delivered → free revision → **paid revision holds 5 more** → approve → **v2 of the original draft** (`origin human`, `transform service`) → **file copied into the media bucket** (bytes match) → both holds settled (25 + 5) → **balance −30, held −30** | the money, content and file outcomes |
| Flow A: security on the real stack | contributor can't approve; outsider gets 404 from either workspace path; customer has no desk; other specialist 404; specialist can't assign; via REST the customer can't read hold ids, assignee, work in progress, internal timeline or ops; customer can't download service files; specialist can't read the customer's media, brands, content, holds, members or audit logs; unassigned specialist sees nothing; customer can't change status; specialist can't promote themselves | RLS, column grants and Storage policies, not just the API |
| Flow B: cancel (3) | cancel after assignment releases the **full 120**, wallet back to the start; cancel refused once work started | release path |
| Flow C: holds (7) | upkeep extends a hold 2 days from expiry to ~30 days; the platform expiry job expires a hold; upkeep reports hold lost + overdue; a second run sends no duplicates; offering without QA delivers directly; approval **re-holds the expired 30 and charges it** | expiry and failure paths |
| Mobile endpoints (7) | inbox counts, agenda paging, publishing status, quick-create (brand ready, prices), notification feed + unread, mark all read, desk list | real PostgREST joins |
| Ops (3) | manager ops view, specialist 403, admin token only | |
| Audit (4) | every Flow A transition audited **with the right person** (owner submitted / approved, manager assigned / delivered, specialist started); holds, charges, files, assignments audited; hold extension / loss audited as system | |
| Notifications (3) | customer got received / assigned / delivered / approved / cancelled; specialist got assigned / QA returned / revision / approved / cancelled / overdue; **no customer notification contains QA notes, internal notes, staff names or hold ids** | |
| Push (4) | 26 pushes to a local HTTPS push endpoint. Each is `aes128gcm`, VAPID-signed, **decrypted by the test with the device's private key**, and free of internal text. The 410 endpoint is removed; outcomes are recorded | the full server-side push path |
| Email (5) | via Mailpit (SMTP):<br>- **customer**: received, delivered, approved, cancelled;<br>- **staff**: new request, assigned, revision;<br>- **non-allowlisted address**: nothing sent, recorded as refused;<br>- **customer bodies**: no internal text. | staging email guard |

### 2c. PWA in real Chrome desktop (Chrome 157, macOS, production build on `localhost:3000`)

| Check | Result |
|---|---|
| Manifest linked and valid (id, name, short_name, start_url `/m?source=pwa`, scope `/`, display standalone, colours) | pass |
| Icons: declared size = actual pixels (192 any, 512 any, 512 maskable), served as `image/png` | pass |
| Service worker `/sw.js` registered, **activated and controlling** the page, scope `/` | pass |
| Installable: Chrome fired `beforeinstallprompt` | pass |
| Cache after visiting app pages holds only `/_next/static/*` (9 files), icons, manifest and `/offline`. **No pages, API responses or media URLs** | pass |
| Offline: web server stopped → navigating to `/m/<ws>?tab=inbox` shows the offline page from cache | pass (screenshot) |
| Real push via Google FCM to this Chrome | **pass**. Permission granted, subscription on `fcm.googleapis.com`, device registered through the API. `scripts/e2e/send-test-push.ts` → notifier → Google FCM answered **201**, and the macOS system notification appeared (seen by the user). Evidence: `real-push-chrome-desktop.json`. Not checked: clicking the notification opens `/m`. |

## 3. PWA acceptance criteria (replace "Lighthouse PWA ≥ 90")

Lighthouse 12 removed the PWA category, so a release passes when, on **staging over HTTPS**, in **Chrome desktop and Android Chrome**:
1. DevTools → Application → Manifest shows no errors, and the installability section is clean.
2. The 192, 512 and maskable 512 icons render; the maskable icon looks right in the maskable preview.
3. The service worker is *activated and is running*, and controls `/m` after one reload.
4. The browser offers install (address-bar icon on desktop; "Install app" / add to home screen on Android), and the installed app opens in standalone at `/m`.
5. With the network off, an app route shows the offline page.
6. Cache Storage `arcatic-v1` contains only `/_next/static/*`, `/icons/*`, `/manifest.webmanifest` and `/offline`.
7. Push: after "Get push notifications on this device" → Allow, `scripts/e2e/send-test-push.ts <email>` produces a system notification, and clicking it opens `/m`.
8. Phone layout (375 × 812): bottom tabs reachable, notifications panel fully on screen, no horizontal scroll.

Criteria 1–6 and 8 pass on Chrome desktop locally (8 in the in-app browser at 375 × 812). Criterion 7 passes except the click-through to `/m`. Everything on Android remains.

## 4. Evidence

`docs/evidence/phase12/`:

| Folder | Contents |
|---|---|
| `local-staging-20261118105925/` (**clean run**) | `steps.json` (98 steps with details), `evidence.json` (holds, wallets, push titles, email subjects, ops totals, audit trail of Flow A), `run.env.json` (ids, test addresses), `run.log`.<br>Screenshots:<br>- `01-desk-operations-clean-run.jpg`<br>- `02-desk-request-staff-view-internal-notes.jpg` |
| `local-staging-20261118064126/` | the same files for the first run.<br>Screenshots:<br>- `01-customer-request-approved.jpg`<br>- `02-mobile-quick-create.jpg`<br>- `03-mobile-media-library-with-delivered-file.jpg`<br>- `04-mobile-notifications-customer-safe.jpg` (after the clipping fix)<br>- `05-desk-operations-multi-run-db.jpg` (before the header fix; includes earlier partial runs)<br>- `06-chrome-desktop-offline-fallback.jpg` |

Secrets (JWTs, signed URLs, keys) are redacted from the evidence files. Test addresses are `@example.test` plus one deliberately non-allowlisted `@not-allowlisted.test`.

## 5. Remaining launch blockers

1. **Hosted staging run.** Provision `arcatic-staging` (Supabase project with the `service-files` bucket; API and web over HTTPS; SMTP to a sandbox provider; VAPID keys), then run:
   ```
   E2E_TARGET=staging npx tsx --env-file=.env.staging scripts/e2e/services-staging.ts
   ```
   Leave out `PUSH_MOCK_*`; real devices cover push. It must pass 103 / 103 minus the four P checks.
2. **Push on Android.** Android Chrome install + push (§3 criteria 4 and 7) needs a person with the device. Chrome desktop real push is verified; its notification click-through is not yet checked.
3. **Temporal on staging.** The `billing-maintenance` schedule runs `serviceMaintenance` before the hold-expiry step. Locally that was checked with Temporal's test server and by calling the activity directly; it needs one scheduled run on staging (check `service.hold_extended` audit rows).
4. **Email provider.** Configure SMTP for the staging provider's sandbox and keep `EMAIL_MODE=allowlist` there. Production moves to `all` only on purpose.
5. **Legal / ops** (from Phase 12):
   - a data-processing agreement covering the service team and any contractors;
   - specialist payouts handled outside Arcatic.

Not blockers, but untested: iOS Safari (no push for non-installed web apps there); AI generation from the mobile Create tab (needs the worker and the Anthropic key; the endpoint itself is unchanged).

## 6. How to reproduce locally

1. Start Supabase:
   ```
   npx supabase@2.122.1 start -x edge-runtime,studio,postgres-meta,vector,logflare,imgproxy
   npx supabase@2.122.1 db reset
   ```
2. Build an env file from `supabase status -o env`:
   - SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY;
   - generated ENCRYPTION_KEY, ADMIN_API_TOKEN and VAPID keys;
   - SMTP_HOST=127.0.0.1, SMTP_PORT=54325;
   - APP_URL / API_CORS_ORIGINS = http://localhost:3000;
   - API_PORT=4418, NEXT_PUBLIC_API_URL=http://localhost:4418, MAILPIT_URL=http://127.0.0.1:54324.
3. API:
   ```
   NODE_EXTRA_CA_CERTS=<mock cert> npx tsx --env-file=<env> apps/api/src/server.ts
   ```
4. Harness:
   ```
   E2E_TARGET=local-staging PUSH_MOCK_CERT=<cert> PUSH_MOCK_KEY=<key> NODE_EXTRA_CA_CERTS=<cert> npx tsx --env-file=<env> scripts/e2e/services-staging.ts
   ```
   The mock push certificate is a throwaway self-signed `localhost` certificate (`openssl req -x509 -newkey ec …`).

## 7. Proposed commit boundaries

The workspace is not a git repository yet, so these are proposals:

1. `fix(api): pin subscriptions→plans embed` (routes/workspace.ts, publishing.ts, billing.ts): an independent production bug fix.
2. `feat(db): services hardening migration` (0018 + smoke §23–24): column grants, event visibility, assignee helper, audit trigger, ops view, delivery column, `extend_reservation`.
3. `feat(notify): web push + email with customer-safe notices`: core `notices`, integrations `push` / `email`, jobs `notifier` + `service-activities`, API `notify` + services / desk wiring, worker wiring, `.env.example`, tests.
4. `feat(ops): service operations view and hold recovery`: `service-ops`, desk / admin endpoints, re-hold on approval, hold-lost upkeep, desk Operations tab, tests.
5. `feat(web): push opt-in, install button, mobile fixes`: Notifications, RegisterSW, DocPreview, format helpers, page fixes.
6. `test(e2e): staging harness and evidence`: `scripts/e2e/*`, `docs/evidence/phase12/*`, docs 09 / 20 / 21.
