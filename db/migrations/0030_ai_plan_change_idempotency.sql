alter table client_ai_billing_accounts
  add column if not exists pending_downgrade_schedule_id text;

alter table client_ai_billing_accounts
  drop constraint if exists client_ai_billing_accounts_pending_plan_shape;
alter table client_ai_billing_accounts
  add constraint client_ai_billing_accounts_pending_plan_shape check (
    (pending_downgrade_tier is null and pending_downgrade_schedule_id is null)
    or
    (
      pending_downgrade_tier is not null
      and pending_downgrade_schedule_id is not null
      and btrim(pending_downgrade_schedule_id) <> ''
      and length(pending_downgrade_schedule_id) <= 255
      and status in ('active', 'trialing')
      and (
        (plan_tier = 'team' and pending_downgrade_tier = 'light')
        or
        (
          plan_tier = 'intensive'
          and pending_downgrade_tier in ('light', 'team')
        )
      )
    )
  );

create unique index if not exists client_ai_billing_accounts_pending_schedule_unique
  on client_ai_billing_accounts (pending_downgrade_schedule_id)
  where pending_downgrade_schedule_id is not null;

create table if not exists client_ai_plan_change_requests (
  id uuid primary key default gen_random_uuid(),
  client_company_id uuid not null references client_companies (id) on delete restrict,
  idempotency_key text not null,
  requested_by_user_id text not null,
  authorization_request_id uuid not null,
  authorization_session_id text not null,
  previous_tier text not null,
  target_tier text not null,
  stripe_customer_id text,
  stripe_subscription_id text,
  previous_price_id text,
  target_price_id text,
  current_period_end timestamptz,
  status text not null,
  outcome text,
  effective_at timestamptz,
  external_operation_id text,
  error_code text,
  attempts integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  retained_until timestamptz not null default (now() + interval '10 years'),
  unique (client_company_id, idempotency_key),
  constraint client_ai_plan_change_requests_key_nonempty
    check (
      length(idempotency_key) between 8 and 180
      and idempotency_key ~ '^[A-Za-z0-9:_-]+$'
    ),
  constraint client_ai_plan_change_requests_authorization_session
    check (length(authorization_session_id) between 1 and 255),
  constraint client_ai_plan_change_requests_requester
    check (length(requested_by_user_id) between 1 and 255),
  constraint client_ai_plan_change_requests_tiers
    check (
      previous_tier in ('light', 'team', 'intensive')
      and target_tier in ('light', 'team', 'intensive')
    ),
  constraint client_ai_plan_change_requests_status
    check (status in ('processing', 'succeeded', 'failed')),
  constraint client_ai_plan_change_requests_attempts
    check (attempts > 0),
  constraint client_ai_plan_change_requests_error_code
    check (error_code is null or error_code ~ '^[a-z0-9_]{1,200}$'),
  constraint client_ai_plan_change_requests_outcome
    check (outcome is null or outcome in ('unchanged', 'upgraded', 'downgrade_scheduled')),
  constraint client_ai_plan_change_requests_shape
    check (
      (
        status = 'processing' and outcome is null and effective_at is null
        and external_operation_id is null and error_code is null
      )
      or
      (
        status = 'failed' and outcome is null and effective_at is null
        and external_operation_id is null and error_code is not null
      )
      or
      (
        status = 'succeeded'
        and outcome is not null
        and error_code is null
        and (
          (
            outcome = 'unchanged' and previous_tier = target_tier
            and effective_at is null and external_operation_id is null
          )
          or
          (
            outcome = 'upgraded'
            and (
              (previous_tier = 'light' and target_tier in ('team', 'intensive'))
              or (previous_tier = 'team' and target_tier = 'intensive')
            )
            and effective_at is not null and external_operation_id is not null
            and length(external_operation_id) <= 255
            and btrim(external_operation_id) <> ''
          )
          or
          (
            outcome = 'downgrade_scheduled'
            and (
              (previous_tier = 'team' and target_tier = 'light')
              or (previous_tier = 'intensive' and target_tier in ('light', 'team'))
            )
            and effective_at is not null and external_operation_id is not null
            and length(external_operation_id) <= 255
            and btrim(external_operation_id) <> ''
          )
        )
      )
    ),
  constraint client_ai_plan_change_requests_gateway_snapshot check (
    (
      previous_tier = target_tier
      and stripe_customer_id is null
      and stripe_subscription_id is null
      and previous_price_id is null
      and target_price_id is null
      and current_period_end is null
    )
    or
    (
      previous_tier <> target_tier
      and stripe_customer_id is not null and btrim(stripe_customer_id) <> ''
      and length(stripe_customer_id) <= 255
      and stripe_subscription_id is not null and btrim(stripe_subscription_id) <> ''
      and length(stripe_subscription_id) <= 255
      and previous_price_id is not null and btrim(previous_price_id) <> ''
      and length(previous_price_id) <= 255
      and target_price_id is not null and btrim(target_price_id) <> ''
      and length(target_price_id) <= 255
      and previous_price_id <> target_price_id
      and current_period_end is not null
    )
  )
);

create unique index if not exists client_ai_plan_change_requests_one_processing_company
  on client_ai_plan_change_requests (client_company_id)
  where status = 'processing';

create index if not exists client_ai_plan_change_requests_company_created
  on client_ai_plan_change_requests (client_company_id, created_at desc);

create or replace function protect_ai_plan_change_request_identity()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'succeeded' then
    raise exception 'succeeded AI plan-change requests are immutable';
  end if;
  if old.client_company_id is distinct from new.client_company_id
     or old.idempotency_key is distinct from new.idempotency_key
     or old.requested_by_user_id is distinct from new.requested_by_user_id
     or old.authorization_request_id is distinct from new.authorization_request_id
     or old.authorization_session_id is distinct from new.authorization_session_id
     or old.previous_tier is distinct from new.previous_tier
     or old.target_tier is distinct from new.target_tier
     or old.stripe_customer_id is distinct from new.stripe_customer_id
     or old.stripe_subscription_id is distinct from new.stripe_subscription_id
     or old.previous_price_id is distinct from new.previous_price_id
     or old.target_price_id is distinct from new.target_price_id
     or old.current_period_end is distinct from new.current_period_end
     or old.created_at is distinct from new.created_at
     or new.attempts < old.attempts
     or new.attempts > old.attempts + 1 then
    raise exception 'AI plan-change request identity is immutable';
  end if;
  return new;
end;
$$;

create trigger client_ai_plan_change_requests_identity_immutable
before update on client_ai_plan_change_requests
for each row execute function protect_ai_plan_change_request_identity();

create trigger client_ai_plan_change_requests_retention
before insert or update on client_ai_plan_change_requests
for each row execute function maintain_billing_account_retention();

create trigger client_ai_plan_change_requests_ten_year_retention
before delete on client_ai_plan_change_requests
for each row execute function protect_ten_year_accounting_record();
