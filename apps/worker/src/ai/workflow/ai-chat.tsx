/** @jsxImportSource smithers-orchestrator */
import { z } from "zod";

import type { WorkerConfig } from "../../config";
import { assertFinalSourceMap } from "../product-state/finalization";
import {
  registerSmithersWorkflowMaxConcurrency,
  type CreateSmithersApi,
} from "../smithers-interop";
import {
  AiRuntimeError,
  isAiRunErrorCode,
  isRetryableAiRunError,
  type AiRunErrorCode,
} from "../runtime/errors";
import type {
  AnswerLaneResult,
  FinalSourceRecord,
  PlanTurnResult,
  MemoryExtractionArtifact,
  MemoryReference,
  TopicPacket,
  WebEvidence,
} from "../runtime/types";
import type { RetrievalPlanResult } from "../retrieval/retrieval";
import { stripHistoricalCitationTags } from "../runtime/canonicalization";
import {
  BranchReasonCodeSchema,
  InternalQueryPlanSchema,
  PHYSICAL_QUERY_BRANCHES,
} from "../retrieval/query-spec";
import {
  FusedResultSchema,
  FusedResultSetSchema,
  ReviewModelFusedResultSchema,
} from "../retrieval/rank-fusion";
import type {
  ContextAssembly,
  ContextState,
  FanoutSourceKeySet,
  MemorySelectorResult,
  SelectorBundle,
  WebSelectorResult,
} from "./operations";
import {
  FallbackContextManifestSchema,
  GroupResultEnvelopeSchema,
  InitialContextManifestSchema,
} from "../context/compaction";
import {
  compactionGroupTaskId,
  MAX_COMPACTION_CONCURRENCY,
  type CompactionPassResult,
  type ExactContextMeasurement,
} from "../context/compaction-runtime";
import { RunAcceptanceScopeSchema, candidateLocalId, type LoadedTurn } from "./types";
import { CanonicalWorkflowOperations } from "./operations";
import { PublicProvenanceSchema } from "../runtime/source-schemas";
import { CandidateLedgerSchema } from "./types";

const CharacterRangeSchema = z
  .strictObject({
    charStart: z.number().int().min(0),
    charEnd: z.number().int().positive(),
  })
  .superRefine((range, context) => {
    if (range.charEnd <= range.charStart) {
      context.addIssue({
        code: "custom",
        path: ["charEnd"],
        message: "character ranges must be non-empty half-open intervals",
      });
    }
  });
const NormalizedDocumentRangesSchema = z
  .array(CharacterRangeSchema)
  .min(1)
  .superRefine((ranges, context) => {
    for (let index = 1; index < ranges.length; index += 1) {
      const previous = ranges[index - 1]!;
      const current = ranges[index]!;
      if (current.charStart <= previous.charEnd) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "document ranges must be sorted, non-overlapping, and non-adjacent",
        });
      }
    }
  });
const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const PublicDocumentSourceIdSchema = z.string().regex(/^public:[^:\s]+$/u);
const PublisherDocumentSourceIdSchema = z.string().regex(/^publisher:[^:\s]+$/u);
const ConversationEntrySchema = z.union([
  z.strictObject({
    turnId: z.string(),
    userMessageId: z.string(),
    userContent: z.string(),
    assistantMessageId: z.string(),
    assistantContent: z.string(),
  }),
  z.strictObject({
    turnId: z.string(),
    userMessageId: z.string(),
    userContent: z.string(),
    errorCode: z.string(),
    retryable: z.boolean(),
  }),
]);
const _MemorySnapshotSchema = z.strictObject({
  memoryId: z.string(),
  memoryRevisionId: z.string(),
  kind: z.enum(["profile", "preference", "instruction", "fact", "episode"]),
  content: z.string(),
});
const LoadedTurnSchema = z.strictObject({
  aiRunId: z.string(),
  chatId: z.string(),
  initiatingUserId: z.string(),
  userMessageId: z.string(),
  userMessage: z.string(),
  locale: z.string(),
  market: z.string(),
  currentDate: z.string(),
  citationNamespace: z.string().regex(/^cn_[A-Za-z0-9_-]{22}$/u),
  acceptanceScope: RunAcceptanceScopeSchema,
});
// Provider output contains only logical document IDs.  Durable Smithers output
// keeps the server-owned binding that retrieval resolved before the task ended.
const PlanTurnWorkflowSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("clarify"), question: z.string() }),
  z.strictObject({
    mode: z.literal("single"),
    question: z.string(),
    relevantTurnIds: z.array(z.string()),
  }),
  z.strictObject({
    mode: z.literal("fanout"),
    question: z.string(),
    topics: z
      .array(
        z.strictObject({
          topicId: z.enum(["t1", "t2", "t3"]),
          question: z.string(),
          relevantTurnIds: z.array(z.string()),
        }),
      )
      .min(2)
      .max(3),
  }),
]);
const MemoryReferenceSchema = z.strictObject({
  memoryId: z.string(),
  memoryRevisionId: z.string(),
});
const WebEvidenceSchema = z.strictObject({
  url: z.string(),
  title: z.string(),
  domain: z.string(),
  quote: z.string(),
  publishedAt: z.string().optional(),
  capturedAt: z.string(),
  purpose: z.string(),
});
const MemorySelectorResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("disabled"),
    reason: z.literal("memory_mode_disabled"),
  }),
  z.strictObject({
    status: z.literal("enabled"),
    entries: z.array(MemoryReferenceSchema),
  }),
]);
const WebSelectorResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("disabled"),
    reason: z.enum(["not_requested", "policy_disabled"]),
  }),
  z.strictObject({
    status: z.literal("enabled"),
    entries: z.array(WebEvidenceSchema),
  }),
]);

const memorySelectorEntries = (result: MemorySelectorResult): readonly MemoryReference[] =>
  result.status === "enabled" ? result.entries : [];
const webSelectorEntries = (result: WebSelectorResult): readonly WebEvidence[] =>
  result.status === "enabled" ? result.entries : [];
const ProviderToolCallSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});
const ProviderMessageSchema = z.union([
  z.strictObject({ role: z.literal("system"), content: z.string() }),
  z.strictObject({ role: z.literal("user"), content: z.string() }),
  z.strictObject({
    role: z.literal("assistant"),
    content: z.string(),
    toolCalls: z.array(ProviderToolCallSchema).optional(),
  }),
  z.strictObject({
    role: z.literal("tool"),
    toolCallId: z.string(),
    name: z.string(),
    content: z.string(),
  }),
]);
const ProviderRequestSchema = z.strictObject({
  requestClass: z.enum(["fast", "main"]),
  // Smithers output is durable live chat state. Historical GLM-5.2 captures
  // are evaluation-only and must fail closed before a resumed Pi call.
  model: z.literal("glm-5-turbo"),
  messages: z.array(ProviderMessageSchema),
  tools: z
    .array(
      z.strictObject({
        name: z.string(),
        description: z.string(),
        parameters: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  toolChoice: z
    .union([z.enum(["auto", "required", "none"]), z.strictObject({ name: z.string() })])
    .optional(),
  responseSchema: z.record(z.string(), z.unknown()).optional(),
  requestedOutputTokens: z.number().int().positive(),
  reasoning: z.enum(["minimal", "low", "medium", "high"]),
});
const DocumentCandidateSchema = z
  .strictObject({
    id: z.string(),
    kind: z.literal("document"),
    rank: z.number().int().nonnegative(),
    purpose: z.string(),
    sourceId: z.string(),
    documentId: z.string(),
    snapshotId: z.string(),
    publisherExtractionId: z.string().trim().min(1).optional(),
    publisherIssueId: z.string().optional(),
    publisherDocumentId: z.string().optional(),
    contentHash: Sha256HexSchema,
    text: z.string(),
    ranges: NormalizedDocumentRangesSchema,
    label: z.string().nullable(),
    publicProvenance: PublicProvenanceSchema,
    renderedTokenCount: z.number().int().nonnegative(),
  })
  .superRefine((candidate, context) => {
    const hasPublisherIssue = candidate.publisherIssueId !== undefined;
    const hasPublisherDocument = candidate.publisherDocumentId !== undefined;
    if (hasPublisherIssue !== hasPublisherDocument) {
      context.addIssue({
        code: "custom",
        path: ["publisherIssueId"],
        message: "publisher document identity must include both publisher fields",
      });
      return;
    }
    if (hasPublisherIssue) {
      if (candidate.publisherExtractionId === undefined) {
        context.addIssue({
          code: "custom",
          path: ["publisherExtractionId"],
          message: "publisher document candidates require an extraction binding",
        });
      }
      if (!PublisherDocumentSourceIdSchema.safeParse(candidate.sourceId).success) {
        context.addIssue({
          code: "custom",
          path: ["sourceId"],
          message: "publisher document candidates require a canonical publisher sourceId",
        });
      }
      if (candidate.publisherDocumentId !== candidate.documentId) {
        context.addIssue({
          code: "custom",
          path: ["publisherDocumentId"],
          message: "publisherDocumentId must equal documentId",
        });
      }
    } else if (!PublicDocumentSourceIdSchema.safeParse(candidate.sourceId).success) {
      context.addIssue({
        code: "custom",
        path: ["sourceId"],
        message: "public document candidates require a canonical public sourceId",
      });
    }
  });

const CandidateSchema = z.discriminatedUnion("kind", [
  DocumentCandidateSchema,
  z.strictObject({
    id: z.string(),
    kind: z.literal("chat_message"),
    rank: z.number().int().nonnegative(),
    purpose: z.string(),
    messageId: z.string(),
    text: z.string(),
    chatRole: z.enum(["user", "assistant"]),
    label: z.string().nullable(),
    renderedTokenCount: z.number().int().nonnegative(),
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal("memory"),
    rank: z.number().int().nonnegative(),
    purpose: z.string(),
    memoryId: z.string(),
    memoryRevisionId: z.string(),
    text: z.string(),
    label: z.string().nullable(),
    renderedTokenCount: z.number().int().nonnegative(),
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal("web"),
    rank: z.number().int().nonnegative(),
    purpose: z.string(),
    url: z.string(),
    title: z.string(),
    domain: z.string(),
    quote: z.string(),
    quoteHash: z.string(),
    publishedAt: z.string().optional(),
    capturedAt: z.string(),
    label: z.string().nullable(),
    renderedTokenCount: z.number().int().nonnegative(),
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal("topic_packet"),
    rank: z.number().int().nonnegative(),
    purpose: z.string(),
    topicId: z.enum(["t1", "t2", "t3"]),
    text: z.string().min(1),
    packetSha256Hex: Sha256HexSchema,
    label: z.string().nullable(),
    renderedTokenCount: z.number().int().nonnegative(),
  }),
]);
const SourceUseSchema = z.strictObject({
  consumerTaskId: z.string(),
  topicId: z.enum(["t1", "t2", "t3"]).optional(),
  contextOrder: z.number().int().nonnegative(),
  renderedTokenCount: z.number().int().nonnegative(),
  ranges: z.array(CharacterRangeSchema),
});
const PublicDocumentLocatorSchema = z.strictObject({
  kind: z.literal("document"),
  sourceId: PublicDocumentSourceIdSchema,
  documentId: z.string(),
  snapshotId: z.string(),
  contentHash: Sha256HexSchema,
  ranges: NormalizedDocumentRangesSchema,
});
const PublisherDocumentLocatorSchema = z
  .strictObject({
    kind: z.literal("document"),
    sourceId: PublisherDocumentSourceIdSchema,
    documentId: z.string(),
    snapshotId: z.string(),
    contentHash: Sha256HexSchema,
    ranges: NormalizedDocumentRangesSchema,
    publisherExtractionId: z.string().trim().min(1),
    publisherIssueId: z.string().trim().min(1),
    publisherDocumentId: z.string().trim().min(1),
  })
  .superRefine((locator, context) => {
    if (locator.publisherDocumentId !== locator.documentId) {
      context.addIssue({
        code: "custom",
        path: ["publisherDocumentId"],
        message: "publisherDocumentId must equal documentId",
      });
    }
  });
const SourceLocatorSchema = z.union([
  PublicDocumentLocatorSchema,
  PublisherDocumentLocatorSchema,
  z.strictObject({ kind: z.literal("chat_message"), messageId: z.string() }),
  z.strictObject({ kind: z.literal("memory"), memoryId: z.string(), memoryRevisionId: z.string() }),
  z.strictObject({
    kind: z.literal("web"),
    url: z.string(),
    title: z.string(),
    domain: z.string(),
    quote: z.string(),
    quoteHash: z.string(),
    publishedAt: z.string().optional(),
    capturedAt: z.string(),
  }),
]);
const SourceRecordSchema = z.strictObject({
  sourceKey: z.string(),
  locator: SourceLocatorSchema,
  label: z.string().nullable(),
  publicProvenance: PublicProvenanceSchema,
  uses: z.array(SourceUseSchema).min(1),
});
const TypedFinalSourceRecordSchema = z.custom<FinalSourceRecord>(
  (value) => SourceRecordSchema.safeParse(value).success,
  "invalid final source record",
);

type ConversationEntryValue = z.infer<typeof ConversationEntrySchema>;
type CandidateValue = z.infer<typeof CandidateSchema>;
type SourceRecordValue = FinalSourceRecord;
type CandidateLedgerValue = z.infer<typeof CandidateLedgerSchema>;

const sanitizedConversationEntry = (entry: ConversationEntryValue): ConversationEntryValue =>
  "assistantContent" in entry
    ? { ...entry, assistantContent: stripHistoricalCitationTags(entry.assistantContent) }
    : entry;

const conversationMatchesLedgerEntry = (
  entry: ConversationEntryValue,
  ledgerEntry: CandidateLedgerValue["candidates"][number] | undefined,
): boolean => {
  if (ledgerEntry === undefined || ledgerEntry.kind !== "conversation_entry") return false;
  const normalized = sanitizedConversationEntry(entry);
  const identity = ledgerEntry.identity;
  return (
    identity.kind === "conversation_entry" &&
    identity.turnId === normalized.turnId &&
    identity.userMessageId === normalized.userMessageId &&
    ("assistantMessageId" in normalized
      ? identity.assistantMessageId === normalized.assistantMessageId
      : identity.assistantMessageId === undefined) &&
    ledgerEntry.text === JSON.stringify(normalized)
  );
};

const sourceMatchesCandidate = (
  candidate: CandidateValue,
  source: SourceRecordValue | undefined,
): boolean => {
  if (candidate.kind === "topic_packet") return false;
  if (source === undefined || source.locator.kind !== candidate.kind) return false;
  switch (candidate.kind) {
    case "document":
      return (
        source.locator.kind === "document" &&
        source.locator.sourceId === candidate.sourceId &&
        source.locator.documentId === candidate.documentId &&
        source.locator.snapshotId === candidate.snapshotId &&
        source.locator.contentHash === candidate.contentHash &&
        JSON.stringify(source.locator.ranges) === JSON.stringify(candidate.ranges) &&
        (candidate.publisherIssueId === undefined ||
          ("publisherIssueId" in source.locator &&
            source.locator.publisherIssueId === candidate.publisherIssueId &&
            source.locator.publisherDocumentId === candidate.publisherDocumentId &&
            source.locator.publisherExtractionId === candidate.publisherExtractionId))
      );
    case "chat_message":
      return (
        source.locator.kind === "chat_message" && source.locator.messageId === candidate.messageId
      );
    case "memory":
      return (
        source.locator.kind === "memory" &&
        source.locator.memoryId === candidate.memoryId &&
        source.locator.memoryRevisionId === candidate.memoryRevisionId
      );
    case "web":
      return (
        source.locator.kind === "web" &&
        source.locator.url === candidate.url &&
        source.locator.quoteHash === candidate.quoteHash &&
        source.locator.capturedAt === candidate.capturedAt
      );
  }
};

const candidateMatchesLedgerEntry = (
  candidate: CandidateValue,
  ledgerEntry: CandidateLedgerValue["candidates"][number] | undefined,
  allowNarrowedDocumentRanges = false,
): boolean => {
  if (ledgerEntry === undefined || candidate.id !== ledgerEntry.candidateId) return false;
  const rawText = candidate.kind === "web" ? candidate.quote : candidate.text;
  const text =
    candidate.kind === "chat_message" && candidate.chatRole === "assistant"
      ? stripHistoricalCitationTags(rawText)
      : rawText;
  if (candidate.kind !== ledgerEntry.kind || text !== ledgerEntry.text) return false;
  const candidateRanges =
    candidate.kind === "document" ? candidate.ranges : [{ charStart: 0, charEnd: text.length }];
  const rangesMatch =
    JSON.stringify(candidateRanges) === JSON.stringify(ledgerEntry.baseRanges) ||
    (allowNarrowedDocumentRanges &&
      candidate.kind === "document" &&
      candidateRanges.every((range) =>
        ledgerEntry.baseRanges.some(
          (baseRange) =>
            range.charStart >= baseRange.charStart && range.charEnd <= baseRange.charEnd,
        ),
      ));
  if (!rangesMatch) return false;
  const candidateDate =
    candidate.kind === "document"
      ? (candidate.publicProvenance.publishedAt ?? null)
      : candidate.kind === "web"
        ? (candidate.publishedAt ?? null)
        : null;
  if (
    ledgerEntry.provenance.label !== candidate.label ||
    ledgerEntry.provenance.purpose !== candidate.purpose ||
    ledgerEntry.provenance.date !== candidateDate
  ) {
    return false;
  }
  const identity = ledgerEntry.identity;
  switch (candidate.kind) {
    case "document":
      return (
        (identity.kind === "public_document" || identity.kind === "publisher_document") &&
        (identity.kind === "public_document"
          ? candidate.sourceId === identity.sourceId
          : candidate.sourceId === `publisher:${identity.subscriptionId}` &&
            candidate.publisherIssueId === identity.issueId &&
            candidate.publisherDocumentId === identity.documentId &&
            candidate.publisherExtractionId === identity.publisherExtractionId) &&
        identity.documentId === candidate.documentId &&
        identity.snapshotId === candidate.snapshotId &&
        identity.contentHash === candidate.contentHash
      );
    case "chat_message":
      return identity.kind === "chat_message" && identity.messageId === candidate.messageId;
    case "memory":
      return (
        identity.kind === "memory" &&
        identity.memoryId === candidate.memoryId &&
        identity.memoryRevisionId === candidate.memoryRevisionId
      );
    case "web":
      return (
        identity.kind === "web" &&
        identity.canonicalUrl === candidate.url &&
        identity.quoteHash === candidate.quoteHash &&
        identity.capturedAt === candidate.capturedAt
      );
    case "topic_packet":
      return (
        identity.kind === "topic_packet" &&
        identity.topicId === candidate.topicId &&
        identity.packetSha256Hex === candidate.packetSha256Hex
      );
  }
};

const ledgerEntryMatchesSource = (
  ledgerEntry: CandidateLedgerValue["candidates"][number] | undefined,
  source: SourceRecordValue | undefined,
): boolean => {
  if (ledgerEntry === undefined || source === undefined) return false;
  const identity = ledgerEntry.identity;
  const locator = source.locator;
  if (identity.kind === "conversation_entry") return false;
  if (identity.kind === "topic_packet") return false;
  if (identity.kind === "public_document") {
    return (
      locator.kind === "document" &&
      locator.sourceId === identity.sourceId &&
      locator.documentId === identity.documentId &&
      locator.snapshotId === identity.snapshotId &&
      locator.contentHash === identity.contentHash
    );
  }
  if (identity.kind === "publisher_document") {
    return (
      locator.kind === "document" &&
      locator.sourceId === `publisher:${identity.subscriptionId}` &&
      locator.documentId === identity.documentId &&
      locator.snapshotId === identity.snapshotId &&
      locator.contentHash === identity.contentHash &&
      "publisherIssueId" in locator &&
      locator.publisherIssueId === identity.issueId &&
      locator.publisherDocumentId === identity.documentId &&
      locator.publisherExtractionId === identity.publisherExtractionId
    );
  }
  if (identity.kind === "chat_message") {
    return locator.kind === "chat_message" && locator.messageId === identity.messageId;
  }
  if (identity.kind === "memory") {
    return (
      locator.kind === "memory" &&
      locator.memoryId === identity.memoryId &&
      locator.memoryRevisionId === identity.memoryRevisionId
    );
  }
  return (
    locator.kind === "web" &&
    locator.url === identity.canonicalUrl &&
    locator.quoteHash === identity.quoteHash &&
    locator.capturedAt === identity.capturedAt
  );
};

const validateConversationLedgerBinding = (
  ledger: CandidateLedgerValue,
  selectedConversation: readonly ConversationEntryValue[],
  context: z.RefinementCtx,
  path: string,
  allowReducedSelection: boolean,
  ledgerConversation?: readonly ConversationEntryValue[] | undefined,
): number => {
  const prefixCount = ledger.candidates.findIndex(
    (candidate) => candidate.kind !== "conversation_entry",
  );
  const conversationCount = prefixCount === -1 ? ledger.candidates.length : prefixCount;
  const prefix = ledger.candidates.slice(0, conversationCount);
  if (ledger.candidates.length === 0 && selectedConversation.length > 0) {
    context.addIssue({
      code: "custom",
      path: [path],
      message: "selected conversation requires a non-empty candidate ledger",
    });
  }
  const canonicalConversation = ledgerConversation ?? selectedConversation;
  if (canonicalConversation.length !== conversationCount) {
    context.addIssue({
      code: "custom",
      path: [path],
      message: "selected conversation must equal the ledger conversation prefix",
    });
  }
  for (let index = 0; index < canonicalConversation.length; index += 1) {
    if (!conversationMatchesLedgerEntry(canonicalConversation[index]!, prefix[index])) {
      context.addIssue({
        code: "custom",
        path: [path, index],
        message: "conversation entry does not match its ordered ledger identity or sanitized text",
      });
    }
  }
  if (
    ledger.candidates
      .slice(conversationCount)
      .some((candidate) => candidate.kind === "conversation_entry")
  ) {
    context.addIssue({
      code: "custom",
      path: ["candidateLedger", "candidates"],
      message: "conversation entries must form one ordered ledger prefix",
    });
  }
  if (allowReducedSelection && ledgerConversation !== undefined) {
    let cursor = 0;
    for (const entry of selectedConversation) {
      const next = ledgerConversation
        .slice(cursor)
        .findIndex(
          (candidate) =>
            JSON.stringify(sanitizedConversationEntry(candidate)) ===
            JSON.stringify(sanitizedConversationEntry(entry)),
        );
      if (next < 0) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: "active conversation is not an ordered subset of the ledger conversation",
        });
        break;
      }
      cursor += next + 1;
    }
  }
  return conversationCount;
};

