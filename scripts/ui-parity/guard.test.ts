import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { completeProtectedGuard, guardProtectedPaths } from "./guard";

describe("protected parity guard", () => {
  it("reports a protected file changed during capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "hartlib-ui-parity-guard-"));
    const protectedFile = join(root, "reference.txt");
    await writeFile(protectedFile, "before", "utf8");

    const before = await guardProtectedPaths(root, ["reference.txt"]);
    await writeFile(protectedFile, "after", "utf8");
    const after = await completeProtectedGuard(root, before);

    expect(after.unchanged).toBe(false);
    expect(after.mismatches).toContain("reference.txt: changed during capture");
  });
});
