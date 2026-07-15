-- Legal-hold placement and retention deletion must have one serialization
-- point per affected product scope. Retention rows also snapshot the
-- canonical scopes and immutable external identities needed to keep applying
-- a later hold after mutable product pointers have moved or disappeared.

create or replace function brief_normalize_legal_hold_scope_keys(keys text[])
returns text[]
language sql
immutable
parallel safe
as $$
  select coalesce(array_agg(distinct key order by key), array[]::text[])
  from unnest(coalesce(keys, array[]::text[])) as scope_keys(key)
  where key is not null and btrim(key) <> ''
$$;

create or replace function brief_has_active_legal_hold(keys text[])
returns boolean
language sql
stable
parallel safe
as $$
  select exists (
    select 1
    from legal_holds holds
    where holds.released_at is null
      and (holds.scope_kind || ':' || holds.scope_id) = any(
        brief_normalize_legal_hold_scope_keys(keys)
      )
  )
$$;

create or replace function brief_has_embedded_legal_hold(keys text[])
returns boolean
language sql
stable
parallel safe
as $$
  select
    exists (
      select 1 from platform_users users
      where users.legal_hold and ('user:' || users.id) = any(keys)
    )
    or exists (
      select 1 from client_companies companies
      where companies.legal_hold
        and ('client_company:' || companies.id::text) = any(keys)
    )
    or exists (
      select 1 from chats
      where chats.legal_hold and ('chat:' || chats.id::text) = any(keys)
    )
    or exists (
      select 1 from brief_documents documents
      where documents.legal_hold
        and ('issue:' || documents.issue_id::text) = any(keys)
    )
$$;

create or replace function brief_resolve_legal_hold_scope_keys(
  requested_scope_kind text,
  requested_scope_id text,
  actor_user_id text default null,
  publisher_company_id uuid default null,
  client_company_id uuid default null,
  affected_user_id text default null
)
returns text[]
language plpgsql
stable
as $$
declare
  keys text[] := array[]::text[];
  related_keys text[];
  resolved_user_id text;
  resolved_client_company_id uuid;
  resolved_publisher_company_id uuid;
  resolved_issue_id uuid;
  resolved_chat_id uuid;
  snapshot jsonb;
