import type { ChatMessage } from "@hartlib/shared";
import type { ChatTranscriptMessage } from "@hartlib/ui";

export const mapApiMessagesToTranscript = (
  messages: readonly ChatMessage[],
): readonly ChatTranscriptMessage[] => {
  const stoppedRuns = new Map(
    messages.flatMap((message) =>
      message.author === "user" && message.run.status === "stopped"
        ? [[message.run.id, message.run.stoppedAt] as const]
        : [],
    ),
  );
  return messages.map((message): ChatTranscriptMessage => {
    if (message.author === "user")
      return {
        id: message.id,
        author: "user",
        content: message.content,
        createdAt: message.createdAt,
        runId: message.run.id,
        failure:
          message.run.status === "failed"
            ? { code: message.run.errorCode, retryable: message.run.retryable }
            : null,
        stopped: message.run.status === "stopped",
        ...(message.run.status === "stopped" ? { stoppedAt: message.run.stoppedAt } : {}),
      };
    const stoppedAt = message.runId === undefined ? undefined : stoppedRuns.get(message.runId);
    return {
      id: message.id,
      author: "assistant",
      content: message.content,
      createdAt: message.createdAt,
      ...(message.runId === undefined ? {} : { runId: message.runId }),
      citations: message.citations,
      sourcesRead: message.sourcesRead,
      ...(stoppedAt === undefined ? {} : { stopped: true, stoppedAt }),
    };
  });
};
