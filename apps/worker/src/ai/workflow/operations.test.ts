import * as SmithersTaskRuntimeModule from "@smithers-orchestrator/driver/task-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeRunAcceptanceScope } from "@hartlib/shared";

import { CanonicalAgentClient } from "../runtime/agent-client";
import { resolveRegisteredModel } from "../runtime/model-registry";
import { serializeExactAnswerRequest } from "../runtime/provider-request";
import { ReadSourcePassagesArgumentsSchema, SearchSourcePassagesArgumentsSchema } from "../prompts";
import {
  buildPassageIndex,
  mapPassageIdsToRanges,
  selectedTextFromRanges,
} from "../context/passages";
import type { CompactionGroup, GroupResultEnvelope } from "../context/compaction";
import type { FinalSourceRecord, PlanTurnResult } from "../runtime/types";
import {
  type CanonicalAiConfig,
  CanonicalWorkflowOperations,
  answerDeltaEmissionKey,
  answerStartedEmissionKey,
  canonicalProviderValueSchemas,
  boundedWebProviderText,
  runQueryReviewReplacement,
  type ContextState,
  type LoadedTurn,
  type SelectorBundle,
} from "./operations";
import { aiChatSchemas } from "./ai-chat";
import {
  InternalQueryPlanProviderSchema,
  InternalQueryPlanSchema,
  QueryReviewProviderSchema,
} from "../retrieval/query-spec";

describe("Phase B query review", () => {
  const query = {
    purpose: "Find evidence",
    targets: [{ kind: "documents" as const, filters: { languages: ["en"] } }],
    all: [{ text: "storage", mode: "term" as const }],
    anyOf: [],
    not: [],
    order: "relevance" as const,
  };
  const plan = { action: "search" as const, queries: [query] };
  const coverage = [
    {
      queryOrdinal: 1,
      branch: "public_documents" as const,
      status: "applicable" as const,
      hitCount: 0,
      truncated: false,
      cap: 2,
    },
    {
      queryOrdinal: 1,
      branch: "publisher_documents" as const,
      status: "not_applicable" as const,
      reason: "scope_documents" as const,
      hitCount: 0,
      truncated: false,
      cap: 2,
    },
    {
      queryOrdinal: 1,
      branch: "chat_messages" as const,
      status: "not_applicable" as const,
      reason: "scope_documents" as const,
      hitCount: 0,
      truncated: false,
      cap: 2,
    },
  ] as const;
  const projection = {
    question: "Which storage evidence matters?",
    queries: [query],
    results: [],
    coverage,
    truncation: { branch: false, candidates: false, hydration: false },
  };
  const exactProjection = {
    question: "Which storage evidence matters?",
    queries: [query],
    results: [
      {
        resultId: "r1" as const,
        kind: "document" as const,
        label: "Source",
        date: null,
        tokenCount: 9,
        preview: "exact preview bytes",
        normalizedFusedScore: 1,
        matchedQueryOrdinals: [1],
        branchCoverage: [
          {
            queryOrdinal: 1,
            branch: "public_documents" as const,
            status: "applicable" as const,
            hitCount: 1,
            truncated: false,
            cap: 2,
          },
          {
            queryOrdinal: 1,
            branch: "publisher_documents" as const,
            status: "not_applicable" as const,
            reason: "scope_documents" as const,
            hitCount: 0,
            truncated: false,
            cap: 2,
          },
          {
            queryOrdinal: 1,
            branch: "chat_messages" as const,
            status: "not_applicable" as const,
            reason: "scope_documents" as const,
            hitCount: 0,
            truncated: false,
            cap: 2,
          },
        ],
        truncationFlags: { branch: false, candidates: false, hydration: false },
      },
    ],
    coverage,
    truncation: { branch: false, candidates: false, hydration: false },
  };

  it("accepts the complete initial result without a second execution", async () => {
    let executions = 0;
    const exposures: unknown[] = [];
    let providerArgument: unknown;
    const result = await runQueryReviewReplacement(
      { initialPlan: plan, initialResult: { source: "private" }, reviewInput: exactProjection },
      {
        review: (input) => {
          providerArgument = input;
          return { action: "accept", reason: "sufficient_coverage" };
        },
        execute: () => {
          executions += 1;
          return { source: "replacement" };
        },
        projectReview: () => ({ providerInput: exactProjection, privateProof: [] }),
        onPreviewExposure: (value) => {
          exposures.push(value);
        },
      },
    );
    expect(result.action).toBe("accept");
    expect(result.result).toEqual({ source: "private" });
    expect(executions).toBe(0);
    expect(exposures).toEqual([{ providerInput: exactProjection, privateProof: [] }]);
    expect(providerArgument).toEqual(exactProjection);
    expect(JSON.stringify(providerArgument)).not.toMatch(/identity|hash|sql|raw|error/u);
  });

  it("executes one complete replacement and never falls back to initial hits", async () => {
    let executedPlan: unknown;
    const exposures: unknown[] = [];
    let providerArgument: unknown;
    const result = await runQueryReviewReplacement(
      { initialPlan: plan, initialResult: { source: "initial" }, reviewInput: projection },
      {
        review: (input) => {
          providerArgument = input;
          return { action: "replace", reason: "missed_concept", queries: [query] };
        },
        execute: (replacement) => {
          executedPlan = replacement;
          return { source: "replacement" };
        },
        projectReview: () => ({ providerInput: projection, privateProof: [] }),
        onPreviewExposure: (value) => {
          exposures.push(value);
        },
      },
    );
    expect(result.action).toBe("replace");
    expect(result.result).toEqual({ source: "replacement" });
    expect(executedPlan).toEqual(plan);
    expect(exposures).toEqual([
      { providerInput: projection, privateProof: [] },
      { providerInput: projection, privateProof: [] },
    ]);
    expect(providerArgument).toEqual(projection);
    expect(projection.coverage).toHaveLength(3);
    expect(projection.truncation).toEqual({ branch: false, candidates: false, hydration: false });
  });

  it("returns typed no-evidence without executing and records the seen preview", async () => {
    let executions = 0;
    const exposures: unknown[] = [];
    let providerArgument: unknown;
    const result = await runQueryReviewReplacement(
      { initialPlan: plan, initialResult: { source: "private" }, reviewInput: projection },
      {
        review: (input) => {
          providerArgument = input;
          return { action: "no_evidence", reason: "no_supporting_evidence" };
        },
        execute: () => {
          executions += 1;
          return {};
        },
        projectReview: () => ({ providerInput: projection, privateProof: [] }),
        onPreviewExposure: (value) => {
          exposures.push(value);
        },
      },
    );
    expect(result).toMatchObject({ action: "no_evidence", result: null });
    expect(executions).toBe(0);
    expect(exposures).toEqual([{ providerInput: projection, privateProof: [] }]);
    expect(providerArgument).toEqual(projection);
    expect((providerArgument as typeof projection).results).toHaveLength(0);
    expect((providerArgument as typeof projection).coverage).toHaveLength(3);
    expect((providerArgument as typeof projection).truncation).toEqual({
      branch: false,
      candidates: false,
      hydration: false,
    });
  });

  it("fails closed on replacement failure after recording the initial preview", async () => {
    const exposures: unknown[] = [];
    await expect(
      runQueryReviewReplacement(
        { initialPlan: plan, initialResult: { source: "initial" }, reviewInput: projection },
        {
          review: () => ({ action: "replace", reason: "missed_concept", queries: [query] }),
          execute: () => {
            throw new Error("replacement failed");
          },
          projectReview: () => ({ providerInput: projection, privateProof: [] }),
          onPreviewExposure: (value) => {
            exposures.push(value);
          },
        },
      ),
    ).rejects.toThrow("replacement failed");
    expect(exposures).toEqual([{ providerInput: projection, privateProof: [] }]);
  });

  it("rejects private fields in the provider review projection", async () => {
    await expect(
      runQueryReviewReplacement(
        {
          initialPlan: plan,
          initialResult: {},
          reviewInput: { queries: [query], results: [{ identity: "private" }] } as never,
        },
        {
          review: () => ({ action: "accept", reason: "sufficient_coverage" }),
          execute: () => ({}),
          projectReview: () => ({ providerInput: projection, privateProof: [] }),
          onPreviewExposure: () => undefined,
        },
      ),
    ).rejects.toThrow();
    await expect(
      runQueryReviewReplacement(
        {
          initialPlan: plan,
          initialResult: {},
          reviewInput: {
            ...projection,
            coverage: [{ ...projection.coverage[0], privateId: "source-id" }],
          } as never,
        },
        {
          review: () => ({ action: "accept", reason: "sufficient_coverage" }),
          execute: () => ({}),
          projectReview: () => ({ providerInput: projection, privateProof: [] }),
          onPreviewExposure: () => undefined,
        },
      ),
    ).rejects.toThrow();
  });

  it("records the private proof before provider throws or returns an invalid review", async () => {
    const privateProof = [
      {
        identity: {
          kind: "chat_message" as const,
          messageId: "message-1",
          sanitizedContentHash: "a".repeat(64),
        },
        snapshotId: "message-1",
        contentHash: "a".repeat(64),
        previewRanges: [{ charStart: 0, charEnd: 7 }],
        previewBytes: new TextEncoder().encode("preview"),
        fastTokenCount: 3,
        mainTokenCount: 4,
      },
    ];
    const exposure = { providerInput: exactProjection, privateProof };
    const recorded: unknown[] = [];
    await expect(
      runQueryReviewReplacement(
        {
          initialPlan: plan,
          initialResult: { source: "initial" },
          reviewInput: exactProjection,
          initialExposure: exposure,
        },
        {
          review: () => {
            expect(recorded).toEqual([exposure]);
            throw new Error("provider unavailable");
          },
          execute: () => ({}),
          projectReview: () => ({ providerInput: exactProjection, privateProof: [] }),
          onPreviewExposure: (value) => {
            recorded.push(value);
          },
        },
      ),
    ).rejects.toThrow("provider unavailable");
    expect(recorded).toEqual([exposure]);

    await expect(
      runQueryReviewReplacement(
        {
          initialPlan: plan,
          initialResult: { source: "initial" },
          reviewInput: exactProjection,
          initialExposure: exposure,
        },
        {
          review: () => ({ action: "invalid" }),
          execute: () => ({}),
          projectReview: () => ({ providerInput: exactProjection, privateProof: [] }),
          onPreviewExposure: (value) => {
            recorded.push(value);
          },
        },
      ),
    ).rejects.toThrow();
    expect(recorded.at(-1)).toEqual(exposure);
  });
});

