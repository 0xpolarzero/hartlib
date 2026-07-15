import { describe, expect, it } from "vitest";

import type { MessageRow, SourceRow, SourceUseRow } from "./chat-runtime";
import { chatMessagesResponseFromRows } from "./chat-response";

const assistantMessage: MessageRow = {
  id: "assistant-1",
  author: "assistant",
  content: `Answer [[cite:k_${"A".repeat(22)}_2,k_${"A".repeat(22)}_10]]`,
  created_at: new Date("2026-01-01T00:00:00.000Z"),
};
const citationNonceHex = "00".repeat(16);
const documentContentHash = "a".repeat(64);

const use = (
  sourceKey: string,
  ranges: unknown = [],
  assistantMessageId = assistantMessage.id,
): SourceUseRow => ({
  assistant_message_id: assistantMessageId,
  source_key: sourceKey,
  consumer_task_id: "single-answer",
  topic_id: null,
  rendered_token_count: 1,
  context_order: 0,
  ranges,
});

const webLocator = (url: string) =>
  ({
    kind: "web",
    title: "source",
    domain: "example.com",
    url,
    capturedAt: "2026-01-01T00:00:00.000Z",
    quote: "Evidence",
    quoteHash: "A4Z66nCsr0xdzjenbPWgTasXFtb_cL8DdhxDnaqL6YQ",
  }) as const;

const webSource = (sourceKey: string, url: string): SourceRow => ({
  assistant_message_id: assistantMessage.id,
  source_key: sourceKey,
  citation_nonce_hex: citationNonceHex,
  publisher_document_version_id: null,
  kind: "web",
  locator: { ...webLocator(url), title: sourceKey },
  display_label: null,
  public_provenance: { citationUrl: url },
});

const documentSource = (url: string, publisher = false): SourceRow => ({
  assistant_message_id: assistantMessage.id,
  source_key: `k_${"A".repeat(22)}_2`,
  citation_nonce_hex: citationNonceHex,
  publisher_document_version_id: publisher ? "publisher-version-1" : null,
  ...(publisher
    ? {
        publisher_document_id: "223e4567-e89b-12d3-a456-426614174000",
        publisher_issue_id: "123e4567-e89b-12d3-a456-426614174000",
      }
    : {}),
  kind: "document",
  locator: {
    kind: "document",
    sourceId: publisher ? "publisher:publisher-source-1" : "public:public-source-1",
    documentId: publisher ? "223e4567-e89b-12d3-a456-426614174000" : "public-document-1",
    documentVersionId: publisher ? "publisher-version-1" : "public-version-1",
    contentHash: documentContentHash,
    ...(publisher
      ? {
          publisherIssueId: "123e4567-e89b-12d3-a456-426614174000",
          publisherDocumentId: "223e4567-e89b-12d3-a456-426614174000",
        }
      : {}),
    ranges: [{ charStart: 0, charEnd: 8 }],
  },
  display_label: null,
  source_id: publisher ? "publisher:publisher-source-1" : "public:public-source-1",
  document_id: publisher ? "223e4567-e89b-12d3-a456-426614174000" : "public-document-1",
  document_version_id: publisher ? "publisher-version-1" : "public-version-1",
  content_hash: documentContentHash,
  canonical_url: url,
  public_provenance: publisher
    ? {
        sourceName: "Publisher",
        issueTitle: "Issue",
        publishedAt: "2026-01-01T00:00:00.000Z",
        documentTitle: "Document",
        citationUrl: url,
      }
    : { documentTitle: "Document", citationUrl: url },
});

const reload = (sources: readonly SourceRow[]) =>
  chatMessagesResponseFromRows(
    [assistantMessage],
    [],
    sources,
    (() => {
      const orderedKeys = [...sources]
        .sort((left, right) => {
          const leftOrdinal = Number(left.source_key.slice(left.source_key.lastIndexOf("_") + 1));
          const rightOrdinal = Number(
            right.source_key.slice(right.source_key.lastIndexOf("_") + 1),
          );
          return leftOrdinal - rightOrdinal;
        })
        .map((source) => source.source_key);
      return sources.map((source) => ({
        ...use(
          source.source_key,
          source.kind === "document" ? (source.locator as { readonly ranges: unknown }).ranges : [],
        ),
        context_order: orderedKeys.indexOf(source.source_key),
      }));
    })(),
  );

