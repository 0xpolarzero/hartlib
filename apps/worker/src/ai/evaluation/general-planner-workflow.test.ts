import * as SmithersTaskRuntimeModule from "@smithers-orchestrator/driver/task-runtime";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { PiRuntimeBoundary } from "../e2e/deterministic-provider";
import { resolveRegisteredModel } from "../runtime/model-registry";
import type { PiCompletion } from "../runtime/pi-boundary";
import type { ProviderRequest } from "../runtime/provider-request";
import { namespacedDocumentEvidenceIdentity, sha256Base64Url } from "../runtime/canonicalization";
import { CanonicalGoldenEvaluationSet } from "./fixtures/golden-set.v3";
import {
  aiEvaluationGeneralPlannerSchemas,
  executeGeneralPlannerProviderTurn,
  generalPlannerRuntimeInputSchema,
  GeneralPlannerEvaluationPrompt,
  GeneralPlannerProviderOutputSchema,
  validateGeneralPlannerOutput,
} from "./general-planner-workflow";

const withTaskRuntime = (
  SmithersTaskRuntimeModule as unknown as {
    readonly withTaskRuntime: <Value>(
      runtime: {
        readonly runId: string;
        readonly stepId: string;
        readonly attempt: number;
        readonly iteration: number;
        readonly signal: AbortSignal;
        readonly db: Readonly<Record<string, unknown>>;
        readonly heartbeat: (data?: unknown) => void;
        readonly lastHeartbeat: unknown | null;
      },
      execute: () => Value,
    ) => Value;
  }
).withTaskRuntime;

const completion = (name: string, arguments_: Readonly<Record<string, unknown>>): PiCompletion => ({
  text: "",
  toolCalls: [{ id: crypto.randomUUID(), name, arguments: arguments_ }],
  usage: {
    inputTokens: 10,
    outputTokens: 2,
    cachedTokens: 0,
    reasoningTokens: 0,
    totalTokens: 12,
    stopReason: "toolUse",
  },
  stopReason: "toolUse",
});

const parallelCompletion = (
  calls: readonly {
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }[],
): PiCompletion => ({
  text: "",
  toolCalls: calls.map((call) => ({ id: crypto.randomUUID(), ...call })),
  usage: {
    inputTokens: 10,
    outputTokens: calls.length,
    cachedTokens: 0,
    reasoningTokens: 0,
    totalTokens: 10 + calls.length,
    stopReason: "toolUse",
  },
  stopReason: "toolUse",
});

const evaluationSourceIdentityOptions = (
  fixture: (typeof CanonicalGoldenEvaluationSet.cases)[number],
) => {
  const documents = new Map(
    fixture.evidence.flatMap((source, index) =>
      source.kind !== "document"
        ? []
        : [
            [
              source.sourceId,
              {
                documentId: source.sourceId,
                snapshotId: `test-version-${index + 1}`,
                contentHash: createHash("sha256").update(source.content, "utf8").digest("hex"),
                source: {
                  kind: "public" as const,
                  sourceId: `public:evaluation-test-${index + 1}`,
                },
              },
            ] as const,
          ],
    ),
  );
  return {
    sourceExposureIdentity: (input: {
      readonly sourceId: string;
      readonly sourceKind: "document" | "chat_message" | "memory" | "web";
      readonly charStart: number;
      readonly charEnd: number;
      readonly visibleText: string;
    }) => {
      const binding = documents.get(input.sourceId);
      if (input.sourceKind === "document" && binding !== undefined) {
        const logicalSourceIdentity = namespacedDocumentEvidenceIdentity(
          binding.source,
          binding.documentId,
        );
        return {
          logicalSourceIdentity,
          contentItemIdentity: `${logicalSourceIdentity}:${binding.snapshotId}:${sha256Base64Url(
            JSON.stringify([{ charStart: input.charStart, charEnd: input.charEnd }]),
          )}`,
          documentId: binding.documentId,
        };
      }
      return {
        logicalSourceIdentity: input.sourceId,
        contentItemIdentity: `${input.sourceId}:${input.charStart}:${input.charEnd}:${createHash(
          "sha256",
        )
          .update(input.visibleText, "utf8")
          .digest("hex")}`,
      };
    },
    sourceIdentitySidecar: (input: {
      readonly sourceId: string;
      readonly sourceKind: "document" | "chat_message" | "memory" | "web";
      readonly charStart: number;
      readonly charEnd: number;
    }) => {
      const binding = documents.get(input.sourceId);
      if (input.sourceKind !== "document" || binding === undefined) return undefined;
      return {
        snapshotId: binding.snapshotId,
        contentHash: binding.contentHash,
        source: binding.source,
        ranges: [{ charStart: input.charStart, charEnd: input.charEnd }],
      };
    },
  };
};

