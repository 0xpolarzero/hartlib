import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { z } from "zod";
import {
  canonicalPublicSourceHttpsUrl,
  isCanonicalPublicDocumentSourceId,
  isCanonicalPublisherDocumentSourceId,
  publisherIssueAdvisoryLockKey,
} from "@brief/shared";

import { isRetryableAiRunError, type AiRunErrorCode } from "../runtime/errors";
import {
  canonicalizeWebUrl,
  encodeCitationNonce,
  normalizeCharacterRanges,
  normalizeWebQuote,
  memoryExtractionSha256Hex,
  webQuoteHash,
} from "../runtime/canonicalization";
import { PublicProvenanceSchema } from "../runtime/source-schemas";
import type {
  AnswerLaneResult,
  FinalSourceRecord,
  MemoryExtractionArtifact,
} from "../runtime/types";
import { parseCurrentTurnCitations } from "./citations";
import { appendAiRunEventInTransaction } from "./events";
import {
  applyMemoryProposalsInTransaction,
  type AppliedMemoryChanges,
  type MemoryConflictError,
} from "./memory";
import {
  appendAggregateAiRunUsageInTransaction,
  insertAiObservation,
  type AggregateAiRunUsage,
} from "./observability";

interface RunRow {
  readonly id: string;
  readonly chatId: string;
  readonly initiatingUserId: string;
  readonly smithersRunId: string | null;
  readonly assistantMessageId: string | null;
  readonly errorCode: AiRunErrorCode | null;
  readonly retryable: boolean | null;
  readonly finishedAt: Date | null;
  readonly failedAt: Date | null;
  readonly citationNonceHex: string;
}

/**
 * The handler's durable Smithers coordinate fence failed.  This is a typed
 * failure so callers can preserve both product and Smithers state rather than
 * attempting a best-effort terminal transition or cleanup against an
 * untrusted coordinate.
 */
export class AiRunSmithersRunIdMismatch extends Error {
  constructor(
    readonly aiRunId: string,
    readonly actualSmithersRunId: string | null,
    readonly expectedSmithersRunId: string,
  ) {
    super(
      `ai run ${aiRunId} has Smithers identity ${actualSmithersRunId ?? "null"}; expected ${expectedSmithersRunId}`,
    );
    this.name = "AiRunSmithersRunIdMismatch";
  }
}

interface IdRow {
  readonly id: string;
}

interface RunExecutionScope {
  readonly chatId: string;
  readonly companyId: string;
  readonly initiatingUserId: string;
}

export type FinalizationAuthorizationResult =
  | { readonly authorized: true }
  | {
      readonly authorized: false;
      readonly code: "source_access_revoked" | "web_policy_revoked";
    };

export type FinalizationAuthorization = (input: {
  readonly runId: string;
  readonly chatId: string;
  readonly initiatingUserId: string;
  readonly sourceMap: readonly FinalSourceRecord[];
}) => Effect.Effect<FinalizationAuthorizationResult, Error, PgClient.PgClient>;

export interface FinalizeAiRunInput {
  readonly runId: string;
  /** The durable Smithers coordinate owned by the currently executing workflow. */
  readonly expectedSmithersRunId: string;
  readonly answer: AnswerLaneResult;
  readonly memory: MemoryExtractionArtifact;
  readonly authorize: FinalizationAuthorization;
  readonly coordinates: {
    readonly loopIteration: number;
    readonly attempt: number;
  };
}

