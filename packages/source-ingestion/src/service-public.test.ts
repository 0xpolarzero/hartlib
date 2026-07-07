import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeServicePublicXmlAdapter,
  parseServicePublicDirectory,
  parseServicePublicIndex,
  servicePublicArticleDirectoryUrl,
} from "./service-public";
import { publicSourceDefinitions } from "./source-catalog";
import type { FetchResponse, PublicSourceDefinition } from "./types";

const source = {
  id: "service_public",
  displayName: "Service-Public",
  publisherName: "Direction de l'information legale et administrative",
  description: "Official DILA XML open data.",
  ingestionMethod: "xml_dataset",
  discoveryUrl: "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/",
  contentFormats: ["html", "text"],
  averageCharsPerItem: 7651,
} as const satisfies PublicSourceDefinition;

const resourceRootHtml = `<html>
<head><title>Index of /actu/3.5/part/</title></head>
<body><pre>
<a href="../">../</a>
<a href="xml/">xml/</a>
<a href="zip/">zip/</a>
</pre></body>
</html>`;

const directoryHtml = `<html>
<head><title>Index of /actu/3.5/part/xml/actualites/</title></head>
<body><pre>
<a href="../">../</a>
<a href="A00001.xml">A00001.xml</a> 07-Jul-2026 15:15 6086
</pre></body>
</html>`;

const articleXml = `<?xml version="1.0" encoding="UTF-8"?>
<Actualite xmlns:dc="http://purl.org/dc/elements/1.1/" ID="A00001" type="bref" datePremiereMiseEnLigne="2026-07-01" spUrl="https://www.service-public.gouv.fr/particuliers/actualites/A00001">
  <dc:title>Nouvelle demarche</dc:title>
  <dc:description>Resume officiel.</dc:description>
  <Introduction><![CDATA[<p>Resume officiel.</p>]]></Introduction>
  <Texte><![CDATA[<p>Contenu complet lisible.</p>]]></Texte>
</Actualite>`;

const response = (url: string, body: string): FetchResponse => ({
  url,
  status: 200,
  ok: true,
  headers: new Headers({ "content-type": "application/xml" }),
  text: async () => body,
});

const notModifiedResponse = (url: string): FetchResponse => ({
  url,
  status: 304,
  ok: false,
  headers: new Headers({ etag: '"directory-cache"' }),
  text: async () => {
    throw new Error("304 responses should not be read");
  },
});

