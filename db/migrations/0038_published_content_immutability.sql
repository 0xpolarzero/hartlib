-- A published issue is a durable distribution record. Restriction and
-- asynchronous indexing metadata remain operationally mutable, but neither
-- the issue's publisher-authored identity nor any stored brief-document
-- provenance may be rewritten after publication.

create or replace function protect_published_issue_state()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'published' and (
    new.subscription_id is distinct from old.subscription_id
    or new.title is distinct from old.title
    or new.status is distinct from old.status
    or new.publication_at is distinct from old.publication_at
    or new.published_at is distinct from old.published_at
    or new.historical is distinct from old.historical
    or new.created_by_user_id is distinct from old.created_by_user_id
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'published issues are immutable';
  end if;
  return new;
end;
$$;

create or replace function protect_published_brief_document()
returns trigger
language plpgsql
as $$
declare
  issue_status text;
begin
  select status into issue_status from publisher_issues where id = old.issue_id;
  if issue_status = 'published' and (
    new.issue_id is distinct from old.issue_id
    or new.title is distinct from old.title
    or new.original_file_name is distinct from old.original_file_name
    or new.object_key is distinct from old.object_key
    or new.media_type is distinct from old.media_type
    or new.byte_size is distinct from old.byte_size
    or new.sha256_hex is distinct from old.sha256_hex
    or new.upload_completed_at is distinct from old.upload_completed_at
    or new.language is distinct from old.language
    or new.deleted_at is distinct from old.deleted_at
    or new.deleted_by_user_id is distinct from old.deleted_by_user_id
    or new.purge_after is distinct from old.purge_after
    or new.created_by_user_id is distinct from old.created_by_user_id
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'published brief documents are immutable';
  end if;
  return new;
end;
$$;
