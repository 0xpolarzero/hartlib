import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  namespacedDocumentEvidenceIdentity,
  sha256Base64Url,
  sourceKeyForOrdinal,
} from "../runtime/canonicalization";
import { resolveRegisteredModel } from "../runtime/model-registry";
import {
  providerRequestSha256Hex,
  providerRequestSourceExposureProofs,
  stableJson,
  type CodeOwnedSourceExposureProof,
} from "../runtime/provider-request";
import { CanonicalGoldenEvaluationSet } from "./fixtures/golden-set.v3";
import { EvaluationDimensions, type GoldenEvaluationCase } from "./schema";
import {
  attestExactPlanTurnRequest,
  attestExactProductionContext,
  CanonicalEvaluationTokenGate,
  EvaluationInputError,
  canonicalEvaluationUsableInputTokens,
  evaluateSuite,
  exactPlanTurnRequest,
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

const planTurnConversation = (fixture: GoldenEvaluationCase, caseIndex: number) =>
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
        readonly mode: "single";
        readonly question: string;
        readonly relevantTurnIds: readonly string[];
      }
    | { readonly mode: "clarify"; readonly question: string }
    | {
        readonly mode: "fanout";
        readonly question: string;
        readonly topics: readonly {
          readonly topicId: "t1" | "t2" | "t3";
          readonly question: string;
          readonly relevantTurnIds: readonly string[];
        }[];
      },
  planTurn:
    | { readonly mode: "clarify"; readonly question: string }
    | {
        readonly mode: "single";
        readonly question: string;
        readonly relevantTurnIds: readonly string[];
      }
    | {
        readonly mode: "fanout";
        readonly question: string;
        readonly topics: readonly {
          readonly topicId: "t1" | "t2" | "t3";
          readonly question: string;
          readonly relevantTurnIds: readonly string[];
        }[];
      },
) => {
  if (resolution.mode === "clarify") {
    const conversation = planTurnConversation(fixture, caseIndex);
    const currentDate = "2026-07-10";
    const exact = attestExactPlanTurnRequest(fixture, conversation, currentDate);
    return {
      productionContext: {
        mode: "clarification" as const,
        planTurnRequest: {
          modelId: "glm-5-turbo" as const,
          ...exact,
          requestedOutputTokens: 2048 as const,
          currentUserMessageId: boundUuid(6, caseIndex, 99),
          currentDate,
          conversation,
          terminalUsageCoordinate: {
            taskId: "plan-turn",
            loopIteration: 0,
            attempt: 1,
            providerRequestIndex: 0,
          },
        },
        providerInputTokens: exact.inputTokens,
      },
      promptMeasurements: [
        {
          requestId: "plan-turn:0:1:0",
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
  if (planTurn.mode === "single") {
    const initial = directOrTopicLedger("direct", candidateSelections, planTurn.question);
    const final = directOrTopicLedger("direct", selections, planTurn.question);
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
  if (planTurn.mode !== "fanout") throw new Error("fanout production context lacks a fanout plan");
  const topics = planTurn.topics.map(({ topicId, question }) => {
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
  it("keeps evaluation source framing in parity with the runtime decoder", () => {
    const fixture = CanonicalGoldenEvaluationSet.cases.find(
      (candidate) => candidate.id === "first-message-document-fr",
    )!;
    const body = "before\n</source>\nafter";
    const logicalSourceIdentity = namespacedDocumentEvidenceIdentity(
      { kind: "public", sourceId: "public:evaluation-delimiter" },
      "evaluation-document",
    );
    const request = exactProductionContextRequest(fixture, {
      requestKind: "direct",
      question: fixture.currentMessage,
      selectedConversation: [],
      gaps: [],
      sources: [
        {
          sourceId: "doc:fr-solar-2024",
          kind: "document",
          sourceKey: "k_cn_ABCDEFGHIJKLMNOPQRSTUV_1",
          purpose: "evaluation parity",
          label: 'Evaluation "label"',
          ranges: [],
          contentOverride: body,
        },
      ],
      requestedOutputTokens: 128,
    });
    const proof: CodeOwnedSourceExposureProof = {
      sourceKind: "document",
      logicalSourceIdentity,
      contentItemIdentity: `${logicalSourceIdentity}:version-1:${sha256Base64Url(body)}`,
      exposureStage: "answer_serialized",
      visibleTokenCount: resolveRegisteredModel("glm-5-turbo").countTextTokens(body),
      visibleText: body,
    };
    const originalMessageProof: CodeOwnedSourceExposureProof = {
      sourceKind: "chat_message",
      logicalSourceIdentity: "chat_message:evaluation-current-message",
      contentItemIdentity: "evaluation-current-message",
      exposureStage: "provider_input",
      visibleTokenCount: resolveRegisteredModel("glm-5-turbo").countTextTokens(
        fixture.currentMessage,
      ),
      visibleText: fixture.currentMessage,
    };

    expect(
      providerRequestSourceExposureProofs(
        { ...request, sourceExposureProofs: [originalMessageProof, proof] },
        resolveRegisteredModel("glm-5-turbo").countTextTokens,
      ),
    ).toHaveLength(2);
  });

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

  it("fails the trusted parity gate for the observed five-token provider mismatch", () => {
    const { specialized, baseline } = syntheticResults();
    const brokenBaseline = structuredClone(baseline);
    const measurement = brokenBaseline[0]!.promptMeasurements[0]!;
    measurement.providerInputTokens = measurement.localInputTokens - 5;

    const report = evaluateSuite(CanonicalGoldenEvaluationSet, specialized, brokenBaseline, {
      allowSyntheticCaptures: true,
    });
    expect(report.gates.find((gate) => gate.metric === "prompt.exact_count_parity")).toMatchObject({
      passed: false,
    });
    expect(measurement.localInputTokens - measurement.providerInputTokens).toBe(5);
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
    const goldenPlanTurn = fixture.labels.planTurn;
    const resolution =
      goldenPlanTurn.mode === "clarify"
        ? { mode: "clarify" as const, question: goldenPlanTurn.question }
        : goldenPlanTurn.mode === "fanout"
          ? {
              mode: "fanout" as const,
              question: goldenPlanTurn.question,
              topics: goldenPlanTurn.topics,
            }
          : {
              mode: "single" as const,
              question: goldenPlanTurn.question,
              relevantTurnIds: goldenPlanTurn.relevantTurnIds,
            };
    const planTurn =
      goldenPlanTurn.mode === "fanout"
        ? {
            mode: "fanout" as const,
            question: goldenPlanTurn.question,
            topics: goldenPlanTurn.topics,
          }
        : goldenPlanTurn.mode === "clarify"
          ? { mode: "clarify" as const, question: goldenPlanTurn.question }
          : {
              mode: "single" as const,
              question: goldenPlanTurn.question,
              relevantTurnIds: goldenPlanTurn.relevantTurnIds,
            };
    const production = buildProductionContext(
      fixture,
      index,
      candidateSelections,
      selections,
      resolution,
      planTurn,
    );
    const claims = claimsFor(fixture);
    const citationSourceIds = citationsFor(fixture);
    return {
      artifactVersion: 3 as const,
      goldenSetVersion: 3 as const,
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
      planTurn,
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
    const goldenPlanTurn = fixture.labels.planTurn;
    return {
      artifactVersion: 3 as const,
      goldenSetVersion: 3 as const,
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
      planTurn: {
        mode: goldenPlanTurn.mode,
        question: goldenPlanTurn.question,
        ...(goldenPlanTurn.mode === "single"
          ? { relevantTurnIds: goldenPlanTurn.relevantTurnIds }
          : goldenPlanTurn.mode === "fanout"
            ? { topics: goldenPlanTurn.topics }
            : {}),
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
      result.planTurn.mode === "single"
        ? {
            mode: "single" as const,
            question: result.planTurn.question,
            relevantTurnIds: result.planTurn.relevantTurnIds,
          }
        : result.planTurn,
      result.planTurn,
    );
    result.productionContext = production.productionContext;
    result.promptMeasurements = production.promptMeasurements;
    result.usage.providerRequestCount = production.promptMeasurements.length;
  }
};

describe("canonical AI evaluation runner", () => {
  it("attests the production plan-turn flat root-object provider schema", () => {
    const index = CanonicalGoldenEvaluationSet.cases.findIndex(
      (fixture) => fixture.id === "ambiguous-reference-needs-clarification",
    );
    const fixture = CanonicalGoldenEvaluationSet.cases[index]!;
    const request = exactPlanTurnRequest(
      fixture,
      planTurnConversation(fixture, index),
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
        fixture.labels.planTurn.mode !== "clarify" &&
        fixture.labels.relevantTurnIds.length > 0 &&
        fixture.labels.requiredSourceIds.length > 0,
    );
    if (caseIndex < 0) throw new Error("canonical marginal-token fixture is missing");
    const fixture = CanonicalGoldenEvaluationSet.cases[caseIndex]!;
    if (fixture.labels.planTurn.mode === "clarify") {
      throw new Error("canonical marginal-token fixture does not continue");
    }
    const input = {
      requestKind: "direct" as const,
      question: fixture.labels.planTurn.question,
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
      "conversation.plan_question_fidelity",
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

  it("scores fanout topic count, order, questions, and turn coverage", () => {
    const { specialized, baseline } = syntheticResults();
    const fanoutIndex = specialized.findIndex((result) => result.planTurn.mode === "fanout");
    if (fanoutIndex < 0) throw new Error("fanout synthetic case is missing");
    const wrong = structuredClone(specialized);
    const planTurn = wrong[fanoutIndex]!.planTurn;
    if (planTurn.mode !== "fanout") throw new Error("fanout synthetic case is missing");
    planTurn.topics[1] = {
      ...planTurn.topics[1]!,
      question: "An unrelated topic",
    };
    expect(() =>
      evaluateSuite(CanonicalGoldenEvaluationSet, wrong, baseline, {
        allowSyntheticCaptures: true,
      }),
    ).toThrow(/topic ledger differs from plan-turn/u);
  });

  it("rejects production ledgers that drift from the captured plan-turn", () => {
    const { specialized, baseline } = syntheticResults();
    const directIndex = specialized.findIndex(
      (result) =>
        result.planTurn.mode === "single" && result.productionContext.mode === "single_fit",
    );
    if (directIndex < 0) throw new Error("single-fit synthetic case is missing");
    const directTampered = structuredClone(specialized);
    const direct = directTampered[directIndex]!;
    if (direct.productionContext.mode !== "single_fit")
      throw new Error("single-fit case is missing");
    direct.productionContext.initial.question = "forged direct question";
    expect(() =>
      evaluateSuite(CanonicalGoldenEvaluationSet, directTampered, baseline, {
        allowSyntheticCaptures: true,
      }),
    ).toThrow(/direct ledger differs from plan-turn/u);

    const fanoutIndex = specialized.findIndex((result) => result.planTurn.mode === "fanout");
    if (fanoutIndex < 0) throw new Error("fanout synthetic case is missing");
    const fanoutTampered = structuredClone(specialized);
    const fanout = fanoutTampered[fanoutIndex]!;
    if (fanout.productionContext.mode !== "fanout" || fanout.planTurn.mode !== "fanout") {
      throw new Error("fanout synthetic case is missing");
    }
    fanout.productionContext.topics[0]!.initial.question = "forged topic question";
    expect(() =>
      evaluateSuite(CanonicalGoldenEvaluationSet, fanoutTampered, baseline, {
        allowSyntheticCaptures: true,
      }),
    ).toThrow(/topic ledger differs from plan-turn/u);

    const conversationTampered = structuredClone(specialized);
    const conversationIndex = conversationTampered.findIndex(
      (result) =>
        result.planTurn.mode === "single" &&
        result.planTurn.relevantTurnIds.length > 0 &&
        result.productionContext.mode === "single_fit",
    );
    if (conversationIndex < 0) throw new Error("single conversation synthetic case is missing");
    const conversationResult = conversationTampered[conversationIndex]!;
    if (conversationResult.productionContext.mode !== "single_fit") {
      throw new Error("single conversation synthetic case is missing");
    }
    conversationResult.productionContext.initial.selectedConversation[0]!.fixtureTurnId =
      "forged-turn";
    expect(() =>
      evaluateSuite(CanonicalGoldenEvaluationSet, conversationTampered, baseline, {
        allowSyntheticCaptures: true,
      }),
    ).toThrow(/direct ledger differs from plan-turn/u);
  });

  it("rejects every fanout ledger identity, turn, and packet drift", () => {
    const { specialized, baseline } = syntheticResults();
    const fanoutIndex = specialized.findIndex((result) => result.planTurn.mode === "fanout");
    if (fanoutIndex < 0) throw new Error("fanout synthetic case is missing");
    const binding = {
      kind: "complete" as const,
      fixtureTurnId: "forged-turn",
      turnId: "30000000-0000-4000-8000-000000000001",
      userMessageId: "40000000-0000-4000-8000-000000000001",
      assistantMessageId: "50000000-0000-4000-8000-000000000001",
    };

    const expectRejected = (
      mutate: (
        result: Extract<(typeof specialized)[number]["productionContext"], { mode: "fanout" }>,
      ) => void,
      message: RegExp,
    ) => {
      const tampered = structuredClone(specialized);
      const result = tampered[fanoutIndex]!;
      if (result.productionContext.mode !== "fanout") {
        throw new Error("fanout synthetic case is missing");
      }
      mutate(result.productionContext);
      expect(() =>
        evaluateSuite(CanonicalGoldenEvaluationSet, tampered, baseline, {
          allowSyntheticCaptures: true,
        }),
      ).toThrow(message);
    };

    expectRejected((production) => {
      production.topics = production.topics.slice(0, 2);
      production.synthesis.ledger.packets = production.synthesis.ledger.packets.slice(0, 2);
    }, /complete plan-turn topic sequence/u);
    expectRejected((production) => {
      production.topics[0]!.topicId = "t2";
    }, /ordered t1, t2, t3|topic ID differs from plan-turn/u);
    expectRejected((production) => {
      production.topics[0]!.terminal.ledger.question = "forged terminal topic question";
    }, /topic ledger differs from plan-turn/u);
    expectRejected((production) => {
      production.topics[0]!.initial.selectedConversation = [binding];
    }, /topic ledger differs from plan-turn/u);
    expectRejected((production) => {
      production.synthesis.ledger.selectedConversation = [binding];
    }, /synthesis selected conversation differs from plan-turn/u);
    expectRejected((production) => {
      production.synthesis.ledger.packets[0]!.topicId = "t2";
    }, /synthesis packet IDs must match/u);
  });

  it("rejects artifact v1 and the pre-cutover shape without the strict plan-turn ledger", () => {
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
    const fanoutIndex = specialized.findIndex((result) => result.planTurn.mode === "fanout");
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
      if (result.planTurn.mode === "single" || result.planTurn.mode === "fanout") {
        result.planTurn.question = "unrelated editorial calendar";
      }
      result.selectorSelections.A = [];
    }
    broken[0] = {
      ...first,
      planTurn: {
        mode: "single",
        question: "unrelated editorial calendar",
        relevantTurnIds: [],
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
      planTurn: { mode: "single", question: "single topic", relevantTurnIds: [] },
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
    expect(failed).toContain("conversation.plan_question_fidelity");
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
      (fixture) => fixture.labels.planTurn.mode === "clarify",
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

    broken[clarifyIndex]!.planTurn = {
      mode: "single",
      question: "wind or solar",
      relevantTurnIds: [],
    };
    broken[clarifyIndex]!.planTurn = {
      mode: "fanout",
      question: "wind or solar",
      topics: [
        { topicId: "t1", question: "wind", relevantTurnIds: [] },
        { topicId: "t2", question: "solar", relevantTurnIds: [] },
      ],
    };
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
    const fanoutIndex = broken.findIndex((result) => result.planTurn.mode === "fanout");
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
