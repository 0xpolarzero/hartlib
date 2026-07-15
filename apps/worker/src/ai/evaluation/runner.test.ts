import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sourceKeyForOrdinal } from "../runtime/canonicalization";
import { providerRequestSha256Hex, stableJson } from "../runtime/provider-request";
import { CanonicalGoldenEvaluationSet } from "./fixtures/golden-set.v2";
import { EvaluationDimensions, type GoldenEvaluationCase } from "./schema";
import {
  attestExactConversationResolverRequest,
  attestExactProductionContext,
  CanonicalEvaluationTokenGate,
  EvaluationInputError,
  canonicalEvaluationUsableInputTokens,
  evaluateSuite,
  exactConversationResolverRequest,
  measureCanonicalEvaluationRequestTokens,
  measureExactProductionContextMarginals,
  exactProductionContextRequest,
  productionRequestSha256Hex,
  productionPacketSha256Hex,
} from "./runner";

const runId = (topology: "specialized" | "baseline", index: number): string =>
  `${topology === "specialized" ? "10000000" : "20000000"}-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;

const sourceIdsFor = (fixture: GoldenEvaluationCase): readonly string[] =>
  fixture.labels.requiredSourceIds;

const rangesFor = (
  fixture: GoldenEvaluationCase,
  sourceId: string,
): readonly { readonly charStart: number; readonly charEnd: number }[] =>
  fixture.labels.acceptableRanges[sourceId]?.slice(0, 1) ?? [];

const fullRangesFor = (
  fixture: GoldenEvaluationCase,
  sourceId: string,
): readonly { readonly charStart: number; readonly charEnd: number }[] =>
  fixture.evidence.find((source) => source.sourceId === sourceId)?.ranges ?? [];

const claimsFor = (fixture: GoldenEvaluationCase) =>
  fixture.labels.supportedClaims.map((claim) => ({
    claimId: claim.claimId,
    citedSourceIds: [claim.supportingSourceIds[0] as string],
  }));

const citationsFor = (fixture: GoldenEvaluationCase): readonly string[] => [
  ...new Set(claimsFor(fixture).flatMap((claim) => claim.citedSourceIds)),
];
const evaluationNonce = Buffer.from("2a4230a519d41be16726314ad1231817", "hex");

const rawPreNormalizationRequestSha256Hex = (request: unknown): string =>
  createHash("sha256").update(stableJson(request)).digest("hex");

const boundUuid = (namespace: number, caseIndex: number, ordinal: number): string =>
  `${String(namespace).padStart(8, "0")}-0000-4000-8000-${String(caseIndex * 100 + ordinal + 1).padStart(12, "0")}`;

const productionConversation = (fixture: GoldenEvaluationCase, caseIndex: number) =>
  fixture.labels.relevantTurnIds.map((fixtureTurnId) => {
    const turnIndex = fixture.conversation.findIndex((entry) => entry.turnId === fixtureTurnId);
    return {
      kind: "complete" as const,
      fixtureTurnId,
      turnId: boundUuid(3, caseIndex, turnIndex),
      userMessageId: boundUuid(4, caseIndex, turnIndex),
      assistantMessageId: boundUuid(5, caseIndex, turnIndex),
    };
  });

const resolverConversation = (fixture: GoldenEvaluationCase, caseIndex: number) =>
  fixture.conversation.slice(-12).map((entry) => {
    const turnIndex = fixture.conversation.findIndex(
      (candidate) => candidate.turnId === entry.turnId,
    );
    return {
      kind: "complete" as const,
      fixtureTurnId: entry.turnId,
      turnId: boundUuid(3, caseIndex, turnIndex),
      userMessageId: boundUuid(4, caseIndex, turnIndex),
      assistantMessageId: boundUuid(5, caseIndex, turnIndex),
    };
  });

const buildProductionContext = (
  fixture: GoldenEvaluationCase,
  caseIndex: number,
  candidateSelections: readonly {
    readonly sourceId: string;
    readonly ranges: readonly { readonly charStart: number; readonly charEnd: number }[];
  }[],
  selections: readonly {
    readonly sourceId: string;
    readonly ranges: readonly { readonly charStart: number; readonly charEnd: number }[];
  }[],
  resolution:
    | {
        readonly mode: "continue";
        readonly retrievalQuestion: string;
        readonly selectedTurnIds: readonly string[];
      }
    | { readonly mode: "clarify"; readonly question: string },
  executionPlan:
    | { readonly mode: "single" }
    | { readonly mode: "fanout"; readonly topicCount: number },
) => {
  if (resolution.mode === "clarify") {
    const conversation = resolverConversation(fixture, caseIndex);
    const currentDate = "2026-07-10";
    const exact = attestExactConversationResolverRequest(fixture, conversation, currentDate);
    return {
      productionContext: {
        mode: "clarification" as const,
        resolverRequest: {
          modelId: "glm-5-turbo" as const,
          ...exact,
          requestedOutputTokens: 2048 as const,
          currentUserMessageId: boundUuid(6, caseIndex, 99),
          currentDate,
          conversation,
          terminalUsageCoordinate: {
            taskId: "resolve-conversation",
            loopIteration: 0,
            attempt: 1,
            providerRequestIndex: 0,
          },
        },
        providerInputTokens: exact.inputTokens,
      },
      promptMeasurements: [
        {
          requestId: "resolve-conversation:0:1:0",
          requestSha256Hex: exact.requestSha256Hex,
          localInputTokens: exact.inputTokens,
          providerInputTokens: exact.inputTokens,
          gatePassed: true,
        },
      ],
    };
  }
  const keyBySourceId = new Map(
    candidateSelections.map((selection, sourceIndex) => [
      selection.sourceId,
      sourceKeyForOrdinal(evaluationNonce, sourceIndex + 1),
    ]),
  );
  const candidateIdBySourceId = new Map(
    candidateSelections.map((selection) => [selection.sourceId, `candidate:${selection.sourceId}`]),
  );
  const sourceBindings = (
    sourceSelections: readonly {
      readonly sourceId: string;
      readonly ranges: readonly { readonly charStart: number; readonly charEnd: number }[];
    }[],
  ) =>
    sourceSelections.map((selection) => {
      const source = fixture.evidence.find(
        (candidate) => candidate.sourceId === selection.sourceId,
      )!;
      return {
        candidateId: candidateIdBySourceId.get(selection.sourceId)!,
        sourceId: selection.sourceId,
        sourceKey: keyBySourceId.get(selection.sourceId)!,
        kind: source.kind,
        purpose:
          source.selector === "B" ? "relevant saved memory" : "canonical evaluation evidence",
        label:
          source.kind === "document"
            ? `Canonical evidence ${source.sourceId}`
            : source.kind === "web"
              ? `Canonical golden web evidence ${fixture.id}`
              : source.sourceId,
        ranges: selection.ranges,
      };
    });
  const selectedConversation = productionConversation(fixture, caseIndex);
  const directOrTopicLedger = (
    requestKind: "direct" | "topic",
    sourceSelections: typeof candidateSelections,
    question: string,
    topicId?: "t1" | "t2" | "t3",
  ) => {
    const sources = sourceBindings(sourceSelections);
    const input =
      requestKind === "direct"
        ? {
            requestKind,
            question,
            selectedConversation,
            gaps: fixture.labels.expectedGaps.map((gap) => gap.description),
            sources,
            requestedOutputTokens: 16_384,
          }
        : {
            requestKind,
            topicId: topicId!,
            question,
            selectedConversation,
            gaps: fixture.labels.expectedGaps.map((gap) => gap.description),
            sources,
            requestedOutputTokens: 16_384,
          };
    const exact = attestExactProductionContext(fixture, input);
    return {
      requestKind,
      ...(requestKind === "topic" ? { topicId: topicId! } : {}),
      modelId: "glm-5-turbo" as const,
      ...exact,
      usableInputTokens: canonicalEvaluationUsableInputTokens(),
      requestedOutputTokens: 16_384,
      selectedConversation,
      question,
      gaps: fixture.labels.expectedGaps.map((gap) => gap.description),
      sources,
    };
  };
  const terminal = <Ledger extends { readonly inputTokens: number }>(
    ledger: Ledger,
    taskId: string,
  ) => ({
    ledger,
    terminalUsageCoordinate: {
      taskId,
      loopIteration: 0,
      attempt: 1,
      providerRequestIndex: 0,
    },
    providerInputTokens: ledger.inputTokens,
  });
  if (executionPlan.mode === "single") {
    const initial = directOrTopicLedger(
      "direct",
      candidateSelections,
      resolution.retrievalQuestion,
    );
    const final = directOrTopicLedger("direct", selections, resolution.retrievalQuestion);
    const reduced = initial.inputTokens > initial.usableInputTokens;
    const productionContext = reduced
      ? {
          mode: "single_reduced" as const,
          initial,
          terminal: terminal(final, "single-answer"),
          iterations: 1,
          decisions: candidateSelections.map((selection) => {
            const selected = selections.find(
              (candidate) => candidate.sourceId === selection.sourceId,
            );
            return selected === undefined
              ? {
                  candidateId: candidateIdBySourceId.get(selection.sourceId)!,
                  action: "omit" as const,
                  ranges: [],
                }
              : selected.ranges.length > 0 &&
                  JSON.stringify(selected.ranges) !== JSON.stringify(selection.ranges)
                ? {
                    candidateId: candidateIdBySourceId.get(selection.sourceId)!,
                    action: "range" as const,
                    ranges: selected.ranges,
                  }
                : {
                    candidateId: candidateIdBySourceId.get(selection.sourceId)!,
                    action: "keep" as const,
                    ranges: [],
                  };
          }),
        }
      : {
          mode: "single_fit" as const,
          initial,
          terminal: terminal(initial, "single-answer"),
        };
    const terminalLedger = productionContext.terminal;
    return {
      productionContext,
      promptMeasurements: [
        {
          requestId: "single-answer:0:1:0",
          requestSha256Hex: terminalLedger.ledger.requestSha256Hex,
          localInputTokens: terminalLedger.ledger.inputTokens,
          providerInputTokens: terminalLedger.ledger.inputTokens,
          gatePassed: true,
        },
      ],
    };
  }
  const topicIds = (["t1", "t2", "t3"] as const).slice(0, executionPlan.topicCount);
  const topics = topicIds.map((topicId) => {
    const question = `${resolution.retrievalQuestion} (${topicId})`;
    const initial = directOrTopicLedger("topic", candidateSelections, question, topicId);
    return {
      topicId,
      reduced: false,
      iterations: 0,
      decisions: [],
      initial,
      terminal: terminal(initial, `topic-${topicId}-answer`),
    };
  });
  const packets = topics.map((topic) => ({
    topicId: topic.topicId,
    status: "partial" as const,
    claims: [],
    gaps: [`No additional ${topic.topicId} claim.`],
  }));
  const exactSynthesis = attestExactProductionContext(fixture, {
    requestKind: "synthesis",
    selectedConversation,
    packets,
    requestedOutputTokens: 16_384,
  });
  const synthesisLedger = {
    requestKind: "synthesis" as const,
    modelId: "glm-5-turbo" as const,
    ...exactSynthesis,
    usableInputTokens: canonicalEvaluationUsableInputTokens(),
    requestedOutputTokens: 16_384,
    selectedConversation,
    packets: packets.map((packet) => ({
      topicId: packet.topicId,
      status: packet.status,
      claimCount: packet.claims.length,
      gapCount: packet.gaps.length,
      packetSha256Hex: productionPacketSha256Hex(packet),
    })),
  };
  const synthesis = terminal(synthesisLedger, "fanout-synthesis");
  const productionContext = { mode: "fanout" as const, topics, synthesis };
  return {
    productionContext,
    promptMeasurements: [
      ...topics.map((topic) => ({
        requestId: `topic-${topic.topicId}-answer:0:1:0`,
        requestSha256Hex: topic.terminal.ledger.requestSha256Hex,
        localInputTokens: topic.terminal.ledger.inputTokens,
        providerInputTokens: topic.terminal.ledger.inputTokens,
        gatePassed: true,
      })),
      {
        requestId: "fanout-synthesis:0:1:0",
        requestSha256Hex: synthesis.ledger.requestSha256Hex,
        localInputTokens: synthesis.ledger.inputTokens,
        providerInputTokens: synthesis.ledger.inputTokens,
        gatePassed: true,
      },
    ],
  };
};

describe("production request attestation", () => {
  it("uses the canonical normalized provider digest for direct and structured requests", () => {
    const fixture = CanonicalGoldenEvaluationSet.cases.find(
      (candidate) => candidate.id === "cross-cutting-separable-energy-question",
    )!;
    const inputs = [
      {
        requestKind: "direct" as const,
        question: fixture.currentMessage,
        selectedConversation: [],
        gaps: [],
        sources: [],
        requestedOutputTokens: CanonicalEvaluationTokenGate.outputTokens,
      },
      {
        requestKind: "topic" as const,
        topicId: "t1" as const,
        question: fixture.currentMessage,
        selectedConversation: [],
        gaps: [],
        sources: [],
        requestedOutputTokens: CanonicalEvaluationTokenGate.outputTokens,
      },
    ];

    for (const input of inputs) {
      const request = exactProductionContextRequest(fixture, input);
      const canonicalDigest = productionRequestSha256Hex(request);

      expect(canonicalDigest).toBe(providerRequestSha256Hex(request));
      if (input.requestKind === "topic") {
        expect(canonicalDigest).not.toBe(rawPreNormalizationRequestSha256Hex(request));
      }
    }
  });
});

const syntheticResults = () => {
  const specialized = CanonicalGoldenEvaluationSet.cases.map((fixture, index) => {
    const serializedSourceIds = sourceIdsFor(fixture);
    const selections = serializedSourceIds.map((sourceId) => ({
      sourceId,
      ranges: rangesFor(fixture, sourceId),
    }));
    const candidateSelections = serializedSourceIds.map((sourceId) => ({
      sourceId,
      ranges: fullRangesFor(fixture, sourceId),
    }));
    const serializedContextTokens = measureCanonicalEvaluationRequestTokens(fixture, selections);
    const candidateTokens = measureCanonicalEvaluationRequestTokens(fixture, candidateSelections);
    const conversationResolution =
      fixture.labels.resolution.mode === "continue"
        ? {
            mode: "continue" as const,
            retrievalQuestion: fixture.labels.resolution.canonicalRetrievalQuestion,
            selectedTurnIds: fixture.labels.relevantTurnIds,
          }
        : {
            mode: "clarify" as const,
            question: "Which result do you mean: wind or solar?",
          };
    const executionPlan =
      fixture.labels.fanoutSuitability === "required"
        ? { mode: "fanout" as const, topicCount: 3 }
        : { mode: "single" as const };
    const production = buildProductionContext(
      fixture,
      index,
      candidateSelections,
      selections,
      conversationResolution,
      executionPlan,
    );
    const claims = claimsFor(fixture);
    const citationSourceIds = citationsFor(fixture);
    return {
      artifactVersion: 2 as const,
      goldenSetVersion: 2 as const,
      caseId: fixture.id,
      topology: "specialized" as const,
      capture: {
        origin: "synthetic_fixture" as const,
        runId: runId("specialized", index),
        provider: "zai" as const,
        modelIds: ["glm-5-turbo"] as const,
        startedAt: "2026-07-10T10:00:00.000Z",
        finishedAt: "2026-07-10T10:00:05.000Z",
      },
      promptMeasurements: production.promptMeasurements,
      answer: {
        claims,
        reportedGapIds: fixture.labels.expectedGaps.map((gap) => gap.gapId),
        citationSourceIds,
        rawCitationTagCount: citationSourceIds.length,
        citationDefectCount: 0,
      },
      memoryProposals: fixture.labels.expectedMemoryProposals,
      pulledSourceIds: serializedSourceIds,
      serializedSourceIds,
      serializedContextTokens,
      sourceAudit: serializedSourceIds.map((sourceId) => ({
        sourceId,
        authorized: true,
        resolvable: true,
      })),
      timing: { timeToFirstTokenMs: 1_000, timeToTerminalMs: 5_000 },
      usage: {
        providerRequestCount: production.promptMeasurements.length,
        inputTokens: 150,
        outputTokens: 50,
        totalTokens: 200,
      },
      conversationResolution,
      executionPlan,
      selectorSelections: {
        A: serializedSourceIds.filter(
          (sourceId) =>
            fixture.evidence.find((source) => source.sourceId === sourceId)?.selector === "A",
        ),
        B: serializedSourceIds.filter(
          (sourceId) =>
            fixture.evidence.find((source) => source.sourceId === sourceId)?.selector === "B",
        ),
        W: serializedSourceIds.filter(
          (sourceId) =>
            fixture.evidence.find((source) => source.sourceId === sourceId)?.selector === "W",
        ),
      },
      reduction: {
        required:
          production.productionContext.mode === "single_reduced" ||
          (production.productionContext.mode === "fanout" &&
            production.productionContext.topics.some((topic) => topic.reduced)),
        iterations:
          production.productionContext.mode === "single_reduced"
            ? production.productionContext.iterations
            : 0,
        candidateTokens,
        serializedTokens: serializedContextTokens,
        usableInputTokens: canonicalEvaluationUsableInputTokens(),
        candidateSourceIds: serializedSourceIds,
        candidateSelections,
        decisions: fixture.dimensions.includes("oversized_evidence")
          ? serializedSourceIds.map((sourceId) => {
              const ranges = rangesFor(fixture, sourceId);
              return ranges.length === 0
                ? { sourceId, action: "keep" as const, ranges: [] }
                : { sourceId, action: "range" as const, ranges };
            })
          : [],
        selections,
      },
      productionContext: production.productionContext,
    };
  });

  const baseline = CanonicalGoldenEvaluationSet.cases.map((fixture, index) => {
    const serializedSourceIds = sourceIdsFor(fixture);
    const claims = claimsFor(fixture);
    const citationSourceIds = citationsFor(fixture);
    return {
      artifactVersion: 2 as const,
      goldenSetVersion: 2 as const,
      caseId: fixture.id,
      topology: "general_planner" as const,
      capture: {
        origin: "synthetic_fixture" as const,
        runId: runId("baseline", index),
        provider: "zai" as const,
        modelIds: ["glm-5-turbo"] as const,
        startedAt: "2026-07-10T10:00:00.000Z",
        finishedAt: "2026-07-10T10:00:06.000Z",
      },
      promptMeasurements: [
        {
          requestId: `baseline-${fixture.id}-1`,
          requestSha256Hex: "b".repeat(64),
          localInputTokens: 120,
          providerInputTokens: 120,
          gatePassed: true,
        },
      ],
      answer: {
        claims,
        reportedGapIds: fixture.labels.expectedGaps.map((gap) => gap.gapId),
        citationSourceIds,
        rawCitationTagCount: citationSourceIds.length,
        citationDefectCount: 0,
      },
      memoryProposals: fixture.labels.expectedMemoryProposals,
      pulledSourceIds: serializedSourceIds,
      serializedSourceIds,
      serializedContextTokens: measureCanonicalEvaluationRequestTokens(
        fixture,
        serializedSourceIds.map((sourceId) => ({
          sourceId,
          ranges: fixture.labels.acceptableRanges[sourceId] ?? fullRangesFor(fixture, sourceId),
        })),
      ),
      sourceAudit: serializedSourceIds.map((sourceId) => ({
        sourceId,
        authorized: true,
        resolvable: true,
      })),
      timing: { timeToFirstTokenMs: 1_200, timeToTerminalMs: 6_000 },
      usage: {
        providerRequestCount: 1,
        inputTokens: 110,
        outputTokens: 40,
        totalTokens: 150,
      },
    };
  });

  return { specialized, baseline };
};

const refreshProductionTokenLedgers = (
  results: ReturnType<typeof syntheticResults>["specialized"],
): void => {
  for (const [index, result] of results.entries()) {
    const fixture = CanonicalGoldenEvaluationSet.cases[index]!;
    const production = buildProductionContext(
      fixture,
      index,
      result.reduction.candidateSelections,
      result.reduction.selections,
      result.conversationResolution,
      result.executionPlan,
    );
    result.productionContext = production.productionContext;
    result.promptMeasurements = production.promptMeasurements;
    result.usage.providerRequestCount = production.promptMeasurements.length;
  }
};

describe("canonical AI evaluation runner", () => {
  it("attests the production resolver's flat root-object provider schema", () => {
    const index = CanonicalGoldenEvaluationSet.cases.findIndex(
      (fixture) => fixture.id === "ambiguous-reference-needs-clarification",
    );
    const fixture = CanonicalGoldenEvaluationSet.cases[index]!;
    const request = exactConversationResolverRequest(
      fixture,
      resolverConversation(fixture, index),
      "2026-07-14",
    );
    expect(request.tools).toHaveLength(1);
    expect(request.tools?.[0]?.parameters).toMatchObject({
      type: "object",
      required: ["mode"],
      additionalProperties: false,
    });
    expect(request.tools?.[0]?.parameters).not.toHaveProperty("oneOf");
  });

  it("ships a golden set covering every canonical dimension with genuinely oversized evidence", () => {
    expect(
      new Set(CanonicalGoldenEvaluationSet.cases.flatMap((fixture) => fixture.dimensions)),
    ).toEqual(new Set(EvaluationDimensions));
    const oversized = CanonicalGoldenEvaluationSet.cases.find((fixture) =>
      fixture.dimensions.includes("oversized_evidence"),
    );
    if (oversized === undefined) throw new Error("canonical oversized fixture is missing");
    const candidateTokens = measureCanonicalEvaluationRequestTokens(
      oversized,
      oversized.evidence.map((source) => ({ sourceId: source.sourceId, ranges: source.ranges })),
    );
    const selectedTokens = measureCanonicalEvaluationRequestTokens(
      oversized,
      oversized.labels.requiredSourceIds.map((sourceId) => ({
        sourceId,
        ranges: rangesFor(oversized, sourceId),
      })),
    );
    expect(candidateTokens).toBeGreaterThan(CanonicalEvaluationTokenGate.inputTokens);
    expect(selectedTokens).toBeLessThanOrEqual(canonicalEvaluationUsableInputTokens());
  });

  it("accounts for every conversation and source token as an exact JSON-framed marginal", () => {
    const caseIndex = CanonicalGoldenEvaluationSet.cases.findIndex(
      (fixture) =>
        fixture.labels.resolution.mode === "continue" &&
        fixture.labels.relevantTurnIds.length > 0 &&
        fixture.labels.requiredSourceIds.length > 0,
    );
    if (caseIndex < 0) throw new Error("canonical marginal-token fixture is missing");
    const fixture = CanonicalGoldenEvaluationSet.cases[caseIndex]!;
    if (fixture.labels.resolution.mode !== "continue") {
      throw new Error("canonical marginal-token fixture does not continue");
    }
    const input = {
      requestKind: "direct" as const,
      question: fixture.labels.resolution.canonicalRetrievalQuestion,
      selectedConversation: productionConversation(fixture, caseIndex),
      gaps: fixture.labels.expectedGaps.map((gap) => gap.description),
      sources: fixture.labels.requiredSourceIds.map((sourceId, sourceIndex) => {
        const source = fixture.evidence.find((candidate) => candidate.sourceId === sourceId)!;
        return {
          sourceId,
          sourceKey: sourceKeyForOrdinal(evaluationNonce, sourceIndex + 1),
          kind: source.kind,
          purpose:
            source.selector === "B" ? "relevant saved memory" : "canonical evaluation evidence",
          label: source.kind === "document" ? `Canonical evidence ${sourceId}` : null,
          ranges: rangesFor(fixture, sourceId),
        };
      }),
      requestedOutputTokens: CanonicalEvaluationTokenGate.outputTokens,
    };
    const measured = measureExactProductionContextMarginals(fixture, input);
    const mandatory = measureExactProductionContextMarginals(fixture, {
      ...input,
      selectedConversation: [],
      sources: [],
    });
    expect(measured.conversationTokenCounts).toHaveLength(input.selectedConversation.length);
    expect(measured.sourceTokenCounts).toHaveLength(input.sources.length);
    expect(
      [...measured.conversationTokenCounts, ...measured.sourceTokenCounts].every(
        (count) => count >= 0,
      ),
    ).toBe(true);
    expect(
      mandatory.inputTokens +
        measured.conversationTokenCounts.reduce((sum, count) => sum + count, 0) +
        measured.sourceTokenCounts.reduce((sum, count) => sum + count, 0),
    ).toBe(measured.inputTokens);
    expect(attestExactProductionContext(fixture, input)).toEqual({
      inputTokens: measured.inputTokens,
      requestSha256Hex: measured.requestSha256Hex,
    });
  });

  it("scores all mandatory gates and passes a deterministic exact oracle", () => {
    const { specialized, baseline } = syntheticResults();
    const report = evaluateSuite(CanonicalGoldenEvaluationSet, specialized, baseline, {
      allowSyntheticCaptures: true,
    });

    expect(report.caseCount).toBe(CanonicalGoldenEvaluationSet.cases.length);
    expect(report.gates.map((gate) => gate.metric)).toEqual([
      "conversation.turn_selection_f1",
      "conversation.retrieval_question_fidelity",
      "conversation.clarification_precision",
      "conversation.clarification_recall",
      "planner.fanout_precision",
      "planner.required_fanout_recall",
      "planner.false_decomposition_rate",
      "selector.A.recall",
      "selector.A.precision",
      "selector.B.recall",
      "selector.B.precision",
      "selector.W.recall",
      "selector.W.precision",
      "prompt.exact_count_parity",
      "reducer.plan_validity",
      "reducer.convergence",
      "reducer.coverage",
      "reducer.range_validity",
      "reducer.token_reduction",
      "answer.factual_support",
      "answer.supported_claim_recall",
      "answer.citation_correctness",
      "answer.expected_gap_recall",
      "memory.proposal_precision",
      "memory.proposal_recall",
      "memory.update_correctness",
      "efficiency.pull_to_serialized",
      "efficiency.serialized_to_cited",
      "source.defect_count",
      "baseline.source_defect_count",
      "latency.time_to_first_token_p95_ms",
      "latency.time_to_terminal_p95_ms",
      "fanout.quality_ratio",
      "fanout.terminal_latency_ratio",
      "fanout.token_cost_ratio",
      "baseline.answer_quality_delta",
      "baseline.grounding_delta",
      "baseline.topology_justified",
    ]);
    expect(report.gates.filter((gate) => !gate.passed)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.metrics["baseline.topology_justified"]).toBe(1);
  });

  it("rejects synthetic captures in the real evaluation path", () => {
    const { specialized, baseline } = syntheticResults();
    expect(() => evaluateSuite(CanonicalGoldenEvaluationSet, specialized, baseline)).toThrow(
      EvaluationInputError,
    );
  });

  it("rejects artifact v1 and the pre-v2 shape without production request attestation", () => {
    const { specialized, baseline } = syntheticResults();
    const v1 = structuredClone(specialized);
    (v1[0] as { artifactVersion: number }).artifactVersion = 1;
    expect(() =>
      evaluateSuite(CanonicalGoldenEvaluationSet, v1, baseline, {
        allowSyntheticCaptures: true,
      }),
    ).toThrow();

    const oldShape = structuredClone(specialized) as unknown as Array<Record<string, unknown>>;
    delete oldShape[0]?.productionContext;
    expect(() =>
      evaluateSuite(CanonicalGoldenEvaluationSet, oldShape, baseline, {
        allowSyntheticCaptures: true,
      }),
    ).toThrow();
  });

  it("rejects unknown fields at the artifact root and inside production ledgers", () => {
    const { specialized, baseline } = syntheticResults();
    const unknownRoot = structuredClone(specialized) as unknown as Array<Record<string, unknown>>;
    unknownRoot[0]!.forgedRootField = true;
    expect(() =>
      evaluateSuite(CanonicalGoldenEvaluationSet, unknownRoot, baseline, {
        allowSyntheticCaptures: true,
      }),
    ).toThrow();

    const unknownNested = structuredClone(specialized) as unknown as Array<Record<string, unknown>>;
    const result = unknownNested.find((candidate) => {
      const production = candidate.productionContext as { readonly mode?: string } | undefined;
      return production?.mode === "single_fit" || production?.mode === "single_reduced";
    });
    const production = result?.productionContext as
      | { readonly initial?: { readonly sources?: Array<Record<string, unknown>> } }
      | undefined;
    const source = production?.initial?.sources?.[0];
    if (source === undefined) throw new Error("synthetic nested production source is missing");
    source.forgedNestedField = true;
    expect(() =>
      evaluateSuite(CanonicalGoldenEvaluationSet, unknownNested, baseline, {
        allowSyntheticCaptures: true,
      }),
    ).toThrow();
  });

  it("rejects incomplete, duplicate, extra, and request-accounting-defective result sets", () => {
    const { specialized, baseline } = syntheticResults();
    expect(() =>
      evaluateSuite(CanonicalGoldenEvaluationSet, specialized.slice(1), baseline, {
        allowSyntheticCaptures: true,
      }),
    ).toThrow(/missing case/u);
    expect(() =>
      evaluateSuite(CanonicalGoldenEvaluationSet, [...specialized, specialized[0]], baseline, {
        allowSyntheticCaptures: true,
      }),
    ).toThrow(/duplicate case/u);
    expect(() =>
      evaluateSuite(
        CanonicalGoldenEvaluationSet,
        [{ ...specialized[0], caseId: "not-in-golden" }, ...specialized.slice(1)],
        baseline,
        { allowSyntheticCaptures: true },
      ),
    ).toThrow(/unknown case/u);
    expect(() =>
      evaluateSuite(
        CanonicalGoldenEvaluationSet,
        [
          {
            ...specialized[0],
            usage: { ...specialized[0]?.usage, providerRequestCount: 2 },
          },
          ...specialized.slice(1),
        ],
        baseline,
        { allowSyntheticCaptures: true },
      ),
    ).toThrow(/every provider request/u);
    expect(() =>
      evaluateSuite(
        CanonicalGoldenEvaluationSet,
        [
          specialized[0],
          {
            ...specialized[1],
            capture: {
              ...specialized[1]!.capture,
              runId: specialized[0]!.capture.runId,
            },
          },
          ...specialized.slice(2),
        ],
        baseline,
        { allowSyntheticCaptures: true },
      ),
    ).toThrow(/reused across cases/u);
  });

  it("rejects one-token tampering in every reconstructed specialized and baseline ledger field", () => {
    const { specialized, baseline } = syntheticResults();
    const oversizedIndex = CanonicalGoldenEvaluationSet.cases.findIndex((fixture) =>
      fixture.dimensions.includes("oversized_evidence"),
    );
    if (oversizedIndex < 0) throw new Error("canonical oversized fixture is missing");

    const specializedMutations = [
      (results: typeof specialized) => {
        results[oversizedIndex]!.reduction.candidateTokens -= 1;
      },
      (results: typeof specialized) => {
        results[oversizedIndex]!.reduction.serializedTokens += 1;
      },
      (results: typeof specialized) => {
        const production = results[oversizedIndex]!.productionContext;
        if (production.mode !== "single_reduced") {
          throw new Error("oversized production context is not reduced");
        }
        production.initial.inputTokens -= 1;
      },
      (results: typeof specialized) => {
        const production = results[oversizedIndex]!.productionContext;
        if (production.mode !== "single_reduced") {
          throw new Error("oversized production context is not reduced");
        }
        production.terminal.ledger.inputTokens += 1;
      },
      (results: typeof specialized) => {
        results[oversizedIndex]!.reduction.usableInputTokens += 1;
      },
      (results: typeof specialized) => {
        results[oversizedIndex]!.serializedContextTokens -= 1;
      },
    ];
    for (const mutate of specializedMutations) {
      const tampered = structuredClone(specialized);
      mutate(tampered);
      expect(() =>
        evaluateSuite(CanonicalGoldenEvaluationSet, tampered, baseline, {
          allowSyntheticCaptures: true,
        }),
      ).toThrow(/does not match exact reconstructed count|route-mismatched terminal/u);
    }

    const tamperedBaseline = structuredClone(baseline);
    tamperedBaseline[oversizedIndex]!.serializedContextTokens += 1;
    expect(() =>
      evaluateSuite(CanonicalGoldenEvaluationSet, specialized, tamperedBaseline, {
        allowSyntheticCaptures: true,
      }),
    ).toThrow(/does not match exact reconstructed count/u);
  }, 15_000);

  it("fails conversation, planner, selector, parity, reducer, answer, and source gates independently", () => {
    const { specialized, baseline } = syntheticResults();
    const first = specialized[0];
    const fanoutIndex = specialized.findIndex((result) => result.executionPlan.mode === "fanout");
    const oversizedIndex = CanonicalGoldenEvaluationSet.cases.findIndex((fixture) =>
      fixture.dimensions.includes("oversized_evidence"),
    );
    if (first === undefined || fanoutIndex < 0 || oversizedIndex < 0) {
      throw new Error("canonical synthetic cases are incomplete");
    }
    const emptyFirstRequestTokens = measureCanonicalEvaluationRequestTokens(
      CanonicalGoldenEvaluationSet.cases[0]!,
      [],
    );

    const broken = structuredClone(specialized);
    for (const result of broken) {
      if (result.conversationResolution.mode === "continue") {
        result.conversationResolution.retrievalQuestion = "unrelated editorial calendar";
      }
      result.selectorSelections.A = [];
    }
    broken[0] = {
      ...first,
      conversationResolution: {
        mode: "continue",
        retrievalQuestion: "unrelated editorial calendar",
        selectedTurnIds: ["invented-turn"],
      },
      promptMeasurements: [{ ...first.promptMeasurements[0]!, providerInputTokens: 101 }],
      selectorSelections: { ...first.selectorSelections, A: [] },
      reduction: {
        ...first.reduction,
        selections: [],
        serializedTokens: emptyFirstRequestTokens,
      },
      serializedSourceIds: [],
      serializedContextTokens: emptyFirstRequestTokens,
      answer: { ...first.answer, citationDefectCount: 1 },
    };
    broken[fanoutIndex] = {
      ...broken[fanoutIndex]!,
      executionPlan: { mode: "single" },
    };
    const oversizedFixture = CanonicalGoldenEvaluationSet.cases[oversizedIndex]!;
    const fullSelections = broken[oversizedIndex]!.reduction.candidateSourceIds.map((sourceId) => ({
      sourceId,
      ranges: fullRangesFor(oversizedFixture, sourceId),
    }));
    const canonicalFullTokens = measureCanonicalEvaluationRequestTokens(
      oversizedFixture,
      fullSelections,
    );
    broken[oversizedIndex] = {
      ...broken[oversizedIndex]!,
      reduction: {
        ...broken[oversizedIndex]!.reduction,
        serializedTokens: canonicalFullTokens,
        decisions: fullSelections.flatMap((selection) => {
          const decision =
            selection.ranges.length === 0
              ? { sourceId: selection.sourceId, action: "keep" as const, ranges: [] }
              : {
                  sourceId: selection.sourceId,
                  action: "range" as const,
                  ranges: selection.ranges,
                };
          return [decision, decision];
        }),
        selections: fullSelections,
      },
      serializedContextTokens: canonicalFullTokens,
      answer: {
        ...broken[oversizedIndex]!.answer,
        claims: [],
        citationSourceIds: [],
        rawCitationTagCount: 0,
      },
    };
    refreshProductionTokenLedgers(broken);

    const parityDefectiveBaseline = structuredClone(baseline);
    parityDefectiveBaseline[0]!.promptMeasurements[0]!.providerInputTokens += 1;
    const report = evaluateSuite(CanonicalGoldenEvaluationSet, broken, parityDefectiveBaseline, {
      allowSyntheticCaptures: true,
    });
    const failed = new Set(report.gates.filter((gate) => !gate.passed).map((gate) => gate.metric));
    expect(failed).toContain("conversation.retrieval_question_fidelity");
    expect(failed).toContain("planner.required_fanout_recall");
    expect(failed).toContain("fanout.quality_ratio");
    expect(failed).toContain("fanout.terminal_latency_ratio");
    expect(failed).toContain("fanout.token_cost_ratio");
    expect(failed).toContain("selector.A.recall");
    expect(failed).toContain("prompt.exact_count_parity");
    expect(failed).toContain("reducer.plan_validity");
    expect(failed).toContain("reducer.convergence");
    expect(failed).toContain("reducer.coverage");
    expect(failed).toContain("reducer.token_reduction");
    expect(failed).toContain("answer.factual_support");
    expect(failed).toContain("answer.citation_correctness");
    expect(failed).toContain("source.defect_count");
    expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();
    expect(report.passed).toBe(false);
  });

  it("fails the offline topology baseline when extra specialization has no measurable benefit", () => {
    const { specialized, baseline } = syntheticResults();
    const noBenefitBaseline = baseline.map((result, index) => ({
      ...result,
      timing: specialized[index]!.timing,
    }));
    const report = evaluateSuite(CanonicalGoldenEvaluationSet, specialized, noBenefitBaseline, {
      allowSyntheticCaptures: true,
    });

    expect(report.metrics["baseline.context_efficiency_improvement"]).toBeLessThanOrEqual(0);
    expect(report.metrics["baseline.terminal_latency_improvement"]).toBe(0);
    expect(report.metrics["baseline.topology_justified"]).toBe(0);
    expect(report.passed).toBe(false);
  });

  it("rejects a provenance-defective baseline instead of treating its defect as specialization gain", () => {
    const { specialized, baseline } = syntheticResults();
    const brokenBaseline = structuredClone(baseline);
    const firstAudit = brokenBaseline[0]?.sourceAudit[0];
    if (firstAudit === undefined) throw new Error("canonical baseline source is missing");
    brokenBaseline[0]!.sourceAudit[0] = { ...firstAudit, authorized: false };

    const report = evaluateSuite(CanonicalGoldenEvaluationSet, specialized, brokenBaseline, {
      allowSyntheticCaptures: true,
    });
    expect(report.metrics["baseline.source_defect_count"]).toBeGreaterThan(0);
    expect(
      report.gates.find((gate) => gate.metric === "baseline.source_defect_count")?.passed,
    ).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("fails authorization, serialization, resolution, and latency invariants without averaging them away", () => {
    const { specialized, baseline } = syntheticResults();
    const broken = structuredClone(specialized);
    const first = broken[0];
    if (first === undefined || first.sourceAudit[0] === undefined) {
      throw new Error("first canonical case must have a source");
    }
    first.sourceAudit[0] = { ...first.sourceAudit[0], authorized: false, resolvable: false };
    const firstFixture = CanonicalGoldenEvaluationSet.cases[0]!;
    const emptyRequestTokens = measureCanonicalEvaluationRequestTokens(firstFixture, []);
    first.serializedSourceIds = [];
    first.reduction.selections = [];
    first.reduction.serializedTokens = emptyRequestTokens;
    first.serializedContextTokens = emptyRequestTokens;
    first.timing = { timeToFirstTokenMs: 120_001, timeToTerminalMs: 300_001 };
    first.capture = { ...first.capture, finishedAt: "2026-07-10T10:10:00.000Z" };
    refreshProductionTokenLedgers(broken);

    const report = evaluateSuite(CanonicalGoldenEvaluationSet, broken, baseline, {
      allowSyntheticCaptures: true,
    });
    expect(report.metrics["source.defect_count"]).toBeGreaterThan(0);
    expect(report.gates.find((gate) => gate.metric === "source.defect_count")?.passed).toBe(false);
    expect(
      report.gates.find((gate) => gate.metric === "latency.time_to_first_token_p95_ms")?.passed,
    ).toBe(false);
    expect(
      report.gates.find((gate) => gate.metric === "latency.time_to_terminal_p95_ms")?.passed,
    ).toBe(false);
  });

  it("enforces clarification, false-decomposition, B/W selection, range, gap, and memory boundaries", () => {
    const { specialized, baseline } = syntheticResults();
    const broken = structuredClone(specialized);
    const clarifyIndex = CanonicalGoldenEvaluationSet.cases.findIndex(
      (fixture) => fixture.labels.resolution.mode === "clarify",
    );
    const memoryIndex = CanonicalGoldenEvaluationSet.cases.findIndex((fixture) =>
      fixture.dimensions.includes("memory_relevance"),
    );
    const webIndex = CanonicalGoldenEvaluationSet.cases.findIndex((fixture) =>
      fixture.dimensions.includes("multilingual"),
    );
    const oversizedIndex = CanonicalGoldenEvaluationSet.cases.findIndex((fixture) =>
      fixture.dimensions.includes("oversized_evidence"),
    );
    const gapIndex = CanonicalGoldenEvaluationSet.cases.findIndex((fixture) =>
      fixture.dimensions.includes("out_of_corpus"),
    );
    if (
      [clarifyIndex, memoryIndex, webIndex, oversizedIndex, gapIndex].some((index) => index < 0)
    ) {
      throw new Error("canonical boundary cases are incomplete");
    }

    broken[clarifyIndex]!.conversationResolution = {
      mode: "continue",
      retrievalQuestion: "wind or solar",
      selectedTurnIds: [],
    };
    broken[clarifyIndex]!.executionPlan = { mode: "fanout", topicCount: 2 };
    broken[memoryIndex]!.selectorSelections.B = [];
    broken[memoryIndex]!.memoryProposals = [
      {
        ...broken[memoryIndex]!.memoryProposals[0]!,
        content: "An incorrect replacement preference",
      },
    ];
    broken[webIndex]!.selectorSelections.W = [];
    const firstAcceptableRange =
      CanonicalGoldenEvaluationSet.cases[oversizedIndex]!.labels.acceptableRanges[
        broken[oversizedIndex]!.reduction.selections[0]!.sourceId
      ]?.[0];
    if (firstAcceptableRange === undefined) throw new Error("oversized range label is missing");
    const badRange = [
      { charStart: firstAcceptableRange.charEnd + 1, charEnd: firstAcceptableRange.charEnd + 11 },
    ];
    broken[oversizedIndex]!.reduction.selections[0] = {
      ...broken[oversizedIndex]!.reduction.selections[0]!,
      ranges: badRange,
    };
    broken[oversizedIndex]!.reduction.decisions[0] = {
      sourceId: broken[oversizedIndex]!.reduction.decisions[0]!.sourceId,
      action: "range",
      ranges: badRange,
    };
    const oversizedFixture = CanonicalGoldenEvaluationSet.cases[oversizedIndex]!;
    const oversizedResult = broken[oversizedIndex]!;
    const canonicalBadRangeTokens = measureCanonicalEvaluationRequestTokens(
      oversizedFixture,
      oversizedResult.reduction.selections,
    );
    broken[oversizedIndex]!.reduction.serializedTokens = canonicalBadRangeTokens;
    broken[oversizedIndex]!.serializedContextTokens = canonicalBadRangeTokens;
    broken[gapIndex]!.answer.reportedGapIds = [];
    refreshProductionTokenLedgers(broken);

    const report = evaluateSuite(CanonicalGoldenEvaluationSet, broken, baseline, {
      allowSyntheticCaptures: true,
    });
    const failed = new Set(report.gates.filter((gate) => !gate.passed).map((gate) => gate.metric));
    expect(failed).toContain("conversation.clarification_precision");
    expect(failed).toContain("conversation.clarification_recall");
    expect(failed).toContain("planner.fanout_precision");
    expect(failed).toContain("planner.false_decomposition_rate");
    expect(failed).toContain("selector.B.recall");
    expect(failed).toContain("selector.W.recall");
    expect(failed).toContain("reducer.range_validity");
    expect(failed).toContain("answer.expected_gap_recall");
    expect(failed).toContain("memory.proposal_precision");
    expect(failed).toContain("memory.proposal_recall");
    expect(failed).toContain("memory.update_correctness");
  });

  it("enforces efficiency and fanout quality, latency, and token-cost comparisons", () => {
    const { specialized, baseline } = syntheticResults();
    const broken = structuredClone(specialized);
    const fanoutIndex = broken.findIndex((result) => result.executionPlan.mode === "fanout");
    if (fanoutIndex < 0) throw new Error("canonical fanout case is missing");

    for (const result of broken) {
      result.pulledSourceIds = [
        ...result.pulledSourceIds,
        ...Array.from({ length: 10 }, (_, index) => `unknown:${result.caseId}:${index}`),
      ];
      result.answer.claims = [];
      result.answer.citationSourceIds = [];
      result.answer.rawCitationTagCount = 0;
    }
    broken[fanoutIndex]!.timing = { timeToFirstTokenMs: 1_000, timeToTerminalMs: 10_000 };
    broken[fanoutIndex]!.capture = {
      ...broken[fanoutIndex]!.capture,
      finishedAt: "2026-07-10T10:00:10.000Z",
    };
    broken[fanoutIndex]!.usage = {
      ...broken[fanoutIndex]!.usage,
      inputTokens: 350,
      outputTokens: 50,
      totalTokens: 400,
    };

    const report = evaluateSuite(CanonicalGoldenEvaluationSet, broken, baseline, {
      allowSyntheticCaptures: true,
    });
    const failed = new Set(report.gates.filter((gate) => !gate.passed).map((gate) => gate.metric));
    expect(failed).toContain("answer.supported_claim_recall");
    expect(failed).toContain("efficiency.pull_to_serialized");
    expect(failed).toContain("efficiency.serialized_to_cited");
    expect(failed).toContain("fanout.quality_ratio");
    expect(failed).toContain("fanout.terminal_latency_ratio");
    expect(failed).toContain("fanout.token_cost_ratio");
  });
});
