import { Effect } from "effect";
import { sha256Hex } from "./hash";
import { fetchPublicSourceText } from "./http";
import { canonicalizeSourceCanonicalUrl, makeSourcePolicyFetcher } from "./source-url-policy";
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

const recordMatchesExternalId = (record: BofipRecord, externalId: string | undefined): boolean =>
  !externalId || record.identifiant_juridique === externalId;

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const recordContent = (record: BofipRecord): string | undefined =>
  record.contenu_html ?? (record.contenu ? `<pre>${escapeHtml(record.contenu)}</pre>` : undefined);

const firstRecord = (body: string, definition: PublicSourceDefinition): BofipRecord => {
  const [record] = readJson(body).results ?? [];
  if (!record) {
    throw new SourceIngestionError("Dataset record normalization skipped: record not found", {
      sourceId: definition.id,
    });
  }
  return record;
};

const stringMetadata = (
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
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
    const candidateUrl = recordUrl(record);
    const canonicalUrl = candidateUrl ? canonicalizeSourceCanonicalUrl(source, candidateUrl) : null;
    const title = recordTitle(record);
    if (canonicalUrl === null || !title) {
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

export const makeBofipDatasetAdapter = (
  definition: PublicSourceDefinition,
  options: { readonly fetcher?: Fetcher } = {},
): SourceAdapter => {
  const fetcher = makeSourcePolicyFetcher(definition, options.fetcher ?? fetch);
  const datasetUrl = definition.contentUrl ?? definition.discoveryUrl;

  return {
    definition,
    discover: (discoverOptions) =>
      Effect.tryPromise({
        try: async () => {
          const params = new URLSearchParams({
            order_by: "debut_de_validite desc",
            limit: "50",
          });
          const discoveryUrl = `${datasetUrl}?${params.toString()}`;
          const { response, body } = await fetchPublicSourceText(
            fetcher,
            definition.id,
            discoveryUrl,
            discoveryRequestInit(discoveryUrl, discoverOptions),
          );
          if (response.status === 304) {
            return {
              status: "not_modified",
              sourceId: definition.id,
              discoveredAt: new Date(),
              metadata: [await responseMetadata(discoveryUrl, response)],
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
          return {
            status: "fetched",
            items: parseBofipDataset(definition, body ?? ""),
            discoveredAt: new Date(),
            metadata: [await responseMetadata(discoveryUrl, response, body)],
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
          const { response, body } = await fetchPublicSourceText(
            fetcher,
            definition.id,
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
          const record = firstRecord(body ?? "", definition);
          if (!recordMatchesExternalId(record, item.externalId)) {
            throw new SourceIngestionError(
              "Dataset record fetch skipped: fetched record does not match requested item",
              {
                sourceId: definition.id,
              },
            );
          }
          const content = recordContent(record);
          if (!content) {
            throw new SourceIngestionError("Dataset record fetch skipped: record has no content", {
              sourceId: definition.id,
            });
          }
          return {
            status: "fetched",
            raw: {
              sourceId: definition.id,
              canonicalUrl: item.canonicalUrl,
              fetchedAt: new Date(),
              mediaType: "text/html",
              body: content,
              metadata: {
                externalId: item.externalId,
                title: record.titre,
                publishedAt: record.debut_de_validite,
                type: record.type,
                serie: record.serie,
                division: record.division,
                officialJsonMediaType: response.headers.get("content-type") ?? "application/json",
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
          const mediaType = raw.mediaType.toLowerCase();
          const record = mediaType.includes("json") ? firstRecord(raw.body, definition) : undefined;
          if (record && !recordMatchesExternalId(record, item?.externalId)) {
            throw new SourceIngestionError(
              "Dataset record normalization skipped: fetched record does not match requested item",
              { sourceId: definition.id },
            );
          }
          const content = record ? recordContent(record) : raw.body;
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
          const externalId =
            item?.externalId ??
            record?.identifiant_juridique ??
            stringMetadata(raw.metadata, "externalId");
          const publishedAtValue =
            record?.debut_de_validite ?? stringMetadata(raw.metadata, "publishedAt");
          return {
            id: stableDocumentId(definition.id, raw.canonicalUrl, contentHash),
            sourceId: definition.id,
            ...(externalId ? { externalId } : {}),
            canonicalUrl: raw.canonicalUrl,
            title:
              item?.title ??
              record?.titre ??
              stringMetadata(raw.metadata, "title") ??
              raw.canonicalUrl,
            publishedAt:
              item?.publishedAt ?? (publishedAtValue ? new Date(publishedAtValue) : null),
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
              contentFormats: definition.contentFormats,
              ...(externalId ? { externalId } : {}),
              type: record?.type ?? raw.metadata?.type,
              serie: record?.serie ?? raw.metadata?.serie,
              division: record?.division ?? raw.metadata?.division,
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
