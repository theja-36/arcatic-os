-- RLS + ledger smoke test. Run as superuser after migrations:
--   psql -v ON_ERROR_STOP=1 -f 10_rls_smoke.sql
-- Each block raises on failure.
\set a '11111111-1111-1111-1111-111111111111'
\set b '22222222-2222-2222-2222-222222222222'
\set c '33333333-3333-3333-3333-333333333333'

insert into auth.users (id, email) values (:'a','a@example.test'), (:'b','b@example.test'), (:'c','c@example.test');

create temp table ctx (k text primary key, v uuid);
grant all on ctx to authenticated, service_role;

-- A and B each bootstrap their own org
set role authenticated;
select set_config('request.jwt.claim.sub', :'a', false);
insert into ctx select 'wsA', public.create_organization('Org A', 'Workspace A', 'ws-a');
with b as (insert into public.brands (workspace_id, name) select v, 'Brand A' from ctx where k='wsA' returning id)
insert into ctx select 'brandA', id from b;
select set_config('request.jwt.claim.sub', :'b', false);
insert into ctx select 'wsB', public.create_organization('Org B', 'Workspace B', 'ws-b');
reset role; select set_config('request.jwt.claim.sub', '', false);

do $$
declare wsA uuid := (select v from ctx where k='wsA');
begin
  assert (select balance from public.credits where workspace_id = wsA) = 100, 'trial grant';
  assert (select role from public.workspace_members where workspace_id = wsA) = 'owner', 'owner membership';
  assert (select count(*) from public.audit_logs where workspace_id = wsA) >= 3, 'audit rows written';
end $$;

-- 1. B cannot see or write A's tenant
set role authenticated;
select set_config('request.jwt.claim.sub', :'b', false);
do $$
declare wsA uuid := (select v from ctx where k='wsA');
begin
  assert (select count(*) from public.brands where workspace_id = wsA) = 0, 'B must not see A brands';
  assert (select count(*) from public.workspaces where id = wsA) = 0, 'B must not see A workspace';
  assert (select count(*) from public.credits where workspace_id = wsA) = 0, 'B must not see A wallet';
  begin
    insert into public.brands (workspace_id, name) values (wsA, 'evil');
    raise exception 'B inserted into A';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 2. A cannot call ledger functions directly
select set_config('request.jwt.claim.sub', :'a', false);
do $$
begin
  perform public.reserve_credits((select v from ctx where k='wsA'), 1, 'x');
  raise exception 'authenticated user reserved credits';
exception when insufficient_privilege then null;
end $$;

-- 3. Last owner cannot leave
do $$
begin
  delete from public.workspace_members where user_id = auth.uid();
  raise exception 'last owner removed';
exception when check_violation then null;
end $$;
reset role; select set_config('request.jwt.claim.sub', '', false);

-- 4. Viewer C: read but not write; cannot escalate
insert into public.workspace_members (workspace_id, user_id, role)
select v, :'c', 'viewer' from ctx where k='wsA';
set role authenticated;
select set_config('request.jwt.claim.sub', :'c', false);
do $$
declare wsA uuid := (select v from ctx where k='wsA'); n int;
begin
  assert (select count(*) from public.brands where workspace_id = wsA) = 1, 'viewer reads brand';
  assert (select count(*) from public.audit_logs where workspace_id = wsA) = 0, 'viewer has no audit.read';
  begin
    insert into public.brands (workspace_id, name) values (wsA, 'nope');
    raise exception 'viewer created brand';
  exception when insufficient_privilege then null;
  end;
  update public.workspace_members set role = 'owner' where workspace_id = wsA and user_id = auth.uid();
  get diagnostics n = row_count;
  assert n = 0, 'viewer self-promoted';
end $$;
reset role; select set_config('request.jwt.claim.sub', '', false);

-- 5. Admin cannot grant owner
update public.workspace_members set role = 'admin' where user_id = :'c';
set role authenticated;
select set_config('request.jwt.claim.sub', :'c', false);
do $$
begin
  update public.workspace_members set role = 'owner' where user_id = auth.uid();
  raise exception 'admin escalated to owner';
exception when insufficient_privilege then null;
end $$;

-- 6. Brand-restricted member sees only assigned brands
reset role; select set_config('request.jwt.claim.sub', '', false);
update public.workspace_members set role = 'editor', brand_restricted = true where user_id = :'c';
set role authenticated;
select set_config('request.jwt.claim.sub', :'c', false);
do $$
begin
  assert (select count(*) from public.brands) = 0, 'restricted member sees unassigned brand';
end $$;
reset role; select set_config('request.jwt.claim.sub', '', false);
insert into public.brand_members (brand_id, workspace_id, user_id)
select (select v from ctx where k='brandA'), (select v from ctx where k='wsA'), :'c';
set role authenticated;
select set_config('request.jwt.claim.sub', :'c', false);
do $$
begin
  assert (select count(*) from public.brands) = 1, 'restricted member sees assigned brand';
end $$;
reset role; select set_config('request.jwt.claim.sub', '', false);

-- 7. Credit ledger: reserve / idempotent replay / settle / release / insufficient
do $$
declare wsA uuid := (select v from ctx where k='wsA'); r1 public.credit_reservations; r2 public.credit_reservations; r3 public.credit_reservations;
begin
  r1 := public.reserve_credits(wsA, 30, 'job-1');
  r2 := public.reserve_credits(wsA, 30, 'job-1');
  assert r1.id = r2.id, 'idempotent reserve';
  assert (select held from public.credits where workspace_id = wsA) = 30, 'held 30';
  perform public.settle_reservation(r1.id, 20);
  perform public.settle_reservation(r1.id, 20);  -- replay
  assert (select balance from public.credits where workspace_id = wsA) = 80, 'balance 80 after settle';
  assert (select held from public.credits where workspace_id = wsA) = 0, 'held 0 after settle';
  assert (select count(*) from public.credit_transactions where workspace_id = wsA and kind = 'debit') = 1, 'one debit';
  r3 := public.reserve_credits(wsA, 50, 'job-2');
  perform public.release_reservation(r3.id);
  perform public.release_reservation(r3.id);
  assert (select held from public.credits where workspace_id = wsA) = 0, 'held 0 after release';
  assert (select balance from public.credits where workspace_id = wsA) = 80, 'release does not charge';
  begin
    perform public.reserve_credits(wsA, 500, 'job-3');
    raise exception 'over-reserve allowed';
  exception when raise_exception then
    if sqlerrm not like 'insufficient_credits%' then raise; end if;
  end;
end $$;

-- 8. Content versions are immutable; scope is inherited from parent
do $$
declare wsA uuid := (select v from ctx where k='wsA'); brandA uuid := (select v from ctx where k='brandA');
        ci uuid; cv uuid; wsB uuid := (select v from ctx where k='wsB');
begin
  insert into public.content_items (workspace_id, brand_id, type, channel) values (wsA, brandA, 'social_post', 'instagram') returning id into ci;
  -- caller lies about workspace; trigger overrides from parent
  insert into public.content_versions (workspace_id, brand_id, content_item_id, version, origin, body)
  values (wsB, brandA, ci, 1, 'human', '{"text":"hi"}') returning id into cv;
  assert (select workspace_id from public.content_versions where id = cv) = wsA, 'scope inherited';
  begin
    update public.content_versions set body = '{"text":"changed"}' where id = cv;
    raise exception 'version mutated';
  exception when insufficient_privilege then null;
  end;
  update public.content_versions set feedback = '{"rating":5}' where id = cv;  -- allowed
  begin
    insert into public.content_versions (content_item_id, version, origin, body) values (ci, 2, 'ai', '{}');
    raise exception 'ai version without provenance accepted';
  exception when check_violation then null;
  end;
end $$;

