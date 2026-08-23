import { describe, expect, it } from "vitest";

import type { MessageRow, RunRow, SourceRow, SourceUseRow } from "./chat-runtime";
import { chatMessagesResponseFromRows } from "./chat-response";

const assistantMessage: MessageRow = {
  id: "assistant-1",
  author: "assistant",
  content: `Answer [[cite:k_${"cn_" + "A".repeat(22)}_2,k_${"cn_" + "A".repeat(22)}_10]]`,
  created_at: new Date("2026-01-01T00:00:00.000Z"),
};
const citationNamespaceHex = "cn_" + "A".repeat(22);
const integrityDigest = "0".repeat(64);
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
  source_use_identity_digest: integrityDigest,
  source_use_identity_valid: true,
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
  citation_namespace: citationNamespaceHex,
  publisher_extraction_id: null,
  kind: "web",
  locator: { ...webLocator(url), title: sourceKey },
  display_label: null,
  public_provenance: { citationUrl: url },
  source_identity_digest: integrityDigest,
  source_identity_valid: true,
});

const documentSource = (url: string, publisher = false): SourceRow => ({
  assistant_message_id: assistantMessage.id,
  source_key: `k_${"cn_" + "A".repeat(22)}_2`,
  citation_namespace: citationNamespaceHex,
  publisher_extraction_id: publisher ? "publisher-extraction-1" : null,
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
    snapshotId: publisher ? "publisher-version-1" : "public-version-1",
    contentHash: documentContentHash,
    ...(publisher
      ? {
          publisherExtractionId: "publisher-extraction-1",
          publisherIssueId: "123e4567-e89b-12d3-a456-426614174000",
          publisherDocumentId: "223e4567-e89b-12d3-a456-426614174000",
        }
      : {}),
    ranges: [{ charStart: 0, charEnd: 8 }],
  },
  display_label: null,
  source_id: publisher ? "publisher:publisher-source-1" : "public:public-source-1",
  canonical_url: publisher ? null : url,
  document_id: publisher ? "223e4567-e89b-12d3-a456-426614174000" : "public-document-1",
  snapshot_id: publisher ? "publisher-version-1" : "public-version-1",
  content_hash: documentContentHash,
  public_provenance: publisher
    ? {
        sourceName: "Publisher",
        issueTitle: "Issue",
        publishedAt: "2026-01-01T00:00:00.000Z",
        documentTitle: "Document",
        citationUrl: url,
      }
    : { documentTitle: "Document", citationUrl: url },
  source_identity_digest: integrityDigest,
  source_identity_valid: true,
});
const chatMessage = (
  id: string,
  author: MessageRow["author"],
  content: string,
  createdAt: string,
): MessageRow => ({
  id,
  author,
  content,
  created_at: new Date(createdAt),
});

const chatSource = (messageId: string): SourceRow => ({
  assistant_message_id: assistantMessage.id,
  source_key: `k_${citationNamespaceHex}_4`,
  citation_namespace: citationNamespaceHex,
  publisher_extraction_id: null,
  message_id: messageId,
  kind: "chat_message",
  locator: { kind: "chat_message", messageId },
  display_label: null,
  public_provenance: {},
  source_identity_digest: integrityDigest,
  source_identity_valid: true,
});

