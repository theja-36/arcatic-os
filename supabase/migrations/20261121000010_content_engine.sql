-- Arcatic Marketing OS — 0010 Content creation engine (Phase 5)

-- ---------------------------------------------------------------------------
-- Content items / versions: templates, lineage, approval pointer
-- ---------------------------------------------------------------------------
alter table public.content_items
  add column template           text,                 -- 'social.post@1' …
  add column source_item_id     uuid references public.content_items(id) on delete set null,   -- translation / repurpose origin
  add column approved_version_id uuid references public.content_versions(id) on delete set null,
  add column metadata           jsonb not null default '{}'::jsonb,
  add column revision           int not null default 0;
create index on public.content_items (source_item_id);

alter table public.content_versions
  add column base_version          int,               -- version this one was derived from (edit / regen / transform)
  add column transform             text,              -- 'improve' | 'tone:friendly' | 'regenerate' | 'translate:te' …
  add column regenerated_block_ids text[] not null default array[]::text[];

-- Content status machine (mirrors packages/core/src/content/status.ts)
create or replace function app.guard_content_status() returns trigger
language plpgsql as $$
begin
  if new.status = old.status then return new; end if;
  if old.status = 'archived' and new.status <> 'draft' then
    raise exception 'archived content must be restored to draft first' using errcode = '23514';
  end if;
  if new.status = 'approved' and coalesce(current_setting('app.trusted_content_write', true), '') <> 'on' then
    raise exception 'content can only be approved through an approval decision' using errcode = '42501';
  end if;
  if old.status = 'published' and new.status not in ('archived') then
    raise exception 'published content can only be archived' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger content_items_status before update of status on public.content_items
  for each row execute function app.guard_content_status();

-- ---------------------------------------------------------------------------
-- Approvals: submit / decide atomically
-- ---------------------------------------------------------------------------
-- Submit the item's CURRENT version; it must have passed deterministic validation.
create or replace function public.submit_for_approval(p_item uuid, p_version uuid, p_actor uuid, p_due timestamptz default null)
returns public.approvals
language plpgsql security definer set search_path = '' as $$
declare
  i public.content_items;
  v public.content_versions;
  a public.approvals;
begin
  select * into i from public.content_items where id = p_item for update;
  if not found then raise exception 'not_found: content %', p_item using errcode = 'P0002'; end if;
  if i.current_version_id is distinct from p_version then
    raise exception 'conflict: only the latest version can be submitted' using errcode = '23514';
  end if;
  if i.status in ('generating','published','archived','scheduled') then
    raise exception 'conflict: content is %', i.status using errcode = '23514';
  end if;
  select * into v from public.content_versions where id = p_version;
  if coalesce((v.validation_report ->> 'passed')::boolean, false) is not true then
    raise exception 'validation_failed: fix the checklist errors before submitting' using errcode = '22023';
  end if;
  update public.approvals set status = 'cancelled', decided_at = now()
   where content_item_id = p_item and status = 'pending';
  insert into public.approvals (workspace_id, brand_id, content_item_id, content_version_id, requested_by, status, due_at)
  values (i.workspace_id, i.brand_id, p_item, p_version, p_actor, 'pending', p_due)
  returning * into a;
  update public.content_items set status = 'in_review' where id = p_item;
  return a;
end $$;

-- Decide a pending approval. Approving pins approved_version_id; any later edit sends it back to draft.
create or replace function public.decide_approval(p_approval uuid, p_decision text, p_comment text, p_actor uuid, p_allow_self boolean default true)
returns public.approvals
language plpgsql security definer set search_path = '' as $$
declare
  a public.approvals;
  i public.content_items;
begin
  if p_decision not in ('approved','rejected','changes_requested') then
    raise exception 'validation_failed: decision %', p_decision using errcode = '22023';
  end if;
  select * into a from public.approvals where id = p_approval for update;
  if not found then raise exception 'not_found: approval %', p_approval using errcode = 'P0002'; end if;
  if a.status <> 'pending' then raise exception 'conflict: approval is %', a.status using errcode = '23514'; end if;
  if not p_allow_self and a.requested_by = p_actor then
    raise exception 'forbidden: someone else must review this' using errcode = '42501';
  end if;
  select * into i from public.content_items where id = a.content_item_id for update;
  if i.current_version_id is distinct from a.content_version_id then
    update public.approvals set status = 'cancelled', decided_at = now() where id = a.id;
    raise exception 'conflict: the content changed after it was submitted' using errcode = '23514';
  end if;

  update public.approvals set status = p_decision, reviewer_id = p_actor, comment = p_comment, decided_at = now()
   where id = a.id returning * into a;

  perform set_config('app.trusted_content_write', 'on', true);
  update public.content_items set
    status = case p_decision when 'approved' then 'approved' when 'rejected' then 'draft' else 'changes_requested' end,
    approved_version_id = case when p_decision = 'approved' then a.content_version_id else approved_version_id end
   where id = i.id;
  perform set_config('app.trusted_content_write', 'off', true);

  insert into public.learning_signals (workspace_id, brand_id, content_item_id, content_version_id, signal, details, actor_id)
  values (i.workspace_id, i.brand_id, i.id, a.content_version_id,
          case p_decision when 'approved' then 'approve' when 'rejected' then 'reject' else 'request_changes' end,
          jsonb_build_object('comment', p_comment), p_actor);
  return a;
