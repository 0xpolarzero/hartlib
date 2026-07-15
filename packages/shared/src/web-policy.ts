import type { EffectiveWebPolicy } from "./chat";

export type DomainAllowlistNormalization =
  | { readonly ok: true; readonly domains: readonly string[] | null }
  | { readonly ok: false };

const forbiddenPrivateSuffixes = [
  "localhost",
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".corp",
  ".lan",
  ".home",
  ".home.arpa",
  ".test",
  ".invalid",
  ".example",
] as const;

const normalizedDomain = (input: string): string | null => {
  const trimmed = input.trim().toLowerCase();
  const trailingDots = trimmed.match(/\.+$/u)?.[0].length ?? 0;
  if (trailingDots > 1) return null;
  const hostnameInput = trailingDots === 1 ? trimmed.slice(0, -1) : trimmed;
  if (
    hostnameInput.length === 0 ||
    hostnameInput.length > 253 ||
    hostnameInput.includes("*") ||
    hostnameInput.includes(":") ||
    hostnameInput.includes("/") ||
    hostnameInput.includes("@")
  ) {
    return null;
  }

  let hostname: string;
  try {
    const url = new URL(`https://${hostnameInput}`);
    if (
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    hostname = url.hostname.toLowerCase().replace(/\.+$/u, "");
  } catch {
    return null;
  }

  if (
    !hostname.includes(".") ||
    /^\d+(?:\.\d+){3}$/u.test(hostname) ||
    hostname.includes(":") ||
    forbiddenPrivateSuffixes.some(
      (suffix) => hostname === suffix.replace(/^\./u, "") || hostname.endsWith(suffix),
    )
  ) {
    return null;
  }

  const labels = hostname.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
  ) {
    return null;
  }
  return hostname;
};

/** Normalize a stored/company-provided allowlist without weakening validation. */
export const normalizeDomainAllowlist = (
  values: readonly string[] | null,
): DomainAllowlistNormalization => {
  // `null` is the only unrestricted marker. A stored empty array is still an
  // active allowlist and must remain distinguishable so policy derivation can
  // fail closed instead of silently broadening access.
  if (values === null) return { ok: true, domains: null };
  const normalized: string[] = [];
  for (const value of values) {
    const domain = normalizedDomain(value);
    if (domain === null) return { ok: false };
    if (!normalized.includes(domain)) normalized.push(domain);
  }
  normalized.sort();
  return { ok: true, domains: normalized };
};

export interface EffectiveWebPolicyOptions {
  readonly companyEnabled: boolean;
  readonly allowedDomains: readonly string[] | null;
  readonly adapterAvailable: boolean;
  readonly provider: "tinyfish" | null;
  readonly allowlistSupported: boolean;
  readonly maxDomainFilters: number;
}

/**
 * Derive the product web policy in one place for API and worker callers.
 * The raw non-null marker is preserved before normalization so corrupt or
 * empty stored arrays remain visible as an active allowlist in disabled
 * outcomes. Company disablement and deployment availability deliberately
 * precede allowlist validation.
 */
export const deriveEffectiveWebPolicy = (
  options: EffectiveWebPolicyOptions,
): EffectiveWebPolicy => {
  const allowlistActive = options.allowedDomains !== null;
  if (!options.companyEnabled) {
    return { enabled: false, reason: "company_disabled", allowlistActive };
  }
  if (!options.adapterAvailable || options.provider === null) {
    return { enabled: false, reason: "deployment_unavailable", allowlistActive };
  }

  const normalized = normalizeDomainAllowlist(options.allowedDomains);
  if (
    !normalized.ok ||
    (normalized.domains !== null &&
      (normalized.domains.length === 0 ||
        !options.allowlistSupported ||
        normalized.domains.length > options.maxDomainFilters))
  ) {
    return { enabled: false, reason: "allowlist_unsupported", allowlistActive: true };
  }
  return {
    enabled: true,
    provider: options.provider,
    allowedDomains: normalized.domains,
  };
};
