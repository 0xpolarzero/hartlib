-- New evaluation sessions attest the fixed Tinyfish web-discovery endpoint.
-- Historical sessions may retain their immutable Z.AI endpoint identity; the
-- worker preflight accepts only Tinyfish for new execution.
alter table ai_evaluation_sessions
  drop constraint if exists ai_evaluation_sessions_execution_identity;

alter table ai_evaluation_sessions
  add constraint ai_evaluation_sessions_execution_identity check (
    (execution_config_sha256_hex is null and provider_endpoint_identity is null)
    or (
      execution_config_sha256_hex ~ '^[0-9a-f]{64}$'
      and provider_endpoint_identity in (
        'tinyfish_search_official:https://api.search.tinyfish.ai',
        'zai_coding_plan_official:https://api.z.ai/api/coding/paas/v4'
      )
    )
  );
