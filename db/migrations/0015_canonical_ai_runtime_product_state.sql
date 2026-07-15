create table if not exists client_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_companies_name_nonempty check (btrim(name) <> '')
);

create table if not exists client_company_memberships (
  company_id uuid not null references client_companies (id) on delete cascade,
  user_id text not null,
  role text not null,
  created_at timestamptz not null default now(),
  primary key (company_id, user_id),
  constraint client_company_memberships_role_valid check (role in ('admin', 'member')),
  constraint client_company_memberships_user_nonempty check (btrim(user_id) <> '')
);

create index if not exists client_company_memberships_user_idx
  on client_company_memberships (user_id, company_id);

create table if not exists client_company_ai_settings (
  company_id uuid primary key references client_companies (id) on delete cascade,
  web_search_enabled boolean not null default false,
  web_domain_allowlist text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_company_ai_settings_allowlist_nonempty
    check (web_domain_allowlist is null or cardinality(web_domain_allowlist) > 0),
  constraint client_company_ai_settings_allowlist_no_nulls
    check (web_domain_allowlist is null or array_position(web_domain_allowlist, null) is null)
);

insert into client_companies (id, name)
select distinct
  (
    substr(md5('brief:client-company:' || chats.user_id), 1, 8) || '-' ||
    substr(md5('brief:client-company:' || chats.user_id), 9, 4) || '-' ||
    substr(md5('brief:client-company:' || chats.user_id), 13, 4) || '-' ||
    substr(md5('brief:client-company:' || chats.user_id), 17, 4) || '-' ||
    substr(md5('brief:client-company:' || chats.user_id), 21, 12)
  )::uuid,
  'Client company for ' || chats.user_id
from chats
on conflict (id) do nothing;

insert into client_company_memberships (company_id, user_id, role)
select distinct
  (
    substr(md5('brief:client-company:' || chats.user_id), 1, 8) || '-' ||
    substr(md5('brief:client-company:' || chats.user_id), 9, 4) || '-' ||
    substr(md5('brief:client-company:' || chats.user_id), 13, 4) || '-' ||
    substr(md5('brief:client-company:' || chats.user_id), 17, 4) || '-' ||
    substr(md5('brief:client-company:' || chats.user_id), 21, 12)
  )::uuid,
  chats.user_id,
  'admin'
from chats
on conflict (company_id, user_id) do nothing;

insert into client_company_ai_settings (company_id)
select companies.id
from client_companies companies
where not exists (
  select 1
  from client_company_ai_settings settings
  where settings.company_id = companies.id
)
on conflict (company_id) do nothing;

alter table chats
  add column if not exists company_id uuid,
  add column if not exists memory_mode text;

update chats
set company_id = (
  substr(md5('brief:client-company:' || chats.user_id), 1, 8) || '-' ||
  substr(md5('brief:client-company:' || chats.user_id), 9, 4) || '-' ||
  substr(md5('brief:client-company:' || chats.user_id), 13, 4) || '-' ||
  substr(md5('brief:client-company:' || chats.user_id), 17, 4) || '-' ||
  substr(md5('brief:client-company:' || chats.user_id), 21, 12)
)::uuid
where company_id is null;

update chats
set memory_mode = 'private_owner'
where memory_mode is null;

