import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";

import { createPlatformNotificationInTransaction } from "./notifications";

export type CreditGateErrorCode =
  | "billing_account_inactive"
  | "billing_period_unavailable"
  | "company_limit_reached"
  | "employee_limit_reached"
  | "credits_exhausted"
  | "credit_idempotency_conflict"
  | "credit_request_invalid";

export class CreditGateError extends Error {
  readonly name = "CreditGateError";
  constructor(readonly code: CreditGateErrorCode) {
    super(code);
  }
}

interface BillingAccountRow {
  readonly status: string;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly companyLimit: string | number | bigint | null;
}

interface CreditLotRow {
  readonly id: string;
  readonly kind: "monthly" | "additional";
  readonly remaining: string | number | bigint;
}

const asSafeInteger = (value: string | number | bigint): number => {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) throw new CreditGateError("credit_request_invalid");
  return numeric;
};

const requireCreditAmount = (credits: number): void => {
  if (!Number.isSafeInteger(credits) || credits <= 0) {
    throw new CreditGateError("credit_request_invalid");
  }
};

export interface ConsumeCreditsInput {
  readonly clientCompanyId: string;
  readonly userId: string;
  readonly aiRunId: string;
  readonly credits: number;
  readonly calculationVersion: string;
  readonly calculationInputs: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly now?: Date;
}

