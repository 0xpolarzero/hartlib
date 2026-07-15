-- Forward fixes and job-owned state for the canonical MVP platform pipeline.

alter table assistant_message_sources
  drop constraint if exists assistant_message_sources_document_version_id_fkey,
  drop constraint if exists assistant_message_sources_typed_identity_valid,
  add column if not exists publisher_document_version_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'assistant_message_sources_publisher_document_version_fkey'
  ) then
    alter table assistant_message_sources
      add constraint assistant_message_sources_publisher_document_version_fkey
      foreign key (publisher_document_version_id)
      references brief_document_versions (id)
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'assistant_message_sources_typed_identity_valid'
  ) then
    alter table assistant_message_sources
      add constraint assistant_message_sources_typed_identity_valid
      check (
        (
          kind = 'document'
          and document_version_id is not null
          and message_id is null
          and memory_revision_id is null
          and (
            publisher_document_version_id is null
            or publisher_document_version_id::text = document_version_id
          )
        )
        or
        (
          kind = 'chat_message'
          and document_version_id is null
          and publisher_document_version_id is null
          and message_id is not null
          and memory_revision_id is null
        )
        or
        (
          kind = 'memory'
          and document_version_id is null
          and publisher_document_version_id is null
          and message_id is null
          and memory_revision_id is not null
        )
        or
        (
          kind = 'web'
          and document_version_id is null
          and publisher_document_version_id is null
          and message_id is null
          and memory_revision_id is null
        )
      );
  end if;
end
$$;

create index if not exists assistant_message_sources_publisher_document_version_idx
  on assistant_message_sources (publisher_document_version_id)
  where publisher_document_version_id is not null;

create or replace function validate_assistant_document_source_identity()
returns trigger
language plpgsql
as $$
begin
  if new.kind = 'document'
     and new.publisher_document_version_id is null
     and not exists (
       select 1 from public_source_documents documents
       where documents.document_id = new.document_version_id
     ) then
    raise exception 'document source must reference an existing immutable document version';
  end if;
  return new;
end;
$$;

drop trigger if exists assistant_message_sources_validate_document on assistant_message_sources;
create trigger assistant_message_sources_validate_document
before insert or update of kind, document_version_id, publisher_document_version_id
on assistant_message_sources
for each row execute function validate_assistant_document_source_identity();

create or replace function protect_referenced_public_source_document()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from assistant_message_sources sources
    where sources.kind = 'document'
      and sources.publisher_document_version_id is null
      and sources.document_version_id = old.document_id
  ) then
    raise exception 'answer-referenced public document versions cannot be deleted';
  end if;
  return old;
end;
$$;

drop trigger if exists public_source_documents_protect_answer_reference on public_source_documents;
create trigger public_source_documents_protect_answer_reference
before delete on public_source_documents
for each row execute function protect_referenced_public_source_document();

create table if not exists brief_document_extractions (
  id uuid primary key default gen_random_uuid(),
  brief_document_id uuid not null references brief_documents (id) on delete restrict,
  input_sha256_hex text not null,
  pages jsonb not null,
  extracted_char_count integer not null,
  created_by_job_id uuid not null references jobs (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (brief_document_id, input_sha256_hex),
  unique (created_by_job_id),
  constraint brief_document_extractions_hash check (input_sha256_hex ~ '^[0-9a-f]{64}$'),
  constraint brief_document_extractions_pages check (
    jsonb_typeof(pages) = 'array'
    and jsonb_array_length(pages) > 0
  ),
  constraint brief_document_extractions_char_count check (extracted_char_count > 0)
);

create index if not exists brief_document_extractions_document_idx
  on brief_document_extractions (brief_document_id, created_at desc);

create or replace function validate_brief_document_extraction_pages()
returns trigger
language plpgsql
as $$
declare
  page_count integer;
  distinct_page_count integer;
  canonical_char_count integer;
begin
  if not exists (
    select 1 from brief_documents documents
    where documents.id = new.brief_document_id
      and documents.sha256_hex = new.input_sha256_hex
  ) then
    raise exception 'PDF extraction hash must match the stored publisher file';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(new.pages) page
    where jsonb_typeof(page) <> 'object'
       or jsonb_typeof(page->'pageNumber') <> 'number'
       or (page->>'pageNumber')::numeric <= 0
       or mod((page->>'pageNumber')::numeric, 1) <> 0
       or jsonb_typeof(page->'text') <> 'string'
       or btrim(page->>'text') = ''
  ) then
    raise exception 'PDF extraction pages must contain positive integer page numbers and non-empty text';
  end if;

  select
    count(*),
    count(distinct page->>'pageNumber'),
    coalesce(sum(char_length(page->>'text')), 0) + 2 * greatest(count(*) - 1, 0)
  into page_count, distinct_page_count, canonical_char_count
  from jsonb_array_elements(new.pages) page;
  if page_count <> distinct_page_count then
    raise exception 'PDF extraction page numbers must be unique';
  end if;
  if canonical_char_count <> new.extracted_char_count then
    raise exception 'PDF extraction character count must match canonical page text';
  end if;
  return new;
