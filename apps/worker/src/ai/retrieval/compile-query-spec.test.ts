import { PgClient } from "@effect/sql-pg";
import { describe, expect, it } from "vitest";

import {
  buildSourceAccessClause,
  compileQuerySpec,
  compileChatMessagesQuery,
  compilePhysicalQueryBranches,
  compilePublisherDocumentsQuery,
  compilePublicDocumentsQuery,
  InvalidQuerySpecError,
  resolveAcceptedSourceNames,
} from "./compile-query-spec";
import type { CompileQuerySpecOptions } from "./compile-query-spec";
import type { QuerySpec } from "./query-spec";

const compiler = PgClient.makeCompiler();

const compile = (spec: QuerySpec, overrides?: Partial<CompileQuerySpecOptions>) =>
  compiler.compile(
    compileQuerySpec(spec, {
      access: { kind: "sourceIds", sourceIds: ["authorized-test-source"] },
      maxLimit: 20,
      recencyHalfLifeDays: 14,
      now: new Date("2026-07-08T00:00:00.000Z"),
      ...overrides,
    }),
    false,
  );

const maxPlaceholder = (text: string): number => {
  const placeholderRegex = /\$(\d+)/g;
  let max = 0;
  let match: RegExpExecArray | null = placeholderRegex.exec(text);

  while (match !== null) {
    const index = Number(match[1] ?? 0);
    max = Math.max(max, index);
    match = placeholderRegex.exec(text);
  }

  return max;
};

