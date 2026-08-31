import { describe, expect, it } from "vitest";

import { isDocsPath } from "./docs-path";

describe("docs path", () => {
  it("recognizes only the exact standalone docs path", () => {
    expect(isDocsPath("/docs")).toBe(true);
    expect(isDocsPath("/docs/")).toBe(false);
  });

  it("does not reserve localized or nested docs paths", () => {
    expect(isDocsPath("/en-US/docs")).toBe(false);
    expect(isDocsPath("/fr-FR/docs")).toBe(false);
    expect(isDocsPath("/docs/reference")).toBe(false);
  });
});
