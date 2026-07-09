import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decodeAppEnv } from "./index";

describe("decodeAppEnv", () => {
  it("decodes a demo environment without unrelated auth or billing secrets", async () => {
    const env = await Effect.runPromise(
      decodeAppEnv({
        NODE_ENV: "development",
        APP_BASE_URL: "http://localhost:3000",
        DATABASE_URL: "postgres://brief:brief@localhost:5432/brief",
      }),
    );

    expect(env.CLERK_SECRET_KEY).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.ZAI_API_KEY).toBe("");
    expect(env.AI_MAIN_MODEL).toBe("glm-5.2");
    expect(env.AI_STREAM_POLL_MS).toBe("300");
  });
});
