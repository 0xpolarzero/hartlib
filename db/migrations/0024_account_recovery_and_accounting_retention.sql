-- Permanent-deletion tombstones prevent restored backups or replayed identity
-- events from resurrecting purged users/companies. Accounting metadata is
-- content-free after processing and cannot be removed before ten years.

alter table platform_users add column if not exists purged_at timestamptz;
alter table client_companies add column if not exists purged_at timestamptz;

create table if not exists identity_deletion_tombstones (
  clerk_user_id text primary key,
  platform_user_id text not null,
  purged_at timestamptz not null default now(),
  constraint identity_deletion_tombstones_ids check (
    btrim(clerk_user_id) <> '' and btrim(platform_user_id) <> ''
  )
);

create table if not exists client_company_deletion_tombstones (
  client_company_id uuid primary key,
  purged_at timestamptz not null default now()
);

alter table client_ai_billing_accounts add column if not exists retained_until timestamptz;
alter table client_credit_lots add column if not exists retained_until timestamptz;
alter table client_credit_usage add column if not exists retained_until timestamptz;
alter table stripe_webhook_events add column if not exists retained_until timestamptz;

update client_ai_billing_accounts
set retained_until = updated_at + interval '10 years'
where retained_until is null;
update client_credit_lots
set retained_until = created_at + interval '10 years'
where retained_until is null;
update client_credit_usage
set retained_until = created_at + interval '10 years'
where retained_until is null;
update stripe_webhook_events
set retained_until = received_at + interval '10 years'
where retained_until is null;

alter table client_ai_billing_accounts alter column retained_until set not null;
alter table client_credit_lots alter column retained_until set not null;
alter table client_credit_usage alter column retained_until set not null;
alter table stripe_webhook_events alter column retained_until set not null;

alter table client_ai_billing_accounts
  alter column retained_until set default (now() + interval '10 years');
alter table client_credit_lots
  alter column retained_until set default (now() + interval '10 years');
alter table client_credit_usage
  alter column retained_until set default (now() + interval '10 years');
alter table stripe_webhook_events
  alter column retained_until set default (now() + interval '10 years');

create or replace function maintain_billing_account_retention()
returns trigger
language plpgsql
as $$
begin
  new.retained_until := greatest(
    coalesce(new.retained_until, '-infinity'::timestamptz),
    now() + interval '10 years'
  );
  return new;
end;
$$;

drop trigger if exists client_ai_billing_accounts_retention on client_ai_billing_accounts;
create trigger client_ai_billing_accounts_retention
before insert or update on client_ai_billing_accounts
for each row execute function maintain_billing_account_retention();

create or replace function protect_ten_year_accounting_record()
returns trigger
language plpgsql
as $$
begin
  if current_setting('brief.allow_accounting_retention_purge', true) = 'on'
     and old.retained_until <= now() then
    return old;
  end if;
  raise exception 'billing/accounting records are retained for ten years';
end;
$$;

drop trigger if exists client_ai_billing_accounts_ten_year_retention on client_ai_billing_accounts;
create trigger client_ai_billing_accounts_ten_year_retention
before delete on client_ai_billing_accounts
for each row execute function protect_ten_year_accounting_record();

drop trigger if exists client_credit_lots_ten_year_retention on client_credit_lots;
create trigger client_credit_lots_ten_year_retention
before delete on client_credit_lots
for each row execute function protect_ten_year_accounting_record();

drop trigger if exists client_credit_usage_ten_year_retention on client_credit_usage;
create trigger client_credit_usage_ten_year_retention
before delete on client_credit_usage
for each row execute function protect_ten_year_accounting_record();

drop trigger if exists stripe_webhook_events_ten_year_retention on stripe_webhook_events;
create trigger stripe_webhook_events_ten_year_retention
before delete on stripe_webhook_events
for each row execute function protect_ten_year_accounting_record();

create or replace function protect_last_company_admin()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from client_companies company where company.id = old.company_id
  ) then
    return old;
  end if;
  if current_setting('brief.allow_account_purge', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin') then
    if not exists (
      select 1 from client_company_memberships membership
      where membership.company_id = old.company_id
        and membership.user_id <> old.user_id
        and membership.role = 'admin'
    ) then
      raise exception 'each client company must retain at least one admin';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function protect_last_publisher_admin()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from publisher_companies company where company.id = old.publisher_company_id
  ) then
    return old;
  end if;
  if current_setting('brief.allow_account_purge', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin') then
    if not exists (
      select 1 from publisher_company_memberships membership
      where membership.publisher_company_id = old.publisher_company_id
        and membership.user_id <> old.user_id
        and membership.role = 'admin'
    ) then
      raise exception 'each publisher company must retain at least one admin';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