describe("compileQuerySpec", () => {
  it("emits a dual-language union when languages are absent", () => {
    const [text, params] = compile({ terms: "inflation" });

    expect(text).toContain("websearch_to_tsquery('french', $");
    expect(text).toContain("websearch_to_tsquery('english', $");
    expect(text).toContain("distinct on (d.content_hash)");
    expect(text).toContain("join public_sources s on s.source_id = d.source_id");
    expect(text).toContain("ts_rank_cd");
    expect(text).toContain("power(0.5");
    expect(text).toContain("order by score desc, document_id asc");
    expect(text).toMatch(/limit \$/);
    expect(params).toContain("inflation");
    expect(params).toContain(20);
    expect(maxPlaceholder(text)).toBe(params.length);
  });

  it("emits language arms by primary subtag", () => {
    const [text, params] = compile({
      terms: "inflation",
      languages: ["fr-FR", "fr-CA", "EN-us"],
    });

    expect(text).toContain("lower(split_part(d.language, '-', 1)) = $");
    expect(text).toContain("websearch_to_tsquery(language_to_regconfig($");
    expect(params).toContain("fr");
    expect(params).toContain("en");
    expect(params).not.toContain("fr-FR");
    expect(params).not.toContain("fr-ca");
    expect(text).not.toContain("websearch_to_tsquery('french'");
  });

  it("caps limits", () => {
    const [, overMaxParams] = compile({ terms: "x", limit: 50 });
    const [, explicitParams] = compile({ terms: "x", limit: 5 });
    const [, zeroParams] = compile({ terms: "x", limit: 0 });
    const [, overrideParams] = compile({ terms: "x" }, { maxLimit: 7 });

    expect(overMaxParams).toContain(20);
    expect(overMaxParams).not.toContain(50);
    expect(overMaxParams.at(-1)).toBe(20);
    expect(explicitParams).toContain(5);
    expect(explicitParams.at(-1)).toBe(5);
    expect(zeroParams).toContain(1);
    expect(zeroParams.at(-1)).toBe(1);
    expect(overrideParams).toContain(7);
    expect(overrideParams.at(-1)).toBe(7);
  });

  it("orders by relevance by default and recency when requested", () => {
    const [defaultText] = compile({ terms: "x" });
    const [recencyText] = compile({ terms: "x", orderBy: "recency" });

    expect(defaultText).toContain("order by score desc, document_id asc");
    expect(defaultText).toContain("order by d.content_hash, score desc, d.document_id asc");
    expect(recencyText).toContain("order by recency_at desc, document_id asc");
    expect(recencyText).toContain("order by d.content_hash, recency_at desc, d.document_id asc");
  });

  it("returns immutable source text after dedupe and limit", () => {
    const [text] = compile({ terms: "inflation" });
    const selectedIndex = text.indexOf(") selected");

    expect(selectedIndex).toBeGreaterThanOrEqual(0);
    expect(text).not.toContain("ts_headline");
    expect(text).toContain('document_id as "snapshotId"');
    expect(text).toContain('content_hash as "contentHash"');
    expect(text).toContain("text,");
    expect(text).toContain("limit $");
  });

  it("compiles filters to parameterized where clauses", () => {
    const [text, params] = compile({
      terms: "x",
      sourceIds: ["a", "b"],
      countries: ["fr"],
      documentTypes: ["article"],
      publishedAfter: "2026-01-01T00:00:00.000Z",
      publishedBefore: "2026-06-01T00:00:00.000Z",
    });

    expect(text).toContain("d.source_id in ($");
    expect(text).toContain("s.country in ($");
    expect(text).toContain("d.document_type in ($");
    expect(text).toContain("d.published_at >= $");
    expect(text).toContain("d.published_at <= $");
    expect(params).toContain("a");
    expect(params).toContain("b");
    expect(params).toContain("FR");
    expect(params).toContain("article");
    expect(
      params.some(
        (param) => param instanceof Date && param.toISOString() === "2026-01-01T00:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      params.some(
        (param) => param instanceof Date && param.toISOString() === "2026-06-01T00:00:00.000Z",
      ),
    ).toBe(true);
  });

  it("emits no optional clauses for empty filter arrays while retaining caller access", () => {
    const [text] = compile({
      terms: "x",
      sourceIds: [],
      countries: [],
      documentTypes: [],
    });

    expect(text).toContain("d.source_id in");
    expect(text).not.toContain("s.country in");
    expect(text).not.toContain("d.document_type in");
  });

  it("keeps hostile input in params", () => {
    const hostile = "'; drop table public_source_documents; --";
    const hostileSourceId = "ret'; delete from jobs; --";
    const [text, params] = compile({
      terms: hostile,
      sourceIds: [hostileSourceId],
    });

    expect(text.toLowerCase()).not.toContain("drop table");
    expect(text.toLowerCase()).not.toContain("delete from");
    expect(params).toContain(hostile);
    expect(params).toContain(hostileSourceId);
    expect(maxPlaceholder(text)).toBe(params.length);
  });

  it("throws InvalidQuerySpecError for invalid specs", () => {
    expect(() => compile({ terms: "   " })).toThrow(InvalidQuerySpecError);
    expect(() => compile({ terms: "x", publishedAfter: "not-a-date" })).toThrow(
      InvalidQuerySpecError,
    );
    expect(() => compile({ terms: "x", publishedBefore: "2026-13-45" })).toThrow(
      InvalidQuerySpecError,
    );
    expect(() => compile({ terms: "x", limit: Number.NaN })).toThrow(InvalidQuerySpecError);
    expect(() => compile({ terms: "x", limit: Number.POSITIVE_INFINITY })).toThrow(
      InvalidQuerySpecError,
    );
  });

  it("compiles a term-less bounded recency listing without a full-text match clause", () => {
    const [text, params] = compile({
      orderBy: "recency",
      publishedAfter: "2026-07-01T00:00:00.000Z",
    });

    expect(text).not.toContain("@@ websearch_to_tsquery");
    expect(text).toContain("d.published_at >= $");
    expect(text).toContain("order by recency_at desc");
    expect(
      params.some(
        (param) => param instanceof Date && param.toISOString() === "2026-07-01T00:00:00.000Z",
      ),
    ).toBe(true);
  });

  it("accepts a term-less recency listing bounded by sourceIds", () => {
    const [text] = compile({ orderBy: "recency", sourceIds: ["a"] });
    expect(text).not.toContain("@@ websearch_to_tsquery");
    expect(text).toContain("d.source_id in");
  });

  it("rejects a term-less unbounded query and a non-recency term-less listing", () => {
    expect(() => compile({ orderBy: "recency" })).toThrow(InvalidQuerySpecError);
    expect(() => compile({})).toThrow(InvalidQuerySpecError);
    expect(() =>
      compile({ orderBy: "relevance", publishedAfter: "2026-07-01T00:00:00.000Z" }),
    ).toThrow(InvalidQuerySpecError);
  });

  it("builds source access clauses", () => {
    const [sourceIdsText, sourceIdsParams] = compiler.compile(
      buildSourceAccessClause({ kind: "sourceIds", sourceIds: ["s1", "s2"] }),
      false,
    );
    const [emptySourceIdsText, emptySourceIdsParams] = compiler.compile(
      buildSourceAccessClause({ kind: "sourceIds", sourceIds: [] }),
      false,
    );

    expect(sourceIdsText).toBe("d.source_id in ($1,$2)");
    expect(sourceIdsParams).toEqual(["s1", "s2"]);
    expect(emptySourceIdsText).toBe("1 = 0");
    expect(emptySourceIdsParams).toEqual([]);
  });

  it("compiles only the accepted source IDs before ranking", () => {
    const access = { kind: "sourceIds" as const, sourceIds: ["source-saved"] };
    const [text, params] = compiler.compile(buildSourceAccessClause(access), false);

    expect(text).toContain("d.source_id in ($1)");
    expect(text).not.toContain("authorized_");
    expect(params).toEqual(["source-saved"]);

    const [searchText] = compile({ terms: "saved" }, { access });
    expect(searchText).not.toContain("authorized_setting.enabled");
  });

  it("composes access into the statement", () => {
    const [text, params] = compile(
      { terms: "x" },
      { access: { kind: "sourceIds", sourceIds: ["only"] } },
    );

    expect(params).toContain("only");
    expect(text).toContain("d.source_id in ($");
  });

  it("parameterizes now and half-life", () => {
    const [text, params] = compile({ terms: "x" });

    expect(
      params.some(
        (param) => param instanceof Date && param.toISOString() === "2026-07-08T00:00:00.000Z",
      ),
    ).toBe(true);
    expect(params).toContain(14);
    expect(text).toContain("::timestamptz - coalesce(d.published_at, d.discovered_at)");
    expect(text).toContain("/ (86400.0 * $");
  });
});