describe("bounded web provider views", () => {
  it("keeps exact beginning and ending excerpts within the provider token bound", () => {
    const page = "BEGINNING evidence " + "middle ".repeat(100) + "ENDING evidence";
    const bounded = boundedWebProviderText(page, 50, (value) => value.length);

    expect(bounded.length).toBeLessThanOrEqual(50);
    expect(bounded.startsWith("BEGINNING evidence")).toBe(true);
    expect(bounded.endsWith("ENDING evidence")).toBe(true);
    expect(page.includes("BEGINNING evidence")).toBe(true);
    expect(page.includes("ENDING evidence")).toBe(true);
  });
});

describe("structured retrieval query plans", () => {
  it("converts the exact provider plan and review schemas", () => {
    expect(z.toJSONSchema(InternalQueryPlanProviderSchema)).not.toHaveProperty("oneOf");
    expect(z.toJSONSchema(QueryReviewProviderSchema)).not.toHaveProperty("oneOf");
  });

  it("keeps temporal wording in the provider-owned query text", () => {
    const plan = InternalQueryPlanSchema.parse({
      action: "search",
      queries: [
        {
          purpose: "find older storage",
          targets: [{ kind: "chat_messages" as const, filters: {} }],
          all: [{ text: "old storage pilot", mode: "term" }],
          anyOf: [],
          not: [],
          order: "relevance",
        },
      ],
    });
    expect(plan.action).toBe("search");
    expect(plan.action === "search" ? plan.queries[0]?.all[0]?.text : undefined).toBe(
      "old storage pilot",
    );
  });
});

describe("canonical answer event emission keys", () => {
  it("uses only consumer task, answer attempt, and delta index", () => {
    expect(answerStartedEmissionKey("single-answer", 1)).toBe("answer_started:single-answer:1");
    expect(answerDeltaEmissionKey("single-answer", 1, 0)).toBe("text_delta:single-answer:1:0");
    expect(answerDeltaEmissionKey("single-answer", 2, 0)).not.toBe(
      answerDeltaEmissionKey("single-answer", 1, 0),
    );
  });

  it("uses flat provider schemas but retains exact semantic unions", () => {
    const planTurnProviderJsonSchema = z.toJSONSchema(
      canonicalProviderValueSchemas.planTurnProvider,
    ) as Record<string, unknown>;
    expect(planTurnProviderJsonSchema).toMatchObject({
      type: "object",
      required: ["mode"],
      additionalProperties: false,
    });
    expect(planTurnProviderJsonSchema).not.toHaveProperty("oneOf");
    const validPlanTurnOutputs = [
      { mode: "clarify", question: "Which result?" },
      { mode: "single", question: "resolved", relevantTurnIds: ["turn-1"] },
      {
        mode: "fanout",
        question: "resolved",
        topics: [
          { question: "First", relevantTurnIds: ["turn-1"] },
          { question: "Second", relevantTurnIds: [] },
        ],
      },
    ];
    for (const output of validPlanTurnOutputs) {
      expect(
        canonicalProviderValueSchemas.planTurn.parse(
          canonicalProviderValueSchemas.planTurnProvider.parse(output),
        ),
      ).toEqual(output);
    }
    expect(() => canonicalProviderValueSchemas.planTurnProvider.parse({})).toThrow();
    expect(() =>
      canonicalProviderValueSchemas.planTurn.parse(
        canonicalProviderValueSchemas.planTurnProvider.parse({
          mode: "clarify",
          question: "Which result?",
          extra: true,
        }),
      ),
    ).toThrow();

    const providerJsonSchema = z.toJSONSchema(
      canonicalProviderValueSchemas.planTurnProvider,
    ) as Record<string, unknown>;
    expect(providerJsonSchema).toMatchObject({
      type: "object",
      required: ["mode"],
      additionalProperties: false,
    });
    expect(providerJsonSchema).not.toHaveProperty("oneOf");
    expect(
      canonicalProviderValueSchemas.planTurnProvider.parse({
        mode: "single",
      }),
    ).toEqual({ mode: "single" });
    expect(() =>
      canonicalProviderValueSchemas.planTurn.parse({
        mode: "single",
        question: "The request is atomic.",
        relevantTurnIds: [],
        topics: [
          { question: "First", relevantTurnIds: [] },
          { question: "Second", relevantTurnIds: [] },
        ],
      }),
    ).toThrow();
  });
});

