create temporary table if not exists chats_user_key_duplicate_chats (
  id uuid primary key
) on commit drop;

truncate table chats_user_key_duplicate_chats;

insert into chats_user_key_duplicate_chats (id)
select id
from (
  select
    id,
    row_number() over (partition by user_id order by created_at, id) as chat_rank
  from chats
) ranked_chats
where chat_rank > 1;

update chat_messages
set ai_run_id = null
where chat_id in (
  select id from chats_user_key_duplicate_chats
)
or ai_run_id in (
  select ai_runs.id
  from ai_runs
  join chats_user_key_duplicate_chats on chats_user_key_duplicate_chats.id = ai_runs.chat_id
);

update user_memory_revisions
set run_id = null
where run_id in (
  select ai_runs.id
  from ai_runs
  join chats_user_key_duplicate_chats on chats_user_key_duplicate_chats.id = ai_runs.chat_id
);

update user_memories
set source_message_id = null
where source_message_id in (
  select chat_messages.id
  from chat_messages
  join chats_user_key_duplicate_chats on chats_user_key_duplicate_chats.id = chat_messages.chat_id
);

update chat_context_blocks
set last_cited_run_id = null
where last_cited_run_id in (
  select ai_runs.id
  from ai_runs
  join chats_user_key_duplicate_chats on chats_user_key_duplicate_chats.id = ai_runs.chat_id
);

delete from ai_run_events
where run_id in (
  select ai_runs.id
  from ai_runs
  join chats_user_key_duplicate_chats on chats_user_key_duplicate_chats.id = ai_runs.chat_id
);

delete from chat_context_blocks
where chat_id in (
  select id from chats_user_key_duplicate_chats
)
or created_by_run_id in (
  select ai_runs.id
  from ai_runs
  join chats_user_key_duplicate_chats on chats_user_key_duplicate_chats.id = ai_runs.chat_id
);

delete from ai_observations
where chat_id in (
  select id from chats_user_key_duplicate_chats
)
or run_id in (
  select ai_runs.id
  from ai_runs
  join chats_user_key_duplicate_chats on chats_user_key_duplicate_chats.id = ai_runs.chat_id
);

delete from ai_runs
where chat_id in (
  select id from chats_user_key_duplicate_chats
);

delete from chat_messages
where chat_id in (
  select id from chats_user_key_duplicate_chats
);

delete from chats
where id in (
  select id from chats_user_key_duplicate_chats
);

create unique index if not exists chats_user_key on chats (user_id);
