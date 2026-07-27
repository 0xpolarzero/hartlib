import { MemoryConflictError } from "../product-state/memory";
import {
  AiRuntimeError,
  isAbortError,
  isAiRuntimeError,
  type AiRunErrorCode,
} from "../runtime/errors";
import type { CanonicalWorkflowOperations } from "./operations";

export type AiPhaseStatus = "started" | "succeeded" | "failed" | "passed" | "rejected";

export interface AiPhaseLogEntry {
  readonly phase: string;
  readonly status: AiPhaseStatus;
  readonly runId: string;
  readonly taskId?: string | undefined;
  readonly topicId?: "t1" | "t2" | "t3" | undefined;
  readonly model?: "glm-5.2" | "glm-5-turbo" | undefined;
  readonly durationMs?: number | undefined;
  readonly attempt?: number | undefined;
  readonly loopIteration?: number | undefined;
  readonly providerRequestIndex?: number | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly requestedOutputTokens?: number | undefined;
  readonly usableInputTokens?: number | undefined;
  readonly itemCount?: number | undefined;
  readonly sourceCount?: number | undefined;
  readonly topicCount?: number | undefined;
  readonly conversationCount?: number | undefined;
  readonly memoryCount?: number | undefined;
  readonly consumerCount?: number | undefined;
  readonly errorCode?: AiRunErrorCode | undefined;
  readonly outcome?:
    | "single"
    | "fanout"
    | "continue"
    | "clarify"
    | "ready"
    | "needs_reduction"
    | "ok"
    | "partial"
    | "answered"
    | undefined;
}

export type AiPhaseLogger = (entry: AiPhaseLogEntry) => Promise<void> | void;

/**
 * Runtime allow-list used at the final console boundary. Unknown properties are
 * deliberately discarded so accidental prompt, question, source, memory, claim,
 * delta, or provider-error fields cannot enter local structured logs.
 */
export const safeAiPhaseLogFields = (entry: AiPhaseLogEntry): AiPhaseLogEntry => ({
  phase: entry.phase,
  status: entry.status,
  runId: entry.runId,
  ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }),
  ...(entry.topicId === undefined ? {} : { topicId: entry.topicId }),
  ...(entry.model === undefined ? {} : { model: entry.model }),
  ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
  ...(entry.attempt === undefined ? {} : { attempt: entry.attempt }),
  ...(entry.loopIteration === undefined ? {} : { loopIteration: entry.loopIteration }),
  ...(entry.providerRequestIndex === undefined
    ? {}
    : { providerRequestIndex: entry.providerRequestIndex }),
  ...(entry.inputTokens === undefined ? {} : { inputTokens: entry.inputTokens }),
  ...(entry.outputTokens === undefined ? {} : { outputTokens: entry.outputTokens }),
  ...(entry.totalTokens === undefined ? {} : { totalTokens: entry.totalTokens }),
  ...(entry.requestedOutputTokens === undefined
    ? {}
    : { requestedOutputTokens: entry.requestedOutputTokens }),
  ...(entry.usableInputTokens === undefined ? {} : { usableInputTokens: entry.usableInputTokens }),
  ...(entry.itemCount === undefined ? {} : { itemCount: entry.itemCount }),
  ...(entry.sourceCount === undefined ? {} : { sourceCount: entry.sourceCount }),
  ...(entry.topicCount === undefined ? {} : { topicCount: entry.topicCount }),
  ...(entry.conversationCount === undefined ? {} : { conversationCount: entry.conversationCount }),
  ...(entry.memoryCount === undefined ? {} : { memoryCount: entry.memoryCount }),
  ...(entry.consumerCount === undefined ? {} : { consumerCount: entry.consumerCount }),
  ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
  ...(entry.outcome === undefined ? {} : { outcome: entry.outcome }),
});

type OperationName =
  | "loadTurn"
  | "planTurn"
  | "extractMemory"
  | "freezeContext"
  | "selectMemories"
  | "retrieveInternal"
  | "retrieveWeb"
  | "assembleContext"
  | "measureAssembly"
  | "mergeFanoutSources"
  | "planReduction"
  | "measureReduction"
  | "answerDirect"
  | "clarify"
  | "allocateFanout"
  | "answerTopic"
  | "synthesisContext"
  | "synthesize"
  | "finalize";

