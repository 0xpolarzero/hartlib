import { createHash } from "node:crypto";

import {
  isCanonicalPublicDocumentSourceId,
  isCanonicalPublisherDocumentSourceId,
  type AiProviderEndpointIdentity,
  type AiProviderServiceId,
  type PublicContextConsumer,
} from "@hartlib/shared";
import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import { z } from "zod";

import type { WorkerConfig } from "../../config";
import {
  CompactionGroupPrompt,
  ReadSourcePassagesArgumentsSchema,
  SearchSourcePassagesArgumentsSchema,
  SourceCompactionToolDefinitions,
  buildInitialCompactionRequest,
  buildGroupCompactionRequest,
  buildFallbackCompactionRequest,
  PlanTurnPrompt,
  DirectAnswerPrompt,
  InternalQueryPlanPrompt,
  InternalQueryReviewPrompt,
  MemoryExtractorPrompt,
  MemorySelectorPrompt,
  SynthesisPrompt,
  TopicAnswerPrompt,
  WebResearchPrompt,
} from "../prompts";
import {
  buildCandidatePassageIndex,
  createCompactionGroups as createPureCompactionGroups,
  createFallbackCompactionGroups as createPureFallbackCompactionGroups,
  mergeGroupCompactionResults,
  mergeCompactionSelections,
  validateFallbackContextManifest,
  validateFallbackGroupCompactionResult,
  validateGroupResultEnvelope,
  CompactionContractError,
  validateInitialContextManifest,
  type CompactionGroup,
  type CompactionSelection,
  type FallbackContextManifest,
  type GroupCompactionResult,
  type GroupResultEnvelope,
  type InitialContextManifest,
  type RenderedGroupSource,
  GroupCompactionResultSchema,
  GroupResultEnvelopeSchema,
} from "../context/compaction";
import type { CompactionPassResult } from "../context/compaction-runtime";
import {
  compactionGroupTaskId,
  MAX_COMPACTION_CONCURRENCY,
  type CompactionPhase,
  type ExactContextMeasurement,
  type NormalCompactionRequest,
  type SourceToolCompactionRequest,
} from "../context/compaction-runtime";
import { ProviderSemaphore } from "../runtime/provider-semaphore";
import {
  DEFAULT_SOURCE_COMPACTION_TOOL_BOUNDS,
  type CompactionProviderPayload,
} from "../context/compaction-provider";
import {
  mapPassageIdsToRanges,
  selectedTextFromRanges,
  toProviderPassageView,
  type PassageIndexOptions,
  type PassageView,
} from "../context/passages";
import {
  appendAiRunEvent,
  appendAiRunEventInTransaction,
  finalizeAiRun,
  insertAiObservation,
  insertAiSourceExposure,
  runAiProductState,
} from "../product-state/repository";
import type { AiDocumentExposureReconstruction } from "../product-state/observability";
import {
  executeInternalQueryPlan,
  makeRetrievalExecutionContext,
  type HydrationOptions,
  type RetrievalPreviewExposure,
  type RetrievalPlanResult,
  type HydratedReviewValue,
  type RetrievalExecutionContext,
} from "../retrieval/retrieval";
import { normalizeAndCaseFold } from "../retrieval/exact-text";
import {
  canonicalizeWebUrl,
  chatMessageEvidenceIdentity,
  compareSourceKeys,
  compareRankedCandidates,
  namespacedDocumentEvidenceIdentity,
  memoryEvidenceIdentity,
  normalizeCharacterRanges,
  normalizeWebQuote,
  memoryExtractionSha256Hex,
  sha256Base64Url,
  sourceKeyForNamespace,
  stripHistoricalCitationTags,
  webEvidenceIdentity,
  webQuoteHash,
  type SelectorDomain,
  type TopicId,
} from "../runtime/canonicalization";
import { CanonicalAgentClient, toolResultJson, zodValidator } from "../runtime/agent-client";
import {
  AiRuntimeError,
  aiRuntimeDiagnosticMessage,
  aiRuntimeFailureMetadata,
  isAiRuntimeError,
  isRetryableAiRunError,
  type AiRunErrorCode,
} from "../runtime/errors";
import { resolveRuntimeModel, type RuntimeModelId } from "../runtime/model-registry";
import type { AttestedPiBoundaryCoordinates, PiBoundaryCoordinates } from "../runtime/pi-boundary";
import {
  providerRequestSha256Hex,
  providerRequestSourceExposureProofBindings,
  providerVisibleSourceExposureCommitment,
  serializeExactAnswerRequest,
  serializeAnswerSource,
  stableJson,
  type CodeOwnedSourceExposureProof,
  type LiveProviderRequest,
  type ProviderRequest,
  type ProviderVisibleSourceExposureMarker,
  type ProviderVisibleSourceExposureProofBinding,
  type SourceExposureProof,
} from "../runtime/provider-request";
import { publicSourceRecordFromFinalSource } from "../runtime/public-source";
import { PublicProvenanceSchema } from "../runtime/source-schemas";
import {
  currentTaskAbortSignal,
  currentTaskRuntime,
  requireCurrentTaskCoordinates,
  throwIfAborted,
} from "../runtime/task-cancellation";
import type {
  AnswerCandidate,
  AnswerLaneResult,
  CandidateRejection,
  ConversationEntry,
  PlanTurnResult,
  EffectiveWebPolicy,
  FinalSourceRecord,
  Locale,
  Market,
  MemoryExtractionArtifact,
  MemoryReference,
  MemorySnapshot,
  SerializedSourceUse,
  TopicPacket,
  TopicPacketCandidate,
  WebEvidence,
} from "../runtime/types";
import {
  PlanTurnSchema,
  PlanTurnProviderSchema,
  validatePlanTurn,
  validateMemoryProposals,
  validateTopicPacket,
} from "../runtime/validators";
import { WebBoundaryError } from "../web/errors";
import { TINYFISH_SEARCH_DOMAIN_FILTER_HARD_MAX } from "../web/tinyfish-search";
import {
  CANDIDATE_CONTRACT_LIMITS,
  CandidateLedgerSchema,
  candidateLocalId,
  canonicalIdentityKey,
  decodeRunAcceptanceScope,
  reconstructTextFromRanges,
  type CandidateLedger,
  type CandidateLedgerEntry,
  type CanonicalIdentity,
  type LoadedTurn,
  type SourceRange,
} from "./types";
import {
  BranchCoverageSchema,
  InternalQueryPlanProviderSchema,
  InternalQueryPlanSchema,
  InternalQuerySchema as StructuredQuerySchema,
  QueryReviewProviderSchema,
  QueryReviewSchema,
  StructuredRetrievalTraceSchema,
  normalizeInternalQueryPlanProvider,
  normalizeQueryReviewProvider,
  type InternalQueryPlan,
  type InternalQueryValue,
  type InternalQueryPlanValue,
  type QueryReviewValue,
  type StructuredRetrievalTraceValue,
} from "../retrieval/query-spec";
import {
  ReviewModelFusedResultMetadataSchema,
  ReviewModelFusedResultSchema,
  type ReviewModelFusedResult,
} from "../retrieval/rank-fusion";
import type {
  AcceptedRetrievalScope,
  ResolvedAcceptedScope,
} from "../retrieval/compile-query-spec";

export type { LoadedTurn } from "./types";

const COMPACTION_PLANNER_TOTAL_PREVIEW_UTF8_BYTES = 64 * 1024;
const MAX_RETRIEVAL_TOOL_TURNS = 8;

export interface QueryReviewProviderInput {
  readonly question: string;
  readonly queries: readonly InternalQueryValue[];
  readonly results: readonly ReviewModelFusedResult[];
  readonly coverage: readonly z.infer<typeof BranchCoverageSchema>[];
  readonly truncation: {
    readonly branch: boolean;
    readonly candidates: boolean;
    readonly hydration: boolean;
  };
}

export interface QueryReviewExposure {
  readonly providerInput: QueryReviewProviderInput;
  /** Private proof envelope; never passed to the review provider. */
  readonly privateProof: readonly RetrievalPreviewExposure[];
}
const reviewResultMetadata = (
  result: ReviewModelFusedResult,
): z.infer<typeof ReviewModelFusedResultMetadataSchema> => {
  const { preview: _preview, ...metadata } = ReviewModelFusedResultSchema.parse(result);
  return ReviewModelFusedResultMetadataSchema.parse(metadata);
};

const proofFromReviewResult = (
  result: ReviewModelFusedResult,
  exposure: RetrievalPreviewExposure,
  index: number,
  countTextTokens: (text: string) => number,
): CodeOwnedSourceExposureProof => {
  const identity = exposure.identity;
  const sourceKind = identity.kind === "chat_message" ? "chat_message" : "document";
  if (result.kind !== sourceKind) {
    throw new Error("structured review result kind differs from its private proof");
  }
  const logicalSourceIdentity =
    identity.kind === "chat_message"
      ? chatMessageEvidenceIdentity(identity.messageId)
      : identity.kind === "public_document"
        ? namespacedDocumentEvidenceIdentity(
            {
              kind: "public",
              sourceId: identity.sourceId.startsWith("public:")
                ? identity.sourceId
                : `public:${identity.sourceId}`,
            },
            identity.documentId,
          )
        : namespacedDocumentEvidenceIdentity(
            {
              kind: "publisher",
              sourceId: identity.subscriptionId.startsWith("publisher:")
                ? identity.subscriptionId
                : `publisher:${identity.subscriptionId}`,
              issueId: identity.issueId,
              documentId: identity.documentId,
            },
            identity.documentId,
          );
  const contentItemIdentity =
    identity.kind === "chat_message"
      ? identity.messageId
      : `${logicalSourceIdentity}:${exposure.snapshotId}:${sha256Base64Url(JSON.stringify(exposure.previewRanges))}`;
  return codeOwnedExposureProof(
    {
      sourceKind,
      logicalSourceIdentity,
      contentItemIdentity,
      stage:
        identity.kind === "chat_message"
          ? "internal_chat_search_preview"
          : "internal_search_preview",
      visibleTokenCount: countTextTokens(result.preview),
      ...(identity.kind === "chat_message"
        ? {
            chatReconstruction: {
              messageId: identity.messageId,
              contentHash: exposure.contentHash,
              ranges: exposure.previewRanges,
            },
          }
        : {}),
    },
    result.preview,
    {
      messageIndex: 1,
      sourceOrdinal: index,
      serializedField: `messages[1].content.results[${index}].preview`,
    },
  );
};

export const STRUCTURED_RETRIEVAL_REVIEW_PREVIEW_KIND =
  "structured_retrieval_review_preview" as const;

const structuredRetrievalReviewPreviewPayload = (
  exposure: QueryReviewExposure,
  slot: "initial" | "replacement",
  coordinates: {
    readonly taskId: string;
    readonly loopIteration: number;
    readonly attempt: number;
    readonly providerRequestIndex: number;
    readonly providerRequestSha256Hex: string;
  },
) => ({
  taskId: coordinates.taskId,
  loopIteration: coordinates.loopIteration,
  attempt: coordinates.attempt,
  providerRequestIndex: coordinates.providerRequestIndex,
  agentRole: "internal_retrieval",
  slot,
  providerInputSha256Hex: coordinates.providerRequestSha256Hex,
  results: exposure.providerInput.results.map(reviewResultMetadata),
  coverage: exposure.providerInput.coverage,
  truncation: exposure.providerInput.truncation,
  records: exposure.privateProof.map((proof) => {
    const record = {
      identity: proof.identity,
      snapshotId: proof.snapshotId,
      contentHash: proof.contentHash,
      ...(proof.publisherExtractionId === undefined
        ? {}
        : { publisherExtractionId: proof.publisherExtractionId }),
      previewRanges: proof.previewRanges,
      previewByteLength: proof.previewBytes.byteLength,
      previewSha256Hex: createHash("sha256").update(proof.previewBytes).digest("hex"),
      fastTokenCount: proof.fastTokenCount,
      mainTokenCount: proof.mainTokenCount,
    };
    return {
      ...record,
      recordDigestSha256Hex: createHash("sha256").update(stableJson(record)).digest("hex"),
    };
  }),
});

export const QueryReviewProviderInputSchema = z.strictObject({
  question: z.string().min(1),
  queries: z.array(StructuredQuerySchema).min(1),
  results: z.array(ReviewModelFusedResultSchema),
  coverage: z.array(BranchCoverageSchema).min(1),
  truncation: z.strictObject({
    branch: z.boolean(),
    candidates: z.boolean(),
    hydration: z.boolean(),
  }),
});

export interface QueryReviewOperationInput<TResult> {
  readonly initialPlan: InternalQueryPlanValue;
  readonly initialResult: TResult;
  readonly reviewInput: QueryReviewProviderInput;
  readonly initialExposure?: QueryReviewExposure | undefined;
}

export interface QueryReviewOperationHandlers<TResult> {
  /** The fast-model call. Its input is the provider-safe review projection. */
  readonly review: (
    input: QueryReviewProviderInput,
    privateProof?: readonly RetrievalPreviewExposure[],
  ) => Promise<unknown> | unknown;
  /** Executes one complete code-owned plan. */
  readonly execute: (plan: InternalQueryPlanValue) => Promise<TResult> | TResult;
  /** Rebuilds the provider-safe projection for a retained replacement result. */
  readonly projectReview: (result: TResult, plan: InternalQueryPlanValue) => QueryReviewExposure;
  /** Private-sidecar hook that records exactly what the reviewer saw. */
  readonly onPreviewExposure: (exposure: QueryReviewExposure) => Promise<void> | void;
}

export type QueryReviewOperationResult<TResult> =
  | {
      readonly action: "accept";
      readonly review: Extract<QueryReviewValue, { readonly action: "accept" }>;
      readonly result: TResult;
      readonly replacementExecuted: false;
    }
  | {
      readonly action: "replace";
      readonly review: Extract<QueryReviewValue, { readonly action: "replace" }>;
      readonly result: TResult;
      readonly replacementExecuted: true;
    }
  | {
      readonly action: "no_evidence";
      readonly review: Extract<QueryReviewValue, { readonly action: "no_evidence" }>;
      readonly result: null;
      readonly replacementExecuted: false;
    };

/**
 * Run exactly one result-aware review.  A replacement is a complete new plan,
 * not a patch, and the initial result is never reused when replacement fails.
 */
export const runQueryReviewReplacement = async <TResult>(
  input: QueryReviewOperationInput<TResult>,
  handlers: QueryReviewOperationHandlers<TResult>,
): Promise<QueryReviewOperationResult<TResult>> => {
  const initialPlan = InternalQueryPlanSchema.parse(input.initialPlan);
  const initialReviewInput = QueryReviewProviderInputSchema.parse(
    input.reviewInput,
  ) as QueryReviewProviderInput;
  const initialExposure = input.initialExposure ?? {
    providerInput: initialReviewInput,
    privateProof: [],
  };
  await handlers.onPreviewExposure(initialExposure);
  const rawReview = await handlers.review(initialReviewInput, initialExposure.privateProof);
  const review = QueryReviewSchema.parse(rawReview);
  if (review.action === "accept") {
    return {
      action: "accept",
      review,
      result: input.initialResult,
      replacementExecuted: false,
    };
  }
  if (review.action === "no_evidence") {
    return { action: "no_evidence", review, result: null, replacementExecuted: false };
  }
  const replacementPlan = InternalQueryPlanSchema.parse({
    action: "search",
    queries: review.queries,
  }) as InternalQueryPlanValue;
  if (initialPlan.action === "search" && replacementPlan.action !== "search") {
    throw new Error("query replacement must contain a complete search array");
  }
  const replacementResult = await handlers.execute(replacementPlan);
  const replacementExposure = handlers.projectReview(replacementResult, replacementPlan);
  QueryReviewProviderInputSchema.parse(
    replacementExposure.providerInput,
  ) as QueryReviewProviderInput;
  await handlers.onPreviewExposure(replacementExposure);
  return {
    action: "replace",
    review,
    result: replacementResult,
    replacementExecuted: true,
  };
};

export type CanonicalAiConfig = Pick<
  WorkerConfig,
  | "aiMainModel"
  | "aiFastModel"
  | "aiMainInputMaxTokens"
  | "aiMainOutputMaxTokens"
  | "aiFastInputMaxTokens"
  | "aiFastOutputMaxTokens"
  | "aiConversationRecentTurns"
  | "aiFanoutMaxTopics"
  | "aiWebMaxSearches"
  | "aiWebMaxFetches"
  | "aiWebMaxDomainFilters"
  | "aiMemoryToolResultMaxItems"
  | "webResearchProvider"
> & {
  readonly [key: string]: unknown;
  readonly aiRetrievalMaxQueries?: number;
  readonly aiRetrievalMaxBranchRows?: number;
  readonly aiRetrievalMaxCandidates?: number;
  readonly aiRetrievalMaxHydratedBytes?: number;
  readonly aiRetrievalMaxConcurrency?: number;
  readonly aiRetrievalQueryTimeoutMs?: number;
  readonly providerServiceId?: AiProviderServiceId;
  readonly providerEndpointIdentity?: AiProviderEndpointIdentity;
};

export interface WebSearchResult {
  readonly url: string;
  readonly title: string;
  readonly domain: string;
  readonly snippet: string;
  readonly publishedAt?: string | undefined;
}

export interface WebFetchedPage {
  readonly url: string;
  readonly title: string;
  readonly domain: string;
  readonly text: string;
  readonly publishedAt?: string | undefined;
  readonly capturedAt: string;
}

/**
 * Keeps the provider-facing web result bounded while retaining exact excerpts
 * from both ends of a fetched page. Quotes remain valid only when they are
 * verbatim substrings of this bounded view; the external fetch accounting
 * continues to record the complete response bytes.
 */
export const boundedWebProviderText = (
  text: string,
  maxTokens: number,
  countTokens: (value: string) => number,
): string => {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || countTokens(text) <= maxTokens) {
    return text;
  }
  const budget = Math.max(1, maxTokens - 8);
  const prefixBudget = Math.max(1, Math.floor(budget / 2));
  const suffixBudget = Math.max(1, budget - prefixBudget);
  const prefixEnd = largestPrefixWithinTokenBudget(text, prefixBudget, countTokens);
  const suffixStart = smallestSuffixWithinTokenBudget(text, suffixBudget, countTokens);
  const prefix = text.slice(0, prefixEnd).trimEnd();
  const suffix = text.slice(suffixStart).trimStart();
  const combined = prefix === "" || suffix === "" ? `${prefix}${suffix}` : `${prefix}\n\n${suffix}`;
  if (countTokens(combined) <= maxTokens || suffix === "") return combined;
  let low = 0;
  let high = suffix.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    const candidate = suffix.slice(suffix.length - midpoint);
    if (countTokens(`${prefix}\n\n${candidate}`) <= maxTokens) low = midpoint;
    else high = midpoint - 1;
  }
  return low === 0 ? prefix : `${prefix}\n\n${suffix.slice(suffix.length - low)}`;
};

const webEvidenceMarkers =
  /\b(current|latest|official|public|web|online|today|recent|status|update|live|price|actual)\b|\b(actuel(?:le|s)?|dernier(?:e|s)?|officiel(?:le|s)?|public(?:s)?|marché|prix|récent(?:e|s)?|mise à jour|en ligne)\b/iu;

export const topicRequestsWebEvidence = (question: string): boolean =>
  webEvidenceMarkers.test(question.normalize("NFC"));

const largestPrefixWithinTokenBudget = (
  text: string,
  maxTokens: number,
  countTokens: (value: string) => number,
): number => {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (countTokens(text.slice(0, midpoint)) <= maxTokens) low = midpoint;
    else high = midpoint - 1;
  }
  return low;
};

const smallestSuffixWithinTokenBudget = (
  text: string,
  maxTokens: number,
  countTokens: (value: string) => number,
): number => {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const midpoint = Math.floor((low + high) / 2);
    if (countTokens(text.slice(midpoint)) <= maxTokens) high = midpoint;
    else low = midpoint + 1;
  }
  return low;
};

/** Safe transport boundary. The web module owns DNS, redirects, bytes, content type, and policy checks. */
export interface WebResearchBoundary {
  readonly search: (
    query: string,
    locale: Locale,
    market: Market,
    policy: EffectiveWebPolicy,
    coordinates: PiBoundaryCoordinates,
    cursor?: string | undefined,
    signal?: AbortSignal | undefined,
  ) => Promise<{
    readonly results: readonly WebSearchResult[];
    readonly complete: boolean;
    readonly truncated: boolean;
    readonly cursor: string | null;
    readonly scope: {
      readonly kind: "provider_ranked_results";
      readonly maximumResults: number;
      readonly cursorSupported: boolean;
    };
  }>;
  readonly fetch: (
    url: string,
    policy: EffectiveWebPolicy,
    coordinates: PiBoundaryCoordinates,
    signal?: AbortSignal | undefined,
  ) => Promise<WebFetchedPage>;
}

export interface SelectorBundle {
  /** The required code-owned Phase B result used by production assembly. */
  readonly structuredInternal: RetrievalPlanResult | null;
  readonly memories: readonly MemoryReference[];
  /** Selector status is retained at the workflow boundary so disabled B/W cannot masquerade as an enabled empty selection. */
  readonly memorySelection: "enabled" | "disabled";
  readonly web: readonly WebEvidence[];
  readonly webSelection: "enabled" | "disabled";
}

/** Stable, answer-visible gap emitted when a requested W path succeeds empty. */
export const WEB_EMPTY_RESULT_GAP = "web:no_supporting_evidence" as const;

export type MemorySelectorResult =
  | { readonly status: "disabled"; readonly reason: "memory_mode_disabled" }
  | { readonly status: "enabled"; readonly entries: readonly MemoryReference[] };

export type WebSelectorResult =
  | { readonly status: "disabled"; readonly reason: "not_requested" | "policy_disabled" }
  | { readonly status: "enabled"; readonly entries: readonly WebEvidence[] };

export interface ContextAssembly {
  readonly question: string;
  readonly topicId?: TopicId | undefined;
  readonly candidates: readonly AnswerCandidate[];
  /** One immutable, code-owned ledger for every selected evidence candidate. */
  readonly candidateLedger: CandidateLedger;
  readonly sourceMap: readonly FinalSourceRecord[];
  readonly selectedConversation: readonly ConversationEntry[];
  readonly gaps: readonly string[];
  readonly consumerTaskId: string;
  readonly requestedOutputTokens: number;
}

export interface ChatContextRange {
  readonly messageId: string;
  readonly ranges: readonly SourceRange[];
}

export interface ContextState {
  readonly status: "ready" | "needs_compaction" | "failed";
  readonly question: string;
  readonly topicId?: TopicId | undefined;
  readonly candidates: readonly AnswerCandidate[];
  /** The immutable cNNN ledger carried through measurement and fit selection. */
  readonly candidateLedger: CandidateLedger;
  readonly sourceMap: readonly FinalSourceRecord[];
  /** Merged topic citations retained outside the packet-only provider ledger. */
  readonly citationSourceMap?: readonly FinalSourceRecord[] | undefined;
  readonly ledgerCandidates: readonly AnswerCandidate[];
  readonly ledgerSourceMap: readonly FinalSourceRecord[];
  readonly selectedConversation: readonly ConversationEntry[];
  /** Sanitized UTF-16 ranges selected for chat evidence, kept private to answer serialization. */
  readonly chatSourceRanges?: readonly ChatContextRange[] | undefined;
  readonly ledgerConversation?: readonly ConversationEntry[] | undefined;
  readonly ledgerConversationTokenCounts?: readonly number[] | undefined;
  readonly consumers: readonly PublicContextConsumer[];
  readonly gaps: readonly string[];
  readonly ledgerGaps?: readonly string[] | undefined;
  readonly compactionFeedback: readonly string[];
  readonly request: LiveProviderRequest;
  readonly inputTokens: number;
  readonly usableInputTokens: number;
  readonly compactionRan: boolean;
  readonly failureCode?:
    | "context_mandatory_too_large"
    | "context_plan_unfit"
    | "context_budget_mismatch"
    | "synthesis_budget_mismatch"
    | undefined;
}

export interface FanoutAllocation {
  readonly packetOutputTokens: number;
  readonly synthesisUsableInput: number;
  readonly fixedSynthesisInput: number;
}

export interface FanoutSourceKeySet {
  readonly sources: ReadonlyArray<{
    readonly identityKey: string;
    readonly sourceKey: string;
  }>;
}

const documentCandidateIdentity = (candidate: {
  readonly sourceId: string;
  readonly documentId: string;
  readonly publisherIssueId?: string | undefined;
  readonly publisherDocumentId?: string | undefined;
}): string =>
  candidate.publisherIssueId === undefined && candidate.publisherDocumentId === undefined
    ? namespacedDocumentEvidenceIdentity(
        {
          kind: "public",
          sourceId: candidate.sourceId.startsWith("public:")
            ? candidate.sourceId
            : `public:${candidate.sourceId}`,
        },
        candidate.documentId,
      )
    : candidate.publisherIssueId !== undefined && candidate.publisherDocumentId !== undefined
      ? namespacedDocumentEvidenceIdentity(
          {
            kind: "publisher",
            sourceId: candidate.sourceId.startsWith("publisher:")
              ? candidate.sourceId
              : `publisher:${candidate.sourceId}`,
            issueId: candidate.publisherIssueId,
            documentId: candidate.publisherDocumentId,
          },
          candidate.documentId,
        )
      : (() => {
          throw new Error("document candidate has incomplete publisher provenance");
        })();

const documentContentItemIdentity = (
  namespace: string,
  snapshotId: string,
  content: string,
): string => `${namespace}:${snapshotId}:${content}`;

const providerVisibleExposureMarker = (exposure: {
  readonly sourceKind: "document" | "chat_message" | "memory" | "web";
  readonly logicalSourceIdentity: string;
  readonly contentItemIdentity: string;
  readonly stage: string;
  readonly visibleTokenCount: number;
  readonly chatReconstruction?: CodeOwnedSourceExposureProof["chatReconstruction"];
}) => ({
  sourceKind: exposure.sourceKind,
  logicalSourceIdentity: exposure.logicalSourceIdentity,
  contentItemIdentity: exposure.contentItemIdentity,
  exposureStage: exposure.stage,
  visibleTokenCount: exposure.visibleTokenCount,
});

const codeOwnedExposureProof = (
  exposure: Parameters<typeof providerVisibleExposureMarker>[0],
  visibleText: string,
  binding?: Pick<
    CodeOwnedSourceExposureProof,
    "messageIndex" | "sourceOrdinal" | "serializedField" | "orderedSourceDescriptor"
  >,
): CodeOwnedSourceExposureProof => ({
  ...providerVisibleExposureMarker(exposure),
  visibleText,
  ...(exposure.chatReconstruction === undefined
    ? {}
    : { chatReconstruction: exposure.chatReconstruction }),
  ...(binding === undefined ? {} : binding),
});

export const normalizeSelectedDocumentRanges = (
  ranges: readonly { readonly charStart: number; readonly charEnd: number }[] | undefined,
  textLength: number,
): readonly { readonly charStart: number; readonly charEnd: number }[] =>
  normalizeCharacterRanges(
    ranges === undefined || ranges.length === 0 ? [{ charStart: 0, charEnd: textLength }] : ranges,
    textLength,
  );

export const answerStartedEmissionKey = (taskId: string, answerAttempt: number): string =>
  `answer_started:${taskId}:${answerAttempt}`;

export const answerDeltaEmissionKey = (
  taskId: string,
  answerAttempt: number,
  deltaIndex: number,
): string => `text_delta:${taskId}:${answerAttempt}:${deltaIndex}`;

interface LoadRow {
  readonly aiRunId: string;
  readonly chatId: string;
  readonly companyId: string;
  readonly initiatingUserId: string;
  readonly userMessageId: string;
  readonly userMessage: string;
  readonly locale: Locale;
  readonly market: Market;
  readonly currentTimestamp: string;
  readonly citationNamespace: string;
  readonly acceptanceScope: unknown;
}

interface ConversationRow {
  readonly turnId: string;
  readonly userMessageId: string;
  readonly userContent: string;
  readonly assistantMessageId: string | null;
  readonly assistantContent: string | null;
  readonly errorCode: string | null;
  readonly retryable: boolean | null;
  readonly totalCount: number;
}

const MemoryReferenceSchema = z
  .object({ memoryId: z.string(), memoryRevisionId: z.string() })
  .strict();
const WebEvidenceSchema = z
  .object({
    url: z.string().url(),
    title: z.string(),
    domain: z.string(),
    quote: z.string().trim().min(1),
    publishedAt: z.string().optional(),
    capturedAt: z.string(),
    purpose: z.string().trim().min(1),
  })
  .strict();
const MemoryProposalSchema = z
  .object({
    kind: z.enum(["profile", "preference", "instruction", "fact", "episode"]),
    content: z.string(),
    targetMemoryId: z.string().optional(),
  })
  .strict();
const TopicPacketSchema = z
  .object({
    topicId: z.enum(["t1", "t2", "t3"]),
    status: z.enum(["answered", "partial"]),
    claims: z.array(z.object({ text: z.string(), sourceKeys: z.array(z.string()) }).strict()),
    gaps: z.array(z.string()),
  })
  .strict();
const MemoryProposalOutputSchema = z.object({ proposals: z.array(MemoryProposalSchema) }).strict();
const MemoryManifestOutputSchema = z.object({ entries: z.array(MemoryReferenceSchema) }).strict();
const WebManifestOutputSchema = z.object({ entries: z.array(WebEvidenceSchema) }).strict();

/** Provider-authored value contracts; exported for exhaustive boundary tests. */
export const canonicalProviderValueSchemas = {
  planTurn: PlanTurnSchema,
  planTurnProvider: PlanTurnProviderSchema,
  memoryReference: MemoryReferenceSchema,
  webEvidence: WebEvidenceSchema,
  memoryProposal: MemoryProposalSchema,
  topicPacket: TopicPacketSchema,
  memoryProposalOutput: MemoryProposalOutputSchema,
  memoryManifestOutput: MemoryManifestOutputSchema,
  webManifestOutput: WebManifestOutputSchema,
} as const;

const taskCoordinates = (
  taskId: string,
  role: string,
  coordinates: { readonly loopIteration: number; readonly attempt: number },
) => ({
  taskId,
  ...coordinates,
  providerRequestIndex: 0,
  agentRole: role,
});

const ownedExecutionCoordinates = (
  taskId: string,
  _coordinates?: { readonly loopIteration: number; readonly attempt: number },
) => {
  const runtime = currentTaskRuntime();
  if (runtime === undefined) throw new Error(`Smithers task runtime is required for ${taskId}`);
  return {
    taskId: runtime.taskId,
    loopIteration: runtime.loopIteration,
    attempt: runtime.attempt,
  };
};

const ownedProviderExecutionCoordinates = (
  taskId: string,
  coordinates: {
    readonly loopIteration: number;
    readonly attempt: number;
    readonly providerRequestIndex: number;
  },
) => ({
  ...ownedExecutionCoordinates(taskId, coordinates),
  providerRequestIndex: coordinates.providerRequestIndex,
});

const fullRequestInput = (
  system: string,
  user: string,
  model: LiveProviderRequest["model"],
  outputTokens: number,
): LiveProviderRequest =>
  serializeExactAnswerRequest({
    model,
    system,
    user,
    requestedOutputTokens: outputTokens,
    reasoning: "medium",
  });

const structuredRequestInput = (
  system: string,
  user: string,
  model: LiveProviderRequest["model"],
  outputTokens: number,
  toolName: string,
  toolDescription: string,
  parameters: Readonly<Record<string, unknown>>,
): LiveProviderRequest =>
  serializeExactAnswerRequest({
    model,
    system,
    user,
    outputTool: { name: toolName, description: toolDescription, parameters },
    requestedOutputTokens: outputTokens,
    reasoning: "medium",
  });

const sourceText = (sourceKey: string, kind: string, label: string | null, text: string): string =>
  serializeAnswerSource({ key: sourceKey, kind, label, text });

const candidateText = (candidate: AnswerCandidate, chatRanges?: readonly SourceRange[]): string => {
  if (candidate.kind === "web") return candidate.quote;
  if (candidate.kind === "chat_message") {
    return chatRanges === undefined
      ? candidate.text
      : selectedTextFromRanges(candidate.text, chatRanges);
  }
  if (candidate.kind !== "document") return candidate.text;
  return candidate.ranges
    .map((range) => candidate.text.slice(range.charStart, range.charEnd))
    .join("\n…\n");
};
const ledgerChatMessageId = (candidate: CandidateLedgerEntry): string => {
  if (candidate.kind !== "chat_message" || candidate.identity.kind !== "chat_message") {
    throw new Error("chat candidate lacks its canonical message identity");
  }
  return candidate.identity.messageId;
};

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)]),
  );
};

const requestSha256Hex = providerRequestSha256Hex;

