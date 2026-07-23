import { createHash } from "node:crypto";

import {
  canonicalizeWebUrl,
  chatMessageEvidenceIdentity,
  namespacedDocumentEvidenceIdentity,
  sha256Base64Url,
  sourceOrdinalFromKey,
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
  /** Code-owned evidence inventory. It is never serialized to the provider. */
  readonly sourceExposureProofs?: readonly SourceExposureProof[] | undefined;
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
  assertProviderRequestIsRedacted(request);
  return request;
};

export interface ProviderVisibleSourceExposureMarker {
  readonly sourceKind: "document" | "chat_message" | "memory" | "web";
  readonly logicalSourceIdentity: string;
  readonly contentItemIdentity: string;
  readonly exposureStage: string;
  readonly visibleTokenCount: number;
}

/**
 * Code-owned proof inventory. The visible text never enters a provider
 * message; it lets the exact gate recount the sidecar with the pinned
 * tokenizer before it stores the proof set.
 */
export type CodeOwnedSourceExposureProof = ProviderVisibleSourceExposureMarker & {
  readonly visibleText: string;
  /** Optional caller-supplied binding; the gate re-derives and checks it. */
  readonly messageIndex?: number | undefined;
  readonly serializedField?: string | undefined;
  readonly sourceOrdinal?: number | undefined;
  readonly orderedSourceDescriptor?: string | undefined;
  readonly publicDocumentId?: string | undefined;
};

export type SourceExposureProof =
  | ProviderVisibleSourceExposureMarker
  | CodeOwnedSourceExposureProof;

/** Internal binding material for one exact normalized source field. */
export interface ProviderVisibleSourceExposureProofBinding {
  readonly messageIndex: number;
  readonly sourceOrdinal: number;
  readonly serializedField: string;
  readonly characterOffset?: number | undefined;
  readonly orderedSourceDescriptor: string;
  readonly publicDocumentId?: string | undefined;
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
    .update(
      stableJson(
        (() => {
          const { sourceExposureProofs: _sourceExposureProofs, ...providerRequest } =
            normalizeProviderRequest(request);
          return providerRequest;
        })(),
      ),
    )
    .digest("hex");

export const providerVisibleSourceExposureProofSha256Hex = (
  marker: ProviderVisibleSourceExposureMarker,
  binding?: ProviderVisibleSourceExposureProofBinding,
): string => {
  // Array.prototype.map passes the element index as the second argument.
  // Keep the one-argument helper compatible with existing attestation callers.
  const exactBinding =
    binding !== null && typeof binding === "object" && !Array.isArray(binding)
      ? binding
      : undefined;
  return createHash("sha256")
    .update(
      stableJson({
        sourceKind: marker.sourceKind,
        logicalSourceIdentity: marker.logicalSourceIdentity,
        contentItemIdentity: marker.contentItemIdentity,
        exposureStage: marker.exposureStage,
        visibleTokenCount: marker.visibleTokenCount,
        ...(exactBinding === undefined ? {} : { binding: exactBinding }),
      }),
    )
    .digest("hex");
};

const providerSourceExposureBindingRegistry = new Map<
  string,
  Map<string, ProviderVisibleSourceExposureProofBinding[]>
>();

const providerSourceExposureMarkerKey = (marker: ProviderVisibleSourceExposureMarker): string =>
  stableJson({
    sourceKind: marker.sourceKind,
    logicalSourceIdentity: marker.logicalSourceIdentity,
    contentItemIdentity: marker.contentItemIdentity,
    exposureStage: marker.exposureStage,
    visibleTokenCount: marker.visibleTokenCount,
  });

const rememberProviderSourceExposureBinding = (
  requestSha256Hex: string,
  marker: ProviderVisibleSourceExposureMarker,
  binding: ProviderVisibleSourceExposureProofBinding,
): void => {
  const requestEntries =
    providerSourceExposureBindingRegistry.get(requestSha256Hex) ??
    new Map<string, ProviderVisibleSourceExposureProofBinding[]>();
  const markerEntries = requestEntries.get(providerSourceExposureMarkerKey(marker)) ?? [];
  if (!markerEntries.some((candidate) => stableJson(candidate) === stableJson(binding))) {
    markerEntries.push(binding);
  }
  requestEntries.set(providerSourceExposureMarkerKey(marker), markerEntries);
  providerSourceExposureBindingRegistry.set(requestSha256Hex, requestEntries);
};

export const providerRequestSourceExposureProofBindingCandidates = (
  requestSha256Hex: string,
  marker: ProviderVisibleSourceExposureMarker,
): readonly ProviderVisibleSourceExposureProofBinding[] =>
  providerSourceExposureBindingRegistry
    .get(requestSha256Hex)
    ?.get(providerSourceExposureMarkerKey(marker)) ?? [];

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

const isCodeOwnedSourceExposureProof = (value: unknown): value is CodeOwnedSourceExposureProof => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  const marker = {
    sourceKind: proof.sourceKind,
    logicalSourceIdentity: proof.logicalSourceIdentity,
    contentItemIdentity: proof.contentItemIdentity,
    exposureStage: proof.exposureStage,
    visibleTokenCount: proof.visibleTokenCount,
  };
  const allowedKeys = new Set([
    "sourceKind",
    "logicalSourceIdentity",
    "contentItemIdentity",
    "exposureStage",
    "visibleTokenCount",
    "visibleText",
    "messageIndex",
    "serializedField",
    "sourceOrdinal",
    "orderedSourceDescriptor",
    "publicDocumentId",
  ]);
  return (
    isProviderVisibleSourceExposureMarker(marker) &&
    Object.keys(proof).every((key) => allowedKeys.has(key)) &&
    typeof proof.visibleText === "string" &&
    proof.visibleText.length > 0
  );
};

type JsonRecord = Readonly<Record<string, unknown>>;