describe("structured retrieval search contract", () => {
  const validPlan = {
    action: "search" as const,
    queries: [
      {
        purpose: "answer the question",
        targets: [{ kind: "documents" as const, filters: {} }],
        all: [{ text: "solar", mode: "term" as const }],
        anyOf: [],
        not: [],
        order: "relevance" as const,
      },
    ],
  };

  it("accepts a complete bounded query plan", () => {
    expect(InternalQueryPlanSchema.parse(validPlan)).toEqual(validPlan);
  });
  it("rejects an unknown query field", () => {
    expect(() => InternalQueryPlanSchema.parse({ ...validPlan, extra: true })).toThrow();
  });
  it("rejects an unknown atom field", () => {
    expect(() =>
      InternalQueryPlanSchema.parse({
        ...validPlan,
        queries: [{ ...validPlan.queries[0], all: [{ text: "solar", mode: "term", extra: true }] }],
      }),
    ).toThrow();
  });
  it("supports an explicit skip result", () => {
    expect(InternalQueryPlanSchema.parse({ action: "skip", reason: "no_evidence" })).toEqual({
      action: "skip",
      reason: "no_evidence",
    });
  });
  it("requires a non-empty query purpose", () => {
    expect(() =>
      InternalQueryPlanSchema.parse({
        ...validPlan,
        queries: [{ ...validPlan.queries[0], purpose: "" }],
      }),
    ).toThrow();
  });
  it("keeps query order closed", () => {
    expect(() =>
      InternalQueryPlanSchema.parse({
        ...validPlan,
        queries: [{ ...validPlan.queries[0], order: "random" }],
      }),
    ).toThrow();
  });
  it("keeps Boolean atoms closed", () => {
    expect(() =>
      InternalQueryPlanSchema.parse({
        ...validPlan,
        queries: [{ ...validPlan.queries[0], anyOf: [[{ text: "x", mode: "invalid" }]] }],
      }),
    ).toThrow();
  });
  it("preserves normalized query text", () => {
    const parsed = InternalQueryPlanSchema.parse({
      ...validPlan,
      queries: [{ ...validPlan.queries[0], all: [{ text: "  solar  ", mode: "term" }] }],
    });
    expect(parsed.action === "search" ? parsed.queries[0]?.all[0]?.text : undefined).toBe("solar");
  });
  it("rejects an empty query list", () => {
    expect(() => InternalQueryPlanSchema.parse({ action: "search", queries: [] })).toThrow();
  });
});

const config = (mainInputTokens: number): CanonicalAiConfig => ({
  aiMainModel: "glm-5-turbo" as const,
  aiFastModel: "glm-5-turbo" as const,
  aiMainInputMaxTokens: mainInputTokens,
  aiMainOutputMaxTokens: 4096,
  aiFastInputMaxTokens: 100_000,
  aiFastOutputMaxTokens: 4096,
  aiConversationRecentTurns: 12,
  aiFanoutMaxTopics: 3,
  aiWebMaxSearches: 2,
  aiWebMaxFetches: 2,
  aiWebMaxDomainFilters: 8,
  aiMemoryToolResultMaxItems: 20,
  webResearchProvider: "" as const,
  providerServiceId: "zai_coding_plan_official",
});

const citationNamespace = "cn_AAAAAAAAAAAAAAAAAAAAAA";

const load = (_historyText: string): LoadedTurn => {
  const aiRunId = crypto.randomUUID();
  const chatId = crypto.randomUUID();
  return {
    aiRunId,
    chatId,
    initiatingUserId: "fanout-allocation-user",
    userMessageId: crypto.randomUUID(),
    userMessage: "Compare both topics.",
    locale: "en-US",
    market: "US",
    currentTimestamp: "2026-07-10T00:00:00.000Z",
    citationNamespace,
    acceptanceScope: makeRunAcceptanceScope({
      userId: "fanout-allocation-user",
      chatId,
      companyId: "00000000-0000-4000-8000-000000000002",
    }),
  };
};

const plan = (
  relevantTurnIds: readonly string[],
): Extract<PlanTurnResult, { readonly mode: "fanout" }> => ({
  mode: "fanout",
  question: "Compare both topics.",
  topics: [
    { topicId: "t1", question: "Topic one", relevantTurnIds },
    { topicId: "t2", question: "Topic two", relevantTurnIds },
  ],
});

const structuredForIdentities = (
  identities: readonly Readonly<Record<string, unknown>>[],
): NonNullable<SelectorBundle["structuredInternal"]> =>
  ({
    queryPlan: { action: "skip", reason: "no_evidence" },
    branches: [],
    fused: {
      results: identities.map((identity, index) => ({
        resultId: `r${index + 1}`,
        identity,
        identityKey: JSON.stringify(identity),
        value: {},
        score: 1,
        rrfK: 60,
        bestRank: index + 1,
        date: null,
        provenance: [],
        matchedQueryOrdinals: [],
      })),
      coverage: [],
      candidateCountBeforeCap: identities.length,
      candidateCap: identities.length || 1,
      hydratedBytes: 0,
      hydrationByteCap: null,
      truncation: { branch: false, candidates: false, hydration: false },
    },
    review: [],
    previewExposures: [],
  }) as unknown as NonNullable<SelectorBundle["structuredInternal"]>;

const stubPriorTurns = (operations: CanonicalWorkflowOperations, historyText = ""): void => {
  (operations as any).currentPriorTurns = async () =>
    historyText === ""
      ? []
      : [
          {
            turnId: "turn-1",
            userMessageId: "message-user-1",
            userContent: historyText,
            assistantMessageId: "message-assistant-1",
            assistantContent: historyText,
          },
        ];
};

