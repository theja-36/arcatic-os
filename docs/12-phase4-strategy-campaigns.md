# 12 — Phase 4: Strategy & Campaign Engine (implemented)

## Flow
1. **Generate a strategy** (`POST /brands/:id/strategies`, ≈10 credits): 4–26 weeks (default 13 = 90 days). Requires an approved Brand Kit. Inputs: approved Brand Context, onboarding goals/channels/maturity, knowledge passages (hybrid search), the seasonal calendar, optional goals/constraints/focus.
2. **Review and edit everything**: summary, positioning, goals, audiences, pillars (+shares), channel mix (posts/week, content types), offers & CTAs, campaigns, week-by-week themes, success metrics, assumptions. Saves are revisioned (`save_strategy_plan`: optimistic revision check + immutable `strategy_revisions` snapshot).
3. **Activate** → one active strategy per brand; each plan campaign becomes a campaign record (idempotent by `plan_key`; campaigns you've already edited are kept as they are).
4. **Plan weeks** (`POST /strategies/:id/weekly-plan`, 1 credit/week, nothing if no topic was created): code allocates posting slots, the model writes one topic per slot, topics are inserted (idempotent per slot), optionally auto-approved (never when flagged).
5. **Run campaigns**: Start → a per-campaign Temporal runner generates approved topics either immediately, `leadDays` before their date, or only on demand, capped by `maxPerDay`. Each generation reserves credits and runs as a child job linked back to the topic (`content_items.topic_id`, `campaign_topics.content_item_id`).
6. **Pause / resume / cancel / complete** take effect immediately via signals (verified < 5 s by a signal→query test). Cancel also cancels in-flight generations (credits released) and drops unused topics.

## Decided by code, not the model
| Rule | Where |
|---|---|
| Week dates = Mondays computed from the start date; the model refers to week numbers | `core/strategy/dates.ts`, `normalizeDraft` |
| Weekly volume capped by marketing maturity (starting 5 · occasional 8 · consistent 15 · advanced 30 posts/week), scaled proportionally | `normalizeDraft` |
| Only selected channels; unknown content types dropped; pillar shares normalised to 100 | `normalizeDraft` |
| Campaign dates clamped to the strategy period; keys unique | `normalizeDraft`, `checkPlan` |
| Seasonal moments: only from the provided calendar; lunar festivals come from `seasonal_events` (never guessed) | `core/strategy/seasonality.ts` |
| Posting slots (which channel, which day, which campaign, which format) | `allocateWeekSlots` |
| Topics containing banned words are flagged and never auto-approved | `fillSlots` |
| Campaign lifecycle draft→planned→active⇄paused→completed/cancelled | SQL trigger + `canTransition` (tested to match) |
| Unsupported formats/channels (email, blog, WhatsApp…) are planned but marked *blocked* with a reason instead of failing | `topicGenerationInput` |
| No credits → topic *blocked* "Not enough credits", campaign keeps running | `reserveTopicGeneration` |

Every deterministic fix made to an AI draft is listed on the strategy (`validation.notes`) and shown in the UI.

## Data model (migration 0009)
`strategies` (plan JSON, revision, provenance: kit version, model, template, source chunks) · `strategy_revisions` (immutable) · `campaigns` + strategy link, `plan_key`, brief, revision, runner bookkeeping · `campaign_topics` + channel, content type, CTA, notes, origin, `slot_key` (unique per campaign), generation links/counters, status note · `seasonal_events` (global + workspace).

## API (added)
Strategies: `GET/POST /brands/:id/strategies`, `GET /strategies/:sid`, `PUT /strategies/:sid/plan`, `GET /strategies/:sid/revisions[/:rev]`, `POST /strategies/:sid/{activate,archive,weekly-plan}`.
Campaigns: `GET/POST /brands/:id/campaigns`, `GET/PATCH /campaigns/:cid`, `POST /campaigns/:cid/{start,pause,resume,cancel,complete}`, `POST /campaigns/:cid/topics`, `POST /campaigns/:cid/topics/bulk`.
Topics: `PATCH/DELETE /brands/:id/topics/:tid`, `POST /topics/:tid/generate` (generate now / regenerate into the same content item).
Planner: `GET /brands/:id/plan?from&to` (topics + week themes + seasonal moments). Seasonal events: `GET/POST/DELETE /seasonal-events`.

## UI
Brand tabs: Brand Kit · Knowledge · **Strategy** (generate, edit every section, save/activate, plan weeks) · **Campaigns** (list with topic counts; detail with lifecycle controls, live runner status, brief & schedule, topics by week with bulk approve/retry/drop, edit, generate/regenerate) · **Planner** (4-week grid, week themes, seasonal moments, add your own dates).

## Verified vs not yet verified
- **Verified**: migration + smoke tests (revision conflicts, immutable revisions, one active strategy, client read-only strategies, campaign transitions, slot uniqueness); 106 core tests incl. calendar rules, normalisation, slot allocation, SQL↔TS lifecycle parity; 16 workflow tests incl. runner pause/resume (signal→query < 5 s), cancel mid-generation releasing credits, unsupported topics, completion; 36 API tests; Next.js build.
- **Not yet verified**: strategy and topic quality from Claude on real brands (needs an eval: 10 brands × strategy rubric — measurability, capacity realism, use of real offers/moments, Telugu fit); a live run on Supabase + Temporal.

## Notes / limitations
- Only social formats (post, carousel, story) on social channels generate today; email, blog, ads, short video and WhatsApp arrive in Phase 5 (they can already be planned).
- Lunar-calendar festivals must be added per year in the Planner (built-in fixed dates cover national days, Sankranti, Mother's/Father's Day, Black Friday, TG/AP formation days).
- The runner wakes on approve/edit signals and otherwise re-checks at the next due time (≤6 h); schedules run in UTC (03:30 UTC ≈ 09:00 IST check-ins).
