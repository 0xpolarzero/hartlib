import { parseRunAcceptanceScope, type RunAcceptanceScope } from "@hartlib/shared";
import { z } from "zod";

import type { Locale, Market } from "../runtime/types";
import { stripHistoricalCitationTags } from "../runtime/canonicalization";

export { stripHistoricalCitationTags };

/** A UTF-16 range into one immutable, sanitized text value. */
export interface SourceRange {
  readonly charStart: number;
  readonly charEnd: number;
}

export type CandidateKind =
  | "conversation_entry"
  | "document"
  | "chat_message"
  | "memory"
  | "web"
  | "topic_packet";
export type ChatRole = "user" | "assistant" | "system";

export type RunLocalId = `${"q" | "r" | "c" | "p" | "g"}${number}`;
export type RunLocalIdPrefix = "q" | "r" | "c" | "p" | "g";

export const runLocalId = (prefix: RunLocalIdPrefix, ordinal: number): RunLocalId => {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new Error("run-local ordinal must be a positive safe integer");
  }
  return `${prefix}${ordinal}`;
};

export const queryLocalId = (ordinal: number): `q${number}` =>
  runLocalId("q", ordinal) as `q${number}`;
export const resultLocalId = (ordinal: number): `r${number}` =>
  runLocalId("r", ordinal) as `r${number}`;
export const candidateLocalId = (ordinal: number): `c${number}` =>
  runLocalId("c", ordinal) as `c${number}`;
export const passageLocalId = (ordinal: number): `p${number}` =>
  runLocalId("p", ordinal) as `p${number}`;
export const groupLocalId = (ordinal: number): `g${number}` =>
  runLocalId("g", ordinal) as `g${number}`;

export const makeRunLocalId = runLocalId;

const validateRunLocalIdOrdinal = (value: string): boolean => {
  const ordinal = Number(value.slice(1));
  return Number.isSafeInteger(ordinal) && ordinal >= 1;
};

export const RunLocalIdSchema = z
  .string()
  .regex(/^[qrcpg][1-9][0-9]*$/u)
  .refine(validateRunLocalIdOrdinal, "run-local ordinal must be a positive safe integer");

export const StrictRunLocalIdSchema = RunLocalIdSchema.refine(
  validateRunLocalIdOrdinal,
  "run-local ordinal must be a positive safe integer",
);

export const QueryLocalIdSchema = StrictRunLocalIdSchema.regex(/^q[1-9][0-9]*$/u);
export const ResultLocalIdSchema = StrictRunLocalIdSchema.regex(/^r[1-9][0-9]*$/u);
export const CandidateLocalIdSchema = StrictRunLocalIdSchema.regex(/^c[1-9][0-9]*$/u);
export const PassageLocalIdSchema = StrictRunLocalIdSchema.regex(/^p[1-9][0-9]*$/u);
export const GroupLocalIdSchema = StrictRunLocalIdSchema.regex(/^g[1-9][0-9]*$/u);

export const isRunLocalId = (value: string, prefix?: RunLocalIdPrefix): value is RunLocalId => {
  const pattern = new RegExp(`^${prefix ?? "[qrcpg]"}[1-9][0-9]*$`, "u");
  return pattern.test(value) && validateRunLocalIdOrdinal(value);
};

/**
 * Code-owned evidence identity. These fields never cross the provider
 * boundary; the provider receives only the run-local candidate ID.
 */
export type CanonicalIdentity =
  | {
      readonly kind: "public_document";
      readonly sourceId: string;
      readonly documentId: string;
      readonly snapshotId: string;
      readonly contentHash: string;
    }
  | {
      readonly kind: "publisher_document";
      readonly subscriptionId: string;
      readonly issueId: string;
      readonly documentId: string;
      readonly snapshotId: string;
      readonly publisherExtractionId: string;
      readonly contentHash: string;
    }
  | {
      readonly kind: "chat_message";
      readonly messageId: string;
      readonly sanitizedContentHash: string;
    }
  | {
      readonly kind: "memory";
      readonly memoryId: string;
      readonly memoryRevisionId: string;
    }
  | {
      readonly kind: "web";
      readonly canonicalUrl: string;
      readonly quoteHash: string;
      readonly capturedAt: string;
    }
  | {
      readonly kind: "topic_packet";
      readonly topicId: "t1" | "t2" | "t3";
      readonly packetSha256Hex: string;
    }
  | {
      readonly kind: "conversation_entry";
      readonly turnId: string;
      readonly userMessageId: string;
      readonly assistantMessageId?: string | undefined;
    };

