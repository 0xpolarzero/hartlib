-- Existing accepted runs keep their scope after live entitlements and
-- settings change. Validate the complete scope only when the run is accepted;
-- later updates may only preserve the scope and its tenant binding.
drop trigger if exists ai_runs_validate_acceptance_scope on ai_runs;

create trigger ai_runs_validate_acceptance_scope_insert
before insert on ai_runs
for each row execute function brief_ai_validate_acceptance_scope();

create or replace function brief_ai_validate_acceptance_scope_update_identity()
returns trigger language plpgsql as $$
begin
  if new.acceptance_scope is distinct from old.acceptance_scope then
    raise exception 'AI run acceptance scope is immutable'
      using errcode = '23514', constraint = 'ai_runs_acceptance_scope_immutable';
  end if;

  if new.initiating_user_id is distinct from old.initiating_user_id
     or new.chat_id is distinct from old.chat_id then
    if (new.acceptance_scope->>'userId') is distinct from new.initiating_user_id::text
       or (new.acceptance_scope->>'chatId') is distinct from new.chat_id::text
       or not exists (
         select 1
         from chats chat
         where chat.id = new.chat_id
           and chat.company_id::text = new.acceptance_scope->>'companyId'
           and chat.user_id = new.initiating_user_id
       ) then
      raise exception 'AI run acceptance scope tenant binding is invalid'
        using errcode = '23514', constraint = 'ai_runs_acceptance_scope_binding';
    end if;
  end if;

  return new;
end;
$$;

create trigger ai_runs_validate_acceptance_scope_update
before update on ai_runs
for each row execute function brief_ai_validate_acceptance_scope_update_identity();