begin
  if actor_user_id is not null and btrim(actor_user_id) <> '' then
    keys := array_append(keys, 'user:' || actor_user_id);
  end if;
  if affected_user_id is not null and btrim(affected_user_id) <> '' then
    keys := array_append(keys, 'user:' || affected_user_id);
  end if;
  if client_company_id is not null then
    keys := array_append(keys, 'client_company:' || client_company_id::text);
  end if;
  if publisher_company_id is not null then
    keys := array_append(keys, 'publisher_company:' || publisher_company_id::text);
  end if;

  if requested_scope_kind = 'user' then
    keys := array_append(keys, 'user:' || requested_scope_id);
  elsif requested_scope_kind = 'client_company' then
    keys := array_append(keys, 'client_company:' || requested_scope_id);
  elsif requested_scope_kind = 'publisher_company' then
    keys := array_append(keys, 'publisher_company:' || requested_scope_id);
  elsif requested_scope_kind in ('chat', 'client_chat') then
    keys := array_append(keys, 'chat:' || requested_scope_id);
    select chats.company_id, chats.user_id
      into resolved_client_company_id, resolved_user_id
    from chats
    where chats.id::text = requested_scope_id;
  elsif requested_scope_kind in ('issue', 'publisher_issue') then
    keys := array_append(keys, 'issue:' || requested_scope_id);
    select subscriptions.publisher_company_id
      into resolved_publisher_company_id
    from publisher_issues issues
    join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
    where issues.id::text = requested_scope_id;
  elsif requested_scope_kind in ('brief_document', 'publisher_file') then
    select documents.issue_id, subscriptions.publisher_company_id
      into resolved_issue_id, resolved_publisher_company_id
    from brief_documents documents
    join publisher_issues issues on issues.id = documents.issue_id
    join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
    where documents.id::text = requested_scope_id;
  elsif requested_scope_kind = 'publisher_text' then
    select documents.issue_id, subscriptions.publisher_company_id
      into resolved_issue_id, resolved_publisher_company_id
    from brief_document_versions versions
    join brief_documents documents on documents.id = versions.brief_document_id
    join publisher_issues issues on issues.id = documents.issue_id
    join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
    where versions.id::text = requested_scope_id;
  elsif requested_scope_kind = 'client_memory' then
    select memories.user_id into resolved_user_id
    from user_memories memories
    where memories.id::text = requested_scope_id;
  elsif requested_scope_kind = 'publisher_subscription' then
    select subscriptions.publisher_company_id
      into resolved_publisher_company_id
    from publisher_subscriptions subscriptions
    where subscriptions.id::text = requested_scope_id;
  elsif requested_scope_kind = 'client_subscription_access' then
    select accesses.client_company_id, subscriptions.publisher_company_id
      into resolved_client_company_id, resolved_publisher_company_id
    from client_subscription_accesses accesses
    join publisher_subscriptions subscriptions on subscriptions.id = accesses.subscription_id
    where accesses.id::text = requested_scope_id;
  elsif requested_scope_kind = 'ai_usage_request' then
    select requests.client_company_id, requests.user_id
      into resolved_client_company_id, resolved_user_id
    from client_ai_usage_requests requests
    where requests.id::text = requested_scope_id;
  elsif requested_scope_kind = 'company_deletion_request' then
    select requests.client_company_id, requests.requested_by_user_id
      into resolved_client_company_id, resolved_user_id
    from company_deletion_requests requests
    where requests.id::text = requested_scope_id;
  elsif requested_scope_kind = 'support_access_log' then
    select access.hold_scope_keys into related_keys
    from restricted_support_access_log access
    where access.id::text = requested_scope_id;
    keys := keys || coalesce(related_keys, array[]::text[]);
  elsif requested_scope_kind = 'export_request' then
    select requests.requester_user_id, requests.authorization_snapshot
      into resolved_user_id, snapshot
    from export_requests requests
    where requests.id::text = requested_scope_id;
    if snapshot is not null then
      select coalesce(array_agg('client_company:' || value), array[]::text[])
        into related_keys
      from jsonb_array_elements_text(
        coalesce(snapshot->'clientCompanyIds', '[]'::jsonb)
      ) as scope_values(value);
      keys := keys || related_keys;
      select coalesce(array_agg('issue:' || value), array[]::text[])
        into related_keys
      from jsonb_array_elements_text(
        coalesce(snapshot->'issueIds', '[]'::jsonb)
      ) as scope_values(value);
      keys := keys || related_keys;
      select coalesce(array_agg('chat:' || value), array[]::text[])
        into related_keys
      from jsonb_array_elements_text(
        coalesce(snapshot->'chatIds', '[]'::jsonb)
      ) as scope_values(value);
      keys := keys || related_keys;
      if snapshot->>'scopeKind' = 'publisher_company'
         and nullif(snapshot->>'scopeId', '') is not null then
        keys := array_append(keys, 'publisher_company:' || (snapshot->>'scopeId'));
      end if;
    end if;
  end if;

  if resolved_user_id is not null and btrim(resolved_user_id) <> '' then
    keys := array_append(keys, 'user:' || resolved_user_id);
  end if;
  if resolved_client_company_id is not null then
    keys := array_append(keys, 'client_company:' || resolved_client_company_id::text);
  end if;
  if resolved_publisher_company_id is not null then
    keys := array_append(keys, 'publisher_company:' || resolved_publisher_company_id::text);
  end if;
  if resolved_issue_id is not null then
    keys := array_append(keys, 'issue:' || resolved_issue_id::text);
  end if;
  if resolved_chat_id is not null then
    keys := array_append(keys, 'chat:' || resolved_chat_id::text);
  end if;

  return brief_normalize_legal_hold_scope_keys(keys);
end;
$$;

alter table restricted_support_grants
  add column if not exists hold_scope_keys text[];

update restricted_support_grants grants
set hold_scope_keys = brief_resolve_legal_hold_scope_keys(
  grants.scope_kind,
  grants.scope_id,
  grants.actor_user_id,
  grants.publisher_company_id,
  grants.client_company_id,
  grants.affected_user_id
)
where grants.hold_scope_keys is null;

alter table restricted_support_grants
  alter column hold_scope_keys set not null,
  alter column hold_scope_keys set default array[]::text[];

alter table restricted_support_grants
  drop constraint if exists restricted_support_grants_hold_scope_keys_normalized;
alter table restricted_support_grants
  add constraint restricted_support_grants_hold_scope_keys_normalized
  check (hold_scope_keys = brief_normalize_legal_hold_scope_keys(hold_scope_keys));

