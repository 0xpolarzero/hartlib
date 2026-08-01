import type { WebhookEvent } from "@clerk/backend/webhooks";
import { PgClient } from "@effect/sql-pg";
import { runMigrations } from "@brief/database/migrations";
import { ConfigProvider, Effect, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { reserveBillingCheckout } from "@brief/backend-domain/billing";
import { acceptClerkWebhook } from "@brief/backend-domain/clerk-webhook";
import { resolveCompanyDeletionRequest } from "@brief/backend-domain/platform-support";
import { requireClientCompanyAdmin } from "@brief/workspace";
import { routeRequest } from "../http";
import { DEMO_COOKIE_NAME } from "../demo-session";
import { makeBillingRoutes, type BillingStripeGateway } from "../domain/billing";

const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const isBun = typeof process.versions.bun === "string";
const databaseName = `brief_billing_plan_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
const companyId = "20000000-0000-4000-8000-000000000002";
const periodEnd = "2026-08-01T00:00:00.000Z";

const urlFor = (database: string): string => {
  if (databaseUrl === undefined) throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL required");
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
};
const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const runDb = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>, database = databaseName) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(urlFor(database)),
          applicationName: "billing-plan-change-integration-test",
        }),
      ),
    ),
  );
const pgLayer = () =>
  PgClient.layer({
    url: Redacted.make(urlFor(databaseName)),
    applicationName: "billing-plan-change-route-test",
  });

const demoCookie = (userId: string) => `${DEMO_COOKIE_NAME}=${userId}`;

const config = (_userId: string) =>
  ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: {
        NODE_ENV: "test",
        AUTH_MODE: "demo",
        STRIPE_SECRET_KEY: "stripe-test",
        STRIPE_PRICE_LIGHT: "price_light",
        STRIPE_PRICE_TEAM: "price_team",
        STRIPE_PRICE_INTENSIVE: "price_intensive",
        STRIPE_PRICE_ADDITIONAL_CREDIT: "price_additional",
        STRIPE_CHECKOUT_SUCCESS_URL: "https://brief.test/billing/success",
        STRIPE_CHECKOUT_CANCEL_URL: "https://brief.test/billing/cancel",
        STRIPE_PORTAL_RETURN_URL: "https://brief.test/billing",
      },
    }),
  );

const call = (gateway: BillingStripeGateway, userId: string, body: unknown) =>
  Effect.runPromise(
    routeRequest(
      makeBillingRoutes(pgLayer(), gateway),
      new Request(`https://brief.test/v1/client-companies/${companyId}/billing/plan-change`, {
        method: "POST",
        headers: {
          cookie: demoCookie(userId),
          "content-type": "application/json",
          "x-request-id": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      }),
    ).pipe(Effect.provide(config(userId))),
  );

const callCheckout = (
  gateway: BillingStripeGateway,
  userId: string,
  body: unknown,
  auditRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
) =>
  Effect.runPromise(
    routeRequest(
      makeBillingRoutes(pgLayer(), gateway),
      new Request(`https://brief.test/v1/client-companies/${companyId}/billing/checkout`, {
        method: "POST",
        headers: {
          cookie: demoCookie(userId),
          "content-type": "application/json",
          "x-request-id": auditRequestId,
        },
        body: JSON.stringify(body),
      }),
    ).pipe(Effect.provide(config(userId))),
  );

const callPortal = (gateway: BillingStripeGateway, userId: string) =>
  Effect.runPromise(
    routeRequest(
      makeBillingRoutes(pgLayer(), gateway),
      new Request(`https://brief.test/v1/client-companies/${companyId}/billing/portal`, {
        method: "POST",
        headers: { cookie: demoCookie(userId), "x-request-id": crypto.randomUUID() },
      }),
    ).pipe(Effect.provide(config(userId))),
  );

const waitForAdvisoryWaiters = async (expected: number): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const count = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly count: number }>`
          select count(*)::int count
          from pg_locks
          where locktype = 'advisory' and granted = false
            and database = (select oid from pg_database where datname = current_database())
        `)[0]!.count;
      }),
    );
    if (count >= expected) return;
    await Bun.sleep(5);
  }
  throw new Error(`expected at least ${expected} waiting advisory locks`);
};

const runDbAs = <A, E>(
  applicationName: string,
  effect: Effect.Effect<A, E, PgClient.PgClient>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(urlFor(databaseName)),
          applicationName,
        }),
      ),
    ),
  );

const waitForDatabaseLock = async (applicationName: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly waiting: boolean }>`
          select exists(
            select 1
            from pg_stat_activity
            where datname = current_database()
              and application_name = ${applicationName}
              and wait_event_type = 'Lock'
          ) as waiting
        `)[0]!.waiting;
      }),
    );
    if (waiting) return;
    await Bun.sleep(5);
  }
  throw new Error(`${applicationName} did not wait for a database lock`);
};

const gateway = (
  changeMonthlyPlan: BillingStripeGateway["changeMonthlyPlan"] = async () => {
    throw new Error("unexpected_gateway_call");
  },
): BillingStripeGateway => ({
  ensureCustomer: async (input) => input.customerId ?? "cus_created",
  checkout: async () => ({ sessionId: "cs_test_checkout", url: "https://stripe.test/checkout" }),
  portal: async () => "https://stripe.test/portal",
  changeMonthlyPlan,
});