describe("fanout source-key merge", () => {
  it("does only stable cross-topic identity deduplication and namespace-key assignment", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(operations);
    const turn = load("");
    const topics = plan([]).topics;
    const _sharedDocument = {
      kind: "document" as const,
      documentId: "shared-document",
      snapshotId: "shared-version",
      source: { kind: "public" as const, sourceId: "public:shared-source" },
      ranges: [{ charStart: 0, charEnd: 10 }],
      purpose: "shared evidence",
    };
    const selectors = {
      t1: {
        structuredInternal: structuredForIdentities([
          {
            kind: "public_document",
            sourceId: "shared-source",
            documentId: "shared-document",
            snapshotId: "shared-version",
            contentHash: "a".repeat(64),
          },
        ]),
        memories: [],
        memorySelection: "enabled" as const,
        web: [],
        webSelection: "enabled" as const,
      },
      t2: {
        structuredInternal: structuredForIdentities([
          {
            kind: "public_document",
            sourceId: "shared-source",
            documentId: "shared-document",
            snapshotId: "shared-version",
            contentHash: "a".repeat(64),
          },
          {
            kind: "chat_message",
            messageId: "older-message",
            sanitizedContentHash: "b".repeat(64),
          },
        ]),
        memories: [],
        memorySelection: "enabled" as const,
        web: [],
        webSelection: "enabled" as const,
      },
      t3: {
        structuredInternal: null,
        memories: [],
        memorySelection: "enabled" as const,
        web: [],
        webSelection: "enabled" as const,
      },
    };

    const first = await operations.mergeFanoutSources(turn, topics, selectors);
    const reversed = await operations.mergeFanoutSources(turn, [...topics].reverse(), selectors);

    expect(first).toEqual(reversed);
    expect(first.sources.map(({ identityKey }) => identityKey)).toHaveLength(2);
    expect(new Set(first.sources.map(({ sourceKey }) => sourceKey)).size).toBe(
      first.sources.length,
    );
  });

  it("keeps identical raw IDs distinct across public and publisher namespaces in both orders", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(operations);
    const _publicReference = {
      kind: "document" as const,
      documentId: "same-document",
      snapshotId: "same-version",
      source: { kind: "public" as const, sourceId: "public:same-source" },
      purpose: "public",
    };
    const _publisherReference = {
      kind: "document" as const,
      documentId: "same-document",
      snapshotId: "same-version",
      source: {
        kind: "publisher" as const,
        sourceId: "publisher:same-source",
        issueId: "same-issue",
        documentId: "same-document",
      },
      purpose: "publisher",
    };
    const topics = plan([]).topics;
    const first = await operations.mergeFanoutSources(load(""), topics, {
      t1: {
        structuredInternal: structuredForIdentities([
          {
            kind: "public_document",
            sourceId: "same-source",
            documentId: "same-document",
            snapshotId: "same-version",
            contentHash: "a".repeat(64),
          },
          {
            kind: "publisher_document",
            subscriptionId: "same-source",
            issueId: "same-issue",
            documentId: "same-document",
            snapshotId: "same-version",
            publisherExtractionId: "same-extraction",
            contentHash: "b".repeat(64),
          },
        ]),
        memories: [],
        memorySelection: "enabled" as const,
        web: [],
        webSelection: "enabled" as const,
      },
      t2: {
        structuredInternal: null,
        memories: [],
        memorySelection: "enabled" as const,
        web: [],
        webSelection: "enabled" as const,
      },
      t3: {
        structuredInternal: null,
        memories: [],
        memorySelection: "enabled" as const,
        web: [],
        webSelection: "enabled" as const,
      },
    });
    const second = await operations.mergeFanoutSources(load(""), topics, {
      t1: {
        structuredInternal: structuredForIdentities([
          {
            kind: "publisher_document",
            subscriptionId: "same-source",
            issueId: "same-issue",
            documentId: "same-document",
            snapshotId: "same-version",
            publisherExtractionId: "same-extraction",
            contentHash: "b".repeat(64),
          },
          {
            kind: "public_document",
            sourceId: "same-source",
            documentId: "same-document",
            snapshotId: "same-version",
            contentHash: "a".repeat(64),
          },
        ]),
        memories: [],
        memorySelection: "enabled" as const,
        web: [],
        webSelection: "enabled" as const,
      },
      t2: {
        structuredInternal: null,
        memories: [],
        memorySelection: "enabled" as const,
        web: [],
        webSelection: "enabled" as const,
      },
      t3: {
        structuredInternal: null,
        memories: [],
        memorySelection: "enabled" as const,
        web: [],
        webSelection: "enabled" as const,
      },
    });
    expect(first.sources).toHaveLength(2);
    expect(second.sources).toHaveLength(2);
    expect(new Set(first.sources.map(({ identityKey }) => identityKey)).size).toBe(2);
    expect(new Set(second.sources.map(({ identityKey }) => identityKey)).size).toBe(2);
    expect(first.sources.map(({ identityKey }) => identityKey).sort()).toEqual(
      second.sources.map(({ identityKey }) => identityKey).sort(),
    );
  });
});

describe("complete candidate ledger", () => {
  it("places one selected turn before evidence and keeps sanitized role text", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(operations, "prior question");
    const assembly = await operations.assembleContext(
      load(""),
      "question",
      {
        structuredInternal: null,
        memories: [],
        memorySelection: "disabled",
        web: [],
        webSelection: "disabled",
      },
      "single-assemble",
      "single-answer",
      undefined,
      ["turn-1"],
    );
    expect(assembly.candidateLedger.candidates).toHaveLength(1);
    expect(assembly.candidateLedger.candidates[0]).toMatchObject({
      kind: "conversation_entry",
      text: expect.stringContaining("prior question"),
      renderedTokenCount: expect.any(Number),
    });
    expect(Object.isFrozen(assembly.candidateLedger)).toBe(true);
  });

  it("keeps hydrated document text in the fit-first measured and sent request", async () => {
    const fullText = "review preview is not the answer; full authorized document text";
    const reviewPreview = "review preview";
    const identity = {
      kind: "public_document" as const,
      sourceId: "source-1",
      documentId: "document-1",
      snapshotId: "snapshot-1",
      contentHash: "a".repeat(64),
    };
    const structured = structuredForIdentities([identity]);
    (structured.fused.results[0] as any).value = {
      kind: "document",
      label: "Document",
      date: null,
      sourceName: "Source",
      text: fullText,
      preview: reviewPreview,
      previewRanges: [{ charStart: 0, charEnd: reviewPreview.length }],
      snapshotId: identity.snapshotId,
      contentHash: identity.contentHash,
      mainTokenCount: 1,
    };
    const transported: unknown[] = [];
    const agents = {
      stream: async (request: unknown) => {
        transported.push(request);
        return {
          text: "grounded answer",
          toolCalls: [],
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedTokens: 0,
            reasoningTokens: 0,
            totalTokens: 2,
            stopReason: "stop",
          },
          stopReason: "stop",
        };
      },
    } as unknown as CanonicalAgentClient;
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      agents,
    );
    stubPriorTurns(operations);
    const turn = load("");
    (operations as any).db = async () => [
      {
        sourceName: "Source",
        documentTitle: "Document",
        citationUrl: "https://example.test/document-1",
        publishedAt: null,
      },
    ];
    const assembly = await operations.assembleContext(
      turn,
      "What is authorized?",
      {
        structuredInternal: structured,
        memories: [],
        memorySelection: "enabled",
        web: [],
        webSelection: "enabled",
      },
      "single-assemble",
      "single-answer",
    );
    const withTaskRuntime = (
      SmithersTaskRuntimeModule as unknown as {
        readonly withTaskRuntime: <Value>(runtime: unknown, execute: () => Value) => Value;
      }
    ).withTaskRuntime;
    const runtime = {
      runId: `ai-chat:${turn.aiRunId}`,
      stepId: "single-measure",
      attempt: 0,
      iteration: 0,
      signal: new AbortController().signal,
      db: {},
      heartbeat: () => undefined,
      lastHeartbeat: null,
    };
    const measured = await withTaskRuntime(runtime, () =>
      operations.measureAssembly(turn, assembly, "single-measure"),
    );
    const ledgerEntry = measured.candidateLedger.candidates[0];
    expect(ledgerEntry).toMatchObject({
      kind: "document",
      text: fullText,
      baseRanges: [{ charStart: 0, charEnd: fullText.length }],
    });
    expect(measured.status).toBe("ready");
    const measuredUser = measured.request.messages.find((message) => message.role === "user");
    if (measuredUser === undefined) throw new Error("measured request has no user message");
    expect(JSON.parse(measuredUser.content).evidence).toContain(fullText);

    await withTaskRuntime({ ...runtime, stepId: "single-answer", attempt: 1 }, () =>
      operations.answerDirect(turn, measured, "single-answer"),
    );
    expect(transported).toHaveLength(1);
    const withoutProofs = (request: any) => {
      const { sourceExposureProofs: _proofs, ...rest } = request;
      return rest;
    };
    expect(withoutProofs(transported[0])).toEqual(withoutProofs(measured.request));
    expect(JSON.parse((transported[0] as any).messages[1].content).evidence).toContain(fullText);
  });

  it("accepts bounded source search arguments for one candidate", () => {
    expect(
      SearchSourcePassagesArgumentsSchema.parse({ candidateId: "c1", query: "alpha", cursor: "0" }),
    ).toEqual({
      candidateId: "c1",
      query: "alpha",
      cursor: "0",
    });
  });

  it("rejects source search arguments with hidden fields", () => {
    expect(() =>
      SearchSourcePassagesArgumentsSchema.parse({
        candidateId: "c1",
        query: "alpha",
        ignored: true,
      }),
    ).toThrow();
  });

  it("requires a source read selection or adjacent passage", () => {
    expect(() => ReadSourcePassagesArgumentsSchema.parse({ candidateId: "c1" })).toThrow();
    expect(
      ReadSourcePassagesArgumentsSchema.parse({ candidateId: "c1", passageIds: ["p1"] }),
    ).toMatchObject({
      candidateId: "c1",
      passageIds: ["p1"],
    });
  });

  it("rejects source read selections outside the run-local passage ID shape", () => {
    expect(() =>
      ReadSourcePassagesArgumentsSchema.parse({ candidateId: "c1", passageIds: ["passage-1"] }),
    ).toThrow();
  });

  it("builds bounded run-local passages from immutable text", () => {
    const index = buildPassageIndex("alpha. beta.", {
      maxTokens: 8,
      maxUtf8Bytes: 128,
      countTokens: (text) => text.length,
    });
    expect(index.passages.map((passage) => passage.passageId)).toEqual(["p1", "p2"]);
    expect(index.passages.map((passage) => passage.text)).toEqual(["alpha.", "beta."]);
  });

  it("restricts source passages to authorized ranges", () => {
    const index = buildPassageIndex("zero. one. two.", {
      maxTokens: 8,
      maxUtf8Bytes: 128,
      countTokens: (text) => text.length,
      authorizedRanges: [{ charStart: 6, charEnd: 10 }],
    });
    expect(index.passages.map((passage) => passage.text)).toEqual(["one."]);
  });

  it("maps only selected passage IDs to exact source ranges", () => {
    const text = "alpha. beta.";
    const index = buildPassageIndex(text, {
      maxTokens: 8,
      maxUtf8Bytes: 128,
      countTokens: (value) => value.length,
    });
    expect(mapPassageIdsToRanges(index, ["p2"])).toEqual([{ charStart: 7, charEnd: 12 }]);
  });

  it("reconstructs selected source text in passage order", () => {
    const text = "alpha. beta.";
    const index = buildPassageIndex(text, {
      maxTokens: 8,
      maxUtf8Bytes: 128,
      countTokens: (value) => value.length,
    });
    expect(selectedTextFromRanges(text, mapPassageIdsToRanges(index, ["p2", "p1"]))).toBe(
      "alpha.\n…\nbeta.",
    );
  });
});

