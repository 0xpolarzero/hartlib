import type { AiRunActivityEvent } from "@hartlib/ui";

import { describe, expect, it } from "vitest";

import { failedChatUxRunFixture, successfulChatUxRunFixture } from "./chat-ux-run.fixture";

describe("chat UX captured run fixtures", () => {
  it("contains a completed live answer grounded in one internal and one web source", () => {
    const activities: readonly AiRunActivityEvent[] = successfulChatUxRunFixture.activities;
    expect(successfulChatUxRunFixture.captureMode).toBe("completed");
    expect(successfulChatUxRunFixture.answer).toContain("25.3 GW");
    expect(successfulChatUxRunFixture.answer).toContain("[1]");
    expect(successfulChatUxRunFixture.answer).toContain("[2]");
    expect(successfulChatUxRunFixture.citations).toHaveLength(2);
    expect(successfulChatUxRunFixture.sourcesRead.map((source) => source.kind)).toEqual([
      "document",
      "web",
    ]);
    expect(new Set(activities.map((activity) => activity.stage))).toEqual(
      new Set(["understanding", "evidence", "preparing", "writing", "finishing"]),
    );
    expect(activities.some((activity) => activity.detail?.kind === "internal_queries")).toBe(true);
    expect(activities.some((activity) => activity.detail?.kind === "web_search")).toBe(true);
    expect(
      activities.some(
        (activity) => activity.code === "finalization" && activity.status === "complete",
      ),
    ).toBe(true);
  });

  it("contains a terminal live failure with its retry history", () => {
    const activities: readonly AiRunActivityEvent[] = failedChatUxRunFixture.run.activities;
    expect(failedChatUxRunFixture.captureMode).toBe("failed");
    expect(failedChatUxRunFixture.run.status).toBe("failed");
    expect(failedChatUxRunFixture.run.errorCode).toBe("web_research_failed");
    expect(activities.some((activity) => activity.status === "retrying")).toBe(true);
    expect(activities.some((activity) => activity.detail?.kind === "web_search")).toBe(true);
    expect(
      activities.some(
        (activity) => activity.code === "web_research" && activity.status === "failed",
      ),
    ).toBe(true);
  });
});
