import type Stripe from "stripe";

import type { AiPlanTier } from "@hartlib/shared";

export const AI_PLAN_TIERS = [
  "light",
  "team",
  "intensive",
] as const satisfies readonly AiPlanTier[];

const tierRank = new Map<AiPlanTier, number>(AI_PLAN_TIERS.map((tier, index) => [tier, index]));

export const compareAiPlanTiers = (left: AiPlanTier, right: AiPlanTier): -1 | 0 | 1 => {
  const difference = tierRank.get(left)! - tierRank.get(right)!;
  return difference === 0 ? 0 : difference < 0 ? -1 : 1;
};

export type BillingPlanChangeGatewayInput = {
  readonly companyId: string;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly currentTier: AiPlanTier;
  readonly targetTier: AiPlanTier;
  readonly currentPriceId: string;
  readonly targetPriceId: string;
  readonly currentPeriodEnd: string;
  readonly idempotencyKey: string;
};

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

export interface BillingPlanChangeGateway {
  readonly changeMonthlyPlan: (
    input: BillingPlanChangeGatewayInput,
  ) => Promise<BillingPlanChangeGatewayResult>;
}

export type BillingPlanChangeErrorCode =
  | "stripe_subscription_ambiguous"
  | "stripe_subscription_item_ambiguous"
  | "stripe_subscription_state_mismatch"
  | "stripe_subscription_schedule_ambiguous"
  | "stripe_proration_invoice_missing"
  | "stripe_proration_invoice_unpaid"
  | "stripe_schedule_invalid";

export class BillingPlanChangeError extends Error {
  readonly name = "BillingPlanChangeError";

  constructor(readonly code: BillingPlanChangeErrorCode) {
    super(code);
  }
}

type StripePlanChangeClient = Pick<Stripe, "subscriptions" | "subscriptionSchedules">;

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const stringId = (value: unknown): string | null => {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  const id = object(value).id;
  return typeof id === "string" && id.trim() !== "" ? id : null;
};

const integer = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

interface ValidatedSubscription {
  readonly itemId: string;
  readonly quantity: number;
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly scheduleId: string | null;
  readonly state: "current" | "upgrade_replay";
}

const validateSubscription = (
  raw: unknown,
  input: BillingPlanChangeGatewayInput,
  direction: -1 | 1,
): ValidatedSubscription => {
  const subscription = object(raw);
  if (
    stringId(subscription.id) !== input.subscriptionId ||
    stringId(subscription.customer) !== input.customerId ||
    (subscription.status !== "active" && !(direction > 0 && subscription.status === "trialing"))
  ) {
    throw new BillingPlanChangeError("stripe_subscription_state_mismatch");
  }
  const itemData = object(subscription.items).data;
  if (!Array.isArray(itemData) || itemData.length !== 1) {
    throw new BillingPlanChangeError("stripe_subscription_item_ambiguous");
  }
  const item = object(itemData[0]);
  const itemId = stringId(item.id);
  const price = object(item.price);
  const priceId = stringId(price.id);
  const quantity =
    item.quantity === null || item.quantity === undefined ? 1 : integer(item.quantity);
  const periodStart = integer(item.current_period_start);
  const periodEnd = integer(item.current_period_end);
  const state =
    priceId === input.currentPriceId
      ? "current"
      : direction < 0 && priceId === input.targetPriceId
        ? "upgrade_replay"
        : null;
  if (
    itemId === null ||
    state === null ||
    quantity !== 1 ||
    periodStart === null ||
    periodEnd === null ||
    periodEnd <= periodStart ||
    new Date(periodEnd * 1000).toISOString() !== input.currentPeriodEnd
  ) {
    throw new BillingPlanChangeError("stripe_subscription_item_ambiguous");
  }
  const subscriptionTier = object(subscription.metadata).hartlib_plan_tier;
  const subscriptionMetadataRecord = object(subscription.metadata);
  const priceTier = object(price.metadata).hartlib_plan_tier;
  const expectedTier = state === "current" ? input.currentTier : input.targetTier;
  if (
    (subscriptionTier !== undefined && subscriptionTier !== expectedTier) ||
    (priceTier !== undefined && priceTier !== expectedTier) ||
    (subscriptionTier === undefined && priceTier === undefined)
  ) {
    throw new BillingPlanChangeError("stripe_subscription_state_mismatch");
  }
  if (subscription.status === "active") {
    const latestInvoice = object(subscription.latest_invoice);
    const subscriptionDetails = object(object(latestInvoice.parent).subscription_details);
    if (
      stringId(latestInvoice.id) === null ||
      latestInvoice.status !== "paid" ||
      latestInvoice.paid !== true ||
      stringId(latestInvoice.customer) !== input.customerId ||
      stringId(subscriptionDetails.subscription) !== input.subscriptionId
    ) {
      throw new BillingPlanChangeError("stripe_subscription_state_mismatch");
    }
  }
  if (
    state === "upgrade_replay" &&
    (subscriptionMetadataRecord.hartlib_client_company_id !== input.companyId ||
      subscriptionMetadataRecord.hartlib_plan_change_key !== input.idempotencyKey ||
      subscriptionMetadataRecord.hartlib_plan_previous_tier !== input.currentTier)
  ) {
    throw new BillingPlanChangeError("stripe_subscription_state_mismatch");
  }
  return {
    itemId,
    quantity,
    periodStart,
    periodEnd,
    scheduleId: stringId(subscription.schedule),
    state,
  };
};

