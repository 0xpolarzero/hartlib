-- The nullable ai_run_id FK is cleared when chat/runtime content is purged,
-- but accounting idempotency must remain bound to the exact original run for
-- the full ten-year ledger retention period.

alter table client_credit_usage
  add column if not exists ai_run_identity uuid;

update client_credit_usage
set ai_run_identity = ai_run_id
where ai_run_identity is null and ai_run_id is not null;

do $$
begin
  if exists (
    select 1 from client_credit_usage where ai_run_identity is null
  ) then
    raise exception 'cannot recover immutable run identity for retained credit usage';
  end if;
end
$$;

alter table client_credit_usage
  alter column ai_run_identity set not null;

alter table client_credit_usage
  drop constraint if exists client_credit_usage_run_identity_matches_live_fk;
alter table client_credit_usage
  add constraint client_credit_usage_run_identity_matches_live_fk check (
    ai_run_id is null or ai_run_id = ai_run_identity
  );

create or replace function preserve_credit_usage_identity()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.ai_run_identity is null then
      new.ai_run_identity := new.ai_run_id;
    end if;
    if new.ai_run_identity is null
       or new.ai_run_id is null
       or new.ai_run_identity is distinct from new.ai_run_id then
      raise exception 'credit usage requires one exact run identity';
    end if;
    return new;
  end if;

  if new.client_company_id is distinct from old.client_company_id
     or new.user_id is distinct from old.user_id
     or new.ai_run_identity is distinct from old.ai_run_identity
     or (
       old.ai_run_id is null
       and new.ai_run_id is distinct from old.ai_run_id
     )
     or (
       old.ai_run_id is not null
       and new.ai_run_id is distinct from old.ai_run_id
       and new.ai_run_id is not null
     )
     or new.credits is distinct from old.credits
     or new.calculation_version is distinct from old.calculation_version
     or new.calculation_inputs is distinct from old.calculation_inputs
     or new.idempotency_key is distinct from old.idempotency_key
     or new.created_at is distinct from old.created_at then
    raise exception 'credit usage identity is immutable';
  end if;

  return new;
end;
$$;

drop trigger if exists client_credit_usage_preserve_identity on client_credit_usage;
create trigger client_credit_usage_preserve_identity
before insert or update on client_credit_usage
for each row execute function preserve_credit_usage_identity();
