-- Arcatic Marketing OS — 0014 Growth suite: projects, repurposing, source attribution (Phase 9)

-- ---------------------------------------------------------------------------
-- Projects: a brand-level folder for related documents and assets (a launch, a client pitch…)
-- ---------------------------------------------------------------------------
create table public.projects (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_id     uuid not null,
  name         text not null check (length(name) between 1 and 160),
  description  text check (length(description) <= 2000),
  status       text not null default 'active' check (status in ('active','archived')),
  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, brand_id),
  unique (brand_id, name),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create index on public.projects (brand_id, updated_at desc);
create trigger projects_touch before update on public.projects
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Repurpose runs: one source → many outputs, read once into a digest
-- ---------------------------------------------------------------------------
create table public.repurpose_runs (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null,
  brand_id          uuid not null,
  project_id        uuid,
  source_kind       text not null check (source_kind in ('source','content')),
  source_id         uuid references public.sources(id) on delete set null,
  source_item_id    uuid references public.content_items(id) on delete set null,
  source_ref        jsonb not null,                -- {kind,id,title,url,sourceType} kept even if the source is deleted
  outputs           jsonb not null,                -- [{outputId, type, channel, status, contentItemId?, jobId?, error?}]
  language          text not null default 'en',
  digest            jsonb,                         -- {title, summary, key_points[{point, chunk_ids}], quotes, angles}
  status            text not null default 'queued' check (status in ('queued','digesting','generating','succeeded','partial','failed','cancelled')),
  generation_job_id uuid references public.generation_jobs(id) on delete set null,
  created_by        uuid references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade,
  foreign key (project_id, brand_id) references public.projects(id, brand_id) on delete set null (project_id)
);
create index on public.repurpose_runs (brand_id, created_at desc);
create trigger repurpose_runs_touch before update on public.repurpose_runs
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Content: project, repurpose lineage, source attribution
-- ---------------------------------------------------------------------------
alter table public.content_items
  add column project_id       uuid,
  add column repurpose_run_id uuid references public.repurpose_runs(id) on delete set null,
  add column source_ref       jsonb;              -- where the content came from (repurposing): {kind,id,title,url,sourceType}
alter table public.content_items
  add constraint content_items_project_fk foreign key (project_id, brand_id) references public.projects(id, brand_id) on delete set null (project_id);
create index on public.content_items (project_id);
create index on public.content_items (repurpose_run_id);

-- ---------------------------------------------------------------------------
-- RLS: read with content.read; writes through the API (project lifecycle, credits for runs)
-- ---------------------------------------------------------------------------
alter table public.projects enable row level security;
alter table public.repurpose_runs enable row level security;
create policy projects_select on public.projects for select to authenticated using (app.brand_perm(workspace_id, brand_id, 'content.read'));
create policy repurpose_runs_select on public.repurpose_runs for select to authenticated using (app.brand_perm(workspace_id, brand_id, 'content.read'));
grant select on public.projects, public.repurpose_runs to authenticated;
grant all on public.projects, public.repurpose_runs to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.repurpose_runs;
  end if;
end $$;

create trigger audit_projects after insert or update of status on public.projects
  for each row execute function app.audit_row();
