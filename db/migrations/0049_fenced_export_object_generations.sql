-- An export object write is an external side effect and may outlive a worker
-- attempt. Give every invocation a never-reused generation key, promote only a
-- definitively successful generation, and make the durable delete fence (not
-- the remote response) the legal-hold-versus-GC linearization point.

lock table export_requests in share row exclusive mode;
lock table jobs in share row exclusive mode;

do $$
begin
  if exists (
    select 1 from jobs
    where kind in ('generate_export', 'purge_expired_exports')
      and status = 'running'
  ) or exists (
    select 1 from export_requests
    where status = 'running'
  ) then
    raise exception 'fenced export-object migration requires export generation and GC jobs to be drained';
  end if;

  if exists (
    select 1 from export_requests
    where object_key is not null and object_deleted_at is null
  ) then
    raise exception 'fenced export-object migration requires every legacy object to be physically deleted';
  end if;

  if exists (
    select 1 from export_requests
    where object_key is not null and status not in ('completed', 'failed')
  ) then
    raise exception 'fenced export-object migration can convert only completed or failed legacy objects';
  end if;
end
$$;

alter table export_requests
  add column if not exists object_generation bigint not null default 0;

create table if not exists export_object_generations (
  export_request_id uuid not null references export_requests (id) on delete restrict,
  generation bigint not null,
  object_key text not null,
  writer_state text not null default 'not_started',
  expected_sha256 text,
  byte_size bigint,
  writer_started_at timestamptz,
  writer_succeeded_at timestamptz,
  promoted_at timestamptz,
  purge_after timestamptz not null,
  delete_fenced_at timestamptz,
  deleted_at timestamptz,
  delete_attempts integer not null default 0,
  next_delete_attempt_at timestamptz not null,
  legacy_unverifiable boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (export_request_id, generation),
  unique (object_key),
  unique (export_request_id, generation, object_key),
  constraint export_object_generations_generation_nonnegative check (generation >= 0),
  constraint export_object_generations_key_deterministic check (
    (
      generation = 0
      and object_key = 'exports/' || export_request_id::text || '.tar'
    )
    or (
      generation > 0
      and object_key = 'exports/' || export_request_id::text || '/attempt-' || generation::text || '.tar'
    )
  ),
  constraint export_object_generations_writer_state check (
    writer_state in ('not_started', 'in_flight', 'succeeded', 'unknown')
  ),
  constraint export_object_generations_writer_shape check (
    (
      legacy_unverifiable
      and generation = 0
      and writer_state in ('succeeded', 'unknown')
      and expected_sha256 is null
      and byte_size is null
      and (
        (
          writer_state = 'succeeded'
          and writer_succeeded_at is not null
          and writer_started_at is null
        )
        or (
          writer_state = 'unknown'
          and writer_started_at is null
          and writer_succeeded_at is null
        )
      )
    )
    or (
      not legacy_unverifiable
      and (
        (
          writer_state = 'not_started'
          and expected_sha256 is null
          and byte_size is null
          and writer_started_at is null
          and writer_succeeded_at is null
        )
        or (
          writer_state in ('in_flight', 'unknown')
          and expected_sha256 ~ '^[a-f0-9]{64}$'
          and byte_size >= 0
          and writer_started_at is not null
          and writer_succeeded_at is null
        )
        or (
          writer_state = 'succeeded'
          and expected_sha256 ~ '^[a-f0-9]{64}$'
          and byte_size >= 0
          and writer_started_at is not null
          and writer_succeeded_at is not null
          and writer_succeeded_at >= writer_started_at
        )
      )
    )
  ),
  constraint export_object_generations_promotion_shape check (
    promoted_at is null or writer_state = 'succeeded'
  ),
  constraint export_object_generations_delete_shape check (
    (delete_fenced_at is null and deleted_at is null)
    or (delete_fenced_at is not null and deleted_at is null)
    or (
      delete_fenced_at is not null
      and deleted_at >= delete_fenced_at
      and writer_state in ('not_started', 'succeeded')
    )
  ),
  constraint export_object_generations_delete_attempts_nonnegative check (delete_attempts >= 0)
);

