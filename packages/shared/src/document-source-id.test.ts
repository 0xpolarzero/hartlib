import { describe, expect, it } from "vitest";

import { isCanonicalPublicDocumentSourceId } from "./document-source-id";

describe("durable document source IDs", () => {
  it("accepts only anchored, namespaced IDs", () => {
    expect(isCanonicalPublicDocumentSourceId("public:source-1")).toBe(true);
  });

  it.each([
    "source-1",
    "public:",
    "public:public:source-1",
    " public:source-1",
    "public:source-1 ",
    "public:source-1\u2003",
  ])("rejects malformed ID %j", (value) => {
    expect(isCanonicalPublicDocumentSourceId(value)).toBe(false);
  });
});
