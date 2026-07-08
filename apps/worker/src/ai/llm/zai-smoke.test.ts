import { streamSimple } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";

import { resolveZaiModel } from "./models";

const apiKey = process.env.ZAI_API_KEY;

describe.skipIf(!apiKey)("z.ai live smoke", () => {
  it(
    "streams one simple answer through the configured z.ai endpoint",
    { timeout: 60_000 },
    async () => {
      if (!apiKey) {
        return;
      }

      const model = resolveZaiModel({
        modelId: process.env.AI_MAIN_MODEL ?? "glm-5.2",
        baseUrl: process.env.AI_BASE_URL,
      });
      const stream = streamSimple(
        model,
        {
          systemPrompt: "Reply with exactly: ok",
          messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
        },
        {
          apiKey,
          maxRetries: 0,
          reasoning: "medium",
        },
      );

      for await (const _event of stream) {
      }

      const final = await stream.result();

      expect(final.stopReason).toBe("stop");
      expect(final.content.some((content) => content.type === "text")).toBe(true);
    },
  );
});
