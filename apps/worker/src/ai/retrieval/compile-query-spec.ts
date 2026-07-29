import * as Statement from "effect/unstable/sql/Statement";

import {
  SNIPPET_MAX_CHARS,
  normalizeInternalQuery,
  type BranchReasonCode,
  type InternalQuery,
  type NormalizedInternalQuery,
  type QueryBranch,
  type QueryScope,
  type QuerySpec,
  type SourceAccess,
} from "./query-spec";

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

/* ------------------------------------------------------------------------- *
 * Phase B structured physical compilers
 * ------------------------------------------------------------------------- */

export interface AcceptedRetrievalScope {
  readonly userId: string;
  readonly chatId: string;
  readonly companyId: string;
  readonly publicSourceIds: readonly string[];
  readonly subscriptionIds: readonly string[];
  readonly accessIds: readonly string[];
  /** Recent plan-turn messages and the current message are never searched by A. */
  readonly excludedMessageIds?: readonly string[] | undefined;
  readonly currentMessageId?: string | undefined;
}

export interface SourceNameCatalog {
  readonly publicSources?: readonly { readonly sourceId: string; readonly displayName: string }[];
  readonly publisherSources?: readonly {
    readonly subscriptionId: string;
    readonly displayName: string;
  }[];
}

/**
 * Resolve provider source names against the accepted snapshot.  The return
 * value contains only code-owned IDs; an unknown, stale, or foreign name is
 * represented by the same empty result as a name with no matching source.
 */
export const resolveAcceptedSourceNames = (
  names: readonly string[] | undefined,
  scope: Pick<AcceptedRetrievalScope, "publicSourceIds" | "subscriptionIds">,
  catalog: SourceNameCatalog,
): readonly string[] => {
  if (names === undefined || names.length === 0) {
    return [
      ...scope.publicSourceIds.map((id) => `public:${id}`),
      ...scope.subscriptionIds.map((id) => `publisher:${id}`),
    ].sort();
  }
  const wanted = new Set(names.map((name) => name.trim().normalize("NFC").toLowerCase()));
  const publicIds = new Set(scope.publicSourceIds);
  const publisherIds = new Set(scope.subscriptionIds);
  const resolved = [
    ...(catalog.publicSources ?? [])
      .filter(
        (source) =>
          publicIds.has(source.sourceId) &&
          wanted.has(source.displayName.trim().normalize("NFC").toLowerCase()),
      )
      .map((source) => `public:${source.sourceId}`),
    ...(catalog.publisherSources ?? [])
      .filter(
        (source) =>
          publisherIds.has(source.subscriptionId) &&
          wanted.has(source.displayName.trim().normalize("NFC").toLowerCase()),
      )
      .map((source) => `publisher:${source.subscriptionId}`),
  ];
  return [...new Set(resolved)].sort();
};

export interface ResolvedAcceptedScope extends AcceptedRetrievalScope {
  readonly acceptedSourceIds: readonly string[];
}

export const resolveAcceptedScope = (
  scope: AcceptedRetrievalScope,
  sourceNames: readonly string[] | undefined,
  catalog: SourceNameCatalog = {},
): ResolvedAcceptedScope => {
  const acceptedSourceIds = resolveAcceptedSourceNames(sourceNames, scope, catalog);
  return { ...scope, acceptedSourceIds };
};

export interface PhysicalCompilerOptions {
  readonly scope: AcceptedRetrievalScope;
  readonly branchCap: number;
  readonly queryOrdinal?: number | undefined;
  /** Resolved source IDs for one logical query. */
  readonly acceptedSourceIds?: readonly string[] | undefined;
  /** Resolve one query's names inside the accepted scope. */
  readonly resolveSourceNames?:
    | ((names: readonly string[] | undefined) => readonly string[])
    | undefined;
}

