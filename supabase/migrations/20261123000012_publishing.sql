-- Arcatic Marketing OS — 0012 Publishing & calendar (Phase 7)

-- ---------------------------------------------------------------------------
-- Encrypted integration secrets (app-level envelope with ENCRYPTION_KEY).
-- RLS on, no policies, no grants to authenticated → API/worker (service role) only.
-- ---------------------------------------------------------------------------
create table public.integration_secrets (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  purpose      text not null check (purpose in ('postiz_api_key','wordpress_app_password','mautic_password')),
  ciphertext   text not null,
  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
alter table public.integration_secrets enable row level security;
revoke all on public.integration_secrets from anon, authenticated;
grant all on public.integration_secrets to service_role;

-- ---------------------------------------------------------------------------
-- Workspace publishing back-ends: one Postiz organisation, one Mautic instance
-- ---------------------------------------------------------------------------
create table public.publishing_connections (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  provider        text not null check (provider in ('postiz','mautic')),
  base_url        text not null,
  username        text,                              -- Mautic basic-auth user
  secret_id       uuid references public.integration_secrets(id) on delete set null,
  status          text not null default 'active' check (status in ('active','error','disconnected')),
  last_checked_at timestamptz,
  last_error      text,
  connected_by    uuid references public.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, provider)
);
create trigger publishing_connections_touch before update on public.publishing_connections
  for each row execute function app.touch_updated_at();
alter table public.publishing_connections enable row level security;
create policy publishing_connections_select on public.publishing_connections for select to authenticated
  using (app.has_permission(workspace_id, 'channel.read'));
grant select on public.publishing_connections to authenticated;
grant all on public.publishing_connections to service_role;

-- ---------------------------------------------------------------------------
-- Connected accounts: channel, transport, permissions, target toggle
-- ---------------------------------------------------------------------------
alter table public.connected_accounts
  add column channel    text,     -- instagram | facebook | linkedin | x | tiktok | youtube | threads | gbp | wordpress | email
  add column transport  text not null default 'postiz' check (transport in ('postiz','wordpress','mautic')),
  add column enabled    boolean not null default true,
  add column min_role   text not null default 'editor' check (min_role in ('owner','admin','editor')),
  add column secret_id  uuid references public.integration_secrets(id) on delete set null,
  add column last_error text;
create index on public.connected_accounts (workspace_id, channel);
alter table public.connected_accounts add constraint connected_accounts_id_ws unique (id, workspace_id);

-- ---------------------------------------------------------------------------
-- Schedules = publish targets. One crosspost = one group_id, one row per account.
-- ---------------------------------------------------------------------------
alter table public.schedules drop constraint schedules_status_check;
update public.schedules set status = 'scheduled' where status = 'queued';
alter table public.schedules
  add constraint schedules_status_check check (status in ('scheduled','publishing','published','failed','cancelled','missed')),
  add column group_id           uuid not null default gen_random_uuid(),
  add column enabled            boolean not null default true,     -- target toggle
  add column content_version_id uuid references public.content_versions(id) on delete set null,
  add column text_override      text,
  add column media_asset_ids    uuid[],                             -- null = the content's own media
  add column validation_report  jsonb,
  add column last_error         jsonb,
  add column external_post_id   text,
  add column external_url       text,
  add column published_at       timestamptz,
  add column revision           int not null default 0,
  add column attempts           int not null default 0;
create index on public.schedules (brand_id, publish_at);
create index on public.schedules (group_id);
create unique index schedules_one_live_per_account on public.schedules (content_item_id, connected_account_id)
  where status in ('scheduled','publishing');

-- A target's account must be in the same workspace and either workspace-wide or the same brand.
create or replace function app.guard_schedule_account() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a public.connected_accounts;
begin
  select * into a from public.connected_accounts where id = new.connected_account_id;
  if not found or a.workspace_id <> new.workspace_id or (a.brand_id is not null and a.brand_id <> new.brand_id) then
    raise exception 'account is not available to this brand' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger schedules_account_guard before insert or update of connected_account_id, brand_id on public.schedules
  for each row execute function app.guard_schedule_account();

-- Schedules are written only by the API (validation, approval pinning) and the worker.
drop policy if exists schedules_write on public.schedules;

-- ---------------------------------------------------------------------------
-- Approval gate: the worker claims a target only if the content is approved and
-- unchanged since approval. Otherwise the target is marked missed.
-- ---------------------------------------------------------------------------
create or replace function public.claim_schedule(p_schedule uuid, p_revision int)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.schedules;
  i public.content_items;
  a public.connected_accounts;
  reason text;
begin
  select * into s from public.schedules where id = p_schedule for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if s.revision <> p_revision then return jsonb_build_object('ok', false, 'reason', 'superseded'); end if;
  if s.status <> 'scheduled' or not s.enabled then return jsonb_build_object('ok', false, 'reason', 'not_scheduled'); end if;

  select * into i from public.content_items where id = s.content_item_id;
  select * into a from public.connected_accounts where id = s.connected_account_id;

  if i.approved_version_id is null or i.status not in ('approved','published') or i.current_version_id is distinct from i.approved_version_id then
    reason := 'Not approved at publish time (or edited after approval). Approve it and reschedule.';
  elsif a.status <> 'active' or not a.enabled then
    reason := 'The account is ' || case when not a.enabled then 'turned off' else replace(a.status, '_', ' ') end || '.';
  end if;

  if reason is not null then
    update public.schedules set status = 'missed', last_error = jsonb_build_object('code', 'blocked', 'message', reason) where id = s.id;
    return jsonb_build_object('ok', false, 'reason', 'blocked', 'message', reason);
  end if;

  update public.schedules
     set status = 'publishing', content_version_id = i.approved_version_id, attempts = attempts + 1, last_error = null
   where id = s.id;
  return jsonb_build_object('ok', true, 'versionId', i.approved_version_id, 'accountId', a.id);
end $$;
revoke all on function public.claim_schedule(uuid, int) from public, anon, authenticated;
grant execute on function public.claim_schedule(uuid, int) to service_role;

-- Archiving content cancels its pending targets.
create or replace function app.content_archive_cancels_schedules() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'archived' and old.status <> 'archived' then
    update public.schedules set status = 'cancelled' where content_item_id = new.id and status = 'scheduled';
  end if;
  return new;
end $$;
create trigger content_items_archive_schedules after update of status on public.content_items
  for each row execute function app.content_archive_cancels_schedules();

-- publishing_jobs: one row per publish run of a target
alter table public.publishing_jobs add column external_ref jsonb not null default '{}'::jsonb;   -- e.g. Postiz group / Mautic email id

grant select on public.schedules, public.publishing_jobs, public.connected_accounts to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.schedules, public.connected_accounts;
  end if;
end $$;

create trigger audit_schedules after insert or update of status on public.schedules
  for each row execute function app.audit_row();
