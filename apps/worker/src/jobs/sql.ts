export const jobSql = {
  enqueue: `
    insert into jobs (kind, payload, unique_key, available_at, priority, max_attempts)
    values ($1, $2, $3, $4, $5, $6)
    on conflict (unique_key) where unique_key is not null do update set
      payload = case
        when jobs.status in ('completed', 'failed') then excluded.payload
        else jobs.payload
      end,
      available_at = case
        when jobs.status in ('completed', 'failed') then excluded.available_at
        when jobs.status = 'queued' then least(jobs.available_at, excluded.available_at)
        else jobs.available_at
      end,
      priority = greatest(jobs.priority, excluded.priority),
      attempts = case
        when jobs.status in ('completed', 'failed') then 0
        else jobs.attempts
      end,
      max_attempts = excluded.max_attempts,
      status = case
        when jobs.status in ('completed', 'failed') then 'queued'
        else jobs.status
      end,
      locked_at = case
        when jobs.status in ('completed', 'failed') then null
        else jobs.locked_at
      end,
      locked_by = case
        when jobs.status in ('completed', 'failed') then null
        else jobs.locked_by
      end,
      completed_at = case
        when jobs.status in ('completed', 'failed') then null
        else jobs.completed_at
      end,
      last_error = case
        when jobs.status in ('completed', 'failed') then null
        else jobs.last_error
      end,
      updated_at = now()
    returning id, kind, payload, attempts
  `,
  claimNext: `
    select pg_advisory_xact_lock(hashtext('brief:jobs:claim'));

    update jobs
    set status = case
          when attempts < max_attempts then 'retrying'
          else 'failed'
        end,
        available_at = case
          when attempts < max_attempts then now()
          else available_at
        end,
        locked_at = null,
        locked_by = null,
        last_error = 'Job lock expired before completion',
        updated_at = now()
    where status = 'running'
      and locked_at < now() - ($1 * interval '1 millisecond');

    update jobs
    set status = 'running',
        attempts = attempts + 1,
        locked_at = now(),
        locked_by = $2,
        updated_at = now()
    where id = (
      select pending.id
      from jobs pending
      where pending.status in ('queued', 'retrying')
        and pending.available_at <= now()
        and not exists (
          select 1
          from jobs running
          where running.status = 'running'
            and running.kind = pending.kind
            and running.kind = 'public_source_ingestion'
            and running.payload->>'sourceId' = pending.payload->>'sourceId'
        )
      order by pending.priority desc, pending.available_at asc, pending.created_at asc
      for update skip locked
      limit 1
    )
    returning id, kind, payload, attempts, locked_by as "lockedBy"
  `,
  markCompleted: `
    update jobs
    set status = 'completed',
        completed_at = now(),
        locked_at = null,
        locked_by = null,
        last_error = null,
        updated_at = now()
    where id = $1
      and status = 'running'
      and locked_by = $2
    returning id
  `,
  heartbeat: `
    update jobs
    set locked_at = now(),
        updated_at = now()
    where id = $1
      and status = 'running'
      and locked_by = $2
    returning id
  `,
  markFailed: `
    update jobs
    set status = case
          when attempts < max_attempts then 'retrying'
          else 'failed'
        end,
        available_at = case
          when attempts < max_attempts then now() + ($3 * interval '1 millisecond')
          else available_at
        end,
        locked_at = null,
        locked_by = null,
        last_error = $2,
        updated_at = now()
    where id = $1
      and status = 'running'
      and locked_by = $4
    returning id
  `,
} as const;
