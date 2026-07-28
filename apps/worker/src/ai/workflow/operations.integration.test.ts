import { PgClient } from "@effect/sql-pg";
import * as SmithersTaskRuntimeModule from "@smithers-orchestrator/driver/task-runtime";
import { Effect, Redacted } from "effect";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeRunAcceptanceScope } from "@brief/shared";

import { runMigrations } from "../../db/migrate";
import {
  CanonicalAgentClient,
  type StructuredCallInput,
  type ToolLoopInput,
} from "../runtime/agent-client";
import type {
  BeforeProviderRequest,
  ExactPiBoundary,
  PiBoundaryCoordinates,
  PiCompletion,
} from "../runtime/pi-boundary";
import {
  providerRequestSha256Hex,
  providerRequestSourceExposureProofBindings,
  type LiveProviderRequest,
  type CodeOwnedSourceExposureProof,
  type ProviderVisibleSourceExposureProofBinding,
  type ProviderVisibleSourceExposureMarker,
} from "../runtime/provider-request";
import { resolveRegisteredModel, type AcceptedProviderProfile } from "../runtime/model-registry";
import {
  chatMessageEvidenceIdentity,
  memoryEvidenceIdentity,
  memoryExtractionSha256Hex,
  namespacedDocumentEvidenceIdentity,
  sha256Base64Url,
  webEvidenceIdentity,
} from "../runtime/canonicalization";
import {
  insertAiObservation,
  insertAiRunUsage,
  insertAiSourceExposure,
  type AiSourceExposureInput,
} from "../product-state/observability";
import type {
  FinalSourceRecord,
  InternalReference,
  MemoryExtractionArtifact,
  MemoryExtractionResult,
  MemoryReference,
  LiveProviderRequestMeasurement,
} from "../runtime/types";
import { WebBoundaryError } from "../web/errors";
import {
  type CanonicalAiConfig,
  CanonicalWorkflowOperations,
  type ContextState,
  type FanoutSourceKeySet,
  type LoadedTurn,
  type SelectorBundle,
  topicRequestsWebEvidence,
  type WebResearchBoundary,
} from "./operations";

const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const databaseName = `brief_ai_operations_test_${process.pid}_${crypto
  .randomUUID()
  .replaceAll("-", "")
  .slice(0, 8)}`;

const databaseUrlFor = (name: string): string => {
  if (databaseUrl === undefined) throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const withTaskRuntime = (
  SmithersTaskRuntimeModule as unknown as {
    readonly withTaskRuntime: <Value>(
      runtime: {
        readonly runId: string;
        readonly stepId: string;
        readonly attempt: number;
        readonly iteration: number;
        readonly signal: AbortSignal;
        readonly db: Readonly<Record<string, unknown>>;
        readonly heartbeat: (data?: unknown) => void;
        readonly lastHeartbeat: unknown | null;
      },
      execute: () => Value,
    ) => Value;
  }
).withTaskRuntime;
const inTask = <Value>(
  stepId: string,
  execute: () => Value,
  options: { readonly attempt?: number; readonly iteration?: number } = {},
): Value => {
  const controller = new AbortController();
  return withTaskRuntime(
    {
      runId: `operations-test:${crypto.randomUUID()}`,
      stepId,
      attempt: options.attempt ?? 1,
      iteration: options.iteration ?? 0,
      signal: controller.signal,
      db: {},
      heartbeat: () => undefined,
      lastHeartbeat: null,
    },
    execute,
  );
};

const testProviderBoundary = (): ExactPiBoundary =>
  ({ bindAcceptedProviderProfile: () => undefined }) as unknown as ExactPiBoundary;

const providerToolCompletion = (
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
  id: string,
): PiCompletion => ({
  text: "",
  toolCalls: [{ id, name, arguments: arguments_ }],
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cachedTokens: 0,
    reasoningTokens: 0,
    totalTokens: 2,
    stopReason: "toolUse",
  },
  stopReason: "toolUse",
});
const assembleAndMeasureContext = async (
  operations: CanonicalWorkflowOperations,
  load: LoadedTurn,
  question: string,
  selectors: SelectorBundle,
  consumerTaskId: string,
  topicId?: "t1" | "t2" | "t3",
  selectedTurnIds?: readonly string[],
  fanoutSourceKeys?: FanoutSourceKeySet,
  requestedOutputTokens?: number,
): Promise<ContextState> => {
  const prefix = topicId === undefined ? "single" : `topic-${topicId}`;
  const assembly = await inTask(`${prefix}-assemble`, () =>
    operations.assembleContext(
      load,
      question,
      selectors,
      `${prefix}-assemble`,
      consumerTaskId,
      topicId,
      selectedTurnIds,
      fanoutSourceKeys,
      requestedOutputTokens,
    ),
  );
  return inTask(
    `${prefix}-measure`,
    () => operations.measureAssembly(load, assembly, `${prefix}-measure`),
    { attempt: 0 },
  );
};
const restrictedLedgerForContext = (
  context: ContextState,
  consumerTaskId: string,
  requestKind: "direct" | "topic",
  topicId?: "t1" | "t2" | "t3",
) => ({
  requestKind,
  modelId: context.request.model,
  requestSha256Hex: providerRequestSha256Hex(context.request),
  inputTokens: context.inputTokens,
  usableInputTokens: context.usableInputTokens,
  requestedOutputTokens: context.request.requestedOutputTokens,
  selectedConversation: context.selectedConversation.map((entry) =>
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
  ),
  ...(topicId === undefined ? {} : { topicId }),
  question: context.question,
  gaps: context.gaps,
  sources: context.sourceMap.map((source, index) => {
    const candidate = context.candidates[index];
    if (candidate === undefined) throw new Error("context candidate/source mismatch");
    const use = source.uses.find(
      (entry) => entry.consumerTaskId === consumerTaskId && entry.topicId === topicId,
    );
    return {
      candidateId: candidate.id,
      sourceKey: source.sourceKey,
      kind: source.locator.kind,
      purpose: candidate.purpose,
      label: source.label ?? null,
      ranges: use?.ranges ?? [],
    };
  }),
});
const passedMeasurement = (
  model: LiveProviderRequest["model"],
): LiveProviderRequestMeasurement => ({
  modelId: model,
  inputTokens: 1,
  requestedOutputTokens: 1,
  usableInputTokens: 100_000,
  contextWindow: 1_000_000,
  passed: true,
});

interface ToolLoopExposureState {
  readonly markers: ProviderVisibleSourceExposureMarker[];
  readonly wrappedTools: Set<ToolLoopInput<unknown>["tools"][number]>;
  readonly executions: ToolLoopExecution[];
}

interface ToolLoopExecution {
  readonly toolName: string;
  readonly callId: string;
  readonly arguments_: Readonly<Record<string, unknown>>;
  readonly result: Readonly<Record<string, unknown>>;
}

const toolLoopExposureStates = new WeakMap<object, ToolLoopExposureState>();

const sourceExposureMarkersFromToolResult = (
  value: Readonly<Record<string, unknown>>,
): readonly ProviderVisibleSourceExposureMarker[] => {
  const raw = value.__briefSourceExposures;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("source exposure inventory must be an array");
  return raw as readonly ProviderVisibleSourceExposureMarker[];
};

const stripSourceExposureMarkers = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripSourceExposureMarkers);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([key]) => key !== "__briefSourceExposures")
      .map(([key, nested]) => [key, stripSourceExposureMarkers(nested)]),
  );
};

const trackToolLoopExposures = <Output>(
  input: ToolLoopInput<Output>,
): readonly ProviderVisibleSourceExposureMarker[] => {
  let state = toolLoopExposureStates.get(input);
  if (state === undefined) {
    state = { markers: [], wrappedTools: new Set(), executions: [] };
    toolLoopExposureStates.set(input, state);
  }
  for (const tool of input.tools) {
    if (state.wrappedTools.has(tool)) continue;
    const originalExecute = tool.execute;
    const wrappedExecute = async (
      arguments_: Readonly<Record<string, unknown>>,
      coordinates: PiBoundaryCoordinates,
    ): Promise<Readonly<Record<string, unknown>>> => {
      const result = await originalExecute(arguments_, coordinates);
      for (const marker of sourceExposureMarkersFromToolResult(result)) {
        state!.markers.push(marker);
      }
      state!.executions.push({
        toolName: tool.definition.name,
        callId: `operations_fixture_tool_${state!.executions.length}`,
        arguments_,
        result,
      });
      return result;
    };
    Object.defineProperty(tool, "execute", { value: wrappedExecute });
    state.wrappedTools.add(tool);
  }
  return state.markers;
};

const invokeToolLoopProviderHook = async <Output>(
  input: ToolLoopInput<Output>,
  coordinates: PiBoundaryCoordinates,
): Promise<void> => {
  const sourceExposureProofs = trackToolLoopExposures(input);
  const state = toolLoopExposureStates.get(input);
  const request: LiveProviderRequest = {
    requestClass: input.requestClass,
    model: input.model,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
      ...(state?.executions.flatMap((execution) => [
        {
          role: "assistant" as const,
          content: "",
          toolCalls: [
            {
              id: execution.callId,
              name: execution.toolName,
              arguments: execution.arguments_,
            },
          ],
        },
        {
          role: "tool" as const,
          toolCallId: execution.callId,
          name: execution.toolName,
          content: JSON.stringify(stripSourceExposureMarkers(execution.result)),
        },
      ]) ?? []),
    ],
    tools: input.tools.map((tool) => tool.definition),
    sourceExposureProofs,
    toolChoice: "auto",
    requestedOutputTokens: input.requestedOutputTokens,
    reasoning: input.reasoning,
  };
  providerRequestSourceExposureProofBindings(
    request,
    resolveRegisteredModel(request.model).countTextTokens,
  );
  await input.onBeforeRequest?.(
    request,
    { ...coordinates, providerRequestSha256Hex: providerRequestSha256Hex(request) },
    passedMeasurement(input.model),
  );
};
const invokeStructuredProviderHook = async <Output>(
  input: StructuredCallInput<Output>,
): Promise<void> => {
  const request: LiveProviderRequest = {
    requestClass: input.requestClass,
    model: input.model,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    tools: [
      {
        name: input.outputToolName,
        description: input.outputToolDescription,
        parameters: input.outputSchema,
      },
    ],
    ...(input.sourceExposureProofs === undefined
      ? {}
      : { sourceExposureProofs: input.sourceExposureProofs }),
    toolChoice: "auto",
    requestedOutputTokens: input.requestedOutputTokens,
    reasoning: input.reasoning,
  };
  providerRequestSourceExposureProofBindings(
    request,
    resolveRegisteredModel(request.model).countTextTokens,
  );
  await input.onBeforeRequest?.(
    request,
    {
      ...input.coordinates,
      providerRequestSha256Hex: providerRequestSha256Hex(request),
    },
    passedMeasurement(input.model),
  );
};
const runDb = <A, E>(
  effect: Effect.Effect<A, E, PgClient.PgClient>,
  url = databaseUrlFor(databaseName),
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName: "brief-ai-operations-test",
        }),
      ),
    ),
  );

const waitForRuntimeDatabaseLock = async (): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly waiting: boolean }>`
          select exists(
            select 1
            from pg_stat_activity
            where datname = current_database()
              and application_name = 'brief-ai-runtime'
              and wait_event_type = 'Lock'
          ) as waiting
        `)[0]!.waiting;
      }),
    );
    if (waiting) return;
    await Bun.sleep(5);
  }
  throw new Error("AI runtime did not wait for the expected database lock");
};

interface Fixture {
  readonly userId: string;
  readonly companyId: string;
  readonly accessId: string;
  readonly issueId: string;
  readonly documentId: string;
  readonly snapshotId: string;
  readonly extractionId: string;
  readonly contentHash: string;
  readonly runId: string;
  readonly subscriptionId: string;
}

type DurableNoCallReason =
  | "memory_mode_disabled"
  | "no_active_memories"
  | "web_not_requested"
  | "web_policy_disabled"
  | "topic_not_web_eligible";

const durableNoCallReasonForFixtureTask = (
  fixture: Pick<Fixture, "runId">,
  taskId: string,
  topicQuestion?: string,
): Promise<DurableNoCallReason | undefined> =>
  runDb(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{
        readonly memoryMode: "private_owner" | "disabled";
        readonly webRequested: boolean;
        readonly webPolicyEnabled: boolean;
        readonly activeMemoryCount: number;
      }>`
        select runs.acceptance_scope->>'memoryMode' as "memoryMode",
               coalesce((runs.acceptance_scope->>'webRequested')::boolean, false)
                 as "webRequested",
               coalesce((runs.acceptance_scope->>'webEnabled')::boolean, false)
                 as "webPolicyEnabled",
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
      const state = rows[0];
      if (state === undefined) return yield* Effect.fail(new Error("fixture run not found"));
      if (taskId.endsWith("select-memories")) {
        if (state.memoryMode === "disabled") return "memory_mode_disabled";
        return state.activeMemoryCount === 0 ? "no_active_memories" : undefined;
      }
      if (!taskId.endsWith("retrieve-web")) return undefined;
      if (!state.webRequested) return "web_not_requested";
      if (!state.webPolicyEnabled) return "web_policy_disabled";
      if (taskId.startsWith("topic-")) {
        if (topicQuestion === undefined) {
          return yield* Effect.fail(new Error("topic web fixture lacks its question"));
        }
        if (!topicRequestsWebEvidence(topicQuestion)) return "topic_not_web_eligible";
      }
      return undefined;
    }),
  );

const seedAnswerSerializedExposures = async (
  fixture: Pick<Fixture, "runId">,
  taskId: string,
  context: ContextState,
  consumerTaskId: string,
): Promise<{
  readonly proofs: readonly string[];
  readonly bindings: readonly {
    readonly providerSerializationProofSha256Hex: string;
    readonly providerSerializationProofBinding: ProviderVisibleSourceExposureProofBinding;
  }[];
}> => {
  const requestSha256Hex = providerRequestSha256Hex(context.request);
  const model = resolveRegisteredModel(context.request.model);
  const candidateText = (candidate: ContextState["candidates"][number]): string => {
    if (candidate.kind === "web") return candidate.quote;
    if (candidate.kind !== "document") return candidate.text;
    return candidate.ranges
      .map((range) => candidate.text.slice(range.charStart, range.charEnd))
      .join("\n…\n");
  };
  const markerForSource = (
    source: ContextState["sourceMap"][number],
    candidate: ContextState["candidates"][number],
  ): ProviderVisibleSourceExposureMarker => {
    const locator = source.locator;
    const visibleText = candidateText(candidate);
    if (locator.kind === "document") {
      const logicalSourceIdentity = namespacedDocumentEvidenceIdentity(
        locator.publisherIssueId === undefined
          ? { kind: "public", sourceId: locator.sourceId }
          : {
              kind: "publisher",
              sourceId: locator.sourceId,
              issueId: locator.publisherIssueId,
              documentId: locator.publisherDocumentId,
            },
        locator.documentId,
      );
      return {
        sourceKind: "document",
        logicalSourceIdentity,
        contentItemIdentity: `${logicalSourceIdentity}:${locator.snapshotId}:${sha256Base64Url(JSON.stringify(source.uses[0]?.ranges ?? []))}`,
        exposureStage: "answer_serialized",
        visibleTokenCount: model.countTextTokens(visibleText),
      };
    }
    if (locator.kind === "chat_message") {
      return {
        sourceKind: "chat_message",
        logicalSourceIdentity: chatMessageEvidenceIdentity(locator.messageId),
        contentItemIdentity: locator.messageId,
        exposureStage: "answer_serialized",
        visibleTokenCount: model.countTextTokens(visibleText),
      };
    }
    if (locator.kind === "memory") {
      return {
        sourceKind: "memory",
        logicalSourceIdentity: memoryEvidenceIdentity(locator.memoryId),
        contentItemIdentity: locator.memoryRevisionId,
        exposureStage: "answer_serialized",
        visibleTokenCount: model.countTextTokens(visibleText),
      };
    }
    return {
      sourceKind: "web",
      logicalSourceIdentity: webEvidenceIdentity(locator.url, locator.quote),
      contentItemIdentity: `${locator.url}:${locator.quoteHash}`,
      exposureStage: "answer_serialized",
      visibleTokenCount: model.countTextTokens(visibleText),
    };
  };
  const sourceMarkers = context.sourceMap.map((source, index) => {
    const candidate = context.candidates[index];
    if (candidate === undefined) throw new Error("context candidate/source mismatch");
    return markerForSource(source, candidate);
  });
  const userMessage = context.request.messages.find((message) => message.role === "user");
  if (userMessage === undefined) throw new Error("context request lacks its user message");
  const parsedUser = JSON.parse(userMessage.content) as Readonly<Record<string, unknown>>;
  const proofs: CodeOwnedSourceExposureProof[] = [];
  const addProviderInputProof = (contentItemIdentity: string, visibleText: string): void => {
    proofs.push({
      sourceKind: "chat_message",
      logicalSourceIdentity: chatMessageEvidenceIdentity(contentItemIdentity),
      contentItemIdentity,
      exposureStage: "provider_input",
      visibleTokenCount: model.countTextTokens(visibleText),
      visibleText,
    });
  };
  for (const [key, idKey] of [
    ["currentMessage", "currentMessageId"],
    ["currentUserMessage", "currentUserMessageId"],
    ["originalMessage", "originalMessageId"],
  ] as const) {
    if (typeof parsedUser[key] === "string") {
      const identity = typeof parsedUser[idKey] === "string" ? parsedUser[idKey] : key;
      addProviderInputProof(identity, parsedUser[key]);
    }
  }
  const selectedConversation = parsedUser.selectedConversation;
  if (Array.isArray(selectedConversation)) {
    for (const entry of selectedConversation) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Readonly<Record<string, unknown>>;
      if (typeof record.userMessageId === "string" && typeof record.userContent === "string") {
        addProviderInputProof(record.userMessageId, record.userContent);
      }
      if (
        typeof record.assistantMessageId === "string" &&
        typeof record.assistantContent === "string"
      ) {
        addProviderInputProof(record.assistantMessageId, record.assistantContent);
      }
    }
  }
  proofs.push(
    ...sourceMarkers.map((marker, index) => ({
      ...marker,
      visibleText: candidateText(context.candidates[index]!),
    })),
  );
  const bindingRows = providerRequestSourceExposureProofBindings(
    { ...context.request, sourceExposureProofs: proofs },
    model.countTextTokens,
  );
  const answerBindings = bindingRows.filter(
    ({ marker }) => marker.exposureStage === "answer_serialized",
  );
  const exposures: AiSourceExposureInput[] = context.sourceMap.flatMap(
    (source, sourceIndex): readonly AiSourceExposureInput[] => {
      const use = source.uses.find(
        (candidate) =>
          candidate.consumerTaskId === consumerTaskId && candidate.topicId === context.topicId,
      );
      if (use === undefined) return [];
      const locator = source.locator;
      const marker = sourceMarkers[sourceIndex];
      const binding = answerBindings.find(
        ({ marker: boundMarker }) =>
          marker !== undefined && JSON.stringify(boundMarker) === JSON.stringify(marker),
      )?.binding;
      if (marker === undefined || binding === undefined) {
        throw new Error("answer source lacks its provider-derived sidecar binding");
      }
      switch (locator.kind) {
        case "document": {
          const logicalSourceIdentity = namespacedDocumentEvidenceIdentity(
            locator.publisherIssueId === undefined
              ? { kind: "public", sourceId: locator.sourceId }
              : {
                  kind: "publisher",
                  sourceId: locator.sourceId,
                  issueId: locator.publisherIssueId,
                  documentId: locator.publisherDocumentId,
                },
            locator.documentId,
          );
          return [
            {
              runId: fixture.runId,
              taskId,
              loopIteration: 0,
              attempt: 0,
              providerRequestIndex: 0,
              providerRequestSha256Hex: requestSha256Hex,
              sourceKind: "document" as const,
              logicalSourceIdentity,
              ...(locator.publisherIssueId === undefined
                ? {}
                : {
                    publisherIssueId: locator.publisherIssueId,
                    publisherDocumentId: locator.publisherDocumentId,
                  }),
              contentItemIdentity: `${logicalSourceIdentity}:${locator.snapshotId}:${sha256Base64Url(JSON.stringify(use.ranges))}`,
              exposureStage: "answer_serialized",
              visibleTokenCount: marker.visibleTokenCount,
              providerSerializationProofBinding: binding,
              documentReconstruction: {
                sourceId: locator.sourceId,
                documentId: locator.documentId,
                snapshotId: locator.snapshotId,
                contentHash: locator.contentHash,
                ...(locator.publisherExtractionId === undefined
                  ? {}
                  : { publisherExtractionId: locator.publisherExtractionId }),
                ranges: use.ranges,
              },
            },
          ];
        }
        case "chat_message":
          return [
            {
              runId: fixture.runId,
              taskId,
              loopIteration: 0,
              attempt: 0,
              providerRequestIndex: 0,
              providerRequestSha256Hex: requestSha256Hex,
              sourceKind: "chat_message" as const,
              logicalSourceIdentity: chatMessageEvidenceIdentity(locator.messageId),
              contentItemIdentity: locator.messageId,
              exposureStage: "answer_serialized",
              visibleTokenCount: marker.visibleTokenCount,
              providerSerializationProofBinding: binding,
            },
          ];
        case "memory":
          return [
            {
              runId: fixture.runId,
              taskId,
              loopIteration: 0,
              attempt: 0,
              providerRequestIndex: 0,
              providerRequestSha256Hex: requestSha256Hex,
              sourceKind: "memory" as const,
              logicalSourceIdentity: memoryEvidenceIdentity(locator.memoryId),
              contentItemIdentity: locator.memoryRevisionId,
              exposureStage: "answer_serialized",
              visibleTokenCount: marker.visibleTokenCount,
              providerSerializationProofBinding: binding,
            },
          ];
        case "web":
          return [
            {
              runId: fixture.runId,
              taskId,
              loopIteration: 0,
              attempt: 0,
              providerRequestIndex: 0,
              providerRequestSha256Hex: requestSha256Hex,
              sourceKind: "web" as const,
              logicalSourceIdentity: webEvidenceIdentity(locator.url, locator.quote),
              contentItemIdentity: `${locator.url}:${locator.quoteHash}`,
              exposureStage: "answer_serialized",
              visibleTokenCount: marker.visibleTokenCount,
              providerSerializationProofBinding: binding,
            },
          ];
      }
    },
  );
  for (const exposure of exposures) {
    await runDb(insertAiSourceExposure(exposure));
  }
  return runDb(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{
        readonly proof: string;
        readonly binding: ProviderVisibleSourceExposureProofBinding;
      }>`
        select payload->>'providerSerializationProofSha256Hex' as proof,
               payload->'providerSerializationProofBinding' as binding
        from ai_observations
        where run_id = ${fixture.runId}
          and emitting_task = ${taskId}
          and loop_iteration = 0
          and attempt = 0
          and kind = 'source_exposure_attestation'
        order by id
      `;
      return {
        proofs: rows.map((row) => row.proof),
        bindings: rows.map((row) => ({
          providerSerializationProofSha256Hex: row.proof,
          providerSerializationProofBinding: row.binding,
        })),
      };
    }),
  );
};

const persistMemoryArtifact = async (
  fixture: Pick<Fixture, "runId">,
  result: MemoryExtractionResult,
): Promise<MemoryExtractionArtifact> => {
  const extractionSha256Hex = memoryExtractionSha256Hex(result);
  const observationKey = `operations-test:memory-extraction:${extractionSha256Hex}`;
  await runDb(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        insert into ai_observations (
          run_id, chat_id, emitting_task, loop_iteration, attempt,
          observation_key, kind, payload
        )
        select ${fixture.runId}, chat_id, 'memory-extract', 0, 1,
               ${observationKey}, 'memory_extraction_result',
               ${sql.json({
                 proposalCount: result.proposals.length,
                 discardedCount: result.discardedCount,
                 extractionSha256Hex,
               })}
        from ai_runs where id = ${fixture.runId}
        on conflict (run_id, observation_key) do nothing
      `;
      const rows = yield* sql<{ readonly chatId: string }>`
        select chat_id::text as "chatId" from ai_runs where id = ${fixture.runId}
      `;
      const chatId = rows[0]?.chatId;
      if (chatId === undefined) return yield* Effect.fail(new Error("chat not found"));
      yield* insertAiObservation({
        runId: fixture.runId,
        chatId,
        emittingTask: "memory-extract",
        loopIteration: 0,
        attempt: 1,
        observationKey: `operations-test:memory-measurement:${extractionSha256Hex}`,
        kind: "provider_request_measurement",
        payload: {
          providerRequestIndex: 0,
          agentRole: "memory_extractor",
          modelId: "glm-5-turbo",
          requestSha256Hex: "d".repeat(64),
          sourceExposureProofSha256Hexes: [],
          sourceExposureProofBindings: [],
          inputTokens: 1,
          requestedOutputTokens: 2048,
          usableInputTokens: 100_000,
          contextWindow: 1_000_000,
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
          inputTokens: 1,
          outputTokens: 1,
          cachedTokens: 0,
          reasoningTokens: 0,
          totalTokens: 2,
          stopReason: "stop",
        },
      });
    }),
  );
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
};

