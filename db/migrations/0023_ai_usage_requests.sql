-- Employee requests for additional AI usage are operational metadata. They do
-- not grant credits; an admin resolves them separately through billing/limits.

create table if not exists client_ai_usage_requests (
  id uuid primary key default gen_random_uuid(),
  client_company_id uuid not null,
  user_id text not null,
  requested_credits bigint not null,
  reason text not null,
  status text not null default 'pending',
  resolved_by_user_id text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (client_company_id, user_id)
    references client_company_memberships (company_id, user_id) on delete cascade,
  constraint client_ai_usage_requests_credits check (requested_credits > 0),
  constraint client_ai_usage_requests_reason check (
    btrim(reason) <> '' and char_length(reason) <= 500
  ),
  constraint client_ai_usage_requests_status check (status in ('pending', 'approved', 'denied')),
  constraint client_ai_usage_requests_resolution_shape check (
    (status = 'pending' and resolved_by_user_id is null and resolved_at is null)
    or
    (status <> 'pending' and resolved_by_user_id is not null and resolved_at is not null)
  )
);

create unique index if not exists client_ai_usage_requests_one_pending_per_user
  on client_ai_usage_requests (client_company_id, user_id)
  where status = 'pending';

create index if not exists client_ai_usage_requests_admin_queue
  on client_ai_usage_requests (client_company_id, status, created_at, id);
