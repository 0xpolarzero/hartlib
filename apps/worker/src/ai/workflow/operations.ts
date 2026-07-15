import { createHash } from "node:crypto";

import {
  isCanonicalPublicDocumentSourceId,
  isCanonicalPublisherDocumentSourceId,
  type PublicContextConsumer,
} from "@brief/shared";
import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import { z } from "zod";

import type { WorkerConfig } from "../../config";
import {
  ContextReductionPrompt,
  ConversationResolverPrompt,
  DirectAnswerPrompt,
  ExecutionPlannerPrompt,
  InternalRetrievalPrompt,
  MemoryExtractorPrompt,
  MemorySelectorPrompt,
  SynthesisPrompt,
  TopicAnswerPrompt,
  WebResearchPrompt,
} from "../prompts";
import {
  appendAiRunEvent,
  finalizeAiRun,
  insertAiObservation,
  insertAiSourceExposure,
  markAiRunStarted,
  runAiProductState,
} from "../product-state/repository";
import { searchDocuments } from "../retrieval/retrieval";
import type { DocumentPreview } from "../retrieval/query-spec";
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
  requiresExplicitInspectionRange,
  sha256Base64Url,
  sourceKeyForOrdinal,
  stripHistoricalCitationTags,
  webEvidenceIdentity,
  webQuoteHash,
  type SelectorDomain,
  type TopicId,
} from "../runtime/canonicalization";
import { CanonicalAgentClient, zodValidator } from "../runtime/agent-client";
import {
  AiRuntimeError,
  isAiRuntimeError,
  isRetryableAiRunError,
  type AiRunErrorCode,
} from "../runtime/errors";
import { resolveRuntimeModel } from "../runtime/model-registry";
import type { PiBoundaryCoordinates } from "../runtime/pi-boundary";
import {
  providerRequestSha256Hex,
  type LiveProviderRequest,
  type ProviderRequest,
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
  ContextDecision,
  ConversationEntry,
  ConversationResolution,
  EffectiveWebPolicy,
  FinalSourceRecord,
  InternalQuery,
  InternalReference,
  Locale,
  Market,
  MemoryExtractionArtifact,
  MemoryProposal,
  MemoryReference,
  MemorySnapshot,
  NormalizedExecutionPlan,
  SerializedSourceUse,
  TopicPacket,
  WebEvidence,
} from "../runtime/types";
import {
  ConversationResolutionSchema,
  ConversationResolutionProviderSchema,
  validateAndNormalizeExecutionPlan,
  validateContextDecisions,
  validateConversationResolution,
  validateMemoryProposals,
  validateTopicPacket,
} from "../runtime/validators";
import { effectiveWebPolicy, recheckWebPolicy } from "../web/policy";

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
  | "aiRetrievalMaxTurns"
  | "aiInternalMaxSearches"
  | "aiInternalMaxInspections"
  | "aiWebMaxSearches"
  | "aiWebMaxFetches"
  | "aiWebMaxDomainFilters"
  | "aiContextReductionMaxIterations"
  | "aiMemoryDirectMaxItems"
  | "aiMemoryToolResultMaxItems"
  | "webResearchProvider"
>;

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

export interface LoadedTurn {
  readonly aiRunId: string;
  readonly chatId: string;
  readonly initiatingUserId: string;
  readonly userMessageId: string;
  readonly userMessage: string;
  readonly locale: Locale;
  readonly market: Market;
  readonly currentDate: string;
  readonly citationNonce: number[];
  readonly priorTerminalTurnCount: number;
  readonly conversation: readonly ConversationEntry[];
  readonly memories: readonly MemorySnapshot[];
  readonly memoryMode: "private_owner" | "disabled";
  readonly sourceCatalog: ReadonlyArray<{
    readonly sourceId: string;
    readonly displayName: string;
    readonly country: string;
    readonly language: string;
    readonly ingestionType: string;
  }>;
  readonly webRequested: boolean;
  readonly webPolicy: EffectiveWebPolicy;
}

export interface SelectorBundle {
  readonly internal: readonly InternalReference[];
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
  readonly sourceMap: readonly FinalSourceRecord[];
  readonly selectedConversation: readonly ConversationEntry[];
  readonly gaps: readonly string[];
  readonly consumerTaskId: string;
  readonly requestedOutputTokens: number;
}

export interface ContextState {
  readonly status: "ready" | "needs_reduction" | "failed";
  readonly question: string;
  readonly topicId?: TopicId | undefined;
  readonly candidates: readonly AnswerCandidate[];
  readonly sourceMap: readonly FinalSourceRecord[];
  readonly ledgerCandidates: readonly AnswerCandidate[];
  readonly ledgerSourceMap: readonly FinalSourceRecord[];
  readonly selectedConversation: readonly ConversationEntry[];
  readonly ledgerConversation?: readonly ConversationEntry[] | undefined;
  readonly ledgerConversationTokenCounts?: readonly number[] | undefined;
  readonly consumers: readonly PublicContextConsumer[];
  readonly gaps: readonly string[];
  readonly ledgerGaps?: readonly string[] | undefined;
  readonly reductionFeedback: readonly string[];
  readonly request: LiveProviderRequest;
  readonly inputTokens: number;
  readonly usableInputTokens: number;
  readonly reductionRan: boolean;
  readonly failureCode?:
    | "context_mandatory_too_large"
    | "context_plan_unfit"
    | "context_budget_mismatch"
    | "synthesis_budget_mismatch"
    | "source_access_revoked"
    | "web_policy_revoked"
    | undefined;
}

export interface ContextReductionPlan {
  readonly decisions: readonly ContextDecision[];
}

export interface FanoutAllocation {
  readonly packetOutputTokens: number;
  readonly synthesisUsableInput: number;
  readonly fixedSynthesisInput: number;
}

export interface FanoutSourceKeySet {
  readonly sources: ReadonlyArray<{
    readonly candidateId: string;
    readonly sourceKey: string;
  }>;
}

interface LiveAuthorizationOptions {
  readonly conversation?: readonly ConversationEntry[] | undefined;
  readonly memories?: readonly MemorySnapshot[] | undefined;
  readonly requireSourceCatalog?: boolean | undefined;
  readonly requireWebPolicy?: boolean | undefined;
}

interface FrozenAuthorizationSnapshot {
  readonly baseAllowed: boolean;
  readonly sourceAllowed: readonly boolean[];
  readonly webPolicyAllowed: boolean;
}

interface InternalProviderExposure {
  readonly reference: InternalReference;
  readonly sourceKind: "document" | "chat_message";
  readonly logicalSourceIdentity: string;
  readonly contentItemIdentity: string;
  readonly publisherIssueId?: string | undefined;
  readonly publisherDocumentId?: string | undefined;
  readonly stage: "internal_search_preview" | "internal_inspection";
  readonly visibleTokenCount: number;
}

/** Stable namespace-aware identity used for every document exposure and citation. */
export const documentReferenceIdentity = (
  reference: Extract<InternalReference, { kind: "document" }>,
): string => namespacedDocumentEvidenceIdentity(reference.source, reference.documentId);

const documentCandidateIdentity = (candidate: {
  readonly sourceId: string;
  readonly documentId: string;
  readonly publisherIssueId?: string | undefined;
  readonly publisherDocumentId?: string | undefined;
}): string =>
  candidate.publisherIssueId === undefined && candidate.publisherDocumentId === undefined
    ? namespacedDocumentEvidenceIdentity(
        { kind: "public", sourceId: candidate.sourceId },
        candidate.documentId,
      )
    : candidate.publisherIssueId !== undefined && candidate.publisherDocumentId !== undefined
      ? namespacedDocumentEvidenceIdentity(
          {
            kind: "publisher",
            sourceId: candidate.sourceId,
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
  versionId: string,
  content: string,
): string => `${namespace}:${versionId}:${content}`;

const documentDiscoveryKey = (
  reference: Extract<InternalReference, { kind: "document" }>,
): string =>
  `${reference.source.kind}:${reference.source.sourceId}:${reference.source.kind === "publisher" ? reference.source.issueId : ""}:${reference.documentId}:${reference.documentVersionId}`;

const documentReferenceSelectionKey = (
  reference: Extract<InternalReference, { kind: "document" }>,
): string =>
  `${documentReferenceIdentity(reference)}:${reference.documentVersionId}:${JSON.stringify(reference.ranges ?? [])}`;

const documentReferenceRangeKey = (
  reference: Extract<InternalReference, { kind: "document" }>,
  range: { readonly charStart: number; readonly charEnd: number },
): string =>
  `${documentReferenceIdentity(reference)}:${reference.documentVersionId}:${JSON.stringify(range)}`;

const documentPreviewIdentity = (item: DocumentPreview): string =>
  item.kind === "publisher"
    ? item.issueId === undefined
      ? (() => {
          throw new Error("publisher search result is missing issue identity");
        })()
      : namespacedDocumentEvidenceIdentity(
          {
            kind: "publisher",
            sourceId: item.sourceId,
            issueId: item.issueId,
            documentId: item.documentId,
          },
          item.documentId,
        )
    : namespacedDocumentEvidenceIdentity(
        { kind: "public", sourceId: item.sourceId },
        item.documentId,
      );

const providerVisibleExposureMarker = (exposure: {
  readonly sourceKind: "document" | "chat_message" | "memory" | "web";
  readonly logicalSourceIdentity: string;
  readonly contentItemIdentity: string;
  readonly stage: string;
  readonly visibleTokenCount: number;
}) => ({
  sourceKind: exposure.sourceKind,
  logicalSourceIdentity: exposure.logicalSourceIdentity,
  contentItemIdentity: exposure.contentItemIdentity,
  exposureStage: exposure.stage,
  visibleTokenCount: exposure.visibleTokenCount,
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
  readonly initiatingUserId: string;
  readonly userMessageId: string;
  readonly userMessage: string;
  readonly locale: Locale;
  readonly market: Market;
  readonly citationNonceHex: string;
  readonly memoryMode: "private_owner" | "disabled";
  readonly webRequested: boolean;
  readonly webPolicy: EffectiveWebPolicy;
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

const ExecutionPlanSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("single"), reason: z.string().trim().min(1) }).strict(),
  z
    .object({
      mode: z.literal("fanout"),
      reason: z.string().trim().min(1),
      topics: z
        .array(
          z
            .object({ question: z.string().trim().min(1), relevantTurnIds: z.array(z.string()) })
            .strict(),
        )
        .min(2)
        .max(3),
    })
    .strict(),
]);
// Z.AI documents function parameters as a root object and currently supports
// only automatic tool selection. Keep the provider-facing shape flat while
// validating the exact discriminated union before any output is accepted.
const ExecutionPlanProviderSchema = z
  .object({
    mode: z.enum(["single", "fanout"]),
    reason: z.string().trim().min(1),
    topics: z
      .array(
        z
          .object({ question: z.string().trim().min(1), relevantTurnIds: z.array(z.string()) })
          .strict(),
      )
      .min(2)
      .max(3)
      .optional(),
  })
  .strict();

const InternalReferenceSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("document"),
        documentId: z.string(),
        documentVersionId: z.string(),
        source: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("public"),
              sourceId: z.string().regex(/^public:[^:\s]+$/u),
            })
            .strict(),
          z
            .object({
              kind: z.literal("publisher"),
              sourceId: z.string().regex(/^publisher:[^:\s]+$/u),
              issueId: z.string().trim().min(1),
              documentId: z.string().trim().min(1),
            })
            .strict(),
        ]),
        ranges: z
          .array(z.object({ charStart: z.number().int(), charEnd: z.number().int() }).strict())
          .optional(),
        purpose: z.string().trim().min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("chat_message"),
        messageId: z.string(),
        purpose: z.string().trim().min(1),
      })
      .strict(),
  ])
  .superRefine((reference, context) => {
    if (
      reference.kind === "document" &&
      reference.source.kind === "publisher" &&
      reference.source.documentId !== reference.documentId
    ) {
      context.addIssue({
        code: "custom",
        message: "publisher source documentId must equal the outer documentId",
      });
    }
  });

const InternalQuerySchema = z.discriminatedUnion("target", [
  z
    .object({
      target: z.literal("documents"),
      terms: z.string().trim().min(1),
      purpose: z.string().trim().min(1),
      sourceIds: z.array(z.string()).optional(),
      countries: z.array(z.string()).optional(),
      languages: z.array(z.string()).optional(),
      documentTypes: z.array(z.string()).optional(),
      publishedAfter: z.string().optional(),
      publishedBefore: z.string().optional(),
      orderBy: z.enum(["relevance", "recency"]).optional(),
      limit: z.number().int().positive().max(50).optional(),
    })
    .strict(),
  z
    .object({
      target: z.literal("chat_messages"),
      terms: z.string().trim().min(1),
      purpose: z.string().trim().min(1),
      beforeMessageId: z.string().optional(),
      limit: z.number().int().positive().max(50).optional(),
    })
    .strict(),
]);

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
const ContextDecisionArraySchema = z.array(
  z.discriminatedUnion("action", [
    z.object({ id: z.string(), action: z.literal("keep"), reason: z.string() }).strict(),
    z
      .object({
        id: z.string(),
        action: z.literal("range"),
        ranges: z.array(
          z.object({ charStart: z.number().int(), charEnd: z.number().int() }).strict(),
        ),
        reason: z.string(),
      })
      .strict(),
    z.object({ id: z.string(), action: z.literal("omit"), reason: z.string() }).strict(),
  ]),
);
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
const InternalManifestOutputSchema = z
  .object({ entries: z.array(InternalReferenceSchema) })
  .strict();
const WebManifestOutputSchema = z.object({ entries: z.array(WebEvidenceSchema) }).strict();
const ContextPlanOutputSchema = z.object({ decisions: ContextDecisionArraySchema }).strict();

/** Provider-authored value contracts; exported for exhaustive boundary tests. */
export const canonicalProviderValueSchemas = {
  conversationResolution: ConversationResolutionSchema,
  conversationResolutionProvider: ConversationResolutionProviderSchema,
  executionPlan: ExecutionPlanSchema,
  executionPlanProvider: ExecutionPlanProviderSchema,
  internalReference: InternalReferenceSchema,
  internalQuery: InternalQuerySchema,
  memoryReference: MemoryReferenceSchema,
  webEvidence: WebEvidenceSchema,
  memoryProposal: MemoryProposalSchema,
  contextDecisions: ContextDecisionArraySchema,
  topicPacket: TopicPacketSchema,
  memoryProposalOutput: MemoryProposalOutputSchema,
  memoryManifestOutput: MemoryManifestOutputSchema,
  internalManifestOutput: InternalManifestOutputSchema,
  webManifestOutput: WebManifestOutputSchema,
  contextPlanOutput: ContextPlanOutputSchema,
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
): LiveProviderRequest => ({
  requestClass: "main",
  model,
  messages: [
    { role: "system", content: system },
    { role: "user", content: user },
  ],
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
): LiveProviderRequest => ({
  requestClass: "main",
  model,
  messages: [
    { role: "system", content: system },
    { role: "user", content: user },
  ],
  tools: [{ name: toolName, description: toolDescription, parameters }],
  toolChoice: "auto",
  requestedOutputTokens: outputTokens,
  reasoning: "medium",
});

const sourceText = (sourceKey: string, kind: string, label: string | null, text: string): string =>
  [
    `<source key="${sourceKey}" kind="${kind}"${label === null ? "" : ` label=${JSON.stringify(label)}`}>`,
    text,
    "</source>",
  ].join("\n");

const candidateText = (candidate: AnswerCandidate): string => {
  if (candidate.kind === "web") return candidate.quote;
  if (candidate.kind !== "document") return candidate.text;
  return candidate.ranges
    .map((range) => candidate.text.slice(range.charStart, range.charEnd))
    .join("\n…\n");
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

interface ConversationReductionCandidate {
  readonly id: string;
  readonly kind: "conversation_entry";
  readonly rank: number;
  readonly purpose: "Conversation Resolver-selected recent turn";
  readonly label: null;
  readonly renderedTokenCount: number;
  readonly entry: ConversationEntry;
  readonly text: string;
}

type ReductionCandidate = AnswerCandidate | ConversationReductionCandidate;

const conversationReductionCandidateId = (entry: ConversationEntry): string =>
  `conversation_entry:${entry.turnId}`;

const reductionCandidateText = (candidate: ReductionCandidate): string =>
  candidate.kind === "conversation_entry" ? candidate.text : candidateText(candidate);

const searchWithinCandidatePage = (
  candidate: ReductionCandidate,
  terms: string,
  cursor = 0,
  maximumMatches = 50,
): {
  readonly matches: ReadonlyArray<{ readonly charStart: number; readonly charEnd: number }>;
  readonly matchPreviews: ReadonlyArray<{
    readonly range: { readonly charStart: number; readonly charEnd: number };
    readonly text: string;
  }>;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly cursor: number | null;
  readonly scope: {
    readonly kind: "selected_document_ranges" | "complete_candidate";
    readonly ranges: ReadonlyArray<{ readonly charStart: number; readonly charEnd: number }>;
    readonly matchOffset: number;
    readonly maximumMatches: number;
  };
} => {
  if (terms === "" || maximumMatches < 1 || cursor < 0) {
    throw new Error("candidate search bounds must be positive and the query must be non-empty");
  }
  const matches: Array<{ readonly charStart: number; readonly charEnd: number }> = [];
  const searchedRanges =
    candidate.kind === "document"
      ? candidate.ranges
      : [{ charStart: 0, charEnd: reductionCandidateText(candidate).length }];
  let matchedBeforePage = 0;
  for (const range of searchedRanges) {
    const text =
      candidate.kind === "document"
        ? candidate.text.slice(range.charStart, range.charEnd)
        : reductionCandidateText(candidate);
    // Use the Unicode-aware regular-expression matcher on the original text.
    // Lowercasing the complete string first can expand a code point (for
    // example, U+0130) and move every later match, so an index in that derived
    // string is not an offset that can safely be passed to String#slice.
    const matcher = new RegExp(terms.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu");
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(text)) !== null) {
      const index = match.index;
      if (matchedBeforePage >= cursor) {
        matches.push({
          charStart: range.charStart + index,
          charEnd: range.charStart + index + match[0].length,
        });
        if (matches.length > maximumMatches) break;
      }
      matchedBeforePage += 1;
      // The literal matcher cannot produce an empty match for non-empty
      // terms, but keep the progress guard for unusual Unicode input.
      if (match[0].length === 0) matcher.lastIndex += 1;
    }
    if (matches.length > maximumMatches) break;
  }
  const truncated = matches.length > maximumMatches;
  const selected = truncated ? matches.slice(0, maximumMatches) : matches;
  const matchPreviews =
    candidate.kind === "document"
      ? (() => {
          const previews: Array<{
            readonly range: { readonly charStart: number; readonly charEnd: number };
            readonly text: string;
          }> = [];
          const fingerprints = new Set<string>();
          for (const match of selected) {
            const sourceRange = searchedRanges.find(
              (range) => match.charStart >= range.charStart && match.charEnd <= range.charEnd,
            );
            if (sourceRange === undefined) continue;
            const precedingBoundary = candidate.text.lastIndexOf(". ", match.charStart - 1);
            const followingBoundary = candidate.text.indexOf(". ", match.charEnd);
            let charStart = Math.max(
              sourceRange.charStart,
              precedingBoundary < sourceRange.charStart
                ? sourceRange.charStart
                : precedingBoundary + 2,
            );
            let charEnd = Math.min(
              sourceRange.charEnd,
              followingBoundary < 0 ? match.charEnd + 320 : followingBoundary + 1,
            );
            if (charEnd - charStart > 640) {
              charStart = Math.max(sourceRange.charStart, match.charStart - 320);
              charEnd = Math.min(sourceRange.charEnd, match.charEnd + 320);
            }
            const text = candidate.text.slice(charStart, charEnd);
            const fingerprint = text
              .toLocaleLowerCase()
              .replace(/\p{Number}+/gu, "#")
              .replace(/\s+/gu, " ")
              .trim();
            if (fingerprints.has(fingerprint)) continue;
            fingerprints.add(fingerprint);
            previews.push({ range: { charStart, charEnd }, text });
            if (previews.length === 8) break;
          }
          return previews;
        })()
      : [];
  return {
    matches: selected,
    matchPreviews,
    complete: !truncated,
    truncated,
    cursor: truncated ? cursor + selected.length : null,
    scope: {
      kind: candidate.kind === "document" ? "selected_document_ranges" : "complete_candidate",
      ranges: searchedRanges,
      matchOffset: cursor,
      maximumMatches,
    },
  };
};

export const searchWithinCandidate = (
  candidate: AnswerCandidate,
  terms: string,
  maximumMatches = 50,
): ReadonlyArray<{ readonly charStart: number; readonly charEnd: number }> =>
  searchWithinCandidatePage(candidate, terms, 0, maximumMatches).matches;

export const searchWithinCandidateWindow = (
  candidate: AnswerCandidate,
  terms: string,
  cursor = 0,
  maximumMatches = 50,
) => searchWithinCandidatePage(candidate, terms, cursor, maximumMatches);

const topicPacketSchemaMinimumOutputTokens = (modelId: string): number =>
  resolveRuntimeModel(modelId).countTextTokens(
    JSON.stringify({ topicId: "t1", status: "partial", claims: [], gaps: ["gap"] }),
  );

const controlledRuntimeFailure = (code: AiRunErrorCode): AiRuntimeError =>
  new AiRuntimeError(code, code, { taskRetryable: false });

const canonicalInternalSearchQueryKey = (query: InternalQuery): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(query).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  );

