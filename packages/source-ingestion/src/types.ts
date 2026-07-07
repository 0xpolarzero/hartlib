import type { Effect } from "effect";

export type PublicSourceId = "service_public" | "bofip_impots" | "tresor" | "assemblee_nationale";

export type SourceIngestionMethod =
  | "atom_feed"
  | "json_dataset"
  | "xml_dataset"
  | "official_document";

export type SourceContentFormat = "text" | "html" | "pdf" | "docx" | "xml" | "json";

export type PublicSourceDefinition = {
  readonly id: PublicSourceId;
  readonly displayName: string;
  readonly publisherName: string;
  readonly description: string;
  readonly ingestionMethod: SourceIngestionMethod;
  readonly discoveryUrl: string;
  readonly discoveryUrls?: readonly string[];
  readonly contentUrl?: string;
  readonly contentFormats: readonly SourceContentFormat[];
  readonly averageCharsPerItem: number;
};

export type DiscoveredItem = {
  readonly sourceId: PublicSourceId;
  readonly externalId: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly publishedAt: Date | null;
  readonly discoveredAt?: Date;
  readonly updatedAt?: Date | null;
  readonly summary?: string;
  readonly metadata?: Record<string, unknown>;
};

export type RawArtifact = {
  readonly sourceId: PublicSourceId;
  readonly canonicalUrl: string;
  readonly fetchedAt: Date;
  readonly mediaType: string;
  readonly body: string;
  readonly metadata?: Record<string, unknown>;
};

export type FetchedSourceArtifact = {
  readonly status: "fetched";
  readonly raw: RawArtifact;
};

export type NotModifiedSourceArtifact = {
  readonly status: "not_modified";
  readonly sourceId: PublicSourceId;
  readonly canonicalUrl: string;
  readonly fetchedAt: Date;
  readonly metadata?: Record<string, unknown>;
};

export type SourceFetchResult = FetchedSourceArtifact | NotModifiedSourceArtifact;

export type CanonicalDocument = {
  readonly id: string;
  readonly sourceId: PublicSourceId;
  readonly externalId?: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly publishedAt: Date | null;
  readonly discoveredAt: Date;
  readonly fetchedAt: Date;
  readonly language: "fr";
  readonly documentType: "article" | "press_release" | "publication" | "doctrine_update";
  readonly text: string;
  readonly textCharCount: number;
  readonly contentHash: string;
  readonly rawArtifactKey: string;
  readonly sourceMetadata: Record<string, unknown>;
};

export type FetchResponse = {
  readonly url: string;
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly text: () => Promise<string>;
};

export type Fetcher = (url: string, init?: RequestInit) => Promise<FetchResponse>;

export type ConditionalRequestValidators = {
  readonly etag?: string;
  readonly lastModified?: string;
};

export type SourceFetchOptions = {
  readonly validators?: ConditionalRequestValidators;
};

export type DiscoveryRequestState = {
  readonly url: string;
  readonly validators?: ConditionalRequestValidators;
};

export type SourceDiscoveryOptions = {
  readonly validators?: ConditionalRequestValidators;
  readonly requests?: readonly DiscoveryRequestState[];
};

export type DiscoveryFetchMetadata = {
  readonly url: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly bodyHash?: string;
  readonly status: number;
};

export type FetchedSourceDiscovery = {
  readonly status: "fetched";
  readonly items: readonly DiscoveredItem[];
  readonly discoveredAt: Date;
  readonly metadata: readonly DiscoveryFetchMetadata[];
};

export type NotModifiedSourceDiscovery = {
  readonly status: "not_modified";
  readonly sourceId: PublicSourceId;
  readonly discoveredAt: Date;
  readonly metadata: readonly DiscoveryFetchMetadata[];
};

export type SourceDiscoveryResult = FetchedSourceDiscovery | NotModifiedSourceDiscovery;

export type IngestedSourceItem = {
  readonly status: "ingested";
  readonly item: DiscoveredItem;
  readonly raw: RawArtifact;
  readonly document: CanonicalDocument;
};

export type UnchangedSourceItem = {
  readonly status: "not_modified";
  readonly item: DiscoveredItem;
  readonly result: NotModifiedSourceArtifact;
};

export type FailedSourceItem = {
  readonly status: "failed";
  readonly item: DiscoveredItem;
  readonly error: SourceIngestionError;
};

export type SourceIngestionResult = IngestedSourceItem | UnchangedSourceItem | FailedSourceItem;

export type SourceAdapter = {
  readonly definition: PublicSourceDefinition;
  readonly discover: (
    options?: SourceDiscoveryOptions,
  ) => Effect.Effect<SourceDiscoveryResult, SourceIngestionError>;
  readonly fetch: (
    item: DiscoveredItem,
    options?: SourceFetchOptions,
  ) => Effect.Effect<SourceFetchResult, SourceIngestionError>;
  readonly normalize: (
    raw: RawArtifact,
    item?: DiscoveredItem,
  ) => Effect.Effect<CanonicalDocument, SourceIngestionError>;
};

export class SourceIngestionError extends Error {
  readonly sourceId?: PublicSourceId;
  readonly cause?: unknown;

  constructor(
    message: string,
    options?: { readonly sourceId?: PublicSourceId; readonly cause?: unknown },
  ) {
    super(message);
    this.name = "SourceIngestionError";
    if (options?.sourceId) {
      this.sourceId = options.sourceId;
    }
    if (options && "cause" in options) {
      this.cause = options.cause;
    }
  }
}