interface PhaseRule {
  readonly phase: string;
  readonly additionalPhases?: readonly string[] | undefined;
  readonly asynchronous: boolean;
  readonly taskId: (args: readonly unknown[]) => string | undefined;
  readonly topicId?: ((args: readonly unknown[]) => "t1" | "t2" | "t3" | undefined) | undefined;
  readonly model: "fast" | "main" | null;
  readonly fallbackErrorCode: AiRunErrorCode;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const stringAt = (args: readonly unknown[], index: number): string | undefined =>
  typeof args[index] === "string" ? args[index] : undefined;

const fixed =
  (value: string): (() => string) =>
  () =>
    value;

const topicFromTask = (taskId: string | undefined): "t1" | "t2" | "t3" | undefined => {
  const match = /^topic-(t[123])-/u.exec(taskId ?? "");
  return match?.[1] as "t1" | "t2" | "t3" | undefined;
};

const topicFrom = (value: unknown): "t1" | "t2" | "t3" | undefined => {
  const candidate = record(value).topicId;
  return candidate === "t1" || candidate === "t2" || candidate === "t3" ? candidate : undefined;
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
  retrieveInternal: {
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
  planReduction: {
    phase: "context_reduction_plan",
    asynchronous: true,
    taskId: (args) => stringAt(args, 2),
    topicId: (args) => topicFrom(args[1]) ?? topicFromTask(stringAt(args, 2)),
    model: "fast",
    fallbackErrorCode: "context_reducer_failed",
  },
  measureReduction: {
    phase: "context_reduction_measure",
    asynchronous: true,
    taskId: (args) => stringAt(args, 3),
    topicId: (args) => topicFrom(args[1]) ?? topicFromTask(stringAt(args, 3)),
    model: null,
    fallbackErrorCode: "context_reducer_failed",
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
    asynchronous: false,
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
    asynchronous: false,
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

const operationNames = new Set<string>(Object.keys(rules));

const runIdFor = (name: OperationName, args: readonly unknown[]): string => {
  if (name === "loadTurn") return stringAt(args, 0) ?? "unknown";
  return typeof record(args[0]).aiRunId === "string"
    ? (record(args[0]).aiRunId as string)
    : "unknown";
};

const safeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const resultFields = (value: unknown): Partial<AiPhaseLogEntry> => {
  const result = record(value);
  const allowedOutcomes = new Set([
    "single",
    "fanout",
    "continue",
    "clarify",
    "ready",
    "needs_reduction",
    "ok",
    "partial",
    "answered",
  ]);
  const outcome = allowedOutcomes.has(String(result.status))
    ? String(result.status)
    : allowedOutcomes.has(String(result.mode))
      ? String(result.mode)
      : undefined;
  return {
    ...(Array.isArray(value) ? { itemCount: value.length } : {}),
    ...(Array.isArray(result.entries) ? { itemCount: result.entries.length } : {}),
    ...(Array.isArray(result.proposals) ? { memoryCount: result.proposals.length } : {}),
    ...(Array.isArray(result.sourceMap) ? { sourceCount: result.sourceMap.length } : {}),
    ...(Array.isArray(result.topics) ? { topicCount: result.topics.length } : {}),
    ...(Array.isArray(result.conversation)
      ? { conversationCount: result.conversation.length }
      : {}),
    ...(Array.isArray(result.memories) ? { memoryCount: result.memories.length } : {}),
    ...(Array.isArray(result.consumers) ? { consumerCount: result.consumers.length } : {}),
    ...(safeNumber(result.inputTokens) === undefined
      ? {}
      : { inputTokens: safeNumber(result.inputTokens) }),
    ...(safeNumber(result.usableInputTokens) === undefined
      ? {}
      : { usableInputTokens: safeNumber(result.usableInputTokens) }),
    ...(outcome === undefined ? {} : { outcome: outcome as AiPhaseLogEntry["outcome"] }),
  };
};

const errorCodeFor = (error: unknown, fallback: AiRunErrorCode): AiRunErrorCode =>
  isAiRuntimeError(error) ? error.code : fallback;

const durableOperationFailure = (error: unknown, fallback: AiRunErrorCode): Error => {
  if (isAbortError(error) || isAiRuntimeError(error)) return error;
  if (error instanceof MemoryConflictError) {
    return new AiRuntimeError("memory_conflict", "memory head changed during finalization");
  }
  return new AiRuntimeError(fallback, "workflow operation failed");
};

export const withAiPhaseLogging = (
  operations: CanonicalWorkflowOperations,
  options: {
    readonly logger: AiPhaseLogger;
    readonly fastModel: "glm-5-turbo";
    readonly mainModel: "glm-5-turbo";
    readonly now?: (() => number) | undefined;
  },
): CanonicalWorkflowOperations => {
  const now = options.now ?? Date.now;
  return new Proxy(operations, {
    get(target, property, receiver) {
      const original = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || !operationNames.has(property)) {
        return typeof original === "function" ? original.bind(target) : original;
      }
      const name = property as OperationName;
      const rule = rules[name];
      const invoke = original.bind(target) as (...args: readonly unknown[]) => unknown;
      return (...args: readonly unknown[]): unknown => {
        const startedAt = now();
        const common = {
          runId: runIdFor(name, args),
          ...(rule.taskId(args) === undefined ? {} : { taskId: rule.taskId(args) }),
          ...(rule.topicId?.(args) === undefined ? {} : { topicId: rule.topicId(args) }),
          ...(rule.model === null
            ? {}
            : { model: rule.model === "fast" ? options.fastModel : options.mainModel }),
        };
        const phases = [rule.phase, ...(rule.additionalPhases ?? [])];
        const emit = (entry: Omit<AiPhaseLogEntry, "phase">) =>
          Promise.all(phases.map((phase) => options.logger({ phase, ...entry }))).then(
            () => undefined,
          );
        if (rule.asynchronous) {
          return (async () => {
            await emit({ ...common, status: "started" });
            try {
              const result = await invoke(...args);
              await emit({
                ...common,
                ...resultFields(result),
                status: "succeeded",
                durationMs: Math.max(0, now() - startedAt),
              });
              return result;
            } catch (error) {
              const durableError = durableOperationFailure(error, rule.fallbackErrorCode);
              await emit({
                ...common,
                status: "failed",
                durationMs: Math.max(0, now() - startedAt),
                errorCode: errorCodeFor(durableError, rule.fallbackErrorCode),
              });
              throw durableError;
            }
          })();
        }
        void emit({ ...common, status: "started" });
        try {
          const result = invoke(...args);
          void emit({
            ...common,
            ...resultFields(result),
            status: "succeeded",
            durationMs: Math.max(0, now() - startedAt),
          });
          return result;
        } catch (error) {
          const durableError = durableOperationFailure(error, rule.fallbackErrorCode);
          void emit({
            ...common,
            status: "failed",
            durationMs: Math.max(0, now() - startedAt),
            errorCode: errorCodeFor(durableError, rule.fallbackErrorCode),
          });
          throw durableError;
        }
      };
    },
  });
};
