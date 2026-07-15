alter table company_deletion_requests add column if not exists idempotency_key text;

update company_deletion_requests
set idempotency_key = 'migration:' || id::text
where idempotency_key is null;

alter table company_deletion_requests alter column idempotency_key set not null;

create unique index if not exists company_deletion_requests_idempotency_key
  on company_deletion_requests (client_company_id, idempotency_key);

alter table client_subscription_accesses add column if not exists idempotency_key text;

create unique index if not exists client_subscription_accesses_idempotency_key
  on client_subscription_accesses (subscription_id, idempotency_key)
  where idempotency_key is not null;
