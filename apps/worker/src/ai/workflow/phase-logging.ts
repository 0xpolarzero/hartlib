import { MemoryConflictError } from "../product-state/memory";
import {
  type AiRunActivityEvent,
  activityCodeForPhase,
  activityStageForCode,
} from "@hartlib/shared";
import {
  AiRuntimeError,
  aiRunErrorCategoryForCode,
  aiRuntimeDiagnosticMessage,
  aiRuntimeFailureMetadata,
  sanitizeAiRuntimeDiagnosticMessage,
  isAbortError,
  isAiRunErrorCode,
  isAiRuntimeError,
  isRetryableAiRunError,
  type AiRunErrorCode,
} from "../runtime/errors";
import { currentTaskRuntime } from "../runtime/task-cancellation";
import type { CanonicalWorkflowOperations } from "./operations";

export type AiPhaseStatus = "started" | "succeeded" | "failed" | "passed" | "rejected";

export interface AiPhaseLogEntry {
  readonly phase: string;
  readonly status: AiPhaseStatus;
  readonly runId: string;
  readonly occurredAt?: string | undefined;
  readonly taskId?: string | undefined;
  readonly topicId?: "t1" | "t2" | "t3" | undefined;
  readonly model?: "glm-5-turbo" | undefined;
  readonly durationMs?: number | undefined;
  readonly attempt?: number | undefined;
  readonly loopIteration?: number | undefined;
  readonly providerRequestIndex?: number | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly requestedOutputTokens?: number | undefined;
  readonly usableInputTokens?: number | undefined;
  readonly afterInputTokens?: number | undefined;
  readonly itemCount?: number | undefined;
  readonly sourceCount?: number | undefined;
  readonly topicCount?: number | undefined;
  readonly conversationCount?: number | undefined;
  readonly memoryCount?: number | undefined;
  readonly consumerCount?: number | undefined;
  readonly queryCount?: number | undefined;
  readonly branchCount?: number | undefined;
  readonly applicableBranchCount?: number | undefined;
  readonly hitCount?: number | undefined;
  readonly candidateCount?: number | undefined;
  readonly groupCount?: number | undefined;
  readonly passageCount?: number | undefined;
  readonly decisionCount?: number | undefined;
  readonly selectedCount?: number | undefined;
  readonly omittedCount?: number | undefined;
  readonly keepCount?: number | undefined;
  readonly compactCount?: number | undefined;
  readonly omitCount?: number | undefined;
  readonly retainCount?: number | undefined;
  readonly tightenCount?: number | undefined;
  readonly renderedTokenCount?: number | undefined;
  readonly overByTokens?: number | undefined;
  readonly capApplied?: boolean | undefined;
  readonly fallbackRan?: boolean | undefined;
  readonly repairUsed?: boolean | undefined;
  readonly action?:
    | "accept"
    | "replace"
    | "no_evidence"
    | "keep"
    | "compact"
    | "omit"
    | "retain"
    | "tighten"
    | "select"
    | undefined;
  readonly failureStage?:
    | "context_plan_unfit"
    | "context_mandatory_too_large"
    | "synthesis_budget_mismatch"
    | undefined;
  readonly retryable?: boolean | undefined;
  readonly errorCode?: AiRunErrorCode | undefined;
  readonly errorCategory?: AiRunActivityEvent["errorCategory"] | undefined;
  readonly errorMessage?: string | undefined;
  readonly outcome?:
    | "single"
    | "fanout"
    | "continue"
    | "clarify"
    | "ready"
    | "needs_compaction"
    | "ok"
    | "partial"
    | "answered"
    | undefined;
}

export type AiPhaseLogger = (entry: AiPhaseLogEntry) => Promise<void> | void;

export type AiActivityLogger = (
  event: AiRunActivityEvent,
  entry: AiPhaseLogEntry,
) => Promise<void> | void;

const contextPreparationPhases: Record<string, true> = {
  context_compaction_plan: true,
  context_compaction_group: true,
  context_compaction_group_plan: true,
  context_compaction_fallback_group_plan: true,
  context_compaction_collect: true,
  context_compaction_fallback_group: true,
  context_compaction_fallback_collect: true,
  context_compaction_fallback_plan: true,
  context_compaction_measure: true,
  context_compaction_fallback_measure: true,
  context_compaction_final_measure: true,
  context_compaction_select: true,
};
const publicCodeForPhase = (phase: string): AiRunActivityEvent["code"] | undefined => {
  return contextPreparationPhases[phase] === true
    ? "context_preparation"
    : activityCodeForPhase(phase);
};

