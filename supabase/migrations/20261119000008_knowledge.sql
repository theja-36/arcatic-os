-- Arcatic Marketing OS — 0008 Knowledge OS (Phase 3)
-- Source tracking, private sources, atomic chunk replacement, hybrid (vector + full-text) search,
-- short-lived encrypted secrets for one-off imports (Google Drive access tokens).

alter table public.sources
  add column parent_source_id uuid references public.sources(id) on delete cascade,
  add column chunk_count      int not null default 0,
  add column embedded_count   int not null default 0,
  add column embedding_model  text,
  add column byte_size        bigint,
  add column duration_ms      int,
  add column parser           text,           -- 'firecrawl' | 'docling' | 'plain' | 'csv' | 'whisper' | 'manual'
  add column last_job_id      uuid references public.generation_jobs(id) on delete set null;
create index on public.sources (parent_source_id);
create index on public.sources using gin (tags);
create index on public.sources (brand_id, type, status);

-- ---------------------------------------------------------------------------
-- Private sources: visible to their owner and to workspace admins/owners only.
-- ---------------------------------------------------------------------------
create or replace function app.source_row_visible(p_workspace uuid, p_visibility text, p_owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_visibility = 'brand'
      or p_owner = (select auth.uid())
      or app.has_permission(p_workspace, 'workspace.update');
$$;

create or replace function app.source_visible(p_source uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.sources s
    where s.id = p_source and app.source_row_visible(s.workspace_id, s.visibility, s.owner_id)
  );
$$;
grant execute on function app.source_row_visible(uuid, text, uuid), app.source_visible(uuid) to authenticated, service_role;

drop policy sources_select on public.sources;
drop policy sources_update on public.sources;
drop policy sources_delete on public.sources;
drop policy knowledge_chunks_select on public.knowledge_chunks;

create policy sources_select on public.sources for select to authenticated
  using (app.can(workspace_id, brand_id, 'knowledge.read') and app.source_row_visible(workspace_id, visibility, owner_id));
create policy sources_update on public.sources for update to authenticated
  using (app.can(workspace_id, brand_id, 'knowledge.update') and app.source_row_visible(workspace_id, visibility, owner_id))
  with check (app.can(workspace_id, brand_id, 'knowledge.update') and app.source_row_visible(workspace_id, visibility, owner_id));
create policy sources_delete on public.sources for delete to authenticated
  using (app.can(workspace_id, brand_id, 'knowledge.delete') and app.source_row_visible(workspace_id, visibility, owner_id));
create policy knowledge_chunks_select on public.knowledge_chunks for select to authenticated
  using (app.can(workspace_id, brand_id, 'knowledge.read') and app.source_visible(source_id));

-- ---------------------------------------------------------------------------
-- Atomic re-index: old chunks (and their embeddings) are replaced in one transaction,
-- so search never sees a half-indexed source.
-- ---------------------------------------------------------------------------
create or replace function public.replace_source_chunks(p_source uuid, p_chunks jsonb)
returns table (chunk_id uuid, ordinal int)
language plpgsql security definer set search_path = '' as $$
declare
  s public.sources;
begin
  select * into s from public.sources where id = p_source for update;
  if not found then
    raise exception 'not_found: source %', p_source using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_chunks) <> 'array' then
    raise exception 'validation_failed: chunks must be an array' using errcode = '22023';
  end if;

  delete from public.knowledge_chunks where source_id = p_source;

  insert into public.knowledge_chunks (workspace_id, brand_id, source_id, ordinal, content, token_count, heading_path, page_url, page_number, start_ms, end_ms, metadata)
  select s.workspace_id, s.brand_id, p_source,
         (c ->> 'ordinal')::int,
         c ->> 'content',
         nullif(c ->> 'tokenCount', '')::int,
         case when c ? 'headingPath' then array(select jsonb_array_elements_text(c -> 'headingPath')) end,
         c ->> 'pageUrl',
         nullif(c ->> 'pageNumber', '')::int,
         nullif(c ->> 'startMs', '')::int,
         nullif(c ->> 'endMs', '')::int,
         coalesce(c -> 'metadata', '{}'::jsonb)
  from jsonb_array_elements(p_chunks) as c;

  update public.sources set chunk_count = jsonb_array_length(p_chunks), embedded_count = 0, embedding_model = null
   where id = p_source;

  return query select k.id, k.ordinal from public.knowledge_chunks k where k.source_id = p_source order by k.ordinal;
end $$;