export interface CompiledPhysicalQuery {
  readonly branch: QueryBranch;
  readonly order?: NormalizedInternalQuery["order"] | undefined;
  readonly status: "applicable" | "not_applicable";
  readonly reason?: BranchReasonCode | undefined;
  readonly cap: number;
  readonly statement?: Statement.Fragment | undefined;
}

const positiveBranchCap = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidQuerySpecError("branchCap must be a positive safe integer");
  }
  return value;
};

const normalizedQuery = (query: InternalQuery | NormalizedInternalQuery): NormalizedInternalQuery =>
  normalizeInternalQuery(query);

const literalFragment = (value: string): Statement.Fragment =>
  Statement.fragment([Statement.literal(value)]);

const sqlList = (values: readonly unknown[]): Statement.Fragment =>
  values.length === 0
    ? literalFragment("1 = 0")
    : Statement.csv(values.map((value) => frag`${value}`));

const atomPredicate = (
  column: string,
  atom: { readonly text: string; readonly mode: string },
  regconfig = "'simple'",
) =>
  atom.mode === "phrase"
    ? frag`${literalFragment(column)} @@ phraseto_tsquery(${literalFragment(regconfig)}, ${atom.text})`
    : frag`${literalFragment(column)} @@ plainto_tsquery(${literalFragment(regconfig)}, ${atom.text})`;

const queryPredicate = (
  column: string,
  query: NormalizedInternalQuery,
  regconfig = "'simple'",
): Statement.Fragment | null => {
  const all = query.all.map((atom) => atomPredicate(column, atom, regconfig));
  const any = query.anyOf.map((group) =>
    Statement.or(group.map((atom) => atomPredicate(column, atom, regconfig))),
  );
  const not = query.not.map((atom) => frag`not (${atomPredicate(column, atom, regconfig)})`);
  const predicates = [...all, ...any, ...not];
  return predicates.length === 0 ? null : Statement.and(predicates);
};

const atomRank = (
  column: string,
  atom: { readonly text: string; readonly mode: string },
  regconfig = "'simple'",
) =>
  atom.mode === "phrase"
    ? frag`ts_rank_cd(${literalFragment(column)}, phraseto_tsquery(${literalFragment(regconfig)}, ${atom.text}))`
    : frag`ts_rank_cd(${literalFragment(column)}, plainto_tsquery(${literalFragment(regconfig)}, ${atom.text}))`;

/** Rank every positive atom, including every anyOf alternative and phrase. */
const queryRank = (
  column: string,
  query: NormalizedInternalQuery,
  regconfig = "'simple'",
): Statement.Fragment => {
  const atoms = [...query.all, ...query.anyOf.flat()];
  if (atoms.length === 0) return literalFragment("0");
  const segments: Statement.Segment[] = [];
  atoms.forEach((atom, index) => {
    if (index > 0) segments.push(Statement.literal(" + "));
    segments.push(...atomRank(column, atom, regconfig).segments);
  });
  return Statement.fragment(segments);
};

const dateValue = (value: string | undefined): Date | undefined =>
  value === undefined ? undefined : new Date(`${value}T00:00:00.000Z`);