describe("fanout synthesis allocation", () => {
  const topicContext = (topicId: "t1" | "t2", packetOutputTokens: number): ContextState => ({
    status: "ready",
    question: `Question ${topicId}`,
    topicId,
    candidates: [],
    candidateLedger: { candidates: [] },
    sourceMap: [],
    ledgerCandidates: [],
    ledgerSourceMap: [],
    selectedConversation: [],
    consumers: [],
    gaps: [],
    compactionFeedback: [],
    request: {
      requestClass: "main",
      model: "glm-5-turbo",
      messages: [{ role: "user", content: `Question ${topicId}` }],
      requestedOutputTokens: packetOutputTokens,
      reasoning: "medium",
    },
    inputTokens: 10,
    usableInputTokens: 100_000,
    compactionRan: false,
  });

  it("reserves the exact selected conversation and packet framing before topic calls", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(operations, "Relevant historical context. ".repeat(500));
    const turn = load("Relevant historical context. ".repeat(500));
    const withoutHistory = await operations.allocateFanout(turn, plan([]));
    const withHistory = await operations.allocateFanout(turn, plan(["turn-1"]));
    expect(withHistory.fixedSynthesisInput).toBeGreaterThan(withoutHistory.fixedSynthesisInput);
    expect(withHistory.packetOutputTokens).toBeLessThanOrEqual(withoutHistory.packetOutputTokens);
    expect(withHistory.packetOutputTokens).toBeGreaterThan(0);
  });

  it("uses the exact minimum valid topic-packet serialization instead of an arbitrary threshold", async () => {
    const turn = load("");
    const roomyOperations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(roomyOperations);
    const roomy = await roomyOperations.allocateFanout(turn, plan([]));
    const minimum = resolveRegisteredModel("glm-5-turbo").countTextTokens(
      JSON.stringify({ topicId: "t1", status: "partial", claims: [], gaps: ["gap"] }),
    );
    const exact = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(roomy.fixedSynthesisInput + minimum * 2),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(exact);
    expect((await exact.allocateFanout(turn, plan([]))).packetOutputTokens).toBe(minimum);

    const oneTokenShort = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(roomy.fixedSynthesisInput + minimum * 2 - 1),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(oneTokenShort);
    await expect(oneTokenShort.allocateFanout(turn, plan([]))).rejects.toThrow(
      "synthesis_budget_mismatch",
    );
  });

  it("fails before fanout when mandatory selected history leaves no packet allowance", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(2_000),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(operations, "mandatory history ".repeat(20_000));
    try {
      await operations.allocateFanout(load("mandatory history ".repeat(20_000)), plan(["turn-1"]));
      throw new Error("expected synthesis allocation to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "synthesis_budget_mismatch", retryable: false });
    }
  });

  it("reasserts the exact preallocation against the real synthesis request", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(operations);
    const turn = load("");
    const allocation = await operations.allocateFanout(turn, plan([]));
    const contexts = [
      topicContext("t1", allocation.packetOutputTokens),
      topicContext("t2", allocation.packetOutputTokens),
    ];
    const packets = [
      { topicId: "t1" as const, status: "partial" as const, claims: [], gaps: ["none"] },
      { topicId: "t2" as const, status: "partial" as const, claims: [], gaps: ["none"] },
    ];

    await expect(
      operations.synthesisContext(turn, packets, [], contexts, allocation),
    ).resolves.toMatchObject({
      status: "ready",
    });
    await expect(
      operations.synthesisContext(turn, packets, [], contexts, {
        ...allocation,
        fixedSynthesisInput: allocation.fixedSynthesisInput + 1,
      }),
    ).resolves.toMatchObject({ status: "failed", failureCode: "synthesis_budget_mismatch" });
    await expect(
      operations.synthesisContext(
        turn,
        packets,
        [],
        [
          topicContext("t1", allocation.packetOutputTokens - 1),
          topicContext("t2", allocation.packetOutputTokens),
        ],
        allocation,
      ),
    ).resolves.toMatchObject({ status: "failed", failureCode: "synthesis_budget_mismatch" });
  });

  it("emits a non-empty synthesis context that satisfies the immutable ContextSchema", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(operations);
    const turn = load("");
    const allocation = await operations.allocateFanout(turn, plan([]));
    const contexts = [
      topicContext("t1", allocation.packetOutputTokens),
      topicContext("t2", allocation.packetOutputTokens),
    ];
    const packets = [
      { topicId: "t1" as const, status: "partial" as const, claims: [], gaps: ["none"] },
      { topicId: "t2" as const, status: "partial" as const, claims: [], gaps: ["none"] },
    ];
    const value = await operations.synthesisContext(turn, packets, [], contexts, allocation);
    aiChatSchemas.aiChatContext.parse({ value });
    expect(value.status).toBe("ready");
    expect(value.candidates).toHaveLength(2);
    expect(value.candidateLedger.candidates).toHaveLength(2);
    expect(value.sourceMap).toEqual([]);
    expect(value.citationSourceMap).toEqual([]);
    expect(Object.isFrozen(value.candidateLedger)).toBe(true);
  });

  it("uses exact synthesis prefix marginals and excludes history and packets from mandatory input", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    const historyText = "selected synthesis history";
    stubPriorTurns(operations, historyText);
    const turn = load(historyText);
    const selectedConversation = [
      {
        turnId: "turn-1",
        userMessageId: "message-user-1",
        userContent: historyText,
        assistantMessageId: "message-assistant-1",
        assistantContent: historyText,
      },
    ];
    const allocation = await operations.allocateFanout(turn, plan(["turn-1"]));
    const contexts = [
      { ...topicContext("t1", allocation.packetOutputTokens), selectedConversation },
      { ...topicContext("t2", allocation.packetOutputTokens), selectedConversation },
    ];
    const packets = [
      {
        topicId: "t1" as const,
        status: "partial" as const,
        claims: [],
        gaps: ["first gap"],
      },
      {
        topicId: "t2" as const,
        status: "partial" as const,
        claims: [],
        gaps: ["second gap"],
      },
    ];
    const value = await operations.synthesisContext(turn, packets, [], contexts, allocation);
    const model = resolveRegisteredModel(turn.acceptanceScope.mainModelId);
    const totalInputTokens = model.countRequestTokens(value.request);
    const mandatoryInputTokens = model.countRequestTokens(
      operations.rebuildSynthesisRequest(turn, [], [], value.request.requestedOutputTokens),
    );
    const ledgerCosts = value.candidateLedger.candidates.map(
      (candidate) => candidate.renderedTokenCount,
    );
    expect(ledgerCosts.every((count) => count >= 0)).toBe(true);
    expect(ledgerCosts.reduce((total, count) => total + count, 0)).toBe(
      totalInputTokens - mandatoryInputTokens,
    );
    expect(
      value.candidateLedger.candidates.filter(
        (candidate) => candidate.kind === "conversation_entry",
      ),
    ).toHaveLength(1);
    expect(
      value.candidateLedger.candidates.filter((candidate) => candidate.kind === "topic_packet"),
    ).toHaveLength(2);

    const measurement = (operations as any).contextMeasurementPayload(
      value,
      "fanout-synthesis",
      "synthesis",
    );
    expect(measurement.mandatoryInputTokens).toBe(mandatoryInputTokens);
    expect(measurement.discretionaryInputTokens).toBe(totalInputTokens - mandatoryInputTokens);
  });

  it("retains the strict synthesis ledger when exact packet input needs compaction", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(800),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(operations);
    const turn = load("");
    const allocation = await operations.allocateFanout(turn, plan([]));
    const contexts = [
      topicContext("t1", allocation.packetOutputTokens),
      topicContext("t2", allocation.packetOutputTokens),
    ];
    const packets = [
      {
        topicId: "t1" as const,
        status: "partial" as const,
        claims: [],
        gaps: ["oversized packet framing ".repeat(100)],
      },
      { topicId: "t2" as const, status: "partial" as const, claims: [], gaps: ["none"] },
    ];
    const value = await operations.synthesisContext(turn, packets, [], contexts, allocation);
    aiChatSchemas.aiChatContext.parse({ value });
    expect(value.status).toBe("needs_compaction");
    expect(value.candidateLedger.candidates).toHaveLength(2);
    expect(
      value.request.messages.some((message) => message.content.includes("oversized packet")),
    ).toBe(true);
  });

  it("rejects packets whose real serialization exceeds their combined output allowance", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(operations);
    const turn = load("");
    const allocation = await operations.allocateFanout(turn, plan([]));
    const contexts = [
      topicContext("t1", allocation.packetOutputTokens),
      topicContext("t2", allocation.packetOutputTokens),
    ];
    const oversized = "grounded claim ".repeat(allocation.packetOutputTokens * 2);
    const packets = [
      {
        topicId: "t1" as const,
        status: "answered" as const,
        claims: [{ text: oversized, sourceKeys: ["k_cn_AAAAAAAAAAAAAAAAAAAAAA_1"] }],
        gaps: [],
      },
      { topicId: "t2" as const, status: "partial" as const, claims: [], gaps: ["none"] },
    ];

    await expect(
      operations.synthesisContext(turn, packets, [], contexts, allocation),
    ).resolves.toMatchObject({
      status: "failed",
      failureCode: "synthesis_budget_mismatch",
    });
  });
});

