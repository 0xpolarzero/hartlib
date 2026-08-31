import { Cause, Context, Effect, Schema } from "effect";
import { httpRouteContract, type HttpRouteContract } from "@hartlib/shared";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { HttpMethod } from "effect/unstable/http/HttpMethod";

import { withCanonicalAuditRequestId } from "./domain/administrative-audit";
import { decodePathParameters, type DecodedPathParameters } from "./domain/path-parameter-policy";
import { JsonLoggerLayer } from "./logging";
import { loadApiConfig } from "./config";
import { captureApiOperationalError } from "./telemetry";

export type RouteHandler = (
  request: Request,
  url: URL,
  pathParameters: DecodedPathParameters,
  input: DecodedRouteInput,
) => Effect.Effect<Response, unknown>;

export interface DecodedRouteInput {
  readonly body?: unknown;
  readonly bodyBytes?: Uint8Array;
  readonly declaredBodyBytes?: number;
  readonly query: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, unknown>>;
}

/**
 * A production endpoint registered with Effect HTTP.
 *
 * Paths use Effect HTTP's find-my-way syntax (`:param` for one segment). The
 * Registration is exact and case-sensitive. Uppercase and trailing-slash
 * aliases are not part of the canonical API surface.
 */
export interface Route {
  readonly method: Exclude<HttpMethod, "HEAD" | "OPTIONS" | "TRACE" | "CONNECT">;
  readonly path: `/${string}`;
  readonly execute: RouteHandler;
  /** Hosted authenticated content must never emit wildcard CORS. */
  readonly corsPolicy?: "explicit-origin";
  /** Explicit contract for non-production harness routes; production routes use the shared matrix. */
  readonly contract?: HttpRouteContract;
  readonly administrativeAudit?: (
    request: Request,
    response: Response,
    pathParameters: DecodedPathParameters,
    input: DecodedRouteInput | null,
  ) => Effect.Effect<void, unknown>;
}

export const json = (body: unknown, init?: ResponseInit): Response => {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
};

/** Encode a public JSON response only after its shared Effect Schema accepts it. */
export const jsonFromSchema = <A, I>(
  schema: Schema.Codec<A, I, never, never>,
  body: unknown,
  init?: ResponseInit,
): Response => json(Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(body), init);

export const corsHeaders = (init?: HeadersInit): Headers => new Headers(init);

const notFound = (): Response =>
  json(
    {
      error: "not_found",
    },
    { status: 404 },
  );

const methodNotAllowed = (): Response =>
  json(
    {
      error: "method_not_allowed",
    },
    { status: 405 },
  );

const configuredCorsOrigins = loadApiConfig.pipe(
  Effect.map((config) => config.corsAllowedOrigins),
  Effect.orDie,
);

const applyCors = (request: Request, response: Response) =>
  Effect.gen(function* () {
    const configured = yield* configuredCorsOrigins;
    const origin = request.headers.get("origin");
    response.headers.delete("access-control-allow-origin");
    if (origin === null) return response;
    if (configured.includes(origin)) {
      response.headers.set("access-control-allow-origin", origin);
      response.headers.set("access-control-allow-credentials", "true");
      response.headers.append("vary", "Origin");
    }
    return response;
  });

const preflight = (request: Request, methods: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const configured = yield* configuredCorsOrigins;
    const origin = request.headers.get("origin");
    const allowed = origin !== null && configured.includes(origin);
    const headers = new Headers();
    if (origin !== null && allowed) {
      headers.set("access-control-allow-origin", origin);
      headers.set("access-control-allow-credentials", "true");
      headers.append("vary", "Origin");
    }
    headers.set("access-control-allow-methods", [...new Set(methods)].join(", "));
    headers.set("access-control-allow-headers", "content-type, last-event-id, x-request-id");
    headers.set("access-control-max-age", "86400");

    return new Response(null, {
      status: allowed ? 204 : 403,
      headers,
    });
  });

const webRequest = (request: HttpServerRequest.HttpServerRequest): Request => {
  if (!(request.source instanceof Request)) {
    throw new Error("Effect HTTP request did not originate from the Fetch boundary");
  }
  return request.source;
};

const isCause = (value: unknown): value is Cause.Cause<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "reasons" in value &&
  Array.isArray((value as { readonly reasons?: unknown }).reasons);

