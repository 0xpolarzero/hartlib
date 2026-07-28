import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { resolveRequestIdentity } from "./auth";
import type { ApiConfig } from "./config";
import { demoSessionRoutes } from "./domain/demo-session";
import {
  DEMO_COOKIE_NAME,
  createDemoSession,
  readCookie,
  signDemoSessionCookie,
  verifyDemoSessionCookie,
} from "./demo-session";
import { routeRequest } from "./http";

const SECRET = "test-session-secret";
const PASSWORD = "demo-password";

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
  demoPassword: PASSWORD,
  demoSessionSecret: SECRET,
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
  corsAllowedOrigins: ["https://brief.test"],
  objectStorageConfigured: false,
  exportObjectStorageConfigured: false,
  sentryDsn: "",
  ...overrides,
});

describe("demo session cookie", () => {
  it("round-trips a visitor id through sign and verify", () => {
    const visitorId = "11111111-1111-4111-8111-111111111111";
    const cookie = signDemoSessionCookie(visitorId, SECRET, PASSWORD);
    expect(verifyDemoSessionCookie(cookie, SECRET, PASSWORD)).toBe(visitorId);
  });

  it("rejects a cookie signed for a different password", () => {
    const visitorId = "22222222-2222-4222-8222-222222222222";
    const cookie = signDemoSessionCookie(visitorId, SECRET, "old-password");
    expect(verifyDemoSessionCookie(cookie, SECRET, PASSWORD)).toBeNull();
  });

  it("rejects a cookie signed for a different secret", () => {
    const visitorId = "33333333-3333-4333-8333-333333333333";
    const cookie = signDemoSessionCookie(visitorId, "other-secret", PASSWORD);
    expect(verifyDemoSessionCookie(cookie, SECRET, PASSWORD)).toBeNull();
  });

  it("rejects malformed and empty cookie values", () => {
    expect(verifyDemoSessionCookie(null, SECRET, PASSWORD)).toBeNull();
    expect(verifyDemoSessionCookie("", SECRET, PASSWORD)).toBeNull();
    expect(verifyDemoSessionCookie("garbage", SECRET, PASSWORD)).toBeNull();
    expect(
      verifyDemoSessionCookie(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.forged",
        SECRET,
        PASSWORD,
      ),
    ).toBeNull();
  });

  it("mints a session whose cookie verifies", () => {
    const session = createDemoSession(SECRET, PASSWORD);
    expect(session.visitorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(verifyDemoSessionCookie(session.cookieValue, SECRET, PASSWORD)).toBe(
      session.visitorId,
    );
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
          ConfigProvider.fromEnv({
            env: {
              NODE_ENV: "test",
              AUTH_MODE: "demo",
              DEMO_PASSWORD: PASSWORD,
              DEMO_SESSION_SECRET: SECRET,
            },
          }),
        ),
      ),
    ),
  );

describe("POST /v1/demo/session", () => {
  it("mints a verifiable session cookie for the correct password", async () => {
    const response = await call(
      new Request("https://brief.test/v1/demo/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    const cookieValue = readCookie(setCookie?.split(";")[0] ?? "", DEMO_COOKIE_NAME);
    const visitorId = verifyDemoSessionCookie(cookieValue, SECRET, PASSWORD);
    expect(visitorId).not.toBeNull();

    // The minted cookie authenticates the request identity end to end.
    const identity = await Effect.runPromise(
      resolveRequestIdentity(
        new Request("https://brief.test/v1/chat", {
          headers: { cookie: `${DEMO_COOKIE_NAME}=${cookieValue}` },
        }),
        config(),
      ),
    );
    expect(identity).toEqual({
      authenticated: true,
      identity: expect.objectContaining({ userId: visitorId, mode: "demo" }),
    });
  });

  it("rejects a wrong password with 401 and no cookie", async () => {
    const response = await call(
      new Request("https://brief.test/v1/demo/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      }),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
