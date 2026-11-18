# 16 — Phase 8: Analytics & learning

One warehouse table for every source, a dashboard with platform summaries and drill-downs, evidence-backed insights, and a learning loop that changes generation **only through decisions a person makes**.

## 1. Sources (verified from source code in the project folder)

| Source | How | What lands in `performance_metrics` | Verified in |
|---|---|---|---|
| Social posts | Postiz `GET /public/v1/analytics/post/:postId` (lifetime totals per label) | `kind=post`, one cumulative snapshot per post per day | `posts.service.ts checkPostAnalytics`, each provider's `postAnalytics()` labels |
| Social accounts | Postiz `GET /public/v1/analytics/:integration?date=30` (daily series) | `kind=account` per day (followers, page impressions …; unknown labels in `extra`) | `social.integrations.interface.ts AnalyticsData` |
| Email | Mautic `GET /api/emails/{id}` (sentCount, readCount) + `GET /api/stats/email_stats` (failed) + `/api/stats/channel_url_trackables` (hits, unique_hits) | `kind=email` cumulative snapshot | `EmailApiController`, `StatsApiController`, `Stat`/`Trackable` entities |
| Website | Matomo `VisitsSummary.get`, `Goals.get`, `Referrers.getCampaigns` (period=day, token in POST body) | `kind=site` per day; `kind=utm` per utm_campaign per day (matched to Arcatic campaigns by slug) | `plugins/VisitsSummary/API.php`, `Goals`, `Referrers`; `AuthenticationToken` |
| Google Ads | **official google-ads SDK (v26)** in `services/ads-sync`: GAQL `campaign` × `segments.date` (impressions, clicks, cost_micros, conversions, conversions_value, video_trueview_views) | `kind=ad` per campaign per day | `google-ads-python-main` 35.1.0 (gRPC only, so not called from Node) |
| Meta ads | **official facebook-business SDK (v26.0)** in `services/ads-sync`: `AdAccount.get_insights(level=campaign, time_increment=1)` | `kind=ad` per campaign per day | `facebook-python-business-sdk-main` 26.0.4 |

Google Analytics is optional in the spec and not built. Matomo covers website analytics.

**Platform figure normalisation** (`core/analytics/metrics.ts`): `Impressions`→impressions, `Unique Impressions`/`Reach`→reach, `Views`→video_views, `Likes`/`Reactions`→likes, `Comments`+`Replies`→comments, `Shares`/`Retweets`/`Reposts`→shares, `Saves`/`Bookmarks`→saves, `Clicks`, `Engagement`. "Seen" = impressions, else views, else reach; engagement rate = interactions ÷ seen. Business Profile posts report nothing per post in Postiz (location-level only).

