import { PgClient } from "@effect/sql-pg";
import { Config, Effect, Redacted } from "effect";
import type { PublicSourcesResponse } from "@brief/shared";
import { json, type Route } from "../http";

type SourceRow = {
  readonly source_id: string;
  readonly display_name: string;
  readonly publisher_name: string;
  readonly description: string;
  readonly created_at: Date;
};

type ItemRow = {
  readonly source_id: string;
  readonly canonical_url: string;
  readonly title: string;
  readonly published_at: Date | null;
  readonly discovered_at: Date;
  readonly summary: string | null;
  readonly current_content_hash: string | null;
  readonly latest_document_id: string | null;
  readonly latest_raw_artifact_id: string | null;
  readonly raw_media_type: string | null;
};

type DocumentRow = {
  readonly document_id: string;
  readonly source_id: string;
  readonly canonical_url: string;
  readonly title: string;
  readonly published_at: Date | null;
  readonly discovered_at: Date;
  readonly language: string;
  readonly document_type: string;
  readonly text: string;
  readonly text_char_count: number;
  readonly content_hash: string;
  readonly raw_artifact_id: string;
  readonly raw_media_type: string | null;
};

type RawDocumentRow = {
  readonly body: string;
  readonly media_type: string;
};

const emptyMetrics = {
  opens: 0,
  downloads: 0,
  aiContextPulls: 0,
} as const;

const minimumReadableTextChars = 100;

const publicPublicationId = (sourceId: string, canonicalUrl: string) =>
  `public:${sourceId}:${encodeURIComponent(canonicalUrl)}`;

const textPreview = (text: string) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 280) return normalized;
  return `${normalized.slice(0, 277).trimEnd()}...`;
};

const hostedContentUrl = (document: DocumentRow) => {
  const mediaType = document.raw_media_type?.toLowerCase();
  if (!mediaType?.includes("html") && !mediaType?.includes("pdf")) return null;
  return `/public-source-documents/${encodeURIComponent(document.document_id)}/content`;
};

const effectivePublicationDate = (item: ItemRow): string =>
  (item.published_at ?? item.discovered_at).toISOString();

export const publicSourcesResponseFromRows = (
  sources: readonly SourceRow[],
  items: readonly ItemRow[],
  documents: readonly DocumentRow[],
): PublicSourcesResponse => {
  const documentsById = new Map(documents.map((document) => [document.document_id, document]));
  const visibleItems = items.filter((item) => {
    if (!item.current_content_hash || !item.latest_document_id || !item.latest_raw_artifact_id) {
      return false;
    }
    const document = documentsById.get(item.latest_document_id);
    return Boolean(
      document &&
      document.source_id === item.source_id &&
      document.canonical_url === item.canonical_url &&
      document.content_hash === item.current_content_hash &&
      document.raw_artifact_id === item.latest_raw_artifact_id &&
      hostedContentUrl(document) &&
      document.text_char_count >= minimumReadableTextChars,
    );
  });

  const itemsBySourceId = new Map<string, ItemRow[]>();
  for (const item of visibleItems) {
    const sourceItems = itemsBySourceId.get(item.source_id) ?? [];
    sourceItems.push(item);
    itemsBySourceId.set(item.source_id, sourceItems);
  }

  return {
    sources: sources.map((source) => {
      const sourceItems = itemsBySourceId.get(source.source_id) ?? [];
      const latest = sourceItems[0];
      return {
        id: source.source_id,
        kind: "public",
        publisherCompanyId: null,
        clientCompanyId: "public",
        name: source.display_name,
        publisherName: source.publisher_name,
        description: source.description,
        subscribed: true,
        subscribedSince: source.created_at.toISOString(),
        subscriberCount: 0,
        latestPublicationId: latest
          ? publicPublicationId(latest.source_id, latest.canonical_url)
          : null,
        latestPublicationDate: latest ? effectivePublicationDate(latest) : null,
        metrics: emptyMetrics,
      };
    }),
    publications: visibleItems.map((item) => {
      const publicationId = publicPublicationId(item.source_id, item.canonical_url);
      const document = documentsById.get(item.latest_document_id!);
      if (!document) {
        throw new Error("visible public source item has no readable document");
      }

      return {
        id: publicationId,
        sourceId: item.source_id,
        sourceKind: "public",
        title: item.title,
        publicationDate: effectivePublicationDate(item),
        status: "published",
        summary: item.summary ?? "",
        canonicalUrl: item.canonical_url,
        documents: [
          {
            id: document.document_id,
            publicationId,
            sourceId: document.source_id,
            title: item.title,
            language: document.language,
            documentType: document.document_type,
            textPreview: textPreview(document.text),
            canonicalUrl: document.canonical_url,
            hostedContentUrl: hostedContentUrl(document),
            fileName: null,
            pageCount: null,
            storagePath: null,
            metrics: emptyMetrics,
          },
        ],
        metrics: emptyMetrics,
      };
    }),
  } satisfies PublicSourcesResponse;
};