create or replace function public.refresh_source_counts(p_source uuid, p_model text)
returns public.sources
language sql security definer set search_path = '' as $$
  update public.sources s set
    chunk_count = (select count(*) from public.knowledge_chunks k where k.source_id = s.id),
    embedded_count = (select count(*) from public.knowledge_chunks k join public.embeddings e on e.chunk_id = k.id and e.model = p_model where k.source_id = s.id),
    embedding_model = p_model
  where s.id = p_source
  returning s.*;
$$;

revoke all on function public.replace_source_chunks(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.refresh_source_counts(uuid, text) from public, anon, authenticated;
grant execute on function public.replace_source_chunks(uuid, jsonb), public.refresh_source_counts(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Hybrid search: reciprocal-rank fusion of vector similarity and full-text rank.
-- Works without an embedding (full-text only) so search degrades instead of failing.
-- SECURITY INVOKER: RLS on chunks/sources applies to the caller.
-- ---------------------------------------------------------------------------
drop function if exists public.match_knowledge(uuid, extensions.vector, text, int, float);

create or replace function public.search_knowledge(
  p_brand uuid,
  p_query text,
  p_embedding extensions.vector(1024) default null,
  p_model text default null,
  p_limit int default 8,
  p_source_types text[] default null,
  p_tags text[] default null
) returns table (
  chunk_id uuid, source_id uuid, source_title text, source_type text, source_url text,
  page_url text, heading_path text[], page_number int, start_ms int, content text,
  score float, vector_rank int, text_rank int
)
language sql stable security invoker
set search_path = ''
set hnsw.iterative_scan = 'relaxed_order'
as $$
  with eligible as (
    select s.id, s.title, s.type, s.url
    from public.sources s
    where s.brand_id = p_brand
      and s.status in ('ready', 'stale')
      and (p_source_types is null or s.type = any (p_source_types))
      and (p_tags is null or s.tags && p_tags)
  ),
  vec as (
    select e.chunk_id, row_number() over (order by e.embedding operator(extensions.<=>) p_embedding) as rnk
    from public.embeddings e
    join public.knowledge_chunks k on k.id = e.chunk_id
    join eligible on eligible.id = k.source_id
    where p_embedding is not null and e.brand_id = p_brand and e.model = p_model
    order by e.embedding operator(extensions.<=>) p_embedding
    limit 50
  ),
  txt as (
    select k.id as chunk_id,
           row_number() over (order by ts_rank_cd(k.fts, q) desc) as rnk
    from public.knowledge_chunks k
    join eligible on eligible.id = k.source_id,
         websearch_to_tsquery('simple', coalesce(p_query, '')) q
    where k.brand_id = p_brand and k.fts @@ q
    order by ts_rank_cd(k.fts, q) desc
    limit 50
  ),
  fused as (
    select coalesce(v.chunk_id, t.chunk_id) as chunk_id,
           coalesce(1.0 / (60 + v.rnk), 0) + coalesce(1.0 / (60 + t.rnk), 0) as score,
           v.rnk::int as vector_rank, t.rnk::int as text_rank
    from vec v full outer join txt t on t.chunk_id = v.chunk_id
  )
  select k.id, k.source_id, el.title, el.type, el.url, k.page_url, k.heading_path, k.page_number, k.start_ms, k.content,
         f.score, f.vector_rank, f.text_rank
  from fused f
  join public.knowledge_chunks k on k.id = f.chunk_id
  join eligible el on el.id = k.source_id
  order by f.score desc, k.id
  limit least(greatest(p_limit, 1), 50);
$$;
grant execute on function public.search_knowledge(uuid, text, extensions.vector, text, int, text[], text[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Short-lived encrypted secrets (AES-256-GCM, encrypted by the app with ENCRYPTION_KEY).
-- Used for one-off imports (e.g. a Google Drive access token from the Picker) so tokens
-- never travel through Temporal history. No RLS policies → service role only.
-- ---------------------------------------------------------------------------
create table public.ephemeral_secrets (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  purpose      text not null,
  ciphertext   text not null,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);
create index on public.ephemeral_secrets (expires_at);
alter table public.ephemeral_secrets enable row level security;

create or replace function public.purge_expired_secrets() returns int
language sql security definer set search_path = '' as $$
  with d as (delete from public.ephemeral_secrets where expires_at < now() returning 1) select count(*)::int from d;
$$;
revoke all on function public.purge_expired_secrets() from public, anon, authenticated;
grant execute on function public.purge_expired_secrets() to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.sources;
  end if;
end $$;
