import { Schema } from "effect";

import {
  AI_WEB_MAX_DOMAIN_FILTERS_DEFAULT,
  AI_WEB_MAX_DOMAIN_FILTERS_HARD_MAX,
} from "@brief/shared";

import type { EffectiveWebPolicy, Locale, Market } from "../runtime/types";
import { canonicalizeWebUrl } from "../runtime/canonicalization";
import { forwardAbortSignal, taskAbortError, throwIfAborted } from "../runtime/task-cancellation";
import { WebBoundaryError, toWebBoundaryError, withFailureAccounting } from "./errors";
import { assertDomainAllowed, assertSavedWebPolicy, canonicalAllowedDomains } from "./policy";
import type { WebFetch, WebOperationAccounting, WebSearchResponse, WebSearchResult } from "./types";

export const TINYFISH_SEARCH_ENDPOINT = "https://api.search.tinyfish.ai";
export const TINYFISH_SEARCH_PROVIDER_SERVICE_ID = "tinyfish_search_official" as const;
export const TINYFISH_SEARCH_PROVIDER_ENDPOINT_IDENTITY =
  `${TINYFISH_SEARCH_PROVIDER_SERVICE_ID}:${TINYFISH_SEARCH_ENDPOINT}` as const;
export const TINYFISH_SEARCH_QUERY_MAX_BYTES = 2 * 1024;
export const TINYFISH_SEARCH_RESPONSE_MAX_BYTES = 1024 * 1024;
export const TINYFISH_SEARCH_TIMEOUT_MS = 10_000;
export const TINYFISH_SEARCH_DOMAIN_FILTER_DEFAULT_MAX = AI_WEB_MAX_DOMAIN_FILTERS_DEFAULT;
export const TINYFISH_SEARCH_DOMAIN_FILTER_HARD_MAX = AI_WEB_MAX_DOMAIN_FILTERS_HARD_MAX;

const TinyfishSearchResult = Schema.Struct({
  position: Schema.Number,
  site_name: Schema.String,
  title: Schema.String,
  snippet: Schema.String,
  url: Schema.String,
  date: Schema.optional(Schema.String),
});

const TinyfishSearchResponse = Schema.Struct({
  query: Schema.String,
  results: Schema.Array(TinyfishSearchResult),
  total_results: Schema.Number,
  page: Schema.Number,
});

