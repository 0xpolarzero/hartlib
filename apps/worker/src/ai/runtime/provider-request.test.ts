import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  chatMessageEvidenceIdentity,
  namespacedDocumentEvidenceIdentity,
  sha256Base64Url,
} from "./canonicalization";
import { resolveRegisteredModel } from "./model-registry";
import {
  providerRequestSourceExposureProofs,
  providerRequestSourceExposureProofBindings,
  providerSourceExposureProofFromToolResult,
  providerVisibleSourceExposureProofSha256Hex,
  requireLiveProviderRequest,
  toGlmTemplateInput,
  type CodeOwnedSourceExposureProof,
  type ProviderRequest,
  type ProviderToolCall,
  type ProviderVisibleSourceExposureProofBinding,
  type ProviderVisibleSourceExposureMarker,
} from "./provider-request";

const model = resolveRegisteredModel("glm-5-turbo");
const countTextTokens = (text: string): number => model.countTextTokens(text);
const immutableHash = (text: string): string => createHash("sha256").update(text).digest("hex");
const rangeIdentityHash = (
  ranges: readonly { readonly charStart: number; readonly charEnd: number }[],
): string => sha256Base64Url(JSON.stringify(ranges));

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

const answerSource = (key: string, kind: string, text: string): string =>
  `<source key="${key}" kind="${kind}" length="${text.length}">\n${text}\n</source>`;

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
        kind: "document",
        documentId: "doc-1",
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
  it("changes the bound digest when a proof moves serialized fields", () => {
    const marker = documentSearchMarker("bound source");
    const binding = (serializedField: string): ProviderVisibleSourceExposureProofBinding => ({
      messageIndex: 2,
      sourceOrdinal: 0,
      serializedField,
      orderedSourceDescriptor: "document:ordered:0",
    });
    expect(
      providerVisibleSourceExposureProofSha256Hex(
        marker,
        binding("messages[2].content.items[0].snippet"),
      ),
    ).not.toBe(
      providerVisibleSourceExposureProofSha256Hex(
        marker,
        binding("messages[2].content.items[1].snippet"),
      ),
    );
  });

  it("rejects legacy or unchecked document identity fields before transport", () => {
    const snippet = "visible source text";
    const marker = documentSearchMarker(snippet);
    const exchange = documentSearchExchange("call-1", snippet, marker);
    const result = exchange.result as {
      readonly items: readonly Readonly<Record<string, unknown>>[];
    };
    for (const field of ["sourceId", "versionId", "contentHash"]) {
      expect(() =>
        providerRequestSourceExposureProofs(
          requestWithToolResults({
            ...exchange,
            result: {
              ...result,
              items: [{ ...result.items[0], [field]: "unchecked" }],
              __briefSourceExposures: [marker],
            },
          }),
          countTextTokens,
        ),
      ).toThrow(/legacy or unchecked identity field/u);
    }
  });

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

    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(1);
    expect(providerRequestSourceExposureProofs(request, countTextTokens)).not.toContain(
      providerVisibleSourceExposureProofSha256Hex(forgedMarker),
    );
  });

  it("rejects a top-level document marker whose immutable content hash drifts", () => {
    const snippet = "search marker body";
    const marker = documentSearchMarker(snippet);
    const drifted = {
      ...marker,
      contentItemIdentity: `${marker.logicalSourceIdentity}:version-1:${sha256Base64Url(
        "different body",
      )}`,
    };
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolResults(documentSearchExchange("call-1", snippet, drifted)),
        countTextTokens,
      ),
    ).toThrow(/exact visible tool-result body|sidecar does not match/u);
  });

  it("verifies the code-owned sidecar against stripped tool results", () => {
    const snippet = "sidecar source text";
    const logical = namespacedDocumentEvidenceIdentity(
      { kind: "public", sourceId: "public:sidecar" },
      "doc-1",
    );
    const call: ProviderToolCall = {
      id: "call-1",
      name: "search_internal",
      arguments: { query: { target: "documents" } },
    };
    const fullResult = {
      items: [
        {
          kind: "document",
          documentId: "doc-1",
          snippet,
          __briefSourceIdentity: {
            versionId: "version-1",
            contentHash: immutableHash("complete immutable document"),
            ranges: [{ charStart: 0, charEnd: snippet.length }],
            source: { kind: "public", sourceId: "public:sidecar" },
          },
        },
      ],
      complete: true,
      __briefSourceExposures: [
        {
          sourceKind: "document",
          logicalSourceIdentity: logical,
          contentItemIdentity: `${logical}:version-1:${rangeIdentityHash([{ charStart: 0, charEnd: snippet.length }])}`,
          exposureStage: "internal_search_preview",
          visibleTokenCount: countTextTokens(snippet),
        },
      ],
    };
    const proof = providerSourceExposureProofFromToolResult(
      call.name,
      fullResult,
      call,
      countTextTokens,
    )[0]!;
    const result = {
      ...fullResult,
      items: [
        {
          kind: "document",
          documentId: "doc-1",
          snippet,
          ranges: [{ charStart: 0, charEnd: snippet.length }],
        },
      ],
    };
    delete (result as Record<string, unknown>).__briefSourceExposures;
    const request = {
      ...requestWithToolResults({ call, result }),
      sourceExposureProofs: [proof],
    } satisfies ProviderRequest;

    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(1);
    expect(() =>
      providerRequestSourceExposureProofs(
        {
          ...request,
          sourceExposureProofs: [{ ...proof, visibleTokenCount: proof.visibleTokenCount + 1 }],
        },
        countTextTokens,
      ),
    ).toThrow(/sidecar|tokenizer/u);
  });

  it("recounts out-of-band conversation proofs without sending their text", () => {
    const text = "conversation content kept in the code-owned proof inventory";
    const marker = {
      ...documentSearchMarker(text),
      sourceKind: "chat_message" as const,
      logicalSourceIdentity: "chat_message:message-1",
      contentItemIdentity: "message-1",
      exposureStage: "provider_input",
      visibleText: text,
    };
    const request = {
      requestClass: "fast" as const,
      model: "glm-5-turbo" as const,
      messages: [{ role: "user" as const, content: JSON.stringify({ currentMessage: text }) }],
      requestedOutputTokens: 64,
      reasoning: "medium" as const,
      sourceExposureProofs: [marker],
    } satisfies ProviderRequest;

    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(1);
    expect(toGlmTemplateInput(request).messages).not.toContainEqual(
      expect.objectContaining({ content: expect.stringContaining("visibleText") }),
    );
    expect(() =>
      providerRequestSourceExposureProofs(
        {
          ...request,
          sourceExposureProofs: [{ ...marker, visibleTokenCount: marker.visibleTokenCount + 1 }],
        },
        countTextTokens,
      ),
    ).toThrow(/tokenizer count/u);
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
            kind: "document",
            documentId: "same-document",
            snippet,
          }
        : {
            kind: "document",
            documentId: namespace.documentId,
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
      ).toEqual(
        [first, second].map((marker) => providerVisibleSourceExposureProofSha256Hex(marker)).sort(),
      );
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
            items: [{ kind: "document", documentId: "doc-1", snippet, source: {} }],
          },
        }),
        countTextTokens,
      ),
    ).toThrow(/legacy or unchecked identity field/u);
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
        versionId: "version-1",
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
      exposureStage: "internal_chat_search_preview",
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
          kind: "document",
          documentId: "doc-1",
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
          purpose: "answer",
          range: ranges[0],
        },
      },
    };
    const result = {
      found: true,
      complete: true,
      documentId: "doc-1",
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
    ).toThrow(/range differs|marker differs from its exact visible tool-result body/u);
  });

  it("accepts the live redacted inspect_internal document shape with sidecar identity", () => {
    const source = "prefix redacted internal inspection suffix";
    const charStart = source.indexOf("redacted");
    const text = source.slice(charStart, charStart + "redacted internal inspection".length);
    const ranges = [{ charStart, charEnd: charStart + text.length }];
    const logical = namespacedDocumentEvidenceIdentity(
      { kind: "public", sourceId: "public:source-1" },
      "doc-1",
    );
    const call: ProviderToolCall = {
      id: "redacted-inspect",
      name: "inspect_internal",
      arguments: {
        reference: {
          kind: "document",
          documentId: "doc-1",
          purpose: "answer",
          range: ranges[0],
        },
      },
    };
    const fullResult = {
      found: true,
      complete: true,
      documentId: "doc-1",
      text,
      ranges,
      __briefSourceIdentity: {
        versionId: "version-1",
        contentHash: immutableHash(source),
        source: { kind: "public", sourceId: "public:source-1" },
      },
      __briefSourceExposures: [
        {
          sourceKind: "document",
          logicalSourceIdentity: logical,
          contentItemIdentity: `${logical}:version-1:${sha256Base64Url(JSON.stringify(ranges))}`,
          exposureStage: "internal_inspection",
          visibleTokenCount: countTextTokens(text),
        },
      ],
    };
    const proof = providerSourceExposureProofFromToolResult(
      call.name,
      fullResult,
      call,
      countTextTokens,
    )[0]!;
    const redactedResult = { found: true, complete: true, documentId: "doc-1", text, ranges };
    const request = {
      ...requestWithToolResults({ call, result: redactedResult }),
      sourceExposureProofs: [proof],
    } satisfies ProviderRequest;
    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(1);
    expect(() =>
      providerRequestSourceExposureProofs(
        {
          ...request,
          messages: request.messages.map((message) =>
            message.role === "tool"
              ? {
                  ...message,
                  content: JSON.stringify({
                    found: true,
                    complete: true,
                    documentId: "doc-2",
                    text,
                    ranges,
                  }),
                }
              : message,
          ),
        },
        countTextTokens,
      ),
    ).toThrow(/visible document ID/u);
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
        versionId: "version-1",
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
    const source =
      "Repeated curtailment audit row. Binding conclusion: curtailment fell by 12 percent. Tail.";
    const firstEnd = source.indexOf(". ") + 1;
    const secondEnd = source.indexOf(". Tail") + 1;
    const previews = [
      {
        range: { charStart: 0, charEnd: firstEnd },
        text: source.slice(0, firstEnd),
      },
      {
        range: { charStart: firstEnd + 2, charEnd: secondEnd },
        text: source.slice(firstEnd + 2, secondEnd),
      },
    ];
    const matches = [
      {
        charStart: source.indexOf("curtailment"),
        charEnd: source.indexOf("curtailment") + "curtailment".length,
      },
      {
        charStart: source.lastIndexOf("curtailment"),
        charEnd: source.lastIndexOf("curtailment") + "curtailment".length,
      },
    ];
    const scope = { charStart: 0, charEnd: source.length };
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
      kind: "document",
      documentId: "doc-1",
      versionId: "version-1",
      source: { kind: "public", sourceId: "public:source-1" },
      scope: {
        kind: "selected_document_ranges",
        ranges: [scope],
        matchOffset: 0,
        maximumMatches: 500,
      },
      matches,
      matchPreviews: previews,
      __briefSourceIdentity: {
        versionId: "version-1",
        contentHash: immutableHash(source),
        source: { kind: "public", sourceId: "public:source-1" },
      },
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

    const proofs = providerSourceExposureProofFromToolResult(
      exchange.call.name,
      result,
      exchange.call,
      countTextTokens,
    );
    const redactedResult = {
      found: true,
      complete: true,
      kind: "document",
      documentId: "doc-1",
      scope: result.scope,
      matches,
      matchPreviews: previews,
    };
    const redactedRequest = {
      ...requestWithToolResults({ ...exchange, result: redactedResult }),
      sourceExposureProofs: proofs,
    } satisfies ProviderRequest;
    expect(providerRequestSourceExposureProofs(redactedRequest, countTextTokens)).toHaveLength(2);
    const bindings = providerRequestSourceExposureProofBindings(redactedRequest, countTextTokens);
    expect(
      bindings.every(
        (binding) =>
          providerVisibleSourceExposureProofSha256Hex(binding.marker, binding.binding) ===
          binding.providerSerializationProofSha256Hex,
      ),
    ).toBe(true);
    expect(() =>
      providerRequestSourceExposureProofs(
        {
          ...redactedRequest,
          messages: redactedRequest.messages.map((message) =>
            message.role === "tool"
              ? {
                  ...message,
                  content: JSON.stringify({
                    ...redactedResult,
                    scope: {
                      ...redactedResult.scope,
                      ranges: [{ charStart: 0, charEnd: source.length - 1 }],
                    },
                  }),
                }
              : message,
          ),
        },
        countTextTokens,
      ),
    ).toThrow(/immutable|scope|marker differs|commitment/u);
    expect(() =>
      providerRequestSourceExposureProofs(
        {
          ...redactedRequest,
          messages: redactedRequest.messages.map((message) =>
            message.role === "tool"
              ? {
                  ...message,
                  content: JSON.stringify({
                    ...redactedResult,
                    matches: [
                      { charStart: matches[0]!.charStart + 1, charEnd: matches[0]!.charEnd + 1 },
                      matches[1],
                    ],
                  }),
                }
              : message,
          ),
        },
        countTextTokens,
      ),
    ).toThrow(/immutable|exact match|sidecar/u);
    const mutateRedacted = (mutated: Readonly<Record<string, unknown>>) => ({
      ...redactedRequest,
      messages: redactedRequest.messages.map((message) =>
        message.role === "tool" ? { ...message, content: JSON.stringify(mutated) } : message,
      ),
    });
    const redactedScope = redactedResult.scope as Readonly<Record<string, unknown>>;
    const redactedScopeRanges = redactedScope.ranges as readonly Readonly<Record<string, number>>[];
    const redactedScopeRange = redactedScopeRanges[0]!;
    const scopeStart = redactedScopeRange.charStart as number;
    const scopeEnd = redactedScopeRange.charEnd as number;
    const secondPreview = previews[1]!;
    for (const mutation of [
      { ...redactedResult, documentId: "doc-2" },
      {
        ...redactedResult,
        scope: { ...redactedScope, kind: "complete_candidate" },
      },
      {
        ...redactedResult,
        scope: { ...redactedScope, matchOffset: 1 },
      },
      {
        ...redactedResult,
        scope: { ...redactedScope, maximumMatches: 499 },
      },
      {
        ...redactedResult,
        scope: {
          ...redactedScope,
          ranges: [{ ...redactedScopeRange, charStart: scopeStart + 1 }],
        },
      },
      {
        ...redactedResult,
        scope: {
          ...redactedScope,
          ranges: [{ ...redactedScopeRange, charEnd: scopeEnd - 1 }],
        },
      },
      {
        ...redactedResult,
        matches: [{ ...matches[0]!, charStart: matches[0]!.charStart + 1 }, matches[1]],
      },
      {
        ...redactedResult,
        matches: [{ ...matches[0]!, charEnd: matches[0]!.charEnd + 1 }, matches[1]],
      },
      { ...redactedResult, matches: [matches[1], matches[0]] },
      {
        ...redactedResult,
        matchPreviews: [
          previews[0],
          {
            ...secondPreview,
            range: { ...secondPreview.range, charStart: secondPreview.range.charStart - 1 },
          },
        ],
      },
      {
        ...redactedResult,
        matchPreviews: [
          previews[0],
          {
            ...secondPreview,
            range: { ...secondPreview.range, charEnd: secondPreview.range.charEnd + 1 },
          },
        ],
      },
      {
        ...redactedResult,
        matchPreviews: [
          previews[0],
          { ...secondPreview, text: `${secondPreview.text.slice(0, -1)}X` },
        ],
      },
    ]) {
      expect(() =>
        providerRequestSourceExposureProofs(mutateRedacted(mutation), countTextTokens),
      ).toThrow(/exact|scope|canonical|immutable|commitment|sidecar/u);
    }
    for (const mutation of [
      {
        ...proofs[0]!,
        logicalSourceIdentity: proofs[0]!.logicalSourceIdentity.replace("source-1", "source-2"),
      },
      {
        ...proofs[0]!,
        contentItemIdentity: proofs[0]!.contentItemIdentity.replace("version-1", "version-2"),
      },
      { ...proofs[0]!, immutableContentHash: immutableHash("different complete body") },
      { ...proofs[0]!, immutableSourceIdentityCommitment: "C".repeat(43) },
      { ...proofs[0]!, immutableSourceCommitment: "D".repeat(43) },
    ]) {
      expect(() =>
        providerRequestSourceExposureProofs(
          { ...redactedRequest, sourceExposureProofs: [mutation, proofs[1]!] },
          countTextTokens,
        ),
      ).toThrow(/identity|commitment|sidecar|descriptor/u);
    }
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

    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolResults({
          ...conversation,
          call: { ...conversation.call, arguments: {} },
        }),
        countTextTokens,
      ),
    ).toThrow(/lacks its candidate identity/u);

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
        .map((marker) => providerVisibleSourceExposureProofSha256Hex(marker))
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
            conversationEntry: {
              ...((conversation.result as Record<string, unknown>).conversationEntry as Record<
                string,
                unknown
              >),
              turnId: "turn-2",
            },
          },
        }),
        countTextTokens,
      ),
    ).toThrow(/conversation entry differs from its candidate/u);
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
      versionId: "version-1",
      source: { kind: "public", sourceId: "public:source-1" },
      ranges: [documentRange],
      __briefSourceExposures: [documentMarker],
    };
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolResults({
          call: documentCall,
          result: { ...documentResult, versionId: "version-2" },
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

  it("rejects reserved marker bytes at the provider boundary", () => {
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

    expect(() => model.countRequestTokens(withMarker)).toThrow(
      /code-owned and must not cross the provider boundary/u,
    );
    expect(model.countRequestTokens(withoutMarker)).toBeGreaterThan(0);
  });

  it("rejects equal-token document snippets whose ordered identities are swapped", () => {
    const firstText = "alpha beta";
    const secondText = "gamma delta";
    expect(countTextTokens(firstText)).toBe(countTextTokens(secondText));
    const call: ProviderToolCall = { id: "call-1", name: "search_internal", arguments: {} };
    const firstLogical = namespacedDocumentEvidenceIdentity(
      { kind: "public", sourceId: "public:ordered-a" },
      "doc-1",
    );
    const secondLogical = namespacedDocumentEvidenceIdentity(
      { kind: "public", sourceId: "public:ordered-b" },
      "doc-2",
    );
    const markers = [
      {
        sourceKind: "document" as const,
        logicalSourceIdentity: firstLogical,
        contentItemIdentity: `${firstLogical}:version-1:${rangeIdentityHash([{ charStart: 0, charEnd: firstText.length }])}`,
        exposureStage: "internal_search_preview",
        visibleTokenCount: countTextTokens(firstText),
      },
      {
        sourceKind: "document" as const,
        logicalSourceIdentity: secondLogical,
        contentItemIdentity: `${secondLogical}:version-1:${rangeIdentityHash([{ charStart: 0, charEnd: secondText.length }])}`,
        exposureStage: "internal_search_preview",
        visibleTokenCount: countTextTokens(secondText),
      },
    ];
    const base = requestWithToolResults({
      call,
      result: {
        items: [
          {
            kind: "document",
            documentId: "doc-1",
            snippet: firstText,
            __briefSourceIdentity: {
              versionId: "version-1",
              contentHash: immutableHash("first complete body"),
              ranges: [{ charStart: 0, charEnd: firstText.length }],
              source: { kind: "public", sourceId: "public:ordered-a" },
            },
          },
          {
            kind: "document",
            documentId: "doc-2",
            snippet: secondText,
            __briefSourceIdentity: {
              versionId: "version-1",
              contentHash: immutableHash("second complete body"),
              ranges: [{ charStart: 0, charEnd: secondText.length }],
              source: { kind: "public", sourceId: "public:ordered-b" },
            },
          },
        ],
        __briefSourceExposures: markers,
      },
    });
    const fullResult = JSON.parse(base.messages.at(-1)!.content) as Record<string, unknown>;
    const proofs = providerSourceExposureProofFromToolResult(
      call.name,
      fullResult,
      call,
      countTextTokens,
    );
    const redacted = {
      items: [
        {
          kind: "document",
          documentId: "doc-1",
          snippet: firstText,
          ranges: [{ charStart: 0, charEnd: firstText.length }],
        },
        {
          kind: "document",
          documentId: "doc-2",
          snippet: secondText,
          ranges: [{ charStart: 0, charEnd: secondText.length }],
        },
      ],
    };
    const redactedRequest = {
      ...requestWithToolResults({ call, result: redacted }),
      sourceExposureProofs: proofs,
    } satisfies ProviderRequest;
    expect(providerRequestSourceExposureProofs(redactedRequest, countTextTokens)).toHaveLength(2);
    expect(() =>
      providerRequestSourceExposureProofs(
        { ...redactedRequest, sourceExposureProofs: [proofs[1]!, proofs[0]!] },
        countTextTokens,
      ),
    ).toThrow(/sidecar does not match/u);
  });

  it("rejects one repeated sidecar proof from covering two stripped locations", () => {
    const snippet = "same visible snippet";
    const marker: ProviderVisibleSourceExposureMarker = {
      sourceKind: "chat_message",
      logicalSourceIdentity: "chat_message:repeated-message",
      contentItemIdentity: "repeated-message",
      exposureStage: "internal_chat_search_preview",
      visibleTokenCount: countTextTokens(snippet),
    };
    const exchange = (callId: string): ToolExchange => ({
      call: { id: callId, name: "search_internal", arguments: {} },
      result: {
        items: [{ kind: "chat_message", messageId: "repeated-message", snippet }],
      },
    });
    const request = requestWithToolResults(exchange("call-1"), exchange("call-2"));
    expect(() =>
      providerRequestSourceExposureProofs(
        { ...request, sourceExposureProofs: [marker] },
        countTextTokens,
      ),
    ).toThrow(/missing proof/u);
    expect(
      providerRequestSourceExposureProofs(
        { ...request, sourceExposureProofs: [marker, marker] },
        countTextTokens,
      ),
    ).toHaveLength(1);
  });

  it("accepts equal document text when immutable source identities differ", () => {
    const snippet = "equal-token document text";
    const publicLogical = namespacedDocumentEvidenceIdentity(
      { kind: "public", sourceId: "public:source-1" },
      "same-doc",
    );
    const publisherLogical = namespacedDocumentEvidenceIdentity(
      {
        kind: "publisher",
        sourceId: "publisher:subscription-1",
        issueId: "issue-1",
        documentId: "same-doc",
      },
      "same-doc",
    );
    const markerFor = (logicalSourceIdentity: string): ProviderVisibleSourceExposureMarker => ({
      sourceKind: "document",
      logicalSourceIdentity,
      contentItemIdentity: `${logicalSourceIdentity}:version-1:${rangeIdentityHash([{ charStart: 0, charEnd: snippet.length }])}`,
      exposureStage: "internal_search_preview",
      visibleTokenCount: countTextTokens(snippet),
    });
    const first = markerFor(publicLogical);
    const second = markerFor(publisherLogical);
    const call: ProviderToolCall = { id: "call-1", name: "search_internal", arguments: {} };
    const fullResult = {
      items: [
        {
          kind: "document",
          documentId: "same-doc",
          snippet,
          __briefSourceIdentity: {
            versionId: "version-1",
            contentHash: immutableHash("public immutable body"),
            ranges: [{ charStart: 0, charEnd: snippet.length }],
            source: { kind: "public", sourceId: "public:source-1" },
          },
        },
        {
          kind: "document",
          documentId: "same-doc",
          snippet,
          __briefSourceIdentity: {
            versionId: "version-1",
            contentHash: immutableHash("publisher immutable body"),
            ranges: [{ charStart: 0, charEnd: snippet.length }],
            publisherExtractionId: "extract-1",
            source: {
              kind: "publisher",
              sourceId: "publisher:subscription-1",
              issueId: "issue-1",
              documentId: "same-doc",
            },
          },
        },
      ],
      __briefSourceExposures: [first, second],
    };
    const proofs = providerSourceExposureProofFromToolResult(
      call.name,
      fullResult,
      call,
      countTextTokens,
    );
    const request = requestWithToolResults({
      call,
      result: {
        items: [
          {
            kind: "document",
            documentId: "same-doc",
            snippet,
            ranges: [{ charStart: 0, charEnd: snippet.length }],
          },
          {
            kind: "document",
            documentId: "same-doc",
            snippet,
            ranges: [{ charStart: 0, charEnd: snippet.length }],
          },
        ],
      },
    });
    expect(
      providerRequestSourceExposureProofs(
        { ...request, sourceExposureProofs: proofs },
        countTextTokens,
      ),
    ).toHaveLength(2);
  });

  it("rejects a proof that appears only as a coincidental substring", () => {
    const proof: CodeOwnedSourceExposureProof = {
      sourceKind: "chat_message",
      logicalSourceIdentity: "chat_message:message-1",
      contentItemIdentity: "message-1",
      exposureStage: "provider_input",
      visibleTokenCount: countTextTokens("needle"),
      visibleText: "needle",
    };
    const request: ProviderRequest = {
      requestClass: "fast",
      model: "glm-5-turbo",
      messages: [{ role: "user", content: JSON.stringify({ text: "prefix needle suffix" }) }],
      requestedOutputTokens: 64,
      reasoning: "medium",
      sourceExposureProofs: [proof],
    };
    expect(() => providerRequestSourceExposureProofs(request, countTextTokens)).toThrow(
      /exact normalized request field/u,
    );
  });

  it("changes the durable sidecar proof when the same source moves fields", () => {
    const text = "field-bound source";
    const proof: CodeOwnedSourceExposureProof = {
      sourceKind: "chat_message",
      logicalSourceIdentity: "chat_message:message-1",
      contentItemIdentity: "message-1",
      exposureStage: "provider_input",
      visibleTokenCount: countTextTokens(text),
      visibleText: text,
    };
    const makeRequest = (field: "currentMessage" | "originalMessage"): ProviderRequest => ({
      requestClass: "fast",
      model: "glm-5-turbo",
      messages: [{ role: "user", content: JSON.stringify({ [field]: text }) }],
      requestedOutputTokens: 64,
      reasoning: "medium",
      sourceExposureProofs: [proof],
    });
    expect(
      providerRequestSourceExposureProofs(makeRequest("currentMessage"), countTextTokens),
    ).not.toEqual(
      providerRequestSourceExposureProofs(makeRequest("originalMessage"), countTextTokens),
    );
  });

  it("binds an explicitly identified current message and rejects identity drift", () => {
    const text = "current message body";
    const proof: CodeOwnedSourceExposureProof = {
      sourceKind: "chat_message",
      logicalSourceIdentity: "chat_message:current-1",
      contentItemIdentity: "current-1",
      exposureStage: "provider_input",
      visibleTokenCount: countTextTokens(text),
      visibleText: text,
    };
    const request: ProviderRequest = {
      requestClass: "fast",
      model: "glm-5-turbo",
      messages: [
        {
          role: "user",
          content: JSON.stringify({ currentMessageId: "current-1", currentMessage: text }),
        },
      ],
      requestedOutputTokens: 64,
      reasoning: "medium",
      sourceExposureProofs: [proof],
    };
    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(1);
    expect(() =>
      providerRequestSourceExposureProofs(
        { ...request, sourceExposureProofs: [{ ...proof, contentItemIdentity: "current-2" }] },
        countTextTokens,
      ),
    ).toThrow(/chat proof identity/u);
    expect(() =>
      providerRequestSourceExposureProofs(
        {
          ...request,
          sourceExposureProofs: [
            {
              ...proof,
              logicalSourceIdentity: "chat_message:current-2",
              contentItemIdentity: "current-2",
            },
          ],
        },
        countTextTokens,
      ),
    ).toThrow(/ordered source descriptor/u);
  });

  it("rejects a web proof whose quote hash does not match its visible text", () => {
    const quote = "exact web quote";
    const url = "https://example.com/drift";
    const proof: CodeOwnedSourceExposureProof = {
      sourceKind: "web",
      logicalSourceIdentity: `web:${url}:${sha256Base64Url("other quote")}`,
      contentItemIdentity: `${url}:${sha256Base64Url("other quote")}`,
      exposureStage: "answer_serialized",
      visibleTokenCount: countTextTokens(quote),
      visibleText: quote,
    };
    const request: ProviderRequest = {
      requestClass: "main",
      model: "glm-5-turbo",
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            evidence: `<source key="k_cn_ABCDEFGHIJKLMNOPQRSTUV_1" kind="web" length="${quote.length}">\n${quote}\n</source>`,
          }),
        },
      ],
      requestedOutputTokens: 64,
      reasoning: "medium",
      sourceExposureProofs: [proof],
    };
    expect(() => providerRequestSourceExposureProofs(request, countTextTokens)).toThrow(
      /web proof identity/u,
    );
  });

  it("rejects hidden exposure inventories at the live provider boundary", () => {
    const request: ProviderRequest = {
      requestClass: "fast",
      model: "glm-5-turbo",
      messages: [
        {
          role: "tool",
          toolCallId: "call-1",
          name: "search_internal",
          content: JSON.stringify({
            items: [],
            __briefSourceExposures: [],
          }),
        },
      ],
      requestedOutputTokens: 64,
      reasoning: "medium",
    };
    expect(() => requireLiveProviderRequest(request)).toThrow(/must not cross/u);
  });

  it("rejects every private source field recursively at the live provider boundary", () => {
    const requestWithContent = (content: unknown): ProviderRequest => ({
      requestClass: "fast",
      model: "glm-5-turbo",
      messages: [
        {
          role: "tool",
          toolCallId: "call-1",
          name: "inspect_candidate",
          content: JSON.stringify(content),
        },
      ],
      requestedOutputTokens: 64,
      reasoning: "medium",
    });
    const forbiddenFields = [
      "__briefSourceExposures",
      "__briefSourceIdentity",
      "versionId",
      "contentHash",
      "publisherExtractionId",
      "source",
    ] as const;

    for (const field of forbiddenFields) {
      expect(() => requireLiveProviderRequest(requestWithContent({ [field]: "hidden" }))).toThrow(
        /private source identity is code-owned and must not cross/u,
      );
      expect(() =>
        requireLiveProviderRequest(
          requestWithContent({ safe: [{ nested: { [field]: "hidden" } }] }),
        ),
      ).toThrow(/private source identity is code-owned and must not cross/u);
    }

    const safe = requestWithContent({
      versionIdentifier: "visible",
      contentHashAlgorithm: "sha256",
      publisherExtractionIdentifier: "visible",
      sourceName: "Visible source",
      sourceUrl: "https://example.com/source",
      text: "source versionId contentHash publisherExtractionId",
      nested: [{ sourceLabel: "Visible" }],
    });
    expect(requireLiveProviderRequest(safe)).toBe(safe);
    expect(toGlmTemplateInput(safe).messages.at(-1)?.content).toContain(
      '"sourceName":"Visible source"',
    );
  });

  it("rejects missing, extra, and duplicate-location sidecar proofs", () => {
    const text = "one exact source";
    const marker = documentSearchMarker(text);
    const exchange = documentSearchExchange("call-1", text, marker);
    const strippedResult = { ...(exchange.result as Record<string, unknown>) };
    delete strippedResult.__briefSourceExposures;
    const base = requestWithToolResults({ ...exchange, result: strippedResult });
    expect(() =>
      providerRequestSourceExposureProofs({ ...base, sourceExposureProofs: [] }, countTextTokens),
    ).toThrow(/missing proof/u);
    expect(() =>
      providerRequestSourceExposureProofs(
        {
          ...base,
          sourceExposureProofs: [
            marker,
            { ...marker, contentItemIdentity: `${marker.contentItemIdentity}:extra` },
          ],
        },
        countTextTokens,
      ),
    ).toThrow(/extra proof|exact ordered/u);

    const first: CodeOwnedSourceExposureProof = {
      sourceKind: "chat_message",
      logicalSourceIdentity: "chat_message:message-1",
      contentItemIdentity: "message-1",
      exposureStage: "provider_input",
      visibleTokenCount: countTextTokens(text),
      visibleText: text,
    };
    const second: CodeOwnedSourceExposureProof = {
      ...first,
      logicalSourceIdentity: "chat_message:message-2",
      contentItemIdentity: "message-2",
    };
    expect(() =>
      providerRequestSourceExposureProofs(
        {
          ...base,
          messages: [{ role: "user", content: JSON.stringify({ currentMessage: text }) }],
          sourceExposureProofs: [first, second],
        },
        countTextTokens,
      ),
    ).toThrow(/extra proof|duplicate normalized request location/u);
  });

  it("binds valid conversation, memory, and web exposures to their ordered fields", () => {
    const current = "current conversation";
    const priorUser = "prior user";
    const priorAssistant = "prior assistant";
    const conversationProofs: readonly CodeOwnedSourceExposureProof[] = [
      {
        sourceKind: "chat_message",
        logicalSourceIdentity: "chat_message:current-user",
        contentItemIdentity: "current-user",
        exposureStage: "provider_input",
        visibleTokenCount: countTextTokens(current),
        visibleText: current,
      },
      {
        sourceKind: "chat_message",
        logicalSourceIdentity: "chat_message:prior-user",
        contentItemIdentity: "prior-user",
        exposureStage: "provider_input",
        visibleTokenCount: countTextTokens(priorUser),
        visibleText: priorUser,
      },
      {
        sourceKind: "chat_message",
        logicalSourceIdentity: "chat_message:prior-assistant",
        contentItemIdentity: "prior-assistant",
        exposureStage: "provider_input",
        visibleTokenCount: countTextTokens(priorAssistant),
        visibleText: priorAssistant,
      },
    ];
    const memoryText = "memory body";
    const memoryMarker: ProviderVisibleSourceExposureMarker = {
      sourceKind: "memory",
      logicalSourceIdentity: "memory:memory-1",
      contentItemIdentity: "revision-1",
      exposureStage: "memory_tool_result",
      visibleTokenCount: countTextTokens(memoryText),
    };
    const webText = "web preview";
    const webUrl = "https://example.com/article";
    const webMarker: ProviderVisibleSourceExposureMarker = {
      sourceKind: "web",
      logicalSourceIdentity: webUrl,
      contentItemIdentity: `${webUrl}:${sha256Base64Url(webText)}`,
      exposureStage: "web_search_preview",
      visibleTokenCount: countTextTokens(webText),
    };
    const request = requestWithToolResults(
      {
        call: { id: "memory-call", name: "search_memories", arguments: {} },
        result: {
          items: [{ memoryId: "memory-1", memoryRevisionId: "revision-1", content: memoryText }],
        },
      },
      {
        call: { id: "web-call", name: "web_search", arguments: {} },
        result: { results: [{ url: webUrl, snippet: webText }] },
      },
    );
    const withConversation: ProviderRequest = {
      ...request,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            currentMessage: current,
            entries: [
              {
                turnId: "turn-1",
                userMessageId: "prior-user",
                userContent: priorUser,
                assistantMessageId: "prior-assistant",
                assistantContent: priorAssistant,
              },
            ],
          }),
        },
        ...request.messages,
      ],
      sourceExposureProofs: [...conversationProofs, memoryMarker, webMarker],
    };
    expect(providerRequestSourceExposureProofs(withConversation, countTextTokens)).toHaveLength(5);
  });

  it("validates marker inventories for memory and web tool results without a sidecar", () => {
    const memoryText = "memory marker text";
    const memoryMarker: ProviderVisibleSourceExposureMarker = {
      sourceKind: "memory",
      logicalSourceIdentity: "memory:memory-1",
      contentItemIdentity: "revision-1",
      exposureStage: "memory_tool_result",
      visibleTokenCount: countTextTokens(memoryText),
    };
    const webText = "web marker text";
    const webUrl = "https://example.com/marker";
    const webMarker: ProviderVisibleSourceExposureMarker = {
      sourceKind: "web",
      logicalSourceIdentity: webUrl,
      contentItemIdentity: `${webUrl}:${sha256Base64Url(webText)}`,
      exposureStage: "web_search_preview",
      visibleTokenCount: countTextTokens(webText),
    };
    expect(
      providerRequestSourceExposureProofs(
        requestWithToolResults(
          {
            call: { id: "memory-call", name: "search_memories", arguments: {} },
            result: {
              items: [
                {
                  memoryId: "memory-1",
                  memoryRevisionId: "revision-1",
                  content: memoryText,
                },
              ],
              __briefSourceExposures: [memoryMarker],
            },
          },
          {
            call: { id: "web-call", name: "web_search", arguments: {} },
            result: {
              results: [{ url: webUrl, snippet: webText }],
              __briefSourceExposures: [webMarker],
            },
          },
        ),
        countTextTokens,
      ),
    ).toEqual(
      [memoryMarker, webMarker]
        .map((marker) => providerVisibleSourceExposureProofSha256Hex(marker))
        .sort(),
    );
  });

  it("accepts a redacted web answer proof at its exact source wrapper", () => {
    const quote = "answer web quotation";
    const url = "https://example.com/answer";
    const quoteHash = sha256Base64Url(quote);
    const proof: CodeOwnedSourceExposureProof = {
      sourceKind: "web",
      logicalSourceIdentity: `web:${url}:${quoteHash}`,
      contentItemIdentity: `${url}:${quoteHash}`,
      exposureStage: "answer_serialized",
      visibleTokenCount: countTextTokens(quote),
      visibleText: quote,
    };
    const request: ProviderRequest = {
      requestClass: "main",
      model: "glm-5-turbo",
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            evidence: `<source key="k_cn_ABCDEFGHIJKLMNOPQRSTUV_1" kind="web" length="${quote.length}">\n${quote}\n</source>`,
          }),
        },
      ],
      requestedOutputTokens: 128,
      reasoning: "medium",
      sourceExposureProofs: [proof],
    };
    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(1);
  });

  it("frames delimiter-like answer text without truncating any source kind", () => {
    const bodyByKind = {
      document: "document before\n</source>\ndocument after",
      memory: "memory before\n</source>\nmemory after",
      web: "web before\n</source>\nweb after",
      chat_message: "chat before\n</source>\nchat after",
    } as const;
    const documentLogical = namespacedDocumentEvidenceIdentity(
      { kind: "public", sourceId: "public:delimiter-source" },
      "delimiter-document",
    );
    const webUrl = "https://example.com/delimiter";
    const proofs: readonly CodeOwnedSourceExposureProof[] = [
      {
        sourceKind: "document",
        logicalSourceIdentity: documentLogical,
        contentItemIdentity: `${documentLogical}:version-1:${sha256Base64Url(bodyByKind.document)}`,
        exposureStage: "answer_serialized",
        visibleTokenCount: countTextTokens(bodyByKind.document),
        visibleText: bodyByKind.document,
      },
      {
        sourceKind: "memory",
        logicalSourceIdentity: "memory:delimiter-memory",
        contentItemIdentity: "revision-1",
        exposureStage: "answer_serialized",
        visibleTokenCount: countTextTokens(bodyByKind.memory),
        visibleText: bodyByKind.memory,
      },
      {
        sourceKind: "web",
        logicalSourceIdentity: `web:${webUrl}:${sha256Base64Url(bodyByKind.web)}`,
        contentItemIdentity: `${webUrl}:${sha256Base64Url(bodyByKind.web)}`,
        exposureStage: "answer_serialized",
        visibleTokenCount: countTextTokens(bodyByKind.web),
        visibleText: bodyByKind.web,
      },
      {
        sourceKind: "chat_message",
        logicalSourceIdentity: "chat_message:delimiter-message",
        contentItemIdentity: "delimiter-message",
        exposureStage: "answer_serialized",
        visibleTokenCount: countTextTokens(bodyByKind.chat_message),
        visibleText: bodyByKind.chat_message,
      },
    ];
    const evidence = (Object.entries(bodyByKind) as readonly [keyof typeof bodyByKind, string][])
      .map(([kind, text], index) =>
        answerSource(`k_cn_ABCDEFGHIJKLMNOPQRSTUV_${index + 1}`, kind, text),
      )
      .join("\n\n");
    const request: ProviderRequest = {
      requestClass: "main",
      model: "glm-5-turbo",
      messages: [{ role: "user", content: JSON.stringify({ evidence }) }],
      requestedOutputTokens: 128,
      reasoning: "medium",
      sourceExposureProofs: proofs,
    };

    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(4);
  });

  it("rejects malformed or legacy answer source framing", () => {
    const text = "framing body";
    const textHash = sha256Base64Url(text);
    const proof: CodeOwnedSourceExposureProof = {
      sourceKind: "web",
      logicalSourceIdentity: `web:https://example.com/framing:${textHash}`,
      contentItemIdentity: `https://example.com/framing:${textHash}`,
      exposureStage: "answer_serialized",
      visibleTokenCount: countTextTokens(text),
      visibleText: text,
    };
    const makeRequest = (evidence: string): ProviderRequest => ({
      requestClass: "main",
      model: "glm-5-turbo",
      messages: [{ role: "user", content: JSON.stringify({ evidence }) }],
      requestedOutputTokens: 128,
      reasoning: "medium",
      sourceExposureProofs: [proof],
    });
    for (const evidence of [
      `<source key="k_cn_ABCDEFGHIJKLMNOPQRSTUV_1" kind="web">\n${text}\n</source>`,
      `<source key="k_cn_ABCDEFGHIJKLMNOPQRSTUV_1" kind="web" length="${text.length - 1}">\n${text}\n</source>`,
      `<source key="k_cn_ABCDEFGHIJKLMNOPQRSTUV_1" kind="web" length="${text.length + 1}">\n${text}\n</source>`,
      `<source key="k_cn_ABCDEFGHIJKLMNOPQRSTUV_1" kind="web" length="01">\n${text}\n</source>`,
      `<source key="k_cn_ABCDEFGHIJKLMNOPQRSTUV_1" kind="web" length="${text.length}" label="\\q">\n${text}\n</source>`,
      `<source key="k_cn_ABCDEFGHIJKLMNOPQRSTUV_1" kind="web" length="${text.length}" label="\\u0066raming body">\n${text}\n</source>`,
    ]) {
      expect(() =>
        providerRequestSourceExposureProofs(makeRequest(evidence), countTextTokens),
      ).toThrow(
        /malformed source wrapper|invalid source body framing|invalid source label|noncanonical source label/u,
      );
    }
  });

  it("binds redacted candidate inspection to its document and exact range", () => {
    const source = "prefix same redacted candidate text suffix";
    const charStart = source.indexOf("same");
    const text = source.slice(charStart, charStart + "same redacted candidate text".length);
    const range = { charStart, charEnd: charStart + text.length };
    const logical = namespacedDocumentEvidenceIdentity(
      { kind: "public", sourceId: "public:redacted" },
      "doc-1",
    );
    const marker: ProviderVisibleSourceExposureMarker = {
      sourceKind: "document",
      logicalSourceIdentity: logical,
      contentItemIdentity: `${logical}:version-1:${sha256Base64Url(JSON.stringify([range]))}`,
      exposureStage: "context_candidate_inspection",
      visibleTokenCount: countTextTokens(text),
    };
    const exchange: ToolExchange = {
      call: {
        id: "inspect-redacted",
        name: "inspect_candidate",
        arguments: { id: "opaque_candidate_1", range },
      },
      result: {
        found: true,
        complete: true,
        kind: "document",
        documentId: "doc-1",
        versionId: "version-1",
        source: { kind: "public", sourceId: "public:redacted" },
        ranges: [range],
        text,
        __briefSourceIdentity: {
          versionId: "version-1",
          contentHash: immutableHash(source),
          source: { kind: "public", sourceId: "public:redacted" },
        },
        __briefSourceExposures: [marker],
      },
    };
    const fullResult = exchange.result as Record<string, unknown>;
    const proof = providerSourceExposureProofFromToolResult(
      exchange.call.name,
      fullResult,
      exchange.call,
      countTextTokens,
    )[0]!;
    const exchangeResult = {
      found: true,
      complete: true,
      kind: "document",
      documentId: "doc-1",
      ranges: [range],
      text,
    };
    expect(
      providerRequestSourceExposureProofs(
        {
          ...requestWithToolResults({ ...exchange, result: exchangeResult }),
          sourceExposureProofs: [proof],
        },
        countTextTokens,
      ),
    ).toHaveLength(1);
    expect(() =>
      providerRequestSourceExposureProofs(
        {
          ...requestWithToolResults({
            ...exchange,
            result: { ...exchangeResult, documentId: "doc-2" },
          }),
          sourceExposureProofs: [proof],
        },
        countTextTokens,
      ),
    ).toThrow(/exact visible tool-result body|sidecar does not match/u);
    expect(() =>
      providerRequestSourceExposureProofs(
        {
          ...requestWithToolResults({
            ...exchange,
            result: {
              ...exchangeResult,
              ranges: [{ charStart: charStart + 1, charEnd: range.charEnd }],
            },
          }),
          sourceExposureProofs: [proof],
        },
        countTextTokens,
      ),
    ).toThrow(/exact visible tool-result body|range/u);
    for (const mutation of [
      { ...proof, logicalSourceIdentity: proof.logicalSourceIdentity.replace("redacted", "other") },
      {
        ...proof,
        contentItemIdentity: proof.contentItemIdentity.replace("version-1", "version-2"),
      },
      { ...proof, immutableContentHash: immutableHash("different immutable body") },
      { ...proof, immutableSourceIdentityCommitment: "A".repeat(43) },
      { ...proof, immutableSourceCommitment: "B".repeat(43) },
    ]) {
      expect(() =>
        providerRequestSourceExposureProofs(
          {
            ...requestWithToolResults({ ...exchange, result: exchangeResult }),
            sourceExposureProofs: [mutation],
          },
          countTextTokens,
        ),
      ).toThrow(/identity|commitment|sidecar|descriptor/u);
    }
  });

  it("binds redacted search previews to distinct documents and ranges even for equal text", () => {
    const source = "equal redacted preview appears here. Tail text.";
    const text = source.slice(0, source.indexOf("."));
    const firstRange = { charStart: 0, charEnd: text.length };
    const secondSource = `prefix ${text} suffix.`;
    const secondStart = secondSource.indexOf("equal");
    const secondRange = { charStart: secondStart, charEnd: secondStart + text.length };
    const makeExchange = (
      callId: string,
      candidateId: string,
      documentId: string,
      namespace:
        | { readonly kind: "public"; readonly sourceId: string }
        | {
            readonly kind: "publisher";
            readonly sourceId: string;
            readonly issueId: string;
            readonly documentId: string;
          },
      body: string,
      range: { readonly charStart: number; readonly charEnd: number },
    ): { readonly full: ToolExchange; readonly redacted: ToolExchange } => {
      const logical = namespacedDocumentEvidenceIdentity(namespace, documentId);
      const marker: ProviderVisibleSourceExposureMarker = {
        sourceKind: "document",
        logicalSourceIdentity: logical,
        contentItemIdentity: `${logical}:version-1:${sha256Base64Url(JSON.stringify([range]))}`,
        exposureStage: "context_candidate_inspection",
        visibleTokenCount: countTextTokens(text),
      };
      const call: ProviderToolCall = {
        id: callId,
        name: "search_within_candidate",
        arguments: { id: candidateId, terms: "equal" },
      };
      const fullResult = {
        found: true,
        complete: true,
        kind: "document",
        documentId,
        versionId: "version-1",
        source: namespace,
        matches: [range],
        matchPreviews: [{ range, text: body.slice(range.charStart, range.charEnd) }],
        scope: {
          kind: "selected_document_ranges",
          ranges: [{ charStart: 0, charEnd: body.length }],
          matchOffset: 0,
          maximumMatches: 500,
        },
        __briefSourceIdentity: {
          versionId: "version-1",
          contentHash: immutableHash(body),
          ...(namespace.kind === "publisher" ? { publisherExtractionId: "extract-2" } : {}),
          source: namespace,
        },
        __briefSourceExposures: [marker],
      };
      return {
        full: { call, result: fullResult },
        redacted: {
          call,
          result: {
            found: true,
            complete: true,
            kind: "document",
            documentId,
            matches: [range],
            matchPreviews: [{ range, text: body.slice(range.charStart, range.charEnd) }],
            scope: fullResult.scope,
          },
        },
      };
    };
    const first = makeExchange(
      "opaque_candidate_1",
      namespacedDocumentEvidenceIdentity(
        { kind: "public", sourceId: "public:redacted-a" },
        "doc-1",
      ),
      "doc-1",
      { kind: "public", sourceId: "public:redacted-a" },
      source,
      firstRange,
    );
    const second = makeExchange(
      "opaque_candidate_2",
      namespacedDocumentEvidenceIdentity(
        {
          kind: "publisher",
          sourceId: "publisher:subscription-2",
          issueId: "issue-2",
          documentId: "doc-2",
        },
        "doc-2",
      ),
      "doc-2",
      {
        kind: "publisher",
        sourceId: "publisher:subscription-2",
        issueId: "issue-2",
        documentId: "doc-2",
      },
      secondSource,
      secondRange,
    );
    const firstProof = providerSourceExposureProofFromToolResult(
      first.full.call.name,
      first.full.result as Record<string, unknown>,
      first.full.call,
      countTextTokens,
    )[0]!;
    const secondProof = providerSourceExposureProofFromToolResult(
      second.full.call.name,
      second.full.result as Record<string, unknown>,
      second.full.call,
      countTextTokens,
    )[0]!;
    const request = requestWithToolResults(first.redacted, second.redacted);
    const validRequest = {
      ...request,
      sourceExposureProofs: [firstProof, secondProof],
    } satisfies ProviderRequest;
    expect(providerRequestSourceExposureProofs(validRequest, countTextTokens)).toHaveLength(2);
    expect(() =>
      providerRequestSourceExposureProofs(
        { ...validRequest, sourceExposureProofs: [secondProof, firstProof] },
        countTextTokens,
      ),
    ).toThrow(/sidecar|identity|commitment/u);
    const mutateSecond = (mutated: Readonly<Record<string, unknown>>) => ({
      ...validRequest,
      messages: validRequest.messages.map((message) =>
        message.role === "tool" && message.toolCallId === second.redacted.call.id
          ? { ...message, content: JSON.stringify(mutated) }
          : message,
      ),
    });
    const secondRedactedResult = second.redacted.result as Readonly<Record<string, unknown>>;
    for (const mutation of [
      { ...secondRedactedResult, documentId: "doc-3" },
      {
        ...secondRedactedResult,
        scope: {
          ...(secondRedactedResult.scope as Record<string, unknown>),
          ranges: [{ charStart: 0, charEnd: secondSource.length - 1 }],
        },
      },
      {
        ...secondRedactedResult,
        matches: [{ charStart: secondRange.charStart + 1, charEnd: secondRange.charEnd + 1 }],
      },
      {
        ...secondRedactedResult,
        matchPreviews: [
          {
            range: secondRange,
            text: `${text}!`,
          },
        ],
      },
    ]) {
      expect(() =>
        providerRequestSourceExposureProofs(mutateSecond(mutation), countTextTokens),
      ).toThrow(/exact|immutable|commitment|sidecar/u);
    }
    for (const mutation of [
      {
        ...secondProof,
        logicalSourceIdentity: secondProof.logicalSourceIdentity.replace("issue-2", "other"),
      },
      {
        ...secondProof,
        contentItemIdentity: secondProof.contentItemIdentity.replace("version-1", "version-2"),
      },
      { ...secondProof, immutableContentHash: immutableHash("other complete body") },
      { ...secondProof, immutableSourceIdentityCommitment: "A".repeat(43) },
    ]) {
      expect(() =>
        providerRequestSourceExposureProofs(
          { ...validRequest, sourceExposureProofs: [firstProof, mutation] },
          countTextTokens,
        ),
      ).toThrow(/identity|commitment|sidecar|descriptor/u);
    }
  });

  it("binds opaque redacted chat, memory, web, and publisher identities", () => {
    const publisherLogical = namespacedDocumentEvidenceIdentity(
      {
        kind: "publisher",
        sourceId: "publisher:subscription-1",
        issueId: "issue-1",
        documentId: "publisher-doc",
      },
      "publisher-doc",
    );
    const cases = [
      {
        handle: "opaque-chat",
        kind: "chat_message" as const,
        text: "same opaque candidate text",
        privateIdentity: {
          messageId: "message-1",
          contentHash: sha256Base64Url("same opaque candidate text"),
        },
        marker: {
          sourceKind: "chat_message" as const,
          logicalSourceIdentity: chatMessageEvidenceIdentity("message-1"),
          contentItemIdentity: "message-1",
          exposureStage: "context_candidate_inspection",
          visibleTokenCount: countTextTokens("same opaque candidate text"),
        },
      },
      {
        handle: "opaque-memory",
        kind: "memory" as const,
        text: "same opaque candidate text",
        privateIdentity: {
          memoryId: "memory-1",
          memoryRevisionId: "revision-1",
          contentHash: sha256Base64Url("same opaque candidate text"),
        },
        marker: {
          sourceKind: "memory" as const,
          logicalSourceIdentity: "memory:memory-1",
          contentItemIdentity: "revision-1",
          exposureStage: "context_candidate_inspection",
          visibleTokenCount: countTextTokens("same opaque candidate text"),
        },
      },
      {
        handle: "opaque-web",
        kind: "web" as const,
        text: "same opaque candidate text",
        privateIdentity: {
          url: "https://example.com/opaque",
          quoteHash: sha256Base64Url("same opaque candidate text"),
          contentHash: sha256Base64Url("same opaque candidate text"),
        },
        marker: {
          sourceKind: "web" as const,
          logicalSourceIdentity: `web:https://example.com/opaque:${sha256Base64Url("same opaque candidate text")}`,
          contentItemIdentity: `https://example.com/opaque:${sha256Base64Url("same opaque candidate text")}`,
          exposureStage: "context_candidate_inspection",
          visibleTokenCount: countTextTokens("same opaque candidate text"),
        },
      },
      {
        handle: "opaque-publisher",
        kind: "document" as const,
        text: "publisher exact range text",
        privateIdentity: {
          versionId: "publisher-version-1",
          contentHash: immutableHash("publisher exact range text"),
          publisherExtractionId: "extract-1",
          source: {
            kind: "publisher" as const,
            sourceId: "publisher:subscription-1",
            issueId: "issue-1",
            documentId: "publisher-doc",
          },
        },
        marker: {
          sourceKind: "document" as const,
          logicalSourceIdentity: publisherLogical,
          contentItemIdentity: `${publisherLogical}:publisher-version-1:${sha256Base64Url(JSON.stringify([{ charStart: 0, charEnd: "publisher exact range text".length }]))}`,
          exposureStage: "context_candidate_inspection",
          visibleTokenCount: countTextTokens("publisher exact range text"),
        },
      },
    ];
    for (const candidate of cases) {
      const range = { charStart: 0, charEnd: candidate.text.length };
      const call: ProviderToolCall = {
        id: `${candidate.handle}-call`,
        name: "inspect_candidate",
        arguments: { id: candidate.handle },
      };
      const fullResult = {
        found: true,
        complete: true,
        kind: candidate.kind,
        text: candidate.text,
        ...(candidate.kind === "document"
          ? {
              documentId: "publisher-doc",
              versionId: "publisher-version-1",
              source: candidate.privateIdentity.source,
              ranges: [range],
            }
          : {}),
        __briefSourceIdentity: candidate.privateIdentity,
        __briefSourceExposures: [candidate.marker],
      };
      const { __briefSourceIdentity: _missingIdentity, ...withoutIdentity } = fullResult;
      expect(() =>
        providerSourceExposureProofFromToolResult(
          call.name,
          withoutIdentity,
          call,
          countTextTokens,
        ),
      ).toThrow(/immutable identity|content hash|sidecar/u);
      expect(() =>
        providerSourceExposureProofFromToolResult(
          call.name,
          { ...fullResult, __briefSourceIdentity: "malformed" },
          call,
          countTextTokens,
        ),
      ).toThrow(/immutable identity|content hash|sidecar/u);
      const proof = providerSourceExposureProofFromToolResult(
        call.name,
        fullResult,
        call,
        countTextTokens,
      )[0]!;
      const redactedResult = {
        found: true,
        complete: true,
        kind: candidate.kind,
        text: candidate.text,
        ...(candidate.kind === "document" ? { documentId: "publisher-doc", ranges: [range] } : {}),
      };
      const request = {
        ...requestWithToolResults({ call, result: redactedResult }),
        sourceExposureProofs: [proof],
      } satisfies ProviderRequest;
      expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(1);
      const identitySwaps =
        candidate.kind === "chat_message"
          ? [
              { ...proof, logicalSourceIdentity: chatMessageEvidenceIdentity("message-2") },
              { ...proof, contentItemIdentity: "message-2" },
            ]
          : candidate.kind === "memory"
            ? [
                { ...proof, logicalSourceIdentity: "memory:memory-2" },
                { ...proof, contentItemIdentity: "revision-2" },
              ]
            : candidate.kind === "web"
              ? [
                  {
                    ...proof,
                    logicalSourceIdentity: proof.logicalSourceIdentity.replace("opaque", "other"),
                  },
                  {
                    ...proof,
                    contentItemIdentity: proof.contentItemIdentity.replace("opaque", "other"),
                  },
                ]
              : [
                  {
                    ...proof,
                    logicalSourceIdentity: proof.logicalSourceIdentity.replace(
                      "issue-1",
                      "issue-2",
                    ),
                  },
                  {
                    ...proof,
                    contentItemIdentity: proof.contentItemIdentity.replace(
                      "publisher-version-1",
                      "publisher-version-2",
                    ),
                  },
                ];
      for (const swapped of [
        ...identitySwaps,
        { ...proof, immutableContentHash: "f".repeat(64) },
        { ...proof, immutableContentHash: "A".repeat(43) },
        { ...proof, immutableSourceIdentityCommitment: "A".repeat(43) },
        { ...proof, immutableSourceCommitment: "B".repeat(43) },
      ]) {
        expect(() =>
          providerRequestSourceExposureProofs(
            { ...request, sourceExposureProofs: [swapped] },
            countTextTokens,
          ),
        ).toThrow(/identity|content hash|commitment|sidecar|descriptor/u);
      }
    }
  });

  it("does not exchange equal-text opaque candidate proofs between calls", () => {
    const text = "the same opaque candidate body";
    const makeExchange = (callId: string, messageId: string): ToolExchange => {
      const marker: ProviderVisibleSourceExposureMarker = {
        sourceKind: "chat_message",
        logicalSourceIdentity: chatMessageEvidenceIdentity(messageId),
        contentItemIdentity: messageId,
        exposureStage: "context_candidate_inspection",
        visibleTokenCount: countTextTokens(text),
      };
      return {
        call: {
          id: callId,
          name: "inspect_candidate",
          arguments: { id: `opaque-${messageId}` },
        },
        result: {
          found: true,
          complete: true,
          kind: "chat_message",
          text,
          __briefSourceIdentity: {
            messageId,
            contentHash: sha256Base64Url(text),
          },
          __briefSourceExposures: [marker],
        },
      };
    };
    const first = makeExchange("opaque-call-1", "opaque-message-1");
    const second = makeExchange("opaque-call-2", "opaque-message-2");
    const firstProof = providerSourceExposureProofFromToolResult(
      first.call.name,
      first.result as Record<string, unknown>,
      first.call,
      countTextTokens,
    )[0]!;
    const secondProof = providerSourceExposureProofFromToolResult(
      second.call.name,
      second.result as Record<string, unknown>,
      second.call,
      countTextTokens,
    )[0]!;
    const redactedRequest = requestWithToolResults(
      { ...first, result: { found: true, complete: true, kind: "chat_message", text } },
      { ...second, result: { found: true, complete: true, kind: "chat_message", text } },
    );
    expect(
      providerRequestSourceExposureProofs(
        { ...redactedRequest, sourceExposureProofs: [firstProof, secondProof] },
        countTextTokens,
      ),
    ).toHaveLength(2);
    const bindings = providerRequestSourceExposureProofBindings(
      { ...redactedRequest, sourceExposureProofs: [firstProof, secondProof] },
      countTextTokens,
    );
    expect(bindings.map((binding) => binding.binding.serializedField).toSorted()).toEqual([
      "messages[3].content.text",
      "messages[5].content.text",
    ]);
    expect(() =>
      providerRequestSourceExposureProofs(
        { ...redactedRequest, sourceExposureProofs: [secondProof, firstProof] },
        countTextTokens,
      ),
    ).toThrow(/tool-result coordinate|sidecar|identity/u);
  });

  it("preserves sparse citation ordinals in answer source wrappers", () => {
    const quote = "sparse answer quotation";
    const url = "https://example.com/sparse";
    const quoteHash = sha256Base64Url(quote);
    const proof: CodeOwnedSourceExposureProof = {
      sourceKind: "web",
      logicalSourceIdentity: `web:${url}:${quoteHash}`,
      contentItemIdentity: `${url}:${quoteHash}`,
      exposureStage: "answer_serialized",
      visibleTokenCount: countTextTokens(quote),
      visibleText: quote,
    };
    const request: ProviderRequest = {
      requestClass: "main",
      model: "glm-5-turbo",
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            evidence: `<source key="k_cn_ABCDEFGHIJKLMNOPQRSTUV_4" kind="web" length="${quote.length}">\n${quote}\n</source>`,
          }),
        },
      ],
      requestedOutputTokens: 128,
      reasoning: "medium",
      sourceExposureProofs: [proof],
    };
    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(1);
  });

  it("binds selected conversation and answer evidence in one global request order", () => {
    const current = "current question";
    const priorQuestion = "prior question";
    const prior = "prior answer";
    const quote = "answer evidence quote";
    const url = "https://example.com/global-order";
    const quoteHash = sha256Base64Url(quote);
    const priorQuestionProof: CodeOwnedSourceExposureProof = {
      sourceKind: "chat_message",
      logicalSourceIdentity: "chat_message:user-1",
      contentItemIdentity: "user-1",
      exposureStage: "provider_input",
      visibleTokenCount: countTextTokens(priorQuestion),
      visibleText: priorQuestion,
    };
    const conversationProof: CodeOwnedSourceExposureProof = {
      sourceKind: "chat_message",
      logicalSourceIdentity: "chat_message:prior-1",
      contentItemIdentity: "prior-1",
      exposureStage: "provider_input",
      visibleTokenCount: countTextTokens(prior),
      visibleText: prior,
    };
    const answerProof: CodeOwnedSourceExposureProof = {
      sourceKind: "web",
      logicalSourceIdentity: `web:${url}:${quoteHash}`,
      contentItemIdentity: `${url}:${quoteHash}`,
      exposureStage: "answer_serialized",
      visibleTokenCount: countTextTokens(quote),
      visibleText: quote,
    };
    const request: ProviderRequest = {
      requestClass: "main",
      model: "glm-5-turbo",
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            originalMessage: current,
            selectedConversation: [
              {
                turnId: "turn-1",
                userMessageId: "user-1",
                userContent: "prior question",
                assistantMessageId: "prior-1",
                assistantContent: prior,
              },
            ],
            evidence: `<source key="k_cn_ABCDEFGHIJKLMNOPQRSTUV_1" kind="web" length="${quote.length}">\n${quote}\n</source>`,
          }),
        },
      ],
      requestedOutputTokens: 128,
      reasoning: "medium",
      sourceExposureProofs: [
        {
          sourceKind: "chat_message",
          logicalSourceIdentity: "chat_message:current-1",
          contentItemIdentity: "current-1",
          exposureStage: "provider_input",
          visibleTokenCount: countTextTokens(current),
          visibleText: current,
        },
        priorQuestionProof,
        conversationProof,
        answerProof,
      ],
    };
    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(4);
    expect(() =>
      providerRequestSourceExposureProofs(
        { ...request, sourceExposureProofs: [] },
        countTextTokens,
      ),
    ).toThrow(/missing proof/u);
  });
});
