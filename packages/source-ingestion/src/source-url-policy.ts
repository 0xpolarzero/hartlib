import { canonicalPublicSourceHttpsUrl } from "@hartlib/shared";

import type { Fetcher, FetchResponse, PublicSourceDefinition } from "./types";
import { cancelPublicSourceResponseBody } from "./http";
import { SourceIngestionError } from "./types";

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maximumRedirects = 5;

const normalizedOrigins = (values: readonly string[]): readonly string[] =>
  values.map((value) => {
    const url = canonicalPublicSourceHttpsUrl(value);
    if (url === null) throw new Error(`Invalid configured public-source origin: ${value}`);
    const parsed = new URL(url);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error(`Public-source origin must not contain a path, query, or fragment: ${value}`);
    }
    return parsed.origin;
  });

const configuredFetchOrigins = (definition: PublicSourceDefinition): readonly string[] =>
  normalizedOrigins(
    definition.fetchOrigins ??
      [
        definition.discoveryUrl,
        ...(definition.discoveryUrls ?? []),
        ...(definition.contentUrl ? [definition.contentUrl] : []),
      ].map((value) => new URL(value).origin),
  );

const configuredCanonicalOrigins = (definition: PublicSourceDefinition): readonly string[] =>
  normalizedOrigins(definition.canonicalUrlOrigins ?? configuredFetchOrigins(definition));

const canonicalizeAtOrigins = (value: string, origins: readonly string[]): string | null => {
  const canonical = canonicalPublicSourceHttpsUrl(value);
  if (canonical === null) return null;
  return origins.includes(new URL(canonical).origin) ? canonical : null;
};

export const canonicalizeSourceCanonicalUrl = (
  definition: PublicSourceDefinition,
  value: string,
): string | null => canonicalizeAtOrigins(value, configuredCanonicalOrigins(definition));

export const canonicalizeSourceFetchUrl = (
  definition: PublicSourceDefinition,
  value: string,
): string | null => canonicalizeAtOrigins(value, configuredFetchOrigins(definition));

export const assertSourceFetchUrl = (definition: PublicSourceDefinition, value: string): string => {
  const canonical = canonicalizeSourceFetchUrl(definition, value);
  if (canonical === null) {
    throw new SourceIngestionError(
      "Public-source fetch URL is outside the configured HTTPS origins",
      {
        sourceId: definition.id,
      },
    );
  }
  return canonical;
};

/**
 * The native fetcher is forced into manual redirect mode so every hop is
 * authorized before the request leaves Hartlib. A custom test/host fetcher that
 * ignores `redirect: manual` is still rejected if its final response URL is
 * outside policy.
 */
export const makeSourcePolicyFetcher =
  (definition: PublicSourceDefinition, fetcher: Fetcher): Fetcher =>
  async (inputUrl, init): Promise<FetchResponse> => {
    let currentUrl = assertSourceFetchUrl(definition, inputUrl);
    for (let redirectCount = 0; ; redirectCount += 1) {
      const response = await fetcher(currentUrl, { ...init, redirect: "manual" });
      if (!redirectStatuses.has(response.status)) {
        try {
          // A custom transport may auto-follow redirects while hiding the
          // final URL.  Accepting that response would make the origin check
          // fail open, so a non-redirect response must report a non-empty,
          // policy-valid final URL just like the native fetch transport.
          if (!response.url) {
            throw new SourceIngestionError(
              "Public-source response omitted its final URL after redirect handling",
              { sourceId: definition.id },
            );
          }
          assertSourceFetchUrl(definition, response.url);
        } catch (error) {
          await cancelPublicSourceResponseBody(response, error);
          throw error;
        }
        return response;
      }
      try {
        if (redirectCount >= maximumRedirects) {
          throw new SourceIngestionError("Public-source fetch exceeded the redirect limit", {
            sourceId: definition.id,
          });
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new SourceIngestionError("Public-source redirect omitted its location", {
            sourceId: definition.id,
          });
        }
        currentUrl = assertSourceFetchUrl(definition, new URL(location, currentUrl).href);
      } finally {
        await cancelPublicSourceResponseBody(response, "public-source redirect followed");
      }
    }
  };
