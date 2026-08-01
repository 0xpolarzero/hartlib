import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import { Clock, Duration, Effect, Semaphore } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  InvalidQuerySpecError,
  compilePhysicalQueryBranches,
  sanitizedChatContentSql,
  type CompiledPhysicalQuery,
  type PhysicalCompilerOptions,
  type AcceptedRetrievalScope,
} from "./compile-query-spec";
import {
  InternalQueryPlanSchema,
  normalizeInternalQuery,
  type InternalQuery,
  type InternalQueryPlan,
} from "./query-spec";
import {
  fuseTwoStageRankedResults,
  ReviewModelFusedResultSchema,
  toReviewModelFusedResults,
  canonicalIdentityKey,
  type FusedResultSet,
  type RankedBranchHit,
  type ReviewModelFusedResult,
  type RetrievalCanonicalIdentity,
} from "./rank-fusion";
import {
  RUNTIME_MODEL_ID,
  resolveRuntimeModel,
  type RuntimeModelId,
} from "../runtime/model-registry";
import { stripHistoricalCitationTags } from "../runtime/canonicalization";
import {
  findNormalizedSubstringRanges,
  isWellFormedUtf16,
  normalizeAndCaseFold,
  type ExactTextRange,
} from "./exact-text";

export type PreviewRange = ExactTextRange;

const SEARCH_OPERATOR_WORDS = new Set(["and", "or", "not"]);
const searchTerms = (terms: string): readonly string[] =>
  !isWellFormedUtf16(terms)
    ? []
    : (terms.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}_'’-]*/gu) ?? []).filter(
        (term) => !SEARCH_OPERATOR_WORDS.has(normalizeAndCaseFold(term)),
      );

const mergeRanges = (ranges: readonly PreviewRange[]): readonly PreviewRange[] => {
  const merged: PreviewRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && range.charStart <= previous.charEnd) {
      merged[merged.length - 1] = {
        charStart: previous.charStart,
        charEnd: Math.max(previous.charEnd, range.charEnd),
      };
    } else {
      merged.push(range);
    }
  }
  return merged;
};

const exactPrefixPreview = (
  text: string,
  maxChars: number,
): {
  readonly snippet: string;
  readonly ranges: readonly PreviewRange[];
} | null => {
  if (text.length === 0) return null;
  let end = Math.min(Math.floor(maxChars), text.length);
  if (
    end > 0 &&
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  ) {
    end -= 1;
  }
  const snippet = text.slice(0, end);
  return snippet.length === 0
    ? null
    : { snippet, ranges: [{ charStart: 0, charEnd: snippet.length }] };
};

/** Build a preview only from exact UTF-16 spans in immutable source text. */
export const previewFromImmutableText = (
  text: string,
  terms: string | undefined,
  maxChars: number,
): { readonly snippet: string; readonly ranges: readonly PreviewRange[] } | null => {
  if (text.length === 0 || !Number.isFinite(maxChars) || maxChars < 1) return null;
  if (terms?.trim().length === 0 || terms === undefined) {
    return exactPrefixPreview(text, maxChars);
  }
  const normalizedTerms = searchTerms(terms);
  if (normalizedTerms.length === 0) return null;
  const allRanges = mergeRanges(findNormalizedSubstringRanges(text, normalizedTerms));
  if (allRanges.length === 0) return null;
  const ranges: PreviewRange[] = [];
  let snippetLength = 0;
  for (const range of allRanges) {
    const nextLength =
      snippetLength +
      (ranges.length === 0 ? 0 : "\n…\n".length) +
      (range.charEnd - range.charStart);
    if (nextLength > maxChars) break;
    ranges.push(range);
    snippetLength = nextLength;
  }
  if (ranges.length === 0) return null;
  const snippet = ranges.map((range) => text.slice(range.charStart, range.charEnd)).join("\n…\n");
  return { snippet, ranges };
};

/* ------------------------------------------------------------------------- *
 * Phase B search service
 * ------------------------------------------------------------------------- */

export interface PhysicalSearchValue {
  readonly kind: "document" | "chat_message";
  readonly label: string | null;
  readonly date: string | null;
  readonly textCharCount: number;
  readonly sourceName?: string | undefined;
}

