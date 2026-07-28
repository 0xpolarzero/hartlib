import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  InvalidQuerySpecError,
  buildSourceAccessClause,
  compileQuerySpec,
} from "./compile-query-spec";
import {
  DEFAULT_PEEK_LENGTH_CHARS,
  MAX_PEEK_LENGTH_CHARS,
  type DocumentPeek,
  type DocumentPreview,
  type QuerySpec,
  type SourceAccess,
} from "./query-spec";
import {
  findNormalizedSubstringRanges,
  isWellFormedUtf16,
  normalizeAndCaseFold,
  type ExactTextRange,
} from "./exact-text";

export interface SearchDocumentsOptions {
  readonly access: SourceAccess;
  readonly maxLimit: number;
  readonly recencyHalfLifeDays: number;
  readonly now?: Date | undefined;
  readonly snippetMaxChars?: number | undefined;
}

interface SearchRow {
  readonly sourceId: string;
  readonly documentId: string;
  readonly snapshotId: string;
  readonly contentHash: string;
  readonly text: string;
  readonly title: string;
  readonly sourceDisplayName: string;
  readonly publishedAt: Date | null;
  readonly language: string;
  readonly documentType: string;
  readonly textCharCount: number;
}

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

export const searchDocuments = (
  spec: QuerySpec,
  options: SearchDocumentsOptions,
): Effect.Effect<readonly DocumentPreview[], SqlError | InvalidQuerySpecError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const fragment = yield* Effect.try({
      try: () =>
        compileQuerySpec(spec, {
          access: options.access,
          maxLimit: options.maxLimit,
          recencyHalfLifeDays: options.recencyHalfLifeDays,
          now: options.now ?? new Date(),
          snippetMaxChars: options.snippetMaxChars,
        }),
      catch: (error) => {
        if (error instanceof InvalidQuerySpecError) {
          return error;
        }
        return new InvalidQuerySpecError(error instanceof Error ? error.message : String(error));
      },
    });
    const rows = yield* sql<SearchRow>`${fragment}`;
    const snippetMaxChars = options.snippetMaxChars ?? 300;
    return rows.flatMap((row) => {
      const exactPreview = previewFromImmutableText(row.text, spec.terms, snippetMaxChars);
      if (exactPreview === null) return [];
      const { snippet, ranges: mappedRanges } = exactPreview;
      const result = {
        kind: "public_source" as const,
        sourceId: `public:${row.sourceId}`,
        documentId: row.documentId,
        snapshotId: row.snapshotId,
        contentHash: row.contentHash,
        title: row.title,
        sourceDisplayName: row.sourceDisplayName,
        publishedAt: row.publishedAt,
        language: row.language,
        documentType: row.documentType,
        textCharCount: row.text.length,
        snippet,
      } as DocumentPreview;
      Object.defineProperties(result, {
        text: { value: row.text, enumerable: false },
        previewRanges: {
          value: mappedRanges,
          enumerable: false,
        },
      });
      return [result];
    });
  });

export interface PeekDocumentOptions {
  readonly access: SourceAccess;
  readonly defaultLengthChars?: number | undefined;
  readonly maxLengthChars?: number | undefined;
}

export const MAX_PEEK_OFFSET_CHARS = 2_000_000_000;

export const clampPeekBounds = (
  offsetChars: number | undefined,
  lengthChars: number | undefined,
  defaultLengthChars: number,
  maxLengthChars: number,
): { readonly offset: number; readonly length: number } => {
  const offset =
    offsetChars === undefined || !Number.isFinite(offsetChars)
      ? 0
      : Math.min(Math.max(Math.floor(offsetChars), 0), MAX_PEEK_OFFSET_CHARS);
  const rawLength =
    lengthChars === undefined || !Number.isFinite(lengthChars)
      ? defaultLengthChars
      : Math.floor(lengthChars);
  return {
    offset,
    length: Math.min(Math.max(rawLength, 0), maxLengthChars),
  };
};

interface PeekRow {
  readonly slice: string;
  readonly textCharCount: number;
}

export const peekDocument = (
  documentId: string,
  offsetChars: number | undefined,
  lengthChars: number | undefined,
  options: PeekDocumentOptions,
): Effect.Effect<DocumentPeek | null, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const defaultLengthChars = options.defaultLengthChars ?? DEFAULT_PEEK_LENGTH_CHARS;
    const maxLengthChars = options.maxLengthChars ?? MAX_PEEK_LENGTH_CHARS;
    const { offset, length } = clampPeekBounds(
      offsetChars,
      lengthChars,
      defaultLengthChars,
      maxLengthChars,
    );
    const accessFragment = buildSourceAccessClause(options.access);
    const rows = yield* sql<PeekRow>`select
        substring(d.text from (least(${offset}, d.text_char_count) + 1)::int for ${length}::int) as slice,
  d.text_char_count as "textCharCount"
from public_source_documents d
join public_sources s on s.source_id = d.source_id
where d.document_id = ${documentId}
  and ${accessFragment}`;
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      documentId,
      text: row.slice,
      offsetChars: Math.min(offset, row.textCharCount),
      lengthChars: row.slice.length,
      textCharCount: row.textCharCount,
    };
  });
