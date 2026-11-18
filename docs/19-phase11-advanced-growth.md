# 19 — Phase 11: Advanced growth (SEO/AEO research, Google & Meta ads)

Two modules:
- **SEO / AEO**: keyword and competitor research, research-backed articles, and a per-version report covering scores, source-backed claims, internal links and JSON-LD.
- **Paid ads**: Google Search and Meta link ads through the official SDKs, built as a **high-risk, permission-controlled** module. Every action that can spend money needs an explicit, typed approval.

## 1. What was verified, and where

| Contract | Source checked | Used for |
|---|---|---|
| Google Ads API **v26** (`google-ads` 35.1.0, local `google-ads-python-main`) | `KeywordPlanIdeaService.generate_keyword_ideas` (keyword / url / keyword_and_url seeds, `GOOGLE_SEARCH` network, `keyword_idea_metrics.{avg_monthly_searches, competition, competition_index, low/high_top_of_page_bid_micros}`); `GeoTargetConstantService.suggest_geo_target_constants`; `GoogleAdsService.mutate` with temporary resource names (`-1`, `-2`, `-3`) as in `add_performance_max_campaign.py`; `CampaignBudget.amount_micros`, `Campaign.{status PAUSED, target_spend, network_settings, contains_eu_political_advertising}`, `AdGroup SEARCH_STANDARD`, `responsive_search_ad.{headlines, descriptions, path1, path2}`, keyword and location / language / negative criteria (from `add_responsive_search_ad_full.py` and `add_campaign_targeting_criteria.py`); updates with `protobuf_helpers.field_mask` (`update_campaign.py`) | keyword ideas, geo search, atomic PAUSED creation, status and budget updates |
| RSA limits | Google Ads Help "About responsive search ads" and the API RSA guide: 3–15 headlines ≤ 30 characters, 2–4 descriptions ≤ 90, paths ≤ 15, double-width characters count as 2 | `checkRsa` |
| Meta Graph **v26** (`facebook-business` 26.0.4, local SDK and examples) | `AdAccount.create_campaign / create_ad_set / create_ad_creative / create_ad`; `Campaign.Objective.OUTCOME_TRAFFIC / OUTCOME_AWARENESS`, `SpecialAdCategories`, `is_adset_budget_sharing_enabled`; `AdSet.OptimizationGoal.LINK_CLICKS / REACH`, `BillingEvent.IMPRESSIONS`, `BidStrategy.LOWEST_COST_WITHOUT_CAP`; targeting (`geo_locations`, `age_min/max`, `genders` 1/2, `flexible_spec.interests`); `object_story_spec.{page_id, instagram_user_id, link_data.{link, message, name, description, picture, call_to_action}}`; CTA types; `TargetingSearch` (`adinterest`, `adgeolocation`); `api_update`, `api_delete`, `AdAccount.Field.currency` | interest / geo search, PAUSED creation with cleanup, status and budget updates |

**Offline proof**: the sidecar's Docker build runs `test_sdk.py`. It builds the real Google `MutateOperation` objects with anonymous credentials, so nothing goes over the network. It also checks every Meta enum and field name against the installed SDK. **12 / 12 pass.** No live Google or Meta account was called.

## 2. SEO / AEO

