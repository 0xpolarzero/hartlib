import { createHash } from "node:crypto";

import {
  AiRunEvent as PublicAiRunEventSchema,
  type AiRunEvent as PublicAiRunEvent,
  type PublicContextConsumer,
} from "@brief/shared";
import { PgClient } from "@effect/sql-pg";
import { Effect, Schema } from "effect";
import { z } from "zod";

import type { WorkerConfig } from "../../config";
import {
  deriveAiChatSmithersRunId,
  handleAiChatRunJob,
  makeCanonicalOperations,
  makeDurableProviderBoundary,
} from "../../jobs/handlers";
import type { JobRecord } from "../../jobs/types";
import {
  appendAiRunEvent,
  assertFinalSourceMap,
  failAiRun,
  finalizeAiRun,
  insertAiObservation,
  insertAiSourceExposure,
  markAiRunStarted,
  parseCurrentTurnCitations,
  runAiProductState,
} from "../product-state/repository";
import { createSmithersStorage, runSmithersWorkflow, smithersRunExists } from "../smithers-interop";
import {
  canonicalizeWebUrl,
  chatMessageEvidenceIdentity,
  compareSourceKeys,
  namespacedDocumentEvidenceIdentity,
  memoryEvidenceIdentity,
  memoryExtractionSha256Hex,
  normalizeCharacterRanges,
  sha256Base64Url,
  sourceKeyForOrdinal,
  stripHistoricalCitationTags,
  webEvidenceIdentity,
  webQuoteHash,
  type DocumentEvidenceNamespace,
} from "../runtime/canonicalization";
import {
  resolveRegisteredModel,
  ZAI_CODING_PLAN_BASE_URL,
  ZAI_CODING_PLAN_PROVIDER_ENDPOINT_IDENTITY,
  ZAI_CODING_PLAN_PROVIDER_SERVICE_ID,
} from "../runtime/model-registry";
import { providerVisibleSourceExposureProofSha256Hex } from "../runtime/provider-request";
import { publicSourceRecordFromFinalSource } from "../runtime/public-source";
import { PublicProvenanceSchema } from "../runtime/source-schemas";
import type {
  EffectiveWebPolicy,
  FinalSourceRecord,
  MemoryExtractionArtifact,
  MemoryExtractionResult,
} from "../runtime/types";
import { canonicalAllowedDomains, hostMatchesAllowedDomain, recheckWebPolicy } from "../web/policy";
import {
  TINYFISH_SEARCH_ENDPOINT,
  TINYFISH_SEARCH_PROVIDER_ENDPOINT_IDENTITY,
} from "../web/tinyfish-search";
import { deleteSmithersRowsForRunWithSchemas } from "../workflow/smithers-cleanup";
import { topicRequestsWebEvidence } from "../workflow/operations";
import { CanonicalGoldenEvaluationSet } from "./fixtures/golden-set.v2";
import {
  aiEvaluationGeneralPlannerSchemas,
  buildGeneralPlannerEvaluationWorkflow,
  executeGeneralPlannerProviderTurn,
  GeneralPlannerProviderOutputSchema,
  type GeneralPlannerProviderOutput,
} from "./general-planner-workflow";
import {
  EvaluationHumanAnnotationsSchema,
  GeneralPlannerEvaluationResultsSchema,
  SpecializedEvaluationResultsSchema,
  type EvaluationHumanAnnotations,
  type EvaluationRange,
  type GeneralPlannerEvaluationResult,
  type GoldenEvaluationCase,
  type SpecializedEvaluationResult,
} from "./schema";
import {
  attestExactConversationResolverRequest,
  attestExactProductionContext,
  canonicalEvaluationUsableInputTokens,
  measureCanonicalEvaluationRequestTokens,
  measureExactProductionContextMarginals,
  type ExactProductionContextInput,
} from "./runner";

export type EvaluationTopology = "specialized" | "general_planner";

const EffectiveWebPolicySchema: z.ZodType<EffectiveWebPolicy> = z.discriminatedUnion("enabled", [
  z
    .object({
      enabled: z.literal(false),
      reason: z.enum(["deployment_unavailable", "company_disabled", "allowlist_unsupported"]),
      allowlistActive: z.boolean(),
    })
    .strict(),
  z
    .object({
      enabled: z.literal(true),
      provider: z.literal("tinyfish"),
      allowedDomains: z.array(z.string().min(1)).nullable(),
    })
    .strict()
    .superRefine((policy, context) => {
      try {
        if (
          canonicalJson(policy.allowedDomains) !==
          canonicalJson(canonicalAllowedDomains(policy.allowedDomains))
        ) {
          context.addIssue({ code: "custom", message: "web domains are not canonical" });
        }
      } catch {
        context.addIssue({ code: "custom", message: "web domains are invalid" });
      }
    }),
]);

const DurableWebSourceLocatorSchema = z
  .strictObject({
    kind: z.literal("web"),
    url: z.url(),
    title: z.string().trim().min(1),
    domain: z.string().trim().min(1),
    quote: z.string().trim().min(1),
    quoteHash: z.string().trim().min(1),
    publishedAt: z.iso.datetime().optional(),
    capturedAt: z.iso.datetime(),
  })
  .superRefine((locator, context) => {
    if (locator.quoteHash !== webQuoteHash(locator.quote)) {
      context.addIssue({ code: "custom", path: ["quoteHash"], message: "web quote hash mismatch" });
    }
  });

const sha256Hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, canonicalValue(nested)]),
  );
};

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalValue(value));
export const canonicalSha256Hex = (value: unknown): string => sha256Hex(canonicalJson(value));

export const CanonicalGoldenFixtureSha256Hex = canonicalSha256Hex(CanonicalGoldenEvaluationSet);

export const CanonicalEvaluationExecutionConfig = Object.freeze({
  providerEndpointIdentity: TINYFISH_SEARCH_PROVIDER_ENDPOINT_IDENTITY,
  aiProviderEndpointIdentity: ZAI_CODING_PLAN_PROVIDER_ENDPOINT_IDENTITY,
  aiBaseUrl: ZAI_CODING_PLAN_BASE_URL,
  aiMainModel: "glm-5-turbo",
  aiFastModel: "glm-5-turbo",
  aiMainInputMaxTokens: 100_000,
  aiMainOutputMaxTokens: 16_384,
  aiFastInputMaxTokens: 100_000,
  aiFastOutputMaxTokens: 16_384,
  aiConversationRecentTurns: 12,
  aiFanoutMaxTopics: 3,
  aiTopicResearchMaxConcurrency: 6,
  aiTopicAnswerMaxConcurrency: 3,
  aiRetrievalMaxTurns: 7,
  aiInternalMaxSearches: 8,
  aiInternalMaxInspections: 8,
  aiWebMaxSearches: 4,
  aiWebMaxFetches: 8,
  aiWebMaxDomainFilters: 8,
  aiContextReductionMaxIterations: 2,
  aiMemoryDirectMaxItems: 200,
  aiMemoryToolResultMaxItems: 50,
  aiFastTaskTimeoutMs: 300_000,
  aiAnswerTimeoutMs: 120_000,
  webResearchProvider: "tinyfish",
  webResearchEndpoint: TINYFISH_SEARCH_ENDPOINT,
} as const);

const canonicalEvaluationConfigDescriptor = (config: WorkerConfig) => ({
  providerEndpointIdentity: TINYFISH_SEARCH_PROVIDER_ENDPOINT_IDENTITY,
  aiProviderEndpointIdentity:
    config.aiBaseUrl === ZAI_CODING_PLAN_BASE_URL
      ? ZAI_CODING_PLAN_PROVIDER_ENDPOINT_IDENTITY
      : `openai_compatible_custom:${config.aiBaseUrl}`,
  aiBaseUrl: config.aiBaseUrl,
  aiMainModel: config.aiMainModel,
  aiFastModel: config.aiFastModel,
  aiMainInputMaxTokens: config.aiMainInputMaxTokens,
  aiMainOutputMaxTokens: config.aiMainOutputMaxTokens,
  aiFastInputMaxTokens: config.aiFastInputMaxTokens,
  aiFastOutputMaxTokens: config.aiFastOutputMaxTokens,
  aiConversationRecentTurns: config.aiConversationRecentTurns,
  aiFanoutMaxTopics: config.aiFanoutMaxTopics,
  aiTopicResearchMaxConcurrency: config.aiTopicResearchMaxConcurrency,
  aiTopicAnswerMaxConcurrency: config.aiTopicAnswerMaxConcurrency,
  aiRetrievalMaxTurns: config.aiRetrievalMaxTurns,
  aiInternalMaxSearches: config.aiInternalMaxSearches,
  aiInternalMaxInspections: config.aiInternalMaxInspections,
  aiWebMaxSearches: config.aiWebMaxSearches,
  aiWebMaxFetches: config.aiWebMaxFetches,
  aiWebMaxDomainFilters: config.aiWebMaxDomainFilters,
  aiContextReductionMaxIterations: config.aiContextReductionMaxIterations,
  aiMemoryDirectMaxItems: config.aiMemoryDirectMaxItems,
  aiMemoryToolResultMaxItems: config.aiMemoryToolResultMaxItems,
  aiFastTaskTimeoutMs: config.aiFastTaskTimeoutMs,
  aiAnswerTimeoutMs: config.aiAnswerTimeoutMs,
  webResearchProvider: config.webResearchProvider,
  webResearchEndpoint: TINYFISH_SEARCH_ENDPOINT,
});

export const canonicalEvaluationConfigSha256Hex = (config: WorkerConfig): string => {
  const actual = canonicalEvaluationConfigDescriptor(config);
  const expected = CanonicalEvaluationExecutionConfig;
  const mismatches = Object.keys(expected).filter(
    (key) => actual[key as keyof typeof actual] !== expected[key as keyof typeof expected],
  );
  if (config.aiE2eFakeProvider) mismatches.push("aiE2eFakeProvider");
  if (config.zaiApiKey.trim() === "") mismatches.push("zaiApiKey");
  if (config.tinyfishApiKey.trim() === "") mismatches.push("tinyfishApiKey");
  if (mismatches.length > 0) {
    throw new Error(
      `canonical evaluation execution config mismatch: ${[...new Set(mismatches)].sort().join(", ")}`,
    );
  }
  return canonicalSha256Hex(expected);
};

export const preflightCanonicalEvaluationExecution = (
  connectionString: string,
  config: WorkerConfig,
): string => {
  if (config.databaseUrl !== connectionString) {
    throw new Error(
      "evaluation connection must exactly match the worker DATABASE_URL used by Smithers",
    );
  }
  return canonicalEvaluationConfigSha256Hex(config);
};

const deterministicUuid = (identity: string): string => {
  const bytes = createHash("sha256").update(identity).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

// Public-source storage rejects sub-100-character documents. Padding is outside
// every canonical labeled half-open range, so the exact fixture evidence and
// content-item identity remain the labeled prefix rather than invented prose.
const storedDocumentText = (content: string): string =>
  content.length >= 100 ? content : content.padEnd(100, " ");

const BindingRangeSchema = z
  .object({ charStart: z.number().int().nonnegative(), charEnd: z.number().int().positive() })
  .strict();

const DurableContextDecisionSchema = z.discriminatedUnion("action", [
  z
    .object({ id: z.string().min(1), action: z.literal("keep"), reason: z.string().min(1) })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      action: z.literal("range"),
      ranges: z.array(BindingRangeSchema).min(1),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({ id: z.string().min(1), action: z.literal("omit"), reason: z.string().min(1) })
    .strict(),
]);

const RestrictedConversationBindingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("complete"),
      turnId: z.uuid(),
      userMessageId: z.uuid(),
      assistantMessageId: z.uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("failed"),
      turnId: z.uuid(),
      userMessageId: z.uuid(),
      errorCode: z.string(),
      retryable: z.boolean(),
    })
    .strict(),
]);

const RestrictedSourceBindingSchema = z
  .object({
    candidateId: z.string().min(1),
    sourceKey: z.string().regex(/^k_[A-Za-z0-9_-]{22}_[1-9][0-9]*$/u),
    kind: z.enum(["document", "chat_message", "memory", "web"]),
    purpose: z.string().trim().min(1),
    label: z.string().nullable(),
    ranges: z.array(BindingRangeSchema),
  })
  .strict();

const RestrictedTopicPacketSchema = z
  .object({
    topicId: z.enum(["t1", "t2", "t3"]),
    status: z.enum(["answered", "partial"]),
    claimCount: z.number().int().nonnegative(),
    gapCount: z.number().int().nonnegative(),
    packetSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

const RestrictedLedgerCommon = {
  modelId: z.literal("glm-5-turbo"),
  requestSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
  inputTokens: z.number().int().nonnegative(),
  usableInputTokens: z.number().int().positive(),
  requestedOutputTokens: z.number().int().positive(),
  selectedConversation: z.array(RestrictedConversationBindingSchema),
} as const;

const RestrictedContextLedgerSchema = z.discriminatedUnion("requestKind", [
  z
    .object({
      ...RestrictedLedgerCommon,
      requestKind: z.literal("direct"),
      question: z.string().min(1),
      gaps: z.array(z.string()),
      sources: z.array(RestrictedSourceBindingSchema),
    })
    .strict(),
  z
    .object({
      ...RestrictedLedgerCommon,
      requestKind: z.literal("topic"),
      topicId: z.enum(["t1", "t2", "t3"]),
      question: z.string().min(1),
      gaps: z.array(z.string()),
      sources: z.array(RestrictedSourceBindingSchema),
    })
    .strict(),
  z
    .object({
      ...RestrictedLedgerCommon,
      requestKind: z.literal("synthesis"),
      packets: z.array(RestrictedTopicPacketSchema).min(2).max(3),
    })
    .strict(),
]);

const TerminalUsageCoordinateSchema = z
  .object({
    taskId: z.string().min(1),
    loopIteration: z.number().int().nonnegative(),
    attempt: z.number().int().nonnegative(),
    providerRequestIndex: z.number().int().nonnegative(),
  })
  .strict();

const ConversationResolverRequestAttestationSchema = z
  .object({
    requestKind: z.literal("conversation_resolution"),
    modelId: z.literal("glm-5-turbo"),
    requestSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
    inputTokens: z.number().int().nonnegative(),
    usableInputTokens: z.number().int().positive(),
    requestedOutputTokens: z.literal(2048),
    currentUserMessageId: z.uuid(),
    currentDate: z.iso.date(),
    conversation: z.array(RestrictedConversationBindingSchema),
    terminalUsageCoordinate: TerminalUsageCoordinateSchema,
  })
  .strict();

const DurableConversationResolutionSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("continue"),
      retrievalQuestion: z.string().min(1),
      selectedTurnIds: z.array(z.uuid()),
    })
    .strict(),
  z.object({ mode: z.literal("clarify"), question: z.string().min(1) }).strict(),
]);

const DurableExecutionPlanSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("single"), reason: z.string().min(1) }).strict(),
  z
    .object({
      mode: z.literal("fanout"),
      reason: z.string().min(1),
      topics: z
        .array(
          z
            .object({
              topicId: z.enum(["t1", "t2", "t3"]),
              question: z.string().min(1),
              relevantTurnIds: z.array(z.uuid()),
            })
            .strict(),
        )
        .min(2)
        .max(3),
    })
    .strict(),
]);

const DocumentSourceNamespaceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("public"), sourceId: z.string().regex(/^public:[^:\s]+$/u) }).strict(),
  z
    .object({
      kind: z.literal("publisher"),
      sourceId: z.string().regex(/^publisher:[^:\s]+$/u),
      issueId: z.string().trim().min(1),
      documentId: z.string().trim().min(1),
    })
    .strict(),
]);

const DurableInternalManifestReferenceSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("document"),
        documentId: z.string().min(1),
        documentVersionId: z.string().min(1),
        source: DocumentSourceNamespaceSchema,
        ranges: z.array(BindingRangeSchema).optional(),
        purpose: z.string().trim().min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("chat_message"),
        messageId: z.uuid(),
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
        message: "publisher source document differs from reference",
      });
    }
  });

const DurableMemoryManifestReferenceSchema = z
  .object({ memoryId: z.uuid(), memoryRevisionId: z.uuid() })
  .strict();

const DurableWebManifestReferenceSchema = z
  .object({
    url: z.url(),
    title: z.string().trim().min(1),
    domain: z.string().trim().min(1),
    quote: z.string().trim().min(1),
    publishedAt: z.iso.datetime().optional(),
    capturedAt: z.iso.datetime(),
    purpose: z.string().trim().min(1),
  })
  .strict();

const DurableRetrievalManifestPayloadSchema = z.discriminatedUnion("selectorRole", [
  z
    .object({
      selectorRole: z.literal("internal"),
      references: z.array(DurableInternalManifestReferenceSchema),
    })
    .strict(),
  z
    .object({
      selectorRole: z.literal("memory"),
      references: z.array(DurableMemoryManifestReferenceSchema),
    })
    .strict(),
  z
    .object({
      selectorRole: z.literal("web"),
      references: z.array(DurableWebManifestReferenceSchema),
    })
    .strict(),
]);

const TerminalContextSerializedPayloadSchema = z
  .object({
    consumerTaskId: z.string().min(1),
    topicId: z.enum(["t1", "t2", "t3"]).optional(),
    sourceKeys: z.array(z.string().regex(/^k_[A-Za-z0-9_-]{22}_[1-9][0-9]*$/u)),
    restrictedContextLedger: RestrictedContextLedgerSchema,
    terminalUsageCoordinate: TerminalUsageCoordinateSchema,
  })
  .strict();

const EvaluationSourceBindingSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        // `sourceId` is the durable source identity used by runtime locators.
        // The fixture's human-readable id is intentionally kept separately so
        // it cannot be confused with an identity that production can authorize.
        sourceId: z.string().regex(/^(?:public|publisher):[^:\s]+$/u),
        goldenSourceId: z.string().min(1),
        kind: z.literal("document"),
        documentId: z.string(),
        documentVersionId: z.string(),
        contentHash: z.string(),
        source: DocumentSourceNamespaceSchema,
      })
      .strict(),
    z
      .object({
        sourceId: z.string(),
        kind: z.literal("chat_message"),
        messageId: z.string().uuid(),
      })
      .strict(),
    z
      .object({
        sourceId: z.string(),
        kind: z.literal("memory"),
        memoryId: z.string().uuid(),
        memoryRevisionId: z.string().uuid(),
      })
      .strict(),
    z
      .object({
        sourceId: z.string(),
        kind: z.literal("web"),
        url: z.string().url(),
        title: z.string(),
        domain: z.string(),
        capturedAt: z.string().datetime(),
      })
      .strict(),
  ])
  .superRefine((binding, context) => {
    if (binding.kind === "document" && binding.sourceId !== binding.source.sourceId) {
      context.addIssue({
        code: "custom",
        message: "document binding source id differs from its namespace",
      });
    }
    if (
      binding.kind === "document" &&
      binding.source.kind === "publisher" &&
      binding.source.documentId !== binding.documentId
    ) {
      context.addIssue({
        code: "custom",
        message: "publisher source document differs from binding",
      });
    }
  });

export const EvaluationSeedManifestSchema = z
  .object({
    artifactVersion: z.literal(2),
    goldenSetVersion: z.literal(2),
    sessionId: z.string().uuid(),
    caseId: z.string(),
    topology: z.enum(["specialized", "general_planner"]),
    userId: z.string(),
    companyId: z.string().uuid(),
    chatId: z.string().uuid(),
    userMessageId: z.string().uuid(),
    aiRunId: z.string().uuid(),
    turnBindings: z.array(
      z
        .object({
          turnId: z.string(),
          aiRunId: z.string().uuid(),
          userMessageId: z.string().uuid(),
          assistantMessageId: z.string().uuid(),
        })
        .strict(),
    ),
    sourceBindings: z.array(EvaluationSourceBindingSchema),
  })
  .strict();

export type EvaluationSeedManifest = z.infer<typeof EvaluationSeedManifestSchema>;

const documentBindingNamespace = (
  binding: Extract<EvaluationSeedManifest["sourceBindings"][number], { readonly kind: "document" }>,
): DocumentEvidenceNamespace => binding.source;

const documentBindingIdentity = (
  binding: Extract<EvaluationSeedManifest["sourceBindings"][number], { readonly kind: "document" }>,
): string =>
  namespacedDocumentEvidenceIdentity(documentBindingNamespace(binding), binding.documentId);

const documentBindingSourceId = (
  binding: Extract<EvaluationSeedManifest["sourceBindings"][number], { readonly kind: "document" }>,
): string => binding.source.sourceId;

export const evaluationBindingGoldenSourceId = (
  binding: EvaluationSeedManifest["sourceBindings"][number],
): string => (binding.kind === "document" ? binding.goldenSourceId : binding.sourceId);

const documentBindingMatchesLocator = (
  binding: Extract<EvaluationSeedManifest["sourceBindings"][number], { readonly kind: "document" }>,
  locator: unknown,
): boolean => {
  if (locator === null || typeof locator !== "object" || Array.isArray(locator)) return false;
  const value = locator as Record<string, unknown>;
  if (
    value.kind !== "document" ||
    value.sourceId !== documentBindingSourceId(binding) ||
    value.documentId !== binding.documentId ||
    value.documentVersionId !== binding.documentVersionId ||
    value.contentHash !== binding.contentHash
  ) {
    return false;
  }
  const allowedLocatorKeys = new Set([
    "kind",
    "sourceId",
    "documentId",
    "documentVersionId",
    "contentHash",
    "ranges",
    ...(binding.source.kind === "publisher" ? ["publisherIssueId", "publisherDocumentId"] : []),
  ]);
  if (Object.keys(value).some((key) => !allowedLocatorKeys.has(key))) return false;
  const issueId = value.publisherIssueId;
  const publisherDocumentId = value.publisherDocumentId;
  if (typeof issueId === "string" || typeof publisherDocumentId === "string") {
    return (
      binding.source.kind === "publisher" &&
      issueId === binding.source.issueId &&
      publisherDocumentId === binding.source.documentId
    );
  }
  return binding.source.kind === "public";
};

export const EvaluationCaseAnnotationSchema = z
  .object({
    caseId: z.string(),
    topology: z.enum(["specialized", "general_planner"]),
    claims: EvaluationHumanAnnotationsSchema.shape.claims,
    reportedGapIds: EvaluationHumanAnnotationsSchema.shape.reportedGapIds,
  })
  .strict();

export const EvaluationAnnotationFileSchema = z
  .object({
    artifactVersion: z.literal(2),
    goldenSetVersion: z.literal(2),
    sessionId: z.string().uuid(),
    annotations: z.array(EvaluationCaseAnnotationSchema),
  })
  .strict();

export type EvaluationAnnotationFile = z.infer<typeof EvaluationAnnotationFileSchema>;

interface CaseRunRow {
  readonly sessionId: string;
  readonly caseId: string;
  readonly topology: EvaluationTopology;
  readonly aiRunId: string;
  readonly seedManifest: unknown;
  readonly status: "seeded" | "running" | "succeeded" | "failed";
  readonly executionOutput: unknown | null;
  readonly executionOutputSha256Hex: string | null;
  readonly runEvidenceSha256Hex: string | null;
  readonly failureReason: string | null;
  readonly evaluationConfigSha256Hex: string | null;
  readonly providerEndpointIdentity: string | null;
}

interface EvaluationSessionRow {
  readonly id: string;
  readonly status: "preparing" | "running" | "awaiting_annotations" | "complete" | "failed";
  readonly failureReason: string | null;
  readonly evaluationConfigSha256Hex: string | null;
  readonly providerEndpointIdentity: string | null;
}

const DurableRunSnapshotSchema = z
  .object({
    id: z.uuid(),
    chatId: z.uuid(),
    userMessageId: z.uuid(),
    initiatingUserId: z.string().min(1),
    locale: z.enum(["fr-FR", "en-US"]),
    market: z.enum(["FR", "US"]),
    webSearchEnabled: z.boolean(),
    effectiveWebPolicy: EffectiveWebPolicySchema,
    smithersRunId: z.string().min(1),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    failedAt: z.null(),
    assistantMessageId: z.uuid(),
    citationNonceHex: z.string().regex(/^[0-9a-f]{32}$/u),
    nextEventSeq: z.number().int().positive(),
    errorCode: z.null(),
    retryable: z.null(),
  })
  .strict();

const DurableMessageSchema = z
  .object({
    id: z.uuid(),
    chatId: z.uuid(),
    author: z.enum(["user", "assistant"]),
    content: z.string(),
    assistantAiRunId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();

const JsonObjectSchema = z.record(z.string(), z.unknown());
const PositiveBigintTextSchema = z.string().regex(/^[1-9][0-9]*$/u);

const decodePublicAiRunEvent = Schema.decodeUnknownSync(PublicAiRunEventSchema, {
  onExcessProperty: "error",
});

const DurableEventPayloadSchema = z.unknown().transform((value, context): PublicAiRunEvent => {
  try {
    return decodePublicAiRunEvent(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "invalid public AI run event",
    });
    return z.NEVER;
  }
});

const DurableMemoryStateSchema = z
  .object({
    kind: z.enum(["profile", "preference", "instruction", "fact", "episode"]),
    content: z.string(),
    deleted: z.boolean(),
  })
  .strict();

const DurableRunEvidenceSchema = z
  .object({
    run: DurableRunSnapshotSchema,
    chat: z
      .object({
        id: z.uuid(),
        userId: z.string().min(1),
        companyId: z.uuid(),
        memoryMode: z.enum(["private_owner", "disabled"]),
        sharedAt: z.iso.datetime().nullable(),
        deletedAt: z.iso.datetime().nullable(),
        deletedByUserId: z.string().nullable(),
        purgeAfter: z.iso.datetime().nullable(),
        legalHold: z.boolean(),
        createdAt: z.iso.datetime(),
        updatedAt: z.iso.datetime(),
      })
      .strict(),
    currentUserMessage: DurableMessageSchema,
    assistantMessage: DurableMessageSchema,
    conversationInventory: z.array(
      z
        .object({
          turnId: z.uuid(),
          chatId: z.uuid(),
          initiatingUserId: z.string().min(1),
          smithersRunId: z.string().min(1),
          locale: z.string().min(1),
          market: z.string().min(1),
          webSearchEnabled: z.boolean(),
          effectiveWebPolicy: EffectiveWebPolicySchema,
          createdAt: z.iso.datetime(),
          startedAt: z.iso.datetime(),
          finishedAt: z.iso.datetime().nullable(),
          failedAt: z.iso.datetime().nullable(),
          userMessageId: z.uuid(),
          userChatId: z.uuid(),
          userAuthor: z.enum(["user", "assistant"]),
          userContent: z.string(),
          userAssistantAiRunId: z.uuid().nullable(),
          userCreatedAt: z.iso.datetime(),
          assistantMessageId: z.uuid().nullable(),
          assistantChatId: z.uuid().nullable(),
          assistantAuthor: z.enum(["user", "assistant"]).nullable(),
          assistantContent: z.string().nullable(),
          assistantAiRunId: z.uuid().nullable(),
          assistantCreatedAt: z.iso.datetime().nullable(),
          errorCode: z.string().nullable(),
          retryable: z.boolean().nullable(),
        })
        .strict(),
    ),
    usage: z.array(
      z
        .object({
          id: PositiveBigintTextSchema,
          taskId: z.string().min(1),
          loopIteration: z.number().int().nonnegative(),
          attempt: z.number().int().nonnegative(),
          providerRequestIndex: z.number().int().nonnegative(),
          agentRole: z.string().min(1),
          modelId: z.string().min(1),
          providerServiceId: z.string().min(1),
          inputTokens: z.number().int().nonnegative(),
          outputTokens: z.number().int().nonnegative(),
          cachedTokens: z.number().int().nonnegative(),
          reasoningTokens: z.number().int().nonnegative(),
          totalTokens: z.number().int().nonnegative(),
          stopReason: z.string().min(1),
          createdAt: z.iso.datetime(),
        })
        .strict(),
    ),
    externalToolUsage: z.array(
      z
        .object({
          id: PositiveBigintTextSchema,
          taskId: z.string().min(1),
          loopIteration: z.number().int().nonnegative(),
          attempt: z.number().int().nonnegative(),
          toolRequestIndex: z.number().int().nonnegative(),
          providerServiceId: z.string().min(1),
          operation: z.enum(["web_search", "web_fetch"]),
          status: z.enum(["ok", "empty", "failed"]),
          resultCount: z.number().int().nonnegative(),
          responseBytes: z.number().int().nonnegative(),
          billedUnits: z.string().nullable(),
          durationMs: z.number().int().nonnegative(),
          createdAt: z.iso.datetime(),
        })
        .strict(),
    ),
    observations: z.array(
      z
        .object({
          id: z.uuid(),
          chatId: z.uuid(),
          kind: z.string().min(1),
          emittingTask: z.string().min(1),
          loopIteration: z.number().int().nonnegative(),
          attempt: z.number().int().nonnegative(),
          observationKey: z.string().min(1),
          payload: JsonObjectSchema,
          createdAt: z.iso.datetime(),
        })
        .strict(),
    ),
    sourceExposures: z.array(
      z
        .object({
          id: PositiveBigintTextSchema,
          taskId: z.string().min(1),
          loopIteration: z.number().int().nonnegative(),
          attempt: z.number().int().nonnegative(),
          providerRequestIndex: z.number().int().nonnegative(),
          sourceKind: z.enum(["document", "chat_message", "memory", "web"]),
          logicalSourceIdentity: z.string().min(1),
          publisherIssueId: z.string().nullable(),
          publisherDocumentId: z.string().nullable(),
          contentItemIdentity: z.string().min(1),
          exposureStage: z.string().min(1),
          visibleTokenCount: z.number().int().nonnegative(),
          documentSourceId: z
            .string()
            .regex(/^(?:public|publisher):[^:\s]+$/u)
            .nullable(),
          documentId: z.string().min(1).nullable(),
          documentVersionId: z.string().min(1).nullable(),
          documentContentHash: z
            .string()
            .regex(/^[0-9a-f]{64}$/u)
            .nullable(),
          documentRanges: z.array(BindingRangeSchema).nullable(),
          createdAt: z.iso.datetime(),
        })
        .strict(),
    ),
    events: z.array(
      z
        .object({
          id: PositiveBigintTextSchema,
          seq: z.number().int().positive(),
          emissionKey: z.string().min(1),
          emittedByTask: z.string().min(1).nullable(),
          event: DurableEventPayloadSchema,
          createdAt: z.iso.datetime(),
        })
        .strict(),
    ),
    sources: z.array(
      z
        .object({
          sourceKey: z.string().regex(/^k_[A-Za-z0-9_-]{22}_[1-9][0-9]*$/u),
          kind: z.enum(["document", "chat_message", "memory", "web"]),
          locator: JsonObjectSchema,
          documentVersionId: z.string().nullable(),
          publisherDocumentVersionId: z.uuid().nullable(),
          messageId: z.uuid().nullable(),
          memoryRevisionId: z.uuid().nullable(),
          displayLabel: z.string().nullable(),
          publicProvenance: PublicProvenanceSchema,
          createdAt: z.iso.datetime(),
        })
        .strict(),
    ),
    sourceUses: z.array(
      z
        .object({
          sourceKey: z.string().regex(/^k_[A-Za-z0-9_-]{22}_[1-9][0-9]*$/u),
          consumerTaskId: z.string().min(1),
          topicId: z.enum(["t1", "t2", "t3"]).nullable(),
          renderedTokenCount: z.number().int().nonnegative(),
          contextOrder: z.number().int().nonnegative(),
          ranges: z.array(BindingRangeSchema),
          createdAt: z.iso.datetime(),
        })
        .strict(),
    ),
    memoryWrites: z.array(
      z
        .object({
          memoryId: z.uuid(),
          revisionId: z.uuid(),
          previousRevisionId: z.uuid().nullable(),
          action: z.enum(["create", "update", "delete", "revert"]),
          stateBefore: DurableMemoryStateSchema.nullable(),
          stateAfter: DurableMemoryStateSchema,
          createdAt: z.iso.datetime(),
        })
        .strict(),
    ),
    memoryHeads: z.array(
      z
        .object({
          memoryId: z.uuid(),
          userId: z.string().min(1),
          kind: z.enum(["profile", "preference", "instruction", "fact", "episode"]).nullable(),
          content: z.string().nullable(),
          headRevisionId: z.uuid().nullable(),
          sourceMessageId: z.uuid().nullable(),
          deletedAt: z.iso.datetime().nullable(),
          provenanceOnlyAt: z.iso.datetime().nullable(),
          createdAt: z.iso.datetime(),
          updatedAt: z.iso.datetime(),
        })
        .strict(),
    ),
  })
  .strict();

type DurableRunEvidence = z.infer<typeof DurableRunEvidenceSchema>;

const db = <A, E>(connectionString: string, effect: Effect.Effect<A, E, PgClient.PgClient>) =>
  runAiProductState(connectionString, effect);

/**
 * Serializes every paid seed/execute/resume path for one evaluation session.
 * The PostgreSQL session lock is held on one reserved connection for the full
 * callback and is released both normally and when the caller fails or is
 * interrupted. A crashed process releases it with the database connection.
 */
export const withEvaluationSessionExecutionLease = <Value>(
  connectionString: string,
  sessionId: string,
  execute: () => Promise<Value>,
): Promise<Value> => {
  const lockIdentity = `brief:ai-evaluation:v2:${sessionId}`;
  return db(
    connectionString,
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const connection = yield* sql.reserve;
        yield* Effect.acquireRelease(
          connection
            .executeRaw("select pg_advisory_lock(hashtextextended($1::text, 0))", [lockIdentity])
            .pipe(Effect.asVoid),
          () =>
            connection
              .executeRaw("select pg_advisory_unlock(hashtextextended($1::text, 0))", [
                lockIdentity,
              ])
              .pipe(Effect.asVoid, Effect.orDie),
        );
        return yield* Effect.tryPromise({
          try: execute,
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        });
      }),
    ),
  );
};

const fixtureFor = (caseId: string): GoldenEvaluationCase => {
  const fixture = CanonicalGoldenEvaluationSet.cases.find((candidate) => candidate.id === caseId);
  if (fixture === undefined) throw new Error(`unknown canonical golden case ${caseId}`);
  return fixture;
};

const manifestIdentity = (
  sessionId: string,
  fixture: GoldenEvaluationCase,
  topology: EvaluationTopology,
): string => `ai-evaluation:v2:${sessionId}:${topology}:${fixture.id}`;

const buildSeedManifest = (
  sessionId: string,
  fixture: GoldenEvaluationCase,
  topology: EvaluationTopology,
): EvaluationSeedManifest => {
  const identity = manifestIdentity(sessionId, fixture, topology);
  const evaluationSourceId = `eval-v2-${sha256Hex(`${identity}:source`).slice(0, 32)}`;
  const turnBindings = fixture.conversation.map((turn, index) => ({
    turnId: turn.turnId,
    aiRunId: deterministicUuid(`${identity}:turn:${index}:run`),
    userMessageId: deterministicUuid(`${identity}:turn:${index}:user`),
    assistantMessageId: deterministicUuid(`${identity}:turn:${index}:assistant`),
  }));
  const byTurn = new Map(turnBindings.map((binding) => [binding.turnId, binding] as const));
  const sourceBindings = fixture.evidence.map((source, index) => {
    if (source.kind === "document") {
      const documentId = `eval-v2-${sha256Hex(`${identity}:document:${index}`).slice(0, 40)}`;
      return {
        sourceId: `public:${evaluationSourceId}`,
        goldenSourceId: source.sourceId,
        kind: "document" as const,
        documentId,
        documentVersionId: documentId,
        contentHash: sha256Hex(storedDocumentText(source.content)),
        source: { kind: "public" as const, sourceId: `public:${evaluationSourceId}` },
      };
    }
    if (source.kind === "chat_message") {
      const turnId = source.sourceId.startsWith("chat:") ? source.sourceId.slice(5) : "";
      const turn = byTurn.get(turnId);
      if (turn === undefined) throw new Error(`${fixture.id} chat evidence has no bound turn`);
      return {
        sourceId: source.sourceId,
        kind: "chat_message" as const,
        messageId: turn.assistantMessageId,
      };
    }
    if (source.kind === "memory") {
      return {
        sourceId: source.sourceId,
        kind: "memory" as const,
        memoryId: deterministicUuid(`${identity}:memory:${index}`),
        memoryRevisionId: deterministicUuid(`${identity}:memory:${index}:revision`),
      };
    }
    if (source.url === undefined || source.title === undefined || source.domain === undefined) {
      throw new Error(`${fixture.id}/${source.sourceId} lacks canonical web source metadata`);
    }
    return {
      sourceId: source.sourceId,
      kind: "web" as const,
      url: source.url,
      title: source.title,
      domain: source.domain,
      // This seed value is only an immutable manifest placeholder. The real
      // Brief fetch captures its own timestamp, which is checked at capture.
      capturedAt: "1970-01-01T00:00:00.000Z",
    };
  });
  return EvaluationSeedManifestSchema.parse({
    artifactVersion: 2,
    goldenSetVersion: 2,
    sessionId,
    caseId: fixture.id,
    topology,
    userId: `eval-v2-${sha256Hex(`${identity}:user`).slice(0, 32)}`,
    companyId: deterministicUuid(`${identity}:company`),
    chatId: deterministicUuid(`${identity}:chat`),
    userMessageId: deterministicUuid(`${identity}:current:user`),
    aiRunId: deterministicUuid(`${identity}:current:run`),
    turnBindings,
    sourceBindings,
  });
};

