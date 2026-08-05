import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { assertResetAllowed } from "./reset";

const runWith = (env: Record<string, string>) =>
  Effect.runPromise(
    assertResetAllowed.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env,
          }),
        ),
      ),
    ),
  );

describe("database reset safety", () => {
  it("fails closed in production", async () => {
    await expect(runWith({ NODE_ENV: "production" })).rejects.toThrow(
      "Refusing to reset the database when NODE_ENV=production",
    );
  });

  it("requires the explicit production override and permits non-production", async () => {
    await expect(
      runWith({ NODE_ENV: "production", HARTLIB_ALLOW_DB_RESET: "true" }),
    ).resolves.toBeUndefined();
    await expect(runWith({ NODE_ENV: "test" })).resolves.toBeUndefined();
  });
});
