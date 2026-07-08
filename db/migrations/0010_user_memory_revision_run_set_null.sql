do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'user_memory_revisions_run_id_fkey'
  ) then
    alter table user_memory_revisions
      drop constraint user_memory_revisions_run_id_fkey;
  end if;
end
$$;

alter table user_memory_revisions
  add constraint user_memory_revisions_run_id_fkey
  foreign key (run_id)
  references ai_runs (id)
  on delete set null;
