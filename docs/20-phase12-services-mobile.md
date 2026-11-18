# 20 — Phase 12: Human-finished services and mobile

> Hardening and launch verification (web push, email, ops view, leak fixes, end-to-end evidence) are in [docs/21](21-phase12-launch-verification.md).

Two parts:
- **Services**: customers hand work to Arcatic's service team and approve the result. The flow is intake → brief → assignment → work → internal review → delivery → approve / revise → billing.
- **Mobile**: an installable PWA (`/m`) for approvals, quick generation, calendar review, asset browsing and publishing status, backed by mobile-ready APIs that a later native app can use unchanged.

No repository in the project folder provides a service marketplace, staff desk or push delivery. Everything in this phase is custom code on the existing stack: Supabase, Hono, Temporal, Next.js and the credit ledger.

## 1. Services: the workflow

| Step | Who | What happens |
|---|---|---|
| **Intake** | customer (`content.create`) | Pick an offering, then fill its form. The form is defined per offering in `service_offerings.intake_fields` and validated by `validateIntake`. Optionally add a draft to finish and reference files. The request can be saved as a draft. |
| **Brief + price** (submit) | customer | 1. The form is fully validated.<br>2. The brief is assembled and **frozen** on the request (`buildServiceBrief`): answers, Brand Kit essentials (voice, banned words, audiences, offers, colours, fonts, disclaimers, claims policy), the source draft text and acceptance criteria. Deterministic, no AI.<br>3. The price is fixed and the credits are **held** (`reserve_credits`, 60-day hold, idempotent per request).<br>4. The due date is set from the turnaround and managers are notified. |
| **Assignment** | manager | Assigns a specialist from a list that ranks staff by skill match and spare capacity (`rankSpecialists`). Managers can reassign before work starts, or unassign. |
| **Work** | assigned specialist | **Start** creates the round's deliverable. Round 1 starts from the customer's draft; later rounds start from the last delivery. The specialist edits text in the same block editor customers use, uploads files to a private bucket (signed uploads; images, video, audio, PDF and zip; up to 200 MB) and writes a note to the customer. |
| **Internal review** | manager | When the offering requires QA, **hand in** goes to QA. **Approve & deliver**, or **return** with a required note, which becomes an internal message to the specialist. Customers never see QA as a step. |
| **Delivery** | — | The customer is notified (requester + owners, admins, editors and reviewers). The delivery shows the text read-only plus files via 1-hour signed links. |
| **Revision** | customer (`approval.decide`) | Must say what should change. Included revisions are free. Beyond that, `extra_revision_credits` are held separately. The revision gets half the original turnaround (at least 24 h, at most 72 h) and goes back to the same specialist. |
| **Approval + delivery into the workspace** | customer (`approval.decide`) | Text becomes a **new version of the source content item** (`origin: human`, `transform: service`) if it can still be edited; otherwise a new draft item with `source_ref.kind = "service"`. Files are copied into the **media library** (`source: service`). Then the held credits are **charged**: the base price plus every paid revision. Rating and feedback are optional. |
| **Cancel** | customer or manager | Possible only before work starts (draft / submitted / assigned). Every hold is released. After work starts, the customer messages the team instead. |

**Status machine**: draft → submitted → assigned → in_progress → (in_review) → delivered → approved, with revision_requested looping back to in_progress. It is enforced twice:
- in `transitionAllowed` (who may move a request where);
- in the database trigger `guard_service_status` (which moves exist at all).

A test parses the SQL so the two can't drift. Every move also bumps `lock_version`, and the API updates with `eq(lock_version)`, so concurrent clicks give a 409 instead of a lost update.

**Catalogue**: placeholder prices in credits; edit the `service_offerings` rows.

| Offering | Credits | Turnaround | Revisions included | Delivers |
|---|---|---|---|---|
| Human polish (finish my draft) | 25 | 48 h | 1 (+5 each) | text |
| Expert-written article | 120 | 5 days | 2 (+20) | text (blog) |
| Caption pack | 60 | 72 h | 1 (+10) | text (document) |
| Design finish | 40 | 48 h | 2 (+8) | files |
| Short video edit | 150 | 5 days | 1 (+30) | files |
| Ad copy & compliance review | 30 | 24 h | 1 (+6) | text, no QA |

## 2. Services: access and privacy

- **Service staff are not workspace members.** `service_staff` lists managers and specialists, managed only through the admin API: `PUT /admin/service-staff` with `ADMIN_API_TOKEN`; the person must have signed up.
- **Specialists** see only requests assigned to them, through RLS and the API. What they see:
  - the frozen brief;
  - the intake answers;
  - the customer's draft text;
  - reference files, through 1-hour signed links;
  - the conversation, including internal notes.

  The RLS smoke test proves they **cannot** read brands, content, the media library or anything else in the workspace.
- **Managers** see every submitted request (never customer drafts) and the team.
- **Customers** see their brand's requests, but never internal notes, work in progress, credit-hold ids, the assignee's identity, or QA steps. "Assigned to X" notes are blanked in their timeline.
- **Writes** all go through the API. A database check prevents customer messages from being marked internal.
- **Audit**: status and assignee changes, and every staff change, are audited.
- **Data retention**: deliverables in `service-files` stay as the record of the work. Approved files are copied into the customer's library.
- **Contracts**: a processor agreement covering the service team is needed before launch (see §6).

## 3. Billing

Credits are the unit (Phase 10 wallet):

| Moment | Credit effect |
|---|---|
| Submit | Hold the price (60 days) |
| Paid revision | One additional hold per paid revision |
| Approve | Settle the base price and each revision hold |
| Cancel | Release every hold |

