import type { EffectiveWebPolicy } from "../runtime/types";
import type { WebBoundaryError } from "./errors";

export type EnabledWebPolicy = Extract<EffectiveWebPolicy, { readonly enabled: true }>;
export type WebFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Z.AI remains readable only for historical operation rows; no executable adapter exists. */
export type WebOperationProvider = "tinyfish" | "zai" | "hartlib_fetch";

export interface PinnedWebRequest {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
  readonly signal: AbortSignal;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Transport contract for direct page fetches. The caller supplies the exact
 * DNS address that was policy-checked; implementations must connect to that
 * address while retaining the URL hostname for HTTP Host and TLS SNI.
 */
export type PinnedWebRequestTransport = (request: PinnedWebRequest) => Promise<Response>;

export interface WebOperationAccounting {
  readonly kind: "search" | "fetch";
  readonly provider: WebOperationProvider;
  readonly outcome: "succeeded" | "empty" | "failed";
  readonly resultCount: number;
  readonly responseBytes: number;
  readonly durationMs: number;
  readonly errorCode?: WebBoundaryError["code"] | undefined;
}

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly snippet: string;
  readonly publishedAt?: string | undefined;
  readonly providerRank: number;
}

export interface WebSearchResponse {
  readonly results: readonly WebSearchResult[];
  readonly operations: readonly WebOperationAccounting[];
  /**
   * Tinyfish has a fixed page-0, ten-result boundary and no continuation
   * cursor. These fields preserve the raw per-operation cap decision before
   * URL de-duplication so W cannot mistake a capped response for a complete
   * one merely because duplicate URLs collapsed the visible result list.
   */
  readonly complete: boolean;
  readonly truncated: boolean;
}

export interface SafeFetchedPage {
  readonly canonicalUrl: string;
  readonly title: string;
  readonly domain: string;
  readonly publishedAt?: string | undefined;
  readonly mediaType: string;
  readonly text: string;
  readonly capturedAt: string;
  readonly operation: WebOperationAccounting;
}