const operationalFailure = (request: Request, cause?: unknown) =>
  Effect.gen(function* () {
    // A disconnected client cannot receive an error body. Returning an empty
    // local response avoids writing to the aborted Bun socket while keeping
    // the failure boundary fail-closed.
    if (request.signal.aborted || (isCause(cause) && Cause.hasInterruptsOnly(cause))) {
      return new Response(null, { status: 499 });
    }

    captureApiOperationalError("request_failed", {
      method: request.method,
    });
    yield* Effect.logError("request failed").pipe(
      Effect.annotateLogs({
        errorCode: "request_failed",
      }),
    );

    return yield* applyCors(
      request,
      json(
        {
          error: "internal_error",
        },
        { status: 500 },
      ),
    );
  });

const mediaType = (headers: Headers): string | null =>
  headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;

const declaredBodyIsWithin = (request: Request, maxBytes: number): boolean => {
  const header = request.headers.get("content-length");
  if (header === null) return true;
  const declared = Number(header);
  return Number.isInteger(declared) && declared >= 0 && declared <= maxBytes;
};

type RequestContractResult =
  | { readonly ok: true; readonly input: DecodedRouteInput }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid"
        | "tooLarge"
        | "unsupportedMediaType"
        | "invalidQuery"
        | "invalidHeaders";
    };

const cancelRequestBody = (request: Request): void => {
  if (request.body !== null && !request.body.locked) void request.body.cancel();
};

/**
 * Read at most maxBytes from a cloned request. Adapters consume only decoded
 * input, so the original tee branch is cancelled on every completion path.
 */
const readBodyBounded = async (request: Request, maxBytes: number): Promise<Uint8Array | null> => {
  const clone = request.clone();
  if (clone.body === null) {
    cancelRequestBody(request);
    return new Uint8Array();
  }
  const reader = clone.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        completed = true;
        break;
      }
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        void reader.cancel("request_body_too_large").catch(() => undefined);
        return null;
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    if (!completed) void reader.cancel("request_body_capture_ended").catch(() => undefined);
    cancelRequestBody(request);
  }
};

const declaredBodyBytes = (request: Request): number | undefined => {
  const value = request.headers.get("content-length");
  return value === null ? undefined : Number(value);
};

const requestSatisfiesContract = (
  request: Request,
  contract: HttpRouteContract,
): Effect.Effect<RequestContractResult> =>
  Effect.tryPromise({
    try: async () => {
      const url = new URL(request.url);
      const queryRecord: Record<string, string> = {};
      for (const key of new Set(url.searchParams.keys())) {
        const values = url.searchParams.getAll(key);
        if (values.length !== 1) {
          cancelRequestBody(request);
          return { ok: false, reason: "invalidQuery" } as const;
        }
        queryRecord[key] = values[0]!;
      }
      let decodedQuery: unknown = {};
      if (contract.query === undefined) {
        if (Object.keys(queryRecord).length > 0) {
          cancelRequestBody(request);
          return { ok: false, reason: "invalidQuery" } as const;
        }
      } else {
        try {
          decodedQuery = Schema.decodeUnknownSync(contract.query, {
            onExcessProperty: "error",
          })(queryRecord);
        } catch {
          cancelRequestBody(request);
          return { ok: false, reason: "invalidQuery" } as const;
        }
      }

      const headerRecord: Record<string, string> = {};
      let decodedHeaders: unknown = {};
      if (contract.headers !== undefined) {
        for (const name of contract.headers.names) {
          const value = request.headers.get(name);
          if (value !== null) headerRecord[name] = value;
        }
        try {
          decodedHeaders = Schema.decodeUnknownSync(contract.headers.schema, {
            onExcessProperty: "error",
          })(headerRecord);
        } catch {
          cancelRequestBody(request);
          return { ok: false, reason: "invalidHeaders" } as const;
        }
      }

      const baseInput = {
        query: decodedQuery as Readonly<Record<string, unknown>>,
        headers: decodedHeaders as Readonly<Record<string, unknown>>,
      };
      const body = contract.requestBody;
      if (body.kind === "none") {
        if (!declaredBodyIsWithin(request, 0)) {
          cancelRequestBody(request);
          return { ok: false, reason: "invalid" } as const;
        }
        const bytes = await readBodyBounded(request, 0);
        return bytes === null
          ? ({ ok: false, reason: "invalid" } as const)
          : ({ ok: true, input: baseInput } as const);
      }
      if (!declaredBodyIsWithin(request, body.kind === "empty" ? 0 : body.maxBytes)) {
        cancelRequestBody(request);
        return { ok: false, reason: "tooLarge" } as const;
      }
      const maxBytes = body.kind === "empty" ? 0 : body.maxBytes;
      const bytes = await readBodyBounded(request, maxBytes);
      if (bytes === null) return { ok: false, reason: "tooLarge" } as const;
      const declared = declaredBodyBytes(request);
      if (declared !== undefined && declared !== bytes.byteLength) {
        cancelRequestBody(request);
        return { ok: false, reason: "invalid" } as const;
      }
      if (body.kind === "empty") {
        return {
          ok: true,
          input: {
            ...baseInput,
            bodyBytes: bytes,
            ...(declared === undefined ? {} : { declaredBodyBytes: declared }),
          },
        } as const;
      }
      if (mediaType(request.headers) !== "application/json") {
        cancelRequestBody(request);
        return { ok: false, reason: "unsupportedMediaType" } as const;
      }
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      const decodedBody = Schema.decodeUnknownSync(body.schema, {
        onExcessProperty: "error",
      })(parsed);
      return {
        ok: true,
        input: {
          ...baseInput,
          body: decodedBody,
          bodyBytes: bytes,
          ...(declared === undefined ? {} : { declaredBodyBytes: declared }),
        },
      } as const;
    },
    catch: () => ({ ok: false, reason: "invalid" }) as const,
  }).pipe(Effect.catch(() => Effect.succeed({ ok: false, reason: "invalid" } as const)));

