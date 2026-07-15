import { describe, expect, it } from "vitest";

import { namespacedDocumentEvidenceIdentity, sha256Base64Url } from "./canonicalization";
import { resolveRegisteredModel } from "./model-registry";
import {
  providerRequestSourceExposureProofs,
  providerVisibleSourceExposureProofSha256Hex,
  type ProviderRequest,
  type ProviderToolCall,
  type ProviderVisibleSourceExposureMarker,
} from "./provider-request";

const model = resolveRegisteredModel("glm-5-turbo");
const countTextTokens = (text: string): number => model.countTextTokens(text);

interface ToolExchange {
  readonly call: ProviderToolCall;
  readonly result: unknown;
}

const requestWithToolResults = (...exchanges: readonly ToolExchange[]): ProviderRequest => ({
  requestClass: "fast",
  model: "glm-5-turbo",
  messages: [
    { role: "system", content: "system" },
    { role: "user", content: "user" },
    ...exchanges.flatMap(({ call, result }) => [
      { role: "assistant" as const, content: "", toolCalls: [call] },
      {
        role: "tool" as const,
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(result),
      },
    ]),
  ],
  requestedOutputTokens: 128,
  reasoning: "medium",
});

const documentSearchExchange = (
  id: string,
  snippet: string,
  marker: ProviderVisibleSourceExposureMarker,
  extra: Readonly<Record<string, unknown>> = {},
): ToolExchange => ({
  call: { id, name: "search_internal", arguments: { query: { target: "documents" } } },
  result: {
    items: [
      {
        kind: "public_source",
        sourceId: "public:source-1",
        documentId: "doc-1",
        documentVersionId: "version-1",
        snippet,
      },
    ],
    complete: true,
    truncated: false,
    cursor: null,
    ...extra,
    __briefSourceExposures: [marker],
  },
});

const documentSearchMarker = (snippet: string): ProviderVisibleSourceExposureMarker => ({
  sourceKind: "document",
  logicalSourceIdentity: namespacedDocumentEvidenceIdentity(
    { kind: "public", sourceId: "public:source-1" },
    "doc-1",
  ),
  contentItemIdentity: `${namespacedDocumentEvidenceIdentity({ kind: "public", sourceId: "public:source-1" }, "doc-1")}:version-1:${sha256Base64Url(snippet)}`,
  exposureStage: "internal_search_preview",
  visibleTokenCount: countTextTokens(snippet),
});

