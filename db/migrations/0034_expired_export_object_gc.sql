-- Export archives contain full private content and must be physically removed
-- when their product download TTL expires. The request row remains as bounded
-- operational metadata, while this timestamp proves object-store deletion.

alter table export_requests
  add column if not exists object_deleted_at timestamptz;

alter table export_requests
  drop constraint if exists export_requests_object_deletion_shape;
alter table export_requests
  add constraint export_requests_object_deletion_shape check (
    object_deleted_at is null
    or (
      status = 'completed'
      and object_key is not null
      and expires_at is not null
      and object_deleted_at >= expires_at
    )
  );

create index if not exists export_requests_expired_object_gc_idx
  on export_requests (expires_at, id)
  where status = 'completed'
    and object_key is not null
    and object_deleted_at is null;

create or replace function enforce_export_object_deletion()
returns trigger
language plpgsql
as $$
begin
  if old.object_deleted_at is not null
     and new.object_deleted_at is distinct from old.object_deleted_at then
    raise exception 'export object deletion is immutable';
  end if;

  if old.object_deleted_at is null and new.object_deleted_at is not null then
    if current_setting('brief.allow_export_object_purge', true) is distinct from 'on'
       or old.status <> 'completed'
       or old.object_key is null
       or old.expires_at is null
       or old.expires_at > now()
       or new.object_deleted_at < old.expires_at then
      raise exception 'export object deletion requires expired GC context';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists export_requests_enforce_object_deletion on export_requests;
create trigger export_requests_enforce_object_deletion
before update of object_deleted_at on export_requests
for each row execute function enforce_export_object_deletion();
