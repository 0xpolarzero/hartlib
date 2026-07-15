import { describe, expect, it } from "vitest";

import { E2E_PORT_BASE_DEFAULT, e2ePortsFromBase, parseE2ePortBase } from "./ports";

describe("E2E port block", () => {
  it("uses the canonical default block", () => {
    expect(parseE2ePortBase(undefined)).toBe(E2E_PORT_BASE_DEFAULT);
    expect(parseE2ePortBase("")).toBe(E2E_PORT_BASE_DEFAULT);
    expect(e2ePortsFromBase(E2E_PORT_BASE_DEFAULT)).toEqual({
      api: 43_110,
      demo: 43_111,
      web: 43_112,
      objectStore: 43_113,
    });
  });

  it("maps an isolated override to four consecutive owned ports", () => {
    expect(e2ePortsFromBase(parseE2ePortBase("44000"))).toEqual({
      api: 44_000,
      demo: 44_001,
      web: 44_002,
      objectStore: 44_003,
    });
  });

  it.each([" ", "1.5", "+44000", "-44000", "0xabe0", "44000 "])(
    "rejects a non-decimal override %j",
    (raw) => {
      expect(() => parseE2ePortBase(raw)).toThrow("BRIEF_E2E_PORT_BASE must be a decimal integer");
    },
  );

  it.each(["1023", "65533", "999999999999999999999999"])(
    "rejects an out-of-range override %s",
    (raw) => {
      expect(() => parseE2ePortBase(raw)).toThrow(
        "BRIEF_E2E_PORT_BASE must be a safe integer between 1024 and 65532",
      );
    },
  );
});
