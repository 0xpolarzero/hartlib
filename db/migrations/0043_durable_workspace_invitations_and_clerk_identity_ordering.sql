-- Workspace invitations cross a transactional Postgres/provider boundary. Keep the
-- local invitation identity stable while a delivery is in doubt, lease one provider
-- attempt at a time, and make every terminal transition release active uniqueness.
-- Clerk user lifecycle projection is ordered independently from delivery order so an
-- older upsert can never resurrect a user after a newer deletion.

alter table workspace_invitations
  drop constraint if exists workspace_invitations_state;

alter table workspace_invitations
  drop constraint if exists workspace_invitations_acceptance_shape;

alter table workspace_invitations
  add constraint workspace_invitations_state check (
    state in ('creating', 'pending', 'accepted', 'revoked', 'expired', 'failed')
  ),
  add constraint workspace_invitations_acceptance_shape check (
    (state = 'accepted' and accepted_user_id is not null and accepted_at is not null)
    or
    (state <> 'accepted' and accepted_user_id is null and accepted_at is null)
  ),
  add column if not exists delivery_attempt_count integer not null default 0,
  add column if not exists delivery_lease_token uuid,
  add column if not exists delivery_lease_expires_at timestamptz,
  add column if not exists delivery_last_attempt_at timestamptz,
  add column if not exists delivery_last_error_code text;

alter table workspace_invitations
  add constraint workspace_invitations_delivery_attempt_count_nonnegative
    check (delivery_attempt_count >= 0),
  add constraint workspace_invitations_delivery_lease_shape check (
    (delivery_lease_token is null and delivery_lease_expires_at is null)
    or
    (
      delivery_lease_token is not null
      and delivery_lease_expires_at is not null
      and state = 'creating'
    )
  ),
  add constraint workspace_invitations_delivery_error_bounded check (
    delivery_last_error_code is null
    or (
      btrim(delivery_last_error_code) <> ''
      and length(delivery_last_error_code) <= 120
      and delivery_last_error_code ~ '^[a-z0-9_:-]+$'
    )
  ),
  add constraint workspace_invitations_provider_shape check (
    state not in ('pending', 'accepted')
    or (
      clerk_invitation_id is not null
      and btrim(clerk_invitation_id) <> ''
      and expires_at is not null
    )
  );

create or replace function protect_workspace_invitation_lifecycle()
returns trigger
language plpgsql
as $$
declare
  transition_allowed boolean;
begin
  if new.workspace_kind is distinct from old.workspace_kind
     or new.publisher_company_id is distinct from old.publisher_company_id
     or new.client_company_id is distinct from old.client_company_id
     or new.normalized_email is distinct from old.normalized_email
     or new.role is distinct from old.role
     or new.publisher_subscription_ids is distinct from old.publisher_subscription_ids
     or new.client_subscription_access_ids is distinct from old.client_subscription_access_ids
     or new.invited_by_user_id is distinct from old.invited_by_user_id
     or new.created_at is distinct from old.created_at then
    raise exception 'workspace invitation identity is immutable';
  end if;

  if old.clerk_invitation_id is not null
     and new.clerk_invitation_id is distinct from old.clerk_invitation_id then
    raise exception 'workspace invitation provider identity is immutable';
  end if;
  if old.expires_at is not null and new.expires_at is distinct from old.expires_at then
    raise exception 'workspace invitation expiry is immutable after reconciliation';
  end if;
  if new.delivery_attempt_count < old.delivery_attempt_count then
    raise exception 'workspace invitation delivery attempts are monotonic';
  end if;

  transition_allowed := new.state = old.state
    or (
      old.state = 'creating'
      and new.state in ('pending', 'accepted', 'revoked', 'expired', 'failed')
    )
    or (old.state = 'pending' and new.state in ('accepted', 'revoked', 'expired'));
  if not transition_allowed then
    raise exception 'invalid workspace invitation state transition: % -> %', old.state, new.state;
  end if;

  if old.state = 'accepted' and (
    new.accepted_user_id is distinct from old.accepted_user_id
    or new.accepted_at is distinct from old.accepted_at
  ) then
    raise exception 'accepted workspace invitations are immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists workspace_invitations_protect_accepted on workspace_invitations;
drop trigger if exists workspace_invitations_protect_lifecycle on workspace_invitations;
create trigger workspace_invitations_protect_lifecycle
before update on workspace_invitations
for each row execute function protect_workspace_invitation_lifecycle();

