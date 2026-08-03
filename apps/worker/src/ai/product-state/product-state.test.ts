import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeRunAcceptanceScope } from "@brief/shared";

import { runMigrations } from "@brief/database/migrations";
import {
  chatMessageEvidenceIdentity,
  memoryEvidenceIdentity,
  memoryExtractionSha256Hex,
  namespacedDocumentEvidenceIdentity,
  sha256Base64Url,
  stripHistoricalCitationTags,
  webEvidenceIdentity,
} from "../runtime/canonicalization";
import {
  providerRequestSourceExposureProofs,
  providerRequestSourceExposureProofBindings,
  providerRequestSha256Hex,
  providerVisibleSourceExposureProofSha256Hex,
  type CodeOwnedSourceExposureProof,
  type ProviderVisibleSourceExposureProofBinding,
} from "../runtime/provider-request";
import { resolveRegisteredModel } from "../runtime/model-registry";
import type {
  AnswerLaneResult,
  FinalSourceRecord,
  MemoryExtractionArtifact,
  MemoryExtractionResult,
} from "../runtime/types";
import { appendAiRunEvent } from "./events";
import { AiRunSmithersRunIdMismatch, failAiRun, finalizeAiRun } from "./finalization";
import {
  ActiveAiRunError,
  deleteUserMemory,
  MemoryConflictError,
  MemoryRevertWindowExpiredError,
  revertUserMemory,
} from "./memory";
import {
  deriveAggregateAiRunUsage,
  insertAiExternalToolUsage,
  insertAiObservation,
  insertAiRunUsage,
  insertAiSourceExposure,
} from "./observability";
import { purgeUserMemoryTombstones } from "./retention";
import {
  pruneFinishedAiRunEvents,
  purgeAiRuntimeRetention,
  sweepAiChatSmithersRows,
} from "../workflow/smithers-cleanup";
import { AI_CHAT_SMITHERS_SCHEMA_FENCE } from "../smithers-interop";
import { TINYFISH_SEARCH_PROVIDER_ENDPOINT_IDENTITY } from "../web/tinyfish-search";

const isBun = typeof process.versions.bun === "string";
const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const databaseName = `brief_product_state_test_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
const finalizeCoordinates = { loopIteration: 0, attempt: 1 } as const;

const sourceUrl = () => {
  if (databaseUrl === undefined) throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  return databaseUrl;
};

const databaseUrlFor = (name: string) => {
  const url = new URL(sourceUrl());
  url.pathname = `/${name}`;
  return url.toString();
};

const adminUrl = () => databaseUrlFor("postgres");
const testUrl = () => databaseUrlFor(databaseName);
const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;

const runDb = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>, url = testUrl()): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName: "brief-product-state-test",
        }),
      ),
    ),
  );
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const causeOf = (value: unknown): unknown => {
  if (!isRecord(value) || !("cause" in value)) return undefined;
  return value.cause;
};

const messageOf = (value: unknown): string | undefined => {
  const message = isRecord(value) ? value.message : undefined;
  return typeof message === "string" ? message : undefined;
};

const errorText = (error: unknown): string => {
  const parts = [String(error)];
  const cause = causeOf(error);
  if (cause !== undefined) {
    parts.push(String(cause));
    const causeMessage = messageOf(cause);
    if (causeMessage) parts.push(causeMessage);
    const nestedCause = causeOf(cause);
    if (nestedCause !== undefined) {
      parts.push(String(nestedCause));
      const nestedCauseMessage = messageOf(nestedCause);
      if (nestedCauseMessage) parts.push(nestedCauseMessage);
    }
  }
  return parts.join("\n");
};

const runDbAs = <A, E>(
  applicationName: string,
  effect: Effect.Effect<A, E, PgClient.PgClient>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(testUrl()),
          applicationName,
        }),
      ),
    ),
  );

const waitForDatabaseLock = async (applicationName: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly waiting: boolean }>`
          select exists(
            select 1
            from pg_stat_activity
            where datname = current_database()
              and application_name = ${applicationName}
              and wait_event_type = 'Lock'
          ) as waiting
        `)[0]!.waiting;
      }),
    );
    if (waiting) return;
    await Bun.sleep(5);
  }
  throw new Error(`${applicationName} did not wait for a database lock`);
};

interface Fixture {
  readonly companyId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly userMessageId: string;
  readonly runId: string;
  readonly chatContent: string;
  readonly citationNamespace: string;
  readonly mode: TurnPlanMode;
  readonly memoryMode: "private_owner" | "disabled";
}

type TurnPlanMode = "clarify" | "single" | "fanout";

type ResetProductChatResult =
  | {
      readonly kind: "created" | "replay";
      readonly archivedChatId: string;
      readonly replacementChatId: string;
    }
  | { readonly kind: "already_reset"; readonly archivedChatId: string }
  | { readonly kind: "replacement_conflict" | "forbidden" };

type ResetProductChat = (
  identity: {
    readonly mode: "demo" | "clerk";
    readonly userId: string;
    readonly organizationId: string | null;
  },
  chatId: string,
  replacementChatId: string,
) => Effect.Effect<ResetProductChatResult, unknown, PgClient.PgClient>;

const loadResetProductChat = async (): Promise<ResetProductChat> => {
  const moduleUrl: string = new URL(
    "../../../../../packages/backend-domain/src/product-chats.ts",
    import.meta.url,
  ).href;
  const productChats = (await import(moduleUrl)) as {
    readonly resetProductChat: ResetProductChat;
  };
  return productChats.resetProductChat;
};

const newCitationNamespace = (): string =>
  `cn_${crypto.randomUUID().replaceAll("-", "").slice(0, 22)}`;

const turnPlanPayload = (
  mode: TurnPlanMode,
  topicIds: readonly ("t1" | "t2" | "t3")[] = ["t1", "t2"],
) =>
  mode === "clarify"
    ? { mode, question: "current question" }
    : mode === "single"
      ? { mode, question: "current question", relevantTurnIds: [] }
      : {
          mode,
          question: "current question",
          topics: topicIds.map((topicId) => ({
            topicId,
            question:
              topicId === "t1" ? "first topic" : topicId === "t2" ? "second topic" : "third topic",
            relevantTurnIds: [],
          })),
        };

const createFixture = (
  suffix: string,
  mode: TurnPlanMode = "single",
  memoryMode: "private_owner" | "disabled" = "private_owner",
  webRequested = true,
  webEnabled = webRequested,
  publicSourceIds: readonly string[] = [],
  topicIds: readonly ("t1" | "t2" | "t3")[] = ["t1", "t2"],
): Effect.Effect<Fixture, unknown, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const companyId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    const userId = `product-state-${suffix}-${crypto.randomUUID()}`;
    const citationNamespace = newCitationNamespace();

    yield* sql`
      insert into platform_users (id, primary_email, display_name, clerk_user_id)
      values (
        ${userId}, ${`${userId}@example.test`}, ${`Product state ${suffix}`},
        ${`clerk-${userId}`}
      )
    `;
    yield* sql`
      insert into client_companies (id, name)
      values (${companyId}, ${`Product state ${suffix}`})
    `;
    yield* sql`
      insert into client_company_memberships (company_id, user_id, role)
      values (${companyId}, ${userId}, 'admin')
    `;
    yield* sql`
      insert into client_company_ai_settings (company_id, web_search_enabled)
      values (${companyId}, true)
    `;
    for (const publicSourceId of publicSourceIds) {
      yield* sql`
        insert into client_company_public_source_settings (
          client_company_id, source_id, enabled, updated_by_user_id
        ) values (${companyId}, ${publicSourceId}, true, ${userId})
      `;
    }
    yield* sql`
      insert into chats (id, company_id, user_id, memory_mode)
      values (${chatId}, ${companyId}, ${userId}, ${memoryMode})
    `;
    const messages = yield* sql<{ readonly id: string }>`
      insert into chat_messages (chat_id, author, content)
      values (${chatId}, 'user', ${`Question ${suffix}`})
      returning id::text
    `;
    const userMessageId = messages[0]!.id;
    const runs = yield* sql<{ readonly id: string }>`
      insert into ai_runs (
        chat_id,
        initiating_user_id,
        user_message_id,
        locale,
        market,
        acceptance_scope,
        citation_namespace
      )
      values (
        ${chatId},
        ${userId},
        ${userMessageId},
        'en-US',
        'US',
        ${sql.json(
          makeRunAcceptanceScope({
            userId,
            chatId,
            companyId,
            publicSourceIds,
            memoryMode,
            webRequested,
            webEnabled,
          }),
        )},
        ${citationNamespace}
      )
      returning id::text
    `;
    const runId = runs[0]!.id;
    yield* sql`
      update ai_runs
      set smithers_run_id = ${`ai-chat:${runId}`}
      where id = ${runId}
    `;
    yield* sql`
      insert into ai_observations (
        run_id, chat_id, emitting_task, loop_iteration, attempt,
        observation_key, kind, payload
      )
      values (
        ${runId}, ${chatId}, 'plan-turn', 0, 0,
        'fixture:turn_plan', 'turn_plan',
        ${sql.json(turnPlanPayload(mode, topicIds))}
      )
    `;
    return {
      companyId,
      userId,
      chatId,
      userMessageId,
      runId,
      chatContent: `Question ${suffix}`,
      citationNamespace,
      mode,
      memoryMode,
    };
  });

const persistMemoryArtifact = (
  fixture: Fixture,
  result: MemoryExtractionResult,
): Effect.Effect<MemoryExtractionArtifact, unknown, PgClient.PgClient> =>
  Effect.gen(function* () {
    yield* insertAiObservation({
      runId: fixture.runId,
      chatId: fixture.chatId,
      emittingTask: "memory-extract",
      loopIteration: 0,
      attempt: 1,
      observationKey: "product-state-test:memory-measurement",
      kind: "provider_request_measurement",
      payload: {
        providerRequestIndex: 0,
        agentRole: "memory_extractor",
        modelId: "glm-5-turbo",
        requestSha256Hex: "c".repeat(64),
        sourceExposureProofSha256Hexes: [],
        sourceExposureProofBindings: [],
        inputTokens: 10,
        requestedOutputTokens: 2048,
        usableInputTokens: 6144,
        contextWindow: 8192,
        passed: true,
      },
    });
    yield* insertAiRunUsage({
      runId: fixture.runId,
      taskId: "memory-extract",
      loopIteration: 0,
      attempt: 1,
      providerRequestIndex: 0,
      agentRole: "memory_extractor",
      modelId: "glm-5-turbo",
      providerServiceId: "zai_coding_plan_official",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 14,
        stopReason: "stop",
      },
    });
    const extractionSha256Hex = memoryExtractionSha256Hex(result);
    const observationKey = `product-state-test:memory-extraction:${extractionSha256Hex}`;
    yield* insertAiObservation({
      runId: fixture.runId,
      chatId: fixture.chatId,
      emittingTask: "memory-extract",
      loopIteration: 0,
      attempt: 1,
      observationKey,
      kind: "memory_extraction_result",
      payload: {
        proposalCount: result.proposals.length,
        discardedCount: result.discardedCount,
        extractionSha256Hex,
      },
    });
    return {
      result,
      producer: {
        taskId: "memory-extract",
        loopIteration: 0,
        attempt: 1,
        observationKey,
        extractionSha256Hex,
      },
    };
  });

const createNextRun = (fixture: Fixture, content: string, mode: TurnPlanMode = "single") =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const citationNamespace = newCitationNamespace();
    const messages = yield* sql<{ readonly id: string }>`
      insert into chat_messages (chat_id, author, content)
      values (${fixture.chatId}, 'user', ${content})
      returning id::text
    `;
    const userMessageId = messages[0]!.id;
    const memoryRevisionRows = yield* sql<{ readonly revisionId: string }>`
      select head_revision_id::text as "revisionId"
      from user_memories
      where user_id = ${fixture.userId}
        and deleted_at is null
        and provenance_only_at is null
      order by id
    `;
    const runs = yield* sql<{ readonly id: string }>`
      insert into ai_runs (
        chat_id, initiating_user_id, user_message_id, locale, market,
        acceptance_scope, citation_namespace
      )
      values (
        ${fixture.chatId}, ${fixture.userId}, ${userMessageId}, 'en-US', 'US',
        ${sql.json(
          makeRunAcceptanceScope({
            userId: fixture.userId,
            chatId: fixture.chatId,
            companyId: fixture.companyId,
            memoryMode: fixture.memoryMode,
            memoryRevisionIds: memoryRevisionRows.map((row) => row.revisionId),
            webRequested: true,
            webEnabled: true,
          }),
        )},
        ${citationNamespace}
      )
      returning id::text
    `;
    const runId = runs[0]!.id;
    yield* sql`
      update ai_runs
      set smithers_run_id = ${`ai-chat:${runId}`}
      where id = ${runId}
    `;
    yield* sql`
      insert into ai_observations (
        run_id, chat_id, emitting_task, loop_iteration, attempt,
        observation_key, kind, payload
      )
      values (
        ${runId}, ${fixture.chatId}, 'plan-turn', 0, 0,
        'fixture:turn_plan', 'turn_plan',
        ${sql.json(turnPlanPayload(mode))}
      )
    `;
    return { ...fixture, userMessageId, runId, citationNamespace, mode };
  });

const sourceKeyFor = (fixture: Pick<Fixture, "citationNamespace">, ordinal = 1): string =>
  `k_${fixture.citationNamespace}_${ordinal}`;

const chatReconstructionFor = (
  messageId: string,
  content: string,
  author: "user" | "assistant" = "user",
  ranges?: readonly { readonly charStart: number; readonly charEnd: number }[],
) => {
  const sanitizedContent = author === "assistant" ? stripHistoricalCitationTags(content) : content;
  return {
    messageId,
    contentHash: createHash("sha256").update(sanitizedContent, "utf8").digest("hex"),
    ranges: ranges ?? [{ charStart: 0, charEnd: sanitizedContent.length }],
  };
};

type StructuredReviewPreviewIdentity =
  | {
      readonly kind: "public_document";
      readonly sourceId: string;
      readonly documentId: string;
      readonly snapshotId: string;
      readonly contentHash: string;
    }
  | {
      readonly kind: "publisher_document";
      readonly subscriptionId: string;
      readonly issueId: string;
      readonly documentId: string;
      readonly snapshotId: string;
      readonly publisherExtractionId: string;
      readonly contentHash: string;
    }
  | {
      readonly kind: "chat_message";
      readonly messageId: string;
      readonly sanitizedContentHash: string;
    };

type StructuredReviewPreviewRecordInput = {
  readonly identity: StructuredReviewPreviewIdentity;
  readonly sourceText: string;
  readonly previewRanges: readonly { readonly charStart: number; readonly charEnd: number }[];
};

const canonicalJsonForProductState = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonForProductState).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonForProductState(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const structuredReviewPreviewRecord = (input: StructuredReviewPreviewRecordInput) => {
  const contentHash = createHash("sha256").update(input.sourceText, "utf8").digest("hex");
  const previewText = input.previewRanges
    .map((range) => input.sourceText.slice(range.charStart, range.charEnd))
    .join("\n…\n");
  const previewBytes = new TextEncoder().encode(previewText);
  const recordWithoutDigest = {
    identity: input.identity,
    snapshotId:
      input.identity.kind === "chat_message" ? input.identity.messageId : input.identity.snapshotId,
    contentHash,
    ...(input.identity.kind === "publisher_document"
      ? { publisherExtractionId: input.identity.publisherExtractionId }
      : {}),
    previewRanges: input.previewRanges,
    previewByteLength: previewBytes.byteLength,
    previewSha256Hex: createHash("sha256").update(previewBytes).digest("hex"),
    fastTokenCount: resolveRegisteredModel("glm-5-turbo").countTextTokens(previewText),
    mainTokenCount: resolveRegisteredModel("glm-5-turbo").countTextTokens(previewText),
  };
  return {
    ...recordWithoutDigest,
    recordDigestSha256Hex: createHash("sha256")
      .update(canonicalJsonForProductState(recordWithoutDigest), "utf8")
      .digest("hex"),
  };
};
const structuredReviewCoverage = [
  {
    queryOrdinal: 1,
    branch: "public_documents" as const,
    status: "applicable" as const,
    hitCount: 0,
    truncated: false,
    cap: 1,
  },
  {
    queryOrdinal: 1,
    branch: "publisher_documents" as const,
    status: "not_applicable" as const,
    reason: "scope_documents" as const,
    hitCount: 0,
    truncated: false,
    cap: 1,
  },
  {
    queryOrdinal: 1,
    branch: "chat_messages" as const,
    status: "not_applicable" as const,
    reason: "scope_documents" as const,
    hitCount: 0,
    truncated: false,
    cap: 1,
  },
] as const;
const structuredReviewTruncation = {
  branch: false,
  candidates: false,
  hydration: false,
} as const;

const insertStructuredReviewPreview = (
  fixture: Fixture,
  options: {
    readonly taskId: string;
    readonly loopIteration: number;
    readonly attempt: number;
    readonly providerRequestIndex?: number;
    readonly providerInputSha256Hex: string;
    readonly slot?: "initial" | "replacement";
    readonly records?: readonly StructuredReviewPreviewRecordInput[];
    readonly results?: readonly Record<string, unknown>[];
    readonly coverage?: readonly (typeof structuredReviewCoverage)[number][];
    readonly truncation?: typeof structuredReviewTruncation;
  },
) => {
  const providerRequestIndex = options.providerRequestIndex ?? 0;
  const records = options.records ?? [];
  const coverage = options.coverage ?? structuredReviewCoverage;
  const truncation = options.truncation ?? structuredReviewTruncation;
  const results =
    options.results ??
    records.map((record, index) => ({
      resultId: `r${index + 1}`,
      kind: record.identity.kind === "chat_message" ? "chat_message" : "document",
      label: null,
      date: null,
      tokenCount: 0,
      normalizedFusedScore: 0,
      matchedQueryOrdinals: [],
      branchCoverage: coverage,
      truncationFlags: truncation,
    }));
  const slot = options.slot ?? (providerRequestIndex === 1 ? "initial" : "replacement");
  return insertAiObservation({
    runId: fixture.runId,
    chatId: fixture.chatId,
    emittingTask: options.taskId,
    loopIteration: options.loopIteration,
    attempt: options.attempt,
    observationKey: `${options.taskId}:${options.loopIteration}:${options.attempt}:structured_retrieval_review_preview:${slot}`,
    kind: "structured_retrieval_review_preview",
    payload: {
      taskId: options.taskId,
      loopIteration: options.loopIteration,
      attempt: options.attempt,
      providerRequestIndex,
      agentRole: "internal_retrieval",
      slot,
      results,
      coverage,
      truncation,
      providerInputSha256Hex: options.providerInputSha256Hex,
      records: records.map(structuredReviewPreviewRecord),
    },
  });
};

const seedSingleObservability = (
  fixture: Fixture,
  options: {
    readonly requestSha256Hex?: string;
    readonly answerRequestSha256Hex?: string;
    readonly sourceExposureProofSha256Hexes?: readonly string[];
    readonly planSourceExposureProofSha256Hexes?: readonly string[];
    readonly answerSourceExposureProofSha256Hexes?: readonly string[];
    readonly planSourceExposureProofBindings?: readonly {
      readonly providerSerializationProofSha256Hex: string;
      readonly providerSerializationProofBinding: ProviderVisibleSourceExposureProofBinding;
    }[];
    readonly answerSourceExposureProofBindings?: readonly {
      readonly providerSerializationProofSha256Hex: string;
      readonly providerSerializationProofBinding: ProviderVisibleSourceExposureProofBinding;
    }[];
    readonly includeAnswerMeasurement?: boolean;
    readonly includeStructuredRetrievalTrace?: boolean;
    readonly includeAnswerContext?: boolean;
    readonly selectedConversation?: readonly unknown[];
    readonly includeMemorySelectorMeasurement?: boolean;
    readonly contextSources?: readonly {
      readonly sourceKey: string;
      readonly candidateId?: string;
      readonly kind: "document" | "chat_message" | "memory" | "web";
      readonly ranges: readonly { readonly charStart: number; readonly charEnd: number }[];
      readonly label?: string | null;
      readonly visibleTokenCount?: number;
      readonly documentSourceId?: string;
      readonly documentId?: string;
      readonly snapshotId?: string;
      readonly contentHash?: string;
      readonly publisherIssueId?: string;
      readonly publisherDocumentId?: string;
      readonly publisherExtractionId?: string;
      readonly contentItemIdentity?: string;
    }[];
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const contextSources = options.contextSources ?? [];
    const selectorStateRows = yield* sql<{
      readonly memoryMode: "private_owner" | "disabled";
      readonly webRequested: boolean;
      readonly webPolicyEnabled: boolean;
      readonly activeMemoryCount: number;
    }>`
      select runs.acceptance_scope->>'memoryMode' as "memoryMode",
             coalesce((runs.acceptance_scope->>'webRequested')::boolean, false) as "webRequested",
             coalesce((runs.acceptance_scope->>'webEnabled')::boolean, false) as "webPolicyEnabled",
             (
               select count(*)::int
               from user_memories memories
               where memories.user_id = runs.initiating_user_id
                 and memories.deleted_at is null
                 and memories.provenance_only_at is null
                 and memories.kind is not null
                 and memories.content is not null
                 and memories.head_revision_id is not null
             ) as "activeMemoryCount"
      from ai_runs runs
      join chats on chats.id = runs.chat_id
      where runs.id = ${fixture.runId}
    `;
    const selectorState = selectorStateRows[0]!;
    const answerExposureInputs = contextSources.map((source, sourceOrdinal) => ({
      runId: fixture.runId,
      taskId: "single-answer",
      loopIteration: 0,
      attempt: 0,
      providerRequestIndex: 0,
      providerRequestSha256Hex: options.answerRequestSha256Hex ?? "b".repeat(64),
      sourceKind: source.kind,
      logicalSourceIdentity: source.candidateId ?? `candidate:${source.sourceKey}`,
      contentItemIdentity:
        source.contentItemIdentity ??
        (source.kind === "chat_message"
          ? fixture.userMessageId
          : source.kind === "document"
            ? `${source.candidateId ?? `candidate:${source.sourceKey}`}:${source.snapshotId ?? "fixture-version"}:${sha256Base64Url(JSON.stringify(source.ranges))}`
            : source.sourceKey),
      exposureStage: "answer_serialized",
      visibleTokenCount:
        source.visibleTokenCount ??
        (source.kind === "chat_message"
          ? resolveRegisteredModel("glm-5-turbo").countTextTokens(
              source.ranges
                .map((range) =>
                  (source.contentItemIdentity ?? fixture.userMessageId) === fixture.userMessageId
                    ? fixture.chatContent.slice(range.charStart, range.charEnd)
                    : (source.label ?? "Question").slice(range.charStart, range.charEnd),
                )
                .join("\n…\n"),
            )
          : 3),
      ...(source.publisherIssueId === undefined
        ? {}
        : { publisherIssueId: source.publisherIssueId }),
      ...(source.publisherDocumentId === undefined
        ? {}
        : { publisherDocumentId: source.publisherDocumentId }),
      providerSerializationProofBinding: {
        messageIndex: 0,
        sourceOrdinal,
        serializedField: `messages[0].content.evidence.source[${sourceOrdinal}](${source.sourceKey})`,
        orderedSourceDescriptor: `fixture:${source.sourceKey}`,
      },
      ...(source.kind === "document"
        ? {
            documentReconstruction: {
              sourceId: source.documentSourceId ?? "public:fixture-source",
              documentId: source.documentId ?? "fixture-document",
              snapshotId: source.snapshotId ?? "fixture-version",
              contentHash: source.contentHash ?? "f".repeat(64),
              ranges: source.ranges,
              ...(source.publisherExtractionId === undefined
                ? {}
                : { publisherExtractionId: source.publisherExtractionId }),
            },
          }
        : {}),
      ...(source.kind === "chat_message"
        ? {
            chatReconstruction: chatReconstructionFor(
              source.contentItemIdentity ?? fixture.userMessageId,
              (source.contentItemIdentity ?? fixture.userMessageId) === fixture.userMessageId
                ? fixture.chatContent
                : (source.label ?? "Question"),
              "user",
              source.ranges,
            ),
          }
        : {}),
    }));
    const answerExposureProofs = answerExposureInputs.map((source) =>
      providerVisibleSourceExposureProofSha256Hex(
        {
          sourceKind: source.sourceKind,
          logicalSourceIdentity: source.logicalSourceIdentity,
          contentItemIdentity: source.contentItemIdentity,
          exposureStage: source.exposureStage,
          visibleTokenCount: source.visibleTokenCount,
        },
        source.providerSerializationProofBinding,
      ),
    );
    const answerExposureBindings = answerExposureInputs.map((source, index) => ({
      providerSerializationProofSha256Hex: answerExposureProofs[index]!,
      providerSerializationProofBinding: source.providerSerializationProofBinding,
    }));
    const bindingsFor = (
      proofs: readonly string[],
      explicit: readonly {
        readonly providerSerializationProofSha256Hex: string;
        readonly providerSerializationProofBinding: ProviderVisibleSourceExposureProofBinding;
      }[] = [],
    ) =>
      [...answerExposureBindings, ...explicit].filter((binding) =>
        proofs.includes(binding.providerSerializationProofSha256Hex),
      );
    const planProofs =
      options.planSourceExposureProofSha256Hexes ?? options.sourceExposureProofSha256Hexes ?? [];
    yield* insertAiObservation({
      runId: fixture.runId,
      chatId: fixture.chatId,
      emittingTask: "plan-turn",
      loopIteration: 0,
      attempt: 0,
      observationKey: "fixture:plan-turn:measurement",
      kind: "provider_request_measurement",
      payload: {
        providerRequestIndex: 0,
        agentRole: "plan_turn",
        modelId: "glm-5-turbo",
        requestSha256Hex: options.requestSha256Hex ?? "a".repeat(64),
        sourceExposureProofSha256Hexes:
          options.planSourceExposureProofSha256Hexes ??
          options.sourceExposureProofSha256Hexes ??
          [],
        sourceExposureProofBindings: bindingsFor(
          planProofs,
          options.planSourceExposureProofBindings,
        ),
        inputTokens: 10,
        requestedOutputTokens: 2048,
        usableInputTokens: 6144,
        contextWindow: 8192,
        passed: true,
      },
    });
    yield* insertAiRunUsage({
      runId: fixture.runId,
      taskId: "plan-turn",
      loopIteration: 0,
      attempt: 0,
      providerRequestIndex: 0,
      agentRole: "plan_turn",
      modelId: "glm-5-turbo",
      providerServiceId: "zai_coding_plan_official",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 14,
        stopReason: "stop",
      },
    });
    if (fixture.mode === "clarify") return;
    if (options.includeAnswerMeasurement !== false) {
      yield* insertAiObservation({
        runId: fixture.runId,
        chatId: fixture.chatId,
        emittingTask: "single-answer",
        loopIteration: 0,
        attempt: 0,
        observationKey: "fixture:single-answer:measurement",
        kind: "provider_request_measurement",
        payload: {
          providerRequestIndex: 0,
          agentRole: "direct_answer",
          modelId: "glm-5-turbo",
          requestSha256Hex: options.answerRequestSha256Hex ?? "b".repeat(64),
          sourceExposureProofSha256Hexes:
            options.answerSourceExposureProofSha256Hexes ??
            options.sourceExposureProofSha256Hexes ??
            answerExposureProofs,
          sourceExposureProofBindings: bindingsFor(
            options.answerSourceExposureProofSha256Hexes ??
              options.sourceExposureProofSha256Hexes ??
              answerExposureProofs,
            options.answerSourceExposureProofBindings,
          ),
          inputTokens: 10,
          requestedOutputTokens: 2048,
          usableInputTokens: 6144,
          contextWindow: 8192,
          passed: true,
        },
      });
      yield* insertAiRunUsage({
        runId: fixture.runId,
        taskId: "single-answer",
        loopIteration: 0,
        attempt: 0,
        providerRequestIndex: 0,
        agentRole: "direct_answer",
        modelId: "glm-5-turbo",
        providerServiceId: "zai_coding_plan_official",
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cachedTokens: 0,
          reasoningTokens: 0,
          totalTokens: 14,
          stopReason: "stop",
        },
      });
    }
    for (const [taskId, selectorRole] of [
      ["single-retrieve-internal", "internal"],
      ["single-select-memories", "memory"],
      ["single-retrieve-web", "web"],
    ] as const) {
      const noCallReason =
        selectorRole === "memory"
          ? selectorState.memoryMode === "disabled"
            ? "memory_mode_disabled"
            : options.includeMemorySelectorMeasurement === false ||
                selectorState.activeMemoryCount === 0
              ? "no_active_memories"
              : undefined
          : selectorRole === "web" && !selectorState.webRequested
            ? "web_not_requested"
            : selectorRole === "web" && !selectorState.webPolicyEnabled
              ? "web_policy_disabled"
              : undefined;
      if (noCallReason !== undefined) {
        yield* sql`
          insert into ai_observations (
            run_id, chat_id, emitting_task, loop_iteration, attempt,
            observation_key, kind, payload
          )
          values (
            ${fixture.runId}, ${fixture.chatId}, ${taskId}, 0, 0,
            ${`${taskId}:0:0:retrieval_manifest:result`}, 'retrieval_manifest',
            ${sql.json({
              selectorRole,
              references: [],
              noCallReason,
            })}
          )
        `;
        continue;
      }
      const agentRole =
        selectorRole === "internal"
          ? "internal_retrieval"
          : selectorRole === "memory"
            ? "memory_selector"
            : "web_research";
      yield* insertAiObservation({
        runId: fixture.runId,
        chatId: fixture.chatId,
        emittingTask: taskId,
        loopIteration: 0,
        attempt: 0,
        observationKey: `fixture:${taskId}:measurement`,
        kind: "provider_request_measurement",
        payload: {
          providerRequestIndex: 0,
          agentRole,
          modelId: "glm-5-turbo",
          requestSha256Hex: "e".repeat(64),
          sourceExposureProofSha256Hexes: [],
          sourceExposureProofBindings: [],
          inputTokens: 10,
          requestedOutputTokens: 2048,
          usableInputTokens: 6144,
          contextWindow: 8192,
          passed: true,
        },
      });
      yield* insertAiRunUsage({
        runId: fixture.runId,
        taskId,
        loopIteration: 0,
        attempt: 0,
        providerRequestIndex: 0,
        agentRole,
        modelId: "glm-5-turbo",
        providerServiceId: "zai_coding_plan_official",
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cachedTokens: 0,
          reasoningTokens: 0,
          totalTokens: 14,
          stopReason: "stop",
        },
      });
      if (selectorRole === "internal") {
        yield* insertProviderMeasurementAndUsage(fixture, {
          taskId,
          agentRole: "internal_retrieval",
          loopIteration: 0,
          attempt: 0,
          providerRequestIndex: 1,
          requestSha256Hex: "f".repeat(64),
        });
      }
      yield* sql`
        insert into ai_observations (
          run_id, chat_id, emitting_task, loop_iteration, attempt,
          observation_key, kind, payload
        )
        values (
          ${fixture.runId}, ${fixture.chatId}, ${taskId}, 0, 0,
          ${`fixture:${taskId}:retrieval_manifest`}, 'retrieval_manifest',
          ${sql.json({ selectorRole, references: [] })}
        )
      `;
      if (selectorRole === "internal" && options.includeStructuredRetrievalTrace !== false) {
        yield* insertAiObservation({
          runId: fixture.runId,
          chatId: fixture.chatId,
          emittingTask: taskId,
          loopIteration: 0,
          attempt: 0,
          observationKey: `${taskId}:0:0:structured_retrieval_trace:result`,
          kind: "structured_retrieval_trace",
          payload: {
            initialPlan: {
              action: "search",
              queries: [
                {
                  purpose: "fixture",
                  all: [{ text: "fixture", mode: "term" }],
                  anyOf: [],
                  not: [],
                  filters: {},
                  order: "relevance",
                },
              ],
            },
            review: { action: "accept", reason: "sufficient_coverage" },
            replacementPlan: null,
            outcome: "accepted",
          },
        });
      }
    }
    for (const exposure of answerExposureInputs) {
      yield* insertAiSourceExposure(exposure);
    }
    const contextLedger = {
      requestKind: "direct",
      modelId: "glm-5-turbo",
      requestSha256Hex: options.answerRequestSha256Hex ?? "b".repeat(64),
      inputTokens: 10,
      requestedOutputTokens: 2048,
      usableInputTokens: 6144,
      selectedConversation: options.selectedConversation ?? [],
      question: "current question",
      gaps: [],
      sources: contextSources.map((source, index) => ({
        candidateId: source.candidateId ?? `fixture-candidate-${index}`,
        sourceKey: source.sourceKey,
        kind: source.kind,
        purpose: "fixture",
        label: source.label ?? (source.kind === "chat_message" ? "Question" : "Fixture source"),
        ranges: source.ranges,
      })),
    };
    if (options.includeAnswerContext !== false) {
      yield* sql`
      insert into ai_observations (
        run_id, chat_id, emitting_task, loop_iteration, attempt,
        observation_key, kind, payload
      )
      values (
        ${fixture.runId}, ${fixture.chatId}, 'single-measure', 0, 0,
        'fixture:context_measurement', 'context_measurement',
        ${sql.json({
          consumerTaskId: "single-answer",
          mandatoryInputTokens: 10,
          discretionaryInputTokens: 0,
          totalInputTokens: 10,
          requestedOutputTokens: 2048,
          usableInputTokens: 6144,
          contextWindow: 8192,
          status: "ready",
          compactionRan: false,
          compactionFeedback: [],
          restrictedContextLedger: contextLedger,
        })}
      )
      `;
      yield* sql`
      insert into ai_observations (
        run_id, chat_id, emitting_task, loop_iteration, attempt,
        observation_key, kind, payload
      )
      values (
        ${fixture.runId}, ${fixture.chatId}, 'single-answer', 0, 0,
        'fixture:context_serialized', 'context_serialized',
        ${sql.json({
          consumerTaskId: "single-answer",
          sourceKeys: contextSources.map((source) => source.sourceKey),
          restrictedContextLedger: contextLedger,
          terminalUsageCoordinate: {
            taskId: "single-answer",
            loopIteration: 0,
            attempt: 0,
            providerRequestIndex: 0,
          },
        })}
      )
      `;
    }
  });

const failedDirectContextLedger = (requestSha256Hex: string) => ({
  requestKind: "direct" as const,
  modelId: "glm-5-turbo",
  requestSha256Hex,
  inputTokens: 10,
  usableInputTokens: 6144,
  requestedOutputTokens: 2048,
  selectedConversation: [],
  question: "current question",
  gaps: [],
  sources: [],
});

const failedTopicContextLedger = (requestSha256Hex: string) => ({
  requestKind: "topic" as const,
  topicId: "t1" as const,
  modelId: "glm-5-turbo",
  requestSha256Hex,
  inputTokens: 10,
  usableInputTokens: 6144,
  requestedOutputTokens: 2048,
  selectedConversation: [],
  question: "first topic",
  gaps: [],
  sources: [],
});

const failedSynthesisContextLedger = (
  requestSha256Hex: string,
  topicIds: readonly ("t1" | "t2" | "t3")[] = ["t1", "t2"],
) => ({
  requestKind: "synthesis" as const,
  modelId: "glm-5-turbo",
  requestSha256Hex,
  inputTokens: 10,
  usableInputTokens: 6144,
  requestedOutputTokens: 2048,
  selectedConversation: [],
  packets: topicIds.map((topicId, index) => ({
    topicId,
    status: "partial" as const,
    claimCount: 0,
    gapCount: 0,
    packetSha256Hex: String.fromCharCode("c".charCodeAt(0) + index).repeat(64),
  })),
});

const insertProviderMeasurementAndUsage = (
  fixture: Fixture,
  options: {
    readonly taskId: string;
    readonly agentRole: string;
    readonly loopIteration: number;
    readonly attempt: number;
    readonly providerRequestIndex?: number;
    readonly requestSha256Hex: string;
    readonly sourceExposureProofSha256Hexes?: readonly string[];
    readonly sourceExposureProofBindings?: readonly {
      readonly providerSerializationProofSha256Hex: string;
      readonly providerSerializationProofBinding: ProviderVisibleSourceExposureProofBinding;
    }[];
    readonly withUsage?: boolean;
    readonly repairConsumed?: boolean;
  },
): Effect.Effect<void, unknown, PgClient.PgClient> =>
  Effect.gen(function* () {
    const providerRequestIndex = options.providerRequestIndex ?? 0;
    yield* insertAiObservation({
      runId: fixture.runId,
      chatId: fixture.chatId,
      emittingTask: options.taskId,
      loopIteration: options.loopIteration,
      attempt: options.attempt,
      observationKey: `fixture:${options.taskId}:measurement:${options.loopIteration}:${options.attempt}:${providerRequestIndex}`,
      kind: "provider_request_measurement",
      payload: {
        providerRequestIndex,
        agentRole: options.agentRole,
        modelId: "glm-5-turbo",
        requestSha256Hex: options.requestSha256Hex,
        sourceExposureProofSha256Hexes: options.sourceExposureProofSha256Hexes ?? [],
        sourceExposureProofBindings: options.sourceExposureProofBindings ?? [],
        inputTokens: 10,
        requestedOutputTokens: 2048,
        usableInputTokens: 6144,
        contextWindow: 8192,
        passed: true,
        ...(options.repairConsumed === undefined ? {} : { repairConsumed: options.repairConsumed }),
      },
    });
    if (options.agentRole === "internal_retrieval" && providerRequestIndex > 0) {
      yield* insertStructuredReviewPreview(fixture, {
        taskId: options.taskId,
        loopIteration: options.loopIteration,
        attempt: options.attempt,
        providerRequestIndex,
        providerInputSha256Hex: options.requestSha256Hex,
      });
    }
    if (options.withUsage === false) return;
    yield* insertAiRunUsage({
      runId: fixture.runId,
      taskId: options.taskId,
      loopIteration: options.loopIteration,
      attempt: options.attempt,
      providerRequestIndex,
      agentRole: options.agentRole,
      modelId: "glm-5-turbo",
      providerServiceId: "zai_coding_plan_official",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 14,
        stopReason: "stop",
      },
    });
  });
const prepareGeneralPlannerEvaluation = (
  fixture: Fixture,
  options: {
    readonly sourceExposureProofSha256Hexes?: readonly string[];
    readonly sourceExposureProofBindings?: readonly {
      readonly providerSerializationProofSha256Hex: string;
      readonly providerSerializationProofBinding: ProviderVisibleSourceExposureProofBinding;
    }[];
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const sessionId = crypto.randomUUID();
    yield* sql`
      delete from ai_source_exposures where run_id = ${fixture.runId}
    `;
    yield* sql`
      delete from ai_run_usage
      where run_id = ${fixture.runId}
        and task_id <> 'memory-extract'
    `;
    yield* sql`
      delete from ai_observations
      where run_id = ${fixture.runId}
        and not (
          kind = 'turn_plan'
          or (
            emitting_task = 'memory-extract'
            and kind in ('provider_request_measurement', 'memory_extraction_result')
          )
        )
    `;
    yield* sql`
      update ai_observations
      set emitting_task = 'evaluation-general-planner',
          observation_key = 'evaluation-general-planner:turn-plan'
      where run_id = ${fixture.runId}
        and kind = 'turn_plan'
    `;
    yield* sql`
      insert into ai_evaluation_sessions (
        id, artifact_version, golden_set_version, fixture_sha256_hex, status
      ) values (${sessionId}, 4, 4, ${"a".repeat(64)}, 'preparing')
    `;
    yield* sql`
      insert into ai_evaluation_case_runs (
        session_id, case_id, topology, ai_run_id, seed_manifest, status
      ) values (
        ${sessionId}, ${`general-planner-${fixture.runId}`}, 'general_planner',
        ${fixture.runId}, '{}'::jsonb, 'seeded'
      )
    `;
    yield* insertProviderMeasurementAndUsage(fixture, {
      taskId: "evaluation-general-planner",
      agentRole: "evaluation_general_planner",
      loopIteration: 0,
      attempt: 0,
      requestSha256Hex: "a".repeat(64),
      ...(options.sourceExposureProofSha256Hexes === undefined
        ? {}
        : { sourceExposureProofSha256Hexes: options.sourceExposureProofSha256Hexes }),
      ...(options.sourceExposureProofBindings === undefined
        ? {}
        : { sourceExposureProofBindings: options.sourceExposureProofBindings }),
    });
    yield* insertAiObservation({
      runId: fixture.runId,
      chatId: fixture.chatId,
      emittingTask: "evaluation-general-planner",
      loopIteration: 0,
      attempt: 0,
      observationKey: "evaluation-general-planner:0:0:retrieval_manifest:result",
      kind: "retrieval_manifest",
      payload: { selectorRole: "general_planner", references: [] },
    });
  });

const generalPlannerChatSourceEvidenceFor = (fixture: Fixture, source: FinalSourceRecord) => {
  const use = source.uses[0]!;
  const ranges = use.ranges;
  const binding = {
    messageIndex: 0,
    sourceOrdinal: 0,
    serializedField: `messages[0].tool.inspect_evidence.source[0](${source.sourceKey})`,
    orderedSourceDescriptor: `evaluation:${source.sourceKey}`,
  } as const;
  const visibleTokenCount = resolveRegisteredModel("glm-5-turbo").countTextTokens(
    ranges.map((range) => fixture.chatContent.slice(range.charStart, range.charEnd)).join("\n…\n"),
  );
  const marker = {
    sourceKind: "chat_message" as const,
    logicalSourceIdentity: chatMessageEvidenceIdentity(fixture.userMessageId),
    contentItemIdentity: fixture.userMessageId,
    exposureStage: "evaluation_general_planner_inspect" as const,
    visibleTokenCount,
  };
  return {
    ranges,
    binding,
    marker,
    proof: providerVisibleSourceExposureProofSha256Hex(marker, binding),
    visibleTokenCount,
  };
};

const insertGeneralPlannerChatSourceExposure = (fixture: Fixture, source: FinalSourceRecord) =>
  Effect.gen(function* () {
    const evidence = generalPlannerChatSourceEvidenceFor(fixture, source);
    yield* insertAiSourceExposure({
      runId: fixture.runId,
      taskId: "evaluation-general-planner",
      loopIteration: 0,
      attempt: 0,
      providerRequestIndex: 0,
      providerRequestSha256Hex: "a".repeat(64),
      sourceKind: "chat_message",
      logicalSourceIdentity: evidence.marker.logicalSourceIdentity,
      contentItemIdentity: evidence.marker.contentItemIdentity,
      chatReconstruction: chatReconstructionFor(
        fixture.userMessageId,
        fixture.chatContent,
        "user",
        evidence.ranges,
      ),
      exposureStage: evidence.marker.exposureStage,
      visibleTokenCount: evidence.visibleTokenCount,
      providerSerializationProofBinding: evidence.binding,
    });
  });

const insertInternalRetrievalPlanAndReview = (
  fixture: Fixture,
  options: {
    readonly taskId: string;
    readonly loopIteration: number;
    readonly attempt: number;
    readonly planRequestSha256Hex?: string;
    readonly reviewRequestSha256Hex?: string;
    readonly withUsage?: boolean;
  },
) =>
  Effect.gen(function* () {
    yield* insertProviderMeasurementAndUsage(fixture, {
      taskId: options.taskId,
      agentRole: "internal_retrieval",
      loopIteration: options.loopIteration,
      attempt: options.attempt,
      providerRequestIndex: 0,
      requestSha256Hex: options.planRequestSha256Hex ?? "e".repeat(64),
      ...(options.withUsage === undefined ? {} : { withUsage: options.withUsage }),
    });
    yield* insertProviderMeasurementAndUsage(fixture, {
      taskId: options.taskId,
      agentRole: "internal_retrieval",
      loopIteration: options.loopIteration,
      attempt: options.attempt,
      providerRequestIndex: 1,
      requestSha256Hex: options.reviewRequestSha256Hex ?? "f".repeat(64),
      ...(options.withUsage === undefined ? {} : { withUsage: options.withUsage }),
    });
    yield* insertAiObservation({
      runId: fixture.runId,
      chatId: fixture.chatId,
      emittingTask: options.taskId,
      loopIteration: options.loopIteration,
      attempt: options.attempt,
      observationKey: `${options.taskId}:${options.loopIteration}:${options.attempt}:structured_retrieval_trace:result`,
      kind: "structured_retrieval_trace",
      payload: {
        initialPlan: {
          action: "search",
          queries: [
            {
              purpose: "fixture",
              all: [{ text: "fixture", mode: "term" }],
              anyOf: [],
              not: [],
              filters: {},
              order: "relevance",
            },
          ],
        },
        review: { action: "accept", reason: "sufficient_coverage" },
        replacementPlan: null,
        outcome: "accepted",
      },
    });
  });

const insertProviderMeasurementAndUsageAfterTerminal = (
  fixture: Fixture,
  options: {
    readonly taskId: string;
    readonly agentRole: string;
    readonly loopIteration: number;
    readonly attempt: number;
    readonly requestSha256Hex: string;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      insert into ai_observations (
        run_id, chat_id, emitting_task, loop_iteration, attempt,
        observation_key, kind, payload
      )
      values (
        ${fixture.runId}, ${fixture.chatId}, ${options.taskId},
        ${options.loopIteration}, ${options.attempt},
        ${`forged:${options.taskId}:${options.loopIteration}:${options.attempt}:measurement`},
        'provider_request_measurement',
        ${sql.json({
          providerRequestIndex: 0,
          agentRole: options.agentRole,
          modelId: "glm-5-turbo",
          requestSha256Hex: options.requestSha256Hex,
          sourceExposureProofSha256Hexes: [],
          sourceExposureProofBindings: [],
          inputTokens: 10,
          requestedOutputTokens: 2048,
          usableInputTokens: 6144,
          contextWindow: 8192,
          passed: true,
        })}
      )
    `;
    yield* sql`
      insert into ai_run_usage (
        run_id, task_id, loop_iteration, attempt, provider_request_index,
        agent_role, model_id, provider_service_id,
        input_tokens, output_tokens, cached_tokens, reasoning_tokens,
        total_tokens, stop_reason
      )
      values (
        ${fixture.runId}, ${options.taskId}, ${options.loopIteration}, ${options.attempt}, 0,
        ${options.agentRole}, 'glm-5-turbo', 'zai_coding_plan_official',
        10, 4, 0, 0, 14, 'stop'
      )
    `;
  });

