import { acceptClerkWebhook } from "@brief/backend-domain/clerk-webhook";
import { verifyWebhook, type WebhookEvent } from "@clerk/backend/webhooks";
import { Effect } from "effect";

import { loadApiConfig } from "../config";
import { ApiDatabaseLayer, type ApiDatabaseLayer as ApiDatabaseLayerType } from "../database";
import { json, type Route } from "../http";

export type ClerkWebhookVerifier = (
  request: Request,
  signingSecret: string,
) => Promise<WebhookEvent>;

const liveVerifier: ClerkWebhookVerifier = (request, signingSecret) =>
  verifyWebhook(request, { signingSecret });

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const makeClerkWebhookRoute = (
  databaseLayer: ApiDatabaseLayerType = ApiDatabaseLayer,
  verifier: ClerkWebhookVerifier = liveVerifier,
): Route => ({
  method: "POST",
  path: "/v1/identity/clerk/webhook",
  execute: (request, _url, _pathParameters, input) =>
    Effect.gen(function* () {
      const eventId = (input.headers["svix-id"] ?? input.headers["webhook-id"]) as string;
      const timestampText = (input.headers["svix-timestamp"] ??
        input.headers["webhook-timestamp"]) as string;
      if (!/^[0-9]{1,16}$/u.test(timestampText)) {
        return json({ code: "webhook_timestamp_invalid" }, { status: 400 });
      }
      const eventTimestamp = Number(timestampText);
      if (!Number.isSafeInteger(eventTimestamp) || eventTimestamp < 0) {
        return json({ code: "webhook_timestamp_invalid" }, { status: 400 });
      }
      const config = yield* loadApiConfig;
      if (config.clerkWebhookSigningSecret === "") {
        return json({ code: "webhook_unavailable" }, { status: 503 });
      }
      const bytes = input.bodyBytes!;
      const verificationRequest = new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: Uint8Array.from(bytes).buffer,
      });
      const event = yield* Effect.tryPromise({
        try: () => verifier(verificationRequest, config.clerkWebhookSigningSecret),
        catch: (error) => error,
      }).pipe(Effect.match({ onFailure: () => null, onSuccess: (value) => value }));
      if (event === null) return json({ code: "signature_invalid" }, { status: 400 });
      const result = yield* acceptClerkWebhook({
        eventId,
        eventTimestamp,
        payloadHash: yield* Effect.promise(() => sha256Hex(bytes)),
        event,
      }).pipe(Effect.provide(databaseLayer));
      if (result === "conflict") {
        return json({ code: "webhook_replay_conflict" }, { status: 409 });
      }
      return json({ status: result });
    }),
});

export const clerkWebhookRoute = makeClerkWebhookRoute();
