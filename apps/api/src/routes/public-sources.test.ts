import { describe, expect, it } from "vitest";
import {
  publicSourceDocumentResponseFromRow,
  publicSourcesResponseFromRows,
} from "../domain/public-sources";

const source = {
  source_id: "assemblee_nationale",
  display_name: "Assemblee nationale",
  publisher_name: "Assemblee nationale",
  description: "Parliamentary documents.",
  country: "FR",
  language: "fr-FR",
  created_at: new Date("2026-07-07T10:00:00.000Z"),
};

const item = {
  source_id: "assemblee_nationale",
  canonical_url: "https://www.assemblee-nationale.fr/17/ta/ta0326.asp",
  title: "Texte adopte n 326",
  published_at: new Date("2026-07-07T18:00:00.000Z"),
  discovered_at: new Date("2026-07-07T16:30:00.000Z"),
  summary: null,
  current_content_hash: "hash-1",
  latest_document_id: "document-1",
  latest_raw_artifact_id: "raw-1",
  raw_media_type: "text/html",
};

const readableText =
  "Official readable document text with enough content to satisfy the invariant that visible public publications are backed by complete stored artifacts.";

const document = {
  document_id: "document-1",
  source_id: "assemblee_nationale",
  canonical_url: "https://www.assemblee-nationale.fr/17/ta/ta0326.asp",
  title: "Texte adopte n 326",
  published_at: new Date("2026-07-07T18:00:00.000Z"),
  discovered_at: new Date("2026-07-07T16:30:00.000Z"),
  language: "fr",
  document_type: "publication",
  text: readableText,
  text_char_count: readableText.length,
  content_hash: "hash-1",
  raw_artifact_id: "raw-1",
  raw_media_type: "text/html",
};