const MemoryExtractionObservationPayloadSchema = z
  .object({
    proposalCount: z.number().int().nonnegative(),
    discardedCount: z.number().int().nonnegative(),
    extractionSha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const MemoryExtractionArtifactSchema = z
  .object({
    result: z
      .object({
        proposals: z.array(
          z
            .object({
              kind: z.enum(["profile", "preference", "instruction", "fact", "episode"]),
              content: z.string().trim().min(1),
              targetMemoryId: z.string().uuid().optional(),
              expectedHeadRevisionId: z.string().uuid().optional(),
            })
            .strict()
            .superRefine((proposal, context) => {
              if (
                (proposal.targetMemoryId === undefined) !==
                (proposal.expectedHeadRevisionId === undefined)
              ) {
                context.addIssue({
                  code: "custom",
                  message: "memory update target and expected head must be supplied together",
                });
              }
            }),
        ),
        discardedCount: z.number().int().nonnegative(),
      })
      .strict(),
    producer: z
      .object({
        taskId: z.enum(["memory-extract", "evaluation-general-planner"]),
        loopIteration: z.number().int().nonnegative(),
        attempt: z.number().int().nonnegative(),
        observationKey: z.string().min(1).max(512),
        extractionSha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();

export type TerminalAiRunResult =
  | {
      readonly status: "succeeded";
      readonly assistantMessageId: string;
      readonly memory: AppliedMemoryChanges;
      readonly usage: AggregateAiRunUsage;
      readonly alreadyTerminal: boolean;
    }
  | {
      readonly status: "failed";
      readonly code: AiRunErrorCode;
      readonly retryable: boolean;
      readonly memory: AppliedMemoryChanges | null;
      readonly usage: AggregateAiRunUsage | null;
      readonly alreadyTerminal: boolean;
    };

const validateDurableObservability = (
  runId: string,
  answer: AnswerLaneResult,
): Effect.Effect<void, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const observationRows = yield* sql<{
      readonly kind: string;
      readonly emittingTask: string;
      readonly loopIteration: number;
      readonly attempt: number;
      readonly payload: Record<string, unknown>;
    }>`
      select kind, emitting_task as "emittingTask", loop_iteration as "loopIteration",
             attempt, payload
      from ai_observations
      where run_id = ${runId}
    `;
    const kinds = new Set(observationRows.map((row) => row.kind));
    const required = new Set<string>(["conversation_resolution"]);
    if (answer.status === "ok" && answer.mode !== "clarification") {
      for (const kind of [
        "execution_plan",
        "retrieval_manifest",
        "context_measurement",
        "context_serialized",
      ]) {
        required.add(kind);
      }
      if (answer.mode === "synthesis") required.add("topic_packet");
    }
    for (const kind of required) {
      if (!kinds.has(kind)) return yield* Effect.fail(new Error(`missing ${kind} observation`));
    }

    const measurements = new Map<string, Record<string, unknown>>();
    for (const row of observationRows.filter(
      (observation) => observation.kind === "provider_request_measurement",
    )) {
      const requestIndex = row.payload.providerRequestIndex;
      const modelId = row.payload.modelId;
      const requestSha256Hex = row.payload.requestSha256Hex;
      const sourceExposureProofs = row.payload.sourceExposureProofSha256Hexes;
      if (
        !Number.isSafeInteger(requestIndex) ||
        typeof modelId !== "string" ||
        typeof requestSha256Hex !== "string" ||
        !/^[0-9a-f]{64}$/u.test(requestSha256Hex) ||
        !Array.isArray(sourceExposureProofs) ||
        sourceExposureProofs.some(
          (proof) => typeof proof !== "string" || !/^[0-9a-f]{64}$/u.test(proof),
        ) ||
        new Set(sourceExposureProofs).size !== sourceExposureProofs.length ||
        JSON.stringify(sourceExposureProofs) !== JSON.stringify([...sourceExposureProofs].sort()) ||
        row.payload.passed !== true
      ) {
        return yield* Effect.fail(new Error("invalid provider request measurement observation"));
      }
      const key = [row.emittingTask, row.loopIteration, row.attempt, requestIndex].join(":");
      if (measurements.has(key)) {
        return yield* Effect.fail(new Error(`duplicate provider measurement coordinates: ${key}`));
      }
      measurements.set(key, row.payload);
    }
    const usageRows = yield* sql<{
      readonly taskId: string;
      readonly loopIteration: number;
      readonly attempt: number;
      readonly providerRequestIndex: number;
      readonly modelId: string;
    }>`
      select task_id as "taskId", loop_iteration as "loopIteration", attempt,
             provider_request_index as "providerRequestIndex", model_id as "modelId"
      from ai_run_usage
      where run_id = ${runId}
    `;
    for (const usage of usageRows) {
      const key = [
        usage.taskId,
        usage.loopIteration,
        usage.attempt,
        usage.providerRequestIndex,
      ].join(":");
      const measurement = measurements.get(key);
      if (measurement === undefined || measurement.modelId !== usage.modelId) {
        return yield* Effect.fail(new Error(`usage lacks matching exact measurement: ${key}`));
      }
    }
  });

const loadRunForUpdate = (
  runId: string,
): Effect.Effect<RunRow, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<RunRow>`
      select
        id::text,
        chat_id::text as "chatId",
        initiating_user_id as "initiatingUserId",
        smithers_run_id as "smithersRunId",
        assistant_message_id::text as "assistantMessageId",
        error_code as "errorCode",
        retryable,
        finished_at as "finishedAt",
        failed_at as "failedAt"
        , encode(citation_nonce, 'hex') as "citationNonceHex"
      from ai_runs
      where id = ${runId}
      for update
    `;
    const row = rows[0];
    if (row === undefined) {
      return yield* Effect.fail(new Error(`ai run not found: ${runId}`));
    }
    return row;
  });

/**
 * Match API message acceptance's canonical order before finalization can make
 * a terminal assistant message visible: user-memory lane, chat row, company
 * membership lane, then chat execution lane. Full chat reads hold the latter
 * three through their complete projection, so they observe finalization wholly
 * before or wholly after it.
 */
const lockRunExecutionScope = (
  runId: string,
): Effect.Effect<RunExecutionScope, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const scopes = yield* sql<RunExecutionScope>`
      select run.chat_id::text as "chatId",
             chat.company_id::text as "companyId",
             run.initiating_user_id as "initiatingUserId"
      from ai_runs run
      join chats chat on chat.id = run.chat_id
      where run.id = ${runId}
    `;
    const scope = scopes[0];
    if (scope === undefined) {
      return yield* Effect.fail(new Error(`ai run not found: ${runId}`));
    }
    yield* sql`
      select pg_advisory_xact_lock(
        hashtext(${`brief:user-memory:${scope.initiatingUserId}`})
      )
    `;
    const chats = yield* sql<{ readonly id: string }>`
      select id::text
      from chats
      where id = ${scope.chatId}
      for share
    `;
    if (chats[0] === undefined) {
      return yield* Effect.fail(new Error(`chat not found: ${scope.chatId}`));
    }
    yield* sql`
      select pg_advisory_xact_lock(
        hashtext(${`brief:client-members:${scope.companyId}`})
      )
    `;
    yield* sql`
      select pg_advisory_xact_lock(
        hashtext(${`brief:ai-chat:${scope.chatId}`})
      )
    `;
    return scope;
  });