const seedOneCase = (
  connectionString: string,
  sessionId: string,
  fixture: GoldenEvaluationCase,
  topology: EvaluationTopology,
): Promise<EvaluationSeedManifest> => {
  const manifest = buildSeedManifest(sessionId, fixture, topology);
  const sourceById = new Map(fixture.evidence.map((source) => [source.sourceId, source] as const));
  const sourceId = `eval-v2-${sha256Hex(`${manifestIdentity(sessionId, fixture, topology)}:source`).slice(0, 32)}`;
  return db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const existing = yield* sql<{ readonly seedManifest: unknown }>`
        select seed_manifest as "seedManifest"
        from ai_evaluation_case_runs
        where session_id = ${sessionId} and case_id = ${fixture.id} and topology = ${topology}
      `;
      if (existing[0] !== undefined) {
        const parsed = EvaluationSeedManifestSchema.parse(existing[0].seedManifest);
        if (canonicalJson(parsed) !== canonicalJson(manifest)) {
          return yield* Effect.fail(new Error(`seed manifest drift for ${topology}/${fixture.id}`));
        }
        return parsed;
      }

      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            insert into platform_users (id, primary_email, display_name, clerk_user_id)
            values (
              ${manifest.userId},
              ${`${manifest.userId}@evaluation.invalid`},
              ${`Evaluation ${fixture.id} ${topology}`},
              ${`clerk_${manifest.userId}`}
            ) on conflict (id) do nothing
          `;
          yield* sql`
            insert into client_companies (id, name)
            values (${manifest.companyId}, ${`Evaluation ${fixture.id} ${topology}`})
            on conflict (id) do nothing
          `;
          yield* sql`
            insert into client_company_memberships (company_id, user_id, role)
            values (${manifest.companyId}, ${manifest.userId}, 'admin')
            on conflict (company_id, user_id) do nothing
          `;
          const evaluationWebAllowlist =
            fixture.webRequested && fixture.webPolicyEnabled
              ? canonicalAllowedDomains(
                  fixture.evidence.flatMap((source) =>
                    source.kind === "web" ? [source.domain] : [],
                  ),
                )
              : null;
          yield* sql`
            insert into client_company_ai_settings (
              company_id, web_search_enabled, web_domain_allowlist
            )
            values (${manifest.companyId}, ${fixture.webPolicyEnabled}, ${evaluationWebAllowlist})
            on conflict (company_id) do update
              set web_search_enabled = excluded.web_search_enabled,
                  web_domain_allowlist = excluded.web_domain_allowlist,
                  updated_at = now()
          `;
          yield* sql`
            insert into chats (id, user_id, company_id, memory_mode)
            values (${manifest.chatId}, ${manifest.userId}, ${manifest.companyId}, 'private_owner')
            on conflict (id) do nothing
          `;

          for (const [index, turn] of fixture.conversation.entries()) {
            const binding = manifest.turnBindings[index]!;
            const createdAt = new Date(Date.UTC(2026, 6, 1, 0, index * 2));
            yield* sql`
              insert into chat_messages (id, chat_id, author, content, created_at)
              values (${binding.userMessageId}, ${manifest.chatId}, 'user', ${turn.userContent}, ${createdAt})
              on conflict (id) do nothing
            `;
            yield* sql`
              insert into ai_runs (
                id, chat_id, initiating_user_id, user_message_id, smithers_run_id,
                locale, market, created_at, web_search_enabled, effective_web_policy
              ) values (
                ${binding.aiRunId}, ${manifest.chatId}, ${manifest.userId},
                ${binding.userMessageId}, ${deriveAiChatSmithersRunId(binding.aiRunId)},
                ${fixture.locale}, ${fixture.market}, ${createdAt}, false,
                ${JSON.stringify({ enabled: false, reason: "company_disabled", allowlistActive: false })}::jsonb
              ) on conflict (id) do nothing
            `;
            yield* sql`
              insert into chat_messages (
                id, chat_id, author, content, assistant_ai_run_id, created_at
              ) values (
                ${binding.assistantMessageId}, ${manifest.chatId}, 'assistant',
                ${turn.assistantContent}, ${binding.aiRunId}, ${new Date(createdAt.getTime() + 1_000)}
              ) on conflict (id) do nothing
            `;
            yield* sql`
              update ai_runs
              set assistant_message_id = ${binding.assistantMessageId},
                  started_at = ${createdAt}, finished_at = ${new Date(createdAt.getTime() + 1_000)}
              where id = ${binding.aiRunId} and finished_at is null
            `;
          }

          if (manifest.sourceBindings.some((binding) => binding.kind === "document")) {
            yield* sql`
              insert into public_sources (
                source_id, display_name, publisher_name, description, ingestion_method,
                discovery_url, average_chars_per_item, country, language
              ) values (
                ${sourceId}, ${`Evaluation source ${fixture.id}`}, 'Brief canonical evaluation',
                'Canonical golden evaluation evidence', 'manual',
                ${`https://evaluation.invalid/discovery/${sourceId}`}, 1000,
                ${fixture.market}, ${fixture.locale}
              ) on conflict (source_id) do nothing
            `;
            yield* sql`
              insert into client_company_public_source_settings (
                client_company_id, source_id, enabled, updated_by_user_id
              ) values (${manifest.companyId}, ${sourceId}, true, ${manifest.userId})
              on conflict (client_company_id, source_id) do update set enabled = true
            `;
          }

          for (const [index, binding] of manifest.sourceBindings.entries()) {
            const source = sourceById.get(evaluationBindingGoldenSourceId(binding))!;
            if (binding.kind === "document") {
              const artifactId = deterministicUuid(
                `${manifestIdentity(sessionId, fixture, topology)}:artifact:${index}`,
              );
              const canonicalUrl = `https://evaluation.invalid/documents/${binding.documentId}`;
              const storedText = storedDocumentText(source.content);
              yield* sql`
                insert into public_source_raw_artifacts (
                  id, source_id, canonical_url, fetched_at, media_type, body, body_hash
                ) values (
                  ${artifactId}, ${sourceId}, ${canonicalUrl}, '2026-07-01T00:00:00.000Z',
                  'text/html', ${storedText}, ${sha256Hex(storedText)}
                ) on conflict (id) do nothing
              `;
              yield* sql`
                insert into public_source_documents (
                  document_id, source_id, raw_artifact_id, canonical_url, title, text,
                  language, published_at, discovered_at, fetched_at, document_type,
                  content_hash, text_char_count
                ) values (
                  ${binding.documentId}, ${sourceId}, ${artifactId}, ${canonicalUrl},
                  ${`Canonical evidence ${evaluationBindingGoldenSourceId(binding)}`}, ${storedText}, ${fixture.locale},
                  '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
                  '2026-07-01T00:00:00.000Z', 'article', ${binding.contentHash},
                  ${storedText.length}
                ) on conflict (document_id) do nothing
              `;
            } else if (binding.kind === "memory") {
              yield* sql`
                insert into user_memories (
                  id, user_id, kind, content, head_revision_id, created_at, updated_at
                ) values (
                  ${binding.memoryId}, ${manifest.userId}, ${"preference"}, ${source.content},
                  ${binding.memoryRevisionId}, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
                ) on conflict (id) do nothing
              `;
              yield* sql`
                insert into user_memory_revisions (
                  id, memory_id, action, state_before, state_after, created_at
                ) values (
                  ${binding.memoryRevisionId}, ${binding.memoryId}, 'create', null,
                  ${JSON.stringify({ kind: "preference", content: source.content, deleted: false })}::jsonb,
                  '2026-07-01T00:00:00.000Z'
                ) on conflict (id) do nothing
              `;
            }
          }

          yield* sql`
            insert into chat_messages (id, chat_id, author, content, created_at)
            values (
              ${manifest.userMessageId}, ${manifest.chatId}, 'user', ${fixture.currentMessage},
              '2026-07-10T10:00:00.000Z'
            ) on conflict (id) do nothing
          `;
          const effectiveWebPolicy =
            fixture.webRequested && fixture.webPolicyEnabled
              ? { enabled: true, provider: "tinyfish", allowedDomains: evaluationWebAllowlist }
              : { enabled: false, reason: "company_disabled", allowlistActive: false };
          yield* sql`
            insert into ai_runs (
              id, chat_id, user_message_id, locale, market, created_at,
              web_search_enabled, effective_web_policy
            ) values (
              ${manifest.aiRunId}, ${manifest.chatId}, ${manifest.userMessageId},
              ${fixture.locale}, ${fixture.market}, '2026-07-10T10:00:00.000Z',
              ${fixture.webRequested}, ${JSON.stringify(effectiveWebPolicy)}::jsonb
            ) on conflict (id) do nothing
          `;
          yield* sql`
            insert into ai_evaluation_case_runs (
              session_id, case_id, topology, ai_run_id, seed_manifest
            ) values (
              ${sessionId}, ${fixture.id}, ${topology}, ${manifest.aiRunId},
              ${JSON.stringify(manifest)}::jsonb
            )
          `;
        }),
      );
      return manifest;
    }),
  );
};

export const createEvaluationSession = async (
  connectionString: string,
  requestedSessionId?: string,
): Promise<string> =>
  db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const sessionId = requestedSessionId ?? crypto.randomUUID();
      yield* sql`
        insert into ai_evaluation_sessions (
          id, artifact_version, golden_set_version, fixture_sha256_hex
        ) values (${sessionId}, 2, 2, ${CanonicalGoldenFixtureSha256Hex})
        on conflict (id) do nothing
      `;
      const rows = yield* sql<{
        readonly fixtureSha256Hex: string;
        readonly artifactVersion: number;
        readonly goldenSetVersion: number;
      }>`
        select fixture_sha256_hex as "fixtureSha256Hex",
               artifact_version as "artifactVersion", golden_set_version as "goldenSetVersion"
        from ai_evaluation_sessions where id = ${sessionId}
      `;
      const row = rows[0];
      if (
        row?.fixtureSha256Hex !== CanonicalGoldenFixtureSha256Hex ||
        row.artifactVersion !== 2 ||
        row.goldenSetVersion !== 2
      ) {
        return yield* Effect.fail(new Error("evaluation session fixture/version mismatch"));
      }
      return sessionId;
    }),
  );

const seedEvaluationSessionWithLeaseHeld = async (
  connectionString: string,
  sessionId: string,
): Promise<readonly EvaluationSeedManifest[]> => {
  const manifests: EvaluationSeedManifest[] = [];
  for (const fixture of CanonicalGoldenEvaluationSet.cases) {
    for (const topology of ["specialized", "general_planner"] as const) {
      manifests.push(await seedOneCase(connectionString, sessionId, fixture, topology));
    }
  }
  return manifests;
};

export const seedEvaluationSession = (
  connectionString: string,
  sessionId: string,
): Promise<readonly EvaluationSeedManifest[]> =>
  withEvaluationSessionExecutionLease(connectionString, sessionId, () =>
    seedEvaluationSessionWithLeaseHeld(connectionString, sessionId),
  );

const loadCaseRuns = (
  connectionString: string,
  sessionId: string,
): Promise<readonly CaseRunRow[]> =>
  db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      return yield* sql<CaseRunRow>`
        select case_runs.session_id::text as "sessionId", case_runs.case_id as "caseId",
               case_runs.topology, case_runs.ai_run_id::text as "aiRunId",
               case_runs.seed_manifest as "seedManifest", case_runs.status,
               case_runs.execution_output as "executionOutput",
               case_runs.execution_output_sha256_hex as "executionOutputSha256Hex",
               case_runs.run_evidence_sha256_hex as "runEvidenceSha256Hex",
               case_runs.failure_reason as "failureReason",
               sessions.execution_config_sha256_hex as "evaluationConfigSha256Hex",
               sessions.provider_endpoint_identity as "providerEndpointIdentity"
        from ai_evaluation_case_runs case_runs
        join ai_evaluation_sessions sessions on sessions.id = case_runs.session_id
        where case_runs.session_id = ${sessionId}
        order by case_runs.case_id, case_runs.topology
      `;
    }),
  );

const loadEvaluationSession = (
  connectionString: string,
  sessionId: string,
): Promise<EvaluationSessionRow> =>
  db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<EvaluationSessionRow>`
        select id::text, status, failure_reason as "failureReason",
               execution_config_sha256_hex as "evaluationConfigSha256Hex",
               provider_endpoint_identity as "providerEndpointIdentity"
        from ai_evaluation_sessions where id = ${sessionId}
      `;
      const row = rows[0];
      if (row === undefined) return yield* Effect.fail(new Error("evaluation session not found"));
      return row;
    }),
  );

export interface EvaluationCaseIdentity {
  readonly sessionId: string;
  readonly caseId: string;
  readonly topology: EvaluationTopology;
  readonly aiRunId: string;
}

export const ensureEvaluationCaseRunning = (
  connectionString: string,
  row: EvaluationCaseIdentity,
): Promise<void> =>
  db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const transitioned = yield* sql<{ readonly id: string }>`
        update ai_evaluation_case_runs
        set status = 'running', started_at = coalesce(started_at, now()), updated_at = now()
        where session_id = ${row.sessionId} and case_id = ${row.caseId}
          and topology = ${row.topology} and status = 'seeded'
        returning ai_run_id::text as id
      `;
      if (transitioned.length !== 1) {
        const existing = yield* sql<{
          readonly aiRunId: string;
          readonly status: string;
        }>`
          select ai_run_id::text as "aiRunId", status
          from ai_evaluation_case_runs
          where session_id = ${row.sessionId} and case_id = ${row.caseId}
            and topology = ${row.topology}
        `;
        if (
          existing.length !== 1 ||
          existing[0]?.aiRunId !== row.aiRunId ||
          existing[0]?.status !== "running"
        ) {
          return yield* Effect.fail(
            new Error(`${row.topology}/${row.caseId} did not enter or remain in running`),
          );
        }
      }
    }),
  ).then(() => undefined);

const executeSpecialized = async (
  connectionString: string,
  config: WorkerConfig,
  row: CaseRunRow,
): Promise<void> => {
  if (config.aiE2eFakeProvider)
    throw new Error("evaluation execution forbids AI_E2E_FAKE_PROVIDER");
  if (config.zaiApiKey.trim() === "") throw new Error("evaluation execution requires ZAI_API_KEY");
  await ensureEvaluationCaseRunning(connectionString, row);
  const job = {
    id: deterministicUuid(`evaluation-job:${row.aiRunId}`),
    kind: "ai_chat_run",
    payload: { aiRunId: row.aiRunId },
  } as JobRecord;
  await Effect.runPromise(
    handleAiChatRunJob(job, {
      operationsFactory: (loadedConfig, aiRunId, loadedConnectionString) => {
        if (aiRunId !== row.aiRunId || loadedConnectionString !== connectionString) {
          throw new Error("evaluation specialized execution database/run mismatch");
        }
        return makeCanonicalOperations(loadedConnectionString, aiRunId, loadedConfig);
      },
    }),
  );
};

const baselineSourceMap = async (
  connectionString: string,
  fixture: GoldenEvaluationCase,
  manifest: EvaluationSeedManifest,
  output: GeneralPlannerProviderOutput,
): Promise<readonly FinalSourceRecord[]> => {
  const nonceHex = await db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{ readonly nonceHex: string }>`
        select encode(citation_nonce, 'hex') as "nonceHex" from ai_runs where id = ${manifest.aiRunId}
      `;
      const nonce = rows[0]?.nonceHex;
      if (nonce === undefined) return yield* Effect.fail(new Error("baseline run not found"));
      return nonce;
    }),
  );
  const bindings = new Map(
    manifest.sourceBindings.map((binding) => [evaluationBindingGoldenSourceId(binding), binding]),
  );
  const evidence = new Map(fixture.evidence.map((source) => [source.sourceId, source]));
  const storedDocuments = await loadStoredEvaluationDocuments(connectionString, manifest);
  const model = resolveRegisteredModel("glm-5-turbo");
  return output.selectedSources.map((selection, index) => {
    const binding = bindings.get(selection.sourceId)!;
    const source = evidence.get(selection.sourceId)!;
    const sourceKey = sourceKeyForOrdinal(Buffer.from(nonceHex, "hex"), index + 1);
    const selectedText =
      source.kind === "document"
        ? (selection.ranges.length > 0
            ? selection.ranges
            : [{ charStart: 0, charEnd: storedDocuments.get(selection.sourceId)!.text.length }]
          )
            .map((range) =>
              storedDocuments.get(selection.sourceId)!.text.slice(range.charStart, range.charEnd),
            )
            .join("\n…\n")
        : source.content;
    const use = {
      consumerTaskId: "single-answer",
      contextOrder: index,
      renderedTokenCount: model.countTextTokens(selectedText),
      ranges: selection.ranges,
    };
    if (binding.kind === "document") {
      return {
        sourceKey,
        locator: {
          kind: "document" as const,
          sourceId: documentBindingSourceId(binding),
          documentId: binding.documentId,
          documentVersionId: binding.documentVersionId,
          contentHash: binding.contentHash,
          ranges: selection.ranges,
          ...(binding.source.kind === "publisher"
            ? {
                publisherIssueId: binding.source.issueId,
                publisherDocumentId: binding.source.documentId,
              }
            : {}),
        },
        label: evaluationBindingGoldenSourceId(binding),
        publicProvenance: {
          sourceName: "Brief canonical evaluation",
          documentTitle: `Canonical evidence ${evaluationBindingGoldenSourceId(binding)}`,
          citationUrl: `https://evaluation.invalid/documents/${binding.documentId}`,
        },
        uses: [use],
      };
    }
    if (binding.kind === "chat_message") {
      return {
        sourceKey,
        locator: { kind: "chat_message" as const, messageId: binding.messageId },
        label: evaluationBindingGoldenSourceId(binding),
        publicProvenance: {},
        uses: [use],
      };
    }
    if (binding.kind === "memory") {
      return {
        sourceKey,
        locator: {
          kind: "memory" as const,
          memoryId: binding.memoryId,
          memoryRevisionId: binding.memoryRevisionId,
        },
        label: evaluationBindingGoldenSourceId(binding),
        publicProvenance: {},
        uses: [use],
      };
    }
    return {
      sourceKey,
      locator: {
        kind: "web" as const,
        url: binding.url,
        title: binding.title,
        domain: binding.domain,
        quote: source.content,
        quoteHash: webQuoteHash(source.content),
        publishedAt: "2026-03-14T00:00:00.000Z",
        capturedAt: binding.capturedAt,
      },
      label: evaluationBindingGoldenSourceId(binding),
      publicProvenance: {
        documentTitle: binding.title,
        citationUrl: binding.url,
        publishedAt: "2026-03-14T00:00:00.000Z",
      },
      uses: [use],
    };
  });
};

const persistBaselineOutput = async (
  connectionString: string,
  row: CaseRunRow,
  output: GeneralPlannerProviderOutput,
): Promise<void> => {
  GeneralPlannerProviderOutputSchema.parse(output);
  const smithersRunId = `ai-evaluation-general-planner:${row.sessionId}:${row.caseId}`;
  const fixture = fixtureFor(row.caseId);
  const manifest = EvaluationSeedManifestSchema.parse(row.seedManifest);
  const sourceMap = await baselineSourceMap(connectionString, fixture, manifest, output);
  const sourceKeys = new Map(
    output.selectedSources.map((selection, index) => [
      selection.sourceId,
      sourceMap[index]!.sourceKey,
    ]),
  );
  const citations = output.citationSourceIds.map((sourceId) => sourceKeys.get(sourceId)!);
  const content =
    citations.length === 0
      ? output.answerContent
      : `${output.answerContent} [[cite:${citations.join(",")}]]`;
  const turnMap = new Map(
    manifest.turnBindings.map((binding) => [binding.turnId, binding.aiRunId]),
  );
  const translatedResolution =
    output.resolution.mode === "clarify"
      ? output.resolution
      : {
          ...output.resolution,
          selectedTurnIds: output.resolution.selectedTurnIds.map((turnId) => turnMap.get(turnId)!),
        };
  const memoryBinding = new Map(
    manifest.sourceBindings.flatMap((binding) =>
      binding.kind === "memory"
        ? [[evaluationBindingGoldenSourceId(binding), binding] as const]
        : [],
    ),
  );
  const memory: MemoryExtractionResult = {
    proposals: output.memoryProposals.map((proposal) => {
      if (proposal.targetMemorySourceId === null) {
        return { kind: proposal.kind, content: proposal.content };
      }
      const target = memoryBinding.get(proposal.targetMemorySourceId)!;
      return {
        kind: proposal.kind,
        content: proposal.content,
        targetMemoryId: target.memoryId,
        expectedHeadRevisionId: target.memoryRevisionId,
      };
    }),
    discardedCount: 0,
  };
  const producer = await db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{
        readonly loopIteration: number;
        readonly attempt: number;
        readonly providerRequestIndex: number;
      }>`
        select loop_iteration as "loopIteration", attempt,
               provider_request_index as "providerRequestIndex"
        from ai_run_usage
        where run_id = ${row.aiRunId}
          and task_id = 'evaluation-general-planner'
          and stop_reason in ('stop', 'length', 'toolUse')
        order by loop_iteration desc, attempt desc, provider_request_index desc
        limit 1
      `;
      if (rows.length !== 1) {
        return yield* Effect.fail(new Error("baseline output lacks terminal provider coordinates"));
      }
      return rows[0]!;
    }),
  );
  const memoryObservationKey = `evaluation-general-planner:${producer.loopIteration}:${producer.attempt}:memory_extraction_result:result`;
  const memoryArtifact: MemoryExtractionArtifact = {
    result: memory,
    producer: {
      taskId: "evaluation-general-planner",
      loopIteration: producer.loopIteration,
      attempt: producer.attempt,
      observationKey: memoryObservationKey,
      extractionSha256Hex: memoryExtractionSha256Hex(memory),
    },
  };
  await db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* insertAiObservation({
        runId: row.aiRunId,
        chatId: manifest.chatId,
        emittingTask: "evaluation-general-planner",
        loopIteration: producer.loopIteration,
        attempt: producer.attempt,
        observationKey: "evaluation-general-planner:conversation-resolution",
        kind: "conversation_resolution",
        payload: translatedResolution,
      });
      yield* insertAiObservation({
        runId: row.aiRunId,
        chatId: manifest.chatId,
        emittingTask: "evaluation-general-planner",
        loopIteration: producer.loopIteration,
        attempt: producer.attempt,
        observationKey: memoryObservationKey,
        kind: "memory_extraction_result",
        payload: {
          proposalCount: memory.proposals.length,
          discardedCount: memory.discardedCount,
          extractionSha256Hex: memoryArtifact.producer.extractionSha256Hex,
        },
      });
      if (output.resolution.mode === "continue") {
        yield* insertAiObservation({
          runId: row.aiRunId,
          chatId: manifest.chatId,
          emittingTask: "evaluation-general-planner",
          loopIteration: producer.loopIteration,
          attempt: producer.attempt,
          observationKey: "evaluation-general-planner:execution-plan",
          kind: "execution_plan",
          payload: { mode: "single", reason: "offline evaluation-only general planner" },
        });
        yield* insertAiObservation({
          runId: row.aiRunId,
          chatId: manifest.chatId,
          emittingTask: "evaluation-general-planner",
          loopIteration: producer.loopIteration,
          attempt: producer.attempt,
          observationKey: "evaluation-general-planner:retrieval-manifest",
          kind: "retrieval_manifest",
          payload: { selectorRole: "general_planner", references: output.selectedSources },
        });
        yield* insertAiObservation({
          runId: row.aiRunId,
          chatId: manifest.chatId,
          emittingTask: "evaluation-general-planner",
          loopIteration: producer.loopIteration,
          attempt: producer.attempt,
          observationKey: "evaluation-general-planner:context-measurement",
          kind: "context_measurement",
          payload: {
            consumerTaskId: "evaluation-general-planner",
            totalInputTokens: measureCanonicalEvaluationRequestTokens(
              fixture,
              output.selectedSources.map((selection) => ({ ...selection })),
            ),
            status: "ready",
            reductionRan: false,
          },
        });
        yield* insertAiObservation({
          runId: row.aiRunId,
          chatId: manifest.chatId,
          emittingTask: "evaluation-general-planner",
          loopIteration: producer.loopIteration,
          attempt: producer.attempt,
          observationKey: "evaluation-general-planner:context-serialized",
          kind: "context_serialized",
          payload: {
            consumerTaskId: "evaluation-general-planner",
            sourceKeys: sourceMap.map((source) => source.sourceKey),
          },
        });
      }
      yield* appendAiRunEvent({
        runId: row.aiRunId,
        emissionKey: "context_ready",
        event: {
          type: "context_ready",
          mode: output.resolution.mode === "clarify" ? "clarification" : "single",
          reductionRan: false,
          sourcesRead:
            output.resolution.mode === "clarify"
              ? []
              : sourceMap.map(publicSourceRecordFromFinalSource),
          consumers:
            output.resolution.mode === "clarify"
              ? []
              : [
                  {
                    consumer: "direct",
                    inputTokens: measureCanonicalEvaluationRequestTokens(
                      fixture,
                      output.selectedSources.map((selection) => ({ ...selection })),
                    ),
                    requestedOutputTokens: CanonicalEvaluationExecutionConfig.aiMainOutputMaxTokens,
                    usableInputTokens: canonicalEvaluationUsableInputTokens(),
                  },
                ],
        },
        emittedByTask: "evaluation-general-planner",
      });
      yield* appendAiRunEvent({
        runId: row.aiRunId,
        emissionKey: `answer_started:evaluation-general-planner:${producer.attempt}`,
        event: {
          type: "answer_started",
          mode: output.resolution.mode === "clarify" ? "clarification" : "single",
          attempt: producer.attempt,
        },
        emittedByTask: "evaluation-general-planner",
      });
      yield* appendAiRunEvent({
        runId: row.aiRunId,
        emissionKey: `text_delta:evaluation-general-planner:${producer.attempt}:0`,
        event: { type: "text_delta", delta: content },
        emittedByTask: "evaluation-general-planner",
      });
      yield* finalizeAiRun({
        runId: row.aiRunId,
        expectedSmithersRunId: smithersRunId,
        answer: {
          status: "ok",
          mode: output.resolution.mode === "clarify" ? "clarification" : "single",
          content,
          sourceMap,
        },
        memory: memoryArtifact,
        coordinates: {
          loopIteration: producer.loopIteration,
          attempt: producer.attempt,
        },
        authorize: ({ sourceMap: requested }) =>
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const rows = yield* sql<{ readonly valid: boolean }>`
              select not exists (
                select 1 from jsonb_array_elements(${JSON.stringify(requested.map((source) => source.locator))}::jsonb) locator
                where case locator->>'kind'
                  when 'document' then not exists (
                    select 1 from public_source_documents documents
                    join client_company_public_source_settings settings
                      on settings.source_id = documents.source_id and settings.enabled
                    where documents.document_id = locator->>'documentId'
                      and documents.content_hash = locator->>'contentHash'
                      and settings.client_company_id = ${manifest.companyId}
                  )
                  when 'chat_message' then not exists (
                    select 1 from chat_messages
                    where id::text = locator->>'messageId' and chat_id = ${manifest.chatId}
                  )
                  when 'memory' then not exists (
                    select 1 from user_memories
                    where id::text = locator->>'memoryId'
                      and head_revision_id::text = locator->>'memoryRevisionId'
                      and user_id = ${manifest.userId}
                  )
                  when 'web' then not (${fixture.webRequested} and ${fixture.webPolicyEnabled})
                  else true
                end
              ) as valid
            `;
            return rows[0]?.valid === true
              ? { authorized: true as const }
              : { authorized: false as const, code: "source_access_revoked" as const };
          }),
      });
      const serialized = canonicalJson(output);
      const digest = sha256Hex(serialized);
      const bound = yield* sql<{ readonly id: string }>`
        update ai_evaluation_case_runs
        set execution_output = ${serialized}::jsonb,
            execution_output_sha256_hex = ${digest}, updated_at = now()
        where session_id = ${row.sessionId} and case_id = ${row.caseId}
          and topology = 'general_planner' and status = 'running'
          and execution_output is null
        returning ai_run_id::text as id
      `;
      if (bound.length !== 1) {
        const existing = yield* sql<{
          readonly digest: string | null;
          readonly output: unknown;
        }>`
          select execution_output_sha256_hex as digest, execution_output as output
          from ai_evaluation_case_runs
          where session_id = ${row.sessionId} and case_id = ${row.caseId}
            and topology = 'general_planner'
        `;
        if (
          existing.length !== 1 ||
          existing[0]?.digest !== digest ||
          canonicalJson(existing[0]?.output) !== serialized
        ) {
          return yield* Effect.fail(
            new Error(`general_planner/${row.caseId} did not bind or retain its exact output`),
          );
        }
      }
    }),
  );
};

const loadBaselineSmithersOutput = (
  connectionString: string,
  smithersRunId: string,
): Promise<GeneralPlannerProviderOutput> =>
  db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{ readonly value: string }>`
        select value from ai_evaluation_general_planner
        where run_id = ${smithersRunId}
          and node_id = 'evaluation-general-planner'
        order by iteration desc limit 1
      `;
      const value = rows[0]?.value;
      if (value === undefined)
        return yield* Effect.fail(new Error("baseline Smithers output missing"));
      return GeneralPlannerProviderOutputSchema.parse(JSON.parse(value) as unknown);
    }),
  );

const deleteBaselineSmithersRowsIfFenced = (
  connectionString: string,
  aiRunId: string,
  smithersRunId: string,
): Promise<void> =>
  db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly smithersRunId: string | null }>`
            select smithers_run_id as "smithersRunId"
            from ai_runs where id = ${aiRunId}
            for update
          `;
          if (rows.length !== 1 || rows[0]?.smithersRunId !== smithersRunId) {
            return yield* Effect.fail(
              new Error("baseline cleanup lost its exact Smithers ownership fence"),
            );
          }
          yield* deleteSmithersRowsForRunWithSchemas(
            aiEvaluationGeneralPlannerSchemas,
            smithersRunId,
          );
        }),
      );
    }),
  ).then(() => undefined);

const terminalizeFailedBaselineRun = async (
  connectionString: string,
  aiRunId: string,
  smithersRunId: string,
): Promise<void> => {
  await db(connectionString, failAiRun(aiRunId, "finalization_failed", undefined, smithersRunId));
  await deleteBaselineSmithersRowsIfFenced(connectionString, aiRunId, smithersRunId);
};

export interface GeneralPlannerEvaluationExecutionOptions {
  /** Explicitly test-only: preserves deterministic_test provider identity. */
  readonly testOnlyAllowDeterministicProvider?: boolean;
}

const executeBaseline = async (
  connectionString: string,
  config: WorkerConfig,
  row: CaseRunRow,
  options: GeneralPlannerEvaluationExecutionOptions = {},
): Promise<void> => {
  const deterministicTestProviderAllowed =
    options.testOnlyAllowDeterministicProvider === true &&
    config.nodeEnv === "test" &&
    config.aiE2eFakeProvider;
  if (config.aiE2eFakeProvider && !deterministicTestProviderAllowed)
    throw new Error("evaluation execution forbids AI_E2E_FAKE_PROVIDER");
  if (config.zaiApiKey.trim() === "") throw new Error("evaluation execution requires ZAI_API_KEY");
  const manifest = EvaluationSeedManifestSchema.parse(row.seedManifest);
  const storedDocuments = await loadStoredEvaluationDocuments(connectionString, manifest);
  await ensureEvaluationCaseRunning(connectionString, row);
  const smithersRunId = `ai-evaluation-general-planner:${row.sessionId}:${row.caseId}`;
  await db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const bound = yield* sql<{ readonly id: string }>`
        update ai_runs
        set smithers_run_id = coalesce(smithers_run_id, ${smithersRunId})
        where id = ${row.aiRunId}
          and (smithers_run_id is null or smithers_run_id = ${smithersRunId})
        returning id::text
      `;
      if (bound.length !== 1) {
        return yield* Effect.fail(new Error("baseline run has a different Smithers identity"));
      }
    }),
  );
  await db(connectionString, markAiRunStarted(row.aiRunId));
  try {
    const storage = await createSmithersStorage(aiEvaluationGeneralPlannerSchemas, {
      connectionString,
    });
    let output: GeneralPlannerProviderOutput;
    try {
      const workflow = buildGeneralPlannerEvaluationWorkflow(
        storage,
        row.caseId,
        async (caseId, aiRunId) => {
          if (caseId !== row.caseId || aiRunId !== row.aiRunId) {
            throw new Error("baseline Smithers input does not match its bound evaluation run");
          }
          return executeGeneralPlannerProviderTurn(
            makeDurableProviderBoundary(connectionString, aiRunId, config),
            fixtureFor(caseId),
            {
              onProviderRequest: async (exposures, _request, coordinates) => {
                const fixture = fixtureFor(caseId);
                await Promise.all(
                  exposures.map(async (exposure) => {
                    const source = fixture.evidence.find(
                      (candidate) => candidate.sourceId === exposure.sourceId,
                    );
                    const binding = EvaluationSeedManifestSchema.parse(
                      row.seedManifest,
                    ).sourceBindings.find(
                      (candidate) =>
                        evaluationBindingGoldenSourceId(candidate) === exposure.sourceId,
                    );
                    if (source === undefined) {
                      throw new Error("baseline exposed an unknown golden source");
                    }
                    if (binding === undefined) {
                      throw new Error("baseline exposed an unbound golden source");
                    }
                    if (source.kind === "document" && binding.kind !== "document") {
                      throw new Error(
                        `baseline document source ${source.sourceId} resolved to ${binding.kind} binding`,
                      );
                    }
                    const visibleText =
                      source.kind === "document"
                        ? storedDocuments
                            .get(exposure.sourceId)!
                            .text.slice(exposure.charStart, exposure.charEnd)
                        : source.content.slice(exposure.charStart, exposure.charEnd);
                    const logicalSourceIdentity =
                      binding.kind === "document"
                        ? documentBindingIdentity(binding)
                        : source.sourceId;
                    await db(
                      connectionString,
                      insertAiSourceExposure({
                        runId: aiRunId,
                        taskId: coordinates.taskId,
                        loopIteration: coordinates.loopIteration,
                        attempt: coordinates.attempt,
                        providerRequestIndex: coordinates.providerRequestIndex,
                        providerRequestSha256Hex: coordinates.providerRequestSha256Hex,
                        sourceKind: source.kind,
                        logicalSourceIdentity,
                        contentItemIdentity: `${logicalSourceIdentity}:${exposure.charStart}:${exposure.charEnd}:${sha256Hex(visibleText)}`,
                        exposureStage: `evaluation_general_planner_${exposure.stage}`,
                        visibleTokenCount:
                          resolveRegisteredModel("glm-5-turbo").countTextTokens(visibleText),
                        ...(source.kind === "document" && binding.kind === "document"
                          ? {
                              documentReconstruction: {
                                sourceId: binding.sourceId,
                                documentId: binding.documentId,
                                documentVersionId: binding.documentVersionId,
                                contentHash: binding.contentHash,
                                ranges: [
                                  {
                                    charStart: exposure.charStart,
                                    charEnd: exposure.charEnd,
                                  },
                                ],
                              },
                            }
                          : {}),
                      }),
                    );
                  }),
                );
              },
            },
          );
        },
      );
      const resume = await smithersRunExists(storage, smithersRunId);
      const result = await runSmithersWorkflow(workflow, {
        runId: smithersRunId,
        input: { aiRunId: row.aiRunId },
        resume,
        logDir: null,
        maxConcurrency: 1,
      });
      if (result.status !== "finished") {
        throw new Error(`general-planner Smithers run ended ${result.status}`);
      }
      output = await loadBaselineSmithersOutput(connectionString, smithersRunId);
    } finally {
      await storage.close();
    }
    await persistBaselineOutput(connectionString, row, output);
  } catch (error) {
    await terminalizeFailedBaselineRun(connectionString, row.aiRunId, smithersRunId);
    throw error;
  }
  await deleteBaselineSmithersRowsIfFenced(connectionString, row.aiRunId, smithersRunId);
};

/** Runs one bound baseline case; used by the focused Postgres execution regression. */
export const executeGeneralPlannerEvaluationCase = async (
  connectionString: string,
  sessionId: string,
  caseId: string,
  config: WorkerConfig,
  options: GeneralPlannerEvaluationExecutionOptions = {},
): Promise<void> =>
  withEvaluationSessionExecutionLease(connectionString, sessionId, async () => {
    const row = (await loadCaseRuns(connectionString, sessionId)).find(
      (candidate) => candidate.caseId === caseId && candidate.topology === "general_planner",
    );
    if (row === undefined) throw new Error(`unknown general-planner evaluation case ${caseId}`);
    try {
      await executeBaseline(connectionString, config, row, options);
    } catch (error) {
      await failCaseRun(connectionString, row, error);
      throw error;
    }
  });

/**
 * Repairs a legacy failed evaluation whose case/session terminal transition
 * committed before its already-started baseline ai_run was terminalized.
 */
export const recoverFailedGeneralPlannerEvaluationRun = async (
  connectionString: string,
  sessionId: string,
  caseId: string,
): Promise<void> =>
  withEvaluationSessionExecutionLease(connectionString, sessionId, async () => {
    const session = await loadEvaluationSession(connectionString, sessionId);
    const row = (await loadCaseRuns(connectionString, sessionId)).find(
      (candidate) => candidate.caseId === caseId && candidate.topology === "general_planner",
    );
    if (session.status !== "failed" || row?.status !== "failed") {
      throw new Error("general-planner recovery requires immutable failed session and case rows");
    }
    await terminalizeFailedBaselineRun(
      connectionString,
      row.aiRunId,
      `ai-evaluation-general-planner:${row.sessionId}:${row.caseId}`,
    );
    await failCaseRun(connectionString, row, new Error("legacy baseline child was nonterminal"));
  });

