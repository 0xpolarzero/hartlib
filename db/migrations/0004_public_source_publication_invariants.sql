create table if not exists public_source_candidates (
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
  last_fetched_at timestamptz,
  last_successful_fetch_at timestamptz,
  last_not_modified_at timestamptz,
  consecutive_failures integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_id, canonical_url)
);

insert into public_source_candidates (
  source_id,
  canonical_url,
  external_id,
  title,
  published_at,
  discovered_at,
  source_updated_at,
  summary,
  metadata,
  etag,
  last_modified,
  last_fetched_at,
  last_successful_fetch_at,
  last_not_modified_at,
  consecutive_failures,
  last_error,
  created_at,
  updated_at
)
select
  source_id,
  canonical_url,
  external_id,
  title,
  published_at,
  discovered_at,
  source_updated_at,
  summary,
  metadata,
  etag,
  last_modified,
  last_fetched_at,
  last_successful_fetch_at,
  last_not_modified_at,
  consecutive_failures,
  last_error,
  created_at,
  updated_at
from public_source_items
on conflict (source_id, canonical_url) do update set
  external_id = coalesce(excluded.external_id, public_source_candidates.external_id),
  title = excluded.title,
  published_at = coalesce(excluded.published_at, public_source_candidates.published_at),
  discovered_at = least(public_source_candidates.discovered_at, excluded.discovered_at),
  source_updated_at = coalesce(
    excluded.source_updated_at,
    public_source_candidates.source_updated_at
  ),
  summary = coalesce(excluded.summary, public_source_candidates.summary),
  metadata = public_source_candidates.metadata || excluded.metadata,
  etag = coalesce(excluded.etag, public_source_candidates.etag),
  last_modified = coalesce(excluded.last_modified, public_source_candidates.last_modified),
  last_fetched_at = coalesce(excluded.last_fetched_at, public_source_candidates.last_fetched_at),
  last_successful_fetch_at = coalesce(
    excluded.last_successful_fetch_at,
    public_source_candidates.last_successful_fetch_at
  ),
  last_not_modified_at = coalesce(
    excluded.last_not_modified_at,
    public_source_candidates.last_not_modified_at
  ),
  consecutive_failures = excluded.consecutive_failures,
  last_error = excluded.last_error,
  updated_at = now();

update public_source_items
set latest_document_id = null
where latest_document_id is not null
  and not exists (
    select 1
    from public_source_documents d
    where d.document_id = public_source_items.latest_document_id
  );

delete from public_source_items
where current_content_hash is null
  or latest_document_id is null
  or latest_raw_artifact_id is null;

delete from public_source_items i
where not exists (
    select 1
    from public_source_documents d
    join public_source_raw_artifacts r on r.id = d.raw_artifact_id
    where d.document_id = i.latest_document_id
      and d.text_char_count >= 100
      and (
        lower(r.media_type) like '%html%'
        or lower(r.media_type) like '%pdf%'
      )
  );

delete from public_source_documents d
where d.text_char_count < 100
  or not exists (
    select 1
    from public_source_raw_artifacts r
    where r.id = d.raw_artifact_id
      and (
        lower(r.media_type) like '%html%'
        or lower(r.media_type) like '%pdf%'
      )
  );

delete from public_source_raw_artifacts r
where (
    lower(r.media_type) not like '%html%'
    and lower(r.media_type) not like '%pdf%'
  )
  or not exists (
    select 1
    from public_source_documents d
    where d.raw_artifact_id = r.id
  );

alter table public_source_items
  alter column current_content_hash set not null,
  alter column latest_document_id set not null,
  alter column latest_raw_artifact_id set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'public_source_items_latest_document_id_fkey'
  ) then
    alter table public_source_items
      add constraint public_source_items_latest_document_id_fkey
      foreign key (latest_document_id)
      references public_source_documents (document_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'public_source_documents_text_readable_check'
  ) then
    alter table public_source_documents
      add constraint public_source_documents_text_readable_check
      check (text_char_count >= 100);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'public_source_raw_artifacts_readable_media_check'
  ) then
    alter table public_source_raw_artifacts
      add constraint public_source_raw_artifacts_readable_media_check
      check (
        lower(media_type) like '%html%'
        or lower(media_type) like '%pdf%'
      );
  end if;
end
$$;
