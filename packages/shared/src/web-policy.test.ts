import { describe, expect, it } from "vitest";

import {
  deriveEffectiveWebPolicy,
  normalizeDomainAllowlist,
  type EffectiveWebPolicyOptions,
} from "./web-policy";

const matrix = [
  { name: "null", allowedDomains: null, allowlistActive: false },
  { name: "empty", allowedDomains: [], allowlistActive: true },
  {
    name: "valid",
    allowedDomains: [" Example.COM. ", "État.fr", "example.com"],
    allowlistActive: true,
  },
  { name: "invalid", allowedDomains: ["https://example.com"], allowlistActive: true },
  {
    name: "too-many",
    allowedDomains: ["a.example.com", "b.example.com"],
    allowlistActive: true,
  },
] as const;

const options = (
  allowedDomains: readonly string[] | null,
  overrides: Partial<EffectiveWebPolicyOptions> = {},
): EffectiveWebPolicyOptions => ({
  companyEnabled: true,
  allowedDomains,
  adapterAvailable: true,
  provider: "tinyfish",
  allowlistSupported: true,
  maxDomainFilters: 1,
  ...overrides,
});

describe("shared web policy derivation", () => {
  it("normalizes IDNA, trailing dots, deduplication, and sorting", () => {
    expect(normalizeDomainAllowlist([" Example.COM. ", "État.fr", "example.com"])).toEqual({
      ok: true,
      domains: ["example.com", "xn--tat-9la.fr"],
    });
  });

  it("preserves an empty stored allowlist as active", () => {
    expect(normalizeDomainAllowlist([])).toEqual({ ok: true, domains: [] });
  });

  it("preserves the raw non-null allowlist marker for null and empty storage", () => {
    expect(deriveEffectiveWebPolicy(options(null, { companyEnabled: false }))).toEqual({
      enabled: false,
      reason: "company_disabled",
      allowlistActive: false,
    });
    expect(deriveEffectiveWebPolicy(options([], { companyEnabled: false }))).toEqual({
      enabled: false,
      reason: "company_disabled",
      allowlistActive: true,
    });
    expect(
      deriveEffectiveWebPolicy(options([], { adapterAvailable: false, provider: null })),
    ).toEqual({
      enabled: false,
      reason: "deployment_unavailable",
      allowlistActive: true,
    });
  });

  it.each(matrix)(
    "applies precedence for $name across company and provider availability",
    ({ allowedDomains, allowlistActive }) => {
      expect(
        deriveEffectiveWebPolicy(
          options(allowedDomains, {
            companyEnabled: false,
            adapterAvailable: false,
            provider: null,
          }),
        ),
      ).toEqual({ enabled: false, reason: "company_disabled", allowlistActive });

      expect(
        deriveEffectiveWebPolicy(
          options(allowedDomains, {
            companyEnabled: true,
            adapterAvailable: false,
            provider: null,
          }),
        ),
      ).toEqual({ enabled: false, reason: "deployment_unavailable", allowlistActive });
    },
  );

  it("rejects invalid and over-limit allowlists only after the provider gate", () => {
    expect(deriveEffectiveWebPolicy(options(["https://example.com"]))).toEqual({
      enabled: false,
      reason: "allowlist_unsupported",
      allowlistActive: true,
    });
    expect(deriveEffectiveWebPolicy(options(["a.example.com", "b.example.com"]))).toEqual({
      enabled: false,
      reason: "allowlist_unsupported",
      allowlistActive: true,
    });
    expect(
      deriveEffectiveWebPolicy(options(["a.example.com"], { allowlistSupported: false })),
    ).toEqual({ enabled: false, reason: "allowlist_unsupported", allowlistActive: true });
  });

  it.each([
    { allowedDomains: null, expected: null },
    { allowedDomains: ["example.com"], expected: ["example.com"] },
  ] as const)("enables supported $allowedDomains", ({ allowedDomains, expected }) => {
    expect(deriveEffectiveWebPolicy(options(allowedDomains, { maxDomainFilters: 8 }))).toEqual({
      enabled: true,
      provider: "tinyfish",
      allowedDomains: expected,
    });
  });

  it("fails closed when an empty allowlist reaches an enabled deployment", () => {
    expect(deriveEffectiveWebPolicy(options([], { maxDomainFilters: 8 }))).toEqual({
      enabled: false,
      reason: "allowlist_unsupported",
      allowlistActive: true,
    });
  });
});