create or replace function snapshot_restricted_support_grant_hold_scopes()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if new.actor_user_id is distinct from old.actor_user_id
       or new.reason is distinct from old.reason
       or new.scope_kind is distinct from old.scope_kind
       or new.scope_id is distinct from old.scope_id
       or new.publisher_company_id is distinct from old.publisher_company_id
       or new.client_company_id is distinct from old.client_company_id
       or new.affected_user_id is distinct from old.affected_user_id
       or new.customer_approval_reference is distinct from old.customer_approval_reference
       or new.approval_skipped_reason is distinct from old.approval_skipped_reason
       or new.granted_by_user_id is distinct from old.granted_by_user_id
       or new.granted_at is distinct from old.granted_at
       or new.expires_at is distinct from old.expires_at
       or new.hold_scope_keys is distinct from old.hold_scope_keys then
      raise exception 'restricted support grant identity and hold scopes are immutable';
    end if;
    return new;
  end if;

  new.hold_scope_keys := brief_resolve_legal_hold_scope_keys(
    new.scope_kind,
    new.scope_id,
    new.actor_user_id,
    new.publisher_company_id,
    new.client_company_id,
    new.affected_user_id
  );
  return new;
end;
$$;

drop trigger if exists restricted_support_grants_hold_scope_snapshot
  on restricted_support_grants;
create trigger restricted_support_grants_hold_scope_snapshot
before insert or update on restricted_support_grants
for each row execute function snapshot_restricted_support_grant_hold_scopes();

alter table restricted_support_access_log
  add column if not exists hold_scope_keys text[];

update restricted_support_access_log access
set hold_scope_keys = coalesce(
  (select grants.hold_scope_keys from restricted_support_grants grants where grants.id = access.grant_id),
  brief_resolve_legal_hold_scope_keys(
    access.scope_kind,
    access.scope_id,
    access.actor_user_id,
    access.publisher_company_id,
    access.client_company_id,
    access.affected_user_id
  )
)
where access.hold_scope_keys is null;

alter table restricted_support_access_log
  alter column hold_scope_keys set not null,
  alter column hold_scope_keys set default array[]::text[];

alter table restricted_support_access_log
  drop constraint if exists restricted_support_access_log_hold_scope_keys_normalized;
alter table restricted_support_access_log
  add constraint restricted_support_access_log_hold_scope_keys_normalized
  check (hold_scope_keys = brief_normalize_legal_hold_scope_keys(hold_scope_keys));

create or replace function snapshot_restricted_support_access_hold_scopes()
returns trigger
language plpgsql
as $$
begin
  select grants.hold_scope_keys into new.hold_scope_keys
  from restricted_support_grants grants
  where grants.id = new.grant_id;
  if new.hold_scope_keys is null then
    raise exception 'restricted support access requires a snapshotted grant scope';
  end if;
  return new;
end;
$$;

drop trigger if exists restricted_support_access_hold_scope_snapshot
  on restricted_support_access_log;
create trigger restricted_support_access_hold_scope_snapshot
before insert on restricted_support_access_log
for each row execute function snapshot_restricted_support_access_hold_scopes();

alter table platform_authorization_audit_log
  add column if not exists hold_scope_keys text[];

update platform_authorization_audit_log audit
set hold_scope_keys = brief_resolve_legal_hold_scope_keys(
  audit.scope_kind,
  audit.scope_id,
  audit.actor_user_id,
  null,
  null,
  null
)
where audit.hold_scope_keys is null;

alter table platform_authorization_audit_log
  alter column hold_scope_keys set not null,
  alter column hold_scope_keys set default array[]::text[];

alter table platform_authorization_audit_log
  drop constraint if exists platform_authorization_audit_hold_scope_keys_normalized;
alter table platform_authorization_audit_log
  add constraint platform_authorization_audit_hold_scope_keys_normalized
  check (hold_scope_keys = brief_normalize_legal_hold_scope_keys(hold_scope_keys));

create or replace function snapshot_platform_authorization_audit_hold_scopes()
returns trigger
language plpgsql
as $$
begin
  new.hold_scope_keys := brief_resolve_legal_hold_scope_keys(
    new.scope_kind,
    new.scope_id,
    new.actor_user_id,
    null,
    null,
    null
  );
  return new;
end;
$$;

drop trigger if exists platform_authorization_audit_hold_scope_snapshot
  on platform_authorization_audit_log;
create trigger platform_authorization_audit_hold_scope_snapshot
before insert on platform_authorization_audit_log
for each row execute function snapshot_platform_authorization_audit_hold_scopes();

create index if not exists restricted_support_grants_hold_scope_keys_idx
  on restricted_support_grants using gin (hold_scope_keys);
create index if not exists restricted_support_access_hold_scope_keys_idx
  on restricted_support_access_log using gin (hold_scope_keys);
create index if not exists platform_authorization_audit_hold_scope_keys_idx
  on platform_authorization_audit_log using gin (hold_scope_keys);