describe("typed controlled operation failures", () => {
  it("does not add an empty-web gap when web was not requested", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(operations);
    const assembly = await operations.assembleContext(
      {
        ...load(""),
      },
      "question",
      {
        structuredInternal: null,
        memories: [],
        memorySelection: "enabled",
        web: [],
        webSelection: "disabled",
      },
      "single-assemble",
      "single-answer",
    );
    expect(assembly.gaps).toEqual([]);
  });

  it("preserves a context failure as the exact nonretryable topic error", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    const failed: ContextState = {
      status: "failed",
      failureCode: "context_plan_unfit",
      question: "question",
      topicId: "t1",
      candidates: [],
      candidateLedger: { candidates: [] },
      sourceMap: [],
      ledgerCandidates: [],
      ledgerSourceMap: [],
      selectedConversation: [],
      consumers: [],
      gaps: [],
      compactionFeedback: [],
      request: {
        requestClass: "main",
        model: "glm-5-turbo",
        messages: [{ role: "user", content: "question" }],
        requestedOutputTokens: 100,
        reasoning: "medium",
      },
      inputTokens: 1,
      usableInputTokens: 1,
      compactionRan: false,
    };
    await expect(
      operations.answerTopic(load(""), failed, "topic-t1-answer", 100),
    ).rejects.toMatchObject({ code: "context_plan_unfit", retryable: false });
  });
});

describe("topic answer request transport", () => {
  it("hands the measured serialized request to the production topic operation", async () => {
    const measuredRequest = serializeExactAnswerRequest({
      model: "glm-5-turbo",
      system: "topic answer system",
      user: JSON.stringify({
        locale: "en-US",
        originalMessage: "Compare both topics.",
        question: "Topic one",
        topicId: "t1",
        selectedConversation: [],
        evidence: "",
        gaps: [],
      }),
      outputTool: {
        name: "emit_topic_packet",
        description: "Emit a grounded topic packet.",
        parameters: { type: "object", properties: {} },
      },
      requestedOutputTokens: 32,
      reasoning: "medium",
    });
    let transportedRequest: unknown;
    const agents = {
      structured: async (input: { readonly request?: unknown }) => {
        transportedRequest = input.request;
        return { topicId: "t1", status: "partial", claims: [], gaps: ["no evidence"] };
      },
    } as unknown as CanonicalAgentClient;
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      agents,
    );
    (operations as any).taskExecutionCoordinates = async () => ({ loopIteration: 0, attempt: 1 });
    (operations as any).contextExposureProofMarkers = () => [];
    (operations as any).recordContextExposures = async () => undefined;
    (operations as any).validateFrozenScope = async () => undefined;
    (operations as any).observe = async () => undefined;
    const context: ContextState = {
      status: "ready",
      question: "Topic one",
      topicId: "t1",
      candidates: [],
      candidateLedger: { candidates: [] },
      sourceMap: [],
      ledgerCandidates: [],
      ledgerSourceMap: [],
      selectedConversation: [],
      consumers: [],
      gaps: [],
      compactionFeedback: [],
      request: measuredRequest,
      inputTokens: 1,
      usableInputTokens: 100_000,
      compactionRan: false,
    };
    await expect(
      operations.answerTopic(load(""), context, "topic-t1-answer", 32),
    ).resolves.toMatchObject({
      topicId: "t1",
      status: "partial",
    });
    const withoutProofs = (request: any) => {
      const { sourceExposureProofs: _proofs, ...rest } = request;
      return rest;
    };
    expect(withoutProofs(transportedRequest)).toEqual(measuredRequest);
  });
});