alter table chats
  alter column company_id set not null,
  alter column memory_mode set default 'private_owner',
  alter column memory_mode set not null,
  add column if not exists shared_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chats_creator_membership_fkey'
  ) then
    alter table chats
      add constraint chats_creator_membership_fkey
      foreign key (company_id, user_id)
      references client_company_memberships (company_id, user_id);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'chats_memory_mode_valid'
  ) then
    alter table chats
      add constraint chats_memory_mode_valid
      check (memory_mode in ('private_owner', 'disabled'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'chats_shared_memory_mode_valid'
  ) then
    alter table chats
      add constraint chats_shared_memory_mode_valid
      check (shared_at is null or memory_mode = 'disabled');
  end if;
end
$$;

create or replace function preserve_chat_company_id()
returns trigger
language plpgsql
as $$
begin
  if new.company_id is distinct from old.company_id then
    raise exception 'chat company ownership is immutable'
      using errcode = '23514', constraint = 'chats_company_id_immutable';
  end if;

  return new;
end;
$$;

drop trigger if exists chats_preserve_company_id on chats;

create trigger chats_preserve_company_id
before update of company_id on chats
for each row
execute function preserve_chat_company_id();

create or replace function preserve_chat_memory_mode()
returns trigger
language plpgsql
as $$
begin
  if new.memory_mode is distinct from old.memory_mode then
    if old.memory_mode = 'private_owner' then
      raise exception 'a private-owner chat can never become shareable'
        using errcode = '23514', constraint = 'chats_private_owner_memory_mode_immutable';
    end if;

    if exists (select 1 from ai_runs where chat_id = old.id) then
      raise exception 'chat memory mode is immutable after its first accepted run'
        using errcode = '23514', constraint = 'chats_memory_mode_immutable_after_run';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists chats_preserve_memory_mode on chats;

create trigger chats_preserve_memory_mode
before update of memory_mode on chats
for each row
execute function preserve_chat_memory_mode();

alter table ai_runs
  add column if not exists initiating_user_id text,
  add column if not exists citation_nonce bytea default gen_random_bytes(16),
  add column if not exists next_event_seq integer default 1,
  add column if not exists web_search_enabled boolean default false,
  add column if not exists effective_web_policy jsonb
    default '{"enabled":false,"reason":"deployment_unavailable","allowlistActive":false}'::jsonb,
  add column if not exists error_code text,
  add column if not exists retryable boolean;

update ai_runs runs
set initiating_user_id = chats.user_id
from chats
where chats.id = runs.chat_id
  and runs.initiating_user_id is null;

update ai_runs
set citation_nonce = gen_random_bytes(16)
where citation_nonce is null
   or octet_length(citation_nonce) <> 16;

update ai_runs runs
set next_event_seq = greatest(1, events.next_seq)
from (
  select run_id, coalesce(max(seq), 0) + 1 as next_seq
  from ai_run_events
  group by run_id
) events
where events.run_id = runs.id;

update ai_runs
set next_event_seq = 1
where next_event_seq is null or next_event_seq < 1;

update ai_runs
set web_search_enabled = false
where web_search_enabled is null;

update ai_runs
set effective_web_policy =
  '{"enabled":false,"reason":"deployment_unavailable","allowlistActive":false}'::jsonb
where effective_web_policy is null
   or jsonb_typeof(effective_web_policy) <> 'object';

update ai_runs
set error_code = error
where error_code is null
  and error is not null;

update ai_runs
set retryable = false
where failed_at is not null
  and retryable is null;

alter table ai_runs
  alter column initiating_user_id set not null,
  alter column citation_nonce set not null,
  alter column next_event_seq set not null,
  alter column web_search_enabled set not null,
  alter column effective_web_policy set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ai_runs_citation_nonce_128_bit'
  ) then
    alter table ai_runs
      add constraint ai_runs_citation_nonce_128_bit
      check (octet_length(citation_nonce) = 16);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'ai_runs_next_event_seq_positive'
  ) then
    alter table ai_runs
      add constraint ai_runs_next_event_seq_positive
      check (next_event_seq >= 1);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'ai_runs_effective_web_policy_object'
  ) then
    alter table ai_runs
      add constraint ai_runs_effective_web_policy_object
      check (jsonb_typeof(effective_web_policy) = 'object');
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'ai_runs_one_terminal_timestamp'
  ) then
    alter table ai_runs
      add constraint ai_runs_one_terminal_timestamp
      check (not (finished_at is not null and failed_at is not null));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'ai_runs_failure_shape_valid'
  ) then
    alter table ai_runs
      add constraint ai_runs_failure_shape_valid
      check (
        (failed_at is null and error_code is null and retryable is null)
        or
        (failed_at is not null and error_code is not null and retryable is not null)
      );
  end if;
end
$$;

