-- Restricted support and authorization auditing are security boundaries. Keep
-- their scope relationships enforceable for direct SQL writes and make the
-- operational audit trail content-free and tamper-evident.

create or replace function validate_restricted_support_grant()
returns trigger
language plpgsql
as $$
declare
  resolved_publisher_company_id uuid;
  resolved_client_company_id uuid;
  resolved_user_id text;
  grantor_role text;
begin
  if (new.customer_approval_reference is null)
     = (btrim(new.approval_skipped_reason) = '') then
    raise exception 'restricted support grant requires exactly one approval basis';
  end if;

  select role into grantor_role
  from platform_admins
  where user_id = new.granted_by_user_id;
  if grantor_role not in ('admin', 'security', 'legal') then
    raise exception 'restricted support grants require admin, security, or legal authority';
  end if;

  if new.scope_kind = 'publisher_file' then
    select subscriptions.publisher_company_id
      into resolved_publisher_company_id
    from brief_documents documents
    join publisher_issues issues on issues.id = documents.issue_id
    join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
    where documents.id::text = new.scope_id;
  elsif new.scope_kind = 'publisher_text' then
    select subscriptions.publisher_company_id
      into resolved_publisher_company_id
    from brief_document_versions versions
    join brief_documents documents on documents.id = versions.brief_document_id
    join publisher_issues issues on issues.id = documents.issue_id
    join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
    where versions.id::text = new.scope_id;
  elsif new.scope_kind = 'client_chat' then
    select chats.company_id, chats.user_id
      into resolved_client_company_id, resolved_user_id
    from chats
    where chats.id::text = new.scope_id;
  elsif new.scope_kind = 'client_memory' then
    select memberships.company_id, memories.user_id
      into resolved_client_company_id, resolved_user_id
    from user_memories memories
    join client_company_memberships memberships on memberships.user_id = memories.user_id
    where memories.id::text = new.scope_id
      and memberships.company_id = new.client_company_id;
  end if;

  if new.scope_kind in ('publisher_file', 'publisher_text') then
    if resolved_publisher_company_id is null
       or new.publisher_company_id is distinct from resolved_publisher_company_id
       or new.client_company_id is not null
       or new.affected_user_id is not null then
      raise exception 'restricted publisher support scope does not match its company';
    end if;
  elsif resolved_client_company_id is null
     or resolved_user_id is null
     or new.client_company_id is distinct from resolved_client_company_id
     or new.affected_user_id is distinct from resolved_user_id
     or new.publisher_company_id is not null then
    raise exception 'restricted client support scope does not match its company and user';
  end if;

  return new;
end;
$$;

drop trigger if exists restricted_support_grants_validate on restricted_support_grants;
create trigger restricted_support_grants_validate
before insert or update on restricted_support_grants
for each row execute function validate_restricted_support_grant();

create or replace function validate_restricted_support_access_log()
returns trigger
language plpgsql
as $$
declare
  grant_row restricted_support_grants%rowtype;
begin
  select * into grant_row
  from restricted_support_grants
  where id = new.grant_id;

  if not found
     or grant_row.actor_user_id is distinct from new.actor_user_id
     or grant_row.reason is distinct from new.reason
     or grant_row.scope_kind is distinct from new.scope_kind
     or grant_row.scope_id is distinct from new.scope_id
     or grant_row.publisher_company_id is distinct from new.publisher_company_id
     or grant_row.client_company_id is distinct from new.client_company_id
     or grant_row.affected_user_id is distinct from new.affected_user_id
     or grant_row.customer_approval_reference is distinct from new.customer_approval_reference
     or grant_row.approval_skipped_reason is distinct from new.approval_skipped_reason
     or grant_row.revoked_at is not null
     or grant_row.expires_at <= new.accessed_at
     or new.accessed_at < grant_row.granted_at then
    raise exception 'restricted support access must match an active exact grant';
  end if;
  return new;
end;
$$;

