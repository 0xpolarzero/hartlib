import { describe, expect, it } from "vitest";

import { buildCreateChatInput } from "./chat-form";

describe("chat creation source form", () => {
  it.each(["private_owner", "disabled"] as const)(
    "preserves the exact selected source order for %s chats",
    (memoryMode) => {
      expect(buildCreateChatInput("company-1", memoryMode, ["access-2", "access-1"])).toEqual({
        companyId: "company-1",
        memoryMode,
        sourceAccessIds: ["access-2", "access-1"],
      });
    },
  );

  it("allows the user to explicitly uncheck every source", () => {
    expect(buildCreateChatInput("company-1", "disabled", [])).toMatchObject({
      sourceAccessIds: [],
    });
  });

  it("rejects duplicate source access identifiers before the API boundary", () => {
    expect(() =>
      buildCreateChatInput("company-1", "private_owner", ["access-1", "access-1"]),
    ).toThrow("chat_sources_must_be_unique");
  });
});
