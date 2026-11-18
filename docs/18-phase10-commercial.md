# 18 — Phase 10: SaaS commercial layer

**Lago** bills: customers, subscriptions, invoices, payment collection through the provider connected in Lago, and usage events. **Arcatic** owns the credit wallet, reservations, refunds, top-up crediting and every entitlement check. Nothing Arcatic does depends on Lago being up, except changing plans or buying credits.

## 1. What was verified, and where

The `lago-main/api` folder is an empty submodule, so the REST contract was checked against **Lago's published OpenAPI spec** (`swagger.getlago.com/openapi.yaml`) and API reference pages. The local `events-processor` confirmed the usage-event fields.

| Call | Verified shape |
|---|---|
| `POST /api/v1/customers` | upsert by `external_id`; `billing_configuration.{payment_provider, payment_provider_code, sync_with_provider}`; providers: stripe, adyen, **cashfree**, flutterwave, gocardless, moneyhash |
| `POST /customers/{id}/checkout_url` · `GET /customers/{id}/portal_url` | `customer.checkout_url` · `customer.portal_url` |
| `POST /subscriptions` | same `external_id` + new `plan_code` = plan change; downgrades become `pending` until period end (`next_plan_code`, `downgrade_plan_date`) |
| `PUT /subscriptions/{external_id}` | `ending_at` (cancel at period end, or `null` to undo) |
| `POST /invoices` | one-off: `fees[{add_on_code, units, unit_amount_cents, description}]` |
| `POST /events/batch` | ≤ 100 events `{transaction_id, external_subscription_id, code, timestamp (unix s), properties}`; `transaction_id` is the idempotency key |
| `POST /billable_metrics` · `/add_ons` · `/plans` | used by `pnpm lago:setup` (plan requires name, code, interval, amount_cents, amount_currency, pay_in_advance) |
| Webhooks | `X-Lago-Signature` = base64 HMAC-SHA256 of the raw body when the endpoint uses `hmac`; `X-Lago-Unique-Key` per delivery; invoice `payment_status` pending / succeeded / failed; subscription status active / canceled / incomplete / pending / terminated |

**Payments**: Lago charges through the provider connected in Lago. For INR, Lago lists **Cashfree** (the default in `.env.example`); Stripe and others also work. Arcatic never handles card or UPI data. The old `STRIPE_*` variables are not used.

## 2. Plans, limits and enforcement

- **Plans** (`plans`): trial (100 credits, 14 days), Starter, Growth, Agency, plus a non-public Enterprise. Each has monthly credits, a price, counted limits (brands, seats incl. pending invites, switched-on connected accounts) and features (video). **The seeded prices are placeholders; set your own**, then run `pnpm lago:setup`.
- **Counted limits** are enforced where things are added: brand create, invite, account connect/enable (Phases 1 and 7). `entitlement_usage()` reports current use for the billing page and downgrade checks.
- **Features**: final video renders need a plan with `video` (402 with the plan name otherwise).
- **Spend gate**: every job that reserves credits first checks the subscription (`billingState`):
  - **active**: allowed. If a cancellation is scheduled, a warning is shown.
  - **trialing / awaiting first payment**: allowed until the trial or period end.
  - **past_due**: allowed for a **7-day grace** with a warning, then blocked.
  - **cancelled / paused**: blocked.
  - Reading, editing, approving and publishing already-approved content keep working.
  - A banner shows the state across the workspace.

## 3. Lifecycle

| Action | Lago | Arcatic |
|---|---|---|
| Start a paid plan (from trial or after cancelling) | upsert customer (workspace id, owner email, INR, provider) → assign plan | plan limits apply now; status `incomplete` until the first invoice is paid |
| Upgrade | assign higher plan (Lago bills the prorated difference) | limits now; credits when that invoice is paid |
| Downgrade | assign lower plan → pending until period end | **refused while over the smaller plan's limits** (lists what to remove); otherwise `pending_plan_key` shown; switches on `subscription.started` / `updated` |
| Cancel | `ending_at` = period end | `cancel_at_period_end`; access until then; credits stay in the wallet |
| Reactivate | before the end: `ending_at: null`; after: new subscription | status back to active / incomplete |
| Payment method / invoices | checkout URL / customer portal | buttons on Settings → Billing |

**Credits for a paid subscription invoice** = `floor(monthly_credits × min(1, fees_amount_cents ÷ plan price))`, granted once per invoice (`grant`, reference `invoice:<lago_id>`). A full month grants the month's credits, and Lago's prorated upgrade invoice grants the prorated share, without Arcatic recomputing proration. Taxes don't count.