const planChangeIdempotency = (input: BillingPlanChangeGatewayInput, operation: string): string =>
  `hartlib-plan:${input.companyId}:${input.idempotencyKey}:${operation}`;

const scheduleMetadata = (input: BillingPlanChangeGatewayInput) => ({
  hartlib_client_company_id: input.companyId,
  hartlib_plan_change_key: input.idempotencyKey,
  hartlib_plan_tier: input.targetTier,
});

const subscriptionMetadata = (input: BillingPlanChangeGatewayInput) => ({
  hartlib_client_company_id: input.companyId,
  hartlib_plan_change_key: input.idempotencyKey,
  hartlib_plan_previous_tier: input.currentTier,
  hartlib_plan_tier: input.targetTier,
});

interface OwnedSchedule {
  readonly id: string;
  readonly currentPhaseStart: number;
}

const validateOwnedSchedule = (
  raw: unknown,
  input: BillingPlanChangeGatewayInput,
): OwnedSchedule => {
  const schedule = object(raw);
  const id = stringId(schedule.id);
  const metadata = object(schedule.metadata);
  const currentPhase = object(schedule.current_phase);
  const currentPhaseStart = integer(currentPhase.start_date);
  const currentPhaseEnd = integer(currentPhase.end_date);
  if (
    id === null ||
    metadata.hartlib_client_company_id !== input.companyId ||
    metadata.hartlib_plan_change_key !== input.idempotencyKey ||
    metadata.hartlib_plan_tier !== input.targetTier ||
    stringId(schedule.subscription) !== input.subscriptionId ||
    schedule.status !== "active" ||
    currentPhaseStart === null ||
    currentPhaseEnd === null ||
    currentPhaseStart >= currentPhaseEnd ||
    new Date(currentPhaseEnd * 1000).toISOString() !== input.currentPeriodEnd
  ) {
    throw new BillingPlanChangeError("stripe_subscription_schedule_ambiguous");
  }
  return { id, currentPhaseStart };
};

const validateSchedulePhaseItem = (raw: unknown, priceId: string): boolean => {
  const item = object(raw);
  const quantity =
    item.quantity === null || item.quantity === undefined ? 1 : integer(item.quantity);
  return stringId(item.price) === priceId && quantity === 1;
};

const validateConfiguredSchedule = (
  raw: unknown,
  input: BillingPlanChangeGatewayInput,
  validated: ValidatedSubscription,
  expectedCurrentPhaseStart: number,
): string => {
  const owned = validateOwnedSchedule(raw, input);
  const schedule = object(raw);
  const phases = schedule.phases;
  if (schedule.end_behavior !== "release" || !Array.isArray(phases) || phases.length !== 2) {
    throw new BillingPlanChangeError("stripe_schedule_invalid");
  }
  const current = object(phases[0]);
  const target = object(phases[1]);
  const currentItems = current.items;
  const targetItems = target.items;
  if (
    integer(current.start_date) !== expectedCurrentPhaseStart ||
    integer(current.end_date) !== validated.periodEnd ||
    current.proration_behavior !== "none" ||
    object(current.metadata).hartlib_plan_tier !== input.currentTier ||
    !Array.isArray(currentItems) ||
    currentItems.length !== 1 ||
    !validateSchedulePhaseItem(currentItems[0], input.currentPriceId) ||
    integer(target.start_date) !== validated.periodEnd ||
    target.proration_behavior !== "none" ||
    object(target.metadata).hartlib_plan_tier !== input.targetTier ||
    !Array.isArray(targetItems) ||
    targetItems.length !== 1 ||
    !validateSchedulePhaseItem(targetItems[0], input.targetPriceId)
  ) {
    throw new BillingPlanChangeError("stripe_schedule_invalid");
  }
  return owned.id;
};

