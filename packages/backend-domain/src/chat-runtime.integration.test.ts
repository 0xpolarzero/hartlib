import { describe, expect, it } from "vitest";

import { effectiveWebPolicy } from "./chat-runtime";

describe("singular chat runtime policy", () => {
  it("keeps web disabled when the deployment is unavailable", () => {
    expect(
      effectiveWebPolicy({
        companyEnabled: true,
        allowedDomains: null,
        adapterAvailable: false,
        provider: null,
        allowlistSupported: false,
        maxDomainFilters: 8,
      }),
    ).toEqual({ enabled: false, reason: "deployment_unavailable", allowlistActive: false });
  });

  it("returns the configured web transport and allowlist", () => {
    expect(
      effectiveWebPolicy({
        companyEnabled: true,
        allowedDomains: ["example.com"],
        adapterAvailable: true,
        provider: "tinyfish",
        allowlistSupported: true,
        maxDomainFilters: 8,
      }),
    ).toEqual({ enabled: true, provider: "tinyfish", allowedDomains: ["example.com"] });
  });
});
