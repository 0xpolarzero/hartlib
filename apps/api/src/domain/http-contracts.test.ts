import {
  AiRunStreamHeaders,
  AiRunStreamQuery,
  HttpErrorResponse,
  ResetDemoSessionRequest,
  ResetDemoSessionResponse,
  httpRouteContracts,
} from "@hartlib/shared";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

describe("shared HTTP contract matrix", () => {
  it("contains only the final product route inventory", () => {
    expect(Object.keys(httpRouteContracts).sort()).toEqual(
      [
        "DELETE /v1/chat/messages/:messageId",
        "DELETE /v1/memories/:memoryId",
        "GET /health",
        "GET /public-source-documents/:documentId/content",
        "GET /v1/ai-runs/:runId/debug",
        "GET /v1/ai-runs/:runId/stream",
        "GET /v1/chat",
        "GET /v1/issues/:issueId/documents/:documentId/content",
        "GET /v1/memories",
        "GET /v1/memories/:memoryId/revisions/:revisionId",
        "GET /v1/public-sources",
        "PATCH /v1/chat/messages/:messageId",
        "POST /v1/ai-runs/:runId/stop",
        "POST /v1/chat/messages",
        "POST /v1/demo/session",
        "POST /v1/demo/session/reset",
        "POST /v1/memories/:memoryId/revert",
        "PUT /v1/public-sources/:sourceId",
      ].sort(),
    );
  });

  it("keeps reset, stream, and body limits strict", () => {
    const reset = httpRouteContracts["POST /v1/demo/session/reset"]!;
    expect(reset.requestBody).toMatchObject({
      kind: "json",
      schema: ResetDemoSessionRequest,
      maxBytes: 16 * 1024,
    });
    expect(reset.success).toEqual([
      { kind: "json", schema: ResetDemoSessionResponse, statuses: [202] },
    ]);
    expect(httpRouteContracts["POST /v1/chat/messages"]!.requestBody).toMatchObject({
      kind: "json",
      maxBytes: 64 * 1024,
    });
    expect(httpRouteContracts["GET /v1/ai-runs/:runId/stream"]!.query).toBe(AiRunStreamQuery);
    expect(httpRouteContracts["GET /v1/ai-runs/:runId/stream"]!.headers).toMatchObject({
      names: ["last-event-id"],
      schema: AiRunStreamHeaders,
    });
  });

  it("declares only empty, JSON, redirect, binary, and SSE successes", () => {
    for (const [key, route] of Object.entries(httpRouteContracts)) {
      expect(route.success.length, key).toBeGreaterThan(0);
      for (const success of route.success) {
        expect(
          success.statuses.every((status) => status >= 200 && status < 400),
          key,
        ).toBe(true);
      }
    }
    expect(httpRouteContracts["DELETE /v1/chat/messages/:messageId"]!.success).toEqual([
      { kind: "empty", statuses: [204] },
    ]);
    expect(httpRouteContracts["GET /v1/ai-runs/:runId/stream"]!.success).toEqual([
      { kind: "sse", statuses: [200] },
    ]);
  });

  it("rejects unknown error fields at the shared boundary", () => {
    const decode = Schema.decodeUnknownSync(HttpErrorResponse, { onExcessProperty: "error" });
    expect(decode({ code: "unauthorized" })).toEqual({ code: "unauthorized" });
    expect(() => decode({ code: "unauthorized", extra: true })).toThrow();
  });
});