create or replace function set_ai_run_initiating_user()
returns trigger
language plpgsql
as $$
begin
  if new.initiating_user_id is null then
    select user_id
    into new.initiating_user_id
    from chats
    where id = new.chat_id;
  end if;

  return new;
end;
$$;

drop trigger if exists ai_runs_set_initiating_user on ai_runs;

create trigger ai_runs_set_initiating_user
before insert on ai_runs
for each row
execute function set_ai_run_initiating_user();

drop index if exists ai_runs_active_chat_key;

create temporary table if not exists canonical_ai_run_duplicate_ids (
  id uuid primary key
) on commit drop;

truncate table canonical_ai_run_duplicate_ids;

insert into canonical_ai_run_duplicate_ids (id)
select id
from (
  select
    id,
    row_number() over (
      partition by user_message_id
      order by created_at, id
    ) as duplicate_rank
  from ai_runs
) ranked_runs
where duplicate_rank > 1;

update ai_runs
set assistant_message_id = null
where id in (select id from canonical_ai_run_duplicate_ids);

delete from chat_messages
where author = 'assistant'
  and ai_run_id in (select id from canonical_ai_run_duplicate_ids);

update chat_messages
set ai_run_id = null
where ai_run_id in (select id from canonical_ai_run_duplicate_ids);

update user_memory_revisions
set run_id = null
where run_id in (select id from canonical_ai_run_duplicate_ids);

delete from ai_run_events
where run_id in (select id from canonical_ai_run_duplicate_ids);

delete from chat_context_blocks
where created_by_run_id in (select id from canonical_ai_run_duplicate_ids)
   or last_cited_run_id in (select id from canonical_ai_run_duplicate_ids);

delete from ai_observations
where run_id in (select id from canonical_ai_run_duplicate_ids);

delete from ai_runs
where id in (select id from canonical_ai_run_duplicate_ids);

create unique index if not exists ai_runs_active_chat_key
  on ai_runs (chat_id)
  where finished_at is null and failed_at is null;

create unique index if not exists ai_runs_active_initiating_user_key
  on ai_runs (initiating_user_id)
  where finished_at is null and failed_at is null;

create unique index if not exists ai_runs_user_message_key
  on ai_runs (user_message_id);

create unique index if not exists ai_runs_assistant_message_key
  on ai_runs (assistant_message_id)
  where assistant_message_id is not null;

create unique index if not exists ai_runs_smithers_run_key
  on ai_runs (smithers_run_id)
  where smithers_run_id is not null;

alter table ai_runs
  drop column if exists usage,
  drop column if exists error;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'chat_messages'
      and column_name = 'ai_run_id'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'chat_messages'
      and column_name = 'assistant_ai_run_id'
  ) then
    alter table chat_messages rename column ai_run_id to assistant_ai_run_id;
  end if;
end
$$;

create unique index if not exists chat_messages_assistant_ai_run_key
  on chat_messages (assistant_ai_run_id)
  where assistant_ai_run_id is not null;

alter table ai_run_events
  add column if not exists emission_key text;

update ai_run_events
set emission_key = 'backfill:event:' || seq::text
where emission_key is null;

with latest_terminal as (
  select distinct on (run_id) id
  from ai_run_events
  where event->>'type' in ('done', 'error')
  order by run_id, seq desc
)
update ai_run_events events
set emission_key = 'terminal'
from latest_terminal
where latest_terminal.id = events.id;

with first_started as (
  select distinct on (run_id) id
  from ai_run_events
  where event->>'type' = 'run_started'
  order by run_id, seq
)
update ai_run_events events
set emission_key = 'run_started'
from first_started
where first_started.id = events.id;

alter table ai_run_events
  alter column emission_key set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ai_run_events_emission_key_nonempty'
  ) then
    alter table ai_run_events
      add constraint ai_run_events_emission_key_nonempty
      check (btrim(emission_key) <> '');
  end if;
end
$$;

create unique index if not exists ai_run_events_run_emission_key
  on ai_run_events (run_id, emission_key);