drop trigger if exists restricted_support_access_log_validate on restricted_support_access_log;
create trigger restricted_support_access_log_validate
before insert on restricted_support_access_log
for each row execute function validate_restricted_support_access_log();

alter table restricted_support_access_reviews
  add constraint restricted_support_access_reviews_reviewer_fkey
  foreign key (reviewer_user_id)
  references platform_admins (user_id)
  on delete restrict;

create or replace function validate_restricted_support_review()
returns trigger
language plpgsql
as $$
declare
  access_actor text;
begin
  select actor_user_id into access_actor
  from restricted_support_access_log
  where id = new.access_log_id;
  if access_actor = new.reviewer_user_id then
    raise exception 'restricted support access requires independent review';
  end if;
  return new;
end;
$$;

drop trigger if exists restricted_support_access_reviews_validate on restricted_support_access_reviews;
create trigger restricted_support_access_reviews_validate
before insert or update on restricted_support_access_reviews
for each row execute function validate_restricted_support_review();

create table if not exists platform_authorization_audit_log (
  id bigint generated always as identity primary key,
  actor_user_id text not null,
  session_id text not null,
  request_id uuid not null,
  action text not null,
  scope_kind text not null,
  scope_id text not null,
  outcome text not null,
  reason_code text,
  previous_hash bytea,
  entry_hash bytea not null,
  occurred_at timestamptz not null default now(),
  purge_after timestamptz not null default (now() + interval '24 months'),
  constraint platform_authorization_audit_actor_nonempty check (btrim(actor_user_id) <> ''),
  constraint platform_authorization_audit_session_nonempty check (btrim(session_id) <> ''),
  constraint platform_authorization_audit_action check (action ~ '^[a-z][a-z0-9_.]{1,127}$'),
  constraint platform_authorization_audit_scope_kind check (scope_kind ~ '^[a-z][a-z0-9_]{1,63}$'),
  constraint platform_authorization_audit_scope_id_nonempty check (btrim(scope_id) <> ''),
  constraint platform_authorization_audit_outcome check (outcome in ('succeeded', 'denied')),
  constraint platform_authorization_audit_reason check (
    reason_code is null or reason_code ~ '^[a-z][a-z0-9_]{1,127}$'
  )
);

create unique index if not exists platform_authorization_audit_request_action_key
  on platform_authorization_audit_log (request_id, action, scope_kind, scope_id);

create index if not exists platform_authorization_audit_retention_idx
  on platform_authorization_audit_log (purge_after, id);

create or replace function append_platform_authorization_audit_hash()
returns trigger
language plpgsql
as $$
declare
  prior_hash bytea;
begin
  perform pg_advisory_xact_lock(hashtext('brief:platform-authorization-audit-log'));
  new.purge_after := new.occurred_at + interval '24 months';
  select entry_hash into prior_hash
  from platform_authorization_audit_log
  order by id desc
  limit 1;
  new.previous_hash := prior_hash;
  new.entry_hash := digest(
    coalesce(encode(prior_hash, 'hex'), '') || '|' ||
    new.actor_user_id || '|' || new.session_id || '|' || new.request_id::text || '|' ||
    new.action || '|' || new.scope_kind || '|' || new.scope_id || '|' ||
    new.outcome || '|' || coalesce(new.reason_code, '') || '|' || new.occurred_at::text,
    'sha256'
  );
  return new;
end;
$$;

drop trigger if exists platform_authorization_audit_hash on platform_authorization_audit_log;
create trigger platform_authorization_audit_hash
before insert on platform_authorization_audit_log
for each row execute function append_platform_authorization_audit_hash();

create or replace function reject_platform_authorization_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('brief.allow_audit_retention_purge', true) = 'on'
     and old.purge_after <= now() then
    return old;
  end if;
  raise exception 'platform authorization audit log is append-only until retention expiry';
end;
$$;

drop trigger if exists platform_authorization_audit_no_mutation on platform_authorization_audit_log;
create trigger platform_authorization_audit_no_mutation
before update or delete on platform_authorization_audit_log
for each row execute function reject_platform_authorization_audit_mutation();
