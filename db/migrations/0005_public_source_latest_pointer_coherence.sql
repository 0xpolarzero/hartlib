delete from public_source_items i
where not exists (
    select 1
    from public_source_documents d
    join public_source_raw_artifacts r on r.id = d.raw_artifact_id
    where d.document_id = i.latest_document_id
      and d.source_id = i.source_id
      and d.canonical_url = i.canonical_url
      and d.content_hash = i.current_content_hash
      and d.raw_artifact_id = i.latest_raw_artifact_id
      and r.source_id = i.source_id
      and r.canonical_url = i.canonical_url
  );

delete from public_source_documents d
where not exists (
    select 1
    from public_source_raw_artifacts r
    where r.id = d.raw_artifact_id
      and r.source_id = d.source_id
      and r.canonical_url = d.canonical_url
  );

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'public_source_raw_artifacts_id_source_url_key'
  ) then
    alter table public_source_raw_artifacts
      add constraint public_source_raw_artifacts_id_source_url_key
      unique (id, source_id, canonical_url);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'public_source_documents_raw_source_url_fkey'
  ) then
    alter table public_source_documents
      add constraint public_source_documents_raw_source_url_fkey
      foreign key (raw_artifact_id, source_id, canonical_url)
      references public_source_raw_artifacts (id, source_id, canonical_url);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'public_source_documents_latest_tuple_key'
  ) then
    alter table public_source_documents
      add constraint public_source_documents_latest_tuple_key
      unique (document_id, source_id, canonical_url, content_hash, raw_artifact_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'public_source_items_latest_document_tuple_fkey'
  ) then
    alter table public_source_items
      add constraint public_source_items_latest_document_tuple_fkey
      foreign key (
        latest_document_id,
        source_id,
        canonical_url,
        current_content_hash,
        latest_raw_artifact_id
      )
      references public_source_documents (
        document_id,
        source_id,
        canonical_url,
        content_hash,
        raw_artifact_id
      )
      on update cascade;
  end if;
end
$$;
