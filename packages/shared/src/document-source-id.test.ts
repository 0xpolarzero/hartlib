import { describe, expect, it } from "vitest";

import {
  isCanonicalDocumentSourceId,
  isCanonicalPublicDocumentSourceId,
  isCanonicalPublisherDocumentSourceId,
} from "./document-source-id";

describe("durable document source IDs", () => {
  it("accepts only anchored, namespaced IDs", () => {
    expect(isCanonicalPublicDocumentSourceId("public:source-1")).toBe(true);
    expect(isCanonicalPublisherDocumentSourceId("publisher:subscription-1")).toBe(true);
    expect(isCanonicalDocumentSourceId("public:source-1")).toBe(true);
    expect(isCanonicalDocumentSourceId("publisher:subscription-1")).toBe(true);
  });

  it.each([
    "source-1",
    "public:",
    "public:public:source-1",
    " public:source-1",
    "public:source-1 ",
    "public:source-1\u2003",
    "publisher:subscription:extra",
  ])("rejects malformed ID %j", (value) => {
    expect(isCanonicalDocumentSourceId(value)).toBe(false);
  });
});
