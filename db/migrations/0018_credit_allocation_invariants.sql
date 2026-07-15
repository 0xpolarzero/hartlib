-- Credit allocation is an accounting boundary. Keep company identity explicit
-- on the join row, serialize every write in the same company lane as the
-- application service, and validate final transaction state with deferred
-- constraint triggers so multi-lot consumption remains atomic.

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'client_credit_usage_id_company_key'
  ) then
    alter table client_credit_usage
      add constraint client_credit_usage_id_company_key
      unique (id, client_company_id);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'client_credit_lots_id_company_key'
  ) then
    alter table client_credit_lots
      add constraint client_credit_lots_id_company_key
      unique (id, client_company_id);
  end if;
end
$$;

alter table client_credit_usage_allocations
  add column if not exists client_company_id uuid;

update client_credit_usage_allocations allocations
set client_company_id = usage.client_company_id
from client_credit_usage usage
where usage.id = allocations.usage_id
  and allocations.client_company_id is null;

alter table client_credit_usage_allocations
  alter column client_company_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'client_credit_usage_allocations_usage_company_fkey'
  ) then
    alter table client_credit_usage_allocations
      add constraint client_credit_usage_allocations_usage_company_fkey
      foreign key (usage_id, client_company_id)
      references client_credit_usage (id, client_company_id)
      on delete restrict
      deferrable initially deferred;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'client_credit_usage_allocations_lot_company_fkey'
  ) then
    alter table client_credit_usage_allocations
      add constraint client_credit_usage_allocations_lot_company_fkey
      foreign key (credit_lot_id, client_company_id)
      references client_credit_lots (id, client_company_id)
      on delete restrict
      deferrable initially deferred;
  end if;
end
$$;

create index if not exists client_credit_usage_allocations_company_idx
  on client_credit_usage_allocations (client_company_id, usage_id, credit_lot_id);

create or replace function serialize_credit_company_write()
returns trigger
language plpgsql
as $$
declare
  company uuid;
begin
  for company in
    select distinct value
    from (
      select case when tg_op <> 'INSERT' then old.client_company_id else null end as value
      union all
      select case when tg_op <> 'DELETE' then new.client_company_id else null end as value
    ) companies
    where value is not null
    order by value
  loop
    perform pg_advisory_xact_lock(hashtext('brief:credits:' || company::text));
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists client_credit_usage_serialize_company on client_credit_usage;
create trigger client_credit_usage_serialize_company
before insert or update or delete on client_credit_usage
for each row execute function serialize_credit_company_write();

drop trigger if exists client_credit_lots_serialize_company on client_credit_lots;
create trigger client_credit_lots_serialize_company
before insert or update or delete on client_credit_lots
for each row execute function serialize_credit_company_write();

drop trigger if exists client_credit_allocations_serialize_company on client_credit_usage_allocations;
create trigger client_credit_allocations_serialize_company
before insert or update or delete on client_credit_usage_allocations
for each row execute function serialize_credit_company_write();

create or replace function assert_credit_usage_fully_allocated(target_usage_id uuid)
returns void
language plpgsql
as $$
declare
  charged bigint;
  allocated bigint;
begin
  select usage.credits,
         coalesce(sum(allocations.credits), 0)
    into charged, allocated
  from client_credit_usage usage
  left join client_credit_usage_allocations allocations
    on allocations.usage_id = usage.id
  where usage.id = target_usage_id
  group by usage.id, usage.credits;

  if found and allocated <> charged then
    raise exception 'credit usage allocation total must equal the charged credits'
      using errcode = '23514', constraint = 'client_credit_usage_fully_allocated';
  end if;
end;
$$;

create or replace function assert_credit_lot_balance(target_lot_id uuid)
returns void
language plpgsql
as $$
declare
  granted bigint;
  remaining bigint;
  expires timestamptz;
  allocated bigint;
begin
  select lot.credits_granted,
         lot.credits_remaining,
         lot.expires_at,
         coalesce(sum(allocations.credits), 0)
    into granted, remaining, expires, allocated
  from client_credit_lots lot
  left join client_credit_usage_allocations allocations
    on allocations.credit_lot_id = lot.id
  where lot.id = target_lot_id
  group by lot.id, lot.credits_granted, lot.credits_remaining, lot.expires_at;

  if found and allocated + remaining > granted then
    raise exception 'credit lot allocations and remaining balance exceed granted credits'
      using errcode = '23514', constraint = 'client_credit_lot_not_overallocated';
  end if;

  if found and expires > transaction_timestamp() and allocated + remaining <> granted then
    raise exception 'unexpired credit lot balance must reconcile to granted credits'
      using errcode = '23514', constraint = 'client_credit_lot_reconciled';
  end if;
end;
$$;

create or replace function check_credit_usage_allocation_constraint()
returns trigger
language plpgsql
as $$
begin
  if tg_table_name = 'client_credit_usage_allocations' then
    if tg_op <> 'INSERT' then
      perform assert_credit_usage_fully_allocated(old.usage_id);
      perform assert_credit_lot_balance(old.credit_lot_id);
    end if;
    if tg_op <> 'DELETE' then
      perform assert_credit_usage_fully_allocated(new.usage_id);
      perform assert_credit_lot_balance(new.credit_lot_id);
    end if;
  elsif tg_table_name = 'client_credit_usage' then
    perform assert_credit_usage_fully_allocated(
      case when tg_op = 'DELETE' then old.id else new.id end
    );
  elsif tg_table_name = 'client_credit_lots' then
    perform assert_credit_lot_balance(
      case when tg_op = 'DELETE' then old.id else new.id end
    );
  end if;
  return null;
end;
$$;

drop trigger if exists client_credit_usage_allocation_constraint on client_credit_usage;
create constraint trigger client_credit_usage_allocation_constraint
after insert or update or delete on client_credit_usage
deferrable initially deferred
for each row execute function check_credit_usage_allocation_constraint();

drop trigger if exists client_credit_lot_balance_constraint on client_credit_lots;
create constraint trigger client_credit_lot_balance_constraint
after insert or update or delete on client_credit_lots
deferrable initially deferred
for each row execute function check_credit_usage_allocation_constraint();

drop trigger if exists client_credit_allocation_constraint on client_credit_usage_allocations;
create constraint trigger client_credit_allocation_constraint
after insert or update or delete on client_credit_usage_allocations
deferrable initially deferred
for each row execute function check_credit_usage_allocation_constraint();
