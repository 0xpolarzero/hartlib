import { describe, expect, it } from "vitest";

import { chatFailureMessageId } from "./virtualized-chat-transcript";

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
