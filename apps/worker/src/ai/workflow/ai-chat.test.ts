import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { Effect as Effect3 } from "effect3";
import { SmithersDb } from "smithers-orchestrator";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate";
import type { CanonicalAgentClient } from "../runtime/agent-client";
import { AiRuntimeError } from "../runtime/errors";
import type {
  AnswerLaneResult,
  FinalSourceRecord,
  PlanTurnResult,
  MemoryExtractionArtifact,
  TopicPacket,
} from "../runtime/types";
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
import {
  CanonicalWorkflowOperations,
  type ContextAssembly,
  type ContextReductionPlan,
  type ContextState,
  type FanoutAllocation,
  type FanoutSourceKeySet,
  type LoadedTurn,
  type MemorySelectorResult,
  type SelectorBundle,
  type WebSelectorResult,
} from "./operations";

const sourceDatabaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const databaseName = `brief_ai_chat_graph_test_${process.pid}_${crypto
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
  aiContextReductionMaxIterations: 2,
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
          applicationName: "brief-ai-chat-graph-test",
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
): Promise<SmithersFrameElement> => {
  const frames = await Effect3.runPromise(new SmithersDb(storage.db).listFrames(runId, 500));
  const frame = frames.find((candidate) => candidate.xmlJson.includes("fanout-topic-research"));
  if (frame === undefined) throw new Error(`missing fanout keyframe for ${runId}`);
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
  memoryMode: "disabled",
  webRequested: false,
  acceptanceScope: {
    userId: "workflow-user",
    chatId: "00000000-0000-4000-8000-000000000001",
    companyId: "00000000-0000-4000-8000-000000000002",
    subscriptionIds: [],
    accessIds: [],
    publicSourceIds: [],
    memoryMode: "disabled",
    memoryRevisionIds: [],
    webRequested: false,
    webEnabled: false,
    provider: "zai_coding_plan_official",
    fastModelId: "glm-5-turbo",
    mainModelId: "glm-5-turbo",
    webTransportProvider: null,
    allowedDomains: null,
  },
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
  reductionFeedback: [],
  request,
  inputTokens: 4,
  usableInputTokens: 100,
  reductionRan: false,
});
const assembly = (topicId?: "t1" | "t2" | "t3"): ContextAssembly => ({
  question: topicId ?? "single",
  ...(topicId === undefined ? {} : { topicId }),
  candidates: [],
  sourceMap: [],
  selectedConversation: [],
  gaps: [],
  consumerTaskId: topicId === undefined ? "single-answer" : `topic-${topicId}-answer`,
  requestedOutputTokens: 32,
});

class ScriptedOperations extends CanonicalWorkflowOperations {
  readonly calls: string[] = [];
  readonly finalAnswers: AnswerLaneResult[] = [];
  readonly reductionFeedbackInputs: (readonly string[])[] = [];
  readonly streamedTaskIds: string[] = [];
  readonly structuredTopicTaskIds: string[] = [];
  private reductionMeasurements = 0;

  constructor(
    readonly route: "clarify" | "single" | "fanout",
    readonly reduction: "none" | "fit" | "correct-then-fit" | "unfit" = "none",
    readonly topicFailure: "context_plan_unfit" | undefined = undefined,
  ) {
    super(
      "postgres://unused",
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 16_384,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 16_384,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 8,
        aiInternalMaxInspections: 8,
        aiWebMaxSearches: 4,
        aiWebMaxFetches: 8,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
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
  override async retrieveInternal(
    _load: LoadedTurn,
    _question: string,
    taskId: string,
    _selectedTurnIds?: readonly string[],
  ) {
    this.calls.push(taskId);
    return [];
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
    _selectors: SelectorBundle,
    observationTaskId: string,
    _consumerTaskId: string,
    topicId?: "t1" | "t2" | "t3",
    _selectedTurnIds?: readonly string[],
    _fanoutSourceKeys?: FanoutSourceKeySet,
    _requestedOutputTokens?: number,
  ) {
    this.calls.push(observationTaskId);
    return assembly(topicId);
  }
  override async measureAssembly(
    _load: LoadedTurn,
    value: ContextAssembly,
    observationTaskId: string,
  ) {
    this.calls.push(observationTaskId);
    return this.reduction === "none" || value.topicId !== undefined
      ? context(value.topicId)
      : {
          ...context(),
          status: "needs_reduction" as const,
          inputTokens: 101,
          usableInputTokens: 100,
        };
  }
  override async planReduction(
    _load: LoadedTurn,
    state: ContextState,
  ): Promise<ContextReductionPlan> {
    this.calls.push("single-reduce-plan");
    this.reductionFeedbackInputs.push(state.reductionFeedback);
    return { decisions: [] };
  }
  override async measureReduction(_load: LoadedTurn, state: ContextState): Promise<ContextState> {
    this.calls.push("single-reduce-measure");
    this.reductionMeasurements += 1;
    if (
      this.reduction === "fit" ||
      (this.reduction === "correct-then-fit" && this.reductionMeasurements > 1)
    ) {
      return {
        ...state,
        status: "ready",
        inputTokens: 90,
        reductionRan: true,
        reductionFeedback: [],
      };
    }
    return {
      ...state,
      status: "needs_reduction",
      reductionRan: true,
      reductionFeedback:
        this.reduction === "correct-then-fit"
          ? ["complete accounting is required"]
          : ["validated plan remains oversized"],
    };
  }
  override async freezeContext(_load: LoadedTurn, state: ContextState) {
    this.calls.push(
      state.topicId === undefined
        ? "single-context-select"
        : `topic-${state.topicId}-context-select`,
    );
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
  ) {
    this.calls.push("fanout-synthesis-measure");
    return packets.length === 0
      ? {
          ...context(),
          status: "failed" as const,
          failureCode: "synthesis_budget_mismatch" as const,
        }
      : context();
  }
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

  override async retrieveInternal(
    _load: LoadedTurn,
    _question: string,
    taskId: string,
  ): Promise<[]> {
    await this.selector(taskId);
    return [];
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

  override async retrieveInternal(
    loaded: LoadedTurn,
    question: string,
    taskId: string,
    selectedTurnIds?: readonly string[],
  ): Promise<never[]> {
    return this.checkpoint === "after-plan"
      ? this.blockAtCheckpoint<never[]>(taskId)
      : super.retrieveInternal(loaded, question, taskId, selectedTurnIds);
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
      throw new AiRuntimeError("agent_context_budget_exceeded", "topic request cannot fit", {
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
      versionId: "version-1",
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
        webRequested: true,
      },
    });
    expect(parsed.success).toBe(true);
    expect(
      aiChatSchemas.aiChatLoadTurn.safeParse({
        value: {
          ...load,
          webRequested: true,
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
          id: "document:document-1",
          kind: "document" as const,
          rank: 0,
          purpose: "publisher evidence",
          sourceId: "publisher:source-1",
          documentId: "document-1",
          versionId: "version-1",
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
      sourceMap: [
        {
          sourceKey: "k_cn_AAAAAAAAAAAAAAAAAAAAAA_1",
          locator: {
            kind: "document" as const,
            sourceId: "publisher:subscription-1",
            documentId: "document-1",
            versionId: "version-1",
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

  it("accepts namespaced public and publisher internal references without a root source alias", () => {
    const references = [
      {
        kind: "document" as const,
        documentId: "public-document-1",
        versionId: "public-version-1",
        source: { kind: "public" as const, sourceId: "public:e2e-fr-energie" },
        purpose: "public evidence",
      },
      {
        kind: "document" as const,
        documentId: "publisher-document-1",
        versionId: "publisher-version-1",
        source: {
          kind: "publisher" as const,
          sourceId: "publisher:e2e-fr-energie",
          issueId: "issue-1",
          documentId: "publisher-document-1",
        },
        publisherExtractionId: "extraction-1",
        purpose: "publisher evidence",
      },
    ];

    expect(aiChatSchemas.aiChatInternal.safeParse({ value: references }).success).toBe(true);
    expect(
      aiChatSchemas.aiChatInternal.safeParse({
        value: [
          {
            ...references[1]!,
            source: { ...references[1]!.source, documentId: "wrong-document" },
          },
        ],
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
                  and application_name = 'brief-ai-chat-smithers-fence'
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
            aiContextReductionMaxIterations: 2,
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
        const finished = await finishedNodeIds(runId);
        if (route === "single") {
          expect(finished.has("single-answer-route")).toBe(true);
          expect(operations.calls.indexOf("single-assemble")).toBeLessThan(
            operations.calls.indexOf("single-measure"),
          );
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

  it("feeds invalid reduction measurement feedback into the next bounded planning iteration", async () => {
    const api = await createSmithersStorage(aiChatSchemas, { connectionString: databaseUrl! });
    const operations = new ScriptedOperations("single", "correct-then-fit");
    try {
      const workflow = buildAiChatWorkflow(api, {
        operations,
        config: {
          aiFastTaskTimeoutMs: 30_000,
          aiAnswerTimeoutMs: 30_000,
          aiTopicResearchMaxConcurrency: 6,
          aiTopicAnswerMaxConcurrency: 3,
          aiContextReductionMaxIterations: 2,
        },
      });
      const result = await runSmithersWorkflow(workflow, {
        runId: `canonical-ai-chat-reduction-correction-${crypto.randomUUID()}`,
        input: { aiRunId: load.aiRunId },
        logDir: null,
        resume: false,
      });
      expect(result.status).toBe("finished");
      expect(operations.calls.filter((call) => call === "single-reduce-plan")).toHaveLength(2);
      expect(operations.calls.filter((call) => call === "single-reduce-measure")).toHaveLength(2);
      expect(operations.reductionFeedbackInputs).toEqual([[], ["complete accounting is required"]]);
      expect(operations.calls).toContain("single-answer");
      expect(operations.calls.at(-1)).toBe("finalize:single");
    } finally {
      await api.close();
    }
  }, 60_000);

  it("returns controlled context_plan_unfit after exactly two non-convergent iterations", async () => {
    const api = await createSmithersStorage(aiChatSchemas, { connectionString: databaseUrl! });
    const operations = new ScriptedOperations("single", "unfit");
    try {
      const workflow = buildAiChatWorkflow(api, {
        operations,
        config: {
          aiFastTaskTimeoutMs: 30_000,
          aiAnswerTimeoutMs: 30_000,
          aiTopicResearchMaxConcurrency: 6,
          aiTopicAnswerMaxConcurrency: 3,
          aiContextReductionMaxIterations: 2,
        },
      });
      const result = await runSmithersWorkflow(workflow, {
        runId: `canonical-ai-chat-reduction-unfit-${crypto.randomUUID()}`,
        input: { aiRunId: load.aiRunId },
        logDir: null,
        resume: false,
      });
      expect(result.status).toBe("finished");
      expect(operations.calls.filter((call) => call === "single-reduce-plan")).toHaveLength(2);
      expect(operations.calls.filter((call) => call === "single-reduce-measure")).toHaveLength(2);
      expect(operations.calls).not.toContain("single-answer");
      expect(operations.calls.at(-1)).toBe("finalize:failed");
    } finally {
      await api.close();
    }
  }, 60_000);

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
        aiContextReductionMaxIterations: 2,
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
          aiContextReductionMaxIterations: 2,
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
          aiContextReductionMaxIterations: 2,
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
        { status: "failed", code: "context_plan_unfit", retryable: true },
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
        { status: "failed", code: "agent_context_budget_exceeded", retryable: false },
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
          aiContextReductionMaxIterations: 2,
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
            aiContextReductionMaxIterations: 2,
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
          aiContextReductionMaxIterations: 2,
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
          aiContextReductionMaxIterations: 2,
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
          aiContextReductionMaxIterations: 2,
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