create or replace function serialize_legal_hold_scope_change()
returns trigger
language plpgsql
as $$
declare
  scope_key text;
begin
  if tg_op = 'DELETE' then
    scope_key := old.scope_kind || ':' || old.scope_id;
    perform pg_advisory_xact_lock(
      hashtextextended('brief:legal-hold:' || scope_key, 0)
    );
    raise exception 'legal hold history is append-only; release the hold instead';
  end if;

  if tg_op = 'UPDATE' then
    if new.scope_kind is distinct from old.scope_kind
       or new.scope_id is distinct from old.scope_id
       or new.reason is distinct from old.reason
       or new.placed_by_user_id is distinct from old.placed_by_user_id
       or new.placed_at is distinct from old.placed_at then
      raise exception 'legal hold placement identity is immutable';
    end if;
    if old.released_at is not null
       and (
         new.released_at is distinct from old.released_at
         or new.released_by_user_id is distinct from old.released_by_user_id
       ) then
      raise exception 'released legal holds are immutable';
    end if;
  end if;

  scope_key := new.scope_kind || ':' || new.scope_id;
  perform pg_advisory_xact_lock(
    hashtextextended('brief:legal-hold:' || scope_key, 0)
  );
  return new;
end;
$$;

drop trigger if exists legal_holds_serialize_scope_change on legal_holds;
create trigger legal_holds_serialize_scope_change
before insert or update or delete on legal_holds
for each row execute function serialize_legal_hold_scope_change();

alter table legal_holds
  drop constraint if exists legal_holds_scope_id_nonempty;
alter table legal_holds
  add constraint legal_holds_scope_id_nonempty check (btrim(scope_id) <> '');

alter table legal_holds
  drop constraint if exists legal_holds_actor_ids_nonempty;
alter table legal_holds
  add constraint legal_holds_actor_ids_nonempty check (
    btrim(placed_by_user_id) <> ''
    and (released_by_user_id is null or btrim(released_by_user_id) <> '')
  );

