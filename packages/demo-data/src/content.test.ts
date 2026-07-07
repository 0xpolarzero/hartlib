import { describe, expect, it } from "vitest";

import { demoIssues, demoSources, findPublicationById, getPublicationsBySourceId } from "./index";

describe("seeded publisher content", () => {
  it("uses the shared source shape for publisher sources", () => {
    for (const source of demoSources) {
      expect(source.kind).toBe("publisher");
      expect(source.publisherName).toBeTruthy();
      expect(source.subscribed).toBe(true);
      expect(source.latestPublicationId).toBeTruthy();
      expect(source.metrics).toEqual(
        expect.objectContaining({
          opens: expect.any(Number),
          downloads: expect.any(Number),
          aiContextPulls: expect.any(Number),
        }),
      );
    }
  });

  it("uses the shared publication and document shape", () => {
    for (const publication of demoIssues) {
      expect(publication.sourceKind).toBe("publisher");
      expect(publication.canonicalUrl).toBeNull();
      for (const document of publication.documents) {
        expect(document.publicationId).toBe(publication.id);
        expect(document.sourceId).toBe(publication.sourceId);
        expect(document.documentType).toBe("pdf");
        expect(document.textPreview).toBeTruthy();
      }
    }
  });

  it("looks up only supplied publications", () => {
    expect(findPublicationById("issue_regfin_2026_06_24")?.sourceId).toBe(
      "source_regulation_financiere",
    );
    expect(findPublicationById("nonexistent_publication")).toBeUndefined();
  });

  it("returns source publications sorted by date", () => {
    const publications = getPublicationsBySourceId("source_regulation_financiere");
    expect(publications.map((publication) => publication.id)).toEqual([
      "issue_regfin_2026_06_24",
      "issue_regfin_2026_06_17",
    ]);
  });
});
