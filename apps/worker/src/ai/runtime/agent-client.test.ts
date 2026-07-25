import type { AssistantMessage } from "@earendil-works/pi-ai";
import * as SmithersTaskRuntimeModule from "@smithers-orchestrator/driver/task-runtime";
import { describe, expect, it, vi } from "vitest";

import { CanonicalAgentClient } from "./agent-client";
import { AiRuntimeError } from "./errors";
import { ExactPiBoundary, type PiCompletion } from "./pi-boundary";

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
const piToolCompletion = (toolCalls: PiCompletion["toolCalls"]): AssistantMessage => ({
  role: "assistant",
  content: toolCalls.map((call) => ({
    type: "toolCall",
    id: call.id,
    name: call.name,
    arguments: call.arguments,
  })),
  api: "openai-completions",
  provider: "zai",
  model: "glm-5-turbo",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  timestamp: 0,
});
const exactBoundaryOptions = {
  apiKey: "test",
  baseUrl: "https://example.invalid/v4",
  fastLimits: { inputTokens: 100_000, outputTokens: 16_384 },
  mainLimits: { inputTokens: 100_000, outputTokens: 16_384 },
  fastTimeoutMs: 30_000,
  answerTimeoutMs: 120_000,
};
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

  it("never logs internal search or inspection result bodies", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([{ id: "search-1", name: "search_internal", arguments: {} }]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "inspect-1", name: "inspect_internal", arguments: {} }]),
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
                  name: "search_internal",
                  description: "Search",
                  parameters: {},
                },
                execute: async () => ({
                  items: [{ messageId: "restricted-message", snippet: "restricted search text" }],
                  complete: true,
                }),
              },
              {
                definition: {
                  name: "inspect_internal",
                  description: "Inspect",
                  parameters: {},
                },
                execute: async () => ({
                  found: true,
                  complete: true,
                  message: {
                    messageId: "restricted-message",
                    content: "restricted inspected text",
                  },
                }),
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
          agentRole: "execution_planner",
        },
      }),
    ).then(
      () => {
        throw new Error("expected structured output failure");
      },
      (error) => error,
    );
    expect(failure).toMatchObject({ code: "execution_planner_failed", retryable: true });
    expect(failure).not.toMatchObject({ details: { failureRetryable: false } });
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
          agentRole: "execution_planner",
        },
      }),
    ).then(
      () => {
        throw new Error("expected schema validation failure");
      },
      (error) => error,
    );
    expect(failure).toMatchObject({ code: "execution_planner_failed", retryable: true });
    expect(failure).not.toMatchObject({ details: { failureRetryable: false } });
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
            agentRole: "execution_planner",
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
        completion([{ id: "call-1", name: "search", arguments: { terms: "solar" } }]),
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
              name: "search",
              description: "Search",
              parameters: { type: "object" },
            },
            execute: async () => ({ complete: true, items: [{ id: "a" }] }),
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
          coordinates: { taskId: "a", attempt: 0, agentRole: "context_reducer" },
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
          coordinates: { taskId: "a", attempt: 0, agentRole: "context_reducer" },
        }),
      ),
    ).rejects.toMatchObject({ code: "context_reducer_failed" });
  });

  it("requires reducer measurement to occupy its own provider turn", async () => {
    const complete = vi.fn(async () =>
      completion([
        { id: "measure-1", name: "measure_plan", arguments: {} },
        { id: "inspect-1", name: "inspect", arguments: {} },
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
              definition: { name: "measure_plan", description: "Measure", parameters: {} },
              execute: async () => ({ complete: true, resolved: true }),
            },
            {
              definition: { name: "inspect", description: "Inspect", parameters: {} },
              execute: async () => ({ complete: true }),
            },
            {
              definition: { name: "emit_context_plan", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit_context_plan",
          exclusiveToolNames: ["measure_plan", "emit_context_plan"],
          validateTerminal: (value) => value,
          maximumTurns: 2,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "context_reducer" },
        }),
      ),
    ).rejects.toMatchObject({ code: "context_reducer_failed" });
  });

  it("preflights every complete call array before executing an exclusive measurement", async () => {
    const complete = vi.fn(async () =>
      completion([
        { id: "measure-1", name: "measure_plan", arguments: {} },
        { id: "measure-2", name: "measure_plan", arguments: {} },
      ]),
    );
    const measure = vi.fn(async () => ({ complete: true, resolved: true }));
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
              definition: { name: "measure_plan", description: "Measure", parameters: {} },
              execute: measure,
            },
            {
              definition: { name: "emit_context_plan", description: "Emit", parameters: {} },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalToolName: "emit_context_plan",
          exclusiveToolNames: ["measure_plan", "emit_context_plan"],
          validateTerminal: (value) => value,
          maximumTurns: 2,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "context_reducer" },
        }),
      ),
    ).rejects.toMatchObject({ code: "context_reducer_failed" });
    expect(measure).not.toHaveBeenCalled();
  });

  it("recovers an opted-in reducer phase conflict without executing mixed calls", async () => {
    let turn = 0;
    let measured = false;
    const complete = vi.fn(async () => {
      const result =
        turn === 0
          ? completion([
              { id: "inspect-mixed", name: "inspect", arguments: {} },
              { id: "measure-mixed", name: "measure_plan", arguments: {} },
            ])
          : turn === 1
            ? completion([{ id: "measure-only", name: "measure_plan", arguments: {} }])
            : completion([{ id: "terminal", name: "emit_context_plan", arguments: {} }]);
      turn += 1;
      return result;
    });
    const inspect = vi.fn(async () => ({ complete: true }));
    const measure = vi.fn(async () => {
      measured = true;
      return { complete: true, resolved: true };
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
              definition: { name: "measure_plan", description: "Measure", parameters: {} },
              execute: measure,
            },
            {
              definition: { name: "inspect", description: "Inspect", parameters: {} },
              execute: inspect,
            },
            {
              definition: {
                name: "emit_context_plan",
                description: "Emit",
                parameters: {},
              },
              execute: async () => ({ complete: true }),
            },
          ],
          terminalOnlyForTurn: () => measured,
          terminalToolName: "emit_context_plan",
          exclusiveToolNames: ["measure_plan", "emit_context_plan"],
          recoverConflictingToolCalls: (toolNames) => ({ rejectedTools: toolNames }),
          validateTerminal: (value) => value,
          maximumTurns: 4,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "context_reducer" },
        }),
      ),
    ).resolves.toEqual({});
    expect(inspect).not.toHaveBeenCalled();
    expect(measure).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(3);
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
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).rejects.toMatchObject({ code: "internal_retrieval_failed" });
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
          coordinates: { taskId: "a", attempt: 0, agentRole: "context_reducer" },
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
      "brief_rejected_1_0_1",
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

  it.each(["search_internal", "search_within_candidate"] as const)(
    "keeps malformed %s recovery admissible at the exact Pi boundary",
    async (toolName) => {
      const execute = vi.fn(async () => ({ complete: true }));
      const complete = vi
        .fn()
        .mockResolvedValueOnce(
          piToolCompletion([{ id: "malformed-1", name: toolName, arguments: { stale: true } }]),
        )
        .mockResolvedValueOnce(
          piToolCompletion([{ id: "terminal-1", name: "emit_terminal", arguments: { ok: true } }]),
        );
      const boundary = new ExactPiBoundary({
        ...exactBoundaryOptions,
        complete: complete as never,
      });
      const client = new CanonicalAgentClient(boundary);

      await expect(
        inTask(() =>
          client.toolLoop({
            requestClass: "fast",
            model: "glm-5-turbo",
            system: "system",
            user: "user",
            tools: [
              {
                definition: { name: toolName, description: "Search", parameters: {} },
                parseArguments: () => {
                  throw new Error("stale argument");
                },
                execute,
              },
              {
                definition: {
                  name: "emit_terminal",
                  description: "Emit",
                  parameters: {},
                },
                execute: async () => ({ complete: true }),
              },
            ],
            terminalToolName: "emit_terminal",
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
    },
  );

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

  it("suppresses every later non-disabled sibling after an incomplete result", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completion([
          {
            id: "search-1",
            name: "search_within_candidate",
            arguments: { query: "solar" },
          },
          {
            id: "search-sibling",
            name: "search_within_candidate",
            arguments: { query: "storage" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        completion([
          {
            id: "search-2",
            name: "search_within_candidate",
            arguments: { query: "solar", cursor: 2 },
          },
        ]),
      )
      .mockResolvedValueOnce(
        completion([{ id: "emit-1", name: "emit", arguments: { ids: ["document-a"] } }]),
      );
    const search = vi
      .fn()
      .mockResolvedValueOnce({ complete: false, truncated: true, cursor: 2, items: [{ id: "a" }] })
      .mockResolvedValueOnce({ complete: true, truncated: false, cursor: null, items: [] });
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
              definition: {
                name: "search_within_candidate",
                description: "Search",
                parameters: {},
              },
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
          maximumTurns: 3,
          requestedOutputTokens: 64,
          reasoning: "medium",
          coordinates: { taskId: "a", attempt: 0, agentRole: "internal_retrieval" },
        }),
      ),
    ).resolves.toEqual({ ids: ["document-a"] });
    expect(search).toHaveBeenCalledTimes(2);
    expect(inspect).not.toHaveBeenCalled();
    expect(complete.mock.calls[1]?.[0].messages.at(-1)?.content).toContain(
      '"continuationRequired":true',
    );
    expect(complete.mock.calls[1]?.[0].messages.at(-1)?.content).toContain('"matchPreviews":[]');
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
          coordinates: { taskId: "a", attempt: 0, agentRole: "context_reducer" },
        }),
      ),
    ).resolves.toEqual({ ids: ["doc"] });
  });

  it("accepts a production inspect_internal continuation with an implicit full range", async () => {
    const reference = {
      kind: "document",
      documentId: "doc",
      documentVersionId: "version",
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
          coordinates: { taskId: "a", attempt: 0, agentRole: "context_reducer" },
        }),
      ),
    ).resolves.toEqual({ ids: ["candidate"] });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("handles two-range production scopes without widening the continuation", async () => {
    const reference = {
      kind: "document",
      documentId: "doc",
      documentVersionId: "version",
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
      documentVersionId: "version",
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
          coordinates: { taskId: "a", attempt: 0, agentRole: "context_reducer" },
        }),
      ),
    ).rejects.toMatchObject({ code: "context_reducer_failed" });
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
        coordinates: { taskId: "a", attempt: 0, agentRole: "context_reducer" },
      }),
    );

    expect(result).toEqual({ ids: ["a"] });
    expect(seen).toEqual([
      {
        output: { ids: ["a"] },
        coordinates: {
          taskId: "a",
          attempt: 1,
          agentRole: "context_reducer",
          loopIteration: 0,
          providerRequestIndex: 0,
        },
        actualCompletion: terminal,
      },
    ]);
  });
});
