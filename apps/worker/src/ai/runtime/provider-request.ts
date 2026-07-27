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
  /** Hash of the immutable source body, kept only in the code-owned sidecar. */
  readonly immutableContentHash?: string | undefined;
  /** Commitment to namespace, version, and publisher/external identity fields. */
  readonly immutableSourceIdentityCommitment?: string | undefined;
  /** Commitment to the exact source identity and provider-visible range fields. */
  readonly immutableSourceCommitment?: string | undefined;
  /** Optional caller-supplied binding; the gate re-derives and checks it. */
  readonly messageIndex?: number | undefined;
  readonly serializedField?: string | undefined;
  readonly sourceOrdinal?: number | undefined;
  readonly orderedSourceDescriptor?: string | undefined;
  readonly publicDocumentId?: string | undefined;
  /** Exact assistant call and result item that minted this sidecar. */
  readonly sourceToolCallId?: string | undefined;
  readonly sourceResultIndex?: number | undefined;
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

/** Shared canonical framing for verbatim answer evidence. */
export const serializeAnswerSource = (source: {
  readonly key: string;
  readonly kind: string;
  readonly label?: string | null | undefined;
  readonly text: string;
}): string =>
  [
    `<source key=${JSON.stringify(source.key)} kind=${JSON.stringify(source.kind)} length="${source.text.length}"${source.label == null ? "" : ` label=${JSON.stringify(source.label)}`}>`,
    source.text,
    "</source>",
  ].join("\n");

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

/**
 * Private commitment carried beside a redacted tool result.  It binds the
 * immutable content hash, every source identity, and the exact provider field
 * (including candidate-search matches, previews, and scope).  The commitment
 * never enters provider messages.
 */
export const providerVisibleSourceExposureCommitment = (
  marker: ProviderVisibleSourceExposureMarker,
  providerVisibleBinding: string,
  immutableContentHash: string,
  immutableSourceIdentityCommitment?: string,
): string =>
  sha256Base64Url(
    stableJson({
      sourceKind: marker.sourceKind,
      logicalSourceIdentity: marker.logicalSourceIdentity,
      contentItemIdentity: marker.contentItemIdentity,
      exposureStage: marker.exposureStage,
      visibleTokenCount: marker.visibleTokenCount,
      immutableContentHash,
      ...(immutableSourceIdentityCommitment === undefined
        ? {}
        : { immutableSourceIdentityCommitment }),
      providerVisibleBinding,
    }),
  );

const providerSourceExposureBindingRegistry = new Map<
  string,
  Map<string, ProviderVisibleSourceExposureProofBinding[]>
>();
const MAX_PROVIDER_SOURCE_EXPOSURE_BINDING_REQUESTS = 4096;

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
  let requestEntries = providerSourceExposureBindingRegistry.get(requestSha256Hex);
  if (requestEntries === undefined) {
    if (
      providerSourceExposureBindingRegistry.size >= MAX_PROVIDER_SOURCE_EXPOSURE_BINDING_REQUESTS
    ) {
      const oldestRequest = providerSourceExposureBindingRegistry.keys().next().value;
      if (typeof oldestRequest === "string") {
        providerSourceExposureBindingRegistry.delete(oldestRequest);
      }
    }
    requestEntries = new Map<string, ProviderVisibleSourceExposureProofBinding[]>();
  }
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
    "immutableContentHash",
    "immutableSourceIdentityCommitment",
    "immutableSourceCommitment",
    "messageIndex",
    "serializedField",
    "sourceOrdinal",
    "orderedSourceDescriptor",
    "publicDocumentId",
    "sourceToolCallId",
    "sourceResultIndex",
  ]);
  return (
    isProviderVisibleSourceExposureMarker(marker) &&
    Object.keys(proof).every((key) => allowedKeys.has(key)) &&
    typeof proof.visibleText === "string" &&
    proof.visibleText.length > 0 &&
    (proof.immutableContentHash === undefined ||
      (typeof proof.immutableContentHash === "string" &&
        (/^[a-f0-9]{64}$/u.test(proof.immutableContentHash) ||
          /^[A-Za-z0-9_-]{43}$/u.test(proof.immutableContentHash)))) &&
    (proof.immutableSourceIdentityCommitment === undefined ||
      (typeof proof.immutableSourceIdentityCommitment === "string" &&
        /^[A-Za-z0-9_-]{43}$/u.test(proof.immutableSourceIdentityCommitment))) &&
    (proof.immutableSourceCommitment === undefined ||
      (typeof proof.immutableSourceCommitment === "string" &&
        /^[A-Za-z0-9_-]{43}$/u.test(proof.immutableSourceCommitment))) &&
    (proof.sourceToolCallId === undefined ||
      (typeof proof.sourceToolCallId === "string" && proof.sourceToolCallId.length > 0)) &&
    (proof.sourceResultIndex === undefined ||
      (typeof proof.sourceResultIndex === "number" &&
        Number.isSafeInteger(proof.sourceResultIndex) &&
        proof.sourceResultIndex >= 0))
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
  /** Canonical binding of every provider-visible field for this exposure. */
  readonly providerVisibleBinding?: string | undefined;
  /** Redacted opaque candidates require the private commitment sidecar. */
  readonly requiresPrivateCommitment?: boolean | undefined;
  /** Exact assistant call and result item that produced this exposure. */
  readonly sourceToolCallId?: string | undefined;
  readonly sourceResultIndex?: number | undefined;
}

const providerVisibleBindingForCall = (
  toolName: string,
  toolCall: ProviderToolCall,
  index: number,
  sourceBinding: string | undefined,
): string =>
  stableJson({
    toolName,
    toolCallId: toolCall.id,
    toolArguments: stableJsonValue(toolCall.arguments),
    resultIndex: index,
    sourceBinding:
      sourceBinding ??
      stableJson({
        visibleTextOnly: true,
      }),
  });

const providerVisibleSourceBinding = (
  exposure: Pick<
    ExpectedVisibleSourceExposure,
    "sourceKind" | "visibleText" | "providerVisibleBinding"
  >,
): string =>
  exposure.providerVisibleBinding ??
  stableJson({
    sourceKind: exposure.sourceKind,
    visibleTextHash: sha256Base64Url(exposure.visibleText),
  });

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
const SOURCE_IDENTITY_FIELD = "__briefSourceIdentity";
const HIDDEN_PROVIDER_TOOL_RESULT_FIELDS = new Set([
  SOURCE_EXPOSURE_FIELD,
  SOURCE_IDENTITY_FIELD,
  "versionId",
  "contentHash",
  "publisherExtractionId",
  "source",
]);

const isJsonRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sourceExposureFailure = (message: string): Error =>
  new Error(`invalid provider-visible source exposure: ${message}`);

/**
 * Removes the complete private source identity policy from a tool result
 * before the result joins the provider-visible transcript.
 */
