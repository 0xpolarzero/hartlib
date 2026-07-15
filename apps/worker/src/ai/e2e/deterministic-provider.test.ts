import * as SmithersTaskRuntimeModule from "@smithers-orchestrator/driver/task-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ConversationResolverPrompt } from "../prompts";
import { CanonicalAgentClient } from "../runtime/agent-client";
import {
  ConversationResolutionProviderSchema,
  validateConversationResolution,
} from "../runtime/validators";
import { DeterministicE2eProviderBoundary } from "./deterministic-provider";

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
      stepId: "resolve-conversation",
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
        system: ConversationResolverPrompt,
        user: JSON.stringify({
          currentMessage,
          entries,
          locale: "en-US",
          market: "US",
          currentDate: "2026-07-14",
        }),
        outputToolName: "emit_conversation_resolution",
        outputToolDescription: "Emit the validated conversation resolution.",
        outputSchema: z.toJSONSchema(ConversationResolutionProviderSchema),
        validate: (value) =>
          validateConversationResolution(
            value,
            entries.map((entry) => entry.turnId),
          ),
        requestedOutputTokens: 2_048,
        reasoning: "medium",
        coordinates: {
          taskId: "resolve-conversation",
          loopIteration: 0,
          attempt: 1,
          providerRequestIndex: 0,
          agentRole: "conversation_resolver",
        },
      }),
  );
};

describe("deterministic conversation resolver", () => {
  it("clarifies an unanchored comparison with multiple plausible antecedents", async () => {
    const result = await resolve("Compare it with the previous result.");
    expect(result).toMatchObject({ mode: "clarify" });
    if (result.mode !== "clarify") throw new Error("expected clarification");
    expect(result.question).toMatch(/wind/iu);
    expect(result.question).toMatch(/solar/iu);
  });

  it("continues when both comparison candidates are explicitly anchored", async () => {
    await expect(resolve("Compare the wind result with the solar result.")).resolves.toEqual({
      mode: "continue",
      retrievalQuestion: "Compare the wind result with the solar result.",
      selectedTurnIds: ["turn-wind", "turn-solar"],
    });
  });
});
