import { createHash } from "node:crypto";
import * as SmithersTaskRuntimeModule from "@smithers-orchestrator/driver/task-runtime";
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
import { PlanTurnProviderSchema, validatePlanTurn } from "../runtime/validators";
import { GeneralPlannerProviderOutputSchema } from "../evaluation/general-planner-workflow";
import { canonicalProviderValueSchemas } from "../workflow/operations";
import { DeterministicE2eProviderBoundary } from "./deterministic-provider";

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

const chatProof = (contentItemIdentity: string, visibleText: string) => ({
  sourceKind: "chat_message" as const,
  logicalSourceIdentity: chatMessageEvidenceIdentity(contentItemIdentity),
  contentItemIdentity,
  exposureStage: "provider_input",
  visibleText,
  visibleTokenCount: resolveRuntimeModel("glm-5-turbo").countTextTokens(visibleText),
});

const documentExposureMarker = (
  documentId: string,
  stage: "internal_search_preview" | "internal_inspection",
  visibleText: string,
  ranges?: readonly { readonly charStart: number; readonly charEnd: number }[],
) => {
  const logicalSourceIdentity = namespacedDocumentEvidenceIdentity(
    { kind: "public", sourceId: "public:test-source" },
    documentId,
  );
  const identityRanges = ranges ?? [{ charStart: 0, charEnd: visibleText.length }];
  const identityHash = sha256Base64Url(JSON.stringify(identityRanges));
  return {
    sourceKind: "document" as const,
    logicalSourceIdentity,
    contentItemIdentity: `${logicalSourceIdentity}:version-1:${identityHash}`,
    exposureStage: stage,
    visibleTokenCount: resolveRuntimeModel("glm-5-turbo").countTextTokens(visibleText),
  };
};

const deterministicDocumentContentHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const addDeterministicDocumentIdentity = (
  name: string,
  result: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  if (name === "search_internal" && Array.isArray(result.items)) {
    return {
      ...result,
      items: result.items.map((item) => {
        if (
          item === null ||
          typeof item !== "object" ||
          Array.isArray(item) ||
          (item as Record<string, unknown>).kind !== "document" ||
          typeof (item as Record<string, unknown>).documentId !== "string" ||
          typeof (item as Record<string, unknown>).snippet !== "string"
        ) {
          return item;
        }
        const document = item as Record<string, unknown>;
        const ranges = Array.isArray(document.ranges)
          ? document.ranges
          : [{ charStart: 0, charEnd: (document.snippet as string).length }];
        return {
          ...document,
          ranges,
          __briefSourceIdentity: {
            snapshotId: "version-1",
            contentHash: deterministicDocumentContentHash(document.snippet as string),
            ranges,
            source: { kind: "public", sourceId: "public:test-source" },
          },
        };
      }),
    };
  }
  if (
    name === "inspect_internal" &&
    result.found === true &&
    result.complete === true &&
    typeof result.text === "string"
  ) {
    const reference = result.reference;
    if (
      reference !== null &&
      typeof reference === "object" &&
      !Array.isArray(reference) &&
      (reference as Record<string, unknown>).kind === "document"
    ) {
      const ranges = Array.isArray(result.ranges)
        ? result.ranges
        : [{ charStart: 0, charEnd: (result.text as string).length }];
      return {
        ...result,
        __briefSourceIdentity: {
          snapshotId: "version-1",
          contentHash: deterministicDocumentContentHash(result.text as string),
          ranges,
          source: { kind: "public", sourceId: "public:test-source" },
        },
      };
    }
  }
  return result;
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
  execute: async (arguments_: Readonly<Record<string, unknown>>) =>
    addDeterministicDocumentIdentity(name, await execute(arguments_)),
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
    __briefSourceExposures: [memoryExposureMarker],
  })),
  memoryTool("inspect_memory", async () => ({
    found: true,
    complete: true,
    memory: memorySnapshot,
    __briefSourceExposures: [memoryExposureMarker],
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
          __briefSourceExposures: [memoryExposureMarker],
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
          __briefSourceExposures: [
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
      __briefSourceExposures: [memoryExposureMarker],
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
  it("uses only logical document IDs returned by search results", async () => {
    const inspected: Readonly<Record<string, unknown>>[] = [];
    const result = await withBoundaryTask("retrieve-internal", async (agent) =>
      agent.toolLoop({
        requestClass: "fast",
        model: "glm-5-turbo",
        system: "internal",
        user: JSON.stringify({ question: "solar" }),
        tools: [
          {
            ...memoryTool("search_internal", async () => ({
              items: [
                {
                  kind: "document",
                  documentId: "document-1",
                  snippet: "Solar capacity increased.",
                  title: "Public solar report",
                  publishedAt: "2026-01-01T00:00:00.000Z",
                },
              ],
              complete: true,
              truncated: false,
              cursor: null,
              __briefSourceExposures: [
                documentExposureMarker(
                  "document-1",
                  "internal_search_preview",
                  "Solar capacity increased.",
                ),
              ],
            })),
          },
          {
            ...memoryTool("inspect_internal", async (arguments_) => {
              inspected.push(arguments_);
              return {
                found: true,
                complete: true,
                reference: arguments_.reference,
                text: "Solar capacity increased.",
                ranges: [{ charStart: 0, charEnd: "Solar capacity increased.".length }],
                __briefSourceExposures: [
                  documentExposureMarker(
                    "document-1",
                    "internal_inspection",
                    "Solar capacity increased.",
                    [{ charStart: 0, charEnd: "Solar capacity increased.".length }],
                  ),
                ],
              };
            }),
          },
          memoryTool("emit_internal_manifest", async () => ({ complete: true })),
        ],
        terminalToolName: "emit_internal_manifest",
        validateTerminal: (value) =>
          canonicalProviderValueSchemas.internalManifestOutput.parse(value).entries,
        maximumTurns: 4,
        requestedOutputTokens: 2_048,
        reasoning: "medium",
        coordinates: { taskId: "retrieve-internal", attempt: 1, agentRole: "internal_retrieval" },
      }),
    );
    expect(result).toEqual([
      {
        kind: "document",
        documentId: "document-1",
        purpose: "ground the deterministic E2E answer",
      },
    ]);
    expect(inspected).toEqual([
      {
        reference: {
          kind: "document",
          documentId: "document-1",
          purpose: "ground the deterministic E2E answer",
        },
      },
    ]);
  });

  it("follows a pending search cursor before inspecting the next page", async () => {
    const searchCalls: Readonly<Record<string, unknown>>[] = [];
    const inspected: Readonly<Record<string, unknown>>[] = [];
    let page = 0;
    const result = await withBoundaryTask("retrieve-internal-cursor", async (agent) =>
      agent.toolLoop({
        requestClass: "fast",
        model: "glm-5-turbo",
        system: "internal",
        user: JSON.stringify({ question: "solar" }),
        tools: [
          {
            ...memoryTool("search_internal", async (arguments_) => {
              searchCalls.push(arguments_);
              page += 1;
              return page < 3
                ? {
                    items: [
                      {
                        kind: "document",
                        documentId: `document-page-${page}`,
                        snippet: `Page ${page}.`,
                      },
                    ],
                    complete: false,
                    truncated: true,
                    cursor: page,
                    __briefSourceExposures: [
                      documentExposureMarker(
                        `document-page-${page}`,
                        "internal_search_preview",
                        `Page ${page}.`,
                      ),
                    ],
                  }
                : {
                    items: [],
                    complete: true,
                    truncated: false,
                    cursor: null,
                  };
            }),
          },
          {
            ...memoryTool("inspect_internal", async (arguments_) => {
              inspected.push(arguments_);
              return {
                found: true,
                complete: true,
                reference: arguments_.reference,
                text: "Inspected page.",
                ranges: [{ charStart: 0, charEnd: "Inspected page.".length }],
                __briefSourceExposures: [
                  documentExposureMarker(
                    String((arguments_.reference as { documentId: string }).documentId),
                    "internal_inspection",
                    "Inspected page.",
                    [{ charStart: 0, charEnd: "Inspected page.".length }],
                  ),
                ],
              };
            }),
          },
          memoryTool("emit_internal_manifest", async () => ({ complete: true })),
        ],
        terminalToolName: "emit_internal_manifest",
        validateTerminal: (value) =>
          canonicalProviderValueSchemas.internalManifestOutput.parse(value).entries,
        maximumTurns: 5,
        requestedOutputTokens: 2_048,
        reasoning: "medium",
        coordinates: {
          taskId: "retrieve-internal-cursor",
          attempt: 1,
          agentRole: "internal_retrieval",
        },
      }),
    );
    expect(searchCalls).toHaveLength(3);
    expect(searchCalls[1]).toMatchObject({ cursor: 1 });
    expect(searchCalls[2]).toMatchObject({ cursor: 2 });
    expect(inspected).toHaveLength(2);
    expect(
      inspected.map((call_) => (call_.reference as { documentId: string }).documentId),
    ).toEqual(["document-page-1", "document-page-2"]);
    expect(result).toHaveLength(2);
  });

  it("resolves an earlier incomplete inspection in a parallel inspection set", async () => {
    const inspected: Readonly<Record<string, unknown>>[] = [];
    let inspectionCount = 0;
    const result = await withBoundaryTask("retrieve-internal-parallel", async (agent) =>
      agent.toolLoop({
        requestClass: "fast",
        model: "glm-5-turbo",
        system: "internal",
        user: JSON.stringify({ question: "solar" }),
        tools: [
          memoryTool("search_internal", async () => ({
            items: [
              { kind: "document", documentId: "document-complete", snippet: "Complete." },
              { kind: "document", documentId: "document-narrow", snippet: "Narrow." },
            ],
            complete: true,
            truncated: false,
            cursor: null,
            __briefSourceExposures: [
              documentExposureMarker("document-complete", "internal_search_preview", "Complete."),
              documentExposureMarker("document-narrow", "internal_search_preview", "Narrow."),
            ],
          })),
          {
            ...memoryTool("inspect_internal", async (arguments_) => {
              inspected.push(arguments_);
              inspectionCount += 1;
              return inspectionCount === 2
                ? {
                    found: true,
                    complete: false,
                    narrowerRangeRequired: true,
                    ranges: [{ charStart: 0, charEnd: 100 }],
                    textCharCount: 100,
                  }
                : {
                    found: true,
                    complete: true,
                    reference: arguments_.reference,
                    text: "Inspected document.",
                    ranges: [
                      (
                        arguments_.reference as {
                          readonly range?: { charStart: number; charEnd: number };
                        }
                      ).range ?? { charStart: 0, charEnd: "Inspected document.".length },
                    ],
                    __briefSourceExposures: [
                      documentExposureMarker(
                        String((arguments_.reference as { documentId: string }).documentId),
                        "internal_inspection",
                        "Inspected document.",
                        [
                          (
                            arguments_.reference as {
                              readonly range?: { charStart: number; charEnd: number };
                            }
                          ).range ?? { charStart: 0, charEnd: "Inspected document.".length },
                        ],
                      ),
                    ],
                  };
            }),
          },
          memoryTool("emit_internal_manifest", async () => ({ complete: true })),
        ],
        terminalToolName: "emit_internal_manifest",
        validateTerminal: (value) =>
          canonicalProviderValueSchemas.internalManifestOutput.parse(value).entries,
        maximumTurns: 5,
        requestedOutputTokens: 2_048,
        reasoning: "medium",
        coordinates: {
          taskId: "retrieve-internal-parallel",
          attempt: 1,
          agentRole: "internal_retrieval",
        },
      }),
    );
    expect(inspected).toHaveLength(3);
    expect(inspected[2]).toMatchObject({
      reference: {
        kind: "document",
        documentId: "document-narrow",
        range: { charStart: 0, charEnd: 50 },
      },
    });
    expect(result).toHaveLength(2);
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
