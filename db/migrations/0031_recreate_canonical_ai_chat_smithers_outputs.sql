-- The canonical graph replaces the preflight/hydrate workflow and changes the
-- payload shape of the surviving output names. Smithers' PostgreSQL adapter
-- creates output tables but does not alter an existing table to a new Zod
-- schema. Refuse to discard durable state: deployments must drain and prune all
-- rows before this forward-only schema boundary is crossed.
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
        'canonical AI chat migration requires all prior Smithers runs to be drained (% run rows remain)',
        output_row_count;
    END IF;
  END IF;

  FOREACH output_table IN ARRAY ARRAY[
    'ai_chat_load_turn',
    'ai_chat_preflight',
    'ai_chat_hydrate',
    'ai_chat_answer',
    'ai_chat_preflight2',
    'ai_chat_hydrate2',
    'ai_chat_answer2',
    'ai_chat_memory',
    'ai_chat_finalize'
  ]
  LOOP
    IF to_regclass(format('public.%I', output_table)) IS NOT NULL THEN
      EXECUTE format('select count(*) from public.%I', output_table)
        INTO output_row_count;

      IF output_row_count <> 0 THEN
        RAISE EXCEPTION
          'canonical AI chat migration requires drained Smithers output table % (% rows remain)',
          output_table,
          output_row_count;
      END IF;
    END IF;
  END LOOP;
END
$$;

DROP TABLE IF EXISTS public.ai_chat_load_turn;
DROP TABLE IF EXISTS public.ai_chat_preflight;
DROP TABLE IF EXISTS public.ai_chat_hydrate;
DROP TABLE IF EXISTS public.ai_chat_answer;
DROP TABLE IF EXISTS public.ai_chat_preflight2;
DROP TABLE IF EXISTS public.ai_chat_hydrate2;
DROP TABLE IF EXISTS public.ai_chat_answer2;
DROP TABLE IF EXISTS public.ai_chat_memory;
DROP TABLE IF EXISTS public.ai_chat_finalize;
