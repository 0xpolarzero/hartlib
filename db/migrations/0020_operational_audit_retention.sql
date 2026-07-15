-- Support-access and authorization audit records are retained for 24 months,
-- then removed only by the serialized retention worker path.

create or replace function reject_restricted_support_access_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('brief.allow_audit_retention_purge', true) = 'on'
     and old.accessed_at <= now() - interval '24 months' then
    return old;
  end if;
  raise exception 'restricted support access log is append-only until retention expiry';
end;
$$;

create index if not exists restricted_support_access_log_purge_idx
  on restricted_support_access_log (accessed_at, id);

create index if not exists restricted_support_access_reviews_access_idx
  on restricted_support_access_reviews (access_log_id);

create index if not exists restricted_support_grants_retention_idx
  on restricted_support_grants (expires_at, id);
