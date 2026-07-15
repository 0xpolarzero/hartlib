import { PgClient } from "@effect/sql-pg";
import { databaseUrlRedactedConfig } from "@brief/config";
import {
  sha256Hex,
  type ConditionalRequestValidators,
  type DiscoveredItem,
  type PublicSourceDefinition,
} from "@brief/source-ingestion";
import { Config, Effect, Layer } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type {
  PublicSourceIngestionOptions,
  PublicSourceIngestionRepositoryShape,
  PublicSourceIngestionRun,
} from "./types";
import { durablePublicSourceItemMetadata } from "./types";
import { PublicSourceIngestionRepository } from "./repository";

type DiscoveryRow = {
  readonly url: string;
  readonly etag: string | null;
  readonly last_modified: string | null;
};

type ItemRow = {
  readonly stored: boolean;
  readonly external_id: string | null;
  readonly title: string;
  readonly published_at: Date | null;
  readonly source_updated_at: Date | null;
  readonly summary: string | null;
  readonly metadata: Record<string, unknown>;
  readonly etag: string | null;
  readonly last_modified: string | null;
  readonly current_content_hash: string | null;
  readonly latest_document_id: string | null;
  readonly latest_raw_artifact_id: string | null;
  readonly last_fetched_at: Date | null;
  readonly last_successful_fetch_at: Date | null;
  readonly consecutive_failures: number;
  readonly poll_eligible: boolean;
  readonly retry_eligible: boolean;
};

type DiscoveredItemRow = {
  readonly source_id: DiscoveredItem["sourceId"];
  readonly canonical_url: string;
  readonly external_id: string;
  readonly title: string;
  readonly published_at: Date | null;
  readonly discovered_at: Date;
  readonly source_updated_at: Date | null;
  readonly summary: string | null;
  readonly metadata: Record<string, unknown>;
};

type RetryItemRow = DiscoveredItemRow & {
  readonly last_fetched_at: Date | null;
};

