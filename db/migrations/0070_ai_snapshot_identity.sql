-- AI-owned immutable evidence identities change from version_id/versionId to
-- snapshot_id/snapshotId. Publisher storage rows keep their true version names.
-- The migration is one fenced transaction: no producer may create or mutate an
-- incompatible Smithers row while retained product evidence is converted.

do $$
declare
  relation_name text;
  row_count bigint;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('brief:ai-chat:smithers-schema', 0)
  );

  -- Lock every affected product relation in one deterministic order.  This is
  -- intentionally stronger than a row lock: evaluation protection triggers
  -- and source identity triggers are disabled for the bounded rewrite below.
  for relation_name in
    select name
    from unnest(array[
      'ai_evaluation_annotations', 'ai_evaluation_case_runs',
      'ai_evaluation_sessions', 'ai_external_tool_usage', 'ai_execution_seeds',
      'ai_observations', 'ai_run_events', 'ai_run_usage', 'ai_runs', 'ai_source_exposures',
      'ai_task_outputs', 'assistant_message_source_uses', 'assistant_message_sources', 'chats',
      'chat_messages', 'user_memories', 'user_memory_revisions'
    ]) as names(name)
    order by name
  loop
    if to_regclass(format('public.%I', relation_name)) is not null then
      execute format('lock table public.%I in access exclusive mode', relation_name);
    end if;
  end loop;

  if to_regclass('public.ai_runs') is not null then
    select count(*) into row_count
    from ai_runs
    where finished_at is null and failed_at is null;
    if row_count <> 0 then
      raise exception
        'AI snapshot identity migration requires all product AI runs to be terminal (% active rows remain)',
        row_count
        using errcode = '55000';
    end if;
  end if;

  -- Current Smithers output schemas are disposable workflow state.  They are
  -- not product terminal data, so use the documented drain/drop/recreate
  -- boundary rather than guessing at an old strict payload.
  for relation_name in
    select name
    from unnest(array[
      '_smithers_runs', 'ai_chat_allocation', 'ai_chat_answer',
      'ai_chat_assembly', 'ai_chat_context', 'ai_chat_fanout_collect',
      'ai_chat_fanout_contexts', 'ai_chat_fanout_sources', 'ai_chat_finalize',
      'ai_chat_hydrate', 'ai_chat_hydrate2', 'ai_chat_internal',
      'ai_chat_load_turn', 'ai_chat_memories', 'ai_chat_memory',
      'ai_chat_plan', 'ai_chat_plan_turn', 'ai_chat_preflight',
      'ai_chat_preflight2', 'ai_chat_reduction_plan', 'ai_chat_resolution',
      'ai_chat_selectors', 'ai_chat_topic_result', 'ai_chat_web'
    ]) as names(name)
    order by name
  loop
    if to_regclass(format('public.%I', relation_name)) is not null then
      execute format('lock table public.%I in access exclusive mode', relation_name);
      if relation_name = '_smithers_runs' then
        execute
          'select count(*) from public._smithers_runs'
          into row_count;
        if row_count <> 0 then
          raise exception
            'AI snapshot identity migration requires all Smithers runs to be drained (% run rows remain)',
            row_count
            using errcode = '55000';
        end if;
      else
        execute format('select count(*) from public.%I', relation_name) into row_count;
        if row_count <> 0 then
          raise exception
            'AI snapshot identity migration requires drained Smithers output table % (% rows remain)',
            relation_name, row_count
            using errcode = '55000';
        end if;
      end if;
    end if;
  end loop;
end
$$;

-- Recursive JSON conversion is limited to the exact AI-owned key.  It fails
-- closed when a row already carries both spellings with different values.
create or replace function brief_snapshot_rename_jsonb(input jsonb)
returns jsonb
language plpgsql
volatile
as $$
declare
  result jsonb := '{}'::jsonb;
  entry record;
  target_key text;
  converted jsonb;