const seedPlanMeasurement = (fixture: Pick<Fixture, "runId">) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly chatId: string }>`
      select chat_id::text as "chatId" from ai_runs where id = ${fixture.runId}
    `;
    const chatId = rows[0]?.chatId;
    if (chatId === undefined) return yield* Effect.fail(new Error("chat not found"));
    yield* insertAiObservation({
      runId: fixture.runId,
      chatId,
      emittingTask: "plan-turn",
      loopIteration: 0,
      attempt: 0,
      observationKey: "fixture:plan-turn:measurement",
      kind: "provider_request_measurement",
      payload: {
        providerRequestIndex: 0,
        agentRole: "plan_turn",
        modelId: "glm-5-turbo",
        requestSha256Hex: "a".repeat(64),
        sourceExposureProofSha256Hexes: [],
        sourceExposureProofBindings: [],
        inputTokens: 1,
        requestedOutputTokens: 2048,
        usableInputTokens: 100_000,
        contextWindow: 1_000_000,
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
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 2,
        stopReason: "stop",
      },
    });
  });

const providerRoleForTask = (taskId: string): string =>
  ({
    "single-retrieve-internal": "internal_retrieval",
    "single-select-memories": "memory_selector",
    "single-retrieve-web": "web_research",
    "single-reduce-plan": "context_reducer",
    "single-answer": "direct_answer",
    "topic-t1-retrieve-internal": "internal_retrieval",
    "topic-t1-select-memories": "memory_selector",
    "topic-t1-retrieve-web": "web_research",
    "topic-t1-reduce-plan": "context_reducer",
    "topic-t1-answer": "topic_answer",
    "topic-t2-retrieve-internal": "internal_retrieval",
    "topic-t2-select-memories": "memory_selector",
    "topic-t2-retrieve-web": "web_research",
    "topic-t2-reduce-plan": "context_reducer",
    "topic-t2-answer": "topic_answer",
    "topic-t3-retrieve-internal": "internal_retrieval",
    "topic-t3-select-memories": "memory_selector",
    "topic-t3-retrieve-web": "web_research",
    "topic-t3-reduce-plan": "context_reducer",
    "topic-t3-answer": "topic_answer",
    "fanout-synthesis": "synthesis",
  })[taskId] ?? taskId;

const seedExposureMeasurements = (fixture: Pick<Fixture, "runId">) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{
      readonly taskId: string;
      readonly loopIteration: number;
      readonly attempt: number;
      readonly providerRequestIndex: number;
      readonly requestSha256Hex: string;
      readonly proofSha256Hex: string;
      readonly binding: ProviderVisibleSourceExposureProofBinding;
    }>`
      select emitting_task as "taskId",
             loop_iteration::int as "loopIteration",
             attempt::int as attempt,
             (payload->>'providerRequestIndex')::int as "providerRequestIndex",
             payload->>'providerRequestSha256Hex' as "requestSha256Hex",
             payload->>'providerSerializationProofSha256Hex' as "proofSha256Hex",
             payload->'providerSerializationProofBinding' as binding
      from ai_observations
      where run_id = ${fixture.runId}
        and kind = 'source_exposure_attestation'
      order by emitting_task, loop_iteration, attempt, "providerRequestIndex"
    `;
    const groups = new Map<
      string,
      {
        readonly taskId: string;
        readonly loopIteration: number;
        readonly attempt: number;
        readonly providerRequestIndex: number;
        readonly requestSha256Hex: string;
        readonly proofs: string[];
        readonly bindings: {
          readonly providerSerializationProofSha256Hex: string;
          readonly providerSerializationProofBinding: ProviderVisibleSourceExposureProofBinding;
        }[];
      }
    >();
    for (const row of rows) {
      const key = [row.taskId, row.loopIteration, row.attempt, row.providerRequestIndex].join(":");
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, {
          taskId: row.taskId,
          loopIteration: row.loopIteration,
          attempt: row.attempt,
          providerRequestIndex: row.providerRequestIndex,
          requestSha256Hex: row.requestSha256Hex,
          proofs: [row.proofSha256Hex],
          bindings: [
            {
              providerSerializationProofSha256Hex: row.proofSha256Hex,
              providerSerializationProofBinding: row.binding,
            },
          ],
        });
      } else {
        group.proofs.push(row.proofSha256Hex);
        group.bindings.push({
          providerSerializationProofSha256Hex: row.proofSha256Hex,
          providerSerializationProofBinding: row.binding,
        });
      }
    }
    const chatRows = yield* sql<{ readonly chatId: string }>`
      select chat_id::text as "chatId" from ai_runs where id = ${fixture.runId}
    `;
    const chatId = chatRows[0]?.chatId;
    if (chatId === undefined) return yield* Effect.fail(new Error("chat not found"));
    const persistMeasurement = (group: {
      readonly taskId: string;
      readonly loopIteration: number;
      readonly attempt: number;
      readonly providerRequestIndex: number;
      readonly requestSha256Hex: string;
      readonly proofs: readonly string[];
      readonly bindings: readonly {
        readonly providerSerializationProofSha256Hex: string;
        readonly providerSerializationProofBinding: ProviderVisibleSourceExposureProofBinding;
      }[];
    }) =>
      Effect.gen(function* () {
        const payload = {
          providerRequestIndex: group.providerRequestIndex,
          agentRole: providerRoleForTask(group.taskId),
          modelId: "glm-5-turbo",
          requestSha256Hex: group.requestSha256Hex,
          sourceExposureProofSha256Hexes: [...new Set(group.proofs)].sort(),
          sourceExposureProofBindings: group.bindings,
          inputTokens: 1,
          requestedOutputTokens: 2048,
          usableInputTokens: 100_000,
          contextWindow: 1_000_000,
          passed: true,
        };
        yield* insertAiObservation({
          runId: fixture.runId,
          chatId,
          emittingTask: group.taskId,
          loopIteration: group.loopIteration,
          attempt: group.attempt,
          observationKey: `fixture:provider-measurement:${group.taskId}:${group.loopIteration}:${group.attempt}:${group.providerRequestIndex}`,
          kind: "provider_request_measurement",
          payload,
        });
        yield* insertAiRunUsage({
          runId: fixture.runId,
          taskId: group.taskId,
          loopIteration: group.loopIteration,
          attempt: group.attempt,
          providerRequestIndex: group.providerRequestIndex,
          agentRole: providerRoleForTask(group.taskId),
          modelId: "glm-5-turbo",
          providerServiceId: "zai_coding_plan_official",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedTokens: 0,
            reasoningTokens: 0,
            totalTokens: 2,
            stopReason: "stop",
          },
        });
      });
    for (const group of groups.values()) {
      for (let index = 0; index < group.providerRequestIndex; index += 1) {
        const priorKey = [group.taskId, group.loopIteration, group.attempt, index].join(":");
        if (groups.has(priorKey)) continue;
        yield* persistMeasurement({
          ...group,
          providerRequestIndex: index,
          requestSha256Hex: "b".repeat(64),
          proofs: [],
          bindings: [],
        });
      }
      yield* persistMeasurement(group);
    }
  });

const seedTaskMeasurement = (
  fixture: Pick<Fixture, "runId">,
  taskId: string,
  providerRequestIndex = 0,
  context?: ContextState,
  sourceExposureProofSha256Hexes: readonly string[] = [],
  sourceExposureProofBindings: readonly {
    readonly providerSerializationProofSha256Hex: string;
    readonly providerSerializationProofBinding: ProviderVisibleSourceExposureProofBinding;
  }[] = [],
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly chatId: string }>`
      select chat_id::text as "chatId" from ai_runs where id = ${fixture.runId}
    `;
    const chatId = rows[0]?.chatId;
    if (chatId === undefined) return yield* Effect.fail(new Error("chat not found"));
    yield* insertAiObservation({
      runId: fixture.runId,
      chatId,
      emittingTask: taskId,
      loopIteration: 0,
      attempt: 0,
      observationKey: `fixture:provider-measurement:${taskId}:0:0:${providerRequestIndex}`,
      kind: "provider_request_measurement",
      payload: {
        providerRequestIndex,
        agentRole: providerRoleForTask(taskId),
        modelId: "glm-5-turbo",
        requestSha256Hex:
          context === undefined ? "c".repeat(64) : providerRequestSha256Hex(context.request),
        sourceExposureProofSha256Hexes,
        sourceExposureProofBindings,
        inputTokens: context?.inputTokens ?? 1,
        requestedOutputTokens: context?.request.requestedOutputTokens ?? 4096,
        usableInputTokens: context?.usableInputTokens ?? 100_000,
        contextWindow:
          context === undefined
            ? 1_000_000
            : resolveRegisteredModel(context.request.model).contextWindow,
        passed: true,
      },
    });
    yield* insertAiRunUsage({
      runId: fixture.runId,
      taskId,
      loopIteration: 0,
      attempt: 0,
      providerRequestIndex,
      agentRole: providerRoleForTask(taskId),
      modelId: "glm-5-turbo",
      providerServiceId: "zai_coding_plan_official",
      usage: {
        inputTokens: context?.inputTokens ?? 1,
        outputTokens: 1,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: (context?.inputTokens ?? 1) + 1,
        stopReason: "stop",
      },
    });
  });

const createFixtureWithCanonicalText = (
  canonicalText: string,
  publicSourceIds: readonly string[] = [],
  memorySeeds: readonly {
    readonly memoryId: string;
    readonly memoryRevisionId: string;
    readonly kind: "fact" | "preference" | "instruction";
    readonly content: string;
    readonly deleted?: boolean;
  }[] = [],
  webRequested = true,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const userId = `ai-publisher-reader-${crypto.randomUUID()}`;
    const publisherUserId = `ai-publisher-owner-${crypto.randomUUID()}`;
    const companyId = crypto.randomUUID();
    const publisherCompanyId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    const accessId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const pdfHash = createHash("sha256").update(canonicalText, "utf8").digest("hex");
    const chatId = crypto.randomUUID();
    yield* sql`
      insert into platform_users (id, primary_email, display_name, clerk_user_id)
      values (
        ${userId}, ${`${userId}@example.test`}, 'AI publisher reader',
        ${`clerk-${userId}`}
      )
    `;
    yield* sql`insert into client_companies (id, name) values (${companyId}, 'AI client')`;
    yield* sql`
    insert into client_company_memberships (company_id, user_id, role)
    values (${companyId}, ${userId}, 'admin')
  `;
    yield* sql`
    insert into client_company_ai_settings (company_id, web_search_enabled)
    values (${companyId}, false)
  `;
    for (const publicSourceId of publicSourceIds) {
      yield* sql`
        insert into client_company_public_source_settings (
          client_company_id, source_id, enabled, updated_by_user_id
        ) values (${companyId}, ${publicSourceId}, true, ${userId})
      `;
    }
    for (const memory of memorySeeds) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const state = {
            kind: memory.kind,
            content: memory.content,
            deleted: memory.deleted ?? false,
          } as const;
          yield* sql`
            insert into user_memories (id, user_id, kind, content, head_revision_id)
            values (${memory.memoryId}, ${userId}, ${memory.kind}, ${memory.content}, ${memory.memoryRevisionId})
          `;
          yield* sql`
            insert into user_memory_revisions (
              id, memory_id, action, state_before, state_after
            ) values (
              ${memory.memoryRevisionId}, ${memory.memoryId}, 'create', null,
              ${sql.json(state)}
            )
          `;
        }),
      );
    }
    yield* sql`
    insert into publisher_companies (id, name)
    values (${publisherCompanyId}, 'Canonical Publisher')
  `;
    yield* sql`
    insert into publisher_company_memberships (
      publisher_company_id, user_id, role, accepted_at
    ) values (${publisherCompanyId}, ${publisherUserId}, 'admin', now())
  `;
    yield* sql`
    insert into publisher_subscriptions (id, publisher_company_id, name, created_by_user_id)
    values (${subscriptionId}, ${publisherCompanyId}, 'Macro Source', ${publisherUserId})
  `;
    yield* sql`
    insert into client_subscription_accesses (
      id, subscription_id, client_company_id, state, first_admin_email,
      accepted_at, subscribed_at, created_by_user_id
    ) values (
      ${accessId}, ${subscriptionId}, ${companyId}, 'active', 'reader@example.test',
      now(), now(), ${publisherUserId}
    )
  `;
    yield* sql`
    insert into client_employee_subscription_grants (
      access_id, client_company_id, user_id, granted_by_user_id
    ) values (${accessId}, ${companyId}, ${userId}, ${userId})
  `;
    yield* sql`
    insert into publisher_issues (
      id, subscription_id, title, status, publication_at, indexing_status,
      created_by_user_id
    ) values (
      ${issueId}, ${subscriptionId}, 'July Macro Brief', 'draft', now(), 'pending',
      ${publisherUserId}
    )
  `;
    yield* sql`
    insert into brief_documents (
      id, issue_id, title, original_file_name, object_key, media_type, byte_size,
      sha256_hex, upload_completed_at, created_by_user_id
    ) values (
      ${documentId}, ${issueId}, 'Liquidity Outlook', 'liquidity.pdf',
      ${`publisher/${publisherCompanyId}/${documentId}.pdf`}, 'application/pdf', 42,
      ${pdfHash}, now(), ${publisherUserId}
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
        ${documentId}, ${pdfHash},
        ${JSON.stringify([{ pageNumber: 1, text: canonicalText }])}::jsonb,
        ${canonicalText.length}, ${jobs[0]!.id}
      )
      returning id::text
    `;
    yield* sql`
    insert into brief_document_versions (
      id, brief_document_id, publisher_extraction_id, content_hash, language, canonical_text,
      text_char_count, page_ranges
    ) values (
      ${snapshotId}, ${documentId}, ${extractions[0]!.id}, encode(digest(convert_to(${canonicalText}, 'UTF8'), 'sha256'), 'hex'), 'english',
      ${canonicalText}, ${canonicalText.length},
      ${JSON.stringify([{ pageNumber: 1, charStart: 0, charEnd: canonicalText.length }])}::jsonb
    )
  `;
    yield* sql`
    update brief_documents set current_version_id = ${snapshotId} where id = ${documentId}
  `;
    yield* sql`
    update publisher_issues
    set status = 'published', published_at = now(), indexing_status = 'ready'
    where id = ${issueId}
  `;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
        insert into issue_deliveries (
          issue_id, subscription_id, access_id, client_company_id, historical
        ) values (${issueId}, ${subscriptionId}, ${accessId}, ${companyId}, false)
      `;
        yield* sql`
        insert into issue_delivery_recipients (issue_id, client_company_id, user_id, delivered_at)
        select issue_id, client_company_id, ${userId}, delivered_at
        from issue_deliveries
        where issue_id = ${issueId} and client_company_id = ${companyId}
      `;
      }),
    );
    yield* sql`
    insert into chats (id, company_id, user_id, memory_mode)
    values (${chatId}, ${companyId}, ${userId}, 'private_owner')
  `;
    yield* sql`
    insert into chat_subscription_sources (chat_id, access_id, client_company_id, subscription_id)
    values (${chatId}, ${accessId}, ${companyId}, ${subscriptionId})
  `;
    const messages = yield* sql<{ readonly id: string }>`
    insert into chat_messages (chat_id, author, content)
    values (${chatId}, 'user', 'What changed in liquidity?')
    returning id::text
  `;
    const userMessageId = messages[0]?.id;
    if (userMessageId === undefined) return yield* Effect.fail(new Error("message insert failed"));
    const runs = yield* sql<{ readonly id: string }>`
    insert into ai_runs (
      chat_id, initiating_user_id, user_message_id, locale, market,
      acceptance_scope
    ) values (
      ${chatId}, ${userId}, ${userMessageId}, 'en-US', 'US',
      ${sql.json(
        makeRunAcceptanceScope({
          userId,
          chatId,
          companyId,
          subscriptionIds: [subscriptionId],
          accessIds: [accessId],
          publicSourceIds,
          webRequested,
          webEnabled: webRequested,
          memoryMode: "private_owner",
          memoryRevisionIds: memorySeeds.map((memory) => memory.memoryRevisionId),
        }),
      )}
    )
    returning id::text
  `;
    const runId = runs[0]?.id;
    if (runId === undefined) return yield* Effect.fail(new Error("run insert failed"));
    yield* sql`
      update ai_runs
      set smithers_run_id = ${`ai-chat:${runId}`}
      where id = ${runId}
    `;
    return {
      userId,
      companyId,
      accessId,
      issueId,
      documentId,
      snapshotId,
      extractionId: extractions[0]!.id,
      contentHash: createHash("sha256").update(canonicalText, "utf8").digest("hex"),
      runId,
      subscriptionId,
    } satisfies Fixture;
  });

const createFixture = createFixtureWithCanonicalText(
  "Liquidity conditions improved while inflation expectations remained anchored.",
);

interface PublicPreviewFixture extends Fixture {
  readonly publicSourceId: string;
  readonly publicDocumentId: string;
  readonly publicContentHash: string;
}

const createPublicPreviewFixture = (canonicalText: string) =>
  Effect.gen(function* () {
    const publicSourceId = `ai-public-preview-${crypto.randomUUID()}`;
    const publicUrl = `https://example.test/public-preview/${publicSourceId}`;
    const sql = yield* PgClient.PgClient;
    yield* sql`
      insert into public_sources (
        source_id, display_name, publisher_name, description, ingestion_method,
        discovery_url, average_chars_per_item, country, language
      ) values (
        ${publicSourceId}, 'Public Preview Source', 'Public Preview Publisher',
        'Repeated immutable preview fixture', 'rss', ${publicUrl}, 100, 'US', 'en-US'
      )
    `;
    const fixture = yield* createFixtureWithCanonicalText(
      "Liquidity conditions improved while inflation expectations remained anchored.",
      [publicSourceId],
    );
    const publicDocumentId = `ai-public-preview-document-${crypto.randomUUID()}`;
    const rawArtifactId = crypto.randomUUID();
    const canonicalUrl = `https://example.test/public-preview/${publicDocumentId}`;
    const contentHash = createHash("sha256").update(canonicalText, "utf8").digest("hex");
    const bodyHash = createHash("sha256").update("public preview body", "utf8").digest("hex");
    yield* sql`
      insert into public_source_raw_artifacts (
        id, source_id, canonical_url, fetched_at, media_type, body, body_hash
      ) values (
        ${rawArtifactId}, ${publicSourceId}, ${canonicalUrl}, now(),
        'text/html', 'public preview body', ${bodyHash}
      )
    `;
    yield* sql`
      insert into public_source_documents (
        document_id, source_id, canonical_url, title, published_at,
        discovered_at, fetched_at, language, document_type, text,
        text_char_count, content_hash, raw_artifact_id
      ) values (
        ${publicDocumentId}, ${publicSourceId}, ${canonicalUrl},
        'Public repeated preview', now(), now(), now(), 'en-US', 'article',
        ${canonicalText}, ${canonicalText.length}, ${contentHash}, ${rawArtifactId}
      )
    `;
    return {
      ...fixture,
      publicSourceId,
      publicDocumentId,
      publicContentHash: contentHash,
    } satisfies PublicPreviewFixture;
  });

class PublisherRetrievalAgent extends CanonicalAgentClient {
  onAfterFirstSearch?: () => Promise<void>;
  repeatInspection = false;
  malformedFirstSearch = false;
  skipInspection = false;
  selectWholeAfterInspection = false;
  narrowerRange = false;
  readonly selectedRange = { charStart: 0, charEnd: 120 } as const;
  firstInspectionWasTooLarge = false;
  narrowedInspectionText: string | undefined;

  constructor() {
    super(testProviderBoundary());
  }

