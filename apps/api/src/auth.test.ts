import { describe, expect, it, vi } from "vitest";

const { hasActiveDemoSession } = vi.hoisted(() => ({ hasActiveDemoSession: vi.fn() }));
vi.mock("@hartlib/backend-domain/demo-sessions", () => ({ hasActiveDemoSession }));

import { Effect } from "effect";
import { resolveRequestIdentity } from "./auth";
import { DEMO_COOKIE_NAME } from "./demo-session";
import type { ApiConfig } from "./config";

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
  corsAllowedOrigins: [],
  objectStorageConfigured: false,
  sentryDsn: "",
  ...overrides,
});

const run = (cookie?: string) =>
  Effect.runPromise(
    resolveRequestIdentity(
      new Request("https://hartlib.test/v1/chat", cookie ? { headers: { cookie } } : {}),
      config(),
    ),
  );

describe("request authentication", () => {
  it("rejects a missing or malformed demo cookie", async () => {
    await expect(run()).resolves.toEqual({ authenticated: false });
    await expect(run(`${DEMO_COOKIE_NAME}=not-a-uuid`)).resolves.toEqual({ authenticated: false });
  });

  it("requires an active database session for a valid cookie", async () => {
    const visitorId = "11111111-1111-4111-8111-111111111111";
    hasActiveDemoSession.mockReturnValueOnce(Effect.succeed(false));
    await expect(run(`${DEMO_COOKIE_NAME}=${visitorId}`)).resolves.toEqual({
      authenticated: false,
    });
    hasActiveDemoSession.mockReturnValueOnce(Effect.succeed(true));
    await expect(run(`${DEMO_COOKIE_NAME}=${visitorId}`)).resolves.toEqual({
      authenticated: true,
      identity: {
        userId: visitorId,
        sessionId: visitorId,
      },
    });
  });
});
