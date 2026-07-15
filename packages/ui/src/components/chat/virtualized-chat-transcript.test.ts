import { describe, expect, it } from "vitest";

import { chatFailureMessageId } from "./virtualized-chat-transcript";

describe("chat failure localization", () => {
  it.each(["workflow_resume_incompatible", "context_assembly_failed", "memory_conflict"])(
    "maps canonical code %s to its exact catalog key",
    (code) => expect(chatFailureMessageId(code)).toBe(`chat.failure.${code}`),
  );

  it("does not retain the obsolete workflow code", () => {
    expect(chatFailureMessageId("workflow_incompatible")).toBe("chat.failure.generic");
  });
});
