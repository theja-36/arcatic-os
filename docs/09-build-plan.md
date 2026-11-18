# 09 — Phased Build Plan

Effort in engineer-weeks (ew) for a team of ~4 full-stack + 1 ML/infra. Estimates are ranges; revisit after Phase 1.

| Phase | Depends on | Scope | Acceptance criteria | Effort |
|---|---|---|---|---|
| 0 Audit & blueprint | — | Repo audit, architecture, docs, monorepo | Docs reviewed & approved; integration matrix has no "assumed" items | 1 ew ✅ (this delivery) |
| 1 Foundation ✅ scaffolded | 0 | Auth, org/workspace/brand, roles, API keys, audit, storage, job infra (Temporal), credit ledger, design system base | New user → org+workspace+wallet in one call; RLS test suite green; job start→events→complete visible in UI; reserve/settle/release idempotent under 100-way concurrency | 6–8 ew |
| 2 Onboarding & Brand Intelligence ✅ scaffolded (docs/10) | 1, Firecrawl | Wizard, website analysis, Brand Kit w/ citations/versions/approval, Brand Context compiler | Analyze a 20-page site in < 3 min; every extracted fact has a source URL; Brand Context ≤ 1.5k tokens and versioned | 5–7 ew |
| 3 Knowledge OS ✅ scaffolded (docs/11) | 1, Docling, Whisper | URL/crawl/file/text/media ingest, chunk+embed, semantic search, Drive import | 50-page PDF searchable in < 2 min; transcript for 10-min Telugu video; SSRF tests pass | 6–8 ew |
| 4 Strategy & Campaigns ✅ scaffolded (docs/12) | 2, 3 | 90-day plan, weekly plans, campaigns, topics, schedule generation | Every generated field editable; pause/resume/cancel reflect in Temporal within 5 s | 5–6 ew |
| 5 Content engine ✅ scaffolded (docs/13) | 2–4, ComfyUI | All generation types, editors, validation, versions, approvals, bulk regen | Schema-valid 100%; validators block publish; selective regen preserves human spans (tested) | 10–14 ew |
| 6 Media & video ✅ scaffolded (docs/14) | 1, 5, FFmpeg | Library, collections, URL import, timeline editor, render | 60-s 1080p render < 2 min on GPU node; exports per platform preset | 8–10 ew |
| 7 Publishing & calendar ✅ scaffolded (docs/15) | 5, Postiz | Workspace↔Postiz provisioning, connected accounts, approval gate, scheduling, retries, GBP, WP | Sandbox publish to each enabled channel; failure surfaces in < 1 min; no publish without approval | 6–8 ew |
| 8 Analytics & learning ✅ scaffolded (docs/16) | 7, Matomo, Mautic | Warehouse, dashboards, insights, learning signals, Langfuse evals | Metrics within 2 h of platform availability; learning proposals require approval | 6–8 ew |
| 9 Growth suite ✅ scaffolded (docs/17) | 5 | Wizards, repurposing one→many | One video → ≥ 6 channel assets with source attribution | 5–7 ew |
| 10 SaaS commercial ✅ scaffolded (docs/18) | 1, Lago (+ payment provider in Lago) | Plans, checkout, top-ups, invoices, entitlement enforcement | Upgrade/downgrade/cancel/reactivate E2E in Stripe test mode; ledger reconciles with Lago | 4–6 ew |
| 11 Advanced growth ✅ scaffolded (docs/19) | 5, 8, Ads SDKs | SEO/AEO, competitor research, Meta/Google Ads (approval-gated) | No ad spend action without explicit approval + budget cap; sandbox campaign created | 8–12 ew |
| 12 Services & mobile ✅ scaffolded (docs/20) | 5, 7 | Human-finished service workflow, PWA approvals | Request→delivery→billing loop on staging (`scripts/e2e/services-staging.ts` all green); PWA criteria in docs/21 §3 (manifest + icons valid, SW active and controlling, Chrome fires `beforeinstallprompt`, offline fallback, cache holds build assets only) checked on Chrome desktop and Android Chrome over HTTPS | 4–6 ew |

**Critical path**: 1 → 2 → 5 → 7 → 8. Platform app reviews (Meta, TikTok, LinkedIn, YouTube) must be **submitted during Phase 2** because approvals take weeks.
