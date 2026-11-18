-- Arcatic Marketing OS — 0018 Phase 12 hardening: delivery tracking, audit trail, ops view

-- Notification delivery outcomes (push / email), and who the notice was written for
alter table public.notifications
  add column audience text not null default 'customer' check (audience in ('customer','staff')),
  add column delivery jsonb not null default '{}'::jsonb;

-- Ops: one row per open (or awaiting-approval) request with SLA state and its credit holds.
-- Service-role only: the API exposes it to service managers and the admin token.
create or replace view public.service_ops with (security_invoker = true) as
select r.id, r.workspace_id, r.brand_id, b.name as brand_name, r.offering_key, r.title, r.status, r.assignee_id, s.display_name as assignee_name,
       r.submitted_at, r.due_at, r.delivered_at, r.revisions_used,
       case
         when r.status = 'delivered' then 'awaiting_customer'
         when r.due_at is null then 'no_due_date'
         when r.due_at < now() then 'overdue'
         when r.due_at < now() + interval '24 hours' then 'due_soon'
         else 'on_track'
       end as sla,
       coalesce((select sum(cr.amount) from public.credit_reservations cr where cr.status = 'held' and (cr.id = r.reservation_id or cr.id = any(r.extra_reservation_ids))), 0) as credits_held,
       (select min(cr.expires_at) from public.credit_reservations cr where cr.status = 'held' and (cr.id = r.reservation_id or cr.id = any(r.extra_reservation_ids))) as hold_expires_at,
       (select count(*) from public.credit_reservations cr where cr.status <> 'held' and cr.status <> 'settled' and (cr.id = r.reservation_id or cr.id = any(r.extra_reservation_ids))) as holds_lost
  from public.service_requests r
  join public.brands b on b.id = r.brand_id
  left join public.service_staff s on s.user_id = r.assignee_id
 where r.status in ('submitted','assigned','in_progress','in_review','revision_requested','delivered');
revoke all on public.service_ops from public, anon, authenticated;
grant select on public.service_ops to service_role;

-- Audit: every service event (status change, assignment, charge, release, hold upkeep, files)
-- is mirrored into audit_logs with the person who caused it. The API writes service_events for
-- each step; the old row trigger (which only saw the service role) is replaced.
drop trigger if exists audit_service_requests on public.service_requests;
create or replace function app.audit_service_event() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_logs (workspace_id, actor_id, actor_type, action, entity_type, entity_id, before, after)
  values (new.workspace_id, new.actor_id, case when new.actor_kind = 'system' or new.actor_id is null then 'system' else 'user' end,
          'service.' || new.kind || coalesce(':' || new.to_status, ''), 'service_requests', new.request_id::text,
          case when new.from_status is not null then jsonb_build_object('status', new.from_status) end,
          jsonb_strip_nulls(jsonb_build_object('status', new.to_status, 'note', new.note, 'actor_kind', new.actor_kind)));
  return new;
end $$;
create trigger service_events_audit after insert on public.service_events for each row execute function app.audit_service_event();

-- ---------------------------------------------------------------------------
-- Staff-only data stays staff-only even through direct (REST / realtime) reads.
-- RLS decides which ROWS a customer sees; column grants decide which COLUMNS.
-- Staff work through the API (service role), so they lose nothing here.
-- ---------------------------------------------------------------------------
-- policies must not read hidden columns as the caller: assignment is checked by a definer helper
create or replace function app.is_service_assignee(p_request uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.service_requests r where r.id = p_request and r.assignee_id = (select auth.uid()))
     and app.service_staff_role() is not null;
$$;
drop policy service_deliverables_read on public.service_deliverables;
create policy service_deliverables_read on public.service_deliverables for select to authenticated using (
  (status in ('delivered','accepted','superseded') and app.brand_perm(workspace_id, brand_id, 'content.read'))
  or app.is_service_assignee(request_id) or app.service_staff_role() = 'manager');
drop policy service_messages_read on public.service_messages;
create policy service_messages_read on public.service_messages for select to authenticated using (
  (visibility = 'all' and app.brand_perm(workspace_id, brand_id, 'content.read'))
  or app.is_service_assignee(request_id) or app.service_staff_role() = 'manager');
drop policy service_requests_read on public.service_requests;
create policy service_requests_read on public.service_requests for select to authenticated using (
  app.brand_perm(workspace_id, brand_id, 'content.read')
  or app.is_service_assignee(id)
  or (app.service_staff_role() = 'manager' and status <> 'draft'));

revoke select on public.service_requests from authenticated;
grant select (id, workspace_id, brand_id, offering_key, title, status, intake, brief, source_content_item_id, source_version_id, reference_asset_ids,
              credits, revisions_included, revisions_used, due_at, submitted_at, assigned_at, delivered_at, approved_at, cancelled_at,
              result_content_item_id, result_version_id, result_asset_ids, rating, feedback, lock_version, created_by, created_at, updated_at)
  on public.service_requests to authenticated;          -- not: reservation_id, extra_reservation_ids, assignee_id, qa_by

revoke select on public.service_deliverables from authenticated;
grant select (id, request_id, workspace_id, brand_id, round, doc, files, note, status, created_at, updated_at)
  on public.service_deliverables to authenticated;      -- not: qa_note, created_by

-- Timeline entries the customer should not see (QA steps, who was assigned, hold upkeep, files in progress)
alter table public.service_events add column visibility text not null default 'all' check (visibility in ('all','internal'));
drop policy service_events_read on public.service_events;
create policy service_events_read on public.service_events for select to authenticated using (
  (visibility = 'all' and app.brand_perm(workspace_id, brand_id, 'content.read'))
  or app.is_service_assignee(request_id) or app.service_staff_role() = 'manager');
