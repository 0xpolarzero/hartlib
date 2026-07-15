import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ZAI_CODING_PLAN_BASE_URL } from "./ai/runtime/model-registry";
import {
  assertWorkerAiProviderPosture,
  loadWorkerConfig,
  PRODUCTION_DECISIONS_BLOCKER,
} from "./config";

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
    ["jobPollIntervalMs", 5_000],
    ["workerConcurrency", 2],
    ["publicSourcePollIntervalMs", 300_000],
    ["publicSourceStartupBackfillDays", 7],
    ["publicSourceOperationTimeoutMs", 60_000],
    ["aiMainInputMaxTokens", 100_000],
    ["aiMainOutputMaxTokens", 16_384],
    ["aiFastInputMaxTokens", 100_000],
    ["aiFastOutputMaxTokens", 16_384],
    ["aiConversationRecentTurns", 12],
    ["aiFanoutMaxTopics", 3],
    ["aiTopicResearchMaxConcurrency", 6],
    ["aiTopicAnswerMaxConcurrency", 3],
    ["aiRetrievalMaxTurns", 7],
    ["aiInternalMaxSearches", 8],
    ["aiInternalMaxInspections", 8],
    ["aiWebMaxSearches", 4],
    ["aiWebMaxFetches", 8],
    ["aiWebMaxDomainFilters", 8],
    ["aiContextReductionMaxIterations", 2],
    ["aiMemoryDirectMaxItems", 200],
    ["aiMemoryToolResultMaxItems", 50],
    ["aiFastTaskTimeoutMs", 300_000],
    ["aiAnswerTimeoutMs", 120_000],
    ["aiStreamPollMs", 300],
    ["aiStreamKeepaliveMs", 15_000],
  ] as const)("defaults %s to %s", async (key, expected) => {
    const config = await loadConfigFrom({});
    expect(config[key]).toBe(expected);
  });

  it("uses the canonical model and runtime defaults", async () => {
    await expect(loadConfigFrom({})).resolves.toMatchObject({
      aiBaseUrl: ZAI_CODING_PLAN_BASE_URL,
      aiMainModel: "glm-5-turbo",
      aiFastModel: "glm-5-turbo",
      publicSourceIngestionEnabled: true,
      runMigrationsOnStartup: true,
    });
  });

  it.each(["0", "33", "1.5"])("rejects unsafe web domain fanout %s", async (value) => {
    await expect(loadConfigFrom({ AI_WEB_MAX_DOMAIN_FILTERS: value })).rejects.toThrow(
      "AI_WEB_MAX_DOMAIN_FILTERS must be an integer between 1 and 32",
    );
  });

  it("infers non-production Tinyfish availability from its dedicated key", async () => {
    await expect(loadConfigFrom({})).resolves.toMatchObject({
      webResearchProvider: "",
      tinyfishApiKey: "",
    });
    await expect(loadConfigFrom({ TINYFISH_API_KEY: "tinyfish-key" })).resolves.toMatchObject({
      webResearchProvider: "tinyfish",
      tinyfishApiKey: "tinyfish-key",
    });
  });

  it("disables implicit production migrations", async () => {
    const config = await loadConfigFrom({ NODE_ENV: "production" });
    expect(config).toMatchObject({ runMigrationsOnStartup: false });
    expect(config.webResearchProvider).toBe("");
    expect(() => assertWorkerAiProviderPosture(config)).toThrow(PRODUCTION_DECISIONS_BLOCKER);
  });

  it("verifies the exact demo model registry before worker startup", async () => {
    const config = await loadConfigFrom({});
    expect(() => assertWorkerAiProviderPosture(config)).not.toThrow();
    expect(() =>
      assertWorkerAiProviderPosture({ ...config, aiMainModel: "unregistered-model" } as never),
    ).toThrow("has no pinned exact tokenizer and chat template");
  });

  it.each([
    ["aiMainModel", { aiMainModel: "glm-5.2" }],
    ["aiFastModel", { aiFastModel: "glm-5.2" }],
  ] as const)("rejects historical %s overrides for live startup", async (_role, override) => {
    const config = await loadConfigFrom({});
    expect(() => assertWorkerAiProviderPosture({ ...config, ...override } as never)).toThrow(
      /evaluation\/compatibility-only/,
    );
  });

  it("keeps AI_BASE_URL overridable and treats blank as unset", async () => {
    await expect(loadConfigFrom({ AI_BASE_URL: "https://zai.example/v4" })).resolves.toMatchObject({
      aiBaseUrl: "https://zai.example/v4",
    });
    await expect(loadConfigFrom({ AI_BASE_URL: "" })).resolves.toMatchObject({
      aiBaseUrl: ZAI_CODING_PLAN_BASE_URL,
    });
  });

  it.each([
    "http://api.z.ai/v4",
    "https://user:secret@api.z.ai/v4",
    "https://api.z.ai/v4?api_key=secret",
    "https://api.z.ai/v4#fragment",
    "not-a-url",
  ])("rejects unsafe model provider base URL %s", async (value) => {
    await expect(loadConfigFrom({ AI_BASE_URL: value })).rejects.toThrow(
      "AI_BASE_URL must be an HTTPS URL without credentials or query data",
    );
  });
});