-- Only already-physically-deleted legacy objects pass the preflight. A
-- completed pointer is authoritative enough to represent as generation zero,
-- but its historical payload digest and size are not reconstructible. A
-- failed pointer is never made authoritative: preserve it as an unverifiable,
-- fenced, not-certified-deleted generation that GC must keep probing.
insert into export_object_generations (
  export_request_id, generation, object_key, writer_state,
  expected_sha256, byte_size, writer_started_at, writer_succeeded_at,
  promoted_at, purge_after, delete_fenced_at, deleted_at,
  delete_attempts, next_delete_attempt_at, legacy_unverifiable,
  created_at, updated_at
)
select requests.id, 0, requests.object_key, 'succeeded',
       null, null, null,
       coalesce(requests.completed_at, requests.created_at),
       requests.completed_at,
       requests.object_purge_after, requests.object_deleted_at, requests.object_deleted_at,
       1, requests.object_deleted_at, true, requests.created_at, now()
from export_requests requests
where requests.object_key is not null and requests.status = 'completed'
on conflict (export_request_id, generation) do nothing;

insert into export_object_generations (
  export_request_id, generation, object_key, writer_state,
  expected_sha256, byte_size, writer_started_at, writer_succeeded_at,
  promoted_at, purge_after, delete_fenced_at, deleted_at,
  delete_attempts, next_delete_attempt_at, legacy_unverifiable,
  created_at, updated_at
)
select requests.id, 0, requests.object_key, 'unknown',
       null, null, null, null, null,
       requests.object_purge_after, requests.object_deleted_at, null,
       1, now(), true, requests.created_at, now()
from export_requests requests
where requests.object_key is not null and requests.status = 'failed'
on conflict (export_request_id, generation) do nothing;

-- The 0042 key trigger intentionally protects runtime object pointers. The
-- table lock above stops producers while this migration performs the one
-- narrowly-scoped conversion it could not previously express: a physically
-- deleted failed legacy pointer becomes unreferenced generation-zero history.
drop trigger if exists export_requests_enforce_object_deletion on export_requests;
update export_requests
set object_key = null,
    object_purge_after = null,
    object_deleted_at = null
where status = 'failed'
  and object_key is not null
  and object_deleted_at is not null;

alter table export_requests
  drop constraint if exists export_requests_object_generation_nonnegative,
  drop constraint if exists export_requests_object_key_deterministic,
  drop constraint if exists export_requests_result_shape,
  drop constraint if exists export_requests_object_deletion_shape;

alter table export_requests
  add constraint export_requests_object_generation_nonnegative
    check (object_generation >= 0),
  add constraint export_requests_object_key_deterministic check (
    object_key is null
    or (
      object_generation = 0
      and object_key = 'exports/' || id::text || '.tar'
    )
    or (
      object_generation > 0
      and object_key = 'exports/' || id::text || '/attempt-' || object_generation::text || '.tar'
    )
  ),
  add constraint export_requests_result_shape check (
    (
      status = 'completed'
      and object_key is not null
      and completed_at is not null
      and expires_at is not null
      and expires_at > completed_at
      and object_purge_after = expires_at
      and error_code is null
    )
    or (
      status = 'failed'
      and object_key is null
      and object_purge_after is null
      and object_deleted_at is null
      and completed_at is not null
      and expires_at is null
      and error_code is not null
    )
    or (
      status = 'queued'
      and object_generation = 0
      and object_key is null
      and object_purge_after is null
      and object_deleted_at is null
      and completed_at is null
      and expires_at is null
      and error_code is null
    )
    or (
      status = 'running'
      and object_generation > 0
      and object_key is null
      and object_purge_after is null
      and object_deleted_at is null
      and completed_at is null
      and expires_at is null
      and error_code is null
    )
  ),
  add constraint export_requests_object_deletion_shape check (
    object_deleted_at is null
    or (
      status = 'completed'
      and object_key is not null
      and object_purge_after is not null
      and expires_at = object_purge_after
      and object_deleted_at >= object_purge_after
    )
  );

alter table export_requests
  drop constraint if exists export_requests_object_generation_fkey;
alter table export_requests
  add constraint export_requests_object_generation_fkey
  foreign key (id, object_generation, object_key)
  references export_object_generations (export_request_id, generation, object_key)
  deferrable initially deferred;

create index if not exists export_object_generations_gc_idx
  on export_object_generations (next_delete_attempt_at, purge_after, export_request_id, generation)
  where deleted_at is null;

create unique index if not exists export_object_generations_one_promotion_idx
  on export_object_generations (export_request_id)
  where promoted_at is not null;

drop index if exists export_requests_expired_object_gc_idx;

