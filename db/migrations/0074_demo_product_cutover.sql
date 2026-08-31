-- Destructive demo-product cutover.
--
-- The preceding migrations describe the retired multi-chat and platform
-- product.  This migration deliberately removes those rows and objects and
-- creates the one-visitor demo model consumed by the API and worker.  The
-- migration is not a compatibility bridge: no old chat, session, archive, or
-- citation identity survives it.

begin;

-- Keep citation tags out of the assistant search vector and evidence hashes.
-- The preceding compaction migration owns this helper in a fresh install, but
-- the destructive cutover also runs against upgraded databases where that
-- helper may have been removed with an obsolete dependent object.
create or replace function brief_ai_strip_historical_citation_tags(input text)
returns text
language plpgsql
immutable
strict
parallel safe
as $$
declare
  cursor_position integer := 1;
  marker_start integer;
  marker_end integer;
  result text := '';
  remainder text;
begin
  loop
    marker_start := strpos(substring(input from cursor_position), '[[cite:');
    if marker_start = 0 then
      return result || substring(input from cursor_position);
    end if;
    marker_start := cursor_position + marker_start - 1;
    result := result || substring(input from cursor_position for marker_start - cursor_position);
    remainder := substring(input from marker_start + 7);
    marker_end := strpos(remainder, ']]');
    if marker_end = 0 then
      return result;
    end if;
    cursor_position := marker_start + 7 + marker_end + 1;
  end loop;
end
$$;

create or replace function brief_ai_safe_bigint(p_value text)
returns bigint
language plpgsql
immutable
strict
as $$
begin
  if p_value !~ '^[0-9]+$'
    or length(p_value) > 19
    or p_value::numeric > 9223372036854775807::numeric then
    return null;
  end if;
  return p_value::bigint;
exception when others then
  return null;
end
$$;

create or replace function brief_ai_utf16_length(p_value text)
returns integer
language plpgsql
immutable
strict
as $$
declare
  bytes bytea := convert_to(p_value, 'UTF8');
  index integer := 0;
  units integer := 0;
  first_byte integer;
begin
  while index < octet_length(bytes) loop
    first_byte := get_byte(bytes, index);
    if first_byte < 128 then
      index := index + 1;
      units := units + 1;
    elsif first_byte < 224 then
      index := index + 2;
      units := units + 1;
    elsif first_byte < 240 then
      index := index + 3;
      units := units + 1;
    else
      index := index + 4;
      units := units + 2;
    end if;
  end loop;
  return units;
end
$$;

create or replace function brief_ai_utf16_boundary(input text, p_offset bigint)
returns boolean
language plpgsql
immutable
strict
as $$
declare
  position integer;
  consumed bigint := 0;
  codepoint integer;
begin
  if p_offset < 0 or p_offset > brief_ai_utf16_length(input) then
    return false;
  end if;
  if p_offset = 0 or p_offset = brief_ai_utf16_length(input) then
    return true;
  end if;
  for position in 1..char_length(input) loop
    codepoint := ascii(substring(input from position for 1));
    consumed := consumed + case when codepoint > 65535 then 2 else 1 end;
    if consumed = p_offset then
      return true;
    end if;
    if consumed > p_offset then
      return false;
    end if;
  end loop;
  return false;
end
$$;

create or replace function brief_valid_chat_exposure_ranges(ranges jsonb)
returns boolean
language plpgsql
immutable
strict
as $$
declare
  item jsonb;
  start_value bigint;
  end_value bigint;
  previous_end bigint;
begin
  if jsonb_typeof(ranges) <> 'array' or jsonb_array_length(ranges) = 0 then
    return false;
  end if;
  for item in select value from jsonb_array_elements(ranges) loop
    if jsonb_typeof(item) is distinct from 'object'
       or exists (select 1 from jsonb_object_keys(item) key where key not in ('charStart', 'charEnd'))
       or item->>'charStart' !~ '^[0-9]+$'
       or item->>'charEnd' !~ '^[0-9]+$' then
      return false;
    end if;
    start_value := brief_ai_safe_bigint(item->>'charStart');
    end_value := brief_ai_safe_bigint(item->>'charEnd');
    if start_value is null or end_value is null
       or start_value < 0 or end_value <= start_value
       or (previous_end is not null and start_value <= previous_end) then
      return false;
    end if;
    previous_end := end_value;
  end loop;
  return true;
end
$$;

create or replace function brief_valid_document_exposure_ranges(ranges jsonb)
returns boolean
language plpgsql
immutable
strict
as $$
declare
  item jsonb;
  char_start bigint;
  char_end bigint;
  previous_end bigint;
begin
  if jsonb_typeof(ranges) <> 'array' or jsonb_array_length(ranges) = 0 then
    return false;
  end if;
  for item in select value from jsonb_array_elements(ranges) loop
    if jsonb_typeof(item) is distinct from 'object'
      or (item - 'charStart' - 'charEnd') <> '{}'::jsonb
      or jsonb_typeof(item->'charStart') is distinct from 'number'
      or jsonb_typeof(item->'charEnd') is distinct from 'number'
      or brief_ai_safe_bigint(item->>'charStart') is null
      or brief_ai_safe_bigint(item->>'charEnd') is null then
      return false;
    end if;
    char_start := brief_ai_safe_bigint(item->>'charStart');
    char_end := brief_ai_safe_bigint(item->>'charEnd');
    if char_end <= char_start
      or (previous_end is not null and char_start <= previous_end) then
      return false;
    end if;
    previous_end := char_end;
  end loop;
  return true;
end
$$;

create or replace function brief_public_source_https_url_allowed(candidate text)
returns boolean
language sql
immutable
strict
parallel safe
as $$
  select candidate = btrim(candidate)
    and candidate !~ '[[:cntrl:]]'
    and candidate ~ '^https://(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:[/?#]|$)'
    and candidate !~* '^https://[^/?#]*\.(?:local|localhost|localdomain|internal|corp|lan|home|home\.arpa)(?:[/?#]|$)'
$$;

create or replace function reject_ai_evaluation_runtime_evidence_mutation()
returns trigger
language plpgsql
as $$
declare
  evaluation_bound boolean;
begin
  select exists (
    select 1 from ai_evaluation_case_runs where ai_run_id = old.run_id
  ) into evaluation_bound;
  if tg_op = 'UPDATE' and not evaluation_bound then
    select exists (
      select 1 from ai_evaluation_case_runs where ai_run_id = new.run_id
    ) into evaluation_bound;
  end if;
  if evaluation_bound then
    raise exception 'canonical AI evaluation runtime evidence is append-only'
      using errcode = '23514',
            constraint = 'ai_evaluation_runtime_evidence_append_only',
            detail = tg_table_name;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create or replace function preserve_ai_run_usage_provider_service()
returns trigger
language plpgsql
as $$
begin
  if new.provider_service_id is distinct from old.provider_service_id then
    raise exception 'AI provider provenance is immutable'
      using errcode = '23514', constraint = 'ai_run_usage_provider_service_immutable';
  end if;
  return new;
end
$$;

create or replace function validate_ai_source_exposure_document_identity()
returns trigger
language plpgsql
as $$
begin
  if new.source_kind <> 'document' then
    return new;
  end if;
  if new.document_source_id is null
     or not brief_ai_valid_document_source_id(new.document_source_id)
     or new.document_id is null
     or new.snapshot_id is null
     or new.content_hash is null
     or new.document_source_id !~ '^public:' then
    raise exception 'document exposure source identity is not canonical';
  end if;
  if not exists (
    select 1
    from public_source_documents documents
    where documents.document_id = new.document_id
      and documents.document_id = new.snapshot_id
      and documents.content_hash = new.content_hash
      and ('public:' || documents.source_id) = new.document_source_id
  ) then
    raise exception 'public exposure is not bound to the exact immutable document';
  end if;
  return new;
end
$$;

create or replace function validate_ai_source_exposure_ranges()
returns trigger
language plpgsql
as $$
declare
  text_length integer;
begin
  if new.source_kind <> 'document' then
    return new;
  end if;
  if not brief_valid_document_exposure_ranges(new.document_ranges) then
    raise exception 'document exposure ranges must be normalized and non-empty';
  end if;
  select brief_ai_utf16_length(documents.text) into text_length
  from public_source_documents documents
  where documents.document_id = new.document_id
    and documents.document_id = new.snapshot_id
    and ('public:' || documents.source_id) = new.document_source_id
    and documents.content_hash = new.content_hash;
  if text_length is null or exists (
    select 1 from jsonb_array_elements(new.document_ranges) range_row
    where brief_ai_safe_bigint(range_row->>'charStart') is null
       or brief_ai_safe_bigint(range_row->>'charEnd') is null
       or brief_ai_safe_bigint(range_row->>'charEnd') > text_length
  ) then
    raise exception 'document exposure range is outside the immutable text';
  end if;
  return new;
end
$$;

-- AI evidence accepts public source identities only.  Publisher documents
-- remain available through their authenticated read path, but never enter the
-- chat retrieval or citation ledger.
create or replace function brief_ai_valid_document_source_id(p_value text)
returns boolean
language sql
immutable
strict
as $$
  select p_value ~ '^public:[^:]+$'
    and not exists (
      select 1
      from generate_series(1, char_length(p_value)) positions(position)
      where ascii(substr(p_value, positions.position, 1)) in (9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279)
        or ascii(substr(p_value, positions.position, 1)) between 8192 and 8202
    )
$$;

-- Remove rows before changing foreign-key shapes.  CASCADE also clears the
-- retained evaluation rows that point at the pre-cutover runtime rows.
-- Queue rows do not have a foreign key to ai_runs, so clear every queued or
-- running pre-cutover chat job explicitly before dropping those run rows.
delete from jobs where kind = 'ai_chat_run';
truncate table
  chats,
  ai_runs,
  chat_messages,
  user_memories,
  user_memory_revisions,
  assistant_message_source_uses,
  assistant_message_sources,
  ai_run_events,
  ai_observations,
  ai_source_exposures,
  ai_run_usage,
  ai_external_tool_usage,
  ai_smithers_orphan_candidates