-- 9. Job state machine
do $$
declare wsA uuid := (select v from ctx where k='wsA'); j uuid;
begin
  insert into public.generation_jobs (workspace_id, kind) values (wsA, 'generate.social_post') returning id into j;
  update public.generation_jobs set status = 'running' where id = j;
  update public.generation_jobs set status = 'succeeded' where id = j;
  assert (select progress from public.generation_jobs where id = j) = 100, 'progress 100';
  begin
    update public.generation_jobs set status = 'running' where id = j;
    raise exception 'terminal job restarted';
  exception when check_violation then null;
  end;
end $$;


-- 10. Brand Kit versions: editors write drafts, viewers read only, versions immutable, approval atomic
reset role; select set_config('request.jwt.claim.sub', '', false);
insert into public.workspace_members (workspace_id, user_id, role)
select v, :'b', 'viewer' from ctx where k='wsA';
set role authenticated;
select set_config('request.jwt.claim.sub', :'a', false);
do $$
declare wsA uuid := (select v from ctx where k='wsA'); brandA uuid := (select v from ctx where k='brandA');
begin
  insert into public.brand_onboarding (brand_id, workspace_id, answers) values (brandA, wsA, '{"businessType":"restaurant"}');
  insert into public.brand_kit_versions (workspace_id, brand_id, version, origin, kit) values (wsA, brandA, 1, 'manual', '{"name":"A"}');
  insert into public.brand_kit_versions (workspace_id, brand_id, version, origin, kit) values (wsA, brandA, 2, 'manual', '{"name":"A2"}');
  begin
    insert into public.brand_kit_versions (workspace_id, brand_id, version, origin, kit, status) values (wsA, brandA, 3, 'manual', '{}', 'approved');
    raise exception 'editor inserted an approved version directly';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', :'b', false);
do $$
declare brandA uuid := (select v from ctx where k='brandA');
begin
  assert (select count(*) from public.brand_kit_versions where brand_id = brandA) = 2, 'viewer reads versions';
  assert (select count(*) from public.brand_onboarding where brand_id = brandA) = 1, 'viewer reads onboarding';
  begin
    insert into public.brand_kit_versions (workspace_id, brand_id, version, origin, kit)
    values ((select v from ctx where k='wsA'), brandA, 9, 'manual', '{}');
    raise exception 'viewer wrote a kit version';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role; select set_config('request.jwt.claim.sub', '', false);
do $$
declare brandA uuid := (select v from ctx where k='brandA'); v1 uuid; v2 uuid;
begin
  select id into v1 from public.brand_kit_versions where brand_id = brandA and version = 1;
  select id into v2 from public.brand_kit_versions where brand_id = brandA and version = 2;
  begin
    update public.brand_kit_versions set kit = '{"name":"tampered"}' where id = v1;
    raise exception 'kit version mutated';
  exception when insufficient_privilege then null;
  end;
  perform public.approve_brand_kit_version(v1, '{"name":"A"}', 'h1', array['f1'], 10, null);
  perform public.approve_brand_kit_version(v1, '{"name":"A"}', 'h1', array['f1'], 10, null);  -- idempotent
  assert (select active_kit_version_id from public.brands where id = brandA) = v1, 'brand points at v1';
  perform public.approve_brand_kit_version(v2, '{"name":"A2"}', 'h2', array['f1'], 10, null);
  assert (select status from public.brand_kit_versions where id = v1) = 'superseded', 'v1 superseded';
  assert (select count(*) from public.brand_kit_versions where brand_id = brandA and status = 'approved') = 1, 'one approved';
  assert (select count(*) from public.brand_contexts where brand_id = brandA) = 2, 'contexts stored';
  begin
    perform public.approve_brand_kit_version(v1, '{}', 'h', array[]::text[], 1, null);
    raise exception 'superseded version re-approved';
  exception when check_violation then null;
  end;
end $$;

-- 11. Selective regeneration lookup
do $$
declare wsA uuid := (select v from ctx where k='wsA'); brandA uuid := (select v from ctx where k='brandA'); ci uuid; cv uuid;
begin
  insert into public.content_items (workspace_id, brand_id, type) values (wsA, brandA, 'social_post') returning id into ci;
  insert into public.content_versions (content_item_id, version, origin, body, model, prompt_template, depends_on_facts)
  values (ci, 1, 'ai', '{}', 'm', 'social.post@1', array['voice.tone','oneLiner']) returning id into cv;
  update public.content_items set current_version_id = cv where id = ci;
  assert (select count(*) from public.content_affected_by_facts(brandA, array['voice.tone'])) = 1, 'affected found';
  assert (select count(*) from public.content_affected_by_facts(brandA, array['visual.colors'])) = 0, 'unaffected ignored';
end $$;


-- 12. Knowledge: private sources, atomic re-index, hybrid search, isolation
\set d '44444444-4444-4444-4444-444444444444'
reset role; select set_config('request.jwt.claim.sub', '', false);
insert into auth.users (id, email) values (:'d', 'd@example.test');
do $$
declare wsA uuid := (select v from ctx where k='wsA'); brandA uuid := (select v from ctx where k='brandA');
        s1 uuid; s2 uuid; c0 uuid; c1 uuid; p0 uuid;
        e1 extensions.vector := (array[1]::real[] || array_fill(0::real, array[1023]))::real[]::extensions.vector;
        e2 extensions.vector := (array[0, 1]::real[] || array_fill(0::real, array[1022]))::real[]::extensions.vector;
begin
  insert into public.sources (workspace_id, brand_id, type, title, status, visibility, owner_id)
  values (wsA, brandA, 'url', 'Menu page', 'ready', 'brand', '11111111-1111-1111-1111-111111111111') returning id into s1;
  insert into public.sources (workspace_id, brand_id, type, title, status, visibility, owner_id)
  values (wsA, brandA, 'text', 'Private pricing notes', 'ready', 'private', '33333333-3333-3333-3333-333333333333') returning id into s2;
  insert into ctx values ('s1', s1), ('s2', s2);

  perform * from public.replace_source_chunks(s1, '[{"ordinal":0,"content":"Fresh idli breakfast tiffins delivered in Gachibowli","pageUrl":"https://x.in/menu","headingPath":["Menu","Breakfast"]},{"ordinal":1,"content":"Lunch box with rice and sambar"}]');
  perform * from public.replace_source_chunks(s2, '[{"ordinal":0,"content":"Secret idli pricing strategy for next quarter"}]');
  select id into c0 from public.knowledge_chunks where source_id = s1 and ordinal = 0;
  select id into c1 from public.knowledge_chunks where source_id = s1 and ordinal = 1;
  select id into p0 from public.knowledge_chunks where source_id = s2;
  insert into public.embeddings (chunk_id, workspace_id, brand_id, model, embedding) values
    (c0, wsA, brandA, 'bge-m3', e1), (c1, wsA, brandA, 'bge-m3', e2), (p0, wsA, brandA, 'bge-m3', e1);
  assert (select embedded_count from public.refresh_source_counts(s1, 'bge-m3')) = 2, 'embedded count';
  assert (select heading_path from public.knowledge_chunks where id = c0) = array['Menu','Breakfast'], 'heading path stored';
end $$;

-- viewer B: sees the brand source and its chunks, not C's private source
set role authenticated;
select set_config('request.jwt.claim.sub', :'b', false);
do $$
declare brandA uuid := (select v from ctx where k='brandA');
        e1 extensions.vector := (array[1]::real[] || array_fill(0::real, array[1023]))::real[]::extensions.vector;
        top record;
