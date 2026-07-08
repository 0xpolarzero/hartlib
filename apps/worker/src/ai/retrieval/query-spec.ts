export type SearchOrderBy = "relevance" | "recency";

export interface QuerySpec {
  readonly terms: string;
  readonly sourceIds?: readonly string[] | undefined;
  readonly countries?: readonly string[] | undefined;
  readonly languages?: readonly string[] | undefined;
  readonly documentTypes?: readonly string[] | undefined;
  readonly publishedAfter?: string | undefined;
  readonly publishedBefore?: string | undefined;
  readonly orderBy?: SearchOrderBy | undefined;
  readonly limit?: number | undefined;
}

export type SourceAccess =
  | { readonly kind: "allPublicSources" }
  | { readonly kind: "sourceIds"; readonly sourceIds: readonly string[] };

export interface DocumentPreview {
  readonly documentId: string;
  readonly title: string;
  readonly sourceDisplayName: string;
  readonly publishedAt: Date | null;
  readonly language: string;
  readonly documentType: string;
  readonly textCharCount: number;
  readonly estimatedTokens: number;
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

export const estimateTokens = (charCount: number): number => Math.ceil(charCount / 4);
