import { createHash, randomBytes } from "node:crypto";

import type { MemoryExtractionResult } from "./types";

export type TopicId = "t1" | "t2" | "t3";
export type SelectorDomain = "internal" | "memory" | "web";

export interface CharacterRange {
  readonly charStart: number;
  readonly charEnd: number;
}

export interface RankedCandidateIdentity {
  readonly topicId?: TopicId | undefined;
  readonly domain: SelectorDomain;
  readonly rank: number;
  readonly identity: string;
}

export class CanonicalizationError extends Error {
  readonly code:
    | "invalid_citation_namespace"
    | "invalid_source_ordinal"
    | "invalid_url"
    | "invalid_range"
    | "invalid_candidate_rank";

  constructor(code: CanonicalizationError["code"], message: string) {
    super(message);
    this.name = "CanonicalizationError";
    this.code = code;
  }
}

/**
 * A run citation namespace is exactly 128 random bits. Its public spelling is
 * unpadded base64url, which is always 22 characters for a 16-byte input.
 */
export const createCitationNamespace = (): string => `cn_${randomBytes(16).toString("base64url")}`;

export const encodeCitationNamespace = (nonce: Uint8Array): string => {
  if (nonce.byteLength !== 16) {
    throw new CanonicalizationError(
      "invalid_citation_namespace",
      "citation namespace seed must contain exactly 16 bytes",
    );
  }

  return `cn_${Buffer.from(nonce).toString("base64url")}`;
};

export const sourceKeyForOrdinal = (nonce: Uint8Array, ordinal: number): string => {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new CanonicalizationError(
      "invalid_source_ordinal",
      "source ordinal must be a positive safe integer",
    );
  }

  return `k_${encodeCitationNamespace(nonce)}_${ordinal}`;
};

export const sourceKeyForNamespace = (namespace: string, ordinal: number): string => {
  if (!/^cn_[A-Za-z0-9_-]{22}$/u.test(namespace)) {
    throw new CanonicalizationError(
      "invalid_citation_namespace",
      "citation namespace must match the final handle namespace",
    );
  }
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new CanonicalizationError(
      "invalid_source_ordinal",
      "source ordinal must be a positive safe integer",
    );
  }
  return `k_${namespace}_${ordinal}`;
};

export const sourceOrdinalFromKey = (sourceKey: string): number => {
  const match = /^k_cn_[A-Za-z0-9_-]{22}_([1-9][0-9]*)$/.exec(sourceKey);
  const ordinal = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new CanonicalizationError("invalid_source_ordinal", "source key has no valid ordinal");
  }
  return ordinal;
};

export const compareSourceKeys = (left: string, right: string): number => {
  const leftOrdinal = sourceOrdinalFromKey(left);
  const rightOrdinal = sourceOrdinalFromKey(right);
  return leftOrdinal - rightOrdinal || left.localeCompare(right, "en");
};

/**
 * URL identity preserves path and query octets because changing them can
 * change the represented resource. Parsing deterministically normalizes IDNA,
 * dot segments, hostname case, and default ports. Fragments are presentation
 * state and are excluded from fetch/citation identity.
 */
export const canonicalizeWebUrl = (input: string): string => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CanonicalizationError("invalid_url", "web URL must be absolute and parseable");
  }

  if (url.protocol !== "https:") {
    throw new CanonicalizationError("invalid_url", "web URL must use HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new CanonicalizationError("invalid_url", "web URL must not contain credentials");
  }

  url.hash = "";
  return url.href;
};

/**
 * Quote identity is based on the exact selected quotation after transport-only
 * normalization: Unicode NFC, CRLF/CR to LF, and removal of outer whitespace.
 * Whitespace inside the quotation is evidence and is never collapsed.
 */
export const normalizeWebQuote = (quote: string): string =>
  quote.normalize("NFC").replace(/\r\n?/g, "\n").trim();

/**
 * Prior-turn presentation keys belong to a different random nonce namespace.
 * Remove every citation-shaped span before historical assistant text is shown
 * to any current-turn model. An unterminated span is removed through EOF so a
 * stale key can never leak merely because the old response was malformed.
 */
export const stripHistoricalCitationTags = (value: string): string => {
  let cursor = 0;
  let sanitized = "";
  while (true) {
    const start = value.indexOf("[[cite:", cursor);
    if (start < 0) return sanitized + value.slice(cursor);
    sanitized += value.slice(cursor, start);
    const end = value.indexOf("]]", start + 7);
    if (end < 0) return sanitized;
    cursor = end + 2;
  }
};

export const sha256Base64Url = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("base64url");

export const canonicalMemoryExtraction = (
  result: MemoryExtractionResult,
): MemoryExtractionResult => ({
  proposals: result.proposals.map((proposal) => ({
    kind: proposal.kind,
    content: proposal.content.trim(),
    ...(proposal.targetMemoryId === undefined ? {} : { targetMemoryId: proposal.targetMemoryId }),
    ...(proposal.expectedHeadRevisionId === undefined
      ? {}
      : { expectedHeadRevisionId: proposal.expectedHeadRevisionId }),
  })),
  discardedCount: result.discardedCount,
});