export const redactProviderToolResult = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactProviderToolResult);
  if (!isJsonRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !HIDDEN_PROVIDER_TOOL_RESULT_FIELDS.has(key))
      .map(([key, nested]) => [key, redactProviderToolResult(nested)]),
  );
};

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
    const privateIdentity = isJsonRecord(value[SOURCE_IDENTITY_FIELD])
      ? value[SOURCE_IDENTITY_FIELD]
      : undefined;
    const hasDocumentIdentity = typeof value.documentId === "string" && value.documentId.length > 0;
    const hasMessageIdentity =
      typeof value.messageId === "string" ||
      (value.kind === "chat_message" &&
        privateIdentity !== undefined &&
        typeof privateIdentity.messageId === "string");
    if (hasDocumentIdentity && hasMessageIdentity) {
      throw sourceExposureFailure("search_internal item must have one canonical source identity");
    }
    if (hasDocumentIdentity) {
      if (
        value.kind !== "document" ||
        Object.keys(value).some(
          (key) =>
            ![
              "kind",
              "documentId",
              "snippet",
              "ranges",
              "title",
              "publishedAt",
              SOURCE_IDENTITY_FIELD,
            ].includes(key),
        )
      ) {
        throw sourceExposureFailure(
          "search_internal document item contains a legacy or unchecked identity field",
        );
      }
      const privateIdentity = isJsonRecord(value[SOURCE_IDENTITY_FIELD])
        ? value[SOURCE_IDENTITY_FIELD]
        : undefined;
      const hasPrivateIdentity =
        privateIdentity !== undefined &&
        typeof privateIdentity.versionId === "string" &&
        privateIdentity.versionId.length > 0 &&
        typeof privateIdentity.contentHash === "string" &&
        /^[a-f0-9]{64}$/u.test(privateIdentity.contentHash) &&
        isJsonRecord(privateIdentity.source);
      const visibleRanges = Object.hasOwn(value, "ranges")
        ? canonicalPrivateDocumentRanges(value.ranges, "search_internal document item")
        : undefined;
      let logicalSourceIdentity: string | undefined;
      let contentItemIdentity: string | undefined;
      let documentRangeHash =
        visibleRanges === undefined ? undefined : sha256Base64Url(JSON.stringify(visibleRanges));
      if (hasPrivateIdentity) {
        validatePrivateDocumentIdentity(
          privateIdentity!,
          value.documentId as string,
          "search_internal document item",
        );
        const ranges = canonicalPrivateDocumentRanges(
          privateIdentity!.ranges,
          "search_internal document item",
        );
        documentRangeHash = sha256Base64Url(JSON.stringify(ranges));
        if (
          visibleRanges !== undefined &&
          documentRangeHash !== sha256Base64Url(JSON.stringify(visibleRanges))
        ) {
          throw sourceExposureFailure(
            "search_internal document ranges differ from its private identity",
          );
        }
        const namespace = documentNamespaceFromValue(
          privateIdentity!.source,
          value.documentId as string,
          "search_internal document item",
        );
        logicalSourceIdentity = namespacedDocumentEvidenceIdentity(
          namespace,
          value.documentId as string,
        );
        contentItemIdentity = `${logicalSourceIdentity}:${privateIdentity!.versionId}:${sha256Base64Url(
          JSON.stringify(ranges),
        )}`;
      }
      return {
        sourceKind: "document" as const,
        exposureStage: "internal_search_preview",
        visibleText: value.snippet,
        documentId: value.documentId as string,
        ...(logicalSourceIdentity === undefined ? {} : { logicalSourceIdentity }),
        ...(contentItemIdentity === undefined ? {} : { contentItemIdentity }),
        ...(documentRangeHash === undefined ? {} : { documentRangeHash }),
        providerVisibleBinding: stableJson({
          sourceKind: "document",
          documentId: value.documentId,
          visibleTextHash: sha256Base64Url(value.snippet as string),
        }),
        ...(hasPrivateIdentity ? {} : { requiresPrivateCommitment: true }),
      };
    }
    if (value.kind === "document") {
      throw sourceExposureFailure(
        "search_internal document item lacks its exact document identity",
      );
    }
    if (value.kind !== undefined && value.kind !== "chat_message") {
      throw sourceExposureFailure("search_internal chat item has an invalid source kind");
    }
    const messageId =
      typeof value.messageId === "string"
        ? value.messageId
        : privateIdentity !== undefined && typeof privateIdentity.messageId === "string"
          ? privateIdentity.messageId
          : undefined;
    return {
      sourceKind: "chat_message" as const,
      ...(messageId === undefined
        ? { requiresPrivateCommitment: true }
        : {
            logicalSourceIdentity: chatMessageEvidenceIdentity(messageId),
            contentItemIdentity: messageId,
          }),
      exposureStage: "internal_chat_search_preview",
      visibleText: value.snippet,
      providerVisibleBinding: stableJson({
        sourceKind: "chat_message",
        visibleTextHash: sha256Base64Url(value.snippet as string),
      }),
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

const canonicalPrivateDocumentRanges = (
  value: unknown,
  context: string,
): readonly CanonicalInspectionRange[] => {
  const ranges = canonicalInspectionRanges(value);
  if (ranges.length === 0) {
    throw sourceExposureFailure(`${context} lacks its exact document ranges`);
  }
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1]!.charEnd >= ranges[index]!.charStart) {
      throw sourceExposureFailure(`${context} document ranges are not canonical`);
    }
  }
  return ranges;
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
  const privateIdentity = isJsonRecord(result[SOURCE_IDENTITY_FIELD])
    ? result[SOURCE_IDENTITY_FIELD]
    : undefined;
  let logicalSourceIdentity: string | undefined;
  let contentItemIdentity: string | undefined;
  if (privateIdentity !== undefined) {
    validatePrivateDocumentIdentity(
      privateIdentity,
      reference.documentId as string,
      "inspect_internal document result",
    );
    const namespace = documentNamespaceFromValue(
      privateIdentity.source,
      reference.documentId as string,
      "inspect_internal document result",
    );
    logicalSourceIdentity = namespacedDocumentEvidenceIdentity(
      namespace,
      reference.documentId as string,
    );
    contentItemIdentity = `${logicalSourceIdentity}:${privateIdentity.versionId}:${sha256Base64Url(
      JSON.stringify(ranges),
    )}`;
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
      ...(logicalSourceIdentity === undefined ? {} : { logicalSourceIdentity }),
      ...(contentItemIdentity === undefined ? {} : { contentItemIdentity }),
      providerVisibleBinding: stableJson({
        sourceKind: "document",
        documentId: reference.documentId,
        ranges,
        visibleTextHash: sha256Base64Url(result.text as string),
      }),
      ...(privateIdentity === undefined ? { requiresPrivateCommitment: true } : {}),
    },
  ];
};