describe("fanout immutable source-map merge", () => {
  const source = (
    topicId: "t1" | "t2",
    range: { readonly charStart: number; readonly charEnd: number },
    snapshotId = "version-1",
    sourceKey = "k_cn_AAAAAAAAAAAAAAAAAAAAAA_1",
  ): FinalSourceRecord => ({
    sourceKey,
    locator: {
      kind: "document",
      sourceId: "public:source-1",
      documentId: "document-1",
      snapshotId,
      contentHash: "a".repeat(64),
      ranges: [range],
    },
    label: "Official report",
    publicProvenance: {
      documentTitle: "Official report",
      citationUrl: "https://example.test/report",
    },
    uses: [
      {
        consumerTaskId: `topic-${topicId}-answer`,
        topicId,
        contextOrder: 0,
        renderedTokenCount: 10,
        ranges: [range],
      },
    ],
  });
  const context = (topicId: "t1" | "t2", record: FinalSourceRecord): ContextState => ({
    status: "ready",
    question: topicId,
    topicId,
    candidates: [],
    candidateLedger: { candidates: [] },
    sourceMap: [record],
    ledgerCandidates: [],
    ledgerSourceMap: [record],
    selectedConversation: [],
    consumers: [],
    gaps: [],
    compactionFeedback: [],
    request: {
      requestClass: "main",
      model: "glm-5-turbo",
      messages: [{ role: "user", content: "answer" }],
      requestedOutputTokens: 512,
      reasoning: "medium",
    },
    inputTokens: 10,
    usableInputTokens: 100,
    compactionRan: false,
  });

  it("unions locator ranges while retaining exact per-topic consumer subsets", () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    expect(
      operations.mergeFanoutSourceMaps([
        context("t1", source("t1", { charStart: 0, charEnd: 10 })),
        context("t2", source("t2", { charStart: 20, charEnd: 30 })),
      ]),
    ).toEqual([
      {
        ...source("t1", { charStart: 0, charEnd: 10 }),
        locator: {
          kind: "document",
          sourceId: "public:source-1",
          documentId: "document-1",
          snapshotId: "version-1",
          contentHash: "a".repeat(64),
          ranges: [
            { charStart: 0, charEnd: 10 },
            { charStart: 20, charEnd: 30 },
          ],
        },
        uses: [
          source("t1", { charStart: 0, charEnd: 10 }).uses[0],
          source("t2", { charStart: 20, charEnd: 30 }).uses[0],
        ],
      },
    ]);
  });

  it("rejects one source key reused for a different immutable version", () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    expect(() =>
      operations.mergeFanoutSourceMaps([
        context("t1", source("t1", { charStart: 0, charEnd: 10 })),
        context("t2", source("t2", { charStart: 20, charEnd: 30 }, "version-2")),
      ]),
    ).toThrow("different immutable provenance");
  });

  it("reuses the first canonical fanout locator for the same normalized web quotation", () => {
    const webSource = (topicId: "t1" | "t2", capturedAt: string): FinalSourceRecord => ({
      sourceKey: "k_cn_AAAAAAAAAAAAAAAAAAAAAA_1",
      locator: {
        kind: "web",
        url: "https://example.test/report",
        title: `Capture ${topicId}`,
        domain: "example.test",
        quote: "The same immutable quotation.",
        quoteHash: "quote-hash",
        capturedAt,
      },
      label: `Capture ${topicId}`,
      publicProvenance: {
        documentTitle: `Capture ${topicId}`,
        citationUrl: "https://example.test/report",
      },
      uses: [
        {
          consumerTaskId: `topic-${topicId}-answer`,
          topicId,
          contextOrder: 0,
          renderedTokenCount: 12,
          ranges: [],
        },
      ],
    });
    const first = webSource("t1", "2026-07-10T12:00:00.000Z");

    expect(
      new CanonicalWorkflowOperations(
        "postgres://unused",
        config(100_000),
        {} as CanonicalAgentClient,
      ).mergeFanoutSourceMaps([
        context("t1", first),
        context("t2", webSource("t2", "2026-07-10T12:00:01.000Z")),
      ]),
    ).toEqual([
      {
        ...first,
        uses: [first.uses[0], webSource("t2", "2026-07-10T12:00:01.000Z").uses[0]],
      },
    ]);
  });

  it("orders merged source keys by numeric ordinal and rejects malformed keys", () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    const keys = [9, 10, 11].map((ordinal) => `k_cn_AAAAAAAAAAAAAAAAAAAAAA_${ordinal}`);
    const contexts = keys.map((key, index) =>
      context("t1", source("t1", { charStart: index, charEnd: index + 1 }, "version-1", key)),
    );
    expect(operations.mergeFanoutSourceMaps(contexts).map((item) => item.sourceKey)).toEqual(keys);
    expect(() =>
      operations.mergeFanoutSourceMaps([
        context("t1", source("t1", { charStart: 0, charEnd: 1 }, "version-1", "not-a-key")),
        context("t2", source("t2", { charStart: 1, charEnd: 2 }, "version-1", "also-not-a-key")),
      ]),
    ).toThrow();
  });
});

