# 05 — Credits & Billing Model

## Principles
1. **Arcatic owns the credit ledger** (Postgres). Lago owns plans, subscriptions, metered invoicing, and payment-provider sync. Lago is never on the synchronous path of a generation.
2. Ledger is **append-only**; balances are derived and cached in `credit_wallets` under row lock.
3. Every expensive action: **estimate → reserve (hold) → settle (actual) or release**.

## Tables (see migration `0004_billing.sql`)
- `credit_wallets(workspace_id, balance, held)` — `available = balance - held`.
- `credit_reservations(id, workspace_id, amount, status: held|settled|released|expired, job_id, expires_at, idempotency_key)`
- `credit_transactions(id, workspace_id, delta, kind: grant|topup|debit|refund|adjustment|expiry, reservation_id, reference, balance_after)`
- `usage_events(workspace_id, metric, quantity, job_id, lago_synced_at)` → batched to Lago `/events`.

## SQL functions (security definer, service-role only)
| Function | Behaviour |
|---|---|
| `reserve_credits(ws, amount, job_id, idem_key, ttl)` | `SELECT … FOR UPDATE` wallet; if `available < amount` raise `insufficient_credits`; insert reservation; `held += amount`. Same `idem_key` returns the existing reservation. |
| `settle_reservation(res_id, actual)` | `actual ≤ amount` (over-run capped at reservation unless `allow_overrun`); `held -= amount`, `balance -= actual`; insert `debit` txn; status settled. Idempotent. |
| `release_reservation(res_id, reason)` | `held -= amount`; status released; no txn row except audit. Idempotent. |
| `grant_credits(ws, amount, kind, ref)` | Plan grant / top-up / adjustment. |
| `expire_stale_reservations()` | Cron: releases holds whose job never finished (`expires_at < now()`). |

## Pricing units
1 credit ≈ fixed internal cost basket. Base costs per type in `04-ai-workflows.md`; multipliers: model tier (Haiku ×0.5, Sonnet ×1, Opus ×3), image resolution, video seconds, language (+0 for translation of own content).
Cost preview always shows `estimate` and `max`; reservation = `max`; settle = actual tokens/GPU-seconds converted.

## Plans (proposal — numbers to validate with market)
| Plan | Monthly credits | Brands | Seats | Connected accounts | Notes |
|---|---|---|---|---|---|
| Starter | 300 | 1 | 2 | 5 | No video gen |
| Growth | 1,500 | 3 | 5 | 15 | Video, email |
| Agency | 6,000 | 15 | 20 | 75 | Client reviewers, dedicated Mautic |
| Enterprise | custom | custom | custom | custom | SSO, SLA |

Monthly grants expire at period end (`expiry` txn); top-ups never expire within 12 months.
Entitlements live in `plans.limits jsonb` and are checked in `packages/core/src/entitlements.ts` + DB constraints/triggers where cheap (e.g. brand count).

## Lifecycle
- **Upgrade**: immediate; prorated by Lago; credit delta granted immediately.
- **Downgrade**: at period end; if over limits → workspace enters "over limit" (read-only for extra brands; no deletion).
- **Cancel**: at period end; data kept 90 days; reactivation restores.
- **Payment failure**: Lago/Stripe webhook → `subscriptions.status = past_due` → generation blocked after 7-day grace; publishing of already-approved posts continues.

## Growth-suite costs (Phase 9, `packages/core/src/credits.ts`)
| Kind | Credits (standard tier) |
|---|---|
| Newsletter / press release / sales sheet | 3 |
| Case study | 5 |
| Landing-page copy / AI document | 4 |
| Creative brief / product copy | 2 |
| Idea list (brainstorm) | 1 |
| Repurpose digest | 2 (+ each output at its normal price; only written outputs are charged) |

## Phase 10 lifecycle (docs/18)
Plan credits are granted per **paid** subscription invoice in proportion to the plan fee billed (handles Lago's prorated upgrades); credit packs are credited on payment of their one-off invoice; refunds of settled charges go through `refund_credits` (staff tooling) and are mirrored as negative usage events; usage is sent to Lago every 15 minutes as `arcatic_credits`. Paid work is blocked after a trial ends, after a 7-day past-due grace, and when cancelled.


## Phase 11 credit kinds (docs/19)

| Kind | Base credits |
|---|---|
| `research.keywords` | 2 |
| `research.competitor` | 3 (up to 6 pages) |
| `seo.brief` | 3 (an SEO article = brief + `generate.blog` 8 = 11) |
| `ads.draft` | 3 |

The SEO report and the ads compliance check are deterministic and free. Ad spend is billed by Google or Meta to the customer's own ad account, never through Arcatic credits.


## Phase 12: human-finished services (docs/20)

Services are priced in credits per offering (placeholders in `service_offerings`).

| Moment | Credit effect |
|---|---|
| Submit | Hold the price for 60 days |
| Paid revision | One extra hold per revision beyond those included |
| Approve | Settle the base price and every revision hold |
| Cancel before work starts | Release every hold |

The 15-minute maintenance run extends holds of open work before stale holds expire. There is no automatic approval.
