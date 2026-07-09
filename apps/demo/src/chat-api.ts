import type {
  ChatTranscriptCitation,
  ChatTranscriptContextBlock,
  ChatTranscriptMessage,
} from "@brief/ui";

export type ChatApiCitation = {
  readonly blockId: string;
  readonly kind: "document" | "memory";
  readonly label: string | null;
  readonly sourceDisplayName: string | null;
  readonly title: string | null;
  readonly canonicalUrl: string | null;
  readonly publishedAt: string | null;
};

export type ChatApiContextBlock = {
  readonly blockId: string;
  readonly kind: "document" | "memory";
  readonly label: string | null;
  readonly tokenEstimate: number;
};

export type ChatApiMessage = {
  readonly id: string;
  readonly author: "user" | "assistant";
  readonly content: string;
  readonly createdAt: string;
  readonly citations?: readonly ChatApiCitation[];
  readonly contextBlocks?: readonly ChatApiContextBlock[];
};

export type ChatApiResponse = {
  readonly chat: {
    readonly id: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly messages: readonly ChatApiMessage[];
  readonly activeRunId: string | null;
};

export type SendMessageResponse = {
  readonly messageId: string;
  readonly runId: string;
};

export type MemoryRevisionResponse = {
  readonly id: string;
  readonly action: string;
  readonly contentBefore: string | null;
  readonly contentAfter: string | null;
  readonly runId: string | null;
  readonly createdAt: string;
};

export type MemoryResponse = {
  readonly id: string;
  readonly kind: string;
  readonly content: string;
  readonly evidenceQuote: string;
  readonly deleted: boolean;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revisions: readonly MemoryRevisionResponse[];
};

export type MemoriesApiResponse = {
  readonly memories: readonly MemoryResponse[];
};

export type ChatDisplayLabels = {
  readonly memoryCitation: string;
  readonly memoryBlockLabel: string;
};

const mapCitation = (
  citation: ChatApiCitation,
  labels: ChatDisplayLabels,
): ChatTranscriptCitation => ({
  id: citation.blockId,
  label: citation.kind === "memory" ? labels.memoryCitation : (citation.label ?? citation.blockId),
  url: citation.canonicalUrl,
  publishedAt: citation.publishedAt,
  title: citation.kind === "memory" ? labels.memoryCitation : citation.title,
  sourceDisplayName: citation.sourceDisplayName,
});

const mapContextBlock = (
  block: ChatApiContextBlock,
  labels: ChatDisplayLabels,
): ChatTranscriptContextBlock => ({
  blockId: block.blockId,
  kind: block.kind,
  label: block.kind === "memory" ? labels.memoryBlockLabel : (block.label ?? block.blockId),
  tokenEstimate: block.tokenEstimate,
});

export const mapApiMessagesToTranscript = (
  messages: readonly ChatApiMessage[],
  labels: ChatDisplayLabels,
): readonly ChatTranscriptMessage[] =>
  messages.map((message) => ({
    id: message.id,
    author: message.author,
    content: message.content,
    citations: (message.citations ?? []).map((citation) => mapCitation(citation, labels)),
    contextBlocks: (message.contextBlocks ?? []).map((block) => mapContextBlock(block, labels)),
  }));