export interface PhysicalSearchRow {
  readonly sourceId?: string | undefined;
  readonly subscriptionId?: string | undefined;
  readonly issueId?: string | undefined;
  readonly documentId?: string | undefined;
  readonly snapshotId?: string | undefined;
  readonly publisherExtractionId?: string | undefined;
  readonly contentHash?: string | undefined;
  readonly messageId?: string | undefined;
  readonly author?: string | undefined;
  readonly createdAt?: string | Date | null | undefined;
  readonly title?: string | null | undefined;
  readonly sourceDisplayName?: string | null | undefined;
  readonly publishedAt?: string | Date | null | undefined;
  readonly language?: string | null | undefined;
  readonly documentType?: string | null | undefined;
  readonly textCharCount?: number | undefined;
  readonly content?: string | undefined;
  readonly contentPreview?: string | undefined;
}

export interface PhysicalSearchOptions extends PhysicalCompilerOptions {
  readonly queryOrdinal?: number | undefined;
  readonly maxConcurrency?: number | undefined;
  readonly statementTimeoutMs?: number | undefined;
  readonly maxCandidates?: number | undefined;
  readonly maxHydratedBytes?: number | undefined;
  readonly now?: Date | undefined;
  readonly executionContext?: RetrievalExecutionContext | undefined;
}

export interface RetrievalExecutionContext {
  readonly deadlineAtMs: number;
  readonly semaphore: ReturnType<typeof Semaphore.makeUnsafe>;
}

export const makeRetrievalExecutionContext = (
  timeoutMs: number,
  maxConcurrency: number,
  startedAtMs = Date.now(),
): RetrievalExecutionContext => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("retrieval timeout must be a positive integer");
  }
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error("retrieval branch concurrency must be a positive integer");
  }
  return {
    deadlineAtMs: startedAtMs + timeoutMs,
    semaphore: Semaphore.makeUnsafe(maxConcurrency),
  };
};

export interface PhysicalBranchResult {
  readonly queryOrdinal: number;
  readonly branch: CompiledPhysicalQuery["branch"];
  readonly order?: CompiledPhysicalQuery["order"];
  readonly status: "applicable" | "not_applicable";
  readonly reason?: CompiledPhysicalQuery["reason"];
  readonly hits: readonly RankedBranchHit<PhysicalSearchValue>[];
  readonly cap: number;
  readonly truncated: boolean;
}

export class RetrievalHydrationError extends Error {
  readonly code: "snapshot_mismatch" | "hash_mismatch" | "missing_snapshot" | "byte_cap";

  constructor(
    code: "snapshot_mismatch" | "hash_mismatch" | "missing_snapshot" | "byte_cap",
    message: string,
  ) {
    super(message);
    this.name = "RetrievalHydrationError";
    this.code = code;
  }
}

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const isoDateString = (value: string | Date | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("retrieval row contains an invalid date");
  }
  return date.toISOString();
};

const identityFromRow = (
  branch: CompiledPhysicalQuery["branch"],
  row: PhysicalSearchRow,
): RetrievalCanonicalIdentity => {
  if (branch === "chat_messages") {
    if (row.messageId === undefined || row.contentHash === undefined) {
      throw new Error("chat search row is missing immutable message identity");
    }
    return {
      kind: "chat_message",
      messageId: row.messageId,
      sanitizedContentHash: row.contentHash,
    };
  }
  if (branch === "public_documents") {
    if (
      row.sourceId === undefined ||
      row.documentId === undefined ||
      row.snapshotId === undefined ||
      row.contentHash === undefined
    ) {
      throw new Error("public search row is missing immutable identity");
    }
    return {
      kind: "public_document",
      sourceId: row.sourceId,
      documentId: row.documentId,
      snapshotId: row.snapshotId,
      contentHash: row.contentHash,
    };
  }
  if (
    row.subscriptionId === undefined ||
    row.issueId === undefined ||
    row.documentId === undefined ||
    row.snapshotId === undefined ||
    row.publisherExtractionId === undefined ||
    row.contentHash === undefined
  ) {
    throw new Error("publisher search row is missing immutable identity");
  }
  return {
    kind: "publisher_document",
    subscriptionId: row.subscriptionId,
    issueId: row.issueId,
    documentId: row.documentId,
    snapshotId: row.snapshotId,
    publisherExtractionId: row.publisherExtractionId,
    contentHash: row.contentHash,
  };
};

