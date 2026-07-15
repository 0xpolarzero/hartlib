create table if not exists publisher_document_upload_intents (
  id uuid primary key,
  document_id uuid not null unique,
  issue_id uuid not null,
  object_key text not null unique,
  expected_sha256_hex text not null,
  byte_size bigint not null,
  actor_user_id text not null,
  request_id uuid not null,
  created_at timestamptz not null default now(),
  reconcile_after timestamptz not null default (now() + interval '15 minutes'),
  constraint publisher_document_upload_intents_object_key_nonempty
    check (btrim(object_key) <> ''),
  constraint publisher_document_upload_intents_sha256
    check (expected_sha256_hex ~ '^[0-9a-f]{64}$'),
  constraint publisher_document_upload_intents_bytes_positive check (byte_size > 0),
  constraint publisher_document_upload_intents_actor_nonempty
    check (btrim(actor_user_id) <> ''),
  constraint publisher_document_upload_intents_reconcile_window
    check (reconcile_after >= created_at)
);

create index if not exists publisher_document_upload_intents_reconcile_idx
  on publisher_document_upload_intents (reconcile_after, id);

create table if not exists publisher_document_upload_events (
  id bigint generated always as identity primary key,
  operation_id uuid not null
    references publisher_document_upload_intents (id) on delete restrict,
  event_kind text not null,
  error_code text,
  created_at timestamptz not null default now(),
  unique (operation_id, event_kind),
  constraint publisher_document_upload_events_kind check (
    event_kind in ('object_put', 'finalized', 'cleanup_required', 'object_deleted')
  ),
  constraint publisher_document_upload_events_error_shape check (
    (event_kind = 'cleanup_required' and error_code ~ '^[a-z][a-z0-9_]{1,127}$')
    or (event_kind <> 'cleanup_required' and error_code is null)
  )
);

create or replace function reject_publisher_document_upload_history_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'publisher document upload history is append-only';
end
$$;

drop trigger if exists publisher_document_upload_intents_no_mutation
  on publisher_document_upload_intents;
create trigger publisher_document_upload_intents_no_mutation
before update or delete on publisher_document_upload_intents
for each row execute function reject_publisher_document_upload_history_mutation();

drop trigger if exists publisher_document_upload_events_no_mutation
  on publisher_document_upload_events;
create trigger publisher_document_upload_events_no_mutation
before update or delete on publisher_document_upload_events
for each row execute function reject_publisher_document_upload_history_mutation();
