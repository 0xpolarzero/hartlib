-- Upload cleanup evidence belongs to one durable attempt.  A historical
-- object_deleted event must not suppress cleanup for a later PUT/retry of the
-- same idempotency reservation.

alter table publisher_document_upload_events
  add column if not exists attempt integer;

update publisher_document_upload_events events
set attempt = intents.attempt
from publisher_document_upload_intents intents
where intents.id = events.operation_id
  and events.attempt is null;

alter table publisher_document_upload_events
  alter column attempt set default 1,
  alter column attempt set not null;

alter table publisher_document_upload_events
  drop constraint if exists publisher_document_upload_events_operation_id_event_kind_key;

alter table publisher_document_upload_events
  add constraint publisher_document_upload_events_attempt_shape check (attempt > 0);

create unique index if not exists publisher_document_upload_events_attempt_kind
  on publisher_document_upload_events (operation_id, attempt, event_kind);

create or replace function protect_publisher_document_upload_event_attempt()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from publisher_document_upload_intents intents
    where intents.id = new.operation_id
      and new.attempt = intents.attempt
  ) then
    raise exception 'publisher upload evidence attempt is not current';
  end if;
  return new;
end
$$;

drop trigger if exists publisher_document_upload_event_attempt
  on publisher_document_upload_events;
create trigger publisher_document_upload_event_attempt
before insert on publisher_document_upload_events
for each row execute function protect_publisher_document_upload_event_attempt();

-- Rebind terminal-event validation to the current attempt and make the lease
-- token an owner fence (stable while renewing; replaced exactly with the next
-- attempt).
create or replace function protect_publisher_document_upload_identity()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'processing' or new.attempt <> 1 then
      raise exception 'publisher document upload reservation must begin processing';
    end if;
    return new;
  end if;
  if old.idempotency_key is distinct from new.idempotency_key
     or old.document_id is distinct from new.document_id
     or old.issue_id is distinct from new.issue_id
     or old.object_key is distinct from new.object_key
     or old.expected_sha256_hex is distinct from new.expected_sha256_hex
     or old.byte_size is distinct from new.byte_size
     or old.actor_user_id is distinct from new.actor_user_id
     or old.actor_organization_id is distinct from new.actor_organization_id
     or old.actor_session_id is distinct from new.actor_session_id
     or old.actor_mode is distinct from new.actor_mode
     or old.title is distinct from new.title
     or old.original_file_name is distinct from new.original_file_name
     or old.media_type is distinct from new.media_type
     or old.request_id is distinct from new.request_id
     or old.created_at is distinct from new.created_at
     or new.attempt < old.attempt
     or new.attempt > old.attempt + 1
     or (new.attempt = old.attempt and new.lease_token is distinct from old.lease_token)
     or (new.attempt = old.attempt + 1 and new.lease_token is not distinct from old.lease_token) then
    raise exception 'publisher document upload reservation identity is immutable';
  end if;
  if (old.state = 'processing' and new.state not in ('processing', 'object_put', 'retryable'))
     or (old.state = 'object_put' and new.state not in ('processing', 'object_put', 'finalized'))
     or (old.state = 'retryable' and new.state <> 'processing') then
    raise exception 'publisher document upload state transition is invalid';
  end if;
  if old.state <> 'finalized' and new.state = 'finalized' then
    if not exists (
      select 1 from brief_documents documents
      where documents.id = new.document_id and documents.issue_id = new.issue_id
        and documents.object_key = new.object_key and documents.title = new.title
        and documents.original_file_name = new.original_file_name
        and documents.media_type = new.media_type and documents.byte_size = new.byte_size
        and documents.sha256_hex = new.expected_sha256_hex
        and documents.created_by_user_id = new.actor_user_id
        and documents.upload_completed_at is not null
    ) then
      raise exception 'finalized publisher document upload requires its exact document';
    end if;
    if not exists (
      select 1 from publisher_document_upload_events events
      where events.operation_id = new.id and events.attempt = new.attempt
        and events.event_kind = 'object_put'
    ) or not exists (
      select 1 from publisher_document_upload_events events
      where events.operation_id = new.id and events.attempt = new.attempt
        and events.event_kind = 'finalized'
    ) then
      raise exception 'finalized publisher document upload requires durable events';
    end if;
    if not exists (
      select 1 from platform_authorization_audit_log audit
      where audit.request_id = new.request_id
        and audit.action = 'publisher.document.upload'
        and audit.scope_kind = 'brief_document'
        and audit.scope_id = new.document_id::text
        and audit.outcome = 'succeeded'
    ) then
      raise exception 'finalized publisher document upload requires its authorization audit';
    end if;
  end if;
  if old.state = 'finalized' and (
       new.state <> 'finalized'
       or new.attempt is distinct from old.attempt
       or new.lease_token is distinct from old.lease_token
       or new.lease_expires_at is distinct from old.lease_expires_at
       or new.reconcile_after is distinct from old.reconcile_after
     ) then
    raise exception 'finalized publisher document upload is terminal';
  end if;
  return new;
end
$$;
