-- Canonical publisher/client platform state. This migration deliberately keeps
-- operational metadata separate from restricted file, extracted-text, and chat
-- content, and gives durable publication/delivery records database-level
-- immutability.

create table if not exists platform_users (
  id text primary key,
  primary_email text not null,
  display_name text not null,
  clerk_user_id text not null unique,
  mfa_required boolean not null default false,
  recovery_deleted_at timestamptz,
  purge_after timestamptz,
  legal_hold boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_users_id_nonempty check (btrim(id) <> ''),
  constraint platform_users_email_nonempty check (btrim(primary_email) <> ''),
  constraint platform_users_deletion_window check (
    (recovery_deleted_at is null and purge_after is null)
    or
    (recovery_deleted_at is not null and purge_after >= recovery_deleted_at + interval '180 days')
  )
);

create unique index if not exists platform_users_primary_email_key
  on platform_users (lower(primary_email));

create table if not exists publisher_companies (
  id uuid primary key default gen_random_uuid(),
  clerk_organization_id text unique,
  name text not null,
  delivery_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint publisher_companies_name_nonempty check (btrim(name) <> '')
);

alter table client_companies
  add column if not exists clerk_organization_id text,
  add column if not exists legal_name text,
  add column if not exists billing_country text,
  add column if not exists billing_address jsonb,
  add column if not exists vat_id text,
  add column if not exists stripe_customer_id text,
  add column if not exists deletion_requested_at timestamptz,
  add column if not exists recovery_deleted_at timestamptz,
  add column if not exists purge_after timestamptz,
  add column if not exists legal_hold boolean not null default false;

create unique index if not exists client_companies_clerk_organization_key
  on client_companies (clerk_organization_id)
  where clerk_organization_id is not null;

create unique index if not exists client_companies_stripe_customer_key
  on client_companies (stripe_customer_id)
  where stripe_customer_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'client_companies_deletion_window'
  ) then
    alter table client_companies
      add constraint client_companies_deletion_window check (
        (recovery_deleted_at is null and purge_after is null)
        or
        (recovery_deleted_at is not null and purge_after >= recovery_deleted_at + interval '180 days')
      );
  end if;
end
$$;

create table if not exists publisher_company_memberships (
  publisher_company_id uuid not null references publisher_companies (id) on delete cascade,
  user_id text not null,
  role text not null,
  invited_email text,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (publisher_company_id, user_id),
  constraint publisher_company_memberships_role check (role in ('admin', 'manager', 'member')),
  constraint publisher_company_memberships_user_nonempty check (btrim(user_id) <> '')
);

create index if not exists publisher_company_memberships_user_idx
  on publisher_company_memberships (user_id, publisher_company_id);

create table if not exists publisher_subscriptions (
  id uuid primary key default gen_random_uuid(),
  publisher_company_id uuid not null references publisher_companies (id) on delete restrict,
  name text not null,
  delivery_enabled boolean not null default true,
  created_by_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, publisher_company_id),
  constraint publisher_subscriptions_name_nonempty check (btrim(name) <> '')
);

create index if not exists publisher_subscriptions_company_idx
  on publisher_subscriptions (publisher_company_id, created_at);

create table if not exists publisher_membership_subscription_grants (
  publisher_company_id uuid not null,
  user_id text not null,
  subscription_id uuid not null,
  granted_by_user_id text not null,
  created_at timestamptz not null default now(),
  primary key (publisher_company_id, user_id, subscription_id),
  foreign key (publisher_company_id, user_id)
    references publisher_company_memberships (publisher_company_id, user_id) on delete cascade,
  foreign key (subscription_id, publisher_company_id)
    references publisher_subscriptions (id, publisher_company_id) on delete cascade
);

