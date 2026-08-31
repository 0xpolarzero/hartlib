import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  assertReadablePdfText,
  makeFeedAdapter,
  MINIMUM_READABLE_PDF_TEXT_CHARS,
  parseFeed,
} from "./feed";
import type { FetchResponse, PublicSourceDefinition } from "./types";

const rssSource = {
  id: "assemblee_nationale",
  displayName: "Assemblee nationale",
  publisherName: "Assemblee nationale",
  description: "Official parliamentary documents.",
  country: "FR",
  language: "fr-FR",
  ingestionMethod: "official_document",
  discoveryUrl: "https://example.test/rss.xml",
  canonicalUrlOrigins: ["https://example.test", "https://www.assemblee-nationale.fr"],
  fetchOrigins: ["https://example.test", "https://www.assemblee-nationale.fr"],
  contentFormats: ["html", "text"],
  averageCharsPerItem: 1000,
} as const satisfies PublicSourceDefinition;

const atomSource = {
  ...rssSource,
  discoveryUrl: "https://example.test/atom.xml",
} as const satisfies PublicSourceDefinition;

const fixturePdfBytes = (): Uint8Array => {
  const text = "Official parliamentary report " + "x".repeat(180);
  const stream = `BT\n/F1 12 Tf\n72 700 Td\n(${text}) Tj\nET\n`;
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /ProcSet [/PDF /Text] /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, body] of bodies.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const crossReferenceOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  pdf += `${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
    .join("\n")}\n`;
  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${crossReferenceOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
};

const response = (url: string, body: string, contentType = "text/xml"): FetchResponse => ({
  url,
  status: 200,
  ok: true,
  headers: new Headers({ "content-type": contentType }),
  text: async () => body,
  body: new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  }),
});

const binaryResponse = (url: string, bytes: Uint8Array, contentType: string): FetchResponse => ({
  url,
  status: 200,
  ok: true,
  headers: new Headers({
    "content-type": contentType,
    "content-length": String(bytes.byteLength),
  }),
  text: async () => {
    throw new Error("binary response must not be decoded as text");
  },
  body: new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from(bytes));
      controller.close();
    },
  }),
});

const streamedBinaryResponse = (
  url: string,
  chunks: readonly Uint8Array[],
  contentType: string,
): FetchResponse => ({
  url,
  status: 200,
  ok: true,
  headers: new Headers({ "content-type": contentType }),
  text: async () => {
    throw new Error("streamed binary response must not be decoded as text");
  },
  body: new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }),
  arrayBuffer: async () => {
    throw new Error("stream reader must be used before arrayBuffer");
  },
});

const failedResponse = (url: string, status: number): FetchResponse => ({
  url,
  status,
  ok: false,
  headers: new Headers(),
  text: async () => "",
});

const notModifiedResponse = (url: string): FetchResponse => ({
  url,
  status: 304,
  ok: false,
  headers: new Headers({ etag: '"cached"', "last-modified": "Mon, 06 Jul 2026 10:00:00 GMT" }),
  text: async () => {
    throw new Error("304 responses should not be read");
  },
});

