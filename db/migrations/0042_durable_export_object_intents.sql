-- Export bytes are written outside the database transaction. Persist the
-- deterministic object key before the write so every possible archive,
-- including an ambiguous or failed write, remains discoverable by GC.

alter table export_requests
  add column if not exists object_purge_after timestamptz;

update export_requests
set object_purge_after = expires_at
where status = 'completed' and object_purge_after is null;

alter table export_requests
  drop constraint if exists export_requests_result_shape,
  drop constraint if exists export_requests_object_deletion_shape;

alter table export_requests
  add constraint export_requests_object_key_deterministic check (
    object_key is null
    or object_key = 'exports/' || id::text || '.tar'
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
    or
    (
      status = 'failed'
      and completed_at is not null
      and expires_at is null
      and error_code is not null
      and (
        (object_key is null and object_purge_after is null)
        or
        (object_key is not null and object_purge_after is not null)
      )
    )
    or
    (
      status = 'queued'
      and object_key is null
      and object_purge_after is null
      and completed_at is null
      and expires_at is null
      and error_code is null
    )
    or
    (
      status = 'running'
      and completed_at is null
      and expires_at is null
      and error_code is null
      and (
        (object_key is null and object_purge_after is null)
        or
        (object_key is not null and object_purge_after is not null)
      )
    )
  ),
  add constraint export_requests_object_deletion_shape check (
    object_deleted_at is null
    or (
      object_key is not null
      and object_purge_after is not null
      and object_deleted_at >= object_purge_after
      and (
        (status = 'completed' and expires_at = object_purge_after)
        or status in ('running', 'failed')
      )
    )
  );

drop index if exists export_requests_expired_object_gc_idx;
create index export_requests_expired_object_gc_idx
  on export_requests (object_purge_after, id)
  where object_key is not null
    and object_purge_after is not null
    and object_deleted_at is null
    and status in ('running', 'completed', 'failed');

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
       or old.object_key is null
       or old.object_purge_after is null
       or old.object_purge_after > now()
       or new.object_deleted_at < old.object_purge_after then
      raise exception 'export object deletion requires expired GC context';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists export_requests_enforce_object_deletion on export_requests;
create trigger export_requests_enforce_object_deletion
before update of object_key, object_deleted_at on export_requests
for each row execute function enforce_export_object_deletion();