describe("offline single-general-planner evaluation workflow", () => {
  it("rejects unknown fields at durable wrappers and nested positions", () => {
    const value = {
      planTurn: { mode: "clarify" as const, question: "Which period?" },
      selectedSources: [],
      answerContent: "Please specify the period.",
      citationSourceIds: [],
      memoryProposals: [],
    };
    expect(
      generalPlannerRuntimeInputSchema.safeParse({
        aiRunId: crypto.randomUUID(),
        runId: "smithers-run",
      }).success,
    ).toBe(true);
    expect(
      generalPlannerRuntimeInputSchema.safeParse({
        aiRunId: crypto.randomUUID(),
        runId: "smithers-run",
        forged: true,
      }).success,
    ).toBe(false);
    expect(GeneralPlannerProviderOutputSchema.safeParse(value).success).toBe(true);
    expect(GeneralPlannerProviderOutputSchema.safeParse({ ...value, forged: true }).success).toBe(
      false,
    );
    expect(
      GeneralPlannerProviderOutputSchema.safeParse({
        ...value,
        planTurn: { ...value.planTurn, forged: true },
      }).success,
    ).toBe(false);
    expect(
      GeneralPlannerProviderOutputSchema.safeParse({
        ...value,
        memoryProposals: [
          {
            action: "create",
            kind: "fact",
            content: "A durable fact",
            targetMemorySourceId: null,
            forged: true,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      aiEvaluationGeneralPlannerSchemas.input.safeParse({
        aiRunId: crypto.randomUUID(),
        forged: true,
      }).success,
    ).toBe(false);
    expect(
      aiEvaluationGeneralPlannerSchemas.input.safeParse({
        caseId: "case-1",
        aiRunId: crypto.randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      aiEvaluationGeneralPlannerSchemas.aiEvaluationGeneralPlanner.safeParse({
        value,
        forged: true,
      }).success,
    ).toBe(false);
  });

  it("pins supplied turn identities and kind-specific range rules", () => {
    expect(GeneralPlannerEvaluationPrompt).toContain(
      "When the supplied conversation is empty, relevantTurnIds MUST be []",
    );
    expect(GeneralPlannerEvaluationPrompt).toContain(
      "MUST be omitted for web, chat_message, and memory evidence",
    );
    expect(GeneralPlannerEvaluationPrompt).toContain(
      "every non-document source MUST use ranges: []",
    );
    expect(GeneralPlannerEvaluationPrompt).toContain(
      "A turnId may appear only in planTurn.relevantTurnIds",
    );
    expect(GeneralPlannerEvaluationPrompt).toContain("multiple plausible same-kind antecedents");
    expect(GeneralPlannerEvaluationPrompt).toContain("Do not infer a recency pairing");
    expect(GeneralPlannerEvaluationPrompt).toContain(
      "include both binding and conclusion in the first search query",
    );

    const emptyConversation = CanonicalGoldenEvaluationSet.cases.find(
      (fixture) => fixture.conversation.length === 0,
    );
    if (emptyConversation === undefined) throw new Error("empty-conversation fixture is missing");
    const result = {
      planTurn: {
        mode: "single" as const,
        question: emptyConversation.currentMessage,
        relevantTurnIds: [],
      },
      selectedSources: [],
      answerContent: "No supplied evidence answers the question.",
      citationSourceIds: [],
      memoryProposals: [],
    };
    expect(validateGeneralPlannerOutput(emptyConversation, result)).toEqual(result);
    expect(() =>
      validateGeneralPlannerOutput(emptyConversation, {
        ...result,
        planTurn: { ...result.planTurn, relevantTurnIds: ["invented-turn"] },
      }),
    ).toThrow(/unknown conversation turn/u);

    const ambiguous = CanonicalGoldenEvaluationSet.cases.find(
      (fixture) => fixture.id === "ambiguous-reference-needs-clarification",
    );
    if (ambiguous === undefined) throw new Error("ambiguous-comparison fixture is missing");
    const clarification = {
      planTurn: {
        mode: "clarify" as const,
        question: "Should I compare the wind result or the solar result?",
      },
      selectedSources: [],
      answerContent: "Should I compare the wind result or the solar result?",
      citationSourceIds: [],
      memoryProposals: [],
    };
    expect(validateGeneralPlannerOutput(ambiguous, clarification)).toEqual(clarification);
    expect(() =>
      validateGeneralPlannerOutput(ambiguous, {
        planTurn: {
          mode: "single",
          question: "Compare solar and wind output results",
          relevantTurnIds: ["turn-wind", "turn-solar"],
        },
        selectedSources: [
          { sourceId: "turn-wind", ranges: [] },
          { sourceId: "turn-solar", ranges: [] },
        ],
        answerContent: "Solar increased more than wind.",
        citationSourceIds: ["turn-wind", "turn-solar"],
        memoryProposals: [],
      }),
    ).toThrow(/unknown source/u);

    const crossCutting = CanonicalGoldenEvaluationSet.cases.find(
      (fixture) => fixture.id === "cross-cutting-separable-energy-question",
    );
    const web = crossCutting?.evidence.find((source) => source.kind === "web");
    if (crossCutting === undefined || web === undefined) {
      throw new Error("cross-cutting web fixture is missing");
    }
    expect(() =>
      validateGeneralPlannerOutput(crossCutting, {
        planTurn: {
          mode: "single",
          question: crossCutting.currentMessage,
          relevantTurnIds: [],
        },
        selectedSources: [{ sourceId: web.sourceId, ranges: [{ charStart: 0, charEnd: 1 }] }],
        answerContent: "A web-backed answer.",
        citationSourceIds: [web.sourceId],
        memoryProposals: [],
      }),
    ).toThrow(/assigned ranges to non-document evidence/u);
  });

  it("keeps every oversized tool-loop request under the exact main gate without label ranges", async () => {
    const fixture = CanonicalGoldenEvaluationSet.cases.find((candidate) =>
      candidate.dimensions.includes("oversized_evidence"),
    );
    if (fixture === undefined) throw new Error("oversized fixture is missing");
    const selectedSources = fixture.evidence.map((source) => {
      const labeledRange = fixture.labels.acceptableRanges[source.sourceId]?.[0];
      if (source.kind === "document" && labeledRange === undefined) {
        throw new Error("oversized fixture range is missing");
      }
      return {
        sourceId: source.sourceId,
        ranges: labeledRange === undefined ? [] : [labeledRange],
      };
    });
    const documentSelections = selectedSources.filter((selection) =>
      fixture.evidence.some(
        (source) => source.sourceId === selection.sourceId && source.kind === "document",
      ),
    );
    const requests: ProviderRequest[] = [];
    let call = 0;
    const boundary: PiRuntimeBoundary = {
      complete: async (request) => {
        requests.push(request);
        const model = resolveRegisteredModel(request.model);
        const inputTokens = model.countRequestTokens(request);
        const usable = Math.min(100_000, model.contextWindow - request.requestedOutputTokens);
        expect(inputTokens).toBeLessThanOrEqual(usable);
        call += 1;
        if (call === 1) {
          return completion("search_evidence", { query: "binding conclusion" });
        }
        if (call === 2) {
          return parallelCompletion(
            documentSelections.map((selection) => ({
              name: "inspect_evidence",
              arguments: { sourceId: selection.sourceId, range: selection.ranges[0] },
            })),
          );
        }
        if (call === 3) {
          return completion("search_evidence", { query: "preference" });
        }
        return completion("emit_general_planner_result", {
          planTurn: {
            mode: "single",
            question: fixture.currentMessage,
            relevantTurnIds: [],
          },
          selectedSources,
          answerContent:
            "In the four saved audit formats, the six trials report curtailment reductions of 12 to 17 percent.",
          citationSourceIds: selectedSources.map((source) => source.sourceId),
          memoryProposals: [],
        });
      },
      stream: async () => {
        throw new Error("general-planner baseline must not stream");
      },
    };

    const output = await withTaskRuntime(
      {
        runId: "ai-evaluation-general-planner:test",
        stepId: "evaluation-general-planner",
        attempt: 1,
        iteration: 0,
        signal: new AbortController().signal,
        db: {},
        heartbeat: () => undefined,
        lastHeartbeat: null,
      },
      () =>
        executeGeneralPlannerProviderTurn(
          boundary,
          fixture,
          evaluationSourceIdentityOptions(fixture),
        ),
    );

    expect(output.selectedSources).toEqual(selectedSources);
    expect(requests).toHaveLength(4);
    const inspectTool = requests[0]!.tools?.find((tool) => tool.name === "inspect_evidence");
    expect(inspectTool?.description).toContain("range is valid only for kind=document");
    expect(inspectTool?.description).toContain("must be omitted for web, chat_message, and memory");
    const initialUser = requests[0]!.messages.find((message) => message.role === "user")?.content;
    expect(initialUser).not.toContain(fixture.evidence[0]!.content.slice(0, 1_000));
    expect(initialUser!.length).toBeLessThan(10_000);
    expect(requests[1]!.messages.filter((message) => message.role === "tool")).toHaveLength(1);
    expect(requests[2]!.messages.filter((message) => message.role === "tool")).toHaveLength(7);
    expect(requests[3]!.messages.filter((message) => message.role === "tool")).toHaveLength(8);
  });

  it("continues a no-range oversized document inspection through the real agent client", async () => {
    const fixture = CanonicalGoldenEvaluationSet.cases.find((candidate) =>
      candidate.dimensions.includes("oversized_evidence"),
    );
    if (fixture === undefined) throw new Error("oversized fixture is missing");
    const source = fixture.evidence.find(
      (candidate) => candidate.kind === "document" && candidate.content.length > 8_000,
    );
    if (source === undefined) throw new Error("oversized document is missing");
    const requests: ProviderRequest[] = [];
    let call = 0;
    const boundary: PiRuntimeBoundary = {
      complete: async (request) => {
        requests.push(request);
        call += 1;
        if (call === 1) {
          return completion("inspect_evidence", { sourceId: source.sourceId });
        }
        if (call === 2) {
          return completion("inspect_evidence", {
            sourceId: source.sourceId,
            range: { charStart: 0, charEnd: 100 },
          });
        }
        return completion("emit_general_planner_result", {
          planTurn: {
            mode: "single",
            question: fixture.currentMessage,
            relevantTurnIds: [],
          },
          selectedSources: [
            { sourceId: source.sourceId, ranges: [{ charStart: 0, charEnd: 100 }] },
          ],
          answerContent: "The supplied document contains the requested evidence.",
          citationSourceIds: [source.sourceId],
          memoryProposals: [],
        });
      },
      stream: async () => {
        throw new Error("general-planner baseline must not stream");
      },
    };

    const output = await withTaskRuntime(
      {
        runId: "ai-evaluation-general-planner:continuation",
        stepId: "evaluation-general-planner",
        attempt: 1,
        iteration: 0,
        signal: new AbortController().signal,
        db: {},
        heartbeat: () => undefined,
        lastHeartbeat: null,
      },
      () =>
        executeGeneralPlannerProviderTurn(
          boundary,
          fixture,
          evaluationSourceIdentityOptions(fixture),
        ),
    );

    expect(output.selectedSources).toEqual([
      { sourceId: source.sourceId, ranges: [{ charStart: 0, charEnd: 100 }] },
    ]);
    expect(requests).toHaveLength(3);
  });

  it("rejects non-document ranges before exposing any source text", async () => {
    const fixture = CanonicalGoldenEvaluationSet.cases.find(
      (candidate) => candidate.id === "cross-cutting-separable-energy-question",
    );
    const source = fixture?.evidence.find((candidate) => candidate.kind === "web");
    if (fixture === undefined || source === undefined) {
      throw new Error("cross-cutting web fixture is missing");
    }
    const requests: ProviderRequest[] = [];
    const onEvidenceVisible = vi.fn();
    const boundary: PiRuntimeBoundary = {
      complete: async (request) => {
        requests.push(request);
        return completion("inspect_evidence", {
          sourceId: source.sourceId,
          range: { charStart: 0, charEnd: 10 },
        });
      },
      stream: async () => {
        throw new Error("general-planner baseline must not stream");
      },
    };

    await expect(
      withTaskRuntime(
        {
          runId: "ai-evaluation-general-planner:non-document-range",
          stepId: "evaluation-general-planner",
          attempt: 1,
          iteration: 0,
          signal: new AbortController().signal,
          db: {},
          heartbeat: () => undefined,
          lastHeartbeat: null,
        },
        () => executeGeneralPlannerProviderTurn(boundary, fixture, { onEvidenceVisible }),
      ),
    ).rejects.toMatchObject({ code: "invalid_workflow_output" });
    expect(onEvidenceVisible).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it("preflights malformed baseline siblings before exposing search results", async () => {
    const fixture = CanonicalGoldenEvaluationSet.cases.find(
      (candidate) => candidate.id === "cross-cutting-separable-energy-question",
    );
    const source = fixture?.evidence[0];
    if (fixture === undefined || source === undefined) {
      throw new Error("cross-cutting evidence fixture is missing");
    }
    const requests: ProviderRequest[] = [];
    const onEvidenceVisible = vi.fn();
    const boundary: PiRuntimeBoundary = {
      complete: async (request) => {
        requests.push(request);
        return parallelCompletion([
          { name: "search_evidence", arguments: { query: "solar" } },
          {
            name: "inspect_evidence",
            arguments: { sourceId: source.sourceId, forged: true },
          },
        ]);
      },
      stream: async () => {
        throw new Error("general-planner baseline must not stream");
      },
    };

    await expect(
      withTaskRuntime(
        {
          runId: "ai-evaluation-general-planner:malformed-sibling",
          stepId: "evaluation-general-planner",
          attempt: 1,
          iteration: 0,
          signal: new AbortController().signal,
          db: {},
          heartbeat: () => undefined,
          lastHeartbeat: null,
        },
        () => executeGeneralPlannerProviderTurn(boundary, fixture, { onEvidenceVisible }),
      ),
    ).rejects.toMatchObject({ code: "invalid_workflow_output" });
    expect(onEvidenceVisible).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it("fails oversized non-document inspection without clipping or exposing text", async () => {
    const fixture = CanonicalGoldenEvaluationSet.cases.find((candidate) =>
      candidate.dimensions.includes("oversized_evidence"),
    );
    if (fixture === undefined) {
      throw new Error("oversized fixture is missing");
    }
    const source = {
      sourceId: "web:oversized-non-document-test",
      selector: "W" as const,
      kind: "web" as const,
      content: "oversized non-document evidence ".repeat(400),
      ranges: [],
      url: "https://example.com/oversized-non-document-test",
      title: "Oversized non-document test source",
      domain: "example.com",
    };
    const oversizedFixture = {
      ...fixture,
      evidence: [...fixture.evidence, source],
    };
    const requests: ProviderRequest[] = [];
    const onEvidenceVisible = vi.fn();
    const boundary: PiRuntimeBoundary = {
      complete: async (request) => {
        requests.push(request);
        return completion("inspect_evidence", { sourceId: source.sourceId });
      },
      stream: async () => {
        throw new Error("general-planner baseline must not stream");
      },
    };

    await expect(
      withTaskRuntime(
        {
          runId: "ai-evaluation-general-planner:oversized-non-document",
          stepId: "evaluation-general-planner",
          attempt: 1,
          iteration: 0,
          signal: new AbortController().signal,
          db: {},
          heartbeat: () => undefined,
          lastHeartbeat: null,
        },
        () => executeGeneralPlannerProviderTurn(boundary, oversizedFixture, { onEvidenceVisible }),
      ),
    ).rejects.toMatchObject({ code: "invalid_workflow_output" });
    expect(onEvidenceVisible).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });
});