export type CandidateIdentity = CanonicalIdentity;

export const CANDIDATE_CONTRACT_LIMITS = {
  maxPreviewUtf8Bytes: 16 * 1024,
  maxLabelUtf8Bytes: 1024,
  maxPurposeUtf8Bytes: 4096,
  maxDateUtf8Bytes: 128,
} as const;

export function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (!isLowSurrogate(value.charCodeAt(index + 1))) return false;
      index += 1;
    } else if (isLowSurrogate(unit)) {
      return false;
    }
  }
  return true;
}

const nonEmptyText = z
  .string()
  .trim()
  .min(1)
  .refine(isWellFormedUtf16, "text must contain well-formed UTF-16");
const wellFormedText = z.string().refine(isWellFormedUtf16, "text must contain well-formed UTF-16");
const boundedText = (maxBytes: number) =>
  wellFormedText.refine(
    (value) => new TextEncoder().encode(value).byteLength <= maxBytes,
    "text is too large",
  );
const boundedNonEmptyText = (maxBytes: number) =>
  nonEmptyText.refine(
    (value) => new TextEncoder().encode(value).byteLength <= maxBytes,
    "text is too large",
  );

export interface CandidateProvenance {
  readonly label: string | null;
  readonly purpose: string;
  readonly date: string | null;
}

export const CandidateProvenanceSchema = z.strictObject({
  label: boundedText(CANDIDATE_CONTRACT_LIMITS.maxLabelUtf8Bytes).nullable(),
  purpose: boundedNonEmptyText(CANDIDATE_CONTRACT_LIMITS.maxPurposeUtf8Bytes),
  date: boundedText(CANDIDATE_CONTRACT_LIMITS.maxDateUtf8Bytes).nullable(),
});

export interface CandidateLedgerEntry {
  readonly candidateId: `c${number}`;
  readonly kind: CandidateKind;
  readonly identity: CanonicalIdentity;
  readonly provenance: CandidateProvenance;
  /** The complete sanitized immutable candidate text. */
  readonly text: string;
  /** Ranges authorized for this candidate before compaction. */
  readonly baseRanges: readonly SourceRange[];
  /** Optional exact preview ranges already shown to a provider. */
  readonly previewRanges: readonly SourceRange[];
  /** Closed message role used only for assistant-only citation sanitation. */
  readonly chatRole?: ChatRole | undefined;
  readonly preview: string;
  readonly renderedTokenCount: number;
}

export interface CandidateLedger {
  readonly candidates: readonly CandidateLedgerEntry[];
}

/** Provider-safe view. It intentionally contains no source, message, hash, or range identity. */
export interface ProviderCandidateView {
  readonly candidateId: `c${number}`;
  readonly kind: CandidateKind;
  readonly label: string | null;
  readonly purpose: string;
  readonly date: string | null;
  readonly renderedTokenCount: number;
  readonly preview: string;
}

export const toProviderCandidateView = (
  candidate: CandidateLedgerEntry,
): ProviderCandidateView => ({
  candidateId: candidate.candidateId,
  kind: candidate.kind,
  label: candidate.provenance.label,
  purpose: candidate.provenance.purpose,
  date: candidate.provenance.date,
  renderedTokenCount: candidate.renderedTokenCount,
  preview: candidate.preview,
});

const safeNonNegativeInt = z.number().int().finite().safe().min(0);
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

export const isUtf16Boundary = (text: string, offset: number): boolean =>
  Number.isSafeInteger(offset) &&
  offset >= 0 &&
  offset <= text.length &&
  (offset === 0 ||
    offset === text.length ||
    !(isHighSurrogate(text.charCodeAt(offset - 1)) && isLowSurrogate(text.charCodeAt(offset))));

export const canonicalIdentityTuple = (
  identity: CanonicalIdentity,
): readonly [string, ...string[]] => {
  const value = CandidateIdentitySchema.parse(identity);
  switch (value.kind) {
    case "public_document":
      return ["public_document", value.sourceId, value.documentId, value.snapshotId];
    case "publisher_document":
      return [
        "publisher_document",
        value.subscriptionId,
        value.issueId,
        value.documentId,
        value.snapshotId,
        value.publisherExtractionId,
      ];
    case "chat_message":
      return ["chat_message", value.messageId, value.sanitizedContentHash];
    case "memory":
      return ["memory", value.memoryId, value.memoryRevisionId];
    case "web":
      return ["web", value.canonicalUrl, value.quoteHash];
    case "topic_packet":
      return ["topic_packet", value.topicId, value.packetSha256Hex];
    case "conversation_entry":
      return ["conversation_entry", value.turnId];
  }
};

