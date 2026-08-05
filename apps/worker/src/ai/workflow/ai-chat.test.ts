import { PgClient } from "@effect/sql-pg";
import { makeRunAcceptanceScope } from "@hartlib/shared";
import { Effect, Redacted } from "effect";
import { Effect as Effect3 } from "effect3";
import { SmithersDb } from "smithers-orchestrator";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "@hartlib/database/migrations";
import type { CanonicalAgentClient } from "../runtime/agent-client";
import { AiRuntimeError } from "../runtime/errors";
import type {
  AnswerLaneResult,
  FinalSourceRecord,
  PlanTurnResult,
  MemoryExtractionArtifact,
  TopicPacket,
} from "../runtime/types";
import type { RetrievalPlanResult } from "../retrieval/retrieval";
import {
  AI_CHAT_SMITHERS_SCHEMA_FENCE,
  createAiChatSmithersStorage,
  createSmithersStorage,
  runSmithersWorkflow,
  runWithAiChatSmithersProducerFence,
  smithersRunExists,
  type SmithersStorage,
} from "../smithers-interop";
import { deleteSmithersRowsForRun } from "./smithers-cleanup";
import {
  aiChatRetryPolicy,
  aiChatRuntimeInputSchema,
  aiChatSchemas,
  aiChatSmithersMaxConcurrency,
  buildAiChatWorkflow,
} from "./ai-chat";
import { toProviderCandidateView, type CandidateLedgerEntry } from "./types";
import {
  CanonicalWorkflowOperations,
  type ContextAssembly,
  type ContextState,
  type FanoutAllocation,
  type FanoutSourceKeySet,
  type LoadedTurn,
  type MemorySelectorResult,
  type SelectorBundle,
  type WebSelectorResult,
} from "./operations";
import type {
  CompactionGroup,
  GroupResultEnvelope,
  InitialContextManifest,
  FallbackContextManifest,
} from "../context/compaction";
import type { CompactionPassResult } from "../context/compaction-runtime";

const sourceDatabaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const databaseName = `hartlib_ai_chat_graph_test_${process.pid}_${crypto
  .randomUUID()
  .replaceAll("-", "")
  .slice(0, 8)}`;
const migrationIsolationDatabaseName = `${databaseName}_migration`;
const fenceIsolationDatabaseName = `${databaseName}_fence`;
const workflowConfig = {
  aiFastTaskTimeoutMs: 30_000,
  aiAnswerTimeoutMs: 30_000,
  aiTopicResearchMaxConcurrency: 6,
  aiTopicAnswerMaxConcurrency: 3,
} as const;

const databaseUrlFor = (name: string): string => {
  if (sourceDatabaseUrl === undefined)
    throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

const adminDatabaseUrl = (): string => databaseUrlFor("postgres");
const workflowDatabaseUrl = (): string => databaseUrlFor(databaseName);
const databaseUrl = sourceDatabaseUrl === undefined ? undefined : workflowDatabaseUrl();
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const runDb = <A, E>(
  effect: Effect.Effect<A, E, PgClient.PgClient>,
  url = workflowDatabaseUrl(),
): Promise<A> => {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName: "hartlib-ai-chat-graph-test",
        }),
      ),
    ),
  );
};

interface SmithersFrameElement {
  readonly kind: string;
  readonly tag?: string;
  readonly props?: Readonly<Record<string, string>>;
  readonly children?: readonly SmithersFrameElement[];
}
const graphKeyframe = async (
  storage: Pick<SmithersStorage<typeof aiChatSchemas>, "db">,
  runId: string,
  marker = "fanout-topic-research",
): Promise<SmithersFrameElement> => {
  const frames = await Effect3.runPromise(new SmithersDb(storage.db).listFrames(runId, 500));
  const frame = frames.find((candidate) => candidate.xmlJson.includes(marker));
  if (frame === undefined) throw new Error(`missing graph keyframe for ${runId}`);
  return JSON.parse(frame.xmlJson) as SmithersFrameElement;
};

const collectFrameElements = (
  root: SmithersFrameElement,
  predicate: (element: SmithersFrameElement) => boolean,
): readonly SmithersFrameElement[] => [
  ...(predicate(root) ? [root] : []),
  ...(root.children ?? []).flatMap((child) => collectFrameElements(child, predicate)),
];

const normalizedTopicIds = (runId: string): Promise<readonly string[]> =>
  runDb(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{ readonly value: string }>`
        select value
        from ai_chat_plan_turn
        where run_id = ${runId}
          and node_id = 'plan-turn'
          and iteration = 0
      `;
      const value = rows[0]?.value;
      if (value === undefined) throw new Error(`missing plan-turn output for ${runId}`);
      const parsed = JSON.parse(value) as {
        readonly topics?: readonly { readonly topicId: string }[];
      };
      return parsed.topics?.map((topic) => topic.topicId) ?? [];
    }),
  );

const finishedTopicNodeIds = (runId: string): Promise<readonly string[]> =>
  runDb(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{ readonly nodeId: string }>`
        select node_id as "nodeId"
        from _smithers_nodes
        where run_id = ${runId}
          and state = 'finished'
          and node_id like 'topic-%'
        order by node_id
      `;
      return rows.map((row) => row.nodeId);
    }),
  );

const finishedNodeIds = (runId: string): Promise<ReadonlySet<string>> =>
  runDb(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{ readonly nodeId: string }>`
        select node_id as "nodeId"
        from _smithers_nodes
        where run_id = ${runId}
          and state = 'finished'
      `;
      return new Set(rows.map((row) => row.nodeId));
    }),
  );

const waitForFinishedNodes = async (runId: string, expected: readonly string[]): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const finished = await finishedNodeIds(runId);
    if (expected.every((nodeId) => finished.has(nodeId))) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  const finished = await finishedNodeIds(runId);
  throw new Error(
    `timed out waiting for Smithers checkpoints: ${expected
      .filter((nodeId) => !finished.has(nodeId))
      .join(", ")}`,
  );
};

const emptyMemory: MemoryExtractionArtifact = {
  result: { proposals: [], discardedCount: 0 },
  producer: {
    taskId: "memory-extract",
    loopIteration: 0,
    attempt: 1,
    observationKey: "memory-extract:0:1:memory_extraction_result:result",
    extractionSha256Hex: "0".repeat(64),
  },
};
const load: LoadedTurn = {
  aiRunId: "00000000-0000-4000-8000-000000000003",
  chatId: "00000000-0000-4000-8000-000000000001",
  initiatingUserId: "workflow-user",
  userMessageId: crypto.randomUUID(),
  userMessage: "Compare the evidence.",
  locale: "en-US",
  market: "US",
  currentDate: "2026-07-10",
  citationNamespace: "cn_" + "A".repeat(22),
  acceptanceScope: makeRunAcceptanceScope({
    userId: "workflow-user",
    chatId: "00000000-0000-4000-8000-000000000001",
    companyId: "00000000-0000-4000-8000-000000000002",
    memoryMode: "disabled",
    webRequested: false,
    webEnabled: false,
  }),
};
const request = {
  requestClass: "main" as const,
  model: "glm-5-turbo" as const,
  messages: [{ role: "user" as const, content: "answer" }],
  requestedOutputTokens: 32,
  reasoning: "medium" as const,
};
const context = (topicId?: "t1" | "t2" | "t3"): ContextState => ({
  status: "ready",
  question: topicId ?? "single",
  ...(topicId === undefined ? {} : { topicId }),
  candidates: [],
  candidateLedger: { candidates: [] },
  sourceMap: [],
  ledgerCandidates: [],
  ledgerSourceMap: [],
  selectedConversation: [],
  consumers: [
    {
      consumer: topicId === undefined ? "direct" : "topic",
      ...(topicId === undefined ? {} : { topicId }),
      inputTokens: 4,
      requestedOutputTokens: 32,
      usableInputTokens: 100,
    },
  ],
  gaps: [],
  compactionFeedback: [],
  request,
  inputTokens: 4,
  usableInputTokens: 100,
  compactionRan: false,
});
const assembly = (topicId?: "t1" | "t2" | "t3"): ContextAssembly => ({
  question: topicId ?? "single",
  ...(topicId === undefined ? {} : { topicId }),
  candidates: [],
  candidateLedger: { candidates: [] },
  sourceMap: [],
  selectedConversation: [],
  gaps: [],
  consumerTaskId: topicId === undefined ? "single-answer" : `topic-${topicId}-answer`,
  requestedOutputTokens: 32,
});

const structuredRetrievalResult = {
  queryPlan: {
    action: "search" as const,
    queries: [
      {
        purpose: "structured evidence",
        all: [{ text: "evidence", mode: "term" as const }],
        anyOf: [],
        not: [],
        filters: {},
        order: "relevance" as const,
      },
    ],
  },
  branches: [],
  fused: {
    results: [
      {
        resultId: "r1" as const,
        identity: {
          kind: "chat_message" as const,
          messageId: "structured-message",
          sanitizedContentHash: "a".repeat(64),
        },
        identityKey: JSON.stringify(["chat_message", "structured-message", "a".repeat(64)]),
        value: {
          kind: "chat_message" as const,
          label: "assistant",
          date: null,
          textCharCount: 18,
          text: "structured evidence",
          snapshotId: "structured-message",
          contentHash: "a".repeat(64),
          tokenCount: 3,
          fullTokenCount: 3,
          fastTokenCount: 3,
          mainTokenCount: 3,
          preview: "structured evidence",
          previewRanges: [{ charStart: 0, charEnd: 18 }],
          previewBytes: new TextEncoder().encode("structured evidence"),
        },
        score: 1 / 61,
        rrfK: 60,
        bestRank: 1,
        date: null,
        provenance: [{ queryOrdinal: 1, branch: "chat_messages", rank: 1 }],
        matchedQueryOrdinals: [1],
      },
    ],
    coverage: [],
    candidateCountBeforeCap: 1,
    candidateCap: 1,
    hydratedBytes: 18,
    hydrationByteCap: null,
    truncation: { branch: false, candidates: false, hydration: false },
  },
  review: [],
  previewExposures: [],
} as unknown as RetrievalPlanResult;

