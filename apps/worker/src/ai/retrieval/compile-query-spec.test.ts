import { PgClient } from "@effect/sql-pg";
import { describe, expect, it } from "vitest";

import {
  buildSourceAccessClause,
  compileQuerySpec,
  InvalidQuerySpecError,
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

  it("runs snippet generation after dedupe and limit", () => {
    const [text] = compile({ terms: "inflation" });
    const headlineIndex = text.indexOf("ts_headline");
    const selectedIndex = text.indexOf(") selected");

    expect(headlineIndex).toBeGreaterThanOrEqual(0);
    expect(selectedIndex).toBeGreaterThanOrEqual(0);
    expect(headlineIndex).toBeLessThan(selectedIndex);
    expect(text).toContain("ts_headline(language_to_regconfig(selected.language), selected.text");
    expect(text).not.toContain("ts_headline(language_to_regconfig(d.language), d.text");
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

  it("compiles live chat, membership, user, company, and source-setting authorization before ranking", () => {
    const access = {
      kind: "liveChatSourceIds" as const,
      chatId: "00000000-0000-4000-8000-000000000001",
      initiatingUserId: "user-live",
      sourceIds: ["source-live"],
    };
    const [text, params] = compiler.compile(buildSourceAccessClause(access), false);

    expect(text).toContain("d.source_id in ($1)");
    expect(text).toContain("authorized_chat.deleted_at is null");
    expect(text).toContain("authorized_membership.revoked_at is null");
    expect(text).toContain("authorized_user.recovery_deleted_at is null");
    expect(text).toContain("authorized_company.purged_at is null");
    expect(text).toContain("authorized_setting.enabled");
    expect(params).toEqual([
      "source-live",
      "user-live",
      "00000000-0000-4000-8000-000000000001",
      "user-live",
    ]);

    const [searchText] = compile({ terms: "authorized" }, { access });
    expect(searchText.indexOf("authorized_setting.enabled")).toBeLessThan(
      searchText.lastIndexOf("limit"),
    );
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
