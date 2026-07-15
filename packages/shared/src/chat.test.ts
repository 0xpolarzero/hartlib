import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  AI_WEB_MAX_DOMAIN_FILTERS_DEFAULT,
  AI_WEB_MAX_DOMAIN_FILTERS_HARD_MAX,
  AiRunEvent,
  EffectiveWebPolicy,
  GetChatResponse,
  MemoryRecord,
  PublicSourceRecord,
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
      reductionRan: false,
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
