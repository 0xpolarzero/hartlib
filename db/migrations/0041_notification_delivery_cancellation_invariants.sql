-- Email delivery is authorized when the provider call is made, not when the
-- platform notification is created. A product-level membership removal is a
-- retained-identity revocation, so the delivery remains available for the
-- durable job to record a terminal cancellation.

alter table notification_preferences
  add column if not exists locale text not null default 'fr-FR';

alter table notification_preferences
  drop constraint if exists notification_preferences_locale;

alter table notification_preferences
  add constraint notification_preferences_locale check (locale in ('fr-FR', 'en-US'));

alter table email_notification_deliveries
  add column if not exists cancellation_reason_code text,
  add column if not exists cancelled_at timestamptz;

do $$
begin
  if exists (
    select 1
    from email_notification_deliveries
    where
      (status = 'queued' and attempts <> 0)
      or (status = 'sending' and attempts <= 0)
      or (status = 'failed' and (
        attempts <= 0
        or last_error_code is null
        or last_error_code not in (
          'application_error',
          'concurrent_idempotent_requests',
          'internal_server_error',
          'invalid_idempotent_request',
          'not_found',
          'provider_aborted',
          'provider_error',
          'provider_response_invalid',
          'provider_transport_error',
          'rate_limit_exceeded',
          'restricted_api_key',
          'unknown_error',
          'validation_error'
        )
      ))
      or (status = 'sent' and (
        attempts <= 0
        or sent_at is null
        or provider_message_id is null
        or btrim(provider_message_id) = ''
        or length(provider_message_id) > 200
      ))
      or (status in ('queued', 'sending', 'sent') and last_error_code is not null)
      or cancellation_reason_code is not null
      or cancelled_at is not null
  ) then
    raise exception
      'notification delivery cancellation migration requires canonical existing outcomes';
  end if;
end
$$;

alter table email_notification_deliveries
  drop constraint if exists email_notification_deliveries_status,
  drop constraint if exists email_notification_deliveries_sent_shape,
  drop constraint if exists email_notification_deliveries_outcome_shape;

alter table email_notification_deliveries
  add constraint email_notification_deliveries_status check (
    status in ('queued', 'sending', 'sent', 'failed', 'cancelled')
  ),
  add constraint email_notification_deliveries_outcome_shape check (
    (
      status = 'sent'
      and attempts > 0
      and sent_at is not null
      and provider_message_id is not null
      and btrim(provider_message_id) <> ''
      and length(provider_message_id) <= 200
      and last_error_code is null
      and cancellation_reason_code is null
      and cancelled_at is null
    )
    or
    (
      status = 'failed'
      and attempts > 0
      and sent_at is null
      and provider_message_id is null
      and last_error_code is not null
      and last_error_code ~ '^[a-z][a-z0-9_]{0,99}$'
      and last_error_code in (
        'application_error',
        'concurrent_idempotent_requests',
        'internal_server_error',
        'invalid_idempotent_request',
        'not_found',
        'provider_aborted',
        'provider_error',
        'provider_response_invalid',
        'provider_transport_error',
        'rate_limit_exceeded',
        'restricted_api_key',
        'unknown_error',
        'validation_error'
      )
      and cancellation_reason_code is null
      and cancelled_at is null
    )
    or
    (
      status = 'cancelled'
      and sent_at is null
      and provider_message_id is null
      and last_error_code is null
      and cancellation_reason_code is not null
      and cancellation_reason_code ~ '^[a-z][a-z0-9_]{0,99}$'
      and cancellation_reason_code in (
        'access_grant_revoked',
        'company_inactive',
        'delivery_state_changed',
        'email_opt_out',
        'issue_restricted',
        'membership_removed',
        'user_inactive'
      )
      and cancelled_at is not null
    )
    or
    (
      status = 'queued'
      and attempts = 0
      and sent_at is null
      and provider_message_id is null
      and last_error_code is null
      and cancellation_reason_code is null
      and cancelled_at is null
    )
    or
    (
      status = 'sending'
      and attempts > 0
      and sent_at is null
      and provider_message_id is null
      and last_error_code is null
      and cancellation_reason_code is null
      and cancelled_at is null
    )
  );

create or replace function protect_email_notification_delivery_state()
returns trigger
language plpgsql
as $$
begin
  if new.notification_id is distinct from old.notification_id
     or new.provider is distinct from old.provider
     or new.created_at is distinct from old.created_at then
    raise exception 'email notification delivery identity is immutable';
  end if;

  if new.recipient_email is distinct from old.recipient_email then
    if new.status <> 'sending'
       or old.status not in ('queued', 'sending', 'failed')
       or not exists (
         select 1
         from platform_notifications notification
         join platform_users users on users.id = notification.user_id
         where notification.id = old.notification_id
           and users.primary_email = new.recipient_email
       ) then
      raise exception 'email notification recipient may only refresh to the current user email';
    end if;
  end if;

  if new.attempts < old.attempts then
    raise exception 'email notification delivery attempts cannot decrease';
  end if;

  if old.status in ('sent', 'cancelled') and new is distinct from old then
    raise exception 'terminal email notification delivery is immutable';
  end if;

  if new.status is distinct from old.status and not (
    (old.status = 'queued' and new.status in ('sending', 'cancelled'))
    or (old.status = 'sending' and new.status in ('sent', 'failed', 'cancelled'))
    or (old.status = 'failed' and new.status in ('sending', 'cancelled'))
  ) then
    raise exception 'invalid email notification delivery transition';
  end if;

  return new;
end
$$;

drop trigger if exists email_notification_deliveries_protect_state
  on email_notification_deliveries;
create trigger email_notification_deliveries_protect_state
before update on email_notification_deliveries
for each row execute function protect_email_notification_delivery_state();