export const internalSearchQueryIssue = (terms: string): string | undefined => {
  const normalized = terms.normalize("NFC").trim();
  if (normalized.includes('"')) return "internal search terms must not contain quoted phrases";
  if (/\p{L}-\p{L}/u.test(normalized)) {
    return "internal search terms must separate words joined by hyphens";
  }
  const tokens = normalized.split(/\s+/u).filter((token) => token !== "");
  const operands = tokens.filter((token) => token.toUpperCase() !== "OR").length;
  const orCount = tokens.length - operands;
  if (Math.max(0, operands - orCount) > 3) {
    return "internal search terms must contain at most three required terms";
  }
  return undefined;
};

export class InternalRetrievalProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InternalRetrievalProtocolError";
  }
}

/**
 * Enforces A's two ordinary search/refinement turns while preserving required
 * cursor continuations. Each provider turn may contain one search call, and a
 * completed non-empty result closes further searching for that target.
 */
export class InternalRetrievalSearchProtocol {
  private readonly ordinarySearchTurns = new Set<number>();
  private readonly searchCallsByTurn = new Set<number>();
  private readonly pendingCursors = new Map<
    string,
    { readonly cursor: number; readonly providerRequestIndex: number }
  >();
  private readonly cursorContinuationTurns = new Set<number>();
  private completeNonEmptySearchTurn: number | undefined;

  beforeSearch(
    query: InternalQuery,
    cursor: number | undefined,
    providerRequestIndex: number,
  ): void {
    const key = canonicalInternalSearchQueryKey(query);
    const pending = this.pendingCursors.get(key);
    if (cursor !== undefined) {
      if (pending === undefined || pending.cursor !== cursor) {
        throw new InternalRetrievalProtocolError(
          "internal search continuation did not use the exact returned cursor",
        );
      }
      if (this.searchCallsByTurn.has(providerRequestIndex)) {
        throw new InternalRetrievalProtocolError(
          "internal search permits at most one call per provider turn",
        );
      }
      this.searchCallsByTurn.add(providerRequestIndex);
      this.cursorContinuationTurns.add(providerRequestIndex);
      return;
    }
    if (this.cursorContinuationTurns.has(providerRequestIndex)) {
      throw new InternalRetrievalProtocolError(
        "internal search cursor continuation must be followed by termination",
      );
    }
    if (this.searchCallsByTurn.has(providerRequestIndex)) {
      throw new InternalRetrievalProtocolError(
        "internal search permits at most one call per provider turn",
      );
    }
    const hasPendingPriorTurn = [...this.pendingCursors.values()].some(
      (obligation) => obligation.providerRequestIndex !== providerRequestIndex,
    );
    if (hasPendingPriorTurn) {
      throw new InternalRetrievalProtocolError(
        "internal search has an unresolved cursor continuation",
      );
    }
    const hasPendingCurrentTurn = this.pendingCursors.size > 0;
    if (
      this.completeNonEmptySearchTurn !== undefined &&
      this.completeNonEmptySearchTurn !== providerRequestIndex &&
      !hasPendingCurrentTurn
    ) {
      throw new InternalRetrievalProtocolError(
        "internal search cannot continue after a complete non-empty result",
      );
    }
    if (!this.ordinarySearchTurns.has(providerRequestIndex)) {
      if (this.ordinarySearchTurns.size >= 2) {
        throw new InternalRetrievalProtocolError("internal search/refinement turn limit exceeded");
      }
      this.ordinarySearchTurns.add(providerRequestIndex);
    }
    this.searchCallsByTurn.add(providerRequestIndex);
  }

  afterSearch(
    query: InternalQuery,
    complete: boolean,
    itemCount: number,
    cursor: number | null,
    providerRequestIndex: number,
  ): void {
    const key = canonicalInternalSearchQueryKey(query);
    if (complete) {
      this.pendingCursors.delete(key);
      if (itemCount > 0) this.completeNonEmptySearchTurn = providerRequestIndex;
      return;
    }
    if (cursor !== null) this.pendingCursors.set(key, { cursor, providerRequestIndex });
  }
}

