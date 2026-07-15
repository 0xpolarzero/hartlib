-- Recovery-deleted and purged identities cannot satisfy the last-admin
-- invariant. Ghost memberships retained only for immutable shared-content
-- foreign keys never authorize removal of the final live administrator.

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
      select 1
      from client_company_memberships membership
      join platform_users users
        on users.id = membership.user_id
       and users.recovery_deleted_at is null
       and users.purged_at is null
      where membership.company_id = old.company_id
        and membership.user_id <> old.user_id
        and membership.role = 'admin'
    ) then
      raise exception 'each client company must retain at least one live admin';
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
      select 1
      from publisher_company_memberships membership
      join platform_users users
        on users.id = membership.user_id
       and users.recovery_deleted_at is null
       and users.purged_at is null
      where membership.publisher_company_id = old.publisher_company_id
        and membership.user_id <> old.user_id
        and membership.role = 'admin'
    ) then
      raise exception 'each publisher company must retain at least one live admin';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
