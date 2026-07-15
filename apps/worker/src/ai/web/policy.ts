import type { EffectiveWebPolicy } from "../runtime/types";
import { deriveEffectiveWebPolicy, normalizeDomainAllowlist } from "@brief/shared";
import { WebBoundaryError } from "./errors";

export const canonicalAllowedDomains = (
  domains: readonly string[] | null,
): readonly string[] | null => {
  const normalized = normalizeDomainAllowlist(domains);
  if (!normalized.ok) {
    throw new WebBoundaryError("disallowed_domain", "web domain is invalid", false);
  }
  return normalized.domains;
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

const isStricter = (
  acceptedDomains: readonly string[] | null,
  currentDomains: readonly string[] | null,
): boolean => {
  if (currentDomains === null) return false;
  if (acceptedDomains === null) return true;
  const current = canonicalAllowedDomains(currentDomains);
  return (
    canonicalAllowedDomains(acceptedDomains)?.some(
      (acceptedDomain) => !hostMatchesAllowedDomain(acceptedDomain, current),
    ) ?? false
  );
};

/**
 * The accepted snapshot remains the operation boundary. Current product state
 * is checked immediately before every external operation and can only revoke
 * or narrow access; a later expansion never broadens an in-flight run.
 */
export const recheckWebPolicy = (
  accepted: EffectiveWebPolicy,
  current: EffectiveWebPolicy,
): Extract<EffectiveWebPolicy, { readonly enabled: true }> => {
  if (!accepted.enabled) {
    throw new WebBoundaryError(
      "unsupported_policy",
      "web was not enabled when the run was accepted",
      false,
    );
  }
  if (!current.enabled || current.provider !== accepted.provider) {
    throw new WebBoundaryError(
      "web_policy_revoked",
      "web access was revoked after acceptance",
      true,
    );
  }
  if (isStricter(accepted.allowedDomains, current.allowedDomains)) {
    throw new WebBoundaryError(
      "web_policy_revoked",
      "web allowlist became stricter after acceptance",
      true,
    );
  }
  return {
    enabled: true,
    provider: accepted.provider,
    allowedDomains: canonicalAllowedDomains(accepted.allowedDomains),
  };
};
