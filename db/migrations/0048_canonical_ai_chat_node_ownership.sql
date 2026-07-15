-- Assembly and exact measurement now have distinct durable node outputs. Refuse
-- to discard resumable runs or orphaned legacy outputs before removing the two
-- superseded output tables.
DO $$
DECLARE
  output_table text;
  output_row_count bigint;
BEGIN
  IF to_regclass('public._smithers_runs') IS NOT NULL THEN
    EXECUTE
      'select count(*) from public._smithers_runs where run_id like ''ai-chat:%'''
      INTO output_row_count;

    IF output_row_count <> 0 THEN
      RAISE EXCEPTION
        'AI chat node-ownership migration requires all prior Smithers runs to be drained (% run rows remain)',
        output_row_count;
    END IF;
  END IF;

  FOREACH output_table IN ARRAY ARRAY[
    'ai_chat_selectors',
    'ai_chat_fanout_contexts'
  ]
  LOOP
    IF to_regclass(format('public.%I', output_table)) IS NOT NULL THEN
      EXECUTE format('select count(*) from public.%I', output_table)
        INTO output_row_count;

      IF output_row_count <> 0 THEN
        RAISE EXCEPTION
          'AI chat node-ownership migration requires drained Smithers output table % (% rows remain)',
          output_table,
          output_row_count;
      END IF;
    END IF;
  END LOOP;
END
$$;

DROP TABLE IF EXISTS public.ai_chat_selectors;
DROP TABLE IF EXISTS public.ai_chat_fanout_contexts;
