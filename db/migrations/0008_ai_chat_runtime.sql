create table if not exists chats (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chats_user_idx on chats (user_id);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references chats (id) on delete cascade,
  author text not null,
  content text not null,
  ai_run_id uuid,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chat_messages_author_valid'
  ) then
    alter table chat_messages
      add constraint chat_messages_author_valid check (author in ('user', 'assistant'));
  end if;
end $$;

create index if not exists chat_messages_chat_idx on chat_messages (chat_id, created_at);

create table if not exists ai_runs (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references chats (id) on delete cascade,
  user_message_id uuid not null references chat_messages (id),
  assistant_message_id uuid references chat_messages (id),
  smithers_run_id text,
  locale text not null,
  market text not null,
  usage jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  failed_at timestamptz
);

create unique index if not exists ai_runs_active_chat_key on ai_runs (chat_id) where finished_at is null and failed_at is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chat_messages_ai_run_id_fkey'
  ) then
    alter table chat_messages
      add constraint chat_messages_ai_run_id_fkey foreign key (ai_run_id) references ai_runs (id);
  end if;
end $$;

create table if not exists ai_run_events (
  id bigint generated always as identity primary key,
  run_id uuid not null references ai_runs (id) on delete cascade,
  seq integer not null,
  event jsonb not null,
  created_at timestamptz not null default now(),
  unique (run_id, seq)
);

create table if not exists chat_context_blocks (
  chat_id uuid not null references chats (id) on delete cascade,
  block_id text not null,
  kind text not null,
  content text not null,
  token_estimate integer not null,
  document_id text,
  char_start integer,
  char_end integer,
  provenance jsonb not null default '{}'::jsonb,
  created_by_run_id uuid not null references ai_runs (id),
  created_at timestamptz not null default now(),
  last_cited_run_id uuid references ai_runs (id),
  evicted_at timestamptz,
  primary key (chat_id, block_id)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chat_context_blocks_kind_valid'
  ) then
    alter table chat_context_blocks
      add constraint chat_context_blocks_kind_valid check (kind in ('document', 'memory'));
  end if;
end $$;

create unique index if not exists chat_context_blocks_active_document_range_key on chat_context_blocks (chat_id, document_id, (coalesce(char_start, -1)), (coalesce(char_end, -1))) where evicted_at is null and document_id is not null;

create table if not exists ai_observations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references ai_runs (id) on delete cascade,
  chat_id uuid not null references chats (id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ai_observations_run_idx on ai_observations (run_id);

create index if not exists ai_observations_chat_kind_idx on ai_observations (chat_id, kind);

create table if not exists user_memories (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  kind text not null,
  content text not null,
  source_message_id uuid references chat_messages (id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_memories_kind_valid'
  ) then
    alter table user_memories
      add constraint user_memories_kind_valid check (kind in ('profile', 'preference', 'instruction', 'fact', 'episode'));
  end if;
end $$;

create index if not exists user_memories_user_idx on user_memories (user_id) where deleted_at is null;

create table if not exists user_memory_revisions (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references user_memories (id) on delete cascade,
  action text not null,
  content_before text,
  content_after text,
  run_id uuid references ai_runs (id),
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_memory_revisions_action_valid'
  ) then
    alter table user_memory_revisions
      add constraint user_memory_revisions_action_valid check (action in ('created', 'updated', 'deleted', 'reverted'));
  end if;
end $$;

create index if not exists user_memory_revisions_memory_idx on user_memory_revisions (memory_id, created_at);
