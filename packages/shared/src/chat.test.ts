import { describe, expect, it } from "vitest";

import {
  AiRunActivityEvent,
  PublicCitationRecord,
  UserMessageRunOutcome,
  makeRunAcceptanceScope,
  aiRunActivityTransitionKey,
  parseRunAcceptanceScope,
} from "./chat";
import { Schema } from "effect";

describe("singular chat contracts", () => {
  it("accepts exactly the final acceptance scope", () => {
    const scope = makeRunAcceptanceScope({
      userId: "visitor",
      chatId: "00000000-0000-4000-8000-000000000001",
      companyId: "00000000-0000-4000-8000-000000000002",
    });
    expect(scope).toEqual(
      expect.objectContaining({
        userId: "visitor",
        publicSourceIds: [],
        memoryRevisionIds: [],
        webRequested: false,
        webEnabled: false,
        webTransportProvider: null,
        allowedDomains: null,
      }),
    );
    expect(() => parseRunAcceptanceScope({ ...scope, unexpectedField: [] } as unknown)).toThrow();
  });

  it("requires a canonical quote object or null", () => {
    expect(
      Schema.decodeUnknownSync(PublicCitationRecord)({
        sourceKey: "k_cn_1234567890123456789012_1",
        label: null,
        kind: "web",
        title: "Example",
        domain: "example.com",
        url: "https://example.com/a",
        capturedAt: "2026-01-01T00:00:00Z",
        ranges: [],
        quote: { text: "Evidence" },
      }),
    ).toMatchObject({ quote: { text: "Evidence" } });
    expect(() =>
      Schema.decodeUnknownSync(PublicCitationRecord)({
        sourceKey: "k_cn_1234567890123456789012_1",
        label: null,
        kind: "web",
        title: "Example",
        domain: "example.com",
        url: "https://example.com/a",
        capturedAt: "2026-01-01T00:00:00Z",
        ranges: [],
        quote: "legacy",
      }),
    ).toThrow();
  });

  it("projects a stopped run outcome", () => {
    expect(
      Schema.decodeUnknownSync(UserMessageRunOutcome)({
        id: "run",
        status: "stopped",
        stoppedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      id: "run",
      status: "stopped",
      stoppedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("accepts strict recorded activity details and rejects captions", () => {
    const decodeActivity = Schema.decodeUnknownSync(AiRunActivityEvent, {
      onExcessProperty: "error",
    });
    const event = decodeActivity({
      type: "activity",
      stage: "evidence",
      code: "web_research",
      status: "complete",
      occurredAt: "2026-05-12T10:00:00.000Z",
      detail: {
        kind: "web_search",
        ordinal: 1,
        query: "site:example.com exact query",
        resultCount: 3,
      },
    });
    expect(event.detail).toMatchObject({
      kind: "web_search",
      query: "site:example.com exact query",
      resultCount: 3,
    });
    expect(() =>
      decodeActivity({
        ...event,
        detail: { ...event.detail, label: "Cross-checking claims" },
      }),
    ).toThrow();
  });

  it("keeps separate recorded tool actions in activity history", () => {
    const decodeActivity = Schema.decodeUnknownSync(AiRunActivityEvent, {
      onExcessProperty: "error",
    });
    const first = decodeActivity({
      type: "activity",
      stage: "evidence",
      code: "web_research",
      status: "complete",
      detail: { kind: "web_search", ordinal: 1, query: "first" },
    });
    const second = decodeActivity({
      ...first,
      detail: { kind: "web_search", ordinal: 2, query: "second" },
    });
    expect(aiRunActivityTransitionKey(first)).not.toBe(aiRunActivityTransitionKey(second));
  });
});
