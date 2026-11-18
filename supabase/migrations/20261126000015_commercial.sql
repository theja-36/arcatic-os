-- Arcatic Marketing OS — 0015 SaaS commercial layer (Phase 10)
-- Lago: customers, subscriptions, invoices, payment collection, usage events.
-- Arcatic: credit ledger, reservations, refunds, top-up crediting, entitlement enforcement.

-- ---------------------------------------------------------------------------
-- Plans: display order, features, Lago codes
-- ---------------------------------------------------------------------------
alter table public.plans
  add column sort      int not null default 0,
  add column features  jsonb not null default '{}'::jsonb,     -- {"video":true,"ads_analytics":true,...} shown on the pricing page
  add column topups    boolean not null default true;
update public.plans set sort = case key when 'trial' then 0 when 'starter' then 1 when 'growth' then 2 when 'agency' then 3 else 9 end;
update public.plans set lago_plan_code = 'arcatic_' || key where lago_plan_code is null and key in ('starter','growth','agency');
update public.plans set topups = false where key = 'trial';

-- ---------------------------------------------------------------------------
-- Credit packs (one-off purchases through a Lago add-on invoice)
-- ---------------------------------------------------------------------------
create table public.credit_packs (
  key               text primary key,
  name              text not null,
  credits           numeric(12,3) not null check (credits > 0),
  price_minor       bigint not null check (price_minor > 0),
  currency          text not null default 'INR',
  lago_add_on_code  text not null unique,
  active            boolean not null default true,
  sort              int not null default 0
);
insert into public.credit_packs (key, name, credits, price_minor, currency, lago_add_on_code, sort) values
  ('pack_200',  '200 credits',   200,  24900,  'INR', 'arcatic_credits_200',  1),
  ('pack_1000', '1,000 credits', 1000, 99900,  'INR', 'arcatic_credits_1000', 2),
  ('pack_5000', '5,000 credits', 5000, 449900, 'INR', 'arcatic_credits_5000', 3);

