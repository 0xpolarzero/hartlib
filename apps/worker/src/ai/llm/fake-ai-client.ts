import type { AiClient, AiCallResult, AnswerStreamEvent } from "./types";
import { zeroUsage } from "./types";

export interface FakeAiClientScenario {
  readonly preflight?: AiCallResult<any> | undefined;
  readonly answer?: readonly AnswerStreamEvent[] | undefined;
  readonly memories?: AiCallResult<any> | undefined;
}

export class FakeAiClient implements AiClient {
  constructor(private readonly scenario: FakeAiClientScenario = {}) {}

  async runPreflight(..._args: Parameters<AiClient["runPreflight"]>) {
    return (
      this.scenario.preflight ?? {
        kind: "ok",
        value: { manifest: [], usage: zeroUsage(), toolEvents: [] },
      }
    );
  }

  async *streamAnswer(
    ..._args: Parameters<AiClient["streamAnswer"]>
  ): AsyncIterable<AnswerStreamEvent> {
    const events =
      this.scenario.answer ??
      ([
        {
          type: "result",
          result: {
            kind: "ok",
            value: {
              message: {
                role: "assistant",
                content: [{ type: "text", text: "" }],
                api: "openai-completions",
                provider: "zai",
                model: "fake",
                usage: zeroUsage(),
                stopReason: "stop",
                timestamp: Date.now(),
              },
              text: "",
              usage: zeroUsage(),
              insufficiencyGap: null,
            },
          },
        },
      ] satisfies readonly AnswerStreamEvent[]);

    for (const event of events) {
      yield event;
    }
  }

  async extractMemories(..._args: Parameters<AiClient["extractMemories"]>) {
    return (
      this.scenario.memories ?? {
        kind: "ok",
        value: { proposals: [], discarded: [], usage: zeroUsage() },
      }
    );
  }
}