begin
  if input is null then return null; end if;
  if jsonb_typeof(input) = 'array' then
    select coalesce(jsonb_agg(brief_snapshot_rename_jsonb(value) order by ordinal), '[]'::jsonb)
      into result
    from jsonb_array_elements(input) with ordinality values(value, ordinal);
    return result;
  end if;
  if jsonb_typeof(input) <> 'object' then return input; end if;

  for entry in select key, value from jsonb_each(input) order by key collate "C" loop
    target_key := case when entry.key = 'versionId' then 'snapshotId' else entry.key end;
    converted := brief_snapshot_rename_jsonb(entry.value);
    if result ? target_key then
      if result->target_key is distinct from converted then
        raise exception
          'AI snapshot identity migration found conflicting % JSON keys', target_key
          using errcode = '22000';
      end if;
    else
      result := result || jsonb_build_object(target_key, converted);
    end if;
  end loop;
  return result;
end
$$;

create or replace function brief_snapshot_json_has_key(input jsonb, wanted text)
returns boolean
language plpgsql
immutable
as $$
declare
  entry record;
begin
  if input is null then return false; end if;
  if jsonb_typeof(input) = 'array' then
    return exists (
      select 1 from jsonb_array_elements(input) value
      where brief_snapshot_json_has_key(value, wanted)
    );
  end if;
  if jsonb_typeof(input) <> 'object' then return false; end if;
  if input ? wanted then return true; end if;
  for entry in select value from jsonb_each(input) loop
    if brief_snapshot_json_has_key(entry.value, wanted) then return true; end if;
  end loop;
  return false;
end
$$;

-- PostgreSQL jsonb is deterministic, but its text form is not the application
-- canonical JSON algorithm.  Rebuild the same sorted-key, no-whitespace form
-- before recomputing every digest affected by the JSON key rename.
create or replace function brief_snapshot_canonical_json(input jsonb)
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
    select coalesce(string_agg(brief_snapshot_canonical_json(value), ',' order by ordinal), '')
      into parts
    from jsonb_array_elements(input) with ordinality values(value, ordinal);
    return '[' || parts || ']';
  end if;
  if jsonb_typeof(input) = 'object' then
    select coalesce(
      string_agg(to_json(key)::text || ':' || brief_snapshot_canonical_json(value), ',' order by key collate "C"),
      ''
    ) into parts
    from jsonb_each(input);
    return '{' || parts || '}';
  end if;
  return input::text;
end
$$;

-- Verify all old attestation keys before changing payloads.  0064 normally
-- performed this check; retaining it here prevents a hand-written pre-cutover
-- row from being silently resealed.
do $$
declare
  row_data record;
  binding_text text;
  reconstruction_text text;
  range_text text;
  expected_proof text;
  expected_key text;
  expected_key_with_proof text;
  old_payload jsonb;
