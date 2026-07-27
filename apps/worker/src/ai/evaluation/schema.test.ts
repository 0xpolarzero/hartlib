import { describe, expect, it } from "vitest";

import { CanonicalGoldenEvaluationSet } from "./fixtures/golden-set.v3";
import {
  EvaluationPlanTurnSchema,
  GoldenEvaluationCaseSchema,
  GoldenEvaluationSetSchema,
  type GoldenEvaluationCase,
} from "./schema";

const fixture = (id: string) => {
  const value = CanonicalGoldenEvaluationSet.cases.find((candidate) => candidate.id === id);
  if (value === undefined) throw new Error(`missing fixture ${id}`);
  return structuredClone(value);
};

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