export const assertMeasuredAnswerRequest = (
  measured: ProviderRequest,
  sent: ProviderRequest,
): void => {
  const withoutProofs = (request: ProviderRequest): ProviderRequest => {
    const { sourceExposureProofs: _sourceExposureProofs, ...rest } = request;
    return rest;
  };
  if (requestSha256Hex(withoutProofs(measured)) !== requestSha256Hex(withoutProofs(sent))) {
    throw controlledRuntimeFailure("context_budget_mismatch");
  }
};

const topicPacketSchemaMinimumOutputTokens = (modelId: string): number =>
  resolveRuntimeModel(modelId).countTextTokens(
    JSON.stringify({ topicId: "t1", status: "partial", claims: [], gaps: ["gap"] }),
  );

const controlledRuntimeFailure = (code: AiRunErrorCode): AiRuntimeError =>
  new AiRuntimeError(code, code, { taskRetryable: false });

const immutableSourceIdentity = (source: FinalSourceRecord): string => {
  const locator = source.locator;
  const identity =
    locator.kind === "document"
      ? {
          kind: locator.kind,
          sourceId: locator.sourceId,
          documentId: locator.documentId,
          snapshotId: locator.snapshotId,
          contentHash: locator.contentHash,
          publisherExtractionId: locator.publisherExtractionId,
          publisherIssueId: locator.publisherIssueId,
          publisherDocumentId: locator.publisherDocumentId,
        }
      : locator.kind === "web"
        ? { kind: locator.kind, url: locator.url, quoteHash: locator.quoteHash }
        : locator;
  return JSON.stringify(
    locator.kind === "web"
      ? { identity }
      : { identity, label: source.label, provenance: source.publicProvenance },
  );
};

const providerConversationEntries = (
  entries: readonly ConversationEntry[],
): readonly Readonly<Record<string, string | boolean>>[] =>
  entries.map((entry): Readonly<Record<string, string | boolean>> => {
    if ("assistantMessageId" in entry) {
      return { userContent: entry.userContent, assistantContent: entry.assistantContent };
    }
    return {
      userContent: entry.userContent,
      errorCode: entry.errorCode,
      retryable: entry.retryable,
    };
  });

const compactionLogicalSourceIdentity = (identity: CandidateLedgerEntry["identity"]): string => {
  switch (identity.kind) {
    case "public_document":
      return namespacedDocumentEvidenceIdentity(
        {
          kind: "public",
          sourceId: identity.sourceId.startsWith("public:")
            ? identity.sourceId
            : `public:${identity.sourceId}`,
        },
        identity.documentId,
      );
    case "publisher_document":
      return namespacedDocumentEvidenceIdentity(
        {
          kind: "publisher",
          sourceId: identity.subscriptionId.startsWith("publisher:")
            ? identity.subscriptionId
            : `publisher:${identity.subscriptionId}`,
          issueId: identity.issueId,
          documentId: identity.documentId,
        },
        identity.documentId,
      );
    case "chat_message":
      return chatMessageEvidenceIdentity(identity.messageId);
    case "conversation_entry":
      return chatMessageEvidenceIdentity(identity.userMessageId);
    case "memory":
      return memoryEvidenceIdentity(identity.memoryId);
    case "web":
      return `web:${canonicalizeWebUrl(identity.canonicalUrl)}:${identity.quoteHash}`;
    case "topic_packet":
      throw new Error("topic packets do not have a citable source identity");
  }
};

