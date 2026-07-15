-- Serialize document insertion with publication and reject documents added to
-- an already-published issue. The row lock closes the upload/publish race even
-- for callers outside the API.

create or replace function protect_brief_document_insert()
returns trigger
language plpgsql
as $$
declare
  issue_status text;
begin
  select status into issue_status
  from publisher_issues
  where id = new.issue_id
  for update;

  if issue_status is null then
    raise exception 'brief document issue does not exist';
  end if;
  if issue_status = 'published' then
    raise exception 'published brief documents are immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists brief_documents_protect_published_insert on brief_documents;
create trigger brief_documents_protect_published_insert
before insert on brief_documents
for each row execute function protect_brief_document_insert();
