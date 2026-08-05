import * as SmithersTaskRuntimeModule from "@smithers-orchestrator/driver/task-runtime";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { CanonicalAgentClient, toolResultJson } from "./agent-client";
import { ExactPiBoundary, type PiCompletion } from "./pi-boundary";
import { WebBoundaryError } from "../web/errors";
import {
  chatMessageEvidenceIdentity,
  namespacedDocumentEvidenceIdentity,
  sha256Base64Url,
} from "./canonicalization";
import { resolveRegisteredModel } from "./model-registry";
import {
  providerRequestSourceExposureProofBindings,
  type CodeOwnedSourceExposureProof,
  type LiveProviderRequest,
  type ProviderVisibleSourceExposureMarker,
} from "./provider-request";
const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cachedTokens: 0,
  reasoningTokens: 0,
  totalTokens: 2,
  stopReason: "toolUse",
};
const completion = (toolCalls: PiCompletion["toolCalls"]): PiCompletion => ({
  text: "",
  toolCalls,
  usage,
  stopReason: "toolUse",
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

const inTask = <Value>(execute: () => Value, attempt = 1, iteration = 0): Value =>
  withTaskRuntime(
    {
      runId: "run",
      stepId: "a",
      attempt,
      iteration,
      signal: new AbortController().signal,
      db: {},
      heartbeat: () => undefined,
      lastHeartbeat: null,
    },
    execute,
  );

describe("canonical agent tool loop", () => {
  it("recovers a prose-only turn within the existing bounded loop", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(completion([]))
      .mockResolvedValueOnce(
        completion([{ id: "terminal", name: "emit", arguments: { ok: true } }]),
      );
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({}),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: 2,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it("mints document and chat source proofs only after search/read", async () => {
    for (const sourceKind of ["document", "chat_message"] as const) {
      const run = async (terminalPassageId: string) => {
        const countTextTokens = resolveRegisteredModel("glm-5-turbo").countTextTokens;
        const firstText = "first exact passage";
        const secondText = "second exact passage";
        const requests: LiveProviderRequest[] = [];
        const markerFor = (passageId: string, text: string) => {
          const charStart = passageId === "p1" ? 0 : firstText.length;
          const charEnd = charStart + text.length;
          const visibleByteCount = new TextEncoder().encode(text).byteLength;
          const logicalSourceIdentity =
            sourceKind === "chat_message"
              ? chatMessageEvidenceIdentity(`source-chat-${passageId}`)
              : namespacedDocumentEvidenceIdentity(
                  { kind: "public", sourceId: "public:source-1" },
                  "doc-1",
                );
          const contentItemIdentity =
            sourceKind === "chat_message"
              ? `source-chat-${passageId}`
              : `${logicalSourceIdentity}:snapshot-1:${sha256Base64Url(
                  JSON.stringify([{ charStart, charEnd }]),
                )}`;
          return {
            marker: {
              sourceKind,
              logicalSourceIdentity,
              contentItemIdentity,
              exposureStage: "context_compaction_input",
              visibleTokenCount: countTextTokens(text),
            } satisfies ProviderVisibleSourceExposureMarker,
            identity:
              sourceKind === "document"
                ? {
                    snapshotId: "snapshot-1",
                    contentHash: createHash("sha256").update(text, "utf8").digest("hex"),
                    source: { kind: "public", sourceId: "public:source-1" },
                    ranges: [{ charStart, charEnd }],
                  }
                : {
                    candidateId: "c1",
                    passageId,
                    charStart,
                    charEnd,
                    visibleByteCount,
                    chatReconstruction: {
                      messageId: `source-chat-${passageId}`,
                      contentHash: createHash("sha256").update(text, "utf8").digest("hex"),
                      ranges: [{ charStart, charEnd }],
                    },
                  },
          };
        };
        const sourceResult = (
          passageId: string,
          text: string,
        ): Readonly<Record<string, unknown>> => {
          const source = markerFor(passageId, text);
          return {
            found: true,
            complete: true,
            truncated: false,
            cursor: null,
            passages: [{ passageId, text }],
            __hartlibSourceExposures: [source.marker],
            __hartlibSourceIdentity: [source.identity],
          };
        };
        const completionFor = (requestIndex: number): PiCompletion =>
          requestIndex === 0
            ? completion([
                {
                  id: "search-1",
                  name: "search_source_passages",
                  arguments: { candidateId: "c1", query: "exact" },
                },
              ])
            : requestIndex === 1
              ? completion([
                  {
                    id: "read-1",
                    name: "read_source_passages",
                    arguments: {
                      candidateId: "c1",
                      passageIds: ["p2"],
                      adjacentToPassageId: "p1",
                    },
                  },
                ])
              : completion([
                  {
                    id: "terminal-1",
                    name: "emit_compaction_result",
                    arguments: {
                      decisions: [
                        {
                          candidateId: "c1",
                          action: "select",
                          passageIds: [terminalPassageId],
                          reason: "select one disclosed passage",
                        },
                      ],
                    },
                  },
                ]);
        const complete = vi.fn(async (request: LiveProviderRequest) => {
          requests.push(request);
          return completionFor(requests.length - 1);
        });
        const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);
        const output = await inTask(() =>
          client.toolLoop({
            requestClass: "fast",
            model: "glm-5-turbo",
            system: "system",
            user: JSON.stringify({
              toolBounds: { maximumTurns: 3, maximumResults: 32, maximumBytes: 64_000 },
            }),
            tools: [
              {
                definition: {
                  name: "search_source_passages",
                  description: "Search exact source passages",
                  parameters: {},
                },
                parseArguments: (value) => value as Readonly<Record<string, unknown>>,
                execute: async () => sourceResult("p1", firstText),
              },
              {
                definition: {
                  name: "read_source_passages",
                  description: "Read exact source passages",
                  parameters: {},
                },
                parseArguments: (value) => value as Readonly<Record<string, unknown>>,
                execute: async () => sourceResult("p2", secondText),
              },
              {
                definition: {
                  name: "emit_compaction_result",
                  description: "Emit the bounded result",
                  parameters: {},
                },
                parseArguments: (value) => value as Readonly<Record<string, unknown>>,
                execute: async () => ({ complete: true }),
              },
            ],
            terminalToolName: "emit_compaction_result",
            validateTerminal: (value) => {
              const decision = (
                value as {
                  readonly decisions?: readonly {
                    readonly passageIds?: readonly string[];
                  }[];
                }
              ).decisions?.[0];
              if (decision?.passageIds?.[0] !== "p2") {
                throw new Error("terminal selected an undisclosed passage");
              }
              return value;
            },
            maximumTurns: 3,
            maximumResults: 32,
            maximumBytes: 64_000,
            reserveFinalTurnForTerminal: true,
            enforceTerminalTurn: true,
            requestedOutputTokens: 64,
            reasoning: "medium",
            coordinates: { taskId: "a", attempt: 0, agentRole: "context_source_tool" },
          }),
        );
        return { output, requests };
      };

      const successful = await run("p2");
      expect(successful.output).toMatchObject({
        decisions: [{ candidateId: "c1", action: "select", passageIds: ["p2"] }],
      });
      expect(successful.requests).toHaveLength(3);
      expect(successful.requests[0]?.sourceExposureProofs).toEqual([]);
      expect(successful.requests[1]?.sourceExposureProofs).toHaveLength(1);
      expect(successful.requests[2]?.sourceExposureProofs).toHaveLength(2);
      expect(
        successful.requests[2]?.sourceExposureProofs?.reduce(
          (total, proof) =>
            total +
            ("visibleByteCount" in proof && typeof proof.visibleByteCount === "number"
              ? proof.visibleByteCount
              : 0),
          0,
        ),
      ).toBe(
        new TextEncoder().encode("first exact passage").byteLength +
          new TextEncoder().encode("second exact passage").byteLength,
      );
      expect(JSON.parse(successful.requests[0]?.messages[1]?.content ?? "{}")).toEqual({
        toolBounds: { maximumTurns: 3, maximumResults: 32, maximumBytes: 64_000 },
      });
      expect(successful.requests[0]?.tools?.map((tool) => tool.name)).toEqual([
        "search_source_passages",
        "read_source_passages",
      ]);
      expect(successful.requests[2]?.tools?.map((tool) => tool.name)).toEqual([
        "emit_compaction_result",
      ]);
      expect(successful.requests[2]?.messages.at(-1)).toMatchObject({ role: "tool" });
      await expect(run("p9")).rejects.toThrow(/context_compaction_failed/iu);
    }
  });
  it("enforces exact serialized source-result occurrence bounds", async () => {
    const model = resolveRegisteredModel("glm-5-turbo");
    const passage = {
      passageId: "p1",
      text: `long-${"x".repeat(96)}\n"quoted"\\backslash\nline three`,
    };
    const sourceMarker: ProviderVisibleSourceExposureMarker = {
      sourceKind: "chat_message",
      logicalSourceIdentity: chatMessageEvidenceIdentity("source-chat-p1"),
      contentItemIdentity: "source-chat-p1",
      exposureStage: "context_compaction_input",
      visibleTokenCount: model.countTextTokens(passage.text),
    };
    const sourceResult = {
      found: true,
      complete: true,
      truncated: false,
      cursor: null,
      passages: [passage],
      __hartlibSourceExposures: [sourceMarker],
      __hartlibSourceIdentity: [
        {
          candidateId: "c1",
          passageId: passage.passageId,
          charStart: 0,
          charEnd: passage.text.length,
          visibleByteCount: new TextEncoder().encode(passage.text).byteLength,
          chatReconstruction: {
            messageId: "source-chat-p1",
            contentHash: createHash("sha256").update(passage.text, "utf8").digest("hex"),
            ranges: [{ charStart: 0, charEnd: passage.text.length }],
          },
        },
      ],
    };
    const serialized = toolResultJson(sourceResult);
    const resultBytes = new TextEncoder().encode(serialized).byteLength;
    const resultTokens = model.countTextTokens(serialized);
    let observedProviderCalls = 0;
    const run = async (occurrences: number, maximumResults: number) => {
      const requests: LiveProviderRequest[] = [];
      const complete = vi.fn(async (request: LiveProviderRequest) => {
        observedProviderCalls += 1;
        requests.push(request);
        const requestIndex = requests.length - 1;
        const call =
          requestIndex < occurrences
            ? {
                id: `search-${requestIndex}`,
                name: "search_source_passages",
                arguments: { candidateId: "c1", query: "line" },
              }
            : { id: "terminal", name: "emit", arguments: { ok: true } };
        return completion([call]);
      });
      const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);
      const output = await inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: {
                name: "search_source_passages",
                description: "Search source",
                parameters: {},
              },
              parseArguments: (value) => value as Readonly<Record<string, unknown>>,
              execute: async () => sourceResult,
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              parseArguments: (value) => value as Readonly<Record<string, unknown>>,
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: occurrences + 1,
          maximumResults,
          maximumBytes: resultBytes * maximumResults,
          maximumResultTokens: resultTokens * maximumResults,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "context_source_tool" },
        }),
      );
      return { complete, output };
    };

    const exact = await run(2, 2);
    expect(exact.output).toEqual({ ok: true });
    expect(exact.complete).toHaveBeenCalledTimes(3);
    expect(observedProviderCalls).toBe(3);

    await expect(run(3, 2)).rejects.toThrow(/context_compaction_failed/iu);
    expect(observedProviderCalls).toBe(6);
  });

  it("never logs internal search or inspection result bodies", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "search-1", name: "search_evidence", arguments: {} }]),
      )
      .mockResolvedValueOnce(
        completion([
          {
            id: "inspect-1",
            name: "inspect_evidence",
            arguments: { reference: { kind: "chat_message", messageId: "restricted-message" } },
          },
        ]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "terminal-1", name: "emit", arguments: { ok: true } }]),
      );
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        inTask(() =>
          client.toolLoop({
            requestClass: "fast",
            model: "glm-5-turbo",
            system: "system",
            user: "user",
            tools: [
              {
                definition: {
                  name: "search_evidence",
                  description: "Search",
                  parameters: {},
                },
                execute: async () => ({ matches: [], complete: true }),
              },
              {
                definition: {
                  name: "inspect_evidence",
                  description: "Inspect",
                  parameters: {},
                },
                execute: async () => ({ found: false, complete: true }),
              },
              {
                definition: { name: "emit", description: "Emit", parameters: {} },
                execute: async () => ({ complete: true }),
              },
            ],
            terminalToolName: "emit",
            validateTerminal: (value) => value,
            maximumTurns: 3,
            requestedOutputTokens: 64,
            reasoning: "medium",
            coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
          }),
        ),
      ).resolves.toEqual({ ok: true });
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("recovers a malformed tool call without executing it", async () => {
    const execute = vi.fn(async () => ({}));
    const complete = vi
      .fn()
      .mockResolvedValueOnce(completion([{ id: "bad", name: "emit", arguments: null } as never]))
      .mockResolvedValueOnce(
        completion([{ id: "terminal", name: "emit", arguments: { ok: true } }]),
      );
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute,
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: 2,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("maps malformed post-boundary structured output to the exact role code", async () => {
    const client = new CanonicalAgentClient({
      complete: vi.fn(async () => completion([])),
    } as unknown as ExactPiBoundary);

    const failure = await inTask(() =>
      client.structured({
        requestClass: "fast",
        model: "glm-5-turbo",
        system: "system",
        user: "user",
        outputToolName: "emit_plan",
        outputToolDescription: "Emit plan",
        outputSchema: { type: "object" },
        validate: (value) => value,
        requestedOutputTokens: 64,
        reasoning: "medium",
        coordinates: {
          taskId: "a",
          loopIteration: 0,
          attempt: 0,
          providerRequestIndex: 0,
          agentRole: "plan_turn",
        },
      }),
    ).then(
      () => {
        throw new Error("expected structured output failure");
      },
      (error) => error,
    );
    expect(failure).toMatchObject({ code: "plan_turn_failed", retryable: true });
    expect(failure).not.toMatchObject({ details: { failureRetryable: false } });
  });
  it("yields once before provider proof verification and completion", async () => {
    let fairnessMarkerRan = false;
    let observedFairness = false;
    setImmediate(() => {
      fairnessMarkerRan = true;
    });
    const complete = vi.fn(async () => {
      observedFairness = fairnessMarkerRan;
      return completion([{ id: "call", name: "emit", arguments: { ok: true } }]);
    });
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.structured({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          outputToolName: "emit",
          outputToolDescription: "Emit",
          outputSchema: { type: "object" },
          validate: (value) => value,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: {
            taskId: "a",
            loopIteration: 0,
            attempt: 0,
            providerRequestIndex: 0,
            agentRole: "plan_turn",
          },
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(observedFairness).toBe(true);
  });

  it("classifies a provider schema validation failure as a bounded task retry", async () => {
    const client = new CanonicalAgentClient({
      complete: vi.fn(async () =>
        completion([{ id: "call", name: "emit", arguments: { malformed: true } }]),
      ),
    } as unknown as ExactPiBoundary);

    const failure = await inTask(() =>
      client.structured({
        requestClass: "fast",
        model: "glm-5-turbo",
        system: "system",
        user: "user",
        outputToolName: "emit",
        outputToolDescription: "Emit",
        outputSchema: { type: "object" },
        validate: () => {
          throw new Error("provider output does not match the schema");
        },
        requestedOutputTokens: 64,
        reasoning: "medium",
        coordinates: {
          taskId: "a",
          loopIteration: 0,
          attempt: 0,
          providerRequestIndex: 0,
          agentRole: "plan_turn",
        },
      }),
    ).then(
      () => {
        throw new Error("expected schema validation failure");
      },
      (error) => error,
    );
    expect(failure).toMatchObject({ code: "plan_turn_failed", retryable: true });
    expect(failure).not.toMatchObject({ details: { failureRetryable: false } });
  });

  it("repairs one semantic structured result at the next provider request index", async () => {
    const coordinates: unknown[] = [];
    const complete = vi.fn(async (_request, requestCoordinates) => {
      coordinates.push(requestCoordinates);
      return completion([
        {
          id: "call",
          name: "emit",
          arguments: coordinates.length === 1 ? { ok: false } : { ok: true },
        },
      ]);
    });
    const repair = vi.fn(() => ({
      user: JSON.stringify({ priorValidationFeedback: "schema_invalid" }),
    }));
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.structured({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          outputToolName: "emit",
          outputToolDescription: "Emit a semantic result.",
          outputSchema: { type: "object" },
          validate: (value) => {
            if (
              value === null ||
              typeof value !== "object" ||
              !("ok" in value) ||
              value.ok !== true
            ) {
              throw new Error("invalid semantic result");
            }
            return value;
          },
          repair,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: {
            taskId: "a",
            loopIteration: 2,
            attempt: 7,
            providerRequestIndex: 4,
            agentRole: "plan_turn",
          },
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(coordinates).toEqual([
      expect.objectContaining({
        taskId: "a",
        attempt: 1,
        loopIteration: 0,
        providerRequestIndex: 4,
      }),
      expect.objectContaining({
        taskId: "a",
        attempt: 1,
        loopIteration: 0,
        providerRequestIndex: 5,
      }),
    ]);
  });

  it("fails after the one structured repair remains invalid", async () => {
    const complete = vi.fn(async () =>
      completion([{ id: "call", name: "emit", arguments: { ok: false } }]),
    );
    const repair = vi.fn(() => ({
      user: JSON.stringify({ priorValidationFeedback: "schema_invalid" }),
    }));
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.structured({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          outputToolName: "emit",
          outputToolDescription: "Emit",
          outputSchema: { type: "object" },
          validate: () => {
            throw new Error("invalid semantic result");
          },
          repair,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: {
            taskId: "a",
            loopIteration: 0,
            attempt: 0,
            providerRequestIndex: 0,
            agentRole: "plan_turn",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "plan_turn_failed", retryable: true });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("does not run structured repair for boundary or source-proof failures", async () => {
    const repair = vi.fn(() => ({
      user: JSON.stringify({ priorValidationFeedback: "schema_invalid" }),
    }));
    const boundary = new CanonicalAgentClient({
      complete: vi.fn(async () => {
        throw new Error("transport failed");
      }),
    } as unknown as ExactPiBoundary);
    await expect(
      inTask(() =>
        boundary.structured({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          outputToolName: "emit",
          outputToolDescription: "Emit",
          outputSchema: { type: "object" },
          validate: (value) => value,
          repair,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: {
            taskId: "a",
            loopIteration: 0,
            attempt: 0,
            providerRequestIndex: 0,
            agentRole: "plan_turn",
          },
        }),
      ),
    ).rejects.toBeDefined();
    expect(repair).not.toHaveBeenCalled();

    const proofFailure = new CanonicalAgentClient({
      complete: vi.fn(async () => completion([])),
    } as unknown as ExactPiBoundary);
    await expect(
      inTask(() =>
        proofFailure.structured({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          outputToolName: "emit",
          outputToolDescription: "Emit",
          outputSchema: { type: "object" },
          validate: (value) => value,
          repair,
          sourceExposureProofs: [
            {
              sourceKind: "document",
              logicalSourceIdentity: "document:public:one",
              contentItemIdentity: "document:public:one:version",
              exposureStage: "test",
              visibleTokenCount: -1,
            },
          ],
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: {
            taskId: "a",
            loopIteration: 0,
            attempt: 0,
            providerRequestIndex: 0,
            agentRole: "plan_turn",
          },
        }),
      ),
    ).rejects.toBeDefined();
    expect(repair).not.toHaveBeenCalled();
  });

  it("classifies parallel terminal calls as bounded provider-output retries", async () => {
    const client = new CanonicalAgentClient({
      complete: vi.fn(async () =>
        completion([
          { id: "terminal", name: "emit", arguments: { ok: true } },
          { id: "extra", name: "search", arguments: { query: "solar" } },
        ]),
      ),
    } as unknown as ExactPiBoundary);

    const failure = await inTask(() =>
      client.toolLoop({
        requestClass: "fast",
        model: "glm-5-turbo",
        system: "system",
        user: "user",
        tools: [
          {
            definition: { name: "search", description: "Search", parameters: {} },
            execute: async () => ({}),
          },
          {
            definition: { name: "emit", description: "Emit", parameters: {} },
            execute: async () => ({}),
          },
        ],
        terminalToolName: "emit",
        validateTerminal: (value) => value,
        maximumTurns: 1,
        requestedOutputTokens: 64,
        reasoning: "medium",
        coordinates: { taskId: "a", attempt: 0, agentRole: "web_research" },
      }),
    ).then(
      () => {
        throw new Error("expected parallel terminal failure");
      },
      (error) => error,
    );
    expect(failure).toMatchObject({ code: "web_research_failed", retryable: true });
    expect(failure).not.toMatchObject({ details: { failureRetryable: false } });
  });

  it("preserves a non-retryable typed boundary policy failure", async () => {
    const policyFailure = new WebBoundaryError(
      "unsupported_policy",
      "saved web policy unavailable",
      false,
    );
    const client = new CanonicalAgentClient({
      complete: vi.fn(async () => {
        throw policyFailure;
      }),
    } as unknown as ExactPiBoundary);

    const failure = await inTask(() =>
      client.toolLoop({
        requestClass: "fast",
        model: "glm-5-turbo",
        system: "system",
        user: "user",
        tools: [],
        terminalToolName: "emit",
        validateTerminal: (value) => value,
        maximumTurns: 1,
        requestedOutputTokens: 64,
        reasoning: "medium",
        coordinates: { taskId: "a", attempt: 0, agentRole: "web_research" },
      }),
    ).then(
      () => {
        throw new Error("expected boundary failure");
      },
      (error) => error,
    );
    expect(failure).toBe(policyFailure);
    expect(failure).toMatchObject({
      code: "unsupported_policy",
      retryable: false,
    });
  });

  it("forwards the exact request hook through structured calls after coordinates resolve", async () => {
    const seen: unknown[] = [];
    const complete = vi.fn(async (request, coordinates, beforeRequest) => {
      await beforeRequest?.(request, coordinates, {
        modelId: "glm-5-turbo",
        inputTokens: 10,
        requestedOutputTokens: 64,
        usableInputTokens: 100,
        contextWindow: 164,
        passed: true,
      });
      return completion([{ id: "call", name: "emit", arguments: { ok: true } }]);
    });
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.structured({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          outputToolName: "emit",
          outputToolDescription: "Emit",
          outputSchema: { type: "object" },
          validate: (value) => value,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: {
            taskId: "a",
            loopIteration: 0,
            attempt: 0,
            providerRequestIndex: 0,
            agentRole: "plan_turn",
          },
          onBeforeRequest: (request, coordinates, measurement) => {
            seen.push({ request, coordinates, measurement });
          },
        }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(seen).toEqual([
      expect.objectContaining({
        coordinates: expect.objectContaining({ taskId: "a", attempt: 1, loopIteration: 0 }),
        measurement: expect.objectContaining({ passed: true }),
        request: expect.objectContaining({ model: "glm-5-turbo", toolChoice: "auto" }),
      }),
    ]);
  });

  it("preserves every assistant call and complete tool result in the next exact-gated transcript", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "call-1", name: "search_evidence", arguments: { terms: "solar" } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "call-2", name: "emit", arguments: { ids: ["a"] } }]),
      );
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);
    const result = await inTask(() =>
      client.toolLoop({
        requestClass: "fast",
        model: "glm-5-turbo",
        system: "system",
        user: "user",
        tools: [
          {
            definition: {
              name: "search_evidence",
              description: "Search",
              parameters: { type: "object" },
            },
            execute: async () => ({
              complete: true,
              matches: [
                {
                  kind: "chat_message",
                  text: "visible",
                  __hartlibSourceIdentity: {
                    chatReconstruction: {
                      messageId: "public-message",
                      contentHash: createHash("sha256").update("visible", "utf8").digest("hex"),
                      ranges: [{ charStart: 0, charEnd: "visible".length }],
                    },
                  },
                },
              ],
              __hartlibSourceExposures: [
                {
                  sourceKind: "chat_message",
                  logicalSourceIdentity: chatMessageEvidenceIdentity("public-message"),
                  contentItemIdentity: `chat_message:public-message:0:7:${createHash("sha256").update("visible", "utf8").digest("hex")}`,
                  exposureStage: "evaluation_general_planner_search",
                  visibleTokenCount:
                    resolveRegisteredModel("glm-5-turbo").countTextTokens("visible"),
                },
              ],
            }),
          },
          {
            definition: { name: "emit", description: "Emit", parameters: { type: "object" } },
            execute: async () => ({ complete: true }),
          },
        ],
        terminalToolName: "emit",
        validateTerminal: (value) => value as { readonly ids: readonly string[] },
        maximumTurns: 2,
        requestedOutputTokens: 128,
        reasoning: "medium",
        coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
      }),
    );

    expect(result.ids).toEqual(["a"]);
    const secondRequest = complete.mock.calls[1]?.[0];
    expect(secondRequest.messages.map((message: { role: string }) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(secondRequest.messages.at(-1).content).toContain('"complete":true');
    expect(secondRequest.messages.at(-1).content).not.toContain("__hartlibSourceExposures");
    expect(secondRequest.messages.at(-1).content).not.toContain("secret");
    expect(secondRequest.sourceExposureProofs).toEqual([
      expect.objectContaining({
        sourceKind: "chat_message",
        logicalSourceIdentity: chatMessageEvidenceIdentity("public-message"),
        contentItemIdentity: `chat_message:public-message:0:7:${createHash("sha256").update("visible", "utf8").digest("hex")}`,
        exposureStage: "evaluation_general_planner_search",
        visibleTokenCount: 1,
        visibleText: "visible",
        immutableContentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        immutableSourceIdentityCommitment: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        immutableSourceCommitment: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        chatReconstruction: {
          messageId: "public-message",
          contentHash: createHash("sha256").update("visible", "utf8").digest("hex"),
          ranges: [{ charStart: 0, charEnd: "visible".length }],
        },
        sourceToolCallId: "call-1",
        sourceResultIndex: 0,
      }),
    ]);
  });

  it("rejects a same-token-count exposure identity rebound to different text", async () => {
    const countTextTokens = resolveRegisteredModel("glm-5-turbo").countTextTokens;
    const snippets = ["one", "two"];
    expect(countTextTokens(snippets[0]!)).toBe(countTextTokens(snippets[1]!));
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "search-1", name: "search_memories", arguments: {} }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "search-2", name: "search_memories", arguments: {} }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "terminal", name: "emit", arguments: { ok: true } }]),
      );
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);
    let searchIndex = 0;

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: {
                name: "search_memories",
                description: "Search",
                parameters: {},
              },
              execute: async () => {
                const snippet = snippets[searchIndex++]!;
                return {
                  complete: true,
                  items: [
                    {
                      memoryId: "same-memory",
                      memoryRevisionId: "same-revision",
                      content: snippet,
                    },
                  ],
                  __hartlibSourceExposures: [
                    {
                      sourceKind: "memory" as const,
                      logicalSourceIdentity: "memory:same-memory",
                      contentItemIdentity: "same-revision",
                      exposureStage: "memory_tool_result",
                      visibleTokenCount: countTextTokens(snippet),
                    },
                  ],
                };
              },
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: 3,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).rejects.toThrow(/internal_retrieval_failed/u);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("binds opaque conversation inspections through the real serialized tool transcript", async () => {
    const entries = {
      opaque_candidate_1: {
        turnId: "turn-1",
        userMessageId: "user-1",
        userContent: "first user text",
        assistantMessageId: "assistant-1",
        assistantContent: "first assistant text",
      },
      opaque_candidate_2: {
        turnId: "turn-2",
        userMessageId: "user-2",
        userContent: "second user text",
        assistantMessageId: "assistant-2",
        assistantContent: "second assistant text",
      },
      opaque_candidate_3: {
        turnId: "turn-3",
        userMessageId: "user-3",
        userContent: "failed user text",
        errorCode: "answer_failed",
        retryable: false,
      },
    } as const;
    const inspectCalls = Object.keys(entries).map((id, index) => ({
      id: `inspect-${index + 1}`,
      name: "inspect_candidate",
      arguments: { id },
    }));
    const complete = vi
      .fn()
      .mockResolvedValueOnce(completion(inspectCalls))
      .mockResolvedValueOnce(
        completion([{ id: "terminal", name: "emit", arguments: { ok: true } }]),
      );
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);
    const countTextTokens = resolveRegisteredModel("glm-5-turbo").countTextTokens;

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: {
                name: "inspect_candidate",
                description: "Inspect",
                parameters: { type: "object" },
              },
              execute: async (arguments_) => {
                const entry = entries[arguments_.id as keyof typeof entries];
                if (entry === undefined) throw new Error("unknown opaque candidate");
                const visibleMessages = [
                  { messageId: entry.userMessageId, content: entry.userContent },
                  ...("assistantMessageId" in entry
                    ? [
                        {
                          messageId: entry.assistantMessageId,
                          content: entry.assistantContent,
                        },
                      ]
                    : []),
                ];
                return {
                  found: true,
                  complete: true,
                  conversationEntry: entry,
                  __hartlibSourceExposures: visibleMessages.map(({ messageId, content }) => ({
                    sourceKind: "chat_message" as const,
                    logicalSourceIdentity: chatMessageEvidenceIdentity(messageId),
                    contentItemIdentity: messageId,
                    exposureStage: "provider_input",
                    visibleTokenCount: countTextTokens(content),
                  })),
                  __hartlibSourceIdentity: visibleMessages.map(({ messageId, content }) => ({
                    messageId,
                    contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
                    ranges: [{ charStart: 0, charEnd: content.length }],
                  })),
                };
              },
            },
            {
              definition: { name: "emit", description: "Emit", parameters: { type: "object" } },
              execute: async () => ({}),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value as { readonly ok: boolean },
          maximumTurns: 2,
          requestedOutputTokens: 128,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "context_source_tool" },
        }),
      ),
    ).resolves.toEqual({ ok: true });

    const serialized = complete.mock.calls[1]?.[0] as LiveProviderRequest;
    expect(
      serialized.messages.flatMap((message) =>
        message.role === "assistant"
          ? (message.toolCalls ?? []).map((call) => call.arguments.id)
          : [],
      ),
    ).toEqual(["opaque_candidate_1", "opaque_candidate_2", "opaque_candidate_3"]);
    expect(JSON.stringify(serialized.messages)).not.toContain("conversation_entry:");
    expect(serialized.sourceExposureProofs).toHaveLength(5);
    expect(providerRequestSourceExposureProofBindings(serialized, countTextTokens)).toHaveLength(5);
    const proofs = serialized.sourceExposureProofs as readonly CodeOwnedSourceExposureProof[];
    for (const field of [
      "immutableContentHash",
      "immutableSourceIdentityCommitment",
      "immutableSourceCommitment",
      "sourceToolCallId",
      "sourceResultIndex",
    ] as const) {
      const { [field]: _removed, ...weakenedProof } = proofs[0]!;
      expect(() =>
        providerRequestSourceExposureProofBindings(
          {
            ...serialized,
            sourceExposureProofs: [weakenedProof, ...proofs.slice(1)],
          },
          countTextTokens,
        ),
      ).toThrow(/code-owned|commitment|coordinate|tool-result/u);
    }
    expect(() =>
      providerRequestSourceExposureProofBindings(
        {
          ...serialized,
          sourceExposureProofs: [
            {
              sourceKind: proofs[0]!.sourceKind,
              logicalSourceIdentity: proofs[0]!.logicalSourceIdentity,
              contentItemIdentity: proofs[0]!.contentItemIdentity,
              exposureStage: proofs[0]!.exposureStage,
              visibleTokenCount: proofs[0]!.visibleTokenCount,
            },
            ...proofs.slice(1),
          ],
        },
        countTextTokens,
      ),
    ).toThrow(/code-owned|commitment/u);

    const toolMessageIndexes = serialized.messages.flatMap((message, index) =>
      message.role === "tool" && message.name === "inspect_candidate" ? [index] : [],
    );
    const toolContents = toolMessageIndexes.map(
      (index) =>
        (
          serialized.messages[index] as Extract<
            (typeof serialized.messages)[number],
            { role: "tool" }
          >
        ).content,
    );
    const withToolContents = (contents: readonly string[]): LiveProviderRequest => ({
      ...serialized,
      messages: serialized.messages.map((message, index) => {
        const toolIndex = toolMessageIndexes.indexOf(index);
        return toolIndex < 0 ? message : { ...message, content: contents[toolIndex]! };
      }),
    });
    const parsedToolResult = (index: number): Record<string, unknown> =>
      JSON.parse(toolContents[index]!) as Record<string, unknown>;
    const withEntryMutation = (
      index: number,
      mutation: Readonly<Record<string, unknown>>,
    ): LiveProviderRequest => {
      const parsed = parsedToolResult(index);
      const entry = parsed.conversationEntry as Readonly<Record<string, unknown>>;
      const contents = [...toolContents];
      contents[index] = JSON.stringify({
        ...parsed,
        conversationEntry: { ...entry, ...mutation },
      });
      return withToolContents(contents);
    };

    const swapped = [...toolContents];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    expect(() =>
      providerRequestSourceExposureProofBindings(withToolContents(swapped), countTextTokens),
    ).toThrow(/sidecar|tool-result|commitment|exact/u);

    const replayed = [...toolContents];
    replayed[1] = replayed[0]!;
    expect(() =>
      providerRequestSourceExposureProofBindings(withToolContents(replayed), countTextTokens),
    ).toThrow(/sidecar|tool-result|commitment|exact/u);

    for (const mutation of [
      { index: 0, value: { turnId: "swapped-turn" } },
      { index: 0, value: { userMessageId: "swapped-user" } },
      { index: 0, value: { userContent: "swapped user content" } },
      { index: 0, value: { assistantMessageId: "swapped-assistant" } },
      { index: 0, value: { assistantContent: "swapped assistant content" } },
      { index: 2, value: { turnId: "replayed-turn" } },
      { index: 2, value: { userMessageId: "replayed-user" } },
      { index: 2, value: { userContent: "replayed user content" } },
      { index: 2, value: { errorCode: "replayed_failure" } },
      { index: 2, value: { retryable: true } },
    ]) {
      expect(() =>
        providerRequestSourceExposureProofBindings(
          withEntryMutation(mutation.index, mutation.value),
          countTextTokens,
        ),
      ).toThrow(/sidecar|tool-result|commitment|exact/u);
    }
  });

  it("lets the owning operation make protocol-error recovery terminal-only", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "search-1", name: "search", arguments: { terms: "solar" } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "emit-1", name: "emit", arguments: { ids: ["document-a"] } }]),
      );
    let recoveryReady = false;
    const search = vi.fn(async () => {
      recoveryReady = true;
      return {
        complete: true,
        protocolError: "search protocol failed",
      };
    });
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "search", description: "Search", parameters: {} },
              execute: search,
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value as { readonly ids: readonly string[] },
          terminalOnlyForTurn: () => recoveryReady,
          enforceTerminalTurn: true,
          maximumTurns: 4,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).resolves.toEqual({ ids: ["document-a"] });
    expect(search).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[1]?.[0]).toMatchObject({
      tools: [{ name: "emit" }],
      toolChoice: "auto",
    });
  });

  it("hides a completed-phase tool while retaining fetch or inspection tools", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "search-1", name: "search", arguments: { terms: "solar" } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "inspect-1", name: "inspect", arguments: { id: "document-a" } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "emit-1", name: "emit", arguments: { ids: ["document-a"] } }]),
      );
    let searchComplete = false;
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "search", description: "Search", parameters: {} },
              execute: async () => {
                searchComplete = true;
                return { complete: true, items: [{ id: "document-a" }] };
              },
            },
            {
              definition: { name: "inspect", description: "Inspect", parameters: {} },
              execute: async () => ({ complete: true, found: true }),
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          disabledToolsForTurn: () => (searchComplete ? ["search"] : []),
          terminalToolName: "emit",
          validateTerminal: (value) => value as { readonly ids: readonly string[] },
          maximumTurns: 4,
          reserveFinalTurnForTerminal: true,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).resolves.toEqual({ ids: ["document-a"] });
    expect(complete.mock.calls[1]?.[0]).toMatchObject({
      tools: [{ name: "inspect" }, { name: "emit" }],
      toolChoice: "auto",
    });
  });

  it("recovers from a stale call to a phase-disabled tool", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "search-1", name: "search", arguments: { terms: "solar" } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "stale-search", name: "search", arguments: { terms: "solar" } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "inspect-1", name: "inspect", arguments: { id: "document-a" } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "emit-1", name: "emit", arguments: { ids: ["document-a"] } }]),
      );
    let searchComplete = false;
    const inspect = vi.fn(async () => ({ complete: true, found: true }));
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "search", description: "Search", parameters: {} },
              execute: async () => {
                searchComplete = true;
                return { complete: true, items: [{ id: "document-a" }] };
              },
            },
            {
              definition: { name: "inspect", description: "Inspect", parameters: {} },
              execute: inspect,
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          disabledToolsForTurn: () => (searchComplete ? ["search"] : []),
          terminalToolName: "emit",
          validateTerminal: (value) => value as { readonly ids: readonly string[] },
          maximumTurns: 4,
          reserveFinalTurnForTerminal: true,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).resolves.toEqual({ ids: ["document-a"] });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[1]?.[0]).toMatchObject({
      tools: [{ name: "inspect" }, { name: "emit" }],
      toolChoice: "auto",
    });
  });

  it("can make the next phase terminal-only before the final configured turn", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "search-1", name: "search", arguments: { terms: "solar" } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "inspect-1", name: "inspect", arguments: { id: "document-a" } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "emit-1", name: "emit", arguments: { ids: ["document-a"] } }]),
      );
    let inspected = false;
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "search", description: "Search", parameters: {} },
              execute: async () => ({ complete: true, items: [{ id: "document-a" }] }),
            },
            {
              definition: { name: "inspect", description: "Inspect", parameters: {} },
              execute: async () => {
                inspected = true;
                return { complete: true, found: true };
              },
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalOnlyForTurn: () => inspected,
          terminalToolName: "emit",
          enforceTerminalTurn: true,
          validateTerminal: (value) => value as { readonly ids: readonly string[] },
          maximumTurns: 4,
          reserveFinalTurnForTerminal: true,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).resolves.toEqual({ ids: ["document-a"] });
    expect(complete.mock.calls[2]?.[0]).toMatchObject({
      tools: [{ name: "emit" }],
      toolChoice: "auto",
    });
  });

  it("returns recoverable terminal validation feedback to the next provider turn", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "emit-1", name: "emit", arguments: { entries: ["unfetched"] } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "fetch-1", name: "fetch", arguments: { url: "https://example.test" } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "emit-2", name: "emit", arguments: { entries: ["fetched"] } }]),
      );
    const fetch = vi.fn(async () => ({ complete: true, fetched: true }));
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "fetch", description: "Fetch", parameters: {} },
              execute: fetch,
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => {
            if ((value as { readonly entries: readonly string[] }).entries[0] === "unfetched") {
              throw new Error("needs fetch");
            }
            return value as { readonly entries: readonly string[] };
          },
          recoverTerminal: (_value, error) =>
            error instanceof Error && error.message === "needs fetch"
              ? { complete: true, terminalRejected: true, message: "fetch first" }
              : undefined,
          maximumTurns: 4,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "web_research" },
        }),
      ),
    ).resolves.toEqual({ entries: ["fetched"] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[1]?.[0].messages.at(-1)?.content).toContain("terminalRejected");
  });

  it("returns recoverable non-terminal tool feedback to the next provider turn", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "fetch-1", name: "fetch", arguments: { url: "bad" } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "fetch-2", name: "fetch", arguments: { url: "good" } }]),
      )
      .mockResolvedValueOnce(completion([{ id: "emit-1", name: "emit", arguments: { ok: true } }]));
    let fetched = false;
    const fetch = vi.fn(async (arguments_: Readonly<Record<string, unknown>>) => {
      if (arguments_.url !== "good") throw new Error("unknown URL");
      fetched = true;
      return { complete: true };
    });
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "fetch", description: "Fetch", parameters: {} },
              execute: fetch,
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalOnlyForTurn: () => fetched,
          terminalToolName: "emit",
          enforceTerminalTurn: true,
          validateTerminal: (value) => value as { readonly ok: true },
          recoverToolError: (toolName, _arguments, error) =>
            toolName === "fetch" && error instanceof Error && error.message === "unknown URL"
              ? { complete: true, toolRejected: true, message: "use an exact discovered URL" }
              : undefined,
          maximumTurns: 4,
          reserveFinalTurnForTerminal: true,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "web_research" },
        }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[0].messages.at(-1)?.content).toContain("toolRejected");
  });

  it("recovers when a provider emits the terminal tool before its reserved turn", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(completion([{ id: "emit-1", name: "emit", arguments: { ok: true } }]))
      .mockResolvedValueOnce(completion([{ id: "emit-2", name: "emit", arguments: { ok: true } }]));
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          enforceTerminalTurn: true,
          validateTerminal: (value) => value,
          recoverTerminal: (_value, error) => ({
            complete: false,
            terminalRejected: true,
            message: error instanceof Error ? error.message : "terminal rejected",
          }),
          maximumTurns: 2,
          reserveFinalTurnForTerminal: true,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "context_source_tool" },
        }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(complete.mock.calls[1]?.[0].messages.at(-1)?.content).toContain(
      "reserved terminal turn",
    );
  });

  it("rejects a terminal turn that contains a stale disabled call", async () => {
    const complete = vi.fn(async () =>
      completion([
        { id: "emit-1", name: "emit", arguments: { ok: true } },
        { id: "stale-1", name: "inspect", arguments: { id: "candidate" } },
      ]),
    );
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "inspect", description: "Inspect", parameters: {} },
              execute: async () => ({ complete: true }),
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          disabledToolsForTurn: () => ["inspect"],
          terminalOnlyForTurn: () => true,
          terminalToolName: "emit",
          enforceTerminalTurn: true,
          validateTerminal: (value) => value,
          maximumTurns: 1,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "context_source_tool" },
        }),
      ),
    ).rejects.toMatchObject({ code: "context_compaction_failed" });
  });

  it("preflights malformed sibling arguments before executing any tool", async () => {
    const complete = vi.fn(async () =>
      completion([
        { id: "first-1", name: "first", arguments: {} },
        {
          id: "second-1",
          name: "second",
          arguments: null as unknown as Readonly<Record<string, unknown>>,
        },
      ]),
    );
    const first = vi.fn(async () => ({ complete: true }));
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "first", description: "First", parameters: {} },
              execute: first,
            },
            {
              definition: { name: "second", description: "Second", parameters: {} },
              parseArguments: () => {
                throw new Error("malformed second arguments");
              },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: 12,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "context_source_tool" },
        }),
      ),
    ).rejects.toMatchObject({ code: "context_compaction_failed" });
    expect(first).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("recovers an opted-in malformed sibling array without executing any sibling", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([
          { id: "first-1", name: "first", arguments: {} },
          {
            id: "first-1",
            name: "second",
            arguments: null as unknown as Readonly<Record<string, unknown>>,
          },
        ]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "terminal-1", name: "emit", arguments: { ok: true } }]),
      );
    const first = vi.fn(async () => ({ complete: true }));
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "first", description: "First", parameters: {} },
              execute: first,
            },
            {
              definition: { name: "second", description: "Second", parameters: {} },
              parseArguments: () => {
                throw new Error("malformed second arguments");
              },
              execute: async () => ({ complete: true }),
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          recoverMalformedToolCallArray: (toolNames) => ({ rejectedTools: toolNames }),
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: 3,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "context_source_tool" },
        }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(first).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(2);
    const calls = (
      complete as unknown as { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }
    ).mock.calls;
    const retryRequest = calls[1]?.[0] as
      | {
          readonly messages?: readonly {
            readonly role?: string;
            readonly toolCalls?: readonly {
              readonly id?: string;
              readonly arguments?: unknown;
            }[];
          }[];
        }
      | undefined;
    const rejectedAssistant = retryRequest?.messages?.find(
      (message) => message.role === "assistant",
    );
    expect(rejectedAssistant?.toolCalls?.[1]?.arguments).toEqual({});
    expect(rejectedAssistant?.toolCalls?.map((call) => call.id)).toEqual([
      "first-1",
      "hartlib_rejected_1_0_1",
    ]);
  });

  it("recovers a strict non-terminal argument failure without executing the call", async () => {
    const execute = vi.fn(async () => ({ complete: true }));
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "search-1", name: "search", arguments: { stale: true } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "terminal-1", name: "emit", arguments: { ok: true } }]),
      );
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "search", description: "Search", parameters: {} },
              parseArguments: () => {
                throw new Error("stale argument");
              },
              execute,
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: 2,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[0].messages).toContainEqual({
      role: "tool",
      toolCallId: "search-1",
      name: "search",
      content:
        '{"complete":true,"protocolError":"tool arguments did not match the advertised schema"}',
    });
  });

  it("preserves a pending cursor obligation across malformed continuation recovery", async () => {
    let searchExecutions = 0;
    const execute = vi.fn(async () => {
      searchExecutions += 1;
      return searchExecutions === 1
        ? { items: [], complete: false, cursor: 1 }
        : { items: [], complete: true, cursor: null };
    });
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "search-1", name: "search", arguments: { query: "grid" } }]),
      )
      .mockResolvedValueOnce(
        completion([
          { id: "search-malformed", name: "search", arguments: { query: "grid", cursor: "1" } },
        ]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "search-2", name: "search", arguments: { query: "grid", cursor: 1 } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "terminal-1", name: "emit", arguments: { ok: true } }]),
      );
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "search", description: "Search", parameters: {} },
              parseArguments: (value) => {
                if (value === null || typeof value !== "object" || Array.isArray(value)) {
                  throw new Error("search arguments must be an object");
                }
                const arguments_ = value as Readonly<Record<string, unknown>>;
                if (
                  typeof arguments_.query !== "string" ||
                  (arguments_.cursor !== undefined && typeof arguments_.cursor !== "number")
                ) {
                  throw new Error("search arguments failed schema");
                }
                return arguments_;
              },
              execute,
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          enforceTerminalTurn: true,
          maximumTurns: 4,
          requestedOutputTokens: 64,
          reserveFinalTurnForTerminal: true,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[2]?.[0].tools ?? []).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "search" })]),
    );
  });

  it("strictly parses stale disabled siblings before executing visible calls", async () => {
    const complete = vi.fn(async () =>
      completion([
        { id: "first-1", name: "first", arguments: {} },
        { id: "disabled-1", name: "disabled", arguments: { forged: true } },
      ]),
    );
    const first = vi.fn(async () => ({ complete: true }));
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "main",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "first", description: "First", parameters: {} },
              execute: first,
            },
            {
              definition: { name: "disabled", description: "Disabled", parameters: {} },
              parseArguments: (value) => {
                if (
                  value === null ||
                  typeof value !== "object" ||
                  Array.isArray(value) ||
                  Object.keys(value).length !== 0
                ) {
                  throw new Error("disabled arguments are malformed");
                }
                return value as Readonly<Record<string, unknown>>;
              },
              execute: async () => ({ complete: true }),
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          disabledToolsForTurn: () => ["disabled"],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: 1,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).rejects.toMatchObject({ code: "internal_retrieval_failed" });
    expect(first).not.toHaveBeenCalled();
  });

  it("rejects duplicate sibling tool-call IDs before executing any tool", async () => {
    const complete = vi.fn(async () =>
      completion([
        { id: "duplicate", name: "first", arguments: {} },
        { id: "duplicate", name: "second", arguments: {} },
      ]),
    );
    const first = vi.fn(async () => ({ complete: true }));
    const second = vi.fn(async () => ({ complete: true }));
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "main",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "first", description: "First", parameters: {} },
              execute: first,
            },
            {
              definition: { name: "second", description: "Second", parameters: {} },
              execute: second,
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: 1,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).rejects.toMatchObject({ code: "internal_retrieval_failed" });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("does not consume a continuation obligation created earlier in the same response", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([
          { id: "search-1", name: "search", arguments: { query: "solar" } },
          { id: "search-same-turn", name: "search", arguments: { query: "solar", cursor: 2 } },
        ]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "search-2", name: "search", arguments: { query: "solar", cursor: 2 } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "emit-1", name: "emit", arguments: { ids: ["a"] } }]),
      );
    const search = vi
      .fn()
      .mockResolvedValueOnce({ complete: false, truncated: true, cursor: 2, items: [{ id: "a" }] })
      .mockResolvedValueOnce({ complete: true, truncated: false, cursor: null, items: [] });
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "search", description: "Search", parameters: {} },
              execute: search,
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value as { readonly ids: readonly string[] },
          maximumTurns: 3,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).resolves.toEqual({ ids: ["a"] });
    expect(search).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[0].messages.at(-1)?.content).toContain(
      '"continuationRequired":true',
    );
  });

  it("recovers when terminal persistence rejects an otherwise valid output", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(completion([{ id: "emit-1", name: "emit", arguments: { ok: true } }]))
      .mockResolvedValueOnce(completion([{ id: "emit-2", name: "emit", arguments: { ok: true } }]));
    const onTerminal = vi.fn().mockRejectedValueOnce(new Error("terminal requires a later phase"));
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          recoverTerminal: (_value, error) =>
            error instanceof Error && error.message === "terminal requires a later phase"
              ? { complete: false, terminalRejected: true }
              : undefined,
          onTerminal,
          maximumTurns: 2,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "web_research" },
        }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(onTerminal).toHaveBeenCalledTimes(2);
  });

  it("reserves a clear final turn for provider-authored terminal output", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "search-1", name: "search", arguments: { terms: "solaire" } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "search-2", name: "search", arguments: { terms: "solar" } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "inspect-1", name: "inspect", arguments: { id: "document-a" } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "emit-1", name: "emit", arguments: { ids: ["document-a"] } }]),
      );
    const search = vi
      .fn()
      .mockResolvedValueOnce({ complete: true, items: [] })
      .mockResolvedValueOnce({ complete: true, items: [{ id: "document-a" }] });
    const inspect = vi.fn(async () => ({ complete: true, found: true }));
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "search", description: "Search", parameters: {} },
              execute: search,
            },
            {
              definition: { name: "inspect", description: "Inspect", parameters: {} },
              execute: inspect,
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value as { readonly ids: readonly string[] },
          maximumTurns: 4,
          reserveFinalTurnForTerminal: true,
          requestedOutputTokens: 128,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).resolves.toEqual({ ids: ["document-a"] });
    expect(search).toHaveBeenCalledTimes(2);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[3]?.[0]).toMatchObject({
      tools: [{ name: "emit" }],
      toolChoice: "auto",
    });
  });

  it("rejects terminal output while a cursor-bearing result remains incomplete", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "search-1", name: "search", arguments: { query: "solar" } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "emit-1", name: "emit", arguments: { ids: ["a"] } }]),
      );
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "search", description: "Search", parameters: {} },
              execute: async () => ({
                complete: false,
                truncated: true,
                cursor: 2,
                items: [{ id: "a" }],
              }),
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: 2,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).rejects.toMatchObject({ code: "internal_retrieval_failed", retryable: true });
  });

  it("blocks unrelated tools until every incomplete result is continued", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "search-1", name: "search", arguments: { query: "solar" } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "search-2", name: "search", arguments: { query: "wind" } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "search-3", name: "search", arguments: { query: "solar", cursor: 2 } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "emit-1", name: "emit", arguments: { ids: ["a", "b"] } }]),
      );
    const search = vi.fn(async (arguments_: Readonly<Record<string, unknown>>) =>
      arguments_.cursor === 2
        ? { complete: true, truncated: false, cursor: null, items: [{ id: "b" }] }
        : { complete: false, truncated: true, cursor: 2, items: [{ id: "a" }] },
    );
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "search", description: "Search", parameters: {} },
              execute: search,
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: 4,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).resolves.toEqual({ ids: ["a", "b"] });
    expect(search).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[2]?.[0].messages.at(-1)?.content).toContain(
      '"continuationRequired":true',
    );
  });

  it("accepts terminal output only after the exact returned cursor reaches completion", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "search-1", name: "search", arguments: { query: "solar" } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "search-2", name: "search", arguments: { query: "solar", cursor: 2 } }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "emit-1", name: "emit", arguments: { ids: ["a", "b"] } }]),
      );
    const search = vi.fn(async (arguments_: Readonly<Record<string, unknown>>) =>
      arguments_.cursor === 2
        ? { complete: true, truncated: false, cursor: null, items: [{ id: "b" }] }
        : { complete: false, truncated: true, cursor: 2, items: [{ id: "a" }] },
    );
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "search", description: "Search", parameters: {} },
              execute: search,
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value as { readonly ids: readonly string[] },
          maximumTurns: 3,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).resolves.toEqual({ ids: ["a", "b"] });
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("rejects a skipped cursor and an incomplete result without a continuation", async () => {
    const run = async (secondCursor: number | null) => {
      const complete = vi
        .fn()
        .mockResolvedValueOnce(
          completion([{ id: "search-1", name: "search", arguments: { query: "solar" } }]),
        )
        .mockResolvedValueOnce(
          completion(
            secondCursor === null
              ? []
              : [
                  {
                    id: "search-2",
                    name: "search",
                    arguments: { query: "solar", cursor: secondCursor },
                  },
                ],
          ),
        );
      const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);
      return inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "search", description: "Search", parameters: {} },
              execute: async () =>
                secondCursor === null
                  ? { complete: false, truncated: true, cursor: null, cursorSupported: false }
                  : { complete: false, truncated: true, cursor: 2, items: [] },
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: 2,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      );
    };

    await expect(run(99)).rejects.toMatchObject({ code: "internal_retrieval_failed" });
    await expect(run(null)).rejects.toMatchObject({ code: "internal_retrieval_failed" });
  });

  it("requires a requested oversized inspection range to become strictly narrower", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([
          { id: "inspect-1", name: "inspect", arguments: { id: "doc", range: [0, 100] } },
        ]),
      )
      .mockResolvedValueOnce(
        completion([
          { id: "inspect-2", name: "inspect", arguments: { id: "doc", range: [0, 10] } },
        ]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "emit-1", name: "emit", arguments: { ids: ["doc"] } }]),
      );
    const inspect = vi.fn(async (arguments_: Readonly<Record<string, unknown>>) =>
      JSON.stringify(arguments_.range) === JSON.stringify([0, 10])
        ? { complete: true, found: true, text: "bounded" }
        : { complete: false, found: true, narrowerRangeRequired: true },
    );
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "inspect", description: "Inspect", parameters: {} },
              execute: inspect,
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: 3,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "context_source_tool" },
        }),
      ),
    ).resolves.toEqual({ ids: ["doc"] });
  });

  it("accepts a production inspect continuation with an implicit full range", async () => {
    const reference = {
      kind: "document",
      documentId: "doc",
      snapshotId: "version",
      source: { kind: "public", sourceId: "public:source" },
      purpose: "inspect",
    } as const;
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "inspect-1", name: "inspect", arguments: { reference } }]),
      )
      .mockResolvedValueOnce(
        completion([
          {
            id: "inspect-2",
            name: "inspect",
            arguments: {
              reference: { ...reference, ranges: [{ charStart: 0, charEnd: 10 }] },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "emit-1", name: "emit", arguments: { ids: ["doc"] } }]),
      );
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({
        complete: false,
        found: true,
        narrowerRangeRequired: true,
        textCharCount: 100,
      })
      .mockResolvedValueOnce({ complete: true, found: true });
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "inspect", description: "Inspect", parameters: {} },
              execute: inspect,
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: 3,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).resolves.toEqual({ ids: ["doc"] });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("accepts a production inspect_candidate continuation from its returned scope", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "inspect-1", name: "inspect", arguments: { id: "candidate" } }]),
      )
      .mockResolvedValueOnce(
        completion([
          {
            id: "inspect-2",
            name: "inspect",
            arguments: { id: "candidate", range: { charStart: 0, charEnd: 10 } },
          },
        ]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "emit-1", name: "emit", arguments: { ids: ["candidate"] } }]),
      );
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({
        complete: false,
        found: true,
        narrowerRangeRequired: true,
        ranges: [{ charStart: 0, charEnd: 100 }],
      })
      .mockResolvedValueOnce({ complete: true, found: true });
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "inspect", description: "Inspect", parameters: {} },
              execute: inspect,
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: 3,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "context_source_tool" },
        }),
      ),
    ).resolves.toEqual({ ids: ["candidate"] });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("handles two-range production scopes without widening the continuation", async () => {
    const reference = {
      kind: "document",
      documentId: "doc",
      snapshotId: "version",
      source: { kind: "public", sourceId: "public:source" },
      purpose: "inspect",
      ranges: [
        { charStart: 0, charEnd: 20 },
        { charStart: 40, charEnd: 60 },
      ],
    } as const;
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "inspect-1", name: "inspect", arguments: { reference } }]),
      )
      .mockResolvedValueOnce(
        completion([
          {
            id: "inspect-2",
            name: "inspect",
            arguments: {
              reference: {
                ...reference,
                ranges: [
                  { charStart: 0, charEnd: 10 },
                  { charStart: 40, charEnd: 50 },
                ],
              },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "emit-1", name: "emit", arguments: { ids: ["doc"] } }]),
      );
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ complete: false, found: true, narrowerRangeRequired: true })
      .mockResolvedValueOnce({ complete: true, found: true });
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "inspect", description: "Inspect", parameters: {} },
              execute: inspect,
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: 3,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).resolves.toEqual({ ids: ["doc"] });
  });

  it("rejects a disjoint two-range production continuation", async () => {
    const reference = {
      kind: "document",
      documentId: "doc",
      snapshotId: "version",
      source: { kind: "public", sourceId: "public:source" },
      purpose: "inspect",
      ranges: [
        { charStart: 0, charEnd: 20 },
        { charStart: 40, charEnd: 60 },
      ],
    } as const;
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "inspect-1", name: "inspect", arguments: { reference } }]),
      )
      .mockResolvedValueOnce(
        completion([
          {
            id: "inspect-2",
            name: "inspect",
            arguments: {
              reference: {
                ...reference,
                ranges: [
                  { charStart: 0, charEnd: 10 },
                  { charStart: 80, charEnd: 90 },
                ],
              },
            },
          },
        ]),
      );
    const inspect = vi.fn(async () => ({
      complete: false,
      found: true,
      narrowerRangeRequired: true as const,
    }));
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "inspect", description: "Inspect", parameters: {} },
              execute: inspect,
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: 2,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).rejects.toMatchObject({ code: "internal_retrieval_failed" });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["shifted equal-width", { charStart: 10, charEnd: 110 }],
    ["expanded", { charStart: 0, charEnd: 120 }],
    ["disjoint", { charStart: 110, charEnd: 120 }],
  ] as const)("rejects a %s continuation range", async (_label, invalidRange) => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([
          {
            id: "inspect-1",
            name: "inspect",
            arguments: { id: "doc", range: { charStart: 0, charEnd: 100 } },
          },
        ]),
      )
      .mockResolvedValueOnce(
        completion([
          { id: "inspect-2", name: "inspect", arguments: { id: "doc", range: invalidRange } },
        ]),
      );
    const inspect = vi.fn(async () => ({
      complete: false,
      found: true,
      narrowerRangeRequired: true as const,
    }));
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);

    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "inspect", description: "Inspect", parameters: {} },
              execute: inspect,
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: 2,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "context_source_tool" },
        }),
      ),
    ).rejects.toMatchObject({ code: "context_compaction_failed" });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("fails visibly when a bounded loop never emits its terminal output", async () => {
    const complete = vi
      .fn()
      .mockResolvedValue(
        completion([{ id: "call", name: "search", arguments: { terms: "none" } }]),
      );
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);
    await expect(
      inTask(() =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "search", description: "Search", parameters: {} },
              execute: async () => ({ complete: true, items: [] }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: 2,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).rejects.toMatchObject({ code: "internal_retrieval_failed" });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("uses Smithers iteration and attempt while provider request index tracks tool turns", async () => {
    const boundaryCoordinates: unknown[] = [];
    const toolCoordinates: unknown[] = [];
    const complete = vi.fn(async (_request, coordinates) => {
      boundaryCoordinates.push(coordinates);
      return boundaryCoordinates.length === 1
        ? completion([{ id: "call-1", name: "search", arguments: { terms: "solar" } }])
        : completion([{ id: "call-2", name: "emit", arguments: { ids: ["a"] } }]);
    });
    const client = new CanonicalAgentClient({ complete } as unknown as ExactPiBoundary);
    const controller = new AbortController();

    await withTaskRuntime(
      {
        runId: "run",
        stepId: "a",
        attempt: 3,
        iteration: 4,
        signal: controller.signal,
        db: {},
        heartbeat: () => undefined,
        lastHeartbeat: null,
      },
      () =>
        client.toolLoop({
          requestClass: "fast",
          model: "glm-5-turbo",
          system: "system",
          user: "user",
          tools: [
            {
              definition: { name: "search", description: "Search", parameters: {} },
              execute: async (_arguments, coordinates) => {
                toolCoordinates.push(coordinates);
                return { complete: true, items: [] };
              },
            },
            {
              definition: { name: "emit", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit",
          validateTerminal: (value) => value,
          maximumTurns: 2,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
    );

    expect(boundaryCoordinates).toEqual([
      {
        taskId: "a",
        attempt: 3,
        agentRole: "internal_retrieval",
        loopIteration: 4,
        providerRequestIndex: 0,
      },
      {
        taskId: "a",
        attempt: 3,
        agentRole: "internal_retrieval",
        loopIteration: 4,
        providerRequestIndex: 1,
      },
    ]);
    expect(toolCoordinates).toEqual([boundaryCoordinates[0]]);
  });

  it("awaits one terminal callback with the actual terminal provider request", async () => {
    const terminal = completion([{ id: "terminal", name: "emit", arguments: { ids: ["a"] } }]);
    const client = new CanonicalAgentClient({
      complete: vi.fn(async () => terminal),
    } as unknown as ExactPiBoundary);
    const seen: unknown[] = [];

    const result = await inTask(() =>
      client.toolLoop({
        requestClass: "fast",
        model: "glm-5-turbo",
        system: "system",
        user: "user",
        tools: [
          {
            definition: { name: "emit", description: "Emit", parameters: {} },
            execute: async () => ({ complete: true }),
          },
        ],
        terminalToolName: "emit",
        validateTerminal: (value) => value as { readonly ids: readonly string[] },
        onTerminal: async (output, coordinates, actualCompletion) => {
          await Promise.resolve();
          seen.push({ output, coordinates, actualCompletion });
        },
        maximumTurns: 1,
        requestedOutputTokens: 64,
        reasoning: "medium",
        coordinates: { taskId: "a", attempt: 0, agentRole: "direct_answer" },
      }),
    );

    expect(result).toEqual({ ids: ["a"] });
    expect(seen).toEqual([
      {
        output: { ids: ["a"] },
        coordinates: {
          taskId: "a",
          attempt: 1,
          agentRole: "direct_answer",
          loopIteration: 0,
          providerRequestIndex: 0,
        },
        actualCompletion: terminal,
      },
    ]);
  });
});