export const memoryExtractionSha256Hex = (result: MemoryExtractionResult): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalMemoryExtraction(result)), "utf8")
    .digest("hex");

export const webQuoteHash = (quote: string): string => sha256Base64Url(normalizeWebQuote(quote));

export const webEvidenceIdentity = (url: string, quote: string): string =>
  `web:${canonicalizeWebUrl(url)}:${webQuoteHash(quote)}`;

export const documentEvidenceIdentity = (documentId: string): string => `document:${documentId}`;
export type DocumentEvidenceNamespace = { readonly kind: "public"; readonly sourceId: string };

/** Includes the literal namespace discriminator and length-safe JSON fields. */
export const namespacedDocumentEvidenceIdentity = (
  namespace: DocumentEvidenceNamespace,
  documentId: string,
): string =>
  documentEvidenceIdentity(
    `namespace:${namespace.kind}:${JSON.stringify([namespace.sourceId, documentId])}`,
  );
export const chatMessageEvidenceIdentity = (messageId: string): string =>
  `chat_message:${messageId}`;
export const memoryEvidenceIdentity = (memoryId: string): string => `memory:${memoryId}`;

const topicOrder = (topicId: TopicId | undefined): number => {
  switch (topicId) {
    case undefined:
      return 0;
    case "t1":
      return 1;
    case "t2":
      return 2;
    case "t3":
      return 3;
  }
};

const domainOrder = (domain: SelectorDomain): number => {
  switch (domain) {
    case "internal":
      return 0;
    case "memory":
      return 1;
    case "web":
      return 2;
  }
};

/** Stable manifest order: path topic, selector domain, selector rank, identity. */
export const compareRankedCandidates = (
  left: RankedCandidateIdentity,
  right: RankedCandidateIdentity,
): number => {
  if (!Number.isSafeInteger(left.rank) || left.rank < 0) {
    throw new CanonicalizationError(
      "invalid_candidate_rank",
      "candidate rank must be non-negative",
    );
  }
  if (!Number.isSafeInteger(right.rank) || right.rank < 0) {
    throw new CanonicalizationError(
      "invalid_candidate_rank",
      "candidate rank must be non-negative",
    );
  }

  return (
    topicOrder(left.topicId) - topicOrder(right.topicId) ||
    domainOrder(left.domain) - domainOrder(right.domain) ||
    left.rank - right.rank ||
    left.identity.localeCompare(right.identity, "en")
  );
};

export const orderRankedCandidates = <Candidate extends RankedCandidateIdentity>(
  candidates: readonly Candidate[],
): readonly Candidate[] => [...candidates].sort(compareRankedCandidates);

/**
 * Validates, sorts, de-duplicates, and unions overlapping or directly adjacent
 * character ranges. A separated gap is never bridged.
 */
export const normalizeCharacterRanges = (
  ranges: readonly CharacterRange[],
  textCharCount: number,
): readonly CharacterRange[] => {
  if (!Number.isSafeInteger(textCharCount) || textCharCount < 0) {
    throw new CanonicalizationError("invalid_range", "text length must be a non-negative integer");
  }

  const ordered = ranges.map((range) => {
    if (
      !Number.isSafeInteger(range.charStart) ||
      !Number.isSafeInteger(range.charEnd) ||
      range.charStart < 0 ||
      range.charEnd <= range.charStart ||
      range.charEnd > textCharCount
    ) {
      throw new CanonicalizationError("invalid_range", "source range is outside immutable text");
    }
    return { charStart: range.charStart, charEnd: range.charEnd };
  });
  ordered.sort((a, b) => a.charStart - b.charStart || a.charEnd - b.charEnd);

  const normalized: CharacterRange[] = [];
  for (const range of ordered) {
    const previous = normalized.at(-1);
    if (previous === undefined || range.charStart > previous.charEnd) {
      normalized.push(range);
      continue;
    }
    normalized[normalized.length - 1] = {
      charStart: previous.charStart,
      charEnd: Math.max(previous.charEnd, range.charEnd),
    };
  }
  return normalized;
};

/**
 * "Large document" is not a character threshold. A full candidate requires an
 * explicit narrower range exactly when its complete, provider-rendered
 * inspection response exceeds that tool response's exact token allowance.
 */
export const requiresExplicitInspectionRange = (
  fullRenderedResponseTokens: number,
  completeResponseAllowanceTokens: number,
): boolean => {
  if (
    !Number.isSafeInteger(fullRenderedResponseTokens) ||
    fullRenderedResponseTokens < 0 ||
    !Number.isSafeInteger(completeResponseAllowanceTokens) ||
    completeResponseAllowanceTokens < 0
  ) {
    throw new CanonicalizationError(
      "invalid_range",
      "inspection token measurements must be non-negative integers",
    );
  }
  return fullRenderedResponseTokens > completeResponseAllowanceTokens;
};
