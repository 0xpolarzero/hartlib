-- Detailed document inspections are durable evidence, not a transient Smithers
-- convenience. Keep only the immutable locator identity and normalized UTF-16
-- ranges needed to re-read the canonical document after Smithers cleanup; the
-- document body never crosses this table. Historical rows cannot be repaired
-- from this body-free table, so the checks remain NOT VALID while still
-- rejecting every new or updated row at the database boundary.

alter table ai_source_exposures
  add column if not exists document_source_id text,
  add column if not exists document_id text,
  add column if not exists document_version_id text,
  add column if not exists document_content_hash text,
  add column if not exists document_ranges jsonb;

create or replace function brief_valid_document_exposure_ranges(ranges jsonb)
returns boolean
language plpgsql
immutable
strict
as $$
declare
  item jsonb;
  char_start bigint;
  char_end bigint;
  previous_end bigint;
begin
  if jsonb_typeof(ranges) <> 'array' or jsonb_array_length(ranges) = 0 then
    return false;
  end if;

  for item in select value from jsonb_array_elements(ranges) loop
    if jsonb_typeof(item) is distinct from 'object'
       or jsonb_typeof(item->'charStart') is distinct from 'number'
       or jsonb_typeof(item->'charEnd') is distinct from 'number'
       or (item - 'charStart' - 'charEnd') <> '{}'::jsonb
       or (item->>'charStart') !~ '^[0-9]+$'
       or (item->>'charEnd') !~ '^[0-9]+$' then
      return false;
    end if;
    char_start := (item->>'charStart')::bigint;
    char_end := (item->>'charEnd')::bigint;
    if char_end <= char_start or (previous_end is not null and char_start <= previous_end) then
      return false;
    end if;
    previous_end := char_end;
  end loop;

  return true;
end;
$$;

alter table ai_source_exposures
  drop constraint if exists ai_source_exposures_document_reconstruction_consistent,
  add constraint ai_source_exposures_document_reconstruction_consistent
    check (
      (
        document_source_id is null
        and document_id is null
        and document_version_id is null
        and document_content_hash is null
        and document_ranges is null
        and (source_kind <> 'document' or exposure_stage = 'internal_search_preview')
      )
      or (
        source_kind = 'document'
        and document_source_id ~ '^((public|publisher):[^:[:space:]]+)$'
        and btrim(document_id) <> ''
        and btrim(document_version_id) <> ''
        and document_content_hash ~ '^[0-9a-f]{64}$'
        and brief_valid_document_exposure_ranges(document_ranges)
      )
    ) not valid,
  drop constraint if exists ai_source_exposures_document_reconstruction_required,
  add constraint ai_source_exposures_document_reconstruction_required
    check (
      not (
        source_kind = 'document'
        and exposure_stage in ('internal_inspection', 'context_candidate_inspection')
      )
      or (
        document_source_id is not null
        and document_id is not null
        and document_version_id is not null
        and document_content_hash is not null
        and document_ranges is not null
      )
    ) not valid;

create index if not exists ai_source_exposures_document_reconstruction_idx
  on ai_source_exposures (run_id, document_source_id, document_version_id)
  where document_source_id is not null;