create or replace function enforce_export_object_deletion()
returns trigger
language plpgsql
as $$
begin
  if old.object_key is not null and new.object_key is distinct from old.object_key then
    raise exception 'export object intent key is immutable';
  end if;

  if old.object_deleted_at is not null
     and new.object_deleted_at is distinct from old.object_deleted_at then
    raise exception 'export object deletion is immutable';
  end if;

  if old.object_deleted_at is null and new.object_deleted_at is not null then
    if current_setting('brief.allow_export_object_purge', true) is distinct from 'on'
       or old.status <> 'completed'
       or old.object_key is null
       or old.object_purge_after is null
       or old.object_purge_after > now()
       or new.object_deleted_at < old.object_purge_after
       or not exists (
         select 1
         from export_object_generations generation
         where generation.export_request_id = old.id
           and generation.generation = old.object_generation
           and generation.object_key = old.object_key
           and generation.deleted_at = new.object_deleted_at
       ) then
      raise exception 'export object deletion requires expired GC context';
    end if;
  end if;

  return new;
end;
$$;

create trigger export_requests_enforce_object_deletion
before update of object_key, object_deleted_at on export_requests
for each row execute function enforce_export_object_deletion();

create or replace function protect_export_object_generation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'export object generation history is append-only';
  end if;

  if tg_op = 'INSERT' then
    if new.generation <= 0
       or new.object_key is distinct from (
         'exports/' || new.export_request_id::text || '/attempt-' || new.generation::text || '.tar'
       )
       or new.writer_state <> 'not_started'
       or new.expected_sha256 is not null
       or new.byte_size is not null
       or new.writer_started_at is not null
       or new.writer_succeeded_at is not null
       or new.promoted_at is not null
       or new.delete_fenced_at is not null
       or new.deleted_at is not null
       or new.delete_attempts <> 0
       or new.legacy_unverifiable
       or new.purge_after < now() + interval '1 millisecond'
       or new.purge_after > now() + interval '31 days'
       or new.next_delete_attempt_at is distinct from new.purge_after then
      raise exception 'export object generation must begin as a clean runtime attempt';
    end if;
    new.updated_at := now();
    return new;
  end if;

  if old.deleted_at is not null then
    raise exception 'deleted export object generation is immutable';
  end if;

  if new.export_request_id is distinct from old.export_request_id
     or new.generation is distinct from old.generation
     or new.object_key is distinct from old.object_key
     or new.created_at is distinct from old.created_at
     or new.legacy_unverifiable is distinct from old.legacy_unverifiable then
    raise exception 'export object generation identity is immutable';
  end if;

  if old.expected_sha256 is not null
     and new.expected_sha256 is distinct from old.expected_sha256 then
    raise exception 'export object generation payload identity is immutable';
  end if;
  if old.byte_size is not null and new.byte_size is distinct from old.byte_size then
    raise exception 'export object generation payload identity is immutable';
  end if;
  if old.writer_started_at is not null
     and new.writer_started_at is distinct from old.writer_started_at then
    raise exception 'export object generation writer start is immutable';
  end if;
  if old.writer_succeeded_at is not null
     and new.writer_succeeded_at is distinct from old.writer_succeeded_at then
    raise exception 'export object generation writer success is immutable';
  end if;
  if old.writer_state = 'not_started' and new.writer_state not in ('not_started', 'in_flight') then
    raise exception 'invalid export object writer transition';
  end if;
  if old.writer_state = 'not_started'
     and new.writer_state = 'in_flight'
     and new.writer_started_at is distinct from now() then
    raise exception 'export object writer start must use the database clock';
  end if;
  if old.writer_state = 'in_flight' and new.writer_state not in ('in_flight', 'succeeded', 'unknown') then
    raise exception 'invalid export object writer transition';
  end if;
  if old.writer_state = 'in_flight'
     and new.writer_state = 'succeeded'
     and new.delete_fenced_at is not null then
    raise exception 'a fenced export object writer cannot become authoritative';
  end if;
  if old.writer_state = 'in_flight'
     and new.writer_state = 'succeeded'
     and new.writer_succeeded_at is distinct from now() then
    raise exception 'export object writer success must use the database clock';
  end if;
  if old.writer_state in ('succeeded', 'unknown') and new.writer_state <> old.writer_state then
    raise exception 'terminal export object writer state is immutable';
  end if;

  if old.promoted_at is not null and new.promoted_at is distinct from old.promoted_at then
    raise exception 'export object generation promotion is immutable';
  end if;
  if old.promoted_at is null
     and new.promoted_at is not null
     and (old.writer_state <> 'succeeded' or new.delete_fenced_at is not null) then
    raise exception 'only a previously succeeded, unfenced export object generation can be promoted';
  end if;
  if new.purge_after is distinct from old.purge_after then
    if old.promoted_at is not null
       or old.delete_fenced_at is not null
       or new.delete_fenced_at is not null then
      raise exception 'promoted or fenced export object purge deadline is immutable';
    end if;
    if new.promoted_at is null and new.purge_after > old.purge_after then
      raise exception 'unpromoted export object purge deadline cannot be extended';
    end if;
  end if;
  if old.delete_fenced_at is null and new.delete_fenced_at is not null then
    if current_setting('brief.allow_export_object_purge', true) is distinct from 'on'
       or old.purge_after > now()
       or new.writer_state is distinct from old.writer_state
       or new.delete_fenced_at is distinct from now() then
      raise exception 'export object delete fence requires expired GC context';
    end if;
  end if;
  if old.delete_fenced_at is not null
     and new.delete_fenced_at is distinct from old.delete_fenced_at then
    raise exception 'export object generation delete fence is immutable';
  end if;
  if old.deleted_at is null and new.deleted_at is not null then
    if current_setting('brief.allow_export_object_purge', true) is distinct from 'on'
       or old.delete_fenced_at is null
       or old.purge_after > now()
       or new.deleted_at is distinct from now() then
      raise exception 'export object deletion requires an expired durable fence';
    end if;
    if old.writer_state not in ('not_started', 'succeeded') then
      raise exception 'ambiguous export object writer cannot be certified deleted';
    end if;
    if new.delete_attempts <> old.delete_attempts + 1
       or new.next_delete_attempt_at is distinct from now() then
      raise exception 'physical export deletion must record exactly one database-clock probe';
    end if;
  end if;
  if old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at then
    raise exception 'export object generation physical deletion is immutable';
  end if;

  if new.delete_attempts < old.delete_attempts
     or new.delete_attempts > old.delete_attempts + 1 then
    raise exception 'export object delete attempts must advance monotonically one probe at a time';
  end if;
  if new.delete_attempts = old.delete_attempts + 1 then
    if current_setting('brief.allow_export_object_purge', true) is distinct from 'on'
       or old.delete_fenced_at is null then
      raise exception 'export object delete attempts require fenced GC context';
    end if;
    if new.deleted_at is not null then
      if new.next_delete_attempt_at is distinct from now() then
        raise exception 'certified export deletion must use the database probe time';
      end if;
    elsif new.next_delete_attempt_at is distinct from now() + interval '5 minutes' then
      raise exception 'undeleted export objects must be reprobed after exactly five minutes';
    end if;
  elsif new.next_delete_attempt_at is distinct from old.next_delete_attempt_at then
    if new.promoted_at is not null and old.promoted_at is null then
      if new.next_delete_attempt_at is distinct from new.purge_after then
        raise exception 'promoted export object probe time must equal its purge deadline';
      end if;
    elsif old.promoted_at is not null
       or old.delete_fenced_at is not null
       or new.delete_fenced_at is not null
       or new.next_delete_attempt_at > old.next_delete_attempt_at then
      raise exception 'export object probe time may only move earlier before promotion or fencing';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists export_object_generations_protect on export_object_generations;
