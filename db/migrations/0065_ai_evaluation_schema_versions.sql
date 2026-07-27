-- Evaluation artifacts and sessions now use the strict v3 contract.
-- Existing v2 rows must be drained or removed; this migration never rewrites them.
do $$
begin
  if to_regclass('public.ai_evaluation_sessions') is null then
    return;
  end if;

  alter table ai_evaluation_sessions
    drop constraint if exists ai_evaluation_sessions_versions;

  alter table ai_evaluation_sessions
    add constraint ai_evaluation_sessions_versions
    check (artifact_version = 3 and golden_set_version = 3);
end
$$;
