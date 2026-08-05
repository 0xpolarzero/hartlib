import {
  acceptStripeWebhook,
  type VerifiedStripeEvent,
} from "@hartlib/backend-domain/stripe-webhook";
import { Effect } from "effect";
import Stripe from "stripe";

import { loadApiConfig } from "../config";
import { ApiDatabaseLayer, type ApiDatabaseLayer as ApiDatabaseLayerType } from "../database";
import { json, type Route } from "../http";

export type { VerifiedStripeEvent } from "@hartlib/backend-domain/stripe-webhook";

export type StripeWebhookVerifier = (input: {
  readonly rawBody: string;
  readonly signature: string;
  readonly secretKey: string;
  readonly webhookSecret: string;
}) => Promise<VerifiedStripeEvent>;

const verifyStripeWebhook: StripeWebhookVerifier = async (input) => {
  const stripe = new Stripe(input.secretKey);
  const event = await stripe.webhooks.constructEventAsync(
    input.rawBody,
    input.signature,
    input.webhookSecret,
  );
  return {
    id: event.id,
    type: event.type,
    payload: event as unknown as Record<string, unknown>,
  };
};

export const makeStripeWebhookRoute = (
  databaseLayer: ApiDatabaseLayerType = ApiDatabaseLayer,
  verifier: StripeWebhookVerifier = verifyStripeWebhook,
): Route => ({
  method: "POST",
  path: "/v1/billing/stripe/webhook",
  execute: (_request, _url, _pathParameters, input) =>
    Effect.gen(function* () {
      const signature = input.headers["stripe-signature"] as string;
      const config = yield* loadApiConfig;
      if (config.stripeSecretKey === "" || config.stripeWebhookSecret === "") {
        return json({ code: "stripe_webhook_unavailable" }, { status: 503 });
      }
      const rawBody = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(input.bodyBytes!),
        catch: (error) => error,
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      );
      if (!rawBody.ok) return json({ code: "stripe_webhook_body_invalid" }, { status: 400 });
      const verified = yield* Effect.tryPromise({
        try: () =>
          verifier({
            rawBody: rawBody.value,
            signature,
            secretKey: config.stripeSecretKey,
            webhookSecret: config.stripeWebhookSecret,
          }),
        catch: (error) => error,
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      );
      if (!verified.ok) return json({ code: "stripe_signature_invalid" }, { status: 400 });
      const event = verified.value;
      if (event.id.length === 0 || event.type.length === 0) {
        return json({ code: "stripe_event_invalid" }, { status: 400 });
      }
      const accepted = yield* acceptStripeWebhook(event, rawBody.value).pipe(
        Effect.provide(databaseLayer),
      );
      if (accepted === "conflict") {
        return json({ code: "stripe_event_id_conflict" }, { status: 409 });
      }
      return json({ received: true, duplicate: !accepted });
    }),
});

export const stripeWebhookRoute = makeStripeWebhookRoute();
