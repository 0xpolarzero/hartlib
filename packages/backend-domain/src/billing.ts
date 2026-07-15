import { PgClient } from "@effect/sql-pg";
import type {
  AiPlanTier,
  AiUsageOverview,
  AiUsageRequestDescriptor,
  MonthlyPlanChangeDescriptor,
} from "@brief/shared";
import { Effect } from "effect";

type SqlEffect<A = void> = Effect.Effect<A, unknown, PgClient.PgClient>;

export interface BillingCheckoutContext {
  readonly customerId: string | null;
  readonly subscriptionId: string | null;
  readonly status: "inactive" | "trialing" | "active" | "past_due" | "paused" | "cancelled";
  readonly email: string;
}

export interface BillingCheckoutReservationInput {
  readonly companyId: string;
  readonly idempotencyKey: string;
  readonly userId: string;
  readonly authorizationRequestId: string;
  readonly authorizationSessionId: string;
  readonly authorizationOrganizationId: string | null;
  readonly authorizationMode: "demo" | "clerk";
  readonly authorizationMfaVerified: boolean;
  readonly kind: "monthly" | "additional";
  readonly planTier: AiPlanTier | null;
  readonly credits: number | null;
  readonly customerId: string;
  readonly priceId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly stripeOperationKey: string;
  readonly allowNew: boolean;
  /** Phase B may only claim the row committed by phase A. */
  readonly requireExisting?: boolean;
  /** Claim the already-reserved provider attempt without counting a second attempt. */
  readonly claimExisting?: boolean;
  /** Phase A's lease owner token. Phase B must present this exact token. */
  readonly claimLeaseToken?: string;
}

export type BillingCheckoutReservation =
  | {
      readonly kind: "execute";
      readonly stripeOperationKey: string;
      readonly attempts: number;
      readonly leaseToken: string;
    }
  | { readonly kind: "complete"; readonly url: string; readonly sessionId: string }
  | { readonly kind: "in_progress" };

/**
 * Keeps current company-admin authorization linearizable with membership
 * revocation while a bounded external billing capability is issued.
 */
export const withBillingAuthorizationLease = <A>(input: {
  readonly companyId: string;
  readonly userId: string;
  readonly authorize: SqlEffect;
  readonly operation: SqlEffect<A>;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`brief:client-members:${input.companyId}`}))
        `;
        // A membership-lane lock serializes membership/grant changes. Row
        // locks additionally serialize the independent Clerk user lifecycle
        // and support-approved company lifecycle while the bearer capability
        // is being issued. Keep the order identical for Checkout and Portal.
        yield* sql`
          select id
          from platform_users
          where id = ${input.userId}
          for share
        `;
        yield* sql`
          select id
          from client_companies
          where id = ${input.companyId}
          for share
        `;
        yield* input.authorize;
        return yield* input.operation;
      }),
    );
  });

export const loadBillingCheckoutContext = (input: {
  readonly companyId: string;
  readonly userId: string;
  readonly authorize: SqlEffect;
}) =>
  Effect.gen(function* () {
    yield* input.authorize;
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<BillingCheckoutContext>`
      select company.stripe_customer_id as "customerId",
             billing.stripe_subscription_id as "subscriptionId",
             coalesce(billing.status, 'inactive') as status,
             users.primary_email as email
      from client_companies company
      join platform_users users on users.id = ${input.userId}
      left join client_ai_billing_accounts billing on billing.client_company_id = company.id
      where company.id = ${input.companyId}
        and company.recovery_deleted_at is null and company.purged_at is null
        and users.recovery_deleted_at is null and users.purged_at is null
    `;
    return rows[0] ?? null;
  });

export const bindBillingCustomer = (input: {
  readonly companyId: string;
  readonly expectedCustomerId: string | null;
  readonly customerId: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`brief:billing-customer:${input.companyId}`}))
        `;
        const rows = yield* sql<{ readonly customerId: string | null }>`
          select stripe_customer_id as "customerId"
          from client_companies
          where id = ${input.companyId} and recovery_deleted_at is null
          for update
        `;
        const current = rows[0];
        if (current === undefined) return "not_found" as const;
        if (input.expectedCustomerId !== null && current.customerId !== input.expectedCustomerId) {
          return "conflict" as const;
        }
        if (current.customerId !== null && current.customerId !== input.customerId) {
          return "conflict" as const;
        }
        if (current.customerId === null) {
          yield* sql`
            update client_companies
            set stripe_customer_id = ${input.customerId}, updated_at = now()
            where id = ${input.companyId} and stripe_customer_id is null
          `;
        }
        return "bound" as const;
      }),
    );
  });

/**
 * Reserve one Stripe Checkout capability under the caller's company lane.
 * Identity columns are compared on every replay; only the provider output and
 * lease/attempt state are mutable.  An uncertain provider call therefore stays
 * replayable with the exact same Stripe idempotency key while a different
 * logical request cannot overtake a live one.
 */