const loadDurableRunEvidence = (
  connectionString: string,
  aiRunId: string,
): Promise<DurableRunEvidence> =>
  db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const runs = yield* sql<{
        readonly id: string;
        readonly chatId: string;
        readonly userMessageId: string;
        readonly initiatingUserId: string;
        readonly locale: string;
        readonly market: string;
        readonly webSearchEnabled: boolean;
        readonly effectiveWebPolicy: unknown;
        readonly smithersRunId: string | null;
        readonly createdAt: Date;
        readonly startedAt: Date | null;
        readonly finishedAt: Date | null;
        readonly failedAt: Date | null;
        readonly assistantMessageId: string | null;
        readonly citationNonceHex: string;
        readonly nextEventSeq: number;
        readonly errorCode: string | null;
        readonly retryable: boolean | null;
        readonly chatUserId: string;
        readonly chatCompanyId: string;
        readonly chatMemoryMode: string;
        readonly chatSharedAt: Date | null;
        readonly chatDeletedAt: Date | null;
        readonly chatDeletedByUserId: string | null;
        readonly chatPurgeAfter: Date | null;
        readonly chatLegalHold: boolean;
        readonly chatCreatedAt: Date;
        readonly chatUpdatedAt: Date;
        readonly currentMessageId: string | null;
        readonly currentMessageChatId: string | null;
        readonly currentMessageAuthor: string | null;
        readonly currentMessageContent: string | null;
        readonly currentMessageAssistantAiRunId: string | null;
        readonly currentMessageCreatedAt: Date | null;
        readonly assistantRowId: string | null;
        readonly assistantChatId: string | null;
        readonly assistantAuthor: string | null;
        readonly assistantContent: string | null;
        readonly assistantAiRunId: string | null;
        readonly assistantCreatedAt: Date | null;
      }>`
        select runs.id::text, runs.chat_id::text as "chatId",
               runs.user_message_id::text as "userMessageId",
               runs.initiating_user_id as "initiatingUserId", runs.locale, runs.market,
               runs.web_search_enabled as "webSearchEnabled",
               runs.effective_web_policy as "effectiveWebPolicy",
               runs.smithers_run_id as "smithersRunId",
               runs.created_at as "createdAt", runs.started_at as "startedAt",
               runs.finished_at as "finishedAt", runs.failed_at as "failedAt",
               runs.assistant_message_id::text as "assistantMessageId",
               encode(runs.citation_nonce, 'hex') as "citationNonceHex",
               runs.next_event_seq as "nextEventSeq", runs.error_code as "errorCode",
               runs.retryable,
               chats.user_id as "chatUserId", chats.company_id::text as "chatCompanyId",
               chats.memory_mode as "chatMemoryMode", chats.shared_at as "chatSharedAt",
               chats.deleted_at as "chatDeletedAt",
               chats.deleted_by_user_id as "chatDeletedByUserId",
               chats.purge_after as "chatPurgeAfter", chats.legal_hold as "chatLegalHold",
               chats.created_at as "chatCreatedAt", chats.updated_at as "chatUpdatedAt",
               current_messages.id::text as "currentMessageId",
               current_messages.chat_id::text as "currentMessageChatId",
               current_messages.author as "currentMessageAuthor",
               current_messages.content as "currentMessageContent",
               current_messages.assistant_ai_run_id::text as "currentMessageAssistantAiRunId",
               current_messages.created_at as "currentMessageCreatedAt",
               assistants.id::text as "assistantRowId",
               assistants.chat_id::text as "assistantChatId",
               assistants.author as "assistantAuthor", assistants.content as "assistantContent",
               assistants.assistant_ai_run_id::text as "assistantAiRunId",
               assistants.created_at as "assistantCreatedAt"
        from ai_runs runs
        join chats on chats.id = runs.chat_id
        left join chat_messages current_messages on current_messages.id = runs.user_message_id
        left join chat_messages assistants on assistants.id = runs.assistant_message_id
        where runs.id = ${aiRunId}
      `;
      const run = runs[0];
      if (
        run === undefined ||
        run.startedAt === null ||
        run.finishedAt === null ||
        run.assistantMessageId === null ||
        run.smithersRunId === null ||
        run.currentMessageId === null ||
        run.currentMessageChatId === null ||
        run.currentMessageAuthor === null ||
        run.currentMessageContent === null ||
        run.currentMessageCreatedAt === null ||
        run.assistantRowId === null ||
        run.assistantChatId === null ||
        run.assistantAuthor === null ||
        run.assistantContent === null ||
        run.assistantCreatedAt === null
      ) {
        return yield* Effect.fail(
          new Error(`evaluation run ${aiRunId} is not successfully terminal`),
        );
      }
      const conversationInventory = yield* sql<{
        readonly turnId: string;
        readonly chatId: string;
        readonly initiatingUserId: string;
        readonly smithersRunId: string | null;
        readonly locale: string;
        readonly market: string;
        readonly webSearchEnabled: boolean;
        readonly effectiveWebPolicy: unknown;
        readonly createdAt: Date;
        readonly startedAt: Date | null;
        readonly finishedAt: Date | null;
        readonly failedAt: Date | null;
        readonly userMessageId: string;
        readonly userChatId: string;
        readonly userAuthor: string;
        readonly userContent: string;
        readonly userAssistantAiRunId: string | null;
        readonly userCreatedAt: Date;
        readonly assistantMessageId: string | null;
        readonly assistantChatId: string | null;
        readonly assistantAuthor: string | null;
        readonly assistantContent: string | null;
        readonly assistantAiRunId: string | null;
        readonly assistantCreatedAt: Date | null;
        readonly errorCode: string | null;
        readonly retryable: boolean | null;
      }>`
        select prior.id::text as "turnId", prior.chat_id::text as "chatId",
               prior.initiating_user_id as "initiatingUserId",
               prior.smithers_run_id as "smithersRunId", prior.locale, prior.market,
               prior.web_search_enabled as "webSearchEnabled",
               prior.effective_web_policy as "effectiveWebPolicy",
               prior.created_at as "createdAt", prior.started_at as "startedAt",
               prior.finished_at as "finishedAt",
               prior.failed_at as "failedAt", prior.user_message_id::text as "userMessageId",
               users.chat_id::text as "userChatId", users.author as "userAuthor",
               users.content as "userContent",
               users.assistant_ai_run_id::text as "userAssistantAiRunId",
               users.created_at as "userCreatedAt",
               assistants.id::text as "assistantMessageId",
               assistants.chat_id::text as "assistantChatId",
               assistants.author as "assistantAuthor", assistants.content as "assistantContent",
               assistants.assistant_ai_run_id::text as "assistantAiRunId",
               assistants.created_at as "assistantCreatedAt",
               prior.error_code as "errorCode", prior.retryable
        from ai_runs current_run
        join ai_runs prior
          on prior.chat_id = current_run.chat_id
         and prior.id <> current_run.id
         and (prior.finished_at is not null or prior.failed_at is not null)
        join chat_messages users on users.id = prior.user_message_id
        left join chat_messages assistants on assistants.id = prior.assistant_message_id
        where current_run.id = ${aiRunId}
        order by prior.created_at, prior.id
      `;
      const usage = yield* sql<
        Omit<DurableRunEvidence["usage"][number], "createdAt"> & { readonly createdAt: Date }
      >`
        select id::text, task_id as "taskId", loop_iteration as "loopIteration", attempt,
               provider_request_index as "providerRequestIndex", agent_role as "agentRole",
               model_id as "modelId", provider_service_id as "providerServiceId",
               input_tokens as "inputTokens", output_tokens as "outputTokens",
               cached_tokens as "cachedTokens", reasoning_tokens as "reasoningTokens",
               total_tokens as "totalTokens", stop_reason as "stopReason",
               created_at as "createdAt"
        from ai_run_usage where run_id = ${aiRunId}
        order by created_at, id
      `;
      const externalToolUsage = yield* sql<
        Omit<DurableRunEvidence["externalToolUsage"][number], "createdAt"> & {
          readonly createdAt: Date;
        }
      >`
        select id::text, task_id as "taskId", loop_iteration as "loopIteration", attempt,
               tool_request_index as "toolRequestIndex",
               provider_service_id as "providerServiceId", operation, status,
               result_count as "resultCount", response_bytes::float8 as "responseBytes",
               billed_units::text as "billedUnits", duration_ms::float8 as "durationMs",
               created_at as "createdAt"
        from ai_external_tool_usage where run_id = ${aiRunId}
        order by task_id, loop_iteration, attempt, tool_request_index, id
      `;
      const observations = yield* sql<{
        readonly id: string;
        readonly chatId: string;
        readonly kind: string;
        readonly emittingTask: string;
        readonly loopIteration: number;
        readonly attempt: number;
        readonly observationKey: string;
        readonly payload: Record<string, unknown>;
        readonly createdAt: Date;
      }>`
        select id::text, chat_id::text as "chatId", kind,
               emitting_task as "emittingTask", loop_iteration as "loopIteration", attempt,
               observation_key as "observationKey", payload, created_at as "createdAt"
        from ai_observations where run_id = ${aiRunId}
        order by observation_key
      `;
      const sourceExposures = yield* sql<{
        readonly id: string;
        readonly taskId: string;
        readonly loopIteration: number;
        readonly attempt: number;
        readonly providerRequestIndex: number;
        readonly sourceKind: string;
        readonly logicalSourceIdentity: string;
        readonly publisherIssueId: string | null;
        readonly publisherDocumentId: string | null;
        readonly contentItemIdentity: string;
        readonly exposureStage: string;
        readonly visibleTokenCount: number;
        readonly documentSourceId: string | null;
        readonly documentId: string | null;
        readonly documentVersionId: string | null;
        readonly documentContentHash: string | null;
        readonly documentRanges: EvaluationRange[] | null;
        readonly createdAt: Date;
      }>`
        select id::text, task_id as "taskId", loop_iteration as "loopIteration", attempt,
               provider_request_index as "providerRequestIndex", source_kind as "sourceKind",
               logical_source_identity as "logicalSourceIdentity",
               publisher_issue_id as "publisherIssueId",
               publisher_document_id as "publisherDocumentId",
               content_item_identity as "contentItemIdentity",
               exposure_stage as "exposureStage", visible_token_count as "visibleTokenCount",
               document_source_id as "documentSourceId",
               document_id as "documentId",
               document_version_id as "documentVersionId",
               document_content_hash as "documentContentHash",
               document_ranges as "documentRanges",
               created_at as "createdAt"
        from ai_source_exposures where run_id = ${aiRunId}
        order by task_id, loop_iteration, attempt, provider_request_index,
                 exposure_stage, content_item_identity, id
      `;
      const events = yield* sql<{
        readonly id: string;
        readonly seq: number;
        readonly emissionKey: string;
        readonly emittedByTask: string | null;
        readonly event: Record<string, unknown>;
        readonly createdAt: Date;
      }>`
        select id::text, seq, emission_key as "emissionKey",
               emitted_by_task as "emittedByTask", event, created_at as "createdAt"
        from ai_run_events where run_id = ${aiRunId} order by seq
      `;
      const sources = yield* sql<
        Omit<DurableRunEvidence["sources"][number], "createdAt"> & { readonly createdAt: Date }
      >`
        select source_key as "sourceKey", kind, locator,
               document_version_id as "documentVersionId",
               publisher_document_version_id::text as "publisherDocumentVersionId",
               message_id::text as "messageId",
               memory_revision_id::text as "memoryRevisionId",
               display_label as "displayLabel", public_provenance as "publicProvenance",
               created_at as "createdAt"
        from assistant_message_sources where assistant_message_id = ${run.assistantMessageId}
      `;
      const sourceUses = yield* sql<
        Omit<DurableRunEvidence["sourceUses"][number], "createdAt"> & {
          readonly createdAt: Date;
        }
      >`
        select source_key as "sourceKey", consumer_task_id as "consumerTaskId",
               topic_id as "topicId", rendered_token_count as "renderedTokenCount",
               context_order as "contextOrder", ranges, created_at as "createdAt"
        from assistant_message_source_uses where assistant_message_id = ${run.assistantMessageId}
      `;
      const memoryWrites = yield* sql<
        Omit<DurableRunEvidence["memoryWrites"][number], "createdAt"> & {
          readonly createdAt: Date;
        }
      >`
        select current.memory_id::text as "memoryId", current.id::text as "revisionId",
               previous.id::text as "previousRevisionId", current.action,
               current.state_before as "stateBefore", current.state_after as "stateAfter",
               current.created_at as "createdAt"
        from user_memory_revisions current
        left join lateral (
          select candidate.id
          from user_memory_revisions candidate
          where candidate.memory_id = current.memory_id
            and (candidate.created_at, candidate.id) < (current.created_at, current.id)
          order by candidate.created_at desc, candidate.id desc
          limit 1
        ) previous on true
        left join ai_observations memory_order
          on memory_order.run_id = current.run_id
         and memory_order.kind = 'memory_written'
         and memory_order.payload->>'revisionId' = current.id::text
        where current.run_id = ${aiRunId}
        order by (memory_order.payload->>'ordinal')::int nulls last, current.id
      `;
      const memoryHeads = yield* sql<
        Omit<
          DurableRunEvidence["memoryHeads"][number],
          "createdAt" | "updatedAt" | "deletedAt" | "provenanceOnlyAt"
        > & {
          readonly createdAt: Date;
          readonly updatedAt: Date;
          readonly deletedAt: Date | null;
          readonly provenanceOnlyAt: Date | null;
        }
      >`
        select memories.id::text as "memoryId", memories.user_id as "userId",
               memories.kind, memories.content,
               memories.head_revision_id::text as "headRevisionId",
               memories.source_message_id::text as "sourceMessageId",
               memories.deleted_at as "deletedAt",
               memories.provenance_only_at as "provenanceOnlyAt",
               memories.created_at as "createdAt", memories.updated_at as "updatedAt"
        from user_memories memories
        join (
          select distinct memory_id
          from user_memory_revisions where run_id = ${aiRunId}
        ) writes on writes.memory_id = memories.id
        order by memories.id
      `;
      return DurableRunEvidenceSchema.parse({
        run: {
          id: run.id,
          chatId: run.chatId,
          userMessageId: run.userMessageId,
          initiatingUserId: run.initiatingUserId,
          locale: run.locale,
          market: run.market,
          webSearchEnabled: run.webSearchEnabled,
          effectiveWebPolicy: run.effectiveWebPolicy,
          smithersRunId: run.smithersRunId,
          createdAt: run.createdAt.toISOString(),
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt.toISOString(),
          failedAt: run.failedAt === null ? null : run.failedAt.toISOString(),
          assistantMessageId: run.assistantMessageId,
          citationNonceHex: run.citationNonceHex,
          nextEventSeq: run.nextEventSeq,
          errorCode: run.errorCode,
          retryable: run.retryable,
        },
        chat: {
          id: run.chatId,
          userId: run.chatUserId,
          companyId: run.chatCompanyId,
          memoryMode: run.chatMemoryMode,
          sharedAt: run.chatSharedAt === null ? null : run.chatSharedAt.toISOString(),
          deletedAt: run.chatDeletedAt === null ? null : run.chatDeletedAt.toISOString(),
          deletedByUserId: run.chatDeletedByUserId,
          purgeAfter: run.chatPurgeAfter === null ? null : run.chatPurgeAfter.toISOString(),
          legalHold: run.chatLegalHold,
          createdAt: run.chatCreatedAt.toISOString(),
          updatedAt: run.chatUpdatedAt.toISOString(),
        },
        currentUserMessage: {
          id: run.currentMessageId,
          chatId: run.currentMessageChatId,
          author: run.currentMessageAuthor,
          content: run.currentMessageContent,
          assistantAiRunId: run.currentMessageAssistantAiRunId,
          createdAt: run.currentMessageCreatedAt.toISOString(),
        },
        assistantMessage: {
          id: run.assistantRowId,
          chatId: run.assistantChatId,
          author: run.assistantAuthor,
          content: run.assistantContent,
          assistantAiRunId: run.assistantAiRunId,
          createdAt: run.assistantCreatedAt.toISOString(),
        },
        conversationInventory: conversationInventory.map((entry) => ({
          ...entry,
          createdAt: entry.createdAt.toISOString(),
          startedAt: entry.startedAt === null ? null : entry.startedAt.toISOString(),
          finishedAt: entry.finishedAt === null ? null : entry.finishedAt.toISOString(),
          failedAt: entry.failedAt === null ? null : entry.failedAt.toISOString(),
          userCreatedAt: entry.userCreatedAt.toISOString(),
          assistantCreatedAt:
            entry.assistantCreatedAt === null ? null : entry.assistantCreatedAt.toISOString(),
        })),
        usage: usage
          .map((entry) => ({ ...entry, createdAt: entry.createdAt.toISOString() }))
          .sort(compareDurableUsageChronology),
        externalToolUsage: externalToolUsage.map((entry) => ({
          ...entry,
          createdAt: entry.createdAt.toISOString(),
        })),
        observations: observations.map((observation) => ({
          ...observation,
          createdAt: observation.createdAt.toISOString(),
        })),
        sourceExposures: sourceExposures.map((exposure) => ({
          ...exposure,
          createdAt: exposure.createdAt.toISOString(),
        })),
        events: events.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })),
        sources: [...sources]
          .sort((left, right) => compareSourceKeys(left.sourceKey, right.sourceKey))
          .map((source) => ({
            ...source,
            createdAt: source.createdAt.toISOString(),
          })),
        sourceUses: [...sourceUses]
          .sort(
            (left, right) =>
              compareSourceKeys(left.sourceKey, right.sourceKey) ||
              left.consumerTaskId.localeCompare(right.consumerTaskId, "en"),
          )
          .map((use) => ({
            ...use,
            createdAt: use.createdAt.toISOString(),
          })),
        memoryWrites: memoryWrites.map((write) => ({
          ...write,
          createdAt: write.createdAt.toISOString(),
        })),
        memoryHeads: memoryHeads.map((memory) => ({
          ...memory,
          deletedAt: memory.deletedAt === null ? null : memory.deletedAt.toISOString(),
          provenanceOnlyAt:
            memory.provenanceOnlyAt === null ? null : memory.provenanceOnlyAt.toISOString(),
          createdAt: memory.createdAt.toISOString(),
          updatedAt: memory.updatedAt.toISOString(),
        })),
      });
    }),
  );

const usageCoordinateOrder = (
  left: DurableRunEvidence["usage"][number],
  right: DurableRunEvidence["usage"][number],
): number =>
  left.loopIteration - right.loopIteration ||
  left.attempt - right.attempt ||
  left.providerRequestIndex - right.providerRequestIndex;

export const compareDurableUsageChronology = (
  left: { readonly id: string; readonly createdAt: string },
  right: { readonly id: string; readonly createdAt: string },
): number => {
  const timeOrder =
    left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
  if (timeOrder !== 0) return timeOrder;
  const leftId = BigInt(left.id);
  const rightId = BigInt(right.id);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
};

const attestDurableUsageChronology = (
  row: CaseRunRow,
  evidence: Pick<DurableRunEvidence, "usage" | "externalToolUsage">,
): void => {
  const usage = evidence.usage;
  if (
    usage.some((entry) => !/^[1-9][0-9]*$/u.test(entry.id)) ||
    new Set(usage.map((entry) => entry.id)).size !== usage.length
  ) {
    throw new Error(`${row.topology}/${row.caseId} has duplicate durable usage IDs`);
  }
  for (let index = 1; index < usage.length; index += 1) {
    if (compareDurableUsageChronology(usage[index - 1]!, usage[index]!) > 0) {
      throw new Error(`${row.topology}/${row.caseId} usage is not in durable chronology order`);
    }
  }
  const byTask = new Map<string, DurableRunEvidence["usage"]>();
  for (const entry of usage) {
    byTask.set(entry.taskId, [...(byTask.get(entry.taskId) ?? []), entry]);
  }
  for (const [taskId, entries] of byTask) {
    const chronologyIds = entries.map((entry) => entry.id);
    const coordinateIds = [...entries].sort(usageCoordinateOrder).map((entry) => entry.id);
    if (canonicalJson(chronologyIds) !== canonicalJson(coordinateIds)) {
      throw new Error(
        `${row.topology}/${row.caseId}/${taskId} usage chronology contradicts provider coordinates`,
      );
    }
  }
  const assertContiguousIndexes = <
    Entry extends {
      readonly taskId: string;
      readonly loopIteration: number;
      readonly attempt: number;
    },
  >(
    entries: readonly Entry[],
    indexOf: (entry: Entry) => number,
    label: string,
  ) => {
    const groups = new Map<string, Entry[]>();
    for (const entry of entries) {
      const key = canonicalJson([entry.taskId, entry.loopIteration, entry.attempt]);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    for (const [key, group] of groups) {
      const indexes = group.map(indexOf).sort((left, right) => left - right);
      if (indexes.some((value, index) => value !== index)) {
        throw new Error(
          `${row.topology}/${row.caseId}/${key} has a non-contiguous ${label} request ledger`,
        );
      }
    }
  };
  assertContiguousIndexes(usage, (entry) => entry.providerRequestIndex, "provider");
  if (
    new Set(evidence.externalToolUsage.map((entry) => entry.id)).size !==
      evidence.externalToolUsage.length ||
    evidence.externalToolUsage.some(
      (entry) =>
        entry.providerServiceId !==
          (entry.operation === "web_search" ? "tinyfish_search_official" : "brief_fetch") ||
        entry.billedUnits !== null ||
        entry.durationMs < 0,
    )
  ) {
    throw new Error(`${row.topology}/${row.caseId} has invalid external-tool usage provenance`);
  }
  assertContiguousIndexes(
    evidence.externalToolUsage,
    (entry) => entry.toolRequestIndex,
    "external-tool",
  );
};

const expectedEvaluationSmithersRunId = (row: CaseRunRow): string =>
  row.topology === "specialized"
    ? deriveAiChatSmithersRunId(row.aiRunId)
    : `ai-evaluation-general-planner:${row.sessionId}:${row.caseId}`;

const attestConversationInventorySnapshot = (
  row: CaseRunRow,
  evidence: DurableRunEvidence,
  manifest: EvaluationSeedManifest,
  fixture: GoldenEvaluationCase,
): void => {
  if (
    evidence.conversationInventory.length !== manifest.turnBindings.length ||
    manifest.turnBindings.length !== fixture.conversation.length
  ) {
    throw new Error(`${row.topology}/${row.caseId} durable conversation inventory is incomplete`);
  }
  for (const [index, entry] of evidence.conversationInventory.entries()) {
    const binding = manifest.turnBindings[index];
    const golden = fixture.conversation[index];
    const createdAt = new Date(Date.UTC(2026, 6, 1, 0, index * 2));
    const terminalAt = new Date(createdAt.getTime() + 1_000);
    if (
      binding === undefined ||
      golden === undefined ||
      entry.turnId !== binding.aiRunId ||
      entry.chatId !== manifest.chatId ||
      entry.initiatingUserId !== manifest.userId ||
      entry.smithersRunId !== deriveAiChatSmithersRunId(binding.aiRunId) ||
      entry.locale !== fixture.locale ||
      entry.market !== fixture.market ||
      entry.webSearchEnabled ||
      canonicalJson(entry.effectiveWebPolicy) !==
        canonicalJson({ enabled: false, reason: "company_disabled", allowlistActive: false }) ||
      entry.createdAt !== createdAt.toISOString() ||
      entry.startedAt !== createdAt.toISOString() ||
      entry.finishedAt !== terminalAt.toISOString() ||
      entry.failedAt !== null ||
      entry.userMessageId !== binding.userMessageId ||
      entry.userChatId !== manifest.chatId ||
      entry.userAuthor !== "user" ||
      entry.userContent !== golden.userContent ||
      entry.userAssistantAiRunId !== null ||
      entry.userCreatedAt !== createdAt.toISOString() ||
      entry.assistantMessageId !== binding.assistantMessageId ||
      entry.assistantChatId !== manifest.chatId ||
      entry.assistantAuthor !== "assistant" ||
      entry.assistantContent !== golden.assistantContent ||
      entry.assistantAiRunId !== binding.aiRunId ||
      entry.assistantCreatedAt !== terminalAt.toISOString() ||
      entry.errorCode !== null ||
      entry.retryable !== null
    ) {
      throw new Error(
        `${row.topology}/${row.caseId} prior run/message snapshot differs from its seed`,
      );
    }
  }
};

const durableFinalSourceMapFromEvidence = (
  evidence: DurableRunEvidence,
): readonly FinalSourceRecord[] =>
  [...evidence.sources]
    .sort((left, right) => compareSourceKeys(left.sourceKey, right.sourceKey))
    .map((source) => ({
      sourceKey: source.sourceKey,
      locator: source.locator as FinalSourceRecord["locator"],
      label: source.displayLabel,
      publicProvenance: source.publicProvenance as FinalSourceRecord["publicProvenance"],
      uses: evidence.sourceUses
        .filter((use) => use.sourceKey === source.sourceKey)
        .map((use) => ({
          consumerTaskId: use.consumerTaskId,
          ...(use.topicId === null ? {} : { topicId: use.topicId }),
          renderedTokenCount: use.renderedTokenCount,
          contextOrder: use.contextOrder,
          ranges: use.ranges,
        })),
    }));

const attestCitationEvidence = (row: CaseRunRow, evidence: DurableRunEvidence): void => {
  const parsed = parseCurrentTurnCitations(
    evidence.assistantMessage.content,
    new Set(evidence.sources.map((source) => source.sourceKey)),
  );
  const actual = evidence.observations
    .filter(
      (observation) => observation.kind === "citation" || observation.kind === "citation_defect",
    )
    .sort((left, right) => left.observationKey.localeCompare(right.observationKey));
  const expected = [
    ...parsed.citations.map((citation) => ({
      observationKey: `citation:${citation.tagIndex}:${citation.keyIndex}`,
      kind: "citation" as const,
      payload: {
        assistantMessageId: evidence.assistantMessage.id,
        sourceKey: citation.sourceKey,
      },
    })),
    ...parsed.defects.map((defect) => ({
      observationKey: `citation_defect:${defect.tagIndex}:${defect.defectSlot}`,
      kind: "citation_defect" as const,
      payload: { token: defect.token, reason: defect.reason },
    })),
  ].sort((left, right) => left.observationKey.localeCompare(right.observationKey));
  const citationPayloadSchema = z
    .object({ assistantMessageId: z.uuid(), sourceKey: z.string().min(1) })
    .strict();
  const defectPayloadSchema = z
    .object({
      token: z.string().max(256),
      reason: z.enum(["malformed", "unknown_source_key"]),
    })
    .strict();
  if (
    actual.length !== expected.length ||
    actual.some((observation, index) => {
      const item = expected[index];
      if (
        item === undefined ||
        observation.emittingTask !== "finalize" ||
        observation.observationKey !== item.observationKey ||
        observation.kind !== item.kind
      ) {
        return true;
      }
      const payload =
        observation.kind === "citation"
          ? citationPayloadSchema.safeParse(observation.payload)
          : defectPayloadSchema.safeParse(observation.payload);
      return !payload.success || canonicalJson(payload.data) !== canonicalJson(item.payload);
    })
  ) {
    throw new Error(`${row.topology}/${row.caseId} citation observations are not exact`);
  }
  const finalizeObservations = evidence.observations.filter(
    (observation) =>
      observation.kind === "citation" ||
      observation.kind === "citation_defect" ||
      observation.kind === "memory_written",
  );
  const coordinate = finalizeObservations[0];
  if (
    coordinate !== undefined &&
    finalizeObservations.some(
      (observation) =>
        observation.emittingTask !== "finalize" ||
        observation.loopIteration !== coordinate.loopIteration ||
        observation.attempt !== coordinate.attempt,
    )
  ) {
    throw new Error(`${row.topology}/${row.caseId} finalization observations are not co-owned`);
  }
};

const attestEventEvidence = (
  row: CaseRunRow,
  evidence: DurableRunEvidence,
  manifest: EvaluationSeedManifest,
  fixture: GoldenEvaluationCase,
): void => {
  const events = evidence.events;
  if (
    events.length === 0 ||
    events.some((entry, index) => entry.seq !== index + 1) ||
    new Set(events.map((entry) => entry.id)).size !== events.length ||
    evidence.run.nextEventSeq !== events.length + 1
  ) {
    throw new Error(`${row.topology}/${row.caseId} has a non-contiguous durable event ledger`);
  }
  const first = events[0]!;
  const terminal = events.at(-1)!;
  if (
    events.filter((entry) => entry.event.type === "run_started").length !== 1 ||
    events.filter((entry) => entry.event.type === "done").length !== 1 ||
    first.event.type !== "run_started" ||
    first.emissionKey !== "run_started" ||
    first.emittedByTask !== null ||
    terminal.event.type !== "done" ||
    terminal.emissionKey !== "terminal" ||
    terminal.emittedByTask !== "finalize" ||
    terminal.event.assistantMessageId !== evidence.assistantMessage.id
  ) {
    throw new Error(`${row.topology}/${row.caseId} has invalid terminal event ownership`);
  }
  const expectedRequestKeys = new Set<string>();
  for (const usage of evidence.usage) {
    const key = `usage:request:model:${usage.taskId}:${usage.loopIteration}:${usage.attempt}:${usage.providerRequestIndex}`;
    expectedRequestKeys.add(key);
    const event = events.find((candidate) => candidate.emissionKey === key);
    if (
      event?.emittedByTask !== usage.taskId ||
      event.event.type !== "usage" ||
      event.event.scope !== "request" ||
      event.event.kind !== "model" ||
      event.event.role !== usage.agentRole ||
      event.event.attempt !== usage.attempt ||
      event.event.inputTokens !== usage.inputTokens ||
      event.event.outputTokens !== usage.outputTokens ||
      event.event.cachedTokens !== usage.cachedTokens ||
      event.event.reasoningTokens !== usage.reasoningTokens ||
      event.event.totalTokens !== usage.totalTokens
    ) {
      throw new Error(`${row.topology}/${row.caseId} model usage event is not exact`);
    }
  }
  for (const usage of evidence.externalToolUsage) {
    const key = `usage:request:${usage.operation}:${usage.taskId}:${usage.loopIteration}:${usage.attempt}:${usage.toolRequestIndex}`;
    expectedRequestKeys.add(key);
    const event = events.find((candidate) => candidate.emissionKey === key);
    if (
      event?.emittedByTask !== usage.taskId ||
      event.event.type !== "usage" ||
      event.event.scope !== "request" ||
      event.event.kind !== usage.operation ||
      event.event.attempt !== usage.attempt ||
      event.event.status !== usage.status ||
      event.event.resultCount !== usage.resultCount ||
      event.event.responseBytes !== usage.responseBytes ||
      event.event.billedUnits !== (usage.billedUnits === null ? null : Number(usage.billedUnits))
    ) {
      throw new Error(`${row.topology}/${row.caseId} external usage event is not exact`);
    }
  }
  const requestUsageEvents = events.filter(
    (entry) => entry.event.type === "usage" && entry.event.scope === "request",
  );
  if (
    requestUsageEvents.length !== expectedRequestKeys.size ||
    requestUsageEvents.some((entry) => !expectedRequestKeys.has(entry.emissionKey))
  ) {
    throw new Error(`${row.topology}/${row.caseId} has an unbound request-usage event`);
  }
  const aggregate = events.find((entry) => entry.emissionKey === "usage:run");
  const aggregateEvents = events.filter(
    (entry) => entry.event.type === "usage" && entry.event.scope === "run",
  );
  const aggregateBilledUnits = evidence.externalToolUsage.some(
    (usage) => usage.billedUnits === null,
  )
    ? null
    : evidence.externalToolUsage.reduce(
        (total, usage) => total + Number(usage.billedUnits ?? "0"),
        0,
      );
  if (
    aggregateEvents.length !== 1 ||
    aggregateEvents[0] !== aggregate ||
    aggregate?.emittedByTask !== "finalize" ||
    aggregate.event.type !== "usage" ||
    aggregate.event.scope !== "run" ||
    canonicalJson(aggregate.event.model) !==
      canonicalJson({
        inputTokens: evidence.usage.reduce((total, usage) => total + usage.inputTokens, 0),
        outputTokens: evidence.usage.reduce((total, usage) => total + usage.outputTokens, 0),
        cachedTokens: evidence.usage.reduce((total, usage) => total + usage.cachedTokens, 0),
        reasoningTokens: evidence.usage.reduce((total, usage) => total + usage.reasoningTokens, 0),
        totalTokens: evidence.usage.reduce((total, usage) => total + usage.totalTokens, 0),
        requestCount: evidence.usage.length,
      }) ||
    canonicalJson(aggregate.event.web) !==
      canonicalJson({
        searchCount: evidence.externalToolUsage.filter((usage) => usage.operation === "web_search")
          .length,
        fetchCount: evidence.externalToolUsage.filter((usage) => usage.operation === "web_fetch")
          .length,
        responseBytes: evidence.externalToolUsage.reduce(
          (total, usage) => total + usage.responseBytes,
          0,
        ),
        billedUnits: aggregateBilledUnits,
      })
  ) {
    throw new Error(`${row.topology}/${row.caseId} aggregate usage event is not exact`);
  }
  const contextEvents = events.filter((entry) => entry.event.type === "context_ready");
  const contextEvent = contextEvents[0];
  if (contextEvents.length !== 1 || contextEvent?.event.type !== "context_ready") {
    throw new Error(`${row.topology}/${row.caseId} lacks one exact context event`);
  }
  const expectedContext = expectedTerminalContextEvidence(row, evidence, manifest, fixture);
  const routing = canonicalResolutionAndPlan(row, evidence, manifest);
  const routedMode =
    routing.resolution.mode === "clarify"
      ? "clarification"
      : routing.plan?.mode === "fanout"
        ? "synthesis"
        : "single";
  if (
    expectedContext.mode !== routedMode ||
    contextEvent.event.mode !== expectedContext.mode ||
    contextEvent.event.reductionRan !== expectedContext.reductionRan ||
    canonicalJson(contextEvent.event.sourcesRead) !== canonicalJson(expectedContext.sourcesRead) ||
    canonicalJson(contextEvent.event.consumers) !== canonicalJson(expectedContext.consumers)
  ) {
    throw new Error(`${row.topology}/${row.caseId} context event payload is not exact`);
  }
  const expectedAnswerOwner =
    row.topology === "general_planner"
      ? "evaluation-general-planner"
      : expectedContext.mode === "clarification"
        ? "clarification-result"
        : expectedContext.mode === "synthesis"
          ? "fanout-synthesis"
          : "single-answer";
  const topicPacketObservations = evidence.observations.filter(
    (observation) => observation.kind === "topic_packet",
  );
  for (const observation of topicPacketObservations) {
    if (!isCanonicalSpecializedTopicAnswerTask(observation.emittingTask)) {
      throw new Error(`${row.topology}/${row.caseId} topic packet has a foreign owner`);
    }
    providerUsageForObservation(row, evidence, observation);
  }
  for (const taskId of new Set(topicPacketObservations.map((entry) => entry.emittingTask))) {
    const ownedPackets = topicPacketObservations
      .filter((entry) => entry.emittingTask === taskId)
      .sort(observationOrder);
    const terminal = ownedPackets.at(-1)!;
    if (
      ownedPackets.filter(
        (entry) =>
          entry.loopIteration === terminal.loopIteration && entry.attempt === terminal.attempt,
      ).length !== 1
    ) {
      throw new Error(`${row.topology}/${row.caseId} has duplicate terminal topic packets`);
    }
    terminalProviderUsage(row, evidence, terminal);
  }
  const memoryEvents = events.filter((entry) => entry.event.type === "memory_updated");
  const memoryEvent = memoryEvents[0];
  const memoryResultSchema = z
    .object({
      proposalCount: z.number().int().nonnegative(),
      discardedCount: z.number().int().nonnegative(),
      extractionSha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict();
  const memoryApplicationSchema = z
    .object({
      extractionTaskId: z.enum(["memory-extract", "evaluation-general-planner"]),
      extractionLoopIteration: z.number().int().nonnegative(),
      extractionAttempt: z.number().int().nonnegative(),
      extractionObservationKey: z.string().min(1),
      extractionSha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
      proposalCount: z.number().int().nonnegative(),
      discardedCount: z.number().int().nonnegative(),
    })
    .strict();
  const expectedMemoryTask =
    row.topology === "general_planner" ? "evaluation-general-planner" : "memory-extract";
  const memoryResultObservations = evidence.observations
    .filter((observation) => observation.kind === "memory_extraction_result")
    .sort(observationOrder);
  const memoryResults = memoryResultObservations.map((observation) => ({
    observation,
    result: memoryResultSchema.parse(observation.payload),
  }));
  for (const { observation } of memoryResults) {
    providerUsageForObservation(row, evidence, observation);
  }
  const applicationObservations = evidence.observations.filter(
    (observation) => observation.kind === "memory_application",
  );
  const applicationObservation = applicationObservations[0];
  const application = memoryApplicationSchema.safeParse(applicationObservation?.payload);
  const consumedMemoryResult = application.success
    ? memoryResults.find(
        ({ observation }) =>
          observation.emittingTask === application.data.extractionTaskId &&
          observation.loopIteration === application.data.extractionLoopIteration &&
          observation.attempt === application.data.extractionAttempt &&
          observation.observationKey === application.data.extractionObservationKey,
      )
    : undefined;
  const createdMemoryCount = evidence.memoryWrites.filter(
    (write) => write.action === "create",
  ).length;
  const updatedMemoryCount = evidence.memoryWrites.filter(
    (write) => write.action === "update",
  ).length;
  const memoryWrittenSchema = z
    .object({
      ordinal: z.number().int().nonnegative(),
      memoryId: z.uuid(),
      revisionId: z.uuid(),
      previousRevisionId: z.uuid().nullable(),
      action: z.enum(["create", "update"]),
    })
    .strict();
  const memoryWritten = evidence.observations
    .filter((observation) => observation.kind === "memory_written")
    .map((observation) => ({
      observation,
      parsed: memoryWrittenSchema.safeParse(observation.payload),
    }))
    .sort((left, right) =>
      left.parsed.success && right.parsed.success
        ? left.parsed.data.ordinal - right.parsed.data.ordinal
        : left.observation.observationKey.localeCompare(right.observation.observationKey),
    );
  const finalizeCoordinate = applicationObservation;
  const writesByRevisionId = new Map(
    evidence.memoryWrites.map((write) => [write.revisionId, write]),
  );
  const reconstructedProposals: MemoryExtractionResult["proposals"][number][] = [];
  const seenRevisionIds = new Set<string>();
  let memoryWrittenInvalid = false;
  for (const [ordinal, item] of memoryWritten.entries()) {
    if (!item.parsed.success) {
      memoryWrittenInvalid = true;
      continue;
    }
    const payload = item.parsed.data;
    const write = writesByRevisionId.get(payload.revisionId);
    if (
      write === undefined ||
      seenRevisionIds.has(payload.revisionId) ||
      payload.ordinal !== ordinal ||
      item.observation.observationKey !== `memory_written:${ordinal}` ||
      item.observation.emittingTask !== "finalize" ||
      payload.memoryId !== write.memoryId ||
      payload.action !== write.action ||
      payload.previousRevisionId !== write.previousRevisionId ||
      (payload.action === "create" && payload.previousRevisionId !== null) ||
      (payload.action === "update" && payload.previousRevisionId === null) ||
      write.stateAfter.deleted !== false ||
      (finalizeCoordinate !== undefined &&
        (item.observation.loopIteration !== finalizeCoordinate.loopIteration ||
          item.observation.attempt !== finalizeCoordinate.attempt))
    ) {
      memoryWrittenInvalid = true;
      continue;
    }
    seenRevisionIds.add(payload.revisionId);
    reconstructedProposals.push(
      payload.action === "create"
        ? { kind: write.stateAfter.kind, content: write.stateAfter.content }
        : {
            kind: write.stateAfter.kind,
            content: write.stateAfter.content,
            targetMemoryId: payload.memoryId,
            expectedHeadRevisionId: payload.previousRevisionId!,
          },
    );
  }
  const reconstructedExtraction: MemoryExtractionResult = {
    proposals: reconstructedProposals,
    discardedCount: application.success ? application.data.discardedCount : -1,
  };
  const consumedCoordinate = consumedMemoryResult?.observation;
  if (
    memoryEvents.length !== 1 ||
    memoryEvent?.event.type !== "memory_updated" ||
    applicationObservations.length !== 1 ||
    applicationObservation?.emittingTask !== "finalize" ||
    applicationObservation?.observationKey !==
      `finalize:${applicationObservation?.loopIteration}:${applicationObservation?.attempt}:memory_application:result` ||
    !application.success ||
    consumedMemoryResult === undefined ||
    consumedCoordinate === undefined ||
    consumedCoordinate.observationKey !==
      `${consumedCoordinate.emittingTask}:${consumedCoordinate.loopIteration}:${consumedCoordinate.attempt}:memory_extraction_result:result` ||
    consumedMemoryResult.result.extractionSha256Hex !== application.data.extractionSha256Hex ||
    consumedMemoryResult.result.proposalCount !== application.data.proposalCount ||
    consumedMemoryResult.result.discardedCount !== application.data.discardedCount ||
    memoryExtractionSha256Hex(reconstructedExtraction) !== application.data.extractionSha256Hex ||
    memoryResultObservations.some(
      (observation) =>
        observation !== consumedCoordinate &&
        (observation.loopIteration > consumedCoordinate.loopIteration ||
          (observation.loopIteration === consumedCoordinate.loopIteration &&
            observation.attempt >= consumedCoordinate.attempt)),
    ) ||
    memoryResultObservations.some(
      (observation) => observation.emittingTask !== expectedMemoryTask,
    ) ||
    evidence.memoryWrites.some((write) => write.action !== "create" && write.action !== "update") ||
    memoryEvent.event.created !== createdMemoryCount ||
    memoryEvent.event.updated !== updatedMemoryCount ||
    memoryEvent.event.discarded !== application.data.discardedCount ||
    application.data.proposalCount !== createdMemoryCount + updatedMemoryCount ||
    memoryWritten.length !== evidence.memoryWrites.length ||
    writesByRevisionId.size !== evidence.memoryWrites.length ||
    seenRevisionIds.size !== evidence.memoryWrites.length ||
    memoryWrittenInvalid
  ) {
    throw new Error(`${row.topology}/${row.caseId} memory event is not exactly reconstructable`);
  }
  terminalProviderUsage(row, evidence, consumedMemoryResult.observation);
  for (const entry of events) {
    if (entry.event.type === "context_ready") {
      if (entry.emissionKey !== "context_ready" || entry.emittedByTask !== expectedAnswerOwner) {
        throw new Error(`${row.topology}/${row.caseId} context event ownership is invalid`);
      }
    } else if (entry.event.type === "memory_updated") {
      if (entry.emissionKey !== "memory_updated" || entry.emittedByTask !== "finalize") {
        throw new Error(`${row.topology}/${row.caseId} memory event ownership is invalid`);
      }
    } else if (entry.event.type === "error") {
      throw new Error(`${row.topology}/${row.caseId} successful capture has an error event`);
    }
  }
  const answerStarts = events.filter((entry) => entry.event.type === "answer_started");
  const startsByAttempt = new Map<number, (typeof answerStarts)[number]>();
  for (const [index, entry] of answerStarts.entries()) {
    const previous = answerStarts[index - 1];
    const previousAttempt = previous?.event.type === "answer_started" ? previous.event.attempt : -1;
    if (
      entry.event.type !== "answer_started" ||
      entry.emittedByTask !== expectedAnswerOwner ||
      entry.event.mode !== expectedContext.mode ||
      !Number.isSafeInteger(entry.event.attempt) ||
      entry.event.attempt < 0 ||
      entry.emissionKey !== `answer_started:${expectedAnswerOwner}:${entry.event.attempt}` ||
      (index > 0 && entry.event.attempt <= previousAttempt)
    ) {
      throw new Error(`${row.topology}/${row.caseId} answer-start chronology is invalid`);
    }
    startsByAttempt.set(entry.event.attempt, entry);
  }
  const deltaCounts = new Map<number, number>();
  const deltaText = new Map<number, string>();
  for (const entry of events.filter((candidate) => candidate.event.type === "text_delta")) {
    const match = new RegExp(`^text_delta:${expectedAnswerOwner}:([0-9]+):([0-9]+)$`, "u").exec(
      entry.emissionKey,
    );
    const attempt = match === null ? -1 : Number(match[1]);
    const deltaIndex = match === null ? -1 : Number(match[2]);
    const start = startsByAttempt.get(attempt);
    const nextStart = answerStarts.find(
      (candidate) => candidate.event.type === "answer_started" && candidate.event.attempt > attempt,
    );
    const expectedIndex = deltaCounts.get(attempt) ?? 0;
    if (
      entry.event.type !== "text_delta" ||
      entry.emittedByTask !== expectedAnswerOwner ||
      match === null ||
      !Number.isSafeInteger(attempt) ||
      !Number.isSafeInteger(deltaIndex) ||
      start === undefined ||
      entry.seq <= start.seq ||
      (nextStart !== undefined && entry.seq >= nextStart.seq) ||
      deltaIndex !== expectedIndex
    ) {
      throw new Error(`${row.topology}/${row.caseId} text-delta chronology is invalid`);
    }
    deltaCounts.set(attempt, expectedIndex + 1);
    deltaText.set(attempt, `${deltaText.get(attempt) ?? ""}${entry.event.delta}`);
  }
  const terminalAnswerStart = answerStarts.at(-1);
  if (terminalAnswerStart?.event.type !== "answer_started") {
    throw new Error(`${row.topology}/${row.caseId} lacks an answer-start event`);
  }
  const terminalText = deltaText.get(terminalAnswerStart.event.attempt) ?? "";
  if (terminalText === "" || terminalText !== evidence.assistantMessage.content) {
    throw new Error(`${row.topology}/${row.caseId} terminal text events differ from the assistant`);
  }
};

const attestRelationalEvidence = (
  row: CaseRunRow,
  evidence: DurableRunEvidence,
  manifest: EvaluationSeedManifest,
  fixture: GoldenEvaluationCase,
  storedDocuments: StoredEvaluationDocuments,
): void => {
  const current = evidence.currentUserMessage;
  const assistant = evidence.assistantMessage;
  const startedAt = Date.parse(evidence.run.startedAt);
  const finishedAt = Date.parse(evidence.run.finishedAt);
  const currentRunEvidenceTimestamps = [
    ...evidence.usage.map((entry) => entry.createdAt),
    ...evidence.externalToolUsage.map((entry) => entry.createdAt),
    ...evidence.observations.map((entry) => entry.createdAt),
    ...evidence.sourceExposures.map((entry) => entry.createdAt),
    ...evidence.events.map((entry) => entry.createdAt),
    ...evidence.sources.map((entry) => entry.createdAt),
    ...evidence.sourceUses.map((entry) => entry.createdAt),
    ...evidence.memoryWrites.map((entry) => entry.createdAt),
  ];
  if (
    evidence.chat.id !== manifest.chatId ||
    evidence.chat.userId !== manifest.userId ||
    evidence.chat.companyId !== manifest.companyId ||
    evidence.chat.memoryMode !== "private_owner" ||
    evidence.chat.sharedAt !== null ||
    evidence.chat.deletedAt !== null ||
    evidence.chat.deletedByUserId !== null ||
    evidence.chat.purgeAfter !== null ||
    evidence.chat.legalHold ||
    Date.parse(evidence.chat.updatedAt) < Date.parse(evidence.chat.createdAt) ||
    current.id !== manifest.userMessageId ||
    current.chatId !== manifest.chatId ||
    current.author !== "user" ||
    current.content !== fixture.currentMessage ||
    current.assistantAiRunId !== null ||
    current.createdAt !== evidence.run.createdAt ||
    assistant.id !== evidence.run.assistantMessageId ||
    assistant.chatId !== manifest.chatId ||
    assistant.author !== "assistant" ||
    assistant.assistantAiRunId !== evidence.run.id ||
    Date.parse(assistant.createdAt) < startedAt ||
    Date.parse(assistant.createdAt) > finishedAt ||
    currentRunEvidenceTimestamps.some((value) => {
      const timestamp = Date.parse(value);
      return timestamp < startedAt || timestamp > finishedAt;
    })
  ) {
    throw new Error(`${row.topology}/${row.caseId} durable chat/message scope is invalid`);
  }
  if (
    evidence.observations.some((observation) => observation.chatId !== manifest.chatId) ||
    new Set(evidence.observations.map((observation) => observation.id)).size !==
      evidence.observations.length ||
    new Set(evidence.sourceExposures.map((exposure) => exposure.id)).size !==
      evidence.sourceExposures.length
  ) {
    throw new Error(`${row.topology}/${row.caseId} durable observability scope is invalid`);
  }
  const serializedLabelsByKey = new Map<string, string | null>();
  for (const observation of evidence.observations) {
    if (observation.kind !== "context_serialized") continue;
    const parsed = RestrictedContextLedgerSchema.safeParse(
      observation.payload.restrictedContextLedger,
    );
    if (!parsed.success || parsed.data.requestKind === "synthesis") continue;
    for (const source of parsed.data.sources) {
      const existing = serializedLabelsByKey.get(source.sourceKey);
      if (existing !== undefined && existing !== source.label) {
        throw new Error(`${row.topology}/${row.caseId} has conflicting durable source labels`);
      }
      serializedLabelsByKey.set(source.sourceKey, source.label);
    }
  }
  const sourceIdsByKey = new Map<string, string>();
  const reconstructedLocatorByKey = new Map<string, Record<string, unknown>>();
  for (const source of evidence.sources) {
    const sourceId = mapDurableSource(manifest, source);
    const binding = manifest.sourceBindings.find(
      (candidate) => evaluationBindingGoldenSourceId(candidate) === sourceId,
    );
    const golden = fixture.evidence.find((candidate) => candidate.sourceId === sourceId);
    const terminalLabel = serializedLabelsByKey.get(source.sourceKey);
    const expectedLabel =
      row.topology === "general_planner"
        ? sourceId
        : binding?.kind === "document"
          ? `Canonical evidence ${evaluationBindingGoldenSourceId(binding)}`
          : binding?.kind === "web"
            ? (() => {
                const locator = DurableWebSourceLocatorSchema.safeParse(source.locator);
                return locator.success ? locator.data.title : binding.title;
              })()
            : null;
    const parsedWebLocator =
      binding?.kind === "web" && golden?.kind === "web"
        ? DurableWebSourceLocatorSchema.safeParse(source.locator)
        : undefined;
    const liveWebLocator =
      parsedWebLocator?.success === true &&
      binding?.kind === "web" &&
      golden?.kind === "web" &&
      parsedWebLocator.data.domain === binding.domain
        ? parsedWebLocator.data
        : undefined;
    const expectedLocator =
      binding?.kind === "document" && golden?.kind === "document"
        ? {
            kind: "document",
            sourceId: documentBindingSourceId(binding),
            documentId: binding.documentId,
            documentVersionId: binding.documentVersionId,
            contentHash: binding.contentHash,
            ranges: normalizeCharacterRanges(
              evidence.sourceUses
                .filter((use) => use.sourceKey === source.sourceKey)
                .flatMap((use) => use.ranges),
              storedDocuments.get(evaluationBindingGoldenSourceId(binding))?.text.length ??
                (() => {
                  throw new Error(
                    `${row.topology}/${row.caseId} document source lacks current stored text`,
                  );
                })(),
            ),
            ...(binding.source.kind === "publisher"
              ? {
                  publisherIssueId: binding.source.issueId,
                  publisherDocumentId: binding.source.documentId,
                }
              : {}),
          }
        : binding?.kind === "chat_message"
          ? { kind: "chat_message", messageId: binding.messageId }
          : binding?.kind === "memory"
            ? {
                kind: "memory",
                memoryId: binding.memoryId,
                memoryRevisionId: binding.memoryRevisionId,
              }
            : binding?.kind === "web" && golden?.kind === "web"
              ? row.topology === "specialized"
                ? liveWebLocator
                : {
                    kind: "web",
                    url: binding.url,
                    title: binding.title,
                    domain: binding.domain,
                    quote: golden.content,
                    quoteHash: webQuoteHash(golden.content),
                    publishedAt: "2026-03-14T00:00:00.000Z",
                    capturedAt: binding.capturedAt,
                  }
              : undefined;
    const expectedProvenance =
      binding?.kind === "document"
        ? {
            sourceName:
              row.topology === "specialized"
                ? `Evaluation source ${fixture.id}`
                : "Brief canonical evaluation",
            documentTitle: `Canonical evidence ${evaluationBindingGoldenSourceId(binding)}`,
            citationUrl: `https://evaluation.invalid/documents/${binding.documentId}`,
            ...(row.topology === "specialized" ? { publishedAt: "2026-07-01T00:00:00.000Z" } : {}),
          }
        : binding?.kind === "web"
          ? row.topology === "specialized" && liveWebLocator !== undefined
            ? {
                documentTitle: liveWebLocator.title,
                citationUrl: liveWebLocator.url,
                ...(liveWebLocator.publishedAt === undefined
                  ? {}
                  : { publishedAt: liveWebLocator.publishedAt }),
              }
            : {
                documentTitle: binding.title,
                citationUrl: binding.url,
                publishedAt: "2026-03-14T00:00:00.000Z",
              }
          : {};
    if (
      sourceId === undefined ||
      binding === undefined ||
      golden === undefined ||
      expectedLabel === undefined ||
      (row.topology === "specialized" && terminalLabel !== expectedLabel) ||
      source.displayLabel !== expectedLabel ||
      source.publisherDocumentVersionId !== null ||
      expectedLocator === undefined ||
      canonicalJson(source.locator) !== canonicalJson(expectedLocator) ||
      canonicalJson(source.publicProvenance) !== canonicalJson(expectedProvenance) ||
      Date.parse(source.createdAt) < Date.parse(assistant.createdAt)
    ) {
      throw new Error(`${row.topology}/${row.caseId} assistant source provenance is invalid`);
    }
    sourceIdsByKey.set(source.sourceKey, sourceId);
    reconstructedLocatorByKey.set(source.sourceKey, expectedLocator);
  }
  if (sourceIdsByKey.size !== evidence.sources.length) {
    throw new Error(`${row.topology}/${row.caseId} assistant source keys are not unique`);
  }
  for (const use of evidence.sourceUses) {
    const source = evidence.sources.find((candidate) => candidate.sourceKey === use.sourceKey);
    if (source === undefined || Date.parse(use.createdAt) < Date.parse(source.createdAt)) {
      throw new Error(`${row.topology}/${row.caseId} assistant source use provenance is invalid`);
    }
  }
  const contextEvent = evidence.events.find((entry) => entry.event.type === "context_ready");
  if (contextEvent?.event.type !== "context_ready") {
    throw new Error(`${row.topology}/${row.caseId} has no source-map mode event`);
  }
  try {
    assertFinalSourceMap(
      {
        status: "ok",
        mode: contextEvent.event.mode,
        content: assistant.content,
        sourceMap: evidence.sources.map((source) => ({
          sourceKey: source.sourceKey,
          locator: reconstructedLocatorByKey.get(source.sourceKey) as FinalSourceRecord["locator"],
          label: source.displayLabel,
          publicProvenance: source.publicProvenance as FinalSourceRecord["publicProvenance"],
          uses: evidence.sourceUses
            .filter((use) => use.sourceKey === source.sourceKey)
            .map((use) => ({
              consumerTaskId: use.consumerTaskId,
              ...(use.topicId === null ? {} : { topicId: use.topicId }),
              renderedTokenCount: use.renderedTokenCount,
              contextOrder: use.contextOrder,
              ranges: use.ranges.map((range) => ({
                charStart: range.charStart,
                charEnd: range.charEnd,
              })),
            })),
        })),
      },
      evidence.run.citationNonceHex,
    );
  } catch (error) {
    throw new Error(`${row.topology}/${row.caseId} has an invalid final source map`, {
      cause: error,
    });
  }
  attestCitationEvidence(row, evidence);
  if (
    evidence.memoryWrites.some(
      (write) => Date.parse(write.createdAt) < Date.parse(evidence.run.startedAt),
    )
  ) {
    throw new Error(`${row.topology}/${row.caseId} memory revision chronology is invalid`);
  }
  const memoryHeads = new Map(evidence.memoryHeads.map((memory) => [memory.memoryId, memory]));
  if (
    memoryHeads.size !== evidence.memoryHeads.length ||
    memoryHeads.size !== new Set(evidence.memoryWrites.map((write) => write.memoryId)).size ||
    new Set(evidence.memoryWrites.map((write) => write.revisionId)).size !==
      evidence.memoryWrites.length
  ) {
    throw new Error(`${row.topology}/${row.caseId} memory write identities are not exact`);
  }
  for (const write of evidence.memoryWrites) {
    const head = memoryHeads.get(write.memoryId);
    const seededBinding = manifest.sourceBindings.find(
      (binding) => binding.kind === "memory" && binding.memoryId === write.memoryId,
    );
    const seededSource =
      seededBinding === undefined
        ? undefined
        : fixture.evidence.find(
            (source) => source.sourceId === evaluationBindingGoldenSourceId(seededBinding),
          );
    const expectedBefore =
      seededBinding?.kind === "memory" && seededSource?.kind === "memory"
        ? { kind: "preference" as const, content: seededSource.content, deleted: false }
        : null;
    if (
      head === undefined ||
      head.userId !== manifest.userId ||
      head.headRevisionId !== write.revisionId ||
      head.kind !== write.stateAfter.kind ||
      head.content !== write.stateAfter.content ||
      head.sourceMessageId !== manifest.userMessageId ||
      head.deletedAt !== null ||
      head.provenanceOnlyAt !== null ||
      write.stateAfter.deleted ||
      (write.action === "create" &&
        (write.stateBefore !== null ||
          write.previousRevisionId !== null ||
          seededBinding !== undefined ||
          Date.parse(head.createdAt) < startedAt)) ||
      (write.action === "update" &&
        (seededBinding?.kind !== "memory" ||
          write.previousRevisionId !== seededBinding.memoryRevisionId ||
          canonicalJson(write.stateBefore) !== canonicalJson(expectedBefore))) ||
      Date.parse(head.updatedAt) < Date.parse(write.createdAt) ||
      Date.parse(head.updatedAt) > finishedAt
    ) {
      throw new Error(`${row.topology}/${row.caseId} applied memory state is not exact`);
    }
  }
};

const attestAcceptedRunSnapshot = (
  row: CaseRunRow,
  evidence: DurableRunEvidence,
  storedDocuments: StoredEvaluationDocuments,
): void => {
  const manifest = EvaluationSeedManifestSchema.parse(row.seedManifest);
  const fixture = fixtureFor(row.caseId);
  const evaluationWebAllowlist =
    fixture.webRequested && fixture.webPolicyEnabled
      ? canonicalAllowedDomains(
          fixture.evidence.flatMap((source) => (source.kind === "web" ? [source.domain] : [])),
        )
      : null;
  const expectedPolicy: EffectiveWebPolicy =
    fixture.webRequested && fixture.webPolicyEnabled
      ? { enabled: true, provider: "tinyfish", allowedDomains: evaluationWebAllowlist }
      : { enabled: false, reason: "company_disabled", allowlistActive: false };
  const run = DurableRunSnapshotSchema.parse(evidence.run);
  if (
    run.id !== row.aiRunId ||
    run.id !== manifest.aiRunId ||
    run.chatId !== manifest.chatId ||
    run.userMessageId !== manifest.userMessageId ||
    run.initiatingUserId !== manifest.userId ||
    run.locale !== fixture.locale ||
    run.market !== fixture.market ||
    run.webSearchEnabled !== fixture.webRequested ||
    canonicalJson(run.effectiveWebPolicy) !== canonicalJson(expectedPolicy) ||
    run.smithersRunId !== expectedEvaluationSmithersRunId(row) ||
    run.createdAt !== "2026-07-10T10:00:00.000Z" ||
    Date.parse(run.startedAt) < Date.parse(run.createdAt) ||
    Date.parse(run.finishedAt) <= Date.parse(run.startedAt) ||
    run.failedAt !== null ||
    run.errorCode !== null ||
    run.retryable !== null
  ) {
    throw new Error(`${row.topology}/${row.caseId} accepted run snapshot differs from its seed`);
  }
  attestConversationInventorySnapshot(row, evidence, manifest, fixture);
  attestDurableUsageChronology(row, evidence);
  deriveTrustedPromptMeasurements(row.topology, row.caseId, evidence.usage, evidence.observations);
  attestExactSourceExposureRows(manifest, evidence, storedDocuments);
  attestEventEvidence(row, evidence, manifest, fixture);
  attestRetrievalManifestEvidence(row, evidence, manifest, storedDocuments);
  attestRelationalEvidence(row, evidence, manifest, fixture, storedDocuments);
};

const evaluationRunEvidenceDigest = (
  row: CaseRunRow,
  evidence: DurableRunEvidence,
  storedDocuments: StoredEvaluationDocuments,
): string => {
  attestAcceptedRunSnapshot(row, evidence, storedDocuments);
  if (
    row.evaluationConfigSha256Hex === null ||
    row.providerEndpointIdentity !== TINYFISH_SEARCH_PROVIDER_ENDPOINT_IDENTITY
  ) {
    throw new Error(
      `${row.topology}/${row.caseId} lacks the immutable canonical execution identity`,
    );
  }
  if (row.topology === "specialized") {
    if (row.executionOutput !== null || row.executionOutputSha256Hex !== null) {
      throw new Error(`${row.topology}/${row.caseId} cannot carry a baseline provider output`);
    }
  } else {
    if (row.executionOutput === null || row.executionOutputSha256Hex === null) {
      throw new Error(`${row.topology}/${row.caseId} lacks its durable provider output`);
    }
    GeneralPlannerProviderOutputSchema.parse(row.executionOutput);
    if (canonicalSha256Hex(row.executionOutput) !== row.executionOutputSha256Hex) {
      throw new Error(`${row.topology}/${row.caseId} provider-output digest mismatch`);
    }
  }
  return canonicalSha256Hex({
    topology: row.topology,
    evaluationConfigSha256Hex: row.evaluationConfigSha256Hex,
    providerEndpointIdentity: row.providerEndpointIdentity,
    durableRun: evidence,
    executionOutputSha256Hex: row.executionOutputSha256Hex,
  });
};

const assertLiveEvaluationAuthorization = async (
  connectionString: string,
  manifest: EvaluationSeedManifest,
): Promise<void> => {
  const authorized = await db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{ readonly authorized: boolean }>`
        select exists (
          select 1
          from chats
          join platform_users users
            on users.id = ${manifest.userId}
           and users.recovery_deleted_at is null
           and users.purged_at is null
          join client_companies companies
            on companies.id = ${manifest.companyId}
           and companies.recovery_deleted_at is null
           and companies.purged_at is null
          join client_company_memberships memberships
            on memberships.company_id = companies.id
           and memberships.user_id = users.id
           and memberships.revoked_at is null
           and memberships.revoked_by_user_id is null
          where chats.id = ${manifest.chatId}
            and chats.company_id = companies.id
            and chats.user_id = users.id
            and chats.deleted_at is null
            and chats.purge_after is null
        ) as authorized
      `;
      return rows[0]?.authorized === true;
    }),
  );
  if (!authorized) {
    throw new Error(`${manifest.caseId} current evaluation authorization is invalid`);
  }
};

