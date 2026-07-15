-- Checkout processing ownership is a durable database-clock lease.  The
-- token changes only when a stale attempt is replaced and is required for
-- phase-B claim/finalization, preventing an old worker from completing a
-- newer replay after the provider boundary.

alter table client_ai_checkout_requests
  add column if not exists lease_token uuid;

update client_ai_checkout_requests
set lease_token = gen_random_uuid()
where lease_token is null;

alter table client_ai_checkout_requests
  alter column lease_token set not null,
  alter column lease_token set default gen_random_uuid();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'client_ai_checkout_requests_lease_shape'
  ) then
    alter table client_ai_checkout_requests add constraint
      client_ai_checkout_requests_lease_shape check (lease_token is not null);
  end if;
end
$$;
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
       or new.attempts is distinct from old.attempts
       or new.lease_token is distinct from old.lease_token
       or new.lease_expires_at is distinct from old.lease_expires_at
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
     or new.attempts > old.attempts + 1
     or (new.attempts = old.attempts and new.lease_token is distinct from old.lease_token)
     or (new.attempts = old.attempts + 1 and new.lease_token is not distinct from old.lease_token) then
    raise exception 'AI Checkout request identity is immutable';
  end if;
  return new;
end;
$$;
