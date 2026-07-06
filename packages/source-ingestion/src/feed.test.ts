import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeFeedAdapter, parseFeed } from "./feed";
import type { FetchResponse, PublicSourceDefinition } from "./types";

const rssSource = {
  id: "info_gouv",
  displayName: "Info.gouv.fr",
  publisherName: "Gouvernement francais",
  description: "Official Government news and explanations.",
  ingestionMethod: "rss",
  discoveryUrl: "https://example.test/rss.xml",
  expectedCadence: "daily",
  averageCharsPerItem: 1000,
} as const satisfies PublicSourceDefinition;

const atomSource = {
  ...rssSource,
  id: "tresor",
  ingestionMethod: "atom",
  discoveryUrl: "https://example.test/atom.xml",
} as const satisfies PublicSourceDefinition;

const response = (url: string, body: string, contentType = "text/xml"): FetchResponse => ({
  url,
  status: 200,
  ok: true,
  headers: new Headers({ "content-type": contentType }),
  text: async () => body,
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
      sourceId: "info_gouv",
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
          <title>Tresor note</title>
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
      sourceId: "tresor",
      externalId: "tag:example.test,2026:note-1",
      canonicalUrl: "https://example.test/notes/1",
      title: "Tresor note",
      summary: "Macro note",
    });
  });

  it("XML-decodes Atom link attributes", () => {
    const items = parseFeed(
      atomSource,
      `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Tresor &amp; economie</title>
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
      title: "Tresor & economie",
    });
  });

  it("prefers Atom alternate links over earlier self links", () => {
    const items = parseFeed(
      atomSource,
      `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Tresor note</title>
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
          <title>Tresor note</title>
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
    const articleBody =
      "<html><main><h1>Government update</h1><p>Useful public text.</p></main></html>";
    const fetcher = async (url: string): Promise<FetchResponse> =>
      url.endsWith("rss.xml") ? response(url, feedBody) : response(url, articleBody, "text/html");

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
      sourceId: "info_gouv",
      externalId: "article-1",
      canonicalUrl: "https://example.test/articles/1",
      title: "Government update",
      documentType: "article",
      text: "Government update Useful public text.",
      textCharCount: 37,
    });
    expect(document.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(document.id).toContain(document.contentHash.slice(0, 16));
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
      sourceId: "info_gouv",
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
    const fetcher = async (_url: string, init?: RequestInit): Promise<FetchResponse> => {
      const headers = new Headers(init?.headers);
      requestHeaders.push(headers.get("if-none-match") ?? "");
      return response("https://example.test/articles/1", "<main>Body</main>", "text/html");
    };

    const adapter = makeFeedAdapter(rssSource, { kind: "rss", fetcher });
    await Effect.runPromise(
      adapter.fetch(
        {
          sourceId: "info_gouv",
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
          sourceId: "info_gouv",
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
      sourceId: "info_gouv",
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
          sourceId: "info_gouv",
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
          sourceId: "info_gouv",
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
          sourceId: "tresor",
          canonicalUrl: "https://example.test/notes/1",
          fetchedAt: new Date("2026-07-06T10:00:00Z"),
          mediaType: "text/html",
          body: "<main>Direction g&#233;n&#233;rale du Tr&#233;sor</main>",
        },
        {
          sourceId: "tresor",
          externalId: "note-1",
          canonicalUrl: "https://example.test/notes/1",
          title: "Tresor note",
          publishedAt: null,
        },
      ),
    );

    expect(document.text).toBe("Direction générale du Trésor");
    expect(document.text).not.toContain("&#233;");
  });

  it("rejects JavaScript or security challenge pages instead of normalizing them", async () => {
    const adapter = makeFeedAdapter(rssSource);

    await expect(
      Effect.runPromise(
        adapter.normalize(
          {
            sourceId: "info_gouv",
            canonicalUrl: "https://example.test/articles/1",
            fetchedAt: new Date("2026-07-06T10:00:00Z"),
            mediaType: "text/html",
            body: "<html><body>This website requires JS enabled and cookies</body></html>",
          },
          {
            sourceId: "info_gouv",
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
      sourceId: "info_gouv",
      externalId: "article-1",
      canonicalUrl: "https://example.test/articles/1",
      title: "Government update",
      publishedAt: null,
    } as const;

    const first = await Effect.runPromise(
      adapter.normalize(
        {
          sourceId: "info_gouv",
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
          sourceId: "info_gouv",
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
