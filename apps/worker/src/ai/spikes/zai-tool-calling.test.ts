import { Type } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  Tool,
} from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const isBun = typeof process.versions.bun === "string";
const spikeTestsEnabled = process.env.AI_SPIKE_TESTS === "1";

const searchDocumentsTool = {
  name: "search_documents",
  description: "Search documents",
  parameters: Type.Object({
    terms: Type.String(),
    limit: Type.Optional(Type.Number()),
  }),
} satisfies Tool;

const emitManifestTool = {
  name: "emit_manifest",
  description: "Emit the context manifest",
  parameters: Type.Object({
    entries: Type.Array(
      Type.Object({
        documentId: Type.String(),
        charStart: Type.Optional(Type.Number()),
        charEnd: Type.Optional(Type.Number()),
      }),
    ),
  }),
} satisfies Tool;

type CapturedRequest = {
  authorization: string | null;
  body: Record<string, unknown>;
  pathname: string;
};

const toolSchema = (tool: Tool) =>
  JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>;

const toolBody = (tool: Tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: toolSchema(tool),
    strict: false,
  },
});

const userMessage = (content: string) => ({
  role: "user" as const,
  content,
  timestamp: Date.now(),
});

const sse = (...chunks: Array<Record<string, unknown>>) =>
  `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;

const textResponseSse = () =>
  sse(
    {
      id: "chatcmpl-spike",
      object: "chat.completion.chunk",
      created: 0,
      model: "glm-5-turbo",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "ok" },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-spike",
      object: "chat.completion.chunk",
      created: 0,
      model: "glm-5-turbo",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    },
  );

const collectFinal = async (events: AssistantMessageEventStream): Promise<AssistantMessage> => {
  for await (const event of events) {
    if (event.type === "done" || event.type === "error") {
      return event.type === "done" ? event.message : event.error;
    }
  }

  expect.fail("stream ended without a final message");
};

describe.skipIf(!isBun || !spikeTestsEnabled)(
  "zai structured tool calling via openai-completions",
  () => {
    const baseModel = getBuiltinModel("zai", "glm-5-turbo");
    const requests: CapturedRequest[] = [];
    let server: ReturnType<typeof Bun.serve>;
    let sseBody = "";

    beforeAll(() => {
      server = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);

          requests.push({
            pathname: url.pathname,
            authorization: request.headers.get("authorization"),
            body: (await request.json()) as Record<string, unknown>,
          });

          return new Response(sseBody, {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
    });

    afterAll(() => {
      server?.stop(true);
    });

    const localModel = (): Model<"openai-completions"> => ({
      ...baseModel,
      baseUrl: `${server.url.origin}/v4`,
    });

    const contextWithTools = (content: string): Context => ({
      systemPrompt: "spike",
      messages: [userMessage(content)],
      tools: [searchDocumentsTool, emitManifestTool],
    });

    const resetServer = (body: string) => {
      requests.length = 0;
      sseBody = body;
    };

    it("sends tool definitions, tool_choice, and the explicit glm thinking parameter", async () => {
      resetServer(
        sse(
          {
            id: "chatcmpl-spike",
            object: "chat.completion.chunk",
            created: 0,
            model: "glm-5-turbo",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      type: "function",
                      function: {
                        name: "emit_manifest",
                        arguments: JSON.stringify({
                          entries: [{ documentId: "doc-1", charStart: 0, charEnd: 120 }],
                        }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl-spike",
            object: "chat.completion.chunk",
            created: 0,
            model: "glm-5-turbo",
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          },
        ),
      );

      const final = await collectFinal(
        stream(localModel(), contextWithTools("emit the manifest"), {
          apiKey: "spike-key",
          reasoningEffort: "medium",
          toolChoice: { type: "function", function: { name: "emit_manifest" } },
        }),
      );

      expect(requests).toHaveLength(1);
      const captured = requests[0];
      if (captured === undefined) {
        throw new Error("Missing captured request");
      }

      expect(captured.pathname).toBe("/v4/chat/completions");
      expect(captured.authorization).toBe("Bearer spike-key");
      const body = captured.body;
      expect(body.model).toBe("glm-5-turbo");
      expect(body.stream).toBe(true);
      expect(body.tool_stream).toBe(true);
      expect(body.tools).toEqual([toolBody(searchDocumentsTool), toolBody(emitManifestTool)]);
      expect(body.tool_choice).toEqual({
        type: "function",
        function: { name: "emit_manifest" },
      });
      expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
      expect("reasoning_effort" in body).toBe(false);
      expect(body.messages).toMatchObject([
        { role: "system", content: "spike" },
        { role: "user", content: "emit the manifest" },
      ]);

      expect(final.stopReason).toBe("toolUse");
      expect(final.content).toEqual([
        {
          type: "toolCall",
          id: "call-1",
          name: "emit_manifest",
          arguments: {
            entries: [{ documentId: "doc-1", charStart: 0, charEnd: 120 }],
          },
        },
      ]);
      expect(final.usage.input).toBe(10);
      expect(final.usage.output).toBe(5);
    });

    it("sends an explicit disabled thinking parameter when reasoning is off", async () => {
      resetServer(textResponseSse());

      const final = await collectFinal(
        stream(localModel(), contextWithTools("say ok"), {
          apiKey: "spike-key",
        }),
      );

      expect(requests).toHaveLength(1);
      const captured = requests[0];
      if (captured === undefined) {
        throw new Error("Missing captured request");
      }
      const body = captured.body;

      expect(body.thinking).toEqual({ type: "disabled" });
      expect("reasoning_effort" in body).toBe(false);
      expect("tool_choice" in body).toBe(false);
      expect(body.tools).toHaveLength(2);
      expect(final.stopReason).toBe("stop");
      expect(final.content).toEqual([{ type: "text", text: "ok" }]);
    });

    it("omits tools and tool_choice for a zero-tool context", async () => {
      resetServer(textResponseSse());

      const final = await collectFinal(
        stream(
          localModel(),
          {
            systemPrompt: "spike",
            messages: [userMessage("say ok")],
          },
          { apiKey: "spike-key" },
        ),
      );

      expect(requests).toHaveLength(1);
      const captured = requests[0];
      if (captured === undefined) {
        throw new Error("Missing captured request");
      }
      const body = captured.body;

      expect("tools" in body).toBe(false);
      expect("tool_choice" in body).toBe(false);
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(final.stopReason).toBe("stop");
    });

    const liveApiKey = process.env.ZAI_API_KEY;

    it.skipIf(!liveApiKey)(
      "round-trips a structured tool call against z.ai",
      { timeout: 60_000 },
      async () => {
        if (liveApiKey === undefined) {
          return;
        }

        const final = await collectFinal(
          stream(
            {
              ...baseModel,
              baseUrl: process.env.AI_BASE_URL ?? baseModel.baseUrl,
            },
            {
              systemPrompt: "spike",
              messages: [
                userMessage(
                  "Emit a manifest selecting documentId doc-live with charStart 0 and charEnd 10.",
                ),
              ],
              tools: [emitManifestTool],
            },
            {
              apiKey: liveApiKey,
              reasoningEffort: "medium",
              toolChoice: { type: "function", function: { name: "emit_manifest" } },
            },
          ),
        );

        expect(final.stopReason).toBe("toolUse");
        expect(
          final.content.some(
            (block) =>
              block.type === "toolCall" &&
              block.name === "emit_manifest" &&
              Array.isArray(block.arguments.entries),
          ),
        ).toBe(true);
      },
    );
  },
);
