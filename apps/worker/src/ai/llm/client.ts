import { FakeAiClient, type FakeAiClientScenario } from "./fake-ai-client";
import { PiAiClient, type RetrievalExecutor } from "./pi-ai-client";
import type { AiClient } from "./types";

export interface AiClientRuntimeConfig {
  readonly zaiApiKey: string;
  readonly aiBaseUrl: string;
  readonly aiMainModel: string;
  readonly aiFastModel: string;
  readonly aiPreflightMaxTurns: number;
  readonly aiPreflightMaxSearches: number;
  readonly aiPreflightMaxPeeks: number;
  readonly aiPreflightTimeoutMs: number;
  readonly aiAnswerTimeoutMs: number;
  readonly aiMemoryMaxWritesPerTurn: number;
  readonly aiFake: boolean;
}

export const makeAiClient = (
  config: AiClientRuntimeConfig,
  retrieval?: RetrievalExecutor,
  fakeScenario?: FakeAiClientScenario,
): AiClient => {
  if (config.aiFake) {
    return new FakeAiClient(fakeScenario);
  }

  if (retrieval === undefined) {
    throw new Error("makeAiClient requires retrieval when AI_FAKE is false");
  }

  return new PiAiClient({
    apiKey: config.zaiApiKey,
    baseUrl: config.aiBaseUrl,
    mainModelId: config.aiMainModel,
    fastModelId: config.aiFastModel,
    preflightMaxTurns: config.aiPreflightMaxTurns,
    preflightMaxSearches: config.aiPreflightMaxSearches,
    preflightMaxPeeks: config.aiPreflightMaxPeeks,
    preflightTimeoutMs: config.aiPreflightTimeoutMs,
    answerTimeoutMs: config.aiAnswerTimeoutMs,
    memoryMaxWritesPerTurn: config.aiMemoryMaxWritesPerTurn,
    retrieval,
  });
};