describe("feed adapters", () => {
  it.each([
    ["empty", ""],
    ["whitespace", " \n\t\r  "],
    ["short", "a".repeat(MINIMUM_READABLE_PDF_TEXT_CHARS - 1)],
  ])("rejects %s extracted PDF text before ingestion", (_label, text) => {
    expect(() => assertReadablePdfText(rssSource, text)).toThrow(
      "extracted content is too short to be considered readable",
    );
  });

  it("accepts extracted PDF text at the exact readability boundary", () => {
    const text = "a".repeat(MINIMUM_READABLE_PDF_TEXT_CHARS);
    expect(assertReadablePdfText(rssSource, text)).toBe(text);
  });

  it("parses RSS discovery items", () => {
    const items = parseFeed(
      rssSource,
      `<?xml version="1.0"?>
      <rss><channel>
        <item>
          <title>Government update</title>
          <link>https://example.test/articles/1</link>
          <guid>article-1</guid>
          <pubDate>Mon, 06 Jul 2026 10:00:00 GMT</pubDate>
          <description><![CDATA[<p>Short <strong>summary</strong>.</p>]]></description>
        </item>
      </channel></rss>`,
      "rss",
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceId: "assemblee_nationale",
      externalId: "article-1",
      canonicalUrl: "https://example.test/articles/1",
      title: "Government update",
      summary: "Short summary.",
    });
    expect(items[0]?.publishedAt?.toISOString()).toBe("2026-07-06T10:00:00.000Z");
  });

  it("XML-decodes RSS URLs, IDs, and titles", () => {
    const items = parseFeed(
      rssSource,
      `<?xml version="1.0"?>
      <rss><channel>
        <item>
          <title>Taxes &amp; entreprises</title>
          <link>https://example.test/articles/1?x=1&amp;y=2</link>
          <guid>article-&amp;-1</guid>
        </item>
      </channel></rss>`,
      "rss",
    );

    expect(items[0]).toMatchObject({
      externalId: "article-&-1",
      canonicalUrl: "https://example.test/articles/1?x=1&y=2",
      title: "Taxes & entreprises",
    });
  });

  it("parses Atom discovery items", () => {
    const items = parseFeed(
      atomSource,
      `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Parliamentary note</title>
          <id>tag:example.test,2026:note-1</id>
          <updated>2026-07-05T09:30:00Z</updated>
          <link rel="alternate" href="https://example.test/notes/1" />
          <summary>Macro note</summary>
        </entry>
      </feed>`,
      "atom",
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceId: "assemblee_nationale",
      externalId: "tag:example.test,2026:note-1",
      canonicalUrl: "https://example.test/notes/1",
      title: "Parliamentary note",
      summary: "Macro note",
    });
  });

  it("XML-decodes Atom link attributes", () => {
    const items = parseFeed(
      atomSource,
      `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Parliament &amp; economie</title>
          <id>tag:example.test,2026:note-&amp;-1</id>
          <updated>2026-07-05T09:30:00Z</updated>
          <link rel="alternate" href="https://example.test/notes/1?x=1&amp;y=2" />
        </entry>
      </feed>`,
      "atom",
    );

    expect(items[0]).toMatchObject({
      externalId: "tag:example.test,2026:note-&-1",
      canonicalUrl: "https://example.test/notes/1?x=1&y=2",
      title: "Parliament & economie",
    });
  });

  it("prefers Atom alternate links over earlier self links", () => {
    const items = parseFeed(
      atomSource,
      `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Parliamentary note</title>
          <id>tag:example.test,2026:note-1</id>
          <updated>2026-07-05T09:30:00Z</updated>
          <link rel="self" href="https://example.test/atom.xml" />
          <link rel="alternate" href="https://example.test/notes/1" />
        </entry>
      </feed>`,
      "atom",
    );

    expect(items[0]?.canonicalUrl).toBe("https://example.test/notes/1");
  });

  it("uses no-rel Atom links as alternate links", () => {
    const items = parseFeed(
      atomSource,
      `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Parliamentary note</title>
          <id>tag:example.test,2026:note-1</id>
          <updated>2026-07-05T09:30:00Z</updated>
          <link href="https://example.test/notes/1" />
          <link rel="self" href="https://example.test/atom.xml" />
        </entry>
      </feed>`,
      "atom",
    );

    expect(items[0]?.canonicalUrl).toBe("https://example.test/notes/1");
  });

  it("discovers, fetches, and normalizes a feed-backed document", async () => {
    const feedBody = `<?xml version="1.0"?>
      <rss><channel>
        <item>
          <title>Government update</title>
          <link>https://example.test/articles/1</link>
          <guid>article-1</guid>
          <pubDate>Mon, 06 Jul 2026 10:00:00 GMT</pubDate>
        </item>
      </channel></rss>`;
    const articleBody = `<html><main><h1>Government update</h1><p>Useful public text with enough official document detail to prove this is the fetched parliamentary document body and not a short landing page shell.</p></main></html>`;
    const articleShell =
      '<html><main><a href="/dyn/opendata/articles-1.html" title="Version opendata HTML du document"></a></main></html>';
    const fetcher = async (url: string): Promise<FetchResponse> => {
      if (url.endsWith("rss.xml")) return response(url, feedBody);
      if (url.endsWith("/articles/1")) return response(url, articleShell, "text/html");
      return response(url, articleBody, "text/html");
    };

    const adapter = makeFeedAdapter(rssSource, { kind: "rss", fetcher });
    const discovery = await Effect.runPromise(adapter.discover());
    expect(discovery.status).toBe("fetched");
    if (discovery.status !== "fetched") {
      throw new Error("expected fetched discovery");
    }
    const [item] = discovery.items;
    expect(item?.canonicalUrl).toBe("https://example.test/articles/1");
    expect(discovery.metadata[0]).toMatchObject({
      url: "https://example.test/rss.xml",
      status: 200,
    });
    expect(discovery.metadata[0]?.bodyHash).toMatch(/^[a-f0-9]{64}$/);

    const result = await Effect.runPromise(adapter.fetch(item!));
    expect(result.status).toBe("fetched");
    if (result.status !== "fetched") {
      throw new Error("expected fetched result");
    }
    const raw = result.raw;
    const document = await Effect.runPromise(adapter.normalize(raw, item));

    expect(document).toMatchObject({
      sourceId: "assemblee_nationale",
      externalId: "article-1",
      canonicalUrl: "https://example.test/articles/1",
      title: "Government update",
      documentType: "publication",
      text: "Government update Useful public text with enough official document detail to prove this is the fetched parliamentary document body and not a short landing page shell.",
      textCharCount: 166,
    });
    expect(document.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(document.id).toContain(document.contentHash.slice(0, 16));
  });

  it("stores the Assemblee nationale official document HTML instead of the document page shell", async () => {
    const feedBody = `<?xml version="1.0"?>
      <rss><channel>
        <item>
          <title>Proposition de loi, n° 3044</title>
          <link>https://www.assemblee-nationale.fr/dyn/old/17/propositions/pion3044.asp</link>
          <guid>pion3044</guid>
        </item>
      </channel></rss>`;
    const landingPage = `<html>
      <main>
        <h1>Proposition de loi, n° 3044</h1>
        <p>Document page shell.</p>
        <iframe id="documentIframeContent" src="/dyn/docs/PIONANR5L17B3044.raw"></iframe>
        <a href="/dyn/opendata/PIONANR5L17B3044.html" title="Version opendata HTML du document"></a>
      </main>
    </html>`;
    const documentHtml = `<html><main><h1>N° 3044</h1><p>Actual official document body with enough parliamentary text to prove the official HTML artifact was fetched and stored instead of the surrounding metadata page shell.</p></main></html>`;
    const requestedUrls: string[] = [];
    const fetcher = async (url: string): Promise<FetchResponse> => {
      requestedUrls.push(url);
      if (url === "https://example.test/rss.xml") return response(url, feedBody);
      if (url === "https://www.assemblee-nationale.fr/dyn/old/17/propositions/pion3044.asp") {
        return response(
          "https://www.assemblee-nationale.fr/dyn/17/textes/l17b3044_proposition-loi",
          landingPage,
          "text/html",
        );
      }
      return response(url, documentHtml, "text/html");
    };

    const adapter = makeFeedAdapter(rssSource, { kind: "rss", fetcher });
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
      "https://example.test/rss.xml",
      "https://www.assemblee-nationale.fr/dyn/old/17/propositions/pion3044.asp",
      "https://www.assemblee-nationale.fr/dyn/opendata/PIONANR5L17B3044.html",
    ]);
    expect(result.raw.canonicalUrl).toBe(
      "https://www.assemblee-nationale.fr/dyn/old/17/propositions/pion3044.asp",
    );
    expect(result.raw.body).toBe(documentHtml);
    expect(document.text).toBe(
      "N° 3044 Actual official document body with enough parliamentary text to prove the official HTML artifact was fetched and stored instead of the surrounding metadata page shell.",
    );
    expect(document.text).not.toContain("Document page shell");
    expect(document.sourceMetadata).toMatchObject({
      landingPageUrl: "https://www.assemblee-nationale.fr/dyn/17/textes/l17b3044_proposition-loi",
      fetchedContentUrl: "https://www.assemblee-nationale.fr/dyn/opendata/PIONANR5L17B3044.html",
    });
  });

  it("fetches deterministic Assemblee nationale opendata HTML without reading the landing page", async () => {
    const documentHtml = `<html><main><h1>N° 3035</h1><p>Direct official opendata document body with enough parliamentary text to prove the deterministic Assemblée URL is used without scraping the landing page first.</p></main></html>`;
    const requestedUrls: string[] = [];
    const fetcher = async (url: string): Promise<FetchResponse> => {
      requestedUrls.push(url);
      if (url === "https://www.assemblee-nationale.fr/17/propositions/pion3035.asp") {
        throw new Error("landing page should not be fetched");
      }
      return response(url, documentHtml, "text/html");
    };

    const adapter = makeFeedAdapter(rssSource, { kind: "rss", fetcher });
    const result = await Effect.runPromise(
      adapter.fetch({
        sourceId: "assemblee_nationale",
        externalId: "pion3035",
        canonicalUrl: "https://www.assemblee-nationale.fr/17/propositions/pion3035.asp",
        title: "Proposition de loi, n° 3035",
        publishedAt: new Date("2026-07-07T00:00:00.000Z"),
      }),
    );

    expect(result.status).toBe("fetched");
    if (result.status !== "fetched") {
      throw new Error("expected fetched result");
    }

    expect(requestedUrls).toEqual([
      "https://www.assemblee-nationale.fr/dyn/opendata/PIONANR5L17B3035.html",
    ]);
    expect(result.raw.metadata).toMatchObject({
      landingPageUrl: "https://www.assemblee-nationale.fr/17/propositions/pion3035.asp",
      fetchedContentUrl: "https://www.assemblee-nationale.fr/dyn/opendata/PIONANR5L17B3035.html",
    });
  });

  it("falls back from obsolete opendata HTML to the canonical official PDF and preserves exact bytes", async () => {
    const pdfBytes = fixturePdfBytes();
    const requestedUrls: string[] = [];
    const fetcher = async (url: string): Promise<FetchResponse> => {
      requestedUrls.push(url);
      if (url.includes("/dyn/opendata/RINFANR5L17B3050.html")) {
        return failedResponse(url, 404);
      }
      return binaryResponse(
        "https://www.assemblee-nationale.fr/dyn/17/rapports/cion-eco/l17b3050_rapport-information.pdf",
        pdfBytes,
        "application/pdf",
      );
    };

    const item = {
      sourceId: "assemblee_nationale",
      externalId: "i3050",
      canonicalUrl: "https://www.assemblee-nationale.fr/17/rap-info/i3050.asp",
      title: "Rapport d'information n° 3050",
      publishedAt: new Date("2026-07-09T00:00:00.000Z"),
    } as const;
    const adapter = makeFeedAdapter(rssSource, { kind: "rss", fetcher });
    const result = await Effect.runPromise(adapter.fetch(item));
    expect(result.status).toBe("fetched");
    if (result.status !== "fetched") throw new Error("expected fetched result");

    expect(requestedUrls).toEqual([
      "https://www.assemblee-nationale.fr/dyn/opendata/RINFANR5L17B3050.html",
      item.canonicalUrl,
    ]);
    expect(result.raw.mediaType).toBe("application/pdf");
    expect(result.raw.body).toBe("");
    expect(result.raw.bodyBytes).toEqual(pdfBytes);
    expect(result.raw.metadata).toMatchObject({
      landingPageUrl: item.canonicalUrl,
      fetchedContentUrl:
        "https://www.assemblee-nationale.fr/dyn/17/rapports/cion-eco/l17b3050_rapport-information.pdf",
    });

    const document = await Effect.runPromise(adapter.normalize(result.raw, item));
    expect(result.raw.bodyBytes).toEqual(pdfBytes);
    expect(document.title).toBe(item.title);
    expect(document.publishedAt).toEqual(item.publishedAt);
    expect(document.textCharCount).toBeGreaterThan(100);
    expect(document.contentHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects a response labelled as PDF when its exact bytes lack the PDF signature", async () => {
    const adapter = makeFeedAdapter(rssSource, {
      kind: "rss",
      fetcher: async (url) =>
        binaryResponse(url, new TextEncoder().encode("not-a-pdf"), "application/pdf"),
    });

    await expect(
      Effect.runPromise(
        adapter.fetch({
          sourceId: "assemblee_nationale",
          externalId: "i3050",
          canonicalUrl: "https://www.assemblee-nationale.fr/17/rap-info/i3050.asp",
          title: "Rapport",
          publishedAt: null,
        }),
      ),
    ).rejects.toThrow("invalid signature");
  });

  it("caps streamed PDFs without trusting Content-Length or materializing arrayBuffer", async () => {
    const overLimit = new Uint8Array(25 * 1024 * 1024 + 1);
    overLimit[0] = 0x25;
    overLimit[1] = 0x50;
    overLimit[2] = 0x44;
    overLimit[3] = 0x46;
    overLimit[4] = 0x2d;
    const adapter = makeFeedAdapter(rssSource, {
      kind: "rss",
      fetcher: async (url) =>
        url.includes("/dyn/opendata/RINFANR5L17B3050.html")
          ? failedResponse(url, 404)
          : streamedBinaryResponse(url, [overLimit], "application/pdf"),
    });

    await expect(
      Effect.runPromise(
        adapter.fetch({
          sourceId: "assemblee_nationale",
          externalId: "i3050",
          canonicalUrl: "https://www.assemblee-nationale.fr/17/rap-info/i3050.asp",
          title: "Rapport",
          publishedAt: null,
        }),
      ),
    ).rejects.toThrow("exceeds its byte limit");
  });

  it("uses the Assemblee nationale iframe raw document when no opendata HTML link exists", async () => {
    const fetcher = async (url: string): Promise<FetchResponse> => {
      if (url === "https://example.test/articles/1") {
        return response(
          url,
          '<main><iframe id="documentIframeContent" src="/dyn/docs/PIONANR5L17B3044.raw"></iframe></main>',
          "text/html",
        );
      }
      return response(
        url,
        "<main><h1>Raw document</h1><p>Official raw document body with enough readable text to pass the content guard and serve as agent-readable HTML.</p></main>",
        "text/html",
      );
    };

    const adapter = makeFeedAdapter(rssSource, { kind: "rss", fetcher });
    const result = await Effect.runPromise(
      adapter.fetch({
        sourceId: "assemblee_nationale",
        externalId: "article-1",
        canonicalUrl: "https://example.test/articles/1",
        title: "Government update",
        publishedAt: null,
      }),
    );

    expect(result.status).toBe("fetched");
    if (result.status !== "fetched") {
      throw new Error("expected fetched result");
    }
    expect(result.raw.metadata).toMatchObject({
      fetchedContentUrl: "https://example.test/dyn/docs/PIONANR5L17B3044.raw",
    });
    expect(result.raw.body).toContain("Official raw document body");
  });

  it("rejects Assemblee nationale official content responses that are still page shells", async () => {
    const fetcher = async (url: string): Promise<FetchResponse> => {
      if (url === "https://example.test/articles/1") {
        return response(
          url,
          '<main><a href="/dyn/opendata/articles-1.html" title="Version opendata HTML du document"></a></main>',
          "text/html",
        );
      }
      return response(
        url,
        '<html><main><iframe id="documentIframeContent" src="/dyn/docs/articles-1.raw"></iframe><p>Document page shell.</p></main></html>',
        "text/html",
      );
    };

    const adapter = makeFeedAdapter(rssSource, { kind: "rss", fetcher });
    await expect(
      Effect.runPromise(
        adapter.fetch({
          sourceId: "assemblee_nationale",
          externalId: "article-1",
          canonicalUrl: "https://example.test/articles/1",
          title: "Government update",
          publishedAt: null,
        }),
      ),
    ).rejects.toThrow("landing page shell");
  });

  it("rejects Assemblee nationale document pages without official content links", async () => {
    const fetcher = async (): Promise<FetchResponse> =>
      response(
        "https://www.assemblee-nationale.fr/dyn/17/textes/l17b3044_proposition-loi",
        "<html><main><p>Only a metadata shell.</p></main></html>",
        "text/html",
      );

    const adapter = makeFeedAdapter(rssSource, { kind: "rss", fetcher });

    await expect(
      Effect.runPromise(
        adapter.fetch({
          sourceId: "assemblee_nationale",
          externalId: "pion3044",
          canonicalUrl: "https://www.assemblee-nationale.fr/dyn/old/17/propositions/pion3044.asp",
          title: "Proposition de loi, n° 3044",
          publishedAt: null,
        }),
      ),
    ).rejects.toThrow("official HTML/PDF document URL");
  });

  it("passes conditional validators to feed discovery", async () => {
    const requestHeaders: string[] = [];
    const fetcher = async (_url: string, init?: RequestInit): Promise<FetchResponse> => {
      const headers = new Headers(init?.headers);
      requestHeaders.push(headers.get("if-none-match") ?? "");
      return response(
        "https://example.test/rss.xml",
        `<?xml version="1.0"?><rss><channel></channel></rss>`,
      );
    };

    const adapter = makeFeedAdapter(rssSource, { kind: "rss", fetcher });
    const discovery = await Effect.runPromise(
      adapter.discover({ validators: { etag: '"feed-cache"' } }),
    );

    expect(discovery.status).toBe("fetched");
    expect(requestHeaders).toEqual(['"feed-cache"']);
  });

  it("returns not_modified when feed discovery gets a conditional cache hit", async () => {
    const fetcher = async (_url: string, init?: RequestInit): Promise<FetchResponse> => {
      const headers = new Headers(init?.headers);
      expect(headers.get("if-none-match")).toBe('"feed-cache"');
      return notModifiedResponse("https://example.test/rss.xml");
    };

    const adapter = makeFeedAdapter(rssSource, { kind: "rss", fetcher });
    const discovery = await Effect.runPromise(
      adapter.discover({ validators: { etag: '"feed-cache"' } }),
    );

    expect(discovery).toMatchObject({
      status: "not_modified",
      sourceId: "assemblee_nationale",
      metadata: [
        {
          url: "https://example.test/rss.xml",
          status: 304,
          etag: '"cached"',
          lastModified: "Mon, 06 Jul 2026 10:00:00 GMT",
        },
      ],
    });
  });

  it("passes conditional validators to item fetches", async () => {
    const requestHeaders: string[] = [];
    const fetcher = async (url: string, init?: RequestInit): Promise<FetchResponse> => {
      const headers = new Headers(init?.headers);
      if (url === "https://example.test/articles/1") {
        requestHeaders.push(headers.get("if-none-match") ?? "");
        return response(
          url,
          '<main><a href="/dyn/opendata/articles-1.html" title="Version opendata HTML du document"></a></main>',
          "text/html",
        );
      }
      return response(
        url,
        "<main>Official document body with enough text to pass the content guard while testing conditional request headers for item fetches.</main>",
        "text/html",
      );
    };

    const adapter = makeFeedAdapter(rssSource, { kind: "rss", fetcher });
    await Effect.runPromise(
      adapter.fetch(
        {
          sourceId: "assemblee_nationale",
          externalId: "article-1",
          canonicalUrl: "https://example.test/articles/1",
          title: "Government update",
          publishedAt: null,
        },
        { validators: { etag: '"abc123"' } },
      ),
    );

    expect(requestHeaders).toEqual(['"abc123"']);
  });

  it("returns not_modified when an item fetch gets a conditional cache hit", async () => {
    const fetcher = async (_url: string, init?: RequestInit): Promise<FetchResponse> => {
      const headers = new Headers(init?.headers);
      expect(headers.get("if-none-match")).toBe('"abc123"');
      return notModifiedResponse("https://example.test/articles/1");
    };

    const adapter = makeFeedAdapter(rssSource, { kind: "rss", fetcher });
    const result = await Effect.runPromise(
      adapter.fetch(
        {
          sourceId: "assemblee_nationale",
          externalId: "article-1",
          canonicalUrl: "https://example.test/articles/1",
          title: "Government update",
          publishedAt: null,
        },
        { validators: { etag: '"abc123"', lastModified: "Mon, 06 Jul 2026 09:00:00 GMT" } },
      ),
    );

    expect(result).toMatchObject({
      status: "not_modified",
      sourceId: "assemblee_nationale",
      canonicalUrl: "https://example.test/articles/1",
      metadata: {
        externalId: "article-1",
        etag: '"cached"',
        lastModified: "Mon, 06 Jul 2026 10:00:00 GMT",
      },
    });
  });

  it("extracts source content instead of whole-page boilerplate", async () => {
    const adapter = makeFeedAdapter(rssSource);
    const document = await Effect.runPromise(
      adapter.normalize(
        {
          sourceId: "assemblee_nationale",
          canonicalUrl: "https://example.test/articles/1",
          fetchedAt: new Date("2026-07-06T10:00:00Z"),
          mediaType: "text/html",
          body: `<html>
            <body>
              <nav>Navigation links</nav>
              <div class="cookie-banner">Cookie notice</div>
              <main><h1>Government update</h1><p>Useful public text.</p></main>
              <footer>Footer links</footer>
            </body>
          </html>`,
        },
        {
          sourceId: "assemblee_nationale",
          externalId: "article-1",
          canonicalUrl: "https://example.test/articles/1",
          title: "Government update",
          publishedAt: null,
        },
      ),
    );

    expect(document.text).toBe("Government update Useful public text.");
    expect(document.text).not.toContain("Navigation links");
    expect(document.text).not.toContain("Cookie notice");
    expect(document.text).not.toContain("Footer links");
  });

  it("decodes numeric HTML entities before hashing canonical text", async () => {
    const adapter = makeFeedAdapter(atomSource, { kind: "atom" });
    const document = await Effect.runPromise(
      adapter.normalize(
        {
          sourceId: "assemblee_nationale",
          canonicalUrl: "https://example.test/notes/1",
          fetchedAt: new Date("2026-07-06T10:00:00Z"),
          mediaType: "text/html",
          body: "<main>Assembl&#233;e nationale</main>",
        },
        {
          sourceId: "assemblee_nationale",
          externalId: "note-1",
          canonicalUrl: "https://example.test/notes/1",
          title: "Parliamentary note",
          publishedAt: null,
        },
      ),
    );

    expect(document.text).toBe("Assemblée nationale");
    expect(document.text).not.toContain("&#233;");
  });

  it("recovers missing publication dates and page titles from fetched HTML metadata", async () => {
    const adapter = makeFeedAdapter(rssSource);
    const document = await Effect.runPromise(
      adapter.normalize(
        {
          sourceId: "assemblee_nationale",
          canonicalUrl: "https://example.test/articles/1",
          fetchedAt: new Date("2026-07-07T10:00:00Z"),
          mediaType: "text/html",
          body: `<html>
            <head>
              <title>Clean page title | Publisher</title>
              <script type="application/ld+json">
                {"@type":"NewsArticle","datePublished":"2026-06-30T00:00:00+02:00"}
              </script>
            </head>
            <main>Useful public text.</main>
          </html>`,
        },
        {
          sourceId: "assemblee_nationale",
          externalId: "article-1",
          canonicalUrl: "https://example.test/articles/1",
          title: "Broken feed title",
          publishedAt: null,
        },
      ),
    );

    expect(document.title).toBe("Clean page title");
    expect(document.publishedAt?.toISOString()).toBe("2026-06-29T22:00:00.000Z");
  });

  it("rejects JavaScript or security challenge pages instead of normalizing them", async () => {
    const adapter = makeFeedAdapter(rssSource);

    await expect(
      Effect.runPromise(
        adapter.normalize(
          {
            sourceId: "assemblee_nationale",
            canonicalUrl: "https://example.test/articles/1",
            fetchedAt: new Date("2026-07-06T10:00:00Z"),
            mediaType: "text/html",
            body: "<html><body>This website requires JS enabled and cookies</body></html>",
          },
          {
            sourceId: "assemblee_nationale",
            externalId: "article-1",
            canonicalUrl: "https://example.test/articles/1",
            title: "Government update",
            publishedAt: null,
          },
        ),
      ),
    ).rejects.toThrow("blocker page");
  });

  it("creates a new document id when fetched content changes", async () => {
    const adapter = makeFeedAdapter(rssSource);
    const item = {
      sourceId: "assemblee_nationale",
      externalId: "article-1",
      canonicalUrl: "https://example.test/articles/1",
      title: "Government update",
      publishedAt: null,
    } as const;

    const first = await Effect.runPromise(
      adapter.normalize(
        {
          sourceId: "assemblee_nationale",
          canonicalUrl: "https://example.test/articles/1",
          fetchedAt: new Date("2026-07-06T10:00:00Z"),
          mediaType: "text/html",
          body: "<main>First body</main>",
        },
        item,
      ),
    );
    const second = await Effect.runPromise(
      adapter.normalize(
        {
          sourceId: "assemblee_nationale",
          canonicalUrl: "https://example.test/articles/1",
          fetchedAt: new Date("2026-07-06T10:05:00Z"),
          mediaType: "text/html",
          body: "<main>Changed body</main>",
        },
        item,
      ),
    );

    expect(first.canonicalUrl).toBe(second.canonicalUrl);
    expect(first.id).not.toBe(second.id);
  });
});
