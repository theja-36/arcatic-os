-- Arcatic Marketing OS — 0005 Analytics & learning

-- Raw, append-only events from every source (Postiz analytics, Matomo, email, ads).
create table public.analytics_events (
  id                   bigint generated always as identity primary key,
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  brand_id             uuid,
  source               text not null,   -- 'postiz','matomo','ga4','mautic','meta_ads','google_ads'
  connected_account_id uuid references public.connected_accounts(id) on delete set null,
  external_id          text,            -- platform post / campaign id
  event_type           text not null,   -- 'snapshot','click','open','conversion', ...
  occurred_at          timestamptz not null,
  payload              jsonb not null,
  ingested_at          timestamptz not null default now(),
  unique (source, external_id, event_type, occurred_at)
);
create index on public.analytics_events (workspace_id, occurred_at desc);

-- Normalised daily metrics; the dashboard reads only this table.
create table public.performance_metrics (
  id                   bigint generated always as identity primary key,
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  brand_id             uuid,
  content_item_id      uuid,
  publishing_job_id    uuid references public.publishing_jobs(id) on delete set null,
  campaign_id          uuid,
  connected_account_id uuid references public.connected_accounts(id) on delete set null,
  channel              text not null,
  metric_date          date not null,
  impressions          bigint,
  reach                bigint,
  engagements          bigint,
  likes                bigint,
  comments             bigint,
  shares               bigint,
  saves                bigint,
  clicks               bigint,
  video_views          bigint,
  watch_time_seconds   bigint,
  opens                bigint,
  conversions          bigint,
  spend_minor          bigint,
  extra                jsonb not null default '{}'::jsonb,
  updated_at           timestamptz not null default now(),
  unique nulls not distinct (workspace_id, channel, content_item_id, connected_account_id, metric_date)
);
create index on public.performance_metrics (workspace_id, brand_id, metric_date desc);
create index on public.performance_metrics (campaign_id, metric_date);

create table public.insights (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  brand_id      uuid,
  kind          text not null check (kind in ('trend','top_content','underperformer','recommendation','voice_refinement','anomaly')),
  title         text not null,
  body          text not null,
  evidence      jsonb not null default '{}'::jsonb,   -- metric refs, content ids, confidence
  status        text not null default 'new' check (status in ('new','accepted','dismissed','applied')),
  period_start  date,
  period_end    date,
  decided_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create index on public.insights (workspace_id, brand_id, created_at desc);

-- Every human or market signal that can improve future generation.
create table public.learning_signals (
  id                 bigint generated always as identity primary key,
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,
  brand_id           uuid,
  content_item_id    uuid,
  content_version_id uuid references public.content_versions(id) on delete set null,
  signal             text not null check (signal in (
                       'edit','approve','reject','request_changes','regenerate','rating',
                       'engagement_outcome','publish_failure','manual_note')),
  edit_class         text,            -- 'tone','length','fact','cta','hashtags','language', ...
  value              numeric,         -- rating / normalised engagement score
  details            jsonb not null default '{}'::jsonb,
  prompt_template    text,
  model              text,
  actor_id           uuid references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  foreign key (brand_id, workspace_id) references public.brands(id, workspace_id) on delete cascade
);
create index on public.learning_signals (workspace_id, brand_id, signal, created_at desc);
