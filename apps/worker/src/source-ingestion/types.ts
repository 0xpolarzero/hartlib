import type {
  ConditionalRequestValidators,
  DiscoveredItem,
  DiscoveryRequestState,
  PublicSourceDefinition,
  PublicSourceId,
  SourceDiscoveryResult,
  SourceIngestionResult,
} from "@hartlib/source-ingestion";
import type { Effect } from "effect";

export type PublicSourceIngestionMode = "backfill" | "poll";

/**
 * Discovery adapters may carry a fetched representation only long enough for
 * the current ingestion attempt. Persisting or comparing that payload as feed
 * metadata makes identical Service-Public items look changed on every poll.
 */
export const durablePublicSourceItemMetadata = (
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  const { xmlBody: _xmlBody, ...durable } = metadata ?? {};
  return durable;
};

export interface PublicSourceIngestionOptions {
  readonly mode: PublicSourceIngestionMode;
  readonly since?: Date;
  readonly now?: () => Date;
  readonly operationTimeoutMs?: number;
}

export interface PublicSourceIngestionStats {
  readonly sourceId: PublicSourceId;
  readonly mode: PublicSourceIngestionMode;
  readonly discoveredCount: number;
  readonly fetchedCount: number;
  readonly unchangedCount: number;
  readonly storedDocumentCount: number;
  readonly failedCount: number;
}

export interface PublicSourceItemState {
  readonly sourceId: PublicSourceId;
  readonly canonicalUrl: string;
  readonly externalId: string | undefined;
  readonly title: string;
  readonly publishedAt: Date | null;
  readonly updatedAt: Date | null | undefined;
  readonly summary: string | undefined;
  readonly metadata: Record<string, unknown>;
  readonly validators: ConditionalRequestValidators | undefined;
  readonly currentContentHash: string | undefined;
  readonly latestDocumentId: string | undefined;
  readonly latestRawArtifactId: string | undefined;
  readonly lastFetchedAt: Date | undefined;
  readonly lastSuccessfulFetchAt: Date | undefined;
  readonly consecutiveFailures: number;
  /** Whether a candidate first observed during backfill may enter recurring polls. */
  readonly pollEligible: boolean;
  /** Repository-computed eligibility using its authoritative clock when available. */
  readonly retryEligible?: boolean;
  readonly stored: boolean;
}

export interface PublicSourceIngestionRun {
  readonly id: string;
  readonly sourceId: PublicSourceId;
  readonly mode: PublicSourceIngestionMode;
  readonly startedAt: Date;
}

export interface StoredIngestedItem {
  readonly storedDocument: boolean;
}

export interface PublicSourceIngestionRepositoryShape {
  readonly startRun: (
    source: PublicSourceDefinition,
    options: PublicSourceIngestionOptions,
  ) => Effect.Effect<PublicSourceIngestionRun, unknown>;
  readonly completeRun: (
    run: PublicSourceIngestionRun,
    stats: PublicSourceIngestionStats,
  ) => Effect.Effect<void, unknown>;
  readonly failRun: (run: PublicSourceIngestionRun, error: unknown) => Effect.Effect<void, unknown>;
  readonly getDiscoveryRequests: (
    source: PublicSourceDefinition,
  ) => Effect.Effect<readonly DiscoveryRequestState[], unknown>;
  readonly recordDiscoveryResult: (
    source: PublicSourceDefinition,
    result: SourceDiscoveryResult,
    options?: {
      readonly items?: readonly DiscoveredItem[];
      readonly pollEligible?: boolean;
    },
  ) => Effect.Effect<void, unknown>;
  readonly recordDiscoveryFailure: (
    source: PublicSourceDefinition,
    error: unknown,
  ) => Effect.Effect<void, unknown>;
  readonly getItemState: (
    sourceId: PublicSourceId,
    canonicalUrl: string,
  ) => Effect.Effect<PublicSourceItemState | undefined, unknown>;
  readonly getRecentIncompleteItems: (
    source: PublicSourceDefinition,
    since: Date,
  ) => Effect.Effect<readonly DiscoveredItem[], unknown>;
  readonly getRetryEligibleItems: (
    source: PublicSourceDefinition,
    now?: Date,
  ) => Effect.Effect<readonly DiscoveredItem[], unknown>;
  readonly recordDiscoveredItem: (
    item: DiscoveredItem,
    pollEligible: boolean,
  ) => Effect.Effect<void, unknown>;
  readonly storeIngestedItem: (
    result: Extract<SourceIngestionResult, { readonly status: "ingested" }>,
  ) => Effect.Effect<StoredIngestedItem, unknown>;
  readonly recordUnchangedItem: (
    result: Extract<SourceIngestionResult, { readonly status: "not_modified" }>,
  ) => Effect.Effect<void, unknown>;
  readonly recordItemFailure: (
    result: Extract<SourceIngestionResult, { readonly status: "failed" }>,
    attemptedAt: Date,
  ) => Effect.Effect<void, unknown>;
}