const responseSatisfiesContract = (
  response: Response,
  contract: HttpRouteContract,
): Effect.Effect<boolean> =>
  Effect.tryPromise({
    try: async () => {
      const responseMediaType = mediaType(response.headers);
      if (response.status >= 400) {
        if (responseMediaType !== "application/json") return false;
        const parsed = (await response.clone().json()) as unknown;
        Schema.decodeUnknownSync(contract.error, { onExcessProperty: "error" })(parsed);
        return true;
      }
      for (const success of contract.success) {
        if (!success.statuses.includes(response.status)) continue;
        if (success.kind === "json" && responseMediaType === "application/json") {
          const parsed = (await response.clone().json()) as unknown;
          try {
            Schema.decodeUnknownSync(success.schema, { onExcessProperty: "error" })(parsed);
            return true;
          } catch {
            continue;
          }
        }
        if (
          success.kind === "empty" &&
          responseMediaType === null &&
          (await response.clone().arrayBuffer()).byteLength === 0
        ) {
          return true;
        }
        if (success.kind === "sse" && responseMediaType === "text/event-stream") return true;
        if (
          success.kind === "redirect" &&
          response.status >= 300 &&
          response.status < 400 &&
          response.headers.has("location") &&
          responseMediaType === null &&
          (await response.clone().arrayBuffer()).byteLength === 0
        ) {
          return true;
        }
        if (
          success.kind === "binary" &&
          responseMediaType !== null &&
          success.mediaTypes.includes(responseMediaType)
        ) {
          return true;
        }
      }
      return false;
    },
    catch: () => false,
  }).pipe(Effect.catch(() => Effect.succeed(false)));

const effectRoute = (route: Route): HttpRouter.Route<never, never> =>
  HttpRouter.route(route.method, route.path, (effectRequest) =>
    Effect.gen(function* () {
      const web = webRequest(effectRequest);
      const pathParameters = decodePathParameters(route, yield* HttpRouter.params);
      if (pathParameters === null) return HttpServerResponse.fromWeb(notFound());
      const request = withCanonicalAuditRequestId(route, web);
      const contract = route.contract ?? httpRouteContract(route.method, route.path);
      if (contract === undefined) {
        return HttpServerResponse.fromWeb(yield* operationalFailure(request));
      }
      const requestValidation = yield* requestSatisfiesContract(request, contract);
      return yield* Effect.gen(function* () {
        const response = requestValidation.ok
          ? yield* route.execute(
              request,
              new URL(request.url),
              pathParameters,
              requestValidation.input,
            )
          : json(
              contract.requestRejections?.[requestValidation.reason].body ?? {
                code: "invalid_body",
              },
              {
                status: contract.requestRejections?.[requestValidation.reason].status ?? 400,
              },
            );
        if (!(yield* responseSatisfiesContract(response, contract))) {
          return yield* Effect.fail(new Error("response_contract_violation"));
        }
        return response;
      }).pipe(
        Effect.catchCause((cause) => operationalFailure(request, cause)),
        Effect.tap(
          (response) =>
            route.administrativeAudit?.(
              request,
              response,
              pathParameters,
              requestValidation.ok ? requestValidation.input : null,
            ) ?? Effect.void,
        ),
        Effect.flatMap((response) => applyCors(request, response)),
        Effect.catchCause((cause) => operationalFailure(request, cause)),
        Effect.map(HttpServerResponse.fromWeb),
        Effect.provide(JsonLoggerLayer),
      );
    }),
  );

