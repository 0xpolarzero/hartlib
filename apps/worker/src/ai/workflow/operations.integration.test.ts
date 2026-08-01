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
  MemoryExtractionArtifact,
  MemoryExtractionResult,
  MemoryReference,
  LiveProviderRequestMeasurement,
} from "../runtime/types";
import { WebBoundaryError } from "../web/errors";
import type { CompactionPassResult } from "../context/compaction-runtime";
import { buildCandidatePassageIndex } from "../context/compaction";
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
import { StructuredRetrievalTraceSchema } from "../retrieval/query-spec";

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
      candidateId:
        source.locator.kind === "document"
          ? namespacedDocumentEvidenceIdentity(
              source.locator.publisherIssueId === undefined
                ? { kind: "public", sourceId: source.locator.sourceId }
                : {
                    kind: "publisher",
                    sourceId: source.locator.sourceId,
                    issueId: source.locator.publisherIssueId,
                    documentId: source.locator.publisherDocumentId!,
                  },
              source.locator.documentId,
            )
          : source.locator.kind === "chat_message"
            ? chatMessageEvidenceIdentity(source.locator.messageId)
            : source.locator.kind === "memory"
              ? memoryEvidenceIdentity(source.locator.memoryId)
              : webEvidenceIdentity(source.locator.url, source.locator.quote),
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
  await input.onBeforeRequest?.(
    request,
    { ...coordinates, providerRequestSha256Hex: providerRequestSha256Hex(request) },
    passedMeasurement(input.model),
  );
};
const invokeStructuredProviderHook = async <Output>(
  input: StructuredCallInput<Output>,
): Promise<void> => {
  const request: LiveProviderRequest = input.request ?? {
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

const chatReconstructionFor = (
  messageId: string,
  text: string,
  ranges: readonly { readonly charStart: number; readonly charEnd: number }[] = [
    { charStart: 0, charEnd: text.length },
  ],
) => ({
  messageId,
  contentHash: createHash("sha256").update(text, "utf8").digest("hex"),
  ranges,
});
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
      chatReconstruction: chatReconstructionFor(contentItemIdentity, visibleText),
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
    ...sourceMarkers.map((marker, index) => {
      const source = context.sourceMap[index];
      const candidate = context.candidates[index];
      if (source === undefined || candidate === undefined) {
        throw new Error("answer source lacks its candidate");
      }
      const use = source.uses.find(
        (entry) => entry.consumerTaskId === consumerTaskId && entry.topicId === context.topicId,
      );
      return {
        ...marker,
        visibleText: candidateText(candidate),
        ...(marker.sourceKind === "chat_message"
          ? {
              chatReconstruction: chatReconstructionFor(
                marker.contentItemIdentity,
                candidateText(candidate),
                use?.ranges,
              ),
            }
          : {}),
      };
    }),
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
              chatReconstruction: chatReconstructionFor(
                locator.messageId,
                candidateText(context.candidates[sourceIndex]!),
                use.ranges,
              ),
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
    "single-compact-plan": "context_manifest",
    "single-fallback-plan": "context_fallback_manifest",
    "single-answer": "direct_answer",
    "topic-t1-retrieve-internal": "internal_retrieval",
    "topic-t1-select-memories": "memory_selector",
    "topic-t1-retrieve-web": "web_research",
    "topic-t1-compact-plan": "context_manifest",
    "topic-t1-fallback-plan": "context_fallback_manifest",
    "topic-t1-answer": "topic_answer",
    "topic-t2-retrieve-internal": "internal_retrieval",
    "topic-t2-select-memories": "memory_selector",
    "topic-t2-retrieve-web": "web_research",
    "topic-t2-compact-plan": "context_manifest",
    "topic-t2-fallback-plan": "context_fallback_manifest",
    "topic-t2-answer": "topic_answer",
    "topic-t3-retrieve-internal": "internal_retrieval",
    "topic-t3-select-memories": "memory_selector",
    "topic-t3-retrieve-web": "web_research",
    "topic-t3-compact-plan": "context_manifest",
    "topic-t3-fallback-plan": "context_fallback_manifest",
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

const phaseBOperationConfig: CanonicalAiConfig = {
  aiMainModel: "glm-5-turbo",
  aiFastModel: "glm-5-turbo",
  aiMainInputMaxTokens: 100_000,
  aiMainOutputMaxTokens: 4096,
  aiFastInputMaxTokens: 100_000,
  aiFastOutputMaxTokens: 4096,
  aiConversationRecentTurns: 12,
  aiFanoutMaxTopics: 3,
  aiWebMaxSearches: 2,
  aiWebMaxFetches: 2,
  aiWebMaxDomainFilters: 8,
  aiMemoryToolResultMaxItems: 20,
  webResearchProvider: "",
  aiRetrievalMaxQueries: 24,
  aiRetrievalMaxBranchRows: 25,
  aiRetrievalMaxCandidates: 64,
  aiRetrievalMaxHydratedBytes: 2_000_000,
  aiRetrievalMaxConcurrency: 2,
  aiRetrievalQueryTimeoutMs: 10_000,
};

const prepareOversizedCompaction = async (
  agent: PhaseDCompactionAgent,
  fastInputMaxTokens = 100_000,
  chatContent?: string | readonly string[],
  mainInputMaxTokens = 780,
) => {
  // The fixture contains an oversized candidate inventory while its smallest
  // compaction result remains within the configured main-input allowance.
  const fixture = await runDb(
    createFixtureWithCanonicalText(
      `Liquidity ${"a!".repeat(130)}\n${"Liquidity evidence remains verbatim and immutable. ".repeat(10_000)}`,
    ),
  );
  if (chatContent !== undefined) {
    const chatContents = typeof chatContent === "string" ? [chatContent] : chatContent;
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        for (const [index, content] of chatContents.entries()) {
          yield* sql`
            insert into chat_messages (chat_id, author, content, created_at)
            select chat_id, 'assistant', ${content},
                   now() - interval '1 hour' - (${index} * interval '1 minute')
            from ai_runs
            where id = ${fixture.runId}
          `;
        }
      }),
    );
  }
  const operations = new CanonicalWorkflowOperations(
    databaseUrlFor(databaseName),
    {
      ...phaseBOperationConfig,
      aiMainInputMaxTokens: mainInputMaxTokens,
      aiMainOutputMaxTokens: 128,
      aiFastInputMaxTokens: fastInputMaxTokens,
    },
    agent,
  );
  const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
  const structuredInternal = await inTask("single-retrieve-internal", () =>
    operations.retrieveStructuredInternal(
      load,
      "What changed in liquidity?",
      "single-retrieve-internal",
      [],
    ),
  );
  const initial = await assembleAndMeasureContext(
    operations,
    load,
    "What changed in liquidity?",
    {
      structuredInternal,
      memories: [],
      memorySelection: "enabled",
      web: [],
      webSelection: "enabled",
    },
    "single-answer",
  );
  expect(initial.status).toBe("needs_compaction");
  expect(initial.inputTokens).toBeGreaterThan(initial.usableInputTokens);
  const oversizedCandidate = initial.candidateLedger.candidates.find(
    (candidate) =>
      candidate.kind === "document" ||
      (chatContent !== undefined && candidate.kind === "chat_message"),
  );
  expect(oversizedCandidate).toBeDefined();
  if (oversizedCandidate === undefined) throw new Error("oversized fixture lost its source");
  const passageIndex = buildCandidatePassageIndex(oversizedCandidate, {
    maxTokens: Math.max(1, Math.min(phaseBOperationConfig.aiFastOutputMaxTokens, 256)),
    maxUtf8Bytes: 8_192,
    countTokens: resolveRegisteredModel(load.acceptanceScope.fastModelId).countTextTokens,
    authorizedRanges: oversizedCandidate.baseRanges,
  });
  const minimumPassageCost = Math.min(
    ...passageIndex.passages.map((passage) => passage.tokenCount),
  );
  expect(passageIndex.passages.length).toBeGreaterThan(1);
  expect(oversizedCandidate.renderedTokenCount).toBeGreaterThan(minimumPassageCost);
  return { fixture, operations, load, initial };
};

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

class IntegrationAgentClient extends CanonicalAgentClient {
  constructor() {
    super(testProviderBoundary());
  }

  override async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    if (input.outputToolName === "emit_internal_query_plan") {
      let question = "evidence";
      try {
        const parsed = JSON.parse(input.user) as { readonly question?: unknown };
        if (typeof parsed.question === "string") question = parsed.question;
      } catch {
        // The provider boundary will report malformed user input in production.
      }
      const term =
        question
          .toLocaleLowerCase()
          .match(/[a-z][a-z0-9-]{4,}/gu)
          ?.sort((left, right) => right.length - left.length)[0] ?? "evidence";
      const chat =
        /\b(older|message|statement|needle|conversation|boundary|subject|comparison)\b/iu.test(
          question,
        );
      await invokeStructuredProviderHook(input);
      return input.validate({
        action: "search",
        queries: [
          {
            purpose: "retrieve the requested evidence",
            ...(chat ? { scope: "chat_messages" } : { scope: "documents" }),
            all: [{ text: term, mode: "term" }],
            anyOf: [],
            not: [],
            filters: chat ? { chatMessages: {} } : { documents: {} },
            order: "relevance",
          },
        ],
      });
    }
    if (input.outputToolName === "emit_internal_query_review") {
      await invokeStructuredProviderHook(input);
      return input.validate({ action: "accept", reason: "sufficient_coverage" });
    }
    return super.structured(input);
  }
}
class StructuredNoEvidenceAgent extends IntegrationAgentClient {
  override async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    if (input.outputToolName === "emit_internal_query_review") {
      await invokeStructuredProviderHook(input);
      return input.validate({ action: "no_evidence", reason: "no_supporting_evidence" });
    }
    return super.structured(input);
  }
}

class StructuredSkipAgent extends IntegrationAgentClient {
  override async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    if (input.outputToolName === "emit_internal_query_plan") {
      await invokeStructuredProviderHook(input);
      return input.validate({ action: "skip", reason: "not needed" });
    }
    return super.structured(input);
  }
}

class ReviewReplacingAgent extends IntegrationAgentClient {
  constructor() {
    super();
  }

  override async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    if (input.outputToolName === "emit_internal_query_plan") {
      await invokeStructuredProviderHook(input);
      return input.validate({
        action: "search",
        queries: [
          {
            purpose: "retrieve the macro evidence",
            all: [{ text: "liquidity", mode: "term" }],
            anyOf: [],
            not: [],
            filters: { documents: {} },
            order: "relevance",
          },
        ],
      });
    }
    if (input.outputToolName === "emit_internal_query_review") {
      await invokeStructuredProviderHook(input);
      return input.validate({
        action: "accept",
        reason: "sufficient_coverage",
      });
    }
    return super.structured(input);
  }
}
class StructuredReplacementAgent extends IntegrationAgentClient {
  reviewCalls = 0;