create table if not exists ai_smithers_orphan_candidates (
  smithers_run_id text primary key,
  first_seen_at timestamptz not null default now(),
  constraint ai_smithers_orphan_candidates_run_nonempty
    check (btrim(smithers_run_id) <> '')
);

create table if not exists ai_source_exposures (
  id bigint generated always as identity primary key,
  run_id uuid not null references ai_runs (id) on delete cascade,
  task_id text not null,
  loop_iteration integer not null,
  attempt integer not null,
  provider_request_index integer not null,
  source_kind text not null,
  logical_source_identity text not null,
  publisher_issue_id text,
  publisher_document_id text,
  content_item_identity text not null,
  exposure_stage text not null,
  visible_token_count integer not null,
  created_at timestamptz not null default now(),
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

create index if not exists ai_source_exposures_run_item_idx
  on ai_source_exposures (run_id, source_kind, content_item_identity);

create index if not exists ai_source_exposures_publisher_issue_idx
  on ai_source_exposures (run_id, publisher_issue_id)
  where publisher_issue_id is not null;

create index if not exists ai_source_exposures_publisher_document_idx
  on ai_source_exposures (run_id, publisher_document_id)
  where publisher_document_id is not null;

create table if not exists assistant_message_sources (
  assistant_message_id uuid not null references chat_messages (id) on delete cascade,
  source_key text not null,
  kind text not null,
  locator jsonb not null,
  document_version_id text references public_source_documents (document_id),
  message_id uuid references chat_messages (id),
  memory_revision_id uuid,
  display_label text,
  public_provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (assistant_message_id, source_key),
  constraint assistant_message_sources_kind_valid
    check (kind in ('document', 'chat_message', 'memory', 'web')),
  constraint assistant_message_sources_json_valid
    check (
      jsonb_typeof(locator) = 'object'
      and locator->>'kind' = kind
      and jsonb_typeof(public_provenance) = 'object'
    ),
  constraint assistant_message_sources_typed_identity_valid
    check (
      (kind = 'document' and document_version_id is not null and message_id is null and memory_revision_id is null)
      or
      (kind = 'chat_message' and document_version_id is null and message_id is not null and memory_revision_id is null)
      or
      (kind = 'memory' and document_version_id is null and message_id is null and memory_revision_id is not null)
      or
      (kind = 'web' and document_version_id is null and message_id is null and memory_revision_id is null)
    )
);

create index if not exists assistant_message_sources_document_version_idx
  on assistant_message_sources (document_version_id)
  where document_version_id is not null;

create index if not exists assistant_message_sources_message_idx
  on assistant_message_sources (message_id)
  where message_id is not null;

create index if not exists assistant_message_sources_memory_revision_idx
  on assistant_message_sources (memory_revision_id)
  where memory_revision_id is not null;

create table if not exists assistant_message_source_uses (
  assistant_message_id uuid not null,
  source_key text not null,
  consumer_task_id text not null,
  topic_id text,
  rendered_token_count integer not null,
  context_order integer not null,
  ranges jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  primary key (assistant_message_id, source_key, consumer_task_id),
  constraint assistant_message_source_uses_source_fkey
    foreign key (assistant_message_id, source_key)
    references assistant_message_sources (assistant_message_id, source_key)
    on delete cascade,
  constraint assistant_message_source_uses_topic_valid
    check (topic_id is null or topic_id in ('t1', 't2', 't3')),
  constraint assistant_message_source_uses_counts_valid
    check (rendered_token_count >= 0 and context_order >= 0),
  constraint assistant_message_source_uses_ranges_array
    check (jsonb_typeof(ranges) = 'array')
);

alter table ai_observations
  add column if not exists emitting_task text,
  add column if not exists loop_iteration integer,
  add column if not exists attempt integer,
  add column if not exists observation_key text;

update ai_observations
set emitting_task = coalesce(emitting_task, 'migration_backfill'),
    loop_iteration = coalesce(loop_iteration, 0),
    attempt = coalesce(attempt, 0),
    observation_key = coalesce(observation_key, 'backfill:observation:' || id::text);

alter table ai_observations
  alter column emitting_task set not null,
  alter column loop_iteration set not null,
  alter column attempt set not null,
  alter column observation_key set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ai_observations_coordinates_nonnegative'
  ) then
    alter table ai_observations
      add constraint ai_observations_coordinates_nonnegative
      check (loop_iteration >= 0 and attempt >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'ai_observations_keys_nonempty'
  ) then
    alter table ai_observations
      add constraint ai_observations_keys_nonempty
      check (btrim(emitting_task) <> '' and btrim(observation_key) <> '');
  end if;
