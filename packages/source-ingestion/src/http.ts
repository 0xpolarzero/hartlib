import { SourceIngestionError } from "./types";
import type { Fetcher, FetchResponse, PublicSourceId } from "./types";

/**
 * Public-source transport bodies are intentionally bounded before they are
 * decoded or handed to a connector parser.  This is a code-owned security
 * ceiling; changing it requires updating the public-source boundary tests.
 */
export const PUBLIC_SOURCE_HTTP_TIMEOUT_MS = 30_000;
export const PUBLIC_SOURCE_TEXT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Body cancellation is part of the request lifecycle.  A broken custom
 * transport must not be able to keep an ingestion task alive forever, but we
 * still give a well-behaved stream time to finish its rejection-safe cleanup.
 */
export const PUBLIC_SOURCE_HTTP_CLEANUP_TIMEOUT_MS = 1_000;

const awaitBounded = async (operation: Promise<void>, timeoutMs: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const contentLength = (response: FetchResponse): number | undefined => {
  const value = response.headers.get("content-length");
  if (value === null) return undefined;
  // Content-Length is an exact decimal byte count.  parseInt("10garbage")
  // would otherwise silently turn malformed framing into an in-limit body.
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) {
    throw new SourceIngestionError("Public-source response has an invalid content length");
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SourceIngestionError("Public-source response has an invalid content length");
  }
  return parsed;
};

export const cancelPublicSourceResponseBody = async (
  response: FetchResponse,
  reason: unknown,
): Promise<void> => {
  const stream = response.body;
  if (!stream) return;
  await awaitBounded(
    Promise.resolve()
      .then(() => stream.cancel(reason))
      .then(() => undefined),
    PUBLIC_SOURCE_HTTP_CLEANUP_TIMEOUT_MS,
  );
};

const toBytes = (value: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
};

const readBoundedBytes = async (
  response: FetchResponse,
  sourceId: PublicSourceId,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  let declaredLength: number | undefined;
  try {
    declaredLength = contentLength(response);
  } catch (error) {
    await cancelPublicSourceResponseBody(response, error);
    throw error;
  }
  if (declaredLength !== undefined && declaredLength > maximumBytes) {
    await cancelPublicSourceResponseBody(response, "public-source declared body limit exceeded");
    throw new SourceIngestionError("Public-source response body exceeds its byte limit", {
      sourceId,
    });
  }

  const stream = response.body;
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let aborted = signal?.aborted ?? false;
    let cancellation: Promise<void> | undefined;
    const ensureCancelled = (reason: unknown): Promise<void> => {
      cancellation ??= awaitBounded(
        Promise.resolve()
          .then(() => reader.cancel(reason))
          .then(() => undefined),
        PUBLIC_SOURCE_HTTP_CLEANUP_TIMEOUT_MS,
      );
      return cancellation;
    };
    const onAbort = () => {
      aborted = true;
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        if (aborted) {
          throw new SourceIngestionError("Public-source response body read was aborted", {
            sourceId,
          });
        }
        const result = await new Promise<Awaited<ReturnType<typeof reader.read>>>(
          (resolve, reject) => {
            let onReadAbort: (() => void) | undefined;
            const cleanupRead = () => {
              if (signal !== undefined && onReadAbort !== undefined) {
                signal.removeEventListener("abort", onReadAbort);
              }
            };
            onReadAbort = () => {
              aborted = true;
              cleanupRead();
              reject(
                new SourceIngestionError("Public-source response body read was aborted", {
                  sourceId,
                }),
              );
            };
            if (signal?.aborted) {
              onReadAbort();
              return;
            }
            signal?.addEventListener("abort", onReadAbort, { once: true });
            void reader.read().then(
              (readResult) => {
                cleanupRead();
                resolve(readResult);
              },
              (cause: unknown) => {
                cleanupRead();
                reject(cause);
              },
            );
          },
        );
        if (aborted) {
          throw new SourceIngestionError("Public-source response body read was aborted", {
            sourceId,
          });
        }
        if (result.done) break;
        const chunk = toBytes(result.value);
        total += chunk.byteLength;
        if (total > maximumBytes) {
          await ensureCancelled("public-source body limit exceeded");
          throw new SourceIngestionError("Public-source response body exceeds its byte limit", {
            sourceId,
          });
        }
        chunks.push(chunk.slice());
      }
    } catch (error) {
      await ensureCancelled(error);
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  throw new SourceIngestionError(
    "Public-source response body cannot be safely bounded without a stream",
    { sourceId },
  );
};

