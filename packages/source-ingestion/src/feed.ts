import { Effect } from "effect";
import { sha256Hex } from "./hash";
import {
  extractSourceContentText,
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
    const summary =
      getTagText(entry, "description") ??
      getTagText(entry, "summary") ??
      getTagText(entry, "content");

    return [
      {
        sourceId: source.id,
        externalId,
        canonicalUrl,
        title,
        publishedAt,
        ...(summary ? { summary: stripHtml(summary) } : {}),
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
            const response = await fetcher(url, discoveryRequestInit(url, discoverOptions));
            if (response.status === 304) {
              metadata.push(await responseMetadata(url, response));
              continue;
            }

            if (!response.ok) {
              throw new SourceIngestionError(`Feed discovery failed with HTTP ${response.status}`, {
                sourceId: definition.id,
              });
            }

            const body = await response.text();
            metadata.push(await responseMetadata(url, response, body));
            items.push(...parseFeed(definition, body, options.kind));
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
          const response = await fetcher(item.canonicalUrl, conditionalRequestInit(fetchOptions));
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
          const body = await response.text();
          return {
            status: "fetched",
            raw: {
              sourceId: definition.id,
              canonicalUrl: response.url || item.canonicalUrl,
              fetchedAt: new Date(),
              mediaType: response.headers.get("content-type") ?? "text/html",
              body,
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
          return {
            id: stableDocumentId(definition.id, raw.canonicalUrl, contentHash),
            sourceId: definition.id,
            ...(item?.externalId ? { externalId: item.externalId } : {}),
            canonicalUrl: raw.canonicalUrl,
            title: item?.title ?? raw.canonicalUrl,
            publishedAt: item?.publishedAt ?? null,
            discoveredAt: item?.discoveredAt ?? raw.fetchedAt,
            fetchedAt: raw.fetchedAt,
            language: "fr",
            documentType: definition.id === "senat_press" ? "press_release" : "article",
            text,
            textCharCount: text.length,
            contentHash,
            rawArtifactKey: `${definition.id}/${contentHash}`,
            sourceMetadata: {
              ingestionMethod: definition.ingestionMethod,
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
