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
  estimateTokens,
} from "./query-spec";

export interface SearchDocumentsOptions {
  readonly access: SourceAccess;
  readonly maxLimit: number;
  readonly recencyHalfLifeDays: number;
  readonly now?: Date | undefined;
  readonly snippetMaxChars?: number | undefined;
}

interface SearchRow {
  readonly documentId: string;
  readonly title: string;
  readonly sourceDisplayName: string;
  readonly publishedAt: Date | null;
  readonly language: string;
  readonly documentType: string;
  readonly textCharCount: number;
  readonly snippet: string;
}

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
    return rows.map((row) => ({
      documentId: row.documentId,
      title: row.title,
      sourceDisplayName: row.sourceDisplayName,
      publishedAt: row.publishedAt,
      language: row.language,
      documentType: row.documentType,
      textCharCount: row.textCharCount,
      estimatedTokens: estimateTokens(row.textCharCount),
      snippet: row.snippet,
    }));
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
