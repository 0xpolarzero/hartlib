import { describe, expect, it } from "vitest";

import { chatComposerEnabled, chatIsArchived } from "./chat-permissions";

const projection = (canWrite: boolean, archivedAt: string | null) =>
  ({
    canWrite,
    chat: { archivedAt },
  }) satisfies NonNullable<Parameters<typeof chatComposerEnabled>[0]>;

describe("chat composer permissions", () => {
  it.each([
    { canWrite: true, archivedAt: null, expected: true },
    { canWrite: false, archivedAt: null, expected: false },
    { canWrite: true, archivedAt: "2026-07-11T00:00:00.000Z", expected: false },
    { canWrite: false, archivedAt: "2026-07-11T00:00:00.000Z", expected: false },
  ] as const)(
    "returns $expected when canWrite is $canWrite and archivedAt is $archivedAt",
    ({ canWrite, archivedAt, expected }) => {
      expect(chatComposerEnabled(projection(canWrite, archivedAt))).toBe(expected);
    },
  );

  it("disables the composer until a chat projection exists", () => {
    expect(chatComposerEnabled(null)).toBe(false);
  });

  it("distinguishes archived history from an active read-only chat", () => {
    const active = { chat: { archivedAt: null } };
    const archived = {
      chat: { archivedAt: "2026-07-11T00:00:00.000Z" },
    };
    expect(chatIsArchived(active)).toBe(false);
    expect(chatIsArchived(archived)).toBe(true);
  });
});
