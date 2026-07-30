-- Phase E durable retrieval/compaction cutover.
-- The migration runs under the worker migration transaction.  The first block
-- takes the shared producer fence, locks every affected relation in one
-- bytewise-sorted list, and performs every refusal and retained-row preflight
-- before this file makes a schema or data change.


do $$
declare
  relation_name text;
  row_count bigint;
  run_count bigint;
  row_data record;
  range_data record;
  range_start bigint;
  range_end bigint;
  previous_end bigint;
  sanitized_content text;
  cursor_position integer;
  marker_start integer;
  marker_end integer;
  sanitizer_remainder text;
  sanitized_length integer;
  source_run_count bigint;
  base_message_id text;
  lock_names text[] := array[
    -- Product relations touched by the conversion and its durable seals.
    'ai_evaluation_annotations', 'ai_evaluation_case_runs',
    'ai_evaluation_sessions', 'ai_external_tool_usage', 'ai_execution_seeds',
    'ai_observations', 'ai_run_events', 'ai_run_usage', 'ai_runs',
    'ai_source_exposures', 'ai_task_outputs', 'assistant_message_sources',
    'assistant_message_source_uses', 'brief_document_extractions',
    'brief_document_versions', 'brief_documents', 'chat_context_blocks',
    'chat_messages', 'chats', 'public_source_documents', 'user_memories',
    'user_memory_revisions',
    -- Current producer outputs and all 0070-era disposable names.  The
    -- current producer recreates the clean schemas after this transaction.
    '_smithers_runs', 'ai_chat_allocation', 'ai_chat_answer',
    'ai_chat_assembly', 'ai_chat_compaction_collect', 'ai_chat_compaction_group',
    'ai_chat_compaction_plan', 'ai_chat_context', 'ai_chat_fallback_plan',
    'ai_chat_fanout_collect', 'ai_chat_fanout_contexts', 'ai_chat_fanout_sources',
    'ai_chat_finalize', 'ai_chat_hydrate', 'ai_chat_hydrate2',
    'ai_chat_internal', 'ai_chat_load_turn', 'ai_chat_memories',
    'ai_chat_memory', 'ai_chat_plan', 'ai_chat_plan_turn',
    'ai_chat_preflight', 'ai_chat_preflight2', 'ai_chat_reduction_plan',
    'ai_chat_resolution', 'ai_chat_selectors', 'ai_chat_structured_internal',
    'ai_chat_topic_result', 'ai_chat_web', 'ai_evaluation_general_planner'
  ];
