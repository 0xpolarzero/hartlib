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
}

export const makeAiClient = (
  config: AiClientRuntimeConfig,
  retrieval: RetrievalExecutor,
): AiClient => {
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
    retrieval,
  });
};
