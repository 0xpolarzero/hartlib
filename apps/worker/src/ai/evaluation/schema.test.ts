import { z } from "zod";
import { describe, expect, it } from "vitest";

import { CanonicalGoldenEvaluationSet } from "./fixtures/golden-set.v4";
import {
  CompactionCaptureSchema,
  CompactionCollectRowSchema,
  CompactionGroupOutputRowSchema,
  CompactionPlanRowSchema,
  EvaluationPlanTurnSchema,
  GoldenEvaluationCaseSchema,
  GoldenEvaluationSetSchema,
  RetrievalCaptureSchema,
  ContextMeasurementCaptureSchema,
  TerminalEvidenceCaptureSchema,
  type GoldenEvaluationCase,
} from "./schema";
import { canonicalIdentityKey } from "../retrieval/rank-fusion";
import { EvaluationResultV3Schema, EvaluationSeedManifestV3Schema } from "./schema.v3";

type RetrievalCapture = z.infer<typeof RetrievalCaptureSchema>;

const fixture = (id: string) => {
  const value = CanonicalGoldenEvaluationSet.cases.find((candidate) => candidate.id === id);
  if (value === undefined) throw new Error(`missing fixture ${id}`);
  return structuredClone(value);
};

const digest = (value: string): string =>
  value
    .split("")
    .map((character) => character.charCodeAt(0).toString(16))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);
const retrievalPlan = {
  action: "search" as const,
  queries: [
    {
      purpose: "energy",
      targets: [{ kind: "documents" as const, filters: {} }],
      all: [{ text: "solar", mode: "term" as const }],
      anyOf: [],
      not: [],
      order: "relevance" as const,
    },
  ],
};
const coverage = {
  queryOrdinal: 1,
  branch: "public_documents" as const,
  status: "applicable" as const,
  hitCount: 1,
  truncated: false,
  cap: 10,
};
const identity = {
  kind: "public_document" as const,
  sourceId: "public:energy",
  documentId: "doc-1",
  snapshotId: "snap-1",
  contentHash: digest("content"),
};
const candidateLedger = [
  {
    candidateId: "c1",
    kind: "document" as const,
    identity,
    identityKey: canonicalIdentityKey(identity),
    provenance: { label: "Energy", purpose: "retrieval evidence", date: null },
    baseRanges: [{ charStart: 0, charEnd: 5 }],
    previewRanges: [{ charStart: 0, charEnd: 5 }],
    previewSha256Hex: digest("preview"),
    renderedTokenCount: 4,
  },
];
const reviewResult = {
  resultId: "r1",
  kind: "document" as const,
  label: "Energy",
  date: null,
  tokenCount: 4,
  preview: "Solar evidence",
  normalizedFusedScore: 1,
  matchedQueryOrdinals: [1],
  branchCoverage: [coverage],
  truncationFlags: { branch: false, candidates: false, hydration: false },
};
const previewRecord = {
  identity,
  snapshotId: "snap-1",
  contentHash: identity.contentHash,
  previewRanges: [{ charStart: 0, charEnd: 5 }],
  previewByteLength: 5,
  previewSha256Hex: digest("preview"),
  fastTokenCount: 2,
  mainTokenCount: 4,
  recordDigestSha256Hex: digest("record"),
};
const providerCoordinate = {
  taskId: "retrieve-t1",
  loopIteration: 0,
  attempt: 0,
  providerRequestIndex: 1,
};
const retrievalCapture = (): RetrievalCapture => ({
  traces: [
    {
      coordinate: {
        taskId: providerCoordinate.taskId,
        loopIteration: 0,
        attempt: 0,
      },
      trace: {
        initialPlan: retrievalPlan,
        review: { action: "accept" as const, reason: "sufficient_coverage" as const },
        replacementPlan: null,
        outcome: "accepted" as const,
      },
    },
  ],
  reviews: [
    {
      coordinate: providerCoordinate,
      inputSha256Hex: digest("review-request"),
      decision: { action: "accept" as const, reason: "sufficient_coverage" as const },
      results: [reviewResult],
      branchCoverage: [coverage],
      truncation: { branch: false, candidates: false, hydration: false },
    },
  ],
  finalResults: [
    {
      outputCoordinate: { nodeId: providerCoordinate.taskId, iteration: 0 },
      ownerCoordinate: {
        taskId: providerCoordinate.taskId,
        loopIteration: 0,
        attempt: 0,
      },
      result: {
        plan: retrievalPlan,
        branchCoverage: [coverage],
        truncation: { branch: false, candidates: false, hydration: false },
        candidates: [
          {
            resultId: "r1",
            identity,
            identityKey: canonicalIdentityKey(identity),
            score: 1,
            rrfK: 60,
            bestRank: 1,
            matchedQueryOrdinals: [1],
            provenance: [{ queryOrdinal: 1, branch: "public_documents" as const, rank: 1 }],
            preview: "Solar evidence",
            previewRanges: [{ charStart: 0, charEnd: 5 }],
            previewSha256Hex: digest("preview"),
            fullTokenCount: 4,
            fastTokenCount: 2,
            mainTokenCount: 4,
            contentHash: identity.contentHash,
            snapshotId: identity.snapshotId,
          },
        ],
      },
    },
  ],
  previews: [
    {
      coordinate: providerCoordinate,
      agentRole: "internal_retrieval" as const,
      slot: "initial" as const,
      requestSha256Hex: digest("review-request"),
      results: [{ ...reviewResult, preview: undefined }].map(
        ({ preview: _preview, ...result }) => result,
      ),
      coverage: [coverage],
      truncation: { branch: false, candidates: false, hydration: false },
      records: [previewRecord],
    },
  ],
});

