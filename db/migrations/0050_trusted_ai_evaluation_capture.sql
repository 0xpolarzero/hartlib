-- Trusted, resumable canonical AI evaluation captures. Model usage must carry
-- the transport that actually produced it; pre-migration rows are deliberately
-- ineligible for a real-provider evaluation instead of being guessed as Z.AI.
alter table ai_run_usage
  add column if not exists provider_service_id text;

update ai_run_usage
set provider_service_id = 'pre_attestation_unknown'
where provider_service_id is null;

alter table ai_run_usage
  alter column provider_service_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ai_run_usage_provider_service_valid'
  ) then
    alter table ai_run_usage
      add constraint ai_run_usage_provider_service_valid
      check (provider_service_id in (
        'zai_coding_plan_official',
        'deterministic_test',
        'openai_compatible_custom',
        'pre_attestation_unknown'
      ));
  end if;
end
$$;

create or replace function preserve_ai_run_usage_provider_service()
returns trigger
language plpgsql
as $$
begin
  if new.provider_service_id is distinct from old.provider_service_id then
    raise exception 'AI provider provenance is immutable'
      using errcode = '23514',
            constraint = 'ai_run_usage_provider_service_immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists ai_run_usage_preserve_provider_service on ai_run_usage;
create trigger ai_run_usage_preserve_provider_service
before update of provider_service_id on ai_run_usage
for each row execute function preserve_ai_run_usage_provider_service();

create table if not exists ai_evaluation_sessions (
  id uuid primary key default gen_random_uuid(),
  artifact_version integer not null,
  golden_set_version integer not null,
  fixture_sha256_hex text not null,
  execution_config_sha256_hex text,
  provider_endpoint_identity text,
  status text not null default 'preparing',
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint ai_evaluation_sessions_versions
    check (artifact_version = 2 and golden_set_version = 2),
  constraint ai_evaluation_sessions_fixture_digest
    check (fixture_sha256_hex ~ '^[0-9a-f]{64}$'),
  constraint ai_evaluation_sessions_execution_identity check (
    (execution_config_sha256_hex is null and provider_endpoint_identity is null)
    or (
      execution_config_sha256_hex ~ '^[0-9a-f]{64}$'
      and provider_endpoint_identity =
        'zai_coding_plan_official:https://api.z.ai/api/coding/paas/v4'
    )
  ),
  constraint ai_evaluation_sessions_status
    check (status in ('preparing', 'running', 'awaiting_annotations', 'complete', 'failed')),
  constraint ai_evaluation_sessions_terminal_shape check (
    (status = 'complete' and completed_at is not null and failure_reason is null
      and execution_config_sha256_hex is not null and provider_endpoint_identity is not null)
    or (status = 'failed' and completed_at is not null and btrim(failure_reason) <> ''
      and execution_config_sha256_hex is not null and provider_endpoint_identity is not null)
    or (status = 'preparing' and completed_at is null and failure_reason is null
        and execution_config_sha256_hex is null and provider_endpoint_identity is null)
    or (status in ('running', 'awaiting_annotations')
        and completed_at is null and failure_reason is null
        and execution_config_sha256_hex is not null and provider_endpoint_identity is not null)
  )
);

create or replace function protect_ai_evaluation_session()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'canonical AI evaluation sessions are append-only'
      using errcode = '23514', constraint = 'ai_evaluation_session_append_only';
  end if;
  if new.id is distinct from old.id
     or new.artifact_version is distinct from old.artifact_version
     or new.golden_set_version is distinct from old.golden_set_version
     or new.fixture_sha256_hex is distinct from old.fixture_sha256_hex
     or new.created_at is distinct from old.created_at
     or (old.execution_config_sha256_hex is not null
         and new.execution_config_sha256_hex is distinct from old.execution_config_sha256_hex)
     or (old.provider_endpoint_identity is not null
         and new.provider_endpoint_identity is distinct from old.provider_endpoint_identity)
     or old.status in ('complete', 'failed') then
    raise exception 'canonical AI evaluation session identity or terminal state is immutable'
      using errcode = '23514', constraint = 'ai_evaluation_session_immutable';
  end if;
  if (old.status = 'preparing' and new.status not in ('preparing', 'running', 'failed'))
     or (old.status = 'running' and new.status not in ('running', 'awaiting_annotations', 'failed'))
     or (old.status = 'awaiting_annotations'
         and new.status not in ('awaiting_annotations', 'complete', 'failed')) then
    raise exception 'invalid canonical AI evaluation session state transition'
      using errcode = '23514', constraint = 'ai_evaluation_session_state_transition';
  end if;
  return new;
