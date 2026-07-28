-- Chat reset is archive-and-replace, not deletion. The old conversation stays
-- as read-only history while a fresh replacement inherits its company,
-- immutable memory mode, and exact selected subscription sources. Archive
-- alone never starts a retention purge; explicit deletion and legal hold keep
-- their existing lifecycle.

alter table chats
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by_user_id text,
  add column if not exists replaced_by_chat_id uuid;

-- The replacement row is committed before this link is set, so the foreign key
-- is always satisfiable within the single reset transaction. If the successor
-- is later deleted independently, the lineage pointer retracts to null rather
-- than cascading back into the archived history.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chats_replaced_by_chat_id_fkey'
  ) then
    alter table chats
      add constraint chats_replaced_by_chat_id_fkey
      foreign key (replaced_by_chat_id) references chats (id) on delete set null;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chats_archive_shape'
  ) then
    alter table chats
      add constraint chats_archive_shape check (
        (archived_at is null and archived_by_user_id is null and replaced_by_chat_id is null)
        or
        (
          archived_at is not null
          and archived_by_user_id is not null
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'chats_archive_no_self_reference'
  ) then
    alter table chats
      add constraint chats_archive_no_self_reference
      check (replaced_by_chat_id is null or replaced_by_chat_id <> id);
  end if;

  -- An archived chat may still be shared for read-only history, but a reset
  -- never leaves a half-archived row. Deletion remains independent and may
  -- follow archive on the explicit delete path.
  if not exists (
    select 1 from pg_constraint where conname = 'chats_archive_before_delete'
  ) then
    alter table chats
      add constraint chats_archive_before_delete check (
        archived_at is null or deleted_at is null or deleted_at >= archived_at
      );
  end if;
end
$$;

-- A replacement chat can be the successor of at most one archived chat. The
-- partial unique index is the durable replay and contention guard: a second
-- reset that supplies the same replacement UUID for a different old chat is
-- rejected at the row level, and replay resolves to the single committed row.
create unique index if not exists chats_replaced_by_chat_id_key
  on chats (replaced_by_chat_id)
  where replaced_by_chat_id is not null;

-- Active owner list: the chats a user can still write to. Ordered to match the
-- canonical listing projection and scoped to live, non-archived rows.
create index if not exists chats_active_owner_idx
  on chats (user_id, updated_at desc, id)
  where archived_at is null and deleted_at is null;

-- Archived owner list: the read-only history a user reset away. Ordered by the
-- archive moment so the most recent reset surfaces first.
create index if not exists chats_archived_owner_idx
  on chats (user_id, archived_at desc, id)
  where archived_at is not null and deleted_at is null;
