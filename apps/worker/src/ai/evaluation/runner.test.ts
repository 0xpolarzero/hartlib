import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { EvaluationDimensions, type GoldenEvaluationCase } from "./schema";
import { CanonicalGoldenEvaluationSet } from "./fixtures/golden-set.v4";
import {
  evaluateSuite,
  measureCanonicalEvaluationRequestTokens,
  terminalRequestEvidenceSha256Hex,
} from "./runner";

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const sourceRanges = (fixture: GoldenEvaluationCase, sourceId: string) => {
  const source = fixture.evidence.find((candidate) => candidate.sourceId === sourceId);
  if (source === undefined) throw new Error(`missing source ${sourceId}`);
  return source.kind === "document"
    ? (fixture.labels.acceptableRanges[sourceId] ?? source.ranges)
    : [];
};

describe("canonical v4 evaluation runner", () => {
  it("covers every canonical dimension and keeps the exact oversized token gate", () => {
    expect(
      new Set(CanonicalGoldenEvaluationSet.cases.flatMap((fixture) => fixture.dimensions)),
    ).toEqual(new Set(EvaluationDimensions));
    const oversized = CanonicalGoldenEvaluationSet.cases.find((fixture) =>
      fixture.dimensions.includes("oversized_evidence"),
    );
    if (oversized === undefined) throw new Error("missing oversized fixture");
    const selections = oversized.evidence.map((source) => ({
      sourceId: source.sourceId,
      ranges: sourceRanges(oversized, source.sourceId),
    }));
    expect(measureCanonicalEvaluationRequestTokens(oversized, selections)).toBe(8787);
  });

  it("keeps schema parsing as the first gate and rejects legacy artifact fields", () => {
    const legacy = [{ productionContext: {}, caseId: "legacy" }];
    expect(() =>
      evaluateSuite(CanonicalGoldenEvaluationSet, legacy, legacy, { allowSyntheticCaptures: true }),
    ).toThrow();
    expect(() =>
      evaluateSuite(CanonicalGoldenEvaluationSet, [], [], { allowSyntheticCaptures: true }),
    ).toThrow();
  });

  it("recomputes terminal evidence digests over every request field", () => {
    const base = {
      coordinate: { taskId: "answer", loopIteration: 0, attempt: 0, providerRequestIndex: 0 },
      requestKind: "direct" as const,
      consumerTaskId: "answer",
      requestSha256Hex: digest("request"),
      localInputTokens: 10,
      providerInputTokens: 10,
      requestedOutputTokens: 100,
      usableInputTokens: 1000,
      sourceMap: [
        {
          sourceKey: `k_cn_${"A".repeat(22)}_1`,
          candidateId: "c1",
          kind: "document" as const,
          label: "source",
          ranges: [{ charStart: 0, charEnd: 10 }],
        },
      ],
      proofDigests: [digest("proof")],
    };
    const first = terminalRequestEvidenceSha256Hex(base);
    const second = {
      ...base,
      coordinate: { ...base.coordinate, providerRequestIndex: 1 },
      requestKind: "topic" as const,
      topicId: "t1" as const,
    };
    expect(terminalRequestEvidenceSha256Hex(second)).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(terminalRequestEvidenceSha256Hex({ ...base, providerInputTokens: 11 })).not.toBe(first);
    expect(
      terminalRequestEvidenceSha256Hex({ ...base, requestKind: "topic", topicId: "t1" }),
    ).not.toBe(first);
    expect(terminalRequestEvidenceSha256Hex({ ...base, sourceMap: [] })).not.toBe(first);
  });

  it("rejects malformed terminal evidence input before scoring", () => {
    const malformed = {
      coordinate: { taskId: "answer", loopIteration: 0, attempt: 0, providerRequestIndex: 0 },
      requestKind: "synthesis" as const,
      consumerTaskId: "answer",
      requestSha256Hex: digest("request"),
      localInputTokens: 10,
      providerInputTokens: 10,
      requestedOutputTokens: 100,
      usableInputTokens: 1000,
      sourceMap: [
        {
          sourceKey: `k_cn_${"A".repeat(22)}_1`,
          candidateId: "c1",
          kind: "document" as const,
          label: "source",
          ranges: [],
        },
      ],
      proofDigests: [],
      evidenceSha256Hex: "a".repeat(64),
    };
    expect(() =>
      evaluateSuite(CanonicalGoldenEvaluationSet, [malformed], [malformed], {
        allowSyntheticCaptures: true,
      }),
    ).toThrow();
  });
});
