import { createHash } from "node:crypto";

import {
  chatMessageEvidenceIdentity,
  namespacedDocumentEvidenceIdentity,
  sha256Base64Url,
  type DocumentEvidenceNamespace,
} from "./canonicalization";

export type ProviderMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: readonly ProviderToolCall[] | undefined;
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly name: string;
      readonly content: string;
    };

export interface ProviderToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ProviderToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  /** Derived during normalization to mirror Pi's exact OpenAI function transport. */
  readonly strict?: false | undefined;
}

export interface ProviderRequest {
  /** Budget class is independent of model identity; evaluation may use historical captures. */
  readonly requestClass: "fast" | "main";
  readonly model: string;
  readonly messages: readonly ProviderMessage[];
  readonly tools?: readonly ProviderToolDefinition[] | undefined;
  readonly toolChoice?: "auto" | "required" | "none" | { readonly name: string } | undefined;
  readonly responseSchema?: Readonly<Record<string, unknown>> | undefined;
  readonly requestedOutputTokens: number;
  readonly reasoning: "minimal" | "low" | "medium" | "high";
}

/**
 * Request shape accepted by the live chat runtime.  Historical model IDs stay
 * available to explicit evaluation/compatibility code through ProviderRequest,
 * but they must never cross the production Pi boundary.
 */
export type LiveProviderRequest = Omit<ProviderRequest, "model"> & {
  readonly model: "glm-5-turbo";
};

export const isLiveProviderRequest = (request: ProviderRequest): request is LiveProviderRequest =>
  request.model === "glm-5-turbo";

export const requireLiveProviderRequest = (request: ProviderRequest): LiveProviderRequest => {
  if (!isLiveProviderRequest(request)) {
    throw new Error(
      `live AI provider requests require model glm-5-turbo; ${request.model} is evaluation/compatibility-only`,
    );
  }
  return request;
};

export interface ProviderVisibleSourceExposureMarker {
  readonly sourceKind: "document" | "chat_message" | "memory" | "web";
  readonly logicalSourceIdentity: string;
  readonly contentItemIdentity: string;
  readonly exposureStage: string;
  readonly visibleTokenCount: number;
}

export const stableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, item]) => [key, stableJsonValue(item)]),
    );
  }
  return value;
};

export const stableJson = (value: unknown): string => JSON.stringify(stableJsonValue(value));

/** Content-free identity of the exact normalized provider request. */
export const providerRequestSha256Hex = (request: ProviderRequest): string =>
  createHash("sha256")
    .update(stableJson(normalizeProviderRequest(request)))
    .digest("hex");

export const providerVisibleSourceExposureProofSha256Hex = (
  marker: ProviderVisibleSourceExposureMarker,
): string => createHash("sha256").update(stableJson(marker)).digest("hex");

const isProviderVisibleSourceExposureMarker = (
  value: unknown,
): value is ProviderVisibleSourceExposureMarker => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return (
    Object.keys(marker).length === 5 &&
    (marker.sourceKind === "document" ||
      marker.sourceKind === "chat_message" ||
      marker.sourceKind === "memory" ||
      marker.sourceKind === "web") &&
    typeof marker.logicalSourceIdentity === "string" &&
    marker.logicalSourceIdentity.length > 0 &&
    typeof marker.contentItemIdentity === "string" &&
    marker.contentItemIdentity.length > 0 &&
    typeof marker.exposureStage === "string" &&
    marker.exposureStage.length > 0 &&
    typeof marker.visibleTokenCount === "number" &&
    Number.isSafeInteger(marker.visibleTokenCount) &&
    marker.visibleTokenCount >= 0
  );
};

type JsonRecord = Readonly<Record<string, unknown>>;

interface ExpectedVisibleSourceExposure {
  readonly sourceKind: ProviderVisibleSourceExposureMarker["sourceKind"];
  readonly logicalSourceIdentity: string;
  readonly exposureStage: string;
  readonly visibleText: string;
  readonly contentItemIdentity?: string | undefined;
}