class ScriptedOperations extends CanonicalWorkflowOperations {
  readonly calls: string[] = [];
  readonly finalAnswers: AnswerLaneResult[] = [];
  readonly streamedTaskIds: string[] = [];
  readonly structuredTopicTaskIds: string[] = [];
  readonly structuredQuestions: string[] = [];
  readonly assembledStructuredResults: number[] = [];
  readonly collectedTaskIds: string[][] = [];
  constructor(
    readonly route: "clarify" | "single" | "fanout",
    readonly compaction: "none" | "fit" | "correct-then-fit" | "unfit" = "none",
    readonly topicFailure: "context_plan_unfit" | undefined = undefined,
  ) {
    super(
      databaseUrl ?? "postgres://unused",
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 16_384,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 16_384,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiWebMaxSearches: 4,
        aiWebMaxFetches: 8,
        aiWebMaxDomainFilters: 8,
        aiMemoryToolResultMaxItems: 50,
        webResearchProvider: "",
      },
      {} as CanonicalAgentClient,
    );
  }

  override async loadTurn() {
    this.calls.push("load-turn");
    return load;
  }
  override async extractMemory() {
    this.calls.push("memory-extract");
    return emptyMemory;
  }
  override async clarify(_load: LoadedTurn, question: string): Promise<AnswerLaneResult> {
    this.calls.push("clarification-result");
    return { status: "ok", mode: "clarification", content: question, sourceMap: [] };
  }
  override async planTurn(): Promise<PlanTurnResult> {
    this.calls.push("plan-turn");
    if (this.route === "clarify") {
      return { mode: "clarify", question: "Which comparison?" };
    }
    if (this.route === "fanout") {
      return {
        mode: "fanout",
        question: "Compare",
        topics: [
          { topicId: "t1", question: "one", relevantTurnIds: [] },
          { topicId: "t2", question: "two", relevantTurnIds: [] },
        ],
      };
    }
    return { mode: "single", question: "Compare", relevantTurnIds: [] };
  }
  override async retrieveStructuredInternal(
    _load: LoadedTurn,
    _question: string,
    taskId: string,
    _selectedTurnIds?: readonly string[],
  ): Promise<RetrievalPlanResult | null> {
    this.calls.push(taskId);
    this.structuredQuestions.push(_question);
    return structuredRetrievalResult;
  }
  override async selectMemories(
    _load: LoadedTurn,
    _question: string,
    taskId: string,
  ): Promise<MemorySelectorResult> {
    this.calls.push(taskId);
    return { status: "enabled", entries: [] } satisfies MemorySelectorResult;
  }
  override async retrieveWeb(
    _load: LoadedTurn,
    _question: string,
    taskId: string,
  ): Promise<WebSelectorResult> {
    this.calls.push(taskId);
    return { status: "enabled", entries: [] } satisfies WebSelectorResult;
  }
  override async assembleContext(
    _load: LoadedTurn,
    _question: string,
    selectors: SelectorBundle,
    observationTaskId: string,
    _consumerTaskId: string,
    topicId?: "t1" | "t2" | "t3",
    _selectedTurnIds?: readonly string[],
    _fanoutSourceKeys?: FanoutSourceKeySet,
    _requestedOutputTokens?: number,
  ) {
    this.calls.push(observationTaskId);
    this.assembledStructuredResults.push(selectors.structuredInternal?.fused.results.length ?? 0);
    return assembly(topicId);
  }
  override async measureAssembly(
    _load: LoadedTurn,
    value: ContextAssembly,
    observationTaskId: string,
  ) {
    this.calls.push(observationTaskId);
    return this.compaction === "none" || value.topicId !== undefined
      ? context(value.topicId)
      : {
          ...context(),
          status: "needs_compaction" as const,
          inputTokens: 101,
          usableInputTokens: 100,
        };
  }
  async initialCompactionManifest(
    _load: LoadedTurn,
    _state: ContextState,
    taskId: string,
  ): Promise<InitialContextManifest> {
    this.calls.push(taskId);
    return { decisions: [], groups: [] };
  }
  async createCompactionGroups(
    _load: LoadedTurn,
    _state: ContextState,
    _manifest: InitialContextManifest,
    taskId: string,
  ): Promise<readonly CompactionGroup[]> {
    this.calls.push(taskId);
    return [];
  }
  async createFallbackCompactionGroups(
    _load: LoadedTurn,
    _state: ContextState,
    _initialManifest: InitialContextManifest,
    _firstPass: unknown,
    _manifest: FallbackContextManifest,
    taskId: string,
  ): Promise<readonly CompactionGroup[]> {
    this.calls.push(taskId);
    return [];
  }
  async compactContextGroup(
    _load: LoadedTurn,
    _state: ContextState,
    _group: CompactionGroup,
    taskId: string,
    _phase: "compact" | "fallback" = "compact",
    _priorResult?: GroupResultEnvelope,
  ): Promise<GroupResultEnvelope> {
    this.calls.push(taskId);
    return {
      groupId: _group.groupId,
      result: { decisions: [] },
      renderedTokenCount: 0,
    };
  }
  async collectCompaction(
    _load: LoadedTurn,
    _state: ContextState,
    _manifest: InitialContextManifest | FallbackContextManifest,
    groups: readonly CompactionGroup[],
    envelopes: readonly GroupResultEnvelope[],
    taskId: string,
  ): Promise<CompactionPassResult> {
    this.calls.push(taskId);
    this.collectedTaskIds.push(envelopes.map((envelope) => envelope.groupId));
    return {
      phase: "compact",
      groups,
      taskIds: envelopes.map((envelope) => envelope.groupId),
      envelopes,
      selections: [],
      repairUsed: false,
    };
  }
  async collectFallbackCompaction(
    _load: LoadedTurn,
    _state: ContextState,
    _manifest: FallbackContextManifest,
    groups: readonly CompactionGroup[],
    envelopes: readonly GroupResultEnvelope[],
    _firstPass: CompactionPassResult,
    taskId: string,
  ): Promise<CompactionPassResult> {
    this.calls.push(taskId);
    this.collectedTaskIds.push(envelopes.map((envelope) => envelope.groupId));
    return {
      phase: "fallback",
      groups,
      taskIds: envelopes.map((envelope) => envelope.groupId),
      envelopes,
      selections: [],
      repairUsed: false,
    };
  }
  async measureCompaction(
    _load: LoadedTurn,
    state: ContextState,
    pass: CompactionPassResult,
    taskId: string,
  ): Promise<ContextState> {
    this.calls.push(taskId);
    const ready =
      this.compaction !== "unfit" && (pass.phase === "fallback" || this.compaction === "fit");
    return {
      ...state,
      status: ready ? "ready" : pass.phase === "fallback" ? "failed" : "needs_compaction",
      ...(ready || pass.phase === "compact" ? {} : { failureCode: "context_plan_unfit" as const }),
      inputTokens: ready ? 90 : 101,
      compactionRan: true,
      compactionFeedback: ready ? [] : ["validated plan remains oversized"],
    };
  }
  async fallbackCompactionManifest(
    _load: LoadedTurn,
    _state: ContextState,
    _initialManifest: InitialContextManifest,
    _firstPass: unknown,
    _measurement: unknown,
    taskId: string,
  ): Promise<FallbackContextManifest> {
    this.calls.push(taskId);
    return { decisions: [], groups: [] };
  }
  async selectCompactionContext(_load: LoadedTurn, state: ContextState, taskId: string) {
    this.calls.push(taskId);
    if (state.topicId === "t1" && this.topicFailure !== undefined) {
      return { ...state, status: "failed" as const, failureCode: this.topicFailure };
    }
    return state;
  }
  override async answerDirect(
    _load: LoadedTurn,
    _state: ContextState,
    taskId: string,
  ): Promise<AnswerLaneResult> {
    this.calls.push("single-answer");
    this.streamedTaskIds.push(taskId);
    return { status: "ok", mode: "single", content: "single", sourceMap: [] };
  }
  override async allocateFanout(
    _load: LoadedTurn,
    _plan: Extract<PlanTurnResult, { mode: "fanout" }>,
  ) {
    this.calls.push("fanout-allocate");
    return { packetOutputTokens: 1024, synthesisUsableInput: 100_000, fixedSynthesisInput: 100 };
  }
  override async mergeFanoutSources(
    _load: LoadedTurn,
    _topics: Extract<PlanTurnResult, { mode: "fanout" }>["topics"],
    _selectors: Readonly<Record<"t1" | "t2" | "t3", SelectorBundle>>,
  ): Promise<FanoutSourceKeySet> {
    this.calls.push("fanout-merge-sources");
    return { sources: [] };
  }
  override async answerTopic(
    _load: LoadedTurn,
    state: ContextState,
    taskId: string,
    _packetOutputTokens?: number,
  ): Promise<TopicPacket> {
    this.calls.push(taskId);
    this.structuredTopicTaskIds.push(taskId);
    return { topicId: state.topicId!, status: "partial", claims: [], gaps: ["none"] };
  }
  override mergeFanoutSourceMaps() {
    this.calls.push("fanout-collect");
    return [];
  }
  override async synthesisContext(
    _load: LoadedTurn,
    packets: readonly TopicPacket[],
    _sourceMap: readonly FinalSourceRecord[],
    _topicContexts: readonly ContextState[],
    _allocation: FanoutAllocation,
  ): Promise<ContextState> {
    this.calls.push("fanout-synthesis-measure");
    const synthesisRequest = {
      ...request,
      messages: [{ role: "user" as const, content: JSON.stringify({ packets }) }],
    };
    return packets.length === 0
      ? {
          ...context(),
          request: synthesisRequest,
          status: "failed" as const,
          failureCode: "synthesis_budget_mismatch" as const,
        }
      : { ...context(), request: synthesisRequest };
  }
  override async recordSynthesisContextMeasurement(): Promise<void> {}
  override async synthesize(
    _load: LoadedTurn,
    _state: ContextState,
    taskId: string,
  ): Promise<AnswerLaneResult> {
    this.calls.push("fanout-synthesis");
    this.streamedTaskIds.push(taskId);
    return { status: "ok", mode: "synthesis", content: "fanout", sourceMap: [] };
  }
  override async finalize(
    _load: LoadedTurn,
    answer: AnswerLaneResult,
    _memory: MemoryExtractionArtifact,
  ) {
    this.finalAnswers.push(answer);
    this.calls.push(`finalize:${answer.status === "ok" ? answer.mode : "failed"}`);
    return {
      status: "succeeded" as const,
      assistantMessageId: crypto.randomUUID(),
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
      alreadyTerminal: false,
    };
  }
}
class GroupedCompactionOperations extends ScriptedOperations {
  constructor(readonly convergence: "fit" | "unfit" = "fit") {
    super("single", convergence);
  }

  override async initialCompactionManifest(
    load: LoadedTurn,
    state: ContextState,
    taskId: string,
  ): Promise<InitialContextManifest> {
    this.calls.push(taskId);
    return {
      decisions: [
        { candidateId: "c1", action: "compact", groupId: "g1", reason: "retain evidence" },
        { candidateId: "c2", action: "compact", groupId: "g2", reason: "retain evidence" },
      ],
      groups: [
        { groupId: "g1", renderedTokenBudget: 1 },
        { groupId: "g2", renderedTokenBudget: 1 },
      ],
    };
  }

  override async createCompactionGroups(
    _load: LoadedTurn,
    _state: ContextState,
    _manifest: InitialContextManifest,
    taskId: string,
  ): Promise<readonly CompactionGroup[]> {
    this.calls.push(taskId);
    return [
      { groupId: "g1", candidateIds: ["c1"], renderedTokenBudget: 1, mode: "normal" },
      { groupId: "g2", candidateIds: ["c2"], renderedTokenBudget: 1, mode: "normal" },
    ];
  }

  override async fallbackCompactionManifest(
    _load: LoadedTurn,
    _state: ContextState,
    _initialManifest: InitialContextManifest,
    _firstPass: unknown,
    _measurement: unknown,
    taskId: string,
  ): Promise<FallbackContextManifest> {
    this.calls.push(taskId);
    return {
      decisions: [
        { candidateId: "c1", action: "omit", reason: "not needed" },
        { candidateId: "c2", action: "omit", reason: "not needed" },
      ],
      groups: [],
    };
  }

  override async createFallbackCompactionGroups(
    _load: LoadedTurn,
    _state: ContextState,
    _initialManifest: InitialContextManifest,
    _firstPass: unknown,
    _manifest: FallbackContextManifest,
    taskId: string,
  ): Promise<readonly CompactionGroup[]> {
    this.calls.push(taskId);
    return [];
  }
}

class FallbackGroupedCompactionOperations extends GroupedCompactionOperations {
  override async fallbackCompactionManifest(
    _load: LoadedTurn,
    _state: ContextState,
    _initialManifest: InitialContextManifest,
    _firstPass: unknown,
    _measurement: unknown,
    taskId: string,
  ): Promise<FallbackContextManifest> {
    this.calls.push(taskId);
    return {
      decisions: [
        { candidateId: "c1", action: "compact", groupId: "g1", reason: "tighten evidence" },
      ],
      groups: [{ groupId: "g1", renderedTokenBudget: 1 }],
    };
  }

  override async createFallbackCompactionGroups(
    _load: LoadedTurn,
    _state: ContextState,
    _initialManifest: InitialContextManifest,
    _firstPass: unknown,
    _manifest: FallbackContextManifest,
    taskId: string,
  ): Promise<readonly CompactionGroup[]> {
    this.calls.push(taskId);
    return [{ groupId: "g1", candidateIds: ["c1"], renderedTokenBudget: 1, mode: "normal" }];
  }
}

class TopicPacketCompactionOperations extends ScriptedOperations {
  readonly manifestDecisions: string[][] = [];

  constructor(readonly mode: "compact-fit" | "fallback-fit" | "fallback-unfit") {
    super("fanout");
  }

  private packetContext(
    packets: readonly TopicPacket[],
    status: ContextState["status"],
  ): ContextState {
    const candidates = packets.map((packet, index) => {
      const candidateId = `c${index + 1}` as `c${number}`;
      const text = JSON.stringify(packet);
      const packetSha256Hex = `${String.fromCharCode(97 + index).repeat(64)}`;
      return {
        id: candidateId,
        kind: "topic_packet" as const,
        rank: index,
        purpose: "provider-authored topic packet",
        topicId: packet.topicId,
        text,
        packetSha256Hex,
        label: packet.topicId,
        renderedTokenCount: 1,
      };
    });
    const ledgerCandidates: CandidateLedgerEntry[] = candidates.map((candidate) => ({
      candidateId: candidate.id,
      kind: "topic_packet",
      identity: {
        kind: "topic_packet",
        topicId: candidate.topicId,
        packetSha256Hex: candidate.packetSha256Hex,
      },
      provenance: { label: candidate.label, purpose: candidate.purpose, date: null },
      text: candidate.text,
      baseRanges: [{ charStart: 0, charEnd: candidate.text.length }],
      previewRanges: [{ charStart: 0, charEnd: candidate.text.length }],
      preview: candidate.text,
      renderedTokenCount: candidate.renderedTokenCount,
    }));
    return {
      ...context(),
      status,
      candidates,
      candidateLedger: { candidates: ledgerCandidates },
      ledgerCandidates: candidates,
      ledgerSourceMap: [],
      citationSourceMap: [],
      consumers: [
        {
          consumer: "synthesis",
          inputTokens: status === "needs_compaction" ? 101 : 90,
          requestedOutputTokens: 32,
          usableInputTokens: 100,
        },
      ],
      request: {
        ...request,
        messages: [{ role: "user", content: JSON.stringify({ packets }) }],
      },
      inputTokens: status === "needs_compaction" ? 101 : 90,
      usableInputTokens: 100,
    };
  }

