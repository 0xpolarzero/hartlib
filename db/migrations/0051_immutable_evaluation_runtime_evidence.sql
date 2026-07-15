-- A canonical evaluation binds its run before runtime evidence is produced.
-- Keep that evidence append-only from the moment it exists: otherwise a
-- coordinated pre-seal rewrite could manufacture a self-consistent digest.
create or replace function reject_ai_evaluation_runtime_evidence_mutation()
returns trigger
language plpgsql
as $$
declare
  evaluation_bound boolean;
begin
  select exists (
    select 1
    from ai_evaluation_case_runs
    where ai_run_id = old.run_id
  ) into evaluation_bound;

  if tg_op = 'UPDATE' and not evaluation_bound then
    select exists (
      select 1
      from ai_evaluation_case_runs
      where ai_run_id = new.run_id
    ) into evaluation_bound;
  end if;

  if evaluation_bound then
    raise exception 'canonical AI evaluation runtime evidence is append-only'
      using errcode = '23514',
            constraint = 'ai_evaluation_runtime_evidence_append_only',
            detail = tg_table_name;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists ai_source_exposures_protect_evaluation on ai_source_exposures;
create trigger ai_source_exposures_protect_evaluation
before update or delete on ai_source_exposures
for each row execute function reject_ai_evaluation_runtime_evidence_mutation();

drop trigger if exists ai_run_usage_protect_evaluation on ai_run_usage;
create trigger ai_run_usage_protect_evaluation
before update or delete on ai_run_usage
for each row execute function reject_ai_evaluation_runtime_evidence_mutation();

drop trigger if exists ai_external_tool_usage_protect_evaluation on ai_external_tool_usage;
create trigger ai_external_tool_usage_protect_evaluation
before update or delete on ai_external_tool_usage
for each row execute function reject_ai_evaluation_runtime_evidence_mutation();

drop trigger if exists ai_observations_protect_evaluation on ai_observations;
create trigger ai_observations_protect_evaluation
before update or delete on ai_observations
for each row execute function reject_ai_evaluation_runtime_evidence_mutation();
