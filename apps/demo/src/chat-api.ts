import type {
  ActiveAiRunConflict,
  ChatMessage,
  GetChatResponse,
  ListMemoriesResponse,
  MemoryRecord,
  SendChatMessageAccepted,
} from "@brief/shared";
import type { ChatTranscriptMessage } from "@brief/ui";

export type ChatApiResponse = GetChatResponse;
export type SendMessageResponse = SendChatMessageAccepted;
export type SendMessageConflict = ActiveAiRunConflict;
export type MemoriesApiResponse = ListMemoriesResponse;
export type MemoryResponse = MemoryRecord;

export const mapApiMessagesToTranscript = (
  messages: readonly ChatMessage[],
): readonly ChatTranscriptMessage[] =>
  messages.map((message) =>
    message.author === "user"
      ? {
          id: message.id,
          author: "user",
          content: message.content,
          run: message.run,
        }
      : {
          id: message.id,
          author: "assistant",
          content: message.content,
          citations: message.citations,
          sourcesRead: message.sourcesRead,
        },
  );
