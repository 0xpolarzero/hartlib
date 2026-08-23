import type { PublicSourceRecord } from "@hartlib/shared";
import { describe, expect, it } from "vitest";

import { citationRecordsFromText, parseCitationTags } from "./citation-tags";

describe("parseCitationTags", () => {
  it("parses a multi-id citation tag", () => {
    expect(parseCitationTags("Texte [[cite:b1,b2]] suite.", ["b1", "b2"])).toEqual({
      segments: [
        { type: "text", text: "Texte " },
        { type: "citations", citationIds: ["b1", "b2"] },
        { type: "text", text: " suite." },
      ],
      pendingTail: "",
    });
  });

  it("renders unknown ids as literal text", () => {
    expect(parseCitationTags("Texte [[cite:b1,b404]].", ["b1"])).toEqual({
      segments: [{ type: "text", text: "Texte [[cite:b1,b404]]." }],
      pendingTail: "",
    });
  });

  it("holds back a partial citation tag tail", () => {
    expect(parseCitationTags("Texte [[cite:b", ["b1"])).toEqual({
      segments: [{ type: "text", text: "Texte " }],
      pendingTail: "[[cite:b",
    });
  });

  it("holds back an opener prefix at the end of a streaming buffer", () => {
    expect(parseCitationTags("Texte [[ci", ["b1"])).toEqual({
      segments: [{ type: "text", text: "Texte " }],
      pendingTail: "[[ci",
    });
  });

  it("renders a trailing partial citation opener as literal text in final mode", () => {
    expect(parseCitationTags("Texte [[cite:b1", ["b1"], "final")).toEqual({
      segments: [{ type: "text", text: "Texte [[cite:b1" }],
      pendingTail: "",
    });
  });

  it("renders a trailing opener prefix as literal text in final mode", () => {
    expect(parseCitationTags("Texte [[", ["b1"], "final")).toEqual({
      segments: [{ type: "text", text: "Texte [[" }],
      pendingTail: "",
    });
  });

  it("handles adjacent tags", () => {
    expect(parseCitationTags("[[cite:b1]][[cite:b2]]", ["b1", "b2"])).toEqual({
      segments: [
        { type: "citations", citationIds: ["b1"] },
        { type: "citations", citationIds: ["b2"] },
      ],
      pendingTail: "",
    });
  });

  it("keeps repeated ids in order", () => {
    expect(parseCitationTags("[[cite:b1,b1]]", ["b1"])).toEqual({
      segments: [{ type: "citations", citationIds: ["b1", "b1"] }],
      pendingTail: "",
    });
  });
});

describe("citationRecordsFromText", () => {
  const sources: readonly PublicSourceRecord[] = [
    {
      sourceKey: "k_a",
      label: "Source A",
      tokenCount: 10,
      topicIds: [],
      kind: "document" as const,
      documentTitle: "Source A",
      url: "https://example.com/a",
      ranges: [{ charStart: 0, charEnd: 10 }],
    },
    {
      sourceKey: "k_b",
      label: "Source B",
      tokenCount: 5,
      topicIds: ["t1" as const],
      kind: "web" as const,
      title: "Source B",
      domain: "example.com",
      url: "https://example.com/b",
      capturedAt: "2026-07-14T00:00:00.000Z",
      quote: "Evidence",
      ranges: [] as const,
    },
  ];

  it("derives complete known tags in text order and strips stream-only fields", () => {
    expect(citationRecordsFromText("A [[cite:k_b]] B [[cite:k_a]]", sources)).toEqual([
      {
        sourceKey: "k_b",
        label: "Source B",
        kind: "web",
        title: "Source B",
        domain: "example.com",
        url: "https://example.com/b",
        capturedAt: "2026-07-14T00:00:00.000Z",
        quote: null,
        ranges: [],
      },
      {
        sourceKey: "k_a",
        label: "Source A",
        kind: "document",
        documentTitle: "Source A",
        url: "https://example.com/a",
        quote: null,
        ranges: [{ charStart: 0, charEnd: 10 }],
      },
    ]);
  });

  it("ignores an unknown-id tag without fabricating a citation", () => {
    expect(
      citationRecordsFromText("Known [[cite:k_a]] unknown [[cite:k_missing]]", sources),
    ).toEqual([expect.objectContaining({ sourceKey: "k_a" })]);
  });

  it("deduplicates repeated tags and repeated ids while preserving first-seen order", () => {
    expect(
      citationRecordsFromText("[[cite:k_a,k_a]] then [[cite:k_b]] then [[cite:k_a]]", sources).map(
        (citation) => citation.sourceKey,
      ),
    ).toEqual(["k_a", "k_b"]);
  });

  it("holds an open citation tag or opener tail until it is complete", () => {
    expect(citationRecordsFromText("Answer [[cite:k_a", sources)).toEqual([]);
    expect(citationRecordsFromText("Answer [[ci", sources)).toEqual([]);
  });
});