  override async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    if (input.outputToolName !== "emit_plan_turn") {
      throw new Error(`unexpected structured call ${input.outputToolName}`);
    }
    return input.validate({
      mode: "single",
      question: "What changed in liquidity?",
      relevantTurnIds: [],
    });
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    const search = input.tools.find((tool) => tool.definition.name === "search_internal");
    const inspect = input.tools.find((tool) => tool.definition.name === "inspect_internal");
    if (search === undefined || inspect === undefined) throw new Error("missing internal tools");
    const coordinates: PiBoundaryCoordinates = {
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex: 0,
    };
    await invokeToolLoopProviderHook(input, coordinates);
    if (this.sourceId.startsWith("public:")) {
      return input.validateTerminal({ entries: [] });
    }
    let searchCoordinates = coordinates;
    if (this.malformedFirstSearch) {
      const rejected = await search.execute(
        {
          query: {
            target: "documents",
            terms: "liquidity conditions remained anchored",
            purpose: "answer the liquidity question",
          },
        },
        coordinates,
      );
      if (rejected.queryRejected !== true || rejected.correctionRequired !== true) {
        throw new Error("malformed first search was not returned as correction-only");
      }
      searchCoordinates = { ...coordinates, providerRequestIndex: 1 };
      await invokeToolLoopProviderHook(input, searchCoordinates);
    }
    const searchResult = await search.execute(
      {
        query: {
          target: "documents",
          terms: "liquidity",
          purpose: "answer the liquidity question",
        },
      },
      searchCoordinates,
    );
    const items = searchResult.items;
    if (!Array.isArray(items)) throw new Error("publisher search failed");
    if (items.length === 0) return input.validateTerminal({ entries: [] });
    if (items.length !== 1) throw new Error("publisher search returned multiple documents");
    if (this.expectedSearchSnippet !== undefined) {
      const item = items[0] as { readonly snippet?: unknown };
      if (item.snippet !== this.expectedSearchSnippet) {
        throw new Error("publisher search preview did not preserve exact repeated matches");
      }
    }
    if (
      !Array.isArray(searchResult.__briefSourceExposures) ||
      searchResult.__briefSourceExposures.length !== 1
    ) {
      throw new Error("publisher search did not include its bounded provider-visible marker");
    }
    await this.onAfterFirstSearch?.();
    if (this.onAfterFirstSearch !== undefined) {
      const driftedSearch = await search.execute(
        {
          query: {
            target: "documents",
            terms: "liquidity",
            purpose: "answer the liquidity question",
          },
        },
        { ...coordinates, providerRequestIndex: 1 },
      );
      if (!Array.isArray(driftedSearch.items)) throw new Error("publisher drift search failed");
    }
    const item = items[0] as {
      readonly documentId: string;
      readonly snapshotId: string;
      readonly publisherExtractionId: string;
      readonly source: {
        readonly kind: "publisher";
        readonly sourceId: string;
        readonly issueId: string;
        readonly documentId: string;
      };
    };
    const inspectionReference: InternalReference = {
      kind: "document",
      documentId: item.documentId,
      snapshotId: item.snapshotId,
      publisherExtractionId: item.publisherExtractionId,
      source: item.source,
      purpose: "answer the liquidity question",
    };
    const reference = {
      kind: "document",
      documentId: inspectionReference.documentId,
      purpose: inspectionReference.purpose,
    };
    const inspectionCoordinates = {
      ...coordinates,
      providerRequestIndex: this.malformedFirstSearch ? 2 : coordinates.providerRequestIndex,
    };
    if (this.malformedFirstSearch) {
      await invokeToolLoopProviderHook(input, inspectionCoordinates);
    }
    if (!this.skipInspection) {
      const firstInspection = await inspect.execute(
        {
          reference: {
            kind: "document",
            documentId: inspectionReference.documentId,
            purpose: inspectionReference.purpose,
          },
        },
        inspectionCoordinates,
      );
      this.firstInspectionWasTooLarge = firstInspection.narrowerRangeRequired === true;
      if (this.narrowerRange) {
        if (firstInspection.narrowerRangeRequired !== true) {
          throw new Error("oversized publisher inspection did not require a narrower range");
        }
        const narrowedCoordinates = {
          ...coordinates,
          providerRequestIndex: inspectionCoordinates.providerRequestIndex + 1,
        };
        await invokeToolLoopProviderHook(input, narrowedCoordinates);
        const inspection = await inspect.execute(
          {
            reference: {
              kind: "document",
              documentId: inspectionReference.documentId,
              range: this.selectedRange,
              purpose: inspectionReference.purpose,
            },
          },
          narrowedCoordinates,
        );
        if (inspection.found !== true || inspection.complete !== true) {
          throw new Error("narrowed publisher inspection failed");
        }
        if (typeof inspection.text !== "string") {
          throw new Error("narrowed publisher inspection did not return immutable text");
        }
        this.narrowedInspectionText = inspection.text;
        if (
          !Array.isArray(inspection.__briefSourceExposures) ||
          inspection.__briefSourceExposures.length !== 1
        ) {
          throw new Error("narrowed publisher inspection lacked its source exposure");
        }
      } else if (firstInspection.found !== true || firstInspection.complete !== true) {
        throw new Error("publisher inspection failed");
      } else if (
        !Array.isArray(firstInspection.__briefSourceExposures) ||
        firstInspection.__briefSourceExposures.length !== 1
      ) {
        throw new Error("publisher inspection did not include its bounded provider-visible marker");
      }
    }
    if (this.repeatInspection) {
      const repeatedInspection = await inspect.execute(
        {
          reference: {
            kind: "document",
            documentId: inspectionReference.documentId,
            purpose: inspectionReference.purpose,
          },
        },
        coordinates,
      );
      if (
        repeatedInspection.protocolError !== "internal inspection repeated a completed reference"
      ) {
        throw new Error("repeated publisher inspection was not closed by protocol recovery");
      }
    }
    const terminalReference = this.narrowerRange
      ? { ...reference, ranges: [this.selectedRange] }
      : reference;
    await invokeToolLoopProviderHook(input, {
      ...coordinates,
      providerRequestIndex: this.narrowerRange
        ? this.malformedFirstSearch
          ? 4
          : 2
        : this.malformedFirstSearch
          ? 3
          : 1,
    });
    return (this.duplicateManifest
      ? [terminalReference, terminalReference]
      : [terminalReference]) as unknown as Output;
  }

  sourceId = "";
  sourceName = "Canonical Publisher";
  duplicateManifest = false;
  expectedSearchSnippet: string | undefined;
}

class CorrectingReducerAgent extends CanonicalAgentClient {
  readonly feedback: unknown[] = [];
  private callCount = 0;

  constructor(private readonly firstPlan: "invalid" | "oversized") {
    super(testProviderBoundary());
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    if (input.terminalToolName !== "emit_context_plan") {
      throw new Error(`unexpected tool loop ${input.terminalToolName}`);
    }
    const request = JSON.parse(input.user) as {
      readonly candidates: readonly { readonly id: string }[];
      readonly priorValidationFeedback: unknown;
    };
    await invokeToolLoopProviderHook(input, {
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex: 0,
    });
    this.feedback.push(request.priorValidationFeedback);
    this.callCount += 1;
    const decisions =
      this.callCount === 1
        ? this.firstPlan === "invalid"
          ? []
          : request.candidates.map((candidate) => ({
              id: candidate.id,
              action: "keep" as const,
              reason: "keep the complete selected evidence",
            }))
        : request.candidates.map((candidate) => ({
            id: candidate.id,
            action: "omit" as const,
            reason: "omit evidence to satisfy the exact allowance",
          }));
    return input.validateTerminal({ decisions });
  }
}

type ReducerProtocolProbeMode = "valid" | "invalid-after-success" | "unmeasured" | "drift";

class ReducerProtocolProbeAgent extends CanonicalAgentClient {
  constructor(private readonly mode: ReducerProtocolProbeMode) {
    super(testProviderBoundary());
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    if (input.terminalToolName !== "emit_context_plan") {
      throw new Error(`unexpected tool loop ${input.terminalToolName}`);
    }
    const measure = input.tools.find((tool) => tool.definition.name === "measure_plan");
    if (measure === undefined) throw new Error("missing reducer measurement tool");
    const candidateIds = (
      JSON.parse(input.user) as { readonly candidates: readonly { readonly id: string }[] }
    ).candidates.map((candidate) => candidate.id);
    const decisions = candidateIds.map((id) => ({
      id,
      action: "omit" as const,
      reason: "omit for protocol validation",
    }));
    const driftedDecisions = candidateIds.map((id) => ({
      id,
      action: "keep" as const,
      reason: "drift from the measured plan",
    }));
    const coordinatesAt = (providerRequestIndex: number): PiBoundaryCoordinates => ({
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex,
    });
    const completionFor = (arguments_: Readonly<Record<string, unknown>>): PiCompletion => ({
      text: "",
      toolCalls: [{ id: "terminal", name: "emit_context_plan", arguments: arguments_ }],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 2,
        stopReason: "toolUse",
      },
      stopReason: "toolUse",
    });
    const measureAt = async (
      value: readonly unknown[],
      providerRequestIndex: number,
    ): Promise<Readonly<Record<string, unknown>>> => {
      const coordinates = coordinatesAt(providerRequestIndex);
      await invokeToolLoopProviderHook(input, coordinates);
      return measure.execute({ decisions: value }, coordinates);
    };
    const terminalAt = async (
      value: readonly unknown[],
      providerRequestIndex: number,
    ): Promise<Output> => {
      const coordinates = coordinatesAt(providerRequestIndex);
      await invokeToolLoopProviderHook(input, coordinates);
      const output = input.validateTerminal({ decisions: value });
      await input.onTerminal?.(output, coordinates, completionFor({ decisions: value }));
      return output;
    };

    if (this.mode === "unmeasured") return terminalAt(decisions, 0);
    await measureAt(decisions, 0);
    if (this.mode === "invalid-after-success") {
      await measureAt([], 1);
      return terminalAt(decisions, 2);
    }
    return terminalAt(this.mode === "drift" ? driftedDecisions : decisions, 1);
  }
}

class WebManifestAgent extends CanonicalAgentClient {
  constructor(
    private readonly quote: string,
    private readonly mode:
      | "valid"
      | "direct-fetch"
      | "undiscovered-fetch"
      | "same-turn-fetch"
      | "repeat-fetch"
      | "duplicate"
      | "duplicate-url"
      | "terminal-first"
      | "fetch-fallback"
      | "empty-after-fetch" = "valid",
  ) {
    super(testProviderBoundary());
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    if (input.terminalToolName !== "emit_web_evidence") {
      throw new Error(`unexpected tool loop ${input.terminalToolName}`);
    }
    if (input.reserveFinalTurnForTerminal !== true) {
      throw new Error("web research must reserve its final provider turn for terminal output");
    }
    const search = input.tools.find((tool) => tool.definition.name === "web_search");
    const fetch = input.tools.find((tool) => tool.definition.name === "web_fetch");
    if (search === undefined || fetch === undefined) throw new Error("missing web tools");
    const coordinates: PiBoundaryCoordinates = {
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex: 0,
    };
    await invokeToolLoopProviderHook(input, coordinates);
    let terminalCoordinates = { ...coordinates, providerRequestIndex: 2 };
    if (this.mode === "terminal-first") {
      const output = input.validateTerminal({ entries: [] });
      await input.onTerminal?.(output, coordinates, {
        text: "",
        toolCalls: [{ id: "terminal", name: "emit_web_evidence", arguments: { entries: [] } }],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedTokens: 0,
          reasoningTokens: 0,
          totalTokens: 2,
          stopReason: "toolUse",
        },
        stopReason: "toolUse",
      } satisfies PiCompletion);
      return output;
    }
    if (this.mode === "direct-fetch") {
      await fetch.execute({ url: "https://official.example/start" }, coordinates);
      throw new Error("direct fetch fixture unexpectedly succeeded");
    }
    const searchResult = await search.execute({ query: "official report" }, coordinates);
    if (searchResult.complete !== true || searchResult.truncated === true) {
      throw new Error("web search fixture did not complete");
    }
    const discoveredUrls = (searchResult.results as readonly { readonly url: string }[]).map(
      (result) => result.url,
    );
    const discovered = discoveredUrls[0];
    if (discovered === undefined) throw new Error("web search fixture returned no URL");
    const fetchCoordinates = {
      ...coordinates,
      providerRequestIndex: this.mode === "same-turn-fetch" ? 0 : 1,
    };
    await invokeToolLoopProviderHook(input, fetchCoordinates);
    const fetchUrl =
      this.mode === "undiscovered-fetch" ? "https://official.example/not-discovered" : discovered;
    let page: { readonly url?: string; readonly fetchFailed?: boolean };
    try {
      page = (await fetch.execute({ url: fetchUrl }, fetchCoordinates)) as typeof page;
    } catch (error) {
      if (this.mode !== "fetch-fallback") throw error;
      const recovered = input.recoverToolError?.(
        "web_fetch",
        { url: fetchUrl },
        error,
        fetchCoordinates,
      );
      if (recovered === undefined) throw error;
      page = recovered as typeof page;
    }
    if (this.mode === "fetch-fallback") {
      if (page.fetchFailed !== true) throw new Error("first web fetch did not fail recoverably");
      const fallbackUrl = discoveredUrls[1];
      if (fallbackUrl === undefined) throw new Error("web search fixture returned no fallback URL");
      const fallbackCoordinates = { ...coordinates, providerRequestIndex: 2 };
      await invokeToolLoopProviderHook(input, fallbackCoordinates);
      page = (await fetch.execute({ url: fallbackUrl }, fallbackCoordinates)) as {
        readonly url?: string;
      };
      terminalCoordinates = { ...coordinates, providerRequestIndex: 3 };
    }
    if (this.mode === "repeat-fetch") {
      const repeated = await fetch.execute({ url: fetchUrl }, fetchCoordinates);
      if (repeated.protocolError !== "web fetch cannot continue after a fetched page") {
        throw new Error("repeat web fetch was not closed by protocol recovery");
      }
    }
    await invokeToolLoopProviderHook(input, terminalCoordinates);
    if (this.mode === "empty-after-fetch") {
      return input.validateTerminal({ entries: [] });
    }
    if (page.url === undefined) throw new Error("web fetch fixture returned no page URL");
    const entry = {
      url: page.url,
      title: "Fabricated model title",
      domain: "fabricated.example",
      quote: this.quote,
      publishedAt: "1999-01-01T00:00:00.000Z",
      capturedAt: "1999-01-01T00:00:00.000Z",
      purpose: "answer from the official report",
    };
    const output = input.validateTerminal({
      entries:
        this.mode === "duplicate"
          ? [entry, entry]
          : this.mode === "duplicate-url"
            ? [entry, { ...entry, quote: "Published findings." }]
            : [entry],
    });
    await input.onTerminal?.(output, terminalCoordinates, {
      text: "",
      toolCalls: [{ id: "terminal", name: "emit_web_evidence", arguments: { entries: output } }],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 2,
        stopReason: "toolUse",
      },
      stopReason: "toolUse",
    } satisfies PiCompletion);
    return output;
  }
}

class MemoryManifestAgent extends CanonicalAgentClient {
  constructor(private readonly entries: readonly MemoryReference[]) {
    super(testProviderBoundary());
  }

  override async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    if (input.outputToolName !== "emit_memory_manifest") {
      throw new Error(`unexpected structured call ${input.outputToolName}`);
    }
    await invokeStructuredProviderHook(input);
    return input.validate({ entries: this.entries });
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    if (input.terminalToolName !== "emit_memory_manifest") {
      throw new Error(`unexpected tool loop ${input.terminalToolName}`);
    }
    const coordinates = {
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex: 0,
    };
    await invokeToolLoopProviderHook(input, coordinates);
    const search = input.tools.find((tool) => tool.definition.name === "search_memories");
    const inspect = input.tools.find((tool) => tool.definition.name === "inspect_memory");
    if (search === undefined || inspect === undefined) throw new Error("missing memory tools");
    await search.execute({ query: "client" }, coordinates);
    for (const entry of this.entries) {
      await inspect.execute({ memoryId: entry.memoryId }, coordinates);
    }
    const output = input.validateTerminal({ entries: this.entries });
    await input.onTerminal?.(output, coordinates, {
      text: "",
      toolCalls: [
        {
          id: "memory-terminal",
          name: "emit_memory_manifest",
          arguments: { entries: this.entries },
        },
      ],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 2,
        stopReason: "toolUse",
      },
      stopReason: "toolUse",
    });
    return output;
  }
}

class EmptyInventoryConversationAgent extends CanonicalAgentClient {
  calls = 0;
  entries: unknown = null;

  constructor() {
    super(testProviderBoundary());
  }

  override async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    if (input.outputToolName !== "emit_plan_turn") {
      throw new Error(`unexpected structured call ${input.outputToolName}`);
    }
    this.calls += 1;
    this.entries = (JSON.parse(input.user) as { readonly entries: unknown }).entries;
    await invokeStructuredProviderHook(input);
    return input.validate({
      mode: "single",
      question: "What changed in liquidity?",
      relevantTurnIds: [],
    });
  }
}

class DateBoundaryInputAgent extends CanonicalAgentClient {
  readonly planInputs: string[] = [];
  readonly retrievalInputs: string[] = [];

  constructor() {
    super(testProviderBoundary());
  }

  override async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    if (input.outputToolName !== "emit_plan_turn") {
      throw new Error(`unexpected structured call ${input.outputToolName}`);
    }
    this.planInputs.push(input.user);
    await invokeStructuredProviderHook(input);
    return input.validate({
      mode: "single",
      question: "What changed in liquidity?",
      relevantTurnIds: [],
    });
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    if (input.terminalToolName !== "emit_internal_manifest") {
      throw new Error(`unexpected tool loop ${input.terminalToolName}`);
    }
    this.retrievalInputs.push(input.user);
    const search = input.tools.find((tool) => tool.definition.name === "search_internal");
    if (search === undefined) throw new Error("internal search tool is missing");
    const coordinates = {
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex: 0,
    };
    await invokeToolLoopProviderHook(input, coordinates);
    const result = await search.execute(
      {
        query: {
          target: "chat_messages",
          terms: "zzboundarytoken",
          purpose: "verify stable retry input",
        },
      },
      coordinates,
    );
    if (result.complete !== true || !Array.isArray(result.items) || result.items.length !== 0) {
      throw new Error("date-boundary search fixture must complete empty");
    }
    await invokeToolLoopProviderHook(input, {
      ...coordinates,
      providerRequestIndex: 1,
    });
    return input.validateTerminal({ entries: [] });
  }
}

class UndiscoveredInternalAgent extends CanonicalAgentClient {
  constructor(private readonly reference: InternalReference) {
    super(testProviderBoundary());
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    if (input.terminalToolName !== "emit_internal_manifest") {
      throw new Error(`unexpected tool loop ${input.terminalToolName}`);
    }
    await invokeToolLoopProviderHook(input, {
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex: 0,
    });
    return input.validateTerminal({
      entries: [
        this.reference.kind === "document"
          ? {
              kind: "document",
              documentId: this.reference.documentId,
              purpose: this.reference.purpose,
            }
          : this.reference,
      ],
    });
  }
}

class ChatRetrievalAgent extends CanonicalAgentClient {
  seenMessageIds: readonly string[] = [];
  seenSnippets: readonly string[] = [];
  inspectedContent = "";

  constructor(private readonly beforeMessageId?: string) {
    super(testProviderBoundary());
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    if (input.terminalToolName !== "emit_internal_manifest") {
      throw new Error(`unexpected tool loop ${input.terminalToolName}`);
    }
    const search = input.tools.find((tool) => tool.definition.name === "search_internal");
    const inspect = input.tools.find((tool) => tool.definition.name === "inspect_internal");
    if (search === undefined || inspect === undefined) throw new Error("missing internal tools");
    const coordinates: PiBoundaryCoordinates = {
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex: 0,
    };
    await invokeToolLoopProviderHook(input, coordinates);
    const result = (await search.execute(
      {
        query: {
          target: "chat_messages",
          terms: "needle",
          purpose: "recover an older statement",
          ...(this.beforeMessageId === undefined ? {} : { beforeMessageId: this.beforeMessageId }),
        },
      },
      coordinates,
    )) as {
      readonly items: readonly {
        readonly messageId: string;
        readonly snippet: string;
      }[];
    };
    this.seenMessageIds = result.items.map((item) => item.messageId);
    this.seenSnippets = result.items.map((item) => item.snippet);
    const first = result.items[0];
    if (first === undefined) return input.validateTerminal({ entries: [] });
    const reference: InternalReference = {
      kind: "chat_message",
      messageId: first.messageId,
      purpose: "recover an older statement",
    };
    const inspected = (await inspect.execute({ reference }, coordinates)) as {
      readonly found: boolean;
      readonly complete: boolean;
      readonly message?: { readonly content: string };
    };
    if (!inspected.found || !inspected.complete || inspected.message === undefined) {
      throw new Error("chat inspection failed");
    }
    this.inspectedContent = inspected.message.content;
    await invokeToolLoopProviderHook(input, { ...coordinates, providerRequestIndex: 1 });
    return input.validateTerminal({ entries: [reference] });
  }
}

class ExhaustedInternalSearchAgent extends CanonicalAgentClient {
  terminalReady = false;

  constructor() {
    super(testProviderBoundary());
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    const search = input.tools.find((tool) => tool.definition.name === "search_internal");
    if (search === undefined) throw new Error("missing internal search tool");
    const firstCoordinates: PiBoundaryCoordinates = {
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex: 0,
    };
    await invokeToolLoopProviderHook(input, firstCoordinates);
    const first = await search.execute(
      {
        query: {
          target: "chat_messages",
          terms: "absent missing",
          purpose: "establish that no older message matches",
        },
      },
      firstCoordinates,
    );
    if (!Array.isArray(first.items) || first.items.length !== 0) {
      throw new Error("first empty search unexpectedly found a message");
    }
    const secondCoordinates = { ...firstCoordinates, providerRequestIndex: 1 };
    await invokeToolLoopProviderHook(input, secondCoordinates);
    const second = await search.execute(
      {
        query: {
          target: "chat_messages",
          terms: "absent",
          purpose: "refine the empty older-message search",
        },
      },
      secondCoordinates,
    );
    if (!Array.isArray(second.items) || second.items.length !== 0) {
      throw new Error("refined empty search unexpectedly found a message");
    }
    this.terminalReady = input.terminalOnlyForTurn?.(2) === true;
    return input.validateTerminal({ entries: [] });
  }
}

class ExhaustedNonEmptyInternalSearchAgent extends CanonicalAgentClient {
  inspectionAvailable = false;
  terminalReady = false;

  constructor() {
    super(testProviderBoundary());
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    const search = input.tools.find((tool) => tool.definition.name === "search_internal");
    const inspect = input.tools.find((tool) => tool.definition.name === "inspect_internal");
    if (search === undefined || inspect === undefined) throw new Error("missing internal tools");
    const coordinates: PiBoundaryCoordinates = {
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex: 0,
    };
    await invokeToolLoopProviderHook(input, coordinates);
    const first = await search.execute(
      {
        query: {
          target: "chat_messages",
          terms: "needle",
          purpose: "find the first comparison subject",
        },
      },
      coordinates,
    );
    const firstItems = first.items;
    if (!Array.isArray(firstItems)) {
      throw new Error("first non-empty search returned no result array");
    }
    const firstItem = firstItems[0];
    if (
      firstItem === null ||
      typeof firstItem !== "object" ||
      !("messageId" in firstItem) ||
      typeof firstItem.messageId !== "string"
    ) {
      throw new Error("first non-empty search returned no message");
    }

    const secondCoordinates = { ...coordinates, providerRequestIndex: 1 };
    await invokeToolLoopProviderHook(input, secondCoordinates);
    const second = await search.execute(
      {
        query: {
          target: "chat_messages",
          terms: "statement",
          purpose: "find the second comparison subject",
        },
      },
      secondCoordinates,
    );
    if (!Array.isArray(second.items) || second.items.length === 0) {
      throw new Error("second non-empty search returned no message");
    }

    this.inspectionAvailable =
      input.terminalOnlyForTurn?.(2) !== true &&
      input.disabledToolsForTurn?.(2)?.includes("search_internal") === true;
    const inspectionCoordinates = { ...coordinates, providerRequestIndex: 2 };
    await invokeToolLoopProviderHook(input, inspectionCoordinates);
    const reference: InternalReference = {
      kind: "chat_message",
      messageId: firstItem.messageId,
      purpose: "recover the comparison evidence",
    };
    const inspection = await inspect.execute({ reference }, inspectionCoordinates);
    if (inspection.found !== true || inspection.complete !== true) {
      throw new Error("post-search inspection failed");
    }

    await invokeToolLoopProviderHook(input, { ...coordinates, providerRequestIndex: 3 });
    this.terminalReady = input.terminalOnlyForTurn?.(3) === true;
    return input.validateTerminal({ entries: [reference] });
  }
}

class MalformedInspectionRecoveryAgent extends CanonicalAgentClient {
  recoveredReferenceCount = 0;

  constructor() {
    super(testProviderBoundary());
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    const search = input.tools.find((tool) => tool.definition.name === "search_internal");
    if (search === undefined) throw new Error("missing internal search tool");
    const coordinates: PiBoundaryCoordinates = {
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex: 0,
    };
    await invokeToolLoopProviderHook(input, coordinates);
    const result = await search.execute(
      {
        query: {
          target: "chat_messages",
          terms: "firstsubject",
          purpose: "find evidence before malformed inspection",
        },
      },
      coordinates,
    );
    if (!Array.isArray(result.items) || result.items.length === 0) {
      throw new Error("recovery search returned no message");
    }
    const malformedCoordinates = { ...coordinates, providerRequestIndex: 1 };
    await invokeToolLoopProviderHook(input, malformedCoordinates);
    const recovery = input.recoverMalformedToolCall?.(
      "inspect_internal",
      new Error("tool call inspect_internal arguments failed its strict schema"),
      malformedCoordinates,
    );
    if (recovery === undefined || !Array.isArray(recovery.recoveryReferences)) {
      throw new Error("malformed inspection did not expose recovery references");
    }
    this.recoveredReferenceCount = recovery.recoveryReferences.length;
    await invokeToolLoopProviderHook(input, { ...coordinates, providerRequestIndex: 2 });
    return input.validateTerminal({ entries: [] });
  }
}

class SecondSearchCursorContinuationAgent extends CanonicalAgentClient {
  continuationCalls = 0;
  searchVisibleDuringContinuation = true;
  searchDisabledAfterContinuation = false;

