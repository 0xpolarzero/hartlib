export const jobSql = {
  claimNext: `
    update jobs
    set status = 'running',
        attempts = attempts + 1,
        started_at = now()
    where id = (
      select id
      from jobs
      where status = 'queued'
        and run_at <= now()
      order by priority desc, run_at asc, created_at asc
      for update skip locked
      limit 1
    )
    returning id, kind, payload, attempts
  `,
  markCompleted: `
    update jobs
    set status = 'completed',
        completed_at = now(),
        error = null
    where id = $1
  `,
  markFailed: `
    update jobs
    set status = 'failed',
        failed_at = now(),
        error = $2
    where id = $1
  `
} as const