export const readPublicSourceBytes = (
  response: FetchResponse,
  sourceId: PublicSourceId,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> => readBoundedBytes(response, sourceId, maximumBytes, signal);

export const readPublicSourceText = async (
  response: FetchResponse,
  sourceId: PublicSourceId,
  signal?: AbortSignal,
): Promise<string> => {
  const bytes = await readBoundedBytes(response, sourceId, PUBLIC_SOURCE_TEXT_MAX_BYTES, signal);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};

export const withPublicSourceHttpDeadline = async <A>(
  sourceId: PublicSourceId,
  operation: (signal: AbortSignal) => Promise<A>,
  timeoutMs = PUBLIC_SOURCE_HTTP_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<A> => {
  const controller = new AbortController();
  let timedOut = false;
  let operationPromise: Promise<A>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline: ((error: unknown) => void) | undefined;
  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason);
    rejectDeadline?.(
      new SourceIngestionError("Public-source HTTP request was aborted", {
        sourceId,
        cause: externalSignal?.reason,
      }),
    );
  };
  operationPromise = Promise.resolve().then(() => operation(controller.signal));
  const timeout = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort("public-source HTTP deadline exceeded");
      reject(
        new SourceIngestionError(`Public-source HTTP request timed out after ${timeoutMs}ms`, {
          sourceId,
        }),
      );
    }, timeoutMs);
  });
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    return await Promise.race([operationPromise, timeout]);
  } catch (error) {
    if (timedOut) {
      throw new SourceIngestionError(`Public-source HTTP request timed out after ${timeoutMs}ms`, {
        sourceId,
        cause: error,
      });
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    // Promise.race settles at the boundary deadline, but the operation may
    // still be unwinding an aborted body reader.  Await its rejection-safe
    // cleanup (with a bounded grace period) before returning to the caller;
    // this prevents a late parser/transport continuation from overlapping a
    // retry or producing an unhandled rejection.
    if (controller.signal.aborted) {
      await awaitBounded(
        operationPromise.then(
          () => undefined,
          () => undefined,
        ),
        Math.max(timeoutMs, PUBLIC_SOURCE_HTTP_CLEANUP_TIMEOUT_MS),
      );
    }
  }
};

export const fetchPublicSourceText = async (
  fetcher: Fetcher,
  sourceId: PublicSourceId,
  url: string,
  init?: RequestInit,
): Promise<{ readonly response: FetchResponse; readonly body: string | undefined }> =>
  withPublicSourceHttpDeadline(
    sourceId,
    async (signal) => {
      const response = await fetcher(url, { ...init, signal });
      if (response.status === 304) {
        // Some transports expose a non-null body even for 304.  Awaiting
        // cancellation keeps the shared deadline/body lifecycle complete and
        // prevents a rejected cancel promise from becoming an unhandled
        // rejection.
        await cancelPublicSourceResponseBody(response, "public-source not modified");
        return { response, body: undefined };
      }
      if (!response.ok) {
        // Status classification is intentionally before body consumption. A
        // rejected response is not evidence and may be arbitrarily large.
        await cancelPublicSourceResponseBody(response, "public-source response rejected");
        return { response, body: undefined };
      }
      const body = await readPublicSourceText(response, sourceId, signal);
      return { response, body };
    },
    PUBLIC_SOURCE_HTTP_TIMEOUT_MS,
    init?.signal ?? undefined,
  );