interface ExpectedVisibleSourceExposure {
  readonly sourceKind: ProviderVisibleSourceExposureMarker["sourceKind"];
  readonly logicalSourceIdentity?: string | undefined;
  readonly exposureStage: string;
  readonly visibleText: string;
  readonly contentItemIdentity?: string | undefined;
  /** The only provider-visible identity for a document search item. */
  readonly documentId?: string | undefined;
  /** Range identity remains internal when version metadata is redacted. */
  readonly documentRangeHash?: string | undefined;
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

interface CanonicalInspectionRange {
  readonly charStart: number;
  readonly charEnd: number;
}

const SOURCE_EXPOSURE_FIELD = "__briefSourceExposures";

const isJsonRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sourceExposureFailure = (message: string): Error =>
  new Error(`invalid provider-visible source exposure: ${message}`);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

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
    const hasDocumentIdentity = typeof value.documentId === "string" && value.documentId.length > 0;
    const hasMessageIdentity = typeof value.messageId === "string";
    if (hasDocumentIdentity === hasMessageIdentity) {
      throw sourceExposureFailure("search_internal item must have one canonical source identity");
    }
    if (hasDocumentIdentity) {
      if (
        value.kind !== "document" ||
        Object.keys(value).some(
          (key) => !["kind", "documentId", "snippet", "title", "publishedAt"].includes(key),
        )
      ) {
        throw sourceExposureFailure(
          "search_internal document item contains a legacy or unchecked identity field",
        );
      }
      return {
        sourceKind: "document" as const,
        exposureStage: "internal_search_preview",
        visibleText: value.snippet,
        documentId: value.documentId as string,
      };
    }
    return {
      sourceKind: "chat_message" as const,
      logicalSourceIdentity: chatMessageEvidenceIdentity(value.messageId as string),
      contentItemIdentity: value.messageId as string,
      exposureStage: "internal_inspection",
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
    reference.documentId.length === 0
  ) {
    throw sourceExposureFailure("inspect_internal document result lacks its tool reference");
  }
  if (
    Object.keys(reference).some((key) => !["kind", "documentId", "purpose", "range"].includes(key))
  ) {
    throw sourceExposureFailure(
      "inspect_internal document reference contains hidden immutable identity",
    );
  }
  const ranges = canonicalInspectionRanges(result.ranges);
  if (
    Object.hasOwn(reference, "range") &&
    stableJson(canonicalInspectionRanges([reference.range])) !== stableJson(ranges)
  ) {
    throw sourceExposureFailure("inspect_internal document range differs from its tool reference");
  }
  if (
    Object.hasOwn(result, "documentId") &&
    (typeof result.documentId !== "string" || result.documentId !== reference.documentId)
  ) {
    throw sourceExposureFailure(
      "inspect_internal visible document ID differs from its tool reference",
    );
  }
  return [
    {
      sourceKind: "document",
      // Live inspect_internal references intentionally contain only the public
      // document ID and range. The immutable namespace/version/range identity
      // stays in the code-owned sidecar and is checked against this location.
      exposureStage: "internal_inspection",
      visibleText: result.text as string,
      documentId: reference.documentId,
      documentRangeHash: sha256Base64Url(JSON.stringify(ranges)),
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
  let documentRangeHash: string | undefined;
  let documentId: string | undefined;
  if (candidateId.startsWith("document:")) {
    sourceKind = "document";
    documentId =
      typeof result.documentId === "string" && result.documentId.length > 0
        ? result.documentId
        : documentIdFromLogicalIdentity(candidateId);
    if (documentId === undefined) {
      throw sourceExposureFailure("inspect_candidate document result lacks its exact document");
    }
    if (
      typeof result.versionId !== "string" ||
      result.versionId.length === 0 ||
      !Object.hasOwn(result, "source")
    ) {
      throw sourceExposureFailure("inspect_candidate document result lacks its immutable identity");
    }
    const namespace = documentNamespaceFromValue(
      result.source,
      documentId,
      "inspect_candidate document result",
    );
    const expectedCandidateId = namespacedDocumentEvidenceIdentity(namespace, documentId);
    if (candidateId !== expectedCandidateId) {
      throw sourceExposureFailure(
        "inspect_candidate document result provenance differs from its namespaced candidate",
      );
    }
    const ranges = isJsonRecord(toolCall.arguments.range)
      ? canonicalInspectionRanges([toolCall.arguments.range])
      : canonicalInspectionRanges(result.ranges);
    const rangeHash = sha256Base64Url(JSON.stringify(ranges));
    contentItemIdentity = `${candidateId}:${result.versionId}:${rangeHash}`;
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
      ...(sourceKind === "document" ? { documentId: documentId as string } : {}),
      ...(documentRangeHash === undefined ? {} : { documentRangeHash }),
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
  if (result.found !== true) {
    if (previews.length > 0) {
      throw sourceExposureFailure(
        "search_within_candidate preview lacks its complete document result",
      );
    }
    return [];
  }
  if (typeof result.versionId !== "string" || result.versionId.length === 0) {
    throw sourceExposureFailure("search_within_candidate result lacks its immutable version");
  }
  return previews.map((preview) => {
    if (!isJsonRecord(preview) || typeof preview.text !== "string") {
      throw sourceExposureFailure("search_within_candidate preview is not canonical");
    }
    const ranges = canonicalInspectionRanges([preview.range]);
    const rangeHash = sha256Base64Url(JSON.stringify(ranges));
    return {
      sourceKind: "document" as const,
      logicalSourceIdentity: candidateId,
      contentItemIdentity: `${candidateId}:${result.versionId}:${rangeHash}`,
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
    toolName !== "search_evidence" &&
    toolName !== "inspect_evidence" &&
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
  if (toolName === "search_evidence") {
    if (!Array.isArray(result.matches)) {
      throw sourceExposureFailure("search_evidence result must contain a matches array");
    }
    return result.matches.map((value) => {
      if (
        !isJsonRecord(value) ||
        typeof value.kind !== "string" ||
        !["document", "chat_message", "memory", "web"].includes(value.kind) ||
        typeof value.text !== "string"
      ) {
        throw sourceExposureFailure("search_evidence match is not canonical");
      }
      return {
        sourceKind: value.kind as ProviderVisibleSourceExposureMarker["sourceKind"],
        exposureStage: "evaluation_general_planner_search",
        visibleText: value.text,
      };
    });
  }
  if (toolName === "inspect_evidence") {
    if (result.found !== true || result.complete !== true || typeof result.text !== "string") {
      return [];
    }
    if (
      result.kind !== "document" &&
      result.kind !== "chat_message" &&
      result.kind !== "memory" &&
      result.kind !== "web"
    ) {
      throw sourceExposureFailure("inspect_evidence result has an invalid source kind");
    }
    return [
      {
        sourceKind: result.kind,
        exposureStage: "evaluation_general_planner_inspect",
        visibleText: result.text,
      },
    ];
  }
  if (toolName === "search_internal") return expectedInternalSearchExposures(result);
  if (toolName === "inspect_internal") {
    return expectedInternalInspectionExposures(result, toolCall);
  }
  return toolName === "inspect_candidate"
    ? expectedCandidateInspectionExposures(result, toolCall)
    : expectedCandidateSearchExposures(result, toolCall);
};

const documentIdFromLogicalIdentity = (logicalSourceIdentity: string): string | undefined => {
  const prefix = "document:namespace:";
  if (!logicalSourceIdentity.startsWith(prefix)) return undefined;
  const separator = logicalSourceIdentity.indexOf(":", prefix.length);
  if (separator < 0) return undefined;
  const kind = logicalSourceIdentity.slice(prefix.length, separator);
  if (kind !== "public" && kind !== "publisher") return undefined;
  try {
    const value = JSON.parse(logicalSourceIdentity.slice(separator + 1)) as unknown;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
    const documentId = value.at(-1);
    return typeof documentId === "string" && documentId.length > 0 ? documentId : undefined;
  } catch {
    return undefined;
  }
};

const isCanonicalDocumentLogicalIdentity = (logicalSourceIdentity: string): boolean => {
  const prefix = "document:namespace:";
  if (!logicalSourceIdentity.startsWith(prefix)) return false;
  const separator = logicalSourceIdentity.indexOf(":", prefix.length);
  if (separator < 0) return false;
  const kind = logicalSourceIdentity.slice(prefix.length, separator);
  try {
    const value = JSON.parse(logicalSourceIdentity.slice(separator + 1)) as unknown;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return false;
    if (kind === "public") {
      return value.length === 2 && hasExactDocumentSourceId("public", value[0]);
    }
    return (
      kind === "publisher" &&
      value.length === 4 &&
      hasExactDocumentSourceId("publisher", value[0]) &&
      value[1]!.length > 0 &&
      value[2]!.length > 0 &&
      value[2] === value[3]
    );
  } catch {
    return false;
  }
};

const documentContentIdentityMatchesSnippet = (
  marker: ProviderVisibleSourceExposureMarker,
  snippet: string,
): boolean => {
  const expectedHash = sha256Base64Url(snippet);
  const prefix = `${marker.logicalSourceIdentity}:`;
  const suffix = marker.contentItemIdentity.startsWith(prefix)
    ? marker.contentItemIdentity.slice(prefix.length).split(":")
    : [];
  return (
    marker.sourceKind === "document" &&
    suffix.length === 2 &&
    suffix[0]!.length > 0 &&
    suffix[1] === expectedHash
  );
};

const documentContentIdentityMatchesRange = (
  marker: ProviderVisibleSourceExposureMarker,
  rangeHash: string,
): boolean =>
  (() => {
    const prefix = `${marker.logicalSourceIdentity}:`;
    const suffix = marker.contentItemIdentity.startsWith(prefix)
      ? marker.contentItemIdentity.slice(prefix.length).split(":")
      : [];
    return (
      marker.sourceKind === "document" &&
      suffix.length === 2 &&
      suffix[0]!.length > 0 &&
      suffix[1] === rangeHash
    );
  })();

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
    expected.documentId !== undefined
      ? isCanonicalDocumentLogicalIdentity(marker.logicalSourceIdentity) &&
        documentIdFromLogicalIdentity(marker.logicalSourceIdentity) === expected.documentId &&
        (expected.contentItemIdentity === undefined
          ? expected.documentRangeHash === undefined
            ? documentContentIdentityMatchesSnippet(marker, expected.visibleText)
            : documentContentIdentityMatchesRange(marker, expected.documentRangeHash)
          : marker.contentItemIdentity === expected.contentItemIdentity)
      : expected.contentItemIdentity === undefined ||
        marker.contentItemIdentity === expected.contentItemIdentity;
  const rangeIdentityMatches =
    expected.documentRangeHash === undefined ||
    documentContentIdentityMatchesRange(marker, expected.documentRangeHash);
  if (
    marker.sourceKind !== expected.sourceKind ||
    (expected.logicalSourceIdentity !== undefined &&
      marker.logicalSourceIdentity !== expected.logicalSourceIdentity) ||
    marker.exposureStage !== expected.exposureStage ||
    marker.visibleTokenCount !== visibleTokenCount ||
    !identityMatches ||
    !rangeIdentityMatches
  ) {
    throw sourceExposureFailure("marker differs from its exact visible tool-result body");
  }
};

const expectedStrippedToolResultExposures = (
  toolName: string,
  result: JsonRecord,
  toolCall: ProviderToolCall,
): readonly ExpectedVisibleSourceExposure[] | undefined => {
  if (toolName === "search_internal") {
    if (!Array.isArray(result.items)) {
      throw sourceExposureFailure("search_internal result must contain an items array");
    }
    return result.items.map((value) => {
      if (!isJsonRecord(value) || typeof value.snippet !== "string") {
        throw sourceExposureFailure("search_internal item must contain an exact snippet");
      }
      const hasDocumentIdentity =
        typeof value.documentId === "string" && value.documentId.length > 0;
      const hasMessageIdentity = typeof value.messageId === "string";
      if (hasDocumentIdentity === hasMessageIdentity) {
        throw sourceExposureFailure("search_internal item must have one canonical source identity");
      }
      if (hasDocumentIdentity) {
        if (
          value.kind !== "document" ||
          Object.keys(value).some(
            (key) => !["kind", "documentId", "snippet", "title", "publishedAt"].includes(key),
          )
        ) {
          throw sourceExposureFailure(
            "search_internal document item contains a legacy or unchecked identity field",
          );
        }
        return {
          sourceKind: "document",
          exposureStage: "internal_search_preview",
          visibleText: value.snippet,
          documentId: value.documentId as string,
        };
      }
      return {
        sourceKind: "chat_message",
        logicalSourceIdentity: chatMessageEvidenceIdentity(value.messageId as string),
        contentItemIdentity: value.messageId as string,
        exposureStage: "internal_inspection",
        visibleText: value.snippet,
      };
    });
  }

  if (toolName === "search_memories") {
    if (!Array.isArray(result.items)) {
      throw sourceExposureFailure("search_memories result must contain an items array");
    }
    return result.items.map((value) => {
      if (
        !isJsonRecord(value) ||
        typeof value.memoryId !== "string" ||
        typeof value.content !== "string"
      ) {
        throw sourceExposureFailure("search_memories item is not canonical");
      }
      return {
        sourceKind: "memory",
        logicalSourceIdentity: `memory:${value.memoryId}`,
        ...(typeof value.memoryRevisionId === "string" && value.memoryRevisionId.length > 0
          ? { contentItemIdentity: value.memoryRevisionId }
          : (() => {
              throw sourceExposureFailure("memory tool result lacks its exact revision identity");
            })()),
        exposureStage: "memory_tool_result",
        visibleText: value.content,
      };
    });
  }

  if (toolName === "inspect_memory") {
    if (result.found !== true || result.complete !== true || !isJsonRecord(result.memory))
      return [];
    const memory = result.memory;
    if (typeof memory.memoryId !== "string" || typeof memory.content !== "string") {
      throw sourceExposureFailure("inspect_memory result is not canonical");
    }
    return [
      {
        sourceKind: "memory",
        logicalSourceIdentity: `memory:${memory.memoryId}`,
        ...(typeof memory.memoryRevisionId === "string" && memory.memoryRevisionId.length > 0
          ? { contentItemIdentity: memory.memoryRevisionId }
          : (() => {
              throw sourceExposureFailure("memory tool result lacks its exact revision identity");
            })()),
        exposureStage: "memory_tool_result",
        visibleText: memory.content,
      },
    ];
  }

  if (toolName === "web_search") {
    if (!Array.isArray(result.results)) return [];
    return result.results.map((value) => {
      if (
        !isJsonRecord(value) ||
        typeof value.url !== "string" ||
        typeof value.snippet !== "string"
      ) {
        throw sourceExposureFailure("web_search result is not canonical");
      }
      const url = canonicalizeWebUrl(value.url);
      return {
        sourceKind: "web",
        logicalSourceIdentity: url,
        contentItemIdentity: `${url}:${sha256Base64Url(value.snippet)}`,
        exposureStage: "web_search_preview",
        visibleText: value.snippet,
      };
    });
  }

  if (toolName === "web_fetch") {
    if (typeof result.url !== "string" || typeof result.text !== "string") return [];
    const url = canonicalizeWebUrl(result.url);
    return [
      {
        sourceKind: "web",
        logicalSourceIdentity: url,
        contentItemIdentity: `${url}:${sha256Base64Url(result.text)}`,
        exposureStage: "web_fetch",
        visibleText: result.text,
      },
    ];
  }

  return expectedSourceExposures(toolName, result, toolCall);
};

interface SourceExposureLocation {
  readonly messageIndex: number;
  /** Global source order in the normalized request. */
  readonly sourceOrdinal: number;
  readonly serializedField: string;
  readonly characterOffset?: number | undefined;
}

interface LocatedSourceExposure {
  marker: ProviderVisibleSourceExposureMarker;
  readonly location: SourceExposureLocation;
  readonly expected?: ExpectedVisibleSourceExposure | undefined;
  readonly descriptor?: CodeOwnedSourceDescriptor | undefined;
}

const boundSourceExposureProofSha256Hex = (
  marker: ProviderVisibleSourceExposureMarker,
  location: SourceExposureLocation,
  expected: ExpectedVisibleSourceExposure | undefined,
): string =>
  providerVisibleSourceExposureProofSha256Hex(marker, {
    messageIndex: location.messageIndex,
    sourceOrdinal: location.sourceOrdinal,
    serializedField: location.serializedField,
    ...(location.characterOffset === undefined
      ? {}
      : { characterOffset: location.characterOffset }),
    orderedSourceDescriptor: stableJson({
      sourceOrdinal: location.sourceOrdinal,
      messageIndex: location.messageIndex,
      serializedField: location.serializedField,
      ...(location.characterOffset === undefined
        ? {}
        : { characterOffset: location.characterOffset }),
      sourceKind: marker.sourceKind,
      exposureStage: marker.exposureStage,
      logicalSourceIdentity: marker.logicalSourceIdentity,
      contentItemIdentity: marker.contentItemIdentity,
      visibleTokenCount: marker.visibleTokenCount,
      publicDocumentId:
        expected?.documentId ?? documentIdFromLogicalIdentity(marker.logicalSourceIdentity),
    }),
    ...((expected?.documentId ?? documentIdFromLogicalIdentity(marker.logicalSourceIdentity)) ===
    undefined
      ? {}
      : {
          publicDocumentId:
            expected?.documentId ?? documentIdFromLogicalIdentity(marker.logicalSourceIdentity),
        }),
  });

export interface ProviderRequestSourceExposureProofBinding {
  readonly providerSerializationProofSha256Hex: string;
  readonly marker: ProviderVisibleSourceExposureMarker;
  readonly binding: ProviderVisibleSourceExposureProofBinding;
}

const sourceToolName = (name: string): boolean =>
  name === "search_internal" ||
  name === "inspect_internal" ||
  name === "inspect_candidate" ||
  name === "search_within_candidate" ||
  name === "search_memories" ||
  name === "inspect_memory" ||
  name === "web_search" ||
  name === "web_fetch";

const containsReservedExposureField = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsReservedExposureField);
  if (!isJsonRecord(value)) return false;
  return Object.entries(value).some(
    ([key, nested]) => key === SOURCE_EXPOSURE_FIELD || containsReservedExposureField(nested),
  );
};

const assertProviderRequestIsRedacted = (request: ProviderRequest): void => {
  for (const message of request.messages) {
    if (message.role !== "tool") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.content) as unknown;
    } catch {
      continue;
    }
    if (containsReservedExposureField(parsed)) {
      throw sourceExposureFailure(
        `${SOURCE_EXPOSURE_FIELD} is code-owned and must not cross the provider boundary`,
      );
    }
  }
};

const sourceResultField = (
  toolName: string,
  index: number,
  expected: ExpectedVisibleSourceExposure,
): string => {
  if (toolName === "search_internal" || toolName === "search_memories") {
    return `items[${index}].${toolName === "search_memories" ? "content" : "snippet"}`;
  }
  if (toolName === "search_within_candidate") return `matchPreviews[${index}].text`;
  if (toolName === "web_search") return `results[${index}].snippet`;
  if (toolName === "inspect_memory") return "memory.content";
  if (toolName === "web_fetch") return "text";
  if (toolName === "inspect_internal") {
    return expected.sourceKind === "chat_message" ? "message.content" : "text";
  }
  if (toolName === "inspect_candidate" && expected.sourceKind === "chat_message") {
    return index === 0 ? "conversationEntry.userContent" : "conversationEntry.assistantContent";
  }
  return "text";
};

const sourceResultLocation = (
  messageIndex: number,
  toolName: string,
  index: number,
  expected: ExpectedVisibleSourceExposure,
): SourceExposureLocation => ({
  messageIndex,
  sourceOrdinal: -1,
  serializedField: `messages[${messageIndex}].content.${sourceResultField(toolName, index, expected)}`,
});

const pathText = (path: readonly (string | number)[]): string =>
  path.reduce<string>(
    (text, part) => (typeof part === "number" ? `${text}[${part}]` : `${text}.${part}`),
    "content",
  );

interface CodeOwnedSourceDescriptor {
  readonly sourceKind: ProviderVisibleSourceExposureMarker["sourceKind"];
  readonly exposureStage: string;
  readonly visibleText: string;
  readonly logicalSourceIdentity?: string | undefined;
  readonly contentItemIdentity?: string | undefined;
  readonly documentId?: string | undefined;
  readonly location: SourceExposureLocation;
}

const sourceKindFromSerializedKind = (
  value: string,
): ProviderVisibleSourceExposureMarker["sourceKind"] | undefined =>
  value === "document" || value === "chat_message" || value === "memory" || value === "web"
    ? value
    : undefined;

const answerSourceDescriptors = (
  messageIndex: number,
  evidence: string,
): readonly CodeOwnedSourceDescriptor[] => {
  const descriptors: CodeOwnedSourceDescriptor[] = [];
  let cursor = 0;
  let sourceIndex = 0;
  while (cursor < evidence.length) {
    if (sourceIndex > 0) {
      if (!evidence.startsWith("\n\n", cursor)) {
        throw sourceExposureFailure("answer evidence contains text outside exact source wrappers");
      }
      cursor += 2;
    }
    const header = /^<source key="([^"]+)" kind="([^"]+)"(?: label="(?:[^"\\]|\\.)*")?>\n/uy.exec(
      evidence.slice(cursor),
    );
    if (header === null) {
      throw sourceExposureFailure("answer evidence contains a malformed source wrapper");
    }
    const sourceKey = header[1];
    const sourceKind = sourceKindFromSerializedKind(header[2] ?? "");
    if (sourceKey === undefined || !/^k_cn_[A-Za-z0-9_-]{22}_[1-9][0-9]*$/u.test(sourceKey)) {
      throw sourceExposureFailure("answer evidence contains an invalid ordered source key");
    }
    // Citation ordinals remain stable across fanout filtering.  The provider
    // field order is bound by `sourceOrdinal` below, so a source key may have
    // a gap when earlier candidates were inaccessible or omitted.
    if (sourceOrdinalFromKey(sourceKey) < 1) {
      throw sourceExposureFailure("answer evidence source key has an invalid ordinal");
    }
    if (
      descriptors.some((descriptor) =>
        descriptor.location.serializedField.endsWith(`(${sourceKey})`),
      )
    ) {
      throw sourceExposureFailure("answer evidence repeats a source key");
    }
    if (sourceKind === undefined) {
      throw sourceExposureFailure("answer evidence contains an invalid source kind");
    }
    const bodyStart = cursor + header[0].length;
    const bodyEnd = evidence.indexOf("\n</source>", bodyStart);
    if (bodyEnd < bodyStart) {
      throw sourceExposureFailure("answer evidence contains an unterminated source wrapper");
    }
    const visibleText = evidence.slice(bodyStart, bodyEnd);
    if (visibleText.length === 0) {
      throw sourceExposureFailure("answer evidence contains an empty source wrapper");
    }
    descriptors.push({
      sourceKind,
      exposureStage: "answer_serialized",
      visibleText,
      location: {
        messageIndex,
        sourceOrdinal: -1,
        serializedField: `messages[${messageIndex}].content.evidence.source[${sourceIndex}](${sourceKey})`,
        characterOffset: bodyStart,
      },
    });
    cursor = bodyEnd + "\n</source>".length;
    sourceIndex += 1;
  }
  return descriptors;
};

