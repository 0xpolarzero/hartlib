import { describe, expect, it } from "vitest";

import { makeAiClient, type AiClientRuntimeConfig } from "./client";
import { clearFakeAiClientScenario, FakeAiClient } from "./fake-ai-client";
import type { AnswerStreamEvent } from "./types";
import type { RetrievalExecutor } from "./pi-ai-client";
import type { DocumentPreview } from "../retrieval/query-spec";
import { demoCitedAnswerSearchTerms } from "../../../../../tests/e2e/demo-cited-answer-fixture";

const config = {
  zaiApiKey: "test-key",
  aiBaseUrl: "https://ai.example",
  aiMainModel: "glm-5.2",
  aiFastModel: "glm-5-flash",
  aiPreflightMaxTurns: 4,
  aiPreflightMaxSearches: 8,
  aiPreflightMaxPeeks: 4,
  aiPreflightTimeoutMs: 30_000,
  aiAnswerTimeoutMs: 120_000,
  aiMemoryMaxWritesPerTurn: 5,
  aiFake: true,
  aiFakeDelayMs: 0,
} satisfies AiClientRuntimeConfig;

const preview = (documentId: string): DocumentPreview => ({
  documentId,
  title: documentId,
  sourceDisplayName: "E2E Source",
  publishedAt: null,
  language: "fr-FR",
  documentType: "article",
  textCharCount: 1200,
  estimatedTokens: 300,
  snippet: demoCitedAnswerSearchTerms,
});

const preflightInputs = {
  systemPrompt: "preflight",
  sourceCatalog: [],
  today: "2026-07-09",
  market: "FR",
  locale: "fr-FR",
  standingWindow: [],
  memories: [],
  history: [],
  userMessage: "Que disent les sources?",
  remainingBlockBudget: 1000,
} as const;

const toolContext = {
  access: { kind: "allPublicSources" },
  maxSearchLimit: 20,
  recencyHalfLifeDays: 14,
} as const;

describe("FakeAiClient env scenarios", () => {
  it("builds the demo cited answer manifest from the first retrieval results", async () => {
    const previousScenario = process.env.AI_FAKE_SCENARIO;
    const searches: unknown[] = [];
    const retrieval: RetrievalExecutor = {
      searchDocuments: async (spec) => {
        searches.push(spec);
        return [preview("doc-alpha"), preview("e2e-fr-stockage-reseau"), preview("doc-beta")];
      },
      peekDocument: async () => null,
    };

    clearFakeAiClientScenario();
    process.env.AI_FAKE_SCENARIO = "demo-cited-answer";

    try {
      const client = makeAiClient(config, retrieval);
      const result = await client.runPreflight(preflightInputs, toolContext);

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") {
        throw new Error("expected ok preflight result");
      }

      expect(searches).toEqual([
        {
          terms: demoCitedAnswerSearchTerms,
          countries: ["FR"],
          languages: ["fr-FR"],
          orderBy: "relevance",
          limit: 5,
        },
      ]);
      expect(result.value.manifest).toEqual([
        { documentId: "doc-alpha" },
        { documentId: "e2e-fr-stockage-reseau" },
      ]);
      expect(result.value.toolEvents).toEqual([
        { type: "search", spec: searches[0], resultCount: 3 },
      ]);
    } finally {
      clearFakeAiClientScenario();
      if (previousScenario === undefined) {
        delete process.env.AI_FAKE_SCENARIO;
      } else {
        process.env.AI_FAKE_SCENARIO = previousScenario;
      }
    }
  });

  it("paces text deltas with an injected sleeper when configured", async () => {
    const sleeps: number[] = [];
    const client = new FakeAiClient(
      {
        answer: [
          { type: "text_delta", delta: "alpha" },
          { type: "text_delta", delta: "beta" },
        ],
      },
      undefined,
      123,
      async (ms) => {
        sleeps.push(ms);
      },
    );

    const events: AnswerStreamEvent[] = [];
    for await (const event of client.streamAnswer({
      systemPrompt: "answer",
      messages: [{ role: "user", content: "Hello" }],
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", delta: "alpha" },
      { type: "text_delta", delta: "beta" },
    ]);
    expect(sleeps).toEqual([123, 123]);
  });
});