end;
$$;

drop trigger if exists ai_evaluation_sessions_protect on ai_evaluation_sessions;
create trigger ai_evaluation_sessions_protect
before update or delete on ai_evaluation_sessions
for each row execute function protect_ai_evaluation_session();

create table if not exists ai_evaluation_case_runs (
  session_id uuid not null references ai_evaluation_sessions (id) on delete restrict,
  case_id text not null,
  topology text not null,
  ai_run_id uuid not null unique references ai_runs (id) on delete restrict,
  seed_manifest jsonb not null,
  status text not null default 'seeded',
  execution_output jsonb,
  execution_output_sha256_hex text,
  run_evidence_sha256_hex text,
  started_at timestamptz,
  finished_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, case_id, topology),
  constraint ai_evaluation_case_runs_case_nonempty check (btrim(case_id) <> ''),
  constraint ai_evaluation_case_runs_topology
    check (topology in ('specialized', 'general_planner')),
  constraint ai_evaluation_case_runs_seed_object
    check (jsonb_typeof(seed_manifest) = 'object'),
  constraint ai_evaluation_case_runs_status
    check (status in ('seeded', 'running', 'succeeded', 'failed')),
  constraint ai_evaluation_case_runs_output_shape check (
    (execution_output is null and execution_output_sha256_hex is null)
    or (
      jsonb_typeof(execution_output) = 'object'
      and execution_output_sha256_hex ~ '^[0-9a-f]{64}$'
    )
  ),
  constraint ai_evaluation_case_runs_evidence_digest check (
    run_evidence_sha256_hex is null
    or run_evidence_sha256_hex ~ '^[0-9a-f]{64}$'
  ),
  constraint ai_evaluation_case_runs_terminal_shape check (
    (status = 'seeded' and started_at is null and finished_at is null
      and failure_reason is null and run_evidence_sha256_hex is null)
    or (status = 'running' and started_at is not null and finished_at is null
      and failure_reason is null and run_evidence_sha256_hex is null)
    or (status = 'succeeded' and started_at is not null and finished_at is not null
      and failure_reason is null and run_evidence_sha256_hex is not null)
    or (status = 'failed' and started_at is not null and finished_at is not null
      and btrim(failure_reason) <> '' and run_evidence_sha256_hex is null)
  )
);

create index if not exists ai_evaluation_case_runs_session_status_idx
  on ai_evaluation_case_runs (session_id, status, topology, case_id);

create table if not exists ai_evaluation_annotations (
  session_id uuid not null,
  case_id text not null,
  topology text not null,
  ai_run_id uuid not null,
  run_evidence_sha256_hex text not null,
  assistant_output_sha256_hex text not null,
  annotations jsonb not null,
  annotations_sha256_hex text not null,
  created_at timestamptz not null default now(),
  primary key (session_id, case_id, topology),
  foreign key (session_id, case_id, topology)
    references ai_evaluation_case_runs (session_id, case_id, topology)
    on delete restrict,
  foreign key (ai_run_id)
    references ai_runs (id)
    on delete restrict,
  constraint ai_evaluation_annotations_topology
    check (topology in ('specialized', 'general_planner')),
  constraint ai_evaluation_annotations_digests check (
    run_evidence_sha256_hex ~ '^[0-9a-f]{64}$'
    and assistant_output_sha256_hex ~ '^[0-9a-f]{64}$'
    and annotations_sha256_hex ~ '^[0-9a-f]{64}$'
  ),
  constraint ai_evaluation_annotations_object
    check (jsonb_typeof(annotations) = 'object')
);

