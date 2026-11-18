-- Arcatic Marketing OS — 0017 Human-finished services + mobile (Phase 12)
--
-- Services: a customer requests human work (polish a draft, expert article, design finish…),
-- Arcatic's service team (managers + specialists, who are NOT workspace members) briefs,
-- assigns, reviews and delivers; the customer approves or asks for a revision; credits held
-- at submission are charged only on approval.
-- Mobile: in-app notifications (feed for the PWA / future native app) and device registrations.

-- ---------------------------------------------------------------------------
-- Catalogue (prices are placeholders, in credits)
-- ---------------------------------------------------------------------------
create table public.service_offerings (
  key                   text primary key,
  name                  text not null,
  description           text not null,
  category              text not null check (category in ('writing','design','video','ads','strategy')),
  credits               numeric(12,3) not null check (credits > 0),
  turnaround_hours      int not null check (turnaround_hours between 4 and 720),
  included_revisions    int not null default 1 check (included_revisions between 0 and 5),
  extra_revision_credits numeric(12,3) not null default 0 check (extra_revision_credits >= 0),
  deliverable_type      text,               -- content type the work lands as (null = files only)
  deliverable_kind      text not null check (deliverable_kind in ('content','files','content_and_files')),
  needs_source_content  boolean not null default false,   -- "finish my draft" style
  qa_required           boolean not null default true,
  intake_fields         jsonb not null default '[]'::jsonb,
  active                boolean not null default true,
  sort                  int not null default 100
);
alter table public.service_offerings enable row level security;
create policy service_offerings_read on public.service_offerings for select to authenticated using (active);
grant select on public.service_offerings to authenticated;
grant all on public.service_offerings to service_role;

insert into public.service_offerings (key, name, description, category, credits, turnaround_hours, included_revisions, extra_revision_credits, deliverable_type, deliverable_kind, needs_source_content, qa_required, intake_fields, sort) values
('polish_draft', 'Human polish', 'An editor tightens an AI or team draft: voice, flow, grammar, and a fact check against your sources.', 'writing', 25, 48, 1, 5, null, 'content', true, true,
  '[{"key":"focus","label":"What should the editor focus on?","type":"textarea","required":false,"max":1000},{"key":"tone","label":"Tone notes","type":"text","required":false,"max":200}]', 10),
('expert_article', 'Expert-written article', 'A specialist researches and writes a long-form article (about 1,200 words) for your blog or website.', 'writing', 120, 120, 2, 20, 'blog', 'content', false, true,
  '[{"key":"topic","label":"Topic or working title","type":"text","required":true,"max":200},{"key":"keyword","label":"Target keyword","type":"text","required":false,"max":120},{"key":"audience","label":"Who is it for?","type":"text","required":false,"max":300},{"key":"points","label":"Points it must make","type":"textarea","required":false,"max":2000},{"key":"references","label":"Links or sources to use","type":"textarea","required":false,"max":2000}]', 20),
('caption_pack', 'Caption pack', 'Ten channel-ready captions written by a copywriter for the posts or theme you describe.', 'writing', 60, 72, 1, 10, 'document', 'content', false, true,
  '[{"key":"theme","label":"Theme or campaign","type":"text","required":true,"max":200},{"key":"channels","label":"Channels","type":"text","required":true,"max":200},{"key":"notes","label":"Anything to include or avoid","type":"textarea","required":false,"max":1500}]', 30),
('visual_finish', 'Design finish', 'A designer finishes a visual or carousel from your brand kit and delivers export-ready files.', 'design', 40, 48, 2, 8, null, 'files', false, true,
  '[{"key":"what","label":"What should be designed?","type":"textarea","required":true,"max":1500},{"key":"sizes","label":"Sizes / formats","type":"text","required":false,"max":200}]', 40),
