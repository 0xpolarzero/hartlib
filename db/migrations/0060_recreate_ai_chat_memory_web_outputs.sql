-- The memory and web selector payloads changed materially. Smithers' PostgreSQL
-- adapter creates output tables but does not alter an existing table to a new
-- Zod schema. Refuse to discard durable state: deployments must drain all
-- AI-chat runs and prune both outputs before this forward-only boundary.
DO $$
DECLARE
  output_table text;
  output_row_count bigint;
BEGIN
  -- AI-chat Smithers producers/resumers take the shared side of this fence
  -- before table creation and every durable workflow operation. Holding the
  -- exclusive side across all discovery, locking, counting, and dropping
  -- closes both the checked-to-drop insert gap and absent-table creation race.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('brief:ai-chat:smithers-schema', 0)
  );

  -- Lock every existing relevant table in deterministic order before any
  -- count. Missing tables are safe: the exclusive producer fence prevents a
  -- compatible Smithers producer from creating one until this transaction
  -- commits and releases the fence.
  FOR output_table IN
    SELECT name
    FROM unnest(ARRAY['_smithers_runs', 'ai_chat_memories', 'ai_chat_web']) AS names(name)
    ORDER BY name
  LOOP
    IF to_regclass(format('public.%I', output_table)) IS NOT NULL THEN
      EXECUTE format('lock table public.%I in access exclusive mode', output_table);
    END IF;
  END LOOP;

  IF to_regclass('public._smithers_runs') IS NOT NULL THEN
    EXECUTE
      'select count(*) from public._smithers_runs where run_id like ''ai-chat:%'''
      INTO output_row_count;

    IF output_row_count <> 0 THEN
      RAISE EXCEPTION
        'AI chat memory/web payload migration requires all prior Smithers runs to be drained (% run rows remain)',
        output_row_count;
    END IF;
  END IF;

  FOREACH output_table IN ARRAY ARRAY[
    'ai_chat_memories',
    'ai_chat_web'
  ]
  LOOP
    IF to_regclass(format('public.%I', output_table)) IS NOT NULL THEN
      EXECUTE format('select count(*) from public.%I', output_table)
        INTO output_row_count;

      IF output_row_count <> 0 THEN
        RAISE EXCEPTION
          'AI chat memory/web payload migration requires drained Smithers output table % (% rows remain)',
          output_table,
          output_row_count;
      END IF;
    END IF;
  END LOOP;
END
$$;

DROP TABLE IF EXISTS public.ai_chat_memories;
DROP TABLE IF EXISTS public.ai_chat_web;
