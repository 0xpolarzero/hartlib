-- Acceptance snapshots carry the exact model provider selected by deployment.
-- Keep the value strict while allowing the deterministic and custom test
-- transports that the worker can execute.
alter table ai_runs
  drop constraint if exists ai_runs_acceptance_scope_shape;

alter table ai_runs
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
    and acceptance_scope->>'provider' in (
      'zai_coding_plan_official', 'deterministic_test', 'openai_compatible_custom'
    )
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