export const reserveBillingCheckout = (
  input: BillingCheckoutReservationInput,
): Effect.Effect<BillingCheckoutReservation, Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    // Reserve under the same company lane used by authorization changes.  The
    // lock is intentionally owned by this short transaction so phase A can
    // commit the immutable reservation before phase B enters the provider
    // boundary; competing keys still serialize deterministically.
    yield* sql`
      select pg_advisory_xact_lock(hashtext(${`brief:client-members:${input.companyId}`}))
    `;
    const existing = yield* sql<{
      readonly id: string;
      readonly requestedByUserId: string;
      readonly authorizationRequestId: string;
      readonly authorizationSessionId: string;
      readonly authorizationOrganizationId: string | null;
      readonly authorizationMode: "demo" | "clerk";
      readonly authorizationMfaVerified: boolean;
      readonly kind: "monthly" | "additional";
      readonly planTier: AiPlanTier | null;
      readonly credits: string | number | bigint | null;
      readonly customerId: string;
      readonly priceId: string;
      readonly successUrl: string;
      readonly cancelUrl: string;
      readonly stripeOperationKey: string;
      readonly status: "processing" | "succeeded" | "failed";
      readonly sessionId: string | null;
      readonly url: string | null;
      readonly attempts: number;
      readonly leaseToken: string;
      readonly leaseFresh: boolean;
    }>`
      select id::text,
             requested_by_user_id as "requestedByUserId",
             authorization_request_id::text as "authorizationRequestId",
             authorization_session_id as "authorizationSessionId",
             authorization_organization_id as "authorizationOrganizationId",
             authorization_mode as "authorizationMode",
             authorization_mfa_verified as "authorizationMfaVerified",
             kind, plan_tier as "planTier", credits,
             stripe_customer_id as "customerId", stripe_price_id as "priceId",
             success_url as "successUrl", cancel_url as "cancelUrl",
             stripe_operation_key as "stripeOperationKey", status,
             stripe_checkout_session_id as "sessionId", checkout_url as url,
             attempts, lease_token::text as "leaseToken",
             lease_expires_at > now() as "leaseFresh"
      from client_ai_checkout_requests
      where client_company_id = ${input.companyId}
        and idempotency_key = ${input.idempotencyKey}
      for update
    `;
    const prior = existing[0];
    const priorCredits =
      prior?.credits === null || prior?.credits === undefined ? null : Number(prior.credits);
    const sameIdentity =
      prior !== undefined &&
      prior.requestedByUserId === input.userId &&
      prior.authorizationSessionId === input.authorizationSessionId &&
      prior.authorizationOrganizationId === input.authorizationOrganizationId &&
      prior.authorizationMode === input.authorizationMode &&
      prior.authorizationMfaVerified === input.authorizationMfaVerified &&
      prior.kind === input.kind &&
      prior.planTier === input.planTier &&
      priorCredits === input.credits &&
      prior.customerId === input.customerId &&
      prior.priceId === input.priceId &&
      prior.successUrl === input.successUrl &&
      prior.cancelUrl === input.cancelUrl &&
      prior.stripeOperationKey === input.stripeOperationKey;
    if (prior !== undefined && !sameIdentity) {
      return yield* Effect.fail(new Error("billing_checkout_idempotency_conflict"));
    }
    if (prior?.status === "succeeded") {
      if (prior.sessionId === null || prior.url === null) {
        return yield* Effect.fail(new Error("billing_checkout_state_invalid"));
      }
      return {
        kind: "complete",
        url: prior.url,
        sessionId: prior.sessionId,
      } satisfies BillingCheckoutReservation;
    }

    if (prior === undefined && input.requireExisting === true) {
      return yield* Effect.fail(new Error("billing_checkout_reservation_missing"));
    }
    if (prior === undefined && !input.allowNew) {
      return yield* Effect.fail(new Error("monthly_plan_change_required"));
    }

    const otherProcessing = yield* sql<{
      readonly id: string;
      readonly leaseFresh: boolean;
      readonly requestedByUserId: string;
      readonly authorizationSessionId: string;
      readonly authorizationRequestId: string;
      readonly kind: "monthly" | "additional";
    }>`
      select id::text, lease_expires_at > now() as "leaseFresh",
             requested_by_user_id as "requestedByUserId",
             authorization_session_id as "authorizationSessionId",
             authorization_request_id::text as "authorizationRequestId",
             kind
      from client_ai_checkout_requests
      where client_company_id = ${input.companyId}
        and status = 'processing'
        and idempotency_key <> ${input.idempotencyKey}
      order by updated_at, id
      limit 1
      for update
    `;
    const competing = otherProcessing[0];
    if (competing !== undefined) {
      if (competing.leaseFresh) {
        return yield* Effect.fail(new Error("billing_checkout_in_progress"));
      }
      yield* sql`
        update client_ai_checkout_requests
        set status = 'failed', error_code = 'request_abandoned', updated_at = now()
        where id = ${competing.id} and status = 'processing'
      `;
      yield* sql`
        insert into platform_authorization_audit_log (
          actor_user_id, session_id, request_id, action,
          scope_kind, scope_id, outcome, reason_code
        ) values (
          ${competing.requestedByUserId}, ${competing.authorizationSessionId},
          ${competing.authorizationRequestId}::uuid,
          ${`client.billing.checkout.${competing.kind}`},
          'client_company', ${input.companyId}, 'denied', 'request_abandoned'
        )
        on conflict (request_id, action, scope_kind, scope_id) do nothing
      `;
    }

    if (prior === undefined) {
      const leaseToken = crypto.randomUUID();
      yield* sql`
        insert into client_ai_checkout_requests (
          client_company_id, idempotency_key, requested_by_user_id,
          authorization_request_id, authorization_session_id,
          authorization_organization_id, authorization_mode,
          authorization_mfa_verified, kind, plan_tier, credits,
          stripe_customer_id, stripe_price_id, success_url, cancel_url,
          stripe_operation_key, status, attempts, lease_token, lease_expires_at
        ) values (
          ${input.companyId}, ${input.idempotencyKey}, ${input.userId},
          ${input.authorizationRequestId}, ${input.authorizationSessionId},
          ${input.authorizationOrganizationId}, ${input.authorizationMode},
          ${input.authorizationMfaVerified}, ${input.kind}, ${input.planTier},
          ${input.credits}, ${input.customerId}, ${input.priceId},
          ${input.successUrl}, ${input.cancelUrl}, ${input.stripeOperationKey},
          'processing', 1, ${leaseToken}, now() + interval '5 minutes'
        )
      `;
      return {
        kind: "execute",
        stripeOperationKey: input.stripeOperationKey,
        attempts: 1,
        leaseToken,
      } satisfies BillingCheckoutReservation;
    }

    // Phase B claims the exact row committed by phase A without incrementing
    // the durable provider-attempt counter. A later HTTP retry (phase A) takes
    // the path below and advances attempts exactly once for its new provider
    // attempt.
    if (input.claimExisting === true && prior.status === "processing") {
      if (input.claimLeaseToken === undefined || input.claimLeaseToken !== prior.leaseToken) {
        return yield* Effect.fail(new Error("billing_checkout_claim_conflict"));
      }
      if (!prior.leaseFresh) {
        return yield* Effect.fail(new Error("billing_checkout_claim_expired"));
      }
      yield* sql`
        update client_ai_checkout_requests
        set lease_expires_at = now() + interval '5 minutes', updated_at = now()
        where id = ${prior.id} and status = 'processing'
          and lease_token = ${prior.leaseToken} and lease_expires_at > now()
      `;
      return {
        kind: "execute",
        stripeOperationKey: prior.stripeOperationKey,
        attempts: prior.attempts,
        leaseToken: prior.leaseToken,
      } satisfies BillingCheckoutReservation;
    }

    // A live same-key owner is still inside the bounded provider boundary.
    // Do not start a second Stripe call; only the owner may claim the lease.
    if (prior?.status === "processing" && prior.leaseFresh) {
      return { kind: "in_progress" } satisfies BillingCheckoutReservation;
    }

    // A same-key processing row is an ambiguous provider boundary. Renew the
    // lease and retry only with the exact immutable operation key. Failed
    // stale rows are likewise revived so the request remains recoverable.
    yield* sql`
      update client_ai_checkout_requests
      set status = 'processing', error_code = null,
          attempts = attempts + 1, lease_token = gen_random_uuid(),
          lease_expires_at = now() + interval '5 minutes',
          updated_at = now()
      where id = ${prior.id}
    `;
    return {
      kind: "execute",
      stripeOperationKey: prior.stripeOperationKey,
      attempts: prior.attempts + 1,
      leaseToken: (yield* sql<{ readonly leaseToken: string }>`
        select lease_token::text as "leaseToken"
        from client_ai_checkout_requests where id = ${prior.id}
      `)[0]!.leaseToken,
    } satisfies BillingCheckoutReservation;
  });