begin
  perform pg_advisory_xact_lock(
    hashtextextended('brief:ai-chat:smithers-schema', 0)
  );

  -- This is the documented bytewise-sorted lock list.  Missing Smithers
  -- tables are safe because the advisory fence prevents their producer from
  -- creating one until this transaction commits.
  for relation_name in
    select name from unnest(lock_names) as names(name) order by name collate "C"
  loop
    if to_regclass(format('public.%I', relation_name)) is not null then
      execute format('lock table public.%I in access exclusive mode', relation_name);
    end if;
  end loop;

  if to_regclass('public.ai_runs') is not null then
    select count(*) into run_count
    from ai_runs
    where finished_at is null and failed_at is null;
    if run_count <> 0 then
      raise exception
        'AI retrieval/compaction migration requires terminal product AI runs (% active rows remain)',
        run_count using errcode = '55000';
    end if;
  end if;

  if to_regclass('public._smithers_runs') is not null then
    execute 'select count(*) from public._smithers_runs' into row_count;
    if row_count <> 0 then
      raise exception
        'AI retrieval/compaction migration requires drained Smithers runs (% run rows remain)',
        row_count using errcode = '55000';
    end if;
  end if;

  -- Every output relation is disposable, but none may be discarded while it
  -- contains state.  Count all names, including old names absent from the
  -- current workflow, before the first DROP below.
  for relation_name in
    select name from unnest(lock_names) as names(name)
    where name <> '_smithers_runs'
      and name like 'ai_chat_%'
      or name = 'ai_evaluation_general_planner'
    order by name collate "C"
  loop
    if to_regclass(format('public.%I', relation_name)) is not null then
      execute format('select count(*) from public.%I', relation_name) into row_count;
      if row_count <> 0 then
        raise exception
          'AI retrieval/compaction migration requires drained Smithers output table % (% rows remain)',
          relation_name, row_count using errcode = '55000';
      end if;
    end if;
  end loop;

  if to_regclass('public.ai_evaluation_sessions') is not null then
    select count(*) into row_count
    from ai_evaluation_sessions
    where artifact_version = 3
      and golden_set_version = 3
      and status not in ('complete', 'failed');
    if row_count <> 0 then
      raise exception
        'cannot install evaluation v4 contract while % nonterminal v3 session(s) remain',
        row_count using errcode = '55000';
    end if;
  end if;

  -- Preflight every retained chat source use.  Empty ranges are the legacy
  -- whole-source form and are converted only when the source and its message
  -- identify one unambiguous same-chat record.
  for row_data in
    select
      uses.assistant_message_id,
      uses.source_key,
      uses.consumer_task_id,
      uses.topic_id,
      uses.context_order,
      uses.rendered_token_count,
      uses.ranges,
      uses.source_use_identity_digest,
      sources.kind as source_kind,
      sources.message_id as source_message_id,
      sources.locator as source_locator,
      assistants.author as assistant_author,
      assistants.chat_id as assistant_chat_id,
      assistants.content as assistant_content,
      referenced.id as referenced_message_id,
      referenced.chat_id as referenced_chat_id,
      referenced.author as referenced_author,
      referenced.content as referenced_content,
      referenced.created_at as referenced_created_at,
      assistants.created_at as assistant_created_at,
      runs.citation_namespace as run_citation_namespace,
      runs.chat_id as run_chat_id
    from assistant_message_source_uses uses
    left join assistant_message_sources sources
      on sources.assistant_message_id = uses.assistant_message_id
     and sources.source_key = uses.source_key
    left join chat_messages assistants on assistants.id = uses.assistant_message_id
    left join chat_messages referenced on referenced.id = sources.message_id
    left join ai_runs runs on runs.assistant_message_id = uses.assistant_message_id
    order by uses.assistant_message_id, uses.source_key, uses.consumer_task_id collate "C"
  loop
    if row_data.source_use_identity_digest is null
       or row_data.source_use_identity_digest is distinct from
          assistant_message_source_use_identity_digest(
            row_data.assistant_message_id, row_data.source_key,
            row_data.consumer_task_id, row_data.topic_id,
            row_data.rendered_token_count, row_data.context_order,
            row_data.ranges
          ) then
      raise exception
        'AI retrieval/compaction preflight row assistant_message_source_uses/%/%/%: source-use identity digest is invalid',
        row_data.assistant_message_id, row_data.source_key, row_data.consumer_task_id;
    end if;

    if row_data.source_kind is null then
      raise exception
        'AI retrieval/compaction preflight row assistant_message_source_uses/%/%/%: source has no exact owner',
        row_data.assistant_message_id, row_data.source_key, row_data.consumer_task_id;
    end if;
    if row_data.source_kind <> 'chat_message' then
      continue;
    end if;

    if row_data.assistant_author is distinct from 'assistant' then
      raise exception
        'AI retrieval/compaction preflight row assistant_message_source_uses/%/%/%: owner is not an assistant message',
        row_data.assistant_message_id, row_data.source_key, row_data.consumer_task_id;
    end if;

    select count(*) into source_run_count
    from ai_runs runs
    where runs.assistant_message_id = row_data.assistant_message_id
      and runs.chat_id = row_data.assistant_chat_id;
    if source_run_count <> 1 then
      raise exception
        'AI retrieval/compaction preflight row assistant_message_source_uses/%/%/%: assistant has % exact run owners',
        row_data.assistant_message_id, row_data.source_key, row_data.consumer_task_id,
        source_run_count;
    end if;

    if row_data.source_message_id is null
       or row_data.referenced_message_id is null
       or row_data.referenced_chat_id is distinct from row_data.assistant_chat_id
       or row_data.run_chat_id is distinct from row_data.assistant_chat_id then
      raise exception
        'AI retrieval/compaction preflight row assistant_message_source_uses/%/%/%: chat source message is missing or foreign',
        row_data.assistant_message_id, row_data.source_key, row_data.consumer_task_id;
    end if;

    if row_data.source_locator is null
       or jsonb_typeof(row_data.source_locator) is distinct from 'object'
       or row_data.source_locator->>'kind' is distinct from 'chat_message'
       or row_data.source_locator->>'messageId' is distinct from row_data.source_message_id::text
       or (row_data.source_locator - 'kind' - 'messageId') <> '{}'::jsonb then
      raise exception
        'AI retrieval/compaction preflight row assistant_message_source_uses/%/%/%: chat locator and message_id disagree',
        row_data.assistant_message_id, row_data.source_key, row_data.consumer_task_id;
    end if;

    if jsonb_typeof(row_data.ranges) is distinct from 'array' then
      raise exception
        'AI retrieval/compaction preflight row assistant_message_source_uses/%/%/%: ranges must be an array',
        row_data.assistant_message_id, row_data.source_key, row_data.consumer_task_id;
    end if;
    if row_data.referenced_created_at is null
       or row_data.assistant_created_at is null
       or row_data.referenced_created_at >= row_data.assistant_created_at then
      raise exception
        'AI retrieval/compaction preflight row assistant_message_source_uses/%/%/%: chat source message must precede its assistant',
        row_data.assistant_message_id, row_data.source_key, row_data.consumer_task_id;
    end if;
    if row_data.run_citation_namespace is null
       or row_data.source_key !~ ('^k_' || row_data.run_citation_namespace || '_[1-9][0-9]*$') then
      raise exception
        'AI retrieval/compaction preflight row assistant_message_source_uses/%/%/%: source key index is not bound to its run',
        row_data.assistant_message_id, row_data.source_key, row_data.consumer_task_id;
    end if;
    if row_data.referenced_author = 'assistant' then
      sanitized_content := '';
      cursor_position := 1;
      loop
        marker_start := strpos(
          substring(row_data.referenced_content from cursor_position), '[[cite:'
        );
        if marker_start = 0 then
          sanitized_content := sanitized_content
            || substring(row_data.referenced_content from cursor_position);
          exit;
        end if;
        marker_start := cursor_position + marker_start - 1;
        sanitized_content := sanitized_content
          || substring(row_data.referenced_content from cursor_position
                       for marker_start - cursor_position);
        sanitizer_remainder := substring(row_data.referenced_content from marker_start + 7);
        marker_end := strpos(sanitizer_remainder, ']]');
        if marker_end = 0 then
          exit;
        end if;
        cursor_position := marker_start + 7 + marker_end + 1;
      end loop;
    else
      sanitized_content := row_data.referenced_content;
    end if;
    sanitized_length := brief_ai_utf16_length(sanitized_content);
    previous_end := null;

    for range_data in
      select value as item, ordinal
      from jsonb_array_elements(row_data.ranges) with ordinality values(value, ordinal)
      order by ordinal
    loop
      if jsonb_typeof(range_data.item) is distinct from 'object'
         or exists (
              select 1 from jsonb_object_keys(range_data.item) key
              where key not in ('charStart', 'charEnd')
            )
         or range_data.item->>'charStart' !~ '^[0-9]+$'
         or range_data.item->>'charEnd' !~ '^[0-9]+$' then
        raise exception
          'AI retrieval/compaction preflight row assistant_message_source_uses/%/%/%: chat range syntax is invalid',
          row_data.assistant_message_id, row_data.source_key, row_data.consumer_task_id;
      end if;
      range_start := brief_ai_safe_bigint(range_data.item->>'charStart');
      range_end := brief_ai_safe_bigint(range_data.item->>'charEnd');
      if range_start is null or range_end is null
         or range_start < 0 or range_end <= range_start
         or range_end > sanitized_length
         or (previous_end is not null and range_start <= previous_end) then
        raise exception
          'AI retrieval/compaction preflight row assistant_message_source_uses/%/%/%: chat range is outside sanitized UTF-16 text or overlaps a prior range',
          row_data.assistant_message_id, row_data.source_key, row_data.consumer_task_id;
      end if;
      previous_end := range_end;
    end loop;

    if jsonb_array_length(row_data.ranges) = 0 and sanitized_length = 0 then
      raise exception
        'AI retrieval/compaction preflight row assistant_message_source_uses/%/%/%: sanitized chat source is empty',
        row_data.assistant_message_id, row_data.source_key, row_data.consumer_task_id;
    end if;
  end loop;