restart identity cascade;

-- These tables have no place in the cutover product.  Drop dependents first
-- through CASCADE so stale triggers, views, and indexes cannot keep an old
-- identity graph alive.
drop table if exists
  chat_subscription_sources,
  deleted_chat_tombstones,
  clerk_user_lifecycle_state,
  clerk_webhook_events,
  client_ai_billing_accounts,
  client_ai_checkout_requests,
  client_ai_plan_change_requests,
  client_ai_usage_requests,
  client_company_deletion_tombstones,
  client_credit_lots,
  client_credit_usage,
  client_credit_usage_allocations,
  client_employee_ai_limits,
  company_deletion_requests,
  email_notification_deliveries,
  export_object_generations,
  export_requests,
  identity_deletion_tombstones,
  legal_holds,
  notification_preferences,
  platform_admins,
  platform_notifications,
  publisher_document_upload_events,
  publisher_document_upload_intents,
  purged_hartlib_document_tombstones,
  purged_publisher_issue_tombstones,
  restricted_support_access_log,
  restricted_support_access_reviews,
  restricted_support_grants,
  stripe_webhook_events,
  workspace_invitations
cascade;

-- The demo user and company retain only fields needed by the product and
-- publisher document authorization.  The old account-lifecycle columns are
-- intentionally gone rather than treated as inactive compatibility rows.
alter table if exists platform_users drop column if exists clerk_user_id cascade;
alter table if exists platform_users drop column if exists mfa_required cascade;
alter table if exists platform_users drop column if exists recovery_deleted_at cascade;
alter table if exists platform_users drop column if exists purge_after cascade;
alter table if exists platform_users drop column if exists legal_hold cascade;
alter table if exists platform_users drop column if exists purged_at cascade;
alter table if exists platform_users drop column if exists clerk_profile_version cascade;
alter table if exists platform_users drop column if exists clerk_profile_event_kind cascade;
alter table if exists platform_users drop column if exists clerk_profile_event_id cascade;
alter table if exists platform_users drop column if exists clerk_recovery_deleted_at cascade;

alter table if exists client_companies drop column if exists clerk_organization_id cascade;
alter table if exists client_companies drop column if exists legal_name cascade;
alter table if exists client_companies drop column if exists billing_country cascade;
alter table if exists client_companies drop column if exists billing_address cascade;
alter table if exists client_companies drop column if exists vat_id cascade;
alter table if exists client_companies drop column if exists stripe_customer_id cascade;
alter table if exists client_companies drop column if exists deletion_requested_at cascade;
alter table if exists client_companies drop column if exists recovery_deleted_at cascade;
alter table if exists client_companies drop column if exists purge_after cascade;
alter table if exists client_companies drop column if exists legal_hold cascade;
alter table if exists client_companies drop column if exists purged_at cascade;

drop trigger if exists platform_users_clerk_profile_order on platform_users;
drop function if exists protect_platform_user_clerk_profile_order() cascade;
drop function if exists clerk_user_profile_event_rank(text) cascade;
drop trigger if exists platform_authorization_audit_hold_scope_snapshot on platform_authorization_audit_log;
drop function if exists snapshot_platform_authorization_audit_hold_scopes() cascade;
-- Account purge is the only lifecycle operation that may remove audit rows
-- for the visitor it owns.
create or replace function reject_platform_authorization_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('hartlib.allow_account_purge', true) = 'on' then
    return old;
  end if;
  raise exception 'platform authorization audit log is append-only until retention expiry';
end;
$$;

create or replace function protect_last_company_admin()
returns trigger
language plpgsql
as $$
begin
  if current_setting('hartlib.allow_account_purge', true) = 'on' then
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
       where membership.company_id = old.company_id
         and membership.user_id <> old.user_id
         and membership.role = 'admin'
         and membership.revoked_at is null
     ) then
    raise exception 'each client company must retain at least one live admin';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- The final purge worker uses one namespaced transaction setting.  Rebuild
