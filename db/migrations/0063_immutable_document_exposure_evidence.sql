-- Reassert the reconstructable-exposure cardinality for databases that already
-- applied 0062, and bind stored document versions to their exact UTF-8 text.
-- The checks remain NOT VALID so historical evidence is not silently repaired;
-- PostgreSQL still enforces every new row and every updated row.

alter table ai_source_exposures
  drop constraint if exists ai_source_exposures_document_reconstruction_consistent,
  add constraint ai_source_exposures_document_reconstruction_consistent
    check (
      (
        (
          (
            (document_source_id is not null)::integer
            + (document_id is not null)::integer
            + (document_version_id is not null)::integer
            + (document_content_hash is not null)::integer
            + (document_ranges is not null)::integer
          ) = 0
          and (source_kind <> 'document' or exposure_stage = 'internal_search_preview')
        )
        or (
          (
            (document_source_id is not null)::integer
            + (document_id is not null)::integer
            + (document_version_id is not null)::integer
            + (document_content_hash is not null)::integer
            + (document_ranges is not null)::integer
          ) = 5
          and source_kind = 'document'
          and document_source_id ~ '^((public|publisher):[^:[:space:]]+)$'
          and btrim(document_id) <> ''
          and btrim(document_version_id) <> ''
          and document_content_hash ~ '^[0-9a-f]{64}$'
          and brief_valid_document_exposure_ranges(document_ranges) is true
        )
      ) is true
    ) not valid,
  drop constraint if exists ai_source_exposures_document_reconstruction_required,
  add constraint ai_source_exposures_document_reconstruction_required
    check (
      (
        source_kind <> 'document'
        or exposure_stage = 'internal_search_preview'
        or (
          document_source_id is not null
          and document_id is not null
          and document_version_id is not null
          and document_content_hash is not null
          and document_ranges is not null
        )
      ) is true
    ) not valid;

alter table public_source_documents
  drop constraint if exists public_source_documents_content_hash_sha256,
  add constraint public_source_documents_content_hash_sha256
    check (
      content_hash = encode(digest(convert_to(text, 'UTF8'), 'sha256'), 'hex')
    ) not valid;

alter table brief_document_versions
  drop constraint if exists brief_document_versions_content_hash_sha256,
  add constraint brief_document_versions_content_hash_sha256
    check (
      content_hash = encode(digest(convert_to(canonical_text, 'UTF8'), 'sha256'), 'hex')
    ) not valid;

create or replace function protect_public_source_document_text_hash()
returns trigger
language plpgsql
as $$
begin
  if new.content_hash is distinct from encode(digest(convert_to(new.text, 'UTF8'), 'sha256'), 'hex') then
    raise exception 'public source document content hash must match exact UTF-8 text'
      using errcode = '23514', constraint = 'public_source_documents_content_hash_sha256';
  end if;

  if tg_op = 'UPDATE'
     and (
       new.text is distinct from old.text
       or new.text_char_count is distinct from old.text_char_count
       or new.content_hash is distinct from old.content_hash
     ) then
    raise exception 'public source document text and content hash are immutable'
      using errcode = '23514', constraint = 'public_source_documents_text_hash_immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists public_source_documents_protect_text_hash on public_source_documents;
create trigger public_source_documents_protect_text_hash
before insert or update of text, text_char_count, content_hash
on public_source_documents
for each row execute function protect_public_source_document_text_hash();

create or replace function protect_brief_document_version_text_hash()
returns trigger
language plpgsql
as $$
begin
  if new.content_hash is distinct from encode(
    digest(convert_to(new.canonical_text, 'UTF8'), 'sha256'),
    'hex'
  ) then
    raise exception 'publisher document version content hash must match exact UTF-8 text'
      using errcode = '23514', constraint = 'brief_document_versions_content_hash_sha256';
  end if;

  if tg_op = 'UPDATE'
     and (
       new.canonical_text is distinct from old.canonical_text
       or new.text_char_count is distinct from old.text_char_count
       or new.content_hash is distinct from old.content_hash
     ) then
    raise exception 'publisher document version text and content hash are immutable'
      using errcode = '23514', constraint = 'brief_document_versions_text_hash_immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists brief_document_versions_protect_text_hash on brief_document_versions;
create trigger brief_document_versions_protect_text_hash
before insert or update of canonical_text, text_char_count, content_hash
on brief_document_versions
for each row execute function protect_brief_document_version_text_hash();
