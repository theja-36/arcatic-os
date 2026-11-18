# Arcatic Marketing OS

Multi-tenant, AI-powered marketing operating system: brand intelligence → knowledge → strategy → campaigns → content → review → publishing → analytics → learning.

**Status: Phases 0–12 scaffolded** — audit + blueprint, platform foundation, onboarding & Brand Intelligence ([docs/10](docs/10-phase2-brand-intelligence.md)), Knowledge OS ([docs/11](docs/11-phase3-knowledge.md)), Strategy & campaigns ([docs/12](docs/12-phase4-strategy-campaigns.md)), content engine ([docs/13](docs/13-phase5-content-engine.md)), media workspace & video editor ([docs/14](docs/14-phase6-media-video.md)), publishing & calendar ([docs/15](docs/15-phase7-publishing.md)), analytics & learning ([docs/16](docs/16-phase8-analytics.md)), growth suite ([docs/17](docs/17-phase9-growth.md)), SaaS commercial layer ([docs/18](docs/18-phase10-commercial.md)), SEO/AEO research & approval-gated Google/Meta ads ([docs/19](docs/19-phase11-advanced-growth.md)), human-finished services & mobile PWA ([docs/20](docs/20-phase12-services-mobile.md)). All planned phases are scaffolded — see [docs/09-build-plan.md](docs/09-build-plan.md) for what each still needs before launch.

## Docs
| # | Document |
|---|---|
| 00 | [Repository audit & integration matrix](docs/00-repo-audit.md) |
| 01 | [Architecture, monorepo, job/queue architecture](docs/01-architecture.md) |
| 02 | [PRD, information architecture, screens](docs/02-prd-and-ia.md) |
| 03 | [API specification](docs/03-api-spec.md) |
| 04 | [AI workflow specifications](docs/04-ai-workflows.md) |
| 05 | [Credits & billing model](docs/05-credits-billing.md) |
| 06 | [Security, privacy, compliance, risk register](docs/06-security-compliance-risks.md) |
| 07 | [Testing plan](docs/07-testing-plan.md) |
| 08 | [Deployment & environment variables](docs/08-deployment.md) |
| 09 | [Phased build plan](docs/09-build-plan.md) |
| 10 | [Phase 2: Onboarding & Brand Intelligence](docs/10-phase2-brand-intelligence.md) |
| 11 | [Phase 3: Knowledge OS](docs/11-phase3-knowledge.md) |
| 12 | [Phase 4: Strategy & campaign engine](docs/12-phase4-strategy-campaigns.md) |
| 13 | [Phase 5: Content creation engine](docs/13-phase5-content-engine.md) |
| 14 | [Phase 6: Media workspace & video editor](docs/14-phase6-media-video.md) |
| 15 | [Phase 7: Publishing & calendar](docs/15-phase7-publishing.md) |
| 16 | [Phase 8: Analytics & learning](docs/16-phase8-analytics.md) |
| 17 | [Phase 9: Growth suite](docs/17-phase9-growth.md) |
| 18 | [Phase 10: SaaS commercial layer](docs/18-phase10-commercial.md) |
| 19 | [Phase 11: SEO/AEO & ads](docs/19-phase11-advanced-growth.md) |
| 20 | [Phase 12: Services & mobile](docs/20-phase12-services-mobile.md) |
| 21 | [Phase 12 hardening & launch verification](docs/21-phase12-launch-verification.md) |

Database schema + RLS: [`supabase/migrations/`](supabase/migrations).

## Layout
```
apps/web          Next.js 15 PWA (sign-in, onboarding, workspace shell, brands, team, API keys, activity, credits)
apps/api          Hono REST API (/v1): JWT or API-key auth, RBAC, idempotent job starts, credit reservation
apps/worker       Temporal worker
packages/core     RBAC, validators (banned words, platform limits, claims), Brand Context compiler, SSRF guard, cost model
packages/database Supabase clients, ledger + job repositories
packages/ai       LLM provider interface, Anthropic adapter, prompt templates, generation runner
packages/integrations  Postiz, Firecrawl, ComfyUI, Langflow clients (verified routes) + interfaces for unverified services
packages/jobs     Temporal workflows/activities, job starter
packages/ui       Design tokens + React primitives
supabase/         migrations, config, smoke tests
infrastructure/   docker-compose (profiles), env templates
```

## Run locally
```bash
cp .env.example .env            # fill in values printed by `supabase start`
pnpm install
pnpm dlx supabase start
pnpm dlx supabase db reset      # applies migrations
pnpm infra:core                 # Temporal on :7233, UI on :8233
pnpm dev                        # web :3000 · api :4000 · worker
```
Website analysis also needs Firecrawl (`docker compose -f ../firecrawl-main/docker-compose.yaml up -d`) and `ANTHROPIC_API_KEY` for the worker. Knowledge ingestion adds Docling, embeddings (TEI + bge-m3) and Whisper: `docker compose -f infrastructure/docker-compose.yml --profile ingest up -d`, plus `ffmpeg` on the worker host.

Sign in with a magic link (Supabase local inbox at http://127.0.0.1:54324), create a workspace, then press **Run system check** on Home to push a job through API → Temporal → worker → Postgres → live UI.

## Checks
```bash
pnpm typecheck
pnpm test        # core, ai, integrations, database, jobs (Temporal test server), api
```
Database (plain Postgres + pgvector, no Supabase needed):
```bash
docker run -d --rm --name arcatic-pgtest -e POSTGRES_PASSWORD=pg -p 55432:5432 pgvector/pgvector:pg17
# then apply supabase/tests/smoke/00_supabase_stub.sql, every migration, and 10_rls_smoke.sql (see .github/workflows/ci.yml)
```

## Licence boundaries
Postiz, Firecrawl and Lago are AGPL-3.0; ComfyUI, Matomo and Mautic are GPL-3.0. They run as **separate, unmodified services** reached over HTTP; no code from them is imported into this repo. See [docs/00](docs/00-repo-audit.md#4-licence-summary--obligations).
