import { Resolver } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import {
  extractHtmlPublishedAt,
  extractHtmlTitle,
  extractPdfPagesIsolated,
  stripHtml,
} from "@brief/source-ingestion";

import type { EffectiveWebPolicy } from "../runtime/types";
import { canonicalizeWebUrl } from "../runtime/canonicalization";
import { forwardAbortSignal, taskAbortError, throwIfAborted } from "../runtime/task-cancellation";
import { WebBoundaryError, toWebBoundaryError, withFailureAccounting } from "./errors";
import { areEquivalentIpAddresses, isPrivateOrReservedAddress } from "./ip-policy";
import { assertDomainAllowed, recheckWebPolicy } from "./policy";
import type {
  LoadEffectiveWebPolicy,
  PinnedWebRequest,
  PinnedWebRequestTransport,
  SafeFetchedPage,
  WebOperationAccounting,
} from "./types";

export const WEB_PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const WEB_OPERATION_TIMEOUT_MS = 10_000;
export const WEB_MAX_REDIRECTS = 5;

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

export interface SafeFetchOptions {
  readonly acceptedPolicy: EffectiveWebPolicy;
  readonly loadCurrentPolicy: LoadEffectiveWebPolicy;
  readonly request?: PinnedWebRequestTransport | undefined;
  /**
   * Resolves the complete answer set. Implementations must observe the signal
   * and reject/stop their resolver when it aborts; this prevents a timed-out
   * lookup from continuing into a later retry.
   */
  readonly resolve?:
    | ((hostname: string, signal: AbortSignal) => Promise<readonly ResolvedAddress[]>)
    | undefined;
  readonly now?: (() => Date) | undefined;
  readonly maxBytes?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxRedirects?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

const supportedMediaTypes = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/ld+json",
  "application/pdf",
]);

const defaultResolve = (
  hostname: string,
  signal: AbortSignal,
): Promise<readonly ResolvedAddress[]> => {
  // dns.promises.lookup() cannot be cancelled. A per-operation Resolver gives
  // us a real cancellation boundary: Resolver.cancel() terminates all DNS
  // requests belonging to this lookup before the task can unwind or retry.
  const resolver = new Resolver();
  return new Promise<readonly ResolvedAddress[]>((resolve, reject) => {
    let settled = false;
    let pending = 2;
    const addresses: ResolvedAddress[] = [];
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const settleResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(addresses);
    };
    const settleReject = (cause: unknown) => {
      if (settled) return;
      settled = true;
      resolver.cancel();
      cleanup();
      reject(cause);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      resolver.cancel();
      cleanup();
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    const noData = (error: NodeJS.ErrnoException): boolean =>
      error.code === "ENODATA" || error.code === "ENOTFOUND";
    const finish = (family: 4 | 6, error: NodeJS.ErrnoException | null, values: string[]) => {
      if (settled) return;
      if (error !== null) {
        if (!noData(error)) {
          settleReject(error);
          return;
        }
      } else {
        addresses.push(...values.map((address) => ({ address, family })));
      }
      pending -= 1;
      if (pending === 0) settleResolve();
    };

    resolver.resolve4(hostname, (error, values) => finish(4, error, values));
    resolver.resolve6(hostname, (error, values) => finish(6, error, values));
  });
};

const timeoutError = (): WebBoundaryError =>
  new WebBoundaryError("fetch_timeout", "web fetch timed out", true);

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
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });

