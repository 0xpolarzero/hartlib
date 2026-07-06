create extension if not exists pgcrypto;

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  unique_key text,
  status text not null default 'queued',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  available_at timestamptz not null default now(),
  priority integer not null default 0,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists jobs_unique_key_idx
  on jobs (unique_key)
  where unique_key is not null;

create index if not exists jobs_claim_idx
  on jobs (status, priority desc, available_at, created_at)
  where status in ('queued', 'retrying');

create table if not exists public_sources (
  source_id text primary key,
  display_name text not null,
  publisher_name text not null,
  description text not null,
  ingestion_method text not null,
  discovery_url text not null,
  discovery_urls jsonb not null default '[]'::jsonb,
  content_url text,
  expected_cadence text not null,
  average_chars_per_item integer not null,
  health_status text not null default 'unknown',
  latest_successful_fetch_at timestamptz,
  latest_attempted_fetch_at timestamptz,
  consecutive_failures integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public_source_discovery_requests (
  source_id text not null references public_sources (source_id) on delete cascade,
  url text not null,
  etag text,
  last_modified text,
  body_hash text,
  last_status integer,
  last_fetched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_id, url)
);

create table if not exists public_source_items (
  source_id text not null references public_sources (source_id) on delete cascade,
  canonical_url text not null,
  external_id text,
  title text not null,
  published_at timestamptz,
  discovered_at timestamptz not null,
  source_updated_at timestamptz,
  summary text,
  metadata jsonb not null default '{}'::jsonb,
  etag text,
  last_modified text,
  current_content_hash text,
  latest_document_id text,
  latest_raw_artifact_id uuid,
  last_fetched_at timestamptz,
  last_successful_fetch_at timestamptz,
  last_not_modified_at timestamptz,
  consecutive_failures integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_id, canonical_url)
);

create index if not exists public_source_items_recent_idx
  on public_source_items (source_id, coalesce(published_at, discovered_at) desc);

create index if not exists public_source_items_incomplete_recent_idx
  on public_source_items (source_id, coalesce(published_at, discovered_at) desc)
  where latest_document_id is null
    or latest_raw_artifact_id is null
    or current_content_hash is null
    or consecutive_failures > 0;

create table if not exists public_source_raw_artifacts (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references public_sources (source_id) on delete cascade,
  canonical_url text not null,
  fetched_at timestamptz not null,
  media_type text not null,
  body text not null,
  body_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (source_id, canonical_url, body_hash)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'public_source_items_latest_raw_artifact_id_fkey'
  ) then
    alter table public_source_items
      add constraint public_source_items_latest_raw_artifact_id_fkey
      foreign key (latest_raw_artifact_id)
      references public_source_raw_artifacts (id);
  end if;
end
$$;

create table if not exists public_source_documents (
  document_id text primary key,
  source_id text not null references public_sources (source_id) on delete cascade,
  external_id text,
  canonical_url text not null,
  title text not null,
  published_at timestamptz,
  discovered_at timestamptz not null,
  fetched_at timestamptz not null,
  language text not null,
  document_type text not null,
  text text not null,
  text_char_count integer not null,
  content_hash text not null,
  raw_artifact_id uuid not null references public_source_raw_artifacts (id),
  source_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (source_id, canonical_url, content_hash)
);

create index if not exists public_source_documents_url_idx
  on public_source_documents (source_id, canonical_url, fetched_at desc);

create table if not exists public_source_ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references public_sources (source_id) on delete cascade,
  mode text not null,
  status text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  discovered_count integer not null default 0,
  fetched_count integer not null default 0,
  unchanged_count integer not null default 0,
  stored_document_count integer not null default 0,
  failed_count integer not null default 0,
  error text,
  metadata jsonb not null default '{}'::jsonb
);
