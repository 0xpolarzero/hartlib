import { HttpErrorResponse, type HttpRouteContract } from "@hartlib/shared";
import { ConfigProvider, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { json, routeRequest, type Route } from "./http";

const uuid = "11111111-1111-4111-8111-111111111111";
const contract = (schema: Schema.Codec<unknown, unknown, never, never>): HttpRouteContract => ({
  requestBody: { kind: "none" },
  success: [{ kind: "json", schema, statuses: [200] }],
  error: HttpErrorResponse,
});

const run = (routes: readonly Route[], request: Request) =>
  Effect.runPromise(
    routeRequest(routes, request).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { CORS_ALLOWED_ORIGINS: "http://localhost:43111" } }),
        ),
      ),
    ),
  );

describe("routeRequest", () => {
  it("answers CORS preflight and rejects unknown paths", async () => {
    const routes: readonly Route[] = [
      {
        method: "POST",
        path: "/v1/widgets/:widgetId",
        contract: {
          requestBody: { kind: "none" },
          success: [
            { kind: "json", schema: Schema.Struct({ ok: Schema.Literal(true) }), statuses: [200] },
          ],
          error: HttpErrorResponse,
        },
        execute: () => Effect.succeed(json({ ok: true })),
      },
    ];
    const preflight = await run(
      routes,
      new Request(`http://hartlib.test/v1/widgets/${uuid}`, {
        method: "OPTIONS",
        headers: { origin: "http://localhost:43111" },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("POST");
    expect(preflight.headers.get("access-control-allow-headers")).toBe(
      "content-type, last-event-id, x-request-id",
    );
    const unknown = await run(routes, new Request("http://hartlib.test/v1/unknown"));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "not_found" });
  });

  it("keeps matching case-sensitive and rejects unsupported methods", async () => {
    const routes: readonly Route[] = [
      {
        method: "GET",
        path: "/v1/widgets/:widgetId",
        contract: contract(Schema.Struct({ widgetId: Schema.String })),
        execute: (_request, _url, path) => Effect.succeed(json({ widgetId: path.widgetId })),
      },
    ];
    const ok = await run(routes, new Request(`http://hartlib.test/v1/widgets/${uuid}`));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ widgetId: uuid });
    const badCase = await run(routes, new Request(`http://hartlib.test/V1/widgets/${uuid}`));
    expect(badCase.status).toBe(404);
    const unsupported = await run(
      routes,
      new Request(`http://hartlib.test/v1/widgets/${uuid}`, { method: "DELETE" }),
    );
    expect(unsupported.status).toBe(405);
  });

  it("validates exact JSON request and response bodies before the adapter", async () => {
    let executions = 0;
    const routes: readonly Route[] = [
      {
        method: "POST",
        path: "/contract",
        contract: {
          requestBody: {
            kind: "json",
            schema: Schema.Struct({ value: Schema.String }),
            maxBytes: 1024,
          },
          success: [
            {
              kind: "json",
              schema: Schema.Struct({ accepted: Schema.Literal(true) }),
              statuses: [200],
            },
          ],
          error: HttpErrorResponse,
        },
        execute: () => {
          executions += 1;
          return Effect.succeed(json({ accepted: true }));
        },
      },
    ];
    const invalid = await run(
      routes,
      new Request("http://hartlib.test/contract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "ok", extra: true }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ code: "invalid_body" });
    expect(executions).toBe(0);
    const malformedResponse = await run(
      [{ ...routes[0]!, execute: () => Effect.succeed(json({ accepted: false })) }],
      new Request("http://hartlib.test/contract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "ok" }),
      }),
    );
    expect(malformedResponse.status).toBe(500);
    expect(await malformedResponse.json()).toEqual({ error: "internal_error" });
  });

  it("returns bounded operational errors for defects", async () => {
    const response = await run(
      [
        {
          method: "GET",
          path: "/broken",
          contract: contract(Schema.Struct({ ok: Schema.Literal(true) })),
          execute: () => Effect.die(new Error("sensitive defect")),
        },
      ],
      new Request("http://hartlib.test/broken"),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
  });
});
