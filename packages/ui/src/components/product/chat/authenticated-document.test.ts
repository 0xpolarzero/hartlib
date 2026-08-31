import { describe, expect, it } from "vitest";
import { publisherDocumentCitationTarget } from "./authenticated-document";

describe("authenticated document targets", () => {
  it("accepts only the canonical issue document route and rejects traversal", () => {
    expect(publisherDocumentCitationTarget("/v1/issues/issue-1/documents/doc-1/content")).toEqual({
      citationUrl: "/v1/issues/issue-1/documents/doc-1/content",
      issueId: "issue-1",
      documentId: "doc-1",
    });
    expect(publisherDocumentCitationTarget("/v1/issues/../documents/doc-1/content")).toBeNull();
    expect(publisherDocumentCitationTarget("https://evil.example/doc.pdf")).toBeNull();
  });
});