  override async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    if (input.outputToolName === "emit_internal_query_plan") {
      await invokeStructuredProviderHook(input);
      return input.validate({
        action: "search",
        queries: [
          {
            purpose: "retrieve liquidity evidence",
            all: [{ text: "liquidity", mode: "term" }],
            anyOf: [],
            not: [],
            filters: { documents: {} },
            order: "relevance",
          },
        ],
      });
    }
    if (input.outputToolName === "emit_internal_query_review") {
      await invokeStructuredProviderHook(input);
      this.reviewCalls += 1;
      return input.validate(
        this.reviewCalls === 1
          ? {
              action: "replace",
              reason: "missed_concept",
              queries: [
                {
                  purpose: "retrieve expectations evidence",
                  all: [{ text: "expectations", mode: "term" }],
                  anyOf: [],
                  not: [],
                  filters: { documents: {} },
                  order: "relevance",
                },
              ],
            }
          : { action: "accept", reason: "sufficient_coverage" },
      );
    }
    return super.structured(input);
  }
}

class StructuredMalformedRecoveryAgent extends IntegrationAgentClient {
  planCalls = 0;
  reviewCalls = 0;
  private readonly reviewCallsByTask = new Map<string, number>();

  override async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    if (
      input.outputToolName === "emit_internal_query_plan" ||
      input.outputToolName === "emit_internal_query_review"
    ) {
      await invokeStructuredProviderHook(input);
      if (input.outputToolName === "emit_internal_query_plan") {
        this.planCalls += 1;
        return input.validate(
          this.planCalls === 1
            ? { action: "search", queries: [] }
            : {
                action: "search",
                queries: [
                  {
                    purpose: "retrieve liquidity evidence",
                    all: [{ text: "liquidity", mode: "term" }],
                    anyOf: [],
                    not: [],
                    filters: { documents: {} },
                    order: "relevance",
                  },
                ],
              },
        );
      }
      this.reviewCalls += 1;
      const reviewTaskId = input.coordinates?.taskId ?? "";
      const taskReviewCalls = (this.reviewCallsByTask.get(reviewTaskId) ?? 0) + 1;
      this.reviewCallsByTask.set(reviewTaskId, taskReviewCalls);
      return input.validate(
        reviewTaskId === "malformed-review-retry" && taskReviewCalls === 1
          ? {
              action: "replace",
              reason: "missed_concept",
              queries: [],
            }
          : { action: "accept", reason: "sufficient_coverage" },
      );
    }

    return super.structured(input);
  }
}

class PublisherRetrievalAgent extends IntegrationAgentClient {
  onAfterFirstSearch?: () => Promise<void>;
}

class PhaseDCompactionAgent extends IntegrationAgentClient {
  manifestCalls = 0;
  groupCalls = 0;
  fallbackCalls = 0;

  constructor(private readonly mode: "select" | "repair" | "fallback-omit" = "select") {
    super();
  }

  override async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    if (input.outputToolName === "emit_context_manifest") {
      this.manifestCalls += 1;
      const inventory = JSON.parse(input.user) as {
        readonly allowance: number;
        readonly mandatoryInputCost: number;
        readonly candidates: readonly {
          readonly candidateId: string;
          readonly kind: string;
          readonly renderedTokenCount: number;
        }[];
      };
      const eligible = inventory.candidates.find(
        (candidate) => candidate.kind === "document" || candidate.kind === "chat_message",
      );
      if (eligible === undefined) {
        return input.validate({
          decisions: inventory.candidates.map((candidate) => ({
            candidateId: candidate.candidateId,
            action: "keep",
            reason: "retain non-compacted evidence",
          })),
          groups: [],
        });
      }
      const keptCost = inventory.candidates
        .filter((candidate) => candidate.candidateId !== eligible.candidateId)
        .reduce((total, candidate) => total + candidate.renderedTokenCount, 0);
      const remainingAnswerTokens = inventory.allowance - inventory.mandatoryInputCost - keptCost;
      return input.validate({
        decisions: inventory.candidates.map((candidate) =>
          candidate.candidateId === eligible.candidateId
            ? {
                candidateId: candidate.candidateId,
                action: "compact",
                groupId: "g1",
                reason: "select exact evidence passages",
              }
            : {
                candidateId: candidate.candidateId,
                action: "keep",
                reason: "retain mandatory evidence",
              },
        ),
        groups: [
          {
            groupId: "g1",
            renderedTokenBudget: Math.max(
              1,
              Math.min(eligible.renderedTokenCount - 1, remainingAnswerTokens),
            ),
          },
        ],
      });
    }
    if (input.outputToolName === "emit_fallback_context_manifest") {
      this.fallbackCalls += 1;
      const inventory = JSON.parse(input.user) as {
        readonly originalCandidates: readonly { readonly candidateId: string }[];
      };
      return input.validate({
        decisions: inventory.originalCandidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          action: "omit",
          reason: "close the bounded fallback without restoring evidence",
        })),
        groups: [],
      });
    }
    if (input.outputToolName === "emit_compaction_result") {
      this.groupCalls += 1;
      const payload = JSON.parse(input.user) as {
        readonly candidates?: readonly {
          readonly candidateId: string;
          readonly passages: readonly {
            readonly passageId: string;
            readonly text: string;
          }[];
        }[];
      };
      const selectSmallestPassage = (
        candidate: NonNullable<typeof payload.candidates>[number],
      ): readonly string[] => {
        const passage = candidate.passages.reduce((smallest, current) =>
          resolveRegisteredModel(input.model).countTextTokens(current.text) <
          resolveRegisteredModel(input.model).countTextTokens(smallest.text)
            ? current
            : smallest,
        );
        return [passage.passageId];
      };
      if (this.mode === "repair" && this.groupCalls === 1) {
        try {
          return input.validate({
            decisions: [
              {
                candidateId: "invalid-candidate",
                action: "omit",
                reason: "trigger one semantic repair",
              },
            ],
          });
        } catch (error) {
          const repair = input.repair?.(error, input.coordinates);
          if (repair === undefined) throw error;
          this.groupCalls += 1;
          return input.validate({
            decisions: (payload.candidates ?? []).map((candidate) => ({
              candidateId: candidate.candidateId,
              action: "select",
              passageIds: selectSmallestPassage(candidate),
              reason: "retain the smallest exact passage after repair",
            })),
          });
        }
      }
      return input.validate({
        decisions: (payload.candidates ?? []).map((candidate) => ({
          candidateId: candidate.candidateId,
          action: "select",
          passageIds: selectSmallestPassage(candidate),
          reason: "retain the smallest exact passage",
        })),
      });
    }
    return super.structured(input);
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    if (input.terminalToolName !== "emit_compaction_result") {
      return super.toolLoop(input);
    }
    const payload = JSON.parse(input.user) as {
      readonly candidate: { readonly candidateId: string };
    };
    const search = input.tools.find((tool) => tool.definition.name === "search_source_passages");
    if (search === undefined) throw new Error("missing source-local search tool");
    const found = (await search.execute(
      { candidateId: payload.candidate.candidateId, query: "evidence" },
      {
        ...input.coordinates,
        loopIteration: 0,
        providerRequestIndex: 0,
      },
    )) as { readonly passages?: readonly { readonly passageId: string }[] };
    const passageId = found.passages?.[0]?.passageId;
    if (passageId === undefined) throw new Error("source-local search returned no passage");
    return input.validateTerminal({
      decisions: [
        {
          candidateId: payload.candidate.candidateId,
          action: "select",
          passageIds: [passageId],
          reason: "retain a source-local exact passage",
        },
      ],
    });
  }
}
type CompactionStructuredObservation = {
  readonly payload: {
    readonly group?: {
      readonly groupId: string;
      readonly candidateIds: readonly string[];
      readonly renderedTokenBudget: number;
      readonly mode: string;
    };
    readonly candidates?: readonly {
      readonly candidateId: string;
      readonly passages: readonly {
        readonly passageId: string;
        readonly text: string;
      }[];
    }[];
    readonly priorResult?: {
      readonly decisions: readonly {
        readonly candidateId: string;
        readonly action: "select" | "omit";
        readonly passageIds?: readonly string[];
      }[];
    };
  };
  readonly proofs: readonly (ProviderVisibleSourceExposureMarker & {
    readonly candidateId?: string | undefined;
    readonly passageId?: string | undefined;
  })[];
  readonly request: LiveProviderRequest | undefined;
  readonly validate: (value: unknown) => unknown;
};

class PriorPassageFallbackAgent extends PhaseDCompactionAgent {
  readonly fallbackGroupObservations: CompactionStructuredObservation[] = [];

  override async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    if (input.outputToolName === "emit_internal_query_plan") {
      await invokeStructuredProviderHook(input);
      return input.validate({
        action: "search",
        queries: [
          {
            purpose: "retrieve the long chat evidence",
            scope: "chat_messages",
            all: [{ text: "evidence", mode: "term" }],
            anyOf: [],
            not: [],
            filters: { chatMessages: {} },
            order: "relevance",
          },
        ],
      });
    }
    if (input.outputToolName === "emit_fallback_context_manifest") {
      const payload = JSON.parse(input.user) as {
        readonly originalCandidates: readonly { readonly candidateId: string }[];
        readonly firstPass: readonly {
          readonly groupId: string;
          readonly actualRenderedTokenCount: number;
          readonly decisions: readonly {
            readonly candidateId: string;
            readonly action: "select" | "omit";
            readonly passageIds?: readonly string[];
          }[];
        }[];
      };
      const firstSelections = new Map(
        payload.firstPass.flatMap((group) =>
          group.decisions.map((decision) => [
            decision.candidateId,
            { ...decision, groupId: group.groupId },
          ]),
        ),
      );
      return input.validate({
        decisions: payload.originalCandidates.map((candidate) => {
          const previous = firstSelections.get(candidate.candidateId);
          return previous?.action === "select"
            ? {
                candidateId: candidate.candidateId,
                action: "tighten",
                groupId: previous.groupId,
                reason: "tighten to one previously selected exact passage",
              }
            : {
                candidateId: candidate.candidateId,
                action: "omit",
                reason: "omit non-selected evidence",
              };
        }),
        groups: payload.firstPass.map((group) => ({
          groupId: group.groupId,
          renderedTokenBudget: Math.max(1, group.actualRenderedTokenCount - 1),
        })),
      });
    }
    if (input.outputToolName === "emit_compaction_result") {
      const payload = JSON.parse(input.user) as CompactionStructuredObservation["payload"];
      if (payload.candidates === undefined) return super.structured(input);
      if (payload.priorResult !== undefined) {
        const request =
          input.request ??
          ({
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
          } satisfies LiveProviderRequest);
        this.fallbackGroupObservations.push({
          payload,
          proofs: input.sourceExposureProofs ?? [],
          request,
          validate: input.validate,
        });
      }
      const requestedPassageIds = payload.priorResult === undefined ? ["p3", "p4"] : ["p4"];
      for (const candidate of payload.candidates) {
        if (
          !requestedPassageIds.every((passageId) =>
            candidate.passages.some((passage) => passage.passageId === passageId),
          )
        ) {
          throw new Error(
            `sparse fallback fixture passages: ${candidate.passages
              .map((passage) => passage.passageId)
              .join(",")}`,
          );
        }
      }
      return input.validate({
        decisions: payload.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          action: "select",
          passageIds: requestedPassageIds,
          reason:
            payload.priorResult === undefined
              ? "retain sparse non-prefix exact passages"
              : "tighten to the final exact passage",
        })),
      });
    }
    return super.structured(input);
  }
}

