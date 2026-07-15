create temporary table invalid_public_source_media_artifacts
on commit drop
as
select id, source_id, canonical_url
from public_source_raw_artifacts
where btrim(lower(split_part(media_type, ';', 1)))
  not in ('text/html', 'application/pdf');

update public_source_candidates candidates
set consecutive_failures = candidates.consecutive_failures + 1,
    last_error = 'unsupported_public_source_media_type',
    updated_at = now()
from invalid_public_source_media_artifacts artifacts
where candidates.source_id = artifacts.source_id
  and candidates.canonical_url = artifacts.canonical_url;

delete from public_source_items items
using invalid_public_source_media_artifacts artifacts
where items.latest_raw_artifact_id = artifacts.id;

delete from public_source_documents documents
using invalid_public_source_media_artifacts artifacts
where documents.raw_artifact_id = artifacts.id;

delete from public_source_raw_artifacts raw
using invalid_public_source_media_artifacts artifacts
where raw.id = artifacts.id;

alter table public_source_raw_artifacts
  drop constraint if exists public_source_raw_artifacts_readable_media_check,
  drop constraint if exists public_source_raw_artifacts_body_representation_check;

alter table public_source_raw_artifacts
  add constraint public_source_raw_artifacts_readable_media_check
  check (
    btrim(lower(split_part(media_type, ';', 1)))
      in ('text/html', 'application/pdf')
  ),
  add constraint public_source_raw_artifacts_body_representation_check
  check (
    (
      btrim(lower(split_part(media_type, ';', 1))) = 'text/html'
      and length(body) > 0
      and body_bytes is null
    )
    or
    (
      btrim(lower(split_part(media_type, ';', 1))) = 'application/pdf'
      and body = ''
      and octet_length(body_bytes) > 0
      and substring(body_bytes from 1 for 5) = decode('255044462d', 'hex')
      and body_hash = encode(digest(body_bytes, 'sha256'), 'hex')
    )
  );