create table if not exists client_subscription_accesses (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references publisher_subscriptions (id) on delete restrict,
  client_company_id uuid not null references client_companies (id) on delete restrict,
  state text not null default 'invited',
  first_admin_email text not null,
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  subscribed_at timestamptz,
  delivery_end_at timestamptz,
  paused_at timestamptz,
  created_by_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subscription_id, client_company_id),
  unique (id, client_company_id),
  unique (id, subscription_id),
  constraint client_subscription_accesses_state check (state in ('invited', 'active', 'ending', 'paused')),
  constraint client_subscription_accesses_email_nonempty check (btrim(first_admin_email) <> ''),
  constraint client_subscription_accesses_acceptance_shape check (
    (state = 'invited' and accepted_at is null and subscribed_at is null and paused_at is null)
    or
    (state = 'active' and accepted_at is not null and subscribed_at is not null and paused_at is null and delivery_end_at is null)
    or
    (state = 'ending' and accepted_at is not null and subscribed_at is not null and paused_at is null and delivery_end_at is not null)
    or
    (state = 'paused' and accepted_at is not null and subscribed_at is not null and paused_at is not null and delivery_end_at is not null and paused_at >= delivery_end_at)
  ),
  constraint client_subscription_accesses_future_end check (
    delivery_end_at is null or subscribed_at is null or delivery_end_at >= subscribed_at
  )
);

create index if not exists client_subscription_accesses_client_idx
  on client_subscription_accesses (client_company_id, state, subscribed_at);

create index if not exists client_subscription_accesses_subscription_idx
  on client_subscription_accesses (subscription_id, state, subscribed_at);

create table if not exists client_employee_subscription_grants (
  access_id uuid not null,
  client_company_id uuid not null,
  user_id text not null,
  granted_by_user_id text not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by_user_id text,
  primary key (access_id, user_id),
  foreign key (access_id, client_company_id)
    references client_subscription_accesses (id, client_company_id) on delete cascade,
  foreign key (client_company_id, user_id)
    references client_company_memberships (company_id, user_id) on delete cascade,
  constraint client_employee_subscription_grants_revocation_shape check (
    (revoked_at is null and revoked_by_user_id is null)
    or
    (revoked_at is not null and revoked_by_user_id is not null)
  )
);

create index if not exists client_employee_subscription_grants_user_idx
  on client_employee_subscription_grants (client_company_id, user_id, access_id)
  where revoked_at is null;

create table if not exists publisher_issues (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references publisher_subscriptions (id) on delete restrict,
  title text not null,
  status text not null default 'draft',
  publication_at timestamptz,
  published_at timestamptz,
  historical boolean not null default false,
  indexing_status text not null default 'pending',
  indexing_error_code text,
  restricted_at timestamptz,
  restricted_by_user_id text,
  restricted_reason text,
  created_by_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, subscription_id),
  constraint publisher_issues_title_nonempty check (btrim(title) <> ''),
  constraint publisher_issues_status check (status in ('draft', 'scheduled', 'published')),
  constraint publisher_issues_indexing_status check (
    indexing_status in ('pending', 'extracting', 'indexing', 'ready', 'failed')
  ),
  constraint publisher_issues_publication_shape check (
    (status = 'draft' and published_at is null)
    or
    (status = 'scheduled' and publication_at is not null and published_at is null)
    or
    (status = 'published' and publication_at is not null and published_at is not null)
  ),
  constraint publisher_issues_indexing_error_shape check (
    (indexing_status = 'failed' and indexing_error_code is not null)
    or
    (indexing_status <> 'failed' and indexing_error_code is null)
  ),
  constraint publisher_issues_restriction_shape check (
    (restricted_at is null and restricted_by_user_id is null and restricted_reason is null)
    or
    (restricted_at is not null and restricted_by_user_id is not null and btrim(restricted_reason) <> '')
  )
);

create index if not exists publisher_issues_subscription_idx
  on publisher_issues (subscription_id, publication_at desc, created_at desc);

create index if not exists publisher_issues_scheduled_idx
  on publisher_issues (publication_at, id)
  where status = 'scheduled';

create table if not exists brief_documents (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references publisher_issues (id) on delete cascade,
  title text not null,
  original_file_name text not null,
  object_key text not null unique,
  media_type text not null,
  byte_size bigint not null,
  sha256_hex text not null,
  current_version_id uuid,
  upload_completed_at timestamptz not null,
  deleted_at timestamptz,
  created_by_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, issue_id),
  constraint brief_documents_title_nonempty check (btrim(title) <> ''),
  constraint brief_documents_pdf_only check (media_type = 'application/pdf'),
  constraint brief_documents_positive_size check (byte_size > 0),
  constraint brief_documents_sha256_hex check (sha256_hex ~ '^[0-9a-f]{64}$')
);

