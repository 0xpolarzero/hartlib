alter table company_deletion_requests
  add column if not exists resolution_idempotency_key text;

alter table company_deletion_requests
  drop constraint if exists company_deletion_requests_resolution_idempotency_nonempty;

alter table company_deletion_requests
  add constraint company_deletion_requests_resolution_idempotency_nonempty check (
    resolution_idempotency_key is null or btrim(resolution_idempotency_key) <> ''
  );

create index if not exists company_deletion_requests_resolution_lookup_idx
  on company_deletion_requests (id, resolution_idempotency_key)
  where resolution_idempotency_key is not null;

create index if not exists company_deletion_requests_pending_review_idx
  on company_deletion_requests (requested_at, id)
  where status = 'requested';