const validateEvidenceLedgerBinding = (
  ledger: CandidateLedgerValue,
  conversationCount: number,
  candidates: readonly CandidateValue[],
  sourceMap: readonly SourceRecordValue[],
  context: z.RefinementCtx,
  path: string,
  requireComplete: boolean,
): void => {
  const suffix = ledger.candidates.slice(conversationCount);
  if (requireComplete && candidates.length !== suffix.length) {
    context.addIssue({
      code: "custom",
      path: [path],
      message: "evidence candidates must match the complete ledger suffix",
    });
  }
  const citableCandidates = candidates.filter((candidate) => candidate.kind !== "topic_packet");
  if (sourceMap.length !== citableCandidates.length) {
    context.addIssue({
      code: "custom",
      path: ["sourceMap"],
      message: "source map must match citable evidence candidate cardinality",
    });
  }
  let suffixCursor = 0;
  let sourceIndex = 0;
  for (const [index, candidate] of candidates.entries()) {
    const expected = requireComplete
      ? suffix[index]
      : suffix.find((entry) => entry.candidateId === candidate.id);
    if (expected === undefined || candidate.id !== expected.candidateId) {
      context.addIssue({
        code: "custom",
        path: [path, index, "id"],
        message: "evidence candidate IDs must match the ordered ledger suffix",
      });
      continue;
    }
    if (!candidateMatchesLedgerEntry(candidate, expected, !requireComplete)) {
      context.addIssue({
        code: "custom",
        path: [path, index],
        message: "evidence candidate does not match its immutable ledger entry",
      });
    }
    if (!requireComplete) {
      const expectedIndex = suffix.indexOf(expected);
      if (expectedIndex < suffixCursor) {
        context.addIssue({
          code: "custom",
          path: [path, index, "id"],
          message: "evidence candidates must preserve ledger order",
        });
      }
      suffixCursor = expectedIndex + 1;
    }
    if (candidate.kind === "topic_packet") continue;
    const source = sourceMap[sourceIndex];
    sourceIndex += 1;
    if (!sourceMatchesCandidate(candidate, source)) {
      context.addIssue({
        code: "custom",
        path: ["sourceMap", sourceIndex - 1],
        message: "source map entry does not match its citable evidence candidate",
      });
    }
    if (!ledgerEntryMatchesSource(expected, source)) {
      context.addIssue({
        code: "custom",
        path: ["sourceMap", sourceIndex - 1],
        message: "source map entry does not match its ordered ledger identity",
      });
    }
  }
};

const ContextAssemblySchema = z
  .strictObject({
    question: z.string(),
    topicId: z.enum(["t1", "t2", "t3"]).optional(),
    candidates: z.array(CandidateSchema),
    candidateLedger: CandidateLedgerSchema,
    sourceMap: z.array(TypedFinalSourceRecordSchema),
    selectedConversation: z.array(ConversationEntrySchema),
    gaps: z.array(z.string()),
    consumerTaskId: z.string(),
    requestedOutputTokens: z.number().int().positive(),
  })
  .superRefine((value, context) => {
    const conversationCount = validateConversationLedgerBinding(
      value.candidateLedger,
      value.selectedConversation,
      context,
      "selectedConversation",
      false,
    );
    const evidence = value.candidateLedger.candidates.filter(
      (candidate) => candidate.kind !== "conversation_entry",
    );
    if (value.candidates.length !== evidence.length) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "assembled candidates must match the required ledger cardinality",
      });
    }
    for (const [index, candidate] of value.candidates.entries()) {
      if (candidate.id !== evidence[index]?.candidateId) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "id"],
          message: "candidate IDs must come from the ordered code-owned ledger",
        });
      }
    }
    if (value.sourceMap.length !== value.candidates.length) {
      context.addIssue({
        code: "custom",
        path: ["sourceMap"],
        message: "source map must match assembled candidate cardinality",
      });
    }
    validateEvidenceLedgerBinding(
      value.candidateLedger,
      conversationCount,
      value.candidates,
      value.sourceMap,
      context,
      "candidates",
      true,
    );
  });
