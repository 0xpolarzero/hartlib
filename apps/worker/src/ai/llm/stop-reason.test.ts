import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { resolveZaiModel } from "./models";
import { classifyAssistantMessage } from "./stop-reason";
import { zeroUsage } from "./types";

const usage = (input: number): Usage => ({
  ...zeroUsage(),
  input,
  totalTokens: input,
});

const errorMessage = (error: string, inputTokens = 10): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "openai-completions",
  provider: "zai",
  model: "glm-5.2",
  usage: usage(inputTokens),
  stopReason: "error",
  errorMessage: error,
  timestamp: Date.now(),
});

const lengthMessage = (): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "partial" }],
  api: "openai-completions",
  provider: "zai",
  model: "glm-5.2",
  usage: usage(10),
  stopReason: "length",
  timestamp: Date.now(),
});

describe("LLM stopReason mapping", () => {
  it("classifies context overflow before retryable provider errors", () => {
    const model = { ...resolveZaiModel({ modelId: "glm-5.2" }), contextWindow: 100 };
    const result = classifyAssistantMessage(
      errorMessage("rate limit exceeded", 101),
      model,
      "value",
    );

    expect(result.kind).toBe("overflow");
  });

  it("classifies non-retryable errors as fatal", () => {
    const model = resolveZaiModel({ modelId: "glm-5.2" });
    const result = classifyAssistantMessage(errorMessage("invalid api key"), model, "value");

    expect(result.kind).toBe("fatal");
  });

  it("classifies length stops as truncated instead of ok", () => {
    const model = resolveZaiModel({ modelId: "glm-5.2" });
    const result = classifyAssistantMessage(lengthMessage(), model, "value");

    expect(result.kind).toBe("truncated");
  });
});
