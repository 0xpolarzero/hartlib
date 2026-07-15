alter table public_source_raw_artifacts
  add column if not exists body_bytes bytea;

-- The prior text-only schema cannot prove that a PDF survived byte-for-byte.
-- Quarantine those publications and leave their candidates eligible for an
-- authoritative refetch instead of fabricating binary data by transcoding text.
create temporary table public_source_unproven_pdf_artifacts
on commit drop
as
select id, source_id, canonical_url
from public_source_raw_artifacts
where lower(media_type) like '%pdf%';

update public_source_candidates candidates
set consecutive_failures = candidates.consecutive_failures + 1,
    last_error = 'binary_pdf_refetch_required',
    updated_at = now()
from public_source_unproven_pdf_artifacts artifacts
where candidates.source_id = artifacts.source_id
  and candidates.canonical_url = artifacts.canonical_url;

delete from public_source_items items
using public_source_unproven_pdf_artifacts artifacts
where items.latest_raw_artifact_id = artifacts.id;

delete from public_source_documents documents
using public_source_unproven_pdf_artifacts artifacts
where documents.raw_artifact_id = artifacts.id;

delete from public_source_raw_artifacts raw
using public_source_unproven_pdf_artifacts artifacts
where raw.id = artifacts.id;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'public_source_raw_artifacts_body_representation_check'
  ) then
    alter table public_source_raw_artifacts
      add constraint public_source_raw_artifacts_body_representation_check
      check (
        (
          lower(media_type) like '%html%'
          and length(body) > 0
          and body_bytes is null
        )
        or
        (
          lower(media_type) like '%pdf%'
          and body = ''
          and octet_length(body_bytes) > 0
          and substring(body_bytes from 1 for 5) = decode('255044462d', 'hex')
          and body_hash = encode(digest(body_bytes, 'sha256'), 'hex')
        )
      );
  end if;
end
$$;