/**
 * Await stream cancellation without allowing an already-aborted operation
 * signal to short-circuit it. The operation deadline remains the outer bound;
 * a late cancellation is observed and contained even when the caller has
 * already moved on to its typed boundary error.
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

const resolveAndValidateAddress = async (
  hostname: string,
  resolve: (hostname: string, signal: AbortSignal) => Promise<readonly ResolvedAddress[]>,
  signal: AbortSignal,
): Promise<{ readonly address: string; readonly family: 4 | 6 }> => {
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await awaitWithDeadline(resolve(hostname, signal), signal);
  } catch (cause) {
    if (cause instanceof WebBoundaryError) throw cause;
    throw new WebBoundaryError(
      "dns_resolution_failed",
      "web host DNS resolution failed",
      true,
      cause,
    );
  }
  if (addresses.length === 0) {
    throw new WebBoundaryError("dns_resolution_failed", "web host resolved to no addresses", true);
  }

  const validated = addresses.map(({ address, family }) => {
    if ((family !== 4 && family !== 6) || isIP(address) !== family) {
      throw new WebBoundaryError(
        "private_or_reserved_address",
        "web host returned malformed DNS address data",
        false,
      );
    }
    if (isPrivateOrReservedAddress(address)) {
      throw new WebBoundaryError(
        "private_or_reserved_address",
        "web host resolves to a private or reserved address",
        false,
      );
    }
    return { address, family } as const;
  });
  // Every answer is validated and the transport receives one exact address.
  // It never performs a second, independently mutable DNS lookup.
  return validated[0] as { readonly address: string; readonly family: 4 | 6 };
};

export const connectedPeerMatchesPin = (
  remoteAddress: string | undefined,
  pinnedAddress: string,
  family: 4 | 6,
): boolean => {
  if (remoteAddress === undefined || isIP(pinnedAddress) !== family) return false;
  return areEquivalentIpAddresses(remoteAddress, pinnedAddress);
};

export const pinnedNodeRequestOptions = (target: PinnedWebRequest) => {
  if (target.url.protocol !== "https:") {
    throw new WebBoundaryError("invalid_url", "web transport requires HTTPS", false);
  }
  return {
    protocol: target.url.protocol,
    // A numeric transport hostname prevents a second DNS lookup after policy
    // validation. Host and SNI below retain the original URL hostname.
    hostname: target.address,
    port: target.url.port === "" ? undefined : target.url.port,
    path: `${target.url.pathname}${target.url.search}`,
    method: "GET",
    headers: { ...target.headers, host: target.url.host },
    family: target.family,
    agent: false as const,
    signal: target.signal,
    ...(isIP(target.url.hostname) === 0 ? { servername: target.url.hostname } : {}),
  };
};

const responseHeaders = (
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Headers => {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else {
      result.set(name, value);
    }
  }
  return result;
};

const decodedResponseStream = (
  response: Readable,
  headers: Headers,
): { readonly stream: Readable; readonly decoded: boolean } => {
  const encoding = (headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  switch (encoding) {
    case "":
    case "identity":
      return { stream: response, decoded: false };
    case "gzip":
    case "x-gzip":
      return { stream: response.pipe(createGunzip()), decoded: true };
    case "deflate":
      return { stream: response.pipe(createInflate()), decoded: true };
    case "br":
      return { stream: response.pipe(createBrotliDecompress()), decoded: true };
    default:
      response.destroy();
      throw new WebBoundaryError(
        "unsupported_content_encoding",
        "web response content encoding is not supported",
        false,
      );
  }
};

/**
 * Default direct-page transport. It connects to the validated numeric address
 * while the original hostname remains in Host and TLS SNI.
 */
export const requestPinnedWebResponse: PinnedWebRequestTransport = (target: PinnedWebRequest) =>
  new Promise<Response>((resolve, reject) => {
    if (target.url.protocol !== "https:") {
      reject(new WebBoundaryError("invalid_url", "web transport requires HTTPS", false));
      return;
    }
    let settled = false;
    const settleReject = (cause: unknown) => {
      if (settled) return;
      settled = true;
      reject(cause);
    };
    const request = httpsRequest(pinnedNodeRequestOptions(target), (incoming) => {
      // Node exposes the real peer. Bun 1.3 does not populate remoteAddress
      // on its IncomingMessage compatibility socket; the numeric transport
      // hostname above remains the primary pin in both runtimes.
      if (
        incoming.socket.remoteAddress !== undefined &&
        !connectedPeerMatchesPin(incoming.socket.remoteAddress, target.address, target.family)
      ) {
        incoming.destroy();
        settleReject(
          new WebBoundaryError(
            "connected_address_mismatch",
            "web transport connected to an address other than the validated DNS address",
            false,
          ),
        );
        return;
      }
      const status = incoming.statusCode ?? 0;
      if (status < 200 || status > 599) {
        incoming.destroy();
        settleReject(
          new WebBoundaryError(
            "transport_failure",
            "web transport returned an invalid HTTP status",
            true,
          ),
        );
        return;
      }
      try {
        const headers = responseHeaders(incoming.headers);
        const decoded = decodedResponseStream(incoming, headers);
        if (decoded.decoded) {
          // The declared length describes encoded bytes and cannot prove the
          // decoded body fits. The streaming decoded-byte gate remains final.
          headers.delete("content-encoding");
          headers.delete("content-length");
        }
        const hasNoBody = status === 204 || status === 205 || status === 304;
        const body = hasNoBody
          ? null
          : (Readable.toWeb(decoded.stream) as unknown as ReadableStream<Uint8Array>);
        if (hasNoBody) decoded.stream.resume();
        settled = true;
        resolve(
          new Response(body as BodyInit | null, {
            status,
            ...(incoming.statusMessage === undefined ? {} : { statusText: incoming.statusMessage }),
            headers,
          }),
        );
      } catch (cause) {
        settleReject(cause);
      }
    });
    request.once("error", settleReject);
    request.end();
  });

