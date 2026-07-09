import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decodeAppEnv } from "./index";

describe("decodeAppEnv", () => {
  it.each([
    ["AI_CONTEXT_BLOCK_BUDGET", "60000"],
    ["AI_CONTEXT_BLOCK_HARD_CAP", "100000"],
    ["AI_FULL_DOC_MAX_CHARS", "12000"],
    ["AI_HISTORY_MAX_MESSAGES", "30"],
    ["AI_PREFLIGHT_HISTORY_MESSAGES", "6"],
    ["AI_PREFLIGHT_MAX_TURNS", "4"],
    ["AI_PREFLIGHT_MAX_SEARCHES", "8"],
    ["AI_PREFLIGHT_MAX_PEEKS", "4"],
    ["AI_PREFLIGHT_TIMEOUT_MS", "30000"],
    ["AI_ANSWER_TIMEOUT_MS", "120000"],
    ["AI_SEARCH_MAX_LIMIT", "20"],
    ["AI_SEARCH_RECENCY_HALF_LIFE_DAYS", "14"],
    ["AI_STREAM_POLL_MS", "300"],
    ["AI_STREAM_KEEPALIVE_MS", "15000"],
    ["AI_MEMORY_MAX_WRITES_PER_TURN", "5"],
    ["AI_MEMORY_INJECT_ALL_MAX_TOKENS", "1500"],
    ["AI_PLANNER_BASELINE", "false"],
  ] as const)("defaults %s to %s", async (key, expected) => {
    const env = await Effect.runPromise(
      decodeAppEnv({
        NODE_ENV: "development",
        APP_BASE_URL: "http://localhost:3000",
        DATABASE_URL: "postgres://brief:brief@localhost:5432/brief",
      }),
    );

    expect(env[key]).toBe(expected);
  });

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