begin
  if to_regclass('public.ai_observations') is null then return; end if;
  for row_data in
    select id, run_id, emitting_task, loop_iteration, attempt, observation_key, payload
    from ai_observations
    where kind = 'source_exposure_attestation'
    order by id
  loop
    old_payload := row_data.payload;
    if jsonb_typeof(old_payload->'providerSerializationProofBinding') = 'object' then
      binding_text := format(
        '{%s"messageIndex":%s,"orderedSourceDescriptor":%s%s,"serializedField":%s,"sourceOrdinal":%s}',
        case when old_payload->'providerSerializationProofBinding' ? 'characterOffset'
          then format('"characterOffset":%s,', (old_payload->'providerSerializationProofBinding'->>'characterOffset')::bigint)
          else '' end,
        (old_payload->'providerSerializationProofBinding'->>'messageIndex')::bigint,
        to_json(old_payload->'providerSerializationProofBinding'->>'orderedSourceDescriptor'),
        case when old_payload->'providerSerializationProofBinding' ? 'publicDocumentId'
          then format(',"publicDocumentId":%s', to_json(old_payload->'providerSerializationProofBinding'->>'publicDocumentId'))
          else '' end,
        to_json(old_payload->'providerSerializationProofBinding'->>'serializedField'),
        (old_payload->'providerSerializationProofBinding'->>'sourceOrdinal')::bigint
      );
      expected_proof := encode(digest(convert_to(format(
        '{"binding":%s,"contentItemIdentity":%s,"exposureStage":%s,"logicalSourceIdentity":%s,"sourceKind":%s,"visibleTokenCount":%s}',
        binding_text,
        to_json(old_payload->>'contentItemIdentity'),
        to_json(old_payload->>'exposureStage'),
        to_json(old_payload->>'logicalSourceIdentity'),
        to_json(old_payload->>'sourceKind'),
        (old_payload->>'visibleTokenCount')::bigint
      ), 'UTF8'), 'sha256'), 'hex');
    else
      binding_text := null;
      expected_proof := encode(digest(convert_to(format(
        '{"contentItemIdentity":%s,"exposureStage":%s,"logicalSourceIdentity":%s,"sourceKind":%s,"visibleTokenCount":%s}',
        to_json(old_payload->>'contentItemIdentity'),
        to_json(old_payload->>'exposureStage'),
        to_json(old_payload->>'logicalSourceIdentity'),
        to_json(old_payload->>'sourceKind'),
        (old_payload->>'visibleTokenCount')::bigint
      ), 'UTF8'), 'sha256'), 'hex');
    end if;
    if old_payload->>'providerSerializationProofSha256Hex' is distinct from expected_proof then
      raise exception
        'AI snapshot identity migration found invalid source exposure attestation proof %', row_data.id
        using errcode = '22000';
    end if;
    if old_payload->>'sourceKind' = 'document' then
      select '[' || string_agg(
        format('{"charEnd":%s,"charStart":%s}',
          (range_row->>'charEnd')::bigint, (range_row->>'charStart')::bigint),
        ',' order by ordinal
      ) || ']'
      into range_text
      from jsonb_array_elements(old_payload->'documentRanges') with ordinality ranges(range_row, ordinal);
      if old_payload ? 'snapshotId' and not old_payload ? 'versionId' then
        reconstruction_text := format(
          '{"contentHash":%s,"documentId":%s%s,"ranges":%s,"snapshotId":%s,"sourceId":%s}',
          to_json(old_payload->>'documentContentHash'), to_json(old_payload->>'documentId'),
          case when old_payload->>'publisherExtractionId' is null then ''
            else format(',"publisherExtractionId":%s', to_json(old_payload->>'publisherExtractionId')) end,
          range_text, to_json(old_payload->>'snapshotId'), to_json(old_payload->>'documentSourceId')
        );
      else
        reconstruction_text := format(
          '{"contentHash":%s,"documentId":%s%s,"ranges":%s,"sourceId":%s,"versionId":%s}',
          to_json(old_payload->>'documentContentHash'), to_json(old_payload->>'documentId'),
          case when old_payload->>'publisherExtractionId' is null then ''
            else format(',"publisherExtractionId":%s', to_json(old_payload->>'publisherExtractionId')) end,
          range_text, to_json(old_payload->>'documentSourceId'), to_json(old_payload->>'versionId')
        );
      end if;
    else
      reconstruction_text := 'null';
    end if;
    expected_key := concat(
      'source_exposure_attestation:', row_data.emitting_task, ':', row_data.loop_iteration, ':', row_data.attempt,
      ':', (old_payload->>'providerRequestIndex')::bigint, ':',
      encode(digest(convert_to(format(
        '[%s,%s,%s,%s,%s,%s,%s,%s]',
        to_json(old_payload->>'sourceKind'), to_json(old_payload->>'logicalSourceIdentity'),
        to_json(old_payload->>'contentItemIdentity'), to_json(old_payload->>'exposureStage'),
        (old_payload->>'visibleTokenCount')::bigint, to_json(old_payload->>'providerRequestSha256Hex'),
        coalesce(binding_text, 'null'), reconstruction_text
      ), 'UTF8'), 'sha256'), 'hex'));
    expected_key_with_proof := concat(
      'source_exposure_attestation:', row_data.emitting_task, ':', row_data.loop_iteration, ':', row_data.attempt,
      ':', (old_payload->>'providerRequestIndex')::bigint, ':',
      encode(digest(convert_to(format(
        '[%s,%s,%s,%s,%s,%s,%s,%s,%s]',
        to_json(old_payload->>'sourceKind'), to_json(old_payload->>'logicalSourceIdentity'),
        to_json(old_payload->>'contentItemIdentity'), to_json(old_payload->>'exposureStage'),
        (old_payload->>'visibleTokenCount')::bigint, to_json(old_payload->>'providerRequestSha256Hex'),
        to_json(old_payload->>'providerSerializationProofSha256Hex'),
        coalesce(binding_text, 'null'), reconstruction_text
      ), 'UTF8'), 'sha256'), 'hex'));
    if row_data.observation_key not in (expected_key, expected_key_with_proof) then
      raise exception
        'AI snapshot identity migration found noncanonical source exposure observation key %', row_data.id
        using errcode = '22000';
    end if;
  end loop;
