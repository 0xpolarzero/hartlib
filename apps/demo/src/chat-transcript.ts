import { citationRecordsFromText, type ChatTranscriptMessage } from "@brief/ui";

import type { ChatStreamPhase, ChatStreamState } from "./chat-stream";

const provisionalPhase = (phase: ChatStreamPhase): boolean => phase !== "done";

export function buildTranscriptMessages(
  messages: readonly ChatTranscriptMessage[],
  activeRunId: string | null,
  phase: ChatStreamPhase,
  stream: Pick<ChatStreamState, "assistantText" | "sourcesRead" | "activities" | "error"> &
    Partial<Pick<ChatStreamState, "activityHistory" | "context" | "memoryUpdated" | "seq">>,
): readonly ChatTranscriptMessage[] {
  if (activeRunId === null || !provisionalPhase(phase)) return messages;

  return [
    ...messages,
    {
      id: `streaming:${activeRunId}`,
      author: "assistant",
      content: stream.assistantText,
      citations: citationRecordsFromText(stream.assistantText, stream.sourcesRead),
      sourcesRead: stream.sourcesRead,
      activities: stream.activities,
      diagnostics: {
        activityHistory: stream.activityHistory ?? stream.activities,
        context: stream.context ?? null,
        memoryUpdated: stream.memoryUpdated ?? null,
        ...(stream.seq === undefined ? {} : { sequence: stream.seq }),
      },
      activityFailure: stream.error,
      streaming: true,
    },
  ];
}
