import type { CharacterRange, TopicId } from "./canonicalization";
import type { AiRunErrorCode } from "./errors";
import type { LiveProviderRequest } from "./provider-request";
import type { EffectiveWebPolicy as SharedEffectiveWebPolicy } from "@hartlib/shared";

export type Locale = "fr-FR" | "en-US";
export type Market = "FR" | "US";
export type MemoryKind = "profile" | "preference" | "instruction" | "fact" | "episode";

export type EffectiveWebPolicy = SharedEffectiveWebPolicy;

export interface CompleteConversationEntry {
  readonly turnId: string;
  readonly userMessageId: string;
  readonly userContent: string;
  readonly assistantMessageId: string;
  readonly assistantContent: string;
}

export interface FailedConversationEntry {
  readonly turnId: string;
  readonly userMessageId: string;
  readonly userContent: string;
  readonly errorCode: string;
  readonly retryable: boolean;
}

export type ConversationEntry = CompleteConversationEntry | FailedConversationEntry;

export type PlanTurnResult =
  | { readonly mode: "clarify"; readonly question: string }
  | {
      readonly mode: "single";
      readonly question: string;
      readonly relevantTurnIds: readonly string[];
    }
  | {
      readonly mode: "fanout";
      readonly question: string;
      readonly topics: ReadonlyArray<{
        readonly topicId: TopicId;
        readonly question: string;
        readonly relevantTurnIds: readonly string[];
      }>;
    };

export type InternalQuery =
  | {
      readonly target: "documents";
      readonly terms?: string | undefined;
      readonly purpose: string;
      /** Opaque, one-use server handoff minted by lookup_named_source. */
      readonly lookupRef?: string | undefined;
      readonly countries?: readonly string[] | undefined;
      readonly languages?: readonly string[] | undefined;
      readonly documentTypes?: readonly string[] | undefined;
      readonly publishedAfter?: string | undefined;
      readonly publishedBefore?: string | undefined;
      readonly orderBy?: "relevance" | "recency" | undefined;
      readonly limit?: number | undefined;
    }
  | {
      readonly target: "chat_messages";
      readonly terms: string;
      readonly purpose: string;
      readonly beforeMessageId?: string | undefined;
      readonly limit?: number | undefined;
    };

export type DocumentSource =
  | { readonly kind: "public"; readonly sourceId: string }
  | {
      readonly kind: "publisher";
      readonly sourceId: string;
      readonly issueId: string;
      readonly documentId: string;
    };

export type InternalReference =
  | {
      readonly kind: "document";
      readonly documentId: string;
      /** Server-owned binding fields are populated after provider validation. */
      readonly snapshotId: string;
      readonly publisherExtractionId?: string | undefined;
      readonly source: DocumentSource;
      readonly ranges?: readonly CharacterRange[] | undefined;
      readonly purpose: string;
    }
  | { readonly kind: "chat_message"; readonly messageId: string; readonly purpose: string };

export interface MemoryReference {
  readonly memoryId: string;
  readonly memoryRevisionId: string;
}

export interface WebEvidence {
  readonly url: string;
  readonly title: string;
  readonly domain: string;
  readonly quote: string;
  readonly publishedAt?: string | undefined;
  readonly capturedAt: string;
  readonly purpose: string;
}

export interface DocumentCandidate {
  readonly id: string;
  readonly kind: "document";
  readonly rank: number;
  readonly purpose: string;
  readonly sourceId: string;
  readonly documentId: string;
  readonly snapshotId: string;
  readonly publisherExtractionId?: string | undefined;
  readonly publisherIssueId?: string | undefined;
  readonly publisherDocumentId?: string | undefined;
  readonly contentHash: string;
  readonly text: string;
  readonly ranges: readonly CharacterRange[];
  readonly label: string | null;
  readonly publicProvenance: PublicProvenance;
  readonly renderedTokenCount: number;
}

export interface ChatMessageCandidate {
  readonly id: string;
  readonly kind: "chat_message";
  readonly rank: number;
  readonly purpose: string;
  readonly messageId: string;
  readonly text: string;
  readonly label: string | null;
  readonly renderedTokenCount: number;
}

export interface MemoryCandidate {
  readonly id: string;
  readonly kind: "memory";
  readonly rank: number;
  readonly purpose: string;
  readonly memoryId: string;
  readonly memoryRevisionId: string;
  readonly text: string;
  readonly label: string | null;
  readonly renderedTokenCount: number;
}

export interface WebCandidate extends WebEvidence {
  readonly id: string;
  readonly kind: "web";
  readonly rank: number;
  readonly quoteHash: string;
  readonly label: string | null;
  readonly renderedTokenCount: number;
}
export interface TopicPacketCandidate {
  readonly id: string;
  readonly kind: "topic_packet";
  readonly rank: number;
  readonly purpose: string;
  readonly topicId: TopicId;
  /** Canonical JSON text of the immutable provider-authored topic packet. */
  readonly text: string;
  readonly packetSha256Hex: string;
  readonly label: string | null;
  readonly renderedTokenCount: number;
}

