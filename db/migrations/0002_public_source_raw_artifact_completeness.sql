create index if not exists public_source_items_incomplete_raw_recent_idx
  on public_source_items (source_id, coalesce(published_at, discovered_at) desc)
  where latest_raw_artifact_id is null;

create index if not exists public_source_raw_artifacts_url_hash_idx
  on public_source_raw_artifacts (source_id, canonical_url, body_hash);