end
$$;

-- The evaluation and source identity guards are intentionally disabled only for
-- this transaction-local rewrite, then recreated below with their exact logic.
drop trigger if exists ai_observations_protect_evaluation on ai_observations;
drop trigger if exists ai_evaluation_case_runs_protect on ai_evaluation_case_runs;
drop trigger if exists ai_evaluation_annotations_immutable on ai_evaluation_annotations;
drop trigger if exists assistant_message_sources_identity_immutable on assistant_message_sources;

-- Rename only AI-owned columns.  Existing publisher version columns are never
-- touched, and a partially applied/both-columns state fails closed.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'assistant_message_sources' and column_name = 'version_id') then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'assistant_message_sources' and column_name = 'snapshot_id') then
      raise exception 'assistant_message_sources contains both version_id and snapshot_id';
    end if;
    alter table assistant_message_sources rename column version_id to snapshot_id;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_source_exposures' and column_name = 'version_id') then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_source_exposures' and column_name = 'snapshot_id') then
      raise exception 'ai_source_exposures contains both version_id and snapshot_id';
    end if;
    alter table ai_source_exposures rename column version_id to snapshot_id;
  end if;
end
$$;

-- Refresh stored PL/pgSQL source after the column rename.  Protect publisher
-- storage names while replacing the AI-owned spelling.
do $$
declare
  function_row record;
  function_body text;
begin
  for function_row in
    select p.oid, pg_get_functiondef(p.oid) as definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and (p.prosrc like '%version_id%' or p.prosrc like '%versionId%')
      and p.proname not like 'brief_snapshot_%'
  loop
    function_body := function_row.definition;
    function_body := replace(function_body, 'publisher_document_version_id', '__BRIEF_PUBLISHER_VERSION_ID__');
    function_body := replace(function_body, 'document_version_id', '__BRIEF_DOCUMENT_VERSION_ID__');
    function_body := replace(function_body, 'current_version_id', '__BRIEF_CURRENT_VERSION_ID__');
    function_body := replace(function_body, 'p_version_id', '__BRIEF_SNAPSHOT_PARAMETER__');
    function_body := replace(function_body, 'version_id', 'snapshot_id');
    function_body := replace(function_body, 'versionId', 'snapshotId');
    function_body := replace(function_body, '__BRIEF_PUBLISHER_VERSION_ID__', 'publisher_document_version_id');
    function_body := replace(function_body, '__BRIEF_DOCUMENT_VERSION_ID__', 'document_version_id');
    function_body := replace(function_body, '__BRIEF_CURRENT_VERSION_ID__', 'current_version_id');
    function_body := replace(function_body, '__BRIEF_SNAPSHOT_PARAMETER__', 'p_version_id');
    execute function_body;
  end loop;
end
$$;

-- Normalize transitional source locators and every retained AI-owned JSON
-- object, including nested retrieval references and evaluation seed manifests.
do $$
begin
  if exists (
    select 1
    from assistant_message_sources
    where kind = 'document'
      and locator ? 'versionId'
      and locator ? 'publisherDocumentVersionId'
      and locator->>'versionId' is distinct from locator->>'publisherDocumentVersionId'
  ) then
    raise exception
      'AI snapshot identity migration found conflicting source locator version identities'
      using errcode = '22000';
  end if;
end
$$;

update assistant_message_sources
set locator = (
  brief_snapshot_rename_jsonb(locator)
  - 'publisherDocumentVersionId'
  - 'snapshotId'
) || jsonb_build_object(
  'snapshotId', coalesce(
    brief_snapshot_rename_jsonb(locator)->'snapshotId',
    locator->'publisherDocumentVersionId'
  )
)
where kind = 'document'
  and (locator ? 'versionId' or locator ? 'publisherDocumentVersionId');

