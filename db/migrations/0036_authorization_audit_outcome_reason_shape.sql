-- Every authenticated denial carries one bounded reason code; successful
-- outcomes are content-free and therefore carry no denial reason.

do $$
begin
  if exists (
    select 1
    from platform_authorization_audit_log
    where (outcome = 'denied' and reason_code is null)
       or (outcome = 'succeeded' and reason_code is not null)
  ) then
    raise exception 'authorization audit rows violate outcome/reason shape';
  end if;
end
$$;

alter table platform_authorization_audit_log
  drop constraint if exists platform_authorization_audit_outcome_reason_shape;
alter table platform_authorization_audit_log
  add constraint platform_authorization_audit_outcome_reason_shape check (
    (outcome = 'succeeded' and reason_code is null)
    or
    (outcome = 'denied' and reason_code is not null)
  );
