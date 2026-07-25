import * as SmithersTaskRuntimeModule from "@smithers-orchestrator/driver/task-runtime";
import { describe, expect, it } from "vitest";

import { DeterministicE2eProviderBoundary } from "./deterministic-provider";
import type { LiveProviderRequest } from "../runtime/provider-request";

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

const request: LiveProviderRequest = {
  requestClass: "main",
  model: "glm-5-turbo",
  messages: [
    { role: "system", content: "answer" },
    { role: "user", content: "Use the saved provider profile." },
  ],
  requestedOutputTokens: 2_048,
  reasoning: "medium",
};

const streamWithRuntime = (taskId: string, provider: DeterministicE2eProviderBoundary) =>
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
    () =>
      provider.stream(
        request,
        {
          taskId,
          loopIteration: 0,
          attempt: 1,
          providerRequestIndex: 0,
          agentRole: "direct_answer",
        },
        () => undefined,
      ),
  );

describe("deterministic provider acceptance", () => {
  it("uses the saved provider profile despite live runtime drift", async () => {
    const provider = new DeterministicE2eProviderBoundary({
      fastLimits: { inputTokens: 100_000, outputTokens: 16_384 },
      mainLimits: { inputTokens: 100_000, outputTokens: 16_384 },
      providerServiceId: "openai_compatible_custom",
      providerEndpointIdentity: "openai_compatible_custom:https://live-drift.example/v1",
      fastModelId: "glm-5-turbo",
      mainModelId: "glm-5-turbo",
      requireAcceptedProviderProfile: true,
    });
    provider.bindAcceptedProviderProfile({
      providerServiceId: "deterministic_test",
      providerEndpointIdentity: "deterministic_test:historical",
      fastModelId: "glm-5-turbo",
      mainModelId: "glm-5-turbo",
    });

    await expect(streamWithRuntime("accepted-profile-drift", provider)).resolves.toMatchObject({
      text: expect.stringContaining("Deterministic direct answer"),
    });
  });

  it("reports a missing saved-provider adapter under the owning role", async () => {
    const provider = new DeterministicE2eProviderBoundary({
      fastLimits: { inputTokens: 100_000, outputTokens: 16_384 },
      mainLimits: { inputTokens: 100_000, outputTokens: 16_384 },
      providerServiceId: "deterministic_test",
      providerEndpointIdentity: "deterministic_test:current",
      fastModelId: "glm-5-turbo",
      mainModelId: "glm-5-turbo",
      requireAcceptedProviderProfile: true,
    });
    provider.bindAcceptedProviderProfile({
      providerServiceId: "zai_coding_plan_official",
      providerEndpointIdentity: "zai_coding_plan_official:https://api.z.ai/api/coding/paas/v4",
      fastModelId: "glm-5-turbo",
      mainModelId: "glm-5-turbo",
    });

    await expect(
      streamWithRuntime("accepted-profile-missing-adapter", provider),
    ).rejects.toMatchObject({ code: "answer_failed" });
  });
});