const documentFilters = (
  query: NormalizedInternalQuery,
  fields: {
    readonly sourceColumn?: string | undefined;
    readonly countryColumn?: string | undefined;
    readonly languageColumn: string;
    readonly documentTypeColumn: string;
    readonly publishedAtColumn: string;
  },
  sourceIds: readonly string[],
): Statement.Fragment[] => {
  const filters = query.filters.documents;
  const fragments: Statement.Fragment[] = [];
  if (fields.sourceColumn !== undefined) {
    if (sourceIds.length === 0) fragments.push(literalFragment("1 = 0"));
    else fragments.push(frag`${literalFragment(fields.sourceColumn)} in (${sqlList(sourceIds)})`);
  }
  if (filters === undefined) return fragments;
  if (
    fields.countryColumn !== undefined &&
    filters.countries !== undefined &&
    filters.countries.length > 0
  ) {
    fragments.push(
      frag`${literalFragment(fields.countryColumn)} in (${sqlList(filters.countries.map((value) => value.toUpperCase()))})`,
    );
  }
  if (filters.languages !== undefined && filters.languages.length > 0) {
    fragments.push(
      frag`lower(split_part(${literalFragment(fields.languageColumn)}, '-', 1)) in (${sqlList(filters.languages.map((value) => value.toLowerCase().split("-", 1)[0]))})`,
    );
  }
  if (filters.documentTypes !== undefined && filters.documentTypes.length > 0) {
    fragments.push(
      frag`${literalFragment(fields.documentTypeColumn)} in (${sqlList(filters.documentTypes)})`,
    );
  }
  const after = dateValue(filters.publishedAt?.after);
  const before = dateValue(filters.publishedAt?.before);
  if (after !== undefined)
    fragments.push(frag`${literalFragment(fields.publishedAtColumn)} >= ${after}`);
  if (before !== undefined)
    fragments.push(frag`${literalFragment(fields.publishedAtColumn)} <= ${before}`);
  return fragments;
};

const sourceIdsForQuery = (
  query: NormalizedInternalQuery,
  options: PhysicalCompilerOptions,
  kind: "public" | "publisher",
): readonly string[] => {
  const names = query.filters.documents?.sourceNames;
  const resolved =
    names === undefined || names.length === 0
      ? undefined
      : (options.resolveSourceNames?.(names) ?? options.acceptedSourceIds ?? []);
  const values =
    resolved ?? (kind === "public" ? options.scope.publicSourceIds : options.scope.subscriptionIds);
  return values
    .filter((id) => id.startsWith(`${kind}:`) || !id.includes(":"))
    .map((id) => (id.startsWith(`${kind}:`) ? id.slice(kind.length + 1) : id));
};

const chatFilters = (query: NormalizedInternalQuery): Statement.Fragment[] => {
  const filters = query.filters.chatMessages;
  if (filters === undefined) return [];
  const fragments: Statement.Fragment[] = [];
  if (filters.authors !== undefined && filters.authors.length > 0) {
    fragments.push(frag`m.author in (${sqlList(filters.authors)})`);
  }
  const after = dateValue(filters.sentAt?.after);
  const before = dateValue(filters.sentAt?.before);
  if (after !== undefined) fragments.push(frag`m.created_at >= ${after}`);
  if (before !== undefined) fragments.push(frag`m.created_at <= ${before}`);
  return fragments;
};

/**
 * Keep the database boundary in step with stripHistoricalCitationTags().
 * Citation-shaped spans are historical assistant presentation only; an
 * assistant span is removed whether it is closed or runs to end of input.
 */
export const sanitizedChatContentSql = (
  contentColumn = "m.content",
  authorColumn = "m.author",
): Statement.Fragment =>
  frag`case when ${literalFragment(authorColumn)} = 'assistant' then regexp_replace(${literalFragment(contentColumn)}, '\\[\\[cite:(?:[^]]*\\]\\]|.*$)', '', 'g') else ${literalFragment(contentColumn)} end`;

const branchNotApplicable = (
  branch: QueryBranch,
  cap: number,
  reason: BranchReasonCode,
  order: NormalizedInternalQuery["order"],
): CompiledPhysicalQuery => ({ branch, order, status: "not_applicable", reason, cap });

const scopeStatus = (
  scope: QueryScope | undefined,
  branch: QueryBranch,
): BranchReasonCode | undefined => {
  if (scope === undefined) return undefined;
  if (scope === "documents" && branch === "chat_messages") return "scope_documents";
  if (scope === "chat_messages" && branch !== "chat_messages") return "scope_chat_messages";
  return undefined;
};