create table public.credit_topups (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references public.workspaces(id) on delete cascade,
  pack_key              text not null references public.credit_packs(key),
  credits               numeric(12,3) not null,
  amount_minor          bigint not null,
  currency              text not null,
  status                text not null default 'pending' check (status in ('pending','paid','failed','cancelled')),
  lago_invoice_id       text unique,
  credit_transaction_id bigint references public.credit_transactions(id),
  idempotency_key       text not null,
  requested_by          uuid references public.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  paid_at               timestamptz,
  unique (workspace_id, idempotency_key)
);
create index on public.credit_topups (workspace_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Subscriptions: billing lifecycle bookkeeping
-- ---------------------------------------------------------------------------
alter table public.subscriptions drop constraint subscriptions_status_check;
alter table public.subscriptions
  add constraint subscriptions_status_check check (status in ('trialing','incomplete','active','past_due','cancelled','paused')),
  add column pending_change_at timestamptz,
  add column cancelled_at      timestamptz,
  add column past_due_since    timestamptz,
  add column lago_status       text;

alter table public.invoices
  add column invoice_type text,
  add column payment_status text,
  add column total_paid_minor bigint;
alter table public.invoices drop constraint invoices_status_check;
alter table public.invoices add constraint invoices_status_check check (status in ('draft','finalized','pending','paid','failed','voided'));

-- refunds are tracked against the settled reservation they correct
alter table public.credit_reservations add column refunded_amount numeric(12,3) not null default 0;

-- ---------------------------------------------------------------------------
-- Webhook inbox: every delivery is stored once (X-Lago-Unique-Key) and processed idempotently
-- ---------------------------------------------------------------------------
create table public.billing_events (
  id            bigint generated always as identity primary key,
  provider      text not null default 'lago',
  unique_key    text not null,
  webhook_type  text not null,
  workspace_id  uuid references public.workspaces(id) on delete set null,
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  error         text,
  unique (provider, unique_key)
);
create index on public.billing_events (processed_at) where processed_at is null;

-- ---------------------------------------------------------------------------
-- Refund part or all of a settled charge (support tooling; service role only)
-- ---------------------------------------------------------------------------
create or replace function public.refund_credits(p_reservation uuid, p_amount numeric, p_reason text, p_actor uuid default null)
returns public.credit_transactions
language plpgsql security definer set search_path = '' as $$
declare
  r public.credit_reservations;
  t public.credit_transactions;
  n int;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'validation_failed: amount must be > 0' using errcode = '22023'; end if;
  select * into r from public.credit_reservations where id = p_reservation for update;
  if not found then raise exception 'not_found: reservation %', p_reservation using errcode = 'P0002'; end if;
  if r.status <> 'settled' then raise exception 'conflict: only settled charges can be refunded (this one is %)', r.status using errcode = '23514'; end if;
  if r.refunded_amount + p_amount > coalesce(r.settled_amount, 0) then
    raise exception 'conflict: refund exceeds what was charged (% of % already refunded)', r.refunded_amount, r.settled_amount using errcode = '23514';
  end if;
  select count(*) into n from public.credit_transactions where kind = 'refund' and reservation_id = r.id;
  t := public.grant_credits(r.workspace_id, p_amount, 'refund', 'refund:' || r.id::text || ':' || (n + 1)::text, p_actor);
  update public.credit_transactions set reservation_id = r.id where id = t.id and reservation_id is null;
  select * into t from public.credit_transactions where id = t.id;
  update public.credit_reservations set refunded_amount = refunded_amount + p_amount where id = r.id;
  insert into public.usage_events (workspace_id, metric, quantity, job_id, transaction_id, properties)
  values (r.workspace_id, 'credits', -p_amount, r.job_id, 'refund:' || r.id::text || ':' || (n + 1)::text, jsonb_build_object('reason', p_reason));
  return t;
end $$;
revoke all on function public.refund_credits(uuid, numeric, text, uuid) from public, anon, authenticated;
grant execute on function public.refund_credits(uuid, numeric, text, uuid) to service_role;

-- credit_transactions are immutable except for linking a refund to its reservation (same txn, above)
create or replace function app.forbid_ledger_update() returns trigger
language plpgsql as $$
begin
  if new.kind = 'refund' and old.reservation_id is null and new.reservation_id is not null
     and (to_jsonb(new) - 'reservation_id') = (to_jsonb(old) - 'reservation_id') then
    return new;
  end if;
  raise exception 'credit transactions are immutable' using errcode = '42501';
end $$;
drop trigger credit_transactions_immutable on public.credit_transactions;
create trigger credit_transactions_immutable before update on public.credit_transactions
  for each row execute function app.forbid_ledger_update();

-- ---------------------------------------------------------------------------
-- What a workspace uses against its plan's counted limits (downgrade checks, billing page)
-- ---------------------------------------------------------------------------
create or replace function public.entitlement_usage(p_workspace uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'max_brands', (select count(*) from public.brands where workspace_id = p_workspace and deleted_at is null),
    'max_seats', (select count(*) from public.workspace_members where workspace_id = p_workspace)
               + (select count(*) from public.workspace_invites where workspace_id = p_workspace and accepted_at is null and revoked_at is null and expires_at > now()),
    'max_connected_accounts', (select count(*) from public.connected_accounts where workspace_id = p_workspace and enabled)
  );
$$;
revoke all on function public.entitlement_usage(uuid) from public, anon, authenticated;
grant execute on function public.entitlement_usage(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.credit_packs enable row level security;
alter table public.credit_topups enable row level security;
alter table public.billing_events enable row level security;
create policy credit_packs_read on public.credit_packs for select to authenticated using (active);
create policy credit_topups_select on public.credit_topups for select to authenticated using (app.has_permission(workspace_id, 'billing.read'));
grant select on public.credit_packs, public.credit_topups to authenticated;
grant all on public.credit_packs, public.credit_topups, public.billing_events to service_role;
-- billing_events: no client access at all
revoke all on public.billing_events from anon, authenticated;
