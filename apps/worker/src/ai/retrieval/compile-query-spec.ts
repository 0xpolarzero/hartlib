import * as Statement from "effect/unstable/sql/Statement";

import { SNIPPET_MAX_CHARS, type QuerySpec, type SourceAccess } from "./query-spec";

export class InvalidQuerySpecError extends Error {}

export interface CompileQuerySpecOptions {
  readonly access: SourceAccess;
  readonly maxLimit: number;
  readonly recencyHalfLifeDays: number;
  readonly now: Date;
  readonly snippetMaxChars?: number | undefined;
}

const frag = (
  strings: TemplateStringsArray,
  ...values: ReadonlyArray<unknown>
): Statement.Fragment => {
  const segments: Array<Statement.Segment> = [];
  if (strings[0] !== undefined && strings[0].length > 0) {
    segments.push(Statement.literal(strings[0]));
  }
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (Statement.isFragment(value)) {
      segments.push(...value.segments);
    } else {
      segments.push(Statement.parameter(value));
    }
    const next = strings[i + 1];
    if (next !== undefined && next.length > 0) {
      segments.push(Statement.literal(next));
    }
  }
  return Statement.fragment(segments);
};

const normalizeList = (values: readonly string[] | undefined): readonly string[] =>
  Array.from(
    new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0)),
  );

const normalizeCountries = (values: readonly string[] | undefined): readonly string[] =>
  normalizeList(values).map((country) => country.toUpperCase());

const normalizeLanguages = (values: readonly string[] | undefined): readonly string[] =>
  Array.from(
    new Set(
      (values ?? [])
        .map((value) => value.trim().toLowerCase().split("-", 1)[0])
        .filter((value): value is string => value !== undefined && value.length > 0),
    ),
  );

const parseDate = (value: string | undefined, name: string): Date | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidQuerySpecError(`${name} is not a valid ISO date`);
  }
  return date;
};

const normalizeLimit = (limit: number | undefined, maxLimit: number): number => {
  if (!Number.isFinite(maxLimit) || maxLimit < 1) {
    throw new InvalidQuerySpecError("maxLimit must be a positive finite number");
  }
  if (limit === undefined) {
    return Math.floor(maxLimit);
  }
  if (!Number.isFinite(limit)) {
    throw new InvalidQuerySpecError("limit must be a finite number");
  }
  return Math.min(Math.max(Math.floor(limit), 1), Math.floor(maxLimit));
};

const csv = (values: readonly string[]): Statement.Fragment =>
  Statement.csv(values.map((value) => frag`${value}`));

export const buildSourceAccessClause = (access: SourceAccess): Statement.Fragment => {
  if (access.sourceIds.length === 0) return frag`1 = 0`;
  return frag`d.source_id in (${csv(access.sourceIds)})`;
};

export const compileQuerySpec = (
  spec: QuerySpec,
  options: CompileQuerySpecOptions,
): Statement.Fragment => {
  const sourceIds = normalizeList(spec.sourceIds);
  const countries = normalizeCountries(spec.countries);
  const languages = normalizeLanguages(spec.languages);
  const documentTypes = normalizeList(spec.documentTypes);
  const publishedAfter = parseDate(spec.publishedAfter, "publishedAfter");
  const publishedBefore = parseDate(spec.publishedBefore, "publishedBefore");
  const terms = spec.terms?.trim() ?? "";
  const hasTerms = terms.length > 0;
  if (
    !hasTerms &&
    !(
      spec.orderBy === "recency" &&
      (publishedAfter !== undefined || publishedBefore !== undefined || sourceIds.length > 0)
    )
  ) {
    throw new InvalidQuerySpecError(
      "terms are required unless the query is a bounded recency listing (orderBy recency with a date or source filter)",
    );
  }
  const limit = normalizeLimit(spec.limit, options.maxLimit);
  const snippetMaxChars = options.snippetMaxChars ?? SNIPPET_MAX_CHARS;
  const halfLifeDays = options.recencyHalfLifeDays;
  const now = options.now;

  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    throw new InvalidQuerySpecError("recencyHalfLifeDays must be a positive finite number");
  }
  if (Number.isNaN(now.getTime())) {
    throw new InvalidQuerySpecError("now is not a valid date");
  }
  if (!Number.isFinite(snippetMaxChars) || snippetMaxChars < 1) {
    throw new InvalidQuerySpecError("snippetMaxChars must be a positive finite number");
  }

  const matchFragment = hasTerms
    ? languages.length === 0
      ? Statement.or([
          frag`d.search_vector @@ websearch_to_tsquery('french', ${terms})`,
          frag`d.search_vector @@ websearch_to_tsquery('english', ${terms})`,
        ])
      : Statement.or(
          languages.map(
            (primary) =>
              frag`(lower(split_part(d.language, '-', 1)) = ${primary} and d.search_vector @@ websearch_to_tsquery(language_to_regconfig(${primary}), ${terms}))`,
          ),
        )
    : null;

  const filterFragments: Array<Statement.Fragment> = [];
  if (sourceIds.length > 0) {
    filterFragments.push(frag`d.source_id in (${csv(sourceIds)})`);
  }
  if (countries.length > 0) {
    filterFragments.push(frag`s.country in (${csv(countries)})`);
  }
  if (documentTypes.length > 0) {
    filterFragments.push(frag`d.document_type in (${csv(documentTypes)})`);
  }
  if (publishedAfter !== undefined) {
    filterFragments.push(frag`d.published_at >= ${publishedAfter}`);
  }
  if (publishedBefore !== undefined) {
    filterFragments.push(frag`d.published_at <= ${publishedBefore}`);
  }

  const whereFragment = Statement.and([
    ...(matchFragment !== null ? [matchFragment] : []),
    ...filterFragments,
    buildSourceAccessClause(options.access),
  ]);
  const scoreExpr = frag`ts_rank_cd(d.search_vector, websearch_to_tsquery(language_to_regconfig(d.language), ${terms})) * power(0.5, greatest(extract(epoch from (${now}::timestamptz - coalesce(d.published_at, d.discovered_at))), 0) / (86400.0 * ${halfLifeDays}))`;
  const isRecency = spec.orderBy === "recency";
  const innerOrder = isRecency ? frag`recency_at desc` : frag`score desc`;
  const outerOrder = isRecency ? frag`recency_at desc` : frag`score desc`;

  return frag`select
  source_id as "sourceId",
  document_id as "documentId",
  document_id as "snapshotId",
  content_hash as "contentHash",
  text,
  title,
  source_display_name as "sourceDisplayName",
  published_at as "publishedAt",
  language,
  document_type as "documentType",
  text_char_count as "textCharCount"
from (
  select *
  from (
    select distinct on (d.content_hash)
      d.source_id,
      d.document_id,
      d.content_hash,
      d.title,
      s.display_name as source_display_name,
      d.published_at,
      d.language,
      d.document_type,
      d.text_char_count,
      d.text,
      ${scoreExpr} as score,
      coalesce(d.published_at, d.discovered_at) as recency_at
    from public_source_documents d
    join public_sources s on s.source_id = d.source_id
    where ${whereFragment}
    order by d.content_hash, ${innerOrder}, d.document_id asc
  ) deduped
  order by ${outerOrder}, document_id asc
  limit ${limit}
) selected
order by ${outerOrder}, document_id asc
`;
};
