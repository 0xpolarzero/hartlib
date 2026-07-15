-- Durable Stripe Checkout capabilities.  A client idempotency key identifies
-- one immutable, company-scoped purchase request.  The row is retained with
-- accounting data so a provider commit followed by response loss can be
-- reconciled by replaying the exact Stripe idempotency key.

create table if not exists client_ai_checkout_requests (
  id uuid primary key default gen_random_uuid(),
  client_company_id uuid not null references client_companies (id) on delete restrict,
  idempotency_key text not null,
  requested_by_user_id text not null,
  authorization_request_id uuid not null,
  authorization_session_id text not null,
  authorization_organization_id text,
  authorization_mode text not null,
  authorization_mfa_verified boolean not null,
  kind text not null,
  plan_tier text,
  credits bigint,
  stripe_customer_id text not null,
  stripe_price_id text not null,
  success_url text not null,
  cancel_url text not null,
  stripe_operation_key text not null,
  stripe_checkout_session_id text,
  checkout_url text,
  status text not null default 'processing',
  error_code text,
  attempts integer not null default 1,
  lease_expires_at timestamptz not null default (now() + interval '5 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  retained_until timestamptz not null default (now() + interval '10 years'),
  unique (client_company_id, idempotency_key),
  constraint client_ai_checkout_requests_key_nonempty check (
    length(idempotency_key) between 8 and 180
    and idempotency_key ~ '^[A-Za-z0-9:_-]+$'
  ),
  constraint client_ai_checkout_requests_requester check (
    btrim(requested_by_user_id) <> '' and length(requested_by_user_id) <= 255
  ),
  constraint client_ai_checkout_requests_session check (
    length(authorization_session_id) between 1 and 255
  ),
  constraint client_ai_checkout_requests_org check (
    authorization_organization_id is null or length(authorization_organization_id) between 1 and 255
  ),
  constraint client_ai_checkout_requests_mode check (authorization_mode in ('demo', 'clerk')),
  constraint client_ai_checkout_requests_kind check (kind in ('monthly', 'additional')),
  constraint client_ai_checkout_requests_purchase_shape check (
    (kind = 'monthly' and plan_tier in ('light', 'team', 'intensive') and credits is null)
    or
    (kind = 'additional' and plan_tier is null and credits > 0 and credits <= 10000000)
  ),
  constraint client_ai_checkout_requests_external_ids check (
    length(stripe_customer_id) between 1 and 255
    and length(stripe_price_id) between 1 and 255
    and length(stripe_operation_key) between 1 and 255
    and stripe_operation_key ~ '^brief-checkout:[A-Za-z0-9:_-]{1,230}:session$'
  ),
  constraint client_ai_checkout_requests_urls check (
    success_url ~ '^https://[^[:space:]]+$'
    and cancel_url ~ '^https://[^[:space:]]+$'
  ),
  constraint client_ai_checkout_requests_status check (status in ('processing', 'succeeded', 'failed')),
  constraint client_ai_checkout_requests_attempts check (attempts > 0),
  constraint client_ai_checkout_requests_error_code check (
    error_code is null or error_code in ('request_abandoned')
  ),
  constraint client_ai_checkout_requests_checkout_shape check (
    (
      status = 'processing'
      and stripe_checkout_session_id is null
      and checkout_url is null
      and error_code is null
    )
    or
    (
      status = 'failed'
      and stripe_checkout_session_id is null
      and checkout_url is null
      and error_code = 'request_abandoned'
    )
    or
    (
      status = 'succeeded'
      and stripe_checkout_session_id ~ '^cs_[A-Za-z0-9_]{1,251}$'
      and checkout_url ~ '^https://[^[:space:]]+$'
      and error_code is null
    )
  )
);

create unique index if not exists client_ai_checkout_requests_one_processing_company
  on client_ai_checkout_requests (client_company_id)
  where status = 'processing';

create index if not exists client_ai_checkout_requests_company_created
  on client_ai_checkout_requests (client_company_id, created_at desc);

create index if not exists client_ai_checkout_requests_customer_retention
  on client_ai_checkout_requests (stripe_customer_id);

create index if not exists client_ai_checkout_requests_session_retention
  on client_ai_checkout_requests (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

create or replace function protect_ai_checkout_request_identity()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'succeeded' and (
       new.status <> 'succeeded'
       or new.stripe_checkout_session_id is distinct from old.stripe_checkout_session_id
       or new.checkout_url is distinct from old.checkout_url
       or new.error_code is distinct from old.error_code
     ) then
    raise exception 'succeeded AI Checkout requests are terminal';
  end if;
  if old.client_company_id is distinct from new.client_company_id
     or old.idempotency_key is distinct from new.idempotency_key
     or old.requested_by_user_id is distinct from new.requested_by_user_id
     or old.authorization_request_id is distinct from new.authorization_request_id
     or old.authorization_session_id is distinct from new.authorization_session_id
     or old.authorization_organization_id is distinct from new.authorization_organization_id
     or old.authorization_mode is distinct from new.authorization_mode
     or old.authorization_mfa_verified is distinct from new.authorization_mfa_verified
     or old.kind is distinct from new.kind
     or old.plan_tier is distinct from new.plan_tier
     or old.credits is distinct from new.credits
     or old.stripe_customer_id is distinct from new.stripe_customer_id
     or old.stripe_price_id is distinct from new.stripe_price_id
     or old.success_url is distinct from new.success_url
     or old.cancel_url is distinct from new.cancel_url
     or old.stripe_operation_key is distinct from new.stripe_operation_key
     or old.created_at is distinct from new.created_at
     or new.attempts < old.attempts
     or new.attempts > old.attempts + 1 then
    raise exception 'AI Checkout request identity is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists client_ai_checkout_requests_identity_immutable
  on client_ai_checkout_requests;
create trigger client_ai_checkout_requests_identity_immutable
before update on client_ai_checkout_requests
for each row execute function protect_ai_checkout_request_identity();

drop trigger if exists client_ai_checkout_requests_retention on client_ai_checkout_requests;
create trigger client_ai_checkout_requests_retention
before insert or update on client_ai_checkout_requests
for each row execute function maintain_billing_account_retention();

drop trigger if exists client_ai_checkout_requests_ten_year_retention
  on client_ai_checkout_requests;
create trigger client_ai_checkout_requests_ten_year_retention
before delete on client_ai_checkout_requests
for each row execute function protect_ten_year_accounting_record();