update assistant_message_sources
set locator = brief_snapshot_rename_jsonb(locator)
where kind <> 'document'
  and brief_snapshot_json_has_key(locator, 'versionId');

update assistant_message_sources
set public_provenance = brief_snapshot_rename_jsonb(public_provenance)
where brief_snapshot_json_has_key(public_provenance, 'versionId');

update ai_observations
set payload = brief_snapshot_rename_jsonb(payload)
where brief_snapshot_json_has_key(payload, 'versionId');

update ai_run_events
set event = brief_snapshot_rename_jsonb(event)
where brief_snapshot_json_has_key(event, 'versionId');

update ai_runs
set acceptance_scope = brief_snapshot_rename_jsonb(acceptance_scope)
where brief_snapshot_json_has_key(acceptance_scope, 'versionId');

update ai_evaluation_case_runs
set seed_manifest = brief_snapshot_rename_jsonb(seed_manifest),
    execution_output = case when execution_output is null then null else brief_snapshot_rename_jsonb(execution_output) end
where brief_snapshot_json_has_key(seed_manifest, 'versionId')
   or brief_snapshot_json_has_key(execution_output, 'versionId');

update ai_evaluation_annotations
set annotations = brief_snapshot_rename_jsonb(annotations)
where brief_snapshot_json_has_key(annotations, 'versionId');

-- No stale AI-owned key may survive the conversion.

-- Older deployments retained these execution/task payloads outside the
-- canonical evaluation tables. Rewrite every JSONB column when present so
-- forward upgrades do not strand a pre-cutover evidence row.
do $$
declare
  table_name text;
  column_name text;
begin
  for table_name in
    select unnest(array['ai_execution_seeds', 'ai_task_outputs'])
  loop
    if to_regclass(format('public.%I', table_name)) is null then
      continue;
    end if;
    for column_name in
      select attributes.attname
      from pg_attribute attributes
      where attributes.attrelid = format('public.%I', table_name)::regclass
        and attributes.attnum > 0
        and not attributes.attisdropped
        and attributes.atttypid = 'jsonb'::regtype
      order by attributes.attname
    loop
      execute format(
        'update public.%I set %I = brief_snapshot_rename_jsonb(%I) where brief_snapshot_json_has_key(%I, ''versionId'')',
        table_name, column_name, column_name, column_name
      );
    end loop;
  end loop;
end
$$;
do $$
declare
  stale_relation text;
begin
  if exists (select 1 from assistant_message_sources where brief_snapshot_json_has_key(locator, 'versionId')) then stale_relation := 'assistant_message_sources'; end if;
  if exists (select 1 from ai_observations where brief_snapshot_json_has_key(payload, 'versionId')) then stale_relation := coalesce(stale_relation || ',', '') || 'ai_observations'; end if;
  if exists (select 1 from ai_run_events where brief_snapshot_json_has_key(event, 'versionId')) then stale_relation := coalesce(stale_relation || ',', '') || 'ai_run_events'; end if;
  if exists (select 1 from ai_runs where brief_snapshot_json_has_key(acceptance_scope, 'versionId')) then stale_relation := coalesce(stale_relation || ',', '') || 'ai_runs'; end if;
  if exists (select 1 from ai_evaluation_case_runs where brief_snapshot_json_has_key(seed_manifest, 'versionId') or brief_snapshot_json_has_key(execution_output, 'versionId')) then stale_relation := coalesce(stale_relation || ',', '') || 'ai_evaluation_case_runs'; end if;
  if exists (select 1 from ai_evaluation_annotations where brief_snapshot_json_has_key(annotations, 'versionId')) then stale_relation := coalesce(stale_relation || ',', '') || 'ai_evaluation_annotations'; end if;
  if stale_relation is not null then
    raise exception 'AI snapshot identity migration left a stale versionId JSON key' using errcode = '22000', detail = stale_relation;
  end if;
end
$$;


-- Recompute source and evaluation JSON integrity metadata.
update assistant_message_sources
set source_identity_digest = assistant_message_source_identity_digest(
  assistant_message_id, source_key, kind, locator, snapshot_id,
  publisher_extraction_id, message_id, memory_revision_id, display_label, public_provenance
);
update ai_evaluation_case_runs
set execution_output_sha256_hex = case
      when execution_output is null then null
      else encode(digest(convert_to(brief_snapshot_canonical_json(execution_output), 'UTF8'), 'sha256'), 'hex')
    end;