const valueFromRow = (
  branch: CompiledPhysicalQuery["branch"],
  row: PhysicalSearchRow,
): PhysicalSearchValue => ({
  kind: branch === "chat_messages" ? "chat_message" : "document",
  label:
    branch === "chat_messages"
      ? (row.author ?? null)
      : (row.title ?? row.sourceDisplayName ?? null),
  date: isoDateString(branch === "chat_messages" ? row.createdAt : row.publishedAt),
  textCharCount: row.textCharCount ?? row.content?.length ?? 0,
  ...(row.sourceDisplayName === undefined || row.sourceDisplayName === null
    ? {}
    : { sourceName: row.sourceDisplayName }),
});

const executePhysicalBranch = (
  sql: PgClient.PgClient,
  branch: CompiledPhysicalQuery,
  queryOrdinal: number,
  statementTimeoutMs: number,
): Effect.Effect<PhysicalBranchResult, SqlError> =>
  Effect.gen(function* () {
    if (branch.status === "not_applicable" || branch.statement === undefined) {
      return {
        queryOrdinal,
        branch: branch.branch,
        ...(branch.order === undefined ? {} : { order: branch.order }),
        status: "not_applicable" as const,
        ...(branch.reason === undefined ? {} : { reason: branch.reason }),
        hits: [],
        cap: branch.cap,
        truncated: false,
      };
    }
    const readOnlyQuery = Effect.gen(function* () {
      yield* sql`set transaction read only`;
      yield* sql`select set_config('statement_timeout', ${String(statementTimeoutMs)}, true)`;
      return yield* sql<PhysicalSearchRow>`${branch.statement}`;
    });
    const rows = yield* sql.withTransaction(readOnlyQuery);
    const truncated = rows.length > branch.cap;
    const hits = rows.slice(0, branch.cap).map((row, index) => ({
      queryOrdinal,
      branch: branch.branch,
      rank: index + 1,
      identity: identityFromRow(branch.branch, row),
      value: valueFromRow(branch.branch, row),
      date: isoDateString(branch.branch === "chat_messages" ? row.createdAt : row.publishedAt),
    }));
    return {
      queryOrdinal,
      branch: branch.branch,
      ...(branch.order === undefined ? {} : { order: branch.order }),
      status: "applicable" as const,
      hits,
      cap: branch.cap,
      truncated,
    };
  });

/** Execute all query/store branches in one bounded, cancellation-aware pool. */
export const executePhysicalQueryBranches = (
  query: InternalQuery,
  options: PhysicalSearchOptions,
): Effect.Effect<readonly PhysicalBranchResult[], SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const queryOrdinal = options.queryOrdinal ?? 1;
    if (!Number.isSafeInteger(queryOrdinal) || queryOrdinal < 1) {
      return yield* Effect.fail(
        new InvalidQuerySpecError("queryOrdinal must be a positive integer"),
      );
    }
    const normalized = normalizeInternalQuery(query);
    const sql = yield* PgClient.PgClient;
    const branches = compilePhysicalQueryBranches(normalized, options);
    const concurrency = options.maxConcurrency ?? 4;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      return yield* Effect.fail(
        new Error("retrieval branch concurrency must be a positive integer"),
      );
    }
    const deadlineMs = options.statementTimeoutMs ?? 30_000;
    const startedAt = yield* Clock.currentTimeMillis;
    const executionContext =
      options.executionContext ?? makeRetrievalExecutionContext(deadlineMs, concurrency, startedAt);
    const deadline = executionContext.deadlineAtMs;
    const branchSemaphore = executionContext.semaphore;
    const execute = Effect.forEach(
      branches,
      (branch) =>
        Effect.gen(function* () {
          return yield* branchSemaphore.withPermit(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const remaining = deadline - now;
              if (remaining <= 0)
                return yield* Effect.fail(new Error("retrieval deadline exceeded"));
              return yield* executePhysicalBranch(sql, branch, queryOrdinal, remaining).pipe(
                Effect.timeout(Duration.millis(remaining)),
              );
            }),
          );
        }),
      { concurrency: "unbounded" },
    );
    const timed = execute.pipe(Effect.timeout(Duration.millis(Math.max(1, deadline - startedAt))));
    return yield* timed;
  });

