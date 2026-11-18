-- Arcatic Marketing OS — 0004 Plans, subscriptions, credits ledger
-- Arcatic owns the ledger; Lago owns subscriptions/invoices and receives usage events.

create table public.plans (
  key            text primary key,               -- 'starter','growth','agency','enterprise'
  name           text not null,
  monthly_credits numeric(12,3) not null default 0,
  price_minor    bigint,                          -- in smallest currency unit
  currency       text not null default 'INR',
  limits         jsonb not null default '{}'::jsonb, -- {"max_brands":1,"max_seats":2,"max_connected_accounts":5,"video":false}
  lago_plan_code text unique,
  is_public      boolean not null default true,
  created_at     timestamptz not null default now()
);

create table public.subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null unique references public.workspaces(id) on delete cascade,
  plan_key             text not null references public.plans(key),
  status               text not null default 'trialing'
                         check (status in ('trialing','active','past_due','cancelled','paused')),
  current_period_start timestamptz not null default now(),
  current_period_end   timestamptz not null default now() + interval '14 days',
  cancel_at_period_end boolean not null default false,
  pending_plan_key     text references public.plans(key),
  lago_customer_id     text,
  lago_subscription_id text unique,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function app.touch_updated_at();

create table public.invoices (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  lago_invoice_id  text unique,
  number           text,
  status           text not null check (status in ('draft','finalized','paid','failed','voided')),
  amount_minor     bigint not null,
  currency         text not null,
  issued_at        timestamptz,
  pdf_url          text,
  created_at       timestamptz not null default now()
);
create index on public.invoices (workspace_id, issued_at desc);

-- "credits": one wallet per workspace. available = balance - held.
create table public.credits (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  balance      numeric(14,3) not null default 0,
  held         numeric(14,3) not null default 0 check (held >= 0),
  updated_at   timestamptz not null default now()
);

create table public.credit_reservations (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  amount          numeric(12,3) not null check (amount > 0),
  settled_amount  numeric(12,3),
  status          text not null default 'held' check (status in ('held','settled','released','expired')),
  job_id          uuid,
  reason          text,
  idempotency_key text not null,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  closed_at       timestamptz,
  unique (workspace_id, idempotency_key)
);
create index on public.credit_reservations (status, expires_at) where status = 'held';

alter table public.generation_jobs
  add constraint generation_jobs_reservation_fk foreign key (credit_reservation_id)
  references public.credit_reservations(id) on delete set null;

-- Append-only ledger
create table public.credit_transactions (
  id             bigint generated always as identity primary key,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  delta          numeric(12,3) not null check (delta <> 0),
  kind           text not null check (kind in ('grant','topup','debit','refund','adjustment','expiry')),
  reservation_id uuid references public.credit_reservations(id),
  reference      text,           -- job id / lago invoice / stripe payment / admin ticket
  balance_after  numeric(14,3) not null,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  unique (kind, reference)       -- a given external reference is applied once
);
create index on public.credit_transactions (workspace_id, created_at desc);
-- immutable; deletes happen only through workspace purge (service role, cascade)
create trigger credit_transactions_immutable before update on public.credit_transactions
  for each row execute function app.forbid_update();

create table public.usage_events (
  id             bigint generated always as identity primary key,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  metric         text not null,     -- 'credits', 'gpu_seconds', 'llm_tokens_in', 'llm_tokens_out', 'posts_published'
  quantity       numeric(14,3) not null,
  job_id         uuid,
  properties     jsonb not null default '{}'::jsonb,
  transaction_id text not null unique default gen_random_uuid()::text,  -- Lago event idempotency key
  lago_synced_at timestamptz,
  created_at     timestamptz not null default now()
);
create index on public.usage_events (lago_synced_at) where lago_synced_at is null;

-- ---------------------------------------------------------------------------
-- Ledger functions (service role only)
-- ---------------------------------------------------------------------------
create or replace function public.reserve_credits(
  p_workspace uuid,
  p_amount numeric,
  p_idempotency_key text,
  p_job uuid default null,
  p_reason text default null,
  p_ttl interval default interval '2 hours'
) returns public.credit_reservations
language plpgsql security definer set search_path = '' as $$
declare
  w public.credits;
  r public.credit_reservations;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'validation_failed: amount must be > 0' using errcode = '22023';
  end if;

  select * into r from public.credit_reservations
   where workspace_id = p_workspace and idempotency_key = p_idempotency_key;
  if found then
    return r;   -- idempotent replay
  end if;

  select * into w from public.credits where workspace_id = p_workspace for update;
  if not found then
    raise exception 'not_found: wallet for workspace %', p_workspace using errcode = 'P0002';
  end if;
  if w.balance - w.held < p_amount then
    raise exception 'insufficient_credits: available %, required %', w.balance - w.held, p_amount
      using errcode = 'P0001';
  end if;

  insert into public.credit_reservations (workspace_id, amount, job_id, reason, idempotency_key, expires_at)
  values (p_workspace, p_amount, p_job, p_reason, p_idempotency_key, now() + p_ttl)
  returning * into r;

  update public.credits set held = held + p_amount, updated_at = now()
   where workspace_id = p_workspace;
  return r;