end
$$;
-- The permanent sanitizer is created only after the fence and all retained
-- source rows have passed the local literal-scan preflight above.
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

-- Chat search uses the same historical citation sanitization as the runtime
-- compiler.  User messages remain raw; assistant citation presentation is not
-- searchable evidence.
alter table chat_messages
  add column if not exists search_vector tsvector generated always as (
    to_tsvector(
      'simple'::regconfig,
      case when author = 'assistant' then
        brief_ai_strip_historical_citation_tags(content)
      else content end
    )
  ) stored;

create index if not exists chat_messages_search_vector_idx
  on chat_messages using gin (search_vector);

create index if not exists chat_messages_chat_created_id_idx
  on chat_messages (chat_id, created_at, id);

alter table ai_source_exposures
  add column if not exists chat_content_hash text,
  add column if not exists chat_ranges jsonb;

-- Keep old v3 rows readable while rejecting every new row that omits the
-- private chat reconstruction proof.  The range predicate is deliberately
-- inline so no conversion helper remains after the migration.
-- Strict shape is permanent because the NOT VALID CHECK depends on it; bounds
-- are checked against the bound message text by the trigger below.
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
alter table ai_source_exposures
  drop constraint if exists ai_source_exposures_chat_reconstruction_consistent,
  add constraint ai_source_exposures_chat_reconstruction_consistent
  check (
    (
      source_kind = 'chat_message'
      and chat_content_hash ~ '^[0-9a-f]{64}$'
      and brief_valid_chat_exposure_ranges(chat_ranges)
    )
    or (
      source_kind <> 'chat_message'
      and chat_content_hash is null
      and chat_ranges is null
    )
  ) not valid;

-- Bind v4 exposure proofs to immutable message text.  This trigger is the
-- database boundary that cannot be expressed by a row-local CHECK.
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

  -- A historical v3 row remains readable.  New rows cannot take this path:
  -- the NOT VALID CHECK rejects them before commit.
  if tg_op = 'UPDATE'
     and old.source_kind = 'chat_message'
     and old.chat_content_hash is null
     and old.chat_ranges is null
     and new.chat_content_hash is null
     and new.chat_ranges is null then
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
       or (previous_end is not null and start_value <= previous_end) then
      raise exception 'chat source exposure ranges exceed citation-sanitized UTF-16 text'
        using errcode = '23514', constraint = 'ai_source_exposures_chat_reconstruction_consistent';
    end if;
    previous_end := end_value;
  end loop;
  return new;
end
$$;

drop trigger if exists ai_source_exposures_validate_chat on ai_source_exposures;
create trigger ai_source_exposures_validate_chat
before insert or update of run_id, source_kind, logical_source_identity,
  content_item_identity, chat_content_hash, chat_ranges
on ai_source_exposures
for each row execute function enforce_ai_chat_source_exposure();

-- The source-use identity trigger intentionally rejects UPDATE.  The bounded
-- rewrite is now safe because the first block validated every row and all
-- affected tables remain locked under the advisory fence.
-- Rebind chat source-use validation to the retained source message.  The
-- 0064 validator remains exact for documents; memory and web uses stay empty.
create or replace function validate_assistant_message_source_use_ranges()
returns trigger
language plpgsql
as $$
declare
  source_row record;
  text_length integer;
  sanitized text;
  item jsonb;
  start_value bigint;
  end_value bigint;
  previous_end bigint;