export const canonicalIdentityKey = (identity: CanonicalIdentity): string =>
  JSON.stringify(canonicalIdentityTuple(identity));

export const PREVIEW_RANGE_SEPARATOR = "\n…\n";

export const reconstructTextFromRanges = (
  text: string,
  ranges: readonly SourceRange[],
  separator = PREVIEW_RANGE_SEPARATOR,
): string => ranges.map((range) => text.slice(range.charStart, range.charEnd)).join(separator);

const validateRanges = (
  text: string,
  ranges: readonly SourceRange[],
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
): void => {
  let previousEnd = -1;
  for (const [index, range] of ranges.entries()) {
    if (
      range.charEnd > text.length ||
      !isUtf16Boundary(text, range.charStart) ||
      !isUtf16Boundary(text, range.charEnd)
    ) {
      context.addIssue({
        code: "custom",
        path: [...path, index],
        message: "range is out of bounds or splits a surrogate pair",
      });
    }
    if (range.charStart <= previousEnd) {
      context.addIssue({
        code: "custom",
        path: [...path, index],
        message: "ranges must be sorted, non-overlapping, and non-adjacent",
      });
    }
    previousEnd = range.charEnd;
  }
};

const rangesAreAuthorized = (
  baseRanges: readonly SourceRange[],
  previewRanges: readonly SourceRange[],
): boolean =>
  previewRanges.every((preview) =>
    baseRanges.some(
      (base) => preview.charStart >= base.charStart && preview.charEnd <= base.charEnd,
    ),
  );

const sourceRangeSchema = z
  .strictObject({
    charStart: safeNonNegativeInt,
    charEnd: z.number().int().finite().safe().positive(),
  })
  .superRefine((range, context) => {
    if (range.charEnd <= range.charStart) {
      context.addIssue({ code: "custom", message: "range end must be greater than start" });
    }
  });

export const SourceRangeSchema = sourceRangeSchema;

const candidateIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("public_document"),
    sourceId: nonEmptyText,
    documentId: nonEmptyText,
    snapshotId: nonEmptyText,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  z.strictObject({
    kind: z.literal("publisher_document"),
    subscriptionId: nonEmptyText,
    issueId: nonEmptyText,
    documentId: nonEmptyText,
    snapshotId: nonEmptyText,
    publisherExtractionId: nonEmptyText,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  z.strictObject({
    kind: z.literal("chat_message"),
    messageId: nonEmptyText,
    sanitizedContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  z.strictObject({
    kind: z.literal("memory"),
    memoryId: nonEmptyText,
    memoryRevisionId: nonEmptyText,
  }),
  z.strictObject({
    kind: z.literal("web"),
    canonicalUrl: z.string().url(),
    quoteHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    capturedAt: nonEmptyText,
  }),
  z.strictObject({
    kind: z.literal("topic_packet"),
    topicId: z.enum(["t1", "t2", "t3"]),
    packetSha256Hex: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  z.strictObject({
    kind: z.literal("conversation_entry"),
    turnId: nonEmptyText,
    userMessageId: nonEmptyText,
    assistantMessageId: nonEmptyText.optional(),
  }),
]);

export const CandidateIdentitySchema = candidateIdentitySchema;
export const CanonicalIdentitySchema = candidateIdentitySchema;

const CandidateLedgerEntryInputSchema = z.strictObject({
  candidateId: CandidateLocalIdSchema,
  kind: z.enum(["conversation_entry", "document", "chat_message", "memory", "web", "topic_packet"]),
  identity: candidateIdentitySchema,
  provenance: CandidateProvenanceSchema,
  text: wellFormedText,
  baseRanges: z.array(sourceRangeSchema),
  previewRanges: z.array(sourceRangeSchema),
  chatRole: z.enum(["user", "assistant", "system"]).optional(),
  preview: boundedText(CANDIDATE_CONTRACT_LIMITS.maxPreviewUtf8Bytes),
  renderedTokenCount: z.number().int().finite().safe().min(0),
});

const CandidateLedgerEntryValidatedSchema = CandidateLedgerEntryInputSchema.superRefine(
  (candidate, context) => {
    if (!isWellFormedUtf16(candidate.text)) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "candidate text must contain well-formed UTF-16",
      });
    }
    if (
      candidate.identity.kind !== candidate.kind &&
      !(
        candidate.kind === "document" &&
        (candidate.identity.kind === "public_document" ||
          candidate.identity.kind === "publisher_document")
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["identity", "kind"],
        message: "identity kind does not match candidate kind",
      });
    }
    if (candidate.identity.kind === "chat_message" && candidate.kind !== "chat_message") {
      context.addIssue({
        code: "custom",
        path: ["identity", "kind"],
        message: "chat identity requires a chat candidate",
      });
    }
    if (candidate.kind === "chat_message" && candidate.chatRole === undefined) {
      context.addIssue({
        code: "custom",
        path: ["chatRole"],
        message: "chat candidates require a closed chat role",
      });
    }
    if (candidate.kind !== "chat_message" && candidate.chatRole !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["chatRole"],
        message: "chat role is only valid for chat candidates",
      });
    }
    validateRanges(candidate.text, candidate.baseRanges, context, ["baseRanges"]);
    validateRanges(candidate.text, candidate.previewRanges, context, ["previewRanges"]);
    if (!rangesAreAuthorized(candidate.baseRanges, candidate.previewRanges)) {
      context.addIssue({
        code: "custom",
        path: ["previewRanges"],
        message: "preview ranges must be subsets of base ranges",
      });
    }
    if (reconstructTextFromRanges(candidate.text, candidate.previewRanges) !== candidate.preview) {
      context.addIssue({
        code: "custom",
        path: ["preview"],
        message: "preview must reconstruct exactly from preview ranges",
      });
    }
  },
);