create trigger export_object_generations_protect
before insert or update or delete on export_object_generations
for each row execute function protect_export_object_generation();

create or replace function protect_export_request_generation()
returns trigger
language plpgsql
as $$
begin
  if old.status not in ('completed', 'failed') and new.status in ('completed', 'failed') then
    if new.completed_at is distinct from now() then
      raise exception 'terminal export request completion must use the database clock';
    end if;
    if new.status = 'completed' and (
      new.expires_at < now() + interval '1 millisecond'
      or new.expires_at > now() + interval '31 days'
      or new.object_purge_after is distinct from new.expires_at
    ) then
      raise exception 'completed export request expiry must use the bounded database deadline';
    end if;
  end if;

  if old.status in ('completed', 'failed') then
    if new.status is distinct from old.status
       or new.object_generation is distinct from old.object_generation
       or new.object_key is distinct from old.object_key
       or new.completed_at is distinct from old.completed_at
       or new.expires_at is distinct from old.expires_at
       or new.object_purge_after is distinct from old.object_purge_after
       or new.error_code is distinct from old.error_code then
      raise exception 'terminal export request result is immutable';
    end if;
    if old.status = 'failed'
       and new.object_deleted_at is distinct from old.object_deleted_at then
      raise exception 'failed export request cannot certify an object deletion';
    end if;
  end if;

  if new.object_generation < old.object_generation
     or new.object_generation > old.object_generation + 1 then
    raise exception 'export request object generation must advance exactly once';
  end if;
  if old.status in ('completed', 'failed')
     and new.object_generation is distinct from old.object_generation then
    raise exception 'terminal export request object generation is immutable';
  end if;

  if new.object_generation > 0 and not exists (
    select 1
    from export_object_generations generation
    where generation.export_request_id = new.id
      and generation.generation = new.object_generation
  ) then
    raise exception 'export request object generation must reference durable history';
  end if;

  if new.status = 'completed' and not exists (
    select 1
    from export_object_generations generation
    where generation.export_request_id = new.id
      and generation.generation = new.object_generation
      and generation.object_key = new.object_key
      and generation.writer_state = 'succeeded'
      and generation.promoted_at = new.completed_at
      and generation.purge_after = new.expires_at
      and new.object_purge_after = new.expires_at
      and (
        (generation.deleted_at is null and new.object_deleted_at is null)
        or generation.deleted_at = new.object_deleted_at
      )
      and (
        generation.delete_fenced_at is null
        or generation.delete_fenced_at >= generation.promoted_at
      )
  ) then
    raise exception 'completed export request must reference a promoted generation';
  end if;
  return new;
