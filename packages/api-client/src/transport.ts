import {
  HttpErrorResponse,
  httpRouteContracts,
  type HttpRouteContract,
  type HttpSuccessContract,
} from "@hartlib/shared";
import { Schema } from "effect";

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ApiErrorBody = Schema.Schema.Type<typeof HttpErrorResponse>;

export class ApiResponseError extends Error {
  readonly name = "ApiResponseError";

  constructor(
    readonly status: number,
    readonly code: string,
    readonly body?: ApiErrorBody | undefined,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

export interface ApiTransportOptions {
  readonly fetch: Fetch;
  readonly baseUrl?: string | URL | undefined;
}

export interface ContractRequestOptions {
  readonly json?: unknown;
  readonly headers?: HeadersInit | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly redirect?: RequestRedirect | undefined;
  readonly referrerPolicy?: ReferrerPolicy | undefined;
}

/** Maximum decoded response body retained by any textual route boundary. */
export const API_TEXT_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
/** Keep response cleanup bounded even when a custom stream rejects or hangs. */
const API_RESPONSE_CLEANUP_TIMEOUT_MS = 1_000;

const awaitCancellationBounded = async (cancellation: Promise<void>): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cancellation.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, API_RESPONSE_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const cancelBody = async (
  body: ReadableStream<Uint8Array> | null,
  reason: unknown,
): Promise<void> => {
  if (body === null) return;
  await awaitCancellationBounded(
    Promise.resolve()
      .then(() => body.cancel(reason))
      .then(() => undefined),
  );
};

const strictDecode = <A, I>(schema: Schema.Codec<A, I, never, never>, value: unknown): A =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

const mediaType = (response: Response): string | null => {
  const value = response.headers.get("content-type");
  return value === null ? null : (value.split(";", 1)[0]?.trim().toLowerCase() ?? null);
};

const responseContractError = (response: Response, code: string, cause?: unknown): never => {
  throw new ApiResponseError(response.status, code, undefined, { cause });
};

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The operation was aborted", "AbortError");

const readResponseBytes = async (
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  const declaredHeader = response.headers.get("content-length");
  let declaredLength: number | undefined;
  if (declaredHeader !== null) {
    const normalized = declaredHeader.trim();
    if (!/^\d+$/u.test(normalized)) {
      await cancelBody(response.body, "invalid response content length");
      throw new ApiResponseError(response.status, "invalid_response_body");
    }
    declaredLength = Number(normalized);
    if (!Number.isSafeInteger(declaredLength)) {
      await cancelBody(response.body, "invalid response content length");
      throw new ApiResponseError(response.status, "invalid_response_body");
    }
  }
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    await cancelBody(response.body, "response body byte limit exceeded");
    throw new ApiResponseError(response.status, "invalid_response_body");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  let cancellation: Promise<void> | undefined;
  const ensureCancelled = (reason: unknown): Promise<void> => {
    cancellation ??= awaitCancellationBounded(
      Promise.resolve()
        .then(() => reader.cancel(reason))
        .then(() => undefined),
    );
    return cancellation;
  };
  try {
    while (true) {
      const next = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        let onAbort: (() => void) | undefined;
        const cleanup = () => {
          if (signal !== undefined && onAbort !== undefined) {
            signal.removeEventListener("abort", onAbort);
          }
        };
        onAbort = () => {
          cleanup();
          reject(abortReason(signal!));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        void reader.read().then(
          (result) => {
            cleanup();
            resolve(result);
          },
          (cause) => {
            cleanup();
            reject(cause);
          },
        );
      });
      if (signal?.aborted) {
        await ensureCancelled(abortReason(signal));
        throw abortReason(signal);
      }
      if (next.done) break;
      const chunk = new Uint8Array(next.value);
      byteCount += chunk.byteLength;
      if (byteCount > maxBytes) {
        await ensureCancelled("response body byte limit exceeded");
        throw new ApiResponseError(response.status, "invalid_response_body");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    // Cancellation is best effort but part of this boundary's lifecycle. It
    // is awaited (and its rejection is contained) before releasing the
    // reader, so no late stream rejection escapes as an unhandled promise.
    await ensureCancelled(signal?.aborted ? abortReason(signal) : error);
    if (signal?.aborted) throw abortReason(signal);
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

const readResponseText = async (response: Response, signal?: AbortSignal): Promise<string> => {
  const bytes = await readResponseBytes(response, API_TEXT_RESPONSE_MAX_BYTES, signal);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new ApiResponseError(response.status, "invalid_response_body", undefined, { cause });
  }
};

const routeContract = (key: string): HttpRouteContract => {
  const contract = httpRouteContracts[key];
  if (contract === undefined) throw new Error(`unknown HTTP route contract: ${key}`);
  return contract;
};

const requestMethod = (key: string): string => {
  const boundary = key.indexOf(" ");
  if (boundary <= 0) throw new Error(`invalid HTTP route contract key: ${key}`);
  return key.slice(0, boundary);
};

const targetFor = (path: string, baseUrl: string | URL | undefined): string | URL =>
  baseUrl === undefined || baseUrl === "" ? path : new URL(path, baseUrl);

const parsedUrl = (path: string): URL => new URL(path, "http://hartlib.invalid");

const validateQuery = (contract: HttpRouteContract, path: string): void => {
  const entries = [...parsedUrl(path).searchParams.entries()];
  const query: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key in query) throw new ApiResponseError(0, "invalid_request_query");
    query[key] = value;
  }
  if (contract.query === undefined) {
    if (entries.length !== 0) throw new ApiResponseError(0, "invalid_request_query");
    return;
  }
  try {
    strictDecode(contract.query, query);
  } catch (cause) {
    throw new ApiResponseError(0, "invalid_request_query", undefined, { cause });
  }
};

const validateContractHeaders = (contract: HttpRouteContract, headers: Headers): void => {
  if (contract.headers === undefined) return;
  const selected = Object.fromEntries(
    contract.headers.names.flatMap((name) => {
      const value = headers.get(name);
      return value === null ? [] : [[name, value] as const];
    }),
  );
  try {
    strictDecode(contract.headers.schema, selected);
  } catch (cause) {
    throw new ApiResponseError(0, "invalid_request_headers", undefined, { cause });
  }
};

const prepareRequest = (
  contract: HttpRouteContract,
  options: ContractRequestOptions,
): { readonly headers: Headers; readonly body?: BodyInit | null } => {
  const headers = new Headers(options.headers);
  const requestBody = contract.requestBody;
  if (requestBody.kind === "none" || requestBody.kind === "empty") {
    if (options.json !== undefined) {
      throw new ApiResponseError(0, "unexpected_request_body");
    }
    validateContractHeaders(contract, headers);
    return { headers };
  }
  if (requestBody.kind === "json") {
    if (options.json === undefined) {
      throw new ApiResponseError(0, "invalid_request_body");
    }
    let decoded: unknown;
    try {
      decoded = strictDecode(requestBody.schema, options.json);
    } catch (cause) {
      throw new ApiResponseError(0, "invalid_request_body", undefined, { cause });
    }
    headers.set("content-type", "application/json");
    validateContractHeaders(contract, headers);
    const body = JSON.stringify(decoded);
    if (body === undefined) throw new ApiResponseError(0, "invalid_request_body");
    if (new TextEncoder().encode(body).byteLength > requestBody.maxBytes) {
      throw new ApiResponseError(0, "request_body_too_large");
    }
    return { headers, body };
  }
  throw new ApiResponseError(0, "invalid_request_body");
};

const decodeError = async (
  response: Response,
  contract: HttpRouteContract,
  signal?: AbortSignal,
): Promise<never> => {
  let body: ApiErrorBody | undefined;
  if (mediaType(response) === "application/json") {
    try {
      if (contract.error !== HttpErrorResponse) throw new Error("non-canonical HTTP error schema");
      body = strictDecode(HttpErrorResponse, JSON.parse(await readResponseText(response, signal)));
    } catch (cause) {
      // Error responses are a strict wire boundary. Malformed bytes, JSON,
      // or schema are all response-body failures; never infer an error code
      // from the HTTP status when the server sent an invalid body.
      if (signal?.aborted) throw cause;
      if (cause instanceof ApiResponseError) throw cause;
      throw new ApiResponseError(response.status, "invalid_response_body", undefined, { cause });
    }
  }
  const code =
    body === undefined ? `request_${response.status}` : "code" in body ? body.code : body.error;
  throw new ApiResponseError(response.status, code, body);
};

const selectSuccess = (
  response: Response,
  contract: HttpRouteContract,
): HttpSuccessContract | undefined =>
  contract.success.find((candidate) => candidate.statuses.includes(response.status));

const withAccept = (
  options: ContractRequestOptions | undefined,
  accept: string,
): ContractRequestOptions => {
  const headers = new Headers(options?.headers);
  if (!headers.has("accept")) headers.set("accept", accept);
  return { ...options, headers };
};

export interface ApiTransport {
  readonly json: <A, I>(
    route: string,
    path: string,
    schema: Schema.Codec<A, I, never, never>,
    options?: ContractRequestOptions,
  ) => Promise<A>;
  readonly empty: (route: string, path: string, options?: ContractRequestOptions) => Promise<void>;
  readonly sse: (
    route: string,
    path: string,
    options?: ContractRequestOptions,
  ) => Promise<Response>;
  readonly binary: (
    route: string,
    path: string,
    options?: ContractRequestOptions,
  ) => Promise<Response>;
  readonly redirectedBinary: (
    route: string,
    path: string,
    mediaTypes: readonly string[],
    options?: ContractRequestOptions,
  ) => Promise<Response>;
}

export const createApiTransport = ({ fetch, baseUrl }: ApiTransportOptions): ApiTransport => {
  const fetchResponse = async (
    route: string,
    path: string,
    options: ContractRequestOptions,
  ): Promise<{ readonly response: Response; readonly contract: HttpRouteContract }> => {
    const contract = routeContract(route);
    validateQuery(contract, path);
    const prepared = prepareRequest(contract, options);
    const response = await fetch(targetFor(path, baseUrl), {
      method: requestMethod(route),
      headers: prepared.headers,
      ...(prepared.body === undefined ? {} : { body: prepared.body }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.redirect === undefined ? {} : { redirect: options.redirect }),
      ...(options.referrerPolicy === undefined ? {} : { referrerPolicy: options.referrerPolicy }),
    });
    return { response, contract };
  };

  const perform = async (
    route: string,
    path: string,
    options: ContractRequestOptions = {},
  ): Promise<{ readonly response: Response; readonly success: HttpSuccessContract }> => {
    const { response, contract } = await fetchResponse(route, path, options);
    const success = selectSuccess(response, contract);
    if (success === undefined) return decodeError(response, contract, options.signal);
    return { response, success };
  };

  return {
    json: async (route, path, schema, options) => {
      const { response, success } = await perform(
        route,
        path,
        withAccept(options, "application/json"),
      );
      if (success.kind !== "json" || success.schema !== schema) {
        responseContractError(response, "invalid_response_contract");
      }
      if (mediaType(response) !== "application/json") {
        responseContractError(response, "invalid_response_media_type");
      }
      let value: unknown;
      try {
        value = JSON.parse(await readResponseText(response, options?.signal)) as unknown;
      } catch (cause) {
        if (options?.signal?.aborted) throw cause;
        return responseContractError(response, "invalid_response_body", cause);
      }
      try {
        return strictDecode(schema, value);
      } catch (cause) {
        return responseContractError(response, "invalid_response_body", cause);
      }
    },
    empty: async (route, path, options) => {
      const { response, success } = await perform(route, path, options);
      if (success.kind !== "empty") responseContractError(response, "invalid_response_contract");
      if (mediaType(response) !== null) {
        responseContractError(response, "invalid_response_media_type");
      }
      if ((await readResponseText(response, options?.signal)) !== "") {
        responseContractError(response, "invalid_response_body");
      }
    },
    sse: async (route, path, options) => {
      const { response, success } = await perform(
        route,
        path,
        withAccept(options, "text/event-stream"),
      );
      if (success.kind !== "sse") responseContractError(response, "invalid_response_contract");
      if (mediaType(response) !== "text/event-stream" || response.body === null) {
        responseContractError(response, "invalid_response_media_type");
      }
      return response;
    },
    binary: async (route, path, options) => {
      const { response, success } = await perform(route, path, options);
      if (success.kind !== "binary") {
        return responseContractError(response, "invalid_response_contract");
      }
      const type = mediaType(response);
      if (type === null || !success.mediaTypes.includes(type)) {
        responseContractError(response, "invalid_response_media_type");
      }
      if (response.body === null) responseContractError(response, "invalid_response_body");
      return response;
    },
    // Browser Fetch exposes only the final response after an authenticated
    // redirect. Require the canonical route to declare a redirect, then gate
    // that observable final response to one exact 200 media contract.
    redirectedBinary: async (route, path, mediaTypes, options) => {
      const contract = routeContract(route);
      if (!contract.success.some((success) => success.kind === "redirect")) {
        throw new Error(`route does not declare redirect success: ${route}`);
      }
      const { response } = await fetchResponse(
        route,
        path,
        withAccept(options, mediaTypes.join(", ")),
      );
      if (!response.redirected || response.status !== 200) {
        const direct = selectSuccess(response, contract);
        if (direct === undefined) return decodeError(response, contract, options?.signal);
        return responseContractError(response, "invalid_response_status");
      }
      const type = mediaType(response);
      if (type === null || !mediaTypes.includes(type)) {
        return responseContractError(response, "invalid_response_media_type");
      }
      if (response.body === null) return responseContractError(response, "invalid_response_body");
      return response;
    },
  };
};
