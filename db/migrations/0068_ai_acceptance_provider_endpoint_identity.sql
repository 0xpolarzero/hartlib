-- Accepted provider scope must bind both the service and the exact endpoint.
-- Existing rows without that identity are not repaired: the migration stops
-- and the operator must drain or purge them under the retention process.
do $$
declare
  row_data record;
begin
  for row_data in
      select runs.id::text as row_identity
      from ai_runs runs
      where runs.acceptance_scope->>'providerEndpointIdentity' is null
         or btrim(runs.acceptance_scope->>'providerEndpointIdentity') = ''
      order by runs.id
    loop
      raise exception
        'AI provider endpoint cutover preflight row ai_runs/%: no exact accepted endpoint identity',
        row_data.row_identity;
    end loop;
end
$$;

alter table ai_runs
  drop constraint if exists ai_runs_acceptance_scope_shape,
  add constraint ai_runs_acceptance_scope_shape check (
    jsonb_typeof(acceptance_scope) = 'object'
    and acceptance_scope ?& array[
      'userId', 'chatId', 'companyId', 'subscriptionIds', 'accessIds',
      'publicSourceIds', 'memoryMode', 'memoryRevisionIds', 'webRequested',
      'webEnabled', 'provider', 'providerEndpointIdentity', 'fastModelId',
      'mainModelId', 'webTransportProvider', 'allowedDomains'
    ]
    and (acceptance_scope - array[
      'userId', 'chatId', 'companyId', 'subscriptionIds', 'accessIds',
      'publicSourceIds', 'memoryMode', 'memoryRevisionIds', 'webRequested',
      'webEnabled', 'provider', 'providerEndpointIdentity', 'fastModelId',
      'mainModelId', 'webTransportProvider', 'allowedDomains'
    ]) = '{}'::jsonb
    and jsonb_typeof(acceptance_scope->'providerEndpointIdentity') = 'string'
    and btrim(acceptance_scope->>'providerEndpointIdentity') = acceptance_scope->>'providerEndpointIdentity'
    and acceptance_scope->>'providerEndpointIdentity' like (acceptance_scope->>'provider' || ':%')
    and (
      (acceptance_scope->>'provider' = 'zai_coding_plan_official'
       and acceptance_scope->>'providerEndpointIdentity' =
         'zai_coding_plan_official:https://api.z.ai/api/coding/paas/v4')
      or acceptance_scope->>'provider' in ('deterministic_test', 'openai_compatible_custom')
    )
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
