import {
  canonicalPublicSourceHttpsUrl,
  isCanonicalPublicDocumentSourceId,
  isCanonicalPublisherDocumentSourceId,
  type AiRunDescriptor,
  type AssistantChatMessage,
  type PublicCitationRecord,
  type PublicSourceRecord,
  type UserChatMessage,
} from "@brief/shared";

import type { MessageRow, RunRow, SourceRow, SourceUseRow } from "./chat-runtime";

/** Indexed fields selected by chat-runtime for exact durable document replay. */
type IndexedDocumentSourceRow = SourceRow & {
  readonly source_id?: string | null;
  readonly canonical_url?: string | null;
  readonly document_id?: string | null;
  readonly version_id?: string | null;
  readonly content_hash?: string | null;
};

const indexedDocumentRow = (row: SourceRow): IndexedDocumentSourceRow =>
  row as IndexedDocumentSourceRow;

const assertSourceIdentityDigest = (row: SourceRow): void => {
  if (row.source_identity_valid === false) {
    throw new Error("persisted source identity digest mismatch");
  }
  if (
    row.source_identity_valid !== true ||
    !/^[0-9a-f]{64}$/u.test(row.source_identity_digest ?? "")
  ) {
    throw new Error("invalid persisted source identity digest");
  }
};

const assertSourceUseIdentityDigest = (row: SourceUseRow): void => {
  if (row.source_use_identity_valid === false) {
    throw new Error("persisted source use identity digest mismatch");
  }
  if (
    row.source_use_identity_valid !== true ||
    !/^[0-9a-f]{64}$/u.test(row.source_use_identity_digest ?? "")
  ) {
    throw new Error("invalid persisted source use identity digest");
  }
};

const strictRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid persisted ${label}`);
  }
  return value as Record<string, unknown>;
};

const assertExactKeys = (
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void => {
  const allowedKeys = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new Error(`invalid persisted ${label}`);
  }
};

const parsePublicProvenance = (value: unknown): Record<string, unknown> => {
  const record = strictRecord(value, "source public provenance");
  assertExactKeys(
    record,
    ["sourceName", "issueTitle", "documentTitle", "citationUrl", "publishedAt"],
    "source public provenance",
  );
  for (const key of Object.keys(record)) {
    if (typeof record[key] !== "string") {
      throw new Error(`invalid persisted source public provenance`);
    }
  }
  return record;
};

const requiredString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid persisted source ${key}`);
  }
  return value;
};

const optionalString = (record: Record<string, unknown>, key: string): string | undefined => {
  if (!(key in record) || record[key] === undefined) return undefined;
  if (typeof record[key] === "string") return record[key];
  throw new Error(`invalid persisted source ${key}`);
};

const requiredNonBlankString = (record: Record<string, unknown>, key: string): string => {
  const value = requiredString(record, key);
  if (value.trim() === "") throw new Error(`invalid persisted source ${key}`);
  return value;
};

const sourceKeyParts = (
  sourceKey: string,
): { readonly namespace: string; readonly ordinal: number } => {
  const match = /^k_(cn_[A-Za-z0-9_-]{22})_([1-9][0-9]*)$/u.exec(sourceKey);
  if (match === null) throw new Error("invalid persisted source key");
  const ordinal = Number(match[2]);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new Error("invalid persisted source key ordinal");
  }
  return { namespace: match[1]!, ordinal };
};

const sourceOrdinalFromKey = (sourceKey: string): number => sourceKeyParts(sourceKey).ordinal;

const assertRunCitationNamespace = (source: SourceRow): void => {
  const citationNamespace = source.citation_namespace;
  if (!/^cn_[A-Za-z0-9_-]{22}$/u.test(citationNamespace)) {
    throw new Error("invalid persisted citation namespace");
  }
  if (sourceKeyParts(source.source_key).namespace !== citationNamespace) {
    throw new Error("persisted source key namespace mismatch");
  }
};

const compareSourceKeys = (left: string, right: string): number =>
  sourceOrdinalFromKey(left) - sourceOrdinalFromKey(right) || left.localeCompare(right, "en");

