import { describe, expect, it } from "vitest";

import type { FinalSourceRecord } from "./types";
import { publicSourceRecordFromFinalSource } from "./public-source";

const documentLocator: Extract<FinalSourceRecord["locator"], { readonly kind: "document" }> = {
  kind: "document",
  sourceId: "public:source-1",
  documentId: "document-1",
  documentVersionId: "version-1",
  contentHash: "hash-1",
  ranges: [{ charStart: 2, charEnd: 9 }],
};

const documentSource: FinalSourceRecord = {
  sourceKey: "k_nonce_1",
  locator: documentLocator,
  label: "Canonical document",
  publicProvenance: {
    documentTitle: "Canonical document",
    citationUrl: "https://example.test/document-1",
  },
  uses: [
    {
      consumerTaskId: "topic-t2-answer",
      topicId: "t2",
      contextOrder: 0,
      renderedTokenCount: 7,
      ranges: [{ charStart: 2, charEnd: 9 }],
    },
    {
      consumerTaskId: "topic-t1-answer",
      topicId: "t1",
      contextOrder: 0,
      renderedTokenCount: 5,
      ranges: [{ charStart: 2, charEnd: 9 }],
    },
  ],
};

describe("canonical public source projection", () => {
  it("projects exact provenance and stable aggregate use metadata", () => {
    expect(publicSourceRecordFromFinalSource(documentSource)).toEqual({
      sourceKey: "k_nonce_1",
      label: "Canonical document",
      tokenCount: 12,
      topicIds: ["t1", "t2"],
      kind: "document",
      documentTitle: "Canonical document",
      url: "https://example.test/document-1",
      ranges: [{ charStart: 2, charEnd: 9 }],
    });
  });

  it("fails closed instead of inventing required document provenance", () => {
    expect(() =>
      publicSourceRecordFromFinalSource({
        ...documentSource,
        publicProvenance: { citationUrl: "https://example.test/document-1" },
      }),
    ).toThrow(/lacks documentTitle/u);
    expect(() =>
      publicSourceRecordFromFinalSource({
        ...documentSource,
        locator: {
          ...documentLocator,
          publisherIssueId: "issue-1",
          publisherDocumentId: "publisher-document-1",
        },
      }),
    ).toThrow(/lacks sourceName/u);
    expect(() =>
      publicSourceRecordFromFinalSource({
        ...documentSource,
        publicProvenance: {
          documentTitle: "Canonical document",
          citationUrl: "https://example.test/document-1",
          unknown: "forged",
        } as never,
      }),
    ).toThrow();
    expect(() =>
      publicSourceRecordFromFinalSource({
        ...documentSource,
        locator: { ...documentLocator, sourceId: "publisher:source-1" },
      }),
    ).toThrow(/not canonical/u);
  });
});
