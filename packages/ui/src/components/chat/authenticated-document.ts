export interface PublisherDocumentCitationTarget {
  readonly citationUrl: string;
  readonly issueId: string;
  readonly documentId: string;
}

export type AuthenticatedDocumentOpener = (
  target: PublisherDocumentCitationTarget,
) => Promise<void>;

export type AuthenticatedPublisherDocument =
  | { readonly kind: "redirected"; readonly url: string }
  | { readonly kind: "direct"; readonly blob: Blob };

export type PublisherDocumentLoader = (
  issueId: string,
  documentId: string,
) => Promise<AuthenticatedPublisherDocument>;

const publisherDocumentCitationPattern =
  /^\/v1\/issues\/([^/?#]+)\/documents\/([^/?#]+)\/content$/u;

const decodeOpaquePathSegment = (value: string): string | null => {
  try {
    const decoded = decodeURIComponent(value);
    return decoded !== "" && decoded !== "." && decoded !== ".." && !/[\\/]/u.test(decoded)
      ? decoded
      : null;
  } catch {
    return null;
  }
};

/** Recognize only Hartlib's relative, authorized publisher-document route. */
export const publisherDocumentCitationTarget = (
  citationUrl: string,
): PublisherDocumentCitationTarget | null => {
  const match = publisherDocumentCitationPattern.exec(citationUrl);
  if (match === null) return null;
  const issueId = decodeOpaquePathSegment(match[1]!);
  const documentId = decodeOpaquePathSegment(match[2]!);
  if (issueId === null || documentId === null) return null;
  return { citationUrl, issueId, documentId };
};

interface PendingDocumentWindow {
  readonly establishNoReferrerPolicy: () => void;
  readonly detachOpener: () => void;
  readonly navigate: (url: string) => void;
  readonly close: () => void;
}

export interface AuthenticatedDocumentBrowser {
  readonly openPendingWindow: () => PendingDocumentWindow | null;
  readonly createObjectUrl: (blob: Blob) => string;
  readonly revokeObjectUrl: (url: string) => void;
  readonly defer: (callback: () => void, milliseconds: number) => void;
}

const defaultDocumentBrowser = (): AuthenticatedDocumentBrowser => ({
  openPendingWindow: () => {
    const opened = window.open("about:blank", "_blank");
    if (opened === null) return null;
    return {
      establishNoReferrerPolicy: () => {
        const meta = opened.document.createElement("meta");
        meta.name = "referrer";
        meta.content = "no-referrer";
        const head = opened.document.head;
        if (head === null) throw new Error("document_pending_head_unavailable");
        head.append(meta);
      },
      detachOpener: () => {
        opened.opener = null;
      },
      navigate: (url) => {
        const anchor = opened.document.createElement("a");
        anchor.href = url;
        anchor.rel = "noopener noreferrer";
        anchor.referrerPolicy = "no-referrer";
        anchor.style.display = "none";
        const body = opened.document.body;
        if (body === null) throw new Error("document_pending_body_unavailable");
        body.append(anchor);
        anchor.click();
      },
      close: () => opened.close(),
    };
  },
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  defer: (callback, milliseconds) => {
    window.setTimeout(callback, milliseconds);
  },
});

/**
 * Open an authenticated PDF in a pending tab created synchronously from the
 * trusted click. Redirects navigate to the API-verified signed URL; only a
 * direct PDF response uses a short-lived local blob URL.
 */
export const createAuthenticatedDocumentOpener =
  (
    load: PublisherDocumentLoader,
    browser: AuthenticatedDocumentBrowser = defaultDocumentBrowser(),
  ): AuthenticatedDocumentOpener =>
  (target) => {
    const pending = browser.openPendingWindow();
    if (pending === null) return Promise.reject(new Error("document_popup_blocked"));
    try {
      pending.establishNoReferrerPolicy();
      pending.detachOpener();
    } catch (cause) {
      pending.close();
      return Promise.reject(cause);
    }

    return (async () => {
      let objectUrl: string | null = null;
      try {
        const document = await load(target.issueId, target.documentId);
        if (document.kind === "redirected") {
          pending.navigate(document.url);
          return;
        }
        if (document.blob.type !== "application/pdf" || document.blob.size === 0) {
          throw new Error("document_media_type_invalid");
        }
        objectUrl = browser.createObjectUrl(document.blob);
        pending.navigate(objectUrl);
        const openedObjectUrl = objectUrl;
        browser.defer(() => browser.revokeObjectUrl(openedObjectUrl), 5 * 60 * 1_000);
      } catch (cause) {
        if (objectUrl !== null) browser.revokeObjectUrl(objectUrl);
        pending.close();
        throw cause;
      }
    })();
  };
