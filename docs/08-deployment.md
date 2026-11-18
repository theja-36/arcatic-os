# 08 — Deployment Plan & Environment Variables

## Local
```bash
pnpm install
pnpm dlx supabase start                      # Postgres+Auth+Storage+Realtime on :54321/:54322
pnpm dlx supabase db reset                   # applies supabase/migrations + seed.sql
docker compose -f infrastructure/docker-compose.yml --profile core up -d   # Temporal + UI
pnpm dev                                     # web :3000, api :4000, worker
# optional planes
docker compose -f infrastructure/docker-compose.yml --profile ingest up -d     # Firecrawl, Docling
docker compose -f infrastructure/docker-compose.yml --profile publish up -d    # Postiz
docker compose -f infrastructure/docker-compose.yml --profile observability up -d  # Langfuse
docker compose -f infrastructure/docker-compose.yml --profile billing up -d    # Lago
docker compose -f infrastructure/docker-compose.yml --profile gpu up -d        # ComfyUI (NVIDIA host)
```

## Environment variables (`.env.example` at repo root is authoritative)
| Var | Used by | Secret |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | web, api | no |
| `SUPABASE_SERVICE_ROLE_KEY` | api, worker | **yes** |
| `SUPABASE_JWT_SECRET` | api (verify JWT locally) | **yes** |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL` | web | no |
| `API_PORT`, `API_CORS_ORIGINS` | api | no |
| `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY` (cloud) | api, worker | key yes |
| `ANTHROPIC_API_KEY` | worker | **yes** |
| `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_ENVIRONMENT` | worker | secret yes |
| `ADS_SYNC_URL`, `ADS_SYNC_SECRET` | api, worker | secret yes |
| `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET` | ads-sync | yes |
| `LANGFLOW_URL`, `LANGFLOW_API_KEY` | worker | yes |
| `FIRECRAWL_URL`, `FIRECRAWL_API_KEY` | worker | yes |
| `DOCLING_SERVICE_URL`, `DOCLING_API_KEY` | worker | key yes |
| `EMBEDDINGS_PROVIDER`, `EMBEDDINGS_URL`, `EMBEDDINGS_MODEL`, `VOYAGE_API_KEY` | api, worker | key yes |
| `FFMPEG_PATH`, `FFPROBE_PATH`, `RENDER_FONT_FILE`, `WHISPER_MODEL` | worker | no |
| `ARCATIC_RENDER_TASK_QUEUE` (api) / `ARCATIC_TASK_QUEUE` (worker) | api, worker | no |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `NEXT_PUBLIC_GOOGLE_API_KEY`, `NEXT_PUBLIC_GOOGLE_APP_ID` | web | no (public by design; restrict by HTTP referrer) |
| `WHISPER_URL` | worker | no |
| `COMFYUI_URL`, `COMFYUI_SHARED_SECRET` | worker | yes |
| `POSTIZ_URL` (Postiz backend; per-workspace org API keys are stored encrypted in the DB), `POSTIZ_ADMIN_KEY` (future provisioning) | api | key yes |
| `APP_URL` (web origin for connect redirects) | api | no |
| `LAGO_API_URL`, `LAGO_API_KEY`, `LAGO_WEBHOOK_SECRET` (HMAC key of the webhook endpoint) | worker, api | yes |
| `LAGO_PAYMENT_PROVIDER` (e.g. cashfree), `LAGO_PAYMENT_PROVIDER_CODE` | api | no |
| `ADMIN_API_TOKEN` (staff refunds/adjustments, ≥ 32 chars) | api | **yes** |
| `MAUTIC_URL`, `MAUTIC_CLIENT_ID`, `MAUTIC_CLIENT_SECRET` | worker | yes |
| `MATOMO_URL`, `MATOMO_TOKEN` | worker | yes |
| `ENCRYPTION_KEY` (32-byte base64, for app-level secret envelope) | api, worker | **yes** |
| `SENTRY_DSN` | all | no |

Secrets: local `.env` (git-ignored); staging/prod in the platform secret manager (Doppler / AWS SM / GCP SM), injected at runtime. Never `NEXT_PUBLIC_*` for secrets.

## Staging
- Supabase project `arcatic-staging`; migrations applied by CI (`supabase db push`) on merge to `main`.
- Temporal Cloud namespace `arcatic-staging`.
- api/worker/web: containers on Fly.io / Render / k8s namespace `staging`; Postiz, Firecrawl, Docling, Langflow, Langfuse on one private VPC.
- Test platform apps only; nightly E2E + publishing sandbox suite.

## Production
- Supabase Pro (PITR, read replica for analytics later), separate project.
- k8s (EKS/GKE) with node pools: `general`, `ingest`, `gpu` (ComfyUI, Whisper; scale-to-zero via KEDA on Temporal queue depth).
- web on Vercel *or* k8s (Next standalone). API behind Cloudflare (WAF, rate limiting).
- Release: trunk-based; migrations are backward compatible (expand → migrate → contract); API blue/green; worker versioning via Temporal Worker Versioning (build ids) so in-flight workflows finish on old code.
- Backups: Supabase PITR; Storage bucket replication; Postiz/Lago Postgres daily snapshots; restore drill quarterly.
- SLOs: API p95 < 300 ms (reads), job start < 2 s, publish success ≥ 99% (excluding platform outages).
