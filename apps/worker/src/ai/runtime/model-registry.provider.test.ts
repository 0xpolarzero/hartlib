import { describe, expect, it } from "vitest";

import { resolveUnverifiedModelForProviderContract } from "./model-registry";
import {
  normalizeProviderRequest,
  stableJson,
  toGlmTemplateInput,
  type ProviderRequest,
} from "./provider-request";

const apiKey = process.env.ZAI_API_KEY?.trim();
const runLive = process.env.RUN_ZAI_TOKENIZER_CONTRACT === "1" && apiKey !== undefined;
const baseUrl = (process.env.ZAI_BASE_URL ?? "https://api.z.ai/api/coding/paas/v4").replace(
  /\/$/,
  "",
);

const baseRequest = {
  requestClass: "fast",
  requestedOutputTokens: 8,
  reasoning: "medium",
} as const;

const vectors = {
  plain_unicode: {
    messages: [{ role: "user", content: "Café e\u0301lan 👩🏽‍💻 中文 — line\r\nnext" }],
  },
  system_unicode: {
    messages: [
      { role: "system", content: "Réponds exactement; preserve NFC/NFD." },
      { role: "user", content: "Boundary: \u0000 replacement? Tabs\tand emoji 🧪." },
    ],
  },
  structured_tool: {
    messages: [
      { role: "system", content: "Return the forced structured result." },
      { role: "user", content: "Classify: solaire" },
    ],
    tools: [
      {
        name: "emit_classification",
        description: "Emit a structured classification.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["label", "confidence"],
          properties: {
            confidence: { type: "number" },
            label: { type: "string", enum: ["yes", "no"] },
          },
        },
      },
    ],
    toolChoice: "auto",
  },
  complete_tool_transcript: {
    messages: [
      { role: "system", content: "Use the supplied evidence." },
      { role: "user", content: "Inspect α." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_contract_1", name: "inspect", arguments: { id: "α", range: [0, 17] } },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_contract_1",
        name: "inspect",
        content: stableJson({ complete: true, text: "déjà vu\n第二行" }),
      },
    ],
    tools: [
      {
        name: "inspect",
        description: "Inspect an exact range.",
        parameters: {
          type: "object",
          required: ["id", "range"],
          properties: {
            id: { type: "string" },
            range: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 },
          },
        },
      },
    ],
    toolChoice: "auto",
  },
  ascii_tool_transcript: {
    messages: [
      { role: "user", content: "Inspect one." },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_ascii", name: "inspect", arguments: { id: "one" } }],
      },
      {
        role: "tool",
        toolCallId: "call_ascii",
        name: "inspect",
        content: '{"text":"one"}',
      },
    ],
    tools: [
      {
        name: "inspect",
        description: "Inspect.",
        parameters: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
    ],
  },
  parallel_tool_results: {
    messages: [
      { role: "user", content: "Inspect two." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_a", name: "inspect", arguments: { id: "a" } },
          { id: "call_b", name: "inspect", arguments: { id: "b" } },
        ],
      },
      { role: "tool", toolCallId: "call_a", name: "inspect", content: "A" },
      { role: "tool", toolCallId: "call_b", name: "inspect", content: "B" },
    ],
    tools: [
      {
        name: "inspect",
        description: "Inspect.",
        parameters: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
    ],
  },
  two_tool_turns: {
    messages: [
      { role: "user", content: "Inspect twice." },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "inspect", arguments: { id: "a" } }],
      },
      { role: "tool", toolCallId: "call_1", name: "inspect", content: "A" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_2", name: "inspect", arguments: { id: "b" } }],
      },
      { role: "tool", toolCallId: "call_2", name: "inspect", content: "B" },
    ],
    tools: [
      {
        name: "inspect",
        description: "Inspect.",
        parameters: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
    ],
  },
  three_tool_definitions: {
    messages: [{ role: "user", content: "Choose exactly one lookup." }],
    tools: [
      {
        name: "lookup_alpha",
        description: "Look up alpha.",
        parameters: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
      {
        name: "lookup_beta",
        description: "Look up beta.",
        parameters: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
      {
        name: "lookup_gamma",
        description: "Look up gamma.",
        parameters: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
    ],
    toolChoice: "auto",
  },
} as const satisfies Record<string, Omit<ProviderRequest, keyof typeof baseRequest | "model">>;

const toApiPayload = (request: ProviderRequest): Record<string, unknown> => {
  const transport = normalizeProviderRequest(request);
  const normalized = toGlmTemplateInput(transport);
  return {
    model: transport.model,
    messages: transport.messages.map((message) => {
      if (message.role === "assistant") {
        return {
          role: "assistant",
          content: message.content,
          ...(message.toolCalls === undefined
            ? {}
            : {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: stableJson(call.arguments) },
                })),
              }),
        };
      }
      if (message.role === "tool") {
        return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
      }
      return message;
    }),
    // toGlmTemplateInput mirrors Pi's provider-visible function object,
    // including `strict: false` for every definition.
    ...(normalized.tools.length === 0 ? {} : { tools: normalized.tools }),
    ...(transport.toolChoice === undefined
      ? {}
      : {
          tool_choice:
            typeof transport.toolChoice === "object"
              ? { type: "function", function: { name: transport.toolChoice.name } }
              : transport.toolChoice,
        }),
    thinking: { type: transport.reasoning === "minimal" ? "disabled" : "enabled" },
    ...(transport.model === "glm-5.2" && transport.reasoning !== "minimal"
      ? { reasoning_effort: "high" }
      : {}),
    max_tokens: transport.requestedOutputTokens,
    stream: false,
  };
};

const providerPromptTokens = async (request: ProviderRequest): Promise<number> => {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(toApiPayload(request)),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = (await response.json()) as {
    readonly usage?: { readonly prompt_tokens?: number | undefined } | undefined;
    readonly error?: { readonly message?: string | undefined } | undefined;
  };
  if (!response.ok || payload.usage?.prompt_tokens === undefined) {
    throw new Error(
      `Z.AI tokenizer contract request failed (${response.status}): ${payload.error?.message ?? "missing usage"}`,
    );
  }
  return payload.usage.prompt_tokens;
};

describe.skipIf(!runLive)("Z.AI exact tokenizer/provider-template parity", () => {
  for (const modelId of ["glm-5.2", "glm-5-turbo"] as const) {
    for (const [vectorName, vector] of Object.entries(vectors)) {
      it(`${modelId}: ${vectorName}`, async () => {
        const request = { ...baseRequest, ...vector, model: modelId } satisfies ProviderRequest;
        expect(await providerPromptTokens(request)).toBe(
          resolveUnverifiedModelForProviderContract(modelId).countRequestTokens(request),
        );
      }, 70_000);
    }
  }
});
