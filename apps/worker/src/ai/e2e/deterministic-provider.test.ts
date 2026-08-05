import { createHash } from "node:crypto";
import * as SmithersTaskRuntimeModule from "@smithers-orchestrator/driver/task-runtime";
import { makeRunAcceptanceScope } from "@hartlib/shared";
import { openSmithersBackend } from "smithers-orchestrator";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { MemoryExtractorPrompt, MemorySelectorPrompt, PlanTurnPrompt } from "../prompts";
import { CanonicalAgentClient } from "../runtime/agent-client";
import {
  chatMessageEvidenceIdentity,
  namespacedDocumentEvidenceIdentity,
  sha256Base64Url,
} from "../runtime/canonicalization";
import { resolveRuntimeModel } from "../runtime/model-registry";
import type { LiveProviderRequest } from "../runtime/provider-request";
import {
  providerVisibleSourceExposureCommitment,
  stableJson,
  type CodeOwnedSourceExposureProof,
} from "../runtime/provider-request";
import { PlanTurnProviderSchema, validatePlanTurn } from "../runtime/validators";
import { GeneralPlannerProviderOutputSchema } from "../evaluation/general-planner-workflow";
import {
  InternalQueryPlanProviderSchema,
  InternalQueryPlanSchema,
  QueryReviewProviderSchema,
  QueryReviewSchema,
  normalizeInternalQueryPlanProvider,
  normalizeQueryReviewProvider,
  type InternalQueryPlan,
} from "../retrieval/query-spec";
import {
  FusedResultSetSchema,
  RankedBranchResultSchema,
  ReviewModelFusedResultSchema,
} from "../retrieval/rank-fusion";
import { canonicalProviderValueSchemas, runQueryReviewReplacement } from "../workflow/operations";
import {
  FallbackContextManifestSchema,
  GroupCompactionResultSchema,
  InitialContextManifestSchema,
} from "../context/compaction";
import {
  FallbackCompactionProviderInputSchema,
  InitialCompactionProviderInputSchema,
  NormalCompactionProviderInputSchema,
  ReadSourcePassagesArgumentsSchema,
  SearchSourcePassagesArgumentsSchema,
  SourceCompactionToolDefinitions,
  SourceToolCompactionProviderInputSchema,
} from "../context/compaction-provider";
import { CanonicalIdentitySchema, canonicalIdentityKey } from "../workflow/types";
import { buildAiChatWorkflow, aiChatSchemas } from "../workflow/ai-chat";
import type {
  ContextState,
  LoadedTurn,
  ContextAssembly,
  MemorySelectorResult,
  WebSelectorResult,
} from "../workflow/operations";
import type { CanonicalWorkflowOperations } from "../workflow/operations";
import type { RetrievalPlanResult } from "../retrieval/retrieval";
import { currentTaskRuntime } from "../runtime/task-cancellation";
import { runSmithersWorkflow } from "../smithers-interop";
import { DeterministicE2eProviderBoundary } from "./deterministic-provider";

const StructuredRetrievalValueSchema = z.strictObject({
  kind: z.enum(["document", "chat_message"]),
  label: z.string().nullable(),
  date: z.string().nullable(),
  textCharCount: z.number().int().nonnegative(),
  sourceName: z.string().optional(),
});

const StructuredRetrievalResultSchema = z
  .strictObject({
    queryPlan: InternalQueryPlanSchema,
    branches: z.array(RankedBranchResultSchema),
    fused: FusedResultSetSchema,
    review: z.array(ReviewModelFusedResultSchema),
    previewExposures: z.array(
      z.strictObject({
        identity: CanonicalIdentitySchema,
        snapshotId: z.string().min(1),
        contentHash: z.string().min(1),
        publisherExtractionId: z.string().optional(),
        previewRanges: z.array(
          z.strictObject({ charStart: z.number().int().nonnegative(), charEnd: z.number().int() }),
        ),
        previewBytes: z.instanceof(Uint8Array),
        fastTokenCount: z.number().int().nonnegative(),
        mainTokenCount: z.number().int().nonnegative(),
      }),
    ),
  })
  .superRefine((result, context) => {
    for (const [index, branch] of result.branches.entries()) {
      for (const [hitIndex, hit] of branch.hits.entries()) {
        const parsed = StructuredRetrievalValueSchema.safeParse(hit.value);
        if (!parsed.success) {
          context.addIssue({
            code: "custom",
            path: ["branches", index, "hits", hitIndex, "value"],
            message: "branch hit value is not a strict physical retrieval value",
          });
        }
      }
    }
    for (const [index, fused] of result.fused.results.entries()) {
      const parsed = StructuredRetrievalValueSchema.safeParse(fused.value);
      if (!parsed.success) {
        context.addIssue({
          code: "custom",
          path: ["fused", "results", index, "value"],
          message: "fused value is not a strict physical retrieval value",
        });
      }
    }
  });

it("cites only the one source available to fanout synthesis", async () => {
  const chunks: string[] = [];
  const sourceKey = "k_cn_1234567890123456789012_1";
  await withTaskRuntime(
    {
      runId: "deterministic-fanout-synthesis-test",
      stepId: "fanout-synthesis",
      attempt: 1,
      iteration: 0,
      signal: new AbortController().signal,
      db: {},
      heartbeat: () => undefined,
      lastHeartbeat: null,
    },
    () =>
      new DeterministicE2eProviderBoundary({
        fastLimits: { inputTokens: 100_000, outputTokens: 16_384 },
        mainLimits: { inputTokens: 100_000, outputTokens: 16_384 },
      }).stream(
        {
          requestClass: "main",
          model: "glm-5-turbo",
          messages: [
            { role: "system", content: "synthesis" },
            { role: "user", content: sourceKey },
          ],
          requestedOutputTokens: 2_048,
          reasoning: "medium",
        },
        {
          taskId: "fanout-synthesis",
          loopIteration: 0,
          attempt: 1,
          providerRequestIndex: 0,
          agentRole: "synthesis",
        },
        (delta) => {
          chunks.push(delta);
        },
      ),
  );
  expect(chunks.join("")).toBe(
    `Deterministic fanout synthesis grounded in both topic packets. [[cite:${sourceKey}]]`,
  );
  expect(chunks.join("")).not.toContain("_2");
});

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

const entries = [
  {
    turnId: "turn-wind",
    userMessageId: "message-wind-user",
    userContent: "What was the wind result?",
    assistantMessageId: "message-wind-assistant",
    assistantContent: "Wind output rose 7 percent.",
  },
  {
    turnId: "turn-solar",
    userMessageId: "message-solar-user",
    userContent: "What was the solar result?",
    assistantMessageId: "message-solar-assistant",
    assistantContent: "Solar output rose 11 percent.",
  },
] as const;

const resolve = (currentMessage: string) => {
  const boundary = new DeterministicE2eProviderBoundary({
    fastLimits: { inputTokens: 100_000, outputTokens: 16_384 },
    mainLimits: { inputTokens: 100_000, outputTokens: 16_384 },
  });
  const agent = new CanonicalAgentClient(boundary);
  return withTaskRuntime(
    {
      runId: "deterministic-resolver-test",
      stepId: "plan-turn",
      attempt: 1,
      iteration: 0,
      signal: new AbortController().signal,
      db: {},
      heartbeat: () => undefined,
      lastHeartbeat: null,
    },
    () =>
      agent.structured({
        requestClass: "fast",
        model: "glm-5-turbo",
        system: PlanTurnPrompt,
        user: JSON.stringify({
          currentMessage,
          entries,
          locale: "en-US",
          market: "US",
          currentDate: "2026-07-14",
        }),
        outputToolName: "emit_plan_turn",
        outputToolDescription: "Emit the validated plan-turn result.",
        outputSchema: z.toJSONSchema(PlanTurnProviderSchema),
        validate: (value) =>
          validatePlanTurn(
            value,
            entries.map((entry) => entry.turnId),
            3,
          ),
        requestedOutputTokens: 2_048,
        reasoning: "medium",
        sourceExposureProofs: [
          chatProof("test-current-message", currentMessage),
          ...entries.flatMap((entry) => [
            chatProof(entry.userMessageId, entry.userContent),
            chatProof(entry.assistantMessageId, entry.assistantContent),
          ]),
        ],
        coordinates: {
          taskId: "plan-turn",
          loopIteration: 0,
          attempt: 1,
          providerRequestIndex: 0,
          agentRole: "plan_turn",
        },
      }),
  );
};

const boundary = () =>
  new DeterministicE2eProviderBoundary({
    fastLimits: { inputTokens: 100_000, outputTokens: 16_384 },
    mainLimits: { inputTokens: 100_000, outputTokens: 16_384 },
  });

const chatProof = (contentItemIdentity: string, visibleText: string) => {
  const contentHash = createHash("sha256").update(visibleText, "utf8").digest("hex");
  return {
    sourceKind: "chat_message" as const,
    logicalSourceIdentity: chatMessageEvidenceIdentity(contentItemIdentity),
    contentItemIdentity,
    exposureStage: "provider_input" as const,
    visibleText,
    visibleTokenCount: resolveRuntimeModel("glm-5-turbo").countTextTokens(visibleText),
    chatReconstruction: {
      messageId: contentItemIdentity,
      contentHash,
      ranges: [{ charStart: 0, charEnd: visibleText.length }],
    },
  };
};

const withBoundaryTask = <Value>(
  taskId: string,
  execute: (agent: CanonicalAgentClient) => Promise<Value>,
): Promise<Value> =>
  withTaskRuntime(
    {
      runId: `deterministic-${taskId}-test`,
      stepId: taskId,
      attempt: 1,
      iteration: 0,
      signal: new AbortController().signal,
      db: {},
      heartbeat: () => undefined,
      lastHeartbeat: null,
    },
    () => execute(new CanonicalAgentClient(boundary())),
  );

