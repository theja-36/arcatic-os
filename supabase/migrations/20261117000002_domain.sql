-- Arcatic Marketing OS — 0002 Domain tables
-- Connected accounts, knowledge, media, campaigns, content, approvals, schedules.
-- Every tenant row carries workspace_id; brand-scoped rows are pinned to the
-- brand's workspace with a composite FK so they can never drift across tenants.

-- ---------------------------------------------------------------------------
-- Connected accounts (platform tokens live in Postiz / Vault, never here)
-- ---------------------------------------------------------------------------
create table public.connected_accounts (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,
  brand_id           uuid,
  provider           text not null,        -- 'postiz:instagram', 'postiz:linkedin-page', 'wordpress', 'mautic', 'matomo', 'google-ads', 'meta-ads', 'google-drive'
  external_id        text not null,        -- Postiz integration id / platform account id
  display_name       text,
  avatar_url         text,
  status             text not null default 'active'
                       check (status in ('active','refresh_needed','disconnected','error')),
  scopes             text[] not null default array[]::text[],
  -- reference into Supabase Vault for any secret Arcatic itself must hold
  vault_secret_id    uuid,
  settings           jsonb not null default '{}'::jsonb,
  last_synced_at     timestamptz,
  connected_by       uuid references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (workspace_id, provider, external_id),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create trigger connected_accounts_touch before update on public.connected_accounts
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Media
-- ---------------------------------------------------------------------------
create table public.media_assets (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  brand_id      uuid,
  kind          text not null check (kind in ('image','video','audio','document','logo','template','font','other')),
  status        text not null default 'pending' check (status in ('pending','ready','processing','failed','deleted')),
  storage_path  text unique,               -- '{workspace_id}/{brand_id|_}/{asset_id}/{filename}'
  source        text not null default 'upload' check (source in ('upload','url_import','generated','drive','render')),
  source_url    text,
  mime_type     text,
  bytes         bigint check (bytes >= 0),
  width         int,
  height        int,
  duration_ms   int,
  checksum      text,
  title         text,
  alt_text      text,
  tags          text[] not null default array[]::text[],
  collection_id uuid,
  metadata      jsonb not null default '{}'::jsonb,
  generation_job_id uuid,                  -- FK added in 0003
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create index on public.media_assets (workspace_id, brand_id, created_at desc);
create index on public.media_assets using gin (tags);
create trigger media_assets_touch before update on public.media_assets
  for each row execute function app.touch_updated_at();

alter table public.brands
  add constraint brands_logo_fk foreign key (logo_asset_id) references public.media_assets(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Knowledge
-- ---------------------------------------------------------------------------
create table public.sources (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  brand_id          uuid not null,
  type              text not null check (type in ('url','crawl','file','text','media','drive','social_reference')),
  title             text not null,
  url               text,
  media_asset_id    uuid references public.media_assets(id) on delete set null,
  body              text,                    -- for pasted text notes
  status            text not null default 'pending'
                      check (status in ('pending','processing','ready','failed','stale')),
  error             text,
  summary           text,
  tags              text[] not null default array[]::text[],
  language          text,
  crawl_options     jsonb not null default '{}'::jsonb,
  content_hash      text,
  last_ingested_at  timestamptz,
  refresh_interval  interval,                -- freshness policy
  owner_id          uuid references public.users(id) on delete set null,
  visibility        text not null default 'brand' check (visibility in ('brand','private')),
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create index on public.sources (brand_id, status);
create trigger sources_touch before update on public.sources
  for each row execute function app.touch_updated_at();

create table public.knowledge_chunks (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  brand_id      uuid not null,
  source_id     uuid not null,
  ordinal       int  not null,
  content       text not null,
  token_count   int,
  heading_path  text[],                    -- e.g. {"Pricing","Enterprise"}
  page_url      text,
  page_number   int,
  start_ms      int,                       -- for transcripts
  end_ms        int,
  metadata      jsonb not null default '{}'::jsonb,
  fts           tsvector generated always as (to_tsvector('simple', content)) stored,
  created_at    timestamptz not null default now(),
  unique (source_id, ordinal),
  unique (id, workspace_id),
  foreign key (source_id, workspace_id) references public.sources(id, workspace_id) on delete cascade,
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create index on public.knowledge_chunks (brand_id);
create index on public.knowledge_chunks using gin (fts);

-- Embeddings are separate so we can re-embed with a new model side by side.
-- 1024 dims matches the default embedding model in packages/ai (voyage-3 class);
-- a different dimension means a new column + index via migration.
create table public.embeddings (
  chunk_id      uuid not null,
  workspace_id  uuid not null,
  brand_id      uuid not null,
  model         text not null,
  embedding     extensions.vector(1024) not null,
  created_at    timestamptz not null default now(),
  primary key (chunk_id, model),
  foreign key (chunk_id, workspace_id) references public.knowledge_chunks(id, workspace_id) on delete cascade
);
create index embeddings_hnsw on public.embeddings
  using hnsw (embedding extensions.vector_cosine_ops);
create index on public.embeddings (brand_id, model);

-- Semantic search; SECURITY INVOKER so RLS on chunks/embeddings applies.
create or replace function public.match_knowledge(
  p_brand uuid,
  p_query extensions.vector(1024),
  p_model text,
  p_limit int default 8,
  p_min_similarity float default 0.2
) returns table (chunk_id uuid, source_id uuid, content text, page_url text, similarity float)
language sql stable security invoker set search_path = '' as $$
  select c.id, c.source_id, c.content, c.page_url,
         1 - (e.embedding operator(extensions.<=>) p_query) as similarity
  from public.embeddings e
  join public.knowledge_chunks c on c.id = e.chunk_id
  where e.brand_id = p_brand and e.model = p_model
    and 1 - (e.embedding operator(extensions.<=>) p_query) >= p_min_similarity
  order by e.embedding operator(extensions.<=>) p_query
  limit least(p_limit, 50);
$$;

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------
create table public.campaigns (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null,
  brand_id           uuid not null,
  name               text not null,
  goal               text,
  audience           jsonb not null default '{}'::jsonb,
  context            text,
  status             text not null default 'draft'
                       check (status in ('draft','planned','active','paused','completed','cancelled')),
  starts_on          date,
  ends_on            date,
  channels           text[] not null default array[]::text[],
  content_types      text[] not null default array[]::text[],
  frequency          jsonb not null default '{}'::jsonb,     -- {"instagram": {"per_week": 3}}
  volume_target      int,
  review_window_hours int not null default 24,
  generation_schedule jsonb not null default '{}'::jsonb,    -- {"mode":"immediate"|"scheduled","cron":...}
  reference_source_ids uuid[] not null default array[]::uuid[],
  created_by         uuid references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (id, workspace_id),
  check (ends_on is null or starts_on is null or ends_on >= starts_on),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create index on public.campaigns (brand_id, status);
create trigger campaigns_touch before update on public.campaigns
  for each row execute function app.touch_updated_at();

create table public.campaign_topics (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  brand_id      uuid not null,
  campaign_id   uuid not null,
  title         text not null,
  angle         text,
  pillar        text,
  planned_for   date,
  channels      text[] not null default array[]::text[],
  status        text not null default 'idea' check (status in ('idea','approved','in_production','done','dropped')),
  position      int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (campaign_id, workspace_id) references public.campaigns(id, workspace_id) on delete cascade,
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create index on public.campaign_topics (campaign_id, position);
create trigger campaign_topics_touch before update on public.campaign_topics
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Content
-- ---------------------------------------------------------------------------
create table public.content_items (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null,
  brand_id           uuid not null,
  campaign_id        uuid,
  topic_id           uuid references public.campaign_topics(id) on delete set null,
  type               text not null,      -- 'social_post','caption','static_visual','email','blog','image','video','ad_copy','yt_script','x_thread','profile_asset', ...
  channel            text,               -- 'instagram','linkedin','x','email','blog', ...
  language           text not null default 'en',
  title              text,
  status             text not null default 'draft'
                       check (status in ('draft','generating','in_review','changes_requested','approved','scheduled','published','failed','archived')),
  current_version_id uuid,
  ai_disclosure_required boolean not null default false,
  due_at             timestamptz,
  assignee_id        uuid references public.users(id) on delete set null,
  created_by         uuid references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade,
  foreign key (campaign_id, workspace_id) references public.campaigns(id, workspace_id) on delete set null (campaign_id)
);
create index on public.content_items (brand_id, status, updated_at desc);
create index on public.content_items (campaign_id);
create trigger content_items_touch before update on public.content_items
  for each row execute function app.touch_updated_at();

-- Immutable snapshots. Provenance is mandatory for AI versions.
create table public.content_versions (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null,
  brand_id              uuid not null,
  content_item_id       uuid not null,
  version               int not null,
  origin                text not null check (origin in ('ai','human','ai_edit','import')),
  body                  jsonb not null,           -- TipTap JSON / structured output
  plain_text            text,
  media_asset_ids       uuid[] not null default array[]::uuid[],
  -- provenance
  prompt                text,
  prompt_template       text,                     -- 'social.post@1'
  model                 text,
  model_params          jsonb,
  inputs                jsonb,
  brand_context_version int,
  brand_context_hash    text,
  depends_on_facts      text[] not null default array[]::text[],
  source_chunk_ids      uuid[] not null default array[]::uuid[],
  generation_job_id     uuid,
  trace_id              text,                     -- Langfuse trace
  credits_cost          numeric(12,3),
  validation_report     jsonb,
  feedback              jsonb,                    -- thumbs, rating, notes
  created_by            uuid references public.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  unique (content_item_id, version),
  foreign key (content_item_id, workspace_id) references public.content_items(id, workspace_id) on delete cascade,
  check (origin <> 'ai' or (model is not null and prompt_template is not null))
);

alter table public.content_items
  add constraint content_items_current_version_fk
  foreign key (current_version_id) references public.content_versions(id) on delete set null
  deferrable initially deferred;

create or replace function app.forbid_update() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'content_versions' and tg_op = 'UPDATE'
     and (to_jsonb(new) - 'feedback') = (to_jsonb(old) - 'feedback') then
    return new;  -- feedback is the only mutable field on a version
  end if;
  raise exception '% rows are immutable', tg_table_name using errcode = '42501';
end $$;
create trigger content_versions_immutable before update on public.content_versions
  for each row execute function app.forbid_update();

create table public.approvals (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  brand_id         uuid not null,
  content_item_id  uuid not null,
  content_version_id uuid not null references public.content_versions(id) on delete cascade,
  requested_by     uuid references public.users(id) on delete set null,
  reviewer_id      uuid references public.users(id) on delete set null,
  status           text not null default 'pending' check (status in ('pending','approved','rejected','changes_requested','cancelled')),
  comment          text,
  decided_at       timestamptz,
  due_at           timestamptz,
  created_at       timestamptz not null default now(),
  foreign key (content_item_id, workspace_id) references public.content_items(id, workspace_id) on delete cascade
);
create index on public.approvals (workspace_id, status);

create table public.schedules (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null,
  brand_id             uuid not null,
  content_item_id      uuid not null,
  connected_account_id uuid not null references public.connected_accounts(id) on delete cascade,
  publish_at           timestamptz not null,
  timezone             text not null default 'Asia/Kolkata',
  status               text not null default 'scheduled' check (status in ('scheduled','queued','publishing','published','failed','cancelled')),
  requires_approval    boolean not null default true,
  channel_settings     jsonb not null default '{}'::jsonb,
  created_by           uuid references public.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  foreign key (content_item_id, workspace_id) references public.content_items(id, workspace_id) on delete cascade
);
create index on public.schedules (workspace_id, publish_at);
create trigger schedules_touch before update on public.schedules
  for each row execute function app.touch_updated_at();

create trigger audit_approvals after insert or update on public.approvals
  for each row execute function app.audit_row();
create trigger audit_connected_accounts after insert or update or delete on public.connected_accounts
  for each row execute function app.audit_row();

-- ---------------------------------------------------------------------------
-- Scope inheritance: child rows always take workspace_id/brand_id from their
-- parent, so a caller cannot attach a row to a brand it does not belong to.
-- TG_ARGV[0] = parent table, TG_ARGV[1] = FK column on the child.
-- ---------------------------------------------------------------------------
create or replace function app.inherit_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  parent_ws uuid;
  parent_brand uuid;
  parent_id uuid;
begin
  parent_id := (to_jsonb(new) ->> tg_argv[1])::uuid;
  execute format('select workspace_id, brand_id from public.%I where id = $1', tg_argv[0])
    into parent_ws, parent_brand using parent_id;
  if parent_ws is null then
    raise exception 'parent %.% not found', tg_argv[0], parent_id using errcode = '23503';
  end if;
  new.workspace_id := parent_ws;
  new.brand_id := parent_brand;
  return new;
end $$;

create trigger knowledge_chunks_scope before insert or update of source_id on public.knowledge_chunks
  for each row execute function app.inherit_scope('sources', 'source_id');
create trigger embeddings_scope before insert or update of chunk_id on public.embeddings
  for each row execute function app.inherit_scope('knowledge_chunks', 'chunk_id');
create trigger campaign_topics_scope before insert or update of campaign_id on public.campaign_topics
  for each row execute function app.inherit_scope('campaigns', 'campaign_id');
create trigger content_versions_scope before insert on public.content_versions
  for each row execute function app.inherit_scope('content_items', 'content_item_id');
create trigger approvals_scope before insert or update of content_item_id on public.approvals
  for each row execute function app.inherit_scope('content_items', 'content_item_id');
create trigger schedules_scope before insert or update of content_item_id on public.schedules
  for each row execute function app.inherit_scope('content_items', 'content_item_id');
