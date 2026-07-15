-- Durable identity webhook idempotency and email-first workspace invitations.
-- Product roles and source grants remain authoritative in Postgres; Clerk only
-- authenticates the user and delivers/accepts the organization invitation.

create table if not exists clerk_webhook_events (
  webhook_event_id text primary key,
  event_type text not null,
  payload_sha256 text not null,
  processed_at timestamptz not null default now(),
  constraint clerk_webhook_events_id_nonempty check (btrim(webhook_event_id) <> ''),
  constraint clerk_webhook_events_hash check (payload_sha256 ~ '^[0-9a-f]{64}$')
);

create table if not exists workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_kind text not null,
  publisher_company_id uuid references publisher_companies (id) on delete cascade,
  client_company_id uuid references client_companies (id) on delete cascade,
  normalized_email text not null,
  role text not null,
  publisher_subscription_ids uuid[] not null default '{}',
  client_subscription_access_ids uuid[] not null default '{}',
  clerk_invitation_id text unique,
  state text not null default 'creating',
  invited_by_user_id text not null,
  accepted_user_id text,
  accepted_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_invitations_kind check (workspace_kind in ('publisher', 'client')),
  constraint workspace_invitations_company_shape check (
    (workspace_kind = 'publisher' and publisher_company_id is not null and client_company_id is null)
    or
    (workspace_kind = 'client' and client_company_id is not null and publisher_company_id is null)
  ),
  constraint workspace_invitations_email_normalized check (
    normalized_email = lower(btrim(normalized_email)) and btrim(normalized_email) <> ''
  ),
  constraint workspace_invitations_role_shape check (
    (workspace_kind = 'publisher' and role in ('admin', 'manager', 'member'))
    or
    (workspace_kind = 'client' and role in ('admin', 'member'))
  ),
  constraint workspace_invitations_grant_shape check (
    (workspace_kind = 'publisher' and cardinality(client_subscription_access_ids) = 0)
    or
    (workspace_kind = 'client' and cardinality(publisher_subscription_ids) = 0)
  ),
  constraint workspace_invitations_state check (
    state in ('creating', 'pending', 'accepted', 'revoked', 'failed')
  ),
  constraint workspace_invitations_acceptance_shape check (
    (state = 'accepted' and accepted_user_id is not null and accepted_at is not null)
    or
    (state <> 'accepted' and accepted_at is null)
  )
);

create unique index if not exists workspace_invitations_active_publisher_email_key
  on workspace_invitations (publisher_company_id, normalized_email)
  where publisher_company_id is not null and state in ('creating', 'pending');

create unique index if not exists workspace_invitations_active_client_email_key
  on workspace_invitations (client_company_id, normalized_email)
  where client_company_id is not null and state in ('creating', 'pending');

create index if not exists workspace_invitations_acceptance_idx
  on workspace_invitations (clerk_invitation_id, state);

create or replace function protect_workspace_invitation_acceptance()
returns trigger
language plpgsql
as $$
begin
  if old.state = 'accepted' and (
    new.state is distinct from old.state
    or new.accepted_user_id is distinct from old.accepted_user_id
    or new.accepted_at is distinct from old.accepted_at
    or new.normalized_email is distinct from old.normalized_email
    or new.role is distinct from old.role
    or new.publisher_company_id is distinct from old.publisher_company_id
    or new.client_company_id is distinct from old.client_company_id
    or new.publisher_subscription_ids is distinct from old.publisher_subscription_ids
    or new.client_subscription_access_ids is distinct from old.client_subscription_access_ids
  ) then
    raise exception 'accepted workspace invitations are immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists workspace_invitations_protect_accepted on workspace_invitations;
create trigger workspace_invitations_protect_accepted
before update on workspace_invitations
for each row execute function protect_workspace_invitation_acceptance();
