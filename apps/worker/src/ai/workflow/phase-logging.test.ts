import { describe, expect, it } from "vitest";

import { MemoryConflictError } from "../product-state/memory";
import type { CanonicalWorkflowOperations } from "./operations";
import { safeAiPhaseLogFields, withAiPhaseLogging, type AiPhaseLogEntry } from "./phase-logging";

describe("AI phase structured logging", () => {
  it("traces canonical phases with stable metadata and never serializes content", async () => {
    const secretQuestion = "SECRET resolved question";
    const secretSource = "SECRET source body";
    const secretAnswer = "SECRET answer delta";
    const entries: AiPhaseLogEntry[] = [];
    const load = { aiRunId: "run-1" };
    const operations = {
      retrieveInternal: async () => [
        {
          kind: "document",
          documentId: "doc-1",
          documentVersionId: "doc-1",
          purpose: secretSource,
        },
      ],
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

    await wrapped.retrieveInternal(load as never, secretQuestion, "topic-t2-retrieve-internal");
    await wrapped.answerDirect(load as never, { status: "ready" } as never, "single-answer");

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "internal_retrieval",
          status: "succeeded",
          runId: "run-1",
          taskId: "topic-t2-retrieve-internal",
          topicId: "t2",
          model: "glm-5-turbo",
          itemCount: 1,
        }),
        expect.objectContaining({
          phase: "direct_answer_call",
          status: "succeeded",
          model: "glm-5-turbo",
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
      errorCode: "answer_failed",
      ...({ rawUserText: secret, error: secret, delta: secret } as object),
    });
    expect(safe).toEqual({
      phase: "provider_call",
      status: "failed",
      runId: "run-2",
      taskId: "single-answer",
      errorCode: "answer_failed",
    });

    const entries: AiPhaseLogEntry[] = [];
    const operations = {
      retrieveWeb: async () => {
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
      .retrieveWeb({ aiRunId: "run-2" } as never, secret, "single-retrieve-web")
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "AiRuntimeError",
      code: "web_research_failed",
      retryable: true,
    });
    expect(String(failure)).not.toContain(secret);
    expect(entries.at(-1)).toMatchObject({
      phase: "web_retrieval",
      status: "failed",
      errorCode: "web_research_failed",
    });
    expect(JSON.stringify(entries)).not.toContain(secret);
  });

  it("propagates cancellation without durable reclassification", async () => {
    const cancellation = new DOMException("task cancelled", "AbortError");
    const operations = {
      retrieveWeb: async () => {
        throw cancellation;
      },
    } as unknown as CanonicalWorkflowOperations;
    const wrapped = withAiPhaseLogging(operations, {
      logger: () => undefined,
      fastModel: "glm-5-turbo",
      mainModel: "glm-5-turbo",
    });

    await expect(
      wrapped.retrieveWeb({ aiRunId: "run-3" } as never, "question", "single-retrieve-web"),
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
});