create index if not exists brief_documents_issue_idx
  on brief_documents (issue_id, created_at);

create index if not exists brief_documents_title_trgm_idx
  on brief_documents using gin (title gin_trgm_ops);

create table if not exists brief_document_versions (
  id uuid primary key default gen_random_uuid(),
  brief_document_id uuid not null references brief_documents (id) on delete cascade,
  content_hash text not null,
  language text not null,
  canonical_text text not null,
  text_char_count integer not null,
  page_ranges jsonb not null,
  search_vector tsvector generated always as (
    setweight(to_tsvector(language_to_regconfig(language), canonical_text), 'B')
  ) stored,
  created_by_job_id uuid references jobs (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (brief_document_id, content_hash),
  unique (id, brief_document_id),
  constraint brief_document_versions_text_nonempty check (btrim(canonical_text) <> ''),
  constraint brief_document_versions_char_count check (text_char_count = char_length(canonical_text)),
  constraint brief_document_versions_page_ranges_array check (jsonb_typeof(page_ranges) = 'array')
);

create index if not exists brief_document_versions_search_idx
  on brief_document_versions using gin (search_vector);

alter table brief_documents
  drop constraint if exists brief_documents_current_version_id_fkey;

alter table brief_documents
  add constraint brief_documents_current_version_id_fkey
  foreign key (current_version_id, id)
  references brief_document_versions (id, brief_document_id)
  deferrable initially deferred;

create table if not exists issue_deliveries (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null,
  subscription_id uuid not null,
  access_id uuid not null,
  client_company_id uuid not null,
  delivered_at timestamptz not null default now(),
  historical boolean not null,
  created_by_job_id uuid references jobs (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (issue_id, client_company_id),
  foreign key (issue_id, subscription_id)
    references publisher_issues (id, subscription_id) on delete restrict,
  foreign key (access_id, subscription_id)
    references client_subscription_accesses (id, subscription_id) on delete restrict,
  foreign key (access_id, client_company_id)
    references client_subscription_accesses (id, client_company_id) on delete restrict
);

create index if not exists issue_deliveries_client_archive_idx
  on issue_deliveries (client_company_id, delivered_at desc, issue_id);

create unique index if not exists chats_id_company_key on chats (id, company_id);

create table if not exists chat_subscription_sources (
  chat_id uuid not null references chats (id) on delete cascade,
  access_id uuid not null,
  client_company_id uuid not null,
  subscription_id uuid not null,
  selected_at timestamptz not null default now(),
  primary key (chat_id, access_id),
  foreign key (chat_id, client_company_id)
    references chats (id, company_id) on delete cascade,
  foreign key (access_id, client_company_id)
    references client_subscription_accesses (id, client_company_id) on delete restrict,
  foreign key (access_id, subscription_id)
    references client_subscription_accesses (id, subscription_id) on delete restrict
);

alter table chats
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by_user_id text,
  add column if not exists purge_after timestamptz,
  add column if not exists legal_hold boolean not null default false;

-- The one-chat-per-user index existed solely for the single-chat demo API.
-- Production users have separate private/shared chats and may belong to more
-- than one company, so identity is scoped by the chat UUID instead.
drop index if exists chats_user_key;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chats_deletion_shape'
  ) then
    alter table chats
      add constraint chats_deletion_shape check (
        (deleted_at is null and deleted_by_user_id is null and purge_after is null)
        or
        (
          deleted_at is not null
          and deleted_by_user_id is not null
          and purge_after >= deleted_at
          and purge_after <= deleted_at + interval '30 days'
        )
      );
  end if;
end
$$;

create index if not exists chats_purge_idx
  on chats (purge_after, id)
  where deleted_at is not null and legal_hold = false;

create table if not exists notification_preferences (
  client_company_id uuid not null,
  user_id text not null,
  email_issue_published boolean not null default false,
  email_delivery_reminders boolean not null default true,
  email_usage_limits boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (client_company_id, user_id),
  foreign key (client_company_id, user_id)
    references client_company_memberships (company_id, user_id) on delete cascade
);

create table if not exists platform_notifications (
  id uuid primary key default gen_random_uuid(),
  client_company_id uuid not null,
  user_id text not null,
  kind text not null,
  issue_id uuid references publisher_issues (id) on delete restrict,
  access_id uuid references client_subscription_accesses (id) on delete restrict,
  billing_event_id uuid,
  deduplication_key text not null unique,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  foreign key (client_company_id, user_id)
    references client_company_memberships (company_id, user_id) on delete cascade,
  constraint platform_notifications_kind check (
    kind in (
      'issue_published',
      'delivery_end_scheduled',
      'delivery_ends_in_7_days',
      'delivery_ended',
      'usage_approaching_limit',
      'usage_limit_reached'
    )
  )
);

create index if not exists platform_notifications_inbox_idx
  on platform_notifications (client_company_id, user_id, created_at desc);

create table if not exists email_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references platform_notifications (id) on delete cascade,
  recipient_email text not null,
  provider text not null default 'resend',
  provider_message_id text,
  status text not null default 'queued',
  attempts integer not null default 0,
  last_error_code text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (notification_id, recipient_email),
  constraint email_notification_deliveries_status check (
    status in ('queued', 'sending', 'sent', 'failed')
  ),
  constraint email_notification_deliveries_no_attachment check (provider = 'resend')
);