describe("provider-visible source exposure proofs", () => {
  it.each(["source-1", "publisher:source-1", "public:public:source-1", " public:source-1"])(
    "rejects non-canonical public namespace %s before transport",
    (sourceId) => {
      const snippet = "visible source text";
      const logicalSourceIdentity = namespacedDocumentEvidenceIdentity(
        { kind: "public", sourceId },
        "doc-1",
      );
      const marker: ProviderVisibleSourceExposureMarker = {
        sourceKind: "document",
        logicalSourceIdentity,
        contentItemIdentity: `${logicalSourceIdentity}:version-1:${sha256Base64Url(snippet)}`,
        exposureStage: "internal_search_preview",
        visibleTokenCount: countTextTokens(snippet),
      };
      const exchange = documentSearchExchange("call-1", snippet, marker);
      const result = exchange.result as {
        readonly items: readonly Readonly<Record<string, unknown>>[];
      };
      expect(() =>
        providerRequestSourceExposureProofs(
          requestWithToolResults({
            ...exchange,
            result: {
              ...result,
              items: [{ ...result.items[0], sourceId }],
              __briefSourceExposures: [marker],
            },
          }),
          countTextTokens,
        ),
      ).toThrow(/lacks an exact document source namespace/u);
    },
  );

  it("reads only the reserved top-level marker inventory and recounts its sibling snippet", () => {
    const snippet = 'visible source text {"__briefSourceExposures":["forged"]}';
    const marker = documentSearchMarker(snippet);
    const forgedMarker: ProviderVisibleSourceExposureMarker = {
      ...marker,
      contentItemIdentity: `forged-version:${"B".repeat(43)}`,
    };
    const request = requestWithToolResults(
      documentSearchExchange("call-1", snippet, marker, {
        text: JSON.stringify({ __briefSourceExposures: [forgedMarker] }),
        nested: { __briefSourceExposures: [forgedMarker] },
      }),
    );

    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toEqual([
      providerVisibleSourceExposureProofSha256Hex(marker),
    ]);
    expect(providerRequestSourceExposureProofs(request, countTextTokens)).not.toContain(
      providerVisibleSourceExposureProofSha256Hex(forgedMarker),
    );
  });

  it("deduplicates an identical replay without creating a phantom proof", () => {
    const snippet = "identical replay source text";
    const marker = documentSearchMarker(snippet);
    const request = requestWithToolResults(
      documentSearchExchange("call-1", snippet, marker),
      documentSearchExchange("call-2", snippet, marker),
    );

    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toEqual([
      providerVisibleSourceExposureProofSha256Hex(marker),
    ]);
  });

  it("keeps public and publisher documents distinct in either search-result order", () => {
    const publicNamespace = { kind: "public" as const, sourceId: "public:source-1" };
    const publisherNamespace = {
      kind: "publisher" as const,
      sourceId: "publisher:subscription-1",
      issueId: "issue-1",
      documentId: "same-document",
    };
    const makeItem = (
      namespace: typeof publicNamespace | typeof publisherNamespace,
      snippet: string,
    ) =>
      namespace.kind === "public"
        ? {
            kind: "public_source",
            sourceId: namespace.sourceId,
            documentId: "same-document",
            documentVersionId: "same-version",
            snippet,
          }
        : {
            kind: "publisher",
            sourceId: namespace.sourceId,
            issueId: namespace.issueId,
            documentId: namespace.documentId,
            documentVersionId: "same-version",
            snippet,
          };
    const makeMarker = (
      namespace: typeof publicNamespace | typeof publisherNamespace,
      snippet: string,
    ): ProviderVisibleSourceExposureMarker => {
      const logical = namespacedDocumentEvidenceIdentity(namespace, "same-document");
      return {
        sourceKind: "document",
        logicalSourceIdentity: logical,
        contentItemIdentity: `${logical}:same-version:${sha256Base64Url(snippet)}`,
        exposureStage: "internal_search_preview",
        visibleTokenCount: countTextTokens(snippet),
      };
    };
    const publicSnippet = "public collision evidence";
    const publisherSnippet = "publisher collision evidence";
    for (const [firstNamespace, firstSnippet, secondNamespace, secondSnippet] of [
      [publicNamespace, publicSnippet, publisherNamespace, publisherSnippet],
      [publisherNamespace, publisherSnippet, publicNamespace, publicSnippet],
    ] as const) {
      const first = makeMarker(firstNamespace, firstSnippet);
      const second = makeMarker(secondNamespace, secondSnippet);
      expect(
        providerRequestSourceExposureProofs(
          requestWithToolResults({
            call: { id: "collision", name: "search_internal", arguments: {} },
            result: {
              items: [
                makeItem(firstNamespace, firstSnippet),
                makeItem(secondNamespace, secondSnippet),
              ],
              __briefSourceExposures: [first, second],
            },
          }),
          countTextTokens,
        ),
      ).toEqual([first, second].map(providerVisibleSourceExposureProofSha256Hex).sort());
    }
  });

  it("rejects missing or ambiguous document namespaces instead of accepting raw IDs", () => {
    const snippet = "namespace evidence";
    const marker = documentSearchMarker(snippet);
    const valid = documentSearchExchange("valid", snippet, marker);
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolResults({
          ...valid,
          result: {
            ...(valid.result as Record<string, unknown>),
            items: [
              {
                kind: "publisher",
                sourceId: "publisher:subscription-1",
                documentId: "doc-1",
                documentVersionId: "version-1",
                snippet,
              },
            ],
          },
        }),
        countTextTokens,
      ),
    ).toThrow(/exact document source namespace/u);
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolResults({
          ...valid,
          result: {
            ...(valid.result as Record<string, unknown>),
            items: [
              {
                kind: "public_source",
                sourceId: "public:source-1",
                issueId: "unexpected-issue",
                documentId: "doc-1",
                documentVersionId: "version-1",
                snippet,
              },
            ],
          },
        }),
        countTextTokens,
      ),
    ).toThrow(/exact document source namespace/u);
    const rawCandidate: ToolExchange = {
      call: {
        id: "raw-candidate",
        name: "inspect_candidate",
        arguments: { id: "document:doc-1" },
      },
      result: {
        found: true,
        complete: true,
        text: snippet,
        documentId: "doc-1",
        documentVersionId: "version-1",
        source: { kind: "public", sourceId: "public:source-1" },
        ranges: [{ charStart: 0, charEnd: snippet.length }],
        __briefSourceExposures: [marker],
      },
    };
    expect(() =>
      providerRequestSourceExposureProofs(requestWithToolResults(rawCandidate), countTextTokens),
    ).toThrow(/namespaced candidate/u);
  });

  it("rejects a changed visible count even when its ordinary marker proof is recomputed", () => {
    const snippet = "counted source text";
    const marker = documentSearchMarker(snippet);
    const changedCount = { ...marker, visibleTokenCount: marker.visibleTokenCount + 1 };

    expect(providerVisibleSourceExposureProofSha256Hex(changedCount)).not.toBe(
      providerVisibleSourceExposureProofSha256Hex(marker),
    );
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolResults(documentSearchExchange("call-1", snippet, changedCount)),
        countTextTokens,
      ),
    ).toThrow(/marker differs from its exact visible tool-result body/u);
  });

  it("rejects missing, extra, and reordered search markers", () => {
    const firstSnippet = "first search result";
    const secondSnippet = "second search result";
    const first = documentSearchMarker(firstSnippet);
    const second: ProviderVisibleSourceExposureMarker = {
      sourceKind: "chat_message",
      logicalSourceIdentity: "chat_message:message-2",
      contentItemIdentity: "message-2",
      exposureStage: "internal_search_preview",
      visibleTokenCount: countTextTokens(secondSnippet),
    };
    const call: ProviderToolCall = {
      id: "call-1",
      name: "search_internal",
      arguments: { query: { target: "messages" } },
    };
    const result = {
      items: [
        {
          kind: "public_source",
          sourceId: "public:source-1",
          documentId: "doc-1",
          documentVersionId: "version-1",
          snippet: firstSnippet,
        },
        { messageId: "message-2", snippet: secondSnippet },
      ],
      __briefSourceExposures: [second, first],
    };

    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolResults({ call, result }),
        countTextTokens,
      ),
    ).toThrow(/marker differs from its exact visible tool-result body/u);
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolResults({
          call,
          result: { ...result, __briefSourceExposures: [first] },
        }),
        countTextTokens,
      ),
    ).toThrow(/marker cardinality differs/u);
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolResults({
          call,
          result: { ...result, __briefSourceExposures: [first, second, second] },
        }),
        countTextTokens,
      ),
    ).toThrow(/marker cardinality differs/u);
  });

  it("binds document inspection text to the exact referenced range identity", () => {
    const text = "verbatim inspected range";
    const ranges = [{ charStart: 10, charEnd: 34 }];
    const marker: ProviderVisibleSourceExposureMarker = {
      sourceKind: "document",
      logicalSourceIdentity: namespacedDocumentEvidenceIdentity(
        { kind: "public", sourceId: "public:source-1" },
        "doc-1",
      ),
      contentItemIdentity: `${namespacedDocumentEvidenceIdentity({ kind: "public", sourceId: "public:source-1" }, "doc-1")}:version-1:${sha256Base64Url(JSON.stringify(ranges))}`,
      exposureStage: "internal_inspection",
      visibleTokenCount: countTextTokens(text),
    };
    const call: ProviderToolCall = {
      id: "call-1",
      name: "inspect_internal",
      arguments: {
        reference: {
          kind: "document",
          documentId: "doc-1",
          documentVersionId: "version-1",
          source: { kind: "public", sourceId: "public:source-1" },
          ranges,
        },
      },
    };
    const result = {
      found: true,
      complete: true,
      text,
      ranges,
      __briefSourceExposures: [marker],
    };

    expect(
      providerRequestSourceExposureProofs(
        requestWithToolResults({ call, result }),
        countTextTokens,
      ),
    ).toEqual([providerVisibleSourceExposureProofSha256Hex(marker)]);
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolResults({
          call,
          result: { ...result, ranges: [{ charStart: 11, charEnd: 34 }] },
        }),
        countTextTokens,
      ),
    ).toThrow(/marker differs from its exact visible tool-result body/u);
  });

  it("canonicalizes O document range arguments before verifying their body identity", () => {
    const text = "reducer document window";
    const range = { charStart: 5, charEnd: 28 };
    const marker: ProviderVisibleSourceExposureMarker = {
      sourceKind: "document",
      logicalSourceIdentity: namespacedDocumentEvidenceIdentity(
        { kind: "public", sourceId: "public:source-1" },
        "doc-1",
      ),
      contentItemIdentity: `${namespacedDocumentEvidenceIdentity({ kind: "public", sourceId: "public:source-1" }, "doc-1")}:version-1:${sha256Base64Url(JSON.stringify([range]))}`,
      exposureStage: "context_candidate_inspection",
      visibleTokenCount: countTextTokens(text),
    };
    const exchange: ToolExchange = {
      call: {
        id: "call-1",
        name: "inspect_candidate",
        arguments: {
          id: namespacedDocumentEvidenceIdentity(
            { kind: "public", sourceId: "public:source-1" },
            "doc-1",
          ),
          range: { charEnd: 28, charStart: 5 },
        },
      },
      result: {
        found: true,
        complete: true,
        text,
        documentId: "doc-1",
        documentVersionId: "version-1",
        source: { kind: "public", sourceId: "public:source-1" },
        ranges: [range],
        __briefSourceExposures: [marker],
      },
    };

    expect(
      providerRequestSourceExposureProofs(requestWithToolResults(exchange), countTextTokens),
    ).toEqual([providerVisibleSourceExposureProofSha256Hex(marker)]);
  });

  it("binds reducer search previews to exact immutable document ranges", () => {
    const candidateId = namespacedDocumentEvidenceIdentity(
      { kind: "public", sourceId: "public:source-1" },
      "doc-1",
    );
    const previews = [
      {
        range: { charStart: 10, charEnd: 42 },
        text: "Repeated curtailment audit row.",
      },
      {
        range: { charStart: 900, charEnd: 952 },
        text: "Binding conclusion: curtailment fell by 12 percent.",
      },
    ];
    const markers = previews.map(
      ({ range, text }): ProviderVisibleSourceExposureMarker => ({
        sourceKind: "document",
        logicalSourceIdentity: candidateId,
        contentItemIdentity: `${candidateId}:version-1:${sha256Base64Url(JSON.stringify([range]))}`,
        exposureStage: "context_candidate_inspection",
        visibleTokenCount: countTextTokens(text),
      }),
    );
    const result = {
      found: true,
      complete: true,
      documentVersionId: "version-1",
      matches: previews.map(({ range }) => range),
      matchPreviews: previews,
      __briefSourceExposures: markers,
    };
    const exchange: ToolExchange = {
      call: {
        id: "call-1",
        name: "search_within_candidate",
        arguments: { id: candidateId, terms: "curtailment" },
      },
      result,
    };

    expect(
      providerRequestSourceExposureProofs(requestWithToolResults(exchange), countTextTokens),
    ).toEqual(markers.map(providerVisibleSourceExposureProofSha256Hex).sort());
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolResults({
          ...exchange,
          result: {
            ...result,
            matchPreviews: [{ ...previews[0], range: { charStart: 11, charEnd: 42 } }, previews[1]],
          },
        }),
        countTextTokens,
      ),
    ).toThrow(/marker differs from its exact visible tool-result body/u);
  });

  it("requires one exact marker per message in an O conversation inspection", () => {
    const text = "selected memory evidence";
    const marker: ProviderVisibleSourceExposureMarker = {
      sourceKind: "memory",
      logicalSourceIdentity: "memory:memory-1",
      contentItemIdentity: "revision-1",
      exposureStage: "context_candidate_inspection",
      visibleTokenCount: countTextTokens(text),
    };
    const evidenceResult = {
      found: true,
      complete: true,
      text,
      memoryId: "memory-1",
      memoryRevisionId: "revision-1",
      __briefSourceExposures: [marker],
    };
    const evidence: ToolExchange = {
      call: { id: "call-1", name: "inspect_candidate", arguments: { id: "memory:memory-1" } },
      result: evidenceResult,
    };
    const conversation: ToolExchange = {
      call: {
        id: "call-2",
        name: "inspect_candidate",
        arguments: { id: "conversation_entry:turn-1" },
      },
      result: {
        found: true,
        complete: true,
        conversationEntry: {
          turnId: "turn-1",
          userMessageId: "user-1",
          userContent: "conversation user text",
          assistantMessageId: "assistant-1",
          assistantContent: "conversation assistant text",
        },
        __briefSourceExposures: [
          {
            sourceKind: "chat_message",
            logicalSourceIdentity: "chat_message:user-1",
            contentItemIdentity: "user-1",
            exposureStage: "provider_input",
            visibleTokenCount: countTextTokens("conversation user text"),
          },
          {
            sourceKind: "chat_message",
            logicalSourceIdentity: "chat_message:assistant-1",
            contentItemIdentity: "assistant-1",
            exposureStage: "provider_input",
            visibleTokenCount: countTextTokens("conversation assistant text"),
          },
        ],
      },
    };

    const proofs = providerRequestSourceExposureProofs(
      requestWithToolResults(evidence, conversation),
      countTextTokens,
    );
    expect(proofs).toEqual(
      (
        [
          marker,
          {
            sourceKind: "chat_message",
            logicalSourceIdentity: "chat_message:user-1",
            contentItemIdentity: "user-1",
            exposureStage: "provider_input",
            visibleTokenCount: countTextTokens("conversation user text"),
          },
          {
            sourceKind: "chat_message",
            logicalSourceIdentity: "chat_message:assistant-1",
            contentItemIdentity: "assistant-1",
            exposureStage: "provider_input",
            visibleTokenCount: countTextTokens("conversation assistant text"),
          },
        ] as ProviderVisibleSourceExposureMarker[]
      )
        .map(providerVisibleSourceExposureProofSha256Hex)
        .sort(),
    );
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolResults({
          ...evidence,
          result: {
            ...evidenceResult,
            __briefSourceExposures: [
              { ...marker, visibleTokenCount: marker.visibleTokenCount + 1 },
            ],
          },
        }),
        countTextTokens,
      ),
    ).toThrow(/marker differs from its exact visible tool-result body/u);

    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolResults({
          ...conversation,
          result: {
            ...(conversation.result as Record<string, unknown>),
            __briefSourceExposures: [],
          },
        }),
        countTextTokens,
      ),
    ).toThrow(/marker cardinality differs/u);
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolResults({
          ...conversation,
          result: {
            ...(conversation.result as Record<string, unknown>),
            __briefSourceExposures: [
              ...((conversation.result as Record<string, unknown>)
                .__briefSourceExposures as readonly unknown[]),
              {
                sourceKind: "chat_message",
                logicalSourceIdentity: "chat_message:stale",
                contentItemIdentity: "stale",
                exposureStage: "provider_input",
                visibleTokenCount: 1,
              },
            ],
          },
        }),
        countTextTokens,
      ),
    ).toThrow(/marker cardinality differs/u);
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolResults({
          ...conversation,
          result: {
            ...(conversation.result as Record<string, unknown>),
            conversationEntry: {
              ...((conversation.result as Record<string, unknown>).conversationEntry as Record<
                string,
                unknown
              >),
              userMessageId: "stale-user",
            },
          },
        }),
        countTextTokens,
      ),
    ).toThrow(/marker differs from its exact visible tool-result body/u);
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolResults({
          ...conversation,
          result: {
            ...(conversation.result as Record<string, unknown>),
            text: "duplicated conversation body",
          },
        }),
        countTextTokens,
      ),
    ).toThrow(/structured entry body/u);
    expect(
      providerRequestSourceExposureProofs(
        requestWithToolResults({
          call: conversation.call,
          result: { found: true, complete: false, itemTooLarge: true },
        }),
        countTextTokens,
      ),
    ).toEqual([]);
  });

  it("rejects O inspection proofs bound to the wrong immutable version or memory revision", () => {
    const documentText = "document evidence";
    const documentRange = { charStart: 0, charEnd: documentText.length };
    const documentMarker: ProviderVisibleSourceExposureMarker = {
      sourceKind: "document",
      logicalSourceIdentity: namespacedDocumentEvidenceIdentity(
        { kind: "public", sourceId: "public:source-1" },
        "document-1",
      ),
      contentItemIdentity: `${namespacedDocumentEvidenceIdentity({ kind: "public", sourceId: "public:source-1" }, "document-1")}:version-1:${sha256Base64Url(JSON.stringify([documentRange]))}`,
      exposureStage: "context_candidate_inspection",
      visibleTokenCount: countTextTokens(documentText),
    };
    const documentCall: ProviderToolCall = {
      id: "document-call",
      name: "inspect_candidate",
      arguments: {
        id: namespacedDocumentEvidenceIdentity(
          { kind: "public", sourceId: "public:source-1" },
          "document-1",
        ),
        range: documentRange,
      },
    };
    const documentResult = {
      found: true,
      complete: true,
      text: documentText,
      documentId: "document-1",
      documentVersionId: "version-1",
      source: { kind: "public", sourceId: "public:source-1" },
      ranges: [documentRange],
      __briefSourceExposures: [documentMarker],
    };
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolResults({
          call: documentCall,
          result: { ...documentResult, documentVersionId: "version-2" },
        }),
        countTextTokens,
      ),
    ).toThrow(/marker differs from its exact visible tool-result body/u);

    const memoryText = "memory evidence";
    const memoryMarker: ProviderVisibleSourceExposureMarker = {
      sourceKind: "memory",
      logicalSourceIdentity: "memory:memory-1",
      contentItemIdentity: "revision-1",
      exposureStage: "context_candidate_inspection",
      visibleTokenCount: countTextTokens(memoryText),
    };
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolResults({
          call: {
            id: "memory-call",
            name: "inspect_candidate",
            arguments: { id: "memory:memory-1" },
          },
          result: {
            found: true,
            complete: true,
            text: memoryText,
            memoryId: "memory-1",
            memoryRevisionId: "revision-2",
            __briefSourceExposures: [memoryMarker],
          },
        }),
        countTextTokens,
      ),
    ).toThrow(/marker differs from its exact visible tool-result body/u);
  });

  it("rejects the reserved inventory on an unrelated tool", () => {
    const snippet = "unrelated source";
    const marker = documentSearchMarker(snippet);
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolResults({
          call: { id: "call-1", name: "other_tool", arguments: {} },
          result: { __briefSourceExposures: [marker] },
        }),
        countTextTokens,
      ),
    ).toThrow(/reserved marker inventory appeared on an unrelated tool/u);
  });

  it("charges the reserved marker bytes to the exact provider request", () => {
    const snippet = "visible source text";
    const marker = documentSearchMarker(snippet);
    const withoutMarker = requestWithToolResults({
      call: { id: "call-1", name: "other_tool", arguments: {} },
      result: { text: snippet },
    });
    const withMarker = requestWithToolResults({
      call: { id: "call-1", name: "other_tool", arguments: {} },
      result: { text: snippet, __briefSourceExposures: [marker] },
    });

    expect(model.countRequestTokens(withMarker)).toBeGreaterThan(
      model.countRequestTokens(withoutMarker),
    );
  });
});
