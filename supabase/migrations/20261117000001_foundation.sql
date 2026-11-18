-- Arcatic Marketing OS — 0001 Foundation
-- Tenancy (organizations → workspaces → brands), users, roles/permissions,
-- invites, API keys, audit logs, and the RLS helper functions every later
-- migration relies on.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;
create extension if not exists vector with schema extensions;

create schema if not exists app;
grant usage on schema app to authenticated, service_role, anon;

-- ---------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------
create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Users (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table public.users (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         extensions.citext not null,
  full_name     text,
  avatar_url    text,
  locale        text not null default 'en',
  timezone      text not null default 'Asia/Kolkata',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger users_touch before update on public.users
  for each row execute function app.touch_updated_at();

create or replace function app.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.users (id, email, full_name, avatar_url)
  values (
    new.id,
    coalesce(new.email, ''),
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Roles & permissions (static catalogue, seeded below)
-- ---------------------------------------------------------------------------
create table public.roles (
  key         text primary key,
  rank        int  not null unique,
  description text not null
);

create table public.permissions (
  key         text primary key,
  description text not null
);

create table public.role_permissions (
  role       text not null references public.roles(key) on delete cascade,
  permission text not null references public.permissions(key) on delete cascade,
  primary key (role, permission)
);

-- ---------------------------------------------------------------------------
-- Organizations, workspaces, membership
-- ---------------------------------------------------------------------------
create table public.organizations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(name) between 1 and 120),
  billing_email extensions.citext,
  country       text not null default 'IN',
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger organizations_touch before update on public.organizations
  for each row execute function app.touch_updated_at();

create table public.workspaces (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null check (length(name) between 1 and 120),
  slug             text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'),
  default_language text not null default 'en',
  currency         text not null default 'INR',
  settings         jsonb not null default '{}'::jsonb,
  deleted_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index on public.workspaces (organization_id);
create trigger workspaces_touch before update on public.workspaces
  for each row execute function app.touch_updated_at();

create table public.workspace_members (
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  user_id          uuid not null references public.users(id) on delete cascade,
  role             text not null references public.roles(key),
  status           text not null default 'active' check (status in ('active','suspended')),
  -- when true, the member only sees brands listed in brand_members
  brand_restricted boolean not null default false,
  invited_by       uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index on public.workspace_members (user_id);
create trigger workspace_members_touch before update on public.workspace_members
  for each row execute function app.touch_updated_at();

create table public.brands (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  name          text not null check (length(name) between 1 and 120),
  website_url   text,
  industry      text,
  languages     text[] not null default array['en'],
  logo_asset_id uuid,
  -- Phase 1 keeps a lightweight profile; Phase 2 adds versioned brand_kits.
  profile       jsonb not null default '{}'::jsonb,
  status        text not null default 'active' check (status in ('active','archived')),
  created_by    uuid references public.users(id) on delete set null,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, workspace_id)   -- target for composite FKs that pin children to the same workspace
);
create index on public.brands (workspace_id) where deleted_at is null;
create trigger brands_touch before update on public.brands
  for each row execute function app.touch_updated_at();

create table public.brand_members (
  brand_id     uuid not null,
  workspace_id uuid not null,
  user_id      uuid not null references public.users(id) on delete cascade,
  -- optional per-brand role override (e.g. client reviewer on one brand)
  role         text references public.roles(key),
  created_at   timestamptz not null default now(),
  primary key (brand_id, user_id),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade,
  foreign key (workspace_id, user_id) references public.workspace_members(workspace_id, user_id) on delete cascade
);

create table public.workspace_invites (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email        extensions.citext not null,
  role         text not null references public.roles(key),
  brand_ids    uuid[],
  token_hash   text not null unique,
  invited_by   uuid references public.users(id) on delete set null,
  expires_at   timestamptz not null default now() + interval '7 days',
  accepted_at  timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index on public.workspace_invites (workspace_id);

create table public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name         text not null,
  prefix       text not null,            -- visible part, e.g. "ak_live_3f9a"
  secret_hash  text not null unique,     -- sha256 hex of the full key
  scopes       text[] not null default array[]::text[],
  role         text not null default 'editor' references public.roles(key),
  created_by   uuid references public.users(id) on delete set null,
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index on public.api_keys (workspace_id);

create table public.audit_logs (
  id           bigint generated always as identity primary key,
  -- deliberately not a FK: audit rows outlive the workspace (purged by retention job)
  workspace_id uuid,
  actor_id     uuid,
  actor_type   text not null default 'user' check (actor_type in ('user','api_key','system')),
  action       text not null,
  entity_type  text not null,
  entity_id    text,
  before       jsonb,
  after        jsonb,
  ip           inet,
  user_agent   text,
  request_id   text,
  created_at   timestamptz not null default now()
);
create index on public.audit_logs (workspace_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS helper functions (SECURITY DEFINER → no policy recursion)
-- ---------------------------------------------------------------------------
create or replace function app.is_workspace_member(p_workspace uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = p_workspace
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  );
$$;

create or replace function app.workspace_role(p_workspace uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.workspace_members m
  where m.workspace_id = p_workspace
    and m.user_id = (select auth.uid())
    and m.status = 'active';
$$;

create or replace function app.has_permission(p_workspace uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.workspace_members m
    join public.role_permissions rp on rp.role = m.role
    where m.workspace_id = p_workspace
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and rp.permission = p_perm
  );
$$;

-- Effective permission on a brand: brand-level role override wins; members with
-- brand_restricted = true need an explicit brand_members row.
create or replace function app.has_brand_permission(p_brand uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.brands b
    join public.workspace_members wm
      on wm.workspace_id = b.workspace_id
     and wm.user_id = (select auth.uid())
     and wm.status = 'active'
    left join public.brand_members bm
      on bm.brand_id = b.id and bm.user_id = wm.user_id
    join public.role_permissions rp
      on rp.role = coalesce(bm.role, wm.role)
    where b.id = p_brand
      and b.deleted_at is null
      and rp.permission = p_perm
      and (not wm.brand_restricted or bm.user_id is not null)
  );
$$;

-- Same rule, but takes the row's own workspace_id so it never has to read the
-- brands table. Policies use this form: it works for INSERT ... RETURNING
-- (where the new row is not yet visible to a STABLE function's snapshot) and
-- avoids an extra join per row.
create or replace function app.brand_perm(p_workspace uuid, p_brand uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.workspace_members wm
    left join public.brand_members bm
      on bm.brand_id = p_brand and bm.user_id = wm.user_id
    join public.role_permissions rp
      on rp.role = coalesce(bm.role, wm.role)
    where wm.workspace_id = p_workspace
      and wm.user_id = (select auth.uid())
      and wm.status = 'active'
      and rp.permission = p_perm
      and (not wm.brand_restricted or bm.user_id is not null)
  );
$$;

-- Row check used by generic policies: brand-scoped rows use the brand rule,
-- workspace-level rows (brand_id is null) use the workspace rule.
create or replace function app.can(p_workspace uuid, p_brand uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when p_brand is null then app.has_permission(p_workspace, p_perm)
    else app.brand_perm(p_workspace, p_brand, p_perm)
  end;
$$;

grant execute on function app.is_workspace_member(uuid), app.workspace_role(uuid),
  app.has_permission(uuid, text), app.has_brand_permission(uuid, text),
  app.brand_perm(uuid, uuid, text), app.can(uuid, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
-- A user can never grant a role ranked above their own; service role bypasses.
create or replace function app.guard_member_role() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor_rank int;
  target_rank int;
begin
  -- service role / migrations, or a trusted SECURITY DEFINER flow
  -- (create_organization, accept_invite) that sets this transaction-local flag.
  if (select auth.uid()) is null
     or coalesce(current_setting('app.trusted_membership_write', true), '') = 'on' then
    return new;
  end if;
  select r.rank into actor_rank
    from public.workspace_members m join public.roles r on r.key = m.role
   where m.workspace_id = new.workspace_id and m.user_id = (select auth.uid());
  select rank into target_rank from public.roles where key = new.role;
  if actor_rank is null or target_rank > actor_rank then
    raise exception 'forbidden: cannot assign role % above your own', new.role
      using errcode = '42501';
  end if;
  return new;
end $$;

create trigger workspace_members_role_guard
  before insert or update of role on public.workspace_members
  for each row execute function app.guard_member_role();

-- Every workspace keeps at least one active owner.
create or replace function app.guard_last_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  remaining int;
begin
  if old.role <> 'owner' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' and new.status = 'active' then
    return new;
  end if;
  -- the workspace itself is being deleted
  if not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    return coalesce(new, old);
  end if;
  select count(*) into remaining
    from public.workspace_members
   where workspace_id = old.workspace_id
     and role = 'owner' and status = 'active'
     and user_id <> old.user_id;
  if remaining = 0 then
    raise exception 'conflict: workspace must keep at least one owner'
      using errcode = '23514';
  end if;
  return coalesce(new, old);
end $$;

create trigger workspace_members_last_owner
  before update or delete on public.workspace_members
  for each row execute function app.guard_last_owner();

-- ---------------------------------------------------------------------------
-- Audit trigger (captures the JWT user; API adds richer rows itself)
-- ---------------------------------------------------------------------------
create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid;
  rec jsonb;
begin
  rec := to_jsonb(coalesce(new, old));
  ws := nullif(rec ->> 'workspace_id', '')::uuid;
  if tg_table_name = 'workspaces' then
    ws := (rec ->> 'id')::uuid;
  end if;
  insert into public.audit_logs (workspace_id, actor_id, actor_type, action, entity_type, entity_id, before, after)
  values (
    ws,
    (select auth.uid()),
    case when (select auth.uid()) is null then 'system' else 'user' end,
    lower(tg_op),
    tg_table_name,
    coalesce(rec ->> 'id', rec ->> 'user_id'),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) - 'secret_hash' - 'token_hash' end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) - 'secret_hash' - 'token_hash' end
  );
  return coalesce(new, old);
end $$;

create trigger audit_workspaces after insert or update or delete on public.workspaces
  for each row execute function app.audit_row();
create trigger audit_workspace_members after insert or update or delete on public.workspace_members
  for each row execute function app.audit_row();
create trigger audit_brands after insert or update or delete on public.brands
  for each row execute function app.audit_row();
create trigger audit_brand_members after insert or update or delete on public.brand_members
  for each row execute function app.audit_row();
create trigger audit_api_keys after insert or update or delete on public.api_keys
  for each row execute function app.audit_row();
create trigger audit_invites after insert or update on public.workspace_invites
  for each row execute function app.audit_row();