const invalidDocumentNamespace = (context: string): never => {
  throw sourceExposureFailure(`${context} lacks an exact document source namespace`);
};

const hasExactDocumentSourceId = (
  kind: "public" | "publisher",
  sourceId: unknown,
): sourceId is string =>
  typeof sourceId === "string" &&
  (kind === "public" ? /^public:[^:\s]+$/u : /^publisher:[^:\s]+$/u).test(sourceId);

const documentNamespaceFromValue = (
  value: unknown,
  documentId: string,
  context: string,
): DocumentEvidenceNamespace => {
  if (!isJsonRecord(value)) return invalidDocumentNamespace(context);
  if (value.kind === "public") {
    if (
      Object.keys(value).some((key) => key !== "kind" && key !== "sourceId") ||
      !hasExactDocumentSourceId("public", value.sourceId)
    ) {
      return invalidDocumentNamespace(context);
    }
    return { kind: "public", sourceId: value.sourceId };
  }
  if (value.kind === "publisher") {
    if (
      Object.keys(value).some(
        (key) => key !== "kind" && key !== "sourceId" && key !== "issueId" && key !== "documentId",
      ) ||
      !hasExactDocumentSourceId("publisher", value.sourceId) ||
      typeof value.issueId !== "string" ||
      value.issueId.length === 0 ||
      typeof value.documentId !== "string" ||
      value.documentId.length === 0 ||
      value.documentId !== documentId
    ) {
      return invalidDocumentNamespace(context);
    }
    return {
      kind: "publisher",
      sourceId: value.sourceId,
      issueId: value.issueId,
      documentId: value.documentId,
    };
  }
  return invalidDocumentNamespace(context);
};

const documentNamespaceFromSearchItem = (value: JsonRecord): DocumentEvidenceNamespace => {
  if (typeof value.documentId !== "string" || value.documentId.length === 0) {
    return invalidDocumentNamespace("search_internal item");
  }
  if (value.kind === "public_source") {
    if (!hasExactDocumentSourceId("public", value.sourceId) || Object.hasOwn(value, "issueId")) {
      return invalidDocumentNamespace("search_internal public item");
    }
    return { kind: "public", sourceId: value.sourceId };
  }
  if (value.kind === "publisher") {
    if (!hasExactDocumentSourceId("publisher", value.sourceId)) {
      return invalidDocumentNamespace("search_internal publisher item");
    }
    if (typeof value.issueId !== "string" || value.issueId.length === 0) {
      return invalidDocumentNamespace("search_internal publisher item");
    }
    return {
      kind: "publisher",
      sourceId: value.sourceId,
      issueId: value.issueId,
      documentId: value.documentId,
    };
  }
  return invalidDocumentNamespace("search_internal item");
};

interface CanonicalInspectionRange {
  readonly charStart: number;
  readonly charEnd: number;
}

const SOURCE_EXPOSURE_FIELD = "__briefSourceExposures";

const isJsonRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sourceExposureFailure = (message: string): Error =>
  new Error(`invalid provider-visible source exposure: ${message}`);

const markersFromResult = (result: JsonRecord): readonly ProviderVisibleSourceExposureMarker[] => {
  if (!Object.hasOwn(result, SOURCE_EXPOSURE_FIELD)) return [];
  const value = result[SOURCE_EXPOSURE_FIELD];
  if (!Array.isArray(value)) {
    throw sourceExposureFailure(`${SOURCE_EXPOSURE_FIELD} must be an array`);
  }
  return value.map((marker) => {
    if (!isProviderVisibleSourceExposureMarker(marker)) {
      throw sourceExposureFailure("marker must contain exactly the five canonical fields");
    }
    return marker;
  });
};