create or replace function protect_ai_evaluation_immutable_identity()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'canonical AI evaluation records are append-only'
      using errcode = '23514', constraint = 'ai_evaluation_append_only';
  end if;

  if new.session_id is distinct from old.session_id
     or new.case_id is distinct from old.case_id
     or new.topology is distinct from old.topology
     or new.ai_run_id is distinct from old.ai_run_id
     or new.seed_manifest is distinct from old.seed_manifest
     or new.created_at is distinct from old.created_at
     or old.status in ('succeeded', 'failed') then
    raise exception 'canonical AI evaluation identity or terminal record is immutable'
      using errcode = '23514', constraint = 'ai_evaluation_identity_immutable';
  end if;

  if (old.started_at is not null and new.started_at is distinct from old.started_at)
     or (old.execution_output is not null
         and (new.execution_output is distinct from old.execution_output
              or new.execution_output_sha256_hex is distinct from old.execution_output_sha256_hex)) then
    raise exception 'canonical AI evaluation execution evidence is write-once'
      using errcode = '23514', constraint = 'ai_evaluation_execution_evidence_write_once';
  end if;

  if (old.status = 'seeded' and new.status not in ('seeded', 'running'))
     or (old.status = 'running' and new.status not in ('running', 'succeeded', 'failed')) then
    raise exception 'invalid canonical AI evaluation state transition'
      using errcode = '23514', constraint = 'ai_evaluation_state_transition';
  end if;
  return new;
end;
$$;

drop trigger if exists ai_evaluation_case_runs_protect on ai_evaluation_case_runs;
create trigger ai_evaluation_case_runs_protect
before update or delete on ai_evaluation_case_runs
for each row execute function protect_ai_evaluation_immutable_identity();

create or replace function validate_ai_evaluation_annotation_binding()
returns trigger
language plpgsql
as $$
declare
  bound ai_evaluation_case_runs%rowtype;
  assistant_content text;
begin
  select * into bound
  from ai_evaluation_case_runs
  where session_id = new.session_id
    and case_id = new.case_id
    and topology = new.topology;

  if bound.status <> 'succeeded'
     or bound.ai_run_id is distinct from new.ai_run_id
     or bound.run_evidence_sha256_hex is distinct from new.run_evidence_sha256_hex then
    raise exception 'annotation is not bound to the exact succeeded evaluation run evidence'
      using errcode = '23514', constraint = 'ai_evaluation_annotation_binding';
  end if;
  select messages.content into assistant_content
  from ai_runs runs
  join chat_messages messages on messages.id = runs.assistant_message_id
  where runs.id = new.ai_run_id;
  if assistant_content is null
     or encode(digest(convert_to(assistant_content, 'UTF8'), 'sha256'), 'hex')
        is distinct from new.assistant_output_sha256_hex then
    raise exception 'annotation assistant-output digest is not bound to the exact durable answer'
      using errcode = '23514', constraint = 'ai_evaluation_annotation_output_binding';
  end if;
  return new;
end;
$$;

drop trigger if exists ai_evaluation_annotations_validate on ai_evaluation_annotations;
create trigger ai_evaluation_annotations_validate
before insert on ai_evaluation_annotations
for each row execute function validate_ai_evaluation_annotation_binding();

create or replace function reject_ai_evaluation_annotation_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'canonical AI evaluation annotations are immutable'
    using errcode = '23514', constraint = 'ai_evaluation_annotations_immutable';
end;
$$;

drop trigger if exists ai_evaluation_annotations_immutable on ai_evaluation_annotations;
create trigger ai_evaluation_annotations_immutable
before update or delete on ai_evaluation_annotations
for each row execute function reject_ai_evaluation_annotation_mutation();
