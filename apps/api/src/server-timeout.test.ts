import { describe, expect, it } from "vitest";

import { shouldDisableRequestIdleTimeout } from "./server-timeout";

describe("shouldDisableRequestIdleTimeout", () => {
  it.each([
    "http://localhost/v1/ai-runs/run-1/stream",
    "https://api.brief.test/v1/ai-runs/run%2D1/stream?afterSeq=2",
  ])("disables Bun's request idle timeout for the canonical SSE route %s", (url) => {
    expect(shouldDisableRequestIdleTimeout(new Request(url))).toBe(true);
  });

  it.each([
    ["POST", "http://localhost/v1/ai-runs/run-1/stream"],
    ["GET", "http://localhost/v1/ai-runs//stream"],
    ["GET", "http://localhost/v1/ai-runs/run-1/stream/extra"],
    ["GET", "http://localhost/v1/chat"],
  ])("retains the bounded server timeout for %s %s", (method, url) => {
    expect(shouldDisableRequestIdleTimeout(new Request(url, { method }))).toBe(false);
  });
});
