import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import type {
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  StreamFn,
} from "@earendil-works/pi-agent-core";

const isBun = typeof process.versions.bun === "string";

const zeroUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const isLlmMessage = (
  message: AgentMessage,
): message is Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }> =>
  message.role === "user" || message.role === "assistant" || message.role === "toolResult";

const makeAssistantMessage = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "zai",
  model: "glm-5.2",
  usage: zeroUsage,
  stopReason: "stop",
  timestamp: Date.now(),
});

describe.skipIf(!isBun)("pi under bun", () => {
  it("runs under the bun runtime", () => {
    expect(process.versions.bun).toBeTruthy();
  });

  it("resolves the zai catalog model for glm-5.2", async () => {
    const { getBuiltinModel } = await import("@earendil-works/pi-ai/providers/all");
    const { ZAI_MODELS } = await import("@earendil-works/pi-ai/providers/zai.models");
    const model = getBuiltinModel("zai", "glm-5.2");

    expect(model.id).toBe("glm-5.2");
    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("zai");
    expect(model.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(model.reasoning).toBe(true);
    expect(model.contextWindow).toBe(1000000);
    expect(model.maxTokens).toBe(131072);
    expect(model.compat?.thinkingFormat).toBe("zai");
    expect(model.thinkingLevelMap).toEqual({
      minimal: null,
      low: "high",
      medium: "high",
      high: "high",
      xhigh: "max",
    });
    const zaiModel = ZAI_MODELS["glm-5.2"];

    if (!zaiModel) {
      throw new Error("Missing glm-5.2 ZAI model");
    }

    expect(zaiModel.id).toBe("glm-5.2");
  });

  it("validates AgentTool arguments with the typebox re-exports", async () => {
    const { Type, validateToolArguments } = await import("@earendil-works/pi-ai");
    const parameters = Type.Object({
      terms: Type.String(),
      limit: Type.Optional(Type.Number()),
    });
    const tool: AgentTool<typeof parameters> = {
      name: "search_documents",
      description: "Search documents",
      label: "Search documents",
      parameters,
      execute: async (_toolCallId, params) => ({
        content: [{ type: "text", text: params.terms }],
        details: null,
      }),
    };

    const args = validateToolArguments(tool, {
      type: "toolCall",
      id: "call-1",
      name: "search_documents",
      arguments: { terms: "budget 2026", limit: 5 },
    });

    expect(args.terms).toBe("budget 2026");
    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-2",
        name: "search_documents",
        arguments: { limit: 5 },
      }),
    ).toThrow();
  });

  it("accepts an agentLoop config with a stub model and completes a turn without network", async () => {
    const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
    const { getBuiltinModel } = await import("@earendil-works/pi-ai/providers/all");
    const { agentLoop } = await import("@earendil-works/pi-agent-core");
    const config: AgentLoopConfig = {
      model: getBuiltinModel("zai", "glm-5.2"),
      apiKey: "spike-key",
      convertToLlm: (messages) => messages.filter(isLlmMessage) as Message[],
    };
    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      const message = makeAssistantMessage("spike ok");

      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);

      return stream;
    };
    const stream = agentLoop(
      [{ role: "user", content: "ping", timestamp: Date.now() }],
      { systemPrompt: "spike", messages: [], tools: [] },
      config,
      undefined,
      streamFn,
    );
    const eventTypes: string[] = [];

    for await (const event of stream) {
      eventTypes.push(event.type);
    }

    const messages = await stream.result();

    expect(eventTypes).toEqual(
      expect.arrayContaining(["agent_start", "turn_start", "message_end", "turn_end", "agent_end"]),
    );
    expect(
      messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some((content) => content.type === "text" && content.text === "spike ok"),
      ),
    ).toBe(true);
  });
});