const finalizeCaseEvidence = async (connectionString: string, row: CaseRunRow): Promise<string> => {
  const manifest = EvaluationSeedManifestSchema.parse(row.seedManifest);
  await assertLiveEvaluationAuthorization(connectionString, manifest);
  const evidence = await loadDurableRunEvidence(connectionString, row.aiRunId);
  const storedDocuments = await loadStoredEvaluationDocuments(connectionString, manifest);
  if (
    evidence.usage.length === 0 ||
    evidence.usage.some((usage) => usage.providerServiceId !== ZAI_CODING_PLAN_PROVIDER_SERVICE_ID)
  ) {
    throw new Error(`${row.topology}/${row.caseId} is not exclusively backed by real Z.AI usage`);
  }
  const digest = evaluationRunEvidenceDigest(row, evidence, storedDocuments);
  const transitioned = await db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      return yield* sql<{ readonly id: string }>`
        update ai_evaluation_case_runs
        set status = 'succeeded', run_evidence_sha256_hex = ${digest},
            finished_at = now(), updated_at = now()
        where session_id = ${row.sessionId} and case_id = ${row.caseId}
          and topology = ${row.topology} and status = 'running'
        returning ai_run_id::text as id
      `;
    }),
  );
  if (transitioned.length !== 1) {
    const current = (await loadCaseRuns(connectionString, row.sessionId)).find(
      (candidate) => candidate.caseId === row.caseId && candidate.topology === row.topology,
    );
    if (current?.status !== "succeeded" || current.runEvidenceSha256Hex !== digest) {
      throw new Error(`${row.topology}/${row.caseId} evidence was not sealed exactly once`);
    }
  }
  return digest;
};

/** Recomputes and seals one already-terminal bound run; exported for recovery tooling and tests. */
export const attestEvaluationCaseFromDurableRun = async (
  connectionString: string,
  sessionId: string,
  caseId: string,
  topology: EvaluationTopology,
): Promise<string> => {
  const row = (await loadCaseRuns(connectionString, sessionId)).find(
    (candidate) => candidate.caseId === caseId && candidate.topology === topology,
  );
  if (row === undefined) throw new Error(`unknown evaluation case run ${topology}/${caseId}`);
  if (row.status !== "running") {
    if (row.status === "succeeded" && row.runEvidenceSha256Hex !== null) {
      const manifest = EvaluationSeedManifestSchema.parse(row.seedManifest);
      await assertLiveEvaluationAuthorization(connectionString, manifest);
      const storedDocuments = await loadStoredEvaluationDocuments(connectionString, manifest);
      const current = evaluationRunEvidenceDigest(
        row,
        await loadDurableRunEvidence(connectionString, row.aiRunId),
        storedDocuments,
      );
      if (current !== row.runEvidenceSha256Hex) {
        throw new Error(`${topology}/${caseId} durable evidence changed after attestation`);
      }
      return current;
    }
    throw new Error(`${topology}/${caseId} is not running or succeeded`);
  }
  return finalizeCaseEvidence(connectionString, row);
};

/** Runs and seals one bound specialized case, then terminalizes its focused parent session. */
export const executeSpecializedEvaluationCase = (
  connectionString: string,
  sessionId: string,
  caseId: string,
  config: WorkerConfig,
): Promise<string> =>
  withEvaluationSessionExecutionLease(connectionString, sessionId, async () => {
    const row = (await loadCaseRuns(connectionString, sessionId)).find(
      (candidate) => candidate.caseId === caseId && candidate.topology === "specialized",
    );
    if (row === undefined) throw new Error(`unknown specialized evaluation case ${caseId}`);
    let digest: string;
    try {
      await executeSpecialized(connectionString, config, row);
      const completed = (await loadCaseRuns(connectionString, sessionId)).find(
        (candidate) => candidate.caseId === caseId && candidate.topology === "specialized",
      );
      if (completed === undefined) throw new Error("specialized evaluation case disappeared");
      digest = await finalizeCaseEvidence(connectionString, completed);
    } catch (error) {
      await failCaseRun(connectionString, row, error);
      throw error;
    }
    await abortFocusedEvaluationSessionWithLeaseHeld(connectionString, sessionId);
    return digest;
  });

export const canonicalEvaluationFailureReason = (_error: unknown): string =>
  "evaluation_case_execution_failed";

const failedEvaluationOrigin = (
  session: EvaluationSessionRow,
  rows: readonly CaseRunRow[],
): CaseRunRow => {
  if (session.status === "failed") {
    const match = /^(specialized|general_planner)\/([^:]+):evaluation_case_execution_failed$/u.exec(
      session.failureReason ?? "",
    );
    const origin =
      match === null
        ? undefined
        : rows.find(
            (row) =>
              row.topology === match[1] && row.caseId === match[2] && row.status === "failed",
          );
    if (origin === undefined) {
      throw new Error("failed evaluation session lacks its exact immutable origin case");
    }
    return origin;
  }
  const failed = rows.filter((row) => row.status === "failed");
  if (session.status !== "running" || failed.length !== 1) {
    throw new Error("running evaluation failure cascade lacks one unique origin case");
  }
  return failed[0]!;
};

const terminalizeEvaluationCaseProductRun = async (
  connectionString: string,
  row: CaseRunRow,
): Promise<void> => {
  if (row.status === "seeded") await ensureEvaluationCaseRunning(connectionString, row);
  const state = await db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{
        readonly started: boolean;
        readonly terminal: boolean;
      }>`
        select started_at is not null as started,
               finished_at is not null or failed_at is not null as terminal
        from ai_runs where id = ${row.aiRunId}
      `;
      const state = rows[0];
      if (state === undefined) return yield* Effect.fail(new Error("evaluation ai run is missing"));
      return state;
    }),
  );
  if (state.terminal) {
    if (!state.started) {
      throw new Error("terminal evaluation ai run lacks its immutable start event");
    }
    return;
  }
  await db(connectionString, markAiRunStarted(row.aiRunId));
  await db(connectionString, failAiRun(row.aiRunId, "finalization_failed"));
};

const markEvaluationCaseFailed = async (
  connectionString: string,
  row: CaseRunRow,
  reason: string,
): Promise<void> =>
  db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const caseRows = yield* sql<{ readonly id: string }>`
        update ai_evaluation_case_runs
        set status = 'failed', failure_reason = ${reason},
            finished_at = now(), updated_at = now()
        where session_id = ${row.sessionId} and case_id = ${row.caseId}
          and topology = ${row.topology} and status = 'running'
        returning ai_run_id::text as id
      `;
      if (caseRows.length === 1) return;
      const existing = yield* sql<{
        readonly status: string;
        readonly failureReason: string | null;
      }>`
        select status, failure_reason as "failureReason"
        from ai_evaluation_case_runs
        where session_id = ${row.sessionId} and case_id = ${row.caseId}
          and topology = ${row.topology}
      `;
      if (
        caseRows.length !== 0 ||
        existing.length !== 1 ||
        existing[0]?.status !== "failed" ||
        existing[0]?.failureReason !== reason
      ) {
        return yield* Effect.fail(
          new Error(`${row.topology}/${row.caseId} failed from an illegal state`),
        );
      }
    }),
  ).then(() => undefined);

const failCaseRun = async (
  connectionString: string,
  row: CaseRunRow,
  error: unknown,
): Promise<void> => {
  const reason = canonicalEvaluationFailureReason(error);
  const sessionReason = `${row.topology}/${row.caseId}:${reason}`;
  // Preserve the origin before touching siblings. A crash leaves a running
  // parent with exactly one failed origin, which resume can deterministically
  // use to replay the remaining cascade.
  await terminalizeEvaluationCaseProductRun(connectionString, row);
  await markEvaluationCaseFailed(connectionString, row, reason);

  const siblings = (await loadCaseRuns(connectionString, row.sessionId)).filter(
    (candidate) =>
      (candidate.caseId !== row.caseId || candidate.topology !== row.topology) &&
      (candidate.status === "seeded" || candidate.status === "running"),
  );
  for (const sibling of siblings) {
    await terminalizeEvaluationCaseProductRun(connectionString, sibling);
  }

  await db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const sibling of siblings) {
            const caseRows = yield* sql<{ readonly id: string }>`
              update ai_evaluation_case_runs
              set status = 'failed', failure_reason = ${reason},
                  finished_at = now(), updated_at = now()
              where session_id = ${sibling.sessionId} and case_id = ${sibling.caseId}
                and topology = ${sibling.topology} and status = 'running'
              returning ai_run_id::text as id
            `;
            if (caseRows.length !== 1) {
              return yield* Effect.fail(
                new Error(`evaluation sibling ${sibling.topology}/${sibling.caseId} did not fail`),
              );
            }
          }
          const sessionRows = yield* sql<{ readonly id: string }>`
            update ai_evaluation_sessions
            set status = 'failed', failure_reason = ${sessionReason},
                completed_at = now(), updated_at = now()
            where id = ${row.sessionId} and status = 'running'
            returning id::text
          `;
          if (sessionRows.length === 0) {
            const existing = yield* sql<{
              readonly status: string;
              readonly failureReason: string | null;
            }>`
              select status, failure_reason as "failureReason"
              from ai_evaluation_sessions where id = ${row.sessionId}
            `;
            if (
              existing.length !== 1 ||
              existing[0]?.status !== "failed" ||
              existing[0]?.failureReason !== sessionReason
            ) {
              return yield* Effect.fail(
                new Error("evaluation session failure transition came from an illegal state"),
              );
            }
          } else if (sessionRows.length !== 1) {
            return yield* Effect.fail(
              new Error("evaluation session failure transition was not unique"),
            );
          }
        }),
      );
    }),
  );
};

const abortFocusedEvaluationSessionWithLeaseHeld = async (
  connectionString: string,
  sessionId: string,
): Promise<void> => {
  const session = await loadEvaluationSession(connectionString, sessionId);
  const rows = await loadCaseRuns(connectionString, sessionId);
  if (session.status === "failed") {
    await failCaseRun(
      connectionString,
      failedEvaluationOrigin(session, rows),
      new Error("replaying focused evaluation abort"),
    );
    return;
  }
  if (session.status !== "running") {
    throw new Error(`focused evaluation session cannot abort from ${session.status}`);
  }
  const failed = rows.filter((row) => row.status === "failed");
  if (failed.length > 0) {
    await failCaseRun(
      connectionString,
      failedEvaluationOrigin(session, rows),
      new Error("finishing focused evaluation failure cascade"),
    );
    return;
  }
  const origin = rows.find((row) => row.status === "seeded" || row.status === "running");
  if (origin === undefined) {
    throw new Error("focused evaluation abort has no unfinished canonical origin");
  }
  await failCaseRun(connectionString, origin, new Error("focused evaluation session completed"));
};

/**
 * Closes a focused evaluation session without weakening the twenty-case
 * invariant. Already-succeeded cases remain immutable; every unfinished child
 * and the parent become terminal under the same execution lease.
 */
export const abortFocusedEvaluationSession = (
  connectionString: string,
  sessionId: string,
): Promise<void> =>
  withEvaluationSessionExecutionLease(connectionString, sessionId, () =>
    abortFocusedEvaluationSessionWithLeaseHeld(connectionString, sessionId),
  );

/** Reconciles a focused/direct handler run whose product child already failed terminally. */
export const reconcileTerminalFailedEvaluationCase = async (
  connectionString: string,
  sessionId: string,
  caseId: string,
  topology: EvaluationTopology,
): Promise<void> => {
  await withEvaluationSessionExecutionLease(connectionString, sessionId, async () => {
    const row = (await loadCaseRuns(connectionString, sessionId)).find(
      (candidate) => candidate.caseId === caseId && candidate.topology === topology,
    );
    if (row === undefined) throw new Error(`unknown evaluation case run ${topology}/${caseId}`);
    const terminallyFailed = await db(
      connectionString,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly failed: boolean }>`
          select finished_at is null and failed_at is not null as failed
          from ai_runs where id = ${row.aiRunId}
        `;
        return rows.length === 1 && rows[0]?.failed === true;
      }),
    );
    if (!terminallyFailed) {
      throw new Error("evaluation case reconciliation requires a terminal failed product run");
    }
    await failCaseRun(connectionString, row, new Error("terminal evaluation child failed"));
  });
};

/** Completes a crashed or legacy parent failure cascade under its session lease. */
export const recoverFailedEvaluationSessionChildren = (
  connectionString: string,
  sessionId: string,
): Promise<void> =>
  withEvaluationSessionExecutionLease(connectionString, sessionId, async () => {
    const session = await loadEvaluationSession(connectionString, sessionId);
    const rows = await loadCaseRuns(connectionString, sessionId);
    const origin = failedEvaluationOrigin(session, rows);
    await failCaseRun(connectionString, origin, new Error("recovering evaluation failure cascade"));
  });

export const evaluationCaseResumeAction = (
  topology: EvaluationTopology,
  hasSuccessfullyTerminalEvidence: boolean,
  hasBaselineOutput: boolean,
): "seal_evidence" | "resume_workflow" =>
  hasSuccessfullyTerminalEvidence && (topology === "specialized" || hasBaselineOutput)
    ? "seal_evidence"
    : "resume_workflow";

const executeEvaluationSessionWithLeaseHeld = async (
  connectionString: string,
  sessionId: string,
  config: WorkerConfig,
): Promise<void> => {
  const evaluationConfigSha256Hex = preflightCanonicalEvaluationExecution(connectionString, config);
  const session = await loadEvaluationSession(connectionString, sessionId);
  const rows = await loadCaseRuns(connectionString, sessionId);
  const expectedKeys = new Set(
    CanonicalGoldenEvaluationSet.cases.flatMap((fixture) =>
      (["specialized", "general_planner"] as const).map((topology) => `${topology}:${fixture.id}`),
    ),
  );
  const actualKeys = new Set(rows.map((row) => `${row.topology}:${row.caseId}`));
  if (
    rows.length !== expectedKeys.size ||
    actualKeys.size !== expectedKeys.size ||
    [...expectedKeys].some((key) => !actualKeys.has(key))
  ) {
    throw new Error(`evaluation session must have exactly ${expectedKeys.size} canonical runs`);
  }
  if (session.status === "failed") {
    const origin = failedEvaluationOrigin(session, rows);
    await failCaseRun(
      connectionString,
      origin,
      new Error("resuming failed evaluation session cascade"),
    );
    throw new Error(`evaluation session previously failed: ${session.failureReason ?? "unknown"}`);
  }
  if (session.status !== "preparing") {
    if (
      session.evaluationConfigSha256Hex !== evaluationConfigSha256Hex ||
      session.providerEndpointIdentity !== TINYFISH_SEARCH_PROVIDER_ENDPOINT_IDENTITY
    ) {
      throw new Error("evaluation session execution identity differs from its immutable preflight");
    }
  }
  if (session.status === "awaiting_annotations" || session.status === "complete") {
    if (rows.some((row) => row.status !== "succeeded")) {
      throw new Error(`${session.status} evaluation session has non-succeeded case runs`);
    }
    return;
  }
  const failedOrigin = rows.find((row) => row.status === "failed");
  if (failedOrigin !== undefined) {
    const origin = failedEvaluationOrigin(session, rows);
    await failCaseRun(connectionString, origin, new Error("resuming evaluation failure cascade"));
    throw new Error(`evaluation session failed from ${origin.topology}/${origin.caseId}`);
  }
  if (session.status === "preparing") {
    if (rows.some((row) => row.status !== "seeded")) {
      throw new Error("preparing evaluation session contains a started case run");
    }
    const transitioned = await db(
      connectionString,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly id: string }>`
          update ai_evaluation_sessions
          set status = 'running', execution_config_sha256_hex = ${evaluationConfigSha256Hex},
              provider_endpoint_identity = ${TINYFISH_SEARCH_PROVIDER_ENDPOINT_IDENTITY},
              updated_at = now()
          where id = ${sessionId} and status = 'preparing'
            and execution_config_sha256_hex is null and provider_endpoint_identity is null
          returning id::text
        `;
      }),
    );
    if (transitioned.length !== 1) {
      const raced = await loadEvaluationSession(connectionString, sessionId);
      if (
        raced.status !== "running" ||
        raced.evaluationConfigSha256Hex !== evaluationConfigSha256Hex ||
        raced.providerEndpointIdentity !== TINYFISH_SEARCH_PROVIDER_ENDPOINT_IDENTITY
      ) {
        throw new Error("evaluation session did not enter running after exact preflight");
      }
    }
  } else if (session.status !== "running") {
    throw new Error(`evaluation session cannot execute from ${session.status}`);
  }

  for (const identity of rows) {
    let row = (await loadCaseRuns(connectionString, sessionId)).find(
      (candidate) =>
        candidate.caseId === identity.caseId && candidate.topology === identity.topology,
    );
    if (row === undefined) throw new Error("evaluation case disappeared during execution");
    if (row.status === "succeeded") continue;
    if (row.status === "failed") {
      throw new Error(`${row.topology}/${row.caseId} previously failed: ${row.failureReason}`);
    }
    try {
      if (row.status === "running") {
        const evidence = await loadDurableRunEvidence(connectionString, row.aiRunId).catch(
          () => null,
        );
        if (
          evaluationCaseResumeAction(
            row.topology,
            evidence !== null,
            row.executionOutput !== null,
          ) === "seal_evidence"
        ) {
          await finalizeCaseEvidence(connectionString, row);
          continue;
        }
      }
      if (row.topology === "specialized") {
        await executeSpecialized(connectionString, config, row);
      } else {
        await executeBaseline(connectionString, config, row);
      }
      row = (await loadCaseRuns(connectionString, sessionId)).find(
        (candidate) =>
          candidate.caseId === identity.caseId && candidate.topology === identity.topology,
      )!;
      await finalizeCaseEvidence(connectionString, row);
    } catch (error) {
      await failCaseRun(connectionString, row, error);
      throw error;
    }
  }
  const terminalRows = await loadCaseRuns(connectionString, sessionId);
  if (terminalRows.some((row) => row.status !== "succeeded")) {
    throw new Error("evaluation execution ended before every case run succeeded");
  }
  const completed = await db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      return yield* sql<{ readonly id: string }>`
        update ai_evaluation_sessions set status = 'awaiting_annotations', updated_at = now()
        where id = ${sessionId} and status = 'running'
        returning id::text
      `;
    }),
  );
  if (completed.length !== 1) {
    const raced = await loadEvaluationSession(connectionString, sessionId);
    const racedRows = await loadCaseRuns(connectionString, sessionId);
    if (
      (raced.status !== "awaiting_annotations" && raced.status !== "complete") ||
      racedRows.some((row) => row.status !== "succeeded")
    ) {
      throw new Error("evaluation session did not enter awaiting_annotations");
    }
  }
};

export const executeEvaluationSession = (
  connectionString: string,
  sessionId: string,
  config: WorkerConfig,
): Promise<void> =>
  withEvaluationSessionExecutionLease(connectionString, sessionId, () =>
    executeEvaluationSessionWithLeaseHeld(connectionString, sessionId, config),
  );

/** CLI-safe paid execution boundary: exact preflight runs before any session or fixture mutation. */
export const prepareAndExecuteEvaluationSession = async (
  connectionString: string,
  requestedSessionId: string | undefined,
  config: WorkerConfig,
): Promise<string> => {
  preflightCanonicalEvaluationExecution(connectionString, config);
  const sessionId = await createEvaluationSession(connectionString, requestedSessionId);
  await withEvaluationSessionExecutionLease(connectionString, sessionId, async () => {
    await seedEvaluationSessionWithLeaseHeld(connectionString, sessionId);
    await executeEvaluationSessionWithLeaseHeld(connectionString, sessionId, config);
  });
  return sessionId;
};

const validateAnnotationCompleteness = (
  file: EvaluationAnnotationFile,
  sessionId: string,
): void => {
  if (file.sessionId !== sessionId) throw new Error("annotation session ID mismatch");
  const expected = new Set(
    CanonicalGoldenEvaluationSet.cases.flatMap((fixture) =>
      (["specialized", "general_planner"] as const).map((topology) => `${topology}:${fixture.id}`),
    ),
  );
  const seen = new Set<string>();
  for (const annotation of file.annotations) {
    const key = `${annotation.topology}:${annotation.caseId}`;
    if (!expected.has(key)) throw new Error(`annotation contains unknown result ${key}`);
    if (seen.has(key)) throw new Error(`annotation duplicates result ${key}`);
    seen.add(key);
    validateEvaluationCaseAnnotation(annotation);
  }
  for (const key of expected) {
    if (!seen.has(key)) throw new Error(`annotation is missing result ${key}`);
  }
};