-- An insert is also a re-invite boundary. Expire the matching pending row in the
-- same statement transaction before the partial active-identity index is checked.
create or replace function expire_prior_workspace_invitation_before_insert()
returns trigger
language plpgsql
as $$
begin
  if new.state = 'pending' and new.expires_at <= now() then
    new.state := 'expired';
  end if;
  if new.state in ('creating', 'pending') then
    update workspace_invitations
    set state = 'expired', updated_at = now()
    where state = 'pending'
      and expires_at <= now()
      and normalized_email = new.normalized_email
      and publisher_company_id is not distinct from new.publisher_company_id
      and client_company_id is not distinct from new.client_company_id;
  end if;
  return new;
end;
$$;

drop trigger if exists workspace_invitations_expire_before_insert on workspace_invitations;
create trigger workspace_invitations_expire_before_insert
before insert on workspace_invitations
for each row execute function expire_prior_workspace_invitation_before_insert();

-- A recoverably deleted client company cannot retain an accept-capable invitation.
create or replace function revoke_client_workspace_invitations_on_deletion()
returns trigger
language plpgsql
as $$
begin
  if old.recovery_deleted_at is null and new.recovery_deleted_at is not null then
    update workspace_invitations
    set state = 'revoked', delivery_lease_token = null,
        delivery_lease_expires_at = null, updated_at = now()
    where client_company_id = new.id and state in ('creating', 'pending');
  end if;
  return new;
end;
$$;

drop trigger if exists client_companies_revoke_workspace_invitations on client_companies;
create trigger client_companies_revoke_workspace_invitations
after update of recovery_deleted_at on client_companies
for each row execute function revoke_client_workspace_invitations_on_deletion();

-- Resource profile versions and lifecycle events have different ordering rules.
-- `user.updated` may advance the profile but is never an explicit restore. Only a
-- newer `user.created` event may move a deleted lifecycle back to active.
alter table platform_users
  add column if not exists clerk_profile_version bigint,
  add column if not exists clerk_profile_event_kind text,
  add column if not exists clerk_profile_event_id text,
  add column if not exists clerk_recovery_deleted_at timestamptz;

alter table platform_users
  add constraint platform_users_clerk_profile_version_nonnegative check (
    clerk_profile_version is null or clerk_profile_version >= 0
  ),
  add constraint platform_users_clerk_profile_event_kind check (
    clerk_profile_event_kind is null
    or clerk_profile_event_kind in ('user.created', 'user.updated')
  ),
  add constraint platform_users_clerk_profile_event_shape check (
    (
      clerk_profile_version is null
      and clerk_profile_event_kind is null
      and clerk_profile_event_id is null
    )
    or
    (
      clerk_profile_version is not null
      and clerk_profile_event_kind is not null
      and clerk_profile_event_id is not null
      and btrim(clerk_profile_event_id) <> ''
    )
  );

create table if not exists clerk_user_lifecycle_state (
  clerk_user_id text primary key,
  state text not null,
  event_timestamp bigint not null,
  event_kind text not null,
  event_id text not null,
  updated_at timestamptz not null default now(),
  constraint clerk_user_lifecycle_user_nonempty check (btrim(clerk_user_id) <> ''),
  constraint clerk_user_lifecycle_state_value check (state in ('active', 'deleted')),
  constraint clerk_user_lifecycle_event_kind check (
    event_kind in ('user.created', 'user.updated', 'user.deleted')
  ),
  constraint clerk_user_lifecycle_timestamp_nonnegative check (event_timestamp >= 0),
  constraint clerk_user_lifecycle_event_id_nonempty check (btrim(event_id) <> ''),
  constraint clerk_user_lifecycle_state_matches_event check (
    (state = 'deleted' and event_kind = 'user.deleted')
    or
    (state = 'active' and event_kind in ('user.created', 'user.updated'))
  )
);

create or replace function clerk_user_event_rank(event_kind text)
returns integer
language sql
immutable
strict
as $$
  select case event_kind
    when 'user.deleted' then 3
    when 'user.created' then 2
    when 'user.updated' then 1
    else 0
  end
$$;

