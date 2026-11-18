-- Arcatic Marketing OS — 0006 Role catalogue, RLS policies, bootstrap RPCs, storage
-- Keep the role/permission catalogue in sync with packages/core/src/rbac.ts
-- (a unit test compares the two).

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
insert into public.roles (key, rank, description) values
  ('owner',       100, 'Full control including billing and workspace deletion'),
  ('admin',        80, 'Manage members, channels, brands and content'),
  ('editor',       60, 'Create, edit, approve and publish content'),
  ('contributor',  40, 'Create and edit drafts; cannot approve or publish'),
  ('reviewer',     30, 'Read and approve/reject content (e.g. client reviewer)'),
  ('viewer',       10, 'Read-only');

insert into public.permissions (key, description)
select k, k from unnest(array[
  'workspace.read','workspace.update','workspace.delete',
  'member.read','member.invite','member.update','member.remove',
  'brand.read','brand.create','brand.update','brand.delete',
  'knowledge.read','knowledge.create','knowledge.update','knowledge.delete',
  'media.read','media.create','media.update','media.delete',
  'campaign.read','campaign.create','campaign.update','campaign.delete',
  'content.read','content.create','content.update','content.delete',
  'approval.read','approval.decide',
  'publish.read','publish.execute',
  'channel.read','channel.manage',
  'analytics.read',
  'billing.read','billing.manage',
  'apikey.manage',
  'audit.read',
  'job.read','job.cancel'
]) as k;

-- owner: everything
insert into public.role_permissions (role, permission)
select 'owner', key from public.permissions;

-- admin: everything except deleting the workspace and managing billing
insert into public.role_permissions (role, permission)
select 'admin', key from public.permissions
where key not in ('workspace.delete','billing.manage');

-- editor
insert into public.role_permissions (role, permission)
select 'editor', key from public.permissions
where key in (
  'workspace.read','member.read',
  'brand.read','brand.create','brand.update',
  'knowledge.read','knowledge.create','knowledge.update','knowledge.delete',
  'media.read','media.create','media.update','media.delete',
  'campaign.read','campaign.create','campaign.update','campaign.delete',
  'content.read','content.create','content.update','content.delete',
  'approval.read','approval.decide','publish.read','publish.execute',
  'channel.read','analytics.read','billing.read','job.read','job.cancel');

-- contributor
insert into public.role_permissions (role, permission)
select 'contributor', key from public.permissions
where key in (
  'workspace.read','member.read','brand.read',
  'knowledge.read','knowledge.create','knowledge.update',
  'media.read','media.create','media.update',
  'campaign.read','content.read','content.create','content.update',
  'approval.read','publish.read','channel.read','analytics.read','job.read','job.cancel');

-- reviewer
insert into public.role_permissions (role, permission)
select 'reviewer', key from public.permissions
where key in (
  'workspace.read','member.read','brand.read','knowledge.read','media.read',
  'campaign.read','content.read','approval.read','approval.decide',
  'publish.read','analytics.read','job.read');

-- viewer
insert into public.role_permissions (role, permission)
select 'viewer', key from public.permissions
where key in (
  'workspace.read','member.read','brand.read','knowledge.read','media.read',
  'campaign.read','content.read','approval.read','publish.read',
  'channel.read','analytics.read','job.read');

insert into public.plans (key, name, monthly_credits, price_minor, currency, limits, lago_plan_code) values
  ('trial',      'Trial',      100,  0,       'INR', '{"max_brands":1,"max_seats":2,"max_connected_accounts":3,"video":false}', null),
  ('starter',    'Starter',    300,  149900,  'INR', '{"max_brands":1,"max_seats":2,"max_connected_accounts":5,"video":false}', 'arcatic_starter'),
  ('growth',     'Growth',     1500, 499900,  'INR', '{"max_brands":3,"max_seats":5,"max_connected_accounts":15,"video":true}', 'arcatic_growth'),
  ('agency',     'Agency',     6000, 1499900, 'INR', '{"max_brands":15,"max_seats":20,"max_connected_accounts":75,"video":true,"client_reviewers":true}', 'arcatic_agency'),
  ('enterprise', 'Enterprise', 0,    null,    'INR', '{}', 'arcatic_enterprise');
