import { describe, expect, it } from "vitest";

import {
  chatFailureMessageId,
  chatProgressStages,
  isChatTranscriptNearBottom,
} from "./virtualized-chat-transcript";

describe("chat failure localization", () => {
  it.each([
    "workflow_resume_incompatible",
    "context_compaction_failed",
    "context_assembly_failed",
    "context_plan_unfit",
    "memory_conflict",
  ])("maps canonical code %s to its exact catalog key", (code) =>
    expect(chatFailureMessageId(code)).toBe(`chat.failure.${code}`),
  );

  it.each(["workflow_incompatible"])(
    "uses the generic fallback for unknown historical code %s",
    (code) => expect(chatFailureMessageId(code)).toBe("chat.failure.generic"),
  );
});

describe("chat progress and transcript anchoring", () => {
  it("keeps the compact rail separate from the full diagnostic history", () => {
    const running = {
      type: "activity" as const,
      stage: "evidence" as const,
      code: "internal_sources" as const,
      status: "running" as const,
    };
    const complete = { ...running, status: "complete" as const };
    expect(chatProgressStages([complete])).toEqual([{ stage: "evidence", status: "complete" }]);
    expect(chatProgressStages([{ ...running, status: "retrying" }])).toEqual([
      { stage: "evidence", status: "retrying" },
    ]);
    expect([running, complete]).toHaveLength(2);
  });

  it("sticks only near the bottom, so growth does not yank a scrolled-up viewer", () => {
    expect(
      isChatTranscriptNearBottom({ scrollHeight: 1000, scrollTop: 752, clientHeight: 200 }),
    ).toBe(true);
    expect(
      isChatTranscriptNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 200 }),
    ).toBe(false);
  });
});