**Credit packs** (₹ placeholders: 200 / 1,000 / 5,000 credits) never expire and are available on paid plans:
1. A `credit_topups` row is stored first (idempotent per request key).
2. A one-off Lago invoice is created with the pack's add-on.
3. On `payment_status = succeeded` the pack is credited once (`topup:<lago_id>`).
4. A 15-minute reconciliation catches a payment that lands before the invoice id was saved.

**Refunds**: `refund_credits(reservation, amount, reason)` returns part or all of a *settled* charge. It is bounded by what was charged, linked to the charge in the ledger, and recorded as a negative usage event so Lago usage matches. It's staff-only (`POST /admin/workspaces/:ws/credits/refund`, `ADMIN_API_TOKEN`), as is `…/credits/adjust`. Automatic refunds already happen in jobs: failed or cancelled jobs release their hold and charge nothing. Money refunds for top-ups are done as credit notes in Lago.

## 4. Metering and maintenance

- Every settled charge writes a `usage_events` row (since Phase 1). Every 15 minutes (`billing-maintenance` schedule) they're sent to Lago in batches of 100 as `arcatic_credits` (sum of `credits`), keyed by the ledger's transaction id. The same run expires stale credit holds and reconciles top-ups.
- **Credits are prepaid in Arcatic.** The Lago metric is for usage reporting and revenue analytics, not overage billing (Arcatic never lets a wallet go negative).

## 5. Webhooks

`POST /webhooks/lago` (outside `/v1`, no user auth):
- **HMAC required**: anything not signed with `LAGO_WEBHOOK_SECRET` is a 401.
- **Stored once**: each delivery goes into `billing_events` (unique `X-Lago-Unique-Key`, no client access at all).
- **Processed synchronously**: invoices are mirrored, credits granted, plan, status and period updated.
- **Retries**: a processing error returns 5xx so Lago retries.

## 6. API (under `/v1/workspaces/:ws` unless noted)

| Method | Path | Permission |
|---|---|---|
| GET | `/billing`, `/billing/usage?days=` | billing.read |
| POST | `/billing/plan {planKey}`, `/billing/cancel`, `/billing/reactivate`, `/billing/payment-method`, `/billing/topups {packKey}` (idempotent) | billing.manage (owners) |
| GET | `/billing/portal` | billing.read |
| POST | `/webhooks/lago` | HMAC signature |
| POST | `/admin/workspaces/:ws/credits/{refund,adjust}` | `ADMIN_API_TOKEN` (≥ 32 chars; the route 404s without it) |

Existing team pieces from Phase 1 complete the commercial layer:
- multi-brand workspaces, invites with roles and brand restriction, role changes, owner protection;
- API keys and the credit estimate endpoint (`/credits/estimate`).

## 7. Verification

| Check | Result |
|---|---|
| core (158) | change kinds, downgrade blockers, credits per invoice (full / prorated / capped / free), spend gate for every status incl. grace |
| integrations (30) | Lago paths, auth and payload shapes; ≤ 100-event batches; HMAC verify (good, tampered, wrong key, missing) |
| jobs (48) | webhook processing: paid subscription invoice → credits + period; prorated upgrade; top-up credited once; failed top-up; past-due; downgrade pending; terminated-with-replacement vs cancelled; unknown customers. Usage sync batching; top-up reconciliation |
| api (80) | upgrade / start / downgrade blocked or scheduled; owners only; Lago not configured; cancel / reactivate; top-ups (trial refused, invoice created, replay safe); webhook signature and single processing; admin token; spend gate (trial ended, cancelled); video feature gate |
| RLS smoke §21 | refunds bounded and linked, ledger still immutable, held reservations not refundable, usage counts, webhook inbox unreadable by clients, top-ups visible only with billing.read |
| `next build` | passes (Settings → Billing) |

**Not verified**: no Lago instance or payment provider was called. The full upgrade / downgrade / cancel / reactivate / top-up loop needs a staging run with Lago and the provider in test mode (the build plan's acceptance criterion).

## 8. Gaps and decisions

- **Prices and pack sizes are placeholders.** GST / tax setup is done in Lago (taxes are excluded from the credits formula).
- **Plan credits don't expire or reset monthly** (simplest fair rule). An `expiry` ledger kind exists if you later want use-it-or-lose-it.
- **Yearly plans** aren't seeded; Lago supports `interval: yearly` via the same setup script with a new plan row.
- **Seats** count members plus pending invites; there is no per-seat pricing.
- **Enterprise / custom contracts** are handled manually (plan row + Lago plan overrides).
