# 13 — Phase 5: Content creation engine (implemented; docs to be expanded)

- **Types**: social post, carousel, story, image caption (vision), email, blog, X thread, YouTube script, short-video script, Meta ad copy, static visual, profile assets (picture/cover/banner/thumbnail/sticker), AI image, product photo (`core/content/types.ts`).
- **Content model**: block documents with origin (AI/human) + lock; selective regeneration rewrites only unlocked AI blocks (`core/content/doc.ts`; tested in core, ai and the activity test).
- **Validation**: per-type block limits, channel limits, banned words per block, disclaimers, uncited numeric claims; visual scenes checked for WCAG contrast, safe zones, palette, text size (`validateDoc`, `validateScene`). Failing versions can't be submitted.
- **AI**: 9 templates + one rewrite path (regenerate / transform / tone / translate); vision for captions; model tier selection; reference sources (`search_knowledge_in`).
- **Images**: ComfyUI (contract verified from source), SDXL/FLUX licence registry (`ai_models`), prompt safety gate, credits per image produced.
- **Approvals**: `submit_for_approval` / `decide_approval` (atomic); edits after approval send content back to draft; optional separate approver (`workspaces.settings.requireSeparateApprover`).
- **UI**: Create, Content, Review tabs; block editor with checklist, AI tools, variants, history, provenance; Fabric.js visual editor with PNG export.
- **Not verified**: live Claude/ComfyUI output quality; Fabric export against real Storage CORS; video generation is deferred to Phase 6 (scripts only). TipTap rich text is not used yet — the block editor uses plain text per block.
