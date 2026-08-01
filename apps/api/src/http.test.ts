import {
  AiRunStreamHeaders,
  AiRunStreamQuery,
  ArchiveQuery,
  HttpErrorResponse,
  ProductChatsQuery,
  type HttpRouteContract,
} from "@brief/shared";
import { ConfigProvider, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { json, routeRequest, type Route } from "./http";
import { chatRoutes } from "./domain/chat";

const uuid = "11111111-1111-4111-8111-111111111111";
const uuidV6 = "f498ef45-d58a-6ebe-bece-6d5c83bbee05";

const testContract = (schema: HttpRouteContract["error"]): HttpRouteContract => ({
  requestBody: { kind: "none" },
  success: [{ kind: "json", schema, statuses: [200] }],
  error: HttpErrorResponse,
});

const route = (request: Request) =>
  Effect.runPromise(
    routeRequest(chatRoutes, request).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              CORS_ALLOWED_ORIGINS: "http://localhost:43111",
            },
          }),
        ),
      ),
    ),
  );

describe("routeRequest", () => {
  it("answers CORS preflight for a registered POST route", async () => {
    const response = await route(
      new Request("http://brief.test/v1/chat/messages", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:43111",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:43111");
    expect(response.headers.get("access-control-allow-methods")).toBe("POST");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type, idempotency-key, last-event-id, x-brief-title, x-content-sha256, x-file-name, x-request-id",
    );
    expect(response.headers.get("access-control-max-age")).toBe("86400");
    expect(await response.text()).toBe("");
  });

  it("keeps unknown preflight paths as 404", async () => {
    const response = await route(
      new Request("http://brief.test/v1/unknown", {
        method: "OPTIONS",
      }),
    );

    expect(response.status).toBe(404);
  });

  it("uses exact canonical paths and keeps aliases at 404 and unsupported methods at 405", async () => {
    const dynamicRoutes: readonly Route[] = [
      {
        method: "GET",
        path: "/v1/widgets/:widgetId",
        contract: testContract(Schema.Struct({ widgetId: Schema.String })),
        execute: (_request, _url, pathParameters) =>
          Effect.succeed(json({ widgetId: pathParameters.widgetId })),
      },
      {
        method: "PATCH",
        path: "/v1/widgets/:widgetId",
        contract: testContract(Schema.Struct({ status: Schema.Literal("updated") })),
        execute: () => Effect.succeed(json({ status: "updated" })),
      },
    ];
    const get = await Effect.runPromise(
      routeRequest(dynamicRoutes, new Request(`http://brief.test/v1/widgets/${uuid}`)),
    );
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ widgetId: uuid });

    const getV6 = await Effect.runPromise(
      routeRequest(dynamicRoutes, new Request(`http://brief.test/v1/widgets/${uuidV6}`)),
    );
    expect(getV6.status).toBe(200);
    expect(await getV6.json()).toEqual({ widgetId: uuidV6 });

    for (const alias of [`/V1/WIDGETS/${uuid}`, `/v1/widgets/${uuid}/`]) {
      const response = await Effect.runPromise(
        routeRequest(dynamicRoutes, new Request(`http://brief.test${alias}`)),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }

    const preflight = await Effect.runPromise(
      routeRequest(
        dynamicRoutes,
        new Request(`http://brief.test/v1/widgets/${uuid}`, {
          method: "OPTIONS",
          headers: { origin: "http://localhost:43111" },
        }),
      ),
    );
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, PATCH");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const unsupported = await Effect.runPromise(
        routeRequest(
          dynamicRoutes,
          new Request(`http://brief.test/v1/widgets/${uuid}`, { method: "DELETE" }),
        ),
      );
      expect(unsupported.status).toBe(405);
      expect(await unsupported.json()).toEqual({ error: "method_not_allowed" });
    }
  });

  it("turns endpoint defects into the bounded operational response", async () => {
    const broken: readonly Route[] = [
      {
        method: "GET",
        path: "/broken",
        contract: testContract(Schema.Struct({ ok: Schema.Literal(true) })),
        execute: () => Effect.die(new Error("sensitive defect")),
      },
    ];
    const response = await Effect.runPromise(
      routeRequest(broken, new Request("http://brief.test/broken")),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
  });

  it("enforces exact shared request and response schemas at the HTTP boundary", async () => {
    let executes = 0;
    const exact: readonly Route[] = [
      {
        method: "POST",
        path: "/contract",
        contract: {
          requestBody: {
            kind: "json",
            schema: Schema.Struct({ value: Schema.String }),
            maxBytes: 1_024,
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
          executes += 1;
          return Effect.succeed(json({ accepted: true }));
        },
      },
    ];
    const invalidRequest = await Effect.runPromise(
      routeRequest(
        exact,
        new Request("http://brief.test/contract", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "ok", unexpected: true }),
        }),
      ),
    );
    expect(invalidRequest.status).toBe(400);
    expect(await invalidRequest.json()).toEqual({ code: "invalid_body" });
    expect(executes).toBe(0);

    const invalidResponse: readonly Route[] = [
      {
        ...exact[0]!,
        execute: () => Effect.succeed(json({ accepted: false })),
      },
    ];
    const response = await Effect.runPromise(
      routeRequest(
        invalidResponse,
        new Request("http://brief.test/contract", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "ok" }),
        }),
      ),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });

    const invalidStatus: readonly Route[] = [
      {
        ...exact[0]!,
        execute: () => Effect.succeed(json({ accepted: true }, { status: 201 })),
      },
    ];
    const wrongStatus = await Effect.runPromise(
      routeRequest(
        invalidStatus,
        new Request("http://brief.test/contract", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "ok" }),
        }),
      ),
    );
    expect(wrongStatus.status).toBe(500);
    expect(await wrongStatus.json()).toEqual({ error: "internal_error" });
  });

  it("validates canonical UUID parameters with shared Effect Schemas before dispatch", async () => {
    const guarded: readonly Route[] = [
      {
        method: "PUT",
        path: "/v1/client-companies/:companyId/ai-limit",
        execute: () => Effect.succeed(json({ status: "updated" })),
      },
    ];
    for (const method of ["PUT", "GET", "OPTIONS"] as const) {
      const response = await Effect.runPromise(
        routeRequest(
          guarded,
          new Request("http://brief.test/v1/client-companies/not-a-uuid/ai-limit", {
            method,
            ...(method === "OPTIONS" ? { headers: { origin: "http://localhost:43111" } } : {}),
          }),
        ),
      );
      expect(response.status).toBe(404);
    }
  });

  it("canonicalizes invalid administrative request IDs once for concurrent execute and audit", async () => {
    const executed = new Map<string, string>();
    const audited = new Map<string, string>();
    const administrative: readonly Route[] = [
      {
        method: "PUT",
        path: "/v1/client-companies/:companyId/ai-limit",
        execute: (request) => {
          const correlation = request.headers.get("x-test-correlation")!;
          executed.set(correlation, request.headers.get("x-request-id")!);
          return Effect.succeed(json({ status: "updated" }));
        },
        administrativeAudit: (request) => {
          const correlation = request.headers.get("x-test-correlation")!;
          audited.set(correlation, request.headers.get("x-request-id")!);
          return Effect.void;
        },
      },
    ];

    await Promise.all(
      Array.from({ length: 32 }, (_, index) => {
        const correlation = String(index);
        return Effect.runPromise(
          routeRequest(
            administrative,
            new Request(`http://brief.test/v1/client-companies/${uuid}/ai-limit`, {
              method: "PUT",
              headers: {
                "content-type": "application/json",
                "x-request-id": `invalid-${index}`,
                "x-test-correlation": correlation,
              },
              body: JSON.stringify({ companyMonthlyLimit: null }),
            }),
          ),
        );
      }),
    );

    const generated = [...executed.values()];
    expect(generated).toHaveLength(32);
    expect(new Set(generated)).toHaveLength(32);
    for (const [correlation, requestId] of executed) {
      expect(requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      );
      expect(audited.get(correlation)).toBe(requestId);
    }
  });

  it("server-binds a unique audit ID even when a client reuses a valid mutation ID", async () => {
    const seen: string[] = [];
    const administrative: readonly Route[] = [
      {
        method: "PUT",
        path: "/v1/client-companies/:companyId/ai-limit",
        execute: (request) => {
          seen.push(request.headers.get("x-request-id")!);
          return Effect.succeed(json({ status: "updated" }));
        },
        administrativeAudit: () => Effect.void,
      },
    ];
    const supplied = "22222222-2222-4222-8222-222222222222";
    for (let index = 0; index < 2; index += 1) {
      const response = await Effect.runPromise(
        routeRequest(
          administrative,
          new Request(`http://brief.test/v1/client-companies/${uuid}/ai-limit`, {
            method: "PUT",
            headers: { "content-type": "application/json", "x-request-id": supplied },
            body: JSON.stringify({ companyMonthlyLimit: null }),
          }),
        ),
      );
      expect(response.status).toBe(200);
    }
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
    expect(seen).not.toContain(supplied);
  });

  it("cancels an oversized streamed administrative body before execute and audits one denial", async () => {
    let cancelled = 0;
    let executes = 0;
    const audited: Array<{ readonly status: number; readonly body: unknown }> = [];
    const administrative: readonly Route[] = [
      {
        method: "PUT",
        path: "/v1/client-companies/:companyId/ai-limit",
        contract: {
          requestBody: {
            kind: "json",
            schema: Schema.Struct({ companyMonthlyLimit: Schema.NullOr(Schema.Number) }),
            maxBytes: 4,
          },
          requestRejections: {
            invalid: { status: 400, body: { code: "invalid_body" } },
            tooLarge: { status: 413, body: { code: "request_too_large" } },
            unsupportedMediaType: { status: 415, body: { code: "content_type_unsupported" } },
            invalidQuery: { status: 400, body: { code: "invalid_query" } },
            invalidHeaders: { status: 400, body: { code: "invalid_headers" } },
          },
          success: [
            {
              kind: "json",
              schema: Schema.Struct({ status: Schema.Literal("updated") }),
              statuses: [200],
            },
          ],
          error: HttpErrorResponse,
        },
        execute: () => {
          executes += 1;
          return Effect.succeed(json({ status: "updated" }));
        },
        administrativeAudit: (_request, response) =>
          Effect.promise(async () => {
            audited.push({ status: response.status, body: await response.clone().json() });
          }),
      },
    ];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled += 1;
      },
    });
    const response = await Effect.runPromise(
      routeRequest(
        administrative,
        new Request(`http://brief.test/v1/client-companies/${uuid}/ai-limit`, {
          method: "PUT",
          headers: {
            authorization: "Bearer authenticated-admin",
            "content-type": "application/json",
          },
          body: stream,
        }),
      ),
    );
    await Promise.resolve();
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ code: "request_too_large" });
    expect(executes).toBe(0);
    expect(cancelled).toBeGreaterThan(0);
    expect(audited).toEqual([{ status: 413, body: { code: "request_too_large" } }]);
  });

  it("rejects unknown, duplicate, and invalid query values before dispatch", async () => {
    let executes = 0;
    const guarded: readonly Route[] = [
      {
        method: "GET",
        path: "/v1/public-sources",
        execute: () => {
          executes += 1;
          return Effect.succeed(json({ sources: [], publications: [] }));
        },
      },
    ];
    for (const query of ["market=EU", "market=FR&market=US", "unknown=value"]) {
      const response = await Effect.runPromise(
        routeRequest(guarded, new Request(`http://brief.test/v1/public-sources?${query}`)),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "invalid_query" });
    }
    expect(executes).toBe(0);
  });

  it("passes the exact decoded query and selected headers to the adapter", async () => {
    let decoded: unknown;
    const guarded: readonly Route[] = [
      {
        method: "GET",
        path: "/decoded",
        contract: {
          requestBody: { kind: "none" },
          requestRejections: {
            invalid: { status: 400, body: { code: "invalid_body" } },
            tooLarge: { status: 413, body: { code: "request_too_large" } },
            unsupportedMediaType: { status: 415, body: { code: "content_type_unsupported" } },
            invalidQuery: { status: 400, body: { code: "invalid_query" } },
            invalidHeaders: { status: 400, body: { code: "invalid_headers" } },
          },
          query: ProductChatsQuery,
          headers: {
            names: ["last-event-id"],
            schema: Schema.Struct({ "last-event-id": Schema.String }),
          },
          success: [
            {
              kind: "json",
              schema: Schema.Struct({ ok: Schema.Literal(true) }),
              statuses: [200],
            },
          ],
          error: HttpErrorResponse,
        },
        execute: (_request, _url, _pathParameters, input) => {
          decoded = input;
          return Effect.succeed(json({ ok: true }));
        },
      },
    ];
    const response = await Effect.runPromise(
      routeRequest(
        guarded,
        new Request("http://brief.test/decoded?view=shared", {
          headers: { "last-event-id": "7", "x-ignored-standard-header": "allowed" },
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(decoded).toMatchObject({
      query: { view: "shared" },
      headers: { "last-event-id": "7" },
    });
  });

  it("rejects malformed webhook, SSE, and PDF metadata inputs before dispatch", async () => {
    const cases: ReadonlyArray<{
      readonly method: Route["method"];
      readonly path: Route["path"];
      readonly url: string;
      readonly init?: RequestInit;
    }> = [
      {
        method: "POST",
        path: "/v1/billing/stripe/webhook",
        url: "/v1/billing/stripe/webhook",
        init: { method: "POST", body: "{}" },
      },
      {
        method: "POST",
        path: "/v1/identity/clerk/webhook",
        url: "/v1/identity/clerk/webhook",
        init: { method: "POST", headers: { "svix-id": "event" }, body: "{}" },
      },
      {
        method: "GET",
        path: "/v1/ai-runs/:runId/stream",
        url: `/v1/ai-runs/${uuid}/stream?afterSeq=-1`,
      },
      {
        method: "POST",
        path: "/v1/publisher-issues/:issueId/documents",
        url: `/v1/publisher-issues/${uuid}/documents`,
        init: {
          method: "POST",
          headers: { "content-type": "application/pdf" },
          body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        },
      },
    ];
    for (const item of cases) {
      let executes = 0;
      const route: Route = {
        method: item.method,
        path: item.path,
        execute: () => {
          executes += 1;
          return Effect.succeed(json({ unexpected: true }));
        },
      };
      const response = await Effect.runPromise(
        routeRequest([route], new Request(`http://brief.test${item.url}`, item.init)),
      );
      expect(response.status, `${item.method} ${item.path}`).toBe(400);
      expect(executes).toBe(0);
    }
  });

  it("rejects and cancels an undeclared streamed body on a no-body contract", async () => {
    let executes = 0;
    let cancelled = 0;
    const route: Route = {
      method: "POST",
      path: "/no-body",
      contract: {
        requestBody: { kind: "none" },
        success: [
          {
            kind: "json",
            schema: Schema.Struct({ ok: Schema.Literal(true) }),
            statuses: [200],
          },
        ],
        error: HttpErrorResponse,
      },
      execute: () => {
        executes += 1;
        return Effect.succeed(json({ ok: true }));
      },
    };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled += 1;
      },
    });
    const response = await Effect.runPromise(
      routeRequest([route], new Request("http://brief.test/no-body", { method: "POST", body })),
    );
    await Promise.resolve();
    expect(response.status).toBe(400);
    expect(executes).toBe(0);
    expect(cancelled).toBeGreaterThan(0);
  });

  it("audits exactly one denial for invalid administrative query and header inputs", async () => {
    const cases = [
      {
        method: "PUT" as const,
        path: "/v1/client-companies/:companyId/ai-limit" as const,
        url: `/v1/client-companies/${uuid}/ai-limit?unexpected=true`,
        init: {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ companyMonthlyLimit: null }),
        },
        code: "invalid_query",
      },
      {
        method: "POST" as const,
        path: "/v1/publisher-issues/:issueId/documents" as const,
        url: `/v1/publisher-issues/${uuid}/documents`,
        init: {
          method: "POST",
          headers: { "content-type": "application/pdf" },
          body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        },
        code: "invalid_headers",
      },
    ];
    for (const item of cases) {
      let executes = 0;
      const audits: unknown[] = [];
      const route: Route = {
        method: item.method,
        path: item.path,
        execute: () => {
          executes += 1;
          return Effect.succeed(json({ unexpected: true }));
        },
        administrativeAudit: (_request, response) =>
          Effect.promise(async () => audits.push(await response.clone().json())),
      };
      const response = await Effect.runPromise(
        routeRequest([route], new Request(`http://brief.test${item.url}`, item.init)),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: item.code });
      expect(executes).toBe(0);
      expect(audits).toEqual([{ code: item.code }]);
    }
  });

  it("rejects unsafe or noncanonical SSE sequences before dispatch", async () => {
    let executes = 0;
    const guarded: Route = {
      method: "GET",
      path: "/cursor",
      contract: {
        requestBody: { kind: "none" },
        requestRejections: {
          invalid: { status: 400, body: { code: "invalid_body" } },
          tooLarge: { status: 413, body: { code: "request_too_large" } },
          unsupportedMediaType: { status: 415, body: { code: "content_type_unsupported" } },
          invalidQuery: { status: 400, body: { code: "invalid_query" } },
          invalidHeaders: { status: 400, body: { code: "invalid_headers" } },
        },
        query: AiRunStreamQuery,
        headers: { names: ["last-event-id"], schema: AiRunStreamHeaders },
        success: [
          { kind: "json", schema: Schema.Struct({ ok: Schema.Literal(true) }), statuses: [200] },
        ],
        error: HttpErrorResponse,
      },
      execute: () => {
        executes += 1;
        return Effect.succeed(json({ ok: true }));
      },
    };
    for (const value of ["01", "9007199254740992"]) {
      const response = await Effect.runPromise(
        routeRequest([guarded], new Request(`http://brief.test/cursor?afterSeq=${value}`)),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "invalid_query" });
    }
    for (const value of ["0", "01", "9007199254740992"]) {
      const response = await Effect.runPromise(
        routeRequest(
          [guarded],
          new Request("http://brief.test/cursor", { headers: { "last-event-id": value } }),
        ),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "invalid_headers" });
    }
    expect(executes).toBe(0);
  });

  it("rejects malformed, noncanonical, and unsafe page cursors before dispatch", async () => {
    let executes = 0;
    const guarded: Route = {
      method: "GET",
      path: "/archive",
      contract: {
        requestBody: { kind: "none" },
        requestRejections: {
          invalid: { status: 400, body: { code: "invalid_body" } },
          tooLarge: { status: 413, body: { code: "request_too_large" } },
          unsupportedMediaType: { status: 415, body: { code: "content_type_unsupported" } },
          invalidQuery: { status: 400, body: { code: "invalid_query" } },
          invalidHeaders: { status: 400, body: { code: "invalid_headers" } },
        },
        query: ArchiveQuery,
        success: [
          { kind: "json", schema: Schema.Struct({ ok: Schema.Literal(true) }), statuses: [200] },
        ],
        error: HttpErrorResponse,
      },
      execute: () => {
        executes += 1;
        return Effect.succeed(json({ ok: true }));
      },
    };
    const invalid = ["A", btoa("01"), btoa("9007199254740992"), btoa("25").replace(/=$/u, "")];
    for (const cursor of invalid) {
      const response = await Effect.runPromise(
        routeRequest(
          [guarded],
          new Request(`http://brief.test/archive?cursor=${encodeURIComponent(cursor)}`),
        ),
      );
      expect(response.status, cursor).toBe(400);
      expect(await response.json()).toEqual({ code: "invalid_query" });
    }
    expect(executes).toBe(0);
  });

  it("accepts only discriminated archive source filters", async () => {
    const dispatched: unknown[] = [];
    const guarded: Route = {
      method: "GET",
      path: "/archive-filter",
      contract: {
        requestBody: { kind: "none" },
        requestRejections: {
          invalid: { status: 400, body: { code: "invalid_body" } },
          tooLarge: { status: 413, body: { code: "request_too_large" } },
          unsupportedMediaType: { status: 415, body: { code: "content_type_unsupported" } },
          invalidQuery: { status: 400, body: { code: "invalid_query" } },
          invalidHeaders: { status: 400, body: { code: "invalid_headers" } },
        },
        query: ArchiveQuery,
        success: [
          { kind: "json", schema: Schema.Struct({ ok: Schema.Literal(true) }), statuses: [200] },
        ],
        error: HttpErrorResponse,
      },
      execute: (_request, _url, _path, input) => {
        dispatched.push(input.query);
        return Effect.succeed(json({ ok: true }));
      },
    };
    const valid = [
      "",
      `?sourceKind=publisher&sourceId=${uuid}`,
      "?sourceKind=public&sourceId=official-marketplace-source",
    ];
    for (const query of valid) {
      const response = await Effect.runPromise(
        routeRequest([guarded], new Request(`http://brief.test/archive-filter${query}`)),
      );
      expect(response.status, query).toBe(200);
    }
    expect(dispatched).toEqual([
      {},
      { sourceKind: "publisher", sourceId: uuid },
      { sourceKind: "public", sourceId: "official-marketplace-source" },
    ]);

    const invalid = [
      `?subscriptionId=${uuid}`,
      "?subscriptionId=public%3Aofficial-marketplace-source",
      "?sourceKind=public",
      "?sourceId=official-marketplace-source",
      "?sourceKind=publisher&sourceId=official-marketplace-source",
      "?sourceKind=unknown&sourceId=official-marketplace-source",
      "?sourceKind=public&sourceId=Public%20Source",
    ];
    for (const query of invalid) {
      const response = await Effect.runPromise(
        routeRequest([guarded], new Request(`http://brief.test/archive-filter${query}`)),
      );
      expect(response.status, query).toBe(400);
      expect(await response.json()).toEqual({ code: "invalid_query" });
    }
    expect(dispatched).toHaveLength(valid.length);
  });

  it("consumes decoded bodies while cancelling the adapter-visible original branch", async () => {
    const guarded: Route = {
      method: "POST",
      path: "/decoded-body",
      contract: {
        requestBody: {
          kind: "json",
          schema: Schema.Struct({ value: Schema.Literal("ok") }),
          maxBytes: 128,
        },
        success: [
          { kind: "json", schema: Schema.Struct({ ok: Schema.Literal(true) }), statuses: [200] },
        ],
        error: HttpErrorResponse,
      },
      execute: (_request, _url, _path, input) => {
        expect(input.body).toEqual({ value: "ok" });
        return Effect.succeed(json({ ok: true }));
      },
    };
    const request = new Request("http://brief.test/decoded-body", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"value":"ok"}'));
          controller.close();
        },
      }),
    });
    const response = await Effect.runPromise(routeRequest([guarded], request));
    expect(response.status).toBe(200);
    expect(request.bodyUsed).toBe(true);

    const malformed = new Request("http://brief.test/decoded-body", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const rejected = await Effect.runPromise(routeRequest([guarded], malformed));
    expect(rejected.status).toBe(400);
    expect(malformed.bodyUsed).toBe(true);
  });

  it("requires empty and redirect successes to have exact body and media semantics", async () => {
    const empty: Route = {
      method: "DELETE",
      path: "/empty",
      contract: {
        requestBody: { kind: "none" },
        success: [{ kind: "empty", statuses: [204] }],
        error: HttpErrorResponse,
      },
      execute: () =>
        Effect.succeed(
          new Response(null, { status: 204, headers: { "content-type": "application/json" } }),
        ),
    };
    const redirect: Route = {
      method: "GET",
      path: "/redirect",
      contract: {
        requestBody: { kind: "none" },
        success: [{ kind: "redirect", statuses: [302] }],
        error: HttpErrorResponse,
      },
      execute: () =>
        Effect.succeed(new Response("unexpected", { status: 302, headers: { location: "/next" } })),
    };
    const emptyResponse = await Effect.runPromise(
      routeRequest([empty], new Request("http://brief.test/empty", { method: "DELETE" })),
    );
    const redirectResponse = await Effect.runPromise(
      routeRequest([redirect], new Request("http://brief.test/redirect")),
    );
    expect(emptyResponse.status).toBe(500);
    expect(redirectResponse.status).toBe(500);
  });

  it("does not write an error body after the request has been aborted", async () => {
    const controller = new AbortController();
    controller.abort("client_disconnected");
    const guarded: Route = {
      method: "GET",
      path: "/aborted",
      contract: testContract(Schema.Struct({ ok: Schema.Literal(true) })),
      execute: () => Effect.fail(new Error("request failed after disconnect")),
    };

    const response = await Effect.runPromise(
      routeRequest(
        [guarded],
        new Request("http://brief.test/aborted", { signal: controller.signal }),
      ),
    );
    expect(response.status).toBe(499);
    expect(await response.text()).toBe("");
  });

  it("does not turn an interrupted request into an error response", async () => {
    const interrupted: Route = {
      method: "GET",
      path: "/interrupted",
      contract: testContract(Schema.Struct({ ok: Schema.Literal(true) })),
      execute: () => Effect.interrupt,
    };

    const response = await Effect.runPromise(
      routeRequest([interrupted], new Request("http://brief.test/interrupted")),
    );
    expect(response.status).toBe(499);
    expect(await response.text()).toBe("");
  });
});
