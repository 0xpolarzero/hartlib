-- Final AI chat schema. This migration is the only forward cutover after 0063.
-- It refuses active work, converts every retained run before writing, and then
-- removes the pre-cutover fields. Earlier migrations stay unchanged.

-- The 0062 range helper casts JSON text directly to bigint.  Retained rows are
-- untrusted input during this cutover, so replace it with a bounded decoder
-- before any preflight query can reach a cast.  The normalizer is also used to
-- compare a locator with the union of split consumer ranges.
--
-- This first pass is deliberately read-only.  It runs before this migration
-- creates any helper function or touches a catalog object, and blocks the
-- cutover on the retained identities that cannot be decoded without a write.
do $$
declare
  row_data record;
  legacy_key text;
  ordinal_text text;
  numeric_value numeric;
  output_table text;
  output_rows bigint;
  incompatible bigint;
  legacy_row record;
  expected_key text;
  reconstruction jsonb;
  uses_union jsonb;
  reconstruction_text text;
  range_text text;
  expected_proof text;
  binding_text text;
  reference_row jsonb;
begin
  -- Fence and lock all retained state before any helper or catalog write.
  perform pg_advisory_xact_lock(hashtextextended('brief:ai-chat:smithers-schema', 0));
  for output_table in
      select name
      from unnest(array[
        'ai_external_tool_usage', 'ai_observations', 'ai_run_events',
        'ai_run_usage', 'ai_runs', 'ai_smithers_orphan_candidates',
        'ai_source_exposures',
        'assistant_message_source_uses', 'assistant_message_sources',
        'brief_document_extractions', 'brief_document_versions', 'brief_documents',
        'chat_messages', 'chat_subscription_sources', 'chats', 'client_companies',
        'client_company_memberships', 'client_company_public_source_settings',
        'client_employee_subscription_grants', 'client_subscription_accesses',
        'issue_deliveries', 'platform_users', 'public_source_documents',
        'public_sources', 'publisher_companies', 'publisher_issues',
        'publisher_subscriptions', 'user_memories', 'user_memory_revisions'
      ]) as names(name)
      order by name
  loop
    if to_regclass(format('public.%I', output_table)) is not null then
      execute format('lock table public.%I in share mode', output_table);
    end if;
    end loop;

  for output_table in
      select name
      from unnest(array[
        'ai_chat_allocation', 'ai_chat_answer', 'ai_chat_answer2',
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
      if to_regclass(format('public.%I', output_table)) is not null then
        execute format('lock table public.%I in access exclusive mode', output_table);
        execute format('select count(*) from public.%I', output_table) into output_rows;
        if output_rows <> 0 then
          raise exception 'AI chat schema cutover requires drained Smithers output table % (%) rows remain', output_table, output_rows;
        end if;
      end if;
    end loop;

  -- The final answer namespace and source identity digest are retained
  -- evidence.  Check both forms before the cutover can add the replacement
  -- columns or rewrite source keys.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_runs'
      and column_name = 'citation_nonce'
  ) then
    for row_data in
        select runs.id::text as row_identity, runs.citation_nonce
        from ai_runs runs
        order by runs.id
      loop
        if row_data.citation_nonce is null or octet_length(row_data.citation_nonce) <> 16 then
          raise exception
            'AI chat schema cutover preflight row ai_runs/%: citation nonce must contain exactly 16 bytes',
            row_data.row_identity;
        end if;
      end loop;
    for row_data in
        select runs.id::text as row_identity
        from ai_runs runs
        where exists (
          select 1 from ai_runs duplicate_runs
          where duplicate_runs.id <> runs.id
            and duplicate_runs.citation_nonce = runs.citation_nonce
        )
        order by runs.id
      loop
        raise exception
          'AI chat schema cutover preflight row ai_runs/%: citation nonce collides with another retained answer',
          row_data.row_identity;
      end loop;
  else
    for row_data in
        select runs.id::text as row_identity, runs.citation_namespace
        from ai_runs runs
        order by runs.id
      loop
        if row_data.citation_namespace is null
          or row_data.citation_namespace !~ '^cn_[A-Za-z0-9_-]{22}$' then
          raise exception
            'AI chat schema cutover preflight row ai_runs/%: final citation namespace is not canonical',
            row_data.row_identity;
        end if;
      end loop;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'assistant_message_sources'
      and column_name = 'document_version_id'
  ) then
    for row_data in
        select
          sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
          sources.assistant_message_id,
          sources.source_key,
          sources.kind,
          sources.locator,
          sources.document_version_id,
          sources.publisher_document_version_id,
          sources.message_id,
          sources.memory_revision_id,
          sources.display_label,
          sources.public_provenance,
          sources.source_identity_digest,
          runs.citation_nonce,
          runs.id as answer_run_id
        from assistant_message_sources sources
        join chat_messages assistants on assistants.id = sources.assistant_message_id
        left join ai_runs runs on runs.assistant_message_id = assistants.id
        order by sources.assistant_message_id, sources.source_key
      loop
        if row_data.answer_run_id is null then
          raise exception
            'AI chat schema cutover preflight row assistant_message_sources/%: source has no exact terminal answer run owner',
            row_data.row_identity;
        end if;
        if row_data.source_identity_digest is null
          or row_data.source_identity_digest is distinct from assistant_message_source_identity_digest(
            row_data.assistant_message_id, row_data.source_key, row_data.kind,
            row_data.locator, row_data.document_version_id,
            row_data.publisher_document_version_id, row_data.message_id,
            row_data.memory_revision_id, row_data.display_label,
            row_data.public_provenance
          ) then
          raise exception
            'AI chat schema cutover preflight row assistant_message_sources/%: stored source identity digest does not match retained fields',
            row_data.row_identity;
        end if;
        if row_data.kind = 'document' and (
          row_data.document_version_id is null
          or row_data.message_id is not null
          or row_data.memory_revision_id is not null
        ) then
          raise exception
            'AI chat schema cutover preflight row assistant_message_sources/%: document identity tuple is incomplete or mixed',
            row_data.row_identity;
        end if;
        if row_data.kind <> 'document' and (
          row_data.document_version_id is not null
          or row_data.publisher_document_version_id is not null
          or (row_data.message_id is not null and row_data.kind <> 'chat_message')
          or (row_data.memory_revision_id is not null and row_data.kind <> 'memory')
          or (row_data.kind = 'chat_message' and row_data.message_id is null)
          or (row_data.kind = 'memory' and row_data.memory_revision_id is null)
        ) then
          raise exception
            'AI chat schema cutover preflight row assistant_message_sources/%: non-document identity tuple is mixed or incomplete',
            row_data.row_identity;
        end if;
        if regexp_replace(row_data.source_key, '^k_(.*)_[1-9][0-9]*$', '\1') is distinct from
          translate(rtrim(encode(row_data.citation_nonce, 'base64'), '='), '+/', '-_') then
          raise exception
            'AI chat schema cutover preflight row assistant_message_sources/%: source key namespace does not match its retained run nonce',
            row_data.row_identity;
        end if;
      end loop;
  else
    for row_data in
        select
          sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
          sources.assistant_message_id,
          sources.source_key,
          sources.kind,
          sources.locator,
          sources.version_id,
          sources.publisher_extraction_id,
          sources.message_id,
          sources.memory_revision_id,
          sources.display_label,
          sources.public_provenance,
          sources.source_identity_digest,
          runs.citation_namespace,
          runs.id as answer_run_id
        from assistant_message_sources sources
        join chat_messages assistants on assistants.id = sources.assistant_message_id
        left join ai_runs runs on runs.assistant_message_id = assistants.id
        order by sources.assistant_message_id, sources.source_key
      loop
        if row_data.answer_run_id is null then
          raise exception
            'AI chat schema cutover preflight row assistant_message_sources/%: source has no exact terminal answer run owner',
            row_data.row_identity;
        end if;
        if row_data.source_identity_digest is null
          or row_data.source_identity_digest is distinct from assistant_message_source_identity_digest(
            row_data.assistant_message_id, row_data.source_key, row_data.kind,
            row_data.locator, row_data.version_id,
            row_data.publisher_extraction_id, row_data.message_id,
            row_data.memory_revision_id, row_data.display_label,
            row_data.public_provenance
          ) then
          raise exception
            'AI chat schema cutover preflight row assistant_message_sources/%: stored final source identity digest does not match retained fields',
            row_data.row_identity;
        end if;
        if regexp_replace(row_data.source_key, '^k_(.*)_[1-9][0-9]*$', '\1') is distinct from
          row_data.citation_namespace then
          raise exception
            'AI chat schema cutover preflight row assistant_message_sources/%: final source key namespace does not match its answer run',
            row_data.row_identity;
        end if;
      end loop;
  end if;

  -- Validate the source-level immutable range before any dependent use or
  -- range-union check, so an off-end locator names its own retained row.
  for row_data in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      left join public_source_documents public_documents
        on sources.kind = 'document'
       and sources.locator->>'sourceId' like 'public:%'
       and public_documents.source_id::text = substring(sources.locator->>'sourceId' from 8)
       and public_documents.document_id = sources.locator->>'documentId'
       and public_documents.document_id = coalesce(
         sources.locator->>'versionId',
         sources.locator->>'versionId'
       )
      left join brief_document_versions publisher_versions
        on sources.kind = 'document'
       and sources.locator->>'sourceId' like 'publisher:%'
       and publisher_versions.id::text = coalesce(
         sources.locator->>'versionId',
         sources.locator->>'versionId'
       )
       and publisher_versions.brief_document_id::text = sources.locator->>'documentId'
      where sources.kind = 'document'
        and jsonb_typeof(sources.locator->'ranges') = 'array'
        and exists (
          select 1
          from jsonb_array_elements(sources.locator->'ranges') range_row
          where case when range_row->>'charEnd' ~ '^[0-9]+$'
            then (range_row->>'charEnd')::numeric > coalesce(
              char_length(public_documents.text) + (
                select count(*)
                from generate_series(1, char_length(public_documents.text)) positions(position)
                where octet_length(convert_to(substr(public_documents.text, positions.position, 1), 'UTF8')) = 4
              ),
              char_length(publisher_versions.canonical_text) + (
                select count(*)
                from generate_series(1, char_length(publisher_versions.canonical_text)) positions(position)
                where octet_length(convert_to(substr(publisher_versions.canonical_text, positions.position, 1), 'UTF8')) = 4
              )
            )
            else false end
        )
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: document range exceeds immutable UTF-16 text length',
        row_data.row_identity;
    end loop;

  for row_data in
      select
        uses.assistant_message_id::text || '/' || uses.source_key || '/' || uses.consumer_task_id || '/' || coalesce(uses.topic_id, '-') as row_identity,
        uses.assistant_message_id,
        uses.source_key,
        uses.consumer_task_id,
        uses.topic_id,
        uses.rendered_token_count,
        uses.context_order,
        uses.ranges,
        uses.source_use_identity_digest,
        sources.kind as source_kind,
        sources.locator as source_locator
      from assistant_message_source_uses uses
      left join assistant_message_sources sources
        on sources.assistant_message_id = uses.assistant_message_id
       and sources.source_key = uses.source_key
      order by uses.assistant_message_id, uses.source_key, uses.consumer_task_id, uses.topic_id
    loop
      if row_data.source_use_identity_digest is null
        or row_data.source_use_identity_digest is distinct from assistant_message_source_use_identity_digest(
          row_data.assistant_message_id, row_data.source_key,
          row_data.consumer_task_id, row_data.topic_id,
          row_data.rendered_token_count, row_data.context_order, row_data.ranges
        ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_source_uses/%: stored source-use identity digest does not match retained fields',
          row_data.row_identity;
      end if;
      if row_data.source_kind is null then
        raise exception
          'AI chat schema cutover preflight row assistant_message_source_uses/%: source use has no exact source owner',
          row_data.row_identity;
      end if;
      if jsonb_typeof(row_data.ranges) is distinct from 'array'
        or row_data.rendered_token_count < 0
        or row_data.context_order < 0
        or (row_data.source_kind = 'document' and jsonb_array_length(row_data.ranges) = 0)
        or (row_data.source_kind <> 'document' and jsonb_array_length(row_data.ranges) <> 0)
        or exists (
          select 1
          from jsonb_array_elements(case when jsonb_typeof(row_data.ranges) = 'array'
            then row_data.ranges else '[]'::jsonb end) range_row
          where jsonb_typeof(range_row) is distinct from 'object'
            or range_row->>'charStart' !~ '^[0-9]+$'
            or range_row->>'charEnd' !~ '^[0-9]+$'
            or exists (select 1 from jsonb_object_keys(range_row) key
              where key not in ('pageNumber', 'charStart', 'charEnd'))
            or (jsonb_exists(range_row, 'pageNumber') and (
              jsonb_typeof(range_row->'pageNumber') is distinct from 'number'
              or range_row->>'pageNumber' !~ '^[0-9]+$'
              or (range_row->>'pageNumber')::numeric < 1
            ))
            or case when range_row->>'charStart' ~ '^[0-9]+$'
              and range_row->>'charEnd' ~ '^[0-9]+$'
              then (range_row->>'charEnd')::numeric <= (range_row->>'charStart')::numeric
              else false end
            or (case when range_row->>'charStart' ~ '^[0-9]+$'
              then (range_row->>'charStart')::numeric > 9007199254740991 else false end)
            or (case when range_row->>'charEnd' ~ '^[0-9]+$'
              then (range_row->>'charEnd')::numeric > 9007199254740991 else false end)
        ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_source_uses/%: source-use range or count is invalid',
          row_data.row_identity;
      end if;
      if row_data.source_kind = 'document' and exists (
        with ordered as (
          select value->>'charStart' as char_start,
                 ordinal,
                 lag(value->>'charStart') over (order by ordinal) as previous_start,
                 lag(value->>'charEnd') over (order by ordinal) as previous_end
          from jsonb_array_elements(row_data.ranges) with ordinality values(value, ordinal)
        )
        select 1 from ordered
        where (previous_start is not null and char_start::numeric <= previous_start::numeric)
           or (previous_end is not null and char_start::numeric < previous_end::numeric)
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_source_uses/%: source-use ranges are not sorted and disjoint',
          row_data.row_identity;
      end if;
      if not exists (
        select 1
        from assistant_message_sources sources
        join chat_messages assistants on assistants.id = sources.assistant_message_id
        join ai_runs runs on runs.assistant_message_id = assistants.id
        where sources.assistant_message_id = row_data.assistant_message_id
          and sources.source_key = row_data.source_key
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_source_uses/%: source use has no exact assistant/run owner',
          row_data.row_identity;
      end if;
      if row_data.source_kind = 'document' and exists (
        select 1
        from jsonb_array_elements(row_data.ranges) use_range
        where not exists (
          select 1
          from public_source_documents public_documents
          where row_data.source_locator->>'sourceId' like 'public:%'
            and public_documents.source_id::text = substring(row_data.source_locator->>'sourceId' from 8)
            and public_documents.document_id = row_data.source_locator->>'documentId'
            and public_documents.document_id = coalesce(
              row_data.source_locator->>'versionId', row_data.source_locator->>'versionId'
            )
            and (use_range->>'charEnd') ~ '^[0-9]+$'
            and (use_range->>'charEnd')::numeric <= (
              char_length(public_documents.text) + (
                select count(*)
                from generate_series(1, char_length(public_documents.text)) positions(position)
                where octet_length(convert_to(substr(public_documents.text, positions.position, 1), 'UTF8')) = 4
              )
            )
        )
        and not exists (
          select 1
          from brief_document_versions publisher_versions
          where row_data.source_locator->>'sourceId' like 'publisher:%'
            and publisher_versions.id::text = coalesce(
              row_data.source_locator->>'versionId', row_data.source_locator->>'versionId'
            )
            and publisher_versions.brief_document_id::text = row_data.source_locator->>'documentId'
            and (use_range->>'charEnd') ~ '^[0-9]+$'
            and (use_range->>'charEnd')::numeric <= (
              char_length(publisher_versions.canonical_text) + (
                select count(*)
                from generate_series(1, char_length(publisher_versions.canonical_text)) positions(position)
                where octet_length(convert_to(substr(publisher_versions.canonical_text, positions.position, 1), 'UTF8')) = 4
              )
            )
        )
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_source_uses/%: source-use range exceeds immutable UTF-16 text length',
          row_data.row_identity;
      end if;
      if row_data.source_kind = 'document' and exists (
        select 1
        from jsonb_array_elements(row_data.ranges) use_range
        where not exists (
          select 1
          from jsonb_array_elements(row_data.source_locator->'ranges') locator_range
          where use_range->>'charStart' ~ '^[0-9]+$'
            and use_range->>'charEnd' ~ '^[0-9]+$'
            and locator_range->>'charStart' ~ '^[0-9]+$'
            and locator_range->>'charEnd' ~ '^[0-9]+$'
            and (use_range->>'charStart')::numeric >= (locator_range->>'charStart')::numeric
            and (use_range->>'charEnd')::numeric <= (locator_range->>'charEnd')::numeric
        )
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_source_uses/%: source-use range is outside its immutable source locator',
        row_data.row_identity;
      end if;
    end loop;

  -- Bind every retained document use to the complete immutable UTF-16 text.
  -- Locator containment alone is not enough: a forged locator and use could
  -- otherwise agree on the same off-end range.
  for row_data in
      select uses.assistant_message_id::text || '/' || uses.source_key || '/' ||
             uses.consumer_task_id || '/' || coalesce(uses.topic_id, '-') as row_identity
      from assistant_message_source_uses uses
      join assistant_message_sources sources
        on sources.assistant_message_id = uses.assistant_message_id
       and sources.source_key = uses.source_key
      left join public_source_documents public_documents
        on sources.kind = 'document'
       and sources.locator->>'sourceId' like 'public:%'
       and public_documents.source_id::text = substring(sources.locator->>'sourceId' from 8)
       and public_documents.document_id = sources.locator->>'documentId'
       and public_documents.document_id = coalesce(
         sources.locator->>'versionId',
         sources.locator->>'versionId'
       )
      left join brief_document_versions publisher_versions
        on sources.kind = 'document'
       and sources.locator->>'sourceId' like 'publisher:%'
       and publisher_versions.id::text = coalesce(
         sources.locator->>'versionId',
         sources.locator->>'versionId'
       )
       and publisher_versions.brief_document_id::text = sources.locator->>'documentId'
      where sources.kind = 'document'
        and exists (
          select 1
          from jsonb_array_elements(uses.ranges) range_row
          where case when range_row->>'charEnd' ~ '^[0-9]+$'
            then (range_row->>'charEnd')::numeric > coalesce(
              char_length(public_documents.text) + (
                select count(*)
                from generate_series(1, char_length(public_documents.text)) positions(position)
                where octet_length(convert_to(substr(public_documents.text, positions.position, 1), 'UTF8')) = 4
              ),
              char_length(publisher_versions.canonical_text) + (
                select count(*)
                from generate_series(1, char_length(publisher_versions.canonical_text)) positions(position)
                where octet_length(convert_to(substr(publisher_versions.canonical_text, positions.position, 1), 'UTF8')) = 4
              )
            )
            else false end
        )
      order by uses.assistant_message_id, uses.source_key, uses.consumer_task_id, uses.topic_id
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_source_uses/%: source-use range exceeds immutable UTF-16 text length',
        row_data.row_identity;
    end loop;

  -- The final saved-answer decoder requires at least one direct or topic
  -- consumer for every retained source.  Run this guard before range-union
  -- and manifest reconciliation so an unreferenced source names its own row
  -- and cannot be masked by a later derived-ledger check.
  for row_data in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      where substring(sources.source_key from '_([1-9][0-9]*)$') is not null
        and length(substring(sources.source_key from '_([1-9][0-9]*)$')) <= 10
        and not (
          length(substring(sources.source_key from '_([1-9][0-9]*)$')) = 10
          and substring(sources.source_key from '_([1-9][0-9]*)$') > '2147483647'
        )
        and not exists (
        select 1
        from assistant_message_source_uses uses
        where uses.assistant_message_id = sources.assistant_message_id
          and uses.source_key = sources.source_key
          and (
            (uses.consumer_task_id = 'single-answer' and uses.topic_id is null)
            or (uses.consumer_task_id ~ '^topic-t[123]-answer$'
              and uses.topic_id = substring(uses.consumer_task_id from 7 for 2))
          )
      )
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: source has no canonical answer use',
        row_data.row_identity;
    end loop;

  for row_data in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      where sources.kind = 'document'
        and (
          exists (
            with locator_ranges as (
              select (range_row->>'charStart')::numeric as char_start,
                     (range_row->>'charEnd')::numeric as char_end
              from jsonb_array_elements(sources.locator->'ranges') range_row
              where range_row->>'charStart' ~ '^[0-9]+$'
                and range_row->>'charEnd' ~ '^[0-9]+$'
            ), use_ranges as (
              select (range_row->>'charStart')::numeric as char_start,
                     (range_row->>'charEnd')::numeric as char_end
              from assistant_message_source_uses uses
              cross join lateral jsonb_array_elements(uses.ranges) range_row
              where uses.assistant_message_id = sources.assistant_message_id
                and uses.source_key = sources.source_key
                and range_row->>'charStart' ~ '^[0-9]+$'
                and range_row->>'charEnd' ~ '^[0-9]+$'
            ), boundaries as (
              select char_start as point from locator_ranges
              union
              select char_end from locator_ranges
              union
              select char_start from use_ranges
              union
              select char_end from use_ranges
            ), segments as (
              select point as char_start, lead(point) over (order by point) as char_end
              from boundaries
            )
            select 1
            from segments
            where char_end > char_start
              and exists (select 1 from locator_ranges locator
                          where char_start >= locator.char_start and char_end <= locator.char_end)
              and not exists (select 1 from use_ranges covered
                              where char_start >= covered.char_start and char_end <= covered.char_end)
          )
          or exists (
            select 1
            from assistant_message_source_uses uses
            cross join lateral jsonb_array_elements(uses.ranges) range_row
            where uses.assistant_message_id = sources.assistant_message_id
              and uses.source_key = sources.source_key
              and not exists (
                select 1
                from jsonb_array_elements(sources.locator->'ranges') locator_range
                where range_row->>'charStart' ~ '^[0-9]+$'
                  and range_row->>'charEnd' ~ '^[0-9]+$'
                  and locator_range->>'charStart' ~ '^[0-9]+$'
                  and locator_range->>'charEnd' ~ '^[0-9]+$'
                  and (range_row->>'charStart')::numeric >= (locator_range->>'charStart')::numeric
                  and (range_row->>'charEnd')::numeric <= (locator_range->>'charEnd')::numeric
              )
          )
        )
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: source-use union does not equal its locator union',
        row_data.row_identity;
    end loop;

  for row_data in
      select
        uses.assistant_message_id::text || '/' || uses.source_key || '/' || uses.consumer_task_id || '/' || coalesce(uses.topic_id, '-') as row_identity,
        uses.context_order,
        (row_number() over (
          partition by uses.assistant_message_id, uses.consumer_task_id, uses.topic_id
          order by uses.context_order, uses.source_key
        ) - 1)::integer as expected_context_order
      from assistant_message_source_uses uses
      order by uses.assistant_message_id, uses.consumer_task_id, uses.topic_id,
               uses.context_order, uses.source_key
    loop
      if row_data.context_order <> row_data.expected_context_order then
        raise exception
          'AI chat schema cutover preflight row assistant_message_source_uses/%: context orders must be unique and contiguous from zero (found %, expected %)',
          row_data.row_identity,
          row_data.context_order,
          row_data.expected_context_order;
      end if;
    end loop;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'assistant_message_sources'
      and column_name = 'document_version_id'
  ) then
    for row_data in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      where sources.kind = 'document'
        and sources.locator->>'sourceId' like 'publisher:%'
        and not exists (
          select 1
          from brief_document_versions versions
          join brief_documents documents on documents.id = versions.brief_document_id
          join brief_document_extractions extractions
            on extractions.brief_document_id = documents.id
           and extractions.input_sha256_hex = documents.sha256_hex
          join publisher_issues issues on issues.id = documents.issue_id
          join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
          where versions.id::text = sources.publisher_document_version_id::text
            and versions.id::text = coalesce(sources.locator->>'versionId', sources.locator->>'versionId', sources.publisher_document_version_id::text)
            and versions.brief_document_id::text = sources.locator->>'documentId'
            and sources.locator->>'publisherIssueId' = issues.id::text
            and sources.locator->>'publisherDocumentId' = documents.id::text
            and (
              sources.locator->>'publisherExtractionId' is null
              or sources.locator->>'publisherExtractionId' = extractions.id::text
            )
            and sources.locator->>'sourceId' = 'publisher:' || subscriptions.id::text
            and sources.locator->>'contentHash' = versions.content_hash
            and versions.content_hash = encode(digest(convert_to(versions.canonical_text, 'UTF8'), 'sha256'), 'hex')
            and versions.canonical_text = (
              select string_agg(page->>'text', E'\n\n' order by (page->>'pageNumber')::numeric)
              from jsonb_array_elements(extractions.pages) page
            )
        )
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: canonical publisher locator is not bound to its exact issue/subscription/document/version/extraction tuple',
        row_data.row_identity;
    end loop;
  else
    for row_data in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      where sources.kind = 'document'
        and sources.document_source_id like 'publisher:%'
        and not exists (
          select 1
          from brief_document_versions versions
          join brief_document_extractions extractions on extractions.id = versions.publisher_extraction_id
          join brief_documents documents on documents.id = versions.brief_document_id
          join publisher_issues issues on issues.id = documents.issue_id
          join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
          where versions.id::text = sources.version_id
            and versions.publisher_extraction_id = sources.publisher_extraction_id
            and versions.brief_document_id::text = sources.document_id
            and sources.document_source_id = 'publisher:' || subscriptions.id::text
            and sources.locator->>'sourceId' = sources.document_source_id
            and sources.locator->>'documentId' = documents.id::text
            and sources.locator->>'publisherIssueId' = issues.id::text
            and sources.locator->>'publisherDocumentId' = documents.id::text
            and sources.locator->>'publisherExtractionId' = extractions.id::text
            and sources.locator->>'versionId' = versions.id::text
            and sources.locator->>'contentHash' = versions.content_hash
            and sources.content_hash = versions.content_hash
            and versions.content_hash = encode(digest(convert_to(versions.canonical_text, 'UTF8'), 'sha256'), 'hex')
            and versions.canonical_text = (
              select string_agg(page->>'text', E'\n\n' order by (page->>'pageNumber')::numeric)
              from jsonb_array_elements(extractions.pages) page
            )
        )
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: canonical publisher locator is not bound to its exact issue/subscription/document/version/extraction tuple',
        row_data.row_identity;
    end loop;
  end if;

  -- Every retained exposure must have one exact, content-free attestation
  -- before the provider ledger can be converted.
  for row_data in
      select exposures.id::text as row_identity,
             exposures.run_id, exposures.task_id, exposures.loop_iteration,
             exposures.attempt, exposures.provider_request_index,
             exposures.source_kind, exposures.logical_source_identity,
             exposures.content_item_identity, exposures.exposure_stage,
             exposures.visible_token_count, to_jsonb(exposures) as row_payload
      from ai_source_exposures exposures
      where not exists (
        select 1
        from ai_observations attestations
        where attestations.run_id = exposures.run_id
          and attestations.emitting_task = exposures.task_id
          and attestations.loop_iteration = exposures.loop_iteration
          and attestations.attempt = exposures.attempt
          and attestations.kind = 'source_exposure_attestation'
          and attestations.payload->>'providerRequestIndex' ~ '^[0-9]+$'
          and (attestations.payload->>'providerRequestIndex')::numeric = exposures.provider_request_index
          and attestations.payload->>'sourceKind' = exposures.source_kind
          and attestations.payload->>'logicalSourceIdentity' = exposures.logical_source_identity
          and attestations.payload->>'contentItemIdentity' = exposures.content_item_identity
          and attestations.payload->>'exposureStage' = exposures.exposure_stage
          and attestations.payload->>'visibleTokenCount' ~ '^[0-9]+$'
          and (attestations.payload->>'visibleTokenCount')::numeric = exposures.visible_token_count
          and (
            exposures.source_kind <> 'document'
            or (
              attestations.payload->>'documentSourceId' = exposures.document_source_id
              and attestations.payload->>'documentId' = exposures.document_id
              and attestations.payload->>'versionId' = coalesce(to_jsonb(exposures)->>'document_version_id', to_jsonb(exposures)->>'version_id')
              and attestations.payload->>'documentContentHash' = coalesce(to_jsonb(exposures)->>'document_content_hash', to_jsonb(exposures)->>'content_hash')
              and attestations.payload->'documentRanges' is not distinct from exposures.document_ranges
              and attestations.payload->>'publisherExtractionId' is not distinct from to_jsonb(exposures)->>'publisher_extraction_id'
            )
          )
      )
      order by exposures.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_source_exposures/%: exposure has no exact attestation row',
        row_data.row_identity;
    end loop;

  for row_data in
      select attestations.id::text as row_identity
      from ai_observations attestations
      where attestations.kind = 'source_exposure_attestation'
        and not exists (
          select 1
          from ai_source_exposures exposures
          where exposures.run_id = attestations.run_id
            and exposures.task_id = attestations.emitting_task
            and exposures.loop_iteration = attestations.loop_iteration
            and exposures.attempt = attestations.attempt
            and attestations.payload->>'providerRequestIndex' ~ '^[0-9]+$'
            and (attestations.payload->>'providerRequestIndex')::numeric = exposures.provider_request_index
            and attestations.payload->>'sourceKind' = exposures.source_kind
            and attestations.payload->>'logicalSourceIdentity' = exposures.logical_source_identity
            and attestations.payload->>'contentItemIdentity' = exposures.content_item_identity
            and attestations.payload->>'exposureStage' = exposures.exposure_stage
            and attestations.payload->>'visibleTokenCount' ~ '^[0-9]+$'
            and (attestations.payload->>'visibleTokenCount')::numeric = exposures.visible_token_count
        )
      order by attestations.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_observations/%: exposure attestation has no exact exposure row',
        row_data.row_identity;
    end loop;

  for row_data in
      select measurements.id::text as row_identity
      from ai_observations measurements
      where measurements.kind = 'provider_request_measurement'
        and exists (
          select 1
          from jsonb_array_elements_text(case when jsonb_typeof(measurements.payload->'sourceExposureProofSha256Hexes') = 'array'
            then measurements.payload->'sourceExposureProofSha256Hexes' else '[]'::jsonb end) proofs(proof)
          where not exists (
            select 1
            from ai_observations attestations
            where attestations.run_id = measurements.run_id
              and attestations.emitting_task = measurements.emitting_task
              and attestations.loop_iteration = measurements.loop_iteration
              and attestations.attempt = measurements.attempt
              and attestations.kind = 'source_exposure_attestation'
              and attestations.payload->>'providerRequestIndex' = measurements.payload->>'providerRequestIndex'
              and attestations.payload->>'providerRequestSha256Hex' = measurements.payload->>'requestSha256Hex'
              and attestations.payload->>'providerSerializationProofSha256Hex' = proofs.proof
          )
        )
      order by measurements.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_observations/%: provider measurement payload is not strict or passed; provider measurement proof set has no exact attestation binding',
        row_data.row_identity;
    end loop;

  for row_data in
      select attestations.id::text as row_identity
      from ai_observations attestations
      where attestations.kind = 'source_exposure_attestation'
        and not exists (
          select 1
          from ai_observations measurements
          where measurements.run_id = attestations.run_id
            and measurements.emitting_task = attestations.emitting_task
            and measurements.loop_iteration = attestations.loop_iteration
            and measurements.attempt = attestations.attempt
            and measurements.kind = 'provider_request_measurement'
            and measurements.payload->>'providerRequestIndex' = attestations.payload->>'providerRequestIndex'
            and measurements.payload->>'requestSha256Hex' = attestations.payload->>'providerRequestSha256Hex'
            and exists (
              select 1
              from jsonb_array_elements_text(case when jsonb_typeof(measurements.payload->'sourceExposureProofSha256Hexes') = 'array'
                then measurements.payload->'sourceExposureProofSha256Hexes' else '[]'::jsonb end) proof(value)
              where proof.value = attestations.payload->>'providerSerializationProofSha256Hex'
            )
        )
      order by attestations.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_observations/%: exposure attestation has no exact provider proof binding',
        row_data.row_identity;
    end loop;

  -- Validate retained public provenance before the run-drain guard so each
  -- malformed saved source reports its own stable row identity.
  for row_data in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      where (sources.kind in ('chat_message', 'memory') and (
          jsonb_typeof(sources.public_provenance) is distinct from 'object'
          or sources.public_provenance <> '{}'::jsonb
        ))
        or (sources.kind = 'web' and (
          jsonb_typeof(sources.public_provenance) is distinct from 'object'
          or jsonb_typeof(sources.public_provenance->'citationUrl') is distinct from 'string'
          or coalesce(btrim(sources.public_provenance->>'citationUrl'), '') = ''
          or sources.public_provenance->>'citationUrl' is distinct from sources.locator->>'url'
          or exists (
            select 1 from jsonb_object_keys(sources.public_provenance) key
            where key <> 'citationUrl'
          )
        ))
        or (sources.kind = 'document' and (
          jsonb_typeof(sources.public_provenance) is distinct from 'object'
          or jsonb_typeof(sources.public_provenance->'documentTitle') is distinct from 'string'
          or coalesce(btrim(sources.public_provenance->>'documentTitle'), '') = ''
          or jsonb_typeof(sources.public_provenance->'citationUrl') is distinct from 'string'
          or coalesce(btrim(sources.public_provenance->>'citationUrl'), '') = ''
          or (sources.locator->>'sourceId' like 'public:%' and (
            exists (
              select 1 from jsonb_object_keys(sources.public_provenance) key
              where key not in ('lookupRef', 'documentTitle', 'citationUrl', 'publishedAt')
            )
            or not exists (
              select 1 from public_source_documents documents
              where documents.source_id::text = substring(sources.locator->>'sourceId' from 8)
                and documents.document_id = sources.locator->>'documentId'
                and documents.canonical_url = sources.public_provenance->>'citationUrl'
            )
          ))
          or (sources.locator->>'sourceId' like 'publisher:%' and (
            jsonb_typeof(sources.public_provenance->'sourceName') is distinct from 'string'
            or coalesce(btrim(sources.public_provenance->>'sourceName'), '') = ''
            or jsonb_typeof(sources.public_provenance->'issueTitle') is distinct from 'string'
            or coalesce(btrim(sources.public_provenance->>'issueTitle'), '') = ''
            or jsonb_typeof(sources.public_provenance->'publishedAt') is distinct from 'string'
            or coalesce(btrim(sources.public_provenance->>'publishedAt'), '') = ''
            or sources.public_provenance->>'citationUrl' is distinct from format(
              '/v1/issues/%s/documents/%s/content',
              sources.locator->>'publisherIssueId',
              sources.locator->>'publisherDocumentId'
            )
            or exists (
              select 1 from jsonb_object_keys(sources.public_provenance) key
              where key not in (
                'lookupRef', 'sourceName', 'issueTitle', 'documentTitle',
                'citationUrl', 'publishedAt'
              )
            )
          ))
        ))
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: public provenance is not a closed canonical record',
        row_data.row_identity;
    end loop;

  for output_table in
      select name
      from unnest(array[
        '_smithers_runs',
        'ai_chat_load_turn', 'ai_chat_memory', 'ai_chat_resolution',
        'ai_chat_plan', 'ai_chat_plan_turn', 'ai_chat_internal',
        'ai_chat_memories', 'ai_chat_web', 'ai_chat_assembly',
        'ai_chat_context', 'ai_chat_reduction_plan', 'ai_chat_answer',
        'ai_chat_allocation', 'ai_chat_fanout_sources', 'ai_chat_topic_result',
        'ai_chat_fanout_collect', 'ai_chat_finalize', 'ai_chat_preflight',
        'ai_chat_hydrate', 'ai_chat_preflight2', 'ai_chat_hydrate2',
        'ai_chat_answer2', 'ai_chat_selectors', 'ai_chat_fanout_contexts'
      ]) as names(name)
      order by name
    loop
      if to_regclass(format('public.%I', output_table)) is not null then
        execute format('select count(*) from public.%I', output_table) into output_rows;
        if output_rows <> 0 then
          raise exception
            'AI chat schema cutover requires drained Smithers output table % (%) rows remain',
            output_table,
            output_rows;
        end if;
      end if;
    end loop;

  for row_data in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
             sources.source_key
      from assistant_message_sources sources
      order by sources.assistant_message_id, sources.source_key
    loop
      ordinal_text := substring(row_data.source_key from '_([1-9][0-9]*)$');
      if row_data.source_key !~ '^k_[A-Za-z0-9_-]+_[1-9][0-9]*$' then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: malformed source key',
          row_data.row_identity;
      end if;
      if ordinal_text is null
        or length(ordinal_text) > 10
        or (length(ordinal_text) = 10 and ordinal_text > '2147483647') then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: citation ordinal exceeds final integer bound',
          row_data.row_identity;
      end if;
    end loop;

  for row_data in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
             sources.kind,
             sources.locator
      from assistant_message_sources sources
      order by sources.assistant_message_id, sources.source_key
    loop
      if row_data.locator is null or jsonb_typeof(row_data.locator) is distinct from 'object' then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: locator must be a JSON object',
          row_data.row_identity;
      end if;
      legacy_key := null;
      with recursive walk(value, depth) as (
        values (row_data.locator, 0)
        union all
        select nested.value, parent.depth + 1
        from walk parent
        cross join lateral (
          select object_entries.value
          from jsonb_each(parent.value) object_entries
          where jsonb_typeof(parent.value) = 'object'
          union all
          select array_entries.value
          from jsonb_array_elements(parent.value) array_entries(value)
          where jsonb_typeof(parent.value) = 'array'
        ) nested
      )
      select keys.key
      into legacy_key
      from walk
      cross join lateral (
        select object_entries.key
        from jsonb_each(walk.value) object_entries
        where jsonb_typeof(walk.value) = 'object'
      ) keys
      where keys.key in (
        'owner', 'ownerId', 'owner_id', 'role', 'agent_role',
        'versionId', 'publisherDocumentVersionId'
      )
        and not (
          row_data.kind = 'document'
          and walk.depth = 0
          and keys.key in ('versionId', 'publisherDocumentVersionId')
        )
      limit 1;
      if legacy_key in ('versionId', 'publisherDocumentVersionId')
        and row_data.kind <> 'document' then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: non-document locator carries a legacy document version field',
          row_data.row_identity;
      elsif legacy_key is not null then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: legacy locator field % has no canonical conversion',
          row_data.row_identity,
          legacy_key;
      end if;
    end loop;

  for row_data in
      select usage_rows.id::text as row_identity,
             usage_rows.agent_role,
             usage_rows.provider_service_id
      from ai_run_usage usage_rows
      order by usage_rows.id
    loop
      if coalesce(row_data.agent_role, '') not in (
        'plan_turn', 'internal_retrieval', 'memory_selector',
        'web_research', 'context_reducer', 'direct_answer',
        'topic_answer', 'synthesis', 'memory_extractor',
        'evaluation_general_planner'
      ) then
        raise exception
          'AI chat schema cutover preflight row ai_run_usage/%: legacy agent role % has no canonical conversion',
          row_data.row_identity,
          row_data.agent_role;
      end if;
      if coalesce(row_data.provider_service_id, '') not in (
        'zai_coding_plan_official', 'deterministic_test',
        'openai_compatible_custom', 'pre_attestation_unknown'
      ) then
        raise exception
          'AI chat schema cutover preflight row ai_run_usage/%: legacy provider service % has no canonical conversion',
          row_data.row_identity,
          row_data.provider_service_id;
      end if;
    end loop;

  -- The final decoder accepts only direct or topic answer consumers, with the
  -- topic column bound to the consumer's topic ID.  Synthesis reads topic
  -- packets and never owns a persisted source-use row.
  for row_data in
      select uses.assistant_message_id::text || '/' || uses.source_key || '/' ||
             uses.consumer_task_id || '/' || coalesce(uses.topic_id, '-') as row_identity
      from assistant_message_source_uses uses
      where not (
        (uses.consumer_task_id = 'single-answer' and uses.topic_id is null)
        or (uses.consumer_task_id ~ '^topic-t[123]-answer$'
          and uses.topic_id = substring(uses.consumer_task_id from 7 for 2))
      )
      order by uses.assistant_message_id, uses.source_key, uses.consumer_task_id, uses.topic_id
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_source_uses/%: source-use consumer or topic ownership is not canonical',
        row_data.row_identity;
    end loop;

  for row_data in
      select uses.assistant_message_id::text as row_identity
      from assistant_message_source_uses uses
      group by uses.assistant_message_id
      having bool_or(uses.consumer_task_id = 'single-answer')
         and bool_or(uses.consumer_task_id ~ '^topic-t[123]-answer$')
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_source_uses/%: source uses mix direct and topic consumers',
        row_data.row_identity;
    end loop;

  -- Reject an answer source that cannot be reached by a canonical source use
  -- before decoding its locator or any derived terminal ledger.
  for row_data in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      where not exists (
          select 1
          from assistant_message_source_uses uses
          where uses.assistant_message_id = sources.assistant_message_id
            and uses.source_key = sources.source_key
            and (
              uses.consumer_task_id = 'single-answer'
              or uses.consumer_task_id ~ '^topic-t[123]-answer$'
            )
        )
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: source has no canonical answer use',
        row_data.row_identity;
    end loop;

  -- Decode each retained locator as the closed final union while the old
  -- typed columns still exist.  Transitional document version names are
  -- allowed only during this one pass and are normalized later.
  for row_data in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
             sources.kind, sources.locator, sources.message_id,
             sources.memory_revision_id, sources.assistant_message_id
      from assistant_message_sources sources
      order by sources.assistant_message_id, sources.source_key
    loop
      if row_data.kind = 'document' and (
        row_data.locator->>'kind' is distinct from 'document'
        or coalesce(btrim(row_data.locator->>'sourceId'), '') = ''
        or row_data.locator->>'sourceId' !~ '^((public|publisher):[^:[:space:]]+)$'
        or coalesce(btrim(row_data.locator->>'documentId'), '') = ''
        or coalesce(btrim(coalesce(row_data.locator->>'versionId', row_data.locator->>'versionId')), '') = ''
        or row_data.locator->>'contentHash' !~ '^[0-9a-f]{64}$'
        or jsonb_typeof(row_data.locator->'ranges') is distinct from 'array'
        or jsonb_array_length(case when jsonb_typeof(row_data.locator->'ranges') = 'array'
          then row_data.locator->'ranges' else '[]'::jsonb end) = 0
        or exists (
          select 1
          from jsonb_array_elements(case when jsonb_typeof(row_data.locator->'ranges') = 'array'
            then row_data.locator->'ranges' else '[]'::jsonb end) range_row
          where jsonb_typeof(range_row) is distinct from 'object'
            or jsonb_typeof(range_row->'charStart') is distinct from 'number'
            or jsonb_typeof(range_row->'charEnd') is distinct from 'number'
            or range_row->>'charStart' !~ '^[0-9]+$'
            or range_row->>'charEnd' !~ '^[0-9]+$'
            or (range_row->>'charEnd')::numeric <= (range_row->>'charStart')::numeric
            or (case when range_row->>'charStart' ~ '^[0-9]+$'
              then (range_row->>'charStart')::numeric > 9007199254740991 else false end)
            or (case when range_row->>'charEnd' ~ '^[0-9]+$'
              then (range_row->>'charEnd')::numeric > 9007199254740991 else false end)
            or exists (select 1 from jsonb_object_keys(range_row) key
              where key not in ('pageNumber', 'charStart', 'charEnd'))
            or (jsonb_exists(range_row, 'pageNumber') and (
              jsonb_typeof(range_row->'pageNumber') is distinct from 'number'
              or range_row->>'pageNumber' !~ '^[0-9]+$'
              or (range_row->>'pageNumber')::numeric < 1
            ))
        )
        or exists (
          select 1 from jsonb_object_keys(row_data.locator) key
          where key not in (
            'kind', 'sourceId', 'documentId', 'versionId', 'versionId',
            'contentHash', 'ranges', 'publisherExtractionId',
            'publisherIssueId', 'publisherDocumentId'
          )
        )
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: document locator is not a closed canonical record',
          row_data.row_identity;
      end if;
      if row_data.kind = 'document' and exists (
        with ordered as (
          select value->>'charStart' as char_start,
                 value->>'charEnd' as char_end,
                 ordinal,
                 lag(value->>'charEnd') over (order by ordinal) as previous_end,
                 lag(value->>'charStart') over (order by ordinal) as previous_start
          from jsonb_array_elements(row_data.locator->'ranges') with ordinality values(value, ordinal)
        )
        select 1 from ordered
        where (previous_start is not null and char_start::numeric <= previous_start::numeric)
           or (previous_end is not null and char_start::numeric < previous_end::numeric)
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: document locator ranges are not sorted and disjoint',
          row_data.row_identity;
      end if;
      if row_data.kind = 'chat_message' and (
        row_data.locator->>'kind' is distinct from 'chat_message'
        or coalesce(btrim(row_data.locator->>'messageId'), '') = ''
        or row_data.message_id is null
        or row_data.locator->>'messageId' is distinct from row_data.message_id::text
        or not exists (
          select 1
          from chat_messages referenced
          join chat_messages assistants on assistants.id = row_data.assistant_message_id
          where referenced.id = row_data.message_id
            and referenced.chat_id = assistants.chat_id
        )
        or exists (
          select 1 from jsonb_object_keys(row_data.locator) key
          where key not in ('kind', 'messageId')
        )
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: chat locator is not a closed canonical record',
          row_data.row_identity;
      end if;
      if row_data.kind = 'memory' and (
        row_data.locator->>'kind' is distinct from 'memory'
        or coalesce(btrim(row_data.locator->>'memoryId'), '') = ''
        or coalesce(btrim(row_data.locator->>'memoryRevisionId'), '') = ''
        or row_data.memory_revision_id is null
        or row_data.locator->>'memoryRevisionId' is distinct from row_data.memory_revision_id::text
        or row_data.locator->>'memoryId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or not exists (
          select 1
          from user_memory_revisions revisions
          where revisions.id = row_data.memory_revision_id
            and revisions.memory_id::text = row_data.locator->>'memoryId'
        )
        or exists (
          select 1 from jsonb_object_keys(row_data.locator) key
          where key not in ('kind', 'memoryId', 'memoryRevisionId')
        )
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: memory locator is not a closed canonical record',
          row_data.row_identity;
      end if;
      if row_data.kind = 'web' and (
        row_data.locator->>'kind' is distinct from 'web'
        or coalesce(btrim(row_data.locator->>'url'), '') = ''
        or row_data.locator->>'url' !~ '^https://[^[:space:]]+$'
        or jsonb_typeof(row_data.locator->'title') is distinct from 'string'
        or jsonb_typeof(row_data.locator->'domain') is distinct from 'string'
        or jsonb_typeof(row_data.locator->'capturedAt') is distinct from 'string'
        or (jsonb_exists(row_data.locator, 'publishedAt')
          and jsonb_typeof(row_data.locator->'publishedAt') is distinct from 'string')
        or coalesce(btrim(row_data.locator->>'title'), '') = ''
        or coalesce(btrim(row_data.locator->>'domain'), '') = ''
        or coalesce(btrim(row_data.locator->>'capturedAt'), '') = ''
        or row_data.locator->>'capturedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
        or coalesce(btrim(row_data.locator->>'quote'), '') = ''
        or row_data.locator->>'quoteHash' !~ '^[A-Za-z0-9_-]{43}$'
        or substring(row_data.locator->>'url' from '^https://([^/:?#]+)') is distinct from row_data.locator->>'domain'
        or row_data.locator->>'quote' is distinct from btrim(normalize(replace(replace(row_data.locator->>'quote', E'\r\n', E'\n'), E'\r', E'\n'), NFC))
        or row_data.locator->>'quoteHash' is distinct from translate(
          rtrim(encode(digest(convert_to(row_data.locator->>'quote', 'UTF8'), 'sha256'), 'base64'), '='),
          '+/', '-_'
        )
        or exists (
          select 1 from jsonb_object_keys(row_data.locator) key
          where key not in ('kind', 'url', 'title', 'domain', 'quote', 'quoteHash', 'publishedAt', 'capturedAt')
        )
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: web locator is not a closed canonical record',
          row_data.row_identity;
      end if;
    end loop;

  -- External tool ledgers are retained evidence too.  Reject malformed rows
  -- before helper functions or later catalog writes can be reached.
  for row_data in
      select tools.id::text as row_identity,
             tools.task_id,
             tools.loop_iteration,
             tools.attempt,
             tools.tool_request_index,
             tools.provider_service_id,
             tools.operation,
             tools.status,
             tools.result_count,
             tools.response_bytes,
             tools.billed_units,
             tools.duration_ms
      from ai_external_tool_usage tools
      order by tools.id
    loop
      if coalesce(row_data.task_id, '') !~ '^(single-retrieve-web|topic-t[123]-retrieve-web|evaluation-general-planner)$'
        or row_data.loop_iteration < 0
        or row_data.attempt < 0
        or row_data.tool_request_index < 0
        or coalesce(btrim(row_data.provider_service_id), '') = ''
        or coalesce(row_data.operation, '') not in ('web_search', 'web_fetch')
        or coalesce(row_data.status, '') not in ('ok', 'empty', 'failed')
        or coalesce(row_data.result_count, -1) < 0
        or coalesce(row_data.response_bytes, -1) < 0
        or (row_data.billed_units is not null and row_data.billed_units < 0)
        or coalesce(row_data.duration_ms, -1) < 0 then
        raise exception
          'AI chat schema cutover preflight row ai_external_tool_usage/%: external tool ledger identity or metrics are not canonical',
          row_data.row_identity;
      end if;
    end loop;

  for row_data in
      select exposures.id::text as row_identity,
             exposures.source_kind,
             exposures.exposure_stage,
             exposures.loop_iteration,
             exposures.attempt,
             exposures.provider_request_index,
             exposures.visible_token_count,
             to_jsonb(exposures) as row_payload
      from ai_source_exposures exposures
      order by exposures.id
    loop
      if row_data.source_kind not in ('document', 'chat_message', 'memory', 'web')
        or row_data.loop_iteration < 0
        or row_data.attempt < 0
        or row_data.provider_request_index < 0
        or row_data.visible_token_count < 0 then
        raise exception
          'AI chat schema cutover preflight row ai_source_exposures/%: exposure coordinates or identity are not canonical',
          row_data.row_identity;
      end if;
      if row_data.source_kind <> 'document' and (
        row_data.row_payload->>'document_source_id' is not null
        or row_data.row_payload->>'document_id' is not null
        or row_data.row_payload->>'document_version_id' is not null
        or row_data.row_payload->>'version_id' is not null
        or row_data.row_payload->>'document_content_hash' is not null
        or row_data.row_payload->>'content_hash' is not null
        or row_data.row_payload->>'document_ranges' is not null
        or row_data.row_payload->>'publisher_extraction_id' is not null
        or row_data.row_payload->>'publisher_issue_id' is not null
        or row_data.row_payload->>'publisher_document_id' is not null
      ) then
        raise exception
          'AI chat schema cutover preflight row ai_source_exposures/%: non-document row carries a document identity',
          row_data.row_identity;
      end if;
      if row_data.source_kind = 'document' then
        if coalesce(btrim(row_data.row_payload->>'document_source_id'), '') = ''
          or coalesce(btrim(row_data.row_payload->>'document_id'), '') = ''
          or coalesce(
            btrim(row_data.row_payload->>'document_version_id'),
            btrim(row_data.row_payload->>'version_id'),
            ''
          ) = ''
          or coalesce(
            btrim(row_data.row_payload->>'document_content_hash'),
            btrim(row_data.row_payload->>'content_hash'),
            ''
          ) = ''
          or row_data.row_payload->>'document_source_id' !~ '^((public|publisher):[^:[:space:]]+)$'
          or position(chr(65279) in row_data.row_payload->>'document_source_id') > 0
          or exists (
            select 1
            from generate_series(1, char_length(row_data.row_payload->>'document_source_id')) positions(position)
            where ascii(substr(row_data.row_payload->>'document_source_id', positions.position, 1)) in (9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279)
              or ascii(substr(row_data.row_payload->>'document_source_id', positions.position, 1)) between 8192 and 8202
          )
          or jsonb_typeof(row_data.row_payload->'document_ranges') is distinct from 'array'
          or jsonb_array_length(row_data.row_payload->'document_ranges') = 0
          or exists (
            select 1
            from jsonb_array_elements(row_data.row_payload->'document_ranges') range_row
            where jsonb_typeof(range_row) is distinct from 'object'
              or jsonb_typeof(range_row->'charStart') is distinct from 'number'
              or jsonb_typeof(range_row->'charEnd') is distinct from 'number'
              or range_row->>'charStart' !~ '^[0-9]+$'
              or range_row->>'charEnd' !~ '^[0-9]+$'
              or length(range_row->>'charStart') > 16
              or length(range_row->>'charEnd') > 16
              or (case when range_row->>'charStart' ~ '^[0-9]+$'
                then (range_row->>'charStart')::numeric > 9007199254740991
                else false end)
              or (case when range_row->>'charEnd' ~ '^[0-9]+$'
                then (range_row->>'charEnd')::numeric > 9007199254740991
                else false end)
              or (case when range_row->>'charStart' ~ '^[0-9]+$'
                then (range_row->>'charStart')::numeric < 0
                else false end)
              or (case when range_row->>'charStart' ~ '^[0-9]+$'
                and range_row->>'charEnd' ~ '^[0-9]+$'
                then (range_row->>'charEnd')::numeric <= (range_row->>'charStart')::numeric
                else false end)
              or exists (
                select 1 from jsonb_object_keys(range_row) key
                where key not in ('charStart', 'charEnd')
              )
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_source_exposures/%: exposure identity or ranges are invalid',
            row_data.row_identity;
        end if;
      elsif row_data.exposure_stage = 'internal_search_preview' then
        raise exception
          'AI chat schema cutover preflight row ai_source_exposures/%: content-bearing search preview is not a document exposure',
          row_data.row_identity;
      end if;
    end loop;

  for row_data in
      select exposures.id::text as row_identity
      from ai_source_exposures exposures
      where exposures.source_kind = 'document'
        and (
          (
            exposures.document_source_id like 'public:%'
            and not exists (
              select 1
              from public_source_documents documents
              where documents.source_id::text = substring(exposures.document_source_id from 8)
                and documents.document_id = exposures.document_id
                and documents.document_id = coalesce(
                  to_jsonb(exposures)->>'document_version_id',
                  to_jsonb(exposures)->>'version_id'
                )
                and documents.content_hash = coalesce(
                  to_jsonb(exposures)->>'document_content_hash',
                  to_jsonb(exposures)->>'content_hash'
                )
                and documents.content_hash = encode(digest(convert_to(documents.text, 'UTF8'), 'sha256'), 'hex')
            )
          )
          or (
            exposures.document_source_id like 'publisher:%'
            and not exists (
              select 1
              from brief_document_versions versions
              join brief_documents documents on documents.id = versions.brief_document_id
              join publisher_issues issues on issues.id = documents.issue_id
              join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
              join brief_document_extractions extractions
                on extractions.brief_document_id = documents.id
               and extractions.input_sha256_hex = documents.sha256_hex
              where versions.id::text = coalesce(
                  to_jsonb(exposures)->>'document_version_id',
                  to_jsonb(exposures)->>'version_id'
                )
                and versions.brief_document_id::text = exposures.document_id
                and exposures.document_source_id = 'publisher:' || subscriptions.id::text
                and coalesce(to_jsonb(exposures)->>'publisher_issue_id', issues.id::text) = issues.id::text
                and coalesce(to_jsonb(exposures)->>'publisher_document_id', documents.id::text) = documents.id::text
                and coalesce(to_jsonb(exposures)->>'publisher_extraction_id', extractions.id::text) = extractions.id::text
                and versions.content_hash = coalesce(
                  to_jsonb(exposures)->>'document_content_hash',
                  to_jsonb(exposures)->>'content_hash'
                )
                and versions.content_hash = encode(digest(convert_to(versions.canonical_text, 'UTF8'), 'sha256'), 'hex')
                and versions.canonical_text = (
                  select string_agg(page.value->>'text', E'\n\n' order by page.ordinality)
                  from jsonb_array_elements(extractions.pages) with ordinality page(value, ordinality)
                )
            )
          )
        )
      order by exposures.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_source_exposures/%: document exposure is not bound to its immutable source/version tuple',
        row_data.row_identity;
    end loop;

  for row_data in
      select exposures.id::text as row_identity
      from ai_source_exposures exposures
      left join public_source_documents public_documents
        on exposures.source_kind = 'document'
       and exposures.document_source_id like 'public:%'
       and public_documents.source_id::text = substring(exposures.document_source_id from 8)
       and public_documents.document_id = exposures.document_id
       and public_documents.document_id = coalesce(to_jsonb(exposures)->>'document_version_id', to_jsonb(exposures)->>'version_id')
      left join brief_document_versions publisher_versions
        on exposures.source_kind = 'document'
       and exposures.document_source_id like 'publisher:%'
       and publisher_versions.id::text = coalesce(to_jsonb(exposures)->>'document_version_id', to_jsonb(exposures)->>'version_id')
       and publisher_versions.brief_document_id::text = exposures.document_id
      where exposures.source_kind = 'document'
        and (
          (exposures.document_source_id like 'public:%' and public_documents.document_id is null)
          or (exposures.document_source_id like 'publisher:%' and publisher_versions.id is null)
          or exists (
            select 1
            from jsonb_array_elements(exposures.document_ranges) range_row
            where case when range_row->>'charEnd' ~ '^[0-9]+$'
              then (range_row->>'charEnd')::numeric > coalesce(
              char_length(public_documents.text) + (
                select count(*)
                from generate_series(1, char_length(public_documents.text)) positions(position)
                where octet_length(convert_to(substr(public_documents.text, positions.position, 1), 'UTF8')) = 4
              ),
              char_length(publisher_versions.canonical_text) + (
                select count(*)
                from generate_series(1, char_length(publisher_versions.canonical_text)) positions(position)
                where octet_length(convert_to(substr(publisher_versions.canonical_text, positions.position, 1), 'UTF8')) = 4
              )
              )
              else false end
          )
        )
      order by exposures.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_source_exposures/%: document exposure range exceeds immutable UTF-16 text length',
        row_data.row_identity;
    end loop;

  for row_data in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      left join public_source_documents public_documents
        on sources.kind = 'document'
       and sources.locator->>'sourceId' like 'public:%'
       and public_documents.source_id::text = substring(sources.locator->>'sourceId' from 8)
       and public_documents.document_id = sources.locator->>'documentId'
       and public_documents.document_id = coalesce(sources.locator->>'versionId', sources.locator->>'versionId')
      left join brief_document_versions publisher_versions
        on sources.kind = 'document'
       and sources.locator->>'sourceId' like 'publisher:%'
       and publisher_versions.id::text = coalesce(sources.locator->>'versionId', sources.locator->>'versionId')
       and publisher_versions.brief_document_id::text = sources.locator->>'documentId'
      where sources.kind = 'document'
        and exists (
          select 1
          from jsonb_array_elements(sources.locator->'ranges') range_row
          where case when range_row->>'charEnd' ~ '^[0-9]+$'
            then (range_row->>'charEnd')::numeric > coalesce(
            char_length(public_documents.text) + (
              select count(*)
              from generate_series(1, char_length(public_documents.text)) positions(position)
              where octet_length(convert_to(substr(public_documents.text, positions.position, 1), 'UTF8')) = 4
            ),
            char_length(publisher_versions.canonical_text) + (
              select count(*)
              from generate_series(1, char_length(publisher_versions.canonical_text)) positions(position)
              where octet_length(convert_to(substr(publisher_versions.canonical_text, positions.position, 1), 'UTF8')) = 4
            )
            )
            else false end
        )
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: document range exceeds immutable UTF-16 text length',
        row_data.row_identity;
    end loop;

  -- Walk JSON values without a helper function.  This catches legacy object
  -- keys recursively while ordinary string values remain data.
  for row_data in
      select observations.id::text as row_identity,
             observations.run_id,
             observations.kind as row_kind,
             observations.payload as row_payload,
             observations.observation_key,
             observations.emitting_task,
             observations.loop_iteration,
             observations.attempt
      from ai_observations observations
      order by observations.id
    loop
      if row_data.emitting_task !~ '^(plan-turn|memory-extract|evaluation-general-planner|single-(retrieve-internal|select-memories|retrieve-web|measure|reduce-plan|reduce-measure|context-select|answer|assemble)|topic-t[123]-(retrieve-internal|select-memories|retrieve-web|measure|reduce-plan|reduce-measure|context-select|answer|assemble)|fanout-synthesis|clarification-result|finalize|migration_backfill)$' then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: observation has a foreign task owner %',
          row_data.row_identity,
          row_data.emitting_task;
      end if;
      if row_data.row_kind in ('conversation_resolution', 'execution_plan', 'provider_request_attestation') then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: legacy observation kind % requires explicit conversion',
          row_data.row_identity,
          row_data.row_kind;
      end if;
      if row_data.row_kind not in (
        'turn_plan', 'retrieval_manifest', 'retrieval_no_call_seal', 'candidate_rejected',
        'provider_request_measurement', 'source_exposure_attestation',
        'context_measurement', 'context_decision', 'context_reducer_terminal',
        'context_serialized', 'topic_packet', 'memory_extraction_result',
        'memory_application', 'answer_started', 'answer_delta',
        'answer_completed', 'citation', 'citation_defect', 'memory_written'
      ) then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: unknown or legacy observation kind %',
          row_data.row_identity,
          row_data.row_kind;
      end if;
      if row_data.row_payload is null or jsonb_typeof(row_data.row_payload) is distinct from 'object' then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: payload must be a JSON object',
          row_data.row_identity;
      end if;
      legacy_key := null;
      with recursive walk(value) as (
        values (row_data.row_payload)
        union all
        select nested.value
        from walk parent
        cross join lateral (
          select object_entries.value
          from jsonb_each(parent.value) object_entries
          where jsonb_typeof(parent.value) = 'object'
          union all
          select array_entries.value
          from jsonb_array_elements(parent.value) array_entries(value)
          where jsonb_typeof(parent.value) = 'array'
        ) nested
      )
      select keys.key
      into legacy_key
      from walk
      cross join lateral (
        select object_entries.key
        from jsonb_each(walk.value) object_entries
        where jsonb_typeof(walk.value) = 'object'
      ) keys
      where keys.key in (
        'owner', 'ownerId', 'owner_id', 'role', 'agent_role',
        'versionId', 'publisherDocumentVersionId'
      )
        -- Bound retrieval references and document exposure attestations use
        -- versionId as part of their canonical immutable identity. All other
        -- observation kinds still reject it as a legacy payload field.
        and not (
          row_data.row_kind in ('retrieval_manifest', 'source_exposure_attestation')
          and keys.key = 'versionId'
        )
      limit 1;
      if legacy_key is not null then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: legacy payload field % has no canonical conversion',
          row_data.row_identity,
          legacy_key;
      end if;
      if row_data.row_kind = 'candidate_rejected'
        and jsonb_typeof(row_data.row_payload->'candidateId') is distinct from 'string' then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: candidate rejection payload is not strict',
          row_data.row_identity;
      end if;
      if row_data.row_kind = 'provider_request_measurement' then
        if row_data.emitting_task !~ '^(plan-turn|memory-extract|evaluation-general-planner|single-(retrieve-internal|select-memories|retrieve-web|reduce-plan|reduce-measure|context-select|answer|assemble)|topic-t[123]-(retrieve-internal|select-memories|retrieve-web|reduce-plan|reduce-measure|context-select|answer|assemble)|fanout-synthesis|clarification-result|migration_backfill)$'
          or row_data.row_payload->>'agentRole' is distinct from (
            case
              when row_data.emitting_task = 'plan-turn' then 'plan_turn'
              when row_data.emitting_task = 'memory-extract' then 'memory_extractor'
              when row_data.emitting_task = 'evaluation-general-planner' then 'evaluation_general_planner'
              when row_data.emitting_task like '%retrieve-internal' then 'internal_retrieval'
              when row_data.emitting_task like '%select-memories' then 'memory_selector'
              when row_data.emitting_task like '%retrieve-web' then 'web_research'
              when row_data.emitting_task like '%reduce-plan' then 'context_reducer'
              when row_data.emitting_task like 'topic-%-answer' then 'topic_answer'
              when row_data.emitting_task = 'single-answer' then 'direct_answer'
              when row_data.emitting_task = 'fanout-synthesis' then 'synthesis'
              else null
            end
          )
          or row_data.observation_key is distinct from format(
            'provider_request_measurement:%s:%s:%s:%s',
            row_data.emitting_task,
            row_data.loop_iteration,
            row_data.attempt,
            row_data.row_payload->>'providerRequestIndex'
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: provider measurement owner or key is not canonical',
            row_data.row_identity;
        end if;
        if jsonb_typeof(row_data.row_payload->'providerRequestIndex') is distinct from 'number'
          or row_data.row_payload->>'providerRequestIndex' !~ '^[0-9]+$'
          or length(row_data.row_payload->>'providerRequestIndex') > 16
          or jsonb_typeof(row_data.row_payload->'inputTokens') is distinct from 'number'
          or row_data.row_payload->>'inputTokens' !~ '^[0-9]+$'
          or length(row_data.row_payload->>'inputTokens') > 16
          or jsonb_typeof(row_data.row_payload->'requestedOutputTokens') is distinct from 'number'
          or row_data.row_payload->>'requestedOutputTokens' !~ '^[0-9]+$'
          or length(row_data.row_payload->>'requestedOutputTokens') > 16
          or jsonb_typeof(row_data.row_payload->'usableInputTokens') is distinct from 'number'
          or row_data.row_payload->>'usableInputTokens' !~ '^[0-9]+$'
          or length(row_data.row_payload->>'usableInputTokens') > 16
          or jsonb_typeof(row_data.row_payload->'contextWindow') is distinct from 'number'
          or row_data.row_payload->>'contextWindow' !~ '^[0-9]+$'
          or length(row_data.row_payload->>'contextWindow') > 16
          or jsonb_typeof(row_data.row_payload->'passed') is distinct from 'boolean'
          or row_data.row_payload->>'passed' <> 'true'
          or jsonb_typeof(row_data.row_payload->'agentRole') is distinct from 'string'
          or coalesce(btrim(row_data.row_payload->>'agentRole'), '') = ''
          or jsonb_typeof(row_data.row_payload->'modelId') is distinct from 'string'
          or row_data.row_payload->>'modelId' <> 'glm-5-turbo'
          or jsonb_typeof(row_data.row_payload->'requestSha256Hex') is distinct from 'string'
          or row_data.row_payload->>'requestSha256Hex' !~ '^[0-9a-f]{64}$'
          or jsonb_typeof(row_data.row_payload->'sourceExposureProofSha256Hexes') is distinct from 'array'
          or exists (
            select 1
            from jsonb_array_elements(case when jsonb_typeof(row_data.row_payload->'sourceExposureProofSha256Hexes') = 'array'
              then row_data.row_payload->'sourceExposureProofSha256Hexes' else '[]'::jsonb end) proof
            where jsonb_typeof(proof) is distinct from 'string'
              or proof #>> '{}' !~ '^[0-9a-f]{64}$'
          )
          or exists (
            select 1 from jsonb_object_keys(row_data.row_payload) key
            where key not in (
              'agentRole', 'modelId', 'requestSha256Hex',
              'sourceExposureProofSha256Hexes', 'providerRequestIndex',
              'sourceExposureProofBindings', 'inputTokens', 'requestedOutputTokens',
              'usableInputTokens', 'contextWindow', 'passed'
            )
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: provider measurement payload is not strict or passed',
            row_data.row_identity;
        end if;
        numeric_value := (row_data.row_payload->>'requestedOutputTokens')::numeric;
        if numeric_value <= 0 or numeric_value > 9007199254740991
          or (case when row_data.row_payload->>'providerRequestIndex' ~ '^[0-9]+$'
            then (row_data.row_payload->>'providerRequestIndex')::numeric > 9007199254740991
            else false end)
          or (case when row_data.row_payload->>'inputTokens' ~ '^[0-9]+$'
            then (row_data.row_payload->>'inputTokens')::numeric > 9007199254740991
            else false end)
          or (case when row_data.row_payload->>'usableInputTokens' ~ '^[0-9]+$'
            then (row_data.row_payload->>'usableInputTokens')::numeric > 9007199254740991
            else false end)
          or (case when row_data.row_payload->>'contextWindow' ~ '^[0-9]+$'
            then (row_data.row_payload->>'contextWindow')::numeric > 9007199254740991
            else false end)
          or (case when row_data.row_payload->>'usableInputTokens' ~ '^[0-9]+$'
            then (row_data.row_payload->>'usableInputTokens')::numeric <= 0
            else false end)
          or (case when row_data.row_payload->>'contextWindow' ~ '^[0-9]+$'
            then (row_data.row_payload->>'contextWindow')::numeric <= 0
            else false end) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: provider measurement payload is not strict or passed',
            row_data.row_identity;
        end if;
        if (case when row_data.row_payload->>'inputTokens' ~ '^[0-9]+$'
          and row_data.row_payload->>'usableInputTokens' ~ '^[0-9]+$'
          then (row_data.row_payload->>'inputTokens')::numeric > (row_data.row_payload->>'usableInputTokens')::numeric
          else false end)
          or (case when row_data.row_payload->>'contextWindow' ~ '^[0-9]+$'
            and row_data.row_payload->>'requestedOutputTokens' ~ '^[0-9]+$'
            then (row_data.row_payload->>'contextWindow')::numeric <= (row_data.row_payload->>'requestedOutputTokens')::numeric
            else false end)
          or (case when row_data.row_payload->>'usableInputTokens' ~ '^[0-9]+$'
            and row_data.row_payload->>'contextWindow' ~ '^[0-9]+$'
            and row_data.row_payload->>'requestedOutputTokens' ~ '^[0-9]+$'
            then (row_data.row_payload->>'usableInputTokens')::numeric >
              (row_data.row_payload->>'contextWindow')::numeric - (row_data.row_payload->>'requestedOutputTokens')::numeric
            else false end) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: provider measurement payload is not strict or passed',
            row_data.row_identity;
        end if;
        if jsonb_typeof(row_data.row_payload->'sourceExposureProofSha256Hexes') is distinct from 'array'
          or exists (
            select 1
            from jsonb_array_elements(case when jsonb_typeof(row_data.row_payload->'sourceExposureProofSha256Hexes') = 'array'
              then row_data.row_payload->'sourceExposureProofSha256Hexes' else '[]'::jsonb end) proof
            where jsonb_typeof(proof) is distinct from 'string'
              or proof #>> '{}' !~ '^[0-9a-f]{64}$'
          )
          or (case when jsonb_typeof(row_data.row_payload->'sourceExposureProofSha256Hexes') = 'array'
            then jsonb_array_length(row_data.row_payload->'sourceExposureProofSha256Hexes') else 0 end > 0
            and jsonb_typeof(row_data.row_payload->'sourceExposureProofBindings') is distinct from 'array')
          or (jsonb_exists(row_data.row_payload, 'sourceExposureProofBindings')
            and jsonb_typeof(row_data.row_payload->'sourceExposureProofBindings') is distinct from 'array')
          or exists (
            select 1
            from jsonb_array_elements(case when jsonb_typeof(row_data.row_payload->'sourceExposureProofBindings') = 'array'
              then row_data.row_payload->'sourceExposureProofBindings' else '[]'::jsonb end) binding_row
            where jsonb_typeof(binding_row) is distinct from 'object'
              or jsonb_typeof(binding_row->'providerSerializationProofSha256Hex') is distinct from 'string'
              or binding_row->>'providerSerializationProofSha256Hex' !~ '^[0-9a-f]{64}$'
              or jsonb_typeof(binding_row->'providerSerializationProofBinding') is distinct from 'object'
              or jsonb_typeof(binding_row->'providerSerializationProofBinding'->'messageIndex') is distinct from 'number'
              or jsonb_typeof(binding_row->'providerSerializationProofBinding'->'sourceOrdinal') is distinct from 'number'
              or jsonb_typeof(binding_row->'providerSerializationProofBinding'->'serializedField') is distinct from 'string'
              or jsonb_typeof(binding_row->'providerSerializationProofBinding'->'orderedSourceDescriptor') is distinct from 'string'
              or coalesce(btrim(binding_row->'providerSerializationProofBinding'->>'serializedField'), '') = ''
              or coalesce(btrim(binding_row->'providerSerializationProofBinding'->>'orderedSourceDescriptor'), '') = ''
              or binding_row->'providerSerializationProofBinding'->>'messageIndex' !~ '^[0-9]+$'
              or binding_row->'providerSerializationProofBinding'->>'sourceOrdinal' !~ '^[0-9]+$'
              or exists (select 1 from jsonb_object_keys(binding_row) key where key not in ('providerSerializationProofSha256Hex', 'providerSerializationProofBinding'))
              or exists (select 1 from jsonb_object_keys(binding_row->'providerSerializationProofBinding') key where key not in ('messageIndex', 'sourceOrdinal', 'serializedField', 'characterOffset', 'orderedSourceDescriptor', 'publicDocumentId'))
              or binding_row->'providerSerializationProofBinding'->>'messageIndex' !~ '^[0-9]+$'
              or binding_row->'providerSerializationProofBinding'->>'sourceOrdinal' !~ '^[0-9]+$'
              or case
                when binding_row->'providerSerializationProofBinding'->>'messageIndex' ~ '^[0-9]+$'
                  then (binding_row->'providerSerializationProofBinding'->>'messageIndex')::numeric > 9007199254740991
                else false
              end
              or case
                when binding_row->'providerSerializationProofBinding'->>'sourceOrdinal' ~ '^[0-9]+$'
                  then (binding_row->'providerSerializationProofBinding'->>'sourceOrdinal')::numeric > 9007199254740991
                else false
              end
              or (jsonb_exists(binding_row->'providerSerializationProofBinding', 'characterOffset')
                and (
                  binding_row->'providerSerializationProofBinding'->>'characterOffset' !~ '^[0-9]+$'
                  or case
                    when binding_row->'providerSerializationProofBinding'->>'characterOffset' ~ '^[0-9]+$'
                      then (binding_row->'providerSerializationProofBinding'->>'characterOffset')::numeric > 9007199254740991
                    else false
                  end
                ))
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: provider measurement payload is not strict or passed',
            row_data.row_identity;
        end if;
        if row_data.row_payload->'sourceExposureProofSha256Hexes' <> coalesce((
          select jsonb_agg(item.value order by item.value #>> '{}')
          from jsonb_array_elements(case when jsonb_typeof(row_data.row_payload->'sourceExposureProofSha256Hexes') = 'array'
            then row_data.row_payload->'sourceExposureProofSha256Hexes' else '[]'::jsonb end) item
        ), '[]'::jsonb)
          or (case when jsonb_typeof(row_data.row_payload->'sourceExposureProofSha256Hexes') = 'array'
            then jsonb_array_length(row_data.row_payload->'sourceExposureProofSha256Hexes') else 0 end) <> (
            select count(distinct item.value #>> '{}')
            from jsonb_array_elements(case when jsonb_typeof(row_data.row_payload->'sourceExposureProofSha256Hexes') = 'array'
              then row_data.row_payload->'sourceExposureProofSha256Hexes' else '[]'::jsonb end) item
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: provider measurement proof set is not canonical',
            row_data.row_identity;
        end if;
      end if;
      if row_data.row_kind = 'source_exposure_attestation' then
        if jsonb_typeof(row_data.row_payload->'providerRequestIndex') is distinct from 'number'
          or row_data.row_payload->>'providerRequestIndex' !~ '^[0-9]+$'
          or (case when row_data.row_payload->>'providerRequestIndex' ~ '^[0-9]+$'
            then (row_data.row_payload->>'providerRequestIndex')::numeric > 9007199254740991
            else false end)
          or jsonb_typeof(row_data.row_payload->'providerRequestSha256Hex') is distinct from 'string'
          or row_data.row_payload->>'providerRequestSha256Hex' !~ '^[0-9a-f]{64}$'
          or jsonb_typeof(row_data.row_payload->'sourceKind') is distinct from 'string'
          or row_data.row_payload->>'sourceKind' not in ('document', 'chat_message', 'memory', 'web')
          or jsonb_typeof(row_data.row_payload->'logicalSourceIdentity') is distinct from 'string'
          or coalesce(btrim(row_data.row_payload->>'logicalSourceIdentity'), '') = ''
          or jsonb_typeof(row_data.row_payload->'contentItemIdentity') is distinct from 'string'
          or coalesce(btrim(row_data.row_payload->>'contentItemIdentity'), '') = ''
          or jsonb_typeof(row_data.row_payload->'exposureStage') is distinct from 'string'
          or coalesce(btrim(row_data.row_payload->>'exposureStage'), '') = ''
          or jsonb_typeof(row_data.row_payload->'visibleTokenCount') is distinct from 'number'
          or row_data.row_payload->>'visibleTokenCount' !~ '^[0-9]+$'
          or (case when row_data.row_payload->>'visibleTokenCount' ~ '^[0-9]+$'
            then (row_data.row_payload->>'visibleTokenCount')::numeric > 9007199254740991
            else false end)
          or jsonb_typeof(row_data.row_payload->'providerSerializationProofSha256Hex') is distinct from 'string'
          or row_data.row_payload->>'providerSerializationProofSha256Hex' !~ '^[0-9a-f]{64}$'
          or jsonb_typeof(row_data.row_payload->'providerSerializationProofBinding') is distinct from 'object'
          or jsonb_typeof(row_data.row_payload->'providerSerializationProofBinding'->'messageIndex') is distinct from 'number'
          or jsonb_typeof(row_data.row_payload->'providerSerializationProofBinding'->'sourceOrdinal') is distinct from 'number'
          or row_data.row_payload->'providerSerializationProofBinding'->>'messageIndex' !~ '^[0-9]+$'
          or row_data.row_payload->'providerSerializationProofBinding'->>'sourceOrdinal' !~ '^[0-9]+$'
          or (case when row_data.row_payload->'providerSerializationProofBinding'->>'messageIndex' ~ '^[0-9]+$'
            then (row_data.row_payload->'providerSerializationProofBinding'->>'messageIndex')::numeric > 9007199254740991 else false end)
          or (case when row_data.row_payload->'providerSerializationProofBinding'->>'sourceOrdinal' ~ '^[0-9]+$'
            then (row_data.row_payload->'providerSerializationProofBinding'->>'sourceOrdinal')::numeric > 9007199254740991 else false end)
          or jsonb_typeof(row_data.row_payload->'providerSerializationProofBinding'->'serializedField') is distinct from 'string'
          or coalesce(btrim(row_data.row_payload->'providerSerializationProofBinding'->>'serializedField'), '') = ''
          or jsonb_typeof(row_data.row_payload->'providerSerializationProofBinding'->'orderedSourceDescriptor') is distinct from 'string'
          or coalesce(btrim(row_data.row_payload->'providerSerializationProofBinding'->>'orderedSourceDescriptor'), '') = ''
          or exists (
            select 1 from jsonb_object_keys(row_data.row_payload) key
            where key not in (
              'providerRequestIndex', 'providerRequestSha256Hex', 'sourceKind',
              'logicalSourceIdentity', 'contentItemIdentity', 'exposureStage',
              'visibleTokenCount', 'providerSerializationProofSha256Hex',
              'providerSerializationProofBinding', 'documentSourceId', 'documentId',
              'versionId', 'documentContentHash', 'documentRanges', 'publisherExtractionId'
            )
          )
          or exists (
            select 1 from jsonb_object_keys(row_data.row_payload->'providerSerializationProofBinding') key
            where key not in ('messageIndex', 'sourceOrdinal', 'serializedField', 'characterOffset', 'orderedSourceDescriptor', 'publicDocumentId')
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: exposure attestation payload is not strict',
            row_data.row_identity;
        end if;
        if row_data.row_payload->>'sourceKind' = 'document'
          and (
            jsonb_typeof(row_data.row_payload->'documentSourceId') is distinct from 'string'
            or jsonb_typeof(row_data.row_payload->'documentId') is distinct from 'string'
            or jsonb_typeof(row_data.row_payload->'versionId') is distinct from 'string'
            or jsonb_typeof(row_data.row_payload->'documentContentHash') is distinct from 'string'
            or row_data.row_payload->>'documentContentHash' !~ '^[0-9a-f]{64}$'
            or jsonb_typeof(row_data.row_payload->'documentRanges') is distinct from 'array'
            or exists (
              select 1 from jsonb_array_elements(case when jsonb_typeof(row_data.row_payload->'documentRanges') = 'array'
                then row_data.row_payload->'documentRanges' else '[]'::jsonb end) range_row
              where jsonb_typeof(range_row) is distinct from 'object'
                or jsonb_typeof(range_row->'charStart') is distinct from 'number'
                or jsonb_typeof(range_row->'charEnd') is distinct from 'number'
                or range_row->>'charStart' !~ '^[0-9]+$'
                or range_row->>'charEnd' !~ '^[0-9]+$'
                or case
                  when range_row->>'charStart' ~ '^[0-9]+$' and range_row->>'charEnd' ~ '^[0-9]+$'
                    then (range_row->>'charEnd')::numeric <= (range_row->>'charStart')::numeric
                  else false
                end
                or exists (select 1 from jsonb_object_keys(range_row) key where key not in ('charStart', 'charEnd'))
            )
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: document exposure attestation is not strict',
            row_data.row_identity;
        end if;
      end if;
      if row_data.row_kind in ('context_measurement', 'context_serialized') then
        if jsonb_typeof(row_data.row_payload->'restrictedContextLedger') is distinct from 'object'
          or row_data.row_payload->'restrictedContextLedger'->>'requestKind' not in ('direct', 'topic', 'synthesis')
          or jsonb_typeof(row_data.row_payload->'restrictedContextLedger'->'modelId') is distinct from 'string'
          or coalesce(btrim(row_data.row_payload->'restrictedContextLedger'->>'modelId'), '') = ''
          or jsonb_typeof(row_data.row_payload->'restrictedContextLedger'->'requestSha256Hex') is distinct from 'string'
          or row_data.row_payload->'restrictedContextLedger'->>'requestSha256Hex' !~ '^[0-9a-f]{64}$'
          or jsonb_typeof(row_data.row_payload->'restrictedContextLedger'->'selectedConversation') is distinct from 'array'
          or jsonb_typeof(row_data.row_payload->'restrictedContextLedger'->'inputTokens') is distinct from 'number'
          or jsonb_typeof(row_data.row_payload->'restrictedContextLedger'->'usableInputTokens') is distinct from 'number'
          or jsonb_typeof(row_data.row_payload->'restrictedContextLedger'->'requestedOutputTokens') is distinct from 'number'
          or row_data.row_payload->'restrictedContextLedger'->>'inputTokens' !~ '^[0-9]+$'
          or row_data.row_payload->'restrictedContextLedger'->>'usableInputTokens' !~ '^[0-9]+$'
          or row_data.row_payload->'restrictedContextLedger'->>'requestedOutputTokens' !~ '^[0-9]+$'
          or length(row_data.row_payload->'restrictedContextLedger'->>'inputTokens') > 16
          or length(row_data.row_payload->'restrictedContextLedger'->>'usableInputTokens') > 16
          or length(row_data.row_payload->'restrictedContextLedger'->>'requestedOutputTokens') > 16
          or (case when row_data.row_payload->'restrictedContextLedger'->>'requestedOutputTokens' ~ '^[0-9]+$'
            then (row_data.row_payload->'restrictedContextLedger'->>'requestedOutputTokens')::numeric <= 0
            else false end)
          or (case when row_data.row_payload->'restrictedContextLedger'->>'usableInputTokens' ~ '^[0-9]+$'
            then (row_data.row_payload->'restrictedContextLedger'->>'usableInputTokens')::numeric <= 0
            else false end)
          or row_data.row_payload->'restrictedContextLedger'->>'modelId' <> 'glm-5-turbo'
          or (case when row_data.row_payload->'restrictedContextLedger'->>'inputTokens' ~ '^[0-9]+$'
            then (row_data.row_payload->'restrictedContextLedger'->>'inputTokens')::numeric < 0
            else false end)
          or (case when row_data.row_payload->'restrictedContextLedger'->>'inputTokens' ~ '^[0-9]+$'
            and row_data.row_payload->'restrictedContextLedger'->>'usableInputTokens' ~ '^[0-9]+$'
            then (row_data.row_payload->'restrictedContextLedger'->>'inputTokens')::numeric >
              (row_data.row_payload->'restrictedContextLedger'->>'usableInputTokens')::numeric
            else false end)
          or exists (
            select 1
            from jsonb_array_elements(row_data.row_payload->'restrictedContextLedger'->'selectedConversation') entry
            where jsonb_typeof(entry) is distinct from 'object'
              or entry->>'kind' not in ('complete', 'failed')
              or jsonb_typeof(entry->'turnId') is distinct from 'string'
              or jsonb_typeof(entry->'userMessageId') is distinct from 'string'
              or entry->>'turnId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              or entry->>'userMessageId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              or (entry->>'kind' = 'complete' and (
                jsonb_typeof(entry->'assistantMessageId') is distinct from 'string'
                or entry->>'assistantMessageId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                or exists (select 1 from jsonb_object_keys(entry) key where key not in ('kind', 'turnId', 'userMessageId', 'assistantMessageId'))
              ))
              or (entry->>'kind' = 'failed' and (
                jsonb_typeof(entry->'errorCode') is distinct from 'string'
                or jsonb_typeof(entry->'retryable') is distinct from 'boolean'
                or coalesce(btrim(entry->>'errorCode'), '') = ''
                or exists (select 1 from jsonb_object_keys(entry) key where key not in ('kind', 'turnId', 'userMessageId', 'errorCode', 'retryable'))
              ))
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: restricted context ledger is not strict',
            row_data.row_identity;
        end if;
        if row_data.row_payload->'restrictedContextLedger'->>'requestKind' in ('direct', 'topic')
          and (
            jsonb_typeof(row_data.row_payload->'restrictedContextLedger'->'sources') is distinct from 'array'
            or exists (
              select 1
              from jsonb_array_elements(row_data.row_payload->'restrictedContextLedger'->'sources') source
              where jsonb_typeof(source) is distinct from 'object'
                or jsonb_typeof(source->'candidateId') is distinct from 'string'
                or coalesce(btrim(source->>'candidateId'), '') = ''
                or jsonb_typeof(source->'sourceKey') is distinct from 'string'
                or source->>'sourceKey' !~ '^k_(?:cn_[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]+)_[1-9][0-9]*$'
                or jsonb_typeof(source->'kind') is distinct from 'string'
                or source->>'kind' not in ('document', 'chat_message', 'memory', 'web')
                or jsonb_typeof(source->'purpose') is distinct from 'string'
                or coalesce(btrim(source->>'purpose'), '') = ''
                or not jsonb_exists(source, 'label')
                or jsonb_typeof(source->'label') not in ('string', 'null')
                or jsonb_typeof(source->'ranges') is distinct from 'array'
                or exists (
                  select 1 from jsonb_array_elements(case when jsonb_typeof(source->'ranges') = 'array' then source->'ranges' else '[]'::jsonb end) range_row
                  where jsonb_typeof(range_row) is distinct from 'object'
                    or jsonb_typeof(range_row->'charStart') is distinct from 'number'
                    or jsonb_typeof(range_row->'charEnd') is distinct from 'number'
                    or range_row->>'charStart' !~ '^[0-9]+$'
                    or range_row->>'charEnd' !~ '^[0-9]+$'
                    or (case when range_row->>'charStart' ~ '^[0-9]+$'
                      and range_row->>'charEnd' ~ '^[0-9]+$'
                      then (range_row->>'charEnd')::numeric <= (range_row->>'charStart')::numeric
                      else false end)
                    or exists (select 1 from jsonb_object_keys(range_row) key where key not in ('charStart', 'charEnd'))
                  )
                or exists (select 1 from jsonb_object_keys(source) key where key not in ('candidateId', 'sourceKey', 'kind', 'purpose', 'label', 'ranges'))
            )
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: restricted context ledger is not strict',
            row_data.row_identity;
        end if;
        if row_data.row_payload->'restrictedContextLedger'->>'requestKind' = 'synthesis'
          and (
            jsonb_typeof(row_data.row_payload->'restrictedContextLedger'->'packets') is distinct from 'array'
            or exists (
              select 1 from jsonb_array_elements(row_data.row_payload->'restrictedContextLedger'->'packets') packet
              where jsonb_typeof(packet) is distinct from 'object'
                or jsonb_typeof(packet->'topicId') is distinct from 'string'
                or packet->>'topicId' not in ('t1', 't2', 't3')
                or jsonb_typeof(packet->'status') is distinct from 'string'
                or packet->>'status' not in ('answered', 'partial')
                or jsonb_typeof(packet->'claimCount') is distinct from 'number'
                or jsonb_typeof(packet->'gapCount') is distinct from 'number'
                or packet->>'claimCount' !~ '^[0-9]+$'
                or packet->>'gapCount' !~ '^[0-9]+$'
                or jsonb_typeof(packet->'packetSha256Hex') is distinct from 'string'
                or packet->>'packetSha256Hex' !~ '^[0-9a-f]{64}$'
                or exists (select 1 from jsonb_object_keys(packet) key where key not in ('topicId', 'status', 'claimCount', 'gapCount', 'packetSha256Hex'))
            )
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: restricted context ledger is not strict',
          row_data.row_identity;
        end if;
      end if;
      if row_data.row_kind = 'context_measurement'
        and (
          jsonb_typeof(row_data.row_payload->'consumerTaskId') is distinct from 'string'
          or coalesce(btrim(row_data.row_payload->>'consumerTaskId'), '') = ''
          or (jsonb_exists(row_data.row_payload, 'topicId')
            and (jsonb_typeof(row_data.row_payload->'topicId') is distinct from 'string'
              or row_data.row_payload->>'topicId' not in ('t1', 't2', 't3')))
          or jsonb_typeof(row_data.row_payload->'mandatoryInputTokens') is distinct from 'number'
          or jsonb_typeof(row_data.row_payload->'discretionaryInputTokens') is distinct from 'number'
          or jsonb_typeof(row_data.row_payload->'totalInputTokens') is distinct from 'number'
          or jsonb_typeof(row_data.row_payload->'requestedOutputTokens') is distinct from 'number'
          or jsonb_typeof(row_data.row_payload->'usableInputTokens') is distinct from 'number'
          or jsonb_typeof(row_data.row_payload->'contextWindow') is distinct from 'number'
          or jsonb_typeof(row_data.row_payload->'status') is distinct from 'string'
          or jsonb_typeof(row_data.row_payload->'reductionRan') is distinct from 'boolean'
          or row_data.row_payload->>'mandatoryInputTokens' !~ '^[0-9]+$'
          or row_data.row_payload->>'discretionaryInputTokens' !~ '^[0-9]+$'
          or row_data.row_payload->>'totalInputTokens' !~ '^[0-9]+$'
          or row_data.row_payload->>'requestedOutputTokens' !~ '^[0-9]+$'
          or row_data.row_payload->>'usableInputTokens' !~ '^[0-9]+$'
          or row_data.row_payload->>'contextWindow' !~ '^[0-9]+$'
          or row_data.row_payload->>'status' not in ('ready', 'needs_reduction')
          or row_data.row_payload->>'reductionRan' not in ('true', 'false')
          or jsonb_typeof(row_data.row_payload->'reductionFeedback') is distinct from 'array'
          or exists (
            select 1
            from jsonb_array_elements(case when jsonb_typeof(row_data.row_payload->'reductionFeedback') = 'array'
              then row_data.row_payload->'reductionFeedback' else '[]'::jsonb end) feedback
            where jsonb_typeof(feedback) is distinct from 'string'
          )
          or (case when row_data.row_payload->>'mandatoryInputTokens' ~ '^[0-9]+$'
            then (row_data.row_payload->>'mandatoryInputTokens')::numeric > 9007199254740991
              or (row_data.row_payload->>'mandatoryInputTokens')::numeric < 0
            else true end)
          or (case when row_data.row_payload->>'discretionaryInputTokens' ~ '^[0-9]+$'
            then (row_data.row_payload->>'discretionaryInputTokens')::numeric > 9007199254740991
              or (row_data.row_payload->>'discretionaryInputTokens')::numeric < 0
            else true end)
          or (case when row_data.row_payload->>'totalInputTokens' ~ '^[0-9]+$'
            then (row_data.row_payload->>'totalInputTokens')::numeric > 9007199254740991
              or (row_data.row_payload->>'totalInputTokens')::numeric < 0
            else true end)
          or (case when row_data.row_payload->>'requestedOutputTokens' ~ '^[0-9]+$'
            then (row_data.row_payload->>'requestedOutputTokens')::numeric > 9007199254740991
              or (row_data.row_payload->>'requestedOutputTokens')::numeric <= 0
            else true end)
          or (case when row_data.row_payload->>'usableInputTokens' ~ '^[0-9]+$'
            then (row_data.row_payload->>'usableInputTokens')::numeric > 9007199254740991
              or (row_data.row_payload->>'usableInputTokens')::numeric <= 0
            else true end)
          or (case when row_data.row_payload->>'contextWindow' ~ '^[0-9]+$'
            then (row_data.row_payload->>'contextWindow')::numeric > 9007199254740991
            else true end)
          or (case when row_data.row_payload->>'contextWindow' ~ '^[0-9]+$'
            and row_data.row_payload->>'requestedOutputTokens' ~ '^[0-9]+$'
            then (row_data.row_payload->>'contextWindow')::numeric <= (row_data.row_payload->>'requestedOutputTokens')::numeric
            else true end)
          or (case when row_data.row_payload->>'usableInputTokens' ~ '^[0-9]+$'
            and row_data.row_payload->>'contextWindow' ~ '^[0-9]+$'
            and row_data.row_payload->>'requestedOutputTokens' ~ '^[0-9]+$'
            then (row_data.row_payload->>'usableInputTokens')::numeric >
              (row_data.row_payload->>'contextWindow')::numeric - (row_data.row_payload->>'requestedOutputTokens')::numeric
            else true end)
          or (case when row_data.row_payload->>'totalInputTokens' ~ '^[0-9]+$'
            and row_data.row_payload->>'mandatoryInputTokens' ~ '^[0-9]+$'
            and row_data.row_payload->>'discretionaryInputTokens' ~ '^[0-9]+$'
            then (row_data.row_payload->>'totalInputTokens')::numeric <>
              (row_data.row_payload->>'mandatoryInputTokens')::numeric + (row_data.row_payload->>'discretionaryInputTokens')::numeric
            else true end)
          or exists (select 1 from jsonb_object_keys(row_data.row_payload) key where key not in (
            'consumerTaskId', 'topicId', 'mandatoryInputTokens', 'discretionaryInputTokens',
            'totalInputTokens', 'requestedOutputTokens', 'usableInputTokens', 'contextWindow',
            'status', 'reductionRan', 'reductionFeedback', 'restrictedContextLedger'
          ))
        ) then
        raise exception 'AI chat schema cutover preflight row ai_observations/%: context measurement payload is not strict', row_data.row_identity;
      end if;
      if row_data.row_kind = 'context_reducer_terminal'
        and (jsonb_typeof(row_data.row_payload->'stopReason') is distinct from 'string'
          or row_data.row_payload->>'stopReason' not in ('stop', 'length', 'toolUse')) then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: context reducer terminal payload is not strict',
          row_data.row_identity;
      end if;
      if row_data.row_kind = 'candidate_rejected'
        and (jsonb_typeof(row_data.row_payload->'candidateId') is distinct from 'string'
          or coalesce(btrim(row_data.row_payload->>'candidateId'), '') = ''
          or jsonb_typeof(row_data.row_payload->'reason') is distinct from 'string'
          or row_data.row_payload->>'reason' not in ('inaccessible', 'missing', 'invalid_range', 'ambiguous_provenance', 'duplicate', 'overlap_merged')
          or exists (select 1 from jsonb_object_keys(row_data.row_payload) key where key not in ('candidateId', 'reason'))) then
        raise exception 'AI chat schema cutover preflight row ai_observations/%: candidate rejection payload is not strict', row_data.row_identity;
      end if;
      if row_data.row_kind = 'retrieval_manifest'
        and (row_data.loop_iteration < 0
          or row_data.attempt < 0
          or row_data.observation_key is distinct from format(
            '%s:%s:%s:retrieval_manifest:result',
            row_data.emitting_task, row_data.loop_iteration, row_data.attempt
          )
          or jsonb_typeof(row_data.row_payload->'selectorRole') is distinct from 'string'
          or row_data.row_payload->>'selectorRole' not in ('internal', 'memory', 'web', 'general_planner')
          or jsonb_typeof(row_data.row_payload->'references') is distinct from 'array'
          or (jsonb_exists(row_data.row_payload, 'noCallReason') and (
            jsonb_typeof(row_data.row_payload->'noCallReason') is distinct from 'string'
            or row_data.row_payload->>'noCallReason' not in (
              'memory_mode_disabled', 'no_active_memories', 'web_not_requested',
              'web_policy_disabled', 'topic_not_web_eligible'
            )
            or jsonb_array_length(case when jsonb_typeof(row_data.row_payload->'references') = 'array'
              then row_data.row_payload->'references' else '[]'::jsonb end) <> 0
            or (row_data.row_payload->>'noCallReason' in ('memory_mode_disabled', 'no_active_memories')
              and row_data.row_payload->>'selectorRole' <> 'memory')
            or (row_data.row_payload->>'noCallReason' in ('web_not_requested', 'web_policy_disabled', 'topic_not_web_eligible')
              and row_data.row_payload->>'selectorRole' <> 'web')
          ))
          or exists (
            select 1
            from jsonb_array_elements(case when jsonb_typeof(row_data.row_payload->'references') = 'array'
              then row_data.row_payload->'references' else '[]'::jsonb end) reference
            where jsonb_typeof(reference) is distinct from 'object'
              or (reference->>'kind' = 'document' and (
                jsonb_typeof(reference->'documentId') is distinct from 'string'
                or jsonb_typeof(reference->'versionId') is distinct from 'string'
                or jsonb_typeof(reference->'source') is distinct from 'object'
                or jsonb_typeof(reference->'source'->'kind') is distinct from 'string'
                or jsonb_typeof(reference->'source'->'sourceId') is distinct from 'string'
                or (jsonb_exists(reference, 'ranges') and (
                  jsonb_typeof(reference->'ranges') is distinct from 'array'
                  or exists (
                    select 1
                    from jsonb_array_elements(case when jsonb_typeof(reference->'ranges') = 'array'
                      then reference->'ranges' else '[]'::jsonb end) range_row
                    where jsonb_typeof(range_row) is distinct from 'object'
                      or jsonb_typeof(range_row->'charStart') is distinct from 'number'
                      or jsonb_typeof(range_row->'charEnd') is distinct from 'number'
                      or range_row->>'charStart' !~ '^[0-9]+$'
                      or range_row->>'charEnd' !~ '^[0-9]+$'
                      or (case when range_row->>'charStart' ~ '^[0-9]+$'
                        and range_row->>'charEnd' ~ '^[0-9]+$'
                        then (range_row->>'charEnd')::numeric <= (range_row->>'charStart')::numeric
                        else false end)
                  )
                ))
              ))
              or (reference->>'kind' = 'chat_message' and jsonb_typeof(reference->'messageId') is distinct from 'string')
              or (reference ? 'memoryId' and jsonb_typeof(reference->'memoryRevisionId') is distinct from 'string')
              or (reference ? 'url' and (
                jsonb_typeof(reference->'url') is distinct from 'string'
                or jsonb_typeof(reference->'title') is distinct from 'string'
                or jsonb_typeof(reference->'domain') is distinct from 'string'
                or jsonb_typeof(reference->'quote') is distinct from 'string'
                or jsonb_typeof(reference->'capturedAt') is distinct from 'string'
              ))
              or (reference->>'kind' = 'document' and (
                coalesce(btrim(reference->>'documentId'), '') = ''
                or coalesce(btrim(reference->>'versionId'), '') = ''
                or coalesce(btrim(reference->>'purpose'), '') = ''
                or jsonb_typeof(reference->'purpose') is distinct from 'string'
                or (jsonb_exists(reference, 'publisherExtractionId')
                  and jsonb_typeof(reference->'publisherExtractionId') is distinct from 'string')
                or jsonb_typeof(reference->'source') is distinct from 'object'
                or reference->'source'->>'kind' not in ('public', 'publisher')
                or coalesce(btrim(reference->'source'->>'sourceId'), '') = ''
                or (reference->'source'->>'kind' = 'publisher' and (
                  coalesce(btrim(reference->'source'->>'issueId'), '') = ''
                  or coalesce(btrim(reference->'source'->>'documentId'), '') = ''
                ))
                or (reference->'source'->>'kind' = 'public' and exists (
                  select 1 from jsonb_object_keys(reference->'source') key
                  where key not in ('kind', 'sourceId')
                ))
                or (reference->'source'->>'kind' = 'publisher' and exists (
                  select 1 from jsonb_object_keys(reference->'source') key
                  where key not in ('kind', 'sourceId', 'issueId', 'documentId')
                ))
                or exists (select 1 from jsonb_object_keys(reference) key
                  where key not in ('kind', 'documentId', 'versionId', 'publisherExtractionId', 'source', 'ranges', 'purpose'))
              ))
              or (reference->>'kind' = 'chat_message' and (
                coalesce(btrim(reference->>'messageId'), '') = ''
                or jsonb_typeof(reference->'messageId') is distinct from 'string'
                or jsonb_typeof(reference->'purpose') is distinct from 'string'
                or coalesce(btrim(reference->>'purpose'), '') = ''
                or exists (select 1 from jsonb_object_keys(reference) key
                  where key not in ('kind', 'messageId', 'purpose'))
              ))
              or (reference ? 'memoryId' and (
                coalesce(btrim(reference->>'memoryId'), '') = ''
                or coalesce(btrim(reference->>'memoryRevisionId'), '') = ''
                or jsonb_typeof(reference->'memoryId') is distinct from 'string'
                or jsonb_typeof(reference->'memoryRevisionId') is distinct from 'string'
                or jsonb_exists(reference, 'kind')
                or exists (select 1 from jsonb_object_keys(reference) key
                  where key not in ('memoryId', 'memoryRevisionId'))
              ))
              or (reference ? 'url' and (
                coalesce(btrim(reference->>'url'), '') = ''
                or coalesce(btrim(reference->>'title'), '') = ''
                or coalesce(btrim(reference->>'domain'), '') = ''
                or coalesce(btrim(reference->>'quote'), '') = ''
                or coalesce(btrim(reference->>'capturedAt'), '') = ''
                or jsonb_typeof(reference->'purpose') is distinct from 'string'
                or coalesce(btrim(reference->>'purpose'), '') = ''
                or (jsonb_exists(reference, 'publishedAt')
                  and jsonb_typeof(reference->'publishedAt') is distinct from 'string')
                or exists (select 1 from jsonb_object_keys(reference) key
                  where key not in ('url', 'title', 'domain', 'quote', 'publishedAt', 'capturedAt', 'purpose'))
              ))
              or (reference ? 'sourceId' and (
                coalesce(btrim(reference->>'sourceId'), '') = ''
                or jsonb_typeof(reference->'ranges') is distinct from 'array'
                or exists (select 1 from jsonb_object_keys(reference) key
                  where key not in ('sourceId', 'ranges'))
              ))
              or not (
                reference->>'kind' in ('document', 'chat_message')
                or reference ? 'memoryId'
                or reference ? 'url'
                or reference ? 'sourceId'
              )
          )
          or exists (select 1 from jsonb_object_keys(row_data.row_payload) key where key not in ('selectorRole', 'references', 'noCallReason'))) then
        raise exception 'AI chat schema cutover preflight row ai_observations/%: retrieval manifest payload is not strict', row_data.row_identity;
      end if;
      if row_data.row_kind = 'retrieval_no_call_seal'
        and (row_data.emitting_task <> 'finalize'
          or jsonb_typeof(row_data.row_payload->'selectorTaskId') is distinct from 'string'
          or coalesce(btrim(row_data.row_payload->>'selectorTaskId'), '') = ''
          or jsonb_typeof(row_data.row_payload->'selectorLoopIteration') is distinct from 'number'
          or row_data.row_payload->>'selectorLoopIteration' !~ '^[0-9]+$'
          or jsonb_typeof(row_data.row_payload->'selectorAttempt') is distinct from 'number'
          or row_data.row_payload->>'selectorAttempt' !~ '^[0-9]+$'
          or jsonb_typeof(row_data.row_payload->'selectorObservationKey') is distinct from 'string'
          or row_data.row_payload->>'selectorObservationKey' is distinct from format(
            '%s:%s:%s:retrieval_manifest:result',
            row_data.row_payload->>'selectorTaskId',
            row_data.row_payload->>'selectorLoopIteration',
            row_data.row_payload->>'selectorAttempt'
          )
          or row_data.observation_key is distinct from format(
            'retrieval_no_call_seal:%s:%s:%s',
            row_data.row_payload->>'selectorTaskId',
            row_data.row_payload->>'selectorLoopIteration',
            row_data.row_payload->>'selectorAttempt'
          )
          or jsonb_typeof(row_data.row_payload->'noCallReason') is distinct from 'string'
          or row_data.row_payload->>'noCallReason' not in (
            'memory_mode_disabled', 'no_active_memories', 'web_not_requested',
            'web_policy_disabled', 'topic_not_web_eligible'
          )
          or exists (select 1 from jsonb_object_keys(row_data.row_payload) key where key not in (
            'selectorTaskId', 'selectorLoopIteration', 'selectorAttempt',
            'selectorObservationKey', 'noCallReason'
          ))) then
        raise exception 'AI chat schema cutover preflight row ai_observations/%: retrieval no-call seal is not strict', row_data.row_identity;
      end if;
      if row_data.row_kind = 'turn_plan'
        and (
          jsonb_typeof(row_data.row_payload->'mode') is distinct from 'string'
          or row_data.row_payload->>'mode' not in ('clarify', 'single', 'fanout')
          or jsonb_typeof(row_data.row_payload->'question') is distinct from 'string'
          or coalesce(btrim(row_data.row_payload->>'question'), '') = ''
          or exists (select 1 from jsonb_object_keys(row_data.row_payload) key where key not in ('mode', 'question', 'relevantTurnIds', 'topics'))
          or (row_data.row_payload->>'mode' <> 'fanout' and jsonb_exists(row_data.row_payload, 'topics'))
          or (row_data.row_payload->>'mode' = 'fanout' and (
            jsonb_typeof(row_data.row_payload->'topics') is distinct from 'array'
            or (case when jsonb_typeof(row_data.row_payload->'topics') = 'array'
              then jsonb_array_length(row_data.row_payload->'topics') not between 2 and 3
              else false
            end)
            or jsonb_exists(row_data.row_payload, 'relevantTurnIds')
            or exists (
              select 1
              from jsonb_array_elements(row_data.row_payload->'topics') with ordinality topic(value, ordinal)
              where topic.value->>'topicId' is distinct from 't' || topic.ordinal::text
            )
          ))
          or (row_data.row_payload->>'mode' = 'single' and (
            jsonb_typeof(row_data.row_payload->'relevantTurnIds') is distinct from 'array'
            or jsonb_exists(row_data.row_payload, 'topics')
          ))
          or (row_data.row_payload->>'mode' = 'clarify' and jsonb_exists(row_data.row_payload, 'relevantTurnIds'))
          or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(row_data.row_payload->'relevantTurnIds') = 'array' then row_data.row_payload->'relevantTurnIds' else '[]'::jsonb end) item where jsonb_typeof(item) is distinct from 'string' or btrim(item #>> '{}') = '')
          or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(row_data.row_payload->'topics') = 'array' then row_data.row_payload->'topics' else '[]'::jsonb end) item where jsonb_typeof(item) is distinct from 'object' or item->>'topicId' not in ('t1', 't2', 't3') or jsonb_typeof(item->'question') is distinct from 'string' or coalesce(btrim(item->>'question'), '') = '' or jsonb_typeof(item->'relevantTurnIds') is distinct from 'array' or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(item->'relevantTurnIds') = 'array' then item->'relevantTurnIds' else '[]'::jsonb end) turn_id where jsonb_typeof(turn_id) is distinct from 'string' or btrim(turn_id #>> '{}') = '') or exists (select 1 from jsonb_object_keys(item) key where key not in ('topicId', 'question', 'relevantTurnIds')))
        ) then
        raise exception 'AI chat schema cutover preflight row ai_observations/%: turn plan payload is not strict', row_data.row_identity;
      end if;
      if row_data.row_kind = 'context_reducer_terminal'
        and (jsonb_typeof(row_data.row_payload->'terminalUsageCoordinate') is distinct from 'object'
          or jsonb_typeof(row_data.row_payload->'modelId') is distinct from 'string'
          or row_data.row_payload->>'modelId' <> 'glm-5-turbo'
          or jsonb_typeof(row_data.row_payload->'requestSha256Hex') is distinct from 'string'
          or row_data.row_payload->>'requestSha256Hex' !~ '^[0-9a-f]{64}$'
          or jsonb_typeof(row_data.row_payload->'providerInputTokens') is distinct from 'number'
          or jsonb_typeof(row_data.row_payload->'totalTokens') is distinct from 'number'
          or row_data.row_payload->>'providerInputTokens' !~ '^[0-9]+$'
          or row_data.row_payload->>'totalTokens' !~ '^[0-9]+$'
          or (case when row_data.row_payload->>'providerInputTokens' ~ '^[0-9]+$' then (row_data.row_payload->>'providerInputTokens')::numeric > 9007199254740991 else false end)
          or (case when row_data.row_payload->>'totalTokens' ~ '^[0-9]+$' then (row_data.row_payload->>'totalTokens')::numeric > 9007199254740991 else false end)
          or jsonb_typeof(row_data.row_payload->'terminalUsageCoordinate'->'taskId') is distinct from 'string'
          or coalesce(btrim(row_data.row_payload->'terminalUsageCoordinate'->>'taskId'), '') = ''
          or jsonb_typeof(row_data.row_payload->'terminalUsageCoordinate'->'loopIteration') is distinct from 'number'
          or jsonb_typeof(row_data.row_payload->'terminalUsageCoordinate'->'attempt') is distinct from 'number'
          or jsonb_typeof(row_data.row_payload->'terminalUsageCoordinate'->'providerRequestIndex') is distinct from 'number'
          or row_data.row_payload->'terminalUsageCoordinate'->>'loopIteration' !~ '^[0-9]+$'
          or row_data.row_payload->'terminalUsageCoordinate'->>'attempt' !~ '^[0-9]+$'
          or row_data.row_payload->'terminalUsageCoordinate'->>'providerRequestIndex' !~ '^[0-9]+$'
          or (case when row_data.row_payload->'terminalUsageCoordinate'->>'loopIteration' ~ '^[0-9]+$' then (row_data.row_payload->'terminalUsageCoordinate'->>'loopIteration')::numeric > 9007199254740991 else false end)
          or (case when row_data.row_payload->'terminalUsageCoordinate'->>'attempt' ~ '^[0-9]+$' then (row_data.row_payload->'terminalUsageCoordinate'->>'attempt')::numeric > 9007199254740991 else false end)
          or (case when row_data.row_payload->'terminalUsageCoordinate'->>'providerRequestIndex' ~ '^[0-9]+$' then (row_data.row_payload->'terminalUsageCoordinate'->>'providerRequestIndex')::numeric > 9007199254740991 else false end)
          or exists (select 1 from jsonb_object_keys(row_data.row_payload->'terminalUsageCoordinate') key where key not in ('taskId', 'loopIteration', 'attempt', 'providerRequestIndex'))
          or exists (select 1 from jsonb_object_keys(row_data.row_payload) key where key not in ('terminalUsageCoordinate', 'modelId', 'requestSha256Hex', 'providerInputTokens', 'totalTokens', 'stopReason'))) then
        raise exception 'AI chat schema cutover preflight row ai_observations/%: context reducer terminal payload is not strict', row_data.row_identity;
      end if;
      if row_data.row_kind = 'context_serialized'
        and (jsonb_typeof(row_data.row_payload->'consumerTaskId') is distinct from 'string'
          or coalesce(btrim(row_data.row_payload->>'consumerTaskId'), '') = ''
          or jsonb_typeof(row_data.row_payload->'sourceKeys') is distinct from 'array'
          or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(row_data.row_payload->'sourceKeys') = 'array' then row_data.row_payload->'sourceKeys' else '[]'::jsonb end) source_key where jsonb_typeof(source_key) is distinct from 'string' or source_key #>> '{}' !~ '^k_(?:cn_[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]+)_[1-9][0-9]*$' or (case when substring(source_key #>> '{}' from '_([1-9][0-9]*)$') ~ '^[0-9]+$' then substring(source_key #>> '{}' from '_([1-9][0-9]*)$')::numeric > 2147483647 else true end))
          or exists (select 1 from jsonb_object_keys(row_data.row_payload) key where key not in ('consumerTaskId', 'topicId', 'sourceKeys', 'restrictedContextLedger', 'terminalUsageCoordinate'))) then
        raise exception 'AI chat schema cutover preflight row ai_observations/%: context serialization payload is not strict', row_data.row_identity;
      end if;
      if row_data.row_kind = 'topic_packet'
        and (jsonb_typeof(row_data.row_payload->'topicId') is distinct from 'string'
          or row_data.row_payload->>'topicId' not in ('t1', 't2', 't3')
          or jsonb_typeof(row_data.row_payload->'status') is distinct from 'string'
          or row_data.row_payload->>'status' not in ('answered', 'partial')
          or jsonb_typeof(row_data.row_payload->'sourceKeys') is distinct from 'array'
          or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(row_data.row_payload->'sourceKeys') = 'array' then row_data.row_payload->'sourceKeys' else '[]'::jsonb end) source_key where jsonb_typeof(source_key) is distinct from 'string')
          or jsonb_typeof(row_data.row_payload->'claimCount') is distinct from 'number'
          or jsonb_typeof(row_data.row_payload->'gapCount') is distinct from 'number'
          or row_data.row_payload->>'claimCount' !~ '^[0-9]+$'
          or row_data.row_payload->>'gapCount' !~ '^[0-9]+$'
          or jsonb_typeof(row_data.row_payload->'packetSha256Hex') is distinct from 'string'
          or row_data.row_payload->>'packetSha256Hex' !~ '^[0-9a-f]{64}$'
          or exists (select 1 from jsonb_object_keys(row_data.row_payload) key where key not in ('topicId', 'status', 'sourceKeys', 'claimCount', 'gapCount', 'packetSha256Hex'))) then
        raise exception 'AI chat schema cutover preflight row ai_observations/%: topic packet payload is not strict', row_data.row_identity;
      end if;
      if row_data.row_kind = 'memory_extraction_result'
        and (jsonb_typeof(row_data.row_payload->'proposalCount') is distinct from 'number'
          or jsonb_typeof(row_data.row_payload->'discardedCount') is distinct from 'number'
          or jsonb_typeof(row_data.row_payload->'extractionSha256Hex') is distinct from 'string'
          or row_data.row_payload->>'proposalCount' !~ '^[0-9]+$'
          or row_data.row_payload->>'discardedCount' !~ '^[0-9]+$'
          or row_data.row_payload->>'extractionSha256Hex' !~ '^[0-9a-f]{64}$'
          or exists (select 1 from jsonb_object_keys(row_data.row_payload) key where key not in ('proposalCount', 'discardedCount', 'extractionSha256Hex'))) then
        raise exception 'AI chat schema cutover preflight row ai_observations/%: memory extraction payload is not strict', row_data.row_identity;
      end if;
      if row_data.row_kind = 'memory_application'
        and (jsonb_typeof(row_data.row_payload->'extractionTaskId') is distinct from 'string'
          or jsonb_typeof(row_data.row_payload->'extractionLoopIteration') is distinct from 'number'
          or jsonb_typeof(row_data.row_payload->'extractionAttempt') is distinct from 'number'
          or jsonb_typeof(row_data.row_payload->'extractionObservationKey') is distinct from 'string'
          or jsonb_typeof(row_data.row_payload->'extractionSha256Hex') is distinct from 'string'
          or jsonb_typeof(row_data.row_payload->'proposalCount') is distinct from 'number'
          or jsonb_typeof(row_data.row_payload->'discardedCount') is distinct from 'number'
          or row_data.row_payload->>'extractionSha256Hex' !~ '^[0-9a-f]{64}$'
          or row_data.row_payload->>'extractionLoopIteration' !~ '^[0-9]+$'
          or row_data.row_payload->>'extractionAttempt' !~ '^[0-9]+$'
          or row_data.row_payload->>'proposalCount' !~ '^[0-9]+$'
          or row_data.row_payload->>'discardedCount' !~ '^[0-9]+$'
          or (case when row_data.row_payload->>'extractionLoopIteration' ~ '^[0-9]+$' then (row_data.row_payload->>'extractionLoopIteration')::numeric > 9007199254740991 else false end)
          or (case when row_data.row_payload->>'extractionAttempt' ~ '^[0-9]+$' then (row_data.row_payload->>'extractionAttempt')::numeric > 9007199254740991 else false end)
          or (case when row_data.row_payload->>'proposalCount' ~ '^[0-9]+$' then (row_data.row_payload->>'proposalCount')::numeric > 9007199254740991 else false end)
          or (case when row_data.row_payload->>'discardedCount' ~ '^[0-9]+$' then (row_data.row_payload->>'discardedCount')::numeric > 9007199254740991 else false end)
          or exists (select 1 from jsonb_object_keys(row_data.row_payload) key where key not in ('extractionTaskId', 'extractionLoopIteration', 'extractionAttempt', 'extractionObservationKey', 'extractionSha256Hex', 'proposalCount', 'discardedCount'))) then
        raise exception 'AI chat schema cutover preflight row ai_observations/%: memory application payload is not strict', row_data.row_identity;
      end if;
      if row_data.row_kind = 'memory_written'
        and (jsonb_typeof(row_data.row_payload->'ordinal') is distinct from 'number'
          or jsonb_typeof(row_data.row_payload->'memoryId') is distinct from 'string'
          or jsonb_typeof(row_data.row_payload->'revisionId') is distinct from 'string'
          or jsonb_typeof(row_data.row_payload->'action') is distinct from 'string'
          or row_data.row_payload->>'ordinal' !~ '^[0-9]+$'
          or length(row_data.row_payload->>'ordinal') > 16
          or (case when row_data.row_payload->>'ordinal' ~ '^[0-9]+$'
            then (row_data.row_payload->>'ordinal')::numeric > 9007199254740991
            else false end)
          or row_data.row_payload->>'memoryId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or row_data.row_payload->>'revisionId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or row_data.row_payload->>'action' not in ('create', 'update')
          or not jsonb_exists(row_data.row_payload, 'previousRevisionId')
          or jsonb_typeof(row_data.row_payload->'previousRevisionId') not in ('string', 'null')
          or (jsonb_typeof(row_data.row_payload->'previousRevisionId') = 'string'
            and row_data.row_payload->>'previousRevisionId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
          or (row_data.row_payload->>'action' = 'create' and row_data.row_payload->'previousRevisionId' <> 'null'::jsonb)
          or exists (select 1 from jsonb_object_keys(row_data.row_payload) key where key not in ('ordinal', 'memoryId', 'revisionId', 'previousRevisionId', 'action'))) then
        raise exception 'AI chat schema cutover preflight row ai_observations/%: memory write payload is not strict', row_data.row_identity;
      end if;
      if row_data.row_kind = 'context_decision'
        and (jsonb_typeof(row_data.row_payload->'valid') is distinct from 'boolean'
          or jsonb_typeof(row_data.row_payload->'decisions') is distinct from 'array'
          or exists (
            select 1
            from jsonb_array_elements(case when jsonb_typeof(row_data.row_payload->'decisions') = 'array'
              then row_data.row_payload->'decisions' else '[]'::jsonb end) decision
            where jsonb_typeof(decision) is distinct from 'object'
              or jsonb_typeof(decision->'id') is distinct from 'string'
              or jsonb_typeof(decision->'action') is distinct from 'string'
              or jsonb_typeof(decision->'reason') is distinct from 'string'
              or decision->>'action' not in ('keep', 'range', 'omit')
              or coalesce(btrim(decision->>'id'), '') = ''
              or coalesce(btrim(decision->>'reason'), '') = ''
              or (decision->>'action' = 'range' and (
                jsonb_typeof(decision->'ranges') is distinct from 'array'
                or exists (
                  select 1
                  from jsonb_array_elements(case when jsonb_typeof(decision->'ranges') = 'array'
                    then decision->'ranges' else '[]'::jsonb end) range_row
                  where jsonb_typeof(range_row) is distinct from 'object'
                    or jsonb_typeof(range_row->'charStart') is distinct from 'number'
                    or jsonb_typeof(range_row->'charEnd') is distinct from 'number'
                    or range_row->>'charStart' !~ '^[0-9]+$'
                    or range_row->>'charEnd' !~ '^[0-9]+$'
                    or (case when range_row->>'charStart' ~ '^[0-9]+$'
                      and range_row->>'charEnd' ~ '^[0-9]+$'
                      then (range_row->>'charEnd')::numeric <= (range_row->>'charStart')::numeric
                      else false end)
                )
              ))
              or (decision->>'action' <> 'range' and jsonb_exists(decision, 'ranges'))
              or exists (select 1 from jsonb_object_keys(decision) key where key not in ('id', 'action', 'ranges', 'reason'))
          )
          or jsonb_typeof(row_data.row_payload->'feedback') is distinct from 'array'
          or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(row_data.row_payload->'feedback') = 'array' then row_data.row_payload->'feedback' else '[]'::jsonb end) feedback where jsonb_typeof(feedback) is distinct from 'string')
          or exists (select 1 from jsonb_object_keys(row_data.row_payload) key where key not in ('valid', 'decisions', 'feedback'))) then
        raise exception 'AI chat schema cutover preflight row ai_observations/%: context decision feedback is not an array of strings', row_data.row_identity;
      end if;
      if row_data.row_kind = 'citation'
        and (jsonb_typeof(row_data.row_payload->'assistantMessageId') is distinct from 'string'
          or jsonb_typeof(row_data.row_payload->'sourceKey') is distinct from 'string'
          or not exists (
            select 1
            from ai_runs runs
            where runs.id = row_data.run_id
              and runs.assistant_message_id::text = row_data.row_payload->>'assistantMessageId'
          )
          or not exists (
            select 1
            from assistant_message_sources sources
            where sources.assistant_message_id::text = row_data.row_payload->>'assistantMessageId'
              and sources.source_key = row_data.row_payload->>'sourceKey'
          )
          or exists (select 1 from jsonb_object_keys(row_data.row_payload) key where key not in ('assistantMessageId', 'sourceKey'))) then
        raise exception 'AI chat schema cutover preflight row ai_observations/%: citation payload is not bound to its answer source', row_data.row_identity;
      end if;
      if row_data.row_kind = 'answer_started'
        and (jsonb_typeof(row_data.row_payload->'mode') is distinct from 'string'
          or row_data.row_payload->>'mode' not in ('clarification', 'single', 'synthesis')
          or jsonb_typeof(row_data.row_payload->'attempt') is distinct from 'number'
          or row_data.row_payload->>'attempt' !~ '^[0-9]+$'
          or exists (select 1 from jsonb_object_keys(row_data.row_payload) key where key not in ('mode', 'attempt'))) then
        raise exception 'AI chat schema cutover preflight row ai_observations/%: answer lifecycle payload is not strict', row_data.row_identity;
      end if;
      if row_data.row_kind = 'answer_completed'
        and (jsonb_typeof(row_data.row_payload->'mode') is distinct from 'string'
          or row_data.row_payload->>'mode' not in ('clarification', 'single', 'synthesis')
          or jsonb_typeof(row_data.row_payload->'attempt') is distinct from 'number'
          or row_data.row_payload->>'attempt' !~ '^[0-9]+$'
          or exists (select 1 from jsonb_object_keys(row_data.row_payload) key where key not in ('mode', 'attempt'))) then
        raise exception 'AI chat schema cutover preflight row ai_observations/%: answer completion payload is not strict', row_data.row_identity;
      end if;
      if row_data.row_kind = 'citation_defect'
        and (jsonb_typeof(row_data.row_payload->'token') is distinct from 'string'
          or jsonb_typeof(row_data.row_payload->'reason') is distinct from 'string'
          or coalesce(btrim(row_data.row_payload->>'token'), '') = ''
          or coalesce(btrim(row_data.row_payload->>'reason'), '') = ''
          or exists (select 1 from jsonb_object_keys(row_data.row_payload) key where key not in ('token', 'reason'))) then
        raise exception 'AI chat schema cutover preflight row ai_observations/%: citation defect payload is not strict', row_data.row_identity;
      end if;
      if row_data.row_kind = 'answer_delta'
        and (jsonb_typeof(row_data.row_payload->'delta') is distinct from 'string'
          or exists (select 1 from jsonb_object_keys(row_data.row_payload) key where key <> 'delta')) then
        raise exception 'AI chat schema cutover preflight row ai_observations/%: answer delta payload is not strict', row_data.row_identity;
      end if;
    end loop;

  for row_data in
      select events.id::text as row_identity,
             case
               when events.event->>'type' = 'usage'
                 and events.event->>'scope' = 'request'
                 and events.event->>'kind' = 'model'
                 then events.event - 'role'
               else events.event
             end as row_event
      from ai_run_events events
      order by events.id
    loop
      if row_data.row_event is null
        or jsonb_typeof(row_data.row_event) is distinct from 'object'
        or row_data.row_event->>'type' not in (
          'run_started', 'context_ready', 'answer_started', 'text_delta',
          'memory_updated', 'usage', 'done', 'error'
        ) then
        raise exception
          'AI chat schema cutover preflight row ai_run_events/%: event type is not canonical',
          row_data.row_identity;
      end if;
      if row_data.row_event->>'type' = 'usage'
        and (
          coalesce(row_data.row_event->>'scope', '') not in ('request', 'run')
          or (row_data.row_event->>'scope' = 'request'
            and coalesce(row_data.row_event->>'kind', '') not in ('model', 'web_search', 'web_fetch'))
          or (row_data.row_event->>'scope' = 'run'
            and jsonb_exists(row_data.row_event, 'kind'))
        ) then
        raise exception
          'AI chat schema cutover preflight row ai_run_events/%: usage event scope or kind is not canonical',
          row_data.row_identity;
      end if;
      legacy_key := null;
      with recursive walk(value) as (
        values (row_data.row_event)
        union all
        select nested.value
        from walk parent
        cross join lateral (
          select object_entries.value
          from jsonb_each(parent.value) object_entries
          where jsonb_typeof(parent.value) = 'object'
          union all
          select array_entries.value
          from jsonb_array_elements(parent.value) array_entries(value)
          where jsonb_typeof(parent.value) = 'array'
        ) nested
      )
      select keys.key into legacy_key
      from walk
      cross join lateral (
        select object_entries.key
        from jsonb_each(walk.value) object_entries
        where jsonb_typeof(walk.value) = 'object'
      ) keys
      where keys.key in ('owner', 'ownerId', 'owner_id', 'role', 'agent_role', 'versionId', 'publisherDocumentVersionId')
      limit 1;
      if legacy_key is not null then
        raise exception
          'AI chat schema cutover preflight row ai_run_events/%: legacy payload field % has no canonical conversion',
          row_data.row_identity,
          legacy_key;
      end if;
      if row_data.row_event->>'type' = 'error'
        and (
          jsonb_typeof(row_data.row_event->'retryable') is distinct from 'boolean'
          or exists (
            select 1
            from jsonb_object_keys(row_data.row_event) key
            where key not in ('type', 'code', 'retryable')
          )
        ) then
        raise exception
          'AI chat schema cutover preflight row ai_run_events/%: error event identity or payload is not canonical',
          row_data.row_identity;
      end if;
    end loop;

  -- Event payloads are the public terminal ledger. Validate each union arm as
  -- a closed object before the cutover can copy or drop its source columns.
  for row_data in
      select events.id::text as row_identity, events.event as row_event
      from ai_run_events events
      order by events.id
    loop
      if row_data.row_event->>'type' = 'run_started' and
         row_data.row_event <> '{"type":"run_started"}'::jsonb then
        raise exception 'AI chat schema cutover preflight row ai_run_events/%: run_started payload is not closed', row_data.row_identity;
      elsif row_data.row_event->>'type' = 'context_ready' and (
        jsonb_typeof(row_data.row_event->'mode') is distinct from 'string'
        or row_data.row_event->>'mode' not in ('clarification', 'single', 'synthesis')
        or jsonb_typeof(row_data.row_event->'reductionRan') is distinct from 'boolean'
        or jsonb_typeof(row_data.row_event->'sourcesRead') is distinct from 'array'
        or jsonb_typeof(row_data.row_event->'consumers') is distinct from 'array'
        or exists (select 1 from jsonb_object_keys(row_data.row_event) key
                   where key not in ('type', 'mode', 'reductionRan', 'sourcesRead', 'consumers'))
        or exists (
          select 1
          from jsonb_array_elements(case when jsonb_typeof(row_data.row_event->'sourcesRead') = 'array'
            then row_data.row_event->'sourcesRead' else '[]'::jsonb end) source
          where jsonb_typeof(source) is distinct from 'object'
            or jsonb_typeof(source->'sourceKey') is distinct from 'string'
            or coalesce(btrim(source->>'sourceKey'), '') = ''
            or jsonb_typeof(source->'label') not in ('string', 'null')
            or jsonb_typeof(source->'tokenCount') is distinct from 'number'
            or source->>'tokenCount' !~ '^[0-9]+$'
            or jsonb_typeof(source->'topicIds') is distinct from 'array'
            or exists (select 1 from jsonb_array_elements(source->'topicIds') topic
                       where jsonb_typeof(topic) is distinct from 'string'
                         or topic #>> '{}' not in ('t1', 't2', 't3'))
            or jsonb_typeof(source->'kind') is distinct from 'string'
            or source->>'kind' not in ('document', 'chat_message', 'memory', 'web')
            or (source->>'kind' = 'document' and (
              jsonb_typeof(source->'documentTitle') is distinct from 'string'
              or jsonb_typeof(source->'url') is distinct from 'string'
              or jsonb_typeof(source->'ranges') is distinct from 'array'))
            or (source->>'kind' = 'chat_message' and (
              jsonb_typeof(source->'messageId') is distinct from 'string'
              or jsonb_typeof(source->'ranges') is distinct from 'array'
              or jsonb_array_length(source->'ranges') <> 0))
            or (source->>'kind' = 'memory' and (
              jsonb_typeof(source->'memoryId') is distinct from 'string'
              or jsonb_typeof(source->'memoryRevisionId') is distinct from 'string'
              or jsonb_typeof(source->'ranges') is distinct from 'array'
              or jsonb_array_length(source->'ranges') <> 0))
            or (source->>'kind' = 'web' and (
              jsonb_typeof(source->'title') is distinct from 'string'
              or jsonb_typeof(source->'domain') is distinct from 'string'
              or jsonb_typeof(source->'url') is distinct from 'string'
              or jsonb_typeof(source->'capturedAt') is distinct from 'string'
              or jsonb_typeof(source->'quote') is distinct from 'string'
              or jsonb_typeof(source->'ranges') is distinct from 'array'
              or jsonb_array_length(source->'ranges') <> 0))
            or (source->>'kind' = 'document' and exists (
              select 1 from jsonb_object_keys(source) key
              where key not in ('sourceKey', 'label', 'tokenCount', 'topicIds', 'kind',
                                'sourceName', 'issueTitle', 'documentTitle', 'url',
                                'publishedAt', 'ranges')))
            or (source->>'kind' = 'chat_message' and exists (
              select 1 from jsonb_object_keys(source) key
              where key not in ('sourceKey', 'label', 'tokenCount', 'topicIds', 'kind',
                                'messageId', 'ranges')))
            or (source->>'kind' = 'memory' and exists (
              select 1 from jsonb_object_keys(source) key
              where key not in ('sourceKey', 'label', 'tokenCount', 'topicIds', 'kind',
                                'memoryId', 'memoryRevisionId', 'ranges')))
            or (source->>'kind' = 'web' and exists (
              select 1 from jsonb_object_keys(source) key
              where key not in ('sourceKey', 'label', 'tokenCount', 'topicIds', 'kind',
                                'title', 'domain', 'url', 'publishedAt', 'capturedAt',
                                'quote', 'ranges')))
        )
        or exists (
          select 1
          from jsonb_array_elements(case when jsonb_typeof(row_data.row_event->'consumers') = 'array'
            then row_data.row_event->'consumers' else '[]'::jsonb end) consumer
          where jsonb_typeof(consumer) is distinct from 'object'
            or jsonb_typeof(consumer->'consumer') is distinct from 'string'
            or consumer->>'consumer' not in ('direct', 'topic', 'synthesis')
            or (consumer ? 'topicId' and consumer->>'topicId' not in ('t1', 't2', 't3'))
            or jsonb_typeof(consumer->'inputTokens') is distinct from 'number'
            or jsonb_typeof(consumer->'requestedOutputTokens') is distinct from 'number'
            or jsonb_typeof(consumer->'usableInputTokens') is distinct from 'number'
            or consumer->>'inputTokens' !~ '^[0-9]+$'
            or consumer->>'requestedOutputTokens' !~ '^[0-9]+$'
            or consumer->>'usableInputTokens' !~ '^[0-9]+$'
            or exists (select 1 from jsonb_object_keys(consumer) key
                       where key not in ('consumer', 'topicId', 'inputTokens', 'requestedOutputTokens', 'usableInputTokens'))
        )
      ) then
        raise exception 'AI chat schema cutover preflight row ai_run_events/%: context_ready payload is not a closed terminal projection', row_data.row_identity;
      elsif row_data.row_event->>'type' = 'answer_started' and (
        jsonb_typeof(row_data.row_event->'mode') is distinct from 'string'
        or row_data.row_event->>'mode' not in ('clarification', 'single', 'synthesis')
        or jsonb_typeof(row_data.row_event->'attempt') is distinct from 'number'
        or row_data.row_event->>'attempt' !~ '^[0-9]+$'
        or exists (select 1 from jsonb_object_keys(row_data.row_event) key
                   where key not in ('type', 'mode', 'attempt'))
      ) then
        raise exception 'AI chat schema cutover preflight row ai_run_events/%: answer lifecycle payload is not closed', row_data.row_identity;
      elsif row_data.row_event->>'type' = 'text_delta' and (
        jsonb_typeof(row_data.row_event->'delta') is distinct from 'string'
        or exists (select 1 from jsonb_object_keys(row_data.row_event) key where key <> 'type' and key <> 'delta')
      ) then
        raise exception 'AI chat schema cutover preflight row ai_run_events/%: text delta payload is not closed', row_data.row_identity;
      elsif row_data.row_event->>'type' = 'memory_updated' and (
        jsonb_typeof(row_data.row_event->'created') is distinct from 'number'
        or jsonb_typeof(row_data.row_event->'updated') is distinct from 'number'
        or jsonb_typeof(row_data.row_event->'discarded') is distinct from 'number'
        or row_data.row_event->>'created' !~ '^[0-9]+$'
        or row_data.row_event->>'updated' !~ '^[0-9]+$'
        or row_data.row_event->>'discarded' !~ '^[0-9]+$'
        or exists (select 1 from jsonb_object_keys(row_data.row_event) key
                   where key not in ('type', 'created', 'updated', 'discarded'))
      ) then
        raise exception 'AI chat schema cutover preflight row ai_run_events/%: memory_updated payload is not closed', row_data.row_identity;
      elsif row_data.row_event->>'type' = 'usage' and row_data.row_event->>'scope' = 'request'
        and row_data.row_event->>'kind' = 'model' and (
          jsonb_typeof(row_data.row_event->'role') is distinct from 'string'
          or coalesce(btrim(row_data.row_event->>'role'), '') = ''
          or jsonb_typeof(row_data.row_event->'attempt') is distinct from 'number'
          or jsonb_typeof(row_data.row_event->'inputTokens') is distinct from 'number'
          or jsonb_typeof(row_data.row_event->'outputTokens') is distinct from 'number'
          or jsonb_typeof(row_data.row_event->'cachedTokens') is distinct from 'number'
          or jsonb_typeof(row_data.row_event->'reasoningTokens') is distinct from 'number'
          or jsonb_typeof(row_data.row_event->'totalTokens') is distinct from 'number'
          or exists (select 1 from jsonb_object_keys(row_data.row_event) key
                     where key not in ('type', 'scope', 'kind', 'role', 'attempt', 'inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens', 'totalTokens'))
      ) then
        raise exception 'AI chat schema cutover preflight row ai_run_events/%: request usage payload is not closed', row_data.row_identity;
      elsif row_data.row_event->>'type' = 'usage' and row_data.row_event->>'scope' = 'request'
        and row_data.row_event->>'kind' in ('web_search', 'web_fetch') and (
          jsonb_typeof(row_data.row_event->'attempt') is distinct from 'number'
          or jsonb_typeof(row_data.row_event->'status') is distinct from 'string'
          or row_data.row_event->>'status' not in ('ok', 'empty', 'failed')
          or jsonb_typeof(row_data.row_event->'resultCount') is distinct from 'number'
          or jsonb_typeof(row_data.row_event->'responseBytes') is distinct from 'number'
          or jsonb_typeof(row_data.row_event->'billedUnits') not in ('number', 'null')
          or jsonb_typeof(row_data.row_event->'durationMs') is distinct from 'number'
          or exists (select 1 from jsonb_object_keys(row_data.row_event) key
                     where key not in ('type', 'scope', 'kind', 'attempt', 'status', 'resultCount', 'responseBytes', 'billedUnits', 'durationMs'))
      ) then
        raise exception 'AI chat schema cutover preflight row ai_run_events/%: external usage payload is not closed', row_data.row_identity;
      elsif row_data.row_event->>'type' = 'usage' and row_data.row_event->>'scope' = 'run' and (
        jsonb_typeof(row_data.row_event->'model') is distinct from 'object'
        or jsonb_typeof(row_data.row_event->'web') is distinct from 'object'
        or exists (select 1 from jsonb_object_keys(row_data.row_event) key where key not in ('type', 'scope', 'model', 'web'))
        or exists (select 1 from jsonb_object_keys(row_data.row_event->'model') key where key not in ('inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens', 'totalTokens', 'requestCount'))
        or exists (select 1 from jsonb_object_keys(row_data.row_event->'web') key where key not in ('searchCount', 'fetchCount', 'responseBytes', 'billedUnits'))
      ) then
        raise exception 'AI chat schema cutover preflight row ai_run_events/%: run usage payload is not closed', row_data.row_identity;
      elsif row_data.row_event->>'type' = 'done' and (
        jsonb_typeof(row_data.row_event->'assistantMessageId') is distinct from 'string'
        or coalesce(btrim(row_data.row_event->>'assistantMessageId'), '') = ''
        or exists (select 1 from jsonb_object_keys(row_data.row_event) key where key not in ('type', 'assistantMessageId'))
      ) then
        raise exception 'AI chat schema cutover preflight row ai_run_events/%: done payload is not closed', row_data.row_identity;
      elsif row_data.row_event->>'type' = 'error' and (
        jsonb_typeof(row_data.row_event->'code') is distinct from 'string'
        or coalesce(btrim(row_data.row_event->>'code'), '') = ''
        or jsonb_typeof(row_data.row_event->'retryable') is distinct from 'boolean'
        or exists (select 1 from jsonb_object_keys(row_data.row_event) key where key not in ('type', 'code', 'retryable'))
      ) then
        raise exception 'AI chat schema cutover preflight row ai_run_events/%: error payload is not closed', row_data.row_identity;
      end if;
    end loop;

  -- Every retained request usage row has one exact public usage event, and no
  -- request usage event may float without its provider ledger row.
  for row_data in
      select usage_rows.id::text as row_identity
      from ai_run_usage usage_rows
      where not exists (
        select 1 from ai_run_events events
        where events.run_id = usage_rows.run_id
          and events.emitted_by_task = usage_rows.task_id
          and events.emission_key = format(
            'usage:request:model:%s:%s:%s:%s', usage_rows.task_id,
            usage_rows.loop_iteration, usage_rows.attempt, usage_rows.provider_request_index)
          and events.event->>'type' = 'usage'
          and events.event->>'scope' = 'request'
          and events.event->>'kind' = 'model'
          and events.event->>'role' = usage_rows.agent_role
          and events.event->>'attempt' = usage_rows.attempt::text
          and events.event->>'inputTokens' = usage_rows.input_tokens::text
          and events.event->>'outputTokens' = usage_rows.output_tokens::text
          and events.event->>'cachedTokens' = usage_rows.cached_tokens::text
          and events.event->>'reasoningTokens' = usage_rows.reasoning_tokens::text
          and events.event->>'totalTokens' = usage_rows.total_tokens::text
      )
      order by usage_rows.id
    loop
      raise exception 'AI chat schema cutover preflight row ai_run_usage/%: request usage event does not match its exact usage row', row_data.row_identity;
    end loop;

  for row_data in
      select events.run_id::text as row_identity
      from ai_run_events events
      where events.event->>'type' = 'usage'
        and events.event->>'scope' = 'request'
        and events.event->>'kind' = 'model'
        and not exists (
          select 1 from ai_run_usage usage_rows
          where usage_rows.run_id = events.run_id
            and usage_rows.task_id = events.emitted_by_task
            and events.emission_key = format(
              'usage:request:model:%s:%s:%s:%s', usage_rows.task_id,
              usage_rows.loop_iteration, usage_rows.attempt, usage_rows.provider_request_index)
            and events.event->>'role' = usage_rows.agent_role
            and events.event->>'attempt' = usage_rows.attempt::text
            and events.event->>'inputTokens' = usage_rows.input_tokens::text
            and events.event->>'outputTokens' = usage_rows.output_tokens::text
            and events.event->>'cachedTokens' = usage_rows.cached_tokens::text
            and events.event->>'reasoningTokens' = usage_rows.reasoning_tokens::text
            and events.event->>'totalTokens' = usage_rows.total_tokens::text
        )
      order by events.id
    loop
      raise exception 'AI chat schema cutover preflight row ai_runs/%: request usage event has no exact provider usage owner', row_data.row_identity;
    end loop;

  for row_data in
      select events.run_id::text as row_identity
      from ai_run_events events
      where events.event->>'type' = 'usage'
        and events.event->>'scope' = 'request'
        and events.event->>'kind' in ('web_search', 'web_fetch')
        and not exists (
          select 1 from ai_external_tool_usage tools
          where tools.run_id = events.run_id
            and events.emitted_by_task = tools.task_id
            and events.event->>'kind' = tools.operation
            and events.event->>'status' = tools.status
            and events.event->>'attempt' = tools.attempt::text
            and events.event->>'resultCount' = tools.result_count::text
            and events.event->>'responseBytes' = tools.response_bytes::text
            and events.event->>'durationMs' = tools.duration_ms::text
            and events.emission_key = format(
              'usage:request:%s:%s:%s:%s:%s', tools.operation, tools.task_id,
              tools.loop_iteration, tools.attempt, tools.tool_request_index)
        )
      order by events.id
    loop
      raise exception 'AI chat schema cutover preflight row ai_runs/%: external request usage event has no exact tool ledger owner', row_data.row_identity;
    end loop;

  -- Bind every terminal event to the route owner, emission key, and selected
  -- answer mode. A valid payload with a foreign owner is still unverifiable.
  for row_data in
      select events.id::text as row_identity,
             events.event as row_event,
             events.emitted_by_task,
             events.emission_key,
             runs.id as run_id,
             plans.payload as plan_payload,
             plans.emitting_task as plan_task
      from ai_run_events events
      join ai_runs runs on runs.id = events.run_id
      left join ai_observations plans on plans.run_id = runs.id and plans.kind = 'turn_plan'
      where runs.finished_at is not null and runs.failed_at is null
        and (
          (events.event->>'type' = 'run_started' and
            (events.emitted_by_task is not null or events.emission_key <> 'run_started'))
          or (events.event->>'type' = 'context_ready' and (
            events.emitted_by_task is distinct from case
              when plans.emitting_task = 'evaluation-general-planner' then 'evaluation-general-planner'
              when plans.payload->>'mode' = 'fanout' then 'fanout-synthesis'
              when plans.payload->>'mode' = 'single' then 'single-answer'
              when plans.payload->>'mode' = 'clarify' then 'clarification-result'
              else null end
            or events.emission_key <> 'context_ready'
            or events.event->>'mode' is distinct from case
              when plans.payload->>'mode' = 'fanout' then 'synthesis'
              when plans.payload->>'mode' = 'single' then 'single'
              when plans.payload->>'mode' = 'clarify' then 'clarification'
              else null end
          ))
          or (events.event->>'type' = 'answer_started' and (
            events.emitted_by_task is distinct from case
              when plans.emitting_task = 'evaluation-general-planner' then 'evaluation-general-planner'
              when plans.payload->>'mode' = 'fanout' then 'fanout-synthesis'
              when plans.payload->>'mode' = 'single' then 'single-answer'
              when plans.payload->>'mode' = 'clarify' then 'clarification-result'
              else null end
            or events.event->>'mode' is distinct from case
              when plans.payload->>'mode' = 'fanout' then 'synthesis'
              when plans.payload->>'mode' = 'single' then 'single'
              when plans.payload->>'mode' = 'clarify' then 'clarification'
              else null end
            or events.emission_key is distinct from format(
              '%s:%s:%s', events.event->>'type',
              case
                when plans.emitting_task = 'evaluation-general-planner' then 'evaluation-general-planner'
                when plans.payload->>'mode' = 'fanout' then 'fanout-synthesis'
                when plans.payload->>'mode' = 'single' then 'single-answer'
                when plans.payload->>'mode' = 'clarify' then 'clarification-result'
                else '' end,
              events.event->>'attempt')
          ))
          or (events.event->>'type' = 'text_delta' and (
            events.emitted_by_task is distinct from case
              when plans.emitting_task = 'evaluation-general-planner' then 'evaluation-general-planner'
              when plans.payload->>'mode' = 'fanout' then 'fanout-synthesis'
              when plans.payload->>'mode' = 'single' then 'single-answer'
              when plans.payload->>'mode' = 'clarify' then 'clarification-result'
              else null end
            or events.emission_key !~ ('^text_delta:' ||
              case
                when plans.emitting_task = 'evaluation-general-planner' then 'evaluation-general-planner'
                when plans.payload->>'mode' = 'fanout' then 'fanout-synthesis'
                when plans.payload->>'mode' = 'single' then 'single-answer'
                when plans.payload->>'mode' = 'clarify' then 'clarification-result'
                else '' end || ':[0-9]+:[0-9]+$')
          ))
          or (events.event->>'type' = 'memory_updated' and (
            events.emitted_by_task is distinct from 'finalize' or events.emission_key <> 'memory_updated'))
          or (events.event->>'type' = 'usage' and events.event->>'scope' = 'run' and (
            events.emitted_by_task is distinct from 'finalize' or events.emission_key <> 'usage:run'))
          or (events.event->>'type' = 'done' and (
            events.emitted_by_task is distinct from 'finalize'
            or events.emission_key <> 'terminal'
            or events.event->>'assistantMessageId' is distinct from runs.assistant_message_id::text))
        )
      order by events.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_run_events/%: terminal event owner, mode, attempt, or emission key is not canonical',
        row_data.row_identity;
    end loop;

  -- Route selection is the first successful-ledger gate. Later projections
  -- must not mask a missing planner or memory finalization route.
  for row_data in
      select runs.id::text as row_identity
      from ai_runs runs
      where runs.finished_at is not null and runs.failed_at is null
        and (
          (select count(*) from ai_observations plans
           where plans.run_id = runs.id and plans.kind = 'turn_plan') <> 1
          or exists (
            select 1 from ai_observations plans
            where plans.run_id = runs.id and plans.kind = 'turn_plan'
              and plans.payload->>'mode' not in ('clarify', 'single', 'fanout')
          )
          or (select count(*) from ai_run_usage usage_rows
              where usage_rows.run_id = runs.id and usage_rows.task_id = 'plan-turn') = 0
          or (select count(*) from ai_run_usage usage_rows
              where usage_rows.run_id = runs.id and usage_rows.task_id = 'memory-extract') = 0
        )
      order by runs.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: successful run has no coherent plan and memory route',
        row_data.row_identity;
    end loop;

  -- A successful route has one exact planner owner.  The expected selector
  -- set below is deliberately mutually exclusive: evaluation plans mount
  -- only the general-planner manifest, while production plans mount the
  -- single or topic A/B/W manifests emitted by plan-turn.
  for row_data in
      select runs.id::text as row_identity, plans.emitting_task
      from ai_runs runs
      join ai_observations plans on plans.run_id = runs.id and plans.kind = 'turn_plan'
      where runs.finished_at is not null and runs.failed_at is null
        and plans.emitting_task not in ('plan-turn', 'evaluation-general-planner')
      order by runs.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: successful turn plan has a foreign owner %',
        row_data.row_identity,
        row_data.emitting_task;
    end loop;

  -- Mount checks run before the rest of the terminal ledger so a missing,
  -- duplicate, foreign, or mis-typed selector cannot be hidden by a later
  -- aggregate failure.
  for row_data in
      with plans as (
        select runs.id, plans.payload, plans.emitting_task
        from ai_runs runs
        join ai_observations plans on plans.run_id = runs.id and plans.kind = 'turn_plan'
        where runs.finished_at is not null and runs.failed_at is null
      ), expected as (
        select plans.id, 'evaluation-general-planner'::text as owner,
               'general_planner'::text as selector_role
        from plans where plans.emitting_task = 'evaluation-general-planner'
        union all
        select plans.id, mounted.owner, mounted.selector_role
        from plans
        cross join lateral (
          select 'single-retrieve-internal'::text as owner, 'internal'::text as selector_role
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'single-select-memories', 'memory'
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'single-retrieve-web', 'web'
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'topic-' || (topic->>'topicId') || '-retrieve-internal', 'internal'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
          union all select 'topic-' || (topic->>'topicId') || '-select-memories', 'memory'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
          union all select 'topic-' || (topic->>'topicId') || '-retrieve-web', 'web'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
        ) mounted
      )
      select runs.id::text as run_id, expected.owner, expected.selector_role,
             count(manifests.id)::int as manifest_count
      from ai_runs runs
      join expected on expected.id = runs.id
       left join ai_observations manifests
         on manifests.run_id = runs.id
       and manifests.kind = 'retrieval_manifest'
       and manifests.emitting_task = expected.owner
       and not exists (
         select 1
         from ai_observations later
         where later.run_id = manifests.run_id
           and later.kind = 'retrieval_manifest'
           and later.emitting_task = manifests.emitting_task
           and (later.loop_iteration > manifests.loop_iteration
             or (later.loop_iteration = manifests.loop_iteration
               and later.attempt > manifests.attempt))
       )
      group by runs.id, expected.owner, expected.selector_role
      having count(manifests.id) <> 1
      order by runs.id, expected.owner
    loop
      if row_data.manifest_count = 0 then
        raise exception
          'AI chat schema cutover preflight row ai_runs/%: successful run is missing terminal retrieval manifest',
          row_data.run_id || '/' || row_data.owner;
      else
        raise exception
          'AI chat schema cutover preflight row ai_runs/%: successful run has duplicate terminal retrieval manifest',
          row_data.run_id || '/' || row_data.owner;
      end if;
    end loop;

  for row_data in
      with plans as (
        select runs.id, plans.payload, plans.emitting_task
        from ai_runs runs
        join ai_observations plans on plans.run_id = runs.id and plans.kind = 'turn_plan'
        where runs.finished_at is not null and runs.failed_at is null
      ), expected as (
        select plans.id, 'evaluation-general-planner'::text as owner,
               'general_planner'::text as selector_role
        from plans where plans.emitting_task = 'evaluation-general-planner'
        union all
        select plans.id, mounted.owner, mounted.selector_role
        from plans
        cross join lateral (
          select 'single-retrieve-internal'::text as owner, 'internal'::text as selector_role
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'single-select-memories', 'memory'
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'single-retrieve-web', 'web'
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'topic-' || (topic->>'topicId') || '-retrieve-internal', 'internal'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
          union all select 'topic-' || (topic->>'topicId') || '-select-memories', 'memory'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
          union all select 'topic-' || (topic->>'topicId') || '-retrieve-web', 'web'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
        ) mounted
      )
      select manifests.run_id::text as run_id, manifests.emitting_task
      from ai_observations manifests
      join ai_runs runs on runs.id = manifests.run_id
      left join (
        select distinct id, owner from expected
      ) expected on expected.id = runs.id and expected.owner = manifests.emitting_task
      where manifests.kind = 'retrieval_manifest'
        and runs.finished_at is not null and runs.failed_at is null
        and expected.owner is null
      order by manifests.run_id, manifests.emitting_task, manifests.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: retrieval manifest owner is outside selected route',
        row_data.run_id || '/' || row_data.emitting_task;
    end loop;

  -- Check selector roles against the exact mounted owner before the broad
  -- source and usage reconciliation below.
  for row_data in
      with plans as (
        select runs.id, plans.payload, plans.emitting_task
        from ai_runs runs
        join ai_observations plans on plans.run_id = runs.id and plans.kind = 'turn_plan'
        where runs.finished_at is not null and runs.failed_at is null
      ), expected as (
        select plans.id, 'evaluation-general-planner'::text as owner,
               'general_planner'::text as selector_role
        from plans where plans.emitting_task = 'evaluation-general-planner'
        union all
        select plans.id, mounted.owner, mounted.selector_role
        from plans
        cross join lateral (
          select 'single-retrieve-internal'::text as owner, 'internal'::text as selector_role
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'single-select-memories', 'memory'
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'single-retrieve-web', 'web'
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'topic-' || (topic->>'topicId') || '-retrieve-internal', 'internal'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
          union all select 'topic-' || (topic->>'topicId') || '-select-memories', 'memory'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
          union all select 'topic-' || (topic->>'topicId') || '-retrieve-web', 'web'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
        ) mounted
      )
      select manifests.run_id::text as run_id, manifests.emitting_task
      from ai_observations manifests
      join expected on expected.id = manifests.run_id and expected.owner = manifests.emitting_task
      where manifests.kind = 'retrieval_manifest'
        and manifests.payload->>'selectorRole' is distinct from expected.selector_role
      order by manifests.run_id, manifests.emitting_task, manifests.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: retrieval manifest selector role does not match its owner',
        row_data.run_id || '/' || row_data.emitting_task;
    end loop;

  -- A mounted manifest is terminal evidence, not only a shape-valid selector
  -- result. Called selectors must point at their latest provider measurement
  -- and matching usage row. Explicit no-call manifests must have exactly one
  -- finalization-owned seal and no provider or web-tool ledger at all.
  for row_data in
      with plans as (
        select runs.id, plans.payload, plans.emitting_task
        from ai_runs runs
        join ai_observations plans on plans.run_id = runs.id and plans.kind = 'turn_plan'
        where runs.finished_at is not null and runs.failed_at is null
      ), expected as (
        select plans.id, 'evaluation-general-planner'::text as owner
        from plans where plans.emitting_task = 'evaluation-general-planner'
        union all
        select plans.id, mounted.owner
        from plans
        cross join lateral (
          select 'single-retrieve-internal'::text as owner
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'single-select-memories'
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'single-retrieve-web'
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'topic-' || (topic->>'topicId') || '-retrieve-internal'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
          union all select 'topic-' || (topic->>'topicId') || '-select-memories'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
          union all select 'topic-' || (topic->>'topicId') || '-retrieve-web'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
        ) mounted
      ), mounted as (
        select expected.id, expected.owner,
               manifests.id as manifest_id, manifests.loop_iteration,
               manifests.attempt, manifests.observation_key,
               manifests.payload,
               count(manifests.id) over (partition by expected.id, expected.owner) as manifest_count
        from expected
        left join ai_observations manifests
          on manifests.run_id = expected.id
         and manifests.kind = 'retrieval_manifest'
         and manifests.emitting_task = expected.owner
         and not exists (
           select 1
           from ai_observations later
           where later.run_id = manifests.run_id
             and later.kind = 'retrieval_manifest'
             and later.emitting_task = manifests.emitting_task
             and (later.loop_iteration > manifests.loop_iteration
               or (later.loop_iteration = manifests.loop_iteration
                 and later.attempt > manifests.attempt))
         )
      )
      select mounted.id::text as run_id, mounted.owner,
             mounted.manifest_count, mounted.manifest_id,
             mounted.loop_iteration, mounted.attempt,
             mounted.observation_key, mounted.payload
      from mounted
      where mounted.manifest_count <> 1
         or (
           mounted.manifest_id is not null
           and mounted.payload ? 'noCallReason'
           and (
             (select count(*)
              from ai_observations seals
              where seals.run_id = mounted.id
                and seals.kind = 'retrieval_no_call_seal'
                and seals.emitting_task = 'finalize'
                and seals.payload->>'selectorTaskId' = mounted.owner
                and seals.payload->>'selectorLoopIteration' = mounted.loop_iteration::text
                and seals.payload->>'selectorAttempt' = mounted.attempt::text
                and seals.payload->>'selectorObservationKey' = mounted.observation_key
                and seals.payload->>'noCallReason' = mounted.payload->>'noCallReason') <> 1
             or exists (
               select 1 from ai_run_usage usage_rows
               where usage_rows.run_id = mounted.id and usage_rows.task_id = mounted.owner
             )
             or exists (
               select 1 from ai_external_tool_usage tools
               where tools.run_id = mounted.id and tools.task_id = mounted.owner
             )
             or exists (
               select 1 from ai_observations measurements
               where measurements.run_id = mounted.id
                 and measurements.kind = 'provider_request_measurement'
                 and measurements.emitting_task = mounted.owner
             )
           )
         )
      order by mounted.id, mounted.owner
    loop
      if row_data.manifest_count = 0 then
        raise exception
          'AI chat schema cutover preflight row ai_runs/%: successful run is missing terminal retrieval manifest',
          row_data.run_id || '/' || row_data.owner;
      elsif row_data.manifest_count <> 1 then
        raise exception
          'AI chat schema cutover preflight row ai_runs/%: successful run has duplicate terminal retrieval manifest',
          row_data.run_id || '/' || row_data.owner;
      else
        raise exception
          'AI chat schema cutover preflight row ai_runs/%: terminal no-call retrieval manifest lacks its exact finalization seal or has provider/tool usage',
          row_data.run_id || '/' || row_data.owner;
      end if;
    end loop;

  for row_data in
      with plans as (
        select runs.id, plans.payload, plans.emitting_task
        from ai_runs runs
        join ai_observations plans on plans.run_id = runs.id and plans.kind = 'turn_plan'
        where runs.finished_at is not null and runs.failed_at is null
      ), expected as (
        select plans.id, 'evaluation-general-planner'::text as owner
        from plans where plans.emitting_task = 'evaluation-general-planner'
        union all
        select plans.id, mounted.owner
        from plans
        cross join lateral (
          select 'single-retrieve-internal'::text as owner
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'single-select-memories'
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'single-retrieve-web'
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'topic-' || (topic->>'topicId') || '-retrieve-internal'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
          union all select 'topic-' || (topic->>'topicId') || '-select-memories'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
          union all select 'topic-' || (topic->>'topicId') || '-retrieve-web'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
        ) mounted
      )
      select manifests.run_id::text as run_id, manifests.emitting_task
      from ai_observations manifests
      join expected on expected.id = manifests.run_id and expected.owner = manifests.emitting_task
      where manifests.kind = 'retrieval_manifest'
        and not (manifests.payload ? 'noCallReason')
        and not exists (
          select 1
          from ai_observations later
          where later.run_id = manifests.run_id
            and later.kind = 'retrieval_manifest'
            and later.emitting_task = manifests.emitting_task
            and (later.loop_iteration > manifests.loop_iteration
              or (later.loop_iteration = manifests.loop_iteration
                and later.attempt > manifests.attempt))
        )
        and (
          (select count(*)
           from ai_observations measurements
           where measurements.run_id = manifests.run_id
             and measurements.kind = 'provider_request_measurement'
             and measurements.emitting_task = manifests.emitting_task
             and measurements.loop_iteration = manifests.loop_iteration
             and measurements.attempt = manifests.attempt
             and not exists (
               select 1 from ai_observations later
               where later.run_id = measurements.run_id
                 and later.kind = 'provider_request_measurement'
                 and later.emitting_task = measurements.emitting_task
                 and (
                   later.loop_iteration > measurements.loop_iteration
                   or (later.loop_iteration = measurements.loop_iteration
                     and later.attempt > measurements.attempt)
                   or (later.loop_iteration = measurements.loop_iteration
                     and later.attempt = measurements.attempt
                     and (later.payload->>'providerRequestIndex')::numeric >
                       (measurements.payload->>'providerRequestIndex')::numeric)
                 )
             )) <> 1
          or not exists (
            select 1
            from ai_observations measurements
            join ai_run_usage usage_rows
              on usage_rows.run_id = measurements.run_id
             and usage_rows.task_id = measurements.emitting_task
             and usage_rows.loop_iteration = measurements.loop_iteration
             and usage_rows.attempt = measurements.attempt
             and usage_rows.provider_request_index = (measurements.payload->>'providerRequestIndex')::integer
             and usage_rows.agent_role = measurements.payload->>'agentRole'
             and usage_rows.model_id = measurements.payload->>'modelId'
             and (measurements.payload->>'inputTokens')::numeric =
               (usage_rows.input_tokens + usage_rows.cached_tokens)::numeric
             and (measurements.payload->>'requestedOutputTokens')::numeric >=
               usage_rows.output_tokens::numeric
             and measurements.payload->>'passed' = 'true'
            where measurements.run_id = manifests.run_id
              and measurements.kind = 'provider_request_measurement'
              and measurements.emitting_task = manifests.emitting_task
              and measurements.loop_iteration = manifests.loop_iteration
              and measurements.attempt = manifests.attempt
              and not exists (
                select 1 from ai_observations later
                where later.run_id = measurements.run_id
                  and later.kind = 'provider_request_measurement'
                  and later.emitting_task = measurements.emitting_task
                  and (
                    later.loop_iteration > measurements.loop_iteration
                    or (later.loop_iteration = measurements.loop_iteration
                      and later.attempt > measurements.attempt)
                    or (later.loop_iteration = measurements.loop_iteration
                      and later.attempt = measurements.attempt
                      and (later.payload->>'providerRequestIndex')::numeric >
                        (measurements.payload->>'providerRequestIndex')::numeric)
                  )
              )
          )
          or exists (
            select 1
            from ai_observations seals
            where seals.run_id = manifests.run_id
              and seals.kind = 'retrieval_no_call_seal'
              and seals.payload->>'selectorTaskId' = manifests.emitting_task
          )
        )
      order by manifests.run_id, manifests.emitting_task, manifests.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: terminal retrieval manifest lacks its latest provider measurement and usage proof',
        row_data.run_id || '/' || row_data.emitting_task;
    end loop;

  -- Every selected reference must have been shown by the exact terminal
  -- selector request that emitted the manifest. An answer-stage exposure at
  -- the same loop/attempt cannot stand in for the selector's own proof.
  for row_data in
      select manifests.id::text || '/' || refs.ordinality::text as row_identity
      from ai_observations manifests
      join ai_runs runs on runs.id = manifests.run_id
      cross join lateral jsonb_array_elements(manifests.payload->'references')
        with ordinality refs(value, ordinality)
      where runs.finished_at is not null
        and runs.failed_at is null
        and manifests.kind = 'retrieval_manifest'
        and manifests.payload->>'selectorRole' in ('internal', 'memory', 'web')
        and not (manifests.payload ? 'noCallReason')
        and not exists (
          select 1
          from ai_observations later
          where later.run_id = manifests.run_id
            and later.kind = 'retrieval_manifest'
            and later.emitting_task = manifests.emitting_task
            and (
              later.loop_iteration > manifests.loop_iteration
              or (
                later.loop_iteration = manifests.loop_iteration
                and later.attempt > manifests.attempt
              )
            )
        )
        and not exists (
          select 1
          from ai_source_exposures exposures
          join ai_observations measurements
            on measurements.run_id = exposures.run_id
           and measurements.emitting_task = exposures.task_id
           and measurements.loop_iteration = exposures.loop_iteration
           and measurements.attempt = exposures.attempt
           and measurements.kind = 'provider_request_measurement'
           and measurements.payload->>'providerRequestIndex' =
             exposures.provider_request_index::text
           and measurements.payload->>'passed' = 'true'
          join ai_run_usage usage_rows
            on usage_rows.run_id = measurements.run_id
           and usage_rows.task_id = measurements.emitting_task
           and usage_rows.loop_iteration = measurements.loop_iteration
           and usage_rows.attempt = measurements.attempt
           and usage_rows.provider_request_index =
             exposures.provider_request_index
           and usage_rows.agent_role = measurements.payload->>'agentRole'
           and usage_rows.model_id = measurements.payload->>'modelId'
           and (measurements.payload->>'inputTokens')::numeric =
             (usage_rows.input_tokens + usage_rows.cached_tokens)::numeric
           and (measurements.payload->>'requestedOutputTokens')::numeric >=
             usage_rows.output_tokens::numeric
          where exposures.run_id = manifests.run_id
            and exposures.task_id = manifests.emitting_task
            and exposures.loop_iteration = manifests.loop_iteration
            and exposures.attempt = manifests.attempt
            and not exists (
              select 1
              from ai_observations later_measurements
              where later_measurements.run_id = measurements.run_id
                and later_measurements.kind = 'provider_request_measurement'
                and later_measurements.emitting_task = measurements.emitting_task
                and (
                  later_measurements.loop_iteration > measurements.loop_iteration
                  or (
                    later_measurements.loop_iteration = measurements.loop_iteration
                    and later_measurements.attempt > measurements.attempt
                  )
                  or (
                    later_measurements.loop_iteration = measurements.loop_iteration
                    and later_measurements.attempt = measurements.attempt
                    and later_measurements.payload->>'providerRequestIndex' ~ '^[0-9]+$'
                    and measurements.payload->>'providerRequestIndex' ~ '^[0-9]+$'
                    and (later_measurements.payload->>'providerRequestIndex')::numeric >
                      (measurements.payload->>'providerRequestIndex')::numeric
                  )
                )
            )
            and (
              (
                manifests.payload->>'selectorRole' = 'memory'
                and exposures.source_kind = 'memory'
                and exposures.exposure_stage = 'memory_tool_result'
                and exposures.logical_source_identity =
                  'memory:' || (refs.value->>'memoryId')
                and exposures.content_item_identity =
                  refs.value->>'memoryRevisionId'
              )
              or (
                manifests.payload->>'selectorRole' = 'web'
                and exposures.source_kind = 'web'
                and exposures.exposure_stage = 'web_fetch'
                and exposures.logical_source_identity =
                  refs.value->>'url'
                and left(exposures.content_item_identity, length(refs.value->>'url') + 1) =
                  (refs.value->>'url') || ':'
                and length(exposures.content_item_identity) = length(refs.value->>'url') + 44
                and substring(exposures.content_item_identity from length(refs.value->>'url') + 2) ~ '^[A-Za-z0-9_-]{43}$'
              )
              or (
                manifests.payload->>'selectorRole' = 'internal'
                and (
                  (
                    refs.value->>'kind' = 'chat_message'
                    and exposures.source_kind = 'chat_message'
                    and exposures.exposure_stage in (
                      'internal_search_preview', 'internal_inspection'
                    )
                    and exposures.logical_source_identity =
                      'chat_message:' || (refs.value->>'messageId')
                    and exposures.content_item_identity =
                      refs.value->>'messageId'
                  )
                  or (
                    refs.value->>'kind' = 'document'
                    and exposures.source_kind = 'document'
                    and exposures.exposure_stage in (
                      'internal_search_preview', 'internal_inspection'
                    )
                    and exposures.document_source_id =
                      refs.value->'source'->>'sourceId'
                    and exposures.document_id = refs.value->>'documentId'
                    and coalesce(
                      to_jsonb(exposures)->>'document_version_id',
                      to_jsonb(exposures)->>'version_id'
                    ) = refs.value->>'versionId'
                    and (
                      (
                        refs.value ? 'ranges'
                        and exposures.document_ranges is not distinct from refs.value->'ranges'
                      )
                      or (
                        not (refs.value ? 'ranges')
                        and exposures.document_ranges is not distinct from jsonb_build_array(
                          jsonb_build_object(
                            'charStart', 0,
                            'charEnd', coalesce(
                              (
                                select char_length(public_documents.text) + (
                                  select count(*)
                                  from generate_series(1, char_length(public_documents.text)) positions(position)
                                  where octet_length(convert_to(substr(public_documents.text, positions.position, 1), 'UTF8')) = 4
                                )
                                from public_source_documents public_documents
                                where public_documents.source_id::text = substring(refs.value->'source'->>'sourceId' from 8)
                                  and public_documents.document_id = refs.value->>'documentId'
                                  and public_documents.document_id = refs.value->>'versionId'
                              ),
                              (
                                select char_length(publisher_versions.canonical_text) + (
                                  select count(*)
                                  from generate_series(1, char_length(publisher_versions.canonical_text)) positions(position)
                                  where octet_length(convert_to(substr(publisher_versions.canonical_text, positions.position, 1), 'UTF8')) = 4
                                )
                                from brief_document_versions publisher_versions
                                where publisher_versions.id::text = refs.value->>'versionId'
                                  and publisher_versions.brief_document_id::text = refs.value->>'documentId'
                              )
                            )
                          )
                        )
                      )
                    )
                    and exposures.content_item_identity =
                      exposures.logical_source_identity || ':' ||
                      (refs.value->>'versionId') || ':' ||
                      translate(
                        rtrim(
                          encode(
                            digest(
                              convert_to(
                                '[' || (
                                  select string_agg(
                                    format(
                                      '{"charStart":%s,"charEnd":%s}',
                                      range_row.value->>'charStart',
                                      range_row.value->>'charEnd'
                                    ),
                                    ',' order by range_row.ordinality
                                  )
                                  from jsonb_array_elements(exposures.document_ranges)
                                    with ordinality range_row(value, ordinality)
                                ) || ']',
                                'UTF8'
                              ),
                              'sha256'
                            ),
                            'base64'
                          ),
                          '='
                        ),
                        '+/',
                        '-_'
                      )
                    and (
                      (
                        refs.value->'source'->>'kind' = 'public'
                        and exposures.publisher_issue_id is null
                        and exposures.publisher_document_id is null
                        and not (refs.value ? 'publisherExtractionId')
                      )
                      or (
                        refs.value->'source'->>'kind' = 'publisher'
                        and exposures.publisher_issue_id =
                          refs.value->'source'->>'issueId'
                        and exposures.publisher_document_id =
                          refs.value->'source'->>'documentId'
                        and refs.value->'source'->>'documentId' =
                          refs.value->>'documentId'
                        and exists (
                          select 1
                          from brief_document_versions selected_versions
                          join brief_documents selected_documents
                            on selected_documents.id =
                              selected_versions.brief_document_id
                          join publisher_issues selected_issues
                            on selected_issues.id = selected_documents.issue_id
                          join publisher_subscriptions selected_subscriptions
                            on selected_subscriptions.id =
                              selected_issues.subscription_id
                          join brief_document_extractions selected_extractions
                            on selected_extractions.brief_document_id =
                              selected_documents.id
                           and selected_extractions.input_sha256_hex =
                              selected_documents.sha256_hex
                          where selected_versions.id::text =
                              refs.value->>'versionId'
                            and selected_documents.id::text =
                              refs.value->>'documentId'
                            and selected_issues.id::text =
                              refs.value->'source'->>'issueId'
                            and selected_subscriptions.id::text =
                              substring(refs.value->'source'->>'sourceId' from 11)
                            and selected_extractions.id::text =
                              refs.value->>'publisherExtractionId'
                        )
                      )
                    )
                  )
                )
              )
            )
            and exists (
              select 1
              from ai_observations attestations
              where attestations.run_id = exposures.run_id
                and attestations.emitting_task = manifests.emitting_task
                and attestations.loop_iteration = manifests.loop_iteration
                and attestations.attempt = manifests.attempt
                and attestations.kind = 'source_exposure_attestation'
                and attestations.payload->>'providerRequestIndex' =
                  exposures.provider_request_index::text
                and attestations.payload->>'providerRequestSha256Hex' =
                  measurements.payload->>'requestSha256Hex'
                and attestations.payload->>'sourceKind' = exposures.source_kind
                and attestations.payload->>'logicalSourceIdentity' =
                  exposures.logical_source_identity
                and attestations.payload->>'contentItemIdentity' =
                  exposures.content_item_identity
                and attestations.payload->>'exposureStage' =
                  exposures.exposure_stage
                and attestations.payload->>'visibleTokenCount' =
                  exposures.visible_token_count::text
                and measurements.payload->'sourceExposureProofSha256Hexes' @>
                  jsonb_build_array(
                    attestations.payload->>'providerSerializationProofSha256Hex'
                  )
                and exists (
                  select 1
                  from jsonb_array_elements(
                    measurements.payload->'sourceExposureProofBindings'
                  ) proof_binding(value)
                  where proof_binding.value->>'providerSerializationProofSha256Hex' =
                      attestations.payload->>'providerSerializationProofSha256Hex'
                    and proof_binding.value->'providerSerializationProofBinding'
                      is not distinct from
                        attestations.payload->'providerSerializationProofBinding'
                )
            )
        )
      order by manifests.id, refs.ordinality
    loop
      raise exception
        'AI chat schema cutover preflight row ai_observations/%: terminal selector reference lacks its exact selector-owned exposure and provider proof coordinate',
        row_data.row_identity;
    end loop;

  -- A fanout success is not complete when only synthesis remains. Every topic
  -- selected by plan-turn owns one terminal packet, context ledger, provider
  -- request/usage pair, and topic consumer in the aggregate context event.
  for row_data in
      with expected as (
        select plans.run_id as id,
               topic.value->>'topicId' as topic_id,
               'topic-' || (topic.value->>'topicId') || '-answer' as owner
        from ai_observations plans
        cross join lateral jsonb_array_elements(plans.payload->'topics') topic(value)
        where plans.kind = 'turn_plan'
          and plans.emitting_task = 'plan-turn'
          and plans.payload->>'mode' = 'fanout'
      )
      select expected.id::text as run_id, expected.owner,
             case
               when (select count(*) from ai_observations packets
                     where packets.run_id = expected.id
                       and packets.kind = 'topic_packet'
                       and packets.emitting_task = expected.owner) <> 1
                 or (select count(*) from ai_observations packets
                     where packets.run_id = expected.id
                       and packets.kind = 'topic_packet'
                       and packets.emitting_task = expected.owner
                       and packets.payload->>'topicId' = expected.topic_id) <> 1
                 then 'fanout topic packet ledger is incomplete'
               when not exists (
                 select 1
                 from ai_observations packets
                 join ai_observations measurements
                   on measurements.run_id = packets.run_id
                  and measurements.kind = 'provider_request_measurement'
                  and measurements.emitting_task = packets.emitting_task
                  and measurements.loop_iteration = packets.loop_iteration
                  and measurements.attempt = packets.attempt
                 join ai_run_usage usage_rows
                   on usage_rows.run_id = measurements.run_id
                  and usage_rows.task_id = measurements.emitting_task
                  and usage_rows.loop_iteration = measurements.loop_iteration
                  and usage_rows.attempt = measurements.attempt
                  and usage_rows.provider_request_index::text = measurements.payload->>'providerRequestIndex'
                 where packets.run_id = expected.id
                   and packets.kind = 'topic_packet'
                   and packets.emitting_task = expected.owner
                   and packets.payload->>'topicId' = expected.topic_id
               ) then 'fanout topic packet has no matching provider coordinate'
               when not exists (
                 select 1 from ai_observations measurements
                 where measurements.run_id = expected.id
                   and measurements.kind = 'context_measurement'
                   and measurements.emitting_task = expected.owner
               ) then 'fanout topic context measurement is missing'
               when not exists (
                 select 1 from ai_observations serialized
                 where serialized.run_id = expected.id
                   and serialized.kind = 'context_serialized'
                   and serialized.emitting_task = expected.owner
                   and serialized.payload->>'consumerTaskId' = expected.owner
               ) then 'fanout topic context serialization is missing'
               when not exists (
                 select 1 from ai_observations measurements
                 join ai_run_usage usage_rows
                   on usage_rows.run_id = measurements.run_id
                  and usage_rows.task_id = measurements.emitting_task
                  and usage_rows.loop_iteration = measurements.loop_iteration
                  and usage_rows.attempt = measurements.attempt
                  and usage_rows.provider_request_index::text = measurements.payload->>'providerRequestIndex'
                 where measurements.run_id = expected.id
                   and measurements.kind = 'provider_request_measurement'
                   and measurements.emitting_task = expected.owner
               ) then 'fanout topic provider request has no usage row'
               when not exists (
                 select 1 from ai_run_usage usage_rows
                 where usage_rows.run_id = expected.id
                   and usage_rows.task_id = expected.owner
               ) then 'fanout topic provider usage is missing'
               when (select count(*) from ai_run_events contexts
                     cross join lateral jsonb_array_elements(contexts.event->'consumers') consumer
                     where contexts.run_id = expected.id
                       and contexts.event->>'type' = 'context_ready'
                       and consumer->>'consumer' = 'topic'
                       and consumer->>'topicId' = expected.topic_id) <> 1
                 then 'fanout topic context consumer is incomplete'
               else null
             end as reason
      from expected
      join ai_runs runs on runs.id = expected.id
      where runs.finished_at is not null
        and runs.failed_at is null
        and (
          (select count(*) from ai_observations packets
           where packets.run_id = expected.id
             and packets.kind = 'topic_packet'
             and packets.emitting_task = expected.owner) <> 1
          or (select count(*) from ai_observations packets
           where packets.run_id = expected.id
             and packets.kind = 'topic_packet'
             and packets.emitting_task = expected.owner
             and packets.payload->>'topicId' = expected.topic_id) <> 1
          or not exists (
             select 1
             from ai_observations packets
             join ai_observations measurements
               on measurements.run_id = packets.run_id
              and measurements.kind = 'provider_request_measurement'
              and measurements.emitting_task = packets.emitting_task
              and measurements.loop_iteration = packets.loop_iteration
              and measurements.attempt = packets.attempt
             join ai_run_usage usage_rows
               on usage_rows.run_id = measurements.run_id
              and usage_rows.task_id = measurements.emitting_task
              and usage_rows.loop_iteration = measurements.loop_iteration
              and usage_rows.attempt = measurements.attempt
              and usage_rows.provider_request_index::text = measurements.payload->>'providerRequestIndex'
             where packets.run_id = expected.id
               and packets.kind = 'topic_packet'
               and packets.emitting_task = expected.owner
               and packets.payload->>'topicId' = expected.topic_id
          )
          or not exists (select 1 from ai_observations measurements
                         where measurements.run_id = expected.id
                           and measurements.kind = 'context_measurement'
                           and measurements.emitting_task = expected.owner)
          or not exists (select 1 from ai_observations serialized
                         where serialized.run_id = expected.id
                           and serialized.kind = 'context_serialized'
                           and serialized.emitting_task = expected.owner
                           and serialized.payload->>'consumerTaskId' = expected.owner)
          or not exists (select 1
                         from ai_observations measurements
                         join ai_run_usage usage_rows
                           on usage_rows.run_id = measurements.run_id
                          and usage_rows.task_id = measurements.emitting_task
                          and usage_rows.loop_iteration = measurements.loop_iteration
                          and usage_rows.attempt = measurements.attempt
                          and usage_rows.provider_request_index::text = measurements.payload->>'providerRequestIndex'
                         where measurements.run_id = expected.id
                           and measurements.kind = 'provider_request_measurement'
                           and measurements.emitting_task = expected.owner)
          or not exists (select 1 from ai_run_usage usage_rows
                         where usage_rows.run_id = expected.id
                           and usage_rows.task_id = expected.owner)
          or (select count(*) from ai_run_events contexts
              cross join lateral jsonb_array_elements(contexts.event->'consumers') consumer
              where contexts.run_id = expected.id
                and contexts.event->>'type' = 'context_ready'
                and consumer->>'consumer' = 'topic'
                and consumer->>'topicId' = expected.topic_id) <> 1
        )
      order by expected.id, expected.topic_id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: %',
        row_data.run_id || '/' || row_data.owner,
        row_data.reason;
    end loop;

  -- Answer attempts and streamed deltas form one ordered terminal ledger.
  -- Bind every delta to the sole successful attempt and require contiguous
  -- zero-based indices before accepting the persisted assistant text.
  for row_data in
      select runs.id::text as row_identity
      from ai_runs runs
      join ai_observations plans on plans.run_id = runs.id and plans.kind = 'turn_plan'
      where runs.finished_at is not null and runs.failed_at is null
        and plans.payload->>'mode' in ('single', 'fanout')
        and (
          (select count(*) from ai_run_events events
           where events.run_id = runs.id and events.event->>'type' = 'answer_started') < 1
          or (select count(*) from ai_observations completions
              where completions.run_id = runs.id and completions.kind = 'answer_completed') <> 1
          or exists (
            select 1
            from ai_observations completions
            where completions.run_id = runs.id
              and completions.kind = 'answer_completed'
              and (
                completions.emitting_task is distinct from case
                  when plans.payload->>'mode' = 'fanout' then 'fanout-synthesis'
                  else 'single-answer' end
                or completions.loop_iteration <> 0
                or completions.attempt::text is distinct from completions.payload->>'attempt'
                or completions.payload->>'mode' is distinct from case
                  when plans.payload->>'mode' = 'fanout' then 'synthesis'
                  else 'single' end
                or not exists (
                  select 1
                  from ai_run_events starts
                  where starts.run_id = runs.id
                    and starts.event->>'type' = 'answer_started'
                    and starts.emitted_by_task = completions.emitting_task
                    and starts.event->>'mode' = completions.payload->>'mode'
                    and starts.event->>'attempt' = completions.payload->>'attempt'
                )
              )
          )
          or exists (
            select 1
            from ai_run_events starts
            where starts.run_id = runs.id and starts.event->>'type' = 'answer_started'
              and (
                starts.event->>'mode' is distinct from case when plans.payload->>'mode' = 'fanout' then 'synthesis' else 'single' end
                or starts.event->>'attempt' !~ '^[0-9]+$'
                or exists (
                  select 1 from ai_run_events prior
                  where prior.run_id = starts.run_id and prior.event->>'type' = 'answer_started'
                    and prior.seq < starts.seq
                    and (prior.event->>'attempt')::numeric >= (starts.event->>'attempt')::numeric
                )
              )
          )
          or not exists (
            select 1
            from ai_run_events latest_start
            where latest_start.run_id = runs.id
              and latest_start.event->>'type' = 'answer_started'
              and not exists (
                select 1 from ai_run_events later_start
                where later_start.run_id = latest_start.run_id
                  and later_start.event->>'type' = 'answer_started'
                  and later_start.seq > latest_start.seq
              )
              and exists (
                select 1 from ai_observations completions
                where completions.run_id = runs.id
                  and completions.kind = 'answer_completed'
                  and completions.emitting_task = latest_start.emitted_by_task
                  and completions.loop_iteration = 0
                  and completions.attempt::text = latest_start.event->>'attempt'
                  and completions.payload->>'attempt' = latest_start.event->>'attempt'
              )
          )
          or exists (
            select 1
            from ai_run_events deltas
            where deltas.run_id = runs.id
              and deltas.event->>'type' = 'text_delta'
              and (
                deltas.emission_key !~ '^text_delta:[^:]+:[0-9]+:[0-9]+$'
                or not exists (
                  select 1 from ai_run_events starts
                  where starts.run_id = deltas.run_id and starts.event->>'type' = 'answer_started'
                    and starts.event->>'attempt' = substring(deltas.emission_key from '[^:]+:([0-9]+):[0-9]+$')
                    and starts.seq < deltas.seq
                    and not exists (
                      select 1 from ai_run_events next_start
                      where next_start.run_id = starts.run_id and next_start.event->>'type' = 'answer_started'
                        and next_start.seq > starts.seq and next_start.seq <= deltas.seq
                    )
                )
              )
          )
          or exists (
            select 1
            from ai_run_events deltas
            where deltas.run_id = runs.id and deltas.event->>'type' = 'text_delta'
              and substring(deltas.emission_key from ':([0-9]+)$')::numeric <> (
                select count(*) from ai_run_events prior
                where prior.run_id = runs.id and prior.event->>'type' = 'text_delta'
                  and substring(prior.emission_key from '[^:]+:([0-9]+):[0-9]+$') = substring(deltas.emission_key from '[^:]+:([0-9]+):[0-9]+$')
                  and prior.seq < deltas.seq
              )
          )
        )
      order by runs.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: successful answer event ledger is incomplete',
        row_data.row_identity;
    end loop;

  -- Successful terminal order is fixed. Request events may interleave, but
  -- the public lifecycle and finalization events cannot move or repeat.
  for row_data in
      select request_events.id::text as row_identity
      from ai_run_events request_events
      join ai_runs runs on runs.id = request_events.run_id
      where (
          (runs.finished_at is not null and runs.failed_at is null)
          or (runs.failed_at is not null and runs.finished_at is null)
        )
        and request_events.event->>'type' = 'usage'
        and request_events.event->>'scope' = 'request'
        and (
          not exists (
            select 1
            from ai_run_events started
            where started.run_id = request_events.run_id
              and started.event->>'type' = 'run_started'
              and started.seq < request_events.seq
          )
          or not exists (
            select 1
            from ai_run_events aggregate
            where aggregate.run_id = request_events.run_id
              and aggregate.event->>'type' = 'usage'
              and aggregate.event->>'scope' = 'run'
              and request_events.seq < aggregate.seq
          )
        )
      order by request_events.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_run_events/%: terminal request usage is not ordered after run_started and before usage:run',
        row_data.row_identity;
    end loop;

  for row_data in
      select runs.id::text as row_identity
      from ai_runs runs
      where runs.finished_at is not null and runs.failed_at is null
        and exists (
          select 1 from ai_run_usage route_usage
          where route_usage.run_id = runs.id and route_usage.task_id = 'plan-turn'
        )
        and exists (
          select 1 from ai_run_usage route_usage
          where route_usage.run_id = runs.id and route_usage.task_id = 'memory-extract'
        )
        and (
          (select count(*) from ai_run_events where run_id = runs.id and event->>'type' = 'run_started') <> 1
          or (select count(*) from ai_run_events where run_id = runs.id and event->>'type' = 'context_ready') <> 1
          or (select count(*) from ai_run_events where run_id = runs.id and event->>'type' = 'answer_started') < 1
          or (select count(*) from ai_run_events where run_id = runs.id and event->>'type' = 'memory_updated') <> 1
          or (select count(*) from ai_run_events where run_id = runs.id and event->>'type' = 'usage' and event->>'scope' = 'run') <> 1
          or (select count(*) from ai_run_events where run_id = runs.id and event->>'type' = 'done') <> 1
          or exists (select 1 from ai_run_events where run_id = runs.id and event->>'type' = 'error')
          or not exists (
            select 1 from ai_run_events started join ai_run_events context_ready
              on context_ready.run_id = started.run_id and context_ready.event->>'type' = 'context_ready'
            join ai_run_events answer_started
              on answer_started.run_id = started.run_id and answer_started.event->>'type' = 'answer_started'
            join ai_run_events memory_updated
              on memory_updated.run_id = started.run_id and memory_updated.event->>'type' = 'memory_updated'
            join ai_run_events run_usage
              on run_usage.run_id = started.run_id and run_usage.event->>'type' = 'usage' and run_usage.event->>'scope' = 'run'
            join ai_run_events done
              on done.run_id = started.run_id and done.event->>'type' = 'done'
            where started.run_id = runs.id and started.event->>'type' = 'run_started'
              and started.seq < context_ready.seq and context_ready.seq < answer_started.seq
              and answer_started.seq < memory_updated.seq
              and memory_updated.seq < run_usage.seq and run_usage.seq < done.seq
          )
        )
      order by runs.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: successful terminal event order or cardinality is incomplete',
        row_data.row_identity;
    end loop;

  for row_data in
      select runs.id::text as row_identity
      from ai_runs runs
      where runs.failed_at is not null
        and (
          runs.assistant_message_id is not null
          or exists (
            select 1
            from chat_messages assistants
            where assistants.assistant_ai_run_id = runs.id
              and assistants.author = 'assistant'
          )
          or exists (
            select 1
            from chat_messages assistants
            join assistant_message_sources sources
              on sources.assistant_message_id = assistants.id
            where assistants.assistant_ai_run_id = runs.id
               or assistants.id = runs.assistant_message_id
          )
        )
      order by runs.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: failed run retains an assistant message or source row',
        row_data.row_identity;
    end loop;

  -- Failed runs retain a public lifecycle too. A controlled failure ends in
  -- finalize after memory_updated; a fatal task failure ends in the
  -- failure-handler without that event. Both paths require one exact run
  -- aggregate and one terminal error, and neither may retain done.
  for row_data in
      select runs.id::text as row_identity
      from ai_runs runs
      where runs.failed_at is not null
        and runs.finished_at is null
        and (
          (select count(*) from ai_run_events events
           where events.run_id = runs.id and events.event->>'type' = 'run_started') <> 1
          or (select count(*) from ai_run_events events
              where events.run_id = runs.id and events.event->>'type' = 'usage'
                and events.event->>'scope' = 'run') <> 1
          or (select count(*) from ai_run_events events
              where events.run_id = runs.id and events.event->>'type' = 'error') <> 1
          or exists (
            select 1 from ai_run_events events
            where events.run_id = runs.id and events.event->>'type' = 'done'
          )
          or (
            not exists (
              select 1 from ai_run_events memory_events
              where memory_events.run_id = runs.id
                and memory_events.event->>'type' = 'memory_updated'
            )
            and (
              exists (
                select 1 from ai_observations artifacts
                where artifacts.run_id = runs.id
                  and artifacts.kind in ('memory_application', 'memory_extraction_result', 'memory_written')
              )
              or exists (
                select 1 from user_memory_revisions revisions
                where revisions.run_id = runs.id
              )
            )
          )
          or (
            (select count(*) from ai_run_events memory_events
             where memory_events.run_id = runs.id
               and memory_events.event->>'type' = 'memory_updated') = 1
            and (
              (select count(*) from ai_observations applications
               where applications.run_id = runs.id
                 and applications.kind = 'memory_application') <> 1
              or (select count(*) from ai_observations extractions
                  where extractions.run_id = runs.id
                    and extractions.kind = 'memory_extraction_result') <> 1
              or exists (
                select 1
                from ai_observations extractions
                where extractions.run_id = runs.id
                  and extractions.kind = 'memory_extraction_result'
                  and not exists (
                    select 1
                    from ai_observations measurements
                    join ai_run_usage usage_rows
                      on usage_rows.run_id = measurements.run_id
                     and usage_rows.task_id = measurements.emitting_task
                     and usage_rows.loop_iteration = measurements.loop_iteration
                     and usage_rows.attempt = measurements.attempt
                     and usage_rows.provider_request_index::text = measurements.payload->>'providerRequestIndex'
                    where measurements.run_id = extractions.run_id
                      and measurements.kind = 'provider_request_measurement'
                      and measurements.emitting_task = extractions.emitting_task
                      and measurements.loop_iteration = extractions.loop_iteration
                      and measurements.attempt = extractions.attempt
                      and measurements.payload->>'passed' = 'true'
                      and extractions.payload->>'extractionSha256Hex' is not null
                    )
              )
              or exists (
                select 1
                from ai_observations applications
                where applications.run_id = runs.id
                  and applications.kind = 'memory_application'
                  and not exists (
                    select 1
                    from ai_observations extractions
                    where extractions.run_id = applications.run_id
                      and extractions.kind = 'memory_extraction_result'
                      and extractions.emitting_task = applications.payload->>'extractionTaskId'
                      and extractions.loop_iteration::numeric = (applications.payload->>'extractionLoopIteration')::numeric
                      and extractions.attempt::numeric = (applications.payload->>'extractionAttempt')::numeric
                      and extractions.observation_key = applications.payload->>'extractionObservationKey'
                      and extractions.payload->>'extractionSha256Hex' = applications.payload->>'extractionSha256Hex'
                      and extractions.payload->>'proposalCount' = applications.payload->>'proposalCount'
                      and extractions.payload->>'discardedCount' = applications.payload->>'discardedCount'
                  )
              )
              or exists (
                select 1
                from ai_observations extractions
                where extractions.run_id = runs.id
                  and extractions.kind = 'memory_extraction_result'
                  and not exists (
                    select 1
                    from ai_observations applications
                    where applications.run_id = extractions.run_id
                      and applications.kind = 'memory_application'
                      and extractions.emitting_task = applications.payload->>'extractionTaskId'
                      and extractions.loop_iteration::numeric = (applications.payload->>'extractionLoopIteration')::numeric
                      and extractions.attempt::numeric = (applications.payload->>'extractionAttempt')::numeric
                      and extractions.observation_key = applications.payload->>'extractionObservationKey'
                      and extractions.payload->>'extractionSha256Hex' = applications.payload->>'extractionSha256Hex'
                      and extractions.payload->>'proposalCount' = applications.payload->>'proposalCount'
                      and extractions.payload->>'discardedCount' = applications.payload->>'discardedCount'
                  )
              )
              or exists (
                select 1
                from ai_run_events memory_events
                join ai_observations applications
                  on applications.run_id = runs.id
                 and applications.kind = 'memory_application'
                where memory_events.run_id = runs.id
                  and memory_events.event->>'type' = 'memory_updated'
                  and (
                    memory_events.event->>'created' <> (select count(*)::text from ai_observations writes where writes.run_id = runs.id and writes.kind = 'memory_written' and writes.payload->>'action' = 'create')
                    or memory_events.event->>'updated' <> (select count(*)::text from ai_observations writes where writes.run_id = runs.id and writes.kind = 'memory_written' and writes.payload->>'action' = 'update')
                    or memory_events.event->>'discarded' <> applications.payload->>'discardedCount'
                    or applications.payload->>'proposalCount' <> ((select count(*) from ai_observations writes where writes.run_id = runs.id and writes.kind = 'memory_written')::bigint)::text
                  )
              )
              or exists (
                select 1
                from ai_observations writes
                where writes.run_id = runs.id
                  and writes.kind = 'memory_written'
                  and not exists (
                    select 1
                    from user_memory_revisions revisions
                    where revisions.id::text = writes.payload->>'revisionId'
                      and revisions.run_id = runs.id
                      and revisions.memory_id::text = writes.payload->>'memoryId'
                      and revisions.action = writes.payload->>'action'
                  )
              )
              or exists (
                select 1 from user_memory_revisions revisions
                where revisions.run_id = runs.id
                  and not exists (
                    select 1 from ai_observations writes
                    where writes.run_id = runs.id
                      and writes.kind = 'memory_written'
                      and writes.payload->>'revisionId' = revisions.id::text
                  )
              )
            )
          )
          or runs.assistant_message_id is not null
          or exists (
            select 1
            from chat_messages assistants
            join assistant_message_sources sources
              on sources.assistant_message_id = assistants.id
            where assistants.assistant_ai_run_id = runs.id
               or assistants.id = runs.assistant_message_id
          )
          or (
            (select count(*) from ai_run_events memory_events
             where memory_events.run_id = runs.id
               and memory_events.event->>'type' = 'memory_updated') = 1
            and (
              not exists (
                select 1
                from ai_observations measurements
                where measurements.run_id = runs.id
                  and measurements.kind = 'provider_request_measurement'
                  and measurements.emitting_task = 'memory-extract'
                  and measurements.payload->>'passed' = 'true'
              )
              or not exists (
                select 1
                from ai_observations measurements
                join ai_run_usage usage_rows
                  on usage_rows.run_id = measurements.run_id
                 and usage_rows.task_id = measurements.emitting_task
                 and usage_rows.loop_iteration = measurements.loop_iteration
                 and usage_rows.attempt = measurements.attempt
                 and usage_rows.provider_request_index::text = measurements.payload->>'providerRequestIndex'
                 and usage_rows.agent_role = measurements.payload->>'agentRole'
                 and usage_rows.model_id = measurements.payload->>'modelId'
                where measurements.run_id = runs.id
                  and measurements.kind = 'provider_request_measurement'
                  and measurements.emitting_task = 'memory-extract'
                  and measurements.payload->>'passed' = 'true'
              )
              or not exists (
                select 1
                from ai_run_usage usage_rows
                join ai_observations measurements
                  on measurements.run_id = usage_rows.run_id
                 and measurements.kind = 'provider_request_measurement'
                 and measurements.emitting_task = usage_rows.task_id
                 and measurements.loop_iteration = usage_rows.loop_iteration
                 and measurements.attempt = usage_rows.attempt
                 and measurements.payload->>'providerRequestIndex' = usage_rows.provider_request_index::text
                where usage_rows.run_id = runs.id
                  and usage_rows.task_id = 'memory-extract'
              )
              or not exists (
                select 1
                from ai_run_events usage_events
                join ai_run_usage usage_rows
                  on usage_rows.run_id = usage_events.run_id
                 and usage_rows.task_id = usage_events.emitted_by_task
                 and usage_events.emission_key = format(
                   'usage:request:model:%s:%s:%s:%s', usage_rows.task_id,
                   usage_rows.loop_iteration, usage_rows.attempt, usage_rows.provider_request_index)
                where usage_events.run_id = runs.id
                  and usage_events.emitted_by_task = 'memory-extract'
                  and usage_events.event->>'type' = 'usage'
                  and usage_events.event->>'scope' = 'request'
                  and usage_events.event->>'kind' = 'model'
              )
            )
          )
          or exists (
            select 1
            from ai_run_events aggregate
            where aggregate.run_id = runs.id
              and aggregate.event->>'type' = 'usage'
              and aggregate.event->>'scope' = 'run'
              and (
                aggregate.event->'model'->>'inputTokens' <> coalesce((select sum(input_tokens) from ai_run_usage where run_id = runs.id), 0)::text
                or aggregate.event->'model'->>'outputTokens' <> coalesce((select sum(output_tokens) from ai_run_usage where run_id = runs.id), 0)::text
                or aggregate.event->'model'->>'cachedTokens' <> coalesce((select sum(cached_tokens) from ai_run_usage where run_id = runs.id), 0)::text
                or aggregate.event->'model'->>'reasoningTokens' <> coalesce((select sum(reasoning_tokens) from ai_run_usage where run_id = runs.id), 0)::text
                or aggregate.event->'model'->>'totalTokens' <> coalesce((select sum(total_tokens) from ai_run_usage where run_id = runs.id), 0)::text
                or aggregate.event->'model'->>'requestCount' <> (select count(*) from ai_run_usage where run_id = runs.id)::text
                or aggregate.event->'web'->>'searchCount' <> (select count(*) from ai_external_tool_usage where run_id = runs.id and operation = 'web_search')::text
                or aggregate.event->'web'->>'fetchCount' <> (select count(*) from ai_external_tool_usage where run_id = runs.id and operation = 'web_fetch')::text
                or aggregate.event->'web'->>'responseBytes' <> coalesce((select sum(response_bytes) from ai_external_tool_usage where run_id = runs.id), 0)::text
              )
          )
          or exists (
            select 1
            from ai_run_events terminal
            join ai_run_events later
              on later.run_id = terminal.run_id
             and later.seq > terminal.seq
            where terminal.run_id = runs.id
              and terminal.event->>'type' = 'error'
          )
          or not exists (
            select 1
            from ai_run_events started
            join ai_run_events aggregate
              on aggregate.run_id = started.run_id
             and aggregate.event->>'type' = 'usage'
             and aggregate.event->>'scope' = 'run'
            join ai_run_events terminal
              on terminal.run_id = started.run_id
             and terminal.event->>'type' = 'error'
            where started.run_id = runs.id
              and started.event->>'type' = 'run_started'
              and started.emitted_by_task is null
              and started.emission_key = 'run_started'
              and aggregate.emission_key = 'usage:run'
              and terminal.emission_key = 'terminal'
              and terminal.event->>'code' is not distinct from runs.error_code
              and terminal.event->'retryable' is not distinct from to_jsonb(runs.retryable)
              and started.seq < aggregate.seq
              and aggregate.seq < terminal.seq
              and (
                (
                  (select count(*) from ai_run_events memory_events
                   where memory_events.run_id = runs.id
                     and memory_events.event->>'type' = 'memory_updated') = 1
                  and aggregate.emitted_by_task = 'finalize'
                  and terminal.emitted_by_task = 'finalize'
                  and exists (
                    select 1 from ai_run_events memory_events
                    where memory_events.run_id = runs.id
                      and memory_events.event->>'type' = 'memory_updated'
                      and memory_events.emitted_by_task = 'finalize'
                      and memory_events.emission_key = 'memory_updated'
                      and started.seq < memory_events.seq
                      and memory_events.seq < aggregate.seq
                  )
                )
                or (
                  not exists (
                    select 1 from ai_run_events memory_events
                    where memory_events.run_id = runs.id
                      and memory_events.event->>'type' = 'memory_updated'
                  )
                  and aggregate.emitted_by_task = 'failure-handler'
                  and terminal.emitted_by_task = 'failure-handler'
                )
              )
          )
        )
      order by runs.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: failed terminal event ledger is incomplete',
        row_data.row_identity;
    end loop;

  -- The answer event projects the persisted source map and its consumer
  -- measurements exactly, rather than merely carrying well-typed JSON.
  -- Keep provenance failures ahead of that projection so a bad saved-answer
  -- record names its source row instead of being masked by a derived ledger.
  for row_data in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      where (
        sources.kind = 'document'
        and (
          jsonb_typeof(sources.public_provenance) is distinct from 'object'
          or jsonb_typeof(sources.public_provenance->'documentTitle') is distinct from 'string'
          or coalesce(btrim(sources.public_provenance->>'documentTitle'), '') = ''
          or jsonb_typeof(sources.public_provenance->'citationUrl') is distinct from 'string'
          or coalesce(btrim(sources.public_provenance->>'citationUrl'), '') = ''
          or (sources.locator->>'sourceId' like 'publisher:%' and (
            jsonb_typeof(sources.public_provenance->'sourceName') is distinct from 'string'
            or jsonb_typeof(sources.public_provenance->'issueTitle') is distinct from 'string'
            or jsonb_typeof(sources.public_provenance->'publishedAt') is distinct from 'string'
            or sources.public_provenance->>'citationUrl' <> format(
              '/v1/issues/%s/documents/%s/content',
              sources.locator->>'publisherIssueId', sources.locator->>'publisherDocumentId')
          ))
        )
      )
      or (sources.kind in ('chat_message', 'memory') and (
        jsonb_typeof(sources.public_provenance) is distinct from 'object'
        or sources.public_provenance <> '{}'::jsonb
      ))
      or (sources.kind = 'web' and (
        jsonb_typeof(sources.public_provenance) is distinct from 'object'
        or exists (
          select 1 from jsonb_object_keys(sources.public_provenance) key
          where key <> 'citationUrl'
        )
        or exists (
          select 1 from jsonb_each(sources.public_provenance) entries(key, value)
          where jsonb_typeof(entries.value) is distinct from 'string'
        )
        or jsonb_typeof(sources.public_provenance->'citationUrl') is distinct from 'string'
        or coalesce(btrim(sources.public_provenance->>'citationUrl'), '') = ''
        or sources.public_provenance->>'citationUrl' <> sources.locator->>'url'
        or sources.locator->>'url' <> btrim(sources.locator->>'url')
        or sources.locator->>'url' ~ '[[:cntrl:]]'
        or sources.locator->>'url' ~ '[^ -~]'
        or sources.locator->>'url' !~ '^https://[^[:space:]]+$'
        or substring(sources.locator->>'url' from '^https://([^/:?#]+)') is null
        or substring(sources.locator->>'url' from '^https://([^/:?#]+)') <>
          lower(substring(sources.locator->>'url' from '^https://([^/:?#]+)'))
        or not brief_public_source_https_url_allowed(sources.locator->>'url')
        or length(substring(sources.locator->>'url' from '^https://([^/:?#]+)')) > 253
        or substring(sources.locator->>'url' from '^https://([^/:?#]+)') in ('localhost')
        or substring(sources.locator->>'url' from '^https://([^/:?#]+)') like '%.localhost'
        or substring(sources.locator->>'url' from '^https://([^/:?#]+)') like '%.local'
        or substring(sources.locator->>'url' from '^https://([^/:?#]+)') like '%.localdomain'
        or substring(sources.locator->>'url' from '^https://([^/:?#]+)') like '%.internal'
        or substring(sources.locator->>'url' from '^https://([^/:?#]+)') like '%.corp'
        or substring(sources.locator->>'url' from '^https://([^/:?#]+)') like '%.lan'
        or substring(sources.locator->>'url' from '^https://([^/:?#]+)') like '%.home'
        or substring(sources.locator->>'url' from '^https://([^/:?#]+)') like '%.home.arpa'
        or substring(sources.locator->>'url' from '^https://([^/:?#]+)') ~* E'^((0x[0-9a-f]+|[0-9]+)(\\.(0x[0-9a-f]+|[0-9]+)){0,3})$'
        or position('@' in substring(sources.locator->>'url' from '^https://([^/?#]+)')) > 0
        or position(':' in substring(sources.locator->>'url' from '^https://([^/?#]+)')) > 0
        or sources.locator->>'url' ~ '^https://[^/?#]+(?:$|[?#])'
        or position(chr(34) in sources.locator->>'url') > 0
        or position('<' in sources.locator->>'url') > 0
        or position('>' in sources.locator->>'url') > 0
        or split_part(split_part(sources.locator->>'url', '?', 1), '#', 1) ~* '(^|/)(\.{1,2}|%2e(?:%2e)?|\.%2e|%2e\.)(/|$)'
        or position('^' in split_part(split_part(sources.locator->>'url', '?', 1), '#', 1)) > 0
        or position(chr(96) in split_part(split_part(sources.locator->>'url', '?', 1), '#', 1)) > 0
        or position('{' in split_part(split_part(sources.locator->>'url', '?', 1), '#', 1)) > 0
        or position('}' in split_part(split_part(sources.locator->>'url', '?', 1), '#', 1)) > 0
        or position(chr(92) in split_part(split_part(sources.locator->>'url', '?', 1), '#', 1)) > 0
        or position(chr(39) in case
          when position('?' in split_part(sources.locator->>'url', '#', 1)) > 0 then
            substring(
              split_part(sources.locator->>'url', '#', 1)
              from position('?' in split_part(sources.locator->>'url', '#', 1)) + 1
            )
          else ''
        end) > 0
        or position(chr(96) in case
          when position('#' in sources.locator->>'url') > 0 then
            substring(sources.locator->>'url' from position('#' in sources.locator->>'url') + 1)
          else ''
        end) > 0
      ))
      or (sources.kind = 'document' and sources.locator->>'sourceId' like 'public:%'
        and (
          not exists (
            select 1 from public_source_documents documents
            where documents.document_id = sources.locator->>'documentId'
              and documents.source_id = substring(sources.locator->>'sourceId' from 8)
              and documents.canonical_url = sources.public_provenance->>'citationUrl'
          )
          or sources.public_provenance->>'citationUrl' <> btrim(sources.public_provenance->>'citationUrl')
          or sources.public_provenance->>'citationUrl' ~ '[[:cntrl:]]'
          or sources.public_provenance->>'citationUrl' ~ '[^ -~]'
          or sources.public_provenance->>'citationUrl' !~ '^https://[^[:space:]]+$'
          or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') is null
          or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') <> lower(substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)'))
          or not brief_public_source_https_url_allowed(sources.public_provenance->>'citationUrl')
          or length(substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)')) > 253
          or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') in ('localhost')
          or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') like '%.localhost'
          or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') like '%.local'
          or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') like '%.localdomain'
          or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') like '%.internal'
          or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') like '%.corp'
          or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') like '%.lan'
          or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') like '%.home'
          or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') like '%.home.arpa'
          or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') ~* E'^((0x[0-9a-f]+|[0-9]+)(\\.(0x[0-9a-f]+|[0-9]+)){0,3})$'
          or position('@' in substring(sources.public_provenance->>'citationUrl' from '^https://([^/?#]+)')) > 0
          or position(':' in substring(sources.public_provenance->>'citationUrl' from '^https://([^/?#]+)')) > 0
          or sources.public_provenance->>'citationUrl' ~ '^https://[^/?#]+(?:$|[?#])'
          or position(chr(34) in sources.public_provenance->>'citationUrl') > 0
          or position('<' in sources.public_provenance->>'citationUrl') > 0
          or position('>' in sources.public_provenance->>'citationUrl') > 0
          or split_part(split_part(sources.public_provenance->>'citationUrl', '?', 1), '#', 1) ~* '(^|/)(\.{1,2}|%2e(?:%2e)?|\.%2e|%2e\.)(/|$)'
          or position('^' in split_part(split_part(sources.public_provenance->>'citationUrl', '?', 1), '#', 1)) > 0
          or position(chr(96) in split_part(split_part(sources.public_provenance->>'citationUrl', '?', 1), '#', 1)) > 0
          or position('{' in split_part(split_part(sources.public_provenance->>'citationUrl', '?', 1), '#', 1)) > 0
          or position('}' in split_part(split_part(sources.public_provenance->>'citationUrl', '?', 1), '#', 1)) > 0
          or position(chr(92) in split_part(split_part(sources.public_provenance->>'citationUrl', '?', 1), '#', 1)) > 0
          or position(chr(39) in case
            when position('?' in split_part(sources.public_provenance->>'citationUrl', '#', 1)) > 0 then
              substring(
                split_part(sources.public_provenance->>'citationUrl', '#', 1)
                from position('?' in split_part(sources.public_provenance->>'citationUrl', '#', 1)) + 1
              )
            else ''
          end) > 0
          or position(chr(96) in case
            when position('#' in sources.public_provenance->>'citationUrl') > 0 then
              substring(sources.public_provenance->>'citationUrl' from position('#' in sources.public_provenance->>'citationUrl') + 1)
            else ''
          end) > 0
        ))
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: public provenance is not a closed canonical record',
        row_data.row_identity;
    end loop;

  -- Reject retained source rows before validating any derived answer ledger.
  -- A source without a canonical answer use cannot be decoded after cutover.
  for row_data in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      join chat_messages assistants on assistants.id = sources.assistant_message_id
      join ai_runs runs on runs.assistant_message_id = assistants.id
      where runs.finished_at is not null
        and runs.failed_at is null
        and not exists (
          select 1
          from assistant_message_source_uses uses
          where uses.assistant_message_id = sources.assistant_message_id
            and uses.source_key = sources.source_key
            and (
              uses.consumer_task_id = 'single-answer'
              or uses.consumer_task_id ~ '^topic-t[123]-answer$'
            )
        )
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: source has no canonical answer use',
        row_data.row_identity;
    end loop;

  for row_data in
      select runs.id::text as row_identity
      from ai_runs runs
      where runs.finished_at is not null and runs.failed_at is null
        and exists (
          select 1 from ai_run_usage route_usage
          where route_usage.run_id = runs.id and route_usage.task_id = 'plan-turn'
        )
        and exists (
          select 1 from ai_run_usage route_usage
          where route_usage.run_id = runs.id and route_usage.task_id = 'memory-extract'
        )
        and (
          (select count(*)
           from ai_run_events contexts
           cross join lateral jsonb_array_elements(contexts.event->'sourcesRead') source
           where contexts.run_id = runs.id and contexts.event->>'type' = 'context_ready')
          <> (select count(*)
              from assistant_message_sources sources
              where sources.assistant_message_id = runs.assistant_message_id)
          or exists (
            select 1
            from ai_run_events contexts
            cross join lateral jsonb_array_elements(contexts.event->'sourcesRead') source
            where contexts.run_id = runs.id and contexts.event->>'type' = 'context_ready'
            group by source->>'sourceKey'
            having count(*) <> 1
          )
          or
          exists (
            select 1
            from assistant_message_sources sources
            where sources.assistant_message_id = runs.assistant_message_id
              and not exists (
                select 1
                from ai_run_events contexts
                cross join lateral jsonb_array_elements(contexts.event->'sourcesRead') source
                where contexts.run_id = runs.id and contexts.event->>'type' = 'context_ready'
                  and source->>'sourceKey' = sources.source_key
                  and source->>'kind' = sources.kind
                  and source->'label' is not distinct from to_jsonb(sources.display_label)
                  and source->>'tokenCount' = (select coalesce(sum(uses.rendered_token_count), 0)::text
                    from assistant_message_source_uses uses
                    where uses.assistant_message_id = sources.assistant_message_id
                      and uses.source_key = sources.source_key)
                  and source->'topicIds' is not distinct from coalesce((
                    select jsonb_agg(topic_id order by topic_id)
                    from (select distinct uses.topic_id from assistant_message_source_uses uses
                      where uses.assistant_message_id = sources.assistant_message_id
                        and uses.source_key = sources.source_key and uses.topic_id is not null) topics
                  ), '[]'::jsonb)
                  and (
                    (sources.kind = 'document'
                      and source->'documentTitle' is not distinct from sources.public_provenance->'documentTitle'
                      and source->'url' is not distinct from sources.public_provenance->'citationUrl'
                      and source->'sourceName' is not distinct from sources.public_provenance->'sourceName'
                      and source->'issueTitle' is not distinct from sources.public_provenance->'issueTitle'
                      and source->'publishedAt' is not distinct from sources.public_provenance->'publishedAt'
                      and source->'ranges' is not distinct from coalesce(sources.locator->'ranges', '[]'::jsonb))
                    or (sources.kind = 'chat_message'
                      and source->'messageId' is not distinct from sources.locator->'messageId'
                      and source->'ranges' = '[]'::jsonb)
                    or (sources.kind = 'memory'
                      and source->'memoryId' is not distinct from sources.locator->'memoryId'
                      and source->'memoryRevisionId' is not distinct from sources.locator->'memoryRevisionId'
                      and source->'ranges' = '[]'::jsonb)
                    or (sources.kind = 'web'
                      and source->'title' is not distinct from sources.locator->'title'
                      and source->'domain' is not distinct from sources.locator->'domain'
                      and source->'url' is not distinct from sources.locator->'url'
                      and source->'publishedAt' is not distinct from sources.locator->'publishedAt'
                      and source->'capturedAt' is not distinct from sources.locator->'capturedAt'
                      and source->'quote' is not distinct from sources.locator->'quote'
                      and source->'ranges' = '[]'::jsonb)
                  )
              )
          )
          or exists (
            select 1
            from ai_run_events contexts
            cross join lateral jsonb_array_elements(contexts.event->'sourcesRead') source
            where contexts.run_id = runs.id and contexts.event->>'type' = 'context_ready'
              and not exists (
                select 1 from assistant_message_sources sources
                where sources.assistant_message_id = runs.assistant_message_id
                  and sources.source_key = source->>'sourceKey'
              )
            )
          )
      order by runs.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: context source projection differs from retained source ledger',
        row_data.row_identity;
    end loop;

  -- Context consumers must agree with the terminal context measurements.
  for row_data in
      select runs.id::text as row_identity
      from ai_runs runs
      join ai_observations plans on plans.run_id = runs.id and plans.kind = 'turn_plan'
      where runs.finished_at is not null and runs.failed_at is null
        and exists (
          select 1 from ai_run_usage route_usage
          where route_usage.run_id = runs.id and route_usage.task_id = 'plan-turn'
        )
        and exists (
          select 1 from ai_run_usage route_usage
          where route_usage.run_id = runs.id and route_usage.task_id = 'memory-extract'
        )
        and (
          exists (
            select 1
            from ai_observations measurements
            where measurements.run_id = runs.id and measurements.kind = 'context_measurement'
              and measurements.emitting_task in ('single-answer', 'fanout-synthesis', 'topic-t1-answer', 'topic-t2-answer', 'topic-t3-answer')
              and not exists (
                select 1
                from ai_run_events contexts
                cross join lateral jsonb_array_elements(contexts.event->'consumers') consumer
                where contexts.run_id = runs.id and contexts.event->>'type' = 'context_ready'
                  and consumer->>'consumer' = case when measurements.emitting_task = 'single-answer' then 'direct'
                    when measurements.emitting_task = 'fanout-synthesis' then 'synthesis' else 'topic' end
                  and ((consumer->>'topicId') is not distinct from case when measurements.emitting_task like 'topic-%'
                    then substring(measurements.emitting_task from 7 for 2) else null end)
                  and consumer->>'inputTokens' = measurements.payload->>'totalInputTokens'
                  and consumer->>'requestedOutputTokens' = measurements.payload->>'requestedOutputTokens'
                  and consumer->>'usableInputTokens' = measurements.payload->>'usableInputTokens'
              )
          )
          or (
            (select count(*)
             from ai_run_events contexts
             cross join lateral jsonb_array_elements(contexts.event->'consumers') consumer
             where contexts.run_id = runs.id and contexts.event->>'type' = 'context_ready')
            <> (select count(*) from ai_observations measurements
                where measurements.run_id = runs.id
                  and measurements.kind = 'context_measurement'
                  and measurements.emitting_task in ('single-answer', 'fanout-synthesis', 'topic-t1-answer', 'topic-t2-answer', 'topic-t3-answer'))
          )
          or exists (
            select 1
            from ai_run_events contexts
            cross join lateral jsonb_array_elements(contexts.event->'consumers') with ordinality consumer(value, ordinal)
            where contexts.run_id = runs.id and contexts.event->>'type' = 'context_ready'
              and not exists (
                select 1
                from (
                  select measurements.payload,
                         measurements.emitting_task,
                         row_number() over (order by case
                           when measurements.emitting_task = 'topic-t1-answer' then 1
                           when measurements.emitting_task = 'topic-t2-answer' then 2
                           when measurements.emitting_task = 'topic-t3-answer' then 3
                           when measurements.emitting_task = 'fanout-synthesis' then 4
                           else 1 end) as ordinal
                  from ai_observations measurements
                  where measurements.run_id = runs.id
                    and measurements.kind = 'context_measurement'
                    and measurements.emitting_task in ('single-answer', 'fanout-synthesis', 'topic-t1-answer', 'topic-t2-answer', 'topic-t3-answer')
                ) expected
                where expected.ordinal = consumer.ordinal
                  and consumer.value->>'consumer' = case when expected.emitting_task = 'single-answer' then 'direct'
                    when expected.emitting_task = 'fanout-synthesis' then 'synthesis' else 'topic' end
                  and consumer.value->>'topicId' is not distinct from case when expected.emitting_task like 'topic-%'
                    then substring(expected.emitting_task from 7 for 2) else null end
                  and consumer.value->>'inputTokens' = expected.payload->>'totalInputTokens'
                  and consumer.value->>'requestedOutputTokens' = expected.payload->>'requestedOutputTokens'
                  and consumer.value->>'usableInputTokens' = expected.payload->>'usableInputTokens'
              )
          )
        )
      order by runs.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: context consumer projection differs from its measurement ledger',
        row_data.row_identity;
    end loop;

  -- The run usage event is a deterministic aggregate of request and external
  -- tool usage rows, not an independently supplied total.
  for row_data in
      select runs.id::text as row_identity
      from ai_runs runs
      join ai_run_events aggregates on aggregates.run_id = runs.id
        and aggregates.event->>'type' = 'usage' and aggregates.event->>'scope' = 'run'
      where runs.finished_at is not null and runs.failed_at is null
        and (
          aggregates.event->'model'->>'inputTokens' <> coalesce((select sum(input_tokens) from ai_run_usage where run_id = runs.id), 0)::text
          or aggregates.event->'model'->>'outputTokens' <> coalesce((select sum(output_tokens) from ai_run_usage where run_id = runs.id), 0)::text
          or aggregates.event->'model'->>'cachedTokens' <> coalesce((select sum(cached_tokens) from ai_run_usage where run_id = runs.id), 0)::text
          or aggregates.event->'model'->>'reasoningTokens' <> coalesce((select sum(reasoning_tokens) from ai_run_usage where run_id = runs.id), 0)::text
          or aggregates.event->'model'->>'totalTokens' <> coalesce((select sum(total_tokens) from ai_run_usage where run_id = runs.id), 0)::text
          or aggregates.event->'model'->>'requestCount' <> (select count(*) from ai_run_usage where run_id = runs.id)::text
          or aggregates.event->'web'->>'searchCount' <> (select count(*) from ai_external_tool_usage where run_id = runs.id and operation = 'web_search')::text
          or aggregates.event->'web'->>'fetchCount' <> (select count(*) from ai_external_tool_usage where run_id = runs.id and operation = 'web_fetch')::text
          or aggregates.event->'web'->>'responseBytes' <> coalesce((select sum(response_bytes) from ai_external_tool_usage where run_id = runs.id), 0)::text
        )
      order by runs.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: run usage aggregate does not match request and tool ledgers',
        row_data.row_identity;
    end loop;

  -- Memory finalization is part of the success boundary. Counts, extraction
  -- identity, and current-run revisions must agree with memory_updated.
  for row_data in
      select writes.id::text as row_identity
      from ai_observations writes
      join ai_runs runs on runs.id = writes.run_id
      left join user_memory_revisions current_revisions
        on current_revisions.id::text = writes.payload->>'revisionId'
      left join user_memories memories
        on memories.id = current_revisions.memory_id
      left join lateral (
        select prior_revisions.id, prior_revisions.state_after
        from user_memory_revisions prior_revisions
        where prior_revisions.memory_id = current_revisions.memory_id
          and (
            prior_revisions.created_at,
            prior_revisions.id
          ) < (
            current_revisions.created_at,
            current_revisions.id
          )
        order by prior_revisions.created_at desc, prior_revisions.id desc
        limit 1
      ) previous_revisions on true
      where writes.kind = 'memory_written'
        and (
          (runs.finished_at is not null and runs.failed_at is null)
          or (runs.failed_at is not null and runs.finished_at is null)
        )
        and (
          current_revisions.id is null
          or memories.id is null
          or current_revisions.run_id is distinct from writes.run_id
          or current_revisions.memory_id::text is distinct from
            writes.payload->>'memoryId'
          or current_revisions.action is distinct from writes.payload->>'action'
          or memories.user_id is distinct from runs.initiating_user_id
          or memories.source_message_id is distinct from runs.user_message_id
          or memories.head_revision_id is distinct from current_revisions.id
          or current_revisions.state_after is distinct from jsonb_build_object(
            'kind', memories.kind,
            'content', btrim(memories.content),
            'deleted', memories.deleted_at is not null
          )
          or current_revisions.state_after->>'deleted' is distinct from 'false'
          or (
            writes.payload->>'action' = 'create'
            and (
              writes.payload->'previousRevisionId' <> 'null'::jsonb
              or current_revisions.state_before is not null
              or previous_revisions.id is not null
            )
          )
          or (
            writes.payload->>'action' = 'update'
            and (
              previous_revisions.id is null
              or writes.payload->>'previousRevisionId' is distinct from
                previous_revisions.id::text
              or current_revisions.state_before is distinct from
                previous_revisions.state_after
              or previous_revisions.state_after->>'deleted' is distinct from 'false'
            )
          )
        )
      order by writes.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_observations/%: memory write is not bound to its immediate prior revision and current live head',
        row_data.row_identity;
    end loop;

  for row_data in
      select runs.id::text as row_identity
      from ai_runs runs
      join ai_run_events memory_events on memory_events.run_id = runs.id
        and memory_events.event->>'type' = 'memory_updated'
      left join ai_observations applications on applications.run_id = runs.id
        and applications.kind = 'memory_application'
      where runs.finished_at is not null and runs.failed_at is null
        and (
          memory_events.event->>'created' <> (select count(*) from ai_observations writes
            where writes.run_id = runs.id and writes.kind = 'memory_written'
              and writes.payload->>'action' = 'create')::text
          or memory_events.event->>'updated' <> (select count(*) from ai_observations writes
            where writes.run_id = runs.id and writes.kind = 'memory_written'
              and writes.payload->>'action' = 'update')::text
          or memory_events.event->>'discarded' <> coalesce(applications.payload->>'discardedCount', '-1')
          or (select count(*) from ai_observations extractions
              where extractions.run_id = runs.id and extractions.kind = 'memory_extraction_result') <> 1
          or (select count(*) from ai_observations applications2
              where applications2.run_id = runs.id and applications2.kind = 'memory_application') <> 1
          or exists (
            select 1
            from ai_observations applications2
            where applications2.run_id = runs.id
              and applications2.kind = 'memory_application'
              and not exists (
                select 1
                from ai_observations extractions2
                where extractions2.run_id = applications2.run_id
                  and extractions2.kind = 'memory_extraction_result'
                  and extractions2.emitting_task = applications2.payload->>'extractionTaskId'
                  and extractions2.loop_iteration::numeric = (applications2.payload->>'extractionLoopIteration')::numeric
                  and extractions2.attempt::numeric = (applications2.payload->>'extractionAttempt')::numeric
                  and extractions2.observation_key = applications2.payload->>'extractionObservationKey'
                  and extractions2.payload->>'extractionSha256Hex' = applications2.payload->>'extractionSha256Hex'
                  and extractions2.payload->>'proposalCount' = applications2.payload->>'proposalCount'
                  and extractions2.payload->>'discardedCount' = applications2.payload->>'discardedCount'
              )
          )
          or exists (
            select 1
            from ai_observations extractions2
            where extractions2.run_id = runs.id
              and extractions2.kind = 'memory_extraction_result'
              and not exists (
                select 1
                from ai_observations applications2
                where applications2.run_id = extractions2.run_id
                  and applications2.kind = 'memory_application'
                  and extractions2.emitting_task = applications2.payload->>'extractionTaskId'
                  and extractions2.loop_iteration::numeric = (applications2.payload->>'extractionLoopIteration')::numeric
                  and extractions2.attempt::numeric = (applications2.payload->>'extractionAttempt')::numeric
                  and extractions2.observation_key = applications2.payload->>'extractionObservationKey'
                  and extractions2.payload->>'extractionSha256Hex' = applications2.payload->>'extractionSha256Hex'
                  and extractions2.payload->>'proposalCount' = applications2.payload->>'proposalCount'
                  and extractions2.payload->>'discardedCount' = applications2.payload->>'discardedCount'
              )
          )
          or exists (
            select 1
            from ai_observations writes
            where writes.run_id = runs.id and writes.kind = 'memory_written'
              and not exists (
                select 1
                from user_memory_revisions revisions
                where revisions.id::text = writes.payload->>'revisionId'
                  and revisions.run_id = runs.id
                  and revisions.memory_id::text = writes.payload->>'memoryId'
                  and revisions.action = writes.payload->>'action'
              )
          )
          or exists (
            select 1
            from user_memory_revisions revisions
            where revisions.run_id = runs.id
              and not exists (
                select 1
                from ai_observations writes
                where writes.run_id = runs.id
                  and writes.kind = 'memory_written'
                  and writes.payload->>'revisionId' = revisions.id::text
              )
          )
        )
      order by runs.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: successful memory extraction, application, writes, and counts do not agree',
        row_data.row_identity;
    end loop;

  for row_data in
      select runs.id::text as row_identity
      from ai_runs runs
      where runs.finished_at is not null
        and runs.failed_at is null
        and exists (
          select 1 from ai_observations extraction
          where extraction.run_id = runs.id and extraction.kind = 'memory_extraction_result'
        )
        and exists (
          select 1 from ai_observations application
          where application.run_id = runs.id and application.kind = 'memory_application'
        )
        and (
          exists (
            select 1 from ai_run_usage usage_rows
            where usage_rows.run_id = runs.id
              and not exists (
                select 1 from ai_observations measurements
                where measurements.run_id = runs.id
                  and measurements.kind = 'provider_request_measurement'
                  and measurements.emitting_task = usage_rows.task_id
                  and measurements.loop_iteration = usage_rows.loop_iteration
                  and measurements.attempt = usage_rows.attempt
                  and measurements.payload->>'providerRequestIndex' = usage_rows.provider_request_index::text
              )
          )
          or exists (
            select 1 from ai_observations measurements
            where measurements.run_id = runs.id
              and measurements.kind = 'provider_request_measurement'
              and not exists (
                select 1 from ai_run_usage usage_rows
                where usage_rows.run_id = runs.id
                  and usage_rows.task_id = measurements.emitting_task
                  and usage_rows.loop_iteration = measurements.loop_iteration
                  and usage_rows.attempt = measurements.attempt
                  and measurements.payload->>'providerRequestIndex' = usage_rows.provider_request_index::text
              )
              and not (
                measurements.payload->>'passed' = 'true'
                and not exists (
                  select 1
                  from ai_observations output_rows
                  where output_rows.run_id = measurements.run_id
                    and output_rows.emitting_task = measurements.emitting_task
                    and output_rows.loop_iteration = measurements.loop_iteration
                    and output_rows.attempt = measurements.attempt
                    and output_rows.kind in (
                      'turn_plan', 'retrieval_manifest', 'context_measurement',
                      'context_decision', 'context_reducer_terminal', 'context_serialized',
                      'topic_packet', 'memory_extraction_result', 'answer_started',
                      'answer_delta', 'answer_completed'
                    )
                )
                and not exists (
                  select 1
                  from ai_run_events output_events
                  where output_events.run_id = measurements.run_id
                    and output_events.emitted_by_task = measurements.emitting_task
                    and output_events.event->>'type' = 'text_delta'
                    and output_events.emission_key ~ '^text_delta:[^:]+:[0-9]+:[0-9]+$'
                    and substring(output_events.emission_key from '[^:]+:([0-9]+):[0-9]+$') = measurements.attempt::text
                )
                and exists (
                  select 1
                  from ai_observations retry_measurements
                  join ai_run_usage retry_usage
                    on retry_usage.run_id = retry_measurements.run_id
                   and retry_usage.task_id = retry_measurements.emitting_task
                   and retry_usage.loop_iteration = retry_measurements.loop_iteration
                   and retry_usage.attempt = retry_measurements.attempt
                   and retry_usage.provider_request_index::text = retry_measurements.payload->>'providerRequestIndex'
                   and retry_usage.agent_role = retry_measurements.payload->>'agentRole'
                   and retry_usage.model_id = retry_measurements.payload->>'modelId'
                  where retry_measurements.run_id = measurements.run_id
                    and retry_measurements.kind = 'provider_request_measurement'
                    and retry_measurements.payload->>'passed' = 'true'
                    and (
                      retry_measurements.loop_iteration > measurements.loop_iteration
                      or (retry_measurements.loop_iteration = measurements.loop_iteration
                        and retry_measurements.attempt > measurements.attempt)
                    )
                )
                and not exists (
                  select 1
                  from ai_observations later_measurement
                  where later_measurement.run_id = measurements.run_id
                    and later_measurement.kind = 'provider_request_measurement'
                    and later_measurement.emitting_task = measurements.emitting_task
                    and later_measurement.loop_iteration = measurements.loop_iteration
                    and later_measurement.attempt = measurements.attempt
                    and later_measurement.id <> measurements.id
                    and later_measurement.payload->>'providerRequestIndex' ~ '^[0-9]+$'
                    and measurements.payload->>'providerRequestIndex' ~ '^[0-9]+$'
                    and (later_measurement.payload->>'providerRequestIndex')::numeric >
                      (measurements.payload->>'providerRequestIndex')::numeric
                )
                and not exists (
                  select 1
                  from ai_observations another
                  where another.run_id = measurements.run_id
                    and another.kind = 'provider_request_measurement'
                    and another.id <> measurements.id
                    and another.payload->>'passed' = 'true'
                    and not exists (
                      select 1
                      from ai_run_usage another_usage
                      where another_usage.run_id = another.run_id
                        and another_usage.task_id = another.emitting_task
                        and another_usage.loop_iteration = another.loop_iteration
                        and another_usage.attempt = another.attempt
                        and another_usage.provider_request_index::text = another.payload->>'providerRequestIndex'
                    )
                )
              )
          )
        )
      order by runs.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: successful run provider measurements and usage do not match',
        row_data.row_identity;
    end loop;

  -- A passed provider request cannot float without the durable output it
  -- owns.  This closes the gap where a usage/measurement pair exists but its
  -- plan, manifest, answer, reducer, or memory observation was lost.
  for row_data in
      select usage_rows.id::text as row_identity
      from ai_run_usage usage_rows
      join ai_runs runs on runs.id = usage_rows.run_id
      where runs.finished_at is not null
        and runs.failed_at is null
        and not exists (
          select 1
          from ai_observations outputs
          where outputs.run_id = usage_rows.run_id
            and outputs.emitting_task = usage_rows.task_id
            and outputs.loop_iteration = usage_rows.loop_iteration
            and outputs.attempt = usage_rows.attempt
            and outputs.kind in (
              'turn_plan', 'retrieval_manifest', 'context_measurement',
              'context_decision', 'context_reducer_terminal', 'context_serialized',
              'topic_packet', 'memory_extraction_result', 'answer_started',
              'answer_delta', 'answer_completed'
            )
        )
        and not exists (
          select 1
          from ai_run_events output_events
          where output_events.run_id = usage_rows.run_id
            and output_events.emitted_by_task = usage_rows.task_id
            and output_events.event->>'type' = 'text_delta'
            and output_events.emission_key ~ '^text_delta:[^:]+:[0-9]+:[0-9]+$'
            and substring(output_events.emission_key from '[^:]+:([0-9]+):[0-9]+$') = usage_rows.attempt::text
        )
      order by usage_rows.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_run_usage/%: successful provider request has no owning output observation',
        row_data.row_identity;
    end loop;

  for row_data in
      select measurements.id::text as row_identity,
             measurements.run_id, measurements.emitting_task,
             measurements.loop_iteration, measurements.attempt,
             measurements.payload
      from ai_observations measurements
      where measurements.kind = 'provider_request_measurement'
        and not exists (
          select 1
          from ai_run_usage usage_rows
          where usage_rows.run_id = measurements.run_id
            and usage_rows.task_id = measurements.emitting_task
            and usage_rows.loop_iteration = measurements.loop_iteration
            and usage_rows.attempt = measurements.attempt
            and measurements.payload->>'providerRequestIndex' ~ '^[0-9]+$'
            and (measurements.payload->>'providerRequestIndex')::numeric = usage_rows.provider_request_index
            and measurements.payload->>'agentRole' = usage_rows.agent_role
            and measurements.payload->>'modelId' = usage_rows.model_id
            and (measurements.payload->>'inputTokens')::numeric =
              (usage_rows.input_tokens + usage_rows.cached_tokens)::numeric
            and (measurements.payload->>'requestedOutputTokens')::numeric >=
              usage_rows.output_tokens::numeric
            and measurements.payload->>'passed' = 'true'
        )
        and not (
          exists (
            select 1 from ai_runs failed_runs
            where failed_runs.id = measurements.run_id
              and failed_runs.failed_at is not null
          )
          and measurements.payload->>'passed' = 'true'
          and not exists (
            select 1 from ai_observations terminal_output
            where terminal_output.run_id = measurements.run_id
              and terminal_output.emitting_task = measurements.emitting_task
              and terminal_output.loop_iteration = measurements.loop_iteration
              and terminal_output.attempt = measurements.attempt
              and terminal_output.kind in (
                'turn_plan', 'retrieval_manifest', 'context_measurement',
                'context_decision', 'context_reducer_terminal', 'context_serialized',
                'topic_packet', 'memory_extraction_result', 'answer_started',
                'answer_delta', 'answer_completed'
              )
          )
          and not exists (
            select 1 from ai_run_events terminal_delta
            where terminal_delta.run_id = measurements.run_id
              and terminal_delta.event->>'type' = 'text_delta'
              and terminal_delta.emitted_by_task = measurements.emitting_task
              and terminal_delta.emission_key ~ '^text_delta:[^:]+:[0-9]+:[0-9]+$'
              and substring(terminal_delta.emission_key from '[^:]+:([0-9]+):[0-9]+$') = measurements.attempt::text
          )
          and not exists (
            select 1 from ai_observations later_measurement
            where later_measurement.run_id = measurements.run_id
              and later_measurement.kind = 'provider_request_measurement'
              and later_measurement.emitting_task = measurements.emitting_task
              and later_measurement.loop_iteration = measurements.loop_iteration
              and later_measurement.attempt = measurements.attempt
              and later_measurement.payload->>'providerRequestIndex' ~ '^[0-9]+$'
              and measurements.payload->>'providerRequestIndex' ~ '^[0-9]+$'
              and (later_measurement.payload->>'providerRequestIndex')::numeric >
                (measurements.payload->>'providerRequestIndex')::numeric
          )
          or (
            exists (
              select 1 from ai_runs successful_runs
              where successful_runs.id = measurements.run_id
                and successful_runs.finished_at is not null
                and successful_runs.failed_at is null
            )
            and measurements.payload->>'passed' = 'true'
            and not exists (
              select 1 from ai_observations output_rows
              where output_rows.run_id = measurements.run_id
                and output_rows.emitting_task = measurements.emitting_task
                and output_rows.loop_iteration = measurements.loop_iteration
                and output_rows.attempt = measurements.attempt
                and output_rows.kind in (
                  'turn_plan', 'retrieval_manifest', 'context_measurement',
                  'context_decision', 'context_reducer_terminal', 'context_serialized',
                  'topic_packet', 'memory_extraction_result', 'answer_started',
                  'answer_delta', 'answer_completed'
                )
            )
            and not exists (
              select 1 from ai_run_events output_events
              where output_events.run_id = measurements.run_id
                and output_events.emitted_by_task = measurements.emitting_task
                and output_events.event->>'type' = 'text_delta'
                and output_events.emission_key ~ '^text_delta:[^:]+:[0-9]+:[0-9]+$'
                and substring(output_events.emission_key from '[^:]+:([0-9]+):[0-9]+$') = measurements.attempt::text
            )
            and exists (
              select 1
              from ai_observations retry_measurements
              join ai_run_usage retry_usage
                on retry_usage.run_id = retry_measurements.run_id
               and retry_usage.task_id = retry_measurements.emitting_task
               and retry_usage.loop_iteration = retry_measurements.loop_iteration
               and retry_usage.attempt = retry_measurements.attempt
               and retry_usage.provider_request_index::text = retry_measurements.payload->>'providerRequestIndex'
               and retry_usage.agent_role = retry_measurements.payload->>'agentRole'
               and retry_usage.model_id = retry_measurements.payload->>'modelId'
              where retry_measurements.run_id = measurements.run_id
                and retry_measurements.kind = 'provider_request_measurement'
                and retry_measurements.payload->>'passed' = 'true'
                and (
                  retry_measurements.loop_iteration > measurements.loop_iteration
                  or (retry_measurements.loop_iteration = measurements.loop_iteration
                    and retry_measurements.attempt > measurements.attempt)
                )
            )
            and not exists (
              select 1
              from ai_observations later_measurement
              where later_measurement.run_id = measurements.run_id
                and later_measurement.kind = 'provider_request_measurement'
                and later_measurement.emitting_task = measurements.emitting_task
                and later_measurement.loop_iteration = measurements.loop_iteration
                and later_measurement.attempt = measurements.attempt
                and later_measurement.id <> measurements.id
                and later_measurement.payload->>'providerRequestIndex' ~ '^[0-9]+$'
                and measurements.payload->>'providerRequestIndex' ~ '^[0-9]+$'
                and (later_measurement.payload->>'providerRequestIndex')::numeric >
                  (measurements.payload->>'providerRequestIndex')::numeric
            )
            and not exists (
              select 1 from ai_observations another
              where another.run_id = measurements.run_id
                and another.kind = 'provider_request_measurement'
                and another.id <> measurements.id
                and another.payload->>'passed' = 'true'
                and not exists (
                  select 1 from ai_run_usage another_usage
                  where another_usage.run_id = another.run_id
                    and another_usage.task_id = another.emitting_task
                    and another_usage.loop_iteration = another.loop_iteration
                    and another_usage.attempt = another.attempt
                    and another_usage.provider_request_index::text = another.payload->>'providerRequestIndex'
                )
            )
          )
        )
      order by measurements.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_observations/%: provider measurement has no matching usage row',
        row_data.row_identity;
    end loop;

  for row_data in
      select usage_rows.id::text as row_identity
      from ai_run_usage usage_rows
      where not exists (
        select 1
        from ai_observations measurements
        where measurements.run_id = usage_rows.run_id
          and measurements.emitting_task = usage_rows.task_id
          and measurements.loop_iteration = usage_rows.loop_iteration
          and measurements.attempt = usage_rows.attempt
          and measurements.kind = 'provider_request_measurement'
          and measurements.payload->>'providerRequestIndex' ~ '^[0-9]+$'
          and (measurements.payload->>'providerRequestIndex')::numeric = usage_rows.provider_request_index
          and measurements.payload->>'agentRole' = usage_rows.agent_role
          and measurements.payload->>'modelId' = usage_rows.model_id
          and (measurements.payload->>'inputTokens')::numeric =
            (usage_rows.input_tokens + usage_rows.cached_tokens)::numeric
          and (measurements.payload->>'requestedOutputTokens')::numeric >=
            usage_rows.output_tokens::numeric
          and measurements.payload->>'passed' = 'true'
      )
      order by usage_rows.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_run_usage/%: usage row has no matching provider measurement',
        row_data.row_identity;
    end loop;

  for row_data in
      select runs.id::text as row_identity
      from ai_runs runs
      where runs.finished_at is not null
        and runs.failed_at is null
        and (
          (select count(*) from ai_observations plans
           where plans.run_id = runs.id and plans.kind = 'turn_plan') <> 1
          or exists (
            select 1 from ai_observations plans
            where plans.run_id = runs.id and plans.kind = 'turn_plan'
              and plans.payload->>'mode' not in ('clarify', 'single', 'fanout')
          )
          or (select count(*) from ai_run_usage usage_rows
              where usage_rows.run_id = runs.id and usage_rows.task_id = 'plan-turn') = 0
          or (select count(*) from ai_run_usage usage_rows
              where usage_rows.run_id = runs.id and usage_rows.task_id = 'memory-extract') = 0
        )
      order by runs.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: successful run has no coherent plan and memory route',
        row_data.row_identity;
    end loop;

  for row_data in
      select runs.id::text as row_identity
      from ai_runs runs
      where runs.finished_at is not null
        and runs.failed_at is null
        and (
          (select count(*) from ai_run_events events
           where events.run_id = runs.id and events.event->>'type' = 'run_started') <> 1
          or (select count(*) from ai_run_events events
              where events.run_id = runs.id and events.event->>'type' = 'context_ready') <> 1
          or (select count(*) from ai_run_events events
              where events.run_id = runs.id and events.event->>'type' = 'answer_started') = 0
          or (select count(*) from ai_run_events events
              where events.run_id = runs.id and events.event->>'type' = 'memory_updated') <> 1
          or (select count(*) from ai_run_events events
              where events.run_id = runs.id and events.event->>'type' = 'usage'
                and events.event->>'scope' = 'run') <> 1
          or (select count(*) from ai_run_events events
              where events.run_id = runs.id and events.event->>'type' = 'done') <> 1
          or exists (
            select 1
            from ai_run_events done_events
            join ai_run_events later_events
              on later_events.run_id = done_events.run_id
             and later_events.seq > done_events.seq
            where done_events.run_id = runs.id
              and done_events.event->>'type' = 'done'
          )
          or exists (
            select 1
            from ai_run_events memory_events
            join ai_run_events run_usage_events
              on run_usage_events.run_id = memory_events.run_id
            where memory_events.run_id = runs.id
              and memory_events.event->>'type' = 'memory_updated'
              and run_usage_events.event->>'type' = 'usage'
              and run_usage_events.event->>'scope' = 'run'
              and run_usage_events.seq <= memory_events.seq
          )
          or exists (select 1 from ai_run_events events
                     where events.run_id = runs.id and events.event->>'type' = 'error')
        )
      order by runs.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: successful run terminal events are incomplete',
        row_data.row_identity;
    end loop;

  for row_data in
      select runs.id::text as row_identity
      from ai_runs runs
      where runs.finished_at is not null
        and runs.failed_at is null
        and (
          exists (
            select 1 from ai_run_usage usage_rows
            where usage_rows.run_id = runs.id
              and not exists (
                select 1 from ai_observations measurements
                where measurements.run_id = usage_rows.run_id
                  and measurements.kind = 'provider_request_measurement'
                  and measurements.emitting_task = usage_rows.task_id
                  and measurements.loop_iteration = usage_rows.loop_iteration
                  and measurements.attempt = usage_rows.attempt
                  and measurements.payload->>'providerRequestIndex' = usage_rows.provider_request_index::text
              )
              )
          or exists (
            select 1 from ai_observations measurements
            where measurements.run_id = runs.id
              and measurements.kind = 'provider_request_measurement'
              and not exists (
                select 1 from ai_run_usage usage_rows
                where usage_rows.run_id = measurements.run_id
                  and usage_rows.task_id = measurements.emitting_task
                  and usage_rows.loop_iteration = measurements.loop_iteration
                  and usage_rows.attempt = measurements.attempt
                  and measurements.payload->>'providerRequestIndex' = usage_rows.provider_request_index::text
              )
              and not (
                measurements.payload->>'passed' = 'true'
                and not exists (
                  select 1
                  from ai_observations output_rows
                  where output_rows.run_id = measurements.run_id
                    and output_rows.emitting_task = measurements.emitting_task
                    and output_rows.loop_iteration = measurements.loop_iteration
                    and output_rows.attempt = measurements.attempt
                    and output_rows.kind in (
                      'turn_plan', 'retrieval_manifest', 'context_measurement',
                      'context_decision', 'context_reducer_terminal', 'context_serialized',
                      'topic_packet', 'memory_extraction_result', 'answer_started',
                      'answer_delta', 'answer_completed'
                    )
                )
                and not exists (
                  select 1
                  from ai_run_events output_events
                  where output_events.run_id = measurements.run_id
                    and output_events.emitted_by_task = measurements.emitting_task
                    and output_events.event->>'type' = 'text_delta'
                    and output_events.emission_key ~ '^text_delta:[^:]+:[0-9]+:[0-9]+$'
                    and substring(output_events.emission_key from '[^:]+:([0-9]+):[0-9]+$') = measurements.attempt::text
                )
                and exists (
                  select 1
                  from ai_observations retry_measurements
                  join ai_run_usage retry_usage
                    on retry_usage.run_id = retry_measurements.run_id
                   and retry_usage.task_id = retry_measurements.emitting_task
                   and retry_usage.loop_iteration = retry_measurements.loop_iteration
                   and retry_usage.attempt = retry_measurements.attempt
                   and retry_usage.provider_request_index::text = retry_measurements.payload->>'providerRequestIndex'
                   and retry_usage.agent_role = retry_measurements.payload->>'agentRole'
                   and retry_usage.model_id = retry_measurements.payload->>'modelId'
                  where retry_measurements.run_id = measurements.run_id
                    and retry_measurements.kind = 'provider_request_measurement'
                    and retry_measurements.payload->>'passed' = 'true'
                    and (
                      retry_measurements.loop_iteration > measurements.loop_iteration
                      or (retry_measurements.loop_iteration = measurements.loop_iteration
                        and retry_measurements.attempt > measurements.attempt)
                    )
                )
                and not exists (
                  select 1
                  from ai_observations later_measurement
                  where later_measurement.run_id = measurements.run_id
                    and later_measurement.kind = 'provider_request_measurement'
                    and later_measurement.emitting_task = measurements.emitting_task
                    and later_measurement.loop_iteration = measurements.loop_iteration
                    and later_measurement.attempt = measurements.attempt
                    and later_measurement.id <> measurements.id
                    and later_measurement.payload->>'providerRequestIndex' ~ '^[0-9]+$'
                    and measurements.payload->>'providerRequestIndex' ~ '^[0-9]+$'
                    and (later_measurement.payload->>'providerRequestIndex')::numeric >
                      (measurements.payload->>'providerRequestIndex')::numeric
                )
                and not exists (
                  select 1
                  from ai_observations another
                  where another.run_id = measurements.run_id
                    and another.kind = 'provider_request_measurement'
                    and another.id <> measurements.id
                    and another.payload->>'passed' = 'true'
                    and not exists (
                      select 1
                      from ai_run_usage another_usage
                      where another_usage.run_id = another.run_id
                        and another_usage.task_id = another.emitting_task
                        and another_usage.loop_iteration = another.loop_iteration
                        and another_usage.attempt = another.attempt
                        and another_usage.provider_request_index::text = another.payload->>'providerRequestIndex'
                    )
                )
              )
          )
        )
      order by runs.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: successful run provider measurements and usage do not match',
        row_data.row_identity;
    end loop;

  for row_data in
      select runs.id::text as row_identity
      from ai_runs runs
      where runs.finished_at is not null
        and runs.failed_at is null
        and (
          not exists (
            select 1 from ai_observations extraction
            where extraction.run_id = runs.id and extraction.kind = 'memory_extraction_result'
          )
          or not exists (
            select 1 from ai_observations application
            where application.run_id = runs.id and application.kind = 'memory_application'
          )
        )
      order by runs.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: successful run memory lane is incomplete',
        row_data.row_identity;
    end loop;

  -- A finished, non-failed run is a successful durable answer.  Do not let a
  -- partial ledger reach the cutover: one route, terminal events, provider
  -- measurements and usage, selected-source exposure, and retrieval/source
  -- agreement must all be present before any helper or schema write.
  for row_data in
      select runs.id::text as row_identity
      from ai_runs runs
      where runs.finished_at is not null
        and runs.failed_at is null
        and (
          runs.assistant_message_id is null
          or (select count(*) from chat_messages assistants
              where assistants.id = runs.assistant_message_id
                and assistants.author = 'assistant') <> 1
          or (select count(*) from ai_observations plans
              where plans.run_id = runs.id and plans.kind = 'turn_plan') <> 1
          or exists (
            select 1
            from ai_observations plans
            where plans.run_id = runs.id
              and (
                (plans.payload->>'mode' = 'single' and not exists (
                  select 1 from ai_run_usage usage_rows
                  where usage_rows.run_id = runs.id and usage_rows.task_id = 'single-answer'
                ))
                or (plans.payload->>'mode' = 'fanout' and not exists (
                  select 1 from ai_run_usage usage_rows
                  where usage_rows.run_id = runs.id and usage_rows.task_id = 'fanout-synthesis'
                ))
              )
          )
          or exists (
            select 1
            from ai_observations plans
            join ai_run_usage usage_rows on usage_rows.run_id = runs.id
            where plans.run_id = runs.id
              and plans.kind = 'turn_plan'
              and (
                (plans.payload->>'mode' = 'clarify'
                  and usage_rows.task_id not in ('plan-turn', 'memory-extract'))
                or (plans.payload->>'mode' = 'single'
                  and usage_rows.task_id ~ '^(fanout-synthesis|topic-t[123]-)')
                or (plans.payload->>'mode' = 'fanout'
                  and usage_rows.task_id like 'single-%')
              )
          )
          or exists (
            select 1
            from ai_observations plans
            where plans.run_id = runs.id
              and plans.kind = 'turn_plan'
              and plans.payload->>'mode' = 'clarify'
              and (
                exists (
                  select 1 from assistant_message_source_uses uses
                  join assistant_message_sources sources
                    on sources.assistant_message_id = uses.assistant_message_id
                   and sources.source_key = uses.source_key
                  where uses.assistant_message_id = runs.assistant_message_id
                )
                or exists (
                  select 1 from ai_observations manifests
                  where manifests.run_id = runs.id and manifests.kind = 'retrieval_manifest'
                )
              )
          )
          or exists (
            select 1
            from ai_observations plans
            where plans.run_id = runs.id
              and plans.kind = 'turn_plan'
              and plans.payload->>'mode' in ('single', 'fanout')
              and (
                not exists (
                  select 1
                  from ai_observations measurements
                  where measurements.run_id = runs.id
                    and measurements.kind = 'context_measurement'
                    and (
                      (plans.payload->>'mode' = 'single' and measurements.emitting_task = 'single-answer')
                      or (plans.payload->>'mode' = 'fanout' and measurements.emitting_task = 'fanout-synthesis')
                    )
                )
                or not exists (
                  select 1
                  from ai_observations serialized
                  where serialized.run_id = runs.id
                    and serialized.kind = 'context_serialized'
                    and (
                      (plans.payload->>'mode' = 'single' and serialized.emitting_task = 'single-answer')
                      or (plans.payload->>'mode' = 'fanout' and serialized.emitting_task = 'fanout-synthesis')
                    )
                )
                or (select count(*) from ai_run_events events
                    where events.run_id = runs.id and events.event->>'type' = 'answer_started') < 1
                or (select count(*) from ai_run_events events
                    where events.run_id = runs.id and events.event->>'type' = 'text_delta') = 0
                or (select count(*) from ai_observations completions
                    where completions.run_id = runs.id and completions.kind = 'answer_completed') < 1
                or not exists (
                  select 1
                  from ai_run_events latest_start
                  join ai_run_events memory_events on memory_events.run_id = latest_start.run_id
                    and memory_events.event->>'type' = 'memory_updated'
                  where latest_start.run_id = runs.id
                    and latest_start.event->>'type' = 'answer_started'
                    and not exists (
                      select 1 from ai_run_events later_start
                      where later_start.run_id = latest_start.run_id
                        and later_start.event->>'type' = 'answer_started'
                        and later_start.seq > latest_start.seq
                    )
                    and latest_start.seq < memory_events.seq
                )
              )
          )
          or (select count(*) from ai_run_events events
              where events.run_id = runs.id and events.event->>'type' = 'run_started') <> 1
          or (select count(*) from ai_run_events events
              where events.run_id = runs.id and events.event->>'type' = 'done') <> 1
          or exists (
            select 1 from ai_run_events events
            where events.run_id = runs.id and events.event->>'type' = 'done'
              and events.event->>'assistantMessageId' is distinct from runs.assistant_message_id::text
          )
          or exists (
            select 1 from ai_run_events events
            where events.run_id = runs.id and events.event->>'type' = 'error'
          )
          or exists (
            select 1
            from ai_run_usage usage_rows
            where usage_rows.run_id = runs.id
              and usage_rows.task_id in ('plan-turn', 'memory-extract')
              and (
                not exists (
                  select 1
                  from ai_observations measurements
                  where measurements.run_id = usage_rows.run_id
                    and measurements.kind = 'provider_request_measurement'
                    and measurements.emitting_task = usage_rows.task_id
                    and measurements.loop_iteration = usage_rows.loop_iteration
                    and measurements.attempt = usage_rows.attempt
                    and measurements.payload->>'providerRequestIndex' = usage_rows.provider_request_index::text
                    and measurements.payload->>'passed' = 'true'
                )
                or (usage_rows.task_id = 'plan-turn' and not exists (
                  select 1
                  from ai_observations plans
                  where plans.run_id = usage_rows.run_id
                    and plans.kind = 'turn_plan'
                    and plans.emitting_task = usage_rows.task_id
                    and plans.loop_iteration = usage_rows.loop_iteration
                    and plans.attempt = usage_rows.attempt
                ))
                or (usage_rows.task_id = 'memory-extract' and not exists (
                  select 1
                  from ai_observations extractions
                  where extractions.run_id = usage_rows.run_id
                    and extractions.kind = 'memory_extraction_result'
                    and extractions.emitting_task = usage_rows.task_id
                    and extractions.loop_iteration = usage_rows.loop_iteration
                    and extractions.attempt = usage_rows.attempt
                ))
              )
          )
          or exists (
            select 1
            from ai_run_usage usage_rows
            where usage_rows.run_id = runs.id
              and not exists (
                select 1
                from ai_observations measurements
                where measurements.run_id = runs.id
                  and measurements.kind = 'provider_request_measurement'
                  and measurements.emitting_task = usage_rows.task_id
                  and measurements.loop_iteration = usage_rows.loop_iteration
                  and measurements.attempt = usage_rows.attempt
                  and measurements.payload->>'providerRequestIndex' = usage_rows.provider_request_index::text
                  and measurements.payload->>'agentRole' = usage_rows.agent_role
                  and (measurements.payload->>'inputTokens')::numeric =
                    (usage_rows.input_tokens + usage_rows.cached_tokens)::numeric
                  and (measurements.payload->>'requestedOutputTokens')::numeric >=
                    usage_rows.output_tokens::numeric
              )
          )
          or exists (
            select 1
            from ai_observations measurements
            where measurements.run_id = runs.id
              and measurements.kind = 'provider_request_measurement'
              and not exists (
                select 1
                from ai_run_usage usage_rows
                where usage_rows.run_id = runs.id
                  and usage_rows.task_id = measurements.emitting_task
                  and usage_rows.loop_iteration = measurements.loop_iteration
                  and usage_rows.attempt = measurements.attempt
                  and measurements.payload->>'providerRequestIndex' = usage_rows.provider_request_index::text
                  and measurements.payload->>'agentRole' = usage_rows.agent_role
                  and (measurements.payload->>'inputTokens')::numeric =
                    (usage_rows.input_tokens + usage_rows.cached_tokens)::numeric
                  and (measurements.payload->>'requestedOutputTokens')::numeric >=
                    usage_rows.output_tokens::numeric
              )
              and not (
                measurements.payload->>'passed' = 'true'
                and not exists (
                  select 1
                  from ai_observations output_rows
                  where output_rows.run_id = measurements.run_id
                    and output_rows.emitting_task = measurements.emitting_task
                    and output_rows.loop_iteration = measurements.loop_iteration
                    and output_rows.attempt = measurements.attempt
                    and output_rows.kind in (
                      'turn_plan', 'retrieval_manifest', 'context_measurement',
                      'context_decision', 'context_reducer_terminal', 'context_serialized',
                      'topic_packet', 'memory_extraction_result', 'answer_started',
                      'answer_delta', 'answer_completed'
                    )
                )
                and not exists (
                  select 1
                  from ai_run_events output_events
                  where output_events.run_id = measurements.run_id
                    and output_events.emitted_by_task = measurements.emitting_task
                    and output_events.event->>'type' = 'text_delta'
                    and output_events.emission_key ~ '^text_delta:[^:]+:[0-9]+:[0-9]+$'
                    and substring(output_events.emission_key from '[^:]+:([0-9]+):[0-9]+$') = measurements.attempt::text
                )
                and exists (
                  select 1
                  from ai_observations retry_measurements
                  join ai_run_usage retry_usage
                    on retry_usage.run_id = retry_measurements.run_id
                   and retry_usage.task_id = retry_measurements.emitting_task
                   and retry_usage.loop_iteration = retry_measurements.loop_iteration
                   and retry_usage.attempt = retry_measurements.attempt
                   and retry_usage.provider_request_index::text = retry_measurements.payload->>'providerRequestIndex'
                   and retry_usage.agent_role = retry_measurements.payload->>'agentRole'
                   and retry_usage.model_id = retry_measurements.payload->>'modelId'
                  where retry_measurements.run_id = measurements.run_id
                    and retry_measurements.kind = 'provider_request_measurement'
                    and retry_measurements.payload->>'passed' = 'true'
                    and (
                      retry_measurements.loop_iteration > measurements.loop_iteration
                      or (retry_measurements.loop_iteration = measurements.loop_iteration
                        and retry_measurements.attempt > measurements.attempt)
                    )
                )
                and not exists (
                  select 1
                  from ai_observations later_measurement
                  where later_measurement.run_id = measurements.run_id
                    and later_measurement.kind = 'provider_request_measurement'
                    and later_measurement.emitting_task = measurements.emitting_task
                    and later_measurement.loop_iteration = measurements.loop_iteration
                    and later_measurement.attempt = measurements.attempt
                    and later_measurement.id <> measurements.id
                    and later_measurement.payload->>'providerRequestIndex' ~ '^[0-9]+$'
                    and measurements.payload->>'providerRequestIndex' ~ '^[0-9]+$'
                    and (later_measurement.payload->>'providerRequestIndex')::numeric >
                      (measurements.payload->>'providerRequestIndex')::numeric
                )
                )
                and not exists (
                  select 1
                  from ai_observations another
                  where another.run_id = measurements.run_id
                    and another.kind = 'provider_request_measurement'
                    and another.id <> measurements.id
                    and another.payload->>'passed' = 'true'
                    and not exists (
                      select 1
                      from ai_run_usage another_usage
                      where another_usage.run_id = another.run_id
                        and another_usage.task_id = another.emitting_task
                        and another_usage.loop_iteration = another.loop_iteration
                        and another_usage.attempt = another.attempt
                        and another_usage.provider_request_index::text = another.payload->>'providerRequestIndex'
                    )
                )
              )
          or exists (
            select 1
            from ai_run_usage usage_rows
            where usage_rows.run_id = runs.id
              and not exists (
                select 1
                from ai_run_events usage_events
                where usage_events.run_id = runs.id
                  and usage_events.event->>'type' = 'usage'
                  and usage_events.event->>'scope' = 'request'
                  and usage_events.event->>'kind' = 'model'
                  and usage_events.emission_key = format(
                    'usage:request:model:%s:%s:%s:%s',
                    usage_rows.task_id, usage_rows.loop_iteration,
                    usage_rows.attempt, usage_rows.provider_request_index
                  )
              )
          )
          or exists (
            select 1
            from assistant_message_source_uses uses
            join assistant_message_sources sources
              on sources.assistant_message_id = uses.assistant_message_id
             and sources.source_key = uses.source_key
            where uses.assistant_message_id = runs.assistant_message_id
              and not exists (
                select 1
                from ai_observations serialized
                where serialized.run_id = runs.id
                  and serialized.kind = 'context_serialized'
                  and serialized.payload->'sourceKeys' ? uses.source_key
                  and exists (
                    select 1
                    from jsonb_array_elements(serialized.payload->'restrictedContextLedger'->'sources') selected(value)
                    where selected.value->>'sourceKey' = uses.source_key
                  )
              )
          )
          or (select string_agg(events.event->>'delta', '' order by events.seq)
              from ai_run_events events
              where events.run_id = runs.id and events.event->>'type' = 'text_delta'
                and substring(events.emission_key from '[^:]+:([0-9]+):[0-9]+$') = (
                  select max((starts.event->>'attempt')::numeric)::text
                  from ai_run_events starts
                  where starts.run_id = runs.id and starts.event->>'type' = 'answer_started'
                )) is distinct from
             (select assistants.content
              from chat_messages assistants
              where assistants.id = runs.assistant_message_id)
          or exists (
            select 1
            from assistant_message_source_uses uses
            join assistant_message_sources sources
              on sources.assistant_message_id = uses.assistant_message_id
             and sources.source_key = uses.source_key
            where uses.assistant_message_id = runs.assistant_message_id
              and not exists (
                select 1
                from ai_observations manifests
                cross join lateral jsonb_array_elements(
                  case when jsonb_typeof(manifests.payload->'references') = 'array'
                    then manifests.payload->'references' else '[]'::jsonb end
                ) refs(value)
                where manifests.run_id = runs.id
                  and manifests.kind = 'retrieval_manifest'
                  and (
                    (sources.kind = 'memory'
                      and refs.value->>'memoryId' = sources.locator->>'memoryId'
                      and refs.value->>'memoryRevisionId' = sources.locator->>'memoryRevisionId')
                    or (sources.kind = 'chat_message'
                      and refs.value->>'messageId' = sources.locator->>'messageId')
                    or (sources.kind = 'document'
                      and refs.value->>'documentId' = sources.locator->>'documentId'
                      and refs.value->>'versionId' = coalesce(
                        sources.locator->>'versionId', sources.locator->>'versionId'))
                    or (sources.kind = 'web'
                      and refs.value->>'url' = sources.locator->>'url')
                  )
              )
          )
          or exists (
            select 1
            from assistant_message_source_uses uses
            join assistant_message_sources sources
              on sources.assistant_message_id = uses.assistant_message_id
             and sources.source_key = uses.source_key
            where uses.assistant_message_id = runs.assistant_message_id
              and not exists (
                select 1
                from ai_source_exposures exposures
                where exposures.run_id = runs.id
                  and exposures.task_id = case
                    when uses.consumer_task_id = 'single-answer' then
                      case sources.kind
                        when 'memory' then 'single-select-memories'
                        when 'web' then 'single-retrieve-web'
                        else 'single-retrieve-internal'
                      end
                    when uses.consumer_task_id like 'topic-t%-answer' then
                      'topic-' || substring(uses.consumer_task_id from 7 for 2) || '-' || case sources.kind
                        when 'memory' then 'select-memories'
                        when 'web' then 'retrieve-web'
                        else 'retrieve-internal'
                      end
                    else null
                  end
                  and exposures.source_kind = sources.kind
                  and exists (
                    select 1
                    from ai_observations manifests
                    where manifests.run_id = runs.id
                      and manifests.kind = 'retrieval_manifest'
                      and manifests.emitting_task = case
                        when uses.consumer_task_id = 'single-answer' then
                          case sources.kind
                            when 'memory' then 'single-select-memories'
                            when 'web' then 'single-retrieve-web'
                            else 'single-retrieve-internal'
                          end
                        when uses.consumer_task_id like 'topic-t%-answer' then
                          'topic-' || substring(uses.consumer_task_id from 7 for 2) || '-' || case sources.kind
                            when 'memory' then 'select-memories'
                            when 'web' then 'retrieve-web'
                            else 'retrieve-internal'
                          end
                        else null
                      end
                      and manifests.loop_iteration = exposures.loop_iteration
                      and manifests.attempt = exposures.attempt
                  )
                  and exists (
                    select 1
                    from ai_observations measurements
                    where measurements.run_id = exposures.run_id
                      and measurements.kind = 'provider_request_measurement'
                      and measurements.emitting_task = exposures.task_id
                      and measurements.loop_iteration = exposures.loop_iteration
                      and measurements.attempt = exposures.attempt
                      and measurements.payload->>'providerRequestIndex' = exposures.provider_request_index::text
                      and measurements.payload->>'passed' = 'true'
                  )
                  and (
                    (sources.kind = 'memory'
                      and exposures.logical_source_identity = 'memory:' || (sources.locator->>'memoryId')
                      and exposures.content_item_identity = sources.locator->>'memoryRevisionId')
                    or (sources.kind = 'chat_message'
                      and exposures.logical_source_identity = 'chat_message:' || (sources.locator->>'messageId')
                      and exposures.content_item_identity = sources.locator->>'messageId')
                    or (sources.kind = 'web'
                      and exposures.logical_source_identity = 'web:' || (sources.locator->>'url') || ':' || (sources.locator->>'quoteHash')
                      and exposures.content_item_identity = (sources.locator->>'url') || ':' || (sources.locator->>'quoteHash'))
                    or (sources.kind = 'document'
                      and exposures.document_source_id = sources.locator->>'sourceId'
                      and exposures.document_id = sources.locator->>'documentId'
                      and coalesce(to_jsonb(exposures)->>'document_version_id', to_jsonb(exposures)->>'version_id') =
                        coalesce(sources.locator->>'versionId', sources.locator->>'versionId')
                      and coalesce(to_jsonb(exposures)->>'document_content_hash', to_jsonb(exposures)->>'content_hash') =
                        sources.locator->>'contentHash'
                      and (exposures.exposure_stage <> 'answer_serialized'
                        or exposures.document_ranges is not distinct from uses.ranges)
                      and (
                        sources.locator->>'publisherExtractionId' is null
                        or to_jsonb(exposures)->>'publisher_extraction_id' = sources.locator->>'publisherExtractionId'
                      )
                    )
                  )
              )
          )
          or exists (
            select 1
            from assistant_message_source_uses uses
            join assistant_message_sources sources
              on sources.assistant_message_id = uses.assistant_message_id
             and sources.source_key = uses.source_key
            where uses.assistant_message_id = runs.assistant_message_id
              and not exists (
                select 1
                from ai_observations serialized
                where serialized.run_id = runs.id
                  and serialized.kind = 'context_serialized'
                  and serialized.payload->'sourceKeys' ? uses.source_key
                  and exists (
                    select 1
                    from jsonb_array_elements(serialized.payload->'restrictedContextLedger'->'sources') selected(value)
                    where selected.value->>'sourceKey' = uses.source_key
                  )
                  and exists (
                    select 1
                    from ai_source_exposures exposures
                    where exposures.run_id = runs.id
                      and exposures.task_id = serialized.payload->'terminalUsageCoordinate'->>'taskId'
                      and serialized.payload->'terminalUsageCoordinate'->>'loopIteration' ~ '^[0-9]+$'
                      and serialized.payload->'terminalUsageCoordinate'->>'attempt' ~ '^[0-9]+$'
                      and serialized.payload->'terminalUsageCoordinate'->>'providerRequestIndex' ~ '^[0-9]+$'
                      and exposures.loop_iteration::numeric = (serialized.payload->'terminalUsageCoordinate'->>'loopIteration')::numeric
                      and exposures.attempt::numeric = (serialized.payload->'terminalUsageCoordinate'->>'attempt')::numeric
                      and exposures.provider_request_index::numeric = (serialized.payload->'terminalUsageCoordinate'->>'providerRequestIndex')::numeric
                      and exposures.source_kind = sources.kind
                      and (
                        (sources.kind = 'memory'
                          and exposures.logical_source_identity = 'memory:' || (sources.locator->>'memoryId')
                          and exposures.content_item_identity = sources.locator->>'memoryRevisionId')
                        or (sources.kind = 'chat_message'
                          and exposures.logical_source_identity = 'chat_message:' || (sources.locator->>'messageId')
                          and exposures.content_item_identity = sources.locator->>'messageId')
                        or (sources.kind = 'web'
                          and exposures.logical_source_identity = 'web:' || (sources.locator->>'url') || ':' || (sources.locator->>'quoteHash')
                          and exposures.content_item_identity = (sources.locator->>'url') || ':' || (sources.locator->>'quoteHash'))
                        or (sources.kind = 'document'
                          and exposures.document_source_id = sources.locator->>'sourceId'
                          and exposures.document_id = sources.locator->>'documentId'
                          and coalesce(to_jsonb(exposures)->>'document_version_id', to_jsonb(exposures)->>'version_id') =
                            coalesce(sources.locator->>'versionId', sources.locator->>'versionId')
                          and coalesce(to_jsonb(exposures)->>'document_content_hash', to_jsonb(exposures)->>'content_hash') =
                            sources.locator->>'contentHash'
                          and exposures.document_ranges is not distinct from uses.ranges
                          and (
                            sources.locator->>'publisherExtractionId' is null
                            or to_jsonb(exposures)->>'publisher_extraction_id' = sources.locator->>'publisherExtractionId'
                          ))
                      )
                      and exists (
                        select 1
                        from ai_observations attestations
                        where attestations.run_id = runs.id
                          and attestations.emitting_task = exposures.task_id
                          and attestations.loop_iteration = exposures.loop_iteration
                          and attestations.attempt = exposures.attempt
                          and attestations.kind = 'source_exposure_attestation'
                          and attestations.payload->>'providerRequestIndex' = exposures.provider_request_index::text
                          and attestations.payload->>'sourceKind' = exposures.source_kind
                          and attestations.payload->>'logicalSourceIdentity' = exposures.logical_source_identity
                          and attestations.payload->>'contentItemIdentity' = exposures.content_item_identity
                          and attestations.payload->>'exposureStage' = exposures.exposure_stage
                          and exists (
                            select 1
                            from ai_observations measurements
                            where measurements.run_id = runs.id
                              and measurements.emitting_task = exposures.task_id
                              and measurements.loop_iteration = exposures.loop_iteration
                              and measurements.attempt = exposures.attempt
                              and measurements.kind = 'provider_request_measurement'
                              and measurements.payload->>'providerRequestIndex' = exposures.provider_request_index::text
                              and measurements.payload->>'requestSha256Hex' = attestations.payload->>'providerRequestSha256Hex'
                              and exists (
                                select 1
                                from jsonb_array_elements_text(case when jsonb_typeof(measurements.payload->'sourceExposureProofSha256Hexes') = 'array'
                                  then measurements.payload->'sourceExposureProofSha256Hexes' else '[]'::jsonb end) proof(value)
                                where proof.value = attestations.payload->>'providerSerializationProofSha256Hex'
                              )
                          )
                      )
                  )
              )
          )
          or exists (
            select 1
            from ai_observations manifests
            cross join lateral jsonb_array_elements(
              case when jsonb_typeof(manifests.payload->'references') = 'array'
                then manifests.payload->'references' else '[]'::jsonb end
            ) refs(value)
            where manifests.run_id = runs.id
              and manifests.kind = 'retrieval_manifest'
              and not exists (
                select 1
                from ai_observations later
                where later.run_id = manifests.run_id
                  and later.kind = 'retrieval_manifest'
                  and later.emitting_task = manifests.emitting_task
                  and (later.loop_iteration > manifests.loop_iteration
                    or (later.loop_iteration = manifests.loop_iteration
                      and later.attempt > manifests.attempt))
              )
              -- A terminal manifest can contain a selector candidate that O
              -- explicitly omitted or reduced.  Such a reference is not a
              -- retained source use; the context-decision reconciliation
              -- below validates the exact final projection.
              and not exists (
                select 1
                from ai_observations decisions
                cross join lateral jsonb_array_elements(
                  case when jsonb_typeof(decisions.payload->'decisions') = 'array'
                    then decisions.payload->'decisions' else '[]'::jsonb end
                ) decisions_set(value)
                join lateral (
                  select measurements.payload
                  from ai_observations measurements
                  where measurements.run_id = decisions.run_id
                    and measurements.kind = 'context_measurement'
                    and measurements.emitting_task in (
                      case
                        when decisions.emitting_task = 'single-reduce-measure' then 'single-measure'
                        when decisions.emitting_task ~ '^topic-t[123]-reduce-measure$'
                          then regexp_replace(decisions.emitting_task, '-reduce-measure$', '-measure')
                        else decisions.emitting_task
                      end,
                      decisions.emitting_task
                    )
                    and (
                      measurements.loop_iteration < decisions.loop_iteration
                      or (measurements.loop_iteration = decisions.loop_iteration
                        and measurements.attempt < decisions.attempt)
                      or (
                        measurements.loop_iteration = decisions.loop_iteration
                        and measurements.attempt = decisions.attempt
                        and not exists (
                          select 1
                          from ai_observations earlier
                          where earlier.run_id = decisions.run_id
                            and earlier.kind = 'context_measurement'
                            and earlier.emitting_task in (
                              case
                                when decisions.emitting_task = 'single-reduce-measure' then 'single-measure'
                                when decisions.emitting_task ~ '^topic-t[123]-reduce-measure$'
                                  then regexp_replace(decisions.emitting_task, '-reduce-measure$', '-measure')
                                else decisions.emitting_task
                              end,
                              decisions.emitting_task
                            )
                            and (earlier.loop_iteration < decisions.loop_iteration
                              or (earlier.loop_iteration = decisions.loop_iteration
                                and earlier.attempt < decisions.attempt))
                        )
                      )
                    )
                  order by measurements.loop_iteration desc, measurements.attempt desc,
                           case when not exists (
                             select 1
                             from ai_observations prior_decisions
                             where prior_decisions.run_id = decisions.run_id
                               and prior_decisions.kind = 'context_decision'
                               and prior_decisions.emitting_task = decisions.emitting_task
                               and (prior_decisions.loop_iteration < decisions.loop_iteration
                                 or (prior_decisions.loop_iteration = decisions.loop_iteration
                                   and (prior_decisions.attempt < decisions.attempt
                                     or (prior_decisions.attempt = decisions.attempt
                                       and prior_decisions.id < decisions.id))))
                           )
                             and measurements.emitting_task = case
                               when decisions.emitting_task = 'single-reduce-measure' then 'single-measure'
                               when decisions.emitting_task ~ '^topic-t[123]-reduce-measure$'
                                 then regexp_replace(decisions.emitting_task, '-reduce-measure$', '-measure')
                               else decisions.emitting_task
                             end then 0 else 1 end,
                           measurements.created_at desc, measurements.id desc
                  limit 1
                ) measurements on true
                cross join lateral jsonb_array_elements(
                  case when jsonb_typeof(measurements.payload->'restrictedContextLedger'->'sources') = 'array'
                    then measurements.payload->'restrictedContextLedger'->'sources' else '[]'::jsonb end
                ) candidates(value)
                where decisions.run_id = runs.id
                  and decisions.kind = 'context_decision'
                  and decisions.payload->>'valid' = 'true'
                  and decisions_set.value->>'id' = candidates.value->>'candidateId'
                  and decisions_set.value->>'action' = 'omit'
                  and (
                    (candidates.value->>'kind' = 'memory'
                      and candidates.value->>'candidateId' in (
                        refs.value->>'memoryId', 'memory:' || (refs.value->>'memoryId')))
                    or (candidates.value->>'kind' = 'chat_message'
                      and candidates.value->>'candidateId' in (
                        refs.value->>'messageId', 'chat_message:' || (refs.value->>'messageId')))
                    or (candidates.value->>'kind' = 'web'
                      and candidates.value->>'candidateId' = 'web:' || (refs.value->>'url') || ':' ||
                        translate(
                          rtrim(encode(digest(convert_to(refs.value->>'quote', 'UTF8'), 'sha256'), 'base64'), '='),
                          '+/', '-_'
                        ))
                    or (candidates.value->>'kind' = 'document'
                      and candidates.value->>'candidateId' = case
                        when refs.value->'source'->>'kind' = 'public' then
                          'document:namespace:public:' || json_build_array(
                            refs.value->'source'->>'sourceId', refs.value->>'documentId'
                          )::text
                        when refs.value->'source'->>'kind' = 'publisher' then
                          'document:namespace:publisher:' || json_build_array(
                            refs.value->'source'->>'sourceId',
                            refs.value->'source'->>'issueId',
                            refs.value->'source'->>'documentId',
                            refs.value->>'documentId'
                          )::text
                        else null end)
                  )
              )
              and not exists (
                select 1
                from ai_observations rejected
                where rejected.run_id = runs.id
                  and rejected.kind = 'candidate_rejected'
                  and (
                    rejected.emitting_task = manifests.emitting_task
                    or rejected.emitting_task = case
                      when manifests.emitting_task in (
                        'single-retrieve-internal', 'single-select-memories', 'single-retrieve-web'
                      ) then 'single-assemble'
                      when manifests.emitting_task ~ '^topic-t[123]-'
                        then substring(manifests.emitting_task from '^topic-t[123]') || '-assemble'
                      else null
                    end
                  )
                  and rejected.loop_iteration = manifests.loop_iteration
                  and rejected.attempt = manifests.attempt
                  and rejected.payload->>'reason' in (
                    'inaccessible', 'missing', 'invalid_range', 'ambiguous_provenance',
                    'duplicate', 'overlap_merged'
                  )
                  and rejected.payload->>'candidateId' in (
                    refs.value->>'candidateId',
                    refs.value->>'sourceKey',
                    case when refs.value ? 'memoryId' then
                      'memory:' || (refs.value->>'memoryId') || ':' || (refs.value->>'memoryRevisionId')
                    else null end,
                    case when refs.value ? 'messageId' then
                      'chat_message:' || (refs.value->>'messageId')
                    else null end,
                    case when refs.value ? 'url' then
                      'web:' || (refs.value->>'url') || ':' || translate(
                        rtrim(encode(digest(convert_to(refs.value->>'quote', 'UTF8'), 'sha256'), 'base64'), '='),
                        '+/', '-_'
                      )
                    else null end,
                    case when refs.value->'source'->>'kind' = 'public' then
                      'document:namespace:public:' || json_build_array(
                        refs.value->'source'->>'sourceId', refs.value->>'documentId'
                      )::text || ':' || (refs.value->>'versionId')
                    when refs.value->'source'->>'kind' = 'publisher' then
                      'document:namespace:publisher:' || json_build_array(
                        refs.value->'source'->>'sourceId', refs.value->'source'->>'issueId',
                        refs.value->'source'->>'documentId', refs.value->>'documentId'
                      )::text || ':' || (refs.value->>'versionId')
                    else null end
                  )
                  and not exists (
                    select 1
                    from ai_observations later_rejected
                    where later_rejected.run_id = rejected.run_id
                      and later_rejected.kind = 'candidate_rejected'
                      and later_rejected.emitting_task = rejected.emitting_task
                      and later_rejected.payload->>'candidateId' = rejected.payload->>'candidateId'
                      and (
                        later_rejected.loop_iteration > rejected.loop_iteration
                        or (later_rejected.loop_iteration = rejected.loop_iteration
                          and (later_rejected.attempt > rejected.attempt
                            or (later_rejected.attempt = rejected.attempt and later_rejected.id > rejected.id)))
                      )
                  )
              )
              and not exists (
                select 1
                from assistant_message_source_uses uses
                join assistant_message_sources sources
                  on sources.assistant_message_id = uses.assistant_message_id
                 and sources.source_key = uses.source_key
                where uses.assistant_message_id = runs.assistant_message_id
                  and (
                    (uses.consumer_task_id = 'single-answer'
                      and manifests.emitting_task = case sources.kind
                        when 'memory' then 'single-select-memories'
                        when 'web' then 'single-retrieve-web'
                        else 'single-retrieve-internal' end)
                    or (uses.consumer_task_id like 'topic-t%-answer'
                      and manifests.emitting_task = 'topic-' || substring(uses.consumer_task_id from 7 for 2) || '-' || case sources.kind
                        when 'memory' then 'select-memories'
                        when 'web' then 'retrieve-web'
                        else 'retrieve-internal' end)
                    or (
                      (
                        uses.consumer_task_id = 'single-answer'
                        or uses.consumer_task_id ~ '^topic-t[123]-answer$'
                      )
                      and manifests.emitting_task = 'evaluation-general-planner'
                      and exists (
                        select 1
                        from ai_observations evaluation_plans
                        where evaluation_plans.run_id = runs.id
                          and evaluation_plans.kind = 'turn_plan'
                          and evaluation_plans.emitting_task = 'evaluation-general-planner'
                      )
                    )
                  )
                  and (
                    (sources.kind = 'memory'
                      and refs.value->>'memoryId' = sources.locator->>'memoryId'
                      and refs.value->>'memoryRevisionId' = sources.locator->>'memoryRevisionId')
                    or (sources.kind = 'chat_message'
                      and refs.value->>'messageId' = sources.locator->>'messageId')
                    or (sources.kind = 'document'
                      and refs.value->>'documentId' = sources.locator->>'documentId'
                      and refs.value->>'versionId' = coalesce(sources.locator->>'versionId', sources.locator->>'versionId')
                      and (
                        refs.value->'ranges' is not distinct from sources.locator->'ranges'
                        or exists (
                          select 1
                          from ai_observations decisions
                          cross join lateral jsonb_array_elements(
                            case when jsonb_typeof(decisions.payload->'decisions') = 'array'
                              then decisions.payload->'decisions' else '[]'::jsonb end
                          ) decisions_set(value)
                          where decisions.run_id = runs.id
                            and decisions.kind = 'context_decision'
                            and decisions.payload->>'valid' = 'true'
                            and decisions_set.value->>'action' = 'range'
                            and decisions_set.value->'ranges' is not distinct from uses.ranges
                            and exists (
                              select 1
                              from ai_observations measurements
                              cross join lateral jsonb_array_elements(
                                case when jsonb_typeof(measurements.payload->'restrictedContextLedger'->'sources') = 'array'
                                  then measurements.payload->'restrictedContextLedger'->'sources' else '[]'::jsonb end
                              ) candidates(value)
                              where measurements.run_id = decisions.run_id
                                and measurements.kind = 'context_measurement'
                                and measurements.emitting_task in (
                                  case
                                    when decisions.emitting_task = 'single-reduce-measure' then 'single-measure'
                                    when decisions.emitting_task ~ '^topic-t[123]-reduce-measure$'
                                      then regexp_replace(decisions.emitting_task, '-reduce-measure$', '-measure')
                                    else decisions.emitting_task
                                  end,
                                  decisions.emitting_task
                                )
                                and candidates.value->>'sourceKey' = sources.source_key
                                and decisions_set.value->>'id' = candidates.value->>'candidateId'
                            )
                        )
                      )
                      and refs.value->>'purpose' is not null
                      and refs.value->'source' = case
                        when sources.locator->>'sourceId' like 'public:%' then jsonb_build_object(
                          'kind', 'public', 'sourceId', sources.locator->>'sourceId'
                        )
                        else jsonb_build_object(
                          'kind', 'publisher', 'sourceId', sources.locator->>'sourceId',
                          'issueId', sources.locator->>'publisherIssueId',
                          'documentId', sources.locator->>'publisherDocumentId'
                        )
                      end
                      and (
                        (sources.locator->>'sourceId' like 'public:%'
                          and not (refs.value ? 'publisherExtractionId'))
                        or (sources.locator->>'sourceId' like 'publisher:%'
                          and refs.value->>'publisherExtractionId' = coalesce(
                            sources.locator->>'publisherExtractionId',
                            (
                              select extractions.id::text
                              from brief_document_versions versions
                              join brief_documents documents on documents.id = versions.brief_document_id
                              join brief_document_extractions extractions
                                on extractions.brief_document_id = documents.id
                               and extractions.input_sha256_hex = documents.sha256_hex
                              where versions.id::text = coalesce(
                                to_jsonb(sources)->>'document_version_id',
                                to_jsonb(sources)->>'version_id',
                                sources.locator->>'versionId',
                                sources.locator->>'versionId'
                              )
                            )
                          ))
                      )
                    or (sources.kind = 'web'
                      and refs.value->>'url' = sources.locator->>'url'
                      and refs.value->>'title' = sources.locator->>'title'
                      and refs.value->>'domain' = sources.locator->>'domain'
                      and refs.value->>'quote' = sources.locator->>'quote'
                      and refs.value->>'capturedAt' = sources.locator->>'capturedAt'
                      and refs.value->>'publishedAt' is not distinct from sources.locator->>'publishedAt'
                      and translate(
                        rtrim(encode(digest(convert_to(refs.value->>'quote', 'UTF8'), 'sha256'), 'base64'), '='),
                        '+/', '-_'
                      ) = sources.locator->>'quoteHash')
                  )
              )
          )
        ))
      order by runs.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: successful run terminal ledger is incomplete or incoherent',
        row_data.row_identity;
    end loop;

  -- publicProvenance is persisted evidence, not optional display data.  The
  -- saved-answer decoder needs a closed object and a publisher route that
  -- names the exact private issue/document tuple.
  for row_data in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
             sources.kind,
             sources.locator,
             sources.public_provenance
      from assistant_message_sources sources
      order by sources.assistant_message_id, sources.source_key
    loop
      if jsonb_typeof(row_data.public_provenance) is distinct from 'object'
        or exists (
          select 1 from jsonb_object_keys(case when jsonb_typeof(row_data.public_provenance) = 'object'
            then row_data.public_provenance else '{}'::jsonb end) key
          where key not in ('sourceName', 'issueTitle', 'documentTitle', 'citationUrl', 'publishedAt')
        )
        or exists (
          select 1
          from jsonb_each(case when jsonb_typeof(row_data.public_provenance) = 'object'
            then row_data.public_provenance else '{}'::jsonb end) entries(key, value)
          where jsonb_typeof(entries.value) is distinct from 'string'
        )
        or (row_data.kind = 'document' and (
          jsonb_typeof(row_data.public_provenance->'documentTitle') is distinct from 'string'
          or coalesce(btrim(row_data.public_provenance->>'documentTitle'), '') = ''
          or jsonb_typeof(row_data.public_provenance->'citationUrl') is distinct from 'string'
          or coalesce(btrim(row_data.public_provenance->>'citationUrl'), '') = ''
        ))
        or (row_data.kind = 'document' and row_data.locator->>'sourceId' like 'publisher:%' and (
          jsonb_typeof(row_data.public_provenance->'sourceName') is distinct from 'string'
          or coalesce(btrim(row_data.public_provenance->>'sourceName'), '') = ''
          or jsonb_typeof(row_data.public_provenance->'issueTitle') is distinct from 'string'
          or coalesce(btrim(row_data.public_provenance->>'issueTitle'), '') = ''
          or jsonb_typeof(row_data.public_provenance->'publishedAt') is distinct from 'string'
          or coalesce(btrim(row_data.public_provenance->>'publishedAt'), '') = ''
          or row_data.public_provenance->>'publishedAt' !~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
          or case when row_data.public_provenance->>'publishedAt' ~
              '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
            then substring(row_data.public_provenance->>'publishedAt' from 6 for 2)::integer not between 1 and 12
              or substring(row_data.public_provenance->>'publishedAt' from 9 for 2)::integer not between 1 and 31
              or substring(row_data.public_provenance->>'publishedAt' from 12 for 2)::integer not between 0 and 23
              or substring(row_data.public_provenance->>'publishedAt' from 15 for 2)::integer not between 0 and 59
              or substring(row_data.public_provenance->>'publishedAt' from 18 for 2)::integer not between 0 and 59
            else false end
          or exists (
            select 1
            from jsonb_object_keys(row_data.public_provenance) key
            where key not in ('sourceName', 'issueTitle', 'documentTitle', 'citationUrl', 'publishedAt')
          )
          or exists (
            select 1
            from unnest(array['sourceName', 'issueTitle', 'documentTitle', 'citationUrl', 'publishedAt']) required(key)
            where not jsonb_exists(row_data.public_provenance, required.key)
          )
          or row_data.public_provenance->>'citationUrl' <> format(
            '/v1/issues/%s/documents/%s/content',
            row_data.locator->>'publisherIssueId', row_data.locator->>'publisherDocumentId'
          )
        )) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: public provenance is not a closed canonical record',
          row_data.row_identity;
      end if;
    end loop;

  -- Non-document sources never carry document provenance. Web evidence keeps
  -- its exact canonical URL in publicProvenance, and public documents bind
  -- that URL to the immutable public document row.
  for row_data in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
             sources.kind, sources.locator, sources.public_provenance
      from assistant_message_sources sources
      where (sources.kind in ('chat_message', 'memory')
        and (
          jsonb_typeof(sources.public_provenance) is distinct from 'object'
          or sources.public_provenance <> '{}'::jsonb
        ))
        or (sources.kind = 'web' and (
          jsonb_typeof(sources.public_provenance) is distinct from 'object'
          or exists (
            select 1 from jsonb_object_keys(sources.public_provenance) key
            where key <> 'citationUrl'
          )
          or exists (
            select 1 from jsonb_each(sources.public_provenance) entries(key, value)
            where jsonb_typeof(entries.value) is distinct from 'string'
          )
          or jsonb_typeof(sources.public_provenance->'citationUrl') is distinct from 'string'
          or coalesce(btrim(sources.public_provenance->>'citationUrl'), '') = ''
          or sources.public_provenance->>'citationUrl' <> sources.locator->>'url'
          or sources.locator->>'url' <> btrim(sources.locator->>'url')
          or sources.locator->>'url' ~ '[[:cntrl:]]'
          or sources.locator->>'url' ~ '[^ -~]'
          or sources.locator->>'url' !~ '^https://[^[:space:]]+$'
          or substring(sources.locator->>'url' from '^https://([^/:?#]+)') is null
          or substring(sources.locator->>'url' from '^https://([^/:?#]+)') <>
            lower(substring(sources.locator->>'url' from '^https://([^/:?#]+)'))
          or not brief_public_source_https_url_allowed(sources.locator->>'url')
          or length(substring(sources.locator->>'url' from '^https://([^/:?#]+)')) > 253
          or substring(sources.locator->>'url' from '^https://([^/:?#]+)') in ('localhost')
          or substring(sources.locator->>'url' from '^https://([^/:?#]+)') like '%.localhost'
          or substring(sources.locator->>'url' from '^https://([^/:?#]+)') like '%.local'
          or substring(sources.locator->>'url' from '^https://([^/:?#]+)') like '%.localdomain'
          or substring(sources.locator->>'url' from '^https://([^/:?#]+)') like '%.internal'
          or substring(sources.locator->>'url' from '^https://([^/:?#]+)') like '%.corp'
          or substring(sources.locator->>'url' from '^https://([^/:?#]+)') like '%.lan'
          or substring(sources.locator->>'url' from '^https://([^/:?#]+)') like '%.home'
          or substring(sources.locator->>'url' from '^https://([^/:?#]+)') like '%.home.arpa'
          or substring(sources.locator->>'url' from '^https://([^/:?#]+)') ~* E'^((0x[0-9a-f]+|[0-9]+)(\\.(0x[0-9a-f]+|[0-9]+)){0,3})$'
          or position('@' in substring(sources.locator->>'url' from '^https://([^/?#]+)')) > 0
          or position(':' in substring(sources.locator->>'url' from '^https://([^/?#]+)')) > 0
          or sources.locator->>'url' ~ '^https://[^/?#]+(?:$|[?#])'
          or position(chr(34) in sources.locator->>'url') > 0
          or position('<' in sources.locator->>'url') > 0
          or position('>' in sources.locator->>'url') > 0
          or split_part(split_part(sources.locator->>'url', '?', 1), '#', 1) ~* '(^|/)(\.{1,2}|%2e(?:%2e)?|\.%2e|%2e\.)(/|$)'
          or position('^' in split_part(split_part(sources.locator->>'url', '?', 1), '#', 1)) > 0
          or position(chr(96) in split_part(split_part(sources.locator->>'url', '?', 1), '#', 1)) > 0
          or position('{' in split_part(split_part(sources.locator->>'url', '?', 1), '#', 1)) > 0
          or position('}' in split_part(split_part(sources.locator->>'url', '?', 1), '#', 1)) > 0
          or position(chr(92) in split_part(split_part(sources.locator->>'url', '?', 1), '#', 1)) > 0
          or position(chr(39) in case
            when position('?' in split_part(sources.locator->>'url', '#', 1)) > 0 then
              substring(
                split_part(sources.locator->>'url', '#', 1)
                from position('?' in split_part(sources.locator->>'url', '#', 1)) + 1
              )
            else ''
          end) > 0
          or position(chr(96) in case
            when position('#' in sources.locator->>'url') > 0 then
              substring(sources.locator->>'url' from position('#' in sources.locator->>'url') + 1)
            else ''
          end) > 0
        ))
        or (sources.kind = 'document' and sources.locator->>'sourceId' like 'public:%'
          and (
            not exists (
              select 1
              from public_source_documents documents
              where documents.document_id = sources.locator->>'documentId'
                and documents.source_id = substring(sources.locator->>'sourceId' from 8)
                and documents.canonical_url = sources.public_provenance->>'citationUrl'
            )
            or sources.public_provenance->>'citationUrl' <> btrim(sources.public_provenance->>'citationUrl')
            or sources.public_provenance->>'citationUrl' ~ '[[:cntrl:]]'
            or sources.public_provenance->>'citationUrl' ~ '[^ -~]'
            or sources.public_provenance->>'citationUrl' !~ '^https://[^[:space:]]+$'
            or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') is null
            or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') <> lower(substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)'))
            or not brief_public_source_https_url_allowed(sources.public_provenance->>'citationUrl')
            or length(substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)')) > 253
            or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') in ('localhost')
            or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') like '%.localhost'
            or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') like '%.local'
            or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') like '%.localdomain'
            or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') like '%.internal'
            or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') like '%.corp'
            or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') like '%.lan'
            or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') like '%.home'
            or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') like '%.home.arpa'
            or substring(sources.public_provenance->>'citationUrl' from '^https://([^/:?#]+)') ~* E'^((0x[0-9a-f]+|[0-9]+)(\\.(0x[0-9a-f]+|[0-9]+)){0,3})$'
            or position('@' in substring(sources.public_provenance->>'citationUrl' from '^https://([^/?#]+)')) > 0
            or position(':' in substring(sources.public_provenance->>'citationUrl' from '^https://([^/?#]+)')) > 0
            or sources.public_provenance->>'citationUrl' ~ '^https://[^/?#]+(?:$|[?#])'
            or position(chr(34) in sources.public_provenance->>'citationUrl') > 0
            or position('<' in sources.public_provenance->>'citationUrl') > 0
            or position('>' in sources.public_provenance->>'citationUrl') > 0
            or split_part(split_part(sources.public_provenance->>'citationUrl', '?', 1), '#', 1) ~* '(^|/)(\.{1,2}|%2e(?:%2e)?|\.%2e|%2e\.)(/|$)'
            or position('^' in split_part(split_part(sources.public_provenance->>'citationUrl', '?', 1), '#', 1)) > 0
            or position(chr(96) in split_part(split_part(sources.public_provenance->>'citationUrl', '?', 1), '#', 1)) > 0
            or position('{' in split_part(split_part(sources.public_provenance->>'citationUrl', '?', 1), '#', 1)) > 0
            or position('}' in split_part(split_part(sources.public_provenance->>'citationUrl', '?', 1), '#', 1)) > 0
            or position(chr(92) in split_part(split_part(sources.public_provenance->>'citationUrl', '?', 1), '#', 1)) > 0
            or position(chr(39) in case
              when position('?' in split_part(sources.public_provenance->>'citationUrl', '#', 1)) > 0 then
                substring(
                  split_part(sources.public_provenance->>'citationUrl', '#', 1)
                  from position('?' in split_part(sources.public_provenance->>'citationUrl', '#', 1)) + 1
                )
              else ''
            end) > 0
            or position(chr(96) in case
              when position('#' in sources.public_provenance->>'citationUrl') > 0 then
                substring(sources.public_provenance->>'citationUrl' from position('#' in sources.public_provenance->>'citationUrl') + 1)
              else ''
            end) > 0
          ))
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: public provenance is not bound to its source kind and locator',
        row_data.row_identity;
    end loop;

  -- A successful reduction is a projection, not a second source selector.
  -- Reconcile every exact candidate ledger with its keep/range/omit decision
  -- before source-use validation. This permits an explicit omission or range
  -- reduction while rejecting a use that bypasses the decision set.
  for row_data in
      with context_rows as (
        select decisions.run_id,
               decisions.id,
               runs.assistant_message_id,
               decisions.emitting_task,
               decisions.loop_iteration,
               decisions.attempt,
               decisions.payload as decision_payload,
               measurements.payload as measurement_payload,
               coalesce(measurements.payload->>'consumerTaskId', decisions.emitting_task) as consumer_task_id,
               serialized.payload as serialized_payload
        from ai_observations decisions
        join ai_runs runs on runs.id = decisions.run_id
        left join lateral (
          select measurements.payload
          from ai_observations measurements
          where measurements.run_id = decisions.run_id
            and measurements.kind = 'context_measurement'
            and measurements.emitting_task in (
              case
                when decisions.emitting_task = 'single-reduce-measure' then 'single-measure'
                when decisions.emitting_task ~ '^topic-t[123]-reduce-measure$'
                  then regexp_replace(decisions.emitting_task, '-reduce-measure$', '-measure')
                else decisions.emitting_task
              end,
              decisions.emitting_task
            )
            and (
              measurements.loop_iteration < decisions.loop_iteration
              or (measurements.loop_iteration = decisions.loop_iteration
                and measurements.attempt < decisions.attempt)
              or (
                measurements.loop_iteration = decisions.loop_iteration
                and measurements.attempt = decisions.attempt
                and not exists (
                  select 1
                  from ai_observations earlier
                  where earlier.run_id = decisions.run_id
                    and earlier.kind = 'context_measurement'
                    and earlier.emitting_task in (
                      case
                        when decisions.emitting_task = 'single-reduce-measure' then 'single-measure'
                        when decisions.emitting_task ~ '^topic-t[123]-reduce-measure$'
                          then regexp_replace(decisions.emitting_task, '-reduce-measure$', '-measure')
                        else decisions.emitting_task
                      end,
                      decisions.emitting_task
                    )
                    and (earlier.loop_iteration < decisions.loop_iteration
                      or (earlier.loop_iteration = decisions.loop_iteration
                        and earlier.attempt < decisions.attempt))
                )
              )
            )
          order by measurements.loop_iteration desc, measurements.attempt desc,
                   case when not exists (
                     select 1
                     from ai_observations prior_decisions
                     where prior_decisions.run_id = decisions.run_id
                       and prior_decisions.kind = 'context_decision'
                       and prior_decisions.emitting_task = decisions.emitting_task
                       and (prior_decisions.loop_iteration < decisions.loop_iteration
                         or (prior_decisions.loop_iteration = decisions.loop_iteration
                           and (prior_decisions.attempt < decisions.attempt
                             or (prior_decisions.attempt = decisions.attempt
                               and prior_decisions.id < decisions.id))))
                   )
                     and measurements.emitting_task = case
                       when decisions.emitting_task = 'single-reduce-measure' then 'single-measure'
                       when decisions.emitting_task ~ '^topic-t[123]-reduce-measure$'
                         then regexp_replace(decisions.emitting_task, '-reduce-measure$', '-measure')
                       else decisions.emitting_task
                     end then 0 else 1 end,
                   measurements.created_at desc, measurements.id desc
          limit 1
        ) measurements on true
        left join lateral (
          select serialized.payload
          from ai_observations serialized
          where serialized.run_id = decisions.run_id
            and serialized.kind = 'context_serialized'
            and serialized.emitting_task = coalesce(measurements.payload->>'consumerTaskId', decisions.emitting_task)
          order by serialized.loop_iteration desc, serialized.attempt desc, serialized.id desc
          limit 1
        ) serialized on true
        where runs.finished_at is not null
          and runs.failed_at is null
          and decisions.kind = 'context_decision'
          and decisions.payload->>'valid' = 'true'
      ), invalid as (
        select context_rows.run_id,
               context_rows.id,
               'missing context measurement'::text as reason
        from context_rows
        where context_rows.measurement_payload is null
        union all
        select context_rows.run_id,
               context_rows.id,
               'context decision does not cover the exact candidate ledger'
        from context_rows
        where context_rows.measurement_payload is not null
          and (
            jsonb_typeof(context_rows.decision_payload->'decisions') is distinct from 'array'
            or jsonb_typeof(context_rows.measurement_payload->'restrictedContextLedger'->'sources') is distinct from 'array'
            or jsonb_array_length(case when jsonb_typeof(context_rows.decision_payload->'decisions') = 'array' then context_rows.decision_payload->'decisions' else '[]'::jsonb end) <> jsonb_array_length(case when jsonb_typeof(context_rows.measurement_payload->'restrictedContextLedger'->'sources') = 'array' then context_rows.measurement_payload->'restrictedContextLedger'->'sources' else '[]'::jsonb end)
            or (select count(*) from jsonb_array_elements(context_rows.decision_payload->'decisions') decision) <> (select count(distinct decision->>'id') from jsonb_array_elements(context_rows.decision_payload->'decisions') decision)
            or exists (
              select 1
              from jsonb_array_elements(context_rows.decision_payload->'decisions') decision
              where not exists (
                select 1
                from jsonb_array_elements(context_rows.measurement_payload->'restrictedContextLedger'->'sources') candidate
                where candidate->>'candidateId' = decision->>'id'
              )
            )
            or exists (
              select 1
              from jsonb_array_elements(context_rows.measurement_payload->'restrictedContextLedger'->'sources') candidate
              where (select count(*) from jsonb_array_elements(context_rows.decision_payload->'decisions') decision where decision->>'id' = candidate->>'candidateId') <> 1
            )
          )
        union all
        select candidates.run_id,
               candidates.id,
               'context decision does not reconcile final source uses'
        from (
          select context_rows.run_id,
                 context_rows.id,
                 context_rows.assistant_message_id,
                 context_rows.consumer_task_id,
                 candidate,
                 decision
          from context_rows
          cross join lateral jsonb_array_elements(case
            when jsonb_typeof(context_rows.measurement_payload->'restrictedContextLedger'->'sources') = 'array'
              then context_rows.measurement_payload->'restrictedContextLedger'->'sources'
            else '[]'::jsonb end) candidate
          left join lateral (
            select decision
            from jsonb_array_elements(case
              when jsonb_typeof(context_rows.decision_payload->'decisions') = 'array'
                then context_rows.decision_payload->'decisions'
              else '[]'::jsonb end) decision
            where decision->>'id' = candidate->>'candidateId'
            limit 1
          ) selected on true
        ) candidates
        where candidates.decision is null
          or candidates.decision->>'action' not in ('keep', 'range', 'omit')
          or (candidates.decision->>'action' = 'range' and candidates.candidate->>'kind' <> 'document')
          or (candidates.decision->>'action' = 'range' and (
            jsonb_typeof(candidates.decision->'ranges') is distinct from 'array'
            or jsonb_array_length(case when jsonb_typeof(candidates.decision->'ranges') = 'array' then candidates.decision->'ranges' else '[]'::jsonb end) = 0
            or exists (
              select 1
              from jsonb_array_elements(candidates.decision->'ranges') reduced
              where jsonb_typeof(reduced) is distinct from 'object'
                or reduced->>'charStart' !~ '^[0-9]+$'
                or reduced->>'charEnd' !~ '^[0-9]+$'
                or (case when reduced->>'charStart' ~ '^[0-9]+$' and reduced->>'charEnd' ~ '^[0-9]+$'
                    then (reduced->>'charEnd')::numeric <= (reduced->>'charStart')::numeric
                    else true end)
                or (case when reduced->>'charStart' ~ '^[0-9]+$' then (reduced->>'charStart')::numeric < 0 else true end)
                or (case when reduced->>'charEnd' ~ '^[0-9]+$' then (reduced->>'charEnd')::numeric <= 0 else true end)
                or (case when reduced->>'charEnd' ~ '^[0-9]+$' then (reduced->>'charEnd')::numeric > 9007199254740991 else true end)
            )
            or exists (
              select 1
              from jsonb_array_elements(candidates.decision->'ranges') reduced
              where not exists (
                select 1
                from jsonb_array_elements(candidates.candidate->'ranges') original
                where original->>'charStart' ~ '^[0-9]+$'
                  and original->>'charEnd' ~ '^[0-9]+$'
                  and reduced->>'charStart' ~ '^[0-9]+$'
                  and reduced->>'charEnd' ~ '^[0-9]+$'
                  and (reduced->>'charStart')::numeric >= (original->>'charStart')::numeric
                  and (reduced->>'charEnd')::numeric <= (original->>'charEnd')::numeric
              )
            )
          ))
          or (candidates.decision->>'action' = 'omit' and exists (
            select 1
            from assistant_message_source_uses uses
            where uses.assistant_message_id = candidates.assistant_message_id
              and uses.source_key = candidates.candidate->>'sourceKey'
              and uses.consumer_task_id = candidates.consumer_task_id
          ))
          or (candidates.decision->>'action' in ('keep', 'range')
            and (
              (select count(*) from assistant_message_source_uses uses
               where uses.assistant_message_id = candidates.assistant_message_id
                 and uses.source_key = candidates.candidate->>'sourceKey'
                 and uses.consumer_task_id = candidates.consumer_task_id) <> 1
              or not exists (
              select 1
              from assistant_message_source_uses uses
              where uses.assistant_message_id = candidates.assistant_message_id
                and uses.source_key = candidates.candidate->>'sourceKey'
                and uses.consumer_task_id = candidates.consumer_task_id
                and uses.ranges is not distinct from coalesce(case
                    when candidates.decision->>'action' = 'range' then candidates.decision->'ranges'
                    else candidates.candidate->'ranges'
                  end, '[]'::jsonb)
              )
            )
          )
        union all
        select context_rows.run_id,
               context_rows.id,
               'context decision does not project the exact serialized context'
        from context_rows
        where not exists (
                select 1
                from ai_observations later
                where later.run_id = context_rows.run_id
                  and later.kind = 'context_decision'
                  and later.emitting_task = context_rows.emitting_task
                  and later.payload->>'valid' = 'true'
                  and (later.loop_iteration > context_rows.loop_iteration
                    or (later.loop_iteration = context_rows.loop_iteration
                      and (later.attempt > context_rows.attempt
                        or (later.attempt = context_rows.attempt and later.id > context_rows.id))))
              )
          and (
            context_rows.serialized_payload is null
            or jsonb_typeof(context_rows.serialized_payload->'sourceKeys') is distinct from 'array'
            or jsonb_typeof(context_rows.serialized_payload->'restrictedContextLedger'->'sources') is distinct from 'array'
            or jsonb_array_length(case
              when jsonb_typeof(context_rows.serialized_payload->'sourceKeys') = 'array'
                then context_rows.serialized_payload->'sourceKeys' else '[]'::jsonb end) <> (
              select count(*)
              from jsonb_array_elements(case
                when jsonb_typeof(context_rows.decision_payload->'decisions') = 'array'
                  then context_rows.decision_payload->'decisions' else '[]'::jsonb end) decision
              where decision->>'action' in ('keep', 'range')
            )
            or jsonb_array_length(case
              when jsonb_typeof(context_rows.serialized_payload->'restrictedContextLedger'->'sources') = 'array'
                then context_rows.serialized_payload->'restrictedContextLedger'->'sources' else '[]'::jsonb end) <> (
              select count(*)
              from jsonb_array_elements(case
                when jsonb_typeof(context_rows.decision_payload->'decisions') = 'array'
                  then context_rows.decision_payload->'decisions' else '[]'::jsonb end) decision
              where decision->>'action' in ('keep', 'range')
            )
            or exists (
              select 1
              from jsonb_array_elements(context_rows.serialized_payload->'sourceKeys') source_key
              where (select count(*)
                     from jsonb_array_elements(case
                       when jsonb_typeof(context_rows.measurement_payload->'restrictedContextLedger'->'sources') = 'array'
                         then context_rows.measurement_payload->'restrictedContextLedger'->'sources' else '[]'::jsonb end) candidate
                     join lateral jsonb_array_elements(case
                       when jsonb_typeof(context_rows.decision_payload->'decisions') = 'array'
                         then context_rows.decision_payload->'decisions' else '[]'::jsonb end) decision
                       on decision->>'id' = candidate->>'candidateId'
                     where decision->>'action' in ('keep', 'range')
                       and candidate->>'sourceKey' = source_key #>> '{}') <> 1
            )
            or exists (
              select 1
              from jsonb_array_elements(case
                when jsonb_typeof(context_rows.measurement_payload->'restrictedContextLedger'->'sources') = 'array'
                  then context_rows.measurement_payload->'restrictedContextLedger'->'sources' else '[]'::jsonb end) candidate
              join lateral jsonb_array_elements(case
                when jsonb_typeof(context_rows.decision_payload->'decisions') = 'array'
                  then context_rows.decision_payload->'decisions' else '[]'::jsonb end) decision
                on decision->>'id' = candidate->>'candidateId'
              where decision->>'action' in ('keep', 'range')
                and not exists (
                  select 1
                  from jsonb_array_elements(context_rows.serialized_payload->'sourceKeys') source_key
                  where source_key #>> '{}' = candidate->>'sourceKey'
                )
            )
            or exists (
              select 1
              from jsonb_array_elements(context_rows.serialized_payload->'restrictedContextLedger'->'sources') actual
              where not exists (
                select 1
                from jsonb_array_elements(case
                  when jsonb_typeof(context_rows.measurement_payload->'restrictedContextLedger'->'sources') = 'array'
                    then context_rows.measurement_payload->'restrictedContextLedger'->'sources' else '[]'::jsonb end) candidate
                join lateral jsonb_array_elements(case
                  when jsonb_typeof(context_rows.decision_payload->'decisions') = 'array'
                    then context_rows.decision_payload->'decisions' else '[]'::jsonb end) decision
                  on decision->>'id' = candidate->>'candidateId'
                where decision->>'action' in ('keep', 'range')
                  and actual is not distinct from case
                    when decision->>'action' = 'range'
                      then jsonb_set(candidate, '{ranges}', decision->'ranges', true)
                    else candidate
                  end
              )
            )
          )
      )
      select invalid.run_id::text || '/' || invalid.id::text as row_identity,
             invalid.reason
      from invalid
      order by invalid.run_id, invalid.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_observations/%: %',
        row_data.row_identity,
        row_data.reason;
    end loop;

  -- Runs that fit on the initial measurement still need a reverse projection
  -- check. Without a reduction decision, the terminal serialized context must
  -- equal the terminal consumer measurement, including its ordered source
  -- keys; one-way use checks must not admit extra hidden candidates.
  for row_data in
      with serialized_rows as (
        select serialized.run_id,
               serialized.id,
               serialized.payload,
               serialized.payload->>'consumerTaskId' as consumer_task_id
        from ai_observations serialized
        join ai_runs runs on runs.id = serialized.run_id
        where serialized.kind = 'context_serialized'
          and runs.finished_at is not null
          and runs.failed_at is null
          and (
            serialized.payload->>'consumerTaskId' = 'single-answer'
            or serialized.payload->>'consumerTaskId' = 'fanout-synthesis'
            or serialized.payload->>'consumerTaskId' ~ '^topic-t[123]-answer$'
          )
          and not exists (
            select 1
            from ai_observations decisions
            where decisions.run_id = serialized.run_id
              and decisions.kind = 'context_decision'
              and decisions.payload->>'valid' = 'true'
              and decisions.emitting_task = case
                when serialized.payload->>'consumerTaskId' = 'single-answer'
                  then 'single-reduce-measure'
                when serialized.payload->>'consumerTaskId' ~ '^topic-t[123]-answer$'
                  then regexp_replace(serialized.payload->>'consumerTaskId', '-answer$', '-reduce-measure')
                else null
              end
          )
      ), terminal_measurements as (
        select serialized_rows.run_id,
               serialized_rows.id,
               serialized_rows.payload,
               measurements.payload as measurement_payload
        from serialized_rows
        left join lateral (
          select measurements.payload
          from ai_observations measurements
          where measurements.run_id = serialized_rows.run_id
            and measurements.kind = 'context_measurement'
            and measurements.emitting_task = serialized_rows.consumer_task_id
          order by measurements.loop_iteration desc, measurements.attempt desc,
                   measurements.created_at desc, measurements.id desc
          limit 1
        ) measurements on true
      )
      select terminal_measurements.run_id::text || '/' || terminal_measurements.id::text as row_identity
      from terminal_measurements
      where terminal_measurements.measurement_payload is null
        or terminal_measurements.payload->'restrictedContextLedger' is distinct from
          terminal_measurements.measurement_payload->'restrictedContextLedger'
        or terminal_measurements.payload->'sourceKeys' is distinct from (
          select coalesce(
            jsonb_agg(source.value->>'sourceKey' order by source.ordinality),
            '[]'::jsonb
          )
          from jsonb_array_elements(case
            when jsonb_typeof(terminal_measurements.measurement_payload->'restrictedContextLedger'->'sources') = 'array'
              then terminal_measurements.measurement_payload->'restrictedContextLedger'->'sources'
            else '[]'::jsonb end) with ordinality source(value, ordinality)
        )
      order by terminal_measurements.run_id, terminal_measurements.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_observations/%: context serialized context does not match its terminal measurement',
        row_data.row_identity;
    end loop;

  -- Every retained source must be reachable from a canonical answer use.
  -- Retrieval-only rows cannot be decoded by the final saved-answer reader.
  for row_data in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      where not exists (
        select 1
        from assistant_message_source_uses uses
        where uses.assistant_message_id = sources.assistant_message_id
          and uses.source_key = sources.source_key
          and (
            uses.consumer_task_id = 'single-answer'
            or uses.consumer_task_id ~ '^topic-t[123]-answer$'
          )
      )
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: source has no canonical answer use',
        row_data.row_identity;
    end loop;

  -- Every canonical answer use must resolve through the selector that owns
  -- that consumer.  A matching reference in another topic's manifest is not
  -- evidence for this use.
  for row_data in
      select runs.id::text as run_id,
             uses.source_key,
             uses.consumer_task_id
      from ai_runs runs
      join assistant_message_source_uses uses
        on uses.assistant_message_id = runs.assistant_message_id
      join assistant_message_sources sources
        on sources.assistant_message_id = uses.assistant_message_id
       and sources.source_key = uses.source_key
      where runs.finished_at is not null
        and runs.failed_at is null
        and (
          uses.consumer_task_id = 'single-answer'
          or uses.consumer_task_id ~ '^topic-t[123]-answer$'
        )
        and not exists (
          select 1
          from ai_observations manifests
          left join ai_observations plans
            on plans.run_id = runs.id and plans.kind = 'turn_plan'
          cross join lateral jsonb_array_elements(
            case when jsonb_typeof(manifests.payload->'references') = 'array'
              then manifests.payload->'references' else '[]'::jsonb end
          ) refs(value)
          where manifests.run_id = runs.id
            and manifests.kind = 'retrieval_manifest'
            and not exists (
              select 1
              from ai_observations later
              where later.run_id = manifests.run_id
                and later.kind = 'retrieval_manifest'
                and later.emitting_task = manifests.emitting_task
                and (later.loop_iteration > manifests.loop_iteration
                  or (later.loop_iteration = manifests.loop_iteration
                    and later.attempt > manifests.attempt))
            )
            and (
              manifests.emitting_task = case
                when plans.emitting_task = 'evaluation-general-planner' then 'evaluation-general-planner'
                when uses.consumer_task_id = 'single-answer' then case sources.kind
                  when 'memory' then 'single-select-memories'
                  when 'web' then 'single-retrieve-web'
                  else 'single-retrieve-internal' end
                when uses.consumer_task_id like 'topic-t%-answer' then
                  'topic-' || substring(uses.consumer_task_id from 7 for 2) || '-' || case sources.kind
                    when 'memory' then 'select-memories'
                    when 'web' then 'retrieve-web'
                    else 'retrieve-internal' end
                else null end
            )
            and manifests.observation_key = format(
              '%s:%s:%s:retrieval_manifest:result',
              manifests.emitting_task, manifests.loop_iteration, manifests.attempt
            )
            and (
              (sources.kind = 'memory'
                and refs.value->>'memoryId' = sources.locator->>'memoryId'
                and refs.value->>'memoryRevisionId' = sources.locator->>'memoryRevisionId')
              or (sources.kind = 'chat_message'
                and refs.value->>'messageId' = sources.locator->>'messageId')
              or (sources.kind = 'document'
                and refs.value->>'documentId' = sources.locator->>'documentId'
                and refs.value->>'versionId' = coalesce(
                  sources.locator->>'versionId', sources.locator->>'versionId')
                and (
                  refs.value->'ranges' is not distinct from uses.ranges
                  or exists (
                    select 1
                    from ai_observations decisions
                    join lateral (
                      select measurements.payload
                      from ai_observations measurements
                      where measurements.run_id = decisions.run_id
                        and measurements.kind = 'context_measurement'
                        and measurements.emitting_task in (
                          case
                            when decisions.emitting_task = 'single-reduce-measure' then 'single-measure'
                            when decisions.emitting_task ~ '^topic-t[123]-reduce-measure$'
                              then regexp_replace(decisions.emitting_task, '-reduce-measure$', '-measure')
                            else decisions.emitting_task
                          end,
                          decisions.emitting_task
                        )
                        and (
                          measurements.loop_iteration < decisions.loop_iteration
                          or (measurements.loop_iteration = decisions.loop_iteration
                            and measurements.attempt < decisions.attempt)
                          or (
                            measurements.loop_iteration = decisions.loop_iteration
                            and measurements.attempt = decisions.attempt
                            and not exists (
                              select 1
                              from ai_observations earlier
                              where earlier.run_id = decisions.run_id
                                and earlier.kind = 'context_measurement'
                                and earlier.emitting_task in (
                                  case
                                    when decisions.emitting_task = 'single-reduce-measure' then 'single-measure'
                                    when decisions.emitting_task ~ '^topic-t[123]-reduce-measure$'
                                      then regexp_replace(decisions.emitting_task, '-reduce-measure$', '-measure')
                                    else decisions.emitting_task
                                  end,
                                  decisions.emitting_task
                                )
                                and (earlier.loop_iteration < decisions.loop_iteration
                                  or (earlier.loop_iteration = decisions.loop_iteration
                                    and earlier.attempt < decisions.attempt))
                            )
                          )
                        )
                      order by measurements.loop_iteration desc, measurements.attempt desc,
                               case when not exists (
                                 select 1
                                 from ai_observations prior_decisions
                                 where prior_decisions.run_id = decisions.run_id
                                   and prior_decisions.kind = 'context_decision'
                                   and prior_decisions.emitting_task = decisions.emitting_task
                                   and (prior_decisions.loop_iteration < decisions.loop_iteration
                                     or (prior_decisions.loop_iteration = decisions.loop_iteration
                                       and (prior_decisions.attempt < decisions.attempt
                                         or (prior_decisions.attempt = decisions.attempt
                                           and prior_decisions.id < decisions.id))))
                               )
                                 and measurements.emitting_task = case
                                   when decisions.emitting_task = 'single-reduce-measure' then 'single-measure'
                                   when decisions.emitting_task ~ '^topic-t[123]-reduce-measure$'
                                     then regexp_replace(decisions.emitting_task, '-reduce-measure$', '-measure')
                                   else decisions.emitting_task
                                 end then 0 else 1 end,
                               measurements.created_at desc, measurements.id desc
                      limit 1
                    ) measurements on true
                    cross join lateral jsonb_array_elements(
                      case when jsonb_typeof(measurements.payload->'restrictedContextLedger'->'sources') = 'array'
                        then measurements.payload->'restrictedContextLedger'->'sources' else '[]'::jsonb end
                    ) candidates(value)
                    cross join lateral jsonb_array_elements(
                      case when jsonb_typeof(decisions.payload->'decisions') = 'array'
                        then decisions.payload->'decisions' else '[]'::jsonb end
                    ) decisions_set(value)
                    where decisions.run_id = runs.id
                      and decisions.kind = 'context_decision'
                      and decisions.payload->>'valid' = 'true'
                    and decisions.emitting_task = case
                      when uses.consumer_task_id = 'single-answer' then 'single-reduce-measure'
                      when uses.consumer_task_id ~ '^topic-t[123]-answer$'
                        then regexp_replace(uses.consumer_task_id, '-answer$', '-reduce-measure')
                      else uses.consumer_task_id
                    end
                      and candidates.value->>'sourceKey' = uses.source_key
                      and decisions_set.value->>'id' = candidates.value->>'candidateId'
                      and decisions_set.value->>'action' = 'range'
                      and decisions_set.value->'ranges' is not distinct from uses.ranges
                      and not exists (
                        select 1
                        from jsonb_array_elements(case when jsonb_typeof(uses.ranges) = 'array' then uses.ranges else '[]'::jsonb end) reduced
                        where not exists (
                          select 1
                          from jsonb_array_elements(case when jsonb_typeof(refs.value->'ranges') = 'array' then refs.value->'ranges' else '[]'::jsonb end) original
                          where original->>'charStart' ~ '^[0-9]+$'
                            and original->>'charEnd' ~ '^[0-9]+$'
                            and reduced->>'charStart' ~ '^[0-9]+$'
                            and reduced->>'charEnd' ~ '^[0-9]+$'
                            and (reduced->>'charStart')::numeric >= (original->>'charStart')::numeric
                            and (reduced->>'charEnd')::numeric <= (original->>'charEnd')::numeric
                        )
                      )
                  )
                )
                and refs.value->>'purpose' is not null
                and refs.value->'source' = case
                  when sources.locator->>'sourceId' like 'public:%' then jsonb_build_object(
                    'kind', 'public',
                    'sourceId', sources.locator->>'sourceId'
                  )
                  else jsonb_build_object(
                    'kind', 'publisher',
                    'sourceId', sources.locator->>'sourceId',
                    'issueId', sources.locator->>'publisherIssueId',
                    'documentId', sources.locator->>'publisherDocumentId'
                  )
                end
                and (
                  (sources.locator->>'sourceId' like 'public:%'
                    and not (refs.value ? 'publisherExtractionId'))
                  or (sources.locator->>'sourceId' like 'publisher:%'
                    and refs.value->>'publisherExtractionId' = coalesce(
                      sources.locator->>'publisherExtractionId',
                      (
                        select extractions.id::text
                        from brief_document_versions versions
                        join brief_documents documents on documents.id = versions.brief_document_id
                        join brief_document_extractions extractions
                          on extractions.brief_document_id = documents.id
                         and extractions.input_sha256_hex = documents.sha256_hex
                        where versions.id::text = coalesce(
                          to_jsonb(sources)->>'document_version_id',
                          to_jsonb(sources)->>'version_id',
                          sources.locator->>'versionId',
                          sources.locator->>'versionId'
                        )
                      )
                    ))
                ))
              or (sources.kind = 'web'
                and refs.value->>'url' = sources.locator->>'url'
                and refs.value->>'title' = sources.locator->>'title'
                and refs.value->>'domain' = sources.locator->>'domain'
                and refs.value->>'quote' = sources.locator->>'quote'
                and refs.value->>'capturedAt' = sources.locator->>'capturedAt'
                and refs.value->>'publishedAt' is not distinct from sources.locator->>'publishedAt'
                and translate(
                  rtrim(encode(digest(convert_to(refs.value->>'quote', 'UTF8'), 'sha256'), 'base64'), '='),
                  '+/', '-_'
                ) = sources.locator->>'quoteHash')
            )
        )
      order by runs.id, uses.source_key, uses.consumer_task_id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: answer source use is not bound to its exact selector manifest',
        row_data.run_id || '/' || row_data.source_key || '/' || row_data.consumer_task_id;
    end loop;

  -- A successful route mounts exactly one terminal A/B/W manifest for every
  -- selector it selected. Owner and selectorRole are one bound identity.
  for row_data in
      with plans as (
        select runs.id, plans.payload, plans.emitting_task
        from ai_runs runs
        join ai_observations plans on plans.run_id = runs.id and plans.kind = 'turn_plan'
        where runs.finished_at is not null and runs.failed_at is null
      ), expected as (
        select plans.id, 'evaluation-general-planner'::text as owner,
               'general_planner'::text as selector_role
        from plans where plans.emitting_task = 'evaluation-general-planner'
        union all
        select plans.id, mounted.owner, mounted.selector_role
        from plans
        cross join lateral (
          select 'single-retrieve-internal'::text as owner, 'internal'::text as selector_role
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'single-select-memories', 'memory'
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'single-retrieve-web', 'web'
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'topic-' || (topic->>'topicId') || '-retrieve-internal', 'internal'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
          union all select 'topic-' || (topic->>'topicId') || '-select-memories', 'memory'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
          union all select 'topic-' || (topic->>'topicId') || '-retrieve-web', 'web'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
        ) mounted
      )
      select runs.id::text || '/' || expected.owner as row_identity
      from ai_runs runs
      join expected on expected.id = runs.id
      where not exists (
        select 1 from ai_observations manifests
        where manifests.run_id = runs.id
          and manifests.kind = 'retrieval_manifest'
          and manifests.emitting_task = expected.owner
          and not exists (
            select 1
            from ai_observations later
            where later.run_id = manifests.run_id
              and later.kind = 'retrieval_manifest'
              and later.emitting_task = manifests.emitting_task
              and (later.loop_iteration > manifests.loop_iteration
                or (later.loop_iteration = manifests.loop_iteration
                  and later.attempt > manifests.attempt))
          )
      )
      order by runs.id, expected.owner
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: successful run is missing terminal retrieval manifest',
        row_data.row_identity;
    end loop;

  for row_data in
      with plans as (
        select runs.id, plans.payload, plans.emitting_task
        from ai_runs runs
        join ai_observations plans on plans.run_id = runs.id and plans.kind = 'turn_plan'
        where runs.finished_at is not null and runs.failed_at is null
      ), expected as (
        select plans.id, 'evaluation-general-planner'::text as owner,
               'general_planner'::text as selector_role
        from plans where plans.emitting_task = 'evaluation-general-planner'
        union all
        select plans.id, mounted.owner, mounted.selector_role
        from plans
        cross join lateral (
          select 'single-retrieve-internal'::text as owner, 'internal'::text as selector_role
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'single-select-memories', 'memory'
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'single-retrieve-web', 'web'
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'topic-' || (topic->>'topicId') || '-retrieve-internal', 'internal'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
          union all select 'topic-' || (topic->>'topicId') || '-select-memories', 'memory'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
          union all select 'topic-' || (topic->>'topicId') || '-retrieve-web', 'web'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
        ) mounted
      )
      select runs.id::text || '/' || expected.owner as row_identity
      from ai_runs runs
      join expected on expected.id = runs.id
      where (select count(*) from ai_observations manifests
             where manifests.run_id = runs.id
               and manifests.kind = 'retrieval_manifest'
               and manifests.emitting_task = expected.owner
               and not exists (
                 select 1
                 from ai_observations later
                 where later.run_id = manifests.run_id
                   and later.kind = 'retrieval_manifest'
                   and later.emitting_task = manifests.emitting_task
                   and (later.loop_iteration > manifests.loop_iteration
                     or (later.loop_iteration = manifests.loop_iteration
                       and later.attempt > manifests.attempt))
               )) > 1
      order by runs.id, expected.owner
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: successful run has duplicate terminal retrieval manifest',
        row_data.row_identity;
    end loop;

  for row_data in
      select manifests.run_id::text || '/' || manifests.emitting_task as row_identity
      from ai_observations manifests
      join ai_runs runs on runs.id = manifests.run_id
      left join ai_observations plans on plans.run_id = runs.id and plans.kind = 'turn_plan'
      where manifests.kind = 'retrieval_manifest'
        and runs.finished_at is not null and runs.failed_at is null
        and not exists (
          select 1
          from (
            select 'evaluation-general-planner'::text as owner
            where plans.emitting_task = 'evaluation-general-planner'
            union all select 'single-retrieve-internal' where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
            union all select 'single-select-memories' where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
            union all select 'single-retrieve-web' where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
            union all select 'topic-' || (topic->>'topicId') || '-retrieve-internal' from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout' then plans.payload->'topics' else '[]'::jsonb end) topic where plans.emitting_task = 'plan-turn'
            union all select 'topic-' || (topic->>'topicId') || '-select-memories' from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout' then plans.payload->'topics' else '[]'::jsonb end) topic where plans.emitting_task = 'plan-turn'
            union all select 'topic-' || (topic->>'topicId') || '-retrieve-web' from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout' then plans.payload->'topics' else '[]'::jsonb end) topic where plans.emitting_task = 'plan-turn'
          ) expected(owner)
          where expected.owner = manifests.emitting_task
        )
      order by manifests.run_id, manifests.emitting_task, manifests.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: retrieval manifest owner is outside selected route',
        row_data.row_identity;
    end loop;

  for row_data in
      with plans as (
        select runs.id, plans.payload, plans.emitting_task
        from ai_runs runs
        join ai_observations plans on plans.run_id = runs.id and plans.kind = 'turn_plan'
        where runs.finished_at is not null and runs.failed_at is null
      ), expected as (
        select plans.id, 'evaluation-general-planner'::text as owner,
               'general_planner'::text as selector_role
        from plans where plans.emitting_task = 'evaluation-general-planner'
        union all
        select plans.id, mounted.owner, mounted.selector_role
        from plans
        cross join lateral (
          select 'single-retrieve-internal'::text as owner, 'internal'::text as selector_role
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'single-select-memories', 'memory'
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'single-retrieve-web', 'web'
          where plans.emitting_task = 'plan-turn' and plans.payload->>'mode' = 'single'
          union all select 'topic-' || (topic->>'topicId') || '-retrieve-internal', 'internal'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
          union all select 'topic-' || (topic->>'topicId') || '-select-memories', 'memory'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
          union all select 'topic-' || (topic->>'topicId') || '-retrieve-web', 'web'
          from jsonb_array_elements(case when plans.payload->>'mode' = 'fanout'
            then plans.payload->'topics' else '[]'::jsonb end) topic
          where plans.emitting_task = 'plan-turn'
        ) mounted
      )
      select manifests.run_id::text || '/' || manifests.emitting_task as row_identity
      from ai_observations manifests
      join expected on expected.id = manifests.run_id and expected.owner = manifests.emitting_task
      where manifests.kind = 'retrieval_manifest'
        and manifests.payload->>'selectorRole' is distinct from expected.selector_role
      order by manifests.run_id, manifests.emitting_task, manifests.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: retrieval manifest selector role does not match its owner',
        row_data.row_identity;
    end loop;

  -- Validate the retained answer identity before the first schema change. A
  -- later namespace check cannot repair a bad nonce because the cutover has
  -- already added and populated the final column by then.
  for legacy_row in
      select versions.id::text as row_identity
      from brief_document_versions versions
      join brief_documents documents on documents.id = versions.brief_document_id
      where not exists (
        select 1 from brief_document_extractions extractions
        where extractions.brief_document_id = documents.id
          and extractions.input_sha256_hex = documents.sha256_hex
          and versions.canonical_text = (
            select string_agg(page->>'text', E'\n\n' order by (case when (page->>'pageNumber') ~ '^[0-9]+$' and length(page->>'pageNumber') <= 19 and (page->>'pageNumber')::numeric <= 9223372036854775807::numeric then (page->>'pageNumber')::bigint else null end))
            from jsonb_array_elements(extractions.pages) page
          )
          and extractions.extracted_char_count = (char_length(versions.canonical_text) + (select count(*) from generate_series(1, char_length(versions.canonical_text)) positions(position) where octet_length(convert_to(substr(versions.canonical_text, positions.position, 1), 'UTF8')) = 4))
          and versions.text_char_count = (char_length(versions.canonical_text) + (select count(*) from generate_series(1, char_length(versions.canonical_text)) positions(position) where octet_length(convert_to(substr(versions.canonical_text, positions.position, 1), 'UTF8')) = 4))
          and versions.content_hash = encode(digest(convert_to(versions.canonical_text, 'UTF8'), 'sha256'), 'hex')
          and jsonb_array_length(versions.page_ranges) = jsonb_array_length(extractions.pages)
          and not exists (
            with extraction_pages as (
              select (case when (page->>'pageNumber') ~ '^[0-9]+$' and length(page->>'pageNumber') <= 19 and (page->>'pageNumber')::numeric <= 9223372036854775807::numeric then (page->>'pageNumber')::bigint else null end) as page_number,
                     page->>'text' as page_text
              from jsonb_array_elements(extractions.pages) page
            ), expected_ranges as (
              select page_number,
                     coalesce(sum((char_length(page_text) + (select count(*) from generate_series(1, char_length(page_text)) positions(position) where octet_length(convert_to(substr(page_text, positions.position, 1), 'UTF8')) = 4)) + 2) over (
                       order by page_number rows between unbounded preceding and 1 preceding
                     ), 0) as char_start,
                     coalesce(sum((char_length(page_text) + (select count(*) from generate_series(1, char_length(page_text)) positions(position) where octet_length(convert_to(substr(page_text, positions.position, 1), 'UTF8')) = 4)) + 2) over (
                       order by page_number rows between unbounded preceding and 1 preceding
                     ), 0) + (char_length(page_text) + (select count(*) from generate_series(1, char_length(page_text)) positions(position) where octet_length(convert_to(substr(page_text, positions.position, 1), 'UTF8')) = 4)) as char_end
              from extraction_pages
            )
            select 1
            from expected_ranges expected
            where not exists (
              select 1 from jsonb_array_elements(versions.page_ranges) range_row
              where (case when (range_row->>'pageNumber') ~ '^[0-9]+$' and length(range_row->>'pageNumber') <= 19 and (range_row->>'pageNumber')::numeric <= 9223372036854775807::numeric then (range_row->>'pageNumber')::bigint else null end) = expected.page_number
                and (case when (range_row->>'charStart') ~ '^[0-9]+$' and length(range_row->>'charStart') <= 19 and (range_row->>'charStart')::numeric <= 9223372036854775807::numeric then (range_row->>'charStart')::bigint else null end) = expected.char_start
                and (case when (range_row->>'charEnd') ~ '^[0-9]+$' and length(range_row->>'charEnd') <= 19 and (range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (range_row->>'charEnd')::bigint else null end) = expected.char_end
            )
          )
      )
      order by versions.id
    loop
      raise exception
        'AI chat schema cutover preflight row brief_document_versions/%: version has no exact extraction lineage',
        legacy_row.row_identity;
    end loop;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_runs'
      and column_name = 'citation_nonce'
  ) then
    for legacy_row in
        select runs.id::text as row_identity, runs.citation_nonce
        from ai_runs runs
        order by runs.id
      loop
        if legacy_row.citation_nonce is null
          or octet_length(legacy_row.citation_nonce) <> 16 then
          raise exception
            'AI chat schema cutover preflight row ai_runs/%: citation nonce must contain exactly 16 bytes',
          legacy_row.row_identity;
        end if;
      end loop;
    for legacy_row in
        select runs.id::text as row_identity
        from ai_runs runs
        where exists (
          select 1
          from ai_runs duplicate_runs
          where duplicate_runs.id <> runs.id
            and duplicate_runs.citation_nonce = runs.citation_nonce
        )
        order by runs.id
      loop
        raise exception
          'AI chat schema cutover preflight row ai_runs/%: citation nonce collides with another retained answer',
          legacy_row.row_identity;
      end loop;
  else
    for legacy_row in
        select runs.id::text as row_identity,
               runs.citation_namespace
        from ai_runs runs
        order by runs.id
      loop
        if legacy_row.citation_namespace is null
          or legacy_row.citation_namespace !~ '^cn_[A-Za-z0-9_-]{22}$' then
          raise exception
            'AI chat schema cutover preflight row ai_runs/%: final citation namespace is not canonical',
            legacy_row.row_identity;
        end if;
      end loop;
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_runs'
      and column_name = 'citation_nonce'
  ) then
    for legacy_row in
        select runs.id::text as row_identity, runs.citation_namespace
        from ai_runs runs
        where exists (
          select 1 from ai_runs duplicate_runs
          where duplicate_runs.id <> runs.id
            and duplicate_runs.citation_namespace = runs.citation_namespace
        )
        order by runs.id
      loop
        raise exception
          'AI chat schema cutover preflight row ai_runs/%: final citation namespace collides with another answer',
          legacy_row.row_identity;
      end loop;
  end if;

  -- Locators are closed records.  The old versionId spelling is
  -- accepted only on a document row in the legacy branch; the DDL below
  -- converts it to versionId.  Every other unknown or cross-kind field blocks
  -- the cutover with the source's composite identity.
  for legacy_row in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
             sources.kind,
             sources.locator
      from assistant_message_sources sources
      order by sources.assistant_message_id, sources.source_key
    loop
      if jsonb_typeof(legacy_row.locator) is distinct from 'object'
        or legacy_row.locator->>'kind' is distinct from legacy_row.kind then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: locator discriminant is not canonical',
          legacy_row.row_identity;
      end if;
        if legacy_row.kind = 'document' then
        if legacy_row.locator->>'sourceId' !~ '^((public|publisher):[^:[:space:]]+)$'
          or position(chr(65279) in legacy_row.locator->>'sourceId') > 0
          or exists (
            select 1
            from generate_series(1, char_length(legacy_row.locator->>'sourceId')) positions(position)
            where ascii(substr(legacy_row.locator->>'sourceId', positions.position, 1)) in (9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279)
              or ascii(substr(legacy_row.locator->>'sourceId', positions.position, 1)) between 8192 and 8202
          )
          or coalesce(btrim(legacy_row.locator->>'documentId'), '') = ''
          or coalesce(btrim(legacy_row.locator->>'versionId'), btrim(legacy_row.locator->>'versionId'), '') = ''
          or legacy_row.locator->>'contentHash' !~ '^[0-9a-f]{64}$'
          or (jsonb_exists(legacy_row.locator, 'versionId') and jsonb_exists(legacy_row.locator, 'versionId')
            and legacy_row.locator->>'versionId' is distinct from legacy_row.locator->>'versionId')
          or exists (
            select 1 from jsonb_object_keys(legacy_row.locator) key
            where key not in (
              'kind', 'sourceId', 'documentId', 'versionId', 'versionId',
              'contentHash', 'ranges', 'publisherIssueId', 'publisherDocumentId',
              'publisherExtractionId'
            )
          )
          or legacy_row.locator->>'sourceId' like 'public:%'
            and (
              jsonb_exists(legacy_row.locator, 'publisherIssueId')
              or jsonb_exists(legacy_row.locator, 'publisherDocumentId')
              or jsonb_exists(legacy_row.locator, 'publisherExtractionId')
            )
          or legacy_row.locator->>'sourceId' like 'publisher:%'
            and (
              coalesce(btrim(legacy_row.locator->>'publisherIssueId'), '') = ''
              or coalesce(btrim(legacy_row.locator->>'publisherDocumentId'), '') = ''
              or legacy_row.locator->>'publisherDocumentId' is distinct from legacy_row.locator->>'documentId'
            ) then
          raise exception
            'AI chat schema cutover preflight row assistant_message_sources/%: document locator is not a closed canonical record',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'chat_message' then
        if coalesce(btrim(legacy_row.locator->>'messageId'), '') = ''
          or exists (
            select 1 from jsonb_object_keys(legacy_row.locator) key
            where key not in ('kind', 'messageId')
          ) then
          raise exception
            'AI chat schema cutover preflight row assistant_message_sources/%: chat locator is not a closed canonical record',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'memory' then
        if coalesce(btrim(legacy_row.locator->>'memoryId'), '') = ''
          or coalesce(btrim(legacy_row.locator->>'memoryRevisionId'), '') = ''
          or exists (
            select 1 from jsonb_object_keys(legacy_row.locator) key
            where key not in ('kind', 'memoryId', 'memoryRevisionId')
          ) then
          raise exception
            'AI chat schema cutover preflight row assistant_message_sources/%: memory locator is not a closed canonical record',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'web' then
        if jsonb_typeof(legacy_row.locator->'url') is distinct from 'string'
          or jsonb_typeof(legacy_row.locator->'title') is distinct from 'string'
          or jsonb_typeof(legacy_row.locator->'domain') is distinct from 'string'
          or jsonb_typeof(legacy_row.locator->'quote') is distinct from 'string'
          or jsonb_typeof(legacy_row.locator->'quoteHash') is distinct from 'string'
          or jsonb_typeof(legacy_row.locator->'capturedAt') is distinct from 'string'
          or (jsonb_exists(legacy_row.locator, 'publishedAt')
            and jsonb_typeof(legacy_row.locator->'publishedAt') is distinct from 'string')
          or coalesce(btrim(legacy_row.locator->>'url'), '') = ''
          or coalesce(btrim(legacy_row.locator->>'title'), '') = ''
          or coalesce(btrim(legacy_row.locator->>'domain'), '') = ''
          or coalesce(btrim(legacy_row.locator->>'quote'), '') = ''
          or legacy_row.locator->>'quoteHash' !~ '^[A-Za-z0-9_-]{43}$'
          or coalesce(btrim(legacy_row.locator->>'capturedAt'), '') = ''
          or legacy_row.locator->>'capturedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
          or legacy_row.locator->>'quoteHash' is distinct from translate(
            rtrim(encode(digest(convert_to(btrim(normalize(replace(replace(legacy_row.locator->>'quote', E'\r\n', E'\n'), E'\r', E'\n'), NFC)), 'UTF8'), 'sha256'), 'base64'), '='),
            '+/', '-_'
          )
          or exists (
            select 1 from jsonb_object_keys(legacy_row.locator) key
            where key not in ('kind', 'url', 'title', 'domain', 'quote', 'quoteHash', 'publishedAt', 'capturedAt')
          ) then
          raise exception
            'AI chat schema cutover preflight row assistant_message_sources/%: web locator is not a closed canonical record',
            legacy_row.row_identity;
        end if;
      end if;
    end loop;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'assistant_message_sources'
      and column_name = 'document_version_id'
  ) then
  -- Validate every retained source identity while the 0063 columns and the
  -- 0059 digest function still exist.  The cutover may rebuild these values,
  -- but it must never turn a tampered row into a valid one.
  -- Validate the shared locator contract with an exact source identity before
  -- the later kind-specific conversion checks can emit a generic blocker.
  for legacy_row in
      select
        sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
        sources.assistant_message_id,
        sources.kind,
        sources.locator,
        sources.message_id
      from assistant_message_sources sources
      order by sources.assistant_message_id, sources.source_key
    loop
      if legacy_row.kind = 'document' and (
        legacy_row.locator->>'sourceId' !~ '^((public|publisher):[^:[:space:]]+)$'
        or position(chr(65279) in legacy_row.locator->>'sourceId') > 0
        or coalesce(btrim(legacy_row.locator->>'documentId'), '') = ''
        or coalesce(btrim(legacy_row.locator->>'versionId'), btrim(legacy_row.locator->>'versionId'), '') = ''
        or legacy_row.locator->>'contentHash' !~ '^[0-9a-f]{64}$'
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: document locator is not canonical',
          legacy_row.row_identity;
      end if;
      if legacy_row.kind = 'chat_message' and (
        legacy_row.message_id is null
        or legacy_row.locator->>'messageId' is distinct from legacy_row.message_id::text
        or not exists (
          select 1
          from chat_messages referenced
          join chat_messages assistants on assistants.id = legacy_row.assistant_message_id
          where referenced.id = legacy_row.message_id
            and referenced.chat_id = assistants.chat_id
        )
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: chat-message locator is not owned by the answer chat',
          legacy_row.row_identity;
      end if;
      if legacy_row.kind = 'web' and (
        coalesce(btrim(legacy_row.locator->>'quote'), '') = ''
        or legacy_row.locator->>'quoteHash' is distinct from translate(
          rtrim(encode(digest(convert_to(btrim(normalize(replace(replace(legacy_row.locator->>'quote', E'\r\n', E'\n'), E'\r', E'\n'), NFC)), 'UTF8'), 'sha256'), 'base64'), '='),
          '+/', '-_'
        )
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: web quotation hash does not match its quote',
          legacy_row.row_identity;
      end if;
    end loop;

  -- Every retained observation has a closed, kind-specific payload.  A bare
  -- JSON object is not a canonical replay record, even for kinds whose full
  -- semantic relation is checked later by the worker.
  for legacy_row in
      select observations.id::text as row_identity,
             observations.run_id,
             observations.emitting_task,
             observations.loop_iteration,
             observations.attempt,
             observations.observation_key,
             observations.kind,
             observations.payload,
             runs.assistant_message_id
      from ai_observations observations
      join ai_runs runs on runs.id = observations.run_id
      order by observations.id
    loop
      if legacy_row.emitting_task !~ '^(plan-turn|memory-extract|evaluation-general-planner|single-(retrieve-internal|select-memories|retrieve-web|measure|reduce-plan|reduce-measure|context-select|answer|assemble)|topic-t[123]-(retrieve-internal|select-memories|retrieve-web|measure|reduce-plan|reduce-measure|context-select|answer|assemble)|fanout-synthesis|clarification-result|finalize|migration_backfill)$' then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: observation has a foreign task owner %',
          legacy_row.row_identity,
          legacy_row.emitting_task;
      end if;
      if legacy_row.kind in ('conversation_resolution', 'execution_plan', 'provider_request_attestation') then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: legacy observation kind % requires explicit conversion',
          legacy_row.row_identity,
          legacy_row.kind;
      end if;
      if legacy_row.kind = 'turn_plan'
        and legacy_row.emitting_task not in ('plan-turn', 'evaluation-general-planner') then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: turn_plan has a foreign owner %',
          legacy_row.row_identity,
          legacy_row.emitting_task;
      elsif legacy_row.kind = 'retrieval_manifest'
        and legacy_row.emitting_task not in (
          'evaluation-general-planner', 'single-retrieve-internal', 'single-select-memories',
          'single-retrieve-web', 'topic-t1-retrieve-internal', 'topic-t1-select-memories',
          'topic-t1-retrieve-web', 'topic-t2-retrieve-internal', 'topic-t2-select-memories',
          'topic-t2-retrieve-web', 'topic-t3-retrieve-internal', 'topic-t3-select-memories',
          'topic-t3-retrieve-web'
        ) then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: retrieval manifest has a foreign owner %',
          legacy_row.row_identity,
          legacy_row.emitting_task;
      elsif legacy_row.kind = 'topic_packet'
        and legacy_row.emitting_task !~ '^topic-t[123]-answer$' then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: topic packet has a foreign owner %',
          legacy_row.row_identity,
          legacy_row.emitting_task;
      elsif legacy_row.kind = 'memory_extraction_result'
        and legacy_row.emitting_task not in ('memory-extract', 'evaluation-general-planner') then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: memory extraction has a foreign owner %',
          legacy_row.row_identity,
          legacy_row.emitting_task;
      end if;
      if legacy_row.kind in ('provider_request_measurement', 'source_exposure_attestation') then
        continue;
      end if;
      if jsonb_typeof(legacy_row.payload) is distinct from 'object'
        or legacy_row.payload = '{}'::jsonb then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: % payload is empty or not an object',
          legacy_row.row_identity,
          legacy_row.kind;
      end if;
      if legacy_row.kind = 'turn_plan' then
        if jsonb_typeof(legacy_row.payload->'mode') is distinct from 'string'
          or legacy_row.payload->>'mode' not in ('clarify', 'single', 'fanout')
          or jsonb_typeof(legacy_row.payload->'question') is distinct from 'string'
          or coalesce(btrim(legacy_row.payload->>'question'), '') = ''
          or (legacy_row.payload->>'mode' = 'single'
            and (jsonb_typeof(legacy_row.payload->'relevantTurnIds') is distinct from 'array'
              or jsonb_exists(legacy_row.payload, 'topics')))
          or (legacy_row.payload->>'mode' = 'fanout'
            and (jsonb_typeof(legacy_row.payload->'topics') is distinct from 'array'
              or case when jsonb_typeof(legacy_row.payload->'topics') = 'array'
                then jsonb_array_length(legacy_row.payload->'topics') else 0 end < 2
              or case when jsonb_typeof(legacy_row.payload->'topics') = 'array'
                then jsonb_array_length(legacy_row.payload->'topics') else 0 end > 3
              or jsonb_exists(legacy_row.payload, 'relevantTurnIds')))
          or (legacy_row.payload->>'mode' = 'clarify'
            and (jsonb_exists(legacy_row.payload, 'relevantTurnIds')
              or jsonb_exists(legacy_row.payload, 'topics')))
          or exists (
            select 1 from jsonb_array_elements(case when jsonb_typeof(legacy_row.payload->'relevantTurnIds') = 'array'
              then legacy_row.payload->'relevantTurnIds' else '[]'::jsonb end) item
            where jsonb_typeof(item) is distinct from 'string' or btrim(item #>> '{}') = ''
          )
          or exists (
            select 1 from jsonb_array_elements(case when jsonb_typeof(legacy_row.payload->'topics') = 'array'
              then legacy_row.payload->'topics' else '[]'::jsonb end) item
            where jsonb_typeof(item) is distinct from 'object'
              or item->>'topicId' not in ('t1', 't2', 't3')
              or coalesce(btrim(item->>'question'), '') = ''
              or jsonb_typeof(item->'question') is distinct from 'string'
              or jsonb_typeof(item->'relevantTurnIds') is distinct from 'array'
              or exists (
                select 1 from jsonb_array_elements(case when jsonb_typeof(item->'relevantTurnIds') = 'array'
                  then item->'relevantTurnIds' else '[]'::jsonb end) turn_id
                where jsonb_typeof(turn_id) is distinct from 'string' or btrim(turn_id #>> '{}') = ''
              )
              or exists (
                select 1 from jsonb_object_keys(item) key
                where key not in ('topicId', 'question', 'relevantTurnIds')
              )
          )
          or exists (
            select 1
            from jsonb_array_elements(case when jsonb_typeof(legacy_row.payload->'topics') = 'array'
              then legacy_row.payload->'topics' else '[]'::jsonb end) with ordinality topic_rows(item, ordinal)
            where topic_rows.item->>'topicId' is distinct from case topic_rows.ordinal
              when 1 then 't1'
              when 2 then 't2'
              when 3 then 't3'
              else null
            end
          )
          or exists (
            select 1
            from jsonb_array_elements(case when jsonb_typeof(legacy_row.payload->'topics') = 'array'
              then legacy_row.payload->'topics' else '[]'::jsonb end) topic_rows(item)
            where jsonb_typeof(topic_rows.item->'question') is distinct from 'string'
              or jsonb_typeof(topic_rows.item->'topicId') is distinct from 'string'
              or jsonb_typeof(topic_rows.item->'relevantTurnIds') is distinct from 'array'
          )
          or exists (
            select selected_turn_id
            from (
              select value as selected_turn_id
              from jsonb_array_elements_text(case when jsonb_typeof(legacy_row.payload->'relevantTurnIds') = 'array'
                then legacy_row.payload->'relevantTurnIds' else '[]'::jsonb end) values(value)
              union all
              select turn_id.value as selected_turn_id
              from jsonb_array_elements(case when jsonb_typeof(legacy_row.payload->'topics') = 'array'
                then legacy_row.payload->'topics' else '[]'::jsonb end) topic_rows(item)
              cross join lateral jsonb_array_elements_text(case when jsonb_typeof(topic_rows.item->'relevantTurnIds') = 'array'
                then topic_rows.item->'relevantTurnIds' else '[]'::jsonb end) turn_id(value)
            ) selected
            group by selected_turn_id
            having count(*) > 1
          )
          or exists (
            select topic_rows.item->>'question'
            from jsonb_array_elements(case when jsonb_typeof(legacy_row.payload->'topics') = 'array'
              then legacy_row.payload->'topics' else '[]'::jsonb end) topic_rows(item)
            group by topic_rows.item->>'question'
            having count(*) > 1
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: turn_plan payload is not strict',
            legacy_row.row_identity;
        end if;
        if exists (
          select 1 from jsonb_object_keys(legacy_row.payload) key
          where key not in ('mode', 'question', 'relevantTurnIds', 'topics')
        ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: turn_plan payload contains an unknown field',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'retrieval_manifest' then
        if legacy_row.loop_iteration < 0
          or legacy_row.attempt < 0
          or legacy_row.observation_key is distinct from format(
            '%s:%s:%s:retrieval_manifest:result',
            legacy_row.emitting_task, legacy_row.loop_iteration, legacy_row.attempt
          )
          or jsonb_typeof(legacy_row.payload->'selectorRole') is distinct from 'string'
          or legacy_row.payload->>'selectorRole' not in ('internal', 'memory', 'web', 'general_planner')
          or jsonb_typeof(legacy_row.payload->'references') is distinct from 'array'
          or (jsonb_exists(legacy_row.payload, 'noCallReason') and (
            jsonb_typeof(legacy_row.payload->'noCallReason') is distinct from 'string'
            or legacy_row.payload->>'noCallReason' not in (
              'memory_mode_disabled', 'no_active_memories', 'web_not_requested',
              'web_policy_disabled', 'topic_not_web_eligible'
            )
            or jsonb_array_length(legacy_row.payload->'references') <> 0
            or (legacy_row.payload->>'noCallReason' in ('memory_mode_disabled', 'no_active_memories')
              and legacy_row.payload->>'selectorRole' <> 'memory')
            or (legacy_row.payload->>'noCallReason' in ('web_not_requested', 'web_policy_disabled', 'topic_not_web_eligible')
              and legacy_row.payload->>'selectorRole' <> 'web')
          )) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: retrieval manifest payload is not strict',
            legacy_row.row_identity;
        end if;
        if exists (
          select 1 from jsonb_object_keys(legacy_row.payload) key
          where key not in ('selectorRole', 'references', 'noCallReason')
        ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: retrieval manifest payload contains an unknown field',
            legacy_row.row_identity;
        end if;
        for reference_row in
            select value
            from jsonb_array_elements(case when jsonb_typeof(legacy_row.payload->'references') = 'array'
              then legacy_row.payload->'references' else '[]'::jsonb end) values(value)
          loop
            if jsonb_typeof(reference_row) is distinct from 'object' then
              raise exception
                'AI chat schema cutover preflight row ai_observations/%: retrieval reference is not an object',
                legacy_row.row_identity;
            elsif reference_row->>'kind' = 'document' then
              if jsonb_typeof(reference_row->'kind') is distinct from 'string'
                or jsonb_typeof(reference_row->'documentId') is distinct from 'string'
                or jsonb_typeof(reference_row->'versionId') is distinct from 'string'
                or jsonb_typeof(reference_row->'purpose') is distinct from 'string'
                or coalesce(btrim(reference_row->>'documentId'), '') = ''
                or coalesce(btrim(reference_row->>'versionId'), '') = ''
                or coalesce(btrim(reference_row->>'purpose'), '') = ''
                or jsonb_typeof(reference_row->'source') is distinct from 'object'
                or (jsonb_exists(reference_row, 'publisherExtractionId')
                  and (jsonb_typeof(reference_row->'publisherExtractionId') is distinct from 'string'
                    or coalesce(btrim(reference_row->>'publisherExtractionId'), '') = ''))
                or reference_row->'source'->>'kind' not in ('public', 'publisher')
                or jsonb_typeof(reference_row->'source'->'kind') is distinct from 'string'
                or jsonb_typeof(reference_row->'source'->'sourceId') is distinct from 'string'
                or coalesce(btrim(reference_row->'source'->>'sourceId'), '') = ''
                or (reference_row->'source'->>'kind' = 'public'
                  and (jsonb_exists(reference_row->'source', 'issueId')
                    or jsonb_exists(reference_row->'source', 'documentId')))
                or (reference_row->'source'->>'kind' = 'publisher'
                  and (jsonb_typeof(reference_row->'source'->'issueId') is distinct from 'string'
                    or jsonb_typeof(reference_row->'source'->'documentId') is distinct from 'string'
                    or coalesce(btrim(reference_row->'source'->>'issueId'), '') = ''
                    or coalesce(btrim(reference_row->'source'->>'documentId'), '') = ''))
                or (reference_row ? 'ranges' and (
                  jsonb_typeof(reference_row->'ranges') is distinct from 'array'
                  or exists (
                    select 1 from jsonb_array_elements(case when jsonb_typeof(reference_row->'ranges') = 'array'
                      then reference_row->'ranges' else '[]'::jsonb end) range_row
                    where jsonb_typeof(range_row) is distinct from 'object'
                      or jsonb_typeof(range_row->'charStart') is distinct from 'number'
                      or jsonb_typeof(range_row->'charEnd') is distinct from 'number'
                      or range_row->>'charStart' !~ '^[0-9]+$'
                      or range_row->>'charEnd' !~ '^[0-9]+$'
                      or (case when (range_row->>'charStart') ~ '^[0-9]+$' and length(range_row->>'charStart') <= 19 and (range_row->>'charStart')::numeric <= 9223372036854775807::numeric then (range_row->>'charStart')::bigint else null end) is null
                      or (case when (range_row->>'charEnd') ~ '^[0-9]+$' and length(range_row->>'charEnd') <= 19 and (range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (range_row->>'charEnd')::bigint else null end) is null
                      or (case when (range_row->>'charEnd') ~ '^[0-9]+$' and length(range_row->>'charEnd') <= 19 and (range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (range_row->>'charEnd')::bigint else null end) <= (case when (range_row->>'charStart') ~ '^[0-9]+$' and length(range_row->>'charStart') <= 19 and (range_row->>'charStart')::numeric <= 9223372036854775807::numeric then (range_row->>'charStart')::bigint else null end)
                      or exists (select 1 from jsonb_object_keys(range_row) key where key not in ('charStart', 'charEnd'))
                  )
                ))
                or exists (
                  select 1 from jsonb_object_keys(reference_row) key
                  where key not in ('kind', 'documentId', 'versionId', 'publisherExtractionId', 'source', 'ranges', 'purpose')
                )
                or exists (
                  select 1 from jsonb_object_keys(reference_row->'source') key
                  where key not in ('kind', 'sourceId', 'issueId', 'documentId')
                ) then
                raise exception
                  'AI chat schema cutover preflight row ai_observations/%: document retrieval reference is not strict',
                  legacy_row.row_identity;
              end if;
            elsif reference_row->>'kind' = 'chat_message' then
              if jsonb_typeof(reference_row->'kind') is distinct from 'string'
                or jsonb_typeof(reference_row->'messageId') is distinct from 'string'
                or jsonb_typeof(reference_row->'purpose') is distinct from 'string'
                or coalesce(btrim(reference_row->>'messageId'), '') = ''
                or coalesce(btrim(reference_row->>'purpose'), '') = ''
                or exists (
                  select 1 from jsonb_object_keys(reference_row) key
                  where key not in ('kind', 'messageId', 'purpose')
                ) then
                raise exception
                  'AI chat schema cutover preflight row ai_observations/%: chat retrieval reference is not strict',
                  legacy_row.row_identity;
              end if;
            elsif reference_row ? 'memoryId' then
              if jsonb_typeof(reference_row->'memoryId') is distinct from 'string'
                or jsonb_typeof(reference_row->'memoryRevisionId') is distinct from 'string'
                or coalesce(btrim(reference_row->>'memoryId'), '') = ''
                or coalesce(btrim(reference_row->>'memoryRevisionId'), '') = ''
                or exists (
                  select 1 from jsonb_object_keys(reference_row) key
                  where key not in ('memoryId', 'memoryRevisionId')
                ) then
                raise exception
                  'AI chat schema cutover preflight row ai_observations/%: memory retrieval reference is not strict',
                  legacy_row.row_identity;
              end if;
            elsif reference_row ? 'url' then
              if jsonb_typeof(reference_row->'url') is distinct from 'string'
                or jsonb_typeof(reference_row->'title') is distinct from 'string'
                or jsonb_typeof(reference_row->'domain') is distinct from 'string'
                or jsonb_typeof(reference_row->'quote') is distinct from 'string'
                or jsonb_typeof(reference_row->'capturedAt') is distinct from 'string'
                or jsonb_typeof(reference_row->'purpose') is distinct from 'string'
                or (jsonb_exists(reference_row, 'publishedAt')
                  and jsonb_typeof(reference_row->'publishedAt') is distinct from 'string')
                or coalesce(btrim(reference_row->>'url'), '') = ''
                or coalesce(btrim(reference_row->>'title'), '') = ''
                or coalesce(btrim(reference_row->>'domain'), '') = ''
                or coalesce(btrim(reference_row->>'quote'), '') = ''
                or coalesce(btrim(reference_row->>'capturedAt'), '') = ''
                or coalesce(btrim(reference_row->>'purpose'), '') = ''
                or exists (
                  select 1 from jsonb_object_keys(reference_row) key
                  where key not in ('url', 'title', 'domain', 'quote', 'publishedAt', 'capturedAt', 'purpose')
                ) then
                raise exception
                  'AI chat schema cutover preflight row ai_observations/%: web retrieval reference is not strict',
                  legacy_row.row_identity;
              end if;
            elsif reference_row ? 'sourceId' then
              if jsonb_typeof(reference_row->'sourceId') is distinct from 'string'
                or coalesce(btrim(reference_row->>'sourceId'), '') = ''
                or jsonb_typeof(reference_row->'ranges') is distinct from 'array'
                or exists (
                  select 1 from jsonb_array_elements(case when jsonb_typeof(reference_row->'ranges') = 'array'
                    then reference_row->'ranges' else '[]'::jsonb end) range_row
                  where jsonb_typeof(range_row) is distinct from 'object'
                    or jsonb_typeof(range_row->'charStart') is distinct from 'number'
                    or jsonb_typeof(range_row->'charEnd') is distinct from 'number'
                    or range_row->>'charStart' !~ '^[0-9]+$'
                    or range_row->>'charEnd' !~ '^[0-9]+$'
                    or (case when (range_row->>'charStart') ~ '^[0-9]+$' and length(range_row->>'charStart') <= 19 and (range_row->>'charStart')::numeric <= 9223372036854775807::numeric then (range_row->>'charStart')::bigint else null end) is null
                    or (case when (range_row->>'charEnd') ~ '^[0-9]+$' and length(range_row->>'charEnd') <= 19 and (range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (range_row->>'charEnd')::bigint else null end) is null
                    or (case when (range_row->>'charEnd') ~ '^[0-9]+$' and length(range_row->>'charEnd') <= 19 and (range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (range_row->>'charEnd')::bigint else null end) <= (case when (range_row->>'charStart') ~ '^[0-9]+$' and length(range_row->>'charStart') <= 19 and (range_row->>'charStart')::numeric <= 9223372036854775807::numeric then (range_row->>'charStart')::bigint else null end)
                    or exists (select 1 from jsonb_object_keys(range_row) key where key not in ('charStart', 'charEnd'))
                )
                or exists (
                  select 1 from jsonb_object_keys(reference_row) key
                  where key not in ('sourceId', 'ranges')
                ) then
                raise exception
                  'AI chat schema cutover preflight row ai_observations/%: source retrieval reference is not strict',
                  legacy_row.row_identity;
              end if;
            else
              raise exception
                'AI chat schema cutover preflight row ai_observations/%: retrieval reference has an unknown kind',
                legacy_row.row_identity;
            end if;
          end loop;
      elsif legacy_row.kind = 'candidate_rejected' then
        if jsonb_typeof(legacy_row.payload->'candidateId') is distinct from 'string'
          or jsonb_typeof(legacy_row.payload->'reason') is distinct from 'string'
          or coalesce(btrim(legacy_row.payload->>'candidateId'), '') = ''
          or legacy_row.payload->>'reason' not in ('inaccessible', 'missing', 'invalid_range', 'ambiguous_provenance', 'duplicate', 'overlap_merged')
          or exists (select 1 from jsonb_object_keys(legacy_row.payload) key where key not in ('candidateId', 'reason')) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: candidate rejection payload is not strict',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'context_measurement' then
        if jsonb_typeof(legacy_row.payload->'consumerTaskId') is distinct from 'string'
          or (jsonb_exists(legacy_row.payload, 'topicId')
            and (jsonb_typeof(legacy_row.payload->'topicId') is distinct from 'string'
              or legacy_row.payload->>'topicId' not in ('t1', 't2', 't3')))
          or jsonb_typeof(legacy_row.payload->'mandatoryInputTokens') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'discretionaryInputTokens') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'totalInputTokens') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'requestedOutputTokens') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'usableInputTokens') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'contextWindow') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'status') is distinct from 'string'
          or jsonb_typeof(legacy_row.payload->'reductionRan') is distinct from 'boolean'
          or coalesce(btrim(legacy_row.payload->>'consumerTaskId'), '') = ''
          or legacy_row.payload->>'mandatoryInputTokens' !~ '^[0-9]+$'
          or legacy_row.payload->>'discretionaryInputTokens' !~ '^[0-9]+$'
          or legacy_row.payload->>'totalInputTokens' !~ '^[0-9]+$'
          or legacy_row.payload->>'requestedOutputTokens' !~ '^[0-9]+$'
          or legacy_row.payload->>'usableInputTokens' !~ '^[0-9]+$'
          or legacy_row.payload->>'contextWindow' !~ '^[0-9]+$'
          or legacy_row.payload->>'status' not in ('ready', 'needs_reduction')
          or legacy_row.payload->>'reductionRan' not in ('true', 'false')
          or jsonb_typeof(legacy_row.payload->'reductionFeedback') is distinct from 'array'
          or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(legacy_row.payload->'reductionFeedback') = 'array'
                     then legacy_row.payload->'reductionFeedback' else '[]'::jsonb end) feedback
                     where jsonb_typeof(feedback) is distinct from 'string')
          or (case when (legacy_row.payload->>'mandatoryInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'mandatoryInputTokens') <= 19 and (legacy_row.payload->>'mandatoryInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'mandatoryInputTokens')::bigint else null end) is null
          or (case when (legacy_row.payload->>'discretionaryInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'discretionaryInputTokens') <= 19 and (legacy_row.payload->>'discretionaryInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'discretionaryInputTokens')::bigint else null end) is null
          or (case when (legacy_row.payload->>'totalInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'totalInputTokens') <= 19 and (legacy_row.payload->>'totalInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'totalInputTokens')::bigint else null end) is null
          or (case when (legacy_row.payload->>'requestedOutputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'requestedOutputTokens') <= 19 and (legacy_row.payload->>'requestedOutputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'requestedOutputTokens')::bigint else null end) is null
          or (case when (legacy_row.payload->>'usableInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'usableInputTokens') <= 19 and (legacy_row.payload->>'usableInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'usableInputTokens')::bigint else null end) is null
          or (case when (legacy_row.payload->>'contextWindow') ~ '^[0-9]+$' and length(legacy_row.payload->>'contextWindow') <= 19 and (legacy_row.payload->>'contextWindow')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'contextWindow')::bigint else null end) is null
          or (case when (legacy_row.payload->>'mandatoryInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'mandatoryInputTokens') <= 19 and (legacy_row.payload->>'mandatoryInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'mandatoryInputTokens')::bigint else null end) > 9007199254740991
          or (case when (legacy_row.payload->>'discretionaryInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'discretionaryInputTokens') <= 19 and (legacy_row.payload->>'discretionaryInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'discretionaryInputTokens')::bigint else null end) > 9007199254740991
          or (case when (legacy_row.payload->>'totalInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'totalInputTokens') <= 19 and (legacy_row.payload->>'totalInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'totalInputTokens')::bigint else null end) > 9007199254740991
          or (case when (legacy_row.payload->>'requestedOutputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'requestedOutputTokens') <= 19 and (legacy_row.payload->>'requestedOutputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'requestedOutputTokens')::bigint else null end) > 9007199254740991
          or (case when (legacy_row.payload->>'usableInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'usableInputTokens') <= 19 and (legacy_row.payload->>'usableInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'usableInputTokens')::bigint else null end) > 9007199254740991
          or (case when (legacy_row.payload->>'contextWindow') ~ '^[0-9]+$' and length(legacy_row.payload->>'contextWindow') <= 19 and (legacy_row.payload->>'contextWindow')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'contextWindow')::bigint else null end) > 9007199254740991
          or (case when (legacy_row.payload->>'mandatoryInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'mandatoryInputTokens') <= 19 and (legacy_row.payload->>'mandatoryInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'mandatoryInputTokens')::bigint else null end) < 0
          or (case when (legacy_row.payload->>'discretionaryInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'discretionaryInputTokens') <= 19 and (legacy_row.payload->>'discretionaryInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'discretionaryInputTokens')::bigint else null end) < 0
          or (case when (legacy_row.payload->>'totalInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'totalInputTokens') <= 19 and (legacy_row.payload->>'totalInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'totalInputTokens')::bigint else null end) < 0
          or (case when (legacy_row.payload->>'requestedOutputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'requestedOutputTokens') <= 19 and (legacy_row.payload->>'requestedOutputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'requestedOutputTokens')::bigint else null end) <= 0
          or (case when (legacy_row.payload->>'usableInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'usableInputTokens') <= 19 and (legacy_row.payload->>'usableInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'usableInputTokens')::bigint else null end) <= 0
          or (case when (legacy_row.payload->>'contextWindow') ~ '^[0-9]+$' and length(legacy_row.payload->>'contextWindow') <= 19 and (legacy_row.payload->>'contextWindow')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'contextWindow')::bigint else null end) <= (case when (legacy_row.payload->>'requestedOutputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'requestedOutputTokens') <= 19 and (legacy_row.payload->>'requestedOutputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'requestedOutputTokens')::bigint else null end)
          or (case when (legacy_row.payload->>'usableInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'usableInputTokens') <= 19 and (legacy_row.payload->>'usableInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'usableInputTokens')::bigint else null end) > (case when (legacy_row.payload->>'contextWindow') ~ '^[0-9]+$' and length(legacy_row.payload->>'contextWindow') <= 19 and (legacy_row.payload->>'contextWindow')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'contextWindow')::bigint else null end) - (case when (legacy_row.payload->>'requestedOutputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'requestedOutputTokens') <= 19 and (legacy_row.payload->>'requestedOutputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'requestedOutputTokens')::bigint else null end)
          or (case when (legacy_row.payload->>'totalInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'totalInputTokens') <= 19 and (legacy_row.payload->>'totalInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'totalInputTokens')::bigint else null end) <> (case when (legacy_row.payload->>'mandatoryInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'mandatoryInputTokens') <= 19 and (legacy_row.payload->>'mandatoryInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'mandatoryInputTokens')::bigint else null end) + (case when (legacy_row.payload->>'discretionaryInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'discretionaryInputTokens') <= 19 and (legacy_row.payload->>'discretionaryInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'discretionaryInputTokens')::bigint else null end)
          or not coalesce(
            true,
            false
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: context measurement payload is not strict',
            legacy_row.row_identity;
        end if;
        if exists (
          select 1 from jsonb_object_keys(legacy_row.payload) key
          where key not in (
            'consumerTaskId', 'topicId', 'mandatoryInputTokens', 'discretionaryInputTokens',
            'totalInputTokens', 'requestedOutputTokens', 'usableInputTokens', 'contextWindow',
            'status', 'reductionRan', 'reductionFeedback', 'restrictedContextLedger'
          )
        ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: context measurement payload contains an unknown field',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'context_decision' then
        if jsonb_typeof(legacy_row.payload->'valid') is distinct from 'boolean'
          or legacy_row.payload->>'valid' not in ('true', 'false')
          or jsonb_typeof(legacy_row.payload->'decisions') is distinct from 'array'
          or exists (
            select 1 from jsonb_array_elements(case when jsonb_typeof(legacy_row.payload->'decisions') = 'array'
              then legacy_row.payload->'decisions' else '[]'::jsonb end) decision
            where jsonb_typeof(decision) is distinct from 'object'
              or jsonb_typeof(decision->'id') is distinct from 'string'
              or jsonb_typeof(decision->'action') is distinct from 'string'
              or jsonb_typeof(decision->'reason') is distinct from 'string'
              or decision->>'action' not in ('keep', 'range', 'omit')
              or coalesce(btrim(decision->>'id'), '') = ''
              or coalesce(btrim(decision->>'reason'), '') = ''
              or (decision->>'action' = 'range' and (
                jsonb_typeof(decision->'ranges') is distinct from 'array'
                or exists (
                  select 1 from jsonb_array_elements(case when jsonb_typeof(decision->'ranges') = 'array'
                    then decision->'ranges' else '[]'::jsonb end) range_row
                  where jsonb_typeof(range_row) is distinct from 'object'
                    or jsonb_typeof(range_row->'charStart') is distinct from 'number'
                    or jsonb_typeof(range_row->'charEnd') is distinct from 'number'
                    or range_row->>'charStart' !~ '^[0-9]+$'
                    or range_row->>'charEnd' !~ '^[0-9]+$'
                    or (case when (range_row->>'charStart') ~ '^[0-9]+$' and length(range_row->>'charStart') <= 19 and (range_row->>'charStart')::numeric <= 9223372036854775807::numeric then (range_row->>'charStart')::bigint else null end) is null
                    or (case when (range_row->>'charEnd') ~ '^[0-9]+$' and length(range_row->>'charEnd') <= 19 and (range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (range_row->>'charEnd')::bigint else null end) is null
                    or (case when (range_row->>'charEnd') ~ '^[0-9]+$' and length(range_row->>'charEnd') <= 19 and (range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (range_row->>'charEnd')::bigint else null end) <= (case when (range_row->>'charStart') ~ '^[0-9]+$' and length(range_row->>'charStart') <= 19 and (range_row->>'charStart')::numeric <= 9223372036854775807::numeric then (range_row->>'charStart')::bigint else null end)
                    or exists (select 1 from jsonb_object_keys(range_row) key where key not in ('charStart', 'charEnd'))
                )
              ))
              or (decision->>'action' <> 'range' and jsonb_exists(decision, 'ranges'))
              or exists (
                select 1 from jsonb_object_keys(decision) key
                where key not in ('id', 'action', 'ranges', 'reason')
              )
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: context decision payload is not strict',
            legacy_row.row_identity;
        end if;
        if exists (
          select 1 from jsonb_object_keys(legacy_row.payload) key
          where key not in ('valid', 'decisions', 'feedback')
        ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: context decision payload contains an unknown field',
            legacy_row.row_identity;
        end if;
        if jsonb_exists(legacy_row.payload, 'feedback')
          and (jsonb_typeof(legacy_row.payload->'feedback') is distinct from 'array'
            or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(legacy_row.payload->'feedback') = 'array'
                       then legacy_row.payload->'feedback' else '[]'::jsonb end) feedback
                       where jsonb_typeof(feedback) is distinct from 'string')) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: context decision feedback is not an array of strings',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'context_reducer_terminal' then
        if not coalesce(
             true,
             false
           )
          or jsonb_typeof(legacy_row.payload->'modelId') is distinct from 'string'
          or coalesce(btrim(legacy_row.payload->>'modelId'), '') = ''
          or jsonb_typeof(legacy_row.payload->'requestSha256Hex') is distinct from 'string'
          or legacy_row.payload->>'requestSha256Hex' !~ '^[0-9a-f]{64}$'
          or jsonb_typeof(legacy_row.payload->'providerInputTokens') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'totalTokens') is distinct from 'number'
          or legacy_row.payload->>'providerInputTokens' !~ '^[0-9]+$'
          or legacy_row.payload->>'totalTokens' !~ '^[0-9]+$'
          or jsonb_typeof(legacy_row.payload->'stopReason') is distinct from 'string'
          or legacy_row.payload->>'stopReason' not in ('stop', 'length', 'toolUse') then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: context reducer terminal payload is not strict',
            legacy_row.row_identity;
        end if;
        if exists (
          select 1 from jsonb_object_keys(legacy_row.payload) key
          where key not in (
            'terminalUsageCoordinate', 'modelId', 'requestSha256Hex',
            'providerInputTokens', 'totalTokens', 'stopReason'
          )
        ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: context reducer terminal payload contains an unknown field',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'context_serialized' then
        if jsonb_typeof(legacy_row.payload->'consumerTaskId') is distinct from 'string'
          or coalesce(btrim(legacy_row.payload->>'consumerTaskId'), '') = ''
          or (jsonb_exists(legacy_row.payload, 'topicId')
            and (jsonb_typeof(legacy_row.payload->'topicId') is distinct from 'string'
              or legacy_row.payload->>'topicId' not in ('t1', 't2', 't3')))
          or jsonb_typeof(legacy_row.payload->'sourceKeys') is distinct from 'array'
          or exists (
            select 1 from jsonb_array_elements(case when jsonb_typeof(legacy_row.payload->'sourceKeys') = 'array'
              then legacy_row.payload->'sourceKeys' else '[]'::jsonb end) source_key
            where jsonb_typeof(source_key) is distinct from 'string'
              or source_key #>> '{}' !~ '^k_(?:cn_[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]+)_[1-9][0-9]*$'
              or (case when (substring(source_key #>> '{}' from '_([1-9][0-9]*)$')) ~ '^[0-9]+$' and length(substring(source_key #>> '{}' from '_([1-9][0-9]*)$')) <= 19 and (substring(source_key #>> '{}' from '_([1-9][0-9]*)$'))::numeric <= 9223372036854775807::numeric then (substring(source_key #>> '{}' from '_([1-9][0-9]*)$'))::bigint else null end) is null
              or (case when (substring(source_key #>> '{}' from '_([1-9][0-9]*)$')) ~ '^[0-9]+$' and length(substring(source_key #>> '{}' from '_([1-9][0-9]*)$')) <= 19 and (substring(source_key #>> '{}' from '_([1-9][0-9]*)$'))::numeric <= 9223372036854775807::numeric then (substring(source_key #>> '{}' from '_([1-9][0-9]*)$'))::bigint else null end) > 2147483647
          )
          or not coalesce(
            true,
            false
          )
          or not coalesce(
            true,
            false
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: context serialization payload is not strict',
            legacy_row.row_identity;
        end if;
        if exists (
          select 1 from jsonb_object_keys(legacy_row.payload) key
          where key not in (
            'consumerTaskId', 'topicId', 'sourceKeys',
            'restrictedContextLedger', 'terminalUsageCoordinate'
          )
        ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: context serialization payload contains an unknown field',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'retrieval_no_call_seal' then
        if legacy_row.emitting_task <> 'finalize'
          or jsonb_typeof(legacy_row.payload->'selectorTaskId') is distinct from 'string'
          or coalesce(btrim(legacy_row.payload->>'selectorTaskId'), '') = ''
          or jsonb_typeof(legacy_row.payload->'selectorLoopIteration') is distinct from 'number'
          or legacy_row.payload->>'selectorLoopIteration' !~ '^[0-9]+$'
          or jsonb_typeof(legacy_row.payload->'selectorAttempt') is distinct from 'number'
          or legacy_row.payload->>'selectorAttempt' !~ '^[0-9]+$'
          or jsonb_typeof(legacy_row.payload->'selectorObservationKey') is distinct from 'string'
          or legacy_row.payload->>'selectorObservationKey' is distinct from format(
            '%s:%s:%s:retrieval_manifest:result',
            legacy_row.payload->>'selectorTaskId',
            legacy_row.payload->>'selectorLoopIteration',
            legacy_row.payload->>'selectorAttempt'
          )
          or legacy_row.observation_key is distinct from format(
            'retrieval_no_call_seal:%s:%s:%s',
            legacy_row.payload->>'selectorTaskId',
            legacy_row.payload->>'selectorLoopIteration',
            legacy_row.payload->>'selectorAttempt'
          )
          or jsonb_typeof(legacy_row.payload->'noCallReason') is distinct from 'string'
          or legacy_row.payload->>'noCallReason' not in (
            'memory_mode_disabled', 'no_active_memories', 'web_not_requested',
            'web_policy_disabled', 'topic_not_web_eligible'
          )
          or exists (select 1 from jsonb_object_keys(legacy_row.payload) key where key not in (
            'selectorTaskId', 'selectorLoopIteration', 'selectorAttempt',
            'selectorObservationKey', 'noCallReason'
          )) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: retrieval no-call seal is not strict',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'topic_packet' then
        if jsonb_typeof(legacy_row.payload->'topicId') is distinct from 'string'
          or legacy_row.payload->>'topicId' not in ('t1', 't2', 't3')
          or jsonb_typeof(legacy_row.payload->'status') is distinct from 'string'
          or legacy_row.payload->>'status' not in ('answered', 'partial')
          or jsonb_typeof(legacy_row.payload->'sourceKeys') is distinct from 'array'
          or exists (
            select 1 from jsonb_array_elements(case when jsonb_typeof(legacy_row.payload->'sourceKeys') = 'array'
              then legacy_row.payload->'sourceKeys' else '[]'::jsonb end) source_key
            where jsonb_typeof(source_key) is distinct from 'string'
              or source_key #>> '{}' !~ '^k_(?:cn_[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]+)_[1-9][0-9]*$'
              or (case when (substring(source_key #>> '{}' from '_([1-9][0-9]*)$')) ~ '^[0-9]+$' and length(substring(source_key #>> '{}' from '_([1-9][0-9]*)$')) <= 19 and (substring(source_key #>> '{}' from '_([1-9][0-9]*)$'))::numeric <= 9223372036854775807::numeric then (substring(source_key #>> '{}' from '_([1-9][0-9]*)$'))::bigint else null end) is null
              or (case when (substring(source_key #>> '{}' from '_([1-9][0-9]*)$')) ~ '^[0-9]+$' and length(substring(source_key #>> '{}' from '_([1-9][0-9]*)$')) <= 19 and (substring(source_key #>> '{}' from '_([1-9][0-9]*)$'))::numeric <= 9223372036854775807::numeric then (substring(source_key #>> '{}' from '_([1-9][0-9]*)$'))::bigint else null end) > 2147483647
          )
          or jsonb_typeof(legacy_row.payload->'claimCount') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'gapCount') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'packetSha256Hex') is distinct from 'string'
          or legacy_row.payload->>'claimCount' !~ '^[0-9]+$'
          or legacy_row.payload->>'gapCount' !~ '^[0-9]+$'
          or legacy_row.payload->>'packetSha256Hex' !~ '^[0-9a-f]{64}$' then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: topic packet payload is not strict',
            legacy_row.row_identity;
        end if;
        if exists (
          select 1 from jsonb_object_keys(legacy_row.payload) key
          where key not in ('topicId', 'status', 'sourceKeys', 'claimCount', 'gapCount', 'packetSha256Hex')
        ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: topic packet payload contains an unknown field',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'memory_extraction_result' then
        if jsonb_typeof(legacy_row.payload->'proposalCount') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'discardedCount') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'extractionSha256Hex') is distinct from 'string'
          or legacy_row.payload->>'proposalCount' !~ '^[0-9]+$'
          or legacy_row.payload->>'discardedCount' !~ '^[0-9]+$'
          or legacy_row.payload->>'extractionSha256Hex' !~ '^[0-9a-f]{64}$' then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: memory extraction payload is not strict',
            legacy_row.row_identity;
        end if;
        if exists (
          select 1 from jsonb_object_keys(legacy_row.payload) key
          where key not in ('proposalCount', 'discardedCount', 'extractionSha256Hex')
        ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: memory extraction payload contains an unknown field',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'memory_application' then
        if jsonb_typeof(legacy_row.payload->'extractionTaskId') is distinct from 'string'
          or jsonb_typeof(legacy_row.payload->'extractionLoopIteration') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'extractionAttempt') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'extractionObservationKey') is distinct from 'string'
          or jsonb_typeof(legacy_row.payload->'extractionSha256Hex') is distinct from 'string'
          or jsonb_typeof(legacy_row.payload->'proposalCount') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'discardedCount') is distinct from 'number'
          or coalesce(btrim(legacy_row.payload->>'extractionTaskId'), '') = ''
          or legacy_row.payload->>'extractionLoopIteration' !~ '^[0-9]+$'
          or legacy_row.payload->>'extractionAttempt' !~ '^[0-9]+$'
          or coalesce(btrim(legacy_row.payload->>'extractionObservationKey'), '') = ''
          or legacy_row.payload->>'extractionSha256Hex' !~ '^[0-9a-f]{64}$'
          or legacy_row.payload->>'proposalCount' !~ '^[0-9]+$'
          or legacy_row.payload->>'discardedCount' !~ '^[0-9]+$' then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: memory application payload is not strict',
            legacy_row.row_identity;
        end if;
        if exists (select 1 from jsonb_object_keys(legacy_row.payload) key where key not in (
          'extractionTaskId', 'extractionLoopIteration', 'extractionAttempt',
          'extractionObservationKey', 'extractionSha256Hex', 'proposalCount', 'discardedCount'
        )) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: memory application payload contains an unknown field',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'memory_written' then
        if jsonb_typeof(legacy_row.payload->'ordinal') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'memoryId') is distinct from 'string'
          or jsonb_typeof(legacy_row.payload->'revisionId') is distinct from 'string'
          or jsonb_typeof(legacy_row.payload->'action') is distinct from 'string'
          or legacy_row.payload->>'ordinal' !~ '^[0-9]+$'
          or not ((legacy_row.payload->>'memoryId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
          or not ((legacy_row.payload->>'revisionId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
          or legacy_row.payload->>'action' not in ('create', 'update')
          or not (jsonb_exists(legacy_row.payload, 'previousRevisionId'))
          or (jsonb_typeof(legacy_row.payload->'previousRevisionId') not in ('string', 'null'))
          or (jsonb_typeof(legacy_row.payload->'previousRevisionId') = 'string'
            and not ((legacy_row.payload->>'previousRevisionId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
          or (legacy_row.payload->>'action' = 'create' and legacy_row.payload->'previousRevisionId' <> 'null'::jsonb) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: memory write payload is not strict',
            legacy_row.row_identity;
        end if;
        if exists (select 1 from jsonb_object_keys(legacy_row.payload) key where key not in (
          'ordinal', 'memoryId', 'revisionId', 'previousRevisionId', 'action'
        )) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: memory write payload contains an unknown field',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'citation' then
        if jsonb_typeof(legacy_row.payload->'assistantMessageId') is distinct from 'string'
          or jsonb_typeof(legacy_row.payload->'sourceKey') is distinct from 'string'
          or legacy_row.payload->>'assistantMessageId' is distinct from legacy_row.assistant_message_id::text
          or coalesce(btrim(legacy_row.payload->>'sourceKey'), '') = ''
          or not exists (
            select 1
            from assistant_message_sources sources
            where sources.assistant_message_id = legacy_row.assistant_message_id
              and sources.source_key = legacy_row.payload->>'sourceKey'
          )
          or exists (select 1 from jsonb_object_keys(legacy_row.payload) key where key not in ('assistantMessageId', 'sourceKey')) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: citation payload is not bound to its answer source',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'citation_defect' then
        if jsonb_typeof(legacy_row.payload->'token') is distinct from 'string'
          or jsonb_typeof(legacy_row.payload->'reason') is distinct from 'string'
          or coalesce(btrim(legacy_row.payload->>'token'), '') = ''
          or coalesce(btrim(legacy_row.payload->>'reason'), '') = ''
          or exists (select 1 from jsonb_object_keys(legacy_row.payload) key where key not in ('token', 'reason')) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: citation defect payload is not strict',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind in ('answer_started', 'answer_delta', 'answer_completed')
        and legacy_row.payload = '{}'::jsonb then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: answer payload is empty',
          legacy_row.row_identity;
      end if;
    end loop;

  -- Answer lifecycle observations are retained evidence too.  They are small
  -- strict records, so reject wrong array/object values before the cutover can
  -- discard the old owner columns.
  for legacy_row in
      select observations.id::text as row_identity,
             observations.kind,
             observations.payload
      from ai_observations observations
      where observations.kind in ('answer_started', 'answer_delta', 'answer_completed')
      order by observations.id
    loop
      if legacy_row.kind = 'answer_delta' then
        if jsonb_typeof(legacy_row.payload->'delta') is distinct from 'string'
          or exists (
            select 1 from jsonb_object_keys(legacy_row.payload) key
            where key <> 'delta'
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: answer delta payload is not strict',
            legacy_row.row_identity;
        end if;
      elsif jsonb_typeof(legacy_row.payload->'mode') is distinct from 'string'
        or legacy_row.payload->>'mode' not in ('clarification', 'single', 'synthesis')
        or jsonb_typeof(legacy_row.payload->'attempt') is distinct from 'number'
        or legacy_row.payload->>'attempt' !~ '^[0-9]+$'
        or exists (
          select 1 from jsonb_object_keys(legacy_row.payload) key
          where key not in ('mode', 'attempt')
        ) then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: answer lifecycle payload is not strict',
          legacy_row.row_identity;
      end if;
    end loop;

  if exists (
    select 1
    from ai_observations seals
    where seals.kind = 'retrieval_no_call_seal'
      and not exists (
        select 1
        from ai_observations manifests
        where manifests.run_id = seals.run_id
          and manifests.kind = 'retrieval_manifest'
          and manifests.emitting_task = seals.payload->>'selectorTaskId'
          and manifests.loop_iteration = (seals.payload->>'selectorLoopIteration')::integer
          and manifests.attempt = (seals.payload->>'selectorAttempt')::integer
          and manifests.observation_key = seals.payload->>'selectorObservationKey'
          and manifests.payload->>'noCallReason' = seals.payload->>'noCallReason'
      )
  ) then
    raise exception 'AI chat schema cutover preflight row ai_observations: retrieval no-call seal has no exact manifest';
  end if;
  for legacy_row in
      select
        sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
        sources.assistant_message_id,
        sources.source_key,
        sources.kind,
        sources.locator,
        sources.document_version_id,
        sources.publisher_document_version_id,
        sources.message_id,
        sources.memory_revision_id,
        sources.display_label,
        sources.public_provenance,
        sources.source_identity_digest,
        runs.id::text as answer_run_id,
        runs.citation_nonce
      from assistant_message_sources sources
      join chat_messages assistants on assistants.id = sources.assistant_message_id
      left join ai_runs runs on runs.assistant_message_id = assistants.id
      order by sources.assistant_message_id, sources.source_key
    loop
      if legacy_row.answer_run_id is null then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: source has no exact terminal answer run owner',
          legacy_row.row_identity;
      end if;
      if legacy_row.source_key !~ '^k_[A-Za-z0-9_-]+_[1-9][0-9]*$' then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: malformed source key',
          legacy_row.row_identity;
      end if;
      if regexp_replace(legacy_row.source_key, '^k_(.*)_[1-9][0-9]*$', '\1') is distinct from
        translate(rtrim(encode(legacy_row.citation_nonce, 'base64'), '='), '+/', '-_') then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: source key namespace does not match its retained run nonce',
          legacy_row.row_identity;
      end if;
      if legacy_row.source_identity_digest is null
        or legacy_row.source_identity_digest is distinct from assistant_message_source_identity_digest(
          legacy_row.assistant_message_id,
          legacy_row.source_key,
          legacy_row.kind,
          legacy_row.locator,
          legacy_row.document_version_id,
          legacy_row.publisher_document_version_id,
          legacy_row.message_id,
          legacy_row.memory_revision_id,
          legacy_row.display_label,
          legacy_row.public_provenance
        ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: stored source identity digest does not match retained fields',
          legacy_row.row_identity;
      end if;
      if legacy_row.kind = 'document' and (
        legacy_row.document_version_id is null
        or legacy_row.message_id is not null
        or legacy_row.memory_revision_id is not null
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: document identity tuple is incomplete or mixed',
          legacy_row.row_identity;
      end if;
      if legacy_row.kind <> 'document' and (
        legacy_row.document_version_id is not null
        or legacy_row.publisher_document_version_id is not null
        or legacy_row.message_id is not null and legacy_row.kind <> 'chat_message'
        or legacy_row.memory_revision_id is not null and legacy_row.kind <> 'memory'
        or legacy_row.kind = 'chat_message' and legacy_row.message_id is null
        or legacy_row.kind = 'memory' and legacy_row.memory_revision_id is null
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: non-document identity tuple is mixed or incomplete',
          legacy_row.row_identity;
      end if;
    end loop;
  else
    for legacy_row in
        select
          sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
          sources.assistant_message_id,
          sources.source_key,
          sources.kind,
          sources.locator,
          sources.version_id,
          sources.publisher_extraction_id,
          sources.message_id,
          sources.memory_revision_id,
          sources.display_label,
          sources.public_provenance,
          sources.source_identity_digest,
          runs.id::text as answer_run_id,
          runs.citation_namespace
        from assistant_message_sources sources
        left join chat_messages assistants on assistants.id = sources.assistant_message_id
        left join ai_runs runs on runs.assistant_message_id = assistants.id
        order by sources.assistant_message_id, sources.source_key
      loop
        if legacy_row.answer_run_id is null then
          raise exception
            'AI chat schema cutover preflight row assistant_message_sources/%: source has no exact terminal answer run owner',
            legacy_row.row_identity;
        end if;
        if legacy_row.source_key !~ '^k_cn_[A-Za-z0-9_-]{22}_[1-9][0-9]*$'
          or regexp_replace(legacy_row.source_key, '^k_(.*)_[1-9][0-9]*$', '\1') is distinct from legacy_row.citation_namespace then
          raise exception
            'AI chat schema cutover preflight row assistant_message_sources/%: final source key namespace does not match its answer run',
            legacy_row.row_identity;
        end if;
        if legacy_row.source_identity_digest is null
          or legacy_row.source_identity_digest is distinct from assistant_message_source_identity_digest(
            legacy_row.assistant_message_id,
            legacy_row.source_key,
            legacy_row.kind,
            legacy_row.locator,
            legacy_row.version_id,
            legacy_row.publisher_extraction_id,
            legacy_row.message_id,
            legacy_row.memory_revision_id,
            legacy_row.display_label,
            legacy_row.public_provenance
          ) then
          raise exception
            'AI chat schema cutover preflight row assistant_message_sources/%: stored final source identity digest does not match retained fields',
            legacy_row.row_identity;
        end if;
      end loop;
  end if;

  -- On an idempotent rerun the typed document-version columns are gone.  The
  -- canonical columns still need the same exact publisher tuple check as the
  -- first conversion pass; a broad document/version match is not enough.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'assistant_message_sources'
      and column_name = 'document_version_id'
  ) then
    for legacy_row in
        select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
        from assistant_message_sources sources
        where sources.kind = 'document'
          and sources.document_source_id like 'publisher:%'
          and not exists (
            select 1
            from brief_document_versions versions
            join brief_document_extractions extractions
              on extractions.id = versions.publisher_extraction_id
            join brief_documents documents on documents.id = versions.brief_document_id
            join publisher_issues issues on issues.id = documents.issue_id
            join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
            where versions.id::text = sources.version_id
              and versions.brief_document_id::text = sources.document_id
              and versions.publisher_extraction_id = sources.publisher_extraction_id
              and extractions.brief_document_id = documents.id
              and extractions.input_sha256_hex = documents.sha256_hex
              and sources.document_source_id = 'publisher:' || subscriptions.id::text
              and sources.locator->>'sourceId' = sources.document_source_id
              and sources.locator->>'documentId' = documents.id::text
              and sources.locator->>'publisherIssueId' = issues.id::text
              and sources.locator->>'publisherDocumentId' = documents.id::text
              and sources.locator->>'publisherExtractionId' = extractions.id::text
              and sources.locator->>'versionId' = versions.id::text
              and sources.locator->>'contentHash' = versions.content_hash
              and sources.content_hash = versions.content_hash
              and versions.content_hash = encode(digest(convert_to(versions.canonical_text, 'UTF8'), 'sha256'), 'hex')
              and versions.canonical_text = (
                select string_agg(page->>'text', E'\n\n' order by (case when (page->>'pageNumber') ~ '^[0-9]+$' and length(page->>'pageNumber') <= 19 and (page->>'pageNumber')::numeric <= 9223372036854775807::numeric then (page->>'pageNumber')::bigint else null end))
                from jsonb_array_elements(extractions.pages) page
              )
              and versions.text_char_count = (char_length(versions.canonical_text) + (select count(*) from generate_series(1, char_length(versions.canonical_text)) positions(position) where octet_length(convert_to(substr(versions.canonical_text, positions.position, 1), 'UTF8')) = 4))
              and sources.publisher_extraction_id = extractions.id
          )
        order by sources.assistant_message_id, sources.source_key
      loop
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: canonical publisher locator is not bound to its exact issue/subscription/document/version/extraction tuple',
          legacy_row.row_identity;
      end loop;
  end if;

  for legacy_row in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      where exists (
        select 1
        from assistant_message_sources duplicate_sources
        where duplicate_sources.assistant_message_id = sources.assistant_message_id
          and duplicate_sources.source_key <> sources.source_key
          and duplicate_sources.kind = sources.kind
          and (
            (sources.kind = 'document' and duplicate_sources.locator = sources.locator)
            or (sources.kind = 'chat_message' and duplicate_sources.locator->>'messageId' = sources.locator->>'messageId')
            or (sources.kind = 'memory' and duplicate_sources.locator->>'memoryRevisionId' = sources.locator->>'memoryRevisionId')
            or (sources.kind = 'web' and duplicate_sources.locator->>'quoteHash' = sources.locator->>'quoteHash'
              and duplicate_sources.locator->>'url' = sources.locator->>'url')
          )
      )
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: source identity is duplicated in this answer',
        legacy_row.row_identity;
    end loop;

  -- Apply the same locator checks on an idempotent rerun, after the old
  -- typed source columns have already been removed.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'assistant_message_sources'
      and column_name = 'document_version_id'
  ) then
  for legacy_row in
      select
        sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
        sources.assistant_message_id,
        sources.kind,
        sources.locator,
        sources.message_id
      from assistant_message_sources sources
      order by sources.assistant_message_id, sources.source_key
    loop
      if legacy_row.kind = 'document' and (
        legacy_row.locator->>'sourceId' !~ '^((public|publisher):[^:[:space:]]+)$'
        or position(chr(65279) in legacy_row.locator->>'sourceId') > 0
        or coalesce(btrim(legacy_row.locator->>'documentId'), '') = ''
        or coalesce(btrim(legacy_row.locator->>'versionId'), '') = ''
        or legacy_row.locator->>'contentHash' !~ '^[0-9a-f]{64}$'
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: document locator is not canonical',
          legacy_row.row_identity;
      end if;
      if legacy_row.kind = 'chat_message' and (
        legacy_row.message_id is null
        or legacy_row.locator->>'messageId' is distinct from legacy_row.message_id::text
        or not exists (
          select 1
          from chat_messages referenced
          join chat_messages assistants on assistants.id = legacy_row.assistant_message_id
          where referenced.id = legacy_row.message_id
            and referenced.chat_id = assistants.chat_id
        )
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: chat-message locator is not owned by the answer chat',
          legacy_row.row_identity;
      end if;
      if legacy_row.kind = 'web' and (
        coalesce(btrim(legacy_row.locator->>'quote'), '') = ''
        or legacy_row.locator->>'quoteHash' is distinct from translate(
          rtrim(encode(digest(convert_to(btrim(normalize(replace(replace(legacy_row.locator->>'quote', E'\r\n', E'\n'), E'\r', E'\n'), NFC)), 'UTF8'), 'sha256'), 'base64'), '='),
          '+/', '-_'
        )
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: web quotation hash does not match its quote',
          legacy_row.row_identity;
      end if;
    end loop;
  end if;

  for legacy_row in
      select
        uses.assistant_message_id::text || '/' || uses.source_key || '/' || uses.consumer_task_id || '/' || coalesce(uses.topic_id, '-') as row_identity,
        uses.assistant_message_id,
        uses.source_key,
        uses.consumer_task_id,
        uses.topic_id,
        uses.rendered_token_count,
        uses.context_order,
        uses.ranges,
        uses.source_use_identity_digest,
        sources.kind as source_kind,
        sources.locator as source_locator
      from assistant_message_source_uses uses
      left join assistant_message_sources sources
        on sources.assistant_message_id = uses.assistant_message_id
       and sources.source_key = uses.source_key
      order by uses.assistant_message_id, uses.source_key, uses.consumer_task_id
    loop
      if legacy_row.source_use_identity_digest is null
        or legacy_row.source_use_identity_digest is distinct from assistant_message_source_use_identity_digest(
          legacy_row.assistant_message_id,
          legacy_row.source_key,
          legacy_row.consumer_task_id,
          legacy_row.topic_id,
          legacy_row.rendered_token_count,
          legacy_row.context_order,
          legacy_row.ranges
        ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_source_uses/%: stored source-use identity digest does not match retained fields',
          legacy_row.row_identity;
      end if;
      if jsonb_typeof(legacy_row.ranges) is distinct from 'array'
        or legacy_row.rendered_token_count < 0
        or legacy_row.context_order < 0 then
        raise exception
          'AI chat schema cutover preflight row assistant_message_source_uses/%: source-use range or count is invalid',
          legacy_row.row_identity;
      end if;
      if exists (
        select 1 from jsonb_array_elements(legacy_row.ranges) range_row
        where jsonb_typeof(range_row) <> 'object'
      ) or exists (
        select 1 from jsonb_array_elements(legacy_row.ranges) range_row
        where range_row->>'charStart' is null
          or range_row->>'charStart' !~ '^[0-9]+$'
          or range_row->>'charEnd' is null
          or range_row->>'charEnd' !~ '^[0-9]+$'
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_source_uses/%: source-use range endpoints are not non-negative integers',
          legacy_row.row_identity;
      end if;
      if exists (
        select 1 from jsonb_array_elements(legacy_row.ranges) range_row
        where (case when (range_row->>'charEnd') ~ '^[0-9]+$' and length(range_row->>'charEnd') <= 19 and (range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (range_row->>'charEnd')::bigint else null end) <= (case when (range_row->>'charStart') ~ '^[0-9]+$' and length(range_row->>'charStart') <= 19 and (range_row->>'charStart')::numeric <= 9223372036854775807::numeric then (range_row->>'charStart')::bigint else null end)
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_source_uses/%: source-use range is empty or reversed',
          legacy_row.row_identity;
      end if;
      if exists (
        select 1
        from jsonb_array_elements(legacy_row.ranges) with ordinality left_range(range_row, ordinal)
        join jsonb_array_elements(legacy_row.ranges) with ordinality right_range(range_row, ordinal)
          on right_range.ordinal = left_range.ordinal + 1
        where (case when (right_range.range_row->>'charStart') ~ '^[0-9]+$' and length(right_range.range_row->>'charStart') <= 19 and (right_range.range_row->>'charStart')::numeric <= 9223372036854775807::numeric then (right_range.range_row->>'charStart')::bigint else null end) <
              (case when (left_range.range_row->>'charEnd') ~ '^[0-9]+$' and length(left_range.range_row->>'charEnd') <= 19 and (left_range.range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (left_range.range_row->>'charEnd')::bigint else null end)
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_source_uses/%: source-use ranges overlap or are not normalized',
          legacy_row.row_identity;
      end if;
      if not exists (
        select 1
        from assistant_message_sources sources
        join chat_messages assistants on assistants.id = sources.assistant_message_id
        join ai_runs runs on runs.assistant_message_id = assistants.id
        where sources.assistant_message_id = legacy_row.assistant_message_id
          and sources.source_key = legacy_row.source_key
          and assistants.id = legacy_row.assistant_message_id
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_source_uses/%: source use has no exact assistant/run owner',
          legacy_row.row_identity;
      end if;
      if legacy_row.source_kind is null then
        raise exception
          'AI chat schema cutover preflight row assistant_message_source_uses/%: source use has no exact source owner',
          legacy_row.row_identity;
      end if;
      if legacy_row.source_kind <> 'document' and jsonb_array_length(legacy_row.ranges) <> 0 then
        raise exception
          'AI chat schema cutover preflight row assistant_message_source_uses/%: non-document source use must have empty ranges',
          legacy_row.row_identity;
      end if;
      if legacy_row.source_kind = 'document' and exists (
        select 1
        from jsonb_array_elements(legacy_row.ranges) use_range
        where not exists (
          select 1
          from jsonb_array_elements(legacy_row.source_locator->'ranges') locator_range
          where (case when (use_range->>'charStart') ~ '^[0-9]+$' and length(use_range->>'charStart') <= 19 and (use_range->>'charStart')::numeric <= 9223372036854775807::numeric then (use_range->>'charStart')::bigint else null end) >= (case when (locator_range->>'charStart') ~ '^[0-9]+$' and length(locator_range->>'charStart') <= 19 and (locator_range->>'charStart')::numeric <= 9223372036854775807::numeric then (locator_range->>'charStart')::bigint else null end)
            and (case when (use_range->>'charEnd') ~ '^[0-9]+$' and length(use_range->>'charEnd') <= 19 and (use_range->>'charEnd')::numeric <= 9223372036854775807::numeric then (use_range->>'charEnd')::bigint else null end) <= (case when (locator_range->>'charEnd') ~ '^[0-9]+$' and length(locator_range->>'charEnd') <= 19 and (locator_range->>'charEnd')::numeric <= 9223372036854775807::numeric then (locator_range->>'charEnd')::bigint else null end)
        )
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_source_uses/%: source-use range is outside its immutable source locator',
          legacy_row.row_identity;
      end if;
    end loop;

  for legacy_row in
      select
        tools.id::text as row_identity,
        tools.task_id,
        tools.loop_iteration,
        tools.attempt,
        tools.tool_request_index,
        tools.provider_service_id,
        tools.operation,
        tools.status,
        tools.result_count,
        tools.response_bytes,
        tools.billed_units,
        tools.duration_ms
      from ai_external_tool_usage tools
      order by tools.id
    loop
      if legacy_row.task_id !~ '^(single-retrieve-web|topic-t[123]-retrieve-web|evaluation-general-planner)$'
        or legacy_row.loop_iteration < 0
        or legacy_row.attempt < 0
        or legacy_row.tool_request_index < 0
        or coalesce(btrim(legacy_row.provider_service_id), '') = ''
        or legacy_row.operation not in ('web_search', 'web_fetch')
        or legacy_row.status not in ('ok', 'empty', 'failed')
        or legacy_row.result_count < 0
        or legacy_row.response_bytes < 0
        or legacy_row.billed_units is not null and legacy_row.billed_units < 0
        or legacy_row.duration_ms < 0 then
        raise exception
          'AI chat schema cutover preflight row ai_external_tool_usage/%: external tool ledger identity or metrics are not canonical',
          legacy_row.row_identity;
      end if;
    end loop;

  -- A source-use ledger is sparse by source ordinal but dense by consumer
  -- context order.  Check the latter with the exact composite row identity.
  for legacy_row in
      select
        uses.assistant_message_id::text || '/' || uses.source_key || '/' || uses.consumer_task_id || '/' || coalesce(uses.topic_id, '-') as row_identity,
        uses.context_order,
        (row_number() over (
          partition by uses.assistant_message_id, uses.consumer_task_id, uses.topic_id
          order by uses.context_order, uses.source_key
        ) - 1)::integer as expected_context_order
      from assistant_message_source_uses uses
      order by uses.assistant_message_id, uses.consumer_task_id, uses.topic_id,
               uses.context_order, uses.source_key
    loop
      if legacy_row.context_order <> legacy_row.expected_context_order then
        raise exception
          'AI chat schema cutover preflight row assistant_message_source_uses/%: context orders must be unique and contiguous from zero (found %, expected %)',
          legacy_row.row_identity,
          legacy_row.context_order,
          legacy_row.expected_context_order;
      end if;
    end loop;

  -- Reject legacy payload names before any kind-specific cast or digest
  -- reconstruction. This keeps malformed retained rows on the read-only
  -- blocker path and reports the exact observation or event identity.
  for legacy_row in
      select observations.id::text as row_identity,
             observations.kind as row_kind,
             observations.payload as row_payload
      from ai_observations observations
      order by observations.id
    loop
      if legacy_row.row_kind in ('conversation_resolution', 'execution_plan', 'provider_request_attestation') then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: legacy observation kind % requires explicit conversion',
          legacy_row.row_identity,
          legacy_row.row_kind;
      end if;
    end loop;
  for legacy_row in
      select events.id::text as row_identity, events.event as row_payload
      from ai_run_events events
      order by events.id
    loop
    end loop;

  -- Provider measurements, source attestations, and usage form one exact
  -- owner/coordinate ledger.  Do not accept a role, model, payload, or
  -- observation key that cannot be recomputed from those coordinates.
  for legacy_row in
      select observations.id::text as row_identity,
             observations.run_id,
             observations.chat_id,
             observations.emitting_task,
             observations.loop_iteration,
             observations.attempt,
             observations.observation_key,
             observations.kind,
             observations.payload,
             runs.chat_id as run_chat_id
      from ai_observations observations
      join ai_runs runs on runs.id = observations.run_id
      order by observations.id
    loop
      if legacy_row.loop_iteration < 0
        or legacy_row.attempt < 0
        or coalesce(btrim(legacy_row.emitting_task), '') = ''
        or coalesce(btrim(legacy_row.observation_key), '') = '' then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: observation coordinates or owner are not canonical',
          legacy_row.row_identity;
      end if;
      if legacy_row.chat_id is distinct from legacy_row.run_chat_id then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: observation chat owner differs from its run',
          legacy_row.row_identity;
      end if;
      if legacy_row.kind in ('conversation_resolution', 'execution_plan', 'provider_request_attestation') then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: legacy observation kind % requires explicit conversion',
          legacy_row.row_identity,
          legacy_row.kind;
      end if;
      if legacy_row.kind in (
        'turn_plan', 'retrieval_manifest', 'retrieval_no_call_seal', 'candidate_rejected', 'context_measurement', 'context_decision',
        'context_reducer_terminal', 'context_serialized', 'topic_packet',
        'memory_extraction_result', 'memory_application', 'memory_written',
        'answer_started', 'answer_delta', 'answer_completed', 'citation',
        'citation_defect', 'provider_request_measurement',
        'source_exposure_attestation'
      ) is not true then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: unknown or legacy observation kind %',
          legacy_row.row_identity,
          legacy_row.kind;
      end if;
      if legacy_row.payload is null or jsonb_typeof(legacy_row.payload) <> 'object' then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: payload must be a JSON object',
          legacy_row.row_identity;
      end if;
      if legacy_row.kind in ('provider_request_measurement', 'source_exposure_attestation')
        and legacy_row.emitting_task !~ '^(plan-turn|memory-extract|evaluation-general-planner|single-(retrieve-internal|select-memories|retrieve-web|measure|reduce-plan|reduce-measure|context-select|answer|assemble)|topic-t[123]-(retrieve-internal|select-memories|retrieve-web|measure|reduce-plan|reduce-measure|context-select|answer|assemble)|fanout-synthesis|clarification-result|migration_backfill)$' then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: provider observation has a foreign task owner %',
          legacy_row.row_identity,
          legacy_row.emitting_task;
      end if;
      if legacy_row.kind = 'provider_request_measurement' then
        if legacy_row.observation_key <> format(
          'provider_request_measurement:%s:%s:%s:%s',
          legacy_row.emitting_task,
          legacy_row.loop_iteration,
          legacy_row.attempt,
          legacy_row.payload->>'providerRequestIndex'
        ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: provider measurement key is not recomputable from its coordinates',
            legacy_row.row_identity;
        end if;
        if legacy_row.payload->>'agentRole' is distinct from (
          case
          when legacy_row.emitting_task = 'plan-turn' then 'plan_turn'
          when legacy_row.emitting_task = 'memory-extract' then 'memory_extractor'
          when legacy_row.emitting_task = 'evaluation-general-planner' then 'evaluation_general_planner'
          when legacy_row.emitting_task like '%retrieve-internal' then 'internal_retrieval'
          when legacy_row.emitting_task like '%select-memories' then 'memory_selector'
          when legacy_row.emitting_task like '%retrieve-web' then 'web_research'
          when legacy_row.emitting_task like '%reduce-plan' then 'context_reducer'
          when legacy_row.emitting_task like '%answer' and legacy_row.emitting_task like 'topic-%' then 'topic_answer'
          when legacy_row.emitting_task = 'single-answer' then 'direct_answer'
          when legacy_row.emitting_task = 'fanout-synthesis' then 'synthesis'
          else null
          end
        ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: provider measurement role is not owned by its task',
            legacy_row.row_identity;
        end if;
        if legacy_row.payload->>'modelId' is distinct from 'glm-5-turbo'
          or jsonb_typeof(legacy_row.payload->'agentRole') is distinct from 'string'
          or jsonb_typeof(legacy_row.payload->'modelId') is distinct from 'string'
          or jsonb_typeof(legacy_row.payload->'requestSha256Hex') is distinct from 'string'
          or jsonb_typeof(legacy_row.payload->'providerRequestIndex') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'inputTokens') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'requestedOutputTokens') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'usableInputTokens') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'contextWindow') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'passed') is distinct from 'boolean'
          or legacy_row.payload->>'requestSha256Hex' is null
          or legacy_row.payload->>'requestSha256Hex' !~ '^[0-9a-f]{64}$'
          or legacy_row.payload->>'providerRequestIndex' is null
          or legacy_row.payload->>'providerRequestIndex' !~ '^[0-9]+$'
          or (case when (legacy_row.payload->>'providerRequestIndex') ~ '^[0-9]+$' and length(legacy_row.payload->>'providerRequestIndex') <= 19 and (legacy_row.payload->>'providerRequestIndex')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'providerRequestIndex')::bigint else null end) is null
          or (case when (legacy_row.payload->>'providerRequestIndex') ~ '^[0-9]+$' and length(legacy_row.payload->>'providerRequestIndex') <= 19 and (legacy_row.payload->>'providerRequestIndex')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'providerRequestIndex')::bigint else null end) > 9007199254740991
          or legacy_row.payload->>'inputTokens' is null
          or legacy_row.payload->>'inputTokens' !~ '^[0-9]+$'
          or (case when (legacy_row.payload->>'inputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'inputTokens') <= 19 and (legacy_row.payload->>'inputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'inputTokens')::bigint else null end) is null
          or (case when (legacy_row.payload->>'inputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'inputTokens') <= 19 and (legacy_row.payload->>'inputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'inputTokens')::bigint else null end) > 9007199254740991
          or legacy_row.payload->>'requestedOutputTokens' is null
          or legacy_row.payload->>'requestedOutputTokens' !~ '^[0-9]+$'
          or (case when (legacy_row.payload->>'requestedOutputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'requestedOutputTokens') <= 19 and (legacy_row.payload->>'requestedOutputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'requestedOutputTokens')::bigint else null end) is null
          or (case when (legacy_row.payload->>'requestedOutputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'requestedOutputTokens') <= 19 and (legacy_row.payload->>'requestedOutputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'requestedOutputTokens')::bigint else null end) <= 0
          or (case when (legacy_row.payload->>'requestedOutputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'requestedOutputTokens') <= 19 and (legacy_row.payload->>'requestedOutputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'requestedOutputTokens')::bigint else null end) > 9007199254740991
          or legacy_row.payload->>'usableInputTokens' is null
          or legacy_row.payload->>'usableInputTokens' !~ '^[0-9]+$'
          or (case when (legacy_row.payload->>'usableInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'usableInputTokens') <= 19 and (legacy_row.payload->>'usableInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'usableInputTokens')::bigint else null end) is null
          or (case when (legacy_row.payload->>'usableInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'usableInputTokens') <= 19 and (legacy_row.payload->>'usableInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'usableInputTokens')::bigint else null end) <= 0
          or (case when (legacy_row.payload->>'usableInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'usableInputTokens') <= 19 and (legacy_row.payload->>'usableInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'usableInputTokens')::bigint else null end) > 9007199254740991
          or legacy_row.payload->>'contextWindow' is null
          or legacy_row.payload->>'contextWindow' !~ '^[0-9]+$'
          or (case when (legacy_row.payload->>'contextWindow') ~ '^[0-9]+$' and length(legacy_row.payload->>'contextWindow') <= 19 and (legacy_row.payload->>'contextWindow')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'contextWindow')::bigint else null end) is null
          or (case when (legacy_row.payload->>'contextWindow') ~ '^[0-9]+$' and length(legacy_row.payload->>'contextWindow') <= 19 and (legacy_row.payload->>'contextWindow')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'contextWindow')::bigint else null end) > 9007199254740991
          or legacy_row.payload->>'passed' is null
          or legacy_row.payload->>'passed' <> 'true'
          or (case when (legacy_row.payload->>'inputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'inputTokens') <= 19 and (legacy_row.payload->>'inputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'inputTokens')::bigint else null end) > (case when (legacy_row.payload->>'usableInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'usableInputTokens') <= 19 and (legacy_row.payload->>'usableInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'usableInputTokens')::bigint else null end)
          or (case when (legacy_row.payload->>'contextWindow') ~ '^[0-9]+$' and length(legacy_row.payload->>'contextWindow') <= 19 and (legacy_row.payload->>'contextWindow')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'contextWindow')::bigint else null end) <= (case when (legacy_row.payload->>'requestedOutputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'requestedOutputTokens') <= 19 and (legacy_row.payload->>'requestedOutputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'requestedOutputTokens')::bigint else null end)
          or (case when (legacy_row.payload->>'usableInputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'usableInputTokens') <= 19 and (legacy_row.payload->>'usableInputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'usableInputTokens')::bigint else null end) > (case when (legacy_row.payload->>'contextWindow') ~ '^[0-9]+$' and length(legacy_row.payload->>'contextWindow') <= 19 and (legacy_row.payload->>'contextWindow')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'contextWindow')::bigint else null end) - (case when (legacy_row.payload->>'requestedOutputTokens') ~ '^[0-9]+$' and length(legacy_row.payload->>'requestedOutputTokens') <= 19 and (legacy_row.payload->>'requestedOutputTokens')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'requestedOutputTokens')::bigint else null end)
          or jsonb_typeof(legacy_row.payload->'sourceExposureProofSha256Hexes') is distinct from 'array'
          or exists (
            select 1 from jsonb_array_elements(case when jsonb_typeof(legacy_row.payload->'sourceExposureProofSha256Hexes') = 'array'
              then legacy_row.payload->'sourceExposureProofSha256Hexes' else '[]'::jsonb end) proof_value
            where jsonb_typeof(proof_value) is distinct from 'string'
          )
          or exists (
            select 1 from jsonb_array_elements_text(case when jsonb_typeof(legacy_row.payload->'sourceExposureProofSha256Hexes') = 'array'
              then legacy_row.payload->'sourceExposureProofSha256Hexes' else '[]'::jsonb end) proof
            where proof !~ '^[0-9a-f]{64}$'
          )
          or legacy_row.payload->'sourceExposureProofSha256Hexes' <>
            coalesce((
              select jsonb_agg(to_jsonb(proof) order by proof)
              from jsonb_array_elements_text(case when jsonb_typeof(legacy_row.payload->'sourceExposureProofSha256Hexes') = 'array'
                then legacy_row.payload->'sourceExposureProofSha256Hexes' else '[]'::jsonb end) proof
            ), '[]'::jsonb)
          or (case when jsonb_typeof(legacy_row.payload->'sourceExposureProofSha256Hexes') = 'array'
            then jsonb_array_length(legacy_row.payload->'sourceExposureProofSha256Hexes') else -1 end) <> (
            select count(distinct proof)
            from jsonb_array_elements_text(case when jsonb_typeof(legacy_row.payload->'sourceExposureProofSha256Hexes') = 'array'
              then legacy_row.payload->'sourceExposureProofSha256Hexes' else '[]'::jsonb end) proof
          )
          or (jsonb_array_length(legacy_row.payload->'sourceExposureProofSha256Hexes') > 0
            and jsonb_typeof(legacy_row.payload->'sourceExposureProofBindings') is distinct from 'array')
          or exists (
            select 1
            from jsonb_array_elements(case when jsonb_typeof(legacy_row.payload->'sourceExposureProofBindings') = 'array'
              then legacy_row.payload->'sourceExposureProofBindings' else '[]'::jsonb end) binding_row
            where jsonb_typeof(binding_row) is distinct from 'object'
              or jsonb_typeof(binding_row->'providerSerializationProofSha256Hex') is distinct from 'string'
              or binding_row->>'providerSerializationProofSha256Hex' !~ '^[0-9a-f]{64}$'
              or jsonb_typeof(binding_row->'providerSerializationProofBinding') is distinct from 'object'
              or jsonb_typeof(binding_row->'providerSerializationProofBinding'->'messageIndex') is distinct from 'number'
              or jsonb_typeof(binding_row->'providerSerializationProofBinding'->'sourceOrdinal') is distinct from 'number'
              or jsonb_typeof(binding_row->'providerSerializationProofBinding'->'serializedField') is distinct from 'string'
              or jsonb_typeof(binding_row->'providerSerializationProofBinding'->'orderedSourceDescriptor') is distinct from 'string'
              or binding_row->'providerSerializationProofBinding'->>'messageIndex' !~ '^[0-9]+$'
              or binding_row->'providerSerializationProofBinding'->>'sourceOrdinal' !~ '^[0-9]+$'
              or (case when (binding_row->'providerSerializationProofBinding'->>'messageIndex') ~ '^[0-9]+$' and length(binding_row->'providerSerializationProofBinding'->>'messageIndex') <= 19 and (binding_row->'providerSerializationProofBinding'->>'messageIndex')::numeric <= 9223372036854775807::numeric then (binding_row->'providerSerializationProofBinding'->>'messageIndex')::bigint else null end) is null
              or (case when (binding_row->'providerSerializationProofBinding'->>'sourceOrdinal') ~ '^[0-9]+$' and length(binding_row->'providerSerializationProofBinding'->>'sourceOrdinal') <= 19 and (binding_row->'providerSerializationProofBinding'->>'sourceOrdinal')::numeric <= 9223372036854775807::numeric then (binding_row->'providerSerializationProofBinding'->>'sourceOrdinal')::bigint else null end) is null
              or (case when (binding_row->'providerSerializationProofBinding'->>'messageIndex') ~ '^[0-9]+$' and length(binding_row->'providerSerializationProofBinding'->>'messageIndex') <= 19 and (binding_row->'providerSerializationProofBinding'->>'messageIndex')::numeric <= 9223372036854775807::numeric then (binding_row->'providerSerializationProofBinding'->>'messageIndex')::bigint else null end) > 9007199254740991
              or (case when (binding_row->'providerSerializationProofBinding'->>'sourceOrdinal') ~ '^[0-9]+$' and length(binding_row->'providerSerializationProofBinding'->>'sourceOrdinal') <= 19 and (binding_row->'providerSerializationProofBinding'->>'sourceOrdinal')::numeric <= 9223372036854775807::numeric then (binding_row->'providerSerializationProofBinding'->>'sourceOrdinal')::bigint else null end) > 9007199254740991
              or coalesce(btrim(binding_row->'providerSerializationProofBinding'->>'serializedField'), '') = ''
              or coalesce(btrim(binding_row->'providerSerializationProofBinding'->>'orderedSourceDescriptor'), '') = ''
              or (jsonb_exists(binding_row->'providerSerializationProofBinding', 'characterOffset') and (
                jsonb_typeof(binding_row->'providerSerializationProofBinding'->'characterOffset') is distinct from 'number'
                or binding_row->'providerSerializationProofBinding'->>'characterOffset' !~ '^[0-9]+$'
                or (case when (binding_row->'providerSerializationProofBinding'->>'characterOffset') ~ '^[0-9]+$' and length(binding_row->'providerSerializationProofBinding'->>'characterOffset') <= 19 and (binding_row->'providerSerializationProofBinding'->>'characterOffset')::numeric <= 9223372036854775807::numeric then (binding_row->'providerSerializationProofBinding'->>'characterOffset')::bigint else null end) is null
                or (case when (binding_row->'providerSerializationProofBinding'->>'characterOffset') ~ '^[0-9]+$' and length(binding_row->'providerSerializationProofBinding'->>'characterOffset') <= 19 and (binding_row->'providerSerializationProofBinding'->>'characterOffset')::numeric <= 9223372036854775807::numeric then (binding_row->'providerSerializationProofBinding'->>'characterOffset')::bigint else null end) > 9007199254740991
              ))
              or (jsonb_exists(binding_row->'providerSerializationProofBinding', 'publicDocumentId') and (
                jsonb_typeof(binding_row->'providerSerializationProofBinding'->'publicDocumentId') is distinct from 'string'
                or coalesce(btrim(binding_row->'providerSerializationProofBinding'->>'publicDocumentId'), '') = ''
              ))
              or exists (select 1 from jsonb_object_keys(binding_row) key where key not in ('providerSerializationProofSha256Hex', 'providerSerializationProofBinding'))
              or exists (select 1 from jsonb_object_keys(binding_row->'providerSerializationProofBinding') key where key not in (
                'messageIndex', 'sourceOrdinal', 'serializedField', 'characterOffset', 'orderedSourceDescriptor', 'publicDocumentId'
              ))
          )
          or (jsonb_array_length(legacy_row.payload->'sourceExposureProofSha256Hexes') = 0
            and jsonb_exists(legacy_row.payload, 'sourceExposureProofBindings')
            and (jsonb_typeof(legacy_row.payload->'sourceExposureProofBindings') is distinct from 'array'
              or jsonb_array_length(legacy_row.payload->'sourceExposureProofBindings') <> 0)) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: provider measurement payload is not strict or passed',
            legacy_row.row_identity;
        end if;
        if exists (
          select 1 from jsonb_object_keys(legacy_row.payload) key
          where key not in (
            'agentRole', 'modelId', 'requestSha256Hex',
            'sourceExposureProofSha256Hexes', 'providerRequestIndex',
            'sourceExposureProofBindings',
            'inputTokens', 'requestedOutputTokens', 'usableInputTokens',
            'contextWindow', 'passed'
          )
        ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: provider measurement payload contains an unknown field',
            legacy_row.row_identity;
        end if;
      end if;
      if legacy_row.kind = 'source_exposure_attestation' then
        if jsonb_exists(legacy_row.payload, 'providerSerializationProofBinding') then
          binding_text := format(
            '{%s"messageIndex":%s,"orderedSourceDescriptor":%s%s,"serializedField":%s,"sourceOrdinal":%s}',
            case when jsonb_exists(legacy_row.payload->'providerSerializationProofBinding', 'characterOffset')
              then format('"characterOffset":%s,', (case when (legacy_row.payload->'providerSerializationProofBinding'->>'characterOffset') ~ '^[0-9]+$' and length(legacy_row.payload->'providerSerializationProofBinding'->>'characterOffset') <= 19 and (legacy_row.payload->'providerSerializationProofBinding'->>'characterOffset')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->'providerSerializationProofBinding'->>'characterOffset')::bigint else null end))
              else '' end,
            (case when (legacy_row.payload->'providerSerializationProofBinding'->>'messageIndex') ~ '^[0-9]+$' and length(legacy_row.payload->'providerSerializationProofBinding'->>'messageIndex') <= 19 and (legacy_row.payload->'providerSerializationProofBinding'->>'messageIndex')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->'providerSerializationProofBinding'->>'messageIndex')::bigint else null end),
            to_json(legacy_row.payload->'providerSerializationProofBinding'->>'orderedSourceDescriptor'),
            case when jsonb_exists(legacy_row.payload->'providerSerializationProofBinding', 'publicDocumentId')
              then format(',"publicDocumentId":%s', to_json(legacy_row.payload->'providerSerializationProofBinding'->>'publicDocumentId'))
              else '' end,
            to_json(legacy_row.payload->'providerSerializationProofBinding'->>'serializedField'),
            (case when (legacy_row.payload->'providerSerializationProofBinding'->>'sourceOrdinal') ~ '^[0-9]+$' and length(legacy_row.payload->'providerSerializationProofBinding'->>'sourceOrdinal') <= 19 and (legacy_row.payload->'providerSerializationProofBinding'->>'sourceOrdinal')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->'providerSerializationProofBinding'->>'sourceOrdinal')::bigint else null end)
          );
          expected_proof := encode(digest(convert_to(format(
            '{"binding":%s,"contentItemIdentity":%s,"exposureStage":%s,"logicalSourceIdentity":%s,"sourceKind":%s,"visibleTokenCount":%s}',
            binding_text,
            to_json(legacy_row.payload->>'contentItemIdentity'),
            to_json(legacy_row.payload->>'exposureStage'),
            to_json(legacy_row.payload->>'logicalSourceIdentity'),
            to_json(legacy_row.payload->>'sourceKind'),
            (case when (legacy_row.payload->>'visibleTokenCount') ~ '^[0-9]+$' and length(legacy_row.payload->>'visibleTokenCount') <= 19 and (legacy_row.payload->>'visibleTokenCount')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'visibleTokenCount')::bigint else null end)
          ), 'UTF8'), 'sha256'), 'hex');
        else
          binding_text := null;
          expected_proof := encode(digest(convert_to(format(
            '{"contentItemIdentity":%s,"exposureStage":%s,"logicalSourceIdentity":%s,"sourceKind":%s,"visibleTokenCount":%s}',
            to_json(legacy_row.payload->>'contentItemIdentity'),
            to_json(legacy_row.payload->>'exposureStage'),
            to_json(legacy_row.payload->>'logicalSourceIdentity'),
            to_json(legacy_row.payload->>'sourceKind'),
            (case when (legacy_row.payload->>'visibleTokenCount') ~ '^[0-9]+$' and length(legacy_row.payload->>'visibleTokenCount') <= 19 and (legacy_row.payload->>'visibleTokenCount')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'visibleTokenCount')::bigint else null end)
          ), 'UTF8'), 'sha256'), 'hex');
        end if;
        if legacy_row.payload->>'providerRequestIndex' is null
          or jsonb_typeof(legacy_row.payload->'providerRequestIndex') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'providerRequestSha256Hex') is distinct from 'string'
          or jsonb_typeof(legacy_row.payload->'providerSerializationProofSha256Hex') is distinct from 'string'
          or jsonb_typeof(legacy_row.payload->'sourceKind') is distinct from 'string'
          or jsonb_typeof(legacy_row.payload->'logicalSourceIdentity') is distinct from 'string'
          or jsonb_typeof(legacy_row.payload->'contentItemIdentity') is distinct from 'string'
          or jsonb_typeof(legacy_row.payload->'exposureStage') is distinct from 'string'
          or jsonb_typeof(legacy_row.payload->'visibleTokenCount') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'providerSerializationProofBinding') is distinct from 'object'
          or jsonb_typeof(legacy_row.payload->'providerSerializationProofBinding'->'messageIndex') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'providerSerializationProofBinding'->'sourceOrdinal') is distinct from 'number'
          or jsonb_typeof(legacy_row.payload->'providerSerializationProofBinding'->'serializedField') is distinct from 'string'
          or jsonb_typeof(legacy_row.payload->'providerSerializationProofBinding'->'orderedSourceDescriptor') is distinct from 'string'
          or legacy_row.payload->'providerSerializationProofBinding'->>'messageIndex' !~ '^[0-9]+$'
          or legacy_row.payload->'providerSerializationProofBinding'->>'sourceOrdinal' !~ '^[0-9]+$'
          or (case when (legacy_row.payload->'providerSerializationProofBinding'->>'messageIndex') ~ '^[0-9]+$' and length(legacy_row.payload->'providerSerializationProofBinding'->>'messageIndex') <= 19 and (legacy_row.payload->'providerSerializationProofBinding'->>'messageIndex')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->'providerSerializationProofBinding'->>'messageIndex')::bigint else null end) is null
          or (case when (legacy_row.payload->'providerSerializationProofBinding'->>'sourceOrdinal') ~ '^[0-9]+$' and length(legacy_row.payload->'providerSerializationProofBinding'->>'sourceOrdinal') <= 19 and (legacy_row.payload->'providerSerializationProofBinding'->>'sourceOrdinal')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->'providerSerializationProofBinding'->>'sourceOrdinal')::bigint else null end) is null
          or (case when (legacy_row.payload->'providerSerializationProofBinding'->>'messageIndex') ~ '^[0-9]+$' and length(legacy_row.payload->'providerSerializationProofBinding'->>'messageIndex') <= 19 and (legacy_row.payload->'providerSerializationProofBinding'->>'messageIndex')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->'providerSerializationProofBinding'->>'messageIndex')::bigint else null end) > 9007199254740991
          or (case when (legacy_row.payload->'providerSerializationProofBinding'->>'sourceOrdinal') ~ '^[0-9]+$' and length(legacy_row.payload->'providerSerializationProofBinding'->>'sourceOrdinal') <= 19 and (legacy_row.payload->'providerSerializationProofBinding'->>'sourceOrdinal')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->'providerSerializationProofBinding'->>'sourceOrdinal')::bigint else null end) > 9007199254740991
          or coalesce(btrim(legacy_row.payload->'providerSerializationProofBinding'->>'serializedField'), '') = ''
          or coalesce(btrim(legacy_row.payload->'providerSerializationProofBinding'->>'orderedSourceDescriptor'), '') = ''
          or (jsonb_exists(legacy_row.payload->'providerSerializationProofBinding', 'characterOffset') and (
            jsonb_typeof(legacy_row.payload->'providerSerializationProofBinding'->'characterOffset') is distinct from 'number'
            or legacy_row.payload->'providerSerializationProofBinding'->>'characterOffset' !~ '^[0-9]+$'
            or (case when (legacy_row.payload->'providerSerializationProofBinding'->>'characterOffset') ~ '^[0-9]+$' and length(legacy_row.payload->'providerSerializationProofBinding'->>'characterOffset') <= 19 and (legacy_row.payload->'providerSerializationProofBinding'->>'characterOffset')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->'providerSerializationProofBinding'->>'characterOffset')::bigint else null end) is null
            or (case when (legacy_row.payload->'providerSerializationProofBinding'->>'characterOffset') ~ '^[0-9]+$' and length(legacy_row.payload->'providerSerializationProofBinding'->>'characterOffset') <= 19 and (legacy_row.payload->'providerSerializationProofBinding'->>'characterOffset')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->'providerSerializationProofBinding'->>'characterOffset')::bigint else null end) > 9007199254740991
          ))
          or (jsonb_exists(legacy_row.payload->'providerSerializationProofBinding', 'publicDocumentId') and (
            jsonb_typeof(legacy_row.payload->'providerSerializationProofBinding'->'publicDocumentId') is distinct from 'string'
            or coalesce(btrim(legacy_row.payload->'providerSerializationProofBinding'->>'publicDocumentId'), '') = ''
          ))
          or exists (select 1 from jsonb_object_keys(legacy_row.payload->'providerSerializationProofBinding') key where key not in (
            'messageIndex', 'sourceOrdinal', 'serializedField', 'characterOffset', 'orderedSourceDescriptor', 'publicDocumentId'
          ))
          or legacy_row.payload->>'providerRequestIndex' !~ '^[0-9]+$'
          or (case when (legacy_row.payload->>'providerRequestIndex') ~ '^[0-9]+$' and length(legacy_row.payload->>'providerRequestIndex') <= 19 and (legacy_row.payload->>'providerRequestIndex')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'providerRequestIndex')::bigint else null end) is null
          or (case when (legacy_row.payload->>'providerRequestIndex') ~ '^[0-9]+$' and length(legacy_row.payload->>'providerRequestIndex') <= 19 and (legacy_row.payload->>'providerRequestIndex')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'providerRequestIndex')::bigint else null end) > 9007199254740991
          or legacy_row.payload->>'providerRequestSha256Hex' is null
          or legacy_row.payload->>'providerRequestSha256Hex' !~ '^[0-9a-f]{64}$'
          or legacy_row.payload->>'providerSerializationProofSha256Hex' is distinct from expected_proof
          or legacy_row.payload->>'sourceKind' not in ('document', 'chat_message', 'memory', 'web')
          or coalesce(btrim(legacy_row.payload->>'logicalSourceIdentity'), '') = ''
          or coalesce(btrim(legacy_row.payload->>'contentItemIdentity'), '') = ''
          or coalesce(btrim(legacy_row.payload->>'exposureStage'), '') = ''
          or legacy_row.payload->>'visibleTokenCount' is null
          or legacy_row.payload->>'visibleTokenCount' !~ '^[0-9]+$'
          or (case when (legacy_row.payload->>'visibleTokenCount') ~ '^[0-9]+$' and length(legacy_row.payload->>'visibleTokenCount') <= 19 and (legacy_row.payload->>'visibleTokenCount')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'visibleTokenCount')::bigint else null end) is null
          or (case when (legacy_row.payload->>'visibleTokenCount') ~ '^[0-9]+$' and length(legacy_row.payload->>'visibleTokenCount') <= 19 and (legacy_row.payload->>'visibleTokenCount')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'visibleTokenCount')::bigint else null end) > 9007199254740991 then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: exposure attestation proof or payload is not recomputable',
            legacy_row.row_identity;
        end if;
        if legacy_row.payload->>'sourceKind' = 'document' then
          if jsonb_typeof(legacy_row.payload->'documentRanges') is distinct from 'array'
            or jsonb_typeof(legacy_row.payload->'documentSourceId') is distinct from 'string'
            or jsonb_typeof(legacy_row.payload->'documentId') is distinct from 'string'
            or jsonb_typeof(legacy_row.payload->'versionId') is distinct from 'string'
            or (jsonb_exists(legacy_row.payload, 'publisherExtractionId')
              and jsonb_typeof(legacy_row.payload->'publisherExtractionId') is distinct from 'string')
            or exists (
              select 1
              from jsonb_array_elements(case when jsonb_typeof(legacy_row.payload->'documentRanges') = 'array'
                then legacy_row.payload->'documentRanges' else '[]'::jsonb end) range_row
              where jsonb_typeof(range_row) is distinct from 'object'
                or jsonb_typeof(range_row->'charStart') is distinct from 'number'
                or jsonb_typeof(range_row->'charEnd') is distinct from 'number'
                or range_row->>'charStart' is null
                or range_row->>'charStart' !~ '^[0-9]+$'
                or range_row->>'charEnd' is null
                or range_row->>'charEnd' !~ '^[0-9]+$'
                or (case when (range_row->>'charStart') ~ '^[0-9]+$' and length(range_row->>'charStart') <= 19 and (range_row->>'charStart')::numeric <= 9223372036854775807::numeric then (range_row->>'charStart')::bigint else null end) is null
                or (case when (range_row->>'charEnd') ~ '^[0-9]+$' and length(range_row->>'charEnd') <= 19 and (range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (range_row->>'charEnd')::bigint else null end) is null
                or (case when (range_row->>'charEnd') ~ '^[0-9]+$' and length(range_row->>'charEnd') <= 19 and (range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (range_row->>'charEnd')::bigint else null end) <= (case when (range_row->>'charStart') ~ '^[0-9]+$' and length(range_row->>'charStart') <= 19 and (range_row->>'charStart')::numeric <= 9223372036854775807::numeric then (range_row->>'charStart')::bigint else null end)
                or exists (select 1 from jsonb_object_keys(range_row) key where key not in ('charStart', 'charEnd'))
            ) then
            raise exception
              'AI chat schema cutover preflight row ai_observations/%: document exposure attestation ranges are not canonical',
              legacy_row.row_identity;
          end if;
          select '[' || string_agg(
            format('{"charEnd":%s,"charStart":%s}', (case when (range_row->>'charEnd') ~ '^[0-9]+$' and length(range_row->>'charEnd') <= 19 and (range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (range_row->>'charEnd')::bigint else null end), (case when (range_row->>'charStart') ~ '^[0-9]+$' and length(range_row->>'charStart') <= 19 and (range_row->>'charStart')::numeric <= 9223372036854775807::numeric then (range_row->>'charStart')::bigint else null end)),
            ',' order by ordinal
          ) || ']'
          into range_text
          from jsonb_array_elements(case when jsonb_typeof(legacy_row.payload->'documentRanges') = 'array'
            then legacy_row.payload->'documentRanges' else '[]'::jsonb end) with ordinality ranges(range_row, ordinal);
          reconstruction_text := format(
            '{"contentHash":%s,"documentId":%s%s,"ranges":%s,"sourceId":%s,"versionId":%s}',
            to_json(legacy_row.payload->>'documentContentHash'),
            to_json(legacy_row.payload->>'documentId'),
            case when legacy_row.payload->>'publisherExtractionId' is null then '' else format(',"publisherExtractionId":%s', to_json(legacy_row.payload->>'publisherExtractionId')) end,
            range_text,
            to_json(legacy_row.payload->>'documentSourceId'),
            to_json(legacy_row.payload->>'versionId')
          );
        else
          reconstruction_text := 'null';
        end if;
        expected_key := concat(
          'source_exposure_attestation:', legacy_row.emitting_task, ':',
          legacy_row.loop_iteration, ':', legacy_row.attempt, ':',
          (case when (legacy_row.payload->>'providerRequestIndex') ~ '^[0-9]+$' and length(legacy_row.payload->>'providerRequestIndex') <= 19 and (legacy_row.payload->>'providerRequestIndex')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'providerRequestIndex')::bigint else null end), ':',
          encode(digest(convert_to(format(
            '[%s,%s,%s,%s,%s,%s,%s,%s]',
            to_json(legacy_row.payload->>'sourceKind'),
            to_json(legacy_row.payload->>'logicalSourceIdentity'),
            to_json(legacy_row.payload->>'contentItemIdentity'),
            to_json(legacy_row.payload->>'exposureStage'),
            (case when (legacy_row.payload->>'visibleTokenCount') ~ '^[0-9]+$' and length(legacy_row.payload->>'visibleTokenCount') <= 19 and (legacy_row.payload->>'visibleTokenCount')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'visibleTokenCount')::bigint else null end),
            to_json(legacy_row.payload->>'providerRequestSha256Hex'),
            coalesce(binding_text, 'null'),
            reconstruction_text
          ), 'UTF8'), 'sha256'), 'hex'
        ));
        if legacy_row.observation_key is distinct from expected_key then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: exposure attestation observation key is not recomputable',
            legacy_row.row_identity;
        end if;
        if exists (
          select 1 from jsonb_object_keys(legacy_row.payload) key
          where key not in (
            'providerRequestIndex', 'providerRequestSha256Hex', 'sourceKind',
            'logicalSourceIdentity', 'contentItemIdentity', 'exposureStage',
            'visibleTokenCount', 'providerSerializationProofSha256Hex', 'providerSerializationProofBinding',
            'documentSourceId', 'documentId', 'versionId', 'documentContentHash',
            'documentRanges', 'publisherExtractionId'
          )
        ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: exposure attestation payload contains an unknown field',
            legacy_row.row_identity;
        end if;
        if legacy_row.payload->>'sourceKind' = 'document'
          and (legacy_row.payload->>'documentSourceId' is null
            or legacy_row.payload->>'documentId' is null
            or legacy_row.payload->>'versionId' is null
            or legacy_row.payload->>'documentContentHash' !~ '^[0-9a-f]{64}$'
            or jsonb_typeof(legacy_row.payload->'documentRanges') is distinct from 'array') then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: document exposure attestation lacks its closed reconstruction tuple',
            legacy_row.row_identity;
        elsif legacy_row.payload->>'sourceKind' <> 'document'
          and exists (
            select 1 from jsonb_object_keys(legacy_row.payload) key
            where key in (
              'documentSourceId', 'documentId', 'versionId', 'documentContentHash',
              'documentRanges', 'publisherExtractionId'
            )
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: non-document exposure attestation carries document identity',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'candidate_rejected' then
        if exists (
          select 1 from jsonb_object_keys(legacy_row.payload) key
          where key not in ('candidateId', 'reason')
        ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: candidate rejection payload contains an unknown field',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'citation' then
        if legacy_row.emitting_task <> 'finalize'
          or legacy_row.observation_key !~ '^citation:[0-9]+:[0-9]+$'
          or exists (
            select 1 from jsonb_object_keys(legacy_row.payload) key
            where key not in ('assistantMessageId', 'sourceKey')
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: citation identity or payload is not canonical',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'citation_defect' then
        if legacy_row.emitting_task <> 'finalize'
          or legacy_row.observation_key !~ '^citation_defect:[0-9]+:[0-9]+$'
          or legacy_row.payload->>'reason' not in ('malformed', 'unknown_source_key')
          or exists (
            select 1 from jsonb_object_keys(legacy_row.payload) key
            where key not in ('token', 'reason')
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: citation defect identity or payload is not canonical',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'memory_application' then
        if legacy_row.emitting_task <> 'finalize'
          or legacy_row.observation_key <> format(
            'finalize:%s:%s:memory_application:result',
            legacy_row.loop_iteration,
            legacy_row.attempt
          )
          or exists (
            select 1 from jsonb_object_keys(legacy_row.payload) key
            where key not in (
              'extractionTaskId', 'extractionLoopIteration', 'extractionAttempt',
              'extractionObservationKey', 'extractionSha256Hex', 'proposalCount',
              'discardedCount'
            )
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: memory application identity or payload is not canonical',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.kind = 'memory_written' then
        if legacy_row.emitting_task <> 'finalize'
          or legacy_row.observation_key <> format('memory_written:%s', legacy_row.payload->>'ordinal')
          or exists (
            select 1 from jsonb_object_keys(legacy_row.payload) key
            where key not in ('ordinal', 'memoryId', 'revisionId', 'previousRevisionId', 'action')
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: memory write identity or payload is not canonical',
            legacy_row.row_identity;
        end if;
      end if;
    end loop;

  for legacy_row in
      select measurements.id::text as row_identity,
             measurements.run_id,
             measurements.emitting_task,
             measurements.loop_iteration,
             measurements.attempt,
             measurements.payload
      from ai_observations measurements
      where measurements.kind = 'provider_request_measurement'
      order by measurements.id
    loop
      if legacy_row.payload->'sourceExposureProofSha256Hexes' is distinct from coalesce(
        (
          select jsonb_agg(attestations.payload->>'providerSerializationProofSha256Hex' order by attestations.payload->>'providerSerializationProofSha256Hex')
          from ai_observations attestations
          where attestations.run_id = legacy_row.run_id
            and attestations.emitting_task = legacy_row.emitting_task
            and attestations.loop_iteration = legacy_row.loop_iteration
            and attestations.attempt = legacy_row.attempt
            and attestations.kind = 'source_exposure_attestation'
            and (case when (attestations.payload->>'providerRequestIndex') ~ '^[0-9]+$' and length(attestations.payload->>'providerRequestIndex') <= 19 and (attestations.payload->>'providerRequestIndex')::numeric <= 9223372036854775807::numeric then (attestations.payload->>'providerRequestIndex')::bigint else null end) = (case when (legacy_row.payload->>'providerRequestIndex') ~ '^[0-9]+$' and length(legacy_row.payload->>'providerRequestIndex') <= 19 and (legacy_row.payload->>'providerRequestIndex')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'providerRequestIndex')::bigint else null end)
        ),
        '[]'::jsonb
      ) then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: provider measurement proof set does not match retained exposure attestations',
          legacy_row.row_identity;
      end if;
    end loop;

  for legacy_row in
      select usage_rows.id::text as row_identity,
             usage_rows.run_id,
             usage_rows.task_id,
             usage_rows.loop_iteration,
             usage_rows.attempt,
             usage_rows.provider_request_index,
             usage_rows.agent_role,
             usage_rows.model_id,
             usage_rows.provider_service_id,
             usage_rows.input_tokens,
             usage_rows.output_tokens,
             usage_rows.cached_tokens,
             usage_rows.reasoning_tokens,
             usage_rows.total_tokens,
             usage_rows.stop_reason,
             measurements.payload as measurement_payload,
             measurements.id::text as measurement_id
      from ai_run_usage usage_rows
      left join ai_observations measurements
        on measurements.run_id = usage_rows.run_id
       and measurements.emitting_task = usage_rows.task_id
       and measurements.loop_iteration = usage_rows.loop_iteration
       and measurements.attempt = usage_rows.attempt
       and measurements.kind = 'provider_request_measurement'
       and (case when (measurements.payload->>'providerRequestIndex') ~ '^[0-9]+$' and length(measurements.payload->>'providerRequestIndex') <= 19 and (measurements.payload->>'providerRequestIndex')::numeric <= 9223372036854775807::numeric then (measurements.payload->>'providerRequestIndex')::bigint else null end) = usage_rows.provider_request_index
      order by usage_rows.id, measurements.id
    loop
      if legacy_row.task_id !~ '^(plan-turn|memory-extract|evaluation-general-planner|single-(retrieve-internal|select-memories|retrieve-web|reduce-plan|answer)|topic-t[123]-(retrieve-internal|select-memories|retrieve-web|reduce-plan|answer)|fanout-synthesis)$' then
        raise exception
          'AI chat schema cutover preflight row ai_run_usage/%: usage task owner % is not canonical',
          legacy_row.row_identity,
          legacy_row.task_id;
      end if;
      if legacy_row.agent_role is distinct from (
        case
        when legacy_row.task_id = 'plan-turn' then 'plan_turn'
        when legacy_row.task_id = 'memory-extract' then 'memory_extractor'
        when legacy_row.task_id = 'evaluation-general-planner' then 'evaluation_general_planner'
        when legacy_row.task_id like '%retrieve-internal' then 'internal_retrieval'
        when legacy_row.task_id like '%select-memories' then 'memory_selector'
        when legacy_row.task_id like '%retrieve-web' then 'web_research'
        when legacy_row.task_id like '%reduce-plan' then 'context_reducer'
        when legacy_row.task_id like 'topic-%-answer' then 'topic_answer'
        when legacy_row.task_id = 'single-answer' then 'direct_answer'
        when legacy_row.task_id = 'fanout-synthesis' then 'synthesis'
        else null
        end
      ) then
        raise exception
          'AI chat schema cutover preflight row ai_run_usage/%: agent role % is not owned by task %',
          legacy_row.row_identity,
          legacy_row.agent_role,
          legacy_row.task_id;
      end if;
      if legacy_row.model_id is distinct from 'glm-5-turbo'
        or legacy_row.provider_service_id not in (
          'zai_coding_plan_official', 'deterministic_test',
          'openai_compatible_custom', 'pre_attestation_unknown'
        )
        or legacy_row.stop_reason not in ('stop', 'length', 'toolUse', 'error')
        or legacy_row.total_tokens <> legacy_row.input_tokens + legacy_row.cached_tokens + legacy_row.output_tokens
        or legacy_row.reasoning_tokens > legacy_row.output_tokens then
        raise exception
          'AI chat schema cutover preflight row ai_run_usage/%: provider usage accounting or identity is not canonical',
          legacy_row.row_identity;
      end if;
      if not exists (
        select 1
        from ai_run_events usage_events
        where usage_events.run_id = legacy_row.run_id
          and usage_events.emission_key = format(
            'usage:request:model:%s:%s:%s:%s',
            legacy_row.task_id,
            legacy_row.loop_iteration,
            legacy_row.attempt,
            legacy_row.provider_request_index
          )
          and usage_events.emitted_by_task = legacy_row.task_id
          and usage_events.event->>'type' = 'usage'
          and usage_events.event->>'scope' = 'request'
          and usage_events.event->>'kind' = 'model'
      ) then
        raise exception
          'AI chat schema cutover preflight row ai_run_usage/%: usage row lacks its exact model usage event',
          legacy_row.row_identity;
      end if;
      if legacy_row.measurement_id is null
        or (
          select count(*)
          from ai_observations measurements
          where measurements.run_id = legacy_row.run_id
            and measurements.emitting_task = legacy_row.task_id
            and measurements.loop_iteration = legacy_row.loop_iteration
            and measurements.attempt = legacy_row.attempt
            and measurements.kind = 'provider_request_measurement'
            and (case when (measurements.payload->>'providerRequestIndex') ~ '^[0-9]+$' and length(measurements.payload->>'providerRequestIndex') <= 19 and (measurements.payload->>'providerRequestIndex')::numeric <= 9223372036854775807::numeric then (measurements.payload->>'providerRequestIndex')::bigint else null end) = legacy_row.provider_request_index
        ) <> 1
        or legacy_row.measurement_payload->>'modelId' is distinct from legacy_row.model_id
        or legacy_row.measurement_payload->>'agentRole' is distinct from legacy_row.agent_role
        or legacy_row.measurement_payload->>'providerRequestIndex' is distinct from legacy_row.provider_request_index::text
        or legacy_row.measurement_payload->>'passed' is distinct from 'true' then
        raise exception
          'AI chat schema cutover preflight row ai_run_usage/%: usage lacks one exact passed provider measurement with matching owner and model',
          legacy_row.row_identity;
      end if;
    end loop;

  -- Failed runs are terminal product state too.  The failure path always
  -- writes one aggregate usage event followed by one terminal error event;
  -- it never leaves a saved assistant answer or a done event behind.  Check
  -- this ledger before any helper or final-column write so a failed row cannot
  -- be mistaken for a drained active run or a successful answer.
  for legacy_row in
      select runs.id::text as row_identity,
             runs.error_code,
             runs.retryable,
             terminal.emitted_by_task as terminal_owner,
             terminal.event as terminal_event,
             aggregate.emitted_by_task as aggregate_owner,
             aggregate.event as aggregate_event,
             terminal.seq as terminal_seq,
             aggregate.seq as aggregate_seq
      from ai_runs runs
      left join ai_run_events terminal
        on terminal.run_id = runs.id
       and terminal.emission_key = 'terminal'
       and terminal.event->>'type' = 'error'
      left join ai_run_events aggregate
        on aggregate.run_id = runs.id
       and aggregate.emission_key = 'usage:run'
       and aggregate.event->>'type' = 'usage'
       and aggregate.event->>'scope' = 'run'
      where runs.failed_at is not null
      order by runs.id, terminal.id, aggregate.id
    loop
      if legacy_row.error_code is null or legacy_row.retryable is null then
        raise exception
          'AI chat schema cutover preflight row ai_runs/%: failed run has no canonical error identity',
          legacy_row.row_identity;
      end if;
      if legacy_row.terminal_owner is null then
        raise exception
          'AI chat schema cutover preflight row ai_runs/%: failed run lacks one terminal error event',
          legacy_row.row_identity;
      end if;
      if legacy_row.terminal_owner not in ('failure-handler', 'finalize')
        or legacy_row.terminal_event->>'code' is distinct from legacy_row.error_code
        or legacy_row.terminal_event->>'retryable' is distinct from legacy_row.retryable::text then
        raise exception
          'AI chat schema cutover preflight row ai_runs/%: failed terminal error event is not bound to the run failure',
          legacy_row.row_identity;
      end if;
      if legacy_row.aggregate_owner is null then
        raise exception
          'AI chat schema cutover preflight row ai_runs/%: failed run lacks one aggregate usage event',
          legacy_row.row_identity;
      end if;
      if legacy_row.aggregate_owner is distinct from legacy_row.terminal_owner
        or legacy_row.aggregate_seq >= legacy_row.terminal_seq then
        raise exception
          'AI chat schema cutover preflight row ai_runs/%: failed terminal lifecycle order is not canonical',
          legacy_row.row_identity;
      end if;
      if exists (
        select 1
        from ai_run_events later
        where later.run_id = legacy_row.row_identity::uuid
          and later.seq > legacy_row.terminal_seq
      ) then
        raise exception
          'AI chat schema cutover preflight row ai_runs/%: failed terminal error event is not last',
          legacy_row.row_identity;
      end if;
      if exists (
        select 1
        from ai_run_events events
        where events.run_id = legacy_row.row_identity::uuid
          and events.event->>'type' = 'done'
      ) then
        raise exception
          'AI chat schema cutover preflight row ai_runs/%: failed run carries a successful done event',
          legacy_row.row_identity;
      end if;
      if (select count(*) from ai_run_events events
          where events.run_id = legacy_row.row_identity::uuid
            and events.emission_key = 'terminal'
            and events.event->>'type' = 'error') <> 1
        or (select count(*) from ai_run_events events
            where events.run_id = legacy_row.row_identity::uuid
              and events.emission_key = 'usage:run'
              and events.event->>'type' = 'usage'
              and events.event->>'scope' = 'run') <> 1 then
        raise exception
          'AI chat schema cutover preflight row ai_runs/%: failed run has duplicate terminal lifecycle events',
          legacy_row.row_identity;
      end if;
    end loop;

  for legacy_row in
      select runs.id::text as row_identity
      from ai_runs runs
      where runs.finished_at is null and runs.failed_at is null
      order by runs.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_runs/%: active run must be drained before cutover',
        legacy_row.row_identity;
    end loop;

  if to_regclass('public._smithers_runs') is not null then
    execute 'select count(*) from public._smithers_runs where run_id like ''ai-chat:%''' into incompatible;
    if incompatible <> 0 then
      raise exception 'AI chat schema cutover requires drained Smithers outputs (%)', incompatible;
    end if;
  end if;
  if to_regclass('public.ai_chat_memories') is not null then
    execute 'select count(*) from public.ai_chat_memories where run_id like ''ai-chat:%''' into incompatible;
    if incompatible <> 0 then
      raise exception 'AI chat schema cutover requires drained memory outputs (%)', incompatible;
    end if;
  end if;
  if to_regclass('public.ai_chat_web') is not null then
    execute 'select count(*) from public.ai_chat_web where run_id like ''ai-chat:%''' into incompatible;
    if incompatible <> 0 then
      raise exception 'AI chat schema cutover requires drained web outputs (%)', incompatible;
    end if;
  end if;

  -- Every retained ledger must already describe the final contract.  These
  -- rows cannot be repaired after the first DDL statement because the old
  -- owner, role, planner, attestation, and document-version identities would
  -- no longer have a canonical home.  Report the exact row and the first
  -- legacy field so an operator can fix or purge that row before retrying.
  for legacy_row in
      select
        documents.source_id::text as source_identity,
        documents.document_id::text as row_identity,
        documents.content_hash as stored_hash,
        encode(digest(convert_to(documents.text, 'UTF8'), 'sha256'), 'hex') as expected_hash
      from public_source_documents documents
      where documents.content_hash is distinct from
            encode(digest(convert_to(documents.text, 'UTF8'), 'sha256'), 'hex')
      order by documents.source_id, documents.document_id
    loop
      raise exception
        'AI chat schema cutover preflight row public_source_documents/%/%: content_hash % differs from text digest %',
        legacy_row.source_identity,
        legacy_row.row_identity,
        legacy_row.stored_hash,
        legacy_row.expected_hash;
    end loop;

  for legacy_row in
      select documents.source_id::text || '/' || documents.document_id::text as row_identity
      from public_source_documents documents
      where documents.text_char_count <> (char_length(documents.text) + (select count(*) from generate_series(1, char_length(documents.text)) positions(position) where octet_length(convert_to(substr(documents.text, positions.position, 1), 'UTF8')) = 4))
      order by documents.source_id, documents.document_id
    loop
      raise exception
        'AI chat schema cutover preflight row public_source_documents/%: text count is not JavaScript UTF-16 length',
        legacy_row.row_identity;
    end loop;

  for legacy_row in
      select versions.id::text as row_identity
      from brief_document_versions versions
      where versions.text_char_count <> (char_length(versions.canonical_text) + (select count(*) from generate_series(1, char_length(versions.canonical_text)) positions(position) where octet_length(convert_to(substr(versions.canonical_text, positions.position, 1), 'UTF8')) = 4))
      order by versions.id
    loop
      raise exception
        'AI chat schema cutover preflight row brief_document_versions/%: text count is not JavaScript UTF-16 length',
        legacy_row.row_identity;
    end loop;

  for legacy_row in
      select extractions.id::text as row_identity
      from brief_document_extractions extractions
      where extractions.extracted_char_count <> (
        select coalesce(sum((char_length(page->>'text') + (select count(*) from generate_series(1, char_length(page->>'text')) positions(position) where octet_length(convert_to(substr(page->>'text', positions.position, 1), 'UTF8')) = 4))), 0)
          + 2 * greatest(count(*) - 1, 0)
        from jsonb_array_elements(extractions.pages) page
      )
      order by extractions.id
    loop
      raise exception
        'AI chat schema cutover preflight row brief_document_extractions/%: extracted count is not JavaScript UTF-16 length',
        legacy_row.row_identity;
    end loop;

  for legacy_row in
      select
        'ai_observations'::text as relation_name,
        observations.id::text as row_identity,
        observations.kind as row_kind,
        observations.payload as row_payload
      from ai_observations observations
      order by observations.id
    loop
      if legacy_row.row_kind in (
        'conversation_resolution',
        'execution_plan',
        'provider_request_attestation'
      ) then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: legacy observation kind % requires explicit conversion',
          legacy_row.row_identity,
          legacy_row.row_kind;
      end if;

      legacy_key := null;
      if legacy_key is not null then
        raise exception
          'AI chat schema cutover preflight row ai_observations/%: legacy payload field % has no canonical conversion',
          legacy_row.row_identity,
          legacy_key;
      end if;
  end loop;

  for legacy_row in
      select
        'ai_run_events'::text as relation_name,
        events.id::text as row_identity,
        events.event as row_payload
      from ai_run_events events
      order by events.id
    loop
      legacy_key := null;
      if legacy_key is not null then
        raise exception
          'AI chat schema cutover preflight row ai_run_events/%: legacy payload field % has no canonical conversion',
          legacy_row.row_identity,
          legacy_key;
      end if;
  end loop;

  -- Usage events are part of the retained accounting ledger.  The canonical
  -- model event deliberately has a `role` field; only the old observation and
  -- planner payload shapes use the rejected role aliases.  Bind every request
  -- event to one exact usage row, including failed provider attempts whose
  -- known stop reason is `error`.
  for legacy_row in
      select events.id::text as row_identity,
             events.run_id,
             events.emission_key,
             events.emitted_by_task,
             events.event as row_event
      from ai_run_events events
      order by events.id
    loop
      if jsonb_typeof(legacy_row.row_event) is distinct from 'object'
        or legacy_row.row_event->>'type' not in (
          'run_started', 'context_ready', 'answer_started', 'text_delta',
          'memory_updated', 'usage', 'done', 'error'
        ) then
        raise exception
          'AI chat schema cutover preflight row ai_run_events/%: event type is not canonical',
          legacy_row.row_identity;
      end if;

      if legacy_row.row_event->>'type' = 'run_started' then
        if legacy_row.emission_key <> 'run_started'
          or legacy_row.emitted_by_task is not null
          or exists (
            select 1 from jsonb_object_keys(legacy_row.row_event) key
            where key <> 'type'
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_run_events/%: run-start event identity or payload is not canonical',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.row_event->>'type' = 'context_ready' then
        if legacy_row.emission_key <> 'context_ready'
          or legacy_row.emitted_by_task !~ '^(evaluation-general-planner|clarification-result|single-answer|fanout-synthesis|topic-t[123]-answer)$'
          or jsonb_typeof(legacy_row.row_event->'mode') is distinct from 'string'
          or legacy_row.row_event->>'mode' not in ('clarification', 'single', 'synthesis')
          or jsonb_typeof(legacy_row.row_event->'reductionRan') is distinct from 'boolean'
          or jsonb_typeof(legacy_row.row_event->'sourcesRead') is distinct from 'array'
          or jsonb_typeof(legacy_row.row_event->'consumers') is distinct from 'array'
          or exists (
            select 1
            from jsonb_array_elements(case when jsonb_typeof(legacy_row.row_event->'sourcesRead') = 'array'
              then legacy_row.row_event->'sourcesRead' else '[]'::jsonb end) source
            where jsonb_typeof(source) is distinct from 'object'
              or jsonb_typeof(source->'sourceKey') is distinct from 'string'
              or coalesce(btrim(source->>'sourceKey'), '') = ''
              or not jsonb_exists(source, 'label')
              or jsonb_typeof(source->'label') not in ('string', 'null')
              or jsonb_typeof(source->'tokenCount') is distinct from 'number'
              or source->>'tokenCount' !~ '^[0-9]+$'
              or jsonb_typeof(source->'topicIds') is distinct from 'array'
              or exists (
                select 1 from jsonb_array_elements(case when jsonb_typeof(source->'topicIds') = 'array'
                  then source->'topicIds' else '[]'::jsonb end) topic
                where jsonb_typeof(topic) is distinct from 'string'
                  or topic #>> '{}' not in ('t1', 't2', 't3')
              )
              or jsonb_array_length(case when jsonb_typeof(source->'topicIds') = 'array'
                then source->'topicIds' else '[]'::jsonb end) <> (
                select count(distinct topic #>> '{}')
                from jsonb_array_elements(case when jsonb_typeof(source->'topicIds') = 'array'
                  then source->'topicIds' else '[]'::jsonb end) topic
              )
              or jsonb_typeof(source->'kind') is distinct from 'string'
              or source->>'kind' not in ('document', 'chat_message', 'memory', 'web')
              or (source->>'kind' = 'document' and (
                jsonb_typeof(source->'documentTitle') is distinct from 'string'
                or jsonb_typeof(source->'url') is distinct from 'string'
                or jsonb_typeof(source->'ranges') is distinct from 'array'
                or (jsonb_exists(source, 'sourceName') and jsonb_typeof(source->'sourceName') is distinct from 'string')
                or (jsonb_exists(source, 'issueTitle') and jsonb_typeof(source->'issueTitle') is distinct from 'string')
                or (jsonb_exists(source, 'publishedAt') and jsonb_typeof(source->'publishedAt') is distinct from 'string')
                or coalesce(btrim(source->>'documentTitle'), '') = ''
                or coalesce(btrim(source->>'url'), '') = ''
                or exists (
                  select 1 from jsonb_array_elements(case when jsonb_typeof(source->'ranges') = 'array'
                    then source->'ranges' else '[]'::jsonb end) range_row
                  where jsonb_typeof(range_row) is distinct from 'object'
                    or jsonb_typeof(range_row->'charStart') is distinct from 'number'
                    or jsonb_typeof(range_row->'charEnd') is distinct from 'number'
                    or range_row->>'charStart' !~ '^[0-9]+$'
                    or range_row->>'charEnd' !~ '^[0-9]+$'
                    or (case when (range_row->>'charStart') ~ '^[0-9]+$' and length(range_row->>'charStart') <= 19 and (range_row->>'charStart')::numeric <= 9223372036854775807::numeric then (range_row->>'charStart')::bigint else null end) is null
                    or (case when (range_row->>'charEnd') ~ '^[0-9]+$' and length(range_row->>'charEnd') <= 19 and (range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (range_row->>'charEnd')::bigint else null end) is null
                    or (case when (range_row->>'charEnd') ~ '^[0-9]+$' and length(range_row->>'charEnd') <= 19 and (range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (range_row->>'charEnd')::bigint else null end) <= (case when (range_row->>'charStart') ~ '^[0-9]+$' and length(range_row->>'charStart') <= 19 and (range_row->>'charStart')::numeric <= 9223372036854775807::numeric then (range_row->>'charStart')::bigint else null end)
                    or (jsonb_exists(range_row, 'pageNumber')
                      and (jsonb_typeof(range_row->'pageNumber') is distinct from 'number'
                        or range_row->>'pageNumber' !~ '^[0-9]+$'))
                    or exists (select 1 from jsonb_object_keys(range_row) key where key not in ('pageNumber', 'charStart', 'charEnd'))
                )
              ))
              or (source->>'kind' in ('chat_message', 'memory', 'web') and (
                jsonb_typeof(source->'ranges') is distinct from 'array'
                or case when jsonb_typeof(source->'ranges') = 'array'
                  then jsonb_array_length(source->'ranges') else 1 end <> 0
              ))
              or (source->>'kind' = 'chat_message' and (
                jsonb_typeof(source->'messageId') is distinct from 'string'
                or coalesce(btrim(source->>'messageId'), '') = ''
              ))
              or (source->>'kind' = 'memory' and (
                jsonb_typeof(source->'memoryId') is distinct from 'string'
                or jsonb_typeof(source->'memoryRevisionId') is distinct from 'string'
                or coalesce(btrim(source->>'memoryId'), '') = ''
                or coalesce(btrim(source->>'memoryRevisionId'), '') = ''
              ))
              or (source->>'kind' = 'web' and (
                jsonb_typeof(source->'title') is distinct from 'string'
                or jsonb_typeof(source->'domain') is distinct from 'string'
                or jsonb_typeof(source->'url') is distinct from 'string'
                or jsonb_typeof(source->'capturedAt') is distinct from 'string'
                or jsonb_typeof(source->'quote') is distinct from 'string'
                or (jsonb_exists(source, 'publishedAt') and jsonb_typeof(source->'publishedAt') is distinct from 'string')
                or coalesce(btrim(source->>'title'), '') = ''
                or coalesce(btrim(source->>'domain'), '') = ''
                or coalesce(btrim(source->>'url'), '') = ''
                or coalesce(btrim(source->>'capturedAt'), '') = ''
                or coalesce(btrim(source->>'quote'), '') = ''
              ))
              or exists (
                select 1 from jsonb_object_keys(source) key
                where case source->>'kind'
                  when 'document' then key not in ('sourceKey', 'label', 'tokenCount', 'topicIds', 'kind', 'sourceName', 'issueTitle', 'documentTitle', 'url', 'publishedAt', 'ranges')
                  when 'chat_message' then key not in ('sourceKey', 'label', 'tokenCount', 'topicIds', 'kind', 'messageId', 'ranges')
                  when 'memory' then key not in ('sourceKey', 'label', 'tokenCount', 'topicIds', 'kind', 'memoryId', 'memoryRevisionId', 'ranges')
                  when 'web' then key not in ('sourceKey', 'label', 'tokenCount', 'topicIds', 'kind', 'title', 'domain', 'url', 'publishedAt', 'capturedAt', 'quote', 'ranges')
                  else true
                end
              )
          )
          or exists (
            select 1
            from jsonb_array_elements(case when jsonb_typeof(legacy_row.row_event->'consumers') = 'array'
              then legacy_row.row_event->'consumers' else '[]'::jsonb end) consumer
            where jsonb_typeof(consumer) is distinct from 'object'
              or jsonb_typeof(consumer->'consumer') is distinct from 'string'
              or consumer->>'consumer' not in ('direct', 'topic', 'synthesis')
              or jsonb_typeof(consumer->'inputTokens') is distinct from 'number'
              or jsonb_typeof(consumer->'requestedOutputTokens') is distinct from 'number'
              or jsonb_typeof(consumer->'usableInputTokens') is distinct from 'number'
              or consumer->>'inputTokens' !~ '^[0-9]+$'
              or consumer->>'requestedOutputTokens' !~ '^[0-9]+$'
              or consumer->>'usableInputTokens' !~ '^[0-9]+$'
              or (jsonb_exists(consumer, 'topicId') and (
                jsonb_typeof(consumer->'topicId') is distinct from 'string'
                or consumer->>'topicId' not in ('t1', 't2', 't3')
              ))
              or exists (
                select 1 from jsonb_object_keys(consumer) key
                where key not in ('consumer', 'topicId', 'inputTokens', 'requestedOutputTokens', 'usableInputTokens')
              )
          )
          or exists (
            select 1 from jsonb_object_keys(legacy_row.row_event) key
            where key not in ('type', 'mode', 'reductionRan', 'sourcesRead', 'consumers')
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_run_events/%: context-ready event is not canonical',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.row_event->>'type' = 'answer_started' then
        if legacy_row.emitted_by_task !~ '^(evaluation-general-planner|clarification-result|single-answer|fanout-synthesis|topic-t[123]-answer)$'
          or jsonb_typeof(legacy_row.row_event->'mode') is distinct from 'string'
          or legacy_row.row_event->>'mode' not in ('clarification', 'single', 'synthesis')
          or jsonb_typeof(legacy_row.row_event->'attempt') is distinct from 'number'
          or (case when (legacy_row.row_event->>'attempt') ~ '^[0-9]+$' and length(legacy_row.row_event->>'attempt') <= 19 and (legacy_row.row_event->>'attempt')::numeric <= 9223372036854775807::numeric then (legacy_row.row_event->>'attempt')::bigint else null end) is null
          or legacy_row.emission_key <> format(
            'answer_started:%s:%s', legacy_row.emitted_by_task,
            (case when (legacy_row.row_event->>'attempt') ~ '^[0-9]+$' and length(legacy_row.row_event->>'attempt') <= 19 and (legacy_row.row_event->>'attempt')::numeric <= 9223372036854775807::numeric then (legacy_row.row_event->>'attempt')::bigint else null end)
          )
          or exists (
            select 1 from jsonb_object_keys(legacy_row.row_event) key
            where key not in ('type', 'mode', 'attempt')
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_run_events/%: answer-start event identity or payload is not canonical',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.row_event->>'type' = 'text_delta' then
        if legacy_row.emitted_by_task !~ '^(evaluation-general-planner|clarification-result|single-answer|fanout-synthesis|topic-t[123]-answer)$'
          or jsonb_typeof(legacy_row.row_event->'delta') is distinct from 'string'
          or legacy_row.emission_key !~ '^text_delta:[^:]+:[0-9]+:[0-9]+$'
          or exists (
            select 1 from jsonb_object_keys(legacy_row.row_event) key
            where key not in ('type', 'delta')
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_run_events/%: text-delta event identity or payload is not canonical',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.row_event->>'type' = 'memory_updated' then
        if legacy_row.emitted_by_task <> 'finalize'
          or jsonb_typeof(legacy_row.row_event->'created') is distinct from 'number'
          or jsonb_typeof(legacy_row.row_event->'updated') is distinct from 'number'
          or jsonb_typeof(legacy_row.row_event->'discarded') is distinct from 'number'
          or legacy_row.row_event->>'created' !~ '^[0-9]+$'
          or legacy_row.row_event->>'updated' !~ '^[0-9]+$'
          or legacy_row.row_event->>'discarded' !~ '^[0-9]+$'
          or exists (
            select 1 from jsonb_object_keys(legacy_row.row_event) key
            where key not in ('type', 'created', 'updated', 'discarded')
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_run_events/%: memory-update event is not canonical',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.row_event->>'type' = 'done' then
        if legacy_row.emitted_by_task <> 'finalize'
          or coalesce(btrim(legacy_row.row_event->>'assistantMessageId'), '') = ''
          or legacy_row.emission_key <> 'terminal'
          or exists (
            select 1 from jsonb_object_keys(legacy_row.row_event) key
            where key <> 'type' and key <> 'assistantMessageId'
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_run_events/%: terminal event identity or payload is not canonical',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.row_event->>'type' = 'error' then
        if legacy_row.emitted_by_task is null
          or coalesce(btrim(legacy_row.row_event->>'code'), '') = ''
          or jsonb_typeof(legacy_row.row_event->'retryable') is distinct from 'boolean'
          or exists (
            select 1 from jsonb_object_keys(legacy_row.row_event) key
            where key not in ('type', 'code', 'retryable')
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_run_events/%: error event identity or payload is not canonical',
            legacy_row.row_identity;
        end if;
      end if;

      if legacy_row.row_event->>'type' = 'usage'
        and legacy_row.row_event->>'scope' = 'request'
        and legacy_row.row_event->>'kind' = 'model' then
        if legacy_row.emitted_by_task is null
          or legacy_row.row_event->>'role' is null
          or legacy_row.row_event->>'attempt' !~ '^[0-9]+$'
          or legacy_row.row_event->>'inputTokens' !~ '^[0-9]+$'
          or legacy_row.row_event->>'outputTokens' !~ '^[0-9]+$'
          or legacy_row.row_event->>'cachedTokens' !~ '^[0-9]+$'
          or legacy_row.row_event->>'reasoningTokens' !~ '^[0-9]+$'
          or legacy_row.row_event->>'totalTokens' !~ '^[0-9]+$'
          or exists (
            select 1 from jsonb_object_keys(legacy_row.row_event) key
            where key not in (
              'type', 'scope', 'kind', 'role', 'attempt', 'inputTokens',
              'outputTokens', 'cachedTokens', 'reasoningTokens', 'totalTokens'
            )
          )
          or not exists (
            select 1
            from ai_run_usage usage_rows
            where usage_rows.run_id = legacy_row.run_id
              and usage_rows.task_id = legacy_row.emitted_by_task
              and usage_rows.attempt = (case when (legacy_row.row_event->>'attempt') ~ '^[0-9]+$' and length(legacy_row.row_event->>'attempt') <= 19 and (legacy_row.row_event->>'attempt')::numeric <= 9223372036854775807::numeric then (legacy_row.row_event->>'attempt')::bigint else null end)
              and legacy_row.emission_key = format(
                'usage:request:model:%s:%s:%s:%s',
                usage_rows.task_id,
                usage_rows.loop_iteration,
                usage_rows.attempt,
                usage_rows.provider_request_index
              )
              and legacy_row.row_event->>'role' = usage_rows.agent_role
              and legacy_row.row_event->>'inputTokens' = usage_rows.input_tokens::text
              and legacy_row.row_event->>'outputTokens' = usage_rows.output_tokens::text
              and legacy_row.row_event->>'cachedTokens' = usage_rows.cached_tokens::text
              and legacy_row.row_event->>'reasoningTokens' = usage_rows.reasoning_tokens::text
              and legacy_row.row_event->>'totalTokens' = usage_rows.total_tokens::text
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_run_events/%: model usage event is not bound to its exact usage row',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.row_event->>'type' = 'usage'
        and legacy_row.row_event->>'scope' = 'request'
        and legacy_row.row_event->>'kind' in ('web_search', 'web_fetch') then
        if legacy_row.emitted_by_task is null
          or legacy_row.row_event->>'attempt' !~ '^[0-9]+$'
          or not (legacy_row.row_event ? 'status')
          or legacy_row.row_event->>'status' not in ('ok', 'empty', 'failed')
          or legacy_row.row_event->>'resultCount' !~ '^[0-9]+$'
          or legacy_row.row_event->>'responseBytes' !~ '^[0-9]+$'
          or not (legacy_row.row_event ? 'durationMs')
          or legacy_row.row_event->>'durationMs' !~ '^[0-9]+$'
          or not (legacy_row.row_event ? 'billedUnits')
          or (
            legacy_row.row_event->>'billedUnits' is not null
            and legacy_row.row_event->>'billedUnits' !~ '^[0-9]+([.][0-9]+)?$'
          )
          or exists (
            select 1 from jsonb_object_keys(legacy_row.row_event) key
            where key not in (
              'type', 'scope', 'kind', 'attempt', 'status', 'resultCount',
              'responseBytes', 'billedUnits', 'durationMs'
            )
          )
          or not exists (
            select 1
            from ai_external_tool_usage tool_rows
            where tool_rows.run_id = legacy_row.run_id
              and tool_rows.task_id = legacy_row.emitted_by_task
              and tool_rows.operation = legacy_row.row_event->>'kind'
              and tool_rows.attempt = (case when (legacy_row.row_event->>'attempt') ~ '^[0-9]+$' and length(legacy_row.row_event->>'attempt') <= 19 and (legacy_row.row_event->>'attempt')::numeric <= 9223372036854775807::numeric then (legacy_row.row_event->>'attempt')::bigint else null end)
              and legacy_row.emission_key = format(
                'usage:request:%s:%s:%s:%s:%s',
                tool_rows.operation,
                tool_rows.task_id,
                tool_rows.loop_iteration,
                tool_rows.attempt,
                tool_rows.tool_request_index
              )
              and legacy_row.row_event->>'status' = tool_rows.status
              and legacy_row.row_event->>'resultCount' = tool_rows.result_count::text
              and legacy_row.row_event->>'responseBytes' = tool_rows.response_bytes::text
              and legacy_row.row_event->>'durationMs' = tool_rows.duration_ms::text
              and legacy_row.row_event->>'billedUnits' is not distinct from tool_rows.billed_units::text
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_run_events/%: external usage event is not bound to its exact usage row',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.row_event->>'type' = 'usage'
        and legacy_row.row_event->>'scope' = 'run' then
        if legacy_row.emission_key <> 'usage:run'
          or (
            case
              when exists (
                select 1
                from ai_runs failed_runs
                where failed_runs.id = legacy_row.run_id
                  and failed_runs.failed_at is not null
              ) then legacy_row.emitted_by_task not in ('failure-handler', 'finalize')
              else legacy_row.emitted_by_task is distinct from 'finalize'
            end
          )
          or exists (
            select 1 from jsonb_object_keys(legacy_row.row_event) key
            where key not in ('type', 'scope', 'model', 'web')
          )
          or jsonb_typeof(legacy_row.row_event->'model') is distinct from 'object'
          or jsonb_typeof(legacy_row.row_event->'web') is distinct from 'object'
          or legacy_row.row_event->'model'->>'inputTokens' !~ '^[0-9]+$'
          or legacy_row.row_event->'model'->>'outputTokens' !~ '^[0-9]+$'
          or legacy_row.row_event->'model'->>'cachedTokens' !~ '^[0-9]+$'
          or legacy_row.row_event->'model'->>'reasoningTokens' !~ '^[0-9]+$'
          or legacy_row.row_event->'model'->>'totalTokens' !~ '^[0-9]+$'
          or legacy_row.row_event->'model'->>'requestCount' !~ '^[0-9]+$'
          or legacy_row.row_event->'web'->>'searchCount' !~ '^[0-9]+$'
          or legacy_row.row_event->'web'->>'fetchCount' !~ '^[0-9]+$'
          or legacy_row.row_event->'web'->>'responseBytes' !~ '^[0-9]+$'
          or not (legacy_row.row_event->'web' ? 'billedUnits')
          or (
            legacy_row.row_event->'web'->>'billedUnits' is not null
            and legacy_row.row_event->'web'->>'billedUnits' !~ '^[0-9]+([.][0-9]+)?$'
          )
          or exists (
            select 1 from jsonb_object_keys(legacy_row.row_event->'model') key
            where key not in ('inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens', 'totalTokens', 'requestCount')
          )
          or exists (
            select 1 from jsonb_object_keys(legacy_row.row_event->'web') key
            where key not in ('searchCount', 'fetchCount', 'responseBytes', 'billedUnits')
          ) then
          raise exception
            'AI chat schema cutover preflight row ai_run_events/%: aggregate usage event is not canonical',
            legacy_row.row_identity;
        end if;
        if exists (
          select 1
          from (
            select
              coalesce(sum(input_tokens), 0)::text as input_tokens,
              coalesce(sum(output_tokens), 0)::text as output_tokens,
              coalesce(sum(cached_tokens), 0)::text as cached_tokens,
              coalesce(sum(reasoning_tokens), 0)::text as reasoning_tokens,
              coalesce(sum(total_tokens), 0)::text as total_tokens,
              count(*)::text as request_count
            from ai_run_usage
            where run_id = legacy_row.run_id
          ) usage_totals
          where legacy_row.row_event->'model'->>'inputTokens' <> usage_totals.input_tokens
             or legacy_row.row_event->'model'->>'outputTokens' <> usage_totals.output_tokens
             or legacy_row.row_event->'model'->>'cachedTokens' <> usage_totals.cached_tokens
             or legacy_row.row_event->'model'->>'reasoningTokens' <> usage_totals.reasoning_tokens
             or legacy_row.row_event->'model'->>'totalTokens' <> usage_totals.total_tokens
             or legacy_row.row_event->'model'->>'requestCount' <> usage_totals.request_count
        ) or exists (
          select 1
          from (
            select
              count(*) filter (where operation = 'web_search')::text as search_count,
              count(*) filter (where operation = 'web_fetch')::text as fetch_count,
              coalesce(sum(response_bytes), 0)::text as response_bytes,
              case
                when count(*) = 0 then '0'
                when count(*) filter (where billed_units is null) > 0 then null
                else sum(billed_units)::text
              end as billed_units
            from ai_external_tool_usage
            where run_id = legacy_row.run_id
          ) web_totals
          where legacy_row.row_event->'web'->>'searchCount' <> web_totals.search_count
             or legacy_row.row_event->'web'->>'fetchCount' <> web_totals.fetch_count
             or legacy_row.row_event->'web'->>'responseBytes' <> web_totals.response_bytes
             or legacy_row.row_event->'web'->>'billedUnits' is distinct from web_totals.billed_units
        ) then
          raise exception
            'AI chat schema cutover preflight row ai_run_events/%: aggregate usage does not match retained usage ledgers',
            legacy_row.row_identity;
        end if;
      elsif legacy_row.row_event->>'type' = 'usage' then
        raise exception
          'AI chat schema cutover preflight row ai_run_events/%: usage event scope or kind is not canonical',
          legacy_row.row_identity;
      end if;
    end loop;

    -- 0063 leaves the old reconstruction columns in place.  A non-document
    -- row must not carry a document identity that the cutover would copy into
    -- the final columns, and a content-bearing document must carry the full
    -- old tuple before it can be copied.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_source_exposures'
      and column_name = 'document_version_id'
  ) then
  for legacy_row in
      select
        exposures.id::text as row_identity,
        exposures.source_kind,
        exposures.exposure_stage,
        exposures.document_source_id,
        exposures.document_id,
        exposures.document_version_id,
        exposures.document_content_hash,
        exposures.document_ranges,
        exposures.task_id,
        exposures.loop_iteration,
        exposures.attempt,
        exposures.provider_request_index,
        exposures.logical_source_identity,
        exposures.content_item_identity,
        exposures.visible_token_count
      from ai_source_exposures exposures
      order by exposures.id
    loop
      if legacy_row.source_kind not in ('document', 'chat_message', 'memory', 'web')
        or coalesce(btrim(legacy_row.task_id), '') = ''
        or coalesce(btrim(legacy_row.logical_source_identity), '') = ''
        or coalesce(btrim(legacy_row.content_item_identity), '') = ''
        or coalesce(btrim(legacy_row.exposure_stage), '') = ''
        or legacy_row.loop_iteration < 0
        or legacy_row.attempt < 0
        or legacy_row.provider_request_index < 0
        or legacy_row.visible_token_count < 0 then
        raise exception
          'AI chat schema cutover preflight row ai_source_exposures/%: exposure coordinates or identity are not canonical',
          legacy_row.row_identity;
      end if;
      if legacy_row.source_kind <> 'document' and (
        legacy_row.document_source_id is not null
        or legacy_row.document_id is not null
        or legacy_row.document_version_id is not null
        or legacy_row.document_content_hash is not null
        or legacy_row.document_ranges is not null
      ) then
        raise exception
          'AI chat schema cutover preflight row ai_source_exposures/%: non-document row carries a document identity',
          legacy_row.row_identity;
      end if;
      if legacy_row.exposure_stage = 'internal_search_preview'
        and legacy_row.source_kind <> 'document' then
        raise exception
          'AI chat schema cutover preflight row ai_source_exposures/%: content-bearing search preview is not a document exposure',
          legacy_row.row_identity;
      end if;
      if legacy_row.source_kind = 'document'
        and (
          legacy_row.document_source_id is null
          or legacy_row.document_id is null
          or legacy_row.document_version_id is null
          or legacy_row.document_content_hash is null
          or legacy_row.document_ranges is null
        ) then
        raise exception
          'AI chat schema cutover preflight row ai_source_exposures/%: content-bearing document exposure lacks its complete reconstruction tuple',
          legacy_row.row_identity;
      end if;
      if legacy_row.source_kind = 'document'
        and (legacy_row.document_source_id !~ '^((public|publisher):[^:[:space:]]+)$'
          or position(chr(65279) in legacy_row.document_source_id) > 0) then
        raise exception
          'AI chat schema cutover preflight row ai_source_exposures/%: document exposure identity or ranges are not canonical',
          legacy_row.row_identity;
      end if;
  end loop;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_source_exposures'
      and column_name = 'document_version_id'
  ) then
  for legacy_row in
      select
        exposures.id::text as row_identity,
        exposures.source_kind,
        exposures.exposure_stage,
        exposures.document_source_id,
        exposures.document_id,
        exposures.version_id,
        exposures.content_hash,
        exposures.document_ranges,
        exposures.publisher_extraction_id,
        exposures.task_id,
        exposures.loop_iteration,
        exposures.attempt,
        exposures.provider_request_index,
        exposures.logical_source_identity,
        exposures.content_item_identity,
        exposures.visible_token_count
      from ai_source_exposures exposures
      order by exposures.id
    loop
      if legacy_row.source_kind not in ('document', 'chat_message', 'memory', 'web')
        or coalesce(btrim(legacy_row.task_id), '') = ''
        or coalesce(btrim(legacy_row.logical_source_identity), '') = ''
        or coalesce(btrim(legacy_row.content_item_identity), '') = ''
        or coalesce(btrim(legacy_row.exposure_stage), '') = ''
        or legacy_row.loop_iteration < 0
        or legacy_row.attempt < 0
        or legacy_row.provider_request_index < 0
        or legacy_row.visible_token_count < 0 then
        raise exception
          'AI chat schema cutover preflight row ai_source_exposures/%: exposure coordinates or identity are not canonical',
          legacy_row.row_identity;
      end if;
      if legacy_row.source_kind <> 'document' and (
        legacy_row.document_source_id is not null
        or legacy_row.document_id is not null
        or legacy_row.version_id is not null
        or legacy_row.content_hash is not null
        or legacy_row.document_ranges is not null
        or legacy_row.publisher_extraction_id is not null
      ) then
        raise exception
          'AI chat schema cutover preflight row ai_source_exposures/%: non-document row carries a document identity',
          legacy_row.row_identity;
      end if;
      if legacy_row.source_kind = 'document'
        and (legacy_row.document_source_id is null
          or legacy_row.document_id is null
          or legacy_row.version_id is null
          or legacy_row.content_hash is null
          or legacy_row.document_ranges is null
          or (legacy_row.publisher_extraction_id is not null) <> (legacy_row.document_source_id like 'publisher:%')
          or legacy_row.document_source_id !~ '^((public|publisher):[^:[:space:]]+)$'
          or position(chr(65279) in legacy_row.document_source_id) > 0) then
        raise exception
          'AI chat schema cutover preflight row ai_source_exposures/%: document exposure identity or ranges are not canonical',
          legacy_row.row_identity;
      end if;
  end loop;
  end if;

    -- The legacy source table also had typed identity columns.  Check them
    -- before they are removed, including the nullable publisher extraction
    -- identity that is only valid for publisher documents.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'assistant_message_sources'
      and column_name = 'document_version_id'
  ) then
  for legacy_row in
      select
        sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
        sources.kind,
        sources.document_version_id,
        sources.publisher_document_version_id,
        sources.message_id,
        sources.memory_revision_id,
        sources.locator
      from assistant_message_sources sources
      order by sources.assistant_message_id, sources.source_key
    loop
      if legacy_row.kind <> 'document' and (
        legacy_row.document_version_id is not null
        or legacy_row.publisher_document_version_id is not null
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: non-document row carries a document version identity',
          legacy_row.row_identity;
      end if;
      if null = 'versionId'
        and jsonb_exists(legacy_row.locator, 'versionId')
        and legacy_row.locator->>'versionId' is distinct from legacy_row.locator->>'versionId' then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: versionId conflicts with versionId',
          legacy_row.row_identity;
      end if;
      legacy_key := null;
      if legacy_key is not null then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: legacy locator field % has no canonical conversion',
          legacy_row.row_identity,
          legacy_key;
      end if;
  end loop;
  end if;

    -- Usage rows retain the final role and provider identity.  Historical
    -- aliases cannot be inferred from a task name without changing evidence
    -- ownership, so reject them with their bigint row identity.
  for legacy_row in
      select usage_rows.id::text as row_identity, usage_rows.agent_role, usage_rows.provider_service_id
      from ai_run_usage usage_rows
      order by usage_rows.id
    loop
      if legacy_row.agent_role not in (
        'plan_turn', 'internal_retrieval', 'memory_selector',
        'web_research', 'context_reducer', 'direct_answer',
        'topic_answer', 'synthesis', 'memory_extractor',
        'evaluation_general_planner'
      ) then
        raise exception
          'AI chat schema cutover preflight row ai_run_usage/%: legacy agent role % has no canonical conversion',
          legacy_row.row_identity,
          legacy_row.agent_role;
      end if;
      if legacy_row.provider_service_id not in (
        'zai_coding_plan_official', 'deterministic_test',
        'openai_compatible_custom', 'pre_attestation_unknown'
      ) then
        raise exception
          'AI chat schema cutover preflight row ai_run_usage/%: legacy provider service % has no canonical conversion',
          legacy_row.row_identity,
          legacy_row.provider_service_id;
      end if;
    end loop;

  -- Every retained external-tool usage row must have one canonical request
  -- event.  Checking only events would allow an orphaned ledger row to
  -- survive the namespace cutover and make the aggregate usage event lie.
  for legacy_row in
      select tool_rows.id::text as row_identity,
             tool_rows.run_id,
             tool_rows.task_id,
             tool_rows.loop_iteration,
             tool_rows.attempt,
             tool_rows.tool_request_index,
             tool_rows.operation,
             tool_rows.status,
             tool_rows.result_count,
             tool_rows.response_bytes,
             tool_rows.billed_units,
             tool_rows.duration_ms
      from ai_external_tool_usage tool_rows
      order by tool_rows.id
    loop
      if not exists (
        select 1
        from ai_run_events usage_events
        where usage_events.run_id = legacy_row.run_id
          and usage_events.emitted_by_task = legacy_row.task_id
          and usage_events.emission_key = format(
            'usage:request:%s:%s:%s:%s:%s',
            legacy_row.operation,
            legacy_row.task_id,
            legacy_row.loop_iteration,
            legacy_row.attempt,
            legacy_row.tool_request_index
          )
          and usage_events.event->>'type' = 'usage'
          and usage_events.event->>'scope' = 'request'
          and usage_events.event->>'kind' = legacy_row.operation
          and usage_events.event->>'attempt' = legacy_row.attempt::text
          and usage_events.event->>'status' = legacy_row.status
          and usage_events.event->>'resultCount' = legacy_row.result_count::text
          and usage_events.event->>'responseBytes' = legacy_row.response_bytes::text
          and usage_events.event->>'durationMs' = legacy_row.duration_ms::text
          and usage_events.event->>'billedUnits' is not distinct from legacy_row.billed_units::text
      ) then
        raise exception
          'AI chat schema cutover preflight row ai_external_tool_usage/%: external usage lacks its exact request event',
          legacy_row.row_identity;
      end if;
    end loop;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'assistant_message_sources'
      and column_name = 'document_version_id'
  ) then
    -- Resolve every retained document locator against the live immutable
    -- tuple.  Presence checks alone are not enough: publisher issue and
    -- subscription ownership must match the source namespace exactly.
    for legacy_row in
        select
          sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
          sources.kind,
          sources.locator,
          sources.document_version_id,
          sources.publisher_document_version_id
        from assistant_message_sources sources
        where sources.kind = 'document'
        order by sources.assistant_message_id, sources.source_key
      loop
        if legacy_row.locator->>'sourceId' like 'public:%' then
          if jsonb_exists(legacy_row.locator, 'publisherIssueId')
            or jsonb_exists(legacy_row.locator, 'publisherDocumentId')
            or jsonb_exists(legacy_row.locator, 'publisherExtractionId')
            or not exists (
              select 1
              from public_source_documents documents
              where documents.source_id::text = substring(legacy_row.locator->>'sourceId' from 8)
                and documents.document_id = legacy_row.locator->>'documentId'
                and documents.document_id = coalesce(legacy_row.locator->>'versionId', legacy_row.locator->>'versionId', legacy_row.document_version_id)
                and documents.content_hash = legacy_row.locator->>'contentHash'
                and documents.content_hash = encode(digest(convert_to(documents.text, 'UTF8'), 'sha256'), 'hex')
            ) then
            raise exception
              'AI chat schema cutover preflight row assistant_message_sources/%: public document locator is not bound to its exact immutable source/version tuple',
              legacy_row.row_identity;
          end if;
        elsif legacy_row.locator->>'sourceId' like 'publisher:%' then
          if legacy_row.publisher_document_version_id is null
            or not exists (
              select 1
              from brief_document_versions versions
              join brief_document_extractions extractions
                on extractions.brief_document_id = versions.brief_document_id
               join brief_documents documents on documents.id = versions.brief_document_id
              join publisher_issues issues on issues.id = documents.issue_id
              join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
              where versions.id = legacy_row.publisher_document_version_id
                and versions.id::text = coalesce(legacy_row.locator->>'versionId', legacy_row.locator->>'versionId', legacy_row.publisher_document_version_id::text)
                and versions.brief_document_id::text = legacy_row.locator->>'documentId'
                and legacy_row.locator->>'publisherIssueId' = issues.id::text
                and legacy_row.locator->>'publisherDocumentId' = documents.id::text
                and coalesce(legacy_row.locator->>'publisherExtractionId', extractions.id::text) = extractions.id::text
                and legacy_row.locator->>'sourceId' = 'publisher:' || subscriptions.id::text
                and legacy_row.locator->>'contentHash' = versions.content_hash
                and versions.content_hash = encode(digest(convert_to(versions.canonical_text, 'UTF8'), 'sha256'), 'hex')
                and extractions.input_sha256_hex = documents.sha256_hex
                and versions.canonical_text = (
                  select string_agg(page->>'text', E'\n\n' order by (case when (page->>'pageNumber') ~ '^[0-9]+$' and length(page->>'pageNumber') <= 19 and (page->>'pageNumber')::numeric <= 9223372036854775807::numeric then (page->>'pageNumber')::bigint else null end))
                  from jsonb_array_elements(extractions.pages) page
                )
            ) then
            raise exception
              'AI chat schema cutover preflight row assistant_message_sources/%: publisher document locator is not bound to its exact issue/subscription/document/version/extraction tuple',
              legacy_row.row_identity;
          end if;
        else
          raise exception
            'AI chat schema cutover preflight row assistant_message_sources/%: document locator has an unknown source namespace',
            legacy_row.row_identity;
        end if;
      end loop;

    for legacy_row in
        select exposures.id::text as row_identity,
               exposures.source_kind,
               exposures.document_source_id,
               exposures.document_id,
               exposures.document_version_id,
               exposures.document_content_hash,
               exposures.document_ranges,
               exposures.publisher_issue_id,
               exposures.publisher_document_id,
               exposures.exposure_stage
        from ai_source_exposures exposures
        order by exposures.id
      loop
        if legacy_row.source_kind = 'document' then
          if legacy_row.document_source_id like 'public:%' then
            if not exists (
              select 1 from public_source_documents documents
              where documents.source_id::text = substring(legacy_row.document_source_id from 8)
                and documents.document_id = legacy_row.document_id
                and documents.document_id = legacy_row.document_version_id
                and documents.content_hash = legacy_row.document_content_hash
                and documents.content_hash = encode(digest(convert_to(documents.text, 'UTF8'), 'sha256'), 'hex')
            ) then
              raise exception
                'AI chat schema cutover preflight row ai_source_exposures/%: public exposure is not bound to its exact immutable source/version tuple',
                legacy_row.row_identity;
            end if;
          elsif legacy_row.document_source_id like 'publisher:%' then
            if not exists (
              select 1
              from brief_document_versions versions
              join brief_document_extractions extractions on extractions.brief_document_id = versions.brief_document_id
              join brief_documents documents on documents.id = versions.brief_document_id
              join publisher_issues issues on issues.id = documents.issue_id
              join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
              where versions.id::text = legacy_row.document_version_id
                and versions.brief_document_id::text = legacy_row.document_id
                and versions.content_hash = legacy_row.document_content_hash
                and legacy_row.document_source_id = 'publisher:' || subscriptions.id::text
                and legacy_row.publisher_issue_id = issues.id::text
                and legacy_row.publisher_document_id = documents.id::text
                and versions.content_hash = encode(digest(convert_to(versions.canonical_text, 'UTF8'), 'sha256'), 'hex')
            ) then
              raise exception
                'AI chat schema cutover preflight row ai_source_exposures/%: publisher exposure is not bound to its exact issue/subscription/document/version/extraction tuple',
                legacy_row.row_identity;
            end if;
          else
            raise exception
              'AI chat schema cutover preflight row ai_source_exposures/%: document exposure has an unknown source namespace',
              legacy_row.row_identity;
          end if;
        elsif legacy_row.exposure_stage = 'internal_search_preview' then
          raise exception
            'AI chat schema cutover preflight row ai_source_exposures/%: content-bearing search preview lacks document identity',
            legacy_row.row_identity;
        end if;
      end loop;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'ai_source_exposures'
      and column_name = 'document_version_id'
  ) then
    for legacy_row in
        select exposures.id::text as row_identity,
               exposures.run_id,
               exposures.task_id,
               exposures.loop_iteration,
               exposures.attempt,
               exposures.provider_request_index,
               exposures.source_kind,
               exposures.logical_source_identity,
               exposures.content_item_identity,
               exposures.exposure_stage,
               exposures.visible_token_count
        from ai_source_exposures exposures
        order by exposures.id
      loop
        if not exists (
          select 1
          from ai_observations attestations
          where attestations.run_id = legacy_row.run_id
            and attestations.emitting_task = legacy_row.task_id
            and attestations.loop_iteration = legacy_row.loop_iteration
            and attestations.attempt = legacy_row.attempt
            and attestations.kind = 'source_exposure_attestation'
            and (case when (attestations.payload->>'providerRequestIndex') ~ '^[0-9]+$' and length(attestations.payload->>'providerRequestIndex') <= 19 and (attestations.payload->>'providerRequestIndex')::numeric <= 9223372036854775807::numeric then (attestations.payload->>'providerRequestIndex')::bigint else null end) = legacy_row.provider_request_index
            and attestations.payload->>'sourceKind' = legacy_row.source_kind
            and attestations.payload->>'logicalSourceIdentity' = legacy_row.logical_source_identity
            and attestations.payload->>'contentItemIdentity' = legacy_row.content_item_identity
            and attestations.payload->>'exposureStage' = legacy_row.exposure_stage
            and (case when (attestations.payload->>'visibleTokenCount') ~ '^[0-9]+$' and length(attestations.payload->>'visibleTokenCount') <= 19 and (attestations.payload->>'visibleTokenCount')::numeric <= 9223372036854775807::numeric then (attestations.payload->>'visibleTokenCount')::bigint else null end) = legacy_row.visible_token_count
        ) then
          raise exception
            'AI chat schema cutover preflight row ai_source_exposures/%: exposure lacks its exact attestation row',
            legacy_row.row_identity;
        end if;
      end loop;
    for legacy_row in
        select observations.id::text as row_identity,
               observations.run_id,
               observations.emitting_task,
               observations.loop_iteration,
               observations.attempt,
               observations.payload
        from ai_observations observations
        where observations.kind = 'source_exposure_attestation'
        order by observations.id
      loop
        if not exists (
          select 1
          from ai_source_exposures exposures
          where exposures.run_id = legacy_row.run_id
            and exposures.task_id = legacy_row.emitting_task
            and exposures.loop_iteration = legacy_row.loop_iteration
            and exposures.attempt = legacy_row.attempt
            and exposures.provider_request_index = (case when (legacy_row.payload->>'providerRequestIndex') ~ '^[0-9]+$' and length(legacy_row.payload->>'providerRequestIndex') <= 19 and (legacy_row.payload->>'providerRequestIndex')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'providerRequestIndex')::bigint else null end)
            and exposures.source_kind = legacy_row.payload->>'sourceKind'
            and exposures.logical_source_identity = legacy_row.payload->>'logicalSourceIdentity'
            and exposures.content_item_identity = legacy_row.payload->>'contentItemIdentity'
            and exposures.exposure_stage = legacy_row.payload->>'exposureStage'
            and exposures.visible_token_count = (case when (legacy_row.payload->>'visibleTokenCount') ~ '^[0-9]+$' and length(legacy_row.payload->>'visibleTokenCount') <= 19 and (legacy_row.payload->>'visibleTokenCount')::numeric <= 9223372036854775807::numeric then (legacy_row.payload->>'visibleTokenCount')::bigint else null end)
        ) then
          raise exception
            'AI chat schema cutover preflight row ai_observations/%: exposure attestation has no exact exposure row',
            legacy_row.row_identity;
        end if;
      end loop;
  end if;

  -- Blocking conversion preflight. This read-only pass runs before any
  -- product DDL or row rewrite and names the first retained identity that
  -- cannot be represented by the final schema.
  for legacy_row in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      where sources.source_key !~ '^k_[A-Za-z0-9_-]+_[1-9][0-9]*$'
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: malformed source key',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
             sources.assistant_message_id,
             substring(sources.source_key from '_([1-9][0-9]*)$') as ordinal_text
      from assistant_message_sources sources
      where exists (
        select 1
        from assistant_message_sources duplicate_sources
        where duplicate_sources.assistant_message_id = sources.assistant_message_id
          and (case when (substring(duplicate_sources.source_key from '_([1-9][0-9]*)$')) ~ '^[0-9]+$' and length(substring(duplicate_sources.source_key from '_([1-9][0-9]*)$')) <= 19 and (substring(duplicate_sources.source_key from '_([1-9][0-9]*)$'))::numeric <= 9223372036854775807::numeric then (substring(duplicate_sources.source_key from '_([1-9][0-9]*)$'))::bigint else null end) =
              (case when (substring(sources.source_key from '_([1-9][0-9]*)$')) ~ '^[0-9]+$' and length(substring(sources.source_key from '_([1-9][0-9]*)$')) <= 19 and (substring(sources.source_key from '_([1-9][0-9]*)$'))::numeric <= 9223372036854775807::numeric then (substring(sources.source_key from '_([1-9][0-9]*)$'))::bigint else null end)
          and duplicate_sources.source_key <> sources.source_key
      )
      order by sources.assistant_message_id,
               (case when (substring(sources.source_key from '_([1-9][0-9]*)$')) ~ '^[0-9]+$' and length(substring(sources.source_key from '_([1-9][0-9]*)$')) <= 19 and (substring(sources.source_key from '_([1-9][0-9]*)$'))::numeric <= 9223372036854775807::numeric then (substring(sources.source_key from '_([1-9][0-9]*)$'))::bigint else null end),
               sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: citation ordinal % is duplicated in this answer',
        legacy_row.row_identity,
        (case when (legacy_row.ordinal_text) ~ '^[0-9]+$' and length(legacy_row.ordinal_text) <= 19 and (legacy_row.ordinal_text)::numeric <= 9223372036854775807::numeric then (legacy_row.ordinal_text)::bigint else null end);
    end loop;
  for legacy_row in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
             substring(sources.source_key from '_([1-9][0-9]*)$') as ordinal_text
      from assistant_message_sources sources
      where (case when (substring(sources.source_key from '_([1-9][0-9]*)$')) ~ '^[0-9]+$' and length(substring(sources.source_key from '_([1-9][0-9]*)$')) <= 19 and (substring(sources.source_key from '_([1-9][0-9]*)$'))::numeric <= 9223372036854775807::numeric then (substring(sources.source_key from '_([1-9][0-9]*)$'))::bigint else null end) is null
         or (case when (substring(sources.source_key from '_([1-9][0-9]*)$')) ~ '^[0-9]+$' and length(substring(sources.source_key from '_([1-9][0-9]*)$')) <= 19 and (substring(sources.source_key from '_([1-9][0-9]*)$'))::numeric <= 9223372036854775807::numeric then (substring(sources.source_key from '_([1-9][0-9]*)$'))::bigint else null end) > 2147483647
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: citation ordinal exceeds final integer bound',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select uses.assistant_message_id::text || '/' || uses.source_key || '/' ||
             uses.consumer_task_id || '/' || coalesce(uses.topic_id, '-') as row_identity
      from assistant_message_source_uses uses
      where not exists (
        select 1 from assistant_message_sources sources
        where sources.assistant_message_id = uses.assistant_message_id
          and sources.source_key = uses.source_key
      )
      order by uses.assistant_message_id, uses.source_key, uses.consumer_task_id, uses.topic_id
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_source_uses/%: source use has no retained source row',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select exposures.id::text as row_identity
      from ai_source_exposures exposures
      where exposures.source_kind = 'document'
        and (exposures.document_source_id is null or exposures.document_id is null
          or coalesce(
            to_jsonb(exposures)->>'document_version_id',
            to_jsonb(exposures)->>'version_id'
          ) is null
          or coalesce(
            to_jsonb(exposures)->>'document_content_hash',
            to_jsonb(exposures)->>'content_hash'
          ) is null
          or exposures.document_ranges is null)
      order by exposures.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_source_exposures/%: document exposure identity is incomplete',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
             sources.locator
      from assistant_message_sources sources
      where sources.kind = 'document'
        and (coalesce(btrim(sources.locator->>'documentId'), '') = ''
          or coalesce(
            btrim(sources.locator->>'versionId'),
            btrim(sources.locator->>'versionId'),
            ''
          ) = ''
          or sources.locator->>'contentHash' !~ '^[0-9a-f]{64}$')
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: document locator is incomplete',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
             sources.locator
      from assistant_message_sources sources
      where sources.kind = 'document'
        and (
          sources.locator->>'sourceId' !~ '^((public|publisher):[^:[:space:]]+)$'
          or position(chr(65279) in sources.locator->>'sourceId') > 0
          or (
            sources.locator->>'sourceId' like 'public:%'
            and (
              jsonb_exists(sources.locator, 'publisherIssueId')
              or jsonb_exists(sources.locator, 'publisherDocumentId')
              or jsonb_exists(sources.locator, 'publisherExtractionId')
              or jsonb_exists(sources.locator, 'publisherDocumentVersionId')
            )
          )
          or (
            sources.locator->>'sourceId' like 'publisher:%'
            and (
              coalesce(btrim(sources.locator->>'publisherIssueId'), '') = ''
              or coalesce(btrim(sources.locator->>'publisherDocumentId'), '') = ''
              or sources.locator->>'publisherDocumentId' is distinct from sources.locator->>'documentId'
            )
          )
        )
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: document identity is ambiguous or foreign',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
             sources.assistant_message_id,
             sources.memory_revision_id,
             sources.locator
      from assistant_message_sources sources
      where sources.kind = 'memory'
      order by sources.assistant_message_id, sources.source_key
    loop
      if legacy_row.memory_revision_id is null
        or legacy_row.locator->>'memoryId' is null
        or legacy_row.locator->>'memoryRevisionId' is null then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: memory locator is incomplete',
          legacy_row.row_identity;
      end if;
      if not exists (
        select 1
        from user_memory_revisions revisions
        join user_memories memories on memories.id = revisions.memory_id
        join chat_messages assistants on assistants.id = legacy_row.assistant_message_id
        join ai_runs runs on runs.assistant_message_id = assistants.id
        where revisions.id::text = legacy_row.memory_revision_id::text
          and memories.id::text = legacy_row.locator->>'memoryId'
          and revisions.id::text = legacy_row.locator->>'memoryRevisionId'
          and memories.user_id = runs.initiating_user_id
      ) then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: memory revision is not owned by the answer user or exact locator',
          legacy_row.row_identity;
      end if;
    end loop;
  for legacy_row in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      where sources.kind = 'web'
        and (sources.locator->>'url' is null or sources.locator->>'quoteHash' is null
          or sources.locator->>'capturedAt' is null
          or sources.locator->>'quoteHash' !~ '^[A-Za-z0-9_-]{43}$'
          or btrim(sources.locator->>'quote') = '')
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: web locator is incomplete',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      where sources.kind = 'chat_message'
        and not exists (
          select 1 from chat_messages messages
          where messages.id = sources.message_id
            and messages.id::text = sources.locator->>'messageId'
        )
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: chat message locator is unknown or foreign',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      join chat_messages messages on messages.id = sources.assistant_message_id
      join ai_runs runs on runs.assistant_message_id = messages.id
      where to_jsonb(runs)->>'citation_namespace' is not null
        and substring(sources.source_key from '^k_(cn_[A-Za-z0-9_-]+)_[0-9]+$') <>
            to_jsonb(runs)->>'citation_namespace'
        and sources.source_key ~ '^k_cn_[A-Za-z0-9_-]+_[0-9]+$'
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: source key uses the wrong answer namespace',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select uses.assistant_message_id::text || '/' || uses.source_key || '/' ||
             uses.consumer_task_id || '/' || coalesce(uses.topic_id, '-') as row_identity,
             uses.ranges
      from assistant_message_source_uses uses
      where jsonb_typeof(uses.ranges) <> 'array'
        or uses.rendered_token_count < 0
        or uses.context_order < 0
        or exists (
          select 1
          from jsonb_array_elements(uses.ranges) range_row
          where jsonb_typeof(range_row) <> 'object'
             or (range_row->>'charStart') !~ '^[0-9]+$'
             or (range_row->>'charEnd') !~ '^[0-9]+$'
             or (case when (range_row->>'charEnd') ~ '^[0-9]+$' and length(range_row->>'charEnd') <= 19 and (range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (range_row->>'charEnd')::bigint else null end) <= (case when (range_row->>'charStart') ~ '^[0-9]+$' and length(range_row->>'charStart') <= 19 and (range_row->>'charStart')::numeric <= 9223372036854775807::numeric then (range_row->>'charStart')::bigint else null end)
        )
        or exists (
          select 1
          from jsonb_array_elements(uses.ranges) with ordinality left_range(range_row, ordinal)
          join jsonb_array_elements(uses.ranges) with ordinality right_range(range_row, ordinal)
            on right_range.ordinal = left_range.ordinal + 1
          where (case when (right_range.range_row->>'charStart') ~ '^[0-9]+$' and length(right_range.range_row->>'charStart') <= 19 and (right_range.range_row->>'charStart')::numeric <= 9223372036854775807::numeric then (right_range.range_row->>'charStart')::bigint else null end) <
                (case when (left_range.range_row->>'charEnd') ~ '^[0-9]+$' and length(left_range.range_row->>'charEnd') <= 19 and (left_range.range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (left_range.range_row->>'charEnd')::bigint else null end)
        )
      order by uses.assistant_message_id, uses.source_key, uses.consumer_task_id, uses.topic_id
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_source_uses/%: source-use ledger row is invalid',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select uses.assistant_message_id::text || '/' || uses.source_key || '/' ||
             uses.consumer_task_id || '/' || coalesce(uses.topic_id, '-') as row_identity
      from assistant_message_source_uses uses
      join assistant_message_sources sources
        on sources.assistant_message_id = uses.assistant_message_id
       and sources.source_key = uses.source_key
      where (sources.kind <> 'document' and jsonb_array_length(uses.ranges) <> 0)
        or (sources.kind = 'document' and exists (
          select 1
          from jsonb_array_elements(uses.ranges) use_range
          where not exists (
            select 1
            from jsonb_array_elements(sources.locator->'ranges') locator_range
            where (case when (use_range->>'charStart') ~ '^[0-9]+$' and length(use_range->>'charStart') <= 19 and (use_range->>'charStart')::numeric <= 9223372036854775807::numeric then (use_range->>'charStart')::bigint else null end) >= (case when (locator_range->>'charStart') ~ '^[0-9]+$' and length(locator_range->>'charStart') <= 19 and (locator_range->>'charStart')::numeric <= 9223372036854775807::numeric then (locator_range->>'charStart')::bigint else null end)
              and (case when (use_range->>'charEnd') ~ '^[0-9]+$' and length(use_range->>'charEnd') <= 19 and (use_range->>'charEnd')::numeric <= 9223372036854775807::numeric then (use_range->>'charEnd')::bigint else null end) <= (case when (locator_range->>'charEnd') ~ '^[0-9]+$' and length(locator_range->>'charEnd') <= 19 and (locator_range->>'charEnd')::numeric <= 9223372036854775807::numeric then (locator_range->>'charEnd')::bigint else null end)
          )
        ))
      order by uses.assistant_message_id, uses.source_key, uses.consumer_task_id, uses.topic_id
      loop
        raise exception
          'AI chat schema cutover preflight row assistant_message_source_uses/%: source-use range is outside its immutable locator',
          legacy_row.row_identity;
      end loop;

  -- Locator ranges and all split uses must stay within the immutable source
  -- text, measured in JavaScript UTF-16 code units.
  for legacy_row in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      left join public_source_documents public_documents
        on sources.kind = 'document'
       and sources.locator->>'sourceId' like 'public:%'
       and public_documents.source_id::text = substring(sources.locator->>'sourceId' from 8)
       and public_documents.document_id = sources.locator->>'documentId'
       and public_documents.document_id = coalesce(sources.locator->>'versionId', sources.locator->>'versionId')
      left join brief_document_versions publisher_versions
        on sources.kind = 'document'
       and sources.locator->>'sourceId' like 'publisher:%'
       and publisher_versions.id::text = coalesce(sources.locator->>'versionId', sources.locator->>'versionId')
       and publisher_versions.brief_document_id::text = sources.locator->>'documentId'
      where sources.kind = 'document'
        and (
          (sources.locator->>'sourceId' like 'public:%' and public_documents.document_id is null)
          or (sources.locator->>'sourceId' like 'publisher:%' and publisher_versions.id is null)
          or exists (
            select 1
            from jsonb_array_elements(sources.locator->'ranges') range_row
            where (case when (range_row->>'charEnd') ~ '^[0-9]+$' and length(range_row->>'charEnd') <= 19 and (range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (range_row->>'charEnd')::bigint else null end) > coalesce(
              (char_length(public_documents.text) + (select count(*) from generate_series(1, char_length(public_documents.text)) positions(position) where octet_length(convert_to(substr(public_documents.text, positions.position, 1), 'UTF8')) = 4)),
              (char_length(publisher_versions.canonical_text) + (select count(*) from generate_series(1, char_length(publisher_versions.canonical_text)) positions(position) where octet_length(convert_to(substr(publisher_versions.canonical_text, positions.position, 1), 'UTF8')) = 4))
            )
          )
        )
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: document range exceeds immutable UTF-16 text length',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      left join public_source_documents documents
        on documents.document_id = sources.locator->>'documentId'
       and documents.document_id = coalesce(sources.locator->>'versionId', sources.locator->>'versionId')
       and sources.locator->>'sourceId' = 'public:' || documents.source_id
      where sources.kind = 'document'
        and sources.locator->>'sourceId' like 'public:%'
        and (
          documents.document_id is null
          or sources.locator->>'contentHash' is distinct from encode(
            digest(convert_to(documents.text, 'UTF8'), 'sha256'),
            'hex'
          )
        )
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: public citation content hash is not bound to its immutable document',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select documents.source_id::text || '/' || documents.document_id::text as row_identity
      from public_source_documents documents
      where exists (
        select 1
        from public_source_documents duplicate_documents
        where duplicate_documents.document_id <> documents.document_id
          and duplicate_documents.source_id = documents.source_id
          and duplicate_documents.canonical_url = documents.canonical_url
          and duplicate_documents.content_hash = encode(digest(convert_to(documents.text, 'UTF8'), 'sha256'), 'hex')
      )
      order by documents.source_id, documents.document_id
    loop
      raise exception
        'AI chat schema cutover preflight row public_source_documents/%: retained public versions collapse to one content hash',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select usage_rows.id::text as row_identity
      from ai_run_usage usage_rows
      where usage_rows.loop_iteration < 0 or usage_rows.attempt < 0 or usage_rows.provider_request_index < 0
        or usage_rows.input_tokens < 0 or usage_rows.output_tokens < 0 or usage_rows.cached_tokens < 0
        or usage_rows.reasoning_tokens < 0 or usage_rows.total_tokens < 0
        or coalesce(btrim(usage_rows.task_id), '') = ''
        or coalesce(btrim(usage_rows.agent_role), '') = ''
        or coalesce(btrim(usage_rows.model_id), '') = ''
      order by usage_rows.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_run_usage/%: attempt ledger coordinates are invalid',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select observations.id::text as row_identity
      from ai_observations observations
      where observations.payload is null
        or jsonb_typeof(observations.payload) <> 'object'
        or coalesce(btrim(observations.emitting_task), '') = ''
        or coalesce(btrim(observations.observation_key), '') = ''
        or observations.loop_iteration < 0
        or observations.attempt < 0
      order by observations.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_observations/%: observation coordinates or payload are invalid',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select observations.id::text as row_identity
      from ai_observations observations
      where observations.kind = 'source_exposure_attestation'
        and (
          coalesce(observations.payload->>'providerRequestSha256Hex', '') !~ '^[0-9a-f]{64}$'
          or coalesce(observations.payload->>'providerSerializationProofSha256Hex', '') !~ '^[0-9a-f]{64}$'
          or coalesce(btrim(observations.payload->>'sourceKind'), '') = ''
          or coalesce(btrim(observations.payload->>'contentItemIdentity'), '') = ''
        )
      order by observations.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_observations/%: exposure attestation is invalid',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select exposures.id::text as row_identity
      from ai_source_exposures exposures
      where (
          exposures.exposure_stage = 'internal_search_preview'
          and exposures.source_kind <> 'document'
        ) or (
          exposures.source_kind = 'document'
          and (
            coalesce(btrim(exposures.document_source_id), '') = ''
            or coalesce(btrim(exposures.document_id), '') = ''
            or coalesce(
              btrim(to_jsonb(exposures)->>'document_version_id'),
              btrim(to_jsonb(exposures)->>'version_id'),
              ''
            ) = ''
            or coalesce(
              btrim(to_jsonb(exposures)->>'document_content_hash'),
              btrim(to_jsonb(exposures)->>'content_hash'),
              ''
            ) = ''
          )
        )
      order by exposures.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_source_exposures/%: exposure identity or ranges are invalid',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select exposures.id::text as row_identity
      from ai_source_exposures exposures
      left join public_source_documents public_documents
        on exposures.document_source_id like 'public:%'
       and public_documents.document_id = exposures.document_id
       and public_documents.document_id = coalesce(
         to_jsonb(exposures)->>'document_version_id',
         to_jsonb(exposures)->>'version_id'
       )
      left join brief_document_versions publisher_versions
        on exposures.document_source_id like 'publisher:%'
       and publisher_versions.id::text = coalesce(
         to_jsonb(exposures)->>'document_version_id',
         to_jsonb(exposures)->>'version_id'
       )
       and publisher_versions.brief_document_id::text = exposures.document_id
      left join brief_documents publisher_documents
        on exposures.document_source_id like 'publisher:%'
       and publisher_documents.id = publisher_versions.brief_document_id
      left join publisher_issues publisher_issues
        on publisher_issues.id = publisher_documents.issue_id
      left join publisher_subscriptions publisher_subscriptions
        on publisher_subscriptions.id = publisher_issues.subscription_id
      left join lateral (
        select extractions.*
        from brief_document_extractions extractions
        where extractions.brief_document_id = publisher_documents.id
          and extractions.input_sha256_hex = publisher_documents.sha256_hex
        order by extractions.created_at desc, extractions.id
        limit 1
      ) publisher_extractions on true
      where exposures.source_kind = 'document'
        and (
          (exposures.document_source_id !~ '^((public|publisher):[^:[:space:]]+)$'
            or position(chr(65279) in exposures.document_source_id) > 0)
          or (exposures.document_source_id like 'public:%' and (
            public_documents.document_id is null
            or to_jsonb(exposures)->>'publisher_issue_id' is not null
            or to_jsonb(exposures)->>'publisher_document_id' is not null
            or to_jsonb(exposures)->>'publisher_extraction_id' is not null
            or public_documents.content_hash <> coalesce(
              to_jsonb(exposures)->>'document_content_hash',
              to_jsonb(exposures)->>'content_hash'
            )
            or public_documents.content_hash <> encode(
              digest(convert_to(public_documents.text, 'UTF8'), 'sha256'),
              'hex'
            )
          ))
          or (exposures.document_source_id like 'publisher:%' and (
            publisher_versions.id is null
            or publisher_documents.id is null
            or publisher_issues.id is null
            or publisher_subscriptions.id is null
            or publisher_extractions.id is null
            or exposures.document_source_id <> 'publisher:' || publisher_subscriptions.id::text
            or to_jsonb(exposures)->>'publisher_issue_id' <> publisher_issues.id::text
            or to_jsonb(exposures)->>'publisher_document_id' <> publisher_documents.id::text
            or to_jsonb(exposures)->>'publisher_extraction_id' <> publisher_extractions.id::text
            or publisher_extractions.brief_document_id <> publisher_documents.id
            or publisher_extractions.input_sha256_hex <> publisher_documents.sha256_hex
            or publisher_versions.brief_document_id <> publisher_documents.id
            or publisher_versions.content_hash <> coalesce(
              to_jsonb(exposures)->>'document_content_hash',
              to_jsonb(exposures)->>'content_hash'
            )
            or publisher_versions.content_hash <> encode(digest(convert_to(publisher_versions.canonical_text, 'UTF8'), 'sha256'), 'hex')
            or publisher_versions.canonical_text <> (
              select string_agg(page->>'text', E'\n\n' order by (case when (page->>'pageNumber') ~ '^[0-9]+$' and length(page->>'pageNumber') <= 19 and (page->>'pageNumber')::numeric <= 9223372036854775807::numeric then (page->>'pageNumber')::bigint else null end))
              from jsonb_array_elements(publisher_extractions.pages) page
            )
          ))
          or exists (
            select 1
            from jsonb_array_elements(exposures.document_ranges) range_row
            where (case when (range_row->>'charEnd') ~ '^[0-9]+$' and length(range_row->>'charEnd') <= 19 and (range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (range_row->>'charEnd')::bigint else null end) > (char_length(
              coalesce(public_documents.text, publisher_versions.canonical_text)
            ) + (select count(*) from generate_series(1, char_length(
              coalesce(public_documents.text, publisher_versions.canonical_text)
            )) positions(position) where octet_length(convert_to(substr(
              coalesce(public_documents.text, publisher_versions.canonical_text)
            , positions.position, 1), 'UTF8')) = 4))
          )
        )
      order by exposures.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_source_exposures/%: document exposure is not bound to its immutable source/version tuple',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      where sources.kind = 'chat_message'
        and (
          sources.message_id is null
          or sources.locator->>'messageId' is distinct from sources.message_id::text
          or not exists (
            select 1
            from chat_messages referenced
            join chat_messages assistant on assistant.id = sources.assistant_message_id
            where referenced.id = sources.message_id
              and referenced.chat_id = assistant.chat_id
          )
        )
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: chat-message identity is invalid',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity
      from assistant_message_sources sources
      where sources.kind = 'web'
        and (
          coalesce(btrim(sources.locator->>'quote'), '') = ''
          or sources.locator->>'quoteHash' is distinct from translate(
            rtrim(
              encode(
                digest(
                  convert_to(
                    btrim(normalize(replace(replace(sources.locator->>'quote', E'\r\n', E'\n'), E'\r', E'\n'), NFC)),
                    'UTF8'
                  ),
                  'sha256'
                ),
                'base64'
              ),
              '='
            ),
            '+/',
            '-_'
          )
        )
      order by sources.assistant_message_id, sources.source_key
    loop
      raise exception
        'AI chat schema cutover preflight row assistant_message_sources/%: web quotation hash is invalid',
        legacy_row.row_identity;
    end loop;
  -- A locator union may be split across several consumers.  Normalize the
  -- complete use union first; requiring one use to contain each locator range
  -- incorrectly rejects valid [0,5] + [5,10] coverage of [0,10].
  for legacy_row in
      select sources.assistant_message_id::text || '/' || sources.source_key as row_identity,
             sources.locator
      from assistant_message_sources sources
      where sources.kind = 'document'
      order by sources.assistant_message_id, sources.source_key
    loop
      select legacy_row.locator->'ranges'
      into uses_union;
      if uses_union is distinct from legacy_row.locator->'ranges' then
        raise exception
          'AI chat schema cutover preflight row assistant_message_sources/%: source-use union does not equal its locator union',
          legacy_row.row_identity;
      end if;
    end loop;
  for legacy_row in
      select exposures.id::text as row_identity
      from ai_source_exposures exposures
      where not exists (
        select 1
        from ai_observations attestations
        where attestations.run_id = exposures.run_id
          and attestations.emitting_task = exposures.task_id
          and attestations.loop_iteration = exposures.loop_iteration
          and attestations.attempt = exposures.attempt
          and attestations.kind = 'source_exposure_attestation'
          and (case when (attestations.payload->>'providerRequestIndex') ~ '^[0-9]+$' and length(attestations.payload->>'providerRequestIndex') <= 19 and (attestations.payload->>'providerRequestIndex')::numeric <= 9223372036854775807::numeric then (attestations.payload->>'providerRequestIndex')::bigint else null end) = exposures.provider_request_index
          and attestations.payload->>'sourceKind' = exposures.source_kind
          and attestations.payload->>'logicalSourceIdentity' = exposures.logical_source_identity
          and attestations.payload->>'contentItemIdentity' = exposures.content_item_identity
          and attestations.payload->>'exposureStage' = exposures.exposure_stage
          and (case when (attestations.payload->>'visibleTokenCount') ~ '^[0-9]+$' and length(attestations.payload->>'visibleTokenCount') <= 19 and (attestations.payload->>'visibleTokenCount')::numeric <= 9223372036854775807::numeric then (attestations.payload->>'visibleTokenCount')::bigint else null end) = exposures.visible_token_count
          and (
            exposures.source_kind <> 'document'
            or (
              attestations.payload->>'documentSourceId' = exposures.document_source_id
              and attestations.payload->>'documentId' = exposures.document_id
              and attestations.payload->>'versionId' = coalesce(to_jsonb(exposures)->>'document_version_id', to_jsonb(exposures)->>'version_id')
              and attestations.payload->>'documentContentHash' = coalesce(to_jsonb(exposures)->>'document_content_hash', to_jsonb(exposures)->>'content_hash')
              and attestations.payload->'documentRanges' is not distinct from exposures.document_ranges
              and attestations.payload->>'publisherExtractionId' is not distinct from to_jsonb(exposures)->>'publisher_extraction_id'
            )
          )
      )
      order by exposures.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_source_exposures/%: exposure has no exact attestation row',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select attestations.id::text as row_identity
      from ai_observations attestations
      where attestations.kind = 'source_exposure_attestation'
        and not exists (
          select 1
          from ai_source_exposures exposures
          where exposures.run_id = attestations.run_id
            and exposures.task_id = attestations.emitting_task
            and exposures.loop_iteration = attestations.loop_iteration
            and exposures.attempt = attestations.attempt
            and (case when (attestations.payload->>'providerRequestIndex') ~ '^[0-9]+$' and length(attestations.payload->>'providerRequestIndex') <= 19 and (attestations.payload->>'providerRequestIndex')::numeric <= 9223372036854775807::numeric then (attestations.payload->>'providerRequestIndex')::bigint else null end) = exposures.provider_request_index
            and attestations.payload->>'sourceKind' = exposures.source_kind
            and attestations.payload->>'logicalSourceIdentity' = exposures.logical_source_identity
            and attestations.payload->>'contentItemIdentity' = exposures.content_item_identity
            and attestations.payload->>'exposureStage' = exposures.exposure_stage
            and (case when (attestations.payload->>'visibleTokenCount') ~ '^[0-9]+$' and length(attestations.payload->>'visibleTokenCount') <= 19 and (attestations.payload->>'visibleTokenCount')::numeric <= 9223372036854775807::numeric then (attestations.payload->>'visibleTokenCount')::bigint else null end) = exposures.visible_token_count
            and (
              attestations.payload->>'sourceKind' <> 'document'
              or (
                attestations.payload->>'documentSourceId' = exposures.document_source_id
                and attestations.payload->>'documentId' = exposures.document_id
                and attestations.payload->>'versionId' = coalesce(to_jsonb(exposures)->>'document_version_id', to_jsonb(exposures)->>'version_id')
                and attestations.payload->>'documentContentHash' = coalesce(to_jsonb(exposures)->>'document_content_hash', to_jsonb(exposures)->>'content_hash')
                and attestations.payload->'documentRanges' is not distinct from exposures.document_ranges
                and attestations.payload->>'publisherExtractionId' is not distinct from to_jsonb(exposures)->>'publisher_extraction_id'
              )
            )
        )
      order by attestations.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_observations/%: exposure attestation has no exact exposure row',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select attestations.id::text as row_identity
      from ai_observations attestations
      where attestations.kind = 'source_exposure_attestation'
        and not exists (
          select 1
          from ai_observations measurements
          where measurements.run_id = attestations.run_id
            and measurements.emitting_task = attestations.emitting_task
            and measurements.loop_iteration = attestations.loop_iteration
            and measurements.attempt = attestations.attempt
            and measurements.kind = 'provider_request_measurement'
            and (case when (measurements.payload->>'providerRequestIndex') ~ '^[0-9]+$' and length(measurements.payload->>'providerRequestIndex') <= 19 and (measurements.payload->>'providerRequestIndex')::numeric <= 9223372036854775807::numeric then (measurements.payload->>'providerRequestIndex')::bigint else null end) = (case when (attestations.payload->>'providerRequestIndex') ~ '^[0-9]+$' and length(attestations.payload->>'providerRequestIndex') <= 19 and (attestations.payload->>'providerRequestIndex')::numeric <= 9223372036854775807::numeric then (attestations.payload->>'providerRequestIndex')::bigint else null end)
            and measurements.payload->>'requestSha256Hex' = attestations.payload->>'providerRequestSha256Hex'
            and measurements.payload->'sourceExposureProofSha256Hexes' @>
                jsonb_build_array(attestations.payload->>'providerSerializationProofSha256Hex')
        )
      order by attestations.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_observations/%: exposure attestation has no exact provider measurement',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select usage_rows.id::text as row_identity
      from ai_run_usage usage_rows
      where not exists (
        select 1
        from ai_observations measurements
        where measurements.run_id = usage_rows.run_id
          and measurements.emitting_task = usage_rows.task_id
          and measurements.loop_iteration = usage_rows.loop_iteration
          and measurements.attempt = usage_rows.attempt
          and measurements.kind = 'provider_request_measurement'
          and (case when (measurements.payload->>'providerRequestIndex') ~ '^[0-9]+$' and length(measurements.payload->>'providerRequestIndex') <= 19 and (measurements.payload->>'providerRequestIndex')::numeric <= 9223372036854775807::numeric then (measurements.payload->>'providerRequestIndex')::bigint else null end) = usage_rows.provider_request_index
          and measurements.payload->>'modelId' = usage_rows.model_id
      )
      order by usage_rows.id
    loop
      raise exception
        'AI chat schema cutover preflight row ai_run_usage/%: usage has no exact provider measurement',
        legacy_row.row_identity;
    end loop;
  -- A version with more than one candidate extraction is also unsafe.  The
  -- full page/range predicate below remains the final lineage check, but the
  -- first failing version must still be named when the candidate set itself
  -- is ambiguous.
  for legacy_row in
      select versions.id::text as row_identity,
             count(extractions.id)::text as candidate_count
      from brief_document_versions versions
      join brief_documents documents on documents.id = versions.brief_document_id
      left join brief_document_extractions extractions
        on extractions.brief_document_id = documents.id
       and extractions.input_sha256_hex = documents.sha256_hex
       and versions.canonical_text = (
         select string_agg(page->>'text', E'\n\n' order by (case when (page->>'pageNumber') ~ '^[0-9]+$' and length(page->>'pageNumber') <= 19 and (page->>'pageNumber')::numeric <= 9223372036854775807::numeric then (page->>'pageNumber')::bigint else null end))
         from jsonb_array_elements(extractions.pages) page
       )
       and extractions.extracted_char_count = (char_length(versions.canonical_text) + (select count(*) from generate_series(1, char_length(versions.canonical_text)) positions(position) where octet_length(convert_to(substr(versions.canonical_text, positions.position, 1), 'UTF8')) = 4))
       and versions.text_char_count = (char_length(versions.canonical_text) + (select count(*) from generate_series(1, char_length(versions.canonical_text)) positions(position) where octet_length(convert_to(substr(versions.canonical_text, positions.position, 1), 'UTF8')) = 4))
       and versions.content_hash = encode(digest(convert_to(versions.canonical_text, 'UTF8'), 'sha256'), 'hex')
      group by versions.id
      having count(extractions.id) > 1
      order by versions.id
    loop
      raise exception
        'AI chat schema cutover preflight row brief_document_versions/%: publisher extraction lineage has % matching candidates',
        legacy_row.row_identity,
        legacy_row.candidate_count;
    end loop;
  for legacy_row in
      select versions.id::text as row_identity
      from brief_document_versions versions
      join brief_documents documents on documents.id = versions.brief_document_id
      where not exists (
        select 1 from brief_document_extractions extractions
        where extractions.brief_document_id = documents.id
          and extractions.input_sha256_hex = documents.sha256_hex
          and versions.canonical_text = (
            select string_agg(page->>'text', E'\n\n' order by (case when (page->>'pageNumber') ~ '^[0-9]+$' and length(page->>'pageNumber') <= 19 and (page->>'pageNumber')::numeric <= 9223372036854775807::numeric then (page->>'pageNumber')::bigint else null end))
            from jsonb_array_elements(extractions.pages) page
          )
          and extractions.extracted_char_count = (char_length(versions.canonical_text) + (select count(*) from generate_series(1, char_length(versions.canonical_text)) positions(position) where octet_length(convert_to(substr(versions.canonical_text, positions.position, 1), 'UTF8')) = 4))
          and versions.text_char_count = (char_length(versions.canonical_text) + (select count(*) from generate_series(1, char_length(versions.canonical_text)) positions(position) where octet_length(convert_to(substr(versions.canonical_text, positions.position, 1), 'UTF8')) = 4))
          and versions.content_hash = encode(digest(convert_to(versions.canonical_text, 'UTF8'), 'sha256'), 'hex')
          and jsonb_array_length(versions.page_ranges) = jsonb_array_length(extractions.pages)
          and not exists (
            with extraction_pages as (
              select
                (case when (page->>'pageNumber') ~ '^[0-9]+$' and length(page->>'pageNumber') <= 19 and (page->>'pageNumber')::numeric <= 9223372036854775807::numeric then (page->>'pageNumber')::bigint else null end) as page_number,
                page->>'text' as page_text
              from jsonb_array_elements(extractions.pages) page
            ), expected_ranges as (
              select
                page_number,
                coalesce(
                  sum((char_length(page_text) + (select count(*) from generate_series(1, char_length(page_text)) positions(position) where octet_length(convert_to(substr(page_text, positions.position, 1), 'UTF8')) = 4)) + 2) over (
                    order by page_number
                    rows between unbounded preceding and 1 preceding
                  ),
                  0
                ) as char_start,
                (
                  coalesce(
                    sum((char_length(page_text) + (select count(*) from generate_series(1, char_length(page_text)) positions(position) where octet_length(convert_to(substr(page_text, positions.position, 1), 'UTF8')) = 4)) + 2) over (
                      order by page_number
                      rows between unbounded preceding and 1 preceding
                    ),
                    0
                  ) + (char_length(page_text) + (select count(*) from generate_series(1, char_length(page_text)) positions(position) where octet_length(convert_to(substr(page_text, positions.position, 1), 'UTF8')) = 4))
                ) as char_end
              from extraction_pages
            )
            select 1
            from expected_ranges expected
            where not exists (
              select 1
              from jsonb_array_elements(versions.page_ranges) range_row
              where (case when (range_row->>'pageNumber') ~ '^[0-9]+$' and length(range_row->>'pageNumber') <= 19 and (range_row->>'pageNumber')::numeric <= 9223372036854775807::numeric then (range_row->>'pageNumber')::bigint else null end) = expected.page_number
                and (case when (range_row->>'charStart') ~ '^[0-9]+$' and length(range_row->>'charStart') <= 19 and (range_row->>'charStart')::numeric <= 9223372036854775807::numeric then (range_row->>'charStart')::bigint else null end) = expected.char_start
                and (case when (range_row->>'charEnd') ~ '^[0-9]+$' and length(range_row->>'charEnd') <= 19 and (range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (range_row->>'charEnd')::bigint else null end) = expected.char_end
            )
          )
      )
      order by versions.id
    loop
      raise exception
        'AI chat schema cutover preflight row brief_document_versions/%: publisher version has no exact extraction lineage',
        legacy_row.row_identity;
    end loop;
  for legacy_row in
      select versions.id::text as row_identity,
             count(extractions.id)::text as candidate_count
      from brief_document_versions versions
      join brief_documents documents on documents.id = versions.brief_document_id
      left join brief_document_extractions extractions
        on extractions.brief_document_id = documents.id
       and extractions.input_sha256_hex = documents.sha256_hex
       and versions.canonical_text = (
         select string_agg(page->>'text', E'\n\n' order by (case when (page->>'pageNumber') ~ '^[0-9]+$' and length(page->>'pageNumber') <= 19 and (page->>'pageNumber')::numeric <= 9223372036854775807::numeric then (page->>'pageNumber')::bigint else null end))
         from jsonb_array_elements(extractions.pages) page
       )
       and extractions.extracted_char_count = (char_length(versions.canonical_text) + (select count(*) from generate_series(1, char_length(versions.canonical_text)) positions(position) where octet_length(convert_to(substr(versions.canonical_text, positions.position, 1), 'UTF8')) = 4))
       and versions.text_char_count = (char_length(versions.canonical_text) + (select count(*) from generate_series(1, char_length(versions.canonical_text)) positions(position) where octet_length(convert_to(substr(versions.canonical_text, positions.position, 1), 'UTF8')) = 4))
       and versions.content_hash = encode(digest(convert_to(versions.canonical_text, 'UTF8'), 'sha256'), 'hex')
       and jsonb_array_length(versions.page_ranges) = jsonb_array_length(extractions.pages)
       and not exists (
         with extraction_pages as (
           select
             (case when (page->>'pageNumber') ~ '^[0-9]+$' and length(page->>'pageNumber') <= 19 and (page->>'pageNumber')::numeric <= 9223372036854775807::numeric then (page->>'pageNumber')::bigint else null end) as page_number,
             page->>'text' as page_text
           from jsonb_array_elements(extractions.pages) page
         ), expected_ranges as (
           select
             page_number,
             coalesce(
               sum((char_length(page_text) + (select count(*) from generate_series(1, char_length(page_text)) positions(position) where octet_length(convert_to(substr(page_text, positions.position, 1), 'UTF8')) = 4)) + 2) over (
                 order by page_number
                 rows between unbounded preceding and 1 preceding
               ),
               0
             ) as char_start,
             (
               coalesce(
                 sum((char_length(page_text) + (select count(*) from generate_series(1, char_length(page_text)) positions(position) where octet_length(convert_to(substr(page_text, positions.position, 1), 'UTF8')) = 4)) + 2) over (
                   order by page_number
                   rows between unbounded preceding and 1 preceding
                 ),
                 0
               ) + (char_length(page_text) + (select count(*) from generate_series(1, char_length(page_text)) positions(position) where octet_length(convert_to(substr(page_text, positions.position, 1), 'UTF8')) = 4))
             ) as char_end
           from extraction_pages
         )
         select 1
         from expected_ranges expected
         where not exists (
           select 1
           from jsonb_array_elements(versions.page_ranges) range_row
           where (case when (range_row->>'pageNumber') ~ '^[0-9]+$' and length(range_row->>'pageNumber') <= 19 and (range_row->>'pageNumber')::numeric <= 9223372036854775807::numeric then (range_row->>'pageNumber')::bigint else null end) = expected.page_number
             and (case when (range_row->>'charStart') ~ '^[0-9]+$' and length(range_row->>'charStart') <= 19 and (range_row->>'charStart')::numeric <= 9223372036854775807::numeric then (range_row->>'charStart')::bigint else null end) = expected.char_start
             and (case when (range_row->>'charEnd') ~ '^[0-9]+$' and length(range_row->>'charEnd') <= 19 and (range_row->>'charEnd')::numeric <= 9223372036854775807::numeric then (range_row->>'charEnd')::bigint else null end) = expected.char_end
         )
       )
      group by versions.id
      having count(extractions.id) <> 1
      order by versions.id
    loop
      raise exception
        'AI chat schema cutover preflight row brief_document_versions/%: publisher extraction lineage has % matching candidates',
        legacy_row.row_identity,
        legacy_row.candidate_count;
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

-- JavaScript counts UTF-16 code units. PostgreSQL's char_length counts Unicode
-- code points, so add one unit for each four-byte UTF-8 code point (the astral
-- planes) wherever a stored text count or range is checked.
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

-- Legacy owner/role/document-version names are invalid object keys. Walk the
-- complete JSON tree so ordinary string values never trigger a blocker.
create or replace function brief_ai_legacy_json_key(p_value jsonb)
returns text
language plpgsql
immutable
strict
as $$
declare
  entry record;
  nested_key text;
begin
  if jsonb_typeof(p_value) = 'object' then
    for entry in select key, value from jsonb_each(p_value) loop
      if entry.key in (
        'owner', 'ownerId', 'owner_id', 'role', 'agent_role',
        'versionId', 'publisherDocumentVersionId'
      ) then
        return entry.key;
      end if;
      nested_key := brief_ai_legacy_json_key(entry.value);
      if nested_key is not null then return nested_key; end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for entry in select value from jsonb_array_elements(p_value) loop
      nested_key := brief_ai_legacy_json_key(entry.value);
      if nested_key is not null then return nested_key; end if;
    end loop;
  end if;
  return null;
end
$$;

create or replace function brief_ai_uuid_text(p_value text)
returns boolean
language sql
immutable
strict
as $$
  select p_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

create or replace function brief_ai_valid_restricted_context_ledger(p_value jsonb)
returns boolean
language plpgsql
immutable
strict
as $$
declare
  entry record;
  kind text;
  source_value jsonb;
  range_value jsonb;
  conversation_value jsonb;
  packet_value jsonb;
begin
  if jsonb_typeof(p_value) is distinct from 'object' then return false; end if;
  kind := p_value->>'requestKind';
  if kind not in ('direct', 'topic', 'synthesis')
    or jsonb_typeof(p_value->'modelId') is distinct from 'string'
    or coalesce(btrim(p_value->>'modelId'), '') = ''
    or jsonb_typeof(p_value->'requestSha256Hex') is distinct from 'string'
    or p_value->>'requestSha256Hex' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_value->'inputTokens') is distinct from 'number'
    or jsonb_typeof(p_value->'usableInputTokens') is distinct from 'number'
    or jsonb_typeof(p_value->'requestedOutputTokens') is distinct from 'number'
    or p_value->>'inputTokens' !~ '^[0-9]+$'
    or p_value->>'usableInputTokens' !~ '^[0-9]+$'
    or p_value->>'requestedOutputTokens' !~ '^[0-9]+$'
    or brief_ai_safe_bigint(p_value->>'inputTokens') is null
    or brief_ai_safe_bigint(p_value->>'usableInputTokens') is null
    or brief_ai_safe_bigint(p_value->>'requestedOutputTokens') is null
    or brief_ai_safe_bigint(p_value->>'inputTokens') > 9007199254740991
    or brief_ai_safe_bigint(p_value->>'usableInputTokens') > 9007199254740991
    or brief_ai_safe_bigint(p_value->>'requestedOutputTokens') > 9007199254740991
    or brief_ai_safe_bigint(p_value->>'requestedOutputTokens') <= 0
    or brief_ai_safe_bigint(p_value->>'usableInputTokens') <= 0
    or brief_ai_safe_bigint(p_value->>'inputTokens') > brief_ai_safe_bigint(p_value->>'usableInputTokens')
    or jsonb_typeof(p_value->'selectedConversation') is distinct from 'array' then
    return false;
  end if;
  for conversation_value in select value from jsonb_array_elements(p_value->'selectedConversation') values(value) loop
    if jsonb_typeof(conversation_value) is distinct from 'object'
      or conversation_value->>'kind' not in ('complete', 'failed')
      or jsonb_typeof(conversation_value->'turnId') is distinct from 'string'
      or jsonb_typeof(conversation_value->'userMessageId') is distinct from 'string'
      or not brief_ai_uuid_text(conversation_value->>'turnId')
      or not brief_ai_uuid_text(conversation_value->>'userMessageId') then
      return false;
    end if;
    if conversation_value->>'kind' = 'complete' then
      if jsonb_typeof(conversation_value->'assistantMessageId') is distinct from 'string'
        or not brief_ai_uuid_text(conversation_value->>'assistantMessageId')
        or exists (select 1 from jsonb_object_keys(conversation_value) key
                   where key not in ('kind','turnId','userMessageId','assistantMessageId')) then
        return false;
      end if;
    else
      if jsonb_typeof(conversation_value->'errorCode') is distinct from 'string'
        or jsonb_typeof(conversation_value->'retryable') is distinct from 'boolean'
        or coalesce(btrim(conversation_value->>'errorCode'), '') = ''
        or exists (select 1 from jsonb_object_keys(conversation_value) key
                   where key not in ('kind','turnId','userMessageId','errorCode','retryable')) then
        return false;
      end if;
    end if;
  end loop;
  if kind in ('direct', 'topic') then
    if jsonb_typeof(p_value->'question') is distinct from 'string'
      or coalesce(btrim(p_value->>'question'), '') = ''
      or jsonb_typeof(p_value->'gaps') is distinct from 'array'
      or exists (select 1 from jsonb_array_elements(p_value->'gaps') value
                 where jsonb_typeof(value) is distinct from 'string')
      or jsonb_typeof(p_value->'sources') is distinct from 'array' then
      return false;
    end if;
    if kind = 'topic' and (jsonb_typeof(p_value->'topicId') is distinct from 'string'
      or p_value->>'topicId' not in ('t1','t2','t3')) then
      return false;
    end if;
    for source_value in select value from jsonb_array_elements(p_value->'sources') values(value) loop
      if jsonb_typeof(source_value) is distinct from 'object'
        or jsonb_typeof(source_value->'candidateId') is distinct from 'string'
        or coalesce(btrim(source_value->>'candidateId'), '') = ''
        or jsonb_typeof(source_value->'sourceKey') is distinct from 'string'
        or source_value->>'sourceKey' !~ '^k_(?:cn_[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]+)_[1-9][0-9]*$'
        or brief_ai_safe_bigint(substring(source_value->>'sourceKey' from '_([1-9][0-9]*)$')) is null
        or brief_ai_safe_bigint(substring(source_value->>'sourceKey' from '_([1-9][0-9]*)$')) > 2147483647
        or source_value->>'kind' not in ('document','chat_message','memory','web')
        or jsonb_typeof(source_value->'purpose') is distinct from 'string'
        or coalesce(btrim(source_value->>'purpose'), '') = ''
        or not jsonb_exists(source_value, 'label')
        or jsonb_typeof(source_value->'label') not in ('string','null')
        or jsonb_typeof(source_value->'ranges') is distinct from 'array'
        or exists (select 1 from jsonb_array_elements(source_value->'ranges') value
                   where jsonb_typeof(value) is distinct from 'object'
                     or jsonb_typeof(value->'charStart') is distinct from 'number'
                     or jsonb_typeof(value->'charEnd') is distinct from 'number'
                     or value->>'charStart' !~ '^[0-9]+$'
                     or value->>'charEnd' !~ '^[0-9]+$'
                     or brief_ai_safe_bigint(value->>'charStart') is null
                     or brief_ai_safe_bigint(value->>'charEnd') is null
                     or brief_ai_safe_bigint(value->>'charStart') > 9007199254740991
                     or brief_ai_safe_bigint(value->>'charEnd') > 9007199254740991
                     or brief_ai_safe_bigint(value->>'charStart') < 0
                     or brief_ai_safe_bigint(value->>'charEnd') <= 0
                     or brief_ai_safe_bigint(value->>'charEnd') <= brief_ai_safe_bigint(value->>'charStart')
                     or exists (
                       select 1 from jsonb_object_keys(value) key
                       where key not in ('charStart', 'charEnd')
                     ))
        or exists (select 1 from jsonb_object_keys(source_value) key
                   where key not in ('candidateId','sourceKey','kind','purpose','label','ranges')) then
        return false;
      end if;
    end loop;
    if exists (select 1 from jsonb_object_keys(p_value) key
               where key not in ('requestKind','modelId','requestSha256Hex','inputTokens',
                                 'usableInputTokens','requestedOutputTokens','selectedConversation',
                                 'question','topicId','gaps','sources')) then
      return false;
    end if;
  else
    if jsonb_typeof(p_value->'packets') is distinct from 'array'
      or jsonb_array_length(p_value->'packets') < 2
      or jsonb_array_length(p_value->'packets') > 3 then
      return false;
    end if;
    for packet_value in select value from jsonb_array_elements(p_value->'packets') values(value) loop
      if jsonb_typeof(packet_value) is distinct from 'object'
        or packet_value->>'topicId' not in ('t1','t2','t3')
        or packet_value->>'status' not in ('answered','partial')
        or jsonb_typeof(packet_value->'claimCount') is distinct from 'number'
        or jsonb_typeof(packet_value->'gapCount') is distinct from 'number'
        or packet_value->>'claimCount' !~ '^[0-9]+$'
        or packet_value->>'gapCount' !~ '^[0-9]+$'
        or brief_ai_safe_bigint(packet_value->>'claimCount') is null
        or brief_ai_safe_bigint(packet_value->>'gapCount') is null
        or brief_ai_safe_bigint(packet_value->>'claimCount') > 9007199254740991
        or brief_ai_safe_bigint(packet_value->>'gapCount') > 9007199254740991
        or jsonb_typeof(packet_value->'packetSha256Hex') is distinct from 'string'
        or packet_value->>'packetSha256Hex' !~ '^[0-9a-f]{64}$'
        or exists (select 1 from jsonb_object_keys(packet_value) key
                   where key not in ('topicId','status','claimCount','gapCount','packetSha256Hex')) then
        return false;
      end if;
    end loop;
    if exists (select 1 from jsonb_object_keys(p_value) key
               where key not in ('requestKind','modelId','requestSha256Hex','inputTokens',
                                 'usableInputTokens','requestedOutputTokens','selectedConversation','packets')) then
      return false;
    end if;
  end if;
  return true;
end
$$;

create or replace function brief_ai_valid_terminal_usage_coordinate(p_value jsonb)
returns boolean
language sql
immutable
strict
as $$
  select jsonb_typeof(p_value) = 'object'
    and jsonb_typeof(p_value->'taskId') = 'string'
    and btrim(p_value->>'taskId') <> ''
    and jsonb_typeof(p_value->'loopIteration') = 'number'
    and jsonb_typeof(p_value->'attempt') = 'number'
    and jsonb_typeof(p_value->'providerRequestIndex') = 'number'
    and (p_value->>'loopIteration') ~ '^[0-9]+$'
    and (p_value->>'attempt') ~ '^[0-9]+$'
    and (p_value->>'providerRequestIndex') ~ '^[0-9]+$'
    and brief_ai_safe_bigint(p_value->>'loopIteration') <= 9007199254740991
    and brief_ai_safe_bigint(p_value->>'attempt') <= 9007199254740991
    and brief_ai_safe_bigint(p_value->>'providerRequestIndex') <= 9007199254740991
    and not exists (
      select 1 from jsonb_object_keys(p_value) key
      where key not in ('taskId','loopIteration','attempt','providerRequestIndex')
    )
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

create or replace function brief_ai_normalize_ranges(ranges jsonb)
returns jsonb
language plpgsql
immutable
strict
as $$
declare
  item jsonb;
  ordered record;
  char_start bigint;
  char_end bigint;
  previous jsonb;
  normalized jsonb := '[]'::jsonb;
  last_index integer;
begin
  if jsonb_typeof(ranges) is distinct from 'array' then
    return null;
  end if;
  for ordered in
    select value
    from jsonb_array_elements(ranges) values(value)
    order by brief_ai_safe_bigint(value->>'charStart'),
             brief_ai_safe_bigint(value->>'charEnd')
  loop
    item := ordered.value;
    char_start := brief_ai_safe_bigint(item->>'charStart');
    char_end := brief_ai_safe_bigint(item->>'charEnd');
    if jsonb_typeof(item) is distinct from 'object'
      or (item - 'charStart' - 'charEnd') <> '{}'::jsonb
      or jsonb_typeof(item->'charStart') is distinct from 'number'
      or jsonb_typeof(item->'charEnd') is distinct from 'number'
      or char_start is null
      or char_end is null
      or char_end <= char_start then
      return null;
    end if;
    if normalized = '[]'::jsonb then
      normalized := jsonb_build_array(jsonb_build_object('charStart', char_start, 'charEnd', char_end));
    else
      last_index := jsonb_array_length(normalized) - 1;
      previous := normalized->last_index;
      if char_start <= brief_ai_safe_bigint(previous->>'charEnd') then
        normalized := jsonb_set(
          normalized,
          array[last_index::text],
          jsonb_build_object(
            'charStart', brief_ai_safe_bigint(previous->>'charStart'),
            'charEnd', greatest(brief_ai_safe_bigint(previous->>'charEnd'), char_end)
          )
        );
      else
        normalized := normalized || jsonb_build_array(jsonb_build_object('charStart', char_start, 'charEnd', char_end));
      end if;
    end if;
  end loop;
  return normalized;
end
$$;

-- PostgreSQL's POSIX classes follow the database locale. Source IDs use the
-- fixed ECMAScript whitespace set, including line terminators and FEFF.
create or replace function brief_ai_valid_document_source_id(p_value text)
returns boolean
language sql
immutable
strict
as $$
  select p_value ~ '^(public|publisher):[^:]+$'
    and not exists (
      select 1
      from generate_series(1, char_length(p_value)) positions(position)
      where ascii(substr(p_value, positions.position, 1)) in (9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279)
        or ascii(substr(p_value, positions.position, 1)) between 8192 and 8202
    )
$$;

drop table if exists public.ai_chat_load_turn;
drop table if exists public.ai_chat_memory;
drop table if exists public.ai_chat_resolution;
drop table if exists public.ai_chat_plan;
drop table if exists public.ai_chat_plan_turn;
drop table if exists public.ai_chat_internal;
drop table if exists public.ai_chat_memories;
drop table if exists public.ai_chat_web;
drop table if exists public.ai_chat_assembly;
drop table if exists public.ai_chat_context;
drop table if exists public.ai_chat_reduction_plan;
drop table if exists public.ai_chat_answer;
drop table if exists public.ai_chat_allocation;
drop table if exists public.ai_chat_fanout_sources;
drop table if exists public.ai_chat_topic_result;
drop table if exists public.ai_chat_fanout_collect;
drop table if exists public.ai_chat_finalize;
drop table if exists public.ai_chat_preflight;
drop table if exists public.ai_chat_hydrate;
drop table if exists public.ai_chat_preflight2;
drop table if exists public.ai_chat_hydrate2;
drop table if exists public.ai_chat_answer2;
drop table if exists public.ai_chat_selectors;
drop table if exists public.ai_chat_fanout_contexts;

-- Introduce the final namespace column before the one-time nonce conversion.
-- The preflight above only inspected retained rows; this is the first schema
-- mutation and remains fenced by the shared Smithers lock.
alter table ai_runs
  add column if not exists citation_namespace text;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_nonce'
  ) then
    execute $sql$
      update ai_runs
      set citation_namespace = case
        when citation_namespace is not null then citation_namespace
        when citation_nonce is not null then 'cn_' || translate(rtrim(encode(citation_nonce, 'base64'), '='), '+/', '-_')
        else null
      end
      where citation_namespace is null
    $sql$;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from ai_runs where citation_namespace is null
       or citation_namespace !~ '^cn_[A-Za-z0-9_-]{22}$'
  ) then
    raise exception 'AI chat schema cutover found an invalid citation namespace';
  end if;
  if exists (
    select citation_namespace from ai_runs group by citation_namespace having count(*) > 1
  ) then
    raise exception 'AI chat schema cutover found a citation namespace collision';
  end if;
end
$$;

alter table ai_runs
  alter column citation_namespace set default (
    'cn_' || translate(rtrim(encode(gen_random_bytes(16), 'base64'), '='), '+/', '-_')
  ),
  alter column citation_namespace set not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_runs_citation_namespace_shape') then
    alter table ai_runs add constraint ai_runs_citation_namespace_shape
      check (citation_namespace ~ '^cn_[A-Za-z0-9_-]{22}$');
  end if;
end
$$;
create unique index if not exists ai_runs_citation_namespace_key on ai_runs (citation_namespace);

-- Re-key retained citations into the final per-answer namespace. The old key
-- spelling is not a durable contract; only its numeric order matters during
-- this one cutover. Update uses, source rows, and rendered citation tags as a
-- single deterministic mapping before the old key can be discarded.
drop table if exists ai_chat_source_key_cutover;
create temporary table ai_chat_source_key_cutover on commit drop as
select sources.assistant_message_id,
       sources.source_key as old_source_key,
       (substring(sources.source_key from '_([1-9][0-9]*)$'))::numeric as ordinal,
       'k_' || runs.citation_namespace || '_' ||
         (substring(sources.source_key from '_([1-9][0-9]*)$'))::text as new_source_key
from assistant_message_sources sources
join chat_messages messages on messages.id = sources.assistant_message_id
join ai_runs runs
  on runs.assistant_message_id = messages.id
 and runs.id = messages.assistant_ai_run_id;

create or replace function ai_chat_rewrite_source_keys(p_value jsonb, p_message_id uuid)
returns jsonb
language plpgsql
as $$
declare
  rewritten jsonb;
  item record;
  mapped_key text;
begin
  if p_value is null then return null; end if;
  case jsonb_typeof(p_value)
    when 'array' then
      select coalesce(jsonb_agg(ai_chat_rewrite_source_keys(value, p_message_id)), '[]'::jsonb)
      into rewritten
      from jsonb_array_elements(p_value) values(value);
      return rewritten;
    when 'object' then
      select coalesce(jsonb_object_agg(
        key,
        case
          when key = 'sourceKey'
            and jsonb_typeof(value) = 'string'
            and (
              (select count(*) from jsonb_object_keys(p_value)) = 1
              or p_value ?| array[
                'assistantMessageId', 'memoryId', 'memoryRevisionId',
                'messageId'
              ]
              or p_value->>'kind' in ('document', 'chat_message', 'memory', 'web')
              or (p_value ? 'ranges' and p_value ? 'tokenCount')
              or (p_value ? 'url' and p_value ? 'quote' and p_value ? 'domain')
            ) then
            coalesce((
              select to_jsonb(mapping.new_source_key)
              from ai_chat_source_key_cutover mapping
              where mapping.assistant_message_id = p_message_id
                and mapping.old_source_key = value #>> '{}'
            ), value)
          when key = 'sourceKeys'
            and jsonb_typeof(value) = 'array' then (
            select coalesce(jsonb_agg(
              case
                when jsonb_typeof(values.value) = 'string' then coalesce((
                  select to_jsonb(mapping.new_source_key)
                  from ai_chat_source_key_cutover mapping
                  where mapping.assistant_message_id = p_message_id
                    and mapping.old_source_key = values.value #>> '{}'
                ), values.value)
                else ai_chat_rewrite_source_keys(values.value, p_message_id)
              end
              order by values.ordinality
            ), '[]'::jsonb)
            from jsonb_array_elements(value) with ordinality values(value, ordinality)
          )
          when key = 'sourcesRead'
            and jsonb_typeof(value) = 'array'
            and p_value ?| array['type', 'mode', 'reductionRan', 'consumers'] then (
            select coalesce(jsonb_agg(
              ai_chat_rewrite_source_keys(values.value, p_message_id)
              order by values.ordinality
            ), '[]'::jsonb)
            from jsonb_array_elements(value) with ordinality values(value, ordinality)
          )
          else ai_chat_rewrite_source_keys(value, p_message_id)
        end
      ), '{}'::jsonb)
      into rewritten
      from jsonb_each(p_value) entries(key, value);
      return rewritten;
    when 'string' then
      -- Strings remain opaque except for complete, known citation tags.  The
      -- citation parser protects fenced, HTML, indented, and inline code.
      return to_jsonb(ai_chat_rewrite_citations(p_value #>> '{}', p_message_id));
    else
      return p_value;
  end case;
end
$$;

do $$
begin
  if exists (
    select assistant_message_id, ordinal
    from ai_chat_source_key_cutover
    group by assistant_message_id, ordinal
    having count(*) > 1
  ) then
    raise exception 'AI chat schema cutover found duplicate source ordinals';
  end if;
  if exists (
    select 1
    from ai_chat_source_key_cutover
    where ordinal > 2147483647
  ) then
    raise exception 'AI chat schema cutover found an unsafe citation ordinal';
  end if;
  if exists (
    select assistant_message_id, new_source_key
    from ai_chat_source_key_cutover
    group by assistant_message_id, new_source_key
    having count(*) > 1
  ) then
      raise exception 'AI chat schema cutover found a source key collision';
  end if;
  if exists (
    select 1
    from assistant_message_sources sources
    where not exists (
      select 1
      from ai_chat_source_key_cutover mapped
      where mapped.assistant_message_id = sources.assistant_message_id
        and mapped.old_source_key = sources.source_key
    )
  ) or exists (
    select 1
    from assistant_message_source_uses uses
    where not exists (
      select 1
      from ai_chat_source_key_cutover mapped
      where mapped.assistant_message_id = uses.assistant_message_id
        and mapped.old_source_key = uses.source_key
    )
  ) then
    raise exception 'AI chat schema cutover found a source row without a bound answer namespace';
  end if;
end
$$;

create or replace function ai_chat_rewrite_citations(p_content text, p_message_id uuid)
returns text
language plpgsql
as $$
declare
  output text := '';
  cursor_pos integer := 1;
  match_pos integer;
  close_pos integer;
  scan_pos integer;
  candidate_length integer;
  backslash_count integer;
  span_length integer;
  escaped boolean;
  line_end integer;
  run_length integer;
  fence_length integer := 0;
  fence_char text;
  fence_match text[];
  html_match text[];
  html_name text;
  in_fence boolean := false;
  tag text;
  tag_body text;
  replacement text;
  mapped_key text;
  key_value text;
  key_values text[];
  all_mapped boolean;
begin
  if p_content is null then return null; end if;
  while cursor_pos <= char_length(p_content) loop
    if in_fence then
      if cursor_pos = 1 or substr(p_content, cursor_pos - 1, 1) = E'\n' then
        fence_match := regexp_match(
          substr(p_content, cursor_pos),
          format('^( {0,3}%s{%s,}[ \t]*(?:\n|$))', fence_char, fence_length)
        );
        if fence_match is not null then
          output := output || fence_match[1];
          cursor_pos := cursor_pos + length(fence_match[1]);
          in_fence := false;
          continue;
        end if;
      end if;
      output := output || substr(p_content, cursor_pos, 1);
      cursor_pos := cursor_pos + 1;
      continue;
    end if;

    -- Indented Markdown code is a code block even without a fence.
    if (cursor_pos = 1 or substr(p_content, cursor_pos - 1, 1) = E'\n')
      and (substr(p_content, cursor_pos, 4) = '    ' or substr(p_content, cursor_pos, 1) = E'\t') then
      line_end := strpos(substr(p_content, cursor_pos), E'\n');
      if line_end = 0 then line_end := char_length(p_content) - cursor_pos + 1; end if;
      output := output || substr(p_content, cursor_pos, line_end);
      cursor_pos := cursor_pos + line_end;
      continue;
    end if;

    -- CommonMark fenced code supports both backticks and tildes.  Only a
    -- fence at the start of a line (with up to three spaces) opens a block.
    if cursor_pos = 1 or substr(p_content, cursor_pos - 1, 1) = E'\n' then
      fence_match := regexp_match(substr(p_content, cursor_pos), '^ {0,3}(`{3,}|~{3,})');
      if fence_match is not null then
        fence_char := left(fence_match[1], 1);
        fence_length := length(fence_match[1]);
        in_fence := true;
        line_end := strpos(substr(p_content, cursor_pos), E'\n');
        if line_end = 0 then line_end := char_length(p_content) - cursor_pos + 1; end if;
        output := output || substr(p_content, cursor_pos, line_end);
        cursor_pos := cursor_pos + line_end;
        continue;
      end if;
    end if;

    -- HTML pre/code blocks are code for the renderer and must remain byte
    -- identical, including any citation-shaped text inside them.
    html_match := regexp_match(substr(p_content, cursor_pos), '^<([cC][oO][dD][eE]|[pP][rR][eE])(?:[[:space:]>])');
    if html_match is not null then
      html_name := lower(html_match[1]);
      close_pos := strpos(lower(substr(p_content, cursor_pos)), '</' || html_name || '>');
      if close_pos = 0 then
        output := output || substr(p_content, cursor_pos);
        return output;
      end if;
      output := output || substr(p_content, cursor_pos, close_pos + length(html_name) + 2);
      cursor_pos := cursor_pos + close_pos + length(html_name) + 2;
      continue;
    end if;

    -- Inline code spans protect their contents.  A run of three or more
    -- backticks is handled here too when it is not line-start fenced syntax.
    if substr(p_content, cursor_pos, 1) = '`' then
      -- A backslash-escaped delimiter is ordinary text.  Count the complete
      -- run of preceding backslashes so only an odd run escapes the tick.
      backslash_count := 0;
      scan_pos := cursor_pos - 1;
      while scan_pos >= 1 and substr(p_content, scan_pos, 1) = E'\\' loop
        backslash_count := backslash_count + 1;
        scan_pos := scan_pos - 1;
      end loop;
      escaped := mod(backslash_count, 2) = 1;
      if escaped then
        output := output || substr(p_content, cursor_pos, 1);
        cursor_pos := cursor_pos + 1;
        continue;
      end if;
      run_length := 1;
      while substr(p_content, cursor_pos + run_length, 1) = '`' loop
        run_length := run_length + 1;
      end loop;
      -- Find an exact closing run.  strpos() can match a run inside a longer
      -- delimiter and therefore leaves part of the closing run to be parsed
      -- as a second span.
      close_pos := 0;
      scan_pos := cursor_pos + run_length;
      while scan_pos <= char_length(p_content) loop
        if substr(p_content, scan_pos, 1) = '`' then
          candidate_length := 1;
          while substr(p_content, scan_pos + candidate_length, 1) = '`' loop
            candidate_length := candidate_length + 1;
          end loop;
          -- Backslashes have no escape meaning inside a CommonMark code span;
          -- an exact closing run closes even when preceded by a backslash.
          if candidate_length = run_length then
            close_pos := scan_pos - (cursor_pos + run_length) + 1;
            exit;
          end if;
          scan_pos := scan_pos + candidate_length;
        else
          scan_pos := scan_pos + 1;
        end if;
      end loop;
      if close_pos = 0 then
        -- An unmatched backtick run is literal Markdown. Keep scanning so a
        -- later complete citation tag still gets rewritten.
        output := output || substr(p_content, cursor_pos, run_length);
        cursor_pos := cursor_pos + run_length;
        continue;
      end if;
      -- close_pos is relative to the text after the opening run.  The full
      -- span includes both delimiter runs, so its length is
      -- close_pos + (2 * run_length) - 1.
      span_length := close_pos + (2 * run_length) - 1;
      output := output || substr(p_content, cursor_pos, span_length);
      cursor_pos := cursor_pos + span_length;
      continue;
    end if;

    if substr(p_content, cursor_pos, 7) = '[[cite:' then
      match_pos := cursor_pos;
      tag_body := (regexp_match(
        substr(p_content, match_pos),
        '^\[\[cite:(k_[A-Za-z0-9_-]+_[1-9][0-9]*(?:,k_[A-Za-z0-9_-]+_[1-9][0-9]*)*)\]\]'
      ))[1];
      if tag_body is null then
        -- Advance one character only.  A malformed opening must not consume
        -- a later independent complete tag.
        output := output || substr(p_content, cursor_pos, 1);
        cursor_pos := cursor_pos + 1;
        continue;
      end if;
      tag := '[[cite:' || tag_body || ']]';
      key_values := string_to_array(tag_body, ',');
      replacement := '[[cite:';
      all_mapped := true;
      foreach key_value in array key_values loop
        select mapped.new_source_key
        into mapped_key
        from ai_chat_source_key_cutover mapped
        where mapped.assistant_message_id = p_message_id
          and mapped.old_source_key = key_value;
        if mapped_key is null then
          all_mapped := false;
          exit;
        end if;
        replacement := replacement || case when replacement = '[[cite:' then '' else ',' end || mapped_key;
      end loop;
      output := output || case when all_mapped then replacement || ']]' else tag end;
      cursor_pos := cursor_pos + length(tag);
      continue;
    end if;

    output := output || substr(p_content, cursor_pos, 1);
    cursor_pos := cursor_pos + 1;
  end loop;
  return output;
end
$$;

alter table assistant_message_source_uses
  drop constraint if exists assistant_message_source_uses_source_fkey,
  drop constraint if exists assistant_message_source_uses_assistant_message_id_source_key_fkey;
drop trigger if exists assistant_message_sources_identity_immutable on assistant_message_sources;
drop trigger if exists assistant_message_source_uses_identity_immutable on assistant_message_source_uses;

update assistant_message_source_uses uses
set source_key = map.new_source_key
from ai_chat_source_key_cutover map
where uses.assistant_message_id = map.assistant_message_id
  and uses.source_key = map.old_source_key;

update assistant_message_sources sources
set source_key = map.new_source_key
from ai_chat_source_key_cutover map
where sources.assistant_message_id = map.assistant_message_id
  and sources.source_key = map.old_source_key;

update ai_observations observations
set payload = ai_chat_rewrite_source_keys(observations.payload, runs.assistant_message_id)
from ai_runs runs
where runs.id = observations.run_id
;
update ai_run_events events
set event = ai_chat_rewrite_source_keys(events.event, runs.assistant_message_id)
from ai_runs runs
where runs.id = events.run_id;

do $$
begin
  if to_regprocedure('ai_chat_rewrite_citations(text,uuid)') is not null then
    execute $sql$
      update chat_messages messages
      set content = ai_chat_rewrite_citations(messages.content, messages.id)
      where exists (
        select 1 from ai_chat_source_key_cutover mapping
        where mapping.assistant_message_id = messages.id
      )
    $sql$;
  end if;
end
$$;

drop function if exists ai_chat_rewrite_citations(text, uuid);
drop function if exists ai_chat_rewrite_source_keys(jsonb, uuid);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'assistant_message_source_uses_final_source_fkey') then
    alter table assistant_message_source_uses add constraint assistant_message_source_uses_final_source_fkey
      foreign key (assistant_message_id, source_key)
      references assistant_message_sources (assistant_message_id, source_key)
      on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'assistant_message_sources_final_key_shape') then
    alter table assistant_message_sources add constraint assistant_message_sources_final_key_shape
      check (
        source_key ~ '^k_cn_[A-Za-z0-9_-]{22}_[1-9][0-9]*$'
        and brief_ai_safe_bigint(substring(source_key from '_([1-9][0-9]*)$')) is not null
        and brief_ai_safe_bigint(substring(source_key from '_([1-9][0-9]*)$')) <= 2147483647
      );
  end if;
end
$$;

alter table ai_runs drop column if exists citation_nonce;

-- Product rows keep one strict locator. The old typed reconstruction columns
-- become server-owned version and extraction identities.
alter table assistant_message_sources
  drop constraint if exists assistant_message_sources_document_version_id_fkey,
  drop constraint if exists assistant_message_sources_publisher_document_version_id_fkey,
  drop constraint if exists assistant_message_sources_publisher_document_version_fkey,
  drop constraint if exists assistant_message_sources_typed_identity_valid;
drop trigger if exists assistant_message_sources_validate_document on assistant_message_sources;
alter table assistant_message_sources
  add column if not exists version_id text,
  add column if not exists publisher_extraction_id uuid,
  add column if not exists document_source_id text,
  add column if not exists document_id text,
  add column if not exists content_hash text;

-- A ready publisher version points to one immutable extraction. The pair is
-- unique in both directions so a source row can bind to the exact extraction
-- without relying on a same-document guess.
alter table brief_document_versions
  add column if not exists publisher_extraction_id uuid;

-- The 0063 immutable trigger covers text and hashes, while the 0016 trigger
-- rejects every update. Drop both only inside this fenced transaction so the
-- one-time binding update can run, then restore the immutable guards below.
drop trigger if exists brief_document_versions_no_update on brief_document_versions;
drop trigger if exists brief_document_versions_protect_text_hash on brief_document_versions;
drop trigger if exists brief_document_versions_ready_immutable on brief_document_versions;
update brief_document_versions versions
set publisher_extraction_id = extractions.id
from brief_document_extractions extractions
join brief_documents documents on documents.id = extractions.brief_document_id
where documents.id = versions.brief_document_id
  and extractions.input_sha256_hex = documents.sha256_hex
  and versions.canonical_text = (
    select string_agg(page->>'text', E'\n\n' order by brief_ai_safe_bigint(page->>'pageNumber'))
    from jsonb_array_elements(extractions.pages) page
  )
  and versions.text_char_count = brief_ai_utf16_length(versions.canonical_text)
  and versions.content_hash = encode(digest(convert_to(versions.canonical_text, 'UTF8'), 'sha256'), 'hex')
  and versions.publisher_extraction_id is null;
do $$
begin
  if exists (select 1 from brief_document_versions where publisher_extraction_id is null) then
    raise exception 'AI chat schema cutover found a publisher version without an extraction binding';
  end if;
  if exists (
    select publisher_extraction_id from brief_document_versions
    group by publisher_extraction_id having count(*) > 1
  ) then
    raise exception 'AI chat schema cutover found a publisher extraction bound to multiple versions';
  end if;
end
$$;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'brief_document_versions_publisher_extraction_unique') then
    alter table brief_document_versions add constraint brief_document_versions_publisher_extraction_unique
      unique (publisher_extraction_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'brief_document_versions_publisher_extraction_fkey') then
    alter table brief_document_versions add constraint brief_document_versions_publisher_extraction_fkey
      foreign key (publisher_extraction_id) references brief_document_extractions (id) on delete restrict;
  end if;
end
$$;
alter table brief_document_versions
  alter column publisher_extraction_id set not null;
create or replace function validate_brief_document_version_extraction()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1
    from brief_document_extractions extractions
    join brief_documents documents on documents.id = extractions.brief_document_id
    where extractions.id = new.publisher_extraction_id
      and extractions.brief_document_id = new.brief_document_id
      and extractions.input_sha256_hex = documents.sha256_hex
      and new.canonical_text = (
        select string_agg(page->>'text', E'\n\n' order by brief_ai_safe_bigint(page->>'pageNumber'))
        from jsonb_array_elements(extractions.pages) page
      )
      and new.text_char_count = brief_ai_utf16_length(new.canonical_text)
      and new.content_hash = encode(
        digest(convert_to(new.canonical_text, 'UTF8'), 'sha256'),
        'hex'
      )
  ) then
    raise exception 'publisher version extraction binding does not match document and PDF hash';
  end if;
  return new;
end
$$;
drop trigger if exists brief_document_versions_validate_extraction on brief_document_versions;
create trigger brief_document_versions_validate_extraction
before insert or update of brief_document_id, content_hash, publisher_extraction_id
on brief_document_versions for each row execute function validate_brief_document_version_extraction();
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'assistant_message_sources' and column_name = 'document_version_id') then
    execute 'update assistant_message_sources set version_id = document_version_id where version_id is null';
  end if;
  if exists (select 1 from information_schema.columns where table_name = 'assistant_message_sources' and column_name = 'publisher_document_version_id') then
    execute $sql$
      update assistant_message_sources sources
      set publisher_extraction_id = versions.publisher_extraction_id
      from brief_document_versions versions
      where sources.publisher_document_version_id = versions.id
        and sources.publisher_extraction_id is null
    $sql$;
    execute $sql$
      update assistant_message_sources sources
      set version_id = versions.id::text
      from brief_document_versions versions
      where sources.publisher_document_version_id = versions.id
        and sources.version_id is null
    $sql$;
  end if;
end
$$;
update assistant_message_sources sources
set publisher_extraction_id = versions.publisher_extraction_id
from brief_document_versions versions
where sources.kind = 'document'
  and sources.locator->>'sourceId' like 'publisher:%'
  and sources.version_id = versions.id::text
  and sources.publisher_extraction_id is null;
update assistant_message_sources
set locator = jsonb_set(locator, '{publisherExtractionId}', to_jsonb(publisher_extraction_id::text), true)
where kind = 'document'
  and publisher_extraction_id is not null;

do $$
begin
  if exists (
    select 1 from assistant_message_sources
    where kind = 'document'
      and publisher_extraction_id is not null
      and (
        coalesce(btrim(locator->>'publisherIssueId'), '') = ''
        or coalesce(btrim(locator->>'publisherDocumentId'), '') = ''
        or coalesce(btrim(locator->>'publisherExtractionId'), '') = ''
        or locator->>'publisherDocumentId' is distinct from locator->>'documentId'
        or locator->>'publisherExtractionId' is distinct from publisher_extraction_id::text
      )
  ) then
    raise exception 'AI chat schema cutover found an incomplete retained publisher locator';
  end if;
end
$$;

do $$
declare
  retained_count bigint;
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'assistant_message_sources'
      and column_name = 'publisher_document_version_id'
  ) then
    execute $sql$
      select count(*)
      from assistant_message_sources
      where publisher_document_version_id is not null
        and publisher_extraction_id is null
    $sql$ into retained_count;
    if retained_count <> 0 then
      raise exception 'AI chat schema cutover could not bind a retained publisher extraction';
    end if;
  end if;
end
$$;
update assistant_message_sources
set locator = jsonb_set(
    locator - 'versionId' - 'publisherDocumentVersionId',
    '{versionId}',
    coalesce(locator->'versionId', locator->'versionId'),
    true)
where kind = 'document' and jsonb_exists(locator, 'versionId');
update assistant_message_sources
set document_source_id = locator->>'sourceId',
    document_id = locator->>'documentId',
    content_hash = locator->>'contentHash'
where kind = 'document'
  and (document_source_id is null or document_id is null or content_hash is null);
alter table assistant_message_sources
  drop column if exists document_version_id,
  drop column if exists publisher_document_version_id;

-- This stable export helper previously joined the removed publisher-version
-- column. Bind hold scope discovery to the final version/extraction pair.
create or replace function brief_export_hold_identity_snapshot(
  authorization_snapshot jsonb
)
returns jsonb
language sql
stable
as $$
  with snapshot_chat_ids(id) as (
    select value
    from jsonb_array_elements_text(
      coalesce(authorization_snapshot->'chatIds', '[]'::jsonb)
    ) as snapshot_chats(value)
  ),
  exact_chat_message_ids(id) as (
    select value
    from jsonb_array_elements_text(
      coalesce(authorization_snapshot->'chatMessageIds', '[]'::jsonb)
    ) as snapshot_messages(value)
  ),
  snapshot_issue_ids(id) as (
    select value
    from jsonb_array_elements_text(
      coalesce(authorization_snapshot->'issueIds', '[]'::jsonb)
    ) as snapshot_issues(value)
  ),
  chat_issue_ids(id) as (
    select documents.issue_id::text
    from chat_messages messages
    join assistant_message_sources sources
      on sources.assistant_message_id = messages.id
    join brief_document_versions versions
      on versions.id::text = sources.version_id
     and versions.publisher_extraction_id = sources.publisher_extraction_id
    join brief_documents documents on documents.id = versions.brief_document_id
    where messages.id::text in (select id from exact_chat_message_ids)
      and messages.chat_id::text in (select id from snapshot_chat_ids)
      and sources.publisher_extraction_id is not null
  ),
  hold_issue_ids(id) as (
    select id from snapshot_issue_ids
    union
    select id from chat_issue_ids
  ),
  hold_publisher_company_ids(id) as (
    select subscriptions.publisher_company_id::text
    from publisher_issues issues
    join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
    where issues.id::text in (select id from hold_issue_ids)
    union
    select authorization_snapshot->>'scopeId'
    where authorization_snapshot->>'scopeKind' = 'publisher_company'
      and nullif(authorization_snapshot->>'scopeId', '') is not null
  )
  select jsonb_build_object(
    'chatMessageIds',
    coalesce(
      (select jsonb_agg(id order by id) from exact_chat_message_ids),
      '[]'::jsonb
    ),
    'holdIssueIds',
    coalesce(
      (select jsonb_agg(id order by id) from hold_issue_ids),
      '[]'::jsonb
    ),
    'holdPublisherCompanyIds',
    coalesce(
      (select jsonb_agg(id order by id) from hold_publisher_company_ids),
      '[]'::jsonb
    )
  )
$$;

create or replace function protect_referenced_public_source_document()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from assistant_message_sources sources
    where sources.kind = 'document'
      and sources.publisher_extraction_id is null
      and sources.version_id = old.document_id
  ) then
    raise exception 'answer-referenced public document versions cannot be deleted';
  end if;
  return old;
end;
$$;

create or replace function validate_assistant_document_source_identity()
returns trigger
language plpgsql
as $$
begin
  if new.kind = 'document' and new.publisher_extraction_id is null then
    if not exists (
      select 1 from public_source_documents documents
      where documents.document_id = new.version_id
        and new.locator->>'sourceId' = 'public:' || documents.source_id
        and new.locator->>'documentId' = documents.document_id
        and new.locator->>'contentHash' = documents.content_hash
        and brief_valid_document_exposure_ranges(new.locator->'ranges')
        and not exists (
          select 1
          from jsonb_array_elements(new.locator->'ranges') range_row
          where brief_ai_safe_bigint(range_row->>'charEnd') > brief_ai_utf16_length(documents.text)
        )
    ) then
      raise exception 'document source must reference an existing immutable document version';
    end if;
  elsif new.kind = 'document' and new.publisher_extraction_id is not null then
    if not exists (
      select 1
      from brief_document_extractions extractions
      join brief_document_versions versions
        on versions.brief_document_id = extractions.brief_document_id
       and versions.id::text = new.version_id
       and versions.publisher_extraction_id = extractions.id
      join brief_documents documents on documents.id = versions.brief_document_id
      join publisher_issues issues on issues.id = documents.issue_id
      join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
      where extractions.id = new.publisher_extraction_id
        and extractions.input_sha256_hex = documents.sha256_hex
        and versions.canonical_text = (
          select string_agg(page->>'text', E'\n\n' order by brief_ai_safe_bigint(page->>'pageNumber'))
          from jsonb_array_elements(extractions.pages) page
        )
        and versions.text_char_count = brief_ai_utf16_length(versions.canonical_text)
        and versions.content_hash = encode(digest(convert_to(versions.canonical_text, 'UTF8'), 'sha256'), 'hex')
        and new.locator->>'documentId' = extractions.brief_document_id::text
        and new.locator->>'publisherDocumentId' = documents.id::text
        and new.locator->>'publisherIssueId' = issues.id::text
        and new.locator->>'sourceId' = 'publisher:' || subscriptions.id::text
        and new.locator->>'publisherExtractionId' = extractions.id::text
        and new.locator->>'contentHash' = versions.content_hash
        and brief_valid_document_exposure_ranges(new.locator->'ranges')
        and not exists (
          select 1
          from jsonb_array_elements(new.locator->'ranges') range_row
          where brief_ai_safe_bigint(range_row->>'charEnd') > brief_ai_utf16_length(versions.canonical_text)
        )
    ) then
      raise exception 'publisher document source must reference its exact immutable extraction and version';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists assistant_message_sources_validate_document on assistant_message_sources;
create trigger assistant_message_sources_validate_document
before insert or update on assistant_message_sources
for each row execute function validate_assistant_document_source_identity();
alter table assistant_message_sources
  drop constraint if exists assistant_message_sources_document_index_identity,
  drop constraint if exists assistant_message_sources_final_kind_identity;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'assistant_message_sources_document_index_identity') then
    alter table assistant_message_sources add constraint assistant_message_sources_document_index_identity
      check (
        (
          kind = 'document'
          and document_source_id is not null
          and brief_ai_valid_document_source_id(document_source_id)
          and document_id is not null
          and content_hash is not null
          and version_id is not null
          and message_id is null
          and memory_revision_id is null
          and document_source_id = locator->>'sourceId'
          and document_id = locator->>'documentId'
          and content_hash = locator->>'contentHash'
          and version_id = locator->>'versionId'
        )
        or (
          kind <> 'document'
          and document_source_id is null
          and document_id is null
          and content_hash is null
          and version_id is null
        )
      );
  end if;
end
$$;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'assistant_message_sources_final_kind_identity') then
    alter table assistant_message_sources add constraint assistant_message_sources_final_kind_identity
      check (
        (
            kind = 'document'
            and document_source_id is not null
            and brief_ai_valid_document_source_id(document_source_id)
            and document_id is not null
            and content_hash is not null
            and version_id is not null
            and message_id is null
            and memory_revision_id is null
          and (
            (publisher_extraction_id is null
              and document_source_id like 'public:%'
              and not jsonb_exists(locator, 'publisherIssueId')
              and not jsonb_exists(locator, 'publisherDocumentId')
              and not jsonb_exists(locator, 'publisherExtractionId'))
            or (
              publisher_extraction_id is not null
              and document_source_id like 'publisher:%'
              and coalesce(btrim(locator->>'publisherIssueId'), '') <> ''
              and locator->>'publisherDocumentId' = document_id
              and locator->>'publisherExtractionId' = publisher_extraction_id::text
            )
          )
        )
        or (kind = 'chat_message' and document_source_id is null and document_id is null and content_hash is null and version_id is null and publisher_extraction_id is null and message_id is not null and memory_revision_id is null)
        or (kind = 'memory' and document_source_id is null and document_id is null and content_hash is null and version_id is null and publisher_extraction_id is null and message_id is null and memory_revision_id is not null)
        or (kind = 'web' and document_source_id is null and document_id is null and content_hash is null and version_id is null and publisher_extraction_id is null and message_id is null and memory_revision_id is null)
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'assistant_message_sources_publisher_extraction_fkey') then
    alter table assistant_message_sources add constraint assistant_message_sources_publisher_extraction_fkey
      foreign key (publisher_extraction_id) references brief_document_extractions (id);
  end if;
end
$$;
create index if not exists assistant_message_sources_version_idx
  on assistant_message_sources (version_id) where version_id is not null;
create index if not exists assistant_message_sources_document_identity_idx
  on assistant_message_sources (document_source_id, document_id, content_hash)
  where document_source_id is not null;

create or replace function validate_assistant_message_source_locator()
returns trigger
language plpgsql
as $$
declare
  captured_at timestamptz;
  published_at timestamptz;
begin
  if new.kind = 'chat_message' then
    if jsonb_typeof(new.locator) is distinct from 'object'
      or new.locator->>'kind' is distinct from 'chat_message'
      or jsonb_typeof(new.locator->'messageId') is distinct from 'string'
      or btrim(new.locator->>'messageId') = ''
      or new.message_id is null
      or new.locator->>'messageId' is distinct from new.message_id::text
      or exists (
        select 1 from jsonb_object_keys(new.locator) key
        where key not in ('kind', 'messageId')
      )
      or new.public_provenance is distinct from '{}'::jsonb
      or not exists (
        select 1
        from chat_messages referenced
        join chat_messages assistants on assistants.id = new.assistant_message_id
        where referenced.id = new.message_id
          and referenced.chat_id = assistants.chat_id
      ) then
      raise exception 'chat locator must bind messageId to the retained chat message';
    end if;
  elsif new.kind = 'memory' then
    if jsonb_typeof(new.locator) is distinct from 'object'
      or new.locator->>'kind' is distinct from 'memory'
      or jsonb_typeof(new.locator->'memoryId') is distinct from 'string'
      or jsonb_typeof(new.locator->'memoryRevisionId') is distinct from 'string'
      or new.locator->>'memoryId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or new.locator->>'memoryRevisionId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or new.memory_revision_id is null
      or new.locator->>'memoryRevisionId' is distinct from new.memory_revision_id::text
      or exists (
        select 1 from jsonb_object_keys(new.locator) key
        where key not in ('kind', 'memoryId', 'memoryRevisionId')
      )
      or new.public_provenance is distinct from '{}'::jsonb
      or not exists (
        select 1
        from user_memory_revisions revisions
        where revisions.id = new.memory_revision_id
          and revisions.memory_id::text = new.locator->>'memoryId'
      ) then
      raise exception 'memory locator must bind memoryRevisionId to its memory revision';
    end if;
  elsif new.kind = 'web' then
    if jsonb_typeof(new.locator) is distinct from 'object'
      or new.locator->>'kind' is distinct from 'web'
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
      or btrim(new.locator->>'capturedAt') = ''
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
      or (jsonb_exists(new.locator, 'publishedAt') and (
        btrim(new.locator->>'publishedAt') = ''
        or new.locator->>'publishedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
      ))
      or new.locator->>'quoteHash' !~ '^[A-Za-z0-9_-]{43}$'
      or substring(new.locator->>'url' from '^https://([^/:?#]+)') is distinct from new.locator->>'domain'
      or new.locator->>'quote' is distinct from btrim(normalize(replace(replace(new.locator->>'quote', E'\r\n', E'\n'), E'\r', E'\n'), NFC))
      or new.locator->>'quoteHash' is distinct from translate(
        rtrim(encode(digest(convert_to(new.locator->>'quote', 'UTF8'), 'sha256'), 'base64'), '='),
        '+/', '-_'
      )
      or exists (
        select 1 from jsonb_object_keys(new.locator) key
        where key not in ('kind', 'url', 'title', 'domain', 'quote', 'quoteHash', 'publishedAt', 'capturedAt')
      )
      or jsonb_typeof(new.public_provenance) is distinct from 'object'
      or new.public_provenance <> jsonb_build_object('citationUrl', new.locator->>'url')
      or new.public_provenance->>'citationUrl' is distinct from new.locator->>'url'
      then
      raise exception 'web locator must use the strict URL, quote, and hash form';
    end if;
    begin
      captured_at := (new.locator->>'capturedAt')::timestamptz;
    exception when others then
      raise exception 'web locator must use the strict URL, quote, and hash form';
    end;
    if jsonb_exists(new.locator, 'publishedAt') then
      begin
        published_at := (new.locator->>'publishedAt')::timestamptz;
      exception when others then
        raise exception 'web locator must use the strict URL, quote, and hash form';
      end;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists assistant_message_sources_validate_locator on assistant_message_sources;
create trigger assistant_message_sources_validate_locator
before insert or update on assistant_message_sources
for each row execute function validate_assistant_message_source_locator();

create or replace function validate_assistant_message_source_key()
returns trigger
language plpgsql
as $$
declare
  expected_namespace text;
  ordinal bigint;
begin
  if new.source_key !~ '^k_cn_[A-Za-z0-9_-]{22}_[1-9][0-9]*$' then
    raise exception 'assistant message source key is not canonical';
  end if;
  ordinal := brief_ai_safe_bigint(substring(new.source_key from '_([1-9][0-9]*)$'));
  if ordinal is null or ordinal > 2147483647 then
    raise exception 'assistant message source ordinal exceeds the final integer bound';
  end if;
  select runs.citation_namespace
    into expected_namespace
  from chat_messages messages
  join ai_runs runs
    on runs.id = messages.assistant_ai_run_id
   and runs.assistant_message_id = messages.id
  where messages.id = new.assistant_message_id;
  if expected_namespace is null
    or substring(new.source_key from '^k_(cn_[A-Za-z0-9_-]{22})_[1-9][0-9]*$') is distinct from expected_namespace then
    raise exception 'assistant message source key namespace does not match its owning run';
  end if;
  if exists (
    select 1
    from assistant_message_sources existing
    join chat_messages existing_messages on existing_messages.id = existing.assistant_message_id
    join ai_runs existing_runs
      on existing_runs.id = existing_messages.assistant_ai_run_id
     and existing_runs.assistant_message_id = existing_messages.id
    where existing_runs.id = (
      select runs.id
      from chat_messages messages
      join ai_runs runs
        on runs.id = messages.assistant_ai_run_id
       and runs.assistant_message_id = messages.id
      where messages.id = new.assistant_message_id
    )
      and existing.source_key <> new.source_key
      and brief_ai_safe_bigint(substring(existing.source_key from '_([1-9][0-9]*)$')) = ordinal
  ) then
    raise exception 'assistant message source ordinal is duplicated within its owning run';
  end if;
  return new;
end
$$;

drop trigger if exists assistant_message_sources_validate_key on assistant_message_sources;
create trigger assistant_message_sources_validate_key
before insert or update of assistant_message_id, source_key
on assistant_message_sources
for each row execute function validate_assistant_message_source_key();

-- Rebuild the immutable identity trigger against the final columns. The
-- previous trigger named the removed typed columns and must not remain live.
drop function if exists assistant_message_source_identity_digest(
  uuid, text, text, jsonb, text, uuid, uuid, uuid, text, jsonb
);
create function assistant_message_source_identity_digest(
  p_assistant_message_id uuid,
  p_source_key text,
  p_kind text,
  p_locator jsonb,
  p_version_id text,
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
    'versionId', p_version_id,
    'publisherExtractionId', p_publisher_extraction_id,
    'messageId', p_message_id,
    'memoryRevisionId', p_memory_revision_id,
    'displayLabel', p_display_label,
    'publicProvenance', p_public_provenance
  )::text, 'UTF8'), 'sha256'), 'hex')
$$;

update assistant_message_sources
set source_identity_digest = assistant_message_source_identity_digest(
  assistant_message_id, source_key, kind, locator, version_id,
  publisher_extraction_id, message_id, memory_revision_id, display_label, public_provenance
);
update assistant_message_source_uses
set source_use_identity_digest = assistant_message_source_use_identity_digest(
  assistant_message_id, source_key, consumer_task_id, topic_id,
  rendered_token_count, context_order, ranges
);

create or replace function enforce_assistant_message_source_identity_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'assistant message source identity is immutable'
      using errcode = '23514', constraint = 'assistant_message_sources_identity_immutable';
  end if;
  if tg_op = 'DELETE' and exists (
    select 1 from chat_messages where id = old.assistant_message_id
  ) then
    raise exception 'assistant message sources cannot be deleted independently'
      using errcode = '23514', constraint = 'assistant_message_sources_delete_immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  new.source_identity_digest := assistant_message_source_identity_digest(
    new.assistant_message_id, new.source_key, new.kind, new.locator,
    new.version_id, new.publisher_extraction_id, new.message_id, new.memory_revision_id, new.display_label,
    new.public_provenance
  );
  return new;
end;
$$;

drop trigger if exists assistant_message_sources_identity_immutable on assistant_message_sources;
create trigger assistant_message_sources_identity_immutable
before insert or update or delete on assistant_message_sources
for each row execute function enforce_assistant_message_source_identity_immutable();

drop trigger if exists assistant_message_source_uses_identity_immutable on assistant_message_source_uses;
create trigger assistant_message_source_uses_identity_immutable
before insert or update or delete on assistant_message_source_uses
for each row execute function enforce_assistant_message_source_use_identity_immutable();

create or replace function validate_assistant_message_source_use_ranges()
returns trigger
language plpgsql
as $$
declare
  source_row record;
  text_length integer;
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
    raise exception 'assistant message source-use ranges overlap or are not normalized';
  end if;
  select sources.kind, sources.locator
    into source_row
  from assistant_message_sources sources
  where sources.assistant_message_id = new.assistant_message_id
    and sources.source_key = new.source_key;
  if not found then
    raise exception 'assistant message source-use has no owning source';
  end if;
  if source_row.kind <> 'document' then
    if jsonb_array_length(new.ranges) <> 0 then
      raise exception 'non-document source-use ranges must be empty';
    end if;
    return new;
  end if;
  if source_row.locator->>'sourceId' like 'public:%' then
    select brief_ai_utf16_length(documents.text)
      into text_length
    from public_source_documents documents
    where documents.source_id::text = substring(source_row.locator->>'sourceId' from 8)
      and documents.document_id = source_row.locator->>'documentId'
      and documents.document_id = source_row.locator->>'versionId';
  else
    select brief_ai_utf16_length(versions.canonical_text)
      into text_length
    from brief_document_versions versions
    where versions.id::text = source_row.locator->>'versionId'
      and versions.brief_document_id::text = source_row.locator->>'documentId'
      and versions.publisher_extraction_id::text = source_row.locator->>'publisherExtractionId';
  end if;
  if text_length is null
    or exists (
      select 1
      from jsonb_array_elements(new.ranges) range_row
      where brief_ai_safe_bigint(range_row->>'charEnd') > text_length
        or not exists (
          select 1
          from jsonb_array_elements(source_row.locator->'ranges') locator_range
          where brief_ai_safe_bigint(range_row->>'charStart') >= brief_ai_safe_bigint(locator_range->>'charStart')
            and brief_ai_safe_bigint(range_row->>'charEnd') <= brief_ai_safe_bigint(locator_range->>'charEnd')
        )
    ) then
    raise exception 'assistant message source-use range is outside immutable source text';
  end if;
  return new;
end
$$;

drop trigger if exists assistant_message_source_uses_validate_ranges on assistant_message_source_uses;
create trigger assistant_message_source_uses_validate_ranges
before insert or update of ranges on assistant_message_source_uses
for each row execute function validate_assistant_message_source_use_ranges();

alter table ai_source_exposures
  drop constraint if exists ai_source_exposures_document_reconstruction_consistent,
  drop constraint if exists ai_source_exposures_document_reconstruction_required,
  add column if not exists version_id text,
  add column if not exists content_hash text,
  add column if not exists publisher_extraction_id uuid,
  add column if not exists publisher_issue_id uuid,
  add column if not exists publisher_document_id uuid;
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'ai_source_exposures' and column_name = 'document_version_id') then
    execute 'update ai_source_exposures set version_id = document_version_id, content_hash = document_content_hash where version_id is null';
  end if;
end
$$;
update ai_source_exposures exposures
set publisher_extraction_id = versions.publisher_extraction_id
from brief_document_versions versions
where exposures.source_kind = 'document'
  and exposures.version_id = versions.id::text
  and exposures.publisher_extraction_id is null;
update ai_source_exposures exposures
set publisher_document_id = documents.id,
    publisher_issue_id = documents.issue_id
from brief_document_versions versions
join brief_documents documents on documents.id = versions.brief_document_id
where exposures.source_kind = 'document'
  and exposures.document_source_id like 'publisher:%'
  and exposures.version_id = versions.id::text
  and exposures.publisher_document_id is null
  and exposures.publisher_issue_id is null;
alter table ai_source_exposures
  drop column if exists document_version_id,
  drop column if exists document_content_hash;

drop table if exists ai_chat_memories;
drop table if exists ai_chat_web;

-- New rows must carry the final namespace and strict document evidence tuple.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_source_exposures_final_document_identity') then
    alter table ai_source_exposures add constraint ai_source_exposures_final_document_identity
      check (
        (
          source_kind <> 'document'
          and exposure_stage <> 'internal_search_preview'
          and version_id is null
          and content_hash is null
          and publisher_extraction_id is null
          and document_source_id is null
          and document_id is null
          and document_ranges is null
          and publisher_issue_id is null
          and publisher_document_id is null
        )
        or (
          source_kind = 'document'
          and version_id is not null
          and content_hash is not null
          and content_hash ~ '^[0-9a-f]{64}$'
          and document_source_id is not null
          and brief_ai_valid_document_source_id(document_source_id)
          and document_id is not null
          and document_ranges is not null
          and brief_valid_document_exposure_ranges(document_ranges)
          and ((publisher_extraction_id is not null) = (document_source_id like 'publisher:%'))
          and (
            (document_source_id like 'publisher:%'
              and publisher_issue_id is not null
              and publisher_document_id = document_id)
            or (document_source_id like 'public:%'
              and publisher_issue_id is null
              and publisher_document_id is null
              and publisher_extraction_id is null)
          )
        )
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_source_exposures_publisher_extraction_fkey') then
    alter table ai_source_exposures add constraint ai_source_exposures_publisher_extraction_fkey
      foreign key (publisher_extraction_id) references brief_document_extractions (id) on delete restrict;
  end if;
end
$$;
create or replace function validate_ai_source_exposure_document_identity()
returns trigger language plpgsql as $$
begin
  if new.source_kind = 'document'
    and (new.document_source_id is null
      or not brief_ai_valid_document_source_id(new.document_source_id)) then
    raise exception 'document exposure source identity is not canonical';
  end if;
  if new.source_kind <> 'document'
    and (new.publisher_issue_id is not null or new.publisher_document_id is not null) then
    raise exception 'non-document exposure carries publisher identity';
  end if;
  if new.source_kind = 'document' and new.document_source_id like 'publisher:%' then
    if not exists (
      select 1
      from brief_document_versions versions
      join brief_documents documents on documents.id = versions.brief_document_id
      join publisher_issues issues on issues.id = documents.issue_id
      join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
      join brief_document_extractions extractions on extractions.id = new.publisher_extraction_id
      where versions.id::text = new.version_id
        and versions.publisher_extraction_id = new.publisher_extraction_id
        and extractions.brief_document_id = documents.id
        and extractions.input_sha256_hex = documents.sha256_hex
        and new.document_source_id = 'publisher:' || subscriptions.id::text
        and new.document_id = documents.id::text
        and new.publisher_issue_id::text = issues.id::text
        and new.publisher_document_id::text = documents.id::text
        and new.publisher_extraction_id::text = extractions.id::text
        and versions.content_hash = new.content_hash
        and versions.content_hash = encode(digest(convert_to(versions.canonical_text, 'UTF8'), 'sha256'), 'hex')
    ) then
      raise exception 'publisher exposure is not bound to the exact version extraction relation';
    end if;
  elsif new.source_kind = 'document' and new.document_source_id like 'public:%' then
    if not exists (
      select 1 from public_source_documents documents
        where documents.document_id = new.document_id
          and documents.document_id = new.version_id
          and documents.content_hash = new.content_hash
          and ('public:' || documents.source_id) = new.document_source_id
          and new.publisher_issue_id is null
          and new.publisher_document_id is null
    ) then
      raise exception 'public exposure is not bound to the exact immutable document';
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists ai_source_exposures_validate_document_identity on ai_source_exposures;
create trigger ai_source_exposures_validate_document_identity
before insert or update on ai_source_exposures
for each row execute function validate_ai_source_exposure_document_identity();

create or replace function validate_ai_source_exposure_ranges()
returns trigger language plpgsql as $$
declare
  text_length integer;
begin
  if new.source_kind <> 'document' then return new; end if;
  if not brief_valid_document_exposure_ranges(new.document_ranges) then
    raise exception 'document exposure ranges must be normalized and non-empty';
  end if;
  if new.document_source_id like 'public:%' then
    select brief_ai_utf16_length(text) into text_length
    from public_source_documents
    where document_id = new.version_id
      and document_id = new.document_id
      and ('public:' || source_id) = new.document_source_id;
  else
    select brief_ai_utf16_length(canonical_text) into text_length
    from brief_document_versions versions
    where versions.id::text = new.version_id
      and versions.brief_document_id::text = new.document_id
      and versions.publisher_extraction_id = new.publisher_extraction_id;
  end if;
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
drop trigger if exists ai_source_exposures_validate_ranges on ai_source_exposures;
create trigger ai_source_exposures_validate_ranges
before insert or update on ai_source_exposures
for each row execute function validate_ai_source_exposure_ranges();

-- Ready publisher rows are immutable. Account deletion and legal retention use
-- the explicit fenced purge path; ordinary jobs cannot replace or delete a
-- ready document, extraction, or binding.
create or replace function protect_ready_publisher_content()
returns trigger
language plpgsql
as $$
begin
  if current_setting('brief.allow_file_purge', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if current_setting('brief.allow_file_purge', true) = 'on' then return old; end if;
    if exists (
      select 1 from publisher_issues i
      join brief_documents d on d.issue_id = i.id
      where d.id = old.id and (i.status = 'published' or i.indexing_status = 'ready')
    ) then
      raise exception 'ready publisher content requires the fenced purge path'
        using errcode = '23514', constraint = 'ready_publisher_content_immutable';
    end if;
    return old;
  end if;
  if (
    exists (
      select 1 from publisher_issues i
      where i.id = old.issue_id and (i.status = 'published' or i.indexing_status = 'ready')
    )
    or exists (
      select 1 from publisher_issues i
      where i.id = new.issue_id and (i.status = 'published' or i.indexing_status = 'ready')
    )
  ) and (
    new.issue_id is distinct from old.issue_id
    or new.title is distinct from old.title
    or new.object_key is distinct from old.object_key
    or new.media_type is distinct from old.media_type
    or new.sha256_hex is distinct from old.sha256_hex
    or new.original_file_name is distinct from old.original_file_name
    or new.byte_size is distinct from old.byte_size
    or new.current_version_id is distinct from old.current_version_id
    or new.upload_completed_at is distinct from old.upload_completed_at
    or new.deleted_at is distinct from old.deleted_at
  ) then
    raise exception 'ready publisher content is immutable'
      using errcode = '23514', constraint = 'ready_publisher_content_immutable';
  end if;
  return new;
end;
$$;

-- Older publication triggers remain installed by the immutable publisher
-- migrations. Make the documented fenced purge path pass through those
-- guards before the final ready-only triggers run.
create or replace function protect_published_brief_document()
returns trigger
language plpgsql
as $$
declare
  issue_status text;
begin
  if current_setting('brief.allow_file_purge', true) = 'on' then
    return new;
  end if;
  select status into issue_status from publisher_issues where id = old.issue_id;
  if issue_status = 'published' and (
    new.issue_id is distinct from old.issue_id
    or new.title is distinct from old.title
    or new.original_file_name is distinct from old.original_file_name
    or new.object_key is distinct from old.object_key
    or new.media_type is distinct from old.media_type
    or new.byte_size is distinct from old.byte_size
    or new.sha256_hex is distinct from old.sha256_hex
    or new.upload_completed_at is distinct from old.upload_completed_at
    or new.language is distinct from old.language
    or new.deleted_at is distinct from old.deleted_at
    or new.deleted_by_user_id is distinct from old.deleted_by_user_id
    or new.purge_after is distinct from old.purge_after
    or new.created_by_user_id is distinct from old.created_by_user_id
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'published brief documents are immutable';
  end if;
  return new;
end;
$$;

create or replace function protect_published_brief_document_delete()
returns trigger
language plpgsql
as $$
begin
  if current_setting('brief.allow_file_purge', true) = 'on' then
    return old;
  end if;
  if exists (
    select 1 from publisher_issues issues
    where issues.id = old.issue_id and issues.status = 'published'
  ) then
    raise exception 'published brief documents are immutable';
  end if;
  return old;
end;
$$;

create or replace function reject_brief_document_version_mutation()
returns trigger
language plpgsql
as $$
declare
  issue_status text;
begin
  if current_setting('brief.allow_file_purge', true) = 'on' and tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'brief document versions are immutable';
  end if;
  select issues.status into issue_status
  from brief_documents documents
  join publisher_issues issues on issues.id = documents.issue_id
  where documents.id = old.brief_document_id;
  if issue_status is not null then
    raise exception 'brief document versions are immutable';
  end if;
  return old;
end;
$$;

drop trigger if exists brief_document_versions_no_update on brief_document_versions;
create trigger brief_document_versions_no_update
before update or delete on brief_document_versions
for each row execute function reject_brief_document_version_mutation();
drop trigger if exists brief_document_versions_protect_text_hash on brief_document_versions;
create trigger brief_document_versions_protect_text_hash
before insert or update of canonical_text, text_char_count, content_hash
on brief_document_versions for each row execute function protect_brief_document_version_text_hash();

alter table brief_document_versions
  drop constraint if exists brief_document_versions_char_count,
  drop constraint if exists brief_document_versions_js_char_count,
  add constraint brief_document_versions_js_char_count
    check (text_char_count = brief_ai_utf16_length(canonical_text));
alter table public_source_documents
  drop constraint if exists public_source_documents_js_char_count,
  add constraint public_source_documents_js_char_count
    check (text_char_count = brief_ai_utf16_length(text));

create or replace function validate_brief_document_extraction_pages()
returns trigger
language plpgsql
as $$
declare
  page_count bigint;
  distinct_page_count bigint;
  canonical_char_count bigint;
begin
  if not exists (
    select 1 from brief_documents documents
    where documents.id = new.brief_document_id
      and documents.sha256_hex = new.input_sha256_hex
  ) then
    raise exception 'PDF extraction hash must match the stored publisher file';
  end if;
  if exists (
    select 1 from jsonb_array_elements(new.pages) page
    where jsonb_typeof(page) <> 'object'
      or jsonb_typeof(page->'pageNumber') <> 'number'
      or (page->>'pageNumber')::numeric <= 0
      or mod((page->>'pageNumber')::numeric, 1) <> 0
      or jsonb_typeof(page->'text') <> 'string'
      or btrim(page->>'text') = ''
  ) then
    raise exception 'PDF extraction pages must contain positive integer page numbers and non-empty text';
  end if;
  select count(*), count(distinct page->>'pageNumber'),
         coalesce(sum(brief_ai_utf16_length(page->>'text')), 0)
           + 2 * greatest(count(*) - 1, 0)
    into page_count, distinct_page_count, canonical_char_count
  from jsonb_array_elements(new.pages) page;
  if page_count <> distinct_page_count then
    raise exception 'PDF extraction page numbers must be unique';
  end if;
  if canonical_char_count <> new.extracted_char_count then
    raise exception 'PDF extraction character count must match canonical page text';
  end if;
  return new;
end
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
    select 1 from jsonb_array_elements(new.page_ranges) range_row
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
      or (range_row->>'charEnd')::numeric > brief_ai_utf16_length(new.canonical_text)
  ) then
    raise exception 'document version page ranges have invalid page or character coordinates';
  end if;
  if exists (
    with ranges as (
      select ordinality,
             (range_row->>'pageNumber')::integer as page_number,
             (range_row->>'charStart')::integer as char_start,
             (range_row->>'charEnd')::integer as char_end
      from jsonb_array_elements(new.page_ranges) with ordinality as rows(range_row, ordinality)
    ), compared as (
      select *, lag(page_number) over (order by ordinality) as previous_page_number,
             lag(char_end) over (order by ordinality) as previous_char_end
      from ranges
    )
    select 1 from compared
    where (ordinality = 1 and char_start <> 0)
      or (previous_page_number is not null and page_number <= previous_page_number)
      or (previous_char_end is not null and char_start <> previous_char_end + 2)
  ) then
    raise exception 'document version page ranges must be ordered and match canonical separators';
  end if;
  return new;
end
$$;
drop trigger if exists brief_document_versions_validate_ranges on brief_document_versions;
create trigger brief_document_versions_validate_ranges
before insert on brief_document_versions
for each row execute function validate_brief_document_version_ranges();

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'brief_document_versions_content_hash_sha256' and not convalidated) then
    alter table brief_document_versions validate constraint brief_document_versions_content_hash_sha256;
  end if;
  if exists (select 1 from pg_constraint where conname = 'public_source_documents_content_hash_sha256' and not convalidated) then
    alter table public_source_documents validate constraint public_source_documents_content_hash_sha256;
  end if;
  if exists (select 1 from pg_constraint where conname = 'ai_source_exposures_document_reconstruction_consistent' and not convalidated) then
    raise exception 'AI chat schema cutover left a legacy NOT VALID exposure constraint';
  end if;
  if exists (
    select 1
    from pg_constraint constraints
    join pg_class relations on relations.oid = constraints.conrelid
    where constraints.connamespace = 'public'::regnamespace
      and not constraints.convalidated
      and relations.relname in (
        'ai_runs',
        'ai_observations',
        'ai_run_usage',
        'ai_source_exposures',
        'assistant_message_sources',
        'assistant_message_source_uses',
        'brief_document_versions',
        'public_source_documents'
      )
  ) then
    raise exception 'AI chat schema cutover left a NOT VALID product constraint';
  end if;
end
$$;

drop trigger if exists brief_documents_ready_immutable on brief_documents;
create trigger brief_documents_ready_immutable
before update or delete on brief_documents
for each row execute function protect_ready_publisher_content();

create or replace function protect_ready_publisher_version()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from brief_documents d
    join publisher_issues i on i.id = d.issue_id
    where d.id = old.brief_document_id
      and (i.status = 'published' or i.indexing_status = 'ready')
  ) and (
    new.brief_document_id is distinct from old.brief_document_id
    or new.content_hash is distinct from old.content_hash
    or new.language is distinct from old.language
    or new.canonical_text is distinct from old.canonical_text
    or new.text_char_count is distinct from old.text_char_count
    or new.page_ranges is distinct from old.page_ranges
    or new.created_by_job_id is distinct from old.created_by_job_id
  ) then
    raise exception 'ready publisher extraction text is immutable'
      using errcode = '23514', constraint = 'ready_publisher_content_immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists brief_document_versions_ready_immutable on brief_document_versions;
create trigger brief_document_versions_ready_immutable
before update on brief_document_versions
for each row execute function protect_ready_publisher_version();

create or replace function reject_ready_publisher_version_insert()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from brief_documents documents
    join publisher_issues issues on issues.id = documents.issue_id
    where documents.id = new.brief_document_id
      and (issues.status = 'published' or issues.indexing_status = 'ready')
  ) then
    raise exception 'ready publisher document versions are immutable'
      using errcode = '23514', constraint = 'ready_publisher_content_immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists brief_document_versions_ready_immutable_insert on brief_document_versions;
create trigger brief_document_versions_ready_immutable_insert
before insert on brief_document_versions
for each row execute function reject_ready_publisher_version_insert();

create or replace function reject_ready_extraction_insert()
returns trigger
language plpgsql
as $$
begin
  if current_setting('brief.allow_file_purge', true) = 'on' then return new; end if;
  if exists (
    select 1 from brief_documents d
    join publisher_issues i on i.id = d.issue_id
    where d.id = new.brief_document_id
      and (i.status = 'published' or i.indexing_status = 'ready')
  ) then
    raise exception 'ready publisher extraction binding is immutable'
      using errcode = '23514', constraint = 'ready_publisher_content_immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists brief_document_extractions_ready_immutable on brief_document_extractions;
create trigger brief_document_extractions_ready_immutable
before insert on brief_document_extractions
for each row execute function reject_ready_extraction_insert();

-- One server-derived acceptance scope is the sole authorization input for an
-- accepted AI run. The value is strict, canonical, bound to the run tenant,
-- and immutable after insert.
alter table ai_runs
  add column if not exists acceptance_scope jsonb;

-- Retained 0063 rows have no acceptance snapshot.  Do not reconstruct one
-- from current chat selections, source settings, memory heads, or provider
-- policy: those rows describe present state, not what the run accepted.  A
-- deployment may only replay this migration after a previous cutover attempt
-- has already stored the complete per-run scope.  Every other retained row
-- fails before any catalog write and must be drained or explicitly purged.
do $$
declare
  row_data record;
begin
  for row_data in
      select runs.id::text as row_identity
      from ai_runs runs
      where runs.acceptance_scope is null
      order by runs.id
    loop
      raise exception
        'AI chat scope cutover preflight row ai_runs/%: no durable acceptance-time scope proves every accepted field',
        row_data.row_identity;
    end loop;
end
$$;

do $$
begin
  if exists (select 1 from ai_runs where acceptance_scope is null) then
    raise exception 'AI chat scope cutover requires an acceptance scope for every retained run';
  end if;
end
$$;

alter table ai_runs alter column acceptance_scope set not null;

alter table ai_runs
  drop constraint if exists ai_runs_acceptance_scope_shape,
  add constraint ai_runs_acceptance_scope_shape check (
    jsonb_typeof(acceptance_scope) = 'object'
    and acceptance_scope ?& array[
      'userId', 'chatId', 'companyId', 'subscriptionIds', 'accessIds',
      'publicSourceIds', 'memoryMode', 'memoryRevisionIds', 'webRequested',
      'webEnabled', 'provider', 'fastModelId', 'mainModelId',
      'webTransportProvider', 'allowedDomains'
    ]
    and (acceptance_scope - array[
      'userId', 'chatId', 'companyId', 'subscriptionIds', 'accessIds',
      'publicSourceIds', 'memoryMode', 'memoryRevisionIds', 'webRequested',
      'webEnabled', 'provider', 'fastModelId', 'mainModelId',
      'webTransportProvider', 'allowedDomains'
    ]) = '{}'::jsonb
    and jsonb_typeof(acceptance_scope->'userId') = 'string'
    and btrim(acceptance_scope->>'userId') <> ''
    and jsonb_typeof(acceptance_scope->'chatId') = 'string'
    and jsonb_typeof(acceptance_scope->'companyId') = 'string'
    and jsonb_typeof(acceptance_scope->'subscriptionIds') = 'array'
    and jsonb_typeof(acceptance_scope->'accessIds') = 'array'
    and jsonb_typeof(acceptance_scope->'publicSourceIds') = 'array'
    and jsonb_typeof(acceptance_scope->'memoryMode') = 'string'
    and acceptance_scope->>'memoryMode' in ('private_owner', 'disabled')
    and jsonb_typeof(acceptance_scope->'memoryRevisionIds') = 'array'
    and jsonb_typeof(acceptance_scope->'webRequested') = 'boolean'
    and jsonb_typeof(acceptance_scope->'webEnabled') = 'boolean'
    and acceptance_scope->>'provider' = 'zai_coding_plan_official'
    and acceptance_scope->>'fastModelId' = 'glm-5-turbo'
    and acceptance_scope->>'mainModelId' = 'glm-5-turbo'
    and (
      acceptance_scope->'webTransportProvider' = 'null'::jsonb
      or (
        jsonb_typeof(acceptance_scope->'webTransportProvider') = 'string'
        and acceptance_scope->>'webTransportProvider' = 'tinyfish'
      )
    )
    and (
      acceptance_scope->'allowedDomains' = 'null'::jsonb
      or jsonb_typeof(acceptance_scope->'allowedDomains') = 'array'
    )
    and (
      (acceptance_scope->>'webEnabled')::boolean
      = (acceptance_scope->'webTransportProvider' = '"tinyfish"'::jsonb)
    )
    and (
      (acceptance_scope->>'webEnabled')::boolean
      or acceptance_scope->'allowedDomains' = 'null'::jsonb
    )
    and (
      (acceptance_scope->>'webRequested')::boolean
      or not (acceptance_scope->>'webEnabled')::boolean
    )
  );

create or replace function brief_ai_scope_array_canonical(p_scope jsonb, p_key text)
returns boolean language sql immutable strict as $$
  with array_values as (
    select value #>> '{}' as item, ordinality
    from jsonb_array_elements(case when jsonb_typeof(p_scope->p_key) = 'array' then p_scope->p_key else '[]'::jsonb end) with ordinality
  )
  select case
    when jsonb_typeof(p_scope->p_key) <> 'array' then false
    else coalesce((
      select bool_and(jsonb_typeof(array_items.raw_value) = 'string' and array_values.item <> '')
      from jsonb_array_elements(p_scope->p_key) with ordinality as array_items(raw_value, ordinality)
      join array_values on array_values.ordinality = array_items.ordinality
    ), true)
      and coalesce((select count(*) from array_values) = (select count(distinct item) from array_values), true)
      and coalesce(not exists (
        select 1 from array_values left join array_values previous on previous.ordinality = array_values.ordinality - 1
        where previous.item is not null and previous.item >= array_values.item
      ), true)
  end
$$;

alter table ai_runs
  drop constraint if exists ai_runs_acceptance_scope_arrays,
  add constraint ai_runs_acceptance_scope_arrays check (
    brief_ai_scope_array_canonical(acceptance_scope, 'subscriptionIds')
    and brief_ai_scope_array_canonical(acceptance_scope, 'accessIds')
    and brief_ai_scope_array_canonical(acceptance_scope, 'publicSourceIds')
    and brief_ai_scope_array_canonical(acceptance_scope, 'memoryRevisionIds')
    and (
      acceptance_scope->'allowedDomains' = 'null'::jsonb
      or brief_ai_scope_array_canonical(acceptance_scope, 'allowedDomains')
    )
  );

create or replace function brief_ai_validate_acceptance_scope()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.acceptance_scope is distinct from old.acceptance_scope then
    raise exception 'AI run acceptance scope is immutable'
      using errcode = '23514', constraint = 'ai_runs_acceptance_scope_immutable';
  end if;

  -- Existing runs carry their accepted entitlement in the immutable scope.
  -- Updates may still change lifecycle fields, but they must not consult live
  -- grants, source settings, memory state, provider settings, or web policy.
  if tg_op = 'UPDATE' then
    if (new.acceptance_scope->>'userId') is distinct from new.initiating_user_id::text
       or (new.acceptance_scope->>'chatId') is distinct from new.chat_id::text
       or not exists (
         select 1 from chats chat
         where chat.id = new.chat_id
           and (new.acceptance_scope->>'companyId') = chat.company_id::text
           and chat.user_id = new.initiating_user_id
       ) then
      raise exception 'AI run acceptance scope tenant binding is invalid'
        using errcode = '23514', constraint = 'ai_runs_acceptance_scope_binding';
    end if;
    return new;
  end if;

  if (new.acceptance_scope->>'userId') is distinct from new.initiating_user_id::text
     or (new.acceptance_scope->>'chatId') is distinct from new.chat_id::text
     or not exists (
       select 1 from chats chat
         where chat.id = new.chat_id
           and (new.acceptance_scope->>'companyId') = chat.company_id::text
           and chat.user_id = new.initiating_user_id
           and exists (
             select 1
             from client_company_memberships membership
             join platform_users users on users.id = membership.user_id
             where membership.company_id = chat.company_id
               and membership.user_id = new.initiating_user_id
               and membership.revoked_at is null
               and users.recovery_deleted_at is null
               and users.purged_at is null
           )
           and new.acceptance_scope->>'memoryMode' = chat.memory_mode::text
       ) then
    raise exception 'AI run acceptance scope tenant binding is invalid'
      using errcode = '23514', constraint = 'ai_runs_acceptance_scope_binding';
  end if;
  if exists (
    select 1
    from jsonb_array_elements_text(new.acceptance_scope->'accessIds') selected(value)
    where not exists (
      select 1
      from chat_subscription_sources chat_sources
      join client_employee_subscription_grants grants
        on grants.access_id = chat_sources.access_id
       and grants.client_company_id = chat_sources.client_company_id
       and grants.user_id = new.initiating_user_id
       and grants.granted_at <= now()
       and (grants.revoked_at is null or grants.revoked_at > now())
      join client_company_memberships membership
        on membership.company_id = grants.client_company_id
       and membership.user_id = grants.user_id
       and membership.revoked_at is null
      join client_subscription_accesses accesses
        on accesses.id = chat_sources.access_id
       and accesses.client_company_id = chat_sources.client_company_id
       and accesses.state in ('active', 'ending', 'paused')
      where chat_sources.chat_id = new.chat_id
        and chat_sources.client_company_id = (new.acceptance_scope->>'companyId')::uuid
        and chat_sources.access_id::text = selected.value
    )
  ) then
    raise exception 'AI run acceptance scope contains an unselected publisher access'
      using errcode = '23514', constraint = 'ai_runs_acceptance_scope_access';
  end if;
  if exists (
    select 1
    from jsonb_array_elements_text(new.acceptance_scope->'subscriptionIds') selected(value)
    where not exists (
      select 1
      from chat_subscription_sources chat_sources
      join client_employee_subscription_grants grants
        on grants.access_id = chat_sources.access_id
       and grants.client_company_id = chat_sources.client_company_id
       and grants.user_id = new.initiating_user_id
       and grants.granted_at <= now()
       and (grants.revoked_at is null or grants.revoked_at > now())
      join client_company_memberships membership
        on membership.company_id = grants.client_company_id
       and membership.user_id = grants.user_id
       and membership.revoked_at is null
      join client_subscription_accesses accesses
        on accesses.id = chat_sources.access_id
       and accesses.client_company_id = chat_sources.client_company_id
       and accesses.subscription_id = selected.value::uuid
       and accesses.state in ('active', 'ending', 'paused')
      where chat_sources.chat_id = new.chat_id
        and chat_sources.client_company_id = (new.acceptance_scope->>'companyId')::uuid
        and chat_sources.subscription_id::text = selected.value
    )
  ) then
    raise exception 'AI run acceptance scope contains an unentitled publisher subscription'
      using errcode = '23514', constraint = 'ai_runs_acceptance_scope_subscription';
  end if;
  if (
    select count(*) from jsonb_array_elements_text(new.acceptance_scope->'subscriptionIds')
  ) <> (
    select count(distinct chat_sources.subscription_id::text)
    from chat_subscription_sources chat_sources
    join client_employee_subscription_grants grants
      on grants.access_id = chat_sources.access_id
     and grants.client_company_id = chat_sources.client_company_id
     and grants.user_id = new.initiating_user_id
      and grants.granted_at <= now()
      and (grants.revoked_at is null or grants.revoked_at > now())
    join client_company_memberships membership
      on membership.company_id = grants.client_company_id
     and membership.user_id = grants.user_id
     and membership.revoked_at is null
    join client_subscription_accesses accesses
      on accesses.id = chat_sources.access_id
     and accesses.client_company_id = chat_sources.client_company_id
     and accesses.subscription_id = chat_sources.subscription_id
     and accesses.state in ('active', 'ending', 'paused')
    where chat_sources.chat_id = new.chat_id
      and chat_sources.client_company_id = (new.acceptance_scope->>'companyId')::uuid
  ) then
    raise exception 'AI run acceptance scope publisher subscription set is not the live accepted set'
      using errcode = '23514', constraint = 'ai_runs_acceptance_scope_subscription_set';
  end if;
  if (
    select count(*) from jsonb_array_elements_text(new.acceptance_scope->'accessIds')
  ) <> (
    select count(distinct chat_sources.access_id::text)
    from chat_subscription_sources chat_sources
    join client_employee_subscription_grants grants
      on grants.access_id = chat_sources.access_id
     and grants.client_company_id = chat_sources.client_company_id
     and grants.user_id = new.initiating_user_id
      and grants.granted_at <= now()
      and (grants.revoked_at is null or grants.revoked_at > now())
    join client_company_memberships membership
      on membership.company_id = grants.client_company_id
     and membership.user_id = grants.user_id
     and membership.revoked_at is null
    join client_subscription_accesses accesses
      on accesses.id = chat_sources.access_id
     and accesses.client_company_id = chat_sources.client_company_id
     and accesses.state in ('active', 'ending', 'paused')
    where chat_sources.chat_id = new.chat_id
      and chat_sources.client_company_id = (new.acceptance_scope->>'companyId')::uuid
  ) then
    raise exception 'AI run acceptance scope publisher access set is not the live accepted set'
      using errcode = '23514', constraint = 'ai_runs_acceptance_scope_access_set';
  end if;
  if exists (
    select 1
    from jsonb_array_elements_text(new.acceptance_scope->'publicSourceIds') selected(value)
    where not exists (
      select 1
      from client_company_public_source_settings settings
      where settings.client_company_id = (new.acceptance_scope->>'companyId')::uuid
        and settings.source_id = selected.value
        and settings.enabled
    )
  ) then
    raise exception 'AI run acceptance scope contains a disabled public source'
      using errcode = '23514', constraint = 'ai_runs_acceptance_scope_public_source';
  end if;
  if (
    select count(*) from jsonb_array_elements_text(new.acceptance_scope->'publicSourceIds')
  ) <> (
    select count(*)
    from client_company_public_source_settings settings
    where settings.client_company_id = (new.acceptance_scope->>'companyId')::uuid
      and settings.enabled
  ) then
    raise exception 'AI run acceptance scope public-source set is not the live accepted set'
      using errcode = '23514', constraint = 'ai_runs_acceptance_scope_public_source_set';
  end if;
  if (new.acceptance_scope->>'memoryMode') = 'disabled'
     and jsonb_array_length(new.acceptance_scope->'memoryRevisionIds') <> 0 then
    raise exception 'AI run acceptance scope enables memory revisions while memory is disabled'
      using errcode = '23514', constraint = 'ai_runs_acceptance_scope_memory_mode';
  end if;
  if exists (
    select 1
    from jsonb_array_elements_text(new.acceptance_scope->'memoryRevisionIds') selected(value)
    where not exists (
      select 1
      from user_memory_revisions revisions
      join user_memories memories on memories.id = revisions.memory_id
      where revisions.id::text = selected.value
        and memories.user_id = new.initiating_user_id
        and memories.deleted_at is null
        and memories.provenance_only_at is null
        and memories.head_revision_id = revisions.id
    )
  ) then
    raise exception 'AI run acceptance scope contains a foreign memory revision'
      using errcode = '23514', constraint = 'ai_runs_acceptance_scope_memory';
  end if;
  if (
    select count(*) from jsonb_array_elements_text(new.acceptance_scope->'memoryRevisionIds')
  ) <> (case when (new.acceptance_scope->>'memoryMode') = 'private_owner' then (
    select count(*)
    from user_memories memories
    where memories.user_id = new.initiating_user_id
      and memories.deleted_at is null
      and memories.provenance_only_at is null
      and memories.head_revision_id is not null
  ) else 0 end) then
    raise exception 'AI run acceptance scope memory revision set is not the live accepted set'
      using errcode = '23514', constraint = 'ai_runs_acceptance_scope_memory_set';
  end if;
  return new;
end;
$$;

drop trigger if exists ai_runs_validate_acceptance_scope on ai_runs;
create trigger ai_runs_validate_acceptance_scope
before insert or update on ai_runs
for each row execute function brief_ai_validate_acceptance_scope();

-- Company delivery rows do not identify the employees who received an issue.
-- Freeze that recipient fact at delivery for historical raw/citation reads.
create table if not exists issue_delivery_recipients (
  issue_id uuid not null references publisher_issues (id) on delete cascade,
  client_company_id uuid not null references client_companies (id) on delete cascade,
  user_id text not null,
  delivered_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (issue_id, client_company_id, user_id),
  constraint issue_delivery_recipients_delivery_key
    foreign key (issue_id, client_company_id)
    references issue_deliveries (issue_id, client_company_id) on delete cascade,
  constraint issue_delivery_recipients_membership_key
    foreign key (client_company_id, user_id)
    references client_company_memberships (company_id, user_id) on delete cascade,
  constraint issue_delivery_recipients_user_nonempty check (btrim(user_id) <> '')
);

create index if not exists issue_delivery_recipients_user_issue_idx
  on issue_delivery_recipients (user_id, issue_id, client_company_id);

-- A recipient snapshot can be opened only by the delivery INSERT that owns
-- it.  The marker is transaction-local, so a later transaction cannot add a
-- user to an old delivery.  The migration backfill uses its separate,
-- transaction-local proof flag below.
create or replace function open_issue_delivery_recipient_snapshot()
returns trigger language plpgsql as $$
begin
  perform set_config(
    format('brief.delivery_snapshot.x%s', md5(new.issue_id::text || ':' || new.client_company_id::text)),
    'on',
    true
  );
  return new;
end;
$$;

drop trigger if exists issue_deliveries_open_recipient_snapshot on issue_deliveries;
create trigger issue_deliveries_open_recipient_snapshot
after insert on issue_deliveries
for each row execute function open_issue_delivery_recipient_snapshot();

-- Backfill only recipients whose durable grant and membership timestamps prove
-- entitlement at delivery time. Rows without that proof remain unavailable.
select set_config('brief.allow_delivery_recipient_backfill', 'on', true);
insert into issue_delivery_recipients (issue_id, client_company_id, user_id, delivered_at)
select delivery.issue_id,
       delivery.client_company_id,
       grants.user_id,
       delivery.delivered_at
from issue_deliveries delivery
join client_employee_subscription_grants grants
  on grants.access_id = delivery.access_id
 and grants.client_company_id = delivery.client_company_id
join client_company_memberships memberships
  on memberships.company_id = delivery.client_company_id
 and memberships.user_id = grants.user_id
where grants.granted_at <= delivery.delivered_at
  and (grants.revoked_at is null or grants.revoked_at > delivery.delivered_at)
  and memberships.created_at <= delivery.delivered_at
  and (memberships.revoked_at is null or memberships.revoked_at > delivery.delivered_at)
  and not exists (
    select 1
    from issue_delivery_recipients existing
    where existing.issue_id = delivery.issue_id
      and existing.client_company_id = delivery.client_company_id
      and existing.user_id = grants.user_id
  )
on conflict (issue_id, client_company_id, user_id) do nothing;
select set_config('brief.allow_delivery_recipient_backfill', 'off', true);

create or replace function protect_issue_delivery_recipient()
returns trigger language plpgsql as $$
declare
  delivery_row issue_deliveries%rowtype;
begin
  if tg_op = 'DELETE' then
    if current_setting('brief.allow_account_purge', true) = 'on' then
      return old;
    end if;
    raise exception 'issue delivery recipients are immutable'
      using errcode = '23514', constraint = 'issue_delivery_recipients_immutable';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'issue delivery recipients are immutable'
      using errcode = '23514', constraint = 'issue_delivery_recipients_immutable';
  end if;

  if current_setting('brief.allow_delivery_recipient_backfill', true) is distinct from 'on'
     and current_setting(
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

drop trigger if exists issue_delivery_recipients_immutable on issue_delivery_recipients;
create trigger issue_delivery_recipients_immutable
before insert or update or delete on issue_delivery_recipients
for each row execute function protect_issue_delivery_recipient();

-- These former live-policy columns are no longer authorization authority.
alter table ai_runs
  drop column if exists web_search_enabled,
  drop column if exists effective_web_policy;
