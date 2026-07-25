import type { AssistantMessage } from "@earendil-works/pi-ai";
import * as SmithersTaskRuntimeModule from "@smithers-orchestrator/driver/task-runtime";
import { describe, expect, it, vi } from "vitest";

import { ExactPiBoundary } from "./pi-boundary";
import { ProviderSemaphore } from "./provider-semaphore";
import { namespacedDocumentEvidenceIdentity, sha256Base64Url } from "./canonicalization";
import {
  normalizeProviderRequest,
  providerRequestSha256Hex,
  providerVisibleSourceExposureProofSha256Hex,
  stableJson,
  type LiveProviderRequest,
  type ProviderVisibleSourceExposureMarker,
} from "./provider-request";
import { resolveRegisteredModel } from "./model-registry";

const assistant = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "zai",
  model: "glm-5-turbo",
  usage: {
    input: 12,
    output: 3,
    cacheRead: 2,
    cacheWrite: 0,
    reasoning: 1,
    totalTokens: 17,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
});

const request: LiveProviderRequest = {
  requestClass: "fast",
  model: "glm-5-turbo",
  messages: [
    { role: "system", content: "System" },
    { role: "user", content: "Question" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "search", arguments: { terms: "solar" } }],
    },
    { role: "tool", toolCallId: "call-1", name: "search", content: '{"complete":true}' },
  ],
  tools: [
    {
      name: "search",
      description: "Search",
      parameters: { type: "object", properties: { terms: { type: "string" } } },
    },
  ],
  requestedOutputTokens: 64,
  reasoning: "medium",
};
const coordinates = {
  taskId: "test",
  loopIteration: 1,
  attempt: 2,
  providerRequestIndex: 3,
  agentRole: "test_role",
} as const;

type Runtime = {
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly iteration: number;
  readonly signal: AbortSignal;
  readonly db: Readonly<Record<string, unknown>>;
  readonly heartbeat: (data?: unknown) => void;
  readonly lastHeartbeat: unknown | null;
};

const withTaskRuntime = (
  SmithersTaskRuntimeModule as unknown as {
    readonly withTaskRuntime: <Value>(runtime: Runtime, execute: () => Value) => Value;
  }
).withTaskRuntime;

const inTask = <Value>(
  controller: AbortController,
  attempt: number,
  execute: () => Value,
  iteration = 0,
): Value =>
  withTaskRuntime(
    {
      runId: "run",
      stepId: coordinates.taskId,
      attempt,
      iteration,
      signal: controller.signal,
      db: {},
      heartbeat: () => undefined,
      lastHeartbeat: null,
    },
    execute,
  );

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const boundaryOptions = () => ({
  apiKey: "test",
  baseUrl: "https://example.invalid/v4",
  fastLimits: { inputTokens: 100_000, outputTokens: 16_384 },
  mainLimits: { inputTokens: 100_000, outputTokens: 16_384 },
  fastTimeoutMs: 30_000,
  answerTimeoutMs: 120_000,
});