const expectedCandidateInspectionExposures = (
  result: JsonRecord,
  toolCall: ProviderToolCall,
): readonly ExpectedVisibleSourceExposure[] => {
  const candidateId = toolCall.arguments.id;
  const hasConversationEntry = Object.hasOwn(result, "conversationEntry");
  if (
    hasConversationEntry ||
    (typeof candidateId === "string" && candidateId.startsWith("conversation_entry:"))
  ) {
    if (typeof candidateId !== "string" || candidateId.length === 0) {
      throw sourceExposureFailure("inspect_candidate lacks its candidate identity");
    }
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
    if (!keysMatch) {
      throw sourceExposureFailure("inspect_candidate conversation entry is not canonical");
    }
    if (
      candidateId.startsWith("conversation_entry:") &&
      entry.turnId !== candidateId.slice("conversation_entry:".length)
    ) {
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
    const providerVisibleBinding = stableJson({
      sourceKind: "chat_message",
      conversationEntry: stableJsonValue(entry),
    });
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
      providerVisibleBinding,
      // The structured entry carries fields beyond the exposed message body.
      // Require the private commitment so each proof stays bound to the exact
      // opaque tool call, result item, and complete visible entry.
      requiresPrivateCommitment: true,
    }));
  }
  if (typeof candidateId !== "string" || candidateId.length === 0) {
    if (typeof result.text !== "string") return [];
    throw sourceExposureFailure("inspect_candidate lacks its candidate identity");
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
  let logicalSourceIdentity: string | undefined;
  let contentItemIdentity: string | undefined;
  let documentRangeHash: string | undefined;
  let documentId: string | undefined;
  let requiresPrivateCommitment = false;
  const resultKind =
    typeof result.kind === "string" ? sourceKindFromSerializedKind(result.kind) : undefined;
  let providerVisibleBinding = stableJson({
    sourceKind: resultKind,
    visibleTextHash: sha256Base64Url(result.text),
  });
  const privateIdentity = isJsonRecord(result[SOURCE_IDENTITY_FIELD])
    ? result[SOURCE_IDENTITY_FIELD]
    : undefined;
  if (candidateId.startsWith("document:") || resultKind === "document") {
    sourceKind = "document";
    const hasKnownDocumentIdentity = isCanonicalDocumentLogicalIdentity(candidateId);
    if (candidateId.startsWith("document:") && !hasKnownDocumentIdentity) {
      throw sourceExposureFailure(
        "inspect_candidate document handle is not a canonical namespaced candidate",
      );
    }
    documentId =
      typeof result.documentId === "string" && result.documentId.length > 0
        ? result.documentId
        : documentIdFromLogicalIdentity(candidateId);
    if (documentId === undefined) {
      throw sourceExposureFailure("inspect_candidate document result lacks its exact document");
    }
    if (
      Object.hasOwn(result, "documentId") &&
      (typeof result.documentId !== "string" || result.documentId !== documentId)
    ) {
      throw sourceExposureFailure(
        "inspect_candidate visible document ID differs from its tool result",
      );
    }
    const ranges = canonicalInspectionRanges(result.ranges);
    if (Object.hasOwn(toolCall.arguments, "range")) {
      const requestedRange = canonicalInspectionRanges([toolCall.arguments.range]);
      if (stableJson(requestedRange) !== stableJson(ranges)) {
        throw sourceExposureFailure(
          "inspect_candidate document range differs from its tool result",
        );
      }
    }
    documentRangeHash = sha256Base64Url(JSON.stringify(ranges));
    const hasVersion = typeof result.versionId === "string" && result.versionId.length > 0;
    const hasSource = Object.hasOwn(result, "source");
    if (hasVersion !== hasSource) {
      throw sourceExposureFailure(
        "inspect_candidate document result has a partial immutable identity",
      );
    }
    if (hasVersion && hasSource) {
      const namespace = documentNamespaceFromValue(
        result.source,
        documentId,
        "inspect_candidate document result",
      );
      const expectedCandidateId = namespacedDocumentEvidenceIdentity(namespace, documentId);
      if (candidateId !== expectedCandidateId) {
        if (hasKnownDocumentIdentity) {
          throw sourceExposureFailure(
            "inspect_candidate document result provenance differs from its namespaced candidate",
          );
        }
      }
      logicalSourceIdentity = expectedCandidateId;
      contentItemIdentity = `${expectedCandidateId}:${result.versionId}:${documentRangeHash}`;
    } else {
      requiresPrivateCommitment = true;
    }
    providerVisibleBinding = stableJson({
      sourceKind,
      documentId,
      ranges,
      visibleTextHash: sha256Base64Url(result.text),
    });
  } else if (candidateId.startsWith("chat_message:") || resultKind === "chat_message") {
    sourceKind = "chat_message";
    const messageId = candidateId.startsWith("chat_message:")
      ? candidateId.slice("chat_message:".length)
      : typeof result.messageId === "string" && result.messageId.length > 0
        ? result.messageId
        : privateIdentity !== undefined &&
            typeof privateIdentity.messageId === "string" &&
            privateIdentity.messageId.length > 0
          ? privateIdentity.messageId
          : undefined;
    if (messageId !== undefined) {
      logicalSourceIdentity = chatMessageEvidenceIdentity(messageId);
      contentItemIdentity = messageId;
    } else {
      requiresPrivateCommitment = true;
    }
    providerVisibleBinding = stableJson({
      sourceKind,
      visibleTextHash: sha256Base64Url(result.text),
    });
  } else if (candidateId.startsWith("memory:") || resultKind === "memory") {
    sourceKind = "memory";
    const memoryId = candidateId.startsWith("memory:")
      ? candidateId.slice("memory:".length)
      : typeof result.memoryId === "string"
        ? result.memoryId
        : privateIdentity?.memoryId;
    if (typeof result.memoryId === "string" && memoryId !== result.memoryId) {
      throw sourceExposureFailure("inspect_candidate memory result differs from its candidate");
    }
    const memoryRevisionId =
      typeof result.memoryRevisionId === "string"
        ? result.memoryRevisionId
        : privateIdentity !== undefined && typeof privateIdentity.memoryRevisionId === "string"
          ? privateIdentity.memoryRevisionId
          : undefined;
    if (
      typeof memoryId === "string" &&
      memoryId.length > 0 &&
      memoryRevisionId !== undefined &&
      memoryRevisionId.length > 0
    ) {
      logicalSourceIdentity = `memory:${memoryId}`;
      contentItemIdentity = memoryRevisionId;
    } else {
      requiresPrivateCommitment = true;
    }
    providerVisibleBinding = stableJson({
      sourceKind,
      visibleTextHash: sha256Base64Url(result.text),
    });
  } else if (candidateId.startsWith("web:") || resultKind === "web") {
    sourceKind = "web";
    const url = candidateId.startsWith("web:")
      ? candidateId.slice("web:".length)
      : typeof result.url === "string" && result.url.length > 0
        ? canonicalizeWebUrl(result.url)
        : privateIdentity !== undefined &&
            typeof privateIdentity.url === "string" &&
            privateIdentity.url.length > 0
          ? canonicalizeWebUrl(privateIdentity.url)
          : undefined;
    const quoteHash =
      typeof result.quoteHash === "string" && result.quoteHash.length > 0
        ? result.quoteHash
        : privateIdentity !== undefined &&
            typeof privateIdentity.quoteHash === "string" &&
            privateIdentity.quoteHash.length > 0
          ? privateIdentity.quoteHash
          : sha256Base64Url(result.text);
    if (url !== undefined) {
      logicalSourceIdentity = `web:${url}:${quoteHash}`;
      contentItemIdentity = `${url}:${quoteHash}`;
    } else {
      requiresPrivateCommitment = true;
    }
    providerVisibleBinding = stableJson({
      sourceKind,
      visibleTextHash: sha256Base64Url(result.text),
    });
  } else {
    throw sourceExposureFailure("inspect_candidate has an unknown candidate identity");
  }
  return [
    {
      sourceKind,
      ...(logicalSourceIdentity === undefined ? {} : { logicalSourceIdentity }),
      ...(contentItemIdentity === undefined ? {} : { contentItemIdentity }),
      exposureStage: "context_candidate_inspection",
      visibleText: result.text,
      ...(sourceKind === "document" ? { documentId: documentId as string } : {}),
      ...(documentRangeHash === undefined ? {} : { documentRangeHash }),
      providerVisibleBinding,
      ...(requiresPrivateCommitment ? { requiresPrivateCommitment: true } : {}),
    },
  ];
};