export const CandidateLedgerEntrySchema = z.preprocess((value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind === "chat_message" &&
    candidate.chatRole === "assistant" &&
    typeof candidate.text === "string"
  ) {
    return { ...candidate, text: stripHistoricalCitationTags(candidate.text) };
  }
  return value;
}, CandidateLedgerEntryValidatedSchema);

export const CandidateLedgerSchema = z
  .strictObject({ candidates: z.array(CandidateLedgerEntrySchema) })
  .superRefine((ledger, context) => {
    const ids = new Set<string>();
    const identities = new Set<string>();
    for (const [index, candidate] of ledger.candidates.entries()) {
      if (candidate.candidateId !== `c${index + 1}`) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "candidateId"],
          message: "candidate IDs must be sequential in ledger order",
        });
      }
      if (ids.has(candidate.candidateId)) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "candidateId"],
          message: "candidate IDs must be unique",
        });
      }
      ids.add(candidate.candidateId);
      const identityKey = canonicalIdentityKey(candidate.identity);
      if (identities.has(identityKey)) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "identity"],
          message: "canonical identities must be unique",
        });
      }
      identities.add(identityKey);
    }
  });

export type CandidateLedgerSchemaValue = z.infer<typeof CandidateLedgerSchema>;

export const ProviderCandidateViewSchema = z.strictObject({
  candidateId: CandidateLocalIdSchema,
  kind: z.enum(["conversation_entry", "document", "chat_message", "memory", "web", "topic_packet"]),
  label: boundedText(CANDIDATE_CONTRACT_LIMITS.maxLabelUtf8Bytes).nullable(),
  purpose: boundedNonEmptyText(CANDIDATE_CONTRACT_LIMITS.maxPurposeUtf8Bytes),
  date: boundedText(CANDIDATE_CONTRACT_LIMITS.maxDateUtf8Bytes).nullable(),
  renderedTokenCount: z.number().int().finite().safe().min(0),
  preview: boundedText(CANDIDATE_CONTRACT_LIMITS.maxPreviewUtf8Bytes),
});

/**
 * The only durable workflow input that carries authorization state.  The
 * scope is decoded once by load-turn and then passed through Smithers output;
 * later tasks must not rebuild it from live settings.
 */
export interface LoadedTurn {
  readonly aiRunId: string;
  readonly chatId: string;
  readonly initiatingUserId: string;
  readonly userMessageId: string;
  readonly userMessage: string;
  readonly locale: Locale;
  readonly market: Market;
  readonly currentTimestamp: string;
  readonly citationNamespace: string;
  readonly acceptanceScope: RunAcceptanceScope;
}

/** Decode the one strict, server-owned acceptance snapshot at the workflow boundary. */
export const decodeRunAcceptanceScope = (value: unknown): RunAcceptanceScope =>
  parseRunAcceptanceScope(value);

/** Zod boundary used for Smithers' durable output decoder. */
export const RunAcceptanceScopeSchema = z.unknown().transform((value, context) => {
  try {
    return decodeRunAcceptanceScope(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "acceptance scope is invalid",
    });
    return z.NEVER;
  }
});
