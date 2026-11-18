-- Arcatic Marketing OS — 0003 Background jobs
-- Postgres mirrors Temporal executions for UI, audit and billing.
-- workflow_id = job id, so starting the same job twice is a no-op in Temporal.

create table public.generation_jobs (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  brand_id         uuid,
  kind             text not null,   -- 'generate.social_post', 'ingest.crawl', 'ingest.document', 'ingest.media', 'brand.extract', 'render.video', 'strategy.generate', ...
  status           text not null default 'queued'
                     check (status in ('queued','running','succeeded','failed','cancelling','cancelled')),
  progress         smallint not null default 0 check (progress between 0 and 100),
  input            jsonb not null default '{}'::jsonb,
  output           jsonb,
  error            jsonb,           -- {code, message, retryable}
  attempts         int not null default 0,
  task_queue       text not null default 'arcatic-default',
  workflow_run_id  text,
  parent_job_id    uuid references public.generation_jobs(id) on delete set null,
  content_item_id  uuid,
  source_id        uuid,
  credit_reservation_id uuid,       -- FK added in 0004
  estimated_credits numeric(12,3),
  actual_credits    numeric(12,3),
  idempotency_key  text,
  requested_by     uuid references public.users(id) on delete set null,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create index on public.generation_jobs (workspace_id, created_at desc);
create index on public.generation_jobs (workspace_id, status) where status in ('queued','running','cancelling');
create trigger generation_jobs_touch before update on public.generation_jobs
  for each row execute function app.touch_updated_at();

alter table public.media_assets
  add constraint media_assets_job_fk foreign key (generation_job_id)
  references public.generation_jobs(id) on delete set null;
alter table public.content_versions
  add constraint content_versions_job_fk foreign key (generation_job_id)
  references public.generation_jobs(id) on delete set null;

-- Progress / log stream (Realtime-subscribed by the UI)
create table public.job_events (
  id           bigint generated always as identity primary key,
  job_id       uuid not null references public.generation_jobs(id) on delete cascade,
  workspace_id uuid not null,
  type         text not null check (type in ('status','progress','log','error','retry')),
  message      text,
  data         jsonb,
  created_at   timestamptz not null default now()
);
create index on public.job_events (job_id, id);

create or replace function app.job_events_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select workspace_id into new.workspace_id from public.generation_jobs where id = new.job_id;
  return new;
end $$;
create trigger job_events_scope before insert on public.job_events
  for each row execute function app.job_events_scope();

-- Allowed status transitions (defence against out-of-order activity writes)
create or replace function app.guard_job_transition() returns trigger
language plpgsql as $$
begin
  if new.status = old.status then
    return new;
  end if;
  if old.status in ('succeeded','failed','cancelled') then
    raise exception 'job % is terminal (%)', old.id, old.status using errcode = '23514';
  end if;
  if new.status = 'running' and new.started_at is null then
    new.started_at := now();
  end if;
  if new.status in ('succeeded','failed','cancelled') then
    new.finished_at := coalesce(new.finished_at, now());
    if new.status = 'succeeded' then new.progress := 100; end if;
  end if;
  return new;
end $$;
create trigger generation_jobs_transition before update of status on public.generation_jobs
  for each row execute function app.guard_job_transition();

create table public.publishing_jobs (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  brand_id             uuid not null,
  schedule_id          uuid references public.schedules(id) on delete set null,
  content_item_id      uuid not null,
  content_version_id   uuid not null references public.content_versions(id),
  connected_account_id uuid not null references public.connected_accounts(id) on delete cascade,
  provider             text not null,
  status               text not null default 'queued'
                         check (status in ('queued','validating','publishing','published','failed','cancelled','deleted')),
  approval_id          uuid references public.approvals(id) on delete set null,
  external_post_id     text,           -- Postiz post id / platform id
  external_url         text,
  validation_report    jsonb,
  error                jsonb,
  attempts             int not null default 0,
  next_attempt_at      timestamptz,
  published_at         timestamptz,
  idempotency_key      text not null,
  created_by           uuid references public.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  foreign key (content_item_id, workspace_id) references public.content_items(id, workspace_id) on delete cascade
);
create index on public.publishing_jobs (workspace_id, status);
create trigger publishing_jobs_touch before update on public.publishing_jobs
  for each row execute function app.touch_updated_at();
create trigger audit_publishing_jobs after insert or update of status on public.publishing_jobs
  for each row execute function app.audit_row();

-- Generic request idempotency (API layer)
create table public.idempotency_keys (
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  key           text not null,
  request_hash  text not null,
  response_code int,
  response_body jsonb,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, key)
);

create trigger publishing_jobs_scope before insert on public.publishing_jobs
  for each row execute function app.inherit_scope('content_items', 'content_item_id');
