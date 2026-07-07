import { Effect } from "effect";
import { sha256Hex } from "./hash";
import {
  extractSourceContentText,
  extractHtmlPublishedAt,
  extractHtmlTitle,
  rejectBlockedSourceContent,
  stableDocumentId,
  stripHtml,
} from "./text";
import type {
  CanonicalDocument,
  ConditionalRequestValidators,
  DiscoveredItem,
  DiscoveryFetchMetadata,
  Fetcher,
  PublicSourceDefinition,
  SourceFetchOptions,
  SourceAdapter,
  SourceDiscoveryOptions,
  SourceDiscoveryResult,
  SourceFetchResult,
} from "./types";
import { SourceIngestionError } from "./types";

type FeedKind = "rss" | "atom";

const decodeXmlEntities = (value: string): string =>
  value
    .replace(/&#x([0-9a-f]+);/giu, (_match, codepoint: string) =>
      String.fromCodePoint(Number.parseInt(codepoint, 16)),
    )
    .replace(/&#([0-9]+);/gu, (_match, codepoint: string) =>
      String.fromCodePoint(Number.parseInt(codepoint, 10)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");

const decodeXmlText = (value: string): string =>
  decodeXmlEntities(value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/u, "$1")).trim();

const getBlocks = (xml: string, tag: string): readonly string[] =>
  Array.from(
    xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "giu")),
    (match) => match[0],
  );

const getTagText = (block: string, tag: string): string | undefined => {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "iu").exec(block);
  return match?.[1] ? decodeXmlText(match[1]) : undefined;
};

const getRssLink = (item: string): string | undefined =>
  getTagText(item, "link") ?? getTagText(item, "guid");