const expectedInternalSearchExposures = (
  result: JsonRecord,
): readonly ExpectedVisibleSourceExposure[] => {
  if (!Array.isArray(result.items)) {
    throw sourceExposureFailure("search_internal result must contain an items array");
  }
  return result.items.map((value) => {
    if (!isJsonRecord(value) || typeof value.snippet !== "string") {
      throw sourceExposureFailure("search_internal item must contain an exact snippet");
    }
    const hasDocumentIdentity =
      typeof value.documentId === "string" &&
      value.documentId.length > 0 &&
      typeof value.documentVersionId === "string" &&
      value.documentVersionId.length > 0;
    const hasMessageIdentity = typeof value.messageId === "string";
    if (hasDocumentIdentity === hasMessageIdentity) {
      throw sourceExposureFailure("search_internal item must have one canonical source identity");
    }
    if (hasDocumentIdentity) {
      const namespace = documentNamespaceFromSearchItem(value);
      return {
        sourceKind: "document" as const,
        logicalSourceIdentity: namespacedDocumentEvidenceIdentity(
          namespace,
          value.documentId as string,
        ),
        contentItemIdentity: `${namespacedDocumentEvidenceIdentity(namespace, value.documentId as string)}:${value.documentVersionId as string}:${sha256Base64Url(value.snippet)}`,
        exposureStage: "internal_search_preview",
        visibleText: value.snippet,
      };
    }
    return {
      sourceKind: "chat_message" as const,
      logicalSourceIdentity: chatMessageEvidenceIdentity(value.messageId as string),
      contentItemIdentity: value.messageId as string,
      exposureStage: "internal_search_preview",
      visibleText: value.snippet,
    };
  });
};

const canonicalInspectionRanges = (value: unknown): readonly CanonicalInspectionRange[] => {
  if (!Array.isArray(value)) {
    throw sourceExposureFailure("document inspection must contain exact ranges");
  }
  return value.map((range) => {
    if (
      !isJsonRecord(range) ||
      Object.keys(range).length !== 2 ||
      typeof range.charStart !== "number" ||
      !Number.isSafeInteger(range.charStart) ||
      range.charStart < 0 ||
      typeof range.charEnd !== "number" ||
      !Number.isSafeInteger(range.charEnd) ||
      range.charEnd <= range.charStart
    ) {
      throw sourceExposureFailure("document inspection range is not canonical");
    }
    return { charStart: range.charStart as number, charEnd: range.charEnd as number };
  });
};

const expectedInternalInspectionExposures = (
  result: JsonRecord,
  toolCall: ProviderToolCall,
): readonly ExpectedVisibleSourceExposure[] => {
  const reference = isJsonRecord(toolCall.arguments.reference)
    ? toolCall.arguments.reference
    : undefined;
  const message = isJsonRecord(result.message) ? result.message : undefined;
  const hasText = typeof result.text === "string";
  if (message !== undefined && hasText) {
    throw sourceExposureFailure("inspect_internal result has two visible source bodies");
  }
  if (message === undefined && !hasText) return [];
  if (result.found !== true || result.complete !== true || reference === undefined) {
    throw sourceExposureFailure("inspect_internal visible body is not a complete found result");
  }
  if (message !== undefined) {
    if (
      reference.kind !== "chat_message" ||
      typeof reference.messageId !== "string" ||
      typeof message.messageId !== "string" ||
      message.messageId !== reference.messageId ||
      typeof message.content !== "string"
    ) {
      throw sourceExposureFailure("inspect_internal chat result differs from its tool reference");
    }
    return [
      {
        sourceKind: "chat_message",
        logicalSourceIdentity: chatMessageEvidenceIdentity(message.messageId),
        contentItemIdentity: message.messageId,
        exposureStage: "internal_inspection",
        visibleText: message.content,
      },
    ];
  }
  if (
    reference.kind !== "document" ||
    typeof reference.documentId !== "string" ||
    reference.documentId.length === 0 ||
    typeof reference.documentVersionId !== "string" ||
    reference.documentVersionId.length === 0
  ) {
    throw sourceExposureFailure("inspect_internal document result lacks its tool reference");
  }
  const namespace = documentNamespaceFromValue(
    reference.source,
    reference.documentId,
    "inspect_internal document reference",
  );
  const ranges = canonicalInspectionRanges(result.ranges);
  const logicalSourceIdentity = namespacedDocumentEvidenceIdentity(namespace, reference.documentId);
  return [
    {
      sourceKind: "document",
      logicalSourceIdentity,
      contentItemIdentity: `${logicalSourceIdentity}:${reference.documentVersionId}:${sha256Base64Url(JSON.stringify(ranges))}`,
      exposureStage: "internal_inspection",
      visibleText: result.text as string,
    },
  ];
};

