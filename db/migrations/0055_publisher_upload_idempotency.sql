-- Publisher PDF uploads are durable issue-scoped reservations.  The client
-- key and every authorization/content field are part of the immutable
-- reservation identity; provider retries reuse this row, document id, and
-- object key rather than allocating another upload.

alter table publisher_document_upload_intents
  add column if not exists idempotency_key text,
  add column if not exists title text,
  add column if not exists original_file_name text,
  add column if not exists media_type text,
  add column if not exists actor_organization_id text,
  add column if not exists actor_session_id text,
  add column if not exists actor_mode text,
  add column if not exists attempt integer,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists state text;

-- There is no safe legacy interpretation for an old intent: its content and
-- authorization envelope are not reconstructible.  Deployment therefore
-- fails closed instead of manufacturing an idempotency identity.
do $$
begin
  if exists (
    select 1 from publisher_document_upload_intents
    where idempotency_key is null
       or title is null
       or original_file_name is null
       or media_type is null
       or actor_session_id is null
       or actor_mode is null
       or attempt is null
       or lease_token is null
       or lease_expires_at is null
       or state is null
  ) then
    raise exception 'publisher upload intents contain unresolved legacy rows';
  end if;
end
$$;

alter table publisher_document_upload_intents
  alter column idempotency_key set not null,
  alter column title set not null,
  alter column original_file_name set not null,
  alter column media_type set not null,
  alter column actor_session_id set not null,
  alter column actor_mode set not null,
  alter column attempt set not null,
  alter column lease_token set not null,
  alter column lease_expires_at set not null,
  alter column state set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'publisher_document_upload_intents_key_shape') then
    alter table publisher_document_upload_intents add constraint publisher_document_upload_intents_key_shape
      check (idempotency_key ~ '^[A-Za-z0-9._:-]{16,200}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'publisher_document_upload_intents_title_shape') then
    alter table publisher_document_upload_intents add constraint publisher_document_upload_intents_title_shape
      check (length(title) between 1 and 300 and title = btrim(title));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'publisher_document_upload_intents_file_name_shape') then
    alter table publisher_document_upload_intents add constraint publisher_document_upload_intents_file_name_shape
      check (length(original_file_name) between 1 and 255 and original_file_name = btrim(original_file_name)
             and original_file_name !~ '[/\\\r\n]');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'publisher_document_upload_intents_media_type') then
    alter table publisher_document_upload_intents add constraint publisher_document_upload_intents_media_type
      check (media_type = 'application/pdf');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'publisher_document_upload_intents_org_shape') then
    alter table publisher_document_upload_intents add constraint publisher_document_upload_intents_org_shape
      check (actor_organization_id is null or length(actor_organization_id) between 1 and 255);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'publisher_document_upload_intents_session_shape') then
    alter table publisher_document_upload_intents add constraint publisher_document_upload_intents_session_shape
      check (length(actor_session_id) between 1 and 255);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'publisher_document_upload_intents_mode_shape') then
    alter table publisher_document_upload_intents add constraint publisher_document_upload_intents_mode_shape
      check (actor_mode in ('demo', 'clerk'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'publisher_document_upload_intents_attempt_shape') then
    alter table publisher_document_upload_intents add constraint publisher_document_upload_intents_attempt_shape
      check (attempt > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'publisher_document_upload_intents_state_shape') then
    alter table publisher_document_upload_intents add constraint publisher_document_upload_intents_state_shape
      check (state in ('processing', 'object_put', 'retryable', 'finalized'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'publisher_document_upload_intents_lease_shape') then
    alter table publisher_document_upload_intents add constraint publisher_document_upload_intents_lease_shape
      check (state = 'finalized' or lease_expires_at >= created_at);
  end if;
end
$$;

create unique index if not exists publisher_document_upload_intents_issue_key
  on publisher_document_upload_intents (issue_id, idempotency_key);

create index if not exists publisher_document_upload_intents_lease_idx
  on publisher_document_upload_intents (lease_expires_at, id);

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
     or new.attempt > old.attempt + 1 then
    raise exception 'publisher document upload reservation identity is immutable';
  end if;
  if (old.state = 'processing' and new.state not in ('processing', 'object_put', 'retryable'))
     or (old.state = 'object_put' and new.state not in ('processing', 'object_put', 'finalized'))
     or (old.state = 'retryable' and new.state <> 'processing') then
    raise exception 'publisher document upload state transition is invalid';
  end if;
  if old.state <> 'finalized' and new.state = 'finalized' then
    if not exists (
      select 1
      from brief_documents documents
      where documents.id = new.document_id
        and documents.issue_id = new.issue_id
        and documents.object_key = new.object_key
        and documents.title = new.title
        and documents.original_file_name = new.original_file_name
        and documents.media_type = new.media_type
        and documents.byte_size = new.byte_size
        and documents.sha256_hex = new.expected_sha256_hex
        and documents.created_by_user_id = new.actor_user_id
        and documents.upload_completed_at is not null
    ) then
      raise exception 'finalized publisher document upload requires its exact document';
    end if;
    if not exists (
      select 1 from publisher_document_upload_events events
      where events.operation_id = new.id and events.event_kind = 'object_put'
    ) or not exists (
      select 1 from publisher_document_upload_events events
      where events.operation_id = new.id and events.event_kind = 'finalized'
    ) then
      raise exception 'finalized publisher document upload requires durable events';
    end if;
    if not exists (
      select 1
      from platform_authorization_audit_log audit
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

drop trigger if exists publisher_document_upload_identity_immutable
  on publisher_document_upload_intents;
create trigger publisher_document_upload_identity_immutable
before insert or update on publisher_document_upload_intents
for each row execute function protect_publisher_document_upload_identity();

drop trigger if exists publisher_document_upload_intents_no_mutation
  on publisher_document_upload_intents;
drop trigger if exists publisher_document_upload_intents_no_delete
  on publisher_document_upload_intents;
create trigger publisher_document_upload_intents_no_delete
before delete on publisher_document_upload_intents
for each row execute function reject_publisher_document_upload_history_mutation();