const codeOwnedExposureDescriptors = (
  normalized: ProviderRequest,
): readonly CodeOwnedSourceDescriptor[] => {
  const candidates: CodeOwnedSourceDescriptor[] = [];
  normalized.messages.forEach((message, messageIndex) => {
    if (message.role !== "user") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.content) as unknown;
    } catch {
      return;
    }
    if (!isJsonRecord(parsed)) return;
    const addMessageField = (field: string, idField: string): void => {
      if (typeof parsed[field] !== "string") return;
      const identity = parsed[idField];
      candidates.push({
        sourceKind: "chat_message",
        exposureStage: "provider_input",
        visibleText: parsed[field],
        ...(typeof identity === "string" && identity.length > 0
          ? {
              logicalSourceIdentity: chatMessageEvidenceIdentity(identity),
              contentItemIdentity: identity,
            }
          : {}),
        location: {
          messageIndex,
          sourceOrdinal: -1,
          serializedField: `messages[${messageIndex}].content.${field}`,
        },
      });
    };
    const addConversationRecords = (value: unknown, path: readonly (string | number)[]): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => addConversationRecords(entry, [...path, index]));
        return;
      }
      if (!isJsonRecord(value)) return;
      for (const [idField, contentField] of [
        ["userMessageId", "userContent"],
        ["assistantMessageId", "assistantContent"],
      ] as const) {
        if (
          typeof value[idField] === "string" &&
          value[idField].length > 0 &&
          typeof value[contentField] === "string"
        ) {
          candidates.push({
            sourceKind: "chat_message",
            exposureStage: "provider_input",
            visibleText: value[contentField],
            logicalSourceIdentity: chatMessageEvidenceIdentity(value[idField]),
            contentItemIdentity: value[idField],
            location: {
              messageIndex,
              sourceOrdinal: -1,
              serializedField: `messages[${messageIndex}].${pathText([...path, contentField])}`,
            },
          });
        }
      }
    };
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "currentMessage") addMessageField(key, "currentMessageId");
      if (key === "currentUserMessage") addMessageField(key, "currentUserMessageId");
      if (key === "originalMessage") addMessageField(key, "originalMessageId");
      if (key === "entries" || key === "selectedConversation") {
        addConversationRecords(value, [key]);
      }
      if (key === "evidence" && typeof value === "string") {
        candidates.push(...answerSourceDescriptors(messageIndex, value));
      }
    }
  });
  return candidates;
};