const publisherDocumentContentPath =
  /^\/v1\/issues\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/documents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/content$/u;

const requiredPublicCitationUrl = (record: Record<string, unknown>, key: string): string => {
  const value = requiredString(record, key);
  if (canonicalPublicSourceHttpsUrl(value) === value) return value;
  throw new Error(`invalid persisted source ${key}`);
};

const requiredDocumentCitationUrl = (
  row: SourceRow,
  locator: Record<string, unknown>,
  provenance: Record<string, unknown>,
): string => {
  const indexed = indexedDocumentRow(row);
  const indexedSourceId = indexed.source_id;
  const sourceId = requiredNonBlankString(locator, "sourceId");
  if (indexedSourceId === undefined || indexedSourceId === null || sourceId !== indexedSourceId) {
    throw new Error("invalid persisted document source identity");
  }
  const value = requiredString(provenance, "citationUrl");
  const publisherIssueValue = locator.publisherIssueId;
  const publisherDocumentValue = locator.publisherDocumentId;
  const hasPublisherIssue = typeof publisherIssueValue === "string";
  const hasPublisherDocument = typeof publisherDocumentValue === "string";
  if (hasPublisherIssue !== hasPublisherDocument) {
    throw new Error("invalid persisted publisher document provenance");
  }
  const indexedPublisherExtractionId = row.publisher_extraction_id;
  const indexedPublisherDocument = row.publisher_document_id ?? null;
  const indexedPublisherIssue = row.publisher_issue_id ?? null;
  if (!hasPublisherIssue) {
    if (
      indexedPublisherExtractionId !== null ||
      Object.hasOwn(locator, "publisherExtractionId") ||
      indexedPublisherDocument !== null ||
      indexedPublisherIssue !== null
    ) {
      throw new Error("invalid persisted publisher document provenance");
    }
    const documentId = indexed.document_id;
    const versionId = indexed.version_id;
    const contentHash = indexed.content_hash;
    const canonicalUrl = indexed.canonical_url;
    if (
      isCanonicalPublicDocumentSourceId(sourceId) &&
      documentId !== null &&
      documentId !== undefined &&
      versionId !== null &&
      versionId !== undefined &&
      contentHash !== null &&
      contentHash !== undefined &&
      canonicalUrl !== null &&
      canonicalUrl !== undefined &&
      locator.documentId === documentId &&
      locator.versionId === versionId &&
      locator.contentHash === contentHash &&
      value === canonicalUrl &&
      canonicalPublicSourceHttpsUrl(canonicalUrl) === canonicalUrl
    ) {
      return value;
    }
    throw new Error("invalid persisted source citationUrl");
  }

  const versionId = requiredString(locator, "versionId");
  const documentId = requiredString(locator, "documentId");
  const publisherIssueId = requiredString(locator, "publisherIssueId");
  const publisherDocumentId = requiredString(locator, "publisherDocumentId");
  const expected = `/v1/issues/${publisherIssueId}/documents/${publisherDocumentId}/content`;
  if (
    !isCanonicalPublisherDocumentSourceId(sourceId) ||
    indexed.document_id !== documentId ||
    indexed.version_id !== versionId ||
    indexed.content_hash !== locator.contentHash ||
    indexedPublisherExtractionId === null ||
    indexedPublisherDocument !== publisherDocumentId ||
    indexedPublisherIssue !== publisherIssueId ||
    publisherDocumentId !== documentId ||
    !publisherDocumentContentPath.test(value) ||
    value !== expected
  ) {
    throw new Error("invalid persisted publisher document provenance");
  }
  return value;
};

const normalizeWebQuote = (quote: string): string =>
  quote.normalize("NFC").replace(/\r\n?/g, "\n").trim();

const sha256RoundConstants = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

const base64Url = (bytes: Uint8Array): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    result += alphabet[first >>> 2];
    result += alphabet[((first & 3) << 4) | ((second ?? 0) >>> 4)];
    if (second !== undefined) result += alphabet[((second & 15) << 2) | ((third ?? 0) >>> 6)];
    if (third !== undefined) result += alphabet[third & 63];
  }
  return result;
};