export const finalizeBillingCheckout = (input: {
  readonly companyId: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly url: string;
  readonly leaseToken: string;
}): Effect.Effect<{ readonly sessionId: string; readonly url: string }, Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly sessionId: string; readonly url: string }>`
      update client_ai_checkout_requests
      set status = 'succeeded', stripe_checkout_session_id = ${input.sessionId},
          checkout_url = ${input.url}, error_code = null,
          lease_expires_at = now(), updated_at = now()
      where client_company_id = ${input.companyId}
        and idempotency_key = ${input.idempotencyKey}
        and status = 'processing'
        and lease_token = ${input.leaseToken}
        and lease_expires_at > now()
      returning stripe_checkout_session_id as "sessionId", checkout_url as url
    `;
    const row = rows[0];
    if (row === undefined) {
      const replay = yield* sql<{ readonly sessionId: string; readonly url: string }>`
        select stripe_checkout_session_id as "sessionId", checkout_url as url
        from client_ai_checkout_requests
        where client_company_id = ${input.companyId}
          and idempotency_key = ${input.idempotencyKey}
          and status = 'succeeded'
      `;
      if (replay[0] !== undefined) return replay[0];
      return yield* Effect.fail(new Error("billing_checkout_finalize_conflict"));
    }
    return row;
  });

/** Release a failed/uncertain provider attempt for exact-key reconciliation.
 * The owner token prevents an old timeout handler from releasing a newer
 * retry's lease. */
