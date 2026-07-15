import { PgClient } from "@effect/sql-pg";
import {
  canonicalPublicSourceHttpsUrl,
  DEFAULT_LOCALE,
  DEFAULT_MARKET,
  isLocale,
  isMarket,
  type PublicSourcesResponse,
} from "@brief/shared";
import { Effect } from "effect";

export interface PublicSourceRow {
  readonly source_id: string;
  readonly display_name: string;
  readonly publisher_name: string;
  readonly description: string;
  readonly country: string;
  readonly language: string;
  readonly created_at: Date;
  /** Company-scoped state, populated by the demo-authorized read route. */
  readonly subscribed?: boolean;
  readonly subscribed_since?: Date | null;
}

export interface PublicSourceItemRow {
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
}

export interface PublicSourceDocumentRow {
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
}

export interface RawPublicSourceDocument {
  readonly body: string;
  readonly body_bytes: Uint8Array | null;
  readonly media_type: string;
}

/** The authenticated identity used to resolve a current client-company scope. */
export interface PublicSourceReadIdentity {
  readonly userId: string;
  readonly organizationId: string | null;
  readonly mode: "demo" | "clerk";
}

/** Public-source analytics are not persisted by this ingestion/read path. */
const publicMetrics = { opens: null, downloads: null, aiContextPulls: null } as const;
export const minimumReadablePublicSourceTextChars = 100;

export const displayablePublicSourceMediaType = (
  mediaType: string | null,
): "text/html" | "application/pdf" | null => {
  const baseType = mediaType?.split(";", 1)[0]?.trim().toLowerCase();
  return baseType === "text/html" || baseType === "application/pdf" ? baseType : null;
};

const publicPublicationId = (sourceId: string, canonicalUrl: string) =>
  `public:${sourceId}:${encodeURIComponent(canonicalUrl)}`;

const textPreview = (text: string) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 280) return normalized;
  return `${normalized.slice(0, 277).trimEnd()}...`;
};

const hostedContentUrl = (document: PublicSourceDocumentRow) => {
  if (displayablePublicSourceMediaType(document.raw_media_type) === null) return null;
  return `/public-source-documents/${encodeURIComponent(document.document_id)}/content`;
};

const effectivePublicationDate = (item: PublicSourceItemRow): string =>
  (item.published_at ?? item.discovered_at).toISOString();

export const publicSourcesResponseFromRows = (
  sources: readonly PublicSourceRow[],
  items: readonly PublicSourceItemRow[],
  documents: readonly PublicSourceDocumentRow[],
  clientCompanyId = "public",
): PublicSourcesResponse => {
  const documentsById = new Map(documents.map((document) => [document.document_id, document]));
  const sourceIds = new Set(sources.map((source) => source.source_id));
  const authorizedSourceIds =
    clientCompanyId === "public"
      ? sourceIds
      : new Set(
          sources.filter((source) => source.subscribed === true).map((source) => source.source_id),
        );
  const visibleItems = items.filter((item) => {
    if (!authorizedSourceIds.has(item.source_id)) return false;
    if (!item.current_content_hash || !item.latest_document_id || !item.latest_raw_artifact_id) {
      return false;
    }
    const document = documentsById.get(item.latest_document_id);
    const canonicalUrl = canonicalPublicSourceHttpsUrl(item.canonical_url);
    return Boolean(
      canonicalUrl &&
      document &&
      document.source_id === item.source_id &&
      document.canonical_url === item.canonical_url &&
      document.content_hash === item.current_content_hash &&
      document.raw_artifact_id === item.latest_raw_artifact_id &&
      canonicalPublicSourceHttpsUrl(document.canonical_url) === canonicalUrl &&
      hostedContentUrl(document) &&
      document.text_char_count >= minimumReadablePublicSourceTextChars,
    );
  });
  const itemsBySourceId = new Map<string, PublicSourceItemRow[]>();
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
        clientCompanyId,
        name: source.display_name,
        publisherName: source.publisher_name,
        description: source.description,
        country: isMarket(source.country) ? source.country : DEFAULT_MARKET,
        language: isLocale(source.language) ? source.language : DEFAULT_LOCALE,
        subscribed: source.subscribed === true,
        subscribedSince:
          source.subscribed === true && source.subscribed_since
            ? source.subscribed_since.toISOString()
            : null,
        subscriberCount: null,
        latestPublicationId: latest
          ? publicPublicationId(latest.source_id, latest.canonical_url)
          : null,
        latestPublicationDate: latest ? effectivePublicationDate(latest) : null,
        metrics: publicMetrics,
      };
    }),
    publications: visibleItems.map((item) => {
      const canonicalUrl = canonicalPublicSourceHttpsUrl(item.canonical_url);
      if (canonicalUrl === null) throw new Error("visible public source item has an unsafe URL");
      const publicationId = publicPublicationId(item.source_id, canonicalUrl);
      const document = documentsById.get(item.latest_document_id!);
      if (!document) throw new Error("visible public source item has no readable document");
      return {
        id: publicationId,
        sourceId: item.source_id,
        sourceKind: "public",
        title: item.title,
        publicationDate: effectivePublicationDate(item),
        status: "published",
        summary: item.summary ?? "",
        canonicalUrl,
        documents: [
          {
            id: document.document_id,
            publicationId,
            sourceId: document.source_id,
            title: item.title,
            language: document.language,
            documentType: document.document_type,
            textPreview: textPreview(document.text),
            canonicalUrl,
            hostedContentUrl: hostedContentUrl(document),
            fileName: null,
            pageCount: null,
            storagePath: null,
            metrics: publicMetrics,
          },
        ],
        metrics: publicMetrics,
      };
    }),
  } satisfies PublicSourcesResponse;
};

