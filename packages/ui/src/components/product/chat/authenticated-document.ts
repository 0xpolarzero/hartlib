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
const route = /^\/v1\/issues\/([^/?#]+)\/documents\/([^/?#]+)\/content$/u;
const opaque = (value: string) => {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && decoded !== "." && decoded !== ".." && !/[\\/]/u.test(decoded)
      ? decoded
      : null;
  } catch {
    return null;
  }
};
export function publisherDocumentCitationTarget(
  citationUrl: string,
): PublisherDocumentCitationTarget | null {
  const match = route.exec(citationUrl);
  if (!match) return null;
  const issueId = opaque(match[1]!);
  const documentId = opaque(match[2]!);
  return issueId && documentId ? { citationUrl, issueId, documentId } : null;
}
export interface AuthenticatedDocumentBrowser {
  openPendingWindow: () => {
    establishNoReferrerPolicy: () => void;
    detachOpener: () => void;
    navigate: (url: string) => void;
    close: () => void;
  } | null;
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  defer: (callback: () => void, milliseconds: number) => void;
}
export const createAuthenticatedDocumentOpener =
  (
    load: PublisherDocumentLoader,
    targetBrowser: AuthenticatedDocumentBrowser,
  ): AuthenticatedDocumentOpener =>
  async (target) => {
    const pending = targetBrowser.openPendingWindow();
    if (!pending) throw new Error("document_popup_blocked");
    let objectUrl: string | null = null;
    try {
      pending.establishNoReferrerPolicy();
      pending.detachOpener();
      const document = await load(target.issueId, target.documentId);
      if (document.kind === "redirected") {
        pending.navigate(document.url);
        return;
      }
      if (
        (document.blob.type !== "application/pdf" && document.blob.type !== "text/html") ||
        document.blob.size === 0
      )
        throw new Error("document_media_type_invalid");
      objectUrl = targetBrowser.createObjectUrl(document.blob);
      pending.navigate(objectUrl);
      const opened = objectUrl;
      targetBrowser.defer(() => targetBrowser.revokeObjectUrl(opened), 300_000);
    } catch (cause) {
      if (objectUrl) targetBrowser.revokeObjectUrl(objectUrl);
      pending.close();
      throw cause;
    }
  };