describe("Service-Public XML adapter", () => {
  it("pins the official Service-Public source catalog roots", () => {
    const definition = publicSourceDefinitions.find(
      (candidate) => candidate.id === "service_public",
    );

    expect(definition).toMatchObject({
      discoveryUrl: "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/",
      discoveryUrls: [
        "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/",
        "https://lecomarquage.service-public.gouv.fr/actu/3.5/pro/",
      ],
      ingestionMethod: "xml_dataset",
      contentFormats: ["html", "text"],
    });
  });

  it("resolves the official data.gouv resource root to the article XML directory", () => {
    expect(servicePublicArticleDirectoryUrl(source.discoveryUrl, resourceRootHtml)).toBe(
      "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/xml/actualites/",
    );
  });

  it("parses official XML directory records into discovered item placeholders", () => {
    const items = parseServicePublicDirectory(
      source,
      directoryHtml,
      "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/xml/actualites/",
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceId: "service_public",
      externalId: "A00001",
      canonicalUrl:
        "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/xml/actualites/A00001.xml",
      title: "A00001",
      metadata: {
        xmlUrl:
          "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/xml/actualites/A00001.xml",
      },
    });
  });

  it("parses official article XML records into discovered items", () => {
    const items = parseServicePublicIndex(
      source,
      articleXml,
      "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/xml/actualites/A00001.xml",
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceId: "service_public",
      externalId: "A00001",
      canonicalUrl: "https://www.service-public.gouv.fr/particuliers/actualites/A00001",
      title: "Nouvelle demarche",
      summary: "Resume officiel.",
      metadata: {
        xmlUrl:
          "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/xml/actualites/A00001.xml",
      },
    });
    expect(items[0]?.publishedAt?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("fetches official XML and normalizes it without fetching the public HTML page", async () => {
    const requestedUrls: string[] = [];
    const fetcher = async (url: string): Promise<FetchResponse> => {
      requestedUrls.push(url);
      if (url === source.discoveryUrl) {
        return response(url, resourceRootHtml);
      }
      if (url.endsWith("/xml/actualites/")) {
        return response(url, directoryHtml);
      }
      return response(url, articleXml);
    };

    const adapter = makeServicePublicXmlAdapter(source, { fetcher });
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
    const document = await Effect.runPromise(adapter.normalize(result.raw, item));

    expect(requestedUrls).toEqual([
      "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/",
      "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/xml/actualites/",
      "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/xml/actualites/A00001.xml",
    ]);
    expect(result.raw).toMatchObject({
      mediaType: "text/html",
      metadata: {
        officialXmlMediaType: "application/xml",
        xmlUrl:
          "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/xml/actualites/A00001.xml",
      },
    });
    expect(result.raw.body).toContain("Contenu complet lisible.");
    expect(document).toMatchObject({
      sourceId: "service_public",
      externalId: "A00001",
      canonicalUrl: "https://www.service-public.gouv.fr/particuliers/actualites/A00001",
      title: "Nouvelle demarche",
      documentType: "article",
      text: "Nouvelle demarche Nouvelle demarche Resume officiel. Contenu complet lisible.",
      sourceMetadata: {
        ingestionMethod: "xml_dataset",
        contentFormats: ["html", "text"],
        xmlUrl:
          "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/xml/actualites/A00001.xml",
      },
    });
  });

  it("discovers both documented Service-Public audiences from official XML roots", async () => {
    const bothAudienceSource = {
      ...source,
      discoveryUrls: [
        "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/",
        "https://lecomarquage.service-public.gouv.fr/actu/3.5/pro/",
      ],
    } as const satisfies PublicSourceDefinition;
    const requestedUrls: string[] = [];
    const fetcher = async (url: string): Promise<FetchResponse> => {
      requestedUrls.push(url);
      if (url.endsWith("/part/") || url.endsWith("/pro/")) {
        return response(url, resourceRootHtml);
      }
      if (url.endsWith("/xml/actualites/")) {
        return response(
          url,
          directoryHtml.replaceAll("A00001", url.includes("/pro/") ? "A00002" : "A00001"),
        );
      }
      return response(
        url,
        articleXml.replaceAll("A00001", url.includes("A00002") ? "A00002" : "A00001"),
      );
    };

    const adapter = makeServicePublicXmlAdapter(bothAudienceSource, { fetcher });
    const discovery = await Effect.runPromise(adapter.discover());

    expect(discovery.status).toBe("fetched");
    expect(requestedUrls).toEqual([
      "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/",
      "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/xml/actualites/",
      "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/xml/actualites/A00001.xml",
      "https://lecomarquage.service-public.gouv.fr/actu/3.5/pro/",
      "https://lecomarquage.service-public.gouv.fr/actu/3.5/pro/xml/actualites/",
      "https://lecomarquage.service-public.gouv.fr/actu/3.5/pro/xml/actualites/A00002.xml",
    ]);
    if (discovery.status !== "fetched") {
      throw new Error("expected fetched discovery");
    }
    expect(discovery.items.map((item) => item.externalId)).toEqual(["A00001", "A00002"]);
  });

  it("passes per-directory conditional validators and records directory cache hits", async () => {
    const requestedHeaders: Array<{ readonly url: string; readonly etag: string | null }> = [];
    const directoryUrl =
      "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/xml/actualites/";
    const fetcher = async (url: string, init?: RequestInit): Promise<FetchResponse> => {
      requestedHeaders.push({ url, etag: new Headers(init?.headers).get("if-none-match") });
      if (url === source.discoveryUrl) {
        return response(url, resourceRootHtml);
      }
      return notModifiedResponse(url);
    };

    const adapter = makeServicePublicXmlAdapter(source, { fetcher });
    const discovery = await Effect.runPromise(
      adapter.discover({
        requests: [{ url: directoryUrl, validators: { etag: '"directory-cache-in"' } }],
      }),
    );

    expect(requestedHeaders).toEqual([
      { url: source.discoveryUrl, etag: null },
      { url: directoryUrl, etag: '"directory-cache-in"' },
    ]);
    expect(discovery).toMatchObject({
      status: "fetched",
      metadata: [
        { url: source.discoveryUrl, status: 200 },
        { url: directoryUrl, status: 304, etag: '"directory-cache"' },
      ],
    });
  });
});
