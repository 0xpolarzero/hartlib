import {
  parseCitationTags,
  type ChatTranscriptCitation,
  type ChatTranscriptContextBlock,
  type ChatTranscriptMessage,
} from "@brief/ui";

import type { ChatStreamContextBlock, ChatStreamPhase, ChatStreamState } from "./chat-stream";

import type { ChatDisplayLabels } from "./chat-api";

function isStreamingPhase(phase: ChatStreamPhase): boolean {
  return phase === "answering" || phase === "retrying";
}

function transcriptContextBlock(
  block: ChatStreamContextBlock,
  labels: ChatDisplayLabels,
): ChatTranscriptContextBlock {
  return {
    blockId: block.blockId,
    kind: block.kind,
    label: block.kind === "memory" ? labels.memoryBlockLabel : (block.label ?? block.blockId),
    tokenEstimate: block.tokenEstimate,
  };
}

function citationFromContextBlock(
  block: ChatTranscriptContextBlock,
  labels: ChatDisplayLabels,
): ChatTranscriptCitation {
  const label = block.kind === "memory" ? labels.memoryCitation : block.label;
  return {
    id: block.blockId,
    label,
    url: null,
    publishedAt: null,
    title: label,
    sourceDisplayName: null,
  };
}

function citedBlocks(
  assistantText: string,
  contextBlocks: readonly ChatTranscriptContextBlock[],
): readonly ChatTranscriptContextBlock[] {
  const blocksById = new Map(contextBlocks.map((block) => [block.blockId, block]));
  const parsed = parseCitationTags(assistantText, [...blocksById.keys()]);
  const citedIds: string[] = [];

  for (const segment of parsed.segments) {
    if (segment.type !== "citations") continue;
    for (const citationId of segment.citationIds) {
      if (blocksById.has(citationId) && !citedIds.includes(citationId)) {
        citedIds.push(citationId);
      }
    }
  }

  return citedIds.map((citationId) => blocksById.get(citationId)!);
}

export function buildTranscriptMessages(
  messages: readonly ChatTranscriptMessage[],
  activeRunId: string | null,
  phase: ChatStreamPhase,
  stream: Pick<ChatStreamState, "assistantText" | "contextBlocks">,
  labels: ChatDisplayLabels,
): readonly ChatTranscriptMessage[] {
  if (activeRunId === null || !isStreamingPhase(phase)) return messages;

  const contextBlocks = stream.contextBlocks.map((block) => transcriptContextBlock(block, labels));
  const citations = citedBlocks(stream.assistantText, contextBlocks).map((block) =>
    citationFromContextBlock(block, labels),
  );

  return [
    ...messages,
    {
      id: `streaming:${activeRunId}`,
      author: "assistant",
      content: stream.assistantText,
      citations,
      contextBlocks,
      streaming: true,
    },
  ];
}
