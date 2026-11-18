# 02 — Product Requirements & Information Architecture

## 1. Product
**Arcatic Marketing OS** turns a business's website, documents, media and goals into a brand-aware marketing engine that plans, creates, publishes, measures and improves — with a human in control of every outbound action.

**Differentiators (original to Arcatic)**
1. **Brand Context with provenance** — every brand fact carries a source citation, confidence and approval state; every generated asset records the exact Brand Context version it used.
2. **Selective regeneration** — when a brand fact changes, Arcatic computes which drafts depend on it and offers to regenerate only those, never overwriting human-edited spans.
3. **Deterministic guardrails** — banned words, platform limits, required disclosures, link checks run as code, not prompts; results shown as a "Ready-to-ship" checklist.
4. **Transparent credits** — cost preview before every run, hold → settle → refund visible in the ledger.
5. **Bilingual from day one** — Telugu + English generation, with script-aware length counting.

## 2. Personas
| Persona | Need | Key surfaces |
|---|---|---|
| Owner-operator (SMB) | "Post consistently without hiring" | Onboarding, Weekly Plan, Quick Create, Approvals (mobile) |
| Marketing manager | Plan campaigns, control quality | Strategy, Campaigns, Calendar, Analytics |
| Agency lead | Many brands, client approvals | Workspace switcher, per-brand roles, client reviewer role, reports |
| Content creator | Produce & edit fast | Editors, Media library, Video editor |
| Client reviewer | Approve without learning the tool | Approval links, mobile approvals |

## 3. Tenancy model
`organization` (billing entity) → `workspace` (team space; credits, plan, connected accounts) → `brand` (Brand Kit, knowledge, campaigns).
A user can belong to many workspaces with one role each, optionally narrowed per brand via `brand_members`.

**Roles**: `owner`, `admin`, `editor`, `contributor`, `reviewer`, `viewer`. Permission matrix lives in `packages/core/src/rbac.ts` and in the `role_permissions` table (kept in sync by a migration).

## 4. Functional requirements by module (abbrev.; acceptance criteria in `09-build-plan.md`)
| Module | Must | Should | Later |
|---|---|---|---|
| Foundation | Auth, orgs, workspaces, brands, members, roles, API keys, audit log, storage, jobs | SSO (SAML) | SCIM |
| Onboarding | Business wizard, website analysis, Brand Kit draft | Competitor scan | Social account voice import |
| Brand Kit | Profile, voice, visuals, rules, versions, citations, approvals | AI suggestions w/ confidence | Multi-locale kits |
| Knowledge | URL, crawl, docs, text notes, media transcripts, tags, freshness | Google Drive | Social reference sources |
| Strategy | 90-day plan, weekly plan, pillars, channel mix | Seasonality calendar (IN festivals) | Budget allocation |
| Campaigns | CRUD, topics, schedule generation, pause/resume/cancel | Concurrent campaigns view | A/B campaign variants |
| Create | Social, captions, email, blog, images, multilingual | Video, ads copy, scripts, threads | Product photo studio |
| Review | Versions, diff, approvals, comments | Client approval links | SLA timers |
| Media | Library, folders, tags, search, URL import | Drive import | Auto-tagging |
| Video | Timeline, trim/split, overlays, audio, render | Captions burn-in | AI b-roll |
| Publish | Calendar, Postiz channels, approval gate, retries | GBP, WordPress | Ads publishing |
| Analytics | Social + web + email summaries, drill-down | Recommendations | Attribution |
| Learning | Signal capture, edit diffs, evals | Voice refinement proposals | Auto-tuning per channel |
| Commercial | Plans, credits, top-ups, invoices, limits | Agency seats | Reseller |

## 5. Information architecture

```
/sign-in, /sign-up, /invite/:token
/onboarding/{business, goals, audience, website, channels, review}
/w/:workspace
  /home                     Today: approvals waiting, scheduled today, failures, credits, next actions
  /brands                   Brand list (+ create)
  /b/:brand
    /kit                    Brand Kit tabs: Profile · Voice · Visuals · Audience · Offers · Rules · Channels · History
    /knowledge              Library: Sources · Notes · Media transcripts · Search (semantic)
    /strategy               90-day plan · Pillars · Channel mix · Metrics
    /campaigns              List · Board · /campaigns/:id (Brief · Topics · Content · Schedule · Results)
    /create                 Quick Create · Wizards (Phase 9) · /create/:contentId (editor)
    /review                 Approval queue · diffs · comments
    /calendar               Month/Week/List; filters by channel/status/campaign
    /media                  Library · Collections · /media/video/:projectId (editor)
    /analytics              Overview · Channels · Content · Campaigns · Insights
  /settings
    /general, /members, /roles, /channels (connected accounts), /api-keys,
    /billing (plan, credits, ledger, invoices), /usage, /audit-log, /jobs
/admin (internal staff; separate role)
```

## 6. Screen-by-screen (Phase 1–2 detail; later phases summarised)

| Screen | Purpose | Key components | Empty / error states | Mobile |
|---|---|---|---|---|
| Sign in / up | Supabase email+magic link, Google OAuth | AuthForm | invalid link, rate-limited | ✓ |
| Workspace create | Name, slug, country/currency, default language | Form, slug check | slug taken | ✓ |
| Workspace switcher | Jump between workspaces/brands | Command palette (⌘K) | none | sheet |
| Home | Prioritised action feed | ActionCard, JobTicker, CreditMeter | "Add your first brand" | ✓ primary |
| Brands list | Grid of brands with health score | BrandCard (kit completeness %) | CTA create | ✓ |
| Brand Kit | Edit facts with citations | FactField(value, source chips, confidence badge, approve) , VersionDrawer | "Analyze website" CTA | read + approve |
| Members | Invite, role change, remove | MemberTable, InviteDialog | last-owner guard | ✓ |
| API keys | Create (shown once), revoke, scopes | KeyTable | — | — |
| Jobs | Live list of background jobs | JobRow(progress, retry, cancel), filters | — | ✓ |
| Billing | Plan, wallet, ledger, top-up | PlanCard, LedgerTable, CostEstimator | payment failed banner | view |
| Audit log | Who did what | Filterable table, export CSV | — | — |
| Create editor (P5) | Edit generated content | TipTap, Ready-to-ship checklist, VariantRail, CostPreview, VersionHistory | generation failed → retry w/ refund note | quick edits |
| Calendar (P7) | Plan + publish status | Month/week grid, drag to reschedule, status chips | channel disconnected | list view |

**Design system**: Tailwind tokens in `packages/ui/tokens.ts` (neutral slate base, one accent `--accent` per brand theme, 4-pt spacing, Inter + Noto Sans Telugu). Components follow shadcn/Radix patterns (accessible, keyboard-first). No Blaze.ai visuals, copy, or flow replicas.