describe("exact Pi boundary", () => {
  it("requires the accepted provider profile before measurement or transport", async () => {
    const complete = vi.fn(async () => assistant("must not run"));
    const onMeasurement = vi.fn();
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      providerServiceId: "zai_coding_plan_official",
      fastModelId: "glm-5-turbo",
      mainModelId: "glm-5-turbo",
      requireAcceptedProviderProfile: true,
      complete: complete as never,
      hooks: { onMeasurement },
    });

    await expect(
      inTask(new AbortController(), coordinates.attempt, () =>
        boundary.complete(request, coordinates),
      ),
    ).rejects.toThrow(/accepted provider profile/u);
    expect(onMeasurement).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("binds the saved service and role models before the provider call", async () => {
    const complete = vi.fn(async () => assistant("done"));
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      providerServiceId: "zai_coding_plan_official",
      fastModelId: "glm-5-turbo",
      mainModelId: "glm-5-turbo",
      requireAcceptedProviderProfile: true,
      complete: complete as never,
    });
    boundary.bindAcceptedProviderProfile({
      providerServiceId: "zai_coding_plan_official",
      fastModelId: "glm-5-turbo",
      mainModelId: "glm-5-turbo",
    });

    await expect(
      inTask(new AbortController(), coordinates.attempt, () =>
        boundary.complete(request, coordinates),
      ),
    ).resolves.toMatchObject({ text: "done" });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("routes a saved provider endpoint despite live runtime drift", async () => {
    const complete = vi.fn(async (model) => {
      expect(model.baseUrl).toBe("https://custom.example/v1");
      return assistant("saved endpoint");
    });
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      providerServiceId: "zai_coding_plan_official",
      requireAcceptedProviderProfile: true,
      complete: complete as never,
    });

    boundary.bindAcceptedProviderProfile({
      providerServiceId: "openai_compatible_custom",
      providerEndpointIdentity: "openai_compatible_custom:https://custom.example/v1",
      fastModelId: "glm-5-turbo",
      mainModelId: "glm-5-turbo",
    });

    await expect(
      inTask(new AbortController(), coordinates.attempt, () =>
        boundary.complete(request, coordinates),
      ),
    ).resolves.toMatchObject({ text: "saved endpoint" });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("classifies a missing accepted provider adapter under the owning role", async () => {
    const complete = vi.fn(async () => assistant("must not run"));
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      requireAcceptedProviderProfile: true,
      complete: complete as never,
    });
    boundary.bindAcceptedProviderProfile({
      providerServiceId: "deterministic_test",
      providerEndpointIdentity: "deterministic_test:deterministic",
      fastModelId: "glm-5-turbo",
      mainModelId: "glm-5-turbo",
    });

    await expect(
      inTask(new AbortController(), coordinates.attempt, () =>
        boundary.complete(
          { ...request, model: "glm-5-turbo" },
          {
            ...coordinates,
            agentRole: "direct_answer",
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "answer_failed" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("classifies missing provider credentials under the owning role", async () => {
    const complete = vi.fn(async () => assistant("must not run"));
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      apiKey: "",
      requireAcceptedProviderProfile: true,
      complete: complete as never,
    });
    boundary.bindAcceptedProviderProfile({
      providerServiceId: "zai_coding_plan_official",
      providerEndpointIdentity: "zai_coding_plan_official:https://api.z.ai/api/coding/paas/v4",
      fastModelId: "glm-5-turbo",
      mainModelId: "glm-5-turbo",
    });

    await expect(
      inTask(new AbortController(), coordinates.attempt, () =>
        boundary.complete(request, { ...coordinates, agentRole: "direct_answer" }),
      ),
    ).rejects.toMatchObject({ code: "answer_failed" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("uses the accepted main model for main provider requests", async () => {
    const complete = vi.fn(async () => assistant("main done"));
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      providerServiceId: "zai_coding_plan_official",
      fastModelId: "glm-5-turbo",
      mainModelId: "glm-5-turbo",
      requireAcceptedProviderProfile: true,
      complete: complete as never,
    });
    boundary.bindAcceptedProviderProfile({
      providerServiceId: "zai_coding_plan_official",
      fastModelId: "glm-5-turbo",
      mainModelId: "glm-5-turbo",
    });

    await expect(
      inTask(new AbortController(), coordinates.attempt, () =>
        boundary.complete({ ...request, requestClass: "main" }, coordinates),
      ),
    ).resolves.toMatchObject({ text: "main done" });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("rejects a historical model before any measurement, hook, or transport", async () => {
    const complete = vi.fn(async () => assistant("must not run"));
    const onMeasurement = vi.fn();
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      complete: complete as never,
      hooks: { onMeasurement },
    });
    const historical = { ...request, model: "glm-5.2" };

    await expect(
      inTask(
        new AbortController(),
        coordinates.attempt,
        // Deliberately bypass the production type gate to verify the runtime
        // fail-closed check for malformed resumed state.
        () => boundary.complete(historical as unknown as LiveProviderRequest, coordinates),
        coordinates.loopIteration,
      ),
    ).rejects.toThrow(/\[invalid_workflow_output\]/u);
    expect(onMeasurement).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("fails closed before measurement or transport without exact Smithers coordinates", async () => {
    const complete = vi.fn(async () => assistant("ghost"));
    const onMeasurement = vi.fn();
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      complete: complete as never,
      hooks: { onMeasurement },
    });

    await expect(boundary.complete(request, coordinates)).rejects.toThrow(
      "Smithers task runtime is required for test",
    );
    expect(onMeasurement).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("gates the full transcript immediately before Pi and sends finite explicit options", async () => {
    const complete = vi.fn(async (_model, context, options) => {
      expect(context.systemPrompt).toBe("System");
      expect(context.messages.map((message: { readonly role: string }) => message.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
      ]);
      expect(options).toMatchObject({ maxTokens: 64, maxRetries: 0, reasoning: "medium" });
      return assistant("done");
    });
    const onMeasurement = vi.fn();
    const onUsage = vi.fn();
    const boundary = new ExactPiBoundary({
      apiKey: "test",
      baseUrl: "https://example.invalid/v4",
      fastLimits: { inputTokens: 100_000, outputTokens: 16_384 },
      mainLimits: { inputTokens: 100_000, outputTokens: 16_384 },
      fastTimeoutMs: 30_000,
      answerTimeoutMs: 120_000,
      complete: complete as never,
      hooks: { onMeasurement, onUsage },
    });

    const result = await inTask(
      new AbortController(),
      coordinates.attempt,
      () => boundary.complete(request, coordinates),
      coordinates.loopIteration,
    );
    expect(result.text).toBe("done");
    expect(complete).toHaveBeenCalledOnce();
    expect(onMeasurement).toHaveBeenCalledWith(
      coordinates,
      expect.objectContaining({ passed: true, requestedOutputTokens: 64 }),
      normalizeProviderRequest(request),
      [],
    );
    expect(onUsage).toHaveBeenCalledWith(
      coordinates,
      "glm-5-turbo",
      expect.objectContaining({ inputTokens: 12, reasoningTokens: 1 }),
    );
  });

  it("passes Pi's empty-assistant omission through the measured boundary", async () => {
    const emptyAssistantRequest: LiveProviderRequest = {
      ...request,
      messages: [
        { role: "system", content: "System" },
        { role: "user", content: "Question" },
        { role: "assistant", content: "", toolCalls: [] },
        { role: "assistant", content: " \n", toolCalls: [] },
      ],
      tools: undefined,
    };
    const complete = vi.fn(async (_model, context) => {
      expect(context.messages).toHaveLength(1);
      expect(context.messages[0]).toMatchObject({ role: "user", content: "Question" });
      return assistant("done");
    });
    const onMeasurement = vi.fn();
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      complete: complete as never,
      hooks: { onMeasurement },
    });

    await expect(
      inTask(
        new AbortController(),
        coordinates.attempt,
        () => boundary.complete(emptyAssistantRequest, coordinates),
        coordinates.loopIteration,
      ),
    ).resolves.toMatchObject({ text: "done" });
    expect(onMeasurement).toHaveBeenCalledWith(
      coordinates,
      expect.objectContaining({ passed: true }),
      expect.objectContaining({
        messages: [
          { role: "system", content: "System" },
          { role: "user", content: "Question" },
        ],
      }),
      [],
    );
  });

  it.each([
    [
      "negative input",
      { input: -1, output: 3, cacheRead: 2, cacheWrite: 0, reasoning: 1, totalTokens: 4 },
    ],
    [
      "fractional output",
      { input: 12, output: 3.5, cacheRead: 2, cacheWrite: 0, reasoning: 1, totalTokens: 17.5 },
    ],
    [
      "non-finite cached",
      {
        input: 12,
        output: 3,
        cacheRead: Number.NaN,
        cacheWrite: 0,
        reasoning: 1,
        totalTokens: Number.NaN,
      },
    ],
    [
      "total arithmetic mismatch",
      { input: 12, output: 3, cacheRead: 2, cacheWrite: 0, reasoning: 1, totalTokens: 18 },
    ],
    [
      "reasoning exceeds output",
      { input: 12, output: 3, cacheRead: 2, cacheWrite: 0, reasoning: 4, totalTokens: 17 },
    ],
  ] as const)("rejects %s usage before the persistence hook", async (_label, usage) => {
    const onUsage = vi.fn();
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      complete: vi.fn(async () => ({ ...assistant("invalid"), usage })) as never,
      hooks: { onUsage },
    });

    await expect(
      inTask(
        new AbortController(),
        coordinates.attempt,
        () => boundary.complete(request, coordinates),
        coordinates.loopIteration,
      ),
    ).rejects.toMatchObject({ code: "invalid_workflow_output", retryable: true });
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("passes only independently recounted source-exposure proofs to durable measurement", async () => {
    const visibleText = "exact visible document preview";
    const logicalSourceIdentity = namespacedDocumentEvidenceIdentity(
      { kind: "public", sourceId: "public:source-1" },
      "doc-1",
    );
    const marker: ProviderVisibleSourceExposureMarker = {
      sourceKind: "document",
      logicalSourceIdentity,
      contentItemIdentity: `${logicalSourceIdentity}:version-1:${sha256Base64Url(visibleText)}`,
      exposureStage: "internal_search_preview",
      visibleTokenCount: resolveRegisteredModel("glm-5-turbo").countTextTokens(visibleText),
    };
    const sourceRequest: LiveProviderRequest = {
      ...request,
      messages: [
        { role: "system", content: "System" },
        { role: "user", content: "Question" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "source-call",
              name: "search_internal",
              arguments: { query: { target: "documents" } },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "source-call",
          name: "search_internal",
          content: JSON.stringify({
            items: [
              {
                kind: "public_source",
                sourceId: "public:source-1",
                documentId: "doc-1",
                documentVersionId: "version-1",
                snippet: visibleText,
              },
            ],
            __briefSourceExposures: [marker],
          }),
        },
      ],
    };
    const onMeasurement = vi.fn();
    const complete = vi.fn(async () => assistant("done"));
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      complete: complete as never,
      hooks: { onMeasurement },
    });

    await expect(
      inTask(
        new AbortController(),
        coordinates.attempt,
        () => boundary.complete(sourceRequest, coordinates),
        coordinates.loopIteration,
      ),
    ).resolves.toMatchObject({ text: "done" });
    expect(onMeasurement).toHaveBeenCalledWith(
      coordinates,
      expect.objectContaining({ passed: true }),
      normalizeProviderRequest(sourceRequest),
      [providerVisibleSourceExposureProofSha256Hex(marker)],
    );
    expect(complete).toHaveBeenCalledOnce();
  });

  it("rejects a source marker/body mismatch before measurement persistence or transport", async () => {
    const visibleText = "exact visible document preview";
    const logicalSourceIdentity = namespacedDocumentEvidenceIdentity(
      { kind: "public", sourceId: "public:source-1" },
      "doc-1",
    );
    const marker: ProviderVisibleSourceExposureMarker = {
      sourceKind: "document",
      logicalSourceIdentity,
      contentItemIdentity: `${logicalSourceIdentity}:version-1:${sha256Base64Url(visibleText)}`,
      exposureStage: "internal_search_preview",
      visibleTokenCount: resolveRegisteredModel("glm-5-turbo").countTextTokens(visibleText) + 1,
    };
    const invalidRequest: LiveProviderRequest = {
      ...request,
      messages: [
        { role: "system", content: "System" },
        { role: "user", content: "Question" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "source-call",
              name: "search_internal",
              arguments: { query: { target: "documents" } },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "source-call",
          name: "search_internal",
          content: JSON.stringify({
            items: [
              {
                kind: "public_source",
                sourceId: "public:source-1",
                documentId: "doc-1",
                documentVersionId: "version-1",
                snippet: visibleText,
              },
            ],
            __briefSourceExposures: [marker],
          }),
        },
      ],
    };
    const onMeasurement = vi.fn();
    const complete = vi.fn(async () => assistant("must not run"));
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      complete: complete as never,
      hooks: { onMeasurement },
    });

    await expect(
      inTask(
        new AbortController(),
        coordinates.attempt,
        () => boundary.complete(invalidRequest, coordinates),
        coordinates.loopIteration,
      ),
    ).rejects.toThrow(/runtime boundary failed/u);
    expect(onMeasurement).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("preserves Pi cache reads and writes in exact total-token accounting", async () => {
    const cached = assistant("cached");
    cached.usage = {
      ...cached.usage,
      input: 7,
      output: 3,
      cacheRead: 4,
      cacheWrite: 2,
      totalTokens: 16,
    };
    const onUsage = vi.fn();
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      complete: vi.fn(async () => cached) as never,
      hooks: { onUsage },
    });

    await expect(
      inTask(
        new AbortController(),
        coordinates.attempt,
        () => boundary.complete(request, coordinates),
        coordinates.loopIteration,
      ),
    ).resolves.toMatchObject({
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        cachedTokens: 6,
        totalTokens: 16,
      },
    });
    expect(onUsage).toHaveBeenCalledWith(
      coordinates,
      "glm-5-turbo",
      expect.objectContaining({ cachedTokens: 6, totalTokens: 16 }),
    );
  });

  it("never invokes Pi when the exact local gate fails", async () => {
    const complete = vi.fn();
    const onBeforeRequest = vi.fn();
    const boundary = new ExactPiBoundary({
      apiKey: "test",
      baseUrl: "https://example.invalid/v4",
      fastLimits: { inputTokens: 1, outputTokens: 64 },
      mainLimits: { inputTokens: 1, outputTokens: 64 },
      fastTimeoutMs: 30_000,
      answerTimeoutMs: 120_000,
      complete: complete as never,
    });
    await expect(
      inTask(
        new AbortController(),
        coordinates.attempt,
        () => boundary.complete(request, coordinates, onBeforeRequest),
        coordinates.loopIteration,
      ),
    ).rejects.toThrow(/agent_context_budget_exceeded|only 1 fit/);
    expect(complete).not.toHaveBeenCalled();
    expect(onBeforeRequest).not.toHaveBeenCalled();
  });

  it("runs the exact gate before the per-request authorization/event hook and transport", async () => {
    const order: string[] = [];
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      complete: vi.fn(async () => {
        order.push("transport");
        return assistant("done");
      }) as never,
      hooks: {
        onMeasurement: () => {
          order.push("measurement");
        },
      },
    });
    const before = vi.fn((exactRequest, exactCoordinates, measurement) => {
      order.push("before");
      expect(exactRequest).toEqual(normalizeProviderRequest(request));
      expect(exactCoordinates).toEqual({
        ...coordinates,
        providerRequestSha256Hex: providerRequestSha256Hex(exactRequest),
      });
      expect(measurement.passed).toBe(true);
    });

    await expect(
      inTask(
        new AbortController(),
        coordinates.attempt,
        () => boundary.complete(request, coordinates, before),
        coordinates.loopIteration,
      ),
    ).resolves.toMatchObject({ text: "done" });
    expect(order).toEqual(["measurement", "before", "transport"]);
    expect(before).toHaveBeenCalledOnce();
  });

  it("preserves task cancellation when a post-gate hook rejects with a non-AbortError", async () => {
    const controller = new AbortController();
    const complete = vi.fn(async () => assistant("ghost"));
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      complete: complete as never,
    });

    await expect(
      inTask(
        controller,
        coordinates.attempt,
        () =>
          boundary.complete(request, coordinates, async () => {
            controller.abort();
            throw new Error("database interruption wrapper");
          }),
        coordinates.loopIteration,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("sends the exact normalized multi-system, schema, tool, and transcript shape that was counted", async () => {
    const unorderedRequest: LiveProviderRequest = {
      ...request,
      messages: [
        { role: "system", content: "First system" },
        { role: "user", content: "Question" },
        { role: "system", content: "Second system" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-normalized",
              name: "search",
              arguments: { zeta: { y: 2, a: 1 }, alpha: true },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-normalized",
          name: "search",
          content: '{"complete":true}',
        },
      ],
      tools: [
        {
          name: "search",
          description: "Search",
          parameters: {
            type: "object",
            required: ["query"],
            properties: { query: { zeta: false, type: "string", alpha: true } },
          },
        },
      ],
      responseSchema: {
        type: "object",
        required: ["answer"],
        properties: { answer: { zeta: false, type: "string", alpha: true } },
      },
    };
    const normalized = normalizeProviderRequest(unorderedRequest);
    const complete = vi.fn(async (_model, context) => {
      expect(context.systemPrompt).toBe(
        `First system\n\nSecond system\n\nReturn JSON matching this exact response schema:\n${stableJson(unorderedRequest.responseSchema)}`,
      );
      expect(context.messages.map((message: { readonly role: string }) => message.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
      ]);
      expect(context.messages[2]).toMatchObject({
        toolCallId: "call-normalized",
        toolName: "search",
      });
      expect(JSON.stringify(context.messages[1]?.content[0]?.arguments)).toBe(
        '{"alpha":true,"zeta":{"a":1,"y":2}}',
      );
      expect(JSON.stringify(context.tools?.[0]?.parameters)).toBe(
        '{"properties":{"query":{"alpha":true,"type":"string","zeta":false}},"required":["query"],"type":"object"}',
      );
      return assistant("normalized");
    });
    const onMeasurement = vi.fn();
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      complete: complete as never,
      hooks: { onMeasurement },
    });

    await expect(
      inTask(
        new AbortController(),
        coordinates.attempt,
        () => boundary.complete(unorderedRequest, coordinates),
        coordinates.loopIteration,
      ),
    ).resolves.toMatchObject({ text: "normalized" });
    expect(normalized.responseSchema).toBeUndefined();
    expect(normalized.messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect(onMeasurement).toHaveBeenCalledWith(
      coordinates,
      expect.objectContaining({
        inputTokens: resolveRegisteredModel("glm-5-turbo").countRequestTokens(normalized),
      }),
      normalized,
      [],
    );
  });

  it("removes a task aborted behind the global semaphore without a ghost Pi call", async () => {
    const semaphore = new ProviderSemaphore(1);
    const blocker = deferred<void>();
    const active = semaphore.withPermit(() => blocker.promise);
    await Promise.resolve();
    const complete = vi.fn(async () => assistant("ghost"));
    const onUsage = vi.fn();
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      complete: complete as never,
      providerSemaphore: semaphore,
      hooks: { onUsage },
    });
    const controller = new AbortController();
    const result = inTask(controller, 1, () =>
      boundary.complete(request, { ...coordinates, attempt: 1 }),
    );
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(semaphore.snapshot()).toEqual({ active: 1, queued: 1, limit: 1 });

    controller.abort();
    await expect(result).rejects.toBeInstanceOf(Error);
    blocker.resolve();
    await active;

    expect(complete).not.toHaveBeenCalled();
    expect(onUsage).not.toHaveBeenCalled();
    expect(semaphore.snapshot()).toEqual({ active: 0, queued: 0, limit: 1 });
  });

  it("passes the Smithers signal to an in-flight Pi call and suppresses aborted usage", async () => {
    const started = deferred<void>();
    let receivedSignal: AbortSignal | undefined;
    const complete = vi.fn(
      async (_model: unknown, _context: unknown, options: { readonly signal?: AbortSignal }) => {
        receivedSignal = options.signal;
        started.resolve();
        return new Promise<AssistantMessage>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("Pi transport aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
      },
    );
    const onUsage = vi.fn();
    const semaphore = new ProviderSemaphore(1);
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      complete: complete as never,
      providerSemaphore: semaphore,
      hooks: { onUsage },
    });
    const controller = new AbortController();
    const result = inTask(controller, 1, () => boundary.complete(request, coordinates));
    await started.promise;

    expect(receivedSignal).toBe(controller.signal);
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(Error);
    expect(onUsage).not.toHaveBeenCalled();
    expect(semaphore.snapshot()).toEqual({ active: 0, queued: 0, limit: 1 });
  });

  it("suppresses a late provider result and usage when a transport ignores abort", async () => {
    const pending = deferred<AssistantMessage>();
    const complete = vi.fn(() => pending.promise);
    const onUsage = vi.fn();
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      complete: complete as never,
      hooks: { onUsage },
    });
    const controller = new AbortController();
    const result = inTask(controller, 1, () => boundary.complete(request, coordinates));
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(complete).toHaveBeenCalledOnce();

    controller.abort();
    pending.resolve(assistant("late"));
    await expect(result).rejects.toBeInstanceOf(Error);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("passes cancellation to streaming Pi and emits no late delta or usage", async () => {
    const releaseStream = deferred<void>();
    const started = deferred<void>();
    let receivedSignal: AbortSignal | undefined;
    const stream = vi.fn(
      (_model: unknown, _context: unknown, options: { readonly signal?: AbortSignal }) => {
        receivedSignal = options.signal;
        return {
          async *[Symbol.asyncIterator]() {
            started.resolve();
            await releaseStream.promise;
            yield { type: "text_delta" as const, delta: "ghost" };
            yield { type: "done" as const, message: assistant("ghost") };
          },
        };
      },
    );
    const onDelta = vi.fn();
    const onUsage = vi.fn();
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      stream: stream as never,
      hooks: { onUsage },
    });
    const controller = new AbortController();
    const result = inTask(controller, 1, () => boundary.stream(request, coordinates, onDelta));
    await started.promise;

    expect(receivedSignal).toBe(controller.signal);
    controller.abort();
    releaseStream.resolve();
    await expect(result).rejects.toBeInstanceOf(Error);
    expect(onDelta).not.toHaveBeenCalled();
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("persists measurements for each retry coordinate but usage only for the successful attempt", async () => {
    const firstStarted = deferred<void>();
    const complete = vi
      .fn()
      .mockImplementationOnce(
        async (_model: unknown, _context: unknown, options: { readonly signal?: AbortSignal }) => {
          firstStarted.resolve();
          return new Promise<AssistantMessage>((_resolve, reject) => {
            options.signal?.addEventListener(
              "abort",
              () => {
                const error = new Error("first attempt aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          });
        },
      )
      .mockResolvedValueOnce(assistant("retry succeeded"));
    const onMeasurement = vi.fn();
    const onUsage = vi.fn();
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      complete: complete as never,
      hooks: { onMeasurement, onUsage },
    });
    const firstController = new AbortController();
    const firstCoordinates = { ...coordinates, attempt: 1 };
    const first = inTask(firstController, 1, () => boundary.complete(request, firstCoordinates));
    await firstStarted.promise;
    firstController.abort();
    await expect(first).rejects.toBeInstanceOf(Error);

    const secondController = new AbortController();
    const secondCoordinates = { ...coordinates, attempt: 2 };
    await expect(
      inTask(secondController, 2, () => boundary.complete(request, secondCoordinates), 1),
    ).resolves.toMatchObject({ text: "retry succeeded" });

    expect(onMeasurement).toHaveBeenCalledTimes(2);
    expect(onMeasurement.mock.calls.map(([value]) => value)).toEqual([
      { ...firstCoordinates, loopIteration: 0 },
      secondCoordinates,
    ]);
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledWith(secondCoordinates, "glm-5-turbo", expect.any(Object));
  });

  it("does not persist usage for a provider-returned aborted message", async () => {
    const onUsage = vi.fn();
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      complete: vi.fn(async () => ({
        ...assistant("partial"),
        stopReason: "aborted" as const,
        errorMessage: "Request was aborted",
      })) as never,
      hooks: { onUsage },
    });

    await expect(
      inTask(
        new AbortController(),
        coordinates.attempt,
        () => boundary.complete(request, coordinates),
        coordinates.loopIteration,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("records known failed-attempt usage while keeping product retryability code-owned", async () => {
    const onUsage = vi.fn();
    const failed = {
      ...assistant(""),
      usage: { ...assistant("").usage, input: 21, output: 2, totalTokens: 25 },
      stopReason: "error" as const,
      errorMessage: "401: invalid api key",
    };
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      complete: vi.fn(async () => failed) as never,
      hooks: { onUsage },
    });
    const roleCoordinates = { ...coordinates, agentRole: "memory_extractor" };

    await expect(
      inTask(
        new AbortController(),
        coordinates.attempt,
        () => boundary.complete(request, roleCoordinates),
        coordinates.loopIteration,
      ),
    ).rejects.toMatchObject({
      code: "memory_extraction_failed",
      retryable: true,
      providerStatus: null,
      details: { failureRetryable: false },
    });
    expect(onUsage).toHaveBeenCalledWith(
      roleCoordinates,
      "glm-5-turbo",
      expect.objectContaining({ inputTokens: 21, outputTokens: 2, stopReason: "error" }),
    );
  });

  it("does not invent a zero usage record when a failed final reports no known accounting", async () => {
    const onUsage = vi.fn();
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      complete: vi.fn(async () => ({
        ...assistant(""),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error" as const,
        errorMessage: "401: invalid api key",
      })) as never,
      hooks: { onUsage },
    });

    await expect(
      inTask(
        new AbortController(),
        coordinates.attempt,
        () => boundary.complete(request, coordinates),
        coordinates.loopIteration,
      ),
    ).rejects.toMatchObject({
      code: "invalid_workflow_output",
      retryable: true,
      providerStatus: null,
    });
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("does not classify raw context-overflow-looking provider text as a budget defect", async () => {
    const onUsage = vi.fn();
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      complete: vi.fn(async () => ({
        ...assistant(""),
        stopReason: "error" as const,
        errorMessage: "400: maximum context length exceeded",
      })) as never,
      hooks: { onUsage },
    });

    await expect(
      inTask(
        new AbortController(),
        coordinates.attempt,
        () => boundary.complete(request, coordinates),
        coordinates.loopIteration,
      ),
    ).rejects.toMatchObject({
      code: "invalid_workflow_output",
      retryable: true,
      providerStatus: null,
    });
    expect(onUsage).toHaveBeenCalledWith(
      coordinates,
      "glm-5-turbo",
      expect.objectContaining({ stopReason: "error" }),
    );
  });

  it("retains known usage from a streamed error final without trusting its text status", async () => {
    const onUsage = vi.fn();
    const failed = {
      ...assistant("partial"),
      stopReason: "error" as const,
      errorMessage: "HTTP 503 service unavailable",
    };
    const stream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta" as const, delta: "partial" };
        yield { type: "error" as const, reason: "error" as const, error: failed };
      },
    }));
    const onDelta = vi.fn();
    const boundary = new ExactPiBoundary({
      ...boundaryOptions(),
      stream: stream as never,
      hooks: { onUsage },
    });
    const roleCoordinates = { ...coordinates, agentRole: "direct_answer" };

    await expect(
      inTask(
        new AbortController(),
        coordinates.attempt,
        () => boundary.stream(request, roleCoordinates, onDelta),
        coordinates.loopIteration,
      ),
    ).rejects.toMatchObject({
      code: "answer_failed",
      retryable: true,
      providerStatus: null,
      details: undefined,
    });
    expect(onDelta).toHaveBeenCalledWith("partial", 0);
    expect(onUsage).toHaveBeenCalledWith(
      roleCoordinates,
      "glm-5-turbo",
      expect.objectContaining({ stopReason: "error" }),
    );
  });
});
