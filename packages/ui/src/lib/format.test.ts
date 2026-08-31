import { describe, expect, it } from "vitest";
import { formatBytes } from "./format";

describe("formatBytes", () => {
  it("uses locale-correct byte units", () => {
    expect(formatBytes("en-US", 1_000)).toBe("1 kB");
    expect(formatBytes("en-US", 1_000_000)).toBe("1 MB");
    expect(formatBytes("fr-FR", 1_000)).toBe("1 Ko");
    expect(formatBytes("fr-FR", 1_000_000)).toBe("1 Mo");
  });
});
