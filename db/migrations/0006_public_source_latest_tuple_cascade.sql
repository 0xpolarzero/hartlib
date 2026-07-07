do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'public_source_items_latest_document_tuple_fkey'
  ) then
    alter table public_source_items
      drop constraint public_source_items_latest_document_tuple_fkey;
  end if;
end
$$;

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
