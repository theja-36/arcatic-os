# 07 — Testing Plan

| Layer | Tooling | Scope | Gate |
|---|---|---|---|
| Unit | Vitest | `packages/core` (RBAC, validators, Brand Context compiler, URL safety, cost estimator), `packages/ai` (template rendering, schema parsing), `packages/jobs` (pure helpers) | PR — 90% lines in `core` |
| DB / RLS | pgTAP (`supabase test db`) | Every tenant table: member can CRUD own ws per role; non-member gets 0 rows; viewer cannot write; audit_logs immutable; credit functions idempotent & race-safe | PR |
| Workflow | `@temporalio/testing` (time-skipping env) | Generate: reserve→settle; failure→release; cancel→release; duplicate start no-op; retries | PR |
| API integration | Vitest + supertest-style against Hono app + local Supabase | Auth, permission matrix, idempotency, pagination, error shape | PR |
| Contract (adapters) | Recorded fixtures (msw / nock) from real Postiz/Firecrawl/Docling responses | Adapter parsing + error mapping; re-record weekly in staging | PR + weekly |
| E2E | Playwright | Sign-up → workspace → brand → upload → job visible; approvals on mobile viewport | main + nightly |
| AI evaluation | Langfuse datasets + eval runner (`pnpm eval`) | Per template: schema validity 100%, validator pass ≥ 95%, LLM-judge rubric (brand voice, accuracy, CTA) ≥ baseline; Telugu set | Before promoting template version |
| Publishing sandbox | Staging Postiz + test accounts/pages per platform (Meta test pages, LinkedIn test org, YouTube unlisted, X dev account) | Publish → status → delete where API allows | Nightly staging |
| Load | k6 | API 200 rps reads; 50 concurrent generation workflows; ledger contention test (100 parallel reservations on one wallet) | Pre-launch |
| Security | ZAP baseline, dependency audit, licence check, RLS fuzz | | Weekly + pre-launch |
