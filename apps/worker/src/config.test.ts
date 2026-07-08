import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ZAI_CODING_PLAN_BASE_URL } from "./ai/llm/models";
import { loadWorkerConfig } from "./config";

const loadConfigFrom = (env: Record<string, string | undefined>) =>
  Effect.runPromise(
    Effect.provide(
      loadWorkerConfig,
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: Object.fromEntries(
            Object.entries(env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
        }),
      ),
    ),
  );

describe("worker config", () => {
  it("defaults AI_BASE_URL to the z.ai coding-plan endpoint", async () => {
    const config = await loadConfigFrom({});

    expect(config.aiBaseUrl).toBe(ZAI_CODING_PLAN_BASE_URL);
  });

  it("keeps AI_BASE_URL overridable and treats blank as unset", async () => {
    await expect(loadConfigFrom({ AI_BASE_URL: "https://zai.example/v4" })).resolves.toMatchObject({
      aiBaseUrl: "https://zai.example/v4",
    });
    await expect(loadConfigFrom({ AI_BASE_URL: "" })).resolves.toMatchObject({
      aiBaseUrl: ZAI_CODING_PLAN_BASE_URL,
    });
  });
});