const compactionGroups = (phase: "initial" | "fallback", nodeId: string) => [
  {
    phase,
    outputCoordinate: { nodeId, iteration: 0 },
    providerCoordinate: { taskId: nodeId, loopIteration: 0, attempt: 0, providerRequestIndex: 1 },
    envelope: {
      groupId: "g1",
      result: {
        decisions: [
          {
            candidateId: "c1",
            action: "select" as const,
            passageIds: ["p1"],
            reason: "key passage",
          },
        ],
      },
      renderedTokenCount: phase === "initial" ? 4 : 2,
    },
  },
];

describe("evaluation golden schemas", () => {
  it("requires clarifications to select no prior turns", () => {
    const ambiguous = fixture("ambiguous-reference-needs-clarification");
    expect(GoldenEvaluationCaseSchema.safeParse(ambiguous).success).toBe(true);

    ambiguous.labels.relevantTurnIds = ["turn-wind"];
    expect(GoldenEvaluationCaseSchema.safeParse(ambiguous).success).toBe(false);

    const selected = fixture("ambiguous-reference-needs-clarification");
    if (selected.labels.planTurn.mode === "fanout") throw new Error("clarification is fanout");
    selected.labels.planTurn.relevantTurnIds = ["turn-wind"];
    expect(GoldenEvaluationCaseSchema.safeParse(selected).success).toBe(false);
  });

  it("rejects every answer-evidence label on a clarification case", () => {
    type ClarificationLabels = GoldenEvaluationCase["labels"];
    const clarificationSource = {
      sourceId: "doc:clarification-test",
      selector: "A" as const,
      kind: "document" as const,
      content: "A valid clarification-only evidence body.",
      ranges: [{ charStart: 0, charEnd: 1 }],
    };
    const validRange = [{ charStart: 0, charEnd: 1 }];
    const withClarificationSource = () => {
      const candidate = fixture("ambiguous-reference-needs-clarification");
      candidate.evidence = [clarificationSource];
      return candidate;
    };
    const expectClarificationIssue = (candidate: GoldenEvaluationCase) => {
      const parsed = GoldenEvaluationCaseSchema.safeParse(candidate);
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      expect(
        parsed.error.issues.some((issue) => issue.message.includes("clarification stops")),
      ).toBe(true);
    };
    const labelMutations = [
      (labels: ClarificationLabels) => {
        labels.acceptableOmissionSourceIds = ["doc:clarification-test"];
      },
      (labels: ClarificationLabels) => {
        labels.acceptableRanges = { "doc:clarification-test": validRange };
      },
      (labels: ClarificationLabels) => {
        labels.supportedClaims = [
          { claimId: "clarification-claim", supportingSourceIds: ["doc:clarification-test"] },
        ];
      },
      (labels: ClarificationLabels) => {
        labels.expectedGaps = [{ gapId: "clarification-gap", description: "answer gap" }];
      },
      (labels: ClarificationLabels) => {
        labels.retrievalSelectors = ["A"];
      },
      (labels: ClarificationLabels) => {
        labels.requiredSourceIds = ["doc:clarification-test"];
      },
      (labels: ClarificationLabels) => {
        labels.relevantSourceIds = ["doc:clarification-test"];
      },
    ];
    for (const mutate of labelMutations) {
      const candidate = withClarificationSource();
      mutate(candidate.labels);
      expectClarificationIssue(candidate);
    }
  });

  it("requires fanout topics to be two or three ordered unique IDs", () => {
    const fanout = fixture("cross-cutting-separable-energy-question");
    const planTurn = fanout.labels.planTurn;
    if (planTurn.mode !== "fanout") throw new Error("fanout fixture is not fanout");
    expect(GoldenEvaluationCaseSchema.safeParse(fanout).success).toBe(true);

    const tooShort = structuredClone(fanout);
    if (tooShort.labels.planTurn.mode !== "fanout") throw new Error("fanout fixture is not fanout");
    tooShort.labels.planTurn.topics = tooShort.labels.planTurn.topics.slice(0, 1);
    expect(GoldenEvaluationCaseSchema.safeParse(tooShort).success).toBe(false);

    const tooLong = structuredClone(fanout);
    if (tooLong.labels.planTurn.mode !== "fanout") throw new Error("fanout fixture is not fanout");
    tooLong.labels.planTurn.topics.push({ ...tooLong.labels.planTurn.topics[2]! });
    expect(GoldenEvaluationCaseSchema.safeParse(tooLong).success).toBe(false);

    const outOfOrder = structuredClone(fanout);
    if (outOfOrder.labels.planTurn.mode !== "fanout")
      throw new Error("fanout fixture is not fanout");
    const topics = outOfOrder.labels.planTurn.topics;
    [topics[0], topics[1]] = [topics[1]!, topics[0]!];
    expect(GoldenEvaluationCaseSchema.safeParse(outOfOrder).success).toBe(false);

    const duplicate = structuredClone(fanout);
    if (duplicate.labels.planTurn.mode !== "fanout")
      throw new Error("fanout fixture is not fanout");
    duplicate.labels.planTurn.topics[1]!.topicId = "t1";
    expect(GoldenEvaluationCaseSchema.safeParse(duplicate).success).toBe(false);

    const twoTopics = structuredClone(fanout);
    if (twoTopics.labels.planTurn.mode !== "fanout")
      throw new Error("fanout fixture is not fanout");
    twoTopics.labels.planTurn.topics = twoTopics.labels.planTurn.topics.slice(0, 2);
    expect(GoldenEvaluationCaseSchema.safeParse(twoTopics).success).toBe(true);

    const duplicateTopicTurn = structuredClone(fanout);
    if (duplicateTopicTurn.labels.planTurn.mode !== "fanout")
      throw new Error("fanout fixture is not fanout");
    duplicateTopicTurn.labels.planTurn.topics[0]!.relevantTurnIds = ["turn-wind"];
    duplicateTopicTurn.labels.planTurn.topics[1]!.relevantTurnIds = ["turn-wind"];
    duplicateTopicTurn.labels.relevantTurnIds = ["turn-wind", "turn-wind"];
    expect(GoldenEvaluationCaseSchema.safeParse(duplicateTopicTurn).success).toBe(false);

    const duplicateTopicQuestion = structuredClone(fanout);
    if (duplicateTopicQuestion.labels.planTurn.mode !== "fanout")
      throw new Error("fanout fixture is not fanout");
    duplicateTopicQuestion.labels.planTurn.topics[1]!.question =
      duplicateTopicQuestion.labels.planTurn.topics[0]!.question;
    expect(GoldenEvaluationCaseSchema.safeParse(duplicateTopicQuestion).success).toBe(false);
  });

  it("rejects duplicate turn selections in captured plan-turn results", () => {
    const duplicate = {
      mode: "fanout" as const,
      question: "Compare the two topics",
      topics: [
        { topicId: "t1" as const, question: "Solar", relevantTurnIds: ["turn-wind"] },
        { topicId: "t2" as const, question: "Storage", relevantTurnIds: ["turn-wind"] },
      ],
    };
    expect(
      GoldenEvaluationCaseSchema.safeParse({
        ...fixture("cross-cutting-separable-energy-question"),
        labels: {
          ...fixture("cross-cutting-separable-energy-question").labels,
          planTurn: {
            ...fixture("cross-cutting-separable-energy-question").labels.planTurn,
            topics: duplicate.topics,
          },
        },
      }).success,
    ).toBe(false);
    expect(EvaluationPlanTurnSchema.safeParse(duplicate).success).toBe(false);

    const duplicateQuestions = {
      ...duplicate,
      topics: duplicate.topics.map((topic) => ({ ...topic, relevantTurnIds: [] })),
    };
    duplicateQuestions.topics[1]!.question = duplicateQuestions.topics[0]!.question;
    expect(EvaluationPlanTurnSchema.safeParse(duplicateQuestions).success).toBe(false);
  });

  it("rejects conflicting top-level and branch turn selections", () => {
    const single = fixture("follow-up-with-irrelevant-recent-turn");
    if (single.labels.planTurn.mode !== "single") throw new Error("single fixture is not single");
    single.labels.planTurn.relevantTurnIds = [];
    expect(GoldenEvaluationCaseSchema.safeParse(single).success).toBe(false);

    const fanout = fixture("cross-cutting-separable-energy-question");
    if (fanout.labels.planTurn.mode !== "fanout") throw new Error("fanout fixture is not fanout");
    fanout.labels.planTurn.topics[0]!.relevantTurnIds = ["invented-turn"];
    expect(GoldenEvaluationCaseSchema.safeParse(fanout).success).toBe(false);
  });

  it("accepts the canonical set only at its declared version", () => {
    expect(GoldenEvaluationSetSchema.safeParse(CanonicalGoldenEvaluationSet).success).toBe(true);
    expect(
      GoldenEvaluationSetSchema.safeParse({ ...CanonicalGoldenEvaluationSet, version: 2 }).success,
    ).toBe(false);
  });
});

