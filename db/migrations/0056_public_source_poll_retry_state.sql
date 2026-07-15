alter table public_source_candidates
  add column if not exists poll_eligible boolean not null default true;

-- Existing candidates may have originated in recurring polls or startup
-- backfills; their origin is not reconstructible from the legacy schema. Keep
-- them eligible so a transient failure cannot be silently starved. New rows
-- always write the explicit mode marker from the repository.

comment on column public_source_candidates.poll_eligible is
  'True for candidates first discovered during recurring poll mode; new startup backfill candidates write false, while legacy rows remain true as the non-starving fail-safe.';