end
$$;

create unique index if not exists ai_observations_run_observation_key
  on ai_observations (run_id, observation_key);

create table if not exists ai_run_usage (
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
  constraint ai_run_usage_coordinates_nonnegative
    check (loop_iteration >= 0 and attempt >= 0 and provider_request_index >= 0),
  constraint ai_run_usage_tokens_nonnegative
    check (
      input_tokens >= 0
      and output_tokens >= 0
      and cached_tokens >= 0
      and reasoning_tokens >= 0
      and total_tokens >= 0
    ),
  constraint ai_run_usage_identity_nonempty
    check (
      btrim(task_id) <> ''
      and btrim(agent_role) <> ''
      and btrim(model_id) <> ''
      and btrim(stop_reason) <> ''
    ),
  unique (run_id, task_id, loop_iteration, attempt, provider_request_index)
);

create index if not exists ai_run_usage_run_idx
  on ai_run_usage (run_id);

create table if not exists ai_external_tool_usage (
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
  created_at timestamptz not null default now(),
  constraint ai_external_tool_usage_coordinates_nonnegative
    check (loop_iteration >= 0 and attempt >= 0 and tool_request_index >= 0),
  constraint ai_external_tool_usage_metrics_nonnegative
    check (
      result_count >= 0
      and response_bytes >= 0
      and (billed_units is null or billed_units >= 0)
      and duration_ms >= 0
    ),
  constraint ai_external_tool_usage_operation_valid
    check (operation in ('web_search', 'web_fetch')),
  constraint ai_external_tool_usage_status_valid
    check (status in ('ok', 'empty', 'failed')),
  constraint ai_external_tool_usage_identity_nonempty
    check (btrim(task_id) <> '' and btrim(provider_service_id) <> ''),
  unique (run_id, task_id, loop_iteration, attempt, tool_request_index)
);

create index if not exists ai_external_tool_usage_run_idx
  on ai_external_tool_usage (run_id);

alter table user_memory_revisions
  add column if not exists state_before jsonb,
  add column if not exists state_after jsonb;

update user_memory_revisions revisions
set state_before = case
      when revisions.action = 'created' then null
      else jsonb_build_object(
        'kind', memories.kind,
        'content', coalesce(revisions.content_before, memories.content),
        'deleted', false
      )
    end,
    state_after = jsonb_build_object(
      'kind', memories.kind,
      'content', coalesce(revisions.content_after, memories.content),
      'deleted', revisions.action = 'deleted'
    )
from user_memories memories
where memories.id = revisions.memory_id
  and revisions.state_after is null;

alter table user_memory_revisions
  drop constraint if exists user_memory_revisions_action_valid;

update user_memory_revisions
set action = case action
  when 'created' then 'create'
  when 'updated' then 'update'
  when 'deleted' then 'delete'
  when 'reverted' then 'revert'
  else action
end;

insert into user_memory_revisions (memory_id, action, state_before, state_after, run_id, created_at)
select
  memories.id,
  'create',
  null,
  jsonb_build_object(
    'kind', memories.kind,
    'content', memories.content,
    'deleted', memories.deleted_at is not null
  ),
  null,
  memories.created_at
from user_memories memories
where not exists (
  select 1
  from user_memory_revisions revisions
  where revisions.memory_id = memories.id
);

