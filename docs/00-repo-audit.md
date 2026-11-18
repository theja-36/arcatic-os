# 00 — Repository Audit & Integration Matrix

Audited: 2026-11-17, from the source trees in `/Users/sara/Downloads/arcatic marketing/`.
Everything below is taken from files in those folders (LICENSE, compose files, controllers, provider folders).
Where a claim could not be verified from source it is marked **UNVERIFIED**.

## 1. Inventory

| # | Folder | What it actually is | License (from LICENSE file) |
|---|---|---|---|
| 1 | `ComfyUI-master` | Node-graph diffusion engine (Python). HTTP API: `/api/prompt`, `/api/queue`, `/api/jobs/{id}`, `/api/jobs/{id}/cancel`, `/api/history`, `/api/assets/*`, `/api/object_info`, websocket progress. | **GPL-3.0** |
| 2 | `FFmpeg-master` | Media decode/encode/filter toolkit (C). | **LGPL-2.1+** by default; **GPL** if built with `--enable-gpl` components (x264 etc.) |
| 3 | `docling-main` | Document → structured text/Markdown/JSON (PDF, DOCX, PPTX, HTML, images). Contains `docling`, `docling-slim`, `docling-client` (client for a remote **Docling Serve**). v2.150.1, Python ≥3.10. | MIT |
| 4 | `fabric.js-master` | Browser/Node canvas object model (text, images, groups, SVG/JSON export). | MIT |
| 5 | `facebook-python-business-sdk-main` | Meta Marketing API SDK (Python). `API_VERSION = v26.0`. Campaign/AdSet/Ad/Creative/Insights/Custom Audience objects. | Meta platform license (permissive, restricted to use with Meta platform) |
| 6 | `firecrawl-main` | Scrape/crawl/map/extract API + SDKs (JS, Python, Go, …). Self-host compose: API+workers, Playwright, Redis, RabbitMQ, NuQ Postgres, FoundationDB (optional). API on :3002. | **AGPL-3.0** (SDKs under `apps/*-sdk` are MIT per upstream — **verify per SDK folder before vendoring**) |
| 7 | `google-ads-python-main` | Google Ads API client library v35.1.0, API versions v23–v25. | Apache-2.0 |
| 8 | `lago-main` | Usage-based billing/metering. **`api/` and `front/` are empty git submodules in this checkout** — only compose, docs, `events-processor` (Go) present. Runs from images `getlago/api:v1.57.0`, `getlago/front:v1.57.0`, Postgres (partman), Redis, Gotenberg (PDF). | **AGPL-3.0** |
| 9 | `langflow-main` | Visual LLM workflow builder (Python/React). REST: `POST /api/v1/run/{flow_id_or_name}`, flows, files, API keys, MCP, A2A, authz. | MIT |
| 10 | `langfuse-main` | LLM observability: traces, prompt mgmt, evals, cost. Compose: web, worker, ai-gateway, ClickHouse, MinIO, Redis, Postgres. | MIT core; `ee/` dirs commercial |
| 11 | `matomo-6.x-dev` | Web analytics (PHP ≥8.1). Tracking API + HTTP Reporting API. | **GPL-3.0** |
| 12 | `mautic-7.x` | Marketing automation + email (PHP, Symfony). REST via `ApiBundle` (OAuth2/Basic). | **GPL-3.0** |
| 13 | `payload-main` | Next.js-native headless CMS (TypeScript). | MIT |
| 14 | `postiz-app-main` | Social scheduler (NestJS backend, Next frontend, Temporal orchestrator). 36 provider files. Public API (per-org API key in `Authorization` header). | **AGPL-3.0** |
| 15 | `sdk-typescript-main` | **Temporal** TypeScript SDK (client, worker, workflow, activity). Node 20/22/24. | MIT |
| 16 | `Arcatic marketingos ` | Empty folder (name ends with a space). Not used; the monorepo is `arcatic-os/` to avoid path-quoting bugs. | — |

