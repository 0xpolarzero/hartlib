import { describe, expect, it } from "vitest";
import { defaultLayout, normalizeLayout } from "./layout-state";

describe("demo layout state", () => {
  it("clamps persisted panel widths and accepts the mobile visualization tab", () => {
    expect(normalizeLayout({ leftWidth: 10, rightWidth: 900, mobileTab: "visualization" })).toEqual(
      { ...defaultLayout, leftWidth: 220, rightWidth: 480, mobileTab: "visualization" },
    );
  });
  it("rejects malformed persisted values", () => {
    expect(normalizeLayout(null)).toEqual(defaultLayout);
    expect(normalizeLayout({ mobileTab: "unknown" })).toEqual(defaultLayout);
  });
});