type RawArtifactRow = {
  readonly id: string;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const validators = (
  row: Pick<DiscoveryRow | ItemRow, "etag" | "last_modified">,
): ConditionalRequestValidators | undefined => {
  if (!row.etag && !row.last_modified) {
    return undefined;
  }

  return {
    ...(row.etag ? { etag: row.etag } : {}),
    ...(row.last_modified ? { lastModified: row.last_modified } : {}),
  };
};

const metadataValue = (metadata: Record<string, unknown> | undefined, key: string): string | null =>
  typeof metadata?.[key] === "string" ? metadata[key] : null;

export const makePgPublicSourceIngestionRepository = (): Effect.Effect<
  PublicSourceIngestionRepositoryShape,
  never,
  PgClient.PgClient
> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    const upsertSource = (source: PublicSourceDefinition) =>
      sql`
          insert into public_sources (
            source_id,
            display_name,
            publisher_name,
            description,
            country,
            language,
            ingestion_method,
            discovery_url,
            discovery_urls,
            content_url,
            average_chars_per_item,
            updated_at
          )
          values (
            ${source.id},
            ${source.displayName},
            ${source.publisherName},
            ${source.description},
            ${source.country},
            ${source.language},
            ${source.ingestionMethod},
            ${source.discoveryUrl},
            ${JSON.stringify(source.discoveryUrls ?? [source.discoveryUrl])}::jsonb,
            ${source.contentUrl ?? null},
            ${source.averageCharsPerItem},
            now()
          )
          on conflict (source_id) do update set
            display_name = excluded.display_name,
            publisher_name = excluded.publisher_name,
            description = excluded.description,
            country = excluded.country,
            language = excluded.language,
            ingestion_method = excluded.ingestion_method,
            discovery_url = excluded.discovery_url,
            discovery_urls = excluded.discovery_urls,
            content_url = excluded.content_url,
            average_chars_per_item = excluded.average_chars_per_item,
            updated_at = now()
        `.pipe(Effect.asVoid);

    const repository: PublicSourceIngestionRepositoryShape = {
      startRun: (source, options: PublicSourceIngestionOptions) =>
        Effect.gen(function* () {
          yield* upsertSource(source);
          const rows = yield* sql<PublicSourceIngestionRun>`
              insert into public_source_ingestion_runs (source_id, mode, status, metadata)
              values (
                ${source.id},
                ${options.mode},
                'running',
                ${sql.json({ since: options.since?.toISOString() ?? null })}
              )
              returning id, source_id as "sourceId", mode, started_at as "startedAt"
            `;
          return rows[0]!;
        }),
      completeRun: (run, stats) =>
        sql`
            update public_source_ingestion_runs set
              status = 'completed',
              completed_at = now(),
              discovered_count = ${stats.discoveredCount},
              fetched_count = ${stats.fetchedCount},
              unchanged_count = ${stats.unchangedCount},
              stored_document_count = ${stats.storedDocumentCount},
              failed_count = ${stats.failedCount}
            where id = ${run.id}
          `.pipe(Effect.asVoid),
      failRun: (run, error) =>
        sql`
            update public_source_ingestion_runs set
              status = 'failed',
              completed_at = now(),
              failed_count = failed_count + 1,
              error = ${errorMessage(error)}
            where id = ${run.id}
          `.pipe(Effect.asVoid),
      getDiscoveryRequests: (source) =>
        Effect.gen(function* () {
          yield* upsertSource(source);
          const rows = yield* sql<DiscoveryRow>`
              select url, etag, last_modified
              from public_source_discovery_requests
              where source_id = ${source.id}
            `;
          const byUrl = new Map(rows.map((row) => [row.url, row]));
          return (source.discoveryUrls ?? [source.discoveryUrl]).map((url) => {
            const row = byUrl.get(url);
            const requestValidators = row ? validators(row) : undefined;
            return requestValidators ? { url, validators: requestValidators } : { url };
          });
        }),
      recordDiscoveryResult: (source, result, options) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* upsertSource(source);
            for (const metadata of result.metadata) {
              yield* sql`
                insert into public_source_discovery_requests (
                  source_id,
                  url,
                  etag,
                  last_modified,
                  body_hash,
                  last_status,
                  last_fetched_at,
                  updated_at
                )
                values (
                  ${source.id},
                  ${metadata.url},
                  ${metadata.etag ?? null},
                  ${metadata.lastModified ?? null},
                  ${metadata.bodyHash ?? null},
                  ${metadata.status},
                  ${result.discoveredAt},
                  now()
                )
                on conflict (source_id, url) do update set
                  etag = coalesce(excluded.etag, public_source_discovery_requests.etag),
                  last_modified = coalesce(
                    excluded.last_modified,
                    public_source_discovery_requests.last_modified
                  ),
                  body_hash = coalesce(excluded.body_hash, public_source_discovery_requests.body_hash),
                  last_status = excluded.last_status,
                  last_fetched_at = excluded.last_fetched_at,
                  updated_at = now()
              `;
            }

            // Discovery metadata and every newly discovered candidate share
            // one transaction.  A crash or candidate-write failure therefore
            // rolls back validators/health as well, so a later 304 cannot hide
            // a partially persisted discovery list.
            for (const item of options?.items ?? []) {
              yield* sql`
                insert into public_source_candidates (
                  source_id,
                  canonical_url,
                  external_id,
                  title,
                  published_at,
                  discovered_at,
                  source_updated_at,
                  summary,
                  metadata,
                  poll_eligible,
                  updated_at
                )
                values (
                  ${item.sourceId},
                  ${item.canonicalUrl},
                  ${item.externalId ?? null},
                  ${item.title},
                  ${item.publishedAt ?? null},
                  ${item.discoveredAt ?? result.discoveredAt},
                  ${item.updatedAt ?? null},
                  ${item.summary ?? null},
                  ${sql.json(durablePublicSourceItemMetadata(item.metadata))},
                  ${options?.pollEligible ?? false},
                  now()
                )
                on conflict (source_id, canonical_url) do update set
                  external_id = coalesce(excluded.external_id, public_source_candidates.external_id),
                  title = excluded.title,
                  published_at = coalesce(excluded.published_at, public_source_candidates.published_at),
                  discovered_at = least(public_source_candidates.discovered_at, excluded.discovered_at),
                  source_updated_at = coalesce(
                    excluded.source_updated_at,
                    public_source_candidates.source_updated_at
                  ),
                  summary = coalesce(excluded.summary, public_source_candidates.summary),
                  metadata = public_source_candidates.metadata || excluded.metadata,
                  updated_at = now()
              `;
              // Stored items remain authoritative and must not leave a shadow
              // candidate that would be loaded by a later 304 retry.
              yield* sql`
                delete from public_source_candidates c
                using public_source_items i
                where c.source_id = ${item.sourceId}
                  and c.canonical_url = ${item.canonicalUrl}
                  and i.source_id = c.source_id
                  and i.canonical_url = c.canonical_url
              `;
            }

            yield* sql`
                update public_sources set
                health_status = 'healthy',
                latest_attempted_fetch_at = ${result.discoveredAt},
                latest_successful_fetch_at = ${result.discoveredAt},
                consecutive_failures = 0,
                last_error = null,
                updated_at = now()
              where source_id = ${source.id}
            `;
          }).pipe(Effect.asVoid),
        ),
      recordDiscoveryFailure: (source, error) =>
        Effect.gen(function* () {
          yield* upsertSource(source);
          yield* sql`
              update public_sources set
                health_status = 'degraded',
                latest_attempted_fetch_at = now(),
                consecutive_failures = consecutive_failures + 1,
                last_error = ${errorMessage(error)},
                updated_at = now()
              where source_id = ${source.id}
            `;
        }).pipe(Effect.asVoid),
      getItemState: (sourceId, canonicalUrl) =>
        Effect.gen(function* () {
          const rows = yield* sql<ItemRow>`
              select
                true as stored,
                external_id,
                title,
                published_at,
                source_updated_at,
                summary,
                metadata,
                etag,
                last_modified,
                current_content_hash,
                latest_document_id,
                latest_raw_artifact_id,
                last_fetched_at,
                last_successful_fetch_at,
                consecutive_failures,
                true as poll_eligible,
                (
                  consecutive_failures = 0
                  or last_fetched_at is null
                  or now() >= last_fetched_at +
                    least(3600, 60 * power(2, least(consecutive_failures - 1, 31))) * interval '1 second'
                ) as retry_eligible
              from public_source_items
              where source_id = ${sourceId} and canonical_url = ${canonicalUrl}
              union all
              select
                false as stored,
                external_id,
                title,
                published_at,
                source_updated_at,
                summary,
                metadata,
                etag,
                last_modified,
                null as current_content_hash,
                null as latest_document_id,
                null as latest_raw_artifact_id,
                last_fetched_at,
                last_successful_fetch_at,
                consecutive_failures,
                poll_eligible,
                (
                  consecutive_failures = 0
                  or last_fetched_at is null
                  or now() >= last_fetched_at +
                    least(3600, 60 * power(2, least(consecutive_failures - 1, 31))) * interval '1 second'
                ) as retry_eligible
              from public_source_candidates
              where source_id = ${sourceId}
                and canonical_url = ${canonicalUrl}
                and not exists (
                  select 1
                  from public_source_items i
                  where i.source_id = ${sourceId}
                    and i.canonical_url = ${canonicalUrl}
                )
              limit 1
            `;
          const row = rows[0];
          if (!row) {
            return undefined;
          }

          return {
            sourceId,
            canonicalUrl,
            externalId: row.external_id ?? undefined,
            title: row.title,
            publishedAt: row.published_at,
            updatedAt: row.source_updated_at,
            summary: row.summary ?? undefined,
            metadata: row.metadata,
            validators: validators(row),
            currentContentHash: row.current_content_hash ?? undefined,
            latestDocumentId: row.latest_document_id ?? undefined,
            latestRawArtifactId: row.latest_raw_artifact_id ?? undefined,
            lastFetchedAt: row.last_fetched_at ?? undefined,
            lastSuccessfulFetchAt: row.last_successful_fetch_at ?? undefined,
            consecutiveFailures: row.consecutive_failures,
            pollEligible: row.poll_eligible,
            retryEligible: row.retry_eligible,
            stored: row.stored,
          };
        }),
      getRecentIncompleteItems: (source, since) =>
        Effect.gen(function* () {
          yield* upsertSource(source);
          const rows = yield* sql<DiscoveredItemRow>`
              select
                source_id,
                canonical_url,
                external_id,
                title,
                published_at,
                discovered_at,
                source_updated_at,
                summary,
                metadata
              from public_source_items
              where source_id = ${source.id}
                and (
                  published_at >= ${since}
                  or (
                    published_at is null
                    and (discovered_at >= ${since} or discovered_at is null)
                  )
                )
                and (
                  latest_document_id is null
                  or latest_raw_artifact_id is null
                  or current_content_hash is null
                  or title like '%�%'
                  or consecutive_failures > 0
                )
              order by greatest(coalesce(published_at, discovered_at), discovered_at) desc
            `;

          const candidateRows = yield* sql<DiscoveredItemRow>`
              select
                source_id,
                canonical_url,
                external_id,
                title,
                published_at,
                discovered_at,
                source_updated_at,
                summary,
                metadata
              from public_source_candidates
              where source_id = ${source.id}
                and (
                  published_at >= ${since}
                  or (
                    published_at is null
                    and (discovered_at >= ${since} or discovered_at is null)
                  )
                )
              order by greatest(coalesce(published_at, discovered_at), discovered_at) desc
            `;

          return [...rows, ...candidateRows].map((row) => ({
            sourceId: row.source_id,
            externalId: row.external_id,
            canonicalUrl: row.canonical_url,
            title: row.title,
            publishedAt: row.published_at,
            discoveredAt: row.discovered_at,
            ...(row.source_updated_at ? { updatedAt: row.source_updated_at } : {}),
            ...(row.summary ? { summary: row.summary } : {}),
            metadata: row.metadata,
          }));
        }),
      getRetryEligibleItems: (source, _now) =>
        Effect.gen(function* () {
          yield* upsertSource(source);
          const rows = yield* sql<RetryItemRow>`
              select
                source_id,
                canonical_url,
                external_id,
                title,
                published_at,
                discovered_at,
                source_updated_at,
                summary,
                metadata,
                last_fetched_at
              from public_source_items
              where source_id = ${source.id}
                and consecutive_failures > 0
                and (
                  last_fetched_at is null
                  or now() >= last_fetched_at +
                    least(3600, 60 * power(2, least(consecutive_failures - 1, 31))) * interval '1 second'
                )
              union all
              select
                source_id,
                canonical_url,
                external_id,
                title,
                published_at,
                discovered_at,
                source_updated_at,
                summary,
                metadata,
                last_fetched_at
              from public_source_candidates
              where source_id = ${source.id}
                and poll_eligible
                and (
                  (consecutive_failures = 0 and last_fetched_at is null)
                  or (
                    consecutive_failures > 0
                    and (
                      last_fetched_at is null
                      or now() >= last_fetched_at +
                        least(3600, 60 * power(2, least(consecutive_failures - 1, 31))) * interval '1 second'
                    )
                  )
                )
              order by last_fetched_at asc nulls first, discovered_at asc, canonical_url asc
              limit 1000
            `;
          return rows.map((row) => ({
            sourceId: row.source_id,
            externalId: row.external_id,
            canonicalUrl: row.canonical_url,
            title: row.title,
            publishedAt: row.published_at,
            discoveredAt: row.discovered_at,
            ...(row.source_updated_at ? { updatedAt: row.source_updated_at } : {}),
            ...(row.summary ? { summary: row.summary } : {}),
            metadata: row.metadata,
          }));
        }),
      recordDiscoveredItem: (item, pollEligible) =>
        sql`
            insert into public_source_candidates (
              source_id,
              canonical_url,
              external_id,
              title,
              published_at,
              discovered_at,
              source_updated_at,
              summary,
              metadata,
              poll_eligible,
              updated_at
            )
            values (
              ${item.sourceId},
              ${item.canonicalUrl},
              ${item.externalId ?? null},
              ${item.title},
              ${item.publishedAt ?? null},
              ${item.discoveredAt ?? new Date()},
              ${item.updatedAt ?? null},
              ${item.summary ?? null},
              ${sql.json(durablePublicSourceItemMetadata(item.metadata))},
              ${pollEligible},
              now()
            )
            on conflict (source_id, canonical_url) do update set
              external_id = coalesce(excluded.external_id, public_source_candidates.external_id),
              title = excluded.title,
              published_at = coalesce(excluded.published_at, public_source_candidates.published_at),
              discovered_at = least(public_source_candidates.discovered_at, excluded.discovered_at),
              source_updated_at = coalesce(
                excluded.source_updated_at,
                public_source_candidates.source_updated_at
              ),
              summary = coalesce(excluded.summary, public_source_candidates.summary),
              metadata = public_source_candidates.metadata || excluded.metadata,
              updated_at = now()
          `.pipe(Effect.asVoid),
      storeIngestedItem: (result) =>
        Effect.gen(function* () {
          const rawMediaType = result.raw.mediaType.split(";", 1)[0]?.trim().toLowerCase();
          const isHtml = rawMediaType === "text/html";
          const isPdf = rawMediaType === "application/pdf";
          if (!isHtml && !isPdf) {
            return yield* Effect.fail(
              new Error(`public source artifact is not readable HTML/PDF: ${result.raw.mediaType}`),
            );
          }
          if (isPdf && (!result.raw.bodyBytes || result.raw.bodyBytes.byteLength === 0)) {
            return yield* Effect.fail(
              new Error("public source PDF artifact is missing exact source bytes"),
            );
          }
          if (isHtml && (result.raw.body.length === 0 || result.raw.bodyBytes !== undefined)) {
            return yield* Effect.fail(
              new Error("public source HTML artifact has an invalid body representation"),
            );
          }
          if (result.document.textCharCount < 100) {
            return yield* Effect.fail(
              new Error(
                `public source document is too short to be considered readable: ${result.document.textCharCount}`,
              ),
            );
          }

          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const bodyHash = yield* Effect.promise(() =>
                sha256Hex(isPdf ? result.raw.bodyBytes! : result.raw.body),
              );
              const rawRows = yield* sql<RawArtifactRow>`
              insert into public_source_raw_artifacts (
                source_id,
                canonical_url,
                fetched_at,
                media_type,
                body,
                body_bytes,
                body_hash,
                metadata
              )
              values (
                ${result.raw.sourceId},
                ${result.raw.canonicalUrl},
                ${result.raw.fetchedAt},
                ${result.raw.mediaType},
                ${result.raw.body},
                ${result.raw.bodyBytes ?? null},
                ${bodyHash},
                ${sql.json(result.raw.metadata ?? {})}
              )
              on conflict (source_id, canonical_url, body_hash) do update set
                fetched_at = least(public_source_raw_artifacts.fetched_at, excluded.fetched_at),
                media_type = excluded.media_type,
                body = excluded.body,
                body_bytes = excluded.body_bytes,
                metadata = public_source_raw_artifacts.metadata || excluded.metadata
              returning id
            `;
              const rawArtifactId = rawRows[0]!.id;
              const documentRows = yield* sql<{ readonly document_id: string }>`
              insert into public_source_documents (
                document_id,
                source_id,
                external_id,
                canonical_url,
                title,
                published_at,
                discovered_at,
                fetched_at,
                language,
                document_type,
                text,
                text_char_count,
                content_hash,
                raw_artifact_id,
                source_metadata
              )
              values (
                ${result.document.id},
                ${result.document.sourceId},
                ${result.document.externalId ?? null},
                ${result.document.canonicalUrl},
                ${result.document.title},
                ${result.document.publishedAt ?? null},
                ${result.document.discoveredAt},
                ${result.document.fetchedAt},
                ${result.document.language},
                ${result.document.documentType},
                ${result.document.text},
                ${result.document.textCharCount},
                ${result.document.contentHash},
                ${rawArtifactId},
                ${sql.json(result.document.sourceMetadata)}
              )
              on conflict (document_id) do update set
                title = excluded.title,
                published_at = coalesce(excluded.published_at, public_source_documents.published_at),
                discovered_at = least(public_source_documents.discovered_at, excluded.discovered_at),
                fetched_at = excluded.fetched_at,
                language = excluded.language,
                document_type = excluded.document_type,
                text = excluded.text,
                text_char_count = excluded.text_char_count,
                content_hash = excluded.content_hash,
                raw_artifact_id = excluded.raw_artifact_id,
                source_metadata = public_source_documents.source_metadata || excluded.source_metadata
              returning document_id
            `;
              yield* sql`
              insert into public_source_items (
                source_id,
                canonical_url,
                external_id,
                title,
                published_at,
                discovered_at,
                source_updated_at,
                summary,
                metadata,
                etag,
                last_modified,
                current_content_hash,
                latest_document_id,
                latest_raw_artifact_id,
                last_fetched_at,
                last_successful_fetch_at,
                consecutive_failures,
                last_error,
                updated_at
              )
              values (
                ${result.item.sourceId},
                ${result.item.canonicalUrl},
                ${result.item.externalId ?? null},
                ${result.document.title},
                ${result.document.publishedAt ?? result.item.publishedAt ?? null},
                ${result.item.discoveredAt ?? result.document.discoveredAt},
                ${result.item.updatedAt ?? null},
                ${result.item.summary ?? null},
                ${sql.json(durablePublicSourceItemMetadata(result.item.metadata))},
                ${metadataValue(result.raw.metadata, "etag")},
                ${metadataValue(result.raw.metadata, "lastModified")},
                ${result.document.contentHash},
                ${result.document.id},
                ${rawArtifactId},
                ${result.raw.fetchedAt},
                ${result.raw.fetchedAt},
                0,
                null,
                now()
              )
              on conflict (source_id, canonical_url) do update set
                external_id = coalesce(excluded.external_id, public_source_items.external_id),
                title = excluded.title,
                published_at = coalesce(excluded.published_at, public_source_items.published_at),
                discovered_at = least(public_source_items.discovered_at, excluded.discovered_at),
                source_updated_at = coalesce(
                  excluded.source_updated_at,
                  public_source_items.source_updated_at
                ),
                summary = coalesce(excluded.summary, public_source_items.summary),
                metadata = public_source_items.metadata || excluded.metadata,
                etag = coalesce(excluded.etag, public_source_items.etag),
                last_modified = coalesce(excluded.last_modified, public_source_items.last_modified),
                current_content_hash = excluded.current_content_hash,
                latest_document_id = excluded.latest_document_id,
                latest_raw_artifact_id = excluded.latest_raw_artifact_id,
                last_fetched_at = excluded.last_fetched_at,
                last_successful_fetch_at = excluded.last_successful_fetch_at,
                consecutive_failures = 0,
                last_error = null,
                updated_at = now()
            `;
              yield* sql`
              delete from public_source_candidates
              where source_id = ${result.item.sourceId}
                and canonical_url = ${result.item.canonicalUrl}
            `;
              return { storedDocument: documentRows.length > 0 };
            }),
          );
        }),
      recordUnchangedItem: (result) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
            update public_source_candidates set
              external_id = coalesce(${result.item.externalId ?? null}, external_id),
              title = ${result.item.title},
              published_at = coalesce(${result.item.publishedAt ?? null}, published_at),
              source_updated_at = coalesce(${result.item.updatedAt ?? null}, source_updated_at),
              summary = coalesce(${result.item.summary ?? null}, summary),
              metadata = metadata || ${sql.json(durablePublicSourceItemMetadata(result.item.metadata))},
              etag = coalesce(${metadataValue(result.result.metadata, "etag")}, etag),
              last_modified = coalesce(
                ${metadataValue(result.result.metadata, "lastModified")},
                last_modified
              ),
              last_fetched_at = ${result.result.fetchedAt},
              last_not_modified_at = ${result.result.fetchedAt},
              consecutive_failures = 0,
              last_error = null,
              updated_at = now()
            where source_id = ${result.item.sourceId}
              and canonical_url = ${result.item.canonicalUrl}
          `;
            yield* sql`
            update public_source_items set
              external_id = coalesce(${result.item.externalId ?? null}, external_id),
              title = ${result.item.title},
              published_at = coalesce(${result.item.publishedAt ?? null}, published_at),
              source_updated_at = coalesce(${result.item.updatedAt ?? null}, source_updated_at),
              summary = coalesce(${result.item.summary ?? null}, summary),
              metadata = metadata || ${sql.json(durablePublicSourceItemMetadata(result.item.metadata))},
              etag = coalesce(${metadataValue(result.result.metadata, "etag")}, etag),
              last_modified = coalesce(
                ${metadataValue(result.result.metadata, "lastModified")},
                last_modified
              ),
              last_fetched_at = ${result.result.fetchedAt},
              last_not_modified_at = ${result.result.fetchedAt},
              consecutive_failures = 0,
              last_error = null,
              updated_at = now()
            where source_id = ${result.item.sourceId}
              and canonical_url = ${result.item.canonicalUrl}
          `;
          }).pipe(Effect.asVoid),
        ),
      recordItemFailure: (result, _attemptedAt) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
            update public_source_candidates set
              last_fetched_at = now(),
              consecutive_failures = consecutive_failures + 1,
              last_error = ${errorMessage(result.error)},
              updated_at = now()
            where source_id = ${result.item.sourceId}
              and canonical_url = ${result.item.canonicalUrl}
          `;
            yield* sql`
            update public_source_items set
              last_fetched_at = now(),
              consecutive_failures = consecutive_failures + 1,
              last_error = ${errorMessage(result.error)},
              updated_at = now()
            where source_id = ${result.item.sourceId}
              and canonical_url = ${result.item.canonicalUrl}
          `;
          }).pipe(Effect.asVoid),
        ),
    };

    return repository;
  }).pipe(
    Effect.catch((error: SqlError) =>
      Effect.die(new Error(`Postgres public source repository failed: ${error.message}`)),
    ),
  );

export const PublicSourceIngestionRepositoryPgLayer = Layer.effect(
  PublicSourceIngestionRepository,
  makePgPublicSourceIngestionRepository(),
).pipe(
  Layer.provide(
    PgClient.layerConfig({
      url: databaseUrlRedactedConfig,
      applicationName: Config.succeed("brief-worker"),
    }),
  ),
);