const reloadChat = (
  sourceMessage: MessageRow,
  ranges: unknown,
  sourceOverrides: Partial<SourceRow> = {},
  sourceUses: readonly SourceUseRow[] = [],
) => {
  const source = { ...chatSource(sourceMessage.id), ...sourceOverrides };
  const runs: readonly RunRow[] =
    sourceMessage.author === "user"
      ? [
          {
            id: `run-${sourceMessage.id}`,
            chat_id: "chat-1",
            user_message_id: sourceMessage.id,
            assistant_message_id: assistantMessage.id,
            started_at: new Date("2025-12-31T23:59:01.000Z"),
            finished_at: new Date("2025-12-31T23:59:02.000Z"),
            failed_at: null,
            error_code: null,
            retryable: null,
          },
        ]
      : [];
  return chatMessagesResponseFromRows(
    [sourceMessage, assistantMessage],
    runs,
    [source],
    sourceUses.length === 0 ? [use(source.source_key, ranges)] : sourceUses,
  );
};

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
      webSource(`k_${"cn_" + "A".repeat(22)}_10`, "https://example.com/ten"),
      webSource(`k_${"cn_" + "A".repeat(22)}_2`, "https://example.com/two"),
    ]);
    expect(response[0]).toMatchObject({
      sourcesRead: [
        { sourceKey: `k_${"cn_" + "A".repeat(22)}_2` },
        { sourceKey: `k_${"cn_" + "A".repeat(22)}_10` },
      ],
    });
    expect(() =>
      reload([webSource(`k_${"cn_" + "A".repeat(22)}_02`, "https://example.com/")]),
    ).toThrow("invalid persisted source key");
  });

  it("accepts only canonical credential-free HTTPS external citations", () => {
    expect(() =>
      reload([webSource(`k_${"cn_" + "A".repeat(22)}_2`, "https://example.com/evidence")]),
    ).not.toThrow();
    for (const url of [
      "http://example.com/evidence",
      "https://user@example.com/evidence",
      "https://localhost/evidence",
      "https://example.com:444/evidence",
      "HTTPS://example.com/evidence",
    ]) {
      expect(() => reload([webSource(`k_${"cn_" + "A".repeat(22)}_2`, url)]), url).toThrow(
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
      reload([{ ...documentSource(valid, true), publisher_extraction_id: "other-version" }]),
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
        snapshot_id: collidingId,
        content_hash: documentContentHash,
        locator: {
          kind: "document",
          sourceId: "public:public-source-1",
          documentId: collidingId,
          snapshotId: collidingId,
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
          publisher_extraction_id: null,
        },
      ]),
    ).toThrow("invalid persisted publisher document provenance");
  });

  it("rechecks strict web provenance on reload", () => {
    const key = `k_${"cn_" + "A".repeat(22)}_2`;
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
      { source_id: "public:other-source" },
      { document_id: "other-document" },
      { snapshot_id: "other-version" },
      { content_hash: "b".repeat(64) },
      {
        source_identity_valid: false,
        public_provenance: {
          documentTitle: "Document",
          citationUrl: "https://public.example/other",
        },
      },
      { canonical_url: "https://public.example/other" },
    ]) {
      expect(() => reload([{ ...valid, ...mutation }]), JSON.stringify(mutation)).toThrow();
    }
  });

  it("rejects rows whose persisted response digest no longer matches", () => {
    const source = webSource(`k_${"cn_" + "A".repeat(22)}_2`, "https://example.com/evidence");
    expect(() =>
      chatMessagesResponseFromRows(
        [assistantMessage],
        [],
        [{ ...source, source_identity_valid: false }],
        [use(source.source_key)],
      ),
    ).toThrow("persisted source identity digest mismatch");
    expect(() =>
      chatMessagesResponseFromRows(
        [assistantMessage],
        [],
        [source],
        [
          {
            ...use(source.source_key),
            source_use_identity_valid: false,
          },
        ],
      ),
    ).toThrow("persisted source use identity digest mismatch");
  });

  it("rejects unknown, non-object, and partial persisted provenance recursively", () => {
    const valid = webSource(`k_${"cn_" + "A".repeat(22)}_2`, "https://example.com/evidence");
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
    const source = webSource(`k_${"cn_" + "A".repeat(22)}_2`, "https://example.com/evidence");
    expect(() => reload([{ ...source, citation_namespace: "cn_" + "B".repeat(22) }])).toThrow(
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
    const source = webSource(`k_${"cn_" + "A".repeat(22)}_2`, "https://example.com/evidence");
    expect(() => chatMessagesResponseFromRows([assistantMessage], [], [source], [])).toThrow(
      "persisted source has no source use",
    );
    expect(() =>
      chatMessagesResponseFromRows(
        [assistantMessage],
        [],
        [],
        [use(`k_${"cn_" + "A".repeat(22)}_2`)],
      ),
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
      content: `Follow-up [[cite:k_${"cn_" + "A".repeat(22)}_3]]`,
      created_at: new Date("2026-01-01T00:01:00.000Z"),
    };
    const firstSource = webSource(`k_${"cn_" + "A".repeat(22)}_2`, "https://example.com/first");
    const secondSource = {
      ...webSource(`k_${"cn_" + "A".repeat(22)}_3`, "https://example.com/second"),
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

  it("reloads exact private chat ranges while keeping the public range projection empty", () => {
    const sourceMessage = chatMessage(
      "user-source-1",
      "user",
      "Earlier evidence 😀 text",
      "2025-12-31T23:59:00.000Z",
    );
    const response = reloadChat(
      sourceMessage,
      [{ charStart: 0, charEnd: sourceMessage.content.length }],
      { source_key: `k_${citationNamespaceHex}_2` },
    );
    expect(response).toMatchObject([
      { id: sourceMessage.id, author: "user" },
      {
        id: assistantMessage.id,
        sourcesRead: [
          {
            kind: "chat_message",
            messageId: sourceMessage.id,
            ranges: [],
          },
        ],
      },
    ]);
    expect(response[1]).toMatchObject({
      citations: [
        { sourceKey: `k_${citationNamespaceHex}_2`, quote: { text: "Earlier evidence 😀 text" } },
      ],
    });
  });

  it("reconstructs a document quote on the server without adding text to sourcesRead", () => {
    const source = documentSource("https://public.example/document");
    const response = reload([{ ...source, document_text: "Evidence" }]);
    expect(response[0]).toMatchObject({
      citations: [{ sourceKey: source.source_key, quote: { text: "Evidence" } }],
      sourcesRead: [{ sourceKey: source.source_key }],
    });
    expect(
      response[0]?.author === "assistant" ? response[0].sourcesRead[0] : null,
    ).not.toHaveProperty("quote");
  });

  it("reconstructs fanout chat quotes from one ordered merged range union", () => {
    const sourceMessage = chatMessage(
      "user-fanout-source",
      "user",
      "abcdefghij",
      "2025-12-31T23:59:00.000Z",
    );
    const assistant = {
      ...assistantMessage,
      content: `Answer [[cite:k_${citationNamespaceHex}_4]]`,
    };
    const source = { ...chatSource(sourceMessage.id), assistant_message_id: assistant.id };
    const response = chatMessagesResponseFromRows(
      [sourceMessage, assistant],
      [
        {
          id: "run-user-fanout-source",
          chat_id: "chat-1",
          user_message_id: sourceMessage.id,
          assistant_message_id: assistant.id,
          started_at: new Date("2025-12-31T23:59:01.000Z"),
          finished_at: new Date("2025-12-31T23:59:02.000Z"),
          failed_at: null,
          error_code: null,
          retryable: null,
        },
      ],
      [source],
      [
        {
          ...use(source.source_key, [{ charStart: 5, charEnd: 10 }], assistant.id),
          consumer_task_id: "topic-t2-answer",
          topic_id: "t2",
          context_order: 0,
          assistant_message_id: assistant.id,
        },
        {
          ...use(source.source_key, [{ charStart: 0, charEnd: 7 }], assistant.id),
          consumer_task_id: "topic-t1-answer",
          topic_id: "t1",
          context_order: 0,
          assistant_message_id: assistant.id,
        },
      ],
    );
    expect(response[1]).toMatchObject({
      citations: [{ sourceKey: source.source_key, quote: { text: "abcdefghij" } }],
    });
  });

  it("rejects empty, paged, overlapping, adjacent, and out-of-bounds chat ranges", () => {
    const sourceMessage = chatMessage(
      "user-source-2",
      "user",
      "Earlier evidence",
      "2025-12-31T23:59:00.000Z",
    );
    for (const ranges of [
      [],
      [{ charStart: 0, charEnd: 1, pageNumber: 1 }],
      [
        { charStart: 0, charEnd: 5 },
        { charStart: 4, charEnd: 8 },
      ],
      [
        { charStart: 0, charEnd: 4 },
        { charStart: 4, charEnd: 8 },
      ],
      [{ charStart: 0, charEnd: sourceMessage.content.length + 1 }],
    ]) {
      expect(() => reloadChat(sourceMessage, ranges), JSON.stringify(ranges)).toThrow(
        /invalid persisted chat message source range/,
      );
    }
  });

  it("rejects chat source identity tampering and foreign source messages", () => {
    const sourceMessage = chatMessage(
      "user-source-3",
      "user",
      "Earlier evidence",
      "2025-12-31T23:59:00.000Z",
    );
    const validRange = [{ charStart: 0, charEnd: sourceMessage.content.length }];
    expect(() =>
      reloadChat(sourceMessage, validRange, {
        locator: { kind: "chat_message", messageId: "tampered-message" },
      }),
    ).toThrow("persisted chat message source identity mismatch");
    expect(() =>
      reloadChat(sourceMessage, validRange, {
        message_id: "foreign-message",
        locator: { kind: "chat_message", messageId: "foreign-message" },
      }),
    ).toThrow("persisted chat message source is missing or not earlier");
  });

  it("sanitizes historical assistant citations but preserves literal user citation text", () => {
    const assistantSource = chatMessage(
      "assistant-source-1",
      "assistant",
      "A [[cite:old]] B [[cite:unterminated",
      "2025-12-31T23:59:00.000Z",
    );
    expect(() =>
      reloadChat(assistantSource, [{ charStart: 0, charEnd: "A  B ".length }]),
    ).not.toThrow();
    expect(() =>
      reloadChat(assistantSource, [{ charStart: 0, charEnd: "A  B ".length + 1 }]),
    ).toThrow("invalid persisted chat message source range");

    const userSource = chatMessage(
      "user-source-4",
      "user",
      "Literal [[cite:old]] text",
      "2025-12-31T23:59:00.000Z",
    );
    expect(() =>
      reloadChat(userSource, [{ charStart: 0, charEnd: userSource.content.length }]),
    ).not.toThrow();
  });

  it("requires zero-based contiguous context order per consumer and canonical topic ownership", () => {
    const sourceTwo = webSource(`k_${"cn_" + "A".repeat(22)}_2`, "https://example.com/two");
    const sourceThree = webSource(`k_${"cn_" + "A".repeat(22)}_3`, "https://example.com/three");
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
