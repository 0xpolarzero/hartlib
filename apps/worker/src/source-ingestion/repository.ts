import { Context, Effect, Layer } from "effect";
import { sha256Hex } from "@brief/source-ingestion";
import type {
  ConditionalRequestValidators,
  DiscoveredItem,
  PublicSourceDefinition,
  PublicSourceId,
} from "@brief/source-ingestion";
import type {
  PublicSourceIngestionRepositoryShape,
  PublicSourceIngestionRun,
  PublicSourceIngestionStats,
} from "./types";

const optionalValidators = (
  etag?: string,
  lastModified?: string,
): ConditionalRequestValidators | undefined => {
  if (!etag && !lastModified) {
    return undefined;
  }

  return {
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {}),
  };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const readableArtifactMediaType = (mediaType: string): boolean => {
  const lower = mediaType.toLowerCase();
  return lower.includes("html") || lower.includes("pdf");
};

const assertReadableStoredItem = (
  raw: { readonly mediaType: string },
  document: { readonly textCharCount: number },
) => {
  if (!readableArtifactMediaType(raw.mediaType)) {
    throw new Error(`public source artifact is not readable HTML/PDF: ${raw.mediaType}`);
  }
  if (document.textCharCount < 100) {
    throw new Error(
      `public source document is too short to be considered readable: ${document.textCharCount}`,
    );
  }
};

export class PublicSourceIngestionRepository extends Context.Service<
  PublicSourceIngestionRepository,
  PublicSourceIngestionRepositoryShape
>()("brief/worker/PublicSourceIngestionRepository") {}

type MemorySourceState = {
  readonly definition: PublicSourceDefinition;
  readonly discovery: Map<
    string,
    {
      readonly etag: string | undefined;
      readonly lastModified: string | undefined;
      readonly bodyHash: string | undefined;
      readonly lastStatus: number | undefined;
      readonly lastFetchedAt: Date | undefined;
    }
  >;
  readonly failures: readonly string[];
};

type MemoryItemState = {
  readonly item: DiscoveredItem;
  readonly etag: string | undefined;
  readonly lastModified: string | undefined;
  readonly currentContentHash: string | undefined;
  readonly latestDocumentId: string | undefined;
  readonly latestRawArtifactId: string | undefined;
  readonly lastFetchedAt: Date | undefined;
  readonly lastSuccessfulFetchAt: Date | undefined;
  readonly lastNotModifiedAt: Date | undefined;
  readonly failures: readonly string[];
};

export interface InMemoryPublicSourceIngestionState {
  readonly sources: Map<PublicSourceId, MemorySourceState>;
  readonly candidates: Map<string, MemoryItemState>;
  readonly items: Map<string, MemoryItemState>;
  readonly rawArtifacts: Map<string, unknown>;
  readonly documents: Map<string, unknown>;
  readonly runs: Array<
    PublicSourceIngestionRun & {
      readonly status: "running" | "completed" | "failed";
      readonly completedAt?: Date;
      readonly stats?: PublicSourceIngestionStats;
      readonly error?: string;
    }
  >;
}

const itemKey = (sourceId: PublicSourceId, canonicalUrl: string): string =>
  `${sourceId}\n${canonicalUrl}`;

const itemStateIsRecent = (state: MemoryItemState, since: Date): boolean =>
  state.item.publishedAt !== null
    ? state.item.publishedAt >= since
    : state.item.discoveredAt === undefined || state.item.discoveredAt >= since;