  constructor() {
    super(testProviderBoundary());
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    const search = input.tools.find((tool) => tool.definition.name === "search_internal");
    const inspect = input.tools.find((tool) => tool.definition.name === "inspect_internal");
    if (search === undefined || inspect === undefined) throw new Error("missing internal tools");
    const baseCoordinates: PiBoundaryCoordinates = {
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex: 0,
    };
    await invokeToolLoopProviderHook(input, baseCoordinates);
    const first = await search.execute(
      {
        query: {
          target: "chat_messages",
          terms: "firstsubject",
          purpose: "find the first comparison subject",
        },
      },
      baseCoordinates,
    );
    const firstItems = first.items;
    if (!Array.isArray(firstItems)) throw new Error("first search returned no result array");
    const firstItem = firstItems[0];
    if (
      firstItem === null ||
      typeof firstItem !== "object" ||
      !("messageId" in firstItem) ||
      typeof firstItem.messageId !== "string"
    ) {
      throw new Error("first search returned no message");
    }

    const pagedQuery = {
      target: "chat_messages" as const,
      terms: "cursorpage marker",
      purpose: "find the second comparison subject",
    };
    let providerRequestIndex = 1;
    let coordinates = { ...baseCoordinates, providerRequestIndex };
    await invokeToolLoopProviderHook(input, coordinates);
    let page = await search.execute({ query: pagedQuery }, coordinates);
    if (page.complete !== false || typeof page.cursor !== "number") {
      throw new Error("second ordinary search did not create a cursor obligation");
    }
    while (page.complete !== true) {
      this.searchVisibleDuringContinuation &&=
        input.disabledToolsForTurn?.(providerRequestIndex + 1)?.includes("search_internal") !==
        true;
      const cursor = page.cursor;
      if (typeof cursor !== "number") {
        throw new Error("incomplete search page omitted its cursor");
      }
      providerRequestIndex += 1;
      coordinates = { ...baseCoordinates, providerRequestIndex };
      await invokeToolLoopProviderHook(input, coordinates);
      page = await search.execute({ query: pagedQuery, cursor }, coordinates);
      this.continuationCalls += 1;
      if (this.continuationCalls > 20) throw new Error("cursor continuation did not terminate");
    }
    this.searchDisabledAfterContinuation =
      input.disabledToolsForTurn?.(providerRequestIndex + 1)?.includes("search_internal") === true;

    providerRequestIndex += 1;
    coordinates = { ...baseCoordinates, providerRequestIndex };
    await invokeToolLoopProviderHook(input, coordinates);
    const reference: InternalReference = {
      kind: "chat_message",
      messageId: firstItem.messageId,
      purpose: "recover the first comparison subject",
    };
    const inspection = await inspect.execute({ reference }, coordinates);
    if (inspection.found !== true || inspection.complete !== true) {
      throw new Error("cursor test inspection failed");
    }
    await invokeToolLoopProviderHook(input, {
      ...baseCoordinates,
      providerRequestIndex: providerRequestIndex + 1,
    });
    return input.validateTerminal({ entries: [reference] });
  }
}

class NamedSourceCursorContinuationAgent extends CanonicalAgentClient {
  continuationCalls = 0;
  reboundReuseRejected = false;

  constructor() {
    super(testProviderBoundary());
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    type NamedSourcePage = {
      readonly complete: boolean;
      readonly cursor: number | null;
      readonly items: readonly {
        readonly documentId: string;
        readonly __briefSourceIdentity?: {
          readonly source?: { readonly kind?: string } | undefined;
        };
      }[];
    };
    const lookup = input.tools.find((tool) => tool.definition.name === "lookup_named_source");
    const search = input.tools.find((tool) => tool.definition.name === "search_internal");
    const inspect = input.tools.find((tool) => tool.definition.name === "inspect_internal");
    if (lookup === undefined || search === undefined || inspect === undefined) {
      throw new Error("missing named-source retrieval tools");
    }
    const baseCoordinates: PiBoundaryCoordinates = {
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex: 0,
    };
    await invokeToolLoopProviderHook(input, baseCoordinates);
    const lookupResult = (await lookup.execute(
      { name: "Canonical Publisher" },
      baseCoordinates,
    )) as {
      readonly found: boolean;
      readonly lookupRef: string | null;
    };
    if (!lookupResult.found || lookupResult.lookupRef === null) {
      throw new Error("named-source lookup did not find the publisher");
    }
    const query = {
      target: "documents" as const,
      terms: "liquidity",
      purpose: "paginate a named-source search",
      lookupRef: lookupResult.lookupRef,
      limit: 50,
    };
    let providerRequestIndex = 1;
    let coordinates = { ...baseCoordinates, providerRequestIndex };
    await invokeToolLoopProviderHook(input, coordinates);
    let page = (await search.execute({ query }, coordinates)) as unknown as NamedSourcePage;
    if (page.complete !== false || typeof page.cursor !== "number") {
      throw new Error("named-source search did not create a cursor obligation");
    }
    const discoveredItems = [...page.items];
    let previousCursor = -1;
    while (page.complete !== true) {
      const cursor = page.cursor;
      if (typeof cursor !== "number") throw new Error("named-source page omitted its cursor");
      if (cursor <= previousCursor) {
        throw new Error("named-source cursor did not advance");
      }
      previousCursor = cursor;
      providerRequestIndex += 1;
      coordinates = { ...baseCoordinates, providerRequestIndex };
      await invokeToolLoopProviderHook(input, coordinates);
      page = (await search.execute({ query, cursor }, coordinates)) as unknown as NamedSourcePage;
      discoveredItems.push(...page.items);
      this.continuationCalls += 1;
      if (this.continuationCalls > 20) {
        throw new Error("named-source cursor continuation did not terminate");
      }
    }
    if (this.continuationCalls === 0 || discoveredItems.length < 2) {
      throw new Error("named-source pagination did not expose all documents");
    }

    providerRequestIndex += 1;
    coordinates = { ...baseCoordinates, providerRequestIndex };
    await invokeToolLoopProviderHook(input, coordinates);
    try {
      await search.execute(
        {
          query: {
            ...query,
            terms: "anchored",
            purpose: "try to reuse the named-source handoff",
          },
        },
        coordinates,
      );
    } catch (error) {
      this.reboundReuseRejected =
        error instanceof Error && error.message.includes("named-source lookupRef");
    }
    if (!this.reboundReuseRejected) {
      throw new Error("named-source handoff was rebound to another search");
    }

    const item = discoveredItems[0];
    if (item === undefined || item.__briefSourceIdentity?.source?.kind !== "publisher") {
      throw new Error(
        `named-source search returned no publisher document: ${JSON.stringify(item)}`,
      );
    }
    const reference = {
      kind: "document" as const,
      documentId: item.documentId,
      purpose: "paginate a named-source search",
    };
    const inspection = await inspect.execute({ reference }, coordinates);
    if (inspection.found !== true || inspection.complete !== true) {
      throw new Error("named-source inspection failed");
    }
    await invokeToolLoopProviderHook(input, {
      ...baseCoordinates,
      providerRequestIndex: providerRequestIndex + 1,
    });
    return input.validateTerminal({ entries: [reference] });
  }
}

class PublicRetrievalAgent extends CanonicalAgentClient {
  constructor(private readonly expectedSearchSnippet: string) {
    super(testProviderBoundary());
  }

  override async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    if (input.outputToolName !== "emit_plan_turn") {
      throw new Error(`unexpected structured call ${input.outputToolName}`);
    }
    return input.validate({
      mode: "single",
      question: "What changed in the public signal?",
      relevantTurnIds: [],
    });
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    const search = input.tools.find((tool) => tool.definition.name === "search_internal");
    const inspect = input.tools.find((tool) => tool.definition.name === "inspect_internal");
    if (search === undefined || inspect === undefined) throw new Error("missing internal tools");
    const coordinates: PiBoundaryCoordinates = {
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex: 0,
    };
    await invokeToolLoopProviderHook(input, coordinates);
    const searchResult = await search.execute(
      {
        query: {
          target: "documents",
          terms: "beacon",
          purpose: "answer the public signal question",
        },
      },
      coordinates,
    );
    if (!Array.isArray(searchResult.items) || searchResult.items.length !== 1) {
      throw new Error("public search failed");
    }
    const item = searchResult.items[0] as {
      readonly documentId: string;
      readonly snippet?: unknown;
    };
    if (item.snippet !== this.expectedSearchSnippet) {
      throw new Error("public search preview did not preserve exact repeated matches");
    }
    if (
      !Array.isArray(searchResult.__briefSourceExposures) ||
      searchResult.__briefSourceExposures.length !== 1
    ) {
      throw new Error("public search did not include its bounded provider-visible marker");
    }
    const reference = {
      kind: "document" as const,
      documentId: item.documentId,
      purpose: "answer the public signal question",
    };
    const inspection = await inspect.execute({ reference }, coordinates);
    if (inspection.found !== true || inspection.complete !== true) {
      throw new Error("public inspection failed");
    }
    await invokeToolLoopProviderHook(input, { ...coordinates, providerRequestIndex: 1 });
    return input.validateTerminal({ entries: [reference] });
  }
}

