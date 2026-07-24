import { describe, expect, it } from "vitest";

import {
  chatMessagesResponseFromRows,
  creditLimitReached,
  effectiveWebPolicy,
  normalizeDomainAllowlist,
} from "../domain/chat";

const at = (value: string) => new Date(value);
const citationNamespace = "cn_" + "A".repeat(22);
const citationNamespaceHex = citationNamespace;
const documentSourceId = "public:test-source";
const documentId = "test-document";
const versionId = "test-document-version";
const documentContentHash = "a".repeat(64);

describe("creditLimitReached", () => {
  it("compares PostgreSQL bigint values without losing precision", () => {
    expect(creditLimitReached("9007199254740992", "9007199254740993")).toBe(false);
    expect(creditLimitReached("9007199254740993", "9007199254740993")).toBe(true);
    expect(creditLimitReached(1n, null)).toBe(false);
    expect(() => creditLimitReached(Number.MAX_SAFE_INTEGER + 1, 1n)).toThrow(
      "unsafe_database_integer",
    );
  });
});

describe("effectiveWebPolicy", () => {
  it("uses canonical precedence and normalizes a stable allowlist", () => {
    expect(
      effectiveWebPolicy({
        companyEnabled: false,
        allowedDomains: ["GOUV.FR."],
        adapterAvailable: false,
        provider: null,
        allowlistSupported: false,
        maxDomainFilters: 8,
      }),
    ).toEqual({ enabled: false, reason: "company_disabled", allowlistActive: true });
    expect(
      effectiveWebPolicy({
        companyEnabled: true,
        allowedDomains: null,
        adapterAvailable: false,
        provider: null,
        allowlistSupported: false,
        maxDomainFilters: 8,
      }),
    ).toEqual({ enabled: false, reason: "deployment_unavailable", allowlistActive: false });
    expect(
      effectiveWebPolicy({
        companyEnabled: true,
        allowedDomains: [" Example.COM. ", "example.com", "État.fr"],
        adapterAvailable: true,
        provider: "tinyfish",
        allowlistSupported: true,
        maxDomainFilters: 8,
      }),
    ).toEqual({
      enabled: true,
      provider: "tinyfish",
      allowedDomains: ["example.com", "xn--tat-9la.fr"],
    });
  });

  it("fails closed before acceptance when the normalized allowlist exceeds adapter fanout", () => {
    const overLimit = ["a.example.com", "b.example.com", "c.example.com"];
    expect(
      effectiveWebPolicy({
        companyEnabled: false,
        allowedDomains: overLimit,
        adapterAvailable: true,
        provider: "tinyfish",
        allowlistSupported: true,
        maxDomainFilters: 2,
      }),
    ).toEqual({ enabled: false, reason: "company_disabled", allowlistActive: true });
    expect(
      effectiveWebPolicy({
        companyEnabled: true,
        allowedDomains: overLimit,
        adapterAvailable: false,
        provider: null,
        allowlistSupported: true,
        maxDomainFilters: 2,
      }),
    ).toEqual({ enabled: false, reason: "deployment_unavailable", allowlistActive: true });
    expect(
      effectiveWebPolicy({
        companyEnabled: true,
        allowedDomains: overLimit,
        adapterAvailable: true,
        provider: "tinyfish",
        allowlistSupported: true,
        maxDomainFilters: 2,
      }),
    ).toEqual({ enabled: false, reason: "allowlist_unsupported", allowlistActive: true });

    expect(
      effectiveWebPolicy({
        companyEnabled: true,
        allowedDomains: ["a.example.com", "A.EXAMPLE.COM.", "b.example.com"],
        adapterAvailable: true,
        provider: "tinyfish",
        allowlistSupported: true,
        maxDomainFilters: 2,
      }),
    ).toEqual({
      enabled: true,
      provider: "tinyfish",
      allowedDomains: ["a.example.com", "b.example.com"],
    });
  });

  it.each([
    "https://example.com",
    "example.com:443",
    "example.com/path",
    "*.example.com",
    "localhost",
    "service.local",
    "service.corp",
    "router.lan",
    "127.0.0.1",
    "127.1",
    "[::1]",
    "single-label",
    "bad_label.example",
  ])("fails closed for unsafe allowlist entry %s", (domain) => {
    expect(normalizeDomainAllowlist([domain])).toEqual({ ok: false });
  });
});

