import {
  aiUsageRequestDescriptor,
  bindBillingCustomer,
  createAiUsageRequest as createAiUsageRequestRecord,
  failMonthlyPlanChange,
  finalizeMonthlyPlanChange,
  loadAiUsageOverview,
  loadBillingCheckoutContext,
  loadBillingPortalCustomer,
  finalizeBillingCheckout,
  reserveMonthlyPlanChange,
  reserveBillingCheckout,
  releaseBillingCheckoutLease,
  resolveAiUsageRequest as resolveAiUsageRequestRecord,
  updateAiLimit,
  withBillingAuthorizationLease,
} from "@hartlib/backend-domain/billing";
import {
  ChangeMonthlyPlanRequest,
  CreateAiUsageRequest,
  CreateBillingCheckoutRequest,
  ResolveAiUsageRequest,
  UpdateCompanyAiLimitRequest,
  UpdateEmployeeAiLimitRequest,
  type AiPlanTier,
  type MonthlyPlanChangeDescriptor,
} from "@hartlib/shared";
import {
  appendAuthorizationAudit,
  appendDeniedAuthorizationAudit,
  requestIdForAudit,
  WorkspaceAuthorizationError as AuthorizationError,
  requireClientCompanyAdmin,
  requireClientCompanyMembership,
} from "@hartlib/workspace";
import { Effect, Schema } from "effect";
import Stripe from "stripe";

import { resolveRequestIdentity } from "../auth";
import {
  compareAiPlanTiers,
  makeLiveBillingPlanChangeGateway,
  type BillingPlanChangeGateway,
} from "../billing-plan-change";
import { loadApiConfig, type ApiConfig } from "../config";
import {
  ApiDatabaseLayer,
  type ApiDatabaseLayer as ApiDatabaseLayerType,
  type ApiDatabaseService,
} from "../database";
import { json, type Route } from "../http";
import { withAdministrativeAuditing } from "./administrative-audit";

export interface BillingStripeGateway extends BillingPlanChangeGateway {
  readonly ensureCustomer: (input: {
    readonly signal: AbortSignal;
    readonly customerId: string | null;
    readonly customerEmail: string;
    readonly companyId: string;
    readonly idempotencyKey: string;
  }) => Promise<string>;
  readonly checkout: (input: {
    readonly signal: AbortSignal;
    readonly customerId: string;
    readonly customerEmail: string;
    readonly companyId: string;
    readonly kind: "monthly" | "additional";
    readonly planTier: "light" | "team" | "intensive" | null;
    readonly credits: number | null;
    readonly priceId: string;
    readonly successUrl: string;
    readonly cancelUrl: string;
    readonly metadata: Record<string, string>;
    readonly automaticTaxEnabled: true;
    readonly billingAddressCollection: "required";
    readonly taxIdCollectionEnabled: true;
    readonly updateExistingCustomerAddress: boolean;
    readonly idempotencyKey: string;
  }) => Promise<{ readonly sessionId: string; readonly url: string }>;
  readonly portal: (input: {
    readonly signal: AbortSignal;
    readonly customerId: string;
    readonly returnUrl: string;
  }) => Promise<string>;
}

export const BILLING_CAPABILITY_PROVIDER_TIMEOUT_MS = 20_000;

const stripeCheckoutSessionId = /^cs_[A-Za-z0-9_]{1,251}$/u;

const validCheckoutResult = (value: {
  readonly sessionId: string;
  readonly url: string;
}): boolean => {
  if (!stripeCheckoutSessionId.test(value.sessionId)) return false;
  try {
    const url = new URL(value.url);
    return (
      url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === ""
    );
  } catch {
    return false;
  }
};