-- every retained identity guard that older migrations keyed to the retired
-- `brief.allow_account_purge` setting so the cutover has one delete authority.
create or replace function protect_retained_client_membership()
returns trigger
language plpgsql
as $$
begin
  if current_setting('hartlib.allow_account_purge', true) = 'on' then
    return old;
  end if;
  raise exception 'client membership identity is retained; revoke it instead';
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
  if current_setting('hartlib.allow_account_purge', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin') then
    if not exists (
      select 1
      from publisher_company_memberships membership
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

create or replace function reject_issue_delivery_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('hartlib.allow_account_purge', true) = 'on' then
    return old;
  end if;

  raise exception 'published issue deliveries are immutable';
end;
$$;

create or replace function protect_issue_delivery_recipient()
returns trigger language plpgsql as $$
declare
  delivery_row issue_deliveries%rowtype;
begin
  if tg_op = 'DELETE' then
    if current_setting('hartlib.allow_account_purge', true) = 'on' then
      return old;
    end if;
    raise exception 'issue delivery recipients are immutable'
      using errcode = '23514', constraint = 'issue_delivery_recipients_immutable';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'issue delivery recipients are immutable'
      using errcode = '23514', constraint = 'issue_delivery_recipients_immutable';
  end if;

  if current_setting(
       format('brief.delivery_snapshot.x%s', md5(new.issue_id::text || ':' || new.client_company_id::text)),
       true
     ) is distinct from 'on' then
    raise exception 'issue delivery recipient requires the atomic delivery transaction'
      using errcode = '23514', constraint = 'issue_delivery_recipients_delivery';
  end if;

  select * into delivery_row
  from issue_deliveries deliveries
  where deliveries.issue_id = new.issue_id
    and deliveries.client_company_id = new.client_company_id;
  if not found then
    raise exception 'issue delivery recipient requires its exact delivery'
      using errcode = '23514', constraint = 'issue_delivery_recipients_delivery';
  end if;
  if new.delivered_at is distinct from delivery_row.delivered_at then
    raise exception 'issue delivery recipient timestamp must match its delivery'
      using errcode = '23514', constraint = 'issue_delivery_recipients_timestamp';
  end if;
  if not exists (
    select 1
    from client_employee_subscription_grants grants
    join client_company_memberships memberships
      on memberships.company_id = grants.client_company_id
     and memberships.user_id = grants.user_id
    where grants.access_id = delivery_row.access_id
      and grants.client_company_id = delivery_row.client_company_id
      and grants.user_id = new.user_id
      and grants.granted_at <= delivery_row.delivered_at
      and (grants.revoked_at is null or grants.revoked_at > delivery_row.delivered_at)
      and memberships.created_at <= delivery_row.delivered_at
      and (memberships.revoked_at is null or memberships.revoked_at > delivery_row.delivered_at)
  ) then
    raise exception 'issue delivery recipient was not entitled at delivery time'
      using errcode = '23514', constraint = 'issue_delivery_recipients_entitlement';
  end if;
  return new;
end;
$$;

drop trigger if exists client_company_memberships_retained on client_company_memberships;
create trigger client_company_memberships_retained
before delete on client_company_memberships
for each row execute function protect_retained_client_membership();

drop trigger if exists publisher_company_memberships_last_admin on publisher_company_memberships;
create trigger publisher_company_memberships_last_admin
before delete on publisher_company_memberships
for each row execute function protect_last_publisher_admin();

drop trigger if exists issue_deliveries_no_mutation on issue_deliveries;
create trigger issue_deliveries_no_mutation
before update or delete on issue_deliveries
for each row execute function reject_issue_delivery_mutation();

drop trigger if exists issue_delivery_recipients_immutable on issue_delivery_recipients;
create trigger issue_delivery_recipients_immutable
before insert or update or delete on issue_delivery_recipients
for each row execute function protect_issue_delivery_recipient();

-- The one-chat schema is rebuilt to make the absence of archive, sharing, and
-- deletion states structural rather than a convention in application code.
drop table if exists ai_run_events, ai_observations, ai_run_usage, ai_external_tool_usage, ai_runs cascade;
drop table if exists chats cascade;
create table chats (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  company_id uuid not null references client_companies (id) on delete cascade,
  memory_mode text not null default 'private_owner',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chats_memory_mode_valid check (memory_mode in ('private_owner', 'disabled')),
  constraint chats_creator_membership_fkey foreign key (company_id, user_id)
    references client_company_memberships (company_id, user_id)
);
create unique index chats_one_per_user_key on chats (user_id);

drop table if exists chat_messages cascade;
create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references chats (id) on delete cascade,
  author text not null,
  content text not null,
  assistant_ai_run_id uuid,
  created_at timestamptz not null default now(),
  search_vector tsvector generated always as (
    to_tsvector(
      'simple'::regconfig,
      case when author = 'assistant' then
        brief_ai_strip_historical_citation_tags(content)
      else content end
    )
  ) stored,
  constraint chat_messages_author_valid check (author in ('user', 'assistant'))
);
create index chat_messages_chat_idx on chat_messages (chat_id, created_at, id);
create unique index chat_messages_assistant_ai_run_key on chat_messages (assistant_ai_run_id)
  where assistant_ai_run_id is not null;
create index chat_messages_search_vector_idx on chat_messages using gin (search_vector);

-- Rebuild runs after the message table exists.  Both visible-message links are
-- nullable and set null so deleting one visible row never erases evidence.
drop table if exists ai_source_exposures cascade;
drop table if exists ai_runs cascade;
create table ai_runs (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references chats (id) on delete cascade,
  initiating_user_id text not null,
  user_message_id uuid references chat_messages (id) on delete set null,
  assistant_message_id uuid references chat_messages (id) on delete set null,
  smithers_run_id text,
  locale text not null,
  market text not null,
  usage jsonb not null default '{}'::jsonb,
  error text,
  error_code text,
  retryable boolean,
  citation_nonce bytea not null default gen_random_bytes(16),
  citation_namespace text not null,
  acceptance_scope jsonb not null,
  next_event_seq integer not null default 1,
  web_search_enabled boolean not null default false,
  effective_web_policy jsonb not null default '{"enabled":false,"reason":"deployment_unavailable","allowlistActive":false}'::jsonb,
  stop_requested_at timestamptz,
  stopped_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  failed_at timestamptz,
  constraint ai_runs_citation_nonce_128_bit check (octet_length(citation_nonce) = 16),
  constraint ai_runs_next_event_seq_positive check (next_event_seq >= 1),
  constraint ai_runs_citation_namespace_shape check (citation_namespace ~ '^cn_[A-Za-z0-9_-]{22}$'),
  constraint ai_runs_terminal_shape check (num_nonnulls(finished_at, failed_at, stopped_at, superseded_at) <= 1),
  constraint ai_runs_failure_shape_valid check (
    (failed_at is null and error_code is null and retryable is null)
    or (failed_at is not null and error_code is not null and retryable is not null)
  )
);
create unique index ai_runs_active_chat_key on ai_runs (chat_id)
  where finished_at is null and failed_at is null and stopped_at is null and superseded_at is null;
create unique index ai_runs_user_message_key on ai_runs (user_message_id)
  where user_message_id is not null
    and finished_at is null and failed_at is null and stopped_at is null and superseded_at is null;
create unique index ai_runs_assistant_message_key on ai_runs (assistant_message_id)
  where assistant_message_id is not null;
create unique index ai_runs_citation_namespace_key on ai_runs (citation_namespace);
create unique index ai_runs_smithers_run_key on ai_runs (smithers_run_id)
  where smithers_run_id is not null;
create index ai_runs_user_message_idx on ai_runs (user_message_id);
create index ai_runs_assistant_message_idx on ai_runs (assistant_message_id);

-- Source exposures are retained run evidence.  Recreate the table after the
-- run rebuild so the destructive drop above cannot leave a missing or
-- assistant-message-owned evidence relation behind.
create table ai_source_exposures (
  id bigint generated always as identity primary key,
  run_id uuid not null references ai_runs (id) on delete cascade,
  task_id text not null,
  loop_iteration integer not null,
  attempt integer not null,
  provider_request_index integer not null,
  source_kind text not null,
  logical_source_identity text not null,
  content_item_identity text not null,
  exposure_stage text not null,
  visible_token_count integer not null,
  created_at timestamptz not null default now(),
  document_source_id text,
  document_id text,
  document_ranges jsonb,
  snapshot_id text,
  content_hash text,
  chat_content_hash text,
  chat_ranges jsonb,
  constraint ai_source_exposures_coordinates_nonnegative
    check (
      loop_iteration >= 0
      and attempt >= 0
      and provider_request_index >= 0
      and visible_token_count >= 0
    ),
  constraint ai_source_exposures_source_kind_valid
    check (source_kind in ('document', 'chat_message', 'memory', 'web')),
  constraint ai_source_exposures_identity_nonempty
    check (
      btrim(task_id) <> ''
      and btrim(logical_source_identity) <> ''
      and btrim(content_item_identity) <> ''
      and btrim(exposure_stage) <> ''
    ),
  constraint ai_source_exposures_chat_reconstruction_consistent
    check (
      (
        source_kind = 'chat_message'
        and chat_content_hash is not null
        and chat_ranges is not null
        and chat_content_hash ~ '^[0-9a-f]{64}$'
        and brief_valid_chat_exposure_ranges(chat_ranges)
      )
      or (
        source_kind <> 'chat_message'
        and chat_content_hash is null
        and chat_ranges is null
      )
    ),
  constraint ai_source_exposures_final_document_identity
    check (
      (
        source_kind <> 'document'
        and exposure_stage <> 'internal_search_preview'
        and snapshot_id is null
        and content_hash is null
        and document_source_id is null
        and document_id is null
        and document_ranges is null
      )
      or (
        source_kind = 'document'
        and snapshot_id is not null
        and content_hash is not null
        and content_hash ~ '^[0-9a-f]{64}$'
        and document_source_id is not null
        and brief_ai_valid_document_source_id(document_source_id)
        and document_id is not null
        and document_ranges is not null
        and brief_valid_document_exposure_ranges(document_ranges)
        and document_source_id like 'public:%'
      )
    ),
  unique (
    run_id,
    task_id,
    loop_iteration,
    attempt,
    provider_request_index,
    exposure_stage,
    content_item_identity
  )
);
create index ai_source_exposures_run_item_idx
  on ai_source_exposures (run_id, source_kind, content_item_identity);
-- Recreate chat exposure validation without the retired compatibility branch.
-- Every cutover row must prove its run-owned message, normalized text hash, and
-- UTF-16 range boundaries at write time.
create or replace function enforce_ai_chat_source_exposure()
returns trigger
language plpgsql
as $$
declare
  base_identity text;
  message_row record;
  sanitized text;
  item jsonb;
  start_value bigint;
  end_value bigint;
  previous_end bigint;
begin
  if new.source_kind <> 'chat_message' then
    if new.chat_content_hash is not null or new.chat_ranges is not null then
      raise exception 'non-chat source exposure cannot carry chat reconstruction fields'
        using errcode = '23514', constraint = 'ai_source_exposures_chat_reconstruction_consistent';
    end if;
    return new;
  end if;

  if new.chat_content_hash is null or new.chat_ranges is null then
    raise exception 'chat source exposure requires content hash and ranges'
      using errcode = '23514', constraint = 'ai_source_exposures_chat_reconstruction_consistent';
  end if;

  base_identity := regexp_replace(new.content_item_identity, '#proof=[0-9a-f]{64}$', '');
  if new.logical_source_identity is distinct from 'chat_message:' || base_identity
     or base_identity !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'chat source exposure identity is not canonical'
      using errcode = '23514', constraint = 'ai_source_exposures_chat_reconstruction_consistent';
  end if;

  select messages.chat_id, messages.author, messages.content
    into message_row
    from ai_runs runs
    join chat_messages messages
      on messages.id::text = base_identity
     and messages.chat_id = runs.chat_id
   where runs.id = new.run_id;
  if not found then
    raise exception 'chat source exposure message is not bound to its same-run chat'
      using errcode = '23514', constraint = 'ai_source_exposures_chat_reconstruction_consistent';
  end if;

  sanitized := case when message_row.author = 'assistant' then
    brief_ai_strip_historical_citation_tags(message_row.content)
    else message_row.content end;
  if new.chat_content_hash is distinct from encode(digest(convert_to(sanitized, 'UTF8'), 'sha256'), 'hex') then
    raise exception 'chat source exposure hash does not match citation-sanitized message text'
      using errcode = '23514', constraint = 'ai_source_exposures_chat_reconstruction_consistent';
  end if;
  if jsonb_typeof(new.chat_ranges) is distinct from 'array'
     or jsonb_array_length(new.chat_ranges) = 0 then
    raise exception 'chat source exposure ranges must be non-empty'
      using errcode = '23514', constraint = 'ai_source_exposures_chat_reconstruction_consistent';
  end if;

  previous_end := null;
  for item in select value from jsonb_array_elements(new.chat_ranges) loop
    if jsonb_typeof(item) is distinct from 'object'
       or exists (select 1 from jsonb_object_keys(item) key where key not in ('charStart', 'charEnd'))
       or item->>'charStart' !~ '^[0-9]+$'
       or item->>'charEnd' !~ '^[0-9]+$' then
      raise exception 'chat source exposure ranges have invalid syntax'
        using errcode = '23514', constraint = 'ai_source_exposures_chat_reconstruction_consistent';
    end if;
    start_value := brief_ai_safe_bigint(item->>'charStart');
    end_value := brief_ai_safe_bigint(item->>'charEnd');
    if start_value is null or end_value is null or start_value < 0
       or end_value <= start_value
       or end_value > brief_ai_utf16_length(sanitized)
       or not brief_ai_utf16_boundary(sanitized, start_value)
       or not brief_ai_utf16_boundary(sanitized, end_value)
       or (previous_end is not null and start_value <= previous_end) then
      raise exception 'chat source exposure ranges exceed citation-sanitized UTF-16 text'
        using errcode = '23514', constraint = 'ai_source_exposures_chat_reconstruction_consistent';
    end if;
    previous_end := end_value;
  end loop;
  return new;
end
$$;

drop trigger if exists ai_source_exposures_protect_evaluation on ai_source_exposures;
create trigger ai_source_exposures_protect_evaluation
before delete or update on ai_source_exposures
for each row execute function reject_ai_evaluation_runtime_evidence_mutation();
drop trigger if exists ai_source_exposures_validate_chat on ai_source_exposures;
create trigger ai_source_exposures_validate_chat
before insert or update of run_id, source_kind, logical_source_identity,
  content_item_identity, chat_content_hash, chat_ranges
on ai_source_exposures
for each row execute function enforce_ai_chat_source_exposure();
drop trigger if exists ai_source_exposures_validate_document_identity on ai_source_exposures;
create trigger ai_source_exposures_validate_document_identity
before insert or update on ai_source_exposures
for each row execute function validate_ai_source_exposure_document_identity();
drop trigger if exists ai_source_exposures_validate_ranges on ai_source_exposures;
create trigger ai_source_exposures_validate_ranges
before insert or update on ai_source_exposures
for each row execute function validate_ai_source_exposure_ranges();

alter table if exists ai_evaluation_case_runs
  drop constraint if exists ai_evaluation_case_runs_ai_run_id_fkey;
alter table if exists ai_evaluation_case_runs
  add constraint ai_evaluation_case_runs_ai_run_id_fkey
  foreign key (ai_run_id) references ai_runs (id) on delete cascade;
alter table if exists ai_evaluation_annotations
  drop constraint if exists ai_evaluation_annotations_ai_run_id_fkey;
alter table if exists ai_evaluation_annotations
  add constraint ai_evaluation_annotations_ai_run_id_fkey
  foreign key (ai_run_id) references ai_runs (id) on delete cascade;

alter table chat_messages
  add constraint chat_messages_ai_run_id_fkey
  foreign key (assistant_ai_run_id) references ai_runs (id) on delete set null;

create table ai_run_events (
  id bigint generated always as identity primary key,
  run_id uuid not null references ai_runs (id) on delete cascade,
  seq integer not null,
  event jsonb not null,
  created_at timestamptz not null default now(),
  emitted_by_task text,
  emission_key text not null default gen_random_uuid()::text,
  unique (run_id, seq)
);
create unique index ai_run_events_run_emission_key on ai_run_events (run_id, emission_key);
create index ai_run_events_run_task_idx on ai_run_events (run_id, emitted_by_task)
  where emitted_by_task is not null;

create table ai_observations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references ai_runs (id) on delete cascade,
  chat_id uuid not null references chats (id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  emitting_task text not null default 'unknown',
  loop_iteration integer not null default 0,
  attempt integer not null default 0,
  observation_key text not null default gen_random_uuid()::text
);
create index ai_observations_run_idx on ai_observations (run_id);
create unique index ai_observations_run_observation_key on ai_observations (run_id, observation_key);
create index ai_observations_chat_kind_idx on ai_observations (chat_id, kind);
drop trigger if exists ai_observations_protect_evaluation on ai_observations;
create trigger ai_observations_protect_evaluation
before update or delete on ai_observations
for each row execute function reject_ai_evaluation_runtime_evidence_mutation();

create table ai_run_usage (
  id bigint generated always as identity primary key,
  run_id uuid not null references ai_runs (id) on delete cascade,
  task_id text not null,
  loop_iteration integer not null,
  attempt integer not null,
  provider_request_index integer not null,
  agent_role text not null,
  model_id text not null,
  input_tokens integer not null,
  output_tokens integer not null,
  cached_tokens integer not null,
  reasoning_tokens integer not null,
  total_tokens integer not null,
  stop_reason text not null,
  created_at timestamptz not null default now(),
  provider_service_id text not null
);
create unique index ai_run_usage_run_request_key
  on ai_run_usage (run_id, task_id, loop_iteration, attempt, provider_request_index);
create index ai_run_usage_run_idx on ai_run_usage (run_id);

alter table ai_run_usage
  add constraint ai_run_usage_provider_service_valid
  check (provider_service_id in (
    'zai_coding_plan_official',
    'deterministic_test'
  ));

-- Evaluation-bound runtime evidence remains append-only after the cutover.
-- Recreate these guards because the runtime tables above are rebuilt.
drop trigger if exists ai_run_usage_protect_evaluation on ai_run_usage;
create trigger ai_run_usage_protect_evaluation
before update or delete on ai_run_usage
for each row execute function reject_ai_evaluation_runtime_evidence_mutation();
drop trigger if exists ai_run_usage_preserve_provider_service on ai_run_usage;
create trigger ai_run_usage_preserve_provider_service
before update of provider_service_id on ai_run_usage
for each row execute function preserve_ai_run_usage_provider_service();

create table ai_external_tool_usage (
  id bigint generated always as identity primary key,
  run_id uuid not null references ai_runs (id) on delete cascade,
  task_id text not null,
  loop_iteration integer not null,
  attempt integer not null,
  tool_request_index integer not null,
  provider_service_id text not null,
  operation text not null,
  status text not null,
  result_count integer not null,
  response_bytes bigint not null,
  billed_units numeric,
  duration_ms bigint not null,
  created_at timestamptz not null default now()
);
create unique index ai_external_tool_usage_run_request_key
  on ai_external_tool_usage (run_id, task_id, loop_iteration, attempt, tool_request_index);
create index ai_external_tool_usage_run_idx on ai_external_tool_usage (run_id);
drop trigger if exists ai_external_tool_usage_protect_evaluation on ai_external_tool_usage;
create trigger ai_external_tool_usage_protect_evaluation
before update or delete on ai_external_tool_usage
for each row execute function reject_ai_evaluation_runtime_evidence_mutation();

-- Evidence belongs to the durable run, not to a visible assistant row.  The
-- nullable visible link is only a projection pointer and never an identity.
drop table if exists assistant_message_source_uses cascade;
drop table if exists assistant_message_sources cascade;
create table assistant_message_sources (
  run_id uuid not null references ai_runs (id) on delete cascade,
  source_key text not null,
  assistant_message_id uuid references chat_messages (id) on delete set null,
  kind text not null,
  locator jsonb not null,
  message_id uuid references chat_messages (id) on delete set null,
  memory_revision_id uuid references user_memory_revisions (id) on delete set null,
  display_label text,
  public_provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  source_identity_digest text not null,
  citation_namespace text not null,
  document_source_id text,
  document_id text,
  snapshot_id text,
  content_hash text,
  primary key (run_id, source_key),
  constraint assistant_message_sources_kind_valid check (kind in ('document', 'chat_message', 'memory', 'web')),
  constraint assistant_message_sources_typed_identity_valid check (
    (
      kind = 'document'
      and document_source_id is not null
      and brief_ai_valid_document_source_id(document_source_id)
      and document_id is not null
      and snapshot_id is not null
      and content_hash is not null
      and message_id is null
      and memory_revision_id is null
    )
    or (
      kind = 'chat_message'
      and document_source_id is null
      and document_id is null
      and snapshot_id is null
      and content_hash is null
      and memory_revision_id is null
    )
    or (
      kind = 'memory'
      and document_source_id is null
      and document_id is null
      and snapshot_id is null
      and content_hash is null
      and message_id is null
    )
    or (
      kind = 'web'
      and document_source_id is null
      and document_id is null
      and snapshot_id is null
      and content_hash is null
      and message_id is null
      and memory_revision_id is null
    )
  ),
  constraint assistant_message_sources_identity_digest_shape check (source_identity_digest ~ '^[0-9a-f]{64}$'),
  constraint assistant_message_sources_namespace_shape check (citation_namespace ~ '^cn_[A-Za-z0-9_-]{22}$'),
  constraint assistant_message_sources_json_valid check (jsonb_typeof(locator) = 'object' and jsonb_typeof(public_provenance) = 'object')
);
create index assistant_message_sources_visible_idx on assistant_message_sources (assistant_message_id);

create table assistant_message_source_uses (
  run_id uuid not null,
  source_key text not null,
  assistant_message_id uuid references chat_messages (id) on delete set null,
  consumer_task_id text not null,
  topic_id text,
  rendered_token_count integer not null,
  context_order integer not null,
  ranges jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  source_use_identity_digest text not null,
  primary key (run_id, source_key, consumer_task_id),
  constraint assistant_message_source_uses_final_source_fkey
    foreign key (run_id, source_key) references assistant_message_sources (run_id, source_key)
      on delete cascade deferrable initially deferred,
  constraint assistant_message_source_uses_counts_valid check (rendered_token_count >= 0 and context_order >= 0),
  constraint assistant_message_source_uses_ranges_array check (jsonb_typeof(ranges) = 'array'),
  constraint assistant_message_source_uses_topic_valid check (topic_id is null or topic_id in ('t1', 't2', 't3')),
  constraint assistant_message_source_uses_identity_digest_shape check (source_use_identity_digest ~ '^[0-9a-f]{64}$')
);

-- Re-seal the run-owned citation ledger.  The old functions survived table
-- replacement because PostgreSQL stores functions separately from their
-- triggers; every function below names only the final run-owned columns.
drop function if exists assistant_message_source_identity_digest(uuid, text, text, jsonb, text, uuid, uuid, uuid, text, jsonb) cascade;
drop function if exists assistant_message_source_identity_digest(uuid, text, text, jsonb, text, uuid, uuid, text, jsonb) cascade;
create or replace function assistant_message_source_identity_digest(
  p_run_id uuid,
  p_source_key text,
  p_kind text,
  p_locator jsonb,
  p_snapshot_id text,
  p_message_id uuid,
  p_memory_revision_id uuid,
  p_display_label text,
  p_public_provenance jsonb
)
returns text
language sql
immutable
as $$
  select encode(digest(convert_to(jsonb_build_object(
    'runId', p_run_id,
    'sourceKey', p_source_key,
    'kind', p_kind,
    'locator', p_locator,
    'snapshotId', p_snapshot_id,
    'messageId', p_message_id,
    'memoryRevisionId', p_memory_revision_id,
    'displayLabel', p_display_label,
    'publicProvenance', p_public_provenance
  )::text, 'UTF8'), 'sha256'), 'hex')
$$;

drop function if exists assistant_message_source_use_identity_digest(uuid, text, text, text, integer, integer, jsonb) cascade;
create or replace function assistant_message_source_use_identity_digest(
  p_run_id uuid,
  p_source_key text,
  p_consumer_task_id text,
  p_topic_id text,
  p_rendered_token_count integer,
  p_context_order integer,
  p_ranges jsonb
)
returns text
language sql
immutable
as $$
  select encode(digest(convert_to(jsonb_build_object(
    'runId', p_run_id,
    'sourceKey', p_source_key,
    'consumerTaskId', p_consumer_task_id,
    'topicId', p_topic_id,
    'renderedTokenCount', p_rendered_token_count,
    'contextOrder', p_context_order,
    'ranges', p_ranges
  )::text, 'UTF8'), 'sha256'), 'hex')
$$;

create or replace function validate_assistant_message_source_key()
returns trigger
language plpgsql
as $$
declare
  expected_namespace text;
  ordinal bigint;
begin
  -- PostgreSQL applies the nullable projection's ON DELETE SET NULL action
  -- while deleting the visible assistant row (and can do so after the owning
  -- run has already entered its CASCADE).  Preserve the run-owned identity
  -- during that referential action, but never let an application clear a live
  -- projection through this trigger.
  if tg_op = 'UPDATE'
     and new.assistant_message_id is null
     and old.assistant_message_id is not null
     and (
       not exists (select 1 from chat_messages where id = old.assistant_message_id)
       or not exists (select 1 from ai_runs where id = old.run_id)
     ) then
    return new;
  end if;
  if new.source_key !~ '^k_cn_[A-Za-z0-9_-]{22}_[1-9][0-9]*$' then
    raise exception 'assistant message source key is not canonical';
  end if;
  ordinal := brief_ai_safe_bigint(substring(new.source_key from '_([1-9][0-9]*)$'));
  if ordinal is null or ordinal > 2147483647 then
    raise exception 'assistant message source ordinal exceeds the final integer bound';
  end if;
  select runs.citation_namespace
    into expected_namespace
  from ai_runs runs
  where runs.id = new.run_id;
  if expected_namespace is null
    or new.citation_namespace is distinct from expected_namespace
    or substring(new.source_key from '^k_(cn_[A-Za-z0-9_-]{22})_[1-9][0-9]*$') is distinct from expected_namespace then
    raise exception 'assistant message source key namespace does not match its owning run';
  end if;
  if new.assistant_message_id is not null and not exists (
    select 1 from chat_messages messages
    where messages.id = new.assistant_message_id
      and messages.author = 'assistant'
      and messages.assistant_ai_run_id = new.run_id
  ) then
    raise exception 'assistant message source points outside its owning run';
  end if;
  if new.assistant_message_id is not null and exists (
    select 1
    from assistant_message_source_uses uses
    where uses.run_id = new.run_id
      and uses.source_key = new.source_key
      and uses.assistant_message_id is not null
      and uses.assistant_message_id <> new.assistant_message_id
  ) then
    raise exception 'assistant message source projection does not match its source uses';
  end if;
  if exists (
    select 1
    from assistant_message_sources existing
    where existing.run_id = new.run_id
      and existing.source_key <> new.source_key
      and brief_ai_safe_bigint(substring(existing.source_key from '_([1-9][0-9]*)$')) = ordinal
  ) then
    raise exception 'assistant message source ordinal is duplicated within its owning run';
  end if;
  return new;
end
$$;

create or replace function validate_assistant_document_source_identity()
returns trigger
language plpgsql
as $$
begin
  if new.kind <> 'document' then
    return new;
  end if;
  if new.document_source_id is null
     or new.document_id is null
     or new.snapshot_id is null
     or new.content_hash is null
     or new.locator->>'sourceId' is distinct from new.document_source_id
     or new.locator->>'documentId' is distinct from new.document_id
     or new.locator->>'snapshotId' is distinct from new.snapshot_id
     or new.locator->>'contentHash' is distinct from new.content_hash
     or not brief_valid_document_exposure_ranges(new.locator->'ranges') then
    raise exception 'document source identity is incomplete';
  end if;
  if new.document_source_id like 'public:%' then
    if exists (
         select 1 from jsonb_object_keys(new.locator) key
         where key not in ('kind', 'sourceId', 'documentId', 'snapshotId', 'contentHash', 'ranges')
       )
       or not exists (
         select 1
         from public_source_documents documents
         where documents.source_id::text = substring(new.document_source_id from 8)
           and documents.document_id = new.document_id
           and documents.document_id = new.snapshot_id
           and documents.content_hash = new.content_hash
           and documents.document_id = new.locator->>'documentId'
           and documents.canonical_url = new.public_provenance->>'citationUrl'
           and not exists (
             select 1
             from jsonb_array_elements(new.locator->'ranges') range_row
             where brief_ai_safe_bigint(range_row->>'charEnd') > brief_ai_utf16_length(documents.text)
           )
       ) then
      raise exception 'public document source must reference an exact immutable document';
    end if;
  else
    raise exception 'document source ID is not canonical';
  end if;
  return new;
end;
$$;

create or replace function validate_assistant_message_source_locator()
returns trigger
language plpgsql
as $$
declare
  captured_at timestamptz;
  published_at timestamptz;
begin
  if new.kind = 'chat_message' then
    -- Deleting the cited visible message uses the FK's SET NULL action.  The
    -- row remains immutable evidence, but its text is no longer available for
    -- a public quote.  Permit only that database-driven orphaning; callers
    -- cannot clear or replace the identity themselves.
    if new.message_id is null then
      if tg_op = 'UPDATE'
         and pg_trigger_depth() > 1
         and (
           old.message_id is not null
           or (old.assistant_message_id is not null and new.assistant_message_id is null)
         ) then
        return new;
      end if;
      raise exception 'chat locator must retain its cited message identity';
    end if;
    if new.locator->>'kind' is distinct from 'chat_message'
       or new.locator->>'messageId' is distinct from new.message_id::text
       or exists (select 1 from jsonb_object_keys(new.locator) key where key not in ('kind', 'messageId'))
       or new.public_provenance is distinct from '{}'::jsonb
       or not exists (
         select 1
         from chat_messages referenced
         join ai_runs runs on runs.id = new.run_id
         where referenced.id = new.message_id
           and referenced.chat_id = runs.chat_id
       ) then
      raise exception 'chat locator must bind messageId to the run chat';
    end if;
    if new.assistant_message_id is not null and not exists (
      select 1 from chat_messages assistants
      where assistants.id = new.assistant_message_id
        and assistants.assistant_ai_run_id = new.run_id
    ) then
      raise exception 'chat citation assistant projection is outside its run';
    end if;
  elsif new.kind = 'memory' then
    -- Memory retention and identity purge use SET NULL after the retained
    -- revision has gone. Keep the run-owned evidence, but do not allow a
    -- caller to clear a live revision reference.
    if new.memory_revision_id is null then
      if tg_op = 'UPDATE'
         and old.memory_revision_id is not null
         and not exists (select 1 from user_memory_revisions where id = old.memory_revision_id) then
        return new;
      end if;
      raise exception 'memory locator must retain its cited revision identity';
    end if;
    if new.locator->>'kind' is distinct from 'memory'
       or new.locator->>'memoryId' is null
       or new.locator->>'memoryRevisionId' is distinct from new.memory_revision_id::text
       or exists (select 1 from jsonb_object_keys(new.locator) key where key not in ('kind', 'memoryId', 'memoryRevisionId'))
       or new.public_provenance is distinct from '{}'::jsonb
       or not exists (
         select 1
         from user_memory_revisions revisions
         join user_memories memories on memories.id = revisions.memory_id
         join ai_runs runs on runs.id = new.run_id
         where revisions.id = new.memory_revision_id
           and revisions.memory_id::text = new.locator->>'memoryId'
           and memories.user_id = runs.initiating_user_id
       ) then
      raise exception 'memory locator must bind its exact owner revision';
    end if;
  elsif new.kind = 'web' then
    if new.locator->>'kind' is distinct from 'web'
       or jsonb_typeof(new.locator->'url') is distinct from 'string'
       or not brief_public_source_https_url_allowed(new.locator->>'url')
       or jsonb_typeof(new.locator->'title') is distinct from 'string'
       or jsonb_typeof(new.locator->'domain') is distinct from 'string'
       or jsonb_typeof(new.locator->'quote') is distinct from 'string'
       or jsonb_typeof(new.locator->'quoteHash') is distinct from 'string'
       or jsonb_typeof(new.locator->'capturedAt') is distinct from 'string'
       or (jsonb_exists(new.locator, 'publishedAt') and jsonb_typeof(new.locator->'publishedAt') is distinct from 'string')
       or btrim(new.locator->>'title') = ''
       or btrim(new.locator->>'domain') = ''
       or btrim(new.locator->>'quote') = ''
       or new.locator->>'url' <> btrim(new.locator->>'url')
       or new.locator->>'url' ~ '[[:cntrl:]]'
       or new.locator->>'url' ~ '[^ -~]'
       or substring(new.locator->>'url' from '^https://([^/:?#]+)') is null
       or substring(new.locator->>'url' from '^https://([^/:?#]+)') <> lower(substring(new.locator->>'url' from '^https://([^/:?#]+)'))
       or new.locator->>'url' ~ '^https://[^/?#]+(?:$|[?#])'
       or new.locator->>'domain' <> lower(new.locator->>'domain')
       or new.locator->>'domain' !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
       or split_part(split_part(new.locator->>'url', '?', 1), '#', 1) ~* '(^|/)(\.{1,2}|%2e(?:%2e)?|\.%2e|%2e\.)(/|$)'
       or new.locator->>'capturedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
       or (jsonb_exists(new.locator, 'publishedAt') and (btrim(new.locator->>'publishedAt') = '' or new.locator->>'publishedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'))
       or new.locator->>'quoteHash' !~ '^[A-Za-z0-9_-]{43}$'
       or substring(new.locator->>'url' from '^https://([^/:?#]+)') is distinct from new.locator->>'domain'
       or new.locator->>'quote' is distinct from btrim(normalize(replace(replace(new.locator->>'quote', E'\r\n', E'\n'), E'\r', E'\n'), NFC))
       or new.locator->>'quoteHash' is distinct from translate(rtrim(encode(digest(convert_to(new.locator->>'quote', 'UTF8'), 'sha256'), 'base64'), '='), '+/', '-_')
       or exists (select 1 from jsonb_object_keys(new.locator) key where key not in ('kind', 'url', 'title', 'domain', 'quote', 'quoteHash', 'publishedAt', 'capturedAt'))
       or new.public_provenance is distinct from jsonb_build_object('citationUrl', new.locator->>'url') then
      raise exception 'web locator must use the strict URL, quote, and hash form';
    end if;
    begin
      captured_at := (new.locator->>'capturedAt')::timestamptz;
      if jsonb_exists(new.locator, 'publishedAt') then published_at := (new.locator->>'publishedAt')::timestamptz; end if;
    exception when others then
      raise exception 'web locator timestamps are invalid';
    end;
    if published_at is not null and published_at > captured_at then
      raise exception 'web locator publication cannot be after capture';
    end if;
  end if;
  return new;
end;
$$;

create or replace function enforce_assistant_message_source_identity_immutable()
returns trigger
language plpgsql
as $$
declare
  message_orphaned boolean := false;
  memory_orphaned boolean := false;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from ai_runs where id = old.run_id) then
      raise exception 'assistant message sources cannot be deleted independently'
        using errcode = '23514', constraint = 'assistant_message_sources_delete_immutable';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    message_orphaned := new.message_id is null
      and old.message_id is not null
      and pg_trigger_depth() > 1;
    memory_orphaned := new.memory_revision_id is null
      and old.memory_revision_id is not null
      and pg_trigger_depth() > 1;
  end if;
  if tg_op = 'UPDATE' and (
    new.run_id is distinct from old.run_id
    or new.source_key is distinct from old.source_key
    or new.kind is distinct from old.kind
    or new.locator is distinct from old.locator
    or new.snapshot_id is distinct from old.snapshot_id
    or (new.message_id is distinct from old.message_id and not message_orphaned)
    or (new.memory_revision_id is distinct from old.memory_revision_id and not memory_orphaned)
    or new.display_label is distinct from old.display_label
    or new.public_provenance is distinct from old.public_provenance
    or new.citation_namespace is distinct from old.citation_namespace
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'assistant message source identity is immutable'
      using errcode = '23514', constraint = 'assistant_message_sources_identity_immutable';
  end if;
  if message_orphaned or memory_orphaned then
    -- The logical identity remains the original cited row even when its
    -- nullable foreign key is cleared by a referential action.
    new.source_identity_digest := old.source_identity_digest;
    return new;
  end if;
  new.source_identity_digest := assistant_message_source_identity_digest(
    new.run_id, new.source_key, new.kind, new.locator, new.snapshot_id,
    new.message_id, new.memory_revision_id,
    new.display_label, new.public_provenance
  );
  return new;
end;
$$;

create or replace function enforce_assistant_message_source_use_identity_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.assistant_message_id is not null and not exists (
    select 1 from chat_messages messages
    where messages.id = new.assistant_message_id
      and messages.author = 'assistant'
      and messages.assistant_ai_run_id = new.run_id
  ) then
    raise exception 'assistant message source use projection is outside its owning run'
      using errcode = '23514', constraint = 'assistant_message_source_uses_assistant_projection';
  end if;
  if new.assistant_message_id is not null and exists (
    select 1
    from assistant_message_sources sources
    where sources.run_id = new.run_id
      and sources.source_key = new.source_key
      and sources.assistant_message_id is not null
      and sources.assistant_message_id <> new.assistant_message_id
  ) then
    raise exception 'assistant message source use projection does not match its source'
      using errcode = '23514', constraint = 'assistant_message_source_uses_assistant_projection';
  end if;
  if tg_op = 'DELETE' then
    if exists (select 1 from assistant_message_sources where run_id = old.run_id and source_key = old.source_key) then
      raise exception 'assistant message source uses cannot be deleted independently'
        using errcode = '23514', constraint = 'assistant_message_source_uses_delete_immutable';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and (
    new.run_id is distinct from old.run_id
    or new.source_key is distinct from old.source_key
    or new.consumer_task_id is distinct from old.consumer_task_id
    or new.topic_id is distinct from old.topic_id
    or new.rendered_token_count is distinct from old.rendered_token_count
    or new.context_order is distinct from old.context_order
    or new.ranges is distinct from old.ranges
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'assistant message source use identity is immutable'
      using errcode = '23514', constraint = 'assistant_message_source_uses_identity_immutable';
  end if;
  new.source_use_identity_digest := assistant_message_source_use_identity_digest(
    new.run_id, new.source_key, new.consumer_task_id, new.topic_id,
    new.rendered_token_count, new.context_order, new.ranges
  );
  return new;
end;
$$;

create or replace function validate_assistant_message_source_use_ranges()
returns trigger
language plpgsql
as $$
declare
  source_row record;
  run_row record;
  text_length integer;
  sanitized text;
  item jsonb;
  start_value bigint;
  end_value bigint;
  previous_end bigint;
begin
  if jsonb_typeof(new.ranges) is distinct from 'array'
     or exists (
       select 1 from jsonb_array_elements(new.ranges) range_row
       where jsonb_typeof(range_row) is distinct from 'object'
         or (range_row - 'charStart' - 'charEnd') <> '{}'::jsonb
         or jsonb_typeof(range_row->'charStart') is distinct from 'number'
         or jsonb_typeof(range_row->'charEnd') is distinct from 'number'
         or brief_ai_safe_bigint(range_row->>'charStart') is null
         or brief_ai_safe_bigint(range_row->>'charEnd') is null
         or brief_ai_safe_bigint(range_row->>'charEnd') <= brief_ai_safe_bigint(range_row->>'charStart')
     ) then
    raise exception 'assistant message source-use ranges are not canonical';
  end if;
  previous_end := null;
  for item in select value from jsonb_array_elements(new.ranges) loop
    start_value := brief_ai_safe_bigint(item->>'charStart');
    end_value := brief_ai_safe_bigint(item->>'charEnd');
    if previous_end is not null and start_value <= previous_end then
      raise exception 'assistant message source-use ranges overlap or touch';
    end if;
    previous_end := end_value;
  end loop;
  select sources.kind, sources.locator, sources.message_id, sources.document_source_id,
         sources.snapshot_id, sources.document_id, sources.content_hash,
         sources.source_key
    into source_row
  from assistant_message_sources sources
  where sources.run_id = new.run_id and sources.source_key = new.source_key;
  if not found then raise exception 'assistant message source-use has no owning source'; end if;
  if source_row.kind = 'chat_message' then
    if jsonb_array_length(new.ranges) = 0 then
      raise exception 'chat source-use ranges must be non-empty';
    end if;
    select runs.chat_id, messages.content into run_row
    from ai_runs runs join chat_messages messages on messages.id = source_row.message_id
    where runs.id = new.run_id and messages.chat_id = runs.chat_id;
    if not found then raise exception 'chat source-use message is outside its run'; end if;
    sanitized := brief_ai_strip_historical_citation_tags(run_row.content);
    if exists (
      select 1 from jsonb_array_elements(new.ranges) range_row
      where brief_ai_safe_bigint(range_row->>'charEnd') > brief_ai_utf16_length(sanitized)
         or not brief_ai_utf16_boundary(sanitized, brief_ai_safe_bigint(range_row->>'charStart'))
         or not brief_ai_utf16_boundary(sanitized, brief_ai_safe_bigint(range_row->>'charEnd'))
    ) then
      raise exception 'chat source-use range is outside citation-sanitized text';
    end if;
    return new;
  end if;
  if source_row.kind <> 'document' then
    if jsonb_array_length(new.ranges) <> 0 then
      raise exception 'non-document source-use ranges must be empty';
    end if;
    return new;
  end if;
  if source_row.document_source_id not like 'public:%' then
    raise exception 'document source-use identity is not canonical';
  end if;
  select brief_ai_utf16_length(documents.text) into text_length
  from public_source_documents documents
  where documents.document_id = source_row.snapshot_id
    and documents.document_id = source_row.document_id
    and documents.source_id::text = substring(source_row.document_source_id from 8)
    and documents.content_hash = source_row.content_hash;
  if source_row.kind = 'document' and (text_length is null or exists (
    select 1 from jsonb_array_elements(new.ranges) range_row
    where brief_ai_safe_bigint(range_row->>'charEnd') > text_length
      or not exists (
        select 1 from jsonb_array_elements(source_row.locator->'ranges') locator_range
        where brief_ai_safe_bigint(range_row->>'charStart') >= brief_ai_safe_bigint(locator_range->>'charStart')
          and brief_ai_safe_bigint(range_row->>'charEnd') <= brief_ai_safe_bigint(locator_range->>'charEnd')
      )
  )) then
    raise exception 'assistant message source-use range is outside immutable source text';
  end if;
  return new;
end;
$$;

drop trigger if exists assistant_message_sources_validate_key on assistant_message_sources;
create trigger assistant_message_sources_validate_key
before insert or update of run_id, source_key, assistant_message_id, citation_namespace
on assistant_message_sources for each row execute function validate_assistant_message_source_key();
drop trigger if exists assistant_message_sources_validate_locator on assistant_message_sources;
create trigger assistant_message_sources_validate_locator
before insert or update of run_id, kind, locator, message_id, memory_revision_id, public_provenance, assistant_message_id
on assistant_message_sources for each row execute function validate_assistant_message_source_locator();
drop trigger if exists assistant_message_sources_validate_document on assistant_message_sources;
create trigger assistant_message_sources_validate_document
before insert or update of kind, locator, document_source_id, document_id, snapshot_id, content_hash, public_provenance
on assistant_message_sources for each row execute function validate_assistant_document_source_identity();
drop trigger if exists assistant_message_sources_identity_immutable on assistant_message_sources;
create trigger assistant_message_sources_identity_immutable
before insert or update or delete on assistant_message_sources
for each row execute function enforce_assistant_message_source_identity_immutable();
drop trigger if exists assistant_message_source_uses_identity_immutable on assistant_message_source_uses;
create trigger assistant_message_source_uses_identity_immutable
before insert or update or delete on assistant_message_source_uses
for each row execute function enforce_assistant_message_source_use_identity_immutable();
drop trigger if exists assistant_message_source_uses_validate_ranges on assistant_message_source_uses;
create trigger assistant_message_source_uses_validate_ranges
before insert or update of run_id, source_key, ranges on assistant_message_source_uses
for each row execute function validate_assistant_message_source_use_ranges();

-- Evaluation metadata keeps its durable identity and state guards after the
-- runtime table rebuild.
create or replace function protect_ai_evaluation_session()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('hartlib.allow_account_purge', true) = 'on' then
    return old;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'canonical AI evaluation sessions are append-only'
      using errcode = '23514', constraint = 'ai_evaluation_session_append_only';
  end if;
  if new.id is distinct from old.id
     or new.artifact_version is distinct from old.artifact_version
     or new.golden_set_version is distinct from old.golden_set_version
     or new.fixture_sha256_hex is distinct from old.fixture_sha256_hex
     or new.created_at is distinct from old.created_at
     or (old.execution_config_sha256_hex is not null
         and new.execution_config_sha256_hex is distinct from old.execution_config_sha256_hex)
     or (old.provider_endpoint_identity is not null
         and new.provider_endpoint_identity is distinct from old.provider_endpoint_identity)
     or old.status in ('complete', 'failed') then
    raise exception 'canonical AI evaluation session identity or terminal state is immutable'
      using errcode = '23514', constraint = 'ai_evaluation_session_immutable';
  end if;
  if (old.status = 'preparing' and new.status not in ('preparing', 'running', 'failed'))
     or (old.status = 'running' and new.status not in ('running', 'awaiting_annotations', 'failed'))
     or (old.status = 'awaiting_annotations'
         and new.status not in ('awaiting_annotations', 'complete', 'failed')) then
    raise exception 'invalid canonical AI evaluation session state transition'
      using errcode = '23514', constraint = 'ai_evaluation_session_state_transition';
  end if;
  return new;
end;
$$;

create or replace function protect_ai_evaluation_immutable_identity()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('hartlib.allow_account_purge', true) = 'on' then
    return old;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'canonical AI evaluation records are append-only'
      using errcode = '23514', constraint = 'ai_evaluation_append_only';
  end if;
  if new.session_id is distinct from old.session_id
     or new.case_id is distinct from old.case_id
     or new.topology is distinct from old.topology
     or new.ai_run_id is distinct from old.ai_run_id
     or new.seed_manifest is distinct from old.seed_manifest
     or new.created_at is distinct from old.created_at
     or old.status in ('succeeded', 'failed') then
    raise exception 'canonical AI evaluation identity or terminal record is immutable'
      using errcode = '23514', constraint = 'ai_evaluation_identity_immutable';
  end if;
  if (old.started_at is not null and new.started_at is distinct from old.started_at)
     or (old.execution_output is not null
         and (new.execution_output is distinct from old.execution_output
              or new.execution_output_sha256_hex is distinct from old.execution_output_sha256_hex)) then
    raise exception 'canonical AI evaluation execution evidence is write-once'
      using errcode = '23514', constraint = 'ai_evaluation_execution_evidence_write_once';
  end if;
  if (old.status = 'seeded' and new.status not in ('seeded', 'running'))
     or (old.status = 'running' and new.status not in ('running', 'succeeded', 'failed')) then
    raise exception 'invalid canonical AI evaluation state transition'
      using errcode = '23514', constraint = 'ai_evaluation_state_transition';
  end if;
  return new;
end;
$$;

create or replace function reject_ai_evaluation_annotation_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('hartlib.allow_account_purge', true) = 'on' then
    return old;
  end if;
  raise exception 'canonical AI evaluation annotations are immutable'
    using errcode = '23514', constraint = 'ai_evaluation_annotations_immutable';
end;
$$;

drop trigger if exists ai_evaluation_sessions_protect on ai_evaluation_sessions;
create trigger ai_evaluation_sessions_protect
before update or delete on ai_evaluation_sessions
for each row execute function protect_ai_evaluation_session();
drop trigger if exists ai_evaluation_case_runs_protect on ai_evaluation_case_runs;
create trigger ai_evaluation_case_runs_protect
before update or delete on ai_evaluation_case_runs
for each row execute function protect_ai_evaluation_immutable_identity();
drop trigger if exists ai_evaluation_annotations_immutable on ai_evaluation_annotations;
create trigger ai_evaluation_annotations_immutable
before update or delete on ai_evaluation_annotations
for each row execute function reject_ai_evaluation_annotation_mutation();

-- Acceptance is a fourteen-field immutable snapshot.  This trigger checks
-- tenant ownership and selected live source/memory sets only at insertion.
create or replace function hartlib_ai_scope_array_canonical(p_scope jsonb, p_key text)
returns boolean
language plpgsql
immutable
strict
as $$
declare
  item record;
  previous text;
begin
  if jsonb_typeof(p_scope->p_key) is distinct from 'array' then return false; end if;
  previous := null;
  for item in
    select value from jsonb_array_elements(p_scope->p_key) with ordinality values(value, ordinal)
    order by ordinal
  loop
    if jsonb_typeof(item.value) is distinct from 'string' or item.value #>> '{}' = '' then return false; end if;
    if previous is not null and previous >= item.value #>> '{}' then return false; end if;
    previous := item.value #>> '{}';
  end loop;
  return true;
end;
$$;

create or replace function hartlib_ai_validate_acceptance_scope()
returns trigger
language plpgsql
as $$
declare
  scope jsonb := new.acceptance_scope;
  expected_public integer;
  selected_public integer;
  expected_memory integer;
  selected_memory integer;
begin
  if tg_op = 'UPDATE' and new.acceptance_scope is distinct from old.acceptance_scope then
    raise exception 'AI run acceptance scope is immutable'
      using errcode = '23514', constraint = 'ai_runs_acceptance_scope_immutable';
  end if;
  if jsonb_typeof(scope) is distinct from 'object'
     or (select count(*) from jsonb_object_keys(scope)) <> 14
     or exists (
       select 1 from jsonb_object_keys(scope) key
       where key not in ('userId','chatId','companyId','publicSourceIds','memoryMode','memoryRevisionIds','webRequested','webEnabled','provider','providerEndpointIdentity','fastModelId','mainModelId','webTransportProvider','allowedDomains')
     )
     or jsonb_typeof(scope->'userId') is distinct from 'string'
     or btrim(scope->>'userId') = ''
     or jsonb_typeof(scope->'chatId') is distinct from 'string'
     or scope->>'chatId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or jsonb_typeof(scope->'companyId') is distinct from 'string'
     or scope->>'companyId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or jsonb_typeof(scope->'publicSourceIds') is distinct from 'array'
     or jsonb_typeof(scope->'memoryRevisionIds') is distinct from 'array'
     or jsonb_typeof(scope->'memoryMode') is distinct from 'string'
     or scope->>'memoryMode' not in ('private_owner','disabled')
     or jsonb_typeof(scope->'webRequested') is distinct from 'boolean'
     or jsonb_typeof(scope->'webEnabled') is distinct from 'boolean'
     or (not (scope->>'webRequested')::boolean and (scope->>'webEnabled')::boolean)
     or jsonb_typeof(scope->'provider') is distinct from 'string'
     or scope->>'provider' not in ('zai_coding_plan_official','deterministic_test')
     or jsonb_typeof(scope->'providerEndpointIdentity') is distinct from 'string'
     or btrim(scope->>'providerEndpointIdentity') = ''
     or left(scope->>'providerEndpointIdentity', length(scope->>'provider') + 1) <> scope->>'provider' || ':'
     or scope->>'fastModelId' <> 'glm-5-turbo'
     or scope->>'mainModelId' <> 'glm-5-turbo'
     or scope->'webTransportProvider' not in ('null'::jsonb, '"tinyfish"'::jsonb)
     or scope->'allowedDomains' <> 'null'::jsonb and jsonb_typeof(scope->'allowedDomains') is distinct from 'array'
     or (scope->>'webEnabled')::boolean and scope->'webTransportProvider' <> '"tinyfish"'::jsonb
     or not (scope->>'webEnabled')::boolean and (scope->'webTransportProvider' <> 'null'::jsonb or scope->'allowedDomains' <> 'null'::jsonb)
     or (scope->'allowedDomains' <> 'null'::jsonb and not hartlib_ai_scope_array_canonical(scope, 'allowedDomains'))
     or not hartlib_ai_scope_array_canonical(scope, 'publicSourceIds')
     or not hartlib_ai_scope_array_canonical(scope, 'memoryRevisionIds') then
    raise exception 'AI run acceptance scope has invalid shape'
      using errcode = '23514', constraint = 'ai_runs_acceptance_scope_shape';
  end if;
  if scope->>'userId' is distinct from new.initiating_user_id::text
     or scope->>'chatId' is distinct from new.chat_id::text
     or not exists (
       select 1 from chats chat
       join client_company_memberships membership
         on membership.company_id = chat.company_id
        and membership.user_id = chat.user_id
        and membership.revoked_at is null
       where chat.id = new.chat_id
         and chat.user_id = new.initiating_user_id
         and chat.company_id::text = scope->>'companyId'
         and chat.memory_mode = scope->>'memoryMode'
     ) then
    raise exception 'AI run acceptance scope tenant binding is invalid'
      using errcode = '23514', constraint = 'ai_runs_acceptance_scope_binding';
  end if;
  select count(*) into selected_public from jsonb_array_elements_text(scope->'publicSourceIds');
  select count(*) into expected_public from client_company_public_source_settings settings
    where settings.client_company_id = (scope->>'companyId')::uuid and settings.enabled;
  if selected_public <> expected_public or exists (
    select 1 from jsonb_array_elements_text(scope->'publicSourceIds') selected(value)
    where not exists (
      select 1 from client_company_public_source_settings settings
      where settings.client_company_id = (scope->>'companyId')::uuid and settings.source_id = selected.value and settings.enabled
    )
  ) then
    raise exception 'AI run acceptance scope public-source set is not the accepted set'
      using errcode = '23514', constraint = 'ai_runs_acceptance_scope_public_source';
  end if;
  select count(*) into selected_memory from jsonb_array_elements_text(scope->'memoryRevisionIds');
  select count(*) into expected_memory from user_memories memories
    where memories.user_id = new.initiating_user_id and memories.deleted_at is null
      and memories.provenance_only_at is null and memories.head_revision_id is not null;
  if scope->>'memoryMode' = 'disabled' and selected_memory <> 0 then
    raise exception 'disabled memory cannot carry revisions' using errcode = '23514', constraint = 'ai_runs_acceptance_scope_memory_mode';
  end if;
  if scope->>'memoryMode' = 'private_owner' and selected_memory <> expected_memory then
    raise exception 'AI run acceptance scope memory set is not the accepted set'
      using errcode = '23514', constraint = 'ai_runs_acceptance_scope_memory';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(scope->'memoryRevisionIds') selected(value)
    where not exists (
      select 1 from user_memories memories
      where memories.user_id = new.initiating_user_id and memories.deleted_at is null
        and memories.provenance_only_at is null and memories.head_revision_id::text = selected.value
    )
  ) then
    raise exception 'AI run acceptance scope contains an unavailable memory revision'
      using errcode = '23514', constraint = 'ai_runs_acceptance_scope_memory';
  end if;
  return new;
end;
$$;

drop trigger if exists ai_runs_validate_acceptance_scope on ai_runs;
drop trigger if exists ai_runs_validate_acceptance_scope_insert on ai_runs;
drop trigger if exists ai_runs_validate_acceptance_scope_update on ai_runs;
create trigger ai_runs_validate_acceptance_scope_insert
before insert on ai_runs
for each row execute function hartlib_ai_validate_acceptance_scope();

create or replace function hartlib_ai_validate_acceptance_scope_update_identity()
returns trigger
language plpgsql
as $$
begin
  -- The accepted snapshot is immutable.  It must continue to authorize the
  -- run after memory and source rows change, so only tenant identity changes
  -- need a live binding check on later updates.
  if new.acceptance_scope is distinct from old.acceptance_scope then
    raise exception 'AI run acceptance scope is immutable'
      using errcode = '23514', constraint = 'ai_runs_acceptance_scope_immutable';
  end if;
  if new.initiating_user_id is distinct from old.initiating_user_id
     or new.chat_id is distinct from old.chat_id then
    if new.acceptance_scope->>'userId' is distinct from new.initiating_user_id::text
       or new.acceptance_scope->>'chatId' is distinct from new.chat_id::text
       or not exists (
         select 1
         from chats chat
         where chat.id = new.chat_id
           and chat.company_id::text = new.acceptance_scope->>'companyId'
           and chat.user_id = new.initiating_user_id
       ) then
      raise exception 'AI run acceptance scope tenant binding is invalid'
        using errcode = '23514', constraint = 'ai_runs_acceptance_scope_binding';
    end if;
  end if;
  return new;
end;
$$;

create trigger ai_runs_validate_acceptance_scope_update
before update on ai_runs
for each row execute function hartlib_ai_validate_acceptance_scope_update_identity();

-- Remove function-only remnants of deleted platform objects.  CASCADE is safe
-- here because every dependent trigger belongs to a table dropped above.
drop function if exists clerk_user_event_rank(text) cascade;
drop function if exists enforce_export_object_deletion() cascade;
drop function if exists expire_prior_workspace_invitation_before_insert() cascade;
drop function if exists hartlib_export_hold_identity_snapshot(jsonb) cascade;
drop function if exists hartlib_export_request_hold_scope_keys(text, jsonb) cascade;
drop function if exists hartlib_export_snapshot_envelope_is_valid(jsonb, text, text, text) cascade;
drop function if exists hartlib_export_snapshot_identity_array_is_valid(jsonb, text) cascade;
drop function if exists hartlib_has_active_legal_hold(text[]) cascade;
drop function if exists hartlib_has_embedded_legal_hold(text[]) cascade;
drop function if exists hartlib_normalize_legal_hold_scope_keys(text[]) cascade;
drop function if exists hartlib_resolve_legal_hold_scope_keys(text, text, text, uuid, uuid, text) cascade;
drop function if exists hartlib_stripe_event_legal_hold_scope_keys(text, text, text, text, text) cascade;
drop function if exists maintain_billing_account_retention() cascade;
drop function if exists protect_ai_checkout_request_identity() cascade;
drop function if exists protect_ai_plan_change_request_identity() cascade;
drop function if exists protect_email_notification_delivery_state() cascade;
drop function if exists protect_export_object_generation() cascade;
drop function if exists protect_export_request_generation() cascade;
drop function if exists protect_publisher_document_upload_event_attempt() cascade;
drop function if exists protect_publisher_document_upload_identity() cascade;
drop function if exists reject_publisher_document_upload_history_mutation() cascade;
drop function if exists reject_purged_publisher_issue_tombstone_mutation() cascade;
drop function if exists reject_restricted_support_access_mutation() cascade;
drop function if exists revoke_client_workspace_invitations_on_deletion() cascade;
drop function if exists serialize_legal_hold_scope() cascade;
drop function if exists serialize_legal_hold_scope_change() cascade;
drop function if exists snapshot_export_request_hold_scopes() cascade;
drop function if exists snapshot_restricted_support_access_hold_scopes() cascade;
drop function if exists snapshot_restricted_support_grant_hold_scopes() cascade;
drop function if exists validate_completed_export_generation() cascade;
drop function if exists validate_promoted_export_generation() cascade;
drop function if exists validate_restricted_support_access_log() cascade;
drop function if exists validate_restricted_support_grant() cascade;
drop function if exists validate_restricted_support_review() cascade;
drop function if exists append_restricted_support_access_hash() cascade;
drop function if exists assert_credit_lot_balance(uuid) cascade;
drop function if exists assert_credit_usage_fully_allocated(uuid) cascade;
drop function if exists check_credit_usage_allocation_constraint() cascade;
drop function if exists enforce_stripe_webhook_signed_payload_immutable() cascade;
drop function if exists preserve_chat_company_id() cascade;
drop function if exists preserve_chat_memory_mode() cascade;
drop function if exists preserve_credit_usage_identity() cascade;
drop function if exists protect_clerk_user_lifecycle_order() cascade;
drop function if exists protect_ten_year_accounting_record() cascade;
drop function if exists protect_workspace_invitation_acceptance() cascade;
drop function if exists protect_workspace_invitation_lifecycle() cascade;
drop function if exists serialize_credit_company_write() cascade;
drop function if exists hartlib_ai_legacy_json_key(jsonb) cascade;
drop function if exists hartlib_ai_normalize_ranges(jsonb) cascade;
drop function if exists hartlib_ai_uuid_text(text) cascade;
drop function if exists set_ai_run_initiating_user() cascade;

-- Keep the durable memory model, but make its run and message links deletion
-- safe for the one-row message mutation contract.
alter table if exists user_memories
  drop constraint if exists user_memories_source_message_id_fkey;
alter table if exists user_memories
  add constraint user_memories_source_message_id_fkey
  foreign key (source_message_id) references chat_messages (id) on delete set null;
alter table if exists user_memory_revisions
  drop constraint if exists user_memory_revisions_run_id_fkey;
alter table if exists user_memory_revisions
  add constraint user_memory_revisions_run_id_fkey
  foreign key (run_id) references ai_runs (id) on delete set null;

-- Reset identity and operation rows are separate from the chat graph so an
-- old cookie can be revoked before its purge completes and retries can replay
-- the same successor without exposing either UUID in a response body.
drop table if exists demo_reset_operations cascade;
drop table if exists demo_sessions cascade;
create table demo_sessions (
  visitor_id uuid primary key,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index demo_sessions_active_idx on demo_sessions (visitor_id) where revoked_at is null;

create table demo_reset_operations (
  reset_operation_id uuid primary key,
  predecessor_visitor_id uuid references demo_sessions (visitor_id) on delete set null,
  successor_visitor_id uuid not null references demo_sessions (visitor_id) on delete restrict,
  purge_job_id uuid references jobs (id) on delete set null,
  created_at timestamptz not null default now()
);
create index demo_reset_operations_predecessor_idx on demo_reset_operations (predecessor_visitor_id);

-- The runner owns terminal queue state.  Purge jobs are durable and may retry
-- forever; the repository never turns them into a permanent failure after a
-- configured attempt count.
delete from jobs
where kind not in (
  'public_source_ingestion', 'ai_chat_run', 'purge_ai_runtime',
  'purge_user_memory_tombstones', 'demo_identity_purge'
);
alter table jobs
  drop constraint if exists jobs_kind_valid;
alter table jobs
  add constraint jobs_kind_valid check (
    kind in (
      'public_source_ingestion', 'ai_chat_run', 'purge_ai_runtime',
      'purge_user_memory_tombstones', 'demo_identity_purge'
    )
  );
alter table jobs
  drop constraint if exists demo_identity_purge_payload_shape;
alter table jobs
  add constraint demo_identity_purge_payload_shape check (
    kind <> 'demo_identity_purge'
    or jsonb_typeof(payload) = 'object'
       and (payload ?| array['visitorId'])
       and (payload - 'visitorId') = '{}'::jsonb
       and payload->>'visitorId' is not null
       and (payload->>'visitorId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );
alter table jobs
  drop constraint if exists demo_identity_purge_unique_key_shape;
alter table jobs
  add constraint demo_identity_purge_unique_key_shape check (
    kind <> 'demo_identity_purge'
    or (
      unique_key is not null
      and unique_key = 'demo-identity-purge:' || (payload->>'visitorId')
    )
  );
alter table jobs
  drop constraint if exists demo_identity_purge_unbounded_attempts;
alter table jobs
  add constraint demo_identity_purge_unbounded_attempts check (
    kind <> 'demo_identity_purge'
    or max_attempts = 2147483647
  );

commit;