export const releaseBillingCheckoutLease = (input: {
  readonly companyId: string;
  readonly idempotencyKey: string;
  readonly leaseToken: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      update client_ai_checkout_requests
      set lease_expires_at = now(), updated_at = now()
      where client_company_id = ${input.companyId}
        and idempotency_key = ${input.idempotencyKey}
        and status = 'processing'
        and lease_token = ${input.leaseToken}
    `;
  });

export const loadBillingPortalCustomer = (input: {
  readonly companyId: string;
  readonly authorize: SqlEffect;
}) =>
  Effect.gen(function* () {
    yield* input.authorize;
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly customerId: string | null }>`
      select stripe_customer_id as "customerId"
      from client_companies
      where id = ${input.companyId}
        and recovery_deleted_at is null and purged_at is null
    `;
    return rows[0]?.customerId ?? null;
  });

const asNumber = (value: string | number | bigint | null): number | null => {
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("billing_value_out_of_range");
  return number;
};

const loadAiUsageOverviewLocked = (input: {
  readonly companyId: string;
  readonly userId: string;
  readonly authorize: SqlEffect;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const roles = yield* sql<{ readonly role: "admin" | "member" }>`
      select role from client_company_memberships
      where company_id = ${input.companyId} and user_id = ${input.userId}
        and revoked_at is null
    `;
    const admin = roles[0]?.role === "admin";
    const accounts = yield* sql<{
      readonly status: AiUsageOverview["status"];
      readonly planTier: AiUsageOverview["planTier"];
      readonly pendingDowngradeTier: AiUsageOverview["pendingDowngradeTier"];
      readonly periodStart: Date | null;
      readonly periodEnd: Date | null;
      readonly companyLimit: string | number | bigint | null;
    }>`
      select coalesce(status, 'inactive') as status, plan_tier as "planTier",
             pending_downgrade_tier as "pendingDowngradeTier",
             current_period_start as "periodStart", current_period_end as "periodEnd",
             company_monthly_limit as "companyLimit"
      from client_ai_billing_accounts where client_company_id = ${input.companyId}
    `;
    const account = accounts[0] ?? {
      status: "inactive" as const,
      planTier: null,
      pendingDowngradeTier: null,
      periodStart: null,
      periodEnd: null,
      companyLimit: null,
    };
    const employees = yield* sql<{
      readonly userId: string;
      readonly used: string | number | bigint;
      readonly limit: string | number | bigint | null;
    }>`
      select membership.user_id as "userId", coalesce(sum(usage.credits), 0) as used,
             limits.monthly_limit as limit
      from client_company_memberships membership
      join platform_users users
        on users.id = membership.user_id
       and users.recovery_deleted_at is null and users.purged_at is null
      left join client_credit_usage usage
        on usage.client_company_id = membership.company_id
       and usage.user_id = membership.user_id
       and (${account.periodStart}::timestamptz is null or usage.created_at >= ${account.periodStart})
       and (${account.periodEnd}::timestamptz is null or usage.created_at < ${account.periodEnd})
      left join client_employee_ai_limits limits
        on limits.client_company_id = membership.company_id
       and limits.user_id = membership.user_id
      where membership.company_id = ${input.companyId}
        and membership.revoked_at is null
        and (${admin} or membership.user_id = ${input.userId})
      group by membership.user_id, limits.monthly_limit
      order by membership.user_id
    `;
    const companyUsage = yield* sql<{ readonly used: string | number | bigint }>`
      select coalesce(sum(usage.credits), 0) as used
      from client_credit_usage usage
      where usage.client_company_id = ${input.companyId}
        and (${account.periodStart}::timestamptz is null or usage.created_at >= ${account.periodStart})
        and (${account.periodEnd}::timestamptz is null or usage.created_at < ${account.periodEnd})
    `;
    const lots = yield* sql<{ readonly available: string | number | bigint }>`
      select coalesce(sum(credits_remaining), 0) as available
      from client_credit_lots
      where client_company_id = ${input.companyId}
        and available_at <= now() and expires_at > now() and credits_remaining > 0
    `;
    const requests = yield* sql<{
      readonly id: string;
      readonly userId: string;
      readonly requestedCredits: string | number | bigint;
      readonly reason: string;
      readonly status: AiUsageRequestDescriptor["status"];
      readonly createdAt: Date;
      readonly resolvedAt: Date | null;
    }>`
      select id::text, user_id as "userId", requested_credits as "requestedCredits",
             reason, status, created_at as "createdAt", resolved_at as "resolvedAt"
      from client_ai_usage_requests
      where client_company_id = ${input.companyId}
        and (${admin} or user_id = ${input.userId})
      order by created_at desc, id desc
      limit 200
    `;
    const mappedEmployees = employees.map((employee) => ({
      userId: employee.userId,
      usedCredits: asNumber(employee.used)!,
      monthlyLimit: asNumber(employee.limit),
    }));
    return {
      status: account.status,
      planTier: account.planTier,
      pendingDowngradeTier: account.pendingDowngradeTier,
      periodStart: account.periodStart?.toISOString() ?? null,
      periodEnd: account.periodEnd?.toISOString() ?? null,
      companyMonthlyLimit: asNumber(account.companyLimit),
      // Company gating is ledger-wide. Membership removal only changes the
      // current employee breakdown; it never erases retained period usage.
      companyUsedCredits: asNumber(companyUsage[0]?.used ?? 0)!,
      availableCredits: asNumber(lots[0]?.available ?? 0)!,
      employees: mappedEmployees,
      requests: requests.map((row) => ({
        ...row,
        requestedCredits: asNumber(row.requestedCredits)!,
        createdAt: row.createdAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
      })),
    } satisfies AiUsageOverview;
  });

export const loadAiUsageOverview = (input: {
  readonly companyId: string;
  readonly userId: string;
  readonly authorize: SqlEffect;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`brief:client-members:${input.companyId}`}))
        `;
        yield* input.authorize;
        return yield* loadAiUsageOverviewLocked(input);
      }),
    );
  });

export const updateAiLimit = (input: {
  readonly companyId: string;
  readonly actorUserId: string;
  readonly employeeUserId: string | null;
  readonly limit: number | null;
  readonly authorize: SqlEffect;
  readonly audit: SqlEffect;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`brief:client-members:${input.companyId}`}))
        `;
        yield* input.authorize;
        if (input.employeeUserId !== null) {
          const rows = yield* sql<{ readonly userId: string }>`
            insert into client_employee_ai_limits (
              client_company_id, user_id, monthly_limit, updated_by_user_id
            )
            select ${input.companyId}, membership.user_id, ${input.limit}, ${input.actorUserId}
            from client_company_memberships membership
            join platform_users users
              on users.id = membership.user_id
             and users.recovery_deleted_at is null and users.purged_at is null
            where membership.company_id = ${input.companyId}
              and membership.user_id = ${input.employeeUserId}
              and membership.revoked_at is null
            on conflict (client_company_id, user_id) do update set
              monthly_limit = excluded.monthly_limit,
              updated_by_user_id = excluded.updated_by_user_id,
              updated_at = now()
            returning user_id as "userId"
          `;
          if (rows[0] === undefined) return false;
        } else {
          yield* sql`
            insert into client_ai_billing_accounts (client_company_id, company_monthly_limit)
            values (${input.companyId}, ${input.limit})
            on conflict (client_company_id) do update set
              company_monthly_limit = excluded.company_monthly_limit, updated_at = now()
          `;
        }
        yield* input.audit;
        return true;
      }),
    );
  });

export interface AiUsageRequestRow {
  readonly id: string;
  readonly userId: string;
  readonly requestedCredits: string | number | bigint;
  readonly reason: string;
  readonly status: AiUsageRequestDescriptor["status"];
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

export const createAiUsageRequest = (input: {
  readonly companyId: string;
  readonly userId: string;
  readonly requestedCredits: number;
  readonly reason: string;
  readonly authorize: SqlEffect;
  readonly audit: (requestId: string) => SqlEffect;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`brief:client-members:${input.companyId}`}))
        `;
        yield* input.authorize;
        const rows = yield* sql<AiUsageRequestRow>`
          insert into client_ai_usage_requests (
            client_company_id, user_id, requested_credits, reason
          ) values (
            ${input.companyId}, ${input.userId}, ${input.requestedCredits}, ${input.reason.trim()}
          )
          on conflict (client_company_id, user_id) where status = 'pending' do update set
            requested_credits = excluded.requested_credits,
            reason = excluded.reason,
            created_at = now()
          returning id::text, user_id as "userId", requested_credits as "requestedCredits",
                    reason, status, created_at as "createdAt", resolved_at as "resolvedAt"
        `;
        const row = rows[0]!;
        yield* input.audit(row.id);
        return row;
      }),
    );
  });

