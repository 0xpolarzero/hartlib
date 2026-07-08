import { describe, expect, it } from "vitest";

import { resolveZaiModel } from "./models";

describe("resolveZaiModel", () => {
  it("resolves z.ai catalog metadata and applies an explicit baseUrl override", () => {
    const model = resolveZaiModel({
      modelId: "glm-5.2",
      baseUrl: "https://zai.example/v4",
    });

    expect(model.id).toBe("glm-5.2");
    expect(model.provider).toBe("zai");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("https://zai.example/v4");
    expect(model.contextWindow).toBe(1_000_000);
    expect(model.maxTokens).toBe(131_072);
    expect(model.reasoning).toBe(true);

    expect(model.compat?.thinkingFormat).toBe("zai");
  });
});