const seedFanoutFailureBase = (
  fixture: Fixture,
  topicIds: readonly ("t1" | "t2" | "t3")[] = ["t1", "t2"],
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const stateRows = yield* sql<{
      readonly webRequested: boolean;
      readonly webPolicyEnabled: boolean;
    }>`
      select coalesce((acceptance_scope->>'webRequested')::boolean, false) as "webRequested",
             coalesce((acceptance_scope->>'webEnabled')::boolean, false) as "webPolicyEnabled"
      from ai_runs
      where id = ${fixture.runId}
    `;
    const state = stateRows[0]!;
    const webNoCallReason = !state.webRequested
      ? "web_not_requested"
      : !state.webPolicyEnabled
        ? "web_policy_disabled"
        : "topic_not_web_eligible";
    yield* insertProviderMeasurementAndUsage(fixture, {
      taskId: "plan-turn",
      agentRole: "plan_turn",
      loopIteration: 0,
      attempt: 0,
      requestSha256Hex: "a".repeat(64),
    });
    for (const [topicIndex, topicId] of topicIds.entries()) {
      const internalTaskId = `topic-${topicId}-retrieve-internal`;
      yield* insertInternalRetrievalPlanAndReview(fixture, {
        taskId: internalTaskId,
        loopIteration: 0,
        attempt: 0,
        planRequestSha256Hex: String.fromCharCode("b".charCodeAt(0) + topicIndex).repeat(64),
        reviewRequestSha256Hex: String.fromCharCode("d".charCodeAt(0) + topicIndex).repeat(64),
      });
      yield* insertAiObservation({
        runId: fixture.runId,
        chatId: fixture.chatId,
        emittingTask: internalTaskId,
        loopIteration: 0,
        attempt: 0,
        observationKey: `${internalTaskId}:0:0:retrieval_manifest:result`,
        kind: "retrieval_manifest",
        payload: { selectorRole: "internal", references: [] },
      });
      for (const [suffix, selectorRole] of [
        ["select-memories", "memory"],
        ["retrieve-web", "web"],
      ] as const) {
        const taskId = `topic-${topicId}-${suffix}`;
        yield* insertAiObservation({
          runId: fixture.runId,
          chatId: fixture.chatId,
          emittingTask: taskId,
          loopIteration: 0,
          attempt: 0,
          observationKey: `${taskId}:0:0:retrieval_manifest:result`,
          kind: "retrieval_manifest",
          payload: {
            selectorRole,
            references: [],
            noCallReason: selectorRole === "memory" ? "no_active_memories" : webNoCallReason,
          },
        });
      }
    }
  });

const seedFailedCompactedContext = (
  fixture: Fixture,
  options:
    | {
        readonly answerTaskId: "single-answer";
        readonly answerAttempt: number;
        readonly initialLedger: ReturnType<typeof failedDirectContextLedger>;
        readonly compactedLedger: ReturnType<typeof failedDirectContextLedger>;
        readonly initialAttempt?: number;
        readonly compactedLoopIteration?: number;
        readonly compactedAttempt?: number;
        readonly answerRepairConsumed?: boolean;
        readonly compactedBeforeInitial?: boolean;
      }
    | {
        readonly answerTaskId: "topic-t1-answer";
        readonly answerAttempt: number;
        readonly initialLedger: ReturnType<typeof failedTopicContextLedger>;
        readonly compactedLedger: ReturnType<typeof failedTopicContextLedger>;
        readonly initialAttempt?: number;
        readonly compactedLoopIteration?: number;
        readonly compactedAttempt?: number;
        readonly answerRepairConsumed?: boolean;
        readonly compactedBeforeInitial?: boolean;
      },
) =>
  Effect.gen(function* () {
    if (fixture.mode === "single") {
      yield* seedSingleObservability(fixture, {
        includeAnswerMeasurement: false,
        includeAnswerContext: false,
      });
    } else {
      yield* seedFanoutFailureBase(fixture);
    }
    yield* insertProviderMeasurementAndUsage(fixture, {
      taskId: options.answerTaskId,
      agentRole: options.answerTaskId === "single-answer" ? "direct_answer" : "topic_answer",
      loopIteration: 0,
      attempt: options.answerAttempt,
      requestSha256Hex: options.compactedLedger.requestSha256Hex,
      ...(options.answerRepairConsumed === undefined
        ? {}
        : { repairConsumed: options.answerRepairConsumed }),
      withUsage: false,
    });
    const initialTaskId =
      options.answerTaskId === "single-answer" ? "single-measure" : "topic-t1-measure";
    const compactedTaskId =
      options.answerTaskId === "single-answer"
        ? "single-compact-measure"
        : "topic-t1-compact-measure";
    const topicId = options.answerTaskId === "single-answer" ? undefined : "t1";
    const insertContextMeasurement = (
      taskId: string,
      loopIteration: number,
      attempt: number,
      ledger:
        | ReturnType<typeof failedDirectContextLedger>
        | ReturnType<typeof failedTopicContextLedger>,
      status: "needs_compaction" | "ready",
      compactionRan: boolean,
    ) =>
      insertAiObservation({
        runId: fixture.runId,
        chatId: fixture.chatId,
        emittingTask: taskId,
        loopIteration,
        attempt,
        observationKey: `fixture:${taskId}:context-measurement:${loopIteration}:${attempt}`,
        kind: "context_measurement",
        payload: {
          consumerTaskId: options.answerTaskId,
          ...(topicId === undefined ? {} : { topicId }),
          mandatoryInputTokens: 10,
          discretionaryInputTokens: Math.max(0, ledger.inputTokens - 10),
          totalInputTokens: ledger.inputTokens,
          requestedOutputTokens: ledger.requestedOutputTokens,
          usableInputTokens: ledger.usableInputTokens,
          contextWindow: 8192,
          status,
          compactionRan,
          compactionFeedback: [],
          restrictedContextLedger: ledger,
        },
      });
    const insertInitial = () =>
      insertContextMeasurement(
        initialTaskId,
        0,
        options.initialAttempt ?? 1,
        options.initialLedger,
        "needs_compaction",
        false,
      );
    const insertCompacted = () =>
      insertContextMeasurement(
        compactedTaskId,
        options.compactedLoopIteration ?? 1,
        options.compactedAttempt ?? 2,
        options.compactedLedger,
        "ready",
        true,
      );
    if (options.compactedBeforeInitial) {
      yield* insertCompacted();
      yield* insertInitial();
    } else {
      yield* insertInitial();
      yield* insertCompacted();
    }
    yield* insertAiObservation({
      runId: fixture.runId,
      chatId: fixture.chatId,
      emittingTask: options.answerTaskId,
      loopIteration: 0,
      attempt: options.answerAttempt,
      observationKey: `fixture:${options.answerTaskId}:context-serialized`,
      kind: "context_serialized",
      payload: {
        consumerTaskId: options.answerTaskId,
        ...(topicId === undefined ? {} : { topicId }),
        sourceKeys: [],
        restrictedContextLedger: options.compactedLedger,
        terminalUsageCoordinate: {
          taskId: options.answerTaskId,
          loopIteration: 0,
          attempt: options.answerAttempt,
          providerRequestIndex: 0,
        },
      },
    });
  });

type SuccessfulCompactedContextLedger = {
  readonly requestKind: "direct" | "topic" | "synthesis";
  readonly modelId: string;
  readonly requestSha256Hex: string;
  readonly inputTokens: number;
  readonly usableInputTokens: number;
  readonly requestedOutputTokens: number;
  readonly selectedConversation: readonly unknown[];
  readonly question?: string;
  readonly topicId?: "t1" | "t2" | "t3";
  readonly gaps?: readonly string[];
  readonly sources?: readonly unknown[];
  readonly packets?: readonly {
    readonly topicId: "t1" | "t2" | "t3";
    readonly status: "answered" | "partial";
    readonly claimCount: number;
    readonly gapCount: number;
    readonly packetSha256Hex: string;
  }[];
};

const insertSuccessfulCompactedContextPath = (
  fixture: Fixture,
  options: {
    readonly consumerTaskId: string;
    readonly topicId?: "t1" | "t2" | "t3";
    readonly sourceKeys?: readonly string[];
    readonly initialTaskId: string;
    readonly compactedTaskId: string;
    readonly initialLedger: SuccessfulCompactedContextLedger;
    readonly compactedLedger: SuccessfulCompactedContextLedger;
  },
) =>
  Effect.gen(function* () {
    const insertMeasurement = (
      taskId: string,
      loopIteration: number,
      attempt: number,
      ledger: SuccessfulCompactedContextLedger,
      status: "needs_compaction" | "ready",
      compactionRan: boolean,
    ) =>
      insertAiObservation({
        runId: fixture.runId,
        chatId: fixture.chatId,
        emittingTask: taskId,
        loopIteration,
        attempt,
        observationKey: `fixture:${taskId}:context-measurement:${loopIteration}:${attempt}`,
        kind: "context_measurement",
        payload: {
          consumerTaskId: options.consumerTaskId,
          ...(options.topicId === undefined ? {} : { topicId: options.topicId }),
          mandatoryInputTokens: 10,
          discretionaryInputTokens: Math.max(0, ledger.inputTokens - 10),
          totalInputTokens: ledger.inputTokens,
          requestedOutputTokens: ledger.requestedOutputTokens,
          usableInputTokens: ledger.usableInputTokens,
          contextWindow: 8192,
          status,
          compactionRan,
          compactionFeedback: [],
          restrictedContextLedger: ledger,
        },
      });
    yield* insertMeasurement(
      options.initialTaskId,
      0,
      1,
      options.initialLedger,
      "needs_compaction",
      false,
    );
    yield* insertMeasurement(options.compactedTaskId, 1, 2, options.compactedLedger, "ready", true);
    yield* insertAiObservation({
      runId: fixture.runId,
      chatId: fixture.chatId,
      emittingTask: options.consumerTaskId,
      loopIteration: 0,
      attempt: 0,
      observationKey: `fixture:${options.consumerTaskId}:context-serialized`,
      kind: "context_serialized",
      payload: {
        consumerTaskId: options.consumerTaskId,
        ...(options.topicId === undefined ? {} : { topicId: options.topicId }),
        sourceKeys: options.sourceKeys ?? [],
        restrictedContextLedger: options.compactedLedger,
        terminalUsageCoordinate: {
          taskId: options.consumerTaskId,
          loopIteration: 0,
          attempt: 0,
          providerRequestIndex: 0,
        },
      },
    });
  });

const seedFailedSingleAnswerObservability = (
  fixture: Fixture,
  options: {
    readonly answerAttempt: number;
    readonly measureLoopIteration: number;
    readonly measureAttempt: number;
  },
) =>
  Effect.gen(function* () {
    yield* seedSingleObservability(fixture, {
      includeAnswerMeasurement: false,
      includeAnswerContext: false,
    });
    const requestSha256Hex = "9".repeat(64);
    const restrictedContextLedger = failedDirectContextLedger(requestSha256Hex);
    yield* insertAiObservation({
      runId: fixture.runId,
      chatId: fixture.chatId,
      emittingTask: "single-answer",
      loopIteration: 0,
      attempt: options.answerAttempt,
      observationKey: "fixture:failed-answer:measurement",
      kind: "provider_request_measurement",
      payload: {
        providerRequestIndex: 0,
        agentRole: "direct_answer",
        modelId: "glm-5-turbo",
        requestSha256Hex,
        sourceExposureProofSha256Hexes: [],
        sourceExposureProofBindings: [],
        inputTokens: 10,
        requestedOutputTokens: 2048,
        usableInputTokens: 6144,
        contextWindow: 8192,
        passed: true,
      },
    });
    yield* insertAiObservation({
      runId: fixture.runId,
      chatId: fixture.chatId,
      emittingTask: "single-measure",
      loopIteration: options.measureLoopIteration,
      attempt: options.measureAttempt,
      observationKey: "fixture:failed-answer:context-measurement",
      kind: "context_measurement",
      payload: {
        consumerTaskId: "single-answer",
        mandatoryInputTokens: 10,
        discretionaryInputTokens: 0,
        totalInputTokens: 10,
        requestedOutputTokens: 2048,
        usableInputTokens: 6144,
        contextWindow: 8192,
        status: "ready",
        compactionRan: false,
        compactionFeedback: [],
        restrictedContextLedger,
      },
    });
    yield* insertAiObservation({
      runId: fixture.runId,
      chatId: fixture.chatId,
      emittingTask: "single-answer",
      loopIteration: 0,
      attempt: options.answerAttempt,
      observationKey: "fixture:failed-answer:context-serialized",
      kind: "context_serialized",
      payload: {
        consumerTaskId: "single-answer",
        sourceKeys: [],
        restrictedContextLedger,
        terminalUsageCoordinate: {
          taskId: "single-answer",
          loopIteration: 0,
          attempt: options.answerAttempt,
          providerRequestIndex: 0,
        },
      },
    });
  });

const sourceFor = (fixture: Fixture): FinalSourceRecord => ({
  sourceKey: sourceKeyFor(fixture),
  locator: { kind: "chat_message", messageId: fixture.userMessageId },
  label: "Question",
  publicProvenance: {},
  uses: [
    {
      consumerTaskId: "single-answer",
      contextOrder: 0,
      renderedTokenCount: 3,
      ranges: [{ charStart: 0, charEnd: fixture.chatContent.length }],
    },
  ],
});

const candidateIdForSource = (source: FinalSourceRecord): string => {
  const locator = source.locator;
  switch (locator.kind) {
    case "document":
      return namespacedDocumentEvidenceIdentity(
        locator.publisherIssueId === undefined
          ? { kind: "public", sourceId: locator.sourceId }
          : {
              kind: "publisher",
              sourceId: locator.sourceId,
              issueId: locator.publisherIssueId,
              documentId: locator.publisherDocumentId!,
            },
        locator.documentId,
      );
    case "chat_message":
      return chatMessageEvidenceIdentity(locator.messageId);
    case "memory":
      return memoryEvidenceIdentity(locator.memoryId);
    case "web":
      return webEvidenceIdentity(locator.url, locator.quote);
  }
  throw new Error("unknown source kind");
};

interface PublisherSourceFixture {
  readonly subscriptionId: string;
  readonly issueId: string;
  readonly documentId: string;
  readonly snapshotId: string;
  readonly extractionId: string;
  readonly contentHash: string;
}

const createPublisherSourceFixture = (
  fixture: Fixture,
): Effect.Effect<PublisherSourceFixture, unknown, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const publisherCompanyId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const contentHash = createHash("sha256").update("Fence source text", "utf8").digest("hex");
    yield* sql`
      insert into publisher_companies (id, name)
      values (${publisherCompanyId}, ${`Fence publisher ${issueId}`})
    `;
    yield* sql`
      insert into publisher_subscriptions (id, publisher_company_id, name, created_by_user_id)
      values (${subscriptionId}, ${publisherCompanyId}, 'Fence publication', ${fixture.userId})
    `;
    yield* sql`
      insert into publisher_issues (
        id, subscription_id, title, status, publication_at, published_at,
        created_by_user_id
      ) values (
        ${issueId}, ${subscriptionId}, 'Fence issue', 'draft', null, null, ${fixture.userId}
      )
    `;
    yield* sql`
      insert into brief_documents (
        id, issue_id, title, original_file_name, object_key, media_type,
        byte_size, sha256_hex, upload_completed_at, created_by_user_id
      ) values (
        ${documentId}, ${issueId}, 'Fence document', 'fence.pdf',
        ${`fence/${documentId}.pdf`}, 'application/pdf', 1, ${contentHash}, now(), ${fixture.userId}
      )
  `;
    const jobs = yield* sql<{ readonly id: string }>`
      insert into jobs (kind, payload)
      values ('extract_pdf_text', '{}'::jsonb)
      returning id::text
    `;
    const extractions = yield* sql<{ readonly id: string }>`
      insert into brief_document_extractions (
        brief_document_id, input_sha256_hex, pages, extracted_char_count, created_by_job_id
      ) values (
        ${documentId}, ${contentHash},
        '[{"pageNumber":1,"text":"Fence source text"}]'::jsonb,
        17, ${jobs[0]!.id}
      )
      returning id::text
    `;
    yield* sql`
      insert into brief_document_versions (
        id, brief_document_id, publisher_extraction_id, content_hash, language, canonical_text,
        text_char_count, page_ranges
      ) values (
        ${snapshotId}, ${documentId}, ${extractions[0]!.id}, ${contentHash}, 'english', 'Fence source text',
        17, '[{"pageNumber":1,"charStart":0,"charEnd":17}]'::jsonb
      )
    `;
    yield* sql`
      update brief_documents set current_version_id = ${snapshotId} where id = ${documentId}
    `;
    yield* sql`
      update publisher_issues
      set status = 'published', publication_at = now(), published_at = now(), indexing_status = 'ready'
      where id = ${issueId}
    `;
    return {
      subscriptionId,
      issueId,
      documentId,
      snapshotId,
      extractionId: extractions[0]!.id,
      contentHash,
    };
  });

interface PublicExposureFixture {
  readonly sourceId: string;
  readonly documentId: string;
  readonly contentHash: string;
}

const createPublicExposureFixture = (
  fixture: Fixture,
): Effect.Effect<PublicExposureFixture, unknown, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const sourceId = `exposure-source-${crypto.randomUUID()}`;
    const documentId = `exposure-document-${crypto.randomUUID()}`;
    const canonicalUrl = `https://public.example/${documentId}`;
    const text = "Public exposure evidence. ".repeat(6);
    const contentHash = createHash("sha256").update(text, "utf8").digest("hex");
    const rawArtifactId = crypto.randomUUID();
    yield* sql`
      insert into public_sources (
        source_id, display_name, publisher_name, description, ingestion_method,
        discovery_url, average_chars_per_item
      ) values (
        ${sourceId}, 'Exposure source', 'Exposure publisher', 'Exposure fixture',
        'manual', ${canonicalUrl}, ${text.length}
      )
    `;
    yield* sql`
      insert into public_source_raw_artifacts (
        id, source_id, canonical_url, fetched_at, media_type, body, body_hash
      ) values (
        ${rawArtifactId}, ${sourceId}, ${canonicalUrl}, now(), 'text/html', ${text}, ${contentHash}
      )
    `;
    yield* sql`
      insert into public_source_documents (
        document_id, source_id, canonical_url, title, published_at,
        discovered_at, fetched_at, language, document_type, text,
        text_char_count, content_hash, raw_artifact_id
      ) values (
        ${documentId}, ${sourceId}, ${canonicalUrl}, 'Exposure document', now(),
        now(), now(), 'en', 'article', ${text}, ${text.length}, ${contentHash}, ${rawArtifactId}
      )
    `;
    yield* sql`
      insert into client_company_public_source_settings (
        client_company_id, source_id, enabled, updated_by_user_id
      ) values (${fixture.companyId}, ${sourceId}, true, ${fixture.userId})
    `;
    return { sourceId, documentId, contentHash };
  });