export const makeInMemoryPublicSourceIngestionRepository = (
  state: InMemoryPublicSourceIngestionState = {
    sources: new Map(),
    candidates: new Map(),
    items: new Map(),
    rawArtifacts: new Map(),
    documents: new Map(),
    runs: [],
  },
): PublicSourceIngestionRepositoryShape => {
  const ensureSource = (definition: PublicSourceDefinition): MemorySourceState => {
    const existing = state.sources.get(definition.id);
    if (existing) {
      return existing;
    }

    const created = {
      definition,
      discovery: new Map(),
      failures: [],
    } satisfies MemorySourceState;
    state.sources.set(definition.id, created);
    return created;
  };

  return {
    startRun: (source, options) =>
      Effect.sync(() => {
        ensureSource(source);
        const run = {
          id: `${source.id}:${options.mode}:${state.runs.length + 1}`,
          sourceId: source.id,
          mode: options.mode,
          startedAt: options.now?.() ?? new Date(),
          status: "running",
        } as const;
        state.runs.push(run);
        return run;
      }),
    completeRun: (run, stats) =>
      Effect.sync(() => {
        const index = state.runs.findIndex((candidate) => candidate.id === run.id);
        const existing = state.runs[index];
        if (!existing) {
          return;
        }

        state.runs[index] = {
          ...existing,
          status: "completed",
          completedAt: new Date(),
          stats,
        };
      }),
    failRun: (run, error) =>
      Effect.sync(() => {
        const index = state.runs.findIndex((candidate) => candidate.id === run.id);
        const existing = state.runs[index];
        if (!existing) {
          return;
        }

        state.runs[index] = {
          ...existing,
          status: "failed",
          completedAt: new Date(),
          error: errorMessage(error),
        };
      }),
    getDiscoveryRequests: (source) =>
      Effect.sync(() => {
        const sourceState = ensureSource(source);
        const urls = source.discoveryUrls ?? [source.discoveryUrl];
        return urls.map((url) => {
          const requestState = sourceState.discovery.get(url);
          const validators = requestState
            ? optionalValidators(requestState.etag, requestState.lastModified)
            : undefined;
          if (!validators) {
            return { url };
          }
          return {
            url,
            validators,
          };
        });
      }),
    recordDiscoveryResult: (source, result) =>
      Effect.sync(() => {
        const sourceState = ensureSource(source);
        for (const metadata of result.metadata) {
          const current = sourceState.discovery.get(metadata.url);
          sourceState.discovery.set(metadata.url, {
            etag: metadata.etag ?? current?.etag,
            lastModified: metadata.lastModified ?? current?.lastModified,
            bodyHash: metadata.bodyHash ?? current?.bodyHash,
            lastStatus: metadata.status,
            lastFetchedAt: result.discoveredAt,
          });
        }
      }),
    recordDiscoveryFailure: (source, error) =>
      Effect.sync(() => {
        const sourceState = ensureSource(source);
        state.sources.set(source.id, {
          ...sourceState,
          failures: [...sourceState.failures, errorMessage(error)],
        });
      }),
    getItemState: (sourceId, canonicalUrl) =>
      Effect.sync(() => {
        const existing = state.items.get(itemKey(sourceId, canonicalUrl));
        const candidate = state.candidates.get(itemKey(sourceId, canonicalUrl));
        if (!existing && !candidate) {
          return undefined;
        }
        const row = existing ?? candidate!;

        return {
          sourceId,
          canonicalUrl,
          externalId: row.item.externalId,
          title: row.item.title,
          publishedAt: row.item.publishedAt,
          updatedAt: row.item.updatedAt,
          summary: row.item.summary,
          metadata: row.item.metadata ?? {},
          validators: optionalValidators(row.etag, row.lastModified),
          currentContentHash: row.currentContentHash,
          latestDocumentId: row.latestDocumentId,
          latestRawArtifactId: row.latestRawArtifactId,
          lastFetchedAt: row.lastFetchedAt,
          lastSuccessfulFetchAt: row.lastSuccessfulFetchAt,
          consecutiveFailures: row.failures.length,
          stored: existing !== undefined,
        };
      }),
    getRecentIncompleteItems: (source, since) =>
      Effect.sync(() =>
        [...state.candidates.values()]
          .filter(
            (existing) =>
              existing.item.sourceId === source.id && itemStateIsRecent(existing, since),
          )
          .map((existing) => existing.item),
      ),
    recordDiscoveredItem: (item) =>
      Effect.sync(() => {
        const key = itemKey(item.sourceId, item.canonicalUrl);
        const existing = state.candidates.get(key) ?? state.items.get(key);
        state.candidates.set(key, {
          item: {
            ...item,
            discoveredAt: item.discoveredAt ?? existing?.item.discoveredAt ?? new Date(),
          },
          etag: existing?.etag,
          lastModified: existing?.lastModified,
          currentContentHash: existing?.currentContentHash,
          latestDocumentId: existing?.latestDocumentId,
          latestRawArtifactId: existing?.latestRawArtifactId,
          lastFetchedAt: existing?.lastFetchedAt,
          lastSuccessfulFetchAt: existing?.lastSuccessfulFetchAt,
          lastNotModifiedAt: existing?.lastNotModifiedAt,
          failures: existing?.failures ?? [],
        });
      }),
    storeIngestedItem: (result) =>
      Effect.gen(function* () {
        assertReadableStoredItem(result.raw, result.document);
        const rawBodyHash = yield* Effect.promise(() => sha256Hex(result.raw.body));
        const rawKey = itemKey(result.raw.sourceId, `${result.raw.canonicalUrl}\n${rawBodyHash}`);
        state.rawArtifacts.set(rawKey, result.raw);

        const storedDocument = !state.documents.has(result.document.id);
        state.documents.set(result.document.id, result.document);

        const key = itemKey(result.item.sourceId, result.item.canonicalUrl);
        const existing = state.items.get(key) ?? state.candidates.get(key);
        const etag =
          typeof result.raw.metadata?.etag === "string" ? result.raw.metadata.etag : existing?.etag;
        const lastModified =
          typeof result.raw.metadata?.lastModified === "string"
            ? result.raw.metadata.lastModified
            : existing?.lastModified;
        state.items.set(key, {
          item: result.item,
          etag,
          lastModified,
          currentContentHash: result.document.contentHash,
          latestDocumentId: result.document.id,
          latestRawArtifactId: rawKey,
          lastFetchedAt: result.raw.fetchedAt,
          lastSuccessfulFetchAt: result.raw.fetchedAt,
          lastNotModifiedAt: existing?.lastNotModifiedAt,
          failures: [],
        });
        state.candidates.delete(key);

        return { storedDocument };
      }),
    recordUnchangedItem: (result) =>
      Effect.sync(() => {
        const key = itemKey(result.item.sourceId, result.item.canonicalUrl);
        const existing = state.items.get(key) ?? state.candidates.get(key);
        const etag =
          typeof result.result.metadata?.etag === "string"
            ? result.result.metadata.etag
            : existing?.etag;
        const lastModified =
          typeof result.result.metadata?.lastModified === "string"
            ? result.result.metadata.lastModified
            : existing?.lastModified;
        const next = {
          item: result.item,
          etag,
          lastModified,
          currentContentHash: existing?.currentContentHash,
          latestDocumentId: existing?.latestDocumentId,
          latestRawArtifactId: existing?.latestRawArtifactId,
          lastFetchedAt: result.result.fetchedAt,
          lastSuccessfulFetchAt: existing?.lastSuccessfulFetchAt,
          lastNotModifiedAt: result.result.fetchedAt,
          failures: [],
        };
        if (state.items.has(key)) {
          state.items.set(key, next);
        } else {
          state.candidates.set(key, next);
        }
      }),
    recordItemFailure: (result) =>
      Effect.sync(() => {
        const key = itemKey(result.item.sourceId, result.item.canonicalUrl);
        const existing = state.items.get(key) ?? state.candidates.get(key);
        const next = {
          item: result.item,
          etag: existing?.etag,
          lastModified: existing?.lastModified,
          currentContentHash: existing?.currentContentHash,
          latestDocumentId: existing?.latestDocumentId,
          latestRawArtifactId: existing?.latestRawArtifactId,
          lastFetchedAt: existing?.lastFetchedAt,
          lastSuccessfulFetchAt: existing?.lastSuccessfulFetchAt,
          lastNotModifiedAt: existing?.lastNotModifiedAt,
          failures: [...(existing?.failures ?? []), errorMessage(result.error)],
        };
        if (state.items.has(key)) {
          state.items.set(key, next);
        } else {
          state.candidates.set(key, next);
        }
      }),
  };
};

export const InMemoryPublicSourceIngestionRepositoryLayer = (
  state?: InMemoryPublicSourceIngestionState,
): Layer.Layer<PublicSourceIngestionRepository> =>
  Layer.succeed(
    PublicSourceIngestionRepository,
    PublicSourceIngestionRepository.of(makeInMemoryPublicSourceIngestionRepository(state)),
  );
