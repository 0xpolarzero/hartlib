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
  it.each([
    ["workerConcurrency", 2],
    ["aiContextBlockBudget", 60_000],
    ["aiContextBlockHardCap", 100_000],
    ["aiFullDocMaxChars", 12_000],
    ["aiHistoryMaxMessages", 30],
    ["aiPreflightHistoryMessages", 6],
    ["aiPreflightMaxTurns", 4],
    ["aiPreflightMaxSearches", 8],
    ["aiPreflightMaxPeeks", 4],
    ["aiPreflightTimeoutMs", 30_000],
    ["aiAnswerTimeoutMs", 120_000],
    ["aiSearchMaxLimit", 20],
    ["aiSearchRecencyHalfLifeDays", 14],
    ["aiStreamPollMs", 300],
    ["aiMemoryInjectAllMaxTokens", 1500],
  ] as const)("defaults %s to %s", async (key, expected) => {
    const config = await loadConfigFrom({});

    expect(config[key]).toBe(expected);
  });

  it("defaults AI_PLANNER_BASELINE to false", async () => {
    const config = await loadConfigFrom({});

    expect(config.aiPlannerBaseline).toBe(false);
  });

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