type EvaluationCaseAnnotation = z.infer<typeof EvaluationCaseAnnotationSchema>;

const validateEvaluationCaseAnnotation = (annotation: EvaluationCaseAnnotation): void => {
  const key = `${annotation.topology}:${annotation.caseId}`;
  const fixture = fixtureFor(annotation.caseId);
  const claimIds = new Set(fixture.labels.supportedClaims.map((claim) => claim.claimId));
  const gapIds = new Set(fixture.labels.expectedGaps.map((gap) => gap.gapId));
  const sourceIds = new Set(fixture.evidence.map((source) => source.sourceId));
  if (annotation.claims.some((claim) => !claimIds.has(claim.claimId))) {
    throw new Error(`${key} annotation contains an unknown golden claim ID`);
  }
  if (annotation.claims.some((claim) => claim.citedSourceIds.some((id) => !sourceIds.has(id)))) {
    throw new Error(`${key} annotation contains an unknown golden source ID`);
  }
  if (annotation.reportedGapIds.some((gapId) => !gapIds.has(gapId))) {
    throw new Error(`${key} annotation contains an unknown golden gap ID`);
  }
};

const bindEvaluationCaseAnnotationRow = async (
  connectionString: string,
  sessionId: string,
  annotation: EvaluationCaseAnnotation,
): Promise<void> => {
  validateEvaluationCaseAnnotation(annotation);
  const row = (await loadCaseRuns(connectionString, sessionId)).find(
    (candidate) =>
      candidate.caseId === annotation.caseId && candidate.topology === annotation.topology,
  );
  if (row?.status !== "succeeded" || row.runEvidenceSha256Hex === null) {
    throw new Error(`${annotation.topology}/${annotation.caseId} is not ready for annotation`);
  }
  const evidence = await loadDurableRunEvidence(connectionString, row.aiRunId);
  const manifest = EvaluationSeedManifestSchema.parse(row.seedManifest);
  const storedDocuments = await loadStoredEvaluationDocuments(connectionString, manifest);
  const currentDigest = evaluationRunEvidenceDigest(row, evidence, storedDocuments);
  if (currentDigest !== row.runEvidenceSha256Hex) {
    throw new Error(`${annotation.topology}/${annotation.caseId} durable evidence changed`);
  }
  const annotations: EvaluationHumanAnnotations = {
    claims: annotation.claims,
    reportedGapIds: annotation.reportedGapIds,
  };
  const annotationDigest = canonicalSha256Hex(annotations);
  const assistantDigest = sha256Hex(evidence.assistantMessage.content);
  await db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        insert into ai_evaluation_annotations (
          session_id, case_id, topology, ai_run_id, run_evidence_sha256_hex,
          assistant_output_sha256_hex, annotations, annotations_sha256_hex
        ) values (
          ${sessionId}, ${annotation.caseId}, ${annotation.topology}, ${row.aiRunId},
          ${currentDigest}, ${assistantDigest}, ${JSON.stringify(annotations)}::jsonb,
          ${annotationDigest}
        ) on conflict (session_id, case_id, topology) do nothing
      `;
      const bound = yield* sql<{
        readonly aiRunId: string;
        readonly runEvidenceSha256Hex: string;
        readonly assistantOutputSha256Hex: string;
        readonly annotationsSha256Hex: string;
        readonly annotations: unknown;
      }>`
        select ai_run_id::text as "aiRunId",
               run_evidence_sha256_hex as "runEvidenceSha256Hex",
               assistant_output_sha256_hex as "assistantOutputSha256Hex",
               annotations_sha256_hex as "annotationsSha256Hex", annotations
        from ai_evaluation_annotations
        where session_id = ${sessionId} and case_id = ${annotation.caseId}
          and topology = ${annotation.topology}
      `;
      const existing = bound[0];
      if (
        existing?.aiRunId !== row.aiRunId ||
        existing.runEvidenceSha256Hex !== currentDigest ||
        existing.assistantOutputSha256Hex !== assistantDigest ||
        existing.annotationsSha256Hex !== annotationDigest ||
        canonicalJson(existing.annotations) !== canonicalJson(annotations)
      ) {
        return yield* Effect.fail(
          new Error(
            `${annotation.topology}/${annotation.caseId} has different immutable annotations`,
          ),
        );
      }
    }),
  );
};

/** Binds one already-attested case without relaxing real-provider eligibility. */
export const bindEvaluationCaseAnnotation = async (
  connectionString: string,
  sessionId: string,
  input: unknown,
): Promise<void> =>
  bindEvaluationCaseAnnotationRow(
    connectionString,
    sessionId,
    EvaluationCaseAnnotationSchema.parse(input),
  );

export const bindEvaluationAnnotations = async (
  connectionString: string,
  sessionId: string,
  input: unknown,
): Promise<void> => {
  const file = EvaluationAnnotationFileSchema.parse(input);
  validateAnnotationCompleteness(file, sessionId);
  for (const annotation of file.annotations) {
    await bindEvaluationCaseAnnotationRow(connectionString, sessionId, annotation);
  }
};

const mapDurableSource = (
  manifest: EvaluationSeedManifest,
  source: DurableRunEvidence["sources"][number],
): string | undefined => {
  const fixture = fixtureFor(manifest.caseId);
  const matches = manifest.sourceBindings.filter((binding) => {
    if (binding.kind !== source.kind) return false;
    if (binding.kind === "document") return documentBindingMatchesLocator(binding, source.locator);
    if (binding.kind === "chat_message") return binding.messageId === source.messageId;
    if (binding.kind === "memory") return binding.memoryRevisionId === source.memoryRevisionId;
    const locator = DurableWebSourceLocatorSchema.safeParse(source.locator);
    if (!locator.success || locator.data.domain !== binding.domain) return false;
    const golden = fixture.evidence.find(
      (candidate) => candidate.sourceId === evaluationBindingGoldenSourceId(binding),
    );
    return (
      canonicalizeWebUrl(binding.url) === canonicalizeWebUrl(locator.data.url) ||
      (golden?.kind === "web" && golden.content === locator.data.quote)
    );
  });
  const liveDomainMatches =
    source.kind === "web"
      ? manifest.sourceBindings.filter(
          (binding) =>
            binding.kind === "web" &&
            DurableWebSourceLocatorSchema.safeParse(source.locator).success &&
            binding.domain === DurableWebSourceLocatorSchema.parse(source.locator).domain,
        )
      : [];
  const resolvedMatches =
    matches.length === 0 && liveDomainMatches.length === 1 ? liveDomainMatches : matches;
  if (resolvedMatches.length > 1) {
    throw new Error(`${manifest.caseId} durable source has an ambiguous document namespace`);
  }
  return resolvedMatches[0] === undefined
    ? undefined
    : evaluationBindingGoldenSourceId(resolvedMatches[0]);
};

const mapReferenceToGolden = (
  manifest: EvaluationSeedManifest,
  reference: Record<string, unknown>,
): string | undefined => {
  const internal = DurableInternalManifestReferenceSchema.safeParse(reference);
  if (internal.success) {
    const bindings =
      internal.data.kind === "document"
        ? (() => {
            const reference = internal.data;
            return manifest.sourceBindings.filter(
              (candidate) =>
                candidate.kind === "document" &&
                candidate.documentId === reference.documentId &&
                candidate.documentVersionId === reference.documentVersionId &&
                canonicalJson(candidate.source) === canonicalJson(reference.source),
            );
          })()
        : (() => {
            const reference = internal.data;
            return manifest.sourceBindings.filter(
              (candidate) =>
                candidate.kind === "chat_message" && candidate.messageId === reference.messageId,
            );
          })();
    return bindings.length === 1 ? evaluationBindingGoldenSourceId(bindings[0]!) : undefined;
  }

  const memory = DurableMemoryManifestReferenceSchema.safeParse(reference);
  if (memory.success) {
    const bindings = manifest.sourceBindings.filter(
      (candidate) =>
        candidate.kind === "memory" &&
        candidate.memoryId === memory.data.memoryId &&
        candidate.memoryRevisionId === memory.data.memoryRevisionId,
    );
    return bindings.length === 1 ? evaluationBindingGoldenSourceId(bindings[0]!) : undefined;
  }

  const web = DurableWebManifestReferenceSchema.safeParse(reference);
  if (web.success) {
    const bindings = manifest.sourceBindings.filter((candidate) => {
      return (
        candidate.kind === "web" &&
        candidate.domain === web.data.domain &&
        (canonicalizeWebUrl(candidate.url) === canonicalizeWebUrl(web.data.url) ||
          fixtureFor(manifest.caseId).evidence.find(
            (source) => source.sourceId === evaluationBindingGoldenSourceId(candidate),
          )?.content === web.data.quote)
      );
    });
    if (bindings.length === 1) return evaluationBindingGoldenSourceId(bindings[0]!);
    const domainBindings = manifest.sourceBindings.filter(
      (candidate) => candidate.kind === "web" && candidate.domain === web.data.domain,
    );
    return domainBindings.length === 1
      ? evaluationBindingGoldenSourceId(domainBindings[0]!)
      : undefined;
  }

  return undefined;
};

/**
 * Baseline selector observations deliberately retain the provider output's
 * golden source IDs and ranges rather than pretending to be production
 * retrieval manifests. Resolve that shape separately so capture can validate
 * the baseline artifact without weakening the namespaced production resolver.
 */
const mapBaselineReferenceToGolden = (
  manifest: EvaluationSeedManifest,
  reference: Record<string, unknown>,
  storedDocuments: StoredEvaluationDocuments,
): string | undefined => {
  const parsed = z
    .object({
      sourceId: z.string().min(1),
      ranges: z.array(BindingRangeSchema),
    })
    .strict()
    .safeParse(reference);
  if (!parsed.success) return undefined;
  const fixtureSource = fixtureFor(manifest.caseId).evidence.find(
    (source) => source.sourceId === parsed.data.sourceId,
  );
  const binding = manifest.sourceBindings.find(
    (candidate) => evaluationBindingGoldenSourceId(candidate) === parsed.data.sourceId,
  );
  if (fixtureSource === undefined || binding === undefined) return undefined;
  if (fixtureSource.kind !== "document" && parsed.data.ranges.length !== 0) return undefined;
  try {
    const normalized = normalizeCharacterRanges(
      parsed.data.ranges,
      fixtureSource.kind === "document"
        ? (storedDocuments.get(parsed.data.sourceId)?.text.length ?? 0)
        : fixtureSource.content.length,
    );
    if (canonicalJson(normalized) !== canonicalJson(parsed.data.ranges)) return undefined;
  } catch {
    return undefined;
  }
  return parsed.data.sourceId;
};

interface StoredEvaluationDocument {
  readonly sourceId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly text: string;
  readonly contentHash: string;
  readonly textCharCount: number;
}

type StoredEvaluationDocuments = ReadonlyMap<string, StoredEvaluationDocument>;

/**
 * Reconstructs the token-counting fixture with the exact current durable
 * document bodies. Capture may encounter a legacy provider turn whose
 * durable range includes storage padding; the persisted document, rather
 * than the shorter seed fixture, is the authority for that request.
 */
const fixtureWithStoredDocumentText = (
  fixture: GoldenEvaluationCase,
  storedDocuments: StoredEvaluationDocuments,
): GoldenEvaluationCase => ({
  ...fixture,
  evidence: fixture.evidence.map((source) => {
    if (source.kind !== "document") return source;
    const stored = storedDocuments.get(source.sourceId);
    if (stored === undefined) {
      throw new Error(`${fixture.id}/${source.sourceId} lacks current stored document text`);
    }
    return { ...source, content: stored.text };
  }),
});

/**
 * Reads the exact current text for every namespaced evaluation document. The
 * fixture is not a substitute for the persisted public/publisher document:
 * trusted capture must independently hash the row that the runtime exposed.
 */
const loadStoredEvaluationDocuments = (
  connectionString: string,
  manifest: EvaluationSeedManifest,
): Promise<StoredEvaluationDocuments> =>
  db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const documents = new Map<string, StoredEvaluationDocument>();
      for (const binding of manifest.sourceBindings) {
        if (binding.kind !== "document") continue;
        const rows = yield* sql<{
          readonly sourceId: string;
          readonly documentId: string;
          readonly documentVersionId: string;
          readonly text: string;
          readonly contentHash: string;
          readonly textCharCount: number;
        }>`
          select source_id::text as "sourceId",
                 document_id::text as "documentId",
                 document_id::text as "documentVersionId",
                 text, content_hash as "contentHash", text_char_count as "textCharCount"
          from public_source_documents
          where ${binding.source.kind === "public"} = true
            and source_id = ${binding.source.kind === "public" ? binding.source.sourceId.slice("public:".length) : null}
            and document_id = ${binding.documentId}
          union all
          select subscriptions.id::text as "sourceId",
                 documents.id::text as "documentId",
                 versions.id::text as "documentVersionId",
                 versions.canonical_text as text, versions.content_hash as "contentHash",
                 versions.text_char_count as "textCharCount"
          from brief_document_versions versions
          join brief_documents documents on documents.id = versions.brief_document_id
          join publisher_issues issues on issues.id = documents.issue_id
          join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
          where ${binding.source.kind === "publisher"} = true
            and subscriptions.id::text = ${binding.source.kind === "publisher" ? binding.source.sourceId.slice("publisher:".length) : null}
            and issues.id::text = ${binding.source.kind === "publisher" ? binding.source.issueId : null}
            and documents.id::text = ${binding.documentId}
            and versions.id::text = ${binding.documentVersionId}
        `;
        if (rows.length !== 1) {
          throw new Error(
            `${manifest.caseId}/${evaluationBindingGoldenSourceId(binding)} lacks one current stored document version`,
          );
        }
        const stored = rows[0]!;
        if (
          stored.sourceId !== binding.source.sourceId.slice(`${binding.source.kind}:`.length) ||
          stored.documentId !== binding.documentId ||
          stored.documentVersionId !== binding.documentVersionId ||
          stored.contentHash !== binding.contentHash ||
          sha256Hex(stored.text) !== stored.contentHash
        ) {
          throw new Error(
            `${manifest.caseId}/${evaluationBindingGoldenSourceId(binding)} stored document text/hash drift`,
          );
        }
        documents.set(evaluationBindingGoldenSourceId(binding), {
          sourceId: stored.sourceId,
          documentId: stored.documentId,
          documentVersionId: stored.documentVersionId,
          text: stored.text,
          contentHash: stored.contentHash,
          textCharCount: stored.textCharCount,
        });
      }
      return documents;
    }),
  );

const SourceExposureAttestationSchema = z
  .object({
    providerRequestIndex: z.number().int().nonnegative(),
    providerRequestSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
    sourceKind: z.enum(["document", "chat_message", "memory", "web"]),
    logicalSourceIdentity: z.string().min(1),
    contentItemIdentity: z.string().min(1),
    exposureStage: z.string().min(1),
    visibleTokenCount: z.number().int().nonnegative(),
    providerSerializationProofSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
    documentSourceId: z
      .string()
      .regex(/^(?:public|publisher):[^:\s]+$/u)
      .optional(),
    documentId: z.string().min(1).optional(),
    documentVersionId: z.string().min(1).optional(),
    documentContentHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    documentRanges: z.array(BindingRangeSchema).optional(),
  })
  .strict();

const ProviderRequestMeasurementSchema = z
  .object({
    providerRequestIndex: z.number().int().nonnegative(),
    agentRole: z.string().min(1),
    modelId: z.string().min(1),
    requestSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
    sourceExposureProofSha256Hexes: z.array(z.string().regex(/^[0-9a-f]{64}$/u)),
    inputTokens: z.number().int().nonnegative(),
    requestedOutputTokens: z.number().int().positive(),
    usableInputTokens: z.number().int().positive(),
    contextWindow: z.number().int().positive(),
    passed: z.boolean(),
  })
  .strict();

const providerCoordinateKey = (
  taskId: string,
  loopIteration: number,
  attempt: number,
  providerRequestIndex: number,
): string => canonicalJson([taskId, loopIteration, attempt, providerRequestIndex]);

const exposureCoordinateKey = (exposure: DurableRunEvidence["sourceExposures"][number]): string =>
  canonicalJson([
    exposure.taskId,
    exposure.loopIteration,
    exposure.attempt,
    exposure.providerRequestIndex,
    exposure.exposureStage,
    exposure.contentItemIdentity,
  ]);

const reconstructDocumentExposureText = (
  manifest: EvaluationSeedManifest,
  exposure: DurableRunEvidence["sourceExposures"][number],
  sourceId: string,
  source: { readonly kind: string; readonly content: string },
  storedDocuments: StoredEvaluationDocuments,
): string => {
  if (source.kind !== "document") {
    throw new Error(`${manifest.caseId} document exposure mapped to a non-document source`);
  }
  const binding = manifest.sourceBindings.find(
    (candidate) =>
      candidate.kind === "document" && evaluationBindingGoldenSourceId(candidate) === sourceId,
  );
  if (binding === undefined || binding.kind !== "document") {
    throw new Error(`${manifest.caseId} document exposure has no immutable binding`);
  }
  const metadata = {
    sourceId: exposure.documentSourceId,
    documentId: exposure.documentId,
    documentVersionId: exposure.documentVersionId,
    contentHash: exposure.documentContentHash,
    ranges: exposure.documentRanges,
  };
  if (
    metadata.sourceId === null ||
    metadata.documentId === null ||
    metadata.documentVersionId === null ||
    metadata.contentHash === null ||
    metadata.ranges === null
  ) {
    throw new Error(`${manifest.caseId} document exposure lacks reconstruction metadata`);
  }
  const stored = storedDocuments.get(sourceId);
  if (stored === undefined) {
    throw new Error(`${manifest.caseId} document exposure has no current stored document`);
  }
  const documentText = stored.text;
  if (
    metadata.sourceId !== binding.sourceId ||
    metadata.documentId !== binding.documentId ||
    metadata.documentVersionId !== binding.documentVersionId ||
    metadata.contentHash !== binding.contentHash ||
    metadata.contentHash !== sha256Hex(documentText)
  ) {
    throw new Error(`${manifest.caseId} document exposure immutable identity is invalid`);
  }
  let ranges: readonly EvaluationRange[];
  try {
    ranges = normalizeCharacterRanges(metadata.ranges, documentText.length);
  } catch (error) {
    throw new Error(
      `${manifest.caseId} document exposure ranges are invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (canonicalJson(ranges) !== canonicalJson(metadata.ranges)) {
    throw new Error(`${manifest.caseId} document exposure ranges are not normalized`);
  }
  // jsonb is free to reorder object keys; rebuild the producer's exact
  // charStart/charEnd object shape before checking its range digest.
  const rangeIdentityJson = JSON.stringify(
    metadata.ranges.map(({ charStart, charEnd }) => ({ charStart, charEnd })),
  );
  const expectedIdentity = `${documentBindingIdentity(binding)}:${binding.documentVersionId}:${sha256Base64Url(rangeIdentityJson)}`;
  if (exposure.logicalSourceIdentity !== documentBindingIdentity(binding)) {
    throw new Error(`${manifest.caseId} document exposure namespace is invalid`);
  }
  if (exposure.contentItemIdentity !== expectedIdentity) {
    throw new Error(`${manifest.caseId} document exposure range identity is invalid`);
  }
  return ranges.map((range) => documentText.slice(range.charStart, range.charEnd)).join("\n…\n");
};

const liveWebQuoteForExposure = (
  manifest: EvaluationSeedManifest,
  evidence: DurableRunEvidence,
  exposure: DurableRunEvidence["sourceExposures"][number],
): string | undefined => {
  if (
    exposure.sourceKind !== "web" ||
    (exposure.exposureStage !== "answer_serialized" &&
      exposure.exposureStage !== "context_candidate_inspection")
  ) {
    return undefined;
  }
  const liveIdentity = /^web:(https:\/\/.+):([A-Za-z0-9_-]{43})$/u.exec(
    exposure.logicalSourceIdentity,
  );
  const transientIdentity = /^((?:https:\/\/).+):([A-Za-z0-9_-]{43})$/u.exec(
    exposure.contentItemIdentity,
  );
  const url = liveIdentity?.[1] ?? transientIdentity?.[1];
  const quoteHash = liveIdentity?.[2] ?? transientIdentity?.[2];
  if (url === undefined || quoteHash === undefined) return undefined;
  const canonicalUrl = canonicalizeWebUrl(url);
  const locator = evidence.sources
    .map((candidate) => DurableWebSourceLocatorSchema.safeParse(candidate.locator))
    .find(
      (candidate) =>
        candidate.success &&
        canonicalizeWebUrl(candidate.data.url) === canonicalUrl &&
        candidate.data.quoteHash === quoteHash,
    );
  if (locator?.success !== true) {
    throw new Error(`${manifest.caseId} live web exposure lacks its durable quotation`);
  }
  return locator.data.quote;
};

const webUrlFromExposureIdentity = (identity: string): string => {
  const liveIdentity = /^web:(https:\/\/.*):[A-Za-z0-9_-]{43}$/u.exec(identity);
  return liveIdentity?.[1] ?? identity;
};

const expectedExposureVisibleTokenCount = (
  manifest: EvaluationSeedManifest,
  evidence: DurableRunEvidence,
  exposure: DurableRunEvidence["sourceExposures"][number],
  modelId: string,
  storedDocuments: StoredEvaluationDocuments,
): number | null => {
  // Search previews intentionally commit only their marker proof: the
  // body-free snippet identity is not reversible after the provider turn.
  // Inspection identities, however, are bound to exact durable ranges (or a
  // whole non-document item) and must be reconstructed and recounted here.
  if (exposure.exposureStage === "internal_search_preview") {
    return null;
  }
  const model = resolveRegisteredModel(modelId);
  if (exposure.exposureStage === "provider_input") {
    const messages = [
      evidence.currentUserMessage,
      ...evidence.conversationInventory.flatMap((entry) => [
        {
          id: entry.userMessageId,
          content: entry.userContent,
        },
        ...(entry.assistantMessageId === null || entry.assistantContent === null
          ? []
          : [{ id: entry.assistantMessageId, content: entry.assistantContent }]),
      ]),
    ];
    const message = messages.find((candidate) => candidate.id === exposure.contentItemIdentity);
    if (message === undefined) {
      throw new Error(`${manifest.caseId} provider-input exposure has unknown message content`);
    }
    return model.countTextTokens(message.content);
  }
  if (exposure.exposureStage === "web_search_preview" || exposure.exposureStage === "web_fetch") {
    // Tinyfish snippets and fetched page bodies are intentionally transient.
    // Their exact provider-visible text is committed by the live Pi marker;
    // terminal web quotes are independently checked against canonical fixture
    // evidence and fetched-page provenance.
    return exposure.visibleTokenCount;
  }
  const liveWebQuote = liveWebQuoteForExposure(manifest, evidence, exposure);
  if (liveWebQuote !== undefined) {
    return resolveRegisteredModel(modelId).countTextTokens(liveWebQuote);
  }
  const fixture = fixtureFor(manifest.caseId);
  const sourceId = mapExposureToGolden(manifest, evidence, exposure, storedDocuments);
  const source =
    sourceId === null
      ? undefined
      : fixture.evidence.find((candidate) => candidate.sourceId === sourceId);
  if (source === undefined || sourceId === null) {
    throw new Error(`${manifest.caseId} source exposure lacks canonical visible content`);
  }
  let visibleText: string;
  if (
    exposure.exposureStage === "evaluation_general_planner_search" ||
    exposure.exposureStage === "evaluation_general_planner_inspect"
  ) {
    const match = /^(.*):([0-9]+):([0-9]+):([0-9a-f]{64})$/u.exec(exposure.contentItemIdentity);
    const binding = manifest.sourceBindings.find(
      (candidate) => evaluationBindingGoldenSourceId(candidate) === sourceId,
    );
    const expectedIdentity =
      binding?.kind === "document"
        ? documentBindingIdentity(binding)
        : binding === undefined
          ? undefined
          : evaluationBindingGoldenSourceId(binding);
    if (match === null || expectedIdentity === undefined || match[1] !== expectedIdentity) {
      throw new Error(`${manifest.caseId} baseline exposure range is invalid`);
    }
    const start = Number(match[2]);
    const end = Number(match[3]);
    const documentText =
      source.kind === "document" ? storedDocuments.get(sourceId)?.text : source.content;
    if (source.kind === "document") {
      const binding = manifest.sourceBindings.find(
        (candidate) => evaluationBindingGoldenSourceId(candidate) === sourceId,
      );
      if (
        binding?.kind !== "document" ||
        documentText === undefined ||
        sha256Hex(documentText) !== binding.contentHash
      ) {
        throw new Error(`${manifest.caseId} baseline document text/hash drift`);
      }
    }
    visibleText = documentText!.slice(start, end);
  } else if (
    exposure.exposureStage === "internal_inspection" ||
    exposure.exposureStage === "context_candidate_inspection"
  ) {
    visibleText =
      source.kind === "document"
        ? reconstructDocumentExposureText(manifest, exposure, sourceId, source, storedDocuments)
        : source.kind === "chat_message"
          ? stripHistoricalCitationTags(source.content)
          : source.content;
  } else if (
    exposure.exposureStage === "memory_direct_inventory" ||
    exposure.exposureStage === "memory_tool_result"
  ) {
    visibleText = source.content;
  } else if (exposure.exposureStage === "answer_serialized") {
    visibleText =
      source.kind === "document"
        ? reconstructDocumentExposureText(manifest, exposure, sourceId, source, storedDocuments)
        : source.content;
  } else {
    throw new Error(`${manifest.caseId} exposure stage lacks exact visible-token semantics`);
  }
  if (visibleText === "" && source.content !== "") {
    throw new Error(`${manifest.caseId} exposure visible content cannot be reconstructed`);
  }
  return model.countTextTokens(visibleText);
};

const attestExactSourceExposureRows = (
  manifest: EvaluationSeedManifest,
  evidence: DurableRunEvidence,
  storedDocuments: StoredEvaluationDocuments,
): void => {
  const attestations = evidence.observations.filter(
    (observation) => observation.kind === "source_exposure_attestation",
  );
  const requestAttestations = new Map<
    string,
    {
      readonly requestSha256Hex: string;
      readonly sourceProofs: readonly string[];
      readonly modelId: string;
    }
  >();
  for (const observation of evidence.observations.filter(
    (candidate) => candidate.kind === "provider_request_measurement",
  )) {
    const measurement = ProviderRequestMeasurementSchema.parse(observation.payload);
    if (!measurement.passed) continue;
    const key = providerCoordinateKey(
      observation.emittingTask,
      observation.loopIteration,
      observation.attempt,
      measurement.providerRequestIndex,
    );
    if (requestAttestations.has(key)) {
      throw new Error(`${manifest.caseId} has duplicate provider-request attestations`);
    }
    requestAttestations.set(key, {
      requestSha256Hex: measurement.requestSha256Hex,
      sourceProofs: measurement.sourceExposureProofSha256Hexes,
      modelId: measurement.modelId,
    });
  }
  const indexed = new Map<string, (typeof attestations)[number]>();
  for (const observation of attestations) {
    const payload = SourceExposureAttestationSchema.parse(observation.payload);
    const key = canonicalJson([
      observation.emittingTask,
      observation.loopIteration,
      observation.attempt,
      payload.providerRequestIndex,
      payload.exposureStage,
      payload.contentItemIdentity,
    ]);
    if (indexed.has(key)) {
      throw new Error(`${manifest.caseId} has duplicate source-exposure attestations`);
    }
    indexed.set(key, observation);
  }
  if (indexed.size !== evidence.sourceExposures.length) {
    throw new Error(`${manifest.caseId} lacks one attestation per source exposure`);
  }
  const expectedProofsByRequest = new Map<string, Set<string>>();
  for (const exposure of evidence.sourceExposures) {
    const observation = indexed.get(exposureCoordinateKey(exposure));
    if (observation === undefined) {
      throw new Error(`${manifest.caseId} source exposure lacks its durable attestation`);
    }
    const payload = SourceExposureAttestationSchema.parse(observation.payload);
    const requestKey = providerCoordinateKey(
      exposure.taskId,
      exposure.loopIteration,
      exposure.attempt,
      exposure.providerRequestIndex,
    );
    const requestAttestation = requestAttestations.get(requestKey);
    const exactProof = providerVisibleSourceExposureProofSha256Hex({
      sourceKind: payload.sourceKind,
      logicalSourceIdentity: payload.logicalSourceIdentity,
      contentItemIdentity: payload.contentItemIdentity,
      exposureStage: payload.exposureStage,
      visibleTokenCount: payload.visibleTokenCount,
    });
    const expectedVisibleTokenCount = expectedExposureVisibleTokenCount(
      manifest,
      evidence,
      exposure,
      requestAttestation?.modelId ?? "glm-5-turbo",
      storedDocuments,
    );
    const attestedDocumentMetadata = {
      sourceId: payload.documentSourceId ?? null,
      documentId: payload.documentId ?? null,
      documentVersionId: payload.documentVersionId ?? null,
      contentHash: payload.documentContentHash ?? null,
      ranges: payload.documentRanges ?? null,
    };
    const durableDocumentMetadata = {
      sourceId: exposure.documentSourceId,
      documentId: exposure.documentId,
      documentVersionId: exposure.documentVersionId,
      contentHash: exposure.documentContentHash,
      ranges: exposure.documentRanges,
    };
    if (
      payload.providerRequestIndex !== exposure.providerRequestIndex ||
      requestAttestation === undefined ||
      payload.providerRequestSha256Hex !== requestAttestation.requestSha256Hex ||
      payload.providerSerializationProofSha256Hex !== exactProof ||
      payload.sourceKind !== exposure.sourceKind ||
      payload.logicalSourceIdentity !== exposure.logicalSourceIdentity ||
      payload.contentItemIdentity !== exposure.contentItemIdentity ||
      payload.exposureStage !== exposure.exposureStage ||
      payload.visibleTokenCount !== exposure.visibleTokenCount ||
      (expectedVisibleTokenCount !== null &&
        exposure.visibleTokenCount !== expectedVisibleTokenCount) ||
      canonicalJson(attestedDocumentMetadata) !== canonicalJson(durableDocumentMetadata)
    ) {
      throw new Error(
        `${manifest.caseId} source exposure differs from its provider-request-bound attestation`,
      );
    }
    if (
      exposure.exposureStage === "internal_search_preview" ||
      exposure.exposureStage === "internal_inspection" ||
      exposure.exposureStage === "context_candidate_inspection" ||
      (exposure.exposureStage === "provider_input" &&
        isCanonicalSpecializedReducerTask(exposure.taskId))
    ) {
      const expected = expectedProofsByRequest.get(requestKey) ?? new Set<string>();
      expected.add(exactProof);
      expectedProofsByRequest.set(requestKey, expected);
    }
  }
  for (const [requestKey, requestAttestation] of requestAttestations) {
    const actual = [...new Set(requestAttestation.sourceProofs)].sort();
    const expected = [...(expectedProofsByRequest.get(requestKey) ?? new Set<string>())].sort();
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new Error(
        `${manifest.caseId} provider request has a missing or unbound source-serialization proof`,
      );
    }
  }
};

const validDocumentRangeIdentities = (
  fixture: GoldenEvaluationCase,
  manifest: EvaluationSeedManifest,
  evidence: DurableRunEvidence,
  binding: Extract<EvaluationSeedManifest["sourceBindings"][number], { readonly kind: "document" }>,
  storedDocuments: StoredEvaluationDocuments,
): ReadonlySet<string> => {
  const source = fixture.evidence.find(
    (candidate) => candidate.sourceId === evaluationBindingGoldenSourceId(binding),
  )!;
  const stored = storedDocuments.get(evaluationBindingGoldenSourceId(binding));
  if (stored === undefined) {
    throw new Error(`${manifest.caseId} document range identity lacks current stored document`);
  }
  const ranges: EvaluationRange[][] = [];
  const add = (value: unknown): void => {
    const parsed = z.array(BindingRangeSchema).safeParse(value);
    if (parsed.success) ranges.push(parsed.data);
  };
  add(source.ranges);
  add(fixture.labels.acceptableRanges[evaluationBindingGoldenSourceId(binding)]);
  add([{ charStart: 0, charEnd: stored.text.length }]);
  for (const durableSource of evidence.sources) {
    if (durableSource.documentVersionId === binding.documentVersionId) {
      add(durableSource.locator.ranges);
    }
  }
  const sourceKeys = new Set(
    evidence.sources
      .filter((durableSource) => durableSource.documentVersionId === binding.documentVersionId)
      .map((durableSource) => durableSource.sourceKey),
  );
  for (const use of evidence.sourceUses) if (sourceKeys.has(use.sourceKey)) add(use.ranges);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const nested of value) visit(nested);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (
      record.candidateId === documentBindingIdentity(binding) ||
      record.documentVersionId === binding.documentVersionId
    ) {
      add(record.ranges);
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  for (const observation of evidence.observations) visit(observation.payload);
  return new Set(
    ranges.map(
      (value) =>
        `${documentBindingIdentity(binding)}:${binding.documentVersionId}:${sha256Base64Url(JSON.stringify(value.map(({ charStart, charEnd }) => ({ charStart, charEnd }))))}`,
    ),
  );
};

const assertExposureStageTask = (
  manifest: EvaluationSeedManifest,
  exposure: DurableRunEvidence["sourceExposures"][number],
): void => {
  const topicTasks = (suffix: string) =>
    (["t1", "t2", "t3"] as const).map((topicId) => `topic-${topicId}-${suffix}`);
  const rules: Readonly<
    Record<string, { readonly tasks: readonly string[]; readonly kinds: readonly string[] }>
  > = {
    provider_input: {
      tasks: [
        "resolve-conversation",
        "plan-execution",
        "memory-extract",
        "single-retrieve-internal",
        ...topicTasks("retrieve-internal"),
        "single-reduce-plan",
        ...topicTasks("reduce-plan"),
        "single-answer",
        ...topicTasks("answer"),
        "fanout-synthesis",
      ],
      kinds: ["chat_message"],
    },
    internal_search_preview: {
      tasks: ["single-retrieve-internal", ...topicTasks("retrieve-internal")],
      kinds: ["document", "chat_message"],
    },
    internal_inspection: {
      tasks: ["single-retrieve-internal", ...topicTasks("retrieve-internal")],
      kinds: ["document", "chat_message"],
    },
    memory_direct_inventory: {
      tasks: ["memory-extract", "single-select-memories", ...topicTasks("select-memories")],
      kinds: ["memory"],
    },
    memory_tool_result: {
      tasks: ["memory-extract", "single-select-memories", ...topicTasks("select-memories")],
      kinds: ["memory"],
    },
    web_search_preview: {
      tasks: ["single-retrieve-web", ...topicTasks("retrieve-web")],
      kinds: ["web"],
    },
    web_fetch: {
      tasks: ["single-retrieve-web", ...topicTasks("retrieve-web")],
      kinds: ["web"],
    },
    answer_serialized: {
      tasks: ["single-answer", ...topicTasks("answer")],
      kinds: ["document", "chat_message", "memory", "web"],
    },
    context_candidate_inspection: {
      tasks: ["single-reduce-plan", ...topicTasks("reduce-plan")],
      kinds: ["document", "chat_message", "memory", "web"],
    },
    evaluation_general_planner_search: {
      tasks: ["evaluation-general-planner"],
      kinds: ["document", "chat_message", "memory", "web"],
    },
    evaluation_general_planner_inspect: {
      tasks: ["evaluation-general-planner"],
      kinds: ["document", "chat_message", "memory", "web"],
    },
  };
  const rule = rules[exposure.exposureStage];
  const valid =
    rule !== undefined &&
    rule.tasks.includes(exposure.taskId) &&
    rule.kinds.includes(exposure.sourceKind);
  if (!valid) {
    throw new Error(
      `${manifest.caseId} has a stage-incompatible ${exposure.taskId}/${exposure.exposureStage} exposure`,
    );
  }
};

const exactBaselineExposureMatches = (
  logicalSourceIdentity: string,
  documentText: string,
  contentItemIdentity: string,
): boolean => {
  const match = /^(.*):([0-9]+):([0-9]+):([0-9a-f]{64})$/u.exec(contentItemIdentity);
  if (match === null || match[1] !== logicalSourceIdentity) return false;
  const charStart = Number(match[2]);
  const charEnd = Number(match[3]);
  return (
    Number.isSafeInteger(charStart) &&
    Number.isSafeInteger(charEnd) &&
    charStart >= 0 &&
    charEnd > charStart &&
    charEnd <= documentText.length &&
    match[4] === sha256Hex(documentText.slice(charStart, charEnd))
  );
};