export const compilePublicDocumentsQuery = (
  input: InternalQuery | NormalizedInternalQuery,
  options: PhysicalCompilerOptions,
): CompiledPhysicalQuery => {
  const query = normalizedQuery(input);
  const cap = positiveBranchCap(options.branchCap);
  const reason = scopeStatus(query.scope, "public_documents");
  if (reason !== undefined)
    return branchNotApplicable("public_documents", cap, reason, query.order);
  const sourceIds = sourceIdsForQuery(query, options, "public");
  const textPredicate = queryPredicate(
    "d.search_vector",
    query,
    "language_to_regconfig(d.language)",
  );
  const predicates = [
    ...(textPredicate === null ? [] : [textPredicate]),
    ...documentFilters(
      query,
      {
        sourceColumn: "d.source_id",
        countryColumn: "s.country",
        languageColumn: "d.language",
        documentTypeColumn: "d.document_type",
        publishedAtColumn: "d.published_at",
      },
      sourceIds,
    ),
  ];
  const where = Statement.and(predicates.length === 0 ? ["1 = 0"] : predicates);
  const order =
    query.order === "oldest"
      ? "coalesce(d.published_at, d.discovered_at) asc"
      : query.order === "newest"
        ? "coalesce(d.published_at, d.discovered_at) desc"
        : "score desc";
  const score = queryRank("d.search_vector", query, "language_to_regconfig(d.language)");
  const statement = frag`select d.source_id as "sourceId", d.document_id as "documentId", d.document_id as "snapshotId", d.content_hash as "contentHash", d.title, s.display_name as "sourceDisplayName", d.published_at as "publishedAt", d.language, d.document_type as "documentType", d.text_char_count as "textCharCount", ${score} as score
from public_source_documents d join public_sources s on s.source_id = d.source_id
where ${where}
order by ${literalFragment(order)}, d.document_id asc
limit ${cap + 1}`;
  return { branch: "public_documents", order: query.order, status: "applicable", cap, statement };
};

export const compilePublisherDocumentsQuery = (
  input: InternalQuery | NormalizedInternalQuery,
  options: PhysicalCompilerOptions,
): CompiledPhysicalQuery => {
  const query = normalizedQuery(input);
  const cap = positiveBranchCap(options.branchCap);
  const reason = scopeStatus(query.scope, "publisher_documents");
  if (reason !== undefined)
    return branchNotApplicable("publisher_documents", cap, reason, query.order);
  if ((query.filters.documents?.countries?.length ?? 0) > 0) {
    return branchNotApplicable(
      "publisher_documents",
      cap,
      "unsupported_country_filter",
      query.order,
    );
  }
  const sourceIds = sourceIdsForQuery(query, options, "publisher");
  const textPredicate = queryPredicate(
    "v.search_vector",
    query,
    "language_to_regconfig(v.language)",
  );
  const predicates = [
    ...(textPredicate === null ? [] : [textPredicate]),
    ...documentFilters(
      query,
      {
        languageColumn: "v.language",
        documentTypeColumn: "documents.media_type",
        publishedAtColumn: "issues.published_at",
      },
      sourceIds,
    ),
  ];
  const where = Statement.and(predicates.length === 0 ? ["1 = 0"] : predicates);
  const score =
    textPredicate === null
      ? literalFragment("0")
      : queryRank("v.search_vector", query, "language_to_regconfig(v.language)");
  const order =
    query.order === "oldest"
      ? "issues.published_at asc"
      : query.order === "newest"
        ? "issues.published_at desc"
        : "score desc";
  const accessPredicate =
    options.scope.accessIds.length === 0
      ? literalFragment("1 = 0")
      : frag`deliveries.access_id::text in (${sqlList(options.scope.accessIds)})`;
  const subscriptionPredicate =
    sourceIds.length === 0
      ? literalFragment("1 = 0")
      : frag`subscriptions.id::text in (${sqlList(sourceIds)})`;
  const statement = frag`select subscriptions.id::text as "subscriptionId", issues.id::text as "issueId", documents.id::text as "documentId", v.id::text as "snapshotId", v.publisher_extraction_id::text as "publisherExtractionId", v.content_hash as "contentHash", documents.title, subscriptions.name as "sourceDisplayName", issues.published_at as "publishedAt", v.language, documents.media_type as "documentType", v.text_char_count as "textCharCount", ${score} as score
from issue_deliveries deliveries
join issue_delivery_recipients recipients on recipients.issue_id = deliveries.issue_id and recipients.client_company_id = deliveries.client_company_id and recipients.user_id = ${options.scope.userId}
join publisher_issues issues on issues.id = deliveries.issue_id and issues.status = 'published' and issues.restricted_at is null and issues.deleted_at is null
join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
join publisher_companies companies on companies.id = subscriptions.publisher_company_id
join brief_documents documents on documents.issue_id = issues.id and documents.deleted_at is null
join brief_document_versions v on v.id = documents.current_version_id and v.brief_document_id = documents.id
where ${accessPredicate}
  and deliveries.client_company_id = ${options.scope.companyId}
  and ${subscriptionPredicate}
  and ${where}
order by ${literalFragment(order)}, documents.id asc
limit ${cap + 1}`;
  return {
    branch: "publisher_documents",
    order: query.order,
    status: "applicable",
    cap,
    statement,
  };
};