describe("v4 retrieval, compaction, and terminal rows", () => {
  it("accepts multi-topic retrieval arrays and rejects duplicate provider coordinates", () => {
    const first = retrievalCapture();
    const second = structuredClone(first);
    second.traces[0]!.coordinate.taskId = "retrieve-t2";
    second.reviews[0]!.coordinate.taskId = "retrieve-t2";
    second.finalResults[0]!.outputCoordinate.nodeId = "retrieve-t2";
    second.finalResults[0]!.ownerCoordinate.taskId = "retrieve-t2";
    second.previews[0]!.coordinate.taskId = "retrieve-t2";
    const multi = {
      traces: [...first.traces, ...second.traces],
      reviews: [...first.reviews, ...second.reviews],
      finalResults: [...first.finalResults, ...second.finalResults],
      previews: [...first.previews, ...second.previews],
    };
    expect(RetrievalCaptureSchema.safeParse(multi).success).toBe(true);
    const tamperedFinal = structuredClone(first);
    tamperedFinal.finalResults[0]!.result!.candidates[0]!.resultId = "r2";
    expect(RetrievalCaptureSchema.safeParse(tamperedFinal).success).toBe(false);
    expect(
      RetrievalCaptureSchema.safeParse({
        ...multi,
        reviews: [...multi.reviews, structuredClone(multi.reviews[0]!)],
      }).success,
    ).toBe(false);
  });

  it("requires a null final result for no-evidence and binds the exact review preview", () => {
    const nonemptyReview = retrievalCapture();
    nonemptyReview.traces[0]!.trace.review = {
      action: "no_evidence",
      reason: "no_supporting_evidence",
    };
    nonemptyReview.traces[0]!.trace.outcome = "no_evidence";
    nonemptyReview.reviews[0]!.decision = {
      action: "no_evidence",
      reason: "no_supporting_evidence",
    };
    nonemptyReview.finalResults[0]!.result = null;
    expect(RetrievalCaptureSchema.safeParse(nonemptyReview).success).toBe(true);
    const skipped = retrievalCapture();
    skipped.traces[0]!.trace.review = null;
    skipped.traces[0]!.trace.initialPlan = { action: "skip", reason: "disabled" };
    skipped.traces[0]!.trace.outcome = "skipped";
    skipped.reviews = [];
    skipped.finalResults[0]!.result = null;
    skipped.previews = [];
    expect(RetrievalCaptureSchema.safeParse(skipped).success).toBe(true);
    skipped.finalResults[0]!.result = retrievalCapture().finalResults[0]!.result;
    expect(RetrievalCaptureSchema.safeParse(skipped).success).toBe(false);
    const value = retrievalCapture();
    value.traces[0]!.trace.review = {
      action: "no_evidence",
      reason: "no_supporting_evidence",
    };
    value.traces[0]!.trace.outcome = "no_evidence";
    value.reviews[0]!.decision = {
      action: "no_evidence",
      reason: "no_supporting_evidence",
    };
    value.reviews[0]!.results = [];
    value.finalResults[0]!.result = null;
    value.previews[0]!.results = [];
    value.previews[0]!.records = [];
    expect(RetrievalCaptureSchema.safeParse(value).success).toBe(true);
    value.finalResults[0]!.result = {
      plan: retrievalPlan,
      branchCoverage: [],
      truncation: { branch: false, candidates: false, hydration: false },
      candidates: [],
    };
    expect(RetrievalCaptureSchema.safeParse(value).success).toBe(false);
    value.finalResults[0]!.result = null;
    value.reviews[0]!.inputSha256Hex = digest("tampered");
    expect(RetrievalCaptureSchema.safeParse(value).success).toBe(false);
  });

  it("preserves g1 ownership across initial and fallback plan/group rows", () => {
    const initialManifest = {
      decisions: [
        { candidateId: "c1", action: "compact" as const, groupId: "g1", reason: "group" },
      ],
      groups: [{ groupId: "g1", renderedTokenBudget: 10 }],
    };
    const fallbackManifest = {
      decisions: [
        { candidateId: "c1", action: "tighten" as const, groupId: "g1", reason: "tighten" },
      ],
      groups: [{ groupId: "g1", renderedTokenBudget: 5 }],
    };
    const groupDefinition = {
      groupId: "g1",
      candidateIds: ["c1"],
      renderedTokenBudget: 10,
      mode: "normal" as const,
    };
    const fallbackGroupDefinition = { ...groupDefinition, renderedTokenBudget: 5 };
    const initialGroup = compactionGroups("initial", "single-compact-g001")[0]!;
    const fallbackGroup = compactionGroups("fallback", "single-fallback-g001")[0]!;
    const initialCollect = {
      outputCoordinate: { nodeId: "single-compact-collect", iteration: 0 },
      phase: "initial" as const,
      groups: [groupDefinition],
      taskIds: ["single-compact-g001"],
      envelopes: [initialGroup.envelope],
      selections: [
        {
          candidateId: "c1",
          action: "range" as const,
          passageIds: ["p1"],
          ranges: [{ charStart: 0, charEnd: 5 }],
          groupId: "g1",
        },
      ],
      repairUsed: false,
    };
    const fallbackCollect = {
      ...initialCollect,
      outputCoordinate: { nodeId: "single-fallback-collect", iteration: 0 },
      phase: "fallback" as const,
      groups: [fallbackGroupDefinition],
      taskIds: ["single-fallback-g001"],
      envelopes: [fallbackGroup.envelope],
      repairUsed: true,
    };
    const compactionValue = {
      plans: [
        {
          phase: "initial" as const,
          outputCoordinate: { nodeId: "single-compact-plan", iteration: 0 },
          providerCoordinate: {
            taskId: "single-compact-plan",
            loopIteration: 0,
            attempt: 0,
            providerRequestIndex: 1,
          },
          manifest: initialManifest,
          groups: [groupDefinition],
        },
        {
          phase: "fallback" as const,
          outputCoordinate: { nodeId: "single-fallback-plan", iteration: 0 },
          providerCoordinate: {
            taskId: "single-fallback-plan",
            loopIteration: 0,
            attempt: 0,
            providerRequestIndex: 1,
          },
          manifest: fallbackManifest,
          groups: [fallbackGroupDefinition],
        },
      ],
      groups: [initialGroup, fallbackGroup],
      collects: [initialCollect, fallbackCollect],
      contexts: [
        {
          outputCoordinate: { nodeId: "single-measure", iteration: 0 },
          stage: "initial" as const,
          consumerTaskId: "single-answer",
          status: "needs_compaction" as const,
          inputTokens: 20,
          usableInputTokens: 10,
          compactionRan: false,
          candidateLedger,
          selectedCandidateIds: ["c1"],
          sourceKeys: ["source-1"],
        },
      ],
      measurements: [],
    };
    expect(CompactionCaptureSchema.safeParse(compactionValue).success).toBe(true);
    const tamperedContext = structuredClone(compactionValue);
    tamperedContext.contexts[0]!.candidateLedger[0]!.identityKey = "tampered";
    expect(CompactionCaptureSchema.safeParse(tamperedContext).success).toBe(false);
    expect(
      CompactionPlanRowSchema.safeParse({
        phase: "fallback",
        outputCoordinate: { nodeId: "single-fallback-plan", iteration: 0 },
        providerCoordinate: {
          taskId: "single-fallback-plan",
          loopIteration: 0,
          attempt: 0,
          providerRequestIndex: 1,
        },
        manifest: {
          decisions: [{ candidateId: "c1", action: "keep", reason: "bad" }],
          groups: [],
        },
        groups: [],
      }).success,
    ).toBe(false);
    expect(
      ContextMeasurementCaptureSchema.safeParse({
        coordinate: { taskId: "single-measure", loopIteration: 0, attempt: 0 },
        consumerTaskId: "single-answer",
        mandatoryInputTokens: 2,
        discretionaryInputTokens: 1,
        totalInputTokens: 3,
        requestedOutputTokens: 5,
        usableInputTokens: 10,
        contextWindow: 20,
        status: "ready",
        compactionRan: false,
        compactionFeedback: [],
        restrictedContextLedger: {
          requestKind: "direct",
          modelId: "glm-5-turbo",
          requestSha256Hex: digest("measurement"),
          inputTokens: 3,
          usableInputTokens: 10,
          requestedOutputTokens: 5,
          selectedConversation: [],
          question: "energy",
          gaps: [],
          sources: [],
        },
      }).success,
    ).toBe(true);
  });

  it("rejects malformed group envelopes and duplicate group output coordinates", () => {
    const row = compactionGroups("initial", "single-compact-g001")[0]!;
    expect(CompactionGroupOutputRowSchema.safeParse(row).success).toBe(true);
    expect(
      CompactionGroupOutputRowSchema.safeParse({
        ...row,
        envelope: {
          ...row.envelope,
          result: {
            decisions: [{ candidateId: "c1", action: "select", passageIds: [], reason: "bad" }],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      CompactionCollectRowSchema.safeParse({
        outputCoordinate: { nodeId: "single-compact-collect", iteration: 0 },
        phase: "initial",
        groups: [{ groupId: "g1", candidateIds: ["c1"], renderedTokenBudget: 10, mode: "normal" }],
        taskIds: ["single-compact-g001"],
        envelopes: [row.envelope],
        selections: [],
        repairUsed: false,
      }).success,
    ).toBe(true);
  });

  it("accepts direct, topic, and synthesis terminal proof/token rows", () => {
    const source = {
      sourceKey: "k_cn_abcdefghijklmnopqrstuv_1",
      candidateId: "c1",
      kind: "document" as const,
      label: "Energy",
      ranges: [{ charStart: 0, charEnd: 5 }],
      contentHash: digest("content"),
      sourceIdentityDigest: digest("identity"),
    };
    const synthesisSource = {
      sourceKey: source.sourceKey,
      kind: source.kind,
      label: source.label,
      ranges: source.ranges,
      contentHash: source.contentHash,
      sourceIdentityDigest: source.sourceIdentityDigest,
    };
    const requests = ["single-answer", "topic-t1-answer", "fanout-synthesis"].map(
      (consumerTaskId, index) => ({
        coordinate: {
          taskId: consumerTaskId,
          loopIteration: 0,
          attempt: 0,
          providerRequestIndex: index,
        },
        consumerTaskId,
        ...(consumerTaskId.startsWith("topic-") ? { topicId: "t1" as const } : {}),
        requestKind: consumerTaskId.startsWith("topic-")
          ? ("topic" as const)
          : consumerTaskId === "fanout-synthesis"
            ? ("synthesis" as const)
            : ("direct" as const),
        requestSha256Hex: digest(`request-${index}`),
        localInputTokens: 10,
        providerInputTokens: index === 1 ? 9 : 10,
        requestedOutputTokens: 5,
        usableInputTokens: 20,
        proofDigests: [digest(`proof-${index}`)],
        sourceMap: [consumerTaskId === "fanout-synthesis" ? synthesisSource : source],
        evidenceSha256Hex: digest(`evidence-${index}`),
      }),
    );
    expect(TerminalEvidenceCaptureSchema.safeParse({ requests }).success).toBe(true);
    const { sourceIdentityDigest: _sourceIdentityDigest, ...sourceWithoutIdentityDigest } =
      requests[0]!.sourceMap[0]!;
    expect(
      TerminalEvidenceCaptureSchema.safeParse({
        requests: [
          {
            ...requests[0]!,
            sourceMap: [sourceWithoutIdentityDigest],
          },
        ],
      }).success,
    ).toBe(false);
    const memorySource = { ...source, kind: "memory" as const };
    expect(
      TerminalEvidenceCaptureSchema.safeParse({
        requests: [
          {
            ...requests[0]!,
            sourceMap: [memorySource],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      TerminalEvidenceCaptureSchema.safeParse({
        requests: [...requests, structuredClone(requests[0]!)],
      }).success,
    ).toBe(false);
    expect(
      TerminalEvidenceCaptureSchema.safeParse({
        requests: [{ ...requests[0]!, consumerTaskId: "wrong-task" }],
      }).success,
    ).toBe(false);
    expect(
      TerminalEvidenceCaptureSchema.safeParse({
        requests: [{ ...requests[0]!, proofDigests: [digest("same"), digest("same")] }],
      }).success,
    ).toBe(false);
    expect(
      TerminalEvidenceCaptureSchema.safeParse({
        requests: [{ ...requests[0]!, localInputTokens: 21 }],
      }).success,
    ).toBe(false);
  });
});

describe("historical v3 evaluation schemas", () => {
  it("accepts a retained v3 seed manifest and never accepts a v4 version", () => {
    const manifest = {
      artifactVersion: 3 as const,
      goldenSetVersion: 3 as const,
      sessionId: "00000000-0000-4000-8000-000000000001",
      caseId: "retained-v3",
      topology: "specialized" as const,
      userId: "user-v3",
      companyId: "00000000-0000-4000-8000-000000000002",
      chatId: "00000000-0000-4000-8000-000000000003",
      userMessageId: "00000000-0000-4000-8000-000000000004",
      aiRunId: "00000000-0000-4000-8000-000000000005",
      turnBindings: [],
      sourceBindings: [],
    };
    expect(EvaluationSeedManifestV3Schema.safeParse(manifest).success).toBe(true);
    expect(
      EvaluationSeedManifestV3Schema.safeParse({ ...manifest, artifactVersion: 4 }).success,
    ).toBe(false);
    expect(EvaluationResultV3Schema.safeParse({ artifactVersion: 4 }).success).toBe(false);
  });
});