export interface TinyfishSearchOptions {
  readonly apiKey: string;
  readonly locale: Locale;
  readonly market: Market;
  readonly acceptedPolicy: EffectiveWebPolicy;
  readonly fetch?: WebFetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly responseMaxBytes?: number | undefined;
  readonly maxDomainFilters?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

const timeoutError = (): WebBoundaryError =>
  new WebBoundaryError("fetch_timeout", "web search timed out", true);

const awaitWithDeadline = <Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> =>
  new Promise<Value>((resolve, reject) => {
    const onAbort = () => reject(timeoutError());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });

/**
 * Await stream cancellation even when the boundary signal is already
 * aborted, while keeping the operation's one cumulative deadline as the
 * outer bound. Cancellation rejection is contained by the caller-provided
 * promise, so it cannot replace the typed boundary outcome.
 */
const awaitCancellationBounded = async (
  cancellation: Promise<void>,
  signal: AbortSignal,
  deadlineAt: number | undefined,
): Promise<void> => {
  if (deadlineAt === undefined) {
    if (signal.aborted) {
      await cancellation;
      return;
    }
    await awaitWithDeadline(cancellation, signal).catch(() => undefined);
    return;
  }

  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cancellation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const cancelBody = async (
  body: ReadableStream<Uint8Array> | null | undefined,
  reason: unknown,
  signal: AbortSignal,
  deadlineAt?: number,
): Promise<void> => {
  if (!body) return;
  const cancellation = Promise.resolve()
    .then(() => body.cancel(reason))
    .catch(() => undefined);
  await awaitCancellationBounded(cancellation, signal, deadlineAt);
};

const cancelReader = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
  signal: AbortSignal,
  deadlineAt?: number,
): Promise<void> => {
  const cancellation = Promise.resolve()
    .then(() => reader.cancel(reason))
    .catch(() => undefined);
  await awaitCancellationBounded(cancellation, signal, deadlineAt);
};

const declaredContentLength = (response: Response): number | undefined => {
  const header = response.headers.get("content-length");
  if (header === null) return undefined;
  const normalized = header.trim();
  if (!/^\d+$/u.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const readProviderBody = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  deadlineAt: number | undefined,
): Promise<Uint8Array> => {
  const declaredLengthHeader = response.headers.get("content-length");
  if (declaredLengthHeader !== null) {
    const declaredLength = declaredContentLength(response);
    if (declaredLength === undefined || declaredLength > maxBytes) {
      await cancelBody(response.body, "invalid provider response length", signal, deadlineAt);
      throw new WebBoundaryError(
        "invalid_provider_response",
        "web search provider response length is invalid",
        false,
      );
    }
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  let cancellation: Promise<void> | undefined;
  const ensureCancelled = (reason: unknown): Promise<void> => {
    cancellation ??= cancelReader(reader, reason, signal, deadlineAt);
    return cancellation;
  };
  try {
    while (true) {
      const chunk = await new Promise<
        | { readonly done: true; readonly value?: undefined }
        | { readonly done: false; readonly value: Uint8Array }
      >((resolve, reject) => {
        const onAbort = () => {
          reject(timeoutError());
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        void reader.read().then(
          (result) => {
            signal.removeEventListener("abort", onAbort);
            resolve(
              result.done ? { done: true } : { done: false, value: new Uint8Array(result.value) },
            );
          },
          (error: unknown) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
      if (chunk.done) break;
      byteCount += chunk.value.byteLength;
      if (byteCount > maxBytes) {
        await ensureCancelled("provider response byte limit exceeded");
        throw new WebBoundaryError(
          "invalid_provider_response",
          "web search provider response exceeds byte limit",
          false,
        );
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    await ensureCancelled(error);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const failedOperation = (
  startedAt: number,
  responseBytes: number,
  error: WebBoundaryError,
): WebOperationAccounting => ({
  kind: "search",
  provider: "tinyfish",
  outcome: "failed",
  resultCount: 0,
  responseBytes,
  durationMs: Math.max(0, Date.now() - startedAt),
  errorCode: error.code,
});

const invalidProviderResponse = (): WebBoundaryError =>
  new WebBoundaryError(
    "invalid_provider_response",
    "web search provider response is invalid",
    false,
  );

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => {
  const expected = new Set(keys);
  const actual = Object.keys(record);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
};

const decodeProviderResponse = (
  bytes: Uint8Array,
  expectedQuery: string,
  allowedDomains: readonly string[] | null,
  requestedDomain: string | undefined,
): { readonly results: readonly WebSearchResult[]; readonly totalResults: number } => {
  let decoded: Schema.Schema.Type<typeof TinyfishSearchResponse>;
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (
      !isRecord(parsed) ||
      !hasExactKeys(parsed, ["query", "results", "total_results", "page"]) ||
      !Array.isArray(parsed.results) ||
      parsed.results.some(
        (result) =>
          !isRecord(result) ||
          !hasExactKeys(
            result,
            "date" in result
              ? ["position", "site_name", "title", "snippet", "url", "date"]
              : ["position", "site_name", "title", "snippet", "url"],
          ),
      )
    ) {
      throw invalidProviderResponse();
    }
    decoded = Schema.decodeUnknownSync(TinyfishSearchResponse)(parsed);
  } catch {
    throw invalidProviderResponse();
  }

  if (
    decoded.query !== expectedQuery ||
    !Number.isSafeInteger(decoded.total_results) ||
    decoded.total_results < 0 ||
    decoded.results.length > 10 ||
    !Number.isSafeInteger(decoded.page) ||
    decoded.page !== 0
  ) {
    throw invalidProviderResponse();
  }

  const positions = new Set<number>();
  const results = decoded.results.map((result) => {
    if (
      !Number.isSafeInteger(result.position) ||
      result.position < 1 ||
      result.position > decoded.total_results ||
      positions.has(result.position) ||
      result.site_name.normalize("NFC").trim() === "" ||
      result.title.normalize("NFC").trim() === "" ||
      (result.date !== undefined && result.date.normalize("NFC").trim() === "")
    ) {
      throw invalidProviderResponse();
    }
    positions.add(result.position);

    let url: string;
    try {
      url = canonicalizeWebUrl(result.url);
    } catch {
      throw invalidProviderResponse();
    }
    const domain = new URL(url).hostname;
    assertDomainAllowed(domain, allowedDomains);
    if (requestedDomain !== undefined) assertDomainAllowed(domain, [requestedDomain]);

    // `date` is documented discovery metadata. Validate it above, then omit it:
    // only Brief's independently fetched page may establish citation publication time.
    return {
      title: result.title.normalize("NFC").trim(),
      url,
      domain,
      snippet: result.snippet.normalize("NFC").trim(),
      // Tinyfish positions are documented as 1-based; preserve the provider rank verbatim.
      providerRank: result.position,
    };
  });

  return {
    results: results.sort((left, right) => left.providerRank - right.providerRank),
    totalResults: decoded.total_results,
  };
};

const searchOneDomain = async (
  query: string,
  domain: string | undefined,
  language: string,
  location: string,
  acceptedPolicy: Extract<EffectiveWebPolicy, { readonly enabled: true }>,
  options: TinyfishSearchOptions,
): Promise<{
  readonly results: readonly WebSearchResult[];
  readonly totalResults: number;
  readonly operation: WebOperationAccounting;
}> => {
  const startedAt = Date.now();
  const controller = new AbortController();
  const removeTaskAbortForwarder = forwardAbortSignal(options.signal, controller);
  const timeoutMs = options.timeoutMs ?? TINYFISH_SEARCH_TIMEOUT_MS;
  const responseMaxBytes = options.responseMaxBytes ?? TINYFISH_SEARCH_RESPONSE_MAX_BYTES;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let deadlineAt: number | undefined;
  let deadlineExpired = false;
  let responseBytes = 0;
  try {
    throwIfAborted(options.signal);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > TINYFISH_SEARCH_TIMEOUT_MS) {
      throw new WebBoundaryError("fetch_timeout", "web search deadline is invalid", false);
    }
    if (
      !Number.isSafeInteger(responseMaxBytes) ||
      responseMaxBytes < 1 ||
      responseMaxBytes > TINYFISH_SEARCH_RESPONSE_MAX_BYTES
    ) {
      throw new WebBoundaryError(
        "invalid_provider_response",
        "web search provider response byte limit is invalid",
        false,
      );
    }
    deadlineAt = Date.now() + timeoutMs;
    timeout = setTimeout(() => {
      deadlineExpired = true;
      controller.abort();
    }, timeoutMs);

    if (domain !== undefined) assertDomainAllowed(domain, acceptedPolicy.allowedDomains);

    const url = new URL(TINYFISH_SEARCH_ENDPOINT);
    url.searchParams.set("query", query);
    url.searchParams.set("location", location);
    url.searchParams.set("language", language);
    url.searchParams.set("page", "0");

    let response: Response;
    let bytes: Uint8Array;
    try {
      response = await awaitWithDeadline(
        (options.fetch ?? globalThis.fetch)(url.href, {
          method: "GET",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "X-API-Key": options.apiKey,
          },
        }),
        controller.signal,
      );
      if (!response.ok) {
        // Classify status before touching the body. A rejected provider
        // response (including an oversized 429) is not trusted input and may
        // be unbounded; cancellation is awaited and rejection-contained.
        await cancelBody(
          response.body,
          "provider response rejected",
          controller.signal,
          deadlineAt,
        );
        throw new WebBoundaryError(
          "provider_failure",
          "web search provider rejected the request",
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      }
      bytes = await readProviderBody(response, responseMaxBytes, controller.signal, deadlineAt);
      responseBytes = bytes.byteLength;
    } catch (error) {
      if (options.signal?.aborted) throw taskAbortError();
      if (deadlineExpired) throw timeoutError();
      throw toWebBoundaryError(error, "provider_failure");
    }

    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") throw invalidProviderResponse();

    const decoded = decodeProviderResponse(bytes, query, acceptedPolicy.allowedDomains, domain);
    throwIfAborted(options.signal);
    return {
      results: decoded.results,
      totalResults: decoded.totalResults,
      operation: {
        kind: "search",
        provider: "tinyfish",
        outcome: decoded.results.length === 0 ? "empty" : "succeeded",
        resultCount: decoded.results.length,
        responseBytes,
        durationMs: Math.max(0, Date.now() - startedAt),
      },
    };
  } catch (error) {
    if (options.signal?.aborted) throw taskAbortError();
    const boundaryError = deadlineExpired
      ? timeoutError()
      : toWebBoundaryError(error, "provider_failure");
    throw withFailureAccounting(boundaryError, [
      failedOperation(startedAt, responseBytes, boundaryError),
    ]);
  } finally {
    clearTimeout(timeout);
    removeTaskAbortForwarder();
  }
};

const languageForLocale = (locale: Locale): "en" | "fr" => {
  const language = ({ "en-US": "en", "fr-FR": "fr" } as Readonly<Record<string, string>>)[locale];
  if (language !== "en" && language !== "fr") {
    throw new WebBoundaryError("provider_failure", "web search locale is invalid", false);
  }
  return language;
};

const locationForMarket = (market: Market): "US" | "FR" => {
  const location = ({ US: "US", FR: "FR" } as Readonly<Record<string, string>>)[market];
  if (location !== "US" && location !== "FR") {
    throw new WebBoundaryError("provider_failure", "web search market is invalid", false);
  }
  return location;
};

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

/** Calls Tinyfish Search once per bounded allowlisted domain. */
export const searchTinyfishWeb = async (
  query: string,
  count: number,
  options: TinyfishSearchOptions,
): Promise<WebSearchResponse> => {
  throwIfAborted(options.signal);
  const normalizedQuery = query.normalize("NFC").trim();
  if (normalizedQuery === "") {
    throw new WebBoundaryError("provider_failure", "web search query must not be empty", false);
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > 10) {
    throw new WebBoundaryError(
      "provider_failure",
      "web search count must be between 1 and 10",
      false,
    );
  }
  if (options.apiKey.trim() === "") {
    throw new WebBoundaryError("unsupported_policy", "Tinyfish Search is not configured", false);
  }
  const language = languageForLocale(options.locale);
  const location = locationForMarket(options.market);

  const acceptedPolicy = assertSavedWebPolicy(options.acceptedPolicy);
  const domains = canonicalAllowedDomains(acceptedPolicy.allowedDomains) ?? [undefined];
  const maxDomainFilters = options.maxDomainFilters ?? TINYFISH_SEARCH_DOMAIN_FILTER_DEFAULT_MAX;
  if (
    !Number.isSafeInteger(maxDomainFilters) ||
    maxDomainFilters < 1 ||
    maxDomainFilters > TINYFISH_SEARCH_DOMAIN_FILTER_HARD_MAX
  ) {
    throw new WebBoundaryError(
      "unsupported_policy",
      "Tinyfish Search domain-filter limit is invalid",
      false,
    );
  }
  if (acceptedPolicy.allowedDomains !== null && domains.length > maxDomainFilters) {
    throw new WebBoundaryError(
      "unsupported_policy",
      "the active web allowlist exceeds the adapter domain-filter limit",
      false,
    );
  }

  const scopedQueries = domains.map((domain) =>
    domain === undefined ? normalizedQuery : `${normalizedQuery} site:${domain}`,
  );
  if (
    scopedQueries.some((scopedQuery) => byteLength(scopedQuery) > TINYFISH_SEARCH_QUERY_MAX_BYTES)
  ) {
    throw new WebBoundaryError(
      "provider_failure",
      "web search query exceeds the byte limit",
      false,
    );
  }

  const responses: Array<Awaited<ReturnType<typeof searchOneDomain>>> = [];
  for (const [index, domain] of domains.entries()) {
    try {
      throwIfAborted(options.signal);
      responses.push(
        await searchOneDomain(
          scopedQueries[index] as string,
          domain,
          language,
          location,
          acceptedPolicy,
          options,
        ),
      );
    } catch (error) {
      if (options.signal?.aborted) throw taskAbortError();
      const boundaryError = toWebBoundaryError(error, "provider_failure");
      throw withFailureAccounting(boundaryError, [
        ...responses.map(({ operation }) => operation),
        ...boundaryError.operations,
      ]);
    }
  }

  const unique = new Map<string, WebSearchResult>();
  for (const response of responses) {
    for (const result of response.results) {
      if (!unique.has(result.url)) unique.set(result.url, result);
    }
  }
  // The cap is evaluated against each provider operation before URL
  // de-duplication. Tinyfish's fixed page-0 response is complete when its
  // declared total equals the returned count; only a provider total beyond
  // the returned page creates an unresolvable continuation obligation.
  const truncated = responses.some(({ results, totalResults }) => totalResults > results.length);
  throwIfAborted(options.signal);
  return {
    results: [...unique.values()].slice(0, count),
    operations: responses.map(({ operation }) => operation),
    complete: !truncated,
    truncated,
  };
};