const sha256Base64Url = (value: string): string => {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const bitLength = input.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLength >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_0000_0000));

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const rotate = (value: number, amount: number): number =>
    (value >>> amount) | (value << (32 - amount));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const value = words[index - 15]!;
      const sigma0 = rotate(value, 7) ^ rotate(value, 18) ^ (value >>> 3);
      const previous = words[index - 2]!;
      const sigma1 = rotate(previous, 17) ^ rotate(previous, 19) ^ (previous >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choice + sha256RoundConstants[index]! + words[index]!) >>> 0;
      const sigma0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((value, index) =>
    digestView.setUint32(index * 4, value),
  );
  return base64Url(digest);
};

const webQuoteHash = (quote: string): string => sha256Base64Url(normalizeWebQuote(quote));

const rangesFrom = (value: unknown): PublicSourceRecord["ranges"] => {
  if (!Array.isArray(value)) throw new Error("invalid persisted source ranges");
  if (value.length === 0) throw new Error("invalid persisted source ranges");
  const ranges = value.map((entry) => {
    const range = strictRecord(entry, "source range");
    assertExactKeys(range, ["pageNumber", "charStart", "charEnd"], "source range");
    if (
      typeof range.charStart !== "number" ||
      !Number.isSafeInteger(range.charStart) ||
      range.charStart < 0 ||
      typeof range.charEnd !== "number" ||
      !Number.isSafeInteger(range.charEnd) ||
      range.charEnd <= range.charStart ||
      (range.pageNumber !== undefined &&
        (typeof range.pageNumber !== "number" ||
          !Number.isSafeInteger(range.pageNumber) ||
          range.pageNumber < 1))
    ) {
      throw new Error("invalid persisted source range");
    }
    return {
      ...(typeof range.pageNumber === "number" ? { pageNumber: range.pageNumber } : {}),
      charStart: range.charStart,
      charEnd: range.charEnd,
    };
  });
  const page = (range: (typeof ranges)[number]): number => range.pageNumber ?? 0;
  const compare = (left: (typeof ranges)[number], right: (typeof ranges)[number]): number =>
    page(left) - page(right) || left.charStart - right.charStart || left.charEnd - right.charEnd;
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index]!;
    if (index > 0) {
      const previous = ranges[index - 1]!;
      if (
        compare(previous, range) >= 0 ||
        (page(previous) === page(range) && range.charStart <= previous.charEnd)
      ) {
        throw new Error("invalid persisted source ranges");
      }
    }
  }
  const ordered = [...ranges].sort(compare);
  if (ordered.some((range, index) => range !== ranges[index])) {
    throw new Error("invalid persisted source ranges");
  }
  return ranges;
};

type PersistedSourceRange = PublicSourceRecord["ranges"][number];

const pageNumberOf = (range: PersistedSourceRange): number => range.pageNumber ?? 0;

