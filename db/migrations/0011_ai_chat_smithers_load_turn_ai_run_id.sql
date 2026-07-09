alter table if exists ai_chat_load_turn
  add column if not exists ai_run_id text;
