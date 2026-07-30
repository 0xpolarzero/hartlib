import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import type { CandidateLedger, CandidateLedgerEntry } from "../workflow/types";
import {
  MAX_COMPACTION_GROUPS,
  compactionGroupTaskId,
  parseCompactionGroupTaskId,
  runCompaction,
  runCompactionPass,
  type CompactionRuntimeDependencies,
  type CompactionRuntimeInput,
} from "./compaction-runtime";

const hash = (value: string) => value.repeat(64).slice(0, 64);
const passageOptions = {
  maxTokens: 1,
  maxUtf8Bytes: 128,
  countTokens: (text: string) => text.split(/\s+/u).filter(Boolean).length,
} as const;

const candidate = (
  candidateId: `c${number}`,
  text: string,
  kind: CandidateLedgerEntry["kind"] = "document",
): CandidateLedgerEntry => ({
  candidateId,
  kind,
  identity:
    kind === "chat_message"
      ? { kind: "chat_message", messageId: candidateId, sanitizedContentHash: hash(candidateId) }
      : {
          kind: "public_document",
          sourceId: "source",
          documentId: candidateId,
          snapshotId: "snapshot",
          contentHash: hash(candidateId),
        },
  provenance: { label: candidateId, purpose: "answer", date: null },
  text,
  baseRanges: [{ charStart: 0, charEnd: text.length }],
  previewRanges: [{ charStart: 0, charEnd: text.length }],
  preview: text,
  ...(kind === "chat_message" ? { chatRole: "user" as const } : {}),
  renderedTokenCount: 20,
});

const ledger = (...entries: CandidateLedgerEntry[]): CandidateLedger => ({ candidates: entries });
const selected = (candidateId: string, passageIds: readonly string[] = ["p1"]) => ({
  decisions: [{ candidateId, action: "select" as const, passageIds, reason: "relevant" }],
});
const basePassInput = (
  groups: readonly { groupId: string; candidateIds: readonly string[] }[],
) => ({
  phase: "compact" as const,
  question: "What matters?",
  ledger: ledger(
    ...groups.map((group, index) =>
      candidate(`c${index + 1}` as `c${number}`, `Text ${index + 1}.`),
    ),
  ),
  groups: groups.map((group) => ({
    ...group,
    renderedTokenBudget: 100,
    mode: "normal" as const,
  })),
  passageOptions,
  concurrency: 2,
});

const passDeps = (
  runNormalGroup: CompactionRuntimeDependencies["runNormalGroup"],
  overrides: Partial<CompactionRuntimeDependencies> = {},
): CompactionRuntimeDependencies => ({
  runNormalGroup,
  runSourceToolGroup: () => Effect.fail(new Error("unexpected source tool call")),
  measureContext: () =>
    Effect.succeed({ fits: true, inputTokens: 1, usableInputTokens: 10, overByTokens: 0 }),
  ...overrides,
});

