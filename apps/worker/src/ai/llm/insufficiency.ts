import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { AiCallResult, AnswerOutput, AnswerStreamEvent } from "./types";

export const INSUFFICIENCY_PREFIX = "[[insufficient:";

export const textFromAssistantMessage = (message: AssistantMessage): string =>
  message.content
    .filter((content) => content.type === "text")
    .map((content) => (content.type === "text" ? content.text : ""))
    .join("");

export const parseInsufficiencyGap = (text: string): string | null => {
  const match = /^\[\[insufficient:\s*([^\]\n]*)\]\]$/.exec(text);

  return match === null ? null : (match[1] ?? "").trim();
};

export const withholdInsufficiencyPrefix = async function* (
  events: AsyncIterable<AnswerStreamEvent>,
): AsyncIterable<AnswerStreamEvent> {
  let pending = "";
  let sniffing = true;
  let releasePendingWithNextDelta = false;

  for await (const event of events) {
    if (event.type === "result") {
      if ((sniffing || releasePendingWithNextDelta) && pending.length > 0) {
        const result = event.result;

        if (
          result.kind !== "ok" ||
          parseInsufficiencyGap(result.value.text) === null ||
          result.value.insufficiencyGap === null
        ) {
          yield { type: "text_delta", delta: pending };
        }
      }

      yield event;
      return;
    }

    if (!sniffing) {
      if (releasePendingWithNextDelta) {
        yield { type: "text_delta", delta: pending + event.delta };
        pending = "";
        releasePendingWithNextDelta = false;
        continue;
      }

      yield event;
      continue;
    }

    pending += event.delta;

    if (INSUFFICIENCY_PREFIX.startsWith(pending)) {
      continue;
    }

    if (pending.startsWith(INSUFFICIENCY_PREFIX)) {
      continue;
    }

    sniffing = false;
    releasePendingWithNextDelta = true;
  }
};

export const answerOutputFromMessage = (message: AssistantMessage): AnswerOutput => {
  const text = textFromAssistantMessage(message);

  return {
    message,
    text,
    usage: message.usage,
    insufficiencyGap: parseInsufficiencyGap(text),
  };
};

export const answerResultFromMessage = (
  result: AiCallResult<AssistantMessage>,
): AiCallResult<AnswerOutput> => {
  if (result.kind !== "ok") {
    return result;
  }

  return {
    kind: "ok",
    value: answerOutputFromMessage(result.value),
  };
};
