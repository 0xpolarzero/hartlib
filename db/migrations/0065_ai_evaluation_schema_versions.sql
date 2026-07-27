-- Evaluation artifacts and sessions now use the strict v3 contract.
-- Terminal v2 evidence is retained, while new rows must use v3. The NOT VALID
-- check leaves immutable historical rows readable without rewriting them.
do $$
declare
  nonterminal_v2_count bigint;
begin
  if to_regclass('public.ai_evaluation_sessions') is null then
    return;
  end if;

  select count(*)
  into nonterminal_v2_count
  from ai_evaluation_sessions
  where artifact_version = 2
    and golden_set_version = 2
    and status not in ('complete', 'failed');

  if nonterminal_v2_count > 0 then
    raise exception
      'cannot install evaluation v3 contract while % nonterminal v2 session(s) remain',
      nonterminal_v2_count
      using errcode = '55000';
  end if;

  alter table ai_evaluation_sessions
    drop constraint if exists ai_evaluation_sessions_versions;

  alter table ai_evaluation_sessions
    add constraint ai_evaluation_sessions_versions
    check (artifact_version = 3 and golden_set_version = 3)
    not valid;
end
$$;