`billing-maintenance` runs every 15 minutes. For services it:
- **first extends** holds on open or delivered requests that would expire within 7 days (`extend_reservation`, which never shortens a hold), so a long job never loses its hold;
- then expires other stale holds.

Customers get no automatic approval: delivered work waits for the customer, with reminders every 3 days. Specialist payouts are outside Arcatic (see §6).

## 4. Mobile: PWA and mobile-ready APIs

**PWA** (`/m`, the manifest's `start_url`):
- **Bottom tabs**: Inbox, Create, Calendar, Media, Status. Touch targets are at least 44 px and safe-area insets are respected.
- **Inbox**: content approvals (approve or request changes in place), service deliveries, and ad requests. Ad requests open the same typed-confirmation dialog as on desktop.
- **Create**: brand → type → channel → topic → generate. Short-form types only, with the price shown.
- **Calendar**: the next 14 days by day.
- **Media**: search, kind filter, a 3-column grid, "Load more".
- **Status**: All / Failed / Upcoming / Published, with Retry for failed or missed posts.
- **Notifications** bell, here and in the desktop sidebar, live over Supabase realtime.
- **Install pieces**: manifest with any + maskable icons (192 / 512) and shortcuts; apple-touch-icon; `viewport-fit=cover`; light / dark theme colours.

**Service worker** (`public/sw.js`):
- **Cached**: only Next's immutable build assets, icons, the manifest and `/offline`.
- **Pages**: network-only, with the offline page as fallback.
- **API, Supabase and signed media URLs**: never intercepted or cached.

A simulation of its fetch handler confirms this routing. Push display and click handlers are present, but **sending** push is not built (see §6).

**Mobile-ready API**: these are new endpoints; existing endpoints already used bearer auth, idempotency keys and stable error codes.

| Endpoint | Purpose |
|---|---|
| `GET /v1/workspaces/:ws/inbox` | Approvals, deliveries and ad requests in one call, filtered to what the role can act on and the brands the member can see (`canDecide` flags) |
| `GET /v1/workspaces/:ws/agenda?from&to&brandId&cursor&limit` | Schedules across brands, cursor = `publish_at` |
| `GET /v1/workspaces/:ws/publishing/status?status=failed\|active\|published\|missed&cursor` | Outcomes, newest first |
| `GET /v1/workspaces/:ws/quick-create/options` | Brands (with kit-ready flag), short-form types, channels, prices |
| `GET /v1/me/notifications?unread=1&cursor`, `POST /v1/me/notifications/read {ids\|all}` | The person's feed and unread count |
| `POST /v1/me/devices`, `DELETE /v1/me/devices/:id` | Register a Web Push subscription now (FCM / APNs tokens later) |

Media and content lists already had cursor pagination.

## 5. Verification

| Check | Result |
|---|---|
| core (198) | lifecycle = SQL guard (parsed), who-may-move rules, customer stages, due / revision dates, revision pricing, specialist ranking, intake validation, brief contents |
| api (115) | intake drops unknown fields, contributors can request, viewers and API keys can't; submit freezes the brief and holds 60 days; incomplete forms / non-drafts refused; cancel releases every hold, refused once started; customers never see holds / assignee / internal steps; free vs paid revisions; approve lands content then settles base + revisions; desk hidden from non-staff (404); specialists only reach their own requests; assign → start (from customer draft) → QA; empty hand-in refused; specialists can't QA; QA delivery notifies customers; upload type / round checks; staff only via admin token; inbox per role; agenda / status cursors; quick-create prices; notifications and devices are per person |
| jobs (66) | hold extension only near expiry, overdue reminders (assignee + managers, deduped daily), slow-approval reminders every 3 days, never "overdue" once delivered; maintenance extends before expiring |
| RLS smoke §23 | transitions guarded, assignee required, lock version, scope inheritance, internal notes can't be customer-authored, notification dedupe, hold extension (never shortens, refuses released holds, not callable by clients); customer / specialist / other specialist / manager / viewer visibility exactly as §2 |
| `next build` | passes (Services, request page, Service desk, `/m` hub, `/offline`) |
| PWA (production server) | manifest linked and parsed (standalone, start_url, any + maskable icons), theme colours, apple icon, viewport; `sw.js` served with a JS content type and passes `node --check`; fetch-routing simulation caches only build assets |

**Not verified**:
- **Service-worker registration in a real browser.** The in-app browser pane refuses service-worker registration for any site, and there is no Lighthouse run. The build plan's "Lighthouse PWA ≥ 90" also predates Lighthouse 12, which removed the PWA category. Check installability in Chrome DevTools (Application → Manifest / Service workers) on staging over https.
- **The full request → delivery → billing loop against a live Supabase.** This needs the `service-files` storage bucket, which the migration creates when `storage.buckets` exists.

## 6. Gaps and decisions

- ~~Push sending is not built.~~ Built in the hardening pass (docs/21). Devices are stored and the service worker can show pushes, but sending needs VAPID keys and Web Push payload encryption (e.g. the `web-push` npm library) or FCM / APNs for a native app. Proposed adapter: `packages/integrations/push.ts` called from `notify()`.
- ~~Email for service events isn't sent.~~ Built in the hardening pass (docs/21). Mautic (Phase 7) could send these as transactional mail via a new template.
- **No AI brief.** The brief is assembled deterministically, with no AI drafting, so customers aren't charged twice. An optional "tidy my request with AI" step could come later.
- **Payouts, contracts and time tracking** for specialists are not in Arcatic; use payroll / contractor tooling. Before using external contractors, add a data-processing agreement with them and a customer-facing disclosure.
- **Ratings** are stored but not yet reported to managers.
- **Native app**: a later phase. It uses the same `/v1` endpoints with bearer tokens; deep links follow the same paths as the web app.
