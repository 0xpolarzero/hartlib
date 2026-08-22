import { describe, expect, it } from "vitest";

import { MemoryConflictError } from "../product-state/memory";
import { AiRuntimeError } from "../runtime/errors";
import type { CanonicalWorkflowOperations } from "./operations";
import {
  publicActivityFromPhase,
  safeAiPhaseLogFields,
  withAiPhaseLogging,
  type AiPhaseLogEntry,
  type AiSafePhaseLogFields,
} from "./phase-logging";

describe("AI phase structured logging", () => {
  it("traces canonical phases with stable metadata and never serializes content", async () => {
    const secretQuestion = "SECRET resolved question";
    const secretSource = "SECRET source body";
    const secretAnswer = "SECRET answer delta";
    const entries: AiSafePhaseLogFields[] = [];
    const load = { aiRunId: "run-1" };
    const operations = {
      retrieveStructuredInternal: async () => ({
        queryPlan: { action: "skip", reason: "no_evidence" },
        branches: [],
        fused: {
          results: [
            {
              identity: { kind: "chat_message", messageId: "message-1" },
              value: { preview: secretSource },
            },
          ],
          coverage: [],
          candidateCountBeforeCap: 1,
          candidateCap: 1,
          hydratedBytes: secretSource.length,
          hydrationByteCap: null,
          truncation: { branch: false, candidates: false, hydration: false },
        },
        review: [],
        previewExposures: [],
      }),
      answerDirect: async () => ({
        status: "ok",
        mode: "single",
        content: secretAnswer,
        sourceMap: [],
      }),
    } as unknown as CanonicalWorkflowOperations;
    let now = 100;
    const wrapped = withAiPhaseLogging(operations, {
      logger: (entry) => {
        entries.push(safeAiPhaseLogFields(entry));
      },
      fastModel: "glm-5-turbo",
      mainModel: "glm-5-turbo",
      now: () => (now += 5),
    });

    await wrapped.retrieveStructuredInternal(
      load as never,
      secretQuestion,
      "topic-t2-retrieve-internal",
    );
    await wrapped.answerDirect(load as never, { status: "ready" } as never, "single-answer");

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "internal_retrieval",
          status: "succeeded",
          itemCount: 1,
        }),
        expect.objectContaining({
          phase: "direct_answer_call",
          status: "succeeded",
          sourceCount: 0,
          outcome: "ok",
        }),
        expect.objectContaining({ phase: "answer_stream", status: "started" }),
        expect.objectContaining({ phase: "answer_stream", status: "succeeded" }),
      ]),
    );
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(secretQuestion);
    expect(serialized).not.toContain(secretSource);
    expect(serialized).not.toContain(secretAnswer);
    expect(serialized).not.toMatch(/question|source body|answer delta|content|reason|claim/iu);
  });

  it("allow-lists fields and records only canonical codes for failures", async () => {
    const secret = "SECRET provider error payload";
    const safe = safeAiPhaseLogFields({
      phase: "provider_call",
      status: "failed",
      runId: "run-2",
      taskId: "single-answer",
      attempt: 2,
      errorCode: "answer_failed",
      errorCategory: "provider_transport",
      errorMessage: secret,
      ...({
        rawUserText: secret,
        error: secret,
        delta: secret,
        sourceId: "source-1",
        messageId: "message-1",
        query: "private query",
        candidateId: "c001",
        groupId: "g001",
        sql: "SELECT private",
        contentHash: "hash",
      } as object),
    });
    expect(safe).toEqual({
      runId: "run-2",
      phase: "provider_call",
      status: "failed",
      taskId: "single-answer",
      errorCode: "answer_failed",
      errorCategory: "provider_transport",
      errorMessage: "The model provider did not return a response.",
      attempt: 2,
    });

    const entries: AiSafePhaseLogFields[] = [];
    const operations = {
      retrieveStructuredInternal: async () => {
        throw new Error(secret);
      },
    } as unknown as CanonicalWorkflowOperations;
    const wrapped = withAiPhaseLogging(operations, {
      logger: (entry) => {
        entries.push(safeAiPhaseLogFields(entry));
      },
      fastModel: "glm-5-turbo",
      mainModel: "glm-5-turbo",
    });
    const failure = await wrapped
      .retrieveStructuredInternal({ aiRunId: "run-2" } as never, secret, "single-retrieve-internal")
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "AiRuntimeError",
      code: "internal_retrieval_failed",
      retryable: true,
    });
    expect(String(failure)).not.toContain(secret);
    expect(entries.at(-1)).toMatchObject({
      phase: "internal_retrieval",
      status: "failed",
      errorCode: "internal_retrieval_failed",
    });
    expect(JSON.stringify(entries)).not.toContain(secret);
  });

  it("propagates cancellation without durable reclassification", async () => {
    const cancellation = new DOMException("task cancelled", "AbortError");
    const operations = {
      retrieveStructuredInternal: async () => {
        throw cancellation;
      },
    } as unknown as CanonicalWorkflowOperations;
    const wrapped = withAiPhaseLogging(operations, {
      logger: () => undefined,
      fastModel: "glm-5-turbo",
      mainModel: "glm-5-turbo",
    });

    await expect(
      wrapped.retrieveStructuredInternal(
        { aiRunId: "run-3" } as never,
        "question",
        "single-retrieve-internal",
      ),
    ).rejects.toBe(cancellation);
  });

  it("preserves the canonical stale-memory classification at finalization", async () => {
    const entries: AiPhaseLogEntry[] = [];
    const operations = {
      finalize: async () => {
        throw new MemoryConflictError();
      },
    } as unknown as CanonicalWorkflowOperations;
    const wrapped = withAiPhaseLogging(operations, {
      logger: (entry) => {
        entries.push(entry);
      },
      fastModel: "glm-5-turbo",
      mainModel: "glm-5-turbo",
    });

    await expect(
      wrapped.finalize(
        { aiRunId: "run-memory" } as never,
        {} as never,
        {} as never,
        "ai-chat:run-memory",
      ),
    ).rejects.toMatchObject({ code: "memory_conflict", retryable: true });
    expect(entries.at(-1)).toMatchObject({
      phase: "finalization",
      status: "failed",
      errorCode: "memory_conflict",
    });
  });

  it.each(["assembleContext", "measureAssembly", "mergeFanoutSources"] as const)(
    "keeps untyped %s failures retryable without calling them provider overflow",
    async (operation) => {
      const entries: AiPhaseLogEntry[] = [];
      const operations = {
        [operation]: async () => {
          throw new Error("transient database failure with secret details");
        },
      } as unknown as CanonicalWorkflowOperations;
      const wrapped = withAiPhaseLogging(operations, {
        logger: (entry) => {
          entries.push(entry);
        },
        fastModel: "glm-5-turbo",
        mainModel: "glm-5-turbo",
      });
      const failure = await (wrapped[operation] as (...args: readonly never[]) => Promise<unknown>)(
        ...([] as readonly never[]),
      ).catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: "context_assembly_failed", retryable: true });
      expect(failure).not.toMatchObject({ code: "context_budget_mismatch" });
      expect(entries.at(-1)).toMatchObject({ errorCode: "context_assembly_failed" });
    },
  );

  it("suppresses setup and duplicate stream phases from public activity", () => {
    const entry = { status: "started", runId: "run-activity" } as const;

    expect(publicActivityFromPhase({ ...entry, phase: "load_turn" })).toBeUndefined();
    expect(publicActivityFromPhase({ ...entry, phase: "answer_stream" })).toBeUndefined();
    expect(publicActivityFromPhase({ ...entry, phase: "plan_turn" })).toMatchObject({
      code: "request_understanding",
      status: "running",
    });
    expect(publicActivityFromPhase({ ...entry, phase: "direct_answer_call" })).toMatchObject({
      code: "answer_generation",
      status: "running",
    });
  });

  it("records bounded query and review metrics without private IDs", async () => {
    const entries: AiSafePhaseLogFields[] = [];
    const operations = {
      retrieveStructuredInternal: async () => ({
        queryPlan: {
          action: "search",
          queries: [{ purpose: "PRIVATE query" }, { purpose: "PRIVATE query 2" }],
        },
        action: "accept",
        fused: {
          results: [{ resultId: "r001", preview: "PRIVATE preview" }],
          coverage: [
            { status: "applicable", hitCount: 4 },
            { status: "applicable", hitCount: 3 },
            { status: "not_applicable", hitCount: 0 },
          ],
          candidateCountBeforeCap: 5,
          truncation: { branch: false, candidates: true, hydration: false },
        },
        sourceId: "source-1",
        candidateId: "c001",
      }),
    } as unknown as CanonicalWorkflowOperations;
    const wrapped = withAiPhaseLogging(operations, {
      logger: (entry) => {
        entries.push(safeAiPhaseLogFields(entry));
      },
      fastModel: "glm-5-turbo",
      mainModel: "glm-5-turbo",
    });

    await wrapped.retrieveStructuredInternal(
      { aiRunId: "run-private" } as never,
      "PRIVATE question",
      "single-query-review",
    );

    expect(entries.at(-1)).toMatchObject({
      phase: "internal_retrieval",
      status: "succeeded",
      queryCount: 2,
      branchCount: 3,
      applicableBranchCount: 2,
      hitCount: 7,
      candidateCount: 5,
      capApplied: true,
      action: "accept",
    });
    expect(JSON.stringify(entries)).not.toMatch(/source-1|r001|c001/iu);
    expect(entries.at(0)).toMatchObject({
      runId: "run-private",
      taskId: "single-query-review",
    });
  });

  it("applies memory and web activity guards from operation arguments", async () => {
    const activities: Array<{ readonly code: string; readonly status: string }> = [];
    const operations = {
      selectMemories: async () => [],
      retrieveWeb: async () => [],
    } as unknown as CanonicalWorkflowOperations;
    const wrapped = withAiPhaseLogging(operations, {
      logger: () => undefined,
      activityLogger: (event) => {
        activities.push({ code: event.code, status: event.status });
      },
      fastModel: "glm-5-turbo",
      mainModel: "glm-5-turbo",
    });
    const enabled = {
      aiRunId: "run-activity",
      acceptanceScope: { memoryMode: "private_owner", webRequested: true, webEnabled: true },
    };
    const disabled = {
      aiRunId: "run-activity",
      acceptanceScope: { memoryMode: "disabled", webRequested: true, webEnabled: false },
    };
    const unrequested = {
      aiRunId: "run-activity",
      acceptanceScope: { memoryMode: "private_owner", webRequested: false, webEnabled: true },
    };

    await wrapped.selectMemories(enabled as never, "question", "single-select-memories");
    await wrapped.selectMemories(disabled as never, "question", "single-select-memories");
    await wrapped.retrieveWeb(enabled as never, "question", "single-retrieve-web");
    await wrapped.retrieveWeb(disabled as never, "question", "single-retrieve-web");
    await wrapped.retrieveWeb(unrequested as never, "question", "single-retrieve-web");

    expect(activities.filter(({ code }) => code === "saved_context")).toHaveLength(2);
    expect(activities.filter(({ code }) => code === "web_research")).toHaveLength(2);
  });

  it("traces every production compaction step with safe lifecycle metadata", async () => {
    const secret = "SECRET compaction query and source";
    const activities: Array<{ readonly code: string; readonly status: string }> = [];
    const load = { aiRunId: "run-compaction" };
    const entries: AiSafePhaseLogFields[] = [];
    const definitions = [
      {
        name: "createCompactionGroups",
        phase: "context_compaction_group_plan",
        args: [load, {}, {}, "single-compact-plan"],
        result: [{ groupId: "g1", candidateIds: ["c1"], renderedTokenBudget: 10, mode: "normal" }],
      },
      {
        name: "createFallbackCompactionGroups",
        phase: "context_compaction_fallback_group_plan",
        args: [load, {}, {}, {}, {}, "single-fallback-plan"],
        result: [{ groupId: "g1", candidateIds: ["c1"], renderedTokenBudget: 8, mode: "normal" }],
      },
      {
        name: "initialCompactionManifest",
        phase: "context_compaction_plan",
        args: [load, {}, "single-compact-plan"],
        result: {
          decisions: [
            { candidateId: "c1", action: "keep", reason: "retain" },
            { candidateId: "c2", action: "compact", groupId: "g1", reason: "compact" },
            { candidateId: "c3", action: "omit", reason: "omit" },
          ],
          groups: [{ groupId: "g1", renderedTokenBudget: 10 }],
          question: secret,
        },
      },
      {
        name: "compactContextGroup",
        phase: "context_compaction_group",
        args: [load, {}, { groupId: "g1" }, "single-compact-g001"],
        result: {
          groupId: "g1",
          result: {
            decisions: [
              { candidateId: "c2", action: "select", passageIds: ["p1", "p2"], reason: "retain" },
              { candidateId: "c3", action: "omit", reason: "omit" },
            ],
          },
          renderedTokenCount: 2,
          sourceText: secret,
        },
      },
      {
        name: "collectCompaction",
        phase: "context_compaction_collect",
        args: [load, {}, {}, [], [], "single-compact-collect"],
        result: {
          context: { status: "ready", inputTokens: 80, usableInputTokens: 100 },
          measurement: { fits: true, inputTokens: 80, usableInputTokens: 100, overByTokens: 0 },
          selections: [],
          pass: { phase: "compact", groups: [], taskIds: [], envelopes: [], selections: [] },
        },
      },
      {
        name: "collectFallbackCompaction",
        phase: "context_compaction_fallback_collect",
        args: [load, {}, {}, "single-fallback-collect"],
        result: {
          context: { status: "ready", inputTokens: 70, usableInputTokens: 100 },
          measurement: { fits: true, inputTokens: 70, usableInputTokens: 100, overByTokens: 0 },
          selections: [],
          pass: { phase: "fallback", groups: [], taskIds: [], envelopes: [], selections: [] },
        },
      },
      {
        name: "measureCompaction",
        phase: "context_compaction_measure",
        args: [load, {}, { phase: "compact", selections: [] }, "single-compact-measure"],
        result: {
          status: "ready",
          inputTokens: 80,
          usableInputTokens: 100,
          compactionFeedback: [secret],
        },
      },
      {
        name: "fallbackCompactionManifest",
        phase: "context_compaction_fallback_plan",
        args: [load, {}, {}, "single-fallback-plan"],
        result: {
          decisions: [
            { candidateId: "c1", action: "retain", reason: "retain" },
            { candidateId: "c2", action: "tighten", reason: "tighten" },
          ],
          groups: [{ groupId: "g1", renderedTokenBudget: 8 }],
          sourceText: secret,
        },
      },
      {
        name: "selectCompactionContext",
        phase: "context_compaction_select",
        args: [load, {}, "single-context-select"],
        result: {
          status: "context_plan_unfit",
          failureStage: "context_plan_unfit",
          sql: secret,
        },
      },
    ] as const;
    const successOperations = Object.fromEntries(
      definitions.map(({ name, result }) => [name, () => result]),
    ) as unknown as CanonicalWorkflowOperations;
    const wrapped = withAiPhaseLogging(successOperations, {
      logger: (entry) => {
        entries.push(safeAiPhaseLogFields(entry));
      },
      activityLogger: (event) => {
        activities.push({ code: event.code, status: event.status });
      },
      fastModel: "glm-5-turbo",
      mainModel: "glm-5-turbo",
    });

    const invoke = async (
      target: CanonicalWorkflowOperations,
      name: string,
      args: readonly unknown[],
    ): Promise<unknown> => {
      const operation = Reflect.get(target, name);
      if (typeof operation !== "function") throw new Error(`missing operation ${name}`);
      return Reflect.apply(operation, target, args);
    };

    for (const definition of definitions) {
      await invoke(wrapped, definition.name, definition.args);
      const rows = entries.filter((entry) => entry.phase === definition.phase);
      expect(rows.map((entry) => entry.status)).toEqual(["started", "succeeded"]);
    }
    await invoke(wrapped, "compactContextGroup", [
      load,
      { phase: "fallback" },
      { groupId: "g1" },
      "single-fallback-g001",
      "fallback",
    ]);
    await invoke(wrapped, "measureCompaction", [
      load,
      {},
      {},
      "single-fallback-measure",
      "fallback",
    ]);
    expect(
      entries
        .filter((entry) => entry.phase === "context_compaction_fallback_measure")
        .map((entry) => entry.status),
    ).toEqual(["started", "succeeded"]);
    expect(
      entries
        .filter((entry) => entry.phase === "context_compaction_fallback_group")
        .map((entry) => entry.status),
    ).toEqual(["started", "succeeded"]);
    expect(
      entries
        .filter((entry) => entry.phase === "context_compaction_fallback_collect")
        .map((entry) => entry.status),
    ).toEqual(["started", "succeeded"]);
    expect(activities.filter(({ code }) => code === "context_preparation")).toHaveLength(
      definitions.length * 2 + 4,
    );

    const failedEntries: AiSafePhaseLogFields[] = [];
    const failingOperations = Object.fromEntries(
      definitions.map(({ name }) => [
        name,
        () => {
          throw new Error(secret);
        },
      ]),
    ) as unknown as CanonicalWorkflowOperations;
    const failedWrapped = withAiPhaseLogging(failingOperations, {
      logger: (entry) => {
        failedEntries.push(safeAiPhaseLogFields(entry));
      },
      fastModel: "glm-5-turbo",
      mainModel: "glm-5-turbo",
    });
    for (const definition of definitions) {
      await expect(invoke(failedWrapped, definition.name, definition.args)).rejects.toBeInstanceOf(
        Error,
      );
      const rows = failedEntries.filter((entry) => entry.phase === definition.phase);
      expect(rows.map((entry) => entry.status)).toEqual(["started", "failed"]);
    }
    await expect(
      invoke(failedWrapped, "compactContextGroup", [
        load,
        { phase: "fallback" },
        { groupId: "g1" },
        "single-fallback-g001",
        "fallback",
      ]),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      invoke(failedWrapped, "measureCompaction", [
        load,
        {},
        {},
        "single-fallback-measure",
        "fallback",
      ]),
    ).rejects.toBeInstanceOf(Error);
    expect(
      failedEntries
        .filter((entry) => entry.phase === "context_compaction_fallback_group")
        .map((entry) => entry.status),
    ).toEqual(["started", "failed"]);
    expect(
      failedEntries
        .filter((entry) => entry.phase === "context_compaction_fallback_collect")
        .map((entry) => entry.status),
    ).toEqual(["started", "failed"]);
    expect(
      failedEntries
        .filter((entry) => entry.phase === "context_compaction_fallback_measure")
        .map((entry) => entry.status),
    ).toEqual(["started", "failed"]);

    const serialized = JSON.stringify([...entries, ...failedEntries]);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/query|sourceText|candidateId|candidateIds|sql|prompt|reason/iu);
    expect(
      entries.find(
        (entry) => entry.phase === "context_compaction_plan" && entry.status === "succeeded",
      ),
    ).toMatchObject({
      candidateCount: 3,
      groupCount: 1,
      keepCount: 1,
      compactCount: 1,
      omitCount: 1,
    });
    expect(
      entries.find(
        (entry) => entry.phase === "context_compaction_collect" && entry.status === "succeeded",
      ),
    ).toMatchObject({
      inputTokens: 80,
      usableInputTokens: 100,
      overByTokens: 0,
      outcome: "ready",
    });
    expect(
      entries.find(
        (entry) =>
          entry.phase === "context_compaction_fallback_collect" && entry.status === "succeeded",
      ),
    ).toMatchObject({
      inputTokens: 70,
      fallbackRan: true,
      outcome: "ready",
    });
  });

  it("emits terminal failures for resolved context states", async () => {
    const entries: AiPhaseLogEntry[] = [];
    const operations = {
      measureCompaction: async () => ({
        status: "failed",
        failureCode: "context_mandatory_too_large",
        failureStage: "context_mandatory_too_large",
      }),
      selectCompactionContext: async (_load: unknown, _state: unknown, taskId: unknown) => ({
        status: "failed",
        failureCode:
          taskId === "synthesis-context-select"
            ? "synthesis_budget_mismatch"
            : "context_plan_unfit",
        failureStage:
          taskId === "synthesis-context-select"
            ? "synthesis_budget_mismatch"
            : "context_plan_unfit",
      }),
    } as unknown as CanonicalWorkflowOperations;
    const wrapped = withAiPhaseLogging(operations, {
      logger: (entry) => {
        entries.push(entry);
      },
      fastModel: "glm-5-turbo",
      mainModel: "glm-5-turbo",
    });
    const load = { aiRunId: "run-failure" };
    await (wrapped.measureCompaction as (...args: readonly unknown[]) => Promise<unknown>)(
      load,
      {},
      { phase: "compact", selections: [] },
      "compact-measure",
    );
    await (wrapped.selectCompactionContext as (...args: readonly unknown[]) => Promise<unknown>)(
      load,
      {},
      "context-select",
    );
    await (wrapped.selectCompactionContext as (...args: readonly unknown[]) => Promise<unknown>)(
      load,
      {},
      "synthesis-context-select",
    );
    expect(
      entries
        .filter((entry) => entry.phase === "context_compaction_measure")
        .map((entry) => entry.status),
    ).toEqual(["started", "failed"]);
    expect(
      entries
        .filter((entry) => entry.phase === "context_compaction_select")
        .map((entry) => entry.status),
    ).toEqual(["started", "failed", "started", "failed"]);
    expect(entries.filter((entry) => entry.status === "failed")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          errorCode: "context_mandatory_too_large",
          failureStage: "context_mandatory_too_large",
        }),
        expect.objectContaining({
          errorCode: "context_plan_unfit",
          failureStage: "context_plan_unfit",
        }),
        expect.objectContaining({
          errorCode: "synthesis_budget_mismatch",
          failureStage: "synthesis_budget_mismatch",
        }),
      ]),
    );
  });

  it("honors explicit retryability for caught and resolved failures", async () => {
    const entries: AiPhaseLogEntry[] = [];
    const activities: Array<{ readonly code: string; readonly status: string }> = [];
    const operations = {
      measureCompaction: async () => {
        throw new AiRuntimeError("context_compaction_failed", "compaction failed", {
          retryable: false,
        });
      },
      selectCompactionContext: async () => ({
        status: "failed",
        failureCode: "context_plan_unfit",
        failureStage: "context_plan_unfit",
        retryable: true,
      }),
    } as unknown as CanonicalWorkflowOperations;
    const wrapped = withAiPhaseLogging(operations, {
      logger: (entry) => {
        entries.push(entry);
      },
      activityLogger: (event) => {
        activities.push({ code: event.code, status: event.status });
      },
      fastModel: "glm-5-turbo",
      mainModel: "glm-5-turbo",
    });
    const load = { aiRunId: "run-retryability" };
    await expect(
      (wrapped.measureCompaction as (...args: readonly unknown[]) => Promise<unknown>)(
        load,
        {},
        { phase: "compact", selections: [] },
        "retryability-measure",
      ),
    ).rejects.toBeInstanceOf(AiRuntimeError);
    await (wrapped.selectCompactionContext as (...args: readonly unknown[]) => Promise<unknown>)(
      load,
      {},
      "retryability-select",
    );
    expect(
      entries
        .filter((entry) => entry.status === "failed")
        .map((entry) => ({ errorCode: entry.errorCode, retryable: entry.retryable })),
    ).toEqual([
      { errorCode: "context_compaction_failed", retryable: false },
      { errorCode: "context_plan_unfit", retryable: true },
    ]);
    expect(
      entries
        .filter((entry) => entry.phase === "context_compaction_select")
        .map((entry) => entry.status),
    ).toEqual(["started", "failed"]);
    expect(
      activities.filter(({ code }) => code === "context_preparation").map(({ status }) => status),
    ).toEqual(["running", "failed", "running", "retrying"]);
    expect(
      entries.find(
        (entry) => entry.phase === "context_compaction_select" && entry.status === "failed",
      ),
    ).toMatchObject({
      errorCode: "context_plan_unfit",
      retryable: true,
      failureStage: "context_plan_unfit",
    });
    expect(JSON.stringify(safeAiPhaseLogFields(entries.at(-1)!))).not.toContain(
      "compaction failed",
    );
  });

  it("does not publish complete for resolved answer failures or finalization", async () => {
    const activities: Array<{ readonly code: string; readonly status: string }> = [];
    const operations = {
      answerDirect: async () => ({
        status: "failed",
        code: "answer_failed",
        retryable: false,
      }),
      finalize: async () => ({ status: "failed", code: "answer_failed", retryable: false }),
    } as unknown as CanonicalWorkflowOperations;
    const wrapped = withAiPhaseLogging(operations, {
      logger: () => undefined,
      activityLogger: (event) => {
        activities.push({ code: event.code, status: event.status });
      },
      fastModel: "glm-5-turbo",
      mainModel: "glm-5-turbo",
    });

    await wrapped.answerDirect(
      { aiRunId: "run-failure" } as never,
      { status: "ready" } as never,
      "single-answer",
    );
    await wrapped.finalize(
      { aiRunId: "run-failure" } as never,
      {} as never,
      {} as never,
      "ai-chat:run-failure",
    );

    expect(activities).not.toContainEqual({ code: "answer_generation", status: "complete" });
    expect(activities).not.toContainEqual({ code: "finalization", status: "complete" });
  });
});