const memoryTool = (
  name: string,
  execute: (
    arguments_: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>>>,
) => ({
  definition: { name, description: name, parameters: z.toJSONSchema(z.object({}).passthrough()) },
  execute: async (arguments_: Readonly<Record<string, unknown>>) => execute(arguments_),
});

const memorySnapshot = {
  memoryId: "memory-1",
  memoryRevisionId: "revision-1",
  kind: "preference",
  content: "Prefer concise answers.",
};

const memoryExposureMarker = {
  sourceKind: "memory" as const,
  logicalSourceIdentity: "memory:memory-1",
  contentItemIdentity: "revision-1",
  exposureStage: "memory_tool_result",
  visibleTokenCount: resolveRuntimeModel("glm-5-turbo").countTextTokens(memorySnapshot.content),
};

const memoryLoopTools = () => [
  memoryTool("search_memories", async () => ({
    items: [memorySnapshot],
    complete: true,
    truncated: false,
    cursor: null,
    __hartlibSourceExposures: [memoryExposureMarker],
  })),
  memoryTool("inspect_memory", async () => ({
    found: true,
    complete: true,
    memory: memorySnapshot,
    __hartlibSourceExposures: [memoryExposureMarker],
  })),
  memoryTool("emit_memory_manifest", async () => ({ complete: true })),
  memoryTool("emit_memory_proposals", async () => ({ complete: true })),
];

const pagedMemoryLoopTools = (
  inspectedMemory: Readonly<Record<string, unknown>>,
  inspectedIds: string[],
) => [
  memoryTool("search_memories", async (arguments_) => {
    const cursor = arguments_.cursor;
    return cursor === undefined
      ? {
          items: [
            {
              memoryId: inspectedMemory.memoryId,
              memoryRevisionId: inspectedMemory.memoryRevisionId,
              kind: inspectedMemory.kind,
              content: inspectedMemory.content,
            },
          ],
          complete: false,
          truncated: true,
          cursor: 1,
          __hartlibSourceExposures: [memoryExposureMarker],
        }
      : {
          items: [
            {
              memoryId: "memory-later-page",
              memoryRevisionId: "revision-later-page",
              kind: "preference",
              content: "A later page must not replace the earlier target.",
            },
          ],
          complete: true,
          truncated: false,
          cursor: null,
          __hartlibSourceExposures: [
            {
              sourceKind: "memory" as const,
              logicalSourceIdentity: "memory:memory-later-page",
              contentItemIdentity: "revision-later-page",
              exposureStage: "memory_tool_result",
              visibleTokenCount: resolveRuntimeModel("glm-5-turbo").countTextTokens(
                "A later page must not replace the earlier target.",
              ),
            },
          ],
        };
  }),
  memoryTool("inspect_memory", async (arguments_) => {
    inspectedIds.push(String(arguments_.memoryId));
    return {
      found: true,
      complete: true,
      memory: inspectedMemory,
      __hartlibSourceExposures: [memoryExposureMarker],
    };
  }),
  memoryTool("emit_memory_manifest", async () => ({ complete: true })),
  memoryTool("emit_memory_proposals", async () => ({ complete: true })),
];

describe("deterministic plan-turn provider", () => {
  it("clarifies an unanchored comparison with multiple plausible antecedents", async () => {
    const result = await resolve("Compare it with the previous result.");
    expect(result).toMatchObject({ mode: "clarify" });
    if (result.mode !== "clarify") throw new Error("expected clarification");
    expect(result.question).toMatch(/wind/iu);
    expect(result.question).toMatch(/solar/iu);
  });

  it("selects both prior turns when comparison candidates are anchored", async () => {
    await expect(resolve("Compare the wind result with the solar result.")).resolves.toEqual({
      mode: "single",
      question: "Compare the wind result with the solar result.",
      relevantTurnIds: ["turn-wind", "turn-solar"],
    });
  });

  it("emits the current fanout plan-turn shape", async () => {
    await expect(resolve("[fanout] compare the two topics")).resolves.toMatchObject({
      mode: "fanout",
      topics: [
        { question: expect.any(String), relevantTurnIds: [] },
        { question: expect.any(String), relevantTurnIds: [] },
      ],
    });
  });
});

describe("deterministic evaluation and memory roles", () => {
  it("emits evaluation_general_planner with planTurn and no legacy resolution", async () => {
    const result = await withBoundaryTask("evaluation-general-planner", async (agent) =>
      agent.structured({
        requestClass: "fast",
        model: "glm-5-turbo",
        system: "evaluation",
        user: JSON.stringify({ currentMessage: "Compare it with the previous result." }),
        outputToolName: "emit_general_planner_result",
        outputToolDescription: "Emit",
        outputSchema: z.toJSONSchema(GeneralPlannerProviderOutputSchema),
        validate: (value) => GeneralPlannerProviderOutputSchema.parse(value),
        requestedOutputTokens: 2_048,
        reasoning: "medium",
        sourceExposureProofs: [
          chatProof("test-general-planner-message", "Compare it with the previous result."),
        ],
        coordinates: {
          taskId: "evaluation-general-planner",
          loopIteration: 0,
          attempt: 1,
          providerRequestIndex: 0,
          agentRole: "evaluation_general_planner",
        },
      }),
    );
    expect(result).toHaveProperty("planTurn.mode", "clarify");
    expect(result).not.toHaveProperty("resolution");
  });

  it("emits canonical single and fanout general-planner branches", async () => {
    const run = (currentMessage: string) =>
      withBoundaryTask(`evaluation-general-planner-${currentMessage}`, async (agent) =>
        agent.structured({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "evaluation",
          user: JSON.stringify({ currentMessage, conversation: entries }),
          outputToolName: "emit_general_planner_result",
          outputToolDescription: "Emit",
          outputSchema: z.toJSONSchema(GeneralPlannerProviderOutputSchema),
          validate: (value) => GeneralPlannerProviderOutputSchema.parse(value),
          requestedOutputTokens: 2_048,
          reasoning: "medium",
          sourceExposureProofs: [
            chatProof(`test-general-planner-${currentMessage}`, currentMessage),
          ],
          coordinates: {
            taskId: `evaluation-general-planner-${currentMessage}`,
            loopIteration: 0,
            attempt: 1,
            providerRequestIndex: 0,
            agentRole: "evaluation_general_planner",
          },
        }),
      );
    await expect(run("Summarize the prior results.")).resolves.toMatchObject({
      planTurn: { mode: "single", relevantTurnIds: ["turn-wind", "turn-solar"] },
    });
    await expect(run("[fanout] compare the two topics")).resolves.toMatchObject({
      planTurn: {
        mode: "fanout",
        topics: [
          { topicId: "t1", relevantTurnIds: [] },
          { topicId: "t2", relevantTurnIds: [] },
        ],
      },
    });
  });

  it("uses the memory tool loop for an update target instead of hidden memories", async () => {
    const calls: string[] = [];
    const result = await withBoundaryTask("memory-extract", async (agent) =>
      agent.toolLoop({
        requestClass: "fast",
        model: "glm-5-turbo",
        system: MemoryExtractorPrompt,
        user: JSON.stringify({
          currentUserMessage: "Update preference: concise answers",
          activeMemoryCount: 1,
          toolBounds: { maximumTurns: 4, maximumResultItems: 4 },
        }),
        tools: memoryLoopTools().map((tool) => ({
          ...tool,
          execute: async (arguments_: Readonly<Record<string, unknown>>, _coordinates: unknown) => {
            calls.push(tool.definition.name);
            return tool.execute(arguments_);
          },
        })),
        terminalToolName: "emit_memory_proposals",
        validateTerminal: (value) =>
          canonicalProviderValueSchemas.memoryProposalOutput.parse(value),
        maximumTurns: 4,
        requestedOutputTokens: 2_048,
        reasoning: "medium",
        sourceExposureProofs: [
          chatProof("test-memory-user-message", "Update preference: concise answers"),
        ],
        coordinates: { taskId: "memory-extract", attempt: 1, agentRole: "memory_extractor" },
      }),
    );
    expect(calls).toEqual(["search_memories", "inspect_memory"]);
    expect(result).toEqual({
      proposals: [{ kind: "preference", content: "concise answers", targetMemoryId: "memory-1" }],
    });
  });

  it("keeps an earlier-page memory target in the extractor ledger", async () => {
    const inspectedIds: string[] = [];
    const result = await withBoundaryTask("memory-extract-paged", async (agent) =>
      agent.toolLoop({
        requestClass: "fast",
        model: "glm-5-turbo",
        system: MemoryExtractorPrompt,
        user: JSON.stringify({
          currentUserMessage: "Update preference: concise answers",
          activeMemoryCount: 2,
          toolBounds: { maximumTurns: 6, maximumResultItems: 4 },
        }),
        tools: pagedMemoryLoopTools(memorySnapshot, inspectedIds),
        terminalToolName: "emit_memory_proposals",
        validateTerminal: (value) =>
          canonicalProviderValueSchemas.memoryProposalOutput.parse(value),
        maximumTurns: 6,
        requestedOutputTokens: 2_048,
        reasoning: "medium",
        sourceExposureProofs: [
          chatProof("test-memory-user-message", "Update preference: concise answers"),
        ],
        coordinates: {
          taskId: "memory-extract-paged",
          attempt: 1,
          agentRole: "memory_extractor",
        },
      }),
    );
    expect(inspectedIds).toEqual(["memory-1"]);
    expect(result).toEqual({
      proposals: [{ kind: "preference", content: "concise answers", targetMemoryId: "memory-1" }],
    });
  });

  it("uses the memory tool loop for a selected revision", async () => {
    const result = await withBoundaryTask("select-memories", async (agent) =>
      agent.toolLoop({
        requestClass: "fast",
        model: "glm-5-turbo",
        system: MemorySelectorPrompt,
        user: JSON.stringify({
          question: "[use-memory] answer in my preferred style",
          activeMemoryCount: 1,
          toolBounds: { maximumTurns: 4, maximumResultItems: 4 },
        }),
        tools: memoryLoopTools(),
        terminalToolName: "emit_memory_manifest",
        validateTerminal: (value) =>
          canonicalProviderValueSchemas.memoryManifestOutput.parse(value).entries,
        maximumTurns: 4,
        requestedOutputTokens: 2_048,
        reasoning: "medium",
        coordinates: { taskId: "select-memories", attempt: 1, agentRole: "memory_selector" },
      }),
    );
    expect(result).toEqual([{ memoryId: "memory-1", memoryRevisionId: "revision-1" }]);
  });

  it("keeps an earlier-page memory target in the selector ledger", async () => {
    const inspectedIds: string[] = [];
    const result = await withBoundaryTask("select-memories-paged", async (agent) =>
      agent.toolLoop({
        requestClass: "fast",
        model: "glm-5-turbo",
        system: MemorySelectorPrompt,
        user: JSON.stringify({
          question: "[use-memory] answer in my preferred style",
          activeMemoryCount: 2,
          toolBounds: { maximumTurns: 6, maximumResultItems: 4 },
        }),
        tools: pagedMemoryLoopTools(memorySnapshot, inspectedIds),
        terminalToolName: "emit_memory_manifest",
        validateTerminal: (value) =>
          canonicalProviderValueSchemas.memoryManifestOutput.parse(value).entries,
        maximumTurns: 6,
        requestedOutputTokens: 2_048,
        reasoning: "medium",
        coordinates: {
          taskId: "select-memories-paged",
          attempt: 1,
          agentRole: "memory_selector",
        },
      }),
    );
    expect(inspectedIds).toEqual(["memory-1"]);
    expect(result).toEqual([{ memoryId: "memory-1", memoryRevisionId: "revision-1" }]);
  });
});

describe("deterministic internal retrieval and citation", () => {
  const identity = {
    kind: "public_document" as const,
    sourceId: "public:test-source",
    documentId: "document-1",
    snapshotId: "version-1",
    contentHash: "a".repeat(64),
  };
  const value = {
    kind: "document" as const,
    label: "Public solar report",
    date: "2026-01-01T00:00:00.000Z",
    textCharCount: 26,
    sourceName: "Test source",
  };
  const coverage = [
    {
      queryOrdinal: 1,
      branch: "public_documents" as const,
      status: "applicable" as const,
      hitCount: 1,
      truncated: false,
      cap: 2,
    },
    {
      queryOrdinal: 1,
      branch: "publisher_documents" as const,
      status: "not_applicable" as const,
      reason: "scope_documents" as const,
      hitCount: 0,
      truncated: false,
      cap: 2,
    },
    {
      queryOrdinal: 1,
      branch: "chat_messages" as const,
      status: "not_applicable" as const,
      reason: "scope_documents" as const,
      hitCount: 0,
      truncated: false,
      cap: 2,
    },
  ];
  const structuredResult = () => {
    const query = {
      purpose: "ground the deterministic answer",
      scope: "documents" as const,
      all: [{ text: "solar", mode: "term" as const }],
      anyOf: [],
      not: [],
      filters: {},
      order: "relevance" as const,
    };
    const hit = {
      queryOrdinal: 1,
      branch: "public_documents" as const,
      rank: 1,
      identity,
      value,
      date: value.date,
    };
    const fused = {
      resultId: "r1" as const,
      identity,
      identityKey: canonicalIdentityKey(identity),
      value,
      score: 1 / 61,
      rrfK: 60,
      bestRank: 1,
      date: value.date,
      provenance: [{ queryOrdinal: 1, branch: "public_documents" as const, rank: 1 }],
      matchedQueryOrdinals: [1],
    };
    return {
      queryPlan: { action: "search" as const, queries: [query] },
      branches: [
        {
          queryOrdinal: 1,
          branch: "public_documents" as const,
          order: "relevance" as const,
          status: "applicable" as const,
          hits: [hit],
          cap: 2,
          truncated: false,
        },
        {
          queryOrdinal: 1,
          branch: "publisher_documents" as const,
          status: "not_applicable" as const,
          reason: "scope_documents" as const,
          hits: [],
          cap: 2,
          truncated: false,
        },
        {
          queryOrdinal: 1,
          branch: "chat_messages" as const,
          status: "not_applicable" as const,
          reason: "scope_documents" as const,
          hits: [],
          cap: 2,
          truncated: false,
        },
      ],
      fused: {
        results: [fused],
        coverage,
        candidateCountBeforeCap: 1,
        candidateCap: 2,
        hydratedBytes: value.textCharCount,
        hydrationByteCap: 10_000,
        truncation: { branch: false, candidates: false, hydration: false },
      },
      review: [
        {
          resultId: "r1" as const,
          kind: "document" as const,
          label: value.label,
          date: value.date,
          tokenCount: 5,
          preview: "Solar capacity increased.",
          normalizedFusedScore: 1,
          matchedQueryOrdinals: [1],
          branchCoverage: coverage,
          truncationFlags: { branch: false, candidates: false, hydration: false },
        },
      ],
      previewExposures: [
        {
          identity,
          snapshotId: "version-1",
          contentHash: "a".repeat(64),
          previewRanges: [{ charStart: 0, charEnd: value.textCharCount }],
          previewBytes: new TextEncoder().encode("Solar capacity increased."),
          fastTokenCount: 5,
          mainTokenCount: 5,
        },
      ],
    };
  };

  it("validates the strict structured plan, branch coverage, review, and ordered result", () => {
    const result = StructuredRetrievalResultSchema.parse(structuredResult());
    expect(InternalQueryPlanSchema.parse(result.queryPlan).action).toBe("search");
    expect(QueryReviewSchema.parse({ action: "accept", reason: "sufficient_coverage" })).toEqual({
      action: "accept",
      reason: "sufficient_coverage",
    });
    expect(result.branches.map((branch) => branch.branch)).toEqual([
      "public_documents",
      "publisher_documents",
      "chat_messages",
    ]);
    expect(result.fused.results.map((candidate) => candidate.resultId)).toEqual(["r1"]);
    expect(result.review[0]?.branchCoverage).toEqual(result.fused.coverage);
    expect(result.previewExposures[0]?.previewRanges).toEqual([{ charStart: 0, charEnd: 26 }]);
  });

  it("rejects malformed and extra structured retrieval fields", () => {
    const result = structuredResult();
    expect(() => StructuredRetrievalResultSchema.parse({ ...result, extra: true })).toThrow();
    expect(() =>
      StructuredRetrievalResultSchema.parse({
        ...result,
        fused: {
          ...result.fused,
          results: [{ ...result.fused.results[0], value: { ...value, extra: true } }],
        },
      }),
    ).toThrow();
    expect(() =>
      StructuredRetrievalResultSchema.parse({
        ...result,
        branches: [{ ...result.branches[0], status: "not_applicable", hits: [] }],
      }),
    ).toThrow();
  });

  it("uses the live boundary for strict plan and result-aware review outputs", async () => {
    const plan = (await withBoundaryTask("internal-query-plan-live", async (agent) =>
      agent.structured({
        requestClass: "fast",
        model: "glm-5-turbo",
        system: "internal query plan",
        user: JSON.stringify({
          question: "Compare solar connections and storage operations.",
          selectedConversation: [],
          locale: "en-US",
          market: "US",
          currentDate: "2026-07-10",
        }),
        outputToolName: "emit_internal_query_plan",
        outputToolDescription: "Emit one complete structured internal query plan.",
        outputSchema: z.toJSONSchema(InternalQueryPlanProviderSchema),
        validate: normalizeInternalQueryPlanProvider,
        requestedOutputTokens: 2_048,
        reasoning: "medium",
        coordinates: {
          taskId: "internal-query-plan-live",
          loopIteration: 0,
          attempt: 1,
          providerRequestIndex: 0,
          agentRole: "internal_query_plan",
        },
      }),
    )) as z.infer<typeof InternalQueryPlanSchema>;
    expect(plan.action).toBe("search");
    expect(JSON.stringify(plan)).not.toContain("deterministic_test");
    if (plan.action !== "search") throw new Error("expected a search plan");

    const source = structuredResult();
    const review = await withBoundaryTask("internal-query-review-live", async (agent) =>
      agent.structured({
        requestClass: "fast",
        model: "glm-5-turbo",
        system: "internal query review",
        user: JSON.stringify({
          question: "Compare solar connections and storage operations.",
          queries: source.queryPlan.queries,
          results: source.review,
          coverage: source.fused.coverage,
          truncation: source.fused.truncation,
        }),
        outputToolName: "emit_internal_query_review",
        outputToolDescription: "Review the complete structured retrieval result.",
        outputSchema: z.toJSONSchema(QueryReviewProviderSchema),
        validate: normalizeQueryReviewProvider,
        sourceExposureProofs: [
          {
            sourceKind: "document" as const,
            logicalSourceIdentity: namespacedDocumentEvidenceIdentity(
              { kind: "public", sourceId: identity.sourceId },
              identity.documentId,
            ),
            contentItemIdentity: `${namespacedDocumentEvidenceIdentity(
              { kind: "public", sourceId: identity.sourceId },
              identity.documentId,
            )}:${identity.snapshotId}:${sha256Base64Url(
              JSON.stringify(source.previewExposures[0]?.previewRanges ?? []),
            )}`,
            exposureStage: "internal_search_preview",
            visibleTokenCount: resolveRuntimeModel("glm-5-turbo").countTextTokens(
              source.review[0]?.preview ?? "",
            ),
            visibleText: source.review[0]?.preview ?? "",
          },
        ],
        requestedOutputTokens: 2_048,
        reasoning: "medium",
        coordinates: {
          taskId: "internal-query-review-live",
          loopIteration: 0,
          attempt: 1,
          providerRequestIndex: 0,
          agentRole: "internal_query_review",
        },
      }),
    );
    expect(review).toEqual({ action: "accept", reason: "sufficient_coverage" });
  });

  it.each([
    {
      label: "replacement",
      question: "[replace] Find the missed storage concept.",
      expected: {
        action: "replace" as const,
        reason: "missed_concept" as const,
      },
    },
    {
      label: "no evidence",
      question: "[no-evidence] Find supporting evidence.",
      expected: {
        action: "no_evidence" as const,
        reason: "no_supporting_evidence" as const,
      },
    },
  ])("emits strict query review $label", async ({ label, question, expected }) => {
    const source = structuredResult();
    const result = await withBoundaryTask(`internal-query-review-${label}`, async () => {
      const completion = await boundary().complete(
        {
          requestClass: "fast",
          model: "glm-5-turbo",
          messages: [
            { role: "system", content: "internal query review" },
            {
              role: "user",
              content: JSON.stringify({
                question,
                queries: source.queryPlan.queries,
                results: source.review,
                coverage: source.fused.coverage,
                truncation: source.fused.truncation,
              }),
            },
          ],
          sourceExposureProofs: [
            {
              sourceKind: "document" as const,
              logicalSourceIdentity: namespacedDocumentEvidenceIdentity(
                { kind: "public", sourceId: identity.sourceId },
                identity.documentId,
              ),
              contentItemIdentity: `${namespacedDocumentEvidenceIdentity(
                { kind: "public", sourceId: identity.sourceId },
                identity.documentId,
              )}:${identity.snapshotId}:${sha256Base64Url(
                JSON.stringify(source.previewExposures[0]?.previewRanges ?? []),
              )}`,
              exposureStage: "internal_search_preview" as const,
              visibleText: source.review[0]?.preview ?? "",
              visibleTokenCount: resolveRuntimeModel("glm-5-turbo").countTextTokens(
                source.review[0]?.preview ?? "",
              ),
            },
          ],
          tools: [
            {
              name: "emit_internal_query_review",
              description: "Review the complete structured retrieval result.",
              parameters: z.toJSONSchema(QueryReviewProviderSchema),
            },
          ],
          toolChoice: "auto",
          requestedOutputTokens: 2_048,
          reasoning: "medium",
        },
        {
          taskId: `internal-query-review-${label}`,
          loopIteration: 0,
          attempt: 1,
          providerRequestIndex: 0,
          agentRole: "internal_query_review",
        },
      );
      expect(completion.toolCalls).toHaveLength(1);
      return QueryReviewSchema.parse(completion.toolCalls[0]!.arguments);
    });
    expect(result).toMatchObject(expected);
    if (expected.action === "replace") {
      expect(result).toHaveProperty("queries.0.all.0.text", "storage");
    }
  });

  it("fails closed for malformed strict requests and unknown roles", async () => {
    await expect(
      withBoundaryTask("internal-query-plan-malformed", async (agent) =>
        agent.structured({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "internal query plan",
          user: JSON.stringify({ question: "solar", locale: "en-US" }),
          outputToolName: "emit_internal_query_plan",
          outputToolDescription: "Emit one complete structured internal query plan.",
          outputSchema: z.toJSONSchema(InternalQueryPlanProviderSchema),
          validate: normalizeInternalQueryPlanProvider,
          requestedOutputTokens: 2_048,
          reasoning: "medium",
          coordinates: {
            taskId: "internal-query-plan-malformed",
            loopIteration: 0,
            attempt: 1,
            providerRequestIndex: 0,
            agentRole: "internal_query_plan",
          },
        }),
      ),
    ).rejects.toThrow(/strict schema|currentDate|selectedConversation/u);

    await expect(
      withBoundaryTask("internal-query-unknown-role", async (agent) =>
        agent.structured({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "unknown",
          user: JSON.stringify({}),
          outputToolName: "emit_unknown",
          outputToolDescription: "unknown",
          outputSchema: z.toJSONSchema(z.strictObject({})),
          validate: (value) => z.strictObject({}).parse(value),
          requestedOutputTokens: 2_048,
          reasoning: "medium",
          coordinates: {
            taskId: "internal-query-unknown-role",
            loopIteration: 0,
            attempt: 1,
            providerRequestIndex: 0,
            agentRole: "unknown_role" as never,
          },
        }),
      ),
    ).rejects.toThrow(/unsupported deterministic role/u);
  });

  it("rejects a passthrough or drifted structured output schema", async () => {
    await expect(
      withBoundaryTask("internal-query-plan-wrong-schema", async (agent) =>
        agent.structured({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "internal query plan",
          user: JSON.stringify({
            question: "solar",
            selectedConversation: [],
            locale: "en-US",
            market: "US",
            currentDate: "2026-07-10",
          }),
          outputToolName: "emit_internal_query_plan",
          outputToolDescription: "Emit one complete structured internal query plan.",
          outputSchema: z.toJSONSchema(z.strictObject({})),
          validate: (value) => InternalQueryPlanSchema.parse(value),
          requestedOutputTokens: 2_048,
          reasoning: "medium",
          coordinates: {
            taskId: "internal-query-plan-wrong-schema",
            loopIteration: 0,
            attempt: 1,
            providerRequestIndex: 0,
            agentRole: "internal_query_plan",
          },
        }),
      ),
    ).rejects.toThrow(/schema/u);
  });

  it("keeps citations in the deterministic streamed answer", async () => {
    const chunks: string[] = [];
    const request: LiveProviderRequest = {
      requestClass: "main",
      model: "glm-5-turbo",
      messages: [
        { role: "system", content: "answer" },
        {
          role: "user",
          content: "[cite-all] k_cn_1234567890123456789012_1 k_cn_1234567890123456789012_2",
        },
      ],
      requestedOutputTokens: 2_048,
      reasoning: "medium",
    };
    await withBoundaryTask("single-answer", async () =>
      boundary().stream(
        request,
        {
          taskId: "single-answer",
          loopIteration: 0,
          attempt: 1,
          providerRequestIndex: 0,
          agentRole: "direct_answer",
        },
        (delta) => {
          chunks.push(delta);
        },
      ),
    );
    expect(chunks.join("")).toContain("[[cite:k_cn_1234567890123456789012_1]]");
  });

  it("retains provider-visible provenance proofs in deterministic measurements", async () => {
    const proofs: string[][] = [];
    const visibleText = "Solar evidence.";
    const logicalSourceIdentity = namespacedDocumentEvidenceIdentity(
      { kind: "public", sourceId: "public:source-1" },
      "doc-1",
    );
    const provenanceBoundary = new DeterministicE2eProviderBoundary({
      fastLimits: { inputTokens: 100_000, outputTokens: 16_384 },
      mainLimits: { inputTokens: 100_000, outputTokens: 16_384 },
      hooks: {
        onMeasurement: async (_coordinates, _measurement, _request, sourceProofs) => {
          proofs.push([...sourceProofs]);
        },
      },
    });
    const request: LiveProviderRequest = {
      requestClass: "main",
      model: "glm-5-turbo",
      messages: [
        { role: "system", content: "answer" },
        {
          role: "user",
          content: JSON.stringify({
            evidence: `<source key="k_cn_1234567890123456789012_1" kind="document" length="${visibleText.length}">\n${visibleText}\n</source>`,
          }),
        },
      ],
      sourceExposureProofs: [
        {
          sourceKind: "document",
          logicalSourceIdentity,
          contentItemIdentity: `${logicalSourceIdentity}:version-1:${sha256Base64Url(visibleText)}`,
          exposureStage: "answer_serialized",
          visibleText,
          visibleTokenCount: resolveRuntimeModel("glm-5-turbo").countTextTokens(visibleText),
        },
      ],
      requestedOutputTokens: 2_048,
      reasoning: "medium",
    };
    await withBoundaryTask("provenance", async () =>
      provenanceBoundary.stream(
        request,
        {
          taskId: "provenance",
          loopIteration: 0,
          attempt: 1,
          providerRequestIndex: 0,
          agentRole: "direct_answer",
        },
        () => undefined,
      ),
    );
    expect(proofs).toHaveLength(1);
    expect(proofs[0]).toHaveLength(1);
  });

  it("rejects provenance markers that are not bound to the serialized source", async () => {
    const request: LiveProviderRequest = {
      requestClass: "main",
      model: "glm-5-turbo",
      messages: [
        { role: "system", content: "answer" },
        {
          role: "user",
          content: JSON.stringify({
            evidence:
              '<source key="k_cn_1234567890123456789012_1" kind="document" length="15">\nSolar evidence.\n</source>',
          }),
        },
      ],
      sourceExposureProofs: [
        {
          sourceKind: "document",
          logicalSourceIdentity: "document:public:unbound",
          contentItemIdentity: "document:public:unbound:version-1:range-1",
          exposureStage: "internal_inspection",
          visibleTokenCount: 3,
        },
      ],
      requestedOutputTokens: 2_048,
      reasoning: "medium",
    };
    await expect(
      withBoundaryTask("provenance-rejection", async () =>
        boundary().stream(
          request,
          {
            taskId: "provenance-rejection",
            loopIteration: 0,
            attempt: 1,
            providerRequestIndex: 0,
            agentRole: "direct_answer",
          },
          () => undefined,
        ),
      ),
    ).rejects.toThrow(/provider-visible source exposure/iu);
  });

  it.each([
    {
      name: "duplicate proof markers",
      marker: {
        sourceKind: "document" as const,
        logicalSourceIdentity: "document:public:duplicate",
        contentItemIdentity: "document:public:duplicate:version-1:hash",
        exposureStage: "answer_serialized" as const,
        visibleText: "Solar evidence.",
        visibleTokenCount: resolveRuntimeModel("glm-5-turbo").countTextTokens("Solar evidence."),
      },
      count: 2,
    },
    {
      name: "malformed proof marker",
      marker: {
        sourceKind: "document" as const,
        logicalSourceIdentity: "document:public:malformed",
        contentItemIdentity: "document:public:malformed:version-1:hash",
        exposureStage: "answer_serialized" as const,
        visibleTokenCount: -1,
      },
      count: 1,
    },
    {
      name: "miscounted proof marker",
      marker: {
        sourceKind: "document" as const,
        logicalSourceIdentity: "document:public:miscounted",
        contentItemIdentity: "document:public:miscounted:version-1:hash",
        exposureStage: "answer_serialized" as const,
        visibleText: "Solar evidence.",
        visibleTokenCount:
          resolveRuntimeModel("glm-5-turbo").countTextTokens("Solar evidence.") + 1,
      },
      count: 1,
    },
  ])("rejects $name", async ({ marker, count }) => {
    const request: LiveProviderRequest = {
      requestClass: "main",
      model: "glm-5-turbo",
      messages: [
        { role: "system", content: "answer" },
        {
          role: "user",
          content: JSON.stringify({
            evidence:
              '<source key="k_cn_1234567890123456789012_1" kind="document" length="15">\nSolar evidence.\n</source>',
          }),
        },
      ],
      sourceExposureProofs: Array.from({ length: count }, () => marker),
      requestedOutputTokens: 2_048,
      reasoning: "medium",
    } as LiveProviderRequest;
    await expect(
      withBoundaryTask(`provenance-${count}`, async () =>
        boundary().stream(
          request,
          {
            taskId: `provenance-${count}`,
            loopIteration: 0,
            attempt: 1,
            providerRequestIndex: 0,
            agentRole: "direct_answer",
          },

          () => undefined,
        ),
      ),
    ).rejects.toThrow();
  });
});

const compactionProofFor = (
  kind: "document" | "chat_message" | "memory",
  candidateId: string,
  text: string,
  serializedField: string,
  passageId?: string,
): CodeOwnedSourceExposureProof => {
  const contentHash = createHash("sha256").update(text, "utf8").digest("hex");
  const contentItemIdentity =
    kind === "document"
      ? `${namespacedDocumentEvidenceIdentity(
          { kind: "public", sourceId: "public:deterministic" },
          candidateId,
        )}:snapshot:${sha256Base64Url(text)}`
      : `${candidateId}-item`;
  const logicalSourceIdentity =
    kind === "document"
      ? contentItemIdentity.slice(0, contentItemIdentity.lastIndexOf(":snapshot:"))
      : kind === "chat_message"
        ? chatMessageEvidenceIdentity(contentItemIdentity)
        : `memory:${candidateId}`;
  const proof = {
    sourceKind: kind,
    logicalSourceIdentity,
    contentItemIdentity,
    exposureStage: "context_compaction_input" as const,
    visibleText: text,
    visibleTokenCount: resolveRuntimeModel("glm-5-turbo").countTextTokens(text),
    candidateId,
    charStart: 0,
    charEnd: text.length,
    visibleByteCount: new TextEncoder().encode(text).byteLength,
    immutableContentHash: contentHash,
    immutableSourceIdentityCommitment: "d".repeat(43),
    messageIndex: 1,
    serializedField,
    ...(passageId === undefined ? {} : { passageId }),
    ...(kind === "chat_message"
      ? {
          chatReconstruction: {
            messageId: contentItemIdentity,
            contentHash,
            ranges: [{ charStart: 0, charEnd: text.length }],
          },
        }
      : {}),
  };
  const compactionBinding = stableJson({
    sourceKind: kind,
    candidateId,
    passageId,
    charStart: 0,
    charEnd: text.length,
    visibleByteCount: proof.visibleByteCount,
    visibleTextHash: sha256Base64Url(text),
  });
  return {
    ...proof,
    immutableSourceCommitment: providerVisibleSourceExposureCommitment(
      proof,
      compactionBinding,
      contentHash,
      proof.immutableSourceIdentityCommitment,
    ),
  };
};

const compactionProofsFor = (user: string): readonly CodeOwnedSourceExposureProof[] => {
  const input = JSON.parse(user) as Record<string, unknown>;
  const previewField =
    Array.isArray(input.candidates) &&
    (input.candidates as unknown[]).some(
      (value) =>
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).preview === "string",
    )
      ? "candidates"
      : Array.isArray(input.originalCandidates)
        ? "originalCandidates"
        : undefined;
  if (previewField !== undefined) {
    return (input[previewField] as unknown[]).flatMap((value, index) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
      const candidate = value as Record<string, unknown>;
      if (
        typeof candidate.candidateId !== "string" ||
        typeof candidate.kind !== "string" ||
        typeof candidate.preview !== "string"
      ) {
        return [];
      }
      return [
        compactionProofFor(
          candidate.kind as "document" | "chat_message" | "memory",
          candidate.candidateId,
          candidate.preview,
          `messages[1].content.${previewField}[${index}].preview`,
        ),
      ];
    });
  }
  if (Array.isArray(input.candidates)) {
    return (input.candidates as unknown[]).flatMap((value, candidateIndex) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
      const candidate = value as Record<string, unknown>;
      if (
        typeof candidate.candidateId !== "string" ||
        typeof candidate.kind !== "string" ||
        !Array.isArray(candidate.passages)
      ) {
        return [];
      }
      const candidateId = candidate.candidateId;
      return (candidate.passages as unknown[]).flatMap((passage, passageIndex) => {
        if (passage === null || typeof passage !== "object" || Array.isArray(passage)) return [];
        const value = passage as Record<string, unknown>;
        return typeof value.text === "string"
          ? [
              compactionProofFor(
                candidate.kind as "document" | "chat_message" | "memory",
                candidateId,
                value.text,
                `messages[1].content.candidates[${candidateIndex}].passages[${passageIndex}].text`,
                typeof value.passageId === "string" ? value.passageId : undefined,
              ),
            ]
          : [];
      });
    });
  }
  return [];
};

