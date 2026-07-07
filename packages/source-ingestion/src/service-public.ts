import { Effect } from "effect";
import { sha256Hex } from "./hash";
import { decodeHtmlEntities, stableDocumentId, stripHtml } from "./text";
import type {
  CanonicalDocument,
  ConditionalRequestValidators,
  DiscoveredItem,
  DiscoveryFetchMetadata,
  Fetcher,
  PublicSourceDefinition,
  SourceAdapter,
  SourceDiscoveryOptions,
  SourceDiscoveryResult,
  SourceFetchOptions,
  SourceFetchResult,
} from "./types";
import { SourceIngestionError } from "./types";

const decodeXmlText = (value: string): string =>
  decodeHtmlEntities(value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/u, "$1")).trim();

const getBlocks = (xml: string, tag: string): readonly string[] =>
  Array.from(
    xml.matchAll(
      new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/(?:\\w+:)?${tag}>`, "giu"),
    ),
    (match) => match[0],
  );

const getTagText = (block: string, tag: string): string | undefined => {
  const match = new RegExp(
    `<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`,
    "iu",
  ).exec(block);
  return match?.[1] ? decodeXmlText(match[1]) : undefined;
};

const getAttributes = (element: string): Record<string, string> =>
  Object.fromEntries(
    Array.from(
      element.matchAll(/\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(["'])(.*?)\2/gu),
      (match) => [match[1]!, decodeXmlText(match[3] ?? "")],
    ),
  );

const getFirstOpeningTag = (xml: string, tag: string): string | undefined =>
  new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>`, "iu").exec(xml)?.[0];

const getRootAttributes = (xml: string): Record<string, string> =>
  getAttributes(getFirstOpeningTag(xml, "Actualite") ?? "");

const parseDate = (value: string | undefined): Date | null => {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const parseDcDate = (value: string | undefined): Date | null => {
  if (!value) {
    return null;
  }
  return parseDate(value.replace(/^(?:created|modified)\s+/iu, ""));
};

const conditionalRequestInit = (options?: {
  readonly validators?: ConditionalRequestValidators;
}): RequestInit | undefined => {
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

const discoveryRequestInit = (
  url: string,
  options?: SourceDiscoveryOptions,
): RequestInit | undefined => {
  const validators =
    options?.requests?.find((request) => request.url === url)?.validators ?? options?.validators;
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

const resolveXmlUrl = (baseUrl: string, value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
};

const parseDirectoryLinks = (html: string, baseUrl: string): readonly string[] =>
  Array.from(html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/giu), (match) => match[2] ?? "")
    .filter((href) => href && href !== "../")
    .flatMap((href): string[] => {
      try {
        return [new URL(href, baseUrl).toString()];
      } catch {
        return [];
      }
    });

export const servicePublicArticleDirectoryUrl = (resourceUrl: string, body: string): string => {
  const links = parseDirectoryLinks(body, resourceUrl);
  return (
    links.find((url) => /\/xml\/actualites\/?$/iu.test(url)) ??
    links.find((url) => /\/actualites\/?$/iu.test(url)) ??
    new URL("xml/actualites/", resourceUrl).toString()
  );
};

export const parseServicePublicDirectory = (
  source: PublicSourceDefinition,
  body: string,
  directoryUrl: string,
): readonly DiscoveredItem[] =>
  parseDirectoryLinks(body, directoryUrl)
    .filter((url) => /\.xml$/iu.test(url))
    .map((xmlUrl): DiscoveredItem => {
      const externalId =
        xmlUrl
          .split("/")
          .pop()
          ?.replace(/\.xml$/iu, "") ?? xmlUrl;
      return {
        sourceId: source.id,
        externalId,
        canonicalUrl: xmlUrl,
        title: externalId,
        publishedAt: null,
        metadata: {
          datasetUrl: directoryUrl,
          xmlUrl,
        },
      };
    });

export const parseServicePublicArticleXml = (
  source: PublicSourceDefinition,
  body: string,
  xmlUrl: string,
): DiscoveredItem | undefined => {
  const attributes = getRootAttributes(body);
  const externalId = attributes.ID ?? getTagText(body, "identifier") ?? xmlUrl;
  const title = getTagText(body, "title") ?? externalId;
  const canonicalUrl = attributes.spUrl ?? xmlUrl;
  const publishedAt =
    parseDate(attributes.datePremiereMiseEnLigne) ??
    parseDate(attributes.dateMiseAJour) ??
    parseDcDate(getTagText(body, "date"));
  const summary = getTagText(body, "description") ?? getTagText(body, "Introduction");

  return {
    sourceId: source.id,
    externalId,
    canonicalUrl,
    title,
    publishedAt,
    ...(summary ? { summary: stripHtml(summary) } : {}),
    metadata: {
      xmlUrl,
      xmlBody: body,
      type: attributes.type,
      audience: getTagText(body, "Audience"),
    },
  };
};

export const parseServicePublicIndex = (
  source: PublicSourceDefinition,
  body: string,
  indexUrl: string,
): readonly DiscoveredItem[] => {
  const rootBody = body.trim().replace(/^<\?xml\b[\s\S]*?\?>\s*/iu, "");
  if (/^<(?:\w+:)?Actualite(?:\s[^>]*)?>/iu.test(rootBody)) {
    const item = parseServicePublicArticleXml(source, body, indexUrl);
    return item ? [item] : [];
  }

  if (/<html\b/iu.test(body)) {
    return parseServicePublicDirectory(source, body, indexUrl);
  }

  const records = getBlocks(body, "Actualite");
  const blocks = records.length > 0 ? records : getBlocks(body, "item");

  return blocks.flatMap((block): DiscoveredItem[] => {
    const attributes = getRootAttributes(block);
    const externalId = attributes.ID ?? getTagText(block, "ID") ?? getTagText(block, "guid");
    const title = getTagText(block, "title") ?? getTagText(block, "Titre");
    const canonicalUrl =
      attributes.spUrl ?? getTagText(block, "spUrl") ?? getTagText(block, "link");
    const xmlUrl = resolveXmlUrl(
      indexUrl,
      getTagText(block, "xmlUrl") ?? getTagText(block, "fichier") ?? getTagText(block, "xml"),
    );
    if (!externalId || !title || !canonicalUrl) {
      return [];
    }

    const publishedAt =
      parseDate(
        attributes.datePremiereMiseEnLigne ??
          attributes.dateMiseAJour ??
          getTagText(block, "datePublication") ??
          getTagText(block, "pubDate"),
      ) ?? parseDcDate(getTagText(block, "dc:date"));

    const summary = getTagText(block, "description") ?? getTagText(block, "Introduction");
    return [
      {
        sourceId: source.id,
        externalId,
        canonicalUrl,
        title,
        publishedAt,
        ...(summary ? { summary } : {}),
        metadata: {
          datasetUrl: indexUrl,
          ...(xmlUrl ? { xmlUrl } : { xmlBody: body }),
        },
      },
    ];
  });
};

const servicePublicText = (xml: string): string => {
  const parts = [
    getTagText(xml, "SurTitre"),
    getTagText(xml, "Introduction"),
    getTagText(xml, "Texte"),
    ...getBlocks(xml, "Paragraphe").map((block) => getTagText(block, "Paragraphe") ?? block),
  ].filter((value): value is string => Boolean(value));

  return stripHtml(parts.length > 0 ? parts.join(" ") : xml);
};

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const servicePublicArticleHtml = (xml: string): string => {
  const title = getTagText(xml, "title") ?? getTagText(xml, "Titre");
  const parts = [
    getTagText(xml, "SurTitre"),
    getTagText(xml, "Introduction"),
    getTagText(xml, "Texte"),
    ...getBlocks(xml, "Paragraphe").map((block) => getTagText(block, "Paragraphe") ?? block),
  ].filter((value): value is string => Boolean(value));

  const body = parts.length > 0 ? parts.join("\n") : `<pre>${escapeHtml(stripHtml(xml))}</pre>`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">${
    title ? `<title>${escapeHtml(stripHtml(title))}</title>` : ""
  }</head><body><main>${title ? `<h1>${escapeHtml(stripHtml(title))}</h1>` : ""}${body}</main></body></html>`;
};

export const makeServicePublicXmlAdapter = (
  definition: PublicSourceDefinition,
  options: { readonly fetcher?: Fetcher } = {},
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
              throw new SourceIngestionError(
                `Service-Public XML failed with HTTP ${response.status}`,
                {
                  sourceId: definition.id,
                },
              );
            }
            const body = await response.text();
            metadata.push(await responseMetadata(url, response, body));
            const directoryUrl = /<html\b/iu.test(body)
              ? servicePublicArticleDirectoryUrl(url, body)
              : undefined;
            if (directoryUrl) {
              const directoryResponse = await fetcher(
                directoryUrl,
                discoveryRequestInit(directoryUrl, discoverOptions),
              );
              if (directoryResponse.status === 304) {
                metadata.push(await responseMetadata(directoryUrl, directoryResponse));
                fetchedCount += 1;
                continue;
              }
              if (!directoryResponse.ok) {
                throw new SourceIngestionError(
                  `Service-Public XML directory failed with HTTP ${directoryResponse.status}`,
                  { sourceId: definition.id },
                );
              }
              const directoryBody = await directoryResponse.text();
              metadata.push(await responseMetadata(directoryUrl, directoryResponse, directoryBody));
              for (const listed of parseServicePublicDirectory(
                definition,
                directoryBody,
                directoryUrl,
              )) {
                const xmlUrl =
                  typeof listed.metadata?.xmlUrl === "string" ? listed.metadata.xmlUrl : undefined;
                if (!xmlUrl) {
                  continue;
                }
                const xmlResponse = await fetcher(xmlUrl);
                if (!xmlResponse.ok) {
                  throw new SourceIngestionError(
                    `Service-Public item XML failed with HTTP ${xmlResponse.status}`,
                    { sourceId: definition.id },
                  );
                }
                const xmlBody = await xmlResponse.text();
                const item = parseServicePublicArticleXml(definition, xmlBody, xmlUrl);
                if (item) {
                  items.push(item);
                }
              }
            } else {
              items.push(...parseServicePublicIndex(definition, body, url));
            }
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
            : new SourceIngestionError("Service-Public XML discovery failed", {
                sourceId: definition.id,
                cause,
              }),
      }),
    fetch: (item, fetchOptions?: SourceFetchOptions) =>
      Effect.tryPromise({
        try: async () => {
          const xmlBody =
            typeof item.metadata?.xmlBody === "string" ? item.metadata.xmlBody : undefined;
          if (xmlBody) {
            return {
              status: "fetched",
              raw: {
                sourceId: definition.id,
                canonicalUrl: item.canonicalUrl,
                fetchedAt: new Date(),
                mediaType: "text/html",
                body: servicePublicArticleHtml(xmlBody),
                metadata: {
                  externalId: item.externalId,
                  datasetUrl: item.metadata?.datasetUrl,
                  xmlUrl: item.metadata?.xmlUrl,
                  officialXmlMediaType: "application/xml",
                },
              },
            } satisfies SourceFetchResult;
          }

          const xmlUrl =
            typeof item.metadata?.xmlUrl === "string" ? item.metadata.xmlUrl : undefined;
          if (!xmlUrl) {
            throw new SourceIngestionError("Service-Public item has no official XML URL", {
              sourceId: definition.id,
            });
          }
          const response = await fetcher(xmlUrl, conditionalRequestInit(fetchOptions));
          if (response.status === 304) {
            return {
              status: "not_modified",
              sourceId: definition.id,
              canonicalUrl: item.canonicalUrl,
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
            throw new SourceIngestionError(
              `Service-Public item XML failed with HTTP ${response.status}`,
              { sourceId: definition.id },
            );
          }
          const body = await response.text();
          return {
            status: "fetched",
            raw: {
              sourceId: definition.id,
              canonicalUrl: item.canonicalUrl,
              fetchedAt: new Date(),
              mediaType: "text/html",
              body: servicePublicArticleHtml(body),
              metadata: {
                externalId: item.externalId,
                xmlUrl,
                officialXmlMediaType: response.headers.get("content-type") ?? "application/xml",
                etag: response.headers.get("etag") ?? undefined,
                lastModified: response.headers.get("last-modified") ?? undefined,
              },
            },
          } satisfies SourceFetchResult;
        },
        catch: (cause) =>
          cause instanceof SourceIngestionError
            ? cause
            : new SourceIngestionError("Service-Public XML fetch failed", {
                sourceId: definition.id,
                cause,
              }),
      }),
    normalize: (raw, item) =>
      Effect.tryPromise({
        try: async () => {
          const text = servicePublicText(raw.body);
          const contentHash = await sha256Hex(text);
          return {
            id: stableDocumentId(definition.id, raw.canonicalUrl, contentHash),
            sourceId: definition.id,
            ...(item?.externalId ? { externalId: item.externalId } : {}),
            canonicalUrl: raw.canonicalUrl,
            title:
              getTagText(raw.body, "title") ??
              getTagText(raw.body, "Titre") ??
              item?.title ??
              raw.canonicalUrl,
            publishedAt:
              item?.publishedAt ??
              parseDate(
                getRootAttributes(raw.body).datePremiereMiseEnLigne ??
                  getRootAttributes(raw.body).dateMiseAJour ??
                  getTagText(raw.body, "datePublication"),
              ) ??
              parseDcDate(getTagText(raw.body, "dc:date")),
            discoveredAt: item?.discoveredAt ?? raw.fetchedAt,
            fetchedAt: raw.fetchedAt,
            language: "fr",
            documentType: "article",
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
            : new SourceIngestionError("Service-Public XML normalization failed", {
                sourceId: definition.id,
                cause,
              }),
      }),
  };
};
