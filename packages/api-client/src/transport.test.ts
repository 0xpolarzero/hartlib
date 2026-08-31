import { HealthResponse, UpdateClientPublicSourceRequest } from "@hartlib/shared";
import { describe, expect, it, vi } from "vitest";

import {
  API_TEXT_RESPONSE_MAX_BYTES,
  ApiResponseError,
  createApiTransport,
  type Fetch,
} from "./transport";

describe("canonical HTTP client transport", () => {
  it("accepts only the exact declared success status, media type, and body", async () => {
    const fetch = vi.fn<Fetch>(async () => Response.json({ ok: true, service: "api" }));
    const transport = createApiTransport({ fetch });

    await expect(transport.json("GET /health", "/health", HealthResponse)).resolves.toEqual({
      ok: true,
      service: "api",
    });
    expect(fetch).toHaveBeenCalledWith(
      "/health",
      expect.objectContaining({ method: "GET", headers: expect.any(Headers) }),
    );
  });

  it("rejects undeclared statuses even when fetch reports a successful class", async () => {
    const transport = createApiTransport({
      fetch: async () => new Response(null, { status: 201 }),
    });
    await expect(transport.json("GET /health", "/health", HealthResponse)).rejects.toMatchObject({
      status: 201,
      code: "request_201",
    });
  });

  it("rejects wrong success media types and malformed or excess bodies", async () => {
    const invalidRedirected = new Response("zip", {
      status: 200,
      headers: { "content-type": "application/zip" },
    });
    Object.defineProperty(invalidRedirected, "redirected", { value: true });
    const responses = [
      new Response(JSON.stringify({ ok: true, service: "api" }), {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
      Response.json({ ok: true, service: "api", extra: true }),
      Response.json({ ok: true }),
    ];
    const transport = createApiTransport({ fetch: async () => responses.shift()! });

    await expect(transport.json("GET /health", "/health", HealthResponse)).rejects.toMatchObject({
      code: "invalid_response_media_type",
    });
    await expect(transport.json("GET /health", "/health", HealthResponse)).rejects.toMatchObject({
      code: "invalid_response_body",
    });
    await expect(transport.json("GET /health", "/health", HealthResponse)).rejects.toMatchObject({
      code: "invalid_response_body",
    });
  });

  it("rejects malformed UTF-8 in split success and error bodies", async () => {
    const split = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x7b, 0x22, 0x6f, 0x6b, 0x22, 0x3a]));
          controller.enqueue(new Uint8Array([0xc3, 0x28]));
          controller.enqueue(new Uint8Array([0x7d]));
          controller.close();
        },
      });
    const responses = [
      new Response(split(), { headers: { "content-type": "application/json" } }),
      new Response(split(), { status: 502, headers: { "content-type": "application/json" } }),
    ];
    const transport = createApiTransport({ fetch: async () => responses.shift()! });
    await expect(transport.json("GET /health", "/health", HealthResponse)).rejects.toMatchObject({
      code: "invalid_response_body",
    });
    await expect(transport.json("GET /health", "/health", HealthResponse)).rejects.toMatchObject({
      code: "invalid_response_body",
      body: undefined,
    });
  });

  it("bounds textual bodies and cancels an in-flight reader on abort", async () => {
    const oversized = new Uint8Array(API_TEXT_RESPONSE_MAX_BYTES + 1);
    oversized.fill(0x20);
    const transport = createApiTransport({
      fetch: async () =>
        new Response(oversized, {
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(transport.json("GET /health", "/health", HealthResponse)).rejects.toMatchObject({
      code: "invalid_response_body",
    });

    const canceled = vi.fn();
    const controller = new AbortController();
    const pending = new ReadableStream<Uint8Array>({ cancel: canceled });
    const abortTransport = createApiTransport({
      fetch: async () => new Response(pending, { headers: { "content-type": "application/json" } }),
    });
    const request = abortTransport.json("GET /health", "/health", HealthResponse, {
      signal: controller.signal,
    });
    controller.abort(new Error("caller aborted"));
    await expect(request).rejects.toThrow("caller aborted");
    expect(canceled).toHaveBeenCalledOnce();
  });

  it("awaits reader cancellation and contains cancellation rejection", async () => {
    let releaseCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let cancellationStarted!: () => void;
    const cancellationStartedPromise = new Promise<void>((resolve) => {
      cancellationStarted = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
      },
      cancel() {
        cancellationStarted();
        return cancellation;
      },
    });
    const controller = new AbortController();
    const transport = createApiTransport({
      fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
    });
    const request = transport.json("GET /health", "/health", HealthResponse, {
      signal: controller.signal,
    });
    controller.abort(new Error("caller aborted"));
    await cancellationStartedPromise;
    let settled = false;
    void request.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCancellation();
    await expect(request).rejects.toThrow("caller aborted");

    const rejectingBody = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('{"partial":'));
      },
      cancel: () => Promise.reject(new Error("cancel failed")),
    });
    const rejectingTransport = createApiTransport({
      fetch: async () =>
        new Response(rejectingBody, { headers: { "content-type": "application/json" } }),
    });
    const rejectedRequest = rejectingTransport.json("GET /health", "/health", HealthResponse, {
      signal: controller.signal,
    });
    await expect(rejectedRequest).rejects.toThrow("caller aborted");
  });

  it("strictly validates current request bodies before invoking fetch", async () => {
    const fetch = vi.fn<Fetch>(async () => {
      throw new Error("must not run");
    });
    const transport = createApiTransport({ fetch });
    await expect(
      transport.json(
        "PUT /v1/public-sources/:sourceId",
        "/v1/public-sources/source-1",
        UpdateClientPublicSourceRequest,
        {
          json: { enabled: true, unexpected: true },
        },
      ),
    ).rejects.toBeInstanceOf(ApiResponseError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses an injected fetch and resolves relative routes against the configured base", async () => {
    const fetch = vi.fn<Fetch>(async () => Response.json({ ok: true, service: "api" }));
    const transport = createApiTransport({ fetch, baseUrl: "https://api.hartlib.test/root/" });
    await transport.json("GET /health", "/health", HealthResponse);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://api.hartlib.test/health");
  });

  it("accepts direct document media and canonical redirected document media", async () => {
    const redirected = new Response("<html>document</html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    Object.defineProperty(redirected, "redirected", { value: true });
    const invalidRedirected = new Response("not a document", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    Object.defineProperty(invalidRedirected, "redirected", { value: true });
    const responses = [
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
      redirected,
      invalidRedirected,
    ];
    const fetch = vi.fn<Fetch>(async () => responses.shift()!);
    const transport = createApiTransport({ fetch });
    const document = await transport.binary(
      "GET /public-source-documents/:documentId/content",
      "/public-source-documents/doc-1/content",
    );
    expect(await document.text()).toBe("%PDF");
    const issuePath = "/v1/issues/issue-1/documents/doc-1/content";
    const accepted = await transport.redirectedBinary(
      "GET /v1/issues/:issueId/documents/:documentId/content",
      issuePath,
      ["application/pdf", "text/html"],
    );
    expect(await accepted.text()).toContain("document");
    await expect(
      transport.redirectedBinary(
        "GET /v1/issues/:issueId/documents/:documentId/content",
        issuePath,
        ["application/pdf", "text/html"],
      ),
    ).rejects.toMatchObject({ code: "invalid_response_media_type" });
  });
});