| Piece | How it works |
|---|---|
| Keyword research | **AI keyword suggestions** never carry numbers. **Search volumes, competition and bid ranges** come only from **Google Keyword Planner**, through the sidecar, when a Google Ads account is selected. Ideas are merged (Planner numbers win), tagged with intent (informational / commercial / transactional / navigational) and grouped into topics: the head keyword has the highest volume, and keywords join a topic by word overlap. |
| Competitor research | Firecrawl reads up to 6 public pages: an SSRF check runs on every URL, and only pages on the competitor's own host are read. The AI returns positioning, audiences, topics (with page URLs), offers, verbatim claims and content gaps. A claim is kept only if its quote appears word for word on the page. |
| Research-backed article | `seoArticleWorkflow` runs in three steps: **brief → article → report**.<br>1. **Brief** (`seo.brief@1`): question, intent, title options, outline, FAQs and entities, built from knowledge retrieval plus competitor gaps.<br>2. **Article** (`blog.article@2`, a child job charged 0): answer-first `answer` block, question headings, bullet lists and an FAQ section.<br>3. **Report**: the content item's SEO targets are saved and the report is built. |
| `blog.article@2` | New default for the blog type; v1 stays registered for existing versions. Its optional inputs are `secondary`, `question`, `outline` and `faqs`. |
| Report (`buildSeoReport`, no AI, no credits) | **Search checks**: keyword in title, intro, heading and meta; natural density (stuffing fails); title and meta lengths; depth; headings per length; paragraph and sentence length; internal and outbound links.<br>**Answer-engine checks**: answer first; question headings; a short answer under each question; FAQ; lists; concrete figures.<br>**Claims**: figures, superlatives, attributions, guarantees and comparisons are matched to the version's knowledge chunks and the Brand Kit. Every figure must appear in the evidence, and enough of the content words must overlap. "No evidence found" means unbacked, not false.<br>**Internal links**: the brand's published pages (`schedules.external_url`) and crawled own-site pages, with an anchor phrase already in the text, at most one per paragraph and one per page.<br>**JSON-LD**: an `Article` block, plus `FAQPage` when there are 2+ question/answer pairs. Nothing is invented: no author, rating or date unless known. |
| Applying a link | "Add link" wraps the anchor as `[anchor](url)` in the draft, and saving creates a new version as usual. Publishing renders markdown links as `<a>` in HTML. In social and plain-text email, `[anchor](url)` becomes `anchor (url)`. |

## 3. Paid ads: the safety model

1. **Off by default per ad account.** `ad_account_policies.manage_enabled` is false until an owner or admin (`ads.approve`) switches it on. Turning it on, raising a limit, removing the cap, or turning off auto-pause or the second approver all require the ad account id typed back.
2. **Requests, not actions.** `launch`, `activate` and `budget_change` create an `ad_actions` row with a plain-language summary and a **confirmation phrase**: the campaign name for launch and activate, or the new amount (e.g. `750.00`) for budget changes.
3. **Approval in the database.** `decide_ad_action()` checks, in one transaction, that:
   - the request is still pending;
   - the campaign revision is unchanged;
   - management is on;
   - the budget is within the account limit;
   - the typed phrase matches;
   - (by default) the approver is not the requester.

   Only `ads.approve` holders reach it, and API keys are refused: a signed-in person is required.
4. **Edits cancel approvals.** Any campaign edit bumps `revision`, and a trigger cancels pending or approved requests for the old revision. The worker re-checks the revision before calling the platform.
5. **Created paused.**
   - **Google**: one atomic `GoogleAdsService.mutate` (budget, campaign, criteria, ad group, RSA and keywords, all or nothing), with campaign status `PAUSED`, Search only (no Display expansion) and Maximize clicks.
   - **Meta**: the campaign is created `PAUSED`; the ad set and ad sit under it.
   - Spending starts only with a separately approved `activate`.
6. **Retry-safe.** Platform objects are named `<name> [arc:<id8>]`.
   - **Google**: a retry finds the existing campaign by name instead of creating a second one.
   - **Meta**: a partial failure deletes the paused campaign; a retry deletes any paused leftover and rebuilds.
   - The HTTP client never auto-retries money-moving calls. The workflow retries at most 3 times and never on `forbidden`, `conflict` or validation errors.
7. **Currency guard.** The sidecar refuses to create a campaign when the ad account's currency differs from the campaign's. Budgets are never converted.
8. **Spend guard.** After each ads sync (every 2 hours), if month-to-date spend on an account reaches its `monthly_spend_cap` and auto-pause is on, every active Arcatic campaign there is paused. A `pause` action is recorded each time. The guard can only reduce spend.
9. **Always allowed.** Anyone with `ads.manage` can pause or end at once, even with management switched off.
10. **Audited.** Audit rows are written for campaign status and budget changes, every request and decision, and every policy change.

