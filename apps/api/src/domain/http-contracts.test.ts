import {
  HttpErrorResponse,
  ResetProductChatRequest,
  ResetProductChatResponse,
  httpRouteContracts,
} from "@brief/shared";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { routes } from "../routes";

describe("shared HTTP contract matrix", () => {
  it("has one route-specific request/response contract for every production route", () => {
    const registered = routes.map((route) => `${route.method} ${route.path}`).sort();
    expect(new Set(registered).size).toBe(registered.length);
    expect(Object.keys(httpRouteContracts).sort()).toEqual(registered);
  });

  it("limits non-JSON request bodies to exact raw-webhook and PDF-upload routes", () => {
    const exceptional = Object.entries(httpRouteContracts)
      .filter(
        ([, contract]) =>
          contract.requestBody.kind === "raw" || contract.requestBody.kind === "binary",
      )
      .map(([key, contract]) => `${key} ${contract.requestBody.kind}`)
      .sort();
    expect(exceptional).toEqual([
      "POST /v1/billing/stripe/webhook raw",
      "POST /v1/identity/clerk/webhook raw",
      "POST /v1/publisher-issues/:issueId/documents binary",
    ]);
  });

  it("declares exact nonempty success status sets for every branch", () => {
    for (const [key, contract] of Object.entries(httpRouteContracts)) {
      for (const success of contract.success) {
        expect(success.statuses.length, key).toBeGreaterThan(0);
        expect(new Set(success.statuses).size, key).toBe(success.statuses.length);
        for (const status of success.statuses) {
          expect(Number.isInteger(status), key).toBe(true);
          expect(status, key).toBeGreaterThanOrEqual(200);
          expect(status, key).toBeLessThan(400);
        }
      }
    }
  });

  it("limits non-JSON success bodies to canonical empty, binary, redirect, and SSE branches", () => {
    const streaming = Object.entries(httpRouteContracts)
      .filter(([, contract]) => contract.success.some((success) => success.kind === "sse"))
      .map(([key]) => key);
    const binary = Object.entries(httpRouteContracts)
      .filter(([, contract]) => contract.success.some((success) => success.kind === "binary"))
      .map(([key]) => key);
    const redirects = Object.entries(httpRouteContracts)
      .filter(([, contract]) => contract.success.some((success) => success.kind === "redirect"))
      .map(([key]) => key)
      .sort();

    expect(streaming).toEqual(["GET /v1/ai-runs/:runId/stream"]);
    expect(binary).toEqual(["GET /public-source-documents/:documentId/content"]);
    expect(redirects).toEqual([
      "GET /v1/exports/:exportId/download",
      "GET /v1/issues/:issueId/documents/:documentId/content",
      "GET /v1/platform/support/grants/:grantId/content",
    ]);
  });

  it("declares the complete query and selected-header input surface", () => {
    const queryRoutes = Object.entries(httpRouteContracts)
      .filter(([, contract]) => contract.query !== undefined)
      .map(([key]) => key)
      .sort();
    const headerRoutes = Object.entries(httpRouteContracts)
      .filter(([, contract]) => contract.headers !== undefined)
      .map(([key, contract]) => [key, contract.headers!.names] as const)
      .sort(([left], [right]) => left.localeCompare(right));

    expect(queryRoutes).toEqual([
      "GET /v1/ai-runs/:runId/stream",
      "GET /v1/chats",
      "GET /v1/client-companies/:companyId/archive",
      "GET /v1/client-companies/:companyId/notifications",
      "GET /v1/public-sources",
      "PUT /v1/public-sources/:sourceId",
    ]);
    expect(headerRoutes).toEqual([
      ["GET /v1/ai-runs/:runId/stream", ["last-event-id"]],
      ["POST /v1/billing/stripe/webhook", ["stripe-signature"]],
      [
        "POST /v1/identity/clerk/webhook",
        [
          "svix-id",
          "svix-timestamp",
          "svix-signature",
          "webhook-id",
          "webhook-timestamp",
          "webhook-signature",
        ],
      ],
      [
        "POST /v1/publisher-issues/:issueId/documents",
        ["idempotency-key", "x-brief-title", "x-file-name", "x-content-sha256"],
      ],
    ]);
    for (const [, names] of headerRoutes) {
      expect(new Set(names).size).toBe(names.length);
      expect(names.every((name) => name === name.toLowerCase())).toBe(true);
    }
  });

  it("keeps the reset request, success, and conflict contracts strict", () => {
    const reset = httpRouteContracts["POST /v1/chats/:chatId/reset"];
    expect(reset).toBeDefined();
    expect(reset?.requestBody).toMatchObject({ kind: "json", schema: ResetProductChatRequest });
    expect(reset?.success).toEqual([
      { kind: "json", schema: ResetProductChatResponse, statuses: [200] },
    ]);

    const decodeError = (value: unknown) =>
      Schema.decodeUnknownSync(HttpErrorResponse, { onExcessProperty: "error" })(value);
    expect(
      decodeError({
        error: "chat_already_reset",
        archivedChatId: "123e4567-e89b-12d3-a456-426614174001",
      }),
    ).toEqual({
      error: "chat_already_reset",
      archivedChatId: "123e4567-e89b-12d3-a456-426614174001",
    });
    expect(() =>
      decodeError({
        error: "chat_already_reset",
        archivedChatId: "123e4567-e89b-12d3-a456-426614174001",
        extra: true,
      }),
    ).toThrow();
  });
});
