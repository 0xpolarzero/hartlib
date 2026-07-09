alter table ai_run_events
  add column if not exists emitted_by_task text;

create index if not exists ai_run_events_run_task_idx
  on ai_run_events (run_id, emitted_by_task)
  where emitted_by_task is not null;