end;
$$;

drop trigger if exists export_requests_protect_object_generation on export_requests;
create trigger export_requests_protect_object_generation
before update on export_requests
for each row execute function protect_export_request_generation();

create or replace function validate_completed_export_generation()
returns trigger
language plpgsql
as $$
begin
  if new.object_generation > 0 and not exists (
    select 1
    from export_object_generations generation
    where generation.export_request_id = new.id
      and generation.generation = new.object_generation
  ) then
    raise exception 'export request object generation must reference durable history';
  end if;

  if new.status = 'completed' and not exists (
    select 1
    from export_object_generations generation
    where generation.export_request_id = new.id
      and generation.generation = new.object_generation
      and generation.object_key = new.object_key
      and generation.writer_state = 'succeeded'
      and generation.promoted_at = new.completed_at
      and generation.purge_after = new.expires_at
      and new.object_purge_after = new.expires_at
      and (
        (generation.deleted_at is null and new.object_deleted_at is null)
        or generation.deleted_at = new.object_deleted_at
      )
      and (
        generation.delete_fenced_at is null
        or generation.delete_fenced_at >= generation.promoted_at
      )
  ) then
    raise exception 'completed export request must reference a promoted generation';
  end if;
  if new.status = 'failed' and exists (
    select 1
    from export_object_generations generation
    where generation.export_request_id = new.id
      and generation.promoted_at is null
      and generation.deleted_at is null
      and generation.delete_fenced_at is null
      and (
        generation.purge_after > new.completed_at
        or generation.next_delete_attempt_at > new.completed_at
      )
  ) then
    raise exception 'failed export request generations must be immediately GC-eligible';
  end if;
  return null;
end;
$$;

drop trigger if exists export_requests_validate_completed_generation on export_requests;
create constraint trigger export_requests_validate_completed_generation
after insert or update on export_requests
deferrable initially deferred
for each row execute function validate_completed_export_generation();

create or replace function validate_promoted_export_generation()
returns trigger
language plpgsql
as $$
begin
  if new.generation > 0 and not exists (
    select 1
    from export_requests request
    where request.id = new.export_request_id
      and request.object_generation >= new.generation
  ) then
    raise exception 'runtime export generation must belong to the request generation history';
  end if;

  if new.promoted_at is not null and not exists (
    select 1
    from export_requests request
    where request.id = new.export_request_id
      and request.status = 'completed'
      and request.object_generation = new.generation
      and request.object_key = new.object_key
      and request.completed_at = new.promoted_at
      and request.expires_at = new.purge_after
      and request.object_purge_after = new.purge_after
      and (
        (new.deleted_at is null and request.object_deleted_at is null)
        or request.object_deleted_at = new.deleted_at
      )
      and (
        new.delete_fenced_at is null
        or new.delete_fenced_at >= new.promoted_at
      )
  ) then
    raise exception 'promoted export generation must be the completed request object';
  end if;
  return null;
end;
$$;

drop trigger if exists export_object_generations_validate_promotion
  on export_object_generations;
create constraint trigger export_object_generations_validate_promotion
after insert or update on export_object_generations
deferrable initially deferred
for each row execute function validate_promoted_export_generation();