create table if not exists client_ai_billing_accounts (
  client_company_id uuid primary key references client_companies (id) on delete restrict,
  plan_tier text,
  stripe_subscription_id text unique,
  stripe_price_id text,
  status text not null default 'inactive',
  current_period_start timestamptz,
  current_period_end timestamptz,
  pending_downgrade_tier text,
  company_monthly_limit bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_ai_billing_accounts_plan check (
    plan_tier is null or plan_tier in ('light', 'team', 'intensive')
  ),
  constraint client_ai_billing_accounts_pending_plan check (
    pending_downgrade_tier is null or pending_downgrade_tier in ('light', 'team', 'intensive')
  ),
  constraint client_ai_billing_accounts_status check (
    status in ('inactive', 'trialing', 'active', 'past_due', 'paused', 'cancelled')
  ),
  constraint client_ai_billing_accounts_period check (
    (current_period_start is null and current_period_end is null)
    or
    (current_period_start is not null and current_period_end > current_period_start)
  ),
  constraint client_ai_billing_accounts_limit check (
    company_monthly_limit is null or company_monthly_limit >= 0
  )
);

create table if not exists client_employee_ai_limits (
  client_company_id uuid not null,
  user_id text not null,
  monthly_limit bigint,
  updated_by_user_id text not null,
  updated_at timestamptz not null default now(),
  primary key (client_company_id, user_id),
  foreign key (client_company_id, user_id)
    references client_company_memberships (company_id, user_id) on delete cascade,
  constraint client_employee_ai_limits_nonnegative check (monthly_limit is null or monthly_limit >= 0)
);

create table if not exists client_credit_lots (
  id uuid primary key default gen_random_uuid(),
  client_company_id uuid not null references client_companies (id) on delete restrict,
  kind text not null,
  credits_granted bigint not null,
  credits_remaining bigint not null,
  available_at timestamptz not null,
  expires_at timestamptz not null,
  stripe_payment_id text,
  created_at timestamptz not null default now(),
  unique (client_company_id, stripe_payment_id),
  constraint client_credit_lots_kind check (kind in ('monthly', 'additional')),
  constraint client_credit_lots_amount check (
    credits_granted > 0 and credits_remaining >= 0 and credits_remaining <= credits_granted
  ),
  constraint client_credit_lots_expiry check (
    expires_at > available_at
    and (
      kind <> 'additional'
      or expires_at = available_at + interval '12 months'
    )
  )
);

create index if not exists client_credit_lots_consumption_idx
  on client_credit_lots (client_company_id, kind, expires_at, created_at)
  where credits_remaining > 0;