export const publicActivityFromPhase = (
  entry: AiPhaseLogEntry,
  args: readonly unknown[] = [],
): AiRunActivityEvent | undefined => {
  if (entry.phase === "load_turn" || entry.phase === "answer_stream") return undefined;
  const code = publicCodeForPhase(entry.phase);
  if (code === undefined) return undefined;
  if (entry.phase === "web_retrieval") {
    const scope = record(record(args[0]).acceptanceScope);
    if (scope.webRequested !== true || scope.webEnabled !== true) return undefined;
  }
  if (entry.phase === "memory_selection") {
    const scope = record(record(args[0]).acceptanceScope);
    if (scope.memoryMode !== "private_owner") return undefined;
  }
  const retryable =
    entry.retryable ??
    (entry.errorCode === undefined ? true : isRetryableAiRunError(entry.errorCode));
  const status =
    entry.status === "started"
      ? "running"
      : entry.status === "failed"
        ? retryable
          ? "retrying"
          : "failed"
        : entry.status === "rejected"
          ? "retrying"
          : "complete";
  const errorCategory =
    entry.errorCategory ??
    (entry.errorCode === undefined ? undefined : aiRunErrorCategoryForCode(entry.errorCode));
  const errorMessage =
    errorCategory === undefined
      ? undefined
      : sanitizeAiRuntimeDiagnosticMessage(errorCategory, entry.errorMessage);
  return {
    type: "activity",
    stage: activityStageForCode(code),
    code,
    status,
    ...(entry.topicId === undefined ? {} : { topicId: entry.topicId }),
    ...(entry.runId === undefined ? {} : { runId: entry.runId }),
    ...(entry.occurredAt === undefined ? {} : { occurredAt: entry.occurredAt }),
    ...(entry.attempt === undefined ? {} : { attempt: entry.attempt }),
    ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
    ...(entry.sourceCount === undefined ? {} : { sourceCount: entry.sourceCount }),
    ...(entry.itemCount === undefined ? {} : { resultCount: entry.itemCount }),
    ...(entry.status === "failed" || entry.status === "rejected"
      ? {
          ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
          ...(errorCategory === undefined ? {} : { errorCategory }),
          ...(errorMessage === undefined ? {} : { errorMessage }),
        }
      : {}),
  };
};

/**
 * Runtime allow-list used at the final console boundary. Unknown properties are
 * deliberately discarded so accidental prompts, questions, source, memory,
 * candidate, group, query, provider, or execution-coordinate fields cannot enter
 * local structured logs.
 */
export type AiSafePhaseLogFields = Pick<
  AiPhaseLogEntry,
  | "runId"
  | "occurredAt"
  | "phase"
  | "status"
  | "taskId"
  | "attempt"
  | "loopIteration"
  | "providerRequestIndex"
  | "durationMs"
  | "inputTokens"
  | "outputTokens"
  | "totalTokens"
  | "requestedOutputTokens"
  | "usableInputTokens"
  | "afterInputTokens"
  | "itemCount"
  | "sourceCount"
  | "topicCount"
  | "conversationCount"
  | "memoryCount"
  | "consumerCount"
  | "queryCount"
  | "branchCount"
  | "applicableBranchCount"
  | "hitCount"
  | "candidateCount"
  | "groupCount"
  | "passageCount"
  | "decisionCount"
  | "selectedCount"
  | "omittedCount"
  | "keepCount"
  | "compactCount"
  | "omitCount"
  | "retainCount"
  | "tightenCount"
  | "renderedTokenCount"
  | "overByTokens"
  | "capApplied"
  | "fallbackRan"
  | "repairUsed"
  | "action"
  | "failureStage"
  | "retryable"
  | "errorCode"
  | "errorCategory"
  | "errorMessage"
  | "outcome"
>;

