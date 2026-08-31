import { Effect, Schema } from "effect";
import { PgClient } from "@effect/sql-pg";

import {
  DemoSessionResponse,
  ResetDemoSessionRequest,
  ResetDemoSessionResponse,
} from "@hartlib/shared";
import {
  findDemoSession,
  persistDemoSession,
  resetDemoSession,
} from "@hartlib/backend-domain/demo-sessions";

import { loadApiConfig } from "../config";
import { ApiDatabaseLayer, type ApiDatabaseLayer as ApiDatabaseLayerType } from "../database";
import {
  DEMO_COOKIE_NAME,
  createDemoSession,
  demoSessionCookieAttributes,
  readCookie,
  verifyDemoSessionCookie,
} from "../demo-session";
import { json, jsonFromSchema, type Route } from "../http";

const cookieFor = (visitorId: string, production: boolean): string =>
  `${DEMO_COOKIE_NAME}=${visitorId}; ${demoSessionCookieAttributes(production)}`;

export const makeDemoSessionRoutes = (
  databaseLayer: ApiDatabaseLayerType = ApiDatabaseLayer,
): readonly Route[] => [
  {
    method: "POST",
    path: "/v1/demo/session",
    execute: (request) =>
      Effect.gen(function* () {
        const config = yield* loadApiConfig;
        const existing = verifyDemoSessionCookie(
          readCookie(request.headers.get("cookie"), DEMO_COOKIE_NAME),
        );
        if (existing !== null) {
          const session = yield* findDemoSession(existing).pipe(Effect.provide(databaseLayer));
          if (session !== null && session.revokedAt === null) {
            return jsonFromSchema(DemoSessionResponse, { ok: true });
          }
        }
        const session = createDemoSession();
        yield* persistDemoSession(session.visitorId).pipe(Effect.provide(databaseLayer));
        return jsonFromSchema(
          DemoSessionResponse,
          { ok: true },
          {
            headers: {
              "set-cookie": cookieFor(session.visitorId, config.nodeEnv === "production"),
            },
          },
        );
      }),
  },
  {
    method: "POST",
    path: "/v1/demo/session/reset",
    execute: (request, _url, _pathParameters, input) =>
      Effect.gen(function* () {
        const config = yield* loadApiConfig;
        const body = Schema.decodeUnknownSync(ResetDemoSessionRequest, {
          onExcessProperty: "error",
        })(input.body);
        const operationId = body.resetOperationId;

        // Read the operation before checking the old cookie.  A response-loss
        // retry therefore works after the predecessor has already been
        // revoked or after its purge has removed the session row.
        const existing = yield* findDemoSessionResetSuccessor(operationId).pipe(
          Effect.provide(databaseLayer),
        );
        if (existing !== null) {
          return jsonFromSchema(
            ResetDemoSessionResponse,
            { ok: true },
            {
              status: 202,
              headers: { "set-cookie": cookieFor(existing, config.nodeEnv === "production") },
            },
          );
        }
        const predecessor = verifyDemoSessionCookie(
          readCookie(request.headers.get("cookie"), DEMO_COOKIE_NAME),
        );
        if (predecessor === null) return json({ error: "unauthorized" }, { status: 401 });
        const result = yield* resetDemoSession(operationId, predecessor).pipe(
          Effect.provide(databaseLayer),
        );
        if (result.kind === "unauthorized") return json({ error: "unauthorized" }, { status: 401 });
        return jsonFromSchema(
          ResetDemoSessionResponse,
          { ok: true },
          {
            status: 202,
            headers: {
              "set-cookie": cookieFor(result.successorVisitorId, config.nodeEnv === "production"),
            },
          },
        );
      }),
  },
];

const findDemoSessionResetSuccessor = (resetOperationId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly successor: string }>`
      select successor_visitor_id::text as successor
      from demo_reset_operations
      where reset_operation_id = ${resetOperationId}::uuid
      limit 1
    `;
    return rows[0]?.successor ?? null;
  });

export const demoSessionRoutes = makeDemoSessionRoutes();
