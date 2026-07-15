import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { resolveRequestIdentity, type RequestAuthenticator } from "./auth";
import type { ApiConfig } from "./config";

const config = (overrides: Partial<ApiConfig> = {}): ApiConfig => ({
  host: "127.0.0.1",
  port: 3000,
  nodeEnv: "test",
  aiStreamPollMs: 300,
  aiStreamKeepAliveMs: 15_000,
  webResearchProvider: null,
  aiWebMaxDomainFilters: 8,
  authMode: "clerk",
  demoUserId: "demo-user",
  clerkSecretKey: "secret",
  clerkPublishableKey: "publishable",
  clerkAuthorizedParties: ["https://brief.test"],
  clerkWebhookSigningSecret: "whsec_test",
  clerkInvitationRedirectUrl: "https://brief.test/invitations/accept",
  stripeSecretKey: "",
  stripeWebhookSecret: "",
  stripePriceLight: "",
  stripePriceTeam: "",
  stripePriceIntensive: "",
  stripePriceAdditionalCredit: "",
  stripeCheckoutSuccessUrl: "",
  stripeCheckoutCancelUrl: "",
  stripePortalReturnUrl: "",
  corsAllowedOrigins: ["https://brief.test"],
  objectStorageConfigured: false,
  exportObjectStorageConfigured: false,
  sentryDsn: "",
  ...overrides,
});

const run = (apiConfig: ApiConfig, authenticator?: RequestAuthenticator) =>
  Effect.runPromise(
    resolveRequestIdentity(
      new Request("https://brief.test/v1/chat"),
      apiConfig,
      authenticator === undefined ? undefined : { authenticator },
    ),
  );

describe("request authentication", () => {
  it("isolates the explicit non-production demo identity", async () => {
    await expect(run(config({ authMode: "demo", demoUserId: "fixture-user" }))).resolves.toEqual({
      authenticated: true,
      identity: {
        userId: "fixture-user",
        organizationId: null,
        sessionId: "demo-session",
        mfaVerified: true,
        mode: "demo",
      },
    });
  });

  it("accepts only authenticated Clerk user sessions and forwards authorized parties", async () => {
    const authenticateRequest = vi.fn(async () => ({
      isAuthenticated: true,
      toAuth: () => ({
        userId: "user_1",
        orgId: "org_1",
        sessionId: "session_1",
        factorVerificationAge: [1, 2],
      }),
    }));
    await expect(run(config(), { authenticateRequest } as RequestAuthenticator)).resolves.toEqual({
      authenticated: true,
      identity: {
        userId: "user_1",
        organizationId: "org_1",
        sessionId: "session_1",
        mfaVerified: true,
        mode: "clerk",
      },
    });
    expect(authenticateRequest).toHaveBeenCalledWith(expect.any(Request), {
      authorizedParties: ["https://brief.test"],
    });
  });

  it("does not treat first-factor-only sessions as MFA verified", async () => {
    const authenticator: RequestAuthenticator = {
      authenticateRequest: async () => ({
        isAuthenticated: true,
        toAuth: () => ({
          userId: "user_1",
          orgId: null,
          sessionId: "session_1",
          factorVerificationAge: [1, -1],
        }),
      }),
    };
    await expect(run(config(), authenticator)).resolves.toMatchObject({
      authenticated: true,
      identity: { mfaVerified: false },
    });
  });

  it("rejects signed-out and malformed authenticated states", async () => {
    const signedOut: RequestAuthenticator = {
      authenticateRequest: async () => ({ isAuthenticated: false, toAuth: () => null }),
    };
    await expect(run(config(), signedOut)).resolves.toEqual({ authenticated: false });

    const missingUser: RequestAuthenticator = {
      authenticateRequest: async () => ({
        isAuthenticated: true,
        toAuth: () => ({
          userId: null,
          orgId: null,
          sessionId: "session_1",
          factorVerificationAge: null,
        }),
      }),
    };
    await expect(run(config(), missingUser)).resolves.toEqual({ authenticated: false });
  });

  it("sanitizes authentication infrastructure failures", async () => {
    const failing: RequestAuthenticator = {
      authenticateRequest: async () => {
        throw new Error("secret provider detail");
      },
    };
    await expect(run(config(), failing)).rejects.toThrow("request authentication failed");
  });
});
