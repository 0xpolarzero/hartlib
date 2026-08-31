import * as Statement from "effect/unstable/sql/Statement";

import {
  normalizeInternalQuery,
  type BranchReasonCode,
  type InternalQuery,
  type NormalizedInternalQuery,
  type QueryBranch,
} from "./query-spec";

export class InvalidQuerySpecError extends Error {}

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

/* ------------------------------------------------------------------------- *
 * Phase B structured physical compilers
 * ------------------------------------------------------------------------- */

export interface AcceptedRetrievalScope {
  readonly userId: string;
  readonly chatId: string;
  readonly companyId: string;
  readonly publicSourceIds: readonly string[];
  /** Recent plan-turn messages and the current message are never searched by A. */
  readonly excludedMessageIds?: readonly string[] | undefined;
  readonly currentMessageId?: string | undefined;
}

export interface SourceNameCatalog {
  readonly publicSources?: readonly { readonly sourceId: string; readonly displayName: string }[];
}

/**
 * Resolve provider source names against the accepted snapshot.  The return
 * value contains only code-owned IDs; an unknown, stale, or foreign name is
 * represented by the same empty result as a name with no matching source.
 */
export const resolveAcceptedSourceNames = (
  names: readonly string[] | undefined,
  scope: Pick<AcceptedRetrievalScope, "publicSourceIds">,
  catalog: SourceNameCatalog,
): readonly string[] => {
  if (names === undefined || names.length === 0) {
    return scope.publicSourceIds.map((id) => `public:${id}`).sort();
  }
  const wanted = new Set(names.map((name) => name.trim().normalize("NFC").toLowerCase()));
  const publicIds = new Set(scope.publicSourceIds);
  const resolved = (catalog.publicSources ?? [])
    .filter(
      (source) =>
        publicIds.has(source.sourceId) &&
        wanted.has(source.displayName.trim().normalize("NFC").toLowerCase()),
    )
    .map((source) => `public:${source.sourceId}`);
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

const timestampValue = (value: string): Statement.Fragment => frag`${value}::timestamptz`;

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
  const filters = query.targets.find((target) => target.kind === "documents")?.filters;
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
  const after = filters.publishedAt?.after;
  const before = filters.publishedAt?.before;
  if (after !== undefined)
    fragments.push(frag`${literalFragment(fields.publishedAtColumn)} >= ${timestampValue(after)}`);
  if (before !== undefined)
    fragments.push(frag`${literalFragment(fields.publishedAtColumn)} < ${timestampValue(before)}`);
  return fragments;
};

const sourceIdsForQuery = (
  query: NormalizedInternalQuery,
  options: PhysicalCompilerOptions,
): readonly string[] => {
  const names = query.targets.find((target) => target.kind === "documents")?.filters.sourceNames;
  const resolved =
    names === undefined || names.length === 0
      ? options.acceptedSourceIds
      : (options.resolveSourceNames?.(names) ?? options.acceptedSourceIds ?? []);
  const values = resolved ?? options.scope.publicSourceIds;
  return values
    .filter((id) => id.startsWith("public:") || !id.includes(":"))
    .map((id) => (id.startsWith("public:") ? id.slice("public:".length) : id));
};

const chatFilters = (query: NormalizedInternalQuery): Statement.Fragment[] => {
  const filters = query.targets.find((target) => target.kind === "chat_messages")?.filters;
  if (filters === undefined) return [];
  const fragments: Statement.Fragment[] = [];
  if (filters.authors !== undefined && filters.authors.length > 0) {
    fragments.push(frag`m.author in (${sqlList(filters.authors)})`);
  }
  const after = filters.sentAt?.after;
  const before = filters.sentAt?.before;
  if (after !== undefined) fragments.push(frag`m.created_at >= ${timestampValue(after)}`);
  if (before !== undefined) fragments.push(frag`m.created_at < ${timestampValue(before)}`);
  return fragments;
};

/**
 * Keep the database boundary in step with stripHistoricalCitationTags().
 * Citation-shaped spans are historical assistant presentation only; the
 * migration-owned function keeps SQL and worker sanitization in exact parity.
 */
export const sanitizedChatContentSql = (
  contentColumn = "m.content",
  authorColumn = "m.author",
): Statement.Fragment =>
  frag`case when ${literalFragment(authorColumn)} = 'assistant' then hartlib_ai_strip_historical_citation_tags(${literalFragment(contentColumn)}) else ${literalFragment(contentColumn)} end`;

