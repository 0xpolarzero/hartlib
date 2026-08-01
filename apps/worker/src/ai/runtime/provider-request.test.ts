import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  chatMessageEvidenceIdentity,
  namespacedDocumentEvidenceIdentity,
  sha256Base64Url,
} from "./canonicalization";
import { measureProviderRequest, resolveRegisteredModel } from "./model-registry";
import {
  redactProviderToolResult,
  normalizeProviderRequest,
  providerRequestSha256Hex,
  providerRequestSourceExposureProofBindings,
  providerRequestSourceExposureProofs,
  providerSourceExposureProofFromToolResult,
  providerVisibleSourceExposureCommitment,
  providerVisibleSourceExposureProofSha256Hex,
  requireLiveProviderRequest,
  serializeExactAnswerRequest,
  stableJson,
  toGlmTemplateInput,
  type CodeOwnedSourceExposureProof,
  type ProviderRequest,
  type ProviderToolCall,
  type ProviderVisibleSourceExposureMarker,
} from "./provider-request";

const model = resolveRegisteredModel("glm-5-turbo");
const countTextTokens = (text: string): number => model.countTextTokens(text);
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const documentMarker = (text: string, sourceId = "public:source-1", documentId = "doc-1") => {
  const logicalSourceIdentity = namespacedDocumentEvidenceIdentity(
    { kind: "public", sourceId },
    documentId,
  );
  return {
    sourceKind: "document" as const,
    logicalSourceIdentity,
    contentItemIdentity: `${logicalSourceIdentity}:snapshot-1:${sha256Base64Url(text)}`,
    exposureStage: "internal_search_preview",
    visibleTokenCount: countTextTokens(text),
  } satisfies ProviderVisibleSourceExposureMarker;
};

const chatMarker = (messageId: string, text: string) =>
  ({
    sourceKind: "chat_message" as const,
    logicalSourceIdentity: chatMessageEvidenceIdentity(messageId),
    contentItemIdentity: messageId,
    exposureStage: "provider_input",
    visibleTokenCount: countTextTokens(text),
  }) satisfies ProviderVisibleSourceExposureMarker;

const reviewRequest = (
  results: readonly { readonly kind: "document" | "chat_message"; readonly preview: string }[],
  proofs: readonly CodeOwnedSourceExposureProof[],
): ProviderRequest => ({
  requestClass: "fast",
  model: "glm-5-turbo",
  messages: [
    { role: "system", content: "review" },
    { role: "user", content: JSON.stringify({ question: "find evidence", results }) },
  ],
  requestedOutputTokens: 128,
  reasoning: "medium",
  sourceExposureProofs: proofs,
});

const proofFor = (
  marker: ProviderVisibleSourceExposureMarker,
  visibleText: string,
): CodeOwnedSourceExposureProof => ({
  ...marker,
  visibleText,
  ...(marker.sourceKind === "chat_message"
    ? {
        chatReconstruction: {
          messageId: marker.contentItemIdentity,
          contentHash: sha256(visibleText),
          ranges: [{ charStart: 0, charEnd: visibleText.length }],
        },
      }
    : {}),
});

const compactionChatProof = (
  text: string,
  messageId: string,
  candidateId = "c1",
  passageId?: string,
): CodeOwnedSourceExposureProof => {
  const marker = {
    sourceKind: "chat_message" as const,
    logicalSourceIdentity: chatMessageEvidenceIdentity(messageId),
    contentItemIdentity: messageId,
    exposureStage: "context_compaction_input",
    visibleTokenCount: countTextTokens(text),
  } satisfies ProviderVisibleSourceExposureMarker;
  const visibleByteCount = new TextEncoder().encode(text).byteLength;
  const immutableContentHash = sha256(text);
  const immutableSourceIdentityCommitment = sha256Base64Url(marker.logicalSourceIdentity);
  const compactionBinding = stableJson({
    sourceKind: marker.sourceKind,
    candidateId,
    passageId,
    charStart: 0,
    charEnd: text.length,
    visibleByteCount,
    visibleTextHash: sha256Base64Url(text),
  });
  return {
    ...marker,
    visibleText: text,
    candidateId,
    ...(passageId === undefined ? {} : { passageId }),
    charStart: 0,
    charEnd: text.length,
    visibleByteCount,
    chatReconstruction: {
      messageId,
      contentHash: immutableContentHash,
      ranges: [{ charStart: 0, charEnd: text.length }],
    },
    immutableContentHash,
    immutableSourceIdentityCommitment,
    immutableSourceCommitment: providerVisibleSourceExposureCommitment(
      marker,
      compactionBinding,
      immutableContentHash,
      immutableSourceIdentityCommitment,
    ),
  };
};

const conversationPreviewCandidate = (
  preview: Readonly<Record<string, string | boolean>>,
): Readonly<Record<string, unknown>> => ({
  candidateId: "c1",
  kind: "conversation_entry",
  label: "Conversation",
  purpose: "answer",
  date: null,
  renderedTokenCount: 20,
  preview,
});

const memoryToolRequest = (text: string): ProviderRequest => ({
  requestClass: "fast",
  model: "glm-5-turbo",
  messages: [
    { role: "system", content: "memory" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "memory-1", name: "search_memories", arguments: { query: "memory" } }],
    },
    {
      role: "tool",
      toolCallId: "memory-1",
      name: "search_memories",
      content: JSON.stringify({
        items: [
          {
            memoryId: "memory-1",
            memoryRevisionId: "revision-1",
            content: text,
            contentHash: sha256Base64Url(text),
          },
        ],
      }),
    },
  ],
  requestedOutputTokens: 128,
  reasoning: "medium",
  sourceExposureProofs: [
    {
      sourceKind: "memory",
      logicalSourceIdentity: "memory:memory-1",
      contentItemIdentity: "revision-1",
      exposureStage: "memory_tool_result",
      visibleTokenCount: countTextTokens(text),
      visibleText: text,
      sourceToolCallId: "memory-1",
      sourceResultIndex: 0,
    },
  ],
});

interface ToolExchange {
  readonly call: ProviderToolCall;
  readonly result: unknown;
}