class MultiMemberFallbackAgent extends PriorPassageFallbackAgent {
  readonly initialGroupPayloads: CompactionStructuredObservation["payload"][] = [];

  override async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    if (input.outputToolName === "emit_context_manifest") {
      const inventory = JSON.parse(input.user) as {
        readonly allowance: number;
        readonly mandatoryInputCost: number;
        readonly candidates: readonly {
          readonly candidateId: string;
          readonly kind: string;
          readonly renderedTokenCount: number;
        }[];
      };
      const compacted = inventory.candidates.filter(
        (candidate) => candidate.kind === "document" || candidate.kind === "chat_message",
      );
      if (compacted.length < 2) throw new Error("multi-member fixture lacks two source candidates");
      const compactedIds = new Set(compacted.map((candidate) => candidate.candidateId));
      const keptCost = inventory.candidates
        .filter((candidate) => !compactedIds.has(candidate.candidateId))
        .reduce((total, candidate) => total + candidate.renderedTokenCount, 0);
      const remainingAnswerTokens = inventory.allowance - inventory.mandatoryInputCost - keptCost;
      return input.validate({
        decisions: inventory.candidates.map((candidate) =>
          compactedIds.has(candidate.candidateId)
            ? {
                candidateId: candidate.candidateId,
                action: "compact",
                groupId: "g1",
                reason: "compact both source candidates together",
              }
            : {
                candidateId: candidate.candidateId,
                action: "keep",
                reason: "retain mandatory evidence",
              },
        ),
        groups: [
          {
            groupId: "g1",
            renderedTokenBudget: Math.max(
              1,
              Math.min(
                compacted.reduce((total, candidate) => total + candidate.renderedTokenCount, 0) - 1,
                remainingAnswerTokens,
              ),
            ),
          },
        ],
      });
    }
    if (input.outputToolName === "emit_compaction_result") {
      const payload = JSON.parse(input.user) as CompactionStructuredObservation["payload"];
      if (payload.candidates !== undefined && payload.priorResult === undefined) {
        this.initialGroupPayloads.push(payload);
      }
    }
    return super.structured(input);
  }
}
class DurableRepairAgent extends CanonicalAgentClient {
  private readonly state: {
    providerCalls: number;
    manifestCalls: number;
    groupCalls: number;
  };

  constructor(
    private readonly runId: string,
    private readonly chatId: string,
    private readonly mode: "manifest" | "group" | "post-response-failure" | "transport-failure",
  ) {
    const state = {
      providerCalls: 0,
      manifestCalls: 0,
      groupCalls: 0,
    };
    let postResponseFailurePending = mode === "post-response-failure";
    const persistCompletion = async (
      completion: PiCompletion,
      coordinates: PiBoundaryCoordinates,
    ): Promise<PiCompletion> => {
      await runDb(
        insertAiRunUsage({
          runId,
          taskId: coordinates.taskId,
          loopIteration: coordinates.loopIteration,
          attempt: coordinates.attempt,
          providerRequestIndex: coordinates.providerRequestIndex,
          agentRole: coordinates.agentRole,
          modelId: "glm-5-turbo",
          providerServiceId: "zai_coding_plan_official",
          usage: completion.usage,
        }),
      );
      if (postResponseFailurePending) {
        postResponseFailurePending = false;
        throw new Error("simulated operation/output persistence crash");
      }
      return completion;
    };
    super({
      bindAcceptedProviderProfile: () => undefined,
      complete: async (
        request: LiveProviderRequest,
        _coordinates: PiBoundaryCoordinates,
        onBeforeRequest?: BeforeProviderRequest,
      ) => {
        state.providerCalls += 1;
        const measurement = passedMeasurement(request.model);
        await onBeforeRequest?.(
          request,
          {
            ..._coordinates,
            providerRequestSha256Hex: providerRequestSha256Hex(request),
          },
          measurement,
        );
        if (mode === "transport-failure" && state.providerCalls === 1) {
          throw new Error("simulated pre-response transport failure");
        }
        await runDb(
          insertAiObservation({
            runId: this.runId,
            chatId: this.chatId,
            emittingTask: _coordinates.taskId,
            loopIteration: _coordinates.loopIteration,
            attempt: _coordinates.attempt,
            observationKey: `durable-repair:${_coordinates.taskId}:${_coordinates.attempt}:${_coordinates.providerRequestIndex}`,
            kind: "provider_request_measurement",
            payload: {
              providerRequestIndex: _coordinates.providerRequestIndex,
              agentRole: _coordinates.agentRole,
              requestSha256Hex: providerRequestSha256Hex(request),
              sourceExposureProofSha256Hexes: [],
              sourceExposureProofBindings: [],
              ...measurement,
            },
          }),
        );
        const user = request.messages.find((message) => message.role === "user")?.content;
        const payload = user === undefined ? {} : (JSON.parse(user) as Record<string, unknown>);
        const toolName = request.tools?.[0]?.name;
        if (toolName === "emit_context_manifest") {
          state.manifestCalls += 1;
          const candidates = Array.isArray(payload.candidates)
            ? payload.candidates.filter(
                (candidate): candidate is Record<string, unknown> =>
                  typeof candidate === "object" && candidate !== null,
              )
            : [];
          const eligible = candidates.find(
            (candidate) =>
              (candidate.kind === "document" || candidate.kind === "chat_message") &&
              typeof candidate.candidateId === "string",
          );
          const keptCost = candidates
            .filter((candidate) => candidate.candidateId !== eligible?.candidateId)
            .reduce(
              (total, candidate) =>
                total +
                (typeof candidate.renderedTokenCount === "number"
                  ? candidate.renderedTokenCount
                  : 0),
              0,
            );
          const remainingAnswerTokens =
            Number(payload.allowance ?? 0) - Number(payload.mandatoryInputCost ?? 0) - keptCost;
          if (this.mode === "manifest" && state.manifestCalls % 2 === 1) {
            return persistCompletion(
              providerToolCompletion(
                "emit_context_manifest",
                {
                  decisions: [
                    { candidateId: "invalid-candidate", action: "keep", reason: "invalid" },
                  ],
                  groups: [],
                },
                `manifest-${String(state.manifestCalls)}`,
              ),
              _coordinates,
            );
          }
          return persistCompletion(
            providerToolCompletion(
              "emit_context_manifest",
              {
                decisions: candidates.map((candidate) =>
                  candidate.candidateId === eligible?.candidateId
                    ? {
                        candidateId: candidate.candidateId,
                        action: "compact",
                        groupId: "g1",
                        reason: "select exact evidence passages",
                      }
                    : {
                        candidateId: candidate.candidateId,
                        action: "keep",
                        reason: "retain evidence",
                      },
                ),
                groups:
                  eligible === undefined
                    ? []
                    : [
                        {
                          groupId: "g1",
                          renderedTokenBudget: Math.max(
                            1,
                            Math.min(
                              Number(eligible.renderedTokenCount ?? 2) - 1,
                              remainingAnswerTokens,
                            ),
                          ),
                        },
                      ],
              },
              `manifest-${String(state.manifestCalls)}`,
            ),
            _coordinates,
          );
        }
        if (toolName === "emit_compaction_result") {
          state.groupCalls += 1;
          const candidates = Array.isArray(payload.candidates)
            ? payload.candidates.filter(
                (candidate): candidate is Record<string, unknown> =>
                  typeof candidate === "object" && candidate !== null,
              )
            : [];
          if (this.mode === "group" && state.groupCalls % 2 === 1) {
            return persistCompletion(
              providerToolCompletion(
                "emit_compaction_result",
                {
                  decisions: [
                    {
                      candidateId: "invalid-candidate",
                      action: "omit",
                      reason: "trigger one semantic repair",
                    },
                  ],
                },
                `group-${String(state.groupCalls)}`,
              ),
              _coordinates,
            );
          }
          return persistCompletion(
            providerToolCompletion(
              "emit_compaction_result",
              {
                decisions: candidates.map((candidate) => {
                  const passages = Array.isArray(candidate.passages) ? candidate.passages : [];
                  const passageCandidates = passages.filter(
                    (passage): passage is { readonly passageId: string; readonly text: string } =>
                      typeof passage === "object" &&
                      passage !== null &&
                      typeof passage.passageId === "string" &&
                      typeof passage.text === "string",
                  );
                  const passage = passageCandidates.reduce<
                    { readonly passageId: string; readonly text: string } | undefined
                  >(
                    (smallest, current) =>
                      smallest === undefined ||
                      resolveRegisteredModel(request.model).countTextTokens(current.text) <
                        resolveRegisteredModel(request.model).countTextTokens(smallest.text)
                        ? current
                        : smallest,
                    undefined,
                  );
                  const passageId = passage?.passageId;
                  return {
                    candidateId: candidate.candidateId,
                    action: "select",
                    ...(passageId === undefined ? {} : { passageIds: [passageId] }),
                    reason: "retain one exact passage",
                  };
                }),
              },
              `group-${String(state.groupCalls)}`,
            ),
            _coordinates,
          );
        }
        throw new Error(`unexpected durable repair tool ${String(toolName)}`);
      },
    } as unknown as ExactPiBoundary);
    this.state = state;
  }

  get providerCalls(): number {
    return this.state.providerCalls;
  }

  get manifestCalls(): number {
    return this.state.manifestCalls;
  }

  get groupCalls(): number {
    return this.state.groupCalls;
  }
}

class WebManifestAgent extends IntegrationAgentClient {
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
    super();
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

class MemoryManifestAgent extends IntegrationAgentClient {
  constructor(private readonly entries: readonly MemoryReference[]) {
    super();
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

class EmptyInventoryConversationAgent extends IntegrationAgentClient {
  calls = 0;
  entries: unknown = null;

  constructor() {
    super();
  }

  override async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    if (input.outputToolName === "emit_plan_turn") {
      this.calls += 1;
      this.entries = (JSON.parse(input.user) as { readonly entries: unknown }).entries;
      await invokeStructuredProviderHook(input);
      return input.validate({
        mode: "single",
        question: "What changed in liquidity?",
        relevantTurnIds: [],
      });
    }
    return super.structured(input);
  }
}

class DateBoundaryInputAgent extends IntegrationAgentClient {
  readonly planInputs: string[] = [];
  readonly retrievalInputs: string[] = [];

  override async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    if (input.outputToolName === "emit_internal_query_plan") {
      this.retrievalInputs.push(input.user);
    }
    if (input.outputToolName === "emit_plan_turn") {
      this.planInputs.push(input.user);
      await invokeStructuredProviderHook(input);
      return input.validate({
        mode: "single",
        question: "What changed in liquidity?",
        relevantTurnIds: [],
      });
    }
    return super.structured(input);
  }
}

class PublicRetrievalAgent extends IntegrationAgentClient {
  constructor() {
    super();
  }