export const safeAiPhaseLogFields = (entry: AiPhaseLogEntry): AiSafePhaseLogFields => {
  const errorCategory =
    entry.errorCategory ??
    (entry.errorCode === undefined ? undefined : aiRunErrorCategoryForCode(entry.errorCode));
  return {
    runId: entry.runId,
    ...(entry.occurredAt === undefined ? {} : { occurredAt: entry.occurredAt }),
    phase: entry.phase,
    status: entry.status,
    ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }),
    ...(entry.attempt === undefined ? {} : { attempt: entry.attempt }),
    ...(entry.loopIteration === undefined ? {} : { loopIteration: entry.loopIteration }),
    ...(entry.providerRequestIndex === undefined
      ? {}
      : { providerRequestIndex: entry.providerRequestIndex }),
    ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
    ...(entry.inputTokens === undefined ? {} : { inputTokens: entry.inputTokens }),
    ...(entry.outputTokens === undefined ? {} : { outputTokens: entry.outputTokens }),
    ...(entry.totalTokens === undefined ? {} : { totalTokens: entry.totalTokens }),
    ...(entry.requestedOutputTokens === undefined
      ? {}
      : { requestedOutputTokens: entry.requestedOutputTokens }),
    ...(entry.usableInputTokens === undefined
      ? {}
      : { usableInputTokens: entry.usableInputTokens }),
    ...(entry.afterInputTokens === undefined ? {} : { afterInputTokens: entry.afterInputTokens }),
    ...(entry.itemCount === undefined ? {} : { itemCount: entry.itemCount }),
    ...(entry.sourceCount === undefined ? {} : { sourceCount: entry.sourceCount }),
    ...(entry.topicCount === undefined ? {} : { topicCount: entry.topicCount }),
    ...(entry.conversationCount === undefined
      ? {}
      : { conversationCount: entry.conversationCount }),
    ...(entry.memoryCount === undefined ? {} : { memoryCount: entry.memoryCount }),
    ...(entry.consumerCount === undefined ? {} : { consumerCount: entry.consumerCount }),
    ...(entry.queryCount === undefined ? {} : { queryCount: entry.queryCount }),
    ...(entry.branchCount === undefined ? {} : { branchCount: entry.branchCount }),
    ...(entry.applicableBranchCount === undefined
      ? {}
      : { applicableBranchCount: entry.applicableBranchCount }),
    ...(entry.hitCount === undefined ? {} : { hitCount: entry.hitCount }),
    ...(entry.candidateCount === undefined ? {} : { candidateCount: entry.candidateCount }),
    ...(entry.groupCount === undefined ? {} : { groupCount: entry.groupCount }),
    ...(entry.passageCount === undefined ? {} : { passageCount: entry.passageCount }),
    ...(entry.decisionCount === undefined ? {} : { decisionCount: entry.decisionCount }),
    ...(entry.selectedCount === undefined ? {} : { selectedCount: entry.selectedCount }),
    ...(entry.omittedCount === undefined ? {} : { omittedCount: entry.omittedCount }),
    ...(entry.keepCount === undefined ? {} : { keepCount: entry.keepCount }),
    ...(entry.compactCount === undefined ? {} : { compactCount: entry.compactCount }),
    ...(entry.retainCount === undefined ? {} : { retainCount: entry.retainCount }),
    ...(entry.omitCount === undefined ? {} : { omitCount: entry.omitCount }),
    ...(entry.tightenCount === undefined ? {} : { tightenCount: entry.tightenCount }),
    ...(entry.renderedTokenCount === undefined
      ? {}
      : { renderedTokenCount: entry.renderedTokenCount }),
    ...(entry.overByTokens === undefined ? {} : { overByTokens: entry.overByTokens }),
    ...(entry.capApplied === undefined ? {} : { capApplied: entry.capApplied }),
    ...(entry.fallbackRan === undefined ? {} : { fallbackRan: entry.fallbackRan }),
    ...(entry.repairUsed === undefined ? {} : { repairUsed: entry.repairUsed }),
    ...(entry.action === undefined ? {} : { action: entry.action }),
    ...(entry.failureStage === undefined ? {} : { failureStage: entry.failureStage }),
    ...(entry.retryable === undefined ? {} : { retryable: entry.retryable }),
    ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
    ...(errorCategory === undefined ? {} : { errorCategory }),
    ...(errorCategory === undefined
      ? {}
      : {
          errorMessage: sanitizeAiRuntimeDiagnosticMessage(errorCategory, entry.errorMessage),
        }),
    ...(entry.outcome === undefined ? {} : { outcome: entry.outcome }),
  };
};

type OperationName =
  | "loadTurn"
  | "planTurn"
  | "extractMemory"
  | "freezeContext"
  | "selectMemories"
  | "retrieveStructuredInternal"
  | "retrieveWeb"
  | "assembleContext"
  | "measureAssembly"
  | "mergeFanoutSources"
  | "createCompactionGroups"
  | "createFallbackCompactionGroups"
  | "answerDirect"
  | "initialCompactionManifest"
  | "compactContextGroup"
  | "collectCompaction"
  | "collectFallbackCompaction"
  | "measureCompaction"
  | "fallbackCompactionManifest"
  | "selectCompactionContext"
  | "clarify"
  | "allocateFanout"
  | "answerTopic"
  | "synthesisContext"
  | "synthesize"
  | "finalize";

interface PhaseRule {
  readonly phase: string | ((args: readonly unknown[]) => string);
  readonly additionalPhases?: readonly string[] | undefined;
  readonly asynchronous: boolean;
  readonly taskId: (args: readonly unknown[]) => string | undefined;
  readonly topicId?: ((args: readonly unknown[]) => "t1" | "t2" | "t3" | undefined) | undefined;
  readonly model: "fast" | "main" | null;
  readonly fallbackErrorCode: AiRunErrorCode;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const stringAt = (args: readonly unknown[], index: number): string | undefined =>
  typeof args[index] === "string" ? args[index] : undefined;

const fixed =
  (value: string): (() => string) =>
  () =>
    value;

const topicFromTask = (taskId: string | undefined): "t1" | "t2" | "t3" | undefined => {
  const topic = /^topic-(t[123])-/u.exec(taskId ?? "")?.[1];
  return topic === "t1" || topic === "t2" || topic === "t3" ? topic : undefined;
};

const topicFrom = (value: unknown): "t1" | "t2" | "t3" | undefined => {
  const candidate = record(value).topicId;
  return candidate === "t1" || candidate === "t2" || candidate === "t3" ? candidate : undefined;
};
const compactionTaskId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  return /(?:^|-)compact-(?:plan|collect|measure|g[0-9]{3})$/u.test(value) ||
    /(?:^|-)fallback-(?:plan|collect|measure|g[0-9]{3})$/u.test(value) ||
    /(?:^|-)context-select$/u.test(value)
    ? value
    : undefined;
};