update public.plans set is_public = false where key in ('trial','enterprise');

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere in public
-- ---------------------------------------------------------------------------
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Special-case policies
-- ---------------------------------------------------------------------------
-- catalogue tables: readable by any signed-in user
create policy catalogue_read on public.roles for select to authenticated using (true);
create policy catalogue_read on public.permissions for select to authenticated using (true);
create policy catalogue_read on public.role_permissions for select to authenticated using (true);
create policy plans_read on public.plans for select to authenticated using (is_public or key = 'trial');

-- users: yourself, plus people you share a workspace with
create policy users_select on public.users for select to authenticated using (
  id = (select auth.uid())
  or exists (
    select 1 from public.workspace_members me
    join public.workspace_members them on them.workspace_id = me.workspace_id
    where me.user_id = (select auth.uid()) and them.user_id = users.id
  )
);
create policy users_update_self on public.users for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy organizations_select on public.organizations for select to authenticated using (
  exists (select 1 from public.workspaces w
          where w.organization_id = organizations.id and app.is_workspace_member(w.id))
);

create policy workspaces_select on public.workspaces for select to authenticated
  using (app.is_workspace_member(id));
create policy workspaces_update on public.workspaces for update to authenticated
  using (app.has_permission(id, 'workspace.update'))
  with check (app.has_permission(id, 'workspace.update'));

create policy members_select on public.workspace_members for select to authenticated
  using (app.is_workspace_member(workspace_id));
create policy members_update on public.workspace_members for update to authenticated
  using (app.has_permission(workspace_id, 'member.update'))
  with check (app.has_permission(workspace_id, 'member.update'));
create policy members_delete on public.workspace_members for delete to authenticated
  using (app.has_permission(workspace_id, 'member.remove') or user_id = (select auth.uid()));

create policy brand_members_select on public.brand_members for select to authenticated
  using (app.has_permission(workspace_id, 'member.read'));
create policy brand_members_write on public.brand_members for all to authenticated
  using (app.has_permission(workspace_id, 'member.update'))
  with check (app.has_permission(workspace_id, 'member.update'));

create policy brands_select on public.brands for select to authenticated
  using (deleted_at is null and app.brand_perm(workspace_id, id, 'brand.read'));
create policy brands_insert on public.brands for insert to authenticated
  with check (app.has_permission(workspace_id, 'brand.create'));
create policy brands_update on public.brands for update to authenticated
  using (app.brand_perm(workspace_id, id, 'brand.update'))
  with check (app.brand_perm(workspace_id, id, 'brand.update'));

-- invites & API keys: users read metadata only; secrets are hidden by column grants;
-- creation/revocation goes through apps/api (service role) so secrets never touch the client.
create policy invites_select on public.workspace_invites for select to authenticated
  using (app.has_permission(workspace_id, 'member.invite'));
create policy api_keys_select on public.api_keys for select to authenticated
  using (app.has_permission(workspace_id, 'apikey.manage'));
revoke select on public.api_keys from authenticated, anon;
grant select (id, workspace_id, name, prefix, scopes, role, created_by, last_used_at, expires_at, revoked_at, created_at)
  on public.api_keys to authenticated;
revoke select on public.workspace_invites from authenticated, anon;
grant select (id, workspace_id, email, role, brand_ids, invited_by, expires_at, accepted_at, revoked_at, created_at)
  on public.workspace_invites to authenticated;

create policy audit_select on public.audit_logs for select to authenticated
  using (workspace_id is not null and app.has_permission(workspace_id, 'audit.read'));

-- content_versions: insert new versions, never update/delete from the client
create policy versions_select on public.content_versions for select to authenticated
  using (app.can(workspace_id, brand_id, 'content.read'));
create policy versions_insert on public.content_versions for insert to authenticated
  with check (origin in ('human','import') and app.can(workspace_id, brand_id, 'content.update'));