export interface HydratedText {
  readonly text: string;
  readonly snapshotId?: string | undefined;
  readonly contentHash?: string | undefined;
  readonly publisherExtractionId?: string | undefined;
  readonly label?: string | null | undefined;
  readonly date?: string | Date | null | undefined;
  readonly kind?: "document" | "chat_message" | undefined;
  readonly messageId?: string | undefined;
  readonly author?: string | undefined;
}

export interface HydrationOptions {
  readonly previewTerms?: string | undefined;
  readonly previewMaxChars?: number | undefined;
  readonly maxHydratedBytes?: number | undefined;
  readonly fastModelId?: RuntimeModelId | undefined;
  readonly mainModelId?: RuntimeModelId | undefined;
}

export interface HydratedReviewValue extends PhysicalSearchValue {
  readonly tokenCount: number;
  readonly fullTokenCount: number;
  readonly preview: string;
  readonly previewRanges: readonly PreviewRange[];
  readonly text: string;
  readonly snapshotId: string;
  readonly contentHash: string;
  readonly publisherExtractionId?: string | undefined;
  readonly fastTokenCount: number;
  readonly mainTokenCount: number;
  readonly previewBytes: Uint8Array;
}

const verifyHydratedIdentity = (
  identity: RetrievalCanonicalIdentity,
  hydrated: HydratedText,
): { readonly snapshotId: string; readonly contentHash: string; readonly text: string } => {
  if (!isWellFormedUtf16(hydrated.text)) {
    throw new RetrievalHydrationError("hash_mismatch", "hydrated text is not well-formed UTF-16");
  }
  const snapshotId = hydrated.snapshotId;
  const contentHash = hydrated.contentHash;
  if (snapshotId === undefined || contentHash === undefined) {
    throw new RetrievalHydrationError(
      "missing_snapshot",
      "hydrated row lacks immutable snapshot proof",
    );
  }
  if (identity.kind !== "chat_message" && identity.snapshotId !== snapshotId) {
    throw new RetrievalHydrationError(
      "snapshot_mismatch",
      "hydrated snapshot differs from search snapshot",
    );
  }
  const visibleText =
    identity.kind === "chat_message" && hydrated.author === "assistant"
      ? stripHistoricalCitationTags(hydrated.text)
      : hydrated.text;
  if (identity.kind === "chat_message") {
    if (hydrated.messageId !== identity.messageId) {
      throw new RetrievalHydrationError(
        "snapshot_mismatch",
        "hydrated chat message identity changed",
      );
    }
    const actual = sha256Hex(visibleText);
    if (identity.sanitizedContentHash !== actual || contentHash !== actual) {
      throw new RetrievalHydrationError("hash_mismatch", "sanitized chat content hash changed");
    }
  } else if (identity.contentHash !== contentHash || sha256Hex(hydrated.text) !== contentHash) {
    throw new RetrievalHydrationError("hash_mismatch", "immutable document content hash changed");
  }
  if (
    identity.kind === "publisher_document" &&
    identity.publisherExtractionId !== hydrated.publisherExtractionId
  ) {
    throw new RetrievalHydrationError("snapshot_mismatch", "publisher extraction binding changed");
  }
  return { snapshotId, contentHash, text: visibleText };
};