const immutableSourceIdentity = (source: FinalSourceRecord): string => {
  const locator = source.locator;
  const identity =
    locator.kind === "document"
      ? {
          kind: locator.kind,
          sourceId: locator.sourceId,
          documentId: locator.documentId,
          documentVersionId: locator.documentVersionId,
          contentHash: locator.contentHash,
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

export class CanonicalWorkflowOperations {
  constructor(
    private readonly connectionString: string,
    private readonly config: CanonicalAiConfig,
    private readonly agents: CanonicalAgentClient,
    private readonly web?: WebResearchBoundary | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private db<A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> {
    const signal = currentTaskAbortSignal();
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
        return {
          candidateId: candidate.id,
          sourceKey: source.sourceKey,
          kind: candidate.kind,
          purpose: candidate.purpose,
          label: source.label,
          ranges: candidate.kind === "document" ? candidate.ranges : [],
        };
      }),
    };
  }

  private contextMeasurementPayload(state: ContextState, consumerTaskId: string) {
    const model = resolveRuntimeModel(state.request.model);
    const messages = state.request.messages.map((message) => {
      if (message.role !== "user") return message;
      try {
        const parsed = JSON.parse(message.content) as Record<string, unknown>;
        if (!("evidence" in parsed)) return message;
        return {
          ...message,
          content: JSON.stringify({ ...parsed, selectedConversation: [], evidence: "" }),
        };
      } catch {
        return message;
      }
    });
    const mandatoryInputTokens = model.countRequestTokens({ ...state.request, messages });
    return {
      consumerTaskId,
      ...(state.topicId === undefined ? {} : { topicId: state.topicId }),
      mandatoryInputTokens,
      discretionaryInputTokens: Math.max(0, state.inputTokens - mandatoryInputTokens),
      totalInputTokens: state.inputTokens,
      requestedOutputTokens: state.request.requestedOutputTokens,
      usableInputTokens: state.usableInputTokens,
      contextWindow: model.contextWindow,
      status: state.status,
      reductionRan: state.reductionRan,
      reductionFeedback: state.reductionFeedback,
      restrictedContextLedger: this.restrictedContextLedger(
        state,
        state.topicId === undefined ? "direct" : "topic",
      ),
    };
  }

  private currentEffectiveWebPolicy(
    enabled: boolean,
    allowedDomains: readonly string[] | null,
  ): EffectiveWebPolicy {
    return effectiveWebPolicy({
      enabled,
      allowedDomains,
      providerAvailable: this.config.webResearchProvider === "tinyfish",
      maxDomainFilters: this.config.aiWebMaxDomainFilters,
    });
  }

  private async assertLiveAuthorization(
    load: LoadedTurn,
    options: LiveAuthorizationOptions = {},
  ): Promise<void> {
    const messageIds = (options.conversation ?? []).flatMap((entry) => [
      entry.userMessageId,
      ...("assistantMessageId" in entry ? [entry.assistantMessageId] : []),
    ]);
    const memorySnapshots = options.memories ?? [];
    const sourceCatalogIds = options.requireSourceCatalog
      ? load.sourceCatalog.map((source) => source.sourceId)
      : [];
    const currentEffectiveWebPolicy = (
      enabled: boolean,
      allowedDomains: readonly string[] | null,
    ) => this.currentEffectiveWebPolicy(enabled, allowedDomains);
    const rows = await this.db(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{
          readonly baseAllowed: boolean;
          readonly messagesAllowed: boolean;
          readonly memoriesAllowed: boolean;
          readonly catalogAllowed: boolean;
          readonly webEnabled: boolean | null;
          readonly webAllowedDomains: readonly string[] | null;
        }>`
          with base as (
            select runs.id, runs.chat_id, runs.initiating_user_id, chats.company_id
            from ai_runs runs
            join chats
              on chats.id = runs.chat_id
             and chats.deleted_at is null
            join chat_messages current_message
              on current_message.id = runs.user_message_id
             and current_message.chat_id = chats.id
             and current_message.author = 'user'
            join client_companies companies
              on companies.id = chats.company_id
             and companies.recovery_deleted_at is null
             and companies.purged_at is null
            join client_company_memberships memberships
              on memberships.company_id = chats.company_id
             and memberships.user_id = runs.initiating_user_id
             and memberships.revoked_at is null
            join platform_users users
              on users.id = runs.initiating_user_id
             and users.recovery_deleted_at is null
             and users.purged_at is null
            where runs.id = ${load.aiRunId}
              and runs.chat_id = ${load.chatId}
              and runs.initiating_user_id = ${load.initiatingUserId}
              and runs.user_message_id = ${load.userMessageId}
              and runs.finished_at is null
              and runs.failed_at is null
              and (
                (chats.shared_at is null and chats.user_id = runs.initiating_user_id)
                or chats.shared_at is not null
              )
          ), requested_messages as (
            select value as message_id
            from jsonb_array_elements_text(${JSON.stringify(messageIds)}::jsonb)
          ), requested_memories as (
            select value as memory
            from jsonb_array_elements(${JSON.stringify(memorySnapshots)}::jsonb)
          ), requested_catalog as (
            select value as source_id
            from jsonb_array_elements_text(${JSON.stringify(sourceCatalogIds)}::jsonb)
          )
          select
            exists(select 1 from base) as "baseAllowed",
            not exists(
              select 1 from requested_messages requested
              where not exists(
                select 1 from base
                join chat_messages messages
                  on messages.chat_id = base.chat_id
                 and messages.id::text = requested.message_id
              )
            ) as "messagesAllowed",
            not exists(
              select 1 from requested_memories requested
              where not exists(
                select 1 from base
                join user_memories memories
                  on memories.user_id = base.initiating_user_id
                 and memories.id::text = requested.memory->>'memoryId'
                 and memories.head_revision_id::text = requested.memory->>'memoryRevisionId'
                 and memories.kind = requested.memory->>'kind'
                 and memories.content = requested.memory->>'content'
                 and memories.deleted_at is null
                 and memories.provenance_only_at is null
              )
            ) as "memoriesAllowed",
            not exists(
              select 1 from requested_catalog requested
              where requested.source_id is null
                or (
                  requested.source_id !~ '^public:[^:[:space:]]+$'
                  and requested.source_id !~ '^publisher:[^:[:space:]]+$'
                )
                or (
                  requested.source_id ~ '^public:[^:[:space:]]+$'
                  and not exists(
                    select 1 from base
                    join client_company_public_source_settings settings
                      on settings.client_company_id = base.company_id
                     and requested.source_id = 'public:' || settings.source_id
                     and settings.enabled
                    join public_sources sources on sources.source_id = settings.source_id
                  )
                ) or (
                  requested.source_id ~ '^publisher:[^:[:space:]]+$'
                  and not exists(
                    select 1 from base
                    join chat_subscription_sources selected on selected.chat_id = base.chat_id
                    join client_subscription_accesses accesses
                      on accesses.id = selected.access_id
                     and accesses.client_company_id = selected.client_company_id
                     and accesses.subscription_id = selected.subscription_id
                     and accesses.state in ('active', 'ending', 'paused')
                    join client_employee_subscription_grants grants
                      on grants.access_id = accesses.id
                     and grants.client_company_id = accesses.client_company_id
                     and grants.user_id = base.initiating_user_id
                     and grants.revoked_at is null
                    join publisher_subscriptions subscriptions
                      on subscriptions.id = selected.subscription_id
                    join publisher_companies companies
                      on companies.id = subscriptions.publisher_company_id
                    where requested.source_id = 'publisher:' || selected.subscription_id::text
                  )
                )
            ) as "catalogAllowed",
            (
              select settings.web_search_enabled
              from base
              join client_company_ai_settings settings on settings.company_id = base.company_id
              limit 1
            ) as "webEnabled",
            (
              select settings.web_domain_allowlist
              from base
              join client_company_ai_settings settings on settings.company_id = base.company_id
              limit 1
            ) as "webAllowedDomains"
        `;
      }),
    );
    const row = rows[0];
    if (
      row?.baseAllowed !== true ||
      row.messagesAllowed !== true ||
      row.memoriesAllowed !== true ||
      row.catalogAllowed !== true
    ) {
      throw controlledRuntimeFailure("source_access_revoked");
    }
    if (options.requireWebPolicy) {
      const current = currentEffectiveWebPolicy(
        row.webEnabled === true,
        row.webAllowedDomains ?? null,
      );
      try {
        const valid = recheckWebPolicy(load.webPolicy, current);
        if (!valid.enabled) throw controlledRuntimeFailure("web_policy_revoked");
      } catch {
        throw controlledRuntimeFailure("web_policy_revoked");
      }
    }
  }

  private async frozenAuthorizationSnapshot(
    load: LoadedTurn,
    sourceMap: readonly FinalSourceRecord[],
  ): Promise<FrozenAuthorizationSnapshot> {
    const locators = sourceMap.map((source) => ({
      ...source.locator,
      publicProvenance: source.publicProvenance,
    }));
    const currentEffectiveWebPolicy = (
      enabled: boolean,
      allowedDomains: readonly string[] | null,
    ) => this.currentEffectiveWebPolicy(enabled, allowedDomains);
    const rows = await this.db(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{
          readonly baseAllowed: boolean;
          readonly sourceAllowed: readonly boolean[];
          readonly webSourceCount: number;
          readonly webEnabled: boolean | null;
          readonly webAllowedDomains: readonly string[] | null;
        }>`
          with base as (
            select runs.id, runs.chat_id, runs.initiating_user_id, chats.company_id
            from ai_runs runs
            join chats on chats.id = runs.chat_id and chats.deleted_at is null
            join chat_messages current_message
              on current_message.id = runs.user_message_id
             and current_message.chat_id = chats.id
             and current_message.author = 'user'
            join client_companies companies
              on companies.id = chats.company_id
             and companies.recovery_deleted_at is null
             and companies.purged_at is null
            join client_company_memberships memberships
              on memberships.company_id = chats.company_id
             and memberships.user_id = runs.initiating_user_id
             and memberships.revoked_at is null
            join platform_users users
              on users.id = runs.initiating_user_id
             and users.recovery_deleted_at is null
             and users.purged_at is null
            where runs.id = ${load.aiRunId}
              and runs.chat_id = ${load.chatId}
              and runs.initiating_user_id = ${load.initiatingUserId}
              and runs.user_message_id = ${load.userMessageId}
              and runs.finished_at is null
              and runs.failed_at is null
              and (
                (chats.shared_at is null and chats.user_id = runs.initiating_user_id)
                or chats.shared_at is not null
              )
          ), requested as (
            select value as source,
                   value->'publicProvenance' as provenance,
                   (ordinality - 1)::int as source_index
            from jsonb_array_elements(${JSON.stringify(locators)}::jsonb) with ordinality
          ), evaluated as (
            select requested.source_index,
              case requested.source->>'kind'
                when 'document' then case
                  when requested.source ? 'publisherIssueId' then exists(
                    select 1 from base
                    join chat_subscription_sources selected on selected.chat_id = base.chat_id
                    join client_subscription_accesses accesses
                      on accesses.id = selected.access_id
                     and accesses.client_company_id = selected.client_company_id
                     and accesses.subscription_id = selected.subscription_id
                     and accesses.state in ('active', 'ending', 'paused')
                    join client_employee_subscription_grants grants
                      on grants.access_id = accesses.id
                     and grants.client_company_id = accesses.client_company_id
                     and grants.user_id = base.initiating_user_id
                     and grants.revoked_at is null
                    join issue_deliveries deliveries
                      on deliveries.access_id = accesses.id
                     and deliveries.client_company_id = selected.client_company_id
                    join publisher_issues issues
                              on issues.id = deliveries.issue_id
                              and issues.subscription_id = selected.subscription_id
                              and issues.id::text = requested.source->>'publisherIssueId'
                              and ('publisher:' || selected.subscription_id::text) = requested.source->>'sourceId'
                     and issues.status = 'published'
                     and issues.restricted_at is null
                     and issues.deleted_at is null
                    join brief_documents documents
                      on documents.issue_id = issues.id
                     and documents.id::text = requested.source->>'publisherDocumentId'
                     and documents.id::text = requested.source->>'documentId'
                     and documents.deleted_at is null
                    join brief_document_versions versions
                              on versions.brief_document_id = documents.id
                              and versions.id::text = requested.source->>'documentVersionId'
                              and versions.content_hash = requested.source->>'contentHash'
                              and requested.provenance->>'citationUrl' =
                                ('/v1/issues/' || issues.id::text || '/documents/' || documents.id::text || '/content')
                  )
                  else exists(
                    select 1 from base
                    join public_source_documents documents
                              on documents.document_id = requested.source->>'documentId'
                              and documents.document_id = requested.source->>'documentVersionId'
                              and documents.content_hash = requested.source->>'contentHash'
                              and ('public:' || documents.source_id) = requested.source->>'sourceId'
                              and requested.provenance->>'citationUrl' = documents.canonical_url
                    join client_company_public_source_settings settings
                      on settings.client_company_id = base.company_id
                     and settings.source_id = documents.source_id
                     and settings.enabled
                  )
                end
                when 'chat_message' then exists(
                  select 1 from base
                  join chat_messages messages
                    on messages.chat_id = base.chat_id
                   and messages.id::text = requested.source->>'messageId'
                )
                when 'memory' then exists(
                  select 1 from base
                  join user_memories memories
                    on memories.user_id = base.initiating_user_id
                   and memories.id::text = requested.source->>'memoryId'
                   and memories.head_revision_id::text = requested.source->>'memoryRevisionId'
                   and memories.deleted_at is null
                   and memories.provenance_only_at is null
                )
                when 'web' then exists(select 1 from base)
                else false
              end as allowed,
              requested.source->>'kind' as kind
            from requested
          )
          select
            exists(select 1 from base) as "baseAllowed",
            coalesce(array_agg(evaluated.allowed order by evaluated.source_index), '{}') as "sourceAllowed",
            count(*) filter (where evaluated.kind = 'web')::int as "webSourceCount",
            (
              select settings.web_search_enabled
              from base
              join client_company_ai_settings settings on settings.company_id = base.company_id
              limit 1
            ) as "webEnabled",
            (
              select settings.web_domain_allowlist
              from base
              join client_company_ai_settings settings on settings.company_id = base.company_id
              limit 1
            ) as "webAllowedDomains"
          from evaluated
        `;
      }),
    );
    const row = rows[0];
    const webPolicyAllowed = (() => {
      // A requested W path remains authorization-bearing even when it returns
      // no evidence.  Otherwise revocation between selection and context
      // freeze (or a later answer retry) can reach the model with an empty
      // web source map and still stream deltas.
      if (!load.webRequested && (row?.webSourceCount ?? 0) === 0) return true;
      const current = currentEffectiveWebPolicy(
        row?.webEnabled === true,
        row?.webAllowedDomains ?? null,
      );
      try {
        return recheckWebPolicy(load.webPolicy, current).enabled;
      } catch {
        return false;
      }
    })();
    return {
      baseAllowed: row?.baseAllowed === true,
      sourceAllowed: row?.sourceAllowed ?? [],
      webPolicyAllowed,
    };
  }

  private async taskExecutionCoordinates(
    _runId: string,
    taskId: string,
  ): Promise<{ readonly loopIteration: number; readonly attempt: number }> {
    return requireCurrentTaskCoordinates(taskId);
  }

  async loadTurn(aiRunId: string): Promise<LoadedTurn> {
    const execution = requireCurrentTaskCoordinates("load-turn");
    const conversationRecentTurns = this.config.aiConversationRecentTurns;
    const boundConversationInventory = (
      run: Pick<LoadRow, "userMessage" | "locale" | "market"> & {
        readonly currentDate: string;
      },
      entries: readonly ConversationEntry[],
    ) => this.boundConversationInventory(run, entries);
    const now = this.now;
    return this.db(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<LoadRow>`
          select
            runs.id::text as "aiRunId",
            runs.chat_id::text as "chatId",
            runs.initiating_user_id as "initiatingUserId",
            runs.user_message_id::text as "userMessageId",
            messages.content as "userMessage",
            runs.locale,
            runs.market,
            encode(runs.citation_nonce, 'hex') as "citationNonceHex",
            chats.memory_mode as "memoryMode",
            runs.web_search_enabled as "webRequested",
            runs.effective_web_policy as "webPolicy"
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
          join client_company_memberships memberships
            on memberships.company_id = chats.company_id
           and memberships.user_id = runs.initiating_user_id
           and memberships.revoked_at is null
          join platform_users users
            on users.id = runs.initiating_user_id
           and users.recovery_deleted_at is null
           and users.purged_at is null
          where runs.id = ${aiRunId}
            and runs.finished_at is null
            and runs.failed_at is null
            and (
              (chats.shared_at is null and chats.user_id = runs.initiating_user_id)
              or chats.shared_at is not null
            )
        `;
        const run = rows[0];
        if (run === undefined) return yield* Effect.fail(new Error(`ai run not found: ${aiRunId}`));
        yield* markAiRunStarted(aiRunId);
        const conversationRows = yield* sql<ConversationRow>`
          with eligible as (
            select
              prior.id::text as "turnId",
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
            where prior.chat_id = ${run.chatId}
              and prior.id <> ${run.aiRunId}
              and (prior.finished_at is not null or prior.failed_at is not null)
          )
          select "turnId", "userMessageId", "userContent", "assistantMessageId",
                 "assistantContent", "errorCode", retryable, "totalCount"
          from eligible
          order by "createdAt" desc, "turnId" desc
          limit ${conversationRecentTurns}
        `;
        const conversation = [...conversationRows].reverse().map(
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
        const currentDate = now().toISOString().slice(0, 10);
        const boundedConversation = boundConversationInventory(
          { ...run, currentDate },
          conversation,
        );
        const totalConversationCount = conversationRows[0]?.totalCount ?? 0;
        const countBoundaryExcludedCount = Math.max(
          0,
          totalConversationCount - conversation.length,
        );
        const tokenBoundaryExcludedCount = conversation.length - boundedConversation.length;
        yield* insertAiObservation({
          runId: run.aiRunId,
          chatId: run.chatId,
          emittingTask: "load-turn",
          loopIteration: execution.loopIteration,
          attempt: execution.attempt,
          observationKey: [
            "load-turn",
            execution.loopIteration,
            execution.attempt,
            "conversation_inventory_boundary",
          ].join(":"),
          kind: "conversation_inventory_boundary",
          payload: {
            consideredCount: totalConversationCount,
            includedCount: boundedConversation.length,
            countBoundaryExcludedCount,
            tokenBoundaryExcludedCount,
          },
        });
        const memoryRows = yield* sql<{
          readonly memoryId: string;
          readonly memoryRevisionId: string;
          readonly kind: MemorySnapshot["kind"];
          readonly content: string;
        }>`
          select id::text as "memoryId", head_revision_id::text as "memoryRevisionId", kind, content
          from user_memories
          where user_id = ${run.initiatingUserId}
            and deleted_at is null
            and provenance_only_at is null
          order by created_at, id
        `;
        const sources = yield* sql<{
          readonly sourceId: string;
          readonly displayName: string;
          readonly country: string;
          readonly language: string;
          readonly ingestionType: string;
        }>`
          select 'public:' || sources.source_id as "sourceId",
                 sources.display_name as "displayName",
                 coalesce(sources.country, '') as country,
                 coalesce(sources.language, '') as language,
                 sources.ingestion_method as "ingestionType"
          from public_sources sources
          join client_company_public_source_settings public_settings
            on public_settings.source_id = sources.source_id
           and public_settings.enabled
          join chats public_chat
            on public_chat.id = ${run.chatId}
           and public_chat.company_id = public_settings.client_company_id
          union all
          select 'publisher:' || subscriptions.id::text as "sourceId",
                 companies.name as "displayName", '' as country, '' as language,
                 'publisher_subscription' as "ingestionType"
          from chat_subscription_sources selected
          join client_subscription_accesses accesses
            on accesses.id = selected.access_id
           and accesses.client_company_id = selected.client_company_id
           and accesses.subscription_id = selected.subscription_id
           and accesses.state in ('active', 'ending', 'paused')
          join client_employee_subscription_grants grants
            on grants.access_id = accesses.id
           and grants.client_company_id = accesses.client_company_id
           and grants.user_id = ${run.initiatingUserId}
           and grants.revoked_at is null
          join publisher_subscriptions subscriptions on subscriptions.id = accesses.subscription_id
          join publisher_companies companies
            on companies.id = subscriptions.publisher_company_id
          where selected.chat_id = ${run.chatId}
            and exists (
              select 1 from issue_deliveries deliveries
              where deliveries.access_id = accesses.id
                and deliveries.client_company_id = selected.client_company_id
            )
          order by "sourceId"
        `;
        return {
          aiRunId: run.aiRunId,
          chatId: run.chatId,
          initiatingUserId: run.initiatingUserId,
          userMessageId: run.userMessageId,
          userMessage: run.userMessage,
          locale: run.locale,
          market: run.market,
          currentDate,
          citationNonce: [...Buffer.from(run.citationNonceHex, "hex")],
          priorTerminalTurnCount: totalConversationCount,
          conversation: boundedConversation,
          memories: memoryRows,
          memoryMode: run.memoryMode,
          sourceCatalog: sources,
          webRequested: run.webRequested,
          webPolicy: run.webPolicy,
        };
      }),
    );
  }

  private boundConversationInventory(
    run: Pick<LoadRow, "userMessage" | "locale" | "market"> & {
      readonly currentDate: string;
    },
    entries: readonly ConversationEntry[],
  ): readonly ConversationEntry[] {
    const model = resolveRuntimeModel(this.config.aiFastModel);
    const selected: ConversationEntry[] = [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      const candidate = [entry, ...selected];
      const request: LiveProviderRequest = {
        requestClass: "fast",
        model: this.config.aiFastModel,
        messages: [
          { role: "system", content: ConversationResolverPrompt },
          {
            role: "user",
            content: JSON.stringify({
              currentMessage: run.userMessage,
              entries: candidate,
              locale: run.locale,
              market: run.market,
              currentDate: run.currentDate,
            }),
          },
        ],
        tools: [
          {
            name: "emit_conversation_resolution",
            description: "Emit the validated conversation resolution.",
            parameters: z.toJSONSchema(ConversationResolutionProviderSchema),
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

  private fastStructuredRequestFits(
    system: string,
    user: string,
    toolName: string,
    toolDescription: string,
    parameters: Readonly<Record<string, unknown>>,
    requestedOutputTokens: number,
  ): boolean {
    const request: LiveProviderRequest = {
      requestClass: "fast",
      model: this.config.aiFastModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      tools: [{ name: toolName, description: toolDescription, parameters }],
      toolChoice: "auto",
      requestedOutputTokens,
      reasoning: "medium",
    };
    const model = resolveRuntimeModel(this.config.aiFastModel);
    return (
      model.countRequestTokens(request) <=
      Math.min(this.config.aiFastInputMaxTokens, model.contextWindow - requestedOutputTokens)
    );
  }

  async resolveConversation(load: LoadedTurn): Promise<ConversationResolution> {
    if (load.priorTerminalTurnCount === 0) {
      const resolution = {
        mode: "continue" as const,
        retrievalQuestion: load.userMessage,
        selectedTurnIds: [] as readonly string[],
      };
      await this.observe(load, "resolve-conversation", "conversation_resolution", resolution);
      return resolution;
    }
    const taskId = "resolve-conversation";
    const execution = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    const coordinates = taskCoordinates(taskId, "conversation_resolver", execution);
    const output = await this.agents.structured({
      requestClass: "fast",
      model: this.config.aiFastModel,
      system: ConversationResolverPrompt,
      user: JSON.stringify({
        currentMessage: load.userMessage,
        entries: load.conversation,
        locale: load.locale,
        market: load.market,
        currentDate: load.currentDate,
      }),
      outputToolName: "emit_conversation_resolution",
      outputToolDescription: "Emit the validated conversation resolution.",
      outputSchema: z.toJSONSchema(ConversationResolutionProviderSchema),
      validate: (value) =>
        ConversationResolutionSchema.parse(ConversationResolutionProviderSchema.parse(value)),
      requestedOutputTokens: Math.min(2048, this.config.aiFastOutputMaxTokens),
      reasoning: "medium",
      coordinates,
      onBeforeRequest: async (request, requestCoordinates) => {
        await this.assertLiveAuthorization(load, { conversation: load.conversation });
        await this.recordConversationExposures(load, taskId, load.conversation, requestCoordinates);
        const model = resolveRuntimeModel(request.model);
        await this.observe(
          load,
          taskId,
          "provider_request_attestation",
          {
            requestKind: "conversation_resolution",
            modelId: request.model,
            requestSha256Hex: requestSha256Hex(request),
            inputTokens: model.countRequestTokens(request),
            usableInputTokens: Math.min(
              this.config.aiFastInputMaxTokens,
              model.contextWindow - request.requestedOutputTokens,
            ),
            requestedOutputTokens: request.requestedOutputTokens,
            currentUserMessageId: load.userMessageId,
            currentDate: load.currentDate,
            conversation: load.conversation.map((entry) =>
              "assistantMessageId" in entry
                ? {
                    kind: "complete",
                    turnId: entry.turnId,
                    userMessageId: entry.userMessageId,
                    assistantMessageId: entry.assistantMessageId,
                  }
                : {
                    kind: "failed",
                    turnId: entry.turnId,
                    userMessageId: entry.userMessageId,
                    errorCode: entry.errorCode,
                    retryable: entry.retryable,
                  },
            ),
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
    const resolution = validateConversationResolution(
      output,
      load.conversation.map((entry) => entry.turnId),
    );
    await this.observe(load, taskId, "conversation_resolution", resolution, coordinates);
    return resolution;
  }

  async planExecution(
    load: LoadedTurn,
    resolution: Extract<ConversationResolution, { mode: "continue" }>,
  ) {
    const taskId = "plan-execution";
    const execution = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    const coordinates = taskCoordinates(taskId, "execution_planner", execution);
    const exactOutputContract = [
      'The only valid atomic output is exactly {"mode":"single","reason":"non-empty"}.',
      'The only valid fanout output is exactly {"mode":"fanout","reason":"non-empty","topics":[{"question":"first non-empty question","relevantTurnIds":[]},{"question":"second non-empty question","relevantTurnIds":[]}]} with exactly two or three topics.',
      "Do not add topic IDs, route names, markdown, or any field not shown.",
      execution.attempt > 1
        ? `A prior schema attempt failed; this is bounded attempt ${execution.attempt}.`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    const selectedEntries = load.conversation.filter((entry) =>
      resolution.selectedTurnIds.includes(entry.turnId),
    );
    const output = await this.agents.structured({
      requestClass: "fast",
      model: this.config.aiFastModel,
      system: `${ExecutionPlannerPrompt}\n\n${exactOutputContract}`,
      user: JSON.stringify({
        originalMessage: load.userMessage,
        resolvedQuestion: resolution.retrievalQuestion,
        selectedEntries,
        locale: load.locale,
        market: load.market,
        webRequested: load.webRequested,
        maxFanoutTopicCount: this.config.aiFanoutMaxTopics,
      }),
      outputToolName: "emit_execution_plan",
      outputToolDescription:
        "Emit exactly one schema-valid atomic single plan or a fanout plan with exactly two or three topics.",
      outputSchema: z.toJSONSchema(ExecutionPlanProviderSchema),
      validate: (value) => ExecutionPlanSchema.parse(ExecutionPlanProviderSchema.parse(value)),
      requestedOutputTokens: Math.min(1536, this.config.aiFastOutputMaxTokens),
      reasoning: "medium",
      coordinates,
      onBeforeRequest: async (_request, requestCoordinates) => {
        await this.assertLiveAuthorization(load, {
          conversation: selectedEntries,
          requireWebPolicy: load.webRequested,
        });
        await this.recordConversationExposures(load, taskId, selectedEntries, requestCoordinates);
      },
    });
    const normalized = validateAndNormalizeExecutionPlan(
      output,
      resolution.selectedTurnIds,
      this.config.aiFanoutMaxTopics,
    );
    await this.observe(load, taskId, "execution_plan", normalized, coordinates);
    return output;
  }

  normalizePlan(
    value: unknown,
    resolution: Extract<ConversationResolution, { mode: "continue" }>,
  ): NormalizedExecutionPlan {
    return validateAndNormalizeExecutionPlan(
      value,
      resolution.selectedTurnIds,
      this.config.aiFanoutMaxTopics,
    );
  }

  async extractMemory(load: LoadedTurn): Promise<MemoryExtractionArtifact> {
    const taskId = "memory-extract";
    const execution = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    const coordinates = taskCoordinates(taskId, "memory_extractor", execution);
    const extractionSchema = z.toJSONSchema(MemoryProposalOutputSchema);
    const extractionUser = JSON.stringify({
      currentUserMessage: load.userMessage,
      activeMemories: load.memories,
    });
    const direct =
      load.memories.length <= this.config.aiMemoryDirectMaxItems &&
      this.fastStructuredRequestFits(
        MemoryExtractorPrompt,
        extractionUser,
        "emit_memory_proposals",
        "Emit zero or more private memory proposals.",
        extractionSchema,
        this.config.aiFastOutputMaxTokens,
      );
    let proposals: readonly MemoryProposal[];
    if (direct) {
      const output = await this.agents.structured({
        requestClass: "fast",
        model: this.config.aiFastModel,
        system: MemoryExtractorPrompt,
        user: extractionUser,
        outputToolName: "emit_memory_proposals",
        outputToolDescription: "Emit zero or more private memory proposals.",
        outputSchema: extractionSchema,
        validate: zodValidator(MemoryProposalOutputSchema),
        requestedOutputTokens: this.config.aiFastOutputMaxTokens,
        reasoning: "medium",
        coordinates,
        onBeforeRequest: async (_request, requestCoordinates) => {
          await this.assertLiveAuthorization(load, { memories: load.memories });
          await this.recordConversationExposures(load, taskId, [], requestCoordinates);
          await this.recordMemoryExposures(
            load.aiRunId,
            taskId,
            load.memories,
            "memory_direct_inventory",
            requestCoordinates,
          );
        },
      });
      proposals = output.proposals;
    } else {
      const visibleMemories = new Map<string, MemorySnapshot>();
      proposals = await this.agents.toolLoop({
        requestClass: "fast",
        model: this.config.aiFastModel,
        system: MemoryExtractorPrompt,
        user: JSON.stringify({
          currentUserMessage: load.userMessage,
          activeMemoryCount: load.memories.length,
          toolBounds: {
            maximumTurns: this.config.aiRetrievalMaxTurns,
            maximumResultItems: this.config.aiMemoryToolResultMaxItems,
          },
        }),
        maximumTurns: this.config.aiRetrievalMaxTurns,
        requestedOutputTokens: this.config.aiFastOutputMaxTokens,
        reasoning: "medium",
        coordinates: { taskId, attempt: execution.attempt, agentRole: "memory_extractor" },
        onBeforeRequest: async (_request, requestCoordinates) => {
          const exposed = [...visibleMemories.values()];
          await this.assertLiveAuthorization(load, { memories: exposed });
          await this.recordConversationExposures(load, taskId, [], requestCoordinates);
          await this.recordMemoryExposures(
            load.aiRunId,
            taskId,
            exposed,
            "memory_tool_result",
            requestCoordinates,
          );
        },
        terminalToolName: "emit_memory_proposals",
        validateTerminal: (value) => MemoryProposalOutputSchema.parse(value).proposals,
        tools: this.memoryTools(
          load,
          "emit_memory_proposals",
          z.toJSONSchema(MemoryProposalOutputSchema),
          (memories) => {
            for (const memory of memories) {
              visibleMemories.set(`${memory.memoryId}:${memory.memoryRevisionId}`, memory);
            }
          },
        ),
      });
    }
    const result = validateMemoryProposals(proposals, load.memories);
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

  private async liveMemorySnapshots(
    load: LoadedTurn,
    requested: readonly MemorySnapshot[],
    filter: { readonly terms?: string | undefined; readonly memoryId?: string | undefined } = {},
  ): Promise<readonly MemorySnapshot[]> {
    const rows = await this.db(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{
          readonly baseAllowed: boolean;
          readonly memories: readonly MemorySnapshot[];
        }>`
          with base as (
            select runs.chat_id, runs.initiating_user_id
            from ai_runs runs
            join chats on chats.id = runs.chat_id and chats.deleted_at is null
            join client_companies companies
              on companies.id = chats.company_id
             and companies.recovery_deleted_at is null
             and companies.purged_at is null
            join client_company_memberships memberships
              on memberships.company_id = chats.company_id
             and memberships.user_id = runs.initiating_user_id
             and memberships.revoked_at is null
            join platform_users users
              on users.id = runs.initiating_user_id
             and users.recovery_deleted_at is null
             and users.purged_at is null
            where runs.id = ${load.aiRunId}
              and runs.chat_id = ${load.chatId}
              and runs.initiating_user_id = ${load.initiatingUserId}
              and runs.finished_at is null
              and runs.failed_at is null
              and (
                (chats.shared_at is null and chats.user_id = runs.initiating_user_id)
                or chats.shared_at is not null
              )
          ), requested as (
            select value as memory, ordinality
            from jsonb_array_elements(${JSON.stringify(requested)}::jsonb) with ordinality
          ), authorized as (
            select jsonb_build_object(
                     'memoryId', memories.id::text,
                     'memoryRevisionId', memories.head_revision_id::text,
                     'kind', memories.kind,
                     'content', memories.content
                   ) as memory,
                   requested.ordinality
            from base
            join requested on true
            join user_memories memories
              on memories.user_id = base.initiating_user_id
             and memories.id::text = requested.memory->>'memoryId'
             and memories.head_revision_id::text = requested.memory->>'memoryRevisionId'
             and memories.kind = requested.memory->>'kind'
             and memories.content = requested.memory->>'content'
             and memories.deleted_at is null
             and memories.provenance_only_at is null
            where (${filter.memoryId ?? null}::text is null or memories.id::text = ${filter.memoryId ?? null})
              and (
                ${filter.terms ?? null}::text is null
                or position(lower(${filter.terms ?? null}) in lower(memories.content)) > 0
              )
          )
          select exists(select 1 from base) as "baseAllowed",
                 coalesce(
                   jsonb_agg(authorized.memory order by authorized.ordinality)
                     filter (where authorized.memory is not null),
                   '[]'::jsonb
                 ) as memories
          from authorized
        `;
      }),
    );
    const row = rows[0];
    if (row?.baseAllowed !== true) throw controlledRuntimeFailure("source_access_revoked");
    return row.memories;
  }

  private memoryTools(
    load: LoadedTurn,
    terminalName: string,
    terminalSchema: Readonly<Record<string, unknown>>,
    onVisible: (memories: readonly MemorySnapshot[]) => void,
  ) {
    return [
      {
        definition: {
          name: "search_memories",
          description: "Search the complete active memory inventory with a cursor.",
          parameters: z.toJSONSchema(
            z.object({ query: z.string(), cursor: z.number().int().min(0).optional() }).strict(),
          ),
        },
        execute: async (args: Readonly<Record<string, unknown>>) => {
          const parsed = z
            .object({ query: z.string(), cursor: z.number().int().min(0).optional() })
            .strict()
            .parse(args);
          const terms = parsed.query.toLocaleLowerCase();
          const matches = await this.liveMemorySnapshots(load, load.memories, { terms });
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
              this.config.aiFastModel,
            );
            if (tokens > this.config.aiFastOutputMaxTokens) break;
            items.push(memory);
          }
          onVisible(items);
          const next = offset + items.length;
          return {
            items,
            complete: next >= matches.length,
            truncated: next < matches.length,
            cursor: next >= matches.length ? null : next,
            scope: {
              kind: "complete_active_memory_inventory",
              offset,
              maximumItems: this.config.aiMemoryToolResultMaxItems,
            },
            ...(items.length === 0 && next < matches.length ? { nextItemTooLarge: true } : {}),
          };
        },
      },
      {
        definition: {
          name: "inspect_memory",
          description: "Inspect one complete active memory snapshot.",
          parameters: z.toJSONSchema(z.object({ memoryId: z.string() }).strict()),
        },
        execute: async (args: Readonly<Record<string, unknown>>) => {
          const { memoryId } = z.object({ memoryId: z.string() }).strict().parse(args);
          const memory = (await this.liveMemorySnapshots(load, load.memories, { memoryId }))[0];
          if (memory === undefined) return { found: false, complete: true };
          const tokens = this.visibleTokenCount(
            JSON.stringify({ found: true, complete: true, memory }),
            this.config.aiFastModel,
          );
          if (tokens > this.config.aiFastOutputMaxTokens) {
            return { found: true, complete: false, itemTooLarge: true, memoryId };
          }
          onVisible([memory]);
          return { found: true, complete: true, memory };
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
    coordinates: {
      readonly loopIteration: number;
      readonly attempt: number;
      readonly providerRequestIndex: number;
      readonly providerRequestSha256Hex: string;
    },
  ) {
    const execution = ownedProviderExecutionCoordinates(taskId, coordinates);
    await Promise.all(
      memories.map((memory) =>
        this.db(
          insertAiSourceExposure({
            runId,
            taskId: execution.taskId,
            loopIteration: execution.loopIteration,
            attempt: execution.attempt,
            providerRequestIndex: execution.providerRequestIndex,
            providerRequestSha256Hex: coordinates.providerRequestSha256Hex,
            sourceKind: "memory",
            logicalSourceIdentity: memoryEvidenceIdentity(memory.memoryId),
            contentItemIdentity: memory.memoryRevisionId,
            exposureStage: stage,
            visibleTokenCount: this.visibleTokenCount(memory.content, this.config.aiFastModel),
          }),
        ),
      ),
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
    } = {},
  ): Promise<void> {
    const execution = ownedProviderExecutionCoordinates(taskId, coordinates);
    const messages = [
      ...(options.includeCurrentUser === false
        ? []
        : [{ messageId: load.userMessageId, content: load.userMessage }]),
      ...entries.flatMap((entry) => [
        { messageId: entry.userMessageId, content: entry.userContent },
        ...("assistantMessageId" in entry
          ? [{ messageId: entry.assistantMessageId, content: entry.assistantContent }]
          : []),
      ]),
    ];
    await Promise.all(
      messages.map(({ messageId, content }) =>
        this.db(
          insertAiSourceExposure({
            runId: load.aiRunId,
            taskId: execution.taskId,
            loopIteration: execution.loopIteration,
            attempt: execution.attempt,
            providerRequestIndex: execution.providerRequestIndex,
            providerRequestSha256Hex: coordinates.providerRequestSha256Hex,
            sourceKind: "chat_message",
            logicalSourceIdentity: chatMessageEvidenceIdentity(messageId),
            contentItemIdentity: messageId,
            exposureStage: "provider_input",
            visibleTokenCount: this.visibleTokenCount(
              content,
              options.modelId ?? this.config.aiFastModel,
            ),
          }),
        ),
      ),
    );
  }

  private async assertLiveInternalReferences(
    load: LoadedTurn,
    references: readonly InternalReference[],
  ): Promise<void> {
    const rows = await this.db(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly baseAllowed: boolean; readonly referencesAllowed: boolean }>`
          with base as (
            select runs.chat_id, runs.initiating_user_id, chats.company_id
            from ai_runs runs
            join chats on chats.id = runs.chat_id and chats.deleted_at is null
            join client_companies companies
              on companies.id = chats.company_id
             and companies.recovery_deleted_at is null
             and companies.purged_at is null
            join client_company_memberships memberships
              on memberships.company_id = chats.company_id
             and memberships.user_id = runs.initiating_user_id
             and memberships.revoked_at is null
            join platform_users users
              on users.id = runs.initiating_user_id
             and users.recovery_deleted_at is null
             and users.purged_at is null
            where runs.id = ${load.aiRunId}
              and runs.chat_id = ${load.chatId}
              and runs.initiating_user_id = ${load.initiatingUserId}
              and runs.finished_at is null
              and runs.failed_at is null
              and (
                (chats.shared_at is null and chats.user_id = runs.initiating_user_id)
                or chats.shared_at is not null
              )
          ), requested as (
            select value as reference
            from jsonb_array_elements(${JSON.stringify(references)}::jsonb)
          )
          select exists(select 1 from base) as "baseAllowed",
                 not exists(
                   select 1 from requested
                   where case requested.reference->>'kind'
                     when 'chat_message' then not exists(
                       select 1 from base
                       join chat_messages messages
                         on messages.chat_id = base.chat_id
                        and messages.id::text = requested.reference->>'messageId'
                     )
                     when 'document' then not (
                       (requested.reference->'source'->>'kind' = 'public'
                        and requested.reference->'source'->>'sourceId' ~ '^public:[^:[:space:]]+$'
                        and exists(
                         select 1 from base
                         join public_source_documents documents
                           on documents.document_id = requested.reference->>'documentId'
                          and documents.document_id = requested.reference->>'documentVersionId'
                         and requested.reference->'source'->>'sourceId' = 'public:' || documents.source_id
                         join client_company_public_source_settings settings
                           on settings.client_company_id = base.company_id
                          and settings.source_id = documents.source_id
                          and settings.enabled
                       )) or (requested.reference->'source'->>'kind' = 'publisher'
                        and requested.reference->'source'->>'sourceId' ~ '^publisher:[^:[:space:]]+$'
                        and exists(
                         select 1 from base
                         join chat_subscription_sources selected on selected.chat_id = base.chat_id
                         join client_subscription_accesses accesses
                           on accesses.id = selected.access_id
                          and accesses.client_company_id = selected.client_company_id
                          and accesses.subscription_id = selected.subscription_id
                          and accesses.state in ('active', 'ending', 'paused')
                         join client_employee_subscription_grants grants
                           on grants.access_id = accesses.id
                          and grants.client_company_id = accesses.client_company_id
                          and grants.user_id = base.initiating_user_id
                          and grants.revoked_at is null
                         join issue_deliveries deliveries
                           on deliveries.access_id = accesses.id
                          and deliveries.client_company_id = selected.client_company_id
                         join publisher_issues issues
                           on issues.id = deliveries.issue_id
                          and issues.subscription_id = selected.subscription_id
                          and issues.status = 'published'
                          and issues.restricted_at is null
                          and issues.deleted_at is null
                          and issues.id::text = requested.reference->'source'->>'issueId'
                          and requested.reference->'source'->>'sourceId' = 'publisher:' || selected.subscription_id::text
                         join publisher_subscriptions subscriptions
                           on subscriptions.id = issues.subscription_id
                         join publisher_companies publisher_company
                           on publisher_company.id = subscriptions.publisher_company_id
                         join brief_documents documents
                           on documents.issue_id = issues.id
                          and documents.id::text = requested.reference->>'documentId'
                          and documents.id::text = requested.reference->'source'->>'documentId'
                          and documents.deleted_at is null
                         join brief_document_versions versions
                           on versions.brief_document_id = documents.id
                          and versions.id::text = requested.reference->>'documentVersionId'
                       ))
                     )
                     else true
                   end
                 ) as "referencesAllowed"
        `;
      }),
    );
    if (rows[0]?.baseAllowed !== true || rows[0]?.referencesAllowed !== true) {
      throw controlledRuntimeFailure("source_access_revoked");
    }
  }

  private async recordInternalProviderExposures(
    load: LoadedTurn,
    taskId: string,
    exposures: readonly InternalProviderExposure[],
    coordinates: PiBoundaryCoordinates & { readonly providerRequestSha256Hex: string },
  ): Promise<void> {
    await Promise.all(
      exposures.map((exposure) =>
        this.db(
          insertAiSourceExposure({
            runId: load.aiRunId,
            taskId,
            loopIteration: coordinates.loopIteration,
            attempt: coordinates.attempt,
            providerRequestIndex: coordinates.providerRequestIndex,
            providerRequestSha256Hex: coordinates.providerRequestSha256Hex,
            sourceKind: exposure.sourceKind,
            logicalSourceIdentity: exposure.logicalSourceIdentity,
            ...(exposure.publisherIssueId === undefined
              ? {}
              : {
                  publisherIssueId: exposure.publisherIssueId,
                  publisherDocumentId: exposure.publisherDocumentId,
                }),
            contentItemIdentity: exposure.contentItemIdentity,
            exposureStage: exposure.stage,
            visibleTokenCount: exposure.visibleTokenCount,
          }),
        ),
      ),
    );
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
  ): Promise<void> {
    const execution = ownedProviderExecutionCoordinates(taskId, coordinates);
    await this.recordConversationExposures(
      load,
      execution.taskId,
      context.selectedConversation,
      { ...execution, providerRequestSha256Hex: coordinates.providerRequestSha256Hex },
      {
        modelId: this.config.aiMainModel,
      },
    );
    await Promise.all(
      context.candidates.map((candidate) => {
        const content = candidateText(candidate);
        const sourceKind = candidate.kind;
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
                candidate.documentVersionId,
                sha256Base64Url(JSON.stringify(candidate.ranges)),
              )
            : candidate.kind === "chat_message"
              ? candidate.messageId
              : candidate.kind === "memory"
                ? candidate.memoryRevisionId
                : `${candidate.url}:${candidate.quoteHash}`;
        return this.db(
          insertAiSourceExposure({
            runId: load.aiRunId,
            taskId: execution.taskId,
            loopIteration: execution.loopIteration,
            attempt: execution.attempt,
            providerRequestIndex: execution.providerRequestIndex,
            providerRequestSha256Hex: coordinates.providerRequestSha256Hex,
            sourceKind,
            logicalSourceIdentity,
            ...(candidate.kind === "document" && candidate.publisherIssueId !== undefined
              ? {
                  publisherIssueId: candidate.publisherIssueId,
                  publisherDocumentId: candidate.publisherDocumentId,
                }
              : {}),
            contentItemIdentity,
            exposureStage: "answer_serialized",
            visibleTokenCount: this.visibleTokenCount(content, this.config.aiMainModel),
          }),
        );
      }),
    );
  }

  private async authorizeFrozenContext(load: LoadedTurn, context: ContextState): Promise<void> {
    const snapshot = await this.frozenAuthorizationSnapshot(load, context.sourceMap);
    if (!snapshot.baseAllowed || snapshot.sourceAllowed.some((allowed) => !allowed)) {
      throw controlledRuntimeFailure("source_access_revoked");
    }
    if (!snapshot.webPolicyAllowed) throw controlledRuntimeFailure("web_policy_revoked");
  }

  async freezeContext(load: LoadedTurn, context: ContextState): Promise<ContextState> {
    if (context.status === "failed") return context;
    if (context.status === "needs_reduction") {
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
    const authorization = await this.frozenAuthorizationSnapshot(load, context.sourceMap);
    if (!authorization.baseAllowed) {
      return { ...context, status: "failed", failureCode: "source_access_revoked" };
    }
    if (!authorization.webPolicyAllowed) {
      return { ...context, status: "failed", failureCode: "web_policy_revoked" };
    }
    if (authorization.sourceAllowed.length !== context.sourceMap.length) {
      return { ...context, status: "failed", failureCode: "source_access_revoked" };
    }
    if (authorization.sourceAllowed.every(Boolean)) {
      return { ...context, inputTokens, usableInputTokens };
    }
    const revoked: Array<{ source: FinalSourceRecord; index: number }> = [];
    for (const [index, source] of context.sourceMap.entries()) {
      if (authorization.sourceAllowed[index] !== true) revoked.push({ source, index });
    }
    if (revoked.some(({ source }) => source.locator.kind === "web")) {
      return { ...context, status: "failed", failureCode: "web_policy_revoked" };
    }
    const candidates = context.candidates.filter(
      (_, index) => authorization.sourceAllowed[index] === true,
    );
    const sourceMap = context.sourceMap.filter(
      (_, index) => authorization.sourceAllowed[index] === true,
    );
    const consumerTaskId =
      context.sourceMap[0]?.uses[0]?.consumerTaskId ??
      (context.topicId === undefined
        ? "single-context-select"
        : `topic-${context.topicId}-context-select`);
    await Promise.all(
      revoked.map(({ source }, index) =>
        this.observe(
          load,
          consumerTaskId,
          "candidate_rejected",
          { candidateId: source.sourceKey, reason: "access_revoked" },
          undefined,
          `access-revoked-${index}`,
        ),
      ),
    );
    const rebuilt = this.measureContext(
      load,
      context.question,
      candidates,
      sourceMap,
      [
        ...context.gaps,
        ...revoked.map(() => "an internal source was revoked before context freeze"),
      ],
      context.reductionRan,
      context.topicId,
      context.selectedConversation,
      candidates,
      sourceMap,
      context.request.requestedOutputTokens,
    );
    await this.observe(
      load,
      consumerTaskId,
      "context_measurement",
      this.contextMeasurementPayload(rebuilt, consumerTaskId),
      undefined,
      "access-revoked-rebuild",
    );
    return rebuilt;
  }

  async selectMemories(
    load: LoadedTurn,
    question: string,
    taskId: string,
  ): Promise<MemorySelectorResult> {
    if (load.memoryMode === "disabled") {
      await this.observe(load, taskId, "retrieval_manifest", {
        selectorRole: "memory",
        references: [],
      });
      return { status: "disabled", reason: "memory_mode_disabled" };
    }
    if (load.memories.length === 0) {
      await this.observe(load, taskId, "retrieval_manifest", {
        selectorRole: "memory",
        references: [],
      });
      return { status: "enabled", entries: [] };
    }
    const execution = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    const coordinates = taskCoordinates(taskId, "memory_selector", execution);
    const selectionSchema = z.toJSONSchema(MemoryManifestOutputSchema);
    const selectionUser = JSON.stringify({ question, memories: load.memories });
    if (
      load.memories.length <= this.config.aiMemoryDirectMaxItems &&
      this.fastStructuredRequestFits(
        MemorySelectorPrompt,
        selectionUser,
        "emit_memory_manifest",
        "Emit selected exact memory snapshot references.",
        selectionSchema,
        Math.min(4096, this.config.aiFastOutputMaxTokens),
      )
    ) {
      const output = await this.agents.structured({
        requestClass: "fast",
        model: this.config.aiFastModel,
        system: MemorySelectorPrompt,
        user: selectionUser,
        outputToolName: "emit_memory_manifest",
        outputToolDescription: "Emit selected exact memory snapshot references.",
        outputSchema: selectionSchema,
        validate: zodValidator(MemoryManifestOutputSchema),
        requestedOutputTokens: Math.min(4096, this.config.aiFastOutputMaxTokens),
        reasoning: "medium",
        coordinates,
        onBeforeRequest: async (_request, requestCoordinates) => {
          await this.assertLiveAuthorization(load, { memories: load.memories });
          await this.recordConversationExposures(load, taskId, [], requestCoordinates, {
            includeCurrentUser: false,
          });
          await this.recordMemoryExposures(
            load.aiRunId,
            taskId,
            load.memories,
            "memory_direct_inventory",
            requestCoordinates,
          );
        },
      });
      const allowed = new Set(
        load.memories.map((memory) => `${memory.memoryId}:${memory.memoryRevisionId}`),
      );
      const seen = new Set<string>();
      for (const entry of output.entries) {
        const identity = `${entry.memoryId}:${entry.memoryRevisionId}`;
        if (!allowed.has(identity)) {
          throw new Error("memory selector invented an unavailable memory revision");
        }
        if (seen.has(identity)) throw new Error("memory selector emitted a duplicate reference");
        seen.add(identity);
      }
      await this.observe(
        load,
        taskId,
        "retrieval_manifest",
        { selectorRole: "memory", references: output.entries },
        coordinates,
      );
      return { status: "enabled", entries: output.entries };
    }
    const visibleMemories = new Map<string, MemorySnapshot>();
    const entries = await this.agents.toolLoop({
      requestClass: "fast",
      model: this.config.aiFastModel,
      system: MemorySelectorPrompt,
      user: JSON.stringify({
        question,
        activeMemoryCount: load.memories.length,
        toolBounds: {
          maximumTurns: this.config.aiRetrievalMaxTurns,
          maximumResultItems: this.config.aiMemoryToolResultMaxItems,
        },
      }),
      tools: this.memoryTools(
        load,
        "emit_memory_manifest",
        z.toJSONSchema(MemoryManifestOutputSchema),
        (memories) => {
          for (const memory of memories) {
            visibleMemories.set(`${memory.memoryId}:${memory.memoryRevisionId}`, memory);
          }
        },
      ),
      terminalToolName: "emit_memory_manifest",
      validateTerminal: (value) => MemoryManifestOutputSchema.parse(value).entries,
      maximumTurns: this.config.aiRetrievalMaxTurns,
      requestedOutputTokens: this.config.aiFastOutputMaxTokens,
      reasoning: "medium",
      coordinates: { taskId, attempt: execution.attempt, agentRole: "memory_selector" },
      onBeforeRequest: async (_request, requestCoordinates) => {
        const exposed = [...visibleMemories.values()];
        await this.assertLiveAuthorization(load, { memories: exposed });
        await this.recordConversationExposures(load, taskId, [], requestCoordinates, {
          includeCurrentUser: false,
        });
        await this.recordMemoryExposures(
          load.aiRunId,
          taskId,
          exposed,
          "memory_tool_result",
          requestCoordinates,
        );
      },
    });
    const allowed = new Set(
      load.memories.map((memory) => `${memory.memoryId}:${memory.memoryRevisionId}`),
    );
    const seen = new Set<string>();
    for (const entry of entries) {
      const identity = `${entry.memoryId}:${entry.memoryRevisionId}`;
      if (!allowed.has(identity)) {
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

  async retrieveInternal(
    load: LoadedTurn,
    question: string,
    taskId: string,
    selectedTurnIds: readonly string[] = load.conversation.map((entry) => entry.turnId),
  ): Promise<readonly InternalReference[]> {
    const selectedConversation = this.selectConversation(load, selectedTurnIds);
    const execution = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    let searches = 0;
    let inspections = 0;
    const searchProtocol = new InternalRetrievalSearchProtocol();
    const discoveredDocuments = new Set<string>();
    const discoveredMessages = new Set<string>();
    // A selector attempt may issue bounded searches across ordinary turns. Bind each
    // logical publisher document to the first immutable version observed and
    // fail closed if its mutable current pointer drifts underneath it.
    const boundPublisherDocumentVersions = new Map<string, string>();
    const providerExposures = new Map<string, InternalProviderExposure>();
    const inspectedDocumentRanges = new Set<string>();
    let protocolErrorReturned = false;
    let completeNonEmptySearch = false;
    const terminalSchema = z.toJSONSchema(InternalManifestOutputSchema);
    const references = await this.agents.toolLoop({
      requestClass: "fast",
      model: this.config.aiFastModel,
      system: InternalRetrievalPrompt,
      user: JSON.stringify({
        question,
        selectedConversation,
        sourceCatalog: load.sourceCatalog,
        locale: load.locale,
        market: load.market,
        currentDate: load.currentDate,
        toolBounds: {
          maximumTurns: this.config.aiRetrievalMaxTurns,
          maximumSearches: this.config.aiInternalMaxSearches,
          maximumInspections: this.config.aiInternalMaxInspections,
          maximumResultsPerSearch: 50,
        },
      }),
      maximumTurns: this.config.aiRetrievalMaxTurns,
      requestedOutputTokens: this.config.aiFastOutputMaxTokens,
      reasoning: "medium",
      coordinates: { taskId, attempt: execution.attempt, agentRole: "internal_retrieval" },
      onBeforeRequest: async (_request, requestCoordinates) => {
        const exposures = [...providerExposures.values()];
        await this.assertLiveAuthorization(load, {
          conversation: selectedConversation,
          requireSourceCatalog: true,
        });
        await this.assertLiveInternalReferences(
          load,
          exposures.map((exposure) => exposure.reference),
        );
        await this.recordConversationExposures(
          load,
          taskId,
          selectedConversation,
          requestCoordinates,
          { includeCurrentUser: false, modelId: this.config.aiFastModel },
        );
        await this.recordInternalProviderExposures(load, taskId, exposures, requestCoordinates);
      },
      terminalToolName: "emit_internal_manifest",
      validateTerminal: (value) => {
        const entries = InternalManifestOutputSchema.parse(value).entries;
        const identities = entries.map((entry) => {
          const discovered = entry.kind === "document" ? discoveredDocuments : discoveredMessages;
          const discoveryIdentity =
            entry.kind === "document" ? documentDiscoveryKey(entry) : entry.messageId;
          if (!discovered.has(discoveryIdentity)) {
            throw new Error(`internal manifest references undiscovered ${entry.kind}`);
          }
          return entry.kind === "document"
            ? documentReferenceSelectionKey(entry)
            : `chat_message:${entry.messageId}`;
        });
        if (new Set(identities).size !== identities.length) {
          throw new Error("internal manifest contains duplicate references");
        }
        const uninspectedRange = entries.some(
          (entry) =>
            entry.kind === "document" &&
            entry.ranges !== undefined &&
            entry.ranges.some(
              (range) => !inspectedDocumentRanges.has(documentReferenceRangeKey(entry, range)),
            ),
        );
        if (uninspectedRange) {
          throw new Error(
            "every selected document range must repeat an exact range from a complete inspect_internal result",
          );
        }
        return entries;
      },
      recoverTerminal: (_value, error) => ({
        complete: false,
        terminalRejected: true,
        message:
          error instanceof Error
            ? error.message
            : "The internal manifest was rejected; complete the bounded search and inspection tools before terminalizing.",
        instruction:
          "Use the advertised search_internal and inspect_internal tools, then emit the terminal manifest on the reserved terminal turn.",
      }),
      // A has the same bounded-loop terminal reservation as web retrieval.
      // Without this, the provider can spend the final allowed turn inspecting
      // an oversized result and leave a successful search without a manifest.
      reserveFinalTurnForTerminal: true,
      enforceTerminalTurn: true,
      disabledToolsForTurn: () =>
        completeNonEmptySearch
          ? ["search_internal", ...(inspections > 0 ? ["inspect_internal"] : [])]
          : [],
      terminalOnlyForTurn: () => completeNonEmptySearch && inspections > 0,
      disabledToolResult: (toolName) => {
        protocolErrorReturned = true;
        return {
          complete: true,
          protocolError: `${toolName} is disabled after the complete retrieval phase`,
          recoveryReferences: [...providerExposures.values()].map((exposure) => exposure.reference),
        };
      },
      tools: [
        {
          definition: {
            name: "search_internal",
            description:
              "Search authorized documents or older messages from this chat. Query terms use PostgreSQL web-search syntax: whitespace is AND and uppercase OR expresses alternatives. Use at most three required terms. A non-English document question's first search must include sparse English content lexemes, alone or OR-paired with user-language lexemes. Make at most one search call per provider turn and never repeat the exact same query without its returned cursor.",
            parameters: z.toJSONSchema(
              z
                .object({
                  query: InternalQuerySchema,
                  cursor: z.number().int().min(0).optional(),
                })
                .strict(),
            ),
          },
          execute: async (args, coordinates) => {
            if (++searches > this.config.aiInternalMaxSearches)
              throw new Error("internal search limit exceeded");
            const parsed = z
              .object({ query: InternalQuerySchema, cursor: z.number().int().min(0).optional() })
              .strict()
              .parse(args);
            const query: InternalQuery = parsed.query;
            const queryIssue = internalSearchQueryIssue(query.terms);
            if (queryIssue !== undefined) {
              return {
                items: [],
                complete: true,
                truncated: false,
                cursor: null,
                queryRejected: true,
                message: `${queryIssue}; retry with a sparse lexical query`,
              };
            }
            if (query.target === "documents") {
              await this.assertBoundPublisherDocumentVersions(boundPublisherDocumentVersions);
            }
            try {
              searchProtocol.beforeSearch(query, parsed.cursor, coordinates.providerRequestIndex);
            } catch (error) {
              if (error instanceof InternalRetrievalProtocolError) {
                protocolErrorReturned = true;
                return {
                  items: [],
                  complete: true,
                  truncated: false,
                  cursor: null,
                  protocolError: error.message,
                  recoveryReferences: [...providerExposures.values()].map(
                    (exposure) => exposure.reference,
                  ),
                };
              }
              throw error;
            }
            const cursor = parsed.cursor ?? 0;
            if (query.target === "documents") {
              const authorizedSourceIds = new Set(
                load.sourceCatalog.map((source) => source.sourceId),
              );
              if (
                query.sourceIds?.some((sourceId) => !authorizedSourceIds.has(sourceId)) === true
              ) {
                throw new Error("internal query requested an unauthorized source");
              }
              const selectedSourceIds = query.sourceIds ?? [...authorizedSourceIds];
              const publicSourceIds = selectedSourceIds
                .filter((sourceId) => isCanonicalPublicDocumentSourceId(sourceId))
                .map((sourceId) => sourceId.slice("public:".length));
              const limit = Math.min(query.limit ?? 20, 50);
              const sentinelLimit = limit + 1;
              const [publicResults, publisherResults] = await Promise.all([
                publicSourceIds.length === 0
                  ? Promise.resolve([] as readonly DocumentPreview[])
                  : this.db(
                      searchDocuments(
                        { ...query, sourceIds: publicSourceIds, limit: sentinelLimit },
                        {
                          access: {
                            kind: "liveChatSourceIds",
                            chatId: load.chatId,
                            initiatingUserId: load.initiatingUserId,
                            sourceIds: publicSourceIds,
                          },
                          maxLimit: 51,
                          recencyHalfLifeDays: 14,
                          now: this.now(),
                        },
                      ),
                    ),
                this.searchPublisherDocuments(
                  load,
                  query,
                  selectedSourceIds,
                  sentinelLimit,
                  boundPublisherDocumentVersions,
                ),
              ]);
              const ranked = [...publicResults, ...publisherResults]
                .map((item, index) => ({ item, index }))
                .sort((left, right) => {
                  if (query.orderBy === "recency") {
                    const dateOrder =
                      (right.item.publishedAt?.getTime() ?? 0) -
                      (left.item.publishedAt?.getTime() ?? 0);
                    if (dateOrder !== 0) return dateOrder;
                  }
                  return (
                    left.index - right.index ||
                    left.item.documentId.localeCompare(right.item.documentId, "en")
                  );
                })
                .slice(0, sentinelLimit)
                .map(({ item }) => item);
              const hardLimitTruncated = ranked.length > limit;
              const bounded = this.boundedToolItems(ranked.slice(0, limit), cursor, {
                hardLimitTruncated,
                maximumResults: limit,
                sourceExposureMarker: (item) =>
                  providerVisibleExposureMarker({
                    sourceKind: "document",
                    logicalSourceIdentity: documentPreviewIdentity(item),
                    contentItemIdentity: documentContentItemIdentity(
                      documentPreviewIdentity(item),
                      item.documentVersionId,
                      sha256Base64Url(item.snippet),
                    ),
                    stage: "internal_search_preview",
                    visibleTokenCount: this.visibleTokenCount(
                      item.snippet,
                      this.config.aiFastModel,
                    ),
                  }),
              });
              for (const item of bounded.items) {
                discoveredDocuments.add(
                  `${item.kind === "publisher" ? "publisher" : "public"}:${item.sourceId}:${item.issueId ?? ""}:${item.documentId}:${item.documentVersionId}`,
                );
              }
              for (const item of bounded.items) {
                const source =
                  item.kind === "publisher"
                    ? item.issueId === undefined
                      ? (() => {
                          throw new Error("publisher search result is missing issue identity");
                        })()
                      : {
                          kind: "publisher" as const,
                          sourceId: item.sourceId,
                          issueId: item.issueId,
                          documentId: item.documentId,
                        }
                    : { kind: "public" as const, sourceId: item.sourceId };
                const logicalSourceIdentity = documentPreviewIdentity(item);
                const contentItemIdentity = documentContentItemIdentity(
                  logicalSourceIdentity,
                  item.documentVersionId,
                  sha256Base64Url(item.snippet),
                );
                const exposure: InternalProviderExposure = {
                  reference: {
                    kind: "document",
                    documentId: item.documentId,
                    documentVersionId: item.documentVersionId,
                    source,
                    purpose: "authorized search preview",
                  },
                  sourceKind: "document",
                  logicalSourceIdentity,
                  contentItemIdentity,
                  ...(item.kind === "publisher" && item.issueId !== undefined
                    ? {
                        publisherIssueId: item.issueId,
                        publisherDocumentId: item.documentId,
                      }
                    : {}),
                  stage: "internal_search_preview",
                  visibleTokenCount: this.visibleTokenCount(item.snippet, this.config.aiFastModel),
                };
                providerExposures.set(
                  `${exposure.stage}:${exposure.contentItemIdentity}`,
                  exposure,
                );
              }
              searchProtocol.afterSearch(
                query,
                bounded.complete,
                bounded.items.length,
                bounded.cursor,
                coordinates.providerRequestIndex,
              );
              completeNonEmptySearch ||= bounded.complete && bounded.items.length > 0;
              return {
                ...bounded,
                __briefSourceExposures: bounded.items.map((item) =>
                  providerVisibleExposureMarker({
                    sourceKind: "document",
                    logicalSourceIdentity: documentPreviewIdentity(item),
                    contentItemIdentity: documentContentItemIdentity(
                      documentPreviewIdentity(item),
                      item.documentVersionId,
                      sha256Base64Url(item.snippet),
                    ),
                    stage: "internal_search_preview",
                    visibleTokenCount: this.visibleTokenCount(
                      item.snippet,
                      this.config.aiFastModel,
                    ),
                  }),
                ),
              };
            }
            const recentMessageIds = selectedConversation.flatMap((entry) => [
              entry.userMessageId,
              ...("assistantMessageId" in entry ? [entry.assistantMessageId] : []),
            ]);
            const limit = Math.min(query.limit ?? 20, 50);
            const results = await this.searchChat(load, query, recentMessageIds, limit + 1);
            const bounded = this.boundedToolItems(results.slice(0, limit), cursor, {
              hardLimitTruncated: results.length > limit,
              maximumResults: limit,
              sourceExposureMarker: (item) =>
                providerVisibleExposureMarker({
                  sourceKind: "chat_message",
                  logicalSourceIdentity: chatMessageEvidenceIdentity(item.messageId),
                  contentItemIdentity: item.messageId,
                  stage: "internal_search_preview",
                  visibleTokenCount: this.visibleTokenCount(item.snippet, this.config.aiFastModel),
                }),
            });
            for (const item of bounded.items) discoveredMessages.add(item.messageId);
            for (const item of bounded.items) {
              const exposure: InternalProviderExposure = {
                reference: {
                  kind: "chat_message",
                  messageId: item.messageId,
                  purpose: "authorized search preview",
                },
                sourceKind: "chat_message",
                logicalSourceIdentity: chatMessageEvidenceIdentity(item.messageId),
                contentItemIdentity: item.messageId,
                stage: "internal_search_preview",
                visibleTokenCount: this.visibleTokenCount(item.snippet, this.config.aiFastModel),
              };
              providerExposures.set(`${exposure.stage}:${exposure.contentItemIdentity}`, exposure);
            }
            searchProtocol.afterSearch(
              query,
              bounded.complete,
              bounded.items.length,
              bounded.cursor,
              coordinates.providerRequestIndex,
            );
            completeNonEmptySearch ||= bounded.complete && bounded.items.length > 0;
            return {
              ...bounded,
              __briefSourceExposures: bounded.items.map((item) =>
                providerVisibleExposureMarker({
                  sourceKind: "chat_message",
                  logicalSourceIdentity: chatMessageEvidenceIdentity(item.messageId),
                  contentItemIdentity: item.messageId,
                  stage: "internal_search_preview",
                  visibleTokenCount: this.visibleTokenCount(item.snippet, this.config.aiFastModel),
                }),
              ),
            };
          },
        },
        {
          definition: {
            name: "inspect_internal",
            description: "Inspect a complete chat message or bounded verbatim document range.",
            parameters: z.toJSONSchema(z.object({ reference: InternalReferenceSchema }).strict()),
          },
          execute: async (args) => {
            if (++inspections > this.config.aiInternalMaxInspections)
              throw new Error("internal inspection limit exceeded");
            const reference = z
              .object({ reference: InternalReferenceSchema })
              .strict()
              .parse(args).reference;
            return this.inspectInternal(
              load,
              reference,
              discoveredDocuments,
              discoveredMessages,
              boundPublisherDocumentVersions,
              (exposure) => {
                providerExposures.set(
                  `${exposure.stage}:${exposure.contentItemIdentity}`,
                  exposure,
                );
                if (
                  exposure.reference.kind === "document" &&
                  exposure.reference.ranges !== undefined
                ) {
                  for (const range of exposure.reference.ranges) {
                    inspectedDocumentRanges.add(
                      documentReferenceRangeKey(exposure.reference, range),
                    );
                  }
                }
              },
            );
          },
        },
        {
          definition: {
            name: "emit_internal_manifest",
            description:
              "Emit final ranked internal references. After a protocolError, copy every exact discovered reference from the preceding successful search result; entries: [] is invalid when that result contained any item.",
            parameters: terminalSchema,
          },
          execute: async () => ({ complete: true }),
        },
      ],
    });
    if (protocolErrorReturned && references.length === 0 && providerExposures.size > 0) {
      throw new Error(
        "internal protocol recovery requires the provider to select a discovered reference",
      );
    }
    for (const reference of references) {
      const allowed = reference.kind === "document" ? discoveredDocuments : discoveredMessages;
      const id =
        reference.kind === "document" ? documentDiscoveryKey(reference) : reference.messageId;
      if (!allowed.has(id))
        throw new Error(`internal manifest references undiscovered ${reference.kind}`);
    }
    const boundManifestVersions = new Map<string, string>();
    const identities = references.map((reference) => {
      if (reference.kind === "document") {
        const identity = documentReferenceIdentity(reference);
        const previousVersion = boundManifestVersions.get(identity);
        if (previousVersion !== undefined && previousVersion !== reference.documentVersionId) {
          throw new Error(
            `publisher document ${reference.documentId} resolved to multiple immutable versions in one selector attempt`,
          );
        }
        boundManifestVersions.set(identity, reference.documentVersionId);
        return documentReferenceSelectionKey(reference);
      }
      return `chat_message:${reference.messageId}`;
    });
    if (new Set(identities).size !== identities.length) {
      throw new Error("internal manifest contains duplicate references");
    }
    await this.observe(
      load,
      taskId,
      "retrieval_manifest",
      { selectorRole: "internal", references },
      execution,
    );
    return references;
  }

  private searchPublisherDocuments(
    load: LoadedTurn,
    query: Extract<InternalQuery, { target: "documents" }>,
    selectedSourceIds: readonly string[],
    resultLimit: number,
    boundPublisherDocumentVersions: Map<string, string>,
  ): Promise<readonly DocumentPreview[]> {
    const selectedSubscriptions = new Set(
      selectedSourceIds
        .filter((sourceId) => isCanonicalPublisherDocumentSourceId(sourceId))
        .map((sourceId) => sourceId.slice("publisher:".length)),
    );
    if (selectedSubscriptions.size === 0) return Promise.resolve([]);
    const selectedSubscriptionIds = [...selectedSubscriptions];
    const countries = [
      ...new Set((query.countries ?? []).map((value) => value.trim().toUpperCase())),
    ];
    const languages = [
      ...new Set(
        (query.languages ?? [])
          .map((value) => value.trim().toLocaleLowerCase().split("-")[0])
          .filter((value): value is string => value !== undefined && value !== ""),
      ),
    ];
    const documentTypes = [
      ...new Set((query.documentTypes ?? []).map((value) => value.trim().toLocaleLowerCase())),
    ];
    const parseDate = (value: string | undefined, name: string): Date | null => {
      if (value === undefined) return null;
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) throw new Error(`${name} is not a valid ISO date`);
      return parsed;
    };
    const publishedAfter = parseDate(query.publishedAfter, "publishedAfter");
    const publishedBefore = parseDate(query.publishedBefore, "publishedBefore");
    const orderByRecency = query.orderBy === "recency";
    return this.db(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const boundDocumentIds = [...boundPublisherDocumentVersions.keys()];
        if (boundDocumentIds.length > 0) {
          const currentPointers = yield* sql<{
            readonly documentId: string;
            readonly documentVersionId: string;
          }>`
            select id::text as "documentId", current_version_id::text as "documentVersionId"
            from brief_documents
            where id::text in (
              select value from jsonb_array_elements_text(${JSON.stringify(boundDocumentIds)}::jsonb)
            )
          `;
          for (const pointer of currentPointers) {
            const boundVersion = boundPublisherDocumentVersions.get(pointer.documentId);
            if (boundVersion !== undefined && boundVersion !== pointer.documentVersionId) {
              throw new Error(
                `publisher document ${pointer.documentId} changed immutable version during selector attempt`,
              );
            }
          }
        }
        const rows = yield* sql<{
          readonly sourceId: string;
          readonly documentId: string;
          readonly documentVersionId: string;
          readonly issueId: string;
          readonly title: string;
          readonly sourceDisplayName: string;
          readonly publishedAt: Date;
          readonly language: string;
          readonly documentType: string;
          readonly textCharCount: number;
          readonly snippet: string;
          readonly score: number;
        }>`
          select subscriptions.id::text as "sourceId",
                 documents.id::text as "documentId",
                 versions.id::text as "documentVersionId",
                 issues.id::text as "issueId",
                 documents.title,
                 companies.name as "sourceDisplayName",
                 issues.published_at as "publishedAt",
                 versions.language,
                 documents.media_type as "documentType",
                 versions.text_char_count as "textCharCount",
                 left(versions.canonical_text, 300) as snippet,
                 ts_rank_cd(
                   versions.search_vector,
                   websearch_to_tsquery(language_to_regconfig(versions.language), ${query.terms})
                 )::float8 as score
          from chat_subscription_sources selected
          join client_subscription_accesses accesses
            on accesses.id = selected.access_id
           and accesses.client_company_id = selected.client_company_id
           and accesses.subscription_id = selected.subscription_id
           and accesses.state in ('active', 'ending', 'paused')
          join client_employee_subscription_grants grants
            on grants.access_id = accesses.id
           and grants.client_company_id = accesses.client_company_id
           and grants.user_id = ${load.initiatingUserId}
           and grants.revoked_at is null
          join issue_deliveries deliveries
            on deliveries.access_id = accesses.id
           and deliveries.client_company_id = selected.client_company_id
          join publisher_issues issues
            on issues.id = deliveries.issue_id
           and issues.subscription_id = selected.subscription_id
           and issues.status = 'published'
           and issues.restricted_at is null
           and issues.deleted_at is null
          join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
          join publisher_companies companies
            on companies.id = subscriptions.publisher_company_id
          join brief_documents documents
            on documents.issue_id = issues.id
           and documents.deleted_at is null
          join brief_document_versions versions
            on versions.id = documents.current_version_id
           and versions.brief_document_id = documents.id
          join chats
            on chats.id = selected.chat_id
           and chats.deleted_at is null
          join client_companies client_companies
            on client_companies.id = chats.company_id
           and client_companies.recovery_deleted_at is null
           and client_companies.purged_at is null
          join client_company_memberships memberships
            on memberships.company_id = chats.company_id
           and memberships.user_id = ${load.initiatingUserId}
           and memberships.revoked_at is null
          join platform_users users
            on users.id = memberships.user_id
           and users.recovery_deleted_at is null
           and users.purged_at is null
          join ai_runs runs
            on runs.id = ${load.aiRunId}
           and runs.chat_id = chats.id
           and runs.initiating_user_id = memberships.user_id
           and runs.finished_at is null
           and runs.failed_at is null
          where selected.chat_id = ${load.chatId}
            and (
              (chats.shared_at is null and chats.user_id = memberships.user_id)
              or chats.shared_at is not null
            )
            and subscriptions.id::text in (
              select value from jsonb_array_elements_text(${JSON.stringify(selectedSubscriptionIds)}::jsonb)
            )
            and jsonb_array_length(${JSON.stringify(countries)}::jsonb) = 0
            and (
              jsonb_array_length(${JSON.stringify(languages)}::jsonb) = 0
              or lower(split_part(versions.language, '-', 1)) in (
                select value from jsonb_array_elements_text(${JSON.stringify(languages)}::jsonb)
              )
            )
            and (
              jsonb_array_length(${JSON.stringify(documentTypes)}::jsonb) = 0
              or lower(documents.media_type) in (
                select value from jsonb_array_elements_text(${JSON.stringify(documentTypes)}::jsonb)
              )
              or 'pdf' in (
                select value from jsonb_array_elements_text(${JSON.stringify(documentTypes)}::jsonb)
              )
            )
            and (${publishedAfter}::timestamptz is null or issues.published_at >= ${publishedAfter})
            and (${publishedBefore}::timestamptz is null or issues.published_at <= ${publishedBefore})
            and versions.search_vector @@ websearch_to_tsquery(
              language_to_regconfig(versions.language),
              ${query.terms}
            )
          order by
            case when ${orderByRecency} then issues.published_at end desc,
            case when not ${orderByRecency} then ts_rank_cd(
              versions.search_vector,
              websearch_to_tsquery(language_to_regconfig(versions.language), ${query.terms})
            ) end desc,
            documents.id
          limit ${resultLimit}
        `;
        for (const row of rows) {
          const boundVersion = boundPublisherDocumentVersions.get(row.documentId);
          if (boundVersion !== undefined && boundVersion !== row.documentVersionId) {
            throw new Error(
              `publisher document ${row.documentId} changed immutable version during selector attempt`,
            );
          }
          boundPublisherDocumentVersions.set(row.documentId, row.documentVersionId);
        }
        return rows.map(
          (row): DocumentPreview => ({
            kind: "publisher",
            sourceId: `publisher:${row.sourceId}`,
            documentId: row.documentId,
            documentVersionId: row.documentVersionId,
            issueId: row.issueId,
            title: row.title,
            sourceDisplayName: row.sourceDisplayName,
            publishedAt: row.publishedAt,
            language: row.language,
            documentType: row.documentType,
            textCharCount: row.textCharCount,
            snippet: row.snippet,
          }),
        );
      }),
    );
  }

  private assertBoundPublisherDocumentVersions(
    boundPublisherDocumentVersions: ReadonlyMap<string, string>,
  ): Promise<void> {
    const boundDocumentIds = [...boundPublisherDocumentVersions.keys()];
    if (boundDocumentIds.length === 0) return Promise.resolve();
    return this.db(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const currentPointers = yield* sql<{
          readonly documentId: string;
          readonly documentVersionId: string;
        }>`
          select id::text as "documentId", current_version_id::text as "documentVersionId"
          from brief_documents
          where id::text in (
            select value from jsonb_array_elements_text(${JSON.stringify(boundDocumentIds)}::jsonb)
          )
        `;
        for (const pointer of currentPointers) {
          const boundVersion = boundPublisherDocumentVersions.get(pointer.documentId);
          if (boundVersion !== undefined && boundVersion !== pointer.documentVersionId) {
            throw new Error(
              `publisher document ${pointer.documentId} changed immutable version during selector attempt`,
            );
          }
        }
      }),
    );
  }

  private searchChat(
    load: LoadedTurn,
    query: Extract<InternalQuery, { target: "chat_messages" }>,
    excludedMessageIds: readonly string[],
    resultLimit: number,
  ) {
    const beforeMessageId = query.beforeMessageId ?? null;
    return this.db(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{
          readonly messageId: string;
          readonly author: string;
          readonly snippet: string;
        }>`
          select messages.id::text as "messageId", messages.author,
                 left(messages.content, 300) as snippet
          from chat_messages messages
          join chats on chats.id = messages.chat_id and chats.deleted_at is null
          join ai_runs runs
            on runs.id = ${load.aiRunId}
           and runs.chat_id = chats.id
           and runs.initiating_user_id = ${load.initiatingUserId}
           and runs.finished_at is null
           and runs.failed_at is null
          join client_companies companies
            on companies.id = chats.company_id
           and companies.recovery_deleted_at is null
           and companies.purged_at is null
          join client_company_memberships memberships
            on memberships.company_id = chats.company_id
           and memberships.user_id = runs.initiating_user_id
           and memberships.revoked_at is null
          join platform_users users
            on users.id = runs.initiating_user_id
           and users.recovery_deleted_at is null
           and users.purged_at is null
          where messages.chat_id = ${load.chatId}
            and messages.id <> ${load.userMessageId}
            and not exists (
              select 1
              from jsonb_array_elements_text(${JSON.stringify(excludedMessageIds)}::jsonb) excluded
              where excluded.value = messages.id::text
            )
            and (
              (chats.shared_at is null and chats.user_id = runs.initiating_user_id)
              or chats.shared_at is not null
            )
            and messages.created_at <= (
              select created_at
              from chat_messages
              where id = ${load.userMessageId}
                and chat_id = ${load.chatId}
            )
            and (
              ${beforeMessageId}::text is null
              or messages.created_at < (
                select created_at from chat_messages
                where id::text = ${beforeMessageId}
                  and chat_id = ${load.chatId}
                limit 1
              )
            )
            and to_tsvector('simple', messages.content) @@ websearch_to_tsquery('simple', ${query.terms})
          order by messages.created_at desc, messages.id desc
          limit ${resultLimit}
        `;
        return rows.map((row) =>
          row.author === "assistant"
            ? { ...row, snippet: stripHistoricalCitationTags(row.snippet) }
            : row,
        );
      }),
    );
  }

  private inspectInternal(
    load: LoadedTurn,
    reference: InternalReference,
    documents: ReadonlySet<string>,
    messages: ReadonlySet<string>,
    boundPublisherDocumentVersions: ReadonlyMap<string, string>,
    onVisible: (exposure: InternalProviderExposure) => void,
  ): Promise<Readonly<Record<string, unknown>>> {
    const fastModel = this.config.aiFastModel;
    const fastOutputMaxTokens = this.config.aiFastOutputMaxTokens;
    const visibleTokenCount = (text: string) => this.visibleTokenCount(text, fastModel);
    return this.db(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        if (reference.kind === "chat_message") {
          if (!messages.has(reference.messageId)) return { found: false, complete: true };
          const rows = yield* sql<{ readonly messageId: string; readonly content: string }>`
            select messages.id::text as "messageId", messages.content
            from chat_messages messages
            join chats on chats.id = messages.chat_id and chats.deleted_at is null
            join ai_runs runs
              on runs.id = ${load.aiRunId}
             and runs.chat_id = chats.id
             and runs.initiating_user_id = ${load.initiatingUserId}
             and runs.finished_at is null
             and runs.failed_at is null
            join client_companies companies
              on companies.id = chats.company_id
             and companies.recovery_deleted_at is null
             and companies.purged_at is null
            join client_company_memberships memberships
              on memberships.company_id = chats.company_id
             and memberships.user_id = runs.initiating_user_id
             and memberships.revoked_at is null
            join platform_users users
              on users.id = runs.initiating_user_id
             and users.recovery_deleted_at is null
             and users.purged_at is null
            where messages.id = ${reference.messageId}
              and messages.chat_id = ${load.chatId}
              and (
                (chats.shared_at is null and chats.user_id = runs.initiating_user_id)
                or chats.shared_at is not null
              )
          `;
          const storedMessage = rows[0];
          const message =
            storedMessage === undefined
              ? undefined
              : {
                  ...storedMessage,
                  content: stripHistoricalCitationTags(storedMessage.content),
                };
          let sourceExposure: ReturnType<typeof providerVisibleExposureMarker> | undefined;
          if (message !== undefined) {
            const exposure: InternalProviderExposure = {
              reference,
              sourceKind: "chat_message",
              logicalSourceIdentity: chatMessageEvidenceIdentity(message.messageId),
              contentItemIdentity: message.messageId,
              stage: "internal_inspection",
              visibleTokenCount: visibleTokenCount(message.content),
            };
            sourceExposure = providerVisibleExposureMarker(exposure);
            const responseTokens = visibleTokenCount(
              JSON.stringify({
                found: true,
                complete: true,
                message,
                __briefSourceExposures: [sourceExposure],
              }),
            );
            if (requiresExplicitInspectionRange(responseTokens, fastOutputMaxTokens)) {
              return {
                found: true,
                complete: false,
                itemTooLarge: true,
                messageId: message.messageId,
              };
            }
            onVisible(exposure);
          }
          return {
            found: message !== undefined,
            complete: true,
            message: message ?? null,
            ...(sourceExposure === undefined ? {} : { __briefSourceExposures: [sourceExposure] }),
          };
        }
        const discoveredKey = documentDiscoveryKey(reference);
        if (!documents.has(discoveredKey)) {
          return { found: false, complete: true };
        }
        const boundVersion = boundPublisherDocumentVersions.get(reference.documentId);
        if (boundVersion !== undefined && boundVersion !== reference.documentVersionId) {
          throw new Error(
            `publisher document ${reference.documentId} changed immutable version during selector attempt`,
          );
        }
        const rows = yield* sql<{
          readonly text: string;
          readonly textCharCount: number;
          readonly publisherIssueId: string | null;
          readonly publisherDocumentId: string | null;
        }>`
          select text, text_char_count as "textCharCount",
                 null::text as "publisherIssueId",
                 null::text as "publisherDocumentId"
          from public_source_documents
          join chats public_chat on public_chat.id = ${load.chatId} and public_chat.deleted_at is null
          join ai_runs public_run
            on public_run.id = ${load.aiRunId}
           and public_run.chat_id = public_chat.id
           and public_run.initiating_user_id = ${load.initiatingUserId}
           and public_run.finished_at is null
           and public_run.failed_at is null
          join client_companies public_company
            on public_company.id = public_chat.company_id
           and public_company.recovery_deleted_at is null
           and public_company.purged_at is null
          join client_company_memberships public_membership
            on public_membership.company_id = public_chat.company_id
           and public_membership.user_id = public_run.initiating_user_id
           and public_membership.revoked_at is null
          join platform_users public_user
            on public_user.id = public_run.initiating_user_id
           and public_user.recovery_deleted_at is null
           and public_user.purged_at is null
          join client_company_public_source_settings public_settings
            on public_settings.client_company_id = public_chat.company_id
           and public_settings.source_id = public_source_documents.source_id
           and public_settings.enabled
          where ${reference.source.kind === "public"}
            and public_source_documents.source_id = ${reference.source.kind === "public" ? reference.source.sourceId.slice("public:".length) : ""}
            and public_source_documents.document_id = ${reference.documentId}
            and public_source_documents.document_id = ${reference.documentVersionId}
            and (
              (public_chat.shared_at is null and public_chat.user_id = public_run.initiating_user_id)
              or public_chat.shared_at is not null
            )
          union all
          select versions.canonical_text as text,
                 versions.text_char_count as "textCharCount",
                 issues.id::text as "publisherIssueId",
                 documents.id::text as "publisherDocumentId"
          from chat_subscription_sources selected
          join client_subscription_accesses accesses
            on accesses.id = selected.access_id
           and accesses.client_company_id = selected.client_company_id
           and accesses.subscription_id = selected.subscription_id
           and accesses.state in ('active', 'ending', 'paused')
          join client_employee_subscription_grants grants
            on grants.access_id = accesses.id
           and grants.client_company_id = accesses.client_company_id
           and grants.user_id = ${load.initiatingUserId}
           and grants.revoked_at is null
          join issue_deliveries deliveries
            on deliveries.access_id = accesses.id
           and deliveries.client_company_id = selected.client_company_id
          join publisher_issues issues
            on issues.id = deliveries.issue_id
           and issues.subscription_id = selected.subscription_id
           and issues.status = 'published'
           and issues.restricted_at is null
           and issues.deleted_at is null
           and issues.id::text = ${reference.source.kind === "publisher" ? reference.source.issueId : ""}
          join publisher_subscriptions subscriptions
            on subscriptions.id = issues.subscription_id
          join publisher_companies publisher_company
            on publisher_company.id = subscriptions.publisher_company_id
          join brief_documents documents
            on documents.issue_id = issues.id
            and documents.id::text = ${reference.documentId}
           and documents.id::text = ${reference.source.kind === "publisher" ? reference.source.documentId : ""}
           and documents.deleted_at is null
          join brief_document_versions versions
            on versions.brief_document_id = documents.id
           and versions.id::text = ${reference.documentVersionId}
          join chats publisher_chat
            on publisher_chat.id = selected.chat_id
           and publisher_chat.deleted_at is null
          join ai_runs publisher_run
            on publisher_run.id = ${load.aiRunId}
           and publisher_run.chat_id = publisher_chat.id
           and publisher_run.initiating_user_id = ${load.initiatingUserId}
           and publisher_run.finished_at is null
           and publisher_run.failed_at is null
          join client_companies publisher_client_company
            on publisher_client_company.id = publisher_chat.company_id
           and publisher_client_company.recovery_deleted_at is null
           and publisher_client_company.purged_at is null
          join client_company_memberships publisher_membership
            on publisher_membership.company_id = publisher_chat.company_id
           and publisher_membership.user_id = publisher_run.initiating_user_id
           and publisher_membership.revoked_at is null
          join platform_users publisher_user
            on publisher_user.id = publisher_run.initiating_user_id
           and publisher_user.recovery_deleted_at is null
           and publisher_user.purged_at is null
          where ${reference.source.kind === "publisher"}
            and selected.subscription_id::text = ${reference.source.kind === "publisher" ? reference.source.sourceId.slice("publisher:".length) : ""}
            and selected.chat_id = ${load.chatId}
            and (
              (publisher_chat.shared_at is null and publisher_chat.user_id = publisher_run.initiating_user_id)
              or publisher_chat.shared_at is not null
            )
          limit 1
        `;
        const row = rows[0];
        if (row === undefined) return { found: false, complete: true };
        const ranges = normalizeSelectedDocumentRanges(reference.ranges, row.text.length);
        const text = ranges
          .map((range) => row.text.slice(range.charStart, range.charEnd))
          .join("\n…\n");
        const exposure: InternalProviderExposure = {
          reference,
          sourceKind: "document",
          logicalSourceIdentity: documentReferenceIdentity(reference),
          ...(reference.source.kind === "publisher"
            ? {
                publisherIssueId: reference.source.issueId,
                publisherDocumentId: reference.source.documentId,
              }
            : {}),
          contentItemIdentity: documentContentItemIdentity(
            documentReferenceIdentity(reference),
            reference.documentVersionId,
            sha256Base64Url(JSON.stringify(ranges)),
          ),
          stage: "internal_inspection",
          visibleTokenCount: visibleTokenCount(text),
        };
        const responseTokens = visibleTokenCount(
          JSON.stringify({
            found: true,
            complete: true,
            text,
            ranges,
            textCharCount: row.textCharCount,
            __briefSourceExposures: [providerVisibleExposureMarker(exposure)],
          }),
        );
        if (requiresExplicitInspectionRange(responseTokens, fastOutputMaxTokens)) {
          return {
            found: true,
            complete: false,
            narrowerRangeRequired: true,
            textCharCount: row.textCharCount,
          };
        }
        onVisible(exposure);
        return {
          found: true,
          complete: true,
          text,
          ranges,
          textCharCount: row.textCharCount,
          __briefSourceExposures: [providerVisibleExposureMarker(exposure)],
        };
      }),
    );
  }

  async retrieveWeb(
    load: LoadedTurn,
    question: string,
    taskId: string,
  ): Promise<WebSelectorResult> {
    const signal = currentTaskAbortSignal();
    throwIfAborted(signal);
    if (!load.webRequested) {
      await this.observe(load, taskId, "retrieval_manifest", {
        selectorRole: "web",
        references: [],
      });
      return { status: "disabled", reason: "not_requested" };
    }
    if (!load.webPolicy.enabled || this.web === undefined) {
      await this.observe(load, taskId, "retrieval_manifest", {
        selectorRole: "web",
        references: [],
      });
      return { status: "disabled", reason: "policy_disabled" };
    }
    const execution = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    throwIfAborted(signal);
    let searches = 0;
    let fetches = 0;
    let completeSearchTurn: number | undefined;
    let completeNonEmptySearch: boolean = false;
    const discoveredUrls = new Map<string, number>();
    const fetched = new Map<string, WebFetchedPage>();
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
    const entries = await this.agents.toolLoop({
      requestClass: "fast",
      model: this.config.aiFastModel,
      system: WebResearchPrompt,
      user: JSON.stringify({
        question,
        locale: load.locale,
        market: load.market,
        policy: load.webPolicy,
        toolBounds: {
          maximumTurns: this.config.aiRetrievalMaxTurns,
          maximumSearches: this.config.aiWebMaxSearches,
          maximumFetches: this.config.aiWebMaxFetches,
          maximumDomainFiltersPerSearch: this.config.aiWebMaxDomainFilters,
        },
      }),
      maximumTurns: this.config.aiRetrievalMaxTurns,
      requestedOutputTokens: this.config.aiFastOutputMaxTokens,
      reasoning: "medium",
      coordinates: { taskId, attempt: execution.attempt, agentRole: "web_research" },
      onBeforeRequest: async (_request, requestCoordinates) => {
        await this.assertLiveAuthorization(load, { requireWebPolicy: true });
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
        if (invalidFetchReturned && fetched.size === 0) {
          throw new Error(
            "web fetch requires a canonical URL discovered by an earlier complete search turn",
          );
        }
        const entries = WebManifestOutputSchema.parse(value).entries;
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
        return entries;
      },
      recoverTerminal: (_value, error) => {
        if (!(error instanceof Error)) return undefined;
        return {
          complete: true,
          terminalRejected: true,
          message:
            "The terminal evidence was rejected because every selected URL must be fetched first, every quote must be verbatim, and references must be unique. Fetch one exact discovered URL, or emit an empty manifest if no discovered page is relevant.",
          discoveredUrls: [...discoveredUrls.keys()],
          fetchedUrls: [...fetched.keys()],
        };
      },
      recoverToolError: (toolName, _arguments, error) => {
        if (
          toolName !== "web_fetch" ||
          !(error instanceof Error) ||
          error.message !==
            "web fetch requires a canonical URL discovered by an earlier complete search turn"
        ) {
          return undefined;
        }
        invalidFetchReturned = true;
        return {
          complete: true,
          toolRejected: true,
          message: "web_fetch requires one exact URL from discoveredUrls",
          discoveredUrls: [...discoveredUrls.keys()],
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
          execute: async (args, coordinates) => {
            if (++searches > this.config.aiWebMaxSearches) {
              protocolErrorReturned = true;
              return { complete: true, protocolError: "web search limit exceeded" };
            }
            const parsed = z
              .object({ query: z.string(), cursor: z.string().optional() })
              .strict()
              .parse(args);
            if (completeNonEmptySearch && parsed.cursor === undefined) {
              protocolErrorReturned = true;
              return {
                complete: true,
                protocolError:
                  "web search cannot continue after a complete non-empty result; fetch discovered URLs and terminate",
              };
            }
            await this.assertLiveAuthorization(load, { requireWebPolicy: true });
            const result = await this.web!.search(
              parsed.query,
              load.locale,
              load.market,
              load.webPolicy,
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
                visibleTokenCount: this.visibleTokenCount(item.snippet, this.config.aiFastModel),
              });
            }
            completeSearchTurn = coordinates.providerRequestIndex;
            completeNonEmptySearch ||= result.results.length > 0;
            throwIfAborted(signal);
            return result;
          },
        },
        {
          definition: {
            name: "web_fetch",
            description: "Fetch one policy-allowed URL through the safe Brief boundary.",
            parameters: z.toJSONSchema(z.object({ url: z.string().url() }).strict()),
          },
          execute: async (args, coordinates) => {
            if (++fetches > this.config.aiWebMaxFetches) {
              protocolErrorReturned = true;
              return { complete: true, protocolError: "web fetch limit exceeded" };
            }
            const { url } = z.object({ url: z.string().url() }).strict().parse(args);
            await this.assertLiveAuthorization(load, { requireWebPolicy: true });
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
            const page = await this.web!.fetch(url, load.webPolicy, coordinates, signal);
            throwIfAborted(signal);
            fetched.set(canonicalizeWebUrl(page.url), page);
            const logicalSourceIdentity = canonicalizeWebUrl(page.url);
            const contentItemIdentity = `${logicalSourceIdentity}:${sha256Base64Url(page.text)}`;
            providerExposures.set(`web_fetch:${contentItemIdentity}`, {
              logicalSourceIdentity,
              contentItemIdentity,
              stage: "web_fetch",
              visibleTokenCount: this.visibleTokenCount(page.text, this.config.aiFastModel),
            });
            throwIfAborted(signal);
            return { ...page, complete: true };
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
    selectedTurnIds: readonly string[] = load.conversation.map((entry) => entry.turnId),
    fanoutSourceKeys?: FanoutSourceKeySet | undefined,
    requestedOutputTokens: number = this.config.aiMainOutputMaxTokens,
  ): Promise<ContextAssembly> {
    const selectedConversation = this.selectConversation(load, selectedTurnIds);
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
    const nonce = new Uint8Array(load.citationNonce);
    const providedKeys = new Map(
      (fanoutSourceKeys?.sources ?? []).map(({ candidateId, sourceKey }) => [
        candidateId,
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
    const sourceMap = ordered.map((candidate, index) => {
      const sourceKey =
        fanoutSourceKeys === undefined
          ? sourceKeyForOrdinal(nonce, index + 1)
          : providedKeys.get(candidate.id);
      if (sourceKey === undefined) {
        throw new Error("fanout candidate lacks a stable source key");
      }
      return this.sourceRecord(candidate, sourceKey, consumerTaskId, index, topicId);
    });
    return {
      question,
      ...(topicId === undefined ? {} : { topicId }),
      candidates: ordered,
      sourceMap,
      selectedConversation,
      gaps: [
        ...(load.webRequested && selectors.web.length === 0 && selectors.webSelection === "enabled"
          ? [WEB_EMPTY_RESULT_GAP]
          : []),
        ...[...materialized.rejections, ...conversationDeduplication.rejections].map(
          (rejection) => `${rejection.candidateId} rejected: ${rejection.reason}`,
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
    const measured = this.measureContext(
      load,
      assembly.question,
      assembly.candidates,
      assembly.sourceMap,
      assembly.gaps,
      false,
      assembly.topicId,
      assembly.selectedConversation,
      assembly.candidates,
      assembly.sourceMap,
      assembly.requestedOutputTokens,
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
    topics: Extract<NormalizedExecutionPlan, { mode: "fanout" }>["topics"],
    selectors: Readonly<Record<TopicId, SelectorBundle>>,
  ): Promise<FanoutSourceKeySet> {
    const orderedIdentities = topics
      .flatMap((topic) => {
        const bundle = selectors[topic.topicId];
        let rank = 0;
        return [
          ...bundle.internal.map((reference) => ({
            topicId: topic.topicId,
            domain: "internal" as const,
            rank: rank++,
            identity:
              reference.kind === "document"
                ? documentReferenceIdentity(reference)
                : chatMessageEvidenceIdentity(reference.messageId),
          })),
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
    const nonce = new Uint8Array(load.citationNonce);
    return {
      sources: uniqueIdentities.map((candidateId, index) => ({
        candidateId,
        sourceKey: sourceKeyForOrdinal(nonce, index + 1),
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

  private selectConversation(
    load: LoadedTurn,
    selectedTurnIds: readonly string[],
  ): readonly ConversationEntry[] {
    const selected = new Set(selectedTurnIds);
    return load.conversation.filter((entry) => selected.has(entry.turnId));
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
        ? [{ candidateId: candidate.id, reason: "duplicate" as const }]
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
          previous.documentVersionId !== candidate.documentVersionId ||
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
      readonly sourceExposureMarker?:
        | ((item: Item) => ReturnType<typeof providerVisibleExposureMarker>)
        | undefined;
    } = {},
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
              __briefSourceExposures: selected.map(options.sourceExposureMarker),
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
          this.config.aiFastModel,
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
    for (const reference of selectors.internal) {
      if (reference.kind === "document") {
        const row = await this.db(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const rows = yield* sql<{
              readonly sourceId: string;
              readonly documentId: string;
              readonly documentVersionId: string;
              readonly contentHash: string;
              readonly text: string;
              readonly title: string;
              readonly canonicalUrl: string;
              readonly sourceName: string;
              readonly issueId: string | null;
              readonly issueTitle: string | null;
              readonly publishedAt: Date | null;
            }>`
              select d.source_id as "sourceId", d.document_id as "documentId", d.document_id as "documentVersionId",
                     d.content_hash as "contentHash", d.text,
                     d.title, d.canonical_url as "canonicalUrl", s.display_name as "sourceName",
                     null::text as "issueId",
                     null::text as "issueTitle",
                     d.published_at as "publishedAt"
              from public_source_documents d
              join public_sources s on s.source_id = d.source_id
              join client_company_public_source_settings public_settings
                on public_settings.source_id = d.source_id and public_settings.enabled
              join chats public_chat
                on public_chat.company_id = public_settings.client_company_id
               and public_chat.id = ${load.chatId}
               and public_chat.deleted_at is null
              join ai_runs public_run
                on public_run.id = ${load.aiRunId}
               and public_run.chat_id = public_chat.id
               and public_run.initiating_user_id = ${load.initiatingUserId}
               and public_run.finished_at is null
               and public_run.failed_at is null
              join client_companies public_company
                on public_company.id = public_chat.company_id
               and public_company.recovery_deleted_at is null
               and public_company.purged_at is null
              join client_company_memberships public_membership
                on public_membership.company_id = public_chat.company_id
               and public_membership.user_id = public_run.initiating_user_id
               and public_membership.revoked_at is null
              join platform_users public_user
                on public_user.id = public_run.initiating_user_id
               and public_user.recovery_deleted_at is null
               and public_user.purged_at is null
              where ${reference.source.kind === "public"}
                and d.source_id = ${reference.source.kind === "public" ? reference.source.sourceId.slice("public:".length) : ""}
                and d.document_id = ${reference.documentId}
                and d.document_id = ${reference.documentVersionId}
                and (
                  (public_chat.shared_at is null and public_chat.user_id = public_run.initiating_user_id)
                  or public_chat.shared_at is not null
                )
              union all
              select selected.subscription_id::text as "sourceId",
                     documents.id::text as "documentId",
                     versions.id::text as "documentVersionId",
                     versions.content_hash as "contentHash",
                     versions.canonical_text as text,
                     documents.title,
                     '/v1/issues/' || issues.id::text || '/documents/' || documents.id::text || '/content' as "canonicalUrl",
                     companies.name as "sourceName",
                     issues.id::text as "issueId",
                     issues.title as "issueTitle",
                     issues.published_at as "publishedAt"
              from chat_subscription_sources selected
              join client_subscription_accesses accesses
                on accesses.id = selected.access_id
               and accesses.client_company_id = selected.client_company_id
               and accesses.subscription_id = selected.subscription_id
               and accesses.state in ('active', 'ending', 'paused')
              join client_employee_subscription_grants grants
                on grants.access_id = accesses.id
               and grants.client_company_id = accesses.client_company_id
               and grants.user_id = ${load.initiatingUserId}
               and grants.revoked_at is null
              join issue_deliveries deliveries
                on deliveries.access_id = accesses.id
               and deliveries.client_company_id = selected.client_company_id
              join publisher_issues issues
                on issues.id = deliveries.issue_id
               and issues.subscription_id = selected.subscription_id
               and issues.status = 'published'
               and issues.restricted_at is null
               and issues.deleted_at is null
              join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
              join publisher_companies companies
                on companies.id = subscriptions.publisher_company_id
              join brief_documents documents
                on documents.issue_id = issues.id
               and documents.id::text = ${reference.documentId}
               and documents.id::text = ${reference.source.kind === "publisher" ? reference.source.documentId : ""}
               and documents.deleted_at is null
              join brief_document_versions versions
                on versions.brief_document_id = documents.id
               and versions.id::text = ${reference.documentVersionId}
              join chats publisher_chat
                on publisher_chat.id = selected.chat_id
               and publisher_chat.deleted_at is null
              join ai_runs publisher_run
                on publisher_run.id = ${load.aiRunId}
               and publisher_run.chat_id = publisher_chat.id
               and publisher_run.initiating_user_id = ${load.initiatingUserId}
               and publisher_run.finished_at is null
               and publisher_run.failed_at is null
              join client_companies publisher_client_company
                on publisher_client_company.id = publisher_chat.company_id
               and publisher_client_company.recovery_deleted_at is null
               and publisher_client_company.purged_at is null
              join client_company_memberships publisher_membership
                on publisher_membership.company_id = publisher_chat.company_id
               and publisher_membership.user_id = publisher_run.initiating_user_id
               and publisher_membership.revoked_at is null
              join platform_users publisher_user
                on publisher_user.id = publisher_run.initiating_user_id
               and publisher_user.recovery_deleted_at is null
               and publisher_user.purged_at is null
              where ${reference.source.kind === "publisher"}
                and selected.subscription_id::text = ${reference.source.kind === "publisher" ? reference.source.sourceId.slice("publisher:".length) : ""}
                and issues.id::text = ${reference.source.kind === "publisher" ? reference.source.issueId : ""}
                and selected.chat_id = ${load.chatId}
                and (
                  (publisher_chat.shared_at is null and publisher_chat.user_id = publisher_run.initiating_user_id)
                  or publisher_chat.shared_at is not null
                )
              limit 1
            `;
            return rows[0] ?? null;
          }),
        );
        if (row === null) {
          rejections.push({
            candidateId: `${documentReferenceIdentity(reference)}:${reference.documentVersionId}`,
            reason: "inaccessible",
          });
          continue;
        }
        if (
          (reference.source.kind === "public" && row.issueId !== null) ||
          (reference.source.kind === "publisher" &&
            (row.issueId !== reference.source.issueId ||
              row.documentId !== reference.source.documentId))
        ) {
          rejections.push({
            candidateId: `${documentReferenceIdentity(reference)}:${reference.documentVersionId}`,
            reason: "ambiguous_provenance",
          });
          continue;
        }
        let ranges;
        try {
          ranges = normalizeSelectedDocumentRanges(reference.ranges, row.text.length);
        } catch {
          rejections.push({
            candidateId: `${documentReferenceIdentity(reference)}:${reference.documentVersionId}`,
            reason: "invalid_range",
          });
          continue;
        }
        candidates.push({
          id: documentReferenceIdentity(reference),
          kind: "document",
          rank: rank++,
          purpose: reference.purpose,
          sourceId: reference.source.sourceId,
          documentId: row.documentId,
          documentVersionId: row.documentVersionId,
          ...(row.issueId === null
            ? {}
            : { publisherIssueId: row.issueId, publisherDocumentId: row.documentId }),
          contentHash: row.contentHash,
          text: row.text,
          ranges,
          label: row.title,
          publicProvenance: {
            sourceName: row.sourceName,
            ...(row.issueTitle === null ? {} : { issueTitle: row.issueTitle }),
            documentTitle: row.title,
            citationUrl: row.canonicalUrl,
            ...(row.publishedAt === null ? {} : { publishedAt: row.publishedAt.toISOString() }),
          },
          renderedTokenCount: 0,
        });
      } else {
        const row = await this.db(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const rows = yield* sql<{ readonly messageId: string; readonly content: string }>`
              select messages.id::text as "messageId", messages.content
              from chat_messages messages
              join chats on chats.id = messages.chat_id and chats.deleted_at is null
              join ai_runs runs
                on runs.id = ${load.aiRunId}
               and runs.chat_id = chats.id
               and runs.initiating_user_id = ${load.initiatingUserId}
               and runs.finished_at is null
               and runs.failed_at is null
              join client_companies companies
                on companies.id = chats.company_id
               and companies.recovery_deleted_at is null
               and companies.purged_at is null
              join client_company_memberships memberships
                on memberships.company_id = chats.company_id
               and memberships.user_id = runs.initiating_user_id
               and memberships.revoked_at is null
              join platform_users users
                on users.id = runs.initiating_user_id
               and users.recovery_deleted_at is null
               and users.purged_at is null
              where messages.id = ${reference.messageId}
                and messages.chat_id = ${load.chatId}
                and (
                  (chats.shared_at is null and chats.user_id = runs.initiating_user_id)
                  or chats.shared_at is not null
                )
            `;
            return rows[0] ?? null;
          }),
        );
        if (row !== null)
          candidates.push({
            id: chatMessageEvidenceIdentity(row.messageId),
            kind: "chat_message",
            rank: rank++,
            purpose: reference.purpose,
            messageId: row.messageId,
            text: stripHistoricalCitationTags(row.content),
            label: null,
            renderedTokenCount: 0,
          });
        else
          rejections.push({
            candidateId: `chat_message:${reference.messageId}`,
            reason: "inaccessible",
          });
      }
    }
    for (const reference of selectors.memories) {
      const requested = load.memories.find(
        (item) =>
          item.memoryId === reference.memoryId &&
          item.memoryRevisionId === reference.memoryRevisionId,
      );
      const memory =
        requested === undefined
          ? undefined
          : (
              await this.liveMemorySnapshots(load, [requested], {
                memoryId: reference.memoryId,
              })
            )[0];
      if (memory !== undefined && load.memoryMode === "private_owner")
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
    if (load.webRequested || selectors.web.length > 0) {
      await this.assertLiveAuthorization(load, { requireWebPolicy: true });
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
  ): FinalSourceRecord {
    const use: SerializedSourceUse = {
      consumerTaskId,
      ...(topicId === undefined ? {} : { topicId }),
      contextOrder,
      // measureContext replaces this pre-measurement sentinel with the exact marginal cost
      // of the source inside the real JSON-framed provider request.
      renderedTokenCount: 0,
      ranges: candidate.kind === "document" ? candidate.ranges : [],
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
            return {
              kind: "document" as const,
              // Candidate identities are already namespaced by retrieval;
              // never repair a raw or double-prefixed value at this boundary.
              sourceId: candidate.sourceId,
              documentId: candidate.documentId,
              documentVersionId: candidate.documentVersionId,
              contentHash: candidate.contentHash,
              ranges: candidate.ranges,
              ...(hasPublisherIssue
                ? {
                    publisherIssueId: candidate.publisherIssueId,
                    publisherDocumentId: candidate.publisherDocumentId,
                  }
                : {}),
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
            ? {
                documentTitle: candidate.title,
                citationUrl: candidate.url,
                ...(candidate.publishedAt === undefined
                  ? {}
                  : { publishedAt: candidate.publishedAt }),
              }
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
    reductionRan: boolean,
    topicId?: TopicId,
    selectedConversation: readonly ConversationEntry[] = load.conversation,
    ledgerCandidates: readonly AnswerCandidate[] = candidates,
    ledgerSourceMap: readonly FinalSourceRecord[] = sourceMap,
    requestedOutputTokens: number = this.config.aiMainOutputMaxTokens,
    reductionFeedback: readonly string[] = [],
    ledgerConversation: readonly ConversationEntry[] = selectedConversation,
    ledgerConversationTokenCounts?: readonly number[] | undefined,
    ledgerGaps: readonly string[] = gaps,
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
        candidateText(candidate),
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
            this.config.aiMainModel,
            requestedOutputTokens,
          )
        : structuredRequestInput(
            prompt,
            userInput(conversation, evidence),
            this.config.aiMainModel,
            requestedOutputTokens,
            "emit_topic_packet",
            "Emit a grounded topic packet.",
            z.toJSONSchema(TopicPacketSchema),
          );
    const model = resolveRuntimeModel(this.config.aiMainModel);
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
    const isInitialEvidenceLedger =
      ledgerCandidates === candidates && ledgerSourceMap === sourceMap;
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
          : "needs_reduction";
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
      sourceMap: measuredSourceMap,
      ledgerCandidates,
      ledgerSourceMap: measuredLedgerSourceMap,
      selectedConversation,
      ledgerConversation,
      ledgerConversationTokenCounts: measuredLedgerConversationTokenCounts,
      consumers: [consumer],
      gaps,
      ledgerGaps,
      reductionFeedback,
      request,
      inputTokens,
      usableInputTokens,
      reductionRan,
      ...(status === "failed" ? { failureCode: "context_mandatory_too_large" } : {}),
    };
  }

  private reductionCandidates(state: ContextState): readonly ReductionCandidate[] {
    const conversation = state.ledgerConversation ?? state.selectedConversation;
    const conversationTokenCounts = state.ledgerConversationTokenCounts ?? [];
    const conversationCandidates = conversation.map(
      (entry, index): ConversationReductionCandidate => ({
        id: conversationReductionCandidateId(entry),
        kind: "conversation_entry",
        rank: index,
        purpose: "Conversation Resolver-selected recent turn",
        label: null,
        renderedTokenCount:
          conversationTokenCounts[index] ??
          this.visibleTokenCount(JSON.stringify(entry), this.config.aiMainModel),
        entry,
        text: JSON.stringify(entry),
      }),
    );
    const evidenceCandidates = state.ledgerCandidates.map((candidate, index) => ({
      ...candidate,
      rank: conversationCandidates.length + index,
      renderedTokenCount: state.ledgerSourceMap[index]?.uses[0]?.renderedTokenCount ?? 0,
    }));
    return [...conversationCandidates, ...evidenceCandidates];
  }

  async planReduction(
    load: LoadedTurn,
    state: ContextState,
    taskId: string,
    _workflowIteration: number,
  ): Promise<ContextReductionPlan> {
    if (state.status !== "needs_reduction") {
      throw new Error("context reduction planning requires an oversized context");
    }
    const execution = await this.taskExecutionCoordinates(load.aiRunId, taskId);
    const reductionCandidates = this.reductionCandidates(state);
    // O's inspection transcript is cumulative. Keep each complete inspection
    // small enough that inspecting several candidates cannot push the next
    // provider request beyond the exact fast-input gate.
    const inspectionResponseAllowanceTokens = Math.min(this.config.aiFastOutputMaxTokens, 2_048);
    const compact = reductionCandidates.map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      label: candidate.label,
      purpose: candidate.purpose,
      rank: candidate.rank,
      renderedTokenCount: candidate.renderedTokenCount,
    }));
    const providerExposures = new Map<
      string,
      {
        readonly candidate: AnswerCandidate;
        readonly contentItemIdentity: string;
        readonly visibleTokenCount: number;
      }
    >();
    const inspectedConversation = new Map<string, ConversationEntry>();
    const providerRequestDigests = new Map<number, string>();
    let measurementRequested = false;
    let measurementResolved = false;
    let inspectionOrSearchCompleted = false;
    const raw = await this.agents.toolLoop({
      requestClass: "fast",
      model: this.config.aiFastModel,
      system: ContextReductionPrompt,
      user: JSON.stringify({
        question: state.question,
        allowance: state.usableInputTokens,
        mandatoryInputCost: this.contextMeasurementPayload(state, taskId).mandatoryInputTokens,
        overage: state.inputTokens - state.usableInputTokens,
        candidates: compact,
        priorValidationFeedback: state.reductionFeedback,
        toolBounds: {
          maximumTurns: this.config.aiRetrievalMaxTurns,
          maximumCandidates: reductionCandidates.length,
          maximumReductionIterations: this.config.aiContextReductionMaxIterations,
        },
      }),
      maximumTurns: this.config.aiRetrievalMaxTurns,
      requestedOutputTokens: this.config.aiFastOutputMaxTokens,
      reasoning: "medium",
      coordinates: { taskId, attempt: execution.attempt, agentRole: "context_reducer" },
      onBeforeRequest: async (_request, requestCoordinates) => {
        providerRequestDigests.set(
          requestCoordinates.providerRequestIndex,
          requestCoordinates.providerRequestSha256Hex,
        );
        await this.authorizeFrozenContext(load, state);
        await this.recordConversationExposures(
          load,
          taskId,
          [...inspectedConversation.values()],
          requestCoordinates,
          {
            includeCurrentUser: false,
          },
        );
        for (const {
          candidate,
          contentItemIdentity,
          visibleTokenCount,
        } of providerExposures.values()) {
          await this.db(
            insertAiSourceExposure({
              runId: load.aiRunId,
              taskId,
              loopIteration: requestCoordinates.loopIteration,
              attempt: requestCoordinates.attempt,
              providerRequestIndex: requestCoordinates.providerRequestIndex,
              providerRequestSha256Hex: requestCoordinates.providerRequestSha256Hex,
              sourceKind: candidate.kind,
              logicalSourceIdentity:
                candidate.kind === "document"
                  ? documentCandidateIdentity(candidate)
                  : candidate.kind === "chat_message"
                    ? chatMessageEvidenceIdentity(candidate.messageId)
                    : candidate.kind === "memory"
                      ? memoryEvidenceIdentity(candidate.memoryId)
                      : webEvidenceIdentity(candidate.url, candidate.quote),
              ...(candidate.kind === "document" && candidate.publisherIssueId !== undefined
                ? {
                    publisherIssueId: candidate.publisherIssueId,
                    publisherDocumentId: candidate.publisherDocumentId,
                  }
                : {}),
              contentItemIdentity,
              exposureStage: "context_candidate_inspection",
              visibleTokenCount,
            }),
          );
        }
      },
      terminalToolName: "emit_context_plan",
      validateTerminal: (value) => ContextPlanOutputSchema.parse(value).decisions,
      recoverTerminal: (_value, error) => ({
        complete: false,
        terminalRejected: true,
        message:
          error instanceof Error
            ? error.message
            : "The context plan was rejected; inspect or search candidates before measuring and terminalizing.",
        instruction:
          "Use the advertised inspection/search tools, then measure a complete plan and emit it on the reserved terminal turn.",
      }),
      enforceTerminalTurn: true,
      // O must leave a distinct terminal turn after inspection/measurement;
      // otherwise a long oversized transcript can consume the final turn with
      // another plan check and never emit its provider-authored decision.
      reserveFinalTurnForTerminal: true,
      disabledToolsForTurn: () => {
        if (measurementRequested) return ["inspect_candidate", "search_within_candidate"];
        if (!inspectionOrSearchCompleted) return ["measure_plan"];
        return [];
      },
      terminalOnlyForTurn: () => measurementResolved,
      exclusiveToolNames: ["measure_plan", "emit_context_plan"],
      onTerminal: async (_output, terminalCoordinates, completion) => {
        const providerRequestDigest = providerRequestDigests.get(
          terminalCoordinates.providerRequestIndex,
        );
        if (providerRequestDigest === undefined) {
          throw new Error("terminal reducer request lacks its exact request digest");
        }
        await this.observe(
          load,
          taskId,
          "context_reducer_terminal",
          {
            terminalUsageCoordinate: {
              taskId,
              loopIteration: terminalCoordinates.loopIteration,
              attempt: terminalCoordinates.attempt,
              providerRequestIndex: terminalCoordinates.providerRequestIndex,
            },
            modelId: this.config.aiFastModel,
            requestSha256Hex: providerRequestDigest,
            providerInputTokens: completion.usage.inputTokens + completion.usage.cachedTokens,
            totalTokens: completion.usage.totalTokens,
            stopReason: completion.stopReason,
          },
          terminalCoordinates,
        );
      },
      tools: [
        {
          definition: {
            name: "inspect_candidate",
            description: "Inspect one candidate or document range.",
            parameters: z.toJSONSchema(
              z
                .object({
                  id: z.string(),
                  range: z
                    .object({
                      charStart: z.number().int().min(0),
                      charEnd: z.number().int().positive(),
                    })
                    .strict()
                    .optional(),
                })
                .strict(),
            ),
          },
          execute: async (args) => {
            const parsed = z
              .object({
                id: z.string(),
                range: z
                  .object({
                    charStart: z.number().int().min(0),
                    charEnd: z.number().int().positive(),
                  })
                  .strict()
                  .optional(),
              })
              .strict()
              .parse(args);
            const item = reductionCandidates.find((candidate) => candidate.id === parsed.id);
            if (item === undefined)
              return {
                found: false,
                complete: true,
                truncated: false,
                cursor: null,
                scope: { kind: "unknown_candidate" },
              };
            if (parsed.range !== undefined && item.kind !== "document") {
              return {
                found: true,
                complete: true,
                rangeRejected: true,
                invalidRangeKind: true,
                message: "Only document candidates accept inspection ranges.",
              };
            }
            if (
              parsed.range !== undefined &&
              item.kind === "document" &&
              (parsed.range.charEnd <= parsed.range.charStart ||
                !item.ranges.some(
                  (range) =>
                    parsed.range !== undefined &&
                    parsed.range.charStart >= range.charStart &&
                    parsed.range.charEnd <= range.charEnd,
                ))
            ) {
              return {
                found: true,
                complete: true,
                rangeRejected: true,
                invalidRange: true,
                message:
                  "The document inspection range must be non-empty and inside a selected range.",
              };
            }
            const text =
              parsed.range === undefined
                ? reductionCandidateText(item)
                : item.kind === "document"
                  ? item.text.slice(parsed.range.charStart, parsed.range.charEnd)
                  : "";
            const contentItemIdentity =
              item.kind === "conversation_entry"
                ? undefined
                : item.kind === "document"
                  ? documentContentItemIdentity(
                      documentCandidateIdentity(item),
                      item.documentVersionId,
                      sha256Base64Url(
                        JSON.stringify(
                          parsed.range === undefined
                            ? item.ranges
                            : [
                                {
                                  charStart: parsed.range.charStart,
                                  charEnd: parsed.range.charEnd,
                                },
                              ],
                        ),
                      ),
                    )
                  : item.kind === "chat_message"
                    ? item.messageId
                    : item.kind === "memory"
                      ? item.memoryRevisionId
                      : `${item.url}:${item.quoteHash}`;
            const sourceExposure =
              contentItemIdentity === undefined || item.kind === "conversation_entry"
                ? undefined
                : providerVisibleExposureMarker({
                    sourceKind: item.kind,
                    logicalSourceIdentity:
                      item.kind === "document"
                        ? documentCandidateIdentity(item)
                        : item.kind === "chat_message"
                          ? chatMessageEvidenceIdentity(item.messageId)
                          : item.kind === "memory"
                            ? memoryEvidenceIdentity(item.memoryId)
                            : webEvidenceIdentity(item.url, item.quote),
                    contentItemIdentity,
                    stage: "context_candidate_inspection",
                    visibleTokenCount: this.visibleTokenCount(text, this.config.aiFastModel),
                  });
            const response = {
              found: true,
              complete: true,
              ...(item.kind === "conversation_entry"
                ? { conversationEntry: item.entry }
                : {
                    text,
                    ...(item.kind === "document"
                      ? {
                          documentId: item.documentId,
                          documentVersionId: item.documentVersionId,
                          source:
                            item.publisherIssueId !== undefined &&
                            item.publisherDocumentId !== undefined
                              ? {
                                  kind: "publisher" as const,
                                  sourceId: item.sourceId,
                                  issueId: item.publisherIssueId,
                                  documentId: item.publisherDocumentId,
                                }
                              : { kind: "public" as const, sourceId: item.sourceId },
                          ranges:
                            parsed.range === undefined
                              ? item.ranges
                              : [
                                  {
                                    charStart: parsed.range.charStart,
                                    charEnd: parsed.range.charEnd,
                                  },
                                ],
                        }
                      : item.kind === "memory"
                        ? { memoryId: item.memoryId, memoryRevisionId: item.memoryRevisionId }
                        : {}),
                  }),
              ...(item.kind === "conversation_entry"
                ? {
                    __briefSourceExposures: [
                      {
                        messageId: item.entry.userMessageId,
                        content: item.entry.userContent,
                      },
                      ...("assistantMessageId" in item.entry
                        ? [
                            {
                              messageId: item.entry.assistantMessageId,
                              content: item.entry.assistantContent,
                            },
                          ]
                        : []),
                    ].map(({ messageId, content }) =>
                      providerVisibleExposureMarker({
                        sourceKind: "chat_message",
                        logicalSourceIdentity: chatMessageEvidenceIdentity(messageId),
                        contentItemIdentity: messageId,
                        stage: "provider_input",
                        visibleTokenCount: this.visibleTokenCount(content, this.config.aiFastModel),
                      }),
                    ),
                  }
                : sourceExposure === undefined
                  ? {}
                  : { __briefSourceExposures: [sourceExposure] }),
            };
            if (
              requiresExplicitInspectionRange(
                this.visibleTokenCount(JSON.stringify(response), this.config.aiFastModel),
                inspectionResponseAllowanceTokens,
              )
            ) {
              if (item.kind !== "document") {
                inspectionOrSearchCompleted = true;
                return {
                  found: true,
                  complete: true,
                  itemTooLarge: true,
                  message:
                    "This whole-item candidate exceeds the inspection response bound; account for it from its compact metadata.",
                };
              }
              return {
                found: true,
                complete: false,
                narrowerRangeRequired: true,
                ranges: item.ranges,
              };
            }
            if (item.kind === "conversation_entry") {
              inspectedConversation.set(item.entry.turnId, item.entry);
              inspectionOrSearchCompleted = true;
              return response;
            }
            if (contentItemIdentity === undefined || sourceExposure === undefined) {
              throw new Error("non-conversation inspection lacks its source marker");
            }
            providerExposures.set(contentItemIdentity, {
              candidate: item,
              contentItemIdentity,
              visibleTokenCount: this.visibleTokenCount(text, this.config.aiFastModel),
            });
            inspectionOrSearchCompleted = true;
            return response;
          },
        },
        {
          definition: {
            name: "search_within_candidate",
            description: "Find literal occurrences inside one candidate.",
            parameters: z.toJSONSchema(
              z
                .object({
                  id: z.string(),
                  terms: z.string().min(1),
                  cursor: z.number().int().min(0).optional(),
                })
                .strict(),
            ),
          },
          execute: async (args) => {
            const parsed = z
              .object({
                id: z.string(),
                terms: z.string().min(1),
                cursor: z.number().int().min(0).optional(),
              })
              .strict()
              .parse(args);
            const item = reductionCandidates.find((candidate) => candidate.id === parsed.id);
            if (item === undefined)
              return {
                found: false,
                matches: [],
                matchPreviews: [],
                complete: true,
                truncated: false,
                cursor: null,
                scope: { kind: "unknown_candidate" },
              };
            const result = searchWithinCandidatePage(item, parsed.terms, parsed.cursor ?? 0, 500);
            const previewExposures =
              item.kind === "document"
                ? result.matchPreviews.map((preview) => {
                    const contentItemIdentity = documentContentItemIdentity(
                      documentCandidateIdentity(item),
                      item.documentVersionId,
                      sha256Base64Url(JSON.stringify([preview.range])),
                    );
                    const visibleTokenCount = this.visibleTokenCount(
                      preview.text,
                      this.config.aiFastModel,
                    );
                    providerExposures.set(contentItemIdentity, {
                      candidate: item,
                      contentItemIdentity,
                      visibleTokenCount,
                    });
                    return providerVisibleExposureMarker({
                      sourceKind: "document",
                      logicalSourceIdentity: documentCandidateIdentity(item),
                      contentItemIdentity,
                      stage: "context_candidate_inspection",
                      visibleTokenCount,
                    });
                  })
                : [];
            if (result.complete) inspectionOrSearchCompleted = true;
            return {
              found: true,
              ...(item.kind === "document" ? { documentVersionId: item.documentVersionId } : {}),
              ...result,
              ...(previewExposures.length === 0
                ? {}
                : { __briefSourceExposures: previewExposures }),
            };
          },
        },
        {
          definition: {
            name: "measure_plan",
            description: "Validate and measure a complete candidate plan.",
            parameters: z.toJSONSchema(ContextPlanOutputSchema),
          },
          execute: async (args) => {
            measurementRequested = true;
            try {
              const decisions = validateContextDecisions(
                ContextPlanOutputSchema.parse(args).decisions,
                reductionCandidates,
              );
              const measured = this.applyDecisions(load, state, decisions);
              measurementResolved = measured.status === "ready";
              return {
                valid: true,
                resolved: measured.status === "ready",
                inputTokens: measured.inputTokens,
                usableInputTokens: measured.usableInputTokens,
              };
            } catch (error) {
              return {
                valid: false,
                complete: true,
                feedback: error instanceof Error ? error.message : String(error),
              };
            }
          },
        },
        {
          definition: {
            name: "emit_context_plan",
            description: "Emit the complete final context plan.",
            parameters: z.toJSONSchema(ContextPlanOutputSchema),
          },
          execute: async () => ({ complete: true }),
        },
      ],
    });
    return { decisions: raw };
  }

  async measureReduction(
    load: LoadedTurn,
    state: ContextState,
    plan: ContextReductionPlan,
    taskId: string,
    _workflowIteration: number,
  ): Promise<ContextState> {
    if (state.status !== "needs_reduction") return state;
    const execution = requireCurrentTaskCoordinates(taskId);
    try {
      const decisions = validateContextDecisions(plan.decisions, this.reductionCandidates(state));
      const measured = this.applyDecisions(load, state, decisions);
      const reductionFeedback =
        measured.status === "needs_reduction"
          ? [
              `validated plan remains ${measured.inputTokens - measured.usableInputTokens} tokens over the exact allowance`,
            ]
          : [];
      const result = { ...measured, reductionFeedback };
      await this.observe(load, taskId, "context_decision", { valid: true, decisions }, execution);
      await this.observe(
        load,
        taskId,
        "context_measurement",
        this.contextMeasurementPayload(result, taskId),
        execution,
      );
      return result;
    } catch (error) {
      const feedback = error instanceof Error ? error.message : String(error);
      const result: ContextState = {
        ...state,
        status: "needs_reduction",
        reductionRan: true,
        reductionFeedback: [feedback],
      };
      await this.observe(
        load,
        taskId,
        "context_decision",
        { valid: false, decisions: plan.decisions, feedback },
        execution,
      );
      await this.observe(
        load,
        taskId,
        "context_measurement",
        this.contextMeasurementPayload(result, taskId),
        execution,
      );
      return result;
    }
  }

  private applyDecisions(
    load: LoadedTurn,
    state: ContextState,
    decisions: readonly ContextDecision[],
  ): ContextState {
    const decisionById = new Map(decisions.map((decision) => [decision.id, decision]));
    const kept: AnswerCandidate[] = [];
    const sourceMap: FinalSourceRecord[] = [];
    const gaps = [...(state.ledgerGaps ?? state.gaps)];
    const ledgerConversation = state.ledgerConversation ?? state.selectedConversation;
    const selectedConversation = ledgerConversation.filter((entry) => {
      const decision = decisionById.get(conversationReductionCandidateId(entry));
      if (decision === undefined) {
        throw new Error(`conversation entry ${entry.turnId} is unaccounted for`);
      }
      if (decision.action === "range") {
        throw new Error(`range is not valid for conversation entry ${entry.turnId}`);
      }
      if (decision.action === "omit") {
        gaps.push(decision.reason);
        return false;
      }
      return true;
    });
    for (const [index, candidate] of state.ledgerCandidates.entries()) {
      const decision = decisionById.get(candidate.id);
      const source = state.ledgerSourceMap[index];
      if (decision === undefined || source === undefined) {
        throw new Error(`evidence candidate ${candidate.id} is unaccounted for`);
      }
      if (decision.action === "omit") {
        gaps.push(decision.reason);
        continue;
      }
      if (decision.action === "range" && candidate.kind === "document") {
        const ranges = normalizeCharacterRanges(decision.ranges, candidate.text.length);
        const outsideSelection = ranges.some(
          (range) =>
            !candidate.ranges.some(
              (selected) =>
                range.charStart >= selected.charStart && range.charEnd <= selected.charEnd,
            ),
        );
        if (outsideSelection) throw new Error("reducer range expands beyond selected evidence");
        const narrowed = { ...candidate, ranges };
        kept.push(narrowed);
        if (source.locator.kind !== "document")
          throw new Error("document candidate has a non-document locator");
        const use = source.uses[0];
        if (use === undefined) throw new Error("document source lacks a serialized use");
        sourceMap.push(
          this.sourceRecord(
            narrowed,
            source.sourceKey,
            use.consumerTaskId,
            sourceMap.length,
            use.topicId,
          ),
        );
      } else {
        kept.push(candidate);
        sourceMap.push({
          ...source,
          uses: source.uses.map((use) => ({ ...use, contextOrder: sourceMap.length })),
        });
      }
    }
    const measured = this.measureContext(
      load,
      state.question,
      kept,
      sourceMap,
      gaps,
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
    );
    return measured;
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
    let resultText: string;
    try {
      const result = await this.agents.stream(
        context.request,
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
          await this.authorizeFrozenContext(load, context);
          await this.emitAnswerStart(load, context, "single", taskId, requestCoordinates);
          await this.recordContextExposures(load, context, taskId, requestCoordinates);
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
          reductionRan: context.reductionRan,
          sourcesRead: context.sourceMap.map(publicSourceRecordFromFinalSource),
          consumers: context.consumers.map((consumer) => ({ ...consumer })),
        },
        emittedByTask: taskId,
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
          reductionRan: false,
          sourcesRead: [],
          consumers: [],
        },
        emittedByTask: taskId,
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

  allocateFanout(
    load: LoadedTurn,
    plan: Extract<NormalizedExecutionPlan, { mode: "fanout" }>,
  ): FanoutAllocation {
    const model = resolveRuntimeModel(this.config.aiMainModel);
    const selectedTurnIds = new Set(plan.topics.flatMap((topic) => topic.relevantTurnIds));
    const selectedConversation = load.conversation.filter((entry) =>
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
      this.config.aiMainModel,
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
    if (packetOutputTokens < topicPacketSchemaMinimumOutputTokens(this.config.aiMainModel)) {
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
    const output = await this.agents.structured({
      requestClass: "main",
      model: this.config.aiMainModel,
      system: TopicAnswerPrompt,
      user: context.request.messages.find((message) => message.role === "user")?.content ?? "",
      outputToolName: "emit_topic_packet",
      outputToolDescription: "Emit a grounded topic packet.",
      outputSchema: z.toJSONSchema(TopicPacketSchema),
      validate: zodValidator(TopicPacketSchema),
      requestedOutputTokens: context.request.requestedOutputTokens,
      reasoning: "medium",
      coordinates: taskCoordinates(taskId, "topic_answer", execution),
      onBeforeRequest: async (request, requestCoordinates) => {
        await this.authorizeFrozenContext(load, context);
        await this.recordContextExposures(load, context, taskId, requestCoordinates);
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

  synthesisContext(
    load: LoadedTurn,
    packets: readonly TopicPacket[],
    sourceMap: readonly FinalSourceRecord[],
    topicContexts: readonly ContextState[],
    allocation: FanoutAllocation,
  ): ContextState {
    const selectedTurnIds = new Set(
      topicContexts.flatMap((context) => context.selectedConversation.map((entry) => entry.turnId)),
    );
    const selectedConversation = load.conversation.filter((entry) =>
      selectedTurnIds.has(entry.turnId),
    );
    const request = fullRequestInput(
      SynthesisPrompt,
      JSON.stringify({
        locale: load.locale,
        originalMessage: load.userMessage,
        selectedConversation,
        packets,
      }),
      this.config.aiMainModel,
      this.config.aiMainOutputMaxTokens,
    );
    const model = resolveRuntimeModel(this.config.aiMainModel);
    const inputTokens = model.countRequestTokens(request);
    const usableInputTokens = Math.min(
      this.config.aiMainInputMaxTokens,
      model.contextWindow - request.requestedOutputTokens,
    );
    const fixedRequest = fullRequestInput(
      SynthesisPrompt,
      JSON.stringify({
        locale: load.locale,
        originalMessage: load.userMessage,
        selectedConversation,
        packets: packets.map((packet) => ({
          topicId: packet.topicId,
          status: "partial" as const,
          claims: [],
          gaps: [],
        })),
      }),
      this.config.aiMainModel,
      this.config.aiMainOutputMaxTokens,
    );
    const measuredFixedInput = model.countRequestTokens(fixedRequest);
    const packetAllowanceTotal = allocation.packetOutputTokens * packets.length;
    const packetTopicIds = packets.map((packet) => packet.topicId);
    const topicContextIds = topicContexts.map((context) => context.topicId);
    const canonicalTopicIds: readonly TopicId[] = ["t1", "t2", "t3"];
    const preallocationMatches =
      packets.length >= 2 &&
      packets.length <= 3 &&
      packetTopicIds.every((topicId, index) => topicId === canonicalTopicIds[index]) &&
      packetTopicIds.every((topicId, index) => topicId === topicContextIds[index]) &&
      measuredFixedInput === allocation.fixedSynthesisInput &&
      usableInputTokens === allocation.synthesisUsableInput &&
      allocation.fixedSynthesisInput + packetAllowanceTotal <= allocation.synthesisUsableInput &&
      inputTokens <= allocation.fixedSynthesisInput + packetAllowanceTotal &&
      topicContexts.every(
        (context) =>
          context.request.requestedOutputTokens === allocation.packetOutputTokens &&
          context.request.requestedOutputTokens <= this.config.aiMainOutputMaxTokens &&
          context.request.requestedOutputTokens <= model.maximumOutputTokens,
      );
    const synthesisConsumer: PublicContextConsumer = {
      consumer: "synthesis",
      inputTokens,
      requestedOutputTokens: request.requestedOutputTokens,
      usableInputTokens,
    };
    return {
      status: preallocationMatches && inputTokens <= usableInputTokens ? "ready" : "failed",
      question: load.userMessage,
      candidates: [],
      sourceMap,
      ledgerCandidates: [],
      ledgerSourceMap: sourceMap,
      selectedConversation,
      consumers: [...topicContexts.flatMap((context) => context.consumers), synthesisConsumer],
      gaps: packets.flatMap((packet) => packet.gaps),
      reductionFeedback: [],
      request,
      inputTokens,
      usableInputTokens,
      reductionRan: false,
      ...(preallocationMatches && inputTokens <= usableInputTokens
        ? {}
        : { failureCode: "synthesis_budget_mismatch" }),
    };
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
    let resultText: string;
    try {
      const result = await this.agents.stream(
        context.request,
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
          await this.authorizeFrozenContext(load, context);
          await this.emitAnswerStart(load, context, "synthesis", taskId, requestCoordinates);
          await this.recordConversationExposures(
            load,
            taskId,
            context.selectedConversation,
            requestCoordinates,
            { modelId: this.config.aiMainModel },
          );
          await this.observe(
            load,
            taskId,
            "context_serialized",
            {
              consumerTaskId: taskId,
              sourceKeys: context.sourceMap.map((source) => source.sourceKey),
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
    return { status: "ok", mode: "synthesis", content: resultText, sourceMap: context.sourceMap };
  }

  async finalize(
    load: LoadedTurn,
    answer: AnswerLaneResult,
    memory: MemoryExtractionArtifact,
    expectedSmithersRunId: string,
  ) {
    const currentEffectiveWebPolicy = (
      enabled: boolean,
      allowedDomains: readonly string[] | null,
    ) => this.currentEffectiveWebPolicy(enabled, allowedDomains);
    return this.db(
      finalizeAiRun({
        runId: load.aiRunId,
        expectedSmithersRunId,
        coordinates: requireCurrentTaskCoordinates("finalize"),
        answer,
        memory,
        authorize: ({ chatId, initiatingUserId, sourceMap }) =>
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const rows = yield* sql<{
              readonly baseAllowed: boolean;
              readonly sourceAllowed: readonly boolean[];
              readonly webSourceCount: number;
              readonly acceptedWebPolicy: EffectiveWebPolicy | null;
              readonly webEnabled: boolean | null;
              readonly webAllowedDomains: readonly string[] | null;
            }>`
              with base as (
                select runs.chat_id, runs.initiating_user_id, runs.effective_web_policy,
                       chats.company_id
                from ai_runs runs
                join chats on chats.id = runs.chat_id and chats.deleted_at is null
                join client_companies companies
                  on companies.id = chats.company_id
                 and companies.recovery_deleted_at is null
                 and companies.purged_at is null
                join client_company_memberships memberships
                  on memberships.company_id = chats.company_id
                 and memberships.user_id = runs.initiating_user_id
                 and memberships.revoked_at is null
                join platform_users users
                  on users.id = runs.initiating_user_id
                 and users.recovery_deleted_at is null
                 and users.purged_at is null
                where runs.id = ${load.aiRunId}
                  and runs.chat_id = ${chatId}
                  and runs.initiating_user_id = ${initiatingUserId}
                  and runs.finished_at is null
                  and runs.failed_at is null
                  and (
                    (chats.shared_at is null and chats.user_id = runs.initiating_user_id)
                    or chats.shared_at is not null
                  )
              ), requested as (
                select value->'locator' as source,
                       value->'publicProvenance' as provenance,
                       (ordinality - 1)::int as source_index
                from jsonb_array_elements(${JSON.stringify(
                  sourceMap.map((source) => ({
                    locator: source.locator,
                    publicProvenance: source.publicProvenance,
                  })),
                )}::jsonb)
                     with ordinality
              ), evaluated as (
                select requested.source_index,
                       requested.source->>'kind' as kind,
                       case requested.source->>'kind'
                         when 'document' then case
                           when requested.source ? 'publisherIssueId' then exists(
                             select 1 from base
                             join chat_subscription_sources selected on selected.chat_id = base.chat_id
                             join client_subscription_accesses accesses
                               on accesses.id = selected.access_id
                              and accesses.client_company_id = selected.client_company_id
                              and accesses.subscription_id = selected.subscription_id
                              and accesses.state in ('active', 'ending', 'paused')
                             join client_employee_subscription_grants grants
                               on grants.access_id = accesses.id
                              and grants.client_company_id = accesses.client_company_id
                              and grants.user_id = base.initiating_user_id
                              and grants.revoked_at is null
                             join issue_deliveries deliveries
                               on deliveries.access_id = accesses.id
                              and deliveries.client_company_id = selected.client_company_id
                             join publisher_issues issues
                               on issues.id = deliveries.issue_id
                              and issues.subscription_id = selected.subscription_id
                              and issues.id::text = requested.source->>'publisherIssueId'
                              and ('publisher:' || selected.subscription_id::text) = requested.source->>'sourceId'
                              and issues.status = 'published'
                              and issues.restricted_at is null
                              and issues.deleted_at is null
                             join publisher_subscriptions subscriptions
                               on subscriptions.id = issues.subscription_id
             join publisher_companies publisher_company
               on publisher_company.id = subscriptions.publisher_company_id
                             join brief_documents documents
                               on documents.issue_id = issues.id
                              and documents.id::text = requested.source->>'publisherDocumentId'
                              and documents.id::text = requested.source->>'documentId'
                              and documents.deleted_at is null
                             join brief_document_versions versions
                               on versions.brief_document_id = documents.id
                              and versions.id::text = requested.source->>'documentVersionId'
                              and versions.content_hash = requested.source->>'contentHash'
                           )
                           else exists(
                             select 1 from base
                             join public_source_documents documents
                               on documents.document_id = requested.source->>'documentId'
                              and documents.document_id = requested.source->>'documentVersionId'
                              and documents.content_hash = requested.source->>'contentHash'
                              and ('public:' || documents.source_id) = requested.source->>'sourceId'
                             join client_company_public_source_settings settings
                               on settings.client_company_id = base.company_id
                              and settings.source_id = documents.source_id
                              and settings.enabled
                           )
                         end
                         when 'chat_message' then exists(
                           select 1 from base
                           join chat_messages messages
                             on messages.chat_id = base.chat_id
                            and messages.id::text = requested.source->>'messageId'
                         )
                         when 'memory' then exists(
                           select 1 from base
                           join user_memories memories
                             on memories.user_id = base.initiating_user_id
                            and memories.id::text = requested.source->>'memoryId'
                            and memories.deleted_at is null
                            and memories.provenance_only_at is null
                           join user_memory_revisions revisions
                             on revisions.memory_id = memories.id
                            and revisions.id::text = requested.source->>'memoryRevisionId'
                            and revisions.state_after->>'deleted' = 'false'
                         )
                         when 'web' then exists(select 1 from base)
                         else false
                       end as allowed
                from requested
              )
              select exists(select 1 from base) as "baseAllowed",
                     coalesce(array_agg(evaluated.allowed order by evaluated.source_index), '{}')
                       as "sourceAllowed",
                     count(*) filter (where evaluated.kind = 'web')::int as "webSourceCount",
                     (select effective_web_policy from base limit 1) as "acceptedWebPolicy",
                     (
                       select settings.web_search_enabled
                       from base
                       join client_company_ai_settings settings on settings.company_id = base.company_id
                       limit 1
                     ) as "webEnabled",
                     (
                       select settings.web_domain_allowlist
                       from base
                       join client_company_ai_settings settings on settings.company_id = base.company_id
                       limit 1
                     ) as "webAllowedDomains"
              from evaluated
            `;
            const row = rows[0];
            if (
              row?.baseAllowed !== true ||
              row.sourceAllowed.length !== sourceMap.length ||
              row.sourceAllowed.some((allowed) => !allowed)
            ) {
              return { authorized: false as const, code: "source_access_revoked" as const };
            }
            // A requested W path must retain its accepted policy snapshot and
            // recheck it at finalization even when W validly returned no
            // evidence. Checking only the final source map would let a later
            // company disablement finalize an empty requested-web answer.
            if (load.webRequested || row.webSourceCount > 0) {
              if (row.acceptedWebPolicy === null) {
                return { authorized: false as const, code: "web_policy_revoked" as const };
              }
              const current = currentEffectiveWebPolicy(
                row.webEnabled === true,
                row.webAllowedDomains ?? null,
              );
              try {
                if (!recheckWebPolicy(row.acceptedWebPolicy, current).enabled) {
                  return { authorized: false as const, code: "web_policy_revoked" as const };
                }
              } catch {
                return { authorized: false as const, code: "web_policy_revoked" as const };
              }
            }
            return { authorized: true as const };
          }),
      }),
    );
  }
}
