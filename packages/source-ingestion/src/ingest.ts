import { Effect } from "effect";
import type {
  DiscoveredItem,
  FailedSourceItem,
  SourceAdapter,
  SourceDiscoveryOptions,
  SourceDiscoveryResult,
  SourceFetchOptions,
  SourceIngestionResult,
  SourceIngestionError,
} from "./types";

export const discoverSource = (
  adapter: SourceAdapter,
  options: {
    readonly discoveryOptions?: SourceDiscoveryOptions;
    readonly now?: () => Date;
  } = {},
): Effect.Effect<SourceDiscoveryResult, SourceIngestionError> =>
  Effect.map(adapter.discover(options.discoveryOptions), (result) => {
    const discoveredAt = options.now?.() ?? result.discoveredAt;
    if (result.status === "not_modified") {
      return { ...result, discoveredAt };
    }

    return {
      ...result,
      discoveredAt,
      items: result.items.map((item) => ({ ...item, discoveredAt })),
    };
  });

export const discoverSourceItems = (
  adapter: SourceAdapter,
  now: () => Date = () => new Date(),
): Effect.Effect<readonly DiscoveredItem[], SourceIngestionError> =>
  Effect.map(discoverSource(adapter, { now }), (result) =>
    result.status === "fetched" ? result.items : [],
  );

export const ingestDiscoveredItem = (
  adapter: SourceAdapter,
  item: DiscoveredItem,
  options?: SourceFetchOptions,
): Effect.Effect<SourceIngestionResult, SourceIngestionError> =>
  Effect.gen(function* () {
    const result = yield* adapter.fetch(item, options);
    if (result.status === "not_modified") {
      return { status: "not_modified", item, result } satisfies SourceIngestionResult;
    }

    const document = yield* adapter.normalize(result.raw, item);
    return {
      status: "ingested",
      item,
      raw: result.raw,
      document,
    } satisfies SourceIngestionResult;
  });

export const ingestSource = (
  adapter: SourceAdapter,
  options: {
    readonly discoveryOptions?: SourceDiscoveryOptions;
    readonly fetchOptions?: SourceFetchOptions;
    readonly now?: () => Date;
  } = {},
): Effect.Effect<readonly SourceIngestionResult[], SourceIngestionError> =>
  Effect.flatMap(
    discoverSource(adapter, {
      ...(options.discoveryOptions ? { discoveryOptions: options.discoveryOptions } : {}),
      ...(options.now ? { now: options.now } : {}),
    }),
    (discovery) =>
      discovery.status === "not_modified"
        ? Effect.succeed([])
        : Effect.all(
            discovery.items.map((item) =>
              Effect.catch(ingestDiscoveredItem(adapter, item, options.fetchOptions), (error) =>
                Effect.succeed({
                  status: "failed",
                  item,
                  error,
                } satisfies FailedSourceItem),
              ),
            ),
          ),
  );
