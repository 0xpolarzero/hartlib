import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { resolveRequestIdentity } from "./auth";
import type { ApiConfig } from "./config";
import { demoSessionRoutes } from "./domain/demo-session";
import {
  DEMO_COOKIE_NAME,
  createDemoSession,
  readCookie,
  verifyDemoSessionCookie,
} from "./demo-session";
import { routeRequest } from "./http";

const config = (overrides: Partial<ApiConfig> = {}): ApiConfig => ({
  host: "127.0.0.1",
  port: 3000,
  nodeEnv: "test",
  aiStreamPollMs: 300,
  aiStreamKeepAliveMs: 15_000,
  webResearchProvider: null,
  aiWebMaxDomainFilters: 8,
  aiProviderServiceId: "zai_coding_plan_official",
  aiProviderEndpointIdentity: "zai_coding_plan_official:https://api.z.ai/api/coding/paas/v4",
  authMode: "demo",
  clerkSecretKey: "",
  clerkPublishableKey: "",
  clerkAuthorizedParties: [],
  clerkWebhookSigningSecret: "",
  clerkInvitationRedirectUrl: "",
  stripeSecretKey: "",
  stripeWebhookSecret: "",
  stripePriceLight: "",
  stripePriceTeam: "",
  stripePriceIntensive: "",
  stripePriceAdditionalCredit: "",
  stripeCheckoutSuccessUrl: "",
  stripeCheckoutCancelUrl: "",
  stripePortalReturnUrl: "",
  corsAllowedOrigins: ["https://hartlib.test"],
  objectStorageConfigured: false,
  exportObjectStorageConfigured: false,
  sentryDsn: "",
  ...overrides,
});

describe("demo session cookie", () => {
  it("accepts a cookie-safe slug and returns it as the visitor id", () => {
    expect(verifyDemoSessionCookie("demo-user")).toBe("demo-user");
    expect(verifyDemoSessionCookie("11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("rejects absent, empty, and non-cookie-safe values", () => {
    expect(verifyDemoSessionCookie(null)).toBeNull();
    expect(verifyDemoSessionCookie("")).toBeNull();
    expect(verifyDemoSessionCookie("has space")).toBeNull();
    expect(verifyDemoSessionCookie("has.dot")).toBeNull();
    expect(verifyDemoSessionCookie("has;semicolon")).toBeNull();
  });

  it("mints a uuid visitor id whose cookie value is the id itself", () => {
    const session = createDemoSession();
    expect(session.visitorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(session.cookieValue).toBe(session.visitorId);
  });

  it("reads a named cookie from a header", () => {
    const header = `_other=abc; ${DEMO_COOKIE_NAME}=value-here; third=def`;
    expect(readCookie(header, DEMO_COOKIE_NAME)).toBe("value-here");
    expect(readCookie(header, "absent")).toBeNull();
    expect(readCookie(null, DEMO_COOKIE_NAME)).toBeNull();
  });
});

const call = (request: Request) =>
  Effect.runPromise(
    routeRequest(demoSessionRoutes, request).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { NODE_ENV: "test", AUTH_MODE: "demo" } }),
        ),
      ),
    ),
  );

describe("POST /v1/demo/session", () => {
  it("mints a visitor cookie for a new browser and authenticates end to end", async () => {
    const response = await call(
      new Request("https://hartlib.test/v1/demo/session", { method: "POST" }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    const cookieValue = readCookie(setCookie?.split(";")[0] ?? "", DEMO_COOKIE_NAME);
    expect(verifyDemoSessionCookie(cookieValue)).toBe(cookieValue);

    // The minted cookie authenticates the request identity end to end.
    const identity = await Effect.runPromise(
      resolveRequestIdentity(
        new Request("https://hartlib.test/v1/chat", {
          headers: { cookie: `${DEMO_COOKIE_NAME}=${cookieValue}` },
        }),
        config(),
      ),
    );
    expect(identity).toEqual({
      authenticated: true,
      identity: expect.objectContaining({ userId: cookieValue, mode: "demo" }),
    });
  });

  it("keeps an existing valid cookie for a returning visitor", async () => {
    const visitorId = "returning-visitor";
    const response = await call(
      new Request("https://hartlib.test/v1/demo/session", {
        method: "POST",
        headers: { cookie: `${DEMO_COOKIE_NAME}=${visitorId}` },
      }),
    );
    expect(response.status).toBe(200);
    // A returning visitor keeps its cookie, so no new one is set.
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("answers 404 outside demo mode", async () => {
    const response = await Effect.runPromise(
      routeRequest(
        demoSessionRoutes,
        new Request("https://hartlib.test/v1/demo/session", { method: "POST" }),
      ).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                NODE_ENV: "test",
                AUTH_MODE: "clerk",
                CLERK_SECRET_KEY: "secret",
                CLERK_PUBLISHABLE_KEY: "publishable",
              },
            }),
          ),
        ),
      ),
    );
    expect(response.status).toBe(404);
  });
});
