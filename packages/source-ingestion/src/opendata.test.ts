import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeBofipDatasetAdapter, parseBofipDataset, parseBofipUpdateFeed } from "./opendata";
import type { FetchResponse, PublicSourceDefinition } from "./types";

const source = {
  id: "bofip_impots",
  displayName: "BOFiP / impots.gouv.fr",
  publisherName: "Direction generale des Finances publiques",
  description: "French tax doctrine updates and official tax guidance news.",
  ingestionMethod: "opendata_dataset",
  discoveryUrl: "https://bofip.impots.gouv.fr/bofip/ext/rss.xml?actualites=1&maxR=10&maxJ=14",
  contentUrl:
    "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/bofip-vigueur/records",
  expectedCadence: "several_per_week",
  averageCharsPerItem: 1859,
} as const satisfies PublicSourceDefinition;

const updateFeedBody = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>TVA - Règles de TVA</title>
      <link>https://bofip.impots.gouv.fr/bofip/15005-PGP.html/ACTU-2026-00057</link>
      <description>TVA - Règles de TVA (identifiant juridique ACTU-2026-00057; publié le 01/07/2026)</description>
      <category>Actualité</category>
    </item>
  </channel>
</rss>`;

const datasetBody = JSON.stringify({
  results: [
    {
      type: "Actualite",
      titre: "TVA - Mise a jour",
      debut_de_validite: "2026-07-01",
      serie: "TVA",
      division: "BASE",
      identifiant_juridique: "BOI-TVA-BASE-10",
      permalien: "https://bofip.impots.gouv.fr/bofip/123",
      contenu: "Texte brut",
      contenu_html: "<section><h1>TVA</h1><p>Doctrine fiscale.</p></section>",
    },
  ],
});

const response = (url: string, body: string): FetchResponse => ({
  url,
  status: 200,
  ok: true,
  headers: new Headers({ "content-type": "application/json" }),
  text: async () => body,
});

const notModifiedResponse = (url: string): FetchResponse => ({
  url,
  status: 304,
  ok: false,
  headers: new Headers({ etag: '"dataset-cache"' }),
  text: async () => {
    throw new Error("304 responses should not be read");
  },
});

describe("BOFiP open data adapter", () => {
  it("parses BOFiP RSS update discovery items", () => {
    const items = parseBofipUpdateFeed(source, updateFeedBody);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceId: "bofip_impots",
      externalId: "ACTU-2026-00057",
      canonicalUrl: "https://bofip.impots.gouv.fr/bofip/15005-PGP.html/ACTU-2026-00057",
      title: "TVA - Règles de TVA",
      metadata: {
        discoveryMethod: "bofip_rss",
      },
    });
    expect(items[0]?.publishedAt?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("parses BOFiP records into discovered items", () => {
    const items = parseBofipDataset(source, datasetBody);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceId: "bofip_impots",
      externalId: "BOI-TVA-BASE-10",
      canonicalUrl: "https://bofip.impots.gouv.fr/bofip/123",
      title: "TVA - Mise a jour",
      metadata: {
        type: "Actualite",
        serie: "TVA",
        division: "BASE",
      },
    });
    expect(items[0]?.publishedAt?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("discovers, fetches, and normalizes BOFiP dataset records", async () => {
    const requestedUrls: string[] = [];
    const fetcher = async (url: string): Promise<FetchResponse> => {
      requestedUrls.push(url);
      return url.includes("rss.xml") ? response(url, updateFeedBody) : response(url, datasetBody);
    };

    const adapter = makeBofipDatasetAdapter(source, { fetcher });
    const discovery = await Effect.runPromise(adapter.discover());
    expect(discovery.status).toBe("fetched");
    if (discovery.status !== "fetched") {
      throw new Error("expected fetched discovery");
    }
    const [item] = discovery.items;
    const result = await Effect.runPromise(adapter.fetch(item!));
    expect(result.status).toBe("fetched");
    if (result.status !== "fetched") {
      throw new Error("expected fetched result");
    }
    const raw = result.raw;
    const document = await Effect.runPromise(adapter.normalize(raw, item));

    expect(requestedUrls[0]).toBe(source.discoveryUrl);
    expect(requestedUrls[1]).toContain("where=identifiant_juridique%3D%22ACTU-2026-00057%22");
    expect(document).toMatchObject({
      sourceId: "bofip_impots",
      externalId: "ACTU-2026-00057",
      canonicalUrl: "https://bofip.impots.gouv.fr/bofip/15005-PGP.html/ACTU-2026-00057",
      title: "TVA - Règles de TVA",
      documentType: "doctrine_update",
      text: "TVA Doctrine fiscale.",
      textCharCount: 21,
      sourceMetadata: {
        ingestionMethod: "opendata_dataset",
        type: "Actualite",
        serie: "TVA",
        division: "BASE",
      },
    });
    expect(document.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(document.id).toContain(document.contentHash.slice(0, 16));
  });

  it("passes conditional validators to dataset discovery", async () => {
    const fetcher = async (_url: string, init?: RequestInit): Promise<FetchResponse> => {
      const headers = new Headers(init?.headers);
      expect(headers.get("if-none-match")).toBe('"bofip-rss-cache"');
      return response(_url, updateFeedBody);
    };

    const adapter = makeBofipDatasetAdapter(source, { fetcher });
    const discovery = await Effect.runPromise(
      adapter.discover({ validators: { etag: '"bofip-rss-cache"' } }),
    );

    expect(discovery.status).toBe("fetched");
  });

  it("returns not_modified when dataset discovery gets a conditional cache hit", async () => {
    const fetcher = async (_url: string, init?: RequestInit): Promise<FetchResponse> => {
      const headers = new Headers(init?.headers);
      expect(headers.get("if-none-match")).toBe('"bofip-rss-cache"');
      return notModifiedResponse(_url);
    };

    const adapter = makeBofipDatasetAdapter(source, { fetcher });
    const discovery = await Effect.runPromise(
      adapter.discover({ validators: { etag: '"bofip-rss-cache"' } }),
    );

    expect(discovery).toMatchObject({
      status: "not_modified",
      sourceId: "bofip_impots",
      metadata: [
        {
          status: 304,
          etag: '"dataset-cache"',
        },
      ],
    });
  });

  it("returns not_modified when a dataset record fetch gets a conditional cache hit", async () => {
    const fetcher = async (_url: string, init?: RequestInit): Promise<FetchResponse> => {
      const headers = new Headers(init?.headers);
      expect(headers.get("if-none-match")).toBe('"abc123"');
      return notModifiedResponse(
        "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/bofip-vigueur/records",
      );
    };

    const adapter = makeBofipDatasetAdapter(source, { fetcher });
    const result = await Effect.runPromise(
      adapter.fetch(
        {
          sourceId: "bofip_impots",
          externalId: "BOI-TVA-BASE-10",
          canonicalUrl: "https://bofip.impots.gouv.fr/bofip/123",
          title: "TVA - Mise a jour",
          publishedAt: null,
        },
        { validators: { etag: '"abc123"' } },
      ),
    );

    expect(result).toMatchObject({
      status: "not_modified",
      sourceId: "bofip_impots",
      canonicalUrl: "https://bofip.impots.gouv.fr/bofip/123",
      metadata: {
        externalId: "BOI-TVA-BASE-10",
        etag: '"dataset-cache"',
      },
    });
  });

  it("fails normalization when a BOFiP dataset lookup returns no record", async () => {
    const adapter = makeBofipDatasetAdapter(source);
    await expect(
      Effect.runPromise(
        adapter.normalize(
          {
            sourceId: "bofip_impots",
            canonicalUrl: "https://bofip.impots.gouv.fr/bofip/15005-PGP.html/ACTU-2026-00057",
            fetchedAt: new Date("2026-07-06T10:00:00Z"),
            mediaType: "application/json",
            body: JSON.stringify({ results: [] }),
          },
          {
            sourceId: "bofip_impots",
            externalId: "ACTU-2026-00057",
            canonicalUrl: "https://bofip.impots.gouv.fr/bofip/15005-PGP.html/ACTU-2026-00057",
            title: "TVA - Règles de TVA",
            publishedAt: null,
          },
        ),
      ),
    ).rejects.toThrow("record not found");
  });
});