const compactionTaskIdFrom = (args: readonly unknown[]): string | undefined =>
  args.map(compactionTaskId).find((value): value is string => value !== undefined);

const compactionTopicFrom = (args: readonly unknown[]): "t1" | "t2" | "t3" | undefined => {
  for (const arg of args) {
    const topic = topicFrom(arg) ?? topicFromTask(compactionTaskId(arg));
    if (topic !== undefined) return topic;
  }
  return undefined;
};

const compactionPhaseFrom = (args: readonly unknown[]): "compact" | "fallback" => {
  for (const arg of args) {
    const phase = record(arg).phase;
    if (phase === "fallback") return "fallback";
  }
  return compactionTaskIdFrom(args)?.includes("-fallback-") === true ? "fallback" : "compact";
};

const rules: Record<OperationName, PhaseRule> = {
  loadTurn: {
    phase: "load_turn",
    asynchronous: true,
    taskId: fixed("load-turn"),
    model: null,
    fallbackErrorCode: "finalization_failed",
  },
  planTurn: {
    phase: "plan_turn",
    asynchronous: true,
    taskId: fixed("plan-turn"),
    model: "fast",
    fallbackErrorCode: "plan_turn_failed",
  },
  extractMemory: {
    phase: "memory_extraction",
    asynchronous: true,
    taskId: fixed("memory-extract"),
    model: "fast",
    fallbackErrorCode: "memory_extraction_failed",
  },
  freezeContext: {
    phase: "context_freeze_gate",
    asynchronous: true,
    taskId: (args) => {
      const topicId = topicFrom(args[1]);
      return topicId === undefined ? "single-context-select" : `topic-${topicId}-context-select`;
    },
    topicId: (args) => topicFrom(args[1]),
    model: "main",
    fallbackErrorCode: "context_assembly_failed",
  },
  selectMemories: {
    phase: "memory_selection",
    asynchronous: true,
    taskId: (args) => stringAt(args, 2),
    topicId: (args) => topicFromTask(stringAt(args, 2)),
    model: "fast",
    fallbackErrorCode: "memory_selector_failed",
  },
  retrieveStructuredInternal: {
    phase: "internal_retrieval",
    asynchronous: true,
    taskId: (args) => stringAt(args, 2),
    topicId: (args) => topicFromTask(stringAt(args, 2)),
    model: "fast",
    fallbackErrorCode: "internal_retrieval_failed",
  },
  retrieveWeb: {
    phase: "web_retrieval",
    asynchronous: true,
    taskId: (args) => stringAt(args, 2),
    topicId: (args) => topicFromTask(stringAt(args, 2)),
    model: "fast",
    fallbackErrorCode: "web_research_failed",
  },
  assembleContext: {
    phase: "context_assembly",
    asynchronous: true,
    taskId: (args) => stringAt(args, 3),
    topicId: (args) => topicFrom(args[5]) ?? topicFromTask(stringAt(args, 3)),
    model: null,
    fallbackErrorCode: "context_assembly_failed",
  },
  measureAssembly: {
    phase: "context_measurement_exact_gate",
    asynchronous: true,
    taskId: (args) => stringAt(args, 2),
    topicId: (args) => topicFrom(args[1]) ?? topicFromTask(stringAt(args, 2)),
    model: "main",
    fallbackErrorCode: "context_assembly_failed",
  },
  mergeFanoutSources: {
    phase: "fanout_source_merge",
    asynchronous: true,
    taskId: fixed("fanout-merge-sources"),
    model: null,
    fallbackErrorCode: "context_assembly_failed",
  },
  createCompactionGroups: {
    phase: "context_compaction_group_plan",
    asynchronous: true,
    taskId: compactionTaskIdFrom,
    topicId: compactionTopicFrom,
    model: null,
    fallbackErrorCode: "context_compaction_failed",
  },
  createFallbackCompactionGroups: {
    phase: "context_compaction_fallback_group_plan",
    asynchronous: true,
    taskId: compactionTaskIdFrom,
    topicId: compactionTopicFrom,
    model: null,
    fallbackErrorCode: "context_compaction_failed",
  },
  initialCompactionManifest: {
    phase: "context_compaction_plan",
    asynchronous: true,
    taskId: compactionTaskIdFrom,
    topicId: compactionTopicFrom,
    model: "fast",
    fallbackErrorCode: "context_compaction_failed",
  },
  compactContextGroup: {
    phase: (args) =>
      compactionPhaseFrom(args) === "fallback"
        ? "context_compaction_fallback_group"
        : "context_compaction_group",
    asynchronous: true,
    taskId: compactionTaskIdFrom,
    topicId: compactionTopicFrom,
    model: "fast",
    fallbackErrorCode: "context_compaction_failed",
  },
  collectCompaction: {
    phase: "context_compaction_collect",
    asynchronous: true,
    taskId: compactionTaskIdFrom,
    topicId: compactionTopicFrom,
    model: null,
    fallbackErrorCode: "context_compaction_failed",
  },
  collectFallbackCompaction: {
    phase: "context_compaction_fallback_collect",
    asynchronous: true,
    taskId: compactionTaskIdFrom,
    topicId: compactionTopicFrom,
    model: null,
    fallbackErrorCode: "context_compaction_failed",
  },
  measureCompaction: {
    phase: (args) =>
      compactionPhaseFrom(args) === "fallback"
        ? "context_compaction_fallback_measure"
        : "context_compaction_measure",
    asynchronous: true,
    taskId: compactionTaskIdFrom,
    topicId: compactionTopicFrom,
    model: null,
    fallbackErrorCode: "context_compaction_failed",
  },
  fallbackCompactionManifest: {
    phase: "context_compaction_fallback_plan",
    asynchronous: true,
    taskId: compactionTaskIdFrom,
    topicId: compactionTopicFrom,
    model: "fast",
    fallbackErrorCode: "context_compaction_failed",
  },
  selectCompactionContext: {
    phase: "context_compaction_select",
    asynchronous: true,
    taskId: compactionTaskIdFrom,
    topicId: compactionTopicFrom,
    model: null,
    fallbackErrorCode: "context_compaction_failed",
  },
  answerDirect: {
    phase: "direct_answer_call",
    additionalPhases: ["answer_stream"],
    asynchronous: true,
    taskId: (args) => stringAt(args, 2),
    model: "main",
    fallbackErrorCode: "answer_failed",
  },
  clarify: {
    phase: "clarification",
    additionalPhases: ["answer_stream"],
    asynchronous: true,
    taskId: fixed("clarify"),
    model: null,
    fallbackErrorCode: "plan_turn_failed",
  },
  allocateFanout: {
    phase: "fanout_allocation_exact_gate",
    asynchronous: true,
    taskId: fixed("fanout-allocate"),
    model: "main",
    fallbackErrorCode: "synthesis_budget_mismatch",
  },
  answerTopic: {
    phase: "topic_answer_call",
    asynchronous: true,
    taskId: (args) => stringAt(args, 2),
    topicId: (args) => topicFrom(args[1]) ?? topicFromTask(stringAt(args, 2)),
    model: "main",
    fallbackErrorCode: "topic_answer_failed",
  },
  synthesisContext: {
    phase: "synthesis_assembly_exact_gate",
    asynchronous: true,
    taskId: fixed("fanout-synthesis-measure"),
    model: "main",
    fallbackErrorCode: "synthesis_budget_mismatch",
  },
  synthesize: {
    phase: "synthesis_call",
    additionalPhases: ["answer_stream"],
    asynchronous: true,
    taskId: (args) => stringAt(args, 2),
    model: "main",
    fallbackErrorCode: "synthesis_failed",
  },
  finalize: {
    phase: "finalization",
    asynchronous: true,
    taskId: fixed("finalize"),
    model: null,
    fallbackErrorCode: "finalization_failed",
  },
};