const expectedCandidateInspectionExposures = (
  result: JsonRecord,
  toolCall: ProviderToolCall,
): readonly ExpectedVisibleSourceExposure[] => {
  const candidateId = toolCall.arguments.id;
  if (typeof candidateId !== "string") {
    if (typeof result.text !== "string") return [];
    throw sourceExposureFailure("inspect_candidate lacks its candidate identity");
  }
  if (candidateId.startsWith("conversation_entry:")) {
    if (!Object.hasOwn(result, "conversationEntry")) {
      if (Object.hasOwn(result, "text") || (result.found === true && result.complete === true)) {
        throw sourceExposureFailure(
          "inspect_candidate conversation result must expose one structured entry body",
        );
      }
      return [];
    }
    if (Object.hasOwn(result, "text") || result.found !== true || result.complete !== true) {
      throw sourceExposureFailure(
        "inspect_candidate conversation result must expose one structured entry body",
      );
    }
    const allowedResultKeys = new Set([
      "found",
      "complete",
      "conversationEntry",
      SOURCE_EXPOSURE_FIELD,
    ]);
    if (Object.keys(result).some((key) => !allowedResultKeys.has(key))) {
      throw sourceExposureFailure(
        "inspect_candidate conversation result has duplicate or unknown fields",
      );
    }
    const entry = result.conversationEntry;
    if (!isJsonRecord(entry) || typeof entry.turnId !== "string" || entry.turnId.length === 0) {
      throw sourceExposureFailure("inspect_candidate conversation result lacks its exact entry");
    }
    const entryKeys = Object.keys(entry).sort();
    const completeKeys = [
      "assistantContent",
      "assistantMessageId",
      "turnId",
      "userContent",
      "userMessageId",
    ];
    const failedKeys = ["errorCode", "retryable", "turnId", "userContent", "userMessageId"];
    const isCompleteEntry = entryKeys.join("\u0000") === completeKeys.join("\u0000");
    const keysMatch = isCompleteEntry || entryKeys.join("\u0000") === failedKeys.join("\u0000");
    if (!keysMatch || entry.turnId !== candidateId.slice("conversation_entry:".length)) {
      throw sourceExposureFailure(
        "inspect_candidate conversation entry differs from its candidate",
      );
    }
    if (
      typeof entry.userMessageId !== "string" ||
      entry.userMessageId.length === 0 ||
      typeof entry.userContent !== "string" ||
      (isCompleteEntry &&
        (typeof entry.assistantMessageId !== "string" ||
          entry.assistantMessageId.length === 0 ||
          typeof entry.assistantContent !== "string")) ||
      (!isCompleteEntry &&
        (typeof entry.errorCode !== "string" ||
          entry.errorCode.length === 0 ||
          typeof entry.retryable !== "boolean"))
    ) {
      throw sourceExposureFailure("inspect_candidate conversation entry is not canonical");
    }
    const messages = [
      { messageId: entry.userMessageId, content: entry.userContent },
      ...(isCompleteEntry
        ? [
            {
              messageId: entry.assistantMessageId as string,
              content: entry.assistantContent as string,
            },
          ]
        : []),
    ];
    return messages.map(({ messageId, content }) => ({
      sourceKind: "chat_message" as const,
      logicalSourceIdentity: chatMessageEvidenceIdentity(messageId),
      contentItemIdentity: messageId,
      exposureStage: "provider_input",
      visibleText: content,
    }));
  }
  if (typeof result.text !== "string") return [];
  if (
    result.found !== true ||
    result.complete !== true ||
    typeof toolCall.arguments.id !== "string"
  ) {
    throw sourceExposureFailure("inspect_candidate visible body is not a complete found result");
  }
  let sourceKind: ProviderVisibleSourceExposureMarker["sourceKind"];
  let contentItemIdentity: string | undefined;
  if (candidateId.startsWith("document:")) {
    sourceKind = "document";
    if (typeof result.documentId !== "string" || result.documentId.length === 0) {
      throw sourceExposureFailure("inspect_candidate document result lacks its exact document");
    }
    const namespace = documentNamespaceFromValue(
      result.source,
      result.documentId,
      "inspect_candidate document result",
    );
    const expectedCandidateId = namespacedDocumentEvidenceIdentity(namespace, result.documentId);
    if (candidateId !== expectedCandidateId) {
      throw sourceExposureFailure(
        "inspect_candidate document result provenance differs from its namespaced candidate",
      );
    }
    if (typeof result.documentVersionId !== "string" || result.documentVersionId.length === 0) {
      throw sourceExposureFailure("inspect_candidate document result lacks its exact version");
    }
    const ranges = isJsonRecord(toolCall.arguments.range)
      ? canonicalInspectionRanges([toolCall.arguments.range])
      : canonicalInspectionRanges(result.ranges);
    contentItemIdentity = `${expectedCandidateId}:${result.documentVersionId}:${sha256Base64Url(JSON.stringify(ranges))}`;
  } else if (candidateId.startsWith("chat_message:")) {
    sourceKind = "chat_message";
    contentItemIdentity = candidateId.slice("chat_message:".length);
  } else if (candidateId.startsWith("memory:")) {
    sourceKind = "memory";
    const memoryId = candidateId.slice("memory:".length);
    if (typeof result.memoryId !== "string" || result.memoryId !== memoryId) {
      throw sourceExposureFailure("inspect_candidate memory result differs from its candidate");
    }
    if (typeof result.memoryRevisionId !== "string" || result.memoryRevisionId.length === 0) {
      throw sourceExposureFailure("inspect_candidate memory result lacks its exact revision");
    }
    contentItemIdentity = result.memoryRevisionId;
  } else if (candidateId.startsWith("web:")) {
    sourceKind = "web";
    contentItemIdentity = candidateId.slice("web:".length);
  } else {
    throw sourceExposureFailure("inspect_candidate has an unknown candidate identity");
  }
  return [
    {
      sourceKind,
      logicalSourceIdentity: candidateId,
      ...(contentItemIdentity === undefined ? {} : { contentItemIdentity }),
      exposureStage: "context_candidate_inspection",
      visibleText: result.text,
    },
  ];
};