const ContextSchema = z
  .strictObject({
    status: z.enum(["ready", "needs_compaction", "failed"]),
    question: z.string(),
    topicId: z.enum(["t1", "t2", "t3"]).optional(),
    candidates: z.array(CandidateSchema),
    candidateLedger: CandidateLedgerSchema,
    sourceMap: z.array(TypedFinalSourceRecordSchema),
    /** Original topic evidence retained for final citations, not provider input. */
    citationSourceMap: z.array(TypedFinalSourceRecordSchema).optional(),
    ledgerCandidates: z.array(CandidateSchema),
    ledgerSourceMap: z.array(TypedFinalSourceRecordSchema),
    selectedConversation: z.array(ConversationEntrySchema),
    ledgerConversation: z.array(ConversationEntrySchema).optional(),
    ledgerConversationTokenCounts: z.array(z.number().int()).optional(),
    chatSourceRanges: z
      .array(z.strictObject({ messageId: z.string(), ranges: z.array(CharacterRangeSchema) }))
      .optional(),
    consumers: z.array(
      z.strictObject({
        consumer: z.enum(["direct", "topic", "synthesis"]),
        topicId: z.enum(["t1", "t2", "t3"]).optional(),
        inputTokens: z.number().int(),
        requestedOutputTokens: z.number().int().positive(),
        usableInputTokens: z.number().int(),
      }),
    ),
    gaps: z.array(z.string()),
    ledgerGaps: z.array(z.string()).optional(),
    compactionFeedback: z.array(z.string()),
    request: ProviderRequestSchema,
    inputTokens: z.number().int(),
    usableInputTokens: z.number().int(),
    compactionRan: z.boolean(),
    failureCode: z
      .enum([
        "context_mandatory_too_large",
        "context_plan_unfit",
        "context_budget_mismatch",
        "synthesis_budget_mismatch",
      ])
      .optional(),
  })
  .superRefine((value, context) => {
    const conversationCount = validateConversationLedgerBinding(
      value.candidateLedger,
      value.selectedConversation,
      context,
      "selectedConversation",
      true,
      value.ledgerConversation,
    );
    const evidence = value.candidateLedger.candidates.filter(
      (candidate) => candidate.kind !== "conversation_entry",
    );
    const ledgerIds = new Set(evidence.map((candidate) => candidate.candidateId));
    if (value.ledgerCandidates.length !== evidence.length) {
      context.addIssue({
        code: "custom",
        path: ["ledgerCandidates"],
        message: "ledger candidate view must match the required ledger cardinality",
      });
    }
    const citableCandidates = value.candidates.filter(
      (candidate) => candidate.kind !== "topic_packet",
    );
    if (value.sourceMap.length !== citableCandidates.length) {
      context.addIssue({
        code: "custom",
        path: ["sourceMap"],
        message: "source map must match active citable candidate cardinality",
      });
    }
    for (const [index, candidate] of value.ledgerCandidates.entries()) {
      if (candidate.id !== evidence[index]?.candidateId) {
        context.addIssue({
          code: "custom",
          path: ["ledgerCandidates", index, "id"],
          message: "ledger candidate IDs must come from the ordered code-owned ledger",
        });
      }
    }
    const activeIds = new Set<string>();
    for (const [index, candidate] of value.candidates.entries()) {
      if (!ledgerIds.has(candidate.id)) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "id"],
          message: "active candidates must come from the code-owned ledger",
        });
      }
      if (activeIds.has(candidate.id)) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "id"],
          message: "active candidate IDs must be unique",
        });
      }
      activeIds.add(candidate.id);
    }
    validateEvidenceLedgerBinding(
      value.candidateLedger,
      conversationCount,
      value.ledgerCandidates,
      value.ledgerSourceMap,
      context,
      "ledgerCandidates",
      true,
    );
    validateEvidenceLedgerBinding(
      value.candidateLedger,
      conversationCount,
      value.candidates,
      value.sourceMap,
      context,
      "candidates",
      false,
    );
  });
const CompactionGroupSchema = z.strictObject({
  groupId: z.string().regex(/^g[1-9][0-9]*$/u),
  candidateIds: z.array(z.string().regex(/^c[1-9][0-9]*$/u)),
  renderedTokenBudget: z.number().int().positive(),
  mode: z.enum(["normal", "source_tool"]),
});
const CompactionSelectionSchema = z.strictObject({
  candidateId: z.string().regex(/^c[1-9][0-9]*$/u),
  action: z.enum(["keep", "range", "omit"]),
  groupId: z
    .string()
    .regex(/^g[1-9][0-9]*$/u)
    .optional(),
  passageIds: z.array(z.string().regex(/^p[1-9][0-9]*$/u)),
  ranges: z.array(CharacterRangeSchema),
});
const CompactionPassSchema = z.strictObject({
  phase: z.enum(["compact", "fallback"]),
  groups: z.array(CompactionGroupSchema),
  taskIds: z.array(z.string().min(1)),
  envelopes: z.array(GroupResultEnvelopeSchema),
  selections: z.array(CompactionSelectionSchema),
  repairUsed: z.boolean(),
});
const CompactionPlanSchema = z.strictObject({
  manifest: InitialContextManifestSchema,
  groups: z.array(CompactionGroupSchema),
});
const FallbackCompactionPlanSchema = z.strictObject({
  manifest: FallbackContextManifestSchema,
  groups: z.array(CompactionGroupSchema),
});
const CompactionCollectionSchema = CompactionPassSchema;
const parseContextValue = (value: unknown): ContextState => {
  const parsed = ContextSchema.parse(value);
  return {
    ...parsed,
    candidateLedger: {
      candidates: parsed.candidateLedger.candidates.map((candidate) => ({
        ...candidate,
        candidateId: candidateLocalId(Number(candidate.candidateId.slice(1))),
      })),
    },
  };
};
const parseCompactionCollection = (value: unknown): CompactionPassResult => {
  const parsedEnvelope = aiChatSchemas.aiChatCompactionCollect.parse(value);
  return CompactionCollectionSchema.parse(parsedEnvelope.value);
};
const exactMeasurementFromContext = (state: ContextState): ExactContextMeasurement => ({
  fits: state.status === "ready",
  inputTokens: state.inputTokens,
  usableInputTokens: state.usableInputTokens,
  overByTokens: Math.max(0, state.inputTokens - state.usableInputTokens),
});
const AnswerSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"),
    mode: z.enum(["clarification", "single", "synthesis"]),
    content: z.string(),
    sourceMap: z.array(SourceRecordSchema),
  }),
  z.strictObject({ status: z.literal("failed"), code: z.string(), retryable: z.boolean() }),
]);
const MemoryExtractionResultSchema = z.strictObject({
  proposals: z.array(
    z.strictObject({
      kind: z.enum(["profile", "preference", "instruction", "fact", "episode"]),
      content: z.string(),
      targetMemoryId: z.string().optional(),
      expectedHeadRevisionId: z.string().optional(),
    }),
  ),
  discardedCount: z.number().int().min(0),
});
const MemoryExtractionSchema = z.strictObject({
  result: MemoryExtractionResultSchema,
  producer: z.strictObject({
    taskId: z.enum(["memory-extract", "evaluation-general-planner"]),
    loopIteration: z.number().int().min(0),
    attempt: z.number().int().min(0),
    observationKey: z.string().min(1),
    extractionSha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
const TopicPacketSchema = z.strictObject({
  topicId: z.enum(["t1", "t2", "t3"]),
  status: z.enum(["answered", "partial"]),
  claims: z.array(z.strictObject({ text: z.string(), sourceKeys: z.array(z.string()) })),
  gaps: z.array(z.string()),
});
const StructuredRetrievalIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("public_document"),
    sourceId: z.string().min(1),
    documentId: z.string().min(1),
    snapshotId: z.string().min(1),
    contentHash: Sha256HexSchema,
  }),
  z.strictObject({
    kind: z.literal("publisher_document"),
    subscriptionId: z.string().min(1),
    issueId: z.string().min(1),
    documentId: z.string().min(1),
    snapshotId: z.string().min(1),
    publisherExtractionId: z.string().min(1),
    contentHash: Sha256HexSchema,
  }),
  z.strictObject({
    kind: z.literal("chat_message"),
    messageId: z.string().min(1),
    sanitizedContentHash: Sha256HexSchema,
  }),
]);
const StructuredPhysicalValueSchema = z.strictObject({
  kind: z.enum(["document", "chat_message"]),
  label: z.string().nullable(),
  date: z.string().nullable(),
  textCharCount: z.number().int().nonnegative(),
  sourceName: z.string().optional(),
  tokenCount: z.number().int().nonnegative(),
  fullTokenCount: z.number().int().nonnegative(),
  preview: z.string(),
  previewRanges: z.array(CharacterRangeSchema),
  text: z.string(),
  snapshotId: z.string().min(1),
  contentHash: Sha256HexSchema,
  publisherExtractionId: z.string().min(1).optional(),
  fastTokenCount: z.number().int().nonnegative(),
  mainTokenCount: z.number().int().nonnegative(),
  previewBytes: z.union([z.instanceof(Uint8Array), z.array(z.number().int().nonnegative())]),
});
const StructuredFusedResultSchema = z.strictObject({
  ...FusedResultSchema.shape,
  identity: StructuredRetrievalIdentitySchema,
  physicalIdentities: z.array(StructuredRetrievalIdentitySchema).min(1).optional(),
  value: StructuredPhysicalValueSchema,
});
const StructuredFusedSetSchema = z.strictObject({
  ...FusedResultSetSchema.shape,
  results: z.array(StructuredFusedResultSchema),
});
const StructuredBranchResultSchema = z.strictObject({
  queryOrdinal: z.number().int().positive(),
  branch: z.enum(PHYSICAL_QUERY_BRANCHES),
  order: z.enum(["relevance", "newest", "oldest"]).optional(),
  status: z.enum(["applicable", "not_applicable"]),
  reason: BranchReasonCodeSchema.optional(),
  hits: z.array(
    z.strictObject({
      queryOrdinal: z.number().int().positive(),
      branch: z.enum(PHYSICAL_QUERY_BRANCHES),
      rank: z.number().int().positive(),
      identity: StructuredRetrievalIdentitySchema,
      value: StructuredPhysicalValueSchema.pick({
        kind: true,
        label: true,
        date: true,
        textCharCount: true,
        sourceName: true,
      }),
      date: z.string().nullable().optional(),
    }),
  ),
  cap: z.number().int().positive(),
  truncated: z.boolean(),
});
const StructuredPreviewExposureSchema = z.strictObject({
  identity: StructuredRetrievalIdentitySchema,
  snapshotId: z.string().min(1),
  contentHash: Sha256HexSchema,
  publisherExtractionId: z.string().min(1).optional(),
  previewRanges: z.array(CharacterRangeSchema),
  previewBytes: z.union([z.instanceof(Uint8Array), z.array(z.number().int().nonnegative())]),
  fastTokenCount: z.number().int().nonnegative(),
  mainTokenCount: z.number().int().nonnegative(),
});
const StructuredRetrievalResultSchema = z.union([
  z.null(),
  z.strictObject({
    queryPlan: InternalQueryPlanSchema,
    branches: z.array(StructuredBranchResultSchema),
    fused: StructuredFusedSetSchema,
    review: z.array(ReviewModelFusedResultSchema),
    previewExposures: z.array(StructuredPreviewExposureSchema),
  }),
]);