describe.skipIf(!isBun || !databaseUrl)("canonical AI product state", () => {
  beforeAll(async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(`create database ${quoted(databaseName)}`);
      }),
      adminUrl(),
    );
    await runDb(runMigrations);
  }, 120_000);

  afterAll(async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          select pg_terminate_backend(pid)
          from pg_stat_activity
          where datname = ${databaseName} and pid <> pg_backend_pid()
        `;
        yield* sql.unsafe(`drop database if exists ${quoted(databaseName)}`);
      }),
      adminUrl(),
    );
  }, 60_000);

  it("allocates immutable gapless sequences under concurrent replay", async () => {
    const fixture = await runDb(createFixture("events"));
    const replayed = await Promise.all(
      Array.from({ length: 24 }, () =>
        runDb(
          appendAiRunEvent({
            runId: fixture.runId,
            emissionKey: "text_delta:answer:0:0",
            event: { type: "text_delta", delta: "stable" },
            emittedByTask: "answer",
          }),
        ),
      ),
    );
    expect(new Set(replayed.map((event) => event.seq))).toEqual(new Set([1]));
    expect(replayed.filter((event) => event.inserted)).toHaveLength(1);

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        runDb(
          appendAiRunEvent({
            runId: fixture.runId,
            emissionKey: `text_delta:answer:0:${index + 1}`,
            event: { type: "text_delta", delta: String(index) },
            emittedByTask: "answer",
          }),
        ),
      ),
    );
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const events = yield* sql<{ readonly seq: number }>`
          select seq from ai_run_events where run_id = ${fixture.runId} order by seq
        `;
        const [run] = yield* sql<{ readonly nextEventSeq: number }>`
          select next_event_seq as "nextEventSeq" from ai_runs where id = ${fixture.runId}
        `;
        return { events, run };
      }),
    );
    expect(state.events.map((row) => row.seq)).toEqual(
      Array.from({ length: 21 }, (_, index) => index + 1),
    );
    expect(state.run?.nextEventSeq).toBe(22);
  });

  it("deduplicates detailed usage and exposures while retaining attempts", async () => {
    const fixture = await runDb(createFixture("usage"));
    const publicDocument = await runDb(createPublicExposureFixture(fixture));
    const usage = {
      runId: fixture.runId,
      taskId: "plan-turn",
      loopIteration: 0,
      attempt: 0,
      providerRequestIndex: 0,
      providerRequestSha256Hex: "a".repeat(64),
      agentRole: "plan_turn",
      modelId: "glm-fast",
      providerServiceId: "zai_coding_plan_official",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cachedTokens: 2,
        reasoningTokens: 1,
        totalTokens: 16,
        stopReason: "stop",
      },
    } as const;
    expect(await runDb(insertAiRunUsage(usage))).toBe(true);
    expect(await runDb(insertAiRunUsage(usage))).toBe(false);
    await runDb(insertAiRunUsage({ ...usage, attempt: 1 }));
    await runDb(
      insertAiExternalToolUsage({
        runId: fixture.runId,
        taskId: "web",
        loopIteration: 0,
        attempt: 0,
        toolRequestIndex: 0,
        providerServiceId: "zai_coding_plan_official",
        operation: "web_search",
        status: "empty",
        resultCount: 0,
        responseBytes: 12,
        billedUnits: null,
        durationMs: 30,
      }),
    );
    const exposure = {
      runId: fixture.runId,
      taskId: "retrieval",
      loopIteration: 0,
      attempt: 0,
      providerRequestIndex: 0,
      providerRequestSha256Hex: "a".repeat(64),
      sourceKind: "document" as const,
      logicalSourceIdentity: "document:1",
      contentItemIdentity: "version:1:range:a",
      exposureStage: "selector_preview",
      visibleTokenCount: 8,
      providerSerializationProofBinding: {
        messageIndex: 0,
        sourceOrdinal: 0,
        serializedField: "messages[0].content.replay",
        orderedSourceDescriptor: "fixture:document:1",
      },
      documentReconstruction: {
        sourceId: `public:${publicDocument.sourceId}`,
        documentId: publicDocument.documentId,
        snapshotId: publicDocument.documentId,
        contentHash: publicDocument.contentHash,
        ranges: [{ charStart: 0, charEnd: 8 }],
      },
    };
    expect(await runDb(insertAiSourceExposure(exposure))).toBe(true);
    expect(await runDb(insertAiSourceExposure(exposure))).toBe(false);
    const secondExposure = {
      ...exposure,
      contentItemIdentity: "version:1:range:b",
      providerSerializationProofBinding: {
        ...exposure.providerSerializationProofBinding,
        sourceOrdinal: 1,
        serializedField: "messages[0].content.replay[1]",
      },
    };
    expect(await runDb(insertAiSourceExposure(secondExposure))).toBe(true);

    const aggregate = await runDb(deriveAggregateAiRunUsage(fixture.runId));
    expect(aggregate.model).toEqual({
      inputTokens: 20,
      outputTokens: 8,
      cachedTokens: 4,
      reasoningTokens: 2,
      totalTokens: 32,
      requestCount: 2,
    });
    expect(aggregate.web).toEqual({
      searchCount: 1,
      fetchCount: 0,
      responseBytes: 12,
      billedUnits: null,
    });
  });

  it("rejects divergent replays for every bound observability field", async () => {
    const fixture = await runDb(createFixture("observability-replay"));
    const publisher = await runDb(createPublisherSourceFixture(fixture));
    const alternatePublisher = await runDb(createPublisherSourceFixture(fixture));
    const expectConflict = async (operation: Promise<unknown>): Promise<void> => {
      await expect(operation).rejects.toThrow(/replay conflicts with an existing immutable row/u);
    };

    const observation = {
      runId: fixture.runId,
      chatId: fixture.chatId,
      emittingTask: "replay-task",
      loopIteration: 0,
      attempt: 0,
      observationKey: "replay:observation",
      kind: "context_measurement",
      payload: { mandatoryTokens: 3, passed: true },
    } as const;
    await expect(runDb(insertAiObservation(observation))).resolves.toBe(true);
    await expect(runDb(insertAiObservation(observation))).resolves.toBe(false);
    for (const divergent of [
      { ...observation, chatId: crypto.randomUUID() },
      { ...observation, emittingTask: "other-task" },
      { ...observation, loopIteration: 1 },
      { ...observation, attempt: 1 },
      { ...observation, kind: "context_serialized" },
      { ...observation, payload: { mandatoryTokens: 4, passed: true } },
    ]) {
      await expectConflict(runDb(insertAiObservation(divergent)));
    }

    const usage = {
      runId: fixture.runId,
      taskId: "replay-model",
      loopIteration: 0,
      attempt: 0,
      providerRequestIndex: 0,
      agentRole: "direct_answer",
      modelId: "glm-5-turbo",
      providerServiceId: "deterministic_test" as const,
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cachedTokens: 2,
        reasoningTokens: 1,
        totalTokens: 16,
        stopReason: "toolUse",
      },
    } as const;
    await expect(runDb(insertAiRunUsage(usage))).resolves.toBe(true);
    await expect(runDb(insertAiRunUsage(usage))).resolves.toBe(false);
    await expectConflict(runDb(insertAiRunUsage({ ...usage, agentRole: "topic_answer" })));
    await expectConflict(runDb(insertAiRunUsage({ ...usage, modelId: "glm-5.2" })));
    await expectConflict(
      runDb(insertAiRunUsage({ ...usage, providerServiceId: "openai_compatible_custom" })),
    );
    await expectConflict(
      runDb(
        insertAiRunUsage({
          ...usage,
          usage: { ...usage.usage, inputTokens: 11, totalTokens: 17 },
        }),
      ),
    );
    await expectConflict(
      runDb(
        insertAiRunUsage({
          ...usage,
          usage: { ...usage.usage, outputTokens: 5, totalTokens: 17 },
        }),
      ),
    );
    await expectConflict(
      runDb(
        insertAiRunUsage({
          ...usage,
          usage: { ...usage.usage, cachedTokens: 3, totalTokens: 17 },
        }),
      ),
    );
    await expectConflict(
      runDb(insertAiRunUsage({ ...usage, usage: { ...usage.usage, reasoningTokens: 2 } })),
    );
    await expectConflict(
      runDb(
        insertAiRunUsage({
          ...usage,
          usage: { ...usage.usage, inputTokens: 9, totalTokens: 15 },
        }),
      ),
    );
    await expectConflict(
      runDb(insertAiRunUsage({ ...usage, usage: { ...usage.usage, stopReason: "stop" } })),
    );

    const tamperedUsage = { ...usage, taskId: "replay-model-event" };
    await expect(runDb(insertAiRunUsage(tamperedUsage))).resolves.toBe(true);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_run_events
          set event = jsonb_set(event, '{role}', '"tampered"'::jsonb)
          where run_id = ${fixture.runId}
            and emission_key = ${`usage:request:model:${tamperedUsage.taskId}:0:0:0`}
        `;
      }),
    );
    await expectConflict(runDb(insertAiRunUsage(tamperedUsage)));

    const external = {
      runId: fixture.runId,
      taskId: "replay-web",
      loopIteration: 0,
      attempt: 0,
      toolRequestIndex: 0,
      providerServiceId: "deterministic_test",
      operation: "web_search" as const,
      status: "ok" as const,
      resultCount: 2,
      responseBytes: 32,
      billedUnits: 1,
      durationMs: 20,
    };
    await expect(runDb(insertAiExternalToolUsage(external))).resolves.toBe(true);
    await expect(runDb(insertAiExternalToolUsage(external))).resolves.toBe(false);
    for (const divergent of [
      { ...external, providerServiceId: "tinyfish_search_official" },
      { ...external, operation: "web_fetch" as const },
      { ...external, status: "failed" as const },
      { ...external, resultCount: 3 },
      { ...external, responseBytes: 33 },
      { ...external, billedUnits: null },
      { ...external, durationMs: 21 },
    ]) {
      await expectConflict(runDb(insertAiExternalToolUsage(divergent)));
    }

    const exposure = {
      runId: fixture.runId,
      taskId: "replay-exposure",
      loopIteration: 0,
      attempt: 0,
      providerRequestIndex: 0,
      providerRequestSha256Hex: "b".repeat(64),
      sourceKind: "document" as const,
      logicalSourceIdentity: "document:replay",
      publisherIssueId: publisher.issueId,
      publisherDocumentId: publisher.documentId,
      contentItemIdentity: "version:replay:range:0-8",
      exposureStage: "context_candidate_inspection",
      visibleTokenCount: 8,
      providerSerializationProofBinding: {
        messageIndex: 0,
        sourceOrdinal: 0,
        serializedField: "messages[0].content.replay",
        orderedSourceDescriptor: "fixture:document:replay",
      },
      documentReconstruction: {
        sourceId: `publisher:${publisher.subscriptionId}`,
        documentId: publisher.documentId,
        snapshotId: publisher.snapshotId,
        contentHash: publisher.contentHash,
        publisherExtractionId: publisher.extractionId,
        ranges: [{ charStart: 0, charEnd: 8 }],
      },
    };
    await expect(runDb(insertAiSourceExposure(exposure))).resolves.toBe(true);
    await expect(runDb(insertAiSourceExposure(exposure))).resolves.toBe(false);
    await expect(
      runDb(
        insertAiSourceExposure({
          ...exposure,
          contentItemIdentity: "version:replay:missing-reconstruction",
          documentReconstruction: undefined,
          providerSerializationProofBinding: {
            ...exposure.providerSerializationProofBinding,
            publicDocumentId: publisher.documentId,
          },
        }),
      ),
    ).rejects.toThrow("document exposure reconstruction is required");
    for (const divergent of [
      { ...exposure, sourceKind: "memory" as const, documentReconstruction: undefined },
      { ...exposure, contentItemIdentity: "version:replay:range:other" },
      { ...exposure, exposureStage: "answer_serialized" },
      { ...exposure, logicalSourceIdentity: "document:other" },
      { ...exposure, publisherIssueId: "issue:other" },
      { ...exposure, publisherDocumentId: "document:other" },
      { ...exposure, visibleTokenCount: 9 },
      { ...exposure, providerRequestSha256Hex: "d".repeat(64) },
      {
        ...exposure,
        documentReconstruction: {
          ...exposure.documentReconstruction,
          sourceId: "publisher:other",
        },
      },
      {
        ...exposure,
        documentReconstruction: {
          ...exposure.documentReconstruction,
          sourceId: `publisher:${alternatePublisher.subscriptionId}`,
          documentId: alternatePublisher.documentId,
          snapshotId: alternatePublisher.snapshotId,
          contentHash: alternatePublisher.contentHash,
          publisherExtractionId: alternatePublisher.extractionId,
        },
      },
      {
        ...exposure,
        documentReconstruction: {
          ...exposure.documentReconstruction,
          sourceId: `publisher:${alternatePublisher.subscriptionId}`,
          documentId: alternatePublisher.documentId,
          snapshotId: alternatePublisher.snapshotId,
          contentHash: alternatePublisher.contentHash,
          publisherExtractionId: alternatePublisher.extractionId,
        },
      },
      {
        ...exposure,
        documentReconstruction: {
          ...exposure.documentReconstruction,
          sourceId: `publisher:${alternatePublisher.subscriptionId}`,
          documentId: alternatePublisher.documentId,
          snapshotId: alternatePublisher.snapshotId,
          contentHash: alternatePublisher.contentHash,
          publisherExtractionId: alternatePublisher.extractionId,
        },
      },
      {
        ...exposure,
        documentReconstruction: {
          ...exposure.documentReconstruction,
          ranges: [{ charStart: 1, charEnd: 8 }],
        },
      },
    ]) {
      await expectConflict(runDb(insertAiSourceExposure(divergent)));
    }
  });

  it("locks the run before concurrent usage child inserts append events", async () => {
    const fixture = await runDb(createFixture("usage-event-lock-order"));
    const operations = Array.from({ length: 48 }, (_, index) => {
      const taskId = index % 2 === 0 ? `model-${index}` : `web-${index}`;
      if (index % 2 === 0) {
        return runDb(
          insertAiRunUsage({
            runId: fixture.runId,
            taskId,
            loopIteration: 0,
            attempt: 1,
            providerRequestIndex: index,
            agentRole: "single_answer",
            modelId: "glm-5-turbo",
            providerServiceId: "deterministic_test",
            usage: {
              inputTokens: 10,
              outputTokens: 4,
              cachedTokens: 0,
              reasoningTokens: 0,
              totalTokens: 14,
              stopReason: "stop",
            },
          }),
        );
      }
      return runDb(
        insertAiExternalToolUsage({
          runId: fixture.runId,
          taskId,
          loopIteration: 0,
          attempt: 1,
          toolRequestIndex: index,
          providerServiceId: "deterministic_test",
          operation: index % 4 === 1 ? "web_search" : "web_fetch",
          status: "ok",
          resultCount: 1,
          responseBytes: 32,
          billedUnits: 1,
          durationMs: 1,
        }),
      );
    });

    await expect(Promise.all(operations)).resolves.toHaveLength(48);
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [counts] = yield* sql<{
          readonly usage: number;
          readonly external: number;
          readonly events: number;
          readonly nextEventSeq: number;
        }>`
          select
            (select count(*)::int from ai_run_usage where run_id = ${fixture.runId}) as usage,
            (select count(*)::int from ai_external_tool_usage where run_id = ${fixture.runId}) as external,
            (select count(*)::int from ai_run_events where run_id = ${fixture.runId}) as events,
            (select next_event_seq::int from ai_runs where id = ${fixture.runId}) as "nextEventSeq"
        `;
        return counts;
      }),
    );
    expect(state).toEqual({ usage: 24, external: 24, events: 48, nextEventSeq: 49 });
  }, 60_000);

  it("rejects malformed provider accounting before inserting a usage row", async () => {
    const fixture = await runDb(createFixture("usage-invalid"));
    const usage = {
      runId: fixture.runId,
      taskId: "plan-turn",
      loopIteration: 0,
      attempt: 0,
      providerRequestIndex: 0,
      providerRequestSha256Hex: "a".repeat(64),
      agentRole: "plan_turn",
      modelId: "glm-fast",
      providerServiceId: "zai_coding_plan_official" as const,
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cachedTokens: 2,
        reasoningTokens: 5,
        totalTokens: 16,
        stopReason: "stop",
      },
    } as const;

    await expect(runDb(insertAiRunUsage(usage))).rejects.toThrow(
      "provider usage accounting is invalid",
    );
    const count = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly count: number }>`
          select count(*)::int as count from ai_run_usage where run_id = ${fixture.runId}
        `;
        return rows[0]?.count ?? 0;
      }),
    );
    expect(count).toBe(0);
  });

  it("requires one passed exact measurement with the same model for every provider usage", async () => {
    const usageFor = (fixture: Fixture) =>
      ({
        runId: fixture.runId,
        taskId: "single-answer",
        loopIteration: 0,
        attempt: 0,
        providerRequestIndex: 0,
        agentRole: "direct_answer",
        modelId: "glm-5-turbo",
        providerServiceId: "zai_coding_plan_official",
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cachedTokens: 0,
          reasoningTokens: 0,
          totalTokens: 14,
          stopReason: "stop",
        },
      }) as const;
    const measurementFor = (
      fixture: Fixture,
      modelId: "glm-5.2" | "glm-5-turbo",
      observationKey = "single-answer:measurement",
    ) =>
      insertAiObservation({
        runId: fixture.runId,
        chatId: fixture.chatId,
        emittingTask: "single-answer",
        loopIteration: 0,
        attempt: 0,
        observationKey,
        kind: "provider_request_measurement",
        payload: {
          providerRequestIndex: 0,
          agentRole: "direct_answer",
          modelId,
          requestSha256Hex: "b".repeat(64),
          sourceExposureProofSha256Hexes: [],
          sourceExposureProofBindings: [],
          inputTokens: 10,
          requestedOutputTokens: 2048,
          usableInputTokens: 6144,
          contextWindow: 8192,
          passed: true,
        },
      });
    const inputFor = (fixture: Fixture, memory: MemoryExtractionArtifact) => ({
      runId: fixture.runId,
      expectedSmithersRunId: `ai-chat:${fixture.runId}`,
      coordinates: finalizeCoordinates,
      answer: {
        status: "ok" as const,
        mode: "single" as const,
        content: "Measured answer",
        sourceMap: [],
      },
      memory,
    });

    const missing = await runDb(createFixture("measurement-missing"));
    const missingMemory = await runDb(
      persistMemoryArtifact(missing, { proposals: [], discardedCount: 0 }),
    );
    await runDb(seedSingleObservability(missing, { includeAnswerMeasurement: false }));
    await runDb(insertAiRunUsage(usageFor(missing)));
    const missingExit = await runDb(Effect.exit(finalizeAiRun(inputFor(missing, missingMemory))));
    expect(missingExit._tag).toBe("Failure");
    await runDb(measurementFor(missing, "glm-5-turbo"));
    await expect(runDb(finalizeAiRun(inputFor(missing, missingMemory)))).resolves.toMatchObject({
      status: "succeeded",
    });

    const mismatch = await runDb(createFixture("measurement-model-mismatch"));
    const mismatchMemory = await runDb(
      persistMemoryArtifact(mismatch, { proposals: [], discardedCount: 0 }),
    );
    await runDb(seedSingleObservability(mismatch, { includeAnswerMeasurement: false }));
    await runDb(insertAiRunUsage(usageFor(mismatch)));
    await runDb(measurementFor(mismatch, "glm-5.2"));
    const mismatchExit = await runDb(
      Effect.exit(finalizeAiRun(inputFor(mismatch, mismatchMemory))),
    );
    expect(mismatchExit._tag).toBe("Failure");

    const duplicate = await runDb(createFixture("measurement-duplicate"));
    const duplicateMemory = await runDb(
      persistMemoryArtifact(duplicate, { proposals: [], discardedCount: 0 }),
    );
    await runDb(seedSingleObservability(duplicate, { includeAnswerMeasurement: false }));
    await runDb(measurementFor(duplicate, "glm-5-turbo", "measurement:first"));
    await runDb(measurementFor(duplicate, "glm-5-turbo", "measurement:second"));
    const duplicateExit = await runDb(
      Effect.exit(finalizeAiRun(inputFor(duplicate, duplicateMemory))),
    );
    expect(duplicateExit._tag).toBe("Failure");
  });

  it("rejects a single route with an extra canonical retrieval owner", async () => {
    const fixture = await runDb(createFixture("single-extra-retrieval-owner"));
    await runDb(seedSingleObservability(fixture));
    await runDb(
      insertAiObservation({
        runId: fixture.runId,
        chatId: fixture.chatId,
        emittingTask: "topic-t1-retrieve-internal",
        loopIteration: 0,
        attempt: 0,
        observationKey: "fixture:single-extra-retrieval-owner",
        kind: "retrieval_manifest",
        payload: { selectorRole: "internal", references: [] },
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );

    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "Answer", sourceMap: [] },
          memory,
        }),
      ),
    ).rejects.toThrow(/outside the selected route/u);
  });

  it("allows older retrieval attempts from the selected route owners", async () => {
    const fixture = await runDb(createFixture("selected-route-retrieval-retry"));
    await runDb(seedSingleObservability(fixture));
    await runDb(
      Effect.gen(function* () {
        yield* insertAiObservation({
          runId: fixture.runId,
          chatId: fixture.chatId,
          emittingTask: "single-retrieve-internal",
          loopIteration: 0,
          attempt: 1,
          observationKey: "fixture:single-retrieve-internal:retry-measurement",
          kind: "provider_request_measurement",
          payload: {
            providerRequestIndex: 0,
            agentRole: "internal_retrieval",
            modelId: "glm-5-turbo",
            requestSha256Hex: "8".repeat(64),
            sourceExposureProofSha256Hexes: [],
            sourceExposureProofBindings: [],
            inputTokens: 10,
            requestedOutputTokens: 2048,
            usableInputTokens: 6144,
            contextWindow: 8192,
            passed: true,
          },
        });
        yield* insertAiRunUsage({
          runId: fixture.runId,
          taskId: "single-retrieve-internal",
          loopIteration: 0,
          attempt: 1,
          providerRequestIndex: 0,
          agentRole: "internal_retrieval",
          modelId: "glm-5-turbo",
          providerServiceId: "zai_coding_plan_official",
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cachedTokens: 0,
            reasoningTokens: 0,
            totalTokens: 14,
            stopReason: "stop",
          },
        });
        yield* insertProviderMeasurementAndUsage(fixture, {
          taskId: "single-retrieve-internal",
          agentRole: "internal_retrieval",
          loopIteration: 0,
          attempt: 1,
          providerRequestIndex: 1,
          requestSha256Hex: "9".repeat(64),
        });
        yield* insertAiObservation({
          runId: fixture.runId,
          chatId: fixture.chatId,
          emittingTask: "single-retrieve-internal",
          loopIteration: 0,
          attempt: 1,
          observationKey: "fixture:single-retrieve-internal:retry-manifest",
          kind: "retrieval_manifest",
          payload: { selectorRole: "internal", references: [] },
        });
        yield* insertAiObservation({
          runId: fixture.runId,
          chatId: fixture.chatId,
          emittingTask: "single-retrieve-internal",
          loopIteration: 0,
          attempt: 1,
          observationKey: "single-retrieve-internal:0:1:structured_retrieval_trace:result",
          kind: "structured_retrieval_trace",
          payload: {
            initialPlan: {
              action: "search",
              queries: [
                {
                  purpose: "fixture",
                  all: [{ text: "fixture", mode: "term" }],
                  anyOf: [],
                  not: [],
                  filters: {},
                  order: "relevance",
                },
              ],
            },
            review: { action: "accept", reason: "sufficient_coverage" },
            replacementPlan: null,
            outcome: "accepted",
          },
        });
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );

    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "Answer", sourceMap: [] },
          memory,
        }),
      ),
    ).resolves.toMatchObject({ status: "succeeded" });
  });
  it("ignores an unconsumed preview from a failed retrieval retry", async () => {
    const fixture = await runDb(createFixture("selected-route-retrieval-failed-preview"));
    await runDb(seedSingleObservability(fixture));
    await runDb(
      Effect.gen(function* () {
        yield* insertProviderMeasurementAndUsage(fixture, {
          taskId: "single-retrieve-internal",
          agentRole: "internal_retrieval",
          loopIteration: 0,
          attempt: 1,
          providerRequestIndex: 0,
          requestSha256Hex: "8".repeat(64),
        });
        yield* insertProviderMeasurementAndUsage(fixture, {
          taskId: "single-retrieve-internal",
          agentRole: "internal_retrieval",
          loopIteration: 0,
          attempt: 1,
          providerRequestIndex: 1,
          requestSha256Hex: "9".repeat(64),
        });
        yield* insertInternalRetrievalPlanAndReview(fixture, {
          taskId: "single-retrieve-internal",
          loopIteration: 0,
          attempt: 2,
          planRequestSha256Hex: "a".repeat(64),
          reviewRequestSha256Hex: "b".repeat(64),
        });
        yield* insertAiObservation({
          runId: fixture.runId,
          chatId: fixture.chatId,
          emittingTask: "single-retrieve-internal",
          loopIteration: 0,
          attempt: 2,
          observationKey: "fixture:single-retrieve-internal:failed-preview-terminal-manifest",
          kind: "retrieval_manifest",
          payload: { selectorRole: "internal", references: [] },
        });
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );

    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "Answer", sourceMap: [] },
          memory,
        }),
      ),
    ).resolves.toMatchObject({ status: "succeeded" });
  });


  it("rejects missing, extra, and mismatched structured review metadata", async () => {
    const tamperKinds = [
      "missing_results",
      "extra_field",
      "empty_coverage",
      "extra_result",
    ] as const;
    for (const tamperKind of tamperKinds) {
      const fixture = await runDb(createFixture(`structured-review-${tamperKind}`));
      await runDb(seedSingleObservability(fixture));
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const rows = yield* sql<{ readonly payload: Record<string, unknown> }>`
            select payload
            from ai_observations
            where run_id = ${fixture.runId}
              and kind = 'structured_retrieval_review_preview'
          `;
          const original = rows[0]?.payload;
          if (original === undefined)
            throw new Error("structured review fixture is missing preview");
          const { results: _results, ...withoutResults } = original;
          const payload =
            tamperKind === "missing_results"
              ? withoutResults
              : tamperKind === "extra_field"
                ? { ...original, question: "source text must not be durable" }
                : tamperKind === "empty_coverage"
                  ? { ...original, coverage: [] }
                  : {
                      ...original,
                      results: [
                        {
                          resultId: "r1",
                          kind: "document",
                          label: null,
                          date: null,
                          tokenCount: 0,
                          normalizedFusedScore: 0,
                          matchedQueryOrdinals: [],
                          branchCoverage: original.coverage,
                          truncationFlags: original.truncation,
                        },
                      ],
                    };
          yield* sql`
            update ai_observations
            set payload = ${sql.json(payload)}
            where run_id = ${fixture.runId}
              and kind = 'structured_retrieval_review_preview'
          `;
        }),
      );
      const memory = await runDb(
        persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
      );
      await expect(
        runDb(
          finalizeAiRun({
            runId: fixture.runId,
            expectedSmithersRunId: `ai-chat:${fixture.runId}`,
            coordinates: finalizeCoordinates,
            answer: { status: "ok", mode: "single", content: "Answer", sourceMap: [] },
            memory,
          }),
        ),
      ).rejects.toThrow(/structured retrieval review preview/u);
    }
  });

  it("rejects an older retrieval attempt without its own provider proof", async () => {
    const fixture = await runDb(createFixture("selected-route-retrieval-unproved-old-attempt"));
    await runDb(seedSingleObservability(fixture));
    await runDb(
      Effect.gen(function* () {
        yield* insertAiObservation({
          runId: fixture.runId,
          chatId: fixture.chatId,
          emittingTask: "single-retrieve-internal",
          loopIteration: 0,
          attempt: 1,
          observationKey: "fixture:single-retrieve-internal:unproved-old-manifest",
          kind: "retrieval_manifest",
          payload: { selectorRole: "internal", references: [] },
        });
        yield* insertInternalRetrievalPlanAndReview(fixture, {
          taskId: "single-retrieve-internal",
          loopIteration: 0,
          attempt: 2,
          planRequestSha256Hex: "9".repeat(64),
          reviewRequestSha256Hex: "a".repeat(64),
        });
        yield* insertAiObservation({
          runId: fixture.runId,
          chatId: fixture.chatId,
          emittingTask: "single-retrieve-internal",
          loopIteration: 0,
          attempt: 2,
          observationKey: "fixture:single-retrieve-internal:proved-terminal-manifest",
          kind: "retrieval_manifest",
          payload: { selectorRole: "internal", references: [] },
        });
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );

    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "Answer", sourceMap: [] },
          memory,
        }),
      ),
    ).rejects.toThrow(/retrieval manifest attempt lacks its latest provider measurement/u);
  });

  it("rejects an older retrieval attempt with the wrong selector role", async () => {
    const fixture = await runDb(createFixture("selected-route-retrieval-wrong-old-role"));
    await runDb(seedSingleObservability(fixture));
    await runDb(
      insertAiObservation({
        runId: fixture.runId,
        chatId: fixture.chatId,
        emittingTask: "single-retrieve-internal",
        loopIteration: 0,
        attempt: 1,
        observationKey: "fixture:selected-route-retrieval-wrong-old-role",
        kind: "retrieval_manifest",
        payload: { selectorRole: "web", references: [] },
      }),
    );
    await runDb(
      insertAiObservation({
        runId: fixture.runId,
        chatId: fixture.chatId,
        emittingTask: "single-retrieve-internal",
        loopIteration: 0,
        attempt: 2,
        observationKey: "fixture:selected-route-retrieval-correct-latest-role",
        kind: "retrieval_manifest",
        payload: { selectorRole: "internal", references: [] },
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "Answer", sourceMap: [] },
          memory,
        }),
      ),
    ).rejects.toThrow(/role differs/u);
  });

  it("rejects a fanout route with an extra canonical retrieval owner", async () => {
    const fixture = await runDb(createFixture("fanout-extra-retrieval-owner", "fanout"));
    await runDb(
      Effect.gen(function* () {
        for (const [taskId, selectorRole] of [
          ["topic-t1-retrieve-internal", "internal"],
          ["topic-t1-select-memories", "memory"],
          ["topic-t1-retrieve-web", "web"],
          ["topic-t2-retrieve-internal", "internal"],
          ["topic-t2-select-memories", "memory"],
          ["topic-t2-retrieve-web", "web"],
          ["single-retrieve-internal", "internal"],
        ] as const) {
          yield* insertAiObservation({
            runId: fixture.runId,
            chatId: fixture.chatId,
            emittingTask: taskId,
            loopIteration: 0,
            attempt: 0,
            observationKey: `fixture:${taskId}:retrieval_manifest`,
            kind: "retrieval_manifest",
            payload: { selectorRole, references: [] },
          });
        }
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );

    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "synthesis", content: "Answer", sourceMap: [] },
          memory,
        }),
      ),
    ).rejects.toThrow(/outside the selected route/u);
  });

  it("rejects a controlled single failure with an extra canonical retrieval owner", async () => {
    const fixture = await runDb(createFixture("single-extra-retrieval-owner-failure"));
    await runDb(seedSingleObservability(fixture));
    await runDb(
      insertAiObservation({
        runId: fixture.runId,
        chatId: fixture.chatId,
        emittingTask: "topic-t1-retrieve-internal",
        loopIteration: 0,
        attempt: 0,
        observationKey: "fixture:single-extra-retrieval-owner-failure",
        kind: "retrieval_manifest",
        payload: { selectorRole: "internal", references: [] },
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "failed", code: "answer_failed", retryable: false },
          memory,
        }),
      ),
    ).rejects.toThrow(/outside the selected route/u);
  });

  it("rejects a controlled fanout failure with an extra canonical retrieval owner", async () => {
    const fixture = await runDb(createFixture("fanout-extra-retrieval-owner-failure", "fanout"));
    await runDb(seedSingleObservability(fixture));
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          delete from ai_observations
          where run_id = ${fixture.runId}
            and kind = 'retrieval_manifest'
        `;
        for (const [taskId, selectorRole] of [
          ["topic-t1-retrieve-internal", "internal"],
          ["topic-t1-select-memories", "memory"],
          ["topic-t1-retrieve-web", "web"],
          ["topic-t2-retrieve-internal", "internal"],
          ["topic-t2-select-memories", "memory"],
          ["topic-t2-retrieve-web", "web"],
          ["single-retrieve-internal", "internal"],
        ] as const) {
          yield* insertAiObservation({
            runId: fixture.runId,
            chatId: fixture.chatId,
            emittingTask: taskId,
            loopIteration: 0,
            attempt: 0,
            observationKey: `fixture:controlled-fanout:${taskId}`,
            kind: "retrieval_manifest",
            payload: { selectorRole, references: [] },
          });
        }
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "failed", code: "answer_failed", retryable: false },
          memory,
        }),
      ),
    ).rejects.toThrow(/outside the selected route/u);
  });

  it("binds source exposure attestations to the exact provider request", async () => {
    const fixture = await runDb(createFixture("exposure-request-digest"));
    const exposure = {
      runId: fixture.runId,
      taskId: "plan-turn",
      loopIteration: 0,
      attempt: 0,
      providerRequestIndex: 0,
      providerRequestSha256Hex: "b".repeat(64),
      sourceKind: "chat_message" as const,
      logicalSourceIdentity: `chat_message:${fixture.userMessageId}`,
      contentItemIdentity: fixture.userMessageId,
      chatReconstruction: chatReconstructionFor(
        fixture.userMessageId,
        "Question exposure-request-digest",
      ),
      exposureStage: "provider_input",
      visibleTokenCount: 1,
      providerSerializationProofBinding: {
        messageIndex: 0,
        sourceOrdinal: 0,
        serializedField: "messages[0].content.currentMessage",
        orderedSourceDescriptor: `chat:${fixture.userMessageId}`,
      },
    };
    const attestation = {
      providerSerializationProofSha256Hex: providerVisibleSourceExposureProofSha256Hex(
        {
          sourceKind: exposure.sourceKind,
          logicalSourceIdentity: exposure.logicalSourceIdentity,
          contentItemIdentity: exposure.contentItemIdentity,
          exposureStage: exposure.exposureStage,
          visibleTokenCount: exposure.visibleTokenCount,
        },
        exposure.providerSerializationProofBinding,
      ),
    };
    await runDb(insertAiSourceExposure(exposure));
    await runDb(
      seedSingleObservability(fixture, {
        requestSha256Hex: "a".repeat(64),
        sourceExposureProofSha256Hexes: [attestation.providerSerializationProofSha256Hex],
        planSourceExposureProofBindings: [
          {
            providerSerializationProofSha256Hex: attestation.providerSerializationProofSha256Hex,
            providerSerializationProofBinding: exposure.providerSerializationProofBinding,
          },
        ],
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );

    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: {
            status: "ok",
            mode: "single",
            content: "Digest-bound answer",
            sourceMap: [],
          },
          memory,
        }),
      ),
    ).rejects.toThrow("source exposure lacks its exact provider measurement");
  });

  it("requires the memory result's exact provider usage", async () => {
    const fixture = await runDb(createFixture("memory-measurement-usage"));
    await runDb(seedSingleObservability(fixture));
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          delete from ai_run_usage
          where run_id = ${fixture.runId} and task_id = 'memory-extract'
        `;
      }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "Answer", sourceMap: [] },
          memory,
        }),
      ),
    ).rejects.toThrow(/provider measurement|provider usage/u);
  });

  it("binds a memory extraction result to the latest request in its tool loop", async () => {
    const fixture = await runDb(createFixture("memory-multi-request"));
    await runDb(seedSingleObservability(fixture));
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    await runDb(
      Effect.gen(function* () {
        yield* insertAiObservation({
          runId: fixture.runId,
          chatId: fixture.chatId,
          emittingTask: "memory-extract",
          loopIteration: 0,
          attempt: 1,
          observationKey: "memory-multi-request:measurement:1",
          kind: "provider_request_measurement",
          payload: {
            providerRequestIndex: 1,
            agentRole: "memory_extractor",
            modelId: "glm-5-turbo",
            requestSha256Hex: "d".repeat(64),
            sourceExposureProofSha256Hexes: [],
            sourceExposureProofBindings: [],
            inputTokens: 11,
            requestedOutputTokens: 2048,
            usableInputTokens: 6144,
            contextWindow: 8192,
            passed: true,
          },
        });
        yield* insertAiRunUsage({
          runId: fixture.runId,
          taskId: "memory-extract",
          loopIteration: 0,
          attempt: 1,
          providerRequestIndex: 1,
          agentRole: "memory_extractor",
          modelId: "glm-5-turbo",
          providerServiceId: "zai_coding_plan_official",
          usage: {
            inputTokens: 11,
            outputTokens: 4,
            cachedTokens: 0,
            reasoningTokens: 0,
            totalTokens: 15,
            stopReason: "toolUse",
          },
        });
      }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "Answer", sourceMap: [] },
          memory,
        }),
      ),
    ).resolves.toMatchObject({ status: "succeeded" });
  });

  it("consumes only the latest memory extraction result", async () => {
    const fixture = await runDb(createFixture("memory-latest-result"));
    await runDb(seedSingleObservability(fixture));
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    const extractionSha256Hex = memoryExtractionSha256Hex(memory.result);
    await runDb(
      Effect.gen(function* () {
        yield* insertAiObservation({
          runId: fixture.runId,
          chatId: fixture.chatId,
          emittingTask: "memory-extract",
          loopIteration: 0,
          attempt: 2,
          observationKey: "memory-latest-result:measurement",
          kind: "provider_request_measurement",
          payload: {
            providerRequestIndex: 0,
            agentRole: "memory_extractor",
            modelId: "glm-5-turbo",
            requestSha256Hex: "d".repeat(64),
            sourceExposureProofSha256Hexes: [],
            sourceExposureProofBindings: [],
            inputTokens: 10,
            requestedOutputTokens: 2048,
            usableInputTokens: 6144,
            contextWindow: 8192,
            passed: true,
          },
        });
        yield* insertAiRunUsage({
          runId: fixture.runId,
          taskId: "memory-extract",
          loopIteration: 0,
          attempt: 2,
          providerRequestIndex: 0,
          agentRole: "memory_extractor",
          modelId: "glm-5-turbo",
          providerServiceId: "zai_coding_plan_official",
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cachedTokens: 0,
            reasoningTokens: 0,
            totalTokens: 14,
            stopReason: "stop",
          },
        });
        yield* insertAiObservation({
          runId: fixture.runId,
          chatId: fixture.chatId,
          emittingTask: "memory-extract",
          loopIteration: 0,
          attempt: 2,
          observationKey: "memory-latest-result:result",
          kind: "memory_extraction_result",
          payload: {
            proposalCount: 0,
            discardedCount: 0,
            extractionSha256Hex,
          },
        });
      }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "Answer", sourceMap: [] },
          memory,
        }),
      ),
    ).rejects.toThrow(/latest extraction result/u);
  });

  it("rejects a serialized answer source without its exact exposure", async () => {
    const fixture = await runDb(createFixture("answer-exposure-missing"));
    const source = sourceFor(fixture);
    await runDb(
      seedSingleObservability(fixture, {
        contextSources: [
          {
            sourceKey: source.sourceKey,
            candidateId: candidateIdForSource(source),
            kind: "chat_message",
            ranges: [{ charStart: 0, charEnd: fixture.chatContent.length }],
            label: source.label,
          },
        ],
      }),
    );
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          delete from ai_source_exposures
          where run_id = ${fixture.runId}
            and task_id = 'single-answer'
            and exposure_stage = 'answer_serialized'
        `;
        yield* sql`
          delete from ai_observations
          where run_id = ${fixture.runId}
            and kind = 'source_exposure_attestation'
            and emitting_task = 'single-answer'
            and payload->>'exposureStage' = 'answer_serialized'
        `;
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: {
            status: "ok",
            mode: "single",
            content: `Answer [[cite:${source.sourceKey}]]`,
            sourceMap: [source],
          },
          memory,
        }),
      ),
    ).rejects.toThrow(/answer_serialized exposure|provider measurement/u);
  });

  it("rejects a context ledger owned by an unrelated optional row", async () => {
    const fixture = await runDb(createFixture("context-owner-mismatch"));
    await runDb(seedSingleObservability(fixture));
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_observations
          set emitting_task = 'optional-context-row'
          where run_id = ${fixture.runId}
            and observation_key = 'fixture:context_measurement'
        `;
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "Answer", sourceMap: [] },
          memory,
        }),
      ),
    ).rejects.toThrow(/path-specific context measurement/u);
  });

  it("does not let a later failed answer attempt hide an older output", async () => {
    const fixture = await runDb(createFixture("later-failed-answer"));
    await runDb(seedSingleObservability(fixture));
    await runDb(
      insertAiObservation({
        runId: fixture.runId,
        chatId: fixture.chatId,
        emittingTask: "single-answer",
        loopIteration: 0,
        attempt: 1,
        observationKey: "fixture:single-answer:retry-measurement",
        kind: "provider_request_measurement",
        payload: {
          providerRequestIndex: 0,
          agentRole: "direct_answer",
          modelId: "glm-5-turbo",
          requestSha256Hex: "d".repeat(64),
          sourceExposureProofSha256Hexes: [],
          sourceExposureProofBindings: [],
          inputTokens: 10,
          requestedOutputTokens: 2048,
          usableInputTokens: 6144,
          contextWindow: 8192,
          passed: true,
        },
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "Answer", sourceMap: [] },
          memory,
        }),
      ),
    ).rejects.toThrow(/latest provider measurement/u);
  });

  it("finalizes a sidecar exposure without a caller binding", async () => {
    const fixture = await runDb(createFixture("location-bound-sidecar"));
    const visibleText = `Question ${"location-bound-sidecar"}`;
    const marker: CodeOwnedSourceExposureProof = {
      sourceKind: "chat_message" as const,
      logicalSourceIdentity: `chat_message:${fixture.userMessageId}`,
      contentItemIdentity: fixture.userMessageId,
      chatReconstruction: chatReconstructionFor(fixture.userMessageId, visibleText),
      exposureStage: "provider_input",
      visibleTokenCount: resolveRegisteredModel("glm-5-turbo").countTextTokens(visibleText),
      visibleText,
    };
    const request = {
      requestClass: "fast" as const,
      model: "glm-5-turbo" as const,
      messages: [
        { role: "system" as const, content: "system" },
        {
          role: "user" as const,
          content: JSON.stringify({
            currentMessage: visibleText,
            currentMessageId: fixture.userMessageId,
          }),
        },
      ],
      requestedOutputTokens: 128,
      reasoning: "medium" as const,
      sourceExposureProofs: [marker],
    };
    const requestBinding = providerRequestSourceExposureProofBindings(request, (text) =>
      resolveRegisteredModel("glm-5-turbo").countTextTokens(text),
    )[0]!;
    const proof = providerRequestSourceExposureProofs(request, (text) =>
      resolveRegisteredModel("glm-5-turbo").countTextTokens(text),
    )[0]!;
    await runDb(
      seedSingleObservability(fixture, {
        requestSha256Hex: providerRequestSha256Hex(request),
        planSourceExposureProofSha256Hexes: [proof],
        planSourceExposureProofBindings: [
          {
            providerSerializationProofSha256Hex: proof,
            providerSerializationProofBinding: requestBinding.binding,
          },
        ],
      }),
    );
    await runDb(
      insertAiSourceExposure({
        runId: fixture.runId,
        taskId: "plan-turn",
        loopIteration: 0,
        attempt: 0,
        providerRequestIndex: 0,
        providerRequestSha256Hex: providerRequestSha256Hex(request),
        ...marker,
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "Answer", sourceMap: [] },
          memory,
        }),
      ),
    ).resolves.toMatchObject({ status: "succeeded" });
  });
  it("stores a provider-bound web exposure without a separate attestation", async () => {
    const fixture = await runDb(createFixture("web-source-proof"));
    const model = resolveRegisteredModel("glm-5-turbo");
    const visibleText = "A web result shown to the model.";
    const url = "https://example.test/source";
    const call = {
      id: "web-proof-call",
      name: "web_search",
      arguments: { query: "source" },
    };
    const marker: CodeOwnedSourceExposureProof = {
      sourceKind: "web",
      logicalSourceIdentity: url,
      contentItemIdentity: `${url}:${sha256Base64Url(visibleText)}`,
      exposureStage: "web_search_preview",
      visibleTokenCount: model.countTextTokens(visibleText),
      visibleText,
      sourceToolCallId: call.id,
      sourceResultIndex: 0,
    };
    const request = {
      requestClass: "fast" as const,
      model: "glm-5-turbo" as const,
      messages: [
        { role: "system" as const, content: "tool test" },
        { role: "assistant" as const, content: "", toolCalls: [call] },
        {
          role: "tool" as const,
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify({ results: [{ url, snippet: visibleText }] }),
        },
      ],
      requestedOutputTokens: 128,
      reasoning: "medium" as const,
      sourceExposureProofs: [marker],
    };
    const bindings = providerRequestSourceExposureProofBindings(request, model.countTextTokens);
    expect(bindings).toHaveLength(1);
    const proof = bindings[0]!.providerSerializationProofSha256Hex;
    const requestSha256Hex = providerRequestSha256Hex(request);

    await expect(
      runDb(
        insertAiSourceExposure({
          runId: fixture.runId,
          taskId: "web-source-proof-task",
          loopIteration: 0,
          attempt: 0,
          providerRequestIndex: 0,
          providerRequestSha256Hex: requestSha256Hex,
          ...marker,
        }),
      ),
    ).resolves.toBe(true);

    const stored = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const exposures = yield* sql<{ readonly contentItemIdentity: string }>`
          select content_item_identity as "contentItemIdentity"
          from ai_source_exposures
          where run_id = ${fixture.runId}
            and task_id = 'web-source-proof-task'
        `;
        const attestations = yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from ai_observations
          where run_id = ${fixture.runId}
            and emitting_task = 'web-source-proof-task'
            and kind = 'source_exposure_attestation'
        `;
        return { exposure: exposures[0]?.contentItemIdentity, attestations: attestations[0]?.count };
      }),
    );
    expect(stored.exposure).toBe(`${marker.contentItemIdentity}#proof=${proof}`);
    expect(stored.attestations).toBe(0);
  });

  it("consumes the latest repeated-marker sidecar after measurement-first insertion", async () => {
    const fixture = await runDb(createFixture("repeated-marker-measurement-first"));
    const visibleText = `Question ${"repeated-marker-measurement-first"}`;
    const marker: CodeOwnedSourceExposureProof = {
      sourceKind: "chat_message",
      logicalSourceIdentity: `chat_message:${fixture.userMessageId}`,
      chatReconstruction: chatReconstructionFor(fixture.userMessageId, visibleText),
      contentItemIdentity: fixture.userMessageId,
      exposureStage: "provider_input",
      visibleTokenCount: resolveRegisteredModel("glm-5-turbo").countTextTokens(visibleText),
      visibleText,
    };
    const markers = [
      { ...marker, sourceOrdinal: 0, serializedField: "messages[1].content.currentMessage" },
      { ...marker, sourceOrdinal: 1, serializedField: "messages[2].content.currentMessage" },
    ] satisfies readonly CodeOwnedSourceExposureProof[];
    const request = {
      requestClass: "fast" as const,
      model: "glm-5-turbo" as const,
      messages: [
        { role: "system" as const, content: "system" },
        {
          role: "user" as const,
          content: JSON.stringify({
            currentMessage: visibleText,
            currentMessageId: fixture.userMessageId,
          }),
        },
        {
          role: "user" as const,
          content: JSON.stringify({
            currentMessage: visibleText,
            currentMessageId: fixture.userMessageId,
          }),
        },
      ],
      requestedOutputTokens: 128,
      reasoning: "medium" as const,
      sourceExposureProofs: markers,
    };
    const model = resolveRegisteredModel("glm-5-turbo");
    const bindings = providerRequestSourceExposureProofBindings(request, model.countTextTokens);
    expect(bindings).toHaveLength(2);
    expect(bindings.map((binding) => binding.binding.sourceOrdinal).sort()).toEqual([0, 1]);
    const proofs = bindings.map((binding) => binding.providerSerializationProofSha256Hex);
    const requestSha256Hex = providerRequestSha256Hex(request);

    await runDb(
      insertAiObservation({
        runId: fixture.runId,
        chatId: fixture.chatId,
        emittingTask: "repeated-marker-task",
        loopIteration: 0,
        attempt: 0,
        observationKey: "repeated-marker:measurement",
        kind: "provider_request_measurement",
        payload: {
          providerRequestIndex: 0,
          agentRole: "context_manifest",
          modelId: "glm-5-turbo",
          requestSha256Hex,
          sourceExposureProofSha256Hexes: [...proofs].sort(),
          sourceExposureProofBindings: bindings.map((proof) => ({
            providerSerializationProofSha256Hex: proof.providerSerializationProofSha256Hex,
            providerSerializationProofBinding: proof.binding,
          })),
          inputTokens: 10,
          requestedOutputTokens: 128,
          usableInputTokens: 6144,
          contextWindow: 8192,
          passed: true,
        },
      }),
    );
    await runDb(
      insertAiRunUsage({
        runId: fixture.runId,
        taskId: "repeated-marker-task",
        loopIteration: 0,
        attempt: 0,
        providerRequestIndex: 0,
        agentRole: "context_manifest",
        modelId: "glm-5-turbo",
        providerServiceId: "zai_coding_plan_official",
        usage: {
          inputTokens: 10,
          outputTokens: 1,
          cachedTokens: 0,
          reasoningTokens: 0,
          totalTokens: 11,
          stopReason: "stop",
        },
      }),
    );
    await expect(
      runDb(
        insertAiSourceExposure({
          runId: fixture.runId,
          taskId: "repeated-marker-task",
          loopIteration: 0,
          attempt: 0,
          providerRequestIndex: 0,
          providerRequestSha256Hex: requestSha256Hex,
          ...markers[0]!,
          providerSerializationProofBinding: bindings.find(
            (binding) => binding.binding.sourceOrdinal === 0,
          )!.binding,
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      runDb(
        insertAiSourceExposure({
          runId: fixture.runId,
          taskId: "repeated-marker-task",
          loopIteration: 0,
          attempt: 0,
          providerRequestIndex: 0,
          providerRequestSha256Hex: requestSha256Hex,
          ...markers[1]!,
          providerSerializationProofBinding: bindings.find(
            (binding) => binding.binding.sourceOrdinal === 1,
          )!.binding,
        }),
      ),
    ).resolves.toBe(true);
    const attestationBinding = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly binding: ProviderVisibleSourceExposureProofBinding }>`
          select payload->'providerSerializationProofBinding' as binding
          from ai_observations
          where run_id = ${fixture.runId}
            and emitting_task = 'repeated-marker-task'
            and kind = 'source_exposure_attestation'
        `;
        return rows[0]?.binding;
      }),
    );
    expect(attestationBinding?.sourceOrdinal).toBe(0);
    const storedSourceIdentities = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly contentItemIdentity: string }>`
          select content_item_identity as "contentItemIdentity"
          from ai_source_exposures
          where run_id = ${fixture.runId}
            and task_id = 'repeated-marker-task'
          order by content_item_identity
        `;
      }),
    );
    expect(storedSourceIdentities.map(({ contentItemIdentity }) => contentItemIdentity)).toEqual(
      proofs.map((proof) => `${fixture.userMessageId}#proof=${proof}`).sort(),
    );
    await expect(
      runDb(
        insertAiSourceExposure({
          runId: fixture.runId,
          taskId: "repeated-marker-task",
          loopIteration: 0,
          attempt: 0,
          providerRequestIndex: 0,
          providerRequestSha256Hex: requestSha256Hex,
          ...markers[0]!,
          providerSerializationProofBinding: bindings.find(
            (binding) => binding.binding.sourceOrdinal === 0,
          )!.binding,
        }),
      ),
    ).resolves.toBe(false);
    const replayedSourceIdentities = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly contentItemIdentity: string }>`
          select content_item_identity as "contentItemIdentity"
          from ai_source_exposures
          where run_id = ${fixture.runId}
            and task_id = 'repeated-marker-task'
          order by content_item_identity
        `;
      }),
    );
    expect(replayedSourceIdentities).toEqual(storedSourceIdentities);
  });

  it("finalizes valid retry and crash-resume histories from the terminal attempt", async () => {
    const fixture = await runDb(createFixture("retry-resume"));
    await runDb(seedSingleObservability(fixture));
    await runDb(
      Effect.gen(function* () {
        const addObservation = (input: Parameters<typeof insertAiObservation>[0]) =>
          insertAiObservation(input);
        yield* addObservation({
          runId: fixture.runId,
          chatId: fixture.chatId,
          emittingTask: "plan-turn",
          loopIteration: 0,
          attempt: 1,
          observationKey: "retry:turn-plan",
          kind: "turn_plan",
          payload: turnPlanPayload("single"),
        });
        yield* addObservation({
          runId: fixture.runId,
          chatId: fixture.chatId,
          emittingTask: "plan-turn",
          loopIteration: 0,
          attempt: 1,
          observationKey: "retry:measurement",
          kind: "provider_request_measurement",
          payload: {
            providerRequestIndex: 0,
            agentRole: "plan_turn",
            modelId: "glm-5-turbo",
            requestSha256Hex: "c".repeat(64),
            sourceExposureProofSha256Hexes: [],
            sourceExposureProofBindings: [],
            inputTokens: 10,
            requestedOutputTokens: 2048,
            usableInputTokens: 6144,
            contextWindow: 8192,
            passed: true,
          },
        });
        yield* insertAiRunUsage({
          runId: fixture.runId,
          taskId: "plan-turn",
          loopIteration: 0,
          attempt: 1,
          providerRequestIndex: 0,
          agentRole: "plan_turn",
          modelId: "glm-5-turbo",
          providerServiceId: "zai_coding_plan_official",
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cachedTokens: 0,
            reasoningTokens: 0,
            totalTokens: 14,
            stopReason: "stop",
          },
        });
        yield* addObservation({
          runId: fixture.runId,
          chatId: fixture.chatId,
          emittingTask: "single-answer",
          loopIteration: 0,
          attempt: 1,
          observationKey: "retry:context",
          kind: "context_serialized",
          payload: {
            consumerTaskId: "single-answer",
            sourceKeys: [],
            restrictedContextLedger: {
              requestKind: "direct",
              modelId: "glm-5-turbo",
              requestSha256Hex: "d".repeat(64),
              inputTokens: 10,
              usableInputTokens: 6144,
              requestedOutputTokens: 2048,
              selectedConversation: [],
              question: "current question",
              gaps: [],
              sources: [],
            },
            terminalUsageCoordinate: {
              taskId: "single-answer",
              loopIteration: 0,
              attempt: 1,
              providerRequestIndex: 0,
            },
          },
        });
        yield* addObservation({
          runId: fixture.runId,
          chatId: fixture.chatId,
          emittingTask: "single-measure",
          loopIteration: 0,
          attempt: 1,
          observationKey: "retry:context-measurement",
          kind: "context_measurement",
          payload: {
            consumerTaskId: "single-answer",
            mandatoryInputTokens: 10,
            discretionaryInputTokens: 0,
            totalInputTokens: 10,
            requestedOutputTokens: 2048,
            usableInputTokens: 6144,
            contextWindow: 8192,
            status: "ready",
            compactionRan: false,
            compactionFeedback: [],
            restrictedContextLedger: {
              requestKind: "direct",
              modelId: "glm-5-turbo",
              requestSha256Hex: "d".repeat(64),
              inputTokens: 10,
              usableInputTokens: 6144,
              requestedOutputTokens: 2048,
              selectedConversation: [],
              question: "current question",
              gaps: [],
              sources: [],
            },
          },
        });
        yield* addObservation({
          runId: fixture.runId,
          chatId: fixture.chatId,
          emittingTask: "single-answer",
          loopIteration: 0,
          attempt: 1,
          observationKey: "retry:answer-measurement",
          kind: "provider_request_measurement",
          payload: {
            providerRequestIndex: 0,
            agentRole: "direct_answer",
            modelId: "glm-5-turbo",
            requestSha256Hex: "d".repeat(64),
            sourceExposureProofSha256Hexes: [],
            sourceExposureProofBindings: [],
            inputTokens: 10,
            requestedOutputTokens: 2048,
            usableInputTokens: 6144,
            contextWindow: 8192,
            passed: true,
          },
        });
        yield* insertAiRunUsage({
          runId: fixture.runId,
          taskId: "single-answer",
          loopIteration: 0,
          attempt: 1,
          providerRequestIndex: 0,
          agentRole: "direct_answer",
          modelId: "glm-5-turbo",
          providerServiceId: "zai_coding_plan_official",
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cachedTokens: 0,
            reasoningTokens: 0,
            totalTokens: 14,
            stopReason: "stop",
          },
        });
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: { loopIteration: 0, attempt: 2 },
          answer: { status: "ok", mode: "single", content: "Retry answer", sourceMap: [] },
          memory,
        }),
      ),
    ).resolves.toMatchObject({ status: "succeeded" });

    const resumed = await runDb(createFixture("crash-resume"));
    await runDb(seedSingleObservability(resumed));
    await runDb(
      insertAiObservation({
        runId: resumed.runId,
        chatId: resumed.chatId,
        emittingTask: "plan-turn",
        loopIteration: 0,
        attempt: 1,
        observationKey: "crash:orphan-measurement",
        kind: "provider_request_measurement",
        payload: {
          providerRequestIndex: 0,
          agentRole: "plan_turn",
          modelId: "glm-5-turbo",
          requestSha256Hex: "e".repeat(64),
          sourceExposureProofSha256Hexes: [],
          sourceExposureProofBindings: [],
          inputTokens: 10,
          requestedOutputTokens: 2048,
          usableInputTokens: 6144,
          contextWindow: 8192,
          passed: true,
        },
      }),
    );
    await runDb(
      Effect.gen(function* () {
        yield* insertAiObservation({
          runId: resumed.runId,
          chatId: resumed.chatId,
          emittingTask: "plan-turn",
          loopIteration: 0,
          attempt: 2,
          observationKey: "crash:terminal-plan",
          kind: "turn_plan",
          payload: turnPlanPayload("single"),
        });
        yield* insertAiObservation({
          runId: resumed.runId,
          chatId: resumed.chatId,
          emittingTask: "single-answer",
          loopIteration: 0,
          attempt: 2,
          observationKey: "crash:terminal-context",
          kind: "context_serialized",
          payload: {
            consumerTaskId: "single-answer",
            sourceKeys: [],
            restrictedContextLedger: {
              requestKind: "direct",
              modelId: "glm-5-turbo",
              requestSha256Hex: "2".repeat(64),
              inputTokens: 10,
              usableInputTokens: 6144,
              requestedOutputTokens: 2048,
              selectedConversation: [],
              question: "current question",
              gaps: [],
              sources: [],
            },
            terminalUsageCoordinate: {
              taskId: "single-answer",
              loopIteration: 0,
              attempt: 2,
              providerRequestIndex: 0,
            },
          },
        });
        yield* insertAiObservation({
          runId: resumed.runId,
          chatId: resumed.chatId,
          emittingTask: "single-measure",
          loopIteration: 0,
          attempt: 2,
          observationKey: "crash:context-measurement",
          kind: "context_measurement",
          payload: {
            consumerTaskId: "single-answer",
            mandatoryInputTokens: 10,
            discretionaryInputTokens: 0,
            totalInputTokens: 10,
            requestedOutputTokens: 2048,
            usableInputTokens: 6144,
            contextWindow: 8192,
            status: "ready",
            compactionRan: false,
            compactionFeedback: [],
            restrictedContextLedger: {
              requestKind: "direct",
              modelId: "glm-5-turbo",
              requestSha256Hex: "2".repeat(64),
              inputTokens: 10,
              usableInputTokens: 6144,
              requestedOutputTokens: 2048,
              selectedConversation: [],
              question: "current question",
              gaps: [],
              sources: [],
            },
          },
        });
        for (const [taskId, role, digest] of [
          ["plan-turn", "plan_turn", "1".repeat(64)],
          ["single-answer", "direct_answer", "2".repeat(64)],
        ] as const) {
          yield* insertAiObservation({
            runId: resumed.runId,
            chatId: resumed.chatId,
            emittingTask: taskId,
            loopIteration: 0,
            attempt: 2,
            observationKey: `crash:${taskId}:measurement`,
            kind: "provider_request_measurement",
            payload: {
              providerRequestIndex: 0,
              agentRole: role,
              modelId: "glm-5-turbo",
              requestSha256Hex: digest,
              sourceExposureProofSha256Hexes: [],
              sourceExposureProofBindings: [],
              inputTokens: 10,
              requestedOutputTokens: 2048,
              usableInputTokens: 6144,
              contextWindow: 8192,
              passed: true,
            },
          });
          yield* insertAiRunUsage({
            runId: resumed.runId,
            taskId,
            loopIteration: 0,
            attempt: 2,
            providerRequestIndex: 0,
            agentRole: role,
            modelId: "glm-5-turbo",
            providerServiceId: "zai_coding_plan_official",
            usage: {
              inputTokens: 10,
              outputTokens: 4,
              cachedTokens: 0,
              reasoningTokens: 0,
              totalTokens: 14,
              stopReason: "stop",
            },
          });
        }
      }),
    );
    const resumedMemory = await runDb(
      persistMemoryArtifact(resumed, { proposals: [], discardedCount: 0 }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: resumed.runId,
          expectedSmithersRunId: `ai-chat:${resumed.runId}`,
          coordinates: { loopIteration: 0, attempt: 3 },
          answer: { status: "ok", mode: "single", content: "Resumed answer", sourceMap: [] },
          memory: resumedMemory,
        }),
      ),
    ).resolves.toMatchObject({ status: "succeeded" });
  });

  it("finalizes answer, memory, provenance, citations, and terminal event exactly once", async () => {
    const fixture = await runDb(createFixture("finalize"));
    const source = sourceFor(fixture);
    await runDb(
      seedSingleObservability(fixture, {
        includeAnswerMeasurement: true,
        contextSources: [
          {
            sourceKey: source.sourceKey,
            candidateId: candidateIdForSource(source),
            kind: "chat_message",
            ranges: [{ charStart: 0, charEnd: fixture.chatContent.length }],
            label: source.label,
          },
        ],
      }),
    );
    const answer: AnswerLaneResult = {
      status: "ok",
      mode: "single",
      content: `Answer [[cite:${sourceKeyFor(fixture, 1)},${sourceKeyFor(fixture, 2)},${sourceKeyFor(fixture, 3)}]]`,
      sourceMap: [source],
    };
    const memory = await runDb(
      persistMemoryArtifact(fixture, {
        proposals: [{ kind: "fact" as const, content: "  Likes exact results  " }],
        discardedCount: 2,
      }),
    );
    const input = {
      runId: fixture.runId,
      expectedSmithersRunId: `ai-chat:${fixture.runId}`,
      coordinates: finalizeCoordinates,
      answer,
      memory,
    };
    const first = await runDb(finalizeAiRun(input));
    const replay = await runDb(finalizeAiRun(input));
    expect(first.status).toBe("succeeded");
    expect(replay.alreadyTerminal).toBe(true);

    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [counts] = yield* sql<{
          readonly memories: number;
          readonly revisions: number;
          readonly assistants: number;
          readonly sources: number;
          readonly uses: number;
          readonly citations: number;
          readonly defects: number;
          readonly memoryWritten: number;
        }>`
          select
            (select count(*)::int from user_memories where user_id = ${fixture.userId}) as memories,
            (select count(*)::int from user_memory_revisions revisions join user_memories memories on memories.id = revisions.memory_id where memories.user_id = ${fixture.userId}) as revisions,
            (select count(*)::int from chat_messages where assistant_ai_run_id = ${fixture.runId}) as assistants,
            (select count(*)::int from assistant_message_sources sources join chat_messages messages on messages.id = sources.assistant_message_id where messages.assistant_ai_run_id = ${fixture.runId}) as sources,
            (select count(*)::int from assistant_message_source_uses uses join chat_messages messages on messages.id = uses.assistant_message_id where messages.assistant_ai_run_id = ${fixture.runId}) as uses,
            (select count(*)::int from ai_observations where run_id = ${fixture.runId} and kind = 'citation') as citations,
            (select count(*)::int from ai_observations where run_id = ${fixture.runId} and kind = 'citation_defect') as defects,
            (select count(*)::int from ai_observations where run_id = ${fixture.runId} and kind = 'memory_written') as "memoryWritten"
        `;
        const events = yield* sql<{ readonly key: string; readonly type: string }>`
          select emission_key as key, event->>'type' as type
          from ai_run_events where run_id = ${fixture.runId} order by seq
        `;
        const finalizationObservationCoordinates = yield* sql<{
          readonly loopIteration: number;
          readonly attempt: number;
        }>`
          select distinct loop_iteration as "loopIteration", attempt
          from ai_observations
          where run_id = ${fixture.runId}
            and emitting_task = 'finalize'
          order by loop_iteration, attempt
        `;
        const memoryWrittenPayloads = yield* sql<{ readonly payload: Record<string, unknown> }>`
          select payload from ai_observations
          where run_id = ${fixture.runId} and kind = 'memory_written'
          order by (payload->>'ordinal')::int
        `;
        const memoryApplications = yield* sql<{ readonly payload: Record<string, unknown> }>`
          select payload from ai_observations
          where run_id = ${fixture.runId} and kind = 'memory_application'
        `;
        const [memory] = yield* sql<{
          readonly content: string;
          readonly headRevisionId: string;
          readonly revisionId: string;
        }>`
          select memories.content, memories.head_revision_id::text as "headRevisionId", revisions.id::text as "revisionId"
          from user_memories memories
          join user_memory_revisions revisions on revisions.id = memories.head_revision_id
          where memories.user_id = ${fixture.userId}
        `;
        return {
          counts,
          events,
          finalizationObservationCoordinates,
          memoryWrittenPayloads,
          memoryApplications,
          memory,
        };
      }),
    );
    expect(state.counts).toMatchObject({
      memories: 1,
      revisions: 1,
      assistants: 1,
      sources: 1,
      uses: 1,
      citations: 1,
      defects: 2,
      memoryWritten: 1,
    });
    expect(state.memory?.content).toBe("Likes exact results");
    expect(state.memory?.headRevisionId).toBe(state.memory?.revisionId);
    expect(state.finalizationObservationCoordinates).toEqual([finalizeCoordinates]);
    expect(state.memoryWrittenPayloads).toEqual([
      {
        payload: {
          ordinal: 0,
          memoryId: expect.any(String),
          revisionId: expect.any(String),
          previousRevisionId: null,
          action: "create",
        },
      },
    ]);
    expect(state.memoryApplications).toEqual([
      {
        payload: {
          extractionTaskId: "memory-extract",
          extractionLoopIteration: 0,
          extractionAttempt: 1,
          extractionObservationKey: expect.any(String),
          extractionSha256Hex: expect.stringMatching(/^[a-f0-9]{64}$/u),
          proposalCount: 1,
          discardedCount: 2,
        },
      },
    ]);
    expect(state.events.map((event) => event.key)).toEqual([
      "usage:request:model:plan-turn:0:0:0",
      "usage:request:model:single-answer:0:0:0",
      "usage:request:model:single-retrieve-internal:0:0:0",
      "usage:request:model:single-retrieve-internal:0:0:1",
      "usage:request:model:single-retrieve-web:0:0:0",
      "usage:request:model:memory-extract:0:1:0",
      "memory_updated",
      "usage:run",
      "activity:finalization:all:finalization:complete:1",
      "terminal",
    ]);
  });

  it("accepts a full surrogate pair and disjoint chat ranges with the exact separator token count", async () => {
    for (const [suffix, ranges] of [
      ["chat-full-pair", [{ charStart: 1, charEnd: 3 }]],
      [
        "chat-disjoint-ranges",
        [
          { charStart: 0, charEnd: 1 },
          { charStart: 3, charEnd: 4 },
        ],
      ],
    ] as const) {
      const fixture = await runDb(createFixture(suffix));
      const text = "A😀B";
      const sourceMessage = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const rows = yield* sql<{ readonly id: string }>`
            insert into chat_messages (chat_id, author, content)
            values (${fixture.chatId}, 'user', ${text})
            returning id::text
          `;
          return rows[0]!.id;
        }),
      );
      const selectedText = ranges
        .map((range) => text.slice(range.charStart, range.charEnd))
        .join("\n…\n");
      const source: FinalSourceRecord = {
        sourceKey: sourceKeyFor(fixture),
        locator: { kind: "chat_message", messageId: sourceMessage },
        label: text,
        publicProvenance: {},
        uses: [
          {
            consumerTaskId: "single-answer",
            contextOrder: 0,
            renderedTokenCount: 3,
            ranges,
          },
        ],
      };
      await runDb(
        seedSingleObservability(fixture, {
          contextSources: [
            {
              sourceKey: source.sourceKey,
              candidateId: candidateIdForSource(source),
              kind: "chat_message",
              contentItemIdentity: sourceMessage,
              ranges,
              label: text,
              visibleTokenCount:
                resolveRegisteredModel("glm-5-turbo").countTextTokens(selectedText),
            },
          ],
        }),
      );
      const memory = await runDb(
        persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
      );
      await expect(
        runDb(
          finalizeAiRun({
            runId: fixture.runId,
            expectedSmithersRunId: `ai-chat:${fixture.runId}`,
            coordinates: finalizeCoordinates,
            answer: {
              status: "ok",
              mode: "single",
              content: `Answer [[cite:${source.sourceKey}]]`,
              sourceMap: [source],
            },
            memory,
          }),
        ),
      ).resolves.toMatchObject({ status: "succeeded" });
    }
  });

  it("rejects chat ranges that split either side of a surrogate pair", async () => {
    for (const [suffix, ranges] of [
      ["chat-split-start", [{ charStart: 2, charEnd: 3 }]],
      ["chat-split-end", [{ charStart: 1, charEnd: 2 }]],
    ] as const) {
      const fixture = await runDb(createFixture(suffix));
      const text = "A😀B";
      const sourceMessage = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const rows = yield* sql<{ readonly id: string }>`
            insert into chat_messages (chat_id, author, content)
            values (${fixture.chatId}, 'user', ${text})
            returning id::text
          `;
          return rows[0]!.id;
        }),
      );
      const source: FinalSourceRecord = {
        sourceKey: sourceKeyFor(fixture),
        locator: { kind: "chat_message", messageId: sourceMessage },
        label: text,
        publicProvenance: {},
        uses: [
          {
            consumerTaskId: "single-answer",
            contextOrder: 0,
            renderedTokenCount: 3,
            ranges,
          },
        ],
      };
      let seedFailure: unknown;
      try {
        await runDb(
          seedSingleObservability(fixture, {
            contextSources: [
              {
                sourceKey: source.sourceKey,
                candidateId: candidateIdForSource(source),
                kind: "chat_message",
                contentItemIdentity: sourceMessage,
                ranges,
                label: text,
              },
            ],
          }),
        );
      } catch (error) {
        seedFailure = error;
      }
      expect(seedFailure).toBeDefined();
      expect(errorText(seedFailure)).toContain(
        "chat source exposure ranges exceed citation-sanitized UTF-16 text",
      );
    }
  });

  it("rejects a token-count tamper after reconstructing selected chat text", async () => {
    const fixture = await runDb(createFixture("chat-token-tamper"));
    const text = "A😀B";
    const ranges = [{ charStart: 0, charEnd: text.length }] as const;
    const sourceMessage = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${fixture.chatId}, 'user', ${text})
          returning id::text
        `;
        return rows[0]!.id;
      }),
    );
    const source: FinalSourceRecord = {
      sourceKey: sourceKeyFor(fixture),
      locator: { kind: "chat_message", messageId: sourceMessage },
      label: text,
      publicProvenance: {},
      uses: [
        {
          consumerTaskId: "single-answer",
          contextOrder: 0,
          renderedTokenCount: 3,
          ranges,
        },
      ],
    };
    await runDb(
      seedSingleObservability(fixture, {
        contextSources: [
          {
            sourceKey: source.sourceKey,
            candidateId: candidateIdForSource(source),
            kind: "chat_message",
            contentItemIdentity: sourceMessage,
            ranges,
            label: text,
            visibleTokenCount: resolveRegisteredModel("glm-5-turbo").countTextTokens(text) + 1,
          },
        ],
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: {
            status: "ok",
            mode: "single",
            content: `Answer [[cite:${source.sourceKey}]]`,
            sourceMap: [source],
          },
          memory,
        }),
      ),
    ).rejects.toThrow(/exact sanitized answer exposure/u);
  });

  it("rejects a future same-chat source even when its exposure proof is otherwise exact", async () => {
    const fixture = await runDb(createFixture("chat-future-source"));
    const text = "Future source";
    const sourceMessage = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content, created_at)
          values (${fixture.chatId}, 'user', ${text}, now() + interval '1 hour')
          returning id::text
        `;
        return rows[0]!.id;
      }),
    );
    const source: FinalSourceRecord = {
      sourceKey: sourceKeyFor(fixture),
      locator: { kind: "chat_message", messageId: sourceMessage },
      label: text,
      publicProvenance: {},
      uses: [
        {
          consumerTaskId: "single-answer",
          contextOrder: 0,
          renderedTokenCount: 3,
          ranges: [{ charStart: 0, charEnd: text.length }],
        },
      ],
    };
    await runDb(
      seedSingleObservability(fixture, {
        contextSources: [
          {
            sourceKey: source.sourceKey,
            candidateId: candidateIdForSource(source),
            kind: "chat_message",
            contentItemIdentity: sourceMessage,
            ranges: [{ charStart: 0, charEnd: text.length }],
            label: text,
          },
        ],
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: {
            status: "ok",
            mode: "single",
            content: `Answer [[cite:${source.sourceKey}]]`,
            sourceMap: [source],
          },
          memory,
        }),
      ),
    ).rejects.toThrow(/strict predecessor/u);
  });

  it("does not borrow a chat hash or range proof from another answer coordinate", async () => {
    const fixture = await runDb(createFixture("chat-cross-coordinate-proof"));
    const source = sourceFor(fixture);
    await runDb(
      seedSingleObservability(fixture, {
        contextSources: [
          {
            sourceKey: source.sourceKey,
            candidateId: candidateIdForSource(source),
            kind: "chat_message",
            ranges: [{ charStart: 0, charEnd: fixture.chatContent.length }],
            label: source.label,
          },
        ],
      }),
    );
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_source_exposures
          set attempt = 1
          where run_id = ${fixture.runId}
            and task_id = 'single-answer'
            and exposure_stage = 'answer_serialized'
        `;
        yield* sql`
          update ai_observations
          set attempt = 1
          where run_id = ${fixture.runId}
            and emitting_task = 'single-answer'
            and kind = 'source_exposure_attestation'
            and payload->>'exposureStage' = 'answer_serialized'
        `;
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: {
            status: "ok",
            mode: "single",
            content: `Answer [[cite:${source.sourceKey}]]`,
            sourceMap: [source],
          },
          memory,
        }),
      ),
    ).rejects.toThrow(/answer_serialized exposure|provider measurement/u);
  });

  it("revalidates every required durable ledger class before terminal replay", async () => {
    for (const ledger of [
      "turn_plan",
      "retrieval_manifest",
      "context_measurement",
      "context_serialized",
      "memory_extraction_result",
      "memory_extraction_payload",
      "provider_request_measurement",
      "provider_usage",
      "source_exposure",
      "source_exposure_attestation",
      "memory_application",
      "memory_written",
      "memory_updated_event",
      "usage_event",
      "terminal_event",
      "memory_revision",
      "source_use",
      "source",
      "citation",
      "citation_defect",
      "assistant_message",
    ] as const) {
      const fixture = await runDb(createFixture(`terminal-replay-${ledger}`));
      const source = sourceFor(fixture);
      await runDb(
        seedSingleObservability(fixture, {
          contextSources: [
            {
              sourceKey: source.sourceKey,
              candidateId: candidateIdForSource(source),
              kind: "chat_message",
              ranges: [{ charStart: 0, charEnd: fixture.chatContent.length }],
              label: source.label,
            },
          ],
        }),
      );
      const memory = await runDb(
        persistMemoryArtifact(fixture, {
          proposals: [{ kind: "fact", content: "Replay proof" }],
          discardedCount: 0,
        }),
      );
      const input = {
        runId: fixture.runId,
        expectedSmithersRunId: `ai-chat:${fixture.runId}`,
        coordinates: finalizeCoordinates,
        answer: {
          status: "ok" as const,
          mode: "single" as const,
          content: `Answer [[cite:${source.sourceKey}]] [[cite:k_${fixture.citationNamespace}_999]]`,
          sourceMap: [source],
        },
        memory,
      };
      await expect(runDb(finalizeAiRun(input))).resolves.toMatchObject({
        status: "succeeded",
        alreadyTerminal: false,
      });
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          if (ledger === "provider_usage") {
            yield* sql`
              delete from ai_run_usage
              where run_id = ${fixture.runId}
                and task_id = 'single-answer'
            `;
          } else if (ledger === "source_exposure") {
            yield* sql`
              delete from ai_source_exposures
              where run_id = ${fixture.runId}
                and task_id = 'single-answer'
            `;
          } else if (ledger === "memory_extraction_payload") {
            yield* sql`
              update ai_observations
              set payload = jsonb_set(payload, '{proposalCount}', '2'::jsonb)
              where run_id = ${fixture.runId}
                and kind = 'memory_extraction_result'
            `;
          } else if (ledger === "memory_application" || ledger === "memory_written") {
            yield* sql`
              delete from ai_observations
              where run_id = ${fixture.runId}
                and kind = ${ledger}
            `;
          } else if (
            ledger === "memory_updated_event" ||
            ledger === "usage_event" ||
            ledger === "terminal_event"
          ) {
            const emissionKey =
              ledger === "memory_updated_event"
                ? "memory_updated"
                : ledger === "usage_event"
                  ? "usage:run"
                  : "terminal";
            yield* sql`
              delete from ai_run_events
              where run_id = ${fixture.runId}
                and emission_key = ${emissionKey}
            `;
          } else if (ledger === "memory_revision") {
            yield* sql`
              update user_memory_revisions
              set state_after = jsonb_set(state_after, '{content}', '"tampered"'::jsonb)
              where run_id = ${fixture.runId}
            `;
          } else if (ledger === "citation" || ledger === "citation_defect") {
            yield* sql`
              delete from ai_observations
              where run_id = ${fixture.runId}
                and kind = ${ledger}
            `;
          } else if (ledger === "source_use") {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`alter table assistant_message_source_uses disable trigger user`;
                yield* sql`
                  delete from assistant_message_source_uses
                  where assistant_message_id in (
                    select id from chat_messages where assistant_ai_run_id = ${fixture.runId}
                  )
                `;
                yield* sql`alter table assistant_message_source_uses enable trigger user`;
              }),
            );
          } else if (ledger === "source") {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`alter table assistant_message_source_uses disable trigger user`;
                yield* sql`
                  delete from assistant_message_source_uses
                  where assistant_message_id in (
                    select id from chat_messages where assistant_ai_run_id = ${fixture.runId}
                  )
                `;
                yield* sql`alter table assistant_message_source_uses enable trigger user`;
                yield* sql`alter table assistant_message_sources disable trigger user`;
                yield* sql`
                  delete from assistant_message_sources
                  where assistant_message_id in (
                    select id from chat_messages where assistant_ai_run_id = ${fixture.runId}
                  )
                `;
                yield* sql`alter table assistant_message_sources enable trigger user`;
              }),
            );
          } else if (ledger === "assistant_message") {
            yield* sql`
              update chat_messages
              set content = content || ' tampered'
              where assistant_ai_run_id = ${fixture.runId}
            `;
          } else {
            const kind =
              ledger === "provider_request_measurement" ? "provider_request_measurement" : ledger;
            yield* sql`
              delete from ai_observations
              where run_id = ${fixture.runId}
                and kind = ${kind}
                and (
                  ${ledger} not in (
                    'retrieval_manifest',
                    'provider_request_measurement',
                    'source_exposure_attestation'
                  )
                  or emitting_task = 'single-answer'
                  or (
                    ${ledger} = 'retrieval_manifest'
                    and emitting_task = 'single-retrieve-internal'
                  )
                )
            `;
          }
        }),
      );

      await expect(runDb(finalizeAiRun(input))).rejects.toThrow();
    }
  });

  it("revalidates every external usage row and its exact request event on replay", async () => {
    for (const corruption of [
      "request-event-removed",
      "usage-row-removed",
      "status-changed",
      "duration-changed",
    ] as const) {
      const fixture = await runDb(createFixture(`terminal-replay-external-${corruption}`));
      await runDb(
        Effect.gen(function* () {
          yield* seedSingleObservability(fixture);
          yield* insertAiExternalToolUsage({
            runId: fixture.runId,
            taskId: "single-retrieve-web",
            loopIteration: 0,
            attempt: 0,
            toolRequestIndex: 0,
            providerServiceId: "tinyfish_search_official",
            operation: "web_search",
            status: "ok",
            resultCount: 1,
            responseBytes: 128,
            billedUnits: null,
            durationMs: 25,
          });
        }),
      );
      const memory = await runDb(
        persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
      );
      const input = {
        runId: fixture.runId,
        expectedSmithersRunId: `ai-chat:${fixture.runId}`,
        coordinates: finalizeCoordinates,
        answer: {
          status: "ok" as const,
          mode: "single" as const,
          content: "Answer",
          sourceMap: [],
        },
        memory,
      };
      await expect(runDb(finalizeAiRun(input))).resolves.toMatchObject({
        status: "succeeded",
        alreadyTerminal: false,
      });
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          if (corruption === "request-event-removed") {
            yield* sql`
              delete from ai_run_events
              where run_id = ${fixture.runId}
                and emission_key =
                  'usage:request:web_search:single-retrieve-web:0:0:0'
            `;
          } else if (corruption === "usage-row-removed") {
            yield* sql`
              delete from ai_external_tool_usage
              where run_id = ${fixture.runId}
                and task_id = 'single-retrieve-web'
                and loop_iteration = 0
                and attempt = 0
                and tool_request_index = 0
            `;
            yield* sql`
              update ai_run_events
              set event = event || '{"web":{"searchCount":0,"fetchCount":0,"responseBytes":0,"billedUnits":0}}'::jsonb
              where run_id = ${fixture.runId}
                and emission_key = 'usage:run'
            `;
          } else if (corruption === "status-changed") {
            yield* sql`
              update ai_external_tool_usage
              set status = 'empty'
              where run_id = ${fixture.runId}
                and task_id = 'single-retrieve-web'
                and loop_iteration = 0
                and attempt = 0
                and tool_request_index = 0
            `;
          } else {
            yield* sql`
              update ai_external_tool_usage
              set duration_ms = 26
              where run_id = ${fixture.runId}
                and task_id = 'single-retrieve-web'
                and loop_iteration = 0
                and attempt = 0
                and tool_request_index = 0
            `;
          }
        }),
      );

      await expect(runDb(finalizeAiRun(input))).rejects.toThrow(
        /external (usage row lacks its exact durable request event|request event has no exact usage row)/u,
      );
    }
  });

  it("keeps a no-memory selector replay idempotent after a later run creates memory", async () => {
    const fixture = await runDb(createFixture("terminal-replay-no-memory-call"));
    await runDb(
      seedSingleObservability(fixture, {
        includeMemorySelectorMeasurement: false,
      }),
    );
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_observations
          set attempt = 1,
              observation_key = 'single-select-memories:0:1:retrieval_manifest:result'
          where run_id = ${fixture.runId}
            and emitting_task = 'single-select-memories'
            and kind = 'retrieval_manifest'
        `;
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    const input = {
      runId: fixture.runId,
      expectedSmithersRunId: `ai-chat:${fixture.runId}`,
      coordinates: finalizeCoordinates,
      answer: {
        status: "ok" as const,
        mode: "single" as const,
        content: "Answer",
        sourceMap: [],
      },
      memory,
    };

    await expect(runDb(finalizeAiRun(input))).resolves.toMatchObject({
      status: "succeeded",
      alreadyTerminal: false,
    });

    const later = await runDb(createNextRun(fixture, "Create the first memory", "clarify"));
    await runDb(seedSingleObservability(later));
    const laterMemory = await runDb(
      persistMemoryArtifact(later, {
        proposals: [{ kind: "fact", content: "Created by a later run" }],
        discardedCount: 0,
      }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: later.runId,
          expectedSmithersRunId: `ai-chat:${later.runId}`,
          coordinates: finalizeCoordinates,
          answer: {
            status: "ok",
            mode: "clarification",
            content: "Saved",
            sourceMap: [],
          },
          memory: laterMemory,
        }),
      ),
    ).resolves.toMatchObject({ status: "succeeded" });

    await expect(runDb(finalizeAiRun(input))).resolves.toMatchObject({
      status: "succeeded",
      alreadyTerminal: true,
    });
  });

  it("replays a provider-backed memory selector after its memory is deleted", async () => {
    const created = await runDb(createFixture("terminal-replay-memory-call-source", "clarify"));
    await runDb(seedSingleObservability(created));
    const createdArtifact = await runDb(
      persistMemoryArtifact(created, {
        proposals: [{ kind: "fact", content: "Delete after the selector call" }],
        discardedCount: 0,
      }),
    );
    await runDb(
      finalizeAiRun({
        runId: created.runId,
        expectedSmithersRunId: `ai-chat:${created.runId}`,
        coordinates: finalizeCoordinates,
        answer: { status: "ok", mode: "clarification", content: "Saved", sourceMap: [] },
        memory: createdArtifact,
      }),
    );
    const memory = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly id: string }>`
          select id::text
          from user_memories
          where user_id = ${created.userId}
        `)[0]!;
      }),
    );

    const providerBacked = await runDb(createNextRun(created, "Read the saved memory"));
    await runDb(seedSingleObservability(providerBacked));
    const providerBackedArtifact = await runDb(
      persistMemoryArtifact(providerBacked, { proposals: [], discardedCount: 0 }),
    );
    const input = {
      runId: providerBacked.runId,
      expectedSmithersRunId: `ai-chat:${providerBacked.runId}`,
      coordinates: finalizeCoordinates,
      answer: {
        status: "ok" as const,
        mode: "single" as const,
        content: "Answer",
        sourceMap: [],
      },
      memory: providerBackedArtifact,
    };
    await expect(runDb(finalizeAiRun(input))).resolves.toMatchObject({
      status: "succeeded",
      alreadyTerminal: false,
    });

    await runDb(deleteUserMemory(created.userId, memory.id));
    await expect(runDb(finalizeAiRun(input))).resolves.toMatchObject({
      status: "succeeded",
      alreadyTerminal: true,
    });
  });

  it("replays a sealed no-memory selector after delete, run, and revert", async () => {
    const created = await runDb(createFixture("terminal-replay-deleted-memory", "clarify"));
    await runDb(seedSingleObservability(created));
    const createdArtifact = await runDb(
      persistMemoryArtifact(created, {
        proposals: [{ kind: "fact", content: "Delete before the next run" }],
        discardedCount: 0,
      }),
    );
    await runDb(
      finalizeAiRun({
        runId: created.runId,
        expectedSmithersRunId: `ai-chat:${created.runId}`,
        coordinates: finalizeCoordinates,
        answer: { status: "ok", mode: "clarification", content: "Saved", sourceMap: [] },
        memory: createdArtifact,
      }),
    );
    const memory = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly id: string; readonly headRevisionId: string }>`
            select id::text, head_revision_id::text as "headRevisionId"
            from user_memories
            where user_id = ${created.userId}
          `)[0]!;
      }),
    );
    await runDb(deleteUserMemory(created.userId, memory.id));

    const noCall = await runDb(createNextRun(created, "Run while the memory is deleted"));
    await runDb(
      seedSingleObservability(noCall, {
        includeMemorySelectorMeasurement: false,
      }),
    );
    const noCallArtifact = await runDb(
      persistMemoryArtifact(noCall, { proposals: [], discardedCount: 0 }),
    );
    const input = {
      runId: noCall.runId,
      expectedSmithersRunId: `ai-chat:${noCall.runId}`,
      coordinates: finalizeCoordinates,
      answer: {
        status: "ok" as const,
        mode: "single" as const,
        content: "Answer",
        sourceMap: [],
      },
      memory: noCallArtifact,
    };
    await expect(runDb(finalizeAiRun(input))).resolves.toMatchObject({
      status: "succeeded",
      alreadyTerminal: false,
    });

    await runDb(revertUserMemory(created.userId, memory.id, memory.headRevisionId));

    await expect(runDb(finalizeAiRun(input))).resolves.toMatchObject({
      status: "succeeded",
      alreadyTerminal: true,
    });
  });

  it("rejects a no-memory manifest forged after retention removed later memory rows", async () => {
    const fixture = await runDb(createFixture("terminal-replay-retention-forgery"));
    await runDb(
      seedSingleObservability(fixture, {
        includeMemorySelectorMeasurement: false,
      }),
    );
    const artifact = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    const input = {
      runId: fixture.runId,
      expectedSmithersRunId: `ai-chat:${fixture.runId}`,
      coordinates: finalizeCoordinates,
      answer: {
        status: "ok" as const,
        mode: "single" as const,
        content: "Answer",
        sourceMap: [],
      },
      memory: artifact,
    };
    await runDb(finalizeAiRun(input));

    const later = await runDb(createNextRun(fixture, "Create memory for retention", "clarify"));
    await runDb(seedSingleObservability(later));
    const laterArtifact = await runDb(
      persistMemoryArtifact(later, {
        proposals: [{ kind: "fact", content: "Remove through retention" }],
        discardedCount: 0,
      }),
    );
    await runDb(
      finalizeAiRun({
        runId: later.runId,
        expectedSmithersRunId: `ai-chat:${later.runId}`,
        coordinates: finalizeCoordinates,
        answer: { status: "ok", mode: "clarification", content: "Saved", sourceMap: [] },
        memory: laterArtifact,
      }),
    );
    const memoryId = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly id: string }>`
            select id::text
            from user_memories
            where user_id = ${fixture.userId}
          `)[0]!.id;
      }),
    );
    await runDb(deleteUserMemory(fixture.userId, memoryId));
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update user_memories
          set deleted_at = now() - interval '31 days'
          where id = ${memoryId}
        `;
      }),
    );
    await runDb(purgeUserMemoryTombstones());
    await runDb(
      insertAiObservation({
        runId: fixture.runId,
        chatId: fixture.chatId,
        emittingTask: "single-select-memories",
        loopIteration: 0,
        attempt: 1,
        observationKey: "single-select-memories:0:1:retrieval_manifest:result",
        kind: "retrieval_manifest",
        payload: {
          selectorRole: "memory",
          references: [],
          noCallReason: "no_active_memories",
        },
      }),
    );

    await expect(runDb(finalizeAiRun(input))).rejects.toThrow(
      /lacks its exact durable no-call seal/u,
    );
  });

  it("rejects forged durable no-call memory reasons", async () => {
    const first = await runDb(createFixture("forged-no-memory-history", "clarify"));
    await runDb(seedSingleObservability(first));
    const firstMemory = await runDb(
      persistMemoryArtifact(first, {
        proposals: [{ kind: "fact", content: "Already exists" }],
        discardedCount: 0,
      }),
    );
    await runDb(
      finalizeAiRun({
        runId: first.runId,
        expectedSmithersRunId: `ai-chat:${first.runId}`,
        coordinates: finalizeCoordinates,
        answer: {
          status: "ok",
          mode: "clarification",
          content: "Saved",
          sourceMap: [],
        },
        memory: firstMemory,
      }),
    );

    const forgedHistory = await runDb(createNextRun(first, "Use memory"));
    await runDb(
      seedSingleObservability(forgedHistory, {
        includeMemorySelectorMeasurement: false,
      }),
    );
    const forgedHistoryMemory = await runDb(
      persistMemoryArtifact(forgedHistory, { proposals: [], discardedCount: 0 }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: forgedHistory.runId,
          expectedSmithersRunId: `ai-chat:${forgedHistory.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "Answer", sourceMap: [] },
          memory: forgedHistoryMemory,
        }),
      ),
    ).rejects.toThrow(/invalid durable no-call reason/u);

    const forgedProviderCall = await runDb(createFixture("forged-no-memory-provider-call"));
    await runDb(
      seedSingleObservability(forgedProviderCall, {
        includeMemorySelectorMeasurement: false,
      }),
    );
    await runDb(
      insertProviderMeasurementAndUsage(forgedProviderCall, {
        taskId: "single-select-memories",
        agentRole: "memory_selector",
        loopIteration: 0,
        attempt: 0,
        requestSha256Hex: "4".repeat(64),
      }),
    );
    const forgedProviderMemory = await runDb(
      persistMemoryArtifact(forgedProviderCall, { proposals: [], discardedCount: 0 }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: forgedProviderCall.runId,
          expectedSmithersRunId: `ai-chat:${forgedProviderCall.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "Answer", sourceMap: [] },
          memory: forgedProviderMemory,
        }),
      ),
    ).rejects.toThrow(/invalid durable no-call reason/u);
  });

  it("requires the exact no-call reason from the locked selector state", async () => {
    const cases = [
      {
        reason: "memory_mode_disabled" as const,
        taskId: "single-select-memories",
        wrongReason: "no_active_memories" as const,
        create: () => createFixture("no-call-required-memory-disabled", "single", "disabled"),
        seed: (fixture: Fixture) => seedSingleObservability(fixture),
        answer: {
          status: "ok" as const,
          mode: "single" as const,
          content: "Answer",
          sourceMap: [],
        },
      },
      {
        reason: "no_active_memories" as const,
        taskId: "single-select-memories",
        wrongReason: "memory_mode_disabled" as const,
        create: () => createFixture("no-call-required-no-memory"),
        seed: (fixture: Fixture) => seedSingleObservability(fixture),
        answer: {
          status: "ok" as const,
          mode: "single" as const,
          content: "Answer",
          sourceMap: [],
        },
      },
      {
        reason: "web_not_requested" as const,
        taskId: "single-retrieve-web",
        wrongReason: "web_policy_disabled" as const,
        create: () =>
          createFixture("no-call-required-web-not-requested", "single", "private_owner", false),
        seed: (fixture: Fixture) => seedSingleObservability(fixture),
        answer: {
          status: "ok" as const,
          mode: "single" as const,
          content: "Answer",
          sourceMap: [],
        },
      },
      {
        reason: "web_policy_disabled" as const,
        taskId: "single-retrieve-web",
        wrongReason: "web_not_requested" as const,
        create: () =>
          createFixture(
            "no-call-required-web-policy-disabled",
            "single",
            "private_owner",
            true,
            false,
          ),
        seed: (fixture: Fixture) =>
          Effect.gen(function* () {
            yield* seedSingleObservability(fixture);
          }),
        answer: {
          status: "ok" as const,
          mode: "single" as const,
          content: "Answer",
          sourceMap: [],
        },
      },
      {
        reason: "topic_not_web_eligible" as const,
        taskId: "topic-t1-retrieve-web",
        wrongReason: "web_not_requested" as const,
        create: () =>
          createFixture("no-call-required-topic", "fanout", "private_owner", true, true),
        seed: (fixture: Fixture) =>
          Effect.gen(function* () {
            yield* seedFanoutFailureBase(fixture);
          }),
        answer: {
          status: "failed" as const,
          code: "synthesis_failed" as const,
          retryable: false,
        },
      },
    ] as const;

    for (const testCase of cases) {
      for (const mutation of ["omitted", "wrong"] as const) {
        const fixture = await runDb(testCase.create());
        await runDb(testCase.seed(fixture));
        await runDb(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            if (mutation === "omitted") {
              yield* sql`
                update ai_observations
                set payload = payload - 'noCallReason'
                where run_id = ${fixture.runId}
                  and emitting_task = ${testCase.taskId}
                  and kind = 'retrieval_manifest'
              `;
            } else {
              yield* sql`
                update ai_observations
                set payload = jsonb_set(payload, '{noCallReason}', to_jsonb(${testCase.wrongReason}::text))
                where run_id = ${fixture.runId}
                  and emitting_task = ${testCase.taskId}
                  and kind = 'retrieval_manifest'
              `;
            }
          }),
        );
        if (mutation === "omitted") {
          await runDb(
            insertProviderMeasurementAndUsage(fixture, {
              taskId: testCase.taskId,
              agentRole: testCase.taskId.endsWith("select-memories")
                ? "memory_selector"
                : testCase.taskId.endsWith("retrieve-web")
                  ? "web_research"
                  : "internal_retrieval",
              loopIteration: 0,
              attempt: 0,
              requestSha256Hex: "4".repeat(64),
            }),
          );
        }
        const memory = await runDb(
          persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
        );
        await expect(
          runDb(
            finalizeAiRun({
              runId: fixture.runId,
              expectedSmithersRunId: `ai-chat:${fixture.runId}`,
              coordinates: finalizeCoordinates,
              answer: testCase.answer,
              memory,
            }),
          ),
        ).rejects.toThrow(/invalid durable no-call reason/u);
      }

      const replayFixture = await runDb(testCase.create());
      await runDb(testCase.seed(replayFixture));
      const replayMemory = await runDb(
        persistMemoryArtifact(replayFixture, { proposals: [], discardedCount: 0 }),
      );
      const replayInput = {
        runId: replayFixture.runId,
        expectedSmithersRunId: `ai-chat:${replayFixture.runId}`,
        coordinates: finalizeCoordinates,
        answer: testCase.answer,
        memory: replayMemory,
      };
      await expect(runDb(finalizeAiRun(replayInput))).resolves.toMatchObject(
        testCase.answer.status === "failed"
          ? { status: "failed", code: testCase.answer.code, alreadyTerminal: false }
          : { status: "succeeded", alreadyTerminal: false },
      );
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update ai_observations
            set payload = payload - 'noCallReason'
            where run_id = ${replayFixture.runId}
              and emitting_task = ${testCase.taskId}
              and kind = 'retrieval_manifest'
          `;
        }),
      );
      await runDb(
        insertProviderMeasurementAndUsageAfterTerminal(replayFixture, {
          taskId: testCase.taskId,
          agentRole: testCase.taskId.endsWith("select-memories")
            ? "memory_selector"
            : testCase.taskId.endsWith("retrieve-web")
              ? "web_research"
              : "internal_retrieval",
          loopIteration: 0,
          attempt: 0,
          requestSha256Hex: "5".repeat(64),
        }),
      );
      const replayUsage = await runDb(deriveAggregateAiRunUsage(replayFixture.runId));
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update ai_run_events
            set event = ${sql.json({ type: "usage", scope: "run", ...replayUsage })}
            where run_id = ${replayFixture.runId}
              and emission_key = 'usage:run'
          `;
        }),
      );
      await expect(runDb(finalizeAiRun(replayInput))).rejects.toThrow(
        /invalid durable no-call reason/u,
      );
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update ai_observations
            set payload = jsonb_set(payload, '{noCallReason}', to_jsonb(${testCase.wrongReason}::text))
            where run_id = ${replayFixture.runId}
              and emitting_task = ${testCase.taskId}
              and kind = 'retrieval_manifest'
          `;
        }),
      );
      await expect(runDb(finalizeAiRun(replayInput))).rejects.toThrow(
        /invalid durable no-call reason|exact durable no-call seal/u,
      );
    }
  });

  it("rejects external usage on a sealed web no-call task during initial seal and replay", async () => {
    const initial = await runDb(
      createFixture("no-call-web-external-initial", "single", "private_owner", false, false),
    );
    await runDb(seedSingleObservability(initial));
    await runDb(
      insertAiExternalToolUsage({
        runId: initial.runId,
        taskId: "single-retrieve-web",
        loopIteration: 0,
        attempt: 0,
        toolRequestIndex: 0,
        providerServiceId: "tinyfish_search_official",
        operation: "web_search",
        status: "ok",
        resultCount: 1,
        responseBytes: 128,
        billedUnits: null,
        durationMs: 25,
      }),
    );
    const initialMemory = await runDb(
      persistMemoryArtifact(initial, { proposals: [], discardedCount: 0 }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: initial.runId,
          expectedSmithersRunId: `ai-chat:${initial.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "Answer", sourceMap: [] },
          memory: initialMemory,
        }),
      ),
    ).rejects.toThrow(/invalid durable no-call reason/u);

    const replay = await runDb(
      createFixture("no-call-web-external-replay", "single", "private_owner", false, false),
    );
    await runDb(seedSingleObservability(replay));
    const replayMemory = await runDb(
      persistMemoryArtifact(replay, { proposals: [], discardedCount: 0 }),
    );
    const replayInput = {
      runId: replay.runId,
      expectedSmithersRunId: `ai-chat:${replay.runId}`,
      coordinates: finalizeCoordinates,
      answer: { status: "ok" as const, mode: "single" as const, content: "Answer", sourceMap: [] },
      memory: replayMemory,
    };
    await expect(runDb(finalizeAiRun(replayInput))).resolves.toMatchObject({
      status: "succeeded",
      alreadyTerminal: false,
    });
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into ai_external_tool_usage (
            run_id, task_id, loop_iteration, attempt, tool_request_index,
            provider_service_id, operation, status, result_count, response_bytes,
            billed_units, duration_ms
          ) values (
            ${replay.runId}, 'single-retrieve-web', 0, 1, 0,
            'tinyfish_search_official', 'web_search', 'ok', 1, 128, null, 25
          )
        `;
        yield* sql`
          insert into ai_run_events (
            run_id, seq, emission_key, event, emitted_by_task
          )
          select ${replay.runId}, coalesce(max(seq), 0) + 1,
                 'usage:request:web_search:single-retrieve-web:0:1:0',
                 ${sql.json({
                   type: "usage",
                   scope: "request",
                   kind: "web_search",
                   attempt: 1,
                   status: "ok",
                   resultCount: 1,
                   responseBytes: 128,
                   billedUnits: null,
                   durationMs: 25,
                 })},
                 'single-retrieve-web'
          from ai_run_events
          where run_id = ${replay.runId}
        `;
      }),
    );
    const replayUsage = await runDb(deriveAggregateAiRunUsage(replay.runId));
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_run_events
          set event = ${sql.json({ type: "usage", scope: "run", ...replayUsage })}
          where run_id = ${replay.runId}
            and emission_key = 'usage:run'
        `;
      }),
    );
    await expect(runDb(finalizeAiRun(replayInput))).rejects.toThrow(
      /invalid durable no-call reason/u,
    );
  });

  it("persists a cited memory revision before applying a same-turn update", async () => {
    const fixture = await runDb(createFixture("memory-citation-update", "clarify"));
    await runDb(seedSingleObservability(fixture));
    const initialMemory = await runDb(
      persistMemoryArtifact(fixture, {
        proposals: [{ kind: "preference", content: "Use GWh" }],
        discardedCount: 0,
      }),
    );
    await runDb(
      finalizeAiRun({
        runId: fixture.runId,
        expectedSmithersRunId: `ai-chat:${fixture.runId}`,
        coordinates: finalizeCoordinates,
        answer: { status: "ok", mode: "clarification", content: "Saved", sourceMap: [] },
        memory: initialMemory,
      }),
    );

    const memory = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [row] = yield* sql<{ readonly id: string; readonly revisionId: string }>`
          select id::text, head_revision_id::text as "revisionId"
          from user_memories where user_id = ${fixture.userId}
        `;
        return row!;
      }),
    );
    const next = await runDb(createNextRun(fixture, "Update the energy unit"));
    const updateMemory = await runDb(
      persistMemoryArtifact(next, {
        proposals: [
          {
            kind: "preference",
            content: "Use MWh",
            targetMemoryId: memory.id,
            expectedHeadRevisionId: memory.revisionId,
          },
        ],
        discardedCount: 0,
      }),
    );
    const source: FinalSourceRecord = {
      sourceKey: sourceKeyFor(next),
      locator: { kind: "memory", memoryId: memory.id, memoryRevisionId: memory.revisionId },
      label: "Energy unit preference",
      publicProvenance: {},
      uses: [
        {
          consumerTaskId: "single-answer",
          contextOrder: 0,
          renderedTokenCount: 3,
          ranges: [],
        },
      ],
    };
    await runDb(
      seedSingleObservability(next, {
        includeAnswerMeasurement: true,
        contextSources: [
          {
            sourceKey: source.sourceKey,
            candidateId: candidateIdForSource(source),
            kind: "memory",
            ranges: [],
            label: source.label,
            ...(source.locator.kind === "memory"
              ? { contentItemIdentity: source.locator.memoryRevisionId }
              : {}),
          },
        ],
      }),
    );
    const result = await runDb(
      finalizeAiRun({
        runId: next.runId,
        expectedSmithersRunId: `ai-chat:${next.runId}`,
        coordinates: finalizeCoordinates,
        answer: {
          status: "ok",
          mode: "single",
          content: `The saved preference is cited [[cite:${sourceKeyFor(next)}]]`,
          sourceMap: [source],
        },
        memory: updateMemory,
      }),
    );
    expect(result).toMatchObject({ status: "succeeded" });
  });

  it("uses publisher provenance to persist a public document whose ID collides with a publisher version", async () => {
    const sourceId = `collision-source-${crypto.randomUUID()}`;
    const canonicalUrl = "https://public.example/colliding-document";
    const text = "Public collision evidence. ".repeat(5);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into public_sources (
            source_id, display_name, publisher_name, description, ingestion_method,
            discovery_url, average_chars_per_item
          ) values (
            ${sourceId}, 'Collision public source', 'Public publisher', 'Collision source',
            'manual', ${canonicalUrl}, ${text.length}
          )
        `;
      }),
    );
    const fixture = await runDb(
      createFixture("document-identity-collision", "single", "private_owner", true, true, [
        sourceId,
      ]),
    );
    const collision = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const publicDocumentId = crypto.randomUUID();
        const publisherCompanyId = crypto.randomUUID();
        const publisherIssueId = crypto.randomUUID();
        const publisherDocumentId = crypto.randomUUID();
        const subscriptionId = crypto.randomUUID();
        const rawArtifactId = crypto.randomUUID();
        const publisherText = "Publisher collision text";
        const publicContentHash = createHash("sha256").update(text, "utf8").digest("hex");
        const publisherContentHash = createHash("sha256")
          .update(publisherText, "utf8")
          .digest("hex");
        let publisherExtractionId!: string;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into publisher_companies (id, name)
              values (${publisherCompanyId}, 'Collision publisher')
            `;
            yield* sql`
              insert into publisher_subscriptions (
                id, publisher_company_id, name, created_by_user_id
              ) values (${subscriptionId}, ${publisherCompanyId}, 'Collision publication', ${fixture.userId})
            `;
            yield* sql`
              insert into publisher_issues (
                id, subscription_id, title, status,
                created_by_user_id
              ) values (
                ${publisherIssueId}, ${subscriptionId}, 'Collision issue', 'draft',
                ${fixture.userId}
              )
            `;
            yield* sql`
              insert into brief_documents (
                id, issue_id, title, original_file_name, object_key, media_type,
                byte_size, sha256_hex, upload_completed_at, created_by_user_id
              ) values (
                ${publisherDocumentId}, ${publisherIssueId}, 'Publisher collision document',
                'collision.pdf', ${`collision/${publisherDocumentId}.pdf`}, 'application/pdf',
                1, ${"b".repeat(64)}, now(), ${fixture.userId}
              )
            `;
            const [extraction] = yield* sql<{ readonly id: string }>`
              insert into jobs (kind, payload)
              values ('extract_pdf_text', '{}'::jsonb)
              returning id::text
            `;
            const extractions = yield* sql<{ readonly id: string }>`
              insert into brief_document_extractions (
                brief_document_id, input_sha256_hex, pages, extracted_char_count, created_by_job_id
              ) values (
                ${publisherDocumentId}, ${"b".repeat(64)},
                ${JSON.stringify([{ pageNumber: 1, text: publisherText }])}::jsonb,
                ${publisherText.length}, ${extraction!.id}
              )
              returning id::text
            `;
            publisherExtractionId = extractions[0]!.id;
            yield* sql`
              insert into brief_document_versions (
                id, brief_document_id, publisher_extraction_id, content_hash, language, canonical_text,
                text_char_count, page_ranges
              ) values (
                ${publicDocumentId}, ${publisherDocumentId}, ${extractions[0]!.id}, ${publisherContentHash}, 'english',
                ${publisherText}, ${publisherText.length},
                '[{"pageNumber":1,"charStart":0,"charEnd":24}]'::jsonb
              )
            `;
            yield* sql`
              update brief_documents
              set current_version_id = ${publicDocumentId}
              where id = ${publisherDocumentId}
            `;
            yield* sql`
              update publisher_issues
              set status = 'published', publication_at = now(), published_at = now()
              where id = ${publisherIssueId}
            `;
            yield* sql`
              insert into public_source_raw_artifacts (
                id, source_id, canonical_url, fetched_at, media_type, body, body_hash
              ) values (
                ${rawArtifactId}, ${sourceId}, ${canonicalUrl}, now(), 'text/html',
                ${text}, ${publicContentHash}
              )
            `;
            yield* sql`
              insert into public_source_documents (
                document_id, source_id, canonical_url, title, published_at,
                discovered_at, fetched_at, language, document_type, text,
                text_char_count, content_hash, raw_artifact_id
              ) values (
                ${publicDocumentId}, ${sourceId}, ${canonicalUrl}, 'Public collision document', now(),
                now(), now(), 'en', 'article', ${text}, ${text.length}, ${publicContentHash}, ${rawArtifactId}
              )
            `;
          }),
        );
        return {
          sourceId,
          subscriptionId,
          publicDocumentId,
          publisherIssueId,
          publisherDocumentId,
          publisherExtractionId,
          publicContentHash,
          publisherContentHash,
          canonicalUrl,
        };
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    const source: FinalSourceRecord = {
      sourceKey: sourceKeyFor(fixture),
      locator: {
        kind: "document",
        sourceId: `public:${collision.sourceId}`,
        documentId: collision.publicDocumentId,
        snapshotId: collision.publicDocumentId,
        contentHash: collision.publicContentHash,
        ranges: [{ charStart: 0, charEnd: 8 }],
      },
      label: "Public collision document",
      publicProvenance: {
        documentTitle: "Public collision document",
        citationUrl: collision.canonicalUrl,
      },
      uses: [
        {
          consumerTaskId: "single-answer",
          contextOrder: 0,
          renderedTokenCount: 8,
          ranges: [{ charStart: 0, charEnd: 8 }],
        },
      ],
    };
    await runDb(
      seedSingleObservability(fixture, {
        includeAnswerMeasurement: true,
        contextSources: [
          {
            sourceKey: source.sourceKey,
            candidateId: candidateIdForSource(source),
            kind: "document",
            label: source.label,
            ranges: source.locator.kind === "document" ? source.locator.ranges : [],
            ...(source.locator.kind === "document"
              ? {
                  documentSourceId: source.locator.sourceId,
                  documentId: source.locator.documentId,
                  snapshotId: source.locator.snapshotId,
                  contentHash: source.locator.contentHash,
                }
              : {}),
          },
        ],
      }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: {
            status: "ok",
            mode: "single",
            content: `Public [[cite:${sourceKeyFor(fixture)}]]`,
            sourceMap: [source],
          },
          memory,
        }),
      ),
    ).resolves.toMatchObject({ status: "succeeded" });
    const persisted = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly snapshotId: string;
          readonly publisherExtractionId: string | null;
        }>`
          select snapshot_id as "snapshotId",
                 publisher_extraction_id::text as "publisherExtractionId"
          from assistant_message_sources
          where assistant_message_id = (select assistant_message_id from ai_runs where id = ${fixture.runId})
        `)[0]!;
      }),
    );
    expect(persisted).toEqual({
      snapshotId: collision.publicDocumentId,
      publisherExtractionId: null,
    });

    const malformed = await runDb(createFixture("document-identity-malformed"));
    const malformedMemory = await runDb(
      persistMemoryArtifact(malformed, { proposals: [], discardedCount: 0 }),
    );
    const wrongIssueId = crypto.randomUUID();
    const malformedSource: FinalSourceRecord = {
      ...source,
      sourceKey: sourceKeyFor(malformed),
      locator: {
        kind: "document",
        sourceId: `publisher:${collision.subscriptionId}` as `publisher:${string}`,
        documentId: collision.publisherDocumentId,
        snapshotId: collision.publicDocumentId,
        contentHash: collision.publisherContentHash,
        publisherExtractionId: collision.publisherExtractionId,
        publisherIssueId: wrongIssueId,
        publisherDocumentId: collision.publisherDocumentId,
        ranges: [{ charStart: 0, charEnd: 8 }],
      },
      publicProvenance: {
        sourceName: "Collision publisher",
        issueTitle: "Collision issue",
        documentTitle: "Publisher collision document",
        citationUrl: `/v1/issues/${wrongIssueId}/documents/${collision.publisherDocumentId}/content`,
        publishedAt: new Date().toISOString(),
      },
    };
    await runDb(
      seedSingleObservability(malformed, {
        includeAnswerMeasurement: true,
        contextSources: [
          {
            sourceKey: malformedSource.sourceKey,
            candidateId: candidateIdForSource(malformedSource),
            kind: "document",
            label: malformedSource.label,
            ranges:
              malformedSource.locator.kind === "document" ? malformedSource.locator.ranges : [],
            ...(malformedSource.locator.kind === "document"
              ? {
                  documentSourceId: malformedSource.locator.sourceId,
                  publisherIssueId: collision.publisherIssueId,
                  publisherDocumentId: malformedSource.locator.publisherDocumentId,
                }
              : {}),
            documentId: collision.publisherDocumentId,
            snapshotId: collision.publicDocumentId,
            contentHash: collision.publisherContentHash,
            publisherExtractionId: collision.publisherExtractionId,
          },
        ],
      }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: malformed.runId,
          expectedSmithersRunId: `ai-chat:${malformed.runId}`,
          coordinates: finalizeCoordinates,
          answer: {
            status: "ok",
            mode: "single",
            content: "Malformed publisher source",
            sourceMap: [malformedSource],
          },

          memory: malformedMemory,
        }),
      ),
    ).rejects.toThrow("publisher document identity does not match database ownership");
  });
  it("rejects tampered document attestation identity and ranges", async () => {
    const fixture = await runDb(createFixture("document-attestation-tamper"));
    const document = await runDb(createPublicExposureFixture(fixture));
    const documentLocator = {
      kind: "document" as const,
      sourceId: `public:${document.sourceId}`,
      documentId: document.documentId,
      snapshotId: document.documentId,
      contentHash: document.contentHash,
      ranges: [{ charStart: 0, charEnd: 8 }],
    };
    const source: FinalSourceRecord = {
      sourceKey: sourceKeyFor(fixture),
      locator: documentLocator,
      label: "Public exposure document",
      publicProvenance: {
        documentTitle: "Exposure document",
        citationUrl: `https://public.example/${document.documentId}`,
      },
      uses: [
        {
          consumerTaskId: "single-answer",
          contextOrder: 0,
          renderedTokenCount: 8,
          ranges: [{ charStart: 0, charEnd: 8 }],
        },
      ],
    };
    await runDb(
      seedSingleObservability(fixture, {
        includeAnswerMeasurement: true,
        contextSources: [
          {
            sourceKey: source.sourceKey,
            candidateId: candidateIdForSource(source),
            kind: "document",
            label: source.label,
            ranges: documentLocator.ranges,
            documentSourceId: documentLocator.sourceId,
            documentId: documentLocator.documentId,
            snapshotId: documentLocator.snapshotId,
            contentHash: documentLocator.contentHash,
          },
        ],
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    for (const tamperedPayload of [
      { documentId: `${document.documentId}-tampered` },
      { documentRanges: [{ charStart: 1, charEnd: 8 }] },
    ]) {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update ai_observations
            set payload = payload || ${JSON.stringify(tamperedPayload)}::jsonb
            where run_id = ${fixture.runId}
              and emitting_task = 'single-answer'
              and kind = 'source_exposure_attestation'
              and payload->>'exposureStage' = 'answer_serialized'
          `;
        }),
      );
      await expect(
        runDb(
          finalizeAiRun({
            runId: fixture.runId,
            expectedSmithersRunId: `ai-chat:${fixture.runId}`,
            coordinates: finalizeCoordinates,
            answer: {
              status: "ok",
              mode: "single",
              content: `Public [[cite:${source.sourceKey}]]`,
              sourceMap: [source],
            },
            memory,
          }),
        ),
      ).rejects.toThrow("document exposure attestation reconstruction differs");
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update ai_observations
            set payload = payload || ${JSON.stringify({
              documentId: document.documentId,
              documentRanges: documentLocator.ranges,
            })}::jsonb
            where run_id = ${fixture.runId}
              and emitting_task = 'single-answer'
              and kind = 'source_exposure_attestation'
              and payload->>'exposureStage' = 'answer_serialized'
          `;
        }),
      );
    }
  });

  it("blocks success finalization between full chat projection queries", async () => {
    const fixture = await runDb(createFixture("projection-finalization", "clarify"));
    await runDb(seedSingleObservability(fixture));
    let signalBetweenQueries!: () => void;
    const betweenQueries = new Promise<void>((resolve) => {
      signalBetweenQueries = resolve;
    });
    let releaseProjection!: () => void;
    const projectionReleased = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });

    const projection = runDbAs(
      "brief-full-chat-projection-race",
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const [chat] = yield* sql<{ readonly companyId: string }>`
              select company_id::text as "companyId"
              from chats
              where id = ${fixture.chatId}
              for share
            `;
            yield* sql`
              select pg_advisory_xact_lock(
                hashtext(${`brief:client-members:${chat!.companyId}`})
              )
            `;
            yield* sql`
              select pg_advisory_xact_lock(hashtext(${`brief:ai-chat:${fixture.chatId}`}))
            `;
            const [messageState] = yield* sql<{
              readonly messageCount: number;
              readonly assistantCount: number;
            }>`
              select count(*)::int as "messageCount",
                     count(*) filter (where author = 'assistant')::int as "assistantCount"
              from chat_messages
              where chat_id = ${fixture.chatId}
            `;
            yield* Effect.sync(signalBetweenQueries);
            yield* Effect.promise(() => projectionReleased);
            const [runState] = yield* sql<{
              readonly finished: boolean;
              readonly assistantMessageId: string | null;
            }>`
              select finished_at is not null as finished,
                     assistant_message_id::text as "assistantMessageId"
              from ai_runs
              where id = ${fixture.runId}
            `;
            return { ...messageState!, ...runState! };
          }),
        );
      }),
    );
    await betweenQueries;

    const projectionMemory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );

    const finalization = runDbAs(
      "brief-finalization-behind-full-projection",
      finalizeAiRun({
        runId: fixture.runId,
        expectedSmithersRunId: `ai-chat:${fixture.runId}`,
        coordinates: finalizeCoordinates,
        answer: {
          status: "ok",
          mode: "clarification",
          content: "Clarify the request",
          sourceMap: [],
        },
        memory: projectionMemory,
      }),
    );
    try {
      await waitForDatabaseLock("brief-finalization-behind-full-projection");
    } finally {
      releaseProjection();
    }

    await expect(projection).resolves.toEqual({
      messageCount: 1,
      assistantCount: 0,
      finished: false,
      assistantMessageId: null,
    });
    await expect(finalization).resolves.toMatchObject({
      status: "succeeded",
      alreadyTerminal: false,
    });
    const stableAfter = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [state] = yield* sql<{
          readonly assistantCount: number;
          readonly finished: boolean;
          readonly assistantMessageId: string | null;
        }>`
          select
            (
              select count(*)::int
              from chat_messages
              where chat_id = ${fixture.chatId} and author = 'assistant'
            ) as "assistantCount",
            finished_at is not null as finished,
            assistant_message_id::text as "assistantMessageId"
          from ai_runs
          where id = ${fixture.runId}
        `;
        return state!;
      }),
    );
    expect(stableAfter).toMatchObject({
      assistantCount: 1,
      finished: true,
      assistantMessageId: expect.any(String),
    });
  });

  it("orders real reset before finalization with no answer or memory publication", async () => {
    const resetProductChat = await loadResetProductChat();
    const fixture = await runDb(createFixture("archive-before-finalization"));
    await runDb(seedSingleObservability(fixture));
    const replacementChatId = crypto.randomUUID();
    const memory = await runDb(
      persistMemoryArtifact(fixture, {
        proposals: [{ kind: "fact", content: "Must stay unpublished" }],
        discardedCount: 0,
      }),
    );
    let signalLaneHeld!: () => void;
    const laneHeld = new Promise<void>((resolve) => {
      signalLaneHeld = resolve;
    });
    let releaseLane!: () => void;
    const laneReleased = new Promise<void>((resolve) => {
      releaseLane = resolve;
    });
    const holder = runDbAs(
      "brief-archive-before-finalization-holder",
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(
                hashtext(${`brief:user-memory:${fixture.userId}`})
              )
            `;
            yield* Effect.sync(signalLaneHeld);
            yield* Effect.promise(() => laneReleased);
          }),
        );
      }),
    );
    await laneHeld;

    const reset = runDbAs(
      "brief-archive-before-finalization-reset",
      resetProductChat(
        { mode: "demo", userId: fixture.userId, organizationId: null },
        fixture.chatId,
        replacementChatId,
      ),
    );
    await waitForDatabaseLock("brief-archive-before-finalization-reset");
    const finalization = runDbAs(
      "brief-archive-before-finalization-finalize",
      Effect.exit(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "late answer", sourceMap: [] },
          memory,
        }),
      ),
    );
    try {
      await waitForDatabaseLock("brief-archive-before-finalization-finalize");
    } finally {
      releaseLane();
    }
    await holder;
    await expect(reset).resolves.toEqual({
      kind: "created",
      archivedChatId: fixture.chatId,
      replacementChatId,
    });
    await expect(finalization).resolves.toMatchObject({ _tag: "Failure" });

    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [run] = yield* sql<{
          readonly errorCode: string | null;
          readonly finishedAt: Date | null;
          readonly failedAt: Date | null;
          readonly assistantMessageId: string | null;
        }>`
          select error_code as "errorCode", finished_at as "finishedAt", failed_at as "failedAt",
                 assistant_message_id::text as "assistantMessageId"
          from ai_runs where id = ${fixture.runId}
        `;
        const [counts] = yield* sql<{
          readonly assistants: number;
          readonly memories: number;
          readonly replacementMessages: number;
          readonly replacementRuns: number;
        }>`
          select
            (
              select count(*)::int
              from chat_messages
              where chat_id = ${fixture.chatId} and author = 'assistant'
            ) as assistants,
            (
              select count(*)::int
              from user_memories
              where user_id = ${fixture.userId}
            ) as memories,
            (
              select count(*)::int
              from chat_messages
              where chat_id = ${replacementChatId}
            ) as "replacementMessages",
            (
              select count(*)::int
              from ai_runs
              where chat_id = ${replacementChatId}
            ) as "replacementRuns"
        `;
        return { run, counts };
      }),
    );
    expect(state.run).toMatchObject({
      errorCode: "chat_archived",
      finishedAt: null,
      failedAt: expect.any(Date),
      assistantMessageId: null,
    });
    expect(state.counts).toEqual({
      assistants: 0,
      memories: 0,
      replacementMessages: 0,
      replacementRuns: 0,
    });
  });

  it("commits final answer and memory wholly before real reset archives the chat", async () => {
    const resetProductChat = await loadResetProductChat();
    const fixture = await runDb(createFixture("finalization-before-archive", "clarify"));
    await runDb(seedSingleObservability(fixture));
    const memory = await runDb(
      persistMemoryArtifact(fixture, {
        proposals: [{ kind: "preference", content: "Keep complete results" }],
        discardedCount: 0,
      }),
    );
    const replacementChatId = crypto.randomUUID();
    let signalLaneHeld!: () => void;
    const laneHeld = new Promise<void>((resolve) => {
      signalLaneHeld = resolve;
    });
    let releaseLane!: () => void;
    const laneReleased = new Promise<void>((resolve) => {
      releaseLane = resolve;
    });
    const holder = runDbAs(
      "brief-finalization-before-archive-holder",
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(
                hashtext(${`brief:user-memory:${fixture.userId}`})
              )
            `;
            yield* Effect.sync(signalLaneHeld);
            yield* Effect.promise(() => laneReleased);
          }),
        );
      }),
    );
    await laneHeld;

    const finalization = runDbAs(
      "brief-finalization-before-archive-finalize",
      finalizeAiRun({
        runId: fixture.runId,
        expectedSmithersRunId: `ai-chat:${fixture.runId}`,
        coordinates: finalizeCoordinates,
        answer: {
          status: "ok",
          mode: "clarification",
          content: "Complete before archive",
          sourceMap: [],
        },
        memory,
      }),
    );
    await waitForDatabaseLock("brief-finalization-before-archive-finalize");
    const reset = runDbAs(
      "brief-finalization-before-archive-reset",
      resetProductChat(
        { mode: "demo", userId: fixture.userId, organizationId: null },
        fixture.chatId,
        replacementChatId,
      ),
    );
    try {
      await waitForDatabaseLock("brief-finalization-before-archive-reset");
    } finally {
      releaseLane();
    }
    await holder;
    await expect(finalization).resolves.toMatchObject({
      status: "succeeded",
      alreadyTerminal: false,
      memory: { created: 1, updated: 0 },
    });
    await expect(reset).resolves.toEqual({
      kind: "created",
      archivedChatId: fixture.chatId,
      replacementChatId,
    });

    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [run] = yield* sql<{
          readonly errorCode: string | null;
          readonly finishedAt: Date | null;
          readonly failedAt: Date | null;
          readonly assistantMessageId: string | null;
          readonly assistantContent: string | null;
        }>`
          select run.error_code as "errorCode",
                 run.finished_at as "finishedAt",
                 run.failed_at as "failedAt",
                 run.assistant_message_id::text as "assistantMessageId",
                 assistant.content as "assistantContent"
          from ai_runs run
          left join chat_messages assistant on assistant.id = run.assistant_message_id
          where run.id = ${fixture.runId}
        `;
        const [counts] = yield* sql<{
          readonly assistants: number;
          readonly memories: number;
          readonly revisions: number;
          readonly replacementMessages: number;
          readonly replacementRuns: number;
          readonly archived: boolean;
        }>`
          select
            (
              select count(*)::int
              from chat_messages
              where chat_id = ${fixture.chatId} and author = 'assistant'
            ) as assistants,
            (
              select count(*)::int
              from user_memories
              where user_id = ${fixture.userId}
            ) as memories,
            (
              select count(*)::int
              from user_memory_revisions revisions
              join user_memories memories on memories.id = revisions.memory_id
              where memories.user_id = ${fixture.userId}
            ) as revisions,
            (
              select count(*)::int
              from chat_messages
              where chat_id = ${replacementChatId}
            ) as "replacementMessages",
            (
              select count(*)::int
              from ai_runs
              where chat_id = ${replacementChatId}
            ) as "replacementRuns",
            (
              select archived_at is not null
                and archived_by_user_id = ${fixture.userId}
                and replaced_by_chat_id = ${replacementChatId}
              from chats
              where id = ${fixture.chatId}
            ) as archived
        `;
        return { run, counts };
      }),
    );
    expect(state.run).toMatchObject({
      errorCode: null,
      finishedAt: expect.any(Date),
      failedAt: null,
      assistantMessageId: expect.any(String),
      assistantContent: "Complete before archive",
    });
    expect(state.counts).toEqual({
      assistants: 1,
      memories: 1,
      revisions: 1,
      replacementMessages: 0,
      replacementRuns: 0,
      archived: true,
    });
  });

  it("linearizes an export message snapshot before a concurrently finishing answer", async () => {
    const fixture = await runDb(createFixture("export-finalization", "clarify"));
    await runDb(seedSingleObservability(fixture));
    const exportId = crypto.randomUUID();
    let signalSnapshotCaptured!: () => void;
    const snapshotCaptured = new Promise<void>((resolve) => {
      signalSnapshotCaptured = resolve;
    });
    let releaseAcceptance!: () => void;
    const acceptanceReleased = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    const acceptance = runDbAs(
      "brief-export-message-snapshot-holder",
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(
                hashtext(${`brief:client-members:${fixture.companyId}`})
              )
            `;
            const messageIds = yield* sql<{ readonly id: string }>`
              select id::text
              from chat_messages
              where chat_id = ${fixture.chatId}
              order by created_at, id
            `;
            yield* sql`
              insert into export_requests (
                id, requester_user_id, scope_kind, scope_id,
                authorization_snapshot, idempotency_key
              ) values (
                ${exportId}, ${fixture.userId}, 'user_chats', 'me',
                ${sql.json({
                  version: 1,
                  authorizedAt: new Date().toISOString(),
                  requesterUserId: fixture.userId,
                  scopeKind: "user_chats",
                  scopeId: "me",
                  role: "self",
                  clientCompanyIds: [fixture.companyId],
                  accessIds: [],
                  issueIds: [],
                  documentIds: [],
                  chatIds: [fixture.chatId],
                  chatMessageIds: messageIds.map((message) => message.id),
                })},
                ${`export-finalization-${exportId}`}
              )
            `;
            yield* Effect.sync(signalSnapshotCaptured);
            yield* Effect.promise(() => acceptanceReleased);
            return messageIds.map((message) => message.id);
          }),
        );
      }),
    );
    await snapshotCaptured;

    const exportMemory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );

    const finalization = runDbAs(
      "brief-finalization-behind-export-snapshot",
      finalizeAiRun({
        runId: fixture.runId,
        expectedSmithersRunId: `ai-chat:${fixture.runId}`,
        coordinates: finalizeCoordinates,
        answer: {
          status: "ok",
          mode: "clarification",
          content: "Clarify after export acceptance",
          sourceMap: [],
        },
        memory: exportMemory,
      }),
    );
    try {
      await waitForDatabaseLock("brief-finalization-behind-export-snapshot");
    } finally {
      releaseAcceptance();
    }
    const capturedMessageIds = await acceptance;
    await expect(finalization).resolves.toMatchObject({ status: "succeeded" });

    const after = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [row] = yield* sql<{
          readonly assistantMessageId: string;
          readonly snapshottedMessageIds: string[];
        }>`
          select run.assistant_message_id::text as "assistantMessageId",
                 array(
                   select jsonb_array_elements_text(
                     request.authorization_snapshot->'chatMessageIds'
                   )
                 ) as "snapshottedMessageIds"
          from ai_runs run
          cross join export_requests request
          where run.id = ${fixture.runId} and request.id = ${exportId}
        `;
        return row!;
      }),
    );
    expect(capturedMessageIds).toEqual([fixture.userMessageId]);
    expect(after.snapshottedMessageIds).toEqual(capturedMessageIds);
    expect(after.snapshottedMessageIds).not.toContain(after.assistantMessageId);
  });

  it("serializes fatal terminal failure on the chat execution lane", async () => {
    const fixture = await runDb(createFixture("failure-execution-lane"));
    let signalLaneHeld!: () => void;
    const laneHeld = new Promise<void>((resolve) => {
      signalLaneHeld = resolve;
    });
    let releaseLane!: () => void;
    const laneReleased = new Promise<void>((resolve) => {
      releaseLane = resolve;
    });
    const holder = runDbAs(
      "brief-failure-lane-holder",
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(hashtext(${`brief:ai-chat:${fixture.chatId}`}))
            `;
            yield* Effect.sync(signalLaneHeld);
            yield* Effect.promise(() => laneReleased);
          }),
        );
      }),
    );
    await laneHeld;
    const failure = runDbAs(
      "brief-failure-behind-chat-projection",
      failAiRun(fixture.runId, "answer_failed"),
    );
    try {
      await waitForDatabaseLock("brief-failure-behind-chat-projection");
    } finally {
      releaseLane();
    }
    await holder;
    await expect(failure).resolves.toMatchObject({
      status: "failed",
      code: "answer_failed",
      alreadyTerminal: false,
    });
  });

  it("applies memory on controlled failure and fatal failure remains memory-free", async () => {
    const controlled = await runDb(createFixture("controlled-failure"));
    await runDb(
      seedSingleObservability(controlled, {
        includeAnswerMeasurement: false,
        includeAnswerContext: false,
      }),
    );
    const controlledMemory = await runDb(
      persistMemoryArtifact(controlled, {
        proposals: [{ kind: "preference", content: "Prefers French" }],
        discardedCount: 0,
      }),
    );
    const result = await runDb(
      finalizeAiRun({
        runId: controlled.runId,
        expectedSmithersRunId: `ai-chat:${controlled.runId}`,
        coordinates: finalizeCoordinates,
        answer: { status: "failed", code: "answer_failed", retryable: false },
        memory: controlledMemory,
      }),
    );
    expect(result).toMatchObject({ status: "failed", code: "answer_failed", retryable: false });

    const fatal = await runDb(createFixture("fatal-failure"));
    await runDb(failAiRun(fatal.runId, "memory_extraction_failed", false));
    await runDb(failAiRun(fatal.runId, "answer_failed"));
    const afterTerminal = await runDb(
      Effect.flip(
        appendAiRunEvent({
          runId: fatal.runId,
          emissionKey: "text_delta:late:0:0",
          event: { type: "text_delta", delta: "late" },
        }),
      ),
    );
    expect(String(afterTerminal)).toContain("cannot append event after terminal run");
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{
          readonly runId: string;
          readonly memoryCount: number;
          readonly keys: string[];
          readonly retryable: boolean | null;
        }>`
          select
            runs.id::text as "runId",
            runs.retryable,
            (select count(*)::int from user_memories where user_id = runs.initiating_user_id) as "memoryCount",
            array(select emission_key from ai_run_events where run_id = runs.id order by seq) as keys
          from ai_runs runs
          where runs.id in (${controlled.runId}, ${fatal.runId})
          order by runs.id
        `;
        return rows;
      }),
    );
    const controlledState = state.find((row) => row.runId === controlled.runId)!;
    const fatalState = state.find((row) => row.runId === fatal.runId)!;
    expect(controlledState.memoryCount).toBe(1);
    expect(controlledState.retryable).toBe(false);
    expect(controlledState.keys).toEqual([
      "usage:request:model:plan-turn:0:0:0",
      "usage:request:model:single-retrieve-internal:0:0:0",
      "usage:request:model:single-retrieve-internal:0:0:1",
      "usage:request:model:single-retrieve-web:0:0:0",
      "usage:request:model:memory-extract:0:1:0",
      "memory_updated",
      "usage:run",
      "activity:answer_generation:failed",
      "terminal",
    ]);
    expect(fatalState.memoryCount).toBe(0);
    expect(fatalState.retryable).toBe(false);
    expect(fatalState.keys).toEqual(["usage:run", "activity:saved_context:failed", "terminal"]);
  });

  it("binds failed answer context to the measure task's own retry coordinates", async () => {
    const fixture = await runDb(createFixture("failed-context-independent-retries"));
    await runDb(
      seedFailedSingleAnswerObservability(fixture, {
        answerAttempt: 3,
        measureLoopIteration: 1,
        measureAttempt: 1,
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );

    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "failed", code: "answer_failed", retryable: false },
          memory,
        }),
      ),
    ).resolves.toMatchObject({
      status: "failed",
      code: "answer_failed",
      alreadyTerminal: false,
    });
  });

  it("binds a compacted direct failed answer to the terminal compact measurement", async () => {
    const fixture = await runDb(createFixture("failed-context-direct-compacted"));
    const initialLedger = {
      ...failedDirectContextLedger("5".repeat(64)),
      inputTokens: 7000,
    };
    const compactedLedger = failedDirectContextLedger("6".repeat(64));
    await runDb(
      seedFailedCompactedContext(fixture, {
        answerTaskId: "single-answer",
        answerAttempt: 4,
        initialLedger,
        compactedLedger,
        initialAttempt: 5,
        compactedLoopIteration: 0,
        compactedAttempt: 0,
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );

    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "failed", code: "answer_failed", retryable: false },
          memory,
        }),
      ),
    ).resolves.toMatchObject({
      status: "failed",
      code: "answer_failed",
      alreadyTerminal: false,
    });
  });

  it("binds a compacted topic failed answer to its topic compact measurement", async () => {
    const fixture = await runDb(createFixture("failed-context-topic-compacted", "fanout"));
    const initialLedger = {
      ...failedTopicContextLedger("7".repeat(64)),
      inputTokens: 7000,
    };
    const compactedLedger = failedTopicContextLedger("8".repeat(64));
    await runDb(
      seedFailedCompactedContext(fixture, {
        answerTaskId: "topic-t1-answer",
        answerAttempt: 5,
        initialLedger,
        compactedLedger,
        initialAttempt: 5,
        compactedLoopIteration: 0,
        compactedAttempt: 0,
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );

    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "failed", code: "topic_answer_failed", retryable: false },
          memory,
        }),
      ),
    ).resolves.toMatchObject({
      status: "failed",
      code: "topic_answer_failed",
      alreadyTerminal: false,
    });
  });

  it("rejects failed answer context with the wrong measure owner, consumer, or latest row", async () => {
    for (const variant of ["task", "consumer", "latest", "newer-consumer", "newer-task"] as const) {
      const fixture = await runDb(createFixture(`failed-context-${variant}`));
      await runDb(
        seedFailedSingleAnswerObservability(fixture, {
          answerAttempt: 3,
          measureLoopIteration: 0,
          measureAttempt: 1,
        }),
      );
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          if (variant === "task") {
            yield* sql`
              update ai_observations
              set emitting_task = 'topic-t1-measure'
              where run_id = ${fixture.runId}
                and observation_key = 'fixture:failed-answer:context-measurement'
            `;
          } else if (variant === "consumer") {
            yield* sql`
              update ai_observations
              set payload = jsonb_set(payload, '{consumerTaskId}', '"topic-t1-answer"'::jsonb)
              where run_id = ${fixture.runId}
                and observation_key = 'fixture:failed-answer:context-measurement'
            `;
          } else if (variant === "latest") {
            yield* insertAiObservation({
              runId: fixture.runId,
              chatId: fixture.chatId,
              emittingTask: "single-measure",
              loopIteration: 0,
              attempt: 2,
              observationKey: "fixture:failed-answer:later-context-measurement",
              kind: "context_measurement",
              payload: {
                consumerTaskId: "single-answer",
                mandatoryInputTokens: 10,
                discretionaryInputTokens: 0,
                totalInputTokens: 10,
                requestedOutputTokens: 2048,
                usableInputTokens: 6144,
                contextWindow: 8192,
                status: "ready",
                compactionRan: false,
                compactionFeedback: [],
                restrictedContextLedger: failedDirectContextLedger("7".repeat(64)),
              },
            });
          } else {
            yield* insertAiObservation({
              runId: fixture.runId,
              chatId: fixture.chatId,
              emittingTask: variant === "newer-task" ? "topic-t1-measure" : "single-measure",
              loopIteration: 1,
              attempt: 0,
              observationKey: `fixture:failed-answer:newer-${variant}`,
              kind: "context_measurement",
              payload: {
                consumerTaskId: variant === "newer-consumer" ? "topic-t1-answer" : "single-answer",
                mandatoryInputTokens: 10,
                discretionaryInputTokens: 0,
                totalInputTokens: 10,
                requestedOutputTokens: 2048,
                usableInputTokens: 6144,
                contextWindow: 8192,
                status: "ready",
                compactionRan: false,
                compactionFeedback: [],
                restrictedContextLedger: failedDirectContextLedger("7".repeat(64)),
              },
            });
          }
        }),
      );
      const memory = await runDb(
        persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
      );

      await expect(
        runDb(
          finalizeAiRun({
            runId: fixture.runId,
            expectedSmithersRunId: `ai-chat:${fixture.runId}`,
            coordinates: finalizeCoordinates,
            answer: { status: "failed", code: "answer_failed", retryable: false },
            memory,
          }),
        ),
      ).rejects.toThrow(
        /path-specific context measurement|context ledger differs|context path measurement consumer|foreign measure owner/u,
      );
    }
  });

  it.each(["direct", "topic", "synthesis"] as const)(
    "finalizes an operation-shaped compacted %s answer",
    async (label) => {
      const fixture = await runDb(
        createFixture(`successful-compacted-${label}`, label === "direct" ? "single" : "fanout"),
      );
      if (label === "direct") {
        const initialLedger = failedDirectContextLedger("a".repeat(64));
        const compactedLedger = failedDirectContextLedger("b".repeat(64));
        await runDb(
          seedFailedCompactedContext(fixture, {
            answerTaskId: "single-answer",
            answerAttempt: 0,
            initialLedger,
            compactedLedger,
            initialAttempt: 0,
            answerRepairConsumed: true,
            compactedLoopIteration: 1,
            compactedAttempt: 0,
          }),
        );
        await runDb(
          insertProviderMeasurementAndUsage(fixture, {
            taskId: "single-answer",
            agentRole: "direct_answer",
            loopIteration: 0,
            attempt: 0,
            requestSha256Hex: compactedLedger.requestSha256Hex,
            repairConsumed: true,
          }),
        );
      } else {
        await runDb(seedFanoutFailureBase(fixture));
        const packetLedger = failedSynthesisContextLedger("8".repeat(64));
        for (const topicId of ["t1", "t2"] as const) {
          const topicTaskId = `topic-${topicId}-answer`;
          const topicLedger = {
            ...failedTopicContextLedger(`${topicId === "t1" ? "1" : "2"}`.repeat(64)),
            topicId,
            question: topicId === "t1" ? "first topic" : "second topic",
          };
          const compactedTopicLedger = {
            ...topicLedger,
            requestSha256Hex: `${topicId === "t1" ? "3" : "4"}`.repeat(64),
          };
          await runDb(
            insertProviderMeasurementAndUsage(fixture, {
              taskId: topicTaskId,
              agentRole: "topic_answer",
              loopIteration: 0,
              attempt: 0,
              requestSha256Hex: compactedTopicLedger.requestSha256Hex,
            }),
          );
          await runDb(
            insertSuccessfulCompactedContextPath(fixture, {
              consumerTaskId: topicTaskId,
              topicId,
              initialTaskId: `topic-${topicId}-measure`,
              compactedTaskId:
                topicId === "t1" && label === "topic"
                  ? `topic-${topicId}-compact-measure`
                  : `topic-${topicId}-fallback-measure`,
              initialLedger: topicLedger,
              compactedLedger: compactedTopicLedger,
            }),
          );
          await runDb(
            insertAiObservation({
              runId: fixture.runId,
              chatId: fixture.chatId,
              emittingTask: topicTaskId,
              loopIteration: 0,
              attempt: 0,
              observationKey: `fixture:${topicTaskId}:topic-packet`,
              kind: "topic_packet",
              payload: {
                topicId,
                status: "partial",
                sourceKeys: [],
                claimCount: 0,
                gapCount: 0,
                packetSha256Hex:
                  topicId === "t1"
                    ? packetLedger.packets[0]!.packetSha256Hex
                    : packetLedger.packets[1]!.packetSha256Hex,
              },
            }),
          );
        }
        await runDb(
          insertProviderMeasurementAndUsage(fixture, {
            taskId: "fanout-synthesis",
            agentRole: "synthesis",
            loopIteration: 0,
            attempt: 0,
            requestSha256Hex: packetLedger.requestSha256Hex,
          }),
        );
        await runDb(
          insertSuccessfulCompactedContextPath(fixture, {
            consumerTaskId: "fanout-synthesis",
            initialTaskId: "fanout-synthesis-measure",
            compactedTaskId:
              label === "synthesis"
                ? "fanout-synthesis-compact-measure"
                : "fanout-synthesis-fallback-measure",
            initialLedger: {
              ...packetLedger,
              requestSha256Hex: "7".repeat(64),
            },
            compactedLedger: packetLedger,
          }),
        );
      }
      const memory = await runDb(
        persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
      );
      await expect(
        runDb(
          finalizeAiRun({
            runId: fixture.runId,
            expectedSmithersRunId: `ai-chat:${fixture.runId}`,
            coordinates: finalizeCoordinates,
            answer:
              label === "direct"
                ? {
                    status: "ok",
                    mode: "single",
                    content: "Compacted direct answer",
                    sourceMap: [],
                  }
                : {
                    status: "ok",
                    mode: "synthesis",
                    content: "Compacted synthesis answer",
                    sourceMap: [],
                  },
            memory,
          }),
        ),
      ).resolves.toMatchObject({ status: "succeeded", alreadyTerminal: false });
    },
  );

  it.each([
    { label: "absent", mutation: "absent", accepted: true },
    { label: "true", mutation: "true", accepted: true },
    { label: "false", mutation: "false", accepted: true },
    { label: "string", mutation: "string", accepted: false },
    { label: "number", mutation: "number", accepted: false },
    { label: "null", mutation: "null", accepted: false },
    { label: "unknown", mutation: "unknown", accepted: false },
  ] as const)(
    "enforces strict repairConsumed shape (%s)",
    async ({ label, mutation, accepted }) => {
      const fixture = await runDb(createFixture(`repair-consumed-${label}`));
      await runDb(seedSingleObservability(fixture));
      if (mutation !== "absent") {
        await runDb(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            if (mutation === "unknown") {
              yield* sql`
              update ai_observations
              set payload = payload || '{"unexpectedRepairField":true}'::jsonb
              where run_id = ${fixture.runId}
                and observation_key = 'fixture:single-answer:measurement'
            `;
            } else {
              const value =
                mutation === "true"
                  ? "true"
                  : mutation === "false"
                    ? "false"
                    : mutation === "null"
                      ? "null"
                      : mutation === "number"
                        ? "1"
                        : '"yes"';
              yield* sql`
              update ai_observations
              set payload = jsonb_set(payload, '{repairConsumed}', ${value}::jsonb)
              where run_id = ${fixture.runId}
                and observation_key = 'fixture:single-answer:measurement'
            `;
            }
          }),
        );
      }
      const memory = await runDb(
        persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
      );
      const terminal = runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "Repair shape", sourceMap: [] },
          memory,
        }),
      );
      if (accepted) {
        await expect(terminal).resolves.toMatchObject({ status: "succeeded" });
      } else {
        await expect(terminal).rejects.toThrow(/provider request measurement|strict|unknown/u);
      }
    },
  );

  it("selects compact over an earlier tied measurement regardless of insertion order", async () => {
    const fixture = await runDb(createFixture("tied-compaction-measurements"));
    const initialLedger = failedDirectContextLedger("a".repeat(64));
    const compactedLedger = failedDirectContextLedger("b".repeat(64));
    await runDb(
      seedFailedCompactedContext(fixture, {
        answerTaskId: "single-answer",
        answerAttempt: 0,
        initialLedger,
        compactedLedger,
        initialAttempt: 0,
        compactedLoopIteration: 0,
        compactedAttempt: 0,
        answerRepairConsumed: true,
        compactedBeforeInitial: true,
      }),
    );
    await runDb(
      insertProviderMeasurementAndUsage(fixture, {
        taskId: "single-answer",
        agentRole: "direct_answer",
        loopIteration: 0,
        attempt: 0,
        requestSha256Hex: compactedLedger.requestSha256Hex,
        repairConsumed: true,
      }),
    );
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "Tied compact", sourceMap: [] },
          memory,
        }),
      ),
    ).resolves.toMatchObject({ status: "succeeded", alreadyTerminal: false });
  });

  it.each([
    { mutation: "subset", accepted: true },
    { mutation: "reorder", accepted: false },
    { mutation: "add", accepted: false },
    { mutation: "mutate", accepted: false },
  ] as const)(
    "binds compacted selected conversation to immutable turn bytes (%s)",
    async ({ mutation, accepted }) => {
      const fixture = await runDb(createFixture(`conversation-compaction-${mutation}`));
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`update ai_runs set finished_at = now() where id = ${fixture.runId}`;
        }),
      );
      const priorOne = await runDb(createNextRun(fixture, "Historical question one"));
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`update ai_runs set finished_at = now() where id = ${priorOne.runId}`;
        }),
      );
      const priorTwo = await runDb(createNextRun(fixture, "Historical question two"));
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update ai_runs
            set finished_at = now()
            where id in (${priorOne.runId}, ${priorTwo.runId})
          `;
        }),
      );
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update ai_runs
            set finished_at = null
            where id = ${fixture.runId}
          `;
        }),
      );
      const history = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const first = yield* sql<{ readonly id: string }>`
            insert into chat_messages (chat_id, author, content)
            values (${fixture.chatId}, 'assistant', 'Historical answer one')
            returning id::text
          `;
          const second = yield* sql<{ readonly id: string }>`
            insert into chat_messages (chat_id, author, content)
            values (${fixture.chatId}, 'assistant', 'Historical answer two')
            returning id::text
          `;
          return { firstAssistantId: first[0]!.id, secondAssistantId: second[0]!.id };
        }),
      );
      const baselineConversation = [
        {
          kind: "complete" as const,
          turnId: priorOne.runId,
          userMessageId: priorOne.userMessageId,
          assistantMessageId: history.firstAssistantId,
        },
        {
          kind: "complete" as const,
          turnId: priorTwo.runId,
          userMessageId: priorTwo.userMessageId,
          assistantMessageId: history.secondAssistantId,
        },
      ];
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update ai_observations
            set payload = jsonb_set(
              payload,
              '{relevantTurnIds}',
              ${JSON.stringify(baselineConversation.map((entry) => entry.turnId))}::jsonb
            )
            where run_id = ${fixture.runId}
              and kind = 'turn_plan'
          `;
        }),
      );
      const compactedConversation =
        mutation === "subset"
          ? baselineConversation.slice(0, 1)
          : mutation === "reorder"
            ? [baselineConversation[1]!, baselineConversation[0]!]
            : mutation === "add"
              ? [
                  ...baselineConversation,
                  { ...baselineConversation[0]!, turnId: crypto.randomUUID() },
                ]
              : [
                  {
                    ...baselineConversation[0]!,
                    assistantMessageId: crypto.randomUUID(),
                  },
                ];
      const initialLedger = {
        ...failedDirectContextLedger("a".repeat(64)),
        selectedConversation: baselineConversation,
      };
      const compactedLedger = {
        ...failedDirectContextLedger("b".repeat(64)),
        selectedConversation: compactedConversation,
      };
      await runDb(
        seedSingleObservability(fixture, {
          includeAnswerMeasurement: false,
          includeAnswerContext: false,
          selectedConversation: baselineConversation,
        }),
      );
      await runDb(
        insertProviderMeasurementAndUsage(fixture, {
          taskId: "single-answer",
          agentRole: "direct_answer",
          loopIteration: 0,
          attempt: 0,
          requestSha256Hex: compactedLedger.requestSha256Hex,
        }),
      );
      await runDb(
        insertSuccessfulCompactedContextPath(fixture, {
          consumerTaskId: "single-answer",
          initialTaskId: "single-measure",
          compactedTaskId: "single-compact-measure",
          initialLedger,
          compactedLedger,
        }),
      );
      const memory = await runDb(
        persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
      );
      const terminal = runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "Conversation subset", sourceMap: [] },
          memory,
        }),
      );
      if (accepted) {
        await expect(terminal).resolves.toMatchObject({ status: "succeeded" });
      } else {
        await expect(terminal).rejects.toThrow(/conversation|turn|subset|ledger/u);
      }
    },
  );

  it.each([
    { taskId: "single-compact-g001", agentRole: "context_compact_group", accepted: true },
    { taskId: "single-compact-g099", agentRole: "context_source_tool", accepted: true },
    { taskId: "single-fallback-g001", agentRole: "context_fallback_group", accepted: true },
    { taskId: "single-compact-g1000", agentRole: "context_compact_group", accepted: false },
    { taskId: "single-compact-g01", agentRole: "context_compact_group", accepted: false },
    { taskId: "single-compact-g000", agentRole: "context_compact_group", accepted: false },
    { taskId: "topic-t1-compact-g001", agentRole: "context_compact_group", accepted: false },
  ] as const)(
    "resolves canonical compaction group task $taskId with strict role $agentRole",
    async ({ taskId, agentRole, accepted }) => {
      const fixture = await runDb(createFixture(`compaction-group-${taskId}`));
      await runDb(seedSingleObservability(fixture));
      await runDb(
        insertProviderMeasurementAndUsage(fixture, {
          taskId,
          agentRole,
          loopIteration: 0,
          attempt: 0,
          requestSha256Hex: "c".repeat(64),
        }),
      );
      const memory = await runDb(
        persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
      );
      const terminal = runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "failed", code: "answer_failed", retryable: false },
          memory,
        }),
      );
      if (accepted) {
        await expect(terminal).resolves.toMatchObject({
          status: "failed",
          alreadyTerminal: false,
        });
      } else {
        await expect(terminal).rejects.toThrow(/foreign task owner/u);
      }
    },
  );

  it("finalizes a successful fanout general-planner evaluation without context rows", async () => {
    const fixture = await runDb(createFixture("evaluation-general-planner-no-context", "fanout"));
    await runDb(seedSingleObservability(fixture));
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    await runDb(prepareGeneralPlannerEvaluation(fixture));

    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "synthesis", content: "Evaluated", sourceMap: [] },
          memory,
        }),
      ),
    ).resolves.toMatchObject({ status: "succeeded", alreadyTerminal: false });
  });

  it("finalizes source-bearing general-planner output only with exact inspect evidence", async () => {
    const setup = async (suffix: string) => {
      const fixture = await runDb(createFixture(suffix, "single"));
      await runDb(seedSingleObservability(fixture));
      const memory = await runDb(
        persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
      );
      const source = sourceFor(fixture);
      const evidence = generalPlannerChatSourceEvidenceFor(fixture, source);
      await runDb(
        prepareGeneralPlannerEvaluation(fixture, {
          sourceExposureProofSha256Hexes: [evidence.proof],
          sourceExposureProofBindings: [
            {
              providerSerializationProofSha256Hex: evidence.proof,
              providerSerializationProofBinding: evidence.binding,
            },
          ],
        }),
      );
      await runDb(insertGeneralPlannerChatSourceExposure(fixture, source));
      return { fixture, memory, source };
    };

    const exact = await setup("evaluation-general-planner-source-exact");
    await expect(
      runDb(
        finalizeAiRun({
          runId: exact.fixture.runId,
          expectedSmithersRunId: `ai-chat:${exact.fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: {
            status: "ok",
            mode: "single",
            content: `Evaluated [[cite:${exact.source.sourceKey}]]`,
            sourceMap: [exact.source],
          },
          memory: exact.memory,
        }),
      ),
    ).resolves.toMatchObject({ status: "succeeded", alreadyTerminal: false });

    const mismatch = await setup("evaluation-general-planner-source-mismatch");
    const mismatchedSource: FinalSourceRecord = {
      ...mismatch.source,
      uses: [
        {
          ...mismatch.source.uses[0]!,
          renderedTokenCount: 1,
          ranges: [{ charStart: 0, charEnd: 1 }],
        },
      ],
    };
    await expect(
      runDb(
        finalizeAiRun({
          runId: mismatch.fixture.runId,
          expectedSmithersRunId: `ai-chat:${mismatch.fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: {
            status: "ok",
            mode: "single",
            content: `Mismatched [[cite:${mismatchedSource.sourceKey}]]`,
            sourceMap: [mismatchedSource],
          },
          memory: mismatch.memory,
        }),
      ),
    ).rejects.toThrow(/exact sanitized answer exposure/u);
  });

  it("rejects an injected general-planner evaluation context row", async () => {
    const fixture = await runDb(createFixture("evaluation-general-planner-context-row"));
    await runDb(seedSingleObservability(fixture));
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    await runDb(prepareGeneralPlannerEvaluation(fixture));
    await runDb(
      insertAiObservation({
        runId: fixture.runId,
        chatId: fixture.chatId,
        emittingTask: "evaluation-general-planner",
        loopIteration: 0,
        attempt: 0,
        observationKey: "evaluation-general-planner:context-serialized",
        kind: "context_serialized",
        payload: { consumerTaskId: "evaluation-general-planner", sourceKeys: [] },
      }),
    );

    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "Evaluated", sourceMap: [] },
          memory,
        }),
      ),
    ).rejects.toThrow(/general-planner evaluation cannot carry context rows/u);
  });

  it("keeps specialized successful output strict when context rows are missing", async () => {
    const fixture = await runDb(createFixture("specialized-missing-context"));
    await runDb(seedSingleObservability(fixture, { includeAnswerContext: false }));
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );

    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "single", content: "Answer", sourceMap: [] },
          memory,
        }),
      ),
    ).rejects.toThrow(/missing context_measurement/u);
  });

  it.each([
    { taskId: "topic-t1-answer", accepted: true },
    { taskId: "topic-t3-answer", accepted: false },
    { taskId: "topic-t4-answer", accepted: false },
  ] as const)(
    "allows only exact parsed general-planner fanout answer task %s",
    async ({ taskId, accepted }) => {
      const fixture = await runDb(
        createFixture(
          `evaluation-fanout-owner-${taskId}`,
          "fanout",
          "private_owner",
          true,
          true,
          [],
          ["t1", "t2"],
        ),
      );
      const sessionId = crypto.randomUUID();
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update ai_observations
            set emitting_task = 'evaluation-general-planner',
                observation_key = 'evaluation-general-planner:turn-plan'
            where run_id = ${fixture.runId}
              and kind = 'turn_plan'
          `;
          yield* sql`
            insert into ai_evaluation_sessions (
              id, artifact_version, golden_set_version, fixture_sha256_hex, status
            ) values (${sessionId}, 4, 4, ${"a".repeat(64)}, 'preparing')
          `;
          yield* sql`
            insert into ai_evaluation_case_runs (
              session_id, case_id, topology, ai_run_id, seed_manifest, status
            ) values (
              ${sessionId}, ${taskId}, 'general_planner', ${fixture.runId}, '{}'::jsonb, 'seeded'
            )
          `;
        }),
      );
      await runDb(
        insertProviderMeasurementAndUsage(fixture, {
          taskId: "evaluation-general-planner",
          agentRole: "evaluation_general_planner",
          loopIteration: 0,
          attempt: 0,
          requestSha256Hex: "a".repeat(64),
        }),
      );
      await runDb(
        insertAiObservation({
          runId: fixture.runId,
          chatId: fixture.chatId,
          emittingTask: "evaluation-general-planner",
          loopIteration: 0,
          attempt: 0,
          observationKey: "evaluation-general-planner:retrieval-manifest",
          kind: "retrieval_manifest",
          payload: { selectorRole: "general_planner", references: [] },
        }),
      );
      await runDb(
        insertProviderMeasurementAndUsage(fixture, {
          taskId,
          agentRole: "topic_answer",
          loopIteration: 0,
          attempt: 0,
          requestSha256Hex: "b".repeat(64),
        }),
      );
      const memory = await runDb(
        persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
      );
      const terminal = runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "failed", code: "topic_answer_failed", retryable: false },
          memory,
        }),
      );
      if (accepted) {
        await expect(terminal).resolves.toMatchObject({
          status: "failed",
          alreadyTerminal: false,
        });
      } else {
        await expect(terminal).rejects.toThrow(/foreign task owner/u);
      }
    },
  );

  it.each([
    { phase: "compact", mutation: "success", accepted: true },
    { phase: "fallback", mutation: "success", accepted: true },
    { phase: "compact", mutation: "reordered", accepted: false },
    { phase: "compact", mutation: "unproved", accepted: false },
    { phase: "compact", mutation: "forged", accepted: false },
  ] as const)(
    "finalizes a 3-to-2 %s synthesis packet compaction (%s)",
    async ({ phase, mutation, accepted }) => {
      const topicIds = ["t1", "t2", "t3"] as const;
      const fixture = await runDb(
        createFixture(`three-topic-${phase}`, "fanout", "private_owner", true, true, [], topicIds),
      );
      await runDb(seedFanoutFailureBase(fixture, topicIds));
      const fullSynthesisLedger = failedSynthesisContextLedger("7".repeat(64), topicIds);
      const compactedSynthesisLedger = {
        ...fullSynthesisLedger,
        requestSha256Hex: "8".repeat(64),
        packets:
          mutation === "reordered"
            ? [fullSynthesisLedger.packets[2]!, fullSynthesisLedger.packets[0]!]
            : mutation === "unproved"
              ? [
                  { ...fullSynthesisLedger.packets[0]!, packetSha256Hex: "f".repeat(64) },
                  fullSynthesisLedger.packets[2]!,
                ]
              : [fullSynthesisLedger.packets[0]!, fullSynthesisLedger.packets[2]!],
      };
      for (const [topicIndex, topicId] of topicIds.entries()) {
        const topicTaskId = `topic-${topicId}-answer`;
        const topicLedger = {
          ...failedTopicContextLedger(String(topicIndex + 1).repeat(64)),
          topicId,
          question:
            topicId === "t1" ? "first topic" : topicId === "t2" ? "second topic" : "third topic",
        };
        const compactedTopicLedger = {
          ...topicLedger,
          requestSha256Hex: String(topicIndex + 4).repeat(64),
        };
        await runDb(
          insertProviderMeasurementAndUsage(fixture, {
            taskId: topicTaskId,
            agentRole: "topic_answer",
            loopIteration: 0,
            attempt: 0,
            requestSha256Hex: compactedTopicLedger.requestSha256Hex,
          }),
        );
        await runDb(
          insertSuccessfulCompactedContextPath(fixture, {
            consumerTaskId: topicTaskId,
            topicId,
            initialTaskId: `topic-${topicId}-measure`,
            compactedTaskId: `topic-${topicId}-compact-measure`,
            initialLedger: topicLedger,
            compactedLedger: compactedTopicLedger,
          }),
        );
        await runDb(
          insertAiObservation({
            runId: fixture.runId,
            chatId: fixture.chatId,
            emittingTask: topicTaskId,
            loopIteration: 0,
            attempt: 0,
            observationKey: `fixture:${topicTaskId}:topic-packet`,
            kind: "topic_packet",
            payload: {
              topicId,
              status: "partial",
              sourceKeys: [],
              claimCount: 0,
              gapCount: 0,
              packetSha256Hex: fullSynthesisLedger.packets[topicIndex]!.packetSha256Hex,
            },
          }),
        );
      }
      if (mutation === "forged") {
        await runDb(
          insertAiObservation({
            runId: fixture.runId,
            chatId: fixture.chatId,
            emittingTask: "topic-t1-answer",
            loopIteration: 1,
            attempt: 0,
            observationKey: "fixture:forged-topic-packet-owner",
            kind: "topic_packet",
            payload: {
              topicId: "t3",
              status: "partial",
              sourceKeys: [],
              claimCount: 0,
              gapCount: 0,
              packetSha256Hex: fullSynthesisLedger.packets[2]!.packetSha256Hex,
            },
          }),
        );
      }
      await runDb(
        insertProviderMeasurementAndUsage(fixture, {
          taskId: "fanout-synthesis",
          agentRole: "synthesis",
          loopIteration: 0,
          attempt: 0,
          requestSha256Hex: compactedSynthesisLedger.requestSha256Hex,
        }),
      );
      await runDb(
        insertSuccessfulCompactedContextPath(fixture, {
          consumerTaskId: "fanout-synthesis",
          initialTaskId: "fanout-synthesis-measure",
          compactedTaskId: `fanout-synthesis-${phase}-measure`,
          initialLedger: fullSynthesisLedger,
          compactedLedger: compactedSynthesisLedger,
        }),
      );
      const memory = await runDb(
        persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
      );
      const terminal = runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: {
            status: "ok",
            mode: "synthesis",
            content: `3-to-2 ${phase} synthesis answer`,
            sourceMap: [],
          },
          memory,
        }),
      );
      if (accepted) {
        await expect(terminal).resolves.toMatchObject({
          status: "succeeded",
          alreadyTerminal: false,
        });
      } else {
        await expect(terminal).rejects.toThrow(
          /synthesis packet order|synthesis ledger differs|canonical packet ledger|foreign owner|topic_packet output is not bound/u,
        );
      }
    },
  );

  it.each([
    { mutation: "success", accepted: true },
    { mutation: "omitted-subset", accepted: true },
    { mutation: "omitted-foreign", accepted: false },
    { mutation: "omitted-duplicate", accepted: false },
    { mutation: "omitted-reorder", accepted: false },
    { mutation: "leak-omitted", accepted: false },
    { mutation: "drop-retained", accepted: false },
    { mutation: "tamper-retained", accepted: false },
    { mutation: "tamper-omitted", accepted: false },
  ] as const)(
    "finalizes source-bearing omitted topic packets (%s)",
    async ({ mutation, accepted }) => {
      const topicIds = ["t1", "t2", "t3"] as const;
      const fixture = await runDb(
        createFixture(
          `source-bearing-${mutation}`,
          "fanout",
          "private_owner",
          true,
          true,
          [],
          topicIds,
        ),
      );
      const sourceMessageIds = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const ids: string[] = [];
          for (const topicId of topicIds) {
            const rows = yield* sql<{ readonly id: string }>`
              insert into chat_messages (chat_id, author, content)
              values (${fixture.chatId}, 'user', ${`Evidence ${topicId}`})
              returning id::text
            `;
            ids.push(rows[0]!.id);
          }
          return ids;
        }),
      );
      const chatContentById = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const contentById = new Map<string, string>();
          for (const messageId of sourceMessageIds) {
            const rows = yield* sql<{ readonly content: string }>`
              select content
              from chat_messages
              where id = ${messageId}
                and chat_id = ${fixture.chatId}
                and author = 'user'
            `;
            if (rows[0] === undefined) throw new Error(`missing fixture chat source ${messageId}`);
            contentById.set(messageId, rows[0].content);
          }
          return contentById;
        }),
      );
      const chatContentFor = (source: FinalSourceRecord): string => {
        if (source.locator.kind !== "chat_message") return source.label ?? "";
        const content = chatContentById.get(source.locator.messageId);
        if (content === undefined)
          throw new Error(`missing fixture chat source ${source.sourceKey}`);
        return content;
      };
      const sources = sourceMessageIds.map((messageId, index) => ({
        sourceKey: sourceKeyFor(fixture, index + 1),
        locator: { kind: "chat_message" as const, messageId },
        label: `Evidence ${topicIds[index]}`,
        publicProvenance: {},
        uses: [],
      })) satisfies readonly FinalSourceRecord[];
      const omittedSource = {
        sourceKey: sourceKeyFor(fixture, 4),
        locator: { kind: "chat_message" as const, messageId: sourceMessageIds[1]! },
        label: "Evidence t2 secondary",
        publicProvenance: {},
        uses: [],
      } satisfies FinalSourceRecord;
      const sourceEntryFor = (source: FinalSourceRecord) => ({
        candidateId: candidateIdForSource(source),
        sourceKey: source.sourceKey,
        kind: "chat_message" as const,
        purpose: "provider-authored topic evidence",
        label: source.label,
        ranges: [{ charStart: 0, charEnd: chatContentFor(source).length }],
      });
      const answerSources = sources.map((source, index) => ({
        ...source,
        uses:
          index === 1
            ? []
            : [
                {
                  consumerTaskId: `topic-${topicIds[index]}-answer`,
                  topicId: topicIds[index],
                  contextOrder: 0,
                  renderedTokenCount: 3,
                  ranges: [{ charStart: 0, charEnd: chatContentFor(source).length }],
                },
              ],
      }));
      const terminalSources =
        mutation === "leak-omitted"
          ? answerSources.map((source, index) =>
              index === 1
                ? {
                    ...source,
                    uses: [
                      {
                        consumerTaskId: "topic-t2-answer",
                        topicId: "t2" as const,
                        contextOrder: 1,
                        renderedTokenCount: 3,
                        ranges: [{ charStart: 0, charEnd: chatContentFor(source).length }],
                      },
                    ],
                  }
                : source,
            )
          : mutation === "drop-retained"
            ? answerSources.filter((source) => source.sourceKey !== sources[0]!.sourceKey)
            : answerSources.filter((source) => source.uses.length > 0);
      await runDb(seedFanoutFailureBase(fixture, topicIds));
      const fullSynthesisLedger = failedSynthesisContextLedger("7".repeat(64), topicIds);
      const compactedSynthesisLedger = {
        ...fullSynthesisLedger,
        requestSha256Hex: "8".repeat(64),
        packets: [fullSynthesisLedger.packets[0]!, fullSynthesisLedger.packets[2]!],
      };
      for (const [topicIndex, topicId] of topicIds.entries()) {
        const topicTaskId = `topic-${topicId}-answer`;
        const source = sources[topicIndex]!;
        const topicSources =
          topicId === "t2"
            ? [sourceEntryFor(source), sourceEntryFor(omittedSource)]
            : [sourceEntryFor(source)];
        const packetSourceKeys =
          topicId !== "t2" ||
          mutation === "success" ||
          mutation === "leak-omitted" ||
          mutation === "drop-retained" ||
          mutation === "tamper-retained" ||
          mutation === "tamper-omitted"
            ? [source.sourceKey]
            : mutation === "omitted-subset"
              ? [source.sourceKey]
              : mutation === "omitted-foreign"
                ? [sources[0]!.sourceKey]
                : mutation === "omitted-duplicate"
                  ? [source.sourceKey, source.sourceKey]
                  : [omittedSource.sourceKey, source.sourceKey];
        const topicLedger = {
          ...failedTopicContextLedger(String(topicIndex + 1).repeat(64)),
          topicId,
          question:
            topicId === "t1" ? "first topic" : topicId === "t2" ? "second topic" : "third topic",
          sources: topicSources,
        };
        const compactedTopicLedger = {
          ...topicLedger,
          requestSha256Hex: String(topicIndex + 4).repeat(64),
        };
        await runDb(
          insertProviderMeasurementAndUsage(fixture, {
            taskId: topicTaskId,
            agentRole: "topic_answer",
            loopIteration: 0,
            attempt: 0,
            requestSha256Hex: compactedTopicLedger.requestSha256Hex,
          }),
        );
        await runDb(
          insertSuccessfulCompactedContextPath(fixture, {
            consumerTaskId: topicTaskId,
            topicId,
            sourceKeys: topicSources.map((entry) => entry.sourceKey),
            initialTaskId: `topic-${topicId}-measure`,
            compactedTaskId: `topic-${topicId}-compact-measure`,
            initialLedger: topicLedger,
            compactedLedger: compactedTopicLedger,
          }),
        );
        await runDb(
          insertAiObservation({
            runId: fixture.runId,
            chatId: fixture.chatId,
            emittingTask: topicTaskId,
            loopIteration: 0,
            attempt: 0,
            observationKey: `fixture:${topicTaskId}:topic-packet`,
            kind: "topic_packet",
            payload: {
              topicId,
              status: "partial",
              sourceKeys: packetSourceKeys,
              claimCount: 0,
              gapCount: 0,
              packetSha256Hex: fullSynthesisLedger.packets[topicIndex]!.packetSha256Hex,
            },
          }),
        );
        if (topicId !== "t2") {
          const binding = {
            messageIndex: 0,
            sourceOrdinal: 0,
            serializedField: `messages[0].content.evidence.source[0](${source.sourceKey})`,
            orderedSourceDescriptor: `fixture:${source.sourceKey}`,
          } as const;
          const proof = providerVisibleSourceExposureProofSha256Hex(
            {
              sourceKind: "chat_message",
              logicalSourceIdentity: candidateIdForSource(source),
              contentItemIdentity: source.locator.messageId,
              exposureStage: "answer_serialized",
              visibleTokenCount: 3,
            },
            binding,
          );
          await runDb(
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              yield* sql`
                update ai_observations
                set payload = payload || ${sql.json({
                  sourceExposureProofSha256Hexes: [proof],
                  sourceExposureProofBindings: [
                    {
                      providerSerializationProofSha256Hex: proof,
                      providerSerializationProofBinding: binding,
                    },
                  ],
                })}
                where run_id = ${fixture.runId}
                  and emitting_task = ${topicTaskId}
                  and kind = 'provider_request_measurement'
              `;
            }),
          );
          await runDb(
            insertAiSourceExposure({
              runId: fixture.runId,
              taskId: topicTaskId,
              loopIteration: 0,
              attempt: 0,
              providerRequestIndex: 0,
              providerRequestSha256Hex: compactedTopicLedger.requestSha256Hex,
              sourceKind: "chat_message",
              logicalSourceIdentity: candidateIdForSource(source),
              contentItemIdentity: source.locator.messageId,
              chatReconstruction: chatReconstructionFor(
                source.locator.messageId,
                chatContentFor(source),
              ),
              exposureStage: "answer_serialized",
              visibleTokenCount: 3,
              providerSerializationProofBinding: binding,
            }),
          );
        }
      }
      if (mutation === "tamper-retained" || mutation === "tamper-omitted") {
        const topicId = mutation === "tamper-retained" ? "t1" : "t2";
        await runDb(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update ai_observations
              set payload = jsonb_set(payload, '{packetSha256Hex}', to_jsonb(${`f`.repeat(64)}::text))
              where run_id = ${fixture.runId}
                and kind = 'topic_packet'
                and emitting_task = ${`topic-${topicId}-answer`}
            `;
          }),
        );
      }
      await runDb(
        insertProviderMeasurementAndUsage(fixture, {
          taskId: "fanout-synthesis",
          agentRole: "synthesis",
          loopIteration: 0,
          attempt: 0,
          requestSha256Hex: compactedSynthesisLedger.requestSha256Hex,
        }),
      );
      await runDb(
        insertSuccessfulCompactedContextPath(fixture, {
          consumerTaskId: "fanout-synthesis",
          sourceKeys: terminalSources.flatMap((source) =>
            source.uses.length > 0 ? [source.sourceKey] : [],
          ),
          initialTaskId: "fanout-synthesis-measure",
          compactedTaskId: "fanout-synthesis-compact-measure",
          initialLedger: fullSynthesisLedger,
          compactedLedger: compactedSynthesisLedger,
        }),
      );
      const memory = await runDb(
        persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
      );
      const terminal = runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: {
            status: "ok",
            mode: "synthesis",
            content: "Source-bearing omitted packet answer",
            sourceMap: terminalSources,
          },
          memory,
        }),
      );
      if (accepted) {
        await expect(terminal).resolves.toMatchObject({ status: "succeeded" });
      } else {
        await expect(terminal).rejects.toThrow(/omitted topic|packet|source|exposure|canonical/u);
      }
    },
  );

  it("fences success and controlled failure before any terminal mutation when Smithers identity is stale", async () => {
    const success = await runDb(createFixture("stale-smithers-success", "clarify"));
    const successMemory = await runDb(
      persistMemoryArtifact(success, {
        proposals: [{ kind: "fact", content: "Must not be written" }],
        discardedCount: 0,
      }),
    );
    const controlled = await runDb(createFixture("stale-smithers-controlled"));
    const controlledMemory = await runDb(
      persistMemoryArtifact(controlled, {
        proposals: [{ kind: "preference", content: "Must not be written" }],
        discardedCount: 0,
      }),
    );
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_runs
          set smithers_run_id = ${`stale:${success.runId}`}
          where id = ${success.runId}
        `;
        yield* sql`
          update ai_runs
          set smithers_run_id = ${`stale:${controlled.runId}`}
          where id = ${controlled.runId}
        `;
      }),
    );

    await expect(
      runDb(
        finalizeAiRun({
          runId: success.runId,
          expectedSmithersRunId: `ai-chat:${success.runId}`,
          coordinates: finalizeCoordinates,
          answer: {
            status: "ok",
            mode: "clarification",
            content: "Must not finalize",
            sourceMap: [],
          },
          memory: successMemory,
        }),
      ),
    ).rejects.toBeInstanceOf(AiRunSmithersRunIdMismatch);
    await expect(
      runDb(
        finalizeAiRun({
          runId: controlled.runId,
          expectedSmithersRunId: `ai-chat:${controlled.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "failed", code: "answer_failed", retryable: false },
          memory: controlledMemory,
        }),
      ),
    ).rejects.toBeInstanceOf(AiRunSmithersRunIdMismatch);

    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{
          readonly runId: string;
          readonly assistantCount: number;
          readonly memoryCount: number;
          readonly usageCount: number;
          readonly eventCount: number;
          readonly finishedAt: Date | null;
          readonly failedAt: Date | null;
        }>`
          select runs.id::text as "runId",
                 (select count(*)::int from chat_messages messages
                   where messages.assistant_ai_run_id = runs.id) as "assistantCount",
                 (select count(*)::int from user_memories memories
                   where memories.user_id = runs.initiating_user_id) as "memoryCount",
                 (select count(*)::int from ai_run_usage run_usage where run_usage.run_id = runs.id) as "usageCount",
                 (select count(*)::int from ai_run_events events where events.run_id = runs.id) as "eventCount",
                 runs.finished_at as "finishedAt", runs.failed_at as "failedAt"
          from ai_runs runs
          where runs.id in (${success.runId}, ${controlled.runId})
          order by runs.id
        `;
      }),
    );
    for (const row of state) {
      expect(row.assistantCount).toBe(0);
      expect(row.memoryCount).toBe(0);
      expect(row.usageCount).toBe(1);
      expect(row.eventCount).toBe(1);
      expect(row.finishedAt).toBeNull();
      expect(row.failedAt).toBeNull();
    }
  });

  it("rejects stale memory heads and manual mutation during an active run", async () => {
    const fixture = await runDb(createFixture("memory-lock", "clarify"));
    await runDb(seedSingleObservability(fixture));
    const originalMemory = await runDb(
      persistMemoryArtifact(fixture, {
        proposals: [{ kind: "fact", content: "Original" }],
        discardedCount: 0,
      }),
    );
    await runDb(
      finalizeAiRun({
        runId: fixture.runId,
        expectedSmithersRunId: `ai-chat:${fixture.runId}`,
        coordinates: finalizeCoordinates,
        answer: { status: "ok", mode: "clarification", content: "Clarify", sourceMap: [] },
        memory: originalMemory,
      }),
    );
    const memory = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [row] = yield* sql<{ readonly id: string; readonly head: string }>`
          select id::text, head_revision_id::text as head
          from user_memories where user_id = ${fixture.userId}
        `;
        return row!;
      }),
    );
    const next = await runDb(createNextRun(fixture, "Update memory", "clarify"));
    await runDb(seedSingleObservability(next));
    const activeDelete = await runDb(Effect.flip(deleteUserMemory(next.userId, memory.id)));
    expect(activeDelete).toBeInstanceOf(ActiveAiRunError);

    const staleMemory = await runDb(
      persistMemoryArtifact(next, {
        proposals: [
          {
            kind: "fact",
            content: "Changed",
            targetMemoryId: memory.id,
            expectedHeadRevisionId: crypto.randomUUID(),
          },
        ],
        discardedCount: 0,
      }),
    );
    const stale = await runDb(
      Effect.flip(
        finalizeAiRun({
          runId: next.runId,
          expectedSmithersRunId: `ai-chat:${next.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "clarification", content: "Updated", sourceMap: [] },
          memory: staleMemory,
        }),
      ),
    );
    expect(stale).toBeInstanceOf(MemoryConflictError);

    await runDb(failAiRun(next.runId, "memory_conflict"));
    const deleted = await runDb(deleteUserMemory(next.userId, memory.id));
    const replay = await runDb(deleteUserMemory(next.userId, memory.id));
    expect(deleted.changed).toBe(true);
    expect(replay.changed).toBe(false);
    const reverted = await runDb(revertUserMemory(next.userId, memory.id, memory.head));
    expect(reverted.current).toEqual({ kind: "fact", content: "Original", deleted: false });
  });

  it("shares the exact API acceptance lock with worker memory mutation", async () => {
    const fixture = await runDb(createFixture("cross-service-lock", "clarify"));
    await runDb(seedSingleObservability(fixture));
    const lockedMemory = await runDb(
      persistMemoryArtifact(fixture, {
        proposals: [{ kind: "fact", content: "Locked" }],
        discardedCount: 0,
      }),
    );
    await runDb(
      finalizeAiRun({
        runId: fixture.runId,
        expectedSmithersRunId: `ai-chat:${fixture.runId}`,
        coordinates: finalizeCoordinates,
        answer: { status: "ok", mode: "clarification", content: "Saved", sourceMap: [] },
        memory: lockedMemory,
      }),
    );
    const ids = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [memory] = yield* sql<{ readonly id: string }>`
          select id::text from user_memories where user_id = ${fixture.userId}
        `;
        const [message] = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${fixture.chatId}, 'user', 'Accepted while delete races')
          returning id::text
        `;
        return { memoryId: memory!.id, messageId: message!.id };
      }),
    );

    const acceptance = runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
            select pg_advisory_xact_lock(hashtext(${`brief:user-memory:${fixture.userId}`}))
            `;
            yield* sql`select pg_sleep(0.3)`;
            const [memoryHead] = yield* sql<{ readonly revisionId: string }>`
              select head_revision_id::text as "revisionId"
              from user_memories
              where id = ${ids.memoryId}
                and deleted_at is null
            `;
            const [run] = yield* sql<{ readonly id: string }>`
              insert into ai_runs (
                chat_id, initiating_user_id, user_message_id, locale, market,
                acceptance_scope
              )
              values (
                ${fixture.chatId}, ${fixture.userId}, ${ids.messageId}, 'en-US', 'US',
                ${sql.json(
                  makeRunAcceptanceScope({
                    userId: fixture.userId,
                    chatId: fixture.chatId,
                    companyId: fixture.companyId,
                    memoryMode: fixture.memoryMode,
                    memoryRevisionIds: memoryHead === undefined ? [] : [memoryHead.revisionId],
                  }),
                )}
              )
              returning id::text
            `;
            return run!.id;
          }),
        );
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const deletion = runDb(Effect.flip(deleteUserMemory(fixture.userId, ids.memoryId)));
    const [acceptedRunId, deletionError] = await Promise.all([acceptance, deletion]);
    expect(deletionError).toBeInstanceOf(ActiveAiRunError);
    expect((deletionError as ActiveAiRunError).runId).toBe(acceptedRunId);
    await runDb(failAiRun(acceptedRunId, "answer_failed"));
  });

  it("redacts referenced expired tombstones and hard-deletes unreferenced tombstones", async () => {
    const fixture = await runDb(createFixture("retention", "clarify"));
    await runDb(seedSingleObservability(fixture));
    const retainedMemory = await runDb(
      persistMemoryArtifact(fixture, {
        proposals: [{ kind: "fact", content: "Retain me" }],
        discardedCount: 0,
      }),
    );
    await runDb(
      finalizeAiRun({
        runId: fixture.runId,
        expectedSmithersRunId: `ai-chat:${fixture.runId}`,
        coordinates: finalizeCoordinates,
        answer: { status: "ok", mode: "clarification", content: "First", sourceMap: [] },
        memory: retainedMemory,
      }),
    );
    const memory = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [row] = yield* sql<{ readonly id: string; readonly revisionId: string }>`
          select id::text, head_revision_id::text as "revisionId"
          from user_memories where user_id = ${fixture.userId}
        `;
        return row!;
      }),
    );
    const citeRun = await runDb(createNextRun(fixture, "Cite memory"));
    const citeMemory = await runDb(
      persistMemoryArtifact(citeRun, { proposals: [], discardedCount: 0 }),
    );
    const memorySource: FinalSourceRecord = {
      sourceKey: sourceKeyFor(citeRun),
      locator: {
        kind: "memory",
        memoryId: memory.id,
        memoryRevisionId: memory.revisionId,
      },
      label: "Memory",
      publicProvenance: {},
      uses: [
        {
          consumerTaskId: "single-answer",
          contextOrder: 0,
          renderedTokenCount: 2,
          ranges: [],
        },
      ],
    };
    await runDb(
      seedSingleObservability(citeRun, {
        includeAnswerMeasurement: true,
        contextSources: [
          {
            sourceKey: memorySource.sourceKey,
            candidateId: candidateIdForSource(memorySource),
            kind: "memory",
            ranges: [],
            label: memorySource.label,
            ...(memorySource.locator.kind === "memory"
              ? { contentItemIdentity: memorySource.locator.memoryRevisionId }
              : {}),
          },
        ],
      }),
    );
    await runDb(
      finalizeAiRun({
        runId: citeRun.runId,
        expectedSmithersRunId: `ai-chat:${citeRun.runId}`,
        coordinates: finalizeCoordinates,
        answer: {
          status: "ok",
          mode: "single",
          content: `Remember [[cite:${sourceKeyFor(citeRun)}]]`,
          sourceMap: [memorySource],
        },
        memory: citeMemory,
      }),
    );
    await runDb(deleteUserMemory(fixture.userId, memory.id));

    const unreferenced = await runDb(createFixture("retention-unreferenced", "clarify"));
    await runDb(seedSingleObservability(unreferenced));
    const unreferencedMemory = await runDb(
      persistMemoryArtifact(unreferenced, {
        proposals: [{ kind: "fact", content: "Delete me" }],
        discardedCount: 0,
      }),
    );
    await runDb(
      finalizeAiRun({
        runId: unreferenced.runId,
        expectedSmithersRunId: `ai-chat:${unreferenced.runId}`,
        coordinates: finalizeCoordinates,
        answer: { status: "ok", mode: "clarification", content: "First", sourceMap: [] },
        memory: unreferencedMemory,
      }),
    );
    const [unreferencedId] = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly id: string }>`
          select id::text from user_memories where user_id = ${unreferenced.userId}
        `;
      }),
    );
    await runDb(deleteUserMemory(unreferenced.userId, unreferencedId!.id));
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update user_memories
          set deleted_at = now() - interval '31 days'
          where id in (${memory.id}, ${unreferencedId!.id})
        `;
      }),
    );

    const purge = await runDb(purgeUserMemoryTombstones());
    expect(purge).toMatchObject({ processed: 2, hardDeleted: 1, madeProvenanceOnly: 1 });
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [retained] = yield* sql<{
          readonly kind: string | null;
          readonly content: string | null;
          readonly head: string | null;
          readonly provenanceOnlyAt: Date | null;
          readonly revisionCount: number;
          readonly stateBefore: unknown;
          readonly runId: string | null;
        }>`
          select
            memories.kind,
            memories.content,
            memories.head_revision_id::text as head,
            memories.provenance_only_at as "provenanceOnlyAt",
            count(revisions.id)::int as "revisionCount",
            min(revisions.state_before::text) as "stateBefore",
            min(revisions.run_id::text) as "runId"
          from user_memories memories
          join user_memory_revisions revisions on revisions.memory_id = memories.id
          where memories.id = ${memory.id}
          group by memories.id
        `;
        const [gone] = yield* sql<{ readonly count: number }>`
          select count(*)::int as count from user_memories where id = ${unreferencedId!.id}
        `;
        return { retained, gone };
      }),
    );
    expect(state.retained).toMatchObject({
      kind: null,
      content: null,
      head: null,
      revisionCount: 1,
      stateBefore: null,
      runId: null,
    });
    expect(state.retained?.provenanceOnlyAt).toBeInstanceOf(Date);
    expect(state.gone?.count).toBe(0);
    const expiredRevert = await runDb(
      Effect.flip(revertUserMemory(fixture.userId, memory.id, memory.revisionId)),
    );
    expect(expiredRevert).toBeInstanceOf(MemoryRevertWindowExpiredError);
  });

  it("does not let a large provenance-only prefix starve newer expired tombstones", async () => {
    const fixture = await runDb(createFixture("retention-fairness"));
    const expiredMemoryId = crypto.randomUUID();
    const expiredRevisionId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
          insert into chat_messages (id, chat_id, author, content, assistant_ai_run_id)
          values (
            ${assistantMessageId}, ${fixture.chatId}, 'assistant', 'Retained memory evidence',
            ${fixture.runId}
          )
        `;
            yield* sql`
          update ai_runs
          set assistant_message_id = ${assistantMessageId}
          where id = ${fixture.runId}
        `;
            yield* sql`
          insert into user_memories (
            id, user_id, kind, content, head_revision_id, deleted_at
          ) values (
            ${expiredMemoryId}, ${fixture.userId}, 'fact', 'Expired tombstone',
            ${expiredRevisionId}, now() - interval '31 days'
          )
        `;
            yield* sql`
          insert into user_memory_revisions (
            id, memory_id, action, state_before, state_after
          ) values (
            ${expiredRevisionId}, ${expiredMemoryId}, 'create', null,
            ${sql.json({ kind: "fact", content: "Expired tombstone", deleted: false })}
          )
        `;
            // These 501 rows are already provenance-only and each remains
            // referenced by an immutable answer source. Their older deletion
            // timestamp would consume the old single LIMIT 500 forever. The
            // 502nd row is unreferenced and must be reached despite that
            // referenced prefix.
            yield* sql`
          with ids as (
            select ordinal,
                   (
                     substr(md5('retention-fair-memory:' || ordinal::text), 1, 8) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 9, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 13, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 17, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 21, 12)
                   )::uuid as memory_id,
                   (
                     substr(md5('retention-fair-revision:' || ordinal::text), 1, 8) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 9, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 13, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 17, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 21, 12)
                   )::uuid as revision_id
            from generate_series(1, 502) ordinal
          )
          insert into user_memories (
            id, user_id, kind, content, head_revision_id, deleted_at
          )
          select memory_id, ${fixture.userId}, 'fact', 'Provenance-only', revision_id,
                 now() - interval '32 days'
          from ids
        `;
            yield* sql`
          with ids as (
            select ordinal,
                   (
                     substr(md5('retention-fair-memory:' || ordinal::text), 1, 8) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 9, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 13, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 17, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 21, 12)
                   )::uuid as memory_id,
                   (
                     substr(md5('retention-fair-revision:' || ordinal::text), 1, 8) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 9, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 13, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 17, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 21, 12)
                   )::uuid as revision_id
            from generate_series(1, 502) ordinal
          )
          insert into user_memory_revisions (
            id, memory_id, action, state_before, state_after
          )
          select revision_id, memory_id, 'create', null,
                 ${sql.json({ kind: "fact", content: "Provenance-only", deleted: false })}
          from ids
        `;
            yield* sql`
          with ids as (
            select ordinal,
                   (
                     substr(md5('retention-fair-memory:' || ordinal::text), 1, 8) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 9, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 13, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 17, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 21, 12)
                   )::uuid as memory_id,
                   (
                     substr(md5('retention-fair-revision:' || ordinal::text), 1, 8) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 9, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 13, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 17, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 21, 12)
                   )::uuid as revision_id
            from generate_series(1, 502) ordinal
          )
          update user_memories memories
          set kind = null,
              content = null,
              head_revision_id = null,
              provenance_only_at = now() - interval '1 day'
          from ids
          where memories.id = ids.memory_id
        `;
            yield* sql`
          with ids as (
            select ordinal,
                   (
                     substr(md5('retention-fair-memory:' || ordinal::text), 1, 8) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 9, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 13, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 17, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 21, 12)
                   )::uuid as memory_id,
                   (
                     substr(md5('retention-fair-revision:' || ordinal::text), 1, 8) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 9, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 13, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 17, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 21, 12)
                   )::uuid as revision_id
            from generate_series(1, 501) ordinal
          )
          insert into assistant_message_sources (
            assistant_message_id, source_key, kind, locator, memory_revision_id
          )
          select ${assistantMessageId},
                 ${`k_${fixture.citationNamespace}_`} || ordinal::text,
                 'memory',
                 jsonb_build_object(
                   'kind', 'memory', 'memoryId', memory_id::text,
                   'memoryRevisionId', revision_id::text
                 ),
                 revision_id
          from ids
        `;
            yield* sql`
          insert into assistant_message_source_uses (
            assistant_message_id, source_key, consumer_task_id,
            rendered_token_count, context_order, ranges
          )
          select ${assistantMessageId},
                 ${`k_${fixture.citationNamespace}_`} || ordinal::text,
                 'single-answer', 1, ordinal - 1, '[]'::jsonb
          from generate_series(1, 501) ordinal
        `;
          }),
        );
      }),
    );

    const purge = await runDb(purgeUserMemoryTombstones(10));
    expect(purge.processed).toBe(2);
    expect(purge.hardDeleted).toBe(2);
    const remainingExpired = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly count: number }>`
          select count(*)::int as count from user_memories where id = ${expiredMemoryId}
        `)[0]!.count;
      }),
    );
    expect(remainingExpired).toBe(0);
    const remainingUnreferencedProvenance = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from user_memories memories
          where memories.user_id = ${fixture.userId}
            and memories.provenance_only_at is not null
            and not exists (
              select 1
              from assistant_message_sources sources
              join user_memory_revisions revisions
                on revisions.id = sources.memory_revision_id
              where revisions.memory_id = memories.id
            )
        `)[0]!.count;
      }),
    );
    expect(remainingUnreferencedProvenance).toBe(0);
  });

  it("prunes stream events only beyond the code-owned 24-hour terminal boundary", async () => {
    const expired = await runDb(createFixture("events-expired"));
    const retained = await runDb(createFixture("events-retained"));
    await runDb(failAiRun(expired.runId, "answer_failed"));
    await runDb(failAiRun(retained.runId, "answer_failed"));
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_run_events
          set created_at = now() - interval '24 hours 1 second'
          where run_id = ${expired.runId} and emission_key = 'terminal'
        `;
        yield* sql`
          update ai_run_events
          set created_at = now() - interval '23 hours 59 minutes 59 seconds'
          where run_id = ${retained.runId} and emission_key = 'terminal'
        `;
      }),
    );

    expect(await runDb(pruneFinishedAiRunEvents())).toEqual({
      deletedEvents: 3,
      selectedCandidates: 1,
    });
    const counts = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly runId: string; readonly count: number }>`
          select run_id::text as "runId", count(*)::int as count
          from ai_run_events
          where run_id in (${expired.runId}, ${retained.runId})
          group by run_id
        `;
      }),
    );
    expect(counts.find((row) => row.runId === expired.runId)).toBeUndefined();
    expect(counts.find((row) => row.runId === retained.runId)?.count).toBe(3);
  });

  it("retains expired event ledgers for awaiting-annotation and completed evaluations", async () => {
    const evaluations = [
      {
        fixture: await runDb(createFixture("events-evaluation-awaiting")),
        sessionId: crypto.randomUUID(),
        status: "awaiting_annotations" as const,
      },
      {
        fixture: await runDb(createFixture("events-evaluation-complete")),
        sessionId: crypto.randomUUID(),
        status: "complete" as const,
      },
    ];
    for (const evaluation of evaluations) {
      await runDb(failAiRun(evaluation.fixture.runId, "answer_failed"));
    }
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        for (const evaluation of evaluations) {
          yield* sql`
            update ai_run_events
            set created_at = now() - interval '24 hours 1 second'
            where run_id = ${evaluation.fixture.runId} and emission_key = 'terminal'
          `;
          yield* sql`
            insert into ai_evaluation_sessions (
              id, artifact_version, golden_set_version, fixture_sha256_hex,
              execution_config_sha256_hex, provider_endpoint_identity, status, completed_at
            ) values (
              ${evaluation.sessionId}, 4, 4, ${"a".repeat(64)}, ${"b".repeat(64)},
              ${TINYFISH_SEARCH_PROVIDER_ENDPOINT_IDENTITY},
              ${evaluation.status},
              ${evaluation.status === "complete" ? new Date() : null}
            )
          `;
          yield* sql`
            insert into ai_evaluation_case_runs (
              session_id, case_id, topology, ai_run_id, seed_manifest, status
            ) values (
              ${evaluation.sessionId}, 'retention-case', 'specialized',
              ${evaluation.fixture.runId}, '{}'::jsonb, 'seeded'
            )
          `;
        }
      }),
    );

    expect(await runDb(pruneFinishedAiRunEvents())).toEqual({
      deletedEvents: 0,
      selectedCandidates: 0,
    });
    const counts = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly runId: string; readonly count: number }>`
          select run_id::text as "runId", count(*)::int as count
          from ai_run_events
          where run_id in (${evaluations[0]!.fixture.runId}, ${evaluations[1]!.fixture.runId})
          group by run_id
        `;
      }),
    );
    expect(counts).toHaveLength(2);
    expect(counts.every((row) => row.count === 3)).toBe(true);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          delete from ai_run_events
          where run_id in (${evaluations[0]!.fixture.runId}, ${evaluations[1]!.fixture.runId})
        `;
      }),
    );
  });

  it("sweeps terminal and absent Smithers state only after 24 hours", async () => {
    const terminal = await runDb(createFixture("smithers-terminal"));
    const active = await runDb(createFixture("smithers-active"));
    const fresh = await runDb(createFixture("smithers-fresh"));
    const terminalSmithersId = `ai-chat:${terminal.runId}`;
    const activeSmithersId = `ai-chat:${active.runId}`;
    const freshSmithersId = `ai-chat:${fresh.runId}`;
    const orphanSmithersId = `ai-chat:${crypto.randomUUID()}`;
    await runDb(failAiRun(terminal.runId, "answer_failed"));
    await runDb(failAiRun(active.runId, "answer_failed"));
    await runDb(failAiRun(fresh.runId, "answer_failed"));
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_runs
          set smithers_run_id = ${terminalSmithersId},
              failed_at = now() - interval '24 hours 1 second'
          where id = ${terminal.runId}
        `;
        yield* sql`
          update ai_runs
          set smithers_run_id = ${activeSmithersId},
              failed_at = now() - interval '24 hours 1 second'
          where id = ${active.runId}
        `;
        yield* sql`
          update ai_runs
          set smithers_run_id = ${freshSmithersId},
              failed_at = now() - interval '23 hours 55 minutes'
          where id = ${fresh.runId}
        `;
        yield* sql`
          create table if not exists _smithers_runs (
            run_id text primary key,
            status text not null,
            heartbeat_at_ms bigint
          )
        `;
        yield* sql`alter table _smithers_runs add column if not exists status text`;
        yield* sql`alter table _smithers_runs add column if not exists heartbeat_at_ms bigint`;
        yield* sql`
          insert into _smithers_runs (run_id, status, heartbeat_at_ms)
          values (${activeSmithersId}, 'running', ${Date.now()})
          on conflict (run_id) do update
            set status = excluded.status, heartbeat_at_ms = excluded.heartbeat_at_ms
        `;
        yield* sql`create table _smithers_retention_test (run_id text primary key)`;
        yield* sql`create table ai_chat_answer (run_id text primary key)`;
        yield* sql`
          insert into _smithers_retention_test (run_id)
          values
            (${terminalSmithersId}), (${activeSmithersId}),
            (${freshSmithersId}), (${orphanSmithersId})
        `;
        yield* sql`
          insert into ai_chat_answer (run_id)
          values
            (${terminalSmithersId}), (${activeSmithersId}),
            (${freshSmithersId}), (${orphanSmithersId})
        `;
      }),
    );

    expect(await runDb(sweepAiChatSmithersRows())).toEqual({
      deletedRuns: 1,
      selectedCandidates: 3,
    });
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_smithers_orphan_candidates
          set first_seen_at = now() - interval '24 hours 1 second'
          where smithers_run_id = ${orphanSmithersId}
        `;
      }),
    );
    expect(await runDb(sweepAiChatSmithersRows())).toEqual({
      deletedRuns: 1,
      selectedCandidates: 2,
    });
    const remaining = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const synthetic = yield* sql<{ readonly runId: string }>`
          select run_id as "runId" from _smithers_retention_test order by run_id
        `;
        const canonical = yield* sql<{ readonly runId: string }>`
          select run_id as "runId" from ai_chat_answer order by run_id
        `;
        return { canonical, synthetic };
      }),
    );
    expect(remaining.synthetic.map((row) => row.runId)).toEqual(
      [activeSmithersId, freshSmithersId].sort(),
    );
    expect(remaining.canonical.map((row) => row.runId)).toEqual(
      [activeSmithersId, freshSmithersId].sort(),
    );
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          delete from _smithers_runs
          where run_id in (${activeSmithersId}, ${freshSmithersId})
        `;
        yield* sql`
          delete from _smithers_retention_test
          where run_id in (${activeSmithersId}, ${freshSmithersId})
        `;
        yield* sql`
          delete from ai_chat_answer
          where run_id in (${activeSmithersId}, ${freshSmithersId})
        `;
      }),
    );
  });

  it("holds the Smithers ownership fence from heartbeat check through deletion", async () => {
    const fixture = await runDb(createFixture("smithers-retention-fence"));
    const smithersRunId = `ai-chat:${fixture.runId}`;
    await runDb(failAiRun(fixture.runId, "answer_failed"));
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_runs
          set smithers_run_id = ${smithersRunId},
              failed_at = now() - interval '24 hours 1 second'
          where id = ${fixture.runId}
        `;
        yield* sql`create table _smithers_retention_fence_test (run_id text primary key)`;
        yield* sql`
          insert into _smithers_retention_fence_test (run_id) values (${smithersRunId})
        `;
      }),
    );

    let releaseFence!: () => void;
    let signalReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const producerFence = runDb(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const connection = yield* sql.reserve;
          yield* connection.executeRaw(
            "select pg_advisory_lock_shared(hashtextextended($1::text, 0))",
            [AI_CHAT_SMITHERS_SCHEMA_FENCE],
          );
          const released = new Promise<void>((resolve) => {
            releaseFence = resolve;
          });
          signalReady();
          yield* Effect.tryPromise({
            try: () => released,
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          });
          yield* connection.executeRaw(
            "select pg_advisory_unlock_shared(hashtextextended($1::text, 0))",
            [AI_CHAT_SMITHERS_SCHEMA_FENCE],
          );
        }),
      ),
    );
    await ready;

    const sweep = runDb(sweepAiChatSmithersRows());
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const whileFenced = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from _smithers_retention_fence_test
          where run_id = ${smithersRunId}
        `;
      }),
    );
    expect(whileFenced[0]?.count).toBe(1);

    releaseFence();
    await producerFence;
    await expect(sweep).resolves.toMatchObject({ deletedRuns: 1 });
  });

  it("shares one exact 500-candidate budget across Smithers and stream-event retention", async () => {
    const smithers = await runDb(createFixture("retention-shared-budget"));
    const smithersRunId = `ai-chat:${smithers.runId}`;
    await runDb(failAiRun(smithers.runId, "answer_failed"));
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_runs
          set smithers_run_id = ${smithersRunId},
              failed_at = now() - interval '24 hours 1 second'
          where id = ${smithers.runId}
        `;
        yield* sql`create table if not exists _smithers_retention_budget_test (run_id text primary key)`;
        yield* sql`
          insert into _smithers_retention_budget_test (run_id)
          values (${smithersRunId})
        `;

        const eventFixture = yield* createFixture("retention-event-budget");
        yield* sql`
          with messages as (
            insert into chat_messages (chat_id, author, content)
            select ${eventFixture.chatId}, 'user', 'retention event ' || candidate::text
            from generate_series(1, 500) candidate
            returning id
          ), runs as (
            insert into ai_runs (
              chat_id, initiating_user_id, user_message_id, locale, market,
              acceptance_scope, failed_at, error_code, retryable
            )
            select ${eventFixture.chatId}, ${eventFixture.userId}, messages.id,
                   'en-US', 'US', (select acceptance_scope from ai_runs where id = ${eventFixture.runId}),
                   now() - interval '24 hours 1 second',
                   'answer_failed', false
            from messages
            returning id
          )
          insert into ai_run_events (
            run_id, seq, emission_key, emitted_by_task, event, created_at
          )
          select runs.id, 1, 'terminal', 'system',
                 '{"type":"failed","code":"answer_failed","retryable":false}'::jsonb,
                 now() - interval '24 hours 1 second'
          from runs
        `;
      }),
    );

    expect(await runDb(purgeAiRuntimeRetention())).toEqual({
      sweptRuns: 1,
      prunedEvents: 499,
      selectedCandidates: 500,
    });
    const afterFirstSweep = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from ai_run_events
          where emission_key = 'terminal'
            and created_at < now() - interval '24 hours'
        `)[0]!.count;
      }),
    );
    expect(afterFirstSweep).toBe(1);

    expect(await runDb(purgeAiRuntimeRetention())).toEqual({
      sweptRuns: 0,
      prunedEvents: 1,
      selectedCandidates: 1,
    });
  });
});
