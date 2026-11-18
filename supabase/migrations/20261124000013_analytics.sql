-- Arcatic Marketing OS — 0013 Analytics warehouse & learning (Phase 8)

-- ---------------------------------------------------------------------------
-- Secrets for analytics sources (service-only table from 0012)
-- ---------------------------------------------------------------------------
alter table public.integration_secrets drop constraint integration_secrets_purpose_check;
alter table public.integration_secrets add constraint integration_secrets_purpose_check check (purpose in (
  'postiz_api_key','wordpress_app_password','mautic_password','matomo_token','google_ads_refresh_token','meta_access_token'));

-- ---------------------------------------------------------------------------
-- Analytics sources: Matomo site, Google Ads customer, Meta ad account (per workspace, optionally per brand)
-- ---------------------------------------------------------------------------
create table public.analytics_connections (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  brand_id       uuid,
  provider       text not null check (provider in ('matomo','google_ads','meta_ads')),
  base_url       text,                     -- Matomo URL
  account_ref    text not null,            -- Matomo idSite / Ads customer id / act_<id>
  display_name   text,
  secret_id      uuid references public.integration_secrets(id) on delete set null,
  settings       jsonb not null default '{}'::jsonb,   -- e.g. login_customer_id
  status         text not null default 'active' check (status in ('active','error','disconnected')),
  last_synced_at timestamptz,
  last_error     text,
  connected_by   uuid references public.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (workspace_id, provider, account_ref),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create trigger analytics_connections_touch before update on public.analytics_connections
  for each row execute function app.touch_updated_at();

create table public.analytics_sync_runs (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source       text not null,
  status       text not null default 'running' check (status in ('running','succeeded','failed','skipped')),
  rows_written int not null default 0,
  error        text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index on public.analytics_sync_runs (workspace_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Warehouse: one row per (metric_key, day). metric_key names the thing measured:
--   post:<schedule>  email:<schedule>  account:<connected_account>  site:<connection>
--   ad:<connection>:<campaign id>     utm:<connection>:<campaign label>
-- Post / email rows are cumulative lifetime snapshots (cumulative = true).
-- ---------------------------------------------------------------------------
alter table public.performance_metrics drop constraint if exists performance_metrics_workspace_id_channel_content_item_id_co_key;
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.performance_metrics'::regclass and contype = 'u' loop
    execute format('alter table public.performance_metrics drop constraint %I', c);
  end loop;
end $$;
alter table public.performance_metrics
  add column metric_key   text,
  add column kind         text check (kind in ('post','email','account','site','ad','utm')),
  add column source       text,
  add column schedule_id  uuid references public.schedules(id) on delete set null,
  add column topic_id     uuid references public.campaign_topics(id) on delete set null,
  add column external_id  text,
  add column cumulative   boolean not null default false,
  add column followers    bigint,
  add column visits       bigint,
  add column visitors     bigint,
  add column bounces      bigint,
  add column sends        bigint,
  add column failed       bigint,
  add column unique_clicks bigint,
  add column conversion_value_minor bigint;
update public.performance_metrics set metric_key = coalesce(metric_key, 'legacy:' || id::text), kind = coalesce(kind, 'post');
alter table public.performance_metrics alter column metric_key set not null, alter column kind set not null;
create unique index performance_metrics_key_day on public.performance_metrics (workspace_id, metric_key, metric_date);
create index on public.performance_metrics (workspace_id, brand_id, kind, metric_date desc);
create index on public.performance_metrics (schedule_id);

-- Latest lifetime snapshot of every post/email published in [p_from, p_to) — what dashboards rank.
create or replace function public.post_performance(p_brand uuid, p_from timestamptz, p_to timestamptz)
returns table (
  schedule_id uuid, content_item_id uuid, campaign_id uuid, topic_id uuid, channel text, kind text, published_at timestamptz,
  connected_account_id uuid, external_url text, metric_date date,
  impressions bigint, reach bigint, video_views bigint, engagements bigint, likes bigint, comments bigint, shares bigint, saves bigint,
  clicks bigint, unique_clicks bigint, opens bigint, sends bigint, failed bigint, conversions bigint
)
language sql stable security invoker set search_path = '' as $$
  select distinct on (m.metric_key)
    s.id, s.content_item_id, ci.campaign_id, m.topic_id, m.channel, m.kind, s.published_at, s.connected_account_id, s.external_url, m.metric_date,
    m.impressions, m.reach, m.video_views, m.engagements, m.likes, m.comments, m.shares, m.saves,
    m.clicks, m.unique_clicks, m.opens, m.sends, m.failed, m.conversions
  from public.performance_metrics m
  join public.schedules s on s.id = m.schedule_id
  join public.content_items ci on ci.id = s.content_item_id
  where s.brand_id = p_brand and s.status = 'published' and s.published_at >= p_from and s.published_at < p_to
    and m.kind in ('post','email')
  order by m.metric_key, m.metric_date desc;
$$;
grant execute on function public.post_performance(uuid, timestamptz, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Insights: dedupe, confidence, and the one sentence a person may approve for future generation
-- ---------------------------------------------------------------------------
alter table public.insights drop constraint insights_kind_check;
alter table public.insights
  add constraint insights_kind_check check (kind in ('trend','top_content','underperformer','recommendation','voice_refinement','anomaly','ai_quality')),
  add column fingerprint text,
  add column confidence  numeric check (confidence between 0 and 1),
  add column guidance    text,            -- used in prompts ONLY after status = accepted
  add column applies_to  jsonb not null default '{}'::jsonb,   -- {channel?, contentType?}
  add column decided_at  timestamptz,
  add column updated_at  timestamptz not null default now();
create unique index insights_open_fingerprint on public.insights (brand_id, fingerprint) where fingerprint is not null and status in ('new','accepted');
create trigger insights_touch before update on public.insights
  for each row execute function app.touch_updated_at();

-- Provenance: which accepted learnings a generated version used
alter table public.content_versions add column insight_ids uuid[] not null default array[]::uuid[];

-- ---------------------------------------------------------------------------
-- Learning signals: more kinds + link to the published post
-- ---------------------------------------------------------------------------
alter table public.learning_signals drop constraint learning_signals_signal_check;
alter table public.learning_signals
  add constraint learning_signals_signal_check check (signal in (
    'edit','approve','reject','request_changes','regenerate','rating','engagement_outcome','publish_failure','manual_note',
    'insight_accept','insight_dismiss')),
  add column schedule_id uuid references public.schedules(id) on delete set null;
create unique index learning_signals_one_outcome on public.learning_signals (schedule_id) where signal = 'engagement_outcome';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.analytics_connections enable row level security;
alter table public.analytics_sync_runs enable row level security;
create policy analytics_connections_select on public.analytics_connections for select to authenticated
  using (app.can(workspace_id, brand_id, 'analytics.read'));
create policy analytics_sync_runs_select on public.analytics_sync_runs for select to authenticated
  using (app.has_permission(workspace_id, 'analytics.read'));
grant select on public.analytics_connections, public.analytics_sync_runs to authenticated;
grant all on public.analytics_connections, public.analytics_sync_runs to service_role;
-- insights: readable with analytics.read (0006 generic policies cover performance_metrics/learning_signals)
alter table public.insights enable row level security;
drop policy if exists insights_select on public.insights;
-- decisions go through the API (records who decided; accepted guidance reaches prompts)
drop policy if exists insights_decide on public.insights;
create policy insights_select on public.insights for select to authenticated using (app.can(workspace_id, brand_id, 'analytics.read'));
grant select on public.insights to authenticated;