describe("compaction runtime", () => {
  it("creates stable gNNN IDs and bounds overlapping normal groups while collecting in ledger order", async () => {
    expect(compactionGroupTaskId("single", "compact", 1)).toBe("single-compact-g001");
    expect(compactionGroupTaskId("single", "fallback", 12)).toBe("single-fallback-g012");
    expect(compactionGroupTaskId("single", "compact", MAX_COMPACTION_GROUPS)).toBe(
      "single-compact-g999",
    );
    expect(() => compactionGroupTaskId("single", "compact", MAX_COMPACTION_GROUPS + 1)).toThrow(
      "between 1 and 999",
    );
    expect(parseCompactionGroupTaskId("single-compact-g001", ["single"])).toEqual({
      prefix: "single",
      phase: "compact",
      ordinal: 1,
    });
    expect(parseCompactionGroupTaskId("topic-t1-fallback-g099", ["topic-t1"])).toEqual({
      prefix: "topic-t1",
      phase: "fallback",
      ordinal: 99,
    });
    expect(parseCompactionGroupTaskId("source-tool-compact-g001", ["source-tool"])).toEqual({
      prefix: "source-tool",
      phase: "compact",
      ordinal: 1,
    });
    for (const taskId of ["single-compact-g01", "single-compact-g000", "single-compact-g1000"]) {
      expect(parseCompactionGroupTaskId(taskId, ["single"])).toBeUndefined();
    }

    let active = 0;
    let maximumActive = 0;
    const completionOrder: string[] = [];
    const input = basePassInput([
      { groupId: "g1", candidateIds: ["c1"] },
      { groupId: "g2", candidateIds: ["c2"] },
      { groupId: "g3", candidateIds: ["c3"] },
    ]);
    const result = await Effect.runPromise(
      runCompactionPass(
        input,
        passDeps((request) =>
          Effect.gen(function* () {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            yield* Effect.sleep(request.group.groupId === "g1" ? "30 millis" : "5 millis");
            completionOrder.push(request.group.groupId);
            active -= 1;
            return selected(request.group.candidateIds[0]!);
          }),
        ),
      ),
    );

    expect(maximumActive).toBe(2);
    expect(completionOrder[0]).toBe("g2");
    expect(completionOrder.indexOf("g1")).toBeGreaterThan(completionOrder.indexOf("g2"));
    expect(result.taskIds).toEqual([
      "single-compact-g001",
      "single-compact-g002",
      "single-compact-g003",
    ]);
    expect(result.envelopes.map((envelope) => envelope.groupId)).toEqual(["g1", "g2", "g3"]);
    expect(result.selections.map((selection) => selection.candidateId)).toEqual(["c1", "c2", "c3"]);
  });

  it("keeps oversized source execution source-local and uses at most one validation repair", async () => {
    const sourceCalls: string[] = [];
    let repairs = 0;
    const input = {
      ...basePassInput([{ groupId: "g1", candidateIds: ["c1"] }]),
      groups: [
        {
          groupId: "g1",
          candidateIds: ["c1"],
          renderedTokenBudget: 100,
          mode: "source_tool" as const,
        },
      ],
    };
    const result = await Effect.runPromise(
      runCompactionPass(
        input,
        passDeps(() => Effect.fail(new Error("normal callback must not run")), {
          runSourceToolGroup: (request) => {
            sourceCalls.push(request.candidate.candidateId);
            expect(request.candidate).not.toHaveProperty("identity");
            return Effect.succeed({ decisions: [{ candidateId: "c1", action: "bad" }] });
          },
          repairGroupResult: () => {
            repairs += 1;
            return Effect.succeed(selected("c1"));
          },
        }),
      ),
    );
    expect(sourceCalls).toEqual(["c1"]);
    expect(repairs).toBe(1);
    expect(result.repairUsed).toBe(true);
  });

  it("propagates Effect cancellation to in-flight group callbacks", async () => {
    let interrupted = false;
    const running = runCompactionPass(
      basePassInput([
        { groupId: "g1", candidateIds: ["c1"] },
        { groupId: "g2", candidateIds: ["c2"] },
      ]),
      passDeps(() =>
        Effect.sleep("1 second").pipe(
          Effect.onInterrupt(() => {
            interrupted = true;
            return Effect.void;
          }),
          Effect.map(() => selected("c1")),
        ),
      ),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(running);
        yield* Effect.sleep("10 millis");
        yield* Fiber.interrupt(fiber);
      }),
    );
    expect(interrupted).toBe(true);
  });

  it("runs one monotone fallback pass and one final exact measure", async () => {
    const first = candidate("c1", "Alpha. Beta.");
    const input: CompactionRuntimeInput = {
      question: "What matters?",
      ledger: ledger(first),
      initialManifest: {
        decisions: [{ candidateId: "c1", action: "compact", groupId: "g1", reason: "large" }],
        groups: [{ groupId: "g1", renderedTokenBudget: 10 }],
      },
      sourceToolEligibleCandidateIds: [],
      passageOptions,
      concurrency: 1,
    };
    const measuredPhases: string[] = [];
    let fallbackPlans = 0;
    const result = await Effect.runPromise(
      runCompaction(input, {
        runNormalGroup: (request) =>
          Effect.succeed(
            request.phase === "compact" ? selected("c1", ["p1", "p2"]) : selected("c1", ["p1"]),
          ),
        runSourceToolGroup: () => Effect.fail(new Error("unexpected source tool call")),
        planFallback: () => {
          fallbackPlans += 1;
          return Effect.succeed({
            decisions: [{ candidateId: "c1", action: "tighten", groupId: "g1", reason: "enough" }],
            groups: [{ groupId: "g1", renderedTokenBudget: 1 }],
          });
        },
        measureContext: (state) => {
          measuredPhases.push(state.phase);
          return Effect.succeed(
            state.phase === "compact"
              ? { fits: false, inputTokens: 20, usableInputTokens: 10, overByTokens: 10 }
              : { fits: true, inputTokens: 8, usableInputTokens: 10, overByTokens: 0 },
          );
        },
      }),
    );
    expect(result.status).toBe("ready");
    expect(result.fallbackRan).toBe(true);
    expect(fallbackPlans).toBe(1);
    expect(measuredPhases).toEqual(["compact", "fallback"]);
    expect(result.context.selections[0]!.passageIds).toEqual(["p1"]);
    expect(result.context.envelopes.map((envelope) => envelope.groupId)).toEqual(["g1"]);
    expect(result.context.envelopes[0]!.renderedTokenCount).toBe(1);
  });
  it("rejects fallback restoration instead of widening an omitted first-pass candidate", async () => {
    const input: CompactionRuntimeInput = {
      question: "What matters?",
      ledger: ledger(candidate("c1", "Alpha.")),
      initialManifest: {
        decisions: [{ candidateId: "c1", action: "compact", groupId: "g1", reason: "large" }],
        groups: [{ groupId: "g1", renderedTokenBudget: 10 }],
      },
      sourceToolEligibleCandidateIds: [],
      passageOptions,
      concurrency: 1,
    };
    await expect(
      Effect.runPromise(
        runCompaction(input, {
          runNormalGroup: () =>
            Effect.succeed({ decisions: [{ candidateId: "c1", action: "omit", reason: "no" }] }),
          runSourceToolGroup: () => Effect.fail(new Error("unexpected source tool call")),
          measureContext: () =>
            Effect.succeed({
              fits: false,
              inputTokens: 20,
              usableInputTokens: 10,
              overByTokens: 10,
            }),
          planFallback: () =>
            Effect.succeed({
              decisions: [{ candidateId: "c1", action: "retain", reason: "restore" }],
              groups: [],
            }),
        }),
      ),
    ).rejects.toThrow(/cannot be restored|first-pass omission/u);
  });

  it("allows a fit-first result without a fallback or repair", async () => {
    let measures = 0;
    let repairs = 0;
    const result = await Effect.runPromise(
      runCompaction(
        {
          question: "Question",
          ledger: ledger(candidate("c1", "Alpha.")),
          initialManifest: {
            decisions: [{ candidateId: "c1", action: "keep", reason: "small" }],
            groups: [],
          },
          sourceToolEligibleCandidateIds: [],
          passageOptions,
          concurrency: 1,
        },
        {
          runNormalGroup: () => Effect.fail(new Error("unexpected normal call")),
          runSourceToolGroup: () => Effect.fail(new Error("unexpected source tool call")),
          repairGroupResult: () => {
            repairs += 1;
            return Effect.fail(new Error("unexpected repair"));
          },
          measureContext: () => {
            measures += 1;
            return Effect.succeed({
              fits: true,
              inputTokens: 2,
              usableInputTokens: 10,
              overByTokens: 0,
            });
          },
        },
      ),
    );
    expect(result.status).toBe("ready");
    expect(measures).toBe(1);
    expect(repairs).toBe(0);
  });
});