  override async synthesisContext(
    _load: LoadedTurn,
    packets: readonly TopicPacket[],
  ): Promise<ContextState> {
    this.calls.push("fanout-synthesis-measure");
    return this.packetContext(packets, "needs_compaction");
  }

  override async initialCompactionManifest(
    _load: LoadedTurn,
    _state: ContextState,
    taskId: string,
  ): Promise<InitialContextManifest> {
    this.calls.push(taskId);
    const decisions =
      this.mode === "compact-fit"
        ? [
            { candidateId: "c1", action: "keep" as const, reason: "retain packet" },
            { candidateId: "c2", action: "omit" as const, reason: "omit packet" },
          ]
        : [
            {
              candidateId: "c1",
              action: "compact" as const,
              groupId: "g1",
              reason: "compact packet",
            },
            { candidateId: "c2", action: "omit" as const, reason: "omit packet" },
          ];
    this.manifestDecisions.push(
      decisions.map((decision) => `${decision.candidateId}:${decision.action}`),
    );
    return {
      decisions,
      groups: this.mode === "compact-fit" ? [] : [{ groupId: "g1", renderedTokenBudget: 1 }],
    };
  }

  override async createCompactionGroups(
    _load: LoadedTurn,
    _state: ContextState,
    _manifest: InitialContextManifest,
    taskId: string,
  ): Promise<readonly CompactionGroup[]> {
    this.calls.push(taskId);
    return this.mode === "compact-fit"
      ? []
      : [{ groupId: "g1", candidateIds: ["c1"], renderedTokenBudget: 1, mode: "normal" }];
  }

  override async compactContextGroup(
    _load: LoadedTurn,
    _state: ContextState,
    group: CompactionGroup,
    taskId: string,
  ): Promise<GroupResultEnvelope> {
    this.calls.push(taskId);
    return {
      groupId: group.groupId,
      result: { decisions: [{ candidateId: "c1", action: "omit", reason: "omit packet" }] },
      renderedTokenCount: 0,
    };
  }

  override async fallbackCompactionManifest(
    _load: LoadedTurn,
    _state: ContextState,
    _initialManifest: InitialContextManifest,
    _firstPass: unknown,
    _measurement: unknown,
    taskId: string,
  ): Promise<FallbackContextManifest> {
    this.calls.push(taskId);
    const decisions = [
      { candidateId: "c1", action: "omit" as const, reason: "omit packet" },
      { candidateId: "c2", action: "omit" as const, reason: "omit packet" },
    ];
    this.manifestDecisions.push(
      decisions.map((decision) => `${decision.candidateId}:${decision.action}`),
    );
    return { decisions, groups: [] };
  }

  override async measureCompaction(
    _load: LoadedTurn,
    state: ContextState,
    pass: CompactionPassResult,
    taskId: string,
  ): Promise<ContextState> {
    this.calls.push(taskId);
    const ready =
      (this.mode === "compact-fit" && pass.phase === "compact") ||
      (this.mode === "fallback-fit" && pass.phase === "fallback");
    return {
      ...state,
      status: ready ? "ready" : pass.phase === "compact" ? "needs_compaction" : "failed",
      ...(ready || pass.phase === "compact" ? {} : { failureCode: "context_plan_unfit" as const }),
      inputTokens: ready ? 90 : 101,
      compactionRan: true,
    };
  }
}

class BlockingAnswerOperations extends ScriptedOperations {
  readonly answerStarted: Promise<void>;
  private readonly blockedAnswer: Promise<AnswerLaneResult>;
  private resolveStarted!: () => void;
  private rejectAnswer!: (error: Error) => void;

  constructor() {
    super("single");
    this.answerStarted = new Promise<void>((resolve) => {
      this.resolveStarted = resolve;
    });
    this.blockedAnswer = new Promise<AnswerLaneResult>((_resolve, reject) => {
      this.rejectAnswer = reject;
    });
    void this.blockedAnswer.catch(() => undefined);
  }

  override async answerDirect(): Promise<AnswerLaneResult> {
    this.calls.push("single-answer-blocked");
    this.resolveStarted();
    return this.blockedAnswer;
  }

  interrupt(): void {
    this.rejectAnswer(new Error("worker interrupted"));
  }
}

class ParallelJoinOperations extends ScriptedOperations {
  readonly memoryStarted: Promise<void>;
  readonly answerStarted: Promise<void>;
  private readonly memoryGate: Promise<MemoryExtractionArtifact>;
  private readonly answerGate: Promise<AnswerLaneResult>;
  private resolveMemoryStarted!: () => void;
  private resolveAnswerStarted!: () => void;
  private resolveMemory!: (value: MemoryExtractionArtifact) => void;
  private resolveAnswer!: (value: AnswerLaneResult) => void;

  constructor() {
    super("single");
    this.memoryStarted = new Promise<void>((resolve) => {
      this.resolveMemoryStarted = resolve;
    });
    this.answerStarted = new Promise<void>((resolve) => {
      this.resolveAnswerStarted = resolve;
    });
    this.memoryGate = new Promise<MemoryExtractionArtifact>((resolve) => {
      this.resolveMemory = resolve;
    });
    this.answerGate = new Promise<AnswerLaneResult>((resolve) => {
      this.resolveAnswer = resolve;
    });
  }

  override async extractMemory(): Promise<MemoryExtractionArtifact> {
    this.calls.push("memory-extract");
    this.resolveMemoryStarted();
    return this.memoryGate;
  }

  override async answerDirect(): Promise<AnswerLaneResult> {
    this.calls.push("single-answer");
    this.resolveAnswerStarted();
    return this.answerGate;
  }

  releaseAnswer(): void {
    this.resolveAnswer({ status: "ok", mode: "single", content: "single", sourceMap: [] });
  }

  releaseMemory(): void {
    this.resolveMemory(emptyMemory);
  }
}

class SelectorParallelOperations extends ScriptedOperations {
  readonly allSelectorsStarted: Promise<void>;
  readonly selectorCallCounts = new Map<string, number>();
  readonly selectorTaskIds = new Set<string>();
  private readonly selectorGate: Promise<void>;
  private resolveAllStarted!: () => void;
  private releaseSelectorGate!: () => void;

  constructor(route: "single" | "fanout") {
    super(route);
    this.allSelectorsStarted = new Promise<void>((resolve) => {
      this.resolveAllStarted = resolve;
    });
    this.selectorGate = new Promise<void>((resolve) => {
      this.releaseSelectorGate = resolve;
    });
  }

  private async selector(taskId: string): Promise<void> {
    this.selectorCallCounts.set(taskId, (this.selectorCallCounts.get(taskId) ?? 0) + 1);
    this.selectorTaskIds.add(taskId);
    const expected = this.route === "single" ? 3 : 6;
    if (this.selectorTaskIds.size === expected) this.resolveAllStarted();
    await this.selectorGate;
  }

  override async retrieveStructuredInternal(
    _load: LoadedTurn,
    _question: string,
    taskId: string,
  ): Promise<RetrievalPlanResult | null> {
    await this.selector(taskId);
    return null;
  }

  override async selectMemories(
    _load: LoadedTurn,
    _question: string,
    taskId: string,
  ): Promise<MemorySelectorResult> {
    await this.selector(taskId);
    return { status: "enabled", entries: [] };
  }

  override async retrieveWeb(
    _load: LoadedTurn,
    _question: string,
    taskId: string,
  ): Promise<WebSelectorResult> {
    await this.selector(taskId);
    return { status: "enabled", entries: [] };
  }

  releaseSelectors(): void {
    this.releaseSelectorGate();
  }
}

class TopicAnswerParallelOperations extends ScriptedOperations {
  readonly allTopicAnswersStarted: Promise<void>;
  readonly topicAnswerTaskIds = new Set<string>();
  private readonly topicAnswerGate: Promise<void>;
  private resolveAllStarted!: () => void;
  private releaseTopicGate!: () => void;

  constructor() {
    super("fanout");
    this.allTopicAnswersStarted = new Promise<void>((resolve) => {
      this.resolveAllStarted = resolve;
    });
    this.topicAnswerGate = new Promise<void>((resolve) => {
      this.releaseTopicGate = resolve;
    });
  }

  override async answerTopic(
    _load: LoadedTurn,
    state: ContextState,
    taskId: string,
  ): Promise<TopicPacket> {
    this.topicAnswerTaskIds.add(taskId);
    if (this.topicAnswerTaskIds.size === 2) this.resolveAllStarted();
    await this.topicAnswerGate;
    return { topicId: state.topicId!, status: "partial", claims: [], gaps: ["none"] };
  }

  releaseTopicAnswers(): void {
    this.releaseTopicGate();
  }
}

type FanoutResumeCheckpoint =
  | "after-plan"
  | "after-research"
  | "after-merge"
  | "after-topic-answers"
  | "after-synthesis";

class BlockingFanoutCheckpointOperations extends ScriptedOperations {
  readonly checkpointStarted: Promise<void>;
  private readonly checkpointGate: Promise<never>;
  private resolveCheckpointStarted!: () => void;
  private rejectCheckpoint!: (error: Error) => void;

  constructor(readonly checkpoint: FanoutResumeCheckpoint) {
    super("fanout");
    this.checkpointStarted = new Promise<void>((resolve) => {
      this.resolveCheckpointStarted = resolve;
    });
    this.checkpointGate = new Promise<never>((_resolve, reject) => {
      this.rejectCheckpoint = reject;
    });
    void this.checkpointGate.catch(() => undefined);
  }

  private blockAtCheckpoint<T>(call: string): Promise<T> {
    this.calls.push(`${call}:blocked`);
    this.resolveCheckpointStarted();
    return this.checkpointGate;
  }

  override async retrieveStructuredInternal(
    loaded: LoadedTurn,
    question: string,
    taskId: string,
    selectedTurnIds?: readonly string[],
  ): Promise<RetrievalPlanResult | null> {
    return this.checkpoint === "after-plan"
      ? this.blockAtCheckpoint<RetrievalPlanResult | null>(taskId)
      : super.retrieveStructuredInternal(loaded, question, taskId, selectedTurnIds);
  }

  override async selectMemories(
    loaded: LoadedTurn,
    question: string,
    taskId: string,
  ): Promise<MemorySelectorResult> {
    return this.checkpoint === "after-plan"
      ? this.blockAtCheckpoint<MemorySelectorResult>(taskId)
      : super.selectMemories(loaded, question, taskId);
  }

  override async retrieveWeb(
    loaded: LoadedTurn,
    question: string,
    taskId: string,
  ): Promise<WebSelectorResult> {
    return this.checkpoint === "after-plan"
      ? this.blockAtCheckpoint<WebSelectorResult>(taskId)
      : super.retrieveWeb(loaded, question, taskId);
  }

  override async mergeFanoutSources(
    loaded: LoadedTurn,
    topics: Extract<PlanTurnResult, { mode: "fanout" }>["topics"],
    selectors: Readonly<Record<"t1" | "t2" | "t3", SelectorBundle>>,
  ): Promise<FanoutSourceKeySet> {
    return this.checkpoint === "after-research"
      ? this.blockAtCheckpoint<FanoutSourceKeySet>("fanout-merge-sources")
      : super.mergeFanoutSources(loaded, topics, selectors);
  }

  override async assembleContext(
    loaded: LoadedTurn,
    question: string,
    selectors: SelectorBundle,
    observationTaskId: string,
    consumerTaskId: string,
    topicId?: "t1" | "t2" | "t3",
    selectedTurnIds?: readonly string[],
    fanoutSourceKeys?: FanoutSourceKeySet,
    requestedOutputTokens?: number,
  ): Promise<ContextAssembly> {
    return this.checkpoint === "after-merge" && topicId !== undefined
      ? this.blockAtCheckpoint<ContextAssembly>(observationTaskId)
      : super.assembleContext(
          loaded,
          question,
          selectors,
          observationTaskId,
          consumerTaskId,
          topicId,
          selectedTurnIds,
          fanoutSourceKeys,
          requestedOutputTokens,
        );
  }