**Permissions**:

| Permission | Roles |
|---|---|
| `ads.read` | owner, admin, editor, reviewer |
| `ads.manage` | owner, admin, editor |
| `ads.approve` | owner, admin |

Viewers and contributors don't see ads.

**Compliance pre-check** (`checkCompliance`, deterministic):
- **Google**: RSA limits and duplicates; Google editorial warnings (no "!" in headlines, all caps, repeated punctuation, phone numbers); keywords and locations required.
- **Meta**:
  - required fields and an image;
  - truncation warnings (125 / 40 / 30);
  - **personal attributes**: "you/your" next to a sensitive trait is blocking;
  - **special ad categories**: once declared, no age or gender narrowing (18–65, all genders);
  - a hint when the copy looks like housing, employment, credit or gambling.
- **Both**:
  - political or election wording is blocked (these need platform authorisation Arcatic doesn't handle);
  - risky claims are warnings: guarantees, health, income, superlatives, urgency;
  - the landing page must use https;
  - budget within the limit, with a monthly projection at 30.4 × daily;
  - dates checked.

  The platforms' own review still applies after creation.

**AI drafting** (`ads.draft`, 3 credits):
1. `ads.brief@1` writes a summary, angles and audiences.
2. Copy comes from `ads.google.rsa@1` (Google; anything over the limits is dropped, not cut) or `ads.meta.campaign@1` (Meta, with alternatives).
3. Meta interest names are turned into ids only by an **exact-name match from Meta's TargetingSearch**. Arcatic never invents targeting ids.
4. Drafting bumps the revision.

**Organic → paid**: "Promote" on Analytics → Top posts creates a draft from the post's current version. Only text that already fits the limits is reused, its image is used for Meta, and its published URL becomes the landing page when it is https. `source_content_item_id` keeps the link back to the post.

**Reporting**: per campaign, the Phase 8 `ad:<connection>:<platformCampaignId>` rows give spend, clicks, CTR, CPC, conversions and cost per conversion, plus the account's month spend against its cap.

## 4. Data (migration `20261127000016_advanced_growth.sql`)

`keyword_sets`, `competitors`, `seo_reports` (one per version), `content_items.seo`, `ad_account_policies`, `ad_campaigns`, `ad_actions` (one open request per campaign), `decide_ad_action()` (service only), revision trigger, ad-account guard (same workspace, matching platform, brand-linked accounts only for that brand), RLS (read by permission; all writes through the API), audit triggers.

## 5. API (under `/v1/workspaces/:ws`)

| Method | Path | Permission |
|---|---|---|
| GET/POST | `/brands/:b/seo/keyword-sets`, GET `/:id` | content.read / content.create (job, 2 credits) |
| GET/POST/DELETE | `/brands/:b/seo/competitors`, POST `/:id/analyze` | content.read / create (job, 3 credits) / delete |
| POST | `/brands/:b/seo/articles` | content.create (job, brief 3 + blog 8 = 11 credits) |
| GET/PUT | `/brands/:b/content/:cid/seo`; POST `/seo/analyze` | content.read / content.update (free) |
| GET | `/ads/accounts`; PUT `/ads/accounts/:conn/policy` | ads.read / ads.approve (+ typed id) |
| GET | `/ads/accounts/:conn/search?kind=geo\|interest&q=` | ads.manage |
| GET/POST | `/brands/:b/ads/campaigns`, GET/PATCH `/:id`, POST `/:id/{check,draft}` | ads.read / ads.manage |
| POST | `/brands/:b/ads/promote` | ads.manage |
| POST | `/brands/:b/ads/campaigns/:id/actions {launch\|activate\|pause\|budget_change\|end}` | ads.manage (signed-in person) |
| GET | `/brands/:b/ads/requests`; POST `/requests/:aid/decide {decision, confirmation}` · `/cancel` | ads.read / ads.approve / ads.manage |
| GET | `/brands/:b/ads/campaigns/:id/report?days=` | ads.read |

## 6. Verification

| Check | Result |
|---|---|
| core (190) | SEO checks (good vs stuffed / thin), claims (figure mismatch isn't support), internal links (own site only, one per paragraph, applied as markdown → HTML / plain text), keyword intent and clusters, JSON-LD; RSA limits incl. double-width, editorial warnings, compliance (Google / Meta / political / special categories / personal attributes), budget guard and 30.4 projection, spend levels, state machine, confirmation phrases, organic → paid seeds; RBAC drift test now reads grants across migrations |
| ai (38) | `blog.article@2` doc shape + answer-first passes the scorer; competitor claims dropped unless verbatim; AI keywords have no volumes; brief bounds; ads brief per platform; RSA copy dropped (not truncated) when over limits |
| integrations (32) | sidecar client: research retried, campaign create / update never retried |
| sidecar (12, Docker) | pure plan builders + real SDK objects: atomic op order, PAUSED, no Display, EU political flag, budget micros, RSA text; Meta enums and field names |
| jobs (63) | execute: launch (Google), stale revision → cancelled and no call, management off / over limit / not approved → no call, pause allowed when off, Meta budget → ad set, Meta image signed URL + Page id; spend guard pauses over cap only with auto-pause; Meta interest ids by exact match; keyword research merge; competitor crawl stays on host; SEO article child prepared once; SEO report end-to-end; workflows: brief → child → report settles once, child failure releases the hold, `forbidden` not retried |
| api (97) | permissions per role, API keys refused for ad changes, policy confirmation, launch is a request (no execution), compliance blocks launch, budget limit and phrase, pause runs at once, approval passes the typed phrase to the DB, drafts-only edits bump revision, promote seeds creative, SEO routes (Planner needs Ads + sidecar, competitor SSRF / own-site, article cost) |
| RLS smoke §22 | competitor uniqueness, scope inheritance, cross-workspace / wrong-platform account blocked, management-off approval blocked, self-approval blocked, wrong phrase blocked, edit cancels approval, over-limit budget blocked, stale request refused, audit rows; clients can't write campaigns, requests or call `decide_ad_action`; viewers see no ads |
| `next build` | passes (SEO, Ads, campaign editor, Settings → Ad accounts, SEO panel on long-form content) |

**Not verified**: no live Google Ads or Meta call was made. The acceptance criterion ("sandbox campaign created") needs:
- a Google Ads **test account** with a developer token;
- a Meta **sandbox ad account** with a system-user token;
- for each, running *launch → approve → paused campaign visible in the platform UI → activate → pause*.

## 7. Gaps and decisions

- **Ad credentials** are still pasted tokens (Phase 8). Google OAuth consent and Meta Business Login are not built; they need app review on both platforms.
- **Scope kept small on purpose**: Google Search RSA only (no Performance Max, Display or Shopping), and Meta single-image link ads for traffic or awareness (no leads, sales or pixel events, catalogues or video). Image upload uses `link_data.picture` with a 1-hour signed URL, not `AdImage` hashes.
- **Live campaigns can't be edited** in Arcatic beyond pausing, ending and changing the budget. To change the ads, duplicate the campaign. This avoids partial updates to platform objects.
- **Meta schedule times** use the workspace offset (default `+0530`). Zero-decimal currencies are refused by the currency guard unless the campaign uses the same currency.
- **Spend data lags** by up to the sync interval (2 hours) plus the platforms' own reporting delay, so the cap guard can overshoot by that window. Platform-side spending limits (Google account budget, Meta account spending limit) are the hard backstop. Set them too.
- **SEO checks are heuristics**; no ranking or AI-answer inclusion is promised. Claims matching is lexical, so a person decides what "no evidence found" means.
- **Not built**: rank tracking, Search Console integration, backlink data, competitor ad libraries. None of the local repositories provides these; each would need its own adapter, e.g. the Search Console API and the Meta Ad Library API.
