# 17 — Phase 9: Growth suite

Guided creation wizards for every content type in the spec, nine new content types, projects that group related work, and one-to-many repurposing with source attribution.

## 1. Wizards (Create tab)

Wizards are declarative (`packages/core/src/content/wizards.ts`): steps, fields, defaults and a `wizardToRequest()` that produces the **same generation request** as the quick form (`POST /brands/:id/content`). A test runs every wizard (and every type choice inside one) through its template's input schema, so a wizard can't drift from its template.

| Group | Wizards |
|---|---|
| Ideas | Brainstorm ideas (→ "Turn ideas into drafts") |
| Social | Social post (post / carousel / story), X thread |
| Long-form | Newsletter, Press release, Case study |
| Sales & web | Landing-page copy, Sales sheet, Product copy, Facebook / Instagram ad |
| Visual | Branded graphic (canvas), Product photo, Profile assets |
| Video | YouTube or short-video script, Video editor (Phase 6) |
| Documents | Creative brief, AI document (one-pager, proposal, guide, FAQ, article, policy draft) |
| Repurpose | Video → content, Website / document / blog → content |

Product photo and profile assets keep their existing dedicated form (`/create/classic?type=…`), which also stays available as "the quick form". Every wizard can file its draft into a project, and can be limited to chosen Knowledge sources for facts and citations.

## 2. New content types (all text, all editable, validated, versioned and approvable like Phase 5)

| Type | Template | Credits | Notes / guardrails |
|---|---|---|---|
| newsletter | `email.newsletter@1` | 3 | subject ≤ 60 (error), preheader ≤ 110; publishable to Mautic segments |
| press_release | `pr.release@1` (premium tier) | 3 | **Quotes are never written by the model**: the quote is your exact text, or a marked `[Add an approved quote…]` placeholder. Dateline from city + date. Publishable to WordPress |
| case_study | `case.study@1` (premium) | 5 | Only facts supplied for challenge / solution / results. A quote appears only if you give one (verbatim). Publishable to WordPress |
| brief | `brief.creative@1` | 2 | Unknown dates and budgets are written as "To confirm" |
| landing_page | `web.landing@1` (premium) | 4 | SEO title, meta ≤ 160 (error), hero ≤ 70; no fake testimonials or counts |
| sales_sheet | `sales.sheet@1` | 3 | Proof only from knowledge; pricing only if given |
| product_copy | `product.copy@1` | 2 | Title, bullets, long description, meta, search terms; no invented specs |
| brainstorm | `ideas.brainstorm@1` | 1 | Each idea stores title, angle, format, channel and why; formats and channels are clamped to the ones you asked for |
| document | `doc.write@1` | 4 | Policy drafts mark items needing legal review with `[Confirm]` |

**AI document editing**: every text item now has an "Ask AI to edit" box (free-form instruction). It sits next to the existing improve / simplify / shorten / expand / grammar / tone / translate tools. Locked and human-edited blocks are preserved as before.

## 3. Projects

`projects` (brand-scoped, unique name per brand, active / archived). Content joins a project through `content_items.project_id`. A composite foreign key to `(project_id, brand_id)` makes cross-brand filing impossible, and deleting a project keeps its content. A project page lists its items by type and its repurpose runs, with "Create in this project" and "Repurpose into this project". Writes go through the API, reads through RLS (`content.read`).

## 4. Repurposing (one → many, with attribution)

**Sources**:
- a Knowledge source: URL, crawled site (child pages included), uploaded or Drive document, pasted text, or a **transcribed video / audio** file (Phase 3 Whisper);
- an existing content item: blog, case study, press release, newsletter, document, YouTube script or landing page.

The page can add a URL inline. Videos and documents are added in Knowledge first.

**Outputs (14)**:
- Social: Instagram post and carousel, LinkedIn post and carousel, Facebook post, Threads post, X thread, Business Profile update.
- Video scripts: short-video script, YouTube script.
- Long-form: blog article, newsletter, promotional email, FAQ document.

**Flow** (`repurposeWorkflow`, one parent job):
1. **Digest once** (`repurpose.digest@1`, 2 credits). The source is read in its original order (≤ 48k characters; truncation is reported) into: title, summary, key points with chunk ids, up to 3 quotes, and 3–5 angles.
   - **Quotes are verified**: a quote not found word for word in its chunk is dropped, and unknown chunk ids are removed.
2. **One child generation per output**, three at a time.
   - Each child uses the digest plus a different angle.
   - For Knowledge sources it is restricted to that source (`referenceSourceIds`), so facts are cited to the source's passages.
3. **Attribution on every piece**: `content_items.source_ref` (kind, id, title, URL, source type) and `repurpose_run_id`; `source_item_id` too when the source is a content item. The content page shows a "made from …" badge linking back.
4. **Credits**: the parent reserves the digest plus every output at its normal price. Children run at 0. The parent settles the digest plus only the outputs that were actually written. Run status: succeeded / partial / failed.

The build-plan acceptance ("one video → ≥ 6 channel assets with source attribution") is met by choosing ≥ 6 outputs for a transcribed video. That path is covered by activity and workflow tests, not by a live model run.

**Brainstorm → drafts**: pick up to 10 ideas on an idea list and Arcatic starts one draft per idea. The format and channel map to the right template, and the draft is filed in the list's project.

## 5. API (under `/v1/workspaces/:ws/brands/:b`)

| Method | Path | Permission |
|---|---|---|
| POST | `/content` now accepts `projectId`; `GET /content?projectId=` | content.create / read |
| GET / POST | `/projects`, `GET/PATCH /projects/:id` | content.read / create / update |
| PUT | `/content/:id/project {projectId \| null}` | content.update |
| GET | `/repurpose/options`, `/repurpose`, `/repurpose/:runId` | content.read |
| POST | `/repurpose/estimate`, `/repurpose {sourceId \| contentItemId, outputs[], language?, projectId?}` (idempotent; job) | content.read / create |
| POST | `/content/:id/ideas/drafts {indexes[], projectId?}` | content.create |

## 6. Verification

| Check | Result |
|---|---|
| ai (31) | every wizard × type choice validates against its template; every text type has a template; press-release / case-study quote guardrails; brainstorm clamping; digest keeps only verbatim quotes and known chunk ids |
| jobs (40) | digest reads chunks in source order once (idempotent), child jobs created once with attribution / project / source restriction, credits = digest + succeeded outputs, not-ready source refused; workflow fans out, records each child's result (incl. a failure) and settles the actual credits |
| api (68) | repurpose cost, run creation with attribution, refusals (not ready, two sources, duplicates, viewer), ideas → drafts mapping (carousel / short video, project inherited, unknown idea), projects permissions, generation into an unknown project refused |
| RLS smoke §20 | unique project names, cross-brand project refused, deleting a project keeps content, client can't write projects or runs, isolation |
| `next build` | passes (hub, wizard stepper, quick form, projects, repurpose) |

**Not verified**: no live model calls. Output quality per template needs the Langfuse eval loop from Phase 8 (scores per `template@1` × model).

## 7. Gaps

- Landing-page, sales-sheet, product-copy and brief documents are copy/export only. There's no page builder, PDF layout or marketplace listing API (marketplace rules weren't verifiable locally).
- Repurposing reads at most 48k characters of a source (≈ 30–40 minutes of transcript). Longer sources use the beginning and say so.
- Ideas → drafts creates drafts, not campaign topics. Topics are still planned in Strategy & Campaigns.
