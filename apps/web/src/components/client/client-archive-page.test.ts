import { afterEach, describe, expect, it, vi } from "vitest";

import { setApiTokenProvider } from "@/lib/api-auth";

import { openAuthorizedArchiveContent, openAuthorizedPdfDocument } from "./client-archive-page";

describe("authorized archive content viewer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setApiTokenProvider(async () => null);
  });

  it("opens a target synchronously and fills it with the authorized PDF", async () => {
    const close = vi.fn();
    const location = { href: "about:blank", replace: vi.fn() };
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/pdf" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      open: vi.fn(() => ({ opener: {}, location, close })),
      setTimeout: vi.fn(),
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:authorized-pdf");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    await openAuthorizedPdfDocument("/v1/issues/issue-1/documents/document-1/content");

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/issues/issue-1/documents/document-1/content",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(location.href).toBe("blob:authorized-pdf");
    expect(close).not.toHaveBeenCalled();
  });

  it("opens the API-authorized final PDF redirect without creating a second blob", async () => {
    const location = { href: "about:blank", replace: vi.fn() };
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "application/pdf" },
    });
    Object.defineProperties(response, {
      redirected: { value: true },
      url: { value: "https://objects.example.test/signed.pdf?expires=300" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    vi.stubGlobal("window", {
      open: vi.fn(() => ({ opener: {}, location, close: vi.fn() })),
    });
    const createObjectUrl = vi.spyOn(URL, "createObjectURL");

    await openAuthorizedPdfDocument("/v1/issues/issue-1/documents/document-1/content");

    expect(location.href).toBe("https://objects.example.test/signed.pdf?expires=300");
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("rejects a plaintext non-loopback object-store redirect", async () => {
    const close = vi.fn();
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "application/pdf" },
    });
    Object.defineProperties(response, {
      redirected: { value: true },
      url: { value: "http://objects.example.test/signed.pdf?expires=300" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    vi.stubGlobal("window", {
      open: vi.fn(() => ({
        opener: {},
        location: { href: "about:blank", replace: vi.fn() },
        close,
      })),
    });

    await expect(openAuthorizedPdfDocument("/v1/private-document")).rejects.toThrow(
      "document_redirect_invalid",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("navigates HTML to the same-origin API route without copying it into a blob", async () => {
    const replace = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      open: vi.fn(() => ({ opener: {}, location: { replace }, close: vi.fn() })),
    });
    const createObjectUrl = vi.spyOn(URL, "createObjectURL");

    await openAuthorizedArchiveContent({
      contentPath: "/public-source-documents/public-document-1/content",
      mediaType: "text/html",
    });

    expect(replace).toHaveBeenCalledWith("/public-source-documents/public-document-1/content");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("does not access a document when the browser blocks the viewer", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { open: vi.fn(() => null) });

    await expect(openAuthorizedPdfDocument("/v1/private-document")).rejects.toThrow(
      "archive_content_popup_blocked",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes the viewer when authorization fails", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({}, { status: 403 })),
    );
    vi.stubGlobal("window", {
      open: vi.fn(() => ({ opener: {}, location: { replace: vi.fn() }, close })),
    });

    await expect(openAuthorizedPdfDocument("/v1/private-document")).rejects.toThrow(
      "document_open_403",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects a PDF response whose media type does not match its descriptor", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("<p>not a PDF</p>", { headers: { "content-type": "text/html" } }),
      ),
    );
    vi.stubGlobal("window", {
      open: vi.fn(() => ({ opener: {}, location: { replace: vi.fn() }, close })),
    });

    await expect(openAuthorizedPdfDocument("/v1/private-document")).rejects.toThrow(
      "document_media_type_mismatch",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects a redirected PDF with a non-network final URL", async () => {
    const close = vi.fn();
    const response = new Response(new Uint8Array([1]), {
      headers: { "content-type": "application/pdf" },
    });
    Object.defineProperties(response, {
      redirected: { value: true },
      url: { value: "data:application/pdf;base64,AA==" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    vi.stubGlobal("window", {
      open: vi.fn(() => ({ opener: {}, location: { replace: vi.fn() }, close })),
    });

    await expect(openAuthorizedPdfDocument("/v1/private-document")).rejects.toThrow(
      "document_redirect_invalid",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not navigate HTML when its viewer popup is blocked", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { open: vi.fn(() => null) });

    await expect(
      openAuthorizedArchiveContent({
        contentPath: "/public-source-documents/public-document-1/content",
        mediaType: "text/html",
      }),
    ).rejects.toThrow("archive_content_popup_blocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