end $$;

revoke all on function public.submit_for_approval(uuid, uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.decide_approval(uuid, text, text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.submit_for_approval(uuid, uuid, uuid, timestamptz), public.decide_approval(uuid, text, text, uuid, boolean) to service_role;

-- A new version invalidates a previous approval/review: back to draft.
create or replace function app.content_version_resets_status() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.current_version_id is distinct from old.current_version_id and old.status in ('approved','in_review','changes_requested') then
    update public.approvals set status = 'cancelled', decided_at = now() where content_item_id = new.id and status = 'pending';
    new.status := 'draft';
  end if;
  return new;
end $$;
create trigger content_items_version_reset before update of current_version_id on public.content_items
  for each row execute function app.content_version_resets_status();

-- ---------------------------------------------------------------------------
-- AI model registry (licence gate for image/video models)
-- ---------------------------------------------------------------------------
create table public.ai_models (
  key              text primary key,
  provider         text not null check (provider in ('anthropic','comfyui','other')),
  kind             text not null check (kind in ('text','image','video','embedding','transcription')),
  display_name     text not null,
  license          text not null,
  commercial_use   boolean not null,
  enabled          boolean not null default true,
  checkpoint       text,                -- ComfyUI ckpt_name
  default_params   jsonb not null default '{}'::jsonb,
  notes            text
);
alter table public.ai_models enable row level security;
create policy ai_models_read on public.ai_models for select to authenticated using (true);
grant select on public.ai_models to authenticated;

insert into public.ai_models (key, provider, kind, display_name, license, commercial_use, enabled, checkpoint, default_params, notes) values
  ('sdxl-base-1.0', 'comfyui', 'image', 'Stable Diffusion XL 1.0', 'CreativeML Open RAIL++-M', true, true, 'sd_xl_base_1.0.safetensors',
   '{"steps":30,"cfg":6.5,"sampler":"dpmpp_2m","scheduler":"karras"}', 'Use-based restrictions apply (see licence attachment A).'),
  ('flux.1-schnell', 'comfyui', 'image', 'FLUX.1 [schnell]', 'Apache-2.0', true, false, 'flux1-schnell-fp8.safetensors',
   '{"steps":4,"cfg":1.0,"sampler":"euler","scheduler":"simple"}', 'Enable once the checkpoint is installed on the GPU node.'),
  ('flux.1-dev', 'comfyui', 'image', 'FLUX.1 [dev]', 'FLUX.1 [dev] Non-Commercial License', false, false, null, '{}',
   'Non-commercial: never enable for customer generations.');

-- ---------------------------------------------------------------------------
-- Knowledge search restricted to chosen sources (generation references)
-- ---------------------------------------------------------------------------
create or replace function public.search_knowledge_in(
  p_brand uuid, p_query text, p_source_ids uuid[], p_embedding extensions.vector(1024) default null, p_model text default null, p_limit int default 8
) returns table (
  chunk_id uuid, source_id uuid, source_title text, source_type text, source_url text,
  page_url text, heading_path text[], page_number int, start_ms int, content text,
  score float, vector_rank int, text_rank int
)
language sql stable security invoker set search_path = '' as $$
  select r.* from public.search_knowledge(p_brand, p_query, p_embedding, p_model, 50, null, null) r
  where r.source_id = any (p_source_ids)
     or exists (select 1 from public.sources s where s.id = r.source_id and s.parent_source_id = any (p_source_ids))
  order by r.score desc
  limit least(greatest(p_limit, 1), 30);
$$;
grant execute on function public.search_knowledge_in(uuid, text, uuid[], extensions.vector, text, int) to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.content_items, public.approvals;
  end if;
end $$;

-- Approvals are written only through submit_for_approval / decide_approval (via the API).
drop policy if exists approvals_insert on public.approvals;
drop policy if exists approvals_decide on public.approvals;
