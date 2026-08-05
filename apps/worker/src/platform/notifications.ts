import { messageForLocale } from "@hartlib/i18n/catalogs";
import { DEFAULT_LOCALE, type Locale } from "@hartlib/shared";
import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";

import type { NotificationEmailAdapter } from "./adapters";

export const NOTIFICATION_PROVIDER_TIMEOUT_MS = 20_000;

export type PlatformNotificationKind =
  | "issue_published"
  | "delivery_end_scheduled"
  | "delivery_ends_in_7_days"
  | "delivery_ended"
  | "usage_approaching_limit"
  | "usage_limit_reached";

export interface CreatePlatformNotificationInput {
  readonly clientCompanyId: string;
  readonly userId: string;
  readonly kind: PlatformNotificationKind;
  readonly deduplicationKey: string;
  readonly issueId?: string;
  readonly accessId?: string;
  readonly billingEventId?: string;
}

interface NotificationRow {
  readonly id: string;
  readonly inserted: boolean;
}

interface RecipientRow {
  readonly email: string;
  readonly emailEnabled: boolean;
}

const isIssueNotification = (kind: PlatformNotificationKind) => kind === "issue_published";

const isDeliveryNotification = (kind: PlatformNotificationKind) =>
  kind === "delivery_end_scheduled" ||
  kind === "delivery_ends_in_7_days" ||
  kind === "delivery_ended";

const isUsageNotification = (kind: PlatformNotificationKind) =>
  kind === "usage_approaching_limit" || kind === "usage_limit_reached";

const emailPreferenceColumn = (kind: PlatformNotificationKind) =>
  isIssueNotification(kind)
    ? "email_issue_published"
    : isUsageNotification(kind)
      ? "email_usage_limits"
      : "email_delivery_reminders";

const validateNotificationAuthorization = (input: CreatePlatformNotificationInput) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    if (
      input.deduplicationKey.trim() === "" ||
      input.deduplicationKey.length > 200 ||
      input.userId.trim() === "" ||
      input.clientCompanyId.trim() === ""
    ) {
      return yield* Effect.fail(new Error("notification_input_invalid"));
    }

    const issueKind = isIssueNotification(input.kind);
    const deliveryKind = isDeliveryNotification(input.kind);
    const usageKind = isUsageNotification(input.kind);
    if (
      (issueKind &&
        (input.issueId === undefined ||
          input.accessId === undefined ||
          input.billingEventId !== undefined)) ||
      (deliveryKind &&
        (input.issueId !== undefined ||
          input.accessId === undefined ||
          input.billingEventId !== undefined)) ||
      (usageKind && (input.issueId !== undefined || input.accessId !== undefined))
    ) {
      return yield* Effect.fail(new Error("notification_scope_invalid"));
    }

    const membership = yield* sql<{ readonly authorized: boolean }>`
      select exists(
        select 1
        from client_company_memberships memberships
        join client_companies companies
          on companies.id = memberships.company_id
         and companies.recovery_deleted_at is null
         and companies.purged_at is null
        join platform_users users
          on users.id = memberships.user_id
         and users.recovery_deleted_at is null
         and users.purged_at is null
        where memberships.company_id = ${input.clientCompanyId}
          and memberships.user_id = ${input.userId}
          and memberships.revoked_at is null
      ) as authorized
    `;
    if (membership[0]?.authorized !== true) {
      return yield* Effect.fail(new Error("notification_recipient_not_authorized"));
    }

    if (issueKind) {
      const access = yield* sql<{ readonly authorized: boolean }>`
        select exists(
          select 1
          from issue_deliveries delivery
          join publisher_issues issue
            on issue.id = delivery.issue_id
           and issue.status = 'published'
           and issue.restricted_at is null
          join client_employee_subscription_grants grant_row
            on grant_row.access_id = delivery.access_id
           and grant_row.client_company_id = delivery.client_company_id
           and grant_row.user_id = ${input.userId}
           and grant_row.revoked_at is null
          where delivery.issue_id = ${input.issueId!}
            and delivery.access_id = ${input.accessId!}
            and delivery.client_company_id = ${input.clientCompanyId}
        ) as authorized
      `;
      if (access[0]?.authorized !== true) {
        return yield* Effect.fail(new Error("issue_notification_not_delivered_to_recipient"));
      }
    }

    if (deliveryKind) {
      const requiredState = input.kind === "delivery_ended" ? "paused" : "ending";
      const access = yield* sql<{ readonly authorized: boolean }>`
        select exists(
          select 1
          from client_subscription_accesses access
          join client_employee_subscription_grants grant_row
            on grant_row.access_id = access.id
           and grant_row.client_company_id = access.client_company_id
           and grant_row.user_id = ${input.userId}
           and grant_row.revoked_at is null
          where access.id = ${input.accessId!}
            and access.client_company_id = ${input.clientCompanyId}
            and access.state = ${requiredState}
        ) as authorized
      `;
      if (access[0]?.authorized !== true) {
        return yield* Effect.fail(new Error("notification_access_not_authorized"));
      }
    }
  });

