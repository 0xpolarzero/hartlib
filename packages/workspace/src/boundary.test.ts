import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const adapters = [
  "apps/api/src/domain/client-workspace.ts",
  "apps/api/src/domain/publisher-workspace.ts",
  "apps/api/src/domain/workspace-memberships.ts",
  "apps/api/src/domain/publisher-onboarding.ts",
] as const;

describe("workspace package boundary", () => {
  it.each(adapters)("keeps %s as a typed HTTP/auth adapter", async (file) => {
    const source = await readFile(new URL(`../../../${file}`, import.meta.url), "utf8");

    expect(source).toContain('from "@hartlib/workspace"');
    expect(source).not.toMatch(/\bsql(?:<|`|\.)/u);
    expect(source).not.toContain("withTransaction");
    expect(source).not.toMatch(/request\.(?:arrayBuffer|json|text|formData|headers)/u);
    expect(source).not.toContain("searchParams");
    expect(source).not.toContain("JSON.parse");
    expect(source).not.toContain("Schema.decode");
    expect(source).not.toMatch(/from "\.\.\/authorization"/u);
    expect(source).not.toMatch(/append(?:Denied)?AuthorizationAudit/u);
  });
});
