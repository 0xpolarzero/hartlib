import { describe, expect, it } from "vitest";

import type { AnswerCandidate, MemorySnapshot, TopicPacket } from "./types";
import {
  AgentOutputValidationError,
  validateAndNormalizeExecutionPlan,
  validateContextDecisions,
  validateConversationResolution,
  validateMemoryProposals,
  validateTopicPacket,
} from "./validators";

describe("canonical agent output validators", () => {
  it("accepts C inventory subsets and rejects invented or duplicate turns", () => {
    expect(
      validateConversationResolution(
        { mode: "continue", retrievalQuestion: "resolved", selectedTurnIds: ["turn-2"] },
        ["turn-1", "turn-2"],
      ),
    ).toEqual({ mode: "continue", retrievalQuestion: "resolved", selectedTurnIds: ["turn-2"] });
    expect(() =>
      validateConversationResolution(
        { mode: "continue", retrievalQuestion: "resolved", selectedTurnIds: ["turn-x"] },
        ["turn-1"],
      ),
    ).toThrow(AgentOutputValidationError);
    expect(() =>
      validateConversationResolution(
        { mode: "continue", retrievalQuestion: "resolved", selectedTurnIds: ["turn-1", "turn-1"] },
        ["turn-1"],
      ),
    ).toThrow(AgentOutputValidationError);
    for (const invalid of [
      {},
      {
        mode: "clarify",
        question: "Which result?",
        retrievalQuestion: "mixed branch",
        selectedTurnIds: [],
      },
      { mode: "clarify", question: "Which result?", ignored: true },
      { mode: "continue", retrievalQuestion: "resolved" },
    ]) {
      expect(() => validateConversationResolution(invalid, ["turn-1"])).toThrow(
        AgentOutputValidationError,
      );
    }
    expect(
      validateConversationResolution({ mode: "clarify", question: "Which result?" }, ["turn-1"]),
    ).toEqual({ mode: "clarify", question: "Which result?" });
  });

  it("normalizes D topic ids once and validates turn subsets", () => {
    expect(
      validateAndNormalizeExecutionPlan(
        {
          mode: "fanout",
          reason: "separable",
          topics: [
            { question: "First?", relevantTurnIds: ["turn-1"] },
            { question: "Second?", relevantTurnIds: [] },
          ],
        },
        ["turn-1"],
        3,
      ),
    ).toEqual({
      mode: "fanout",
      reason: "separable",
      topics: [
        { topicId: "t1", question: "First?", relevantTurnIds: ["turn-1"] },
        { topicId: "t2", question: "Second?", relevantTurnIds: [] },
      ],
    });
    expect(() =>
      validateAndNormalizeExecutionPlan(
        {
          mode: "fanout",
          reason: "bad",
          topics: [
            { question: "First?", relevantTurnIds: ["turn-x"] },
            { question: "Second?", relevantTurnIds: [] },
          ],
        },
        ["turn-1"],
        3,
      ),
    ).toThrow(AgentOutputValidationError);
    expect(() =>
      validateAndNormalizeExecutionPlan(
        { mode: "single", reason: "focused", unexpected: true },
        [],
        3,
      ),
    ).toThrow(AgentOutputValidationError);
  });

  it("requires O to decide every candidate once and range documents only", () => {
    const document: AnswerCandidate = {
      id: "candidate-document",
      kind: "document",
      rank: 0,
      purpose: "answer",
      sourceId: "source-test",
      documentId: "document-1",
      documentVersionId: "version-1",
      contentHash: "hash",
      text: "0123456789",
      ranges: [],
      label: null,
      publicProvenance: { documentTitle: "Document", citationUrl: "https://example.test" },
      renderedTokenCount: 10,
    };
    const memory: AnswerCandidate = {
      id: "candidate-memory",
      kind: "memory",
      rank: 0,
      purpose: "answer",
      memoryId: "memory-1",
      memoryRevisionId: "revision-1",
      text: "memory",
      label: null,
      renderedTokenCount: 3,
    };
    expect(
      validateContextDecisions(
        [
          {
            id: document.id,
            action: "range",
            ranges: [
              { charStart: 0, charEnd: 3 },
              { charStart: 2, charEnd: 5 },
            ],
            reason: "focused",
          },
          { id: memory.id, action: "omit", reason: "irrelevant" },
        ],
        [document, memory],
      ),
    ).toEqual([
      {
        id: document.id,
        action: "range",
        ranges: [{ charStart: 0, charEnd: 5 }],
        reason: "focused",
      },
      { id: memory.id, action: "omit", reason: "irrelevant" },
    ]);
    expect(() =>
      validateContextDecisions(
        [{ id: memory.id, action: "range", ranges: [{ charStart: 0, charEnd: 2 }], reason: "bad" }],
        [memory],
      ),
    ).toThrow(AgentOutputValidationError);
    expect(() =>
      validateContextDecisions(
        [{ id: memory.id, action: "omit", reason: "irrelevant", unexpected: true }],
        [memory],
      ),
    ).toThrow(AgentOutputValidationError);
  });

  it("rejects unknown fields in topic packets before semantic validation", () => {
    expect(() =>
      validateTopicPacket(
        {
          topicId: "t1",
          status: "partial",
          claims: [],
          gaps: ["not enough evidence"],
          unexpected: true,
        } as unknown as TopicPacket,
        "t1",
        [],
      ),
    ).toThrow(AgentOutputValidationError);
  });

  it("constrains topic claims to the branch-visible source namespace", () => {
    const packet: TopicPacket = {
      topicId: "t1",
      status: "answered",
      claims: [{ text: "Supported", sourceKeys: ["k_nonce_1"] }],
      gaps: [],
    };
    expect(validateTopicPacket(packet, "t1", ["k_nonce_1"])).toBe(packet);
    expect(() => validateTopicPacket(packet, "t1", ["k_nonce_2"])).toThrow(
      AgentOutputValidationError,
    );
    expect(() =>
      validateTopicPacket({ ...packet, status: "answered", claims: [] }, "t1", []),
    ).toThrow(AgentOutputValidationError);
    expect(() =>
      validateTopicPacket({ ...packet, claims: [], gaps: [] }, "t1", ["k_nonce_1"]),
    ).toThrow("answered packet must contain at least one claim");
    expect(() =>
      validateTopicPacket({ ...packet, status: "partial", claims: [], gaps: ["  "] }, "t1", [
        "k_nonce_1",
      ]),
    ).toThrow("gap 1 is empty");
  });

  it("normalizes zero-to-many memories and snapshots update heads", () => {
    const active: readonly MemorySnapshot[] = [
      {
        memoryId: "memory-1",
        memoryRevisionId: "revision-1",
        kind: "profile",
        content: "Lives in Paris",
      },
    ];
    expect(
      validateMemoryProposals(
        [
          { kind: "profile", content: "Lives in Paris" },
          { kind: "profile", content: "  Lives in Lyon ", targetMemoryId: "memory-1" },
          { kind: "fact", content: "", targetMemoryId: "foreign" },
        ],
        active,
      ),
    ).toEqual({
      proposals: [
        {
          kind: "profile",
          content: "Lives in Lyon",
          targetMemoryId: "memory-1",
          expectedHeadRevisionId: "revision-1",
        },
      ],
      discardedCount: 2,
    });
    expect(() =>
      validateMemoryProposals(
        [
          { kind: "profile", content: "One", targetMemoryId: "memory-1" },
          { kind: "profile", content: "Two", targetMemoryId: "memory-1" },
        ],
        active,
      ),
    ).toThrow(AgentOutputValidationError);
    expect(() =>
      validateMemoryProposals(
        [
          { kind: "profile", content: "Same", targetMemoryId: "memory-1" },
          { kind: "profile", content: "Same", targetMemoryId: "memory-1" },
        ],
        active,
      ),
    ).toThrow(AgentOutputValidationError);
  });
});