const getAttributes = (element: string): Record<string, string> =>
  Object.fromEntries(
    Array.from(
      element.matchAll(/\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(["'])(.*?)\2/gu),
      (match) => [match[1]!.toLowerCase(), decodeXmlText(match[3] ?? "")],
    ),
  );

const getAtomLink = (entry: string): string | undefined => {
  const links = Array.from(entry.matchAll(/<link\b[^>]*\/?>/giu), (match) =>
    getAttributes(match[0]),
  ).filter((attributes) => attributes.href);
  const alternate = links.find((attributes) => {
    const rels = (attributes.rel ?? "alternate").toLowerCase().split(/\s+/u);
    return rels.includes("alternate");
  });

  return alternate?.href ?? links.find((attributes) => attributes.rel !== "self")?.href;
};

const parseDate = (value: string | undefined): Date | null => {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const conditionalRequestInit = (options?: SourceFetchOptions): RequestInit | undefined => {
  if (!options?.validators?.etag && !options?.validators?.lastModified) {
    return undefined;
  }

  const headers = new Headers();
  if (options.validators.etag) {
    headers.set("if-none-match", options.validators.etag);
  }
  if (options.validators.lastModified) {
    headers.set("if-modified-since", options.validators.lastModified);
  }
  return { headers };
};

const validatorsForUrl = (
  url: string,
  options?: SourceDiscoveryOptions,
): ConditionalRequestValidators | undefined =>
  options?.requests?.find((request) => request.url === url)?.validators ?? options?.validators;

const defaultFetchTimeoutMs = 30_000;

const withTimeoutSignal = async <A>(operation: (signal: AbortSignal) => Promise<A>): Promise<A> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), defaultFetchTimeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
};

const fetchTextWithTimeout = async (
  fetcher: Fetcher,
  url: string,
  init?: RequestInit,
): Promise<{
  readonly response: Awaited<ReturnType<Fetcher>>;
  readonly body: string | undefined;
}> =>
  withTimeoutSignal(async (signal) => {
    const response = await fetcher(url, {
      ...init,
      signal,
    });
    const body = response.status === 304 ? undefined : await response.text();
    return { response, body };
  });

const discoveryRequestInit = (
  url: string,
  options?: SourceDiscoveryOptions,
): RequestInit | undefined => {
  const validators = validatorsForUrl(url, options);
  return validators ? conditionalRequestInit({ validators }) : undefined;
};

const responseMetadata = async (
  url: string,
  response: Awaited<ReturnType<Fetcher>>,
  body?: string,
): Promise<DiscoveryFetchMetadata> => {
  const etag = response.headers.get("etag") ?? undefined;
  const lastModified = response.headers.get("last-modified") ?? undefined;
  const bodyHash = body ? await sha256Hex(body) : undefined;
  return {
    url,
    status: response.status,
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {}),
    ...(bodyHash ? { bodyHash } : {}),
  };
};

const absoluteUrl = (baseUrl: string, value: string): string => new URL(value, baseUrl).href;

const extractHtmlAttribute = (tag: string, attribute: string): string | undefined => {
  const match = new RegExp(`\\s${attribute}\\s*=\\s*(["'])(.*?)\\1`, "iu").exec(tag);
  return match?.[2] ? decodeXmlEntities(match[2]).trim() : undefined;
};

const assembleeOpendataUrlFromCanonicalUrl = (canonicalUrl: string): string | undefined => {
  const url = new URL(canonicalUrl);
  const path = url.pathname;
  const legislature = path.match(/^\/(\d+)\//u)?.[1];
  if (!legislature) {
    return undefined;
  }

  const base = `${url.origin}/dyn/opendata`;
  const proposal = /^\/\d+\/propositions\/pion(\d+)\.asp$/iu.exec(path)?.[1];
  if (proposal) {
    return `${base}/PIONANR5L${legislature}B${proposal}.html`;
  }

  const bill = /^\/\d+\/projets\/pl(\d+)\.asp$/iu.exec(path)?.[1];
  if (bill) {
    return `${base}/PRJLANR5L${legislature}B${bill}.html`;
  }

  const report = /^\/\d+\/rap-info\/i(\d+)\.asp$/iu.exec(path)?.[1];
  if (report) {
    return `${base}/RINFANR5L${legislature}B${report}.html`;
  }

  const adoptedText = /^\/\d+\/ta\/ta(\d+)\.asp$/iu.exec(path)?.[1];
  if (adoptedText) {
    return `${base}/PRJLANR5L${legislature}BTA${adoptedText}.html`;
  }

  return undefined;
};

const assembleeDocumentContentUrl = (landingUrl: string, html: string): string | undefined => {
  const opendataHtmlLink = Array.from(html.matchAll(/<a\b[^>]*>/giu), (match) => match[0])
    .map((tag) => extractHtmlAttribute(tag, "href"))
    .find((href) => href?.includes("/dyn/opendata/") && href.endsWith(".html"));
  if (opendataHtmlLink) {
    return absoluteUrl(landingUrl, opendataHtmlLink);
  }

  const rawIframe = /<iframe\b[^>]*\bid=["']documentIframeContent["'][^>]*>/iu.exec(html)?.[0];
  const rawSrc = rawIframe ? extractHtmlAttribute(rawIframe, "src") : undefined;
  if (rawSrc?.includes("/dyn/docs/") && rawSrc.endsWith(".raw")) {
    return absoluteUrl(landingUrl, rawSrc);
  }

  return undefined;
};

const assertUsableAssembleeDocumentBody = (
  definition: PublicSourceDefinition,
  mediaType: string,
  body: string,
): string => {
  const lowerMediaType = mediaType.toLowerCase();
  if (!lowerMediaType.includes("html") && !lowerMediaType.includes("text")) {
    throw new SourceIngestionError(
      "Assemblee nationale official document fetch returned an unsupported media type",
      { sourceId: definition.id },
    );
  }

  if (/<iframe\b[^>]*\bid=["']documentIframeContent["']/iu.test(body)) {
    throw new SourceIngestionError(
      "Assemblee nationale official document fetch returned the landing page shell",
      { sourceId: definition.id },
    );
  }

  const text = rejectBlockedSourceContent(
    definition.id,
    extractSourceContentText(definition.id, body),
  );
  if (text.length < 100) {
    throw new SourceIngestionError(
      "Assemblee nationale official document fetch returned unusably short content",
      { sourceId: definition.id },
    );
  }

  return body;
};

export const parseFeed = (
  source: PublicSourceDefinition,
  xml: string,
  kind: FeedKind,
): readonly DiscoveredItem[] => {
  const entries = kind === "rss" ? getBlocks(xml, "item") : getBlocks(xml, "entry");

  return entries.flatMap((entry): DiscoveredItem[] => {
    const canonicalUrl = kind === "rss" ? getRssLink(entry) : getAtomLink(entry);
    const title = getTagText(entry, "title");
    if (!canonicalUrl || !title) {
      return [];
    }

    const publishedAt = parseDate(
      kind === "rss"
        ? getTagText(entry, "pubDate")
        : (getTagText(entry, "published") ?? getTagText(entry, "updated")),
    );
    const externalId = getTagText(entry, "guid") ?? getTagText(entry, "id") ?? canonicalUrl;
    const contentHtml = kind === "atom" ? getTagText(entry, "content") : undefined;
    const summary = getTagText(entry, "description") ?? getTagText(entry, "summary") ?? contentHtml;

    return [
      {
        sourceId: source.id,
        externalId,
        canonicalUrl,
        title,
        publishedAt,
        ...(summary ? { summary: stripHtml(summary) } : {}),
        ...(contentHtml
          ? {
              metadata: {
                contentHtml,
              },
            }
          : {}),
      },
    ];
  });
};

export const makeFeedAdapter = (
  definition: PublicSourceDefinition,
  options: { readonly kind: FeedKind; readonly fetcher?: Fetcher } = { kind: "rss" },
): SourceAdapter => {
  const fetcher = options.fetcher ?? fetch;
  const discoveryUrls = definition.discoveryUrls ?? [definition.discoveryUrl];

  return {
    definition,
    discover: (discoverOptions) =>
      Effect.tryPromise({
        try: async () => {
          const discoveredAt = new Date();
          const metadata: DiscoveryFetchMetadata[] = [];
          const items: DiscoveredItem[] = [];
          let fetchedCount = 0;

          for (const url of discoveryUrls) {
            const { response, body } = await fetchTextWithTimeout(
              fetcher,
              url,
              discoveryRequestInit(url, discoverOptions),
            );
            if (response.status === 304) {
              metadata.push(await responseMetadata(url, response));
              continue;
            }

            if (!response.ok) {
              throw new SourceIngestionError(`Feed discovery failed with HTTP ${response.status}`, {
                sourceId: definition.id,
              });
            }

            metadata.push(await responseMetadata(url, response, body ?? ""));
            items.push(...parseFeed(definition, body ?? "", options.kind));
            fetchedCount += 1;
          }

          if (fetchedCount === 0) {
            return {
              status: "not_modified",
              sourceId: definition.id,
              discoveredAt,
              metadata,
            } satisfies SourceDiscoveryResult;
          }

          return {
            status: "fetched",
            items,
            discoveredAt,
            metadata,
          } satisfies SourceDiscoveryResult;
        },
        catch: (cause) =>
          cause instanceof SourceIngestionError
            ? cause
            : new SourceIngestionError("Feed discovery failed", { sourceId: definition.id, cause }),
      }),
    fetch: (item, fetchOptions) =>
      Effect.tryPromise({
        try: async () => {
          const contentHtml =
            definition.id === "tresor" && typeof item.metadata?.contentHtml === "string"
              ? item.metadata.contentHtml
              : undefined;
          if (contentHtml) {
            return {
              status: "fetched",
              raw: {
                sourceId: definition.id,
                canonicalUrl: item.canonicalUrl,
                fetchedAt: new Date(),
                mediaType: "text/html",
                body: contentHtml,
                metadata: {
                  externalId: item.externalId,
                  embeddedFeedContent: true,
                },
              },
            } satisfies SourceFetchResult;
          }

          if (definition.id === "tresor") {
            throw new SourceIngestionError(
              "Tresor Atom item did not include embedded official HTML content",
              { sourceId: definition.id },
            );
          }

          if (definition.id === "assemblee_nationale") {
            const directContentUrl = assembleeOpendataUrlFromCanonicalUrl(item.canonicalUrl);
            if (directContentUrl) {
              const { response: contentResponse, body: contentBodyText } =
                await fetchTextWithTimeout(
                  fetcher,
                  directContentUrl,
                  conditionalRequestInit(fetchOptions),
                );

              if (contentResponse.status === 304) {
                return {
                  status: "not_modified",
                  sourceId: definition.id,
                  canonicalUrl: item.canonicalUrl,
                  fetchedAt: new Date(),
                  metadata: {
                    externalId: item.externalId,
                    landingPageUrl: item.canonicalUrl,
                    fetchedContentUrl: contentResponse.url || directContentUrl,
                    etag: contentResponse.headers.get("etag") ?? fetchOptions?.validators?.etag,
                    lastModified:
                      contentResponse.headers.get("last-modified") ??
                      fetchOptions?.validators?.lastModified,
                  },
                } satisfies SourceFetchResult;
              }

              if (!contentResponse.ok) {
                throw new SourceIngestionError(
                  `Assemblee nationale document fetch failed with HTTP ${contentResponse.status}`,
                  {
                    sourceId: definition.id,
                  },
                );
              }

              const mediaType = contentResponse.headers.get("content-type") ?? "text/html";
              const contentBody = assertUsableAssembleeDocumentBody(
                definition,
                mediaType,
                contentBodyText ?? "",
              );

              return {
                status: "fetched",
                raw: {
                  sourceId: definition.id,
                  canonicalUrl: item.canonicalUrl,
                  fetchedAt: new Date(),
                  mediaType,
                  body: contentBody,
                  metadata: {
                    externalId: item.externalId,
                    landingPageUrl: item.canonicalUrl,
                    fetchedContentUrl: contentResponse.url || directContentUrl,
                    etag: contentResponse.headers.get("etag") ?? undefined,
                    lastModified: contentResponse.headers.get("last-modified") ?? undefined,
                  },
                },
              } satisfies SourceFetchResult;
            }
          }

          const { response, body } = await fetchTextWithTimeout(
            fetcher,
            item.canonicalUrl,
            conditionalRequestInit(fetchOptions),
          );
          if (response.status === 304) {
            return {
              status: "not_modified",
              sourceId: definition.id,
              canonicalUrl: response.url || item.canonicalUrl,
              fetchedAt: new Date(),
              metadata: {
                externalId: item.externalId,
                etag: response.headers.get("etag") ?? fetchOptions?.validators?.etag,
                lastModified:
                  response.headers.get("last-modified") ?? fetchOptions?.validators?.lastModified,
              },
            } satisfies SourceFetchResult;
          }

          if (!response.ok) {
            throw new SourceIngestionError(`Item fetch failed with HTTP ${response.status}`, {
              sourceId: definition.id,
            });
          }

          if (definition.id === "assemblee_nationale") {
            const contentUrl = assembleeDocumentContentUrl(
              response.url || item.canonicalUrl,
              body ?? "",
            );
            if (!contentUrl) {
              throw new SourceIngestionError(
                "Assemblee nationale document page did not expose an official HTML document URL",
                {
                  sourceId: definition.id,
                },
              );
            }

            const { response: contentResponse, body: contentBodyText } = await fetchTextWithTimeout(
              fetcher,
              contentUrl,
            );
            if (!contentResponse.ok) {
              throw new SourceIngestionError(
                `Assemblee nationale document fetch failed with HTTP ${contentResponse.status}`,
                {
                  sourceId: definition.id,
                },
              );
            }

            const mediaType = contentResponse.headers.get("content-type") ?? "text/html";
            const contentBody = assertUsableAssembleeDocumentBody(
              definition,
              mediaType,
              contentBodyText ?? "",
            );

            return {
              status: "fetched",
              raw: {
                sourceId: definition.id,
                canonicalUrl: item.canonicalUrl,
                fetchedAt: new Date(),
                mediaType,
                body: contentBody,
                metadata: {
                  externalId: item.externalId,
                  landingPageUrl: response.url || item.canonicalUrl,
                  fetchedContentUrl: contentResponse.url || contentUrl,
                  etag: contentResponse.headers.get("etag") ?? undefined,
                  lastModified: contentResponse.headers.get("last-modified") ?? undefined,
                },
              },
            } satisfies SourceFetchResult;
          }

          return {
            status: "fetched",
            raw: {
              sourceId: definition.id,
              canonicalUrl: response.url || item.canonicalUrl,
              fetchedAt: new Date(),
              mediaType: response.headers.get("content-type") ?? "text/html",
              body: body ?? "",
              metadata: {
                externalId: item.externalId,
                etag: response.headers.get("etag") ?? undefined,
                lastModified: response.headers.get("last-modified") ?? undefined,
              },
            },
          } satisfies SourceFetchResult;
        },
        catch: (cause) =>
          cause instanceof SourceIngestionError
            ? cause
            : new SourceIngestionError("Item fetch failed", { sourceId: definition.id, cause }),
      }),
    normalize: (raw, item) =>
      Effect.tryPromise({
        try: async () => {
          const text = rejectBlockedSourceContent(
            definition.id,
            extractSourceContentText(definition.id, raw.body),
          );
          const contentHash = await sha256Hex(text);
          const publishedAt = item?.publishedAt ?? extractHtmlPublishedAt(raw.body);
          const title = extractHtmlTitle(raw.body) ?? item?.title ?? raw.canonicalUrl;
          return {
            id: stableDocumentId(definition.id, raw.canonicalUrl, contentHash),
            sourceId: definition.id,
            ...(item?.externalId ? { externalId: item.externalId } : {}),
            canonicalUrl: raw.canonicalUrl,
            title,
            publishedAt,
            discoveredAt: item?.discoveredAt ?? raw.fetchedAt,
            fetchedAt: raw.fetchedAt,
            language: "fr",
            documentType: definition.id === "assemblee_nationale" ? "publication" : "article",
            text,
            textCharCount: text.length,
            contentHash,
            rawArtifactKey: `${definition.id}/${contentHash}`,
            sourceMetadata: {
              ingestionMethod: definition.ingestionMethod,
              contentFormats: definition.contentFormats,
              mediaType: raw.mediaType,
              ...raw.metadata,
            },
          } satisfies CanonicalDocument;
        },
        catch: (cause) =>
          cause instanceof SourceIngestionError
            ? cause
            : new SourceIngestionError("Item normalization failed", {
                sourceId: definition.id,
                cause,
              }),
      }),
  };
};