describe("publicSourcesResponseFromRows", () => {
  it("does not expose public source metadata as a publication when no readable documents exist", () => {
    const response = publicSourcesResponseFromRows([source], [], []);

    expect(response.sources).toHaveLength(1);
    expect(response.sources[0]).toMatchObject({
      id: "assemblee_nationale",
      latestPublicationId: null,
      latestPublicationDate: null,
    });
    expect(response.publications).toEqual([]);
  });

  it("hides stale item pointers without a matching document row", () => {
    const response = publicSourcesResponseFromRows([source], [item], []);

    expect(response.sources[0]?.latestPublicationId).toBeNull();
    expect(response.publications).toEqual([]);
  });

  it("hides items missing the required publication pointers", () => {
    const response = publicSourcesResponseFromRows(
      [source],
      [
        {
          ...item,
          current_content_hash: null,
        },
      ],
      [document],
    );

    expect(response.sources[0]?.latestPublicationId).toBeNull();
    expect(response.publications).toEqual([]);
  });

  it("hides items whose latest pointers do not match one coherent document", () => {
    const response = publicSourcesResponseFromRows(
      [source],
      [
        {
          ...item,
          latest_raw_artifact_id: "different-raw",
        },
      ],
      [document],
    );

    expect(response.sources[0]?.latestPublicationId).toBeNull();
    expect(response.publications).toEqual([]);
  });

  it("hides documents that are too short to be complete and readable", () => {
    const response = publicSourcesResponseFromRows(
      [source],
      [item],
      [
        {
          ...document,
          text: "short",
          text_char_count: 5,
        },
      ],
    );

    expect(response.sources[0]?.latestPublicationId).toBeNull();
    expect(response.publications).toEqual([]);
  });

  it("exposes a public publication only with a readable stored HTML/PDF document", () => {
    const response = publicSourcesResponseFromRows([source], [item], [document]);

    expect(response.sources[0]).toMatchObject({
      subscribed: false,
      subscribedSince: null,
      subscriberCount: null,
      metrics: { opens: null, downloads: null, aiContextPulls: null },
      latestPublicationId:
        "public:assemblee_nationale:https%3A%2F%2Fwww.assemblee-nationale.fr%2F17%2Fta%2Fta0326.asp",
      latestPublicationDate: "2026-07-07T18:00:00.000Z",
    });
    expect(response.publications).toHaveLength(1);
    expect(response.publications[0]?.documents).toHaveLength(1);
    expect(response.publications[0]?.documents[0]).toMatchObject({
      hostedContentUrl: "/public-source-documents/document-1/content",
      metrics: { opens: null, downloads: null, aiContextPulls: null },
    });
    expect(response.publications[0]?.metrics).toEqual({
      opens: null,
      downloads: null,
      aiContextPulls: null,
    });
  });

  it("projects only the enabled company setting as subscribed state", () => {
    const response = publicSourcesResponseFromRows(
      [{ ...source, subscribed: true, subscribed_since: new Date("2026-07-08T10:00:00.000Z") }],
      [item],
      [document],
      "demo-company",
    );

    expect(response.sources[0]).toMatchObject({
      clientCompanyId: "demo-company",
      subscribed: true,
      subscribedSince: "2026-07-08T10:00:00.000Z",
    });
    expect(response.publications).toHaveLength(1);
  });

  it("does not return publication rows for a disabled company source", () => {
    const response = publicSourcesResponseFromRows(
      [{ ...source, subscribed: false, subscribed_since: null }],
      [item],
      [document],
      "demo-company",
    );

    expect(response.sources[0]?.subscribed).toBe(false);
    expect(response.publications).toEqual([]);
  });

  it("rejects media-type substrings that are not exact displayable base types", () => {
    for (const raw_media_type of ["application/notpdf", "text/htmlish", "image/pdf-preview"]) {
      const response = publicSourcesResponseFromRows(
        [source],
        [{ ...item, raw_media_type }],
        [{ ...document, raw_media_type }],
      );
      expect(response.sources[0]?.latestPublicationId).toBeNull();
      expect(response.publications).toEqual([]);
    }
  });

  it.each([
    "javascript:alert(1)",
    "http://www.assemblee-nationale.fr/17/ta/ta0326.asp",
    "https://user@www.assemblee-nationale.fr/17/ta/ta0326.asp",
    "https://127.0.0.1/17/ta/ta0326.asp",
  ])("hides publications with an unsafe canonical URL: %s", (canonical_url) => {
    const response = publicSourcesResponseFromRows(
      [source],
      [{ ...item, canonical_url }],
      [{ ...document, canonical_url }],
    );

    expect(response.sources[0]?.latestPublicationId).toBeNull();
    expect(response.publications).toEqual([]);
  });

  it("uses discovered_at as the display date only for undated readable items", () => {
    const response = publicSourcesResponseFromRows(
      [source],
      [{ ...item, published_at: null }],
      [{ ...document, published_at: null }],
    );

    expect(response.sources[0]?.latestPublicationDate).toBe("2026-07-07T16:30:00.000Z");
    expect(response.publications[0]?.publicationDate).toBe("2026-07-07T16:30:00.000Z");
  });

  it("excludes publications whose source is not in the (market-filtered) sources set", () => {
    // Simulate a `?market=US` response: the sources array is scoped to a US
    // source, but the items/documents queries return a readable FR publication.
    // The FR publication must NOT leak into the response.
    const usSource = {
      ...source,
      source_id: "us_source",
      display_name: "US Source",
      country: "US",
    };

    const response = publicSourcesResponseFromRows([usSource], [item], [document]);

    expect(response.sources).toHaveLength(1);
    expect(response.sources[0]?.id).toBe("us_source");
    expect(response.publications).toEqual([]);
  });
});

describe("publicSourceDocumentResponseFromRow", () => {
  it("serves exact PDF bytes without text transcoding", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff]);
    const response = publicSourceDocumentResponseFromRow({
      body: "",
      body_bytes: bytes,
      media_type: "application/pdf",
    });

    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("inline");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("serves HTML as UTF-8 under a restrictive content security policy", async () => {
    const response = publicSourceDocumentResponseFromRow({
      body: "<main>Document officiel</main>",
      body_bytes: null,
      media_type: "text/html; charset=iso-8859-1",
    });

    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const contentSecurityPolicy = response.headers.get("content-security-policy");
    expect(contentSecurityPolicy).toContain("default-src 'none'");
    expect(contentSecurityPolicy).toContain("img-src data:");
    expect(contentSecurityPolicy).not.toContain("https:");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.text()).toBe("<main>Document officiel</main>");
  });

  it("fails closed for ambiguous media-type substrings", () => {
    expect(() =>
      publicSourceDocumentResponseFromRow({
        body: "<main>not HTML</main>",
        body_bytes: null,
        media_type: "text/htmlish",
      }),
    ).toThrow("unsupported media type");
    expect(() =>
      publicSourceDocumentResponseFromRow({
        body: "",
        body_bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
        media_type: "application/notpdf",
      }),
    ).toThrow("unsupported media type");
  });
});