const assertCodeOwnedMarkerShape = (proof: CodeOwnedSourceExposureProof): void => {
  if (
    (proof.messageIndex !== undefined &&
      (!Number.isSafeInteger(proof.messageIndex) || proof.messageIndex < 0)) ||
    (proof.sourceOrdinal !== undefined &&
      (!Number.isSafeInteger(proof.sourceOrdinal) || proof.sourceOrdinal < 0)) ||
    (proof.serializedField !== undefined && proof.serializedField.length === 0) ||
    (proof.orderedSourceDescriptor !== undefined && proof.orderedSourceDescriptor.length === 0) ||
    (proof.publicDocumentId !== undefined && proof.publicDocumentId.length === 0)
  ) {
    throw sourceExposureFailure("code-owned proof has an invalid request binding");
  }
  if (
    ![
      "provider_input",
      "answer_serialized",
      "internal_search_preview",
      "internal_inspection",
      "context_candidate_inspection",
      "memory_tool_result",
      "web_search_preview",
      "web_fetch",
    ].includes(proof.exposureStage)
  ) {
    throw sourceExposureFailure("code-owned proof has an invalid exposure stage");
  }
  if (proof.exposureStage === "provider_input" && proof.sourceKind !== "chat_message") {
    throw sourceExposureFailure("provider-input proof must identify a chat message");
  }
  if (
    proof.sourceKind === "chat_message" &&
    proof.logicalSourceIdentity !== chatMessageEvidenceIdentity(proof.contentItemIdentity)
  ) {
    throw sourceExposureFailure("code-owned chat proof identity is not canonical");
  }
  if (proof.sourceKind === "memory" && !proof.logicalSourceIdentity.startsWith("memory:")) {
    throw sourceExposureFailure("code-owned memory proof identity is not canonical");
  }
  if (
    proof.sourceKind === "memory" &&
    (!/^memory:[^:\s]+$/u.test(proof.logicalSourceIdentity) ||
      proof.contentItemIdentity.trim() === "" ||
      /\s/u.test(proof.contentItemIdentity))
  ) {
    throw sourceExposureFailure("code-owned memory proof identity is not canonical");
  }
  if (proof.sourceKind === "web") {
    const namespaced = proof.logicalSourceIdentity.startsWith("web:");
    const identity = namespaced
      ? proof.logicalSourceIdentity.slice("web:".length)
      : proof.logicalSourceIdentity;
    const separator = namespaced ? identity.lastIndexOf(":") : -1;
    const url = namespaced && separator > 0 ? identity.slice(0, separator) : identity;
    let canonicalUrl: string;
    try {
      canonicalUrl = canonicalizeWebUrl(url);
    } catch {
      throw sourceExposureFailure("code-owned web proof identity is not canonical");
    }
    const contentHash = proof.visibleText.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
    if (
      canonicalUrl !== url ||
      (namespaced && separator <= 0) ||
      proof.contentItemIdentity !== `${canonicalUrl}:${sha256Base64Url(contentHash)}` ||
      (namespaced && identity.slice(separator + 1) !== sha256Base64Url(contentHash))
    ) {
      throw sourceExposureFailure("code-owned web proof identity is not canonical");
    }
  }
  if (
    proof.sourceKind === "document" &&
    (!isCanonicalDocumentLogicalIdentity(proof.logicalSourceIdentity) ||
      documentIdFromLogicalIdentity(proof.logicalSourceIdentity) === undefined ||
      !new RegExp(
        `^${escapeRegExp(proof.logicalSourceIdentity)}:[^:\\s]+:[A-Za-z0-9_-]{43}$`,
        "u",
      ).test(proof.contentItemIdentity))
  ) {
    throw sourceExposureFailure("code-owned document proof identity is not canonical");
  }
};