update ai_evaluation_annotations
set annotations_sha256_hex = encode(
  digest(convert_to(brief_snapshot_canonical_json(annotations), 'UTF8'), 'sha256'), 'hex'
);

-- Recompute the attestation key with the final snapshotId reconstruction key.
do $$
declare
  row_data record;
  binding_text text;
  reconstruction_text text;
  range_text text;
  expected_key text;
  converted_payload jsonb;
begin
  for row_data in
    select id, run_id, emitting_task, loop_iteration, attempt, payload
    from ai_observations
    where kind = 'source_exposure_attestation'
    order by id
  loop
    converted_payload := row_data.payload;
    if jsonb_typeof(converted_payload->'providerSerializationProofBinding') = 'object' then
      binding_text := format(
        '{%s"messageIndex":%s,"orderedSourceDescriptor":%s%s,"serializedField":%s,"sourceOrdinal":%s}',
        case when converted_payload->'providerSerializationProofBinding' ? 'characterOffset'
          then format('"characterOffset":%s,', (converted_payload->'providerSerializationProofBinding'->>'characterOffset')::bigint)
          else '' end,
        (converted_payload->'providerSerializationProofBinding'->>'messageIndex')::bigint,
        to_json(converted_payload->'providerSerializationProofBinding'->>'orderedSourceDescriptor'),
        case when converted_payload->'providerSerializationProofBinding' ? 'publicDocumentId'
          then format(',"publicDocumentId":%s', to_json(converted_payload->'providerSerializationProofBinding'->>'publicDocumentId'))
          else '' end,
        to_json(converted_payload->'providerSerializationProofBinding'->>'serializedField'),
        (converted_payload->'providerSerializationProofBinding'->>'sourceOrdinal')::bigint
      );
    else
      binding_text := null;
    end if;
    if converted_payload->>'sourceKind' = 'document' then
      select '[' || string_agg(
        format('{"charEnd":%s,"charStart":%s}',
          (range_row->>'charEnd')::bigint, (range_row->>'charStart')::bigint),
        ',' order by ordinal
      ) || ']'
      into range_text
      from jsonb_array_elements(converted_payload->'documentRanges') with ordinality ranges(range_row, ordinal);
      reconstruction_text := format(
        '{"contentHash":%s,"documentId":%s%s,"ranges":%s,"snapshotId":%s,"sourceId":%s}',
        to_json(converted_payload->>'documentContentHash'), to_json(converted_payload->>'documentId'),
        case when converted_payload->>'publisherExtractionId' is null then ''
          else format(',"publisherExtractionId":%s', to_json(converted_payload->>'publisherExtractionId')) end,
        range_text, to_json(converted_payload->>'snapshotId'), to_json(converted_payload->>'documentSourceId')
      );
    else
      reconstruction_text := 'null';
    end if;
    expected_key := concat(
      'source_exposure_attestation:', row_data.emitting_task, ':', row_data.loop_iteration, ':', row_data.attempt,
      ':', (converted_payload->>'providerRequestIndex')::bigint, ':',
      encode(digest(convert_to(format(
        '[%s,%s,%s,%s,%s,%s,%s,%s,%s]',
        to_json(converted_payload->>'sourceKind'), to_json(converted_payload->>'logicalSourceIdentity'),
        to_json(converted_payload->>'contentItemIdentity'), to_json(converted_payload->>'exposureStage'),
        (converted_payload->>'visibleTokenCount')::bigint, to_json(converted_payload->>'providerRequestSha256Hex'),
        to_json(converted_payload->>'providerSerializationProofSha256Hex'),
        coalesce(binding_text, 'null'), reconstruction_text
      ), 'UTF8'), 'sha256'), 'hex'));
    if exists (
      select 1 from ai_observations collision
      where collision.run_id = row_data.run_id
        and collision.observation_key = expected_key
        and collision.id <> row_data.id
    ) then
      raise exception 'AI snapshot identity migration found an observation-key collision for %', row_data.id using errcode = '23505';
    end if;
    update ai_observations
    set observation_key = expected_key
    where id = row_data.id;
  end loop;