const expectedCandidateSearchExposures = (
  result: JsonRecord,
  toolCall: ProviderToolCall,
): readonly ExpectedVisibleSourceExposure[] => {
  if (result.protocolError === "tool arguments did not match the advertised schema") return [];
  const candidateId = toolCall.arguments.id;
  const matches = result.matches;
  const previews = result.matchPreviews;
  if (!Array.isArray(previews)) {
    throw sourceExposureFailure("search_within_candidate result lacks canonical match previews");
  }
  if (!Array.isArray(matches)) {
    if (previews.length === 0) return [];
    throw sourceExposureFailure("search_within_candidate result lacks canonical matches");
  }
  if (matches.length === 0 && previews.length === 0 && !Object.hasOwn(result, "scope")) {
    return [];
  }
  const canonicalMatches = matches.map((match) => canonicalInspectionRanges([match])[0]!);
  const knownDocumentCandidate =
    typeof candidateId === "string" && candidateId.startsWith("document:");
  if (knownDocumentCandidate && !isCanonicalDocumentLogicalIdentity(candidateId as string)) {
    throw sourceExposureFailure("search_within_candidate document handle is not canonical");
  }
  const candidateKind = knownDocumentCandidate
    ? "document"
    : typeof result.kind === "string"
      ? sourceKindFromSerializedKind(result.kind)
      : undefined;
  if (result.found !== true) {
    if (previews.length > 0) {
      throw sourceExposureFailure(
        "search_within_candidate preview lacks its complete document result",
      );
    }
    return [];
  }
  if (candidateKind !== "document") {
    if (previews.length > 0) {
      throw sourceExposureFailure(
        "search_within_candidate preview lacks its document candidate identity",
      );
    }
    return [];
  }
  if (!isJsonRecord(result.scope)) {
    throw sourceExposureFailure(
      "search_within_candidate result must contain its exact search scope",
    );
  }
  const scope = result.scope;
  if (
    Object.keys(scope).some(
      (key) => !["kind", "ranges", "matchOffset", "maximumMatches"].includes(key),
    ) ||
    (scope.kind !== "selected_document_ranges" && scope.kind !== "complete_candidate") ||
    typeof scope.matchOffset !== "number" ||
    !Number.isSafeInteger(scope.matchOffset) ||
    scope.matchOffset < 0 ||
    typeof scope.maximumMatches !== "number" ||
    !Number.isSafeInteger(scope.maximumMatches) ||
    scope.maximumMatches < 1
  ) {
    throw sourceExposureFailure("search_within_candidate result has an invalid search scope");
  }
  if (scope.kind !== "selected_document_ranges") {
    throw sourceExposureFailure(
      "search_within_candidate result has an invalid document scope kind",
    );
  }
  const requestedCursor =
    typeof toolCall.arguments.cursor === "number" ? toolCall.arguments.cursor : 0;
  if (scope.matchOffset !== requestedCursor || scope.maximumMatches !== 500) {
    throw sourceExposureFailure(
      "search_within_candidate scope does not match its production bounds",
    );
  }
  const scopeRanges = canonicalInspectionRanges(scope.ranges);
  if (scopeRanges.length === 0) {
    throw sourceExposureFailure("search_within_candidate scope must contain a selected range");
  }
  for (let index = 1; index < scopeRanges.length; index += 1) {
    if (scopeRanges[index - 1]!.charEnd >= scopeRanges[index]!.charStart) {
      throw sourceExposureFailure("search_within_candidate scope ranges are not canonical");
    }
  }
  for (let index = 1; index < canonicalMatches.length; index += 1) {
    if (canonicalMatches[index - 1]!.charStart >= canonicalMatches[index]!.charStart) {
      throw sourceExposureFailure("search_within_candidate matches are not canonical");
    }
  }
  if (
    canonicalMatches.some(
      (match) =>
        !scopeRanges.some(
          (scopeRange) =>
            match.charStart >= scopeRange.charStart && match.charEnd <= scopeRange.charEnd,
        ),
    )
  ) {
    throw sourceExposureFailure("search_within_candidate match range is outside its search scope");
  }
  if (typeof result.documentId !== "string" || result.documentId.length === 0) {
    throw sourceExposureFailure("search_within_candidate result lacks its exact document");
  }
  const resultDocumentId = result.documentId;
  if (canonicalMatches.length === 0 && previews.length > 0) {
    throw sourceExposureFailure("search_within_candidate previews lack their exact matches");
  }
  const privateIdentity = isJsonRecord(result[SOURCE_IDENTITY_FIELD])
    ? result[SOURCE_IDENTITY_FIELD]
    : undefined;
  const privateVersion =
    privateIdentity !== undefined && typeof privateIdentity.versionId === "string"
      ? privateIdentity.versionId
      : undefined;
  const privateSource = privateIdentity?.source;
  const hasVersion =
    (typeof result.versionId === "string" && result.versionId.length > 0) ||
    (privateVersion !== undefined && privateVersion.length > 0);
  const hasSource = Object.hasOwn(result, "source") || privateSource !== undefined;
  if (hasVersion !== hasSource) {
    throw sourceExposureFailure("search_within_candidate result has a partial immutable identity");
  }
  if (
    typeof result.versionId === "string" &&
    privateVersion !== undefined &&
    result.versionId !== privateVersion
  ) {
    throw sourceExposureFailure(
      "search_within_candidate version differs from its private identity",
    );
  }
  if (privateIdentity !== undefined) {
    validatePrivateDocumentIdentity(
      privateIdentity,
      resultDocumentId,
      "search_within_candidate result",
    );
  }
  let logicalSourceIdentity: string | undefined;
  if (hasVersion && hasSource) {
    const namespace = documentNamespaceFromValue(
      result.source ?? privateSource,
      resultDocumentId,
      "search_within_candidate result",
    );
    logicalSourceIdentity = namespacedDocumentEvidenceIdentity(namespace, resultDocumentId);
    if (knownDocumentCandidate && candidateId !== logicalSourceIdentity) {
      throw sourceExposureFailure(
        "search_within_candidate result provenance differs from its namespaced candidate",
      );
    }
  }
  const exactSearchBinding = stableJson({
    sourceKind: "document",
    documentId: resultDocumentId,
    matches: canonicalMatches,
    matchPreviews: previews.map((preview) =>
      isJsonRecord(preview) && typeof preview.text === "string"
        ? { range: canonicalInspectionRanges([preview.range])[0], text: preview.text }
        : preview,
    ),
    scope: {
      kind: scope.kind,
      ranges: scopeRanges,
      matchOffset: scope.matchOffset,
      maximumMatches: scope.maximumMatches,
    },
  });
  return previews.map((preview) => {
    if (!isJsonRecord(preview) || typeof preview.text !== "string") {
      throw sourceExposureFailure("search_within_candidate preview is not canonical");
    }
    const ranges = canonicalInspectionRanges([preview.range]);
    const previewRange = ranges[0]!;
    if (
      !canonicalMatches.some(
        (match) =>
          match.charStart >= previewRange.charStart && match.charEnd <= previewRange.charEnd,
      ) ||
      (scopeRanges !== undefined &&
        !scopeRanges.some(
          (scopeRange) =>
            previewRange.charStart >= scopeRange.charStart &&
            previewRange.charEnd <= scopeRange.charEnd,
        ))
    ) {
      throw sourceExposureFailure(
        "search_within_candidate preview range is not bound to its exact match range",
      );
    }
    const rangeHash = sha256Base64Url(JSON.stringify(ranges));
    return {
      sourceKind: "document" as const,
      ...(logicalSourceIdentity === undefined ? {} : { logicalSourceIdentity }),
      ...(hasVersion && logicalSourceIdentity !== undefined
        ? {
            contentItemIdentity: `${logicalSourceIdentity}:${privateVersion ?? String(result.versionId)}:${rangeHash}`,
          }
        : {}),
      exposureStage: "context_candidate_inspection",
      visibleText: preview.text,
      documentId: resultDocumentId,
      documentRangeHash: rangeHash,
      providerVisibleBinding: exactSearchBinding,
      ...(hasVersion ? {} : { requiresPrivateCommitment: true }),
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
      const documentRangeHash =
        value.kind === "document" &&
        Number.isSafeInteger(value.charStart) &&
        Number.isSafeInteger(value.charEnd) &&
        Number(value.charStart) >= 0 &&
        Number(value.charEnd) > Number(value.charStart)
          ? sha256Base64Url(
              JSON.stringify([
                { charStart: Number(value.charStart), charEnd: Number(value.charEnd) },
              ]),
            )
          : undefined;
      const documentId =
        value.kind === "document" &&
        typeof value.documentId === "string" &&
        value.documentId.length > 0
          ? value.documentId
          : undefined;
      if (value.kind === "document" && documentId === undefined) {
        throw sourceExposureFailure("search_evidence document match lacks its exact document ID");
      }
      return {
        sourceKind: value.kind as ProviderVisibleSourceExposureMarker["sourceKind"],
        exposureStage: "evaluation_general_planner_search",
        visibleText: value.text,
        ...(documentId === undefined ? {} : { documentId }),
        ...(documentRangeHash === undefined ? {} : { documentRangeHash }),
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
    const documentRangeHash =
      result.kind === "document" &&
      isJsonRecord(result.range) &&
      Number.isSafeInteger(result.range.charStart) &&
      Number.isSafeInteger(result.range.charEnd) &&
      Number(result.range.charStart) >= 0 &&
      Number(result.range.charEnd) > Number(result.range.charStart)
        ? sha256Base64Url(
            JSON.stringify([
              {
                charStart: Number(result.range.charStart),
                charEnd: Number(result.range.charEnd),
              },
            ]),
          )
        : undefined;
    const documentId =
      result.kind === "document" &&
      typeof result.documentId === "string" &&
      result.documentId.length > 0
        ? result.documentId
        : undefined;
    if (result.kind === "document" && documentId === undefined) {
      throw sourceExposureFailure("inspect_evidence document result lacks its exact document ID");
    }
    return [
      {
        sourceKind: result.kind,
        exposureStage: "evaluation_general_planner_inspect",
        visibleText: result.text,
        ...(documentId === undefined ? {} : { documentId }),
        ...(documentRangeHash === undefined ? {} : { documentRangeHash }),
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
      : (expected.logicalSourceIdentity === undefined ||
          marker.logicalSourceIdentity === expected.logicalSourceIdentity) &&
        (expected.contentItemIdentity === undefined ||
          marker.contentItemIdentity === expected.contentItemIdentity);
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
    return expectedInternalSearchExposures(result);
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

const privateIdentityForExposure = (
  toolName: string,
  result: JsonRecord,
  index: number,
): JsonRecord | undefined => {
  const item =
    toolName === "search_internal" || toolName === "search_memories"
      ? Array.isArray(result.items)
        ? result.items[index]
        : undefined
      : toolName === "search_evidence"
        ? Array.isArray(result.matches)
          ? result.matches[index]
          : undefined
        : toolName === "web_search"
          ? Array.isArray(result.results)
            ? result.results[index]
            : undefined
          : result;
  if (!isJsonRecord(item)) return undefined;
  const value = item[SOURCE_IDENTITY_FIELD];
  if (value !== undefined && !isJsonRecord(value)) {
    throw sourceExposureFailure("source identity sidecar must be an object");
  }
  return isJsonRecord(value) ? value : undefined;
};

const immutableContentHashForExposure = (
  toolName: string,
  result: JsonRecord,
  index: number,
  expected: ExpectedVisibleSourceExposure,
): string => {
  const privateIdentity = privateIdentityForExposure(toolName, result, index);
  const contentHash = privateIdentity?.contentHash;
  if (typeof contentHash === "string" && /^[a-f0-9]{64}$/u.test(contentHash)) {
    return contentHash;
  }
  const directHash = result.contentHash;
  if (typeof directHash === "string" && /^[a-f0-9]{64}$/u.test(directHash)) {
    return directHash;
  }
  if (expected.sourceKind === "document") {
    throw sourceExposureFailure("document exposure lacks its immutable full-content hash");
  }
  return sha256Base64Url(expected.visibleText);
};

const immutableSourceIdentityCommitmentForExposure = (
  toolName: string,
  result: JsonRecord,
  index: number,
  marker: ProviderVisibleSourceExposureMarker,
  expected: ExpectedVisibleSourceExposure,
): string => {
  const privateIdentity = privateIdentityForExposure(toolName, result, index);
  return sha256Base64Url(
    stableJson({
      sourceKind: marker.sourceKind,
      logicalSourceIdentity: marker.logicalSourceIdentity,
      contentItemIdentity: marker.contentItemIdentity,
      privateIdentity: privateIdentity ?? null,
      visibleTextHash: sha256Base64Url(expected.visibleText),
    }),
  );
};

const validatePrivateDocumentIdentity = (
  privateIdentity: JsonRecord,
  documentId: string,
  context: string,
): DocumentEvidenceNamespace => {
  if (
    Object.keys(privateIdentity).some(
      (key) =>
        !["versionId", "contentHash", "publisherExtractionId", "source", "ranges"].includes(key),
    )
  ) {
    throw sourceExposureFailure(`${context} has unknown immutable identity fields`);
  }
  if (
    typeof privateIdentity.versionId !== "string" ||
    privateIdentity.versionId.length === 0 ||
    typeof privateIdentity.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(privateIdentity.contentHash)
  ) {
    throw sourceExposureFailure(`${context} has an invalid immutable content identity`);
  }
  if (Object.hasOwn(privateIdentity, "ranges")) {
    canonicalPrivateDocumentRanges(privateIdentity.ranges, context);
  }
  const namespace = documentNamespaceFromValue(privateIdentity.source, documentId, context);
  if (
    namespace.kind === "publisher" &&
    (typeof privateIdentity.publisherExtractionId !== "string" ||
      privateIdentity.publisherExtractionId.length === 0)
  ) {
    throw sourceExposureFailure(`${context} lacks its publisher extraction identity`);
  }
  if (namespace.kind === "public" && Object.hasOwn(privateIdentity, "publisherExtractionId")) {
    throw sourceExposureFailure(`${context} has publisher identity on a public document`);
  }
  return namespace;
};

const validatePrivateNonDocumentIdentity = (
  privateIdentity: JsonRecord,
  expected: ExpectedVisibleSourceExposure,
  marker: ProviderVisibleSourceExposureMarker,
  toolName: string,
): void => {
  const exactVisibleBody =
    toolName === "inspect_candidate" ||
    toolName === "inspect_memory" ||
    toolName === "search_memories";
  if (expected.sourceKind === "chat_message") {
    if (
      Object.keys(privateIdentity).some((key) => !["messageId", "contentHash"].includes(key)) ||
      typeof privateIdentity.messageId !== "string" ||
      privateIdentity.messageId.length === 0 ||
      typeof privateIdentity.contentHash !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(privateIdentity.contentHash)
    ) {
      throw sourceExposureFailure(`${toolName} chat identity is not canonical`);
    }
    if (
      marker.logicalSourceIdentity !== chatMessageEvidenceIdentity(privateIdentity.messageId) ||
      marker.contentItemIdentity !== privateIdentity.messageId
    ) {
      throw sourceExposureFailure(`${toolName} chat identity differs from its private identity`);
    }
  } else if (expected.sourceKind === "memory") {
    if (
      Object.keys(privateIdentity).some(
        (key) => !["memoryId", "memoryRevisionId", "contentHash"].includes(key),
      ) ||
      typeof privateIdentity.memoryId !== "string" ||
      privateIdentity.memoryId.length === 0 ||
      typeof privateIdentity.memoryRevisionId !== "string" ||
      privateIdentity.memoryRevisionId.length === 0 ||
      typeof privateIdentity.contentHash !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(privateIdentity.contentHash)
    ) {
      throw sourceExposureFailure(`${toolName} memory identity is not canonical`);
    }
    if (
      marker.logicalSourceIdentity !== `memory:${privateIdentity.memoryId}` ||
      marker.contentItemIdentity !== privateIdentity.memoryRevisionId
    ) {
      throw sourceExposureFailure(`${toolName} memory identity differs from its private identity`);
    }
  } else if (expected.sourceKind === "web") {
    let url: string;
    try {
      if (typeof privateIdentity.url !== "string") throw new Error("missing URL");
      url = canonicalizeWebUrl(privateIdentity.url);
    } catch {
      throw sourceExposureFailure(`${toolName} web identity is not canonical`);
    }
    if (
      Object.keys(privateIdentity).some(
        (key) => !["url", "quoteHash", "contentHash"].includes(key),
      ) ||
      typeof privateIdentity.quoteHash !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(privateIdentity.quoteHash) ||
      typeof privateIdentity.contentHash !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(privateIdentity.contentHash) ||
      marker.logicalSourceIdentity !== `web:${url}:${privateIdentity.quoteHash}` ||
      marker.contentItemIdentity !== `${url}:${privateIdentity.quoteHash}`
    ) {
      throw sourceExposureFailure(`${toolName} web identity differs from its private identity`);
    }
  }
  if (exactVisibleBody && privateIdentity.contentHash !== sha256Base64Url(expected.visibleText)) {
    throw sourceExposureFailure(`${toolName} private content hash differs from its visible body`);
  }
};

/**
 * Converts a code-owned result marker into the private proof carried to the
 * next provider request.  This runs before hidden identity fields and markers
 * are stripped from the provider-visible tool result.
 */
export const providerSourceExposureProofFromToolResult = (
  toolName: string,
  result: JsonRecord,
  toolCall: ProviderToolCall,
  countTextTokens: (text: string) => number,
): readonly CodeOwnedSourceExposureProof[] => {
  const expected =
    expectedSourceExposures(toolName, result, toolCall) ??
    expectedStrippedToolResultExposures(toolName, result, toolCall);
  if (expected === undefined) return [];
  const embedded = markersFromResult(result);
  if (embedded.length !== expected.length) {
    throw sourceExposureFailure("marker cardinality differs from visible source bodies");
  }
  return expected.map((item, index) => {
    const marker = embedded[index]!;
    assertExactSourceExposureMarker(marker, item, countTextTokens);
    if (item.sourceKind === "document") {
      const privateIdentity = privateIdentityForExposure(toolName, result, index);
      if (privateIdentity === undefined) {
        throw sourceExposureFailure(
          `${toolName} document result lacks its immutable identity sidecar`,
        );
      }
      if (privateIdentity !== undefined) {
        const documentId =
          item.documentId ?? documentIdFromLogicalIdentity(marker.logicalSourceIdentity);
        if (documentId === undefined) {
          throw sourceExposureFailure("document exposure lacks its exact document identity");
        }
        const namespace = validatePrivateDocumentIdentity(
          privateIdentity,
          documentId,
          `${toolName} document result`,
        );
        if (
          toolName !== "search_internal" &&
          ((Object.hasOwn(result, "versionId") && result.versionId !== privateIdentity.versionId) ||
            (Object.hasOwn(result, "contentHash") &&
              result.contentHash !== privateIdentity.contentHash) ||
            (Object.hasOwn(result, "publisherExtractionId") &&
              result.publisherExtractionId !== privateIdentity.publisherExtractionId) ||
            (Object.hasOwn(result, "source") &&
              stableJson(
                documentNamespaceFromValue(
                  result.source,
                  documentId,
                  `${toolName} document result`,
                ),
              ) !== stableJson(namespace)))
        ) {
          throw sourceExposureFailure(
            `${toolName} document identity differs from its private identity`,
          );
        }
        const privateLogicalIdentity = namespacedDocumentEvidenceIdentity(namespace, documentId);
        if (marker.logicalSourceIdentity !== privateLogicalIdentity) {
          throw sourceExposureFailure(
            `${toolName} marker namespace differs from its private identity`,
          );
        }
        const privateContentIdentity = `${privateLogicalIdentity}:${privateIdentity.versionId}:${
          item.documentRangeHash ?? sha256Base64Url(item.visibleText)
        }`;
        if (marker.contentItemIdentity !== privateContentIdentity) {
          throw sourceExposureFailure(
            `${toolName} marker version or range differs from its private identity`,
          );
        }
        if (item.documentRangeHash !== undefined && Object.hasOwn(privateIdentity, "ranges")) {
          const privateRangeHash = sha256Base64Url(
            JSON.stringify(
              canonicalPrivateDocumentRanges(privateIdentity.ranges, `${toolName} document result`),
            ),
          );
          if (privateRangeHash !== item.documentRangeHash) {
            throw sourceExposureFailure(
              `${toolName} document range differs from its immutable identity sidecar`,
            );
          }
        }
      }
    } else {
      const privateIdentity = privateIdentityForExposure(toolName, result, index);
      if (
        item.requiresPrivateCommitment === true &&
        privateIdentity === undefined &&
        (item.logicalSourceIdentity === undefined || item.contentItemIdentity === undefined)
      ) {
        throw sourceExposureFailure(
          `${toolName} opaque ${item.sourceKind} result lacks its immutable identity sidecar`,
        );
      }
      if (privateIdentity !== undefined) {
        validatePrivateNonDocumentIdentity(privateIdentity, item, marker, toolName);
      }
    }
    const immutableContentHash = immutableContentHashForExposure(toolName, result, index, item);
    const immutableSourceIdentityCommitment = immutableSourceIdentityCommitmentForExposure(
      toolName,
      result,
      index,
      marker,
      item,
    );
    const providerVisibleBinding = providerVisibleBindingForCall(
      toolName,
      toolCall,
      index,
      providerVisibleSourceBinding(item),
    );
    return {
      ...marker,
      visibleText: item.visibleText,
      sourceToolCallId: toolCall.id,
      sourceResultIndex: index,
      immutableContentHash,
      immutableSourceIdentityCommitment,
      immutableSourceCommitment: providerVisibleSourceExposureCommitment(
        marker,
        providerVisibleBinding,
        immutableContentHash,
        immutableSourceIdentityCommitment,
      ),
    };
  });
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
  descriptor: CodeOwnedSourceDescriptor,
): string =>
  providerVisibleSourceExposureProofSha256Hex(marker, {
    messageIndex: location.messageIndex,
    sourceOrdinal: location.sourceOrdinal,
    serializedField: location.serializedField,
    ...(location.characterOffset === undefined
      ? {}
      : { characterOffset: location.characterOffset }),
    orderedSourceDescriptor: codeOwnedDescriptorBinding(descriptor, marker, location.sourceOrdinal),
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
  name === "search_evidence" ||
  name === "inspect_evidence" ||
  name === "web_search" ||
  name === "web_fetch";

const containsHiddenProviderToolResultField = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsHiddenProviderToolResultField);
  if (!isJsonRecord(value)) return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      HIDDEN_PROVIDER_TOOL_RESULT_FIELDS.has(key) || containsHiddenProviderToolResultField(nested),
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
    if (containsHiddenProviderToolResultField(parsed)) {
      throw sourceExposureFailure(
        "private source identity is code-owned and must not cross the provider boundary",
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
  if (toolName === "search_evidence") return `matches[${index}].text`;
  if (toolName === "web_search") return `results[${index}].snippet`;
  if (toolName === "inspect_memory") return "memory.content";
  if (toolName === "web_fetch") return "text";
  if (toolName === "inspect_internal") {
    return expected.sourceKind === "chat_message" ? "message.content" : "text";
  }
  if (
    toolName === "inspect_candidate" &&
    expected.sourceKind === "chat_message" &&
    expected.exposureStage === "provider_input"
  ) {
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
    const header =
      /^<source key="([^"]+)" kind="([^"]+)" length="([1-9][0-9]*)"(?: label="((?:[^"\\]|\\.)*)")?>\n/uy.exec(
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
    const rawLabel = header[4];
    if (rawLabel !== undefined) {
      let label: unknown;
      try {
        label = JSON.parse(`"${rawLabel}"`);
      } catch {
        throw sourceExposureFailure("answer evidence contains an invalid source label");
      }
      if (typeof label !== "string" || JSON.stringify(label) !== `"${rawLabel}"`) {
        throw sourceExposureFailure("answer evidence contains a noncanonical source label");
      }
    }
    const bodyStart = cursor + header[0].length;
    const declaredLength = Number(header[3]);
    if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0) {
      throw sourceExposureFailure("answer evidence contains an invalid source body length");
    }
    const bodyEnd = bodyStart + declaredLength;
    if (bodyEnd > evidence.length || !evidence.startsWith("\n</source>", bodyEnd)) {
      throw sourceExposureFailure("answer evidence contains an invalid source body framing");
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
  if ((proof.sourceToolCallId === undefined) !== (proof.sourceResultIndex === undefined)) {
    throw sourceExposureFailure("code-owned proof has a partial tool-result coordinate");
  }
  if (
    ![
      "provider_input",
      "answer_serialized",
      "internal_search_preview",
      "internal_chat_search_preview",
      "internal_inspection",
      "context_candidate_inspection",
      "memory_tool_result",
      "web_search_preview",
      "web_fetch",
      "evaluation_general_planner_search",
      "evaluation_general_planner_inspect",
    ].includes(proof.exposureStage)
  ) {
    throw sourceExposureFailure("code-owned proof has an invalid exposure stage");
  }
  if (
    proof.sourceKind === "document" &&
    proof.immutableContentHash !== undefined &&
    !/^[a-f0-9]{64}$/u.test(proof.immutableContentHash)
  ) {
    throw sourceExposureFailure("document proof has an invalid immutable content hash");
  }
  if (proof.exposureStage === "provider_input" && proof.sourceKind !== "chat_message") {
    throw sourceExposureFailure("provider-input proof must identify a chat message");
  }
  const evaluationGeneralPlannerExposure =
    proof.exposureStage === "evaluation_general_planner_search" ||
    proof.exposureStage === "evaluation_general_planner_inspect";
  if (evaluationGeneralPlannerExposure && proof.sourceKind !== "document") {
    const match = /^(.*):([0-9]+):([0-9]+):([0-9a-f]{64})$/u.exec(proof.contentItemIdentity);
    if (
      match === null ||
      match[1] !== proof.logicalSourceIdentity ||
      !Number.isSafeInteger(Number(match[2])) ||
      !Number.isSafeInteger(Number(match[3])) ||
      Number(match[2]) < 0 ||
      Number(match[3]) <= Number(match[2]) ||
      match[4] !== createHash("sha256").update(proof.visibleText, "utf8").digest("hex")
    ) {
      throw sourceExposureFailure(
        "general-planner proof identity differs from its exact fixture range",
      );
    }
  }
  if (
    !evaluationGeneralPlannerExposure &&
    proof.sourceKind === "chat_message" &&
    proof.logicalSourceIdentity !== chatMessageEvidenceIdentity(proof.contentItemIdentity)
  ) {
    throw sourceExposureFailure("code-owned chat proof identity is not canonical");
  }
  if (
    !evaluationGeneralPlannerExposure &&
    proof.sourceKind === "memory" &&
    !proof.logicalSourceIdentity.startsWith("memory:")
  ) {
    throw sourceExposureFailure("code-owned memory proof identity is not canonical");
  }
  if (
    !evaluationGeneralPlannerExposure &&
    proof.sourceKind === "memory" &&
    (!/^memory:[^:\s]+$/u.test(proof.logicalSourceIdentity) ||
      proof.contentItemIdentity.trim() === "" ||
      /\s/u.test(proof.contentItemIdentity))
  ) {
    throw sourceExposureFailure("code-owned memory proof identity is not canonical");
  }
  if (!evaluationGeneralPlannerExposure && proof.sourceKind === "web") {
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
    ...(isCodeOwnedSourceExposureProof(proof) && proof.sourceToolCallId !== undefined
      ? { sourceToolCallId: proof.sourceToolCallId }
      : {}),
    ...(isCodeOwnedSourceExposureProof(proof) && proof.sourceResultIndex !== undefined
      ? { sourceResultIndex: proof.sourceResultIndex }
      : {}),
    ...(isCodeOwnedSourceExposureProof(proof) && proof.immutableContentHash !== undefined
      ? { immutableContentHash: proof.immutableContentHash }
      : {}),
    ...(isCodeOwnedSourceExposureProof(proof) &&
    proof.immutableSourceIdentityCommitment !== undefined
      ? { immutableSourceIdentityCommitment: proof.immutableSourceIdentityCommitment }
      : {}),
    ...(isCodeOwnedSourceExposureProof(proof) && proof.immutableSourceCommitment !== undefined
      ? { immutableSourceCommitment: proof.immutableSourceCommitment }
      : {}),
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
      const boundExpected = {
        ...item,
        sourceToolCallId: call.id,
        sourceResultIndex: index,
        providerVisibleBinding: providerVisibleBindingForCall(
          message.name,
          call,
          index,
          providerVisibleSourceBinding(item),
        ),
      } satisfies ExpectedVisibleSourceExposure;
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
        expected: boundExpected,
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
  const markerProofs = markers;
  for (const proof of markerProofs) {
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
  if (markerProofs.length !== normalizedExposures.length) {
    throw sourceExposureFailure(
      markerProofs.length < normalizedExposures.length
        ? "missing proof for an exact normalized request field"
        : "extra proof has no exact normalized request field",
    );
  }
  const boundProofs: string[] = [];
  const bindings: ProviderRequestSourceExposureProofBinding[] = [];
  for (const [index, exposure] of normalizedExposures.entries()) {
    const proof = markerProofs[index]!;
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
          (expected.sourceToolCallId !== undefined &&
            proof.sourceToolCallId !== expected.sourceToolCallId) ||
          (expected.sourceResultIndex !== undefined &&
            proof.sourceResultIndex !== expected.sourceResultIndex)
        ) {
          throw sourceExposureFailure("sidecar tool-result coordinate differs from its source");
        }
      }
      if (
        expected.requiresPrivateCommitment === true &&
        (!isCodeOwnedSourceExposureProof(proof) ||
          proof.immutableContentHash === undefined ||
          proof.immutableSourceIdentityCommitment === undefined ||
          proof.immutableSourceCommitment === undefined)
      ) {
        throw sourceExposureFailure(
          "redacted source exposure lacks its immutable code-owned commitment",
        );
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
          ...(proof.sourceToolCallId === undefined
            ? {}
            : { sourceToolCallId: proof.sourceToolCallId }),
          ...(proof.sourceResultIndex === undefined
            ? {}
            : { sourceResultIndex: proof.sourceResultIndex }),
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
        if (expected.requiresPrivateCommitment === true) {
          const providerVisibleBinding =
            expected.providerVisibleBinding ?? providerVisibleSourceBinding(expected);
          if (
            proof.immutableSourceCommitment !==
            providerVisibleSourceExposureCommitment(
              proof,
              providerVisibleBinding,
              proof.immutableContentHash!,
              proof.immutableSourceIdentityCommitment!,
            )
          ) {
            throw sourceExposureFailure("immutable source exposure commitment does not match");
          }
        } else if (isCodeOwnedSourceExposureProof(proof)) {
          if (
            proof.immutableContentHash !== undefined &&
            proof.immutableSourceIdentityCommitment !== undefined &&
            proof.immutableSourceCommitment !== undefined
          ) {
            const providerVisibleBinding =
              expected.providerVisibleBinding ?? providerVisibleSourceBinding(expected);
            if (
              proof.immutableSourceCommitment !==
              providerVisibleSourceExposureCommitment(
                proof,
                providerVisibleBinding,
                proof.immutableContentHash,
                proof.immutableSourceIdentityCommitment,
              )
            ) {
              throw sourceExposureFailure("immutable source exposure commitment does not match");
            }
          }
        }
      }
    } else {
      throw sourceExposureFailure("source exposure location lacks its expected body");
    }
    const bindingDescriptor = exposure.descriptor ?? {
      sourceKind: proof.sourceKind,
      exposureStage: proof.exposureStage,
      visibleText: isCodeOwnedSourceExposureProof(proof) ? proof.visibleText : "",
      location: exposure.location,
    };
    const orderedSourceDescriptor = codeOwnedDescriptorBinding(bindingDescriptor, proof, index);
    const boundProof = boundSourceExposureProofSha256Hex(
      proof,
      exposure.location,
      expected,
      bindingDescriptor,
    );
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
        orderedSourceDescriptor,
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
  const latestBindingByMarker = new Map<string, ProviderRequestSourceExposureProofBinding>();
  for (const binding of bindings) {
    const markerKey = providerSourceExposureMarkerKey(binding.marker);
    const previous = latestBindingByMarker.get(markerKey);
    if (previous === undefined || binding.binding.sourceOrdinal > previous.binding.sourceOrdinal) {
      latestBindingByMarker.set(markerKey, binding);
    }
  }
  const selectedBindings = [...latestBindingByMarker.values()].sort((left, right) =>
    left.providerSerializationProofSha256Hex.localeCompare(
      right.providerSerializationProofSha256Hex,
    ),
  );
  const proofs = selectedBindings
    .map((binding) => binding.providerSerializationProofSha256Hex)
    .sort();
  return {
    proofs,
    bindings: selectedBindings,
  };
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
