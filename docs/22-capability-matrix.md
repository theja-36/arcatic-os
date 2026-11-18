# 22 — Capability matrix (honest status)

Written 2026-11-18 at the end of the Phase 12 local-staging cycle.

**About the "185-feature scope".** No 185-item list exists in this repository or in the project folder. This matrix is therefore built from what *is* written down: the phase scopes and acceptance criteria in [`09-build-plan.md`](09-build-plan.md) and the per-phase docs (10–20). If you have the original numbered list, send it and each item gets mapped onto a row below; until then, treat the row count here as unrelated to 185.

## Tiers

| Tier | Meaning |
|---|---|
| **V** Implemented and verified | Works, and a test or recorded run against a *real* component (real Postgres/RLS, real Supabase Storage, real SMTP sink, real Chrome) proves it. Evidence is named. |
| **U** Implemented but unverified | Code exists and passes unit tests against mocks/fakes of the external service, but has never run against the real service or in the real deployment shape. |
| **S** Scaffold / mock / placeholder | Route/page/table exists, the behaviour is thin, canned or mock-backed. Not a finished feature. |
| **M** Missing | Not built. |
| **B** Blocked | Cannot be verified or finished without credentials, a device, hosting, or an external approval. |

**Test baseline (this cycle, `pnpm test`, all green):** database 4, web 13, ai 38, integrations 36, core 203, api 131, jobs 72 (+1 skipped Docker/FFmpeg test) = **497 passed, 1 skipped**. Typecheck/build were green at the last commit. DB behaviour: `supabase/tests/smoke/10_rls_smoke.sql` sections 1–24, last run "RLS SMOKE: ALL PASSED". Hosted Supabase, Temporal and every third-party SaaS have **not** been exercised.

What "real" means in this environment: local Supabase (Postgres, PostgREST, Auth, Storage) + Mailpit (SMTP sink) + the real API and web production build + real desktop Chrome. Temporal is **not** running locally; workflows are tested with Temporal's in-process `TestWorkflowEnvironment`. All AI, scraping, media, publishing, billing and ads services are faked in tests.

## Matrix

Evidence key: **RLS-n** = smoke section n; **E2E** = `scripts/e2e/services-staging.ts` (98 checks, `docs/evidence/phase12/local-staging-20261118105925/`); **SWEEP** = `scripts/e2e/api-sweep.ts` (0 × 5xx, `docs/evidence/api-sweep/local-staging-20261118130757/`); **UI** = manual walkthrough of every page in the built web app on real data (this cycle, no error states); unit files are under `*/test/`.

### Phase 1 — Foundation

| Capability | Tier | Evidence / gap |
|---|---|---|
| Org → workspace → wallet bootstrap, roles, brand-restricted members | **V** | RLS-1…6; `core/test/rbac.test.ts`; SWEEP; UI (members page lists real members) |
| Tenant isolation, last-owner guard, no owner escalation | **V** | RLS-1,3,5 |
| API keys (create/list/revoke) | **U** | `api/test/app.test.ts`; UI page loads; never used by an external client |
| Credit ledger: reserve/settle/release/extend, idempotency, insufficient funds | **V** (SQL level) | RLS-7; `core/test/credits.test.ts`; E2E billing loop. The "100-way concurrency" acceptance criterion in 09 has **no** test → **U** |
| Job state machine + job feed | **V** (state machine) / **U** (feed with real Temporal) | RLS-9; `jobs/test/workflows.test.ts` uses in-process Temporal only |
| Audit log | **V** for services events | RLS-24 (trigger, real actor); other domains' audit coverage not enumerated → **U** |
| Auth (Supabase) | **V** locally | E2E signs real users in; SWEEP. SSO/OAuth providers, password reset emails: **B** (hosted project) |

### Phase 2 — Onboarding & Brand Intelligence

| Capability | Tier | Evidence / gap |
|---|---|---|
| Brand Kit: versions, drafts, approval atomicity, citations stored | **V** | RLS-10; `core/test/brand-kit.test.ts`; UI (kit page) |
| Website analysis → extracted kit (Firecrawl + Claude) | **U** | `ai/test/brand-extract.test.ts`, `core/test/brand-web.test.ts`, `integrations/test/clients.test.ts` use fakes. No real Firecrawl or Anthropic call has ever been made. "20-page site < 3 min" **not measured** → **B** (Anthropic + Firecrawl keys) |
| SSRF protection | **V** | `core/test/url-safety.test.ts` |
| Brand Context compiler ≤ 1.5k tokens | **U** | unit-tested; no real-model measurement |
| Onboarding wizard UI | **S** | page renders ("Your business"); the end-to-end analyse→review→approve flow has not been driven with a live analyzer |

### Phase 3 — Knowledge OS