const deterministicWorkflowConfig = {
  aiFastTaskTimeoutMs: 30_000,
  aiAnswerTimeoutMs: 30_000,
  aiTopicResearchMaxConcurrency: 6,
  aiTopicAnswerMaxConcurrency: 3,
} as const;

const deterministicWorkflowLoad: LoadedTurn = {
  aiRunId: "00000000-0000-4000-8000-000000000103",
  chatId: "00000000-0000-4000-8000-000000000101",
  initiatingUserId: "deterministic-workflow-user",
  userMessageId: "00000000-0000-4000-8000-000000000102",
  userMessage: "Compare the deterministic evidence.",
  locale: "en-US",
  market: "US",
  currentDate: "2026-07-14",
  citationNamespace: "cn_" + "B".repeat(22),
  acceptanceScope: makeRunAcceptanceScope({
    userId: "deterministic-workflow-user",
    chatId: "00000000-0000-4000-8000-000000000101",
    companyId: "00000000-0000-4000-8000-000000000104",
    memoryMode: "disabled",
    webRequested: false,
    webEnabled: false,
  }),
};

const deterministicAnswerRequest = {
  requestClass: "main" as const,
  model: "glm-5-turbo" as const,
  messages: [{ role: "user" as const, content: "deterministic workflow answer" }],
  requestedOutputTokens: 32,
  reasoning: "medium" as const,
};

