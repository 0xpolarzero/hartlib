-- Export archives are retention objects in their own right. Snapshot every
-- canonical legal-hold scope at request acceptance so later product-pointer
-- changes cannot detach the private object from a hold before physical GC.

-- A pre-0047 request has no exact chat-message acceptance boundary. Neither
-- current rows nor timestamps can reconstruct it. Block concurrent request
-- mutation, fail closed while any such request can still generate or retains
-- an object, and require deployment to drain it before retrying this migration.
lock table export_requests in share row exclusive mode;

create or replace function brief_export_snapshot_identity_array_is_valid(
  authorization_snapshot jsonb,
  identity_key text
)
returns boolean
language sql
immutable
parallel safe
as $$
  select coalesce(
    authorization_snapshot ? identity_key
    and jsonb_typeof(authorization_snapshot->identity_key) = 'array'
    and not exists (
      select 1
      from jsonb_array_elements(
        case
          when jsonb_typeof(authorization_snapshot->identity_key) = 'array'
          then authorization_snapshot->identity_key
          else '[]'::jsonb
        end
      ) item
      where jsonb_typeof(item) <> 'string'
        or btrim(item #>> '{}') = ''
    ),
    false
  )
$$;

create or replace function brief_export_snapshot_envelope_is_valid(
  authorization_snapshot jsonb,
  requester_user_id text,
  scope_kind text,
  scope_id text
)
returns boolean
language plpgsql
immutable
as $$
begin
  if jsonb_typeof(authorization_snapshot->'version') is distinct from 'number'
     or authorization_snapshot->'version' is distinct from '1'::jsonb
     or jsonb_typeof(authorization_snapshot->'authorizedAt') is distinct from 'string'
     or nullif(btrim(authorization_snapshot->>'authorizedAt'), '') is null
     or jsonb_typeof(authorization_snapshot->'requesterUserId') is distinct from 'string'
     or authorization_snapshot->>'requesterUserId' is distinct from requester_user_id
     or jsonb_typeof(authorization_snapshot->'scopeKind') is distinct from 'string'
     or authorization_snapshot->>'scopeKind' is distinct from scope_kind
     or jsonb_typeof(authorization_snapshot->'scopeId') is distinct from 'string'
     or authorization_snapshot->>'scopeId' is distinct from scope_id
     or jsonb_typeof(authorization_snapshot->'role') is distinct from 'string'
     or nullif(btrim(authorization_snapshot->>'role'), '') is null then
    return false;
  end if;

  begin
    perform (authorization_snapshot->>'authorizedAt')::timestamptz;
  exception when others then
    return false;
  end;
  return true;
end;
$$;

do $$
begin
  if exists (
    select 1
    from export_requests
    where not brief_export_snapshot_identity_array_is_valid(
        authorization_snapshot,
        'chatMessageIds'
      )
      and (
        status in ('queued', 'running')
        or (object_key is not null and object_deleted_at is null)
      )
  ) then
    raise exception 'export message-snapshot migration requires legacy exports to be terminal and every legacy object to be physically deleted';
  end if;
end
$$;

create or replace function brief_export_hold_identity_snapshot(
  authorization_snapshot jsonb
)
returns jsonb
language sql
stable
as $$
  with snapshot_chat_ids(id) as (
    select value
    from jsonb_array_elements_text(
      coalesce(authorization_snapshot->'chatIds', '[]'::jsonb)
    ) as snapshot_chats(value)
  ),
  exact_chat_message_ids(id) as (
    select value
    from jsonb_array_elements_text(
      coalesce(authorization_snapshot->'chatMessageIds', '[]'::jsonb)
    ) as snapshot_messages(value)
  ),
  snapshot_issue_ids(id) as (
    select value
    from jsonb_array_elements_text(
      coalesce(authorization_snapshot->'issueIds', '[]'::jsonb)
    ) as snapshot_issues(value)
  ),
  chat_issue_ids(id) as (
    select documents.issue_id::text
    from chat_messages messages
    join assistant_message_sources sources
      on sources.assistant_message_id = messages.id
    join brief_document_versions versions
      on versions.id = sources.publisher_document_version_id
    join brief_documents documents on documents.id = versions.brief_document_id
    where messages.id::text in (select id from exact_chat_message_ids)
      and messages.chat_id::text in (select id from snapshot_chat_ids)
      and sources.publisher_document_version_id is not null
  ),
  hold_issue_ids(id) as (
    select id from snapshot_issue_ids
    union
    select id from chat_issue_ids
  ),
  hold_publisher_company_ids(id) as (
    select subscriptions.publisher_company_id::text
    from publisher_issues issues
    join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
    where issues.id::text in (select id from hold_issue_ids)
    union
    select authorization_snapshot->>'scopeId'
    where authorization_snapshot->>'scopeKind' = 'publisher_company'
      and nullif(authorization_snapshot->>'scopeId', '') is not null
  )
  select jsonb_build_object(
    'chatMessageIds',
    coalesce(
      (select jsonb_agg(id order by id) from exact_chat_message_ids),
      '[]'::jsonb
    ),
    'holdIssueIds',
    coalesce(
      (select jsonb_agg(id order by id) from hold_issue_ids),
      '[]'::jsonb
    ),
    'holdPublisherCompanyIds',
    coalesce(
      (select jsonb_agg(id order by id) from hold_publisher_company_ids),
      '[]'::jsonb
    )
  )
$$;

create or replace function brief_export_request_hold_scope_keys(
  requester_user_id text,
  authorization_snapshot jsonb
)
returns text[]
language sql
immutable
parallel safe
as $$
  select brief_normalize_legal_hold_scope_keys(
    array['user:' || requester_user_id]
    || coalesce(
      (
        select array_agg('client_company:' || value order by value)
        from jsonb_array_elements_text(
          coalesce(authorization_snapshot->'clientCompanyIds', '[]'::jsonb)
        ) as client_company_scopes(value)
      ),
      array[]::text[]
    )
    || coalesce(
      (
        select array_agg('issue:' || value order by value)
        from jsonb_array_elements_text(
          coalesce(authorization_snapshot->'holdIssueIds', '[]'::jsonb)
        ) as issue_scopes(value)
      ),
      array[]::text[]
    )
    || coalesce(
      (
        select array_agg('chat:' || value order by value)
        from jsonb_array_elements_text(
          coalesce(authorization_snapshot->'chatIds', '[]'::jsonb)
        ) as chat_scopes(value)
      ),
      array[]::text[]
    )
    || coalesce(
      (
        select array_agg('publisher_company:' || value order by value)
        from jsonb_array_elements_text(
          coalesce(authorization_snapshot->'holdPublisherCompanyIds', '[]'::jsonb)
        ) as publisher_company_scopes(value)
      ),
      array[]::text[]
    )
    || case
      when authorization_snapshot->>'scopeKind' = 'client_company'
       and nullif(authorization_snapshot->>'scopeId', '') is not null
      then array['client_company:' || (authorization_snapshot->>'scopeId')]
      else array[]::text[]
    end
  )
$$;

alter table export_requests
  add column if not exists hold_scope_keys text[];

-- The only legacy rows admitted by the preflight are terminal records with no
-- retained object. Give them an explicit empty content identity set. Never
-- infer an acceptance set from mutable current chat rows or created_at.
update export_requests
set authorization_snapshot = jsonb_set(
  authorization_snapshot,
  '{chatMessageIds}',
  '[]'::jsonb,
  true
)
where not brief_export_snapshot_identity_array_is_valid(
    authorization_snapshot,
    'chatMessageIds'
  );

-- Every identity consumed below must already have its exact JSON type and
-- value shape. In particular, jsonb_array_elements_text is never validation:
-- it would coerce numbers, nulls, and objects into text.
do $$
declare
  identity_key text;
begin
  foreach identity_key in array array[
    'clientCompanyIds',
    'accessIds',
    'issueIds',
    'documentIds',
    'chatIds',
    'chatMessageIds'
  ] loop
    if exists (
      select 1
      from export_requests
      where not brief_export_snapshot_identity_array_is_valid(
        authorization_snapshot,
        identity_key
      )
    ) then
      raise exception 'export authorization-snapshot migration requires every existing identity array to contain only nonempty strings';
    end if;
  end loop;

  if exists (
    select 1
    from export_requests
    where not brief_export_snapshot_envelope_is_valid(
      authorization_snapshot,
      requester_user_id,
      scope_kind,
      scope_id
    )
  ) then
    raise exception 'export authorization-snapshot migration requires every existing snapshot identity to match its request';
  end if;
end
$$;

update export_requests
set authorization_snapshot = authorization_snapshot
  || brief_export_hold_identity_snapshot(authorization_snapshot);

update export_requests
set hold_scope_keys = brief_export_request_hold_scope_keys(
  requester_user_id,
  authorization_snapshot
)
where hold_scope_keys is null;

alter table export_requests
  alter column hold_scope_keys set not null,
  alter column hold_scope_keys set default array[]::text[];

alter table export_requests
  drop constraint if exists export_requests_hold_scope_keys_normalized;
alter table export_requests
  add constraint export_requests_hold_scope_keys_normalized
  check (
    hold_scope_keys = brief_normalize_legal_hold_scope_keys(hold_scope_keys)
    and hold_scope_keys = brief_export_request_hold_scope_keys(
      requester_user_id,
      authorization_snapshot
    )
  );

create or replace function snapshot_export_request_hold_scopes()
returns trigger
language plpgsql
as $$
declare
  identity_key text;
begin
  if tg_op = 'INSERT' then
    foreach identity_key in array array[
      'clientCompanyIds',
      'accessIds',
      'issueIds',
      'documentIds',
      'chatIds',
      'chatMessageIds'
    ] loop
      if not brief_export_snapshot_identity_array_is_valid(
        new.authorization_snapshot,
        identity_key
      ) then
        raise exception 'export authorization snapshot requires explicit identity arrays containing only nonempty strings';
      end if;
    end loop;
    if new.authorization_snapshot->>'requesterUserId' is distinct from new.requester_user_id
       or new.authorization_snapshot->>'scopeKind' is distinct from new.scope_kind
       or new.authorization_snapshot->>'scopeId' is distinct from new.scope_id then
      raise exception 'export authorization snapshot identity does not match request';
    end if;
    if not brief_export_snapshot_envelope_is_valid(
      new.authorization_snapshot,
      new.requester_user_id,
      new.scope_kind,
      new.scope_id
    ) then
      raise exception 'export authorization snapshot requires version 1, a valid authorization time, and a nonempty role';
    end if;
    new.authorization_snapshot := new.authorization_snapshot
      || brief_export_hold_identity_snapshot(new.authorization_snapshot);
    new.hold_scope_keys := brief_export_request_hold_scope_keys(
      new.requester_user_id,
      new.authorization_snapshot
    );
    return new;
  end if;

  if new.id is distinct from old.id
     or new.requester_user_id is distinct from old.requester_user_id
     or new.scope_kind is distinct from old.scope_kind
     or new.scope_id is distinct from old.scope_id
     or new.authorization_snapshot is distinct from old.authorization_snapshot
     or new.hold_scope_keys is distinct from old.hold_scope_keys then
    raise exception 'export request authorization identity and hold scopes are immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists export_requests_hold_scope_snapshot on export_requests;
create trigger export_requests_hold_scope_snapshot
before insert or update on export_requests
for each row execute function snapshot_export_request_hold_scopes();

create index if not exists export_requests_hold_scope_keys_idx
  on export_requests using gin (hold_scope_keys);