end;
$$;

drop trigger if exists brief_document_extractions_validate_pages on brief_document_extractions;
create trigger brief_document_extractions_validate_pages
before insert on brief_document_extractions
for each row execute function validate_brief_document_extraction_pages();

create or replace function validate_brief_document_version_ranges()
returns trigger
language plpgsql
as $$
begin
  if jsonb_array_length(new.page_ranges) = 0 or exists (
    select 1
    from jsonb_array_elements(new.page_ranges) range_row
    where jsonb_typeof(range_row) <> 'object'
       or jsonb_typeof(range_row->'pageNumber') <> 'number'
       or mod((range_row->>'pageNumber')::numeric, 1) <> 0
       or (range_row->>'pageNumber')::numeric <= 0
       or jsonb_typeof(range_row->'charStart') <> 'number'
       or mod((range_row->>'charStart')::numeric, 1) <> 0
       or (range_row->>'charStart')::numeric < 0
       or jsonb_typeof(range_row->'charEnd') <> 'number'
       or mod((range_row->>'charEnd')::numeric, 1) <> 0
       or (range_row->>'charEnd')::numeric <= (range_row->>'charStart')::numeric
       or (range_row->>'charEnd')::numeric > char_length(new.canonical_text)
  ) then
    raise exception 'document version page ranges have invalid page or character coordinates';
  end if;

  if exists (
    with ranges as (
      select
        ordinality,
        (range_row->>'pageNumber')::integer as page_number,
        (range_row->>'charStart')::integer as char_start,
        (range_row->>'charEnd')::integer as char_end
      from jsonb_array_elements(new.page_ranges) with ordinality as rows(range_row, ordinality)
    ), compared as (
      select *,
        lag(page_number) over (order by ordinality) as previous_page_number,
        lag(char_end) over (order by ordinality) as previous_char_end
      from ranges
    )
    select 1
    from compared
    where (ordinality = 1 and char_start <> 0)
       or (previous_page_number is not null and page_number <= previous_page_number)
       or (previous_char_end is not null and char_start <> previous_char_end + 2)
  ) then
    raise exception 'document version page ranges must be ordered and match canonical separators';
  end if;
  return new;
end;
$$;

drop trigger if exists brief_document_versions_validate_ranges on brief_document_versions;
create trigger brief_document_versions_validate_ranges
before insert on brief_document_versions
for each row execute function validate_brief_document_version_ranges();

create or replace function reject_brief_document_extraction_mutation()
returns trigger
language plpgsql
as $$
begin
  if current_setting('brief.allow_file_purge', true) = 'on' then
    return old;
  end if;
  raise exception 'successful PDF extraction outcomes are immutable';
end;
$$;

drop trigger if exists brief_document_extractions_no_mutation on brief_document_extractions;
create trigger brief_document_extractions_no_mutation
before update or delete on brief_document_extractions
for each row execute function reject_brief_document_extraction_mutation();

create or replace function protect_published_brief_document_delete()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from publisher_issues issues
    where issues.id = old.issue_id and issues.status = 'published'
  ) then
    raise exception 'published brief documents are immutable';
  end if;
  return old;
end;
$$;

drop trigger if exists brief_documents_protect_published_delete on brief_documents;
create trigger brief_documents_protect_published_delete
before delete on brief_documents
for each row execute function protect_published_brief_document_delete();

alter table brief_documents
  add column if not exists language text not null default 'fr-FR',
  add column if not exists deleted_by_user_id text,
  add column if not exists purge_after timestamptz,
  add column if not exists legal_hold boolean not null default false,
  add column if not exists indexing_error_code text;

update brief_documents
set deleted_by_user_id = coalesce(deleted_by_user_id, created_by_user_id),
    purge_after = coalesce(purge_after, deleted_at + interval '30 days')
where deleted_at is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'brief_documents_deletion_shape'
  ) then
    alter table brief_documents
      add constraint brief_documents_deletion_shape check (
        (
          deleted_at is null
          and deleted_by_user_id is null
          and purge_after is null
        )
        or
        (
          deleted_at is not null
          and deleted_by_user_id is not null
          and purge_after >= deleted_at
          and purge_after <= deleted_at + interval '30 days'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'brief_documents_language_nonempty'
  ) then
    alter table brief_documents
      add constraint brief_documents_language_nonempty check (btrim(language) <> '');
  end if;
end
$$;

create index if not exists brief_documents_purge_idx
  on brief_documents (purge_after, id)
  where deleted_at is not null and legal_hold = false;

-- Legal-hold placement/release and retention purge take the same scope lock.
-- This closes the otherwise unavoidable race where a purge observes no active
-- hold immediately before a concurrent transaction creates one.
create or replace function serialize_legal_hold_scope()
returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('brief:legal-hold:' || new.scope_kind || ':' || new.scope_id, 0)
  );
  return new;