  override async answerTopic(
    loaded: LoadedTurn,
    state: ContextState,
    taskId: string,
    packetOutputTokens?: number,
  ): Promise<TopicPacket> {
    return super.answerTopic(loaded, state, taskId, packetOutputTokens);
  }

  override async synthesize(
    loaded: LoadedTurn,
    state: ContextState,
    taskId: string,
  ): Promise<AnswerLaneResult> {
    return this.checkpoint === "after-topic-answers"
      ? this.blockAtCheckpoint(taskId)
      : super.synthesize(loaded, state, taskId);
  }

  override async finalize(
    loaded: LoadedTurn,
    answer: AnswerLaneResult,
    memory: MemoryExtractionArtifact,
  ): Promise<Awaited<ReturnType<ScriptedOperations["finalize"]>>> {
    return this.checkpoint === "after-synthesis"
      ? this.blockAtCheckpoint<Awaited<ReturnType<ScriptedOperations["finalize"]>>>("finalize")
      : super.finalize(loaded, answer, memory);
  }

  interrupt(): void {
    this.rejectCheckpoint(new Error(`worker interrupted ${this.checkpoint}`));
  }
}

class SynthesisMismatchOperations extends ScriptedOperations {
  constructor() {
    super("fanout");
  }

  override async synthesisContext(
    _load: LoadedTurn,
    _packets: readonly TopicPacket[],
    _sourceMap: readonly FinalSourceRecord[],
    _topicContexts: readonly ContextState[],
    _allocation: FanoutAllocation,
  ): Promise<ContextState> {
    this.calls.push("fanout-synthesis-measure");
    return {
      ...context(),
      status: "failed",
      inputTokens: 101,
      usableInputTokens: 100,
      failureCode: "synthesis_budget_mismatch",
    };
  }
}

class TypedSynthesisFailureOperations extends ScriptedOperations {
  constructor(private readonly failureCode: NonNullable<ContextState["failureCode"]>) {
    super("fanout");
  }

  override async synthesisContext(
    _load: LoadedTurn,
    _packets: readonly TopicPacket[],
    _sourceMap: readonly FinalSourceRecord[],
    _topicContexts: readonly ContextState[],
    _allocation: FanoutAllocation,
  ): Promise<ContextState> {
    this.calls.push("fanout-synthesis-measure");
    return {
      ...context(),
      status: "failed",
      inputTokens: 101,
      usableInputTokens: 100,
      failureCode: this.failureCode,
    };
  }
}

class RetryingAnswerOperations extends ScriptedOperations {
  answerAttempts = 0;

  constructor(private readonly failuresBeforeSuccess: number) {
    super("single");
  }

  override async answerDirect(): Promise<AnswerLaneResult> {
    this.answerAttempts += 1;
    this.calls.push(`single-answer-attempt:${this.answerAttempts}`);
    if (this.answerAttempts <= this.failuresBeforeSuccess) {
      throw new Error("retryable provider failure");
    }
    return { status: "ok", mode: "single", content: "single", sourceMap: [] };
  }
}

class FailingMemoryOperations extends ScriptedOperations {
  memoryAttempts = 0;

  constructor() {
    super("single");
  }

  override async extractMemory(): Promise<MemoryExtractionArtifact> {
    this.memoryAttempts += 1;
    throw new Error("memory extraction failed");
  }
}

class NonRetryableTopicAnswerOperations extends ScriptedOperations {
  topicAttempts = 0;

  constructor() {
    super("fanout");
  }

  override async answerTopic(
    loaded: LoadedTurn,
    state: ContextState,
    taskId: string,
    packetOutputTokens?: number,
  ): Promise<TopicPacket> {
    if (state.topicId === "t1") {
      this.topicAttempts += 1;
      throw new AiRuntimeError("topic_answer_failed", "topic request cannot fit", {
        retryable: false,
        taskRetryable: false,
      });
    }
    return super.answerTopic(loaded, state, taskId, packetOutputTokens);
  }
}

class RetryableTopicAnswerOperations extends ScriptedOperations {
  topicAttempts = 0;

  constructor() {
    super("fanout");
  }

  override async answerTopic(
    loaded: LoadedTurn,
    state: ContextState,
    taskId: string,
    packetOutputTokens?: number,
  ): Promise<TopicPacket> {
    if (state.topicId === "t1" && ++this.topicAttempts <= 2) {
      throw new AiRuntimeError("topic_answer_failed", "transient provider failure", {
        retryable: true,
        taskRetryable: true,
      });
    }
    return super.answerTopic(loaded, state, taskId, packetOutputTokens);
  }
}

class AbortedTopicAnswerOperations extends ScriptedOperations {
  topicAttempts = 0;

  constructor() {
    super("fanout");
  }

  override async answerTopic(
    loaded: LoadedTurn,
    state: ContextState,
    taskId: string,
    packetOutputTokens?: number,
  ): Promise<TopicPacket> {
    if (state.topicId === "t1") {
      this.topicAttempts += 1;
      const error = new Error("topic cancelled");
      error.name = "AbortError";
      throw error;
    }
    return super.answerTopic(loaded, state, taskId, packetOutputTokens);
  }
}

class MalformedSourceMapOperations extends ScriptedOperations {
  constructor() {
    super("single");
  }

  override async answerDirect(): Promise<AnswerLaneResult> {
    return {
      status: "ok",
      mode: "single",
      content: "invalid citation boundary",
      sourceMap: [
        {
          sourceKey: "k_outside_current_nonce_1",
          locator: {
            kind: "memory",
            memoryId: "memory-1",
            memoryRevisionId: "memory-revision-1",
          },
          label: null,
          publicProvenance: {},
          uses: [
            {
              consumerTaskId: "single-answer",
              contextOrder: 0,
              renderedTokenCount: 1,
              ranges: [],
            },
          ],
        },
      ],
    };
  }
}