/** Hydrate only fused candidates, prove immutable text, and build exact previews. */
export const hydrateFusedResults = (
  fused: FusedResultSet<PhysicalSearchValue>,
  options: HydrationOptions,
  load: (identity: RetrievalCanonicalIdentity) => HydratedText | null,
): FusedResultSet<HydratedReviewValue> => {
  const fastModel = resolveRuntimeModel(options.fastModelId ?? RUNTIME_MODEL_ID);
  const mainModel = resolveRuntimeModel(options.mainModelId ?? RUNTIME_MODEL_ID);
  const maxChars = options.previewMaxChars ?? 300;
  let hydratedBytes = 0;
  const results = [] as Array<(typeof fused.results)[number] & { value: HydratedReviewValue }>;
  for (const result of fused.results) {
    const hydrated = load(result.identity);
    if (hydrated === null) {
      throw new RetrievalHydrationError(
        "missing_snapshot",
        "retained fused identity failed to hydrate",
      );
    }
    const proof = verifyHydratedIdentity(result.identity, hydrated);
    const preview = previewFromImmutableText(proof.text, options.previewTerms, maxChars);
    if (preview === null) {
      throw new RetrievalHydrationError(
        "missing_snapshot",
        "retained fused identity has no exact preview",
      );
    }
    const bytes = new TextEncoder().encode(proof.text).byteLength;
    if (
      options.maxHydratedBytes !== undefined &&
      hydratedBytes + bytes > options.maxHydratedBytes
    ) {
      throw new RetrievalHydrationError(
        "byte_cap",
        "retained fused identities exceed hydration byte cap",
      );
    }
    hydratedBytes += bytes;
    const fullTokenCount = fastModel.countTextTokens(proof.text);
    const fastTokenCount = fastModel.countTextTokens(proof.text);
    const mainTokenCount = mainModel.countTextTokens(proof.text);
    const value: HydratedReviewValue = {
      ...result.value,
      kind: result.identity.kind === "chat_message" ? "chat_message" : "document",
      label: hydrated.label ?? result.value.label,
      date: isoDateString(hydrated.date) ?? result.value.date,
      fullTokenCount,
      tokenCount: fullTokenCount,
      fastTokenCount,
      mainTokenCount,
      previewBytes: new TextEncoder().encode(preview.snippet),
      preview: preview.snippet,
      previewRanges: preview.ranges,
      text: proof.text,
      snapshotId: proof.snapshotId,
      contentHash: proof.contentHash,
      ...(hydrated.publisherExtractionId === undefined
        ? {}
        : { publisherExtractionId: hydrated.publisherExtractionId }),
    };
    if (
      !Number.isSafeInteger(value.fullTokenCount) ||
      value.fullTokenCount < 0 ||
      value.tokenCount !== value.fullTokenCount ||
      !Number.isSafeInteger(value.fastTokenCount) ||
      value.fastTokenCount < 0 ||
      !Number.isSafeInteger(value.mainTokenCount) ||
      value.mainTokenCount < 0
    ) {
      throw new RetrievalHydrationError("hash_mismatch", "token counter returned an invalid count");
    }
    results.push({ ...result, value });
  }
  const hydratedSet: FusedResultSet<HydratedReviewValue> = {
    ...fused,
    results,
    hydratedBytes,
    hydrationByteCap: options.maxHydratedBytes ?? null,
    truncation: {
      ...fused.truncation,
      hydration: results.length < fused.results.length,
    },
  };
  return hydratedSet;
};

export interface RetrievalPreviewExposure {
  readonly identity: RetrievalCanonicalIdentity;
  readonly snapshotId: string;
  readonly contentHash: string;
  readonly publisherExtractionId?: string | undefined;
  readonly previewRanges: readonly PreviewRange[];
  readonly previewBytes: Uint8Array;
  readonly fastTokenCount: number;
  readonly mainTokenCount: number;
}

const hydrateFusedResultsFromDatabase = (
  sql: PgClient.PgClient,
  fused: FusedResultSet<PhysicalSearchValue>,
  options: HydrationOptions & { readonly scope: AcceptedRetrievalScope },
): Effect.Effect<
  {
    readonly fused: FusedResultSet<HydratedReviewValue>;
    readonly exposures: readonly RetrievalPreviewExposure[];
  },
  SqlError | Error
