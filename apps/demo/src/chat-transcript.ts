import type { ChatTranscriptMessage } from "@hartlib/ui";
import type { ChatStreamPhase, ChatStreamState } from "./chat-stream";

const provisionalPhase = (phase: ChatStreamPhase, assistantText: string): boolean =>
  phase !== "done" || assistantText.length > 0;
export function buildTranscriptMessages(
  messages: readonly ChatTranscriptMessage[],
  activeRunId: string | null,
  phase: ChatStreamPhase,
  stream: Pick<ChatStreamState, "assistantText" | "sourcesRead" | "activities" | "error"> &
    Partial<
      Pick<ChatStreamState, "stoppedAt" | "activityHistory" | "context" | "memoryUpdated" | "seq">
    >,
): readonly ChatTranscriptMessage[] {
  if (activeRunId === null || !provisionalPhase(phase, stream.assistantText)) return messages;
  const failure =
    stream.error === null
      ? null
      : {
          code: stream.error.code,
          retryable: stream.error.retryable,
          ...(stream.error.errorMessage === undefined
            ? {}
            : { message: stream.error.errorMessage }),
        };
  const stoppedAt = stream.stoppedAt;
  const provisional: ChatTranscriptMessage = {
    id: `streaming:${activeRunId}`,
    author: "assistant" as const,
    content: stream.assistantText,
    // The server supplies canonical citation records on the persisted
    // assistant message. Streaming context contains source-read rows only;
    // never reconstruct citations in the client.
    citations: [],
    sourcesRead: stream.sourcesRead,
    ...(stream.activities.length === 0
      ? {}
      : {
          activities: stream.activities.map((activity) => ({
            stage: activity.stage,
            status: activity.status,
          })),
        }),
    diagnostics: {
      activityHistory: stream.activityHistory ?? stream.activities,
      context: stream.context ?? null,
      memoryUpdated: stream.memoryUpdated ?? null,
      ...(failure === null ? {} : { terminalFailure: failure }),
      ...(stream.seq === undefined ? {} : { sequence: stream.seq }),
    },
    ...(failure === null ? {} : { failure }),
    ...(stoppedAt === undefined || stoppedAt === null ? {} : { stopped: true, stoppedAt }),
    streaming: phase !== "done" && phase !== "stopped" && phase !== "error",
  };
  return [...messages, provisional];
}