begin
  assert (select count(*) from public.sources where brand_id = brandA) = 1, 'viewer sees only brand-visible sources';
  assert (select count(*) from public.knowledge_chunks where source_id = (select v from ctx where k='s2')) = 0, 'private chunks hidden';
  select * into top from public.search_knowledge(brandA, 'idli', e1, 'bge-m3', 5) limit 1;
  assert top.source_title = 'Menu page', 'hybrid search top hit';
  assert top.vector_rank = 1 and top.text_rank = 1, 'both signals agree';
  assert (select count(*) from public.search_knowledge(brandA, 'idli', e1, 'bge-m3', 5) where source_id = (select v from ctx where k='s2')) = 0, 'private source never returned';
  assert (select content from public.search_knowledge(brandA, 'sambar') limit 1) = 'Lunch box with rice and sambar', 'full-text only fallback';
  assert (select count(*) from public.search_knowledge(brandA, 'idli', null, null, 5, array['text'])) = 0, 'source type filter';
end $$;

-- owner of the private source sees it
select set_config('request.jwt.claim.sub', :'c', false);
do $$
begin
  assert (select count(*) from public.sources where id = (select v from ctx where k='s2')) = 1, 'owner sees private source';
end $$;

-- a user with no membership sees nothing
select set_config('request.jwt.claim.sub', :'d', false);
do $$
begin
  assert (select count(*) from public.search_knowledge((select v from ctx where k='brandA'), 'idli')) = 0, 'outsider search returns nothing';
  assert (select count(*) from public.sources) = 0, 'outsider sees no sources';
end $$;
reset role; select set_config('request.jwt.claim.sub', '', false);

-- re-index replaces chunks and drops their embeddings atomically
do $$
declare s1 uuid := (select v from ctx where k='s1');
begin
  perform * from public.replace_source_chunks(s1, '[{"ordinal":0,"content":"New menu"}]');
  assert (select chunk_count from public.sources where id = s1) = 1, 'chunk count after replace';
  assert (select count(*) from public.embeddings e join public.knowledge_chunks k on k.id = e.chunk_id where k.source_id = s1) = 0, 'old embeddings removed';
end $$;


-- 13. Strategies: revision conflicts, immutable revisions, one active per brand, read-only for clients
do $$
declare wsA uuid := (select v from ctx where k='wsA'); brandA uuid := (select v from ctx where k='brandA'); st uuid; st2 uuid; rev int;
begin
  insert into public.strategies (workspace_id, brand_id, title, starts_on, ends_on, plan) values (wsA, brandA, 'Q1', '2027-01-04', '2027-04-04', '{"summary":"a"}') returning id into st;
  insert into ctx values ('st', st);
  rev := public.save_strategy_plan(st, 0, '{"summary":"b"}', 'human', array['summary'], null);
  assert rev = 1, 'revision 1';
  begin
    perform public.save_strategy_plan(st, 0, '{"summary":"stale"}', 'human', array[]::text[], null);
    raise exception 'stale revision accepted';
  exception when check_violation then null;
  end;
  assert (select plan ->> 'summary' from public.strategies where id = st) = 'b', 'plan saved';
  begin
    update public.strategy_revisions set plan = '{}' where strategy_id = st;
    raise exception 'revision mutated';
  exception when insufficient_privilege then null;
  end;
  update public.strategies set status = 'active' where id = st;
  insert into public.strategies (workspace_id, brand_id, title, starts_on, ends_on) values (wsA, brandA, 'Q2', '2027-04-05', '2027-07-04') returning id into st2;
  begin
    update public.strategies set status = 'active' where id = st2;
    raise exception 'two active strategies';
  exception when unique_violation then null;
  end;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', :'b', false);   -- viewer in wsA
do $$
begin
  assert (select count(*) from public.strategies where brand_id = (select v from ctx where k='brandA')) = 2, 'viewer reads strategies';
  assert (select count(*) from public.strategy_revisions where strategy_id = (select v from ctx where k='st')) = 1, 'viewer reads revisions';
  begin
    insert into public.strategies (workspace_id, brand_id, title, starts_on, ends_on)
    values ((select v from ctx where k='wsA'), (select v from ctx where k='brandA'), 'x', '2027-01-01', '2027-02-01');
    raise exception 'client inserted a strategy';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.seasonal_events (workspace_id, name, on_date) values ((select v from ctx where k='wsA'), 'Store anniversary', '2027-03-01');
    raise exception 'viewer added a seasonal event';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role; select set_config('request.jwt.claim.sub', '', false);

-- 14. Campaign lifecycle + topic slots
do $$
declare wsA uuid := (select v from ctx where k='wsA'); brandA uuid := (select v from ctx where k='brandA'); c uuid;
begin
  insert into public.campaigns (workspace_id, brand_id, name, status) values (wsA, brandA, 'Sankranti offer', 'planned') returning id into c;
  update public.campaigns set status = 'active' where id = c;
  update public.campaigns set status = 'paused' where id = c;
  assert (select paused_at from public.campaigns where id = c) is not null, 'paused_at set';
  update public.campaigns set status = 'active' where id = c;
  assert (select paused_at from public.campaigns where id = c) is null, 'paused_at cleared';
  begin
    update public.campaigns set status = 'draft' where id = c;
    raise exception 'active -> draft allowed';
  exception when check_violation then null;
  end;
  insert into public.campaign_topics (campaign_id, title, slot_key, channel, planned_for) values (c, 'Til ladoo gift box', '2027-01-11:instagram:0', 'instagram', '2027-01-11');
  begin
    insert into public.campaign_topics (campaign_id, title, slot_key) values (c, 'duplicate slot', '2027-01-11:instagram:0');
    raise exception 'duplicate slot accepted';
  exception when unique_violation then null;
  end;
  begin
    update public.campaign_topics set status = 'published' where campaign_id = c;
    raise exception 'bad topic status accepted';
  exception when check_violation then null;
  end;
  assert (select brand_id from public.campaign_topics where campaign_id = c limit 1) = brandA, 'topic scope inherited';
  update public.campaigns set status = 'cancelled' where id = c;
  begin
    update public.campaigns set status = 'active' where id = c;
    raise exception 'cancelled campaign restarted';
  exception when check_violation then null;
  end;
end $$;


-- 15. Content approval workflow
reset role; select set_config('request.jwt.claim.sub', '', false);
do $$
declare wsA uuid := (select v from ctx where k='wsA'); brandA uuid := (select v from ctx where k='brandA');
        ci uuid; v1 uuid; v2 uuid; ap uuid; ap2 uuid;
begin
  insert into public.content_items (workspace_id, brand_id, type, channel) values (wsA, brandA, 'social_post', 'instagram') returning id into ci;
  insert into ctx values ('ci', ci);
  insert into public.content_versions (content_item_id, version, origin, body, validation_report) values (ci, 1, 'human', '{}', '{"passed": false}') returning id into v1;
  update public.content_items set current_version_id = v1 where id = ci;
  begin
    perform public.submit_for_approval(ci, v1, null);
    raise exception 'failing version submitted';
  exception when invalid_parameter_value then null;
  end;
  insert into public.content_versions (content_item_id, version, origin, body, validation_report) values (ci, 2, 'human', '{}', '{"passed": true}') returning id into v2;
  update public.content_items set current_version_id = v2 where id = ci;
  begin
    perform public.submit_for_approval(ci, v1, null);
    raise exception 'old version submitted';
  exception when check_violation then null;
  end;
  ap := (public.submit_for_approval(ci, v2, '11111111-1111-1111-1111-111111111111')).id;
  assert (select status from public.content_items where id = ci) = 'in_review', 'in review';
  begin
    perform public.decide_approval(ap, 'approved', 'x', '11111111-1111-1111-1111-111111111111', false);
    raise exception 'self approval allowed when disabled';
  exception when insufficient_privilege then null;
  end;
  perform public.decide_approval(ap, 'approved', 'Looks good', '33333333-3333-3333-3333-333333333333');
  assert (select status from public.content_items where id = ci) = 'approved', 'approved';
  assert (select approved_version_id from public.content_items where id = ci) = v2, 'approved version pinned';
  assert (select count(*) from public.learning_signals where content_item_id = ci and signal = 'approve') = 1, 'learning signal';
  begin
    perform public.decide_approval(ap, 'rejected', null, null);
    raise exception 'decided twice';
  exception when check_violation then null;
  end;

  -- a new version sends approved content back to draft and cancels pending reviews
  ap2 := (public.submit_for_approval(ci, v2, null)).id;
  insert into public.content_versions (content_item_id, version, origin, body, validation_report) values (ci, 3, 'human', '{}', '{"passed": true}') returning id into v1;
  update public.content_items set current_version_id = v1 where id = ci;
  assert (select status from public.content_items where id = ci) = 'draft', 'back to draft after edit';
  assert (select status from public.approvals where id = ap2) = 'cancelled', 'pending review cancelled';
