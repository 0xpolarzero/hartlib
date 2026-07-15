alter table publisher_companies add column if not exists onboarding_idempotency_key text;

create unique index if not exists publisher_companies_onboarding_idempotency_key
  on publisher_companies (onboarding_idempotency_key)
  where onboarding_idempotency_key is not null;