const mediaTypeOf = (response: Response): string =>
  (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";

const readCappedBody = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  deadlineAt: number | undefined,
): Promise<{ readonly bytes: Uint8Array; readonly byteCount: number }> => {
  const declaredHeader = response.headers.get("content-length");
  let declaredLength: number | undefined;
  if (declaredHeader !== null) {
    const normalized = declaredHeader.trim();
    if (!/^\d+$/u.test(normalized)) {
      await cancelBody(response.body, "invalid response content length", signal, deadlineAt);
      throw new WebBoundaryError(
        "response_too_large",
        "web response content length is invalid",
        false,
      );
    }
    declaredLength = Number(normalized);
    if (!Number.isSafeInteger(declaredLength)) {
      await cancelBody(response.body, "invalid response content length", signal, deadlineAt);
      throw new WebBoundaryError(
        "response_too_large",
        "web response content length is invalid",
        false,
      );
    }
  }
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    await cancelBody(response.body, "response byte limit exceeded", signal, deadlineAt);
    throw new WebBoundaryError("response_too_large", "web response exceeds byte limit", false);
  }
  if (response.body === null) return { bytes: new Uint8Array(), byteCount: 0 };

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
          (cause: unknown) => {
            signal.removeEventListener("abort", onAbort);
            reject(cause);
          },
        );
      });
      if (chunk.done) break;
      byteCount += chunk.value.byteLength;
      if (byteCount > maxBytes) {
        await ensureCancelled("response byte limit exceeded");
        throw new WebBoundaryError("response_too_large", "web response exceeds byte limit", false);
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
  return { bytes, byteCount };
};

const operationFailure = (
  startedAt: number,
  error: WebBoundaryError,
  responseBytes: number,
): WebOperationAccounting => ({
  kind: "fetch",
  provider: "brief_fetch",
  outcome: "failed",
  resultCount: 0,
  responseBytes,
  durationMs: Math.max(0, Date.now() - startedAt),
  errorCode: error.code,
});