alter table user_memory_revisions
  alter column state_after set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_memory_revisions_action_valid'
  ) then
    alter table user_memory_revisions
      add constraint user_memory_revisions_action_valid
      check (action in ('create', 'update', 'delete', 'revert'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'user_memory_revisions_state_valid'
  ) then
    alter table user_memory_revisions
      add constraint user_memory_revisions_state_valid
      check (
        jsonb_typeof(state_after) = 'object'
        and state_after->>'kind' in ('profile', 'preference', 'instruction', 'fact', 'episode')
        and jsonb_typeof(state_after->'content') = 'string'
        and btrim(state_after->>'content') <> ''
        and jsonb_typeof(state_after->'deleted') = 'boolean'
        and (
          state_before is null
          or (
            jsonb_typeof(state_before) = 'object'
            and state_before->>'kind' in ('profile', 'preference', 'instruction', 'fact', 'episode')
            and jsonb_typeof(state_before->'content') = 'string'
            and btrim(state_before->>'content') <> ''
            and jsonb_typeof(state_before->'deleted') = 'boolean'
          )
        )
      );
  end if;
end
$$;

alter table user_memories
  add column if not exists head_revision_id uuid,
  add column if not exists provenance_only_at timestamptz;

update user_memories memories
set head_revision_id = heads.id
from (
  select distinct on (memory_id) memory_id, id
  from user_memory_revisions
  order by memory_id, created_at desc, id desc
) heads
where heads.memory_id = memories.id
  and memories.head_revision_id is null;

update user_memory_revisions
set state_before = case
      when state_before is null then null
      else jsonb_set(state_before, '{content}', to_jsonb(btrim(state_before->>'content')))
    end,
    state_after = jsonb_set(state_after, '{content}', to_jsonb(btrim(state_after->>'content')));

update user_memories memories
set kind = revisions.state_after->>'kind',
    content = btrim(revisions.state_after->>'content'),
    deleted_at = case
      when (revisions.state_after->>'deleted')::boolean then coalesce(memories.deleted_at, now())
      else null
    end
from user_memory_revisions revisions
where revisions.id = memories.head_revision_id;

alter table user_memories
  alter column kind drop not null,
  alter column content drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_memories_head_revision_id_fkey'
  ) then
    alter table user_memories
      add constraint user_memories_head_revision_id_fkey
      foreign key (head_revision_id)
      references user_memory_revisions (id)
      deferrable initially deferred;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'user_memories_state_valid'
  ) then
    alter table user_memories
      add constraint user_memories_state_valid
      check (
        (
          provenance_only_at is null
          and kind is not null
          and content is not null
          and btrim(content) <> ''
          and head_revision_id is not null
        )
        or
        (
          provenance_only_at is not null
          and kind is null
          and content is null
          and head_revision_id is null
          and source_message_id is null
          and deleted_at is not null
        )
      );
  end if;
end
$$;

drop index if exists user_memories_user_idx;

create temporary table if not exists canonical_duplicate_active_memories (
  id uuid primary key
) on commit drop;

truncate table canonical_duplicate_active_memories;

insert into canonical_duplicate_active_memories (id)
select id
from (
  select
    id,
    row_number() over (
      partition by user_id, kind, btrim(content)
      order by created_at, id
    ) as duplicate_rank
  from user_memories
  where deleted_at is null and provenance_only_at is null
) ranked_memories
where duplicate_rank > 1;

delete from user_memories
where id in (select id from canonical_duplicate_active_memories);

create index if not exists user_memories_user_active_idx
  on user_memories (user_id, updated_at desc)
  where deleted_at is null and provenance_only_at is null;

create unique index if not exists user_memories_active_exact_key
  on user_memories (user_id, kind, btrim(content))
  where deleted_at is null and provenance_only_at is null;

create index if not exists user_memories_tombstone_gc_idx
  on user_memories (deleted_at)
  where deleted_at is not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'assistant_message_sources_memory_revision_fkey'
  ) then
    alter table assistant_message_sources
      add constraint assistant_message_sources_memory_revision_fkey
      foreign key (memory_revision_id)
      references user_memory_revisions (id);
  end if;
end
$$;

alter table user_memory_revisions
  drop column if exists content_before,
  drop column if exists content_after;

drop table if exists chat_context_blocks;