create table if not exists client_credit_usage (
  id uuid primary key default gen_random_uuid(),
  client_company_id uuid not null references client_companies (id) on delete restrict,
  user_id text not null,
  ai_run_id uuid not null references ai_runs (id) on delete restrict,
  credits bigint not null,
  calculation_version text not null,
  calculation_inputs jsonb not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  constraint client_credit_usage_positive check (credits > 0),
  constraint client_credit_usage_inputs_object check (jsonb_typeof(calculation_inputs) = 'object')
);

create index if not exists client_credit_usage_company_period_idx
  on client_credit_usage (client_company_id, created_at, user_id);

create table if not exists client_credit_usage_allocations (
  usage_id uuid not null references client_credit_usage (id) on delete restrict,
  credit_lot_id uuid not null references client_credit_lots (id) on delete restrict,
  credits bigint not null,
  primary key (usage_id, credit_lot_id),
  constraint client_credit_usage_allocations_positive check (credits > 0)
);

create table if not exists stripe_webhook_events (
  stripe_event_id text primary key,
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error_code text,
  constraint stripe_webhook_events_payload_object check (jsonb_typeof(payload) = 'object')
);

create table if not exists export_requests (
  id uuid primary key default gen_random_uuid(),
  requester_user_id text not null,
  scope_kind text not null,
  scope_id text not null,
  status text not null default 'queued',
  object_key text,
  expires_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint export_requests_scope check (
    scope_kind in ('user_chats', 'publisher_company', 'client_company')
  ),
  constraint export_requests_status check (status in ('queued', 'running', 'completed', 'failed')),
  constraint export_requests_result_shape check (
    (status = 'completed' and object_key is not null and completed_at is not null and error_code is null)
    or
    (status = 'failed' and object_key is null and completed_at is not null and error_code is not null)
    or
    (status in ('queued', 'running') and object_key is null and completed_at is null and error_code is null)
  )
);

create table if not exists company_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  client_company_id uuid not null references client_companies (id) on delete restrict,
  requested_by_user_id text not null,
  reason text not null,
  status text not null default 'requested',
  requested_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by_user_id text,
  constraint company_deletion_requests_reason_nonempty check (btrim(reason) <> ''),
  constraint company_deletion_requests_status check (
    status in ('requested', 'approved', 'rejected', 'completed')
  )
);

create table if not exists legal_holds (
  id uuid primary key default gen_random_uuid(),
  scope_kind text not null,
  scope_id text not null,
  reason text not null,
  placed_by_user_id text not null,
  placed_at timestamptz not null default now(),
  released_by_user_id text,
  released_at timestamptz,
  constraint legal_holds_scope check (
    scope_kind in ('user', 'client_company', 'publisher_company', 'chat', 'issue')
  ),
  constraint legal_holds_reason_nonempty check (btrim(reason) <> ''),
  constraint legal_holds_release_shape check (
    (released_at is null and released_by_user_id is null)
    or
    (released_at is not null and released_by_user_id is not null and released_at >= placed_at)
  )
);

create unique index if not exists legal_holds_active_scope_key
  on legal_holds (scope_kind, scope_id)
  where released_at is null;

create table if not exists platform_admins (
  user_id text primary key,
  role text not null,
  created_at timestamptz not null default now(),
  constraint platform_admins_role check (role in ('admin', 'support', 'security', 'legal')),
  constraint platform_admins_user_nonempty check (btrim(user_id) <> '')
);

create table if not exists restricted_support_grants (
  id uuid primary key default gen_random_uuid(),
  actor_user_id text not null references platform_admins (user_id) on delete restrict,
  reason text not null,
  scope_kind text not null,
  scope_id text not null,
  publisher_company_id uuid references publisher_companies (id) on delete restrict,
  client_company_id uuid references client_companies (id) on delete restrict,
  affected_user_id text,
  customer_approval_reference text,
  approval_skipped_reason text,
  granted_by_user_id text not null references platform_admins (user_id) on delete restrict,
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by_user_id text references platform_admins (user_id) on delete restrict,
  constraint restricted_support_grants_reason_nonempty check (btrim(reason) <> ''),
  constraint restricted_support_grants_scope check (
    scope_kind in ('publisher_file', 'publisher_text', 'client_chat', 'client_memory')
  ),
  constraint restricted_support_grants_approval check (
    customer_approval_reference is not null
    or btrim(approval_skipped_reason) <> ''
  ),
  constraint restricted_support_grants_expiry check (
    expires_at > granted_at and expires_at <= granted_at + interval '8 hours'
  ),
  constraint restricted_support_grants_revocation check (
    (revoked_at is null and revoked_by_user_id is null)
    or
    (revoked_at is not null and revoked_by_user_id is not null and revoked_at >= granted_at)
  )
);

