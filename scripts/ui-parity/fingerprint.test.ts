import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertFingerprintUnchanged, fingerprintTree } from "./fingerprint";

describe("protected reference fingerprint", () => {
  it("is stable for an unchanged tree", () => {
    const root = mkdtempSync(join(tmpdir(), "hartlib-parity-tree-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "main.ts"), "export {}\n");
    const before = fingerprintTree(root);
    const after = fingerprintTree(root);
    expect(after).toEqual(before);
    expect(() => assertFingerprintUnchanged(before, after)).not.toThrow();
  });

  it("fails when a protected file changes", () => {
    const root = mkdtempSync(join(tmpdir(), "hartlib-parity-tree-"));
    const path = join(root, "main.ts");
    writeFileSync(path, "export {}\n");
    const before = fingerprintTree(root);
    writeFileSync(path, "export const changed = true\n");
    const after = fingerprintTree(root);
    expect(() => assertFingerprintUnchanged(before, after)).toThrow(/Protected tree changed/u);
  });
});