### Not present in the folder (spec mentions them)
Supabase, Whisper, listmonk, LangGraph, TipTap, GrapesJS, shadcn/ui. Supabase/TipTap/GrapesJS/shadcn are pulled as npm/CLI deps. **Whisper**: use `faster-whisper` or `whisper.cpp` as a separate service (decision in Phase 3). **LangGraph** is replaced by **Temporal** (present, and already required by Postiz — one durable-workflow engine instead of two). **listmonk**: Postiz has a `listmonk.provider.ts`, but the listmonk server itself is absent; **Mautic** is the email engine of record.

## 2. Per-repo detail

### ComfyUI (GPL-3.0)
- **Self-host**: Python 3.10+, PyTorch, NVIDIA GPU (≥12 GB VRAM for SDXL-class; more for video). Model folders: `checkpoints, loras, vae, diffusion_models, text_encoders, controlnet, upscale_models, background_removal, …`.
- **API**: `POST /api/prompt` (workflow JSON) → job; `GET /api/jobs/{id}`, `POST /api/jobs/{id}/cancel`, `GET /api/jobs/{id}/assets`, websocket for progress.
- **Limits/risks**: no multi-tenant auth — must sit on a private network behind `apps/worker`. Model weights carry their *own* licences (SDXL OpenRAIL, Flux-dev non-commercial, etc.) — tracked per model in `ai_models` registry (Phase 5).
- **Role**: image/video generation backend only. Templates, text layout, logo placement and brand validation are Arcatic code (Fabric.js + `packages/core`).
- **Licence posture**: run as a separate unmodified process over HTTP; no linking.

### FFmpeg (LGPL/GPL)
- **Role**: transcoding, audio extraction for Whisper, thumbnailing, final video render.
- **Posture**: invoke as a CLI binary in the worker container; ship an LGPL build unless an H.264 encoder (x264, GPL) is needed — then the worker image is GPL and is not distributed to customers (SaaS use only).

### Docling (MIT)
- **Role**: PDF/DOCX/PPTX/HTML/TXT/CSV → Markdown/JSON for the knowledge pipeline.
- **Deploy**: Docling Serve container; call via HTTP (`DOCLING_SERVICE_URL`). CPU works; GPU speeds OCR/layout.
- **Gap**: Docling Serve repo is not in the folder; the client README documents it. Image tag to be pinned at Phase 3.

### Fabric.js (MIT)
- **Role**: visual post composer (Phase 5), also server-side render via `index.node.ts` (node-canvas) for headless export.
- **Custom**: brand templates, safe-zones, logo placement, contrast checks, export presets.

### Meta Business SDK (Python, v26.0)
- **Role**: Phase 11 ads module (campaigns, ad sets, creatives, insights). Python → runs in a small `ads-service` (FastAPI) or we call Graph API from TS directly. Decided in Phase 8/11: the Python `services/ads-sync` sidecar (stdlib HTTP server) wraps the official SDK; see docs/19.
- **Risk**: App Review + `ads_management` permission; Business Verification required.

### Google Ads Python (Apache-2.0, v35.1.0, API v23–v25)
- **Role**: Phase 11 ads module + reporting. Requires developer token (Basic access approval), OAuth, MCC.

### Firecrawl (AGPL-3.0)
- **Role**: URL scrape, crawl, map, structured extract (Phase 2/3).
- **`branding` scrape format** (verified in `controllers/v2/types.ts`, `types/branding.ts`): returns colours, fonts, logo, typography. Self-hosted it needs a TypeSafe key (proprietary "Jev" engine) or Firecrawl's LLM fallback configured — so Arcatic uses it only as an optional enrichment and always runs its own deterministic HTML colour/font/logo extraction.
- **Self-host**: unauthenticated by default (`USE_DB_AUTHENTICATION=false`) → **must be private-network only**. AI extract needs an OpenAI-compatible model configured. Compose has no persistent volumes.
- **Licence posture**: run unmodified as a network service. If we modify it, we must publish those modifications (AGPL §13).