const codeOwnedDescriptorBinding = (
  descriptor: CodeOwnedSourceDescriptor,
  proof: SourceExposureProof,
  sourceOrdinal: number,
): string =>
  stableJson({
    sourceOrdinal,
    messageIndex: descriptor.location.messageIndex,
    serializedField: descriptor.location.serializedField,
    ...(descriptor.location.characterOffset === undefined
      ? {}
      : { characterOffset: descriptor.location.characterOffset }),
    sourceKind: descriptor.sourceKind,
    exposureStage: descriptor.exposureStage,
    logicalSourceIdentity: proof.logicalSourceIdentity,
    contentItemIdentity: proof.contentItemIdentity,
    publicDocumentId:
      descriptor.documentId ?? documentIdFromLogicalIdentity(proof.logicalSourceIdentity),
    visibleTokenCount: proof.visibleTokenCount,
  });

const expectedToolExposures = (normalized: ProviderRequest): readonly LocatedSourceExposure[] => {
  const toolCalls = new Map<
    string,
    { readonly call: ProviderToolCall; readonly messageIndex: number }
  >();
  for (const [messageIndex, message] of normalized.messages.entries()) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (toolCalls.has(call.id)) throw sourceExposureFailure("duplicate tool-call location");
      toolCalls.set(call.id, { call, messageIndex });
    }
  }
  const exposures: LocatedSourceExposure[] = [];
  for (const [messageIndex, message] of normalized.messages.entries()) {
    if (message.role !== "tool") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.content) as unknown;
    } catch {
      if (sourceToolName(message.name)) {
        throw sourceExposureFailure(`${message.name} result is not JSON`);
      }
      continue;
    }
    if (!isJsonRecord(parsed)) {
      if (sourceToolName(message.name)) {
        throw sourceExposureFailure(`${message.name} result is not an object`);
      }
      continue;
    }
    const callLocation = toolCalls.get(message.toolCallId);
    if (callLocation === undefined || callLocation.messageIndex >= messageIndex) {
      throw sourceExposureFailure(`${message.name} result lacks its exact preceding tool call`);
    }
    const call = callLocation.call;
    const expected =
      expectedSourceExposures(message.name, parsed, call) ??
      expectedStrippedToolResultExposures(message.name, parsed, call);
    if (expected === undefined) {
      if (Object.hasOwn(parsed, SOURCE_EXPOSURE_FIELD)) {
        throw sourceExposureFailure("reserved marker inventory appeared on an unrelated tool");
      }
      continue;
    }
    const embedded = Object.hasOwn(parsed, SOURCE_EXPOSURE_FIELD)
      ? markersFromResult(parsed)
      : undefined;
    if (embedded !== undefined && embedded.length !== expected.length) {
      throw sourceExposureFailure("marker cardinality differs from visible source bodies");
    }
    expected.forEach((item, index) => {
      const marker = embedded?.[index];
      exposures.push({
        marker: marker ?? {
          sourceKind: item.sourceKind,
          logicalSourceIdentity: item.logicalSourceIdentity ?? "",
          contentItemIdentity: item.contentItemIdentity ?? "",
          exposureStage: item.exposureStage,
          visibleTokenCount: 0,
        },
        location: sourceResultLocation(messageIndex, message.name, index, item),
        expected: item,
      });
    });
  }
  return exposures;
};

