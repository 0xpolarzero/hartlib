import { citationRecordsFromText, type ChatTranscriptMessage } from "@brief/ui";

import type { ChatStreamPhase, ChatStreamState } from "./chat-stream";

const provisionalPhase = (phase: ChatStreamPhase): boolean => phase !== "done";

export function buildTranscriptMessages(
  messages: readonly ChatTranscriptMessage[],
  activeRunId: string | null,
  phase: ChatStreamPhase,
  stream: Pick<ChatStreamState, "assistantText" | "sourcesRead" | "activities" | "error">,
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
      activityFailure: stream.error,
      streaming: true,
    },
  ];
}