const validatePaidUpgradeInvoice = (
  raw: unknown,
  input: BillingPlanChangeGatewayInput,
): { readonly id: string; readonly effectiveAt: string } => {
  const invoice = object(raw);
  const invoiceId = stringId(invoice.id);
  const parent = object(invoice.parent);
  const subscriptionDetails = object(parent.subscription_details);
  const paidAt = integer(object(invoice.status_transitions).paid_at) ?? integer(invoice.created);
  const invoiceLines = object(invoice.lines).data;
  const hasTargetProration =
    Array.isArray(invoiceLines) &&
    invoiceLines.some((rawLine) => {
      const line = object(rawLine);
      const lineParent = object(line.parent);
      const details = object(lineParent.subscription_item_details);
      const priceDetails = object(object(line.pricing).price_details);
      const quantity =
        line.quantity === null || line.quantity === undefined ? 1 : integer(line.quantity);
      return (
        (integer(line.amount) ?? 0) > 0 &&
        details.proration === true &&
        stringId(details.subscription) === input.subscriptionId &&
        stringId(priceDetails.price) === input.targetPriceId &&
        quantity === 1
      );
    });
  if (invoiceId === null) {
    throw new BillingPlanChangeError("stripe_proration_invoice_missing");
  }
  if (
    invoice.status !== "paid" ||
    invoice.paid !== true ||
    (integer(invoice.amount_paid) ?? 0) <= 0 ||
    invoice.billing_reason !== "subscription_update" ||
    stringId(invoice.customer) !== input.customerId ||
    stringId(subscriptionDetails.subscription) !== input.subscriptionId ||
    !hasTargetProration ||
    paidAt === null ||
    paidAt <= 0
  ) {
    throw new BillingPlanChangeError("stripe_proration_invoice_unpaid");
  }
  return { id: invoiceId, effectiveAt: new Date(paidAt * 1000).toISOString() };
};

export const makeLiveBillingPlanChangeGateway = (
  stripe: StripePlanChangeClient,
): BillingPlanChangeGateway => ({
  changeMonthlyPlan: async (input) => {
    const direction = compareAiPlanTiers(input.currentTier, input.targetTier);
    if (direction === 0) {
      throw new BillingPlanChangeError("stripe_subscription_state_mismatch");
    }
    const subscription = await stripe.subscriptions.retrieve(input.subscriptionId, {
      expand: ["items.data.price", "latest_invoice", "schedule"],
    });
    const validated = validateSubscription(subscription, input, direction);
    if (direction < 0) {
      if (validated.scheduleId !== null) {
        throw new BillingPlanChangeError("stripe_subscription_schedule_ambiguous");
      }
      const updated = await stripe.subscriptions.update(
        input.subscriptionId,
        {
          items: [{ id: validated.itemId, price: input.targetPriceId, quantity: 1 }],
          billing_cycle_anchor: "unchanged",
          proration_behavior: "always_invoice",
          payment_behavior: "error_if_incomplete",
          metadata: subscriptionMetadata(input),
          expand: ["items.data.price", "latest_invoice"],
        },
        { idempotencyKey: planChangeIdempotency(input, "upgrade") },
      );
      const updatedRecord = object(updated);
      const upgraded = validateSubscription(updatedRecord, input, direction);
      if (upgraded.state !== "upgrade_replay" || upgraded.scheduleId !== null) {
        throw new BillingPlanChangeError("stripe_subscription_state_mismatch");
      }
      const invoice = validatePaidUpgradeInvoice(updatedRecord.latest_invoice, input);
      return {
        kind: "upgraded",
        effectiveAt: invoice.effectiveAt,
        externalOperationId: invoice.id,
      };
    }

    let ownedSchedule: OwnedSchedule;
    if (validated.scheduleId === null) {
      const created = await stripe.subscriptionSchedules.create(
        {
          from_subscription: input.subscriptionId,
          metadata: scheduleMetadata(input),
        },
        { idempotencyKey: planChangeIdempotency(input, "schedule-create") },
      );
      ownedSchedule = validateOwnedSchedule(created, input);
    } else {
      const existing = await stripe.subscriptionSchedules.retrieve(validated.scheduleId);
      ownedSchedule = validateOwnedSchedule(existing, input);
    }
    const updatedSchedule = await stripe.subscriptionSchedules.update(
      ownedSchedule.id,
      {
        end_behavior: "release",
        proration_behavior: "none",
        metadata: scheduleMetadata(input),
        phases: [
          {
            start_date: ownedSchedule.currentPhaseStart,
            end_date: validated.periodEnd,
            items: [{ price: input.currentPriceId, quantity: 1 }],
            proration_behavior: "none",
            metadata: {
              hartlib_client_company_id: input.companyId,
              hartlib_plan_change_key: input.idempotencyKey,
              hartlib_plan_previous_tier: input.currentTier,
              hartlib_plan_tier: input.currentTier,
            },
          },
          {
            start_date: validated.periodEnd,
            items: [{ price: input.targetPriceId, quantity: 1 }],
            proration_behavior: "none",
            metadata: subscriptionMetadata(input),
          },
        ],
      },
      { idempotencyKey: planChangeIdempotency(input, "schedule-update") },
    );
    if (
      validateConfiguredSchedule(
        updatedSchedule,
        input,
        validated,
        ownedSchedule.currentPhaseStart,
      ) !== ownedSchedule.id
    ) {
      throw new BillingPlanChangeError("stripe_schedule_invalid");
    }
    return {
      kind: "downgrade_scheduled",
      effectiveAt: input.currentPeriodEnd,
      externalOperationId: ownedSchedule.id,
    };
  },
});
