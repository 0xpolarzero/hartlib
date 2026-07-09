import { Effect } from "effect";

export type RouteHandler = (request: Request, url: URL) => Effect.Effect<Response, unknown>;

export interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly handle: RouteHandler;
}

export const json = (body: unknown, init?: ResponseInit): Response => {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("access-control-allow-origin", "*");

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
};

export const corsHeaders = (init?: HeadersInit): Headers => {
  const headers = new Headers(init);
  headers.set("access-control-allow-origin", "*");
  return headers;
};

export const notFound = json(
  {
    error: "not_found",
  },
  { status: 404 },
);

export const methodNotAllowed = json(
  {
    error: "method_not_allowed",
  },
  { status: 405 },
);

const routeMatchesPath = (route: Route, path: string): boolean => {
  route.pattern.lastIndex = 0;
  return route.pattern.test(path);
};

const preflight = (request: Request, matchingRoutes: ReadonlyArray<Route>): Response => {
  const requestedMethod = request.headers.get("access-control-request-method") ?? request.method;
  const methods =
    [...new Set(matchingRoutes.map((route) => route.method))].join(", ") || requestedMethod;
  const headers = new Headers();
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", methods);
  headers.set("access-control-allow-headers", "content-type, last-event-id");
  headers.set("access-control-max-age", "86400");

  return new Response(null, {
    status: 204,
    headers,
  });
};

export const routeRequest = (
  routes: ReadonlyArray<Route>,
  request: Request,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const path = url.pathname;

    const matchingRoutes = routes.filter((candidate) => routeMatchesPath(candidate, path));
    if (matchingRoutes.length === 0) {
      return notFound;
    }

    if (request.method === "OPTIONS") {
      return preflight(request, matchingRoutes);
    }

    const route = matchingRoutes.find((candidate) => candidate.method === request.method);
    if (!route) {
      return methodNotAllowed;
    }

    return yield* route.handle(request, url);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.logError("request failed").pipe(
          Effect.annotateLogs({
            cause: String(cause),
          }),
        );

        return json(
          {
            error: "internal_error",
          },
          { status: 500 },
        );
      }),
    ),
  );

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