const mapExposureToGolden = (
  manifest: EvaluationSeedManifest,
  evidence: DurableRunEvidence,
  exposure: DurableRunEvidence["sourceExposures"][number],
  storedDocuments: StoredEvaluationDocuments,
): string | null => {
  assertExposureStageTask(manifest, exposure);
  if (exposure.sourceKind === "chat_message" && exposure.exposureStage === "provider_input") {
    const allowedMessageIds = new Set([
      manifest.userMessageId,
      ...manifest.turnBindings.flatMap((binding) => [
        binding.userMessageId,
        binding.assistantMessageId,
      ]),
    ]);
    const messageId = [...allowedMessageIds].find(
      (candidate) => chatMessageEvidenceIdentity(candidate) === exposure.logicalSourceIdentity,
    );
    if (messageId !== undefined && exposure.contentItemIdentity === messageId) {
      const binding = manifest.sourceBindings.find(
        (candidate) => candidate.kind === "chat_message" && candidate.messageId === messageId,
      );
      return binding === undefined ? null : evaluationBindingGoldenSourceId(binding);
    }
    throw new Error(`${manifest.caseId} has an unmapped conversation provider exposure`);
  }
  const fixture = fixtureFor(manifest.caseId);
  const fixtureById = new Map(fixture.evidence.map((source) => [source.sourceId, source] as const));
  const matches = manifest.sourceBindings.filter((binding) => {
    if (binding.kind !== exposure.sourceKind) return false;
    if (exposure.exposureStage.startsWith("evaluation_general_planner_")) {
      const expectedIdentity =
        binding.kind === "document"
          ? documentBindingIdentity(binding)
          : evaluationBindingGoldenSourceId(binding);
      if (exposure.logicalSourceIdentity === expectedIdentity) return true;
    }
    if (binding.kind === "document") {
      return exposure.logicalSourceIdentity === documentBindingIdentity(binding);
    }
    if (binding.kind === "chat_message") {
      return exposure.logicalSourceIdentity === chatMessageEvidenceIdentity(binding.messageId);
    }
    if (binding.kind === "memory") {
      return exposure.logicalSourceIdentity === memoryEvidenceIdentity(binding.memoryId);
    }
    const source = fixtureById.get(evaluationBindingGoldenSourceId(binding));
    const canonicalUrl = canonicalizeWebUrl(binding.url);
    const liveQuoteIdentity = `web:${canonicalUrl}:`;
    const exposureUrl = webUrlFromExposureIdentity(exposure.logicalSourceIdentity);
    let exposureDomain: string | undefined;
    try {
      exposureDomain = new URL(exposureUrl).hostname;
    } catch {
      exposureDomain = undefined;
    }
    return (
      source?.kind === "web" &&
      (exposure.logicalSourceIdentity === canonicalUrl ||
        exposure.logicalSourceIdentity === webEvidenceIdentity(binding.url, source.content) ||
        (exposure.logicalSourceIdentity.startsWith(liveQuoteIdentity) &&
          /^[A-Za-z0-9_-]{43}$/u.test(
            exposure.logicalSourceIdentity.slice(liveQuoteIdentity.length),
          )) ||
        exposureDomain === binding.domain)
    );
  });
  if (matches.length > 1) {
    throw new Error(`${manifest.caseId} exposure maps to multiple canonical golden sources`);
  }
  const binding = matches[0];
  if (binding !== undefined) {
    const source = fixtureById.get(evaluationBindingGoldenSourceId(binding))!;
    const stage = exposure.exposureStage;
    let exact = false;
    if (stage.startsWith("evaluation_general_planner_")) {
      const expectedIdentity =
        binding.kind === "document"
          ? documentBindingIdentity(binding)
          : evaluationBindingGoldenSourceId(binding);
      exact = exactBaselineExposureMatches(
        expectedIdentity,
        binding?.kind === "document"
          ? (storedDocuments.get(evaluationBindingGoldenSourceId(binding))?.text ?? "")
          : source.content,
        exposure.contentItemIdentity,
      );
    } else if (binding.kind === "document") {
      const immutablePrefix = `${documentBindingIdentity(binding)}:${binding.documentVersionId}:`;
      const digest = exposure.contentItemIdentity.slice(immutablePrefix.length);
      const structurallyExact =
        exposure.contentItemIdentity.startsWith(immutablePrefix) &&
        /^[A-Za-z0-9_-]{43}$/u.test(digest);
      exact =
        structurallyExact &&
        (stage === "answer_serialized"
          ? validDocumentRangeIdentities(fixture, manifest, evidence, binding, storedDocuments).has(
              exposure.contentItemIdentity,
            )
          : stage === "internal_search_preview" ||
            stage === "internal_inspection" ||
            stage === "context_candidate_inspection");
    } else if (binding.kind === "chat_message") {
      exact = exposure.contentItemIdentity === binding.messageId;
    } else if (binding.kind === "memory") {
      exact = exposure.contentItemIdentity === binding.memoryRevisionId;
    } else if (source.kind === "web") {
      const url = canonicalizeWebUrl(webUrlFromExposureIdentity(exposure.logicalSourceIdentity));
      let exposureDomain: string | undefined;
      try {
        exposureDomain = new URL(url).hostname;
      } catch {
        exposureDomain = undefined;
      }
      const sameAllowedDomain = exposureDomain === binding.domain;
      const transientBodyPrefix = `${url}:`;
      const hasTransientBodyIdentity =
        exposure.contentItemIdentity.startsWith(transientBodyPrefix) &&
        /^[A-Za-z0-9_-]{43}$/u.test(exposure.contentItemIdentity.slice(transientBodyPrefix.length));
      const serializedQuoteHash = exposure.contentItemIdentity.startsWith(transientBodyPrefix)
        ? exposure.contentItemIdentity.slice(transientBodyPrefix.length)
        : null;
      exact =
        (stage === "web_search_preview" && sameAllowedDomain && hasTransientBodyIdentity) ||
        (stage === "web_fetch" && sameAllowedDomain && hasTransientBodyIdentity) ||
        ((stage === "answer_serialized" || stage === "context_candidate_inspection") &&
          /^web:https:\/\/.*:[A-Za-z0-9_-]{43}$/u.test(exposure.logicalSourceIdentity) &&
          serializedQuoteHash ===
            exposure.logicalSourceIdentity.slice(
              exposure.logicalSourceIdentity.lastIndexOf(":") + 1,
            ));
    }
    if (!exact) {
      throw new Error(
        `${manifest.caseId}/${evaluationBindingGoldenSourceId(binding)} has a stage-incompatible content-item identity`,
      );
    }
    return evaluationBindingGoldenSourceId(binding);
  }

  if (exposure.sourceKind === "web") {
    const liveIdentity = /^web:(https:\/\/.+):([A-Za-z0-9_-]{43})$/u.exec(
      exposure.logicalSourceIdentity,
    );
    if (liveIdentity !== null) {
      const url = canonicalizeWebUrl(liveIdentity[1]!);
      const expectedContentItemIdentity = `${url}:${liveIdentity[2]}`;
      if (
        (exposure.exposureStage === "answer_serialized" ||
          exposure.exposureStage === "context_candidate_inspection") &&
        exposure.contentItemIdentity === expectedContentItemIdentity
      ) {
        return null;
      }
      throw new Error(`${manifest.caseId} has an invalid live web citation identity`);
    }
    const url = canonicalizeWebUrl(exposure.logicalSourceIdentity);
    const transientBodyPrefix = `${url}:`;
    if (
      exposure.logicalSourceIdentity !== url ||
      !exposure.contentItemIdentity.startsWith(transientBodyPrefix) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(exposure.contentItemIdentity.slice(transientBodyPrefix.length))
    ) {
      throw new Error(`${manifest.caseId} has an invalid transient web exposure identity`);
    }
    return null;
  }

  throw new Error(
    `${manifest.caseId} has an unmapped ${exposure.sourceKind}/${exposure.exposureStage} source exposure (identity=${exposure.logicalSourceIdentity}; bindings=${manifest.sourceBindings
      .filter((binding) => binding.kind === exposure.sourceKind)
      .map((binding) =>
        binding.kind === "document"
          ? documentBindingIdentity(binding)
          : evaluationBindingGoldenSourceId(binding),
      )
      .join(",")})`,
  );
};

const exposedGoldenSourceIds = (
  manifest: EvaluationSeedManifest,
  evidence: DurableRunEvidence,
  storedDocuments: StoredEvaluationDocuments,
): readonly string[] => {
  attestExactSourceExposureRows(manifest, evidence, storedDocuments);
  const exposed = new Set(
    evidence.sourceExposures.flatMap((exposure) => {
      const sourceId = mapExposureToGolden(manifest, evidence, exposure, storedDocuments);
      return sourceId === null ? [] : [sourceId];
    }),
  );
  return fixtureFor(manifest.caseId)
    .evidence.filter((source) => exposed.has(source.sourceId))
    .map((source) => source.sourceId);
};

export const evaluationWebSourceAuthorized = (
  run: Pick<DurableRunEvidence["run"], "webSearchEnabled" | "effectiveWebPolicy">,
  url: string,
  currentPolicy: {
    readonly enabled: boolean;
    readonly allowedDomains: readonly string[] | null;
  },
): boolean => {
  if (!run.webSearchEnabled) return false;
  let host: string;
  try {
    host = new URL(url).hostname;
    const strictCurrent = EffectiveWebPolicySchema.parse(
      currentPolicy.enabled
        ? {
            enabled: true,
            provider: "tinyfish",
            allowedDomains: canonicalAllowedDomains(currentPolicy.allowedDomains),
          }
        : {
            enabled: false,
            reason: "company_disabled",
            allowlistActive: currentPolicy.allowedDomains !== null,
          },
    );
    const accepted = recheckWebPolicy(run.effectiveWebPolicy, strictCurrent);
    return hostMatchesAllowedDomain(host, accepted.allowedDomains);
  } catch {
    return false;
  }
};

const sourceAudit = async (
  connectionString: string,
  manifest: EvaluationSeedManifest,
  evidence: DurableRunEvidence,
  storedDocuments: StoredEvaluationDocuments,
): Promise<
  readonly {
    readonly sourceId: string;
    readonly authorized: boolean;
    readonly resolvable: boolean;
  }[]
> => {
  const fixture = fixtureFor(manifest.caseId);
  const exposedSourceIds = exposedGoldenSourceIds(manifest, evidence, storedDocuments);
  const sourceIds = new Set(
    evidence.sources.flatMap((source) => {
      const sourceId = mapDurableSource(manifest, source);
      return sourceId === undefined ? [] : [sourceId];
    }),
  );
  for (const observation of evidence.observations.filter(
    (candidate) => candidate.kind === "retrieval_manifest",
  )) {
    const references = Array.isArray(observation.payload.references)
      ? observation.payload.references
      : [];
    for (const reference of references) {
      if (reference === null || typeof reference !== "object") {
        throw new Error(`${manifest.caseId} has a malformed durable selector reference`);
      }
      const sourceId =
        observation.payload.selectorRole === "general_planner"
          ? mapBaselineReferenceToGolden(
              manifest,
              reference as Record<string, unknown>,
              storedDocuments,
            )
          : mapReferenceToGolden(manifest, reference as Record<string, unknown>);
      if (sourceId === undefined) {
        throw new Error(`${manifest.caseId} has an unmapped durable selector reference`);
      }
      sourceIds.add(sourceId);
    }
  }
  for (const sourceId of exposedSourceIds) sourceIds.add(sourceId);
  return Promise.all(
    fixture.evidence
      .filter((source) => sourceIds.has(source.sourceId))
      .map(({ sourceId }) => {
        const binding = manifest.sourceBindings.find(
          (candidate) => evaluationBindingGoldenSourceId(candidate) === sourceId,
        )!;
        return db(
          connectionString,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const rows = yield* sql<{
              readonly resolvable: boolean;
              readonly authorized: boolean;
              readonly currentWebEnabled: boolean;
              readonly currentWebAllowedDomains: readonly string[] | null;
            }>`
              select case ${binding.kind}::text
                when 'document' then case ${binding.kind === "document" && binding.source.kind === "publisher"}::boolean
                  when true then exists (
                    select 1
                    from brief_document_versions versions
                    join brief_documents documents on documents.id = versions.brief_document_id
                    join publisher_issues issues on issues.id = documents.issue_id
                    join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
                    join publisher_companies companies
                      on companies.id = subscriptions.publisher_company_id
                    where versions.id::text = ${binding.kind === "document" ? binding.documentVersionId : null}
                      and documents.id::text = ${binding.kind === "document" ? binding.documentId : null}
                      and issues.id::text = ${binding.kind === "document" && binding.source.kind === "publisher" ? binding.source.issueId : null}
                      and documents.id::text = ${binding.kind === "document" && binding.source.kind === "publisher" ? binding.source.documentId : null}
                      and ('publisher:' || subscriptions.id::text) = ${binding.kind === "document" ? binding.source.sourceId : null}
                      and versions.content_hash = ${binding.kind === "document" ? binding.contentHash : null}
                  )
                  else exists (
                    select 1 from public_source_documents documents
                    where documents.document_id = ${binding.kind === "document" ? binding.documentId : null}
                      and documents.document_id = ${binding.kind === "document" ? binding.documentVersionId : null}
                      and documents.source_id = ${binding.kind === "document" && binding.source.kind === "public" ? binding.source.sourceId.slice("public:".length) : null}
                      and ('public:' || documents.source_id) = ${binding.kind === "document" ? binding.source.sourceId : null}
                      and documents.content_hash = ${binding.kind === "document" ? binding.contentHash : null}
                  )
                end
                when 'chat_message' then exists (
                  select 1 from chat_messages where id = ${binding.kind === "chat_message" ? binding.messageId : null}
                )
                when 'memory' then exists (
                  select 1 from user_memory_revisions where id = ${binding.kind === "memory" ? binding.memoryRevisionId : null}
                )
                when 'web' then ${
                  binding.kind === "web" &&
                  fixture.evidence.find((item) => item.sourceId === sourceId)?.kind === "web"
                }::boolean
                else false end as resolvable,
              case ${binding.kind}::text
                when 'document' then case ${binding.kind === "document" && binding.source.kind === "publisher"}::boolean
                  when true then exists (
                    select 1
                    from chats chat
                    join client_companies client_company
                      on client_company.id = chat.company_id
                     and client_company.id = ${manifest.companyId}
                     and client_company.recovery_deleted_at is null
                     and client_company.purged_at is null
                    join client_company_memberships membership
                      on membership.company_id = chat.company_id
                     and membership.user_id = ${manifest.userId}
                     and membership.revoked_at is null
                    join platform_users users
                      on users.id = membership.user_id
                     and users.recovery_deleted_at is null
                     and users.purged_at is null
                    join chat_subscription_sources selected
                      on selected.chat_id = chat.id
                     and selected.client_company_id = chat.company_id
                    join client_subscription_accesses accesses
                      on accesses.id = selected.access_id
                     and accesses.client_company_id = selected.client_company_id
                     and accesses.subscription_id = selected.subscription_id
                     and accesses.state in ('active', 'ending', 'paused')
                    join client_employee_subscription_grants grants
                      on grants.access_id = accesses.id
                     and grants.client_company_id = accesses.client_company_id
                     and grants.user_id = ${manifest.userId}
                     and grants.revoked_at is null
                    join issue_deliveries deliveries
                      on deliveries.access_id = accesses.id
                     and deliveries.client_company_id = selected.client_company_id
                    join publisher_issues issues
                      on issues.id = deliveries.issue_id
                     and issues.subscription_id = selected.subscription_id
                     and issues.id::text = ${binding.kind === "document" && binding.source.kind === "publisher" ? binding.source.issueId : null}
                     and issues.status = 'published'
                     and issues.restricted_at is null
                     and issues.deleted_at is null
                    join publisher_subscriptions subscriptions
                      on subscriptions.id = issues.subscription_id
                    join publisher_companies publisher_company
                      on publisher_company.id = subscriptions.publisher_company_id
                    join brief_documents documents
                      on documents.issue_id = issues.id
                     and documents.id::text = ${binding.kind === "document" ? binding.documentId : null}
                     and documents.id::text = ${binding.kind === "document" && binding.source.kind === "publisher" ? binding.source.documentId : null}
                     and documents.deleted_at is null
                    join brief_document_versions versions
                      on versions.brief_document_id = documents.id
                     and versions.id::text = ${binding.kind === "document" ? binding.documentVersionId : null}
                     and versions.content_hash = ${binding.kind === "document" ? binding.contentHash : null}
                     and ('publisher:' || selected.subscription_id::text) = ${binding.kind === "document" ? binding.source.sourceId : null}
                    where chat.id = ${manifest.chatId}
                      and chat.deleted_at is null
                      and chat.user_id = ${manifest.userId}
                  )
                  else exists (
                    select 1 from public_source_documents documents
                    join client_company_public_source_settings settings
                      on settings.source_id = documents.source_id and settings.enabled
                    where documents.document_id = ${binding.kind === "document" ? binding.documentId : null}
                      and documents.document_id = ${binding.kind === "document" ? binding.documentVersionId : null}
                      and documents.source_id = ${binding.kind === "document" && binding.source.kind === "public" ? binding.source.sourceId.slice("public:".length) : null}
                      and ('public:' || documents.source_id) = ${binding.kind === "document" ? binding.source.sourceId : null}
                      and documents.content_hash = ${binding.kind === "document" ? binding.contentHash : null}
                      and settings.client_company_id = ${manifest.companyId}
                  )
                end
                when 'chat_message' then exists (
                  select 1 from chat_messages where id = ${binding.kind === "chat_message" ? binding.messageId : null}
                    and chat_id = ${manifest.chatId}
                )
                when 'memory' then exists (
                  select 1 from user_memories where id = ${binding.kind === "memory" ? binding.memoryId : null}
                    and user_id = ${manifest.userId} and deleted_at is null
                )
                when 'web' then false
                else false end as authorized,
              coalesce((
                select settings.web_search_enabled
                from client_company_ai_settings settings
                where settings.company_id = ${manifest.companyId}
              ), false) as "currentWebEnabled",
              (
                select settings.web_domain_allowlist
                from client_company_ai_settings settings
                where settings.company_id = ${manifest.companyId}
              ) as "currentWebAllowedDomains"
          `;
            const current = rows[0];
            return {
              sourceId,
              authorized:
                binding.kind === "web"
                  ? evaluationWebSourceAuthorized(evidence.run, binding.url, {
                      enabled: current?.currentWebEnabled === true,
                      allowedDomains: current?.currentWebAllowedDomains ?? null,
                    })
                  : current?.authorized === true,
              resolvable: current?.resolvable === true,
            };
          }),
        );
      }),
  );
};

interface TrustedPromptMeasurement {
  readonly requestId: string;
  readonly requestSha256Hex: string;
  readonly localInputTokens: number;
  readonly providerInputTokens: number;
  readonly gatePassed: boolean;
}

const ProviderAuthoredOutputObservationKinds = new Set([
  "conversation_resolution",
  "execution_plan",
  "retrieval_manifest",
  "context_reducer_terminal",
  "context_decision",
  "topic_packet",
  "memory_extraction_result",
]);

export const deriveTrustedPromptMeasurements = (
  topology: EvaluationTopology,
  caseId: string,
  usageRows: readonly DurableRunEvidence["usage"][number][],
  observations: readonly Pick<
    DurableRunEvidence["observations"][number],
    | "kind"
    | "emittingTask"
    | "loopIteration"
    | "attempt"
    | "observationKey"
    | "payload"
    | "createdAt"
  >[],
) => {
  if (usageRows.length === 0) throw new Error(`${topology}/${caseId} has no provider usage`);
  if (usageRows.some((usage) => usage.providerServiceId !== ZAI_CODING_PLAN_PROVIDER_SERVICE_ID)) {
    throw new Error(`${topology}/${caseId} contains non-Z.AI provider usage`);
  }
  const usageByCoordinate = new Map<string, DurableRunEvidence["usage"][number]>();
  for (const usage of usageRows) {
    const coordinate = [
      usage.taskId,
      usage.loopIteration,
      usage.attempt,
      usage.providerRequestIndex,
    ].join(":");
    if (usageByCoordinate.has(coordinate)) {
      throw new Error(`${topology}/${caseId} has duplicate provider usage coordinates`);
    }
    if (usage.totalTokens !== usage.inputTokens + usage.cachedTokens + usage.outputTokens) {
      throw new Error(`${topology}/${caseId} has inconsistent provider usage totals`);
    }
    usageByCoordinate.set(coordinate, usage);
  }
  const measurements = observations.filter(
    (observation) => observation.kind === "provider_request_measurement",
  );
  const seen = new Set<string>();
  const measurementByCoordinate = new Map<
    string,
    {
      readonly payload: z.infer<typeof ProviderRequestMeasurementSchema>;
    }
  >();
  const measurementsByExecution = new Map<
    string,
    Array<{
      readonly coordinate: string;
      readonly index: number;
      readonly emittingTask: string;
      readonly loopIteration: number;
      readonly attempt: number;
    }>
  >();
  for (const measurement of measurements) {
    const payload = ProviderRequestMeasurementSchema.parse(measurement.payload);
    if (
      payload.passed !== true ||
      payload.agentRole !== expectedAgentRoleForTask(topology, measurement.emittingTask) ||
      payload.modelId !== expectedModelForTask(measurement.emittingTask)
    ) {
      throw new Error(`${topology}/${caseId} has an invalid exact provider measurement`);
    }
    const index = payload.providerRequestIndex;
    const coordinate = [
      measurement.emittingTask,
      measurement.loopIteration,
      measurement.attempt,
      index,
    ].join(":");
    if (seen.has(coordinate)) {
      throw new Error(`${topology}/${caseId} has duplicate provider measurements`);
    }
    seen.add(coordinate);
    measurementByCoordinate.set(coordinate, { payload });
    const execution = [
      measurement.emittingTask,
      measurement.loopIteration,
      measurement.attempt,
    ].join(":");
    measurementsByExecution.set(execution, [
      ...(measurementsByExecution.get(execution) ?? []),
      {
        coordinate,
        index,
        emittingTask: measurement.emittingTask,
        loopIteration: measurement.loopIteration,
        attempt: measurement.attempt,
      },
    ]);
  }
  for (const [execution, entries] of measurementsByExecution) {
    const ordered = [...entries].sort((left, right) => left.index - right.index);
    if (ordered.some((entry, index) => entry.index !== index)) {
      throw new Error(`${topology}/${caseId}/${execution} has a non-contiguous measurement ledger`);
    }
    const unmatched = ordered.filter((entry) => !usageByCoordinate.has(entry.coordinate));
    if (
      unmatched.length > 1 ||
      (unmatched.length === 1 && unmatched[0]!.coordinate !== ordered.at(-1)!.coordinate)
    ) {
      throw new Error(`${topology}/${caseId}/${execution} has a non-terminal failed measurement`);
    }
    const terminalUnmatched = unmatched[0];
    if (
      terminalUnmatched !== undefined &&
      observations.some(
        (observation) =>
          observation.emittingTask === terminalUnmatched.emittingTask &&
          observation.loopIteration === terminalUnmatched.loopIteration &&
          observation.attempt === terminalUnmatched.attempt &&
          ProviderAuthoredOutputObservationKinds.has(observation.kind),
      )
    ) {
      throw new Error(
        `${topology}/${caseId}/${execution} has provider-authored output without provider usage`,
      );
    }
  }
  const result = usageRows.map((usage) => {
    const coordinate = [
      usage.taskId,
      usage.loopIteration,
      usage.attempt,
      usage.providerRequestIndex,
    ].join(":");
    const measurement = measurementByCoordinate.get(coordinate);
    if (measurement === undefined) {
      throw new Error(`${topology}/${caseId} usage lacks an exact provider measurement`);
    }
    const payload = measurement.payload;
    if (
      payload.modelId !== usage.modelId ||
      payload.agentRole !== usage.agentRole ||
      payload.passed !== true
    ) {
      throw new Error(`${topology}/${caseId} has an invalid exact provider measurement`);
    }
    return {
      requestId: coordinate,
      requestSha256Hex: payload.requestSha256Hex,
      localInputTokens: payload.inputTokens,
      providerInputTokens: usage.inputTokens + usage.cachedTokens,
      gatePassed: true,
    };
  });
  if (result.length !== usageRows.length) {
    throw new Error(`${topology}/${caseId} does not have one measurement per provider request`);
  }
  return result;
};

const commonCapturedResult = async (
  connectionString: string,
  row: CaseRunRow,
  annotations: EvaluationHumanAnnotations,
  annotationsSha256Hex: string,
) => {
  const fixture = fixtureFor(row.caseId);
  const manifest = EvaluationSeedManifestSchema.parse(row.seedManifest);
  await assertLiveEvaluationAuthorization(connectionString, manifest);
  const evidence = await loadDurableRunEvidence(connectionString, row.aiRunId);
  const storedDocuments = await loadStoredEvaluationDocuments(connectionString, manifest);
  const measurementFixture = fixtureWithStoredDocumentText(fixture, storedDocuments);
  const currentDigest = evaluationRunEvidenceDigest(row, evidence, storedDocuments);
  if (row.runEvidenceSha256Hex !== currentDigest)
    throw new Error(`${row.topology}/${row.caseId} evidence attestation mismatch`);
  if (
    evidence.usage.some((usage) => usage.providerServiceId !== ZAI_CODING_PLAN_PROVIDER_SERVICE_ID)
  ) {
    throw new Error(`${row.topology}/${row.caseId} contains non-Z.AI provider usage`);
  }
  const promptMeasurements = deriveTrustedPromptMeasurements(
    row.topology,
    row.caseId,
    evidence.usage,
    evidence.observations,
  );
  const sourceIdsByKey = new Map(
    evidence.sources.map((source) => [source.sourceKey, mapDurableSource(manifest, source)]),
  );
  if ([...sourceIdsByKey.values()].some((sourceId) => sourceId === undefined)) {
    throw new Error(`${row.topology}/${row.caseId} has a source outside its canonical fixture`);
  }
  const serializedSources = durableFinalSourceMapFromEvidence(evidence).filter(
    (source) => source.uses.length > 0,
  );
  const serializedSourceIds = serializedSources.map(
    (source) => sourceIdsByKey.get(source.sourceKey)!,
  );
  // A live web result may contribute multiple provider-authored excerpts from
  // one canonical fixture source. Preserve those distinct durable source keys
  // in production evidence, but measure the canonical artifact once per source
  // ID because the evaluation request schema is a set of source selections.
  const canonicalSerializedSourceIds = [...new Set(serializedSourceIds)];
  const serializedSourceGroups = new Map<string, typeof serializedSources>();
  for (const [index, sourceId] of serializedSourceIds.entries()) {
    const source = serializedSources[index]!;
    serializedSourceGroups.set(sourceId, [...(serializedSourceGroups.get(sourceId) ?? []), source]);
  }
  if (
    [...serializedSourceGroups.values()].some(
      (sources) => sources.length > 1 && sources.some((source) => source.locator.kind !== "web"),
    )
  ) {
    throw new Error(`${row.topology}/${row.caseId} serialized source order is not bijective`);
  }
  const citationObservations = evidence.observations.filter(
    (observation) => observation.kind === "citation",
  );
  const citationSourceIds = [
    ...new Set(
      citationObservations.map((observation) =>
        sourceIdsByKey.get(String(observation.payload.sourceKey)),
      ),
    ),
  ];
  if (citationSourceIds.some((sourceId) => sourceId === undefined)) {
    throw new Error(`${row.topology}/${row.caseId} cites an unmapped source`);
  }
  const firstAnswerEvent = evidence.events.find((event) => event.event.type === "answer_started");
  const firstDeltaEvent = evidence.events.find((event) => event.event.type === "text_delta");
  const terminalEvent = [...evidence.events].reverse().find((event) => event.event.type === "done");
  if (
    firstAnswerEvent === undefined ||
    firstDeltaEvent === undefined ||
    terminalEvent === undefined
  ) {
    throw new Error(`${row.topology}/${row.caseId} lacks durable timing events`);
  }
  const startedMs = Date.parse(evidence.run.startedAt);
  const finishedMs = Date.parse(evidence.run.finishedAt);
  const rangesBySource = new Map<string, EvaluationRange[]>();
  for (const use of evidence.sourceUses) {
    const sourceId = sourceIdsByKey.get(use.sourceKey)!;
    const current = rangesBySource.get(sourceId) ?? [];
    for (const range of use.ranges) {
      if (
        !current.some(
          (item) => item.charStart === range.charStart && item.charEnd === range.charEnd,
        )
      )
        current.push(range);
    }
    rangesBySource.set(sourceId, current);
  }
  const selections = canonicalSerializedSourceIds.map((sourceId) => {
    const source = fixture.evidence.find((candidate) => candidate.sourceId === sourceId)!;
    const ranges = rangesBySource.get(sourceId) ?? [];
    const documentLength =
      source.kind === "document"
        ? (storedDocuments.get(sourceId)?.text.length ??
          (() => {
            throw new Error(`${row.topology}/${row.caseId} document lacks current stored text`);
          })())
        : source.content.length;
    return {
      sourceId,
      ranges:
        source.kind === "document" && ranges.length > 0
          ? normalizeCharacterRanges(
              ranges
                .map((range) => ({
                  charStart: range.charStart,
                  charEnd: Math.min(range.charEnd, documentLength),
                }))
                .filter((range) => range.charEnd > range.charStart),
              documentLength,
            )
          : ranges,
    };
  });
  const serializedContextTokens = measureCanonicalEvaluationRequestTokens(
    measurementFixture,
    row.topology === "general_planner"
      ? canonicalSerializedSourceIds.map((sourceId) => ({
          sourceId,
          ranges:
            fixture.labels.acceptableRanges[sourceId] ??
            fixture.evidence.find((source) => source.sourceId === sourceId)?.ranges ??
            [],
        }))
      : selections,
  );
  const memorySourceById = new Map(
    manifest.sourceBindings.flatMap((binding) =>
      binding.kind === "memory" ? [[binding.memoryId, binding] as const] : [],
    ),
  );
  const memoryProposals = evidence.memoryWrites.map((write) => {
    const after = write.stateAfter;
    const original = memorySourceById.get(write.memoryId);
    return write.action === "create"
      ? {
          action: "create" as const,
          kind: String(after.kind) as "profile" | "preference" | "instruction" | "fact" | "episode",
          content: String(after.content),
          targetMemoryId: null,
          expectedHeadRevisionId: null,
        }
      : {
          action: "update" as const,
          kind: String(after.kind) as "profile" | "preference" | "instruction" | "fact" | "episode",
          content: String(after.content),
          targetMemoryId: original?.sourceId.split(":")[1] ?? write.memoryId,
          expectedHeadRevisionId: original?.sourceId.split(":")[2] ?? write.previousRevisionId,
        };
  });
  const aggregate = evidence.usage.reduce(
    (total, usage) => ({
      // Evaluation artifacts expose complete provider prompt tokens. Pi's
      // durable `inputTokens` excludes cache hits/writes, so fold the durable
      // cached bucket back in before comparing aggregate totals.
      inputTokens: total.inputTokens + usage.inputTokens + usage.cachedTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      totalTokens: total.totalTokens + usage.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
  return {
    fixture,
    manifest,
    evidence,
    selections,
    storedDocuments,
    common: {
      artifactVersion: 2 as const,
      goldenSetVersion: 2 as const,
      caseId: row.caseId,
      capture: {
        origin: "real_provider_turn" as const,
        runId: row.aiRunId,
        provider: "zai" as const,
        modelIds: [...new Set(evidence.usage.map((usage) => usage.modelId))] as (
          | "glm-5.2"
          | "glm-5-turbo"
        )[],
        startedAt: evidence.run.startedAt,
        finishedAt: evidence.run.finishedAt,
        attestation: {
          sessionId: row.sessionId,
          topology: row.topology,
          runEvidenceSha256Hex: currentDigest,
          annotationsSha256Hex,
          evaluationConfigSha256Hex: row.evaluationConfigSha256Hex!,
          providerEndpointIdentity: row.providerEndpointIdentity!,
        },
      },
      promptMeasurements,
      answer: {
        claims: annotations.claims,
        reportedGapIds: annotations.reportedGapIds,
        citationSourceIds: citationSourceIds as string[],
        rawCitationTagCount: citationObservations.length,
        citationDefectCount: evidence.observations.filter(
          (observation) => observation.kind === "citation_defect",
        ).length,
      },
      memoryProposals,
      pulledSourceIds: [] as string[],
      serializedSourceIds: canonicalSerializedSourceIds,
      serializedContextTokens,
      sourceAudit: await sourceAudit(connectionString, manifest, evidence, storedDocuments),
      timing: {
        timeToFirstTokenMs: Math.max(0, Date.parse(firstDeltaEvent.createdAt) - startedMs),
        timeToTerminalMs: Math.max(
          1,
          Math.min(finishedMs, Date.parse(terminalEvent.createdAt)) - startedMs,
        ),
      },
      usage: { providerRequestCount: evidence.usage.length, ...aggregate },
    },
  };
};

const loadAnnotations = (
  connectionString: string,
  row: CaseRunRow,
): Promise<{ readonly annotations: EvaluationHumanAnnotations; readonly digest: string }> =>
  db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{
        readonly annotations: unknown;
        readonly annotationsSha256Hex: string;
        readonly assistantOutputSha256Hex: string;
        readonly runEvidenceSha256Hex: string;
        readonly assistantContent: string;
      }>`
        select annotations.annotations,
               annotations.annotations_sha256_hex as "annotationsSha256Hex",
               annotations.assistant_output_sha256_hex as "assistantOutputSha256Hex",
               annotations.run_evidence_sha256_hex as "runEvidenceSha256Hex",
               messages.content as "assistantContent"
        from ai_evaluation_annotations annotations
        join ai_runs runs on runs.id = annotations.ai_run_id
        join chat_messages messages on messages.id = runs.assistant_message_id
        where annotations.session_id = ${row.sessionId}
          and annotations.case_id = ${row.caseId}
          and annotations.topology = ${row.topology}
      `;
      const value = rows[0];
      if (value === undefined)
        return yield* Effect.fail(
          new Error(`${row.topology}/${row.caseId} lacks bound annotations`),
        );
      const annotations = EvaluationHumanAnnotationsSchema.parse(value.annotations);
      if (canonicalSha256Hex(annotations) !== value.annotationsSha256Hex) {
        return yield* Effect.fail(
          new Error(`${row.topology}/${row.caseId} annotation digest mismatch`),
        );
      }
      if (
        value.runEvidenceSha256Hex !== row.runEvidenceSha256Hex ||
        sha256Hex(value.assistantContent) !== value.assistantOutputSha256Hex
      ) {
        return yield* Effect.fail(
          new Error(`${row.topology}/${row.caseId} annotation binding digest mismatch`),
        );
      }
      return { annotations, digest: value.annotationsSha256Hex };
    }),
  );

const observationOrder = (
  left: DurableRunEvidence["observations"][number],
  right: DurableRunEvidence["observations"][number],
): number =>
  left.loopIteration - right.loopIteration ||
  left.attempt - right.attempt ||
  Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
  left.observationKey.localeCompare(right.observationKey);

const latestObservation = (evidence: DurableRunEvidence, kind: string, emittingTask: string) =>
  evidence.observations
    .filter((observation) => observation.kind === kind && observation.emittingTask === emittingTask)
    .sort(observationOrder)
    .at(-1);

const productionCandidateSourceIds = (
  fixture: GoldenEvaluationCase,
  manifest: EvaluationSeedManifest,
  evidence: DurableRunEvidence,
): ReadonlyMap<string, string> => {
  const sourceById = new Map(fixture.evidence.map((source) => [source.sourceId, source] as const));
  const entries = manifest.sourceBindings.flatMap((binding) => {
    const source = sourceById.get(evaluationBindingGoldenSourceId(binding));
    if (source === undefined) throw new Error(`${manifest.caseId} has an unknown source binding`);
    const candidateId =
      binding.kind === "document"
        ? documentBindingIdentity(binding)
        : binding.kind === "chat_message"
          ? chatMessageEvidenceIdentity(binding.messageId)
          : binding.kind === "memory"
            ? memoryEvidenceIdentity(binding.memoryId)
            : webEvidenceIdentity(binding.url, source.content);
    const liveWebCandidateIds =
      binding.kind !== "web"
        ? []
        : evidence.sources.flatMap((candidate) => {
            const locator = DurableWebSourceLocatorSchema.safeParse(candidate.locator);
            return locator.success && locator.data.domain === binding.domain
              ? [webEvidenceIdentity(locator.data.url, locator.data.quote)]
              : [];
          });
    return [
      [candidateId, evaluationBindingGoldenSourceId(binding)] as const,
      ...liveWebCandidateIds.map(
        (liveCandidateId) => [liveCandidateId, evaluationBindingGoldenSourceId(binding)] as const,
      ),
    ];
  });
  const byCandidateId = new Map<string, string>();
  for (const [candidateId, sourceId] of entries) {
    const existingSourceId = byCandidateId.get(candidateId);
    if (existingSourceId !== undefined && existingSourceId !== sourceId) {
      throw new Error(`${manifest.caseId} production candidate identities collide`);
    }
    byCandidateId.set(candidateId, sourceId);
  }
  return byCandidateId;
};

const translateRestrictedConversation = (
  fixture: GoldenEvaluationCase,
  manifest: EvaluationSeedManifest,
  entries: readonly z.infer<typeof RestrictedConversationBindingSchema>[],
) => {
  const turnByRunId = new Map(
    manifest.turnBindings.map((binding) => [binding.aiRunId, binding] as const),
  );
  const translated = entries.map((entry) => {
    const binding = turnByRunId.get(entry.turnId);
    if (
      binding === undefined ||
      binding.userMessageId !== entry.userMessageId ||
      (entry.kind === "complete" && binding.assistantMessageId !== entry.assistantMessageId)
    ) {
      throw new Error(`${fixture.id} production conversation binding differs from the seeded turn`);
    }
    return entry.kind === "complete"
      ? {
          kind: "complete" as const,
          fixtureTurnId: binding.turnId,
          turnId: entry.turnId,
          userMessageId: entry.userMessageId,
          assistantMessageId: entry.assistantMessageId,
        }
      : {
          kind: "failed" as const,
          fixtureTurnId: binding.turnId,
          turnId: entry.turnId,
          userMessageId: entry.userMessageId,
          errorCode: entry.errorCode,
          retryable: entry.retryable,
        };
  });
  if (new Set(translated.map((entry) => entry.turnId)).size !== translated.length) {
    throw new Error(`${fixture.id} production conversation contains duplicate turns`);
  }
  return translated;
};

const attestCompleteConversationResolverInventory = (
  fixture: GoldenEvaluationCase,
  manifest: EvaluationSeedManifest,
  evidence: DurableRunEvidence,
  request: z.infer<typeof ConversationResolverRequestAttestationSchema>,
) => {
  if (
    evidence.conversationInventory.length !== manifest.turnBindings.length ||
    manifest.turnBindings.length !== fixture.conversation.length
  ) {
    throw new Error(`${fixture.id} durable conversation inventory is not complete`);
  }
  const complete = evidence.conversationInventory.map((entry, index) => {
    const binding = manifest.turnBindings[index];
    const golden = fixture.conversation[index];
    if (
      binding === undefined ||
      golden === undefined ||
      binding.turnId !== golden.turnId ||
      entry.turnId !== binding.aiRunId ||
      entry.userMessageId !== binding.userMessageId ||
      entry.userContent !== golden.userContent ||
      entry.assistantMessageId !== binding.assistantMessageId ||
      entry.assistantContent === null ||
      stripHistoricalCitationTags(entry.assistantContent) !== golden.assistantContent ||
      entry.errorCode !== null
    ) {
      throw new Error(`${fixture.id} durable conversation inventory differs from its seed`);
    }
    return {
      kind: "complete" as const,
      fixtureTurnId: binding.turnId,
      turnId: binding.aiRunId,
      userMessageId: binding.userMessageId,
      assistantMessageId: binding.assistantMessageId,
    };
  });
  const recent = complete.slice(-CanonicalEvaluationExecutionConfig.aiConversationRecentTurns);
  const bounded: typeof complete = [];
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const entry = recent[index];
    if (entry === undefined) continue;
    const candidate = [entry, ...bounded];
    const exact = attestExactConversationResolverRequest(fixture, candidate, request.currentDate);
    if (exact.inputTokens > exact.usableInputTokens) break;
    bounded.unshift(entry);
  }
  const boundary = latestObservation(evidence, "conversation_inventory_boundary", "load-turn");
  const counts = z
    .object({
      consideredCount: z.number().int().nonnegative(),
      includedCount: z.number().int().nonnegative(),
      countBoundaryExcludedCount: z.number().int().nonnegative(),
      tokenBoundaryExcludedCount: z.number().int().nonnegative(),
    })
    .strict()
    .parse(boundary?.payload);
  if (
    counts.consideredCount !== complete.length ||
    counts.includedCount !== bounded.length ||
    counts.countBoundaryExcludedCount !== complete.length - recent.length ||
    counts.tokenBoundaryExcludedCount !== recent.length - bounded.length
  ) {
    throw new Error(`${fixture.id} conversation inventory boundary is not exact`);
  }
  const supplied = translateRestrictedConversation(fixture, manifest, request.conversation);
  if (canonicalJson(supplied) !== canonicalJson(bounded)) {
    throw new Error(
      `${fixture.id} clarification conversation inventory is incomplete or out of order`,
    );
  }
  return bounded;
};

