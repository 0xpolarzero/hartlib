import { HttpErrorResponse, type HttpRouteContract } from "@brief/shared";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { json, routeRequest, type Route } from "../http";
import { routes } from "../routes";
import {
  pathParameterKind,
  pathParameterNames,
  pathParameterPolicyExceptions,
} from "./path-parameter-policy";

const uuid = "11111111-1111-4111-8111-111111111111";
const okContract: HttpRouteContract = {
  requestBody: { kind: "none" },
  success: [{ kind: "json", schema: Schema.Struct({ ok: Schema.Literal(true) }), statuses: [200] }],
  error: HttpErrorResponse,
};

const validValue = (kind: ReturnType<typeof pathParameterKind>): string =>
  kind === "uuid" ? uuid : kind === "positive_integer" ? "1" : "opaque-id";

describe("canonical path parameter policy", () => {
  it("keeps the complete non-UUID exception inventory explicit", () => {
    expect(pathParameterPolicyExceptions).toEqual({
      opaque: [
        "DELETE /v1/client-companies/:companyId/members/:userId userId",
        "DELETE /v1/client-companies/:companyId/members/:userId/subscription-grants/:accessId userId",
        "DELETE /v1/publisher-companies/:companyId/members/:userId userId",
        "GET /public-source-documents/:documentId/content documentId",
        "PATCH /v1/client-companies/:companyId/members/:userId userId",
        "PATCH /v1/publisher-companies/:companyId/members/:userId userId",
        "POST /v1/client-companies/:companyId/members/:userId/subscription-grants userId",
        "PUT /v1/client-companies/:companyId/members/:userId/ai-limit userId",
        "PUT /v1/client-companies/:companyId/public-sources/:sourceId sourceId",
      ],
      positiveInteger: ["POST /v1/platform/support/access/:accessId/review accessId"],
    });
  });

  it("rejects a malformed value for every current path parameter before execute or audit", async () => {
    for (const route of routes) {
      for (const invalidName of pathParameterNames(route.path)) {
        let executes = 0;
        let audits = 0;
        const guarded: Route = {
          method: route.method,
          path: route.path,
          execute: () => {
            executes += 1;
            return Effect.succeed(json({ ok: true }));
          },
          administrativeAudit: () => {
            audits += 1;
            return Effect.void;
          },
        };
        const path = route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/gu, (_match, name: string) => {
          const kind = pathParameterKind(route.method, route.path, name);
          if (name === invalidName) {
            return kind === "positive_integer" ? "0" : kind === "opaque" ? "%00" : "malformed";
          }
          return validValue(kind);
        });
        const response = await Effect.runPromise(
          routeRequest(
            [guarded],
            new Request(`http://brief.test${path}`, { method: route.method }),
          ),
        );
        expect(response.status, `${route.method} ${route.path} ${invalidName}`).toBe(404);
        expect(executes).toBe(0);
        expect(audits).toBe(0);
      }
    }
  });

  it("passes Effect HTTP's decoded validated values to endpoint adapters", async () => {
    let captured: Readonly<Record<string, string>> | undefined;
    const route: Route = {
      method: "PUT",
      path: "/v1/client-companies/:companyId/public-sources/:sourceId",
      contract: okContract,
      execute: (_request, _url, pathParameters) => {
        captured = pathParameters;
        return Effect.succeed(json({ ok: true }));
      },
    };
    const response = await Effect.runPromise(
      routeRequest(
        [route],
        new Request(
          `http://brief.test/v1/client-companies/${uuid}/public-sources/source%20identifier`,
          { method: "PUT" },
        ),
      ),
    );
    expect(response.status).toBe(200);
    expect(captured).toEqual({ companyId: uuid, sourceId: "source identifier" });
  });
});