('short_video_edit', 'Short video edit', 'An editor cuts a 15–60 second vertical video from footage you provide, with captions and your brand style.', 'video', 150, 120, 1, 30, null, 'files', false, true,
  '[{"key":"story","label":"What should the video show?","type":"textarea","required":true,"max":1500},{"key":"length","label":"Length","type":"select","options":["15s","30s","45s","60s"],"required":true}]', 50),
('ad_review', 'Ad copy & compliance review', 'A paid-media specialist reviews ad copy and targeting against platform policies before you launch.', 'ads', 30, 24, 1, 6, 'document', 'content', false, false,
  '[{"key":"campaign","label":"Campaign or ad to review","type":"text","required":true,"max":300},{"key":"concerns","label":"Concerns","type":"textarea","required":false,"max":1500}]', 60);

-- ---------------------------------------------------------------------------
-- Service team (Arcatic staff or contracted specialists; managed via the admin API)
-- ---------------------------------------------------------------------------
create table public.service_staff (
  user_id      uuid primary key references public.users(id) on delete cascade,
  role         text not null check (role in ('manager','specialist')),
  display_name text not null,
  skills       text[] not null default array[]::text[],   -- offering categories
  active       boolean not null default true,
  max_active   int not null default 5 check (max_active between 1 and 50),
  created_at   timestamptz not null default now()
);

create or replace function app.service_staff_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.service_staff where user_id = (select auth.uid()) and active;
$$;