const branchNotApplicable = (
  branch: QueryBranch,
  cap: number,
  reason: BranchReasonCode,
  order: NormalizedInternalQuery["order"],
): CompiledPhysicalQuery => ({ branch, order, status: "not_applicable", reason, cap });

const targetStatus = (
  targets: NormalizedInternalQuery["targets"],
  branch: QueryBranch,
): BranchReasonCode | undefined => {
  const targetKind = branch === "chat_messages" ? "chat_messages" : "documents";
  return targets.some((target) => target.kind === targetKind)
    ? undefined
    : targetKind === "documents"
      ? "scope_chat_messages"
      : "scope_documents";
};

export const compilePublicDocumentsQuery = (
  input: InternalQuery | NormalizedInternalQuery,
  options: PhysicalCompilerOptions,
): CompiledPhysicalQuery => {
  const query = normalizedQuery(input);
  const cap = positiveBranchCap(options.branchCap);
  const reason = targetStatus(query.targets, "public_documents");
  if (reason !== undefined)
    return branchNotApplicable("public_documents", cap, reason, query.order);
  const sourceIds = sourceIdsForQuery(query, options);
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
order by ${literalFragment(order)}, encode(convert_to(d.source_id::text, 'UTF8'), 'hex') asc, encode(convert_to(d.document_id::text, 'UTF8'), 'hex') asc
limit ${cap + 1}`;
  return { branch: "public_documents", order: query.order, status: "applicable", cap, statement };
};

export const compileChatMessagesQuery = (
  input: InternalQuery | NormalizedInternalQuery,
  options: PhysicalCompilerOptions,
): CompiledPhysicalQuery => {
  const query = normalizedQuery(input);
  const cap = positiveBranchCap(options.branchCap);
  const reason = targetStatus(query.targets, "chat_messages");
  if (reason !== undefined) return branchNotApplicable("chat_messages", cap, reason, query.order);
  const excluded = [
    ...(options.scope.excludedMessageIds ?? []),
    ...(options.scope.currentMessageId === undefined ? [] : [options.scope.currentMessageId]),
  ];
  const sanitizedContent = sanitizedChatContentSql();
  const currentMessageJoin =
    options.scope.currentMessageId === undefined
      ? literalFragment("")
      : frag`join chat_messages current_message on current_message.id = ${options.scope.currentMessageId} and current_message.chat_id = m.chat_id and (m.created_at, m.id) < (current_message.created_at, current_message.id) `;
  const queryText = queryPredicate("m.search_vector", query);
  const predicates = [
    ...(queryText === null ? [] : [queryText]),
    frag`m.chat_id = ${options.scope.chatId}`,
    ...(excluded.length === 0 ? [] : [frag`m.id::text not in (${sqlList(excluded)})`]),
    ...chatFilters(query),
  ];
  const where = Statement.and(predicates);
  const order =
    query.order === "oldest"
      ? "m.created_at asc"
      : query.order === "newest"
        ? "m.created_at desc"
        : "score desc, m.created_at desc";
  const statement = frag`select m.id::text as "messageId", m.author, m.created_at as "createdAt", encode(digest(convert_to(sanitized_chat_content, 'UTF8'), 'sha256'), 'hex') as "contentHash", left(sanitized_chat_content, 512) as "contentPreview", length(sanitized_chat_content) as "textCharCount", ${queryText === null ? literalFragment("0") : queryRank("m.search_vector", query)} as score
from (
  select m.*, ${sanitizedContent} as sanitized_chat_content
  from chat_messages m
  ${currentMessageJoin}join chats c on c.id = m.chat_id and c.company_id = ${options.scope.companyId}
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
order by ${literalFragment(order)}, encode(convert_to(m.id::text, 'UTF8'), 'hex') asc
limit ${cap + 1}`;
  return { branch: "chat_messages", order: query.order, status: "applicable", cap, statement };
};

export const compilePhysicalQueryBranches = (
  input: InternalQuery | NormalizedInternalQuery,
  options: PhysicalCompilerOptions,
): readonly CompiledPhysicalQuery[] => [
  compilePublicDocumentsQuery(input, options),
  compileChatMessagesQuery(input, options),
];