const normalizedRangeUnion = (
  ranges: readonly PersistedSourceRange[],
): readonly PersistedSourceRange[] => {
  const ordered = [...ranges].sort(
    (left, right) =>
      pageNumberOf(left) - pageNumberOf(right) ||
      left.charStart - right.charStart ||
      left.charEnd - right.charEnd,
  );
  const merged: PersistedSourceRange[] = [];
  for (const range of ordered) {
    const previous = merged[merged.length - 1];
    if (
      previous !== undefined &&
      pageNumberOf(previous) === pageNumberOf(range) &&
      range.charStart <= previous.charEnd
    ) {
      merged[merged.length - 1] = {
        ...previous,
        charEnd: Math.max(previous.charEnd, range.charEnd),
      };
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
};

const rangesExactlyEqual = (
  left: readonly PersistedSourceRange[],
  right: readonly PersistedSourceRange[],
): boolean =>
  left.length === right.length &&
  left.every((range, index) => {
    const candidate = right[index];
    return (
      candidate !== undefined &&
      pageNumberOf(range) === pageNumberOf(candidate) &&
      range.charStart === candidate.charStart &&
      range.charEnd === candidate.charEnd
    );
  });

const nonDocumentUseRanges = (uses: readonly SourceUseRow[]): void => {
  for (const use of uses) {
    if (!Array.isArray(use.ranges) || use.ranges.length !== 0) {
      throw new Error("invalid persisted source use ranges");
    }
  }
};

const documentUseRanges = (
  locatorRanges: PublicSourceRecord["ranges"],
  uses: readonly SourceUseRow[],
): void => {
  const allUseRanges: PersistedSourceRange[] = [];
  for (const use of uses) {
    if (!Array.isArray(use.ranges)) {
      throw new Error("invalid persisted source use ranges");
    }
    const ranges = rangesFrom(use.ranges);
    allUseRanges.push(...ranges);
    for (const range of ranges) {
      if (
        !locatorRanges.some(
          (locatorRange) =>
            pageNumberOf(locatorRange) === pageNumberOf(range) &&
            range.charStart >= locatorRange.charStart &&
            range.charEnd <= locatorRange.charEnd,
        )
      ) {
        throw new Error("persisted source use range exceeds source locator");
      }
    }
  }
  if (
    !rangesExactlyEqual(normalizedRangeUnion(locatorRanges), normalizedRangeUnion(allUseRanges))
  ) {
    throw new Error("persisted source use ranges do not cover source locator");
  }
};

const validateUseOwnership = (use: SourceUseRow): string => {
  const consumerTaskId = use.consumer_task_id;
  if (typeof consumerTaskId !== "string" || consumerTaskId.trim() === "") {
    throw new Error("invalid persisted source use consumer");
  }
  if (consumerTaskId === "single-answer") {
    if (use.topic_id !== null) throw new Error("invalid persisted source use topic ownership");
    return consumerTaskId;
  }
  const topicConsumer = /^topic-(t1|t2|t3)-answer$/u.exec(consumerTaskId);
  if (topicConsumer === null || use.topic_id !== topicConsumer[1]) {
    throw new Error("invalid persisted source use topic ownership");
  }
  return consumerTaskId;
};

const validateConsumerContextOrders = (uses: readonly SourceUseRow[]): void => {
  const byConsumer = new Map<string, SourceUseRow[]>();
  const modeByAssistantMessage = new Map<string, "single" | "topic">();
  for (const use of uses) {
    const consumerTaskId = validateUseOwnership(use);
    const mode = consumerTaskId === "single-answer" ? "single" : "topic";
    const assistantMode = modeByAssistantMessage.get(use.assistant_message_id);
    if (assistantMode !== undefined && assistantMode !== mode) {
      throw new Error("persisted source use mixes consumer modes");
    }
    modeByAssistantMessage.set(use.assistant_message_id, mode);
    const ledgerKey = `${use.assistant_message_id}\u0000${consumerTaskId}`;
    const consumerUses = byConsumer.get(ledgerKey) ?? [];
    consumerUses.push(use);
    byConsumer.set(ledgerKey, consumerUses);
  }
  for (const consumerUses of byConsumer.values()) {
    consumerUses.sort((left, right) => left.context_order - right.context_order);
    for (const [index, use] of consumerUses.entries()) {
      if (use.context_order !== index) {
        throw new Error("persisted source use context order is not contiguous");
      }
    }
  }
};

const topicOrder = { t1: 1, t2: 2, t3: 3 } as const;

const publicSourceFromRow = (row: SourceRow, uses: readonly SourceUseRow[]): PublicSourceRecord => {
  sourceOrdinalFromKey(row.source_key);
  assertRunCitationNamespace(row);
  const locator = strictRecord(row.locator, "source locator");
  const provenance = parsePublicProvenance(row.public_provenance);
  if (locator.kind !== row.kind) throw new Error("persisted source locator kind mismatch");
  const topicIds = [
    ...new Set(uses.flatMap((use) => (use.topic_id === null ? [] : [use.topic_id]))),
  ].sort((left, right) => topicOrder[left] - topicOrder[right]);
  const base = {
    sourceKey: row.source_key,
    label: row.display_label,
    tokenCount: uses.reduce((sum, use) => sum + use.rendered_token_count, 0),
    topicIds,
  } as const;

  switch (row.kind) {
    case "document":
      assertExactKeys(
        locator,
        [
          "kind",
          "sourceId",
          "documentId",
          "versionId",
          "contentHash",
          "ranges",
          "publisherExtractionId",
          "publisherIssueId",
          "publisherDocumentId",
        ],
        "source locator",
      );
      const hasPublisherTuple =
        typeof locator.publisherIssueId === "string" ||
        typeof locator.publisherDocumentId === "string" ||
        (row.publisher_extraction_id !== null && row.publisher_extraction_id !== undefined) ||
        (row.publisher_document_id !== null && row.publisher_document_id !== undefined) ||
        (row.publisher_issue_id !== null && row.publisher_issue_id !== undefined);
      if (hasPublisherTuple) {
        if (locator.publisherExtractionId !== row.publisher_extraction_id) {
          throw new Error("invalid persisted publisher document provenance");
        }
        const sourceName = requiredNonBlankString(provenance, "sourceName");
        const issueTitle = requiredNonBlankString(provenance, "issueTitle");
        const publishedAt = requiredNonBlankString(provenance, "publishedAt");
        if (!Number.isFinite(Date.parse(publishedAt))) {
          throw new Error("invalid persisted source publishedAt");
        }
        return {
          ...base,
          kind: "document",
          sourceName,
          issueTitle,
          documentTitle: requiredNonBlankString(provenance, "documentTitle"),
          url: requiredDocumentCitationUrl(row, locator, provenance),
          publishedAt,
          ranges: (() => {
            const ranges = rangesFrom(locator.ranges);
            documentUseRanges(ranges, uses);
            return ranges;
          })(),
        };
      }
      return {
        ...base,
        kind: "document",
        ...(optionalString(provenance, "sourceName") === undefined
          ? {}
          : { sourceName: optionalString(provenance, "sourceName") }),
        ...(optionalString(provenance, "issueTitle") === undefined
          ? {}
          : { issueTitle: optionalString(provenance, "issueTitle") }),
        documentTitle: requiredNonBlankString(provenance, "documentTitle"),
        url: requiredDocumentCitationUrl(row, locator, provenance),
        ...(optionalString(provenance, "publishedAt") === undefined
          ? {}
          : { publishedAt: optionalString(provenance, "publishedAt") }),
        ranges: (() => {
          const ranges = rangesFrom(locator.ranges);
          documentUseRanges(ranges, uses);
          return ranges;
        })(),
      };
    case "chat_message":
      assertExactKeys(locator, ["kind", "messageId"], "source locator");
      if (Object.keys(provenance).length !== 0) {
        throw new Error("invalid persisted chat message provenance");
      }
      nonDocumentUseRanges(uses);
      return {
        ...base,
        kind: "chat_message",
        messageId: requiredString(locator, "messageId"),
        ranges: [],
      };
    case "memory":
      assertExactKeys(locator, ["kind", "memoryId", "memoryRevisionId"], "source locator");
      if (Object.keys(provenance).length !== 0) {
        throw new Error("invalid persisted memory provenance");
      }
      nonDocumentUseRanges(uses);
      return {
        ...base,
        kind: "memory",
        memoryId: requiredString(locator, "memoryId"),
        memoryRevisionId: requiredString(locator, "memoryRevisionId"),
        ranges: [],
      };
    case "web": {
      assertExactKeys(
        locator,
        ["kind", "url", "title", "domain", "quote", "quoteHash", "publishedAt", "capturedAt"],
        "source locator",
      );
      const title = requiredString(locator, "title");
      const domain = requiredString(locator, "domain");
      const url = requiredPublicCitationUrl(locator, "url");
      const quote = requiredString(locator, "quote");
      const quoteHash = requiredString(locator, "quoteHash");
      const capturedAt = requiredString(locator, "capturedAt");
      let hostname: string;
      try {
        hostname = new URL(url).hostname;
      } catch {
        throw new Error("invalid persisted source web URL");
      }
      if (
        title.trim() === "" ||
        domain.trim() === "" ||
        hostname !== domain ||
        normalizeWebQuote(quote) !== quote ||
        normalizeWebQuote(quote) === "" ||
        webQuoteHash(quote) !== quoteHash ||
        !Number.isFinite(Date.parse(capturedAt)) ||
        requiredPublicCitationUrl(provenance, "citationUrl") !== url
      ) {
        throw new Error("invalid persisted source web provenance");
      }
      nonDocumentUseRanges(uses);
      return {
        ...base,
        kind: "web",
        title,
        domain,
        url,
        ...(optionalString(locator, "publishedAt") === undefined
          ? {}
          : { publishedAt: optionalString(locator, "publishedAt") }),
        capturedAt,
        quote,
        ranges: [],
      };
    }
  }
};

const citationFromSource = (source: PublicSourceRecord): PublicCitationRecord => {
  const { tokenCount: _tokenCount, topicIds: _topicIds, ...citation } = source;
  return citation;
};

const citationTagPattern = /\[\[cite:([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*)\]\]/gu;

const citationsForContent = (
  content: string,
  sources: readonly PublicSourceRecord[],
): readonly PublicCitationRecord[] => {
  const sourceByKey = new Map(sources.map((source) => [source.sourceKey, source]));
  const citations: PublicCitationRecord[] = [];
  for (const match of content.matchAll(citationTagPattern)) {
    const keys = match[1]?.split(",") ?? [];
    for (const key of keys) {
      const source = sourceByKey.get(key);
      if (source !== undefined && !citations.some((citation) => citation.sourceKey === key)) {
        citations.push(citationFromSource(source));
      }
    }
  }
  return citations;
};

export const runDescriptor = (run: Pick<RunRow, "id" | "started_at">): AiRunDescriptor => ({
  id: run.id,
  status: run.started_at === null ? "queued" : "running",
  streamPath: `/v1/ai-runs/${encodeURIComponent(run.id)}/stream`,
});

const runOutcome = (run: RunRow): UserChatMessage["run"] => {
  if (run.finished_at !== null) {
    return { id: run.id, status: "succeeded", finishedAt: run.finished_at.toISOString() };
  }
  if (run.failed_at !== null) {
    return {
      id: run.id,
      status: "failed",
      errorCode: run.error_code ?? "internal_error",
      retryable: run.retryable === true,
      failedAt: run.failed_at.toISOString(),
    };
  }
  return run.started_at === null
    ? { id: run.id, status: "queued" }
    : { id: run.id, status: "running" };
};

export const chatMessagesResponseFromRows = (
  messages: readonly MessageRow[],
  runs: readonly RunRow[],
  sourceRows: readonly SourceRow[],
  useRows: readonly SourceUseRow[],
): readonly (UserChatMessage | AssistantChatMessage)[] => {
  const runsByUserMessage = new Map(runs.map((run) => [run.user_message_id, run]));
  const assistantMessageIds = new Set(
    messages.filter((message) => message.author === "assistant").map((message) => message.id),
  );
  const sourceByIdentity = new Map<string, SourceRow>();
  for (const sourceRow of sourceRows) {
    if (!assistantMessageIds.has(sourceRow.assistant_message_id)) {
      throw new Error("persisted source does not belong to an assistant message");
    }
    const identity = `${sourceRow.assistant_message_id}\u0000${sourceRow.source_key}`;
    if (sourceByIdentity.has(identity)) {
      throw new Error("duplicate persisted source key");
    }
    sourceByIdentity.set(identity, sourceRow);
  }
  const usesByIdentity = new Map<string, SourceUseRow[]>();
  const useCoordinates = new Set<string>();
  const sourceConsumers = new Set<string>();
  for (const use of useRows) {
    if (use.topic_id !== null && !(use.topic_id in topicOrder)) {
      throw new Error("invalid persisted source use topic");
    }
    if (
      !Number.isSafeInteger(use.rendered_token_count) ||
      use.rendered_token_count < 0 ||
      !Number.isSafeInteger(use.context_order) ||
      use.context_order < 0
    ) {
      throw new Error("invalid persisted source use metrics");
    }
    const identity = `${use.assistant_message_id}\u0000${use.source_key}`;
    if (!sourceByIdentity.has(identity)) {
      throw new Error("persisted source use has no source");
    }
    const consumerTaskId = validateUseOwnership(use);
    assertSourceUseIdentityDigest(use);
    const sourceConsumer = `${identity}\u0000${consumerTaskId}`;
    if (sourceConsumers.has(sourceConsumer)) {
      throw new Error("duplicate persisted source use consumer");
    }
    sourceConsumers.add(sourceConsumer);
    const coordinate = `${identity}\u0000${use.consumer_task_id ?? ""}\u0000${use.topic_id ?? ""}\u0000${use.context_order}`;
    if (useCoordinates.has(coordinate)) {
      throw new Error("duplicate persisted source use coordinate");
    }
    useCoordinates.add(coordinate);
    const uses = usesByIdentity.get(identity) ?? [];
    uses.push(use);
    usesByIdentity.set(identity, uses);
  }
  validateConsumerContextOrders(useRows);
  for (const sourceRow of sourceRows) {
    const identity = `${sourceRow.assistant_message_id}\u0000${sourceRow.source_key}`;
    if ((usesByIdentity.get(identity)?.length ?? 0) === 0) {
      throw new Error("persisted source has no source use");
    }
  }
  const sourcesByAssistantMessage = new Map<string, PublicSourceRecord[]>();
  for (const sourceRow of sourceRows) {
    sourceOrdinalFromKey(sourceRow.source_key);
    assertRunCitationNamespace(sourceRow);
    const uses = [
      ...usesByIdentity.get(`${sourceRow.assistant_message_id}\u0000${sourceRow.source_key}`)!,
    ].sort((left, right) => left.context_order - right.context_order);
    const source = publicSourceFromRow(sourceRow, uses);
    assertSourceIdentityDigest(sourceRow);
    const rows = sourcesByAssistantMessage.get(sourceRow.assistant_message_id) ?? [];
    rows.push(source);
    sourcesByAssistantMessage.set(sourceRow.assistant_message_id, rows);
  }
  for (const [assistantMessageId, sources] of sourcesByAssistantMessage) {
    sources.sort((left, right) => {
      const firstUse = (sourceKey: string) =>
        useRows
          .filter(
            (use) =>
              use.assistant_message_id === assistantMessageId && use.source_key === sourceKey,
          )
          .map((use) => ({
            topic: use.topic_id === null ? 0 : topicOrder[use.topic_id],
            order: use.context_order,
          }))
          .sort((a, b) => a.topic - b.topic || a.order - b.order)[0] ?? {
          topic: Number.MAX_SAFE_INTEGER,
          order: Number.MAX_SAFE_INTEGER,
        };
      const leftOrder = firstUse(left.sourceKey);
      const rightOrder = firstUse(right.sourceKey);
      return (
        leftOrder.topic - rightOrder.topic ||
        leftOrder.order - rightOrder.order ||
        compareSourceKeys(left.sourceKey, right.sourceKey)
      );
    });
  }
  return [...messages]
    .sort(
      (left, right) =>
        left.created_at.getTime() - right.created_at.getTime() || left.id.localeCompare(right.id),
    )
    .map((message) => {
      if (message.author === "user") {
        const run = runsByUserMessage.get(message.id);
        if (run === undefined) throw new Error("user chat message has no durable run outcome");
        return {
          id: message.id,
          author: "user" as const,
          content: message.content,
          createdAt: message.created_at.toISOString(),
          run: runOutcome(run),
        };
      }
      const sourcesRead = sourcesByAssistantMessage.get(message.id) ?? [];
      return {
        id: message.id,
        author: "assistant" as const,
        content: message.content,
        createdAt: message.created_at.toISOString(),
        citations: citationsForContent(message.content, sourcesRead),
        sourcesRead,
      };
    });
};