const requestWithToolExchanges = (
  exchanges: readonly ToolExchange[],
  sourceExposureProofs: readonly CodeOwnedSourceExposureProof[] = [],
): ProviderRequest => ({
  requestClass: "fast",
  model: "glm-5-turbo",
  messages: [
    { role: "system", content: "tool test" },
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
  sourceExposureProofs,
});

const exactDocumentMarker = (
  text: string,
  exposureStage: ProviderVisibleSourceExposureMarker["exposureStage"],
  range: { readonly charStart: number; readonly charEnd: number },
  sourceId = "public:source-1",
  documentId = "doc-1",
): ProviderVisibleSourceExposureMarker => {
  const logicalSourceIdentity = namespacedDocumentEvidenceIdentity(
    { kind: "public", sourceId },
    documentId,
  );
  const rangeHash = sha256Base64Url(JSON.stringify([range]));
  return {
    sourceKind: "document",
    logicalSourceIdentity,
    contentItemIdentity: `${logicalSourceIdentity}:snapshot-1:${rangeHash}`,
    exposureStage,
    visibleTokenCount: countTextTokens(text),
  };
};

const answerWrapper = (key: string, kind: string, text: string): string =>
  `<source key="${key}" kind="${kind}" length="${text.length}">\n${text}\n</source>`;

describe("provider-visible source exposure proofs", () => {
  it("binds a proof to its exact serialized field", () => {
    const marker = documentMarker("bound source");
    expect(
      providerVisibleSourceExposureProofSha256Hex(marker, {
        messageIndex: 1,
        sourceOrdinal: 0,
        serializedField: "messages[1].content.results[0].preview",
        orderedSourceDescriptor: "result-0",
      }),
    ).not.toBe(
      providerVisibleSourceExposureProofSha256Hex(marker, {
        messageIndex: 1,
        sourceOrdinal: 0,
        serializedField: "messages[1].content.results[1].preview",
        orderedSourceDescriptor: "result-0",
      }),
    );
  });

  it("accepts an exact code-owned review proof", () => {
    const text = "visible source text";
    const marker = documentMarker(text);
    const request = reviewRequest([{ kind: "document", preview: text }], [proofFor(marker, text)]);
    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(1);
    expect(providerRequestSourceExposureProofBindings(request, countTextTokens)).toHaveLength(1);
  });

  it("binds mixed document and chat review previews to their kind-specific stages", () => {
    const documentText = "document review preview";
    const chatText = "chat review preview";
    const documentProof = proofFor(documentMarker(documentText), documentText);
    const chatMarkerForReview = {
      ...chatMarker("review-message-1", chatText),
      exposureStage: "internal_chat_search_preview" as const,
    };
    const chatProof = proofFor(chatMarkerForReview, chatText);
    const request = reviewRequest(
      [
        { kind: "document", preview: documentText },
        { kind: "chat_message", preview: chatText },
      ],
      [documentProof, chatProof],
    );
    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(2);
    expect(providerRequestSourceExposureProofBindings(request, countTextTokens)).toHaveLength(2);
    expect(() => providerRequestSourceExposureProofs(request, countTextTokens)).not.toThrow();
    expect(() =>
      providerRequestSourceExposureProofs(
        {
          ...request,
          sourceExposureProofs: [
            documentProof,
            { ...chatProof, exposureStage: "internal_search_preview" },
          ],
        },
        countTextTokens,
      ),
    ).toThrow(/stage|exact normalized source field/u);
  });

  it("rejects a missing proof", () => {
    const text = "missing proof";
    expect(() =>
      providerRequestSourceExposureProofs(
        reviewRequest([{ kind: "document", preview: text }], []),
        countTextTokens,
      ),
    ).toThrow(/missing proof/u);
  });

  it("rejects an extra proof", () => {
    const first = "first";
    const second = "second";
    expect(() =>
      providerRequestSourceExposureProofs(
        reviewRequest(
          [{ kind: "document", preview: first }],
          [
            proofFor(documentMarker(first), first),
            proofFor(documentMarker(second, "public:source-2", "doc-2"), second),
          ],
        ),
        countTextTokens,
      ),
    ).toThrow(/extra proof/u);
  });

  it("rejects a reordered proof", () => {
    const first = "first";
    const second = "second";
    const request = reviewRequest(
      [
        { kind: "document", preview: first },
        { kind: "document", preview: second },
      ],
      [proofFor(documentMarker(first), "changed"), proofFor(documentMarker(second), second)],
    );
    expect(() => providerRequestSourceExposureProofs(request, countTextTokens)).toThrow(
      /exact normalized source field|identity/u,
    );
  });

  it("accepts two real occurrences of identical source text at distinct fields", () => {
    const text = "repeated source";
    const marker = documentMarker(text);
    const request = reviewRequest(
      [
        { kind: "document", preview: text },
        { kind: "document", preview: text },
      ],
      [
        {
          ...proofFor(marker, text),
          sourceOrdinal: 0,
          serializedField: "messages[1].content.results[0].preview",
        },
        {
          ...proofFor(marker, text),
          sourceOrdinal: 1,
          serializedField: "messages[1].content.results[1].preview",
        },
      ],
    );
    expect(providerRequestSourceExposureProofBindings(request, countTextTokens)).toHaveLength(2);
  });

  it("rejects an identical-source request when one occurrence is missing", () => {
    const text = "repeated source";
    const marker = documentMarker(text);
    const proof = {
      ...proofFor(marker, text),
      sourceOrdinal: 0,
      serializedField: "messages[1].content.results[0].preview",
    };
    expect(() =>
      providerRequestSourceExposureProofs(
        reviewRequest(
          [
            { kind: "document", preview: text },
            { kind: "document", preview: text },
          ],
          [proof],
        ),
        countTextTokens,
      ),
    ).toThrow(/missing proof/u);
  });

  it("rejects two proofs bound to the same exact source coordinate", () => {
    const text = "repeated source";
    const marker = documentMarker(text);
    const proof = {
      ...proofFor(marker, text),
      sourceOrdinal: 0,
      serializedField: "messages[1].content.results[0].preview",
    };
    expect(() =>
      providerRequestSourceExposureProofs(
        reviewRequest([{ kind: "document", preview: text }], [proof, proof]),
        countTextTokens,
      ),
    ).toThrow(/duplicate source exposure proof|extra proof/u);
  });

  it("rejects a document proof whose immutable content digest changed", () => {
    const text = "immutable document";
    const marker = documentMarker(text);
    expect(() =>
      providerRequestSourceExposureProofs(
        reviewRequest([{ kind: "document", preview: text }], [proofFor(marker, "changed")]),
        countTextTokens,
      ),
    ).toThrow(/exact normalized source field|content/u);
  });

  it("rejects a chat proof whose private identity changed", () => {
    const text = "chat evidence";
    const marker = chatMarker("message-1", text);
    expect(() =>
      providerRequestSourceExposureProofs(
        reviewRequest(
          [{ kind: "chat_message", preview: text }],
          [
            proofFor(
              {
                ...marker,
                contentItemIdentity: "message-2",
                logicalSourceIdentity: chatMessageEvidenceIdentity("message-2"),
              },
              text,
            ),
          ],
        ),
        countTextTokens,
      ),
    ).toThrow(/exact normalized source field|identity/u);
  });

  it("keeps private identity out of the provider-visible review request", () => {
    const text = "private chat text";
    const marker = chatMarker("private-message", text);
    const request = reviewRequest(
      [{ kind: "chat_message", preview: text }],
      [proofFor(marker, text)],
    );
    expect(request.messages[1]?.content).not.toContain("private-message");
    expect(request.messages[1]?.content).not.toContain("__briefSourceExposures");
  });

  it("preserves two equal snippets with distinct immutable identities", () => {
    const text = "equal text";
    const first = documentMarker(text, "public:source-1", "doc-1");
    const second = documentMarker(text, "public:source-2", "doc-2");
    const request = reviewRequest(
      [
        { kind: "document", preview: text },
        { kind: "document", preview: text },
      ],
      [proofFor(first, text), proofFor(second, text)],
    );
    expect(providerRequestSourceExposureProofBindings(request, countTextTokens)).toHaveLength(2);
  });

  it("rejects a changed tokenizer count", () => {
    const text = "token count";
    const marker = documentMarker(text);
    expect(() =>
      providerRequestSourceExposureProofs(
        reviewRequest(
          [{ kind: "document", preview: text }],
          [proofFor({ ...marker, visibleTokenCount: marker.visibleTokenCount + 1 }, text)],
        ),
        countTextTokens,
      ),
    ).toThrow(/tokenizer count/u);
  });

  it("rejects a proof with the wrong source kind", () => {
    const text = "wrong source kind";
    const marker = documentMarker(text);
    expect(() =>
      providerRequestSourceExposureProofs(
        reviewRequest(
          [{ kind: "document", preview: text }],
          [
            proofFor(
              {
                ...marker,
                sourceKind: "chat_message",
                logicalSourceIdentity: chatMessageEvidenceIdentity("message"),
                contentItemIdentity: "message",
              },
              text,
            ),
          ],
        ),
        countTextTokens,
      ),
    ).toThrow(/source field|identity/u);
  });

  it("retains repeated memory exposure locations", () => {
    const text = "same memory";
    const request = memoryToolRequest(text);
    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(1);
  });

  it("rejects a memory proof rebound to different text", () => {
    const text = "same memory";
    expect(() =>
      providerRequestSourceExposureProofs(
        { ...memoryToolRequest(text), messages: memoryToolRequest("changed").messages },
        countTextTokens,
      ),
    ).toThrow(/visible|identity|content/u);
  });

  it("uses the content-free provider request digest", () => {
    const text = "digest source";
    const marker = documentMarker(text);
    const request = reviewRequest([{ kind: "document", preview: text }], [proofFor(marker, text)]);
    const changed = { ...request, sourceExposureProofs: [proofFor(marker, `${text} changed`)] };
    expect(providerRequestSha256Hex(request)).toBe(providerRequestSha256Hex(changed));
  });

  it("normalizes provider messages without exposing sidecar proofs", () => {
    const text = "normalization";
    const marker = documentMarker(text);
    const request = reviewRequest([{ kind: "document", preview: text }], [proofFor(marker, text)]);
    expect(normalizeProviderRequest(request).messages).toEqual(request.messages);
    expect(toGlmTemplateInput(request).messages[1]?.content).not.toContain(
      "__briefSourceExposures",
    );
  });
  it("keeps semantic repair metadata out of provider framing and measurement", () => {
    const text = 'same "quoted"\\nline';
    const marker = documentMarker(text);
    const request = reviewRequest([{ kind: "document", preview: text }], [proofFor(marker, text)]);
    const repaired = { ...request, repairConsumed: true as const };
    const limits = { inputTokens: 100_000, outputTokens: 128 };
    expect(normalizeProviderRequest(repaired).repairConsumed).toBe(true);
    expect(toGlmTemplateInput(repaired)).toEqual(toGlmTemplateInput(request));
    expect(measureProviderRequest(repaired, model, limits).inputTokens).toBe(
      measureProviderRequest(request, model, limits).inputTokens,
    );
    expect(measureProviderRequest(repaired, model, limits).requestedOutputTokens).toBe(
      measureProviderRequest(request, model, limits).requestedOutputTokens,
    );
  });

  it("accepts the live model and rejects historical model IDs", () => {
    const request = reviewRequest([], []);
    expect(requireLiveProviderRequest(request).model).toBe("glm-5-turbo");
    expect(() => requireLiveProviderRequest({ ...request, model: "glm-5.2" })).toThrow(
      /glm-5-turbo/u,
    );
  });

  it("serializes the exact answer request shape", () => {
    const request = serializeExactAnswerRequest({
      model: "glm-5-turbo",
      system: "system",
      user: "user",
      requestedOutputTokens: 64,
      reasoning: "medium",
    });
    expect(request.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "user" },
    ]);
    expect(request.requestedOutputTokens).toBe(64);
  });

  it("accepts current provider tool markers without a serial compatibility path", () => {
    const text = "memory evidence";
    const request = memoryToolRequest(text);
    expect(
      request.messages.some(
        (message) => message.role === "tool" && message.name === "search_memories",
      ),
    ).toBe(true);
    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(1);
  });

  it("keeps source proof hashes bound to distinct request coordinates", () => {
    const text = "coordinate source";
    const marker = documentMarker(text);
    const first = providerVisibleSourceExposureProofSha256Hex(marker, {
      messageIndex: 1,
      sourceOrdinal: 0,
      serializedField: "messages[1].content.results[0].preview",
      orderedSourceDescriptor: "one",
    });
    const second = providerVisibleSourceExposureProofSha256Hex(marker, {
      messageIndex: 1,
      sourceOrdinal: 1,
      serializedField: "messages[1].content.results[1].preview",
      orderedSourceDescriptor: "two",
    });
    expect(first).not.toBe(second);
  });

  it("uses exact UTF-8 text hashes for immutable source identity", () => {
    const text = "😀 immutable";
    expect(sha256(text)).toMatch(/^[a-f0-9]{64}$/u);
    expect(sha256Base64Url(text)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("keeps tool calls typed at the current provider boundary", () => {
    const call: ProviderToolCall = { id: "call", name: "search_memories", arguments: {} };
    expect(call.name).toBe("search_memories");
  });

  it("accepts opaque document snapshot IDs containing colons", () => {
    const text = "service public evidence";
    const marker = documentMarker(text);
    const colonMarker = {
      ...marker,
      contentItemIdentity: `${marker.logicalSourceIdentity}:https://service.example/F123:${sha256Base64Url(text)}`,
    };
    const request = reviewRequest(
      [{ kind: "document", preview: text }],
      [proofFor(colonMarker, text)],
    );
    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(1);
  });

  it("rejects unchecked immutable document fields before transport", () => {
    const request = {
      ...memoryToolRequest("visible memory"),
      messages: memoryToolRequest("visible memory").messages.map((message) =>
        message.role === "tool"
          ? { ...message, content: JSON.stringify({ snapshotId: "unchecked" }) }
          : message,
      ),
    } satisfies ProviderRequest;
    expect(() => requireLiveProviderRequest(request)).toThrow(
      /private source identity|source exposure/u,
    );
  });

  it("rejects a reserved marker inventory in a code-owned sidecar request", () => {
    const request = {
      ...memoryToolRequest("reserved marker"),
      messages: memoryToolRequest("reserved marker").messages.map((message) =>
        message.role === "tool"
          ? {
              ...message,
              content: JSON.stringify({
                items: [
                  {
                    memoryId: "memory-1",
                    memoryRevisionId: "revision-1",
                    content: "reserved marker",
                  },
                ],
                __briefSourceExposures: [],
              }),
            }
          : message,
      ),
    } satisfies ProviderRequest;
    expect(() => providerRequestSourceExposureProofs(request, countTextTokens)).toThrow(
      /marker|proof/u,
    );
  });

  it("rejects a document marker whose immutable identity hash drifts", () => {
    const text = "immutable body";
    const marker = documentMarker(text);
    expect(() =>
      providerRequestSourceExposureProofs(
        reviewRequest(
          [{ kind: "document", preview: text }],
          [proofFor(marker, "different visible body")],
        ),
        countTextTokens,
      ),
    ).toThrow(/identity|source field|tokenizer/u);
  });

  it("mints a code-owned proof from a current tool result", () => {
    const text = "minted memory";
    const request = memoryToolRequest(text);
    const call = request.messages.find((message) => message.role === "assistant")!.toolCalls![0]!;
    const result = JSON.parse(
      request.messages.find((message) => message.role === "tool")!.content,
    ) as Record<string, unknown>;
    result.__briefSourceExposures = [
      {
        sourceKind: "memory",
        logicalSourceIdentity: "memory:memory-1",
        contentItemIdentity: "revision-1",
        exposureStage: "memory_tool_result",
        visibleTokenCount: countTextTokens(text),
      },
    ];
    const proofs = providerSourceExposureProofFromToolResult(
      "search_memories",
      result,
      call,
      countTextTokens,
    );
    expect(proofs).toHaveLength(1);
    expect(proofs[0]?.sourceToolCallId).toBe("memory-1");
  });

  it("keeps conversation proof text out of the serialized request", () => {
    const text = "private conversation text";
    const request: ProviderRequest = {
      requestClass: "fast",
      model: "glm-5-turbo",
      messages: [
        { role: "system", content: "system" },
        {
          role: "user",
          content: JSON.stringify({ currentMessage: text, currentMessageId: "m-1" }),
        },
      ],
      requestedOutputTokens: 64,
      reasoning: "low",
      sourceExposureProofs: [proofFor(chatMarker("m-1", text), text)],
    };
    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(1);
    expect(request.messages[1]?.content).not.toContain("__briefSourceExposures");
  });

  it("does not create a second proof for an identical replay", () => {
    const text = "replayed memory";
    const request = memoryToolRequest(text);
    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toEqual(
      providerRequestSourceExposureProofs(request, countTextTokens),
    );
  });

  it("keeps equal document text tied to distinct source identities", () => {
    const text = "same visible text";
    const request = reviewRequest(
      [
        { kind: "document", preview: text },
        { kind: "document", preview: text },
      ],
      [
        proofFor(documentMarker(text, "public:one", "doc-one"), text),
        proofFor(documentMarker(text, "public:two", "doc-two"), text),
      ],
    );
    expect(providerRequestSourceExposureProofBindings(request, countTextTokens)).toHaveLength(2);
  });

  it("rejects a document proof without a canonical namespace", () => {
    const text = "namespace required";
    const marker = documentMarker(text);
    expect(() =>
      providerRequestSourceExposureProofs(
        reviewRequest(
          [{ kind: "document", preview: text }],
          [proofFor({ ...marker, logicalSourceIdentity: "doc-1" }, text)],
        ),
        countTextTokens,
      ),
    ).toThrow(/identity|namespace/u);
  });

  it("rejects a proof with a recomputed but incorrect visible token count", () => {
    const text = "visible count";
    const marker = documentMarker(text);
    expect(() =>
      providerRequestSourceExposureProofs(
        reviewRequest(
          [{ kind: "document", preview: text }],
          [proofFor({ ...marker, visibleTokenCount: 99 }, text)],
        ),
        countTextTokens,
      ),
    ).toThrow(/tokenizer/u);
  });

  it("rejects a proof order swap even when both texts have equal length", () => {
    const first = "first evidence";
    const second = "second evidence";
    expect(() =>
      providerRequestSourceExposureProofs(
        reviewRequest(
          [
            { kind: "document", preview: first },
            { kind: "document", preview: second },
          ],
          [proofFor(documentMarker(second), second), proofFor(documentMarker(first), first)],
        ),
        countTextTokens,
      ),
    ).toThrow(/exact normalized source field|identity/u);
  });

  it("keeps answer source wrappers in sparse ordinal order", () => {
    const text = `<source key="k_cn_${"a".repeat(22)}_2" kind="document" length="5">\nabcde\n</source>`;
    const marker: CodeOwnedSourceExposureProof = {
      ...documentMarker("abcde"),
      exposureStage: "answer_serialized",
      visibleText: "abcde",
    };
    const request: ProviderRequest = {
      requestClass: "main",
      model: "glm-5-turbo",
      messages: [
        { role: "system", content: "answer" },
        { role: "user", content: JSON.stringify({ evidence: text }) },
      ],
      requestedOutputTokens: 64,
      reasoning: "medium",
      sourceExposureProofs: [marker],
    };
    expect(() => providerRequestSourceExposureProofs(request, countTextTokens)).not.toThrow();
  });

  it("redacts private fields recursively at the live boundary", () => {
    const request = memoryToolRequest("recursive private");
    expect(() =>
      requireLiveProviderRequest({
        ...request,
        messages: request.messages.map((message) =>
          message.role === "tool"
            ? { ...message, content: JSON.stringify({ nested: { snapshotId: "secret" } }) }
            : message,
        ),
      }),
    ).toThrow(/private source identity/u);
  });

  it("normalizes system schema instructions into one provider system message", () => {
    const request: ProviderRequest = {
      requestClass: "fast",
      model: "glm-5-turbo",
      messages: [
        { role: "system", content: "one" },
        { role: "system", content: "two" },
        { role: "user", content: "body" },
      ],
      responseSchema: { type: "object" },
      requestedOutputTokens: 64,
      reasoning: "low",
    };
    expect(normalizeProviderRequest(request).messages[0]).toMatchObject({ role: "system" });
    expect(normalizeProviderRequest(request).messages).toHaveLength(2);
  });

  it("keeps tool result order bound to result indices", () => {
    const first = memoryToolRequest("first");
    const second = memoryToolRequest("second");
    expect(providerRequestSha256Hex(first)).not.toBe(providerRequestSha256Hex(second));
  });

  it("rejects a source proof whose visible text is only a substring", () => {
    const text = "complete visible source";
    const marker = documentMarker(text);
    expect(() =>
      providerRequestSourceExposureProofs(
        reviewRequest([{ kind: "document", preview: text }], [proofFor(marker, "visible source")]),
        countTextTokens,
      ),
    ).toThrow(/source field|content/u);
  });

  it("requires both distinct request bindings for repeated memory fields", () => {
    const text = "memory occurrence";
    const marker = {
      sourceKind: "memory" as const,
      logicalSourceIdentity: "memory:memory-1",
      contentItemIdentity: "revision-1",
      exposureStage: "memory_tool_result",
      visibleTokenCount: countTextTokens(text),
    };
    const request: ProviderRequest = {
      ...memoryToolRequest(text),
      messages: [
        ...memoryToolRequest(text).messages,
        { role: "user", content: JSON.stringify({ results: [{ kind: "memory", preview: text }] }) },
      ],
      sourceExposureProofs: [
        {
          ...marker,
          visibleText: text,
          sourceOrdinal: 0,
          serializedField: "messages[2].content.items[0].content",
        },
      ],
    };
    expect(() => providerRequestSourceExposureProofs(request, countTextTokens)).toThrow(
      /proof|field|coordinate/u,
    );
  });
  it("binds search previews to exact immutable document ranges", () => {
    const text = "abc";
    const range = { charStart: 0, charEnd: text.length };
    const call: ProviderToolCall = {
      id: "search-1",
      name: "search_evidence",
      arguments: { query: "abc" },
    };
    const marker = exactDocumentMarker(text, "evaluation_general_planner_search", range);
    const result = {
      matches: [{ kind: "document", documentId: "doc-1", text, ...range }],
    };
    const proof: CodeOwnedSourceExposureProof = {
      ...marker,
      visibleText: text,
      sourceToolCallId: call.id,
      sourceResultIndex: 0,
    };
    const request = requestWithToolExchanges([{ call, result }], [proof]);
    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(1);
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolExchanges(
          [{ call, result }],
          [{ ...proof, contentItemIdentity: `${marker.logicalSourceIdentity}:snapshot-1:wrong` }],
        ),
        countTextTokens,
      ),
    ).toThrow(/exact|identity|range/u);
  });

  it("binds inspection text to its exact immutable document range", () => {
    const text = "inspect";
    const range = { charStart: 2, charEnd: 2 + text.length };
    const call: ProviderToolCall = {
      id: "inspect-1",
      name: "inspect_evidence",
      arguments: { id: "document:doc-1", range },
    };
    const marker = exactDocumentMarker(text, "evaluation_general_planner_inspect", range);
    const result = {
      found: true,
      complete: true,
      kind: "document",
      documentId: "doc-1",
      text,
      range,
    };
    const proof: CodeOwnedSourceExposureProof = {
      ...marker,
      visibleText: text,
      sourceToolCallId: call.id,
      sourceResultIndex: 0,
    };
    expect(
      providerRequestSourceExposureProofs(
        requestWithToolExchanges([{ call, result }], [proof]),
        countTextTokens,
      ),
    ).toHaveLength(1);
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolExchanges(
          [{ call, result }],
          [
            {
              ...proof,
              contentItemIdentity: `${marker.logicalSourceIdentity}:snapshot-1:${sha256Base64Url(
                JSON.stringify([{ charStart: 0, charEnd: text.length }]),
              )}`,
            },
          ],
        ),
        countTextTokens,
      ),
    ).toThrow(/exact|range|identity/u);
  });

  it("binds candidate inspection proofs to the exact document range", () => {
    const text = "candidate";
    const range = { charStart: 4, charEnd: 4 + text.length };
    const logicalSourceIdentity = namespacedDocumentEvidenceIdentity(
      { kind: "public", sourceId: "public:candidate" },
      "doc-1",
    );
    const call: ProviderToolCall = {
      id: "candidate-1",
      name: "inspect_candidate",
      arguments: {
        id: logicalSourceIdentity,
        range,
      },
    };
    const marker: ProviderVisibleSourceExposureMarker = {
      sourceKind: "document",
      logicalSourceIdentity,
      contentItemIdentity: `${logicalSourceIdentity}:snapshot-1:${sha256Base64Url(
        JSON.stringify([range]),
      )}`,
      exposureStage: "context_candidate_inspection",
      visibleTokenCount: countTextTokens(text),
    };
    const result = {
      found: true,
      complete: true,
      kind: "document",
      documentId: "doc-1",
      text,
      ranges: [range],
      __briefSourceIdentity: {
        snapshotId: "snapshot-1",
        contentHash: sha256(text),
        source: { kind: "public", sourceId: "public:candidate" },
        ranges: [range],
      },
      __briefSourceExposures: [marker],
    };
    const proof = providerSourceExposureProofFromToolResult(
      call.name,
      result,
      call,
      countTextTokens,
    )[0]!;
    expect(
      providerRequestSourceExposureProofs(
        requestWithToolExchanges([{ call, result: redactProviderToolResult(result) }], [proof]),
        countTextTokens,
      ),
    ).toHaveLength(1);
    expect(() =>
      providerSourceExposureProofFromToolResult(
        call.name,
        { ...result, ranges: [{ charStart: 0, charEnd: text.length }] },
        call,
        countTextTokens,
      ),
    ).toThrow(/range|identity/u);
  });
  it("rejects a web proof whose quote hash does not match its visible text", () => {
    const text = "web preview";
    const url = "https://example.com/source";
    const call: ProviderToolCall = {
      id: "web-1",
      name: "web_search",
      arguments: { query: "source" },
    };
    const result = { results: [{ url, snippet: text }] };
    const proof: CodeOwnedSourceExposureProof = {
      sourceKind: "web",
      logicalSourceIdentity: url,
      contentItemIdentity: `${url}:${sha256Base64Url(text)}`,
      exposureStage: "web_search_preview",
      visibleTokenCount: countTextTokens(text),
      visibleText: text,
      sourceToolCallId: call.id,
      sourceResultIndex: 0,
    };
    expect(
      providerRequestSourceExposureProofs(
        requestWithToolExchanges([{ call, result }], [proof]),
        countTextTokens,
      ),
    ).toHaveLength(1);
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolExchanges(
          [{ call, result }],
          [{ ...proof, contentItemIdentity: `${url}:${sha256Base64Url("changed")}` }],
        ),
        countTextTokens,
      ),
    ).toThrow(/exact|identity|visible/u);
  });

  it("validates memory and web marker inventories without a provider sidecar", () => {
    const memoryText = "memory result";
    const memoryCall: ProviderToolCall = {
      id: "memory-2",
      name: "search_memories",
      arguments: { query: "memory" },
    };
    const memoryResult = {
      items: [
        {
          memoryId: "memory-2",
          memoryRevisionId: "revision-2",
          content: memoryText,
        },
      ],
      __briefSourceExposures: [
        {
          sourceKind: "memory",
          logicalSourceIdentity: "memory:memory-2",
          contentItemIdentity: "revision-2",
          exposureStage: "memory_tool_result",
          visibleTokenCount: countTextTokens(memoryText),
        },
      ],
    };
    const memoryProof = providerSourceExposureProofFromToolResult(
      memoryCall.name,
      memoryResult,
      memoryCall,
      countTextTokens,
    );
    expect(memoryProof).toHaveLength(1);

    const webText = "web result";
    const webCall: ProviderToolCall = {
      id: "web-2",
      name: "web_fetch",
      arguments: { url: "https://example.com/result" },
    };
    const webUrl = "https://example.com/result";
    const webResult = {
      url: webUrl,
      text: webText,
      __briefSourceExposures: [
        {
          sourceKind: "web",
          logicalSourceIdentity: webUrl,
          contentItemIdentity: `${webUrl}:${sha256Base64Url(webText)}`,
          exposureStage: "web_fetch",
          visibleTokenCount: countTextTokens(webText),
        },
      ],
    };
    expect(
      providerSourceExposureProofFromToolResult(webCall.name, webResult, webCall, countTextTokens),
    ).toHaveLength(1);
  });

  it("accepts a redacted web answer proof at its exact source wrapper", () => {
    const text = "web answer";
    const key = `k_cn_${"a".repeat(22)}_1`;
    const url = "https://example.com/answer";
    const marker: CodeOwnedSourceExposureProof = {
      sourceKind: "web",
      logicalSourceIdentity: url,
      contentItemIdentity: `${url}:${sha256Base64Url(text)}`,
      exposureStage: "answer_serialized",
      visibleTokenCount: countTextTokens(text),
      visibleText: text,
    };
    const request: ProviderRequest = {
      requestClass: "main",
      model: "glm-5-turbo",
      messages: [
        { role: "system", content: "answer" },
        { role: "user", content: JSON.stringify({ evidence: answerWrapper(key, "web", text) }) },
      ],
      requestedOutputTokens: 64,
      reasoning: "medium",
      sourceExposureProofs: [marker],
    };
    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(1);
  });

  it("frames delimiter-like answer text without truncating any source kind", () => {
    const text = "literal </source> and <source> delimiters";
    const key = `k_cn_${"b".repeat(22)}_2`;
    const marker: CodeOwnedSourceExposureProof = {
      sourceKind: "chat_message",
      logicalSourceIdentity: chatMessageEvidenceIdentity("answer-message"),
      contentItemIdentity: "answer-message",
      exposureStage: "answer_serialized",
      visibleTokenCount: countTextTokens(text),
      visibleText: text,
      chatReconstruction: {
        messageId: "answer-message",
        contentHash: sha256(text),
        ranges: [{ charStart: 0, charEnd: text.length }],
      },
    };
    const request: ProviderRequest = {
      requestClass: "main",
      model: "glm-5-turbo",
      messages: [
        { role: "system", content: "answer" },
        {
          role: "user",
          content: JSON.stringify({ evidence: answerWrapper(key, "chat_message", text) }),
        },
      ],
      requestedOutputTokens: 64,
      reasoning: "medium",
      sourceExposureProofs: [marker],
    };
    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(1);
  });

  it("rejects malformed or legacy answer source framing", () => {
    const text = "answer";
    const key = `k_cn_${"c".repeat(22)}_1`;
    const marker: CodeOwnedSourceExposureProof = {
      sourceKind: "web",
      logicalSourceIdentity: "https://example.com/answer",
      contentItemIdentity: `https://example.com/answer:${sha256Base64Url(text)}`,
      exposureStage: "answer_serialized",
      visibleTokenCount: countTextTokens(text),
      visibleText: text,
    };
    const request: ProviderRequest = {
      requestClass: "main",
      model: "glm-5-turbo",
      messages: [
        { role: "system", content: "answer" },
        {
          role: "user",
          content: JSON.stringify({
            evidence: `<source key="${key}" kind="web" length="999">\n${text}\n</source>`,
          }),
        },
      ],
      requestedOutputTokens: 64,
      reasoning: "medium",
      sourceExposureProofs: [marker],
    };
    expect(() => providerRequestSourceExposureProofs(request, countTextTokens)).toThrow(
      /framing|body|source/u,
    );
  });

  it("binds selected conversation and answer evidence in one global request order", () => {
    const conversationText = "selected conversation";
    const answerText = "selected answer";
    const key = `k_cn_${"d".repeat(22)}_3`;
    const answerUrl = "https://example.com/global";
    const request: ProviderRequest = {
      requestClass: "main",
      model: "glm-5-turbo",
      messages: [
        { role: "system", content: "answer" },
        {
          role: "user",
          content: JSON.stringify({
            currentMessage: conversationText,
            currentMessageId: "conversation-1",
            evidence: answerWrapper(key, "web", answerText),
          }),
        },
      ],
      requestedOutputTokens: 64,
      reasoning: "medium",
      sourceExposureProofs: [
        proofFor(chatMarker("conversation-1", conversationText), conversationText),
        {
          sourceKind: "web",
          logicalSourceIdentity: answerUrl,
          contentItemIdentity: `${answerUrl}:${sha256Base64Url(answerText)}`,
          exposureStage: "answer_serialized",
          visibleTokenCount: countTextTokens(answerText),
          visibleText: answerText,
        },
      ],
    };
    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(2);
    expect(() =>
      providerRequestSourceExposureProofs(
        {
          ...request,
          sourceExposureProofs: [...request.sourceExposureProofs!].reverse(),
        },
        countTextTokens,
      ),
    ).toThrow(/exact|identity|order/u);
  });
  it("binds valid conversation, memory, and web exposures to ordered fields", () => {
    const conversationText = "conversation evidence";
    const memoryText = "memory evidence";
    const webText = "web evidence";
    const memoryCall: ProviderToolCall = {
      id: "memory-ordered",
      name: "search_memories",
      arguments: { query: "memory" },
    };
    const webCall: ProviderToolCall = {
      id: "web-ordered",
      name: "web_fetch",
      arguments: { url: "https://example.com/ordered" },
    };
    const webUrl = "https://example.com/ordered";
    const request: ProviderRequest = {
      requestClass: "fast",
      model: "glm-5-turbo",
      messages: [
        { role: "system", content: "ordered" },
        {
          role: "user",
          content: JSON.stringify({
            currentMessage: conversationText,
            currentMessageId: "conversation-ordered",
          }),
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [memoryCall],
        },
        {
          role: "tool",
          toolCallId: memoryCall.id,
          name: memoryCall.name,
          content: JSON.stringify({
            items: [
              {
                memoryId: "memory-ordered",
                memoryRevisionId: "revision-ordered",
                content: memoryText,
              },
            ],
          }),
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [webCall],
        },
        {
          role: "tool",
          toolCallId: webCall.id,
          name: webCall.name,
          content: JSON.stringify({ url: webUrl, text: webText }),
        },
      ],
      requestedOutputTokens: 64,
      reasoning: "medium",
      sourceExposureProofs: [
        proofFor(chatMarker("conversation-ordered", conversationText), conversationText),
        {
          sourceKind: "memory",
          logicalSourceIdentity: "memory:memory-ordered",
          contentItemIdentity: "revision-ordered",
          exposureStage: "memory_tool_result",
          visibleTokenCount: countTextTokens(memoryText),
          visibleText: memoryText,
          sourceToolCallId: memoryCall.id,
          sourceResultIndex: 0,
        },
        {
          sourceKind: "web",
          logicalSourceIdentity: webUrl,
          contentItemIdentity: `${webUrl}:${sha256Base64Url(webText)}`,
          exposureStage: "web_fetch",
          visibleTokenCount: countTextTokens(webText),
          visibleText: webText,
          sourceToolCallId: webCall.id,
          sourceResultIndex: 0,
        },
      ],
    };
    expect(providerRequestSourceExposureProofs(request, countTextTokens)).toHaveLength(3);
  });
  it("rejects the reserved inventory on an unrelated tool", () => {
    const call: ProviderToolCall = {
      id: "unrelated-1",
      name: "other_tool",
      arguments: {},
    };
    const request = requestWithToolExchanges([
      {
        call,
        result: {
          value: "not evidence",
          __briefSourceExposures: [],
        },
      },
    ]);
    expect(() => providerRequestSourceExposureProofs(request, countTextTokens)).toThrow(
      /code-owned|reserved|exposure/u,
    );
  });

  it("does not exchange equal-text opaque candidate proofs between calls", () => {
    const text = "same candidate text";
    const url = "https://example.com/candidate";
    const firstCall: ProviderToolCall = {
      id: "candidate-call-1",
      name: "web_fetch",
      arguments: { url },
    };
    const secondCall: ProviderToolCall = {
      id: "candidate-call-2",
      name: "web_fetch",
      arguments: { url },
    };
    const result = { url, text };
    const proof: CodeOwnedSourceExposureProof = {
      sourceKind: "web",
      logicalSourceIdentity: url,
      contentItemIdentity: `${url}:${sha256Base64Url(text)}`,
      exposureStage: "web_fetch",
      visibleTokenCount: countTextTokens(text),
      visibleText: text,
      sourceToolCallId: firstCall.id,
      sourceResultIndex: 0,
    };
    expect(
      providerRequestSourceExposureProofs(
        requestWithToolExchanges([{ call: firstCall, result }], [proof]),
        countTextTokens,
      ),
    ).toHaveLength(1);
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolExchanges([{ call: secondCall, result }], [proof]),
        countTextTokens,
      ),
    ).toThrow(/coordinate|call|source/u);
  });

  it("binds candidate search previews to distinct documents and ranges", () => {
    const text = "match";
    const range = { charStart: 1, charEnd: 1 + text.length };
    const scopeRange = { charStart: 0, charEnd: 20 };
    const logicalSourceIdentity = namespacedDocumentEvidenceIdentity(
      { kind: "public", sourceId: "public:candidate-search" },
      "doc-1",
    );
    const call: ProviderToolCall = {
      id: "candidate-search-1",
      name: "search_within_candidate",
      arguments: { id: logicalSourceIdentity, query: "match", cursor: 0 },
    };
    const marker: ProviderVisibleSourceExposureMarker = {
      sourceKind: "document",
      logicalSourceIdentity,
      contentItemIdentity: `${logicalSourceIdentity}:snapshot-1:${sha256Base64Url(
        JSON.stringify([range]),
      )}`,
      exposureStage: "context_candidate_inspection",
      visibleTokenCount: countTextTokens(text),
    };
    const result = {
      found: true,
      kind: "document",
      documentId: "doc-1",
      matches: [range],
      matchPreviews: [{ range, text }],
      scope: {
        kind: "selected_document_ranges",
        ranges: [scopeRange],
        matchOffset: 0,
        maximumMatches: 500,
      },
      __briefSourceIdentity: {
        snapshotId: "snapshot-1",
        contentHash: sha256(text),
        source: { kind: "public", sourceId: "public:candidate-search" },
      },
      __briefSourceExposures: [marker],
    };
    const proof = providerSourceExposureProofFromToolResult(
      call.name,
      result,
      call,
      countTextTokens,
    )[0]!;
    expect(
      providerRequestSourceExposureProofs(
        requestWithToolExchanges([{ call, result: redactProviderToolResult(result) }], [proof]),
        countTextTokens,
      ),
    ).toHaveLength(1);
    expect(() =>
      providerSourceExposureProofFromToolResult(
        call.name,
        {
          ...result,
          scope: { ...result.scope, ranges: [{ charStart: 10, charEnd: 20 }, scopeRange] },
        },
        call,
        countTextTokens,
      ),
    ).toThrow(/canonical|scope|range/u);
  });
  it("requires one exact proof per message in a structured conversation entry", () => {
    const call: ProviderToolCall = {
      id: "conversation-inspect",
      name: "inspect_candidate",
      arguments: { id: "conversation_entry:turn-1" },
    };
    const result = {
      found: true,
      complete: true,
      conversationEntry: {
        turnId: "turn-1",
        userMessageId: "user-1",
        userContent: "user evidence",
        assistantMessageId: "assistant-1",
        assistantContent: "assistant evidence",
      },
      __briefSourceIdentity: [
        {
          messageId: "user-1",
          contentHash: sha256("user evidence"),
          ranges: [{ charStart: 0, charEnd: "user evidence".length }],
        },
        {
          messageId: "assistant-1",
          contentHash: sha256("assistant evidence"),
          ranges: [{ charStart: 0, charEnd: "assistant evidence".length }],
        },
      ],
      __briefSourceExposures: [
        {
          sourceKind: "chat_message",
          logicalSourceIdentity: chatMessageEvidenceIdentity("user-1"),
          contentItemIdentity: "user-1",
          exposureStage: "provider_input",
          visibleTokenCount: countTextTokens("user evidence"),
        },
        {
          sourceKind: "chat_message",
          logicalSourceIdentity: chatMessageEvidenceIdentity("assistant-1"),
          contentItemIdentity: "assistant-1",
          exposureStage: "provider_input",
          visibleTokenCount: countTextTokens("assistant evidence"),
        },
      ],
    };
    const proofs = providerSourceExposureProofFromToolResult(
      call.name,
      result,
      call,
      countTextTokens,
    );
    expect(proofs).toHaveLength(2);
    const redacted = redactProviderToolResult(result);
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolExchanges([{ call, result: redacted }], [proofs[0]!]),
        countTextTokens,
      ),
    ).toThrow(/missing|proof|conversation/u);
    expect(
      providerRequestSourceExposureProofs(
        requestWithToolExchanges([{ call, result: redacted }], proofs),
        countTextTokens,
      ),
    ).toHaveLength(2);
  });
  it("accepts opaque publisher document identities without rebinding them", () => {
    const text = "publisher evidence";
    const range = { charStart: 0, charEnd: text.length };
    const logicalSourceIdentity = namespacedDocumentEvidenceIdentity(
      {
        kind: "publisher",
        sourceId: "publisher:subscription-1",
        issueId: "issue-1",
        documentId: "doc-1",
      },
      "doc-1",
    );
    const call: ProviderToolCall = {
      id: "publisher-search",
      name: "search_evidence",
      arguments: { query: "publisher" },
    };
    const marker: CodeOwnedSourceExposureProof = {
      sourceKind: "document",
      logicalSourceIdentity,
      contentItemIdentity: `${logicalSourceIdentity}:snapshot-1:${sha256Base64Url(
        JSON.stringify([range]),
      )}`,
      exposureStage: "evaluation_general_planner_search",
      visibleTokenCount: countTextTokens(text),
      visibleText: text,
      sourceToolCallId: call.id,
      sourceResultIndex: 0,
    };
    const result = {
      matches: [{ kind: "document", documentId: "doc-1", text, ...range }],
    };
    expect(
      providerRequestSourceExposureProofs(
        requestWithToolExchanges([{ call, result }], [marker]),
        countTextTokens,
      ),
    ).toHaveLength(1);
  });
  it("binds every ordered passage from a plural read result", () => {
    const call: ProviderToolCall = {
      id: "read-1",
      name: "read_source_passages",
      arguments: { candidateId: "c1", passageIds: ["p1", "p2"] },
    };
    const passages = [
      { passageId: "p1", text: "first passage" },
      { passageId: "p2", text: "second passage" },
    ];
    const result = {
      found: true,
      complete: true,
      truncated: false,
      cursor: null,
      passages,
      __briefSourceExposures: passages.map((passage) => {
        const range = { charStart: 0, charEnd: passage.text.length };
        const logicalSourceIdentity = namespacedDocumentEvidenceIdentity(
          { kind: "public", sourceId: "public:source-1" },
          "doc-1",
        );
        return {
          sourceKind: "document" as const,
          logicalSourceIdentity,
          contentItemIdentity: `${logicalSourceIdentity}:snapshot-1:${sha256Base64Url(
            JSON.stringify([range]),
          )}`,
          exposureStage: "context_compaction_input",
          visibleTokenCount: countTextTokens(passage.text),
        };
      }),
      __briefSourceIdentity: passages.map((passage) => ({
        snapshotId: "snapshot-1",
        contentHash: sha256(passage.text),
        source: { kind: "public", sourceId: "public:source-1" },
        ranges: [{ charStart: 0, charEnd: passage.text.length }],
      })),
    };
    const proofs = providerSourceExposureProofFromToolResult(
      call.name,
      result,
      call,
      countTextTokens,
    );
    expect(proofs).toHaveLength(2);
    expect(proofs.map((proof) => proof.passageId)).toEqual(["p1", "p2"]);
    expect(() =>
      providerSourceExposureProofFromToolResult(
        call.name,
        { ...result, passage: passages[0] },
        call,
        countTextTokens,
      ),
    ).toThrow(/passages only/u);
  });
  it("binds chat source-tool passage ranges to their exact reconstruction range", () => {
    const text = "chat source passage";
    const range = { charStart: 0, charEnd: text.length };
    const call: ProviderToolCall = {
      id: "chat-read-1",
      name: "read_source_passages",
      arguments: { candidateId: "c1", passageIds: ["p1"] },
    };
    const messageId = "chat-source-message";
    const result = {
      found: true,
      complete: true,
      truncated: false,
      cursor: null,
      passages: [{ passageId: "p1", text }],
      __briefSourceExposures: [
        {
          sourceKind: "chat_message" as const,
          logicalSourceIdentity: chatMessageEvidenceIdentity(messageId),
          contentItemIdentity: messageId,
          exposureStage: "context_compaction_input" as const,
          visibleTokenCount: countTextTokens(text),
        },
      ],
      __briefSourceIdentity: [
        {
          candidateId: "c1",
          passageId: "p1",
          ...range,
          visibleByteCount: new TextEncoder().encode(text).byteLength,
          chatReconstruction: {
            messageId,
            contentHash: sha256(text),
            ranges: [range],
          },
        },
      ],
    };
    const proofs = providerSourceExposureProofFromToolResult(
      call.name,
      result,
      call,
      countTextTokens,
    );
    expect(
      providerRequestSourceExposureProofs(
        requestWithToolExchanges([{ call, result: redactProviderToolResult(result) }], proofs),
        countTextTokens,
      ),
    ).toHaveLength(1);
    const proof = proofs[0]!;
    const reconstruction = proof.chatReconstruction!;
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolExchanges(
          [{ call, result: redactProviderToolResult(result) }],
          [
            {
              ...proof,
              chatReconstruction: {
                ...reconstruction,
                ranges: [{ charStart: 1, charEnd: text.length + 1 }],
              },
            },
          ],
        ),
        countTextTokens,
      ),
    ).toThrow(/reconstruction range|exact passage range/u);
  });
  it("keeps repeated passage proofs one-to-one across source-tool results", () => {
    const calls: readonly ProviderToolCall[] = [
      {
        id: "read-1",
        name: "read_source_passages",
        arguments: { candidateId: "c1", passageIds: ["p1"] },
      },
      {
        id: "read-2",
        name: "read_source_passages",
        arguments: { candidateId: "c1", passageIds: ["p1"] },
      },
    ];
    const makeResult = () => {
      const text = "repeated passage";
      const ranges = [{ charStart: 0, charEnd: text.length }];
      const logicalSourceIdentity = namespacedDocumentEvidenceIdentity(
        { kind: "public", sourceId: "public:source-1" },
        "doc-1",
      );
      return {
        found: true,
        complete: true,
        truncated: false,
        cursor: null,
        passages: [{ passageId: "p1", text }],
        __briefSourceExposures: [
          {
            sourceKind: "document" as const,
            logicalSourceIdentity,
            contentItemIdentity: `${logicalSourceIdentity}:snapshot-1:${sha256Base64Url(
              JSON.stringify(ranges),
            )}`,
            exposureStage: "context_compaction_input" as const,
            visibleTokenCount: countTextTokens(text),
          },
        ],
        __briefSourceIdentity: [
          {
            snapshotId: "snapshot-1",
            contentHash: sha256(text),
            source: { kind: "public", sourceId: "public:source-1" },
            ranges,
          },
        ],
      };
    };
    const results = calls.map(() => makeResult());
    const proofs = calls.flatMap((call, index) =>
      providerSourceExposureProofFromToolResult(call.name, results[index]!, call, countTextTokens),
    );
    expect(proofs).toHaveLength(2);
    expect(proofs.map((proof) => proof.sourceResultIndex)).toEqual([0, 0]);
    expect(
      providerRequestSourceExposureProofs(
        requestWithToolExchanges(
          calls.map((call, index) => ({ call, result: redactProviderToolResult(results[index]!) })),
          proofs,
        ),
        countTextTokens,
      ),
    ).toHaveLength(2);
    expect(() =>
      providerRequestSourceExposureProofs(
        requestWithToolExchanges(
          calls.map((call, index) => ({ call, result: redactProviderToolResult(results[index]!) })),
          [proofs[0]!, { ...proofs[1]!, passageId: "p2" }],
        ),
        countTextTokens,
      ),
    ).toThrow(/content|text|proof|sidecar/u);
  });
  it("rejects legacy source-tool argument names and cursor types", () => {
    const cases: readonly ProviderToolCall[] = [
      {
        id: "legacy-terms",
        name: "search_source_passages",
        arguments: { candidateId: "c1", terms: "exact" },
      },
      {
        id: "numeric-cursor",
        name: "search_source_passages",
        arguments: { candidateId: "c1", query: "exact", cursor: 1 },
      },
      {
        id: "legacy-adjacent",
        name: "read_source_passages",
        arguments: { candidateId: "c1", passageIds: ["p1"], adjacentPassageId: "p2" },
      },
    ];
    for (const call of cases) {
      expect(() =>
        providerRequestSourceExposureProofs(
          requestWithToolExchanges([{ call, result: {} }]),
          countTextTokens,
        ),
      ).toThrow(/arguments are not canonical/u);
    }
  });
  it("binds sanitized conversation previews separately in initial and fallback payloads", () => {
    const userText = "User request";
    const assistantText = "Assistant answer";
    const proofs = [
      compactionChatProof(userText, "user-message-1"),
      compactionChatProof(assistantText, "assistant-message-1"),
    ];
    const requestFor = (
      payload: Readonly<Record<string, unknown>>,
      sourceProofs: readonly CodeOwnedSourceExposureProof[] = proofs,
    ): ProviderRequest => ({
      requestClass: "fast",
      model: "glm-5-turbo",
      messages: [
        { role: "system", content: "compaction" },
        { role: "user", content: JSON.stringify(payload) },
      ],
      requestedOutputTokens: 128,
      reasoning: "medium",
      sourceExposureProofs: sourceProofs,
    });
    const initialPayload = {
      question: "q",
      allowance: 100,
      overage: 10,
      mandatoryInputCost: 20,
      candidates: [
        conversationPreviewCandidate({
          userContent: userText,
          assistantContent: assistantText,
        }),
      ],
      toolBounds: { maximumCandidates: 4, maximumGroups: 2 },
    };
    expect(
      providerRequestSourceExposureProofs(requestFor(initialPayload), countTextTokens),
    ).toHaveLength(2);
    expect(initialPayload.candidates[0]).not.toHaveProperty("userMessageId");
    expect(initialPayload.candidates[0]).not.toHaveProperty("assistantMessageId");
    const fallbackPayload = {
      question: "q",
      allowance: 100,
      remainingOverage: 10,
      originalCandidates: [
        conversationPreviewCandidate({
          userContent: userText,
          assistantContent: assistantText,
        }),
      ],
      initialManifest: { decisions: [], groups: [] },
      firstPass: [],
    };
    expect(
      providerRequestSourceExposureProofs(requestFor(fallbackPayload), countTextTokens),
    ).toHaveLength(2);
    const failedPayload = {
      ...initialPayload,
      candidates: [
        conversationPreviewCandidate({
          userContent: userText,
          errorCode: "provider_failed",
          retryable: false,
        }),
      ],
    };
    expect(
      providerRequestSourceExposureProofs(requestFor(failedPayload, [proofs[0]!]), countTextTokens),
    ).toHaveLength(1);
    expect(() =>
      providerRequestSourceExposureProofs(
        requestFor({
          ...initialPayload,
          candidates: [
            conversationPreviewCandidate({
              userContent: "Changed request",
              assistantContent: assistantText,
            }),
          ],
        }),
        countTextTokens,
      ),
    ).toThrow(/exact normalized source field|compaction field/u);
    expect(() =>
      providerRequestSourceExposureProofs(
        requestFor({
          ...initialPayload,
          candidates: [
            conversationPreviewCandidate({
              userContent: userText,
              assistantContent: "Changed answer",
            }),
          ],
        }),
        countTextTokens,
      ),
    ).toThrow(/exact normalized source field|compaction field/u);
    expect(() =>
      providerRequestSourceExposureProofs(
        requestFor(initialPayload, [{ ...proofs[0]!, charStart: 1 }, proofs[1]!]),
        countTextTokens,
      ),
    ).toThrow(/range|commitment|compaction/u);
    expect(() =>
      providerRequestSourceExposureProofs(
        requestFor(initialPayload, [
          {
            ...proofs[0]!,
            logicalSourceIdentity: chatMessageEvidenceIdentity("user-message-2"),
            contentItemIdentity: "user-message-2",
          },
          proofs[1]!,
        ]),
        countTextTokens,
      ),
    ).toThrow(/identity|commitment|compaction|reconstruction/u);
  });
  it("binds group passage ranges into ordered provider descriptors", () => {
    const text = "group passage";
    const proof = compactionChatProof(text, "user-message-1", "c1", "p1");
    const payload = {
      question: "q",
      group: {
        groupId: "g1",
        candidateIds: ["c1"],
        renderedTokenBudget: 32,
        mode: "normal",
      },
      candidates: [
        {
          candidateId: "c1",
          kind: "conversation_entry",
          label: "Conversation",
          purpose: "answer",
          date: null,
          passages: [{ passageId: "p1", text }],
        },
      ],
      taskId: "group-task",
      phase: "compact",
    };
    const request: ProviderRequest = {
      requestClass: "fast",
      model: "glm-5-turbo",
      messages: [
        { role: "system", content: "compaction" },
        { role: "user", content: JSON.stringify(payload) },
      ],
      requestedOutputTokens: 128,
      reasoning: "medium",
      sourceExposureProofs: [proof],
    };
    const bindings = providerRequestSourceExposureProofBindings(request, countTextTokens);
    expect(bindings).toHaveLength(1);
    const ordered = JSON.parse(bindings[0]!.binding.orderedSourceDescriptor) as Record<
      string,
      unknown
    >;
    expect(ordered).toMatchObject({
      candidateId: "c1",
      passageId: "p1",
      charStart: 0,
      charEnd: text.length,
    });
    expect(() =>
      providerRequestSourceExposureProofs(
        {
          ...request,
          sourceExposureProofs: [
            {
              ...proof,
              charEnd: text.length + 1,
            },
          ],
        },
        countTextTokens,
      ),
    ).toThrow(/commitment|compaction|range/u);
    expect(() =>
      providerRequestSourceExposureProofs(
        {
          ...request,
          sourceExposureProofs: [
            {
              ...proof,
              orderedSourceDescriptor: stableJson({
                ...ordered,
                charEnd: text.length + 1,
              }),
            },
          ],
        },
        countTextTokens,
      ),
    ).toThrow(/ordered|descriptor|request location/u);
  });
});
