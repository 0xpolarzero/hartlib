import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  AI_WEB_MAX_DOMAIN_FILTERS_DEFAULT,
  AI_WEB_MAX_DOMAIN_FILTERS_HARD_MAX,
  AiRunActivityFailureCode,
  AiRunEvent,
  activityCodeForAiRunError,
  activityCodeForPhase,
  emptyAiRunActivityProjection,
  failActiveAiRunActivity,
  projectAiRunActivity,
  EffectiveWebPolicy,
  GetChatResponse,
  MemoryRecord,
  PublicSourceRecord,
  ResetProductChatRequest,
  ResetProductChatResponse,
  SendChatMessageRequest,
} from "./chat";

describe("canonical chat schemas", () => {
  it("carries the authoritative write capability for shared-chat viewers", () => {
    const decode = Schema.decodeUnknownSync(GetChatResponse);
    const response = decode({
      chat: {
        id: "chat-1",
        memoryMode: "disabled",
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z",
        archivedAt: null,
      },
      messages: [],
      effectiveWebPolicy: {
        enabled: false,
        reason: "company_disabled",
        allowlistActive: false,
      },
      activeRun: null,
      canWrite: false,
    });
    expect(response.canWrite).toBe(false);
    expect(() => decode({ ...response, canWrite: undefined })).toThrow();
  });

  it("strictly validates chat reset identities and the complete replacement projection", () => {
    const decodeRequest = Schema.decodeUnknownSync(ResetProductChatRequest, {
      onExcessProperty: "error",
    });
    const replacementChatId = "123e4567-e89b-12d3-a456-426614174002";
    expect(decodeRequest({ replacementChatId })).toEqual({ replacementChatId });
    expect(() => decodeRequest({ replacementChatId: replacementChatId.toUpperCase() })).toThrow();
    expect(() => decodeRequest({ replacementChatId: "not-a-uuid" })).toThrow();
    expect(() => decodeRequest({ replacementChatId, extra: true })).toThrow();

    const decodeResponse = Schema.decodeUnknownSync(ResetProductChatResponse, {
      onExcessProperty: "error",
    });
    const replacement = Schema.decodeUnknownSync(GetChatResponse)({
      chat: {
        id: replacementChatId,
        memoryMode: "disabled",
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z",
        archivedAt: null,
      },
      messages: [],
      effectiveWebPolicy: {
        enabled: false,
        reason: "company_disabled",
        allowlistActive: false,
      },
      activeRun: null,
      canWrite: true,
    });
    expect(
      decodeResponse({
        archivedChatId: "123e4567-e89b-12d3-a456-426614174001",
        replacement,
      }),
    ).toMatchObject({ archivedChatId: "123e4567-e89b-12d3-a456-426614174001" });
    expect(() =>
      decodeResponse({
        archivedChatId: "123e4567-e89b-12d3-a456-426614174001",
        replacement: { ...replacement, extra: true },
      }),
    ).toThrow();
    expect(() =>
      decodeResponse({
        archivedChatId: "123e4567-e89b-12d3-a456-426614174001",
        replacement: { ...replacement, canWrite: false },
      }),
    ).toThrow();
  });

  it("exports the shared code-owned web-domain fanout bounds", () => {
    expect(AI_WEB_MAX_DOMAIN_FILTERS_DEFAULT).toBe(8);
    expect(AI_WEB_MAX_DOMAIN_FILTERS_HARD_MAX).toBe(32);
  });

  it("decodes both exact effective web policy variants", () => {
    const decode = Schema.decodeUnknownSync(EffectiveWebPolicy);
    expect(decode({ enabled: false, reason: "company_disabled", allowlistActive: true })).toEqual({
      enabled: false,
      reason: "company_disabled",
      allowlistActive: true,
    });
    expect(decode({ enabled: true, provider: "tinyfish", allowedDomains: ["gouv.fr"] })).toEqual({
      enabled: true,
      provider: "tinyfish",
      allowedDomains: ["gouv.fr"],
    });
    expect(() =>
      decode({ enabled: false, reason: "not_configured", allowlistActive: false }),
    ).toThrow();
  });

  it("accepts locale and market as independently valid values", () => {
    expect(
      Schema.decodeUnknownSync(SendChatMessageRequest)({
        text: "Question",
        locale: "fr-FR",
        market: "US",
        webSearchEnabled: false,
      }),
    ).toMatchObject({ locale: "fr-FR", market: "US" });
    const decode = Schema.decodeUnknownSync(SendChatMessageRequest, {
      onExcessProperty: "error",
    });
    expect(() =>
      decode({ text: "   ", locale: "fr-FR", market: "FR", webSearchEnabled: false }),
    ).toThrow();
    expect(() =>
      decode({
        text: "Question",
        locale: "fr-FR",
        market: "FR",
        webSearchEnabled: false,
        unexpected: true,
      }),
    ).toThrow();
  });

  it("requires complete immutable public source provenance by kind", () => {
    const decode = Schema.decodeUnknownSync(PublicSourceRecord);
    expect(
      decode({
        sourceKey: "k_nonce_1",
        label: null,
        tokenCount: 10,
        topicIds: ["t1"],
        kind: "memory",
        memoryId: "memory-1",
        memoryRevisionId: "revision-1",
        ranges: [],
      }),
    ).toMatchObject({ kind: "memory", memoryRevisionId: "revision-1" });
    expect(() =>
      decode({
        sourceKey: "k_nonce_1",
        label: null,
        tokenCount: 10,
        topicIds: [],
        kind: "document",
        documentTitle: "Missing URL",
        ranges: [],
      }),
    ).toThrow();
  });

  it("rejects legacy or incomplete SSE events", () => {
    const decode = Schema.decodeUnknownSync(AiRunEvent);
    expect(() => decode({ type: "context_window", blocks: [] })).toThrow();
    expect(() => decode({ type: "answer_started", attempt: 1 })).toThrow();
    expect(decode({ type: "answer_started", mode: "synthesis", attempt: 2 })).toEqual({
      type: "answer_started",
      mode: "synthesis",
      attempt: 2,
    });
  });

  it("strictly decodes the canonical public context payload at every nesting level", () => {
    const decode = Schema.decodeUnknownSync(AiRunEvent, { onExcessProperty: "error" });
    const contextReady = {
      type: "context_ready",
      mode: "single",
      compactionRan: false,
      sourcesRead: [
        {
          sourceKey: "k_nonce_1",
          label: "Source",
          tokenCount: 7,
          topicIds: [],
          kind: "memory",
          memoryId: "memory-1",
          memoryRevisionId: "revision-1",
          ranges: [],
        },
      ],
      consumers: [
        {
          consumer: "direct",
          inputTokens: 123,
          requestedOutputTokens: 32,
          usableInputTokens: 10_000,
        },
      ],
    } as const;
    expect(decode(contextReady)).toEqual(contextReady);
    expect(() =>
      decode({
        ...contextReady,
        consumers: [{ ...contextReady.consumers[0], forged: true }],
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...contextReady,
        sourcesRead: [{ ...contextReady.sourcesRead[0], forged: true }],
      }),
    ).toThrow();
  });

  it("strictly decodes safe activity progress and rejects opaque fields", () => {
    const decode = Schema.decodeUnknownSync(AiRunEvent, { onExcessProperty: "error" });
    const activity = {
      type: "activity",
      stage: "evidence",
      code: "web_research",
      status: "retrying",
      topicId: "t2",
      attempt: 2,
      durationMs: 120,
      resultCount: 0,
      reason: "search_adjusted",
      runId: "run-1",
      occurredAt: "2026-08-21T19:05:56.810Z",
      errorCode: "plan_turn_failed",
      errorCategory: "provider_transport",
      errorMessage: "The model provider did not return a response.",
    } as const;
    expect(decode(activity)).toEqual(activity);
    expect(() => decode({ ...activity, rawQuery: "private query" })).toThrow();
    expect(() => decode({ ...activity, code: "provider_internal_operation" })).toThrow();
    expect(() => decode({ ...activity, runId: "run secret" })).toThrow();
    expect(() => decode({ ...activity, occurredAt: "not-a-timestamp" })).toThrow();
    expect(() => decode({ ...activity, attempt: -1 })).toThrow();
    expect(() => decode({ ...activity, attempt: 100_001 })).toThrow();
    expect(() =>
      decode({
        ...activity,
        errorMessage: "x".repeat(513),
      }),
    ).toThrow();
    expect(
      decode({
        type: "error",
        code: "plan_turn_failed",
        retryable: true,
        runId: "run-1",
        stage: "understanding",
        attempt: 3,
        occurredAt: "2026-08-21T19:05:58.509Z",
        errorCategory: "provider_transport",
        errorMessage: "The model provider did not return a response.",
      }),
    ).toMatchObject({ type: "error", errorCategory: "provider_transport" });
  });

  it("projects retrieval and compaction failures to preparation or evidence activities", () => {
    const decode = Schema.decodeUnknownSync(AiRunActivityFailureCode);
    expect(decode("context_compaction_failed")).toBe("context_compaction_failed");
    expect(activityCodeForAiRunError("context_plan_unfit")).toBe("context_preparation");
    expect(activityCodeForAiRunError("internal_retrieval_failed")).toBe("internal_sources");
    expect(activityCodeForPhase("context_compaction_plan")).toBe("context_preparation");
    expect(activityCodeForPhase("context_compaction_fallback_measure")).toBe("context_preparation");
    expect(() => decode("provider_internal_operation")).toThrow();
  });

  it("keeps one current activity per key while replaying each transition once", () => {
    const running = {
      type: "activity" as const,
      stage: "evidence" as const,
      code: "internal_sources" as const,
      status: "running" as const,
      attempt: 1,
    };
    const complete = { ...running, status: "complete" as const, durationMs: 120 };
    let projection = projectAiRunActivity(emptyAiRunActivityProjection(), running);
    projection = projectAiRunActivity(projection, complete);
    projection = projectAiRunActivity(projection, complete);
    expect(projection.activities).toEqual([complete]);
    expect(projection.history).toEqual([running, complete]);
  });

  it("keeps a repeated transition when it occurs again after another state", () => {
    const running = {
      type: "activity" as const,
      stage: "evidence" as const,
      code: "internal_sources" as const,
      status: "running" as const,
    };
    const complete = { ...running, status: "complete" as const };
    let projection = projectAiRunActivity(emptyAiRunActivityProjection(), running);
    projection = projectAiRunActivity(projection, complete);
    projection = projectAiRunActivity(projection, running);
    expect(projection.history).toEqual([running, complete, running]);
  });

  it("fails the activity from the latest active transition", () => {
    const first = {
      type: "activity" as const,
      stage: "evidence" as const,
      code: "internal_sources" as const,
      status: "running" as const,
    };
    const second = {
      type: "activity" as const,
      stage: "preparing" as const,
      code: "context_preparation" as const,
      status: "running" as const,
    };
    let projection = projectAiRunActivity(emptyAiRunActivityProjection(), first);
    projection = projectAiRunActivity(projection, second);
    projection = projectAiRunActivity(projection, { ...first, status: "retrying" });
    const failed = failActiveAiRunActivity(projection);
    expect(failed.activities).toEqual([{ ...first, status: "failed" }, second]);
  });

  it("does not expose chat message ranges in public source records", () => {
    const decode = Schema.decodeUnknownSync(PublicSourceRecord);
    const chatSource = {
      sourceKey: "k_nonce_chat",
      label: null,
      tokenCount: 10,
      topicIds: [],
      kind: "chat_message",
      messageId: "message-1",
      ranges: [],
    } as const;
    expect(decode(chatSource)).toEqual(chatSource);
    expect(() => decode({ ...chatSource, ranges: [{ charStart: 0, charEnd: 3 }] })).toThrow();
  });

  it("does not expose low-level provider calls as answer progress", () => {
    expect(activityCodeForPhase("provider_call")).toBeUndefined();
    expect(activityCodeForPhase("direct_answer_call")).toBe("answer_generation");
  });

  it("models append-only memory revisions with an exact current head", () => {
    const decoded = Schema.decodeUnknownSync(MemoryRecord)({
      id: "memory-1",
      headRevisionId: "revision-2",
      current: { kind: "preference", content: "Concise", deleted: false },
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:01:00.000Z",
      revisions: [
        {
          id: "revision-1",
          action: "create",
          before: null,
          after: { kind: "preference", content: "Detailed", deleted: false },
          createdAt: "2026-07-10T00:00:00.000Z",
        },
        {
          id: "revision-2",
          action: "update",
          before: { kind: "preference", content: "Detailed", deleted: false },
          after: { kind: "preference", content: "Concise", deleted: false },
          createdAt: "2026-07-10T00:01:00.000Z",
        },
      ],
    });
    expect(decoded.headRevisionId).toBe("revision-2");
  });
});
