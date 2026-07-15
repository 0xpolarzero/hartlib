-- Saved citation rows are referenced by assistant-message ID plus source key.
-- Keep the complete source tuple immutable so that a later update cannot make
-- an existing citation observation resolve to different evidence.

create or replace function assistant_message_source_identity_digest(
  p_assistant_message_id uuid,
  p_source_key text,
  p_kind text,
  p_locator jsonb,
  p_document_version_id text,
  p_publisher_document_version_id uuid,
  p_message_id uuid,
  p_memory_revision_id uuid,
  p_display_label text,
  p_public_provenance jsonb
)
returns text
language sql
immutable
as $$
  select encode(
    digest(
      convert_to(
        jsonb_build_object(
          'assistantMessageId', p_assistant_message_id,
          'sourceKey', p_source_key,
          'kind', p_kind,
          'locator', p_locator,
          'documentVersionId', p_document_version_id,
          'publisherDocumentVersionId', p_publisher_document_version_id,
          'messageId', p_message_id,
          'memoryRevisionId', p_memory_revision_id,
          'displayLabel', p_display_label,
          'publicProvenance', p_public_provenance
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

alter table assistant_message_sources
  add column if not exists source_identity_digest text;

update assistant_message_sources
set source_identity_digest = assistant_message_source_identity_digest(
  assistant_message_id,
  source_key,
  kind,
  locator,
  document_version_id,
  publisher_document_version_id,
  message_id,
  memory_revision_id,
  display_label,
  public_provenance
)
where source_identity_digest is null;

alter table assistant_message_sources
  alter column source_identity_digest set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'assistant_message_sources_identity_digest_shape'
  ) then
    alter table assistant_message_sources
      add constraint assistant_message_sources_identity_digest_shape
      check (source_identity_digest ~ '^[0-9a-f]{64}$');
  end if;
end
$$;

create or replace function enforce_assistant_message_source_identity_immutable()
returns trigger
language plpgsql
as $$
declare
  expected_digest text;
begin
  if tg_op = 'UPDATE' then
    raise exception 'assistant message source identity is immutable'
      using errcode = '23514',
            constraint = 'assistant_message_sources_identity_immutable';
  end if;

  if tg_op = 'DELETE' and exists (
    select 1
    from chat_messages
    where id = old.assistant_message_id
  ) then
    raise exception 'assistant message sources cannot be deleted independently'
      using errcode = '23514',
            constraint = 'assistant_message_sources_delete_immutable';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  expected_digest := assistant_message_source_identity_digest(
    new.assistant_message_id,
    new.source_key,
    new.kind,
    new.locator,
    new.document_version_id,
    new.publisher_document_version_id,
    new.message_id,
    new.memory_revision_id,
    new.display_label,
    new.public_provenance
  );
  new.source_identity_digest := expected_digest;
  return new;
end;
$$;

drop trigger if exists assistant_message_sources_identity_immutable
  on assistant_message_sources;
create trigger assistant_message_sources_identity_immutable
before insert or update or delete on assistant_message_sources
for each row execute function enforce_assistant_message_source_identity_immutable();

create or replace function assistant_message_source_use_identity_digest(
  p_assistant_message_id uuid,
  p_source_key text,
  p_consumer_task_id text,
  p_topic_id text,
  p_rendered_token_count integer,
  p_context_order integer,
  p_ranges jsonb
)
returns text
language sql
immutable
as $$
  select encode(
    digest(
      convert_to(
        jsonb_build_object(
          'assistantMessageId', p_assistant_message_id,
          'sourceKey', p_source_key,
          'consumerTaskId', p_consumer_task_id,
          'topicId', p_topic_id,
          'renderedTokenCount', p_rendered_token_count,
          'contextOrder', p_context_order,
          'ranges', p_ranges
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

alter table assistant_message_source_uses
  add column if not exists source_use_identity_digest text;

update assistant_message_source_uses
set source_use_identity_digest = assistant_message_source_use_identity_digest(
  assistant_message_id,
  source_key,
  consumer_task_id,
  topic_id,
  rendered_token_count,
  context_order,
  ranges
)
where source_use_identity_digest is null;

alter table assistant_message_source_uses
  alter column source_use_identity_digest set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'assistant_message_source_uses_identity_digest_shape'
  ) then
    alter table assistant_message_source_uses
      add constraint assistant_message_source_uses_identity_digest_shape
      check (source_use_identity_digest ~ '^[0-9a-f]{64}$');
  end if;
end
$$;

create or replace function enforce_assistant_message_source_use_identity_immutable()
returns trigger
language plpgsql
as $$
declare
  expected_digest text;
begin
  if tg_op = 'UPDATE' then
    raise exception 'assistant message source use identity is immutable'
      using errcode = '23514',
            constraint = 'assistant_message_source_uses_identity_immutable';
  end if;

  if tg_op = 'DELETE' and exists (
    select 1
    from chat_messages
    where id = old.assistant_message_id
  ) then
    raise exception 'assistant message source uses cannot be deleted independently'
      using errcode = '23514',
            constraint = 'assistant_message_source_uses_delete_immutable';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  expected_digest := assistant_message_source_use_identity_digest(
    new.assistant_message_id,
    new.source_key,
    new.consumer_task_id,
    new.topic_id,
    new.rendered_token_count,
    new.context_order,
    new.ranges
  );
  new.source_use_identity_digest := expected_digest;
  return new;
end;
$$;

drop trigger if exists assistant_message_source_uses_identity_immutable
  on assistant_message_source_uses;
create trigger assistant_message_source_uses_identity_immutable
before insert or update or delete on assistant_message_source_uses
for each row execute function enforce_assistant_message_source_use_identity_immutable();