const withGlobalSourceOrdinals = (
  normalized: ProviderRequest,
): readonly LocatedSourceExposure[] => {
  const code = codeOwnedExposureDescriptors(normalized).map((descriptor) => ({
    marker: {
      sourceKind: descriptor.sourceKind,
      logicalSourceIdentity: descriptor.logicalSourceIdentity ?? "",
      contentItemIdentity: descriptor.contentItemIdentity ?? "",
      exposureStage: descriptor.exposureStage,
      visibleTokenCount: 0,
    },
    location: descriptor.location,
    descriptor,
  }));
  const tools = expectedToolExposures(normalized);
  const codeByMessage = new Map<number, LocatedSourceExposure[]>();
  for (const exposure of code) {
    const values = codeByMessage.get(exposure.location.messageIndex) ?? [];
    values.push(exposure);
    codeByMessage.set(exposure.location.messageIndex, values);
  }
  const toolsByMessage = new Map<number, LocatedSourceExposure[]>();
  for (const exposure of tools) {
    const values = toolsByMessage.get(exposure.location.messageIndex) ?? [];
    values.push(exposure);
    toolsByMessage.set(exposure.location.messageIndex, values);
  }
  const all: LocatedSourceExposure[] = [];
  for (const messageIndex of normalized.messages.keys()) {
    all.push(...(codeByMessage.get(messageIndex) ?? []));
    all.push(...(toolsByMessage.get(messageIndex) ?? []));
  }
  return all.map((exposure, sourceOrdinal) => ({
    ...exposure,
    location: { ...exposure.location, sourceOrdinal },
  }));
};