export type AnswerCandidate =
  | DocumentCandidate
  | ChatMessageCandidate
  | MemoryCandidate
  | WebCandidate
  | TopicPacketCandidate;

export type CandidateRejectionReason =
  | "inaccessible"
  | "missing"
  | "invalid_range"
  | "ambiguous_provenance"
  | "duplicate"
  | "overlap_merged";

export interface CandidateRejection {
  readonly candidateId: string;
  readonly reason: CandidateRejectionReason;
}

export interface PublicProvenance {
  readonly sourceName?: string | undefined;
  readonly issueTitle?: string | undefined;
  readonly documentTitle?: string | undefined;
  readonly citationUrl?: string | undefined;
  readonly publishedAt?: string | undefined;
}

export interface SerializedSourceUse {
  readonly consumerTaskId: string;
  readonly topicId?: TopicId | undefined;
  readonly contextOrder: number;
  readonly renderedTokenCount: number;
  readonly ranges: readonly CharacterRange[];
}

export type PublisherDocumentLocator = {
  readonly kind: "document";
  readonly sourceId: `publisher:${string}`;
  readonly documentId: string;
  readonly snapshotId: string;
  readonly contentHash: string;
  readonly ranges: readonly CharacterRange[];
  readonly publisherExtractionId: string;
  readonly publisherIssueId: string;
  readonly publisherDocumentId: string;
};

export type PublicDocumentLocator = {
  readonly kind: "document";
  readonly sourceId: string;
  readonly documentId: string;
  readonly snapshotId: string;
  readonly contentHash: string;
  readonly ranges: readonly CharacterRange[];
  /** Publisher identity fields are forbidden on public locators. */
  readonly publisherExtractionId?: never;
  readonly publisherIssueId?: never;
  readonly publisherDocumentId?: never;
};

export type SourceLocator =
  | PublicDocumentLocator
  | PublisherDocumentLocator
  | { readonly kind: "chat_message"; readonly messageId: string }
  | {
      readonly kind: "memory";
      readonly memoryId: string;
      readonly memoryRevisionId: string;
    }
  | {
      readonly kind: "web";
      readonly url: string;
      readonly title: string;
      readonly domain: string;
      readonly quote: string;
      readonly quoteHash: string;
      readonly publishedAt?: string | undefined;
      readonly capturedAt: string;
    };

export interface FinalSourceRecord {
  readonly sourceKey: string;
  readonly locator: SourceLocator;
  readonly label: string | null;
  readonly publicProvenance: PublicProvenance;
  readonly uses: readonly SerializedSourceUse[];
}

export interface ProviderRequestMeasurement {
  readonly modelId: "glm-5.2" | "glm-5-turbo";
  readonly inputTokens: number;
  readonly requestedOutputTokens: number;
  readonly usableInputTokens: number;
  readonly contextWindow: number;
  readonly passed: boolean;
}

export type LiveProviderRequestMeasurement = Omit<ProviderRequestMeasurement, "modelId"> & {
  readonly modelId: LiveProviderRequest["model"];
};

export interface TopicPacket {
  readonly topicId: TopicId;
  readonly status: "answered" | "partial";
  readonly claims: ReadonlyArray<{ readonly text: string; readonly sourceKeys: readonly string[] }>;
  readonly gaps: readonly string[];
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly stopReason: string;
}

export interface MemorySnapshot {
  readonly memoryId: string;
  readonly memoryRevisionId: string;
  readonly kind: MemoryKind;
  readonly content: string;
}

export interface MemoryProposal {
  readonly kind: MemoryKind;
  readonly content: string;
  readonly targetMemoryId?: string | undefined;
}

export interface ValidatedMemoryProposal extends MemoryProposal {
  readonly expectedHeadRevisionId?: string | undefined;
}

export interface MemoryExtractionResult {
  readonly proposals: readonly ValidatedMemoryProposal[];
  readonly discardedCount: number;
}

export interface MemoryExtractionArtifact {
  readonly result: MemoryExtractionResult;
  readonly producer: {
    readonly taskId: "memory-extract" | "evaluation-general-planner";
    readonly loopIteration: number;
    readonly attempt: number;
    readonly observationKey: string;
    readonly extractionSha256Hex: string;
  };
}

export type AnswerLaneResult =
  | {
      readonly status: "ok";
      readonly mode: "clarification" | "single" | "synthesis";
      readonly content: string;
      readonly sourceMap: readonly FinalSourceRecord[];
    }
  | { readonly status: "failed"; readonly code: AiRunErrorCode; readonly retryable: boolean };