describe("chat response reload boundaries", () => {
  it("orders source ordinals numerically and rejects malformed source keys", () => {
    const response = reload([
      webSource(`k_${"A".repeat(22)}_10`, "https://example.com/ten"),
      webSource(`k_${"A".repeat(22)}_2`, "https://example.com/two"),
    ]);
    expect(response[0]).toMatchObject({
      sourcesRead: [
        { sourceKey: `k_${"A".repeat(22)}_2` },
        { sourceKey: `k_${"A".repeat(22)}_10` },
      ],
    });
    expect(() => reload([webSource(`k_${"A".repeat(22)}_02`, "https://example.com/")])).toThrow(
      "invalid persisted source key",
    );
  });

  it("accepts only canonical credential-free HTTPS external citations", () => {
    expect(() =>
      reload([webSource(`k_${"A".repeat(22)}_2`, "https://example.com/evidence")]),
    ).not.toThrow();
    for (const url of [
      "http://example.com/evidence",
      "https://user@example.com/evidence",
      "https://localhost/evidence",
      "https://example.com:444/evidence",
      "HTTPS://example.com/evidence",
    ]) {
      expect(() => reload([webSource(`k_${"A".repeat(22)}_2`, url)]), url).toThrow(
        "invalid persisted source url",
      );
    }
  });

  it("requires indexed publisher identity for in-app document citations", () => {
    const valid =
      "/v1/issues/123e4567-e89b-12d3-a456-426614174000/documents/223e4567-e89b-12d3-a456-426614174000/content";
    expect(() => reload([documentSource(valid, true)])).not.toThrow();
    for (const key of ["sourceName", "issueTitle", "publishedAt"] as const) {
      const malformed = documentSource(valid, true);
      const provenance = { ...(malformed.public_provenance as Record<string, unknown>) };
      delete provenance[key];
      expect(() => reload([{ ...malformed, public_provenance: provenance }]), key).toThrow(
        `invalid persisted source ${key}`,
      );
    }
    expect(() =>
      reload([
        {
          ...documentSource(valid, true),
          public_provenance: {
            ...(documentSource(valid, true).public_provenance as Record<string, unknown>),
            publishedAt: "not-a-date",
          },
        },
      ]),
    ).toThrow("invalid persisted source publishedAt");
    for (const url of [
      "/other/path",
      "//evil.example/path",
      "/\\evil.example/path",
      `${valid}?download=1`,
      `${valid}/extra`,
    ]) {
      expect(() => reload([documentSource(url, true)]), url).toThrow();
    }
    expect(() => reload([documentSource(valid)])).toThrow("invalid persisted source citationUrl");
    expect(() => reload([documentSource("https://public.example/document")])).not.toThrow();
    expect(() =>
      reload([{ ...documentSource(valid, true), publisher_document_version_id: "other-version" }]),
    ).toThrow("invalid persisted publisher document provenance");
  });

  it("keeps a colliding public document ID in the public namespace", () => {
    const collidingId = "223e4567-e89b-12d3-a456-426614174000";
    const source = documentSource("https://public.example/colliding", false);
    const response = reload([
      {
        ...source,
        source_id: "public:public-source-1",
        document_id: collidingId,
        document_version_id: collidingId,
        content_hash: documentContentHash,
        canonical_url: "https://public.example/colliding",
        locator: {
          kind: "document",
          sourceId: "public:public-source-1",
          documentId: collidingId,
          documentVersionId: collidingId,
          contentHash: documentContentHash,
          ranges: [{ charStart: 0, charEnd: 8 }],
        },
      },
    ]);
    expect(response[0]).toMatchObject({
      sourcesRead: [{ kind: "document", url: "https://public.example/colliding" }],
    });
  });

  it("rejects malformed publisher tuple ownership on reload", () => {
    const valid =
      "/v1/issues/123e4567-e89b-12d3-a456-426614174000/documents/223e4567-e89b-12d3-a456-426614174000/content";
    const source = documentSource(valid, true);
    expect(() => reload([{ ...source, publisher_issue_id: "other-issue" }])).toThrow(
      "invalid persisted publisher document provenance",
    );
    expect(() => reload([{ ...source, publisher_document_id: "other-document" }])).toThrow(
      "invalid persisted publisher document provenance",
    );
    expect(() =>
      reload([
        {
          ...source,
          publisher_document_version_id: null,
        },
      ]),
    ).toThrow("invalid persisted publisher document provenance");
  });

  it("rechecks strict web provenance on reload", () => {
    const key = `k_${"A".repeat(22)}_2`;
    const valid = webSource(key, "https://example.com/evidence");
    const validLocator = webLocator("https://example.com/evidence");
    expect(() => reload([valid])).not.toThrow();
    for (const locator of [
      { ...validLocator, domain: "other.example.com" },
      { ...validLocator, quote: "  Evidence  " },
      { ...validLocator, quoteHash: "wrong" },
      { ...validLocator, capturedAt: "not-a-date" },
    ]) {
      expect(() => reload([{ ...valid, locator }]), JSON.stringify(locator)).toThrow(
        "invalid persisted source web provenance",
      );
    }
    expect(() =>
      reload([{ ...valid, public_provenance: { citationUrl: "https://example.com/other" } }]),
    ).toThrow("invalid persisted source web provenance");
  });

  it("binds public document URL and identity to the indexed source row", () => {
    const valid = documentSource("https://public.example/document");
    expect(() => reload([valid])).not.toThrow();
    for (const sourceId of [
      "public-source-1",
      " public:public-source-1",
      "public:public:public-source-1",
      "public:public-source-1\u2003",
      "publisher:subscription-1",
    ]) {
      expect(
        () =>
          reload([
            {
              ...valid,
              source_id: sourceId,
              locator: { ...(valid.locator as Record<string, unknown>), sourceId },
            },
          ]),
        sourceId,
      ).toThrow();
    }
    for (const mutation of [
      { canonical_url: "https://public.example/other" },
      { source_id: "public:other-source" },
      { document_id: "other-document" },
      { document_version_id: "other-version" },
      { content_hash: "b".repeat(64) },
      {
        public_provenance: {
          documentTitle: "Document",
          citationUrl: "https://public.example/other",
        },
      },
    ]) {
      expect(() => reload([{ ...valid, ...mutation }]), JSON.stringify(mutation)).toThrow();
    }
  });

  it("rejects unknown, non-object, and partial persisted provenance recursively", () => {
    const valid = webSource(`k_${"A".repeat(22)}_2`, "https://example.com/evidence");
    for (const publicProvenance of [
      { citationUrl: "https://example.com/evidence", unexpected: true },
      null,
      [],
      { citationUrl: 42 },
    ]) {
      expect(() => reload([{ ...valid, public_provenance: publicProvenance }])).toThrow(
        "invalid persisted source public provenance",
      );
    }
    expect(() =>
      reload([
        {
          ...valid,
          locator: {
            ...(valid.locator as Record<string, unknown>),
            nested: { forged: true },
          },
        },
      ]),
    ).toThrow("invalid persisted source locator");
  });

  it("binds reload source keys to the owning run nonce", () => {
    const source = webSource(`k_${"A".repeat(22)}_2`, "https://example.com/evidence");
    expect(() => reload([{ ...source, citation_nonce_hex: "11".repeat(16) }])).toThrow(
      "persisted source key namespace mismatch",
    );
  });

  it("fails closed for empty, unsorted, overlapping, or adjacent document ranges", () => {
    const valid = documentSource("https://public.example/document");
    const locator = valid.locator as Record<string, unknown>;
    for (const ranges of [
      [],
      [
        { charStart: 8, charEnd: 12 },
        { charStart: 0, charEnd: 4 },
      ],
      [
        { charStart: 0, charEnd: 5 },
        { charStart: 4, charEnd: 8 },
      ],
      [
        { charStart: 0, charEnd: 4 },
        { charStart: 4, charEnd: 8 },
      ],
    ]) {
      expect(() => reload([{ ...valid, locator: { ...locator, ranges } }])).toThrow(
        "invalid persisted source ranges",
      );
    }
  });

  it("requires a complete one-to-one source/use replay ledger", () => {
    const source = webSource(`k_${"A".repeat(22)}_2`, "https://example.com/evidence");
    expect(() => chatMessagesResponseFromRows([assistantMessage], [], [source], [])).toThrow(
      "persisted source has no source use",
    );
    expect(() =>
      chatMessagesResponseFromRows([assistantMessage], [], [], [use(`k_${"A".repeat(22)}_2`)]),
    ).toThrow("persisted source use has no source");
    expect(() =>
      chatMessagesResponseFromRows(
        [assistantMessage],
        [],
        [{ ...source, assistant_message_id: "user-1" }],
        [use(source.source_key)],
      ),
    ).toThrow("persisted source does not belong to an assistant message");
    expect(() =>
      chatMessagesResponseFromRows(
        [assistantMessage],
        [],
        [source],
        [use(source.source_key), use(source.source_key)],
      ),
    ).toThrow("duplicate persisted source use consumer");
  });

  it("resets context order for each assistant message consumer ledger", () => {
    const secondAssistant: MessageRow = {
      ...assistantMessage,
      id: "assistant-2",
      content: `Follow-up [[cite:k_${"A".repeat(22)}_3]]`,
      created_at: new Date("2026-01-01T00:01:00.000Z"),
    };
    const firstSource = webSource(`k_${"A".repeat(22)}_2`, "https://example.com/first");
    const secondSource = {
      ...webSource(`k_${"A".repeat(22)}_3`, "https://example.com/second"),
      assistant_message_id: secondAssistant.id,
    };
    const response = chatMessagesResponseFromRows(
      [assistantMessage, secondAssistant],
      [],
      [firstSource, secondSource],
      [use(firstSource.source_key), use(secondSource.source_key, [], secondAssistant.id)],
    );
    expect(response).toHaveLength(2);
    expect(response[0]).toMatchObject({
      id: assistantMessage.id,
      sourcesRead: [{ sourceKey: firstSource.source_key }],
    });
    expect(response[1]).toMatchObject({
      id: secondAssistant.id,
      sourcesRead: [{ sourceKey: secondSource.source_key }],
    });
  });

  it("validates document use ranges against the exact page-aware locator union", () => {
    const source = documentSource("https://public.example/document");
    const sourceKey = source.source_key;
    for (const ranges of [
      [],
      [
        { charStart: 1, charEnd: 4 },
        { charStart: 3, charEnd: 6 },
      ],
      [{ charStart: 8, charEnd: 9 }],
      [{ pageNumber: 1, charStart: 0, charEnd: 4 }],
    ]) {
      expect(() =>
        chatMessagesResponseFromRows([assistantMessage], [], [source], [use(sourceKey, ranges)]),
      ).toThrow(
        /invalid persisted source ranges|persisted source use ranges|persisted source use range exceeds source locator/,
      );
    }

    const pagedSource: SourceRow = {
      ...source,
      locator: {
        ...(source.locator as Record<string, unknown>),
        ranges: [{ pageNumber: 2, charStart: 0, charEnd: 8 }],
      },
    };
    expect(() =>
      chatMessagesResponseFromRows(
        [assistantMessage],
        [],
        [pagedSource],
        [use(sourceKey, [{ pageNumber: 2, charStart: 0, charEnd: 8 }])],
      ),
    ).not.toThrow();
    expect(() =>
      chatMessagesResponseFromRows(
        [assistantMessage],
        [],
        [pagedSource],
        [use(sourceKey, [{ charStart: 2, charEnd: 4 }])],
      ),
    ).toThrow("persisted source use range exceeds source locator");

    const splitUses: SourceUseRow[] = [
      {
        ...use(sourceKey, [{ charStart: 0, charEnd: 4 }]),
        consumer_task_id: "topic-t1-answer",
        topic_id: "t1",
      },
      {
        ...use(sourceKey, [{ charStart: 4, charEnd: 8 }]),
        consumer_task_id: "topic-t2-answer",
        topic_id: "t2",
      },
    ];
    expect(() =>
      chatMessagesResponseFromRows([assistantMessage], [], [source], splitUses),
    ).not.toThrow();

    const locatorGap: SourceRow = {
      ...source,
      locator: {
        ...(source.locator as Record<string, unknown>),
        ranges: [
          { charStart: 0, charEnd: 4 },
          { charStart: 8, charEnd: 12 },
        ],
      },
    };
    expect(() =>
      chatMessagesResponseFromRows(
        [assistantMessage],
        [],
        [locatorGap],
        [use(sourceKey, [{ charStart: 0, charEnd: 4 }])],
      ),
    ).toThrow("persisted source use ranges do not cover source locator");
  });

  it("requires zero-based contiguous context order per consumer and canonical topic ownership", () => {
    const sourceTwo = webSource(`k_${"A".repeat(22)}_2`, "https://example.com/two");
    const sourceThree = webSource(`k_${"A".repeat(22)}_3`, "https://example.com/three");
    expect(() =>
      chatMessagesResponseFromRows(
        [assistantMessage],
        [],
        [sourceTwo, sourceThree],
        [use(sourceTwo.source_key), { ...use(sourceThree.source_key), context_order: 2 }],
      ),
    ).toThrow("persisted source use context order is not contiguous");
    expect(() =>
      chatMessagesResponseFromRows(
        [assistantMessage],
        [],
        [sourceTwo, sourceThree],
        [
          use(sourceTwo.source_key),
          { ...use(sourceThree.source_key), context_order: 1, topic_id: "t1" },
        ],
      ),
    ).toThrow("invalid persisted source use topic ownership");
  });
});