### Lago (AGPL-3.0)
- **Role**: subscription plans, metered usage events, invoices, payment-provider (Stripe) connection.
- **Gap in folder**: Rails API source missing (empty submodule). Use pinned images `v1.57.0`; API contract taken from Lago public docs at implementation time — **UNVERIFIED from local source**.
- **Arcatic owns**: credit ledger, reservations, refunds, entitlements (Lago is never on the hot path of a generation request).

### Langflow (MIT)
- **Role**: authoring + hosting reusable *stateless* LLM chains (brand extraction, caption variants, repurposing prompts). Called via `POST /api/v1/run/{flow}`.
- **Not used for**: long-running/stateful jobs, credit handling, tenancy — those are Temporal + Postgres.
- **Risk**: flows can execute arbitrary Python components → Langflow instance is internal-only, custom components disabled in prod, flows promoted via export/import from Git.

### Langfuse (MIT core)
- **Role**: trace every model call (prompt version, model, tokens, cost, latency), datasets + evals for prompt regression.
- **Posture**: do not enable `ee/` features without a licence.

### Matomo (GPL-3.0)
- **Role**: optional first-party web analytics for customers who don't use GA4. Reporting API pull into `analytics_events`.
- **Multi-tenancy**: one Matomo "site" per brand domain; token per workspace.

### Mautic (GPL-3.0)
- **Role**: email campaigns, segments, sends, opens/clicks (Phase 7/8).
- **Multi-tenancy gap**: Mautic is single-tenant. Options: (a) one Mautic instance per paying workspace (costly), (b) shared instance with segment/tag isolation (weak isolation — rejected), (c) start with transactional ESP (SES/Postmark) + Arcatic-native campaign sender and add Mautic for agencies. **Decision proposed: (c) for MVP-plus, (a) for Agency plan.**

### Payload CMS (MIT)
- Not in the recommended architecture. **Proposed role**: Arcatic's own marketing site/blog and an internal template-library admin. **Not** the product backend (Supabase is). Optional; can be dropped.

### Postiz (AGPL-3.0)
- **Verified public API (`apps/backend/src/public-api/routes/v1/public.integrations.controller.ts`)**:
  `POST /upload`, `POST /upload-from-url`, `GET /find-slot/:id`, `GET|POST /posts`, `DELETE /posts/:id`, `DELETE /posts/group/:group`, `GET /integrations`, `GET /social/:integration` (OAuth URL), `POST /integrations/connect` (Postiz-hosted connect page), `DELETE /integrations/:id`, `GET /integration-settings/:id`, `PUT /posts/:id/settings|status|release-id`, `GET /analytics/:integration`, `GET /analytics/post/:postId`, `GET /media`, `GET /notifications`.
  Auth: org API key (or OAuth token) in `Authorization` header (`public.auth.middleware.ts`).
- **Providers present**: X, LinkedIn (+Page), Facebook, Instagram (+standalone), Threads, TikTok (+business), YouTube, Pinterest, Reddit, GMB, WordPress, Medium, Dev.to, Hashnode, Mastodon, Bluesky, Telegram, Discord, Slack, Twitch, Kick, VK, Lemmy, Nostr, Farcaster, Dribbble, Tumblr, Listmonk, Skool, Whop, MeWe, Moltbook.
- **Analytics implemented in**: Facebook, Instagram (both), LinkedIn Page, Threads, TikTok (both), X, YouTube, Pinterest, GMB, Dribbble. *No analytics* for LinkedIn personal, WordPress, Reddit, etc.
- **Gaps**:
  1. **Org provisioning** isn't in the public API (`/users` is SuperAdmin). Arcatic needs one Postiz org per workspace → provision via Postiz signup flow automation or a small upstream-able patch (published per AGPL).
  2. Postiz holds platform OAuth tokens; Arcatic stores only the Postiz integration id + status mirror.
  3. Requires its own Temporal + Postgres + Redis (can share our Temporal cluster with a separate namespace).