const assertProofMatchesDescriptor = (
  proof: CodeOwnedSourceExposureProof,
  descriptor: CodeOwnedSourceDescriptor,
  location: SourceExposureLocation,
  sourceOrdinal: number,
  countTextTokens: (text: string) => number,
): void => {
  if (
    proof.sourceKind !== descriptor.sourceKind ||
    proof.exposureStage !== descriptor.exposureStage ||
    proof.visibleText !== descriptor.visibleText ||
    proof.visibleTokenCount !== countTextTokens(descriptor.visibleText)
  ) {
    throw sourceExposureFailure(
      "sidecar content is not bound to its exact normalized source field",
    );
  }
  if (
    descriptor.logicalSourceIdentity !== undefined &&
    proof.logicalSourceIdentity !== descriptor.logicalSourceIdentity
  ) {
    throw sourceExposureFailure("sidecar identity differs from its ordered source descriptor");
  }
  if (
    descriptor.contentItemIdentity !== undefined &&
    proof.contentItemIdentity !== descriptor.contentItemIdentity
  ) {
    throw sourceExposureFailure(
      "sidecar content identity differs from its ordered source descriptor",
    );
  }
  if (
    descriptor.documentId !== undefined &&
    (documentIdFromLogicalIdentity(proof.logicalSourceIdentity) !== descriptor.documentId ||
      !documentContentIdentityMatchesSnippet(proof, descriptor.visibleText))
  ) {
    throw sourceExposureFailure(
      "sidecar document identity differs from its visible document field",
    );
  }
  if (proof.messageIndex !== undefined && proof.messageIndex !== location.messageIndex) {
    throw sourceExposureFailure("sidecar message location differs from its normalized request");
  }
  if (proof.serializedField !== undefined && proof.serializedField !== location.serializedField) {
    throw sourceExposureFailure("sidecar serialized field differs from its normalized request");
  }
  if (proof.sourceOrdinal !== undefined && proof.sourceOrdinal !== sourceOrdinal) {
    throw sourceExposureFailure("sidecar source order differs from its normalized request");
  }
  const publicDocumentId =
    descriptor.documentId ?? documentIdFromLogicalIdentity(proof.logicalSourceIdentity);
  if (proof.publicDocumentId !== undefined && proof.publicDocumentId !== publicDocumentId) {
    throw sourceExposureFailure("sidecar public document ID differs from its source descriptor");
  }
  const orderedDescriptor = codeOwnedDescriptorBinding(descriptor, proof, sourceOrdinal);
  if (
    proof.orderedSourceDescriptor !== undefined &&
    proof.orderedSourceDescriptor !== orderedDescriptor
  ) {
    throw sourceExposureFailure(
      "sidecar ordered source descriptor differs from its request location",
    );
  }
};

const verifyCodeOwnedExposureInventory = (
  request: ProviderRequest,
  markers: readonly SourceExposureProof[],
  countTextTokens: (text: string) => number,
): {
  readonly proofs: readonly string[];
  readonly bindings: readonly ProviderRequestSourceExposureProofBinding[];
} => {
  const normalized = normalizeProviderRequest(request);
  const invalid = markers.some(
    (marker) =>
      !isProviderVisibleSourceExposureMarker(marker) && !isCodeOwnedSourceExposureProof(marker),
  );
  if (invalid) {
    throw sourceExposureFailure("code-owned exposure inventory contains an invalid proof");
  }
  const proofs = markers;
  for (const proof of proofs) {
    if (!isCodeOwnedSourceExposureProof(proof)) continue;
    assertCodeOwnedMarkerShape(proof);
    const visibleTokenCount = countTextTokens(proof.visibleText);
    if (!Number.isSafeInteger(visibleTokenCount) || visibleTokenCount !== proof.visibleTokenCount) {
      throw sourceExposureFailure("sidecar tokenizer count differs from its visible content");
    }
  }
  const normalizedExposures = withGlobalSourceOrdinals(normalized);
  if (
    normalizedExposures.some((exposure) => {
      let parsed: unknown;
      const message = normalized.messages[exposure.location.messageIndex];
      if (message?.role !== "tool") return false;
      try {
        parsed = JSON.parse(message.content) as unknown;
      } catch {
        return false;
      }
      return isJsonRecord(parsed) && Object.hasOwn(parsed, SOURCE_EXPOSURE_FIELD);
    })
  ) {
    throw sourceExposureFailure(
      `${SOURCE_EXPOSURE_FIELD} is code-owned and must be stripped before a sidecar request`,
    );
  }
  if (proofs.length !== normalizedExposures.length) {
    throw sourceExposureFailure(
      proofs.length < normalizedExposures.length
        ? "missing proof for an exact normalized request field"
        : "extra proof has no exact normalized request field",
    );
  }
  const boundProofs: string[] = [];
  const bindings: ProviderRequestSourceExposureProofBinding[] = [];
  for (const [index, exposure] of normalizedExposures.entries()) {
    const proof = proofs[index]!;
    const expected = exposure.expected;
    if (exposure.descriptor !== undefined) {
      if (!isCodeOwnedSourceExposureProof(proof)) {
        throw sourceExposureFailure("conversation or answer exposure lacks its code-owned proof");
      }
      assertProofMatchesDescriptor(
        proof,
        exposure.descriptor,
        exposure.location,
        index,
        countTextTokens,
      );
    } else if (expected !== undefined) {
      try {
        assertExactSourceExposureMarker(proof, expected, countTextTokens);
      } catch {
        throw sourceExposureFailure("sidecar does not match the exact visible tool result");
      }
      if (isCodeOwnedSourceExposureProof(proof)) {
        if (
          proof.messageIndex !== undefined &&
          proof.messageIndex !== exposure.location.messageIndex
        ) {
          throw sourceExposureFailure(
            "sidecar message location differs from its normalized request",
          );
        }
        if (
          proof.serializedField !== undefined &&
          proof.serializedField !== exposure.location.serializedField
        ) {
          throw sourceExposureFailure(
            "sidecar serialized field differs from its normalized request",
          );
        }
        if (proof.sourceOrdinal !== undefined && proof.sourceOrdinal !== index) {
          throw sourceExposureFailure("sidecar source order differs from its normalized request");
        }
        const descriptor = stableJson({
          sourceOrdinal: index,
          messageIndex: exposure.location.messageIndex,
          serializedField: exposure.location.serializedField,
          ...(exposure.location.characterOffset === undefined
            ? {}
            : { characterOffset: exposure.location.characterOffset }),
          sourceKind: proof.sourceKind,
          exposureStage: proof.exposureStage,
          logicalSourceIdentity: proof.logicalSourceIdentity,
          contentItemIdentity: proof.contentItemIdentity,
          publicDocumentId:
            expected.documentId ?? documentIdFromLogicalIdentity(proof.logicalSourceIdentity),
          visibleTokenCount: proof.visibleTokenCount,
        });
        if (
          proof.orderedSourceDescriptor !== undefined &&
          proof.orderedSourceDescriptor !== descriptor
        ) {
          throw sourceExposureFailure(
            "sidecar ordered source descriptor differs from its request location",
          );
        }
        if (
          proof.publicDocumentId !== undefined &&
          proof.publicDocumentId !==
            (expected.documentId ?? documentIdFromLogicalIdentity(proof.logicalSourceIdentity))
        ) {
          throw sourceExposureFailure(
            "sidecar public document ID differs from its source descriptor",
          );
        }
      }
    } else {
      throw sourceExposureFailure("source exposure location lacks its expected body");
    }
    const boundProof = boundSourceExposureProofSha256Hex(proof, exposure.location, expected);
    boundProofs.push(boundProof);
    bindings.push({
      providerSerializationProofSha256Hex: boundProof,
      marker: {
        sourceKind: proof.sourceKind,
        logicalSourceIdentity: proof.logicalSourceIdentity,
        contentItemIdentity: proof.contentItemIdentity,
        exposureStage: proof.exposureStage,
        visibleTokenCount: proof.visibleTokenCount,
      },
      binding: {
        messageIndex: exposure.location.messageIndex,
        sourceOrdinal: index,
        serializedField: exposure.location.serializedField,
        ...(exposure.location.characterOffset === undefined
          ? {}
          : { characterOffset: exposure.location.characterOffset }),
        orderedSourceDescriptor: codeOwnedDescriptorBinding(
          exposure.descriptor ?? {
            sourceKind: proof.sourceKind,
            exposureStage: proof.exposureStage,
            visibleText: isCodeOwnedSourceExposureProof(proof) ? proof.visibleText : "",
            location: exposure.location,
          },
          proof,
          index,
        ),
        ...((expected?.documentId ?? documentIdFromLogicalIdentity(proof.logicalSourceIdentity)) ===
        undefined
          ? {}
          : {
              publicDocumentId:
                expected?.documentId ?? documentIdFromLogicalIdentity(proof.logicalSourceIdentity),
            }),
      },
    });
    const binding = bindings.at(-1)!;
    rememberProviderSourceExposureBinding(
      providerRequestSha256Hex(request),
      binding.marker,
      binding.binding,
    );
  }
  if (new Set(boundProofs).size !== boundProofs.length) {
    throw sourceExposureFailure("code-owned exposure inventory contains duplicate bindings");
  }
  return { proofs: boundProofs.sort(), bindings };
};

