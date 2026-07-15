create or replace function brief_public_source_https_url_allowed(candidate text)
returns boolean
language sql
immutable
strict
parallel safe
as $$
  select candidate = btrim(candidate)
    and candidate !~ '[[:cntrl:]]'
    and candidate ~ '^https://(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:[/?#]|$)'
    and candidate !~* '^https://[^/?#]*\.(?:local|localhost|localdomain|internal|corp|lan|home|home\.arpa)(?:[/?#]|$)'
$$;

-- Quarantine any pre-policy tuples before making the invariant structural. An
-- item points to its document/raw tuple, so delete in dependency order.
delete from public_source_items
where not brief_public_source_https_url_allowed(canonical_url);

delete from public_source_documents
where not brief_public_source_https_url_allowed(canonical_url);

delete from public_source_raw_artifacts
where not brief_public_source_https_url_allowed(canonical_url);

delete from public_source_candidates
where not brief_public_source_https_url_allowed(canonical_url);

alter table public_source_candidates
  add constraint public_source_candidates_https_canonical_url
  check (brief_public_source_https_url_allowed(canonical_url));

alter table public_source_items
  add constraint public_source_items_https_canonical_url
  check (brief_public_source_https_url_allowed(canonical_url));

alter table public_source_documents
  add constraint public_source_documents_https_canonical_url
  check (brief_public_source_https_url_allowed(canonical_url));

alter table public_source_raw_artifacts
  add constraint public_source_raw_artifacts_https_canonical_url
  check (brief_public_source_https_url_allowed(canonical_url));