- **Spec says** GMB and WordPress need separate adapters: Postiz *does* have `gmb.provider.ts` and `wordpress.provider.ts`. We still wrap them behind our own `PublishingAdapter` so they can be swapped; first implementation delegates to Postiz, with a direct WordPress REST adapter as fallback.

### Temporal TS SDK (MIT)
- **Role**: durable, retryable, cancellable workflows for crawl, ingest, transcribe, generate, render, publish, analytics sync, learning. Worker in `apps/worker`.
- Server: `temporalio/auto-setup` locally; Temporal Cloud or self-hosted cluster in prod.

## 3. Integration matrix — feature → foundation → what stays custom

| Feature | Foundation (repo) | Custom Arcatic work |
|---|---|---|
| Auth, users, sessions | Supabase Auth (external) | Org/workspace model, invites, roles, API keys |
| Multi-tenant data | Supabase Postgres + RLS | Entire schema, RLS policies, audit log |
| Vector search | pgvector | Chunking, embedding jobs, retrieval ranking, citation |
| File storage | Supabase Storage | Path conventions per workspace, signed URLs, URL-import safety (SSRF guard) |
| Durable jobs | **Temporal** (sdk-typescript) | Workflow defs, job table mirror, progress, cancellation, credit hooks |
| URL scrape/crawl/extract | **Firecrawl** | robots/ToS policy, per-workspace quotas, page classifier (about/pricing/FAQ…), Brand Kit extraction |
| Document parsing | **Docling** (Serve) | Cleaning, chunking, metadata |
| Transcription | Whisper (*not in folder*) + **FFmpeg** | Service wrapper, language detect (Telugu/English) |
| Prompt chains | **Langflow** | Brand Context compiler, structured output schemas, validators |
| AI provider calls | Anthropic / other SDKs | `packages/ai` provider abstraction, cost table |
| AI tracing/evals | **Langfuse** | Eval datasets, scorecards, prompt-version linkage to `content_versions` |
| Image/video gen | **ComfyUI** | Workflow templates, model registry + licence flags, GPU queue, safety filter |
| Visual composer | **Fabric.js** | Templates, brand rules, export presets |
| Video editor | **FFmpeg** | Timeline model, browser preview, render graph → ffmpeg args |
| Social publishing | **Postiz** | Workspace↔org mapping, approval gate, validation, retry policy, calendar |
| GBP / WordPress | Postiz providers (verified present) | Wrapper adapter + direct WP REST fallback |
| Email | **Mautic** (agency) / ESP (default) | Email editor (GrapesJS), list mgmt, metrics sync |
| Web analytics | **Matomo** / GA4 API | Normalised warehouse, rollups |
| Social analytics | Postiz `/analytics/*` (12 providers) | Normalisation, gaps for providers without analytics |
| Ads | **Meta SDK**, **Google Ads SDK** | Approval-gated ads module, budget caps, compliance checks |
| Billing | **Lago** + Stripe | Credit ledger, reservations, entitlements, top-ups |
| CMS / marketing site | **Payload** (optional) | — |

## 4. Licence summary & obligations

| Licence | Repos | Obligation for a SaaS |
|---|---|---|
| AGPL-3.0 | Postiz, Firecrawl, Lago | Run as separate services. Any modification we deploy must be published to users of that service. **Never import their code into Arcatic packages.** |
| GPL-3.0 | ComfyUI, Matomo, Mautic | Separate processes over HTTP. Distribution-triggered; SaaS use OK; don't link into our code. |
| LGPL/GPL | FFmpeg | CLI invocation; prefer LGPL build. |
| MIT/Apache | Docling, Fabric.js, Langflow, Langfuse core, Payload, Temporal SDK, Google Ads | Attribution in NOTICE. |
| Meta platform | Meta SDK | Use only with Meta platform; follow Platform Terms. |
| Model weights | via ComfyUI | Per-model licence registry; block non-commercial models on paid plans. |
