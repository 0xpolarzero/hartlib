import {
  discoverSource,
  ingestDiscoveredItem,
  SourceIngestionError,
} from "@brief/source-ingestion";
import type {
  DiscoveredItem,
  PublicSourceId,
  SourceAdapter,
  SourceIngestionResult,
} from "@brief/source-ingestion";
import { Cause, Effect } from "effect";
import { PublicSourceIngestionRepository } from "./repository";
import type {
  PublicSourceIngestionMode,
  PublicSourceIngestionOptions,
  PublicSourceIngestionStats,
  PublicSourceItemState,
} from "./types";

const isWithinIngestionWindow = (item: DiscoveredItem, since: Date | undefined): boolean => {
  if (!since) {
    return true;
  }

  if (item.publishedAt !== null) {
    return item.publishedAt >= since;
  }

  return item.discoveredAt === undefined || item.discoveredAt >= since;
};

const defaultOperationTimeoutMs = 60_000;

const publicSourceOperationTimeoutError = (
  label: string,
  sourceId: PublicSourceId,
  timeoutMs: number,
): SourceIngestionError =>
  new SourceIngestionError(`${label} timed out for ${sourceId} after ${timeoutMs}ms`, {
    sourceId,
  });

const normalizeOperationError = (
  error: unknown,
  label: string,
  sourceId: PublicSourceId,
  timeoutMs: number,
): SourceIngestionError => {
  if (Cause.isTimeoutError(error)) {
    return publicSourceOperationTimeoutError(label, sourceId, timeoutMs);
  }

  return error instanceof SourceIngestionError
    ? error
    : new SourceIngestionError(`${label} failed for ${sourceId}`, {
        sourceId,
        cause: error,
      });
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

const itemKey = (item: DiscoveredItem): string => `${item.sourceId}\n${item.canonicalUrl}`;

const itemStateIsIncomplete = (itemState: PublicSourceItemState | undefined): boolean =>
  itemState !== undefined &&
  (!itemState.stored ||
    !itemState.currentContentHash ||
    !itemState.latestDocumentId ||
    !itemState.latestRawArtifactId ||
    itemState.title.includes("�"));

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

const validateReadableIngestedItem = (
  result: Extract<SourceIngestionResult, { status: "ingested" }>,
): SourceIngestionResult => {
  const mediaType = result.raw.mediaType.toLowerCase();
  if (!mediaType.includes("html") && !mediaType.includes("pdf")) {
    return {
      status: "failed",
      item: result.item,
      error: new SourceIngestionError(
        `public source artifact is not readable HTML/PDF: ${result.raw.mediaType}`,
        {
          sourceId: result.item.sourceId,
        },
      ),
    } satisfies SourceIngestionResult;
  }
  if (result.document.textCharCount < 100) {
    return {
      status: "failed",
      item: result.item,
      error: new SourceIngestionError(
        `public source document is too short to be considered readable: ${result.document.textCharCount}`,
        {
          sourceId: result.item.sourceId,
        },
      ),
    } satisfies SourceIngestionResult;
  }

  return result;
};

const shouldFetchDiscoveredItem = (
  item: DiscoveredItem,
  itemState: PublicSourceItemState | undefined,
  options: PublicSourceIngestionOptions,
): boolean => {
  if (options.mode === "backfill") {
    return isWithinIngestionWindow(item, options.since);
  }

  if (!itemState) {
    return true;
  }

  return itemState.stored;
};

export const runPublicSourceIngestion = (
  adapter: SourceAdapter,
  options: PublicSourceIngestionOptions,
): Effect.Effect<PublicSourceIngestionStats, unknown, PublicSourceIngestionRepository> =>
  Effect.gen(function* () {
    const repository = yield* PublicSourceIngestionRepository;
    const run = yield* repository.startRun(adapter.definition, options);
    const operationTimeoutMs = options.operationTimeoutMs ?? defaultOperationTimeoutMs;

    return yield* Effect.gen(function* () {
      let stats = emptyStats(adapter.definition.id, options.mode);

      const discoveryOptions = {
        requests: yield* repository.getDiscoveryRequests(adapter.definition),
      };
      const discovered = yield* discoverSource(adapter, {
        discoveryOptions,
        ...(options.now ? { now: options.now } : {}),
      }).pipe(
        Effect.timeout(`${operationTimeoutMs} millis`),
        Effect.mapError((error) =>
          normalizeOperationError(
            error,
            "public source discovery",
            adapter.definition.id,
            operationTimeoutMs,
          ),
        ),
        Effect.catch((error) =>
          repository
            .recordDiscoveryFailure(adapter.definition, error)
            .pipe(Effect.andThen(Effect.fail(error))),
        ),
      );

      yield* repository.recordDiscoveryResult(adapter.definition, discovered);

      const discoveredItems = discovered.status === "fetched" ? discovered.items : [];
      const itemStatesBeforeDiscovery = new Map<string, PublicSourceItemState | undefined>();
      for (const item of discoveredItems) {
        const itemState = yield* repository.getItemState(item.sourceId, item.canonicalUrl);
        itemStatesBeforeDiscovery.set(itemKey(item), itemState);
        if (!itemState?.stored) {
          yield* repository.recordDiscoveredItem(item);
        }
      }

      const fetchableDiscoveredItems = discoveredItems.filter((item) =>
        shouldFetchDiscoveredItem(item, itemStatesBeforeDiscovery.get(itemKey(item)), options),
      );
      const missingRecentItems =
        options.mode === "backfill" && options.since
          ? yield* repository.getRecentIncompleteItems(adapter.definition, options.since)
          : [];
      const items = uniqueItemsByCanonicalUrl([...fetchableDiscoveredItems, ...missingRecentItems]);

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

        const shouldBypassValidators = itemStateIsIncomplete(itemState);
        const updatedItemState = yield* repository.getItemState(item.sourceId, item.canonicalUrl);
        const fetchOptions =
          updatedItemState?.validators && !shouldBypassValidators
            ? { validators: updatedItemState.validators }
            : undefined;
        const result = yield* ingestDiscoveredItem(adapter, item, fetchOptions).pipe(
          Effect.timeout(`${operationTimeoutMs} millis`),
          Effect.mapError((error) =>
            normalizeOperationError(
              error,
              "public source item ingestion",
              adapter.definition.id,
              operationTimeoutMs,
            ),
          ),
          Effect.catch((error) =>
            Effect.succeed({
              status: "failed",
              item,
              error,
            } satisfies SourceIngestionResult),
          ),
        );

        const validatedResult =
          result.status === "ingested" ? validateReadableIngestedItem(result) : result;

        if (validatedResult.status === "ingested") {
          const stored = yield* repository.storeIngestedItem(validatedResult);
          stats = addResultToStats(stats, validatedResult, stored.storedDocument);
        } else if (validatedResult.status === "not_modified") {
          yield* repository.recordUnchangedItem(validatedResult);
          stats = addResultToStats(stats, validatedResult, false);
        } else {
          yield* repository.recordItemFailure(validatedResult);
          stats = addResultToStats(stats, validatedResult, false);
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