const manifestCandidate = (
  candidateId: string,
  kind: "document" | "chat_message" | "memory",
  renderedTokenCount: number,
) => ({
  candidateId,
  kind,
  label: `${kind} ${candidateId}`,
  purpose: "retain the focused evidence",
  date: "2026-07-01",
  renderedTokenCount,
  preview: `${kind} preview`,
});

const deterministicContext = (
  status: "ready" | "needs_compaction" | "failed",
  inputTokens: number,
  compactionRan = false,
  options: {
    readonly question?: string;
    readonly topicId?: "t1" | "t2" | "t3";
    readonly request?: typeof deterministicAnswerRequest;
    readonly consumer?: "direct" | "topic" | "synthesis";
  } = {},
): ContextState =>
  ({
    status,
    question: options.question ?? "deterministic workflow",
    ...(options.topicId === undefined ? {} : { topicId: options.topicId }),
    candidates: [],
    candidateLedger: { candidates: [] },
    sourceMap: [],
    ledgerCandidates: [],
    ledgerSourceMap: [],
    selectedConversation: [],
    consumers: [
      {
        consumer: options.consumer ?? (options.topicId === undefined ? "direct" : "topic"),
        ...(options.topicId === undefined ? {} : { topicId: options.topicId }),
        inputTokens,
        requestedOutputTokens: 32,
        usableInputTokens: 100,
      },
    ],
    gaps: [],
    compactionFeedback: status === "failed" ? ["validated plan remains oversized"] : [],
    request: options.request ?? deterministicAnswerRequest,
    inputTokens,
    usableInputTokens: 100,
    compactionRan,
    ...(status === "failed" ? { failureCode: "context_plan_unfit" as const } : {}),
  }) as unknown as ContextState;