const translateAndAttestRestrictedLedger = (
  fixture: GoldenEvaluationCase,
  manifest: EvaluationSeedManifest,
  evidence: DurableRunEvidence,
  raw: unknown,
) => {
  const ledger = RestrictedContextLedgerSchema.parse(raw);
  const selectedConversation = translateRestrictedConversation(
    fixture,
    manifest,
    ledger.selectedConversation,
  );
  const sourceIdByCandidateId = productionCandidateSourceIds(fixture, manifest, evidence);
  const fixtureSourceById = new Map(
    fixture.evidence.map((source) => [source.sourceId, source] as const),
  );
  const sources =
    ledger.requestKind === "synthesis"
      ? []
      : ledger.sources.map((source) => {
          const sourceId = sourceIdByCandidateId.get(source.candidateId);
          const fixtureSource =
            sourceId === undefined ? undefined : fixtureSourceById.get(sourceId);
          if (sourceId === undefined || fixtureSource?.kind !== source.kind) {
            throw new Error(`${fixture.id} production ledger contains an unknown candidate`);
          }
          const liveLocator =
            source.kind === "web"
              ? evidence.sources
                  .map((candidate) => DurableWebSourceLocatorSchema.safeParse(candidate.locator))
                  .find(
                    (candidate) =>
                      candidate.success &&
                      webEvidenceIdentity(candidate.data.url, candidate.data.quote) ===
                        source.candidateId,
                  )
              : undefined;
          const contentOverride =
            liveLocator?.success === true ? liveLocator.data.quote : undefined;
          return {
            ...source,
            sourceId,
            ...(contentOverride === undefined ? {} : { contentOverride }),
          };
        });
  if (
    new Set(sources.map((source) => source.candidateId)).size !== sources.length ||
    new Set(sources.map((source) => source.sourceKey)).size !== sources.length ||
    new Set(selectedConversation.map((entry) => entry.turnId)).size !== selectedConversation.length
  ) {
    throw new Error(`${fixture.id} production ledger contains duplicate context identities`);
  }
  if (ledger.requestKind === "synthesis") {
    if (
      ledger.usableInputTokens !== canonicalEvaluationUsableInputTokens() ||
      new Set(ledger.packets.map((packet) => packet.topicId)).size !== ledger.packets.length
    ) {
      throw new Error(`${fixture.id} synthesis ledger has invalid bounds or packet identities`);
    }
    return { ...ledger, selectedConversation };
  }
  const exactInput: ExactProductionContextInput =
    ledger.requestKind === "topic"
      ? {
          requestKind: "topic",
          topicId: ledger.topicId,
          question: ledger.question,
          selectedConversation,
          gaps: ledger.gaps,
          sources,
          requestedOutputTokens: ledger.requestedOutputTokens,
        }
      : {
          requestKind: "direct",
          question: ledger.question,
          selectedConversation,
          gaps: ledger.gaps,
          sources,
          requestedOutputTokens: ledger.requestedOutputTokens,
        };
  const exact = attestExactProductionContext(fixture, exactInput);
  if (
    ledger.inputTokens !== exact.inputTokens ||
    ledger.requestSha256Hex !== exact.requestSha256Hex ||
    ledger.usableInputTokens !== canonicalEvaluationUsableInputTokens()
  ) {
    throw new Error(`${fixture.id} restricted production ledger differs from its exact request`);
  }
  return { ...ledger, selectedConversation, sources };
};

const usageCoordinateKey = (coordinate: {
  readonly taskId: string;
  readonly loopIteration: number;
  readonly attempt: number;
  readonly providerRequestIndex: number;
}): string =>
  [
    coordinate.taskId,
    coordinate.loopIteration,
    coordinate.attempt,
    coordinate.providerRequestIndex,
  ].join(":");

const providerCoordinateOrder = (
  left: {
    readonly loopIteration: number;
    readonly attempt: number;
    readonly providerRequestIndex: number;
  },
  right: {
    readonly loopIteration: number;
    readonly attempt: number;
    readonly providerRequestIndex: number;
  },
): number =>
  left.loopIteration - right.loopIteration ||
  left.attempt - right.attempt ||
  left.providerRequestIndex - right.providerRequestIndex;

const providerMeasurementsForTask = (
  evidence: DurableRunEvidence,
  taskId: string,
): ReadonlyArray<{
  readonly observation: DurableRunEvidence["observations"][number];
  readonly payload: z.infer<typeof ProviderRequestMeasurementSchema>;
  readonly taskId: string;
  readonly loopIteration: number;
  readonly attempt: number;
  readonly providerRequestIndex: number;
}> =>
  evidence.observations
    .filter(
      (observation) =>
        observation.kind === "provider_request_measurement" && observation.emittingTask === taskId,
    )
    .map((observation) => {
      const payload = ProviderRequestMeasurementSchema.parse(observation.payload);
      return {
        observation,
        payload,
        taskId: observation.emittingTask,
        loopIteration: observation.loopIteration,
        attempt: observation.attempt,
        providerRequestIndex: payload.providerRequestIndex,
      };
    })
    .sort(providerCoordinateOrder);

const isSuccessfulProviderStopReason = (stopReason: string): boolean =>
  stopReason === "stop" || stopReason === "length" || stopReason === "toolUse";

const providerPromptTokens = (usage: DurableRunEvidence["usage"][number]): number =>
  usage.inputTokens + usage.cachedTokens;

const specializedProviderAgentRoles = new Map<string, string>([
  ["resolve-conversation", "conversation_resolver"],
  ["plan-execution", "execution_planner"],
  ["single-retrieve-internal", "internal_retrieval"],
  ["single-select-memories", "memory_selector"],
  ["single-retrieve-web", "web_research"],
  ["single-reduce-plan", "context_reducer"],
  ["single-answer", "direct_answer"],
  ["topic-t1-retrieve-internal", "internal_retrieval"],
  ["topic-t1-select-memories", "memory_selector"],
  ["topic-t1-retrieve-web", "web_research"],
  ["topic-t1-reduce-plan", "context_reducer"],
  ["topic-t1-answer", "topic_answer"],
  ["topic-t2-retrieve-internal", "internal_retrieval"],
  ["topic-t2-select-memories", "memory_selector"],
  ["topic-t2-retrieve-web", "web_research"],
  ["topic-t2-reduce-plan", "context_reducer"],
  ["topic-t2-answer", "topic_answer"],
  ["topic-t3-retrieve-internal", "internal_retrieval"],
  ["topic-t3-select-memories", "memory_selector"],
  ["topic-t3-retrieve-web", "web_research"],
  ["topic-t3-reduce-plan", "context_reducer"],
  ["topic-t3-answer", "topic_answer"],
  ["fanout-synthesis", "synthesis"],
  ["memory-extract", "memory_extractor"],
]);

const generalPlannerProviderAgentRoles = new Map<string, string>([
  ["evaluation-general-planner", "evaluation_general_planner"],
]);

const providerAgentRolesByTopology: Readonly<
  Record<EvaluationTopology, ReadonlyMap<string, string>>
> = {
  specialized: specializedProviderAgentRoles,
  general_planner: generalPlannerProviderAgentRoles,
};

const specializedTopicAnswerTasks = new Set([
  "topic-t1-answer",
  "topic-t2-answer",
  "topic-t3-answer",
]);

const specializedReducerTasks = new Set([
  "single-reduce-plan",
  "topic-t1-reduce-plan",
  "topic-t2-reduce-plan",
  "topic-t3-reduce-plan",
]);

const specializedSelectorRoles = new Map<string, "internal" | "memory" | "web">([
  ["single-retrieve-internal", "internal"],
  ["single-select-memories", "memory"],
  ["single-retrieve-web", "web"],
  ["topic-t1-retrieve-internal", "internal"],
  ["topic-t1-select-memories", "memory"],
  ["topic-t1-retrieve-web", "web"],
  ["topic-t2-retrieve-internal", "internal"],
  ["topic-t2-select-memories", "memory"],
  ["topic-t2-retrieve-web", "web"],
  ["topic-t3-retrieve-internal", "internal"],
  ["topic-t3-select-memories", "memory"],
  ["topic-t3-retrieve-web", "web"],
]);

const isCanonicalSpecializedTopicAnswerTask = (taskId: string): boolean =>
  specializedTopicAnswerTasks.has(taskId);

const isCanonicalSpecializedReducerTask = (taskId: string): boolean =>
  specializedReducerTasks.has(taskId);

const expectedSelectorRoleForTask = (taskId: string): "internal" | "memory" | "web" => {
  const role = specializedSelectorRoles.get(taskId);
  if (role === undefined) throw new Error(`unknown canonical selector task ${taskId}`);
  return role;
};

const expectedAgentRoleForTask = (topology: EvaluationTopology, taskId: string): string => {
  const role = providerAgentRolesByTopology[topology].get(taskId);
  if (role === undefined) throw new Error(`unknown canonical provider task ${topology}/${taskId}`);
  return role;
};

const expectedModelForTask = (_taskId: string): "glm-5-turbo" => "glm-5-turbo";

const providerUsageForObservation = (
  row: CaseRunRow,
  evidence: DurableRunEvidence,
  observation: Pick<
    DurableRunEvidence["observations"][number],
    "emittingTask" | "loopIteration" | "attempt"
  >,
  options: { readonly allowNoUsage?: boolean } = {},
): DurableRunEvidence["usage"][number] | null => {
  const executionMeasurements = providerMeasurementsForTask(
    evidence,
    observation.emittingTask,
  ).filter(
    (measurement) =>
      measurement.loopIteration === observation.loopIteration &&
      measurement.attempt === observation.attempt,
  );
  const executionUsage = evidence.usage
    .filter(
      (usage) =>
        usage.taskId === observation.emittingTask &&
        usage.loopIteration === observation.loopIteration &&
        usage.attempt === observation.attempt,
    )
    .sort(usageCoordinateOrder);
  if (executionUsage.length === 0) {
    if (options.allowNoUsage === true && executionMeasurements.length === 0) return null;
    throw new Error(
      `${row.topology}/${row.caseId}/${observation.emittingTask} lacks terminal provider usage`,
    );
  }
  const terminal = executionUsage.at(-1)!;
  const measurements = executionMeasurements.filter(
    (candidate) => candidate.providerRequestIndex === terminal.providerRequestIndex,
  );
  const measurement = measurements[0];
  const latestMeasurement = executionMeasurements.at(-1);
  if (
    terminal.agentRole !== expectedAgentRoleForTask(row.topology, observation.emittingTask) ||
    terminal.modelId !== expectedModelForTask(observation.emittingTask) ||
    terminal.providerServiceId !== ZAI_CODING_PLAN_PROVIDER_SERVICE_ID ||
    !isSuccessfulProviderStopReason(terminal.stopReason) ||
    measurements.length !== 1 ||
    measurement === undefined ||
    latestMeasurement === undefined ||
    usageCoordinateKey(latestMeasurement) !== usageCoordinateKey(terminal) ||
    measurement.payload.agentRole !== terminal.agentRole ||
    measurement.payload.modelId !== terminal.modelId ||
    !measurement.payload.passed
  ) {
    throw new Error(
      `${row.topology}/${row.caseId}/${observation.emittingTask} output is not bound to its latest provider execution`,
    );
  }
  return terminal;
};

const terminalProviderUsage = (
  row: CaseRunRow,
  evidence: DurableRunEvidence,
  observation: Pick<
    DurableRunEvidence["observations"][number],
    "emittingTask" | "loopIteration" | "attempt"
  >,
  options: { readonly allowNoUsage?: boolean } = {},
): DurableRunEvidence["usage"][number] | null => {
  const bound = providerUsageForObservation(row, evidence, observation, options);
  const latestMeasurement = providerMeasurementsForTask(evidence, observation.emittingTask).at(-1);
  if (bound === null) {
    if (latestMeasurement !== undefined) {
      throw new Error(
        `${row.topology}/${row.caseId}/${observation.emittingTask} deterministic output has provider evidence`,
      );
    }
    return null;
  }
  const latest = evidence.usage
    .filter((usage) => usage.taskId === observation.emittingTask)
    .sort(usageCoordinateOrder)
    .at(-1);
  if (
    latest === undefined ||
    latestMeasurement === undefined ||
    usageCoordinateKey(latest) !== usageCoordinateKey(bound) ||
    usageCoordinateKey(latestMeasurement) !== usageCoordinateKey(bound)
  ) {
    throw new Error(
      `${row.topology}/${row.caseId}/${observation.emittingTask} output is not the latest provider execution`,
    );
  }
  return bound;
};

const externalToolUsageForObservation = (
  row: CaseRunRow,
  evidence: DurableRunEvidence,
  observation: Pick<
    DurableRunEvidence["observations"][number],
    "emittingTask" | "loopIteration" | "attempt"
  >,
  required: boolean,
): readonly DurableRunEvidence["externalToolUsage"][number][] => {
  const executionUsage = evidence.externalToolUsage.filter(
    (usage) =>
      usage.taskId === observation.emittingTask &&
      usage.loopIteration === observation.loopIteration &&
      usage.attempt === observation.attempt,
  );
  if (executionUsage.length === 0) {
    if (!required) return [];
    throw new Error(
      `${row.topology}/${row.caseId}/${observation.emittingTask} lacks terminal external-tool usage`,
    );
  }
  if (executionUsage.some((usage) => usage.status === "failed")) {
    throw new Error(
      `${row.topology}/${row.caseId}/${observation.emittingTask} output is not bound to its latest external-tool execution`,
    );
  }
  return executionUsage;
};

const terminalExternalToolUsage = (
  row: CaseRunRow,
  evidence: DurableRunEvidence,
  observation: Pick<
    DurableRunEvidence["observations"][number],
    "emittingTask" | "loopIteration" | "attempt"
  >,
  required: boolean,
): readonly DurableRunEvidence["externalToolUsage"][number][] => {
  const bound = externalToolUsageForObservation(row, evidence, observation, required);
  if (bound.length === 0) return bound;
  const latest = evidence.externalToolUsage
    .filter((usage) => usage.taskId === observation.emittingTask)
    .at(-1)!;
  if (
    latest.loopIteration !== observation.loopIteration ||
    latest.attempt !== observation.attempt
  ) {
    throw new Error(
      `${row.topology}/${row.caseId}/${observation.emittingTask} output is not the latest external-tool execution`,
    );
  }
  return bound;
};

const ContextReducerTerminalSchema = z
  .object({
    terminalUsageCoordinate: TerminalUsageCoordinateSchema,
    modelId: z.literal("glm-5-turbo"),
    requestSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
    providerInputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    stopReason: z.string().min(1),
  })
  .strict();

const terminalProductionLedger = (
  fixture: GoldenEvaluationCase,
  manifest: EvaluationSeedManifest,
  evidence: DurableRunEvidence,
  promptMeasurements: readonly TrustedPromptMeasurement[],
  taskId: string,
) => {
  const observations = evidence.observations
    .filter(
      (candidate) => candidate.kind === "context_serialized" && candidate.emittingTask === taskId,
    )
    .sort(observationOrder);
  const observation = observations.at(-1);
  if (observation === undefined) throw new Error(`${fixture.id}/${taskId} lacks a terminal ledger`);
  if (
    observations.filter(
      (candidate) =>
        candidate.loopIteration === observation.loopIteration &&
        candidate.attempt === observation.attempt,
    ).length !== 1
  ) {
    throw new Error(`${fixture.id}/${taskId} has duplicate terminal serialized outputs`);
  }
  for (const candidate of observations) {
    const candidatePayload = TerminalContextSerializedPayloadSchema.parse(candidate.payload);
    const executionUsage = evidence.usage
      .filter(
        (usage) =>
          usage.taskId === taskId &&
          usage.loopIteration === candidate.loopIteration &&
          usage.attempt === candidate.attempt,
      )
      .at(-1);
    const executionMeasurement = providerMeasurementsForTask(evidence, taskId)
      .filter(
        (measurement) =>
          measurement.loopIteration === candidate.loopIteration &&
          measurement.attempt === candidate.attempt,
      )
      .at(-1);
    if (executionUsage === undefined) {
      // A provider call may time out after passing the exact gate and before
      // returning usage. deriveTrustedPromptMeasurements already admits that
      // one terminal measurement-only failure shape; the serialized context
      // produced before that call must follow the same bounded rule.
      if (
        candidatePayload.consumerTaskId !== taskId ||
        candidatePayload.terminalUsageCoordinate.taskId !== taskId ||
        candidatePayload.terminalUsageCoordinate.loopIteration !== candidate.loopIteration ||
        candidatePayload.terminalUsageCoordinate.attempt !== candidate.attempt ||
        executionMeasurement === undefined ||
        usageCoordinateKey(executionMeasurement) !==
          usageCoordinateKey(candidatePayload.terminalUsageCoordinate)
      ) {
        throw new Error(`${fixture.id}/${taskId} has an unbound serialized retry output`);
      }
      continue;
    }
    if (
      candidatePayload.consumerTaskId !== taskId ||
      candidatePayload.terminalUsageCoordinate.taskId !== taskId ||
      candidatePayload.terminalUsageCoordinate.loopIteration !== candidate.loopIteration ||
      candidatePayload.terminalUsageCoordinate.attempt !== candidate.attempt ||
      executionUsage === undefined ||
      executionMeasurement === undefined ||
      usageCoordinateKey(executionUsage) !==
        usageCoordinateKey(candidatePayload.terminalUsageCoordinate) ||
      usageCoordinateKey(executionMeasurement) !==
        usageCoordinateKey(candidatePayload.terminalUsageCoordinate) ||
      executionUsage.agentRole !== expectedAgentRoleForTask("specialized", taskId) ||
      executionUsage.modelId !== expectedModelForTask(taskId) ||
      executionUsage.providerServiceId !== ZAI_CODING_PLAN_PROVIDER_SERVICE_ID ||
      !isSuccessfulProviderStopReason(executionUsage.stopReason) ||
      !promptMeasurements.some(
        (measurement) => measurement.requestId === usageCoordinateKey(executionUsage),
      )
    ) {
      throw new Error(`${fixture.id}/${taskId} has an unbound serialized retry output`);
    }
  }
  const payload = TerminalContextSerializedPayloadSchema.parse(observation.payload);
  const coordinate = payload.terminalUsageCoordinate;
  if (
    coordinate.taskId !== taskId ||
    coordinate.loopIteration !== observation.loopIteration ||
    coordinate.attempt !== observation.attempt
  ) {
    throw new Error(`${fixture.id}/${taskId} terminal ledger has foreign usage coordinates`);
  }
  const usage = evidence.usage.find(
    (candidate) => usageCoordinateKey(candidate) === usageCoordinateKey(coordinate),
  );
  const latestUsage = evidence.usage.filter((candidate) => candidate.taskId === taskId).at(-1);
  const latestMeasurement = providerMeasurementsForTask(evidence, taskId).at(-1);
  const measurement = promptMeasurements.find(
    (candidate) => candidate.requestId === usageCoordinateKey(coordinate),
  );
  const ledger = translateAndAttestRestrictedLedger(
    fixture,
    manifest,
    evidence,
    payload.restrictedContextLedger,
  );
  if (
    usage === undefined ||
    latestUsage === undefined ||
    latestMeasurement === undefined ||
    usageCoordinateKey(latestUsage) !== usageCoordinateKey(coordinate) ||
    usageCoordinateKey(latestMeasurement) !== usageCoordinateKey(coordinate) ||
    usage.agentRole !== expectedAgentRoleForTask("specialized", taskId) ||
    usage.providerServiceId !== ZAI_CODING_PLAN_PROVIDER_SERVICE_ID ||
    !isSuccessfulProviderStopReason(usage.stopReason) ||
    usage.modelId !== ledger.modelId ||
    providerPromptTokens(usage) !== ledger.inputTokens ||
    measurement?.requestSha256Hex !== ledger.requestSha256Hex ||
    measurement?.localInputTokens !== ledger.inputTokens ||
    measurement.providerInputTokens !== ledger.inputTokens ||
    !measurement.gatePassed
  ) {
    throw new Error(`${fixture.id}/${taskId} terminal ledger lacks exact real-provider usage`);
  }
  return {
    ledger,
    terminalUsageCoordinate: coordinate,
    providerInputTokens: providerPromptTokens(usage),
  };
};

const exactInputForTranslatedLedger = (
  ledger: Exclude<
    ReturnType<typeof translateAndAttestRestrictedLedger>,
    { readonly requestKind: "synthesis" }
  >,
): Exclude<ExactProductionContextInput, { readonly requestKind: "synthesis" }> =>
  ledger.requestKind === "topic"
    ? {
        requestKind: "topic",
        topicId: ledger.topicId,
        question: ledger.question,
        selectedConversation: ledger.selectedConversation,
        gaps: ledger.gaps,
        sources: ledger.sources,
        requestedOutputTokens: ledger.requestedOutputTokens,
      }
    : {
        requestKind: "direct",
        question: ledger.question,
        selectedConversation: ledger.selectedConversation,
        gaps: ledger.gaps,
        sources: ledger.sources,
        requestedOutputTokens: ledger.requestedOutputTokens,
      };

const compareExactSourceUses = (
  row: CaseRunRow,
  evidence: DurableRunEvidence,
  expected: readonly Omit<DurableRunEvidence["sourceUses"][number], "createdAt">[],
): void => {
  const order = (
    left: { readonly sourceKey: string; readonly consumerTaskId: string },
    right: {
      readonly sourceKey: string;
      readonly consumerTaskId: string;
    },
  ) =>
    compareSourceKeys(left.sourceKey, right.sourceKey) ||
    left.consumerTaskId.localeCompare(right.consumerTaskId);
  const actual = evidence.sourceUses.map(({ createdAt: _createdAt, ...use }) => use).sort(order);
  if (canonicalJson(actual) !== canonicalJson([...expected].sort(order))) {
    throw new Error(`${row.topology}/${row.caseId} durable source uses are not exact`);
  }
};

const expectedTerminalContextEvidence = (
  row: CaseRunRow,
  evidence: DurableRunEvidence,
  manifest: EvaluationSeedManifest,
  fixture: GoldenEvaluationCase,
): {
  readonly mode: "clarification" | "single" | "synthesis";
  readonly reductionRan: boolean;
  readonly sourcesRead: readonly ReturnType<typeof publicSourceRecordFromFinalSource>[];
  readonly consumers: readonly PublicContextConsumer[];
} => {
  const durableSourceMap = durableFinalSourceMapFromEvidence(evidence);
  if (row.topology === "general_planner") {
    const output = GeneralPlannerProviderOutputSchema.parse(row.executionOutput);
    if (output.resolution.mode === "clarify") {
      compareExactSourceUses(row, evidence, []);
      if (durableSourceMap.length !== 0) {
        throw new Error(`${row.topology}/${row.caseId} clarification has durable sources`);
      }
      return { mode: "clarification", reductionRan: false, sourcesRead: [], consumers: [] };
    }
    const model = resolveRegisteredModel("glm-5-turbo");
    const expectedUses = output.selectedSources.map((selection, index) => {
      const source = fixture.evidence.find(
        (candidate) => candidate.sourceId === selection.sourceId,
      );
      const rawDurableSource = evidence.sources.find(
        (candidate) => mapDurableSource(manifest, candidate) === selection.sourceId,
      );
      const durableSource = durableSourceMap.find(
        (candidate) => candidate.sourceKey === rawDurableSource?.sourceKey,
      );
      if (source === undefined || durableSource === undefined) {
        throw new Error(`${row.topology}/${row.caseId} baseline source order is incomplete`);
      }
      const selectedText =
        source.kind === "document" && selection.ranges.length > 0
          ? selection.ranges
              .map((range) => source.content.slice(range.charStart, range.charEnd))
              .join("\n…\n")
          : source.content;
      return {
        sourceKey: durableSource.sourceKey,
        consumerTaskId: "single-answer",
        topicId: null,
        renderedTokenCount: model.countTextTokens(selectedText),
        contextOrder: index,
        ranges: selection.ranges,
      };
    });
    compareExactSourceUses(row, evidence, expectedUses);
    return {
      mode: "single",
      reductionRan: false,
      sourcesRead: durableSourceMap.map(publicSourceRecordFromFinalSource),
      consumers: [
        {
          consumer: "direct",
          inputTokens: measureCanonicalEvaluationRequestTokens(fixture, output.selectedSources),
          requestedOutputTokens: CanonicalEvaluationExecutionConfig.aiMainOutputMaxTokens,
          usableInputTokens: canonicalEvaluationUsableInputTokens(),
        },
      ],
    };
  }

  const promptMeasurements = deriveTrustedPromptMeasurements(
    row.topology,
    row.caseId,
    evidence.usage,
    evidence.observations,
  );
  const serializedTasks = new Set(
    evidence.observations
      .filter((observation) => observation.kind === "context_serialized")
      .map((observation) => observation.emittingTask),
  );
  const hasSingle = serializedTasks.has("single-answer");
  const hasSynthesis = serializedTasks.has("fanout-synthesis");
  if (hasSingle && hasSynthesis) {
    throw new Error(`${row.topology}/${row.caseId} has conflicting terminal context routes`);
  }
  if (!hasSingle && !hasSynthesis) {
    compareExactSourceUses(row, evidence, []);
    if (durableSourceMap.length !== 0) {
      throw new Error(`${row.topology}/${row.caseId} clarification has durable sources`);
    }
    return { mode: "clarification", reductionRan: false, sourcesRead: [], consumers: [] };
  }
  const expectedUses: Array<Omit<DurableRunEvidence["sourceUses"][number], "createdAt">> = [];
  const consumers: PublicContextConsumer[] = [];
  if (hasSingle) {
    const terminal = terminalProductionLedger(
      fixture,
      manifest,
      evidence,
      promptMeasurements,
      "single-answer",
    );
    if (terminal.ledger.requestKind !== "direct") {
      throw new Error(`${row.topology}/${row.caseId} single route has a non-direct ledger`);
    }
    const exact = measureExactProductionContextMarginals(
      fixture,
      exactInputForTranslatedLedger(terminal.ledger),
    );
    terminal.ledger.sources.forEach((source, index) => {
      expectedUses.push({
        sourceKey: source.sourceKey,
        consumerTaskId: "single-answer",
        topicId: null,
        renderedTokenCount: exact.sourceTokenCounts[index] ?? -1,
        contextOrder: index,
        ranges: source.ranges,
      });
    });
    compareExactSourceUses(row, evidence, expectedUses);
    const initial = initialProductionLedger(fixture, manifest, evidence, "single-measure");
    return {
      mode: "single",
      reductionRan: initial.ledger.inputTokens > initial.ledger.usableInputTokens,
      sourcesRead: durableSourceMap.map(publicSourceRecordFromFinalSource),
      consumers: [
        {
          consumer: "direct",
          inputTokens: terminal.ledger.inputTokens,
          requestedOutputTokens: terminal.ledger.requestedOutputTokens,
          usableInputTokens: terminal.ledger.usableInputTokens,
        },
      ],
    };
  }
  const topicTasks = [...serializedTasks].filter(isCanonicalSpecializedTopicAnswerTask).sort();
  const expectedTopicTasks = (["t1", "t2", "t3"] as const)
    .slice(0, topicTasks.length)
    .map((topicId) => `topic-${topicId}-answer`);
  if (
    topicTasks.length < 2 ||
    topicTasks.length > 3 ||
    canonicalJson(topicTasks) !== canonicalJson(expectedTopicTasks)
  ) {
    throw new Error(`${row.topology}/${row.caseId} fanout topic ledger set is invalid`);
  }
  for (const taskId of topicTasks) {
    const terminal = terminalProductionLedger(
      fixture,
      manifest,
      evidence,
      promptMeasurements,
      taskId,
    );
    if (terminal.ledger.requestKind !== "topic") {
      throw new Error(`${row.topology}/${row.caseId}/${taskId} lacks a topic ledger`);
    }
    const topicLedger = terminal.ledger;
    const exact = measureExactProductionContextMarginals(
      fixture,
      exactInputForTranslatedLedger(topicLedger),
    );
    topicLedger.sources.forEach((source, index) => {
      expectedUses.push({
        sourceKey: source.sourceKey,
        consumerTaskId: taskId,
        topicId: topicLedger.topicId,
        renderedTokenCount: exact.sourceTokenCounts[index] ?? -1,
        contextOrder: index,
        ranges: source.ranges,
      });
    });
    consumers.push({
      consumer: "topic",
      topicId: topicLedger.topicId,
      inputTokens: topicLedger.inputTokens,
      requestedOutputTokens: topicLedger.requestedOutputTokens,
      usableInputTokens: topicLedger.usableInputTokens,
    });
  }
  const synthesis = terminalProductionLedger(
    fixture,
    manifest,
    evidence,
    promptMeasurements,
    "fanout-synthesis",
  );
  if (synthesis.ledger.requestKind !== "synthesis") {
    throw new Error(`${row.topology}/${row.caseId} lacks a synthesis ledger`);
  }
  consumers.push({
    consumer: "synthesis",
    inputTokens: synthesis.ledger.inputTokens,
    requestedOutputTokens: synthesis.ledger.requestedOutputTokens,
    usableInputTokens: synthesis.ledger.usableInputTokens,
  });
  compareExactSourceUses(row, evidence, expectedUses);
  return {
    mode: "synthesis",
    reductionRan: false,
    sourcesRead: durableSourceMap.map(publicSourceRecordFromFinalSource),
    consumers,
  };
};

const terminalOwnedObservation = (
  row: CaseRunRow,
  evidence: DurableRunEvidence,
  kind: "conversation_resolution" | "execution_plan",
  expectedOwner: string,
) => {
  const observations = evidence.observations
    .filter((observation) => observation.kind === kind)
    .sort(observationOrder);
  if (
    observations.length === 0 ||
    observations.some((observation) => observation.emittingTask !== expectedOwner)
  ) {
    throw new Error(`${row.topology}/${row.caseId} ${kind} ownership is invalid`);
  }
  const terminal = observations.at(-1)!;
  if (
    observations.filter(
      (observation) =>
        observation.loopIteration === terminal.loopIteration &&
        observation.attempt === terminal.attempt,
    ).length !== 1
  ) {
    throw new Error(`${row.topology}/${row.caseId} has duplicate terminal ${kind} output`);
  }
  return terminal;
};

const canonicalResolutionAndPlan = (
  row: CaseRunRow,
  evidence: DurableRunEvidence,
  manifest: EvaluationSeedManifest,
): {
  readonly resolution: z.infer<typeof DurableConversationResolutionSchema>;
  readonly plan: z.infer<typeof DurableExecutionPlanSchema> | null;
} => {
  const resolutionOwner =
    row.topology === "general_planner" ? "evaluation-general-planner" : "resolve-conversation";
  const resolutionObservation = terminalOwnedObservation(
    row,
    evidence,
    "conversation_resolution",
    resolutionOwner,
  );
  const resolution = DurableConversationResolutionSchema.parse(resolutionObservation.payload);
  const resolutionObservations = evidence.observations.filter(
    (observation) => observation.kind === "conversation_resolution",
  );
  for (const observation of resolutionObservations) {
    providerUsageForObservation(row, evidence, observation, {
      allowNoUsage: row.topology === "specialized" && manifest.turnBindings.length === 0,
    });
  }
  const resolutionUsage = terminalProviderUsage(row, evidence, resolutionObservation, {
    allowNoUsage: row.topology === "specialized" && manifest.turnBindings.length === 0,
  });
  const allowedTurns = new Set(manifest.turnBindings.map((binding) => binding.aiRunId));
  if (
    resolution.mode === "continue" &&
    (new Set(resolution.selectedTurnIds).size !== resolution.selectedTurnIds.length ||
      resolution.selectedTurnIds.some((turnId) => !allowedTurns.has(turnId)))
  ) {
    throw new Error(`${row.topology}/${row.caseId} resolution selects a foreign turn`);
  }
  if (row.topology === "general_planner") {
    const output = GeneralPlannerProviderOutputSchema.parse(row.executionOutput);
    const turnIds = new Map(
      manifest.turnBindings.map((binding) => [binding.turnId, binding.aiRunId] as const),
    );
    const expectedResolution =
      output.resolution.mode === "clarify"
        ? output.resolution
        : {
            mode: "continue" as const,
            retrievalQuestion: output.resolution.retrievalQuestion,
            selectedTurnIds: output.resolution.selectedTurnIds.map((turnId) => turnIds.get(turnId)),
          };
    if (canonicalJson(resolution) !== canonicalJson(expectedResolution)) {
      throw new Error(`${row.topology}/${row.caseId} resolution differs from provider output`);
    }
  } else {
    if (
      resolutionUsage === null &&
      (resolutionObservations.length !== 1 ||
        resolution.mode !== "continue" ||
        resolution.retrievalQuestion !== fixtureFor(row.caseId).currentMessage ||
        resolution.selectedTurnIds.length !== 0)
    ) {
      throw new Error(`${row.topology}/${row.caseId} deterministic resolution is not exact`);
    }
    const attestations = evidence.observations
      .filter(
        (observation) =>
          observation.kind === "provider_request_attestation" &&
          observation.emittingTask === "resolve-conversation",
      )
      .sort(observationOrder);
    const terminalAttestation = attestations.at(-1);
    if (
      terminalAttestation !== undefined &&
      (terminalAttestation.loopIteration !== resolutionObservation.loopIteration ||
        terminalAttestation.attempt !== resolutionObservation.attempt)
    ) {
      throw new Error(`${row.topology}/${row.caseId} resolution output/request attempts differ`);
    }
  }
  const planObservations = evidence.observations.filter(
    (observation) => observation.kind === "execution_plan",
  );
  if (resolution.mode === "clarify") {
    if (planObservations.length !== 0) {
      throw new Error(`${row.topology}/${row.caseId} clarification has an execution plan`);
    }
    return { resolution, plan: null };
  }
  const planOwner =
    row.topology === "general_planner" ? "evaluation-general-planner" : "plan-execution";
  const planObservation = terminalOwnedObservation(row, evidence, "execution_plan", planOwner);
  const plan = DurableExecutionPlanSchema.parse(planObservation.payload);
  for (const observation of planObservations) {
    providerUsageForObservation(row, evidence, observation);
  }
  terminalProviderUsage(row, evidence, planObservation);
  if (plan.mode === "fanout") {
    const expectedTopicIds = (["t1", "t2", "t3"] as const).slice(0, plan.topics.length);
    if (
      canonicalJson(plan.topics.map((topic) => topic.topicId)) !==
        canonicalJson(expectedTopicIds) ||
      plan.topics.some(
        (topic) =>
          new Set(topic.relevantTurnIds).size !== topic.relevantTurnIds.length ||
          topic.relevantTurnIds.some((turnId) => !resolution.selectedTurnIds.includes(turnId)),
      )
    ) {
      throw new Error(`${row.topology}/${row.caseId} execution plan topology is invalid`);
    }
  }
  if (row.topology === "general_planner" && plan.mode !== "single") {
    throw new Error(`${row.topology}/${row.caseId} baseline cannot fan out`);
  }
  if (row.topology === "specialized") {
    const fixture = fixtureFor(row.caseId);
    const measurements = deriveTrustedPromptMeasurements(
      row.topology,
      row.caseId,
      evidence.usage,
      evidence.observations,
    );
    if (plan.mode === "single") {
      const terminal = terminalProductionLedger(
        fixture,
        manifest,
        evidence,
        measurements,
        "single-answer",
      );
      if (
        terminal.ledger.requestKind !== "direct" ||
        terminal.ledger.question !== resolution.retrievalQuestion ||
        canonicalJson(terminal.ledger.selectedConversation.map((entry) => entry.turnId)) !==
          canonicalJson(resolution.selectedTurnIds)
      ) {
        throw new Error(`${row.topology}/${row.caseId} single ledger differs from routing outputs`);
      }
    } else {
      for (const topic of plan.topics) {
        const terminal = terminalProductionLedger(
          fixture,
          manifest,
          evidence,
          measurements,
          `topic-${topic.topicId}-answer`,
        );
        if (
          terminal.ledger.requestKind !== "topic" ||
          terminal.ledger.topicId !== topic.topicId ||
          terminal.ledger.question !== topic.question ||
          canonicalJson(terminal.ledger.selectedConversation.map((entry) => entry.turnId)) !==
            canonicalJson(topic.relevantTurnIds)
        ) {
          throw new Error(
            `${row.topology}/${row.caseId}/${topic.topicId} ledger differs from routing outputs`,
          );
        }
      }
      const synthesis = terminalProductionLedger(
        fixture,
        manifest,
        evidence,
        measurements,
        "fanout-synthesis",
      );
      if (
        synthesis.ledger.requestKind !== "synthesis" ||
        canonicalJson(synthesis.ledger.packets.map((packet) => packet.topicId)) !==
          canonicalJson(plan.topics.map((topic) => topic.topicId))
      ) {
        throw new Error(`${row.topology}/${row.caseId} synthesis differs from execution plan`);
      }
    }
  }
  return { resolution, plan };
};

interface AttestedTerminalManifest {
  readonly taskId: string;
  readonly selectorRole: "internal" | "memory" | "web";
  readonly observation: DurableRunEvidence["observations"][number];
  readonly references: readonly {
    readonly sourceId: string;
    readonly candidateId: string;
    readonly ranges: readonly EvaluationRange[];
  }[];
}

