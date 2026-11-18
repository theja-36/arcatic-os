# 10 — Phase 2: Onboarding & Brand Intelligence (implemented)

## Flow
1. **Create brand** → redirected to the **onboarding wizard** (5 steps: business · goals & audience · offers & competitors · voice & language · channels & maturity). Each step is saved (`PUT /brands/:id/onboarding`); finishing seeds the Brand Kit with the owner's answers as **approved** facts (origin `onboarding`) in a new draft version.
2. **Analyse website** (`POST /brands/:id/kit/analyze-website`, Idempotency-Key, ownership attestation required, SSRF-checked) → credits reserved → `brandAnalysisWorkflow`:
   - `discoverPages`: Firecrawl `/v2/map` → deterministic `selectPages` (home, about, services, products, pricing, testimonials, FAQ, contact, one blog index; same host only; assets/admin/legal skipped). Falls back to the home page if mapping fails.
   - `scrapePage` ×N (4 in parallel): Firecrawl `/v2/scrape` markdown; home page also `rawHtml` (and optionally Firecrawl `branding`). Pages are stored in `sources` (type `url`, `metadata.page_type`) so Phase 3 can chunk/embed them. Unreadable pages are skipped; zero readable pages fails the job and releases credits.
   - `extractBrand`: Claude structured extraction (`brand.extract@1`) → **citation verification** (each quote must appear verbatim, formatting-insensitive, in the cited page; otherwise dropped and confidence capped at 0.3; prices kept only if present on a page) + deterministic visual signals (colours, fonts, logo) → `mergeSuggestions` → new draft kit version (origin `ai_analysis`).
3. **Review in the Brand Kit editor** (tabs: Profile, Audience, Offers, Voice, Visuals, Channels & rules, History). Each fact shows status, confidence, and source quotes with links. Edits are queued client-side and previewed with the same `applyKitOps` the API runs; **Save draft** posts them with `baseVersion` (409 on concurrent change).
4. **Approve a version** → `approve_brand_kit_version` (atomic: one approved version per brand, previous → superseded), compiled **Brand Context** stored in `brand_contexts`, and the response lists drafts affected by the change (`content_affected_by_facts`) for selective regeneration.
5. **Generation** (`generateContent`) now reads only the brand's active approved Brand Context; no approved kit → the job fails with a clear message.

## Rules enforced in code (not prompts)
| Rule | Where |
|---|---|
| AI never overwrites an approved fact; it attaches a `suggestion` | `core/brand/merge.ts` |
| A rejected value is never re-suggested | `core/brand/merge.ts` |
| Onboarding re-saves don't overwrite Brand Kit edits | `core/brand/onboarding.ts` |
| Only known fact paths; values schema-validated | `core/brand/kit.ts` (`SINGLETON_PATHS`), `ops.ts` |
| Citations must quote the page | `core/brand/citations.ts`, `ai/brand-extract.ts` |
| Only approved facts in approved versions reach prompts | `core/brand/context.ts`, `jobs/activities.ts` |
| Brand Context ≤ 1,500 tokens (Telugu-safe estimate), banned words never truncated | `core/brand/context.ts` |
| Kit versions immutable; only approval lifecycle changes | `0007` trigger `guard_kit_version` |
| Website analysis needs an ownership attestation, stored with who/when | API + `brand_onboarding.ownership_attested_*` |
| Same-host pages only; private/reserved addresses refused at API and in each activity | `core/url-safety.ts`, `core/brand/pages.ts` |

## Data model (migration 0007)
`brand_onboarding` · `brand_kit_versions` (immutable, `draft → approved → superseded`) · `brand_contexts` (compiled context per approved version) · `brands.active_kit_version_id`, `brands.kit_completeness` · functions `approve_brand_kit_version`, `content_affected_by_facts`.

## API (added)
`GET/PUT /brands/:id/onboarding` · `POST /brands/:id/kit/analyze-website` · `GET /brands/:id/kit` · `POST /brands/:id/kit/ops` · `GET /brands/:id/kit/versions[/:v]` · `POST /brands/:id/kit/versions/:v/approve` · `POST /brands/:id/kit/versions/:v/restore` · `GET /brands/:id/kit/impact?from&to` · `GET /brands/:id/context?channel=`

## Credits
Website analysis = `brand.extract` (5) + `ingest.url` (0.2 × pages); reserve 1.5×, settle the estimate on success, release on failure/cancel.

## Verified vs not yet verified
- **Verified (automated):** SQL migration + RLS/approval smoke test on Postgres 17 + pgvector; 98 unit/workflow/API tests; Next.js production build.
- **Not yet verified:** a live run against self-hosted Firecrawl + Claude + Supabase; extraction quality on real sites (needs the Phase 2 eval set: 20 real SMB sites incl. Telugu, scored for citation precision and field accuracy); Firecrawl `branding` (off by default; needs a branding-capable Firecrawl configuration).

## Deferred to later phases
Competitor scans (Phase 11), Google Drive / document sources (Phase 3), logo upload into the media library (Phase 6: `visual.logoAssetId`), regenerate-affected-drafts action (Phase 5; the impact list is already returned), Langfuse tracer adapter.