describe("provider-authored canonical schemas", () => {
  it("keeps provider JSON schemas compatible with Z.AI while retaining exact namespace rejection", () => {
    for (const schema of Object.values(canonicalProviderValueSchemas)) {
      const providerJson = JSON.stringify(z.toJSONSchema(schema));
      expect(providerJson).not.toMatch(/\\p\{/u);
    }

    const _publicReference = {
      kind: "document" as const,
      documentId: "document",
      snapshotId: "version",
      source: { kind: "public" as const, sourceId: "public:source" },
      purpose: "ground answer",
    };
    for (const whitespace of ["\u00a0", "\u2028", "\ufeff"]) {
      expect(() =>
        canonicalProviderValueSchemas.planTurn.parse({
          mode: "single",
          question: `question${whitespace}`,
          relevantTurnIds: [],
        }),
      ).not.toThrow();
    }
  });

  it("accepts only the model-visible document identity", () => {
    const publicReference = {
      kind: "document" as const,
      documentId: "document",
      purpose: "ground answer",
    };
    expect("internalManifestOutput" in canonicalProviderValueSchemas).toBe(false);
    expect(publicReference).toMatchObject({ kind: "document", documentId: "document" });
  });

  it("rejects unknown fields at every model-output root and nested object boundary", () => {
    expect(() =>
      canonicalProviderValueSchemas.planTurn.parse({
        mode: "single",
        question: "question",
        relevantTurnIds: [],
        ignored: true,
      }),
    ).toThrow();
    expect(() =>
      canonicalProviderValueSchemas.planTurn.parse({
        mode: "fanout",
        reason: "independent topics",
        topics: [
          { question: "one", relevantTurnIds: [], ignored: true },
          { question: "two", relevantTurnIds: [] },
        ],
      }),
    ).toThrow();
    expect(() =>
      canonicalProviderValueSchemas.planTurnProvider.parse({
        mode: "single",
        question: "question",
        relevantTurnIds: [],
        ignored: true,
      }),
    ).toThrow();
    expect(() =>
      canonicalProviderValueSchemas.memoryManifestOutput.parse({
        entries: [{ memoryId: "memory", memoryRevisionId: "revision", ignored: true }],
      }),
    ).toThrow();
    expect(() =>
      canonicalProviderValueSchemas.webManifestOutput.parse({
        entries: [
          {
            url: "https://example.com/",
            title: "Title",
            domain: "example.com",
            quote: "quote",
            capturedAt: "2026-07-10T00:00:00.000Z",
            purpose: "ground answer",
            ignored: true,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      canonicalProviderValueSchemas.memoryProposalOutput.parse({
        proposals: [{ kind: "preference", content: "value", ignored: true }],
      }),
    ).toThrow();
    expect(() =>
      canonicalProviderValueSchemas.topicPacket.parse({
        topicId: "t1",
        status: "answered",
        claims: [{ text: "claim", sourceKeys: ["key"], ignored: true }],
        gaps: [],
      }),
    ).toThrow();
  });
});

describe("compaction run concurrency permit", () => {
  type CompactGroup = CompactionGroup;
  type TaskRuntime = {
    readonly runId: string;
    readonly stepId: string;
    readonly attempt: number;
    readonly iteration: number;
    readonly signal: AbortSignal;
    readonly db: Readonly<Record<string, unknown>>;
    readonly heartbeat: (data?: unknown) => void;
    readonly lastHeartbeat: unknown | null;
  };
  interface Deferred {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
  }
  const withTaskRuntime = (
    SmithersTaskRuntimeModule as unknown as {
      readonly withTaskRuntime: <Value>(runtime: TaskRuntime, execute: () => Value) => Value;
    }
  ).withTaskRuntime;

  const deferred = (): Deferred => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  const group = (groupId: string, mode: CompactGroup["mode"]): CompactGroup => ({
    groupId,
    candidateIds: ["candidate"],
    renderedTokenBudget: 100,
    mode,
  });

  const envelope = (groupId: string): GroupResultEnvelope => ({
    groupId,
    result: { decisions: [] },
    renderedTokenCount: 0,
  });

  it("caps each run, preserves FIFO progress, releases failures, and drops queued aborts", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    const internal = operations as unknown as {
      normalCompactionGroup: (...args: readonly unknown[]) => Promise<GroupResultEnvelope>;
      sourceToolCompactionGroup: (...args: readonly unknown[]) => Promise<GroupResultEnvelope>;
      compactionRunSemaphores: Map<string, unknown>;
    };
    const providerCalls: string[] = [];
    const enteredByRun = new Map<string, string[]>();
    const activeByRun = new Map<string, number>();
    const peakByRun = new Map<string, number>();
    const gates = new Map<string, Deferred>();
    const taskKey = (runId: string, taskId: string): string => `${runId}:${taskId}`;
    const sharedRun = "run-shared";
    const otherRun = "run-other";
    const sharedTasks = [
      { taskId: "topic-a1", mode: "normal" as const },
      { taskId: "topic-a2", mode: "normal" as const },
      { taskId: "synthesis-a1", mode: "source_tool" as const },
      { taskId: "topic-a3", mode: "normal" as const },
      { taskId: "synthesis-a2", mode: "source_tool" as const },
      { taskId: "topic-fail", mode: "normal" as const },
      { taskId: "topic-abort", mode: "normal" as const },
      { taskId: "topic-after", mode: "normal" as const },
    ];
    const otherTasks = [
      { taskId: "topic-b1", mode: "normal" as const },
      { taskId: "synthesis-b1", mode: "source_tool" as const },
      { taskId: "topic-b2", mode: "normal" as const },
    ];
    for (const { taskId } of [...sharedTasks, ...otherTasks]) {
      if (taskId !== "topic-fail") {
        gates.set(taskKey(sharedRun, taskId), deferred());
      }
    }
    for (const { taskId } of otherTasks) {
      gates.set(taskKey(otherRun, taskId), deferred());
    }
    const fakeProviderCall = async (...args: readonly unknown[]): Promise<GroupResultEnvelope> => {
      const runId = (args[0] as { readonly aiRunId: string }).aiRunId;
      const taskId = String(args[3]);
      providerCalls.push(taskKey(runId, taskId));
      const entered = enteredByRun.get(runId) ?? [];
      entered.push(taskId);
      enteredByRun.set(runId, entered);
      const active = (activeByRun.get(runId) ?? 0) + 1;
      activeByRun.set(runId, active);
      peakByRun.set(runId, Math.max(peakByRun.get(runId) ?? 0, active));
      try {
        if (taskId === "topic-fail") throw new Error("provider failure");
        const gate = gates.get(taskKey(runId, taskId));
        if (gate === undefined) throw new Error(`missing gate for ${taskKey(runId, taskId)}`);
        await gate.promise;
        return envelope((args[2] as { readonly groupId: string }).groupId);
      } finally {
        activeByRun.set(runId, (activeByRun.get(runId) ?? 1) - 1);
      }
    };
    internal.normalCompactionGroup = fakeProviderCall;
    internal.sourceToolCompactionGroup = fakeProviderCall;

    const controllers = new Map<string, AbortController>();
    const invoke = (
      runId: string,
      taskId: string,
      mode: CompactGroup["mode"],
    ): Promise<unknown> => {
      const controller = new AbortController();
      controllers.set(taskKey(runId, taskId), controller);
      return withTaskRuntime(
        {
          runId: `ai-chat:${runId}`,
          stepId: taskId,
          attempt: 1,
          iteration: 0,
          signal: controller.signal,
          db: {},
          heartbeat: () => undefined,
          lastHeartbeat: null,
        },
        () =>
          operations.compactContextGroup(
            { aiRunId: runId } as LoadedTurn,
            {} as ContextState,
            group(taskId, mode),
            taskId,
          ),
      );
    };
    const waitFor = async (condition: () => boolean): Promise<void> => {
      for (let index = 0; index < 100 && !condition(); index += 1) {
        await Promise.resolve();
      }
      expect(condition()).toBe(true);
    };
    const sharedPromises = sharedTasks.map(({ taskId, mode }) => invoke(sharedRun, taskId, mode));
    await waitFor(() => (enteredByRun.get(sharedRun)?.length ?? 0) === 3);
    const otherPromises = otherTasks.map(({ taskId, mode }) => invoke(otherRun, taskId, mode));
    await waitFor(() => (enteredByRun.get(otherRun)?.length ?? 0) === 3);

    controllers.get(taskKey(sharedRun, "topic-abort"))!.abort();
    gates.get(taskKey(sharedRun, "topic-a1"))!.resolve();
    await waitFor(() => (enteredByRun.get(sharedRun) ?? []).includes("topic-a3"));
    gates.get(taskKey(sharedRun, "topic-a3"))!.resolve();
    gates.get(taskKey(sharedRun, "topic-a2"))!.resolve();
    await waitFor(() => (enteredByRun.get(sharedRun) ?? []).includes("synthesis-a2"));
    gates.get(taskKey(sharedRun, "synthesis-a2"))!.resolve();
    gates.get(taskKey(sharedRun, "synthesis-a1"))!.resolve();
    await waitFor(() => (enteredByRun.get(sharedRun) ?? []).includes("topic-after"));
    gates.get(taskKey(sharedRun, "topic-after"))!.resolve();
    for (const { taskId } of otherTasks) gates.get(taskKey(otherRun, taskId))!.resolve();

    const [sharedSettled, otherSettled] = await Promise.all([
      Promise.allSettled(sharedPromises),
      Promise.allSettled(otherPromises),
    ]);
    expect(sharedSettled[5]?.status).toBe("rejected");
    expect(sharedSettled[6]?.status).toBe("rejected");
    expect(enteredByRun.get(sharedRun)).toEqual([
      "topic-a1",
      "topic-a2",
      "synthesis-a1",
      "topic-a3",
      "synthesis-a2",
      "topic-fail",
      "topic-after",
    ]);
    expect(providerCalls).not.toContain(taskKey(sharedRun, "topic-abort"));
    expect(peakByRun.get(sharedRun)).toBe(3);
    expect(peakByRun.get(otherRun)).toBe(3);
    expect(otherSettled.every(({ status }) => status === "fulfilled")).toBe(true);
    expect(internal.compactionRunSemaphores.size).toBe(0);
  });
});