end $$;

-- clients can't approve content or write approvals directly
set role authenticated;
select set_config('request.jwt.claim.sub', :'a', false);   -- owner A
do $$
begin
  begin
    update public.content_items set status = 'approved' where id = (select v from ctx where k='ci');
    raise exception 'client approved content directly';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.approvals (workspace_id, brand_id, content_item_id, content_version_id, status)
    select workspace_id, brand_id, id, current_version_id, 'approved' from public.content_items where id = (select v from ctx where k='ci');
    raise exception 'client wrote an approval';
  exception when insufficient_privilege then null;
  end;
  assert (select count(*) from public.ai_models where commercial_use) >= 2, 'model registry readable';
end $$;
reset role; select set_config('request.jwt.claim.sub', '', false);

-- references: search restricted to chosen sources (incl. crawl children)
do $$
declare brandA uuid := (select v from ctx where k='brandA'); s1 uuid := (select v from ctx where k='s1');
begin
  assert (select count(*) from public.search_knowledge_in(brandA, 'menu', array[s1])) = 1, 'restricted search hit';
  assert (select count(*) from public.search_knowledge_in(brandA, 'menu', array[gen_random_uuid()])) = 0, 'other sources excluded';
end $$;


-- 16. Media folders
reset role; select set_config('request.jwt.claim.sub', '', false);
do $$
declare wsA uuid := (select v from ctx where k='wsA'); wsB uuid := (select v from ctx where k='wsB'); f1 uuid; f2 uuid; fb uuid; a uuid;
begin
  insert into public.media_collections (workspace_id, name) values (wsA, 'Festivals') returning id into f1;
  insert into public.media_collections (workspace_id, parent_id, name) values (wsA, f1, 'Sankranti 2027') returning id into f2;
  begin
    update public.media_collections set parent_id = f2 where id = f1;
    raise exception 'folder cycle accepted';
  exception when check_violation then null;
  end;
  insert into public.media_collections (workspace_id, name) values (wsB, 'Other tenant') returning id into fb;
  begin
    insert into public.media_collections (workspace_id, parent_id, name) values (wsA, fb, 'sneaky');
    raise exception 'cross-workspace parent accepted';
  exception when foreign_key_violation then null;
  end;
  insert into public.media_assets (workspace_id, kind, title, collection_id) values (wsA, 'image', 'kite.png', f2) returning id into a;
  begin
    update public.media_assets set collection_id = fb where id = a;
    raise exception 'asset moved into another workspace folder';
  exception when foreign_key_violation then null;
  end;
  delete from public.media_collections where id = f1;
  assert (select collection_id from public.media_assets where id = a) is null, 'asset kept when folder deleted';
  assert (select count(*) from public.media_collections where id = f2) = 0, 'subfolder deleted with parent';
end $$;

-- 17. Video projects
do $$
declare wsA uuid := (select v from ctx where k='wsA'); brandA uuid := (select v from ctx where k='brandA'); p uuid; r int;
begin
  insert into public.video_projects (workspace_id, brand_id, title, export_preset, timeline) values (wsA, brandA, 'Reel', 'instagram-reel', '{"format":1}') returning id into p;
  insert into ctx values ('vp', p);
  r := public.save_video_timeline(p, 0, '{"format":1,"v":2}', 15000);
  assert r = 1, 'revision 1';
  begin
    perform public.save_video_timeline(p, 0, '{}', 1);
    raise exception 'stale timeline accepted';
  exception when check_violation then null;
  end;
  update public.video_projects set status = 'rendered' where id = p;
  perform public.save_video_timeline(p, 1, '{"format":1,"v":3}', 16000);
  assert (select status from public.video_projects where id = p) = 'draft', 'edit makes the render stale';
  update public.video_projects set status = 'rendering' where id = p;
  begin
    perform public.save_video_timeline(p, 2, '{}', 1);
    raise exception 'saved during render';
  exception when check_violation then null;
  end;
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', :'b', false);   -- viewer
do $$
declare n int;
begin
  assert (select count(*) from public.video_projects where id = (select v from ctx where k='vp')) = 1, 'viewer reads projects';
  update public.video_projects set title = 'hacked' where id = (select v from ctx where k='vp');
  get diagnostics n = row_count;
  assert n = 0, 'client updated a project directly';
  begin
    insert into public.media_collections (workspace_id, name) values ((select v from ctx where k='wsA'), 'viewer folder');
    raise exception 'viewer created a folder';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role; select set_config('request.jwt.claim.sub', '', false);

-- 18. Publishing: approval gate at publish time, account/brand guard, secrets service-only
do $$
declare wsA uuid := (select v from ctx where k='wsA'); brandA uuid := (select v from ctx where k='brandA');
        wsB uuid := (select v from ctx where k='wsB');
        brand2 uuid; acc uuid; acc2 uuid; accB uuid; ci uuid; v1 uuid; v2 uuid; ap uuid; s uuid; r jsonb;
begin
  insert into public.brands (workspace_id, name) values (wsA, 'Brand A2') returning id into brand2;
  insert into public.integration_secrets (workspace_id, purpose, ciphertext) values (wsA, 'postiz_api_key', 'enc:xyz');
  insert into public.publishing_connections (workspace_id, provider, base_url) values (wsA, 'postiz', 'https://postiz.example.test');
  insert into public.publishing_connections (workspace_id, provider, base_url) values (wsB, 'postiz', 'https://postiz.example.test');
  insert into public.connected_accounts (workspace_id, brand_id, provider, external_id, channel) values (wsA, null, 'postiz:instagram', 'ig1', 'instagram') returning id into acc;
  insert into public.connected_accounts (workspace_id, brand_id, provider, external_id, channel) values (wsA, brand2, 'postiz:x', 'x1', 'x') returning id into acc2;
  insert into public.connected_accounts (workspace_id, provider, external_id, channel) values (wsB, 'postiz:x', 'xb', 'x') returning id into accB;
  insert into ctx values ('acc', acc);

  insert into public.content_items (workspace_id, brand_id, type, channel) values (wsA, brandA, 'social_post', 'instagram') returning id into ci;
  insert into ctx values ('pci', ci);
  insert into public.content_versions (content_item_id, version, origin, body, validation_report) values (ci, 1, 'human', '{}', '{"passed": true}') returning id into v1;
  update public.content_items set current_version_id = v1 where id = ci;

  -- another brand's account and another workspace's account are refused
  begin
    insert into public.schedules (workspace_id, brand_id, content_item_id, connected_account_id, publish_at) values (wsA, brandA, ci, acc2, now());
    raise exception 'scheduled to another brand''s account';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.schedules (workspace_id, brand_id, content_item_id, connected_account_id, publish_at) values (wsA, brandA, ci, accB, now());
    raise exception 'scheduled to another workspace''s account';
  exception when insufficient_privilege then null;
  end;

  -- not approved at publish time → missed
  insert into public.schedules (workspace_id, brand_id, content_item_id, connected_account_id, publish_at) values (wsA, brandA, ci, acc, now()) returning id into s;
  insert into ctx values ('sch', s);
  r := public.claim_schedule(s, 0);
  assert (r ->> 'ok')::boolean = false and r ->> 'reason' = 'blocked', 'unapproved content blocked';
  assert (select status from public.schedules where id = s) = 'missed', 'marked missed';

  -- approved → claimed once; stale revision refused
  ap := (public.submit_for_approval(ci, v1, null)).id;
  perform public.decide_approval(ap, 'approved', null, '33333333-3333-3333-3333-333333333333');
  update public.schedules set status = 'scheduled', revision = revision + 1 where id = s;
  assert (public.claim_schedule(s, 0)) ->> 'reason' = 'superseded', 'old workflow revision refused';
  r := public.claim_schedule(s, 1);
  assert (r ->> 'ok')::boolean, 'approved content claimed';
  assert (r ->> 'versionId')::uuid = v1, 'approved version pinned';
  assert (public.claim_schedule(s, 1)) ->> 'reason' = 'not_scheduled', 'no double claim';

  -- edited after approval → blocked
  update public.schedules set status = 'scheduled', revision = revision + 1 where id = s;
  insert into public.content_versions (content_item_id, version, origin, body, validation_report) values (ci, 2, 'human', '{}', '{"passed": true}') returning id into v2;
  update public.content_items set current_version_id = v2 where id = ci;
  assert (public.claim_schedule(s, 2)) ->> 'reason' = 'blocked', 'edit after approval blocks publishing';

  -- disabled account → blocked
  update public.content_items set status = 'archived' where id = ci;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', :'a', false);   -- owner A
