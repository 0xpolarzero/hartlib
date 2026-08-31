import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { loadApiConfig, PRODUCTION_DECISIONS_BLOCKER } from "./config";

const loadFrom = (env: Record<string, string>) =>
  Effect.runPromise(
    loadApiConfig.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))),
  );

describe("API configuration", () => {
  it("infers Tinyfish capability from its dedicated key without retaining the credential", async () => {
    await expect(loadFrom({})).resolves.toMatchObject({ webResearchProvider: null });

    const config = await loadFrom({ TINYFISH_API_KEY: "tinyfish-secret" });
    expect(config).toMatchObject({ webResearchProvider: "tinyfish", aiWebMaxDomainFilters: 8 });
    expect(config).not.toHaveProperty("tinyfishApiKey");
    expect(config).not.toHaveProperty("webResearchApiKey");
  });

  it.each(["0", "33", "1.5"])("rejects unsafe web domain fanout %s", async (value) => {
    await expect(loadFrom({ AI_WEB_MAX_DOMAIN_FILTERS: value })).rejects.toThrow(
      "AI_WEB_MAX_DOMAIN_FILTERS must be an integer between 1 and 32",
    );
  });

  it("uses one sanitized blocker while production decisions are unresolved", async () => {
    const secret = "must-not-appear-in-an-error";
    const result = await loadFrom({
      NODE_ENV: "production",
      ZAI_API_KEY: secret,
      TINYFISH_API_KEY: secret,
      DATABASE_URL: `postgres://hartlib:${secret}@db.example/hartlib`,
    }).then(
      () => null,
      (error: unknown) => String(error),
    );

    expect(result).toContain(PRODUCTION_DECISIONS_BLOCKER);
    expect(result).not.toContain(secret);
  });
});
