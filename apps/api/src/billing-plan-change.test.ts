import { describe, expect, it, vi } from "vitest";

import {
  BillingPlanChangeError,
  compareAiPlanTiers,
  makeLiveBillingPlanChangeGateway,
  type BillingPlanChangeGatewayInput,
} from "./billing-plan-change";

const periodStart = 1_767_225_600;
const periodEnd = 1_769_904_000;

const input = (
  currentTier: BillingPlanChangeGatewayInput["currentTier"],
  targetTier: BillingPlanChangeGatewayInput["targetTier"],
): BillingPlanChangeGatewayInput => ({
  companyId: "company-1",
  customerId: "cus_1",
  subscriptionId: "sub_1",
  currentTier,
  targetTier,
  currentPriceId: `price_${currentTier}`,
  targetPriceId: `price_${targetTier}`,
  currentPeriodEnd: new Date(periodEnd * 1000).toISOString(),
  idempotencyKey: "plan-change-0001",
});

const subscription = (
  tier: BillingPlanChangeGatewayInput["currentTier"],
  schedule: unknown = null,
) => ({
  id: "sub_1",
  customer: "cus_1",
  status: "active",
  schedule,
  metadata: { brief_plan_tier: tier },
  latest_invoice: {
    id: "in_current_1",
    customer: "cus_1",
    status: "paid",
    paid: true,
    parent: { subscription_details: { subscription: "sub_1" } },
    lines: {
      data: [
        {
          amount: 1_500,
          quantity: 1,
          parent: {
            subscription_item_details: { proration: true, subscription: "sub_1" },
          },
          pricing: { type: "price_details", price_details: { price: `price_${tier}` } },
        },
      ],
    },
  },
  items: {
    data: [
      {
        id: "si_1",
        quantity: 1,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        price: { id: `price_${tier}`, metadata: { brief_plan_tier: tier } },
      },
    ],
  },
});

const upgradedSubscription = (tier: BillingPlanChangeGatewayInput["targetTier"]) => ({
  ...subscription(tier),
  metadata: {
    brief_client_company_id: "company-1",
    brief_plan_change_key: "plan-change-0001",
    brief_plan_previous_tier: "team",
    brief_plan_tier: tier,
  },
});

const paidUpgrade = (tier: BillingPlanChangeGatewayInput["targetTier"]) => ({
  ...upgradedSubscription(tier),
  latest_invoice: {
    id: "in_upgrade_1",
    customer: "cus_1",
    status: "paid",
    paid: true,
    amount_paid: 1_500,
    billing_reason: "subscription_update",
    created: periodStart + 60,
    status_transitions: { paid_at: periodStart + 61 },
    parent: { subscription_details: { subscription: "sub_1" } },
    lines: {
      data: [
        {
          amount: 1_500,
          quantity: 1,
          parent: {
            subscription_item_details: { proration: true, subscription: "sub_1" },
          },
          pricing: { type: "price_details", price_details: { price: `price_${tier}` } },
        },
      ],
    },
  },
});

const ownedSchedule = (
  tier: BillingPlanChangeGatewayInput["targetTier"],
  extra: Record<string, unknown> = {},
) => ({
  id: "sub_sched_1",
  subscription: "sub_1",
  status: "active",
  current_phase: { start_date: periodStart, end_date: periodEnd },
  metadata: {
    brief_client_company_id: "company-1",
    brief_plan_change_key: "plan-change-0001",
    brief_plan_tier: tier,
  },
  ...extra,
});

const configuredSchedule = (
  currentTier: BillingPlanChangeGatewayInput["currentTier"],
  targetTier: BillingPlanChangeGatewayInput["targetTier"],
  currentPhaseStart = periodStart,
) =>
  ownedSchedule(targetTier, {
    end_behavior: "release",
    phases: [
      {
        start_date: currentPhaseStart,
        end_date: periodEnd,
        items: [{ price: `price_${currentTier}`, quantity: 1 }],
        proration_behavior: "none",
        metadata: { brief_plan_tier: currentTier },
      },
      {
        start_date: periodEnd,
        items: [{ price: `price_${targetTier}`, quantity: 1 }],
        proration_behavior: "none",
        metadata: { brief_plan_tier: targetTier },
      },
    ],
  });

