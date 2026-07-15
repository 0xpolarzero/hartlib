-- Published deliveries remain immutable during ordinary product operations.
-- Canonical account-retention GC is the sole delete path after the company's
-- recovery window and legal-hold checks have passed in the same transaction.

create or replace function reject_issue_delivery_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('brief.allow_account_purge', true) = 'on' then
    return old;
  end if;

  raise exception 'published issue deliveries are immutable';
end;
$$;
