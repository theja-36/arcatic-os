# 03 — API Specification (v1)

Base: `https://api.arcatic.app/v1` · JSON · OpenAPI generated from zod schemas (`apps/api/src/openapi.ts`).

## Conventions
- **Auth**: `Authorization: Bearer <supabase_jwt>` **or** `Authorization: Bearer ak_live_<id>.<secret>` (workspace API key, scoped).
- **Tenancy**: every resource path is under `/workspaces/:workspaceId`; the API verifies membership + permission before touching data; RLS re-checks.
- **Idempotency**: all `POST` that create jobs or move credits require `Idempotency-Key` (stored 24 h in `idempotency_keys`).
- **Async**: long work returns `202 { job: { id, status, kind } }`; poll `GET /jobs/:id` or subscribe to Realtime `job_events`.
- **Errors**: `{ error: { code, message, details?, request_id } }` with codes `unauthenticated, forbidden, not_found, validation_failed, conflict, insufficient_credits, rate_limited, plan_limit, upstream_error, internal`.
- **Pagination**: cursor (`?cursor=&limit=`), response `{ data, next_cursor }`.
- **Rate limits**: per API key / user: 600 req/min read, 60 req/min write, 10 generation starts/min (plan-dependent). Headers `RateLimit-*`.

## Phase 1 endpoints (implemented in scaffold)
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/me` | auth | profile + memberships |
| POST | `/organizations` | auth | creates org + first workspace + owner membership + wallet |
| GET | `/workspaces` | auth | workspaces for current user |
| GET | `/workspaces/:ws` | `workspace.read` | |
| PATCH | `/workspaces/:ws` | `workspace.update` | |
| GET | `/workspaces/:ws/members` | `member.read` | |
| POST | `/workspaces/:ws/invites` | `member.invite` | email, role; cannot grant above own role |
| PATCH | `/workspaces/:ws/members/:userId` | `member.update` | last-owner guard |
| DELETE | `/workspaces/:ws/members/:userId` | `member.remove` | |
| GET/POST | `/workspaces/:ws/brands` | `brand.read` / `brand.create` | plan limit `max_brands` |
| GET/PATCH/DELETE | `/workspaces/:ws/brands/:brandId` | `brand.*` | soft delete |
| GET/POST | `/workspaces/:ws/api-keys` | `apikey.manage` | secret returned once; stored as SHA-256 |
| DELETE | `/workspaces/:ws/api-keys/:id` | `apikey.manage` | revoke |
| POST | `/workspaces/:ws/media/upload-url` | `media.create` | returns signed upload URL + `media_assets` row (pending) |
| GET | `/workspaces/:ws/jobs` | `job.read` | filters: kind, status |
| GET | `/workspaces/:ws/jobs/:id` | `job.read` | includes events |
| POST | `/workspaces/:ws/jobs/:id/cancel` | `job.cancel` | |
| GET | `/workspaces/:ws/credits` | `billing.read` | balance, held, available |
| GET | `/workspaces/:ws/credits/transactions` | `billing.read` | ledger |
| POST | `/workspaces/:ws/credits/estimate` | `content.create` | `{ kind, params }` → `{ credits }` |
| GET | `/workspaces/:ws/audit-logs` | `audit.read` | |
| GET | `/health` | none | liveness; `/health/ready` checks DB + Temporal |

## Later-phase endpoints (contract only)
| Area | Endpoints |
|---|---|
| Brand Kit (P2) — **implemented**, see docs/10 | `GET/PUT /brands/:id/onboarding`, `POST /brands/:id/kit/analyze-website`, `GET /brands/:id/kit`, `POST /brands/:id/kit/ops`, `GET /brands/:id/kit/versions[/:v]`, `POST /brands/:id/kit/versions/:v/{approve,restore}`, `GET /brands/:id/kit/impact`, `GET /brands/:id/context` |
| Knowledge (P3) — **implemented**, see docs/11 | `GET/POST /brands/:id/sources` (`type: url|crawl|file|text|media|social_reference`), `POST /brands/:id/sources/drive`, `GET/PATCH/DELETE /brands/:id/sources/:sid`, `POST /brands/:id/sources/:sid/refresh`, `POST /brands/:id/knowledge/search` |
| Strategy (P4) — **implemented**, see docs/12 | `GET/POST /brands/:id/strategies`, `GET /strategies/:sid`, `PUT /strategies/:sid/plan`, revisions, `POST /strategies/:sid/{activate,archive,weekly-plan}` |
| Campaigns (P4) — **implemented** | `GET/POST /brands/:id/campaigns`, `GET/PATCH /campaigns/:cid`, `POST /campaigns/:cid/{start,pause,resume,cancel,complete}`, topics CRUD + bulk + `POST /topics/:tid/generate`, `GET /brands/:id/plan`, `/seasonal-events` |
| Content (P5) | `POST /brands/:id/generations` (job), CRUD `/content/:id`, `GET /content/:id/versions`, `POST /content/:id/{improve,regenerate,validate,submit-for-approval}`, `POST /content/bulk-regenerate` |
| Approvals | `POST /approvals/:id/{approve,reject,request-changes}`, `POST /content/:id/review-links` |
| Media (P3 + P6) — **implemented**, see docs/14 | `GET /media` (`collectionId`, `source`, `tag`, `q`, `kind`), `POST /media/upload-url` (`collectionId?`), `POST /media/finalize`, `POST /media/import-url`, `POST /media/import-drive`, `GET /media/:id/url[?poster=1]`, `PATCH/DELETE /media/:id`, `POST /media/:id/replace[/finalize]`, `POST /media/move`, `GET/POST /media/collections`, `PATCH/DELETE /media/collections/:id` |
| Video (P6) — **implemented**, see docs/14 | `GET/POST /brands/:id/video-projects`, `GET/DELETE /video-projects/:pid`, `PUT /video-projects/:pid/timeline`, `POST /video-projects/:pid/render` (job), `POST /video-projects/:pid/send-to-content` |
| Publishing (P7) — **implemented**, see docs/15 | `/publishing/connections[/postiz\|/mautic]`, `/connected-accounts` (+ `/sync`, `/connect`, `/wordpress`, `/:id`, `/:id/wordpress-terms`), `/brands/:id/content/:cid/{publish-options,publish/preview,publish}`, `/brands/:id/schedules[/:sid][/cancel\|/retry\|/attempts]`, `GET /brands/:id/calendar?from&to` |
| Analytics (P8) — **implemented**, see docs/16 | `/analytics/connections[/matomo\|/google-ads\|/meta-ads\|/:id]`, `/analytics/sync`, `/analytics/sync-runs`, `/brands/:id/analytics/{overview,breakdown}`, `/brands/:id/insights[/refresh\|/:iid/{accept,dismiss,applied}]`, `/brands/:id/learning`, `/brands/:id/content/:cid/feedback` |
| Growth (P9) — **implemented**, see docs/17 | `/brands/:id/projects[/:pid]`, `PUT /brands/:id/content/:cid/project`, `/brands/:id/repurpose[/options\|/estimate\|/:runId]`, `POST /brands/:id/content/:cid/ideas/drafts`; `POST /brands/:id/content` accepts `projectId` |
| Billing (P10) — **implemented**, see docs/18 | `GET /billing`, `GET /billing/usage`, `POST /billing/{plan,cancel,reactivate,payment-method,topups}`, `GET /billing/portal`; staff: `POST /admin/workspaces/:ws/credits/{refund,adjust}` |
| SEO (P11) — **implemented**, see docs/19 | `/brands/:id/seo/keyword-sets[/:sid]`, `/brands/:id/seo/competitors[/:cid][/analyze]`, `POST /brands/:id/seo/articles`, `GET/PUT /brands/:id/content/:cid/seo`, `POST /brands/:id/content/:cid/seo/analyze` |
| Ads (P11) — **implemented**, approval-gated, see docs/19 | `GET /ads/accounts`, `PUT /ads/accounts/:conn/policy`, `GET /ads/accounts/:conn/search`, `/brands/:id/ads/campaigns[/:id][/check\|/draft\|/actions\|/report]`, `POST /brands/:id/ads/promote`, `GET /brands/:id/ads/requests`, `POST /brands/:id/ads/requests/:aid/{decide,cancel}` |
| Services (P12) — **implemented**, see docs/20 | `GET /services/offerings`, `/brands/:id/services[/:rid]` (GET/POST/PATCH), `POST /brands/:id/services/:rid/{submit,cancel,messages,approve,revise}`; staff: `/v1/desk/{me,requests[/:rid],staff}`, `POST /v1/desk/requests/:rid/{assign,unassign,start,files,files/confirm,submit,qa,messages}`, `PUT /v1/desk/requests/:rid/deliverable`; admin: `PUT /admin/service-staff` |
| Mobile (P12) — **implemented** | `GET /inbox`, `GET /agenda`, `GET /publishing/status`, `GET /quick-create/options`; `GET /v1/me/notifications`, `POST /v1/me/notifications/read`, `POST/DELETE /v1/me/devices` |
| Webhooks in | `POST /webhooks/lago` (HMAC, implemented); payments arrive through Lago's provider integration, so there is no separate Stripe webhook |
| Webhooks out | workspace-configurable: `job.completed`, `content.approved`, `post.published`, `post.failed` |
