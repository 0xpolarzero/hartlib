-- Provider usage is immutable accounting. Keep the arithmetic invariant at
-- the database boundary as well as in the Pi/application boundary. Adding the
-- validated check deliberately fails the migration if historical accounting
-- is corrupt; no legacy row may remain outside the canonical invariant.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ai_run_usage_accounting_consistent'
  ) then
    alter table ai_run_usage
      add constraint ai_run_usage_accounting_consistent
      check (
        total_tokens = input_tokens::bigint
          + cached_tokens::bigint
          + output_tokens::bigint
        and reasoning_tokens <= output_tokens
      );
  end if;
end
$$;

-- An interrupted predecessor may have created the same constraint as
-- NOT VALID. Always finish validation on replay; corrupt history must abort
-- the migration rather than preserving a weakened constraint state.
alter table ai_run_usage
  validate constraint ai_run_usage_accounting_consistent;