const fakeStripe = (options: {
  readonly retrievedSubscription: unknown;
  readonly updatedSubscription?: unknown;
  readonly createdSchedule?: unknown;
  readonly retrievedSchedule?: unknown;
  readonly updatedSchedule?: unknown;
}) => {
  const client = {
    subscriptions: {
      retrieve: vi.fn(async () => options.retrievedSubscription),
      update: vi.fn(async () => options.updatedSubscription),
    },
    subscriptionSchedules: {
      create: vi.fn(async () => options.createdSchedule),
      retrieve: vi.fn(async () => options.retrievedSchedule),
      update: vi.fn(async () => options.updatedSchedule),
    },
  };
  return {
    client: client as unknown as Parameters<typeof makeLiveBillingPlanChangeGateway>[0],
    spies: client,
  };
};

describe("monthly AI plan tier ordering", () => {
  it("defines a total order for every canonical tier pair", () => {
    const tiers = ["light", "team", "intensive"] as const;
    for (const [leftIndex, left] of tiers.entries()) {
      for (const [rightIndex, right] of tiers.entries()) {
        expect(compareAiPlanTiers(left, right)).toBe(
          leftIndex === rightIndex ? 0 : leftIndex < rightIndex ? -1 : 1,
        );
      }
    }
  });
});