const runDeterministicProductionWorkflow = async (
  mode: "fit" | "compact" | "fallback" | "unfit",
  route: "single" | "fanout" = "single",
): Promise<{
  readonly result: { readonly status: string };
  readonly calls: readonly string[];
  readonly providerCalls: readonly { readonly taskId: string; readonly agentRole: string }[];
  readonly maximumGroups: number;
  readonly groupsOverlapped: boolean;
  readonly replacementActions: readonly string[];
  readonly retrievalSearches: readonly string[];
  readonly retrievalReviewCalls: number;
  readonly replacementResultLabel: string | null;
  readonly replacementResultUsed: boolean;
  readonly terminalFailureCode: string | undefined;
}> => {
  const providerCalls: { taskId: string; agentRole: string }[] = [];
  const replacementActions: string[] = [];
  const retrievalSearches: string[] = [];
  let retrievalReviewCalls = 0;
  let replacementResultLabel: string | null = null;
  let replacementResultUsed = false;
  let terminalFailureCode: string | undefined;
  let activeGroups = 0;
  let maximumGroups = 0;
  let groupsOverlapped = false;
  let normalGroupsEntered = 0;
  let releaseNormalGroups!: () => void;
  const normalGroupsBarrier = new Promise<void>((resolve) => {
    releaseNormalGroups = resolve;
  });
  const provider = new DeterministicE2eProviderBoundary({
    fastLimits: { inputTokens: 100_000, outputTokens: 16_384 },
    mainLimits: { inputTokens: 100_000, outputTokens: 16_384 },
    hooks: {
      onMeasurement: async (coordinates) => {
        providerCalls.push({ taskId: coordinates.taskId, agentRole: coordinates.agentRole });
      },
    },
  });
  const agent = new CanonicalAgentClient(provider);
  const storage = await openSmithersBackend(aiChatSchemas, {
    backend: "sqlite",
    dbPath: `/tmp/hartlib-deterministic-${crypto.randomUUID()}.db`,
  });
  const calls: string[] = [];
  const structuredViaAgent = async <Value>(
    taskId: string,
    agentRole:
      | "context_manifest"
      | "context_fallback_manifest"
      | "context_compact_group"
      | "internal_retrieval"
      | "topic_answer",
    user: string,
    outputToolName: string,
    outputSchema: Readonly<Record<string, unknown>>,
    validate: (value: unknown) => Value,
    options: {
      readonly providerRequestIndex?: number;
      readonly requestClass?: "fast" | "main";
      readonly useCompactionProofs?: boolean;
      readonly sourceExposureProofs?: readonly CodeOwnedSourceExposureProof[];
    } = {},
  ): Promise<Value> => {
    const runtime = currentTaskRuntime();
    if (runtime === undefined) throw new Error(`missing Smithers runtime for ${taskId}`);
    return agent.structured({
      requestClass: options.requestClass ?? "fast",
      model: "glm-5-turbo",
      system: "deterministic v4 role",
      user,
      outputToolName,
      outputToolDescription: outputToolName,
      outputSchema,
      validate,
      requestedOutputTokens: 2_048,
      reasoning: "medium",
      ...(options.sourceExposureProofs !== undefined
        ? { sourceExposureProofs: options.sourceExposureProofs }
        : options.useCompactionProofs === false
          ? {}
          : { sourceExposureProofs: compactionProofsFor(user) }),
      coordinates: {
        taskId,
        loopIteration: runtime.loopIteration,
        attempt: runtime.attempt,
        providerRequestIndex: options.providerRequestIndex ?? 0,
        agentRole,
      },
    });
  };
  const retrievalCoverage = [
    {
      queryOrdinal: 1,
      branch: "public_documents" as const,
      status: "applicable" as const,
      hitCount: 1,
      truncated: false,
      cap: 2,
    },
    {
      queryOrdinal: 1,
      branch: "publisher_documents" as const,
      status: "not_applicable" as const,
      reason: "scope_documents" as const,
      hitCount: 0,
      truncated: false,
      cap: 2,
    },
    {
      queryOrdinal: 1,
      branch: "chat_messages" as const,
      status: "not_applicable" as const,
      reason: "scope_documents" as const,
      hitCount: 0,
      truncated: false,
      cap: 2,
    },
  ];
  const retrievalResultFor = (
    plan: z.infer<typeof InternalQueryPlanSchema>,
    label: "initial" | "replacement",
  ): RetrievalPlanResult => {
    const review = [
      {
        resultId: "r1" as const,
        kind: "document" as const,
        label,
        date: "2026-07-01",
        tokenCount: 4,
        preview: `${label} deterministic preview`,
        normalizedFusedScore: 1,
        matchedQueryOrdinals: [1],
        branchCoverage: retrievalCoverage,
        truncationFlags: { branch: false, candidates: false, hydration: false },
      },
    ];
    return {
      queryPlan: plan as unknown as InternalQueryPlan,
      branches: [],
      fused: {
        results: [],
        coverage: retrievalCoverage,
        candidateCountBeforeCap: 0,
        candidateCap: 2,
        hydratedBytes: 0,
        hydrationByteCap: null,
        truncation: { branch: false, candidates: false, hydration: false },
      },
      review,
      previewExposures: [],
    };
  };
  const retrievalProofFor = (text: string): CodeOwnedSourceExposureProof => ({
    sourceKind: "document",
    logicalSourceIdentity: namespacedDocumentEvidenceIdentity(
      { kind: "public", sourceId: "public:deterministic" },
      "deterministic-document",
    ),
    contentItemIdentity: `${namespacedDocumentEvidenceIdentity(
      { kind: "public", sourceId: "public:deterministic" },
      "deterministic-document",
    )}:snapshot:${sha256Base64Url(text)}`,
    exposureStage: "internal_search_preview",
    visibleText: text,
    visibleTokenCount: resolveRuntimeModel("glm-5-turbo").countTextTokens(text),
    messageIndex: 1,
    sourceOrdinal: 0,
    serializedField: "messages[1].content.results[0].preview",
  });
  const operations = {
    loadTurn: async () => deterministicWorkflowLoad,
    planTurn: async () =>
      route === "fanout"
        ? {
            mode: "fanout" as const,
            question: "deterministic fanout workflow",
            topics: [
              { topicId: "t1" as const, question: "deterministic topic one", relevantTurnIds: [] },
              { topicId: "t2" as const, question: "deterministic topic two", relevantTurnIds: [] },
            ],
          }
        : {
            mode: "single" as const,
            question: "deterministic workflow [replace]",
            relevantTurnIds: [],
          },
    extractMemory: async () => ({
      result: { proposals: [], discardedCount: 0 },
      producer: {
        taskId: "memory-extract",
        loopIteration: 0,
        attempt: 1,
        observationKey: "memory-extract:0:1:memory_extraction_result:result",
        extractionSha256Hex: "0".repeat(64),
      },
    }),
    retrieveStructuredInternal: async (
      _load: LoadedTurn,
      question: string,
      taskId: string,
    ): Promise<RetrievalPlanResult> => {
      const retrievalQuestion = `${question} [replace]`;
      let searchesForOperation = 0;
      let reviewsForOperation = 0;
      const plan = InternalQueryPlanSchema.parse(
        await structuredViaAgent(
          taskId,
          "internal_retrieval",
          JSON.stringify({
            question: retrievalQuestion,
            selectedConversation: [],
            locale: "en-US",
            market: "US",
            currentDate: "2026-07-14",
          }),
          "emit_internal_query_plan",
          z.toJSONSchema(InternalQueryPlanProviderSchema),
          normalizeInternalQueryPlanProvider,
          { useCompactionProofs: false },
        ),
      );
      const execute = async (replacementPlan: z.infer<typeof InternalQueryPlanSchema>) => {
        const search = searchesForOperation === 0 ? "initial" : "replacement";
        if (searchesForOperation >= 2) throw new Error("a second replacement search cannot run");
        searchesForOperation += 1;
        retrievalSearches.push(`${taskId}:${search}`);
        return retrievalResultFor(replacementPlan, search);
      };
      const initialResult = await execute(plan);
      const initialReviewInput = {
        question: retrievalQuestion,
        queries: plan.action === "search" ? plan.queries : [],
        results: initialResult.review,
        coverage: retrievalCoverage,
        truncation: initialResult.fused.truncation,
      };
      const reviewed = await runQueryReviewReplacement(
        {
          initialPlan: plan,
          initialResult,
          reviewInput: initialReviewInput,
          initialExposure: { providerInput: initialReviewInput, privateProof: [] },
        },
        {
          review: async (input) => {
            reviewsForOperation += 1;
            retrievalReviewCalls += 1;
            if (reviewsForOperation > 1) throw new Error("a second replacement review cannot run");
            return structuredViaAgent(
              taskId,
              "internal_retrieval",
              JSON.stringify(input),
              "emit_internal_query_review",
              z.toJSONSchema(QueryReviewProviderSchema),
              normalizeQueryReviewProvider,
              {
                providerRequestIndex: 1,
                useCompactionProofs: false,
                sourceExposureProofs: [retrievalProofFor(input.results[0]!.preview)],
              },
            );
          },
          execute,
          projectReview: (result) => ({
            providerInput: {
              question: retrievalQuestion,
              queries: (() => {
                const canonicalResultPlan = InternalQueryPlanSchema.parse(result.queryPlan);
                return canonicalResultPlan.action === "search" ? canonicalResultPlan.queries : [];
              })(),
              results: result.review,
              coverage: retrievalCoverage,
              truncation: result.fused.truncation,
            },
            privateProof: [],
          }),
          onPreviewExposure: () => undefined,
        },
      );
      if (reviewed.action === "replace") {
        replacementActions.push(reviewed.action);
        replacementResultLabel = reviewed.result.review[0]?.label ?? null;
      }
      if (reviewed.action === "no_evidence")
        throw new Error("deterministic replacement review returned no evidence");
      return reviewed.result;
    },
    selectMemories: async (): Promise<MemorySelectorResult> => ({
      status: "disabled",
      reason: "memory_mode_disabled",
    }),
    retrieveWeb: async (): Promise<WebSelectorResult> => ({
      status: "disabled",
      reason: "not_requested",
    }),
    assembleContext: async (
      _load: LoadedTurn,
      question: string,
      selectors: unknown,
      _taskId: string,
      consumerTaskId: string,
      topicId?: "t1" | "t2" | "t3",
    ): Promise<ContextAssembly> => {
      const structuredInternal = (
        selectors as { readonly structuredInternal?: RetrievalPlanResult | null }
      ).structuredInternal;
      if (structuredInternal?.review[0]?.label !== "replacement") {
        throw new Error("assembly did not receive the replacement retrieval result");
      }
      replacementResultUsed = true;
      return {
        question,
        ...(topicId === undefined ? {} : { topicId }),
        candidates: [],
        candidateLedger: { candidates: [] },
        sourceMap: [],
        selectedConversation: [],
        gaps: [],
        consumerTaskId,
        requestedOutputTokens: 32,
      };
    },
    measureAssembly: async (_load: LoadedTurn, assembly: ContextAssembly): Promise<ContextState> =>
      mode === "fit"
        ? deterministicContext("ready", 4, false, {
            question: assembly.question,
            consumer: assembly.topicId === undefined ? "direct" : "topic",
            ...(assembly.topicId === undefined ? {} : { topicId: assembly.topicId }),
          })
        : deterministicContext("needs_compaction", 101, false, {
            question: assembly.question,
            consumer: assembly.topicId === undefined ? "direct" : "topic",
            ...(assembly.topicId === undefined ? {} : { topicId: assembly.topicId }),
          }),
    initialCompactionManifest: async (_load: LoadedTurn, _state: ContextState, taskId: string) => {
      calls.push(taskId);
      const input = InitialCompactionProviderInputSchema.parse({
        question: "deterministic workflow",
        allowance: 100,
        overage: 1,
        mandatoryInputCost: 1,
        candidates: [
          manifestCandidate("c1", "document", 10),
          manifestCandidate("c2", "document", 8),
        ],
        toolBounds: { maximumCandidates: 2, maximumGroups: 2 },
      });
      return structuredViaAgent(
        taskId,
        "context_manifest",
        JSON.stringify(input),
        "emit_context_manifest",
        z.toJSONSchema(InitialContextManifestSchema),
        (value) => InitialContextManifestSchema.parse(value),
      );
    },
    createCompactionGroups: async (
      _load: LoadedTurn,
      _state: ContextState,
      _manifest: unknown,
      taskId: string,
    ) => {
      calls.push(taskId);
      return [
        { groupId: "g1", candidateIds: ["c1"], renderedTokenBudget: 8, mode: "normal" as const },
        { groupId: "g2", candidateIds: ["c2"], renderedTokenBudget: 7, mode: "normal" as const },
      ];
    },
    compactContextGroup: async (
      _load: LoadedTurn,
      _state: ContextState,
      group: {
        readonly groupId: string;
        readonly candidateIds: readonly string[];
        readonly renderedTokenBudget: number;
        readonly mode: "normal";
      },
      taskId: string,
    ) => {
      calls.push(taskId);
      activeGroups += 1;
      maximumGroups = Math.max(maximumGroups, activeGroups);
      try {
        normalGroupsEntered += 1;
        if (normalGroupsEntered === 2) {
          groupsOverlapped = true;
          releaseNormalGroups();
        }
        await normalGroupsBarrier;
        const candidateId = group.candidateIds[0]!;
        const input = NormalCompactionProviderInputSchema.parse({
          question: "deterministic workflow",
          group,
          candidates: [
            {
              candidateId,
              kind: "document",
              label: `Document ${candidateId}`,
              purpose: "workflow evidence",
              date: "2026-07-01",
              passages: [{ passageId: "p1", text: "Exact evidence." }],
            },
          ],
        });
        const result = await structuredViaAgent(
          taskId,
          "context_compact_group",
          JSON.stringify(input),
          "emit_compaction_result",
          z.toJSONSchema(GroupCompactionResultSchema),
          (value) => GroupCompactionResultSchema.parse(value),
        );
        return { groupId: group.groupId, result, renderedTokenCount: 1 };
      } finally {
        activeGroups -= 1;
      }
    },
    collectCompaction: async (
      _load: LoadedTurn,
      _state: ContextState,
      manifest: unknown,
      groups: readonly unknown[],
      envelopes: readonly unknown[],
      _taskId: string,
    ) => ({
      phase: "compact" as const,
      groups,
      taskIds: envelopes.map((envelope) => (envelope as { readonly groupId: string }).groupId),
      envelopes,
      selections: [],
      repairUsed: false,
    }),
    measureCompaction: async (
      _load: LoadedTurn,
      _state: ContextState,
      pass: { readonly phase: "compact" | "fallback" },
    ): Promise<ContextState> =>
      pass.phase === "compact"
        ? mode === "compact"
          ? deterministicContext("ready", 90, true)
          : deterministicContext("needs_compaction", 101, true)
        : mode === "fallback"
          ? deterministicContext("ready", 90, true)
          : deterministicContext("failed", 101, true),
    fallbackCompactionManifest: async (
      _load: LoadedTurn,
      _state: ContextState,
      _initial: unknown,
      _firstPass: unknown,
      _measurement: unknown,
      taskId: string,
    ) => {
      calls.push(taskId);
      const input = FallbackCompactionProviderInputSchema.parse({
        question: "deterministic workflow",
        allowance: 100,
        remainingOverage: 1,
        originalCandidates: [
          manifestCandidate("c1", "document", 10),
          manifestCandidate("c2", "document", 8),
        ],
        initialManifest: {
          decisions: [
            { candidateId: "c1", action: "compact", groupId: "g1", reason: "compact" },
            { candidateId: "c2", action: "compact", groupId: "g2", reason: "compact" },
          ],
          groups: [
            { groupId: "g1", renderedTokenBudget: 8 },
            { groupId: "g2", renderedTokenBudget: 7 },
          ],
        },
        firstPass: [
          {
            groupId: "g1",
            actualRenderedTokenCount: 2,
            decisions: [
              { candidateId: "c1", action: "select", passageIds: ["p1"], reason: "first pass" },
            ],
          },
          {
            groupId: "g2",
            actualRenderedTokenCount: 2,
            decisions: [
              { candidateId: "c2", action: "select", passageIds: ["p1"], reason: "first pass" },
            ],
          },
        ],
      });
      return structuredViaAgent(
        taskId,
        "context_fallback_manifest",
        JSON.stringify(input),
        "emit_fallback_context_manifest",
        z.toJSONSchema(FallbackContextManifestSchema),
        (value) => FallbackContextManifestSchema.parse(value),
      );
    },
    createFallbackCompactionGroups: async (
      _load: LoadedTurn,
      _state: ContextState,
      _initial: unknown,
      _firstPass: unknown,
      _manifest: unknown,
      taskId: string,
    ) => {
      calls.push(taskId);
      return [];
    },
    collectFallbackCompaction: async (
      _load: LoadedTurn,
      _state: ContextState,
      _manifest: unknown,
      groups: readonly unknown[],
      envelopes: readonly unknown[],
      _firstPass: unknown,
      _taskId: string,
    ) => ({
      phase: "fallback" as const,
      groups,
      taskIds: [],
      envelopes,
      selections: [],
      repairUsed: false,
    }),
    selectCompactionContext: async (_load: LoadedTurn, state: ContextState, taskId: string) => {
      calls.push(taskId);
      terminalFailureCode = state.failureCode;
      return state;
    },
    answerDirect: async (_load: LoadedTurn, _state: ContextState, taskId: string) => {
      calls.push(taskId);
      const runtime = currentTaskRuntime();
      if (runtime === undefined) throw new Error("missing Smithers runtime for answer");
      const chunks: string[] = [];
      await agent.stream(
        deterministicAnswerRequest,
        {
          taskId,
          loopIteration: runtime.loopIteration,
          attempt: runtime.attempt,
          providerRequestIndex: 0,
          agentRole: "direct_answer",
        },
        (delta) => {
          chunks.push(delta);
        },
      );
      return {
        status: "ok" as const,
        mode: "single" as const,
        content: chunks.join(""),
        sourceMap: [],
      };
    },
    allocateFanout: async () => {
      calls.push("fanout-allocate");
      return { packetOutputTokens: 32, synthesisUsableInput: 100, fixedSynthesisInput: 4 };
    },
    mergeFanoutSources: async () => ({ sources: [] }),
    mergeFanoutSourceMaps: () => [],
    answerTopic: async (_load: LoadedTurn, context: ContextState, taskId: string) => {
      calls.push(taskId);
      const topicId = context.topicId;
      if (topicId === undefined) throw new Error("topic answer lacks topic ID");
      return structuredViaAgent(
        taskId,
        "topic_answer",
        JSON.stringify({ topicId }),
        "emit_topic_packet",
        z.toJSONSchema(canonicalProviderValueSchemas.topicPacket),
        (value) => canonicalProviderValueSchemas.topicPacket.parse(value),
        { requestClass: "main", useCompactionProofs: false },
      );
    },
    synthesisContext: async (
      _load: LoadedTurn,
      packets: readonly unknown[],
    ): Promise<ContextState> =>
      deterministicContext("ready", 4, false, {
        question: "deterministic fanout workflow",
        consumer: "synthesis",
        request: {
          ...deterministicAnswerRequest,
          messages: [{ role: "user", content: JSON.stringify({ packets }) }],
        },
      }),
    recordSynthesisContextMeasurement: async () => undefined,
    synthesize: async (_load: LoadedTurn, _state: ContextState, taskId: string) => {
      calls.push(taskId);
      const runtime = currentTaskRuntime();
      if (runtime === undefined) throw new Error("missing Smithers runtime for synthesis");
      const chunks: string[] = [];
      await agent.stream(
        {
          ...deterministicAnswerRequest,
          messages: [{ role: "user", content: JSON.stringify({ packets: [] }) }],
        },
        {
          taskId,
          loopIteration: runtime.loopIteration,
          attempt: runtime.attempt,
          providerRequestIndex: 0,
          agentRole: "synthesis",
        },
        (delta) => {
          chunks.push(delta);
        },
      );
      return {
        status: "ok" as const,
        mode: "synthesis" as const,
        content: chunks.join(""),
        sourceMap: [],
      };
    },
    finalize: async () => ({
      status: "succeeded" as const,
      assistantMessageId: "00000000-0000-4000-8000-000000000105",
      memory: { created: 0, updated: 0, discarded: 0, writes: [] },
      usage: {
        model: {
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          requestCount: 0,
        },
        web: { searchCount: 0, fetchCount: 0, responseBytes: 0, billedUnits: 0 },
      },
      alreadyTerminal: false,
    }),
  };
  try {
    const workflow = buildAiChatWorkflow(storage, {
      operations: operations as unknown as CanonicalWorkflowOperations,
      config: deterministicWorkflowConfig,
    });
    const result = await runSmithersWorkflow(workflow, {
      runId: `deterministic-production-${mode}`,
      input: { aiRunId: deterministicWorkflowLoad.aiRunId },
      logDir: null,
      resume: false,
    });
    return {
      result,
      calls,
      providerCalls,
      maximumGroups,
      groupsOverlapped,
      replacementActions,
      retrievalSearches,
      retrievalReviewCalls,
      replacementResultLabel,
      replacementResultUsed,
      terminalFailureCode,
    };
  } finally {
    await storage.close?.();
  }
};