/**
 * Restriction changes and finalization share one transaction advisory lane per
 * publisher issue. The sorted acquisition order keeps a fanout answer from
 * deadlocking another transaction that touches the same set of issues.
 */
const lockPublisherIssueLanes = (
  sourceMap: readonly FinalSourceRecord[],
): Effect.Effect<void, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const issueIds = [
      ...new Set(
        sourceMap.flatMap((source) =>
          source.locator.kind === "document" && source.locator.publisherIssueId !== undefined
            ? [source.locator.publisherIssueId]
            : [],
        ),
      ),
    ].sort();
    for (const issueId of issueIds) {
      yield* sql`
        select pg_advisory_xact_lock(
          hashtextextended(${publisherIssueAdvisoryLockKey(issueId)}, 0)
        )
      `;
    }
  });

const existingTerminalResult = (row: RunRow): TerminalAiRunResult | null => {
  if (row.finishedAt !== null && row.assistantMessageId !== null) {
    return {
      status: "succeeded",
      assistantMessageId: row.assistantMessageId,
      memory: { created: 0, updated: 0, discarded: 0, writes: [] },
      usage: {
        model: {
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          requestCount: 0,
        },
        web: { searchCount: 0, fetchCount: 0, responseBytes: 0, billedUnits: 0 },
      },
      alreadyTerminal: true,
    };
  }

  if (row.failedAt !== null && row.errorCode !== null && row.retryable !== null) {
    return {
      status: "failed",
      code: row.errorCode,
      retryable: row.retryable,
      memory: null,
      usage: null,
      alreadyTerminal: true,
    };
  }

  return null;
};

const sourceIdentity = (source: FinalSourceRecord): string => {
  const locator = source.locator;
  switch (locator.kind) {
    case "document":
      return `document:${locator.sourceId}:${
        locator.publisherIssueId === undefined
          ? "public"
          : `publisher:${locator.publisherIssueId}:${locator.publisherDocumentId ?? ""}`
      }:${locator.documentVersionId}:${locator.contentHash}`;
    case "chat_message":
      return `chat_message:${locator.messageId}`;
    case "memory":
      return `memory:${locator.memoryId}:${locator.memoryRevisionId}`;
    case "web":
      return `web:${locator.url}:${locator.quoteHash}`;
  }
};

const rangesEqual = (
  left: readonly { readonly charStart: number; readonly charEnd: number }[],
  right: readonly { readonly charStart: number; readonly charEnd: number }[],
): boolean => JSON.stringify(left) === JSON.stringify(right);