end
$$;

-- The old source identity function used the typed column name and the legacy
-- JSON key.  Replace it with the final snapshot contract before restoring the
-- immutable trigger.
drop function if exists assistant_message_source_identity_digest(uuid, text, text, jsonb, text, uuid, uuid, uuid, text, jsonb);
create function assistant_message_source_identity_digest(
  p_assistant_message_id uuid,
  p_source_key text,
  p_kind text,
  p_locator jsonb,
  p_snapshot_id text,
  p_publisher_extraction_id uuid,
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
    'assistantMessageId', p_assistant_message_id,
    'sourceKey', p_source_key,
    'kind', p_kind,
    'locator', p_locator,
    'snapshotId', p_snapshot_id,
    'publisherExtractionId', p_publisher_extraction_id,
    'messageId', p_message_id,
    'memoryRevisionId', p_memory_revision_id,
    'displayLabel', p_display_label,
    'publicProvenance', p_public_provenance
  )::text, 'UTF8'), 'sha256'), 'hex')
$$;

create or replace function enforce_assistant_message_source_identity_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'assistant message source identity is immutable'
      using errcode = '23514', constraint = 'assistant_message_sources_identity_immutable';
  end if;
  if tg_op = 'DELETE' and exists (select 1 from chat_messages where id = old.assistant_message_id) then
    raise exception 'assistant message sources cannot be deleted independently'
      using errcode = '23514', constraint = 'assistant_message_sources_delete_immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  new.source_identity_digest := assistant_message_source_identity_digest(
    new.assistant_message_id, new.source_key, new.kind, new.locator,
    new.snapshot_id, new.publisher_extraction_id, new.message_id,
    new.memory_revision_id, new.display_label, new.public_provenance
  );
  return new;
end
$$;

create trigger assistant_message_sources_identity_immutable
before insert or update or delete on assistant_message_sources
for each row execute function enforce_assistant_message_source_identity_immutable();

create trigger ai_observations_protect_evaluation
before update or delete on ai_observations
for each row execute function reject_ai_evaluation_runtime_evidence_mutation();

create trigger ai_evaluation_case_runs_protect
before update or delete on ai_evaluation_case_runs
for each row execute function protect_ai_evaluation_immutable_identity();


-- Idempotent index cutover; publisher/domain version indexes remain untouched.
do $$
begin
  if to_regclass('public.assistant_message_sources_version_idx') is not null
    and to_regclass('public.assistant_message_sources_snapshot_idx') is null then
    alter index assistant_message_sources_version_idx rename to assistant_message_sources_snapshot_idx;
  end if;
end
$$;
create index if not exists assistant_message_sources_snapshot_idx
  on assistant_message_sources (snapshot_id) where snapshot_id is not null;

-- Smithers tables are recreated by the current producer after this transaction.
-- Drop only drained disposable tables, never Brief product terminal rows.
do $$
declare
  relation_name text;
begin
  for relation_name in
    select name from unnest(array[
      '_smithers_runs', 'ai_chat_allocation', 'ai_chat_answer', 'ai_chat_assembly',
      'ai_chat_context', 'ai_chat_fanout_collect', 'ai_chat_fanout_contexts',
      'ai_chat_fanout_sources', 'ai_chat_finalize', 'ai_chat_hydrate',
      'ai_chat_hydrate2', 'ai_chat_internal', 'ai_chat_load_turn',
      'ai_chat_memories', 'ai_chat_memory', 'ai_chat_plan', 'ai_chat_plan_turn',
      'ai_chat_preflight', 'ai_chat_preflight2', 'ai_chat_reduction_plan',
      'ai_chat_resolution', 'ai_chat_selectors', 'ai_chat_topic_result', 'ai_chat_web'
    ]) as names(name) order by name
  loop
    if to_regclass(format('public.%I', relation_name)) is not null then
      execute format('drop table public.%I', relation_name);
    end if;
  end loop;