end $$;

create or replace function public.settle_reservation(
  p_reservation uuid,
  p_actual numeric,
  p_allow_overrun boolean default false
) returns public.credit_reservations
language plpgsql security definer set search_path = '' as $$
declare
  r public.credit_reservations;
  charge numeric;
  new_balance numeric;
begin
  select * into r from public.credit_reservations where id = p_reservation for update;
  if not found then
    raise exception 'not_found: reservation %', p_reservation using errcode = 'P0002';
  end if;
  if r.status = 'settled' then
    return r;   -- idempotent
  end if;
  if r.status <> 'held' then
    raise exception 'conflict: reservation % is %', p_reservation, r.status using errcode = '23514';
  end if;
  if p_actual is null or p_actual < 0 then
    raise exception 'validation_failed: actual must be >= 0' using errcode = '22023';
  end if;

  charge := case when p_allow_overrun then p_actual else least(p_actual, r.amount) end;

  update public.credits
     set held = held - r.amount,
         balance = balance - charge,
         updated_at = now()
   where workspace_id = r.workspace_id
  returning balance into new_balance;

  if charge > 0 then
    insert into public.credit_transactions (workspace_id, delta, kind, reservation_id, reference, balance_after)
    values (r.workspace_id, -charge, 'debit', r.id, 'reservation:' || r.id::text, new_balance);
    insert into public.usage_events (workspace_id, metric, quantity, job_id, transaction_id)
    values (r.workspace_id, 'credits', charge, r.job_id, 'reservation:' || r.id::text);
  end if;

  update public.credit_reservations
     set status = 'settled', settled_amount = charge, closed_at = now()
   where id = r.id
  returning * into r;
  return r;
end $$;

create or replace function public.release_reservation(
  p_reservation uuid,
  p_reason text default null
) returns public.credit_reservations
language plpgsql security definer set search_path = '' as $$
declare
  r public.credit_reservations;
begin
  select * into r from public.credit_reservations where id = p_reservation for update;
  if not found then
    raise exception 'not_found: reservation %', p_reservation using errcode = 'P0002';
  end if;
  if r.status in ('released','expired') then
    return r;   -- idempotent
  end if;
  if r.status = 'settled' then
    raise exception 'conflict: reservation % already settled; issue a refund instead', p_reservation
      using errcode = '23514';
  end if;

  update public.credits set held = held - r.amount, updated_at = now()
   where workspace_id = r.workspace_id;
  update public.credit_reservations
     set status = 'released', reason = coalesce(p_reason, reason), closed_at = now()
   where id = r.id
  returning * into r;
  return r;
end $$;

create or replace function public.grant_credits(
  p_workspace uuid,
  p_amount numeric,
  p_kind text,
  p_reference text,
  p_actor uuid default null
) returns public.credit_transactions
language plpgsql security definer set search_path = '' as $$
declare
  t public.credit_transactions;
  new_balance numeric;
begin
  if p_kind not in ('grant','topup','refund','adjustment','expiry') then
    raise exception 'validation_failed: kind %', p_kind using errcode = '22023';
  end if;
  select * into t from public.credit_transactions where kind = p_kind and reference = p_reference;
  if found then
    return t;   -- idempotent on (kind, reference)
  end if;

  insert into public.credits (workspace_id) values (p_workspace) on conflict do nothing;
  update public.credits set balance = balance + p_amount, updated_at = now()
   where workspace_id = p_workspace
  returning balance into new_balance;

  insert into public.credit_transactions (workspace_id, delta, kind, reference, balance_after, created_by)
  values (p_workspace, p_amount, p_kind, p_reference, new_balance, p_actor)
  returning * into t;
  return t;
end $$;

create or replace function public.expire_stale_reservations() returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int := 0;
  r record;
begin
  for r in
    select id, workspace_id, amount from public.credit_reservations
     where status = 'held' and expires_at < now()
     for update skip locked
  loop
    update public.credits set held = held - r.amount, updated_at = now() where workspace_id = r.workspace_id;
    update public.credit_reservations set status = 'expired', closed_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.reserve_credits(uuid, numeric, text, uuid, text, interval) from public, anon, authenticated;
revoke all on function public.settle_reservation(uuid, numeric, boolean) from public, anon, authenticated;
revoke all on function public.release_reservation(uuid, text) from public, anon, authenticated;
revoke all on function public.grant_credits(uuid, numeric, text, text, uuid) from public, anon, authenticated;
revoke all on function public.expire_stale_reservations() from public, anon, authenticated;
grant execute on function public.reserve_credits(uuid, numeric, text, uuid, text, interval),
  public.settle_reservation(uuid, numeric, boolean), public.release_reservation(uuid, text),
  public.grant_credits(uuid, numeric, text, text, uuid), public.expire_stale_reservations()
  to service_role;
