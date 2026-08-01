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
  all: [{ text: "storage", mode: "term" as const }],
  anyOf: [[{ text: "battery", mode: "phrase" as const }]],
  not: [{ text: "residential", mode: "term" as const }],
  filters: {
    documents: {
      sourceNames: ["Saved Source"],
      languages: ["en-US"],
      publishedAt: { after: "2026-01-01", before: "2026-02-01" },
    },
    chatMessages: { authors: ["user" as const] },
  },
  order: "relevance" as const,
};

const options = { scope, branchCap: 3 } as const;

describe("Phase B physical compilers", () => {
  it("uses the canonical physical branch order", () => {
    expect(compilePhysicalQueryBranches(query, options).map((branch) => branch.branch)).toEqual(
      PHYSICAL_QUERY_BRANCHES,
    );
  });

  it("marks scoped branches and unsupported publisher filters without SQL", () => {
    const documentQuery = { ...query, scope: "documents" as const };
    expect(compileChatMessagesQuery(documentQuery, options)).toMatchObject({
      branch: "chat_messages",
      status: "not_applicable",
      reason: "scope_documents",
    });
    const countryQuery = {
      ...query,
      filters: { ...query.filters, documents: { countries: ["FR"] } },
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
    expect(chatText).toContain("brief_ai_strip_historical_citation_tags(m.content)");
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
});
