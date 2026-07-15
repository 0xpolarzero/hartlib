alter table publisher_issues
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by_user_id text,
  add column if not exists purge_after timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'publisher_issues_deletion_shape'
  ) then
    alter table publisher_issues
      add constraint publisher_issues_deletion_shape check (
        (
          deleted_at is null
          and deleted_by_user_id is null
          and purge_after is null
        )
        or
        (
          status <> 'published'
          and deleted_at is not null
          and btrim(deleted_by_user_id) <> ''
          and purge_after >= deleted_at
          and purge_after <= deleted_at + interval '30 days'
        )
      );
  end if;
end
$$;

create index if not exists publisher_issues_purge_idx
  on publisher_issues (purge_after, id)
  where deleted_at is not null;

create table if not exists purged_publisher_issue_tombstones (
  issue_id uuid primary key,
  subscription_id uuid not null,
  deleted_at timestamptz not null,
  deleted_by_user_id text not null,
  purged_at timestamptz not null default now(),
  constraint purged_publisher_issue_tombstones_actor_nonempty
    check (btrim(deleted_by_user_id) <> '')
);

create or replace function reject_purged_publisher_issue_tombstone_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'purged publisher issue tombstones are append-only';
end
$$;

drop trigger if exists purged_publisher_issue_tombstones_no_mutation
  on purged_publisher_issue_tombstones;
create trigger purged_publisher_issue_tombstones_no_mutation
before update or delete on purged_publisher_issue_tombstones
for each row execute function reject_purged_publisher_issue_tombstone_mutation();

create or replace function require_publisher_issue_purge_context()
returns trigger
language plpgsql
as $$
begin
  if current_setting('brief.allow_issue_purge', true) is distinct from 'on' then
    raise exception 'publisher issues require recoverable deletion before purge';
  end if;
  if old.deleted_at is null or old.purge_after > now() then
    raise exception 'publisher issue is not eligible for purge';
  end if;
  return old;
end
$$;

drop trigger if exists publisher_issues_require_purge_context on publisher_issues;
create trigger publisher_issues_require_purge_context
before delete on publisher_issues
for each row execute function require_publisher_issue_purge_context();
