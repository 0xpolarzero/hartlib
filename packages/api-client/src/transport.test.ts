import { HealthResponse } from "@brief/shared";
import { EXPORT_ARCHIVE_MEDIA_TYPE } from "@brief/shared/export-contract";
import { describe, expect, it, vi } from "vitest";

import {
  API_TEXT_RESPONSE_MAX_BYTES,
  ApiResponseError,
  createApiTransport,
  type Fetch,
} from "./transport";

const testUstarArchive = (): Uint8Array => {
  const encoder = new TextEncoder();
  const header = new Uint8Array(512);
  const body = encoder.encode("{}\n");
  const write = (offset: number, length: number, value: string): void => {
    header.set(encoder.encode(value).subarray(0, length), offset);
  };
  const octal = (value: number, width: number): string =>
    value.toString(8).padStart(width - 1, "0") + "\0";
  write(0, 100, "manifest.json");
  write(100, 8, octal(0o644, 8));
  write(108, 8, octal(0, 8));
  write(116, 8, octal(0, 8));
  write(124, 12, octal(body.byteLength, 12));
  write(136, 12, octal(0, 12));
  header.fill(0x20, 148, 156);
  write(156, 1, "0");
  write(257, 6, "ustar\0");
  write(263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  write(148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
  const archive = new Uint8Array(2048);
  archive.set(header);
  archive.set(body, 512);
  return archive;
};

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
      fetch: async () => Response.json({ ok: true, service: "api" }, { status: 201 }),
    });
    await expect(transport.json("GET /health", "/health", HealthResponse)).rejects.toMatchObject({
      status: 201,
      code: "request_201",
    });
  });

  it("rejects wrong success media types and malformed or excess bodies", async () => {
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

  it("rejects malformed UTF-8 in split success and error bodies without replacement text", async () => {
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
      body: undefined,
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
    const pending = new ReadableStream<Uint8Array>({
      cancel: canceled,
    });
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
    const started = new Promise<void>((resolve) => {
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
    await started;
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

  it("strictly validates request bodies before invoking fetch", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("must not run");
    });
    const transport = createApiTransport({ fetch });
    await expect(
      transport.jsonUnknown("POST /v1/chats", "/v1/chats", {
        json: {
          companyId: "company-1",
          memoryMode: "disabled",
          sourceAccessIds: [],
          unexpected: true,
        },
      }),
    ).rejects.toBeInstanceOf(ApiResponseError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses an injected fetch and resolves relative routes against the configured base", async () => {
    const fetch = vi.fn<Fetch>(async () => Response.json({ ok: true, service: "api" }));
    const transport = createApiTransport({ fetch, baseUrl: "https://api.brief.test/root/" });
    await transport.json("GET /health", "/health", HealthResponse);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://api.brief.test/health");
  });

  it("accepts only the canonical ustar media contract after an export redirect", async () => {
    const makeRedirected = (type: string) => {
      const response = new Response(Uint8Array.from(testUstarArchive()).buffer, {
        status: 200,
        headers: { "content-type": type },
      });
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    };
    const responses = [
      makeRedirected(EXPORT_ARCHIVE_MEDIA_TYPE),
      makeRedirected("application/zip"),
      makeRedirected("application/octet-stream"),
    ];
    const fetch = vi.fn<Fetch>(async () => responses.shift()!);
    const transport = createApiTransport({ fetch });
    const path = "/v1/exports/123e4567-e89b-12d3-a456-426614174000/download";
    const accepted = await transport.redirectedBinary("GET /v1/exports/:exportId/download", path, [
      EXPORT_ARCHIVE_MEDIA_TYPE,
    ]);
    expect(new TextDecoder().decode((await accepted.arrayBuffer()).slice(257, 262))).toBe("ustar");
    const requestHeaders = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get("accept")).toBe(EXPORT_ARCHIVE_MEDIA_TYPE);
    for (const rejectedType of ["application/zip", "application/octet-stream"]) {
      await expect(
        transport.redirectedBinary("GET /v1/exports/:exportId/download", path, [
          EXPORT_ARCHIVE_MEDIA_TYPE,
        ]),
        rejectedType,
      ).rejects.toMatchObject({ code: "invalid_response_media_type" });
    }
  });
});