begin
  if jsonb_typeof(new.ranges) is distinct from 'array'
     or exists (
       select 1
       from jsonb_array_elements(new.ranges) range_row
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
  if exists (
    select 1
    from jsonb_array_elements(new.ranges) with ordinality left_range(range_row, ordinal)
    join jsonb_array_elements(new.ranges) with ordinality right_range(range_row, ordinal)
      on right_range.ordinal = left_range.ordinal + 1
    where brief_ai_safe_bigint(right_range.range_row->>'charStart') <=
          brief_ai_safe_bigint(left_range.range_row->>'charEnd')
  ) then
    raise exception 'assistant message source-use ranges overlap, touch, or are not normalized';
  end if;

  select
    sources.kind,
    sources.locator,
    sources.snapshot_id,
    sources.publisher_extraction_id,
    sources.document_source_id,
    sources.document_id,
    sources.content_hash,
    messages.chat_id as source_chat_id,
    messages.author as source_author,
    messages.content as source_content,
    assistants.chat_id as assistant_chat_id
  into source_row
  from assistant_message_sources sources
  left join chat_messages messages on messages.id = sources.message_id
  left join chat_messages assistants on assistants.id = new.assistant_message_id
  where sources.assistant_message_id = new.assistant_message_id
    and sources.source_key = new.source_key;
  if not found then
    raise exception 'assistant message source-use has no owning source';
  end if;
  if source_row.kind = 'document' then
    if source_row.publisher_extraction_id is null then
      select brief_ai_utf16_length(documents.text)
        into text_length
      from public_source_documents documents
      where documents.source_id::text = substring(source_row.document_source_id from 8)
        and documents.document_id = source_row.snapshot_id
        and source_row.document_id = documents.document_id
        and source_row.content_hash = documents.content_hash
        and source_row.locator->>'sourceId' = source_row.document_source_id
        and source_row.locator->>'documentId' = source_row.document_id
        and source_row.locator->>'snapshotId' = source_row.snapshot_id
        and source_row.locator->>'contentHash' = source_row.content_hash;
    else
      select brief_ai_utf16_length(versions.canonical_text)
        into text_length
      from brief_document_versions versions
      join brief_document_extractions extractions
        on extractions.id = source_row.publisher_extraction_id
       and versions.publisher_extraction_id = extractions.id
      join brief_documents documents on documents.id = versions.brief_document_id
      join publisher_issues issues on issues.id = documents.issue_id
      join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
      where versions.id::text = source_row.snapshot_id
        and source_row.document_source_id = 'publisher:' || subscriptions.id::text
        and source_row.document_id = versions.brief_document_id::text
        and source_row.content_hash = versions.content_hash
        and source_row.locator->>'sourceId' = source_row.document_source_id
        and source_row.locator->>'documentId' = source_row.document_id
        and source_row.locator->>'snapshotId' = source_row.snapshot_id
        and source_row.locator->>'publisherIssueId' = issues.id::text
        and source_row.locator->>'publisherDocumentId' = documents.id::text
        and source_row.locator->>'publisherExtractionId' = source_row.publisher_extraction_id::text
        and source_row.locator->>'contentHash' = source_row.content_hash;
    end if;
    if text_length is null
       or exists (
         select 1
         from jsonb_array_elements(new.ranges) range_row
         where brief_ai_safe_bigint(range_row->>'charEnd') > text_length
           or not exists (
             select 1
             from jsonb_array_elements(source_row.locator->'ranges') locator_range
             where brief_ai_safe_bigint(range_row->>'charStart') >=
                     brief_ai_safe_bigint(locator_range->>'charStart')
               and brief_ai_safe_bigint(range_row->>'charEnd') <=
                     brief_ai_safe_bigint(locator_range->>'charEnd')
           )
       ) then
      raise exception 'assistant message source-use range is outside immutable source text';
    end if;
    return new;
  end if;
  if source_row.kind <> 'chat_message' then
    if jsonb_array_length(new.ranges) <> 0 then
      raise exception 'non-document source-use ranges must be empty';
    end if;
    return new;
  end if;
  if source_row.source_chat_id is null
     or source_row.assistant_chat_id is distinct from source_row.source_chat_id then
    raise exception 'chat source-use message is missing or foreign';
  end if;
  sanitized := case when source_row.source_author = 'assistant' then
    brief_ai_strip_historical_citation_tags(source_row.source_content)
    else source_row.source_content end;
  text_length := brief_ai_utf16_length(sanitized);
  if text_length = 0 or jsonb_array_length(new.ranges) = 0 then
    raise exception 'chat source-use ranges must be non-empty over non-empty source text';
  end if;
  previous_end := null;
  for item in select value from jsonb_array_elements(new.ranges) loop
    start_value := brief_ai_safe_bigint(item->>'charStart');
    end_value := brief_ai_safe_bigint(item->>'charEnd');
    if start_value is null or end_value is null
       or start_value < 0 or end_value <= start_value
       or end_value > text_length
       or (previous_end is not null and start_value <= previous_end) then
      raise exception 'chat source-use range is outside sanitized UTF-16 source text';
    end if;
    previous_end := end_value;
  end loop;
  return new;
end
$$;
create temporary table brief_ai_0072_legacy_chat_uses (
  assistant_message_id uuid not null,
  source_key text not null,
  consumer_task_id text not null,
  topic_id text
) on commit drop;
insert into brief_ai_0072_legacy_chat_uses (
  assistant_message_id, source_key, consumer_task_id, topic_id
)
select uses.assistant_message_id, uses.source_key, uses.consumer_task_id,
       uses.topic_id
from assistant_message_source_uses uses
join assistant_message_sources sources
  on sources.assistant_message_id = uses.assistant_message_id
 and sources.source_key = uses.source_key
where sources.kind = 'chat_message'
  and jsonb_array_length(uses.ranges) = 0;
drop trigger if exists assistant_message_source_uses_identity_immutable
  on assistant_message_source_uses;
drop trigger if exists assistant_message_source_uses_validate_ranges
  on assistant_message_source_uses;
-- 0070 seals are immutable during normal operation.  All three guards are
-- dropped only after the read-only preflight and immediately before the
-- transaction-local conversion/reseal writes.
drop trigger if exists ai_observations_protect_evaluation on ai_observations;
drop trigger if exists ai_evaluation_case_runs_protect on ai_evaluation_case_runs;
drop trigger if exists ai_evaluation_annotations_immutable on ai_evaluation_annotations;
with converted as (
  select uses.assistant_message_id, uses.source_key,
         uses.consumer_task_id, uses.topic_id,
         uses.rendered_token_count, uses.context_order,
         jsonb_build_array(
           jsonb_build_object(
             'charStart', 0,
             'charEnd', brief_ai_utf16_length(
               case when messages.author = 'assistant' then
                 brief_ai_strip_historical_citation_tags(messages.content)
               else messages.content end
             )
           )
         ) as converted_ranges
  from assistant_message_source_uses uses
  join assistant_message_sources sources
    on sources.assistant_message_id = uses.assistant_message_id
   and sources.source_key = uses.source_key
  join chat_messages messages on messages.id = sources.message_id
  where sources.kind = 'chat_message'
    and jsonb_array_length(uses.ranges) = 0
    and messages.author in ('user', 'assistant')
    and exists (
      select 1
      from brief_ai_0072_legacy_chat_uses legacy
      where legacy.assistant_message_id = uses.assistant_message_id
        and legacy.source_key = uses.source_key
        and legacy.consumer_task_id = uses.consumer_task_id
        and legacy.topic_id is not distinct from uses.topic_id
    )
)
update assistant_message_source_uses uses
set ranges = converted.converted_ranges,
    source_use_identity_digest = assistant_message_source_use_identity_digest(
      converted.assistant_message_id, converted.source_key,
      converted.consumer_task_id, converted.topic_id,
      converted.rendered_token_count, converted.context_order,
      converted.converted_ranges
    )
from converted
where uses.assistant_message_id = converted.assistant_message_id
  and uses.source_key = converted.source_key
  and uses.consumer_task_id = converted.consumer_task_id
  and uses.topic_id is not distinct from converted.topic_id;

create trigger assistant_message_source_uses_identity_immutable
before insert or update or delete on assistant_message_source_uses
for each row execute function enforce_assistant_message_source_use_identity_immutable();
create trigger assistant_message_source_uses_validate_ranges
before insert or update of ranges on assistant_message_source_uses
for each row execute function validate_assistant_message_source_use_ranges();

-- Deterministic helpers used only while resealing retained evaluation rows.
create function brief_ai_0072_canonical_json(input jsonb)
returns text
language plpgsql
immutable
as $$
declare
  parts text;
  entry record;
begin
  if input is null then return 'null'; end if;
  if jsonb_typeof(input) = 'array' then
    select coalesce(string_agg(brief_ai_0072_canonical_json(value), ',' order by ordinal), '')
      into parts
    from jsonb_array_elements(input) with ordinality values(value, ordinal);
    return '[' || parts || ']';
  end if;
  if jsonb_typeof(input) = 'object' then
    select coalesce(
      string_agg(to_json(key)::text || ':' || brief_ai_0072_canonical_json(value), ',' order by key collate "C"),
      ''
    ) into parts
    from jsonb_each(input);
    return '{' || parts || '}';
  end if;
  return input::text;
end
$$;

-- Rewrite every retained range-bearing evidence payload before resealing it.
-- The loops are ordered by assistant/run/source identity so the resulting JSON
-- and all downstream digests remain deterministic.
do $$
declare
  source_row record;
begin
  for source_row in
    select uses.assistant_message_id, uses.source_key, uses.ranges,
           uses.consumer_task_id, uses.topic_id,
           runs.id as run_id,
           case when sources.kind = 'chat_message'
             then 'chat_message:' || (sources.locator->>'messageId')
             else null end as logical_source_identity,
           binding.source_id as mapped_source_id
    from assistant_message_source_uses uses
    join assistant_message_sources sources
      on sources.assistant_message_id = uses.assistant_message_id
     and sources.source_key = uses.source_key
    join brief_ai_0072_legacy_chat_uses legacy
      on legacy.assistant_message_id = uses.assistant_message_id
     and legacy.source_key = uses.source_key
     and legacy.consumer_task_id = uses.consumer_task_id
     and legacy.topic_id is not distinct from uses.topic_id
    join ai_runs runs on runs.assistant_message_id = uses.assistant_message_id
    left join lateral (
      select binding_row.value->>'sourceId' as source_id
      from ai_evaluation_case_runs cases
      cross join jsonb_array_elements(
        coalesce(cases.seed_manifest->'sourceBindings', '[]'::jsonb)
      ) as binding_row(value)
      where cases.ai_run_id = runs.id
        and binding_row.value->>'kind' = 'chat_message'
        and binding_row.value->>'messageId' = sources.message_id::text
      order by cases.session_id, cases.case_id, cases.topology
      limit 1
    ) binding on true
    where sources.kind = 'chat_message'
    order by uses.assistant_message_id, uses.source_key collate "C",
             uses.consumer_task_id collate "C", uses.topic_id collate "C"
  loop
    update ai_observations observations
    set payload = jsonb_set(
      jsonb_set(
        observations.payload,
        '{references}',
        coalesce((
          select jsonb_agg(
            case
              when reference_row->>'sourceId' in (
                source_row.source_key, source_row.logical_source_identity, source_row.mapped_source_id
              )
              then jsonb_set(reference_row, '{ranges}', source_row.ranges, true)
              else reference_row
            end order by reference_ordinal
          )
          from jsonb_array_elements(observations.payload->'references')
            with ordinality as refs(reference_row, reference_ordinal)
        ), coalesce(observations.payload->'references', 'null'::jsonb)),
        false
      ),
      '{restrictedContextLedger,sources}',
      coalesce((
        select jsonb_agg(
          case
            when ledger_row->>'sourceKey' = source_row.source_key
            then jsonb_set(ledger_row, '{ranges}', source_row.ranges, true)
            else ledger_row
          end order by ledger_ordinal
        )
        from jsonb_array_elements(
          observations.payload #> '{restrictedContextLedger,sources}'
        ) with ordinality as ledger(ledger_row, ledger_ordinal)
      ), coalesce(observations.payload #> '{restrictedContextLedger,sources}', 'null'::jsonb)),
      false
    )
    where observations.run_id = source_row.run_id
      and (
        (observations.payload->'references' is not null
          and jsonb_typeof(observations.payload->'references') = 'array')
        or (observations.payload #> '{restrictedContextLedger,sources}' is not null
          and jsonb_typeof(observations.payload #> '{restrictedContextLedger,sources}') = 'array')
      );
  end loop;
end
$$;

do $$
declare
  source_row record;
begin
  for source_row in
    select cases.session_id as case_session_id, cases.case_id, cases.topology,
           uses.assistant_message_id,
           uses.source_key, uses.ranges,
           uses.consumer_task_id, uses.topic_id,
           case when sources.kind = 'chat_message'
             then 'chat_message:' || (sources.locator->>'messageId')
             else null end as logical_source_identity,
           binding.source_id as mapped_source_id
    from assistant_message_source_uses uses
    join assistant_message_sources sources
      on sources.assistant_message_id = uses.assistant_message_id
     and sources.source_key = uses.source_key
    join brief_ai_0072_legacy_chat_uses legacy
      on legacy.assistant_message_id = uses.assistant_message_id
     and legacy.source_key = uses.source_key
     and legacy.consumer_task_id = uses.consumer_task_id
     and legacy.topic_id is not distinct from uses.topic_id
    join ai_runs runs on runs.assistant_message_id = uses.assistant_message_id
    join ai_evaluation_case_runs cases on cases.ai_run_id = runs.id
    left join lateral (
      select binding_row.value->>'sourceId' as source_id
      from jsonb_array_elements(
        coalesce(cases.seed_manifest->'sourceBindings', '[]'::jsonb)
      ) as binding_row(value)
      where binding_row.value->>'kind' = 'chat_message'
        and binding_row.value->>'messageId' = sources.message_id::text
      order by binding_row.value->>'sourceId' collate "C"
      limit 1
    ) binding on true
    where sources.kind = 'chat_message'
    order by cases.session_id, cases.case_id, cases.topology, uses.source_key collate "C",
             uses.consumer_task_id collate "C", uses.topic_id collate "C"
  loop
    update ai_evaluation_case_runs cases
    set execution_output = jsonb_set(
      cases.execution_output,
      '{selectedSources}',
      coalesce((
        select jsonb_agg(
          case
            when selected->>'sourceId' in (
              source_row.source_key, source_row.logical_source_identity, source_row.mapped_source_id
            )
            then jsonb_set(selected, '{ranges}', source_row.ranges, true)
            else selected
          end order by selected_ordinal
        )
        from jsonb_array_elements(cases.execution_output->'selectedSources')
          with ordinality as selections(selected, selected_ordinal)
      ), cases.execution_output->'selectedSources'),
      false
    )
    where cases.session_id = source_row.case_session_id
      and cases.case_id = source_row.case_id
      and cases.topology = source_row.topology
      and cases.execution_output->'selectedSources' is not null
      and jsonb_typeof(cases.execution_output->'selectedSources') = 'array';
    if found then
      update ai_evaluation_case_runs cases
      set execution_output_sha256_hex = encode(digest(convert_to(
        brief_ai_0072_canonical_json(cases.execution_output), 'UTF8'
      ), 'sha256'), 'hex')
      where cases.session_id = source_row.case_session_id
        and cases.case_id = source_row.case_id
        and cases.topology = source_row.topology
        and cases.execution_output->'selectedSources' is not null
        and jsonb_typeof(cases.execution_output->'selectedSources') = 'array';
    end if;
  end loop;
end
$$;

-- This is the 0070 evidence envelope with the current source-use projection.
-- Keeping the full envelope, rather than hashing only the changed rows, keeps
-- the terminal v3 seal formula stable and deterministic.
create function brief_ai_0072_evaluation_evidence_json(p_run_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  run_data record;
  current_message record;
  assistant_message record;
begin
  select runs.*, chats.user_id as chat_user_id, chats.company_id::text as chat_company_id,
         chats.memory_mode as chat_memory_mode, chats.shared_at as chat_shared_at,
         chats.deleted_at as chat_deleted_at, chats.deleted_by_user_id as chat_deleted_by_user_id,
         chats.purge_after as chat_purge_after, chats.legal_hold as chat_legal_hold,
         chats.created_at as chat_created_at, chats.updated_at as chat_updated_at
    into run_data
    from ai_runs runs join chats on chats.id = runs.chat_id
   where runs.id = p_run_id;
  if not found then raise exception 'AI retrieval/compaction evidence run % is missing', p_run_id; end if;
  select messages.* into current_message from chat_messages messages where messages.id = run_data.user_message_id;
  select messages.* into assistant_message from chat_messages messages where messages.id = run_data.assistant_message_id;
  return jsonb_build_object(
    'run', jsonb_build_object(
      'id', run_data.id::text, 'chatId', run_data.chat_id::text,
      'userMessageId', run_data.user_message_id::text, 'initiatingUserId', run_data.initiating_user_id,
      'locale', run_data.locale, 'market', run_data.market,
      'webSearchEnabled', coalesce((run_data.acceptance_scope->>'webRequested')::boolean, false),
      'effectiveWebPolicy', case when coalesce((run_data.acceptance_scope->>'webEnabled')::boolean, false)
        then jsonb_build_object('enabled', true, 'provider', run_data.acceptance_scope->>'webTransportProvider',
          'allowedDomains', run_data.acceptance_scope->'allowedDomains')
        else jsonb_build_object('enabled', false, 'reason', 'company_disabled', 'allowlistActive', false) end,
      'acceptanceScope', run_data.acceptance_scope, 'smithersRunId', run_data.smithers_run_id,
      'createdAt', to_char(run_data.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'startedAt', to_char(run_data.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'finishedAt', to_char(run_data.finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'failedAt', to_char(run_data.failed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'assistantMessageId', run_data.assistant_message_id::text,
      'citationNamespace', run_data.citation_namespace, 'nextEventSeq', run_data.next_event_seq,
      'errorCode', run_data.error_code, 'retryable', run_data.retryable
    ),
    'chat', jsonb_build_object(
      'id', run_data.chat_id::text, 'userId', run_data.chat_user_id,
      'companyId', run_data.chat_company_id, 'memoryMode', run_data.chat_memory_mode,
      'sharedAt', case when run_data.chat_shared_at is null then null else to_char(run_data.chat_shared_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'deletedAt', case when run_data.chat_deleted_at is null then null else to_char(run_data.chat_deleted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'deletedByUserId', run_data.chat_deleted_by_user_id,
      'purgeAfter', case when run_data.chat_purge_after is null then null else to_char(run_data.chat_purge_after at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'legalHold', run_data.chat_legal_hold,
      'createdAt', to_char(run_data.chat_created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt', to_char(run_data.chat_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'currentUserMessage', jsonb_build_object(
      'id', current_message.id::text, 'chatId', current_message.chat_id::text,
      'author', current_message.author, 'content', current_message.content,
      'assistantAiRunId', current_message.assistant_ai_run_id::text,
      'createdAt', to_char(current_message.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'assistantMessage', jsonb_build_object(
      'id', assistant_message.id::text, 'chatId', assistant_message.chat_id::text,
      'author', assistant_message.author, 'content', assistant_message.content,
      'assistantAiRunId', assistant_message.assistant_ai_run_id::text,
      'createdAt', to_char(assistant_message.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'conversationInventory', coalesce((
      select jsonb_agg(jsonb_build_object(
        'turnId', prior.id::text, 'chatId', prior.chat_id::text,
        'initiatingUserId', prior.initiating_user_id, 'smithersRunId', prior.smithers_run_id,
        'locale', prior.locale, 'market', prior.market,
        'webSearchEnabled', coalesce((prior.acceptance_scope->>'webRequested')::boolean, false),
        'effectiveWebPolicy', case when coalesce((prior.acceptance_scope->>'webEnabled')::boolean, false)
          then jsonb_build_object('enabled', true, 'provider', prior.acceptance_scope->>'webTransportProvider',
            'allowedDomains', prior.acceptance_scope->'allowedDomains')
          else jsonb_build_object('enabled', false, 'reason', 'company_disabled', 'allowlistActive', false) end,
        'createdAt', to_char(prior.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'startedAt', to_char(prior.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'finishedAt', case when prior.finished_at is null then null else to_char(prior.finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'failedAt', case when prior.failed_at is null then null else to_char(prior.failed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'userMessageId', users.id::text, 'userChatId', users.chat_id::text,
        'userAuthor', users.author, 'userContent', users.content,
        'userAssistantAiRunId', users.assistant_ai_run_id::text,
        'userCreatedAt', to_char(users.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'assistantMessageId', assistants.id::text, 'assistantChatId', assistants.chat_id::text,
        'assistantAuthor', assistants.author, 'assistantContent', assistants.content,
        'assistantAiRunId', assistants.assistant_ai_run_id::text,
        'assistantCreatedAt', case when assistants.created_at is null then null else to_char(assistants.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'errorCode', prior.error_code, 'retryable', prior.retryable
      ) order by prior.created_at, prior.id)
      from ai_runs prior
      join chat_messages users on users.id = prior.user_message_id
      left join chat_messages assistants on assistants.id = prior.assistant_message_id
      where prior.chat_id = run_data.chat_id and prior.id <> run_data.id
        and (prior.finished_at is not null or prior.failed_at is not null)
    ), '[]'::jsonb),
    'usage', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', usage.id::text, 'taskId', usage.task_id, 'loopIteration', usage.loop_iteration,
        'attempt', usage.attempt, 'providerRequestIndex', usage.provider_request_index,
        'agentRole', usage.agent_role, 'modelId', usage.model_id,
        'providerServiceId', usage.provider_service_id, 'inputTokens', usage.input_tokens,
        'outputTokens', usage.output_tokens, 'cachedTokens', usage.cached_tokens,
        'reasoningTokens', usage.reasoning_tokens, 'totalTokens', usage.total_tokens,
        'stopReason', usage.stop_reason,
        'createdAt', to_char(usage.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) order by usage.created_at, usage.id)
      from ai_run_usage usage where usage.run_id = p_run_id
    ), '[]'::jsonb),
    'externalToolUsage', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', usage.id::text, 'taskId', usage.task_id, 'loopIteration', usage.loop_iteration,
        'attempt', usage.attempt, 'toolRequestIndex', usage.tool_request_index,
        'providerServiceId', usage.provider_service_id, 'operation', usage.operation,
        'status', usage.status, 'resultCount', usage.result_count,
        'responseBytes', usage.response_bytes::float8, 'billedUnits', usage.billed_units::text,
        'durationMs', usage.duration_ms::float8,
        'createdAt', to_char(usage.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) order by usage.task_id, usage.loop_iteration, usage.attempt, usage.tool_request_index, usage.id)
      from ai_external_tool_usage usage where usage.run_id = p_run_id
    ), '[]'::jsonb),
    'observations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', observations.id::text, 'chatId', observations.chat_id::text,
        'kind', observations.kind, 'emittingTask', observations.emitting_task,
        'loopIteration', observations.loop_iteration, 'attempt', observations.attempt,
        'observationKey', observations.observation_key, 'payload', observations.payload,
        'createdAt', to_char(observations.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) order by observations.observation_key)
      from ai_observations observations where observations.run_id = p_run_id
    ), '[]'::jsonb),
    'sourceExposures', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', exposures.id::text, 'taskId', exposures.task_id,
        'loopIteration', exposures.loop_iteration, 'attempt', exposures.attempt,
        'providerRequestIndex', exposures.provider_request_index, 'sourceKind', exposures.source_kind,
        'logicalSourceIdentity', exposures.logical_source_identity,
        'publisherIssueId', exposures.publisher_issue_id, 'publisherDocumentId', exposures.publisher_document_id,
        'contentItemIdentity', exposures.content_item_identity, 'exposureStage', exposures.exposure_stage,
        'visibleTokenCount', exposures.visible_token_count, 'documentSourceId', exposures.document_source_id,
        'documentId', exposures.document_id, 'snapshotId', exposures.snapshot_id,
        'documentContentHash', exposures.content_hash, 'documentRanges', exposures.document_ranges,
        'publisherExtractionId', exposures.publisher_extraction_id::text,
        'createdAt', to_char(exposures.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) order by exposures.task_id, exposures.loop_iteration, exposures.attempt,
        exposures.provider_request_index, exposures.exposure_stage, exposures.content_item_identity, exposures.id)
      from ai_source_exposures exposures where exposures.run_id = p_run_id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', events.id::text, 'seq', events.seq, 'emissionKey', events.emission_key,
        'emittedByTask', events.emitted_by_task, 'event', events.event,
        'createdAt', to_char(events.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) order by events.seq)
      from ai_run_events events where events.run_id = p_run_id
    ), '[]'::jsonb),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sourceKey', sources.source_key, 'kind', sources.kind, 'locator', sources.locator,
        'snapshotId', sources.snapshot_id, 'publisherExtractionId', sources.publisher_extraction_id::text,
        'messageId', sources.message_id::text, 'memoryRevisionId', sources.memory_revision_id::text,
        'displayLabel', sources.display_label, 'publicProvenance', sources.public_provenance,
        'createdAt', to_char(sources.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) order by brief_ai_safe_bigint(substring(sources.source_key from '_([1-9][0-9]*)$')), sources.source_key collate "C")
      from assistant_message_sources sources where sources.assistant_message_id = run_data.assistant_message_id
    ), '[]'::jsonb),
    'sourceUses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sourceKey', uses.source_key, 'consumerTaskId', uses.consumer_task_id,
        'topicId', uses.topic_id, 'renderedTokenCount', uses.rendered_token_count,
        'contextOrder', uses.context_order, 'ranges', uses.ranges,
        'createdAt', to_char(uses.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) order by brief_ai_safe_bigint(substring(uses.source_key from '_([1-9][0-9]*)$')), uses.source_key collate "C", uses.consumer_task_id collate "C")
      from assistant_message_source_uses uses where uses.assistant_message_id = run_data.assistant_message_id
    ), '[]'::jsonb),
    'memoryWrites', coalesce((
      select jsonb_agg(jsonb_build_object(
        'memoryId', current.memory_id::text, 'revisionId', current.id::text,
        'previousRevisionId', previous.id::text, 'action', current.action,
        'stateBefore', current.state_before, 'stateAfter', current.state_after,
        'createdAt', to_char(current.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) order by (select (observations.payload->>'ordinal')::int from ai_observations observations
          where observations.run_id = p_run_id and observations.kind = 'memory_written'
            and observations.payload->>'revisionId' = current.id::text limit 1) nulls last, current.id)
      from user_memory_revisions current
      left join lateral (
        select candidate.id from user_memory_revisions candidate
        where candidate.memory_id = current.memory_id
          and (candidate.created_at, candidate.id) < (current.created_at, current.id)
        order by candidate.created_at desc, candidate.id desc limit 1
      ) previous on true
      where current.run_id = p_run_id
    ), '[]'::jsonb),
    'memoryHeads', coalesce((
      select jsonb_agg(jsonb_build_object(
        'memoryId', memories.id::text, 'userId', memories.user_id, 'kind', memories.kind,
        'content', memories.content, 'headRevisionId', memories.head_revision_id::text,
        'sourceMessageId', memories.source_message_id::text, 'deletedAt',
        case when memories.deleted_at is null then null else to_char(memories.deleted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'provenanceOnlyAt', case when memories.provenance_only_at is null then null else to_char(memories.provenance_only_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'createdAt', to_char(memories.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'updatedAt', to_char(memories.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) order by memories.id)
      from user_memories memories
      where exists (select 1 from user_memory_revisions revisions
                    where revisions.memory_id = memories.id and revisions.run_id = p_run_id)
    ), '[]'::jsonb)
  );
end
$$;

do $$
declare
  row_data record;
  evidence jsonb;
  digest_value text;
begin
  for row_data in
    select cases.session_id, cases.case_id, cases.topology, cases.ai_run_id,
           cases.execution_output_sha256_hex,
           sessions.execution_config_sha256_hex, sessions.provider_endpoint_identity
    from ai_evaluation_case_runs cases
    join ai_evaluation_sessions sessions on sessions.id = cases.session_id
    where cases.status = 'succeeded'
      and cases.run_evidence_sha256_hex is not null
      and sessions.artifact_version = 3
      and sessions.golden_set_version = 3
    order by cases.session_id, cases.case_id, cases.topology
  loop
    evidence := brief_ai_0072_evaluation_evidence_json(row_data.ai_run_id);
    digest_value := encode(digest(convert_to(brief_ai_0072_canonical_json(jsonb_build_object(
      'topology', row_data.topology,
      'evaluationConfigSha256Hex', row_data.execution_config_sha256_hex,
      'providerEndpointIdentity', row_data.provider_endpoint_identity,
      'durableRun', evidence,
      'executionOutputSha256Hex', row_data.execution_output_sha256_hex
    )), 'UTF8'), 'sha256'), 'hex');
    update ai_evaluation_case_runs
      set run_evidence_sha256_hex = digest_value
      where session_id = row_data.session_id
        and case_id = row_data.case_id
        and topology = row_data.topology;
    update ai_evaluation_annotations
      set run_evidence_sha256_hex = digest_value,
          annotations_sha256_hex = encode(digest(convert_to(brief_ai_0072_canonical_json(annotations), 'UTF8'), 'sha256'), 'hex')
      where session_id = row_data.session_id
        and case_id = row_data.case_id
        and topology = row_data.topology;
  end loop;
end
$$;

create trigger ai_evaluation_case_runs_protect
before update or delete on ai_evaluation_case_runs
for each row execute function protect_ai_evaluation_immutable_identity();
create trigger ai_evaluation_annotations_immutable
before update or delete on ai_evaluation_annotations
for each row execute function reject_ai_evaluation_annotation_mutation();
create trigger ai_observations_protect_evaluation
before update or delete on ai_observations
for each row execute function reject_ai_evaluation_runtime_evidence_mutation();

-- v4 is a clean write contract.  NOT VALID retains immutable terminal v3
-- history while rejecting every future v3 insert/update.
alter table ai_evaluation_sessions
  drop constraint if exists ai_evaluation_sessions_versions,
  add constraint ai_evaluation_sessions_versions
    check (artifact_version = 4 and golden_set_version = 4)
    not valid;

-- Smithers creates these tables from the current workflow schemas.  Do not
-- leave a mixed old/new table behind.
do $$
declare
  relation_name text;
begin
  for relation_name in
    select name from unnest(array[
      '_smithers_runs', 'ai_chat_allocation', 'ai_chat_answer',
      'ai_chat_assembly', 'ai_chat_compaction_collect', 'ai_chat_compaction_group',
      'ai_chat_compaction_plan', 'ai_chat_context', 'ai_chat_fallback_plan',
      'ai_chat_fanout_collect', 'ai_chat_fanout_contexts', 'ai_chat_fanout_sources',
      'ai_chat_finalize', 'ai_chat_hydrate', 'ai_chat_hydrate2',
      'ai_chat_internal', 'ai_chat_load_turn', 'ai_chat_memories',
      'ai_chat_memory', 'ai_chat_plan', 'ai_chat_plan_turn',
      'ai_chat_preflight', 'ai_chat_preflight2', 'ai_chat_reduction_plan',
      'ai_chat_resolution', 'ai_chat_selectors', 'ai_chat_structured_internal',
      'ai_chat_topic_result', 'ai_chat_web', 'ai_evaluation_general_planner'
    ]) as names(name) order by name collate "C"
  loop
    if to_regclass(format('public.%I', relation_name)) is not null then
      execute format('drop table public.%I', relation_name);
    end if;
  end loop;
end
$$;

-- Conversion helpers are transaction-local and must not remain callable.
drop function if exists brief_ai_0072_evaluation_evidence_json(uuid);
drop function if exists brief_ai_0072_canonical_json(jsonb);