const seed = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  yield* sql`
    insert into platform_users (id, primary_email, display_name, clerk_user_id) values
      ('admin-user', 'admin@example.test', 'Admin', 'clerk-admin'),
      ('member-user', 'member@example.test', 'Member', 'clerk-member')
  `;
  yield* sql`
    insert into client_companies (id, name, clerk_organization_id, stripe_customer_id)
    values (${companyId}, 'Client', 'org_client', 'cus_client')
  `;
  yield* sql`
    insert into client_company_memberships (company_id, user_id, role) values
      (${companyId}, 'admin-user', 'admin'),
      (${companyId}, 'member-user', 'member')
  `;
  yield* sql`
    insert into client_ai_billing_accounts (
      client_company_id, plan_tier, stripe_subscription_id, stripe_price_id,
      status, current_period_start, current_period_end
    ) values (
      ${companyId}, 'team', 'sub_client', 'price_team', 'active',
      '2026-07-01T00:00:00.000Z', ${new Date(periodEnd)}
    )
  `;
  yield* sql`
    insert into client_credit_lots (
      client_company_id, kind, credits_granted, credits_remaining,
      available_at, expires_at, stripe_payment_id
    ) values (
      ${companyId}, 'additional', 275, 275,
      '2026-07-01T00:00:00.000Z', '2027-07-01T00:00:00.000Z', 'payment:additional'
    )
  `;
});

const billingState = () =>
  runDb(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      return (yield* sql<{
        readonly planTier: string;
        readonly priceId: string;
        readonly pendingTier: string | null;
        readonly pendingScheduleId: string | null;
        readonly additionalRemaining: number;
      }>`
        select billing.plan_tier as "planTier", billing.stripe_price_id as "priceId",
               billing.pending_downgrade_tier as "pendingTier",
               billing.pending_downgrade_schedule_id as "pendingScheduleId",
               (select credits_remaining::int from client_credit_lots
                where client_company_id = billing.client_company_id and kind = 'additional')
                 as "additionalRemaining"
        from client_ai_billing_accounts billing
        where billing.client_company_id = ${companyId}
      `)[0]!;
    }),
  );

describe("billing route templates", () => {
  it("registers the canonical Effect HTTP paths without regex compatibility routes", () => {
    expect(makeBillingRoutes().map((route) => `${route.method} ${route.path}`)).toEqual([
      "POST /v1/client-companies/:companyId/billing/checkout",
      "POST /v1/client-companies/:companyId/billing/plan-change",
      "POST /v1/client-companies/:companyId/billing/portal",
      "GET /v1/client-companies/:companyId/ai-usage",
      "PUT /v1/client-companies/:companyId/ai-limit",
      "PUT /v1/client-companies/:companyId/members/:userId/ai-limit",
      "POST /v1/client-companies/:companyId/ai-usage-requests",
      "POST /v1/client-companies/:companyId/ai-usage-requests/:requestId/resolve",
    ]);
  });
});