create policy versions_feedback on public.content_versions for update to authenticated
  using (app.can(workspace_id, brand_id, 'content.read'))
  with check (app.can(workspace_id, brand_id, 'content.read'));

-- approvals: anyone who can edit may request; deciding needs approval.decide
create policy approvals_select on public.approvals for select to authenticated
  using (app.can(workspace_id, brand_id, 'approval.read'));
create policy approvals_insert on public.approvals for insert to authenticated
  with check (app.can(workspace_id, brand_id, 'content.update') and status = 'pending');
create policy approvals_decide on public.approvals for update to authenticated
  using (app.can(workspace_id, brand_id, 'approval.decide'))
  with check (app.can(workspace_id, brand_id, 'approval.decide'));

create policy insights_select on public.insights for select to authenticated
  using (app.can(workspace_id, brand_id, 'analytics.read'));
create policy insights_decide on public.insights for update to authenticated
  using (app.can(workspace_id, brand_id, 'brand.update'))
  with check (app.can(workspace_id, brand_id, 'brand.update'));

-- ---------------------------------------------------------------------------
-- Generic policies
--   mode 'crud'  : select <res>.read, insert <res>.create, update <res>.update, delete <res>.delete
--   mode 'read'  : select only (rows are written by apps/api / apps/worker with the service role)
--   brand-aware  : table has a brand_id column → app.can(workspace_id, brand_id, perm)
-- ---------------------------------------------------------------------------
do $$
declare
  spec record;
  pred text;
begin
  for spec in
    select * from (values
      ('connected_accounts',  'channel',   'read', true),
      ('media_assets',        'media',     'crud', true),
      ('sources',             'knowledge', 'crud', true),
      ('knowledge_chunks',    'knowledge', 'read', true),
      ('embeddings',          'knowledge', 'read', true),
      ('campaigns',           'campaign',  'crud', true),
      ('campaign_topics',     'campaign',  'crud', true),
      ('content_items',       'content',   'crud', true),
      ('schedules',           'publish',   'read', true),
      ('generation_jobs',     'job',       'read', true),
      ('publishing_jobs',     'publish',   'read', true),
      ('analytics_events',    'analytics', 'read', true),
      ('performance_metrics', 'analytics', 'read', true),
      ('learning_signals',    'analytics', 'read', true),
      ('job_events',          'job',       'read', false),
      ('credits',             'billing',   'read', false),
      ('credit_reservations', 'billing',   'read', false),
      ('credit_transactions', 'billing',   'read', false),
      ('usage_events',        'billing',   'read', false),
      ('subscriptions',       'billing',   'read', false),
      ('invoices',            'billing',   'read', false)
    ) as v(tbl, res, mode, brand_aware)
  loop
    pred := case when spec.brand_aware
                 then 'app.can(workspace_id, brand_id, %L)'
                 else 'app.has_permission(workspace_id, %L)' end;

    execute format('create policy %I on public.%I for select to authenticated using (' || pred || ')',
                   spec.tbl || '_select', spec.tbl, spec.res || '.read');

    if spec.mode = 'crud' then
      execute format('create policy %I on public.%I for insert to authenticated with check (' || pred || ')',
                     spec.tbl || '_insert', spec.tbl, spec.res || '.create');
      execute format('create policy %I on public.%I for update to authenticated using (' || pred || ') with check (' || pred || ')',
                     spec.tbl || '_update', spec.tbl, spec.res || '.update', spec.res || '.update');
      execute format('create policy %I on public.%I for delete to authenticated using (' || pred || ')',
                     spec.tbl || '_delete', spec.tbl, spec.res || '.delete');
    end if;
  end loop;
end $$;

-- schedules are created by editors (publish.execute) but executed by the worker
create policy schedules_write on public.schedules for all to authenticated
  using (app.can(workspace_id, brand_id, 'publish.execute'))
  with check (app.can(workspace_id, brand_id, 'publish.execute'));

-- idempotency_keys: RLS enabled, no policies → service role only.