const liveGateway = (secretKey: string): BillingStripeGateway => {
  const stripe = new Stripe(secretKey, { maxNetworkRetries: 1, timeout: 20_000 });
  const planChanges = makeLiveBillingPlanChangeGateway(stripe);
  return {
    ...planChanges,
    ensureCustomer: async (input) => {
      const customer =
        input.customerId === null
          ? await stripe.customers.create(
              {
                email: input.customerEmail,
                metadata: { hartlib_client_company_id: input.companyId },
              },
              { idempotencyKey: input.idempotencyKey },
            )
          : await stripe.customers.retrieve(input.customerId);
      if (
        ("deleted" in customer && customer.deleted === true) ||
        !("metadata" in customer) ||
        customer.metadata.hartlib_client_company_id !== input.companyId
      ) {
        throw new Error("stripe_customer_company_mismatch");
      }
      return customer.id;
    },
    checkout: async (input) => {
      const session = await stripe.checkout.sessions.create(
        {
          mode: input.kind === "monthly" ? "subscription" : "payment",
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          client_reference_id: input.companyId,
          customer: input.customerId,
          billing_address_collection: input.billingAddressCollection,
          automatic_tax: { enabled: input.automaticTaxEnabled },
          tax_id_collection: { enabled: input.taxIdCollectionEnabled },
          customer_update: { address: "auto" as const, name: "auto" as const },
          line_items: [{ price: input.priceId, quantity: input.credits ?? 1 }],
          metadata: input.metadata,
          ...(input.kind === "monthly" ? { subscription_data: { metadata: input.metadata } } : {}),
          allow_promotion_codes: false,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      if (session.url === null) throw new Error("stripe_checkout_url_missing");
      if (!stripeCheckoutSessionId.test(session.id))
        throw new Error("stripe_checkout_session_invalid");
      return { sessionId: session.id, url: session.url };
    },
    portal: async (input) => {
      const session = await stripe.billingPortal.sessions.create({
        customer: input.customerId,
        return_url: input.returnUrl,
      });
      return session.url;
    },
  };
};

const authenticate = (request: Request) =>
  Effect.gen(function* () {
    const config = yield* loadApiConfig;
    return yield* resolveRequestIdentity(request, config);
  });

const provided = <A, E>(
  effect: Effect.Effect<A, E, ApiDatabaseService>,
  databaseLayer: ApiDatabaseLayerType,
) =>
  effect.pipe(
    Effect.provide(databaseLayer),
    Effect.match({
      onFailure: (error) => ({ ok: false as const, error }),
      onSuccess: (value) => ({ ok: true as const, value }),
    }),
  );

const authResponse = (error: unknown) =>
  error instanceof AuthorizationError
    ? json({ code: error.code }, { status: error.code === "mfa_required" ? 403 : 404 })
    : null;

const auditDenied = (
  identity: Parameters<typeof appendAuthorizationAudit>[0]["identity"],
  requestId: string,
  action: string,
  scopeKind: string,
  scopeId: string,
  error: unknown,
  databaseLayer: ApiDatabaseLayerType,
) =>
  appendDeniedAuthorizationAudit({ identity, requestId, action, scopeKind, scopeId, error }).pipe(
    Effect.provide(databaseLayer),
  );

const priceForTier = (config: ApiConfig, tier: AiPlanTier): string =>
  tier === "light"
    ? config.stripePriceLight
    : tier === "team"
      ? config.stripePriceTeam
      : config.stripePriceIntensive;

const planPrices = (config: ApiConfig) => ({
  light: config.stripePriceLight,
  team: config.stripePriceTeam,
  intensive: config.stripePriceIntensive,
});

const planChangeAction = (outcome?: MonthlyPlanChangeDescriptor["status"]): string =>
  `client.billing.plan_change${outcome === undefined ? "" : `.${outcome}`}`;

export const makeBillingRoutes = (
  databaseLayer: ApiDatabaseLayerType = ApiDatabaseLayer,
  injectedGateway?: BillingStripeGateway,
): readonly Route[] => {
  const routes: Route[] = [];

  routes.push({
    method: "POST",
    path: "/v1/client-companies/:companyId/billing/checkout",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const companyId = pathParameters.companyId!;
        const authentication = yield* authenticate(request);
        if (!authentication.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const body = input.body as Schema.Schema.Type<typeof CreateBillingCheckoutRequest>;
        const config = yield* loadApiConfig;
        const gateway =
          injectedGateway ??
          (config.stripeSecretKey === "" ? null : liveGateway(config.stripeSecretKey));
        const priceId =
          body.kind === "monthly"
            ? priceForTier(config, body.planTier)
            : config.stripePriceAdditionalCredit;
        // Phase A is deliberately a short, fully committed authorization
        // transaction.  It creates the immutable Checkout reservation before
        // any Checkout capability can be issued.  A provider response (or a
        // process crash) can therefore never leave a provider-side session
        // with no durable local idempotency row.
        const phaseA = yield* provided(
          withBillingAuthorizationLease({
            companyId,
            userId: authentication.identity.userId,
            authorize: requireClientCompanyAdmin(authentication.identity, companyId),
            operation: Effect.gen(function* () {
              const context = yield* loadBillingCheckoutContext({
                companyId,
                userId: authentication.identity.userId,
                authorize: Effect.void,
              });
              if (context === null) {
                return yield* Effect.fail(new AuthorizationError("not_found"));
              }
              if (
                gateway === null ||
                priceId === "" ||
                config.stripeCheckoutSuccessUrl === "" ||
                config.stripeCheckoutCancelUrl === ""
              ) {
                return {
                  kind: "response" as const,
                  response: json({ code: "billing_unavailable" }, { status: 503 }),
                };
              }
              const customerId = yield* Effect.tryPromise({
                try: (signal) =>
                  gateway.ensureCustomer({
                    signal,
                    customerId: context.customerId,
                    customerEmail: context.email,
                    companyId,
                    idempotencyKey: `hartlib-customer:${companyId}`,
                  }),
                catch: (error) => error,
              }).pipe(
                Effect.timeout(`${BILLING_CAPABILITY_PROVIDER_TIMEOUT_MS} millis`),
                Effect.match({ onFailure: () => null, onSuccess: (value) => value }),
              );
              if (customerId === null || !/^cus_[A-Za-z0-9_]{1,251}$/u.test(customerId)) {
                return {
                  kind: "response" as const,
                  response: json({ code: "stripe_customer_binding_failed" }, { status: 503 }),
                };
              }
              const binding = yield* bindBillingCustomer({
                companyId,
                expectedCustomerId: context.customerId,
                customerId,
              });
              if (binding === "not_found") {
                return {
                  kind: "response" as const,
                  response: json({ code: "not_found" }, { status: 404 }),
                };
              }
              if (binding === "conflict") {
                return {
                  kind: "response" as const,
                  response: json({ code: "billing_customer_conflict" }, { status: 409 }),
                };
              }
              const reservation = yield* reserveBillingCheckout({
                companyId,
                idempotencyKey: body.idempotencyKey,
                userId: authentication.identity.userId,
                authorizationRequestId: requestId,
                authorizationSessionId: authentication.identity.sessionId,
                authorizationOrganizationId: authentication.identity.organizationId,
                authorizationMode: authentication.identity.mode,
                authorizationMfaVerified: authentication.identity.mfaVerified,
                kind: body.kind,
                planTier: body.kind === "monthly" ? body.planTier : null,
                credits: body.kind === "additional" ? body.credits : null,
                customerId,
                priceId,
                successUrl: config.stripeCheckoutSuccessUrl,
                cancelUrl: config.stripeCheckoutCancelUrl,
                stripeOperationKey: `hartlib-checkout:${companyId}:${body.idempotencyKey}:session`,
                allowNew:
                  body.kind !== "monthly" ||
                  context.status === "inactive" ||
                  context.status === "cancelled",
              });
              if (reservation.kind === "complete") {
                yield* appendAuthorizationAudit({
                  identity: authentication.identity,
                  requestId,
                  action: `client.billing.checkout.${body.kind}`,
                  scopeKind: "client_company",
                  scopeId: companyId,
                  outcome: "succeeded",
                });
              }
              return { kind: "reserved" as const, context, customerId, reservation };
            }),
          }),
          databaseLayer,
        );
        if (!phaseA.ok) {
          yield* auditDenied(
            authentication.identity,
            requestId,
            `client.billing.checkout.${body.kind}`,
            "client_company",
            companyId,
            phaseA.error,
            databaseLayer,
          );
          const response = authResponse(phaseA.error);
          if (response !== null) return response;
          if (
            phaseA.error instanceof Error &&
            phaseA.error.message === "monthly_plan_change_required"
          ) {
            return json({ code: phaseA.error.message }, { status: 409 });
          }
          if (
            phaseA.error instanceof Error &&
            [
              "billing_checkout_idempotency_conflict",
              "billing_checkout_in_progress",
              "billing_checkout_claim_conflict",
              "billing_checkout_claim_expired",
            ].includes(phaseA.error.message)
          ) {
            return json({ code: phaseA.error.message }, { status: 409 });
          }
          return yield* Effect.fail(phaseA.error);
        }
        const phaseAValue = phaseA.value;
        if ("response" in phaseAValue) {
          return phaseAValue.response;
        }
        if (phaseAValue.reservation.kind === "complete") {
          return json({ url: phaseAValue.reservation.url }, { status: 201 });
        }
        if (phaseAValue.reservation.kind === "in_progress") {
          return json({ code: "billing_checkout_in_progress" }, { status: 409 });
        }
        const phaseAReservation = phaseAValue.reservation;

        // Phase B reacquires and holds the same authorization lease through
        // the bounded provider call, finalization, and success audit.  The
        // reservation from phase A is already committed, so a rollback after
        // a provider commit is recoverable by replaying this exact key.
        const result = yield* provided(
          withBillingAuthorizationLease({
            companyId,
            userId: authentication.identity.userId,
            authorize: requireClientCompanyAdmin(authentication.identity, companyId),
            operation: Effect.gen(function* () {
              const context = yield* loadBillingCheckoutContext({
                companyId,
                userId: authentication.identity.userId,
                authorize: Effect.void,
              });
              if (context === null) {
                return yield* Effect.fail(new AuthorizationError("not_found"));
              }
              const reservation = yield* reserveBillingCheckout({
                companyId,
                idempotencyKey: body.idempotencyKey,
                userId: authentication.identity.userId,
                authorizationRequestId: requestId,
                authorizationSessionId: authentication.identity.sessionId,
                authorizationOrganizationId: authentication.identity.organizationId,
                authorizationMode: authentication.identity.mode,
                authorizationMfaVerified: authentication.identity.mfaVerified,
                kind: body.kind,
                planTier: body.kind === "monthly" ? body.planTier : null,
                credits: body.kind === "additional" ? body.credits : null,
                customerId: phaseAValue.customerId,
                priceId,
                successUrl: config.stripeCheckoutSuccessUrl,
                cancelUrl: config.stripeCheckoutCancelUrl,
                stripeOperationKey: `hartlib-checkout:${companyId}:${body.idempotencyKey}:session`,
                allowNew: false,
                requireExisting: true,
                claimExisting: true,
                claimLeaseToken: phaseAReservation.leaseToken,
              });
              if (reservation.kind === "complete") {
                yield* appendAuthorizationAudit({
                  identity: authentication.identity,
                  requestId,
                  action: `client.billing.checkout.${body.kind}`,
                  scopeKind: "client_company",
                  scopeId: companyId,
                  outcome: "succeeded",
                });
                return json({ url: reservation.url }, { status: 201 });
              }
              if (reservation.kind === "in_progress") {
                return json({ code: "billing_checkout_in_progress" }, { status: 409 });
              }
              const checkoutResult = yield* Effect.tryPromise({
                try: (signal) =>
                  gateway!.checkout({
                    signal,
                    customerId: phaseAValue.customerId,
                    customerEmail: context.email,
                    companyId,
                    kind: body.kind,
                    planTier: body.kind === "monthly" ? body.planTier : null,
                    credits: body.kind === "additional" ? body.credits : null,
                    priceId,
                    successUrl: reservation.successUrl,
                    cancelUrl: reservation.cancelUrl,
                    metadata: {
                      [`${reservation.metadataPrefix}_client_company_id`]: companyId,
                      [`${reservation.metadataPrefix}_purchase_kind`]:
                        body.kind === "additional" ? "additional_credits" : "monthly_plan",
                      ...(body.kind === "monthly"
                        ? { [`${reservation.metadataPrefix}_plan_tier`]: body.planTier }
                        : {}),
                      ...(body.kind === "additional"
                        ? { [`${reservation.metadataPrefix}_credits`]: String(body.credits) }
                        : {}),
                    },
                    automaticTaxEnabled: true,
                    billingAddressCollection: "required",
                    taxIdCollectionEnabled: true,
                    updateExistingCustomerAddress: true,
                    idempotencyKey: reservation.stripeOperationKey,
                  }),
                catch: (error) => error,
              }).pipe(
                Effect.timeout(`${BILLING_CAPABILITY_PROVIDER_TIMEOUT_MS} millis`),
                Effect.match({ onFailure: () => null, onSuccess: (value) => value }),
              );
              if (checkoutResult === null || !validCheckoutResult(checkoutResult)) {
                yield* releaseBillingCheckoutLease({
                  companyId,
                  idempotencyKey: body.idempotencyKey,
                  leaseToken: reservation.leaseToken,
                });
                return json({ code: "stripe_request_failed" }, { status: 503 });
              }
              const finalized = yield* finalizeBillingCheckout({
                companyId,
                idempotencyKey: body.idempotencyKey,
                sessionId: checkoutResult.sessionId,
                url: checkoutResult.url,
                leaseToken: reservation.leaseToken,
              });
              yield* appendAuthorizationAudit({
                identity: authentication.identity,
                requestId,
                action: `client.billing.checkout.${body.kind}`,
                scopeKind: "client_company",
                scopeId: companyId,
                outcome: "succeeded",
              });
              return json({ url: finalized.url }, { status: 201 });
            }),
          }),
          databaseLayer,
        );
        if (!result.ok) {
          yield* auditDenied(
            authentication.identity,
            requestId,
            `client.billing.checkout.${body.kind}`,
            "client_company",
            companyId,
            result.error,
            databaseLayer,
          );
          const response = authResponse(result.error);
          if (response !== null) return response;
          if (
            result.error instanceof Error &&
            ["billing_checkout_idempotency_conflict", "billing_checkout_in_progress"].includes(
              result.error.message,
            )
          ) {
            return json({ code: result.error.message }, { status: 409 });
          }
          return yield* Effect.fail(result.error);
        }
        return result.value;
      }),
  });

  routes.push({
    method: "POST",
    path: "/v1/client-companies/:companyId/billing/plan-change",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const companyId = pathParameters.companyId!;
        const authentication = yield* authenticate(request);
        if (!authentication.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const body = input.body as Schema.Schema.Type<typeof ChangeMonthlyPlanRequest>;
        const config = yield* loadApiConfig;
        const targetPriceId = priceForTier(config, body.planTier);
        const gateway =
          injectedGateway ??
          (config.stripeSecretKey === "" ? null : liveGateway(config.stripeSecretKey));
        const succeededAudit = (outcome: MonthlyPlanChangeDescriptor["status"]) =>
          appendAuthorizationAudit({
            identity: authentication.identity,
            requestId,
            action: planChangeAction(outcome),
            scopeKind: "client_company",
            scopeId: companyId,
            outcome: "succeeded",
          });
        const reservation = yield* provided(
          reserveMonthlyPlanChange({
            companyId,
            userId: authentication.identity.userId,
            sessionId: authentication.identity.sessionId,
            authorizationRequestId: requestId,
            targetTier: body.planTier,
            idempotencyKey: body.idempotencyKey,
            prices: planPrices(config),
            gatewayAvailable: gateway !== null,
            authorize: requireClientCompanyAdmin(authentication.identity, companyId),
            accountMissingError: new AuthorizationError("not_found"),
            auditSucceeded: succeededAudit,
          }),
          databaseLayer,
        );
        if (!reservation.ok) {
          yield* auditDenied(
            authentication.identity,
            requestId,
            planChangeAction(),
            "client_company",
            companyId,
            reservation.error,
            databaseLayer,
          );
          const auth = authResponse(reservation.error);
          if (auth !== null) return auth;
          const code = reservation.error instanceof Error ? reservation.error.message : "";
          if (
            [
              "plan_change_idempotency_conflict",
              "plan_change_in_progress",
              "plan_change_conflict",
            ].includes(code)
          ) {
            return json({ code }, { status: 409 });
          }
          if (code === "billing_unavailable") return json({ code }, { status: 503 });
          if (["billing_subscription_missing", "billing_subscription_ambiguous"].includes(code)) {
            return json({ code }, { status: 409 });
          }
          return yield* Effect.fail(reservation.error);
        }
        if (reservation.value.kind === "complete") {
          return json({ change: reservation.value.change });
        }
        const executable = reservation.value;
        const markFailed = () =>
          provided(
            failMonthlyPlanChange({
              companyId,
              idempotencyKey: body.idempotencyKey,
              errorCode: "stripe_request_failed",
            }),
            databaseLayer,
          );
        const gatewayResult = yield* Effect.tryPromise({
          try: () => gateway!.changeMonthlyPlan(executable.gatewayInput),
          catch: (error) => error,
        }).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (value) => ({ ok: true as const, value }),
          }),
        );
        if (!gatewayResult.ok) {
          yield* markFailed();
          yield* auditDenied(
            authentication.identity,
            requestId,
            planChangeAction(),
            "client_company",
            companyId,
            gatewayResult.error,
            databaseLayer,
          );
          return json({ code: "stripe_request_failed" }, { status: 503 });
        }
        const direction = compareAiPlanTiers(
          executable.previousTier,
          executable.gatewayInput.targetTier,
        );
        const effectiveAt = new Date(gatewayResult.value.effectiveAt);
        const gatewayShapeValid =
          Number.isFinite(effectiveAt.getTime()) &&
          effectiveAt.toISOString() === gatewayResult.value.effectiveAt &&
          /^[A-Za-z0-9_:-]{1,255}$/u.test(gatewayResult.value.externalOperationId) &&
          (gatewayResult.value.kind !== "downgrade_scheduled" ||
            gatewayResult.value.effectiveAt === executable.gatewayInput.currentPeriodEnd);
        if (
          !gatewayShapeValid ||
          (direction < 0 && gatewayResult.value.kind !== "upgraded") ||
          (direction > 0 && gatewayResult.value.kind !== "downgrade_scheduled")
        ) {
          yield* markFailed();
          yield* auditDenied(
            authentication.identity,
            requestId,
            planChangeAction(),
            "client_company",
            companyId,
            new Error("stripe_response_invalid"),
            databaseLayer,
          );
          return json({ code: "stripe_request_failed" }, { status: 503 });
        }
        const finalized = yield* provided(
          finalizeMonthlyPlanChange({
            companyId,
            targetTier: body.planTier,
            targetPriceId,
            idempotencyKey: body.idempotencyKey,
            executable,
            gatewayResult: gatewayResult.value,
            auditSucceeded: succeededAudit,
          }),
          databaseLayer,
        );
        if (!finalized.ok) {
          yield* auditDenied(
            authentication.identity,
            requestId,
            planChangeAction(),
            "client_company",
            companyId,
            finalized.error,
            databaseLayer,
          );
          return json({ code: "billing_state_changed" }, { status: 409 });
        }
        return json({ change: finalized.value });
      }),
  });

  routes.push({
    method: "POST",
    path: "/v1/client-companies/:companyId/billing/portal",
    execute: (request, _url, pathParameters) =>
      Effect.gen(function* () {
        const companyId = pathParameters.companyId!;
        const authentication = yield* authenticate(request);
        if (!authentication.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const config = yield* loadApiConfig;
        const gateway =
          injectedGateway ??
          (config.stripeSecretKey === "" ? null : liveGateway(config.stripeSecretKey));
        const result = yield* provided(
          withBillingAuthorizationLease({
            companyId,
            userId: authentication.identity.userId,
            authorize: requireClientCompanyAdmin(authentication.identity, companyId),
            operation: Effect.gen(function* () {
              const customerId = yield* loadBillingPortalCustomer({
                companyId,
                authorize: Effect.void,
              });
              if (customerId === null) {
                return json({ code: "billing_customer_missing" }, { status: 409 });
              }
              if (gateway === null || config.stripePortalReturnUrl === "") {
                return json({ code: "billing_unavailable" }, { status: 503 });
              }
              const portalUrl = yield* Effect.tryPromise({
                try: (signal) =>
                  gateway.portal({
                    signal,
                    customerId,
                    returnUrl: config.stripePortalReturnUrl,
                  }),
                catch: (error) => error,
              }).pipe(
                Effect.timeout(`${BILLING_CAPABILITY_PROVIDER_TIMEOUT_MS} millis`),
                Effect.match({ onFailure: () => null, onSuccess: (value) => value }),
              );
              if (portalUrl === null) {
                return json({ code: "stripe_request_failed" }, { status: 503 });
              }
              yield* appendAuthorizationAudit({
                identity: authentication.identity,
                requestId,
                action: "client.billing.portal.create",
                scopeKind: "client_company",
                scopeId: companyId,
                outcome: "succeeded",
              });
              return json({ url: portalUrl }, { status: 201 });
            }),
          }),
          databaseLayer,
        );
        if (!result.ok) {
          yield* auditDenied(
            authentication.identity,
            requestId,
            "client.billing.portal.create",
            "client_company",
            companyId,
            result.error,
            databaseLayer,
          );
          return authResponse(result.error) ?? (yield* Effect.fail(result.error));
        }
        return result.value;
      }),
  });

  routes.push({
    method: "GET",
    path: "/v1/client-companies/:companyId/ai-usage",
    execute: (request, _url, pathParameters) =>
      Effect.gen(function* () {
        const companyId = pathParameters.companyId!;
        const authentication = yield* authenticate(request);
        if (!authentication.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const result = yield* provided(
          loadAiUsageOverview({
            companyId,
            userId: authentication.identity.userId,
            authorize: requireClientCompanyMembership(authentication.identity, companyId),
          }),
          databaseLayer,
        );
        if (!result.ok) return authResponse(result.error) ?? (yield* Effect.fail(result.error));
        return json({ usage: result.value });
      }),
  });

  const limitRoute = (employee: boolean): Route => ({
    method: "PUT",
    path: employee
      ? "/v1/client-companies/:companyId/members/:userId/ai-limit"
      : "/v1/client-companies/:companyId/ai-limit",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const companyId = pathParameters.companyId!;
        const authentication = yield* authenticate(request);
        if (!authentication.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const userId = employee ? pathParameters.userId! : null;
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const body = input.body as
          | Schema.Schema.Type<typeof UpdateEmployeeAiLimitRequest>
          | Schema.Schema.Type<typeof UpdateCompanyAiLimitRequest>;
        const limit = employee
          ? (body as Schema.Schema.Type<typeof UpdateEmployeeAiLimitRequest>).monthlyLimit
          : (body as Schema.Schema.Type<typeof UpdateCompanyAiLimitRequest>).companyMonthlyLimit;
        const action = employee
          ? "client.ai_limit.employee.update"
          : "client.ai_limit.company.update";
        const scopeKind = employee ? "platform_user" : "client_company";
        const scopeId = userId ?? companyId;
        const result = yield* provided(
          updateAiLimit({
            companyId,
            actorUserId: authentication.identity.userId,
            employeeUserId: userId,
            limit,
            authorize: requireClientCompanyAdmin(authentication.identity, companyId),
            audit: appendAuthorizationAudit({
              identity: authentication.identity,
              requestId,
              action,
              scopeKind,
              scopeId,
              outcome: "succeeded",
            }),
          }).pipe(
            Effect.flatMap((updated) =>
              updated ? Effect.void : Effect.fail(new AuthorizationError("not_found")),
            ),
          ),
          databaseLayer,
        );
        if (!result.ok) {
          yield* auditDenied(
            authentication.identity,
            requestId,
            action,
            scopeKind,
            scopeId,
            result.error,
            databaseLayer,
          );
          return authResponse(result.error) ?? (yield* Effect.fail(result.error));
        }
        return json({ status: "updated" });
      }),
  });
  routes.push(limitRoute(false), limitRoute(true));

  routes.push({
    method: "POST",
    path: "/v1/client-companies/:companyId/ai-usage-requests",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const companyId = pathParameters.companyId!;
        const authentication = yield* authenticate(request);
        if (!authentication.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const body = input.body as Schema.Schema.Type<typeof CreateAiUsageRequest>;
        const result = yield* provided(
          createAiUsageRequestRecord({
            companyId,
            userId: authentication.identity.userId,
            requestedCredits: body.requestedCredits,
            reason: body.reason,
            authorize: requireClientCompanyMembership(authentication.identity, companyId),
            audit: (usageRequestId) =>
              appendAuthorizationAudit({
                identity: authentication.identity,
                requestId,
                action: "client.ai_usage_request.create",
                scopeKind: "ai_usage_request",
                scopeId: usageRequestId,
                outcome: "succeeded",
              }),
          }),
          databaseLayer,
        );
        if (!result.ok) {
          yield* auditDenied(
            authentication.identity,
            requestId,
            "client.ai_usage_request.create",
            "client_company",
            companyId,
            result.error,
            databaseLayer,
          );
          return authResponse(result.error) ?? (yield* Effect.fail(result.error));
        }
        return json({ request: aiUsageRequestDescriptor(result.value) }, { status: 201 });
      }),
  });

  routes.push({
    method: "POST",
    path: "/v1/client-companies/:companyId/ai-usage-requests/:requestId/resolve",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const companyId = pathParameters.companyId!;
        const usageRequestId = pathParameters.requestId!;
        const authentication = yield* authenticate(request);
        if (!authentication.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const body = input.body as Schema.Schema.Type<typeof ResolveAiUsageRequest>;
        const result = yield* provided(
          resolveAiUsageRequestRecord({
            companyId,
            usageRequestId,
            actorUserId: authentication.identity.userId,
            decision: body.decision,
            authorize: requireClientCompanyAdmin(authentication.identity, companyId),
            audit: appendAuthorizationAudit({
              identity: authentication.identity,
              requestId,
              action: `client.ai_usage_request.${body.decision}`,
              scopeKind: "ai_usage_request",
              scopeId: usageRequestId,
              outcome: "succeeded",
            }),
          }).pipe(
            Effect.flatMap((resolved) =>
              resolved ? Effect.void : Effect.fail(new AuthorizationError("not_found")),
            ),
          ),
          databaseLayer,
        );
        if (!result.ok) {
          yield* auditDenied(
            authentication.identity,
            requestId,
            `client.ai_usage_request.${body.decision}`,
            "ai_usage_request",
            usageRequestId,
            result.error,
            databaseLayer,
          );
          return authResponse(result.error) ?? (yield* Effect.fail(result.error));
        }
        return json({ status: body.decision });
      }),
  });

  return withAdministrativeAuditing(routes, databaseLayer);
};

export const billingRoutes = makeBillingRoutes();