-- ---------------------------------------------------------------------------
-- Requests, deliverables, messages, timeline
-- ---------------------------------------------------------------------------
create table public.service_requests (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null,
  brand_id               uuid not null,
  offering_key           text not null references public.service_offerings(key),
  title                  text not null check (length(title) between 1 and 200),
  status                 text not null default 'draft' check (status in ('draft','submitted','assigned','in_progress','in_review','delivered','revision_requested','approved','cancelled')),
  intake                 jsonb not null default '{}'::jsonb,
  brief                  jsonb,                    -- assembled at submission: intake + brand snapshot + acceptance criteria
  source_content_item_id uuid references public.content_items(id) on delete set null,
  source_version_id      uuid references public.content_versions(id) on delete set null,
  reference_asset_ids    uuid[] not null default array[]::uuid[],
  credits                numeric(12,3),            -- price fixed at submission
  reservation_id         uuid references public.credit_reservations(id),
  extra_reservation_ids  uuid[] not null default array[]::uuid[],
  revisions_included     int not null default 0,
  revisions_used         int not null default 0,
  assignee_id            uuid references public.users(id) on delete set null,
  qa_by                  uuid references public.users(id) on delete set null,
  due_at                 timestamptz,
  submitted_at           timestamptz,
  assigned_at            timestamptz,
  delivered_at           timestamptz,
  approved_at            timestamptz,
  cancelled_at           timestamptz,
  result_content_item_id uuid references public.content_items(id) on delete set null,
  result_version_id      uuid references public.content_versions(id) on delete set null,
  result_asset_ids       uuid[] not null default array[]::uuid[],
  rating                 int check (rating between 1 and 5),
  feedback               text,
  lock_version           int not null default 0,
  created_by             uuid references public.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create index on public.service_requests (workspace_id, brand_id, updated_at desc);
create index on public.service_requests (status, due_at) where status in ('submitted','assigned','in_progress','in_review','revision_requested');
create index on public.service_requests (assignee_id) where assignee_id is not null;
create trigger service_requests_touch before update on public.service_requests for each row execute function app.touch_updated_at();

-- status machine (mirrors packages/core/src/services/lifecycle.ts)
create or replace function app.guard_service_status() returns trigger
language plpgsql set search_path = '' as $$
declare ok boolean;
begin
  if new.status = old.status then return new; end if;
  ok := case old.status
    when 'draft'              then new.status in ('submitted','cancelled')
    when 'submitted'          then new.status in ('assigned','cancelled')
    when 'assigned'           then new.status in ('in_progress','submitted','cancelled')
    when 'in_progress'        then new.status in ('in_review','delivered','assigned')
    when 'in_review'          then new.status in ('delivered','in_progress')
    when 'delivered'          then new.status in ('approved','revision_requested')
    when 'revision_requested' then new.status in ('in_progress','assigned')
    else false end;
  if not ok then
    raise exception 'conflict: a % request can''t move to %', old.status, new.status using errcode = '23514';
  end if;
  if new.status in ('assigned','in_progress') and new.assignee_id is null then
    raise exception 'validation_failed: assign a specialist first' using errcode = '22023';
  end if;
  new.lock_version := old.lock_version + 1;
  return new;
end $$;
create trigger service_requests_status before update of status on public.service_requests for each row execute function app.guard_service_status();

create table public.service_deliverables (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.service_requests(id) on delete cascade,
  workspace_id uuid not null,
  brand_id    uuid not null,
  round       int not null check (round >= 1),
  doc         jsonb,                                    -- ContentDoc for content deliverables
  files       jsonb not null default '[]'::jsonb,       -- [{path, name, mime, size}] in the service-files bucket
  note        text,                                     -- message to the customer
  status      text not null default 'draft' check (status in ('draft','in_review','returned','delivered','accepted','superseded')),
  qa_note     text,
  created_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (request_id, round)
);
create trigger service_deliverables_touch before update on public.service_deliverables for each row execute function app.touch_updated_at();
create or replace function app.inherit_request_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select workspace_id, brand_id into new.workspace_id, new.brand_id from public.service_requests where id = new.request_id;
  if new.workspace_id is null then raise exception 'parent request % not found', new.request_id using errcode = '23503'; end if;
  return new;
end $$;
create trigger service_deliverables_scope before insert on public.service_deliverables for each row execute function app.inherit_request_scope();

create table public.service_messages (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.service_requests(id) on delete cascade,
  workspace_id uuid not null,
  brand_id    uuid not null,
  author_id   uuid references public.users(id) on delete set null,
  author_kind text not null check (author_kind in ('customer','staff','system')),
  visibility  text not null default 'all' check (visibility in ('all','internal')),
  body        text not null check (length(body) between 1 and 5000),
  created_at  timestamptz not null default now(),
  check (visibility = 'all' or author_kind <> 'customer')
);
create index on public.service_messages (request_id, created_at);
create trigger service_messages_scope before insert on public.service_messages for each row execute function app.inherit_request_scope();

create table public.service_events (
  id          bigint generated always as identity primary key,
  request_id  uuid not null references public.service_requests(id) on delete cascade,
  workspace_id uuid not null,
  brand_id    uuid not null,
  from_status text,
  to_status   text,
  kind        text not null,                -- status | assigned | message | deliverable | charge | release | reminder
  actor_id    uuid references public.users(id) on delete set null,
  actor_kind  text not null check (actor_kind in ('customer','staff','system')),
  note        text,
  created_at  timestamptz not null default now()
);
create index on public.service_events (request_id, id);
create trigger service_events_scope before insert on public.service_events for each row execute function app.inherit_request_scope();

-- RLS: customers by brand permission; specialists only their assignments; managers everything.
alter table public.service_staff enable row level security;
alter table public.service_requests enable row level security;
alter table public.service_deliverables enable row level security;
alter table public.service_messages enable row level security;
alter table public.service_events enable row level security;

create policy service_staff_read on public.service_staff for select to authenticated
  using (user_id = (select auth.uid()) or app.service_staff_role() = 'manager');
create policy service_requests_read on public.service_requests for select to authenticated using (
  app.brand_perm(workspace_id, brand_id, 'content.read')
  or (assignee_id = (select auth.uid()) and app.service_staff_role() is not null)
  or (app.service_staff_role() = 'manager' and status <> 'draft'));
create policy service_deliverables_read on public.service_deliverables for select to authenticated using (
  (status in ('delivered','accepted','superseded') and app.brand_perm(workspace_id, brand_id, 'content.read'))
  or exists (select 1 from public.service_requests r where r.id = request_id and r.assignee_id = (select auth.uid()) and app.service_staff_role() is not null)
  or app.service_staff_role() = 'manager');
create policy service_messages_read on public.service_messages for select to authenticated using (
  (visibility = 'all' and app.brand_perm(workspace_id, brand_id, 'content.read'))
  or exists (select 1 from public.service_requests r where r.id = request_id and r.assignee_id = (select auth.uid()) and app.service_staff_role() is not null)
  or app.service_staff_role() = 'manager');
create policy service_events_read on public.service_events for select to authenticated using (
  app.brand_perm(workspace_id, brand_id, 'content.read')
  or exists (select 1 from public.service_requests r where r.id = request_id and r.assignee_id = (select auth.uid()) and app.service_staff_role() is not null)
  or app.service_staff_role() = 'manager');
grant select on public.service_staff, public.service_requests, public.service_deliverables, public.service_messages, public.service_events to authenticated;
grant all on public.service_staff, public.service_requests, public.service_deliverables, public.service_messages, public.service_events to service_role;

create trigger audit_service_requests after insert or update of status, assignee_id on public.service_requests for each row execute function app.audit_row();
create trigger audit_service_staff after insert or update or delete on public.service_staff for each row execute function app.audit_row();

-- Human work can take longer than a hold's TTL: keep holds of open requests alive.
create or replace function public.extend_reservation(p_reservation uuid, p_until timestamptz) returns public.credit_reservations
language plpgsql security definer set search_path = '' as $$
declare r public.credit_reservations;
begin
  update public.credit_reservations set expires_at = greatest(expires_at, p_until)
   where id = p_reservation and status = 'held' returning * into r;
  if not found then raise exception 'conflict: reservation % is not held', p_reservation using errcode = '23514'; end if;
  return r;
end $$;
revoke all on function public.extend_reservation(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.extend_reservation(uuid, timestamptz) to service_role;

-- Media library: files delivered by the service team land with source 'service'
alter table public.media_assets drop constraint media_assets_source_check;
alter table public.media_assets add constraint media_assets_source_check check (source in ('upload','url_import','generated','drive','render','service'));

-- Private bucket for work in progress (only the API reads/writes it, via signed URLs)
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public) values ('service-files', 'service-files', false) on conflict (id) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Notifications (in-app feed; the PWA and a future native app read the same API)
-- ---------------------------------------------------------------------------
create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  kind         text not null,
  title        text not null check (length(title) between 1 and 200),
  body         text,
  link         text,                       -- in-app path, e.g. /w/<ws>/b/<brand>/services/<id>
  data         jsonb not null default '{}'::jsonb,
  dedupe_key   text,
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index on public.notifications (user_id, created_at desc);
create index on public.notifications (user_id) where read_at is null;
create unique index notifications_dedupe on public.notifications (user_id, dedupe_key) where dedupe_key is not null;
alter table public.notifications enable row level security;
create policy notifications_own_read on public.notifications for select to authenticated using (user_id = (select auth.uid()));
grant select on public.notifications to authenticated;
grant all on public.notifications to service_role;

-- Devices for push (Web Push subscriptions now; FCM/APNs tokens for a native app later)
create table public.user_devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  kind         text not null check (kind in ('webpush','fcm','apns')),
  endpoint     text not null,              -- push endpoint URL or device token
  keys         jsonb not null default '{}'::jsonb,   -- webpush p256dh / auth
  label        text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, endpoint)
);
alter table public.user_devices enable row level security;
create policy user_devices_own_read on public.user_devices for select to authenticated using (user_id = (select auth.uid()));
grant select on public.user_devices to authenticated;
grant all on public.user_devices to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications, public.service_requests, public.service_messages;
  end if;
end $$;