const expectedCandidateSearchExposures = (
  result: JsonRecord,
  toolCall: ProviderToolCall,
): readonly ExpectedVisibleSourceExposure[] => {
  const candidateId = toolCall.arguments.id;
  const previews = result.matchPreviews;
  if (!Array.isArray(previews)) {
    throw sourceExposureFailure("search_within_candidate result lacks canonical match previews");
  }
  if (typeof candidateId !== "string" || !candidateId.startsWith("document:")) {
    if (previews.length > 0) {
      throw sourceExposureFailure(
        "search_within_candidate preview lacks its document candidate identity",
      );
    }
    return [];
  }
  if (
    result.found !== true ||
    typeof result.documentVersionId !== "string" ||
    result.documentVersionId.length === 0
  ) {
    if (previews.length > 0) {
      throw sourceExposureFailure(
        "search_within_candidate preview lacks its immutable document version",
      );
    }
    return [];
  }
  return previews.map((preview) => {
    if (!isJsonRecord(preview) || typeof preview.text !== "string") {
      throw sourceExposureFailure("search_within_candidate preview is not canonical");
    }
    const ranges = canonicalInspectionRanges([preview.range]);
    return {
      sourceKind: "document" as const,
      logicalSourceIdentity: candidateId,
      contentItemIdentity: `${candidateId}:${result.documentVersionId as string}:${sha256Base64Url(JSON.stringify(ranges))}`,
      exposureStage: "context_candidate_inspection",
      visibleText: preview.text,
    };
  });
};