create index if not exists restricted_support_grants_active_idx
  on restricted_support_grants (actor_user_id, scope_kind, scope_id, expires_at)
  where revoked_at is null;

create table if not exists restricted_support_access_log (
  id bigint generated always as identity primary key,
  grant_id uuid not null references restricted_support_grants (id) on delete restrict,
  actor_user_id text not null,
  reason text not null,
  scope_kind text not null,
  scope_id text not null,
  publisher_company_id uuid references publisher_companies (id) on delete restrict,
  client_company_id uuid references client_companies (id) on delete restrict,
  affected_user_id text,
  customer_approval_reference text,
  approval_skipped_reason text,
  previous_hash bytea,
  entry_hash bytea not null,
  accessed_at timestamptz not null default now(),
  review_status text not null default 'pending',
  reviewed_by_user_id text,
  reviewed_at timestamptz,
  constraint restricted_support_access_reason_nonempty check (btrim(reason) <> ''),
  constraint restricted_support_access_scope check (
    scope_kind in ('publisher_file', 'publisher_text', 'client_chat', 'client_memory')
  ),
  constraint restricted_support_access_approval check (
    customer_approval_reference is not null
    or btrim(approval_skipped_reason) <> ''
  ),
  constraint restricted_support_access_review_status check (
    review_status in ('pending', 'approved', 'flagged')
  )
);

create index if not exists restricted_support_access_retention_idx
  on restricted_support_access_log (accessed_at, id);

create table if not exists restricted_support_access_reviews (
  id uuid primary key default gen_random_uuid(),
  access_log_id bigint not null references restricted_support_access_log (id) on delete restrict,
  reviewer_user_id text not null,
  decision text not null,
  notes text not null,
  reviewed_at timestamptz not null default now(),
  unique (access_log_id, reviewer_user_id),
  constraint restricted_support_access_reviews_decision check (
    decision in ('approved', 'flagged')
  ),
  constraint restricted_support_access_reviews_notes_nonempty check (btrim(notes) <> '')
);

create or replace function append_restricted_support_access_hash()
returns trigger
language plpgsql
as $$
declare
  prior_hash bytea;
begin
  perform pg_advisory_xact_lock(hashtext('brief:restricted-support-access-log'));
  select entry_hash into prior_hash
  from restricted_support_access_log
  order by id desc
  limit 1;

  new.previous_hash := prior_hash;
  new.entry_hash := digest(
    coalesce(encode(prior_hash, 'hex'), '') || '|' ||
    new.grant_id::text || '|' ||
    new.actor_user_id || '|' ||
    new.reason || '|' ||
    new.scope_kind || '|' ||
    new.scope_id || '|' ||
    new.accessed_at::text,
    'sha256'
  );
  return new;
end;
$$;

drop trigger if exists restricted_support_access_hash on restricted_support_access_log;
create trigger restricted_support_access_hash
before insert on restricted_support_access_log
for each row execute function append_restricted_support_access_hash();

create or replace function reject_restricted_support_access_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'restricted support access log is append-only';
end;
$$;

drop trigger if exists restricted_support_access_no_update on restricted_support_access_log;
create trigger restricted_support_access_no_update
before update or delete on restricted_support_access_log
for each row execute function reject_restricted_support_access_mutation();

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
  ) then
    raise exception 'published issues are immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists publisher_issues_protect_published on publisher_issues;