  override async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    if (input.outputToolName === "emit_plan_turn") {
      return input.validate({
        mode: "single",
        question: "What changed in the public signal?",
        relevantTurnIds: [],
      });
    }
    if (input.outputToolName === "emit_internal_query_plan") {
      await invokeStructuredProviderHook(input);
      return input.validate({
        action: "search",
        queries: [
          {
            purpose: "retrieve the public signal",
            all: [{ text: "beacon", mode: "term" }],
            anyOf: [],
            not: [],
            filters: { documents: {} },
            order: "relevance",
          },
        ],
      });
    }
    if (input.outputToolName === "emit_internal_query_review") {
      await invokeStructuredProviderHook(input);
      return input.validate({ action: "accept", reason: "sufficient_coverage" });
    }
    return super.structured(input);
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
          where datname = ${databaseName}
            and pid <> pg_backend_pid()
            and usename = current_user
        `;
        yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`).raw;
      }),
      databaseUrlFor("postgres"),
    );
  }, 60_000);

  it("resolves accepted names and durably records the real structured review preview", async () => {
    const fixture = await runDb(
      createFixtureWithCanonicalText("Liquidity evidence for the macro brief."),
    );
    const foreignPublisherCompanyId = crypto.randomUUID();
    const foreignSubscriptionId = crypto.randomUUID();
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into publisher_companies (id, name)
          values (${foreignPublisherCompanyId}, 'Foreign Publisher')
        `;
        yield* sql`
          insert into publisher_subscriptions (id, publisher_company_id, name, created_by_user_id)
          values (${foreignSubscriptionId}, ${foreignPublisherCompanyId}, 'Foreign Source', ${fixture.userId})
        `;
      }),
    );
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      phaseBOperationConfig,
      new ReviewReplacingAgent(),
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into chat_messages (chat_id, author, content, created_at)
          values (${load.chatId}, 'assistant', 'Older liquidity evidence.', now() - interval '1 day')
        `;
      }),
    );
    const accepted = await inTask("single-retrieve-internal", () =>
      operations.resolveAcceptedRetrievalScope(load, ["Macro Source"]),
    );
    const foreign = await inTask("single-retrieve-internal", () =>
      operations.resolveAcceptedRetrievalScope(load, ["Foreign Source"]),
    );
    const unknown = await inTask("single-retrieve-internal", () =>
      operations.resolveAcceptedRetrievalScope(load, ["Unknown Source"]),
    );
    expect(accepted.acceptedSourceIds).toEqual([`publisher:${fixture.subscriptionId}`]);
    expect(foreign.acceptedSourceIds).toEqual([]);
    expect(unknown.acceptedSourceIds).toEqual([]);

    const namedPlan = (sourceName: string) => ({
      action: "search" as const,
      queries: [
        {
          purpose: "retrieve the named macro evidence",
          all: [{ text: "liquidity", mode: "term" as const }],
          anyOf: [],
          not: [],
          filters: { documents: { sourceNames: [sourceName] } },
          order: "relevance" as const,
        },
      ],
    });
    const acceptedNamedResult = await inTask("single-retrieve-internal", () =>
      operations.executeStructuredRetrieval(load, namedPlan("Macro Source")),
    );
    const foreignNamedResult = await inTask("single-retrieve-internal", () =>
      operations.executeStructuredRetrieval(load, namedPlan("Foreign Source")),
    );
    const unknownNamedResult = await inTask("single-retrieve-internal", () =>
      operations.executeStructuredRetrieval(load, namedPlan("Unknown Source")),
    );
    expect(
      acceptedNamedResult.branches.find((branch) => branch.branch === "publisher_documents")?.hits
        .length,
    ).toBeGreaterThan(0);
    const publicShape = (result: typeof foreignNamedResult) => ({
      branches: result.branches.map(
        ({ queryOrdinal, branch, status, reason, cap, truncated, hits }) => ({
          queryOrdinal,
          branch,
          status,
          reason,
          cap,
          truncated,
          hitCount: hits.length,
        }),
      ),
      fused: result.fused.results.map(
        ({ resultId, score, bestRank, date, matchedQueryOrdinals }) => ({
          resultId,
          score,
          bestRank,
          date,
          matchedQueryOrdinals,
        }),
      ),
      review: result.review,
    });
    expect(publicShape(foreignNamedResult)).toEqual(publicShape(unknownNamedResult));

    const reviewed = await inTask("single-retrieve-internal", () =>
      operations.retrieveStructuredInternal(
        load,
        "resolved macro retrieval question",
        "single-retrieve-internal",
        [],
      ),
    );
    expect(reviewed?.previewExposures.length).toBeGreaterThan(0);
    const persistedPreviews = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly providerRequestIndex: number }>`
          select (payload->>'providerRequestIndex')::int as "providerRequestIndex"
          from ai_observations
          where run_id = ${fixture.runId}
            and kind = 'structured_retrieval_review_preview'
          order by "providerRequestIndex"
        `;
      }),
    );
    expect(persistedPreviews.map((row) => row.providerRequestIndex)).toEqual([1]);
    const traces = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly payload: Record<string, unknown> }>`
          select payload
          from ai_observations
          where run_id = ${fixture.runId}
            and kind = 'structured_retrieval_trace'
        `;
      }),
    );
    expect(traces).toHaveLength(1);
    expect(StructuredRetrievalTraceSchema.parse(traces[0]!.payload)).toMatchObject({
      outcome: "accepted",
      initialPlan: { action: "search" },
      review: { action: "accept", reason: "sufficient_coverage" },
      replacementPlan: null,
    });
  }, 120_000);
  it("replaces a structured review without duplicating discovered evidence", async () => {
    const fixture = await runDb(
      createFixtureWithCanonicalText(
        "Liquidity conditions improved while inflation expectations remained anchored.",
      ),
    );
    const agent = new StructuredReplacementAgent();
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      phaseBOperationConfig,
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const result = await inTask("structured-replacement-retrieve", () =>
      operations.retrieveStructuredInternal(
        load,
        "What changed in liquidity expectations?",
        "structured-replacement-retrieve",
        [],
      ),
    );
    expect(agent.reviewCalls).toBe(1);
    expect(result?.queryPlan).toMatchObject({
      action: "search",
      queries: [{ all: [{ text: "expectations", mode: "term" }] }],
    });
    expect(result?.fused.results).toHaveLength(1);
    const identities = result?.previewExposures.map((exposure) =>
      JSON.stringify(exposure.identity),
    );
    expect(identities ?? []).toHaveLength(1);
    const traces = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly payload: Record<string, unknown> }>`
          select payload
          from ai_observations
          where run_id = ${fixture.runId}
            and kind = 'structured_retrieval_trace'
        `;
      }),
    );
    expect(traces).toHaveLength(1);
    expect(StructuredRetrievalTraceSchema.parse(traces[0]!.payload)).toMatchObject({
      outcome: "replaced",
      initialPlan: { action: "search" },
      review: { action: "replace" },
      replacementPlan: {
        action: "search",
        queries: [{ all: [{ text: "expectations", mode: "term" }] }],
      },
    });
  });
  it("records exact no-evidence and skip retrieval traces", async () => {
    const cases = [
      {
        suffix: "trace-no-evidence",
        taskId: "trace-no-evidence-retrieve",
        agent: new StructuredNoEvidenceAgent(),
        expected: {
          outcome: "no_evidence",
          initialPlan: { action: "search" },
          review: { action: "no_evidence", reason: "no_supporting_evidence" },
          replacementPlan: null,
        },
      },
      {
        suffix: "trace-skip",
        taskId: "trace-skip-retrieve",
        agent: new StructuredSkipAgent(),
        expected: {
          outcome: "skipped",
          initialPlan: { action: "skip" },
          review: null,
          replacementPlan: null,
        },
      },
    ] as const;
    for (const testCase of cases) {
      const fixture = await runDb(createFixtureWithCanonicalText(testCase.suffix));
      const operations = new CanonicalWorkflowOperations(
        databaseUrlFor(databaseName),
        phaseBOperationConfig,
        testCase.agent,
      );
      const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
      await inTask(testCase.taskId, () =>
        operations.retrieveStructuredInternal(load, "trace terminal outcome", testCase.taskId, []),
      );
      const traces = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{ readonly payload: Record<string, unknown> }>`
            select payload
            from ai_observations
            where run_id = ${fixture.runId}
              and kind = 'structured_retrieval_trace'
          `;
        }),
      );
      expect(traces).toHaveLength(1);
      expect(StructuredRetrievalTraceSchema.parse(traces[0]!.payload)).toMatchObject(
        testCase.expected,
      );
    }
  }, 120_000);

  it("recovers malformed structured plan and review outputs on task retry", async () => {
    const fixture = await runDb(createFixture);
    const agent = new StructuredMalformedRecoveryAgent();
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      phaseBOperationConfig,
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const retrieve = (taskId: string) =>
      inTask(taskId, () =>
        operations.retrieveStructuredInternal(load, "What changed in liquidity?", taskId, []),
      );
    await expect(retrieve("malformed-plan-retry")).rejects.toThrow();
    const planRecovered = await retrieve("malformed-plan-retry");
    expect(planRecovered?.previewExposures.length).toBeGreaterThan(0);
    await expect(retrieve("malformed-review-retry")).rejects.toThrow();
    const reviewRecovered = await retrieve("malformed-review-retry");
    expect(reviewRecovered?.previewExposures.length).toBeGreaterThan(0);
    expect(agent.planCalls).toBe(4);
    expect(agent.reviewCalls).toBe(3);
  });

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
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
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
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
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
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
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
        beforeBoundary.retrieveStructuredInternal(
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
        afterBoundary.retrieveStructuredInternal(
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
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
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
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await expect(
      inTask("publisher-repeated-preview", () =>
        operations.retrieveStructuredInternal(
          load,
          "What changed in liquidity?",
          "publisher-repeated-preview",
          [],
        ),
      ),
    ).resolves.toMatchObject({
      previewExposures: expect.arrayContaining([
        expect.objectContaining({
          identity: expect.objectContaining({ documentId: fixture.documentId }),
          snapshotId: fixture.snapshotId,
        }),
      ]),
    });

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
    const _secondStart = canonicalText.lastIndexOf("Liquidity");
    expect(firstStart).toBe(3);
    expect(persisted).toHaveLength(1);
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          snapshotId: fixture.snapshotId,
          contentHash: fixture.contentHash,
          sourceId: `publisher:${fixture.subscriptionId}`,
          documentId: fixture.documentId,
          publisherExtractionId: fixture.extractionId,
        }),
      ]),
    );
  }, 120_000);

  it("binds repeated public preview fragments without a publisher extraction", async () => {
    const canonicalText =
      "Beacon conditions improved. " +
      "filler ".repeat(40) +
      "Beacon expectations remained anchored.";
    const fixture = await runDb(createPublicPreviewFixture(canonicalText));
    const agent = new PublicRetrievalAgent();
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
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await expect(
      inTask("public-repeated-preview", () =>
        operations.retrieveStructuredInternal(
          load,
          "What changed in the public signal?",
          "public-repeated-preview",
          [],
        ),
      ),
    ).resolves.toMatchObject({
      previewExposures: expect.arrayContaining([
        expect.objectContaining({
          identity: expect.objectContaining({ documentId: fixture.publicDocumentId }),
          snapshotId: expect.any(String),
        }),
      ]),
    });

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
    const _firstStart = canonicalText.indexOf("Beacon");
    const _secondStart = canonicalText.lastIndexOf("Beacon");
    expect(persisted).toHaveLength(1);
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contentHash: fixture.publicContentHash,
          sourceId: `public:${fixture.publicSourceId}`,
          documentId: fixture.publicDocumentId,
          publisherExtractionId: null,
        }),
      ]),
    );
  }, 120_000);

  it("rejects malformed resumed source identities at retrieval and freeze integrity boundaries", async () => {
    const fixture = await runDb(createFixture);
    const agent = new PublisherRetrievalAgent();
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
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));

    const sourceFor = (sourceId: string): FinalSourceRecord => ({
      sourceKey: "k_cn_AAAAAAAAAAAAAAAAAAAAAA_1",
      locator: {
        kind: "document",
        sourceId: sourceId as `publisher:${string}`,
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
    const malformedSourceIds = [
      `publisherx:${fixture.subscriptionId}`,
      `publisher:${fixture.subscriptionId}:extra`,
    ];
    for (const [index, sourceId] of malformedSourceIds.entries()) {
      const source = sourceFor(sourceId);
      const context: ContextState = {
        status: "ready",
        question: "What changed in liquidity?",
        candidates: [],
        sourceMap: [source],
        ledgerCandidates: [],
        ledgerSourceMap: [source],
        candidateLedger: { candidates: [] },
        selectedConversation: [],
        consumers: [],
        gaps: [],
        compactionFeedback: [],
        request: {
          requestClass: "main",
          model: "glm-5-turbo",
          messages: [{ role: "user", content: "answer" }],
          requestedOutputTokens: 512,
          reasoning: "medium",
        },
        inputTokens: 1,
        usableInputTokens: 100_000,
        compactionRan: false,
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
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
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
    const references = await inTask("single-retrieve-internal", () =>
      operations.retrieveStructuredInternal(
        load,
        "What changed in liquidity?",
        "single-retrieve-internal",
        [],
      ),
    );
    expect(references).toMatchObject({
      previewExposures: expect.arrayContaining([
        expect.objectContaining({
          identity: expect.objectContaining({ documentId: fixture.documentId }),
          snapshotId: fixture.snapshotId,
        }),
      ]),
    });
    const context = await assembleAndMeasureContext(
      operations,
      load,
      "What changed in liquidity?",
      {
        structuredInternal: references,
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
      sourceName: "Macro Source",
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
    expect(exposures[0]?.count).toBeGreaterThanOrEqual(1);

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
    await expect(
      inTask("later-restricted-retrieve", () =>
        operations.retrieveStructuredInternal(
          laterLoad,
          "What changed after access was removed?",
          "later-restricted-retrieve",
          [],
        ),
      ),
    ).resolves.toMatchObject({ previewExposures: expect.any(Array) });
  }, 120_000);

  it("keeps the publisher current pointer immutable between searches", async () => {
    const fixture = await runDb(createFixture);
    const agent = new PublisherRetrievalAgent();
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
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
      aiMemoryToolResultMaxItems: 20,
      webResearchProvider: "",
    };
    const operations = new CanonicalWorkflowOperations(databaseUrlFor(databaseName), config, agent);
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await expect(
      inTask("pointer-stable-retrieve", () =>
        operations.retrieveStructuredInternal(
          load,
          "What changed in liquidity?",
          "pointer-stable-retrieve",
          [],
        ),
      ),
    ).resolves.toMatchObject({
      previewExposures: expect.arrayContaining([
        expect.objectContaining({
          identity: expect.objectContaining({ documentId: fixture.documentId }),
        }),
      ]),
    });
  }, 120_000);

  it("stops frozen-context and finalization access as soon as a company enters recovery deletion", async () => {
    const fixture = await runDb(createFixture);
    const agent = new PublisherRetrievalAgent();
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
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const references = await inTask("single-retrieve-internal", () =>
      operations.retrieveStructuredInternal(
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
        structuredInternal: references,
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
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
      aiMemoryToolResultMaxItems: 20,
      webResearchProvider: "" as const,
    };
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      config,
      new IntegrationAgentClient(),
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const retrieved = await inTask("single-retrieve-internal", () =>
      operations.retrieveStructuredInternal(
        load,
        "find the older needle",
        "single-retrieve-internal",
        [],
      ),
    );
    expect(retrieved?.previewExposures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: expect.objectContaining({
            kind: "chat_message",
            messageId: seeded.retainedId,
          }),
        }),
      ]),
    );
    const absent = await inTask("single-retrieve-internal-absent", () =>
      operations.retrieveStructuredInternal(
        load,
        "find an absent older message",
        "single-retrieve-internal-absent",
        [],
      ),
    );
    expect(absent?.previewExposures).toEqual([]);
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
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
      aiMemoryToolResultMaxItems: 20,
      webResearchProvider: "",
    };
    const agent = new IntegrationAgentClient();
    const operations = new CanonicalWorkflowOperations(databaseUrlFor(databaseName), config, agent);
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const retrieved = await inTask("named-source-retrieve", () =>
      operations.retrieveStructuredInternal(
        load,
        "find liquidity in the named source",
        "named-source-retrieve",
        [],
      ),
    );
    expect(retrieved?.previewExposures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: expect.objectContaining({ kind: "publisher_document" }),
        }),
      ]),
    );
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
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      phaseBOperationConfig,
      new IntegrationAgentClient(),
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const retrieved = await inTask("retrieve-malformed-inspection", () =>
      operations.retrieveStructuredInternal(
        load,
        "recover firstsubject message evidence",
        "retrieve-malformed-inspection",
        [],
      ),
    );
    expect(retrieved?.previewExposures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: expect.objectContaining({ kind: "chat_message", messageId }),
        }),
      ]),
    );
  });

  it("keeps an incomplete second search available until exact cursor completion", async () => {
    const fixture = await runDb(createFixture);
    const _messageId = await runDb(
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
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      phaseBOperationConfig,
      new IntegrationAgentClient(),
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const retrieved = await inTask("retrieve-second-search-cursor", () =>
      operations.retrieveStructuredInternal(
        load,
        "compare cursorpage message",
        "retrieve-second-search-cursor",
        [],
      ),
    );
    expect(retrieved?.previewExposures.length).toBeGreaterThan(0);
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
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      new PublisherRetrievalAgent(),
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const topicOneStructured = await inTask("topic-t1-retrieve-internal", () =>
      operations.retrieveStructuredInternal(
        load,
        "What changed in liquidity?",
        "topic-t1-retrieve-internal",
        [],
      ),
    );
    const topicTwoStructured = await inTask("topic-t2-retrieve-internal", () =>
      operations.retrieveStructuredInternal(
        load,
        "What remained anchored?",
        "topic-t2-retrieve-internal",
        [],
      ),
    );
    const reference = (charStart: number, charEnd: number, purpose: string) => ({
      kind: "document" as const,
      documentId: fixture.documentId,
      snapshotId: fixture.snapshotId,
      publisherExtractionId: fixture.extractionId,
      source: {
        kind: "publisher" as const,
        sourceId: `publisher:${fixture.subscriptionId}`,
        issueId: fixture.issueId,
        documentId: fixture.documentId,
      },
      ranges: [{ charStart, charEnd }],
      purpose,
    });
    const topicOneSelectors = {
      structuredInternal: topicOneStructured,
      memories: [],
      memorySelection: "enabled",
      web: [],
      webSelection: "enabled",
    } satisfies SelectorBundle;
    const topicTwoSelectors = {
      structuredInternal: topicTwoStructured,
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
          structuredInternal: null,
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
          ranges: [{ charStart: 0, charEnd: 77 }],
        }),
        uses: [
          expect.objectContaining({
            consumerTaskId: "topic-t1-answer",
            topicId: "t1",
            ranges: [{ charStart: 0, charEnd: 77 }],
          }),
          expect.objectContaining({
            consumerTaskId: "topic-t2-answer",
            topicId: "t2",
            ranges: [{ charStart: 0, charEnd: 77 }],
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
              compactionRan: false,
              compactionFeedback: [],
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
              sourceKeys: sourceMap.map((source) => source.sourceKey),
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
              sourceKeys: sourceMap.map((source) => source.sourceKey),
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
          ranges: [{ charStart: 0, charEnd: 77 }],
        },
      ],
      uses: [
        {
          consumerTaskId: "topic-t1-answer",
          topicId: "t1",
          ranges: [{ charStart: 0, charEnd: 77 }],
        },
        {
          consumerTaskId: "topic-t2-answer",
          topicId: "t2",
          ranges: [{ charStart: 0, charEnd: 77 }],
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
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
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
        structuredInternal: null,
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
        candidateId:
          candidate.kind === "memory" ? memoryEvidenceIdentity(candidate.memoryId) : candidate.id,
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
        yield* sql`
          insert into ai_observations (
            run_id, chat_id, emitting_task, loop_iteration, attempt,
            observation_key, kind, payload
          )
          select ${fixture.runId}, chat_id, 'single-retrieve-internal', 0, 0,
                 'single-retrieve-internal:0:0:structured_retrieval_trace:result',
                 'structured_retrieval_trace',
                 ${sql.json({
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
                 })}
          from ai_runs where id = ${fixture.runId}
        `;
        yield* sql`
          insert into ai_observations (
            run_id, chat_id, emitting_task, loop_iteration, attempt,
            observation_key, kind, payload
          )
          select ${fixture.runId}, chat_id, 'single-retrieve-internal', 0, 0,
                 'single-retrieve-internal:0:0:structured_retrieval_review_preview:initial',
                 'structured_retrieval_review_preview',
                 ${sql.json({
                   taskId: "single-retrieve-internal",
                   loopIteration: 0,
                   attempt: 0,
                   providerRequestIndex: 1,
                   agentRole: "internal_retrieval",
                   slot: "initial",
                   providerInputSha256Hex: "c".repeat(64),
                   results: [],
                   coverage: [
                     {
                       queryOrdinal: 1,
                       branch: "public_documents",
                       status: "applicable",
                       hitCount: 0,
                       truncated: false,
                       cap: 25,
                     },
                     {
                       queryOrdinal: 1,
                       branch: "publisher_documents",
                       status: "applicable",
                       hitCount: 0,
                       truncated: false,
                       cap: 25,
                     },
                     {
                       queryOrdinal: 1,
                       branch: "chat_messages",
                       status: "not_applicable",
                       reason: "scope_documents",
                       hitCount: 0,
                       truncated: false,
                       cap: 25,
                     },
                   ],
                   truncation: { branch: false, candidates: false, hydration: false },
                   records: [],
                 })}
          from ai_runs where id = ${fixture.runId}
        `;
      }),
    );
    for (const taskId of ["single-retrieve-internal", "single-select-memories"]) {
      await runDb(seedTaskMeasurement(fixture, taskId));
    }
    await runDb(seedTaskMeasurement(fixture, "single-retrieve-internal", 1));
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
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
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
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
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
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
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
          aiWebMaxSearches: 2,
          aiWebMaxFetches: 2,
          aiWebMaxDomainFilters: 8,
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
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
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
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
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
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
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
      structuredInternal: null,
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
  it("rejects a frozen-scope mutation before dispatch or proof persistence", async () => {
    const fixture = await runDb(createFixture);
    const config = {
      ...phaseBOperationConfig,
      aiMainInputMaxTokens: 100_000,
      aiMainOutputMaxTokens: 4096,
    };
    const retrievalOperations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      config,
      new PublisherRetrievalAgent(),
    );
    const load = await inTask("load-turn", () => retrievalOperations.loadTurn(fixture.runId));
    const references = await inTask("single-retrieve-internal", () =>
      retrievalOperations.retrieveStructuredInternal(
        load,
        "What changed in liquidity?",
        "single-retrieve-internal",
        [],
      ),
    );
    const context = await assembleAndMeasureContext(
      retrievalOperations,
      load,
      "What changed in liquidity?",
      {
        structuredInternal: references,
        memories: [],
        memorySelection: "enabled",
        web: [],
        webSelection: "enabled",
      },
      "single-answer",
    );
    const frozen = await inTask("single-context-select", () =>
      retrievalOperations.freezeContext(load, context),
    );
    expect(frozen.status).toBe("ready");

    let beforeRequestCalls = 0;
    let providerTransportCalls = 0;
    const agent = new CanonicalAgentClient(testProviderBoundary());
    agent.stream = async (
      request: LiveProviderRequest,
      coordinates: PiBoundaryCoordinates,
      _onDelta: (delta: string, index: number) => Promise<void> | void,
      onBeforeRequest?: BeforeProviderRequest,
    ) => {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
              update client_companies
              set recovery_deleted_at = now(), purge_after = now() + interval '180 days'
              where id = ${fixture.companyId}
            `;
        }),
      );
      beforeRequestCalls += 1;
      await onBeforeRequest?.(
        request,
        {
          ...coordinates,
          providerRequestSha256Hex: providerRequestSha256Hex(request),
        },
        passedMeasurement(request.model),
      );
      providerTransportCalls += 1;
      return {
        text: "provider must not run",
        toolCalls: [],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedTokens: 0,
          reasoningTokens: 0,
          totalTokens: 2,
          stopReason: "stop",
        },
        stopReason: "stop",
      };
    };
    const operations = new CanonicalWorkflowOperations(databaseUrlFor(databaseName), config, agent);
    const before = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{
          readonly sourceExposures: number;
          readonly observations: number;
          readonly usage: number;
        }>`
          select
            (select count(*)::int from ai_source_exposures
             where run_id = ${fixture.runId} and task_id = 'single-answer') as "sourceExposures",
            (select count(*)::int from ai_observations
             where run_id = ${fixture.runId} and emitting_task = 'single-answer') as observations,
            (select count(*)::int from ai_run_usage
             where run_id = ${fixture.runId} and task_id = 'single-answer') as usage
        `;
        return rows[0];
      }),
    );
    await expect(
      inTask("single-answer", () => operations.answerDirect(load, frozen, "single-answer")),
    ).rejects.toMatchObject({ code: "context_assembly_failed" });
    expect(beforeRequestCalls).toBe(1);
    expect(providerTransportCalls).toBe(0);
    const after = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{
          readonly sourceExposures: number;
          readonly observations: number;
          readonly usage: number;
        }>`
          select
            (select count(*)::int from ai_source_exposures
             where run_id = ${fixture.runId} and task_id = 'single-answer') as "sourceExposures",
            (select count(*)::int from ai_observations
             where run_id = ${fixture.runId} and emitting_task = 'single-answer') as observations,
            (select count(*)::int from ai_run_usage
             where run_id = ${fixture.runId} and task_id = 'single-answer') as usage
        `;
        return rows[0];
      }),
    );
    expect(after).toEqual(before);
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
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
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
  }, 120_000);

  it("requires and binds a narrower immutable publisher range after an oversized inspection", async () => {
    const canonicalText = "Liquidity evidence remains verbatim and immutable. ".repeat(8_000);
    const fixture = await runDb(createFixtureWithCanonicalText(canonicalText));
    const agent = new PublisherRetrievalAgent();
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
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const references = await inTask("oversized-range-retrieve", () =>
      operations.retrieveStructuredInternal(
        load,
        "What changed in liquidity?",
        "oversized-range-retrieve",
        [],
      ),
    );
    const expectedPreview = references?.previewExposures[0];
    expect(references).toMatchObject({
      previewExposures: expect.arrayContaining([
        expect.objectContaining({
          identity: expect.objectContaining({ documentId: fixture.documentId }),
          snapshotId: fixture.snapshotId,
        }),
      ]),
    });
    if (expectedPreview === undefined || expectedPreview.identity.kind === "chat_message") {
      throw new Error("structured retrieval did not return a document preview");
    }
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
            and exposure_stage = 'internal_search_preview'
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
        ranges: expectedPreview.previewRanges,
      },
    ]);
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
    expect(persistedRanges).toEqual(expectedPreview.previewRanges);
    expect(persisted.manifests).toEqual([
      {
        references: [
          expect.objectContaining({
            kind: "document",
            documentId: fixture.documentId,
            snapshotId: fixture.snapshotId,
          }),
        ],
      },
    ]);
  }, 120_000);

  it("takes the fit-first path without a manifest, group, or measure compactor call", async () => {
    const agent = new PhaseDCompactionAgent();
    const fixture = await runDb(createFixture);
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      phaseBOperationConfig,
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const context = await assembleAndMeasureContext(
      operations,
      load,
      "What changed in liquidity?",
      {
        structuredInternal: null,
        memories: [],
        memorySelection: "enabled",
        web: [],
        webSelection: "enabled",
      },
      "single-answer",
    );
    expect(context.status).toBe("ready");
    expect(agent.manifestCalls).toBe(0);
    expect(agent.groupCalls).toBe(0);
    expect(agent.fallbackCalls).toBe(0);
  }, 120_000);

  it("validates one complete initial manifest before starting any group", async () => {
    const agent = new PhaseDCompactionAgent();
    const { operations, load, initial } = await prepareOversizedCompaction(agent);
    expect(initial.status).toBe("needs_compaction");
    const manifest = await inTask("single-compact-plan", () =>
      operations.initialCompactionManifest(load, initial, "single-compact-plan"),
    );
    expect(agent.manifestCalls).toBe(1);
    expect(manifest.decisions).toHaveLength(initial.candidateLedger.candidates.length);
    expect(new Set(manifest.decisions.map((decision) => decision.candidateId)).size).toBe(
      manifest.decisions.length,
    );
  }, 120_000);

  it("collects validated group envelopes in ledger order and measures the final answer request once", async () => {
    const agent = new PhaseDCompactionAgent();
    const { operations, load, initial } = await prepareOversizedCompaction(agent);
    const manifest = await inTask("single-compact-plan", () =>
      operations.initialCompactionManifest(load, initial, "single-compact-plan"),
    );
    const groups = await operations.createCompactionGroups(
      load,
      initial,
      manifest,
      "single-compact-plan",
    );
    const envelopes = await Promise.all(
      groups.map((group, index) =>
        inTask(`single-compact-g${String(index + 1).padStart(3, "0")}`, () =>
          operations.compactContextGroup(
            load,
            initial,
            group,
            `single-compact-g${String(index + 1).padStart(3, "0")}`,
          ),
        ),
      ),
    );
    const pass = await operations.collectCompaction(
      load,
      initial,
      manifest,
      groups,
      envelopes,
      "single-compact-collect",
    );
    expect(pass).not.toHaveProperty("measurement");
    expect(pass.selections.map((selection) => selection.candidateId)).toEqual(
      [...initial.candidateLedger.candidates]
        .filter((candidate) =>
          pass.selections.some((selection) => selection.candidateId === candidate.candidateId),
        )
        .map((candidate) => candidate.candidateId),
    );
    const measured = await inTask("single-compact-measure", () =>
      operations.measureCompaction(load, initial, pass, "single-compact-measure"),
    );
    expect(measured.status).toBe("ready");
    expect(measured.compactionRan).toBe(true);
  }, 120_000);

  it("uses exactly one structured repair for an invalid group result", async () => {
    const agent = new PhaseDCompactionAgent("repair");
    const { operations, load, initial } = await prepareOversizedCompaction(agent);
    const manifest = await inTask("single-compact-plan", () =>
      operations.initialCompactionManifest(load, initial, "single-compact-plan"),
    );
    const groups = await operations.createCompactionGroups(
      load,
      initial,
      manifest,
      "single-compact-plan",
    );
    const envelopes = await Promise.all(
      groups.map((group, index) =>
        inTask(`single-compact-g${String(index + 1).padStart(3, "0")}`, () =>
          operations.compactContextGroup(
            load,
            initial,
            group,
            `single-compact-g${String(index + 1).padStart(3, "0")}`,
          ),
        ),
      ),
    );
    const pass = await operations.collectCompaction(
      load,
      initial,
      manifest,
      groups,
      envelopes,
      "single-compact-collect",
    );
    expect(pass.repairUsed).toBe(true);
    expect(agent.groupCalls).toBe(2);
  }, 120_000);

  describe("durable semantic repair re-entry", () => {
    it("does not grant a second schema repair after task re-entry", async () => {
      const prepared = await prepareOversizedCompaction(new PhaseDCompactionAgent());
      const agent = new DurableRepairAgent(prepared.load.aiRunId, prepared.load.chatId, "manifest");
      const operations = new CanonicalWorkflowOperations(
        databaseUrlFor(databaseName),
        {
          ...phaseBOperationConfig,
          aiMainInputMaxTokens: 780,
          aiMainOutputMaxTokens: 128,
        },
        agent,
      );
      const taskId = "durable-schema-repair";
      await inTask(taskId, () =>
        operations.initialCompactionManifest(prepared.load, prepared.initial, taskId),
      );
      await expect(
        inTask(
          taskId,
          () => operations.initialCompactionManifest(prepared.load, prepared.initial, taskId),
          { attempt: 2 },
        ),
      ).rejects.toThrow();
      expect(agent.providerCalls).toBe(2);
      const rows = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{ readonly count: number }>`
            select count(*)::int as count
            from ai_observations
            where run_id = ${prepared.load.aiRunId}
              and emitting_task = ${taskId}
              and kind = 'provider_request_measurement'
          `;
        }),
      );
      expect(rows[0]?.count).toBe(2);
      const usageRows = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{ readonly count: number }>`
            select count(*)::int as count
            from ai_run_usage
            where run_id = ${prepared.load.aiRunId}
              and task_id = ${taskId}
          `;
        }),
      );
      expect(usageRows[0]?.count).toBe(2);
      const exposures = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{
            readonly documentCount: number;
            readonly reconstructedCount: number;
          }>`
            select count(*)::int as "documentCount",
                   count(document_ranges)::int as "reconstructedCount"
            from ai_source_exposures
            where run_id = ${prepared.load.aiRunId}
              and task_id = ${taskId}
              and exposure_stage = 'context_compaction_input'
              and source_kind = 'document'
          `;
        }),
      );
      expect(exposures[0]?.documentCount).toBeGreaterThan(0);
      expect(exposures[0]?.reconstructedCount).toBe(exposures[0]?.documentCount);
    }, 120_000);

    it("does not dispatch again after a response survives an output persistence crash", async () => {
      const prepared = await prepareOversizedCompaction(new PhaseDCompactionAgent());
      const agent = new DurableRepairAgent(
        prepared.load.aiRunId,
        prepared.load.chatId,
        "post-response-failure",
      );
      const operations = new CanonicalWorkflowOperations(
        databaseUrlFor(databaseName),
        {
          ...phaseBOperationConfig,
          aiMainInputMaxTokens: 780,
          aiMainOutputMaxTokens: 128,
        },
        agent,
      );
      const taskId = "durable-post-response-crash";
      await expect(
        inTask(taskId, () =>
          operations.initialCompactionManifest(prepared.load, prepared.initial, taskId),
        ),
      ).rejects.toMatchObject({ code: "context_compaction_failed" });
      await expect(
        inTask(
          taskId,
          () => operations.initialCompactionManifest(prepared.load, prepared.initial, taskId),
          { attempt: 2 },
        ),
      ).rejects.toMatchObject({ code: "workflow_resume_incompatible" });
      expect(agent.providerCalls).toBe(1);
      const usageRows = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{ readonly count: number }>`
            select count(*)::int as count
            from ai_run_usage
            where run_id = ${prepared.load.aiRunId}
              and task_id = ${taskId}
          `;
        }),
      );
      expect(usageRows[0]?.count).toBe(1);
    }, 120_000);

    it("allows one retry after a pre-response transport failure", async () => {
      const prepared = await prepareOversizedCompaction(new PhaseDCompactionAgent());
      const agent = new DurableRepairAgent(
        prepared.load.aiRunId,
        prepared.load.chatId,
        "transport-failure",
      );
      const operations = new CanonicalWorkflowOperations(
        databaseUrlFor(databaseName),
        {
          ...phaseBOperationConfig,
          aiMainInputMaxTokens: 780,
          aiMainOutputMaxTokens: 128,
        },
        agent,
      );
      const taskId = "durable-transport-failure";
      await expect(
        inTask(taskId, () =>
          operations.initialCompactionManifest(prepared.load, prepared.initial, taskId),
        ),
      ).rejects.toMatchObject({ code: "context_compaction_failed" });
      await expect(
        inTask(
          taskId,
          () => operations.initialCompactionManifest(prepared.load, prepared.initial, taskId),
          { attempt: 2 },
        ),
      ).resolves.toBeDefined();
      expect(agent.providerCalls).toBe(2);
      const usageRows = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{ readonly count: number }>`
            select count(*)::int as count
            from ai_run_usage
            where run_id = ${prepared.load.aiRunId}
              and task_id = ${taskId}
          `;
        }),
      );
      expect(usageRows[0]?.count).toBe(1);
    }, 120_000);

    it("does not grant a second group repair after task re-entry", async () => {
      const prepared = await prepareOversizedCompaction(new PhaseDCompactionAgent());
      const agent = new DurableRepairAgent(prepared.load.aiRunId, prepared.load.chatId, "group");
      const operations = new CanonicalWorkflowOperations(
        databaseUrlFor(databaseName),
        {
          ...phaseBOperationConfig,
          aiMainInputMaxTokens: 780,
          aiMainOutputMaxTokens: 128,
        },
        agent,
      );
      const planTaskId = "durable-group-plan";
      const manifest = await inTask(planTaskId, () =>
        operations.initialCompactionManifest(prepared.load, prepared.initial, planTaskId),
      );
      const groups = await operations.createCompactionGroups(
        prepared.load,
        prepared.initial,
        manifest,
        planTaskId,
      );
      const group = groups.find((candidate) => candidate.mode === "normal");
      if (group === undefined) throw new Error("durable repair fixture lacks a normal group");
      const taskId = "durable-group-repair";
      await inTask(taskId, () =>
        operations.compactContextGroup(prepared.load, prepared.initial, group, taskId),
      );
      await expect(
        inTask(
          taskId,
          () => operations.compactContextGroup(prepared.load, prepared.initial, group, taskId),
          { attempt: 2 },
        ),
      ).rejects.toThrow();
      expect(agent.providerCalls).toBe(3);
      const rows = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{ readonly count: number }>`
            select count(*)::int as count
            from ai_observations
            where run_id = ${prepared.load.aiRunId}
              and emitting_task = ${taskId}
              and kind = 'provider_request_measurement'
          `;
        }),
      );
      expect(rows[0]?.count).toBe(2);
      const usageRows = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{ readonly taskId: string; readonly count: number }>`
            select task_id as "taskId", count(*)::int as count
            from ai_run_usage
            where run_id = ${prepared.load.aiRunId}
              and task_id in (${planTaskId}, ${taskId})
            group by task_id
          `;
        }),
      );
      expect(usageRows).toEqual(
        expect.arrayContaining([
          { taskId: planTaskId, count: 1 },
          { taskId, count: 2 },
        ]),
      );
      const exposures = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{
            readonly documentCount: number;
            readonly reconstructedCount: number;
          }>`
            select count(*)::int as "documentCount",
                   count(document_ranges)::int as "reconstructedCount"
            from ai_source_exposures
            where run_id = ${prepared.load.aiRunId}
              and task_id = ${taskId}
              and exposure_stage = 'context_compaction_input'
              and source_kind = 'document'
          `;
        }),
      );
      expect(exposures[0]?.documentCount).toBeGreaterThan(0);
      expect(exposures[0]?.reconstructedCount).toBe(exposures[0]?.documentCount);
    }, 120_000);
  });
  it("keeps oversized source-tool requests scoped to the accepted candidate", async () => {
    const agent = new PhaseDCompactionAgent();
    // This fast allowance fits the manifest planner but leaves the group request oversized,
    // which is the code-owned condition for the single-candidate source-tool lane.
    const { operations, load, initial } = await prepareOversizedCompaction(agent, 1_350);
    const manifest = await inTask("single-compact-plan", () =>
      operations.initialCompactionManifest(load, initial, "single-compact-plan"),
    );
    const groups = await operations.createCompactionGroups(
      load,
      initial,
      manifest,
      "single-compact-plan",
    );
    expect(groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mode: "source_tool", candidateIds: [expect.any(String)] }),
      ]),
    );
    const result = await inTask("single-compact-g001", () =>
      operations.compactContextGroup(load, initial, groups[0]!, "single-compact-g001"),
    );

    expect(result.result.decisions[0]).toMatchObject({
      action: "select",
      passageIds: [expect.stringMatching(/^p[1-9]/u)],
    });
  }, 120_000);
  it("preserves sparse non-prefix prior passage identities through fallback", async () => {
    const agent = new PriorPassageFallbackAgent();
    const { operations, load, initial } = await prepareOversizedCompaction(
      agent,
      1_000_000,
      `Long evidence chat passage. ${"evidence remains immutable. ".repeat(2_000)}`,
    );
    const manifest = await inTask("prior-identity-compact-plan", () =>
      operations.initialCompactionManifest(load, initial, "prior-identity-compact-plan"),
    );
    const groups = await operations.createCompactionGroups(
      load,
      initial,
      manifest,
      "prior-identity-compact-plan",
    );
    const envelopes = await Promise.all(
      groups.map((group, index) =>
        inTask(`prior-identity-compact-g${String(index + 1).padStart(3, "0")}`, () =>
          operations.compactContextGroup(
            load,
            initial,
            group,
            `prior-identity-compact-g${String(index + 1).padStart(3, "0")}`,
          ),
        ),
      ),
    );
    const firstPass = await operations.collectCompaction(
      load,
      initial,
      manifest,
      groups,
      envelopes,
      "prior-identity-compact-collect",
    );
    const firstSelection = firstPass.envelopes[0]?.result.decisions[0];
    expect(firstSelection).toMatchObject({
      action: "select",
      passageIds: ["p3", "p4"],
    });
    const firstMeasured = await inTask("prior-identity-compact-measure", () =>
      operations.measureCompaction(load, initial, firstPass, "prior-identity-compact-measure"),
    );
    const fallbackManifest = await inTask("prior-identity-fallback-plan", () =>
      operations.fallbackCompactionManifest(
        load,
        initial,
        manifest,
        firstPass,
        {
          fits: false,
          inputTokens: firstMeasured.usableInputTokens + 1,
          usableInputTokens: firstMeasured.usableInputTokens,
          overByTokens: 1,
        },
        "prior-identity-fallback-plan",
      ),
    );
    const fallbackGroups = await operations.createFallbackCompactionGroups(
      load,
      initial,
      manifest,
      firstPass,
      fallbackManifest,
      "prior-identity-fallback-plan",
    );
    const fallbackGroup = fallbackGroups[0];
    const priorEnvelope = firstPass.envelopes.find(
      (envelope) => envelope.groupId === fallbackGroup?.groupId,
    );
    if (fallbackGroup === undefined || priorEnvelope === undefined) {
      throw new Error("fallback identity fixture lacks its prior group");
    }
    const fallbackEnvelope = await inTask("prior-identity-fallback-g001", () =>
      operations.compactContextGroup(
        load,
        initial,
        fallbackGroup,
        "prior-identity-fallback-g001",
        "fallback",
        priorEnvelope,
      ),
    );
    expect(fallbackEnvelope.result.decisions[0]).toMatchObject({
      action: "select",
      passageIds: ["p4"],
    });
    const observation = agent.fallbackGroupObservations[0];
    if (observation === undefined) throw new Error("fallback identity request was not observed");
    const candidate = observation.payload.candidates?.[0];
    if (candidate === undefined || observation.request === undefined) {
      throw new Error("fallback identity request lacks its candidate");
    }
    expect(candidate.passages.map((passage) => passage.passageId)).toEqual(["p3", "p4"]);
    expect(
      observation.proofs
        .filter((proof) => proof.candidateId === candidate.candidateId)
        .map((proof) => proof.passageId),
    ).toEqual(["p3", "p4"]);
    expect(
      observation.payload.priorResult?.decisions.find(
        (decision) => decision.candidateId === candidate.candidateId,
      )?.passageIds,
    ).toEqual(["p3", "p4"]);
    expect(() =>
      observation.validate({
        decisions: [
          {
            candidateId: candidate.candidateId,
            action: "select",
            passageIds: ["p1"],
            reason: "renumbered passage must be rejected",
          },
        ],
      }),
    ).toThrow();
  }, 120_000);

  it("uses prior-filtered multi-member fallback inventory for exact preflight fit", async () => {
    const agent = new MultiMemberFallbackAgent();
    const { operations, load, initial } = await prepareOversizedCompaction(
      agent,
      8_700,
      [
        `Long evidence chat passage one. ${"evidence remains immutable. ".repeat(250)}`,
        `Long evidence chat passage two. ${"evidence remains immutable. ".repeat(250)}`,
      ],
      2_000,
    );
    const manifest = await inTask("multi-filter-compact-plan", () =>
      operations.initialCompactionManifest(load, initial, "multi-filter-compact-plan"),
    );
    const groups = await operations.createCompactionGroups(
      load,
      initial,
      manifest,
      "multi-filter-compact-plan",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.candidateIds).toHaveLength(2);
    const envelopes = await Promise.all(
      groups.map((group, index) =>
        inTask(`multi-filter-compact-g${String(index + 1).padStart(3, "0")}`, () =>
          operations.compactContextGroup(
            load,
            initial,
            group,
            `multi-filter-compact-g${String(index + 1).padStart(3, "0")}`,
          ),
        ),
      ),
    );
    const firstPass = await operations.collectCompaction(
      load,
      initial,
      manifest,
      groups,
      envelopes,
      "multi-filter-compact-collect",
    );
    expect(firstPass.envelopes[0]?.result.decisions).toHaveLength(2);
    expect(firstPass.envelopes[0]?.result.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "select", passageIds: ["p3", "p4"] }),
        expect.objectContaining({ action: "select", passageIds: ["p3", "p4"] }),
      ]),
    );
    const firstMeasured = await inTask("multi-filter-compact-measure", () =>
      operations.measureCompaction(load, initial, firstPass, "multi-filter-compact-measure"),
    );
    const fallbackManifest = await inTask("multi-filter-fallback-plan", () =>
      operations.fallbackCompactionManifest(
        load,
        initial,
        manifest,
        firstPass,
        {
          fits: false,
          inputTokens: firstMeasured.usableInputTokens + 1,
          usableInputTokens: firstMeasured.usableInputTokens,
          overByTokens: 1,
        },
        "multi-filter-fallback-plan",
      ),
    );
    const fallbackGroups = await operations.createFallbackCompactionGroups(
      load,
      initial,
      manifest,
      firstPass,
      fallbackManifest,
      "multi-filter-fallback-plan",
    );
    expect(fallbackGroups).toHaveLength(1);
    const fallbackGroup = fallbackGroups[0]!;
    const priorEnvelope = firstPass.envelopes.find(
      (envelope) => envelope.groupId === fallbackGroup.groupId,
    );
    if (priorEnvelope === undefined)
      throw new Error("multi-member fallback lost its prior envelope");
    const fallbackEnvelope = await inTask("multi-filter-fallback-g001", () =>
      operations.compactContextGroup(
        load,
        initial,
        fallbackGroup,
        "multi-filter-fallback-g001",
        "fallback",
        priorEnvelope,
      ),
    );
    expect(fallbackEnvelope.result.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "select", passageIds: ["p4"] }),
        expect.objectContaining({ action: "select", passageIds: ["p4"] }),
      ]),
    );
    const finalPass = await operations.collectFallbackCompaction(
      load,
      initial,
      fallbackManifest,
      fallbackGroups,
      [fallbackEnvelope],
      firstPass,
      "multi-filter-fallback-collect",
    );
    expect(
      await inTask("multi-filter-fallback-measure", () =>
        operations.measureCompaction(load, initial, finalPass, "multi-filter-fallback-measure"),
      ),
    ).toMatchObject({ status: "ready" });
    const observation = agent.fallbackGroupObservations[0];
    const initialPayload = agent.initialGroupPayloads[0];
    if (
      observation === undefined ||
      initialPayload === undefined ||
      observation.request === undefined
    ) {
      throw new Error("multi-member fallback requests were not captured");
    }
    const dispatched = observation.request;
    const model = resolveRegisteredModel(dispatched.model);
    const replaceUserPayload = (
      payload: Readonly<Record<string, unknown>>,
    ): LiveProviderRequest => ({
      ...dispatched,
      messages: dispatched.messages.map((message) =>
        message.role === "user" ? { ...message, content: JSON.stringify(payload) } : message,
      ),
    });
    const filteredRequest = replaceUserPayload(observation.payload);
    const originalFallbackRequest = replaceUserPayload({
      ...observation.payload,
      candidates: initialPayload.candidates,
    });
    const initialRequest = replaceUserPayload(initialPayload);
    const allowance = Math.min(8_700, model.contextWindow - dispatched.requestedOutputTokens);
    expect(model.countRequestTokens(initialRequest)).toBeLessThanOrEqual(allowance);
    expect(model.countRequestTokens(filteredRequest)).toBe(model.countRequestTokens(dispatched));
    expect(providerRequestSha256Hex(filteredRequest)).toBe(providerRequestSha256Hex(dispatched));
    expect(model.countRequestTokens(filteredRequest)).toBeLessThanOrEqual(allowance);
    expect(model.countRequestTokens(originalFallbackRequest)).toBeGreaterThan(allowance);
  }, 120_000);
  it("runs one monotone fallback and reuses retained selections without a second fallback", async () => {
    const agent = new PhaseDCompactionAgent("fallback-omit");
    const { operations, load, initial } = await prepareOversizedCompaction(agent);
    const manifest = await inTask("single-compact-plan", () =>
      operations.initialCompactionManifest(load, initial, "single-compact-plan"),
    );
    const groups = await operations.createCompactionGroups(
      load,
      initial,
      manifest,
      "single-compact-plan",
    );
    const envelopes = await Promise.all(
      groups.map((group, index) =>
        inTask(`single-compact-g${String(index + 1).padStart(3, "0")}`, () =>
          operations.compactContextGroup(
            load,
            initial,
            group,
            `single-compact-g${String(index + 1).padStart(3, "0")}`,
          ),
        ),
      ),
    );
    const firstPass = await operations.collectCompaction(
      load,
      initial,
      manifest,
      groups,
      envelopes,
      "single-compact-collect",
    );
    const firstMeasured = await inTask("single-compact-measure", () =>
      operations.measureCompaction(load, initial, firstPass, "single-compact-measure"),
    );
    // The normal pass is allowed to fit; this explicit oversized measurement drives the
    // bounded fallback branch without weakening the normal compaction contract.
    const firstMeasurement = {
      fits: false,
      inputTokens: firstMeasured.usableInputTokens + 1,
      usableInputTokens: firstMeasured.usableInputTokens,
      overByTokens: 1,
    };
    const fallbackManifest = await inTask("single-fallback-plan", () =>
      operations.fallbackCompactionManifest(
        load,
        initial,
        manifest,
        firstPass,
        {
          fits: firstMeasurement.fits,
          inputTokens: firstMeasurement.inputTokens,
          usableInputTokens: firstMeasurement.usableInputTokens,
          overByTokens: Math.max(
            0,
            firstMeasurement.inputTokens - firstMeasurement.usableInputTokens,
          ),
        },
        "single-fallback-plan",
      ),
    );
    const fallbackGroups = await operations.createFallbackCompactionGroups(
      load,
      initial,
      manifest,
      firstPass,
      fallbackManifest,
      "single-fallback-plan",
    );
    const fallbackEnvelopes = await Promise.all(
      fallbackGroups.map((group, index) =>
        inTask(`single-fallback-g${String(index + 1).padStart(3, "0")}`, () =>
          operations.compactContextGroup(
            load,
            initial,
            group,
            `single-fallback-g${String(index + 1).padStart(3, "0")}`,
            "fallback",
          ),
        ),
      ),
    );
    const fallbackPass = await operations.collectFallbackCompaction(
      load,
      initial,
      fallbackManifest,
      fallbackGroups,
      fallbackEnvelopes,
      firstPass,
      "single-fallback-collect",
    );
    const final = await inTask("single-fallback-measure", () =>
      operations.measureCompaction(load, initial, fallbackPass, "single-fallback-measure"),
    );
    expect(agent.fallbackCalls).toBe(1);
    expect(final.status).toBe("ready");
  }, 120_000);

  it("fails closed as context_plan_unfit after the fallback pass remains oversized", async () => {
    const agent = new PhaseDCompactionAgent();
    const { operations, load, initial } = await prepareOversizedCompaction(agent);
    const pass: CompactionPassResult = {
      phase: "fallback",
      groups: [],
      taskIds: [],
      envelopes: [],
      selections: initial.candidateLedger.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        action: "keep",
        passageIds: [],
        ranges: candidate.baseRanges,
      })),
      repairUsed: false,
    };
    const result = await inTask("single-fallback-measure", () =>
      operations.measureCompaction(load, initial, pass, "single-fallback-measure"),
    );
    expect(result.status).toBe("failed");
    expect(result.failureCode).toBe("context_plan_unfit");
    expect(agent.fallbackCalls).toBe(0);
  }, 120_000);

  it("preserves exact selected ranges and private source proof inputs after compaction", async () => {
    const agent = new PhaseDCompactionAgent();
    const { operations, load, initial } = await prepareOversizedCompaction(agent);
    const manifest = await inTask("single-compact-plan", () =>
      operations.initialCompactionManifest(load, initial, "single-compact-plan"),
    );
    const groups = await operations.createCompactionGroups(
      load,
      initial,
      manifest,
      "single-compact-plan",
    );
    const envelopes = await Promise.all(
      groups.map((group, index) =>
        inTask(`single-compact-g${String(index + 1).padStart(3, "0")}`, () =>
          operations.compactContextGroup(
            load,
            initial,
            group,
            `single-compact-g${String(index + 1).padStart(3, "0")}`,
          ),
        ),
      ),
    );
    const pass = await operations.collectCompaction(
      load,
      initial,
      manifest,
      groups,
      envelopes,
      "single-compact-collect",
    );
    const measured = await inTask("single-compact-measure", () =>
      operations.measureCompaction(load, initial, pass, "single-compact-measure"),
    );
    expect(
      measured.sourceMap.every(
        (source) => source.locator.kind !== "document" || source.locator.ranges.length > 0,
      ),
    ).toBe(true);
    expect(measured.request.messages.find((message) => message.role === "user")?.content).toContain(
      "evidence",
    );
    expect(measured.status).toBe("ready");
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
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await inTask("plan-turn", () => operations.planTurn(load));
    expect(agent.entries).toHaveLength(12);
  }, 120_000);

  it("returns the canonical retrieval ledger result shape", async () => {
    const fixture = await runDb(createFixture);
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      phaseBOperationConfig,
      new IntegrationAgentClient(),
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const result = await inTask("ledger-shape-retrieve", () =>
      operations.retrieveStructuredInternal(
        load,
        "What changed in liquidity?",
        "ledger-shape-retrieve",
        [],
      ),
    );
    expect(result).toMatchObject({
      queryPlan: expect.objectContaining({ action: "search" }),
      fused: expect.objectContaining({ results: expect.any(Array) }),
      previewExposures: expect.any(Array),
      review: expect.any(Array),
    });
  }, 120_000);
});
