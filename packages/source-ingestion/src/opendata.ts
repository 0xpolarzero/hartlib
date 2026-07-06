import { Effect } from "effect";
import { parseFeed } from "./feed";
import { sha256Hex } from "./hash";
import { stableDocumentId, stripHtml } from "./text";
import type {
  CanonicalDocument,
  DiscoveryFetchMetadata,
  DiscoveredItem,
  Fetcher,
  PublicSourceDefinition,
  SourceFetchOptions,
  SourceAdapter,
  SourceDiscoveryOptions,
  SourceDiscoveryResult,
  SourceFetchResult,
} from "./types";
import { SourceIngestionError } from "./types";

type BofipRecord = {
  readonly type?: string;
  readonly titre?: string;
  readonly debut_de_validite?: string;
  readonly serie?: string;
  readonly division?: string;
  readonly identifiant_juridique?: string;
  readonly permalien?: string;
  readonly contenu?: string;
  readonly contenu_html?: string;
};

type OpendataResponse = {
  readonly results?: readonly BofipRecord[];
};

const readJson = (body: string): OpendataResponse => {
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  return parsed as OpendataResponse;
};

const recordUrl = (record: BofipRecord): string | undefined =>
  record.permalien ?? record.identifiant_juridique;

const recordTitle = (record: BofipRecord): string | undefined =>
  record.titre ?? record.identifiant_juridique;

const bofipIdFromUrl = (url: string): string | undefined => {
  const match = /\/(ACTU-\d{4}-\d+)(?:[/?#]|$)/iu.exec(url);
  return match?.[1]?.toUpperCase();
};

const bofipPublishedAtFromSummary = (summary: string | undefined): Date | null => {
  if (!summary) {
    return null;
  }

  const match = /publi[ée]\s+le\s+(\d{2})\/(\d{2})\/(\d{4})/iu.exec(summary);
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }

  const date = new Date(`${match[3]}-${match[2]}-${match[1]}T00:00:00.000Z`);
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

export const parseBofipDataset = (
  source: PublicSourceDefinition,
  body: string,
): readonly DiscoveredItem[] => {
  const parsed = readJson(body);
  return (parsed.results ?? []).flatMap((record): DiscoveredItem[] => {
    const canonicalUrl = recordUrl(record);
    const title = recordTitle(record);
    if (!canonicalUrl || !title) {
      return [];
    }

    const publishedAt = record.debut_de_validite ? new Date(record.debut_de_validite) : null;
    return [
      {
        sourceId: source.id,
        externalId: record.identifiant_juridique ?? canonicalUrl,
        canonicalUrl,
        title,
        publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
        metadata: {
          type: record.type,
          serie: record.serie,
          division: record.division,
        },
      },
    ];
  });
};

export const parseBofipUpdateFeed = (
  source: PublicSourceDefinition,
  body: string,
): readonly DiscoveredItem[] =>
  parseFeed(source, body, "rss").flatMap((item): DiscoveredItem[] => {
    const externalId = bofipIdFromUrl(item.canonicalUrl);
    if (!externalId) {
      return [];
    }

    return [
      {
        ...item,
        externalId,
        publishedAt: item.publishedAt ?? bofipPublishedAtFromSummary(item.summary),
        metadata: {
          ...item.metadata,
          discoveryMethod: "bofip_rss",
        },
      },
    ];
  });

export const makeBofipDatasetAdapter = (
  definition: PublicSourceDefinition,
  options: { readonly fetcher?: Fetcher } = {},
): SourceAdapter => {
  const fetcher = options.fetcher ?? fetch;
  const updateFeedUrl = definition.discoveryUrl;
  const datasetUrl = definition.contentUrl ?? definition.discoveryUrl;

  return {
    definition,
    discover: (discoverOptions) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetcher(
            updateFeedUrl,
            discoveryRequestInit(updateFeedUrl, discoverOptions),
          );
          if (response.status === 304) {
            return {
              status: "not_modified",
              sourceId: definition.id,
              discoveredAt: new Date(),
              metadata: [await responseMetadata(updateFeedUrl, response)],
            } satisfies SourceDiscoveryResult;
          }

          if (!response.ok) {
            throw new SourceIngestionError(
              `Dataset discovery failed with HTTP ${response.status}`,
              {
                sourceId: definition.id,
              },
            );
          }
          const body = await response.text();
          return {
            status: "fetched",
            items: parseBofipUpdateFeed(definition, body),
            discoveredAt: new Date(),
            metadata: [await responseMetadata(updateFeedUrl, response, body)],
          } satisfies SourceDiscoveryResult;
        },
        catch: (cause) =>
          cause instanceof SourceIngestionError
            ? cause
            : new SourceIngestionError("Dataset discovery failed", {
                sourceId: definition.id,
                cause,
              }),
      }),
    fetch: (item, fetchOptions) =>
      Effect.tryPromise({
        try: async () => {
          const params = new URLSearchParams({
            where: `identifiant_juridique="${item.externalId}"`,
            limit: "1",
          });
          const response = await fetcher(
            `${datasetUrl}?${params.toString()}`,
            conditionalRequestInit(fetchOptions),
          );
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
              `Dataset record fetch failed with HTTP ${response.status}`,
              {
                sourceId: definition.id,
              },
            );
          }
          const body = await response.text();
          return {
            status: "fetched",
            raw: {
              sourceId: definition.id,
              canonicalUrl: item.canonicalUrl,
              fetchedAt: new Date(),
              mediaType: response.headers.get("content-type") ?? "application/json",
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
            : new SourceIngestionError("Dataset record fetch failed", {
                sourceId: definition.id,
                cause,
              }),
      }),
    normalize: (raw, item) =>
      Effect.tryPromise({
        try: async () => {
          const [record] = readJson(raw.body).results ?? [];
          if (!record) {
            throw new SourceIngestionError(
              "Dataset record normalization skipped: record not found",
              {
                sourceId: definition.id,
              },
            );
          }

          const content = record.contenu_html ?? record.contenu;
          if (!content) {
            throw new SourceIngestionError(
              "Dataset record normalization skipped: record has no content",
              {
                sourceId: definition.id,
              },
            );
          }

          const text = stripHtml(content);
          const contentHash = await sha256Hex(text);
          const externalId = item?.externalId ?? record.identifiant_juridique;
          return {
            id: stableDocumentId(definition.id, raw.canonicalUrl, contentHash),
            sourceId: definition.id,
            ...(externalId ? { externalId } : {}),
            canonicalUrl: raw.canonicalUrl,
            title: item?.title ?? record.titre ?? raw.canonicalUrl,
            publishedAt: item?.publishedAt ?? null,
            discoveredAt: item?.discoveredAt ?? raw.fetchedAt,
            fetchedAt: raw.fetchedAt,
            language: "fr",
            documentType: "doctrine_update",
            text,
            textCharCount: text.length,
            contentHash,
            rawArtifactKey: `${definition.id}/${contentHash}`,
            sourceMetadata: {
              ingestionMethod: definition.ingestionMethod,
              type: record.type,
              serie: record.serie,
              division: record.division,
              mediaType: raw.mediaType,
            },
          } satisfies CanonicalDocument;
        },
        catch: (cause) =>
          cause instanceof SourceIngestionError
            ? cause
            : new SourceIngestionError("Dataset record normalization failed", {
                sourceId: definition.id,
                cause,
              }),
      }),
  };
};
