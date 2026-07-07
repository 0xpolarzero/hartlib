import type {
  ConditionalRequestValidators,
  DiscoveredItem,
  DiscoveryRequestState,
  PublicSourceDefinition,
  PublicSourceId,
  SourceDiscoveryResult,
  SourceIngestionResult,
} from "@brief/source-ingestion";
import type { Effect } from "effect";

export type PublicSourceIngestionMode = "backfill" | "poll";

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
  readonly recordDiscoveredItem: (item: DiscoveredItem) => Effect.Effect<void, unknown>;
  readonly storeIngestedItem: (
    result: Extract<SourceIngestionResult, { readonly status: "ingested" }>,
  ) => Effect.Effect<StoredIngestedItem, unknown>;
  readonly recordUnchangedItem: (
    result: Extract<SourceIngestionResult, { readonly status: "not_modified" }>,
  ) => Effect.Effect<void, unknown>;
  readonly recordItemFailure: (
    result: Extract<SourceIngestionResult, { readonly status: "failed" }>,
  ) => Effect.Effect<void, unknown>;
}