-- ---------------------------------------------------------------------------
-- Bootstrap RPCs (callable with the user's JWT)
-- ---------------------------------------------------------------------------
create or replace function public.create_organization(
  p_org_name text,
  p_workspace_name text,
  p_workspace_slug text,
  p_country text default 'IN',
  p_currency text default 'INR'
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  org_id uuid;
  ws_id uuid;
begin
  if uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  -- the auth trigger normally creates this row; guard for users created before it existed
  insert into public.users (id, email)
  select uid, coalesce((select email from auth.users where id = uid), '')
  on conflict (id) do nothing;

  insert into public.organizations (name, country, created_by)
  values (p_org_name, p_country, uid) returning id into org_id;

  insert into public.workspaces (organization_id, name, slug, currency)
  values (org_id, p_workspace_name, lower(p_workspace_slug), p_currency) returning id into ws_id;

  perform set_config('app.trusted_membership_write', 'on', true);
  insert into public.workspace_members (workspace_id, user_id, role) values (ws_id, uid, 'owner');
  perform set_config('app.trusted_membership_write', 'off', true);

  insert into public.subscriptions (workspace_id, plan_key, status) values (ws_id, 'trial', 'trialing');
  perform public.grant_credits(ws_id, 100, 'grant', 'trial:' || ws_id::text, uid);
  return ws_id;
end $$;

create or replace function public.accept_invite(p_token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  inv public.workspace_invites;
  user_email text;
  b uuid;
begin
  if uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  select * into inv from public.workspace_invites
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
   for update;
  if not found or inv.accepted_at is not null or inv.revoked_at is not null or inv.expires_at < now() then
    raise exception 'not_found: invite is invalid or expired' using errcode = 'P0002';
  end if;
  select email into user_email from auth.users where id = uid;
  if lower(user_email) <> lower(inv.email::text) then
    raise exception 'forbidden: invite was sent to a different email' using errcode = '42501';
  end if;

  perform set_config('app.trusted_membership_write', 'on', true);
  insert into public.workspace_members (workspace_id, user_id, role, invited_by, brand_restricted)
  values (inv.workspace_id, uid, inv.role, inv.invited_by, coalesce(array_length(inv.brand_ids, 1), 0) > 0)
  on conflict (workspace_id, user_id) do nothing;
  perform set_config('app.trusted_membership_write', 'off', true);

  if inv.brand_ids is not null then
    foreach b in array inv.brand_ids loop
      insert into public.brand_members (brand_id, workspace_id, user_id)
      values (b, inv.workspace_id, uid) on conflict do nothing;
    end loop;
  end if;

  update public.workspace_invites set accepted_at = now() where id = inv.id;
  return inv.workspace_id;
end $$;

revoke all on function public.create_organization(text, text, text, text, text) from public, anon;
revoke all on function public.accept_invite(text) from public, anon;
grant execute on function public.create_organization(text, text, text, text, text) to authenticated;
grant execute on function public.accept_invite(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private bucket, first path segment = workspace_id
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('media', 'media', false, 524288000)
    on conflict (id) do nothing;

    execute $p$
      create policy media_read on storage.objects for select to authenticated using (
        bucket_id = 'media' and app.has_permission(((storage.foldername(name))[1])::uuid, 'media.read'))
    $p$;
    execute $p$
      create policy media_insert on storage.objects for insert to authenticated with check (
        bucket_id = 'media' and app.has_permission(((storage.foldername(name))[1])::uuid, 'media.create'))
    $p$;
    execute $p$
      create policy media_update on storage.objects for update to authenticated using (
        bucket_id = 'media' and app.has_permission(((storage.foldername(name))[1])::uuid, 'media.update'))
    $p$;
    execute $p$
      create policy media_delete on storage.objects for delete to authenticated using (
        bucket_id = 'media' and app.has_permission(((storage.foldername(name))[1])::uuid, 'media.delete'))
    $p$;
  end if;
end $$;

-- Realtime: job progress stream
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.job_events, public.generation_jobs;
  end if;
end $$;
