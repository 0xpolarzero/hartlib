import { describe, expect, it } from "vitest";

import { isDocsPath } from "./docs-path";

describe("docs path", () => {
  it("recognizes both standalone docs paths", () => {
    expect(isDocsPath("/docs")).toBe(true);
    expect(isDocsPath("/docs/")).toBe(true);
  });

  it("does not reserve localized or nested docs paths", () => {
    expect(isDocsPath("/en-US/docs")).toBe(false);
    expect(isDocsPath("/fr-FR/docs")).toBe(false);
    expect(isDocsPath("/docs/reference")).toBe(false);
  });
});