export const listPublicSources = (market?: string, clientCompanyId?: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const sources =
      clientCompanyId !== undefined && market !== undefined
        ? yield* sql<PublicSourceRow>`
            select sources.source_id, sources.display_name, sources.publisher_name,
                   sources.description, sources.country, sources.language, sources.created_at,
                   coalesce(settings.enabled, false) as subscribed,
                   settings.created_at as subscribed_since
            from public_sources sources
            left join client_company_public_source_settings settings
              on settings.source_id = sources.source_id
             and settings.client_company_id = ${clientCompanyId}
            where sources.country = ${market}
            order by sources.display_name asc
          `
        : clientCompanyId !== undefined
          ? yield* sql<PublicSourceRow>`
              select sources.source_id, sources.display_name, sources.publisher_name,
                     sources.description, sources.country, sources.language, sources.created_at,
                     coalesce(settings.enabled, false) as subscribed,
                     settings.created_at as subscribed_since
              from public_sources sources
              left join client_company_public_source_settings settings
                on settings.source_id = sources.source_id
               and settings.client_company_id = ${clientCompanyId}
              order by sources.display_name asc
            `
          : market !== undefined
            ? yield* sql<PublicSourceRow>`
            select source_id, display_name, publisher_name, description, country, language, created_at,
                   false as subscribed, null::timestamptz as subscribed_since
            from public_sources
            where country = ${market}
            order by display_name asc
          `
            : yield* sql<PublicSourceRow>`
            select source_id, display_name, publisher_name, description, country, language, created_at,
                   false as subscribed, null::timestamptz as subscribed_since
            from public_sources
            order by display_name asc
          `;
    const items = yield* sql<PublicSourceItemRow>`
      select i.source_id, i.canonical_url, i.title, i.published_at, i.discovered_at, i.summary,
             i.current_content_hash, i.latest_document_id, i.latest_raw_artifact_id,
             r.media_type as raw_media_type
      from public_source_items i
      join public_source_documents d on d.document_id = i.latest_document_id
      join public_source_raw_artifacts r on r.id = d.raw_artifact_id
      where btrim(lower(split_part(r.media_type, ';', 1))) in ('text/html', 'application/pdf')
        and d.text_char_count >= ${minimumReadablePublicSourceTextChars}
        and brief_public_source_https_url_allowed(i.canonical_url)
      order by i.published_at desc nulls last, i.title asc
    `;
    const documents = yield* sql<PublicSourceDocumentRow>`
      select d.document_id, d.source_id, d.canonical_url, d.title, d.published_at,
             d.discovered_at, d.language, d.document_type, d.text, d.text_char_count,
             d.content_hash, d.raw_artifact_id, r.media_type as raw_media_type
      from public_source_documents d
      left join public_source_raw_artifacts r on r.id = d.raw_artifact_id
      where brief_public_source_https_url_allowed(d.canonical_url)
    `;
    return publicSourcesResponseFromRows(sources, items, documents, clientCompanyId);
  }).pipe(
    Effect.catch((error: unknown) =>
      Effect.die(
        new Error(
          `Postgres public source read failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ),
    ),
  );

/**
 * Read a hosted public-source artifact only through the caller's current
 * company scope. The document ID is never an authorization boundary: the
 * current publication tuple, enabled company setting, live company/user, and
 * unrevoked membership are all checked in the same SQL snapshot.
 *
 * Demo requests receive their company from the canonical demo chat. Clerk
 * requests receive theirs from the authenticated current organization; a
 * missing organization is intentionally denied because it cannot identify an
 * exact company scope.
 */
export const readAuthorizedPublicSourceDocument = (
  identity: PublicSourceReadIdentity,
  documentId: string,
  demoCompanyId: string | null,
) =>
  Effect.gen(function* () {
    if (identity.mode === "demo" && demoCompanyId === null) return null;
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<RawPublicSourceDocument>`
      select r.body, r.body_bytes, r.media_type
      from public_source_documents d
      join public_source_items i
        on i.latest_document_id = d.document_id
       and i.source_id = d.source_id
       and i.canonical_url = d.canonical_url
       and i.current_content_hash = d.content_hash
       and i.latest_raw_artifact_id = d.raw_artifact_id
      join public_source_raw_artifacts r on r.id = d.raw_artifact_id
      join client_company_public_source_settings settings
        on settings.source_id = d.source_id
       and settings.enabled
      join client_companies company on company.id = settings.client_company_id
      join client_company_memberships membership
        on membership.company_id = company.id
       and membership.user_id = ${identity.userId}
       and membership.revoked_at is null
      join platform_users users
        on users.id = membership.user_id
       and users.recovery_deleted_at is null
       and users.purged_at is null
      where d.document_id = ${documentId}
        and company.recovery_deleted_at is null
        and company.purged_at is null
        and d.text_char_count >= ${minimumReadablePublicSourceTextChars}
        and btrim(lower(split_part(r.media_type, ';', 1))) in ('text/html', 'application/pdf')
        and brief_public_source_https_url_allowed(i.canonical_url)
        and (
          (
            ${identity.mode} = 'demo'
            and company.id = ${demoCompanyId}::uuid
          )
          or (
            ${identity.mode} = 'clerk'
            and ${identity.organizationId}::text is not null
            and company.clerk_organization_id = ${identity.organizationId}
          )
        )
      limit 1
    `;
    return rows[0] ?? null;
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