export const assertFinalSourceMap = (
  answer: Extract<AnswerLaneResult, { readonly status: "ok" }>,
  citationNonceHex: string,
): void => {
  for (const source of answer.sourceMap) {
    // Reparse the durable public projection at the finalization boundary so
    // unknown/nested/wrongly typed provenance cannot survive into storage.
    PublicProvenanceSchema.parse(source.publicProvenance);
  }
  const sourceMap = answer.sourceMap;
  if (answer.mode === "clarification" && sourceMap.length !== 0) {
    throw new Error("clarification result must have an empty source map");
  }
  const nonce = encodeCitationNonce(Uint8Array.from(Buffer.from(citationNonceHex, "hex")));
  const keyPattern = new RegExp(`^k_${nonce}_[1-9][0-9]*$`, "u");
  const keys = new Set<string>();
  const identities = new Set<string>();
  const consumerOrders = new Map<string, Set<number>>();
  for (const source of sourceMap) {
    if (!keyPattern.test(source.sourceKey)) {
      throw new Error(`source key is outside the current citation namespace: ${source.sourceKey}`);
    }
    if (keys.has(source.sourceKey)) {
      throw new Error(`duplicate final source key: ${source.sourceKey}`);
    }
    keys.add(source.sourceKey);
    const identity = sourceIdentity(source);
    if (identities.has(identity)) throw new Error(`duplicate final source identity: ${identity}`);
    identities.add(identity);
    if (source.uses.length === 0)
      throw new Error(`source has no answer consumer: ${source.sourceKey}`);

    if (source.locator.kind === "document") {
      const ranges = normalizeCharacterRanges(
        source.locator.ranges,
        Math.max(0, ...source.locator.ranges.map((range) => range.charEnd)),
      );
      if (ranges.length === 0 || !rangesEqual(ranges, source.locator.ranges)) {
        throw new Error(`document locator ranges are not a normalized non-empty union`);
      }
      if (
        !(
          isCanonicalPublicDocumentSourceId(source.locator.sourceId) ||
          isCanonicalPublisherDocumentSourceId(source.locator.sourceId)
        ) ||
        source.locator.documentId.trim() === "" ||
        source.locator.documentVersionId.trim() === "" ||
        !/^[a-f0-9]{64}$/u.test(source.locator.contentHash)
      ) {
        throw new Error("document locator identity is incomplete");
      }
      if (
        typeof source.publicProvenance.documentTitle !== "string" ||
        source.publicProvenance.documentTitle.trim() === "" ||
        typeof source.publicProvenance.citationUrl !== "string" ||
        source.publicProvenance.citationUrl.trim() === "" ||
        ((source.locator.publisherIssueId === undefined ||
          source.locator.publisherDocumentId === undefined) &&
          canonicalPublicSourceHttpsUrl(source.publicProvenance.citationUrl) !==
            source.publicProvenance.citationUrl)
      ) {
        throw new Error("document public provenance is incomplete");
      }
      const publisherIssueId = source.locator.publisherIssueId;
      const publisherDocumentId = source.locator.publisherDocumentId;
      if ((publisherIssueId === undefined) !== (publisherDocumentId === undefined)) {
        throw new Error("publisher document identity is incomplete");
      }
      if (publisherIssueId !== undefined && publisherDocumentId !== undefined) {
        if (
          !isCanonicalPublisherDocumentSourceId(source.locator.sourceId) ||
          publisherIssueId.trim() === "" ||
          publisherDocumentId.trim() === "" ||
          publisherDocumentId !== source.locator.documentId ||
          source.publicProvenance.sourceName?.trim() === "" ||
          source.publicProvenance.issueTitle?.trim() === "" ||
          typeof source.publicProvenance.sourceName !== "string" ||
          typeof source.publicProvenance.issueTitle !== "string" ||
          typeof source.publicProvenance.publishedAt !== "string" ||
          !Number.isFinite(Date.parse(source.publicProvenance.publishedAt)) ||
          source.publicProvenance.citationUrl !==
            `/v1/issues/${publisherIssueId}/documents/${publisherDocumentId}/content`
        ) {
          throw new Error("publisher document provenance is incomplete");
        }
      } else if (!isCanonicalPublicDocumentSourceId(source.locator.sourceId)) {
        throw new Error("public document source identity is incomplete");
      }
    } else if (source.locator.kind === "web") {
      if (
        canonicalizeWebUrl(source.locator.url) !== source.locator.url ||
        normalizeWebQuote(source.locator.quote) !== source.locator.quote ||
        webQuoteHash(source.locator.quote) !== source.locator.quoteHash ||
        source.locator.title.trim() === "" ||
        source.locator.domain.trim() === "" ||
        new URL(source.locator.url).hostname !== source.locator.domain ||
        !Number.isFinite(Date.parse(source.locator.capturedAt))
      ) {
        throw new Error("web locator provenance is not canonical");
      }
      if (source.publicProvenance.citationUrl !== source.locator.url) {
        throw new Error("web public provenance URL differs from its immutable locator");
      }
    } else if (source.locator.kind === "chat_message") {
      if (source.locator.messageId.trim() === "") {
        throw new Error("chat-message locator identity is incomplete");
      }
    } else if (
      source.locator.memoryId.trim() === "" ||
      source.locator.memoryRevisionId.trim() === ""
    ) {
      throw new Error("memory locator identity is incomplete");
    }
    const consumers = new Set<string>();
    for (const use of source.uses) {
      if (consumers.has(use.consumerTaskId)) {
        throw new Error(`duplicate source consumer: ${source.sourceKey}/${use.consumerTaskId}`);
      }
      consumers.add(use.consumerTaskId);
      if (!Number.isSafeInteger(use.contextOrder) || use.contextOrder < 0) {
        throw new Error(`invalid source context order: ${source.sourceKey}`);
      }
      if (!Number.isSafeInteger(use.renderedTokenCount) || use.renderedTokenCount < 0) {
        throw new Error(`invalid rendered token count: ${source.sourceKey}`);
      }
      const orders = consumerOrders.get(use.consumerTaskId) ?? new Set<number>();
      if (orders.has(use.contextOrder)) {
        throw new Error(`duplicate context order for consumer ${use.consumerTaskId}`);
      }
      orders.add(use.contextOrder);
      consumerOrders.set(use.consumerTaskId, orders);
      if (source.locator.kind !== "document" && use.ranges.length !== 0) {
        throw new Error(`non-document source has ranges: ${source.sourceKey}`);
      }
      if (source.locator.kind === "document") {
        const locator = source.locator;
        const normalizedUse = normalizeCharacterRanges(
          use.ranges,
          Math.max(0, ...locator.ranges.map((range) => range.charEnd)),
        );
        if (normalizedUse.length === 0 || !rangesEqual(normalizedUse, use.ranges)) {
          throw new Error(`document use ranges are not normalized: ${source.sourceKey}`);
        }
        if (
          use.ranges.some(
            (range) =>
              !locator.ranges.some(
                (locatorRange) =>
                  range.charStart >= locatorRange.charStart &&
                  range.charEnd <= locatorRange.charEnd,
              ),
          )
        ) {
          throw new Error(`document use range exceeds locator union: ${source.sourceKey}`);
        }
      }
      if (answer.mode === "single") {
        if (use.consumerTaskId !== "single-answer" || use.topicId !== undefined) {
          throw new Error(`single answer has a non-single source consumer`);
        }
      } else if (answer.mode === "synthesis") {
        if (use.topicId === undefined || use.consumerTaskId !== `topic-${use.topicId}-answer`) {
          throw new Error(`fanout source consumer does not own its topic`);
        }
      }
    }

    // A document locator is the exact union of every serialized consumer
    // slice.  Checking only that each slice is contained by one locator range
    // would accept stale/orphan locator ranges that no answer consumer saw,
    // which makes a replayed source map differ from the prompt ledger.
    if (source.locator.kind === "document") {
      const textCharCount = Math.max(0, ...source.locator.ranges.map((range) => range.charEnd));
      const consumerRangeUnion = normalizeCharacterRanges(
        source.uses.flatMap((use) => use.ranges),
        textCharCount,
      );
      if (!rangesEqual(consumerRangeUnion, source.locator.ranges)) {
        throw new Error(`document use ranges do not equal locator union: ${source.sourceKey}`);
      }
    }
  }

  // Each consumer's source ledger is a zero-based contiguous sequence.  A
  // uniqueness check alone admits gaps (for example [0, 2]), which cannot
  // reproduce the exact terminal context order on chat replay.
  for (const [consumerTaskId, orders] of consumerOrders) {
    const ordered = [...orders].sort((left, right) => left - right);
    for (let index = 0; index < ordered.length; index += 1) {
      if (ordered[index] !== index) {
        throw new Error(`non-contiguous context order for consumer ${consumerTaskId}`);
      }
    }
  }
};

