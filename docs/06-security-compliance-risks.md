# 06 — Security, Privacy, Compliance & Risk Register

## 1. Security controls
| Area | Control |
|---|---|
| Tenant isolation | RLS on every tenant table via `is_workspace_member(ws)` / `has_permission(ws, perm)`; service-role code always filters by `workspace_id`; automated RLS test suite (`supabase/tests/rls.test.sql`) asserts cross-tenant reads return 0 rows. |
| AuthN | Supabase Auth (email magic link, Google). MFA available; required for owners on Agency+. |
| API keys | `ak_live_<id>.<secret>`; only SHA-256 stored; scopes; last-used tracking; revoke. |
| Secrets for third parties | OAuth tokens held by Postiz. Tokens Arcatic must hold are AES-256-GCM encrypted by the app (`ENCRYPTION_KEY`, AAD-bound to workspace + purpose) — never in plain columns. Short-lived import tokens (Google Drive) live in `ephemeral_secrets` ≤55 min and never enter Temporal history. |
| SSRF | URL imports (image URLs, crawl seeds) go through `packages/core/src/url-safety.ts`: scheme allow-list, DNS resolve + block private/link-local/metadata IPs, size + content-type caps, redirect re-check on every hop (`apps/api/src/safe-fetch.ts`). Residual DNS-rebinding window → production egress proxy blocks private ranges. |
| Uploads | Magic-byte type detection (`core/knowledge/files.ts`), SVG refused, size caps (bucket 500 MB, image import 20 MB, Drive 50 MB). Still to add: image re-encode and AV scan (ClamAV) before public launch. |
| Internal services | Firecrawl, Langflow, ComfyUI, Docling, Postiz admin: private network only; mTLS or shared secret headers. Firecrawl default is unauthenticated → never exposed. |
| Prompt injection | Retrieved content is wrapped as data with delimiters; tools available to models are read-only; no model output triggers publishing without human approval. |
| Audit | `audit_logs` for auth, role changes, key changes, approvals, publish, billing, data export/delete. Append-only (no UPDATE/DELETE policies). |
| Observability | Structured JSON logs w/ `request_id`, `workspace_id`; Sentry for errors; Langfuse for AI; Temporal UI for workflows. PII redaction in logs. |

## 2. Privacy
- Data map: users (email, name), customer knowledge (may contain PII), analytics (aggregates; no end-user PII from platforms stored beyond what APIs return).
- India **DPDP Act 2023** + **GDPR** readiness: purpose limitation, data-principal requests (export/delete via `/settings/privacy`), sub-processor list, DPA.
- Retention: deleted workspaces purged after 90 days (storage + vectors + Langfuse traces by `workspace_id`).
- Model providers: zero-retention / no-training settings where offered; disclosed in sub-processor list.

## 3. Platform policy
- Publishing only via official APIs (through Postiz providers); no scraping of social platforms for posting or analytics.
- Each platform app needs its own review (Meta App Review, TikTok audit for direct post, YouTube quota, LinkedIn Marketing Developer Platform, X paid tier). Track status per platform in `docs/platforms.md` (Phase 7).
- AI-generated content labels where platforms require (Meta/TikTok/YouTube "altered or synthetic" disclosures) → `content_items.ai_disclosure_required` set by validator.
- Scraping: Firecrawl only on URLs the workspace asserts it owns or has rights to analyse; respect robots.txt; per-domain rate limits; competitor analysis restricted to public pages, no login walls.

## 4. Risk register
| ID | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | Platform API access denied / revoked (Meta, TikTok, X pricing) | High | High | Launch with channels where Postiz provider + our app approval are confirmed; feature-flag per channel; graceful "export & post manually" fallback | Integrations |
| R2 | Rate limits / quota exhaustion (YouTube 10k units/day, X tiers) | High | Med | Per-account token buckets in `publishing_jobs`, backoff on 429, quota dashboard | Integrations |
| R3 | Publishing failure silently loses a post | Med | High | Publish workflow polls final status; failures surface on calendar + notification; retries w/ jitter; manual retry button | Integrations |
| R4 | AGPL contamination (Postiz/Firecrawl/Lago) | Med | High | Services isolated; no code import; published fork for any patch; licence check in CI (`license-checker` on our packages) | Eng lead |
| R5 | Model licence violation (non-commercial weights) | Med | High | `ai_models.license_commercial` flag; ComfyUI workflows reference registry ids; CI rejects unknown models | AI |
| R6 | Harmful / off-brand / false content published | Med | High | Deterministic validators + approval required before publish; claims must cite sources; content safety classifier | AI |
| R7 | Cross-tenant data leak | Low | Critical | RLS tests in CI; service-role code review rule; pen test pre-launch | Security |
| R8 | Scraping complaints / ToS breach | Med | Med | Ownership attestation, robots respect, crawl budgets, takedown process | Legal |
| R9 | Credit ledger drift (double charge / free work) | Med | High | Idempotent SQL functions, reservations with TTL, nightly reconciliation job vs. `usage_events` | Billing |
| R10 | GPU cost blow-up | Med | High | Per-plan GPU-second quotas, queue priorities, autoscale caps, reserve-before-run | Infra |
| R11 | Personal data in knowledge sources | Med | Med | PII detection on ingest (flag, not block), DSAR tooling, retention | Privacy |
| R12 | Postiz single-tenant assumptions (org provisioning gap) | High | Med | Provisioning service; evaluate upstream PR; fallback direct adapters for top 3 channels | Integrations |
| R13 | Prompt injection via crawled pages | Med | Med | Data delimiting, no tool side-effects, output validation | AI |
| R14 | Vendor lock on single LLM provider | Low | Med | `packages/ai` provider interface; eval suite runs across providers | AI |
| R15 | Unintended ad spend (wrong budget, runaway campaign, duplicate creation) | Med | High | Management off per account until an owner opts in; typed approvals checked in the DB (revision, limit, phrase, second person); created PAUSED; atomic / name-idempotent creation; currency guard; monthly cap auto-pause; pause always allowed; audit (docs/19) | Integrations |
| R17 | Service staff over-reach into customer data | Med | High | Staff aren't workspace members; RLS limits specialists to assigned requests (frozen brief, intake, linked files); managers see submitted requests only; short-lived signed links; internal notes DB-checked; audit; staff added only via admin token (docs/20) | Security |
| R18 | Sensitive data cached on phones | Med | Med | Service worker caches only build assets and the offline page; API, pages and media URLs never cached (docs/20) | Security |
| R16 | Ad policy violations (personal attributes, special categories, political ads, unsupported claims) | Med | Med | Deterministic pre-check blocks the clear cases (personal attributes, political, special-category targeting) and flags claims for the approver; platforms' own review still applies | AI |