export const compileChatMessagesQuery = (
  input: InternalQuery | NormalizedInternalQuery,
  options: PhysicalCompilerOptions,
): CompiledPhysicalQuery => {
  const query = normalizedQuery(input);
  const cap = positiveBranchCap(options.branchCap);
  const reason = scopeStatus(query.scope, "chat_messages");
  if (reason !== undefined) return branchNotApplicable("chat_messages", cap, reason, query.order);
  const excluded = [
    ...(options.scope.excludedMessageIds ?? []),
    ...(options.scope.currentMessageId === undefined ? [] : [options.scope.currentMessageId]),
  ];
  const sanitizedContent = sanitizedChatContentSql();
  const queryText = queryPredicate("to_tsvector('simple', sanitized_chat_content)", query);
  const predicates = [
    ...(queryText === null ? [] : [queryText]),
    frag`m.chat_id = ${options.scope.chatId}`,
    ...(excluded.length === 0 ? [] : [frag`m.id::text not in (${sqlList(excluded)})`]),
    ...chatFilters(query),
  ];
  const where = Statement.and(predicates);
  const order =
    query.order === "oldest"
      ? "m.created_at asc, m.id asc"
      : query.order === "newest"
        ? "m.created_at desc, m.id asc"
        : "score desc, m.created_at desc, m.id asc";
  const statement = frag`select m.id::text as "messageId", m.author, m.created_at as "createdAt", encode(digest(convert_to(sanitized_chat_content, 'UTF8'), 'sha256'), 'hex') as "contentHash", left(sanitized_chat_content, 512) as "contentPreview", length(sanitized_chat_content) as "textCharCount", ${queryText === null ? literalFragment("0") : queryRank("to_tsvector('simple', sanitized_chat_content)", query)} as score
from (
  select m.*, ${sanitizedContent} as sanitized_chat_content
  from chat_messages m
  join chats c on c.id = m.chat_id and c.deleted_at is null and c.company_id = ${options.scope.companyId}
  where m.chat_id = ${options.scope.chatId}
    and exists (
      select 1
      from client_company_memberships memberships
      where memberships.company_id = c.company_id
        and memberships.user_id = ${options.scope.userId}
        and memberships.revoked_at is null
    )
) m
where ${where}
order by ${literalFragment(order)}
limit ${cap + 1}`;
  return { branch: "chat_messages", order: query.order, status: "applicable", cap, statement };
};

export const compilePhysicalQueryBranches = (
  input: InternalQuery | NormalizedInternalQuery,
  options: PhysicalCompilerOptions,
): readonly CompiledPhysicalQuery[] => [
  compilePublicDocumentsQuery(input, options),
  compilePublisherDocumentsQuery(input, options),
  compileChatMessagesQuery(input, options),
];

export const compileQueryBranches = compilePhysicalQueryBranches;