end;
$$;

drop trigger if exists legal_holds_serialize_scope on legal_holds;
create trigger legal_holds_serialize_scope
before insert or update of scope_kind, scope_id, released_at on legal_holds
for each row execute function serialize_legal_hold_scope();

create table if not exists deleted_chat_tombstones (
  chat_id uuid primary key,
  client_company_id uuid not null,
  creator_user_id text not null,
  subscription_source_ids uuid[] not null default '{}',
  deleted_at timestamptz not null,
  deleted_by_user_id text not null,
  purged_at timestamptz not null default now(),
  terminal_error_codes text[] not null default '{}',
  model_input_tokens bigint not null default 0,
  model_output_tokens bigint not null default 0,
  model_request_count bigint not null default 0,
  web_search_count bigint not null default 0,
  web_fetch_count bigint not null default 0,
  exposed_item_count bigint not null default 0,
  constraint deleted_chat_tombstones_counts_nonnegative check (
    model_input_tokens >= 0
    and model_output_tokens >= 0
    and model_request_count >= 0
    and web_search_count >= 0
    and web_fetch_count >= 0
    and exposed_item_count >= 0
  )
);

create index if not exists deleted_chat_tombstones_company_idx
  on deleted_chat_tombstones (client_company_id, purged_at desc);

create table if not exists purged_brief_document_tombstones (
  brief_document_id uuid primary key,
  issue_id uuid not null,
  publisher_company_id uuid not null,
  sha256_hex text not null,
  byte_size bigint not null,
  deleted_at timestamptz not null,
  deleted_by_user_id text not null,
  purged_at timestamptz not null default now(),
  constraint purged_brief_document_tombstones_hash check (sha256_hex ~ '^[0-9a-f]{64}$'),
  constraint purged_brief_document_tombstones_size check (byte_size > 0)
);

create index if not exists purged_brief_document_tombstones_publisher_idx
  on purged_brief_document_tombstones (publisher_company_id, purged_at desc);

alter table client_credit_usage
  drop constraint if exists client_credit_usage_ai_run_id_fkey,
  alter column ai_run_id drop not null;

alter table client_credit_usage
  add constraint client_credit_usage_ai_run_id_fkey
  foreign key (ai_run_id)
  references ai_runs (id)
  on delete set null;

alter table export_requests
  add column if not exists authorization_snapshot jsonb,
  add column if not exists idempotency_key text;

update export_requests
set authorization_snapshot = coalesce(authorization_snapshot, '{}'::jsonb),
    idempotency_key = coalesce(idempotency_key, 'backfill:export:' || id::text);

alter table export_requests
  alter column authorization_snapshot set not null,
  alter column idempotency_key set not null,
  drop constraint if exists export_requests_result_shape;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'export_requests_authorization_snapshot_object'
  ) then
    alter table export_requests
      add constraint export_requests_authorization_snapshot_object
      check (jsonb_typeof(authorization_snapshot) = 'object');
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'export_requests_result_shape'
  ) then
    alter table export_requests
      add constraint export_requests_result_shape check (
        (
          status = 'completed'
          and object_key is not null
          and completed_at is not null
          and expires_at is not null
          and expires_at > completed_at
          and error_code is null
        )
        or
        (
          status = 'failed'
          and object_key is null
          and completed_at is not null
          and expires_at is null
          and error_code is not null
        )
        or
        (
          status in ('queued', 'running')
          and object_key is null
          and completed_at is null
          and expires_at is null
          and error_code is null
        )
      );
  end if;
end
$$;

create unique index if not exists export_requests_idempotency_key
  on export_requests (idempotency_key);

create index if not exists export_requests_requester_scope_idx
  on export_requests (requester_user_id, scope_kind, scope_id, created_at desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'email_notification_deliveries_attempts_nonnegative'
  ) then
    alter table email_notification_deliveries
      add constraint email_notification_deliveries_attempts_nonnegative
      check (attempts >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'email_notification_deliveries_sent_shape'
  ) then
    alter table email_notification_deliveries
      add constraint email_notification_deliveries_sent_shape
      check (
        (
          status = 'sent'
          and sent_at is not null
          and provider_message_id is not null
          and last_error_code is null
        )
        or
        (
          status <> 'sent'
          and sent_at is null
          and provider_message_id is null
        )
      );
  end if;
end
$$;

create or replace function reject_issue_delivery_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'published issue deliveries are immutable';
end;
$$;

drop trigger if exists issue_deliveries_no_mutation on issue_deliveries;
create trigger issue_deliveries_no_mutation
before update or delete on issue_deliveries
for each row execute function reject_issue_delivery_mutation();

create or replace function reject_brief_document_version_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and current_setting('brief.allow_file_purge', true) = 'on' then
    return old;
  end if;
  raise exception 'brief document versions are immutable';
end;
$$;