create or replace function protect_clerk_user_lifecycle_order()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Clerk user lifecycle projection is retained';
  end if;
  if new.clerk_user_id is distinct from old.clerk_user_id then
    raise exception 'Clerk user lifecycle identity is immutable';
  end if;
  if new.event_timestamp < old.event_timestamp
     or (
       new.event_timestamp = old.event_timestamp
       and clerk_user_event_rank(new.event_kind) < clerk_user_event_rank(old.event_kind)
     )
     or (
       new.event_timestamp = old.event_timestamp
       and clerk_user_event_rank(new.event_kind) = clerk_user_event_rank(old.event_kind)
       and new.event_id <= old.event_id
     ) then
    raise exception 'Clerk user lifecycle events must advance deterministically';
  end if;
  if old.state = 'deleted' and new.event_kind = 'user.updated' then
    raise exception 'user.updated cannot restore a deleted Clerk lifecycle';
  end if;
  return new;
end;
$$;

drop trigger if exists clerk_user_lifecycle_order on clerk_user_lifecycle_state;
create trigger clerk_user_lifecycle_order
before update or delete on clerk_user_lifecycle_state
for each row execute function protect_clerk_user_lifecycle_order();

create or replace function clerk_user_profile_event_rank(event_kind text)
returns integer
language sql
immutable
strict
as $$
  select case event_kind
    when 'user.updated' then 2
    when 'user.created' then 1
    else 0
  end
$$;

create or replace function protect_platform_user_clerk_profile_order()
returns trigger
language plpgsql
as $$
begin
  if old.clerk_profile_version is not null and (
    new.clerk_profile_version is null
    or new.clerk_profile_version < old.clerk_profile_version
    or (
      new.clerk_profile_version = old.clerk_profile_version
      and clerk_user_profile_event_rank(new.clerk_profile_event_kind)
        < clerk_user_profile_event_rank(old.clerk_profile_event_kind)
    )
    or (
      new.clerk_profile_version = old.clerk_profile_version
      and clerk_user_profile_event_rank(new.clerk_profile_event_kind)
        = clerk_user_profile_event_rank(old.clerk_profile_event_kind)
      and new.clerk_profile_event_id < old.clerk_profile_event_id
    )
  ) then
    raise exception 'Clerk profile versions are monotonic';
  end if;
  return new;
end;
$$;

drop trigger if exists platform_users_clerk_profile_order on platform_users;
create trigger platform_users_clerk_profile_order
before update on platform_users
for each row execute function protect_platform_user_clerk_profile_order();

-- Membership identity is retained because chats, accounting settings, notifications,
-- and other durable records reference it. Product removal revokes access atomically;
-- physical deletion is reserved for the existing account-purge transaction.
alter table client_company_memberships
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by_user_id text;

alter table client_company_memberships
  add constraint client_company_memberships_revocation_shape check (
    (revoked_at is null and revoked_by_user_id is null)
    or
    (revoked_at is not null and revoked_by_user_id is not null)
  );

create index if not exists client_company_memberships_active_user_idx
  on client_company_memberships (user_id, company_id)
  where revoked_at is null;

create or replace function protect_retained_client_membership()
returns trigger
language plpgsql
as $$
begin
  if current_setting('brief.allow_account_purge', true) = 'on' then
    return old;
  end if;
  raise exception 'client membership identity is retained; revoke it instead';
end;
$$;

drop trigger if exists client_company_memberships_retained on client_company_memberships;
create trigger client_company_memberships_retained
before delete on client_company_memberships
for each row execute function protect_retained_client_membership();

create or replace function protect_last_company_admin()
returns trigger
language plpgsql
as $$
begin
  if current_setting('brief.allow_account_purge', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if old.role = 'admin'
     and old.revoked_at is null
     and (
       tg_op = 'DELETE'
       or new.role <> 'admin'
       or new.revoked_at is not null
     )
     and not exists (
       select 1
       from client_company_memberships membership
       join platform_users users on users.id = membership.user_id
       where membership.company_id = old.company_id
         and membership.user_id <> old.user_id
         and membership.role = 'admin'
         and membership.revoked_at is null
         and users.recovery_deleted_at is null
         and users.purged_at is null
     ) then
    raise exception 'each client company must retain at least one live admin';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists client_company_memberships_last_admin on client_company_memberships;
create trigger client_company_memberships_last_admin
before update of role, revoked_at or delete on client_company_memberships
for each row execute function protect_last_company_admin();