> =>
  Effect.gen(function* () {
    const rows = new Map<string, HydratedText>();
    for (const result of fused.results) {
      const identity = result.identity;
      const hydrated =
        identity.kind === "public_document"
          ? (yield* sql<HydratedText>`
                select d.text, d.document_id as "snapshotId", d.content_hash as "contentHash",
                       d.title as label, d.published_at as date
                from public_source_documents d
                join public_sources s on s.source_id = d.source_id
                where d.source_id = ${identity.sourceId}
                  and d.document_id = ${identity.documentId}
              `)[0]
          : identity.kind === "publisher_document"
            ? (yield* sql<HydratedText>`
                  select v.canonical_text as text, v.id::text as "snapshotId",
                         v.content_hash as "contentHash",
                         v.publisher_extraction_id::text as "publisherExtractionId",
                         documents.title as label, issues.published_at as date
                  from brief_documents documents
                  join brief_document_versions v on v.id = documents.current_version_id
                  join publisher_issues issues on issues.id = documents.issue_id
                  join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
                  join issue_deliveries deliveries on deliveries.issue_id = issues.id
                    and deliveries.subscription_id = subscriptions.id
                    and deliveries.client_company_id = ${options.scope.companyId}
                    and deliveries.access_id::text = any(${options.scope.accessIds}::text[])
                  join issue_delivery_recipients recipients on recipients.issue_id = deliveries.issue_id
                    and recipients.client_company_id = deliveries.client_company_id
                    and recipients.user_id = ${options.scope.userId}
                  where subscriptions.id::text = ${identity.subscriptionId}
                    and issues.id::text = ${identity.issueId}
                    and documents.id::text = ${identity.documentId}
                    and v.id::text = ${identity.snapshotId}
                    and v.publisher_extraction_id::text = ${identity.publisherExtractionId}
                `)[0]
            : (yield* sql<HydratedText>`
                  select m.content as text, m.id::text as "snapshotId",
                         m.author, m.id::text as "messageId", m.created_at as date,
                         encode(digest(convert_to(${sanitizedChatContentSql("m.content", "m.author")}, 'UTF8'), 'sha256'), 'hex') as "contentHash"
                  from chat_messages m
                  join chats c on c.id = m.chat_id and c.deleted_at is null
                    and c.company_id = ${options.scope.companyId}
                  where m.id::text = ${identity.messageId}
                    and m.chat_id = ${options.scope.chatId}
                `)[0];
      if (hydrated === undefined) {
        throw new RetrievalHydrationError(
          "missing_snapshot",
          "retained identity is not present in accepted scope",
        );
      }
      rows.set(canonicalIdentityKey(identity), hydrated);
    }
    const loaded = hydrateFusedResults(
      fused,
      options,
      (identity) => rows.get(canonicalIdentityKey(identity)) ?? null,
    );
    const exposures = loaded.results.map((result) => ({
      identity: result.identity,
      snapshotId: result.value.snapshotId,
      contentHash: result.value.contentHash,
      ...(result.value.publisherExtractionId === undefined
        ? {}
        : { publisherExtractionId: result.value.publisherExtractionId }),
      previewRanges: result.value.previewRanges,
      previewBytes: result.value.previewBytes,
      fastTokenCount: result.value.fastTokenCount,
      mainTokenCount: result.value.mainTokenCount,
    }));
    return { fused: loaded, exposures };
  });

export const reviewProjection = (
  fused: FusedResultSet<HydratedReviewValue>,
): readonly ReviewModelFusedResult[] => {
  const views = toReviewModelFusedResults(
    fused as unknown as FusedResultSet<{
      readonly kind: "document" | "chat_message";
      readonly label: string | null;
      readonly date: string | null;
      readonly tokenCount: number;
      readonly preview: string;
    }>,
  );
  return views.map((view) => ReviewModelFusedResultSchema.parse(view) as ReviewModelFusedResult);
};

export interface RetrievalPlanResult {
  readonly queryPlan: InternalQueryPlan;
  readonly branches: readonly PhysicalBranchResult[];
  readonly fused: FusedResultSet<PhysicalSearchValue>;
  readonly review: readonly ReviewModelFusedResult[];
  readonly previewExposures: readonly RetrievalPreviewExposure[];
}

export interface InternalPlanExecutionOptions extends Omit<PhysicalSearchOptions, "queryOrdinal"> {
  readonly maxQueries?: number | undefined;
  readonly hydration?: HydrationOptions | undefined;
  readonly executeBranch?: (
    branch: CompiledPhysicalQuery,
    queryOrdinal: number,
    statementTimeoutMs: number,
  ) => Effect.Effect<PhysicalBranchResult, Error>;
  readonly hydrateResult?: (fused: FusedResultSet<PhysicalSearchValue>) => Effect.Effect<
    {
      readonly fused: FusedResultSet<HydratedReviewValue>;
      readonly exposures: readonly RetrievalPreviewExposure[];
    },
    Error
  >;
}