describe("chatMessagesResponseFromRows", () => {
  it("projects durable run outcomes and immutable source/citation records", () => {
    const response = chatMessagesResponseFromRows(
      [
        {
          id: "user-message",
          author: "user",
          content: "What changed?",
          created_at: at("2026-07-10T10:00:00.000Z"),
        },
        {
          id: "assistant-message",
          author: "assistant",
          content: `A claim [[cite:k_${citationNamespace}_1]]. Unknown [[cite:k_unknown]].`,
          created_at: at("2026-07-10T10:00:02.000Z"),
        },
      ],
      [
        {
          id: "run-1",
          chat_id: "chat-1",
          user_message_id: "user-message",
          assistant_message_id: "assistant-message",
          started_at: at("2026-07-10T10:00:01.000Z"),
          finished_at: at("2026-07-10T10:00:03.000Z"),
          failed_at: null,
          error_code: null,
          retryable: null,
        },
      ],
      [
        {
          assistant_message_id: "assistant-message",
          source_key: `k_${citationNamespace}_1`,
          citation_namespace: citationNamespaceHex,
          publisher_extraction_id: null,
          source_id: documentSourceId,
          document_id: documentId,
          version_id: versionId,
          content_hash: documentContentHash,
          canonical_url: "https://example.com/document",
          kind: "document",
          locator: {
            kind: "document",
            sourceId: documentSourceId,
            documentId,
            versionId,
            contentHash: documentContentHash,
            ranges: [{ pageNumber: 2, charStart: 10, charEnd: 50 }],
          },
          display_label: "Official source",
          public_provenance: {
            sourceName: "DILA",
            issueTitle: "Issue",
            documentTitle: "Document",
            citationUrl: "https://example.com/document",
            publishedAt: "2026-07-09T00:00:00.000Z",
          },
        },
      ],
      [
        {
          assistant_message_id: "assistant-message",
          source_key: `k_${citationNamespace}_1`,
          topic_id: "t2",
          consumer_task_id: "topic-t2-answer",
          rendered_token_count: 40,
          context_order: 0,
          ranges: [{ pageNumber: 2, charStart: 30, charEnd: 50 }],
        },
        {
          assistant_message_id: "assistant-message",
          source_key: `k_${citationNamespace}_1`,
          topic_id: "t1",
          consumer_task_id: "topic-t1-answer",
          rendered_token_count: 60,
          context_order: 0,
          ranges: [{ pageNumber: 2, charStart: 10, charEnd: 30 }],
        },
      ],
    );

    expect(response[0]).toMatchObject({
      author: "user",
      run: { id: "run-1", status: "succeeded" },
    });
    expect(response[1]).toMatchObject({
      author: "assistant",
      citations: [{ sourceKey: `k_${citationNamespace}_1`, kind: "document" }],
      sourcesRead: [
        {
          sourceKey: `k_${citationNamespace}_1`,
          kind: "document",
          tokenCount: 100,
          topicIds: ["t1", "t2"],
          ranges: [{ pageNumber: 2, charStart: 10, charEnd: 50 }],
        },
      ],
    });
  });

  it("reloads sources by numeric ordinal and rejects malformed or non-HTTPS provenance", () => {
    const sourceRow = (sourceKey: string, citationUrl = "https://example.com/document") => ({
      assistant_message_id: "assistant-message",
      source_key: sourceKey,
      citation_namespace: citationNamespaceHex,
      publisher_extraction_id: null,
      source_id: documentSourceId,
      document_id: documentId,
      version_id: versionId,
      content_hash: documentContentHash,
      canonical_url: "https://example.com/document",
      kind: "document" as const,
      locator: {
        kind: "document",
        sourceId: documentSourceId,
        documentId,
        versionId,
        contentHash: documentContentHash,
        ranges: [{ charStart: 0, charEnd: 8 }],
      },
      display_label: sourceKey,
      public_provenance: { documentTitle: sourceKey, citationUrl },
    });
    const useRow = (sourceKey: string, context_order: number) => ({
      assistant_message_id: "assistant-message",
      source_key: sourceKey,
      consumer_task_id: "single-answer",
      topic_id: null,
      rendered_token_count: 1,
      context_order,
      ranges: [{ charStart: 0, charEnd: 8 }],
    });
    const projected = chatMessagesResponseFromRows(
      [
        {
          id: "assistant-message",
          author: "assistant",
          content: "answer",
          created_at: at("2026-07-10T10:00:00.000Z"),
        },
      ],
      [],
      [
        sourceRow(`k_${citationNamespace}_10`),
        sourceRow(`k_${citationNamespace}_2`),
        sourceRow(`k_${citationNamespace}_11`),
      ],
      [
        useRow(`k_${citationNamespace}_10`, 1),
        useRow(`k_${citationNamespace}_2`, 0),
        useRow(`k_${citationNamespace}_11`, 2),
      ],
    );
    expect(
      (projected[0] as { sourcesRead: readonly { sourceKey: string }[] }).sourcesRead.map(
        (source) => source.sourceKey,
      ),
    ).toEqual([
      `k_${citationNamespace}_2`,
      `k_${citationNamespace}_10`,
      `k_${citationNamespace}_11`,
    ]);

    expect(() =>
      chatMessagesResponseFromRows(
        [
          {
            id: "assistant-message",
            author: "assistant",
            content: "answer",
            created_at: at("2026-07-10T10:00:00.000Z"),
          },
        ],
        [],
        [sourceRow(`k_${citationNamespace}_bad`)],
        [useRow(`k_${citationNamespace}_bad`, 0)],
      ),
    ).toThrow("invalid persisted source key");
    expect(() =>
      chatMessagesResponseFromRows(
        [
          {
            id: "assistant-message",
            author: "assistant",
            content: "answer",
            created_at: at("2026-07-10T10:00:00.000Z"),
          },
        ],
        [],
        [sourceRow(`k_${citationNamespace}_1`, "http://example.com/document")],
        [useRow(`k_${citationNamespace}_1`, 0)],
      ),
    ).toThrow("invalid persisted source citationUrl");
  });
});
