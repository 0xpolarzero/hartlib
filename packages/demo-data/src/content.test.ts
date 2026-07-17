import { describe, expect, it } from "vitest";

import { demoIssues, demoSources, findPublicationById, getPublicationsBySourceId } from "./index";

describe("demo dataset fake publisher content", () => {
  it("ships no seeded publisher sources", () => {
    expect(demoSources).toEqual([]);
  });

  it("ships no seeded publisher issues", () => {
    expect(demoIssues).toEqual([]);
  });

  it("findPublicationById returns undefined for any id", () => {
    expect(findPublicationById("issue_regfin_2026_06_24")).toBeUndefined();
  });

  it("getPublicationsBySourceId returns empty for any source", () => {
    expect(getPublicationsBySourceId("source_regulation_financiere")).toEqual([]);
  });
});
