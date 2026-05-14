-- Pass 1: durable enrichment queue foundation.
-- Foundation only — no worker, no claim/complete endpoints, and no production
-- endpoint automatically enqueues into this table yet. Mirrors
-- lib/db/src/schema/enrichmentJobs.ts.

create table if not exists public.enrichment_jobs (
  id uuid primary key default gen_random_uuid(),

  job_key text not null,
  job_type text not null default 'detail_only',

  query text null,
  normalized_query text null,
  name text null,
  house text null,
  year integer null,
  bn_url text null,
  fg_url text null,
  source_id text null,

  status text not null default 'pending',
  priority integer not null default 0,
  requested_count integer not null default 1,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_requested_at timestamptz not null default now(),

  -- Worker lifecycle columns — present so Pass 2 needs no migration, unused in Pass 1.
  claimed_at timestamptz null,
  claim_expires_at timestamptz null,
  completed_at timestamptz null,
  failed_at timestamptz null,
  ignored_at timestamptz null,
  last_error text null,

  metadata_json jsonb null
);

create unique index if not exists enrichment_jobs_job_key_unique_idx
on public.enrichment_jobs (job_key);

create index if not exists enrichment_jobs_status_idx
on public.enrichment_jobs (status);

create index if not exists enrichment_jobs_fg_url_idx
on public.enrichment_jobs (fg_url);

create index if not exists enrichment_jobs_status_priority_idx
on public.enrichment_jobs (status, priority);

comment on table public.enrichment_jobs is
  'Durable enrichment request queue (Pass 1: persistence foundation only — no worker, no automatic enqueue hook).';

comment on column public.enrichment_jobs.job_key is
  'Canonical idempotency key. One row per job_key; repeated requests upsert instead of inserting duplicates.';
