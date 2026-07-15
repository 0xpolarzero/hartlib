import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAuthenticatedDocumentOpener,
  publisherDocumentCitationTarget,
  type AuthenticatedDocumentBrowser,
} from "./authenticated-document";

describe("authenticated publisher-document citations", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("recognizes only the exact relative authorized content route", () => {
    expect(
      publisherDocumentCitationTarget("/v1/issues/issue%201/documents/document%201/content"),
    ).toEqual({
      citationUrl: "/v1/issues/issue%201/documents/document%201/content",
      issueId: "issue 1",
      documentId: "document 1",
    });
    for (const value of [
      "https://brief.example/v1/issues/i/documents/d/content",
      "//evil.example/v1/issues/i/documents/d/content",
      "/v1/issues/i/documents/d/content?token=secret",
      "/v1/issues/i/documents/%2F/content",
      "/public-source-documents/d/content",
    ]) {
      expect(publisherDocumentCitationTarget(value)).toBeNull();
    }
  });

  it("opens a verified redirect after establishing no-referrer and detaching the opener", async () => {
    const calls: string[] = [];
    const navigate = vi.fn((url: string) => calls.push(`navigate:${url}`));
    const close = vi.fn();
    const pending = {
      establishNoReferrerPolicy: () => calls.push("no-referrer"),
      detachOpener: () => calls.push("detach-opener"),
      navigate,
      close,
    };
    const deferred: Array<() => void> = [];
    const revokeObjectUrl = vi.fn();
    const browser: AuthenticatedDocumentBrowser = {
      openPendingWindow: () => pending,
      createObjectUrl: () => "blob:brief-document",
      revokeObjectUrl,
      defer: (callback, milliseconds) => {
        expect(milliseconds).toBe(300_000);
        deferred.push(callback);
      },
    };
    const load = vi.fn(async () => ({
      kind: "redirected" as const,
      url: "https://objects.example/signed.pdf?expires=300",
    }));
    const open = createAuthenticatedDocumentOpener(load, browser);

    await open({
      citationUrl: "/v1/issues/issue-1/documents/document-1/content",
      issueId: "issue-1",
      documentId: "document-1",
    });

    expect(load).toHaveBeenCalledWith("issue-1", "document-1");
    expect(calls).toEqual([
      "no-referrer",
      "detach-opener",
      "navigate:https://objects.example/signed.pdf?expires=300",
    ]);
    expect(close).not.toHaveBeenCalled();
    expect(deferred).toEqual([]);
    expect(revokeObjectUrl).not.toHaveBeenCalled();
  });

  it("uses and revokes a local object URL only for a direct PDF response", async () => {
    const navigate = vi.fn();
    const deferred: Array<() => void> = [];
    const revokeObjectUrl = vi.fn();
    const browser: AuthenticatedDocumentBrowser = {
      openPendingWindow: () => ({
        establishNoReferrerPolicy: vi.fn(),
        detachOpener: vi.fn(),
        navigate,
        close: vi.fn(),
      }),
      createObjectUrl: () => "blob:brief-document",
      revokeObjectUrl,
      defer: (callback, milliseconds) => {
        expect(milliseconds).toBe(300_000);
        deferred.push(callback);
      },
    };
    await createAuthenticatedDocumentOpener(
      async () => ({
        kind: "direct",
        blob: new Blob(["%PDF-1.7"], { type: "application/pdf" }),
      }),
      browser,
    )({
      citationUrl: "/v1/issues/i/documents/d/content",
      issueId: "i",
      documentId: "d",
    });

    expect(navigate).toHaveBeenCalledWith("blob:brief-document");
    deferred[0]?.();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:brief-document");
  });

  it("writes an actual no-referrer policy into the pending browser document", async () => {
    const meta: { name?: string; content?: string } = {};
    const anchor = {
      href: "",
      rel: "",
      referrerPolicy: "",
      style: { display: "" },
      click: vi.fn(),
    };
    const appendHead = vi.fn();
    const appendBody = vi.fn();
    const opened = {
      document: {
        createElement: vi.fn((tagName: string) => (tagName === "meta" ? meta : anchor)),
        head: { append: appendHead },
        body: { append: appendBody },
      },
      opener: {},
      close: vi.fn(),
    };
    vi.stubGlobal("window", { open: vi.fn(() => opened), setTimeout: vi.fn() });

    await createAuthenticatedDocumentOpener(async () => ({
      kind: "redirected",
      url: "https://objects.example/signed.pdf",
    }))({
      citationUrl: "/v1/issues/i/documents/d/content",
      issueId: "i",
      documentId: "d",
    });

    expect(meta).toEqual({ name: "referrer", content: "no-referrer" });
    expect(appendHead).toHaveBeenCalledWith(meta);
    expect(opened.opener).toBeNull();
    expect(anchor).toMatchObject({
      href: "https://objects.example/signed.pdf",
      rel: "noopener noreferrer",
      referrerPolicy: "no-referrer",
      style: { display: "none" },
    });
    expect(appendBody).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledOnce();
  });

  it("closes the pending tab for a loader failure, invalid media, or blocked popup", async () => {
    const close = vi.fn();
    const browser: AuthenticatedDocumentBrowser = {
      openPendingWindow: () => ({
        establishNoReferrerPolicy: vi.fn(),
        detachOpener: vi.fn(),
        navigate: vi.fn(),
        close,
      }),
      createObjectUrl: () => "blob:invalid",
      revokeObjectUrl: vi.fn(),
      defer: vi.fn(),
    };
    const target = {
      citationUrl: "/v1/issues/i/documents/d/content",
      issueId: "i",
      documentId: "d",
    };
    await expect(
      createAuthenticatedDocumentOpener(
        async () => ({ kind: "direct", blob: new Blob(["html"], { type: "text/html" }) }),
        browser,
      )(target),
    ).rejects.toThrow("document_media_type_invalid");
    expect(close).toHaveBeenCalledOnce();

    await expect(
      createAuthenticatedDocumentOpener(async () => ({ kind: "direct", blob: new Blob(["pdf"]) }), {
        ...browser,
        openPendingWindow: () => null,
      })(target),
    ).rejects.toThrow("document_popup_blocked");
  });
});