const operationNames: Record<OperationName, true> = {
  loadTurn: true,
  planTurn: true,
  extractMemory: true,
  freezeContext: true,
  selectMemories: true,
  retrieveStructuredInternal: true,
  retrieveWeb: true,
  assembleContext: true,
  measureAssembly: true,
  mergeFanoutSources: true,
  createCompactionGroups: true,
  createFallbackCompactionGroups: true,
  initialCompactionManifest: true,
  compactContextGroup: true,
  collectCompaction: true,
  collectFallbackCompaction: true,
  measureCompaction: true,
  fallbackCompactionManifest: true,
  selectCompactionContext: true,
  answerDirect: true,
  clarify: true,
  allocateFanout: true,
  answerTopic: true,
  synthesisContext: true,
  synthesize: true,
  finalize: true,
};

const isOperationName = (value: string): value is OperationName =>
  Object.prototype.hasOwnProperty.call(operationNames, value);

const runIdFor = (name: OperationName, args: readonly unknown[]): string => {
  if (name === "loadTurn") return stringAt(args, 0) ?? "unknown";
  const aiRunId = record(args[0]).aiRunId;
  return typeof aiRunId === "string" ? aiRunId : "unknown";
};

const safeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

type PhaseOutcome = NonNullable<AiPhaseLogEntry["outcome"]>;

const phaseOutcome = (value: unknown): PhaseOutcome | undefined => {
  switch (value) {
    case "single":
    case "fanout":
    case "continue":
    case "clarify":
    case "ready":
    case "needs_compaction":
    case "ok":
    case "partial":
    case "answered":
      return value;
    default:
      return undefined;
  }
};

type PhaseAction = NonNullable<AiPhaseLogEntry["action"]>;

const phaseAction = (value: unknown): PhaseAction | undefined => {
  switch (value) {
    case "accept":
    case "replace":
    case "no_evidence":
    case "keep":
    case "compact":
    case "omit":
    case "retain":
    case "tighten":
    case "select":
      return value;
    default:
      return undefined;
  }
};

const phaseFailureStage = (
  value: unknown,
): NonNullable<AiPhaseLogEntry["failureStage"]> | undefined => {
  switch (value) {
    case "context_plan_unfit":
    case "context_mandatory_too_large":
    case "synthesis_budget_mismatch":
      return value;
    default:
      return undefined;
  }
};

const safeBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;
const resultFields = (value: unknown): Partial<AiPhaseLogEntry> => {
  const result = record(value);
  const manifestValue = record(result.manifest);
  const manifest = Object.keys(manifestValue).length === 0 ? result : manifestValue;
  const measurement = record(result.measurement);
  const fallbackManifestValue = record(result.fallbackManifest);
  const fallbackManifest =
    Object.keys(fallbackManifestValue).length === 0 ? result : fallbackManifestValue;
  const context = record(result.context);
  const fused = record(result.fused);
  const queryPlan = record(result.queryPlan);
  const coverage = Array.isArray(fused.coverage) ? fused.coverage : undefined;
  const queryCountFromPlan = Array.isArray(queryPlan.queries)
    ? queryPlan.queries.length
    : undefined;
  const branchCountFromCoverage = coverage?.length;
  const applicableBranchCountFromCoverage = coverage?.filter(
    (branch) => record(branch).status === "applicable",
  ).length;
  const hitCountFromCoverage = coverage?.reduce(
    (count, branch) => count + (safeNumber(record(branch).hitCount) ?? 0),
    0,
  );
  const candidateCountBeforeCap = safeNumber(fused.candidateCountBeforeCap);
  const fusedCandidateCount = Array.isArray(fused.results) ? fused.results.length : undefined;
  const truncation = record(fused.truncation);
  const fusionCapApplied =
    safeBoolean(truncation.branch) === true ||
    safeBoolean(truncation.candidates) === true ||
    safeBoolean(truncation.hydration) === true;
  const outcome =
    phaseOutcome(result.status) ??
    phaseOutcome(result.mode) ??
    phaseOutcome(measurement.status) ??
    phaseOutcome(context.status);
  const itemCount = Array.isArray(value)
    ? value.length
    : Array.isArray(result.entries)
      ? result.entries.length
      : Array.isArray(fused.results)
        ? fused.results.length
        : undefined;
  const decisions = Array.isArray(result.decisions)
    ? result.decisions
    : Array.isArray(manifest.decisions)
      ? manifest.decisions
      : Array.isArray(fallbackManifest.decisions)
        ? fallbackManifest.decisions
        : undefined;
  const groups = Array.isArray(result.groups)
    ? result.groups
    : Array.isArray(manifest.groups)
      ? manifest.groups
      : Array.isArray(fallbackManifest.groups)
        ? fallbackManifest.groups
        : undefined;
  const groupResult = record(result.result);
  const groupDecisions = Array.isArray(groupResult.decisions) ? groupResult.decisions : undefined;
  const decisionCountFor = (key: string): number | undefined => {
    const action = key.endsWith("Count") ? key.slice(0, -5) : key;
    const source = groupDecisions ?? decisions;
    return source === undefined
      ? undefined
      : source.filter((decision) => record(decision).action === action).length;
  };
  const groupSelectedCount = decisionCountFor("select");
  const groupOmittedCount = decisionCountFor("omit");
  const groupPassageCount =
    groupDecisions?.reduce((count, decision) => {
      const passageIds = record(decision).passageIds;
      return count + (Array.isArray(passageIds) ? passageIds.length : 0);
    }, 0) ?? undefined;
  const numberFrom = (key: string): number | undefined =>
    safeNumber(result[key]) ?? safeNumber(measurement[key]) ?? safeNumber(context[key]);
  const actionCountFrom = (key: string): number | undefined => decisionCountFor(key);
  const inputTokens = numberFrom("inputTokens");
  const usableInputTokens = numberFrom("usableInputTokens");
  const overByTokens = numberFrom("overByTokens");
  const afterInputTokens = numberFrom("afterInputTokens");
  const action =
    phaseAction(result.action) ??
    phaseAction(record(result.review).action) ??
    phaseAction(record(result.queryReview).action);
  const failureCode = result.failureCode ?? result.code;
  const failureStage = phaseFailureStage(failureCode);
  const resultError =
    typeof failureCode === "string" && isAiRunErrorCode(failureCode) ? failureCode : undefined;
  const resultRetryable = safeBoolean(result.retryable);
  const capApplied = safeBoolean(result.capApplied) ?? (fusionCapApplied ? true : undefined);
  const fallbackRan = safeBoolean(result.fallbackRan);
  const repairUsed = safeBoolean(result.repairUsed);
  return {
    ...(itemCount === undefined ? {} : { itemCount }),
    ...(Array.isArray(result.proposals) ? { memoryCount: result.proposals.length } : {}),
    ...(Array.isArray(result.sourceMap) ? { sourceCount: result.sourceMap.length } : {}),
    ...(Array.isArray(result.topics) ? { topicCount: result.topics.length } : {}),
    ...(Array.isArray(result.conversation)
      ? { conversationCount: result.conversation.length }
      : {}),
    ...(Array.isArray(result.memories) ? { memoryCount: result.memories.length } : {}),
    ...(Array.isArray(result.consumers) ? { consumerCount: result.consumers.length } : {}),
    ...((safeNumber(result.queryCount) ?? queryCountFromPlan) === undefined
      ? {}
      : { queryCount: safeNumber(result.queryCount) ?? queryCountFromPlan }),
    ...((safeNumber(result.branchCount) ?? branchCountFromCoverage) === undefined
      ? {}
      : { branchCount: safeNumber(result.branchCount) ?? branchCountFromCoverage }),
    ...((safeNumber(result.applicableBranchCount) ?? applicableBranchCountFromCoverage) ===
    undefined
      ? {}
      : {
          applicableBranchCount:
            safeNumber(result.applicableBranchCount) ?? applicableBranchCountFromCoverage,
        }),
    ...((safeNumber(result.hitCount) ?? hitCountFromCoverage) === undefined
      ? {}
      : { hitCount: safeNumber(result.hitCount) ?? hitCountFromCoverage }),
    ...((safeNumber(result.candidateCount) ?? candidateCountBeforeCap ?? fusedCandidateCount) ===
      undefined && decisions === undefined
      ? {}
      : {
          candidateCount:
            safeNumber(result.candidateCount) ??
            candidateCountBeforeCap ??
            fusedCandidateCount ??
            decisions?.length,
        }),
    ...(safeNumber(result.groupCount) === undefined && groups === undefined
      ? {}
      : { groupCount: safeNumber(result.groupCount) ?? groups?.length }),
    ...(safeNumber(result.passageCount) === undefined && groupPassageCount === undefined
      ? {}
      : { passageCount: safeNumber(result.passageCount) ?? groupPassageCount }),
    ...(safeNumber(result.decisionCount) === undefined && decisions === undefined
      ? {}
      : { decisionCount: safeNumber(result.decisionCount) ?? decisions?.length }),
    ...(safeNumber(result.selectedCount) === undefined && groupSelectedCount === undefined
      ? {}
      : { selectedCount: safeNumber(result.selectedCount) ?? groupSelectedCount }),
    ...(safeNumber(result.omittedCount) === undefined && groupOmittedCount === undefined
      ? {}
      : { omittedCount: safeNumber(result.omittedCount) ?? groupOmittedCount }),
    ...(actionCountFrom("keepCount") === undefined
      ? {}
      : { keepCount: actionCountFrom("keepCount") }),
    ...(actionCountFrom("compactCount") === undefined
      ? {}
      : { compactCount: actionCountFrom("compactCount") }),
    ...(actionCountFrom("omitCount") === undefined
      ? {}
      : { omitCount: actionCountFrom("omitCount") }),
    ...(actionCountFrom("retainCount") === undefined
      ? {}
      : { retainCount: actionCountFrom("retainCount") }),
    ...(actionCountFrom("tightenCount") === undefined
      ? {}
      : { tightenCount: actionCountFrom("tightenCount") }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(afterInputTokens === undefined ? {} : { afterInputTokens }),
    ...(usableInputTokens === undefined ? {} : { usableInputTokens }),
    ...(overByTokens === undefined ? {} : { overByTokens }),
    ...(safeNumber(result.renderedTokenCount) === undefined
      ? {}
      : { renderedTokenCount: safeNumber(result.renderedTokenCount) }),
    ...(capApplied === undefined ? {} : { capApplied }),
    ...(fallbackRan === undefined ? {} : { fallbackRan }),
    ...(repairUsed === undefined ? {} : { repairUsed }),
    ...(resultError === undefined ? {} : { errorCode: resultError }),
    ...(action === undefined ? {} : { action }),
    ...(failureStage === undefined ? {} : { failureStage }),
    ...(resultRetryable === undefined ? {} : { retryable: resultRetryable }),
    ...(outcome === undefined ? {} : { outcome }),
  };
};

const errorCodeFor = (error: unknown, fallback: AiRunErrorCode): AiRunErrorCode =>
  isAiRuntimeError(error) ? error.code : fallback;
const resultErrorCode = (value: unknown, fallback: AiRunErrorCode): AiRunErrorCode => {
  const code = record(value).failureCode ?? record(value).code;
  return typeof code === "string" && isAiRunErrorCode(code) ? code : fallback;
};

const diagnosticFieldsForCode = (code: AiRunErrorCode) => {
  const category = aiRunErrorCategoryForCode(code);
  return {
    errorCategory: category,
    errorMessage: aiRuntimeDiagnosticMessage(category, null),
  } as const;
};

const diagnosticFieldsForFailure = (error: unknown, fallback: AiRunErrorCode) => {
  const metadata = aiRuntimeFailureMetadata(error);
  if (metadata !== undefined) {
    return {
      errorCategory: metadata.category,
      errorMessage: sanitizeAiRuntimeDiagnosticMessage(metadata.category, metadata.message),
    } as const;
  }
  return diagnosticFieldsForCode(fallback);
};

const durableOperationFailure = (error: unknown, fallback: AiRunErrorCode): Error => {
  if (isAbortError(error) || isAiRuntimeError(error)) return error;
  if (
    error instanceof MemoryConflictError ||
    (error instanceof Error && error.name === "MemoryConflictError")
  ) {
    return new AiRuntimeError("memory_conflict", "memory head changed during finalization");
  }
  return new AiRuntimeError(fallback, "workflow operation failed");
};

export const withAiPhaseLogging = (
  operations: CanonicalWorkflowOperations,
  options: {
    readonly logger: AiPhaseLogger;
    readonly activityLogger?: AiActivityLogger | undefined;
    readonly fastModel: "glm-5-turbo";
    readonly mainModel: "glm-5-turbo";
    readonly now?: (() => number) | undefined;
  },
): CanonicalWorkflowOperations => {
  const now = options.now ?? Date.now;
  return new Proxy(operations, {
    get(target, property, receiver) {
      const original = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || !isOperationName(property)) {
        return typeof original === "function" ? original.bind(target) : original;
      }
      const name = property;
      const rule = rules[name];
      if (typeof original !== "function") return original;
      const invoke = (...args: readonly unknown[]): unknown =>
        Reflect.apply(original, target, args);
      return (...args: readonly unknown[]): unknown => {
        const startedAt = now();
        const runtime = currentTaskRuntime();
        const common = {
          runId: runIdFor(name, args),
          ...(rule.taskId(args) === undefined ? {} : { taskId: rule.taskId(args) }),
          ...(rule.topicId?.(args) === undefined ? {} : { topicId: rule.topicId(args) }),
          ...(runtime === undefined ? {} : { attempt: runtime.attempt }),
          ...(rule.model === null
            ? {}
            : { model: rule.model === "fast" ? options.fastModel : options.mainModel }),
        };
        const primaryPhase = typeof rule.phase === "function" ? rule.phase(args) : rule.phase;
        const phases = [primaryPhase, ...(rule.additionalPhases ?? [])];
        const fallbackOperation =
          name === "collectFallbackCompaction" ||
          (name === "measureCompaction" && compactionPhaseFrom(args) === "fallback");
        const emit = (entry: Omit<AiPhaseLogEntry, "phase">, includePublicActivity = true) =>
          Promise.all(
            phases.map((phase) => {
              const phaseEntry = {
                phase,
                ...entry,
                occurredAt: entry.occurredAt ?? new Date(now()).toISOString(),
              };
              const publicActivity = includePublicActivity
                ? publicActivityFromPhase(phaseEntry, args)
                : undefined;
              return Promise.all([
                options.logger(phaseEntry),
                ...(options.activityLogger === undefined || publicActivity === undefined
                  ? []
                  : [options.activityLogger(publicActivity, phaseEntry)]),
              ]);
            }),
          ).then(() => undefined);
        if (rule.asynchronous) {
          return (async () => {
            await emit({ ...common, status: "started" });
            try {
              const result = await invoke(...args);
              if (record(result).status === "failed") {
                await emit({
                  ...common,
                  ...resultFields(result),
                  ...(fallbackOperation ? { fallbackRan: true } : {}),
                  status: "failed",
                  durationMs: Math.max(0, now() - startedAt),
                  errorCode: resultErrorCode(result, rule.fallbackErrorCode),
                  ...diagnosticFieldsForCode(resultErrorCode(result, rule.fallbackErrorCode)),
                });
                return result;
              }
              await emit(
                {
                  ...common,
                  ...resultFields(result),
                  ...(fallbackOperation ? { fallbackRan: true } : {}),
                  status: "succeeded",
                  durationMs: Math.max(0, now() - startedAt),
                },
                name !== "finalize",
              );
              return result;
            } catch (error) {
              const durableError = durableOperationFailure(error, rule.fallbackErrorCode);
              await emit({
                ...common,
                status: "failed",
                durationMs: Math.max(0, now() - startedAt),
                ...(isAiRuntimeError(durableError) ? { retryable: durableError.retryable } : {}),
                errorCode: errorCodeFor(durableError, rule.fallbackErrorCode),
                ...diagnosticFieldsForFailure(durableError, rule.fallbackErrorCode),
              });
              throw durableError;
            }
          })();
        }
        void emit({ ...common, status: "started" });
        try {
          const result = invoke(...args);
          void emit(
            {
              ...common,
              ...resultFields(result),
              ...(fallbackOperation ? { fallbackRan: true } : {}),
              status: "succeeded",
              durationMs: Math.max(0, now() - startedAt),
            },
            name !== "finalize" &&
              !(
                (name === "answerDirect" || name === "answerTopic" || name === "synthesize") &&
                record(result).status === "failed"
              ),
          );
          return result;
        } catch (error) {
          const durableError = durableOperationFailure(error, rule.fallbackErrorCode);
          void emit({
            ...common,
            status: "failed",
            durationMs: Math.max(0, now() - startedAt),
            errorCode: errorCodeFor(durableError, rule.fallbackErrorCode),
            ...(isAiRuntimeError(durableError) ? { retryable: durableError.retryable } : {}),
            ...diagnosticFieldsForFailure(durableError, rule.fallbackErrorCode),
          });
          throw durableError;
        }
      };
    },
  });
};
