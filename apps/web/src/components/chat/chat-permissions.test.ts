import { describe, expect, it } from "vitest";

import { chatComposerEnabled } from "./chat-permissions";

describe("chat composer permissions", () => {
  it("allows only the authoritative writer", () => {
    expect(chatComposerEnabled({ canWrite: true })).toBe(true);
    expect(chatComposerEnabled({ canWrite: false })).toBe(false);
    expect(chatComposerEnabled(null)).toBe(false);
  });
});