do $$
declare n int;
begin
  begin
    perform 1 from public.integration_secrets limit 1;
    raise exception 'client read secrets';
  exception when insufficient_privilege then null;
  end;
  assert (select count(*) from public.publishing_connections) = 1, 'owner sees the connection';
  assert (select count(*) from public.connected_accounts where channel is not null) = 2, 'owner sees own workspace accounts only';
  update public.schedules set status = 'scheduled', publish_at = now() where id = (select v from ctx where k='sch');
  get diagnostics n = row_count;
  assert n = 0, 'client changed a schedule directly';
  begin
    insert into public.schedules (workspace_id, brand_id, content_item_id, connected_account_id, publish_at)
    select workspace_id, brand_id, id, (select v from ctx where k='acc'), now() from public.content_items where id = (select v from ctx where k='pci');
    raise exception 'client created a schedule directly';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', :'b', false);   -- owner of B, viewer in A
do $$
begin
  assert (select count(*) from public.publishing_connections) = 2, 'member of both workspaces sees both';
  assert (select count(*) from public.schedules where id = (select v from ctx where k='sch')) = 1, 'viewer reads schedules';
  begin
    perform 1 from public.integration_secrets limit 1;
    raise exception 'viewer read secrets';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role; select set_config('request.jwt.claim.sub', '', false);

-- 19. Analytics warehouse: one row per key/day, latest snapshot per post, isolation, decisions via API
do $$
declare wsA uuid := (select v from ctx where k='wsA'); brandA uuid := (select v from ctx where k='brandA');
        acc uuid := (select v from ctx where k='acc'); ci uuid; v1 uuid; ap uuid; s uuid; n int;
begin
  insert into public.content_items (workspace_id, brand_id, type, channel) values (wsA, brandA, 'social_post', 'instagram') returning id into ci;
  insert into public.content_versions (content_item_id, version, origin, body, validation_report) values (ci, 1, 'human', '{}', '{"passed": true}') returning id into v1;
  update public.content_items set current_version_id = v1 where id = ci;
  ap := (public.submit_for_approval(ci, v1, null)).id;
  perform public.decide_approval(ap, 'approved', null, '33333333-3333-3333-3333-333333333333');
  update public.connected_accounts set status = 'active', enabled = true where id = acc;
  insert into public.schedules (workspace_id, brand_id, content_item_id, connected_account_id, publish_at, status, published_at)
  values (wsA, brandA, ci, acc, now() - interval '3 days', 'published', now() - interval '3 days') returning id into s;
  insert into ctx values ('psched', s);

  insert into public.performance_metrics (workspace_id, brand_id, content_item_id, schedule_id, channel, kind, source, metric_key, metric_date, cumulative, impressions, likes)
  values (wsA, brandA, ci, s, 'instagram', 'post', 'postiz', 'post:' || s, current_date - 1, true, 100, 5),
         (wsA, brandA, ci, s, 'instagram', 'post', 'postiz', 'post:' || s, current_date, true, 180, 9);
  begin
    insert into public.performance_metrics (workspace_id, channel, kind, metric_key, metric_date) values (wsA, 'instagram', 'post', 'post:' || s, current_date);
    raise exception 'duplicate key/day accepted';
  exception when unique_violation then null;
  end;
  select count(*) into n from public.post_performance(brandA, now() - interval '7 days', now());
  assert n = 1, 'one row per post';
  assert (select impressions from public.post_performance(brandA, now() - interval '7 days', now())) = 180, 'latest snapshot wins';
  assert (select count(*) from public.post_performance(brandA, now() - interval '1 day', now())) = 0, 'range is by publish time';

  insert into public.insights (workspace_id, brand_id, kind, title, body, fingerprint, guidance) values (wsA, brandA, 'recommendation', 'Shorter posts', 'b', 'len:instagram', 'Keep Instagram captions under 600 characters.');
  begin
    insert into public.insights (workspace_id, brand_id, kind, title, body, fingerprint) values (wsA, brandA, 'recommendation', 'dup', 'b', 'len:instagram');
    raise exception 'duplicate open insight';
  exception when unique_violation then null;
  end;
  insert into public.learning_signals (workspace_id, brand_id, content_item_id, schedule_id, signal, value) values (wsA, brandA, ci, s, 'engagement_outcome', 0.8);
  begin
    insert into public.learning_signals (workspace_id, brand_id, content_item_id, schedule_id, signal, value) values (wsA, brandA, ci, s, 'engagement_outcome', 0.9);
    raise exception 'two outcomes for one post';
  exception when unique_violation then null;
  end;
  insert into public.analytics_connections (workspace_id, brand_id, provider, base_url, account_ref) values (wsA, brandA, 'matomo', 'https://matomo.example.test', '1');
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', :'a', false);   -- owner A
do $$
declare n int;
begin
  assert (select count(*) from public.post_performance((select v from ctx where k='brandA'), now() - interval '7 days', now())) = 1, 'owner reads performance';
  assert (select count(*) from public.analytics_connections) = 1, 'owner sees analytics source';
  update public.insights set status = 'accepted' where fingerprint = 'len:instagram';
  get diagnostics n = row_count;
  assert n = 0, 'client accepted an insight directly';
  begin
    insert into public.performance_metrics (workspace_id, channel, kind, metric_key, metric_date) values ((select v from ctx where k='wsA'), 'x', 'post', 'forged', current_date);
    raise exception 'client wrote metrics';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', :'c', false);   -- not a member of A any more? (viewer C from section 4)
do $$
begin
  assert (select count(*) from public.analytics_connections where workspace_id <> (select v from ctx where k='wsA')) = 0, 'no foreign sources';
end $$;
reset role; select set_config('request.jwt.claim.sub', '', false);

-- 20. Projects & repurposing: brand-pinned projects, API-only writes, readable runs
do $$
declare wsA uuid := (select v from ctx where k='wsA'); brandA uuid := (select v from ctx where k='brandA');
        brand2 uuid; p1 uuid; p2 uuid; ci uuid; run uuid;