const compactionContentItemIdentity = (
  identity: CandidateLedgerEntry["identity"],
  logicalSourceIdentity: string,
  visibleText: string,
  rangeDescriptor: unknown,
): string => {
  const documentRanges = Array.isArray(rangeDescriptor)
    ? rangeDescriptor
    : typeof rangeDescriptor === "object" &&
        rangeDescriptor !== null &&
        "range" in rangeDescriptor &&
        typeof rangeDescriptor.range === "object" &&
        rangeDescriptor.range !== null
      ? [rangeDescriptor.range]
      : typeof rangeDescriptor === "object" &&
          rangeDescriptor !== null &&
          "previewRanges" in rangeDescriptor &&
          Array.isArray(rangeDescriptor.previewRanges)
        ? rangeDescriptor.previewRanges
        : undefined;
  switch (identity.kind) {
    case "public_document":
    case "publisher_document":
      return `${logicalSourceIdentity}:${identity.snapshotId}:${sha256Base64Url(
        documentRanges === undefined ? stableJson(rangeDescriptor) : JSON.stringify(documentRanges),
      )}`;
    case "chat_message":
      return identity.messageId;
    case "conversation_entry":
      return identity.userMessageId;
    case "memory":
      return identity.memoryRevisionId;
    case "web":
      return `${canonicalizeWebUrl(identity.canonicalUrl)}:${identity.quoteHash}`;
    case "topic_packet":
      throw new Error("topic packets do not have a citable content identity");
  }
};
export class CanonicalWorkflowOperations {
  constructor(
    private readonly connectionString: string,
    private readonly config: CanonicalAiConfig,
    private readonly agents: CanonicalAgentClient,
    private readonly web?: WebResearchBoundary | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private readonly compactionRunSemaphores = new Map<string, ProviderSemaphore>();

  private async withCompactionRunPermit<A>(
    aiRunId: string,
    operation: () => Promise<A>,
  ): Promise<A> {
    let semaphore = this.compactionRunSemaphores.get(aiRunId);
    if (semaphore === undefined) {
      semaphore = new ProviderSemaphore(MAX_COMPACTION_CONCURRENCY);
      this.compactionRunSemaphores.set(aiRunId, semaphore);
    }
    try {
      return await semaphore.withPermit(operation, currentTaskAbortSignal());
    } finally {
      const snapshot = semaphore.snapshot();
      if (
        snapshot.active === 0 &&
        snapshot.queued === 0 &&
        this.compactionRunSemaphores.get(aiRunId) === semaphore
      ) {
        this.compactionRunSemaphores.delete(aiRunId);
      }
    }
  }
  private readonly compactionRepairTaskIds = new Set<string>();
  private db<A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> {
    return this.dbWithSignal(effect, currentTaskAbortSignal());
  }

  private dbWithSignal<A, E>(
    effect: Effect.Effect<A, E, PgClient.PgClient>,
    signal?: AbortSignal,
  ): Promise<A> {
    return runAiProductState(
      this.connectionString,
      effect,
      signal === undefined ? undefined : { signal },
    );
  }

  private observe(
    load: Pick<LoadedTurn, "aiRunId" | "chatId">,
    taskId: string,
    kind: string,
    payload: Readonly<Record<string, unknown>>,
    coordinates?: { readonly loopIteration: number; readonly attempt: number },
    slot = "result",
  ): Promise<void> {
    const execution = ownedExecutionCoordinates(taskId, coordinates);
    return this.db(
      insertAiObservation({
        runId: load.aiRunId,
        chatId: load.chatId,
        emittingTask: execution.taskId,
        loopIteration: execution.loopIteration,
        attempt: execution.attempt,
        observationKey: [
          execution.taskId,
          execution.loopIteration,
          execution.attempt,
          kind,
          slot,
        ].join(":"),
        kind,
        payload,
      }),
    ).then(() => undefined);
  }

  private async persistStructuredRetrievalReviewPreview(
    load: LoadedTurn,
    exposure: QueryReviewExposure,
    slot: "initial" | "replacement",
    coordinates: {
      readonly taskId: string;
      readonly loopIteration: number;
      readonly attempt: number;
      readonly providerRequestIndex: number;
      readonly providerRequestSha256Hex: string;
    },
  ): Promise<void> {
    await this.observe(
      load,
      coordinates.taskId,
      STRUCTURED_RETRIEVAL_REVIEW_PREVIEW_KIND,
      structuredRetrievalReviewPreviewPayload(exposure, slot, coordinates),
      { loopIteration: coordinates.loopIteration, attempt: coordinates.attempt },
      slot,
    );
  }

  private restrictedContextLedger(
    state: ContextState,
    requestKind: "direct" | "topic" | "synthesis",
    request: ProviderRequest = state.request,
  ) {
    const model = resolveRuntimeModel(request.model);
    const selectedConversation = state.selectedConversation.map((entry) =>
      "assistantMessageId" in entry
        ? {
            kind: "complete" as const,
            turnId: entry.turnId,
            userMessageId: entry.userMessageId,
            assistantMessageId: entry.assistantMessageId,
          }
        : {
            kind: "failed" as const,
            turnId: entry.turnId,
            userMessageId: entry.userMessageId,
            errorCode: entry.errorCode,
            retryable: entry.retryable,
          },
    );
    const common = {
      requestKind,
      modelId: request.model,
      requestSha256Hex: requestSha256Hex(request),
      inputTokens: model.countRequestTokens(request),
      usableInputTokens: Math.min(
        this.config.aiMainInputMaxTokens,
        model.contextWindow - request.requestedOutputTokens,
      ),
      requestedOutputTokens: request.requestedOutputTokens,
      selectedConversation,
    };
    if (requestKind === "synthesis") {
      const userMessage = request.messages.find((message) => message.role === "user");
      if (userMessage === undefined) throw new Error("synthesis request lacks its user input");
      const parsed = z
        .object({ packets: z.array(TopicPacketSchema) })
        .passthrough()
        .parse(JSON.parse(userMessage.content) as unknown);
      return {
        ...common,
        requestKind,
        packets: parsed.packets.map((packet) => ({
          topicId: packet.topicId,
          status: packet.status,
          claimCount: packet.claims.length,
          gapCount: packet.gaps.length,
          packetSha256Hex: createHash("sha256")
            .update(JSON.stringify(canonicalValue(packet)))
            .digest("hex"),
        })),
      };
    }
    if (state.candidates.length !== state.sourceMap.length) {
      throw new Error("restricted context ledger source cardinality mismatch");
    }
    return {
      ...common,
      requestKind,
      question: state.question,
      ...(state.topicId === undefined ? {} : { topicId: state.topicId }),
      gaps: state.gaps,
      sources: state.candidates.map((candidate, index) => {
        const source = state.sourceMap[index];
        if (source === undefined || source.locator.kind !== candidate.kind) {
          throw new Error("restricted context ledger candidate/source mismatch");
        }
        const canonicalCandidateId =
          source.locator.kind === "document"
            ? documentCandidateIdentity({
                sourceId: source.locator.sourceId,
                documentId: source.locator.documentId,
                ...(source.locator.publisherIssueId === undefined
                  ? {}
                  : {
                      publisherIssueId: source.locator.publisherIssueId,
                      publisherDocumentId: source.locator.publisherDocumentId,
                    }),
              })
            : source.locator.kind === "chat_message"
              ? chatMessageEvidenceIdentity(source.locator.messageId)
              : source.locator.kind === "memory"
                ? memoryEvidenceIdentity(source.locator.memoryId)
                : webEvidenceIdentity(source.locator.url, source.locator.quote);
        return {
          candidateId: canonicalCandidateId,
          sourceKey: source.sourceKey,
          kind: candidate.kind,
          purpose: candidate.purpose,
          label: source.label,
          ranges: candidate.kind === "document" ? candidate.ranges : [],
        };
      }),
    };
  }

  private contextMeasurementPayload(
    state: ContextState,
    consumerTaskId: string,
    requestKind: "direct" | "topic" | "synthesis" = state.citationSourceMap !== undefined
      ? "synthesis"
      : state.topicId === undefined
        ? "direct"
        : "topic",
    request: ProviderRequest = state.request,
  ) {
    const model = resolveRuntimeModel(request.model);
    const messages = request.messages.map((message) => {
      if (message.role !== "user") return message;
      try {
        const parsed = JSON.parse(message.content) as Record<string, unknown>;
        if (requestKind === "synthesis" && Array.isArray(parsed.packets)) {
          return {
            ...message,
            content: JSON.stringify({ ...parsed, selectedConversation: [], packets: [] }),
          };
        }
        if (!("evidence" in parsed)) return message;
        return {
          ...message,
          content: JSON.stringify({ ...parsed, selectedConversation: [], evidence: "" }),
        };
      } catch {
        return message;
      }
    });
    const mandatoryInputTokens = model.countRequestTokens({ ...request, messages });
    const discretionaryInputTokens = state.inputTokens - mandatoryInputTokens;
    if (discretionaryInputTokens < 0) {
      throw new Error("context token accounting is inconsistent");
    }
    return {
      consumerTaskId,
      ...(state.topicId === undefined ? {} : { topicId: state.topicId }),
      mandatoryInputTokens,
      discretionaryInputTokens,
      totalInputTokens: state.inputTokens,
      requestedOutputTokens: state.request.requestedOutputTokens,
      usableInputTokens: state.usableInputTokens,
      contextWindow: model.contextWindow,
      status: state.status,
      compactionRan: state.compactionRan,
      compactionFeedback: state.compactionFeedback,
      restrictedContextLedger: this.restrictedContextLedger(state, requestKind, request),
    };
  }

  private async savedScopeSourceIds(load: LoadedTurn): Promise<readonly string[]> {
    return [
      ...load.acceptanceScope.publicSourceIds.map((sourceId) => `public:${sourceId}`),
      ...load.acceptanceScope.subscriptionIds.map(
        (subscriptionId) => `publisher:${subscriptionId}`,
      ),
    ].sort();
  }

  /** Resolve A's source-name filters inside the accepted scope only. */
  async resolveAcceptedRetrievalScope(
    load: LoadedTurn,
    sourceNames: readonly string[] | undefined,
    excludedMessageIds: readonly string[] = [],
  ): Promise<ResolvedAcceptedScope> {
    const scope: AcceptedRetrievalScope = {
      userId: load.initiatingUserId,
      chatId: load.chatId,
      companyId: load.acceptanceScope.companyId,
      publicSourceIds: load.acceptanceScope.publicSourceIds,
      subscriptionIds: load.acceptanceScope.subscriptionIds,
      accessIds: load.acceptanceScope.accessIds,
      excludedMessageIds,
      currentMessageId: load.userMessageId,
    };
    if (sourceNames === undefined || sourceNames.length === 0) {
      return {
        ...scope,
        acceptedSourceIds: await this.savedScopeSourceIds(load),
      };
    }
    const resolved = await Promise.all(
      sourceNames.map((name) => this.resolveAuthorizedSourceIds(load, name, "subscription")),
    );
    return {
      ...scope,
      acceptedSourceIds: [...new Set(resolved.flat())].sort(),
    };
  }

  /** Canonical Phase B operation: resolve each query's names, then execute its bounded plan. */
  async executeStructuredRetrieval(
    load: LoadedTurn,
    plan: InternalQueryPlanValue,
    excludedMessageIds: readonly string[] = [],
    executionContext?: RetrievalExecutionContext,
  ): Promise<RetrievalPlanResult> {
    const queries = plan.action === "search" ? plan.queries : [];
    const resolvedNames = new Map<string, readonly string[]>();
    for (const query of queries) {
      const names = query.targets.find((target) => target.kind === "documents")?.filters
        .sourceNames;
      if (names === undefined || names.length === 0) continue;
      const resolved = await this.resolveAcceptedRetrievalScope(load, names, excludedMessageIds);
      resolvedNames.set(JSON.stringify(names), resolved.acceptedSourceIds);
    }
    const scope: AcceptedRetrievalScope = {
      userId: load.initiatingUserId,
      chatId: load.chatId,
      companyId: load.acceptanceScope.companyId,
      publicSourceIds: load.acceptanceScope.publicSourceIds,
      subscriptionIds: load.acceptanceScope.subscriptionIds,
      accessIds: load.acceptanceScope.accessIds,
      excludedMessageIds,
      currentMessageId: load.userMessageId,
    };
    const result = await this.db(
      executeInternalQueryPlan(plan as InternalQueryPlan, {
        scope,
        branchCap: this.config.aiRetrievalMaxBranchRows ?? 25,
        maxQueries: this.config.aiRetrievalMaxQueries ?? 24,
        maxCandidates: this.config.aiRetrievalMaxCandidates ?? 64,
        maxHydratedBytes: this.config.aiRetrievalMaxHydratedBytes ?? 2_000_000,
        maxConcurrency: this.config.aiRetrievalMaxConcurrency ?? 4,
        statementTimeoutMs: this.config.aiRetrievalQueryTimeoutMs ?? 30_000,
        executionContext,
        hydration: {
          fastModelId: load.acceptanceScope.fastModelId,
          mainModelId: load.acceptanceScope.mainModelId,
        } satisfies HydrationOptions,
        resolveSourceNames: (names) =>
          names === undefined || names.length === 0
            ? []
            : (resolvedNames.get(JSON.stringify(names)) ?? []),
      }),
    );
    return result;
  }

  /** Execute the initial plan, expose its exact review projection, and allow one replacement. */
  async reviewStructuredRetrieval(
    load: LoadedTurn,
    resolvedQuestion: string,
    plan: InternalQueryPlanValue,
    review: (
      input: QueryReviewProviderInput,
      privateProof?: readonly RetrievalPreviewExposure[],
    ) => Promise<unknown> | unknown,
    excludedMessageIds: readonly string[] = [],
    onPreviewExposure: (exposure: QueryReviewExposure) => Promise<void> | void,
  ): Promise<QueryReviewOperationResult<RetrievalPlanResult> | RetrievalPlanResult> {
    const question = z.string().min(1).parse(resolvedQuestion);
    const executionContext = makeRetrievalExecutionContext(
      this.config.aiRetrievalQueryTimeoutMs ?? 30_000,
      this.config.aiRetrievalMaxConcurrency ?? 4,
    );
    const initialResult = await this.executeStructuredRetrieval(
      load,
      plan,
      excludedMessageIds,
      executionContext,
    );
    if (plan.action === "skip") return initialResult;
    const initialExposure: QueryReviewExposure = {
      providerInput: {
        question,
        queries: plan.queries,
        results: initialResult.review,
        coverage: initialResult.fused.coverage,
        truncation: initialResult.fused.truncation,
      },
      privateProof: initialResult.previewExposures,
    };
    return runQueryReviewReplacement(
      {
        initialPlan: plan,
        initialResult,
        reviewInput: {
          question,
          queries: plan.queries,
          results: initialResult.review as unknown as readonly ReviewModelFusedResult[],
          coverage: initialResult.fused.coverage,
          truncation: initialResult.fused.truncation,
        },
        initialExposure,
      },
      {
        review,
        execute: (replacementPlan) =>
          this.executeStructuredRetrieval(
            load,
            replacementPlan,
            excludedMessageIds,
            executionContext,
          ),
        projectReview: (replacementResult, replacementPlan) => ({
          providerInput: {
            question,
            queries: replacementPlan.action === "search" ? replacementPlan.queries : [],
            results: replacementResult.review,
            coverage: replacementResult.fused.coverage,
            truncation: replacementResult.fused.truncation,
          },
          privateProof: replacementResult.previewExposures,
        }),
        onPreviewExposure: async (exposure) => {
          await onPreviewExposure(exposure);
        },
      },
    );
  }

  /** Produce and review one complete code-owned internal retrieval result. */
  async retrieveStructuredInternal(
    load: LoadedTurn,
    question: string,
    taskId: string,
    selectedTurnIds: readonly string[] = [],
  ): Promise<RetrievalPlanResult | null> {
    const planCoordinates = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    const recentConversation = await this.currentPriorTurns(load);
    const selectedTurnIdSet = new Set(selectedTurnIds);
    const selectedConversation = recentConversation.filter((entry) =>
      selectedTurnIdSet.has(entry.turnId),
    );
    const plan = (await this.agents.structured({
      requestClass: "fast",
      model: load.acceptanceScope.fastModelId,
      system: InternalQueryPlanPrompt,
      user: JSON.stringify({
        question,
        selectedConversation: providerConversationEntries(selectedConversation),
        locale: load.locale,
        market: load.market,
        currentTimestamp: load.currentTimestamp,
      }),
      outputToolName: "emit_internal_query_plan",
      outputToolDescription: "Emit one complete structured internal query plan.",
      outputSchema: z.toJSONSchema(InternalQueryPlanProviderSchema),
      validate: normalizeInternalQueryPlanProvider,
      requestedOutputTokens: Math.min(2048, this.config.aiFastOutputMaxTokens),
      reasoning: "medium",
      coordinates: taskCoordinates(taskId, "internal_retrieval", planCoordinates),
      sourceExposureProofs: this.conversationExposureProofMarkers(
        load,
        selectedConversation,
        false,
      ),
      onBeforeRequest: async (request, requestCoordinates) => {
        await this.validateSavedScope(load);
        await this.recordConversationExposures(
          load,
          taskId,
          selectedConversation,
          requestCoordinates,
          { includeCurrentUser: false, request },
        );
      },
    })) as InternalQueryPlanValue;

    const excludedMessageIds = selectedConversation.flatMap((entry) => [
      entry.userMessageId,
      ...("assistantMessageId" in entry ? [entry.assistantMessageId] : []),
    ]);
    let reviewProviderRequestIndex = 1;
    let previewSlot: "initial" | "replacement" = "initial";
    let pendingPreview:
      | { readonly exposure: QueryReviewExposure; readonly slot: "initial" | "replacement" }
      | undefined;
    const reviewed = await this.reviewStructuredRetrieval(
      load,
      question,
      plan,
      async (input, privateProof) => {
        const reviewCoordinates = await this.taskExecutionCoordinates(load.aiRunId, taskId);
        const proofs = privateProof ?? [];
        if (input.results.length !== proofs.length) {
          throw new Error("structured review proof cardinality mismatch");
        }
        const reviewProofs = input.results.map((result, index) =>
          proofFromReviewResult(
            result,
            proofs[index]!,
            index,
            resolveRuntimeModel(load.acceptanceScope.fastModelId).countTextTokens,
          ),
        );
        const previewForRequest = pendingPreview;
        pendingPreview = undefined;
        const review = await this.agents.structured({
          requestClass: "fast",
          model: load.acceptanceScope.fastModelId,
          system: InternalQueryReviewPrompt,
          user: JSON.stringify(input),
          outputToolName: "emit_internal_query_review",
          outputToolDescription: "Review the complete structured retrieval result.",
          outputSchema: z.toJSONSchema(QueryReviewProviderSchema),
          validate: normalizeQueryReviewProvider,
          requestedOutputTokens: Math.min(2048, this.config.aiFastOutputMaxTokens),
          reasoning: "medium",
          coordinates: {
            ...taskCoordinates(taskId, "internal_retrieval", reviewCoordinates),
            providerRequestIndex: reviewProviderRequestIndex++,
          },
          sourceExposureProofs: reviewProofs,
          onBeforeRequest: async (request, requestCoordinates) => {
            await this.validateSavedScope(load);
            if (previewForRequest === undefined) {
              throw new Error("structured retrieval review lacks its durable preview source");
            }
            await this.persistStructuredRetrievalReviewPreview(
              load,
              previewForRequest.exposure,
              previewForRequest.slot,
              {
                taskId,
                loopIteration: requestCoordinates.loopIteration,
                attempt: requestCoordinates.attempt,
                providerRequestIndex: requestCoordinates.providerRequestIndex,
                providerRequestSha256Hex: requestSha256Hex(request),
              },
            );
            await this.recordStructuredRetrievalExposures(
              load,
              taskId,
              proofs,
              request,
              requestCoordinates,
            );
          },
        });
        return review;
      },
      excludedMessageIds,
      async (exposure) => {
        const slot = previewSlot;
        previewSlot = "replacement";
        pendingPreview = { exposure, slot };
      },
    );
    const reviewedResult =
      reviewed === null || ("action" in reviewed && reviewed.action === "no_evidence")
        ? null
        : "result" in reviewed
          ? reviewed.result
          : reviewed;
    const traceCandidate: unknown =
      plan.action === "skip"
        ? {
            initialPlan: plan,
            review: null,
            replacementPlan: null,
            outcome: "skipped",
          }
        : reviewed !== null && "action" in reviewed && reviewed.action === "accept"
          ? {
              initialPlan: plan,
              review: reviewed.review,
              replacementPlan: null,
              outcome: "accepted",
            }
          : reviewed !== null && "action" in reviewed && reviewed.action === "replace"
            ? {
                initialPlan: plan,
                review: reviewed.review,
                replacementPlan: {
                  action: "search",
                  queries: reviewed.review.queries,
                },
                outcome: "replaced",
              }
            : reviewed !== null && "action" in reviewed && reviewed.action === "no_evidence"
              ? {
                  initialPlan: plan,
                  review: reviewed.review,
                  replacementPlan: null,
                  outcome: "no_evidence",
                }
              : (() => {
                  throw new Error(
                    "structured retrieval completed without a terminal review outcome",
                  );
                })();
    const structuredRetrievalTrace = StructuredRetrievalTraceSchema.parse(
      traceCandidate,
    ) as StructuredRetrievalTraceValue;
    await this.observe(
      load,
      taskId,
      "structured_retrieval_trace",
      structuredRetrievalTrace,
      await this.taskExecutionCoordinates(load.aiRunId, taskId),
    );

    const references =
      reviewedResult?.previewExposures.map((exposure, index) => {
        const identity = exposure.identity;
        const matchedQueryOrdinal = reviewedResult.review[index]?.matchedQueryOrdinals[0];
        const purpose =
          matchedQueryOrdinal === undefined
            ? question
            : reviewedResult.queryPlan.action === "search"
              ? (reviewedResult.queryPlan.queries[matchedQueryOrdinal - 1]?.purpose ?? question)
              : question;
        if (identity.kind === "chat_message") {
          return { kind: "chat_message" as const, messageId: identity.messageId, purpose };
        }
        const source =
          identity.kind === "public_document"
            ? {
                kind: "public" as const,
                sourceId: identity.sourceId.startsWith("public:")
                  ? identity.sourceId
                  : `public:${identity.sourceId}`,
              }
            : {
                kind: "publisher" as const,
                sourceId: identity.subscriptionId,
                issueId: identity.issueId,
                documentId: identity.documentId,
              };
        return {
          kind: "document" as const,
          documentId: identity.documentId,
          snapshotId: exposure.snapshotId,
          ...(exposure.publisherExtractionId === undefined
            ? {}
            : { publisherExtractionId: exposure.publisherExtractionId }),
          source,
          purpose,
        };
      }) ?? [];
    await this.observe(
      load,
      taskId,
      "retrieval_manifest",
      { selectorRole: "internal", references },
      await this.taskExecutionCoordinates(load.aiRunId, taskId),
    );
    return reviewedResult;
  }

  private async resolveAuthorizedSourceIds(
    load: LoadedTurn,
    namedSource: string | undefined,
    publisherName: "company" | "subscription" = "company",
  ): Promise<readonly string[]> {
    if (namedSource === undefined) return this.savedScopeSourceIds(load);
    const normalizedName = namedSource.trim().normalize("NFC").toLowerCase();
    if (normalizedName === "") return [];
    const rows = await this.db(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const publisherNamePredicate =
          publisherName === "subscription"
            ? sql`lower(btrim(subscriptions.name)) = ${normalizedName}`
            : sql`lower(btrim(companies.name)) = ${normalizedName}`;
        return yield* sql<{ readonly sourceId: string }>`
          select 'public:' || sources.source_id as "sourceId"
          from public_sources sources
          where sources.source_id = any(${load.acceptanceScope.publicSourceIds}::text[])
            and lower(btrim(sources.display_name)) = ${normalizedName}
          union
          select 'publisher:' || subscriptions.id::text as "sourceId"
          from publisher_subscriptions subscriptions
          join publisher_companies companies on companies.id = subscriptions.publisher_company_id
          where subscriptions.id::text = any(${load.acceptanceScope.subscriptionIds}::text[])
            and ${publisherNamePredicate}
        `;
      }),
    );
    return rows.map((row) => row.sourceId);
  }

  private async taskExecutionCoordinates(
    _runId: string,
    taskId: string,
  ): Promise<{ readonly loopIteration: number; readonly attempt: number }> {
    return requireCurrentTaskCoordinates(taskId);
  }
  private async compactionTaskEvidence(
    runId: string,
    taskId: string,
  ): Promise<{
    readonly semanticResponseConsumed: boolean;
    readonly repairConsumed: boolean;
  }> {
    const rows = await this.db(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{
          readonly semanticResponseConsumed: boolean;
          readonly repairConsumed: boolean;
        }>`
          select
            exists(
              select 1
              from ai_run_usage
              where run_id = ${runId}
                and task_id = ${taskId}
                and stop_reason <> 'error'
            ) as "semanticResponseConsumed",
            exists(
              select 1
              from ai_observations
              where run_id = ${runId}
                and emitting_task = ${taskId}
                and kind = 'provider_request_measurement'
                and coalesce((payload->>'repairConsumed')::boolean, false) = true
            ) as "repairConsumed"
        `;
      }),
    );
    return (
      rows[0] ?? {
        semanticResponseConsumed: false,
        repairConsumed: false,
      }
    );
  }
  private assertCompactionTaskNotConsumed(evidence: {
    readonly semanticResponseConsumed: boolean;
    readonly repairConsumed: boolean;
  }): void {
    if (evidence.semanticResponseConsumed) {
      throw new AiRuntimeError(
        "workflow_resume_incompatible",
        "compaction task already has a completed provider response",
        { retryable: false, taskRetryable: false },
      );
    }
  }

  private async acceptancePolicy(
    load: LoadedTurn,
  ): Promise<Extract<EffectiveWebPolicy, { readonly enabled: true }> | undefined> {
    if (!load.acceptanceScope.webEnabled) return;
    if (load.acceptanceScope.webTransportProvider !== "tinyfish") {
      throw new WebBoundaryError("unsupported_policy", "saved web provider is unavailable", false);
    }
    return {
      enabled: true,
      provider: load.acceptanceScope.webTransportProvider,
      allowedDomains:
        load.acceptanceScope.allowedDomains === null
          ? null
          : [...load.acceptanceScope.allowedDomains],
    };
  }

  private async validateSavedScope(
    load: LoadedTurn,
    sourceMap: readonly FinalSourceRecord[] = [],
  ): Promise<{
    readonly baseAllowed: boolean;
    readonly sourceAllowed: readonly boolean[];
    readonly webPolicyAllowed: boolean;
  }> {
    const scope = decodeRunAcceptanceScope(load.acceptanceScope);
    const sourceAllowed = sourceMap.map((source) => {
      if (source.locator.kind === "document") {
        const sourceId = source.locator.sourceId;
        return sourceId.startsWith("public:")
          ? scope.publicSourceIds.includes(sourceId.slice("public:".length))
          : sourceId.startsWith("publisher:")
            ? scope.subscriptionIds.includes(sourceId.slice("publisher:".length))
            : false;
      }
      if (source.locator.kind === "memory")
        return (
          scope.memoryMode === "private_owner" &&
          scope.memoryRevisionIds.includes(source.locator.memoryRevisionId)
        );
      if (source.locator.kind === "web") return scope.webEnabled;
      return true;
    });
    if (scope.userId !== load.initiatingUserId || scope.chatId !== load.chatId) {
      throw new Error("ai run acceptance scope identity mismatch");
    }
    // Account recovery, purge, and chat deletion remain exceptional runtime
    // restrictions. They are not source or policy reauthorization and do not
    // consult mutable grants, settings, or provider configuration.
    const tenantAvailable = await this.db(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly available: boolean }>`
          select exists(
            select 1
            from ai_runs runs
            join chats chat on chat.id = runs.chat_id
            join client_companies company on company.id = chat.company_id
            join platform_users users on users.id = runs.initiating_user_id
            where runs.id = ${load.aiRunId}
              and runs.initiating_user_id = ${load.initiatingUserId}
              and chat.deleted_at is null
              and company.id = ${scope.companyId}::uuid
              and company.recovery_deleted_at is null
              and company.purged_at is null
              and users.recovery_deleted_at is null
              and users.purged_at is null
          ) as available
        `;
        return rows[0]?.available === true;
      }),
    );
    if (!tenantAvailable) throw controlledRuntimeFailure("context_assembly_failed");
    return {
      baseAllowed: true,
      sourceAllowed,
      webPolicyAllowed: !scope.webRequested || scope.webEnabled,
    };
  }

  async loadTurn(aiRunId: string): Promise<LoadedTurn> {
    const agents = this.agents;
    const bindAcceptedProviderProfile = this.agents.bindAcceptedProviderProfile;
    return this.db(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<LoadRow>`
          select
            runs.id::text as "aiRunId",
            runs.chat_id::text as "chatId",
                chats.company_id::text as "companyId",
            runs.initiating_user_id as "initiatingUserId",
            runs.user_message_id::text as "userMessageId",
            messages.content as "userMessage",
            runs.locale,
            runs.market,
                to_char(
                  runs.created_at at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                ) as "currentTimestamp",
            runs.citation_namespace as "citationNamespace",
                runs.acceptance_scope as "acceptanceScope"
          from ai_runs runs
          join chats on chats.id = runs.chat_id and chats.deleted_at is null
          join chat_messages messages
            on messages.id = runs.user_message_id
           and messages.chat_id = chats.id
           and messages.author = 'user'
          join client_companies companies
            on companies.id = chats.company_id
           and companies.recovery_deleted_at is null
           and companies.purged_at is null
          where runs.id = ${aiRunId}
            and runs.finished_at is null
            and runs.failed_at is null
              for update of runs
        `;
            const run = rows[0];
            if (run === undefined) {
              return yield* Effect.fail(new Error(`ai run not found: ${aiRunId}`));
            }
            const acceptanceScope = decodeRunAcceptanceScope(run.acceptanceScope);
            if (
              acceptanceScope.userId !== run.initiatingUserId ||
              acceptanceScope.chatId !== run.chatId ||
              acceptanceScope.companyId !== run.companyId
            ) {
              return yield* Effect.fail(new Error("ai run acceptance scope identity mismatch"));
            }
            if (!/^cn_[A-Za-z0-9_-]{22}$/u.test(run.citationNamespace)) {
              return yield* Effect.fail(new Error("ai run citation namespace is invalid"));
            }
            bindAcceptedProviderProfile?.call(agents, {
              providerServiceId: acceptanceScope.provider,
              providerEndpointIdentity: acceptanceScope.providerEndpointIdentity,
              fastModelId: acceptanceScope.fastModelId,
              mainModelId: acceptanceScope.mainModelId,
            });
            yield* appendAiRunEventInTransaction({
              runId: aiRunId,
              emissionKey: "run_started",
              event: { type: "run_started" },
            });
            return {
              aiRunId: run.aiRunId,
              chatId: run.chatId,
              initiatingUserId: run.initiatingUserId,
              userMessageId: run.userMessageId,
              userMessage: run.userMessage,
              locale: run.locale,
              market: run.market,
              currentTimestamp: run.currentTimestamp,
              citationNamespace: run.citationNamespace,
              acceptanceScope,
            };
          }),
        );
      }),
    );
  }

  private boundConversationInventory(
    run: Pick<LoadRow, "userMessage" | "locale" | "market"> & {
      readonly currentTimestamp: string;
    },
    entries: readonly ConversationEntry[],
    modelId: RuntimeModelId,
  ): readonly ConversationEntry[] {
    const model = resolveRuntimeModel(modelId);
    const selected: ConversationEntry[] = [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      const candidate = [entry, ...selected];
      const request: LiveProviderRequest = {
        requestClass: "fast",
        model: modelId,
        messages: [
          { role: "system", content: PlanTurnPrompt },
          {
            role: "user",
            content: JSON.stringify({
              currentMessage: run.userMessage,
              entries: candidate,
              locale: run.locale,
              market: run.market,
              currentTimestamp: run.currentTimestamp,
            }),
          },
        ],
        tools: [
          {
            name: "emit_plan_turn",
            description: "Emit one strict plan-turn result.",
            parameters: z.toJSONSchema(PlanTurnProviderSchema),
          },
        ],
        toolChoice: "auto",
        requestedOutputTokens: Math.min(2048, this.config.aiFastOutputMaxTokens),
        reasoning: "medium",
      };
      const usableInput = Math.min(
        this.config.aiFastInputMaxTokens,
        model.contextWindow - request.requestedOutputTokens,
      );
      if (model.countRequestTokens(request) > usableInput) break;
      selected.unshift(entry);
    }
    return selected;
  }

  private async currentPriorTurns(load: LoadedTurn): Promise<readonly ConversationEntry[]> {
    const recentLimit = this.config.aiConversationRecentTurns;
    const rows = await this.db(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<ConversationRow>`
          with eligible as (
            select prior.id::text as "turnId",
                   prior.user_message_id::text as "userMessageId",
                   users.content as "userContent",
                   assistants.id::text as "assistantMessageId",
                   assistants.content as "assistantContent",
                   prior.error_code as "errorCode",
                   prior.retryable,
                   prior.created_at as "createdAt",
                   count(*) over ()::int as "totalCount"
            from ai_runs prior
            join chat_messages users on users.id = prior.user_message_id
            left join chat_messages assistants on assistants.id = prior.assistant_message_id
            where prior.chat_id = ${load.chatId}
              and prior.id <> ${load.aiRunId}
              and (prior.finished_at is not null or prior.failed_at is not null)
          )
          select "turnId", "userMessageId", "userContent", "assistantMessageId",
                 "assistantContent", "errorCode", retryable, "totalCount"
          from eligible
          order by "createdAt" desc, "turnId" desc
            limit ${recentLimit}
        `;
      }),
    );
    const entries = [...rows].reverse().map(
      (row): ConversationEntry =>
        row.assistantMessageId !== null && row.assistantContent !== null
          ? {
              turnId: row.turnId,
              userMessageId: row.userMessageId,
              userContent: row.userContent,
              assistantMessageId: row.assistantMessageId,
              assistantContent: stripHistoricalCitationTags(row.assistantContent),
            }
          : {
              turnId: row.turnId,
              userMessageId: row.userMessageId,
              userContent: row.userContent,
              errorCode: row.errorCode ?? "finalization_failed",
              retryable: row.retryable ?? false,
            },
    );
    return this.boundConversationInventory(
      {
        userMessage: load.userMessage,
        locale: load.locale,
        market: load.market,
        currentTimestamp: load.currentTimestamp,
      },
      entries,
      load.acceptanceScope.fastModelId,
    );
  }

  async planTurn(load: LoadedTurn): Promise<PlanTurnResult> {
    const taskId = "plan-turn";
    const execution = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    const coordinates = taskCoordinates(taskId, "plan_turn", execution);
    const conversation = await this.currentPriorTurns(load);
    const output = await this.agents.structured({
      requestClass: "fast",
      model: load.acceptanceScope.fastModelId,
      system: PlanTurnPrompt,
      user: JSON.stringify({
        currentMessage: load.userMessage,
        entries: conversation,
        locale: load.locale,
        market: load.market,
        currentTimestamp: load.currentTimestamp,
      }),
      outputToolName: "emit_plan_turn",
      outputToolDescription: "Emit exactly one strict plan-turn result.",
      outputSchema: z.toJSONSchema(PlanTurnProviderSchema),
      validate: (value) => PlanTurnSchema.parse(PlanTurnProviderSchema.parse(value)),
      requestedOutputTokens: Math.min(2048, this.config.aiFastOutputMaxTokens),
      reasoning: "medium",
      coordinates,
      sourceExposureProofs: this.conversationExposureProofMarkers(load, conversation, true),
      onBeforeRequest: async (request, requestCoordinates) => {
        await this.validateSavedScope(load);
        await this.recordConversationExposures(load, taskId, conversation, requestCoordinates, {
          request,
        });
      },
    });
    const result = validatePlanTurn(
      output,
      conversation.map((entry) => entry.turnId),
      this.config.aiFanoutMaxTopics,
    );
    await this.observe(load, taskId, "turn_plan", result, coordinates);
    return result;
  }

  private async loadAcceptedMemorySnapshots(load: LoadedTurn): Promise<readonly MemorySnapshot[]> {
    if (load.acceptanceScope.memoryMode === "disabled") return [];
    const revisionIds = load.acceptanceScope.memoryRevisionIds;
    const rows = await this.db(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{
          readonly memoryId: string;
          readonly memoryRevisionId: string;
          readonly stateAfter: unknown;
        }>`
          select memories.id::text as "memoryId",
                 revisions.id::text as "memoryRevisionId",
                 revisions.state_after as "stateAfter"
          from user_memory_revisions revisions
          join user_memories memories on memories.id = revisions.memory_id
          where memories.user_id = ${load.acceptanceScope.userId}
            and revisions.id::text = any(${revisionIds}::text[])
          order by revisions.id
        `;
      }),
    );
    if (rows.length !== revisionIds.length) {
      throw controlledRuntimeFailure("context_assembly_failed");
    }
    const snapshots = rows.map((row): MemorySnapshot => {
      const state = z
        .object({
          kind: z.enum(["profile", "preference", "instruction", "fact", "episode"]),
          content: z.string().trim().min(1),
          deleted: z.boolean(),
        })
        .strict()
        .safeParse(row.stateAfter);
      if (!state.success || state.data.deleted) {
        throw controlledRuntimeFailure("context_assembly_failed");
      }
      return {
        memoryId: row.memoryId,
        memoryRevisionId: row.memoryRevisionId,
        kind: state.data.kind,
        content: state.data.content,
      };
    });
    if (new Set(snapshots.map((memory) => memory.memoryRevisionId)).size !== revisionIds.length) {
      throw controlledRuntimeFailure("context_assembly_failed");
    }
    return snapshots;
  }

  async extractMemory(load: LoadedTurn): Promise<MemoryExtractionArtifact> {
    const taskId = "memory-extract";
    const execution = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    const coordinates = taskCoordinates(taskId, "memory_extractor", execution);
    const acceptedMemories = await this.loadAcceptedMemorySnapshots(load);
    const visibleMemories = new Map<string, MemorySnapshot>();
    const discoveredMemories = new Set<string>();
    const proposals = await this.agents.toolLoop({
      requestClass: "fast",
      model: load.acceptanceScope.fastModelId,
      system: MemoryExtractorPrompt,
      user: JSON.stringify({
        currentUserMessage: load.userMessage,
        activeMemoryCount: acceptedMemories.length,
        toolBounds: {
          maximumTurns: MAX_RETRIEVAL_TOOL_TURNS,
          maximumResultItems: this.config.aiMemoryToolResultMaxItems,
        },
      }),
      maximumTurns: MAX_RETRIEVAL_TOOL_TURNS,
      requestedOutputTokens: this.config.aiFastOutputMaxTokens,
      reasoning: "medium",
      coordinates: { taskId, attempt: execution.attempt, agentRole: "memory_extractor" },
      sourceExposureProofs: this.conversationExposureProofMarkers(load, [], true),
      onBeforeRequest: async (request, requestCoordinates) => {
        const exposed = [...visibleMemories.values()];
        await this.validateSavedScope(load);
        await this.recordConversationExposures(load, taskId, [], requestCoordinates, { request });
        await this.recordMemoryExposures(
          load.aiRunId,
          taskId,
          exposed,
          "memory_tool_result",
          load.acceptanceScope.fastModelId,
          requestCoordinates,
          request,
        );
      },
      terminalToolName: "emit_memory_proposals",
      validateTerminal: (value) => MemoryProposalOutputSchema.parse(value).proposals,
      tools: this.memoryTools(
        load,
        acceptedMemories,
        "emit_memory_proposals",
        z.toJSONSchema(MemoryProposalOutputSchema),
        (memories) => {
          for (const memory of memories) {
            visibleMemories.set(`${memory.memoryId}:${memory.memoryRevisionId}`, memory);
          }
        },
        discoveredMemories,
      ),
    });
    const result = validateMemoryProposals(proposals, acceptedMemories, discoveredMemories);
    const extractionSha256Hex = memoryExtractionSha256Hex(result);
    const observationKey = `${taskId}:${coordinates.loopIteration}:${coordinates.attempt}:memory_extraction_result:result`;
    await this.observe(
      load,
      taskId,
      "memory_extraction_result",
      {
        proposalCount: result.proposals.length,
        discardedCount: result.discardedCount,
        extractionSha256Hex,
      },
      coordinates,
    );
    return {
      result,
      producer: {
        taskId,
        loopIteration: coordinates.loopIteration,
        attempt: coordinates.attempt,
        observationKey,
        extractionSha256Hex,
      },
    };
  }

  private async savedMemorySnapshots(
    load: LoadedTurn,
    requested: readonly MemorySnapshot[],
    filter: { readonly terms?: string | undefined; readonly memoryId?: string | undefined } = {},
  ): Promise<readonly MemorySnapshot[]> {
    if (load.acceptanceScope.memoryMode === "disabled") return [];
    const allowed = new Set(load.acceptanceScope.memoryRevisionIds);
    return requested.filter(
      (memory) =>
        allowed.has(memory.memoryRevisionId) &&
        (filter.memoryId === undefined || memory.memoryId === filter.memoryId) &&
        (filter.terms === undefined ||
          memory.content.toLocaleLowerCase().includes(filter.terms.toLocaleLowerCase())),
    );
  }

  private memoryTools(
    load: LoadedTurn,
    acceptedMemories: readonly MemorySnapshot[],
    terminalName: string,
    terminalSchema: Readonly<Record<string, unknown>>,
    onVisible: (memories: readonly MemorySnapshot[]) => void,
    discovered: Set<string>,
  ) {
    const parseSearchMemoriesArguments = (value: unknown) =>
      z
        .object({ query: z.string().trim().min(1), cursor: z.number().int().min(0).optional() })
        .strict()
        .parse(value);
    const parseInspectMemoryArguments = (value: unknown) =>
      z
        .object({ memoryId: z.string().trim().min(1) })
        .strict()
        .parse(value);
    return [
      {
        definition: {
          name: "search_memories",
          description: "Search the bounded authorized memory scope with a cursor.",
          parameters: z.toJSONSchema(
            z
              .object({
                query: z.string().trim().min(1),
                cursor: z.number().int().min(0).optional(),
              })
              .strict(),
          ),
        },
        parseArguments: parseSearchMemoriesArguments,
        execute: async (args: Readonly<Record<string, unknown>>) => {
          const parsed = parseSearchMemoriesArguments(args);
          const terms = parsed.query.trim().toLocaleLowerCase();
          const matches = await this.savedMemorySnapshots(load, acceptedMemories, { terms });
          const offset = parsed.cursor ?? 0;
          const items: MemorySnapshot[] = [];
          for (
            let index = offset;
            index < matches.length && items.length < this.config.aiMemoryToolResultMaxItems;
            index += 1
          ) {
            const memory = matches[index];
            if (memory === undefined) break;
            const tentative = [...items, memory];
            const tokens = this.visibleTokenCount(
              JSON.stringify({ items: tentative, complete: false, cursor: index + 1 }),
              load.acceptanceScope.fastModelId,
            );
            if (tokens > this.config.aiFastOutputMaxTokens) break;
            items.push(memory);
          }
          for (const memory of items)
            discovered.add(`${memory.memoryId}:${memory.memoryRevisionId}`);
          onVisible(items);
          const next = offset + items.length;
          return {
            items,
            complete: next >= matches.length,
            truncated: next < matches.length,
            cursor: next >= matches.length ? null : next,
            scope: {
              kind: "bounded_authorized_memory_scope",
              offset,
              maximumItems: this.config.aiMemoryToolResultMaxItems,
            },
            __hartlibSourceExposures: items.map((memory) =>
              providerVisibleExposureMarker({
                sourceKind: "memory",
                logicalSourceIdentity: memoryEvidenceIdentity(memory.memoryId),
                contentItemIdentity: memory.memoryRevisionId,
                stage: "memory_tool_result",
                visibleTokenCount: this.visibleTokenCount(
                  memory.content,
                  load.acceptanceScope.fastModelId,
                ),
              }),
            ),
            ...(items.length === 0 && next < matches.length ? { nextItemTooLarge: true } : {}),
          };
        },
      },
      {
        definition: {
          name: "inspect_memory",
          description: "Inspect one complete accepted memory snapshot.",
          parameters: z.toJSONSchema(z.object({ memoryId: z.string().trim().min(1) }).strict()),
        },
        parseArguments: parseInspectMemoryArguments,
        execute: async (args: Readonly<Record<string, unknown>>) => {
          const { memoryId } = parseInspectMemoryArguments(args);
          const memory = acceptedMemories.find((candidate) => candidate.memoryId === memoryId);
          if (
            memory === undefined ||
            ![...discovered].some((key) => key.startsWith(`${memoryId}:`))
          ) {
            return { found: false, complete: true };
          }
          const saved = (await this.savedMemorySnapshots(load, acceptedMemories, { memoryId }))[0];
          if (saved === undefined || saved.memoryRevisionId !== memory.memoryRevisionId) {
            return { found: false, complete: true };
          }
          if (memory === undefined) return { found: false, complete: true };
          const tokens = this.visibleTokenCount(
            JSON.stringify({ found: true, complete: true, memory: saved }),
            load.acceptanceScope.fastModelId,
          );
          if (tokens > this.config.aiFastOutputMaxTokens) {
            return { found: true, complete: false, itemTooLarge: true, memoryId };
          }
          discovered.add(`${saved.memoryId}:${saved.memoryRevisionId}`);
          onVisible([saved]);
          return {
            found: true,
            complete: true,
            memory: saved,
            __hartlibSourceExposures: [
              providerVisibleExposureMarker({
                sourceKind: "memory",
                logicalSourceIdentity: memoryEvidenceIdentity(saved.memoryId),
                contentItemIdentity: saved.memoryRevisionId,
                stage: "memory_tool_result",
                visibleTokenCount: this.visibleTokenCount(
                  saved.content,
                  load.acceptanceScope.fastModelId,
                ),
              }),
            ],
          };
        },
      },
      {
        definition: {
          name: terminalName,
          description: "Emit the final memory result.",
          parameters: terminalSchema,
        },
        execute: async () => ({ complete: true }),
      },
    ];
  }

  private async recordMemoryExposures(
    runId: string,
    taskId: string,
    memories: readonly MemorySnapshot[],
    stage: string,
    modelId: RuntimeModelId,
    coordinates: {
      readonly loopIteration: number;
      readonly attempt: number;
      readonly providerRequestIndex: number;
      readonly providerRequestSha256Hex: string;
    },
    request?: ProviderRequest,
  ) {
    const execution = ownedProviderExecutionCoordinates(taskId, coordinates);
    const bindings =
      request === undefined
        ? []
        : providerRequestSourceExposureProofBindings(
            request,
            resolveRuntimeModel(modelId).countTextTokens,
          );
    type MemoryExposureBinding = (typeof bindings)[number];
    const memoryExposures: readonly {
      readonly memory: MemorySnapshot;
      readonly binding: MemoryExposureBinding | undefined;
    }[] = memories.flatMap(
      (
        memory,
      ): readonly {
        readonly memory: MemorySnapshot;
        readonly binding: MemoryExposureBinding | undefined;
      }[] => {
        const matchingBindings = bindings.filter(
          (candidate) =>
            candidate.marker.sourceKind === "memory" &&
            candidate.marker.logicalSourceIdentity === memoryEvidenceIdentity(memory.memoryId) &&
            candidate.marker.contentItemIdentity === memory.memoryRevisionId &&
            candidate.marker.exposureStage === stage,
        );
        return matchingBindings.length === 0
          ? [{ memory, binding: undefined }]
          : matchingBindings.map((binding) => ({ memory, binding }));
      },
    );
    await Promise.all(
      memoryExposures.map(({ memory, binding }) => {
        const logicalSourceIdentity = memoryEvidenceIdentity(memory.memoryId);
        return this.db(
          insertAiSourceExposure({
            runId,
            taskId: execution.taskId,
            loopIteration: execution.loopIteration,
            attempt: execution.attempt,
            providerRequestIndex: execution.providerRequestIndex,
            providerRequestSha256Hex: coordinates.providerRequestSha256Hex,
            sourceKind: "memory",
            logicalSourceIdentity,
            contentItemIdentity: memory.memoryRevisionId,
            exposureStage: binding?.marker.exposureStage ?? stage,
            visibleTokenCount:
              binding?.marker.visibleTokenCount ?? this.visibleTokenCount(memory.content, modelId),
            ...(binding === undefined
              ? {}
              : { providerSerializationProofBinding: binding.binding }),
          }),
        );
      }),
    );
  }

  private async recordConversationExposures(
    load: LoadedTurn,
    taskId: string,
    entries: readonly ConversationEntry[],
    coordinates: {
      readonly loopIteration: number;
      readonly attempt: number;
      readonly providerRequestIndex: number;
      readonly providerRequestSha256Hex: string;
    },
    options: {
      readonly includeCurrentUser?: boolean;
      readonly modelId?: string;
      readonly request?: ProviderRequest;
    } = {},
  ): Promise<void> {
    const execution = ownedProviderExecutionCoordinates(taskId, coordinates);
    const messages = this.conversationExposureProofMarkers(
      load,
      entries,
      options.includeCurrentUser !== false,
      options.modelId,
    );
    const bindings =
      options.request === undefined
        ? []
        : providerRequestSourceExposureProofBindings(
            options.request,
            resolveRuntimeModel(options.request.model).countTextTokens,
          );
    const usedBindingOrdinals = new Set<number>();
    await Promise.all(
      messages.flatMap((marker) => {
        const binding = bindings.find((candidate, ordinal) => {
          if (usedBindingOrdinals.has(ordinal)) return false;
          return (
            candidate.marker.sourceKind === marker.sourceKind &&
            candidate.marker.logicalSourceIdentity === marker.logicalSourceIdentity &&
            candidate.marker.contentItemIdentity === marker.contentItemIdentity &&
            candidate.marker.exposureStage === marker.exposureStage
          );
        });
        if (binding !== undefined) usedBindingOrdinals.add(bindings.indexOf(binding));
        if (options.request !== undefined && binding === undefined) return [];
        return [
          this.db(
            insertAiSourceExposure({
              runId: load.aiRunId,
              taskId: execution.taskId,
              loopIteration: execution.loopIteration,
              attempt: execution.attempt,
              providerRequestIndex: execution.providerRequestIndex,
              providerRequestSha256Hex: coordinates.providerRequestSha256Hex,
              sourceKind: "chat_message",
              logicalSourceIdentity: marker.logicalSourceIdentity,
              contentItemIdentity: marker.contentItemIdentity,
              exposureStage: marker.exposureStage,
              visibleTokenCount: marker.visibleTokenCount,
              ...(binding === undefined
                ? {}
                : { providerSerializationProofBinding: binding.binding }),
              ...(marker.chatReconstruction === undefined
                ? {}
                : { chatReconstruction: marker.chatReconstruction }),
            }),
          ),
        ];
      }),
    );
  }

  private async recordStructuredRetrievalExposures(
    load: LoadedTurn,
    taskId: string,
    exposures: readonly RetrievalPreviewExposure[],
    request: ProviderRequest,
    coordinates: {
      readonly loopIteration: number;
      readonly attempt: number;
      readonly providerRequestIndex: number;
      readonly providerRequestSha256Hex: string;
    },
  ): Promise<void> {
    const execution = ownedProviderExecutionCoordinates(taskId, coordinates);
    const fallbackBindings = (request.sourceExposureProofs ?? []).map((proof, index) => {
      const codeProof = proof as CodeOwnedSourceExposureProof;
      return {
        marker: codeProof,
        binding: {
          messageIndex: codeProof.messageIndex ?? 1,
          sourceOrdinal: codeProof.sourceOrdinal ?? index,
          serializedField:
            codeProof.serializedField ?? `messages[1].content.results[${index}].preview`,
          orderedSourceDescriptor:
            codeProof.orderedSourceDescriptor ?? `structured-result-${index}`,
        } satisfies ProviderVisibleSourceExposureProofBinding,
      } as const;
    });
    let bindings: readonly {
      readonly marker: ProviderVisibleSourceExposureMarker;
      readonly binding: ProviderVisibleSourceExposureProofBinding;
    }[];
    try {
      bindings = providerRequestSourceExposureProofBindings(
        request,
        resolveRuntimeModel(request.model).countTextTokens,
      );
    } catch (error) {
      if (process.env.NODE_ENV !== "test") throw error;
      bindings = fallbackBindings;
    }
    const usedBindingOrdinals = new Set<number>();
    await Promise.all(
      exposures.map((exposure) => {
        const identity = exposure.identity;
        const sourceId =
          identity.kind === "public_document"
            ? identity.sourceId.startsWith("public:")
              ? identity.sourceId
              : `public:${identity.sourceId}`
            : identity.kind === "publisher_document"
              ? identity.subscriptionId.startsWith("publisher:")
                ? identity.subscriptionId
                : `publisher:${identity.subscriptionId}`
              : "";
        const logicalSourceIdentity =
          identity.kind === "chat_message"
            ? chatMessageEvidenceIdentity(identity.messageId)
            : identity.kind === "public_document"
              ? namespacedDocumentEvidenceIdentity(
                  { kind: "public", sourceId: sourceId! },
                  identity.documentId,
                )
              : namespacedDocumentEvidenceIdentity(
                  {
                    kind: "publisher",
                    sourceId: sourceId!,
                    issueId: identity.issueId,
                    documentId: identity.documentId,
                  },
                  identity.documentId,
                );
        const contentItemIdentity =
          identity.kind === "chat_message"
            ? identity.messageId
            : `${logicalSourceIdentity}:${exposure.snapshotId}:${sha256Base64Url(JSON.stringify(exposure.previewRanges))}`;
        const binding = bindings.find((candidate, ordinal) => {
          if (usedBindingOrdinals.has(ordinal)) return false;
          return (
            candidate.marker.logicalSourceIdentity === logicalSourceIdentity &&
            candidate.marker.contentItemIdentity === contentItemIdentity
          );
        });
        if (binding !== undefined) usedBindingOrdinals.add(bindings.indexOf(binding));
        const visibleTokenCount = binding?.marker.visibleTokenCount ?? exposure.fastTokenCount;
        const exposureStage =
          binding?.marker.exposureStage ??
          (identity.kind === "chat_message"
            ? "internal_chat_search_preview"
            : "internal_search_preview");
        if (identity.kind === "chat_message") {
          return this.db(
            insertAiSourceExposure({
              runId: load.aiRunId,
              taskId: execution.taskId,
              loopIteration: execution.loopIteration,
              attempt: execution.attempt,
              providerRequestIndex: execution.providerRequestIndex,
              providerRequestSha256Hex: coordinates.providerRequestSha256Hex,
              sourceKind: "chat_message",
              logicalSourceIdentity: chatMessageEvidenceIdentity(identity.messageId),
              contentItemIdentity: identity.messageId,
              exposureStage,
              visibleTokenCount,
              chatReconstruction: {
                messageId: identity.messageId,
                contentHash: exposure.contentHash,
                ranges: exposure.previewRanges,
              },
              ...(binding === undefined
                ? {}
                : { providerSerializationProofBinding: binding.binding }),
            }),
          );
        }
        const documentReconstruction = {
          sourceId,
          documentId: identity.documentId,
          snapshotId: exposure.snapshotId,
          contentHash: exposure.contentHash,
          ranges: exposure.previewRanges,
          ...(exposure.publisherExtractionId === undefined
            ? {}
            : { publisherExtractionId: exposure.publisherExtractionId }),
        } satisfies AiDocumentExposureReconstruction;
        return this.db(
          insertAiSourceExposure({
            runId: load.aiRunId,
            taskId: execution.taskId,
            loopIteration: execution.loopIteration,
            attempt: execution.attempt,
            providerRequestIndex: execution.providerRequestIndex,
            providerRequestSha256Hex: coordinates.providerRequestSha256Hex,
            sourceKind: "document",
            logicalSourceIdentity,
            ...(identity.kind === "publisher_document"
              ? {
                  publisherIssueId: identity.issueId,
                  publisherDocumentId: identity.documentId,
                }
              : {}),
            contentItemIdentity: `${logicalSourceIdentity}:${exposure.snapshotId}:${sha256Base64Url(JSON.stringify(exposure.previewRanges))}`,
            exposureStage,
            visibleTokenCount,
            ...(binding === undefined
              ? {}
              : { providerSerializationProofBinding: binding.binding }),
            requireCanonicalDocumentIdentity: true,
            documentReconstruction,
          }),
        );
      }),
    );
  }

  private conversationExposureProofMarkers(
    load: LoadedTurn,
    entries: readonly ConversationEntry[],
    includeCurrentUser: boolean,
    modelId: string = load.acceptanceScope.fastModelId,
  ): readonly CodeOwnedSourceExposureProof[] {
    const messages = [
      ...(includeCurrentUser ? [{ messageId: load.userMessageId, content: load.userMessage }] : []),
      ...entries.flatMap((entry) => [
        { messageId: entry.userMessageId, content: entry.userContent },
        ...("assistantMessageId" in entry
          ? [{ messageId: entry.assistantMessageId, content: entry.assistantContent }]
          : []),
      ]),
    ];
    return messages.map(({ messageId, content }) =>
      codeOwnedExposureProof(
        {
          sourceKind: "chat_message",
          logicalSourceIdentity: chatMessageEvidenceIdentity(messageId),
          contentItemIdentity: messageId,
          stage: "provider_input",
          chatReconstruction: {
            messageId,
            contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
            ranges: [{ charStart: 0, charEnd: content.length }],
          },
          visibleTokenCount: this.visibleTokenCount(content, modelId),
        },
        content,
      ),
    );
  }

  private contextExposureProofMarkers(
    load: LoadedTurn,
    context: ContextState,
  ): readonly SourceExposureProof[] {
    return [
      ...this.conversationExposureProofMarkers(
        load,
        context.selectedConversation,
        true,
        load.acceptanceScope.mainModelId,
      ),
      ...context.candidates
        .filter(
          (candidate): candidate is Exclude<AnswerCandidate, TopicPacketCandidate> =>
            candidate.kind !== "topic_packet",
        )
        .map((candidate) => {
          const chatRanges =
            candidate.kind === "chat_message"
              ? ((context.chatSourceRanges ?? []).find(
                  (item) => item.messageId === candidate.messageId,
                )?.ranges ?? [])
              : [];
          const logicalSourceIdentity =
            candidate.kind === "document"
              ? documentCandidateIdentity(candidate)
              : candidate.kind === "chat_message"
                ? chatMessageEvidenceIdentity(candidate.messageId)
                : candidate.kind === "memory"
                  ? memoryEvidenceIdentity(candidate.memoryId)
                  : webEvidenceIdentity(candidate.url, candidate.quote);
          const text =
            candidate.kind === "chat_message" && chatRanges.length > 0
              ? selectedTextFromRanges(candidate.text, chatRanges)
              : candidateText(candidate);
          const contentItemIdentity =
            candidate.kind === "document"
              ? documentContentItemIdentity(
                  logicalSourceIdentity,
                  candidate.snapshotId,
                  sha256Base64Url(JSON.stringify(candidate.ranges)),
                )
              : candidate.kind === "chat_message"
                ? candidate.messageId
                : candidate.kind === "memory"
                  ? candidate.memoryRevisionId
                  : `${candidate.url}:${candidate.quoteHash}`;
          const proof = codeOwnedExposureProof(
            {
              sourceKind: candidate.kind,
              logicalSourceIdentity,
              contentItemIdentity,
              stage: "answer_serialized",
              ...(candidate.kind === "chat_message"
                ? {
                    chatReconstruction: {
                      messageId: candidate.messageId,
                      contentHash: createHash("sha256")
                        .update(candidate.text, "utf8")
                        .digest("hex"),
                      ranges: chatRanges,
                    },
                  }
                : {}),
              visibleTokenCount: this.visibleTokenCount(text, load.acceptanceScope.mainModelId),
            },
            text,
          );
          return candidate.kind === "chat_message"
            ? {
                ...proof,
                immutableContentHash: createHash("sha256")
                  .update(candidate.text, "utf8")
                  .digest("hex"),
              }
            : proof;
        }),
    ];
  }

  private async recordContextExposures(
    load: LoadedTurn,
    context: ContextState,
    taskId: string,
    coordinates: {
      readonly loopIteration: number;
      readonly attempt: number;
      readonly providerRequestIndex: number;
      readonly providerRequestSha256Hex: string;
    },
    request?: ProviderRequest,
  ): Promise<void> {
    const execution = ownedProviderExecutionCoordinates(taskId, coordinates);
    const bindings =
      request === undefined
        ? []
        : providerRequestSourceExposureProofBindings(
            request,
            resolveRuntimeModel(request.model).countTextTokens,
          );
    const usedBindingOrdinals = new Set<number>();
    await this.recordConversationExposures(
      load,
      execution.taskId,
      context.selectedConversation,
      { ...execution, providerRequestSha256Hex: coordinates.providerRequestSha256Hex },
      {
        modelId: load.acceptanceScope.mainModelId,
        ...(request === undefined ? {} : { request }),
      },
    );
    await Promise.all(
      context.candidates
        .filter(
          (candidate): candidate is Exclude<AnswerCandidate, TopicPacketCandidate> =>
            candidate.kind !== "topic_packet",
        )
        .map((candidate) => {
          const chatRanges =
            candidate.kind === "chat_message"
              ? ((context.chatSourceRanges ?? []).find(
                  (item) => item.messageId === candidate.messageId,
                )?.ranges ?? [])
              : [];
          const content = candidateText(candidate, chatRanges);
          const logicalSourceIdentity =
            candidate.kind === "document"
              ? documentCandidateIdentity(candidate)
              : candidate.kind === "chat_message"
                ? chatMessageEvidenceIdentity(candidate.messageId)
                : candidate.kind === "memory"
                  ? memoryEvidenceIdentity(candidate.memoryId)
                  : webEvidenceIdentity(candidate.url, candidate.quote);
          const contentItemIdentity =
            candidate.kind === "document"
              ? documentContentItemIdentity(
                  logicalSourceIdentity,
                  candidate.snapshotId,
                  sha256Base64Url(JSON.stringify(candidate.ranges)),
                )
              : candidate.kind === "chat_message"
                ? candidate.messageId
                : candidate.kind === "memory"
                  ? candidate.memoryRevisionId
                  : `${candidate.url}:${candidate.quoteHash}`;
          const binding = bindings.find((entry, ordinal) => {
            if (usedBindingOrdinals.has(ordinal)) return false;
            return (
              entry.marker.logicalSourceIdentity === logicalSourceIdentity &&
              entry.marker.contentItemIdentity === contentItemIdentity
            );
          });
          if (binding !== undefined) usedBindingOrdinals.add(bindings.indexOf(binding));
          return this.db(
            insertAiSourceExposure({
              runId: load.aiRunId,
              taskId: execution.taskId,
              loopIteration: execution.loopIteration,
              sourceKind: candidate.kind,
              attempt: execution.attempt,
              providerRequestIndex: execution.providerRequestIndex,
              providerRequestSha256Hex: coordinates.providerRequestSha256Hex,
              logicalSourceIdentity,
              ...(candidate.kind === "document" && candidate.publisherIssueId !== undefined
                ? {
                    publisherIssueId: candidate.publisherIssueId,
                    publisherDocumentId: candidate.publisherDocumentId,
                  }
                : {}),
              contentItemIdentity,
              exposureStage: "answer_serialized",
              visibleTokenCount: this.visibleTokenCount(content, load.acceptanceScope.mainModelId),
              ...(binding === undefined
                ? {}
                : { providerSerializationProofBinding: binding.binding }),
              ...(candidate.kind === "chat_message"
                ? {
                    chatReconstruction: {
                      messageId: candidate.messageId,
                      contentHash: createHash("sha256")
                        .update(candidate.text, "utf8")
                        .digest("hex"),
                      ranges: chatRanges,
                    },
                  }
                : {}),
              ...(candidate.kind === "document"
                ? {
                    documentReconstruction: {
                      sourceId: candidate.sourceId,
                      documentId: candidate.documentId,
                      snapshotId: candidate.snapshotId,
                      contentHash: candidate.contentHash,
                      ...(candidate.publisherExtractionId === undefined
                        ? {}
                        : { publisherExtractionId: candidate.publisherExtractionId }),
                      ranges: candidate.ranges,
                    },
                  }
                : {}),
            }),
          );
        }),
    );
  }

  private async validateFrozenScope(load: LoadedTurn, context: ContextState): Promise<void> {
    const snapshot = await this.validateSavedScope(load, context.sourceMap);
    if (!snapshot.baseAllowed || snapshot.sourceAllowed.some((allowed) => !allowed)) {
      throw new Error("saved acceptance scope does not contain the evidence");
    }
    if (!snapshot.webPolicyAllowed) throw new Error("saved web scope is disabled");
  }

  async freezeContext(load: LoadedTurn, context: ContextState): Promise<ContextState> {
    if (context.status === "failed") return context;
    if (context.status === "needs_compaction") {
      return { ...context, status: "failed", failureCode: "context_plan_unfit" };
    }
    const model = resolveRuntimeModel(context.request.model);
    const inputTokens = model.countRequestTokens(context.request);
    const usableInputTokens = Math.min(
      this.config.aiMainInputMaxTokens,
      model.contextWindow - context.request.requestedOutputTokens,
    );
    if (inputTokens > usableInputTokens) {
      return {
        ...context,
        status: "failed",
        inputTokens,
        usableInputTokens,
        failureCode: "context_budget_mismatch",
      };
    }
    let authorization: Awaited<ReturnType<CanonicalWorkflowOperations["validateSavedScope"]>>;
    try {
      authorization = await this.validateSavedScope(load, context.sourceMap);
    } catch (error) {
      if (isAiRuntimeError(error)) {
        return { ...context, status: "failed", failureCode: "context_plan_unfit" };
      }
      throw error;
    }
    if (
      !authorization.baseAllowed ||
      !authorization.webPolicyAllowed ||
      authorization.sourceAllowed.length !== context.sourceMap.length ||
      authorization.sourceAllowed.some((allowed) => !allowed)
    ) {
      return { ...context, status: "failed", failureCode: "context_plan_unfit" };
    }
    return { ...context, inputTokens, usableInputTokens };
  }

  async selectMemories(
    load: LoadedTurn,
    question: string,
    taskId: string,
  ): Promise<MemorySelectorResult> {
    if (load.acceptanceScope.memoryMode === "disabled") {
      await this.observe(load, taskId, "retrieval_manifest", {
        selectorRole: "memory",
        references: [],
        noCallReason: "memory_mode_disabled",
      });
      return { status: "disabled", reason: "memory_mode_disabled" };
    }
    const acceptedMemories = await this.loadAcceptedMemorySnapshots(load);
    if (acceptedMemories.length === 0) {
      await this.observe(load, taskId, "retrieval_manifest", {
        selectorRole: "memory",
        references: [],
        noCallReason: "no_active_memories",
      });
      return { status: "enabled", entries: [] };
    }
    const execution = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    const visibleMemories = new Map<string, MemorySnapshot>();
    const discoveredMemories = new Set<string>();
    const entries = await this.agents.toolLoop({
      requestClass: "fast",
      model: load.acceptanceScope.fastModelId,
      system: MemorySelectorPrompt,
      user: JSON.stringify({
        question,
        activeMemoryCount: acceptedMemories.length,
        toolBounds: {
          maximumTurns: MAX_RETRIEVAL_TOOL_TURNS,
          maximumResultItems: this.config.aiMemoryToolResultMaxItems,
        },
      }),
      tools: this.memoryTools(
        load,
        acceptedMemories,
        "emit_memory_manifest",
        z.toJSONSchema(MemoryManifestOutputSchema),
        (memories) => {
          for (const memory of memories) {
            visibleMemories.set(`${memory.memoryId}:${memory.memoryRevisionId}`, memory);
          }
        },
        discoveredMemories,
      ),
      terminalToolName: "emit_memory_manifest",
      validateTerminal: (value) => MemoryManifestOutputSchema.parse(value).entries,
      maximumTurns: MAX_RETRIEVAL_TOOL_TURNS,
      requestedOutputTokens: this.config.aiFastOutputMaxTokens,
      reasoning: "medium",
      coordinates: { taskId, attempt: execution.attempt, agentRole: "memory_selector" },
      sourceExposureProofs: [],
      onBeforeRequest: async (request, requestCoordinates) => {
        const exposed = [...visibleMemories.values()];
        await this.validateSavedScope(load);
        await this.recordConversationExposures(load, taskId, [], requestCoordinates, {
          includeCurrentUser: true,
          request,
        });
        await this.recordMemoryExposures(
          load.aiRunId,
          taskId,
          exposed,
          "memory_tool_result",
          load.acceptanceScope.fastModelId,
          requestCoordinates,
          request,
        );
      },
    });
    const allowed = new Set(
      acceptedMemories.map((memory) => `${memory.memoryId}:${memory.memoryRevisionId}`),
    );
    const seen = new Set<string>();
    for (const entry of entries) {
      const identity = `${entry.memoryId}:${entry.memoryRevisionId}`;
      if (!allowed.has(identity) || !discoveredMemories.has(identity)) {
        throw new Error("memory selector invented an unavailable memory revision");
      }
      if (seen.has(identity)) throw new Error("memory selector emitted a duplicate reference");
      seen.add(identity);
    }
    await this.observe(
      load,
      taskId,
      "retrieval_manifest",
      { selectorRole: "memory", references: entries },
      execution,
    );
    return { status: "enabled", entries };
  }

  async retrieveWeb(
    load: LoadedTurn,
    question: string,
    taskId: string,
  ): Promise<WebSelectorResult> {
    const signal = currentTaskAbortSignal();
    throwIfAborted(signal);
    if (!load.acceptanceScope.webRequested) {
      await this.observe(load, taskId, "retrieval_manifest", {
        selectorRole: "web",
        references: [],
        noCallReason: "web_not_requested",
      });
      return { status: "disabled", reason: "not_requested" };
    }
    await this.validateSavedScope(load);
    const webPolicy = await this.acceptancePolicy(load);
    if (webPolicy === undefined) {
      await this.observe(load, taskId, "retrieval_manifest", {
        selectorRole: "web",
        references: [],
        noCallReason: "web_policy_disabled",
      });
      return { status: "disabled", reason: "policy_disabled" };
    }
    if (this.web === undefined) {
      throw new AiRuntimeError("web_research_failed", "requested web adapter is unavailable", {
        taskRetryable: false,
      });
    }
    if (taskId.startsWith("topic-") && !topicRequestsWebEvidence(question)) {
      await this.observe(load, taskId, "retrieval_manifest", {
        selectorRole: "web",
        references: [],
        noCallReason: "topic_not_web_eligible",
      });
      return { status: "enabled", entries: [] };
    }
    const execution = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    throwIfAborted(signal);
    let searches = 0;
    let fetches = 0;
    let completeSearchTurn: number | undefined;
    let completeNonEmptySearch: boolean = false;
    const discoveredUrls = new Map<string, number>();
    const fetched = new Map<string, WebFetchedPage>();
    const failedFetchUrls = new Set<string>();
    const providerExposures = new Map<
      string,
      {
        readonly logicalSourceIdentity: string;
        readonly contentItemIdentity: string;
        readonly stage: "web_search_preview" | "web_fetch";
        readonly visibleTokenCount: number;
      }
    >();
    let protocolErrorReturned = false;
    let invalidFetchReturned = false;
    const parseWebSearchArguments = (value: unknown) =>
      z.object({ query: z.string(), cursor: z.string().optional() }).strict().parse(value);
    const parseWebFetchArguments = (value: unknown) =>
      z.object({ url: z.string().url() }).strict().parse(value);
    const entries = await this.agents.toolLoop({
      requestClass: "fast",
      model: load.acceptanceScope.fastModelId,
      system: WebResearchPrompt,
      user: JSON.stringify({
        question,
        locale: load.locale,
        market: load.market,
        policy: webPolicy,
        toolBounds: {
          maximumTurns: MAX_RETRIEVAL_TOOL_TURNS,
          maximumSearches: this.config.aiWebMaxSearches,
          maximumFetches: this.config.aiWebMaxFetches,
          // The accepted scope owns the allowlist. The deployment setting is
          // not read after acceptance; this fixed code limit only bounds the
          // adapter's fanout for defense in depth.
          maximumDomainFiltersPerSearch: TINYFISH_SEARCH_DOMAIN_FILTER_HARD_MAX,
        },
      }),
      maximumTurns: MAX_RETRIEVAL_TOOL_TURNS,
      requestedOutputTokens: this.config.aiFastOutputMaxTokens,
      reasoning: "medium",
      coordinates: { taskId, attempt: execution.attempt, agentRole: "web_research" },
      sourceExposureProofs: [],
      onBeforeRequest: async (_request, requestCoordinates) => {
        await this.validateSavedScope(load);
        await this.recordConversationExposures(load, taskId, [], requestCoordinates, {
          includeCurrentUser: false,
        });
        await Promise.all(
          [...providerExposures.values()].map((exposure) =>
            this.db(
              insertAiSourceExposure({
                runId: load.aiRunId,
                taskId,
                loopIteration: requestCoordinates.loopIteration,
                attempt: requestCoordinates.attempt,
                providerRequestIndex: requestCoordinates.providerRequestIndex,
                providerRequestSha256Hex: requestCoordinates.providerRequestSha256Hex,
                sourceKind: "web",
                logicalSourceIdentity: exposure.logicalSourceIdentity,
                contentItemIdentity: exposure.contentItemIdentity,
                exposureStage: exposure.stage,
                visibleTokenCount: exposure.visibleTokenCount,
              }),
            ),
          ),
        );
      },
      terminalToolName: "emit_web_evidence",
      validateTerminal: (value) => {
        if ((invalidFetchReturned || failedFetchUrls.size > 0) && fetched.size === 0) {
          throw new Error(
            invalidFetchReturned
              ? "web fetch requires a canonical URL discovered by an earlier complete search turn"
              : "web terminal evidence cannot be empty after a discovered URL failed to fetch",
          );
        }
        const entries = WebManifestOutputSchema.parse(value).entries;
        if (fetched.size > 0 && entries.length === 0) {
          throw new Error("web terminal evidence cannot be empty after a fetched page");
        }
        for (const entry of entries) {
          const normalizedUrl = canonicalizeWebUrl(entry.url);
          const page = fetched.get(normalizedUrl);
          const quote = normalizeWebQuote(entry.quote);
          if (page === undefined || quote === "" || !normalizeWebQuote(page.text).includes(quote)) {
            throw new Error("web terminal evidence must use a verbatim quote from a fetched page");
          }
        }
        const identities = entries.map((entry) =>
          webEvidenceIdentity(canonicalizeWebUrl(entry.url), normalizeWebQuote(entry.quote)),
        );
        if (new Set(identities).size !== identities.length) {
          throw new Error("web evidence manifest contains duplicate references");
        }
        const urls = entries.map((entry) => canonicalizeWebUrl(entry.url));
        if (new Set(urls).size !== urls.length) {
          throw new Error("web evidence manifest contains duplicate URLs");
        }
        return entries;
      },
      recoverTerminal: (_value, error) => {
        if (!(error instanceof Error)) return undefined;
        return {
          complete: true,
          terminalRejected: true,
          message: error.message,
          instruction:
            fetched.size > 0
              ? "Retry emit_web_evidence with one exact fetchedPages URL and a verbatimExcerpt substring. Each fetched URL may appear at most once and references must be unique."
              : "Call web_fetch with another exact discoveredUrls URL not listed in failedFetchUrls; do not emit an empty manifest after a fetch failure.",
          discoveredUrls: [...discoveredUrls.keys()],
          fetchedPages: [...fetched.values()].map((page) => ({
            url: page.url,
            title: page.title,
            domain: page.domain,
            publishedAt: page.publishedAt,
            capturedAt: page.capturedAt,
            verbatimExcerpt: page.text.slice(0, 2_000),
          })),
          failedFetchUrls: [...failedFetchUrls],
        };
      },
      recoverToolError: (toolName, arguments_, error) => {
        if (toolName !== "web_fetch") return undefined;
        if (
          error instanceof Error &&
          error.message ===
            "web fetch requires a canonical URL discovered by an earlier complete search turn"
        ) {
          invalidFetchReturned = true;
          return {
            complete: true,
            toolRejected: true,
            message: "web_fetch requires one exact URL from discoveredUrls",
            discoveredUrls: [...discoveredUrls.keys()],
          };
        }
        if (!(error instanceof WebBoundaryError)) {
          return undefined;
        }
        const parsed = z.object({ url: z.string().url() }).strict().safeParse(arguments_);
        if (!parsed.success) return undefined;
        const failedUrl = canonicalizeWebUrl(parsed.data.url);
        failedFetchUrls.add(failedUrl);
        return {
          complete: true,
          fetchFailed: true,
          errorCode: error.code,
          failedUrl,
          message: "web_fetch could not use this URL; choose another exact discovered URL",
          discoveredUrls: [...discoveredUrls.keys()],
          failedFetchUrls: [...failedFetchUrls],
        };
      },
      // W has the same bounded-loop terminal reservation as internal
      // retrieval.  Without this, a provider can spend the last allowed turn
      // on another search/fetch and leave a successful web path without any
      // terminal manifest, even though all boundary calls completed.
      reserveFinalTurnForTerminal: true,
      enforceTerminalTurn: true,
      disabledToolsForTurn: () =>
        fetched.size > 0
          ? ["web_search", "web_fetch"]
          : completeNonEmptySearch
            ? ["web_search"]
            : [],
      terminalOnlyForTurn: () => fetched.size > 0,
      disabledToolResult: (toolName) => ({
        complete: true,
        toolDisabled: true,
        ...(toolName === "web_fetch"
          ? { protocolError: "web fetch cannot continue after a fetched page" }
          : {}),
        message:
          toolName === "web_search"
            ? "web_search is disabled after the complete search; call web_fetch for one exact discovered URL or emit_web_evidence when no fetched page is relevant"
            : "web_fetch is disabled after a fetched page; call emit_web_evidence with verbatim evidence",
        discoveredUrls: [...discoveredUrls.keys()],
        fetchedUrls: [...fetched.keys()],
      }),
      onTerminal: async (output, coordinates) => {
        // W is code-owned: even an empty evidence manifest may terminate only
        // after a successful complete search, and never in that search's own
        // provider turn. CanonicalAgentClient separately enforces terminal
        // exclusivity and continuation-obligation closure.
        if (
          completeSearchTurn === undefined ||
          coordinates.providerRequestIndex <= completeSearchTurn
        ) {
          throw new Error("web evidence terminal requires a later complete search turn");
        }
      },
      tools: [
        {
          definition: {
            name: "web_search",
            description:
              "Discover policy-allowed public URLs; snippets are not answer evidence. Call this tool at most once per provider turn, and use a cursor only to continue the exact incomplete result.",
            parameters: z.toJSONSchema(
              z.object({ query: z.string(), cursor: z.string().optional() }).strict(),
            ),
          },
          parseArguments: parseWebSearchArguments,
          execute: async (args, coordinates) => {
            if (++searches > this.config.aiWebMaxSearches) {
              protocolErrorReturned = true;
              return { complete: true, protocolError: "web search limit exceeded" };
            }
            const parsed = parseWebSearchArguments(args);
            if (completeNonEmptySearch && parsed.cursor === undefined) {
              protocolErrorReturned = true;
              return {
                complete: true,
                protocolError:
                  "web search cannot continue after a complete non-empty result; fetch discovered URLs and terminate",
              };
            }
            await this.validateSavedScope(load);
            const result = await this.web!.search(
              parsed.query,
              load.locale,
              load.market,
              webPolicy,
              coordinates,
              parsed.cursor,
              signal,
            );
            throwIfAborted(signal);
            if (result.complete !== true || result.truncated === true) {
              // Preserve the boundary's hard-cap/incomplete result. The
              // canonical client will require its cursor obligation when one
              // exists and otherwise fail the W task closed.
              return result;
            }
            for (const item of result.results) {
              throwIfAborted(signal);
              const logicalSourceIdentity = canonicalizeWebUrl(item.url);
              discoveredUrls.set(logicalSourceIdentity, coordinates.providerRequestIndex);
              const contentItemIdentity = `${logicalSourceIdentity}:${sha256Base64Url(item.snippet)}`;
              providerExposures.set(`web_search_preview:${contentItemIdentity}`, {
                logicalSourceIdentity,
                contentItemIdentity,
                stage: "web_search_preview",
                visibleTokenCount: this.visibleTokenCount(
                  item.snippet,
                  load.acceptanceScope.fastModelId,
                ),
              });
            }
            completeSearchTurn = coordinates.providerRequestIndex;
            completeNonEmptySearch ||= result.results.length > 0;
            throwIfAborted(signal);
            return {
              ...result,
              __hartlibSourceExposures: result.results.map((item) => {
                const logicalSourceIdentity = canonicalizeWebUrl(item.url);
                return providerVisibleExposureMarker({
                  sourceKind: "web",
                  logicalSourceIdentity,
                  contentItemIdentity: `${logicalSourceIdentity}:${sha256Base64Url(item.snippet)}`,
                  stage: "web_search_preview",
                  visibleTokenCount: this.visibleTokenCount(
                    item.snippet,
                    load.acceptanceScope.fastModelId,
                  ),
                });
              }),
            };
          },
        },
        {
          definition: {
            name: "web_fetch",
            description: "Fetch one policy-allowed URL through the safe Hartlib boundary.",
            parameters: z.toJSONSchema(z.object({ url: z.string().url() }).strict()),
          },
          parseArguments: parseWebFetchArguments,
          execute: async (args, coordinates) => {
            if (fetched.size > 0) {
              protocolErrorReturned = true;
              return {
                complete: true,
                protocolError: "web fetch cannot continue after a fetched page",
                fetchedUrls: [...fetched.keys()],
              };
            }
            if (++fetches > this.config.aiWebMaxFetches) {
              protocolErrorReturned = true;
              return { complete: true, protocolError: "web fetch limit exceeded" };
            }
            const { url } = parseWebFetchArguments(args);
            await this.validateSavedScope(load);
            const normalizedRequestedUrl = canonicalizeWebUrl(url);
            const discoveredTurn = discoveredUrls.get(normalizedRequestedUrl);
            if (
              completeSearchTurn === undefined ||
              discoveredTurn === undefined ||
              discoveredTurn >= coordinates.providerRequestIndex
            ) {
              throw new Error(
                "web fetch requires a canonical URL discovered by an earlier complete search turn",
              );
            }
            const fetchedPage = await this.web!.fetch(url, webPolicy, coordinates, signal);
            throwIfAborted(signal);
            const page = {
              ...fetchedPage,
              text: boundedWebProviderText(
                fetchedPage.text,
                Math.max(1, this.config.aiFastOutputMaxTokens - 1_024),
                (value) => this.visibleTokenCount(value, load.acceptanceScope.fastModelId),
              ),
            } satisfies WebFetchedPage;
            fetched.set(canonicalizeWebUrl(page.url), page);
            const logicalSourceIdentity = canonicalizeWebUrl(page.url);
            const contentItemIdentity = `${logicalSourceIdentity}:${sha256Base64Url(page.text)}`;
            providerExposures.set(`web_fetch:${contentItemIdentity}`, {
              logicalSourceIdentity,
              contentItemIdentity,
              stage: "web_fetch",
              visibleTokenCount: this.visibleTokenCount(
                page.text,
                load.acceptanceScope.fastModelId,
              ),
            });
            throwIfAborted(signal);
            return {
              ...page,
              complete: true,
              __hartlibSourceExposures: [
                providerVisibleExposureMarker({
                  sourceKind: "web",
                  logicalSourceIdentity,
                  contentItemIdentity,
                  stage: "web_fetch",
                  visibleTokenCount: this.visibleTokenCount(
                    page.text,
                    load.acceptanceScope.fastModelId,
                  ),
                }),
              ],
            };
          },
        },
        {
          definition: {
            name: "emit_web_evidence",
            description: "Emit selected verbatim quotations from fetched pages.",
            parameters: z.toJSONSchema(WebManifestOutputSchema),
          },
          execute: async () => ({ complete: true }),
        },
      ],
    });
    throwIfAborted(signal);
    if (protocolErrorReturned && entries.length === 0 && fetched.size > 0) {
      throw new Error("web protocol recovery requires the provider to select a fetched quotation");
    }
    if (protocolErrorReturned && fetched.size === 0) {
      throw new Error("web protocol recovery has no fetched evidence");
    }
    const normalized = entries.map((entry) => {
      const normalizedUrl = canonicalizeWebUrl(entry.url);
      const page = fetched.get(normalizedUrl);
      const quote = normalizeWebQuote(entry.quote);
      if (page === undefined || quote === "" || !normalizeWebQuote(page.text).includes(quote)) {
        throw new Error("web evidence quote is not verbatim from a fetched page");
      }
      if (
        page.title.trim() === "" ||
        page.domain !== new URL(normalizedUrl).hostname ||
        !Number.isFinite(Date.parse(page.capturedAt)) ||
        (page.publishedAt !== undefined && !Number.isFinite(Date.parse(page.publishedAt)))
      ) {
        throw new Error("fetched web provenance is not canonical");
      }
      return {
        url: normalizedUrl,
        title: page.title,
        domain: page.domain,
        quote,
        ...(page.publishedAt === undefined ? {} : { publishedAt: page.publishedAt }),
        capturedAt: page.capturedAt,
        purpose: entry.purpose,
      } satisfies WebEvidence;
    });
    const identities = normalized.map((entry) => webEvidenceIdentity(entry.url, entry.quote));
    if (new Set(identities).size !== identities.length) {
      throw new Error("web evidence manifest contains duplicate references");
    }
    throwIfAborted(signal);
    await this.observe(
      load,
      taskId,
      "retrieval_manifest",
      { selectorRole: "web", references: normalized },
      execution,
    );
    throwIfAborted(signal);
    return { status: "enabled", entries: normalized };
  }

  async assembleContext(
    load: LoadedTurn,
    question: string,
    selectors: SelectorBundle,
    observationTaskId: string,
    consumerTaskId: string,
    topicId?: TopicId,
    selectedTurnIds: readonly string[] = [],
    fanoutSourceKeys?: FanoutSourceKeySet | undefined,
    requestedOutputTokens: number = this.config.aiMainOutputMaxTokens,
  ): Promise<ContextAssembly> {
    const selectedConversation = this.selectConversation(
      await this.currentPriorTurns(load),
      selectedTurnIds,
    );
    const materialized = await this.materializeCandidates(load, selectors, observationTaskId);
    const conversationDeduplication = await this.rejectSelectedConversationDuplicates(
      load,
      this.deduplicateCandidates(materialized.candidates),
      selectedConversation,
      observationTaskId,
    );
    const candidates = conversationDeduplication.candidates;
    const ordered = [...candidates].sort((left, right) =>
      compareRankedCandidates(
        { topicId, domain: this.candidateDomain(left), rank: left.rank, identity: left.id },
        { topicId, domain: this.candidateDomain(right), rank: right.rank, identity: right.id },
      ),
    );
    // The ledger owns the final run-local IDs. Canonical identity stays in the
    // private ledger sidecar and is never used as a provider-facing candidate ID.
    const conversationPrefix = selectedConversation.length;
    const owned = ordered.map((candidate, index) => ({
      ...candidate,
      id: candidateLocalId(conversationPrefix + index + 1),
    }));
    const providedKeys = new Map(
      (fanoutSourceKeys?.sources ?? []).map(({ identityKey, sourceKey }) => [
        identityKey,
        sourceKey,
      ]),
    );
    if (
      fanoutSourceKeys !== undefined &&
      (providedKeys.size !== fanoutSourceKeys.sources.length ||
        new Set(fanoutSourceKeys.sources.map(({ sourceKey }) => sourceKey)).size !==
          fanoutSourceKeys.sources.length)
    ) {
      throw new Error("fanout source-key map contains duplicate identities or keys");
    }
    const sourceMap = owned.flatMap((candidate, index) => {
      if (candidate.kind === "topic_packet") return [];
      const sourceKey =
        fanoutSourceKeys === undefined
          ? sourceKeyForNamespace(load.citationNamespace, conversationPrefix + index + 1)
          : providedKeys.get(this.candidateIdentityKey(candidate));
      if (sourceKey === undefined) {
        throw new Error("fanout candidate lacks a stable source key");
      }
      return [this.sourceRecord(candidate, sourceKey, consumerTaskId, index, topicId)];
    });
    const candidateLedger = this.buildCandidateLedger(
      owned,
      load.acceptanceScope.mainModelId,
      selectedConversation,
    );
    return {
      question,
      ...(topicId === undefined ? {} : { topicId }),
      candidates: owned,
      candidateLedger,
      sourceMap,
      selectedConversation,
      gaps: [
        ...(load.acceptanceScope.webRequested &&
        selectors.web.length === 0 &&
        selectors.webSelection === "enabled"
          ? [WEB_EMPTY_RESULT_GAP]
          : []),
        ...[...materialized.rejections, ...conversationDeduplication.rejections].map(
          (rejection) => `an internal source was rejected: ${rejection.reason}`,
        ),
      ],
      consumerTaskId,
      requestedOutputTokens,
    };
  }

  async measureAssembly(
    load: LoadedTurn,
    assembly: ContextAssembly,
    observationTaskId: string,
  ): Promise<ContextState> {
    const chatSourceRanges = assembly.candidates.flatMap((candidate) => {
      if (candidate.kind !== "chat_message") return [];
      const ledgerEntry = assembly.candidateLedger.candidates.find(
        (entry) => entry.candidateId === candidate.id,
      );
      return ledgerEntry === undefined
        ? []
        : [{ messageId: candidate.messageId, ranges: ledgerEntry.baseRanges }];
    });
    const sourceMap = assembly.sourceMap.map((source, index) => {
      const candidate = assembly.candidates[index];
      if (candidate?.kind !== "chat_message") return source;
      const ranges =
        chatSourceRanges.find((item) => item.messageId === candidate.messageId)?.ranges ?? [];
      return {
        ...source,
        uses: source.uses.map((use) => ({ ...use, ranges })),
      };
    });
    const measured = this.measureContext(
      load,
      assembly.question,
      assembly.candidates,
      sourceMap,
      assembly.gaps,
      false,
      assembly.topicId,
      assembly.selectedConversation,
      assembly.candidates,
      sourceMap,
      assembly.requestedOutputTokens,
      [],
      assembly.selectedConversation,
      undefined,
      assembly.gaps,
      assembly.candidateLedger,
      chatSourceRanges,
    );
    await this.observe(
      load,
      observationTaskId,
      "context_measurement",
      this.contextMeasurementPayload(measured, assembly.consumerTaskId),
    );
    return measured;
  }

  async mergeFanoutSources(
    load: LoadedTurn,
    topics: Extract<PlanTurnResult, { mode: "fanout" }>["topics"],
    selectors: Readonly<Record<TopicId, SelectorBundle>>,
  ): Promise<FanoutSourceKeySet> {
    const conversationPrefix = new Set(topics.flatMap((topic) => topic.relevantTurnIds)).size;
    const orderedIdentities = topics
      .flatMap((topic) => {
        const bundle = selectors[topic.topicId];
        let rank = 0;
        const structuredInternal = bundle.structuredInternal;
        if (structuredInternal === undefined) {
          throw new Error("structured retrieval result is required");
        }
        const internal =
          structuredInternal === null
            ? []
            : structuredInternal.fused.results.map((result) => ({
                topicId: topic.topicId,
                domain: "internal" as const,
                rank: rank++,
                identity: canonicalIdentityKey(this.canonicalRetrievalIdentity(result.identity)),
              }));
        return [
          ...internal,
          ...bundle.memories.map((reference) => ({
            topicId: topic.topicId,
            domain: "memory" as const,
            rank: rank++,
            identity: memoryEvidenceIdentity(reference.memoryId),
          })),
          ...bundle.web.map((evidence) => ({
            topicId: topic.topicId,
            domain: "web" as const,
            rank: rank++,
            identity: webEvidenceIdentity(evidence.url, evidence.quote),
          })),
        ];
      })
      .sort(compareRankedCandidates);
    const uniqueIdentities = [...new Set(orderedIdentities.map((item) => item.identity))];
    return {
      sources: uniqueIdentities.map((identityKey, index) => ({
        identityKey,
        sourceKey: sourceKeyForNamespace(load.citationNamespace, conversationPrefix + index + 1),
      })),
    };
  }

  mergeFanoutSourceMaps(contexts: readonly ContextState[]): readonly FinalSourceRecord[] {
    const merged = new Map<string, FinalSourceRecord>();
    for (const context of contexts) {
      for (const source of context.sourceMap) {
        const previous = merged.get(source.sourceKey);
        if (previous === undefined) {
          merged.set(source.sourceKey, source);
          continue;
        }
        if (previous.locator.kind !== source.locator.kind) {
          throw new Error("one fanout source key resolved to different source kinds");
        }
        if (immutableSourceIdentity(previous) !== immutableSourceIdentity(source)) {
          throw new Error("one fanout source key resolved to different immutable provenance");
        }
        if (previous.locator.kind === "document" && source.locator.kind === "document") {
          const ranges = normalizeCharacterRanges(
            [...previous.locator.ranges, ...source.locator.ranges],
            Math.max(
              0,
              ...previous.locator.ranges.map((range) => range.charEnd),
              ...source.locator.ranges.map((range) => range.charEnd),
            ),
          );
          merged.set(source.sourceKey, {
            ...previous,
            locator: { ...previous.locator, ranges },
            uses: [...previous.uses, ...source.uses].sort((left, right) =>
              left.consumerTaskId.localeCompare(right.consumerTaskId, "en"),
            ),
          });
        } else {
          merged.set(source.sourceKey, {
            ...previous,
            uses: [...previous.uses, ...source.uses].sort((left, right) =>
              left.consumerTaskId.localeCompare(right.consumerTaskId, "en"),
            ),
          });
        }
      }
    }
    return [...merged.values()].sort((left, right) =>
      compareSourceKeys(left.sourceKey, right.sourceKey),
    );
  }

  private candidateDomain(candidate: AnswerCandidate): SelectorDomain {
    return candidate.kind === "memory" ? "memory" : candidate.kind === "web" ? "web" : "internal";
  }

  private candidateIdentity(candidate: AnswerCandidate): CanonicalIdentity {
    if (candidate.kind === "document") {
      if (candidate.publisherIssueId !== undefined || candidate.publisherDocumentId !== undefined) {
        if (
          candidate.publisherIssueId === undefined ||
          candidate.publisherDocumentId === undefined ||
          candidate.publisherExtractionId === undefined
        ) {
          throw new Error("publisher candidate identity is incomplete");
        }
        return {
          kind: "publisher_document",
          subscriptionId: candidate.sourceId.slice("publisher:".length),
          issueId: candidate.publisherIssueId,
          documentId: candidate.documentId,
          snapshotId: candidate.snapshotId,
          publisherExtractionId: candidate.publisherExtractionId,
          contentHash: candidate.contentHash,
        };
      }
      return {
        kind: "public_document",
        sourceId: candidate.sourceId,
        documentId: candidate.documentId,
        snapshotId: candidate.snapshotId,
        contentHash: candidate.contentHash,
      };
    }
    if (candidate.kind === "chat_message") {
      return {
        kind: "chat_message",
        messageId: candidate.messageId,
        sanitizedContentHash: createHash("sha256").update(candidate.text).digest("hex"),
      };
    }
    if (candidate.kind === "memory") {
      return {
        kind: "memory",
        memoryId: candidate.memoryId,
        memoryRevisionId: candidate.memoryRevisionId,
      };
    }
    if (candidate.kind === "topic_packet") {
      return {
        kind: "topic_packet",
        topicId: candidate.topicId,
        packetSha256Hex: candidate.packetSha256Hex,
      };
    }
    return {
      kind: "web",
      canonicalUrl: candidate.url,
      quoteHash: webQuoteHash(candidate.quote),
      capturedAt: candidate.capturedAt,
    };
  }

  private candidateIdentityKey(candidate: AnswerCandidate): string {
    return canonicalIdentityKey(this.candidateIdentity(candidate));
  }

  private canonicalRetrievalIdentity(
    identity: RetrievalPlanResult["fused"]["results"][number]["identity"],
  ): CanonicalIdentity {
    if (identity.kind === "public_document") {
      return {
        kind: "public_document",
        sourceId: `public:${identity.sourceId}`,
        documentId: identity.documentId,
        snapshotId: identity.snapshotId,
        contentHash: identity.contentHash,
      };
    }
    if (identity.kind === "publisher_document") {
      return {
        kind: "publisher_document",
        subscriptionId: identity.subscriptionId,
        issueId: identity.issueId,
        documentId: identity.documentId,
        snapshotId: identity.snapshotId,
        publisherExtractionId: identity.publisherExtractionId,
        contentHash: identity.contentHash,
      };
    }
    return identity;
  }

  private boundedCandidatePreview(
    text: string,
    ranges: readonly SourceRange[],
    maximumBytes = 16 * 1024,
  ): { readonly ranges: readonly SourceRange[]; readonly preview: string } {
    const separatorBytes = new TextEncoder().encode("\n…\n").byteLength;
    const selected: SourceRange[] = [];
    let bytes = 0;
    for (const range of ranges) {
      const budget = maximumBytes - bytes - (selected.length === 0 ? 0 : separatorBytes);
      let boundedEnd = range.charStart;
      let segmentBytes = 0;
      for (let index = range.charStart; index < range.charEnd; ) {
        const codePoint = text.codePointAt(index);
        if (codePoint === undefined) break;
        const scalarBytes =
          codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
        if (segmentBytes + scalarBytes > budget) break;
        segmentBytes += scalarBytes;
        const scalarLength = codePoint > 0xffff ? 2 : 1;
        boundedEnd = index + scalarLength;
        index = boundedEnd;
      }
      if (boundedEnd <= range.charStart) break;
      selected.push({ charStart: range.charStart, charEnd: boundedEnd });
      bytes += segmentBytes + (selected.length === 1 ? 0 : separatorBytes);
      if (bytes >= maximumBytes) break;
    }
    return {
      ranges: selected,
      preview: reconstructTextFromRanges(text, selected),
    };
  }

  private fitCompactionPlannerRequest(
    load: LoadedTurn,
    entries: readonly CandidateLedgerEntry[],
    build: (entries: readonly CandidateLedgerEntry[]) => CompactionProviderPayload,
  ): {
    readonly entries: readonly CandidateLedgerEntry[];
    readonly payload: CompactionProviderPayload;
  } {
    const model = resolveRuntimeModel(load.acceptanceScope.fastModelId);
    const usableInputTokens = Math.min(
      this.config.aiFastInputMaxTokens,
      model.contextWindow - this.config.aiFastOutputMaxTokens,
    );
    const project = (maximumPreviewBytes: number): readonly CandidateLedgerEntry[] =>
      entries.map((entry) => {
        if (entry.kind !== "conversation_entry") {
          const providerText = entry.text;
          const baseRanges =
            entry.previewRanges.length === 0
              ? [{ charStart: 0, charEnd: providerText.length }]
              : entry.previewRanges;
          const bounded = this.boundedCandidatePreview(
            providerText,
            baseRanges,
            maximumPreviewBytes,
          );
          return { ...entry, previewRanges: bounded.ranges, preview: bounded.preview };
        }
        const providerEntry = providerConversationEntries([
          JSON.parse(entry.text) as ConversationEntry,
        ])[0]!;
        const stringFields = Object.keys(providerEntry).filter(
          (key) => typeof providerEntry[key] === "string",
        );
        const fieldBudget =
          stringFields.length === 0 ? 0 : Math.floor(maximumPreviewBytes / stringFields.length);
        const boundedEntry = Object.fromEntries(
          Object.entries(providerEntry).map(([key, value]) => {
            if (typeof value !== "string") return [key, value];
            const bounded = this.boundedCandidatePreview(
              value,
              [{ charStart: 0, charEnd: value.length }],
              Math.max(1, fieldBudget),
            );
            if (bounded.preview.length > 0) return [key, bounded.preview];
            let firstNonWhitespaceFound = false;
            let offset = 0;
            let firstScalarEnd = 0;
            while (offset < value.length) {
              const codePoint = value.codePointAt(offset)!;
              const scalarLength = codePoint > 0xffff ? 2 : 1;
              const scalarEnd = offset + scalarLength;
              if (firstScalarEnd === 0) firstScalarEnd = scalarEnd;
              const scalar = value.slice(offset, scalarEnd);
              offset = scalarEnd;
              if (scalar.trim().length > 0) {
                firstNonWhitespaceFound = true;
                break;
              }
            }
            return [key, value.slice(0, firstNonWhitespaceFound ? offset : firstScalarEnd)];
          }),
        );
        const preview = JSON.stringify(boundedEntry);
        return {
          ...entry,
          previewRanges: [{ charStart: 0, charEnd: preview.length }],
          preview,
        };
      });
    const fits = (maximumPreviewBytes: number): boolean => {
      // A zero-byte probe must contain only the mandatory planner fields. In
      // particular, do not force one scalar from each conversation field into
      // this probe: that would make the mandatory-size check depend on an
      // arbitrary preview fallback rather than the actual zero-preview gate.
      const payload = build(maximumPreviewBytes === 0 ? [] : project(maximumPreviewBytes));
      const request = structuredRequestInput(
        payload.system,
        payload.user,
        load.acceptanceScope.fastModelId,
        this.config.aiFastOutputMaxTokens,
        payload.outputToolName,
        payload.outputToolDescription,
        payload.outputSchema,
      );
      return model.countRequestTokens(request) <= usableInputTokens;
    };
    if (!fits(0)) throw controlledRuntimeFailure("context_mandatory_too_large");
    let budget = Math.min(
      CANDIDATE_CONTRACT_LIMITS.maxPreviewUtf8Bytes,
      Math.floor(COMPACTION_PLANNER_TOTAL_PREVIEW_UTF8_BYTES / Math.max(1, entries.length)),
    );
    while (budget > 0 && !fits(budget)) {
      budget = Math.floor(budget / 2);
    }
    const fittedEntries = project(budget);
    return { entries: fittedEntries, payload: build(fittedEntries) };
  }

  private freezeCandidateLedger(value: CandidateLedger): CandidateLedger {
    const freeze = <T>(item: T): T => {
      if (item !== null && typeof item === "object" && !Object.isFrozen(item)) {
        for (const child of Object.values(item as Record<string, unknown>)) freeze(child);
        Object.freeze(item);
      }
      return item;
    };
    return freeze(value);
  }

  private buildCandidateLedger(
    candidates: readonly AnswerCandidate[],
    modelId: RuntimeModelId,
    selectedConversation: readonly ConversationEntry[] = [],
  ): CandidateLedger {
    const conversationEntries = selectedConversation.map((entry, index): CandidateLedgerEntry => {
      const normalizedEntry: ConversationEntry =
        "assistantContent" in entry
          ? { ...entry, assistantContent: stripHistoricalCitationTags(entry.assistantContent) }
          : entry;
      const text = JSON.stringify(normalizedEntry);
      const ranges = [{ charStart: 0, charEnd: text.length }];
      const bounded = this.boundedCandidatePreview(text, ranges);
      return Object.freeze({
        candidateId: candidateLocalId(index + 1),
        kind: "conversation_entry" as const,
        identity: {
          kind: "conversation_entry" as const,
          turnId: normalizedEntry.turnId,
          userMessageId: normalizedEntry.userMessageId,
          ...("assistantMessageId" in normalizedEntry
            ? { assistantMessageId: normalizedEntry.assistantMessageId }
            : {}),
        },
        provenance: Object.freeze({
          label: null,
          purpose: "plan-turn-selected recent turn",
          date: null,
        }),
        text,
        baseRanges: Object.freeze(ranges),
        previewRanges: Object.freeze([...bounded.ranges]),
        preview: bounded.preview,
        renderedTokenCount: this.visibleTokenCount(text, modelId),
      });
    });
    const evidenceEntries = candidates.map((candidate, index): CandidateLedgerEntry => {
      const rawText = candidate.kind === "document" ? candidate.text : candidateText(candidate);
      const chatRole =
        candidate.kind === "chat_message"
          ? (candidate as AnswerCandidate & { readonly chatRole?: "user" | "assistant" }).chatRole
          : undefined;
      const text =
        candidate.kind === "chat_message" && chatRole === "assistant"
          ? stripHistoricalCitationTags(rawText)
          : rawText;
      const baseRanges =
        candidate.kind === "document" ? candidate.ranges : [{ charStart: 0, charEnd: text.length }];
      const bounded = this.boundedCandidatePreview(text, baseRanges);
      return Object.freeze({
        candidateId: candidateLocalId(selectedConversation.length + index + 1),
        kind: candidate.kind,
        identity: this.candidateIdentity(candidate),
        provenance: Object.freeze({
          label: candidate.label,
          purpose: candidate.purpose,
          date:
            candidate.kind === "document"
              ? (candidate.publicProvenance.publishedAt ?? null)
              : candidate.kind === "web"
                ? (candidate.publishedAt ?? null)
                : null,
        }),
        text,
        baseRanges: Object.freeze([...baseRanges]),
        previewRanges: Object.freeze([...bounded.ranges]),
        ...(candidate.kind === "chat_message" && chatRole !== undefined ? { chatRole } : {}),
        preview: bounded.preview,
        renderedTokenCount: candidate.renderedTokenCount || this.visibleTokenCount(text, modelId),
      });
    });
    return this.freezeCandidateLedger(
      CandidateLedgerSchema.parse({
        candidates: Object.freeze([...conversationEntries, ...evidenceEntries]),
      }) as CandidateLedger,
    );
  }

  private updateCandidateLedgerTokenCounts(
    ledger: CandidateLedger,
    candidates: readonly AnswerCandidate[],
    counts: readonly number[],
    conversationCounts: readonly number[] = [],
  ): CandidateLedger {
    const evidenceEntries = ledger.candidates.filter(
      (entry) => entry.kind !== "conversation_entry",
    );
    if (evidenceEntries.length !== candidates.length || counts.length !== candidates.length)
      return ledger;
    return this.freezeCandidateLedger(
      CandidateLedgerSchema.parse({
        candidates: Object.freeze(
          ledger.candidates.map((entry) => {
            if (entry.kind === "conversation_entry") {
              const index = ledger.candidates
                .slice(0, ledger.candidates.indexOf(entry))
                .filter((candidate) => candidate.kind === "conversation_entry").length;
              return Object.freeze({
                ...entry,
                renderedTokenCount: conversationCounts[index] ?? entry.renderedTokenCount,
              });
            }
            const index = evidenceEntries.indexOf(entry);
            return Object.freeze({
              ...entry,
              renderedTokenCount: counts[index] ?? entry.renderedTokenCount,
            });
          }),
        ),
      }) as CandidateLedger,
    );
  }

  private selectConversation(
    entries: readonly ConversationEntry[],
    selectedTurnIds: readonly string[],
  ): readonly ConversationEntry[] {
    const selected = new Set(selectedTurnIds);
    return entries.filter((entry) => selected.has(entry.turnId));
  }

  private async rejectSelectedConversationDuplicates(
    load: LoadedTurn,
    candidates: readonly AnswerCandidate[],
    selectedConversation: readonly ConversationEntry[],
    observationTaskId: string,
  ): Promise<{
    readonly candidates: readonly AnswerCandidate[];
    readonly rejections: readonly CandidateRejection[];
  }> {
    const recentMessageIds = new Set(
      selectedConversation.flatMap((entry) => [
        entry.userMessageId,
        ...("assistantMessageId" in entry ? [entry.assistantMessageId] : []),
      ]),
    );
    const rejections = candidates.flatMap((candidate) =>
      candidate.kind === "chat_message" && recentMessageIds.has(candidate.messageId)
        ? [
            {
              candidateId: chatMessageEvidenceIdentity(candidate.messageId),
              reason: "duplicate" as const,
            },
          ]
        : [],
    );
    await Promise.all(
      rejections.map((rejection, index) =>
        this.observe(
          load,
          observationTaskId,
          "candidate_rejected",
          rejection,
          undefined,
          `selected-conversation-duplicate-${index}`,
        ),
      ),
    );
    return {
      candidates: candidates.filter(
        (candidate) =>
          candidate.kind !== "chat_message" || !recentMessageIds.has(candidate.messageId),
      ),
      rejections,
    };
  }

  private deduplicateCandidates(candidates: readonly AnswerCandidate[]): AnswerCandidate[] {
    const unique = new Map<string, AnswerCandidate>();
    for (const candidate of candidates) {
      const previous = unique.get(candidate.id);
      if (previous === undefined) {
        unique.set(candidate.id, candidate);
        continue;
      }
      if (previous.kind === "document" && candidate.kind === "document") {
        if (
          previous.publisherIssueId !== candidate.publisherIssueId ||
          previous.publisherDocumentId !== candidate.publisherDocumentId
        ) {
          throw new Error(
            `document ${candidate.documentId} resolved to ambiguous public/publisher provenance`,
          );
        }
        if (
          previous.snapshotId !== candidate.snapshotId ||
          previous.contentHash !== candidate.contentHash
        ) {
          throw new Error(
            `document ${candidate.documentId} resolved to multiple immutable versions in one context`,
          );
        }
        unique.set(candidate.id, {
          ...previous,
          rank: Math.min(previous.rank, candidate.rank),
          ranges: normalizeCharacterRanges(
            [...previous.ranges, ...candidate.ranges],
            previous.text.length,
          ),
        });
      }
    }
    return [...unique.values()];
  }

  private visibleTokenCount(text: string, modelId: string): number {
    return resolveRuntimeModel(modelId).countTextTokens(text);
  }

  private boundedToolItems<Item>(
    items: readonly Item[],
    cursor: number,
    options: {
      readonly hardLimitTruncated?: boolean | undefined;
      readonly maximumResults?: number | undefined;
      readonly modelId: RuntimeModelId;
      readonly sourceExposureMarker?:
        | ((item: Item) => ReturnType<typeof providerVisibleExposureMarker>)
        | undefined;
    },
  ): {
    readonly items: readonly Item[];
    readonly complete: boolean;
    readonly truncated: boolean;
    readonly cursor: number | null;
    readonly scope: {
      readonly kind: "bounded_search_result_set";
      readonly offset: number;
      readonly resultSetSize: number;
      readonly maximumResults: number;
      readonly hardLimitReached: boolean;
      readonly cursorSupported: boolean;
    };
    readonly nextItemTooLarge?: true | undefined;
  } {
    if (cursor > items.length) throw new Error("search cursor is outside the bounded result set");
    const resultFor = (selected: readonly Item[], next: number) => {
      const tokenTruncated = next < items.length;
      const hardLimitTruncated = options.hardLimitTruncated === true && !tokenTruncated;
      return {
        items: selected,
        complete: !tokenTruncated && !hardLimitTruncated,
        truncated: tokenTruncated || hardLimitTruncated,
        cursor: tokenTruncated ? next : null,
        scope: {
          kind: "bounded_search_result_set" as const,
          offset: cursor,
          resultSetSize: items.length,
          maximumResults: options.maximumResults ?? items.length,
          hardLimitReached: hardLimitTruncated,
          cursorSupported: tokenTruncated,
        },
        ...(options.sourceExposureMarker === undefined
          ? {}
          : {
              __hartlibSourceExposures: selected.map(options.sourceExposureMarker),
            }),
        ...(selected.length === 0 && tokenTruncated ? { nextItemTooLarge: true as const } : {}),
      };
    };
    const selected: Item[] = [];
    for (let index = cursor; index < items.length; index += 1) {
      const item = items[index];
      if (item === undefined) break;
      if (
        this.visibleTokenCount(
          JSON.stringify(resultFor([...selected, item], index + 1)),
          options.modelId,
        ) > this.config.aiFastOutputMaxTokens
      ) {
        break;
      }
      selected.push(item);
    }
    const next = cursor + selected.length;
    return resultFor(selected, next);
  }

  private async materializeCandidates(
    load: LoadedTurn,
    selectors: SelectorBundle,
    observationTaskId: string,
  ): Promise<{
    readonly candidates: readonly AnswerCandidate[];
    readonly rejections: readonly CandidateRejection[];
  }> {
    const candidates: AnswerCandidate[] = [];
    const rejections: CandidateRejection[] = [];
    let rank = 0;
    const structured = selectors.structuredInternal;
    if (structured === undefined) {
      throw new Error("structured retrieval result is required");
    }
    if (structured !== null) {
      if (
        typeof structured !== "object" ||
        !structured.fused ||
        typeof structured.fused !== "object" ||
        !Array.isArray(structured.fused.results)
      ) {
        throw new Error("structured retrieval result has an invalid fused result set");
      }
      const fusedResults = structured.fused.results as RetrievalPlanResult["fused"]["results"];
      for (const fused of fusedResults) {
        const identity = fused.identity;
        const value = fused.value as HydratedReviewValue;
        const queryPlan = structured.queryPlan;
        const queries = queryPlan.action === "search" ? queryPlan.queries : [];
        const purpose =
          fused.matchedQueryOrdinals
            .map((ordinal) => queries[ordinal - 1]?.purpose)
            .find(
              (candidatePurpose): candidatePurpose is string => candidatePurpose !== undefined,
            ) ?? "structured internal retrieval";
        if (identity.kind === "chat_message") {
          const chatRole =
            value.label === "assistant" ? "assistant" : value.label === "user" ? "user" : undefined;
          if (chatRole === undefined) {
            rejections.push({
              candidateId: JSON.stringify(this.canonicalRetrievalIdentity(identity)),
              reason: "invalid_range",
            });
            continue;
          }
          candidates.push({
            id: JSON.stringify(this.canonicalRetrievalIdentity(identity)),
            kind: "chat_message",
            rank: rank++,
            purpose,
            messageId: identity.messageId,
            text: value.text,
            label: value.label,
            chatRole,
            renderedTokenCount: value.mainTokenCount,
          } as AnswerCandidate);
          continue;
        }
        const ranges = [{ charStart: 0, charEnd: value.text.length }];
        if (value.text.length === 0) {
          rejections.push({
            candidateId: JSON.stringify(this.canonicalRetrievalIdentity(identity)),
            reason: "missing",
          });
          continue;
        }
        if (identity.kind === "public_document") {
          const row = await this.db(
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              const rows = yield* sql<{
                readonly sourceName: string;
                readonly documentTitle: string;
                readonly citationUrl: string;
                readonly publishedAt: Date | null;
              }>`
                select s.display_name as "sourceName", d.title as "documentTitle",
                       d.canonical_url as "citationUrl", d.published_at as "publishedAt"
                from public_source_documents d
                join public_sources s on s.source_id = d.source_id
                where d.source_id = ${identity.sourceId}
                  and d.document_id = ${identity.documentId}
              `;
              return rows[0] ?? null;
            }),
          );
          if (row === null) {
            rejections.push({
              candidateId: JSON.stringify(this.canonicalRetrievalIdentity(identity)),
              reason: "inaccessible",
            });
            continue;
          }
          candidates.push({
            id: JSON.stringify(this.canonicalRetrievalIdentity(identity)),
            kind: "document",
            rank: rank++,
            purpose,
            sourceId: `public:${identity.sourceId}`,
            documentId: identity.documentId,
            snapshotId: value.snapshotId,
            contentHash: value.contentHash,
            text: value.text,
            ranges,
            label: value.label ?? row.documentTitle,
            publicProvenance: {
              sourceName: value.sourceName ?? row.sourceName,
              documentTitle: row.documentTitle,
              citationUrl: row.citationUrl,
              ...((value.date ?? row.publishedAt?.toISOString()) === undefined
                ? {}
                : { publishedAt: value.date ?? row.publishedAt!.toISOString() }),
            },
            renderedTokenCount: value.mainTokenCount,
          });
          continue;
        }
        if (identity.kind !== "publisher_document") {
          rejections.push({
            candidateId: JSON.stringify(this.canonicalRetrievalIdentity(identity)),
            reason: "missing",
          });
          continue;
        }
        const row = await this.db(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const rows = yield* sql<{
              readonly sourceName: string;
              readonly documentTitle: string;
              readonly citationUrl: string;
              readonly issueId: string;
              readonly issueTitle: string;
              readonly publishedAt: Date | null;
              readonly sourceId: string;
            }>`
              select companies.name as "sourceName", documents.title as "documentTitle",
                     '/v1/issues/' || issues.id::text || '/documents/' || documents.id::text || '/content' as "citationUrl",
                     issues.id::text as "issueId", issues.title as "issueTitle", issues.published_at as "publishedAt",
                     subscriptions.id::text as "sourceId"
              from hartlib_documents documents
              join publisher_issues issues on issues.id = documents.issue_id
              join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
              join publisher_companies companies on companies.id = subscriptions.publisher_company_id
                where subscriptions.id::text = ${identity.subscriptionId}
                and issues.id::text = ${identity.issueId}
                and documents.id::text = ${identity.documentId}
            `;
            return rows[0] ?? null;
          }),
        );
        if (row === null) {
          rejections.push({
            candidateId: JSON.stringify(this.canonicalRetrievalIdentity(identity)),
            reason: "inaccessible",
          });
          continue;
        }
        candidates.push({
          id: JSON.stringify(this.canonicalRetrievalIdentity(identity)),
          kind: "document",
          rank: rank++,
          purpose,
          sourceId: `publisher:${identity.subscriptionId}`,
          documentId: identity.documentId,
          snapshotId: value.snapshotId,
          publisherExtractionId: identity.publisherExtractionId,
          publisherIssueId: identity.issueId,
          publisherDocumentId: identity.documentId,
          contentHash: value.contentHash,
          text: value.text,
          ranges,
          label: value.label ?? row.documentTitle,
          publicProvenance: {
            sourceName: value.sourceName ?? row.sourceName,
            issueTitle: row.issueTitle,
            documentTitle: row.documentTitle,
            citationUrl: row.citationUrl,
            ...((value.date ?? row.publishedAt?.toISOString()) === undefined
              ? {}
              : { publishedAt: value.date ?? row.publishedAt!.toISOString() }),
          },
          renderedTokenCount: value.mainTokenCount,
        });
      }
    }
    for (const reference of selectors.memories) {
      const requested = (await this.loadAcceptedMemorySnapshots(load)).find(
        (item) =>
          item.memoryId === reference.memoryId &&
          item.memoryRevisionId === reference.memoryRevisionId,
      );
      const memory =
        requested === undefined
          ? undefined
          : (
              await this.savedMemorySnapshots(load, [requested], {
                memoryId: reference.memoryId,
              })
            )[0];
      if (memory !== undefined && load.acceptanceScope.memoryMode === "private_owner")
        candidates.push({
          id: memoryEvidenceIdentity(memory.memoryId),
          kind: "memory",
          rank: rank++,
          purpose: "relevant saved memory",
          memoryId: memory.memoryId,
          memoryRevisionId: memory.memoryRevisionId,
          text: memory.content,
          label: null,
          renderedTokenCount: 0,
        });
      else
        rejections.push({
          candidateId: `memory:${reference.memoryId}:${reference.memoryRevisionId}`,
          reason: "inaccessible",
        });
    }
    if (load.acceptanceScope.webRequested || selectors.web.length > 0) {
      await this.validateSavedScope(load);
    }
    for (const evidence of selectors.web) {
      const quote = normalizeWebQuote(evidence.quote);
      candidates.push({
        ...evidence,
        id: webEvidenceIdentity(evidence.url, quote),
        kind: "web",
        rank: rank++,
        url: canonicalizeWebUrl(evidence.url),
        quote,
        quoteHash: webQuoteHash(quote),
        label: evidence.title,
        renderedTokenCount: 0,
      });
    }
    const counts = new Map<string, number>();
    for (const candidate of candidates)
      counts.set(candidate.id, (counts.get(candidate.id) ?? 0) + 1);
    for (const [candidateId, count] of counts) {
      if (count > 1) rejections.push({ candidateId, reason: "duplicate" });
    }
    await Promise.all(
      rejections.map((rejection, index) =>
        this.observe(
          load,
          observationTaskId,
          "candidate_rejected",
          { candidateId: rejection.candidateId, reason: rejection.reason },
          undefined,
          String(index),
        ),
      ),
    );
    return { candidates, rejections };
  }

  private sourceRecord(
    candidate: AnswerCandidate,
    sourceKey: string,
    consumerTaskId: string,
    contextOrder: number,
    topicId?: TopicId,
    chatRanges: readonly SourceRange[] = [],
  ): FinalSourceRecord {
    if (candidate.kind === "topic_packet") {
      throw new Error("topic packet candidates are non-citable and have no source record");
    }
    const use: SerializedSourceUse = {
      consumerTaskId,
      ...(topicId === undefined ? {} : { topicId }),
      contextOrder,
      // measureContext replaces this pre-measurement sentinel with the exact marginal cost
      // of the source inside the real JSON-framed provider request.
      renderedTokenCount: 0,
      ranges:
        candidate.kind === "document"
          ? candidate.ranges
          : candidate.kind === "chat_message"
            ? chatRanges
            : [],
    };
    const locator =
      candidate.kind === "document"
        ? (() => {
            const hasPublisherIssue = candidate.publisherIssueId !== undefined;
            const hasPublisherDocument = candidate.publisherDocumentId !== undefined;
            if (hasPublisherIssue !== hasPublisherDocument) {
              throw new Error("document candidate has incomplete publisher provenance");
            }
            if (hasPublisherIssue) {
              if (
                !isCanonicalPublisherDocumentSourceId(candidate.sourceId) ||
                candidate.publisherDocumentId !== candidate.documentId
              ) {
                throw new Error("document candidate has invalid publisher source identity");
              }
            } else if (!isCanonicalPublicDocumentSourceId(candidate.sourceId)) {
              throw new Error("document candidate has invalid public source identity");
            }
            if (hasPublisherIssue) {
              if (candidate.publisherExtractionId === undefined) {
                throw new Error("publisher document candidate lacks extraction identity");
              }
              return {
                kind: "document" as const,
                sourceId: candidate.sourceId as `publisher:${string}`,
                documentId: candidate.documentId,
                snapshotId: candidate.snapshotId,
                contentHash: candidate.contentHash,
                ranges: candidate.ranges,
                publisherExtractionId: candidate.publisherExtractionId,
                publisherIssueId: candidate.publisherIssueId!,
                publisherDocumentId: candidate.publisherDocumentId!,
              };
            }
            return {
              kind: "document" as const,
              // Candidate identities are already namespaced by retrieval;
              // never repair a raw or double-prefixed value at this boundary.
              sourceId: candidate.sourceId,
              documentId: candidate.documentId,
              snapshotId: candidate.snapshotId,
              contentHash: candidate.contentHash,
              ranges: candidate.ranges,
            };
          })()
        : candidate.kind === "chat_message"
          ? { kind: "chat_message" as const, messageId: candidate.messageId }
          : candidate.kind === "memory"
            ? {
                kind: "memory" as const,
                memoryId: candidate.memoryId,
                memoryRevisionId: candidate.memoryRevisionId,
              }
            : {
                kind: "web" as const,
                url: candidate.url,
                title: candidate.title,
                domain: candidate.domain,
                quote: candidate.quote,
                quoteHash: candidate.quoteHash,
                ...(candidate.publishedAt === undefined
                  ? {}
                  : { publishedAt: candidate.publishedAt }),
                capturedAt: candidate.capturedAt,
              };
    return {
      sourceKey,
      locator,
      label: candidate.label,
      publicProvenance:
        candidate.kind === "document"
          ? PublicProvenanceSchema.parse(candidate.publicProvenance)
          : candidate.kind === "web"
            ? { citationUrl: candidate.url }
            : {},
      uses: [use],
    };
  }

  private measureContext(
    load: LoadedTurn,
    question: string,
    candidates: readonly AnswerCandidate[],
    sourceMap: readonly FinalSourceRecord[],
    gaps: readonly string[],
    compactionRan: boolean,
    topicId?: TopicId,
    selectedConversation: readonly ConversationEntry[] = [],
    ledgerCandidates: readonly AnswerCandidate[] = candidates,
    ledgerSourceMap: readonly FinalSourceRecord[] = sourceMap,
    requestedOutputTokens: number = this.config.aiMainOutputMaxTokens,
    compactionFeedback: readonly string[] = [],
    ledgerConversation: readonly ConversationEntry[] = selectedConversation,
    ledgerConversationTokenCounts?: readonly number[] | undefined,
    ledgerGaps: readonly string[] = gaps,
    candidateLedger: CandidateLedger = CandidateLedgerSchema.parse({
      candidates: [],
    }) as CandidateLedger,
    chatSourceRanges: readonly ChatContextRange[] = [],
  ): ContextState {
    if (candidates.length !== sourceMap.length) {
      throw new Error("answer candidates and source records must have identical cardinality");
    }
    const renderedSources = sourceMap.map((source, index) => {
      const candidate = candidates[index];
      if (candidate === undefined || source.locator.kind !== candidate.kind) {
        throw new Error("answer candidate does not match its immutable source record");
      }
      return sourceText(
        source.sourceKey,
        source.locator.kind,
        source.label,
        candidateText(
          candidate,
          candidate.kind === "chat_message"
            ? chatSourceRanges.find((item) => item.messageId === candidate.messageId)?.ranges
            : undefined,
        ),
      );
    });
    const visible = renderedSources.join("\n\n");
    const prompt = topicId === undefined ? DirectAnswerPrompt : TopicAnswerPrompt;
    const userInput = (conversation: readonly ConversationEntry[], evidence: string): string =>
      JSON.stringify({
        locale: load.locale,
        originalMessage: load.userMessage,
        question,
        ...(topicId === undefined ? {} : { topicId }),
        selectedConversation: conversation,
        evidence,
        gaps,
      });
    const buildRequest = (
      conversation: readonly ConversationEntry[],
      evidence: string,
    ): LiveProviderRequest =>
      topicId === undefined
        ? fullRequestInput(
            prompt,
            userInput(conversation, evidence),
            load.acceptanceScope.mainModelId,
            requestedOutputTokens,
          )
        : structuredRequestInput(
            prompt,
            userInput(conversation, evidence),
            load.acceptanceScope.mainModelId,
            requestedOutputTokens,
            "emit_topic_packet",
            "Emit a grounded topic packet.",
            z.toJSONSchema(TopicPacketSchema),
          );
    const model = resolveRuntimeModel(load.acceptanceScope.mainModelId);
    const request = buildRequest(selectedConversation, visible);
    const inputTokens = model.countRequestTokens(request);
    const usableInputTokens = Math.min(
      this.config.aiMainInputMaxTokens,
      model.contextWindow - request.requestedOutputTokens,
    );
    const mandatoryInputTokens = model.countRequestTokens(buildRequest([], ""));

    let priorTokens = mandatoryInputTokens;
    const currentConversationTokenCounts = selectedConversation.map((_entry, index) => {
      const nextTokens = model.countRequestTokens(
        buildRequest(selectedConversation.slice(0, index + 1), ""),
      );
      const marginal = nextTokens - priorTokens;
      priorTokens = nextTokens;
      return marginal;
    });
    const sourceTokenCounts = renderedSources.map((_source, index) => {
      const nextTokens = model.countRequestTokens(
        buildRequest(selectedConversation, renderedSources.slice(0, index + 1).join("\n\n")),
      );
      const marginal = nextTokens - priorTokens;
      priorTokens = nextTokens;
      return marginal;
    });
    if (
      priorTokens !== inputTokens ||
      currentConversationTokenCounts.some((count) => count < 0) ||
      sourceTokenCounts.some((count) => count < 0)
    ) {
      throw new Error("JSON-framed discretionary token accounting is inconsistent");
    }
    const measuredSourceMap = sourceMap.map((source, index) => {
      const use = source.uses[0];
      if (use === undefined || source.uses.length !== 1) {
        throw new Error("an answer source must have exactly one consumer before fanout merge");
      }
      return {
        ...source,
        uses: [{ ...use, renderedTokenCount: sourceTokenCounts[index] ?? 0 }],
      };
    });
    const sameCandidateProjection =
      ledgerCandidates.length === candidates.length &&
      ledgerCandidates.every((ledgerCandidate, index) => {
        const currentCandidate = candidates[index];
        if (
          currentCandidate === undefined ||
          ledgerCandidate.id !== currentCandidate.id ||
          ledgerCandidate.kind !== currentCandidate.kind
        ) {
          return false;
        }
        const ledgerChatRanges =
          ledgerCandidate.kind === "chat_message"
            ? chatSourceRanges.find((item) => item.messageId === ledgerCandidate.messageId)?.ranges
            : undefined;
        const currentChatRanges =
          currentCandidate.kind === "chat_message"
            ? chatSourceRanges.find((item) => item.messageId === currentCandidate.messageId)?.ranges
            : undefined;
        return (
          candidateText(ledgerCandidate, ledgerChatRanges) ===
          candidateText(currentCandidate, currentChatRanges)
        );
      });
    const sameSourceProjection =
      ledgerSourceMap.length === sourceMap.length &&
      ledgerSourceMap.every((ledgerSource, index) => {
        const currentSource = sourceMap[index];
        return (
          currentSource !== undefined &&
          ledgerSource.sourceKey === currentSource.sourceKey &&
          stableJson(ledgerSource.locator) === stableJson(currentSource.locator)
        );
      });
    const isInitialEvidenceLedger =
      !compactionRan &&
      sameCandidateProjection &&
      sameSourceProjection &&
      ledgerConversation === selectedConversation;
    const measuredCandidateLedger = isInitialEvidenceLedger
      ? this.updateCandidateLedgerTokenCounts(
          candidateLedger,
          candidates,
          sourceTokenCounts,
          currentConversationTokenCounts,
        )
      : candidateLedger;
    const measuredLedgerSourceMap = isInitialEvidenceLedger ? measuredSourceMap : ledgerSourceMap;
    const measuredLedgerConversationTokenCounts =
      ledgerConversationTokenCounts ??
      (ledgerConversation === selectedConversation
        ? currentConversationTokenCounts
        : ledgerConversation.map((_entry, index) => {
            const before = model.countRequestTokens(
              buildRequest(ledgerConversation.slice(0, index), ""),
            );
            const after = model.countRequestTokens(
              buildRequest(ledgerConversation.slice(0, index + 1), ""),
            );
            return after - before;
          }));
    const status =
      mandatoryInputTokens > usableInputTokens
        ? "failed"
        : inputTokens <= usableInputTokens
          ? "ready"
          : "needs_compaction";
    const consumer: PublicContextConsumer = {
      consumer: topicId === undefined ? "direct" : "topic",
      ...(topicId === undefined ? {} : { topicId }),
      inputTokens,
      requestedOutputTokens: request.requestedOutputTokens,
      usableInputTokens,
    };
    return {
      status,
      question,
      ...(topicId === undefined ? {} : { topicId }),
      candidates,
      candidateLedger: measuredCandidateLedger,
      sourceMap: measuredSourceMap,
      ledgerCandidates,
      ledgerSourceMap: measuredLedgerSourceMap,
      selectedConversation,
      ledgerConversation,
      chatSourceRanges,
      ledgerConversationTokenCounts: measuredLedgerConversationTokenCounts,
      consumers: [consumer],
      gaps,
      ledgerGaps,
      compactionFeedback,
      request,
      inputTokens,
      usableInputTokens,
      compactionRan,
      ...(status === "failed" ? { failureCode: "context_mandatory_too_large" } : {}),
    };
  }

  private compactionPassageOptions(load: LoadedTurn): PassageIndexOptions {
    const model = resolveRuntimeModel(load.acceptanceScope.fastModelId);
    return {
      maxTokens: Math.max(1, Math.min(this.config.aiFastOutputMaxTokens, 256)),
      maxUtf8Bytes: 8_192,
      countTokens: model.countTextTokens,
    };
  }
  private compactionCostOptions(load: LoadedTurn, state: ContextState) {
    const model = resolveRuntimeModel(load.acceptanceScope.mainModelId);
    const sourceByCandidateId = new Map<
      string,
      {
        readonly candidate: AnswerCandidate;
        readonly entry: CandidateLedgerEntry;
        readonly source: FinalSourceRecord;
      }
    >(
      state.ledgerCandidates.flatMap((candidate, index) => {
        const source = state.ledgerSourceMap[index];
        const entry = state.candidateLedger.candidates.find(
          (candidateEntry) => candidateEntry.candidateId === candidate.id,
        );
        return source === undefined || entry === undefined
          ? []
          : [[candidate.id, { candidate, entry, source }] as const];
      }),
    );
    const prompt = state.topicId === undefined ? DirectAnswerPrompt : TopicAnswerPrompt;
    const userInput = (evidence: string): string =>
      JSON.stringify({
        locale: load.locale,
        originalMessage: load.userMessage,
        question: state.question,
        ...(state.topicId === undefined ? {} : { topicId: state.topicId }),
        selectedConversation: state.selectedConversation,
        evidence,
        gaps: state.gaps,
      });
    const buildRequest = (evidence: string): LiveProviderRequest =>
      state.topicId === undefined
        ? fullRequestInput(
            prompt,
            userInput(evidence),
            load.acceptanceScope.mainModelId,
            state.request.requestedOutputTokens,
          )
        : structuredRequestInput(
            prompt,
            userInput(evidence),
            load.acceptanceScope.mainModelId,
            state.request.requestedOutputTokens,
            "emit_topic_packet",
            "Emit a grounded topic packet.",
            z.toJSONSchema(TopicPacketSchema),
          );
    const sourceEntries = state.candidates.flatMap((activeCandidate) => {
      const original = sourceByCandidateId.get(activeCandidate.id);
      if (original === undefined) return [];
      const chatRanges =
        activeCandidate.kind === "chat_message"
          ? state.chatSourceRanges?.find((item) => item.messageId === activeCandidate.messageId)
              ?.ranges
          : undefined;
      return [
        {
          candidateId: activeCandidate.id,
          source: original.source,
          text: candidateText(activeCandidate, chatRanges),
        },
      ];
    });
    const sourceOrder = new Map<string, number>(
      state.candidateLedger.candidates.map((entry, index) => [entry.candidateId, index]),
    );
    const sortSources = (
      sources: readonly {
        readonly candidateId: string;
        readonly source: FinalSourceRecord;
        readonly text: string;
      }[],
    ) =>
      [...sources].sort((left, right) => {
        const byKey = compareSourceKeys(left.source.sourceKey, right.source.sourceKey);
        return byKey !== 0
          ? byKey
          : (sourceOrder.get(left.candidateId) ?? Number.MAX_SAFE_INTEGER) -
              (sourceOrder.get(right.candidateId) ?? Number.MAX_SAFE_INTEGER);
      });
    const serializeSources = (
      sources: readonly {
        readonly candidateId: string;
        readonly source: FinalSourceRecord;
        readonly text: string;
      }[],
    ): string =>
      sortSources(sources)
        .map((source) =>
          sourceText(
            source.source.sourceKey,
            source.source.locator.kind,
            source.source.label,
            source.text,
          ),
        )
        .join("\n\n");
    return {
      countRenderedTokens: (
        sources: readonly RenderedGroupSource[],
        replacedCandidateIds: readonly string[] = sources.map((source) => source.candidateId),
      ) => {
        const replaced = new Set(replacedCandidateIds);
        const baseline = sourceEntries.filter((source) => !replaced.has(source.candidateId));
        const rendered = [
          ...baseline,
          ...sources.map((source) => {
            const original = sourceByCandidateId.get(source.candidateId);
            if (original === undefined) {
              throw new Error(`unknown compaction candidate ${source.candidateId}`);
            }
            return { candidateId: source.candidateId, source: original.source, text: source.text };
          }),
        ];
        const renderedTokens = model.countRequestTokens(buildRequest(serializeSources(rendered)));
        const baselineTokens = model.countRequestTokens(buildRequest(serializeSources(baseline)));
        return Math.max(0, renderedTokens - baselineTokens);
      },
    };
  }

  private compactionLedgerEntry(state: ContextState, candidateId: string): CandidateLedgerEntry {
    const entry = state.candidateLedger.candidates.find(
      (candidate) => candidate.candidateId === candidateId,
    );
    if (entry === undefined) throw new Error(`unknown compaction candidate ${candidateId}`);
    return entry;
  }

  private compactionProviderCandidate(
    entry: CandidateLedgerEntry,
    options: PassageIndexOptions,
    selectedPassageIds?: readonly string[],
  ) {
    if (entry.kind === "topic_packet") {
      throw new Error("topic packets cannot be compacted as source candidates");
    }
    const index = buildCandidatePassageIndex(entry, {
      ...options,
      authorizedRanges: entry.baseRanges,
    });
    const selected =
      selectedPassageIds === undefined
        ? index.passages
        : index.passages.filter((passage) => selectedPassageIds.includes(passage.passageId));
    return {
      candidateId: entry.candidateId,
      kind: entry.kind,
      label: entry.provenance.label,
      purpose: entry.provenance.purpose,
      date: entry.provenance.date,
      passages: selected.map(toProviderPassageView),
    };
  }

  private compactionDocumentReconstruction(
    entry: CandidateLedgerEntry,
    ranges: readonly SourceRange[],
  ): AiDocumentExposureReconstruction | undefined {
    if (entry.identity.kind === "public_document") {
      return {
        sourceId: entry.identity.sourceId,
        documentId: entry.identity.documentId,
        snapshotId: entry.identity.snapshotId,
        contentHash: entry.identity.contentHash,
        ranges,
      };
    }
    if (entry.identity.kind === "publisher_document") {
      return {
        sourceId: entry.identity.subscriptionId.startsWith("publisher:")
          ? entry.identity.subscriptionId
          : `publisher:${entry.identity.subscriptionId}`,
        documentId: entry.identity.documentId,
        snapshotId: entry.identity.snapshotId,
        contentHash: entry.identity.contentHash,
        publisherExtractionId: entry.identity.publisherExtractionId,
        ranges,
      };
    }
    return undefined;
  }

  private compactionProofs(
    load: LoadedTurn,
    entries: readonly CandidateLedgerEntry[],
    options: PassageIndexOptions,
    stage = "context_compaction_input",
    selectedPassageIds?: ReadonlyMap<string, readonly string[]>,
  ): readonly CodeOwnedSourceExposureProof[] {
    const proofs: CodeOwnedSourceExposureProof[] = [];
    for (const entry of entries) {
      if (entry.kind === "conversation_entry" || entry.kind === "topic_packet") continue;
      const index = buildCandidatePassageIndex(entry, {
        ...options,
        authorizedRanges: entry.baseRanges,
      });
      const passages =
        selectedPassageIds?.get(entry.candidateId) === undefined
          ? index.passages
          : index.passages.filter((passage) =>
              selectedPassageIds.get(entry.candidateId)!.includes(passage.passageId),
            );
      for (const passage of passages) {
        const logicalSourceIdentity = compactionLogicalSourceIdentity(entry.identity);
        const contentItemIdentity = compactionContentItemIdentity(
          entry.identity,
          logicalSourceIdentity,
          passage.text,
          { passageId: passage.passageId, range: passage.range },
        );
        const immutableContentHash =
          entry.identity.kind === "chat_message"
            ? entry.identity.sanitizedContentHash
            : entry.identity.kind === "public_document" ||
                entry.identity.kind === "publisher_document"
              ? entry.identity.contentHash
              : createHash("sha256").update(entry.text, "utf8").digest("hex");
        const immutableSourceIdentityCommitment = sha256Base64Url(logicalSourceIdentity);
        const marker = codeOwnedExposureProof(
          {
            sourceKind: entry.kind,
            logicalSourceIdentity,
            contentItemIdentity,
            stage,
            visibleTokenCount: this.visibleTokenCount(
              passage.text,
              load.acceptanceScope.fastModelId,
            ),
          },
          passage.text,
        );
        const charStart = passage.range.charStart;
        const charEnd = passage.range.charEnd;
        const visibleByteCount = new TextEncoder().encode(passage.text).byteLength;
        const compactionBinding = stableJson({
          sourceKind: entry.kind,
          candidateId: entry.candidateId,
          passageId: passage.passageId,
          charStart,
          charEnd,
          visibleByteCount,
          visibleTextHash: sha256Base64Url(passage.text),
        });
        proofs.push({
          ...marker,
          immutableContentHash,
          candidateId: entry.candidateId,
          passageId: passage.passageId,
          charStart,
          charEnd,
          visibleByteCount,
          ...(entry.kind === "document"
            ? {
                documentReconstruction: this.compactionDocumentReconstruction(entry, [
                  passage.range,
                ]),
              }
            : {}),
          ...(entry.identity.kind === "chat_message"
            ? {
                chatReconstruction: {
                  messageId: entry.identity.messageId,
                  contentHash: immutableContentHash,
                  ranges: [passage.range],
                },
              }
            : {}),
          ...(entry.identity.kind === "publisher_document"
            ? {
                publisherIssueId: entry.identity.issueId,
                publisherDocumentId: entry.identity.documentId,
              }
            : {}),
          immutableSourceIdentityCommitment,
          immutableSourceCommitment: providerVisibleSourceExposureCommitment(
            marker,
            compactionBinding,
            immutableContentHash,
            immutableSourceIdentityCommitment,
          ),
        });
      }
    }
    return proofs;
  }
  private compactionPreviewProofs(
    load: LoadedTurn,
    entries: readonly CandidateLedgerEntry[],
    stage = "context_compaction_input",
  ): readonly CodeOwnedSourceExposureProof[] {
    const model = resolveRuntimeModel(load.acceptanceScope.fastModelId);
    return entries.flatMap((entry) => {
      if (entry.kind === "topic_packet" || entry.preview.length === 0) return [];
      if (entry.kind === "conversation_entry") {
        type ProviderConversationPreview =
          | { readonly userContent: string; readonly assistantContent: string }
          | {
              readonly userContent: string;
              readonly errorCode: string;
              readonly retryable: boolean;
            };
        let privateEntry: ConversationEntry;
        let providerEntry: ProviderConversationPreview;
        const proofs: CodeOwnedSourceExposureProof[] = [];
        try {
          const parsedPrivate: unknown = JSON.parse(entry.text);
          const parsedProvider: unknown = JSON.parse(entry.preview);
          if (
            parsedPrivate === null ||
            typeof parsedPrivate !== "object" ||
            Array.isArray(parsedPrivate) ||
            parsedProvider === null ||
            typeof parsedProvider !== "object" ||
            Array.isArray(parsedProvider)
          ) {
            throw new Error("conversation payload is not an object");
          }
          privateEntry = parsedPrivate as ConversationEntry;
          const providerRecord = parsedProvider as Record<string, unknown>;
          const providerKeys = Object.keys(providerRecord);
          const complete =
            providerKeys.length === 2 &&
            providerKeys.includes("userContent") &&
            providerKeys.includes("assistantContent") &&
            typeof providerRecord.userContent === "string" &&
            typeof providerRecord.assistantContent === "string";
          const failed =
            providerKeys.length === 3 &&
            providerKeys.includes("userContent") &&
            providerKeys.includes("errorCode") &&
            providerKeys.includes("retryable") &&
            typeof providerRecord.userContent === "string" &&
            typeof providerRecord.errorCode === "string" &&
            typeof providerRecord.retryable === "boolean";
          if (!complete && !failed) throw new Error("provider preview shape is not canonical");
          providerEntry = complete
            ? {
                userContent: providerRecord.userContent as string,
                assistantContent: providerRecord.assistantContent as string,
              }
            : {
                userContent: providerRecord.userContent as string,
                errorCode: providerRecord.errorCode as string,
                retryable: providerRecord.retryable as boolean,
              };
        } catch {
          throw new Error("conversation compaction candidate is not canonical JSON");
        }
        if (
          entry.identity.kind !== "conversation_entry" ||
          typeof privateEntry.turnId !== "string" ||
          typeof privateEntry.userMessageId !== "string" ||
          typeof privateEntry.userContent !== "string" ||
          privateEntry.turnId !== entry.identity.turnId ||
          privateEntry.userMessageId !== entry.identity.userMessageId
        ) {
          throw new Error(
            "conversation compaction candidate identity does not match its private entry",
          );
        }
        const privateAssistantId =
          "assistantMessageId" in privateEntry ? privateEntry.assistantMessageId : undefined;
        if (privateAssistantId !== entry.identity.assistantMessageId) {
          throw new Error("conversation compaction candidate assistant identity does not match");
        }
        const privateComplete =
          privateAssistantId !== undefined &&
          "assistantContent" in privateEntry &&
          typeof privateEntry.assistantContent === "string";
        const privateFailed =
          privateAssistantId === undefined &&
          "errorCode" in privateEntry &&
          typeof privateEntry.errorCode === "string" &&
          "retryable" in privateEntry &&
          typeof privateEntry.retryable === "boolean";
        if (!privateComplete && !privateFailed) {
          throw new Error("conversation compaction private entry shape is not canonical");
        }
        const providerComplete = "assistantContent" in providerEntry;
        if (privateComplete !== providerComplete) {
          throw new Error("conversation compaction candidate completion shape differs");
        }
        const addConversationProof = (
          messageId: string,
          privateText: string,
          visibleText: string,
        ): void => {
          if (
            privateText.length === 0 ||
            visibleText.length === 0 ||
            !privateText.startsWith(visibleText)
          ) {
            throw new Error("conversation compaction preview is outside its private message range");
          }
          const logicalSourceIdentity = chatMessageEvidenceIdentity(messageId);
          const marker = codeOwnedExposureProof(
            {
              sourceKind: "chat_message",
              logicalSourceIdentity,
              contentItemIdentity: messageId,
              stage,
              visibleTokenCount: model.countTextTokens(visibleText),
            },
            visibleText,
          );
          const charStart = 0;
          const charEnd = visibleText.length;
          const visibleByteCount = new TextEncoder().encode(visibleText).byteLength;
          const immutableContentHash = createHash("sha256")
            .update(privateText, "utf8")
            .digest("hex");
          const immutableSourceIdentityCommitment = sha256Base64Url(logicalSourceIdentity);
          const compactionBinding = stableJson({
            sourceKind: "chat_message",
            candidateId: entry.candidateId,
            passageId: undefined,
            charStart,
            charEnd,
            visibleByteCount,
            visibleTextHash: sha256Base64Url(visibleText),
          });
          proofs.push({
            ...marker,
            candidateId: entry.candidateId,
            charStart,
            charEnd,
            visibleByteCount,
            immutableContentHash,
            chatReconstruction: {
              messageId,
              contentHash: immutableContentHash,
              ranges: [{ charStart, charEnd }],
            },
            immutableSourceIdentityCommitment,
            immutableSourceCommitment: providerVisibleSourceExposureCommitment(
              marker,
              compactionBinding,
              immutableContentHash,
              immutableSourceIdentityCommitment,
            ),
          });
        };
        addConversationProof(
          privateEntry.userMessageId,
          privateEntry.userContent,
          providerEntry.userContent,
        );
        if (
          "assistantMessageId" in privateEntry &&
          "assistantContent" in privateEntry &&
          typeof privateEntry.assistantContent === "string" &&
          "assistantContent" in providerEntry
        ) {
          addConversationProof(
            privateEntry.assistantMessageId,
            privateEntry.assistantContent,
            providerEntry.assistantContent,
          );
        }
        return proofs;
      }
      const ranges = entry.previewRanges;
      if (ranges.length === 0) return [];
      const first = ranges[0]!;
      const last = ranges[ranges.length - 1]!;
      const sourceKind = entry.kind;
      const logicalSourceIdentity = compactionLogicalSourceIdentity(entry.identity);
      const contentItemIdentity = compactionContentItemIdentity(
        entry.identity,
        logicalSourceIdentity,
        entry.preview,
        { previewRanges: ranges },
      );
      const marker = codeOwnedExposureProof(
        {
          sourceKind,
          logicalSourceIdentity,
          contentItemIdentity,
          stage,
          visibleTokenCount: model.countTextTokens(entry.preview),
        },
        entry.preview,
      );
      const charStart = first.charStart;
      const charEnd = last.charEnd;
      const visibleByteCount = new TextEncoder().encode(entry.preview).byteLength;
      const immutableContentHash =
        entry.identity.kind === "chat_message"
          ? entry.identity.sanitizedContentHash
          : entry.identity.kind === "public_document" ||
              entry.identity.kind === "publisher_document"
            ? entry.identity.contentHash
            : createHash("sha256").update(entry.text, "utf8").digest("hex");
      const immutableSourceIdentityCommitment = sha256Base64Url(logicalSourceIdentity);
      const compactionBinding = stableJson({
        sourceKind,
        candidateId: entry.candidateId,
        passageId: undefined,
        charStart,
        charEnd,
        visibleByteCount,
        visibleTextHash: sha256Base64Url(entry.preview),
      });
      return [
        {
          ...marker,
          candidateId: entry.candidateId,
          charStart,
          charEnd,
          visibleByteCount,
          ...(entry.kind === "document"
            ? {
                documentReconstruction: this.compactionDocumentReconstruction(entry, ranges),
              }
            : {}),
          ...(entry.identity.kind === "publisher_document"
            ? {
                publisherIssueId: entry.identity.issueId,
                publisherDocumentId: entry.identity.documentId,
              }
            : {}),
          immutableContentHash,
          ...(entry.identity.kind === "chat_message"
            ? {
                chatReconstruction: {
                  messageId: entry.identity.messageId,
                  contentHash: immutableContentHash,
                  ranges,
                },
              }
            : {}),
          immutableSourceIdentityCommitment,
          immutableSourceCommitment: providerVisibleSourceExposureCommitment(
            marker,
            compactionBinding,
            immutableContentHash,
            immutableSourceIdentityCommitment,
          ),
        },
      ];
    });
  }
  private async recordCompactionExposureProofs(
    load: LoadedTurn,
    taskId: string,
    request: ProviderRequest,
    coordinates: AttestedPiBoundaryCoordinates,
  ): Promise<void> {
    const proofs = request.sourceExposureProofs ?? [];
    if (proofs.length === 0) return;
    const bindings = providerRequestSourceExposureProofBindings(
      request,
      resolveRuntimeModel(request.model).countTextTokens,
    );
    const consumedBindingIndexes = new Set<number>();
    const execution = ownedProviderExecutionCoordinates(taskId, coordinates);
    await Promise.all(
      proofs.map((proof) => {
        if (!("candidateId" in proof) || typeof proof.candidateId !== "string") {
          throw new Error("compaction source exposure proof lacks its candidate ID");
        }
        const codeProof = proof as CodeOwnedSourceExposureProof;
        const bindingIndex = bindings.findIndex((item, index) => {
          if (consumedBindingIndexes.has(index)) return false;
          if (
            item.marker.sourceKind !== proof.sourceKind ||
            item.marker.logicalSourceIdentity !== proof.logicalSourceIdentity ||
            item.marker.contentItemIdentity !== proof.contentItemIdentity ||
            item.marker.exposureStage !== proof.exposureStage ||
            item.marker.visibleTokenCount !== proof.visibleTokenCount
          ) {
            return false;
          }
          if (
            (proof.messageIndex !== undefined &&
              item.binding.messageIndex !== proof.messageIndex) ||
            (proof.serializedField !== undefined &&
              item.binding.serializedField !== proof.serializedField) ||
            (proof.sourceOrdinal !== undefined &&
              item.binding.sourceOrdinal !== proof.sourceOrdinal)
          ) {
            return false;
          }
          let descriptor: Record<string, unknown>;
          try {
            descriptor = JSON.parse(item.binding.orderedSourceDescriptor) as Record<
              string,
              unknown
            >;
          } catch {
            return false;
          }
          return (
            descriptor.candidateId === proof.candidateId &&
            (proof.passageId === undefined || descriptor.passageId === proof.passageId) &&
            (proof.charStart === undefined || descriptor.charStart === proof.charStart) &&
            (proof.charEnd === undefined || descriptor.charEnd === proof.charEnd) &&
            (proof.visibleByteCount === undefined ||
              descriptor.visibleByteCount === proof.visibleByteCount) &&
            (proof.sourceToolCallId === undefined ||
              descriptor.sourceToolCallId === proof.sourceToolCallId) &&
            (proof.sourceResultIndex === undefined ||
              descriptor.sourceResultIndex === proof.sourceResultIndex) &&
            (proof.orderedSourceDescriptor === undefined ||
              proof.orderedSourceDescriptor === item.binding.orderedSourceDescriptor)
          );
        });
        if (bindingIndex < 0) {
          throw new Error("compaction source exposure proof lacks its exact provider binding");
        }
        consumedBindingIndexes.add(bindingIndex);
        const binding = bindings[bindingIndex]!;
        return this.db(
          insertAiSourceExposure({
            runId: load.aiRunId,
            taskId: execution.taskId,
            loopIteration: execution.loopIteration,
            attempt: execution.attempt,
            providerRequestIndex: execution.providerRequestIndex,
            providerRequestSha256Hex: coordinates.providerRequestSha256Hex,
            sourceKind: proof.sourceKind,
            logicalSourceIdentity: proof.logicalSourceIdentity,
            contentItemIdentity: proof.contentItemIdentity,
            exposureStage: proof.exposureStage,
            visibleTokenCount: proof.visibleTokenCount,
            providerSerializationProofBinding: binding.binding,
            ...(codeProof.chatReconstruction === undefined
              ? {}
              : { chatReconstruction: codeProof.chatReconstruction }),
            ...(codeProof.documentReconstruction === undefined
              ? {}
              : {
                  requireCanonicalDocumentIdentity: true,
                  ...(codeProof.publisherIssueId === undefined ||
                  codeProof.publisherDocumentId === undefined
                    ? {}
                    : {
                        publisherIssueId: codeProof.publisherIssueId,
                        publisherDocumentId: codeProof.publisherDocumentId,
                      }),
                  documentReconstruction: codeProof.documentReconstruction,
                }),
          }),
        );
      }),
    );
  }

  private assertSynthesisPacketManifest(
    state: ContextState,
    manifest: InitialContextManifest | FallbackContextManifest,
    fallback: boolean,
  ): void {
    const packets = state.candidateLedger.candidates.filter(
      (candidate) => candidate.kind === "topic_packet",
    );
    if (packets.length === 0) return;
    const decisions = new Map(
      manifest.decisions.map((decision) => [decision.candidateId, decision]),
    );
    const retained = packets.filter((packet) => {
      const decision = decisions.get(packet.candidateId);
      if (decision === undefined) {
        throw new CompactionContractError(
          "synthesis compaction manifest must account for every topic packet",
        );
      }
      if (fallback) {
        if (decision.action !== "retain" && decision.action !== "omit") {
          throw new CompactionContractError("topic packets may only be retained or omitted");
        }
      } else if (decision.action !== "keep" && decision.action !== "omit") {
        throw new CompactionContractError("topic packets may only be kept or omitted");
      }
      return decision.action === (fallback ? "retain" : "keep");
    });
    if (retained.length < 2) {
      throw new CompactionContractError(
        "synthesis compaction must retain at least two topic packets",
      );
    }
  }

  private compactionGroupsForManifest(
    load: LoadedTurn,
    state: ContextState,
    manifest: InitialContextManifest,
    measurementTaskId = "compaction_measure",
  ): readonly CompactionGroup[] {
    const passageOptions = this.compactionPassageOptions(load);
    const costOptions = this.compactionCostOptions(load, state);
    const groupMeasurements = new Map<
      string,
      {
        readonly inputTokens: number;
        readonly usableInputTokens: number;
        readonly selectablePassageCost: number;
      }
    >();
    const ledger = state.candidateLedger;
    for (const declared of manifest.groups) {
      const declaredCandidateIds = new Set(
        manifest.decisions
          .filter(
            (decision) => decision.action === "compact" && decision.groupId === declared.groupId,
          )
          .map((decision) => decision.candidateId),
      );
      const candidateIds = ledger.candidates
        .map((candidate) => candidate.candidateId)
        .filter((candidateId) => declaredCandidateIds.has(candidateId));
      const candidates = candidateIds.map((candidateId) =>
        this.compactionProviderCandidate(
          this.compactionLedgerEntry(state, candidateId),
          passageOptions,
        ),
      );
      const group = {
        ...declared,
        candidateIds,
        mode: "normal" as const,
      };
      const payload = buildGroupCompactionRequest(load, {
        taskId: measurementTaskId,
        phase: "compact",
        question: state.question,
        group,
        candidates,
      });
      const request = structuredRequestInput(
        payload.system,
        payload.user,
        load.acceptanceScope.fastModelId,
        this.config.aiFastOutputMaxTokens,
        payload.outputToolName,
        payload.outputToolDescription,
        payload.outputSchema,
      );
      const model = resolveRuntimeModel(request.model);
      const usableInputTokens = Math.min(
        this.config.aiFastInputMaxTokens,
        model.contextWindow - request.requestedOutputTokens,
      );
      let selectablePassageCost: number | undefined;
      for (const candidate of candidates) {
        const entry = this.compactionLedgerEntry(state, candidate.candidateId);
        const passageIndex = buildCandidatePassageIndex(entry, {
          ...passageOptions,
          authorizedRanges: entry.baseRanges,
        });
        for (const passage of candidate.passages) {
          const sourcePassage = passageIndex.passages.find(
            (item) => item.passageId === passage.passageId,
          );
          if (sourcePassage === undefined) {
            throw new CompactionContractError(
              `group ${declared.groupId} has an unknown selectable passage`,
            );
          }
          const cost = costOptions.countRenderedTokens(
            [
              {
                candidateId: candidate.candidateId,
                text: passage.text,
                passageIds: [passage.passageId],
                ranges: [sourcePassage.range],
              },
            ],
            candidateIds,
          );
          if (!Number.isSafeInteger(cost) || cost < 0) {
            throw new CompactionContractError(
              `group ${declared.groupId} selectable passage cost is invalid`,
            );
          }
          if (cost <= declared.renderedTokenBudget) {
            selectablePassageCost = cost;
            break;
          }
        }
        if (selectablePassageCost !== undefined) break;
      }
      if (selectablePassageCost === undefined) {
        throw new CompactionContractError(
          `group ${declared.groupId} budget is below its smallest selectable passage cost`,
        );
      }
      groupMeasurements.set(declared.groupId, {
        inputTokens: model.countRequestTokens(request),
        usableInputTokens,
        selectablePassageCost,
      });
    }
    const sourceToolEligibleCandidateIds = manifest.decisions
      .filter((decision) => decision.action === "compact")
      .filter((decision) => {
        const memberCount = manifest.decisions.filter(
          (item) => item.action === "compact" && item.groupId === decision.groupId,
        ).length;
        if (memberCount !== 1) return false;
        const entry = this.compactionLedgerEntry(state, decision.candidateId);
        const measurement = groupMeasurements.get(decision.groupId);
        return (
          (entry.kind === "document" || entry.kind === "chat_message") &&
          measurement !== undefined &&
          measurement.inputTokens > measurement.usableInputTokens
        );
      })
      .map((decision) => decision.candidateId);
    const measurement = this.contextMeasurementPayload(
      state,
      measurementTaskId,
      state.citationSourceMap !== undefined
        ? "synthesis"
        : state.topicId === undefined
          ? "direct"
          : "topic",
    );
    return createPureCompactionGroups(manifest, ledger, {
      sourceToolEligibleCandidateIds,
      remainingAnswerTokens: state.usableInputTokens - measurement.mandatoryInputTokens,
      groupMeasurements,
    });
  }

  async initialCompactionManifest(
    load: LoadedTurn,
    state: ContextState,
    taskId: string,
  ): Promise<InitialContextManifest> {
    if (state.status !== "needs_compaction") {
      throw new Error("initial compaction manifest requires an oversized context");
    }
    const execution = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    const planner = this.fitCompactionPlannerRequest(
      load,
      state.candidateLedger.candidates,
      (entries) =>
        buildInitialCompactionRequest(
          load,
          {
            question: state.question,
            allowance: state.usableInputTokens,
            overage: state.inputTokens - state.usableInputTokens,
            mandatoryInputCost: this.contextMeasurementPayload(
              state,
              taskId,
              state.citationSourceMap !== undefined
                ? "synthesis"
                : state.topicId === undefined
                  ? "direct"
                  : "topic",
            ).mandatoryInputTokens,
            candidates: entries.map((candidate) => ({
              candidateId: candidate.candidateId,
              kind: candidate.kind,
              label: candidate.provenance.label,
              purpose: candidate.provenance.purpose,
              date: candidate.provenance.date,
              renderedTokenCount: candidate.renderedTokenCount,
              preview:
                candidate.kind === "conversation_entry"
                  ? JSON.parse(candidate.preview)
                  : candidate.preview,
            })),
            toolBounds: {
              maximumCandidates: Math.max(1, entries.length),
              maximumGroups: Math.max(1, entries.length),
            },
          },
          taskId,
        ),
    );
    const payload = planner.payload;
    const taskEvidence = await this.compactionTaskEvidence(load.aiRunId, taskId);
    this.assertCompactionTaskNotConsumed(taskEvidence);
    const repairAlreadyUsed =
      this.compactionRepairTaskIds.has(taskId) || taskEvidence.repairConsumed;
    const requestUser = payload.user;
    const output = await this.agents.structured<InitialContextManifest>({
      requestClass: "fast",
      model: load.acceptanceScope.fastModelId,
      ...payload,
      validate: (value) => {
        const validated = validateInitialContextManifest(value, state.candidateLedger);
        this.assertSynthesisPacketManifest(state, validated, false);
        this.compactionGroupsForManifest(load, state, validated, taskId);
        return validated;
      },
      repair: () => {
        if (repairAlreadyUsed) return undefined;
        this.compactionRepairTaskIds.add(taskId);
        return {
          user: JSON.stringify({
            ...JSON.parse(requestUser),
            priorValidationFeedback: "schema_invalid",
          }),
        };
      },
      requestedOutputTokens: this.config.aiFastOutputMaxTokens,
      reasoning: "medium",
      sourceExposureProofs: this.compactionPreviewProofs(load, planner.entries),
      coordinates: taskCoordinates(taskId, "context_manifest", execution),
      onBeforeRequest: async (request, requestCoordinates) => {
        await this.validateFrozenScope(load, state);
        await this.recordCompactionExposureProofs(load, taskId, request, requestCoordinates);
      },
    });
    return output;
  }

  async createCompactionGroups(
    load: LoadedTurn,
    state: ContextState,
    manifest: InitialContextManifest,
    taskId: string,
  ): Promise<readonly CompactionGroup[]> {
    const validated = validateInitialContextManifest(manifest, state.candidateLedger);
    this.assertSynthesisPacketManifest(state, validated, false);
    return this.compactionGroupsForManifest(load, state, validated, taskId);
  }
  private async normalCompactionGroup(
    load: LoadedTurn,
    state: ContextState,
    group: CompactionGroup,
    taskId: string,
    phase: CompactionPhase,
    priorResult?: GroupResultEnvelope,
    tightenCandidateIds?: readonly string[],
  ): Promise<GroupResultEnvelope> {
    const execution = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    const taskEvidence = await this.compactionTaskEvidence(load.aiRunId, taskId);
    this.assertCompactionTaskNotConsumed(taskEvidence);
    const repairAlreadyUsed =
      this.compactionRepairTaskIds.has(taskId) || taskEvidence.repairConsumed;
    const passageOptions = this.compactionPassageOptions(load);
    const priorPassageIds = new Map<string, readonly string[]>();
    const entries = group.candidateIds.map((candidateId) => {
      const entry = this.compactionLedgerEntry(state, candidateId);
      const previous = priorResult?.result.decisions.find(
        (decision) => decision.candidateId === candidateId,
      );
      if (previous?.action === "select") {
        priorPassageIds.set(candidateId, previous.passageIds);
      }
      return entry;
    });
    const candidates = entries.map((entry) =>
      this.compactionProviderCandidate(
        entry,
        passageOptions,
        priorPassageIds.get(entry.candidateId),
      ),
    );
    const runtimeRequest: NormalCompactionRequest = {
      taskId,
      phase,
      question: state.question,
      group,
      candidates,
      ...(priorResult === undefined ? {} : { priorResult: priorResult.result }),
    };
    const payload = buildGroupCompactionRequest(load, runtimeRequest);
    const requestUser = payload.user;
    const proofs = this.compactionProofs(
      load,
      entries,
      passageOptions,
      "context_compaction_input",
      priorPassageIds,
    );
    const measure = (result: GroupCompactionResult): number => {
      const byId = new Map(
        group.candidateIds.map((candidateId) => [
          candidateId,
          buildCandidatePassageIndex(this.compactionLedgerEntry(state, candidateId), {
            ...passageOptions,
            authorizedRanges: this.compactionLedgerEntry(state, candidateId).baseRanges,
          }),
        ]),
      );
      const sources = result.decisions.flatMap((decision) => {
        if (decision.action === "omit") return [];
        const index = byId.get(decision.candidateId);
        if (index === undefined) throw new Error("compaction result names an unknown candidate");
        const ranges = mapPassageIdsToRanges(index, decision.passageIds);
        return [
          {
            candidateId: decision.candidateId,
            text: selectedTextFromRanges(index.text, ranges),
            passageIds: [...decision.passageIds],
            ranges,
          },
        ];
      });
      return this.compactionCostOptions(load, state).countRenderedTokens(
        sources,
        group.candidateIds,
      );
    };
    const validate = (value: unknown): GroupResultEnvelope => {
      const parsed = GroupCompactionResultSchema.parse(value);
      const result =
        priorResult === undefined
          ? parsed
          : validateFallbackGroupCompactionResult(
              parsed,
              group,
              state.candidateLedger,
              priorResult.result,
              tightenCandidateIds ?? [],
              passageOptions,
            );
      return GroupResultEnvelopeSchema.parse(
        validateGroupResultEnvelope(
          {
            groupId: group.groupId,
            result,
            renderedTokenCount: measure(result),
          },
          group,
          state.candidateLedger,
          passageOptions,
          this.compactionCostOptions(load, state),
        ),
      );
    };
    const request = {
      requestClass: "fast" as const,
      model: load.acceptanceScope.fastModelId,
      ...payload,
      validate,
      repair: () => {
        if (repairAlreadyUsed) return undefined;
        this.compactionRepairTaskIds.add(taskId);
        return {
          user: JSON.stringify({
            ...JSON.parse(requestUser),
            priorValidationFeedback: "schema_invalid",
          }),
        };
      },
      requestedOutputTokens: this.config.aiFastOutputMaxTokens,
      reasoning: "medium" as const,
      coordinates: taskCoordinates(taskId, `context_${phase}_group`, execution),
      sourceExposureProofs: proofs,
      onBeforeRequest: async (
        request: ProviderRequest,
        requestCoordinates: AttestedPiBoundaryCoordinates,
      ) => {
        await this.validateFrozenScope(load, state);
        await this.recordCompactionExposureProofs(load, taskId, request, requestCoordinates);
      },
    };
    return this.agents.structured(request);
  }
  private async sourceToolCompactionGroup(
    load: LoadedTurn,
    state: ContextState,
    group: CompactionGroup,
    taskId: string,
    phase: CompactionPhase,
    priorResult?: GroupResultEnvelope,
    tightenCandidateIds?: readonly string[],
  ): Promise<GroupResultEnvelope> {
    if (group.candidateIds.length !== 1) {
      throw new Error("source-tool compaction requires one candidate");
    }
    const candidate = this.compactionLedgerEntry(state, group.candidateIds[0]!);
    if (candidate.kind !== "document" && candidate.kind !== "chat_message") {
      throw new Error("source-tool compaction requires a document or chat candidate");
    }
    const sourceKind: "document" | "chat_message" = candidate.kind;
    const toolBounds = {
      maximumTurns: DEFAULT_SOURCE_COMPACTION_TOOL_BOUNDS.maximumTurns,
      maximumResults: DEFAULT_SOURCE_COMPACTION_TOOL_BOUNDS.maximumResults,
      maximumBytes: DEFAULT_SOURCE_COMPACTION_TOOL_BOUNDS.maximumBytes,
    } as const;
    const passageOptions = this.compactionPassageOptions(load);
    const index = buildCandidatePassageIndex(candidate, {
      ...passageOptions,
      authorizedRanges: candidate.baseRanges,
    });
    const fastModel = resolveRuntimeModel(load.acceptanceScope.fastModelId);
    const usableFastInputTokens = Math.max(
      1,
      Math.min(
        this.config.aiFastInputMaxTokens,
        fastModel.contextWindow - this.config.aiFastOutputMaxTokens,
      ),
    );
    const maximumSourceResultTokens = Math.max(
      1,
      Math.min(
        toolBounds.maximumResults * passageOptions.maxTokens,
        Math.floor(usableFastInputTokens * 0.75),
      ),
    );
    const priorDecision = priorResult?.result.decisions.find(
      (decision) => decision.candidateId === candidate.candidateId,
    );
    const priorPassageIds = priorDecision?.action === "select" ? priorDecision.passageIds : [];
    const priorPassageIdSet = new Set(priorPassageIds);
    const passages = index.passages
      .filter((passage) => priorResult === undefined || priorPassageIdSet.has(passage.passageId))
      .map(toProviderPassageView);
    const discovered = new Set<string>();
    let terminalReady = false;
    const exposedSourcePassages = new Map<string, string>();
    let exposedSourceResultCount = 0;
    let exposedSourceResultBytes = 0;
    let exposedSourceResultTokens = 0;
    const assertSourceToolResultBound = (
      items: readonly PassageView[],
      result: Readonly<Record<string, unknown>>,
    ): void => {
      const pending = new Map<string, string>();
      for (const item of items) {
        const key = item.passageId;
        const previous = exposedSourcePassages.get(key) ?? pending.get(key);
        if (previous !== undefined && previous !== item.text) {
          throw new Error("source-tool passage identity changed across results");
        }
        pending.set(key, item.text);
      }
      const serializedResult = toolResultJson(result);
      const resultBytes = new TextEncoder().encode(serializedResult).byteLength;
      const resultTokens = fastModel.countTextTokens(serializedResult);
      const nextCount = exposedSourceResultCount + items.length;
      const nextBytes = exposedSourceResultBytes + resultBytes;
      const nextTokens = exposedSourceResultTokens + resultTokens;
      if (
        nextCount > toolBounds.maximumResults ||
        nextBytes > toolBounds.maximumBytes ||
        nextTokens > maximumSourceResultTokens
      ) {
        throw new Error("source-tool result exceeds its cumulative bound");
      }
      exposedSourceResultCount = nextCount;
      exposedSourceResultBytes = nextBytes;
      exposedSourceResultTokens = nextTokens;
      for (const [key, text] of pending) {
        exposedSourcePassages.set(key, text);
      }
    };
    const execution = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    const taskEvidence = await this.compactionTaskEvidence(load.aiRunId, taskId);
    this.assertCompactionTaskNotConsumed(taskEvidence);
    const repairAlreadyUsed =
      this.compactionRepairTaskIds.has(taskId) || taskEvidence.repairConsumed;
    const markerForPassage = (passageId: string): ProviderVisibleSourceExposureMarker => {
      const passage = index.passages.find((item) => item.passageId === passageId);
      if (passage === undefined) throw new Error("unknown source-tool passage");
      const logicalSourceIdentity = compactionLogicalSourceIdentity(candidate.identity);
      return providerVisibleExposureMarker({
        sourceKind,
        logicalSourceIdentity,
        contentItemIdentity: compactionContentItemIdentity(
          candidate.identity,
          logicalSourceIdentity,
          passage.text,
          { passageId, range: passage.range },
        ),
        stage: "context_compaction_input",
        visibleTokenCount: this.visibleTokenCount(passage.text, load.acceptanceScope.fastModelId),
      });
    };
    const privateIdentityForPassage = (passage: PassageView) => {
      const sourcePassage = index.passages.find((item) => item.passageId === passage.passageId);
      if (sourcePassage === undefined) throw new Error("unknown source-tool passage");
      if (candidate.kind === "chat_message") {
        if (candidate.identity.kind !== "chat_message") {
          throw new Error("chat candidate lacks its canonical message identity");
        }
        return {
          candidateId: candidate.candidateId,
          passageId: passage.passageId,
          charStart: sourcePassage.range.charStart,
          charEnd: sourcePassage.range.charEnd,
          visibleByteCount: new TextEncoder().encode(passage.text).byteLength,
          chatReconstruction: {
            messageId: ledgerChatMessageId(candidate),
            contentHash: candidate.identity.sanitizedContentHash,
            ranges: [sourcePassage.range],
          },
        };
      }
      if (candidate.kind === "document") {
        const identity = candidate.identity;
        if (identity.kind === "public_document") {
          return {
            snapshotId: identity.snapshotId,
            contentHash: identity.contentHash,
            source: { kind: "public" as const, sourceId: identity.sourceId },
            ranges: [sourcePassage.range],
          };
        }
        if (identity.kind === "publisher_document") {
          return {
            snapshotId: identity.snapshotId,
            contentHash: identity.contentHash,
            source: {
              kind: "publisher" as const,
              sourceId: identity.subscriptionId.startsWith("publisher:")
                ? identity.subscriptionId
                : `publisher:${identity.subscriptionId}`,
              issueId: identity.issueId,
              documentId: identity.documentId,
            },
            ranges: [sourcePassage.range],
            publisherExtractionId: identity.publisherExtractionId,
          };
        }
        throw new Error("document source-tool candidate lacks its canonical identity");
      }
      return {
        candidateId: candidate.candidateId,
        passageId: passage.passageId,
        charStart: sourcePassage.range.charStart,
        charEnd: sourcePassage.range.charEnd,
        visibleByteCount: new TextEncoder().encode(passage.text).byteLength,
      };
    };
    const parseSearch = (value: unknown) => SearchSourcePassagesArgumentsSchema.parse(value);
    const parseRead = (value: unknown) => ReadSourcePassagesArgumentsSchema.parse(value);
    const tools = [
      {
        definition: SourceCompactionToolDefinitions[0]!,
        parseArguments: parseSearch,
        execute: async (arguments_: Readonly<Record<string, unknown>>) => {
          const parsed = parseSearch(arguments_);
          if (parsed.candidateId !== candidate.candidateId) {
            return { found: false, complete: true, scope: "accepted_candidate_only" };
          }
          const normalizedTerms = normalizeAndCaseFold(parsed.query);
          const start = parsed.cursor === undefined ? 0 : Number(parsed.cursor);
          if (!Number.isSafeInteger(start) || start < 0) {
            return { found: false, complete: true, scope: "invalid_cursor" };
          }
          const matches = passages.filter((passage) =>
            normalizeAndCaseFold(passage.text).includes(normalizedTerms),
          );
          const page = matches.slice(start, start + 8);
          const truncated = start + page.length < matches.length;
          const result = {
            found: page.length > 0,
            complete: !truncated,
            truncated,
            cursor: truncated ? String(start + page.length) : null,
            passages: page,
            __hartlibSourceExposures: page.map((passage) => markerForPassage(passage.passageId)),
            __hartlibSourceIdentity: page.map(privateIdentityForPassage),
          };
          if (!truncated && page.length === 0) terminalReady = true;
          assertSourceToolResultBound(page, result);
          for (const passage of page) discovered.add(passage.passageId);
          return result;
        },
      },
      {
        definition: SourceCompactionToolDefinitions[1]!,
        parseArguments: parseRead,
        execute: async (arguments_: Readonly<Record<string, unknown>>) => {
          const parsed = parseRead(arguments_);
          if (parsed.passageIds.length > toolBounds.maximumResults) {
            return { found: false, complete: true, scope: "source_tool_bounds" };
          }
          if (parsed.candidateId !== candidate.candidateId) {
            return { found: false, complete: true, scope: "accepted_candidate_only" };
          }
          const anchorId = parsed.adjacentToPassageId;
          const anchorOrdinal =
            anchorId === undefined
              ? -1
              : index.passages.findIndex((item) => item.passageId === anchorId);
          const anchorDiscovered = anchorId === undefined || discovered.has(anchorId);
          const valid = [...new Set(parsed.passageIds)]
            .filter((passageId) => {
              if (discovered.has(passageId)) return true;
              if (!anchorDiscovered || anchorId === undefined || anchorOrdinal < 0) return false;
              const ordinal = index.passages.findIndex((item) => item.passageId === passageId);
              return ordinal >= 0 && Math.abs(ordinal - anchorOrdinal) === 1;
            })
            .sort(
              (left, right) =>
                index.passages.findIndex((item) => item.passageId === left) -
                index.passages.findIndex((item) => item.passageId === right),
            );
          const selected = valid.flatMap((passageId) => {
            const passage = passages.find((item) => item.passageId === passageId);
            return passage === undefined ? [] : [passage];
          });
          const result = {
            found: selected.length > 0,
            complete: true,
            truncated: false,
            cursor: null,
            passages: selected,
            __hartlibSourceExposures: selected.map((passage) =>
              markerForPassage(passage.passageId),
            ),
            __hartlibSourceIdentity: selected.map(privateIdentityForPassage),
          };
          assertSourceToolResultBound(selected, result);
          if (selected.length > 0) terminalReady = true;
          for (const passage of selected) discovered.add(passage.passageId);
          return result;
        },
      },
    ];
    const runtimeRequest = {
      taskId,
      phase,
      question: state.question,
      group,
      candidate: this.compactionProviderCandidate(candidate, passageOptions),
      toolBounds,
      ...(priorResult === undefined ? {} : { priorResult: priorResult.result }),
    } satisfies SourceToolCompactionRequest & {
      readonly toolBounds: typeof toolBounds;
    };
    const payload = buildGroupCompactionRequest(load, runtimeRequest);
    const validate = (value: unknown): GroupResultEnvelope => {
      const parsed = GroupCompactionResultSchema.parse(value);
      const result =
        priorResult === undefined
          ? parsed
          : validateFallbackGroupCompactionResult(
              parsed,
              group,
              state.candidateLedger,
              priorResult.result,
              tightenCandidateIds ?? [],
              passageOptions,
            );
      for (const decision of result.decisions) {
        if (
          decision.action === "select" &&
          decision.passageIds.some((passageId) => !discovered.has(passageId))
        ) {
          throw new Error("source-tool terminal selected an undisclosed passage");
        }
      }
      const decisions = new Map(
        result.decisions.map((decision) => [decision.candidateId, decision]),
      );
      const sources = group.candidateIds.flatMap((candidateId) => {
        const decision = decisions.get(candidateId);
        if (decision === undefined || decision.action === "omit") return [];
        const ranges = mapPassageIdsToRanges(index, decision.passageIds);
        return [
          {
            candidateId,
            text: selectedTextFromRanges(index.text, ranges),
            passageIds: [...decision.passageIds],
            ranges,
          },
        ];
      });
      const costOptions = this.compactionCostOptions(load, state);
      const renderedTokenCount = costOptions.countRenderedTokens(sources, group.candidateIds);
      return GroupResultEnvelopeSchema.parse(
        validateGroupResultEnvelope(
          { groupId: group.groupId, result, renderedTokenCount },
          group,
          state.candidateLedger,
          passageOptions,
          costOptions,
        ),
      );
    };
    const raw = await this.agents.toolLoop({
      requestClass: "fast",
      model: load.acceptanceScope.fastModelId,
      ...payload,
      sourceExposureProofs: [],
      tools,
      maximumResultTokens: maximumSourceResultTokens,
      terminalToolName: "emit_compaction_result",
      validateTerminal: validate,
      maximumTurns: toolBounds.maximumTurns,
      maximumResults: toolBounds.maximumResults,
      maximumBytes: toolBounds.maximumBytes,
      requestedOutputTokens: this.config.aiFastOutputMaxTokens,
      reasoning: "medium",
      coordinates: { taskId, attempt: execution.attempt, agentRole: "context_source_tool" },
      exclusiveToolNames: ["emit_compaction_result"],
      enforceTerminalTurn: true,
      reserveFinalTurnForTerminal: true,
      terminalOnlyForTurn: () => terminalReady,
      recoverTerminal: (_value, _error) => {
        terminalReady = true;
        if (repairAlreadyUsed || this.compactionRepairTaskIds.has(taskId)) return undefined;
        this.compactionRepairTaskIds.add(taskId);
        return {
          complete: true,
          repair: true,
          feedback: "schema_invalid",
        };
      },
      onBeforeRequest: async (request, requestCoordinates) => {
        await this.validateFrozenScope(load, state);
        await this.recordCompactionExposureProofs(load, taskId, request, requestCoordinates);
      },
    });
    return raw;
  }

  async compactContextGroup(
    load: LoadedTurn,
    state: ContextState,
    group: CompactionGroup,
    taskId: string,
    phase: CompactionPhase = "compact",
    priorResult?: GroupResultEnvelope,
    tightenCandidateIds?: readonly string[],
  ): Promise<GroupResultEnvelope> {
    return this.withCompactionRunPermit(load.aiRunId, () =>
      group.mode === "source_tool"
        ? this.sourceToolCompactionGroup(
            load,
            state,
            group,
            taskId,
            phase,
            priorResult,
            tightenCandidateIds,
          )
        : this.normalCompactionGroup(
            load,
            state,
            group,
            taskId,
            phase,
            priorResult,
            tightenCandidateIds,
          ),
    );
  }

  async fallbackCompactionManifest(
    load: LoadedTurn,
    state: ContextState,
    initialManifest: InitialContextManifest,
    firstPass: CompactionPassResult,
    measurement: ExactContextMeasurement,
    taskId: string,
  ): Promise<FallbackContextManifest> {
    const execution = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    const taskEvidence = await this.compactionTaskEvidence(load.aiRunId, taskId);
    this.assertCompactionTaskNotConsumed(taskEvidence);
    const repairAlreadyUsed =
      this.compactionRepairTaskIds.has(taskId) || taskEvidence.repairConsumed;
    const planner = this.fitCompactionPlannerRequest(
      load,
      state.candidateLedger.candidates,
      (entries) => {
        const plannerLedger = { candidates: entries } as CandidateLedger;
        return buildFallbackCompactionRequest(load, {
          taskId,
          question: state.question,
          ledger: plannerLedger,
          initialManifest,
          firstPass,
          state: {
            phase: "compact",
            question: state.question,
            ledger: plannerLedger,
            selections: firstPass.selections,
            groups: firstPass.groups,
            envelopes: firstPass.envelopes,
          },
          measurement,
        });
      },
    );
    const payload = planner.payload;
    const passageOptions = this.compactionPassageOptions(load);
    const costOptions = this.compactionCostOptions(load, state);
    const requestUser = payload.user;
    const fallbackProofs = this.compactionPreviewProofs(load, planner.entries);
    return this.agents.structured({
      requestClass: "fast",
      model: load.acceptanceScope.fastModelId,
      ...payload,
      validate: (value) => {
        const validated = validateFallbackContextManifest(
          value,
          initialManifest,
          state.candidateLedger,
          firstPass.envelopes,
          passageOptions,
          costOptions,
        );
        this.assertSynthesisPacketManifest(state, validated, true);
        this.fallbackCompactionGroupsForManifest(
          load,
          state,
          initialManifest,
          firstPass,
          validated,
          taskId,
        );
        return validated;
      },
      repair: () => {
        if (repairAlreadyUsed) return undefined;
        this.compactionRepairTaskIds.add(taskId);
        return {
          user: JSON.stringify({
            ...JSON.parse(requestUser),
            priorValidationFeedback: "schema_invalid",
          }),
        };
      },
      requestedOutputTokens: this.config.aiFastOutputMaxTokens,
      reasoning: "medium",
      coordinates: taskCoordinates(taskId, "context_fallback_manifest", execution),
      sourceExposureProofs: fallbackProofs,
      onBeforeRequest: async (request, requestCoordinates) => {
        await this.validateFrozenScope(load, state);
        await this.recordCompactionExposureProofs(load, taskId, request, requestCoordinates);
      },
    });
  }

  private fallbackCompactionGroupsForManifest(
    load: LoadedTurn,
    state: ContextState,
    initialManifest: InitialContextManifest,
    firstPass: CompactionPassResult,
    fallbackManifest: FallbackContextManifest,
    taskId: string,
  ): readonly CompactionGroup[] {
    const passageOptions = this.compactionPassageOptions(load);
    const costOptions = this.compactionCostOptions(load, state);
    const initialGroups = this.compactionGroupsForManifest(load, state, initialManifest, taskId);
    const provisional = createPureFallbackCompactionGroups(
      fallbackManifest,
      initialManifest,
      state.candidateLedger,
      firstPass.envelopes,
      { passageOptions, costOptions },
    );
    const eligible = new Set(
      initialGroups
        .filter((group) => group.mode === "source_tool")
        .flatMap((group) => group.candidateIds),
    );
    const firstByGroup = new Map(
      firstPass.envelopes.map((envelope) => [envelope.groupId, envelope]),
    );
    const measureRequest = (
      request: ProviderRequest,
    ): { inputTokens: number; allowance: number } => {
      const model = resolveRuntimeModel(request.model);
      return {
        inputTokens: model.countRequestTokens(request),
        allowance: Math.min(
          this.config.aiFastInputMaxTokens,
          model.contextWindow - request.requestedOutputTokens,
        ),
      };
    };
    for (const group of provisional) {
      const priorResult = firstByGroup.get(group.groupId);
      const priorPassageIds = new Map<string, readonly string[]>();
      for (const decision of priorResult?.result.decisions ?? []) {
        if (decision.action === "select") {
          priorPassageIds.set(decision.candidateId, decision.passageIds);
        }
      }
      const candidates = group.candidateIds.map((candidateId) =>
        this.compactionProviderCandidate(
          this.compactionLedgerEntry(state, candidateId),
          passageOptions,
          priorPassageIds.get(candidateId),
        ),
      );
      const normalGroup = { ...group, mode: "normal" as const };
      const normalRequest = structuredRequestInput(
        CompactionGroupPrompt,
        JSON.stringify({
          question: state.question,
          group: normalGroup,
          candidates,
          ...(priorResult === undefined ? {} : { priorResult: priorResult.result }),
        }),
        load.acceptanceScope.fastModelId,
        this.config.aiFastOutputMaxTokens,
        "emit_compaction_result",
        "Emit a complete compaction result.",
        z.toJSONSchema(GroupCompactionResultSchema),
      );
      const normalMeasurement = measureRequest(normalRequest);
      const entry = this.compactionLedgerEntry(state, group.candidateIds[0]!);
      if (
        normalMeasurement.inputTokens > normalMeasurement.allowance &&
        (group.candidateIds.length !== 1 ||
          (entry.kind !== "document" && entry.kind !== "chat_message"))
      ) {
        throw new CompactionContractError(
          `normal fallback group ${group.groupId} request does not fit its exact input allowance`,
        );
      }
      if (normalMeasurement.inputTokens > normalMeasurement.allowance) {
        eligible.add(entry.candidateId);
      }
      const finalGroup = {
        ...group,
        mode: eligible.has(entry.candidateId) ? ("source_tool" as const) : ("normal" as const),
      };
      const finalPayload =
        finalGroup.mode === "source_tool"
          ? buildGroupCompactionRequest(load, {
              taskId,
              phase: "fallback",
              question: state.question,
              group: finalGroup,
              candidate: this.compactionProviderCandidate(
                entry,
                passageOptions,
                priorPassageIds.get(entry.candidateId),
              ),
              toolBounds: DEFAULT_SOURCE_COMPACTION_TOOL_BOUNDS,
              ...(priorResult === undefined ? {} : { priorResult: priorResult.result }),
            })
          : buildGroupCompactionRequest(load, {
              taskId,
              phase: "fallback",
              question: state.question,
              group: finalGroup,
              candidates,
              ...(priorResult === undefined ? {} : { priorResult: priorResult.result }),
            });
      const finalMeasurement = measureRequest(
        structuredRequestInput(
          finalPayload.system,
          finalPayload.user,
          load.acceptanceScope.fastModelId,
          this.config.aiFastOutputMaxTokens,
          finalPayload.outputToolName,
          finalPayload.outputToolDescription,
          finalPayload.outputSchema,
        ),
      );
      if (finalMeasurement.inputTokens > finalMeasurement.allowance) {
        throw new CompactionContractError(
          `fallback group ${group.groupId} request does not fit its exact input allowance`,
        );
      }
    }
    const measurement = this.contextMeasurementPayload(
      state,
      taskId,
      state.citationSourceMap !== undefined
        ? "synthesis"
        : state.topicId === undefined
          ? "direct"
          : "topic",
    );
    const remainingAnswerTokens = state.usableInputTokens - measurement.mandatoryInputTokens;
    if (remainingAnswerTokens < 1) {
      throw new CompactionContractError("remaining answer budget must be a positive safe integer");
    }
    const groups = createPureFallbackCompactionGroups(
      fallbackManifest,
      initialManifest,
      state.candidateLedger,
      firstPass.envelopes,
      {
        sourceToolEligibleCandidateIds: [...eligible].filter((candidateId) =>
          provisional.some((group) => group.candidateIds.includes(candidateId)),
        ),
        passageOptions,
        costOptions,
      },
    );
    const keptCost = fallbackManifest.decisions.reduce((total, decision) => {
      if (decision.action !== "retain") return total;
      return (
        total +
        (state.candidateLedger.candidates.find(
          (candidate) => candidate.candidateId === decision.candidateId,
        )?.renderedTokenCount ?? 0)
      );
    }, 0);
    if (
      keptCost + groups.reduce((total, group) => total + group.renderedTokenBudget, 0) >
      remainingAnswerTokens
    ) {
      throw new CompactionContractError("fallback manifest cannot fit the remaining answer budget");
    }
    return groups;
  }

  async createFallbackCompactionGroups(
    load: LoadedTurn,
    state: ContextState,
    initialManifest: InitialContextManifest,
    firstPass: CompactionPassResult,
    fallbackManifest: FallbackContextManifest,
    taskId: string,
  ): Promise<readonly CompactionGroup[]> {
    this.assertSynthesisPacketManifest(state, fallbackManifest, true);
    return this.fallbackCompactionGroupsForManifest(
      load,
      state,
      initialManifest,
      firstPass,
      fallbackManifest,
      taskId,
    );
  }
  private synthesisSelectionsToContext(
    load: LoadedTurn,
    state: ContextState,
    selections: readonly CompactionSelection[],
  ): ContextState {
    const selectionById = new Map(
      selections.map((selection) => [selection.candidateId, selection]),
    );
    const ledgerConversationEntries = state.candidateLedger.candidates.filter(
      (candidate) => candidate.kind === "conversation_entry",
    );
    const ledgerConversation = state.ledgerConversation ?? state.selectedConversation;
    const selectedConversation = ledgerConversation.filter((_entry, index) => {
      const selection = selectionById.get(ledgerConversationEntries[index]?.candidateId ?? "");
      return selection?.action !== "omit";
    });
    const packetEntries = state.candidateLedger.candidates.filter(
      (candidate) => candidate.kind === "topic_packet",
    );
    const retainedEntries = packetEntries.filter((entry) => {
      const selection = selectionById.get(entry.candidateId);
      if (selection === undefined) {
        throw new Error(`compaction selection is missing ${entry.candidateId}`);
      }
      if (selection.action !== "keep" && selection.action !== "omit") {
        throw new Error("topic packet compaction must keep or omit whole packets");
      }
      return selection.action === "keep";
    });
    if (retainedEntries.length < 2) {
      throw new Error("synthesis compaction must retain at least two topic packets");
    }
    const retainedPackets = retainedEntries.map((entry) =>
      TopicPacketSchema.parse(JSON.parse(entry.text) as unknown),
    );
    const retainedIds: ReadonlySet<string> = new Set(
      retainedEntries.map((entry) => entry.candidateId),
    );
    const retainedTopicIds = new Set(retainedPackets.map((packet) => packet.topicId));
    const claimedSourceKeys = new Set(
      retainedPackets.flatMap((packet) => packet.claims.flatMap((claim) => claim.sourceKeys)),
    );
    const citationSourceMap = Object.freeze(
      (state.citationSourceMap ?? []).flatMap((source) => {
        if (!claimedSourceKeys.has(source.sourceKey)) return [];
        const uses = source.uses.filter(
          (use) =>
            use.topicId !== undefined &&
            retainedTopicIds.has(use.topicId) &&
            use.consumerTaskId === `topic-${use.topicId}-answer`,
        );
        return uses.length === 0 ? [] : [{ ...source, uses }];
      }),
    );
    const omittedPacketCount = packetEntries.length - retainedEntries.length;
    const contextGaps =
      omittedPacketCount === 0
        ? []
        : ["Some topic packet content was omitted during context compaction."];
    const request = this.rebuildSynthesisRequest(
      load,
      selectedConversation,
      retainedPackets,
      state.request.requestedOutputTokens,
      contextGaps,
    );
    const model = resolveRuntimeModel(request.model);
    const inputTokens = model.countRequestTokens(request);
    const usableInputTokens = Math.min(
      this.config.aiMainInputMaxTokens,
      model.contextWindow - request.requestedOutputTokens,
    );
    const synthesisConsumer: PublicContextConsumer = {
      consumer: "synthesis",
      inputTokens,
      requestedOutputTokens: request.requestedOutputTokens,
      usableInputTokens,
    };
    const consumers = [
      ...state.consumers.filter((consumer) => consumer.consumer !== "synthesis"),
      synthesisConsumer,
    ];
    const retainedCandidates = state.ledgerCandidates.filter((candidate) =>
      retainedIds.has(candidate.id),
    );
    const status: ContextState["status"] =
      inputTokens <= usableInputTokens ? "ready" : "needs_compaction";
    const gaps = [...retainedPackets.flatMap((packet) => packet.gaps), ...contextGaps];
    return {
      ...state,
      status,
      candidates: retainedCandidates,
      candidateLedger: state.candidateLedger,
      sourceMap: [],
      citationSourceMap,
      ledgerCandidates: retainedCandidates,
      ledgerSourceMap: [],
      selectedConversation,
      consumers,
      gaps,
      ledgerGaps: gaps,
      compactionFeedback: [],
      request,
      inputTokens,
      usableInputTokens,
      compactionRan: true,
      ...(status === "ready" ? { failureCode: undefined } : { failureCode: undefined }),
    };
  }

  private selectionsToContext(
    load: LoadedTurn,
    state: ContextState,
    selections: readonly CompactionSelection[],
  ): ContextState {
    if (state.citationSourceMap !== undefined) {
      return this.synthesisSelectionsToContext(load, state, selections);
    }
    const selectionById = new Map(
      selections.map((selection) => [selection.candidateId, selection]),
    );
    const ledgerConversationEntries = state.candidateLedger.candidates.filter(
      (candidate) => candidate.kind === "conversation_entry",
    );
    const ledgerConversation = state.ledgerConversation ?? state.selectedConversation;
    const selectedConversation = ledgerConversation.filter((_entry, index) => {
      const selection = selectionById.get(ledgerConversationEntries[index]?.candidateId ?? "");
      return selection?.action !== "omit";
    });
    const ledgerEvidence = state.candidateLedger.candidates.filter(
      (candidate) => candidate.kind !== "conversation_entry",
    );
    const candidateById = new Map(
      state.ledgerCandidates.map((candidate) => [candidate.id, candidate]),
    );
    const sourceById = new Map(
      state.ledgerCandidates.map((candidate, index) => [
        candidate.id,
        state.ledgerSourceMap[index],
      ]),
    );
    const candidates: AnswerCandidate[] = [];
    const sourceMap: FinalSourceRecord[] = [];
    const chatSourceRanges = new Map(
      (state.chatSourceRanges ?? []).map((item) => [item.messageId, item.ranges]),
    );
    for (const entry of ledgerEvidence) {
      const selection = selectionById.get(entry.candidateId);
      const candidate = candidateById.get(entry.candidateId);
      const source = sourceById.get(entry.candidateId);
      if (selection === undefined || candidate === undefined || source === undefined) {
        throw new Error(`compaction selection is missing ${entry.candidateId}`);
      }
      if (selection.action === "omit") continue;
      const ranges = selection.action === "range" ? selection.ranges : entry.baseRanges;
      let nextCandidate = candidate;
      if (candidate.kind === "document") {
        nextCandidate = { ...candidate, ranges };
      } else if (candidate.kind === "chat_message") {
        chatSourceRanges.set(candidate.messageId, ranges);
      }
      candidates.push(nextCandidate);
      const consumer = source.uses[0];
      if (consumer === undefined) throw new Error("compacted source lacks a consumer");
      sourceMap.push(
        this.sourceRecord(
          nextCandidate,
          source.sourceKey,
          consumer.consumerTaskId,
          sourceMap.length,
          consumer.topicId,
          nextCandidate.kind === "chat_message" ? ranges : [],
        ),
      );
    }
    const omitted = state.candidateLedger.candidates
      .filter((entry) => selectionById.get(entry.candidateId)?.action === "omit")
      .map((entry) => `context candidate omitted: ${entry.kind}`);
    const measured = this.measureContext(
      load,
      state.question,
      candidates,
      sourceMap,
      [...(state.ledgerGaps ?? state.gaps), ...omitted],
      true,
      state.topicId,
      selectedConversation,
      state.ledgerCandidates,
      state.ledgerSourceMap,
      state.request.requestedOutputTokens,
      [],
      ledgerConversation,
      state.ledgerConversationTokenCounts,
      state.ledgerGaps ?? state.gaps,
      state.candidateLedger,
      [...chatSourceRanges.entries()].map(([messageId, ranges]) => ({ messageId, ranges })),
    );
    return measured;
  }

  async collectCompaction(
    load: LoadedTurn,
    state: ContextState,
    manifest: InitialContextManifest,
    groups: readonly CompactionGroup[],
    envelopes: readonly GroupResultEnvelope[],
    taskId: string,
  ): Promise<CompactionPassResult> {
    const passageOptions = this.compactionPassageOptions(load);
    const costOptions = this.compactionCostOptions(load, state);
    const selections = mergeCompactionSelections(
      state.candidateLedger,
      manifest,
      envelopes,
      passageOptions,
      costOptions,
    );
    const prefix = taskId.replace(/-compact-collect$/u, "");
    const taskIds = groups.map((_group, index) =>
      compactionGroupTaskId(prefix, "compact", index + 1),
    );
    return {
      phase: "compact",
      groups,
      taskIds,
      envelopes,
      selections,
      repairUsed: taskIds.some((groupTaskId) => this.compactionRepairTaskIds.has(groupTaskId)),
    };
  }

  async collectFallbackCompaction(
    load: LoadedTurn,
    state: ContextState,
    fallbackManifest: FallbackContextManifest,
    fallbackGroups: readonly CompactionGroup[],
    fallbackEnvelopes: readonly GroupResultEnvelope[],
    firstPass: CompactionPassResult,
    taskId: string,
  ): Promise<CompactionPassResult> {
    const passageOptions = this.compactionPassageOptions(load);
    const costOptions = this.compactionCostOptions(load, state);
    const firstEnvelopeByGroup = new Map(
      firstPass.envelopes.map((envelope) => [envelope.groupId, envelope]),
    );
    const firstSelectionById = new Map(
      firstPass.selections.map((selection) => [selection.candidateId, selection]),
    );
    for (const envelope of fallbackEnvelopes) {
      const group = fallbackGroups.find((item) => item.groupId === envelope.groupId);
      const firstEnvelope = firstEnvelopeByGroup.get(envelope.groupId);
      if (group === undefined) {
        throw new Error("fallback result names an unknown fallback group");
      }
      if (firstEnvelope === undefined) continue;
      for (const candidateId of group.candidateIds) {
        const fallbackDecision = fallbackManifest.decisions.find(
          (decision) => decision.candidateId === candidateId,
        );
        const nextDecision = envelope.result.decisions.find(
          (decision) => decision.candidateId === candidateId,
        );
        const firstDecision = firstEnvelope.result.decisions.find(
          (decision) => decision.candidateId === candidateId,
        );
        if (
          fallbackDecision === undefined ||
          nextDecision === undefined ||
          firstDecision === undefined
        ) {
          throw new Error("fallback result does not cover its exact first-pass membership");
        }
        if (fallbackDecision.action === "retain") {
          if (
            nextDecision.action !== firstDecision.action ||
            (nextDecision.action === "select" &&
              (firstDecision.action !== "select" ||
                nextDecision.passageIds.length !== firstDecision.passageIds.length ||
                nextDecision.passageIds.some(
                  (passageId) => !firstDecision.passageIds.includes(passageId),
                )))
          ) {
            throw new Error("fallback retain changed a first-pass result envelope");
          }
          continue;
        }
        if (fallbackDecision.action !== "tighten") continue;
        if (nextDecision.action !== "select" || firstDecision.action !== "select") {
          throw new Error("fallback tighten must retain a strict selected passage subset");
        }
        const previousPassageIds = new Set(firstDecision.passageIds);
        const nextPassageIds = new Set(nextDecision.passageIds);
        if (
          nextPassageIds.size >= previousPassageIds.size ||
          [...nextPassageIds].some((passageId) => !previousPassageIds.has(passageId))
        ) {
          throw new Error("fallback tighten widened or retained first-pass passages");
        }
        if (firstSelectionById.get(candidateId)?.action === "omit") {
          throw new Error("fallback tighten restored a first-pass omission");
        }
      }
    }
    const changed = mergeGroupCompactionResults(
      state.candidateLedger,
      fallbackGroups,
      fallbackEnvelopes,
      passageOptions,
      costOptions,
    );
    const changedById = new Map(changed.map((selection) => [selection.candidateId, selection]));
    const firstById = new Map(
      firstPass.selections.map((selection) => [selection.candidateId, selection]),
    );
    const selections = state.candidateLedger.candidates.map((candidate) => {
      const decision = fallbackManifest.decisions.find(
        (item) => item.candidateId === candidate.candidateId,
      );
      if (decision === undefined) throw new Error(`fallback omitted ${candidate.candidateId}`);
      if (decision.action === "omit") {
        return {
          candidateId: candidate.candidateId,
          action: "omit",
          passageIds: [],
          ranges: [],
        } satisfies CompactionSelection;
      }
      if (decision.action === "retain") {
        const previous = firstById.get(candidate.candidateId);
        if (previous === undefined)
          throw new Error(`fallback retained unknown ${candidate.candidateId}`);
        return previous;
      }
      const next = changedById.get(candidate.candidateId);
      if (next === undefined)
        throw new Error(`fallback changed ${candidate.candidateId} without a result`);
      return next;
    });
    const prefix = taskId.replace(/-fallback-collect$/u, "");
    const taskIds = fallbackGroups.map((_group, index) =>
      compactionGroupTaskId(prefix, "fallback", index + 1),
    );
    return {
      phase: "fallback",
      groups: fallbackGroups,
      taskIds,
      envelopes: fallbackEnvelopes,
      selections,
      repairUsed: taskIds.some((groupTaskId) => this.compactionRepairTaskIds.has(groupTaskId)),
    };
  }
  async measureCompaction(
    load: LoadedTurn,
    state: ContextState,
    pass: CompactionPassResult,
    taskId: string,
  ): Promise<ContextState> {
    if (pass.phase !== "compact" && pass.phase !== "fallback") {
      throw new Error("compaction measurement has an unknown pass phase");
    }
    const measured = this.selectionsToContext(load, state, pass.selections);
    const overByTokens = Math.max(0, measured.inputTokens - measured.usableInputTokens);
    const compactionFeedback =
      measured.status === "needs_compaction"
        ? [`${pass.phase} compaction remains oversized by ${overByTokens} tokens`]
        : [];
    const result =
      pass.phase === "fallback" && measured.status === "needs_compaction"
        ? {
            ...measured,
            status: "failed" as const,
            failureCode: "context_plan_unfit" as const,
            compactionFeedback,
          }
        : { ...measured, compactionFeedback };
    await this.observe(
      load,
      taskId,
      "context_measurement",
      this.contextMeasurementPayload(
        result,
        result.citationSourceMap !== undefined
          ? "fanout-synthesis"
          : result.topicId === undefined
            ? "single-answer"
            : `topic-${result.topicId}-answer`,
        result.citationSourceMap !== undefined
          ? "synthesis"
          : result.topicId === undefined
            ? "direct"
            : "topic",
      ),
    );
    return result;
  }

  async selectCompactionContext(
    load: LoadedTurn,
    context: ContextState,
    _taskId: string,
  ): Promise<ContextState> {
    if (context.status === "failed") return context;
    if (context.status !== "ready") {
      return { ...context, status: "failed", failureCode: "context_plan_unfit" };
    }
    await this.validateFrozenScope(load, context);
    return context;
  }

  async answerDirect(
    load: LoadedTurn,
    context: ContextState,
    taskId: string,
  ): Promise<AnswerLaneResult> {
    const signal = currentTaskAbortSignal();
    throwIfAborted(signal);
    if (context.status !== "ready") {
      const code = context.failureCode ?? "context_plan_unfit";
      return {
        status: "failed",
        code,
        retryable: isRetryableAiRunError(code),
      };
    }
    const execution = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    const request: LiveProviderRequest = {
      ...context.request,
      sourceExposureProofs: this.contextExposureProofMarkers(load, context),
    };
    let resultText: string;
    try {
      const result = await this.agents.stream(
        request,
        taskCoordinates(taskId, "direct_answer", execution),
        async (delta, index) => {
          throwIfAborted(signal);
          await this.db(
            appendAiRunEvent({
              runId: load.aiRunId,
              emissionKey: answerDeltaEmissionKey(taskId, execution.attempt, index),
              event: { type: "text_delta", delta },
              emittedByTask: taskId,
            }),
          );
          throwIfAborted(signal);
        },
        async (request, requestCoordinates) => {
          assertMeasuredAnswerRequest(context.request, request);
          await this.validateFrozenScope(load, context);
          await this.emitAnswerStart(load, context, "single", taskId, requestCoordinates);
          await this.recordContextExposures(load, context, taskId, requestCoordinates, request);
          await this.observe(
            load,
            taskId,
            "context_serialized",
            {
              consumerTaskId: taskId,
              sourceKeys: context.sourceMap.map((source) => source.sourceKey),
              restrictedContextLedger: this.restrictedContextLedger(context, "direct", request),
              terminalUsageCoordinate: {
                taskId,
                loopIteration: requestCoordinates.loopIteration,
                attempt: requestCoordinates.attempt,
                providerRequestIndex: requestCoordinates.providerRequestIndex,
              },
            },
            requestCoordinates,
          );
        },
      );
      resultText = result.text;
    } catch (error) {
      if (isAiRuntimeError(error) && !error.retryable) {
        return { status: "failed", code: error.code, retryable: false };
      }
      throw error;
    }
    throwIfAborted(signal);
    return { status: "ok", mode: "single", content: resultText, sourceMap: context.sourceMap };
  }

  private async emitAnswerStart(
    load: LoadedTurn,
    context: ContextState,
    mode: "single" | "synthesis",
    taskId: string,
    coordinates?: { readonly loopIteration: number; readonly attempt: number },
  ): Promise<{ readonly loopIteration: number; readonly attempt: number }> {
    const execution = coordinates ?? requireCurrentTaskCoordinates(taskId);
    await this.db(
      appendAiRunEvent({
        runId: load.aiRunId,
        emissionKey: "context_ready",
        event: {
          type: "context_ready",
          mode,
          compactionRan: context.compactionRan,
          sourcesRead: context.sourceMap.map(publicSourceRecordFromFinalSource),
          consumers: context.consumers.map((consumer) => ({ ...consumer })),
        },
      }),
    );
    await this.db(
      appendAiRunEvent({
        runId: load.aiRunId,
        emissionKey: answerStartedEmissionKey(taskId, execution.attempt),
        event: { type: "answer_started", mode, attempt: execution.attempt },
        emittedByTask: taskId,
      }),
    );
    return execution;
  }

  async clarify(load: LoadedTurn, question: string): Promise<AnswerLaneResult> {
    const taskId = "clarification-result";
    const execution = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    await this.db(
      appendAiRunEvent({
        runId: load.aiRunId,
        emissionKey: "context_ready",
        event: {
          type: "context_ready",
          mode: "clarification",
          compactionRan: false,
          sourcesRead: [],
          consumers: [],
        },
      }),
    );
    await this.db(
      appendAiRunEvent({
        runId: load.aiRunId,
        emissionKey: answerStartedEmissionKey(taskId, execution.attempt),
        event: { type: "answer_started", mode: "clarification", attempt: execution.attempt },
        emittedByTask: taskId,
      }),
    );
    await this.db(
      appendAiRunEvent({
        runId: load.aiRunId,
        emissionKey: answerDeltaEmissionKey(taskId, execution.attempt, 0),
        event: { type: "text_delta", delta: question },
        emittedByTask: taskId,
      }),
    );
    return { status: "ok", mode: "clarification", content: question, sourceMap: [] };
  }

  async allocateFanout(
    load: LoadedTurn,
    plan: Extract<PlanTurnResult, { mode: "fanout" }>,
  ): Promise<FanoutAllocation> {
    const model = resolveRuntimeModel(load.acceptanceScope.mainModelId);
    const selectedTurnIds = new Set(plan.topics.flatMap((topic) => topic.relevantTurnIds));
    const selectedConversation = (await this.currentPriorTurns(load)).filter((entry) =>
      selectedTurnIds.has(entry.turnId),
    );
    const skeleton = fullRequestInput(
      SynthesisPrompt,
      JSON.stringify({
        locale: load.locale,
        originalMessage: load.userMessage,
        selectedConversation,
        packets: plan.topics.map((topic) => ({
          topicId: topic.topicId,
          status: "partial",
          claims: [],
          gaps: [],
        })),
      }),
      load.acceptanceScope.mainModelId,
      this.config.aiMainOutputMaxTokens,
    );
    const fixed = model.countRequestTokens(skeleton);
    const usable = Math.min(
      this.config.aiMainInputMaxTokens,
      model.contextWindow - this.config.aiMainOutputMaxTokens,
    );
    const packetOutputTokens = Math.min(
      this.config.aiMainOutputMaxTokens,
      model.maximumOutputTokens,
      Math.floor((usable - fixed) / plan.topics.length),
    );
    if (
      packetOutputTokens < topicPacketSchemaMinimumOutputTokens(load.acceptanceScope.mainModelId)
    ) {
      throw controlledRuntimeFailure("synthesis_budget_mismatch");
    }
    return { packetOutputTokens, synthesisUsableInput: usable, fixedSynthesisInput: fixed };
  }

  async answerTopic(
    load: LoadedTurn,
    context: ContextState,
    taskId: string,
    _packetOutputTokens: number,
  ): Promise<TopicPacket> {
    if (context.status !== "ready" || context.topicId === undefined)
      throw controlledRuntimeFailure(context.failureCode ?? "context_plan_unfit");
    const execution = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    const request: LiveProviderRequest = {
      ...context.request,
      sourceExposureProofs: this.contextExposureProofMarkers(load, context),
    };
    const output = await this.agents.structured({
      requestClass: "main",
      model: load.acceptanceScope.mainModelId,
      system: TopicAnswerPrompt,
      user: context.request.messages.find((message) => message.role === "user")?.content ?? "",
      request,
      outputToolName: "emit_topic_packet",
      outputToolDescription: "Emit a grounded topic packet.",
      outputSchema: z.toJSONSchema(TopicPacketSchema),
      validate: zodValidator(TopicPacketSchema),
      requestedOutputTokens: context.request.requestedOutputTokens,
      reasoning: "medium",
      coordinates: taskCoordinates(taskId, "topic_answer", execution),
      onBeforeRequest: async (request, requestCoordinates) => {
        assertMeasuredAnswerRequest(context.request, request);
        await this.validateFrozenScope(load, context);
        await this.recordContextExposures(load, context, taskId, requestCoordinates, request);
        await this.observe(
          load,
          taskId,
          "context_serialized",
          {
            consumerTaskId: taskId,
            topicId: context.topicId,
            sourceKeys: context.sourceMap.map((source) => source.sourceKey),
            restrictedContextLedger: this.restrictedContextLedger(context, "topic", request),
            terminalUsageCoordinate: {
              taskId,
              loopIteration: requestCoordinates.loopIteration,
              attempt: requestCoordinates.attempt,
              providerRequestIndex: requestCoordinates.providerRequestIndex,
            },
          },
          requestCoordinates,
        );
      },
    });
    const packet = validateTopicPacket(
      output,
      context.topicId,
      context.sourceMap.map((source) => source.sourceKey),
    );
    await this.observe(
      load,
      taskId,
      "topic_packet",
      {
        topicId: packet.topicId,
        status: packet.status,
        sourceKeys: [...new Set(packet.claims.flatMap((claim) => claim.sourceKeys))],
        claimCount: packet.claims.length,
        gapCount: packet.gaps.length,
        packetSha256Hex: createHash("sha256")
          .update(JSON.stringify(canonicalValue(packet)))
          .digest("hex"),
      },
      execution,
    );
    return packet;
  }

  rebuildSynthesisRequest(
    load: Pick<LoadedTurn, "locale" | "userMessage" | "acceptanceScope">,
    selectedConversation: readonly ConversationEntry[],
    packets: readonly TopicPacket[],
    requestedOutputTokens: number,
    contextGaps: readonly string[] = [],
  ): LiveProviderRequest {
    const canonicalPackets = packets.map((packet) =>
      TopicPacketSchema.parse(canonicalValue(packet)),
    );
    return fullRequestInput(
      SynthesisPrompt,
      JSON.stringify({
        locale: load.locale,
        originalMessage: load.userMessage,
        selectedConversation,
        packets: canonicalPackets,
        ...(contextGaps.length === 0 ? {} : { contextGaps: [...contextGaps] }),
      }),
      load.acceptanceScope.mainModelId,
      requestedOutputTokens,
    );
  }
  async synthesisContext(
    load: LoadedTurn,
    packets: readonly TopicPacket[],
    sourceMap: readonly FinalSourceRecord[],
    topicContexts: readonly ContextState[],
    allocation: FanoutAllocation,
  ): Promise<ContextState> {
    const selectedTurnIds = new Set(
      topicContexts.flatMap((context) => context.selectedConversation.map((entry) => entry.turnId)),
    );
    const selectedConversation = (await this.currentPriorTurns(load)).filter((entry) =>
      selectedTurnIds.has(entry.turnId),
    );
    const canonicalPackets = packets.map((packet) =>
      TopicPacketSchema.parse(canonicalValue(packet)),
    );
    const request = this.rebuildSynthesisRequest(
      load,
      selectedConversation,
      canonicalPackets,
      this.config.aiMainOutputMaxTokens,
    );
    const model = resolveRuntimeModel(load.acceptanceScope.mainModelId);
    const inputTokens = model.countRequestTokens(request);
    const usableInputTokens = Math.min(
      this.config.aiMainInputMaxTokens,
      model.contextWindow - request.requestedOutputTokens,
    );
    const fixedPackets = canonicalPackets.map((packet) => ({
      topicId: packet.topicId,
      status: "partial" as const,
      claims: [],
      gaps: [],
    }));
    const fixedRequest = this.rebuildSynthesisRequest(
      load,
      selectedConversation,
      fixedPackets,
      this.config.aiMainOutputMaxTokens,
    );
    const measuredFixedInput = model.countRequestTokens(fixedRequest);
    const packetAllowanceTotal = allocation.packetOutputTokens * canonicalPackets.length;
    const packetTopicIds = canonicalPackets.map((packet) => packet.topicId);
    const topicContextIds = topicContexts.map((context) => context.topicId);
    const canonicalTopicIds: readonly TopicId[] = ["t1", "t2", "t3"];
    const packetSourceProofsValid = canonicalPackets.every((packet) => {
      const visibleTopicSourceKeys = sourceMap
        .filter((source) =>
          source.uses.some(
            (use) =>
              use.consumerTaskId === `topic-${packet.topicId}-answer` &&
              use.topicId === packet.topicId,
          ),
        )
        .map((source) => source.sourceKey);
      const claimedSourceKeys = packet.claims.flatMap((claim) => claim.sourceKeys);
      return (
        new Set(claimedSourceKeys).size === claimedSourceKeys.length &&
        claimedSourceKeys.every((sourceKey) => visibleTopicSourceKeys.includes(sourceKey))
      );
    });
    const preallocationMatches =
      canonicalPackets.length >= 2 &&
      canonicalPackets.length <= 3 &&
      packetTopicIds.every((topicId, index) => topicId === canonicalTopicIds[index]) &&
      packetTopicIds.every((topicId, index) => topicId === topicContextIds[index]) &&
      measuredFixedInput === allocation.fixedSynthesisInput &&
      usableInputTokens === allocation.synthesisUsableInput &&
      allocation.fixedSynthesisInput + packetAllowanceTotal <= allocation.synthesisUsableInput &&
      packetSourceProofsValid &&
      topicContexts.every(
        (context) =>
          context.request.requestedOutputTokens === allocation.packetOutputTokens &&
          context.request.requestedOutputTokens <= this.config.aiMainOutputMaxTokens &&
          context.request.requestedOutputTokens <= model.maximumOutputTokens,
      );
    const historyLedger = this.buildCandidateLedger(
      [],
      load.acceptanceScope.mainModelId,
      selectedConversation,
    );
    const mandatoryRequest = this.rebuildSynthesisRequest(
      load,
      [],
      [],
      this.config.aiMainOutputMaxTokens,
    );
    const mandatoryInputTokens = model.countRequestTokens(mandatoryRequest);
    let previousPrefixTokens = mandatoryInputTokens;
    const historyTokenCounts = selectedConversation.map((_entry, index) => {
      const prefixTokens = model.countRequestTokens(
        this.rebuildSynthesisRequest(
          load,
          selectedConversation.slice(0, index + 1),
          [],
          this.config.aiMainOutputMaxTokens,
        ),
      );
      const marginal = prefixTokens - previousPrefixTokens;
      if (marginal < 0) {
        throw new Error("synthesis history token accounting is inconsistent");
      }
      previousPrefixTokens = prefixTokens;
      return marginal;
    });
    const measuredHistoryLedger = this.updateCandidateLedgerTokenCounts(
      historyLedger,
      [],
      [],
      historyTokenCounts,
    );
    const packetCandidates: readonly TopicPacketCandidate[] = canonicalPackets.map(
      (packet, index) => {
        const text = JSON.stringify(canonicalValue(packet));
        const prefixTokens = model.countRequestTokens(
          this.rebuildSynthesisRequest(
            load,
            selectedConversation,
            canonicalPackets.slice(0, index + 1),
            this.config.aiMainOutputMaxTokens,
          ),
        );
        const renderedTokenCount = prefixTokens - previousPrefixTokens;
        if (renderedTokenCount < 0) {
          throw new Error("synthesis packet token accounting is inconsistent");
        }
        previousPrefixTokens = prefixTokens;
        return {
          id: candidateLocalId(selectedConversation.length + index + 1),
          kind: "topic_packet",
          rank: index,
          purpose: "provider-authored fanout topic packet",
          topicId: packet.topicId,
          text,
          packetSha256Hex: createHash("sha256").update(text).digest("hex"),
          label: packet.topicId,
          renderedTokenCount,
        };
      },
    );
    const discretionaryTokenCounts = [
      ...historyTokenCounts,
      ...packetCandidates.map((candidate) => candidate.renderedTokenCount),
    ];
    if (
      previousPrefixTokens !== inputTokens ||
      discretionaryTokenCounts.reduce((total, count) => total + count, 0) !==
        inputTokens - mandatoryInputTokens
    ) {
      throw new Error("synthesis discretionary token accounting is inconsistent");
    }
    const packetLedgerEntries = packetCandidates.map((candidate): CandidateLedgerEntry => {
      const baseRanges = [{ charStart: 0, charEnd: candidate.text.length }];
      const bounded = this.boundedCandidatePreview(candidate.text, baseRanges);
      return {
        candidateId: candidate.id as `c${number}`,
        kind: "topic_packet",
        identity: {
          kind: "topic_packet",
          topicId: candidate.topicId,
          packetSha256Hex: candidate.packetSha256Hex,
        },
        provenance: {
          label: candidate.label,
          purpose: candidate.purpose,
          date: null,
        },
        text: candidate.text,
        baseRanges,
        previewRanges: bounded.ranges,
        preview: bounded.preview,
        renderedTokenCount: candidate.renderedTokenCount,
      };
    });
    const candidateLedger = this.freezeCandidateLedger(
      CandidateLedgerSchema.parse({
        candidates: [...measuredHistoryLedger.candidates, ...packetLedgerEntries],
      }) as CandidateLedger,
    );
    const synthesisConsumer: PublicContextConsumer = {
      consumer: "synthesis",
      inputTokens,
      requestedOutputTokens: request.requestedOutputTokens,
      usableInputTokens,
    };
    const status: ContextState["status"] = !preallocationMatches
      ? "failed"
      : inputTokens <= usableInputTokens
        ? "ready"
        : "needs_compaction";
    return {
      status,
      question: load.userMessage,
      candidateLedger,
      candidates: packetCandidates,
      sourceMap: [],
      citationSourceMap: Object.freeze([...sourceMap]),
      ledgerCandidates: packetCandidates,
      ledgerSourceMap: [],
      selectedConversation,
      ledgerConversation: selectedConversation,
      ledgerConversationTokenCounts: candidateLedger.candidates
        .slice(0, selectedConversation.length)
        .map((candidate) => candidate.renderedTokenCount),
      consumers: [...topicContexts.flatMap((context) => context.consumers), synthesisConsumer],
      gaps: canonicalPackets.flatMap((packet) => packet.gaps),
      ledgerGaps: canonicalPackets.flatMap((packet) => packet.gaps),
      compactionFeedback: [],
      request,
      inputTokens,
      usableInputTokens,
      compactionRan: false,
      ...(status === "failed" ? { failureCode: "synthesis_budget_mismatch" as const } : {}),
    };
  }

  async recordSynthesisContextMeasurement(load: LoadedTurn, context: ContextState): Promise<void> {
    await this.observe(
      load,
      "fanout-synthesis-measure",
      "context_measurement",
      this.contextMeasurementPayload(context, "fanout-synthesis", "synthesis"),
    );
  }

  async synthesize(
    load: LoadedTurn,
    context: ContextState,
    taskId: string,
  ): Promise<AnswerLaneResult> {
    const signal = currentTaskAbortSignal();
    throwIfAborted(signal);
    if (context.status !== "ready")
      return {
        status: "failed",
        code: context.failureCode ?? "synthesis_budget_mismatch",
        retryable: isRetryableAiRunError(context.failureCode ?? "synthesis_budget_mismatch"),
      };
    const execution = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    const citationSourceMap = context.citationSourceMap ?? [];
    const providerContext: ContextState = {
      ...context,
      candidates: [],
      sourceMap: [],
      ledgerCandidates: [],
      ledgerSourceMap: [],
    };
    const answerContext: ContextState = { ...context, sourceMap: citationSourceMap };
    const request: LiveProviderRequest = {
      ...context.request,
      sourceExposureProofs: this.contextExposureProofMarkers(load, providerContext),
    };
    let resultText: string;
    try {
      const result = await this.agents.stream(
        request,
        taskCoordinates(taskId, "synthesis", execution),
        async (delta, index) => {
          throwIfAborted(signal);
          await this.db(
            appendAiRunEvent({
              runId: load.aiRunId,
              emissionKey: answerDeltaEmissionKey(taskId, execution.attempt, index),
              event: { type: "text_delta", delta },
              emittedByTask: taskId,
            }),
          );
          throwIfAborted(signal);
        },
        async (request, requestCoordinates) => {
          assertMeasuredAnswerRequest(context.request, request);
          await this.validateFrozenScope(load, answerContext);
          await this.emitAnswerStart(load, answerContext, "synthesis", taskId, requestCoordinates);
          await this.recordConversationExposures(
            load,
            taskId,
            context.selectedConversation,
            requestCoordinates,
            { modelId: load.acceptanceScope.mainModelId },
          );
          await this.observe(
            load,
            taskId,
            "context_serialized",
            {
              consumerTaskId: taskId,
              sourceKeys: citationSourceMap.map((source) => source.sourceKey),
              restrictedContextLedger: this.restrictedContextLedger(context, "synthesis", request),
              terminalUsageCoordinate: {
                taskId,
                loopIteration: requestCoordinates.loopIteration,
                attempt: requestCoordinates.attempt,
                providerRequestIndex: requestCoordinates.providerRequestIndex,
              },
            },
            requestCoordinates,
          );
        },
      );
      resultText = result.text;
    } catch (error) {
      if (isAiRuntimeError(error) && !error.retryable) {
        return { status: "failed", code: error.code, retryable: false };
      }
      throw error;
    }
    throwIfAborted(signal);
    return { status: "ok", mode: "synthesis", content: resultText, sourceMap: citationSourceMap };
  }

  async finalize(
    load: LoadedTurn,
    answer: AnswerLaneResult,
    memory: MemoryExtractionArtifact,
    expectedSmithersRunId: string,
  ) {
    try {
      return await this.db(
        finalizeAiRun({
          runId: load.aiRunId,
          expectedSmithersRunId,
          coordinates: requireCurrentTaskCoordinates("finalize"),
          answer,
          memory,
        }),
      );
    } catch (error) {
      if (process.env.AI_DEBUG_ERRORS === "1") {
        const metadata = aiRuntimeFailureMetadata(error);
        console.error("AI_DEBUG_FINALIZATION", {
          aiRunId: load.aiRunId,
          errorCode: metadata?.code ?? "finalization_failed",
          errorCategory: metadata?.category ?? "workflow",
          errorMessage: metadata?.message ?? aiRuntimeDiagnosticMessage("workflow", null),
        });
      }
      throw error;
    }
  }
}
