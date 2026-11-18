-- Arcatic Marketing OS — 0007 Brand Intelligence (Phase 2)
-- Onboarding answers, immutable Brand Kit versions with approval, compiled Brand Contexts.
--
-- Model: every save of the Brand Kit creates a new immutable version (status 'draft').
-- Approving a version makes it the brand's active kit (previous approved → 'superseded')
-- and stores the compiled Brand Context that generation uses. Only approved facts inside an
-- approved version ever reach a prompt.

create table public.brand_onboarding (
  brand_id      uuid primary key,
  workspace_id  uuid not null,
  answers       jsonb not null default '{}'::jsonb,
  step          text not null default 'business',
  completed_at  timestamptz,
  ownership_attested_at timestamptz,          -- "I own or may analyse this website" (docs/06 scraping policy)
  ownership_attested_by uuid references public.users(id) on delete set null,
  updated_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create trigger brand_onboarding_touch before update on public.brand_onboarding
  for each row execute function app.touch_updated_at();

create table public.brand_kit_versions (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  brand_id         uuid not null,
  version          int  not null check (version > 0),
  base_version     int,
  status           text not null default 'draft' check (status in ('draft','approved','superseded')),
  origin           text not null check (origin in ('manual','onboarding','ai_analysis','ai_suggestion','restore')),
  kit              jsonb not null,
  changed_fact_ids text[] not null default array[]::text[],
  completeness     smallint not null default 0 check (completeness between 0 and 100),
  analysis_job_id  uuid references public.generation_jobs(id) on delete set null,
  note             text,
  created_by       uuid references public.users(id) on delete set null,
  approved_by      uuid references public.users(id) on delete set null,
  approved_at      timestamptz,
  created_at       timestamptz not null default now(),
  unique (brand_id, version),
  unique (id, workspace_id),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create index on public.brand_kit_versions (brand_id, version desc);
-- at most one approved version per brand
create unique index brand_kit_one_approved on public.brand_kit_versions (brand_id) where status = 'approved';

-- Versions are immutable; only the approval lifecycle may change.
create or replace function app.guard_kit_version() returns trigger
language plpgsql as $$
begin
  if (to_jsonb(new) - array['status','approved_by','approved_at'])
     is distinct from (to_jsonb(old) - array['status','approved_by','approved_at']) then
    raise exception 'brand_kit_versions rows are immutable' using errcode = '42501';
  end if;
  if old.status = 'superseded' or (old.status = 'approved' and new.status = 'draft') then
    raise exception 'invalid kit status transition % -> %', old.status, new.status using errcode = '23514';
  end if;
  return new;
end $$;
create trigger brand_kit_versions_immutable before update on public.brand_kit_versions
  for each row execute function app.guard_kit_version();

create table public.brand_contexts (
  kit_version_id uuid primary key,
  workspace_id   uuid not null,
  brand_id       uuid not null,
  version        int  not null,
  hash           text not null,
  fact_ids       text[] not null,
  context        jsonb not null,
  token_estimate int  not null,
  created_at     timestamptz not null default now(),
  foreign key (kit_version_id, workspace_id) references public.brand_kit_versions(id, workspace_id) on delete cascade,
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);

alter table public.brands
  add column active_kit_version_id uuid references public.brand_kit_versions(id) on delete set null,
  add column kit_completeness smallint not null default 0;

-- Atomic approval: one approved version per brand, brand pointer updated, context stored.
create or replace function public.approve_brand_kit_version(
  p_version_id uuid,
  p_context jsonb,
  p_hash text,
  p_fact_ids text[],
  p_token_estimate int,
  p_actor uuid
) returns public.brand_kit_versions
language plpgsql security definer set search_path = '' as $$
declare
  v public.brand_kit_versions;
begin
  select * into v from public.brand_kit_versions where id = p_version_id for update;
  if not found then
    raise exception 'not_found: kit version %', p_version_id using errcode = 'P0002';
  end if;
  if v.status = 'approved' then
    return v;   -- idempotent
  end if;
  if v.status <> 'draft' then
    raise exception 'conflict: version % is %', v.version, v.status using errcode = '23514';
  end if;

  update public.brand_kit_versions set status = 'superseded'
   where brand_id = v.brand_id and status = 'approved';
  update public.brand_kit_versions set status = 'approved', approved_by = p_actor, approved_at = now()
   where id = v.id returning * into v;

  insert into public.brand_contexts (kit_version_id, workspace_id, brand_id, version, hash, fact_ids, context, token_estimate)
  values (v.id, v.workspace_id, v.brand_id, v.version, p_hash, p_fact_ids, p_context, p_token_estimate)
  on conflict (kit_version_id) do nothing;

  update public.brands set active_kit_version_id = v.id, kit_completeness = v.completeness
   where id = v.brand_id;
  return v;
end $$;
revoke all on function public.approve_brand_kit_version(uuid, jsonb, text, text[], int, uuid) from public, anon, authenticated;
grant execute on function public.approve_brand_kit_version(uuid, jsonb, text, text[], int, uuid) to service_role;

-- Content whose last AI version depended on any of the given facts (selective regeneration).
create or replace function public.content_affected_by_facts(p_brand uuid, p_fact_ids text[])
returns table (content_item_id uuid, title text, status text, version int, matched_facts text[])
language sql stable security invoker set search_path = '' as $$
  select ci.id, ci.title, ci.status, cv.version,
         array(select unnest(cv.depends_on_facts) intersect select unnest(p_fact_ids))
  from public.content_items ci
  join public.content_versions cv on cv.id = ci.current_version_id
  where ci.brand_id = p_brand
    and ci.status in ('draft','in_review','changes_requested')
    and cv.depends_on_facts && p_fact_ids;
$$;

-- RLS
alter table public.brand_onboarding enable row level security;
alter table public.brand_kit_versions enable row level security;
alter table public.brand_contexts enable row level security;

create policy onboarding_select on public.brand_onboarding for select to authenticated
  using (app.brand_perm(workspace_id, brand_id, 'brand.read'));
create policy onboarding_write on public.brand_onboarding for all to authenticated
  using (app.brand_perm(workspace_id, brand_id, 'brand.update'))
  with check (app.brand_perm(workspace_id, brand_id, 'brand.update'));

create policy kit_versions_select on public.brand_kit_versions for select to authenticated
  using (app.brand_perm(workspace_id, brand_id, 'brand.read'));
-- drafts may be written directly by editors; approval goes through approve_brand_kit_version (API)
create policy kit_versions_insert on public.brand_kit_versions for insert to authenticated
  with check (status = 'draft' and app.brand_perm(workspace_id, brand_id, 'brand.update'));

create policy brand_contexts_select on public.brand_contexts for select to authenticated
  using (app.brand_perm(workspace_id, brand_id, 'brand.read'));

create trigger audit_brand_kit_versions after insert or update of status on public.brand_kit_versions
  for each row execute function app.audit_row();
create trigger audit_brand_onboarding after insert or update on public.brand_onboarding
  for each row execute function app.audit_row();

grant select, insert, update, delete on public.brand_onboarding, public.brand_kit_versions, public.brand_contexts to authenticated, service_role;

-- Keep audit rows small: drop whole-document columns from before/after snapshots.
create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid;
  rec jsonb;
  strip text[] := array['secret_hash','token_hash','kit','context','answers'];
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
    coalesce(rec ->> 'id', rec ->> 'user_id', rec ->> 'brand_id'),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) - strip end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) - strip end
  );
  return coalesce(new, old);
end $$;
