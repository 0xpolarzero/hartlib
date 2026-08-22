import { describe, expect, it } from "vitest";

import {
  compileChatMessagesQuery,
  compilePhysicalQueryBranches,
  compilePublisherDocumentsQuery,
  compilePublicDocumentsQuery,
} from "./compile-query-spec";
import { PHYSICAL_QUERY_BRANCHES } from "./query-spec";

const scope = {
  userId: "user-1",
  chatId: "chat-1",
  companyId: "company-1",
  publicSourceIds: ["public-source"],
  subscriptionIds: ["subscription-1"],
  accessIds: ["access-1"],
  excludedMessageIds: ["recent-1"],
} as const;

const query = {
  purpose: "Find storage evidence",
  targets: [
    {
      kind: "documents" as const,
      filters: {
        sourceNames: ["Saved Source"],
        languages: ["en-US"],
        publishedAt: {
          after: "2026-01-01T00:00:00.000Z",
          before: "2026-02-01T00:00:00.000Z",
        },
      },
    },
    { kind: "chat_messages" as const, filters: { authors: ["user" as const] } },
  ],
  all: [{ text: "storage", mode: "term" as const }],
  anyOf: [[{ text: "battery", mode: "phrase" as const }]],
  not: [{ text: "residential", mode: "term" as const }],
  order: "relevance" as const,
};

const options = { scope, branchCap: 3 } as const;

const literalSql = (statement: { readonly segments: readonly unknown[] } | undefined): string =>
  statement?.segments
    .map((segment) =>
      typeof segment === "object" &&
      segment !== null &&
      "_tag" in segment &&
      segment._tag === "Literal"
        ? String((segment as unknown as { readonly value: unknown }).value)
        : "",
    )
    .join("") ?? "";

const parameterValues = (
  statement: { readonly segments: readonly unknown[] } | undefined,
): readonly unknown[] =>
  statement?.segments.flatMap((segment) =>
    typeof segment === "object" &&
    segment !== null &&
    "_tag" in segment &&
    segment._tag === "Parameter"
      ? [(segment as unknown as { readonly value: unknown }).value]
      : [],
  ) ?? [];

describe("Phase B physical compilers", () => {
  it("uses the canonical physical branch order", () => {
    const branches = compilePhysicalQueryBranches(query, options);
    expect(branches.map((branch) => branch.branch)).toEqual(PHYSICAL_QUERY_BRANCHES);
    expect(branches.map((branch) => branch.status)).toEqual([
      "applicable",
      "applicable",
      "applicable",
    ]);
  });

  it("marks unlisted target branches and unsupported publisher filters without SQL", () => {
    const documentQuery = {
      ...query,
      targets: [query.targets[0]!],
    };
    expect(compileChatMessagesQuery(documentQuery, options)).toMatchObject({
      branch: "chat_messages",
      status: "not_applicable",
      reason: "scope_documents",
    });
    const chatQuery = {
      ...query,
      targets: [query.targets[1]!],
    };
    expect(compilePublicDocumentsQuery(chatQuery, options)).toMatchObject({
      branch: "public_documents",
      status: "not_applicable",
      reason: "scope_chat_messages",
    });
    const countryQuery = {
      ...query,
      targets: [
        {
          kind: "documents" as const,
          filters: { countries: ["FR"] },
        },
      ],
    };
    expect(compilePublisherDocumentsQuery(countryQuery, options)).toMatchObject({
      branch: "publisher_documents",
      status: "not_applicable",
      reason: "unsupported_country_filter",
    });
  });

  it("uses indexed chat FTS with sanitized previews and accepted-chat authorization", () => {
    const compiled = compilePublicDocumentsQuery(query, options);
    expect(compiled.statement).toBeDefined();
    const publicText = compiled.statement?.segments
      .map((segment) => (segment._tag === "Literal" ? segment.value : ""))
      .join("");
    expect(publicText).toContain("public_source_documents");

    const chat = compileChatMessagesQuery(query, options);
    expect(chat.statement).toBeDefined();
    const chatText = chat.statement?.segments
      .map((segment) => (segment._tag === "Literal" ? segment.value : ""))
      .join("");
    expect(chatText).toContain("m.search_vector @@");
    expect(chatText).toContain("ts_rank_cd(m.search_vector");
    expect(chatText).toContain("plainto_tsquery('simple'");
    expect(chatText).toContain("phraseto_tsquery('simple'");
    expect(chatText).toContain("encode(digest(convert_to(sanitized_chat_content");
    expect(chatText).toContain("left(sanitized_chat_content, 512)");
    expect(chatText).toContain("length(sanitized_chat_content)");
    expect(chatText).toContain("hartlib_ai_strip_historical_citation_tags(m.content)");
    expect(chatText).not.toContain("regexp_replace");
    expect(chatText).toContain("m.chat_id = ");
    expect(chatText).toContain("c.company_id = ");
    expect(chatText).toContain("memberships.user_id = ");
    expect(chatText).toContain("memberships.revoked_at is null");
    expect(chatText).toContain("m.id::text not in (");
    const boundedChat = compileChatMessagesQuery(query, {
      ...options,
      scope: { ...scope, currentMessageId: "current-message" },
    });
    const boundedText = boundedChat.statement?.segments
      .map((segment) => (segment._tag === "Literal" ? segment.value : ""))
      .join("");
    expect(boundedText).toContain("join chat_messages current_message on current_message.id = ");
    expect(boundedText).toContain("current_message.chat_id = m.chat_id");
    expect(boundedText).toContain(
      "(m.created_at, m.id) < (current_message.created_at, current_message.id)",
    );
  });

  it("preserves the reported UTC freshness window and compiles every bound as [after, before)", () => {
    const after = "2026-08-15T14:12:48.063Z";
    const before = "2026-08-16T14:12:48.063Z";
    const bounded = {
      ...query,
      targets: [
        { kind: "documents" as const, filters: { publishedAt: { after, before } } },
        { kind: "chat_messages" as const, filters: { sentAt: { after, before } } },
      ],
      order: "newest" as const,
    };
    const compiled = [
      compilePublicDocumentsQuery(bounded, options),
      compilePublisherDocumentsQuery(bounded, options),
      compileChatMessagesQuery(bounded, options),
    ] as const;

    for (const branch of compiled) {
      expect(parameterValues(branch.statement)).toContain(after);
      expect(parameterValues(branch.statement)).toContain(before);
      expect(parameterValues(branch.statement)).not.toContainEqual(expect.any(Date));
      expect(literalSql(branch.statement)).toContain("::timestamptz");
    }

    const publicSql = literalSql(compiled[0].statement);
    expect(publicSql).toContain("d.published_at >= ");
    expect(publicSql).toContain("d.published_at < ");
    expect(publicSql).not.toContain("d.published_at <= ");

    const publisherSql = literalSql(compiled[1].statement);
    expect(publisherSql).toContain("issues.published_at >= ");
    expect(publisherSql).toContain("issues.published_at < ");
    expect(publisherSql).not.toContain("issues.published_at <= ");

    const chatSql = literalSql(compiled[2].statement);
    expect(chatSql).toContain("m.created_at >= ");
    expect(chatSql).toContain("m.created_at < ");
    expect(chatSql).not.toContain("m.created_at <= ");
  });
});