/**
 * Returns the exact content-free binding for every normalized sidecar field.
 * Callers that persist measurements must store this result with the proof
 * hashes; a hash without its binding cannot be reconciled after a retry.
 */
export const providerRequestSourceExposureProofBindings = (
  request: ProviderRequest,
  countTextTokens: (text: string) => number,
): readonly ProviderRequestSourceExposureProofBinding[] =>
  verifyCodeOwnedExposureInventory(request, request.sourceExposureProofs ?? [], countTextTokens)
    .bindings;

/**
 * Reads a legacy test-only marker inventory when one is supplied directly.
 * Live agent-client tool messages strip that field before this boundary; live
 * exposure proofs come from the code-owned ledger instead.
 */
export const providerRequestSourceExposureProofs = (
  request: ProviderRequest,
  countTextTokens: (text: string) => number,
): readonly string[] => {
  if (request.sourceExposureProofs !== undefined) {
    return verifyCodeOwnedExposureInventory(request, request.sourceExposureProofs, countTextTokens)
      .proofs;
  }
  const normalized = normalizeProviderRequest(request);
  if (codeOwnedExposureDescriptors(normalized).length > 0) {
    throw sourceExposureFailure("missing code-owned proof for an exact normalized request field");
  }
  const proofs = new Set<string>();
  const toolCalls = new Map<
    string,
    { readonly call: ProviderToolCall; readonly messageIndex: number }
  >();
  for (const [messageIndex, message] of normalized.messages.entries()) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        if (toolCalls.has(call.id)) throw sourceExposureFailure("duplicate tool-call location");
        toolCalls.set(call.id, { call, messageIndex });
      }
      continue;
    }
    if (message.role !== "tool") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.content) as unknown;
    } catch {
      if (
        message.name.endsWith("_internal") ||
        message.name === "inspect_candidate" ||
        message.name === "search_within_candidate"
      ) {
        throw sourceExposureFailure(`${message.name} result is not JSON`);
      }
      continue;
    }
    if (!isJsonRecord(parsed)) continue;
    const callLocation = toolCalls.get(message.toolCallId);
    const call =
      callLocation !== undefined && callLocation.messageIndex < messageIndex
        ? callLocation.call
        : undefined;
    const expected =
      expectedSourceExposures(message.name, parsed, call) ??
      (call === undefined
        ? undefined
        : expectedStrippedToolResultExposures(message.name, parsed, call));
    if (!Object.hasOwn(parsed, SOURCE_EXPOSURE_FIELD)) {
      if (expected !== undefined && expected.length > 0) {
        throw sourceExposureFailure("missing proof for an exact normalized tool-result field");
      }
      continue;
    }
    if (expected === undefined) {
      throw sourceExposureFailure("reserved marker inventory appeared on an unrelated tool");
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
      // Pi's OpenAI-completions adapter drops assistant messages that contain
      // neither visible text nor tool calls before transport. Keep the local
      // GLM template and the provider request byte-for-byte equivalent for
      // prose-only correction turns that produced an empty assistant body.
      if (
        message.role === "assistant" &&
        message.content.trim() === "" &&
        (message.toolCalls === undefined || message.toolCalls.length === 0)
      ) {
        return [];
      }
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
    ...(request.sourceExposureProofs === undefined
      ? {}
      : { sourceExposureProofs: request.sourceExposureProofs }),
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
  assertProviderRequestIsRedacted(request);
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