export const aiUsageRequestDescriptor = (row: AiUsageRequestRow): AiUsageRequestDescriptor => ({
  ...row,
  requestedCredits: asNumber(row.requestedCredits)!,
  createdAt: row.createdAt.toISOString(),
  resolvedAt: row.resolvedAt?.toISOString() ?? null,
});

export const resolveAiUsageRequest = (input: {
  readonly companyId: string;
  readonly usageRequestId: string;
  readonly actorUserId: string;
  readonly decision: "approved" | "denied";
  readonly authorize: SqlEffect;
  readonly audit: SqlEffect;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`brief:client-members:${input.companyId}`}))
        `;
        yield* input.authorize;
        const rows = yield* sql<{ readonly id: string }>`
          update client_ai_usage_requests
          set status = ${input.decision}, resolved_by_user_id = ${input.actorUserId},
              resolved_at = now()
          where id = ${input.usageRequestId}
            and client_company_id = ${input.companyId}
            and status = 'pending'
          returning id::text
        `;
        if (rows[0] === undefined) return false;
        yield* input.audit;
        return true;
      }),
    );
  });

export type BillingPlanPrices = Readonly<Record<AiPlanTier, string>>;

const tierRank: Readonly<Record<AiPlanTier, number>> = {
  light: 0,
  team: 1,
  intensive: 2,
};

const compareTiers = (left: AiPlanTier, right: AiPlanTier): -1 | 0 | 1 => {
  const difference = tierRank[left] - tierRank[right];
  return difference === 0 ? 0 : difference < 0 ? -1 : 1;
};

const storedPlanChange = (input: {
  readonly outcome: MonthlyPlanChangeDescriptor["status"];
  readonly previousTier: AiPlanTier;
  readonly targetTier: AiPlanTier;
  readonly effectiveAt: Date | null;
}): MonthlyPlanChangeDescriptor => {
  if (input.outcome === "unchanged" && input.effectiveAt === null) {
    return {
      status: "unchanged",
      previousTier: input.previousTier,
      planTier: input.targetTier,
      effectiveAt: null,
    };
  }
  if (input.outcome === "upgraded" && input.effectiveAt !== null) {
    return {
      status: "upgraded",
      previousTier: input.previousTier,
      planTier: input.targetTier,
      effectiveAt: input.effectiveAt.toISOString(),
    };
  }
  if (input.outcome === "downgrade_scheduled" && input.effectiveAt !== null) {
    return {
      status: "downgrade_scheduled",
      previousTier: input.previousTier,
      planTier: input.targetTier,
      effectiveAt: input.effectiveAt.toISOString(),
    };
  }
  throw new Error("billing_plan_change_record_invalid");
};

export interface BillingPlanChangeGatewayInput {
  readonly companyId: string;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly currentTier: AiPlanTier;
  readonly targetTier: AiPlanTier;
  readonly currentPriceId: string;
  readonly targetPriceId: string;
  readonly currentPeriodEnd: string;
  readonly idempotencyKey: string;
}

export type BillingPlanChangeGatewayResult =
  | {
      readonly kind: "upgraded";
      readonly effectiveAt: string;
      readonly externalOperationId: string;
    }
  | {
      readonly kind: "downgrade_scheduled";
      readonly effectiveAt: string;
      readonly externalOperationId: string;
    };

export type BillingPlanChangeReservation =
  | { readonly kind: "complete"; readonly change: MonthlyPlanChangeDescriptor }
  | {
      readonly kind: "execute";
      readonly previousTier: AiPlanTier;
      readonly gatewayInput: BillingPlanChangeGatewayInput;
    };

export const reserveMonthlyPlanChange = (input: {
  readonly companyId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly authorizationRequestId: string;
  readonly targetTier: AiPlanTier;
  readonly idempotencyKey: string;
  readonly prices: BillingPlanPrices;
  readonly gatewayAvailable: boolean;
  readonly authorize: SqlEffect;
  readonly accountMissingError: unknown;
  readonly auditSucceeded: (outcome: MonthlyPlanChangeDescriptor["status"]) => SqlEffect;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`brief:client-members:${input.companyId}`}))
        `;
        yield* input.authorize;
        const rows = yield* sql<{
          readonly customerId: string | null;
          readonly subscriptionId: string | null;
          readonly currentTier: AiPlanTier | null;
          readonly currentPriceId: string | null;
          readonly status: string;
          readonly periodEnd: Date | null;
          readonly pendingDowngradeTier: AiPlanTier | null;
          readonly pendingDowngradeScheduleId: string | null;
        }>`
          select company.stripe_customer_id as "customerId",
                 billing.stripe_subscription_id as "subscriptionId",
                 billing.plan_tier as "currentTier", billing.stripe_price_id as "currentPriceId",
                 billing.status, billing.current_period_end as "periodEnd",
                 billing.pending_downgrade_tier as "pendingDowngradeTier",
                 billing.pending_downgrade_schedule_id as "pendingDowngradeScheduleId"
          from client_companies company
          join client_ai_billing_accounts billing on billing.client_company_id = company.id
          where company.id = ${input.companyId} and company.recovery_deleted_at is null
          for update of billing
        `;
        const account = rows[0];
        if (account === undefined) return yield* Effect.fail(input.accountMissingError);

        const existing = yield* sql<{
          readonly targetTier: AiPlanTier;
          readonly previousTier: AiPlanTier;
          readonly status: "processing" | "succeeded" | "failed";
          readonly outcome: MonthlyPlanChangeDescriptor["status"] | null;
          readonly effectiveAt: Date | null;
          readonly leaseFresh: boolean;
          readonly customerId: string | null;
          readonly subscriptionId: string | null;
          readonly previousPriceId: string | null;
          readonly targetPriceId: string | null;
          readonly currentPeriodEnd: Date | null;
        }>`
          select target_tier as "targetTier", previous_tier as "previousTier", status,
                 outcome, effective_at as "effectiveAt",
                 updated_at > now() - interval '5 minutes' as "leaseFresh",
                 stripe_customer_id as "customerId", stripe_subscription_id as "subscriptionId",
                 previous_price_id as "previousPriceId", target_price_id as "targetPriceId",
                 current_period_end as "currentPeriodEnd"
          from client_ai_plan_change_requests
          where client_company_id = ${input.companyId}
            and idempotency_key = ${input.idempotencyKey}
          for update
        `;
        const prior = existing[0];
        if (prior !== undefined && prior.targetTier !== input.targetTier) {
          return yield* Effect.fail(new Error("plan_change_idempotency_conflict"));
        }
        if (prior?.status === "succeeded" && prior.outcome !== null) {
          const change = storedPlanChange({
            outcome: prior.outcome,
            previousTier: prior.previousTier,
            targetTier: prior.targetTier,
            effectiveAt: prior.effectiveAt,
          });
          yield* input.auditSucceeded(change.status);
          return { kind: "complete", change } satisfies BillingPlanChangeReservation;
        }
        if (prior?.status === "processing" && prior.leaseFresh) {
          return yield* Effect.fail(new Error("plan_change_in_progress"));
        }
        const otherProcessing = yield* sql<{
          readonly id: string;
          readonly requestedByUserId: string;
          readonly authorizationRequestId: string;
          readonly authorizationSessionId: string;
          readonly leaseFresh: boolean;
        }>`
          select id::text, requested_by_user_id as "requestedByUserId",
                 authorization_request_id::text as "authorizationRequestId",
                 authorization_session_id as "authorizationSessionId",
                 updated_at > now() - interval '5 minutes' as "leaseFresh"
          from client_ai_plan_change_requests
          where client_company_id = ${input.companyId}
            and status = 'processing' and idempotency_key <> ${input.idempotencyKey}
          for update
        `;
        const competing = otherProcessing[0];
        if (competing !== undefined) {
          if (competing.leaseFresh) return yield* Effect.fail(new Error("plan_change_in_progress"));
          yield* sql`
            update client_ai_plan_change_requests
            set status = 'failed', error_code = 'request_abandoned', updated_at = now()
            where id = ${competing.id} and status = 'processing'
          `;
          yield* sql`
            insert into platform_authorization_audit_log (
              actor_user_id, session_id, request_id, action,
              scope_kind, scope_id, outcome, reason_code
            ) values (
              ${competing.requestedByUserId}, ${competing.authorizationSessionId},
              ${competing.authorizationRequestId}::uuid, 'client.billing.plan_change',
              'client_company', ${input.companyId}, 'denied', 'request_abandoned'
            )
            on conflict (request_id, action, scope_kind, scope_id) do nothing
          `;
        }
        if (account.currentTier === null) {
          return yield* Effect.fail(new Error("billing_subscription_missing"));
        }
        const previousTier = prior?.previousTier ?? account.currentTier;
        const direction = compareTiers(previousTier, input.targetTier);
        const targetPriceId = input.prices[input.targetTier];
        if (account.pendingDowngradeTier !== null) {
          if (
            direction <= 0 ||
            account.pendingDowngradeTier !== input.targetTier ||
            account.pendingDowngradeScheduleId === null ||
            account.periodEnd === null ||
            account.customerId === null ||
            account.subscriptionId === null ||
            account.currentPriceId === null ||
            account.currentPriceId !== input.prices[previousTier] ||
            targetPriceId === "" ||
            (prior !== undefined &&
              (prior.customerId !== account.customerId ||
                prior.subscriptionId !== account.subscriptionId ||
                prior.previousPriceId !== account.currentPriceId ||
                prior.targetPriceId !== targetPriceId ||
                prior.currentPeriodEnd?.getTime() !== account.periodEnd.getTime()))
          ) {
            return yield* Effect.fail(new Error("plan_change_conflict"));
          }
          if (prior === undefined) {
            yield* sql`
              insert into client_ai_plan_change_requests (
                client_company_id, idempotency_key, requested_by_user_id,
                authorization_request_id, authorization_session_id,
                previous_tier, target_tier, stripe_customer_id,
                stripe_subscription_id, previous_price_id, target_price_id,
                current_period_end, status, outcome, effective_at, external_operation_id
              ) values (
                ${input.companyId}, ${input.idempotencyKey}, ${input.userId},
                ${input.authorizationRequestId}, ${input.sessionId}, ${previousTier},
                ${input.targetTier}, ${account.customerId}, ${account.subscriptionId},
                ${account.currentPriceId}, ${targetPriceId}, ${account.periodEnd},
                'succeeded', 'downgrade_scheduled', ${account.periodEnd},
                ${account.pendingDowngradeScheduleId}
              )
            `;
          } else {
            yield* sql`
              update client_ai_plan_change_requests
              set status = 'succeeded', outcome = 'downgrade_scheduled',
                  effective_at = ${account.periodEnd},
                  external_operation_id = ${account.pendingDowngradeScheduleId},
                  error_code = null, attempts = attempts + 1, updated_at = now()
              where client_company_id = ${input.companyId}
                and idempotency_key = ${input.idempotencyKey}
            `;
          }
          const change = {
            status: "downgrade_scheduled",
            previousTier,
            planTier: input.targetTier,
            effectiveAt: account.periodEnd.toISOString(),
          } satisfies MonthlyPlanChangeDescriptor;
          yield* input.auditSucceeded(change.status);
          return { kind: "complete", change } satisfies BillingPlanChangeReservation;
        }

        if (direction === 0) {
          if (
            prior !== undefined &&
            (prior.customerId !== null ||
              prior.subscriptionId !== null ||
              prior.previousPriceId !== null ||
              prior.targetPriceId !== null ||
              prior.currentPeriodEnd !== null)
          ) {
            return yield* Effect.fail(new Error("plan_change_idempotency_conflict"));
          }
          const change = {
            status: "unchanged",
            previousTier,
            planTier: input.targetTier,
            effectiveAt: null,
          } satisfies MonthlyPlanChangeDescriptor;
          if (prior === undefined) {
            yield* sql`
              insert into client_ai_plan_change_requests (
                client_company_id, idempotency_key, requested_by_user_id,
                authorization_request_id, authorization_session_id,
                previous_tier, target_tier, status, outcome
              ) values (
                ${input.companyId}, ${input.idempotencyKey}, ${input.userId},
                ${input.authorizationRequestId}, ${input.sessionId},
                ${previousTier}, ${input.targetTier}, 'succeeded', 'unchanged'
              )
            `;
          } else {
            yield* sql`
              update client_ai_plan_change_requests
              set status = 'succeeded', outcome = 'unchanged', effective_at = null,
                  external_operation_id = null, error_code = null,
                  attempts = attempts + 1, updated_at = now()
              where client_company_id = ${input.companyId}
                and idempotency_key = ${input.idempotencyKey}
            `;
          }
          yield* input.auditSucceeded(change.status);
          return { kind: "complete", change } satisfies BillingPlanChangeReservation;
        }

        const expectedCurrentPriceId = input.prices[account.currentTier];
        if (!input.gatewayAvailable || targetPriceId === "" || expectedCurrentPriceId === "") {
          return yield* Effect.fail(new Error("billing_unavailable"));
        }
        let gatewayInput: BillingPlanChangeGatewayInput;
        if (prior === undefined) {
          if (
            account.customerId === null ||
            account.subscriptionId === null ||
            account.currentPriceId !== expectedCurrentPriceId ||
            (account.status !== "active" && !(direction > 0 && account.status === "trialing")) ||
            account.periodEnd === null
          ) {
            return yield* Effect.fail(new Error("billing_subscription_ambiguous"));
          }
          gatewayInput = {
            companyId: input.companyId,
            customerId: account.customerId,
            subscriptionId: account.subscriptionId,
            currentTier: previousTier,
            targetTier: input.targetTier,
            currentPriceId: account.currentPriceId,
            targetPriceId,
            currentPeriodEnd: account.periodEnd.toISOString(),
            idempotencyKey: input.idempotencyKey,
          };
          yield* sql`
            insert into client_ai_plan_change_requests (
              client_company_id, idempotency_key, requested_by_user_id,
              authorization_request_id, authorization_session_id,
              previous_tier, target_tier, stripe_customer_id,
              stripe_subscription_id, previous_price_id, target_price_id,
              current_period_end, status
            ) values (
              ${input.companyId}, ${input.idempotencyKey}, ${input.userId},
              ${input.authorizationRequestId}, ${input.sessionId}, ${previousTier},
              ${input.targetTier}, ${gatewayInput.customerId}, ${gatewayInput.subscriptionId},
              ${gatewayInput.currentPriceId}, ${gatewayInput.targetPriceId},
              ${account.periodEnd}, 'processing'
            )
          `;
        } else {
          if (
            prior.customerId === null ||
            prior.subscriptionId === null ||
            prior.previousPriceId === null ||
            prior.targetPriceId !== targetPriceId ||
            prior.currentPeriodEnd === null ||
            prior.previousPriceId !== input.prices[prior.previousTier] ||
            account.customerId !== prior.customerId ||
            account.subscriptionId !== prior.subscriptionId ||
            (account.status !== "active" && !(direction > 0 && account.status === "trialing")) ||
            account.periodEnd?.getTime() !== prior.currentPeriodEnd.getTime() ||
            !(
              (account.currentTier === prior.previousTier &&
                account.currentPriceId === prior.previousPriceId) ||
              (direction < 0 &&
                account.currentTier === input.targetTier &&
                account.currentPriceId === prior.targetPriceId)
            )
          ) {
            return yield* Effect.fail(new Error("billing_subscription_ambiguous"));
          }
          gatewayInput = {
            companyId: input.companyId,
            customerId: prior.customerId,
            subscriptionId: prior.subscriptionId,
            currentTier: prior.previousTier,
            targetTier: prior.targetTier,
            currentPriceId: prior.previousPriceId,
            targetPriceId: prior.targetPriceId,
            currentPeriodEnd: prior.currentPeriodEnd.toISOString(),
            idempotencyKey: input.idempotencyKey,
          };
          yield* sql`
            update client_ai_plan_change_requests
            set status = 'processing', outcome = null, effective_at = null,
                external_operation_id = null, error_code = null,
                attempts = attempts + 1, updated_at = now()
            where client_company_id = ${input.companyId}
              and idempotency_key = ${input.idempotencyKey}
          `;
        }
        return {
          kind: "execute",
          previousTier,
          gatewayInput,
        } satisfies BillingPlanChangeReservation;
      }),
    );
  });

