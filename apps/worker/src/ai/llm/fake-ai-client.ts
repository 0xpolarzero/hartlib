import type {
  AiClient,
  AiCallResult,
  AnswerStreamEvent,
  MemoryExtractionInput,
  MemoryExtractionOutput,
  PreflightInputs,
  PreflightOutput,
  PreflightToolContext,
  StreamAnswerInput,
} from "./types";
import type { RetrievalExecutor } from "./pi-ai-client";
import { zeroUsage } from "./types";

type MaybePromise<A> = A | Promise<A>;
type AnswerScriptResult =
  | readonly AnswerStreamEvent[]
  | AsyncIterable<AnswerStreamEvent>
  | Promise<readonly AnswerStreamEvent[] | AsyncIterable<AnswerStreamEvent>>;

export interface FakeAiClientScenario {
  readonly preflight?:
    | AiCallResult<PreflightOutput>
    | readonly AiCallResult<PreflightOutput>[]
    | ((
        inputs: PreflightInputs,
        toolContext: PreflightToolContext,
        callIndex: number,
        retrieval: RetrievalExecutor | undefined,
      ) => MaybePromise<AiCallResult<PreflightOutput>>)
    | undefined;
  readonly answer?:
    | readonly AnswerStreamEvent[]
    | readonly (readonly AnswerStreamEvent[])[]
    | ((input: StreamAnswerInput, callIndex: number) => AnswerScriptResult)
    | undefined;
  readonly memories?:
    | AiCallResult<MemoryExtractionOutput>
    | readonly AiCallResult<MemoryExtractionOutput>[]
    | ((
        input: MemoryExtractionInput,
        callIndex: number,
      ) => MaybePromise<AiCallResult<MemoryExtractionOutput>>)
    | undefined;
  readonly captures?:
    | {
        readonly preflightInputs?: PreflightInputs[] | undefined;
        readonly answerInputs?: StreamAnswerInput[] | undefined;
        readonly memoryInputs?: MemoryExtractionInput[] | undefined;
      }
    | undefined;
}

interface ScenarioState {
  preflightCalls: number;
  answerCalls: number;
  memoryCalls: number;
}

const scenarioStates = new WeakMap<FakeAiClientScenario, ScenarioState>();
let defaultScenario: FakeAiClientScenario | undefined;

const stateFor = (scenario: FakeAiClientScenario): ScenarioState => {
  const existing = scenarioStates.get(scenario);
  if (existing !== undefined) return existing;

  const state = { preflightCalls: 0, answerCalls: 0, memoryCalls: 0 };
  scenarioStates.set(scenario, state);
  return state;
};

export const setFakeAiClientScenario = (scenario: FakeAiClientScenario): void => {
  defaultScenario = scenario;
  scenarioStates.delete(scenario);
};

export const clearFakeAiClientScenario = (): void => {
  defaultScenario = undefined;
};

const defaultPreflight = (): AiCallResult<PreflightOutput> => ({
  kind: "ok",
  value: { manifest: [], usage: zeroUsage(), toolEvents: [] },
});

const defaultAnswer = (): readonly AnswerStreamEvent[] =>
  [
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
  ] satisfies readonly AnswerStreamEvent[];

const defaultMemory = (): AiCallResult<MemoryExtractionOutput> => ({
  kind: "ok",
  value: { proposals: [], discarded: [], usage: zeroUsage() },
});

const isAnswerEventList = (value: readonly unknown[]): value is readonly AnswerStreamEvent[] =>
  value.length === 0 ||
  (typeof value[0] === "object" &&
    value[0] !== null &&
    "type" in value[0] &&
    ((value[0] as { readonly type?: unknown }).type === "text_delta" ||
      (value[0] as { readonly type?: unknown }).type === "result"));

export class FakeAiClient implements AiClient {
  constructor(
    private readonly scenario: FakeAiClientScenario = defaultScenario ?? {},
    private readonly retrieval?: RetrievalExecutor,
  ) {}

  async runPreflight(inputs: PreflightInputs, toolContext: PreflightToolContext) {
    this.scenario.captures?.preflightInputs?.push(inputs);
    const script = this.scenario.preflight;
    if (script === undefined) return defaultPreflight();

    const state = stateFor(this.scenario);
    const callIndex = state.preflightCalls++;

    if (typeof script === "function") {
      return script(inputs, toolContext, callIndex, this.retrieval);
    }

    if (Array.isArray(script)) {
      return script[callIndex] ?? defaultPreflight();
    }

    return script;
  }

  async *streamAnswer(input: StreamAnswerInput): AsyncIterable<AnswerStreamEvent> {
    this.scenario.captures?.answerInputs?.push(input);
    const script = this.scenario.answer;
    const state = stateFor(this.scenario);
    const callIndex = state.answerCalls++;
    const events =
      script === undefined
        ? defaultAnswer()
        : typeof script === "function"
          ? await script(input, callIndex)
          : Array.isArray(script) && !isAnswerEventList(script)
            ? (script[callIndex] ?? defaultAnswer())
            : script;

    if (Symbol.asyncIterator in events) {
      for await (const event of events) {
        yield event;
      }
      return;
    }

    for (const event of events as readonly AnswerStreamEvent[]) {
      yield event;
    }
  }

  async extractMemories(input: MemoryExtractionInput) {
    this.scenario.captures?.memoryInputs?.push(input);
    const script = this.scenario.memories;
    if (script === undefined) return defaultMemory();

    const state = stateFor(this.scenario);
    const callIndex = state.memoryCalls++;

    if (typeof script === "function") {
      return script(input, callIndex);
    }

    if (Array.isArray(script)) {
      return script[callIndex] ?? defaultMemory();
    }

    return script;
  }
}