export const consumeCredits = (input: ConsumeCreditsInput) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* Effect.try({
      try: () => requireCreditAmount(input.credits),
      catch: (error) => error,
    });
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const now = input.now ?? new Date();
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`brief:credits:${input.clientCompanyId}`}))
        `;
        yield* sql`
          select pg_advisory_xact_lock(
            hashtext(${`brief:client-members:${input.clientCompanyId}`})
          )
        `;
        const prior = yield* sql<{
          readonly id: string;
          readonly clientCompanyId: string;
          readonly userId: string;
          readonly aiRunIdentity: string;
          readonly credits: string | number | bigint;
          readonly calculationVersion: string;
          readonly inputsMatch: boolean;
        }>`
          select id::text,
                 client_company_id::text as "clientCompanyId",
                 user_id as "userId",
                 ai_run_identity::text as "aiRunIdentity",
                 credits,
                 calculation_version as "calculationVersion",
                 calculation_inputs = ${sql.json(input.calculationInputs)}::jsonb as "inputsMatch"
          from client_credit_usage
          where idempotency_key = ${input.idempotencyKey}
        `;
        if (prior[0] !== undefined) {
          const row = prior[0];
          if (
            row.clientCompanyId !== input.clientCompanyId ||
            row.userId !== input.userId ||
            row.aiRunIdentity !== input.aiRunId ||
            asSafeInteger(row.credits) !== input.credits ||
            row.calculationVersion !== input.calculationVersion ||
            !row.inputsMatch
          ) {
            return yield* Effect.fail(new CreditGateError("credit_idempotency_conflict"));
          }
          const allocations = yield* sql<{
            readonly creditLotId: string;
            readonly credits: string | number | bigint;
          }>`
            select credit_lot_id::text as "creditLotId", credits
            from client_credit_usage_allocations
            where usage_id = ${row.id}
            order by credit_lot_id
          `;
          return {
            usageId: row.id,
            idempotent: true,
            allocations: allocations.map((allocation) => ({
              creditLotId: allocation.creditLotId,
              credits: asSafeInteger(allocation.credits),
            })),
          };
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
          return yield* Effect.fail(new CreditGateError("billing_account_inactive"));
        }

        const accounts = yield* sql<BillingAccountRow>`
          select status,
                 current_period_start as "periodStart",
                 current_period_end as "periodEnd",
                 company_monthly_limit as "companyLimit"
          from client_ai_billing_accounts
          where client_company_id = ${input.clientCompanyId}
          for update
        `;
        const account = accounts[0];
        if (
          account === undefined ||
          (account.status !== "active" && account.status !== "trialing")
        ) {
          return yield* Effect.fail(new CreditGateError("billing_account_inactive"));
        }
        if (
          account.periodStart === null ||
          account.periodEnd === null ||
          now < account.periodStart ||
          now >= account.periodEnd
        ) {
          return yield* Effect.fail(new CreditGateError("billing_period_unavailable"));
        }

        const usage = yield* sql<{
          readonly companyUsed: string | number | bigint;
          readonly employeeUsed: string | number | bigint;
          readonly employeeLimit: string | number | bigint | null;
        }>`
          select
            coalesce((
              select sum(credits) from client_credit_usage
              where client_company_id = ${input.clientCompanyId}
                and created_at >= ${account.periodStart}
                and created_at < ${account.periodEnd}
            ), 0) as "companyUsed",
            coalesce((
              select sum(credits) from client_credit_usage
              where client_company_id = ${input.clientCompanyId}
                and user_id = ${input.userId}
                and created_at >= ${account.periodStart}
                and created_at < ${account.periodEnd}
            ), 0) as "employeeUsed",
            (
              select monthly_limit from client_employee_ai_limits
              where client_company_id = ${input.clientCompanyId} and user_id = ${input.userId}
            ) as "employeeLimit"
        `;
        const totals = usage[0]!;
        if (
          account.companyLimit !== null &&
          asSafeInteger(totals.companyUsed) + input.credits > asSafeInteger(account.companyLimit)
        ) {
          return yield* Effect.fail(new CreditGateError("company_limit_reached"));
        }
        if (
          totals.employeeLimit !== null &&
          asSafeInteger(totals.employeeUsed) + input.credits > asSafeInteger(totals.employeeLimit)
        ) {
          return yield* Effect.fail(new CreditGateError("employee_limit_reached"));
        }

        const lots = yield* sql<CreditLotRow>`
          select id::text, kind, credits_remaining as remaining
          from client_credit_lots
          where client_company_id = ${input.clientCompanyId}
            and available_at <= ${now}
            and expires_at > ${now}
            and credits_remaining > 0
          order by case kind when 'monthly' then 0 else 1 end,
                   expires_at asc,
                   created_at asc,
                   id asc
          for update
        `;
        const available = lots.reduce((total, lot) => total + asSafeInteger(lot.remaining), 0);
        if (available < input.credits) {
          return yield* Effect.fail(new CreditGateError("credits_exhausted"));
        }

        const inserted = yield* sql<{ readonly id: string }>`
          insert into client_credit_usage (
            client_company_id,
            user_id,
            ai_run_id,
            ai_run_identity,
            credits,
            calculation_version,
            calculation_inputs,
            idempotency_key,
            created_at
          ) values (
            ${input.clientCompanyId},
            ${input.userId},
            ${input.aiRunId},
            ${input.aiRunId},
            ${input.credits},
            ${input.calculationVersion},
            ${sql.json(input.calculationInputs)},
            ${input.idempotencyKey},
            ${now}
          )
          returning id::text
        `;
        const usageId = inserted[0]!.id;
        let remaining = input.credits;
        const allocations: Array<{ readonly creditLotId: string; readonly credits: number }> = [];
        for (const lot of lots) {
          if (remaining === 0) break;
          const allocated = Math.min(remaining, asSafeInteger(lot.remaining));
          yield* sql`
            update client_credit_lots
            set credits_remaining = credits_remaining - ${allocated}
            where id = ${lot.id}
          `;
          yield* sql`
            insert into client_credit_usage_allocations (
              usage_id, credit_lot_id, client_company_id, credits
            )
            values (${usageId}, ${lot.id}, ${input.clientCompanyId}, ${allocated})
          `;
          allocations.push({ creditLotId: lot.id, credits: allocated });
          remaining -= allocated;
        }
        const companyUsedAfter = asSafeInteger(totals.companyUsed) + input.credits;
        const employeeUsedAfter = asSafeInteger(totals.employeeUsed) + input.credits;
        const availableAfter = available - input.credits;
        const reachedLimit =
          availableAfter === 0 ||
          (account.companyLimit !== null &&
            companyUsedAfter === asSafeInteger(account.companyLimit)) ||
          (totals.employeeLimit !== null &&
            employeeUsedAfter === asSafeInteger(totals.employeeLimit));
        if (reachedLimit) {
          const admins = yield* sql<{ readonly userId: string }>`
            select memberships.user_id as "userId"
            from client_company_memberships memberships
            join platform_users users
              on users.id = memberships.user_id
             and users.recovery_deleted_at is null
             and users.purged_at is null
            where memberships.company_id = ${input.clientCompanyId}
              and memberships.role = 'admin' and memberships.revoked_at is null
            order by memberships.user_id
          `;
          const recipients = new Set([input.userId, ...admins.map((admin) => admin.userId)]);
          const periodKey = account.periodStart.toISOString();
          for (const userId of [...recipients].sort()) {
            const deduplicationHash = createHash("sha256")
              .update([input.clientCompanyId, periodKey, userId].join("\0"), "utf8")
              .digest("hex");
            yield* createPlatformNotificationInTransaction({
              clientCompanyId: input.clientCompanyId,
              userId,
              kind: "usage_limit_reached",
              deduplicationKey: `usage-limit-reached:${deduplicationHash}`,
            });
          }
        }
        return { usageId, idempotent: false, allocations };
      }),
    );
  });

const recordProcessingError = (stripeEventId: string, error: unknown) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const candidate =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : error instanceof Error
          ? error.message
          : "unknown_error";
    const code = /^stripe_[a-z0-9_]{1,160}$/.test(candidate)
      ? candidate
      : "stripe_processing_failed";
    yield* sql`
      update stripe_webhook_events
      set processing_error_code = ${code.slice(0, 200)}
      where stripe_event_id = ${stripeEventId} and processed_at is null
    `;
  });

const objectValue = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("stripe_payload_invalid");
  }
  return value as Record<string, unknown>;
};

const stringValue = (value: unknown, code: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
};

const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const objectId = (value: unknown, code: string): string => {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return stringValue((value as Record<string, unknown>).id, code);
  }
  throw new Error(code);
};

const positiveInteger = (value: unknown, code: string): number => {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(code);
  }
  return parsed;
};

const timestamp = (value: unknown, code: string): Date => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(code);
  }
  return new Date(value * 1000);
};

const stripeStatus = (
  value: unknown,
): "inactive" | "trialing" | "active" | "past_due" | "paused" | "cancelled" => {
  if (value === "trialing" || value === "active" || value === "past_due" || value === "paused") {
    return value;
  }
  if (value === "canceled") return "cancelled";
  return "inactive";
};

const planTier = (value: unknown): "light" | "team" | "intensive" | null =>
  value === "light" || value === "team" || value === "intensive" ? value : null;

const planTierRank = { light: 0, team: 1, intensive: 2 } as const;

const stripeObject = (payload: Record<string, unknown>) =>
  objectValue(objectValue(objectValue(payload).data).object);

const companyIdForCustomer = (customerId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly id: string }>`
      select id::text
      from client_companies
      where stripe_customer_id = ${customerId}
        and recovery_deleted_at is null
        and purged_at is null
    `;
    if (rows[0] === undefined) return yield* Effect.fail(new Error("stripe_customer_not_mapped"));
    return rows[0].id;
  });

const processSubscription = (payload: Record<string, unknown>, deleted: boolean) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const object = stripeObject(payload);
    const customerId = stringValue(object.customer, "stripe_subscription_customer_missing");
    const companyId = yield* companyIdForCustomer(customerId);
    const existingAccounts = yield* sql<{
      readonly currentTier: "light" | "team" | "intensive" | null;
      readonly currentPriceId: string | null;
      readonly subscriptionId: string | null;
      readonly status: "inactive" | "trialing" | "active" | "past_due" | "paused" | "cancelled";
      readonly periodEnd: Date | null;
      readonly pendingTier: "light" | "team" | "intensive" | null;
      readonly pendingScheduleId: string | null;
    }>`
      select plan_tier as "currentTier", stripe_price_id as "currentPriceId",
             stripe_subscription_id as "subscriptionId", status,
             current_period_end as "periodEnd",
             pending_downgrade_tier as "pendingTier",
             pending_downgrade_schedule_id as "pendingScheduleId"
      from client_ai_billing_accounts
      where client_company_id = ${companyId}
      for update
    `;
    const existingAccount = existingAccounts[0];
    const metadata = objectValue(object.metadata ?? {});
    if (
      metadata.brief_client_company_id !== undefined &&
      metadata.brief_client_company_id !== companyId
    ) {
      throw new Error("stripe_subscription_company_mismatch");
    }
    const items = objectValue(object.items ?? {});
    const itemRows = Array.isArray(items.data) ? items.data : [];
    if (itemRows.length !== 1) throw new Error("stripe_subscription_items_ambiguous");
    const firstItem = objectValue(itemRows[0]);
    if (positiveInteger(firstItem.quantity ?? 1, "stripe_subscription_quantity_invalid") !== 1) {
      throw new Error("stripe_subscription_quantity_invalid");
    }
    const price = objectValue(firstItem.price ?? {});
    const metadataTier = planTier(metadata.brief_plan_tier);
    const priceTier = planTier(objectValue(price.metadata ?? {}).brief_plan_tier);
    if (metadataTier === null || priceTier === null) {
      throw new Error("stripe_plan_tier_missing");
    }
    if (metadataTier !== priceTier) {
      throw new Error("stripe_plan_tier_mismatch");
    }
    const tier = metadataTier;
    const status = deleted ? "cancelled" : stripeStatus(object.status);
    const periodStart = timestamp(firstItem.current_period_start, "stripe_period_start_missing");
    const periodEnd = timestamp(firstItem.current_period_end, "stripe_period_end_missing");
    if (periodEnd <= periodStart) throw new Error("stripe_subscription_period_invalid");
    const priceId = objectId(price, "stripe_subscription_price_missing");
    const subscriptionId = stringValue(object.id, "stripe_subscription_id_missing");
    const planChangeKey = optionalString(metadata.brief_plan_change_key);
    const subscriptionChanged =
      existingAccount?.subscriptionId !== null &&
      existingAccount?.subscriptionId !== undefined &&
      existingAccount.subscriptionId !== subscriptionId;
    const terminalReplacement =
      subscriptionChanged &&
      (existingAccount.status === "inactive" || existingAccount.status === "cancelled") &&
      existingAccount.pendingTier === null &&
      existingAccount.pendingScheduleId === null &&
      metadata.brief_client_company_id === companyId &&
      metadata.brief_purchase_kind === "monthly_plan" &&
      planChangeKey === null;
    if (
      subscriptionChanged &&
      terminalReplacement &&
      status !== "active" &&
      status !== "trialing"
    ) {
      return;
    }
    if (
      subscriptionChanged &&
      (!terminalReplacement || (status !== "active" && status !== "trialing"))
    ) {
      throw new Error("stripe_subscription_replacement_unrecognized");
    }
    if (
      existingAccount?.status === "cancelled" &&
      existingAccount.subscriptionId === subscriptionId &&
      (status === "active" || status === "trialing")
    ) {
      throw new Error("stripe_subscription_reactivation_requires_replacement");
    }
    if (planChangeKey !== null) {
      const requests = yield* sql<{
        readonly previousTier: "light" | "team" | "intensive";
        readonly targetTier: "light" | "team" | "intensive";
        readonly subscriptionId: string | null;
        readonly targetPriceId: string | null;
        readonly status: "processing" | "succeeded" | "failed";
      }>`
        select previous_tier as "previousTier", target_tier as "targetTier",
               stripe_subscription_id as "subscriptionId", target_price_id as "targetPriceId",
               status
        from client_ai_plan_change_requests
        where client_company_id = ${companyId} and idempotency_key = ${planChangeKey}
        for update
      `;
      const request = requests[0];
      if (
        request === undefined ||
        optionalString(metadata.brief_plan_previous_tier) !== request.previousTier ||
        request.subscriptionId !== subscriptionId
      ) {
        throw new Error("stripe_plan_change_request_mismatch");
      }
      if (planTierRank[request.previousTier] < planTierRank[request.targetTier]) {
        if (
          tier !== request.targetTier ||
          priceId !== request.targetPriceId ||
          existingAccount === undefined ||
          existingAccount.subscriptionId !== request.subscriptionId
        ) {
          throw new Error("stripe_upgrade_projection_mismatch");
        }
        if (request.status !== "succeeded") {
          yield* sql`
            update client_ai_billing_accounts
            set status = ${status}, current_period_start = ${periodStart},
                current_period_end = ${periodEnd}, updated_at = now()
            where client_company_id = ${companyId}
          `;
          return;
        }
      }
    }
    const tierOrPriceChanged =
      existingAccount !== undefined &&
      existingAccount.currentTier !== null &&
      (existingAccount.currentTier !== tier || existingAccount.currentPriceId !== priceId);
    if (
      tierOrPriceChanged &&
      existingAccount.pendingTier === tier &&
      (status === "active" || status === "trialing")
    ) {
      const ownedRequests = yield* sql<{
        readonly idempotencyKey: string;
        readonly previousTier: "light" | "team" | "intensive";
        readonly targetTier: "light" | "team" | "intensive";
        readonly customerId: string | null;
        readonly subscriptionId: string | null;
        readonly previousPriceId: string | null;
        readonly targetPriceId: string | null;
        readonly periodEnd: Date | null;
        readonly status: "processing" | "succeeded" | "failed";
        readonly outcome: "unchanged" | "upgraded" | "downgrade_scheduled" | null;
        readonly externalOperationId: string | null;
      }>`
        select idempotency_key as "idempotencyKey",
               previous_tier as "previousTier", target_tier as "targetTier",
               stripe_customer_id as "customerId",
               stripe_subscription_id as "subscriptionId",
               previous_price_id as "previousPriceId", target_price_id as "targetPriceId",
               current_period_end as "periodEnd", status, outcome,
               external_operation_id as "externalOperationId"
        from client_ai_plan_change_requests
        where client_company_id = ${companyId}
          and external_operation_id = ${existingAccount.pendingScheduleId}
        for update
      `;
      const request = ownedRequests[0];
      if (
        ownedRequests.length !== 1 ||
        request === undefined ||
        request.status !== "succeeded" ||
        request.outcome !== "downgrade_scheduled" ||
        request.previousTier !== existingAccount.currentTier ||
        request.targetTier !== tier ||
        request.customerId !== customerId ||
        request.subscriptionId !== subscriptionId ||
        request.previousPriceId !== existingAccount.currentPriceId ||
        request.targetPriceId !== priceId ||
        request.periodEnd?.getTime() !== existingAccount.periodEnd?.getTime() ||
        periodStart.getTime() !== request.periodEnd?.getTime() ||
        request.externalOperationId !== existingAccount.pendingScheduleId ||
        (planChangeKey !== null && planChangeKey !== request.idempotencyKey)
      ) {
        throw new Error("stripe_downgrade_projection_mismatch");
      }
    }
    if (
      tierOrPriceChanged &&
      !terminalReplacement &&
      !(existingAccount.pendingTier === tier && (status === "active" || status === "trialing"))
    ) {
      throw new Error("stripe_subscription_tier_change_unrecognized");
    }
    yield* sql`
      insert into client_ai_billing_accounts (
        client_company_id, plan_tier, stripe_subscription_id, stripe_price_id,
        status, current_period_start, current_period_end
      ) values (
        ${companyId}, ${tier}, ${subscriptionId},
        ${priceId}, ${status},
        ${periodStart}, ${periodEnd}
      )
      on conflict (client_company_id) do update set
        plan_tier = excluded.plan_tier,
        stripe_subscription_id = excluded.stripe_subscription_id,
        stripe_price_id = excluded.stripe_price_id,
        status = excluded.status,
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end,
        pending_downgrade_tier = case
          when excluded.status not in ('active', 'trialing')
            or client_ai_billing_accounts.pending_downgrade_tier = excluded.plan_tier
          then null
          else client_ai_billing_accounts.pending_downgrade_tier
        end,
        pending_downgrade_schedule_id = case
          when excluded.status not in ('active', 'trialing')
            or client_ai_billing_accounts.pending_downgrade_tier = excluded.plan_tier
          then null
          else client_ai_billing_accounts.pending_downgrade_schedule_id
        end,
        updated_at = now()
    `;
  });

interface DowngradeScheduleSnapshot {
  readonly previousTier: "light" | "team" | "intensive";
  readonly targetTier: "light" | "team" | "intensive";
  readonly previousPriceId: string | null;
  readonly targetPriceId: string | null;
  readonly periodEnd: Date | null;
}

const validateOwnedDowngradeScheduleShape = (
  object: Record<string, unknown>,
  input: {
    readonly companyId: string;
    readonly idempotencyKey: string;
    readonly snapshot: DowngradeScheduleSnapshot;
  },
): { readonly currentPhaseStart: Date; readonly currentPhaseEnd: Date } => {
  const { snapshot } = input;
  const phases = object.phases;
  if (
    snapshot.previousPriceId === null ||
    snapshot.targetPriceId === null ||
    snapshot.periodEnd === null ||
    object.end_behavior !== "release" ||
    !Array.isArray(phases) ||
    phases.length !== 2
  ) {
    throw new Error("stripe_schedule_state_mismatch");
  }
  const currentPhase = objectValue(phases[0]);
  const targetPhase = objectValue(phases[1]);
  const currentItems = Array.isArray(currentPhase.items) ? currentPhase.items : [];
  const targetItems = Array.isArray(targetPhase.items) ? targetPhase.items : [];
  if (currentItems.length !== 1 || targetItems.length !== 1) {
    throw new Error("stripe_schedule_state_mismatch");
  }
  const currentItem = objectValue(currentItems[0]);
  const targetItem = objectValue(targetItems[0]);
  const currentMetadata = objectValue(currentPhase.metadata ?? {});
  const targetMetadata = objectValue(targetPhase.metadata ?? {});
  const currentPhaseStart = timestamp(currentPhase.start_date, "stripe_schedule_phase_invalid");
  const currentPhaseEnd = timestamp(currentPhase.end_date, "stripe_schedule_phase_invalid");
  const targetPhaseStart = timestamp(targetPhase.start_date, "stripe_schedule_phase_invalid");
  if (
    currentPhaseStart >= currentPhaseEnd ||
    currentPhaseEnd.getTime() !== snapshot.periodEnd.getTime() ||
    targetPhaseStart.getTime() !== snapshot.periodEnd.getTime() ||
    currentPhase.proration_behavior !== "none" ||
    targetPhase.proration_behavior !== "none" ||
    currentMetadata.brief_client_company_id !== input.companyId ||
    currentMetadata.brief_plan_change_key !== input.idempotencyKey ||
    currentMetadata.brief_plan_previous_tier !== snapshot.previousTier ||
    currentMetadata.brief_plan_tier !== snapshot.previousTier ||
    targetMetadata.brief_client_company_id !== input.companyId ||
    targetMetadata.brief_plan_change_key !== input.idempotencyKey ||
    targetMetadata.brief_plan_previous_tier !== snapshot.previousTier ||
    targetMetadata.brief_plan_tier !== snapshot.targetTier ||
    positiveInteger(currentItem.quantity ?? 1, "stripe_schedule_quantity_invalid") !== 1 ||
    positiveInteger(targetItem.quantity ?? 1, "stripe_schedule_quantity_invalid") !== 1 ||
    objectId(currentItem.price, "stripe_schedule_price_invalid") !== snapshot.previousPriceId ||
    objectId(targetItem.price, "stripe_schedule_price_invalid") !== snapshot.targetPriceId
  ) {
    throw new Error("stripe_schedule_state_mismatch");
  }
  return { currentPhaseStart, currentPhaseEnd };
};

const processSubscriptionSchedule = (eventType: string, payload: Record<string, unknown>) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const object = stripeObject(payload);
    const metadata = objectValue(object.metadata ?? {});
    const metadataCompanyId = optionalString(metadata.brief_client_company_id);
    const idempotencyKey = optionalString(metadata.brief_plan_change_key);
    const targetTier = planTier(metadata.brief_plan_tier);
    if (metadataCompanyId === null && idempotencyKey === null && targetTier === null) return;
    if (metadataCompanyId === null || idempotencyKey === null || targetTier === null) {
      throw new Error("stripe_schedule_metadata_invalid");
    }
    const scheduleId = stringValue(object.id, "stripe_schedule_id_missing");
    const subscriptionId = objectId(object.subscription, "stripe_schedule_subscription_missing");
    const rows = yield* sql<{
      readonly companyId: string;
      readonly currentTier: "light" | "team" | "intensive" | null;
      readonly currentPriceId: string | null;
      readonly periodEnd: Date | null;
      readonly pendingTier: "light" | "team" | "intensive" | null;
      readonly pendingScheduleId: string | null;
    }>`
      select client_company_id::text as "companyId", plan_tier as "currentTier",
             stripe_price_id as "currentPriceId",
             current_period_end as "periodEnd",
             pending_downgrade_tier as "pendingTier",
             pending_downgrade_schedule_id as "pendingScheduleId"
      from client_ai_billing_accounts
      where stripe_subscription_id = ${subscriptionId}
      for update
    `;
    const account = rows[0];
    if (account === undefined || account.companyId !== metadataCompanyId) {
      return yield* Effect.fail(new Error("stripe_schedule_account_mismatch"));
    }
    const status = String(object.status);
    if (status === "not_started" || status === "active") {
      if (eventType === "subscription_schedule.created") return;
      const requests = yield* sql<{
        readonly previousTier: "light" | "team" | "intensive";
        readonly targetTier: "light" | "team" | "intensive";
        readonly previousPriceId: string | null;
        readonly targetPriceId: string | null;
        readonly periodEnd: Date | null;
      }>`
        select previous_tier as "previousTier", target_tier as "targetTier",
               previous_price_id as "previousPriceId", target_price_id as "targetPriceId",
               current_period_end as "periodEnd"
        from client_ai_plan_change_requests
        where client_company_id = ${account.companyId}
          and idempotency_key = ${idempotencyKey}
        for update
      `;
      const request = requests[0];
      if (request === undefined) {
        return yield* Effect.fail(new Error("stripe_schedule_state_mismatch"));
      }
      const configured = validateOwnedDowngradeScheduleShape(object, {
        companyId: account.companyId,
        idempotencyKey,
        snapshot: request,
      });
      const liveCurrentPhase = objectValue(object.current_phase ?? {});
      const liveCurrentPhaseStart = timestamp(
        liveCurrentPhase.start_date,
        "stripe_schedule_current_phase_invalid",
      );
      const liveCurrentPhaseEnd = timestamp(
        liveCurrentPhase.end_date,
        "stripe_schedule_current_phase_invalid",
      );
      if (
        account.currentTier === null ||
        account.currentPriceId === null ||
        account.periodEnd === null ||
        planTierRank[targetTier] >= planTierRank[account.currentTier] ||
        (account.pendingScheduleId !== null && account.pendingScheduleId !== scheduleId) ||
        (account.pendingTier !== null && account.pendingTier !== targetTier) ||
        request.previousTier !== account.currentTier ||
        request.targetTier !== targetTier ||
        request.previousPriceId !== account.currentPriceId ||
        request.targetPriceId === null ||
        request.periodEnd?.getTime() !== account.periodEnd.getTime() ||
        configured.currentPhaseStart.getTime() !== liveCurrentPhaseStart.getTime() ||
        configured.currentPhaseEnd.getTime() !== account.periodEnd.getTime() ||
        liveCurrentPhaseEnd.getTime() !== account.periodEnd.getTime() ||
        request.previousPriceId !== account.currentPriceId
      ) {
        return yield* Effect.fail(new Error("stripe_schedule_state_mismatch"));
      }
      yield* sql`
        update client_ai_billing_accounts
        set pending_downgrade_tier = ${targetTier},
            pending_downgrade_schedule_id = ${scheduleId}, updated_at = now()
        where client_company_id = ${account.companyId}
      `;
      return;
    }
    if (["completed", "released", "canceled", "aborted"].includes(status)) {
      const expectedEventType = `subscription_schedule.${status}`;
      if (eventType !== expectedEventType) {
        return yield* Effect.fail(new Error("stripe_schedule_state_mismatch"));
      }
      const terminalRequests = yield* sql<{
        readonly previousTier: "light" | "team" | "intensive";
        readonly targetTier: "light" | "team" | "intensive";
        readonly previousPriceId: string | null;
        readonly targetPriceId: string | null;
        readonly periodEnd: Date | null;
        readonly status: "processing" | "succeeded" | "failed";
        readonly outcome: "unchanged" | "upgraded" | "downgrade_scheduled" | null;
        readonly externalOperationId: string | null;
        readonly requestedByUserId: string;
        readonly authorizationRequestId: string;
        readonly authorizationSessionId: string;
      }>`
        select previous_tier as "previousTier", target_tier as "targetTier",
               previous_price_id as "previousPriceId", target_price_id as "targetPriceId",
               current_period_end as "periodEnd", status, outcome,
               external_operation_id as "externalOperationId",
               requested_by_user_id as "requestedByUserId",
               authorization_request_id::text as "authorizationRequestId",
               authorization_session_id as "authorizationSessionId"
        from client_ai_plan_change_requests
        where client_company_id = ${account.companyId}
          and idempotency_key = ${idempotencyKey}
        for update
      `;
      const request = terminalRequests[0];
      if (request !== undefined) {
        validateOwnedDowngradeScheduleShape(object, {
          companyId: account.companyId,
          idempotencyKey,
          snapshot: request,
        });
      }
      const requestMatches =
        request !== undefined &&
        request.status === "succeeded" &&
        request.outcome === "downgrade_scheduled" &&
        request.targetTier === targetTier &&
        request.targetPriceId !== null &&
        request.externalOperationId === scheduleId;
      const beforeTransition =
        requestMatches &&
        account.currentTier === request.previousTier &&
        account.currentPriceId === request.previousPriceId &&
        account.periodEnd?.getTime() === request.periodEnd?.getTime() &&
        account.pendingTier === targetTier &&
        account.pendingScheduleId === scheduleId;
      const afterTransition =
        requestMatches &&
        account.currentTier === targetTier &&
        account.currentPriceId === request.targetPriceId &&
        account.pendingTier === null &&
        account.pendingScheduleId === null;
      const canceledBeforeAlreadyReconciled =
        requestMatches &&
        (status === "canceled" || status === "aborted") &&
        account.currentTier === request.previousTier &&
        account.currentPriceId === request.previousPriceId &&
        account.periodEnd?.getTime() === request.periodEnd?.getTime() &&
        account.pendingTier === null &&
        account.pendingScheduleId === null;
      if (!beforeTransition && !afterTransition && !canceledBeforeAlreadyReconciled) {
        return yield* Effect.fail(new Error("stripe_schedule_state_mismatch"));
      }
      if ((status === "canceled" || status === "aborted") && beforeTransition) {
        yield* sql`
          update client_ai_billing_accounts
          set pending_downgrade_tier = null,
              pending_downgrade_schedule_id = null,
              updated_at = now()
          where client_company_id = ${account.companyId}
            and pending_downgrade_tier = ${targetTier}
            and pending_downgrade_schedule_id = ${scheduleId}
        `;
        yield* sql`
          insert into platform_authorization_audit_log (
            actor_user_id, session_id, request_id, action, scope_kind, scope_id,
            outcome, reason_code
          ) values (
            ${request.requestedByUserId}, ${request.authorizationSessionId},
            ${request.authorizationRequestId}::uuid,
            ${`client.billing.plan_change.schedule_${status}`},
            'client_company', ${account.companyId}, 'succeeded', null
          )
          on conflict (request_id, action, scope_kind, scope_id) do nothing
        `;
      }
      return;
    }
    return yield* Effect.fail(new Error("stripe_schedule_status_invalid"));
  });

const invoiceLinePriceId = (raw: unknown): string => {
  const line = objectValue(raw);
  const pricing = objectValue(line.pricing ?? {});
  const priceDetails = objectValue(pricing.price_details ?? {});
  return objectId(priceDetails.price, "stripe_invoice_line_price_missing");
};

const reconcilePaidPlanUpgrade = (object: Record<string, unknown>) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const customerId = stringValue(object.customer, "stripe_invoice_customer_missing");
    const companyId = yield* companyIdForCustomer(customerId);
    const parent = objectValue(object.parent ?? {});
    const subscriptionDetails = objectValue(parent.subscription_details ?? {});
    const subscriptionMetadata = objectValue(subscriptionDetails.metadata ?? {});
    const planChangeKey = stringValue(
      subscriptionMetadata.brief_plan_change_key,
      "stripe_upgrade_plan_change_key_missing",
    );
    if (subscriptionMetadata.brief_client_company_id !== companyId) {
      throw new Error("stripe_upgrade_company_mismatch");
    }
    const targetTier = planTier(subscriptionMetadata.brief_plan_tier);
    const previousTier = planTier(subscriptionMetadata.brief_plan_previous_tier);
    if (
      targetTier === null ||
      previousTier === null ||
      planTierRank[previousTier] >= planTierRank[targetTier]
    ) {
      throw new Error("stripe_upgrade_tier_invalid");
    }
    const subscriptionId = objectId(
      subscriptionDetails.subscription,
      "stripe_upgrade_subscription_missing",
    );
    const invoiceId = stringValue(object.id, "stripe_invoice_id_missing");
    const paidAt = timestamp(
      objectValue(object.status_transitions ?? {}).paid_at ?? object.created,
      "stripe_upgrade_paid_at_missing",
    );
    if (
      object.status !== "paid" ||
      object.paid !== true ||
      positiveInteger(object.amount_paid, "stripe_upgrade_payment_missing") <= 0
    ) {
      throw new Error("stripe_upgrade_payment_missing");
    }
    const accounts = yield* sql<{
      readonly currentTier: "light" | "team" | "intensive" | null;
      readonly currentPriceId: string | null;
      readonly subscriptionId: string | null;
      readonly periodStart: Date | null;
      readonly periodEnd: Date | null;
    }>`
      select plan_tier as "currentTier", stripe_price_id as "currentPriceId",
             stripe_subscription_id as "subscriptionId",
             current_period_start as "periodStart", current_period_end as "periodEnd"
      from client_ai_billing_accounts
      where client_company_id = ${companyId}
      for update
    `;
    const account = accounts[0];
    const requests = yield* sql<{
      readonly previousTier: "light" | "team" | "intensive";
      readonly targetTier: "light" | "team" | "intensive";
      readonly customerId: string | null;
      readonly subscriptionId: string | null;
      readonly previousPriceId: string | null;
      readonly targetPriceId: string | null;
      readonly status: "processing" | "succeeded" | "failed";
      readonly outcome: "unchanged" | "upgraded" | "downgrade_scheduled" | null;
      readonly externalOperationId: string | null;
      readonly currentPeriodEnd: Date | null;
      readonly requestedByUserId: string;
      readonly authorizationRequestId: string;
      readonly authorizationSessionId: string;
    }>`
      select previous_tier as "previousTier", target_tier as "targetTier",
             stripe_customer_id as "customerId", stripe_subscription_id as "subscriptionId",
             previous_price_id as "previousPriceId", target_price_id as "targetPriceId",
             status, outcome, external_operation_id as "externalOperationId",
             current_period_end as "currentPeriodEnd",
             requested_by_user_id as "requestedByUserId",
             authorization_request_id::text as "authorizationRequestId",
             authorization_session_id as "authorizationSessionId"
      from client_ai_plan_change_requests
      where client_company_id = ${companyId} and idempotency_key = ${planChangeKey}
      for update
    `;
    const request = requests[0];
    const lines = objectValue(object.lines ?? {});
    const lineRows = Array.isArray(lines.data) ? lines.data : [];
    const hasTargetProration = lineRows.some((rawLine) => {
      const line = objectValue(rawLine);
      const details = objectValue(objectValue(line.parent ?? {}).subscription_item_details ?? {});
      const period = objectValue(line.period ?? {});
      return (
        Number(line.amount) > 0 &&
        details.proration === true &&
        objectId(details.subscription, "stripe_upgrade_line_subscription_missing") ===
          subscriptionId &&
        invoiceLinePriceId(line) === request?.targetPriceId &&
        timestamp(period.end, "stripe_upgrade_line_period_missing").getTime() ===
          request?.currentPeriodEnd?.getTime()
      );
    });
    const accountMatchesPrevious =
      account?.currentTier === previousTier && account.currentPriceId === request?.previousPriceId;
    const accountMatchesTarget =
      account?.currentTier === targetTier && account.currentPriceId === request?.targetPriceId;
    if (
      account === undefined ||
      request === undefined ||
      request.previousTier !== previousTier ||
      request.targetTier !== targetTier ||
      request.customerId !== customerId ||
      request.subscriptionId !== subscriptionId ||
      account.subscriptionId !== subscriptionId ||
      account.periodStart === null ||
      account.periodEnd === null ||
      request.currentPeriodEnd?.getTime() !== account.periodEnd.getTime() ||
      paidAt < account.periodStart ||
      paidAt >= account.periodEnd ||
      request.previousPriceId === null ||
      request.targetPriceId === null ||
      (!accountMatchesPrevious && !accountMatchesTarget) ||
      !hasTargetProration
    ) {
      throw new Error("stripe_upgrade_request_mismatch");
    }
    if (request.status === "succeeded") {
      if (request.outcome !== "upgraded" || request.externalOperationId !== invoiceId) {
        throw new Error("stripe_upgrade_replay_mismatch");
      }
      return;
    }
    yield* sql`
      update client_ai_billing_accounts
      set plan_tier = ${targetTier}, stripe_price_id = ${request.targetPriceId},
          pending_downgrade_tier = null, pending_downgrade_schedule_id = null,
          updated_at = now()
      where client_company_id = ${companyId}
    `;
    yield* sql`
      update client_ai_plan_change_requests
      set status = 'succeeded', outcome = 'upgraded', effective_at = ${paidAt},
          external_operation_id = ${invoiceId}, error_code = null, updated_at = now()
      where client_company_id = ${companyId} and idempotency_key = ${planChangeKey}
    `;
    yield* sql`
      insert into platform_authorization_audit_log (
        actor_user_id, session_id, request_id, action, scope_kind, scope_id,
        outcome, reason_code
      ) values (
        ${request.requestedByUserId}, ${request.authorizationSessionId},
        ${request.authorizationRequestId}::uuid, 'client.billing.plan_change.upgraded',
        'client_company', ${companyId}, 'succeeded', null
      )
      on conflict (request_id, action, scope_kind, scope_id) do nothing
    `;
  });

const processMonthlyInvoice = (payload: Record<string, unknown>) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const object = stripeObject(payload);
    if (object.billing_reason === "subscription_update") {
      return yield* reconcilePaidPlanUpgrade(object);
    }
    if (
      object.billing_reason !== "subscription_create" &&
      object.billing_reason !== "subscription_cycle"
    ) {
      return;
    }
    const customerId = stringValue(object.customer, "stripe_invoice_customer_missing");
    const companyId = yield* companyIdForCustomer(customerId);
    const metadata = objectValue(object.metadata ?? {});
    const lines = objectValue(object.lines ?? {});
    const lineRows = Array.isArray(lines.data) ? lines.data : [];
    if (lineRows.length !== 1) throw new Error("stripe_monthly_invoice_lines_ambiguous");
    const firstLine = objectValue(lineRows[0]);
    const priceId = invoiceLinePriceId(firstLine);
    if (positiveInteger(firstLine.quantity ?? 1, "stripe_monthly_quantity_invalid") !== 1) {
      throw new Error("stripe_monthly_quantity_invalid");
    }
    const parent = objectValue(object.parent ?? {});
    const subscriptionDetails = objectValue(parent.subscription_details ?? {});
    const subscriptionId = objectId(
      subscriptionDetails.subscription,
      "stripe_monthly_subscription_missing",
    );
    if (
      object.status !== "paid" ||
      object.paid !== true ||
      positiveInteger(object.amount_paid, "stripe_monthly_payment_missing") <= 0
    ) {
      throw new Error("stripe_monthly_payment_missing");
    }
    const credits = positiveInteger(metadata.brief_credits, "stripe_monthly_credits_missing");
    const period = objectValue(firstLine.period ?? {});
    const availableAt = timestamp(period.start, "stripe_invoice_period_start_missing");
    const expiresAt = timestamp(period.end, "stripe_invoice_period_end_missing");
    if (expiresAt <= availableAt) throw new Error("stripe_invoice_period_invalid");
    const accounts = yield* sql<{
      readonly status: string;
      readonly subscriptionId: string | null;
      readonly priceId: string | null;
      readonly periodStart: Date | null;
      readonly periodEnd: Date | null;
    }>`
      select status, stripe_subscription_id as "subscriptionId",
             stripe_price_id as "priceId", current_period_start as "periodStart",
             current_period_end as "periodEnd"
      from client_ai_billing_accounts
      where client_company_id = ${companyId}
      for update
    `;
    const account = accounts[0];
    if (
      account === undefined ||
      (account.status !== "active" && account.status !== "trialing") ||
      account.subscriptionId !== subscriptionId ||
      account.priceId !== priceId ||
      account.periodStart?.getTime() !== availableAt.getTime() ||
      account.periodEnd?.getTime() !== expiresAt.getTime()
    ) {
      throw new Error("stripe_monthly_account_mismatch");
    }
    yield* sql`
      insert into client_credit_lots (
        client_company_id, kind, credits_granted, credits_remaining,
        available_at, expires_at, stripe_payment_id
      ) values (
        ${companyId}, 'monthly', ${credits}, ${credits}, ${availableAt}, ${expiresAt},
        ${`invoice:${stringValue(object.id, "stripe_invoice_id_missing")}`}
      )
      on conflict (client_company_id, stripe_payment_id) do nothing
    `;
  });

const processAdditionalCheckout = (eventType: string, payload: Record<string, unknown>) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const object = stripeObject(payload);
    const metadata = objectValue(object.metadata ?? {});
    if (metadata.brief_purchase_kind !== "additional_credits") return;
    const customerId = stringValue(object.customer, "stripe_checkout_customer_missing");
    const companyId = yield* companyIdForCustomer(customerId);
    if (
      stringValue(metadata.brief_client_company_id, "stripe_checkout_company_missing") !==
        companyId ||
      (object.client_reference_id !== undefined && object.client_reference_id !== companyId)
    ) {
      throw new Error("stripe_checkout_company_mismatch");
    }
    const credits = positiveInteger(metadata.brief_credits, "stripe_additional_credits_missing");
    const availableAt = timestamp(object.created, "stripe_checkout_created_missing");
    if (positiveInteger(object.amount_total, "stripe_checkout_payment_missing") <= 0) {
      throw new Error("stripe_checkout_payment_missing");
    }
    if (eventType === "checkout.session.expired") {
      if (object.status !== "expired" || object.payment_status !== "unpaid") {
        throw new Error("stripe_checkout_terminal_state_mismatch");
      }
      return;
    }
    if (eventType === "checkout.session.async_payment_failed") {
      if (object.status !== "complete" || object.payment_status !== "unpaid") {
        throw new Error("stripe_checkout_terminal_state_mismatch");
      }
      return;
    }
    if (
      eventType === "checkout.session.completed" &&
      object.status === "complete" &&
      object.payment_status === "unpaid"
    ) {
      return;
    }
    if (object.status !== "complete" || object.payment_status !== "paid") {
      throw new Error("stripe_checkout_payment_missing");
    }
    const paymentId = stringValue(object.payment_intent, "stripe_payment_id_missing");
    yield* sql`
      insert into client_credit_lots (
        client_company_id, kind, credits_granted, credits_remaining,
        available_at, expires_at, stripe_payment_id
      ) values (
        ${companyId}, 'additional', ${credits}, ${credits}, ${availableAt},
        (${availableAt}::timestamptz + interval '12 months'), ${`payment:${paymentId}`}
      )
      on conflict (client_company_id, stripe_payment_id) do nothing
    `;
  });

export const processStripeWebhookEvent = (stripeEventId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly eventType: string;
            readonly payload: Record<string, unknown>;
            readonly processedAt: Date | null;
          }>`
            select event_type as "eventType", payload, processed_at as "processedAt"
            from stripe_webhook_events
            where stripe_event_id = ${stripeEventId}
            for update
          `;
          const event = rows[0];
          if (event === undefined) return yield* Effect.fail(new Error("stripe_event_not_found"));
          if (event.processedAt !== null) return { status: "already_processed" as const };
          switch (event.eventType) {
            case "customer.subscription.created":
            case "customer.subscription.updated":
              yield* processSubscription(event.payload, false);
              break;
            case "customer.subscription.deleted":
              yield* processSubscription(event.payload, true);
              break;
            case "subscription_schedule.created":
            case "subscription_schedule.updated":
            case "subscription_schedule.completed":
            case "subscription_schedule.released":
            case "subscription_schedule.canceled":
            case "subscription_schedule.aborted":
              yield* processSubscriptionSchedule(event.eventType, event.payload);
              break;
            case "invoice.paid":
              yield* processMonthlyInvoice(event.payload);
              break;
            case "checkout.session.completed":
            case "checkout.session.async_payment_succeeded":
            case "checkout.session.async_payment_failed":
            case "checkout.session.expired":
              yield* processAdditionalCheckout(event.eventType, event.payload);
              break;
            default:
              break;
          }
          yield* sql`
            update stripe_webhook_events
            set processed_at = now(), processing_error_code = null
            where stripe_event_id = ${stripeEventId}
          `;
          return { status: "processed" as const };
        }),
      )
      .pipe(
        Effect.tapError((error) => recordProcessingError(stripeEventId, error)),
        Effect.tapDefect((defect) => recordProcessingError(stripeEventId, defect)),
      );
  });

export const expireMonthlyCreditLots = (now = new Date()) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly id: string }>`
      update client_credit_lots
      set credits_remaining = 0
      where kind = 'monthly'
        and expires_at <= ${now}
        and credits_remaining > 0
      returning id::text
    `;
    return rows.length;
  });