export const aiChatSchemas = {
  input: z.strictObject({ aiRunId: z.string() }),
  aiChatLoadTurn: z.strictObject({ value: LoadedTurnSchema }),
  aiChatMemory: z.strictObject({ value: MemoryExtractionSchema }),
  aiChatPlanTurn: z.strictObject({ value: PlanTurnWorkflowSchema }),
  aiChatStructuredInternal: z.strictObject({ value: StructuredRetrievalResultSchema }),
  aiChatMemories: z.strictObject({ value: MemorySelectorResultSchema }),
  aiChatWeb: z.strictObject({ value: WebSelectorResultSchema }),
  aiChatAssembly: z.strictObject({ value: ContextAssemblySchema }),
  aiChatContext: z.strictObject({ value: ContextSchema }),
  aiChatCompactionPlan: z.strictObject({ value: CompactionPlanSchema }),
  aiChatCompactionGroup: z.strictObject({ value: GroupResultEnvelopeSchema }),
  aiChatCompactionCollect: z.strictObject({ value: CompactionCollectionSchema }),
  aiChatFallbackPlan: z.strictObject({ value: FallbackCompactionPlanSchema }),
  aiChatAnswer: z.strictObject({ value: AnswerSchema }),
  aiChatAllocation: z.strictObject({
    value: z.strictObject({
      packetOutputTokens: z.number().int().positive(),
      synthesisUsableInput: z.number().int(),
      fixedSynthesisInput: z.number().int(),
    }),
  }),
  aiChatFanoutSources: z.strictObject({
    value: z.strictObject({
      sources: z.array(z.strictObject({ identityKey: z.string(), sourceKey: z.string() })),
    }),
  }),
  aiChatTopicResult: z.strictObject({
    status: z.enum(["ok", "failed"]),
    packet: TopicPacketSchema.optional(),
    code: z.string().optional(),
    retryable: z.boolean(),
  }),
  aiChatFanoutCollect: z.strictObject({
    status: z.enum(["ok", "failed"]),
    packets: z.array(TopicPacketSchema),
    sourceMap: z.array(SourceRecordSchema),
    contexts: z.array(ContextSchema),
    code: z.string().optional(),
    retryable: z.boolean(),
  }),
  aiChatFinalize: z.strictObject({
    status: z.enum(["succeeded", "failed"]),
    assistantMessageId: z.string().optional(),
    code: z.string().optional(),
    alreadyTerminal: z.boolean(),
  }),
};

// Smithers adds its own persisted run key to non-payload input rows when it
// re-renders a durable workflow. It is framework metadata rather than a
// product input and therefore cannot be part of the `input` table shape (the
// table reserves `runId`), but it is the one additional key accepted at the
// workflow boundary. Keep this parser strict so arbitrary input keys still
// fail closed.
export const aiChatRuntimeInputSchema = aiChatSchemas.input.extend({
  runId: z.string().optional(),
});
export type AiChatSchemas = typeof aiChatSchemas;
export type AiChatWorkflow = ReturnType<CreateSmithersApi<AiChatSchemas>["smithers"]>;

export interface AiChatWorkflowRuntime {
  readonly config: Pick<
    WorkerConfig,
    | "aiFastTaskTimeoutMs"
    | "aiAnswerTimeoutMs"
    | "aiTopicResearchMaxConcurrency"
    | "aiTopicAnswerMaxConcurrency"
  >;
  readonly operations: CanonicalWorkflowOperations;
}

export const AI_CHAT_SINGLE_SELECTOR_MAX_CONCURRENCY = 3;
export const AI_CHAT_MEMORY_LANE_CONCURRENCY = 1;
export const AI_CHAT_TURN_LANE_MAX_CONCURRENCY = 2;

export const aiChatSmithersMaxConcurrency = (
  config: Pick<
    AiChatWorkflowRuntime["config"],
    "aiTopicResearchMaxConcurrency" | "aiTopicAnswerMaxConcurrency"
  >,
): number =>
  AI_CHAT_MEMORY_LANE_CONCURRENCY +
  Math.max(
    AI_CHAT_SINGLE_SELECTOR_MAX_CONCURRENCY,
    config.aiTopicResearchMaxConcurrency,
    config.aiTopicAnswerMaxConcurrency,
  );

export const aiChatRetryPolicy = Object.freeze({
  backoff: "exponential" as const,
  initialDelayMs: 250,
});
const controlledFailure = (
  code: AiRunErrorCode,
  retryableOverride?: boolean,
): AnswerLaneResult => ({
  status: "failed",
  code,
  retryable: retryableOverride ?? isRetryableAiRunError(code),
});

const parseRunId = (input: unknown): string => aiChatRuntimeInputSchema.parse(input).aiRunId;

