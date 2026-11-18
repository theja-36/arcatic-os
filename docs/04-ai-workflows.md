# 04 — AI Workflow Specifications

## 1. Shared pipeline (every generation type)

```
request → estimate cost → reserve credits → compile BrandContext(vN) → retrieve knowledge (k chunks, cited)
        → render prompt template (id@version) → model call (structured output, zod schema)
        → deterministic validation (packages/core/validation) → auto-repair pass (max 1) if fixable
        → persist content_version {prompt, template_version, model, params, inputs, brand_context_version,
                                    source_chunk_ids, cost, trace_id, validation_report}
        → settle credits (actual) → job succeeded
```

**Brand Context object** (compiled by `packages/core/src/brand-context.ts`, ≤ ~1,500 tokens, hashed):
`{ brand_id, version, hash, name, one_liner, positioning, audiences[≤3], offers[≤5], voice{tone[], personality[], do[], dont[]}, vocabulary{preferred[], banned[]}, visual{colors[], fonts[], logo_asset_id}, channel_rules{[channel]: {...}}, languages[], compliance{disclaimers[], claims_policy} }`
Only *approved* facts are compiled; unapproved suggestions never reach a prompt.

**Validation (code, not prompt)**: banned words (case/diacritics-insensitive, word-boundary, Telugu-aware), platform length limits (grapheme-counted), hashtag limits, required CTA/link, URL reachability (async, HEAD), disclaimers present, no unverified numeric claims if `claims_policy=strict` (claim must cite a chunk).

**Model routing** (`packages/ai/src/models.ts`): every tier defaults to `claude-opus-5-5` (effort `low` / `medium` / `high` for economy / standard / premium templates). Moving a template to `claude-sonnet-5-5` or `claude-haiku-5-5` to cut cost is a product decision, made per template only after the eval suite shows quality holds; set `ARCATIC_MODEL_{ECONOMY,STANDARD,PREMIUM}` to override. Calls use structured JSON output (`output_config.format`, re-validated with zod), server-side refusal fallbacks (`fallbacks: "default"`), and a cache-marked system prompt (instructions + Brand Context) so repeated generations for a brand reuse the prompt cache. The `LlmProvider` interface allows other providers. Each call is traced to Langfuse over OTLP (Phase 8, docs/16 §5) with `workspace_id`, `job_id` (= trace id), `template@version`; human review and engagement outcomes are attached as scores. Accepted performance learnings are added to prompts as a `<learnings>` block (docs/16 §4).

## 2. Per-type specs

| Type | Inputs | Template | Output schema (zod) | Validators | Credits (base) |
|---|---|---|---|---|---|
| Social post | channel, topic, goal, CTA, refs | `social.post@1` | `{hook, body, cta, hashtags[], alt_text?, variants[≤3]}` | channel length, hashtags ≤ limit, banned words | 1 |
| Caption for image | asset_id, channel | `social.caption@1` (vision) | same as above | same | 1 |
| Static visual | template_id, copy, asset refs | `visual.layout@1` → Fabric JSON | `{fabric_json, text_slots, contrast_report}` | safe zone, min contrast 4.5:1, logo present | 2 (+image gen) |
| AI image | prompt, style, aspect, refs | ComfyUI workflow `img.sdxl.brand@1` | `{asset_ids[]}` | NSFW filter, model licence allowed on plan | 4 / image |
| Email | goal, audience, offer | `email.campaign@1` | `{subject[3], preheader, sections[], cta, plain_text}` | subject ≤ 60, link check, unsubscribe placeholder | 3 |
| Blog article | keyword/topic, outline? | `blog.outline@1` → `blog.draft@1` | `{title, meta_desc, outline[], body_md, citations[]}` | meta ≤ 160, every claim cited | 8 |
| X thread | topic | `x.thread@1` | `{tweets[≤15]}` | 280 graphemes each (weighted) | 2 |
| YouTube script | topic, duration | `yt.script@1` | `{title[3], hook, beats[], cta, description, chapters[]}` | duration estimate ±15% | 4 |
| Facebook ad copy | offer, audience | `ads.meta.copy@1` | `{primary_text[3], headline[3], description[3]}` | Meta text limits, prohibited claims list | 2 |
| AI video | script, assets | storyboard → ComfyUI video wf / FFmpeg compose | `{video_asset_id, timeline_json}` | duration/aspect per platform | 20+ (per sec) |
| Multilingual | content_id, target lang | `translate.localize@1` | same schema as source | per-language length, script check | 1 per item |
| Improve / tone / simplify | content_id, instruction | `edit.transform@1` | diff-able body | preserve locked spans | 0.5 |
| Profile assets (pfp, cover, banner, thumbnail, sticker) | brand visuals | Fabric templates + ComfyUI | `{asset_id, size}` | exact pixel sizes per platform | 2–4 |

## 3. Non-generation AI workflows
| Workflow | Engine | Notes |
|---|---|---|
| Website → business profile | Firecrawl map/scrape → Langflow `brand.extract@1` (Haiku) | Each field returns `{value, confidence, source_url, quote}` |
| Strategy (90-day) | `strategy.90day@1`, premium tier; weeks/channels/capacity/moments given as fixed inputs | Draft → `normalizeDraft` (deterministic fixes, recorded) → editable revisioned plan |
| Weekly topics | `strategy.weekly_topics@1`, standard tier; code allocates slots, model fills one topic per slot | Banned words flagged; never auto-approved when flagged |
| Knowledge summary / tags | Haiku | Per source |
| Edit learning | Diff of AI draft vs approved version → classify edit type (tone/length/fact/CTA) | Feeds `learning_signals`; proposals require human approval |
| Evaluation | Langfuse datasets per template; LLM-as-judge rubric + deterministic checks | Gate for promoting `template@N+1` |

## 4. Human-edit preservation & selective regeneration
- Content stored as TipTap JSON with span marks `{origin: "ai"|"human", locked?: boolean}`.
- Each content_version stores `brand_context_hash` and the list of Brand Kit fact ids it used (`depends_on_facts[]`).
- On Brand Kit change → `affected = content where depends_on_facts ∩ changed_facts ≠ ∅ and status in (draft, in_review)` → user sees a list → regenerate only AI spans; human spans are passed as fixed context.