describe("Phase B physical compilers", () => {
  const scope = {
    userId: "user-1",
    chatId: "chat-1",
    companyId: "company-1",
    publicSourceIds: ["public-source"],
    subscriptionIds: ["subscription-1"],
    accessIds: ["access-1"],
    excludedMessageIds: ["recent-1"],
  } as const;
  const structuredQuery = {
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
    },
    order: "relevance" as const,
  };

  it("resolves only accepted names without an authorization oracle", () => {
    expect(
      resolveAcceptedSourceNames(
        ["saved source", "foreign source"],
        { publicSourceIds: ["public-source"], subscriptionIds: ["subscription-1"] },
        {
          publicSources: [{ sourceId: "public-source", displayName: "Saved Source" }],
          publisherSources: [{ subscriptionId: "foreign", displayName: "Foreign Source" }],
        },
      ),
    ).toEqual(["public:public-source"]);
  });

  it("marks unsupported and out-of-scope branches explicitly", () => {
    const options = { scope, branchCap: 4, acceptedSourceIds: ["public:public-source"] } as const;
    expect(
      compilePublisherDocumentsQuery(
        { ...structuredQuery, filters: { documents: { countries: ["FR"] } } },
        options,
      ),
    ).toMatchObject({
      status: "not_applicable",
      reason: "unsupported_country_filter",
    });
    expect(
      compileChatMessagesQuery({ ...structuredQuery, scope: "documents" }, options),
    ).toMatchObject({
      status: "not_applicable",
      reason: "scope_documents",
    });
    expect(compilePhysicalQueryBranches(structuredQuery, options)).toHaveLength(3);
  });

  it("keeps all model values parameterized and emits term/phrase predicates", () => {
    const result = compilePublicDocumentsQuery(structuredQuery, {
      scope,
      branchCap: 4,
      acceptedSourceIds: ["public:public-source"],
    });
    expect(result.statement).toBeDefined();
    const [text, params] = compiler.compile(result.statement!, false);
    expect(text).toContain("plainto_tsquery");
    expect(text).toContain("phraseto_tsquery");
    expect(text).toContain("not (");
    expect(text).toContain("limit $ ".trim());
    expect(text.toLowerCase()).not.toContain("drop table");
    expect(params).toContain("storage");
    expect(params).toContain("battery");
    expect(params).toContain("residential");
    expect(params).toContain("public-source");
    expect(maxPlaceholder(text)).toBe(params.length);
  });

  it("resolves source names separately for each logical query and ranks every positive atom", () => {
    const query = {
      ...structuredQuery,
      all: [
        { text: "storage", mode: "term" as const },
        { text: "grid", mode: "term" as const },
      ],
      anyOf: [
        [
          { text: "battery", mode: "phrase" as const },
          { text: "capacity", mode: "term" as const },
        ],
      ],
    };
    const publicQuery = compilePublicDocumentsQuery(query, {
      scope,
      branchCap: 4,
      resolveSourceNames: (names) =>
        names?.[0] === "Saved Source" ? ["public:public-source"] : [],
    });
    const publisherQuery = compilePublisherDocumentsQuery(query, {
      scope,
      branchCap: 4,
      resolveSourceNames: (names) =>
        names?.[0] === "Saved Source" ? ["publisher:subscription-1"] : [],
    });
    const [publicText, publicParams] = compiler.compile(publicQuery.statement!, false);
    const [publisherText, publisherParams] = compiler.compile(publisherQuery.statement!, false);
    expect(publicParams).toContain("public-source");
    expect(publicParams).not.toContain("subscription-1");
    expect(publisherParams).toContain("subscription-1");
    expect(publisherParams).not.toContain("public-source");
    expect(publicText.match(/ts_rank_cd/g)?.length).toBe(4);
    expect(publisherText.match(/ts_rank_cd/g)?.length).toBe(4);
  });

  it("uses canonical publisher fields and bounded chat identity previews", () => {
    const publisher = compilePublisherDocumentsQuery(structuredQuery, {
      scope,
      branchCap: 4,
      acceptedSourceIds: ["publisher:subscription-1"],
    });
    const chat = compileChatMessagesQuery(structuredQuery, {
      scope,
      branchCap: 4,
    });
    const [publisherText] = compiler.compile(publisher.statement!, false);
    const [chatText] = compiler.compile(chat.statement!, false);
    expect(publisherText).toContain("v.language");
    expect(publisherText).toContain("documents.media_type");
    expect(publisherText).toContain("issues.published_at");
    expect(publisherText).toContain("subscriptions.name");
    expect(chatText).toContain('"contentPreview"');
    expect(chatText).toContain('"contentHash"');
    expect(chatText).not.toContain("ai_runs");
    expect(chatText).not.toContain('m.content as "content"');
  });

  it("keeps older chat retrieval inside the accepted tenant and chat", () => {
    const result = compileChatMessagesQuery(structuredQuery, {
      scope,
      branchCap: 4,
      acceptedSourceIds: ["public:public-source"],
    });
    const [text, params] = compiler.compile(result.statement!, false);
    expect(text).toContain("m.chat_id = $");
    expect(text).toContain("join chats c on c.id = m.chat_id");
    expect(text).toContain("c.deleted_at is null");
    expect(text).toContain("c.company_id = $");
    expect(text).toContain("m.id::text not in");
    expect(params).toContain(scope.chatId);
    expect(params).toContain(scope.companyId);
    expect(params).toContain("recent-1");
  });
});