| Capability | Tier | Evidence / gap |
|---|---|---|
| Sources, chunks, hybrid search, private sources, atomic re-index | **V** | RLS-12; `core/test/knowledge.test.ts`; `api/test/knowledge.test.ts` |
| Ingestion: URL/crawl/PDF (Docling)/media (Whisper)/Drive | **U** | clients tested with fakes (`knowledge-clients.test.ts`); no real Docling/Whisper/Drive. "50-page PDF < 2 min", "10-min Telugu transcript" **unmeasured** → **B** |
| Embeddings (real model) | **U** | pgvector storage verified; embedding model never run |

### Phase 4 — Strategy & Campaigns

| Capability | Tier | Evidence / gap |
|---|---|---|
| Strategy revisions, one active per brand, read-only for clients | **V** | RLS-13; `core/test/strategy.test.ts` |
| Campaign lifecycle, topic slots | **V** (DB) | RLS-14; `jobs/test/campaign-runner.test.ts` (pause/resume/cancel on in-process Temporal; "reflects in Temporal within 5 s" **unmeasured** against a real server) |
| AI-generated 90-day plan | **U** | `ai/test/strategy.test.ts` with a fake model only |
| Planner / calendar / campaigns UI | **V**/**S** | UI: pages render real rows (Diwali campaign). Not every edit path exercised |

### Phase 5 — Content engine

| Capability | Tier | Evidence / gap |
|---|---|---|
| Versions immutable, selective regeneration lookup, validators, approval workflow | **V** | RLS-8,11,15; `core/test/{content,validation}.test.ts`; `api/test/content.test.ts` |
| AI generation of all content types | **U** | `ai/test/{generate,content-templates}.test.ts` with fakes; schema validity "100%" is only proven for fake output |
| Image generation (ComfyUI) | **U** | `integrations/test/comfyui.test.ts` (fake HTTP) |
| Editors, bulk regen UI | **S** | content list/detail render; rich editing not exercised end-to-end |

### Phase 6 — Media & video

| Capability | Tier | Evidence / gap |
|---|---|---|
| Media folders, video projects, timeline data model | **V** (DB) | RLS-16,17; `core/test/video.test.ts` |
| FFmpeg render pipeline | **U** | `scripts/verify-render.ts` and a Docker test exist; the Docker test is **skipped** in this run, so no render was verified this cycle. 60 s / 2 min target unmeasured |
| Media library / video editor UI | **S** | page loads; no upload→render run in UI |

### Phase 7 — Publishing & calendar

| Capability | Tier | Evidence / gap |
|---|---|---|
| Approval gate at publish time, account/brand guards, secrets service-only | **V** | RLS-18; `core/test/publishing.test.ts`; `jobs/test/publish-*.test.ts` |
| Postiz provisioning/publishing, GBP, WordPress | **U** | fakes only. "Sandbox publish to each channel" never done → **B** (Postiz instance, social/GBP/WP sandbox accounts) |
| Failure surfacing < 1 min, retries | **U** | workflow tests on in-process Temporal |

### Phase 8 — Analytics & learning

| Capability | Tier | Evidence / gap |
|---|---|---|
| Warehouse upsert/snapshots, isolation, decision-by-API | **V** | RLS-19; `core/test/analytics.test.ts`; `jobs/test/analytics-*.test.ts` |
| Matomo / Mautic / Langfuse integrations | **U** | `integrations/test/analytics-clients.test.ts`, fakes. "Metrics within 2 h" unmeasured → **B** |
| Insights, learning proposals (approval-gated) | **U** | logic unit-tested; no real data volume |

### Phase 9 — Growth suite

| Capability | Tier | Evidence / gap |
|---|---|---|
| Projects, repurposing runs, brand-pinned projects | **V** (DB) | RLS-20; `jobs/test/{repurpose,growth-workflow}.test.ts` |
| "One video → ≥ 6 assets" | **U** | proven with a fake model; not with real transcript/LLM |

### Phase 10 — SaaS commercial

| Capability | Tier | Evidence / gap |
|---|---|---|
| Refund bounds, ledger immutability, usage counts, isolation | **V** | RLS-21; `core/test/billing.test.ts`; `api/test/billing.test.ts` |
| Lago plans/checkout/top-ups/invoices, payment provider | **U** | `integrations/test/clients.test.ts` (fake); `scripts/lago-setup.ts` never run. Upgrade/downgrade/cancel/reactivate in Stripe test mode **not done** → **B** (Lago + Stripe test keys) |
| Billing page, billing-portal embed | **V** locally | SWEEP fixed an ambiguous embed; UI page loads |

### Phase 11 — Advanced growth

| Capability | Tier | Evidence / gap |
|---|---|---|
| SEO/AEO research data model, competitor research (fake provider) | **V** (DB) / **U** (logic) | RLS-22; `core/test/seo.test.ts`; `api/test/seo-ads.test.ts` |
| Ads approvals tied to campaign revision, budget cap, no spend without approval | **V** (DB + unit) | RLS-22; `core/test/ads.test.ts`; `jobs/test/growth-ads.test.ts` |
| Google Ads v26 / Meta SDK sidecar | **U** | `services/ads-sync/test_{build,normalize,sdk}.py` exercise the official SDKs' request builders offline. "Sandbox campaign created" **never done** → **B** (Google Ads dev token + test account, Meta sandbox app) |

### Phase 12 — Services & mobile

| Capability | Tier | Evidence / gap |
|---|---|---|
| Service request → assignment → delivery → QA → approval → billing loop, holds (60-day), paid revisions, re-hold before charge | **V** (local staging) | E2E 98/98 ×2 on real local Supabase incl. **real Storage** for deliverables; RLS-23,24; `core/test/services.test.ts`; `api/test/services-{mobile,security}.test.ts` |
| Customers can't see internal notes, hold ids, assignee, QA notes | **V** | RLS-24; E2E; `api/test/services-security.test.ts` |
| Staff desk, `/ops` view, audit trail with real actors | **V** (local) | E2E; RLS-24; UI: `/desk` correctly refuses a non-staff user |
| Scheduled services maintenance (hold extension, overdue, 3-day review reminder, expired/failed-hold policy, idempotency) | **U** | `jobs/test/services.test.ts` (activities against fakes). Extended run against real DB + Temporal is in the staging-prep work, **not complete** |
| In-app notifications | **V** | E2E; RLS-23 |
| Email notifications | **V** to a local SMTP sink only | E2E via Mailpit (allowlist mode). Real provider delivery/DKIM/bounces: **B** |
| Web Push — server accepted by push service, payload decrypts (RFC 8291) | **V** | `integrations/test/push-email.test.ts` (independent decrypt) |
| Web Push — **displayed** on desktop Chrome while Chrome was running | **V** (single observation, recorded) | `docs/evidence/phase12/…/real-push-chrome-desktop.json`. After the tag fix, re-display was shown in-browser only |
| Notification click → correct `/m` page: foreground tab, background tab | **U** — unit-tested (`web/test/sw-click.test.ts`, 13 tests, all paths incl. closed/uncontrolled/openWindow) and user-observed twice, but not recorded as automated evidence | |
| Notification delivery + click with **the browser app closed** (desktop) | **B / UNVERIFIED — not passed.** Two manual attempts showed no notification and the cause was not isolated | See [21-phase12-launch-verification.md](21-phase12-launch-verification.md). Not retried until a specific cause is found |
| Android Chrome: install, permission, push, tap → `/m`, offline, cache contents | **B / UNVERIFIED** | No device test performed. Checklist: [23-hosted-staging.md](23-hosted-staging.md) §Android |
| PWA: manifest, icons, SW controlling, offline fallback, cache holds build assets only | **V** (desktop Chrome, local HTTP) | docs/21 §3; E2E. `beforeinstallprompt` and HTTPS install: **B** (needs hosted HTTPS / Android) |
| Mobile hub (`/m`) inbox/agenda/publishing/quick-create | **V** (API) / **S** (UI) | SWEEP covers routes; UI loads; a day-to-day phone workflow has not been used |

### Cross-cutting

| Capability | Tier | Evidence / gap |
|---|---|---|
| Route robustness | **V** | SWEEP: 6 server errors found and fixed (embeds, 404 mapping); re-run 0 × 5xx |
| UI walkthrough of every workspace/brand/settings page on real data | **V** (renders without errors) | UI, this cycle. This proves pages load; it does **not** prove each interaction works |
| Hosted Supabase project, hosted web/API, Temporal Cloud/self-hosted, domains/CORS, real SMTP provider | **B** | No credentials; see [23](23-hosted-staging.md) |
| Observability/alerting, backups/DR, load/perf tests, pen test, DPA/legal | **M** | not built or not started |
| Multi-language (Telugu) content/transcripts | **U** | prompts/templates exist; no real-model check |

## Summary

* **Genuinely verified:** the data layer (RLS, ledger, state machines), the API's route behaviour, the Phase 12 services workflow on a real local Supabase, in-app + local-sink email, and a single real desktop push display.
* **Not finished products:** everything that depends on an external AI/scrape/render/publish/billing/ads service. The code and its fakes exist; none has run against the real thing. These are *scaffolds with unit tests*, not a finished advanced product.
* **Honestly open:** closed-app push/click and Android are BLOCKED/UNVERIFIED; hosted staging has not been touched.
