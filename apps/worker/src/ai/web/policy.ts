import type { EffectiveWebPolicy } from "../runtime/types";
import { deriveEffectiveWebPolicy, normalizeDomainAllowlist } from "@brief/shared";
import { WebBoundaryError } from "./errors";
import type { EnabledWebPolicy } from "./types";

export const canonicalAllowedDomains = (
  domains: readonly string[] | null,
): readonly string[] | null => {
  const normalized = normalizeDomainAllowlist(domains);
  if (!normalized.ok) {
    throw new WebBoundaryError("disallowed_domain", "web domain is invalid", false);
  }
  return normalized.domains;
};

/** Validate and detach the immutable policy supplied to one web operation. */
export const assertSavedWebPolicy = (policy: EffectiveWebPolicy): EnabledWebPolicy => {
  if (
    policy === null ||
    typeof policy !== "object" ||
    policy.enabled !== true ||
    policy.provider !== "tinyfish" ||
    !("allowedDomains" in policy) ||
    Object.keys(policy).length !== 3 ||
    Object.keys(policy).some((key) => !["enabled", "provider", "allowedDomains"].includes(key)) ||
    (policy.allowedDomains !== null &&
      (!Array.isArray(policy.allowedDomains) ||
        policy.allowedDomains.some((domain) => typeof domain !== "string")))
  ) {
    throw new WebBoundaryError(
      "unsupported_policy",
      "saved web policy does not authorize Tinyfish",
      false,
    );
  }
  const domains = canonicalAllowedDomains(policy.allowedDomains);
  if (
    domains !== null &&
    (domains.length === 0 || JSON.stringify(domains) !== JSON.stringify(policy.allowedDomains))
  ) {
    throw new WebBoundaryError("unsupported_policy", "saved web allowlist is not canonical", false);
  }
  return {
    enabled: true,
    provider: "tinyfish",
    allowedDomains: domains === null ? null : [...domains],
  };
};

/**
 * Resolves the current product policy with the shared API/worker precedence.
 * Company disablement and provider availability win before allowlist
 * validation, while the raw non-null marker remains visible in disabled
 * outcomes.
 */
export const effectiveWebPolicy = (options: {
  readonly enabled: boolean;
  readonly allowedDomains: readonly string[] | null;
  readonly providerAvailable: boolean;
  readonly maxDomainFilters: number;
}): EffectiveWebPolicy => {
  return deriveEffectiveWebPolicy({
    companyEnabled: options.enabled,
    allowedDomains: options.allowedDomains,
    adapterAvailable: options.providerAvailable,
    provider: options.providerAvailable ? "tinyfish" : null,
    allowlistSupported: options.providerAvailable,
    maxDomainFilters: options.maxDomainFilters,
  });
};

export const hostMatchesAllowedDomain = (
  host: string,
  allowedDomains: readonly string[] | null,
): boolean => {
  if (allowedDomains === null) return true;
  const normalizedHost = normalizeDomainAllowlist([host]);
  if (!normalizedHost.ok || normalizedHost.domains === null) return false;
  const canonicalHost = normalizedHost.domains[0]!;
  return allowedDomains.some((domain) => {
    const normalizedDomain = normalizeDomainAllowlist([domain]);
    if (!normalizedDomain.ok || normalizedDomain.domains === null) return false;
    const canonicalDomain = normalizedDomain.domains[0]!;
    return canonicalHost === canonicalDomain || canonicalHost.endsWith(`.${canonicalDomain}`);
  });
};

export const assertDomainAllowed = (
  host: string,
  allowedDomains: readonly string[] | null,
): void => {
  if (!hostMatchesAllowedDomain(host, allowedDomains)) {
    throw new WebBoundaryError(
      "disallowed_domain",
      "web host is outside the accepted allowlist",
      false,
    );
  }
};