/** Fetches a public page with one deadline and a DNS-pinned transport at every hop. */
export const safeFetchPage = async (
  input: string,
  options: SafeFetchOptions,
): Promise<SafeFetchedPage> => {
  throwIfAborted(options.signal);
  const startedAt = Date.now();
  const request = options.request ?? requestPinnedWebResponse;
  const resolve = options.resolve ?? defaultResolve;
  const maxBytes = options.maxBytes ?? WEB_PAGE_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? WEB_OPERATION_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? WEB_MAX_REDIRECTS;
  let currentUrl: string;
  try {
    currentUrl = canonicalizeWebUrl(input);
  } catch (cause) {
    throw new WebBoundaryError("invalid_url", "web URL is invalid", false, cause);
  }

  const controller = new AbortController();
  const removeTaskAbortForwarder = forwardAbortSignal(options.signal, controller);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let deadlineAt: number | undefined;
  let deadlineExpired = false;
  let responseBytes = 0;
  try {
    throwIfAborted(options.signal);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > WEB_PAGE_MAX_BYTES) {
      throw new WebBoundaryError("response_too_large", "web response byte limit is invalid", false);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > WEB_OPERATION_TIMEOUT_MS) {
      throw new WebBoundaryError("fetch_timeout", "web fetch deadline is invalid", false);
    }
    if (
      !Number.isSafeInteger(maxRedirects) ||
      maxRedirects < 0 ||
      maxRedirects > WEB_MAX_REDIRECTS
    ) {
      throw new WebBoundaryError("too_many_redirects", "web redirect limit is invalid", false);
    }
    deadlineAt = Date.now() + timeoutMs;
    deadline = setTimeout(() => {
      deadlineExpired = true;
      controller.abort();
    }, timeoutMs);

    for (let redirectCount = 0; ; redirectCount += 1) {
      const currentPolicy = await awaitWithDeadline(options.loadCurrentPolicy(), controller.signal);
      const accepted = recheckWebPolicy(options.acceptedPolicy, currentPolicy);
      const parsed = new URL(currentUrl);
      assertDomainAllowed(parsed.hostname, accepted.allowedDomains);
      const pinned = await resolveAndValidateAddress(parsed.hostname, resolve, controller.signal);

      let response: Response;
      try {
        response = await awaitWithDeadline(
          request({
            url: parsed,
            address: pinned.address,
            family: pinned.family,
            signal: controller.signal,
            headers: {
              accept:
                "text/html,application/xhtml+xml,text/plain,text/markdown,application/pdf,application/json;q=0.8",
              "accept-encoding": "gzip, deflate, br",
              "user-agent": "BriefWebResearch/1.0",
            },
          }),
          controller.signal,
        );
      } catch (cause) {
        if (options.signal?.aborted) throw taskAbortError();
        if (deadlineExpired) throw timeoutError();
        throw toWebBoundaryError(cause, "transport_failure");
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await cancelBody(
          response.body,
          "following validated redirect",
          controller.signal,
          deadlineAt,
        );
        if (redirectCount >= maxRedirects) {
          throw new WebBoundaryError(
            "too_many_redirects",
            "web fetch exceeded redirect limit",
            false,
          );
        }
        const location = response.headers.get("location");
        if (location === null) {
          throw new WebBoundaryError(
            "redirect_without_location",
            "web redirect did not include a location",
            false,
          );
        }
        try {
          currentUrl = canonicalizeWebUrl(new URL(location, currentUrl).href);
        } catch (cause) {
          throw new WebBoundaryError("invalid_url", "web redirect URL is invalid", false, cause);
        }
        continue;
      }

      if (!response.ok) {
        await cancelBody(response.body, "non-success response", controller.signal, deadlineAt);
        throw new WebBoundaryError(
          "transport_failure",
          `web fetch returned HTTP ${response.status}`,
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      }
      const mediaType = mediaTypeOf(response);
      if (!supportedMediaTypes.has(mediaType)) {
        await cancelBody(response.body, "unsupported content type", controller.signal, deadlineAt);
        throw new WebBoundaryError(
          "unsupported_content_type",
          "web response content type is not supported",
          false,
        );
      }

      const body = await readCappedBody(response, maxBytes, controller.signal, deadlineAt);
      responseBytes = body.byteCount;
      const canonicalUrl = canonicalizeWebUrl(currentUrl);
      const finalHost = new URL(canonicalUrl).hostname;
      assertDomainAllowed(finalHost, accepted.allowedDomains);
      let title = finalHost;
      let publishedAt: string | undefined;
      let text: string;
      if (mediaType === "application/pdf") {
        try {
          const pages = await extractPdfPagesIsolated(body.bytes);
          text = pages
            .map((page) => page.text)
            .join("\n\n")
            .normalize("NFC")
            .trim();
        } catch (cause) {
          throw new WebBoundaryError(
            "pdf_extraction_failed",
            "web PDF text extraction failed",
            false,
            cause,
          );
        }
      } else {
        let raw: string;
        try {
          // Page bytes are evidence. Replacement decoding would turn a
          // malformed response into apparently valid quotation text, so the
          // boundary rejects invalid UTF-8 before title/text extraction.
          raw = new TextDecoder("utf-8", { fatal: true }).decode(body.bytes);
        } catch (cause) {
          throw new WebBoundaryError(
            "invalid_response_encoding",
            "web response body is not valid UTF-8",
            false,
            cause,
          );
        }
        const isHtml = mediaType === "text/html" || mediaType === "application/xhtml+xml";
        title = isHtml ? (extractHtmlTitle(raw) ?? finalHost) : finalHost;
        publishedAt = isHtml ? extractHtmlPublishedAt(raw)?.toISOString() : undefined;
        text = isHtml ? stripHtml(raw) : raw.normalize("NFC").trim();
      }
      throwIfAborted(options.signal);
      return {
        canonicalUrl,
        title,
        domain: finalHost,
        ...(publishedAt === undefined ? {} : { publishedAt }),
        mediaType,
        text,
        capturedAt: (options.now ?? (() => new Date()))().toISOString(),
        operation: {
          kind: "fetch",
          provider: "brief_fetch",
          outcome: text === "" ? "empty" : "succeeded",
          resultCount: text === "" ? 0 : 1,
          responseBytes,
          durationMs: Math.max(0, Date.now() - startedAt),
        },
      };
    }
  } catch (error) {
    if (options.signal?.aborted) throw taskAbortError();
    const boundaryError = deadlineExpired
      ? timeoutError()
      : toWebBoundaryError(error, "transport_failure");
    throw withFailureAccounting(boundaryError, [
      operationFailure(startedAt, boundaryError, responseBytes),
    ]);
  } finally {
    clearTimeout(deadline);
    removeTaskAbortForwarder();
  }
};
