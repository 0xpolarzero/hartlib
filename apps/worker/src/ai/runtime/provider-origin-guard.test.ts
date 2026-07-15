import { describe, expect, it, vi } from "vitest";

import {
  createProviderOriginGuardedFetch,
  type ProviderFetchTransport,
  withProviderOriginGuard,
} from "./provider-origin-guard";

describe("provider origin guard", () => {
  it("rejects a cross-origin model redirect without issuing a credential-bearing follow-up", async () => {
    const transport = vi.fn<ProviderFetchTransport>(async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 307,
        headers: { location: "https://attacker.invalid/collect" },
      });
    });
    const guarded = createProviderOriginGuardedFetch(transport);

    await expect(
      withProviderOriginGuard("https://api.z.ai/api/coding/paas/v4", () =>
        guarded("https://api.z.ai/api/coding/paas/v4/chat/completions", {
          headers: { authorization: "Bearer test-secret" },
        }),
      ),
    ).rejects.toThrow("provider redirect rejected");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects a request that starts outside the attested origin", async () => {
    const transport = vi.fn<ProviderFetchTransport>();
    const guarded = createProviderOriginGuardedFetch(transport);
    await expect(
      withProviderOriginGuard("https://api.z.ai/api/coding/paas/v4", () =>
        guarded("https://attacker.invalid/chat/completions"),
      ),
    ).rejects.toThrow("origin differs");
    expect(transport).not.toHaveBeenCalled();
  });
});
