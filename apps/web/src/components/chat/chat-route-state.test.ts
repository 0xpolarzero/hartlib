import { describe, expect, it } from "vitest";

import { chatForRoute, conflictBelongsToRoute } from "./chat-route-state";

describe("chat route state", () => {
  it("does not expose the prior chat while an owner navigates to another chat", () => {
    const previous = { canWrite: true } as const;

    expect(chatForRoute("shared-chat", "owned-chat", previous)).toBeNull();
    expect(chatForRoute("owned-chat", "owned-chat", previous)).toBe(previous);
  });

  it("does not replay a user-scoped conflict into the destination chat", () => {
    const conflict = { chatId: "owned-chat" } as const;

    expect(conflictBelongsToRoute("shared-chat", conflict)).toBe(false);
    expect(conflictBelongsToRoute("owned-chat", conflict)).toBe(true);
  });
});
