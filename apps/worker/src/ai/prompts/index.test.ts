import { describe, expect, it } from "vitest";

import {
  CompactionGroupPrompt,
  ContextManifestPrompt,
  FallbackContextPrompt,
  OversizedSourcePrompt,
  InternalQueryPlanPrompt,
  InternalQueryReviewPrompt,
  PlanTurnPrompt,
  DirectAnswerPrompt,
  MemoryExtractorPrompt,
  MemorySelectorPrompt,
  SynthesisPrompt,
  TopicAnswerPrompt,
  WebResearchPrompt,
  InitialCompactionProviderInputSchema,
  SourceToolCompactionProviderInputSchema,
  buildGroupCompactionRequest,
  buildInitialCompactionRequest,
} from "./index";
import type { SourceToolCompactionRequest } from "../context/compaction-runtime";

const rolePrompts = {
  PlanTurnPrompt,
  MemorySelectorPrompt,
  WebResearchPrompt,
  DirectAnswerPrompt,
  TopicAnswerPrompt,
  SynthesisPrompt,
  MemoryExtractorPrompt,
} as const;

describe("canonical AI role prompts", () => {
  it.each(Object.entries(rolePrompts))(
    "%s declares every mandatory contract boundary",
    (_name, prompt) => {
      expect(prompt).toContain("Atomic responsibility:");
      expect(prompt).toContain("Input inventory:");
      expect(prompt).toContain("Allowed tools:");
      expect(prompt).toContain("Output contract:");
      expect(prompt).toContain("Empty-result behavior:");
      expect(prompt).toContain("Failure behavior:");
      expect(prompt).toContain("Restricted-content handling:");
    },
  );

  it("pins the plan-turn inventory, union, and only terminal tool", () => {
    expect(PlanTurnPrompt).toContain('"currentMessage"');
    expect(PlanTurnPrompt).toContain('"currentDate"');
    expect(PlanTurnPrompt).toContain('"assistantContent"');
    expect(PlanTurnPrompt).toContain('"retryable"');
    expect(PlanTurnPrompt).toContain("emit_plan_turn only");
    expect(PlanTurnPrompt).toContain('"mode":"clarify"');
    expect(PlanTurnPrompt).toContain("relevantTurnIds: []");
    expect(PlanTurnPrompt).toContain("A bounded retry means");
    expect(PlanTurnPrompt).toContain("multiple plausible same-kind antecedents");
    expect(PlanTurnPrompt).toContain("exactly one supplied whole entry matches the modifier");
    expect(PlanTurnPrompt).toContain("Do not infer a recency pairing");
    expect(PlanTurnPrompt).toContain("Name the competing candidates");
    expect(PlanTurnPrompt).toContain("Shared generic terms");
    expect(PlanTurnPrompt).toContain("Ignore unrelated later entries");
  });

  it("pins plan-turn routing without workflow-owned IDs", () => {
    for (const field of [
      '"currentMessage"',
      '"entries"',
      '"locale"',
      '"market"',
      '"currentDate"',
    ]) {
      expect(PlanTurnPrompt).toContain(field);
    }
    expect(PlanTurnPrompt).toContain("emit_plan_turn only");
    expect(PlanTurnPrompt).toContain('"mode":"single"');
    expect(PlanTurnPrompt).toContain('"mode":"fanout"');
    expect(PlanTurnPrompt).toContain("relevantTurnIds");
    expect(PlanTurnPrompt).toContain("resolved question");
  });

  it("pins every selector tool inventory and strict manifest shape", () => {
    for (const tool of ["search_memories", "inspect_memory", "emit_memory_manifest"]) {
      expect(MemorySelectorPrompt).toContain(tool);
    }
    expect(MemorySelectorPrompt).toContain('"memoryRevisionId"');
    for (const tool of ["web_search", "web_fetch", "emit_web_evidence"]) {
      expect(WebResearchPrompt).toContain(tool);
    }
    for (const field of ["url", "domain", "quote", "capturedAt", "purpose"]) {
      expect(WebResearchPrompt).toContain(field);
    }
    expect(WebResearchPrompt).toContain("Search snippets are discovery hints only");
    expect(WebResearchPrompt).toContain("only the smallest set of directly relevant pages");
    expect(WebResearchPrompt).toContain("emit exactly one quotation from that page");
    expect(WebResearchPrompt).toContain("Use web tools only when this topic explicitly asks");
    expect(WebResearchPrompt).toContain(
      "A conceptual comparison such as how two internal energy subjects work remains non-web",
    );
    expect(WebResearchPrompt).toContain("A named source is a hard lexical anchor");
    expect(WebResearchPrompt).toContain(
      "If any web_fetch succeeds, emit at least one exact quotation from the fetched page",
    );
    expect(WebResearchPrompt).toContain(
      "A URL-specific fetchFailed result may be followed only by another discovered URL",
    );
    for (const prompt of [MemorySelectorPrompt, WebResearchPrompt]) {
      expect(prompt).toContain('"toolBounds"');
    }
    expect(MemorySelectorPrompt).toContain('"maximumResultItems"');
    expect(WebResearchPrompt).toContain('"maximumDomainFiltersPerSearch"');
    expect(MemorySelectorPrompt).toContain("search_memories(query, cursor?)");
    expect(MemorySelectorPrompt).not.toContain("search_memories(terms");
  });

  it("requires terminal tools to run alone after non-terminal tool results", () => {
    for (const prompt of [MemorySelectorPrompt, WebResearchPrompt, MemoryExtractorPrompt]) {
      expect(prompt).toContain(
        "wait for every requested non-terminal tool result before another turn",
      );
      expect(prompt).toContain(
        "The named terminal tool is the sole call in its own later provider turn",
      );
      expect(prompt).toContain(
        "never issue a terminal call alongside search, fetch, inspection, or any other tool",
      );
    }
    expect(WebResearchPrompt).toContain(
      "After a successful fetch, emit_web_evidence must be the sole tool call in the next turn",
    );
    expect(WebResearchPrompt).toContain(
      "A fetchFailed result is not a successful fetch: choose another exact discovered URL",
    );
    expect(WebResearchPrompt).toContain("Request at most one web_search call per provider turn");
    expect(WebResearchPrompt).toContain(
      "If any tool result contains protocolError, stop search and fetch immediately",
    );
  });

  it("keeps direct and synthesis output as ordinary no-tool text", () => {
    for (const prompt of [DirectAnswerPrompt, SynthesisPrompt]) {
      expect(prompt).toContain("Allowed tools: None");
      expect(prompt).toContain("ordinary assistant text");
      expect(prompt).toContain("[[cite:k_<citationNamespace>_<ordinal>]]");
      expect(prompt).toContain("exact-token-gate failure");
    }
    expect(DirectAnswerPrompt).toContain('"evidence"');
    expect(DirectAnswerPrompt).toContain(
      "A user-authored preference, instruction, or memory request",
    );
    expect(DirectAnswerPrompt).toContain("Feed-recap answers");
    expect(SynthesisPrompt).toContain('"packets"');
    expect(SynthesisPrompt).toContain("facts absent from those packets");
    expect(SynthesisPrompt).toContain("Every factual sentence must be a direct restatement");
  });

  it("pins the topic packet schema and empty-evidence partial result", () => {
    expect(TopicAnswerPrompt).toContain("emit_topic_packet only");
    expect(TopicAnswerPrompt).toContain('"topicId":"t1"|"t2"|"t3"');
    expect(TopicAnswerPrompt).toContain('"status":"answered"|"partial"');
    expect(TopicAnswerPrompt).toContain('"sourceKeys":string[]');
    expect(TopicAnswerPrompt).toContain("status: partial, claims: []");
  });

  it("pins memory extraction modes, unbounded proposal array, and invalid-target failure", () => {
    for (const tool of ["search_memories", "inspect_memory", "emit_memory_proposals"]) {
      expect(MemoryExtractorPrompt).toContain(tool);
    }
    expect(MemoryExtractorPrompt).toContain('"currentUserMessage"');
    expect(MemoryExtractorPrompt).toContain('"activeMemoryCount"');
    expect(MemoryExtractorPrompt).not.toContain('"activeMemories"');
    expect(MemoryExtractorPrompt).toContain('"toolBounds"');
    expect(MemoryExtractorPrompt).toContain("search_memories(query, cursor?)");
    expect(MemoryExtractorPrompt).not.toContain("search_memories(terms");
    expect(MemoryExtractorPrompt).toContain('"targetMemoryId"?:string');
    expect(MemoryExtractorPrompt).toContain("no application-level item maximum");
    expect(MemoryExtractorPrompt).toContain("Never turn an invalid update into a create");
    expect(MemoryExtractorPrompt).toContain(
      "A one-turn request for an exact date, language, format, or answer style is not durable memory",
    );
  });
});

