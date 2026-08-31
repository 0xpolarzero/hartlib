import { HttpErrorResponse, type HttpRouteContract } from "@hartlib/shared";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { json, routeRequest, type Route } from "../http";
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

describe("canonical path parameter policy", () => {
  it("keeps only document and public-source IDs opaque", () => {
    expect(pathParameterPolicyExceptions).toEqual({
      opaque: [
        "GET /public-source-documents/:documentId/content documentId",
        "GET /v1/issues/:issueId/documents/:documentId/content documentId",
        "PUT /v1/public-sources/:sourceId sourceId",
      ],
    });
  });

  it("rejects malformed UUIDs before endpoint execution", async () => {
    const route: Route = {
      method: "GET",
      path: "/v1/ai-runs/:runId/debug",
      contract: okContract,
      execute: () => Effect.succeed(json({ ok: true })),
    };
    const response = await Effect.runPromise(
      routeRequest([route], new Request("http://hartlib.test/v1/ai-runs/not-a-uuid/debug")),
    );
    expect(response.status).toBe(404);
  });

  it("passes decoded opaque values to endpoint adapters", async () => {
    let captured: Readonly<Record<string, string>> | undefined;
    const route: Route = {
      method: "PUT",
      path: "/v1/public-sources/:sourceId",
      contract: okContract,
      execute: (_request, _url, path) => {
        captured = path;
        return Effect.succeed(json({ ok: true }));
      },
    };
    const response = await Effect.runPromise(
      routeRequest(
        [route],
        new Request("http://hartlib.test/v1/public-sources/source%20identifier", { method: "PUT" }),
      ),
    );
    expect(response.status).toBe(200);
    expect(captured).toEqual({ sourceId: "source identifier" });
  });

  it("classifies every parameter from the final route shape", () => {
    expect(pathParameterNames("PATCH /v1/chat/messages/:messageId")).toEqual(["messageId"]);
    expect(pathParameterKind("PATCH", "/v1/chat/messages/:messageId", "messageId")).toBe("uuid");
    expect(pathParameterKind("PUT", "/v1/public-sources/:sourceId", "sourceId")).toBe("opaque");
    expect(uuid).toMatch(/[0-9a-f-]{36}/u);
  });
});