end
$$;
-- Rebuild the durable evaluation evidence envelope after changing observation
-- payload keys.  This mirrors loadDurableRunEvidence and its canonical
-- evaluationRunEvidenceDigest inputs; no terminal seal is discarded.
create or replace function brief_snapshot_evaluation_evidence_json(p_run_id uuid)
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
  if not found then raise exception 'AI snapshot evidence run % is missing', p_run_id; end if;

  select messages.* into current_message
    from chat_messages messages where messages.id = run_data.user_message_id;
  select messages.* into assistant_message
    from chat_messages messages where messages.id = run_data.assistant_message_id;

  return jsonb_build_object(
    'run', jsonb_build_object(
      'id', run_data.id::text, 'chatId', run_data.chat_id::text,
      'userMessageId', run_data.user_message_id::text,
      'initiatingUserId', run_data.initiating_user_id, 'locale', run_data.locale,
      'market', run_data.market,
      'webSearchEnabled', coalesce((run_data.acceptance_scope->>'webRequested')::boolean, false),
      'effectiveWebPolicy', case when coalesce((run_data.acceptance_scope->>'webEnabled')::boolean, false)
        then jsonb_build_object('enabled', true, 'provider', run_data.acceptance_scope->>'webTransportProvider',
          'allowedDomains', run_data.acceptance_scope->'allowedDomains')
        else jsonb_build_object('enabled', false, 'reason', 'company_disabled', 'allowlistActive', false) end,
      'acceptanceScope', run_data.acceptance_scope, 'smithersRunId', run_data.smithers_run_id,
      'createdAt', to_char(run_data.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'startedAt', to_char(run_data.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'finishedAt', to_char(run_data.finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'failedAt', null, 'assistantMessageId', run_data.assistant_message_id::text,
      'citationNamespace', run_data.citation_namespace, 'nextEventSeq', run_data.next_event_seq,
      'errorCode', null, 'retryable', null
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

-- Reseal terminal evaluation rows only after all source payloads are final.
drop trigger if exists ai_evaluation_case_runs_protect on ai_evaluation_case_runs;
do $$
declare
  row_data record;
  evidence jsonb;
  digest_value text;
begin
  for row_data in
    select case_runs.session_id, case_runs.case_id, case_runs.topology,
           case_runs.ai_run_id, case_runs.execution_output_sha256_hex,
           sessions.execution_config_sha256_hex, sessions.provider_endpoint_identity
    from ai_evaluation_case_runs case_runs
    join ai_evaluation_sessions sessions on sessions.id = case_runs.session_id
    where case_runs.status = 'succeeded' and case_runs.run_evidence_sha256_hex is not null
    order by case_runs.session_id, case_runs.case_id, case_runs.topology
  loop
    evidence := brief_snapshot_evaluation_evidence_json(row_data.ai_run_id);
    digest_value := encode(digest(convert_to(brief_snapshot_canonical_json(jsonb_build_object(
      'topology', row_data.topology,
      'evaluationConfigSha256Hex', row_data.execution_config_sha256_hex,
      'providerEndpointIdentity', row_data.provider_endpoint_identity,
      'durableRun', evidence,
      'executionOutputSha256Hex', row_data.execution_output_sha256_hex
    )), 'UTF8'), 'sha256'), 'hex');
    update ai_evaluation_case_runs
    set run_evidence_sha256_hex = digest_value
    where session_id = row_data.session_id and case_id = row_data.case_id and topology = row_data.topology;
    update ai_evaluation_annotations
    set run_evidence_sha256_hex = digest_value
    where session_id = row_data.session_id and case_id = row_data.case_id and topology = row_data.topology;
  end loop;
end
$$;
create trigger ai_evaluation_case_runs_protect
before update or delete on ai_evaluation_case_runs
for each row execute function protect_ai_evaluation_immutable_identity();
-- Conversion helpers are transaction-local and must not remain executable.
drop function if exists brief_snapshot_evaluation_evidence_json(uuid);
drop function if exists brief_snapshot_canonical_json(jsonb);
drop function if exists brief_snapshot_json_has_key(jsonb, text);
drop function if exists brief_snapshot_rename_jsonb(jsonb);
create trigger ai_evaluation_annotations_immutable
before update or delete on ai_evaluation_annotations
for each row execute function reject_ai_evaluation_annotation_mutation();