/** Execute a complete code-owned query plan; replacement plans call this once more. */
export const executeInternalQueryPlan = (
  plan: InternalQueryPlan,
  options: InternalPlanExecutionOptions,
): Effect.Effect<
  RetrievalPlanResult,
  SqlError | InvalidQuerySpecError | Error,
  PgClient.PgClient
> =>
  Effect.gen(function* () {
    const validatedPlan = yield* Effect.try({
      try: () => InternalQueryPlanSchema.parse(plan) as InternalQueryPlan,
      catch: (error) =>
        new InvalidQuerySpecError(error instanceof Error ? error.message : String(error)),
    });
    const queryCap = options.maxQueries ?? 64;
    if (!Number.isSafeInteger(queryCap) || queryCap < 1) {
      return yield* Effect.fail(new InvalidQuerySpecError("maxQueries must be a positive integer"));
    }
    if (validatedPlan.action === "skip") {
      return {
        queryPlan: validatedPlan,
        branches: [],
        fused: {
          results: [],
          coverage: [],
          candidateCountBeforeCap: 0,
          candidateCap: options.maxCandidates ?? Number.MAX_SAFE_INTEGER,
          hydratedBytes: 0,
          hydrationByteCap: null,
          truncation: { branch: false, candidates: false, hydration: false },
        },
        review: [],
        previewExposures: [],
      };
    }
    if (validatedPlan.queries.length > queryCap) {
      return yield* Effect.fail(new InvalidQuerySpecError("query plan exceeds maxQueries"));
    }
    const sql = options.executeBranch === undefined ? yield* PgClient.PgClient : undefined;
    const branchJobs = validatedPlan.queries.flatMap((query, index) =>
      compilePhysicalQueryBranches(normalizeInternalQuery(query), {
        ...options,
        queryOrdinal: index + 1,
        acceptedSourceIds: undefined,
      }).map((branch) => ({ branch, queryOrdinal: index + 1 })),
    );
    const concurrency = options.maxConcurrency ?? 4;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      return yield* Effect.fail(
        new Error("retrieval branch concurrency must be a positive integer"),
      );
    }
    const deadlineMs = options.statementTimeoutMs ?? 30_000;
    const startedAt = yield* Clock.currentTimeMillis;
    const executionContext =
      options.executionContext ?? makeRetrievalExecutionContext(deadlineMs, concurrency, startedAt);
    const deadline = executionContext.deadlineAtMs;
    const branchSemaphore = executionContext.semaphore;
    const branches = yield* Effect.forEach(
      branchJobs,
      ({ branch, queryOrdinal }) =>
        Effect.gen(function* () {
          return yield* branchSemaphore.withPermit(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const remaining = deadline - now;
              if (remaining <= 0)
                return yield* Effect.fail(new Error("retrieval deadline exceeded"));
              const branchResult =
                options.executeBranch === undefined
                  ? executePhysicalBranch(sql!, branch, queryOrdinal, remaining)
                  : options.executeBranch(branch, queryOrdinal, remaining);
              return yield* branchResult.pipe(Effect.timeout(Duration.millis(remaining)));
            }),
          );
        }),
      { concurrency: "unbounded" },
    ).pipe(Effect.timeout(Duration.millis(Math.max(1, deadline - startedAt))));
    const fused = fuseTwoStageRankedResults(branches, {
      maxCandidates: options.maxCandidates,
      queryOrders: new Map(
        validatedPlan.queries.map((query, index) => [index + 1, query.order] as const),
      ),
    });
    const hydrated =
      options.hydrateResult === undefined
        ? yield* hydrateFusedResultsFromDatabase(sql!, fused, {
            ...options.hydration,
            maxHydratedBytes: options.hydration?.maxHydratedBytes ?? options.maxHydratedBytes,
            scope: options.scope,
          })
        : yield* options.hydrateResult(fused);
    return {
      queryPlan: validatedPlan,
      branches,
      fused: hydrated.fused as FusedResultSet<PhysicalSearchValue>,
      review: reviewProjection(hydrated.fused),
      previewExposures: hydrated.exposures,
    };
  });