-- Generated columns make all external identities used by retention mapping a
-- pure, immutable projection of the already immutable signed event.
alter table stripe_webhook_events
  add column if not exists stripe_customer_id text generated always as (
    case
      when jsonb_typeof(payload #> '{data,object,customer}') = 'string'
        then nullif(payload #>> '{data,object,customer}', '')
      when jsonb_typeof(payload #> '{data,object,customer}') = 'object'
        then nullif(payload #>> '{data,object,customer,id}', '')
      else null
    end
  ) stored,
  add column if not exists stripe_subscription_id text generated always as (
    case
      when event_type like 'customer.subscription.%'
        then nullif(payload #>> '{data,object,id}', '')
      when event_type like 'subscription_schedule.%'
        then case
          when jsonb_typeof(payload #> '{data,object,subscription}') = 'string'
            then nullif(payload #>> '{data,object,subscription}', '')
          when jsonb_typeof(payload #> '{data,object,subscription}') = 'object'
            then nullif(payload #>> '{data,object,subscription,id}', '')
          else null
        end
      when event_type = 'invoice.paid'
        then case
          when jsonb_typeof(payload #> '{data,object,parent,subscription_details,subscription}') = 'string'
            then nullif(payload #>> '{data,object,parent,subscription_details,subscription}', '')
          when jsonb_typeof(payload #> '{data,object,parent,subscription_details,subscription}') = 'object'
            then nullif(payload #>> '{data,object,parent,subscription_details,subscription,id}', '')
          else null
        end
      when event_type like 'checkout.session.%'
        then case
          when jsonb_typeof(payload #> '{data,object,subscription}') = 'string'
            then nullif(payload #>> '{data,object,subscription}', '')
          when jsonb_typeof(payload #> '{data,object,subscription}') = 'object'
            then nullif(payload #>> '{data,object,subscription,id}', '')
          else null
        end
      else null
    end
  ) stored,
  add column if not exists stripe_schedule_id text generated always as (
    case when event_type like 'subscription_schedule.%'
      then nullif(payload #>> '{data,object,id}', '') else null end
  ) stored,
  add column if not exists stripe_payment_id text generated always as (
    case
      when event_type = 'invoice.paid' or event_type like 'checkout.session.%'
        then case
          when jsonb_typeof(payload #> '{data,object,payment_intent}') = 'string'
            then nullif(payload #>> '{data,object,payment_intent}', '')
          when jsonb_typeof(payload #> '{data,object,payment_intent}') = 'object'
            then nullif(payload #>> '{data,object,payment_intent,id}', '')
          else null
        end
      else null
    end
  ) stored,
  add column if not exists stripe_invoice_id text generated always as (
    case when event_type = 'invoice.paid'
      then nullif(payload #>> '{data,object,id}', '') else null end
  ) stored,
  add column if not exists stripe_checkout_session_id text generated always as (
    case when event_type like 'checkout.session.%'
      then nullif(payload #>> '{data,object,id}', '') else null end
  ) stored;

alter table stripe_webhook_events
  drop constraint if exists stripe_webhook_events_retention_identity_lengths;
alter table stripe_webhook_events
  add constraint stripe_webhook_events_retention_identity_lengths check (
    (stripe_customer_id is null or length(stripe_customer_id) between 1 and 255)
    and (stripe_subscription_id is null or length(stripe_subscription_id) between 1 and 255)
    and (stripe_schedule_id is null or length(stripe_schedule_id) between 1 and 255)
    and (stripe_payment_id is null or length(stripe_payment_id) between 1 and 255)
    and (stripe_invoice_id is null or length(stripe_invoice_id) between 1 and 255)
    and (stripe_checkout_session_id is null or length(stripe_checkout_session_id) between 1 and 255)
  );

create index if not exists stripe_webhook_events_customer_retention_idx
  on stripe_webhook_events (stripe_customer_id, retained_until)
  where stripe_customer_id is not null;
create index if not exists stripe_webhook_events_subscription_retention_idx
  on stripe_webhook_events (stripe_subscription_id, retained_until)
  where stripe_subscription_id is not null;
create index if not exists stripe_webhook_events_schedule_retention_idx
  on stripe_webhook_events (stripe_schedule_id, retained_until)
  where stripe_schedule_id is not null;
create index if not exists stripe_webhook_events_payment_retention_idx
  on stripe_webhook_events (stripe_payment_id, retained_until)
  where stripe_payment_id is not null;
create index if not exists stripe_webhook_events_invoice_retention_idx
  on stripe_webhook_events (stripe_invoice_id, retained_until)
  where stripe_invoice_id is not null;

create index if not exists client_ai_plan_change_requests_customer_retention_idx
  on client_ai_plan_change_requests (stripe_customer_id)
  where stripe_customer_id is not null;
create index if not exists client_ai_plan_change_requests_subscription_retention_idx
  on client_ai_plan_change_requests (stripe_subscription_id)
  where stripe_subscription_id is not null;
create index if not exists client_ai_plan_change_requests_operation_retention_idx
  on client_ai_plan_change_requests (external_operation_id)
  where external_operation_id is not null;

create or replace function brief_stripe_event_legal_hold_scope_keys(
  customer_id text,
  subscription_id text,
  schedule_id text,
  payment_id text,
  invoice_id text
)
returns text[]
language sql
stable
as $$
  with mapped_companies as (
    select companies.id as company_id
    from client_companies companies
    where customer_id is not null and companies.stripe_customer_id = customer_id
    union
    select accounts.client_company_id
    from client_ai_billing_accounts accounts
    where (subscription_id is not null and accounts.stripe_subscription_id = subscription_id)
       or (schedule_id is not null and accounts.pending_downgrade_schedule_id = schedule_id)
    union
    select lots.client_company_id
    from client_credit_lots lots
    where (payment_id is not null and lots.stripe_payment_id = 'payment:' || payment_id)
       or (invoice_id is not null and lots.stripe_payment_id = 'invoice:' || invoice_id)
    union
    select requests.client_company_id
    from client_ai_plan_change_requests requests
    where (customer_id is not null and requests.stripe_customer_id = customer_id)
       or (subscription_id is not null and requests.stripe_subscription_id = subscription_id)
       or (schedule_id is not null and requests.external_operation_id = schedule_id)
       or (payment_id is not null and requests.external_operation_id = payment_id)
       or (invoice_id is not null and requests.external_operation_id = invoice_id)
  ), mapped_requesters as (
    select requests.requested_by_user_id as user_id
    from client_ai_plan_change_requests requests
    where (customer_id is not null and requests.stripe_customer_id = customer_id)
       or (subscription_id is not null and requests.stripe_subscription_id = subscription_id)
       or (schedule_id is not null and requests.external_operation_id = schedule_id)
       or (payment_id is not null and requests.external_operation_id = payment_id)
       or (invoice_id is not null and requests.external_operation_id = invoice_id)
  ), scope_keys as (
    select 'client_company:' || company_id::text as scope_key from mapped_companies
    union
    select 'user:' || user_id from mapped_requesters
  )
  select brief_normalize_legal_hold_scope_keys(
    coalesce(array_agg(scope_key), array[]::text[])
  )
  from scope_keys
$$;