describe.skipIf(!isBun || !databaseUrl)("monthly AI plan-change route", () => {
  beforeAll(async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(`create database ${quote(databaseName)}`).withoutTransform;
      }),
      "postgres",
    );
    await runDb(runMigrations);
  }, 120_000);

  afterAll(async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName}`;
        yield* sql.unsafe(`drop database if exists ${quote(databaseName)}`).withoutTransform;
      }),
      "postgres",
    );
  }, 60_000);

  beforeEach(async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          truncate table platform_authorization_audit_log, client_companies, platform_users cascade
        `;
        yield* seed;
      }),
    );
  });

  it("creates, verifies, binds, and reuses the authoritative customer before first Checkout", async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_companies set stripe_customer_id = null where id = ${companyId}
        `;
      }),
    );
    const ensureCustomer = vi.fn<BillingStripeGateway["ensureCustomer"]>(async (input) => {
      expect(input.idempotencyKey).toBe(`brief-customer:${companyId}`);
      return input.customerId ?? "cus_first_purchase";
    });
    const checkout = vi.fn<BillingStripeGateway["checkout"]>(async () => ({
      sessionId: "cs_first_purchase",
      url: "https://stripe.test/checkout",
    }));
    const routesGateway = { ...gateway(), ensureCustomer, checkout };
    const body = {
      kind: "additional",
      credits: 250,
      idempotencyKey: "checkout-first-0001",
    } as const;
    const first = await callCheckout(routesGateway, "admin-user", body);
    const replay = await callCheckout(routesGateway, "admin-user", body);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(checkout).toHaveBeenCalledTimes(1);
    expect(checkout).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus_first_purchase" }),
    );
    const bound = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly customerId: string | null }>`
          select stripe_customer_id as "customerId" from client_companies where id = ${companyId}
        `)[0]!.customerId;
      }),
    );
    expect(bound).toBe("cus_first_purchase");
    expect(ensureCustomer.mock.calls[1]?.[0].customerId).toBe("cus_first_purchase");
  });

  it("serializes competing first-customer bindings and rejects the losing identity", async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`update client_companies set stripe_customer_id = null where id = ${companyId}`;
      }),
    );
    let callIndex = 0;
    const ensureCustomer = vi.fn<BillingStripeGateway["ensureCustomer"]>(async () =>
      callIndex++ === 0 ? "cus_competing_a" : "cus_competing_b",
    );
    const checkout = vi.fn<BillingStripeGateway["checkout"]>(async () => ({
      sessionId: "cs_competing",
      url: "https://stripe.test/checkout",
    }));
    const routesGateway = { ...gateway(), ensureCustomer, checkout };
    const responses = await Promise.all([
      callCheckout(routesGateway, "admin-user", {
        kind: "additional",
        credits: 250,
        idempotencyKey: "checkout-compete-a",
      }),
      callCheckout(routesGateway, "admin-user", {
        kind: "additional",
        credits: 250,
        idempotencyKey: "checkout-compete-b",
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(checkout).toHaveBeenCalledTimes(1);
  });

  it("recovers a provider commit followed by response loss with the same Stripe key", async () => {
    let attempts = 0;
    const checkout = vi.fn<BillingStripeGateway["checkout"]>(async (input) => {
      expect(input.idempotencyKey).toBe(
        `brief-checkout:${companyId}:checkout-response-loss-0001:session`,
      );
      attempts += 1;
      if (attempts === 1) throw new Error("provider_response_lost_after_commit");
      return { sessionId: "cs_response_loss", url: "https://stripe.test/recovered" };
    });
    const routesGateway = { ...gateway(), checkout };
    const body = {
      kind: "additional",
      credits: 125,
      idempotencyKey: "checkout-response-loss-0001",
    } as const;
    const first = await callCheckout(routesGateway, "admin-user", body);
    const replay = await callCheckout(routesGateway, "admin-user", body);
    expect(first.status).toBe(503);
    expect(replay.status).toBe(201);
    await expect(replay.json()).resolves.toEqual({ url: "https://stripe.test/recovered" });
    expect(checkout).toHaveBeenCalledTimes(2);
    expect(checkout.mock.calls[0]?.[0].idempotencyKey).toBe(
      checkout.mock.calls[1]?.[0].idempotencyKey,
    );
    const attemptsRow = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly attempts: number }>`
          select attempts
          from client_ai_checkout_requests
          where client_company_id = ${companyId}
            and idempotency_key = ${body.idempotencyKey}
        `)[0]!.attempts;
      }),
    );
    expect(attemptsRow).toBe(2);
  });

  it("commits the immutable reservation before entering Stripe Checkout", async () => {
    let observed:
      | { readonly status: string; readonly attempts: number; readonly key: string }
      | undefined;
    const checkout = vi.fn<BillingStripeGateway["checkout"]>(async (input) => {
      observed = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly status: string;
            readonly attempts: number;
            readonly key: string;
          }>`
            select status, attempts, idempotency_key as key
            from client_ai_checkout_requests
            where client_company_id = ${companyId}
              and stripe_operation_key = ${input.idempotencyKey}
          `)[0];
        }),
      );
      return { sessionId: "cs_durable_before_provider", url: "https://stripe.test/durable" };
    });
    const body = {
      kind: "additional",
      credits: 50,
      idempotencyKey: "checkout-durable-before-provider-1",
    } as const;
    const response = await callCheckout({ ...gateway(), checkout }, "admin-user", body);
    expect(response.status).toBe(201);
    expect(observed).toEqual({
      status: "processing",
      attempts: 1,
      key: body.idempotencyKey,
    });
  });

  it("phase B refuses to create a missing phase-A reservation", async () => {
    const idempotencyKey = "checkout-phase-b-missing-0001";
    await expect(
      runDb(
        reserveBillingCheckout({
          companyId,
          idempotencyKey,
          userId: "admin-user",
          authorizationRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          authorizationSessionId: "phase-b-missing-session",
          authorizationOrganizationId: null,
          authorizationMode: "demo",
          authorizationMfaVerified: true,
          kind: "additional",
          planTier: null,
          credits: 25,
          customerId: "cus_client",
          priceId: "price_additional",
          successUrl: "https://brief.test/billing/success",
          cancelUrl: "https://brief.test/billing/cancel",
          stripeOperationKey: `brief-checkout:${companyId}:${idempotencyKey}:session`,
          allowNew: false,
          requireExisting: true,
          claimExisting: true,
        }),
      ),
    ).rejects.toThrow("billing_checkout_reservation_missing");
    const rows = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql`
          select count(*)::int as count
          from client_ai_checkout_requests
          where client_company_id = ${companyId} and idempotency_key = ${idempotencyKey}
        `;
      }),
    );
    expect(rows[0]!.count).toBe(0);
  });

  it("blocks a fresh same-key replay and fences the exact-key retry after expiry", async () => {
    const idempotencyKey = "checkout-lease-fence-0001";
    const reservationInput = {
      companyId,
      idempotencyKey,
      userId: "admin-user",
      authorizationRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      authorizationSessionId: "lease-fence-session",
      authorizationOrganizationId: null,
      authorizationMode: "demo" as const,
      authorizationMfaVerified: true,
      kind: "additional" as const,
      planTier: null,
      credits: 25,
      customerId: "cus_client",
      priceId: "price_additional",
      successUrl: "https://brief.test/billing/success",
      cancelUrl: "https://brief.test/billing/cancel",
      stripeOperationKey: `brief-checkout:${companyId}:${idempotencyKey}:session`,
      allowNew: true,
    };
    const first = await runDb(reserveBillingCheckout(reservationInput));
    expect(first.kind).toBe("execute");
    const freshReplay = await runDb(reserveBillingCheckout(reservationInput));
    expect(freshReplay).toEqual({ kind: "in_progress" });
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_ai_checkout_requests
          set lease_expires_at = now() - interval '1 second'
          where client_company_id = ${companyId} and idempotency_key = ${idempotencyKey}
        `;
      }),
    );
    const expiredReplay = await runDb(reserveBillingCheckout(reservationInput));
    expect(expiredReplay.kind).toBe("execute");
    if (expiredReplay.kind === "execute" && first.kind === "execute") {
      expect(expiredReplay.attempts).toBe(first.attempts + 1);
      expect(expiredReplay.stripeOperationKey).toBe(first.stripeOperationKey);
      expect(expiredReplay.leaseToken).not.toBe(first.leaseToken);
    }
  });

  it("serializes concurrent identical keys to one payable session and stable responses", async () => {
    let started!: () => void;
    const startedSignal = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checkout = vi.fn<BillingStripeGateway["checkout"]>(async () => {
      started();
      await gate;
      return { sessionId: "cs_concurrent_same", url: "https://stripe.test/concurrent" };
    });
    const routesGateway = { ...gateway(), checkout };
    const body = {
      kind: "additional",
      credits: 333,
      idempotencyKey: "checkout-concurrent-same-1",
    } as const;
    const first = callCheckout(routesGateway, "admin-user", body);
    await startedSignal;
    const second = callCheckout(routesGateway, "admin-user", body);
    await waitForAdvisoryWaiters(1);
    release();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(await responses[0]!.clone().json()).toEqual({ url: "https://stripe.test/concurrent" });
    expect(await responses[1]!.clone().json()).toEqual({ url: "https://stripe.test/concurrent" });
    expect(checkout).toHaveBeenCalledOnce();
    const rows = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly count: number; readonly sessions: number }>`
          select count(*)::int,
                 count(stripe_checkout_session_id)::int as sessions
          from client_ai_checkout_requests
          where client_company_id = ${companyId}
            and idempotency_key = 'checkout-concurrent-same-1'
        `)[0]!;
      }),
    );
    expect(rows).toEqual({ count: 1, sessions: 1 });
  });

  it("rejects a changed purchase body under an already completed key", async () => {
    const checkout = vi.fn<BillingStripeGateway["checkout"]>(async () => ({
      sessionId: "cs_conflict",
      url: "https://stripe.test/conflict",
    }));
    const routesGateway = { ...gateway(), checkout };
    const first = await callCheckout(routesGateway, "admin-user", {
      kind: "additional",
      credits: 100,
      idempotencyKey: "checkout-body-conflict-1",
    });
    const conflict = await callCheckout(routesGateway, "admin-user", {
      kind: "additional",
      credits: 101,
      idempotencyKey: "checkout-body-conflict-1",
    });
    expect(first.status).toBe(201);
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      code: "billing_checkout_idempotency_conflict",
    });
    expect(checkout).toHaveBeenCalledOnce();
  });

  it("binds the protected checkout key to its original actor", async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_memberships
          set role = 'admin'
          where company_id = ${companyId} and user_id = 'member-user'
        `;
      }),
    );
    const checkout = vi.fn<BillingStripeGateway["checkout"]>(async () => ({
      sessionId: "cs_actor_binding",
      url: "https://stripe.test/actor-binding",
    }));
    const routesGateway = { ...gateway(), checkout };
    const body = {
      kind: "additional",
      credits: 42,
      idempotencyKey: "checkout-actor-binding-1",
    } as const;
    expect((await callCheckout(routesGateway, "admin-user", body)).status).toBe(201);
    const conflict = await callCheckout(routesGateway, "member-user", body);
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      code: "billing_checkout_idempotency_conflict",
    });
    expect(checkout).toHaveBeenCalledOnce();
  });

  it("does not bind or start Checkout when authoritative customer creation fails", async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`update client_companies set stripe_customer_id = null where id = ${companyId}`;
      }),
    );
    const checkout = vi.fn<BillingStripeGateway["checkout"]>();
    const response = await callCheckout(
      {
        ...gateway(),
        ensureCustomer: async () => {
          throw new Error("provider unavailable");
        },
        checkout,
      },
      "admin-user",
      { kind: "additional", credits: 250, idempotencyKey: "checkout-failure-0001" },
    );
    expect(response.status).toBe(503);
    expect(checkout).not.toHaveBeenCalled();
    const bound = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly customerId: string | null }>`
          select stripe_customer_id as "customerId" from client_companies where id = ${companyId}
        `)[0]!.customerId;
      }),
    );
    expect(bound).toBeNull();
  });

  it("records a same-tier no-op once, replays it exactly, audits both calls, and never touches credits", async () => {
    const changeMonthlyPlan = vi.fn<BillingStripeGateway["changeMonthlyPlan"]>();
    const routesGateway = gateway(changeMonthlyPlan);
    const body = { planTier: "team", idempotencyKey: "same-tier-0001" } as const;
    const first = await call(routesGateway, "admin-user", body);
    const second = await call(routesGateway, "admin-user", body);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      change: { status: "unchanged", previousTier: "team", planTier: "team", effectiveAt: null },
    });
    await expect(second.json()).resolves.toEqual({
      change: { status: "unchanged", previousTier: "team", planTier: "team", effectiveAt: null },
    });
    expect(changeMonthlyPlan).not.toHaveBeenCalled();
    await expect(billingState()).resolves.toEqual({
      planTier: "team",
      priceId: "price_team",
      pendingTier: null,
      pendingScheduleId: null,
      additionalRemaining: 275,
    });
    const ledger = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ requests: number; attempts: number; audits: number }>`
          select (select count(*)::int from client_ai_plan_change_requests) requests,
                 (select attempts from client_ai_plan_change_requests limit 1) attempts,
                 (select count(*)::int from platform_authorization_audit_log
                  where action = 'client.billing.plan_change.unchanged'
                    and outcome = 'succeeded') audits
        `)[0]!;
      }),
    );
    expect(ledger).toEqual({ requests: 1, attempts: 1, audits: 2 });
  });

  it("applies a paid upgrade immediately, replays the stored response, and binds a key to its tier", async () => {
    const changeMonthlyPlan = vi.fn<BillingStripeGateway["changeMonthlyPlan"]>(async () => ({
      kind: "upgraded",
      effectiveAt: "2026-07-10T12:00:00.000Z",
      externalOperationId: "in_upgrade_1",
    }));
    const routesGateway = gateway(changeMonthlyPlan);
    const body = { planTier: "intensive", idempotencyKey: "upgrade-tier-0001" } as const;
    const first = await call(routesGateway, "admin-user", body);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      change: {
        status: "upgraded",
        previousTier: "team",
        planTier: "intensive",
        effectiveAt: "2026-07-10T12:00:00.000Z",
      },
    });
    expect(changeMonthlyPlan).toHaveBeenCalledWith({
      companyId,
      customerId: "cus_client",
      subscriptionId: "sub_client",
      currentTier: "team",
      targetTier: "intensive",
      currentPriceId: "price_team",
      targetPriceId: "price_intensive",
      currentPeriodEnd: periodEnd,
      idempotencyKey: "upgrade-tier-0001",
    });
    expect((await call(routesGateway, "admin-user", body)).status).toBe(200);
    expect(changeMonthlyPlan).toHaveBeenCalledOnce();
    const conflict = await call(routesGateway, "admin-user", {
      planTier: "light",
      idempotencyKey: body.idempotencyKey,
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ code: "plan_change_idempotency_conflict" });
    await expect(billingState()).resolves.toEqual({
      planTier: "intensive",
      priceId: "price_intensive",
      pendingTier: null,
      pendingScheduleId: null,
      additionalRemaining: 275,
    });
  });

  it("keeps the current plan until a downgrade's next cycle and recognizes the same schedule under a new key", async () => {
    const changeMonthlyPlan = vi.fn<BillingStripeGateway["changeMonthlyPlan"]>(async () => ({
      kind: "downgrade_scheduled",
      effectiveAt: periodEnd,
      externalOperationId: "sub_sched_down_1",
    }));
    const routesGateway = gateway(changeMonthlyPlan);
    const first = await call(routesGateway, "admin-user", {
      planTier: "light",
      idempotencyKey: "downgrade-0001",
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      change: { status: "downgrade_scheduled", previousTier: "team", planTier: "light" },
    });
    expect(await billingState()).toEqual({
      planTier: "team",
      priceId: "price_team",
      pendingTier: "light",
      pendingScheduleId: "sub_sched_down_1",
      additionalRemaining: 275,
    });
    const sameSchedule = await call(routesGateway, "admin-user", {
      planTier: "light",
      idempotencyKey: "downgrade-0002",
    });
    expect(sameSchedule.status).toBe(200);
    expect(changeMonthlyPlan).toHaveBeenCalledOnce();
    const conflict = await call(routesGateway, "admin-user", {
      planTier: "intensive",
      idempotencyKey: "different-plan-0001",
    });
    expect(conflict.status).toBe(409);
    expect(await billingState()).toMatchObject({ additionalRemaining: 275 });
  });

  it("persists a bounded failed attempt and safely retries the same snapshot", async () => {
    const changeMonthlyPlan = vi
      .fn<BillingStripeGateway["changeMonthlyPlan"]>()
      .mockRejectedValueOnce(new Error("provider body that must not be stored"))
      .mockResolvedValueOnce({
        kind: "upgraded",
        effectiveAt: "2026-07-10T12:00:00.000Z",
        externalOperationId: "in_retry_1",
      });
    const routesGateway = gateway(changeMonthlyPlan);
    const body = { planTier: "intensive", idempotencyKey: "retry-upgrade-0001" } as const;
    const failed = await call(routesGateway, "admin-user", body);
    expect(failed.status).toBe(503);
    expect(await billingState()).toMatchObject({ planTier: "team", additionalRemaining: 275 });
    const retry = await call(routesGateway, "admin-user", body);
    expect(retry.status).toBe(200);
    expect(changeMonthlyPlan).toHaveBeenCalledTimes(2);
    const record = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          status: string;
          attempts: number;
          errorCode: string | null;
          previousPriceId: string;
        }>`
          select status, attempts, error_code as "errorCode",
                 previous_price_id as "previousPriceId"
          from client_ai_plan_change_requests
          where client_company_id = ${companyId} and idempotency_key = ${body.idempotencyKey}
        `)[0]!;
      }),
    );
    expect(record).toEqual({
      status: "succeeded",
      attempts: 2,
      errorCode: null,
      previousPriceId: "price_team",
    });
  });

  it("serializes concurrent calls and invokes Stripe only once", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const changeMonthlyPlan = vi.fn<BillingStripeGateway["changeMonthlyPlan"]>(async () => {
      await blocked;
      return {
        kind: "upgraded",
        effectiveAt: "2026-07-10T12:00:00.000Z",
        externalOperationId: "in_concurrent_1",
      };
    });
    const routesGateway = gateway(changeMonthlyPlan);
    const body = { planTier: "intensive", idempotencyKey: "concurrent-0001" } as const;
    const first = call(routesGateway, "admin-user", body);
    await vi.waitFor(() => expect(changeMonthlyPlan).toHaveBeenCalledOnce());
    const second = await call(routesGateway, "admin-user", body);
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({ code: "plan_change_in_progress" });
    const competing = await call(routesGateway, "admin-user", {
      planTier: "light",
      idempotencyKey: "concurrent-0002",
    });
    expect(competing.status).toBe(409);
    await expect(competing.json()).resolves.toEqual({ code: "plan_change_in_progress" });
    release();
    expect((await first).status).toBe(200);
    expect(changeMonthlyPlan).toHaveBeenCalledOnce();
  });

  it("recovers an upgrade projected by a webhook using the original stored Stripe snapshot", async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into client_ai_plan_change_requests (
            client_company_id, idempotency_key, requested_by_user_id,
            authorization_request_id, authorization_session_id,
            previous_tier, target_tier, stripe_customer_id, stripe_subscription_id,
            previous_price_id, target_price_id, current_period_end,
            status, error_code
          ) values (
            ${companyId}, 'webhook-recovery-0001', 'admin-user',
            '90000000-0000-4000-8000-000000000009', 'recovery-session', 'team', 'intensive',
            'cus_client', 'sub_client', 'price_team', 'price_intensive', ${new Date(periodEnd)},
            'failed', 'stripe_request_failed'
          )
        `;
        yield* sql`
          update client_ai_billing_accounts
          set plan_tier = 'intensive', stripe_price_id = 'price_intensive'
          where client_company_id = ${companyId}
        `;
      }),
    );
    const changeMonthlyPlan = vi.fn<BillingStripeGateway["changeMonthlyPlan"]>(async () => ({
      kind: "upgraded",
      effectiveAt: "2026-07-10T12:00:00.000Z",
      externalOperationId: "in_webhook_recovery_1",
    }));
    const response = await call(gateway(changeMonthlyPlan), "admin-user", {
      planTier: "intensive",
      idempotencyKey: "webhook-recovery-0001",
    });
    expect(response.status).toBe(200);
    expect(changeMonthlyPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        currentTier: "team",
        currentPriceId: "price_team",
        targetTier: "intensive",
        targetPriceId: "price_intensive",
      }),
    );
    expect(await billingState()).toMatchObject({ planTier: "intensive", additionalRemaining: 275 });
  });

  it("expires a different abandoned processing lease before accepting a new protected request", async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into client_ai_plan_change_requests (
            client_company_id, idempotency_key, requested_by_user_id,
            authorization_request_id, authorization_session_id,
            previous_tier, target_tier, stripe_customer_id, stripe_subscription_id,
            previous_price_id, target_price_id, current_period_end, status
          ) values (
            ${companyId}, 'abandoned-change-0001', 'admin-user',
            '90000000-0000-4000-8000-000000000015', 'abandoned-session',
            'team', 'intensive', 'cus_client', 'sub_client',
            'price_team', 'price_intensive', ${new Date(periodEnd)}, 'processing'
          )
        `;
        yield* sql`
          update client_ai_plan_change_requests
          set updated_at = now() - interval '10 minutes'
          where client_company_id = ${companyId}
            and idempotency_key = 'abandoned-change-0001'
        `;
      }),
    );
    const changeMonthlyPlan = vi.fn<BillingStripeGateway["changeMonthlyPlan"]>();
    const response = await call(gateway(changeMonthlyPlan), "admin-user", {
      planTier: "team",
      idempotencyKey: "replacement-noop-0001",
    });
    expect(response.status).toBe(200);
    expect(changeMonthlyPlan).not.toHaveBeenCalled();
    const abandoned = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ status: string; errorCode: string; deniedAudits: number }>`
          select request.status, request.error_code as "errorCode",
                 (select count(*)::int from platform_authorization_audit_log
                  where request_id = '90000000-0000-4000-8000-000000000015'
                    and action = 'client.billing.plan_change'
                    and outcome = 'denied' and reason_code = 'request_abandoned')
                   as "deniedAudits"
          from client_ai_plan_change_requests request
          where request.client_company_id = ${companyId}
            and request.idempotency_key = 'abandoned-change-0001'
        `)[0]!;
      }),
    );
    expect(abandoned).toEqual({
      status: "failed",
      errorCode: "request_abandoned",
      deniedAudits: 1,
    });
  });

  it("requires an MFA-verified admin and records denied member mutations", async () => {
    const denied = await call(gateway(), "member-user", {
      planTier: "intensive",
      idempotencyKey: "member-denied-0001",
    });
    expect(denied.status).toBe(404);
    const audit = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ outcome: string; reasonCode: string }>`
          select outcome, reason_code as "reasonCode"
          from platform_authorization_audit_log
          where action = 'client.billing.plan_change'
            and actor_user_id = 'member-user'
        `)[0]!;
      }),
    );
    expect(audit).toEqual({ outcome: "denied", reasonCode: "forbidden" });
    await expect(
      runDb(
        requireClientCompanyAdmin(
          {
            userId: "admin-user",
            organizationId: "org_client",
            sessionId: "session-without-mfa",
            mfaVerified: false,
            mode: "clerk",
          },
          companyId,
        ),
      ),
    ).rejects.toMatchObject({ code: "mfa_required" });
  });

  it("audits an authenticated malformed administrative mutation without invoking Stripe", async () => {
    const changeMonthlyPlan = vi.fn<BillingStripeGateway["changeMonthlyPlan"]>();
    const response = await call(gateway(changeMonthlyPlan), "admin-user", {
      planTier: "team",
      idempotencyKey: "short",
    });
    expect(response.status).toBe(400);
    expect(changeMonthlyPlan).not.toHaveBeenCalled();
    const audit = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ outcome: string; reasonCode: string }>`
          select outcome, reason_code as "reasonCode"
          from platform_authorization_audit_log
          where action = 'client.billing.plan_change' and actor_user_id = 'admin-user'
        `)[0]!;
      }),
    );
    expect(audit).toEqual({ outcome: "denied", reasonCode: "invalid_body" });
  });

  it("fills a missing domain audit for malformed administrative branches at the HTTP boundary", async () => {
    const checkout = vi.fn<BillingStripeGateway["checkout"]>();
    const routesGateway = { ...gateway(), checkout };
    const response = await callCheckout(routesGateway, "admin-user", {});
    expect(response.status).toBe(400);
    expect(checkout).not.toHaveBeenCalled();
    const audits = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ outcome: string; reasonCode: string }>`
          select outcome, reason_code as "reasonCode"
          from platform_authorization_audit_log
          where action = 'client.billing.checkout'
            and actor_user_id = 'admin-user'
        `;
      }),
    );
    expect(audits).toEqual([{ outcome: "denied", reasonCode: "invalid_body" }]);
  });

  it("linearizes admin revocation before Checkout and Portal capability issuance", async () => {
    const ensureCustomer = vi.fn<BillingStripeGateway["ensureCustomer"]>(async () => "cus_client");
    const checkout = vi.fn<BillingStripeGateway["checkout"]>(async () =>
      Promise.resolve({ sessionId: "cs_lease", url: "https://stripe.test/checkout" }),
    );
    const portal = vi.fn<BillingStripeGateway["portal"]>(async () =>
      Promise.resolve("https://stripe.test/portal"),
    );
    const routesGateway = { ...gateway(), ensureCustomer, checkout, portal };

    const revokeBefore = async (capability: () => Promise<Response>): Promise<Response> => {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update client_company_memberships
            set role = 'admin'
            where company_id = ${companyId} and user_id = 'member-user'
          `;
          yield* sql`
            update client_company_memberships
            set revoked_at = null, revoked_by_user_id = null
            where company_id = ${companyId} and user_id = 'admin-user'
          `;
        }),
      );
      let signalHeld!: () => void;
      const held = new Promise<void>((resolve) => {
        signalHeld = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                select pg_advisory_xact_lock(hashtext(${`brief:client-members:${companyId}`}))
              `;
              yield* Effect.sync(signalHeld);
              yield* Effect.promise(() => released);
            }),
          );
        }),
      );
      await held;
      const revocation = runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                select pg_advisory_xact_lock(hashtext(${`brief:client-members:${companyId}`}))
              `;
              yield* sql`
                update client_company_memberships
                set revoked_at = now(), revoked_by_user_id = 'member-user'
                where company_id = ${companyId} and user_id = 'admin-user'
              `;
            }),
          );
        }),
      );
      await waitForAdvisoryWaiters(1);
      const response = capability();
      await waitForAdvisoryWaiters(2);
      release();
      await holder;
      await revocation;
      return response;
    };

    const checkoutResponse = await revokeBefore(() =>
      callCheckout(routesGateway, "admin-user", {
        kind: "additional",
        credits: 10,
        idempotencyKey: "checkout-revoked-0001",
      }),
    );
    expect(checkoutResponse.status).toBe(404);
    expect(ensureCustomer).not.toHaveBeenCalled();
    expect(checkout).not.toHaveBeenCalled();

    const portalResponse = await revokeBefore(() => callPortal(routesGateway, "admin-user"));
    expect(portalResponse.status).toBe(404);
    expect(portal).not.toHaveBeenCalled();

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_memberships
          set revoked_at = null, revoked_by_user_id = null
          where company_id = ${companyId} and user_id = 'admin-user'
        `;
        yield* sql`
          update client_company_memberships
          set role = 'member'
          where company_id = ${companyId} and user_id = 'member-user'
        `;
      }),
    );
  });

  it("fails closed when a mandatory billing denial audit cannot be persisted", async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(`
          create or replace function reject_billing_denial_audit_for_test()
          returns trigger
          language plpgsql
          as $$
          begin
            if new.action = 'client.billing.portal.create' and new.outcome = 'denied' then
              raise exception 'injected_billing_denial_audit_failure';
            end if;
            return new;
          end;
          $$
        `).raw;
        yield* sql.unsafe(`
          create trigger reject_billing_denial_audit_for_test
          before insert on platform_authorization_audit_log
          for each row execute function reject_billing_denial_audit_for_test()
        `).raw;
      }),
    );
    try {
      const response = await callPortal(gateway(), "member-user");
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "internal_error" });
    } finally {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            drop trigger if exists reject_billing_denial_audit_for_test
            on platform_authorization_audit_log
          `;
          yield* sql`drop function if exists reject_billing_denial_audit_for_test()`;
        }),
      );
    }
  });

  it("holds the live requester row through Checkout against Clerk user deletion", async () => {
    let signalCheckoutStarted!: () => void;
    const checkoutStarted = new Promise<void>((resolve) => {
      signalCheckoutStarted = resolve;
    });
    let releaseCheckout!: () => void;
    const checkoutReleased = new Promise<void>((resolve) => {
      releaseCheckout = resolve;
    });
    const checkout = vi.fn<BillingStripeGateway["checkout"]>(async (input) => {
      expect(input.signal.aborted).toBe(false);
      signalCheckoutStarted();
      await checkoutReleased;
      return { sessionId: "cs_user_lease", url: "https://stripe.test/checkout-user-lease" };
    });
    const capability = callCheckout({ ...gateway(), checkout }, "admin-user", {
      kind: "additional",
      credits: 10,
      idempotencyKey: "checkout-user-lease-1",
    });
    await checkoutStarted;
    let deletionFinished = false;
    const deletion = runDbAs(
      "billing-clerk-user-deletion-race",
      acceptClerkWebhook({
        eventId: "evt_billing_user_deleted",
        eventTimestamp: Math.floor(Date.now() / 1_000),
        payloadHash: "d".repeat(64),
        event: {
          type: "user.deleted",
          data: { id: "clerk-admin", deleted: true },
        } as unknown as WebhookEvent,
      }),
    ).then((result) => {
      deletionFinished = true;
      return result;
    });
    await waitForDatabaseLock("billing-clerk-user-deletion-race");
    expect(deletionFinished).toBe(false);
    releaseCheckout();
    expect((await capability).status).toBe(201);
    await expect(deletion).resolves.toBe("processed");
    expect(checkout).toHaveBeenCalledOnce();
    const deleted = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly deleted: boolean }>`
          select recovery_deleted_at is not null as deleted
          from platform_users where id = 'admin-user'
        `)[0]!.deleted;
      }),
    );
    expect(deleted).toBe(true);
  });

  it("holds the live company row through Portal against approved company deletion", async () => {
    const deletionRequestId = crypto.randomUUID();
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into company_deletion_requests (
            id, client_company_id, requested_by_user_id, reason, idempotency_key
          ) values (
            ${deletionRequestId}, ${companyId}, 'admin-user', 'Close billing company',
            'billing-company-deletion-request'
          )
        `;
      }),
    );
    let signalPortalStarted!: () => void;
    const portalStarted = new Promise<void>((resolve) => {
      signalPortalStarted = resolve;
    });
    let releasePortal!: () => void;
    const portalReleased = new Promise<void>((resolve) => {
      releasePortal = resolve;
    });
    const portal = vi.fn<BillingStripeGateway["portal"]>(async (input) => {
      expect(input.signal.aborted).toBe(false);
      signalPortalStarted();
      await portalReleased;
      return "https://stripe.test/portal-company-lease";
    });
    const capability = callPortal({ ...gateway(), portal }, "admin-user");
    await portalStarted;
    let deletionFinished = false;
    const deletion = runDbAs(
      "billing-company-deletion-race",
      resolveCompanyDeletionRequest({
        deletionRequestId,
        decision: "approved",
        idempotencyKey: "billing-company-deletion-decision",
        actorUserId: "member-user",
        auditSucceeded: () => Effect.void,
      }),
    ).then((result) => {
      deletionFinished = true;
      return result;
    });
    await waitForDatabaseLock("billing-company-deletion-race");
    expect(deletionFinished).toBe(false);
    releasePortal();
    expect((await capability).status).toBe(201);
    await expect(deletion).resolves.toMatchObject({ duplicate: false });
    expect(portal).toHaveBeenCalledOnce();
    const deleted = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly deleted: boolean }>`
          select recovery_deleted_at is not null as deleted
          from client_companies where id = ${companyId}
        `)[0]!.deleted;
      }),
    );
    expect(deleted).toBe(true);
  });
});