describe("retrieval and compaction prompt inventory", () => {
  it("contains the six current prompt contracts", () => {
    const promptInventory = {
      InternalQueryPlanPrompt,
      InternalQueryReviewPrompt,
      ContextManifestPrompt,
      CompactionGroupPrompt,
      OversizedSourcePrompt,
      FallbackContextPrompt,
    };
    expect(Object.keys(promptInventory)).toEqual([
      "InternalQueryPlanPrompt",
      "InternalQueryReviewPrompt",
      "ContextManifestPrompt",
      "CompactionGroupPrompt",
      "OversizedSourcePrompt",
      "FallbackContextPrompt",
    ]);
  });
  it("requires phrase atoms to represent explicit adjacency", () => {
    for (const prompt of [InternalQueryPlanPrompt, InternalQueryReviewPrompt]) {
      expect(prompt).toContain("Use one term atom per separate concept");
      expect(prompt).toContain("Use a phrase atom only when exact word adjacency is explicit");
    }
  });
  it("requires date-only planning for broad freshness", () => {
    expect(InternalQueryPlanPrompt).toContain(
      'produce an ordinary document query with order "newest", an exact publishedAt date filter, and empty all and anyOf arrays',
    );
    expect(InternalQueryReviewPrompt).toContain(
      "preserve the date filter and newest ordering with empty all and anyOf arrays",
    );
    expect(InternalQueryReviewPrompt).not.toContain("remove generic lexical terms");
  });
});
describe("parallel compaction provider contracts", () => {
  const candidate = {
    candidateId: "c1",
    kind: "document" as const,
    label: "Public document",
    purpose: "answer the question",
    date: "2026-07-30",
    renderedTokenCount: 120,
    preview: "Exact preview text.",
  };

  it("declares complete, injection-resistant prompts", () => {
    for (const prompt of [
      ContextManifestPrompt,
      CompactionGroupPrompt,
      OversizedSourcePrompt,
      FallbackContextPrompt,
    ]) {
      expect(prompt).toContain("Atomic responsibility:");
      expect(prompt).toContain("Complete output:");
      expect(prompt).toContain("Prompt-injection resistance:");
      expect(prompt).toContain("opaque run-local");
      expect(prompt).toContain("raw range identity");
    }
    expect(ContextManifestPrompt).toContain(
      "Only document and retrieved older chat candidates may be compacted",
    );
    expect(CompactionGroupPrompt).toContain("Every group member appears exactly once");
    expect(OversizedSourcePrompt).toContain("search_source_passages");
    expect(OversizedSourcePrompt).toContain("read_source_passages");
    expect(OversizedSourcePrompt).toContain("emit_compaction_result");
    expect(FallbackContextPrompt).toContain("A second fallback");
  });

  it("keeps provider payloads strict and free of canonical source fields", () => {
    const manifestInput = {
      question: "What changed?",
      allowance: 500,
      overage: 80,
      mandatoryInputCost: 100,
      candidates: [candidate],
      toolBounds: { maximumCandidates: 8, maximumGroups: 4 },
    };
    expect(InitialCompactionProviderInputSchema.parse(manifestInput)).toEqual(manifestInput);
    expect(() =>
      InitialCompactionProviderInputSchema.parse({ ...manifestInput, sourceId: "public:secret" }),
    ).toThrow();

    const manifestPayload = buildInitialCompactionRequest({}, manifestInput, "single-compact-plan");
    const manifestJson = JSON.parse(manifestPayload.user);
    expect(manifestJson).toEqual(manifestInput);
    for (const forbidden of [
      "identity",
      "sourceId",
      "documentId",
      "snapshotId",
      "contentHash",
      "messageId",
      "ranges",
      "charStart",
      "charEnd",
    ]) {
      expect(manifestPayload.user).not.toContain(`"${forbidden}"`);
    }

    const sourceRequest: SourceToolCompactionRequest = {
      taskId: "single-compact-g001",
      phase: "compact",
      question: "What changed?",
      group: {
        groupId: "g1",
        candidateIds: ["c1"],
        renderedTokenBudget: 80,
        mode: "source_tool",
      },
      candidate: {
        candidateId: "c1",
        kind: "document",
        label: "Public document",
        purpose: "answer the question",
        date: "2026-07-30",
        passages: [{ passageId: "p1", text: "Exact passage." }],
      },
    };
    const sourcePayload = buildGroupCompactionRequest({}, sourceRequest);
    expect(sourcePayload.tools?.map((tool) => tool.name)).toEqual([
      "search_source_passages",
      "read_source_passages",
      "emit_compaction_result",
    ]);
    expect(
      SourceToolCompactionProviderInputSchema.parse(JSON.parse(sourcePayload.user)),
    ).toBeDefined();
    expect(sourcePayload.user).not.toContain('"ranges"');
    expect(sourcePayload.user).not.toContain('"charStart"');
    expect(sourcePayload.user).not.toContain('"sourceId"');
  });
});