create trigger publisher_issues_protect_published
before update on publisher_issues
for each row execute function protect_published_issue_state();

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
    or new.deleted_at is distinct from old.deleted_at
  ) then
    raise exception 'published brief documents are immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists brief_documents_protect_published on brief_documents;
create trigger brief_documents_protect_published
before update on brief_documents
for each row execute function protect_published_brief_document();

create or replace function reject_brief_document_version_mutation()
returns trigger
language plpgsql
as $$
declare
  issue_status text;
begin
  if tg_op = 'UPDATE' then
    raise exception 'brief document versions are immutable';
  end if;

  select issues.status into issue_status
  from brief_documents documents
  join publisher_issues issues on issues.id = documents.issue_id
  where documents.id = old.brief_document_id;

  if issue_status is not null then
    raise exception 'brief document versions are immutable';
  end if;
  return old;
end;
$$;

drop trigger if exists brief_document_versions_no_update on brief_document_versions;
create trigger brief_document_versions_no_update
before update or delete on brief_document_versions
for each row execute function reject_brief_document_version_mutation();

create or replace function enforce_issue_publishable()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'published' and old.status <> 'published' then
    if not exists (
      select 1
      from brief_documents documents
      where documents.issue_id = new.id
        and documents.deleted_at is null
        and documents.upload_completed_at is not null
    ) then
      raise exception 'an issue requires at least one stored PDF before publication';
    end if;
    new.published_at := coalesce(new.published_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists publisher_issues_enforce_publishable on publisher_issues;
create trigger publisher_issues_enforce_publishable
before update of status on publisher_issues
for each row execute function enforce_issue_publishable();

create or replace function protect_last_company_admin()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from client_companies company where company.id = old.company_id
  ) then
    return old;
  end if;
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin') then
    if not exists (
      select 1 from client_company_memberships membership
      where membership.company_id = old.company_id
        and membership.user_id <> old.user_id
        and membership.role = 'admin'
    ) then
      raise exception 'each client company must retain at least one admin';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists client_company_memberships_last_admin on client_company_memberships;
create trigger client_company_memberships_last_admin
before update of role or delete on client_company_memberships
for each row execute function protect_last_company_admin();

create or replace function protect_last_publisher_admin()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from publisher_companies company where company.id = old.publisher_company_id
  ) then
    return old;
  end if;
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin') then
    if not exists (
      select 1 from publisher_company_memberships membership
      where membership.publisher_company_id = old.publisher_company_id
        and membership.user_id <> old.user_id
        and membership.role = 'admin'
    ) then
      raise exception 'each publisher company must retain at least one admin';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists publisher_company_memberships_last_admin on publisher_company_memberships;
create trigger publisher_company_memberships_last_admin
before update of role or delete on publisher_company_memberships
for each row execute function protect_last_publisher_admin();

create or replace function validate_issue_delivery()
returns trigger
language plpgsql
as $$
declare
  issue_row publisher_issues%rowtype;
  access_row client_subscription_accesses%rowtype;
begin
  select * into issue_row from publisher_issues where id = new.issue_id;
  select * into access_row from client_subscription_accesses where id = new.access_id;

  if issue_row.status <> 'published' or issue_row.published_at > new.delivered_at then
    raise exception 'only already-published issues can be delivered';
  end if;
  if new.historical is distinct from issue_row.historical then
    raise exception 'delivery historical flag must match its issue';
  end if;
  if access_row.state not in ('active', 'ending') then
    raise exception 'issue delivery requires current delivery access';
  end if;
  if access_row.state = 'ending' and access_row.delivery_end_at <= new.delivered_at then
    raise exception 'issue delivery is disabled at the delivery end time';
  end if;
  return new;
end;
$$;

drop trigger if exists issue_deliveries_validate on issue_deliveries;
create trigger issue_deliveries_validate
before insert on issue_deliveries
for each row execute function validate_issue_delivery();

create or replace function prevent_published_issue_delete()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'published' then
    raise exception 'published issues cannot be deleted';
  end if;
  return old;
end;
$$;

drop trigger if exists publisher_issues_no_published_delete on publisher_issues;
create trigger publisher_issues_no_published_delete
before delete on publisher_issues
for each row execute function prevent_published_issue_delete();