const persistAssistantSources = (
  assistantMessageId: string,
  sourceMap: readonly FinalSourceRecord[],
): Effect.Effect<void, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    for (const source of sourceMap) {
      const documentVersionId =
        source.locator.kind === "document" ? source.locator.documentVersionId : null;
      let publisherDocumentVersionId: string | null = null;
      if (source.locator.kind === "document") {
        const publisherIssueId = source.locator.publisherIssueId;
        const publisherDocumentId = source.locator.publisherDocumentId;
        if ((publisherIssueId === undefined) !== (publisherDocumentId === undefined)) {
          return yield* Effect.fail(new Error("publisher document identity is incomplete"));
        }
        if (publisherIssueId !== undefined && publisherDocumentId !== undefined) {
          const publisherVersions = yield* sql<{ readonly id: string }>`
            select versions.id::text as id
            from brief_document_versions versions
            join brief_documents documents on documents.id = versions.brief_document_id
            join publisher_issues issues on issues.id = documents.issue_id
            join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
            where versions.id::text = ${source.locator.documentVersionId}
              and documents.id::text = ${publisherDocumentId}
              and issues.id::text = ${publisherIssueId}
              and ('publisher:' || subscriptions.id::text) = ${source.locator.sourceId}
              and versions.content_hash = ${source.locator.contentHash}
            limit 1
          `;
          publisherDocumentVersionId = publisherVersions[0]?.id ?? null;
          if (publisherDocumentVersionId === null) {
            return yield* Effect.fail(
              new Error("publisher document identity does not match database ownership"),
            );
          }
        } else {
          const publicVersions = yield* sql<{ readonly id: string }>`
            select document_id as id
            from public_source_documents
            where source_id = ${source.locator.sourceId.slice("public:".length)}
              and document_id = ${source.locator.documentVersionId}
              and document_id = ${source.locator.documentId}
              and content_hash = ${source.locator.contentHash}
              and canonical_url = ${source.publicProvenance.citationUrl ?? ""}
            limit 1
          `;
          if (publicVersions[0] === undefined) {
            return yield* Effect.fail(
              new Error(`public document version not found: ${source.locator.documentVersionId}`),
            );
          }
        }
      }
      const messageId = source.locator.kind === "chat_message" ? source.locator.messageId : null;
      const memoryRevisionId =
        source.locator.kind === "memory" ? source.locator.memoryRevisionId : null;

      yield* sql`
        insert into assistant_message_sources (
          assistant_message_id,
          source_key,
          kind,
          locator,
          document_version_id,
          publisher_document_version_id,
          message_id,
          memory_revision_id,
          display_label,
          public_provenance
        )
        values (
          ${assistantMessageId},
          ${source.sourceKey},
          ${source.locator.kind},
          ${sql.json(source.locator)},
          ${documentVersionId},
          ${publisherDocumentVersionId},
          ${messageId},
          ${memoryRevisionId},
          ${source.label},
          ${sql.json(source.publicProvenance)}
        )
      `;

      for (const use of source.uses) {
        yield* sql`
          insert into assistant_message_source_uses (
            assistant_message_id,
            source_key,
            consumer_task_id,
            topic_id,
            rendered_token_count,
            context_order,
            ranges
          )
          values (
            ${assistantMessageId},
            ${source.sourceKey},
            ${use.consumerTaskId},
            ${use.topicId ?? null},
            ${use.renderedTokenCount},
            ${use.contextOrder},
            ${JSON.stringify(use.ranges)}::jsonb
          )
        `;
      }
    }
  });