describe("deterministic v4 retrieval and compaction roles", () => {
  const manifestCandidate = (
    candidateId: string,

    kind: "document" | "chat_message" | "memory",
    renderedTokenCount: number,
  ) => ({
    candidateId,
    kind,
    label: `${kind} ${candidateId}`,
    purpose: "retain the focused evidence",
    date: "2026-07-01",
    renderedTokenCount,
    preview: `${kind} preview`,
  });

  const structured = <Output>(
    taskId: string,
    user: string,
    outputToolName: string,
    outputSchema: Readonly<Record<string, unknown>>,
    validate: (value: unknown) => Output,
    agentRole:
      | "context_manifest"
      | "context_fallback_manifest"
      | "context_compact_group"
      | "context_fallback_group",
  ) =>
    withBoundaryTask(taskId, async () => {
      const completion = await boundary().complete(
        {
          requestClass: "fast",
          model: "glm-5-turbo",
          messages: [
            { role: "system", content: "deterministic v4 role" },
            { role: "user", content: user },
          ],
          sourceExposureProofs: compactionProofsFor(user),
          tools: [
            {
              name: outputToolName,
              description: outputToolName,
              parameters: outputSchema,
            },
          ],
          toolChoice: "auto",
          requestedOutputTokens: 2_048,
          reasoning: "medium",
        },
        {
          taskId,
          loopIteration: 0,
          attempt: 1,
          providerRequestIndex: 0,
          agentRole,
        },
      );
      expect(completion.toolCalls).toHaveLength(1);
      return validate(completion.toolCalls[0]!.arguments);
    });

  it("emits a complete initial manifest with independent compact groups", async () => {
    const input = InitialCompactionProviderInputSchema.parse({
      question: "Compare solar and storage evidence.",
      allowance: 30,
      overage: 8,
      mandatoryInputCost: 1,
      candidates: [
        manifestCandidate("c1", "document", 10),
        manifestCandidate("c2", "chat_message", 8),
        manifestCandidate("c3", "memory", 1),
      ],
      toolBounds: { maximumCandidates: 3, maximumGroups: 3 },
    });
    const manifest = await structured(
      "context-manifest-cases",
      JSON.stringify(input),
      "emit_context_manifest",
      z.toJSONSchema(InitialContextManifestSchema),
      (value) => InitialContextManifestSchema.parse(value),
      "context_manifest",
    );
    expect(manifest.decisions).toEqual([
      {
        candidateId: "c1",
        action: "compact",
        groupId: "g1",
        reason: "retain exact evidence passages",
      },
      {
        candidateId: "c2",
        action: "compact",
        groupId: "g2",
        reason: "retain exact evidence passages",
      },
      { candidateId: "c3", action: "keep", reason: "retain provider-safe evidence" },
    ]);
    expect(manifest.groups).toEqual([
      { groupId: "g1", renderedTokenBudget: 9 },
      { groupId: "g2", renderedTokenBudget: 7 },
    ]);
  });

  it("runs the production fit-first workflow without a compaction provider call", async () => {
    const run = await runDeterministicProductionWorkflow("fit");
    expect(run.result.status).toBe("finished");
    expect(run.calls).not.toContain("single-compact-plan");
    expect(run.providerCalls.map((call) => call.agentRole)).toEqual([
      "internal_retrieval",
      "internal_retrieval",
      "direct_answer",
    ]);
    expect(run.replacementActions).toEqual(["replace"]);
    expect(run.retrievalSearches).toEqual([
      "single-retrieve-internal:initial",
      "single-retrieve-internal:replacement",
    ]);
    expect(run.retrievalReviewCalls).toBe(1);
    expect(run.replacementResultLabel).toBe("replacement");
    expect(run.replacementResultUsed).toBe(true);
  });

  it("runs direct, fanout topic, and synthesis production routes", async () => {
    const run = await runDeterministicProductionWorkflow("fit", "fanout");
    expect(run.result.status).toBe("finished");
    expect(run.calls).toEqual(
      expect.arrayContaining([
        "fanout-allocate",
        "topic-t1-answer",
        "topic-t2-answer",
        "fanout-synthesis",
      ]),
    );
    expect(
      run.providerCalls
        .filter((call) => call.agentRole === "internal_retrieval")
        .map((call) => call.taskId),
    ).toEqual(expect.arrayContaining(["topic-t1-retrieve-internal", "topic-t2-retrieve-internal"]));
    expect(
      run.providerCalls
        .filter((call) => call.agentRole === "topic_answer")
        .map((call) => call.taskId),
    ).toEqual(expect.arrayContaining(["topic-t1-answer", "topic-t2-answer"]));
    expect(
      run.providerCalls.filter((call) => call.agentRole === "synthesis").map((call) => call.taskId),
    ).toEqual(["fanout-synthesis"]);
  });

  it("runs bounded production compaction groups and records both provider calls", async () => {
    const run = await runDeterministicProductionWorkflow("compact");
    expect(run.result.status).toBe("finished");
    expect(run.calls).toEqual(
      expect.arrayContaining(["single-compact-plan", "single-compact-g001", "single-compact-g002"]),
    );
    expect(run.maximumGroups).toBeLessThanOrEqual(3);
    expect(run.groupsOverlapped).toBe(true);
    expect(
      run.providerCalls.filter((call) => call.agentRole === "context_compact_group"),
    ).toHaveLength(2);
  });

  it("selects exact passages for a normal group", async () => {
    const input = NormalCompactionProviderInputSchema.parse({
      question: "Retain solar evidence.",
      group: {
        groupId: "g1",
        candidateIds: ["c1", "c2"],
        renderedTokenBudget: 8,
        mode: "normal",
      },
      candidates: [
        {
          candidateId: "c1",
          kind: "document",
          label: "Document one",
          purpose: "first evidence",
          date: "2026-07-01",
          passages: [
            { passageId: "p1", text: "Solar capacity rose." },
            { passageId: "p2", text: "A second detail." },
          ],
        },
        {
          candidateId: "c2",
          kind: "chat_message",
          label: "Chat one",
          purpose: "second evidence",
          date: "2026-07-02",
          passages: [{ passageId: "p3", text: "Storage demand grew." }],
        },
      ],
    });
    const result = await structured(
      "context-normal-group",
      JSON.stringify(input),
      "emit_compaction_result",
      z.toJSONSchema(GroupCompactionResultSchema),
      (value) => GroupCompactionResultSchema.parse(value),
      "context_compact_group",
    );
    expect(result.decisions).toEqual([
      {
        candidateId: "c1",
        action: "select",
        passageIds: ["p1"],
        reason: "select the first exact passage",
      },
      {
        candidateId: "c2",
        action: "select",
        passageIds: ["p3"],
        reason: "select the first exact passage",
      },
    ]);
  });

  it("runs one production fallback pass and no second fallback", async () => {
    const run = await runDeterministicProductionWorkflow("fallback");
    expect(run.result.status).toBe("finished");
    expect(run.calls).toContain("single-fallback-plan");
    expect(run.calls.some((call) => call.includes("single-fallback-g"))).toBe(false);
    expect(
      run.providerCalls.filter((call) => call.agentRole === "context_fallback_manifest"),
    ).toHaveLength(1);
  });

  it("ends the production workflow at context_plan_unfit without a third round", async () => {
    const run = await runDeterministicProductionWorkflow("unfit");
    expect(run.result.status).toBe("finished");
    expect(run.calls).not.toContain("single-answer");
    expect(run.calls).toContain("single-fallback-plan");
    expect(run.calls.some((call) => call.includes("single-fallback-plan-2"))).toBe(false);
    expect(run.terminalFailureCode).toBe("context_plan_unfit");
  });

  it("closes an unfit fallback without a second fallback or restored evidence", async () => {
    const initial = InitialContextManifestSchema.parse({
      decisions: [
        { candidateId: "c1", action: "compact", groupId: "g1", reason: "compact" },
        { candidateId: "c2", action: "keep", reason: "keep" },
      ],
      groups: [{ groupId: "g1", renderedTokenBudget: 5 }],
    });
    const input = FallbackCompactionProviderInputSchema.parse({
      question: "Retain exact evidence.",
      allowance: 1,
      remainingOverage: 9,
      originalCandidates: [
        manifestCandidate("c1", "document", 10),
        manifestCandidate("c2", "memory", 1),
      ],
      initialManifest: initial,
      firstPass: [
        {
          groupId: "g1",
          actualRenderedTokenCount: 2,
          decisions: [
            {
              candidateId: "c1",
              action: "select",
              passageIds: ["p1"],
              reason: "first pass",
            },
          ],
        },
      ],
    });
    const manifest = await structured(
      "context-fallback-unfit",
      JSON.stringify(input),
      "emit_fallback_context_manifest",
      z.toJSONSchema(FallbackContextManifestSchema),
      (value) => FallbackContextManifestSchema.parse(value),
      "context_fallback_manifest",
    );
    expect(manifest).toEqual({
      decisions: [
        {
          candidateId: "c1",
          action: "omit",
          reason: "omit the first-pass selection when it cannot tighten",
        },
        { candidateId: "c2", action: "retain", reason: "retain the prior whole candidate" },
      ],
      groups: [],
    });
  });

  it("uses only the fixed source candidate before terminal selection", async () => {
    const input = SourceToolCompactionProviderInputSchema.parse({
      question: "Retain solar evidence.",
      group: {
        groupId: "g1",
        candidateIds: ["c1"],
        renderedTokenBudget: 4,
        mode: "source_tool",
      },
      candidate: {
        candidateId: "c1",
        kind: "document",
        label: "Oversized document",
        purpose: "source-scoped evidence",
        date: "2026-07-01",
      },
      toolBounds: { maximumTurns: 3, maximumResults: 8, maximumBytes: 16_000 },
    });
    const calls: string[] = [];
    const sourceResultFor = (passageId: string, text: string) => {
      const logicalSourceIdentity = namespacedDocumentEvidenceIdentity(
        { kind: "public", sourceId: "public:source-1" },
        "document-1",
      );
      const contentHash = createHash("sha256").update(text, "utf8").digest("hex");
      const rangeHash = sha256Base64Url(JSON.stringify([{ charStart: 0, charEnd: text.length }]));
      return {
        __hartlibSourceExposures: [
          {
            sourceKind: "document" as const,
            logicalSourceIdentity,
            contentItemIdentity: `${logicalSourceIdentity}:snapshot-1:${rangeHash}`,
            exposureStage: "context_compaction_input" as const,
            visibleTokenCount: resolveRuntimeModel("glm-5-turbo").countTextTokens(text),
          },
        ],
        __hartlibSourceIdentity: [
          {
            snapshotId: "snapshot-1",
            contentHash,
            source: { kind: "public" as const, sourceId: "public:source-1" },
            ranges: [{ charStart: 0, charEnd: text.length }],
          },
        ],
      };
    };
    const result = await withBoundaryTask("context-source-tool", (agent) =>
      agent.toolLoop({
        requestClass: "fast",
        model: "glm-5-turbo",
        system: "deterministic source tool",
        user: JSON.stringify(input),
        tools: SourceCompactionToolDefinitions.map((definition) => ({
          definition,
          ...(definition.name === "search_source_passages"
            ? {
                parseArguments: (value: unknown) =>
                  SearchSourcePassagesArgumentsSchema.parse(value),
              }
            : definition.name === "read_source_passages"
              ? {
                  parseArguments: (value: unknown) =>
                    ReadSourcePassagesArgumentsSchema.parse(value),
                }
              : {}),
          execute: async (arguments_: Readonly<Record<string, unknown>>) => {
            calls.push(definition.name);
            if (definition.name === "search_source_passages") {
              expect(arguments_.candidateId).toBe("c1");
              return {
                found: true,
                complete: true,
                truncated: false,
                cursor: null,
                passages: [{ passageId: "p1", text: "Solar evidence." }],
                ...sourceResultFor("p1", "Solar evidence."),
              };
            }
            if (definition.name === "read_source_passages") {
              expect(arguments_.candidateId).toBe("c1");
              return {
                found: true,
                complete: true,
                truncated: false,
                cursor: null,
                passages: [{ passageId: "p1", text: "Solar evidence." }],
                ...sourceResultFor("p1", "Solar evidence."),
              };
            }
            return {};
          },
        })),
        terminalToolName: "emit_compaction_result",
        validateTerminal: (value) => GroupCompactionResultSchema.parse(value),
        maximumTurns: 3,
        reserveFinalTurnForTerminal: true,
        enforceTerminalTurn: true,
        requestedOutputTokens: 2_048,
        reasoning: "medium",
        coordinates: {
          taskId: "context-source-tool",
          attempt: 1,
          agentRole: "context_source_tool",
        },
      }),
    );
    expect(calls).toEqual(["search_source_passages", "read_source_passages"]);
    expect(result).toEqual({
      decisions: [
        {
          candidateId: "c1",
          action: "select",
          passageIds: ["p1"],
          reason: "select disclosed exact passages",
        },
      ],
    });
  });
});