describe("live Stripe monthly plan change gateway", () => {
  it("upgrades immediately with an exact paid proration invoice and stable idempotency key", async () => {
    const change = input("team", "intensive");
    const stripe = fakeStripe({
      retrievedSubscription: subscription("team"),
      updatedSubscription: paidUpgrade("intensive"),
    });
    await expect(
      makeLiveBillingPlanChangeGateway(stripe.client).changeMonthlyPlan(change),
    ).resolves.toEqual({
      kind: "upgraded",
      effectiveAt: new Date((periodStart + 61) * 1000).toISOString(),
      externalOperationId: "in_upgrade_1",
    });
    expect(stripe.spies.subscriptions.update).toHaveBeenCalledWith(
      "sub_1",
      expect.objectContaining({
        items: [{ id: "si_1", price: "price_intensive", quantity: 1 }],
        billing_cycle_anchor: "unchanged",
        proration_behavior: "always_invoice",
        payment_behavior: "error_if_incomplete",
        metadata: {
          brief_client_company_id: "company-1",
          brief_plan_change_key: "plan-change-0001",
          brief_plan_previous_tier: "team",
          brief_plan_tier: "intensive",
        },
      }),
      { idempotencyKey: "brief-plan:company-1:plan-change-0001:upgrade" },
    );
    expect(stripe.spies.subscriptions.retrieve).toHaveBeenCalledWith("sub_1", {
      expand: ["items.data.price", "latest_invoice", "schedule"],
    });
    expect(stripe.spies.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it("replays an externally completed upgrade through the same Stripe idempotency operation", async () => {
    const change = input("team", "intensive");
    const stripe = fakeStripe({
      retrievedSubscription: upgradedSubscription("intensive"),
      updatedSubscription: paidUpgrade("intensive"),
    });
    await expect(
      makeLiveBillingPlanChangeGateway(stripe.client).changeMonthlyPlan(change),
    ).resolves.toMatchObject({ kind: "upgraded", externalOperationId: "in_upgrade_1" });
    expect(stripe.spies.subscriptions.update).toHaveBeenCalledOnce();
  });

  it("fails closed when the immediate proration invoice is missing, unpaid, or unrelated", async () => {
    for (const latestInvoice of [
      null,
      {
        ...paidUpgrade("intensive").latest_invoice,
        status: "open",
        paid: false,
      },
      {
        ...paidUpgrade("intensive").latest_invoice,
        parent: { subscription_details: { subscription: "sub_other" } },
      },
    ]) {
      const stripe = fakeStripe({
        retrievedSubscription: subscription("team"),
        updatedSubscription: { ...paidUpgrade("intensive"), latest_invoice: latestInvoice },
      });
      await expect(
        makeLiveBillingPlanChangeGateway(stripe.client).changeMonthlyPlan(
          input("team", "intensive"),
        ),
      ).rejects.toBeInstanceOf(BillingPlanChangeError);
    }
    const unpaidCurrent = fakeStripe({
      retrievedSubscription: {
        ...subscription("team"),
        latest_invoice: { ...subscription("team").latest_invoice, status: "open", paid: false },
      },
    });
    await expect(
      makeLiveBillingPlanChangeGateway(unpaidCurrent.client).changeMonthlyPlan(
        input("team", "intensive"),
      ),
    ).rejects.toMatchObject({ code: "stripe_subscription_state_mismatch" });
    expect(unpaidCurrent.spies.subscriptions.update).not.toHaveBeenCalled();
    const trialUpgrade = fakeStripe({
      retrievedSubscription: { ...subscription("team"), status: "trialing" },
    });
    await expect(
      makeLiveBillingPlanChangeGateway(trialUpgrade.client).changeMonthlyPlan(
        input("team", "intensive"),
      ),
    ).rejects.toMatchObject({ code: "stripe_subscription_state_mismatch" });
  });

  it("schedules a downgrade at the exact next period without proration", async () => {
    const change = input("intensive", "team");
    const schedulePhaseStart = periodStart - 86_400;
    const stripe = fakeStripe({
      retrievedSubscription: subscription("intensive"),
      createdSchedule: ownedSchedule("team", {
        current_phase: { start_date: schedulePhaseStart, end_date: periodEnd },
      }),
      updatedSchedule: configuredSchedule("intensive", "team", schedulePhaseStart),
    });
    await expect(
      makeLiveBillingPlanChangeGateway(stripe.client).changeMonthlyPlan(change),
    ).resolves.toEqual({
      kind: "downgrade_scheduled",
      effectiveAt: change.currentPeriodEnd,
      externalOperationId: "sub_sched_1",
    });
    expect(stripe.spies.subscriptionSchedules.create).toHaveBeenCalledWith(
      {
        from_subscription: "sub_1",
        metadata: expect.objectContaining({ brief_plan_tier: "team" }),
      },
      { idempotencyKey: "brief-plan:company-1:plan-change-0001:schedule-create" },
    );
    expect(stripe.spies.subscriptionSchedules.update).toHaveBeenCalledWith(
      "sub_sched_1",
      expect.objectContaining({
        end_behavior: "release",
        proration_behavior: "none",
        phases: expect.arrayContaining([
          expect.objectContaining({
            start_date: schedulePhaseStart,
            end_date: periodEnd,
            proration_behavior: "none",
          }),
          expect.objectContaining({ start_date: periodEnd, proration_behavior: "none" }),
        ]),
      }),
      { idempotencyKey: "brief-plan:company-1:plan-change-0001:schedule-update" },
    );
  });

  it("resumes only the same owned schedule after an uncertain response", async () => {
    const schedule = ownedSchedule("team");
    const stripe = fakeStripe({
      retrievedSubscription: subscription("intensive", schedule),
      retrievedSchedule: schedule,
      updatedSchedule: configuredSchedule("intensive", "team"),
    });
    await expect(
      makeLiveBillingPlanChangeGateway(stripe.client).changeMonthlyPlan(input("intensive", "team")),
    ).resolves.toMatchObject({
      kind: "downgrade_scheduled",
      externalOperationId: "sub_sched_1",
    });
    expect(stripe.spies.subscriptionSchedules.create).not.toHaveBeenCalled();
    expect(stripe.spies.subscriptionSchedules.retrieve).toHaveBeenCalledWith("sub_sched_1");
  });

  it("rejects unrelated schedules, malformed phases, ambiguous items, and same-tier calls", async () => {
    const unrelated = fakeStripe({
      retrievedSubscription: subscription("intensive", { id: "sub_sched_other" }),
      retrievedSchedule: ownedSchedule("team", {
        id: "sub_sched_other",
        metadata: { brief_client_company_id: "another-company" },
      }),
    });
    await expect(
      makeLiveBillingPlanChangeGateway(unrelated.client).changeMonthlyPlan(
        input("intensive", "team"),
      ),
    ).rejects.toMatchObject({ code: "stripe_subscription_schedule_ambiguous" });

    const malformed = fakeStripe({
      retrievedSubscription: subscription("intensive"),
      createdSchedule: ownedSchedule("team"),
      updatedSchedule: ownedSchedule("team", { end_behavior: "release", phases: [] }),
    });
    await expect(
      makeLiveBillingPlanChangeGateway(malformed.client).changeMonthlyPlan(
        input("intensive", "team"),
      ),
    ).rejects.toMatchObject({ code: "stripe_schedule_invalid" });

    const ambiguous = fakeStripe({
      retrievedSubscription: {
        ...subscription("team"),
        items: { data: subscription("team").items.data.concat(subscription("team").items.data) },
      },
    });
    await expect(
      makeLiveBillingPlanChangeGateway(ambiguous.client).changeMonthlyPlan(
        input("team", "intensive"),
      ),
    ).rejects.toMatchObject({ code: "stripe_subscription_item_ambiguous" });

    const same = fakeStripe({ retrievedSubscription: subscription("team") });
    await expect(
      makeLiveBillingPlanChangeGateway(same.client).changeMonthlyPlan(input("team", "team")),
    ).rejects.toMatchObject({ code: "stripe_subscription_state_mismatch" });
    expect(same.spies.subscriptions.retrieve).not.toHaveBeenCalled();
  });
});