export function buildAiChatWorkflow(
  api: CreateSmithersApi<AiChatSchemas>,
  runtime: AiChatWorkflowRuntime,
): AiChatWorkflow {
  const { Workflow, Task, Sequence, Parallel, Branch, smithers, outputs } = api;
  const fast = runtime.config.aiFastTaskTimeoutMs;
  const answerTimeout = runtime.config.aiAnswerTimeoutMs;
  const retryPolicy = aiChatRetryPolicy;

  const workflow = smithers((ctx) => {
    const load = () =>
      ctx.output(outputs.aiChatLoadTurn, { nodeId: "load-turn" }).value as LoadedTurn;
    const planTurnMaybe = ctx.outputMaybe(outputs.aiChatPlanTurn, {
      nodeId: "plan-turn",
    })?.value as PlanTurnResult | undefined;
    const topics = planTurnMaybe?.mode === "fanout" ? planTurnMaybe.topics : [];

    const CompactionFlow = ({ prefix, initialNode }: { prefix: string; initialNode: string }) => {
      const contextOutput = (nodeId: string): ContextState | undefined => {
        const output = ctx.outputMaybe(outputs.aiChatContext, { nodeId });
        return output === undefined ? undefined : parseContextValue(output.value);
      };
      const initial = contextOutput(initialNode);
      const compactPlanOutput = ctx.outputMaybe(outputs.aiChatCompactionPlan, {
        nodeId: `${prefix}-compact-plan`,
      });
      const compactPlan =
        compactPlanOutput === undefined
          ? undefined
          : aiChatSchemas.aiChatCompactionPlan.parse(compactPlanOutput).value;
      const compactCollectionOutput = ctx.outputMaybe(outputs.aiChatCompactionCollect, {
        nodeId: `${prefix}-compact-collect`,
      });
      const compactCollection =
        compactCollectionOutput === undefined
          ? undefined
          : parseCompactionCollection(compactCollectionOutput);
      const compactMeasure = contextOutput(`${prefix}-compact-measure`);
      const fallbackPlanOutput = ctx.outputMaybe(outputs.aiChatFallbackPlan, {
        nodeId: `${prefix}-fallback-plan`,
      });
      const fallbackPlan =
        fallbackPlanOutput === undefined
          ? undefined
          : aiChatSchemas.aiChatFallbackPlan.parse(fallbackPlanOutput).value;
      const fallbackMeasure = contextOutput(`${prefix}-fallback-measure`);
      const firstState = initial?.status === "needs_compaction" ? initial : undefined;
      const compactGroups = compactPlan?.groups ?? [];
      const fallbackGroups = fallbackPlan?.groups ?? [];
      const compactResults = compactGroups.map((group, index) => {
        const taskId = compactionGroupTaskId(prefix, "compact", index + 1);
        return (
          <Task
            key={taskId}
            id={taskId}
            output={outputs.aiChatCompactionGroup}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => {
              if (firstState === undefined) throw new Error("compaction state is unavailable");
              return {
                value: await runtime.operations.compactContextGroup(
                  load(),
                  firstState,
                  group,
                  taskId,
                ),
              };
            }}
          </Task>
        );
      });
      const fallbackResults = fallbackGroups.map((group, index) => {
        const taskId = compactionGroupTaskId(prefix, "fallback", index + 1);
        const priorResult = compactCollection?.envelopes.find(
          (envelope) => envelope.groupId === group.groupId,
        );
        return (
          <Task
            key={taskId}
            id={taskId}
            output={outputs.aiChatCompactionGroup}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => {
              const context = compactMeasure;
              if (context === undefined) throw new Error("fallback context is unavailable");
              return {
                value: await runtime.operations.compactContextGroup(
                  load(),
                  context,
                  group,
                  taskId,
                  "fallback",
                  priorResult,
                ),
              };
            }}
          </Task>
        );
      });
      const compactPass =
        firstState !== undefined && compactPlan !== undefined ? (
          <Sequence>
            <Parallel id={`${prefix}-compact-groups`} maxConcurrency={MAX_COMPACTION_CONCURRENCY}>
              {compactResults}
            </Parallel>
            <Task
              id={`${prefix}-compact-collect`}
              output={outputs.aiChatCompactionCollect}
              retries={2}
              retryPolicy={retryPolicy}
              timeoutMs={fast}
            >
              {async () => {
                const envelopes = compactGroups.map((group, index) =>
                  GroupResultEnvelopeSchema.parse(
                    ctx.output(outputs.aiChatCompactionGroup, {
                      nodeId: compactionGroupTaskId(prefix, "compact", index + 1),
                    }).value,
                  ),
                );
                return {
                  value: await runtime.operations.collectCompaction(
                    load(),
                    firstState,
                    compactPlan.manifest,
                    compactGroups,
                    envelopes,
                    `${prefix}-compact-collect`,
                  ),
                };
              }}
            </Task>
            <Task
              id={`${prefix}-compact-measure`}
              output={outputs.aiChatContext}
              retries={2}
              retryPolicy={retryPolicy}
              timeoutMs={fast}
            >
              {async () => {
                const pass = parseCompactionCollection(
                  ctx.output(outputs.aiChatCompactionCollect, {
                    nodeId: `${prefix}-compact-collect`,
                  }),
                );
                return {
                  value: await runtime.operations.measureCompaction(
                    load(),
                    firstState,
                    pass,
                    `${prefix}-compact-measure`,
                  ),
                };
              }}
            </Task>
          </Sequence>
        ) : null;
      const fallbackPass =
        compactMeasure?.status === "needs_compaction" &&
        compactCollection !== undefined &&
        fallbackPlan !== undefined ? (
          <Sequence>
            <Parallel id={`${prefix}-fallback-groups`} maxConcurrency={MAX_COMPACTION_CONCURRENCY}>
              {fallbackResults}
            </Parallel>
            <Task
              id={`${prefix}-fallback-collect`}
              output={outputs.aiChatCompactionCollect}
              retries={2}
              retryPolicy={retryPolicy}
              timeoutMs={fast}
            >
              {async () => {
                const envelopes = fallbackGroups.map((group, index) =>
                  GroupResultEnvelopeSchema.parse(
                    ctx.output(outputs.aiChatCompactionGroup, {
                      nodeId: compactionGroupTaskId(prefix, "fallback", index + 1),
                    }).value,
                  ),
                );
                return {
                  value: await runtime.operations.collectFallbackCompaction(
                    load(),
                    compactMeasure,
                    fallbackPlan.manifest,
                    fallbackGroups,
                    envelopes,
                    compactCollection,
                    `${prefix}-fallback-collect`,
                  ),
                };
              }}
            </Task>
            <Task
              id={`${prefix}-fallback-measure`}
              output={outputs.aiChatContext}
              retries={2}
              retryPolicy={retryPolicy}
              timeoutMs={fast}
            >
              {async () => {
                const pass = parseCompactionCollection(
                  ctx.output(outputs.aiChatCompactionCollect, {
                    nodeId: `${prefix}-fallback-collect`,
                  }),
                );
                return {
                  value: await runtime.operations.measureCompaction(
                    load(),
                    compactMeasure,
                    pass,
                    `${prefix}-fallback-measure`,
                  ),
                };
              }}
            </Task>
          </Sequence>
        ) : null;
      return (
        <Sequence>
          {initial?.status === "needs_compaction" ? (
            <Sequence>
              {compactPlan === undefined ? (
                <Task
                  id={`${prefix}-compact-plan`}
                  output={outputs.aiChatCompactionPlan}
                  retries={2}
                  retryPolicy={retryPolicy}
                  timeoutMs={fast}
                >
                  {async () => {
                    const state = parseContextValue(
                      ctx.output(outputs.aiChatContext, { nodeId: initialNode }).value,
                    );
                    const manifest = await runtime.operations.initialCompactionManifest(
                      load(),
                      state,
                      `${prefix}-compact-plan`,
                    );
                    const groups = await runtime.operations.createCompactionGroups(
                      load(),
                      state,
                      manifest,
                      `${prefix}-compact-plan`,
                    );
                    return { value: { manifest, groups } };
                  }}
                </Task>
              ) : null}
              {compactPlan !== undefined ? compactPass : null}
              {compactMeasure?.status === "needs_compaction" && compactCollection !== undefined ? (
                <Sequence>
                  {fallbackPlan === undefined ? (
                    <Task
                      id={`${prefix}-fallback-plan`}
                      output={outputs.aiChatFallbackPlan}
                      retries={2}
                      retryPolicy={retryPolicy}
                      timeoutMs={fast}
                    >
                      {async () => {
                        const collection = parseCompactionCollection(
                          ctx.output(outputs.aiChatCompactionCollect, {
                            nodeId: `${prefix}-compact-collect`,
                          }),
                        );
                        const state = parseContextValue(
                          ctx.output(outputs.aiChatContext, {
                            nodeId: `${prefix}-compact-measure`,
                          }).value,
                        );
                        const initialPlan = aiChatSchemas.aiChatCompactionPlan.parse(
                          ctx.output(outputs.aiChatCompactionPlan, {
                            nodeId: `${prefix}-compact-plan`,
                          }),
                        ).value;
                        const manifest = await runtime.operations.fallbackCompactionManifest(
                          load(),
                          state,
                          initialPlan.manifest,
                          collection,
                          exactMeasurementFromContext(state),
                          `${prefix}-fallback-plan`,
                        );
                        const groups = await runtime.operations.createFallbackCompactionGroups(
                          load(),
                          state,
                          initialPlan.manifest,
                          collection,
                          manifest,
                          `${prefix}-fallback-plan`,
                        );
                        return { value: { manifest, groups } };
                      }}
                    </Task>
                  ) : null}
                  {fallbackPlan !== undefined ? fallbackPass : null}
                </Sequence>
              ) : null}
            </Sequence>
          ) : null}
          <Task
            id={`${prefix}-context-select`}
            output={outputs.aiChatContext}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => {
              const state = fallbackMeasure ?? compactMeasure ?? initial;
              if (state === undefined) throw new Error("context selection state is unavailable");
              return {
                value: await runtime.operations.selectCompactionContext(
                  load(),
                  state,
                  `${prefix}-context-select`,
                ),
              };
            }}
          </Task>
        </Sequence>
      );
    };

    const SingleAnswerFlow = () => {
      const selected = ctx.outputMaybe(outputs.aiChatContext, { nodeId: "single-answer-route" })
        ?.value as ContextState | undefined;
      return (
        <Sequence>
          <Parallel id="single-selectors" maxConcurrency={AI_CHAT_SINGLE_SELECTOR_MAX_CONCURRENCY}>
            <Task
              id="single-retrieve-internal"
              output={outputs.aiChatStructuredInternal}
              retries={2}
              retryPolicy={retryPolicy}
              timeoutMs={fast}
            >
              {async () => {
                const plan = ctx.output(outputs.aiChatPlanTurn, {
                  nodeId: "plan-turn",
                }).value as Extract<PlanTurnResult, { mode: "single" }>;
                return {
                  value: await runtime.operations.retrieveStructuredInternal(
                    load(),
                    plan.question,
                    "single-retrieve-internal",
                    plan.relevantTurnIds,
                  ),
                };
              }}
            </Task>
            <Task
              id="single-select-memories"
              output={outputs.aiChatMemories}
              retries={2}
              retryPolicy={retryPolicy}
              timeoutMs={fast}
            >
              {async () => {
                const plan = ctx.output(outputs.aiChatPlanTurn, {
                  nodeId: "plan-turn",
                }).value as Extract<PlanTurnResult, { mode: "single" }>;
                return {
                  value: await runtime.operations.selectMemories(
                    load(),
                    plan.question,
                    "single-select-memories",
                  ),
                };
              }}
            </Task>
            <Task
              id="single-retrieve-web"
              output={outputs.aiChatWeb}
              retries={2}
              retryPolicy={retryPolicy}
              timeoutMs={fast}
            >
              {async () => {
                const plan = ctx.output(outputs.aiChatPlanTurn, {
                  nodeId: "plan-turn",
                }).value as Extract<PlanTurnResult, { mode: "single" }>;
                return {
                  value: await runtime.operations.retrieveWeb(
                    load(),
                    plan.question,
                    "single-retrieve-web",
                  ),
                };
              }}
            </Task>
          </Parallel>
          <Task
            id="single-assemble"
            output={outputs.aiChatAssembly}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => {
              const plan = ctx.output(outputs.aiChatPlanTurn, {
                nodeId: "plan-turn",
              }).value as Extract<PlanTurnResult, { mode: "single" }>;
              const selectors: SelectorBundle = {
                structuredInternal: ctx.output(outputs.aiChatStructuredInternal, {
                  nodeId: "single-retrieve-internal",
                }).value as RetrievalPlanResult | null,
                memories: memorySelectorEntries(
                  ctx.output(outputs.aiChatMemories, { nodeId: "single-select-memories" }).value,
                ),
                memorySelection: ctx.output(outputs.aiChatMemories, {
                  nodeId: "single-select-memories",
                }).value.status,
                web: webSelectorEntries(
                  ctx.output(outputs.aiChatWeb, { nodeId: "single-retrieve-web" }).value,
                ),
                webSelection: ctx.output(outputs.aiChatWeb, { nodeId: "single-retrieve-web" }).value
                  .status,
              };
              return {
                value: await runtime.operations.assembleContext(
                  load(),
                  plan.question,
                  selectors,
                  "single-assemble",
                  "single-answer",
                  undefined,
                  plan.relevantTurnIds,
                ),
              };
            }}
          </Task>
          <Task
            id="single-measure"
            output={outputs.aiChatContext}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => ({
              value: await runtime.operations.measureAssembly(
                load(),
                ctx.output(outputs.aiChatAssembly, { nodeId: "single-assemble" })
                  .value as ContextAssembly,
                "single-measure",
              ),
            })}
          </Task>
          <CompactionFlow prefix="single" initialNode="single-measure" />
          <Task
            id="single-answer-route"
            output={outputs.aiChatContext}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => ({
              value: ctx.output(outputs.aiChatContext, { nodeId: "single-context-select" }).value,
            })}
          </Task>
          <Branch
            if={selected?.status === "ready"}
            then={
              <Task
                id="single-answer"
                output={outputs.aiChatAnswer}
                retries={2}
                retryPolicy={retryPolicy}
                timeoutMs={answerTimeout}
              >
                {async () => ({
                  value: await runtime.operations.answerDirect(
                    load(),
                    ctx.output(outputs.aiChatContext, { nodeId: "single-answer-route" })
                      .value as ContextState,
                    "single-answer",
                  ),
                })}
              </Task>
            }
            else={
              <Task
                id="single-failure"
                output={outputs.aiChatAnswer}
                retries={2}
                retryPolicy={retryPolicy}
                timeoutMs={fast}
              >
                {async () => ({
                  value: controlledFailure(
                    (
                      ctx.output(outputs.aiChatContext, { nodeId: "single-answer-route" })
                        .value as ContextState
                    ).failureCode ?? "context_plan_unfit",
                  ),
                })}
              </Task>
            }
          />
          <Task
            id="single-result"
            output={outputs.aiChatAnswer}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => ({
              value: (
                ctx.outputMaybe(outputs.aiChatAnswer, { nodeId: "single-answer" }) ??
                ctx.output(outputs.aiChatAnswer, { nodeId: "single-failure" })
              ).value,
            })}
          </Task>
        </Sequence>
      );
    };

    const TopicAnswerFlow = ({ topicId }: { topicId: "t1" | "t2" | "t3"; key?: string }) => {
      const prefix = `topic-${topicId}`;
      const selected = ctx.outputMaybe(outputs.aiChatContext, {
        nodeId: `${prefix}-answer-route`,
      })?.value as ContextState | undefined;
      return (
        <Sequence key={topicId}>
          <Task
            id={`${prefix}-assemble`}
            output={outputs.aiChatAssembly}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => {
              const plan = ctx.output(outputs.aiChatPlanTurn, {
                nodeId: "plan-turn",
              }).value as Extract<PlanTurnResult, { mode: "fanout" }>;
              const topic = plan.topics.find((candidate) => candidate.topicId === topicId);
              if (topic === undefined) {
                throw new AiRuntimeError("invalid_workflow_output", "fanout topic missing", {
                  taskRetryable: false,
                });
              }
              const selectors: SelectorBundle = {
                structuredInternal: ctx.output(outputs.aiChatStructuredInternal, {
                  nodeId: `${prefix}-retrieve-internal`,
                }).value as RetrievalPlanResult | null,
                memories: memorySelectorEntries(
                  ctx.output(outputs.aiChatMemories, {
                    nodeId: `${prefix}-select-memories`,
                  }).value,
                ),
                memorySelection: ctx.output(outputs.aiChatMemories, {
                  nodeId: `${prefix}-select-memories`,
                }).value.status,
                web: webSelectorEntries(
                  ctx.output(outputs.aiChatWeb, { nodeId: `${prefix}-retrieve-web` }).value,
                ),
                webSelection: ctx.output(outputs.aiChatWeb, { nodeId: `${prefix}-retrieve-web` })
                  .value.status,
              };
              return {
                value: await runtime.operations.assembleContext(
                  load(),
                  topic.question,
                  selectors,
                  `${prefix}-assemble`,
                  `${prefix}-answer`,
                  topicId,
                  topic.relevantTurnIds,
                  ctx.output(outputs.aiChatFanoutSources, {
                    nodeId: "fanout-merge-sources",
                  }).value as FanoutSourceKeySet,
                  ctx.output(outputs.aiChatAllocation, { nodeId: "fanout-allocate" }).value
                    .packetOutputTokens,
                ),
              };
            }}
          </Task>
          <Task
            id={`${prefix}-measure`}
            output={outputs.aiChatContext}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => ({
              value: await runtime.operations.measureAssembly(
                load(),
                ctx.output(outputs.aiChatAssembly, { nodeId: `${prefix}-assemble` })
                  .value as ContextAssembly,
                `${prefix}-measure`,
              ),
            })}
          </Task>
          <CompactionFlow prefix={prefix} initialNode={`${prefix}-measure`} />
          <Task
            id={`${prefix}-answer-route`}
            output={outputs.aiChatContext}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => ({
              value: ctx.output(outputs.aiChatContext, { nodeId: `${prefix}-context-select` })
                .value,
            })}
          </Task>
          <Branch
            if={selected?.status === "ready"}
            then={
              <Task
                id={`${prefix}-answer`}
                output={outputs.aiChatTopicResult}
                retries={2}
                retryPolicy={retryPolicy}
                timeoutMs={answerTimeout}
              >
                {async () => {
                  try {
                    return {
                      status: "ok" as const,
                      packet: await runtime.operations.answerTopic(
                        load(),
                        ctx.output(outputs.aiChatContext, { nodeId: `${prefix}-answer-route` })
                          .value as ContextState,
                        `${prefix}-answer`,
                        ctx.output(outputs.aiChatAllocation, { nodeId: "fanout-allocate" }).value
                          .packetOutputTokens,
                      ),
                      retryable: false,
                    };
                  } catch (error) {
                    if (error instanceof AiRuntimeError && !error.retryable) {
                      return {
                        status: "failed" as const,
                        code: error.code,
                        retryable: error.retryable,
                      };
                    }
                    throw error;
                  }
                }}
              </Task>
            }
            else={
              <Task
                id={`${prefix}-failure`}
                output={outputs.aiChatTopicResult}
                retries={2}
                retryPolicy={retryPolicy}
                timeoutMs={fast}
              >
                {async () => {
                  const code =
                    (
                      ctx.output(outputs.aiChatContext, { nodeId: `${prefix}-answer-route` })
                        .value as ContextState
                    ).failureCode ?? "context_plan_unfit";
                  return {
                    status: "failed" as const,
                    code,
                    retryable: isAiRunErrorCode(code) ? isRetryableAiRunError(code) : false,
                  };
                }}
              </Task>
            }
          />
          <Task
            id={`${prefix}-result`}
            output={outputs.aiChatTopicResult}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => {
              const result =
                ctx.outputMaybe(outputs.aiChatTopicResult, { nodeId: `${prefix}-answer` }) ??
                ctx.output(outputs.aiChatTopicResult, { nodeId: `${prefix}-failure` });
              return result.status === "ok" && result.packet !== undefined
                ? { status: "ok" as const, packet: result.packet, retryable: false }
                : {
                    status: "failed" as const,
                    retryable: result.retryable === true,
                    code: result.code ?? "context_plan_unfit",
                  };
            }}
          </Task>
        </Sequence>
      );
    };

    const FanoutAnswerFlow = () => {
      const synthesis = ctx.outputMaybe(outputs.aiChatContext, {
        nodeId: "fanout-synthesis-route",
      })?.value as ContextState | undefined;
      return (
        <Sequence>
          <Task
            id="fanout-allocate"
            output={outputs.aiChatAllocation}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => ({
              value: await runtime.operations.allocateFanout(
                load(),
                ctx.output(outputs.aiChatPlanTurn, { nodeId: "plan-turn" }).value as Extract<
                  PlanTurnResult,
                  { mode: "fanout" }
                >,
              ),
            })}
          </Task>
          <Parallel
            id="fanout-topic-research"
            maxConcurrency={runtime.config.aiTopicResearchMaxConcurrency}
          >
            {topics.flatMap((topic) => {
              const prefix = `topic-${topic.topicId}`;
              return [
                <Task
                  key={`${prefix}-a`}
                  id={`${prefix}-retrieve-internal`}
                  output={outputs.aiChatStructuredInternal}
                  retries={2}
                  retryPolicy={retryPolicy}
                  timeoutMs={fast}
                >
                  {async () => ({
                    value: await runtime.operations.retrieveStructuredInternal(
                      load(),
                      topic.question,
                      `${prefix}-retrieve-internal`,
                      topic.relevantTurnIds,
                    ),
                  })}
                </Task>,
                <Task
                  key={`${prefix}-b`}
                  id={`${prefix}-select-memories`}
                  output={outputs.aiChatMemories}
                  retries={2}
                  retryPolicy={retryPolicy}
                  timeoutMs={fast}
                >
                  {async () => ({
                    value: await runtime.operations.selectMemories(
                      load(),
                      topic.question,
                      `${prefix}-select-memories`,
                    ),
                  })}
                </Task>,
                <Task
                  key={`${prefix}-w`}
                  id={`${prefix}-retrieve-web`}
                  output={outputs.aiChatWeb}
                  retries={2}
                  retryPolicy={retryPolicy}
                  timeoutMs={fast}
                >
                  {async () => ({
                    value: await runtime.operations.retrieveWeb(
                      load(),
                      topic.question,
                      `${prefix}-retrieve-web`,
                    ),
                  })}
                </Task>,
              ];
            })}
          </Parallel>
          <Task
            id="fanout-merge-sources"
            output={outputs.aiChatFanoutSources}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => {
              const plan = ctx.output(outputs.aiChatPlanTurn, {
                nodeId: "plan-turn",
              }).value as Extract<PlanTurnResult, { mode: "fanout" }>;
              const selectors = Object.fromEntries(
                plan.topics.map((topic) => [
                  topic.topicId,
                  {
                    structuredInternal: ctx.output(outputs.aiChatStructuredInternal, {
                      nodeId: `topic-${topic.topicId}-retrieve-internal`,
                    }).value as RetrievalPlanResult | null,
                    memories: memorySelectorEntries(
                      ctx.output(outputs.aiChatMemories, {
                        nodeId: `topic-${topic.topicId}-select-memories`,
                      }).value,
                    ),
                    memorySelection: ctx.output(outputs.aiChatMemories, {
                      nodeId: `topic-${topic.topicId}-select-memories`,
                    }).value.status,
                    web: webSelectorEntries(
                      ctx.output(outputs.aiChatWeb, {
                        nodeId: `topic-${topic.topicId}-retrieve-web`,
                      }).value,
                    ),
                    webSelection: ctx.output(outputs.aiChatWeb, {
                      nodeId: `topic-${topic.topicId}-retrieve-web`,
                    }).value.status,
                  },
                ]),
              ) as unknown as Record<"t1" | "t2" | "t3", SelectorBundle>;
              return {
                value: await runtime.operations.mergeFanoutSources(load(), plan.topics, selectors),
              };
            }}
          </Task>
          <Parallel
            id="fanout-topic-answers"
            maxConcurrency={runtime.config.aiTopicAnswerMaxConcurrency}
          >
            {topics.map((topic) => (
              <TopicAnswerFlow key={topic.topicId} topicId={topic.topicId} />
            ))}
          </Parallel>
          <Task
            id="fanout-collect"
            output={outputs.aiChatFanoutCollect}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => {
              const results = topics.map((topic) =>
                ctx.output(outputs.aiChatTopicResult, { nodeId: `topic-${topic.topicId}-result` }),
              );
              const failed = results.find((result) => result.status === "failed");
              const contexts = topics.map(
                (topic) =>
                  ctx.output(outputs.aiChatContext, {
                    nodeId: `topic-${topic.topicId}-context-select`,
                  }).value as ContextState,
              );
              if (failed !== undefined)
                return {
                  status: "failed" as const,
                  packets: [],
                  sourceMap: [],
                  contexts,
                  code: failed.code ?? "context_plan_unfit",
                  retryable: failed.retryable === true,
                };
              const packets = results.flatMap((result) =>
                result.packet === undefined ? [] : [result.packet],
              );
              if (packets.length !== results.length)
                return {
                  status: "failed" as const,
                  packets: [],
                  sourceMap: [],
                  contexts,
                  code: "context_plan_unfit",
                  retryable: false,
                };
              return {
                status: "ok" as const,
                packets,
                sourceMap: runtime.operations.mergeFanoutSourceMaps(contexts),
                contexts,
                retryable: false,
              };
            }}
          </Task>
          <Task
            id="fanout-synthesis-measure"
            output={outputs.aiChatContext}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => {
              const collected = ctx.output(outputs.aiChatFanoutCollect, {
                nodeId: "fanout-collect",
              });
              const context =
                collected.status === "ok"
                  ? await runtime.operations.synthesisContext(
                      load(),
                      collected.packets as TopicPacket[],
                      collected.sourceMap as FinalSourceRecord[],
                      collected.contexts as ContextState[],
                      ctx.output(outputs.aiChatAllocation, { nodeId: "fanout-allocate" }).value,
                    )
                  : await runtime.operations.synthesisContext(
                      load(),
                      [],
                      [],
                      collected.contexts as ContextState[],
                      ctx.output(outputs.aiChatAllocation, { nodeId: "fanout-allocate" }).value,
                    );
              await runtime.operations.recordSynthesisContextMeasurement(load(), context);
              return { value: context };
            }}
          </Task>
          <CompactionFlow prefix="fanout-synthesis" initialNode="fanout-synthesis-measure" />
          <Task
            id="fanout-synthesis-route"
            output={outputs.aiChatContext}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => ({
              value: ctx.output(outputs.aiChatContext, {
                nodeId: "fanout-synthesis-context-select",
              }).value,
            })}
          </Task>
          <Branch
            if={synthesis?.status === "ready"}
            then={
              <Task
                id="fanout-synthesis"
                output={outputs.aiChatAnswer}
                retries={2}
                retryPolicy={retryPolicy}
                timeoutMs={answerTimeout}
              >
                {async () => ({
                  value: await runtime.operations.synthesize(
                    load(),
                    ctx.output(outputs.aiChatContext, { nodeId: "fanout-synthesis-route" })
                      .value as ContextState,
                    "fanout-synthesis",
                  ),
                })}
              </Task>
            }
            else={
              <Task
                id="fanout-synthesis-failure"
                output={outputs.aiChatAnswer}
                retries={2}
                retryPolicy={retryPolicy}
                timeoutMs={fast}
              >
                {async () => {
                  const collected = ctx.output(outputs.aiChatFanoutCollect, {
                    nodeId: "fanout-collect",
                  });
                  const synthesisCode =
                    collected.status === "ok" &&
                    synthesis?.status === "failed" &&
                    synthesis.failureCode !== undefined &&
                    isAiRunErrorCode(synthesis.failureCode)
                      ? synthesis.failureCode
                      : undefined;
                  const collectionCode =
                    collected.status === "failed" &&
                    collected.code !== undefined &&
                    isAiRunErrorCode(collected.code)
                      ? collected.code
                      : undefined;
                  const failureCode =
                    synthesisCode ?? collectionCode ?? "synthesis_budget_mismatch";
                  const failureRetryable =
                    collected.status === "failed" ? collected.retryable === true : undefined;
                  return {
                    value: controlledFailure(failureCode, failureRetryable),
                  };
                }}
              </Task>
            }
          />
          <Task
            id="fanout-result"
            output={outputs.aiChatAnswer}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => ({
              value: (
                ctx.outputMaybe(outputs.aiChatAnswer, { nodeId: "fanout-synthesis" }) ??
                ctx.output(outputs.aiChatAnswer, { nodeId: "fanout-synthesis-failure" })
              ).value,
            })}
          </Task>
        </Sequence>
      );
    };

    const AnswerLane = () => (
      <Sequence>
        <Branch
          if={planTurnMaybe?.mode === "clarify"}
          then={
            <Task
              id="clarification-result"
              output={outputs.aiChatAnswer}
              retries={2}
              retryPolicy={retryPolicy}
              timeoutMs={fast}
            >
              {async () => ({
                value: await runtime.operations.clarify(
                  load(),
                  (
                    ctx.output(outputs.aiChatPlanTurn, { nodeId: "plan-turn" }).value as Extract<
                      PlanTurnResult,
                      { mode: "clarify" }
                    >
                  ).question,
                ),
              })}
            </Task>
          }
          else={
            <Branch
              if={planTurnMaybe?.mode === "fanout"}
              then={<FanoutAnswerFlow />}
              else={<SingleAnswerFlow />}
            />
          }
        />
        <Task
          id="answer-select"
          output={outputs.aiChatAnswer}
          retries={2}
          retryPolicy={retryPolicy}
          timeoutMs={fast}
        >
          {async () => {
            const answer = (
              ctx.outputMaybe(outputs.aiChatAnswer, { nodeId: "clarification-result" }) ??
              ctx.outputMaybe(outputs.aiChatAnswer, { nodeId: "single-result" }) ??
              ctx.output(outputs.aiChatAnswer, { nodeId: "fanout-result" })
            ).value as AnswerLaneResult;
            if (answer.status === "ok") {
              assertFinalSourceMap(answer, load().citationNamespace);
            }
            return { value: answer };
          }}
        </Task>
      </Sequence>
    );

    return (
      <Workflow name="ai-chat">
        <Sequence>
          <Task
            id="load-turn"
            output={outputs.aiChatLoadTurn}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => ({ value: await runtime.operations.loadTurn(parseRunId(ctx.input)) })}
          </Task>
          <Task
            id="plan-turn"
            output={outputs.aiChatPlanTurn}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => {
              const value = await runtime.operations.planTurn(load());
              if (value.mode === "fanout") {
                return {
                  value: {
                    ...value,
                    topics: value.topics.map((topic) => ({ ...topic })),
                  },
                };
              }
              return { value };
            }}
          </Task>
          {planTurnMaybe ? (
            <Sequence>
              <Parallel id="turn-lanes" maxConcurrency={AI_CHAT_TURN_LANE_MAX_CONCURRENCY}>
                <Task
                  id="memory-extract"
                  output={outputs.aiChatMemory}
                  retries={2}
                  retryPolicy={retryPolicy}
                  timeoutMs={fast}
                >
                  {async () => {
                    return {
                      value: await runtime.operations.extractMemory(load()),
                    };
                  }}
                </Task>
                <AnswerLane />
              </Parallel>
              <Task
                id="finalize"
                output={outputs.aiChatFinalize}
                retries={2}
                retryPolicy={retryPolicy}
                timeoutMs={fast}
              >
                {async () => {
                  const terminal = await runtime.operations.finalize(
                    load(),
                    ctx.output(outputs.aiChatAnswer, { nodeId: "answer-select" })
                      .value as AnswerLaneResult,
                    MemoryExtractionSchema.parse(
                      ctx.output(outputs.aiChatMemory, { nodeId: "memory-extract" }).value,
                    ) as MemoryExtractionArtifact,
                    `ai-chat:${load().aiRunId}`,
                  );
                  return terminal.status === "succeeded"
                    ? {
                        status: "succeeded" as const,
                        assistantMessageId: terminal.assistantMessageId,
                        alreadyTerminal: terminal.alreadyTerminal,
                      }
                    : {
                        status: "failed" as const,
                        code: terminal.code,
                        alreadyTerminal: terminal.alreadyTerminal,
                      };
                }}
              </Task>
            </Sequence>
          ) : null}
        </Sequence>
      </Workflow>
    );
  });

  return registerSmithersWorkflowMaxConcurrency(
    workflow,
    aiChatSmithersMaxConcurrency(runtime.config),
  );
}