const routesLayer = (routes: ReadonlyArray<Route>) => {
  const httpMethods: ReadonlyArray<HttpMethod> = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
    "TRACE",
  ];
  const methodsByPath = new Map<string, { readonly methods: string[]; readonly route: Route }>();
  for (const route of routes) {
    const current = methodsByPath.get(route.path) ?? { methods: [], route };
    current.methods.push(route.method);
    methodsByPath.set(route.path, current);
  }

  const registered = routes.map(effectRoute);
  const boundaries = [...methodsByPath].flatMap(([path, { methods, route }]) => {
    const methodSet = new Set(methods);
    return [
      HttpRouter.route("OPTIONS", path as `/${string}`, (effectRequest) =>
        Effect.gen(function* () {
          const valid = decodePathParameters(route, yield* HttpRouter.params) !== null;
          return yield* valid
            ? preflight(webRequest(effectRequest), methods)
            : Effect.succeed(notFound());
        }).pipe(Effect.map(HttpServerResponse.fromWeb), Effect.provide(JsonLoggerLayer)),
      ),
      ...httpMethods
        .filter((method) => method !== "OPTIONS" && !methodSet.has(method))
        .map((method) =>
          HttpRouter.route(method, path as `/${string}`, (_effectRequest) =>
            Effect.map(HttpRouter.params, (captured) =>
              HttpServerResponse.fromWeb(
                decodePathParameters(route, captured) === null ? notFound() : methodNotAllowed(),
              ),
            ),
          ),
        ),
    ];
  });

  return HttpRouter.addAll([
    ...registered,
    ...boundaries,
    HttpRouter.route("*", "*", () => Effect.succeed(HttpServerResponse.fromWeb(notFound()))),
  ]);
};

export interface ApiWebHandler {
  readonly handler: (request: Request, context?: Context.Context<never>) => Promise<Response>;
  readonly dispose: () => Promise<void>;
}

/** Build the canonical Effect HTTP application once at process startup. */
export const makeApiWebHandler = (routes: ReadonlyArray<Route>): ApiWebHandler => {
  const application = routesLayer(routes);
  const effectHandler = HttpRouter.toWebHandler(application, {
    disableLogger: true,
    routerConfig: {
      caseSensitive: true,
      ignoreTrailingSlash: false,
    },
  });
  return {
    handler: (request, context = Context.empty()) =>
      effectHandler.handler(request, context as Context.Context<any>),
    dispose: effectHandler.dispose,
  };
};

const handlerCache = new WeakMap<ReadonlyArray<Route>, ApiWebHandler>();

/**
 * Effect-native test/integration entry point. Production creates one handler
 * with `makeApiWebHandler`; this helper preserves the caller's Effect context
 * (notably test Config providers) while using the same router.
 */
export const routeRequest = (
  routes: ReadonlyArray<Route>,
  request: Request,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    let api = handlerCache.get(routes);
    if (api === undefined) {
      api = makeApiWebHandler(routes);
      handlerCache.set(routes, api);
    }
    const context = yield* Effect.context<never>();
    return yield* Effect.tryPromise({
      try: () => api!.handler(request, context),
      catch: (cause) => new Error("Effect HTTP request failed", { cause }),
    }).pipe(Effect.catch((cause) => operationalFailure(request, cause)));
  });

export const serverSentEvents = (
  events: ReadonlyArray<{ readonly event: string; readonly data: unknown }>,
): Response => {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const item of events) {
          controller.enqueue(encoder.encode(`event: ${item.event}\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(item.data)}\n\n`));
        }
        controller.close();
      },
    }),
    {
      headers: {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
    },
  );
};