begin
  select id into brand2 from public.brands where workspace_id = wsA and name = 'Brand A2';
  insert into public.projects (workspace_id, brand_id, name) values (wsA, brandA, 'Diwali launch') returning id into p1;
  insert into public.projects (workspace_id, brand_id, name) values (wsA, brand2, 'Other brand project') returning id into p2;
  insert into ctx values ('proj', p1);
  begin
    insert into public.projects (workspace_id, brand_id, name) values (wsA, brandA, 'Diwali launch');
    raise exception 'duplicate project name';
  exception when unique_violation then null;
  end;
  insert into public.content_items (workspace_id, brand_id, type, project_id) values (wsA, brandA, 'document', p1) returning id into ci;
  begin
    insert into public.content_items (workspace_id, brand_id, type, project_id) values (wsA, brandA, 'document', p2);
    raise exception 'content joined another brand''s project';
  exception when foreign_key_violation then null;
  end;
  insert into public.repurpose_runs (workspace_id, brand_id, project_id, source_kind, source_item_id, source_ref, outputs)
  values (wsA, brandA, p1, 'content', ci, jsonb_build_object('kind','content','id',ci,'title','Doc'), '[]') returning id into run;
  update public.content_items set repurpose_run_id = run, source_ref = jsonb_build_object('kind','content','id',ci) where id = ci;
  delete from public.projects where id = p1;
  assert (select project_id from public.content_items where id = ci) is null, 'deleting a project keeps its content';
  insert into public.projects (id, workspace_id, brand_id, name) values (p1, wsA, brandA, 'Diwali launch');
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', :'a', false);   -- owner A
do $$
declare n int;
begin
  assert (select count(*) from public.projects where id = (select v from ctx where k='proj')) = 1, 'owner reads projects';
  assert (select count(*) from public.repurpose_runs) >= 1, 'owner reads runs';
  begin
    insert into public.projects (workspace_id, brand_id, name) values ((select v from ctx where k='wsA'), (select v from ctx where k='brandA'), 'client project');
    raise exception 'client created a project directly';
  exception when insufficient_privilege then null;
  end;
  update public.repurpose_runs set status = 'succeeded';
  get diagnostics n = row_count;
  assert n = 0, 'client changed a run';
end $$;
select set_config('request.jwt.claim.sub', :'b', false);   -- owner B
do $$
begin
  assert (select count(*) from public.projects p join public.brands b on b.id = p.brand_id where b.workspace_id = (select v from ctx where k='wsB')) = 0, 'B has no projects';
end $$;
reset role; select set_config('request.jwt.claim.sub', '', false);

-- 21. Commercial: refunds bounded by the charge, ledger stays immutable, usage counts, isolation
do $$
declare wsA uuid := (select v from ctx where k='wsA'); r public.credit_reservations; t public.credit_transactions; bal numeric; u jsonb;
begin
  perform public.grant_credits(wsA, 50, 'adjustment', 'smoke:phase10', null);
  r := public.reserve_credits(wsA, 6, 'smoke-refund-1');
  r := public.settle_reservation(r.id, 4);
  select balance into bal from public.credits where workspace_id = wsA;
  t := public.refund_credits(r.id, 3, 'bad output', null);
  assert (select balance from public.credits where workspace_id = wsA) = bal + 3, 'refund credited';
  assert t.kind = 'refund' and t.reservation_id = r.id, 'refund linked to the charge';
  begin
    perform public.refund_credits(r.id, 2, 'again', null);
    raise exception 'refunded more than was charged';
  exception when check_violation then null;
  end;
  perform public.refund_credits(r.id, 1, 'rest', null);
  assert (select refunded_amount from public.credit_reservations where id = r.id) = 4, 'fully refunded';
  begin
    update public.credit_transactions set delta = 999 where id = t.id;
    raise exception 'ledger row edited';
  exception when insufficient_privilege then null;
  end;
  r := public.reserve_credits(wsA, 1, 'smoke-refund-2');
  begin
    perform public.refund_credits(r.id, 1, 'held', null);
    raise exception 'refunded a held reservation';
  exception when check_violation then null;
  end;
  perform public.release_reservation(r.id, 'smoke');
  u := public.entitlement_usage(wsA);
  assert (u ->> 'max_brands')::int >= 2 and (u ->> 'max_seats')::int >= 1, 'usage counted';
  insert into public.credit_topups (workspace_id, pack_key, credits, amount_minor, currency, lago_invoice_id, idempotency_key) values (wsA, 'pack_200', 200, 24900, 'INR', 'lago-inv-smoke', 'k1');
  insert into public.billing_events (unique_key, webhook_type, workspace_id, payload) values ('evt-1', 'invoice.created', wsA, '{}');
  begin
    insert into public.billing_events (unique_key, webhook_type, payload) values ('evt-1', 'invoice.created', '{}');
    raise exception 'duplicate webhook stored';
  exception when unique_violation then null;
  end;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', :'a', false);   -- owner A
do $$
begin
  assert (select count(*) from public.credit_packs) = 3, 'packs readable';
  assert (select count(*) from public.credit_topups) = 1, 'owner sees own top-ups';
  begin
    perform 1 from public.billing_events limit 1;
    raise exception 'client read webhook inbox';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.refund_credits(gen_random_uuid(), 1, 'x', null);
    raise exception 'client called refund';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', :'b', false);   -- owner B (viewer in A, no billing.read there)
do $$
begin
  assert (select count(*) from public.credit_topups where workspace_id = (select v from ctx where k='wsA')) = 0, 'viewer sees no top-ups';
end $$;
reset role; select set_config('request.jwt.claim.sub', '', false);

-- 22. SEO research & ads: API-only writes, ad account guards, approvals tied to the campaign revision
do $$
declare wsA uuid := (select v from ctx where k='wsA'); wsB uuid := (select v from ctx where k='wsB'); brandA uuid := (select v from ctx where k='brandA');
        gconn uuid; mconnB uuid; camp uuid; act public.ad_actions; ci uuid; v1 uuid;
        a uuid := '11111111-1111-1111-1111-111111111111'; c uuid := '33333333-3333-3333-3333-333333333333';
