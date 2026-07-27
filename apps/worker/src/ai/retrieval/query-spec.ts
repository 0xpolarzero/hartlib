export type SearchOrderBy = "relevance" | "recency";

export interface QuerySpec {
  readonly terms?: string | undefined;
  readonly sourceIds?: readonly string[] | undefined;
  readonly countries?: readonly string[] | undefined;
  readonly languages?: readonly string[] | undefined;
  readonly documentTypes?: readonly string[] | undefined;
  readonly publishedAfter?: string | undefined;
  readonly publishedBefore?: string | undefined;
  readonly orderBy?: SearchOrderBy | undefined;
  readonly limit?: number | undefined;
}

export type SourceAccess = {
  /** Immutable source IDs captured by the accepted run or a current catalog read. */
  readonly kind: "sourceIds";
  readonly sourceIds: readonly string[];
};

export interface DocumentPreview {
  readonly kind: "public_source" | "publisher";
  readonly sourceId: string;
  readonly documentId: string;
  readonly versionId: string;
  readonly contentHash: string;
  readonly publisherExtractionId?: string | undefined;
  /** Full immutable text stays server-side; only an exact source slice preview enters tool output. */
  readonly text: string;
  /** Exact UTF-16 spans of the original text that contributed to the preview. */
  readonly previewRanges: readonly { readonly charStart: number; readonly charEnd: number }[];
  readonly issueId?: string | undefined;
  readonly title: string;
  readonly sourceDisplayName: string;
  readonly publishedAt: Date | null;
  readonly language: string;
  readonly documentType: string;
  readonly textCharCount: number;
  readonly snippet: string;
}

export interface DocumentPeek {
  readonly documentId: string;
  readonly text: string;
  readonly offsetChars: number;
  readonly lengthChars: number;
  readonly textCharCount: number;
}

export const SNIPPET_MAX_CHARS = 300;
export const DEFAULT_PEEK_LENGTH_CHARS = 2000;
export const MAX_PEEK_LENGTH_CHARS = 8000;
