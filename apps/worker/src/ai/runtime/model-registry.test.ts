import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  exactProviderRequestGate,
  renderOfficialGlmProviderRequest,
  resolveRegisteredModel,
  resolveRuntimeModel,
  verifyRegisteredModelsAtStartup,
} from "./model-registry";
import {
  normalizeProviderRequest,
  providerRequestSha256Hex,
  stableJson,
  toGlmTemplateInput,
  type ProviderRequest,
} from "./provider-request";

const request = {
  requestClass: "fast",
  model: "glm-5-turbo",
  messages: [
    { role: "system", content: "Be exact." },
    { role: "user", content: "Bonjour" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "search_internal", arguments: { terms: "solar" } }],
    },
    { role: "tool", toolCallId: "call-1", name: "search_internal", content: '{"items":[]}' },
  ],
  tools: [
    {
      name: "search_internal",
      description: "Search",
      parameters: { type: "object", properties: { terms: { type: "string" } } },
    },
  ],
  toolChoice: "auto",
  requestedOutputTokens: 64,
  reasoning: "medium",
} as const satisfies ProviderRequest;

describe("exact provider-shaped request gate", () => {
  it.each([
    ["system", [{ role: "system", content: "System policy." }], 15, 8],
    ["user", [{ role: "user", content: "Bonjour le monde." }], 16, 9],
    ["assistant", [{ role: "assistant", content: "A complete answer." }], 18, 10],
    [
      "tool observation",
      [
        {
          role: "tool",
          toolCallId: "call-7",
          name: "inspect_internal",
          content: '{"text":"Evidence"}',
        },
      ],
      19,
      12,
    ],
  ] as const)("has a golden token count for the %s role", (_name, messages, main, fast) => {
    for (const [modelId, expected] of [
      ["glm-5.2", main],
      ["glm-5-turbo", fast],
    ] as const) {
      expect(
        resolveRegisteredModel(modelId).countRequestTokens({
          requestClass: "fast",
          model: modelId,
          messages,
          requestedOutputTokens: 64,
          reasoning: "medium",
        }),
      ).toBe(expected);
    }
  });

  it("has a golden count for the complete accumulated tool transcript", () => {
    const withSchema = {
      ...request,
      responseSchema: {
        type: "object",
        required: ["answer"],
        properties: { answer: { type: "string" } },
      },
    } as const satisfies ProviderRequest;
    const main = resolveRegisteredModel("glm-5.2");
    const fast = resolveRegisteredModel("glm-5-turbo");
    expect(main.countRequestTokens({ ...withSchema, model: "glm-5.2" })).toBe(195);
    expect(fast.countRequestTokens(withSchema)).toBe(202);
    expect(renderOfficialGlmProviderRequest(request, "glm-5.2")).toContain("<tool_call>");
    expect(renderOfficialGlmProviderRequest(request, "glm-5.2")).toContain("<|observation|>");
  });

  it.each([
    ["glm-5.2", [17, 156, 242]],
    ["glm-5-turbo", [10, 163, 277]],
  ] as const)(
    "pins %s counts for zero, one, and three Pi function definitions",
    (modelId, expected) => {
      const definitions = ["alpha", "beta", "gamma"].map((id) => ({
        name: `lookup_${id}`,
        description: `Look up ${id}.`,
        parameters: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      }));
      const base = {
        requestClass: "fast",
        model: modelId,
        messages: [{ role: "user", content: "Choose exactly one lookup." }],
        toolChoice: "auto",
        requestedOutputTokens: 8,
        reasoning: "medium",
      } as const satisfies ProviderRequest;
      const model = resolveRegisteredModel(modelId);
      const requests = [
        base,
        { ...base, tools: definitions.slice(0, 1) },
        { ...base, tools: definitions },
      ] satisfies readonly ProviderRequest[];

      expect(requests.map((candidate) => model.countRequestTokens(candidate))).toEqual(expected);
    },
  );

  it("normalizes and hashes Pi's provider-visible strict field for every function", () => {
    const normalized = normalizeProviderRequest(request);
    expect(normalized.tools?.map((tool) => tool.strict)).toEqual([false]);
    expect(toGlmTemplateInput(request).tools.map((tool) => tool.function.strict)).toEqual([false]);
    expect(providerRequestSha256Hex(request)).toBe(
      createHash("sha256").update(stableJson(normalized)).digest("hex"),
    );
  });

  it("canonicalizes multiple systems into the same single provider prompt counted by the gate", () => {
    const multipleSystems = {
      ...request,
      messages: [
        { role: "system", content: "First" },
        { role: "user", content: "Question" },
        { role: "system", content: "Second" },
      ],
      responseSchema: { required: ["answer"], type: "object" },
    } as const satisfies ProviderRequest;
    const normalized = normalizeProviderRequest(multipleSystems);
    expect(normalized.messages).toEqual([
      {
        role: "system",
        content:
          'First\n\nSecond\n\nReturn JSON matching this exact response schema:\n{"required":["answer"],"type":"object"}',
      },
      { role: "user", content: "Question" },
    ]);
    expect(resolveRegisteredModel("glm-5-turbo").countRequestTokens(multipleSystems)).toBe(
      resolveRegisteredModel("glm-5-turbo").countRequestTokens(normalized),
    );
  });

  it("omits empty assistant correction turns exactly as Pi omits them before transport", () => {
    const withoutEmptyTurns = {
      ...request,
      messages: [
        { role: "system" as const, content: "Be exact." },
        { role: "user" as const, content: "Bonjour" },
      ],
    } satisfies ProviderRequest;
    const withEmptyTurns = {
      ...withoutEmptyTurns,
      messages: [
        ...withoutEmptyTurns.messages,
        { role: "assistant" as const, content: "", toolCalls: [] },
        { role: "assistant" as const, content: "  \n", toolCalls: [] },
      ],
    } satisfies ProviderRequest;

    expect(normalizeProviderRequest(withEmptyTurns).messages).toEqual(
      normalizeProviderRequest(withoutEmptyTurns).messages,
    );
    expect(resolveRegisteredModel("glm-5-turbo").countRequestTokens(withEmptyTurns)).toBe(
      resolveRegisteredModel("glm-5-turbo").countRequestTokens(withoutEmptyTurns),
    );
  });

  it("gates input plus explicit requested output against both limits", () => {
    const model = resolveRegisteredModel("glm-5.2");
    const modelRequest = { ...request, model: "glm-5.2" } satisfies ProviderRequest;
    const measurement = exactProviderRequestGate(modelRequest, model, {
      inputTokens: 100_000,
      outputTokens: 16_384,
    });
    expect(measurement.passed).toBe(true);
    expect(measurement.requestedOutputTokens).toBe(64);
    expect(() =>
      exactProviderRequestGate({ ...modelRequest, requestedOutputTokens: 16_385 }, model, {
        inputTokens: 100_000,
        outputTokens: 16_384,
      }),
    ).toThrow(/output allowance/);
  });

  it.each([
    ["glm-5.2", 169],
    ["glm-5-turbo", 176],
  ] as const)("gates %s exactly at limit - 1, limit, and limit + 1", (modelId, expected) => {
    const model = resolveRegisteredModel(modelId);
    const modelRequest = { ...request, model: modelId } satisfies ProviderRequest;
    const exactInput = model.countRequestTokens(modelRequest);
    expect(exactInput).toBe(expected);

    expect(() =>
      exactProviderRequestGate(modelRequest, model, {
        inputTokens: exactInput - 1,
        outputTokens: 64,
      }),
    ).toThrow(new RegExp(`only ${exactInput - 1} fit`));
    expect(
      exactProviderRequestGate(modelRequest, model, {
        inputTokens: exactInput,
        outputTokens: 64,
      }).passed,
    ).toBe(true);
    expect(
      exactProviderRequestGate(modelRequest, model, {
        inputTokens: exactInput + 1,
        outputTokens: 64,
      }).passed,
    ).toBe(true);
  });

  it("verifies both parity-proven default registry models at startup", () => {
    expect(verifyRegisteredModelsAtStartup().map((model) => model.id)).toEqual([
      "glm-5.2",
      "glm-5-turbo",
    ]);
  });

  it("rejects unregistered models at startup", () => {
    expect(() => resolveRegisteredModel("glm-unknown")).toThrow(/no pinned exact tokenizer/);
  });

  it("keeps the historical model available only through the compatibility resolver", () => {
    expect(resolveRuntimeModel("glm-5-turbo").id).toBe("glm-5-turbo");
    expect(() => resolveRuntimeModel("glm-5.2")).toThrow(/evaluation\/compatibility-only/);
    expect(resolveRegisteredModel("glm-5.2").id).toBe("glm-5.2");
  });

  it.each(["glm-5.2", "glm-5-turbo"] as const)(
    "property: %s exact gating is monotone and equivalent to the registered inequality",
    (modelId) => {
      const model = resolveRegisteredModel(modelId);
      const modelRequest = { ...request, model: modelId } satisfies ProviderRequest;
      const exactInput = model.countRequestTokens(modelRequest);
      let state = modelId === "glm-5.2" ? 0x52_52_52_52 : 0x50_50_50_50;
      const next = (): number => {
        state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
        return state;
      };

      for (let example = 0; example < 250; example += 1) {
        const requestedOutputTokens = 1 + (next() % 1_024);
        const inputLimit = Math.max(0, exactInput - 20 + (next() % 41));
        const limits = { inputTokens: inputLimit, outputTokens: 1_024 };
        const usable = Math.min(inputLimit, model.contextWindow - requestedOutputTokens);
        const shouldPass = exactInput <= usable;

        if (shouldPass) {
          const measurement = exactProviderRequestGate(
            { ...modelRequest, requestedOutputTokens },
            model,
            limits,
          );
          expect(measurement.passed).toBe(true);
          expect(measurement.inputTokens).toBe(exactInput);
          expect(measurement.usableInputTokens).toBe(usable);
          expect(
            exactProviderRequestGate({ ...modelRequest, requestedOutputTokens }, model, {
              ...limits,
              inputTokens: inputLimit + 1,
            }).passed,
          ).toBe(true);
        } else {
          expect(() =>
            exactProviderRequestGate({ ...modelRequest, requestedOutputTokens }, model, limits),
          ).toThrow(/only .* fit/u);
        }
      }
    },
  );
});
