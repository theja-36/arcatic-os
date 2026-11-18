-- Arcatic Marketing OS — 0011 Media workspace & video editor (Phase 6)

-- ---------------------------------------------------------------------------
-- Collections (folders). Nested via parent_id; brand optional (workspace-wide folders).
-- ---------------------------------------------------------------------------
create table public.media_collections (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_id     uuid,
  parent_id    uuid references public.media_collections(id) on delete cascade,
  name         text not null check (length(name) between 1 and 120),
  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  unique nulls not distinct (workspace_id, parent_id, name),
  unique (id, workspace_id),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);

alter table public.media_assets
  add constraint media_assets_collection_fk foreign key (collection_id, workspace_id)
  references public.media_collections(id, workspace_id) on delete set null (collection_id);
create index on public.media_assets (workspace_id, collection_id);
create index on public.media_assets using gin (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(alt_text, '')));

-- A parent must be in the same workspace and a folder can't contain itself.
create or replace function app.guard_collection_parent() returns trigger
language plpgsql as $$
declare
  cur uuid := new.parent_id;
  depth int := 0;
begin
  while cur is not null loop
    if cur = new.id then raise exception 'a folder cannot be inside itself' using errcode = '23514'; end if;
    select parent_id into cur from public.media_collections where id = cur and workspace_id = new.workspace_id;
    if not found then raise exception 'parent folder not found' using errcode = '23503'; end if;
    depth := depth + 1;
    if depth > 8 then raise exception 'folders can be nested at most 8 deep' using errcode = '23514'; end if;
  end loop;
  return new;
end $$;
create trigger media_collections_parent before insert or update of parent_id on public.media_collections
  for each row execute function app.guard_collection_parent();

-- ---------------------------------------------------------------------------
-- Video projects: timeline document + render bookkeeping
-- ---------------------------------------------------------------------------
create table public.video_projects (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  brand_id         uuid not null,
  title            text not null check (length(title) between 1 and 200),
  export_preset    text not null,
  timeline         jsonb not null,                 -- Timeline (packages/core/src/video)
  revision         int not null default 0,
  status           text not null default 'draft' check (status in ('draft','rendering','rendered','failed')),
  duration_ms      int not null default 0,
  last_render_job_id uuid references public.generation_jobs(id) on delete set null,
  preview_asset_id uuid references public.media_assets(id) on delete set null,
  output_asset_id  uuid references public.media_assets(id) on delete set null,
  rendered_revision int,                           -- timeline revision the output was rendered from
  content_item_id  uuid references public.content_items(id) on delete set null,
  campaign_id      uuid,
  created_by       uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create index on public.video_projects (brand_id, updated_at desc);
create trigger video_projects_touch before update on public.video_projects
  for each row execute function app.touch_updated_at();

-- Optimistic timeline save; a timeline change makes an earlier render stale (status → draft).
create or replace function public.save_video_timeline(p_project uuid, p_base_revision int, p_timeline jsonb, p_duration_ms int, p_title text default null)
returns int
language plpgsql security definer set search_path = '' as $$
declare
  p public.video_projects;
begin
  select * into p from public.video_projects where id = p_project for update;
  if not found then raise exception 'not_found: project %', p_project using errcode = 'P0002'; end if;
  if p.revision <> p_base_revision then raise exception 'conflict: project changed (revision %)', p.revision using errcode = '23514'; end if;
  if p.status = 'rendering' then raise exception 'conflict: wait for the render to finish' using errcode = '23514'; end if;
  update public.video_projects
     set timeline = p_timeline, duration_ms = p_duration_ms, revision = p.revision + 1, title = coalesce(p_title, title),
         status = case when p.status = 'rendered' then 'draft' else p.status end
   where id = p_project;
  return p.revision + 1;
end $$;
revoke all on function public.save_video_timeline(uuid, int, jsonb, int, text) from public, anon, authenticated;
grant execute on function public.save_video_timeline(uuid, int, jsonb, int, text) to service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.media_collections enable row level security;
alter table public.video_projects enable row level security;

create policy collections_select on public.media_collections for select to authenticated
  using (app.can(workspace_id, brand_id, 'media.read'));
create policy collections_write on public.media_collections for all to authenticated
  using (app.can(workspace_id, brand_id, 'media.update'))
  with check (app.can(workspace_id, brand_id, 'media.create'));

create policy video_projects_select on public.video_projects for select to authenticated
  using (app.brand_perm(workspace_id, brand_id, 'media.read'));
create policy video_projects_insert on public.video_projects for insert to authenticated
  with check (app.brand_perm(workspace_id, brand_id, 'media.create'));
-- timeline saves and render bookkeeping go through the API (revision checks)

grant select, insert, update, delete on public.media_collections, public.video_projects to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.video_projects, public.media_assets;
  end if;
end $$;