const expectedSourceExposures = (
  toolName: string,
  result: JsonRecord,
  toolCall: ProviderToolCall | undefined,
): readonly ExpectedVisibleSourceExposure[] | undefined => {
  if (
    toolName !== "search_internal" &&
    toolName !== "inspect_internal" &&
    toolName !== "inspect_candidate" &&
    toolName !== "search_within_candidate"
  ) {
    return undefined;
  }
  if (toolCall === undefined || toolCall.name !== toolName) {
    throw sourceExposureFailure(`${toolName} result lacks its exact assistant tool call`);
  }
  if (toolName === "search_internal") return expectedInternalSearchExposures(result);
  if (toolName === "inspect_internal") {
    return expectedInternalInspectionExposures(result, toolCall);
  }
  return toolName === "inspect_candidate"
    ? expectedCandidateInspectionExposures(result, toolCall)
    : expectedCandidateSearchExposures(result, toolCall);
};

const assertExactSourceExposureMarker = (
  marker: ProviderVisibleSourceExposureMarker,
  expected: ExpectedVisibleSourceExposure,
  countTextTokens: (text: string) => number,
): void => {
  const visibleTokenCount = countTextTokens(expected.visibleText);
  if (!Number.isSafeInteger(visibleTokenCount) || visibleTokenCount < 0) {
    throw sourceExposureFailure("tokenizer returned a non-canonical visible count");
  }
  const identityMatches =
    expected.contentItemIdentity === undefined ||
    marker.contentItemIdentity === expected.contentItemIdentity;
  if (
    marker.sourceKind !== expected.sourceKind ||
    marker.logicalSourceIdentity !== expected.logicalSourceIdentity ||
    marker.exposureStage !== expected.exposureStage ||
    marker.visibleTokenCount !== visibleTokenCount ||
    !identityMatches
  ) {
    throw sourceExposureFailure("marker differs from its exact visible tool-result body");
  }
};

/**
 * Reads markers only from the reserved top-level inventory, then independently
 * recounts the exact code-owned sibling text field. Source text is never
 * scanned for marker-shaped content, so an untrusted body cannot forge proof.
 */
export const providerRequestSourceExposureProofs = (
  request: ProviderRequest,
  countTextTokens: (text: string) => number,
): readonly string[] => {
  const proofs = new Set<string>();
  const toolCalls = new Map<string, ProviderToolCall>();
  for (const message of normalizeProviderRequest(request).messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) toolCalls.set(call.id, call);
      continue;
    }
    if (message.role !== "tool") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.content) as unknown;
    } catch {
      if (
        message.name === "search_internal" ||
        message.name === "inspect_internal" ||
        message.name === "inspect_candidate" ||
        message.name === "search_within_candidate"
      ) {
        throw sourceExposureFailure(`${message.name} result is not JSON`);
      }
      continue;
    }
    if (!isJsonRecord(parsed)) {
      if (
        message.name === "search_internal" ||
        message.name === "inspect_internal" ||
        message.name === "inspect_candidate" ||
        message.name === "search_within_candidate"
      ) {
        throw sourceExposureFailure(`${message.name} result is not an object`);
      }
      continue;
    }
    const expected = expectedSourceExposures(
      message.name,
      parsed,
      toolCalls.get(message.toolCallId),
    );
    if (expected === undefined) {
      if (Object.hasOwn(parsed, SOURCE_EXPOSURE_FIELD)) {
        throw sourceExposureFailure("reserved marker inventory appeared on an unrelated tool");
      }
      continue;
    }
    const markers = markersFromResult(parsed);
    if (markers.length !== expected.length) {
      throw sourceExposureFailure("marker cardinality differs from visible source bodies");
    }
    for (const [index, marker] of markers.entries()) {
      assertExactSourceExposureMarker(marker, expected[index]!, countTextTokens);
      proofs.add(providerVisibleSourceExposureProofSha256Hex(marker));
    }
  }
  return [...proofs].sort();
};

