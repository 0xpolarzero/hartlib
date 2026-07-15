-- Preserve the exact verified Stripe bytes and close SQL three-valued-logic
-- loopholes in the restricted-support approval basis.

alter table stripe_webhook_events
  add column if not exists signed_payload text;

-- Historical rows predate exact-payload retention. Their canonical JSON is
-- the only recoverable representation; all new rows store the signed text.
update stripe_webhook_events
set signed_payload = payload::text
where signed_payload is null;

alter table stripe_webhook_events
  alter column signed_payload set not null;

alter table stripe_webhook_events
  drop constraint if exists stripe_webhook_events_signed_payload_nonempty;
alter table stripe_webhook_events
  add constraint stripe_webhook_events_signed_payload_nonempty
  check (octet_length(signed_payload) between 1 and 1048576);

create or replace function enforce_stripe_webhook_signed_payload_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.stripe_event_id is distinct from old.stripe_event_id
     or new.event_type is distinct from old.event_type
     or new.payload is distinct from old.payload
     or new.signed_payload is distinct from old.signed_payload
     or new.received_at is distinct from old.received_at then
    raise exception 'stripe webhook signed event is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists stripe_webhook_signed_payload_immutable on stripe_webhook_events;
create trigger stripe_webhook_signed_payload_immutable
before update on stripe_webhook_events
for each row execute function enforce_stripe_webhook_signed_payload_immutable();

update restricted_support_grants
set approval_skipped_reason = null
where customer_approval_reference is not null
  and btrim(coalesce(approval_skipped_reason, '')) = '';

alter table restricted_support_grants
  drop constraint if exists restricted_support_grants_approval;
alter table restricted_support_grants
  add constraint restricted_support_grants_approval check (
    (
      customer_approval_reference is not null
      and btrim(customer_approval_reference) <> ''
      and approval_skipped_reason is null
    )
    or
    (
      customer_approval_reference is null
      and approval_skipped_reason is not null
      and btrim(approval_skipped_reason) <> ''
    )
  );

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
  if not (
    (
      new.customer_approval_reference is not null
      and btrim(new.customer_approval_reference) <> ''
      and new.approval_skipped_reason is null
    )
    or
    (
      new.customer_approval_reference is null
      and new.approval_skipped_reason is not null
      and btrim(new.approval_skipped_reason) <> ''
    )
  ) then
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
    join client_companies companies on companies.id = chats.company_id
    where chats.id::text = new.scope_id
      and chats.deleted_at is null
      and companies.recovery_deleted_at is null;
  elsif new.scope_kind = 'client_memory' then
    select memberships.company_id, memories.user_id
      into resolved_client_company_id, resolved_user_id
    from user_memories memories
    join client_company_memberships memberships on memberships.user_id = memories.user_id
    join client_companies companies on companies.id = memberships.company_id
    where memories.id::text = new.scope_id
      and memberships.company_id = new.client_company_id
      and companies.recovery_deleted_at is null;
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
