import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";

import type { AiCallResult } from "./types";

const exceedsModelContextWindow = (message: AssistantMessage, contextWindow: number): boolean =>
  contextWindow > 0 &&
  (message.usage.input > contextWindow || message.usage.totalTokens > contextWindow);

export const classifyAssistantMessage = <A>(
  message: AssistantMessage,
  model: Model<any>,
  value: A,
): AiCallResult<A> => {
  const errorMessage = message.errorMessage ?? "";

  if (
    isContextOverflow(message, model.contextWindow) ||
    exceedsModelContextWindow(message, model.contextWindow)
  ) {
    return {
      kind: "overflow",
      message,
      usage: message.usage,
      errorMessage,
    };
  }

  if (message.stopReason === "error" || message.stopReason === "aborted") {
    if (isRetryableAssistantError(message)) {
      return {
        kind: "retryable",
        message,
        usage: message.usage,
        errorMessage,
      };
    }

    return {
      kind: "fatal",
      message,
      usage: message.usage,
      errorMessage,
    };
  }

  return { kind: "ok", value };
};