begin
  insert into public.keyword_sets (workspace_id, brand_id, name, seeds, source, status) values (wsA, brandA, 'Diwali', array['diwali gifts'], 'manual', 'ready');
  insert into public.competitors (workspace_id, brand_id, name, url) values (wsA, brandA, 'Rival', 'https://rival.example.test');
  begin
    insert into public.competitors (workspace_id, brand_id, name, url) values (wsA, brandA, 'Rival again', 'https://rival.example.test');
    raise exception 'duplicate competitor url';
  exception when unique_violation then null;
  end;
  insert into public.content_items (workspace_id, brand_id, type) values (wsA, brandA, 'blog') returning id into ci;
  insert into public.content_versions (content_item_id, version, origin, body) values (ci, 1, 'human', '{}') returning id into v1;
  insert into public.seo_reports (workspace_id, brand_id, content_item_id, content_version_id, scores) values (wsB, brandA, ci, v1, '{}');
  assert (select workspace_id from public.seo_reports where content_version_id = v1) = wsA, 'seo report inherits scope';

  insert into public.analytics_connections (workspace_id, brand_id, provider, account_ref) values (wsA, brandA, 'google_ads', '1234567890') returning id into gconn;
  insert into public.analytics_connections (workspace_id, provider, account_ref) values (wsB, 'meta_ads', 'act_1') returning id into mconnB;
  insert into ctx values ('gconn', gconn);
  begin
    insert into public.ad_campaigns (workspace_id, brand_id, connection_id, platform, name, objective) values (wsA, brandA, mconnB, 'meta', 'x', 'traffic');
    raise exception 'campaign on another workspace''s ad account';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.ad_campaigns (workspace_id, brand_id, connection_id, platform, name, objective) values (wsA, brandA, gconn, 'meta', 'x', 'traffic');
    raise exception 'meta campaign on a google account';
  exception when invalid_parameter_value then null;
  end;
  insert into public.ad_campaigns (workspace_id, brand_id, connection_id, platform, name, objective, daily_budget_minor)
  values (wsA, brandA, gconn, 'google', 'Diwali search', 'website_traffic', 50000) returning id into camp;
  insert into ctx values ('camp', camp);

  -- launch request; approval rules
  insert into public.ad_actions (workspace_id, campaign_id, action, campaign_revision, summary, requested_by, payload)
  values (wsB, camp, 'launch', 0, 'Create paused', a, '{"confirm":"Diwali search"}') returning * into act;
  assert act.workspace_id = wsA, 'action inherits scope';
  begin
    insert into public.ad_actions (workspace_id, campaign_id, action, campaign_revision, summary) values (wsA, camp, 'pause', 0, 'dup');
    raise exception 'two open requests';
  exception when unique_violation then null;
  end;
  begin
    perform public.decide_ad_action(act.id, 'approved', c, 'Diwali search');
    raise exception 'approved without managing switched on';
  exception when insufficient_privilege then null;
  end;
  insert into public.ad_account_policies (connection_id, workspace_id, manage_enabled, max_daily_budget_minor) values (gconn, wsB, true, 100000);
  assert (select workspace_id from public.ad_account_policies where connection_id = gconn) = wsA, 'policy takes the account workspace';
  begin
    perform public.decide_ad_action(act.id, 'approved', a, 'Diwali search');
    raise exception 'requester approved own launch';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.decide_ad_action(act.id, 'approved', c, 'wrong');
    raise exception 'approved without typed confirmation';
  exception when invalid_parameter_value then null;
  end;
  act := public.decide_ad_action(act.id, 'approved', c, 'Diwali search');
  assert act.status = 'approved' and act.decided_by = c, 'approved by second person';

  -- an edit cancels approvals made on the old revision
  update public.ad_campaigns set revision = revision + 1, daily_budget_minor = 60000 where id = camp;
  assert (select status from public.ad_actions where id = act.id) = 'cancelled', 'edit cancels approval';
  insert into public.ad_actions (workspace_id, campaign_id, action, campaign_revision, summary, requested_by, payload)
  values (wsA, camp, 'budget_change', 1, 'Raise budget', a, '{"confirm":"5000","dailyBudgetMinor":500000}') returning * into act;
  begin
    perform public.decide_ad_action(act.id, 'approved', c, '5000');
    raise exception 'approved above the account limit';
  exception when insufficient_privilege then null;
  end;
  update public.ad_campaigns set revision = revision + 1 where id = camp;
  insert into public.ad_actions (workspace_id, campaign_id, action, campaign_revision, summary, requested_by) values (wsA, camp, 'pause', 1, 'Pause', a) returning * into act;
  begin
    perform public.decide_ad_action(act.id, 'approved', c, null);
    raise exception 'decided a stale request';
  exception when check_violation then null;
  end;
  update public.ad_actions set status = 'cancelled' where id = act.id;
  assert (select count(*) from public.audit_logs where entity_type = 'ad_actions') >= 3, 'ad actions audited';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', :'a', false);   -- owner A
do $$
declare n int;
begin
  assert (select count(*) from public.ad_campaigns) = 1, 'owner reads campaigns';
  assert (select count(*) from public.ad_actions) >= 3, 'owner reads requests';
  assert (select count(*) from public.keyword_sets) = 1 and (select count(*) from public.competitors) = 1, 'owner reads research';
  update public.ad_campaigns set daily_budget_minor = 99999999;
  get diagnostics n = row_count;
  assert n = 0, 'client changed a budget';
  begin
    insert into public.ad_actions (workspace_id, campaign_id, action, campaign_revision, summary) values ((select v from ctx where k='wsA'), (select v from ctx where k='camp'), 'activate', 2, 'x');
    raise exception 'client requested a launch directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.decide_ad_action(gen_random_uuid(), 'approved', auth.uid(), null);
    raise exception 'client called decide';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', :'b', false);   -- owner B (viewer in A: no ads.read there)
do $$
begin
  assert (select count(*) from public.ad_campaigns where workspace_id = (select v from ctx where k='wsA')) = 0, 'viewer sees no campaigns';
  assert (select count(*) from public.ad_account_policies where workspace_id = (select v from ctx where k='wsA')) = 0, 'viewer sees no ad policies';
end $$;
reset role; select set_config('request.jwt.claim.sub', '', false);

-- 23. Services & mobile: staff see only their assignments, internal notes stay internal, status machine, own notifications
insert into auth.users (id, email) values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','spec@example.test'), ('ffffffff-ffff-4fff-8fff-ffffffffffff','mgr@example.test'), ('99999999-9999-4999-8999-999999999999','spec2@example.test');
do $$
declare wsA uuid := (select v from ctx where k='wsA'); brandA uuid := (select v from ctx where k='brandA'); req uuid; req2 uuid;
        spec uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'; mgr uuid := 'ffffffff-ffff-4fff-8fff-ffffffffffff'; spec2 uuid := '99999999-9999-4999-8999-999999999999';
begin
  insert into public.service_staff (user_id, role, display_name, skills) values (spec, 'specialist', 'Spec', array['writing']), (mgr, 'manager', 'Mgr', array[]::text[]), (spec2, 'specialist', 'Other', array['writing']);
  insert into public.service_requests (workspace_id, brand_id, offering_key, title, status) values (wsA, brandA, 'expert_article', 'Tiffin guide', 'draft') returning id into req;
  insert into public.service_requests (workspace_id, brand_id, offering_key, title, status) values (wsA, brandA, 'polish_draft', 'Still a draft', 'draft') returning id into req2;
  insert into ctx values ('sreq', req);
  begin
    update public.service_requests set status = 'delivered' where id = req;
    raise exception 'skipped the workflow';
  exception when check_violation then null;
  end;
  update public.service_requests set status = 'submitted' where id = req;
  begin
    update public.service_requests set status = 'assigned' where id = req;
    raise exception 'assigned without a specialist';
  exception when invalid_parameter_value then null;
  end;
  update public.service_requests set status = 'assigned', assignee_id = spec where id = req;
  assert (select lock_version from public.service_requests where id = req) = 2, 'lock version bumps per transition';
  insert into public.service_messages (request_id, workspace_id, brand_id, author_id, author_kind, visibility, body) values (req, wsA, brandA, mgr, 'staff', 'internal', 'Customer is picky about tone');
  insert into public.service_messages (request_id, workspace_id, brand_id, author_id, author_kind, body) values (req, wsA, brandA, null, 'customer', 'Thanks!');
  begin
    insert into public.service_messages (request_id, workspace_id, brand_id, author_kind, visibility, body) values (req, wsA, brandA, 'customer', 'internal', 'sneaky');
    raise exception 'customer wrote an internal note';
  exception when check_violation then null;
  end;
  insert into public.service_deliverables (request_id, workspace_id, brand_id, round, status, doc) values (req, '00000000-0000-0000-0000-000000000000', brandA, 1, 'draft', '{}');
  assert (select workspace_id from public.service_deliverables where request_id = req) = wsA, 'deliverable inherits scope';
  declare h public.credit_reservations; e timestamptz;
  begin
    h := public.reserve_credits(wsA, 1, 'smoke-service-hold', null, 'service.expert_article', interval '1 day');
    e := (public.extend_reservation(h.id, now() + interval '30 days')).expires_at;
    assert e > now() + interval '29 days', 'hold extended';
    assert (public.extend_reservation(h.id, now() + interval '2 days')).expires_at = e, 'extension never shortens a hold';
    perform public.release_reservation(h.id, 'smoke');
    begin
      perform public.extend_reservation(h.id, now() + interval '30 days');
      raise exception 'extended a released hold';
    exception when check_violation then null;
    end;
  end;
  insert into public.notifications (user_id, workspace_id, kind, title, dedupe_key) values ('11111111-1111-1111-1111-111111111111', wsA, 'service.delivered', 'Delivered', 'k1'), (spec, null, 'service.assigned', 'Assigned', null);
  begin
    insert into public.notifications (user_id, kind, title, dedupe_key) values ('11111111-1111-1111-1111-111111111111', 'service.delivered', 'again', 'k1');
    raise exception 'duplicate notification';
  exception when unique_violation then null;
  end;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', :'a', false);   -- owner A (customer)