describe("canonical ai-chat workflow source contract", () => {
  it("persists ordered code-owned candidates while exposing only the provider-safe view", () => {
    const entry: CandidateLedgerEntry = {
      candidateId: "c1",
      kind: "document",
      identity: {
        kind: "public_document",
        sourceId: "public:source-1",
        documentId: "document-1",
        snapshotId: "version-1",
        contentHash: "a".repeat(64),
      },
      provenance: { label: "Document", purpose: "answer", date: null },
      text: "Exact source text",
      baseRanges: [{ charStart: 0, charEnd: 17 }],
      previewRanges: [{ charStart: 0, charEnd: 17 }],
      preview: "Exact source text",
      renderedTokenCount: 3,
    };
    const runtimeCandidate = {
      id: "c1",
      kind: "document" as const,
      rank: 0,
      purpose: "answer",
      sourceId: "public:source-1",
      documentId: "document-1",
      snapshotId: "version-1",
      contentHash: "a".repeat(64),
      text: "Exact source text",
      ranges: [{ charStart: 0, charEnd: 17 }],
      label: "Document",
      publicProvenance: { documentTitle: "Document", citationUrl: "https://example.test/document" },
      renderedTokenCount: 3,
    };
    const parsed = aiChatSchemas.aiChatAssembly.safeParse({
      value: {
        ...assembly(),
        candidates: [runtimeCandidate],
        candidateLedger: { candidates: [entry] },
        sourceMap: [
          {
            sourceKey: "k_cn_AAAAAAAAAAAAAAAAAAAAAA_1",
            locator: {
              kind: "document",
              sourceId: "public:source-1",
              documentId: "document-1",
              snapshotId: "version-1",
              contentHash: "a".repeat(64),
              ranges: [{ charStart: 0, charEnd: 17 }],
            },
            label: "Document",
            publicProvenance: {
              documentTitle: "Document",
              citationUrl: "https://example.test/document",
            },
            uses: [
              {
                consumerTaskId: "single-answer",
                contextOrder: 0,
                renderedTokenCount: 3,
                ranges: [{ charStart: 0, charEnd: 17 }],
              },
            ],
          },
        ],
      },
    });
    expect(parsed.success).toBe(true);
    const provider = toProviderCandidateView(entry);
    expect(provider).toEqual({
      candidateId: "c1",
      kind: "document",
      label: "Document",
      purpose: "answer",
      date: null,
      renderedTokenCount: 3,
      preview: "Exact source text",
    });
    expect(provider).not.toHaveProperty("identity");
    expect(provider).not.toHaveProperty("text");
    expect(
      aiChatSchemas.aiChatAssembly.safeParse({
        value: {
          ...assembly(),
          candidates: [runtimeCandidate],
          sourceMap: [],
          candidateLedger: undefined,
        },
      }).success,
    ).toBe(false);
  });

  it("rejects a historical model in durable context state before resume", () => {
    const parsed = aiChatSchemas.aiChatContext.safeParse({
      value: {
        ...context(),
        request: { ...request, model: "glm-5.2" },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects malformed durable document source identities before resume", () => {
    const base = {
      sourceKey: "k_cn_AAAAAAAAAAAAAAAAAAAAAA_1",
      label: null,
      publicProvenance: { documentTitle: "Document", citationUrl: "https://example.test/doc" },
      uses: [
        {
          consumerTaskId: "single-answer",
          contextOrder: 0,
          renderedTokenCount: 1,
          ranges: [{ charStart: 0, charEnd: 1 }],
        },
      ],
    };
    const parse = (locator: Record<string, unknown>) =>
      aiChatSchemas.aiChatAnswer.safeParse({
        value: {
          status: "ok",
          mode: "single",
          content: "Answer",
          sourceMap: [{ ...base, locator }],
        },
      });
    const document = {
      kind: "document",
      sourceId: "public:source-1",
      documentId: "document-1",
      snapshotId: "version-1",
      contentHash: "a".repeat(64),
      ranges: [{ charStart: 0, charEnd: 1 }],
    };
    expect(parse(document).success).toBe(true);
    expect(parse({ ...document, ranges: [] }).success).toBe(false);
    for (const sourceId of [
      "source-1",
      " public:source-1",
      "public:public:source-1",
      "public:source-1\u2003",
      "publisher:subscription-1",
    ]) {
      expect(parse({ ...document, sourceId }).success, sourceId).toBe(false);
    }
    expect(
      parse({
        ...document,
        sourceId: "publisher:subscription-1",
        publisherIssueId: "issue-1",
        publisherDocumentId: "other-document",
      }).success,
    ).toBe(false);
    expect(
      parse({
        ...document,
        sourceId: "publisher:subscription-1",
        publisherIssueId: "issue-1",
        publisherDocumentId: "document-1",
        publisherExtractionId: "extraction-1",
      }).success,
    ).toBe(true);
    expect(
      parse({
        ...document,
        publisherIssueId: "issue-1",
        publisherDocumentId: "document-1",
      }).success,
    ).toBe(false);
  });

  it("keeps the web policy body out of the load-turn output contract", () => {
    const parsed = aiChatSchemas.aiChatLoadTurn.safeParse({
      value: {
        ...load,
        acceptanceScope: makeRunAcceptanceScope({
          userId: load.initiatingUserId,
          chatId: load.chatId,
          companyId: load.acceptanceScope.companyId,
          memoryMode: "disabled",
          webRequested: true,
          webEnabled: true,
        }),
      },
    });
    expect(parsed.success).toBe(true);
    expect(
      aiChatSchemas.aiChatLoadTurn.safeParse({
        value: {
          ...load,
          webPolicy: {
            enabled: true,
            provider: "tinyfish",
            allowedDomains: null,
          },
        },
      }).success,
    ).toBe(false);
  });

  it("keeps durable load-turn state small and rejects authorization inventories", () => {
    expect(aiChatSchemas.aiChatLoadTurn.safeParse({ value: load }).success).toBe(true);
    expect(
      aiChatSchemas.aiChatLoadTurn.safeParse({
        value: { ...load, authorizedScope: [{ sourceId: "public:source" }] },
      }).success,
    ).toBe(false);
  });

  it("decodes one strict saved scope and rejects malformed scope data", () => {
    const parsed = aiChatSchemas.aiChatLoadTurn.safeParse({ value: load });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.value.acceptanceScope).toEqual(load.acceptanceScope);
    }

    for (const acceptanceScope of [
      { ...load.acceptanceScope, chatId: "not-a-uuid" },
      { ...load.acceptanceScope, companyId: "not-a-uuid" },
      {
        ...load.acceptanceScope,
        accessIds: ["00000000-0000-4000-8000-000000000009", "00000000-0000-4000-8000-000000000001"],
      },
      { ...load.acceptanceScope, forged: true },
    ]) {
      expect(
        aiChatSchemas.aiChatLoadTurn.safeParse({
          value: { ...load, acceptanceScope },
        }).success,
      ).toBe(false);
    }
  });

  it("keeps disabled selectors distinct from enabled empty selections", () => {
    expect(
      aiChatSchemas.aiChatMemories.safeParse({
        value: { status: "disabled", reason: "memory_mode_disabled" },
      }).success,
    ).toBe(true);
    expect(
      aiChatSchemas.aiChatMemories.safeParse({
        value: { status: "enabled", entries: [] },
      }).success,
    ).toBe(true);
    expect(
      aiChatSchemas.aiChatWeb.safeParse({
        value: { status: "disabled", reason: "not_requested" },
      }).success,
    ).toBe(true);
    expect(
      aiChatSchemas.aiChatWeb.safeParse({
        value: { status: "disabled", reason: "policy_disabled" },
      }).success,
    ).toBe(true);
    expect(
      aiChatSchemas.aiChatWeb.safeParse({
        value: { status: "enabled", entries: [] },
      }).success,
    ).toBe(true);
    expect(
      aiChatSchemas.aiChatWeb.safeParse({
        value: { status: "enabled", entries: [], reason: "none" },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields at durable wrappers and nested positions", () => {
    expect(
      aiChatRuntimeInputSchema.safeParse({ aiRunId: load.aiRunId, runId: "smithers-run" }).success,
    ).toBe(true);
    expect(
      aiChatRuntimeInputSchema.safeParse({
        aiRunId: load.aiRunId,
        runId: "smithers-run",
        forged: true,
      }).success,
    ).toBe(false);
    expect(
      aiChatSchemas.aiChatLoadTurn.safeParse({
        value: { ...load, forged: true },
      }).success,
    ).toBe(false);
    expect(
      aiChatSchemas.aiChatLoadTurn.safeParse({
        value: {
          ...load,
          authorizedScope: [
            {
              sourceId: "source-1",
              displayName: "Source",
              country: "US",
              language: "en",
              ingestionType: "fixture",
              forged: true,
            },
          ],
        },
      }).success,
    ).toBe(false);

    const answer = {
      status: "ok" as const,
      mode: "single" as const,
      content: "Answer",
      sourceMap: [
        {
          sourceKey: "k_source_1",
          locator: {
            kind: "memory" as const,
            memoryId: "memory-1",
            memoryRevisionId: "revision-1",
          },
          label: null,
          publicProvenance: {},
          uses: [
            {
              consumerTaskId: "single-answer",
              contextOrder: 0,
              renderedTokenCount: 1,
              ranges: [],
            },
          ],
        },
      ],
    };
    expect(aiChatSchemas.aiChatAnswer.safeParse({ value: answer }).success).toBe(true);
    expect(
      aiChatSchemas.aiChatAnswer.safeParse({
        value: {
          ...answer,
          sourceMap: [
            {
              ...answer.sourceMap[0],
              uses: [{ ...answer.sourceMap[0]!.uses[0], contextOrder: -1 }],
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      aiChatSchemas.aiChatAnswer.safeParse({
        value: {
          ...answer,
          sourceMap: [
            {
              ...answer.sourceMap[0],
              uses: [{ ...answer.sourceMap[0]!.uses[0], renderedTokenCount: -1 }],
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      aiChatSchemas.aiChatAnswer.safeParse({
        value: {
          ...answer,
          sourceMap: [
            {
              ...answer.sourceMap[0],
              publicProvenance: { forged: true },
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      aiChatSchemas.aiChatAnswer.safeParse({
        value: {
          ...answer,
          sourceMap: [
            {
              ...answer.sourceMap[0],
              publicProvenance: { documentTitle: { nested: true } },
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      aiChatSchemas.aiChatAnswer.safeParse({
        value: {
          ...answer,
          sourceMap: [
            {
              ...answer.sourceMap[0],
              uses: [{ ...answer.sourceMap[0]!.uses[0], forged: true }],
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      aiChatSchemas.aiChatPlanTurn.safeParse({
        value: {
          mode: "single",
          question: "Question",
          relevantTurnIds: [],
          forged: true,
        },
      }).success,
    ).toBe(false);
    expect(
      aiChatSchemas.aiChatAllocation.safeParse({
        forged: true,
        value: {
          packetOutputTokens: 32,
          synthesisUsableInput: 100,
          fixedSynthesisInput: 10,
        },
      }).success,
    ).toBe(false);
  });

  it("retains publisher issue/document coordinates in strict durable candidate output", () => {
    const value = {
      question: "Compare the evidence.",
      candidates: [
        {
          id: "c1",
          kind: "document" as const,
          rank: 0,
          purpose: "publisher evidence",
          sourceId: "publisher:source-1",
          documentId: "document-1",
          snapshotId: "version-1",
          publisherIssueId: "issue-1",
          publisherDocumentId: "document-1",
          publisherExtractionId: "extraction-1",
          contentHash: "a".repeat(64),
          text: "publisher text",
          ranges: [{ charStart: 0, charEnd: 14 }],
          label: "Publisher document",
          publicProvenance: {
            sourceName: "Publisher",
            issueTitle: "Issue",
            documentTitle: "Publisher document",
            citationUrl: "/v1/issues/issue-1/documents/document-1/content",
            publishedAt: "2026-07-01T00:00:00.000Z",
          },
          renderedTokenCount: 3,
        },
      ],
      candidateLedger: {
        candidates: [
          {
            candidateId: "c1",
            kind: "document",
            identity: {
              kind: "publisher_document",
              subscriptionId: "source-1",
              issueId: "issue-1",
              documentId: "document-1",
              snapshotId: "version-1",
              publisherExtractionId: "extraction-1",
              contentHash: "a".repeat(64),
            },
            provenance: {
              label: "Publisher document",
              purpose: "publisher evidence",
              date: "2026-07-01T00:00:00.000Z",
            },
            text: "publisher text",
            baseRanges: [{ charStart: 0, charEnd: 14 }],
            previewRanges: [{ charStart: 0, charEnd: 14 }],
            preview: "publisher text",
            renderedTokenCount: 3,
          },
        ],
      },
      sourceMap: [
        {
          sourceKey: "k_cn_AAAAAAAAAAAAAAAAAAAAAA_1",
          locator: {
            kind: "document" as const,
            sourceId: "publisher:source-1",
            documentId: "document-1",
            snapshotId: "version-1",
            contentHash: "a".repeat(64),
            ranges: [{ charStart: 0, charEnd: 14 }],
            publisherIssueId: "issue-1",
            publisherDocumentId: "document-1",
            publisherExtractionId: "extraction-1",
          },
          label: "Publisher document",
          publicProvenance: {
            sourceName: "Publisher",
            issueTitle: "Issue",
            documentTitle: "Publisher document",
            citationUrl: "/v1/issues/issue-1/documents/document-1/content",
            publishedAt: "2026-07-01T00:00:00.000Z",
          },
          uses: [
            {
              consumerTaskId: "single-answer",
              contextOrder: 0,
              renderedTokenCount: 3,
              ranges: [{ charStart: 0, charEnd: 14 }],
            },
          ],
        },
      ],
      selectedConversation: [],
      gaps: [],
      consumerTaskId: "single-answer",
      requestedOutputTokens: 32,
    };
    expect(aiChatSchemas.aiChatAssembly.safeParse({ value }).success).toBe(true);
    expect(
      aiChatSchemas.aiChatAssembly.safeParse({
        value: {
          ...value,
          candidates: [{ ...value.candidates[0], publisherIssueId: undefined, forged: true }],
        },
      }).success,
    ).toBe(false);
  });

  it("uses one initial attempt plus two exponential-backoff retries on every task", () => {
    expect(aiChatRetryPolicy).toEqual({ backoff: "exponential", initialDelayMs: 250 });
    const source = readFileSync(new URL("./ai-chat.tsx", import.meta.url), "utf8");
    const taskOpenings = source.match(/<Task(?:\s[^>]*)?>/gu) ?? [];
    expect(taskOpenings.length).toBeGreaterThan(20);
    for (const opening of taskOpenings) {
      expect(opening, opening).toContain("retries={2}");
      expect(opening, opening).toContain("retryPolicy={retryPolicy}");
      expect(opening, opening).toMatch(/timeoutMs=\{(?:fast|answerTimeout)\}/u);
    }
  });

  it("reserves one global Smithers slot for memory beyond the widest configured answer lane", () => {
    expect(
      aiChatSmithersMaxConcurrency({
        aiTopicResearchMaxConcurrency: 6,
        aiTopicAnswerMaxConcurrency: 3,
      }),
    ).toBe(7);
    expect(
      aiChatSmithersMaxConcurrency({
        aiTopicResearchMaxConcurrency: 2,
        aiTopicAnswerMaxConcurrency: 8,
      }),
    ).toBe(9);
    expect(
      aiChatSmithersMaxConcurrency({
        aiTopicResearchMaxConcurrency: 1,
        aiTopicAnswerMaxConcurrency: 1,
      }),
    ).toBe(4);
  });
});

describe.skipIf(databaseUrl === undefined)("canonical ai-chat Smithers graph", () => {
  beforeAll(async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`).raw;
      }),
      adminDatabaseUrl(),
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
        `;
        yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`).raw;
      }),
      adminDatabaseUrl(),
    );
  }, 60_000);

  it("provisions canonical migrations before isolated Smithers output state", async () => {
    const migrationUrl = databaseUrlFor(migrationIsolationDatabaseName);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(`create database ${quoteIdentifier(migrationIsolationDatabaseName)}`).raw;
      }),
      adminDatabaseUrl(),
    );
    try {
      await runDb(runMigrations, migrationUrl);
      const [workflowState, sourceState] = await Promise.all([
        runDb(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return (yield* sql<{
              readonly databaseName: string;
              readonly canonicalMigrationCount: number;
              readonly loadTurnTable: string | null;
            }>`
              select
                current_database() as "databaseName",
                (
                  select count(*)::int
                  from schema_migrations
                  where name in (
                    '0031_recreate_canonical_ai_chat_smithers_outputs.sql',
                    '0048_canonical_ai_chat_node_ownership.sql'
                  )
                ) as "canonicalMigrationCount",
                to_regclass('public.ai_chat_load_turn')::text as "loadTurnTable"
            `)[0]!;
          }),
          migrationUrl,
        ),
        runDb(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return (yield* sql<{ readonly databaseName: string }>`
              select current_database() as "databaseName"
            `)[0]!;
          }),
          sourceDatabaseUrl!,
        ),
      ]);

      expect(workflowState).toEqual({
        databaseName: migrationIsolationDatabaseName,
        canonicalMigrationCount: 2,
        loadTurnTable: null,
      });
      expect(sourceState.databaseName).not.toBe(migrationIsolationDatabaseName);
    } finally {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            select pg_terminate_backend(pid)
            from pg_stat_activity
            where datname = ${migrationIsolationDatabaseName}
              and pid <> pg_backend_pid()
          `;
          yield* sql.unsafe(
            `drop database if exists ${quoteIdentifier(migrationIsolationDatabaseName)}`,
          ).raw;
        }),
        adminDatabaseUrl(),
      );
    }
  });

  it("releases startup fencing before cleanup while retaining per-workflow fencing", async () => {
    const fenceDatabaseUrl = databaseUrlFor(fenceIsolationDatabaseName);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(`create database ${quoteIdentifier(fenceIsolationDatabaseName)}`).raw;
      }),
      adminDatabaseUrl(),
    );

    let releaseExclusiveStartupLock!: () => void;
    const startupLockReleased = new Promise<void>((resolve) => {
      releaseExclusiveStartupLock = resolve;
    });
    let exclusiveStartupLockReady!: () => void;
    const startupLockReady = new Promise<void>((resolve) => {
      exclusiveStartupLockReady = resolve;
    });
    const exclusiveStartupLock = runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(
                hashtextextended(${AI_CHAT_SMITHERS_SCHEMA_FENCE}, 0)
              )
            `;
            yield* Effect.sync(exclusiveStartupLockReady);
            yield* Effect.promise(() => startupLockReleased);
          }),
        );
      }),
      fenceDatabaseUrl,
    );
    await startupLockReady;

    let storage: SmithersStorage<typeof aiChatSchemas> | undefined;
    let storagePromise: Promise<SmithersStorage<typeof aiChatSchemas>> | undefined;
    let releaseWorkflowOperation: (() => void) | undefined;
    let workflowProducer: Promise<void> | undefined;
    let exclusiveCleanup: Promise<void> | undefined;
    try {
      let startupProvisioningSettled = false;
      storagePromise = createAiChatSmithersStorage(aiChatSchemas, fenceDatabaseUrl).then(
        (createdStorage) => {
          startupProvisioningSettled = true;
          return createdStorage;
        },
      );
      let startupFenceWaitObserved = false;
      for (let attempt = 0; attempt < 100 && !startupFenceWaitObserved; attempt += 1) {
        startupFenceWaitObserved = await runDb(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const rows = yield* sql<{ readonly waiting: boolean }>`
              select exists (
                select 1
                from pg_stat_activity
                where datname = current_database()
                  and application_name = 'hartlib-ai-chat-smithers-fence'
                  and state <> 'idle'
                  and query like '%pg_advisory_lock_shared%'
              ) as waiting
            `;
            return rows[0]?.waiting === true;
          }),
          fenceDatabaseUrl,
        );
        if (!startupFenceWaitObserved && !startupProvisioningSettled) {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(startupFenceWaitObserved).toBe(true);
      expect(startupProvisioningSettled).toBe(false);
      const tablesBeforeStartupFenceRelease = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly smithersRuns: string | null;
            readonly loadTurn: string | null;
          }>`
            select
              to_regclass('public._smithers_runs')::text as "smithersRuns",
              to_regclass('public.ai_chat_load_turn')::text as "loadTurn"
          `)[0]!;
        }),
        fenceDatabaseUrl,
      );
      expect(tablesBeforeStartupFenceRelease).toEqual({ smithersRuns: null, loadTurn: null });

      releaseExclusiveStartupLock();
      await exclusiveStartupLock;
      storage = await storagePromise;
      const tablesAfterStartupFenceRelease = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly smithersRuns: string | null;
            readonly loadTurn: string | null;
          }>`
            select
              to_regclass('public._smithers_runs')::text as "smithersRuns",
              to_regclass('public.ai_chat_load_turn')::text as "loadTurn"
          `)[0]!;
        }),
        fenceDatabaseUrl,
      );
      expect(tablesAfterStartupFenceRelease.smithersRuns).toBe("_smithers_runs");
      expect(tablesAfterStartupFenceRelease.loadTurn).toBe("ai_chat_load_turn");
      await expect(
        smithersRunExists(storage, `ai-chat:startup-fence-${crypto.randomUUID()}`),
      ).resolves.toBe(false);
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            create table ai_smithers_orphan_candidates (
              smithers_run_id text primary key
            )
          `;
        }),
        fenceDatabaseUrl,
      );

      await expect(
        runDb(
          deleteSmithersRowsForRun(`ai-chat:startup-fence-${crypto.randomUUID()}`),
          fenceDatabaseUrl,
        ),
      ).resolves.toBeUndefined();

      const workflowOperationReleased = new Promise<void>((resolve) => {
        releaseWorkflowOperation = resolve;
      });
      let workflowOperationEntered!: () => void;
      const workflowOperationReady = new Promise<void>((resolve) => {
        workflowOperationEntered = resolve;
      });
      let workflowProducerSettled = false;
      workflowProducer = runWithAiChatSmithersProducerFence(fenceDatabaseUrl, async () => {
        workflowOperationEntered();
        await workflowOperationReleased;
      }).finally(() => {
        workflowProducerSettled = true;
      });
      await workflowOperationReady;

      let exclusiveCleanupSettled = false;
      exclusiveCleanup = runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.withTransaction(
            sql`
              select pg_advisory_xact_lock(
                hashtextextended(${AI_CHAT_SMITHERS_SCHEMA_FENCE}, 0)
              )
            `.pipe(Effect.asVoid),
          );
        }),
        fenceDatabaseUrl,
      ).then(() => {
        exclusiveCleanupSettled = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(exclusiveCleanupSettled).toBe(false);
      expect(workflowProducerSettled).toBe(false);

      releaseWorkflowOperation?.();
      await expect(workflowProducer).resolves.toBeUndefined();
      await expect(exclusiveCleanup).resolves.toBeUndefined();
    } finally {
      releaseWorkflowOperation?.();
      await workflowProducer?.catch(() => undefined);
      await exclusiveCleanup?.catch(() => undefined);
      releaseExclusiveStartupLock();
      await exclusiveStartupLock.catch(() => undefined);
      if (storage === undefined) {
        storage = await storagePromise?.catch(() => undefined);
      }
      await storage?.close();
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            select pg_terminate_backend(pid)
            from pg_stat_activity
            where datname = ${fenceIsolationDatabaseName}
              and pid <> pg_backend_pid()
          `;
          yield* sql.unsafe(
            `drop database if exists ${quoteIdentifier(fenceIsolationDatabaseName)}`,
          ).raw;
        }),
        adminDatabaseUrl(),
      );
    }
  }, 30_000);

  it.each([
    ["clarify", "finalize:clarification"],
    ["single", "finalize:single"],
    ["fanout", "finalize:synthesis"],
  ] as const)(
    "completes the %s branch and joins memory before finalization",
    async (route, terminal) => {
      const api = await createSmithersStorage(aiChatSchemas, {
        connectionString: workflowDatabaseUrl(),
      });
      const operations = new ScriptedOperations(route);
      try {
        const workflow = buildAiChatWorkflow(api, {
          operations,
          config: {
            aiFastTaskTimeoutMs: 30_000,
            aiAnswerTimeoutMs: 30_000,
            aiTopicResearchMaxConcurrency: 6,
            aiTopicAnswerMaxConcurrency: 3,
          },
        });
        const runId = `canonical-ai-chat-${route}-${crypto.randomUUID()}`;
        const result = await runSmithersWorkflow(workflow, {
          runId,
          input: { aiRunId: load.aiRunId },
          logDir: null,
          resume: false,
        });
        expect(result.status).toBe("finished");
        expect(operations.calls).toContain("memory-extract");
        expect(operations.calls.at(-1)).toBe(terminal);
        expect(operations.structuredQuestions.length).toBe(
          route === "single" ? 1 : route === "fanout" ? 2 : 0,
        );
        expect(operations.assembledStructuredResults.every((count) => count > 0)).toBe(true);
        const finished = await finishedNodeIds(runId);
        if (route === "single") {
          expect(finished.has("single-answer-route")).toBe(true);
          expect(operations.calls).not.toContain("single-compact-plan");
          expect(operations.calls.filter((call) => call.includes("single-compact-g"))).toEqual([]);
          expect(operations.calls.indexOf("single-assemble")).toBeLessThan(
            operations.calls.indexOf("single-measure"),
          );
          expect(operations.calls.filter((call) => call.includes("single-fallback"))).toEqual([]);
          expect(operations.calls.indexOf("single-measure")).toBeLessThan(
            operations.calls.indexOf("single-answer"),
          );
        }
        if (route === "fanout") {
          expect(finished.has("topic-t1-answer-route")).toBe(true);
          expect(finished.has("topic-t2-answer-route")).toBe(true);
          expect(finished.has("fanout-synthesis-route")).toBe(true);
          const mergeIndex = operations.calls.indexOf("fanout-merge-sources");
          for (const topicId of ["t1", "t2"] as const) {
            const assembleIndex = operations.calls.indexOf(`topic-${topicId}-assemble`);
            const measureIndex = operations.calls.indexOf(`topic-${topicId}-measure`);
            const answerIndex = operations.calls.indexOf(`topic-${topicId}-answer`);
            expect(mergeIndex).toBeLessThan(assembleIndex);
            expect(assembleIndex).toBeLessThan(measureIndex);
            expect(measureIndex).toBeLessThan(answerIndex);
          }
        }
      } finally {
        await api.close();
      }
    },
    60_000,
  );

  it("persists stable topic IDs in one flat research group and streams only synthesis", async () => {
    const runId = `canonical-ai-chat-fanout-shape-${crypto.randomUUID()}`;
    const api = await createSmithersStorage(aiChatSchemas, { connectionString: databaseUrl! });
    const operations = new ScriptedOperations("fanout");
    try {
      const workflow = buildAiChatWorkflow(api, { operations, config: workflowConfig });
      const result = await runSmithersWorkflow(workflow, {
        runId,
        input: { aiRunId: load.aiRunId },
        logDir: null,
        resume: false,
      });
      expect(result.status).toBe("finished");
      expect(await normalizedTopicIds(runId)).toEqual(["t1", "t2"]);
      expect(await finishedTopicNodeIds(runId)).toEqual([
        "topic-t1-answer",
        "topic-t1-answer-route",
        "topic-t1-assemble",
        "topic-t1-context-select",
        "topic-t1-measure",
        "topic-t1-result",
        "topic-t1-retrieve-internal",
        "topic-t1-retrieve-web",
        "topic-t1-select-memories",
        "topic-t2-answer",
        "topic-t2-answer-route",
        "topic-t2-assemble",
        "topic-t2-context-select",
        "topic-t2-measure",
        "topic-t2-result",
        "topic-t2-retrieve-internal",
        "topic-t2-retrieve-web",
        "topic-t2-select-memories",
      ]);
      expect(operations.structuredTopicTaskIds.sort()).toEqual([
        "topic-t1-answer",
        "topic-t2-answer",
      ]);
      expect(operations.streamedTaskIds).toEqual(["fanout-synthesis"]);
      expect((await finishedNodeIds(runId)).has("fanout-synthesis-route")).toBe(true);

      const frame = await graphKeyframe(api, runId);
      const researchGroups = collectFrameElements(
        frame,
        (element) =>
          element.tag === "smithers:parallel" && element.props?.id === "fanout-topic-research",
      );
      expect(researchGroups).toHaveLength(1);
      expect(researchGroups[0]?.children?.map((child) => child.tag)).toEqual(
        Array.from({ length: 6 }, () => "smithers:task"),
      );
      expect(researchGroups[0]?.children?.map((child) => child.props?.id)).toEqual([
        "topic-t1-retrieve-internal",
        "topic-t1-select-memories",
        "topic-t1-retrieve-web",
        "topic-t2-retrieve-internal",
        "topic-t2-select-memories",
        "topic-t2-retrieve-web",
      ]);

      for (const nodeId of [
        "topic-t1-answer-route",
        "topic-t1-result",
        "topic-t2-answer-route",
        "topic-t2-result",
        "fanout-synthesis-route",
        "fanout-result",
        "answer-select",
      ]) {
        const normalizers = collectFrameElements(
          frame,
          (element) => element.tag === "smithers:task" && element.props?.id === nodeId,
        );
        expect(normalizers, `${nodeId} must be mounted exactly once`).toHaveLength(1);
        expect(normalizers[0]?.props).not.toHaveProperty("dependsOn");
      }
      expect(
        collectFrameElements(
          frame,
          (element) => element.tag === "smithers:task" && element.props?.id === "continue-result",
        ),
      ).toHaveLength(0);
    } finally {
      await api.close();
    }
  }, 60_000);
  it("renders canonical parallel compaction group IDs in ledger order", async () => {
    const api = await createSmithersStorage(aiChatSchemas, { connectionString: databaseUrl! });
    const operations = new GroupedCompactionOperations();
    try {
      const workflow = buildAiChatWorkflow(api, { operations, config: workflowConfig });
      const runId = `canonical-ai-chat-compaction-groups-${crypto.randomUUID()}`;
      const result = await runSmithersWorkflow(workflow, {
        runId,
        input: { aiRunId: load.aiRunId },
        logDir: null,
        resume: false,
      });
      expect(result.status).toBe("finished");
      expect(operations.calls).toContain("single-compact-plan");
      expect(operations.calls).toContain("single-compact-g001");
      expect(operations.calls).toContain("single-compact-g002");
      expect(operations.calls.filter((call) => call.includes("single-fallback"))).toEqual([]);
      const frame = await graphKeyframe(api, runId, "single-compact-groups");
      const groups = collectFrameElements(
        frame,
        (element) =>
          element.tag === "smithers:parallel" && element.props?.id === "single-compact-groups",
      );
      expect(groups).toHaveLength(1);
      expect(groups[0]?.props?.maxConcurrency).toBe("3");
      expect(groups[0]?.children?.map((child) => child.props?.id)).toEqual([
        "single-compact-g001",
        "single-compact-g002",
      ]);
    } finally {
      await api.close();
    }
  }, 60_000);
  it("mounts one bounded fallback group with stable ledger ordering", async () => {
    const api = await createSmithersStorage(aiChatSchemas, { connectionString: databaseUrl! });
    const operations = new FallbackGroupedCompactionOperations("unfit");
    const runId = `canonical-ai-chat-compaction-fallback-group-${crypto.randomUUID()}`;
    try {
      const workflow = buildAiChatWorkflow(api, { operations, config: workflowConfig });
      const result = await runSmithersWorkflow(workflow, {
        runId,
        input: { aiRunId: load.aiRunId },
        logDir: null,
        resume: false,
      });
      expect(result.status).toBe("finished");
      expect(operations.calls).not.toContain("single-fallback-g002");
      expect(operations.calls.indexOf("single-fallback-g001")).toBeGreaterThan(-1);
      expect(operations.calls.indexOf("single-fallback-collect")).toBeGreaterThan(
        operations.calls.indexOf("single-fallback-g001"),
      );
      expect(operations.collectedTaskIds.at(-1)).toEqual(["g1"]);
      expect(operations.calls).not.toContain("single-answer");

      const frame = await graphKeyframe(api, runId, "single-fallback-g001");
      const fallbackGroups = collectFrameElements(
        frame,
        (element) =>
          element.tag === "smithers:parallel" && element.props?.id === "single-fallback-groups",
      );
      expect(fallbackGroups).toHaveLength(1);
      expect(fallbackGroups[0]?.props?.maxConcurrency).toBe("3");
      expect(
        collectFrameElements(
          frame,
          (element) =>
            element.tag === "smithers:task" && element.props?.id === "single-fallback-g001",
        ),
      ).toHaveLength(1);
      expect(
        collectFrameElements(
          frame,
          (element) =>
            element.tag === "smithers:task" && element.props?.id === "single-fallback-collect",
        ),
      ).toHaveLength(1);
      expect(
        collectFrameElements(
          frame,
          (element) =>
            element.tag === "smithers:task" && element.props?.id === "single-fallback-measure",
        ),
      ).toHaveLength(1);
      expect(
        collectFrameElements(
          frame,
          (element) =>
            element.tag === "smithers:task" && element.props?.id === "single-fallback-g002",
        ),
      ).toHaveLength(0);
    } finally {
      await api.close();
    }
  }, 60_000);

  it("runs at most one monotone fallback and fails closed when it remains oversized", async () => {
    const api = await createSmithersStorage(aiChatSchemas, { connectionString: databaseUrl! });
    const operations = new GroupedCompactionOperations("unfit");
    try {
      const workflow = buildAiChatWorkflow(api, { operations, config: workflowConfig });
      const result = await runSmithersWorkflow(workflow, {
        runId: `canonical-ai-chat-compaction-unfit-${crypto.randomUUID()}`,
        input: { aiRunId: load.aiRunId },
        logDir: null,
        resume: false,
      });
      expect(result.status).toBe("finished");
      expect(operations.calls.filter((call) => call === "single-fallback-plan")).toHaveLength(2);
      expect(operations.calls.filter((call) => call.includes("fallback-g"))).toEqual([]);
      expect(operations.calls).not.toContain("single-answer");
      expect(operations.calls.at(-1)).toBe("finalize:failed");
    } finally {
      await api.close();
    }
  }, 60_000);

  it.each([
    ["compact-fit", "compact"] as const,
    ["fallback-fit", "fallback"] as const,
    ["fallback-unfit", "unfit"] as const,
  ])(
    "runs the synthesis topic-packet %s path through the shared compaction graph",
    async (mode, terminalPhase) => {
      const api = await createSmithersStorage(aiChatSchemas, { connectionString: databaseUrl! });
      const operations = new TopicPacketCompactionOperations(mode);
      try {
        const workflow = buildAiChatWorkflow(api, { operations, config: workflowConfig });
        const result = await runSmithersWorkflow(workflow, {
          runId: `canonical-ai-chat-topic-packet-${mode}-${crypto.randomUUID()}`,
          input: { aiRunId: load.aiRunId },
          logDir: null,
          resume: false,
        });
        expect(result.status).toBe("finished");
        expect(operations.calls).toContain("fanout-synthesis-measure");
        expect(operations.calls).toContain("fanout-synthesis-compact-plan");
        expect(operations.manifestDecisions[0]).toEqual(
          ["c1:keep", "c2:omit"].map((value) =>
            mode === "compact-fit" ? value : value.replace(":keep", ":compact"),
          ),
        );
        if (mode === "compact-fit") {
          expect(operations.calls).not.toContain("fanout-synthesis-fallback-plan");
          expect(operations.calls).toContain("fanout-synthesis-compact-measure");
          expect(operations.calls).toContain("fanout-synthesis");
        } else {
          expect(operations.calls).toContain("fanout-synthesis-fallback-plan");
          expect(operations.calls).toContain("fanout-synthesis-fallback-measure");
          expect(operations.manifestDecisions.at(-1)).toEqual(["c1:omit", "c2:omit"]);
          if (terminalPhase === "fallback") {
            expect(operations.calls).toContain("fanout-synthesis");
          } else {
            expect(operations.calls).not.toContain("fanout-synthesis");
            expect(operations.calls.at(-1)).toBe("finalize:failed");
          }
        }
      } finally {
        await api.close();
      }
    },
    60_000,
  );

  it("resumes the same durable graph without re-executing completed answer-lane or memory tasks", async () => {
    const runId = `canonical-ai-chat-resume-${crypto.randomUUID()}`;
    const firstStorage = await createSmithersStorage(aiChatSchemas, {
      connectionString: databaseUrl!,
    });
    const blocking = new BlockingAnswerOperations();
    const firstWorkflow = buildAiChatWorkflow(firstStorage, {
      operations: blocking,
      config: {
        aiFastTaskTimeoutMs: 30_000,
        aiAnswerTimeoutMs: 30_000,
        aiTopicResearchMaxConcurrency: 6,
        aiTopicAnswerMaxConcurrency: 3,
      },
    });
    const controller = new AbortController();
    const pending = runSmithersWorkflow(firstWorkflow, {
      runId,
      input: { aiRunId: load.aiRunId },
      logDir: null,
      resume: false,
      signal: controller.signal,
    });
    await blocking.answerStarted;
    controller.abort();
    blocking.interrupt();
    const interrupted = await pending;
    expect(interrupted.status).toBe("cancelled");
    expect(blocking.calls).toContain("memory-extract");
    await firstStorage.close();

    const resumedStorage = await createSmithersStorage(aiChatSchemas, {
      connectionString: databaseUrl!,
    });
    const resumedOperations = new ScriptedOperations("single");
    try {
      const resumedWorkflow = buildAiChatWorkflow(resumedStorage, {
        operations: resumedOperations,
        config: {
          aiFastTaskTimeoutMs: 30_000,
          aiAnswerTimeoutMs: 30_000,
          aiTopicResearchMaxConcurrency: 6,
          aiTopicAnswerMaxConcurrency: 3,
        },
      });
      const resumed = await runSmithersWorkflow(resumedWorkflow, {
        runId,
        input: { aiRunId: load.aiRunId },
        logDir: null,
        resume: true,
      });
      expect(resumed.status).toBe("finished");
      expect(resumedOperations.calls).toEqual(["single-answer", "finalize:single"]);
    } finally {
      await resumedStorage.close();
    }
  }, 60_000);

  it.each([
    {
      checkpoint: "after-plan",
      durableNodes: ["memory-extract", "plan-turn", "fanout-allocate"],
      completedCalls: [
        "load-turn",
        "memory-extract",
        "plan-turn",
        "plan-turn",
        "plan-turn",
        "fanout-allocate",
      ],
    },
    {
      checkpoint: "after-research",
      durableNodes: [
        "memory-extract",
        "topic-t1-retrieve-internal",
        "topic-t1-select-memories",
        "topic-t1-retrieve-web",
        "topic-t2-retrieve-internal",
        "topic-t2-select-memories",
        "topic-t2-retrieve-web",
      ],
      completedCalls: [
        "load-turn",
        "memory-extract",
        "plan-turn",
        "plan-turn",
        "plan-turn",
        "fanout-allocate",
        "topic-t1-retrieve-internal",
        "topic-t1-select-memories",
        "topic-t1-retrieve-web",
        "topic-t2-retrieve-internal",
        "topic-t2-select-memories",
        "topic-t2-retrieve-web",
      ],
    },
    {
      checkpoint: "after-merge",
      durableNodes: ["memory-extract", "fanout-merge-sources"],
      completedCalls: [
        "load-turn",
        "memory-extract",
        "plan-turn",
        "plan-turn",
        "plan-turn",
        "fanout-allocate",
        "topic-t1-retrieve-internal",
        "topic-t1-select-memories",
        "topic-t1-retrieve-web",
        "topic-t2-retrieve-internal",
        "topic-t2-select-memories",
        "topic-t2-retrieve-web",
        "fanout-merge-sources",
      ],
    },
    {
      checkpoint: "after-topic-answers",
      durableNodes: ["memory-extract", "fanout-synthesis-measure"],
      completedCalls: [
        "load-turn",
        "memory-extract",
        "plan-turn",
        "plan-turn",
        "plan-turn",
        "fanout-allocate",
        "topic-t1-retrieve-internal",
        "topic-t1-select-memories",
        "topic-t1-retrieve-web",
        "topic-t2-retrieve-internal",
        "topic-t2-select-memories",
        "topic-t2-retrieve-web",
        "fanout-merge-sources",
        "topic-t1-assemble",
        "topic-t1-measure",
        "topic-t1-context-select",
        "topic-t1-answer",
        "topic-t2-assemble",
        "topic-t2-measure",
        "topic-t2-context-select",
        "topic-t2-answer",
        "fanout-collect",
        "fanout-synthesis-measure",
      ],
    },
    {
      checkpoint: "after-synthesis",
      durableNodes: ["memory-extract", "fanout-synthesis"],
      completedCalls: [
        "load-turn",
        "memory-extract",
        "plan-turn",
        "plan-turn",
        "plan-turn",
        "fanout-allocate",
        "topic-t1-retrieve-internal",
        "topic-t1-select-memories",
        "topic-t1-retrieve-web",
        "topic-t2-retrieve-internal",
        "topic-t2-select-memories",
        "topic-t2-retrieve-web",
        "fanout-merge-sources",
        "topic-t1-assemble",
        "topic-t1-measure",
        "topic-t1-context-select",
        "topic-t1-answer",
        "topic-t2-assemble",
        "topic-t2-measure",
        "topic-t2-context-select",
        "topic-t2-answer",
        "fanout-collect",
        "fanout-synthesis-measure",
        "fanout-synthesis",
      ],
    },
  ] as const)(
    "resumes after the $checkpoint fanout checkpoint without replaying completed phases",
    async ({ checkpoint, durableNodes, completedCalls }) => {
      const runId = `canonical-ai-chat-resume-${checkpoint}-${crypto.randomUUID()}`;
      const firstStorage = await createSmithersStorage(aiChatSchemas, {
        connectionString: databaseUrl!,
      });
      const blocking = new BlockingFanoutCheckpointOperations(checkpoint);
      const controller = new AbortController();
      try {
        const firstWorkflow = buildAiChatWorkflow(firstStorage, {
          operations: blocking,
          config: workflowConfig,
        });
        const pending = runSmithersWorkflow(firstWorkflow, {
          runId,
          input: { aiRunId: load.aiRunId },
          logDir: null,
          resume: false,
          signal: controller.signal,
        });
        await blocking.checkpointStarted;
        await waitForFinishedNodes(runId, durableNodes);
        expect(await normalizedTopicIds(runId)).toEqual(["t1", "t2"]);
        controller.abort();
        blocking.interrupt();
        await expect(pending).resolves.toMatchObject({ status: "cancelled" });
      } finally {
        controller.abort();
        blocking.interrupt();
        await firstStorage.close();
      }

      const resumedStorage = await createSmithersStorage(aiChatSchemas, {
        connectionString: databaseUrl!,
      });
      const resumedOperations = new ScriptedOperations("fanout");
      try {
        const resumedWorkflow = buildAiChatWorkflow(resumedStorage, {
          operations: resumedOperations,
          config: workflowConfig,
        });
        const resumed = await runSmithersWorkflow(resumedWorkflow, {
          runId,
          input: { aiRunId: load.aiRunId },
          logDir: null,
          resume: true,
        });
        expect(resumed.status).toBe("finished");
        for (const call of completedCalls) {
          expect(
            resumedOperations.calls,
            `${call} must not replay after ${checkpoint}`,
          ).not.toContain(call);
        }
        expect(resumedOperations.calls.at(-1)).toBe("finalize:synthesis");
        expect(await normalizedTopicIds(runId)).toEqual(["t1", "t2"]);
      } finally {
        await resumedStorage.close();
      }
    },
    90_000,
  );

  it("preserves a typed topic failure through fanout collection without scheduling synthesis", async () => {
    const api = await createSmithersStorage(aiChatSchemas, { connectionString: databaseUrl! });
    const operations = new ScriptedOperations("fanout", "none", "context_plan_unfit");
    try {
      const workflow = buildAiChatWorkflow(api, {
        operations,
        config: {
          aiFastTaskTimeoutMs: 30_000,
          aiAnswerTimeoutMs: 30_000,
          aiTopicResearchMaxConcurrency: 6,
          aiTopicAnswerMaxConcurrency: 3,
        },
      });
      const result = await runSmithersWorkflow(workflow, {
        runId: `canonical-ai-chat-topic-failure-${crypto.randomUUID()}`,
        input: { aiRunId: load.aiRunId },
        logDir: null,
        resume: false,
      });
      expect(result.status).toBe("finished");
      expect(operations.calls).not.toContain("fanout-synthesis");
      expect(operations.finalAnswers).toEqual([
        { status: "failed", code: "context_plan_unfit", retryable: false },
      ]);
      expect(operations.calls.at(-1)).toBe("finalize:failed");
    } finally {
      await api.close();
    }
  }, 60_000);

  it("converts only a non-retryable topic AiRuntimeError into the controlled failed union", async () => {
    const api = await createSmithersStorage(aiChatSchemas, { connectionString: databaseUrl! });
    const operations = new NonRetryableTopicAnswerOperations();
    try {
      const workflow = buildAiChatWorkflow(api, { operations, config: workflowConfig });
      const result = await runSmithersWorkflow(workflow, {
        runId: `canonical-ai-chat-topic-nonretryable-${crypto.randomUUID()}`,
        input: { aiRunId: load.aiRunId },
        logDir: null,
        resume: false,
      });
      expect(result.status).toBe("finished");
      expect(operations.topicAttempts).toBe(1);
      expect(operations.calls).not.toContain("fanout-synthesis");
      expect(operations.finalAnswers).toEqual([
        { status: "failed", code: "topic_answer_failed", retryable: false },
      ]);
    } finally {
      await api.close();
    }
  }, 60_000);

  it("rethrows retryable topic AiRuntimeError values for Smithers bounded retries", async () => {
    const api = await createSmithersStorage(aiChatSchemas, { connectionString: databaseUrl! });
    const operations = new RetryableTopicAnswerOperations();
    try {
      const workflow = buildAiChatWorkflow(api, { operations, config: workflowConfig });
      const result = await runSmithersWorkflow(workflow, {
        runId: `canonical-ai-chat-topic-retryable-${crypto.randomUUID()}`,
        input: { aiRunId: load.aiRunId },
        logDir: null,
        resume: false,
      });
      expect(result.status).toBe("finished");
      expect(operations.topicAttempts).toBe(3);
      expect(operations.calls).toContain("fanout-synthesis");
      expect(operations.calls.at(-1)).toBe("finalize:synthesis");
    } finally {
      await api.close();
    }
  }, 60_000);

  it("rethrows AbortError from a topic answer without fabricating a partial packet", async () => {
    const api = await createSmithersStorage(aiChatSchemas, { connectionString: databaseUrl! });
    const operations = new AbortedTopicAnswerOperations();
    try {
      const workflow = buildAiChatWorkflow(api, { operations, config: workflowConfig });
      const result = await runSmithersWorkflow(workflow, {
        runId: `canonical-ai-chat-topic-abort-${crypto.randomUUID()}`,
        input: { aiRunId: load.aiRunId },
        logDir: null,
        resume: false,
      });
      expect(result.status).toBe("cancelled");
      expect(operations.topicAttempts).toBe(1);
      expect(operations.calls).not.toContain("fanout-synthesis");
      expect(operations.finalAnswers).toEqual([]);
    } finally {
      await api.close();
    }
  }, 60_000);

  it("routes a failed synthesis measurement without mounting or streaming synthesis", async () => {
    const api = await createSmithersStorage(aiChatSchemas, { connectionString: databaseUrl! });
    const operations = new SynthesisMismatchOperations();
    try {
      const workflow = buildAiChatWorkflow(api, { operations, config: workflowConfig });
      const result = await runSmithersWorkflow(workflow, {
        runId: `canonical-ai-chat-synthesis-mismatch-${crypto.randomUUID()}`,
        input: { aiRunId: load.aiRunId },
        logDir: null,
        resume: false,
      });
      expect(result.status).toBe("finished");
      expect(operations.calls.filter((call) => call === "fanout-synthesis-measure")).toHaveLength(
        1,
      );
      expect(operations.calls).not.toContain("fanout-synthesis");
      expect(operations.streamedTaskIds).toEqual([]);
      expect(operations.finalAnswers).toEqual([
        { status: "failed", code: "synthesis_budget_mismatch", retryable: false },
      ]);
      expect(operations.calls.at(-1)).toBe("finalize:failed");
    } finally {
      await api.close();
    }
  }, 60_000);

  it.each([
    "context_plan_unfit",
    "context_mandatory_too_large",
    "context_budget_mismatch",
  ] as const)(
    "propagates typed synthesis context failure %s through the fanout failure branch",
    async (failureCode) => {
      const api = await createSmithersStorage(aiChatSchemas, { connectionString: databaseUrl! });
      const operations = new TypedSynthesisFailureOperations(failureCode);
      try {
        const workflow = buildAiChatWorkflow(api, { operations, config: workflowConfig });
        const result = await runSmithersWorkflow(workflow, {
          runId: `canonical-ai-chat-synthesis-${failureCode}-${crypto.randomUUID()}`,
          input: { aiRunId: load.aiRunId },
          logDir: null,
          resume: false,
        });
        expect(result.status).toBe("finished");
        expect(operations.calls).not.toContain("fanout-synthesis");
        expect(operations.finalAnswers).toEqual([
          { status: "failed", code: failureCode, retryable: false },
        ]);
        expect(operations.calls.at(-1)).toBe("finalize:failed");
      } finally {
        await api.close();
      }
    },
    60_000,
  );

  it("starts memory and answer concurrently and never finalizes before both lanes join", async () => {
    const api = await createSmithersStorage(aiChatSchemas, { connectionString: databaseUrl! });
    const operations = new ParallelJoinOperations();
    try {
      const workflow = buildAiChatWorkflow(api, {
        operations,
        config: {
          aiFastTaskTimeoutMs: 30_000,
          aiAnswerTimeoutMs: 30_000,
          aiTopicResearchMaxConcurrency: 6,
          aiTopicAnswerMaxConcurrency: 3,
        },
      });
      const pending = runSmithersWorkflow(workflow, {
        runId: `canonical-ai-chat-parallel-join-${crypto.randomUUID()}`,
        input: { aiRunId: load.aiRunId },
        logDir: null,
        resume: false,
      });
      await Promise.all([operations.memoryStarted, operations.answerStarted]);
      operations.releaseAnswer();
      await Promise.resolve();
      expect(operations.calls).not.toContain("finalize:single");
      operations.releaseMemory();
      await expect(pending).resolves.toMatchObject({ status: "finished" });
      expect(operations.calls.at(-1)).toBe("finalize:single");
    } finally {
      await api.close();
    }
  }, 60_000);

  it.each([
    ["single", ["single-retrieve-internal", "single-retrieve-web", "single-select-memories"]],
    [
      "fanout",
      [
        "topic-t1-retrieve-internal",
        "topic-t1-retrieve-web",
        "topic-t1-select-memories",
        "topic-t2-retrieve-internal",
        "topic-t2-retrieve-web",
        "topic-t2-select-memories",
      ],
    ],
  ] as const)(
    "mounts the %s A/B/W selector set as one bounded parallel join",
    async (route, expected) => {
      const api = await createSmithersStorage(aiChatSchemas, { connectionString: databaseUrl! });
      const operations = new SelectorParallelOperations(route);
      let pending: ReturnType<typeof runSmithersWorkflow> | undefined;
      let startDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const workflow = buildAiChatWorkflow(api, {
          operations,
          config: {
            aiFastTaskTimeoutMs: 30_000,
            aiAnswerTimeoutMs: 30_000,
            aiTopicResearchMaxConcurrency: 6,
            aiTopicAnswerMaxConcurrency: 3,
          },
        });
        pending = runSmithersWorkflow(workflow, {
          runId: `canonical-ai-chat-${route}-selector-parallel-${crypto.randomUUID()}`,
          input: { aiRunId: load.aiRunId },
          logDir: null,
          resume: false,
        });
        const allStartedBeforeTimeout = await Promise.race([
          operations.allSelectorsStarted.then(() => true),
          new Promise<false>((resolve) => {
            startDeadline = setTimeout(() => resolve(false), 10_000);
          }),
        ]);
        if (startDeadline !== undefined) clearTimeout(startDeadline);
        expect(allStartedBeforeTimeout).toBe(true);
        expect([...operations.selectorTaskIds].sort()).toEqual([...expected].sort());
        expect([...operations.selectorCallCounts.values()]).toEqual(
          Array.from({ length: expected.length }, () => 1),
        );
        operations.releaseSelectors();
        await expect(pending).resolves.toMatchObject({ status: "finished" });
      } finally {
        if (startDeadline !== undefined) clearTimeout(startDeadline);
        operations.releaseSelectors();
        await pending?.catch(() => undefined);
        await api.close();
      }
    },
    60_000,
  );

  it("runs sibling topic answers in the configured bounded parallel group", async () => {
    const api = await createSmithersStorage(aiChatSchemas, { connectionString: databaseUrl! });
    const operations = new TopicAnswerParallelOperations();
    try {
      const workflow = buildAiChatWorkflow(api, {
        operations,
        config: {
          aiFastTaskTimeoutMs: 30_000,
          aiAnswerTimeoutMs: 30_000,
          aiTopicResearchMaxConcurrency: 6,
          aiTopicAnswerMaxConcurrency: 2,
        },
      });
      const pending = runSmithersWorkflow(workflow, {
        runId: `canonical-ai-chat-topic-answer-parallel-${crypto.randomUUID()}`,
        input: { aiRunId: load.aiRunId },
        logDir: null,
        resume: false,
      });
      await operations.allTopicAnswersStarted;
      expect([...operations.topicAnswerTaskIds].sort()).toEqual([
        "topic-t1-answer",
        "topic-t2-answer",
      ]);
      operations.releaseTopicAnswers();
      await expect(pending).resolves.toMatchObject({ status: "finished" });
      expect(operations.calls.at(-1)).toBe("finalize:synthesis");
    } finally {
      await api.close();
    }
  }, 60_000);

  it("uses one initial answer attempt plus exactly two bounded retries", async () => {
    const api = await createSmithersStorage(aiChatSchemas, { connectionString: databaseUrl! });
    const operations = new RetryingAnswerOperations(2);
    try {
      const workflow = buildAiChatWorkflow(api, {
        operations,
        config: {
          aiFastTaskTimeoutMs: 30_000,
          aiAnswerTimeoutMs: 30_000,
          aiTopicResearchMaxConcurrency: 6,
          aiTopicAnswerMaxConcurrency: 3,
        },
      });
      const result = await runSmithersWorkflow(workflow, {
        runId: `canonical-ai-chat-answer-retries-${crypto.randomUUID()}`,
        input: { aiRunId: load.aiRunId },
        logDir: null,
        resume: false,
      });
      expect(result.status).toBe("finished");
      expect(operations.answerAttempts).toBe(3);
      expect(operations.calls.at(-1)).toBe("finalize:single");
    } finally {
      await api.close();
    }
  }, 60_000);

  it("rejects a malformed selected source map at answer-select before finalization", async () => {
    const api = await createSmithersStorage(aiChatSchemas, { connectionString: databaseUrl! });
    const operations = new MalformedSourceMapOperations();
    try {
      const workflow = buildAiChatWorkflow(api, { operations, config: workflowConfig });
      const result = await runSmithersWorkflow(workflow, {
        runId: `canonical-ai-chat-answer-select-source-map-${crypto.randomUUID()}`,
        input: { aiRunId: load.aiRunId },
        logDir: null,
        resume: false,
      });
      expect(result.status).toBe("failed");
      expect(operations.finalAnswers).toEqual([]);
      expect(operations.calls.some((call) => call.startsWith("finalize:"))).toBe(false);
    } finally {
      await api.close();
    }
  }, 60_000);

  it("never finalizes or emits done when memory extraction exhausts its two retries", async () => {
    const api = await createSmithersStorage(aiChatSchemas, { connectionString: databaseUrl! });
    const operations = new FailingMemoryOperations();
    try {
      const workflow = buildAiChatWorkflow(api, {
        operations,
        config: {
          aiFastTaskTimeoutMs: 30_000,
          aiAnswerTimeoutMs: 30_000,
          aiTopicResearchMaxConcurrency: 6,
          aiTopicAnswerMaxConcurrency: 3,
        },
      });
      const result = await runSmithersWorkflow(workflow, {
        runId: `canonical-ai-chat-memory-retries-${crypto.randomUUID()}`,
        input: { aiRunId: load.aiRunId },
        logDir: null,
        resume: false,
      });
      expect(result.status).toBe("failed");
      expect(operations.memoryAttempts).toBe(3);
      expect(operations.calls.some((call) => call.startsWith("finalize:"))).toBe(false);
    } finally {
      await api.close();
    }
  }, 60_000);
});