const listPublicSources = (): Effect.Effect<PublicSourcesResponse, never, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    const sources = yield* sql<SourceRow>`
      select source_id, display_name, publisher_name, description, created_at
      from public_sources
      order by display_name asc
    `;

    const items = yield* sql<ItemRow>`
      select
        i.source_id,
        i.canonical_url,
        i.title,
        i.published_at,
        i.discovered_at,
        i.summary,
        i.current_content_hash,
        i.latest_document_id,
        i.latest_raw_artifact_id,
        r.media_type as raw_media_type
      from public_source_items i
      join public_source_documents d on d.document_id = i.latest_document_id
      join public_source_raw_artifacts r on r.id = d.raw_artifact_id
      where
        (
          lower(r.media_type) like '%html%'
          or lower(r.media_type) like '%pdf%'
        )
        and d.text_char_count >= ${minimumReadableTextChars}
      order by i.published_at desc nulls last, i.title asc
    `;

    const documents = yield* sql<DocumentRow>`
      select
        d.document_id,
        d.source_id,
        d.canonical_url,
        d.title,
        d.published_at,
        d.discovered_at,
        d.language,
        d.document_type,
        d.text,
        d.text_char_count,
        d.content_hash,
        d.raw_artifact_id,
        r.media_type as raw_media_type
      from public_source_documents d
      left join public_source_raw_artifacts r on r.id = d.raw_artifact_id
    `;

    return publicSourcesResponseFromRows(sources, items, documents);
  }).pipe(
    Effect.catch((error: unknown) =>
      Effect.die(
        new Error(
          `Postgres public source read failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ),
    ),
  );

const PgLayer = PgClient.layerConfig({
  url: Config.string("DATABASE_URL").pipe(
    Config.withDefault("postgres://brief:brief@localhost:5432/brief"),
    Config.map(Redacted.make),
  ),
  applicationName: Config.succeed("brief-api"),
});

export const publicSourcesRoute: Route = {
  method: "GET",
  pattern: /^\/public-sources\/?$/,
  handle: () => listPublicSources().pipe(Effect.provide(PgLayer), Effect.map(json)),
};

const readPublicSourceDocumentContent = (
  documentId: string,
): Effect.Effect<Response, never, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<RawDocumentRow>`
      select r.body, r.media_type
      from public_source_documents d
      join public_source_raw_artifacts r on r.id = d.raw_artifact_id
      where d.document_id = ${documentId}
        and d.text_char_count >= ${minimumReadableTextChars}
        and (
          lower(r.media_type) like '%html%'
          or lower(r.media_type) like '%pdf%'
        )
      limit 1
    `;
    const row = rows[0];
    if (!row) {
      return json({ error: "not_found" }, { status: 404 });
    }

    const headers = new Headers();
    headers.set("access-control-allow-origin", "*");
    headers.set("content-type", `${row.media_type}; charset=utf-8`);
    headers.set(
      "content-security-policy",
      "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
    return new Response(row.body, { headers });
  }).pipe(
    Effect.catch((error: unknown) =>
      Effect.die(
        new Error(
          `Postgres public source document read failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      ),
    ),
  );

export const publicSourceDocumentContentRoute: Route = {
  method: "GET",
  pattern: /^\/public-source-documents\/[^/]+\/content\/?$/,
  handle: (_request, url) => {
    const match = /^\/public-source-documents\/([^/]+)\/content\/?$/.exec(url.pathname);
    const documentId = match ? decodeURIComponent(match[1] ?? "") : "";
    return readPublicSourceDocumentContent(documentId).pipe(Effect.provide(PgLayer));
  },
};