do $$
declare n int;
begin
  assert (select count(*) from public.service_requests) = 2, 'customer sees own requests incl. drafts';
  assert (select count(*) from public.service_messages) = 1, 'customer does not see internal notes';
  assert (select count(*) from public.service_deliverables) = 0, 'customer does not see work in progress';
  assert (select count(*) from public.notifications) = 1, 'own notifications only';
  assert (select count(*) from public.service_staff) = 0, 'customers do not see the staff list';
  update public.service_requests set status = 'cancelled';
  get diagnostics n = row_count;
  assert n = 0, 'client changed a request directly';
  begin
    perform public.extend_reservation(gen_random_uuid(), now());
    raise exception 'client extended a hold';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', false);   -- assigned specialist (not a workspace member)
do $$
begin
  assert (select count(*) from public.service_requests) = 1, 'specialist sees only the assigned request';
  assert (select count(*) from public.service_messages) = 2, 'specialist sees internal notes on their request';
  assert (select count(*) from public.service_deliverables) = 1, 'specialist sees their work';
  assert (select count(*) from public.brands) = 0, 'specialist gets no workspace access';
  assert (select count(*) from public.content_items) = 0, 'specialist sees no content library';
  assert (select count(*) from public.notifications) = 1, 'specialist notification';
end $$;
select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false);   -- another specialist
do $$
begin
  assert (select count(*) from public.service_requests) = 0, 'unassigned specialist sees nothing';
  assert (select count(*) from public.service_messages) = 0, 'no messages either';
end $$;
select set_config('request.jwt.claim.sub', 'ffffffff-ffff-4fff-8fff-ffffffffffff', false);   -- manager
do $$
begin
  assert (select count(*) from public.service_requests) = 1, 'manager sees submitted work, not customer drafts';
  assert (select count(*) from public.service_staff) = 3, 'manager sees the team';
end $$;
select set_config('request.jwt.claim.sub', :'b', false);   -- owner B
do $$
begin
  assert (select count(*) from public.service_requests where workspace_id = (select v from ctx where k='wsA')) = 2, 'a viewer in A reads A requests (content.read)';
  assert (select count(*) from public.service_messages) = 1, 'viewer sees no internal notes';
  assert (select count(*) from public.service_requests r join public.brands b on b.id = r.brand_id where b.workspace_id = (select v from ctx where k='wsB')) = 0, 'B has none';
end $$;
reset role; select set_config('request.jwt.claim.sub', '', false);

-- 24. Phase 12 hardening: no client writes to service state, no self-promotion, ops view and devices private, audit trail with real actors
do $$
declare req uuid := (select v from ctx where k='sreq'); wsA uuid := (select v from ctx where k='wsA'); brandA uuid := (select v from ctx where k='brandA');
begin
  insert into public.service_events (request_id, workspace_id, brand_id, from_status, to_status, kind, actor_id, actor_kind)
  values (req, wsA, brandA, 'assigned', 'in_progress', 'status', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'staff');
  insert into public.service_events (request_id, workspace_id, brand_id, kind, actor_id, actor_kind, note, visibility)
  values (req, wsA, brandA, 'assigned', 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'staff', 'Spec', 'internal');
  assert exists (select 1 from public.audit_logs where action = 'service.status:in_progress' and entity_id = req::text and actor_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' and actor_type = 'user'), 'service event audited with its actor';
  insert into public.user_devices (user_id, kind, endpoint, keys) values ('11111111-1111-1111-1111-111111111111', 'webpush', 'https://push.example.test/a', '{"p256dh":"k","auth":"a"}'),
                                                                        ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'webpush', 'https://push.example.test/s', '{"p256dh":"k","auth":"a"}');
  assert (select count(*) from public.service_ops) >= 1, 'ops view works for the service role';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', :'a', false);   -- customer (owner A)
do $$
declare n int; req uuid := (select v from ctx where k='sreq');
begin
  update public.service_requests set status = 'approved', assignee_id = auth.uid() where id = req;
  get diagnostics n = row_count; assert n = 0, 'customer approved / assigned directly';
  update public.service_deliverables set status = 'delivered';
  get diagnostics n = row_count; assert n = 0, 'customer changed a deliverable';
  update public.notifications set body = 'x';
  get diagnostics n = row_count; assert n = 0, 'customer edited a notification';
  begin insert into public.service_messages (request_id, workspace_id, brand_id, author_kind, body) values (req, (select v from ctx where k='wsA'), (select v from ctx where k='brandA'), 'staff', 'fake staff message'); raise exception 'customer posted as staff'; exception when insufficient_privilege then null; end;
  begin insert into public.service_events (request_id, workspace_id, brand_id, kind, actor_kind) values (req, (select v from ctx where k='wsA'), (select v from ctx where k='brandA'), 'charge', 'system'); raise exception 'customer forged a timeline event'; exception when insufficient_privilege then null; end;
  begin insert into public.service_staff (user_id, role, display_name) values (auth.uid(), 'manager', 'me'); raise exception 'customer made themselves staff'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.service_ops; raise exception 'customer read ops view'; exception when insufficient_privilege then null; end;
  assert (select count(*) from public.user_devices) = 1, 'own devices only';
  begin perform reservation_id from public.service_requests limit 1; raise exception 'customer read hold ids'; exception when insufficient_privilege then null; end;
  begin perform assignee_id from public.service_requests limit 1; raise exception 'customer read the assignee'; exception when insufficient_privilege then null; end;
  begin perform qa_note from public.service_deliverables limit 1; raise exception 'customer read QA notes'; exception when insufficient_privilege then null; end;
  assert (select count(*) from public.service_requests where id = req) = 1, 'customer still reads the safe columns';
  assert (select count(*) from public.service_events where visibility = 'internal') = 0, 'customer sees no internal timeline entries';
end $$;
select set_config('request.jwt.claim.sub', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', false);   -- specialist
do $$
declare n int;
begin
  update public.service_staff set role = 'manager' where user_id = auth.uid();
  get diagnostics n = row_count; assert n = 0, 'specialist promoted themselves';
  update public.service_requests set status = 'delivered';
  get diagnostics n = row_count; assert n = 0, 'specialist changed status directly';
  begin perform 1 from public.service_ops; raise exception 'specialist read ops view'; exception when insufficient_privilege then null; end;
  assert (select count(*) from public.user_devices) = 1, 'specialist sees own device only';
  assert (select count(*) from public.audit_logs) = 0, 'specialist cannot read workspace audit logs';
  assert (select count(*) from public.credit_reservations) = 0, 'specialist cannot see credit holds';
  assert (select count(*) from public.service_events where visibility = 'internal') >= 1, 'assigned specialist sees internal timeline';
  assert (select count(*) from public.workspace_members) = 0, 'specialist cannot see members';
end $$;
reset role; select set_config('request.jwt.claim.sub', '', false);

select 'RLS SMOKE: ALL PASSED' as result;