export interface GlmTemplateMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly tool_calls?: ReadonlyArray<{
    readonly id: string;
    readonly type: "function";
    readonly function: {
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    };
  }>;
}

export interface GlmTemplateTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly strict: false;
  };
}

const responseSchemaInstruction = (schema: Readonly<Record<string, unknown>>): string =>
  `Return JSON matching this exact response schema:\n${stableJson(schema)}`;

/**
 * Canonical provider transport shape shared by the exact counter and Pi.
 * System messages are hoisted and joined because Pi exposes one systemPrompt;
 * response schemas become that same transmitted prompt content. Recursive JSON
 * key order is fixed before either token rendering or HTTP serialization.
 */
export const normalizeProviderRequest = (request: ProviderRequest): ProviderRequest => {
  const systemParts = request.messages.flatMap((message) =>
    message.role === "system" ? [message.content] : [],
  );
  if (request.responseSchema !== undefined) {
    systemParts.push(responseSchemaInstruction(request.responseSchema));
  }

  const messages: ProviderMessage[] = [
    ...(systemParts.length === 0
      ? []
      : [{ role: "system" as const, content: systemParts.join("\n\n") }]),
    ...request.messages.flatMap((message): ProviderMessage[] => {
      if (message.role === "system") return [];
      if (message.role !== "assistant" || message.toolCalls === undefined) return [message];
      return [
        {
          ...message,
          toolCalls: message.toolCalls.map((call) => ({
            ...call,
            arguments: stableJsonValue(call.arguments) as Readonly<Record<string, unknown>>,
          })),
        },
      ];
    }),
  ];
  const tools = request.tools?.map((tool) => ({
    ...tool,
    parameters: stableJsonValue(tool.parameters) as Readonly<Record<string, unknown>>,
    // Pi serializes this inside each OpenAI `function` object. Retaining the
    // derived constant in the normalized Brief request also binds request
    // digests to that exact transport posture.
    strict: false as const,
  }));

  return {
    requestClass: request.requestClass,
    model: request.model,
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
    requestedOutputTokens: request.requestedOutputTokens,
    reasoning: request.reasoning,
  };
};

/**
 * Produces the exact OpenAI chat-completions objects used by both the pinned
 * official GLM template and the Pi boundary. Stable recursive key ordering is
 * intentional: retries must render byte-identical tool inventories and calls.
 */
export const toGlmTemplateInput = (
  request: ProviderRequest,
): {
  readonly messages: readonly GlmTemplateMessage[];
  readonly tools: readonly GlmTemplateTool[];
} => {
  const normalized = normalizeProviderRequest(request);
  const messages: GlmTemplateMessage[] = normalized.messages.map((message) => {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls === undefined || message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: {
                  name: call.name,
                  arguments: stableJsonValue(call.arguments) as Readonly<Record<string, unknown>>,
                },
              })),
            }),
      };
    }
    if (message.role === "tool") {
      // The official template renders the content only, exactly like the
      // provider; tool-call identity remains part of the provider message but
      // is not a prompt token.
      return { role: "tool", content: message.content };
    }
    return { role: message.role, content: message.content };
  });

  const tools = (normalized.tools ?? []).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: stableJsonValue(tool.parameters) as Readonly<Record<string, unknown>>,
      // Pi's pinned openai-completions adapter sends this field whenever the
      // provider supports strict mode. It is provider-visible template input,
      // even though Brief does not request strict schema enforcement.
      strict: tool.strict ?? false,
    },
  }));

  return { messages, tools };
};
