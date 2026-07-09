import type { AssistantMessage } from "@earendil-works/pi-ai";

import { demoCitedAnswerSearchTerms } from "../../../../../tests/e2e/demo-cited-answer-fixture";
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

const assistantMessage = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "zai",
  model: "fake",
  usage: zeroUsage(),
  stopReason: "stop",
  timestamp: Date.now(),
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function* scriptedAnswer(text: string): AsyncIterable<AnswerStreamEvent> {
  const chunks = text.match(/.{1,48}(\s|$)/g) ?? [text];

  for (const chunk of chunks) {
    yield { type: "text_delta", delta: chunk };
  }

  yield {
    type: "result",
    result: {
      kind: "ok",
      value: {
        message: assistantMessage(text),
        text,
        usage: zeroUsage(),
        insufficiencyGap: null,
      },
    },
  };
}

const demoCitedAnswerScenario = (): FakeAiClientScenario => ({
  preflight: async (_inputs, toolContext, _callIndex, retrieval) => {
    if (retrieval === undefined) {
      throw new Error("AI_FAKE_SCENARIO=demo-cited-answer requires retrieval");
    }

    const spec = {
      terms: demoCitedAnswerSearchTerms,
      countries: ["FR"],
      languages: ["fr-FR"],
      orderBy: "relevance" as const,
      limit: 5,
    };
    const results = await retrieval.searchDocuments(spec, toolContext);
    const selected = results.slice(0, 2);
    const entries = selected.map((result) => ({ documentId: result.documentId }));

    return {
      kind: "ok",
      value: {
        manifest: entries,
        usage: zeroUsage(),
        toolEvents: [{ type: "search", spec, resultCount: results.length }],
      },
    };
  },
  answer: (input, callIndex) => {
    const latestUserMessage =
      [...input.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const turnLabel = callIndex === 0 ? "Premier point" : "Suite";
    return scriptedAnswer(
      `${turnLabel}: les sources signalent une progression solaire et des raccordements plus rapides. ` +
        `Elles notent aussi que le stockage et le reseau restent suivis par les acteurs publics. ` +
        `Question recue: ${latestUserMessage.slice(0, 80)}. [[cite:b1]] [[cite:b2]]`,
    );
  },
  memories: (input) => {
    const existing = input.existingMemories[0];
    return {
      kind: "ok",
      value: {
        proposals: [
          {
            kind: existing?.kind ?? "episode",
            content: `L'utilisateur a demande: "${input.userText}"`,
            evidenceQuote: input.userText,
            ...(existing === undefined ? {} : { targetMemoryId: existing.id }),
          },
        ],
        discarded: [],
        usage: zeroUsage(),
      },
    };
  },
});

const namedScenario = (name: string | undefined): FakeAiClientScenario | undefined => {
  switch (name) {
    case "demo-cited-answer":
      return demoCitedAnswerScenario();
    case undefined:
    case "":
      return undefined;
    default:
      throw new Error(`Unknown AI_FAKE_SCENARIO: ${name}`);
  }
};

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
    private readonly scenario: FakeAiClientScenario = defaultScenario ??
      namedScenario(process.env.AI_FAKE_SCENARIO) ??
      {},
    private readonly retrieval?: RetrievalExecutor,
    private readonly delayMs = 0,
    private readonly sleeper: (ms: number) => Promise<void> = sleep,
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
        if (event.type === "text_delta" && this.delayMs > 0) {
          await this.sleeper(this.delayMs);
        }
        yield event;
      }
      return;
    }

    for (const event of events as readonly AnswerStreamEvent[]) {
      if (event.type === "text_delta" && this.delayMs > 0) {
        await this.sleeper(this.delayMs);
      }
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