export const createPlatformNotificationInTransaction = (input: CreatePlatformNotificationInput) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      select pg_advisory_xact_lock(
        hashtext(${`hartlib:client-members:${input.clientCompanyId}`})
      )
    `;
    yield* validateNotificationAuthorization(input);
    yield* sql`
      select pg_advisory_xact_lock(hashtext(${`hartlib:notification:${input.deduplicationKey}`}))
    `;
    const prior = yield* sql<{ readonly id: string; readonly matches: boolean }>`
      select id::text,
             client_company_id = ${input.clientCompanyId}
             and user_id = ${input.userId}
             and kind = ${input.kind}
             and issue_id is not distinct from ${input.issueId ?? null}::uuid
             and access_id is not distinct from ${input.accessId ?? null}::uuid
             and billing_event_id is not distinct from ${input.billingEventId ?? null}::uuid
               as matches
      from platform_notifications
      where deduplication_key = ${input.deduplicationKey}
    `;
    if (prior[0]?.matches === false) {
      return yield* Effect.fail(new Error("notification_idempotency_conflict"));
    }
    const notification: NotificationRow =
      prior[0] === undefined
        ? (yield* sql<NotificationRow>`
            insert into platform_notifications (
              client_company_id,
              user_id,
              kind,
              issue_id,
              access_id,
              billing_event_id,
              deduplication_key
            ) values (
              ${input.clientCompanyId},
              ${input.userId},
              ${input.kind},
              ${input.issueId ?? null},
              ${input.accessId ?? null},
              ${input.billingEventId ?? null},
              ${input.deduplicationKey}
            )
            returning id::text, true as inserted
          `)[0]!
        : { id: prior[0].id, inserted: false };
    const preference = emailPreferenceColumn(input.kind);
    const defaultEmailEnabled = preference !== "email_issue_published";
    const recipients = yield* sql<RecipientRow>`
      select users.primary_email as email,
             coalesce(
               (to_jsonb(preferences)->>${preference})::boolean,
               ${defaultEmailEnabled}
             ) as "emailEnabled"
      from platform_users users
      left join notification_preferences preferences
        on preferences.client_company_id = ${input.clientCompanyId}
       and preferences.user_id = users.id
      where users.id = ${input.userId}
        and users.recovery_deleted_at is null
        and users.purged_at is null
    `;
    const recipient = recipients[0];
    let deliveryId: string | null = null;
    if (notification.inserted && recipient?.emailEnabled === true) {
      const deliveries = yield* sql<{ readonly id: string }>`
        insert into email_notification_deliveries (notification_id, recipient_email)
        values (${notification.id}, ${recipient.email})
        on conflict (notification_id, recipient_email) do update
        set recipient_email = excluded.recipient_email
        returning id::text
      `;
      deliveryId = deliveries[0]!.id;
      yield* sql`
        insert into jobs (kind, payload, unique_key, max_attempts)
        values (
          'send_email_notification',
          ${sql.json({ deliveryId })},
          ${`email-notification:${deliveryId}`},
          8
        )
        on conflict (unique_key) where unique_key is not null do nothing
      `;
    }
    return { notificationId: notification.id, deliveryId, inserted: notification.inserted };
  });

export const createPlatformNotification = (input: CreatePlatformNotificationInput) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(createPlatformNotificationInTransaction(input));
  });

type EmailDeliveryStatus = "queued" | "sending" | "sent" | "failed" | "cancelled";

interface EmailDeliveryRow {
  readonly id: string;
  readonly recipientEmail: string;
  readonly status: EmailDeliveryStatus;
  readonly cancellationReasonCode: string | null;
  readonly kind: PlatformNotificationKind;
  readonly clientCompanyId: string;
  readonly userId: string;
  readonly issueId: string | null;
  readonly accessId: string | null;
  readonly billingEventId: string | null;
  readonly companyExists: boolean;
  readonly companyActive: boolean;
  readonly userExists: boolean;
  readonly userActive: boolean;
  readonly membershipExists: boolean;
  readonly currentEmail: string | null;
  readonly locale: Locale;
  readonly emailIssuePublished: boolean;
  readonly emailDeliveryReminders: boolean;
  readonly emailUsageLimits: boolean;
  readonly accessExists: boolean;
  readonly accessMatchesCompany: boolean;
  readonly accessState: "invited" | "active" | "ending" | "paused" | null;
  readonly grantAuthorized: boolean;
  readonly issueExists: boolean;
  readonly issuePublished: boolean;
  readonly issueRestricted: boolean;
  readonly issueDeliveryMatches: boolean;
  readonly issueDeliveredToOtherCompany: boolean;
}

type CancellationReasonCode =
  | "company_inactive"
  | "user_inactive"
  | "membership_removed"
  | "access_grant_revoked"
  | "delivery_state_changed"
  | "issue_restricted"
  | "email_opt_out";

type AuthorizationDecision =
  | { readonly _tag: "authorized"; readonly email: string; readonly locale: Locale }
  | { readonly _tag: "cancelled"; readonly reasonCode: CancellationReasonCode }
  | { readonly _tag: "malformed"; readonly errorCode: string };

const deliveryAuthorization = (row: EmailDeliveryRow): AuthorizationDecision => {
  const issueKind = isIssueNotification(row.kind);
  const deliveryKind = isDeliveryNotification(row.kind);
  const usageKind = isUsageNotification(row.kind);
  if (
    (issueKind && (row.issueId === null || row.accessId === null || row.billingEventId !== null)) ||
    (deliveryKind &&
      (row.issueId !== null || row.accessId === null || row.billingEventId !== null)) ||
    (usageKind && (row.issueId !== null || row.accessId !== null))
  ) {
    return { _tag: "malformed", errorCode: "notification_scope_invalid" };
  }

  if (row.accessId !== null && row.accessExists && !row.accessMatchesCompany) {
    return { _tag: "malformed", errorCode: "notification_scope_tenant_mismatch" };
  }
  if (issueKind && row.issueDeliveredToOtherCompany && !row.issueDeliveryMatches) {
    return { _tag: "malformed", errorCode: "notification_scope_tenant_mismatch" };
  }
  if (!row.companyExists) {
    return { _tag: "malformed", errorCode: "notification_company_missing" };
  }
  if (!row.userExists) {
    return { _tag: "malformed", errorCode: "notification_user_missing" };
  }
  if (!row.companyActive) return { _tag: "cancelled", reasonCode: "company_inactive" };
  if (!row.userActive) return { _tag: "cancelled", reasonCode: "user_inactive" };
  if (!row.membershipExists) return { _tag: "cancelled", reasonCode: "membership_removed" };

  if (row.accessId !== null && !row.accessExists) {
    return { _tag: "malformed", errorCode: "notification_access_missing" };
  }
  if (issueKind) {
    if (!row.issueExists) {
      return { _tag: "malformed", errorCode: "notification_issue_missing" };
    }
    if (!row.issuePublished || !row.issueDeliveryMatches) {
      return { _tag: "malformed", errorCode: "notification_issue_delivery_mismatch" };
    }
  }
  if (row.accessId !== null && !row.grantAuthorized) {
    return { _tag: "cancelled", reasonCode: "access_grant_revoked" };
  }
  if (
    (row.kind === "delivery_end_scheduled" || row.kind === "delivery_ends_in_7_days") &&
    row.accessState !== "ending"
  ) {
    return { _tag: "cancelled", reasonCode: "delivery_state_changed" };
  }
  if (row.kind === "delivery_ended" && row.accessState !== "paused") {
    return { _tag: "cancelled", reasonCode: "delivery_state_changed" };
  }
  if (issueKind && row.issueRestricted) {
    return { _tag: "cancelled", reasonCode: "issue_restricted" };
  }

  const emailEnabled = issueKind
    ? row.emailIssuePublished
    : usageKind
      ? row.emailUsageLimits
      : row.emailDeliveryReminders;
  if (!emailEnabled) return { _tag: "cancelled", reasonCode: "email_opt_out" };
  if (row.currentEmail === null || row.currentEmail.trim() === "") {
    return { _tag: "malformed", errorCode: "notification_recipient_email_invalid" };
  }
  return { _tag: "authorized", email: row.currentEmail, locale: row.locale };
};

const subjectKeyByKind = {
  issue_published: "notification.email.issue_published.subject",
  delivery_end_scheduled: "notification.email.delivery_end_scheduled.subject",
  delivery_ends_in_7_days: "notification.email.delivery_ends_in_7_days.subject",
  delivery_ended: "notification.email.delivery_ended.subject",
  usage_approaching_limit: "notification.email.usage_approaching_limit.subject",
  usage_limit_reached: "notification.email.usage_limit_reached.subject",
} as const;

const htmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const emailContent = (row: EmailDeliveryRow, locale: Locale, appBaseUrl: URL) => {
  const localizedPath =
    row.issueId === null
      ? `/${locale}/client/${encodeURIComponent(row.clientCompanyId)}/notifications`
      : `/${locale}/client/${encodeURIComponent(row.clientCompanyId)}/issues/${encodeURIComponent(row.issueId)}`;
  const platformUrl = new URL(localizedPath, appBaseUrl).toString();
  const subject = messageForLocale(locale, subjectKeyByKind[row.kind]);
  const openHartlib = messageForLocale(locale, "notification.email.openHartlib");
  return {
    subject,
    text: `${subject}. ${openHartlib}: ${platformUrl}`,
    html: `<p>${htmlEscape(subject)}.</p><p><a href="${htmlEscape(platformUrl)}">${htmlEscape(openHartlib)}</a></p>`,
  };
};

const knownProviderErrorCodes = new Set([
  "application_error",
  "concurrent_idempotent_requests",
  "internal_server_error",
  "invalid_idempotent_request",
  "not_found",
  "rate_limit_exceeded",
  "restricted_api_key",
  "validation_error",
]);

const providerErrorCode = (error: unknown): string => {
  const candidate =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  if (typeof candidate === "string" && knownProviderErrorCodes.has(candidate)) return candidate;
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "TimeoutException"
  ) {
    return "provider_timeout";
  }
  if (error instanceof Error && error.name === "AbortError") return "provider_aborted";
  if (error instanceof TypeError) return "provider_transport_error";
  return "provider_error";
};

const isProviderMessageId = (value: string): boolean => value.trim() !== "" && value.length <= 200;

type SendTransactionResult =
  | { readonly status: "already_sent" }
  | { readonly status: "already_cancelled"; readonly reasonCode: string }
  | { readonly status: "cancelled"; readonly reasonCode: CancellationReasonCode }
  | { readonly status: "sent"; readonly providerMessageId: string }
  | { readonly status: "provider_failed"; readonly errorCode: string };

export const sendEmailNotification = (input: {
  readonly deliveryId: string;
  readonly appBaseUrl: string;
  readonly adapter: NotificationEmailAdapter;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const appBaseUrl = yield* Effect.try({
      try: () => new URL(input.appBaseUrl),
      catch: () => new Error("notification_app_base_url_invalid"),
    });
    const transactionResult: SendTransactionResult = yield* sql.withTransaction(
      Effect.gen(function* () {
        const scopes = yield* sql<{
          readonly clientCompanyId: string;
          readonly userId: string;
        }>`
          select notification.client_company_id::text as "clientCompanyId",
                 notification.user_id as "userId"
          from email_notification_deliveries delivery
          join platform_notifications notification on notification.id = delivery.notification_id
          where delivery.id = ${input.deliveryId}
          for update of delivery
        `;
        const scope = scopes[0];
        if (scope === undefined) return yield* Effect.fail(new Error("email_delivery_not_found"));
        yield* sql`
          select pg_advisory_xact_lock(
            hashtext(${`hartlib:client-members:${scope.clientCompanyId}`})
          )
        `;
        // Clerk user deletion and support-approved company deletion mutate
        // independent lifecycle rows rather than the membership lane. Hold
        // both rows, in the same order as billing capability issuance, until
        // the bounded provider call and terminal delivery write complete.
        yield* sql`
          select id
          from platform_users
          where id = ${scope.userId}
          for share
        `;
        yield* sql`
          select id
          from client_companies
          where id = ${scope.clientCompanyId}
          for share
        `;
        const rows = yield* sql<EmailDeliveryRow>`
          select delivery.id::text,
                 delivery.recipient_email as "recipientEmail",
                 delivery.status,
                 delivery.cancellation_reason_code as "cancellationReasonCode",
                 notification.kind,
                 notification.client_company_id::text as "clientCompanyId",
                 notification.user_id as "userId",
                 notification.issue_id::text as "issueId",
                 notification.access_id::text as "accessId",
                 notification.billing_event_id::text as "billingEventId",
                 company.id is not null as "companyExists",
                 company.id is not null
                   and company.recovery_deleted_at is null
                   and company.purged_at is null as "companyActive",
                 users.id is not null as "userExists",
                 users.id is not null
                   and users.recovery_deleted_at is null
                   and users.purged_at is null as "userActive",
                 membership.user_id is not null as "membershipExists",
                 users.primary_email as "currentEmail",
                 coalesce(preferences.locale, ${DEFAULT_LOCALE}) as locale,
                 coalesce(preferences.email_issue_published, false) as "emailIssuePublished",
                 coalesce(preferences.email_delivery_reminders, true) as "emailDeliveryReminders",
                 coalesce(preferences.email_usage_limits, true) as "emailUsageLimits",
                 exists(
                   select 1 from client_subscription_accesses access
                   where access.id = notification.access_id
                 ) as "accessExists",
                 exists(
                   select 1 from client_subscription_accesses access
                   where access.id = notification.access_id
                     and access.client_company_id = notification.client_company_id
                 ) as "accessMatchesCompany",
                 (
                   select access.state
                   from client_subscription_accesses access
                   where access.id = notification.access_id
                 ) as "accessState",
                 exists(
                   select 1
                   from client_employee_subscription_grants grant_row
                   where grant_row.access_id = notification.access_id
                     and grant_row.client_company_id = notification.client_company_id
                     and grant_row.user_id = notification.user_id
                     and grant_row.revoked_at is null
                 ) as "grantAuthorized",
                 exists(
                   select 1 from publisher_issues issue
                   where issue.id = notification.issue_id
                 ) as "issueExists",
                 exists(
                   select 1 from publisher_issues issue
                   where issue.id = notification.issue_id and issue.status = 'published'
                 ) as "issuePublished",
                 exists(
                   select 1 from publisher_issues issue
                   where issue.id = notification.issue_id and issue.restricted_at is not null
                 ) as "issueRestricted",
                 exists(
                   select 1
                   from issue_deliveries issue_delivery
                   where issue_delivery.issue_id = notification.issue_id
                     and issue_delivery.access_id = notification.access_id
                     and issue_delivery.client_company_id = notification.client_company_id
                 ) as "issueDeliveryMatches",
                 exists(
                   select 1
                   from issue_deliveries issue_delivery
                   where issue_delivery.issue_id = notification.issue_id
                     and issue_delivery.client_company_id <> notification.client_company_id
                 ) as "issueDeliveredToOtherCompany"
          from email_notification_deliveries delivery
          join platform_notifications notification on notification.id = delivery.notification_id
          left join client_companies company on company.id = notification.client_company_id
          left join platform_users users on users.id = notification.user_id
          left join client_company_memberships membership
           on membership.company_id = notification.client_company_id
           and membership.user_id = notification.user_id
           and membership.revoked_at is null
          left join notification_preferences preferences
            on preferences.client_company_id = notification.client_company_id
           and preferences.user_id = notification.user_id
          where delivery.id = ${input.deliveryId}
        `;
        const row = rows[0];
        if (row === undefined) return yield* Effect.fail(new Error("email_delivery_not_found"));
        if (row.status === "sent") return { status: "already_sent" } as const;
        if (row.status === "cancelled") {
          return {
            status: "already_cancelled",
            reasonCode: row.cancellationReasonCode ?? "cancellation_reason_missing",
          } as const;
        }

        const decision = deliveryAuthorization(row);
        if (decision._tag === "malformed") {
          return yield* Effect.fail(new Error(decision.errorCode));
        }
        if (decision._tag === "cancelled") {
          yield* sql`
            update email_notification_deliveries
            set status = 'cancelled', cancellation_reason_code = ${decision.reasonCode},
                cancelled_at = now(), last_error_code = null, updated_at = now()
            where id = ${row.id}
          `;
          return { status: "cancelled", reasonCode: decision.reasonCode } as const;
        }

        yield* sql`
          update email_notification_deliveries
          set status = 'sending', attempts = attempts + 1,
              recipient_email = ${decision.email}, last_error_code = null,
              cancellation_reason_code = null, cancelled_at = null, updated_at = now()
          where id = ${row.id}
        `;
        const content = emailContent(row, decision.locale, appBaseUrl);
        const attempted = yield* Effect.tryPromise({
          try: (signal) =>
            input.adapter.send(
              {
                to: decision.email,
                ...content,
                idempotencyKey: `hartlib-email-${row.id}`,
              },
              { signal },
            ),
          catch: (error) => error,
        }).pipe(
          Effect.timeout(`${NOTIFICATION_PROVIDER_TIMEOUT_MS} millis`),
          Effect.map((result) => ({ _tag: "success" as const, result })),
          Effect.catch((error) => Effect.succeed({ _tag: "failure" as const, error })),
        );
        if (attempted._tag === "failure") {
          const code = providerErrorCode(attempted.error);
          yield* sql`
            update email_notification_deliveries
            set status = 'failed', last_error_code = ${code}, updated_at = now()
            where id = ${row.id} and status = 'sending'
          `;
          return { status: "provider_failed", errorCode: code } as const;
        }
        if (!isProviderMessageId(attempted.result.providerMessageId)) {
          yield* sql`
            update email_notification_deliveries
            set status = 'failed', last_error_code = 'provider_response_invalid', updated_at = now()
            where id = ${row.id} and status = 'sending'
          `;
          return {
            status: "provider_failed",
            errorCode: "provider_response_invalid",
          } as const;
        }
        yield* sql`
          update email_notification_deliveries
          set status = 'sent', provider_message_id = ${attempted.result.providerMessageId},
              sent_at = now(), last_error_code = null, updated_at = now()
          where id = ${row.id} and status = 'sending'
        `;
        return {
          status: "sent",
          providerMessageId: attempted.result.providerMessageId,
        } as const;
      }),
    );
    if (transactionResult.status === "provider_failed") {
      return yield* Effect.fail(new Error(transactionResult.errorCode));
    }
    return transactionResult;
  });