const persistCitationObservations = (
  run: RunRow,
  assistantMessageId: string,
  content: string,
  sourceMap: readonly FinalSourceRecord[],
  coordinates: FinalizeAiRunInput["coordinates"],
): Effect.Effect<void, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const parsed = parseCurrentTurnCitations(
      content,
      new Set(sourceMap.map((source) => source.sourceKey)),
    );

    for (const citation of parsed.citations) {
      yield* insertAiObservation({
        runId: run.id,
        chatId: run.chatId,
        emittingTask: "finalize",
        loopIteration: coordinates.loopIteration,
        attempt: coordinates.attempt,
        observationKey: `citation:${citation.tagIndex}:${citation.keyIndex}`,
        kind: "citation",
        payload: { assistantMessageId, sourceKey: citation.sourceKey },
      });
    }
    for (const defect of parsed.defects) {
      yield* insertAiObservation({
        runId: run.id,
        chatId: run.chatId,
        emittingTask: "finalize",
        loopIteration: coordinates.loopIteration,
        attempt: coordinates.attempt,
        observationKey: `citation_defect:${defect.tagIndex}:${defect.defectSlot}`,
        kind: "citation_defect",
        payload: { token: defect.token, reason: defect.reason },
      });
    }
  });

const transitionToFailure = (
  runId: string,
  code: AiRunErrorCode,
  emittedByTask: string,
  retryable: boolean = isRetryableAiRunError(code),
): Effect.Effect<
  { readonly code: AiRunErrorCode; readonly retryable: boolean },
  SqlError | Error,
  PgClient.PgClient
> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      update ai_runs
      set failed_at = now(),
          error_code = ${code},
          retryable = ${retryable}
      where id = ${runId}
        and finished_at is null
        and failed_at is null
    `;
    yield* appendAiRunEventInTransaction({
      runId,
      emissionKey: "terminal",
      event: { type: "error", code, retryable },
      emittedByTask,
    });
    return { code, retryable };
  });

export const finalizeAiRun = (
  input: FinalizeAiRunInput,
): Effect.Effect<TerminalAiRunResult, SqlError | Error | MemoryConflictError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const memoryArtifact = MemoryExtractionArtifactSchema.parse(input.memory);
    if (
      !Number.isSafeInteger(input.coordinates.loopIteration) ||
      input.coordinates.loopIteration < 0 ||
      !Number.isSafeInteger(input.coordinates.attempt) ||
      input.coordinates.attempt < 1
    ) {
      return yield* Effect.fail(new Error("finalization requires exact Smithers coordinates"));
    }
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const executionScope = yield* lockRunExecutionScope(input.runId);
        const run = yield* loadRunForUpdate(input.runId);
        if (
          run.chatId !== executionScope.chatId ||
          run.initiatingUserId !== executionScope.initiatingUserId
        ) {
          return yield* Effect.fail(new Error("ai run execution scope changed"));
        }
        if (run.smithersRunId !== input.expectedSmithersRunId) {
          return yield* Effect.fail(
            new AiRunSmithersRunIdMismatch(
              input.runId,
              run.smithersRunId,
              input.expectedSmithersRunId,
            ),
          );
        }
        const terminal = existingTerminalResult(run);
        if (terminal !== null) return terminal;

        // Acquire every publisher restriction lane before any authorization
        // query. The lane remains held until this transaction commits, so a
        // restriction either linearizes before finalization (and is observed
        // as revoked) or after the complete terminal answer write.
        if (input.answer.status === "ok") {
          yield* lockPublisherIssueLanes(input.answer.sourceMap);
        }

        yield* validateDurableObservability(run.id, input.answer);

        const extractionSha256Hex = memoryExtractionSha256Hex(memoryArtifact.result);
        if (extractionSha256Hex !== memoryArtifact.producer.extractionSha256Hex) {
          return yield* Effect.fail(new Error("memory extraction artifact digest differs"));
        }
        const extractionRows = yield* sql<{ readonly payload: unknown }>`
          select payload
          from ai_observations
          where run_id = ${run.id}
            and chat_id = ${run.chatId}
            and emitting_task = ${memoryArtifact.producer.taskId}
            and loop_iteration = ${memoryArtifact.producer.loopIteration}
            and attempt = ${memoryArtifact.producer.attempt}
            and observation_key = ${memoryArtifact.producer.observationKey}
            and kind = 'memory_extraction_result'
        `;
        if (extractionRows.length !== 1) {
          return yield* Effect.fail(new Error("memory extraction artifact has no exact producer"));
        }
        const extractionPayload = MemoryExtractionObservationPayloadSchema.parse(
          extractionRows[0]!.payload,
        );
        if (
          extractionPayload.proposalCount !== memoryArtifact.result.proposals.length ||
          extractionPayload.discardedCount !== memoryArtifact.result.discardedCount ||
          extractionPayload.extractionSha256Hex !== extractionSha256Hex
        ) {
          return yield* Effect.fail(new Error("memory extraction artifact producer differs"));
        }

        yield* insertAiObservation({
          runId: run.id,
          chatId: run.chatId,
          emittingTask: "finalize",
          loopIteration: input.coordinates.loopIteration,
          attempt: input.coordinates.attempt,
          observationKey: `finalize:${input.coordinates.loopIteration}:${input.coordinates.attempt}:memory_application:result`,
          kind: "memory_application",
          payload: {
            extractionTaskId: memoryArtifact.producer.taskId,
            extractionLoopIteration: memoryArtifact.producer.loopIteration,
            extractionAttempt: memoryArtifact.producer.attempt,
            extractionObservationKey: memoryArtifact.producer.observationKey,
            extractionSha256Hex,
            proposalCount: memoryArtifact.result.proposals.length,
            discardedCount: memoryArtifact.result.discardedCount,
          },
        });

        let answer = input.answer;
        if (answer.status === "ok") {
          assertFinalSourceMap(answer, run.citationNonceHex);
          const authorization = yield* input.authorize({
            runId: run.id,
            chatId: run.chatId,
            initiatingUserId: run.initiatingUserId,
            sourceMap: answer.sourceMap,
          });
          if (!authorization.authorized) {
            answer = {
              status: "failed",
              code: authorization.code,
              retryable: isRetryableAiRunError(authorization.code),
            };
          }
        }

        // Authorize against the revision that was actually rendered. Memory
        // proposals are applied below; doing that first would advance a cited
        // memory's head revision and make an otherwise valid answer appear to
        // have lost access to its source during the same transaction.
        const memory = yield* applyMemoryProposalsInTransaction(
          run.id,
          run.initiatingUserId,
          memoryArtifact.result,
        );
        for (const write of memory.writes) {
          yield* insertAiObservation({
            runId: run.id,
            chatId: run.chatId,
            emittingTask: "finalize",
            loopIteration: input.coordinates.loopIteration,
            attempt: input.coordinates.attempt,
            observationKey: `memory_written:${write.ordinal}`,
            kind: "memory_written",
            payload: write,
          });
        }
        yield* appendAiRunEventInTransaction({
          runId: run.id,
          emissionKey: "memory_updated",
          event: {
            type: "memory_updated",
            created: memory.created,
            updated: memory.updated,
            discarded: memory.discarded,
          },
          emittedByTask: "finalize",
        });
        const usage = yield* appendAggregateAiRunUsageInTransaction(run.id, "finalize");

        if (answer.status === "failed") {
          const failure = yield* transitionToFailure(
            run.id,
            answer.code,
            "finalize",
            answer.retryable,
          );
          return {
            status: "failed" as const,
            ...failure,
            memory,
            usage,
            alreadyTerminal: false,
          };
        }

        const messages = yield* sql<IdRow>`
          insert into chat_messages (chat_id, author, content, assistant_ai_run_id)
          values (${run.chatId}, 'assistant', ${answer.content}, ${run.id})
          returning id::text
        `;
        const assistantMessageId = messages[0]?.id;
        if (assistantMessageId === undefined) {
          return yield* Effect.fail(new Error("assistant message insert returned no row"));
        }

        yield* persistAssistantSources(assistantMessageId, answer.sourceMap);
        yield* persistCitationObservations(
          run,
          assistantMessageId,
          answer.content,
          answer.sourceMap,
          input.coordinates,
        );
        yield* sql`
          update ai_runs
          set assistant_message_id = ${assistantMessageId},
              finished_at = now(),
              error_code = null,
              retryable = null
          where id = ${run.id}
        `;
        yield* appendAiRunEventInTransaction({
          runId: run.id,
          emissionKey: "terminal",
          event: { type: "done", assistantMessageId },
          emittedByTask: "finalize",
        });

        return {
          status: "succeeded" as const,
          assistantMessageId,
          memory,
          usage,
          alreadyTerminal: false,
        };
      }),
    );
  });

export const failAiRun = (
  runId: string,
  code: AiRunErrorCode,
  retryable: boolean = isRetryableAiRunError(code),
  expectedSmithersRunId?: string,
): Effect.Effect<TerminalAiRunResult, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const executionScope = yield* lockRunExecutionScope(runId);
        const run = yield* loadRunForUpdate(runId);
        if (
          run.chatId !== executionScope.chatId ||
          run.initiatingUserId !== executionScope.initiatingUserId
        ) {
          return yield* Effect.fail(new Error("ai run execution scope changed"));
        }
        if (expectedSmithersRunId !== undefined && run.smithersRunId !== expectedSmithersRunId) {
          return yield* Effect.fail(
            new AiRunSmithersRunIdMismatch(runId, run.smithersRunId, expectedSmithersRunId),
          );
        }
        const terminal = existingTerminalResult(run);
        if (terminal !== null) return terminal;

        const usage = yield* appendAggregateAiRunUsageInTransaction(run.id, "failure-handler");
        const failure = yield* transitionToFailure(run.id, code, "failure-handler", retryable);
        return {
          status: "failed" as const,
          ...failure,
          memory: null,
          usage,
          alreadyTerminal: false,
        };
      }),
    );
  });