describe.skipIf(databaseUrl === undefined)("canonical publisher evidence operations", () => {
  beforeAll(async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`).raw;
      }),
      databaseUrlFor("postgres"),
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
        yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`).raw;
      }),
      databaseUrlFor("postgres"),
    );
  }, 60_000);

  it("loads the saved provider profile after live provider drift", async () => {
    const fixture = await runDb(createFixture);
    let boundProfile: AcceptedProviderProfile | undefined;
    const agent = new CanonicalAgentClient({
      bindAcceptedProviderProfile: (profile: AcceptedProviderProfile) => {
        boundProfile = profile;
      },
    } as unknown as ExactPiBoundary);
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
        providerServiceId: "openai_compatible_custom",
        providerEndpointIdentity: "openai_compatible_custom:https://live-drift.example/v1",
      },
      agent,
    );

    await expect(
      inTask("load-turn", () => operations.loadTurn(fixture.runId)),
    ).resolves.toMatchObject({
      acceptanceScope: {
        provider: "zai_coding_plan_official",
        providerEndpointIdentity: "zai_coding_plan_official:https://api.z.ai/api/coding/paas/v4",
      },
    });
    expect(boundProfile).toEqual({
      providerServiceId: "zai_coding_plan_official",
      providerEndpointIdentity: "zai_coding_plan_official:https://api.z.ai/api/coding/paas/v4",
      fastModelId: "glm-5-turbo",
      mainModelId: "glm-5-turbo",
    });
  }, 120_000);

  it("persists distinct owning coordinates for retries across Smithers loop iterations", async () => {
    const fixture = await runDb(createFixture);
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      new EmptyInventoryConversationAgent(),
    );
    let load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const run = (iteration: number, attempt: number) => {
      const controller = new AbortController();
      return withTaskRuntime(
        {
          runId: `ai-chat:${fixture.runId}`,
          stepId: "plan-turn",
          attempt,
          iteration,
          signal: controller.signal,
          db: {},
          heartbeat: () => undefined,
          lastHeartbeat: null,
        },
        () => operations.planTurn(load),
      );
    };

    await run(0, 1);
    await run(1, 2);
    const observations = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{
          readonly emittingTask: string;
          readonly loopIteration: number;
          readonly attempt: number;
        }>`
          select emitting_task as "emittingTask", loop_iteration::int as "loopIteration",
                 attempt::int as attempt
          from ai_observations
          where run_id = ${fixture.runId}
            and kind = 'turn_plan'
          order by loop_iteration, attempt
        `;
      }),
    );
    expect(observations).toEqual([
      { emittingTask: "plan-turn", loopIteration: 0, attempt: 1 },
      { emittingTask: "plan-turn", loopIteration: 1, attempt: 2 },
    ]);
  });

  it("keeps plan and retrieval input stable when delayed retries cross a UTC date boundary", async () => {
    const fixture = await runDb(createFixture);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_runs
          set created_at = '2026-07-10T23:59:59.500Z'::timestamptz
          where id = ${fixture.runId}
        `;
      }),
    );
    const config = {
      aiMainModel: "glm-5-turbo" as const,
      aiFastModel: "glm-5-turbo" as const,
      aiMainInputMaxTokens: 100_000,
      aiMainOutputMaxTokens: 4096,
      aiFastInputMaxTokens: 100_000,
      aiFastOutputMaxTokens: 4096,
      aiConversationRecentTurns: 12,
      aiFanoutMaxTopics: 3,
      aiRetrievalMaxTurns: 4,
      aiInternalMaxSearches: 4,
      aiInternalMaxInspections: 4,
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
      aiContextReductionMaxIterations: 2,
      aiMemoryToolResultMaxItems: 20,
      webResearchProvider: "" as const,
    } satisfies CanonicalAiConfig;
    const agent = new DateBoundaryInputAgent();
    const beforeBoundary = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      config,
      agent,
      undefined,
      () => new Date("2026-07-10T23:59:59.750Z"),
    );
    const afterBoundary = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      config,
      agent,
      undefined,
      () => new Date("2026-07-11T00:00:00.250Z"),
    );

    const firstLoad = await inTask("load-turn", () => beforeBoundary.loadTurn(fixture.runId), {
      attempt: 1,
    });
    const retryLoad = await inTask("load-turn", () => afterBoundary.loadTurn(fixture.runId), {
      attempt: 2,
    });
    expect(firstLoad.currentDate).toBe("2026-07-10");
    expect(retryLoad).toEqual(firstLoad);
    expect(retryLoad.acceptanceScope).toEqual(firstLoad.acceptanceScope);
    expect(retryLoad).toMatchObject({
      aiRunId: fixture.runId,
      chatId: firstLoad.acceptanceScope.chatId,
      initiatingUserId: firstLoad.acceptanceScope.userId,
    });
    expect(firstLoad).not.toHaveProperty("webPolicy");

    await inTask("plan-turn", () => beforeBoundary.planTurn(firstLoad), { attempt: 1 });
    await inTask("plan-turn", () => afterBoundary.planTurn(retryLoad), { attempt: 2 });
    await inTask(
      "single-retrieve-internal",
      () =>
        beforeBoundary.retrieveInternal(
          firstLoad,
          "What changed in liquidity?",
          "single-retrieve-internal",
          [],
        ),
      { attempt: 1 },
    );
    await inTask(
      "single-retrieve-internal",
      () =>
        afterBoundary.retrieveInternal(
          retryLoad,
          "What changed in liquidity?",
          "single-retrieve-internal",
          [],
        ),
      { attempt: 2 },
    );

    expect(agent.planInputs).toHaveLength(2);
    expect(agent.planInputs[1]).toBe(agent.planInputs[0]);
    expect(agent.retrievalInputs).toHaveLength(2);
    expect(agent.retrievalInputs[1]).toBe(agent.retrievalInputs[0]);
    expect(JSON.parse(agent.planInputs[0]!) as { currentDate: string }).toMatchObject({
      currentDate: "2026-07-10",
    });
    expect(JSON.parse(agent.retrievalInputs[0]!) as { currentDate: string }).toMatchObject({
      currentDate: "2026-07-10",
    });
  }, 120_000);

  it("locks the persisted run date through the idempotent start event transaction", async () => {
    const fixture = await runDb(createFixture);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_runs
          set created_at = '2026-07-10T23:59:59.500Z'::timestamptz
          where id = ${fixture.runId}
        `;
      }),
    );
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      new EmptyInventoryConversationAgent(),
    );
    const blockerReady = Promise.withResolvers<void>();
    const releaseBlocker = Promise.withResolvers<void>();
    const blocker = runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              update ai_runs
              set created_at = '2026-07-11T00:00:00.250Z'::timestamptz
              where id = ${fixture.runId}
            `;
            blockerReady.resolve();
            yield* Effect.promise(() => releaseBlocker.promise);
          }),
        );
      }),
    );
    void blocker.catch((error: unknown) => blockerReady.reject(error));
    await blockerReady.promise;
    const loadPromise = inTask("load-turn", () => operations.loadTurn(fixture.runId));
    try {
      await waitForRuntimeDatabaseLock();
    } finally {
      releaseBlocker.resolve();
      await blocker;
    }
    const load = await loadPromise;
    expect(load.currentDate).toBe("2026-07-11");
    const persisted = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly currentDate: string;
          readonly startedAt: Date | null;
          readonly startEventCount: number;
        }>`
          select ((runs.created_at at time zone 'UTC')::date)::text as "currentDate",
                 runs.started_at as "startedAt",
                 (
                   select count(*)::int
                   from ai_run_events events
                   where events.run_id = runs.id
                     and events.emission_key = 'run_started'
                 ) as "startEventCount"
          from ai_runs runs
          where runs.id = ${fixture.runId}
        `)[0]!;
      }),
    );
    expect(persisted).toMatchObject({
      currentDate: "2026-07-11",
      startedAt: expect.any(Date),
      startEventCount: 1,
    });
  }, 120_000);

  it("binds repeated publisher preview fragments to one immutable reconstruction tuple", async () => {
    const canonicalText =
      "😀 Liquidity conditions improved. " +
      "filler ".repeat(40) +
      "Liquidity expectations remained anchored.";
    const fixture = await runDb(createFixtureWithCanonicalText(canonicalText));
    const agent = new PublisherRetrievalAgent();
    agent.sourceId = `publisher:${fixture.subscriptionId}`;
    agent.expectedSearchSnippet = "Liquidity\n…\nLiquidity";
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await expect(
      inTask("publisher-repeated-preview", () =>
        operations.retrieveInternal(
          load,
          "What changed in liquidity?",
          "publisher-repeated-preview",
          [],
        ),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "document",
        documentId: fixture.documentId,
        snapshotId: fixture.snapshotId,
      }),
    ]);

    const persisted = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{
          readonly snapshotId: string;
          readonly contentHash: string;
          readonly sourceId: string;
          readonly documentId: string;
          readonly publisherExtractionId: string;
          readonly ranges: unknown;
        }>`
          select snapshot_id as "snapshotId",
                 content_hash as "contentHash",
                 document_source_id as "sourceId",
                 document_id as "documentId",
                 publisher_extraction_id::text as "publisherExtractionId",
                 document_ranges as ranges
            from ai_source_exposures
           where run_id = ${fixture.runId}
             and task_id = 'publisher-repeated-preview'
             and exposure_stage = 'internal_search_preview'
        `;
      }),
    );
    const firstStart = canonicalText.indexOf("Liquidity");
    const secondStart = canonicalText.lastIndexOf("Liquidity");
    expect(firstStart).toBe(3);
    expect(persisted).toEqual([
      {
        snapshotId: fixture.snapshotId,
        contentHash: fixture.contentHash,
        sourceId: `publisher:${fixture.subscriptionId}`,
        documentId: fixture.documentId,
        publisherExtractionId: fixture.extractionId,
        ranges: [
          { charStart: firstStart, charEnd: firstStart + "Liquidity".length },
          { charStart: secondStart, charEnd: secondStart + "Liquidity".length },
        ],
      },
    ]);
  }, 120_000);

  it("binds repeated public preview fragments without a publisher extraction", async () => {
    const canonicalText =
      "Beacon conditions improved. " +
      "filler ".repeat(40) +
      "Beacon expectations remained anchored.";
    const fixture = await runDb(createPublicPreviewFixture(canonicalText));
    const agent = new PublicRetrievalAgent("Beacon\n…\nBeacon");
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await expect(
      inTask("public-repeated-preview", () =>
        operations.retrieveInternal(
          load,
          "What changed in the public signal?",
          "public-repeated-preview",
          [],
        ),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "document",
        documentId: fixture.publicDocumentId,
        snapshotId: fixture.publicDocumentId,
        source: { kind: "public", sourceId: `public:${fixture.publicSourceId}` },
      }),
    ]);

    const persisted = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{
          readonly snapshotId: string;
          readonly contentHash: string;
          readonly sourceId: string;
          readonly documentId: string;
          readonly publisherExtractionId: string | null;
          readonly ranges: unknown;
        }>`
          select snapshot_id as "snapshotId",
                 content_hash as "contentHash",
                 document_source_id as "sourceId",
                 document_id as "documentId",
                 publisher_extraction_id::text as "publisherExtractionId",
                 document_ranges as ranges
            from ai_source_exposures
           where run_id = ${fixture.runId}
             and task_id = 'public-repeated-preview'
             and exposure_stage = 'internal_search_preview'
        `;
      }),
    );
    const firstStart = canonicalText.indexOf("Beacon");
    const secondStart = canonicalText.lastIndexOf("Beacon");
    expect(persisted).toEqual([
      {
        snapshotId: fixture.publicDocumentId,
        contentHash: fixture.publicContentHash,
        sourceId: `public:${fixture.publicSourceId}`,
        documentId: fixture.publicDocumentId,
        publisherExtractionId: null,
        ranges: [
          { charStart: firstStart, charEnd: firstStart + "Beacon".length },
          { charStart: secondStart, charEnd: secondStart + "Beacon".length },
        ],
      },
    ]);
  }, 120_000);

  it("rejects malformed resumed source identities at retrieval and freeze integrity boundaries", async () => {
    const fixture = await runDb(createFixture);
    const agent = new PublisherRetrievalAgent();
    agent.sourceId = `publisher:${fixture.subscriptionId}`;
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const malformedSourceIds = [
      `publisherx:${fixture.subscriptionId}`,
      `publisher:${fixture.subscriptionId}:extra`,
    ];
    for (const [index, sourceId] of malformedSourceIds.entries()) {
      agent.sourceName = sourceId;
      await expect(
        inTask(`malformed-retrieval-boundary-${index}`, () =>
          operations.retrieveInternal(
            load,
            "What changed in liquidity?",
            `malformed-retrieval-boundary-${index}`,
            [],
          ),
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          kind: "document",
          documentId: fixture.documentId,
          snapshotId: fixture.snapshotId,
        }),
      ]);
    }

    const sourceFor = (sourceId: string): FinalSourceRecord => ({
      sourceKey: "k_cn_AAAAAAAAAAAAAAAAAAAAAA_1",
      locator: {
        kind: "document",
        sourceId: `publisher:${sourceId}` as `publisher:${string}`,
        documentId: fixture.documentId,
        snapshotId: fixture.snapshotId,
        contentHash: fixture.contentHash,
        ranges: [{ charStart: 0, charEnd: 20 }],
        publisherExtractionId: fixture.extractionId,
        publisherIssueId: fixture.issueId,
        publisherDocumentId: fixture.documentId,
      },
      label: "Liquidity Outlook",
      publicProvenance: {
        issueTitle: "July Macro Brief",
        documentTitle: "Liquidity Outlook",
        citationUrl: `/v1/issues/${fixture.issueId}/documents/${fixture.documentId}/content`,
      },
      uses: [],
    });
    for (const [index, sourceId] of malformedSourceIds.entries()) {
      const source = sourceFor(sourceId);
      const context: ContextState = {
        status: "ready",
        question: "What changed in liquidity?",
        candidates: [],
        sourceMap: [source],
        ledgerCandidates: [],
        ledgerSourceMap: [source],
        selectedConversation: [],
        consumers: [],
        gaps: [],
        reductionFeedback: [],
        request: {
          requestClass: "main",
          model: "glm-5-turbo",
          messages: [{ role: "user", content: "answer" }],
          requestedOutputTokens: 512,
          reasoning: "medium",
        },
        inputTokens: 1,
        usableInputTokens: 100_000,
        reductionRan: false,
      };
      await expect(
        inTask(`malformed-freeze-boundary-${index}`, () => operations.freezeContext(load, context)),
      ).resolves.toMatchObject({
        status: "failed",
        failureCode: "context_plan_unfit",
      });
    }
  }, 120_000);

  it("keeps accepted publisher access after source disable and excludes it from later runs", async () => {
    const fixture = await runDb(
      createFixtureWithCanonicalText(
        "Liquidity conditions improved while inflation expectations remained anchored.",
        [],
        [],
        false,
      ),
    );
    const agent = new PublisherRetrievalAgent();
    agent.sourceId = `publisher:${fixture.subscriptionId}`;
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    expect(load.acceptanceScope.accessIds).toContain(fixture.accessId);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_employee_subscription_grants
          set revoked_at = now(), revoked_by_user_id = ${fixture.userId}
          where access_id = ${fixture.accessId} and user_id = ${fixture.userId}
        `;
        yield* sql`
          delete from chat_subscription_sources
          where chat_id = ${load.chatId}
        `;
      }),
    );
    agent.sourceId = `publisher:${fixture.subscriptionId}`;
    const references = await inTask("single-retrieve-internal", () =>
      operations.retrieveInternal(
        load,
        "What changed in liquidity?",
        "single-retrieve-internal",
        [],
      ),
    );
    expect(references).toEqual([
      expect.objectContaining({
        documentId: fixture.documentId,
        snapshotId: fixture.snapshotId,
      }),
    ]);
    const context = await assembleAndMeasureContext(
      operations,
      load,
      "What changed in liquidity?",
      {
        internal: references,
        memories: [],
        memorySelection: "enabled",
        web: [],
        webSelection: "enabled",
      },
      "single-answer",
      undefined,
      [],
    );
    expect(context.sourceMap[0]?.publicProvenance).toMatchObject({
      sourceName: "Canonical Publisher",
      issueTitle: "July Macro Brief",
      documentTitle: "Liquidity Outlook",
      citationUrl: `/v1/issues/${fixture.issueId}/documents/${fixture.documentId}/content`,
    });
    const requestUserMessage = context.request.messages.find((message) => message.role === "user");
    if (requestUserMessage === undefined) throw new Error("measured request has no user message");
    const requestUser = JSON.parse(requestUserMessage.content) as Record<string, unknown>;
    const mandatoryRequest = {
      ...context.request,
      messages: context.request.messages.map((message) =>
        message.role === "user"
          ? {
              ...message,
              content: JSON.stringify({
                ...requestUser,
                selectedConversation: [],
                evidence: "",
              }),
            }
          : message,
      ),
    };
    const exactDiscretionaryTokens =
      context.inputTokens -
      resolveRegisteredModel(context.request.model).countRequestTokens(mandatoryRequest);
    expect(context.sourceMap[0]?.uses[0]?.renderedTokenCount).toBe(exactDiscretionaryTokens);
    const currentQuestionPulls = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from ai_source_exposures
          where run_id = ${fixture.runId}
            and task_id = 'single-retrieve-internal'
            and content_item_identity = ${load.userMessageId}
        `;
        return rows[0]?.count ?? -1;
      }),
    );
    expect(currentQuestionPulls).toBe(0);
    await expect(
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update brief_documents set current_version_id = ${crypto.randomUUID()}
            where id = ${fixture.documentId}
          `;
        }),
      ),
    ).rejects.toThrow(/failed to execute statement|immutable|ready publisher content/i);
    const frozenAfterPointerChange = await inTask("single-context-select", () =>
      operations.freezeContext(load, context),
    );
    expect(frozenAfterPointerChange.status).toBe("ready");
    expect(frozenAfterPointerChange.sourceMap[0]?.locator).toMatchObject({
      snapshotId: fixture.snapshotId,
    });
    const exposures = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from ai_source_exposures
          where run_id = ${fixture.runId}
            and publisher_issue_id = ${fixture.issueId}
            and publisher_document_id = ${fixture.documentId}
        `;
      }),
    );
    expect(exposures[0]?.count).toBeGreaterThanOrEqual(2);

    const revokedAccessResult = await inTask("single-context-select", () =>
      operations.freezeContext(load, context),
    );
    expect(revokedAccessResult.status).toBe("ready");
    expect(revokedAccessResult.candidates).toEqual([
      expect.objectContaining({
        documentId: fixture.documentId,
        snapshotId: fixture.snapshotId,
      }),
    ]);
    expect(revokedAccessResult.sourceMap).toHaveLength(1);
    expect(revokedAccessResult.gaps).not.toContain(
      "an internal source was removed before context freeze",
    );

    const laterRunId = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_runs
          set failed_at = now(), error_code = 'finalization_failed', retryable = false
          where id = ${fixture.runId}
        `;
        const messages = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${load.chatId}, 'user', 'What changed after access was removed?')
          returning id::text
        `;
        const messageId = messages[0]?.id;
        if (messageId === undefined) return yield* Effect.fail(new Error("message insert failed"));
        const runs = yield* sql<{ readonly id: string }>`
          insert into ai_runs (
            chat_id, initiating_user_id, user_message_id, locale, market, acceptance_scope
          ) values (
            ${load.chatId}, ${load.initiatingUserId}, ${messageId}, 'en-US', 'US',
            ${sql.json(
              makeRunAcceptanceScope({
                userId: load.initiatingUserId,
                chatId: load.chatId,
                companyId: fixture.companyId,
                memoryMode: "private_owner",
                webRequested: false,
                webEnabled: false,
              }),
            )}
          )
          returning id::text
        `;
        const laterRunId = runs[0]?.id;
        if (laterRunId === undefined) return yield* Effect.fail(new Error("run insert failed"));
        return laterRunId;
      }),
    );
    const laterLoad = await inTask("load-turn", () => operations.loadTurn(laterRunId));
    expect(laterLoad.acceptanceScope.accessIds).toEqual([]);
    agent.sourceId = `publisher:${fixture.subscriptionId}`;
    await expect(
      inTask("later-restricted-retrieve", () =>
        operations.retrieveInternal(
          laterLoad,
          "What changed after access was removed?",
          "later-restricted-retrieve",
          [],
        ),
      ),
    ).resolves.toEqual([]);
  }, 120_000);

  it("keeps the publisher current pointer immutable between searches", async () => {
    const fixture = await runDb(createFixture);
    const agent = new PublisherRetrievalAgent();
    agent.sourceId = `publisher:${fixture.subscriptionId}`;
    agent.onAfterFirstSearch = async () => {
      await expect(
        runDb(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update brief_documents set current_version_id = ${crypto.randomUUID()}
              where id = ${fixture.documentId}
            `;
          }),
        ),
      ).rejects.toThrow(/failed to execute statement|immutable|ready publisher content/i);
    };
    const config: CanonicalAiConfig = {
      aiMainModel: "glm-5-turbo",
      aiFastModel: "glm-5-turbo",
      aiMainInputMaxTokens: 100_000,
      aiMainOutputMaxTokens: 4096,
      aiFastInputMaxTokens: 100_000,
      aiFastOutputMaxTokens: 4096,
      aiConversationRecentTurns: 12,
      aiFanoutMaxTopics: 3,
      aiRetrievalMaxTurns: 4,
      aiInternalMaxSearches: 4,
      aiInternalMaxInspections: 4,
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
      aiContextReductionMaxIterations: 2,
      aiMemoryToolResultMaxItems: 20,
      webResearchProvider: "",
    };
    const operations = new CanonicalWorkflowOperations(databaseUrlFor(databaseName), config, agent);
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await expect(
      inTask("pointer-stable-retrieve", () =>
        operations.retrieveInternal(
          load,
          "What changed in liquidity?",
          "pointer-stable-retrieve",
          [],
        ),
      ),
    ).resolves.toEqual(expect.any(Array));
  }, 120_000);

  it("stops frozen-context and finalization access as soon as a company enters recovery deletion", async () => {
    const fixture = await runDb(createFixture);
    const agent = new PublisherRetrievalAgent();
    agent.sourceId = `publisher:${fixture.subscriptionId}`;
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const references = await inTask("single-retrieve-internal", () =>
      operations.retrieveInternal(
        load,
        "What changed in liquidity?",
        "single-retrieve-internal",
        [],
      ),
    );
    const context = await assembleAndMeasureContext(
      operations,
      load,
      "What changed in liquidity?",
      {
        internal: references,
        memories: [],
        memorySelection: "enabled",
        web: [],
        webSelection: "enabled",
      },
      "single-answer",
      undefined,
      [],
    );
    const memoryArtifact = await persistMemoryArtifact(fixture, {
      proposals: [],
      discardedCount: 0,
    });
    await expect(
      inTask("single-context-select", () => operations.freezeContext(load, context)),
    ).resolves.toMatchObject({
      status: "ready",
    });
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into ai_observations (
            run_id, chat_id, emitting_task, loop_iteration, attempt,
            observation_key, kind, payload
          )
          select ${fixture.runId}, chat_id, 'plan-turn', 0, 0,
                 'fixture:deleted-company:turn-plan', 'turn_plan',
                 ${sql.json({ mode: "clarify", question: "Could you clarify?" })}
          from ai_runs where id = ${fixture.runId}
        `;
      }),
    );
    await runDb(seedPlanMeasurement(fixture));
    await runDb(seedExposureMeasurements(fixture));

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_companies
          set recovery_deleted_at = now(), purge_after = now() + interval '180 days'
          where id = ${fixture.companyId}
        `;
        yield* sql`
          delete from ai_observations
          where run_id = ${fixture.runId} and kind = 'retrieval_manifest'
        `;
      }),
    );

    await expect(
      inTask("single-context-select", () => operations.freezeContext(load, context)),
    ).resolves.toMatchObject({
      status: "failed",
      failureCode: "context_plan_unfit",
    });
    await expect(
      inTask("finalize", () =>
        operations.finalize(
          load,
          {
            status: "ok",
            mode: "clarification",
            content: "Could you clarify?",
            sourceMap: [],
          },
          memoryArtifact,
          `ai-chat:${load.aiRunId}`,
        ),
      ),
    ).rejects.toThrow("ai run execution scope is no longer available");
    const persisted = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly assistantMessages: number;
          readonly errorCode: string | null;
        }>`
            select
              count(messages.id)::int as "assistantMessages",
              max(runs.error_code) as "errorCode"
            from ai_runs runs
            left join chat_messages messages
              on messages.assistant_ai_run_id = runs.id
            where runs.id = ${fixture.runId}
          `)[0]!;
      }),
    );
    expect(persisted).toEqual({
      assistantMessages: 0,
      errorCode: null,
    });
  }, 120_000);

  it("searches only older messages in the same chat and excludes deleted or invented-cursor rows", async () => {
    const fixture = await runDb(createFixture);
    const seeded = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const run = yield* sql<{ readonly chatId: string; readonly companyId: string }>`
          select chat_id::text as "chatId", chats.company_id::text as "companyId"
          from ai_runs
          join chats on chats.id = ai_runs.chat_id
          where ai_runs.id = ${fixture.runId}
        `;
        const chat = run[0];
        if (chat === undefined) return yield* Effect.fail(new Error("chat fixture missing"));
        const retained = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content, created_at)
          values (
            ${chat.chatId}, 'assistant',
            'The older needle statement [[cite:stale_key]] remains available.',
            now() - interval '2 days'
          )
          returning id::text
        `;
        const deleted = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content, created_at)
          values (${chat.chatId}, 'user', 'deleted needle statement', now() - interval '3 days')
          returning id::text
        `;
        yield* sql`delete from chat_messages where id = ${deleted[0]!.id}`;
        yield* sql`
          insert into chat_messages (chat_id, author, content, created_at)
          values (${chat.chatId}, 'assistant', 'future needle statement', now() + interval '1 day')
        `;
        const otherChatId = crypto.randomUUID();
        yield* sql`
          insert into chats (id, company_id, user_id, memory_mode)
          values (${otherChatId}, ${chat.companyId}, ${fixture.userId}, 'private_owner')
        `;
        const other = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content, created_at)
          values (${otherChatId}, 'assistant', 'cross-chat needle statement', now() - interval '4 days')
          returning id::text
        `;
        return { retainedId: retained[0]!.id, otherId: other[0]!.id };
      }),
    );
    const config: CanonicalAiConfig = {
      aiMainModel: "glm-5-turbo" as const,
      aiFastModel: "glm-5-turbo" as const,
      aiMainInputMaxTokens: 100_000,
      aiMainOutputMaxTokens: 4096,
      aiFastInputMaxTokens: 100_000,
      aiFastOutputMaxTokens: 4096,
      aiConversationRecentTurns: 12,
      aiFanoutMaxTopics: 3,
      aiRetrievalMaxTurns: 4,
      aiInternalMaxSearches: 4,
      aiInternalMaxInspections: 4,
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
      aiContextReductionMaxIterations: 2,
      aiMemoryToolResultMaxItems: 20,
      webResearchProvider: "" as const,
    };
    const agent = new ChatRetrievalAgent();
    const operations = new CanonicalWorkflowOperations(databaseUrlFor(databaseName), config, agent);
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await expect(
      inTask("single-retrieve-internal", () =>
        operations.retrieveInternal(load, "find the older needle", "single-retrieve-internal", []),
      ),
    ).resolves.toEqual([
      {
        kind: "chat_message",
        messageId: seeded.retainedId,
        purpose: "recover an older statement",
      },
    ]);
    expect(agent.seenMessageIds).toEqual([seeded.retainedId]);
    expect(agent.seenSnippets[0]).not.toContain("[[cite:");
    expect(agent.inspectedContent).not.toContain("[[cite:");

    const inventedCursorAgent = new ChatRetrievalAgent(seeded.otherId);
    const inventedCursorOperations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      config,
      inventedCursorAgent,
    );
    await expect(
      inTask("single-retrieve-internal-invented-cursor", () =>
        inventedCursorOperations.retrieveInternal(
          load,
          "find the older needle",
          "single-retrieve-internal-invented-cursor",
          [],
        ),
      ),
    ).resolves.toEqual([]);
    expect(inventedCursorAgent.seenMessageIds).toEqual([]);

    const exhaustedAgent = new ExhaustedInternalSearchAgent();
    const exhaustedOperations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      config,
      exhaustedAgent,
    );
    await expect(
      inTask("single-retrieve-internal-exhausted", () =>
        exhaustedOperations.retrieveInternal(
          load,
          "find an absent older statement",
          "single-retrieve-internal-exhausted",
          [],
        ),
      ),
    ).resolves.toEqual([]);
    expect(exhaustedAgent.terminalReady).toBe(true);

    const inspectableAgent = new ExhaustedNonEmptyInternalSearchAgent();
    const inspectableOperations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      config,
      inspectableAgent,
    );
    await expect(
      inTask("single-retrieve-internal-exhausted-non-empty", () =>
        inspectableOperations.retrieveInternal(
          load,
          "compare the older needle statement",
          "single-retrieve-internal-exhausted-non-empty",
          [],
        ),
      ),
    ).resolves.toEqual([
      {
        kind: "chat_message",
        messageId: seeded.retainedId,
        purpose: "recover the comparison evidence",
      },
    ]);
    expect(inspectableAgent.inspectionAvailable).toBe(true);
    expect(inspectableAgent.terminalReady).toBe(true);
  });

  it("continues a named-source search through token pages and rejects handoff rebinding", async () => {
    const fixture = await runDb(createFixture);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const issueRows = yield* sql<{ readonly createdByUserId: string }>`
          select created_by_user_id as "createdByUserId"
          from publisher_issues
          where id = ${fixture.issueId}
        `;
        const createdByUserId = issueRows[0]?.createdByUserId;
        if (createdByUserId === undefined) {
          return yield* Effect.fail(new Error("publisher issue owner is missing"));
        }
        const issueId = crypto.randomUUID();
        const documentId = crypto.randomUUID();
        const snapshotId = crypto.randomUUID();
        const canonicalText =
          "Liquidity conditions improved while inflation expectations remained anchored in the second brief.";
        const contentHash = createHash("sha256").update(canonicalText, "utf8").digest("hex");
        const jobs = yield* sql<{ readonly id: string }>`
          insert into jobs (kind, payload)
          values ('extract_pdf_text', '{}'::jsonb)
          returning id::text
        `;
        yield* sql`
          insert into publisher_issues (
            id, subscription_id, title, status, publication_at, published_at,
            indexing_status, created_by_user_id
          ) values (
            ${issueId}, ${fixture.subscriptionId}, 'Second Macro Brief', 'draft', null, null,
            'pending', ${createdByUserId}
          )
        `;
        yield* sql`
          insert into brief_documents (
            id, issue_id, title, original_file_name, object_key, media_type, byte_size,
            sha256_hex, upload_completed_at, created_by_user_id
          ) values (
            ${documentId}, ${issueId}, 'Second Liquidity Outlook', 'second-liquidity.pdf',
            ${`publisher/second-liquidity/${documentId}.pdf`}, 'application/pdf', 42,
            ${contentHash}, now(), ${createdByUserId}
          )
        `;
        const extractions = yield* sql<{ readonly id: string }>`
          insert into brief_document_extractions (
            brief_document_id, input_sha256_hex, pages, extracted_char_count, created_by_job_id
          ) values (
            ${documentId}, ${contentHash},
            ${JSON.stringify([{ pageNumber: 1, text: canonicalText }])}::jsonb,
            ${canonicalText.length}, ${jobs[0]!.id}
          )
          returning id::text
        `;
        yield* sql`
          insert into brief_document_versions (
            id, brief_document_id, publisher_extraction_id, content_hash, language,
            canonical_text, text_char_count, page_ranges
          ) values (
            ${snapshotId}, ${documentId}, ${extractions[0]!.id}, ${contentHash}, 'english',
            ${canonicalText}, ${canonicalText.length},
            ${JSON.stringify([{ pageNumber: 1, charStart: 0, charEnd: canonicalText.length }])}::jsonb
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
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into issue_deliveries (
                issue_id, subscription_id, access_id, client_company_id, historical
              ) values (
                ${issueId}, ${fixture.subscriptionId}, ${fixture.accessId}, ${fixture.companyId}, false
              )
            `;
            yield* sql`
              insert into issue_delivery_recipients (issue_id, client_company_id, user_id, delivered_at)
              values (${issueId}, ${fixture.companyId}, ${fixture.userId}, now())
            `;
          }),
        );
      }),
    );
    const config: CanonicalAiConfig = {
      aiMainModel: "glm-5-turbo",
      aiFastModel: "glm-5-turbo",
      aiMainInputMaxTokens: 100_000,
      aiMainOutputMaxTokens: 4096,
      aiFastInputMaxTokens: 100_000,
      aiFastOutputMaxTokens: 700,
      aiConversationRecentTurns: 12,
      aiFanoutMaxTopics: 3,
      aiRetrievalMaxTurns: 8,
      aiInternalMaxSearches: 8,
      aiInternalMaxInspections: 4,
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
      aiContextReductionMaxIterations: 2,
      aiMemoryToolResultMaxItems: 20,
      webResearchProvider: "",
    };
    const agent = new NamedSourceCursorContinuationAgent();
    const operations = new CanonicalWorkflowOperations(databaseUrlFor(databaseName), config, agent);
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await expect(
      inTask("named-source-retrieve", () =>
        operations.retrieveInternal(
          load,
          "find liquidity in the named source",
          "named-source-retrieve",
          [],
        ),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "document",
        purpose: "paginate a named-source search",
      }),
    ]);
    expect(agent.continuationCalls).toBeGreaterThan(0);
    expect(agent.reboundReuseRejected).toBe(true);
  }, 120_000);

  it("preserves discovered evidence after malformed inspection recovery", async () => {
    const fixture = await runDb(createFixture);
    const messageId = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content, created_at)
          select chat_id, 'assistant', 'firstsubject retained evidence', now() - interval '2 days'
          from ai_runs where id = ${fixture.runId}
          returning id::text
        `;
        return rows[0]!.id;
      }),
    );
    const agent = new MalformedInspectionRecoveryAgent();
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await expect(
      inTask("retrieve-malformed-inspection", () =>
        operations.retrieveInternal(
          load,
          "recover firstsubject evidence",
          "retrieve-malformed-inspection",
          [],
        ),
      ),
    ).resolves.toEqual([
      {
        kind: "chat_message",
        messageId,
        purpose: "authorized search preview",
      },
    ]);
    expect(agent.recoveredReferenceCount).toBe(1);
  });

  it("recovers a stale repeated inspection through the production tool loop", async () => {
    const fixture = await runDb(createFixture);
    const messageId = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content, created_at)
          select chat_id, 'assistant', 'repeatinspection retained evidence', now() - interval '2 days'
          from ai_runs where id = ${fixture.runId}
          returning id::text
        `;
        return rows[0]!.id;
      }),
    );
    const reference = {
      kind: "chat_message" as const,
      messageId,
      purpose: "recover repeatinspection evidence",
    };
    const providerRequests: LiveProviderRequest[] = [];
    let providerTurn = 0;
    const client = new CanonicalAgentClient({
      bindAcceptedProviderProfile: () => undefined,
      complete: async (request: LiveProviderRequest) => {
        providerRequests.push(request);
        const completion =
          providerTurn === 0
            ? providerToolCompletion(
                "search_internal",
                {
                  query: {
                    target: "chat_messages",
                    terms: "repeatinspection",
                    purpose: reference.purpose,
                  },
                },
                "repeat-search",
              )
            : providerTurn === 1
              ? providerToolCompletion("inspect_internal", { reference }, "repeat-inspect-first")
              : providerTurn === 2
                ? providerToolCompletion("inspect_internal", { reference }, "repeat-inspect-stale")
                : providerToolCompletion(
                    "emit_internal_manifest",
                    { entries: [reference] },
                    "repeat-terminal",
                  );
        providerTurn += 1;
        return completion;
      },
    } as unknown as ExactPiBoundary);
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      client,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await expect(
      inTask("retrieve-stale-repeated-inspection", () =>
        operations.retrieveInternal(
          load,
          "recover repeatinspection evidence",
          "retrieve-stale-repeated-inspection",
          [],
        ),
      ),
    ).resolves.toEqual([reference]);
    expect((providerRequests[2]?.tools ?? []).map((tool) => tool.name)).toEqual([
      "emit_internal_manifest",
    ]);
    const recovery = providerRequests[3]?.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "repeat-inspect-stale",
    );
    expect(recovery?.content).toBe(
      JSON.stringify({
        complete: true,
        protocolError: "inspect_internal is disabled after the complete retrieval phase",
        recoveryReferences: [reference],
      }),
    );
  });

  it("requires a completed search after malformed initial search arguments", async () => {
    const fixture = await runDb(createFixture);
    const providerRequests: LiveProviderRequest[] = [];
    let providerTurn = 0;
    const client = new CanonicalAgentClient({
      bindAcceptedProviderProfile: () => undefined,
      complete: async (request: LiveProviderRequest) => {
        providerRequests.push(request);
        const completion =
          providerTurn === 0
            ? providerToolCompletion(
                "search_internal",
                { query: { target: "documents", purpose: "find absent evidence" } },
                "search-malformed",
              )
            : providerTurn === 1
              ? providerToolCompletion(
                  "search_internal",
                  {
                    query: {
                      target: "documents",
                      terms: "unfindablelexeme",
                      purpose: "confirm the corpus has no matching evidence",
                    },
                  },
                  "search-corrected",
                )
              : providerTurn === 2
                ? providerToolCompletion(
                    "search_internal",
                    {
                      query: {
                        target: "documents",
                        terms: "stillunfindablelexeme",
                        purpose: "complete the bounded empty search",
                      },
                    },
                    "search-corrected-second",
                  )
                : providerToolCompletion(
                    "emit_internal_manifest",
                    { entries: [] },
                    "terminal-corrected",
                  );
        providerTurn += 1;
        return completion;
      },
    } as unknown as ExactPiBoundary);
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 12,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      client,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await expect(
      inTask("retrieve-malformed-initial-search", () =>
        operations.retrieveInternal(
          load,
          "find absent evidence",
          "retrieve-malformed-initial-search",
          [],
        ),
      ),
    ).resolves.toEqual([]);
    expect((providerRequests[2]?.tools ?? []).map((tool) => tool.name)).toContain(
      "search_internal",
    );
    expect(providerRequests).toHaveLength(4);
  });

  it("keeps an incomplete second search available until exact cursor completion", async () => {
    const fixture = await runDb(createFixture);
    const messageId = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const first = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content, created_at)
          select chat_id, 'assistant', 'firstsubject retained evidence', now() - interval '3 days'
          from ai_runs where id = ${fixture.runId}
          returning id::text
        `;
        yield* sql`
          insert into chat_messages (chat_id, author, content, created_at)
          select ai_runs.chat_id, 'assistant',
                 'cursorpage marker ' || page::text || repeat(' bounded cursor content', 80),
                 now() - interval '2 days' - (page * interval '1 minute')
          from ai_runs cross join generate_series(1, 20) as page
          where ai_runs.id = ${fixture.runId}
        `;
        return first[0]!.id;
      }),
    );
    const agent = new SecondSearchCursorContinuationAgent();
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 512,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 32,
        aiInternalMaxSearches: 32,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await expect(
      inTask("retrieve-second-search-cursor", () =>
        operations.retrieveInternal(
          load,
          "compare firstsubject with cursorpage marker",
          "retrieve-second-search-cursor",
          [],
        ),
      ),
    ).resolves.toEqual([
      {
        kind: "chat_message",
        messageId,
        purpose: "recover the first comparison subject",
      },
    ]);
    expect(agent.continuationCalls).toBeGreaterThan(0);
    expect(agent.searchVisibleDuringContinuation).toBe(true);
    expect(agent.searchDisabledAfterContinuation).toBe(true);
  });

  it("persists a fanout document range union with exact per-topic consumer subsets", async () => {
    const fixture = await runDb(createFixture);
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      new PublisherRetrievalAgent(),
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const reference = (charStart: number, charEnd: number, purpose: string): InternalReference => ({
      kind: "document",
      documentId: fixture.documentId,
      snapshotId: fixture.snapshotId,
      publisherExtractionId: fixture.extractionId,
      source: {
        kind: "publisher",
        sourceId: `publisher:${fixture.subscriptionId}`,
        issueId: fixture.issueId,
        documentId: fixture.documentId,
      },
      ranges: [{ charStart, charEnd }],
      purpose,
    });
    const topicOneSelectors = {
      internal: [reference(0, 20, "first liquidity claim")],
      memories: [],
      memorySelection: "enabled",
      web: [],
      webSelection: "enabled",
    } satisfies SelectorBundle;
    const topicTwoSelectors = {
      internal: [reference(31, 63, "second expectations claim")],
      memories: [],
      memorySelection: "enabled",
      web: [],
      webSelection: "enabled",
    } satisfies SelectorBundle;
    const topics = [
      { topicId: "t1" as const, question: "What changed in liquidity?", relevantTurnIds: [] },
      { topicId: "t2" as const, question: "What remained anchored?", relevantTurnIds: [] },
    ];
    const fanoutSourceKeys = await inTask("fanout-merge-sources", () =>
      operations.mergeFanoutSources(load, topics, {
        t1: topicOneSelectors,
        t2: topicTwoSelectors,
        t3: {
          internal: [],
          memories: [],
          memorySelection: "enabled",
          web: [],
          webSelection: "enabled",
        },
      }),
    );
    const [topicOne, topicTwo] = await Promise.all([
      assembleAndMeasureContext(
        operations,
        load,
        "What changed in liquidity?",
        topicOneSelectors,
        "topic-t1-answer",
        "t1",
        [],
        fanoutSourceKeys,
      ),
      assembleAndMeasureContext(
        operations,
        load,
        "What remained anchored?",
        topicTwoSelectors,
        "topic-t2-answer",
        "t2",
        [],
        fanoutSourceKeys,
      ),
    ]);
    const sourceMap = operations.mergeFanoutSourceMaps([topicOne, topicTwo]);
    expect(sourceMap).toEqual([
      expect.objectContaining({
        locator: expect.objectContaining({
          ranges: [
            { charStart: 0, charEnd: 20 },
            { charStart: 31, charEnd: 63 },
          ],
        }),
        uses: [
          expect.objectContaining({
            consumerTaskId: "topic-t1-answer",
            topicId: "t1",
            ranges: [{ charStart: 0, charEnd: 20 }],
          }),
          expect.objectContaining({
            consumerTaskId: "topic-t2-answer",
            topicId: "t2",
            ranges: [{ charStart: 31, charEnd: 63 }],
          }),
        ],
      }),
    ]);
    const topicNoCallReasons = new Map(
      await Promise.all(
        topics.flatMap((topic) =>
          (["select-memories", "retrieve-web"] as const).map(async (suffix) => {
            const taskId = `topic-${topic.topicId}-${suffix}`;
            return [
              taskId,
              await durableNoCallReasonForFixtureTask(fixture, taskId, topic.question),
            ] as const;
          }),
        ),
      ),
    );
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        for (const [index, observation] of [
          {
            kind: "turn_plan",
            task: "plan-turn",
            payload: {
              mode: "fanout",
              question: "What changed in liquidity?",
              topics: topics.map((topic) => ({ ...topic })),
            },
          },
          {
            kind: "retrieval_manifest",
            task: "topic-t1-retrieve-internal",
            payload: { selectorRole: "internal", references: [reference(0, 20, "first")] },
          },
          {
            kind: "retrieval_manifest",
            task: "topic-t1-select-memories",
            payload: {
              selectorRole: "memory",
              references: [],
              noCallReason: topicNoCallReasons.get("topic-t1-select-memories"),
            },
          },
          {
            kind: "retrieval_manifest",
            task: "topic-t1-retrieve-web",
            payload: {
              selectorRole: "web",
              references: [],
              noCallReason: topicNoCallReasons.get("topic-t1-retrieve-web"),
            },
          },
          {
            kind: "retrieval_manifest",
            task: "topic-t2-retrieve-internal",
            payload: { selectorRole: "internal", references: [reference(31, 63, "second")] },
          },
          {
            kind: "retrieval_manifest",
            task: "topic-t2-select-memories",
            payload: {
              selectorRole: "memory",
              references: [],
              noCallReason: topicNoCallReasons.get("topic-t2-select-memories"),
            },
          },
          {
            kind: "retrieval_manifest",
            task: "topic-t2-retrieve-web",
            payload: {
              selectorRole: "web",
              references: [],
              noCallReason: topicNoCallReasons.get("topic-t2-retrieve-web"),
            },
          },
          {
            kind: "context_measurement",
            task: "fanout-synthesis-measure",
            payload: {
              consumerTaskId: "fanout-synthesis",
              mandatoryInputTokens: 1,
              discretionaryInputTokens: 0,
              totalInputTokens: 1,
              requestedOutputTokens: 4096,
              usableInputTokens: 100_000,
              contextWindow: 1_000_000,
              status: "ready",
              reductionRan: false,
              reductionFeedback: [],
              restrictedContextLedger: {
                requestKind: "synthesis",
                modelId: "glm-5-turbo",
                requestSha256Hex: "c".repeat(64),
                inputTokens: 1,
                usableInputTokens: 100_000,
                requestedOutputTokens: 4096,
                selectedConversation: [],
                packets: [
                  {
                    topicId: "t1",
                    status: "answered",
                    claimCount: 0,
                    gapCount: 0,
                    packetSha256Hex: "0".repeat(64),
                  },
                  {
                    topicId: "t2",
                    status: "answered",
                    claimCount: 0,
                    gapCount: 0,
                    packetSha256Hex: "1".repeat(64),
                  },
                ],
              },
            },
          },
          {
            kind: "context_serialized",
            task: "topic-t1-answer",
            payload: {
              consumerTaskId: "topic-t1-answer",
              topicId: "t1",
              sourceKeys: sourceMap.map((source) => source.sourceKey),
              restrictedContextLedger: restrictedLedgerForContext(
                topicOne,
                "topic-t1-answer",
                "topic",
                "t1",
              ),
              terminalUsageCoordinate: {
                taskId: "topic-t1-answer",
                loopIteration: 0,
                attempt: 0,
                providerRequestIndex: 0,
              },
            },
          },
          {
            kind: "context_serialized",
            task: "topic-t2-answer",
            payload: {
              consumerTaskId: "topic-t2-answer",
              topicId: "t2",
              sourceKeys: sourceMap.map((source) => source.sourceKey),
              restrictedContextLedger: restrictedLedgerForContext(
                topicTwo,
                "topic-t2-answer",
                "topic",
                "t2",
              ),
              terminalUsageCoordinate: {
                taskId: "topic-t2-answer",
                loopIteration: 0,
                attempt: 0,
                providerRequestIndex: 0,
              },
            },
          },
          {
            kind: "context_serialized",
            task: "fanout-synthesis",
            payload: {
              consumerTaskId: "fanout-synthesis",
              sourceKeys: sourceMap.map((source) => source.sourceKey),
              restrictedContextLedger: {
                requestKind: "synthesis",
                modelId: "glm-5-turbo",
                requestSha256Hex: "c".repeat(64),
                inputTokens: 1,
                usableInputTokens: 100_000,
                requestedOutputTokens: 4096,
                selectedConversation: [],
                packets: [
                  {
                    topicId: "t1",
                    status: "answered",
                    claimCount: 0,
                    gapCount: 0,
                    packetSha256Hex: "0".repeat(64),
                  },
                  {
                    topicId: "t2",
                    status: "answered",
                    claimCount: 0,
                    gapCount: 0,
                    packetSha256Hex: "1".repeat(64),
                  },
                ],
              },
              terminalUsageCoordinate: {
                taskId: "fanout-synthesis",
                loopIteration: 0,
                attempt: 0,
                providerRequestIndex: 0,
              },
            },
          },
          {
            kind: "topic_packet",
            task: "topic-t1-answer",
            payload: {
              topicId: "t1",
              status: "answered",
              sourceKeys: [],
              claimCount: 0,
              gapCount: 0,
              packetSha256Hex: "0".repeat(64),
            },
          },
          {
            kind: "topic_packet",
            task: "topic-t2-answer",
            payload: {
              topicId: "t2",
              status: "answered",
              sourceKeys: [],
              claimCount: 0,
              gapCount: 0,
              packetSha256Hex: "1".repeat(64),
            },
          },
        ].entries()) {
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values (
              ${fixture.runId}, (select chat_id from ai_runs where id = ${fixture.runId}),
              ${observation.task}, 0, 0,
              ${
                observation.kind === "retrieval_manifest"
                  ? `${observation.task}:0:0:retrieval_manifest:result`
                  : `fanout-fixture:${index}`
              },
              ${observation.kind}, ${sql.json(observation.payload)}
            )
          `;
        }
      }),
    );
    const key = sourceMap[0]?.sourceKey;
    if (key === undefined) throw new Error("missing merged source key");
    const memoryArtifact = await persistMemoryArtifact(fixture, {
      proposals: [],
      discardedCount: 0,
    });
    await runDb(seedPlanMeasurement(fixture));
    await runDb(seedExposureMeasurements(fixture));
    for (const taskId of ["topic-t1-retrieve-internal", "topic-t2-retrieve-internal"]) {
      await runDb(seedTaskMeasurement(fixture, taskId));
    }
    const topicOneEvidence = await seedAnswerSerializedExposures(
      fixture,
      "topic-t1-answer",
      topicOne,
      "topic-t1-answer",
    );
    const topicTwoEvidence = await seedAnswerSerializedExposures(
      fixture,
      "topic-t2-answer",
      topicTwo,
      "topic-t2-answer",
    );
    await runDb(
      seedTaskMeasurement(
        fixture,
        "topic-t1-answer",
        0,
        topicOne,
        topicOneEvidence.proofs,
        topicOneEvidence.bindings,
      ),
    );
    await runDb(
      seedTaskMeasurement(
        fixture,
        "topic-t2-answer",
        0,
        topicTwo,
        topicTwoEvidence.proofs,
        topicTwoEvidence.bindings,
      ),
    );
    await runDb(seedTaskMeasurement(fixture, "fanout-synthesis"));
    const result = await inTask("finalize", () =>
      operations.finalize(
        load,
        {
          status: "ok",
          mode: "synthesis",
          content: `Liquidity improved while expectations stayed anchored [[cite:${key}]].`,
          sourceMap,
        },
        memoryArtifact,
        `ai-chat:${load.aiRunId}`,
      ),
    );
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") throw new Error(`unexpected final status ${result.status}`);
    const persisted = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const sources = yield* sql<{
          readonly ranges: readonly { readonly charStart: number; readonly charEnd: number }[];
        }>`
          select locator->'ranges' as ranges
          from assistant_message_sources
          where assistant_message_id = ${result.assistantMessageId}
        `;
        const uses = yield* sql<{
          readonly consumerTaskId: string;
          readonly topicId: string;
          readonly ranges: readonly { readonly charStart: number; readonly charEnd: number }[];
        }>`
          select consumer_task_id as "consumerTaskId", topic_id as "topicId", ranges
          from assistant_message_source_uses
          where assistant_message_id = ${result.assistantMessageId}
          order by consumer_task_id
        `;
        return { sources, uses };
      }),
    );
    expect(persisted).toEqual({
      sources: [
        {
          ranges: [
            { charStart: 0, charEnd: 20 },
            { charStart: 31, charEnd: 63 },
          ],
        },
      ],
      uses: [
        {
          consumerTaskId: "topic-t1-answer",
          topicId: "t1",
          ranges: [{ charStart: 0, charEnd: 20 }],
        },
        {
          consumerTaskId: "topic-t2-answer",
          topicId: "t2",
          ranges: [{ charStart: 31, charEnd: 63 }],
        },
      ],
    });
  }, 120_000);

  it("keeps the rendered memory revision immutable when parallel extraction updates its head", async () => {
    const memoryId = crypto.randomUUID();
    const renderedRevisionId = crypto.randomUUID();
    const renderedState = {
      kind: "fact",
      content: "The client prefers quarterly liquidity comparisons.",
      deleted: false,
    } as const;
    const fixture = await runDb(
      createFixtureWithCanonicalText(
        "Liquidity conditions improved while inflation expectations remained anchored.",
        [],
        [
          {
            memoryId,
            memoryRevisionId: renderedRevisionId,
            kind: renderedState.kind,
            content: renderedState.content,
            deleted: renderedState.deleted,
          },
        ],
        false,
      ),
    );
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      new PublisherRetrievalAgent(),
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly chatId: string }>`
          select chat_id::text as "chatId" from ai_runs where id = ${fixture.runId}
        `;
        const chatId = rows[0]?.chatId;
        if (chatId === undefined) return yield* Effect.fail(new Error("chat not found"));
        yield* insertAiObservation({
          runId: fixture.runId,
          chatId,
          emittingTask: "plan-turn",
          loopIteration: 0,
          attempt: 0,
          observationKey: "fixture:plan-turn:measurement",
          kind: "provider_request_measurement",
          payload: {
            providerRequestIndex: 0,
            agentRole: "plan_turn",
            modelId: "glm-5-turbo",
            requestSha256Hex: "a".repeat(64),
            sourceExposureProofSha256Hexes: [],
            inputTokens: 1,
            requestedOutputTokens: 2048,
            usableInputTokens: 100_000,
            contextWindow: 1_000_000,
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
            inputTokens: 1,
            outputTokens: 1,
            cachedTokens: 0,
            reasoningTokens: 0,
            totalTokens: 2,
            stopReason: "stop",
          },
        });
      }),
    );
    const context = await assembleAndMeasureContext(
      operations,
      load,
      "What should I compare?",
      {
        internal: [],
        memories: [{ memoryId, memoryRevisionId: renderedRevisionId }],
        memorySelection: "enabled",
        web: [],
        webSelection: "enabled",
      },
      "single-answer",
      undefined,
      [],
    );
    expect(context.sourceMap).toEqual([
      expect.objectContaining({
        locator: {
          kind: "memory",
          memoryId,
          memoryRevisionId: renderedRevisionId,
        },
      }),
    ]);
    const restrictedContextLedger = {
      requestKind: "direct",
      modelId: context.request.model,
      requestSha256Hex: providerRequestSha256Hex(context.request),
      inputTokens: context.inputTokens,
      usableInputTokens: context.usableInputTokens,
      requestedOutputTokens: context.request.requestedOutputTokens,
      selectedConversation: [],
      question: context.question,
      gaps: context.gaps,
      sources: context.candidates.map((candidate, index) => ({
        candidateId: candidate.id,
        sourceKey: context.sourceMap[index]!.sourceKey,
        kind: candidate.kind,
        purpose: candidate.purpose,
        label: context.sourceMap[index]!.label,
        ranges: [],
      })),
    };
    const answerEvidence = await seedAnswerSerializedExposures(
      fixture,
      "single-answer",
      context,
      "single-answer",
    );
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly chatId: string }>`
          select chat_id::text as "chatId" from ai_runs where id = ${fixture.runId}
        `;
        const chatId = rows[0]?.chatId;
        if (chatId === undefined) return yield* Effect.fail(new Error("chat not found"));
        yield* insertAiObservation({
          runId: fixture.runId,
          chatId,
          emittingTask: "single-answer",
          loopIteration: 0,
          attempt: 0,
          observationKey: "fixture:single-answer:measurement",
          kind: "provider_request_measurement",
          payload: {
            providerRequestIndex: 0,
            agentRole: "direct_answer",
            modelId: context.request.model,
            requestSha256Hex: restrictedContextLedger.requestSha256Hex,
            sourceExposureProofSha256Hexes: answerEvidence.proofs,
            sourceExposureProofBindings: answerEvidence.bindings,
            inputTokens: context.inputTokens,
            requestedOutputTokens: context.request.requestedOutputTokens,
            usableInputTokens: context.usableInputTokens,
            contextWindow: resolveRegisteredModel(context.request.model).contextWindow,
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
          modelId: context.request.model,
          providerServiceId: "zai_coding_plan_official",
          usage: {
            inputTokens: context.inputTokens,
            outputTokens: 1,
            cachedTokens: 0,
            reasoningTokens: 0,
            totalTokens: context.inputTokens + 1,
            stopReason: "stop",
          },
        });
      }),
    );
    const finalRetrievalFixtures = await Promise.all(
      (
        [
          ["single-retrieve-internal", "internal"],
          ["single-retrieve-web", "web"],
        ] as const
      ).map(async ([task, selectorRole]) => ({
        task,
        selectorRole,
        noCallReason: await durableNoCallReasonForFixtureTask(fixture, task),
      })),
    );
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        for (const [kind, payload] of [
          [
            "turn_plan",
            { mode: "single", question: "What should I compare?", relevantTurnIds: [] },
          ],
          [
            "retrieval_manifest",
            {
              selectorRole: "memory",
              references: [{ memoryId, memoryRevisionId: renderedRevisionId }],
            },
          ],
          [
            "context_measurement",
            {
              consumerTaskId: "single-answer",
              restrictedContextLedger,
            },
          ],
          [
            "context_serialized",
            {
              consumerTaskId: "single-answer",
              sourceKeys: context.sourceMap.map((s) => s.sourceKey),
              restrictedContextLedger,
              terminalUsageCoordinate: {
                taskId: "single-answer",
                loopIteration: 0,
                attempt: 0,
                providerRequestIndex: 0,
              },
            },
          ],
        ] as const) {
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            )
            select ${fixture.runId}, chat_id,
                   case ${kind}
                     when 'turn_plan' then 'plan-turn'
                     when 'retrieval_manifest' then 'single-select-memories'
                     else 'single-answer'
                   end,
                   0, 0,
                   ${
                     kind === "retrieval_manifest"
                       ? "single-select-memories:0:0:retrieval_manifest:result"
                       : `fixture:${kind}`
                   },
                   ${kind}, ${sql.json(payload)}
            from ai_runs where id = ${fixture.runId}
          `;
        }
        for (const { task, selectorRole, noCallReason } of finalRetrievalFixtures) {
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            )
            select ${fixture.runId}, chat_id, ${task}, 0, 0,
                   ${`${task}:0:0:retrieval_manifest:result`}, 'retrieval_manifest',
                   ${sql.json({
                     selectorRole,
                     references: [],
                     ...(noCallReason === undefined ? {} : { noCallReason }),
                   })}
            from ai_runs where id = ${fixture.runId}
          `;
        }
      }),
    );
    for (const taskId of ["single-retrieve-internal", "single-select-memories"]) {
      await runDb(seedTaskMeasurement(fixture, taskId));
    }
    const sourceKey = context.sourceMap[0]?.sourceKey;
    if (sourceKey === undefined) throw new Error("expected memory source key");
    const updatedContent = "The client prefers monthly and quarterly liquidity comparisons.";
    const memoryArtifact = await persistMemoryArtifact(fixture, {
      proposals: [
        {
          kind: "fact",
          content: updatedContent,
          targetMemoryId: memoryId,
          expectedHeadRevisionId: renderedRevisionId,
        },
      ],
      discardedCount: 0,
    });
    const result = await inTask("finalize", () =>
      operations.finalize(
        load,
        {
          status: "ok",
          mode: "single",
          content: `Use the saved comparison preference [${sourceKey}].`,
          sourceMap: context.sourceMap,
        },
        memoryArtifact,
        `ai-chat:${load.aiRunId}`,
      ),
    );
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") throw new Error(`unexpected final status ${result.status}`);
    const persisted = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{
          readonly sourceRevisionId: string;
          readonly headRevisionId: string;
          readonly headState: { readonly content: string; readonly deleted: boolean };
        }>`
          select sources.memory_revision_id::text as "sourceRevisionId",
                 memories.head_revision_id::text as "headRevisionId",
                 head.state_after as "headState"
          from assistant_message_sources sources
          join user_memory_revisions rendered on rendered.id = sources.memory_revision_id
          join user_memories memories on memories.id = rendered.memory_id
          join user_memory_revisions head on head.id = memories.head_revision_id
          where sources.assistant_message_id = ${result.assistantMessageId}
        `;
        return rows;
      }),
    );
    expect(persisted).toEqual([
      {
        sourceRevisionId: renderedRevisionId,
        headRevisionId: expect.not.stringMatching(renderedRevisionId),
        headState: expect.objectContaining({ content: updatedContent, deleted: false }),
      },
    ]);
  }, 120_000);

  it("reconstructs web provenance only from the fetched page and rejects invented quotations", async () => {
    const fixture = await runDb(createFixture);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings set web_search_enabled = true
          where company_id = ${fixture.companyId}
        `;
      }),
    );
    const officialQuote = "The official report records a 4.2 percent increase.";
    const web: WebResearchBoundary = {
      search: async (_query, _locale, _market, _policy) => {
        return {
          results: [
            {
              title: "Official report result",
              url: "https://official.example/start",
              domain: "official.example",
              snippet: "Official report discovery snippet.",
              providerRank: 1,
            },
          ],
          complete: true,
          truncated: false,
          cursor: null,
          scope: {
            kind: "provider_ranked_results",
            maximumResults: 10,
            cursorSupported: false,
          },
        };
      },
      fetch: async (_url, _policy) => {
        return {
          url: "https://official.example/final-report",
          title: "Official report title",
          domain: "official.example",
          text: `Published findings. ${officialQuote} Methodology follows.`,
          publishedAt: "2026-07-09T08:00:00.000Z",
          capturedAt: "2026-07-10T12:00:00.000Z",
        };
      },
    };
    const workflowConfig = {
      aiMainModel: "glm-5-turbo" as const,
      aiFastModel: "glm-5-turbo" as const,
      aiMainInputMaxTokens: 100_000,
      aiMainOutputMaxTokens: 4096,
      aiFastInputMaxTokens: 100_000,
      aiFastOutputMaxTokens: 4096,
      aiConversationRecentTurns: 12,
      aiFanoutMaxTopics: 3,
      aiRetrievalMaxTurns: 4,
      aiInternalMaxSearches: 4,
      aiInternalMaxInspections: 4,
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
      aiContextReductionMaxIterations: 2,
      aiMemoryToolResultMaxItems: 20,
      webResearchProvider: "tinyfish" as const,
    } satisfies CanonicalAiConfig;
    const webOperations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      workflowConfig,
      new WebManifestAgent(officialQuote),
      web,
    );
    const load = await inTask("load-turn", () => webOperations.loadTurn(fixture.runId));
    const evidence = await inTask("single-retrieve-web", () =>
      webOperations.retrieveWeb(load, "What changed?", "single-retrieve-web"),
    );
    expect(evidence).toEqual({
      status: "enabled",
      entries: [
        {
          url: "https://official.example/final-report",
          title: "Official report title",
          domain: "official.example",
          quote: officialQuote,
          publishedAt: "2026-07-09T08:00:00.000Z",
          capturedAt: "2026-07-10T12:00:00.000Z",
          purpose: "answer from the official report",
        },
      ],
    });
    const fallbackWeb: WebResearchBoundary = {
      search: async (_query, _locale, _market, _policy) => {
        return {
          results: [
            {
              title: "Unreadable report",
              url: "https://official.example/report.pdf",
              domain: "official.example",
              snippet: "Official PDF.",
              providerRank: 1,
            },
            {
              title: "Official report result",
              url: "https://official.example/report.html",
              domain: "official.example",
              snippet: "Official HTML report.",
              providerRank: 2,
            },
          ],
          complete: true,
          truncated: false,
          cursor: null,
          scope: {
            kind: "provider_ranked_results",
            maximumResults: 10,
            cursorSupported: false,
          },
        };
      },
      fetch: async (url, _policy) => {
        if (url.endsWith(".pdf")) {
          throw new WebBoundaryError(
            "unsupported_content_type",
            "web fetch content type is unsupported",
            false,
          );
        }
        return {
          url: "https://official.example/final-report",
          title: "Official report title",
          domain: "official.example",
          text: `Published findings. ${officialQuote} Methodology follows.`,
          publishedAt: "2026-07-09T08:00:00.000Z",
          capturedAt: "2026-07-10T12:00:00.000Z",
        };
      },
    };
    await expect(
      inTask("fetch-fallback-web-selector", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          new WebManifestAgent(officialQuote, "fetch-fallback"),
          fallbackWeb,
        ).retrieveWeb(load, "What changed?", "fetch-fallback-web-selector"),
      ),
    ).resolves.toEqual(evidence);
    await expect(
      inTask("repeat-fetch-web-selector", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          new WebManifestAgent(officialQuote, "repeat-fetch"),
          web,
        ).retrieveWeb(load, "What changed?", "repeat-fetch-web-selector"),
      ),
    ).resolves.toEqual(evidence);
    const providerRequests: LiveProviderRequest[] = [];
    let providerTurn = 0;
    const staleFetchClient = new CanonicalAgentClient({
      bindAcceptedProviderProfile: () => undefined,
      complete: async (request: LiveProviderRequest) => {
        providerRequests.push(request);
        const completion =
          providerTurn === 0
            ? providerToolCompletion("web_search", { query: "official report" }, "web-search")
            : providerTurn === 1
              ? providerToolCompletion(
                  "web_fetch",
                  { url: "https://official.example/start" },
                  "web-fetch",
                )
              : providerTurn === 2
                ? providerToolCompletion(
                    "web_fetch",
                    { url: "https://official.example/final-report" },
                    "web-fetch-stale",
                  )
                : providerToolCompletion(
                    "emit_web_evidence",
                    {
                      entries: [
                        {
                          url: "https://official.example/final-report",
                          title: "Official report title",
                          domain: "official.example",
                          quote: officialQuote,
                          publishedAt: "2026-07-09T08:00:00.000Z",
                          capturedAt: "2026-07-10T12:00:00.000Z",
                          purpose: "answer from the official report",
                        },
                      ],
                    },
                    "web-terminal",
                  );
        providerTurn += 1;
        return completion;
      },
    } as unknown as ExactPiBoundary);
    await expect(
      inTask("stale-fetch-web-selector", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          staleFetchClient,
          web,
        ).retrieveWeb(load, "What changed?", "stale-fetch-web-selector"),
      ),
    ).resolves.toEqual(evidence);
    expect((providerRequests[2]?.tools ?? []).map((tool) => tool.name)).toEqual([
      "emit_web_evidence",
    ]);
    const staleFetchRecovery = providerRequests[3]?.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "web-fetch-stale",
    );
    expect(staleFetchRecovery?.content).toBe(
      JSON.stringify({
        complete: true,
        toolDisabled: true,
        protocolError: "web fetch cannot continue after a fetched page",
        message:
          "web_fetch is disabled after a fetched page; call emit_web_evidence with verbatim evidence",
        discoveredUrls: ["https://official.example/start"],
        fetchedUrls: ["https://official.example/final-report"],
      }),
    );
    const terminalRecoveryRequests: LiveProviderRequest[] = [];
    let terminalRecoveryTurn = 0;
    const terminalRecoveryClient = new CanonicalAgentClient({
      bindAcceptedProviderProfile: () => undefined,
      complete: async (request: LiveProviderRequest) => {
        terminalRecoveryRequests.push(request);
        const completion =
          terminalRecoveryTurn === 0
            ? providerToolCompletion("web_search", { query: "official report" }, "web-search")
            : terminalRecoveryTurn === 1
              ? providerToolCompletion(
                  "web_fetch",
                  { url: "https://official.example/start" },
                  "web-fetch",
                )
              : providerToolCompletion(
                  "emit_web_evidence",
                  {
                    entries: [
                      {
                        url: "https://official.example/final-report",
                        title: "Official report title",
                        domain: "official.example",
                        quote: terminalRecoveryTurn === 2 ? "paraphrased evidence" : officialQuote,
                        publishedAt: "2026-07-09T08:00:00.000Z",
                        capturedAt: "2026-07-10T12:00:00.000Z",
                        purpose: "answer from the official report",
                      },
                    ],
                  },
                  terminalRecoveryTurn === 2 ? "web-terminal-invalid" : "web-terminal-recovered",
                );
        terminalRecoveryTurn += 1;
        return completion;
      },
    } as unknown as ExactPiBoundary);
    await expect(
      inTask("terminal-recovery-web-selector", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          terminalRecoveryClient,
          web,
        ).retrieveWeb(load, "What changed?", "terminal-recovery-web-selector"),
      ),
    ).resolves.toEqual(evidence);
    const terminalRecovery = terminalRecoveryRequests[3]?.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "web-terminal-invalid",
    );
    expect(JSON.parse(terminalRecovery?.content ?? "{}")).toMatchObject({
      complete: true,
      terminalRejected: true,
      message: "web terminal evidence must use a verbatim quote from a fetched page",
      instruction: expect.stringContaining("verbatimExcerpt substring"),
      fetchedPages: [
        {
          url: "https://official.example/final-report",
          verbatimExcerpt: expect.stringContaining(officialQuote),
        },
      ],
    });
    await expect(
      inTask("disabled-web-selector", () =>
        webOperations.retrieveWeb(
          {
            ...load,
          },
          "What changed?",
          "disabled-web-selector",
        ),
      ),
    ).resolves.toEqual(evidence);
    const currentQuestionPulls = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from ai_source_exposures
          where run_id = ${fixture.runId}
            and task_id = 'single-retrieve-web'
            and content_item_identity = ${load.userMessageId}
        `;
        return rows[0]?.count ?? -1;
      }),
    );
    expect(currentQuestionPulls).toBe(0);
    await expect(
      inTask("topic-t1-retrieve-web", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          new WebManifestAgent("An invented quote that is absent."),
          web,
        ).retrieveWeb(load, "What is the current official update?", "topic-t1-retrieve-web"),
      ),
    ).rejects.toThrow("web terminal evidence must use a verbatim quote from a fetched page");
    await expect(
      inTask("duplicate-web-selector", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          new WebManifestAgent(officialQuote, "duplicate"),
          web,
        ).retrieveWeb(load, "What is the current official update?", "duplicate-web-selector"),
      ),
    ).rejects.toThrow("web evidence manifest contains duplicate references");
    await expect(
      inTask("duplicate-web-url-selector", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          new WebManifestAgent(officialQuote, "duplicate-url"),
          web,
        ).retrieveWeb(load, "What is the current official update?", "duplicate-web-url-selector"),
      ),
    ).rejects.toThrow("web evidence manifest contains duplicate URLs");
    await expect(
      inTask("empty-after-fetch-web-selector", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          new WebManifestAgent(officialQuote, "empty-after-fetch"),
          web,
        ).retrieveWeb(
          load,
          "What is the current official update?",
          "empty-after-fetch-web-selector",
        ),
      ),
    ).rejects.toThrow("web terminal evidence cannot be empty after a fetched page");

    for (const [mode, expected] of [
      ["direct-fetch", "canonical URL discovered by an earlier complete search turn"],
      ["undiscovered-fetch", "canonical URL discovered by an earlier complete search turn"],
      ["same-turn-fetch", "canonical URL discovered by an earlier complete search turn"],
      ["terminal-first", "later complete search turn"],
    ] as const) {
      await expect(
        inTask(`adversarial-${mode}`, () =>
          new CanonicalWorkflowOperations(
            databaseUrlFor(databaseName),
            workflowConfig,
            new WebManifestAgent(officialQuote, mode),
            web,
          ).retrieveWeb(load, "What is the current official update?", `adversarial-${mode}`),
        ),
      ).rejects.toThrow(expected);
    }
    await expect(
      inTask("topic-t1-no-web-need", () =>
        webOperations.retrieveWeb(
          load,
          "Compare two internal energy subjects conceptually, including their market roles.",
          "topic-t1-retrieve-web",
        ),
      ),
    ).resolves.toEqual({ status: "enabled", entries: [] });
  }, 120_000);

  it("uses the accepted web policy after the company setting changes", async () => {
    const fixture = await runDb(createFixture);
    const originalPolicy = {
      enabled: true,
      provider: "tinyfish",
      allowedDomains: null,
    } as const;
    const changedPolicy = {
      enabled: true,
      provider: "tinyfish",
      allowedDomains: ["changed.example"],
    } as const;
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings
          set web_search_enabled = true,
              web_domain_allowlist = null
          where company_id = ${fixture.companyId}
        `;
      }),
    );

    const requestReady = Promise.withResolvers<LiveProviderRequest>();
    const releaseAuthorization = Promise.withResolvers<void>();
    let providerTransportCalls = 0;
    let providerTurn = 0;
    let webBoundaryCalls = 0;
    const agent = new CanonicalAgentClient({
      bindAcceptedProviderProfile: () => undefined,
      complete: async (
        request: LiveProviderRequest,
        coordinates: PiBoundaryCoordinates,
        onBeforeRequest?: BeforeProviderRequest,
      ) => {
        requestReady.resolve(request);
        await releaseAuthorization.promise;
        await onBeforeRequest?.(
          request,
          {
            ...coordinates,
            providerRequestSha256Hex: providerRequestSha256Hex(request),
          },
          passedMeasurement(request.model),
        );
        providerTransportCalls += 1;
        return providerTurn++ === 0
          ? providerToolCompletion("web_search", { query: "changed policy" }, "search")
          : providerTurn === 2
            ? providerToolCompletion(
                "web_fetch",
                { url: "https://accepted.example/result" },
                "fetch",
              )
            : providerToolCompletion(
                "emit_web_evidence",
                {
                  entries: [
                    {
                      url: "https://accepted.example/result",
                      title: "Accepted result",
                      domain: "accepted.example",
                      quote: "Accepted snapshot result.",
                      publishedAt: "2026-07-10T00:00:00.000Z",
                      capturedAt: "2026-07-10T00:00:00.000Z",
                      purpose: "accepted policy test",
                    },
                  ],
                },
                "terminal",
              );
      },
    } as unknown as ExactPiBoundary);
    const web: WebResearchBoundary = {
      search: async (_query, _locale, _market, policy) => {
        webBoundaryCalls += 1;
        expect(policy).toEqual(originalPolicy);
        return {
          results: [
            {
              title: "Accepted result",
              url: "https://accepted.example/result",
              domain: "accepted.example",
              snippet: "Accepted snapshot result.",
              providerRank: 1,
            },
          ],
          complete: true,
          truncated: false,
          cursor: null,
          scope: {
            kind: "provider_ranked_results",
            maximumResults: 10,
            cursorSupported: false,
          },
        };
      },
      fetch: async (_url, policy) => {
        webBoundaryCalls += 1;
        expect(policy).toEqual(originalPolicy);
        return {
          url: "https://accepted.example/result",
          title: "Accepted result",
          domain: "accepted.example",
          text: "Accepted snapshot result.",
          publishedAt: "2026-07-10T00:00:00.000Z",
          capturedAt: "2026-07-10T00:00:00.000Z",
        };
      },
    };
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "tinyfish",
      },
      agent,
      web,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const retrieval = inTask("changed-policy-web", () =>
      operations.retrieveWeb(load, "What is the current update?", "changed-policy-web"),
    );
    const request = await requestReady.promise;
    expect(JSON.parse(request.messages[1]!.content)).toMatchObject({ policy: originalPolicy });
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              update client_company_ai_settings
              set web_domain_allowlist = ${changedPolicy.allowedDomains}
              where company_id = ${fixture.companyId}
            `;
          }),
        );
      }),
    );
    releaseAuthorization.resolve();

    await expect(retrieval).resolves.toEqual({
      status: "enabled",
      entries: [
        {
          url: "https://accepted.example/result",
          title: "Accepted result",
          domain: "accepted.example",
          quote: "Accepted snapshot result.",
          publishedAt: "2026-07-10T00:00:00.000Z",
          capturedAt: "2026-07-10T00:00:00.000Z",
          purpose: "accepted policy test",
        },
      ],
    });
    expect(providerTransportCalls).toBe(3);
    expect(webBoundaryCalls).toBe(2);
  }, 120_000);

  it("fails a requested web path with a missing current adapter", async () => {
    const fixture = await runDb(createFixture);
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "tinyfish",
      },
      new WebManifestAgent("unused"),
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));

    await expect(
      inTask("single-retrieve-web", () =>
        operations.retrieveWeb(load, "What is the current update?", "single-retrieve-web"),
      ),
    ).rejects.toMatchObject({
      code: "web_research_failed",
      details: { failureRetryable: false },
    });
  }, 120_000);

  it.each(["membership", "settings", "accepted-policy", "chat"] as const)(
    "uses the accepted web scope after a pending %s change",
    async (change) => {
      const fixture = await runDb(createFixture);

      const boundaryEntered = Promise.withResolvers<void>();
      const startAuthorization = Promise.withResolvers<void>();
      const authorizationStarted = Promise.withResolvers<void>();
      let transportCalls = 0;
      const web: WebResearchBoundary = {
        search: async (_query, _locale, _market, _policy) => {
          boundaryEntered.resolve();
          await startAuthorization.promise;
          authorizationStarted.resolve();
          transportCalls += 1;
          throw new Error("revoked web operation reached transport");
        },
        fetch: async () => {
          transportCalls += 1;
          throw new Error("revoked web operation reached fetch");
        },
      };
      const operations = new CanonicalWorkflowOperations(
        databaseUrlFor(databaseName),
        {
          aiMainModel: "glm-5-turbo",
          aiFastModel: "glm-5-turbo",
          aiMainInputMaxTokens: 100_000,
          aiMainOutputMaxTokens: 4096,
          aiFastInputMaxTokens: 100_000,
          aiFastOutputMaxTokens: 4096,
          aiConversationRecentTurns: 12,
          aiFanoutMaxTopics: 3,
          aiRetrievalMaxTurns: 4,
          aiInternalMaxSearches: 4,
          aiInternalMaxInspections: 4,
          aiWebMaxSearches: 2,
          aiWebMaxFetches: 2,
          aiWebMaxDomainFilters: 8,
          aiContextReductionMaxIterations: 2,
          aiMemoryToolResultMaxItems: 20,
          webResearchProvider: "tinyfish",
        },
        new WebManifestAgent("unused"),
        web,
      );
      const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
      const retrieval = inTask(`pending-${change}-boundary`, () =>
        operations.retrieveWeb(load, "What is the current update?", `pending-${change}-boundary`),
      );
      await boundaryEntered.promise;
      startAuthorization.resolve();
      await authorizationStarted.promise;
      await expect(retrieval).rejects.toThrow("revoked web operation reached transport");
      expect(transportCalls).toBe(1);
    },
    120_000,
  );

  it("fails closed before web use when the accepted policy is malformed", async () => {
    const fixture = await runDb(createFixture);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings
          set web_search_enabled = true
          where company_id = ${fixture.companyId}
        `;
      }),
    );
    let boundaryCalls = 0;
    const web: WebResearchBoundary = {
      search: async () => {
        boundaryCalls += 1;
        throw new Error("malformed accepted policy reached web search");
      },
      fetch: async () => {
        boundaryCalls += 1;
        throw new Error("malformed accepted policy reached web fetch");
      },
    };
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "tinyfish",
      },
      new WebManifestAgent("unused"),
      web,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await expect(
      inTask("malformed-policy-web", () =>
        operations.retrieveWeb(load, "What is the current update?", "malformed-policy-web"),
      ),
    ).rejects.toThrow("malformed accepted policy reached web search");
    expect(boundaryCalls).toBe(1);
  }, 120_000);

  it("uses the accepted web policy at finalization even when W returned no evidence", async () => {
    const fixture = await runDb(createFixture);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings
          set web_search_enabled = true
          where company_id = ${fixture.companyId}
        `;
        for (const [index, kind] of ["turn_plan"].entries()) {
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values (
              ${fixture.runId},
              (select chat_id from ai_runs where id = ${fixture.runId}),
              ${kind === "turn_plan" ? "plan-turn" : "fixture"}, 0, 0,
              ${`web-empty-finalize:${index}`}, ${kind},
              ${kind === "turn_plan" ? sql.json({ mode: "clarify", question: "fixture" }) : sql.json({})}
            )
          `;
        }
      }),
    );
    const config = {
      aiMainModel: "glm-5-turbo" as const,
      aiFastModel: "glm-5-turbo" as const,
      aiMainInputMaxTokens: 100_000,
      aiMainOutputMaxTokens: 4096,
      aiFastInputMaxTokens: 100_000,
      aiFastOutputMaxTokens: 4096,
      aiConversationRecentTurns: 12,
      aiFanoutMaxTopics: 3,
      aiRetrievalMaxTurns: 4,
      aiInternalMaxSearches: 4,
      aiInternalMaxInspections: 4,
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
      aiContextReductionMaxIterations: 2,
      aiMemoryToolResultMaxItems: 20,
      webResearchProvider: "tinyfish" as const,
    } satisfies CanonicalAiConfig;
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      config,
      new CanonicalAgentClient(testProviderBoundary()),
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    expect(load.acceptanceScope.webRequested).toBe(true);
    const memoryArtifact = await persistMemoryArtifact(fixture, {
      proposals: [],
      discardedCount: 0,
    });
    await runDb(seedPlanMeasurement(fixture));
    const finalization = inTask("finalize", () =>
      operations.finalize(
        load,
        {
          status: "ok",
          mode: "clarification",
          content: "No supporting web evidence.",
          sourceMap: [],
        },
        memoryArtifact,
        `ai-chat:${load.aiRunId}`,
      ),
    );
    await expect(finalization).resolves.toMatchObject({ status: "succeeded" });
  }, 120_000);

  it("keeps an accepted web scope after live settings change", async () => {
    const fixture = await runDb(createFixture);
    const config = {
      aiMainModel: "glm-5-turbo" as const,
      aiFastModel: "glm-5-turbo" as const,
      aiMainInputMaxTokens: 100_000,
      aiMainOutputMaxTokens: 4096,
      aiFastInputMaxTokens: 100_000,
      aiFastOutputMaxTokens: 4096,
      aiConversationRecentTurns: 12,
      aiFanoutMaxTopics: 3,
      aiRetrievalMaxTurns: 4,
      aiInternalMaxSearches: 4,
      aiInternalMaxInspections: 4,
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
      aiContextReductionMaxIterations: 2,
      aiMemoryToolResultMaxItems: 20,
      webResearchProvider: "tinyfish" as const,
    } satisfies CanonicalAiConfig;
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      config,
      new CanonicalAgentClient(testProviderBoundary()),
    );
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings
          set web_search_enabled = true
          where company_id = ${fixture.companyId}
        `;
      }),
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const selectors: SelectorBundle = {
      internal: [],
      memories: [],
      memorySelection: "enabled",
      web: [],
      webSelection: "enabled",
    };
    const context = await assembleAndMeasureContext(
      operations,
      load,
      "What changed?",
      selectors,
      "single-answer",
    );
    expect(context.status).toBe("ready");

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings
          set web_search_enabled = false
          where company_id = ${fixture.companyId}
        `;
      }),
    );
    const frozenAfterRevocation = await inTask("single-context-select", () =>
      operations.freezeContext(load, context),
    );
    expect(frozenAfterRevocation.status).toBe("ready");
    const retryContext = await assembleAndMeasureContext(
      operations,
      load,
      "What changed?",
      selectors,
      "single-answer",
    );
    const readyRetryContext = await inTask("single-context-select", () =>
      operations.freezeContext(load, retryContext),
    );
    expect(readyRetryContext.status).toBe("ready");
  }, 120_000);

  it("rejects invented or duplicate A and B manifests instead of silently dropping them", async () => {
    const memoryId = crypto.randomUUID();
    const memoryRevisionId = crypto.randomUUID();
    const memoryState = {
      kind: "fact",
      content: "The client tracks liquidity monthly.",
      deleted: false,
    } as const;
    const fixture = await runDb(
      createFixtureWithCanonicalText(
        "Liquidity conditions improved while inflation expectations remained anchored.",
        [],
        [
          {
            memoryId,
            memoryRevisionId,
            kind: memoryState.kind,
            content: memoryState.content,
            deleted: memoryState.deleted,
          },
        ],
      ),
    );
    const workflowConfig = {
      aiMainModel: "glm-5-turbo" as const,
      aiFastModel: "glm-5-turbo" as const,
      aiMainInputMaxTokens: 100_000,
      aiMainOutputMaxTokens: 4096,
      aiFastInputMaxTokens: 100_000,
      aiFastOutputMaxTokens: 4096,
      aiConversationRecentTurns: 12,
      aiFanoutMaxTopics: 3,
      aiRetrievalMaxTurns: 4,
      aiInternalMaxSearches: 4,
      aiInternalMaxInspections: 4,
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
      aiContextReductionMaxIterations: 2,
      aiMemoryToolResultMaxItems: 20,
      webResearchProvider: "" as const,
    } satisfies CanonicalAiConfig;
    const load = await inTask("load-turn", () =>
      new CanonicalWorkflowOperations(
        databaseUrlFor(databaseName),
        workflowConfig,
        new MemoryManifestAgent([]),
      ).loadTurn(fixture.runId),
    );
    const activeReference = { memoryId, memoryRevisionId };
    await expect(
      inTask("memory-invented", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          new MemoryManifestAgent([
            { memoryId: crypto.randomUUID(), memoryRevisionId: crypto.randomUUID() },
          ]),
        ).selectMemories(load, "What preference matters?", "memory-invented"),
      ),
    ).rejects.toThrow("invented an unavailable memory revision");
    await expect(
      inTask("memory-duplicate", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          new MemoryManifestAgent([activeReference, activeReference]),
        ).selectMemories(load, "What preference matters?", "memory-duplicate"),
      ),
    ).rejects.toThrow("duplicate reference");
    await expect(
      inTask("memory-valid", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          new MemoryManifestAgent([activeReference]),
        ).selectMemories(load, "What preference matters?", "memory-valid"),
      ),
    ).resolves.toEqual({ status: "enabled", entries: [activeReference] });
    const currentQuestionPulls = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from ai_source_exposures
          where run_id = ${fixture.runId}
            and task_id = 'memory-valid'
            and content_item_identity = ${load.userMessageId}
        `;
        return rows[0]?.count ?? -1;
      }),
    );
    expect(currentQuestionPulls).toBe(0);

    const undiscoveredReference: InternalReference = {
      kind: "document",
      documentId: fixture.documentId,
      snapshotId: fixture.snapshotId,
      publisherExtractionId: fixture.extractionId,
      source: {
        kind: "publisher",
        sourceId: `publisher:${fixture.subscriptionId}`,
        issueId: fixture.issueId,
        documentId: fixture.documentId,
      },
      ranges: [{ charStart: 0, charEnd: 20 }],
      purpose: "invent a manifest without discovery",
    };
    await expect(
      inTask("internal-undiscovered", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          new UndiscoveredInternalAgent(undiscoveredReference),
        ).retrieveInternal(load, "What changed?", "internal-undiscovered", []),
      ),
    ).rejects.toThrow("references undiscovered document");
    const duplicateInternal = new PublisherRetrievalAgent();
    duplicateInternal.sourceId = `publisher:${fixture.subscriptionId}`;
    duplicateInternal.duplicateManifest = true;
    await expect(
      inTask("internal-duplicate", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          duplicateInternal,
        ).retrieveInternal(load, "What changed?", "internal-duplicate", []),
      ),
    ).rejects.toThrow("internal manifest contains duplicate references");
    const uninspectedInternal = new PublisherRetrievalAgent();
    uninspectedInternal.sourceId = `publisher:${fixture.subscriptionId}`;
    uninspectedInternal.skipInspection = true;
    await expect(
      inTask("internal-uninspected", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          uninspectedInternal,
        ).retrieveInternal(load, "What changed?", "internal-uninspected", []),
      ),
    ).rejects.toThrow(
      "every selected internal reference must repeat an exact complete inspect_internal result",
    );
    const wholeAfterInspection = new PublisherRetrievalAgent();
    wholeAfterInspection.sourceId = `publisher:${fixture.subscriptionId}`;
    wholeAfterInspection.selectWholeAfterInspection = true;
    const wholeReference = await inTask("internal-whole-after-bounded-inspection", () =>
      new CanonicalWorkflowOperations(
        databaseUrlFor(databaseName),
        workflowConfig,
        wholeAfterInspection,
      ).retrieveInternal(load, "What changed?", "internal-whole-after-bounded-inspection", []),
    );
    expect(wholeReference).toEqual([
      expect.objectContaining({
        documentId: fixture.documentId,
        snapshotId: fixture.snapshotId,
      }),
    ]);
    expect(wholeReference[0]).not.toHaveProperty("ranges");
    const repeatedInternal = new PublisherRetrievalAgent();
    repeatedInternal.sourceId = `publisher:${fixture.subscriptionId}`;
    repeatedInternal.repeatInspection = true;
    await expect(
      inTask("internal-repeated-inspection", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          repeatedInternal,
        ).retrieveInternal(load, "What changed?", "internal-repeated-inspection", []),
      ),
    ).resolves.toHaveLength(1);

    const malformedFirstSearch = new PublisherRetrievalAgent();
    malformedFirstSearch.sourceId = `publisher:${fixture.subscriptionId}`;
    malformedFirstSearch.malformedFirstSearch = true;
    await expect(
      inTask("internal-malformed-first-search", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          { ...workflowConfig, aiInternalMaxSearches: 1 },
          malformedFirstSearch,
        ).retrieveInternal(load, "What changed?", "internal-malformed-first-search", []),
      ),
    ).resolves.toHaveLength(1);
  }, 120_000);

  it.each(["invalid", "oversized"] as const)(
    "feeds %s reducer-plan validation feedback into the next semantic loop iteration",
    async (firstPlan) => {
      const longText = "Liquidity evidence remains verbatim and immutable. ".repeat(8_000);
      const fixture = await runDb(createFixtureWithCanonicalText(longText));
      const agent = new CorrectingReducerAgent(firstPlan);
      const operations = new CanonicalWorkflowOperations(
        databaseUrlFor(databaseName),
        {
          aiMainModel: "glm-5-turbo",
          aiFastModel: "glm-5-turbo",
          aiMainInputMaxTokens: 2_000,
          aiMainOutputMaxTokens: 128,
          aiFastInputMaxTokens: 100_000,
          aiFastOutputMaxTokens: 4096,
          aiConversationRecentTurns: 12,
          aiFanoutMaxTopics: 3,
          aiRetrievalMaxTurns: 4,
          aiInternalMaxSearches: 4,
          aiInternalMaxInspections: 4,
          aiWebMaxSearches: 2,
          aiWebMaxFetches: 2,
          aiWebMaxDomainFilters: 8,
          aiContextReductionMaxIterations: 2,
          aiMemoryToolResultMaxItems: 20,
          webResearchProvider: "",
        },
        agent,
      );
      const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
      const initial = await assembleAndMeasureContext(
        operations,
        load,
        "What changed in liquidity?",
        {
          internal: [
            {
              kind: "document",
              documentId: fixture.documentId,
              snapshotId: fixture.snapshotId,
              publisherExtractionId: fixture.extractionId,
              source: {
                kind: "publisher",
                sourceId: `publisher:${fixture.subscriptionId}`,
                issueId: fixture.issueId,
                documentId: fixture.documentId,
              },
              ranges: [{ charStart: 0, charEnd: longText.length }],
              purpose: "answer with the complete liquidity evidence",
            },
          ],
          memories: [],
          memorySelection: "enabled",
          web: [],
          webSelection: "enabled",
        },
        "single-answer",
        undefined,
        [],
      );
      expect(initial.status).toBe("needs_reduction");
      const first = await inTask(
        "single-reduce-plan",
        () => operations.planReduction(load, initial, "single-reduce-plan", 0),
        { iteration: 0 },
      );
      const firstMeasurement = await inTask(
        "single-reduce-measure",
        () => operations.measureReduction(load, initial, first, "single-reduce-measure", 0),
        { iteration: 0 },
      );
      expect(firstMeasurement.status).toBe("needs_reduction");
      expect(firstMeasurement.reductionFeedback).toHaveLength(1);
      const corrected = await inTask(
        "single-reduce-plan",
        () => operations.planReduction(load, firstMeasurement, "single-reduce-plan", 1),
        { iteration: 1 },
      );
      const correctedMeasurement = await inTask(
        "single-reduce-measure",
        () =>
          operations.measureReduction(
            load,
            firstMeasurement,
            corrected,
            "single-reduce-measure",
            1,
          ),
        { iteration: 1 },
      );
      expect(correctedMeasurement).toMatchObject({
        status: "ready",
        candidates: [],
        sourceMap: [],
        reductionRan: true,
        reductionFeedback: [],
      });
      expect(agent.feedback).toEqual([[], firstMeasurement.reductionFeedback]);
      const decisions = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{ readonly loopIteration: number; readonly valid: boolean }>`
            select loop_iteration as "loopIteration", (payload->>'valid')::boolean as valid
            from ai_observations
            where run_id = ${fixture.runId}
              and emitting_task = 'single-reduce-measure'
              and kind = 'context_decision'
            order by loop_iteration
          `;
        }),
      );
      expect(decisions).toEqual([
        { loopIteration: 0, valid: firstPlan === "oversized" },
        { loopIteration: 1, valid: true },
      ]);
      const currentQuestionPulls = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const rows = yield* sql<{ readonly count: number }>`
            select count(*)::int as count
            from ai_source_exposures
            where run_id = ${fixture.runId}
              and task_id = 'single-reduce-plan'
              and content_item_identity = ${load.userMessageId}
          `;
          return rows[0]?.count ?? -1;
        }),
      );
      expect(currentQuestionPulls).toBe(0);
    },
    120_000,
  );

  it.each([
    ["valid", true, ""],
    ["invalid-after-success", false, "successful prior measurement"],
    ["unmeasured", false, "successful prior measurement"],
    ["drift", false, "drifted from its successfully measured decisions"],
  ] as const)(
    "enforces the reducer measurement phase for a %s terminal plan",
    async (mode, succeeds, message) => {
      const longText = "Liquidity evidence remains verbatim and immutable. ".repeat(8_000);
      const fixture = await runDb(createFixtureWithCanonicalText(longText));
      const operations = new CanonicalWorkflowOperations(
        databaseUrlFor(databaseName),
        {
          aiMainModel: "glm-5-turbo",
          aiFastModel: "glm-5-turbo",
          aiMainInputMaxTokens: 2_000,
          aiMainOutputMaxTokens: 128,
          aiFastInputMaxTokens: 100_000,
          aiFastOutputMaxTokens: 4096,
          aiConversationRecentTurns: 12,
          aiFanoutMaxTopics: 3,
          aiRetrievalMaxTurns: 4,
          aiInternalMaxSearches: 4,
          aiInternalMaxInspections: 4,
          aiWebMaxSearches: 2,
          aiWebMaxFetches: 2,
          aiWebMaxDomainFilters: 8,
          aiContextReductionMaxIterations: 2,
          aiMemoryToolResultMaxItems: 20,
          webResearchProvider: "",
        },
        new ReducerProtocolProbeAgent(mode),
      );
      const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
      const initial = await assembleAndMeasureContext(
        operations,
        load,
        "What changed in liquidity?",
        {
          internal: [
            {
              kind: "document",
              documentId: fixture.documentId,
              snapshotId: fixture.snapshotId,
              publisherExtractionId: fixture.extractionId,
              source: {
                kind: "publisher",
                sourceId: `publisher:${fixture.subscriptionId}`,
                issueId: fixture.issueId,
                documentId: fixture.documentId,
              },
              ranges: [{ charStart: 0, charEnd: longText.length }],
              purpose: "answer with the complete liquidity evidence",
            },
          ],
          memories: [],
          memorySelection: "enabled",
          web: [],
          webSelection: "enabled",
        },
        "single-answer",
        undefined,
        [],
      );
      expect(initial.status).toBe("needs_reduction");

      const reduction = inTask("single-reduce-plan", () =>
        operations.planReduction(load, initial, "single-reduce-plan", 0),
      );
      if (succeeds) {
        await expect(reduction).resolves.toMatchObject({ decisions: expect.any(Array) });
      } else {
        await expect(reduction).rejects.toThrow(message);
      }
    },
    120_000,
  );

  it("requires and binds a narrower immutable publisher range after an oversized inspection", async () => {
    const canonicalText = "Liquidity evidence remains verbatim and immutable. ".repeat(8_000);
    const fixture = await runDb(createFixtureWithCanonicalText(canonicalText));
    const agent = new PublisherRetrievalAgent();
    agent.narrowerRange = true;
    agent.sourceId = `publisher:${fixture.subscriptionId}`;
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const references = await inTask("oversized-range-retrieve", () =>
      operations.retrieveInternal(
        load,
        "What changed in liquidity?",
        "oversized-range-retrieve",
        [],
      ),
    );
    expect(agent.firstInspectionWasTooLarge).toBe(true);
    expect(references).toEqual([
      expect.objectContaining({
        kind: "document",
        documentId: fixture.documentId,
        snapshotId: fixture.snapshotId,
        publisherExtractionId: fixture.extractionId,
        source: {
          kind: "publisher",
          sourceId: `publisher:${fixture.subscriptionId}`,
          issueId: fixture.issueId,
          documentId: fixture.documentId,
        },
        ranges: [agent.selectedRange],
      }),
    ]);
    const persisted = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const exposures = yield* sql<{
          readonly snapshotId: string;
          readonly contentHash: string;
          readonly sourceId: string;
          readonly documentId: string;
          readonly publisherExtractionId: string;
          readonly ranges: unknown;
        }>`
          select snapshot_id as "snapshotId",
                 content_hash as "contentHash",
                 document_source_id as "sourceId",
                 document_id as "documentId",
                 publisher_extraction_id::text as "publisherExtractionId",
                 document_ranges as ranges
          from ai_source_exposures
          where run_id = ${fixture.runId}
            and task_id = 'oversized-range-retrieve'
            and exposure_stage = 'internal_inspection'
        `;
        const manifests = yield* sql<{ readonly references: unknown }>`
          select payload->'references' as references
          from ai_observations
          where run_id = ${fixture.runId}
            and emitting_task = 'oversized-range-retrieve'
            and kind = 'retrieval_manifest'
        `;
        const versions = yield* sql<{
          readonly documentId: string;
          readonly snapshotId: string;
          readonly contentHash: string;
          readonly publisherExtractionId: string;
          readonly canonicalText: string;
        }>`
          select versions.brief_document_id::text as "documentId",
                  versions.id::text as "snapshotId",
                  versions.content_hash as "contentHash",
                  versions.publisher_extraction_id::text as "publisherExtractionId",
                  versions.canonical_text as "canonicalText"
             from brief_document_versions versions
            where versions.id = ${fixture.snapshotId}
        `;
        const extractions = yield* sql<{
          readonly extractionId: string;
          readonly inputSha256Hex: string;
          readonly pages: unknown;
        }>`
          select id::text as "extractionId",
                 input_sha256_hex as "inputSha256Hex",
                 pages
            from brief_document_extractions
           where id = ${fixture.extractionId}
        `;
        return { exposures, manifests, versions, extractions };
      }),
    );
    expect(persisted.exposures).toEqual([
      {
        snapshotId: fixture.snapshotId,
        contentHash: fixture.contentHash,
        sourceId: `publisher:${fixture.subscriptionId}`,
        documentId: fixture.documentId,
        publisherExtractionId: fixture.extractionId,
        ranges: [agent.selectedRange],
      },
    ]);
    expect(agent.narrowedInspectionText).toBe(
      canonicalText.slice(agent.selectedRange.charStart, agent.selectedRange.charEnd),
    );
    expect(persisted.versions).toEqual([
      {
        documentId: fixture.documentId,
        snapshotId: fixture.snapshotId,
        contentHash: fixture.contentHash,
        publisherExtractionId: fixture.extractionId,
        canonicalText,
      },
    ]);
    expect(persisted.extractions).toEqual([
      {
        extractionId: fixture.extractionId,
        inputSha256Hex: fixture.contentHash,
        pages: [{ pageNumber: 1, text: canonicalText }],
      },
    ]);
    const persistedExposure = persisted.exposures[0];
    const persistedVersion = persisted.versions[0];
    if (persistedExposure === undefined || persistedVersion === undefined) {
      throw new Error("missing persisted narrowed publisher binding");
    }
    const persistedRanges = persistedExposure.ranges as readonly {
      readonly charStart: number;
      readonly charEnd: number;
    }[];
    expect(persistedVersion.contentHash).toBe(
      createHash("sha256").update(persistedVersion.canonicalText, "utf8").digest("hex"),
    );
    expect(
      persistedRanges
        .map((range) => persistedVersion.canonicalText.slice(range.charStart, range.charEnd))
        .join("\n…\n"),
    ).toBe(agent.narrowedInspectionText);
    expect(persisted.manifests).toEqual([
      {
        references: [
          {
            kind: "document",
            documentId: fixture.documentId,
            snapshotId: fixture.snapshotId,
            publisherExtractionId: fixture.extractionId,
            source: {
              kind: "publisher",
              sourceId: `publisher:${fixture.subscriptionId}`,
              issueId: fixture.issueId,
              documentId: fixture.documentId,
            },
            ranges: [agent.selectedRange],
            purpose: "answer the liquidity question",
          },
        ],
      },
    ]);
  }, 120_000);

  it("keeps reducer inspection and measurement available after malformed search arguments", async () => {
    const longText = "Liquidity evidence remains verbatim and immutable. ".repeat(8_000);
    const fixture = await runDb(createFixtureWithCanonicalText(longText));
    const providerRequests: LiveProviderRequest[] = [];
    let providerTurn = 0;
    const client = new CanonicalAgentClient({
      bindAcceptedProviderProfile: () => undefined,
      complete: async (
        request: LiveProviderRequest,
        coordinates: PiBoundaryCoordinates,
        beforeProviderRequest?: BeforeProviderRequest,
      ) => {
        providerRequests.push(request);
        await beforeProviderRequest?.(
          request,
          {
            ...coordinates,
            providerRequestSha256Hex: providerRequestSha256Hex(request),
          },
          {} as LiveProviderRequestMeasurement,
        );
        const initialUser = request.messages.find((message) => message.role === "user");
        if (initialUser === undefined) throw new Error("missing reducer input");
        const candidates = (
          JSON.parse(initialUser.content) as {
            readonly candidates: readonly { readonly id: string }[];
          }
        ).candidates;
        const candidateId = candidates[0]?.id;
        if (candidateId === undefined) throw new Error("missing reducer candidate");
        const decisions = candidates.map((candidate) => ({
          id: candidate.id,
          action: "omit",
          reason: "omit evidence to satisfy the exact allowance",
        }));
        const completion =
          providerTurn === 0
            ? providerToolCompletion(
                "search_within_candidate",
                { id: candidateId },
                "reducer-search-malformed",
              )
            : providerTurn === 1
              ? providerToolCompletion(
                  "inspect_candidate",
                  { id: candidateId, range: { charStart: 0, charEnd: 100 } },
                  "reducer-inspect",
                )
              : providerTurn === 2
                ? providerToolCompletion("measure_plan", { decisions }, "reducer-measure")
                : providerToolCompletion("emit_context_plan", { decisions }, "reducer-terminal");
        providerTurn += 1;
        return completion;
      },
    } as unknown as ExactPiBoundary);
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 2_000,
        aiMainOutputMaxTokens: 128,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      client,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const initial = await assembleAndMeasureContext(
      operations,
      load,
      "What changed in liquidity?",
      {
        internal: [
          {
            kind: "document",
            documentId: fixture.documentId,
            snapshotId: fixture.snapshotId,
            publisherExtractionId: fixture.extractionId,
            source: {
              kind: "publisher",
              sourceId: `publisher:${fixture.subscriptionId}`,
              issueId: fixture.issueId,
              documentId: fixture.documentId,
            },
            ranges: [{ charStart: 0, charEnd: longText.length }],
            purpose: "answer with the complete liquidity evidence",
          },
        ],
        memories: [],
        memorySelection: "enabled",
        web: [],
        webSelection: "enabled",
      },
      "single-answer",
      undefined,
      [],
    );
    expect(initial.status).toBe("needs_reduction");
    await expect(
      inTask("malformed-reducer-plan", () =>
        operations.planReduction(load, initial, "malformed-reducer-plan", 0),
      ),
    ).resolves.toMatchObject({ decisions: expect.any(Array) });
    expect((providerRequests[1]?.tools ?? []).map((tool) => tool.name)).toEqual([
      "inspect_candidate",
      "search_within_candidate",
    ]);
    expect((providerRequests[2]?.tools ?? []).map((tool) => tool.name)).toContain("measure_plan");
    expect(providerRequests).toHaveLength(4);
  }, 120_000);

  it("calls C for a token-bounded empty prior inventory and lets O omit selected history", async () => {
    const fixture = await runDb(createFixture);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const messages = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content, created_at)
          select chat_id, 'user', ${"historical context ".repeat(5_000)}, now() - interval '1 minute'
          from ai_runs where id = ${fixture.runId}
          returning id::text
        `;
        const messageId = messages[0]?.id;
        if (messageId === undefined) return yield* Effect.fail(new Error("message insert failed"));
        yield* sql`
          insert into ai_runs (
            chat_id, initiating_user_id, user_message_id, locale, market,
            acceptance_scope, failed_at, error_code,
            retryable, created_at
          )
          select chat_id, initiating_user_id, ${messageId}, 'en-US', 'US', acceptance_scope,
                 now(), 'finalization_failed', false, now() - interval '1 minute'
          from ai_runs where id = ${fixture.runId}
        `;
      }),
    );
    const agent = new EmptyInventoryConversationAgent();
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 2_000,
        aiMainOutputMaxTokens: 128,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));

    await inTask("plan-turn", () => operations.planTurn(load));
    expect(agent.calls).toBe(1);
    expect(agent.entries).toHaveLength(1);

    const priorTurns = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly turnId: string; readonly messageId: string }>`
          select id::text as "turnId", user_message_id::text as "messageId"
          from ai_runs
          where chat_id = ${load.chatId}
            and id <> ${load.aiRunId}
            and (finished_at is not null or failed_at is not null)
          order by created_at desc, id desc
          limit 1
        `;
      }),
    );
    const turnId = priorTurns[0]?.turnId;
    const priorMessageId = priorTurns[0]?.messageId;
    if (turnId === undefined) throw new Error("prior conversation entry was not loaded");
    if (priorMessageId === undefined) throw new Error("prior conversation message was not loaded");
    const initial = await assembleAndMeasureContext(
      operations,
      load,
      "What changed in liquidity?",
      {
        internal: [
          {
            kind: "chat_message",
            messageId: priorMessageId,
            purpose: "duplicate the selected recent conversation",
          },
        ],
        memories: [],
        memorySelection: "enabled",
        web: [],
        webSelection: "enabled",
      },
      "single-answer",
      undefined,
      [turnId],
    );
    expect(initial).toMatchObject({
      status: "needs_reduction",
      candidates: [],
      ledgerCandidates: [],
      selectedConversation: [{ turnId }],
      ledgerConversation: [{ turnId }],
    });
    const duplicateRejections = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly candidateId: string; readonly reason: string }>`
          select payload->>'candidateId' as "candidateId", payload->>'reason' as reason
          from ai_observations
          where run_id = ${fixture.runId}
            and emitting_task = 'single-assemble'
            and kind = 'candidate_rejected'
            and payload->>'reason' = 'duplicate'
        `;
      }),
    );
    expect(duplicateRejections).toEqual([
      { candidateId: `chat_message:${priorMessageId}`, reason: "duplicate" },
    ]);
    const initialMeasurements = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly emittingTask: string }>`
          select emitting_task as "emittingTask"
          from ai_observations
          where run_id = ${fixture.runId}
            and emitting_task = 'single-measure'
            and kind = 'context_measurement'
        `;
      }),
    );
    expect(initialMeasurements).toEqual([{ emittingTask: "single-measure" }]);
    const reduced = await inTask("single-reduce-measure", () =>
      operations.measureReduction(
        load,
        initial,
        {
          decisions: [
            {
              id: `conversation_entry:${turnId}`,
              action: "omit",
              reason: "omit irrelevant prior history to fit the exact request",
            },
          ],
        },
        "single-reduce-measure",
        0,
      ),
    );
    expect(reduced).toMatchObject({
      status: "ready",
      selectedConversation: [],
      ledgerConversation: [{ turnId }],
      reductionRan: true,
    });
  }, 120_000);

  it("bounds the live prior-turn inventory before plan-turn", async () => {
    const fixture = await runDb(createFixture);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        for (let index = 0; index < 15; index += 1) {
          const messages = yield* sql<{ readonly id: string }>`
            insert into chat_messages (chat_id, author, content, created_at)
            select chat_id, 'user', ${`Prior failed turn ${index}`}, now() - (${15 - index} * interval '1 second')
            from ai_runs where id = ${fixture.runId}
            returning id::text
          `;
          const messageId = messages[0]?.id;
          if (messageId === undefined)
            return yield* Effect.fail(new Error("message insert failed"));
          yield* sql`
            insert into ai_runs (
              chat_id, initiating_user_id, user_message_id, locale, market,
              acceptance_scope, failed_at, error_code,
              retryable, created_at
            )
            select chat_id, initiating_user_id, ${messageId}, 'en-US', 'US', acceptance_scope,
                   now(), 'finalization_failed', false,
                   now() - (${15 - index} * interval '1 second')
            from ai_runs where id = ${fixture.runId}
          `;
        }
      }),
    );
    const agent = new EmptyInventoryConversationAgent();
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await inTask("plan-turn", () => operations.planTurn(load));
    expect(agent.entries).toHaveLength(12);
  }, 120_000);
});