export const failMonthlyPlanChange = (input: {
  readonly companyId: string;
  readonly idempotencyKey: string;
  readonly errorCode: "stripe_request_failed";
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      update client_ai_plan_change_requests
      set status = 'failed', error_code = ${input.errorCode}, updated_at = now()
      where client_company_id = ${input.companyId}
        and idempotency_key = ${input.idempotencyKey}
        and status = 'processing'
    `;
  });

export const finalizeMonthlyPlanChange = (input: {
  readonly companyId: string;
  readonly targetTier: AiPlanTier;
  readonly targetPriceId: string;
  readonly idempotencyKey: string;
  readonly executable: Extract<BillingPlanChangeReservation, { readonly kind: "execute" }>;
  readonly gatewayResult: BillingPlanChangeGatewayResult;
  readonly auditSucceeded: (outcome: MonthlyPlanChangeDescriptor["status"]) => SqlEffect;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const accounts = yield* sql<{
          readonly currentTier: AiPlanTier | null;
          readonly subscriptionId: string | null;
          readonly currentPriceId: string | null;
          readonly pendingDowngradeTier: AiPlanTier | null;
          readonly pendingDowngradeScheduleId: string | null;
          readonly currentPeriodEnd: Date | null;
        }>`
          select plan_tier as "currentTier", stripe_subscription_id as "subscriptionId",
                 stripe_price_id as "currentPriceId",
                 pending_downgrade_tier as "pendingDowngradeTier",
                 pending_downgrade_schedule_id as "pendingDowngradeScheduleId",
                 current_period_end as "currentPeriodEnd"
          from client_ai_billing_accounts
          where client_company_id = ${input.companyId}
          for update
        `;
        const account = accounts[0];
        const requests = yield* sql<{
          readonly status: "processing" | "succeeded" | "failed";
          readonly outcome: MonthlyPlanChangeDescriptor["status"] | null;
          readonly previousTier: AiPlanTier;
          readonly targetTier: AiPlanTier;
          readonly effectiveAt: Date | null;
          readonly externalOperationId: string | null;
        }>`
          select status, outcome, previous_tier as "previousTier",
                 target_tier as "targetTier", effective_at as "effectiveAt",
                 external_operation_id as "externalOperationId"
          from client_ai_plan_change_requests
          where client_company_id = ${input.companyId}
            and idempotency_key = ${input.idempotencyKey}
          for update
        `;
        const planRequest = requests[0];
        if (planRequest?.status === "succeeded" && planRequest.outcome !== null) {
          const reconciled = storedPlanChange({
            outcome: planRequest.outcome,
            previousTier: planRequest.previousTier,
            targetTier: planRequest.targetTier,
            effectiveAt: planRequest.effectiveAt,
          });
          if (
            reconciled.status !== input.gatewayResult.kind ||
            reconciled.effectiveAt !== input.gatewayResult.effectiveAt ||
            planRequest.externalOperationId !== input.gatewayResult.externalOperationId
          ) {
            return yield* Effect.fail(new Error("billing_state_changed"));
          }
          yield* input.auditSucceeded(reconciled.status);
          return reconciled;
        }
        if (planRequest?.status !== "processing") {
          return yield* Effect.fail(new Error("billing_state_changed"));
        }
        const accountIsOriginalState =
          account?.currentTier === input.executable.previousTier &&
          account.currentPriceId === input.executable.gatewayInput.currentPriceId;
        const accountIsUpgradeReplayState =
          input.gatewayResult.kind === "upgraded" &&
          account?.currentTier === input.executable.gatewayInput.targetTier &&
          account.currentPriceId === input.executable.gatewayInput.targetPriceId;
        const pendingStateValid =
          account?.pendingDowngradeTier === null ||
          (input.gatewayResult.kind === "downgrade_scheduled" &&
            account?.pendingDowngradeTier === input.executable.gatewayInput.targetTier &&
            account.pendingDowngradeScheduleId === input.gatewayResult.externalOperationId);
        if (
          account === undefined ||
          (!accountIsOriginalState && !accountIsUpgradeReplayState) ||
          account.subscriptionId !== input.executable.gatewayInput.subscriptionId ||
          account.currentPeriodEnd?.toISOString() !==
            input.executable.gatewayInput.currentPeriodEnd ||
          !pendingStateValid
        ) {
          return yield* Effect.fail(new Error("billing_state_changed"));
        }
        if (input.gatewayResult.kind === "upgraded") {
          yield* sql`
            update client_ai_billing_accounts
            set plan_tier = ${input.targetTier}, stripe_price_id = ${input.targetPriceId},
                pending_downgrade_tier = null, pending_downgrade_schedule_id = null,
                updated_at = now()
            where client_company_id = ${input.companyId}
          `;
        } else {
          yield* sql`
            update client_ai_billing_accounts
            set pending_downgrade_tier = ${input.targetTier},
                pending_downgrade_schedule_id = ${input.gatewayResult.externalOperationId},
                updated_at = now()
            where client_company_id = ${input.companyId}
          `;
        }
        const change = {
          status: input.gatewayResult.kind,
          previousTier: input.executable.previousTier,
          planTier: input.targetTier,
          effectiveAt: input.gatewayResult.effectiveAt,
        } satisfies MonthlyPlanChangeDescriptor;
        const completed = yield* sql<{ readonly id: string }>`
          update client_ai_plan_change_requests
          set status = 'succeeded', outcome = ${change.status},
              effective_at = ${new Date(change.effectiveAt)},
              external_operation_id = ${input.gatewayResult.externalOperationId},
              error_code = null, updated_at = now()
          where client_company_id = ${input.companyId}
            and idempotency_key = ${input.idempotencyKey}
            and status = 'processing'
          returning id::text
        `;
        if (completed.length !== 1) {
          return yield* Effect.fail(new Error("billing_state_changed"));
        }
        yield* input.auditSucceeded(change.status);
        return change;
      }),
    );
  });