const terminalRetrievalManifests = (
  row: CaseRunRow,
  evidence: DurableRunEvidence,
  manifest: EvaluationSeedManifest,
  storedDocuments: StoredEvaluationDocuments,
): readonly AttestedTerminalManifest[] => {
  if (row.topology !== "specialized") return [];
  const routing = canonicalResolutionAndPlan(row, evidence, manifest);
  const manifests = evidence.observations.filter(
    (observation) => observation.kind === "retrieval_manifest",
  );
  if (routing.resolution.mode === "clarify") {
    if (manifests.length !== 0) {
      throw new Error(`${row.topology}/${row.caseId} clarification has retrieval manifests`);
    }
    return [];
  }
  const fixture = fixtureFor(row.caseId);
  const contexts =
    routing.plan?.mode === "fanout"
      ? routing.plan.topics.map((topic) => ({
          prefix: `topic-${topic.topicId}`,
          ledger: initialProductionLedger(
            fixture,
            manifest,
            evidence,
            `topic-${topic.topicId}-measure`,
          ).ledger,
        }))
      : [
          {
            prefix: "single",
            ledger: initialProductionLedger(fixture, manifest, evidence, "single-measure").ledger,
          },
        ];
  const expectedTasks = new Set(
    contexts.flatMap(({ prefix }) => [
      `${prefix}-retrieve-internal`,
      `${prefix}-select-memories`,
      `${prefix}-retrieve-web`,
    ]),
  );
  if (manifests.some((observation) => !expectedTasks.has(observation.emittingTask))) {
    throw new Error(`${row.topology}/${row.caseId} retrieval manifest has a foreign owner`);
  }
  const result: AttestedTerminalManifest[] = [];
  for (const { prefix, ledger } of contexts) {
    if (ledger.requestKind === "synthesis") {
      throw new Error(`${row.topology}/${row.caseId} retrieval context cannot be synthesis`);
    }
    for (const taskId of [
      `${prefix}-retrieve-internal`,
      `${prefix}-select-memories`,
      `${prefix}-retrieve-web`,
    ]) {
      const owned = manifests
        .filter((observation) => observation.emittingTask === taskId)
        .sort(observationOrder);
      const terminal = owned.at(-1);
      if (terminal === undefined) {
        throw new Error(`${row.topology}/${row.caseId}/${taskId} lacks a retrieval manifest`);
      }
      if (
        owned.filter(
          (observation) =>
            observation.loopIteration === terminal.loopIteration &&
            observation.attempt === terminal.attempt,
        ).length !== 1
      ) {
        throw new Error(`${row.topology}/${row.caseId}/${taskId} has duplicate terminal manifests`);
      }
      const payload = DurableRetrievalManifestPayloadSchema.parse(terminal.payload);
      const role = expectedSelectorRoleForTask(taskId);
      if (payload.selectorRole !== role) {
        throw new Error(`${row.topology}/${row.caseId}/${taskId} has a role-mismatched manifest`);
      }
      const providerRequired =
        role === "internal" ||
        (role === "memory" &&
          manifest.sourceBindings.some((binding) => binding.kind === "memory")) ||
        (role === "web" &&
          fixture.webRequested &&
          fixture.webPolicyEnabled &&
          (taskId.startsWith("topic-")
            ? topicRequestsWebEvidence(
                routing.plan?.mode === "fanout"
                  ? (routing.plan.topics.find(
                      (topic) => `topic-${topic.topicId}-retrieve-web` === taskId,
                    )?.question ?? "")
                  : "",
              )
            : true));
      if (!providerRequired && owned.length !== 1) {
        throw new Error(
          `${row.topology}/${row.caseId}/${taskId} deterministic manifest is not unique`,
        );
      }
      for (const observation of owned) {
        providerUsageForObservation(row, evidence, observation, {
          allowNoUsage: !providerRequired,
        });
        if (role === "web") {
          externalToolUsageForObservation(row, evidence, observation, providerRequired);
        }
      }
      const terminalUsage = terminalProviderUsage(row, evidence, terminal, {
        allowNoUsage: !providerRequired,
      });
      const externalUsage =
        role === "web"
          ? terminalExternalToolUsage(row, evidence, terminal, providerRequired)
          : ([] as const);
      const selector = role === "internal" ? "A" : role === "memory" ? "B" : "W";
      const expected = ledger.sources.filter((source) => {
        return (
          fixture.evidence.find((candidate) => candidate.sourceId === source.sourceId)?.selector ===
          selector
        );
      });
      const actual = payload.references.map((reference) => {
        const sourceId = mapReferenceToGolden(manifest, reference);
        const source = expected.find((candidate) => candidate.sourceId === sourceId);
        const binding = manifest.sourceBindings.find(
          (candidate) => evaluationBindingGoldenSourceId(candidate) === sourceId,
        );
        if (sourceId === undefined || source === undefined || binding === undefined) {
          throw new Error(`${row.topology}/${row.caseId}/${taskId} has an unbound manifest item`);
        }
        const resolvedSourceId = sourceId;
        const fixtureSource = fixture.evidence.find(
          (candidate) => candidate.sourceId === resolvedSourceId,
        )!;
        let ranges: readonly EvaluationRange[] = [];
        let candidateId: string;
        let exact = false;
        if (binding.kind === "document") {
          const documentReference = DurableInternalManifestReferenceSchema.parse(reference);
          if (documentReference.kind !== "document") {
            throw new Error(`${row.topology}/${row.caseId}/${taskId} has a kind-mismatched item`);
          }
          const storedDocument = storedDocuments.get(resolvedSourceId);
          if (storedDocument === undefined) {
            throw new Error(
              `${row.topology}/${row.caseId}/${taskId} lacks current stored document text`,
            );
          }
          ranges = normalizeCharacterRanges(
            documentReference.ranges === undefined || documentReference.ranges.length === 0
              ? [
                  {
                    charStart: 0,
                    charEnd: storedDocument.text.length,
                  },
                ]
              : documentReference.ranges,
            storedDocument.text.length,
          );
          candidateId = documentBindingIdentity(binding);
          exact =
            documentReference.documentId === binding.documentId &&
            documentReference.documentVersionId === binding.documentVersionId &&
            canonicalJson(documentReference.source) === canonicalJson(binding.source) &&
            documentReference.purpose === source.purpose &&
            canonicalJson(ranges) === canonicalJson(source.ranges);
        } else if (binding.kind === "chat_message") {
          const chatReference = DurableInternalManifestReferenceSchema.parse(reference);
          candidateId = chatMessageEvidenceIdentity(binding.messageId);
          exact =
            chatReference.kind === "chat_message" &&
            chatReference.messageId === binding.messageId &&
            chatReference.purpose === source.purpose;
        } else if (binding.kind === "memory") {
          const memoryReference = DurableMemoryManifestReferenceSchema.parse(reference);
          candidateId = memoryEvidenceIdentity(binding.memoryId);
          exact =
            memoryReference.memoryId === binding.memoryId &&
            memoryReference.memoryRevisionId === binding.memoryRevisionId &&
            source.purpose === "relevant saved memory";
        } else if (binding.kind === "web" && fixtureSource.kind === "web") {
          const webReference = DurableWebManifestReferenceSchema.parse(reference);
          candidateId = webEvidenceIdentity(binding.url, webReference.quote);
          let referenceHost: string | undefined;
          try {
            referenceHost = new URL(webReference.url).hostname;
          } catch {
            referenceHost = undefined;
          }
          exact =
            referenceHost === binding.domain &&
            webReference.domain === binding.domain &&
            webReference.quote.trim().length > 0 &&
            (webReference.publishedAt === undefined ||
              Number.isFinite(Date.parse(webReference.publishedAt))) &&
            Number.isFinite(Date.parse(webReference.capturedAt)) &&
            webReference.purpose.trim().length > 0;
        } else {
          throw new Error(`${row.topology}/${row.caseId}/${taskId} has a kind-mismatched item`);
        }
        if (!exact) {
          throw new Error(`${row.topology}/${row.caseId}/${taskId} manifest semantics differ`);
        }
        const requiredExposureStages =
          role === "internal"
            ? ["internal_search_preview"]
            : role === "memory"
              ? ["memory_direct_inventory", "memory_tool_result"]
              : ["web_fetch"];
        const exposureMatches = evidence.sourceExposures.some(
          (exposure) =>
            exposure.taskId === terminal.emittingTask &&
            exposure.loopIteration === terminal.loopIteration &&
            exposure.attempt === terminal.attempt &&
            exposure.providerRequestIndex === terminalUsage?.providerRequestIndex &&
            requiredExposureStages.includes(exposure.exposureStage) &&
            mapExposureToGolden(manifest, evidence, exposure, storedDocuments) === sourceId,
        );
        if (!exposureMatches) {
          throw new Error(
            `${row.topology}/${row.caseId}/${taskId}/${sourceId} lacks its exact manifest exposure`,
          );
        }
        return { sourceId: source.sourceId, candidateId, ranges };
      });
      const actualSourceIds = actual.map((reference) => reference.sourceId);
      const expectedSourceIds = expected.map((source) => source.sourceId);
      const sourceIdsMatch =
        role === "web"
          ? canonicalJson([...new Set(actualSourceIds)]) === canonicalJson(expectedSourceIds)
          : canonicalJson(actualSourceIds) === canonicalJson(expectedSourceIds);
      if (
        (role !== "web" && new Set(actualSourceIds).size !== actual.length) ||
        !sourceIdsMatch ||
        (role === "web" &&
          payload.references.length > 0 &&
          (!externalUsage.some((usage) => usage.operation === "web_search") ||
            externalUsage.filter((usage) => usage.operation === "web_fetch").length <
              payload.references.length))
      ) {
        throw new Error(`${row.topology}/${row.caseId}/${taskId} manifest cardinality differs`);
      }
      if (role === "internal" && fixture.dimensions.includes("oversized_evidence")) {
        const canonicalDocuments = fixture.evidence.filter(
          (source) => source.selector === "A" && source.kind === "document",
        );
        const canonicalSourceIds = canonicalDocuments.map((source) => source.sourceId).sort();
        if (
          canonicalDocuments.length !== 6 ||
          actual.length !== 6 ||
          canonicalJson(actual.map((reference) => reference.sourceId).sort()) !==
            canonicalJson(canonicalSourceIds) ||
          terminalUsage === null
        ) {
          throw new Error(
            `${row.topology}/${row.caseId}/${taskId} oversized A identity set differs`,
          );
        }
        const terminalExposures = evidence.sourceExposures.filter(
          (exposure) =>
            exposure.taskId === terminal.emittingTask &&
            exposure.loopIteration === terminal.loopIteration &&
            exposure.attempt === terminal.attempt &&
            exposure.providerRequestIndex === terminalUsage.providerRequestIndex,
        );
        const exactStageRows = (stage: "internal_search_preview" | "internal_inspection") =>
          terminalExposures.filter((exposure) => exposure.exposureStage === stage);
        const previewRows = exactStageRows("internal_search_preview");
        const previewSourceIds = previewRows
          .map((exposure) => mapExposureToGolden(manifest, evidence, exposure, storedDocuments))
          .sort();
        if (
          previewRows.length !== 6 ||
          new Set(previewSourceIds).size !== 6 ||
          canonicalJson(previewSourceIds) !== canonicalJson(canonicalSourceIds)
        ) {
          throw new Error(
            `${row.topology}/${row.caseId}/${taskId} oversized A preview exposure set is not exact`,
          );
        }
      }
      result.push({ taskId, selectorRole: role, observation: terminal, references: actual });
    }
  }
  return result;
};

const attestRetrievalManifestEvidence = (
  row: CaseRunRow,
  evidence: DurableRunEvidence,
  manifest: EvaluationSeedManifest,
  storedDocuments: StoredEvaluationDocuments,
): void => {
  terminalRetrievalManifests(row, evidence, manifest, storedDocuments);
};

const initialProductionLedger = (
  fixture: GoldenEvaluationCase,
  manifest: EvaluationSeedManifest,
  evidence: DurableRunEvidence,
  taskId: string,
) => {
  const observation = latestObservation(evidence, "context_measurement", taskId);
  if (observation === undefined)
    throw new Error(`${fixture.id}/${taskId} lacks its initial ledger`);
  const payload = z
    .object({
      totalInputTokens: z.number().int().nonnegative(),
      usableInputTokens: z.number().int().positive(),
      requestedOutputTokens: z.number().int().positive(),
      status: z.enum(["ready", "needs_reduction", "failed"]),
      reductionRan: z.boolean(),
      restrictedContextLedger: RestrictedContextLedgerSchema,
    })
    .passthrough()
    .parse(observation.payload);
  const ledger = translateAndAttestRestrictedLedger(
    fixture,
    manifest,
    evidence,
    payload.restrictedContextLedger,
  );
  if (
    payload.totalInputTokens !== ledger.inputTokens ||
    payload.usableInputTokens !== ledger.usableInputTokens ||
    payload.requestedOutputTokens !== ledger.requestedOutputTokens ||
    payload.reductionRan
  ) {
    throw new Error(`${fixture.id}/${taskId} initial measurement differs from its ledger`);
  }
  return { ledger, status: payload.status };
};

const reducedProductionLedger = (
  fixture: GoldenEvaluationCase,
  manifest: EvaluationSeedManifest,
  evidence: DurableRunEvidence,
  taskId: string,
) => {
  const observation = latestObservation(evidence, "context_measurement", taskId);
  if (observation === undefined)
    throw new Error(`${fixture.id}/${taskId} lacks its reduced ledger`);
  const payload = z
    .object({
      totalInputTokens: z.number().int().nonnegative(),
      usableInputTokens: z.number().int().positive(),
      requestedOutputTokens: z.number().int().positive(),
      status: z.enum(["ready", "needs_reduction", "failed"]),
      reductionRan: z.boolean(),
      restrictedContextLedger: RestrictedContextLedgerSchema,
    })
    .passthrough()
    .parse(observation.payload);
  const ledger = translateAndAttestRestrictedLedger(
    fixture,
    manifest,
    evidence,
    payload.restrictedContextLedger,
  );
  if (
    payload.totalInputTokens !== ledger.inputTokens ||
    payload.usableInputTokens !== ledger.usableInputTokens ||
    payload.requestedOutputTokens !== ledger.requestedOutputTokens ||
    !payload.reductionRan ||
    payload.status !== "ready" ||
    ledger.inputTokens > ledger.usableInputTokens
  ) {
    throw new Error(`${fixture.id}/${taskId} reduced measurement differs from its ready ledger`);
  }
  return ledger;
};

const productionReduction = (
  fixture: GoldenEvaluationCase,
  manifest: EvaluationSeedManifest,
  evidence: DurableRunEvidence,
  promptMeasurements: readonly TrustedPromptMeasurement[],
  taskId: string,
  initial: ReturnType<typeof translateAndAttestRestrictedLedger>,
  terminal: ReturnType<typeof translateAndAttestRestrictedLedger>,
) => {
  if (initial.requestKind === "synthesis" || terminal.requestKind === "synthesis") {
    throw new Error(`${fixture.id}/${taskId} synthesis cannot carry an O decision`);
  }
  const observations = evidence.observations
    .filter(
      (observation) =>
        observation.kind === "context_decision" && observation.emittingTask === taskId,
    )
    .sort(observationOrder);
  const reducerTaskId = taskId.replace(/reduce-measure$/u, "reduce-plan");
  const terminalObservation = observations.at(-1);
  if (terminalObservation === undefined || terminalObservation.payload.valid !== true) {
    throw new Error(`${fixture.id}/${taskId} lacks a valid terminal O decision`);
  }
  const reducerTerminalObservations = evidence.observations
    .filter(
      (observation) =>
        observation.kind === "context_reducer_terminal" &&
        observation.emittingTask === reducerTaskId,
    )
    .sort(observationOrder);
  for (const observation of reducerTerminalObservations) {
    const artifact = ContextReducerTerminalSchema.parse(observation.payload);
    const bound = evidence.usage
      .filter(
        (usage) =>
          usage.taskId === reducerTaskId &&
          usage.loopIteration === observation.loopIteration &&
          usage.attempt === observation.attempt,
      )
      .at(-1);
    const boundMeasurement = providerMeasurementsForTask(evidence, reducerTaskId)
      .filter(
        (measurement) =>
          measurement.loopIteration === observation.loopIteration &&
          measurement.attempt === observation.attempt,
      )
      .at(-1);
    if (
      bound === undefined ||
      boundMeasurement === undefined ||
      bound.agentRole !== "context_reducer" ||
      bound.modelId !== "glm-5-turbo" ||
      bound.providerServiceId !== ZAI_CODING_PLAN_PROVIDER_SERVICE_ID ||
      !isSuccessfulProviderStopReason(bound.stopReason) ||
      artifact.terminalUsageCoordinate.taskId !== reducerTaskId ||
      artifact.terminalUsageCoordinate.loopIteration !== observation.loopIteration ||
      artifact.terminalUsageCoordinate.attempt !== observation.attempt ||
      usageCoordinateKey(artifact.terminalUsageCoordinate) !== usageCoordinateKey(bound) ||
      usageCoordinateKey(artifact.terminalUsageCoordinate) !== usageCoordinateKey(boundMeasurement)
    ) {
      throw new Error(`${fixture.id}/${reducerTaskId} has an unbound reducer retry output`);
    }
  }
  const reducerTerminalObservation = reducerTerminalObservations.at(-1);
  const reducerTerminal = ContextReducerTerminalSchema.parse(reducerTerminalObservation?.payload);
  const coordinate = reducerTerminal.terminalUsageCoordinate;
  const reducerUsage = evidence.usage.filter((usage) => usage.taskId === reducerTaskId);
  const terminalUsage = reducerUsage.at(-1);
  const latestReducerMeasurement = providerMeasurementsForTask(evidence, reducerTaskId).at(-1);
  const exactUsage = evidence.usage.find(
    (usage) => usageCoordinateKey(usage) === usageCoordinateKey(coordinate),
  );
  const measurementObservation = evidence.observations.find((observation) => {
    if (observation.kind !== "provider_request_measurement") return false;
    const parsed = ProviderRequestMeasurementSchema.safeParse(observation.payload);
    return (
      parsed.success &&
      usageCoordinateKey({
        taskId: observation.emittingTask,
        loopIteration: observation.loopIteration,
        attempt: observation.attempt,
        providerRequestIndex: parsed.data.providerRequestIndex,
      }) === usageCoordinateKey(coordinate)
    );
  });
  const requestMeasurement = ProviderRequestMeasurementSchema.parse(
    measurementObservation?.payload,
  );
  const trustedMeasurement = promptMeasurements.find(
    (measurement) => measurement.requestId === usageCoordinateKey(coordinate),
  );
  if (
    reducerTerminalObservation === undefined ||
    coordinate.taskId !== reducerTaskId ||
    reducerTerminalObservation.loopIteration !== coordinate.loopIteration ||
    reducerTerminalObservation.attempt !== coordinate.attempt ||
    terminalObservation.loopIteration !== coordinate.loopIteration ||
    exactUsage === undefined ||
    terminalUsage === undefined ||
    latestReducerMeasurement === undefined ||
    usageCoordinateKey(terminalUsage) !== usageCoordinateKey(coordinate) ||
    usageCoordinateKey(latestReducerMeasurement) !== usageCoordinateKey(coordinate) ||
    exactUsage.agentRole !== "context_reducer" ||
    exactUsage.providerServiceId !== ZAI_CODING_PLAN_PROVIDER_SERVICE_ID ||
    exactUsage.modelId !== "glm-5-turbo" ||
    !isSuccessfulProviderStopReason(exactUsage.stopReason) ||
    reducerTerminal.modelId !== exactUsage.modelId ||
    reducerTerminal.requestSha256Hex !== requestMeasurement.requestSha256Hex ||
    requestMeasurement.modelId !== exactUsage.modelId ||
    requestMeasurement.agentRole !== exactUsage.agentRole ||
    !requestMeasurement.passed ||
    requestMeasurement.inputTokens !== providerPromptTokens(exactUsage) ||
    reducerTerminal.providerInputTokens !== providerPromptTokens(exactUsage) ||
    reducerTerminal.totalTokens !== exactUsage.totalTokens ||
    reducerTerminal.stopReason !== exactUsage.stopReason ||
    trustedMeasurement?.requestSha256Hex !== reducerTerminal.requestSha256Hex ||
    trustedMeasurement?.localInputTokens !== providerPromptTokens(exactUsage) ||
    trustedMeasurement.providerInputTokens !== providerPromptTokens(exactUsage) ||
    !trustedMeasurement.gatePassed
  ) {
    throw new Error(`${fixture.id}/${taskId} lacks exact terminal context-reducer usage`);
  }
  const parsed = z.array(DurableContextDecisionSchema).parse(terminalObservation.payload.decisions);
  type InitialCandidate =
    | {
        readonly kind: "conversation";
        readonly value: (typeof initial.selectedConversation)[number];
      }
    | { readonly kind: "source"; readonly value: (typeof initial.sources)[number] };
  const initialCandidates = new Map<string, InitialCandidate>();
  for (const entry of initial.selectedConversation) {
    initialCandidates.set(`conversation_entry:${entry.turnId}`, {
      kind: "conversation",
      value: entry,
    });
  }
  for (const source of initial.sources) {
    initialCandidates.set(source.candidateId, { kind: "source", value: source });
  }
  const terminalConversation = new Map(
    terminal.selectedConversation.map((entry) => [`conversation_entry:${entry.turnId}`, entry]),
  );
  const terminalSources = new Map(
    terminal.sources.map((source) => [source.candidateId, source] as const),
  );
  if (
    initialCandidates.size !== initial.selectedConversation.length + initial.sources.length ||
    parsed.length !== initialCandidates.size ||
    new Set(parsed.map((decision) => decision.id)).size !== parsed.length ||
    parsed.some((decision) => !initialCandidates.has(decision.id))
  ) {
    throw new Error(`${fixture.id}/${taskId} O decision is not complete for the exact ledger`);
  }
  for (const decision of parsed) {
    const candidate = initialCandidates.get(decision.id)!;
    if (candidate.kind === "conversation") {
      if (decision.action === "range") {
        throw new Error(`${fixture.id}/${taskId} ranges a conversation candidate`);
      }
      const kept = terminalConversation.has(decision.id);
      if (kept !== (decision.action === "keep")) {
        throw new Error(`${fixture.id}/${taskId} conversation O decision differs from terminal`);
      }
      continue;
    }
    const selected = terminalSources.get(decision.id);
    if (decision.action === "omit") {
      if (selected !== undefined)
        throw new Error(`${fixture.id}/${taskId} serialized an O omission`);
    } else if (selected === undefined) {
      throw new Error(`${fixture.id}/${taskId} omitted an O keep`);
    } else {
      const expectedRanges = decision.action === "range" ? decision.ranges : candidate.value.ranges;
      if (
        selected.sourceKey !== candidate.value.sourceKey ||
        selected.sourceId !== candidate.value.sourceId ||
        selected.purpose !== candidate.value.purpose ||
        selected.label !== candidate.value.label ||
        canonicalJson(selected.ranges) !== canonicalJson(expectedRanges)
      ) {
        throw new Error(`${fixture.id}/${taskId} terminal source differs from its O decision`);
      }
    }
  }
  const iterations = new Set(observations.map((observation) => observation.loopIteration)).size;
  if (iterations < 1 || iterations > 2) {
    throw new Error(`${fixture.id}/${taskId} O did not converge in one or two iterations`);
  }
  return {
    iterations,
    decisions: parsed.map((decision) => ({
      candidateId: decision.id,
      action: decision.action,
      ranges: decision.action === "range" ? decision.ranges : [],
    })),
  };
};

const captureProductionTopology = (
  fixture: GoldenEvaluationCase,
  manifest: EvaluationSeedManifest,
  evidence: DurableRunEvidence,
  promptMeasurements: readonly TrustedPromptMeasurement[],
  resolutionMode: "continue" | "clarify",
  executionPlan:
    | { readonly mode: "single" }
    | { readonly mode: "fanout"; readonly topicCount: number },
) => {
  if (resolutionMode === "clarify") {
    const observation = latestObservation(
      evidence,
      "provider_request_attestation",
      "resolve-conversation",
    );
    const request = ConversationResolverRequestAttestationSchema.parse(observation?.payload);
    const conversation = attestCompleteConversationResolverInventory(
      fixture,
      manifest,
      evidence,
      request,
    );
    const exact = attestExactConversationResolverRequest(
      fixture,
      conversation,
      request.currentDate,
    );
    const usage = evidence.usage.find(
      (candidate) =>
        usageCoordinateKey(candidate) === usageCoordinateKey(request.terminalUsageCoordinate),
    );
    const latestResolverUsage = evidence.usage
      .filter((candidate) => candidate.taskId === "resolve-conversation")
      .at(-1);
    const latestResolverMeasurement = providerMeasurementsForTask(
      evidence,
      "resolve-conversation",
    ).at(-1);
    const providerMeasurementObservation = evidence.observations.find((candidate) => {
      if (candidate.kind !== "provider_request_measurement") return false;
      const payload = ProviderRequestMeasurementSchema.safeParse(candidate.payload);
      return (
        payload.success &&
        usageCoordinateKey({
          taskId: candidate.emittingTask,
          loopIteration: candidate.loopIteration,
          attempt: candidate.attempt,
          providerRequestIndex: payload.data.providerRequestIndex,
        }) === usageCoordinateKey(request.terminalUsageCoordinate)
      );
    });
    const providerMeasurement = ProviderRequestMeasurementSchema.parse(
      providerMeasurementObservation?.payload,
    );
    if (
      observation === undefined ||
      request.currentUserMessageId !== manifest.userMessageId ||
      request.terminalUsageCoordinate.taskId !== "resolve-conversation" ||
      request.terminalUsageCoordinate.loopIteration !== observation.loopIteration ||
      request.terminalUsageCoordinate.attempt !== observation.attempt ||
      request.inputTokens !== exact.inputTokens ||
      request.usableInputTokens !== exact.usableInputTokens ||
      request.requestSha256Hex !== exact.requestSha256Hex ||
      usage === undefined ||
      latestResolverUsage === undefined ||
      latestResolverMeasurement === undefined ||
      usageCoordinateKey(latestResolverUsage) !== usageCoordinateKey(usage) ||
      usageCoordinateKey(latestResolverMeasurement) !== usageCoordinateKey(usage) ||
      usage.agentRole !== "conversation_resolver" ||
      usage.providerServiceId !== ZAI_CODING_PLAN_PROVIDER_SERVICE_ID ||
      usage.modelId !== request.modelId ||
      !isSuccessfulProviderStopReason(usage.stopReason) ||
      providerPromptTokens(usage) !== request.inputTokens ||
      providerMeasurement.requestSha256Hex !== request.requestSha256Hex ||
      providerMeasurement.modelId !== request.modelId ||
      providerMeasurement.agentRole !== usage.agentRole ||
      providerMeasurement.inputTokens !== request.inputTokens ||
      !providerMeasurement.passed ||
      !promptMeasurements.some(
        (measurement) =>
          measurement.requestId === usageCoordinateKey(usage) &&
          measurement.requestSha256Hex === request.requestSha256Hex &&
          measurement.localInputTokens === request.inputTokens &&
          measurement.providerInputTokens === request.inputTokens &&
          measurement.gatePassed,
      )
    ) {
      throw new Error(`${fixture.id} clarification lacks exact resolver provider usage`);
    }
    return {
      mode: "clarification" as const,
      resolverRequest: {
        modelId: request.modelId,
        requestSha256Hex: request.requestSha256Hex,
        inputTokens: request.inputTokens,
        usableInputTokens: request.usableInputTokens,
        requestedOutputTokens: request.requestedOutputTokens,
        currentUserMessageId: request.currentUserMessageId,
        currentDate: request.currentDate,
        conversation,
        terminalUsageCoordinate: request.terminalUsageCoordinate,
      },
      providerInputTokens: providerPromptTokens(usage),
    };
  }
  if (executionPlan.mode === "single") {
    const initial = initialProductionLedger(fixture, manifest, evidence, "single-measure");
    const terminal = terminalProductionLedger(
      fixture,
      manifest,
      evidence,
      promptMeasurements,
      "single-answer",
    );
    if (initial.ledger.requestKind !== "direct" || terminal.ledger.requestKind !== "direct") {
      throw new Error(`${fixture.id} single path has a non-direct production ledger`);
    }
    const reductionTaskId = "single-reduce-measure";
    const reduced = initial.ledger.inputTokens > initial.ledger.usableInputTokens;
    if (reduced !== (initial.status === "needs_reduction")) {
      throw new Error(`${fixture.id} single production ledger has an invalid initial route`);
    }
    if (!reduced) {
      if (
        evidence.observations.some(
          (observation) =>
            observation.emittingTask === reductionTaskId &&
            (observation.kind === "context_decision" || observation.kind === "context_measurement"),
        ) ||
        canonicalJson(initial.ledger) !== canonicalJson(terminal.ledger)
      ) {
        throw new Error(`${fixture.id} fitting single path changed or ran O before answering`);
      }
      return { mode: "single_fit" as const, initial: initial.ledger, terminal };
    }
    const reducedLedger = reducedProductionLedger(fixture, manifest, evidence, reductionTaskId);
    if (
      reducedLedger.requestKind !== "direct" ||
      canonicalJson(reducedLedger) !== canonicalJson(terminal.ledger)
    ) {
      throw new Error(`${fixture.id} reduced single ledger differs from its terminal request`);
    }
    const reduction = productionReduction(
      fixture,
      manifest,
      evidence,
      promptMeasurements,
      reductionTaskId,
      initial.ledger,
      terminal.ledger,
    );
    return {
      mode: "single_reduced" as const,
      initial: initial.ledger,
      terminal,
      ...reduction,
    };
  }
  const topicIds = (["t1", "t2", "t3"] as const).slice(0, executionPlan.topicCount);
  const topics = topicIds.map((topicId) => {
    const initialTaskId = `topic-${topicId}-measure`;
    const answerTaskId = `topic-${topicId}-answer`;
    const reductionTaskId = `topic-${topicId}-reduce-measure`;
    const initial = initialProductionLedger(fixture, manifest, evidence, initialTaskId);
    const terminal = terminalProductionLedger(
      fixture,
      manifest,
      evidence,
      promptMeasurements,
      answerTaskId,
    );
    if (
      initial.ledger.requestKind !== "topic" ||
      terminal.ledger.requestKind !== "topic" ||
      initial.ledger.topicId !== topicId ||
      terminal.ledger.topicId !== topicId
    ) {
      throw new Error(`${fixture.id}/${topicId} has a route-mismatched topic ledger`);
    }
    const reduced = initial.ledger.inputTokens > initial.ledger.usableInputTokens;
    if (reduced !== (initial.status === "needs_reduction")) {
      throw new Error(`${fixture.id}/${topicId} has an invalid initial topic route`);
    }
    if (!reduced) {
      if (
        evidence.observations.some(
          (observation) =>
            observation.emittingTask === reductionTaskId &&
            (observation.kind === "context_decision" || observation.kind === "context_measurement"),
        ) ||
        canonicalJson(initial.ledger) !== canonicalJson(terminal.ledger)
      ) {
        throw new Error(`${fixture.id}/${topicId} fitting topic changed or ran O`);
      }
      return {
        topicId,
        reduced: false,
        iterations: 0,
        decisions: [],
        initial: initial.ledger,
        terminal,
      };
    }
    const reducedLedger = reducedProductionLedger(fixture, manifest, evidence, reductionTaskId);
    if (
      reducedLedger.requestKind !== "topic" ||
      reducedLedger.topicId !== topicId ||
      canonicalJson(reducedLedger) !== canonicalJson(terminal.ledger)
    ) {
      throw new Error(`${fixture.id}/${topicId} reduced topic differs from its terminal request`);
    }
    return {
      topicId,
      reduced: true,
      ...productionReduction(
        fixture,
        manifest,
        evidence,
        promptMeasurements,
        reductionTaskId,
        initial.ledger,
        terminal.ledger,
      ),
      initial: initial.ledger,
      terminal,
    };
  });
  const synthesis = terminalProductionLedger(
    fixture,
    manifest,
    evidence,
    promptMeasurements,
    "fanout-synthesis",
  );
  if (
    synthesis.ledger.requestKind !== "synthesis" ||
    canonicalJson(synthesis.ledger.packets.map((packet) => packet.topicId)) !==
      canonicalJson(topicIds)
  ) {
    throw new Error(`${fixture.id} fanout synthesis ledger does not match its topic routes`);
  }
  for (const packet of synthesis.ledger.packets) {
    const observation = latestObservation(
      evidence,
      "topic_packet",
      `topic-${packet.topicId}-answer`,
    );
    const durablePacket = z
      .object({
        topicId: z.literal(packet.topicId),
        status: z.enum(["answered", "partial"]),
        claimCount: z.number().int().nonnegative(),
        gapCount: z.number().int().nonnegative(),
        packetSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .passthrough()
      .parse(observation?.payload);
    if (
      packet.status !== durablePacket.status ||
      packet.claimCount !== durablePacket.claimCount ||
      packet.gapCount !== durablePacket.gapCount ||
      packet.packetSha256Hex !== durablePacket.packetSha256Hex
    ) {
      throw new Error(`${fixture.id}/${packet.topicId} synthesis packet hash is not durable`);
    }
  }
  return { mode: "fanout" as const, topics, synthesis };
};

const captureSpecialized = async (
  connectionString: string,
  row: CaseRunRow,
  annotations: EvaluationHumanAnnotations,
  annotationDigest: string,
): Promise<SpecializedEvaluationResult> => {
  const captured = await commonCapturedResult(connectionString, row, annotations, annotationDigest);
  const { fixture, manifest, evidence, selections } = captured;
  const measurementFixture = fixtureWithStoredDocumentText(fixture, captured.storedDocuments);
  const routing = canonicalResolutionAndPlan(row, evidence, manifest);
  const turnMap = new Map(
    manifest.turnBindings.map((binding) => [binding.aiRunId, binding.turnId]),
  );
  const resolution =
    routing.resolution.mode === "clarify"
      ? { mode: "clarify" as const, question: routing.resolution.question }
      : {
          mode: "continue" as const,
          retrievalQuestion: routing.resolution.retrievalQuestion,
          selectedTurnIds: routing.resolution.selectedTurnIds.map((id) => turnMap.get(id) ?? id),
        };
  const executionPlan =
    routing.plan?.mode !== "fanout"
      ? { mode: "single" as const }
      : {
          mode: "fanout" as const,
          topicCount: routing.plan.topics.length,
        };
  const selectorSelections = { A: [] as string[], B: [] as string[], W: [] as string[] };
  const pulledSelections = new Map<
    string,
    {
      readonly ranges: readonly EvaluationRange[];
      readonly candidateId: string;
    }
  >();
  const manifests = terminalRetrievalManifests(row, evidence, manifest, captured.storedDocuments);
  for (const terminalManifest of manifests) {
    for (const { sourceId, candidateId, ranges } of terminalManifest.references) {
      const prior = pulledSelections.get(sourceId);
      if (
        prior !== undefined &&
        (prior.candidateId !== candidateId || canonicalJson(prior.ranges) !== canonicalJson(ranges))
      ) {
        if (terminalManifest.selectorRole !== "web") {
          throw new Error(`${row.caseId}/${sourceId} has divergent durable selector references`);
        }
        // Production web retrieval can return multiple excerpts from the same
        // canonical domain. The durable candidate identity includes each
        // provider quote, while the scored artifact has one canonical source
        // selection; retain one identity and merge any ranges for that source.
        pulledSelections.set(sourceId, {
          ranges: [...prior.ranges, ...ranges],
          candidateId: prior.candidateId,
        });
      } else {
        pulledSelections.set(sourceId, { ranges, candidateId });
      }
      if (terminalManifest.selectorRole === "memory") selectorSelections.B.push(sourceId);
      else if (terminalManifest.selectorRole === "web") selectorSelections.W.push(sourceId);
      else selectorSelections.A.push(sourceId);
    }
  }
  for (const key of ["A", "B", "W"] as const)
    selectorSelections[key] = [...new Set(selectorSelections[key])];
  const candidateSourceIds = [...pulledSelections.keys()];
  const pulledSourceIds = exposedGoldenSourceIds(manifest, evidence, captured.storedDocuments);
  const semanticRanges = (sourceId: string, ranges: readonly EvaluationRange[]) => {
    const source = fixture.evidence.find((candidate) => candidate.sourceId === sourceId);
    if (source?.kind !== "document" || ranges.length === 0) return ranges;
    const documentLength =
      captured.storedDocuments.get(sourceId)?.text.length ??
      (() => {
        throw new Error(`${row.topology}/${row.caseId} document lacks current stored text`);
      })();
    return normalizeCharacterRanges(
      ranges
        .map((range) => ({
          charStart: range.charStart,
          charEnd: Math.min(range.charEnd, documentLength),
        }))
        .filter((range) => range.charEnd > range.charStart),
      documentLength,
    );
  };
  const candidateSelections = candidateSourceIds.map((sourceId) => ({
    sourceId,
    ranges: semanticRanges(sourceId, pulledSelections.get(sourceId)!.ranges),
  }));
  const candidateTokens = measureCanonicalEvaluationRequestTokens(
    measurementFixture,
    candidateSelections,
  );
  const serializedTokens = measureCanonicalEvaluationRequestTokens(measurementFixture, selections);
  const productionContext = captureProductionTopology(
    measurementFixture,
    manifest,
    evidence,
    captured.common.promptMeasurements,
    resolution.mode,
    executionPlan,
  );
  const reductionRequired =
    productionContext.mode === "single_reduced" ||
    (productionContext.mode === "fanout" &&
      productionContext.topics.some((topic) => topic.reduced));
  const reductionIterations =
    productionContext.mode === "single_reduced"
      ? productionContext.iterations
      : productionContext.mode === "fanout"
        ? Math.max(0, ...productionContext.topics.map((topic) => topic.iterations))
        : 0;
  const sourceIdByCandidateId = new Map(
    candidateSourceIds.map((sourceId) => [pulledSelections.get(sourceId)!.candidateId, sourceId]),
  );
  const decisions =
    productionContext.mode === "single_reduced"
      ? productionContext.decisions.flatMap((decision) => {
          const sourceId = sourceIdByCandidateId.get(decision.candidateId);
          return sourceId === undefined
            ? []
            : [
                {
                  sourceId,
                  action: decision.action,
                  ranges: semanticRanges(sourceId, decision.ranges),
                },
              ];
        })
      : [];
  return SpecializedEvaluationResultsSchema.element.parse({
    ...captured.common,
    topology: "specialized",
    pulledSourceIds,
    conversationResolution: resolution,
    executionPlan,
    selectorSelections,
    reduction: {
      required: reductionRequired,
      iterations: reductionIterations,
      candidateTokens,
      serializedTokens,
      usableInputTokens: canonicalEvaluationUsableInputTokens(),
      candidateSourceIds,
      candidateSelections,
      decisions,
      selections,
    },
    productionContext,
  });
};

const captureBaseline = async (
  connectionString: string,
  row: CaseRunRow,
  annotations: EvaluationHumanAnnotations,
  annotationDigest: string,
): Promise<GeneralPlannerEvaluationResult> => {
  const captured = await commonCapturedResult(connectionString, row, annotations, annotationDigest);
  GeneralPlannerProviderOutputSchema.parse(row.executionOutput);
  return GeneralPlannerEvaluationResultsSchema.element.parse({
    ...captured.common,
    topology: "general_planner",
    pulledSourceIds: exposedGoldenSourceIds(
      captured.manifest,
      captured.evidence,
      captured.storedDocuments,
    ),
  });
};

/**
 * Runs the same trusted capture core for one already-attested case. This is
 * useful for bounded recovery/integration checks and retains the immutable
 * annotation, provider-service, model, measurement, and authorization gates.
 */
export const captureEvaluationCase = async (
  connectionString: string,
  sessionId: string,
  caseId: string,
  topology: EvaluationTopology,
): Promise<SpecializedEvaluationResult | GeneralPlannerEvaluationResult> => {
  const row = (await loadCaseRuns(connectionString, sessionId)).find(
    (candidate) => candidate.caseId === caseId && candidate.topology === topology,
  );
  if (row?.status !== "succeeded" || row.runEvidenceSha256Hex === null) {
    throw new Error(`${topology}/${caseId} is not ready for trusted capture`);
  }
  const bound = await loadAnnotations(connectionString, row);
  return topology === "specialized"
    ? captureSpecialized(connectionString, row, bound.annotations, bound.digest)
    : captureBaseline(connectionString, row, bound.annotations, bound.digest);
};

export interface CapturedEvaluationSuite {
  readonly specialized: readonly SpecializedEvaluationResult[];
  readonly baseline: readonly GeneralPlannerEvaluationResult[];
}

export const captureEvaluationSession = async (
  connectionString: string,
  sessionId: string,
): Promise<CapturedEvaluationSuite> => {
  const session = await loadEvaluationSession(connectionString, sessionId);
  if (session.status !== "awaiting_annotations" && session.status !== "complete") {
    throw new Error(`evaluation session cannot be captured from ${session.status}`);
  }
  const rows = await loadCaseRuns(connectionString, sessionId);
  const specialized: SpecializedEvaluationResult[] = [];
  const baseline: GeneralPlannerEvaluationResult[] = [];
  for (const fixture of CanonicalGoldenEvaluationSet.cases) {
    for (const topology of ["specialized", "general_planner"] as const) {
      const row = rows.find(
        (candidate) => candidate.caseId === fixture.id && candidate.topology === topology,
      );
      if (row?.status !== "succeeded")
        throw new Error(`${topology}/${fixture.id} is not succeeded`);
      const bound = await loadAnnotations(connectionString, row);
      if (topology === "specialized") {
        specialized.push(
          await captureSpecialized(connectionString, row, bound.annotations, bound.digest),
        );
      } else {
        baseline.push(
          await captureBaseline(connectionString, row, bound.annotations, bound.digest),
        );
      }
    }
  }
  const suite = {
    specialized: SpecializedEvaluationResultsSchema.parse(specialized),
    baseline: GeneralPlannerEvaluationResultsSchema.parse(baseline),
  };
  const completed = await db(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      return yield* sql<{ readonly id: string }>`
        update ai_evaluation_sessions
        set status = 'complete', completed_at = now(), updated_at = now()
        where id = ${sessionId} and status = 'awaiting_annotations'
        returning id::text
      `;
    }),
  );
  if (completed.length !== (session.status === "awaiting_annotations" ? 1 : 0)) {
    const current = await loadEvaluationSession(connectionString, sessionId);
    if (current.status !== "complete") {
      throw new Error("evaluation session did not enter or remain in complete");
    }
  }
  return suite;
};

export const revalidateCapturedArtifacts = async (
  connectionString: string,
  sessionId: string,
  specializedInput: unknown,
  baselineInput: unknown,
): Promise<CapturedEvaluationSuite> => {
  const trusted = await captureEvaluationSession(connectionString, sessionId);
  if (canonicalJson(specializedInput) !== canonicalJson(trusted.specialized)) {
    throw new Error("raw specialized artifact does not exactly match its durable trusted capture");
  }
  if (canonicalJson(baselineInput) !== canonicalJson(trusted.baseline)) {
    throw new Error("raw baseline artifact does not exactly match its durable trusted capture");
  }
  const specialized = SpecializedEvaluationResultsSchema.parse(specializedInput);
  const baseline = GeneralPlannerEvaluationResultsSchema.parse(baselineInput);
  if (canonicalJson(specialized) !== canonicalJson(trusted.specialized)) {
    throw new Error("specialized artifact does not exactly match its durable trusted capture");
  }
  if (canonicalJson(baseline) !== canonicalJson(trusted.baseline)) {
    throw new Error("baseline artifact does not exactly match its durable trusted capture");
  }
  return trusted;
};
