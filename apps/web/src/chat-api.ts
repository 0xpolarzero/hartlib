import type { ChatMessage } from "@hartlib/shared";
import type { ChatTranscriptMessage } from "@hartlib/ui";

export const mapApiMessagesToTranscript = (
  messages: readonly ChatMessage[],
): readonly ChatTranscriptMessage[] => {
  const terminalRuns = new Map(
    messages.flatMap((message) =>
      message.author === "user" &&
      (message.run.status === "succeeded" ||
        message.run.status === "failed" ||
        message.run.status === "stopped")
        ? [[message.run.id, message.run] as const]
        : [],
    ),
  );
  const assistantRunIds = new Set(
    messages.flatMap((message) =>
      message.author === "assistant" && message.runId !== undefined ? [message.runId] : [],
    ),
  );
  return messages.map((message): ChatTranscriptMessage => {
    if (message.author === "user") {
      const terminalRun = terminalRuns.get(message.run.id);
      return {
        id: message.id,
        author: "user",
        content: message.content,
        createdAt: message.createdAt,
        runId: message.run.id,
        ...(terminalRun === undefined || assistantRunIds.has(message.run.id)
          ? {}
          : { runStatus: terminalRun.status }),
        failure:
          message.run.status === "failed"
            ? { code: message.run.errorCode, retryable: message.run.retryable }
            : null,
        stopped: message.run.status === "stopped",
        ...(message.run.status === "stopped" ? { stoppedAt: message.run.stoppedAt } : {}),
      };
    }
    const terminalRun = message.runId === undefined ? undefined : terminalRuns.get(message.runId);
    const stoppedAt = terminalRun?.status === "stopped" ? terminalRun.stoppedAt : undefined;
    return {
      id: message.id,
      author: "assistant",
      content: message.content,
      createdAt: message.createdAt,
      ...(message.runId === undefined ? {} : { runId: message.runId }),
      ...(terminalRun === undefined ? {} : { runStatus: terminalRun.status }),
      citations: message.citations,
      sourcesRead: message.sourcesRead,
      ...(stoppedAt === undefined ? {} : { stopped: true, stoppedAt }),
    };
  });
};
