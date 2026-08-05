import { describe, expect, it } from "vitest";

import { e2eStreamGateIdFromMessage, e2eStreamGateLockKey, isE2eStreamGateId } from "./stream-gate";

describe("deterministic E2E stream gate", () => {
  it("extracts one bounded gate identity from the current message", () => {
    expect(e2eStreamGateIdFromMessage("before [e2e-stream-gate:reload_active-1] after")).toBe(
      "reload_active-1",
    );
    expect(isE2eStreamGateId("reload_active-1")).toBe(true);
    expect(e2eStreamGateLockKey("reload_active-1")).toBe(
      "hartlib:ai:e2e-stream-gate:reload_active-1",
    );
  });

  it("rejects malformed or unbounded control markers", () => {
    expect(e2eStreamGateIdFromMessage("[e2e-stream-gate:bad id]")).toBeNull();
    expect(e2eStreamGateIdFromMessage(`[e2e-stream-gate:${"a".repeat(81)}]`)).toBeNull();
    expect(isE2eStreamGateId("bad id")).toBe(false);
    expect(isE2eStreamGateId("a".repeat(81))).toBe(false);
  });
});
