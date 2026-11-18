-- Arcatic Marketing OS — 0016 Advanced growth: SEO/AEO research & ads management (Phase 11)

-- ---------------------------------------------------------------------------
-- Permissions for the ads module (high risk: money leaves the customer's account)
--   ads.read    see ad campaigns, spend and approvals
--   ads.manage  draft campaigns, run checks, request launches / changes, pause
--   ads.approve approve or reject launches, activation and budget increases
-- ---------------------------------------------------------------------------
insert into public.permissions (key, description)
select k, k from unnest(array[
  'ads.read','ads.manage','ads.approve'
]) as k;

insert into public.role_permissions (role, permission)
select 'owner', key from public.permissions
where key in ('ads.read','ads.manage','ads.approve');
insert into public.role_permissions (role, permission)
select 'admin', key from public.permissions
where key in ('ads.read','ads.manage','ads.approve');
insert into public.role_permissions (role, permission)
select 'editor', key from public.permissions
where key in ('ads.read','ads.manage');
insert into public.role_permissions (role, permission)
select 'reviewer', key from public.permissions
where key in ('ads.read');

-- ---------------------------------------------------------------------------
-- SEO: keyword research, competitors, per-content reports
-- ---------------------------------------------------------------------------
create table public.keyword_sets (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  brand_id     uuid not null,
  name         text not null check (length(name) between 1 and 160),
  seeds        text[] not null default array[]::text[],
  seed_url     text,
  language     text not null default 'en',
  geo          text not null default 'IN',
  source       text not null check (source in ('google_ads_keyword_planner','ai_suggested','manual')),
  status       text not null default 'running' check (status in ('running','ready','failed')),
  ideas        jsonb not null default '[]'::jsonb,   -- [{keyword, avgMonthlySearches?, competition?, lowBidMinor?, highBidMinor?, intent?}]
  clusters     jsonb not null default '[]'::jsonb,   -- [{label, keywords[], volume?}]
  error        text,
  generation_job_id uuid references public.generation_jobs(id) on delete set null,
  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create index on public.keyword_sets (brand_id, created_at desc);
create trigger keyword_sets_touch before update on public.keyword_sets for each row execute function app.touch_updated_at();

create table public.competitors (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  brand_id         uuid not null,
  name             text not null check (length(name) between 1 and 160),
  url              text not null,
  notes            text,
  status           text not null default 'new' check (status in ('new','analyzing','ready','failed')),
  analysis         jsonb,      -- {pages:[{url,title,headings}], topics:[], offers:[], claims:[{text,url}], positioning, gaps:[{topic, why}]}
  analyzed_at      timestamptz,
  error            text,
  generation_job_id uuid references public.generation_jobs(id) on delete set null,
  created_by       uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (brand_id, url),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create trigger competitors_touch before update on public.competitors for each row execute function app.touch_updated_at();

-- target keyword, secondary keywords, search intent, FAQ wish — set per content item
alter table public.content_items add column seo jsonb not null default '{}'::jsonb;

create table public.seo_reports (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null,
  brand_id           uuid not null,
  content_item_id    uuid not null,
  content_version_id uuid not null references public.content_versions(id) on delete cascade,
  scores             jsonb not null,     -- {seo:{score, checks[]}, aeo:{…}, claims:{…}}
  claims             jsonb not null default '[]'::jsonb,
  links              jsonb not null default '[]'::jsonb,
  schema_jsonld      jsonb,
  created_at         timestamptz not null default now(),
  unique (content_version_id),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create trigger seo_reports_scope before insert on public.seo_reports for each row execute function app.inherit_scope('content_items', 'content_item_id');

-- ---------------------------------------------------------------------------
-- Ads: per-account guardrails, campaigns, and an approval record for every critical action
-- ---------------------------------------------------------------------------
create table public.ad_account_policies (
  connection_id             uuid primary key references public.analytics_connections(id) on delete cascade,
  workspace_id              uuid not null references public.workspaces(id) on delete cascade,
  manage_enabled            boolean not null default false,   -- owner opt-in: Arcatic may create / change campaigns here
  currency                  text not null default 'INR',
  max_daily_budget_minor    bigint not null default 100000 check (max_daily_budget_minor > 0),  -- per campaign
  monthly_spend_cap_minor   bigint check (monthly_spend_cap_minor > 0),
  auto_pause_on_cap         boolean not null default true,
  require_separate_approver boolean not null default true,
  page_id                   text,      -- Meta: Facebook Page the ads run as
  instagram_user_id         text,
  updated_by                uuid references public.users(id) on delete set null,
  updated_at                timestamptz not null default now()
);

create table public.ad_campaigns (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null,
  brand_id           uuid not null,
  connection_id      uuid not null references public.analytics_connections(id) on delete restrict,
  platform           text not null check (platform in ('google','meta')),
  name               text not null check (length(name) between 1 and 200),
  objective          text not null,
  status             text not null default 'draft' check (status in ('draft','launching','paused','active','ended','failed','archived')),
  brief              jsonb not null default '{}'::jsonb,
  audience           jsonb not null default '{}'::jsonb,   -- geo, ages, genders, interests (ids), keywords
  creative           jsonb not null default '{}'::jsonb,   -- Google: headlines[], descriptions[], path1/2 · Meta: primaryText, headline, description, cta, mediaAssetId
  landing_url        text,
  daily_budget_minor bigint check (daily_budget_minor > 0),
  currency           text not null default 'INR',
  start_date         date,
  end_date           date,
  special_ad_categories text[] not null default array[]::text[],
  compliance         jsonb,               -- last deterministic check {passed, issues[]}
  revision           int not null default 0,
  external           jsonb not null default '{}'::jsonb,   -- platform ids once created
  source_content_item_id uuid references public.content_items(id) on delete set null,   -- organic → paid
  last_error         text,
  created_by         uuid references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create index on public.ad_campaigns (brand_id, updated_at desc);
create trigger ad_campaigns_touch before update on public.ad_campaigns for each row execute function app.touch_updated_at();

create table public.ad_actions (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  brand_id         uuid not null,
  campaign_id      uuid not null references public.ad_campaigns(id) on delete cascade,
  action           text not null check (action in ('launch','activate','pause','budget_change','end')),
  payload          jsonb not null default '{}'::jsonb,        -- e.g. {dailyBudgetMinor}
  campaign_revision int not null,
  summary          text not null,                             -- what the approver sees ("Create … PAUSED with ₹500/day")
  status           text not null default 'pending' check (status in ('pending','approved','rejected','cancelled','executing','done','failed')),
  requested_by     uuid references public.users(id) on delete set null,
  decided_by       uuid references public.users(id) on delete set null,
  decided_at       timestamptz,
  confirmation     text,
  executed_at      timestamptz,
  result           jsonb,
  error            text,
  created_at       timestamptz not null default now()
);
create index on public.ad_actions (campaign_id, created_at desc);
create unique index ad_actions_one_pending on public.ad_actions (campaign_id) where status in ('pending','approved','executing');
create trigger ad_actions_scope before insert on public.ad_actions for each row execute function app.inherit_scope('ad_campaigns', 'campaign_id');

-- A campaign runs on an ad account of its own workspace and of the matching platform;
-- a policy row always carries its connection's workspace.
create or replace function app.guard_ad_connection() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  conn public.analytics_connections;
begin
  select * into conn from public.analytics_connections where id = new.connection_id;
  if conn.id is null then raise exception 'not_found: ad account %', new.connection_id using errcode = '23503'; end if;
  if tg_table_name = 'ad_account_policies' then
    if conn.provider not in ('google_ads','meta_ads') then raise exception 'validation_failed: not an ad account' using errcode = '22023'; end if;
    new.workspace_id := conn.workspace_id;
    return new;
  end if;
  if conn.workspace_id <> new.workspace_id then raise exception 'forbidden: ad account belongs to another workspace' using errcode = '42501'; end if;
  if conn.provider <> (case new.platform when 'google' then 'google_ads' else 'meta_ads' end) then
    raise exception 'validation_failed: % campaigns need a % account', new.platform, new.platform using errcode = '22023';
  end if;
  if conn.brand_id is not null and conn.brand_id <> new.brand_id then
    raise exception 'forbidden: ad account is linked to another brand' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger ad_campaigns_connection before insert or update of connection_id, platform, workspace_id, brand_id on public.ad_campaigns
  for each row execute function app.guard_ad_connection();
create trigger ad_policies_connection before insert or update of connection_id, workspace_id on public.ad_account_policies
  for each row execute function app.guard_ad_connection();

-- Approve / reject one pending action. The campaign must be unchanged since the request;
-- budget changes need the amount typed back; the workspace policy can require a second person.
create or replace function public.decide_ad_action(p_action uuid, p_decision text, p_actor uuid, p_confirmation text default null)
returns public.ad_actions
language plpgsql security definer set search_path = '' as $$
declare
  a public.ad_actions;
  c public.ad_campaigns;
  pol public.ad_account_policies;
begin
  if p_decision not in ('approved','rejected') then raise exception 'validation_failed: decision %', p_decision using errcode = '22023'; end if;
  select * into a from public.ad_actions where id = p_action for update;
  if not found then raise exception 'not_found: action %', p_action using errcode = 'P0002'; end if;
  if a.status <> 'pending' then raise exception 'conflict: this request is %', a.status using errcode = '23514'; end if;
  select * into c from public.ad_campaigns where id = a.campaign_id for update;
  if c.revision <> a.campaign_revision then   -- edits normally cancel requests (trigger below); this is the backstop
    raise exception 'conflict: the campaign changed after this was requested; request again' using errcode = '23514';
  end if;
  if p_decision = 'approved' then
    select * into pol from public.ad_account_policies where connection_id = c.connection_id;
    if a.action in ('launch','activate','budget_change') and (pol.connection_id is null or not pol.manage_enabled) then
      raise exception 'forbidden: managing campaigns is switched off for this ad account' using errcode = '42501';
    end if;
    if coalesce(pol.require_separate_approver, true) and a.requested_by = p_actor and a.action not in ('pause','end') then
      raise exception 'forbidden: someone other than the requester must approve this' using errcode = '42501';
    end if;
    if a.action = 'budget_change' and (a.payload ->> 'dailyBudgetMinor')::bigint > pol.max_daily_budget_minor then
      raise exception 'forbidden: above this ad account''s daily budget limit' using errcode = '42501';
    end if;
    if a.action in ('launch','activate') and coalesce(c.daily_budget_minor, 0) > pol.max_daily_budget_minor then
      raise exception 'forbidden: above this ad account''s daily budget limit' using errcode = '42501';
    end if;
    if a.action in ('launch','activate','budget_change') and coalesce(trim(p_confirmation), '') <> coalesce(a.payload ->> 'confirm', '') then
      raise exception 'validation_failed: type % to confirm', a.payload ->> 'confirm' using errcode = '22023';
    end if;
  end if;
  update public.ad_actions set status = p_decision, decided_by = p_actor, decided_at = now(), confirmation = p_confirmation where id = a.id returning * into a;
  return a;
end $$;
revoke all on function public.decide_ad_action(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.decide_ad_action(uuid, text, uuid, text) to service_role;

-- Any edit to a campaign cancels requests made against the previous revision.
create or replace function app.ad_campaign_edit_cancels_requests() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.revision <> old.revision then
    update public.ad_actions set status = 'cancelled', decided_at = now()
     where campaign_id = new.id and status in ('pending','approved') and campaign_revision < new.revision;
  end if;
  return new;
end $$;
create trigger ad_campaigns_revision after update of revision on public.ad_campaigns
  for each row execute function app.ad_campaign_edit_cancels_requests();

-- ---------------------------------------------------------------------------
-- RLS: reads by permission; all writes through the API (approvals, platform calls)
-- ---------------------------------------------------------------------------
alter table public.keyword_sets enable row level security;
alter table public.competitors enable row level security;
alter table public.seo_reports enable row level security;
alter table public.ad_account_policies enable row level security;
alter table public.ad_campaigns enable row level security;
alter table public.ad_actions enable row level security;
create policy keyword_sets_select on public.keyword_sets for select to authenticated using (app.brand_perm(workspace_id, brand_id, 'content.read'));
create policy competitors_select on public.competitors for select to authenticated using (app.brand_perm(workspace_id, brand_id, 'content.read'));
create policy seo_reports_select on public.seo_reports for select to authenticated using (app.brand_perm(workspace_id, brand_id, 'content.read'));
create policy ad_policies_select on public.ad_account_policies for select to authenticated using (app.has_permission(workspace_id, 'ads.read'));
create policy ad_campaigns_select on public.ad_campaigns for select to authenticated using (app.brand_perm(workspace_id, brand_id, 'ads.read'));
create policy ad_actions_select on public.ad_actions for select to authenticated using (app.brand_perm(workspace_id, brand_id, 'ads.read'));
grant select on public.keyword_sets, public.competitors, public.seo_reports, public.ad_account_policies, public.ad_campaigns, public.ad_actions to authenticated;
grant all on public.keyword_sets, public.competitors, public.seo_reports, public.ad_account_policies, public.ad_campaigns, public.ad_actions to service_role;

create trigger audit_ad_campaigns after insert or update of status, daily_budget_minor on public.ad_campaigns for each row execute function app.audit_row();
create trigger audit_ad_actions after insert or update of status on public.ad_actions for each row execute function app.audit_row();
create trigger audit_ad_policies after insert or update on public.ad_account_policies for each row execute function app.audit_row();
