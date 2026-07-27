import { describe, expect, it } from "vitest";

import {
  ContextReductionPrompt,
  PlanTurnPrompt,
  DirectAnswerPrompt,
  InternalRetrievalPrompt,
  MemoryExtractorPrompt,
  MemorySelectorPrompt,
  SynthesisPrompt,
  TopicAnswerPrompt,
  WebResearchPrompt,
} from "./index";

const rolePrompts = {
  PlanTurnPrompt,
  InternalRetrievalPrompt,
  MemorySelectorPrompt,
  WebResearchPrompt,
  ContextReductionPrompt,
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
    for (const tool of ["search_internal", "inspect_internal", "emit_internal_manifest"]) {
      expect(InternalRetrievalPrompt).toContain(tool);
    }
    for (const field of ['"documentId":string', "chat_message", "purpose"]) {
      expect(InternalRetrievalPrompt).toContain(field);
    }
    expect(InternalRetrievalPrompt).toContain("authorized search scope is compiled by Brief code");
    expect(InternalRetrievalPrompt).toContain("unquoted whitespace requires every lexeme");
    expect(InternalRetrievalPrompt).toContain("sparse high-recall lexical query");
    expect(InternalRetrievalPrompt).toContain(
      "sole permitted refinement must be a strict deletion-only subset",
    );
    expect(InternalRetrievalPrompt).toContain("replace every hyphen joining words with a space");
    expect(InternalRetrievalPrompt).toContain(
      "Saved memories are owned by the separate memory selector B",
    );
    expect(InternalRetrievalPrompt).toContain(
      "target documents and search only the factual document subject",
    );
    expect(InternalRetrievalPrompt).toContain(
      "select the answer message that contains the requested information",
    );
    expect(InternalRetrievalPrompt).toContain(
      "Spend at most two ordinary provider turns on search and refinement",
    );
    expect(InternalRetrievalPrompt).toContain(
      "Issue at most one search_internal call per provider turn",
    );
    expect(InternalRetrievalPrompt).toContain(
      "issue multiple distinct inspect_internal calls together in the same provider turn",
    );
    expect(InternalRetrievalPrompt).toContain(
      "If any tool result contains protocolError, stop all search and inspection immediately",
    );
    expect(InternalRetrievalPrompt).toContain(
      "A queryRejected result is correction-only, is not an empty search result",
    );
    expect(InternalRetrievalPrompt).toContain("cannot justify an empty manifest");
    expect(InternalRetrievalPrompt).toContain("retrieve each distinct named subject");
    expect(InternalRetrievalPrompt).toContain(
      "emit an empty manifest without calling search_internal",
    );
    expect(InternalRetrievalPrompt).toContain("Feed-recap rule");
    expect(InternalRetrievalPrompt).toContain("bounded recency listing");
    expect(InternalRetrievalPrompt).toContain(
      "Reserve the final provider turn for emit_internal_manifest",
    );
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
    for (const prompt of [InternalRetrievalPrompt, MemorySelectorPrompt, WebResearchPrompt]) {
      expect(prompt).toContain('"toolBounds"');
    }
    expect(InternalRetrievalPrompt).toContain('"maximumResultsPerSearch"');
    expect(MemorySelectorPrompt).toContain('"maximumResultItems"');
    expect(WebResearchPrompt).toContain('"maximumDomainFiltersPerSearch"');
    expect(MemorySelectorPrompt).toContain("search_memories(query, cursor?)");
    expect(MemorySelectorPrompt).not.toContain("search_memories(terms");
  });

  it("requires terminal tools to run alone after non-terminal tool results", () => {
    for (const prompt of [
      InternalRetrievalPrompt,
      MemorySelectorPrompt,
      WebResearchPrompt,
      ContextReductionPrompt,
      MemoryExtractorPrompt,
    ]) {
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

  it("pins complete context accounting, measurement, and document-only ranges", () => {
    for (const field of [
      '"allowance"',
      '"overage"',
      '"mandatoryInputCost"',
      '"renderedTokenCount"',
      '"priorValidationFeedback"',
    ]) {
      expect(ContextReductionPrompt).toContain(field);
    }
    for (const tool of [
      "inspect_candidate",
      "search_within_candidate",
      "measure_plan",
      "emit_context_plan",
    ]) {
      expect(ContextReductionPrompt).toContain(tool);
    }
    expect(ContextReductionPrompt).toContain('"action":"keep"');
    expect(ContextReductionPrompt).toContain('"action":"range"');
    expect(ContextReductionPrompt).toContain('"action":"omit"');
    expect(ContextReductionPrompt).toContain("Non-document candidates are whole-item keep or omit");
    expect(ContextReductionPrompt).toContain('"conversation_entry"');
    expect(ContextReductionPrompt).toContain('"toolBounds"');
    expect(ContextReductionPrompt).toContain("search_within_candidate(id, terms, cursor?)");
    expect(ContextReductionPrompt).toContain("Preserve every candidate required by the question");
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
