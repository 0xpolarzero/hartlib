import { discoverSource, ingestDiscoveredItem } from "@brief/source-ingestion";
import type {
  DiscoveredItem,
  PublicSourceId,
  SourceAdapter,
  SourceIngestionResult,
} from "@brief/source-ingestion";
import { Effect } from "effect";
import { PublicSourceIngestionRepository } from "./repository";
import type {
  PublicSourceIngestionMode,
  PublicSourceIngestionOptions,
  PublicSourceIngestionStats,
  PublicSourceItemState,
} from "./types";

const isWithinBackfillWindow = (item: DiscoveredItem, since: Date | undefined): boolean => {
  if (!since) {
    return true;
  }

  return (
    (item.publishedAt !== null && item.publishedAt >= since) ||
    (item.discoveredAt !== undefined && item.discoveredAt >= since) ||
    (item.publishedAt === null && item.discoveredAt === undefined)
  );
};

const emptyStats = (
  sourceId: PublicSourceId,
  mode: PublicSourceIngestionMode,
): PublicSourceIngestionStats => ({
  sourceId,
  mode,
  discoveredCount: 0,
  fetchedCount: 0,
  unchangedCount: 0,
  storedDocumentCount: 0,
  failedCount: 0,
});

const addResultToStats = (
  stats: PublicSourceIngestionStats,
  result: SourceIngestionResult,
  storedDocument: boolean,
): PublicSourceIngestionStats => {
  if (result.status === "ingested") {
    return {
      ...stats,
      fetchedCount: stats.fetchedCount + 1,
      storedDocumentCount: stats.storedDocumentCount + (storedDocument ? 1 : 0),
    };
  }

  if (result.status === "not_modified") {
    return {
      ...stats,
      unchangedCount: stats.unchangedCount + 1,
    };
  }

  return {
    ...stats,
    failedCount: stats.failedCount + 1,
  };
};

const uniqueItemsByCanonicalUrl = (items: readonly DiscoveredItem[]): readonly DiscoveredItem[] => [
  ...new Map(items.map((item) => [`${item.sourceId}\n${item.canonicalUrl}`, item])).values(),
];

const itemStateIsIncomplete = (itemState: PublicSourceItemState | undefined): boolean =>
  itemState !== undefined &&
  (!itemState.currentContentHash || !itemState.latestDocumentId || !itemState.latestRawArtifactId);

const itemStateIsComplete = (
  itemState: PublicSourceItemState | undefined,
): itemState is PublicSourceItemState =>
  itemState !== undefined && !itemStateIsIncomplete(itemState);

const dateTime = (date: Date | null | undefined): number | null =>
  date === undefined || date === null ? null : date.getTime();

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

const feedMetadataUnchanged = (
  item: DiscoveredItem,
  itemState: PublicSourceItemState | undefined,
): boolean =>
  itemStateIsComplete(itemState) &&
  itemState.consecutiveFailures === 0 &&
  itemState.externalId === item.externalId &&
  itemState.title === item.title &&
  dateTime(itemState.publishedAt) === dateTime(item.publishedAt) &&
  dateTime(itemState.updatedAt) === dateTime(item.updatedAt) &&
  (itemState.summary ?? undefined) === (item.summary ?? undefined) &&
  stableJson(itemState.metadata ?? {}) === stableJson(item.metadata ?? {});

export const runPublicSourceIngestion = (
  adapter: SourceAdapter,
  options: PublicSourceIngestionOptions,
): Effect.Effect<PublicSourceIngestionStats, unknown, PublicSourceIngestionRepository> =>
  Effect.gen(function* () {
    const repository = yield* PublicSourceIngestionRepository;
    const run = yield* repository.startRun(adapter.definition, options);

    return yield* Effect.gen(function* () {
      let stats = emptyStats(adapter.definition.id, options.mode);

      const discoveryOptions = {
        requests: yield* repository.getDiscoveryRequests(adapter.definition),
      };
      const discovered = yield* discoverSource(adapter, {
        discoveryOptions,
        ...(options.now ? { now: options.now } : {}),
      }).pipe(
        Effect.catch((error) =>
          repository
            .recordDiscoveryFailure(adapter.definition, error)
            .pipe(Effect.andThen(Effect.fail(error))),
        ),
      );

      yield* repository.recordDiscoveryResult(adapter.definition, discovered);

      const discoveredItems =
        discovered.status === "fetched"
          ? discovered.items.filter((item) =>
              options.mode === "backfill" ? isWithinBackfillWindow(item, options.since) : true,
            )
          : [];
      const missingRecentItems =
        options.mode === "backfill" && options.since
          ? yield* repository.getRecentIncompleteItems(adapter.definition, options.since)
          : [];
      const items = uniqueItemsByCanonicalUrl([...discoveredItems, ...missingRecentItems]);

      stats = {
        ...stats,
        discoveredCount: items.length,
      };

      for (const item of items) {
        const itemState = yield* repository.getItemState(item.sourceId, item.canonicalUrl);

        if (options.mode === "poll" && feedMetadataUnchanged(item, itemState)) {
          stats = {
            ...stats,
            unchangedCount: stats.unchangedCount + 1,
          };
          continue;
        }

        yield* repository.recordDiscoveredItem(item);
        const shouldBypassValidators =
          options.mode === "backfill" && itemStateIsIncomplete(itemState);
        const updatedItemState = yield* repository.getItemState(item.sourceId, item.canonicalUrl);
        const fetchOptions =
          updatedItemState?.validators && !shouldBypassValidators
            ? { validators: updatedItemState.validators }
            : undefined;
        const result = yield* ingestDiscoveredItem(adapter, item, fetchOptions).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              status: "failed",
              item,
              error,
            } satisfies SourceIngestionResult),
          ),
        );

        if (result.status === "ingested") {
          const stored = yield* repository.storeIngestedItem(result);
          stats = addResultToStats(stats, result, stored.storedDocument);
        } else if (result.status === "not_modified") {
          yield* repository.recordUnchangedItem(result);
          stats = addResultToStats(stats, result, false);
        } else {
          yield* repository.recordItemFailure(result);
          stats = addResultToStats(stats, result, false);
        }
      }

      yield* repository.completeRun(run, stats);
      return stats;
    }).pipe(
      Effect.catch((error) =>
        repository.failRun(run, error).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
  });

export const runPublicSourceIngestionBatch = (
  adapters: readonly SourceAdapter[],
  options: PublicSourceIngestionOptions,
): Effect.Effect<readonly PublicSourceIngestionStats[], unknown, PublicSourceIngestionRepository> =>
  Effect.all(
    adapters.map((adapter) => runPublicSourceIngestion(adapter, options)),
    {
      concurrency: 2,
    },
  );