**Attribution**: links in published posts and emails now carry `utm_source=<channel>&utm_medium=social|email&utm_campaign=<campaign slug>&utm_content=<target id>` (shown in the publish preview; WordPress articles aren't tagged). Matomo's campaigns report then maps visits and goal conversions to Arcatic campaigns.

**Cadence**: a Temporal schedule (`analytics-daily`) runs every 2 hours to refresh metrics. Insights are recalculated in the nightly run (≈ 02:00 IST). "Sync now" is available in the UI, limited to one per workspace per hour. Each source's run is recorded in `analytics_sync_runs`; a failing source never blocks the others.

## 2. Warehouse

`performance_metrics` now has one row per `(workspace, metric_key, day)`. Re-syncing the same day overwrites it, so syncs are idempotent. Keys: `post:<schedule>`, `email:<schedule>`, `account:<connected_account>`, `site:<connection>`, `utm:<connection>:<label>`, `ad:<connection>:<campaign>`. Rows carry `brand_id`, `campaign_id`, `topic_id`, `content_item_id`, `schedule_id` and `channel`, so every drill-down is one query. `post_performance(brand, from, to)` (RLS-aware) returns the latest snapshot of each post published in a period.

## 3. Dashboard (Analytics tab)

- **Periods**: 7 days, 30 days, year (calendar days incl. today), each compared with the equally long period before it.
- **Platform summaries**: posts, seen, interactions, engagement rate; email open and click rate; website visits and conversions; ad spend and conversions per network; follower change per account.
- **Charts**: seen per day (by publish date) and website visits per day, one measure per chart, with hover and a table view.
- **Trends**: Welch t ≥ 2 and |change| ≥ 15% with at least 5 days per side. Otherwise nothing is called a trend.
- **Top / bottom**: posts at least 48 h old with ≥ 50 seen, scored against their own channel (median / MAD robust z).
- **Breakdown**: by channel, campaign (+ website visits and conversions from utm), topic, content item, content type or publish date.

## 4. Insights & learning (what is and isn't automatic)

| Insight | Logic (`core/analytics`) | Minimum evidence |
|---|---|---|
| Top post / underperformer | robust z ≥ 1 / ≤ −1 within channel | 3 eligible posts in the channel |
| Best time | weekday × part of day (brand timezone, IST default), median ER ≥ 1.3 × channel median | 8 posts on the channel, 3 in the slot |
| Format | video vs image vs text median ER ratio ≥ 1.3 | 3 posts of each compared format |
| Length / hashtags | Spearman ρ(length or hashtag count, ER), \|ρ\| ≥ 0.4 (hashtags: ρ ≤ −0.4) | 8 posts |
| Channel mix | channel ER ≥ 1.5 × the others with below-average posting | 5 posts per channel |
| Website trend | two-week windows, same test as above | 10 days of data |
| Voice refinement (edit learning) | AI draft vs approved text: consistently shorter (median ≤ 85% in ≥ 60% of edits), words removed in ≥ 3 drafts (≥ 60% of drafts they appeared in) or added in ≥ 3 | 5 edited drafts / 3 drafts per word |

Every insight stores its evidence (posts, counts, ratios, correlation) and a confidence. A dismissed insight is never raised again.

**The loop is explicit:**
1. **Signals stored**:
   - edits (with edit class), approvals, rejections and change requests;
   - regenerations, ratings and notes (new feedback card on content);
   - accept and dismiss decisions on insights;
   - one **engagement outcome** per post 72 h after publishing (its ER relative to its channel median).
2. **Accepting** a recommendation adds its one-line `guidance` to future generation prompts for the matching channel (`<learnings>` block). Each new version records which insights it used (`content_versions.insight_ids`). "Stop using" removes it.
3. **Voice refinements** with vocabulary changes become a **Brand Kit draft** (existing ops + approval flow). They reach prompts only when that kit version is approved.
4. Nothing is applied without a decision. The UI says so on the Insights page.

**AI quality per prompt × model** (Insights page): first-pass approval rate, edit rate, regenerations per draft, rejection rate and average engagement versus channel.

## 5. Langfuse

- **Traces**: every model call is exported as an OTLP/HTTP JSON span to `POST /api/public/otel/v1/traces`. Langfuse's source marks the old `/api/public/ingestion` batch API as deprecated for traces (score events only).
  - Span attributes are the ones its OTel processor reads: generation type, model, usage, prompt name/version from `template@N`, workspace as session, and tags.
  - The trace id is the generation job id. The cached Brand Context system prompt is not exported.
- **Scores**: `POST /api/public/scores` with deterministic ids:
  - `approved_first_pass` and `human_edited` (boolean), from the nightly insights run;
  - `engagement_vs_channel` (numeric), when a post matures.
- **Comparing prompt and model versions** therefore works in Langfuse (filter by prompt version or model, compare scores) as well as in-app.
- Configure with `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` (`LANGFUSE_ENVIRONMENT` optional). Tracing never fails a generation.

## 6. API (under `/v1/workspaces/:ws`)

| Method | Path | Permission |
|---|---|---|
| GET | `/analytics/connections`, `/analytics/sync-runs` | analytics.read |
| PUT | `/analytics/connections/matomo {baseUrl, siteId, token, brandId?}`, `/analytics/connections/google-ads {customerId, loginCustomerId?, refreshToken, brandId?}`, `/analytics/connections/meta-ads {adAccountId, accessToken, brandId?}` | channel.manage |
| DELETE | `/analytics/connections/:id` (keeps collected metrics) | channel.manage |
| POST | `/analytics/sync` | analytics.read |
| GET | `/brands/:b/analytics/overview?period=7d\|30d\|365d`, `/brands/:b/analytics/breakdown?period&by=channel\|campaign\|topic\|content\|content_type\|date` | analytics.read |
| GET / POST | `/brands/:b/insights[?status&kind]`, `/brands/:b/insights/refresh` | analytics.read |
| POST | `/brands/:b/insights/:id/{accept,dismiss,applied}` (accept returns Brand Kit ops for voice refinements) | brand.update |
| GET | `/brands/:b/learning` | analytics.read |
| POST | `/brands/:b/content/:c/feedback {rating?, note?}` | approval.read |

## 7. Verification

| Check | Result |
|---|---|
| core (154) | label normalisation, periods, trend test, ranking, recommendations (fire with evidence, silent on thin data), edit learning, quality summary, learnings filter, UTM tagging |
| integrations (28) | Matomo token only in POST body + error JSON; Langfuse OTLP span shape/ids/auth, scores, never-throw tracer; Mautic stats queries |
| jobs (36) | post snapshot sync (missing / empty posts), outcomes once per post, insights raised with evidence and dismissed ones not re-raised, sync workflow continues past a failing source, accepted learnings reach the prompt (unaccepted don't), UTM-tagged publish |
| api (62) | overview totals/ER/top-bottom, breakdown, accept → merged Kit ops, permissions, Matomo HTTPS + token check + encrypted storage, feedback, sync |
| RLS smoke §19 | one row per key/day, latest snapshot by publish time, open-insight dedupe, one outcome per post, analytics sources isolated, clients can't write metrics or decide insights |
| ads-sync | Python normaliser tests; Docker image builds with google-ads 35.1.0 + facebook-business 26.0.4, the SDK imports used resolve, and the service rejects unauthenticated and malformed calls |
| `next build` | passes |

**Not verified**: no live Postiz, Mautic, Matomo, Google Ads, Meta or Langfuse instance was called. Real figures, OAuth/token scopes and Langfuse's rendering of the spans need a staging run.

## 8. Gaps and decisions

- **Ad credentials**: workspaces paste a Google Ads refresh token / Meta system-user token. An OAuth consent flow for these is still not built (Phase 11 kept pasted tokens; see docs/19 §7). The platform needs a Google Ads developer token (`GOOGLE_ADS_*`).
- **Meta conversions** count standard events (purchase, lead, complete_registration, pixel purchase/lead). Custom conversions aren't counted.
- **Post figures are lifetime totals** attributed to the publish date. Day-by-day views per post aren't available from every platform via Postiz.
- **Time zone**: periods are UTC calendar days. Best-time slots use IST unless a brand time zone is passed.
- **Google Analytics 4**: not built (Matomo is the website source).
- **Matomo image**: compose uses `matomo:5` while the reference repo is 6.x-dev. The APIs used exist in both.
