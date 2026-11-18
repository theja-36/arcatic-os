-- Arcatic Marketing OS — 0009 Strategy & campaign engine (Phase 4)

-- ---------------------------------------------------------------------------
-- Strategies: editable plan document with optimistic concurrency + immutable revisions
-- ---------------------------------------------------------------------------
create table public.strategies (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null,
  brand_id             uuid not null,
  title                text not null,
  status               text not null default 'draft' check (status in ('generating','draft','active','archived','failed')),
  starts_on            date not null,
  ends_on              date not null,
  inputs               jsonb not null default '{}'::jsonb,   -- goals, channels, constraints, budget notes
  plan                 jsonb,                                -- StrategyPlan (packages/core/src/strategy)
  revision             int not null default 0,
  validation           jsonb,                                -- deterministic fixes applied to the AI draft
  brand_kit_version_id uuid references public.brand_kit_versions(id) on delete set null,
  generation_job_id    uuid references public.generation_jobs(id) on delete set null,
  source_chunk_ids     uuid[] not null default array[]::uuid[],
  model                text,
  prompt_template      text,
  created_by           uuid references public.users(id) on delete set null,
  activated_by         uuid references public.users(id) on delete set null,
  activated_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (id, workspace_id),
  check (ends_on > starts_on),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create index on public.strategies (brand_id, created_at desc);
create unique index strategies_one_active on public.strategies (brand_id) where status = 'active';
create trigger strategies_touch before update on public.strategies
  for each row execute function app.touch_updated_at();

create table public.strategy_revisions (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null,
  brand_id     uuid not null,
  strategy_id  uuid not null,
  revision     int not null,
  origin       text not null check (origin in ('ai','human')),
  plan         jsonb not null,
  changed_paths text[] not null default array[]::text[],
  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (strategy_id, revision),
  foreign key (strategy_id, workspace_id) references public.strategies(id, workspace_id) on delete cascade
);
create trigger strategy_revisions_scope before insert on public.strategy_revisions
  for each row execute function app.inherit_scope('strategies', 'strategy_id');
create trigger strategy_revisions_immutable before update on public.strategy_revisions
  for each row execute function app.forbid_update();

-- Save a plan edit atomically: revision check + snapshot. Returns the new revision.
create or replace function public.save_strategy_plan(p_strategy uuid, p_base_revision int, p_plan jsonb, p_origin text, p_changed text[], p_actor uuid)
returns int
language plpgsql security definer set search_path = '' as $$
declare
  s public.strategies;
begin
  select * into s from public.strategies where id = p_strategy for update;
  if not found then
    raise exception 'not_found: strategy %', p_strategy using errcode = 'P0002';
  end if;
  if s.revision <> p_base_revision then
    raise exception 'conflict: strategy changed (revision %)', s.revision using errcode = '23514';
  end if;
  if s.status in ('archived','generating') then
    raise exception 'conflict: strategy is %', s.status using errcode = '23514';
  end if;
  update public.strategies set plan = p_plan, revision = s.revision + 1,
         status = case when s.status = 'failed' then 'draft' else s.status end
   where id = p_strategy;
  insert into public.strategy_revisions (strategy_id, revision, origin, plan, changed_paths, created_by)
  values (p_strategy, s.revision + 1, p_origin, p_plan, coalesce(p_changed, array[]::text[]), p_actor);
  return s.revision + 1;
end $$;
revoke all on function public.save_strategy_plan(uuid, int, jsonb, text, text[], uuid) from public, anon, authenticated;
grant execute on function public.save_strategy_plan(uuid, int, jsonb, text, text[], uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Campaigns: link to strategy, brief, lifecycle bookkeeping, optimistic revision
-- ---------------------------------------------------------------------------
alter table public.campaigns
  add column strategy_id       uuid references public.strategies(id) on delete set null,
  add column plan_key          text,          -- campaign id inside the strategy plan (idempotent materialisation)
  add column brief             jsonb not null default '{}'::jsonb,   -- theme, key message, offer, CTA, KPIs, audience
  add column pillar            text,
  add column revision          int not null default 0,
  add column runner_workflow_id text,
  add column next_generation_at timestamptz,
  add column paused_at          timestamptz,
  add column cancelled_at       timestamptz,
  add column last_runner_event  jsonb;
create unique index campaigns_strategy_plan_key on public.campaigns (strategy_id, plan_key) where plan_key is not null;

-- Lifecycle: draft → planned → active ⇄ paused → completed | cancelled (terminal)
create or replace function app.guard_campaign_transition() returns trigger
language plpgsql as $$
begin
  if new.status = old.status then return new; end if;
  if old.status in ('completed','cancelled') then
    raise exception 'campaign is % and cannot change', old.status using errcode = '23514';
  end if;
  if not (
       (old.status = 'draft'   and new.status in ('planned','active','cancelled'))
    or (old.status = 'planned' and new.status in ('draft','active','cancelled'))
    or (old.status = 'active'  and new.status in ('paused','completed','cancelled'))
    or (old.status = 'paused'  and new.status in ('active','completed','cancelled'))
  ) then
    raise exception 'invalid campaign transition % -> %', old.status, new.status using errcode = '23514';
  end if;
  if new.status = 'paused' then new.paused_at := now(); end if;
  if new.status = 'active' then new.paused_at := null; end if;
  if new.status = 'cancelled' then new.cancelled_at := now(); end if;
  return new;
end $$;
create trigger campaigns_transition before update of status on public.campaigns
  for each row execute function app.guard_campaign_transition();

-- ---------------------------------------------------------------------------
-- Topics: the unit of planned content (one channel, one content type, one date)
-- ---------------------------------------------------------------------------
alter table public.campaign_topics drop constraint campaign_topics_status_check;
alter table public.campaign_topics
  add constraint campaign_topics_status_check check (status in ('idea','approved','in_production','done','failed','blocked','dropped')),
  add column strategy_id      uuid references public.strategies(id) on delete set null,
  add column channel          text,
  add column content_type     text not null default 'social_post',
  add column cta              text,
  add column notes            text,
  add column origin           text not null default 'human' check (origin in ('ai','human')),
  add column slot_key         text,           -- deterministic slot id from the weekly allocator
  add column content_item_id  uuid references public.content_items(id) on delete set null,
  add column generation_job_id uuid references public.generation_jobs(id) on delete set null,
  add column generation_count int not null default 0,
  add column status_note      text;
create unique index campaign_topics_slot on public.campaign_topics (campaign_id, slot_key) where slot_key is not null and status <> 'dropped';
create index on public.campaign_topics (brand_id, planned_for);
create index on public.campaign_topics (campaign_id, status, planned_for);

-- ---------------------------------------------------------------------------
-- Seasonal moments: global (workspace_id null) + workspace-specific dates
-- ---------------------------------------------------------------------------
create table public.seasonal_events (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  name         text not null,
  on_date      date not null,
  region       text not null default 'IN',     -- 'IN', 'IN-TG', 'IN-AP', ...
  kind         text not null default 'festival' check (kind in ('festival','national','commercial','awareness','business')),
  note         text,
  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  unique nulls not distinct (workspace_id, name, on_date)
);
create index on public.seasonal_events (on_date);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.strategies enable row level security;
alter table public.strategy_revisions enable row level security;
alter table public.seasonal_events enable row level security;

create policy strategies_select on public.strategies for select to authenticated
  using (app.brand_perm(workspace_id, brand_id, 'campaign.read'));
-- writes go through the API (revision checks, AI provenance); no direct client writes
create policy strategy_revisions_select on public.strategy_revisions for select to authenticated
  using (app.brand_perm(workspace_id, brand_id, 'campaign.read'));

create policy seasonal_select on public.seasonal_events for select to authenticated
  using (workspace_id is null or app.is_workspace_member(workspace_id));
create policy seasonal_write on public.seasonal_events for all to authenticated
  using (workspace_id is not null and app.has_permission(workspace_id, 'campaign.update'))
  with check (workspace_id is not null and app.has_permission(workspace_id, 'campaign.update'));

grant select, insert, update, delete on public.strategies, public.strategy_revisions, public.seasonal_events to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

create trigger audit_strategies after insert or update of status on public.strategies
  for each row execute function app.audit_row();
create trigger audit_campaigns after insert or update of status on public.campaigns
  for each row execute function app.audit_row();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.strategies, public.campaigns, public.campaign_topics;
  end if;
end $$;

-- strategy plans and campaign briefs are large documents: keep them out of audit rows
create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid;
  rec jsonb;
  strip text[] := array['secret_hash','token_hash','kit','context','answers','plan','brief','inputs'];
begin
  rec := to_jsonb(coalesce(new, old));
  ws := nullif(rec ->> 'workspace_id', '')::uuid;
  if tg_table_name = 'workspaces' then
    ws := (rec ->> 'id')::uuid;
  end if;
  insert into public.audit_logs (workspace_id, actor_id, actor_type, action, entity_type, entity_id, before, after)
  values (
    ws, (select auth.uid()),
    case when (select auth.uid()) is null then 'system' else 'user' end,
    lower(tg_op), tg_table_name,
    coalesce(rec ->> 'id', rec ->> 'user_id', rec ->> 'brand_id'),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) - strip end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) - strip end
  );
  return coalesce(new, old);
end $$;
