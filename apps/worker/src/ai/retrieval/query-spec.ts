import { z } from "zod";

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
  readonly snapshotId: string;
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

/*
 * Phase A contracts. The old QuerySpec above remains the input used by query shaping.
 * These names describe the replacement contract without changing that public surface.
 */

export type QueryScope = "documents" | "chat_messages";
export type QueryAtomMode = "term" | "phrase";
export type QueryOrder = "relevance" | "newest" | "oldest";
export type QueryBranch = "public_documents" | "publisher_documents" | "chat_messages";
export const PHYSICAL_QUERY_BRANCHES = [
  "public_documents",
  "publisher_documents",
  "chat_messages",
] as const satisfies readonly QueryBranch[];

export const BranchReasonCodeSchema = z.enum([
  "scope_documents",
  "scope_chat_messages",
  "unsupported_country_filter",
]);
export type BranchReasonCode = z.infer<typeof BranchReasonCodeSchema>;

export const QueryReviewReasonCodeSchema = z.enum([
  "sufficient_coverage",
  "missed_concept",
  "narrow_filter",
  "wrong_language",
  "unsupported_branch",
  "no_supporting_evidence",
]);
export type QueryReviewReasonCode = z.infer<typeof QueryReviewReasonCodeSchema>;

export interface QueryAtom {
  readonly text: string;
  readonly mode: QueryAtomMode;
}

export interface InternalQuery {
  readonly purpose: string;
  readonly scope?: QueryScope | undefined;
  readonly all: readonly QueryAtom[];
  readonly anyOf: readonly (readonly QueryAtom[])[];
  readonly not: readonly QueryAtom[];
  readonly filters: {
    readonly documents?:
      | {
          readonly sourceNames?: readonly string[] | undefined;
          readonly countries?: readonly string[] | undefined;
          readonly languages?: readonly string[] | undefined;
          readonly documentTypes?: readonly string[] | undefined;
          readonly publishedAt?: { readonly after?: string; readonly before?: string } | undefined;
        }
      | undefined;
    readonly chatMessages?:
      | {
          readonly authors?: readonly ("user" | "assistant")[] | undefined;
          readonly sentAt?: { readonly after?: string; readonly before?: string } | undefined;
        }
      | undefined;
  };
  readonly order: QueryOrder;
}

export type InternalQueryPlan =
  | { readonly action: "skip"; readonly reason: string }
  | { readonly action: "search"; readonly queries: readonly InternalQuery[] };

export type QueryReview =
  | { readonly action: "accept"; readonly reason: "sufficient_coverage" }
  | {
      readonly action: "replace";
      readonly reason: "missed_concept" | "narrow_filter" | "wrong_language" | "unsupported_branch";
      readonly queries: readonly InternalQuery[];
    }
  | { readonly action: "no_evidence"; readonly reason: "no_supporting_evidence" };

export type BranchStatus = "applicable" | "not_applicable";

export interface BranchCoverage {
  readonly queryOrdinal: number;
  readonly branch: QueryBranch;
  readonly status: BranchStatus;
  readonly reason?: BranchReasonCode | undefined;
  readonly hitCount: number;
  readonly truncated: boolean;
  readonly cap: number;
}

export interface BranchResult<THit = unknown> extends BranchCoverage {
  readonly hits: readonly THit[];
}

export const QUERY_CONTRACT_LIMITS = {
  maxQueries: 64,
  maxPlanUtf8Bytes: 64 * 1024,
  maxTotalAtoms: 512,
  maxAtomUtf8Bytes: 512,
  maxPurposeUtf8Bytes: 4096,
  maxHitPreviewUtf8Bytes: 16 * 1024,
  maxHitLabelUtf8Bytes: 1024,
  maxHitDateUtf8Bytes: 128,
  maxArrayValues: 128,
} as const;

const {
  maxQueries: MAX_QUERY_COUNT,
  maxPlanUtf8Bytes: MAX_QUERY_BYTES,
  maxTotalAtoms: MAX_TOTAL_ATOMS,
  maxAtomUtf8Bytes: MAX_ATOM_BYTES,
  maxPurposeUtf8Bytes: MAX_PURPOSE_BYTES,
  maxHitPreviewUtf8Bytes: MAX_HIT_PREVIEW_BYTES,
  maxHitLabelUtf8Bytes: MAX_HIT_LABEL_BYTES,
  maxHitDateUtf8Bytes: MAX_HIT_DATE_BYTES,
  maxArrayValues: MAX_QUERY_ARRAY_VALUE,
} = QUERY_CONTRACT_LIMITS;

const utf8Encoder = new TextEncoder();

export const isWellFormedUtf16 = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const normalizedText = (maxBytes: number, minimum = 1) =>
  z
    .string()
    .transform((value) => value.trim().normalize("NFC"))
    .refine(isWellFormedUtf16, "text must contain well-formed UTF-16")
    .refine((value) => value.length >= minimum, `text must contain at least ${minimum} character`)
    .refine((value) => utf8Encoder.encode(value).byteLength <= maxBytes, "text is too large");

const boundedText = (maxBytes: number) =>
  z
    .string()
    .refine(isWellFormedUtf16, "text must contain well-formed UTF-16")
    .refine((value) => utf8Encoder.encode(value).byteLength <= maxBytes, "text is too large");

const localResultId = z
  .string()
  .regex(/^r[1-9][0-9]*$/u)
  .refine((value) => Number.isSafeInteger(Number(value.slice(1))), "result ordinal is too large");

const normalizedList = z
  .array(normalizedText(MAX_ATOM_BYTES))
  .max(MAX_QUERY_ARRAY_VALUE)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: "custom",
        message: "list values must be unique after normalization",
      });
    }
  });

const isoDate = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => /^\d{4}-\d{2}-\d{2}$/u.test(value), "date must be YYYY-MM-DD")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year!, month! - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month! - 1 &&
      date.getUTCDate() === day
    );
  }, "date is not a real calendar date");

const dateInterval = z
  .strictObject({ after: isoDate.optional(), before: isoDate.optional() })
  .superRefine((interval, context) => {
    if (
      interval.after !== undefined &&
      interval.before !== undefined &&
      interval.after > interval.before
    ) {
      context.addIssue({ code: "custom", message: "date interval is reversed" });
    }
  });

export const QueryAtomSchema = z.strictObject({
  text: normalizedText(MAX_ATOM_BYTES),
  mode: z.enum(["term", "phrase"]),
});

const queryAtoms = z.array(QueryAtomSchema).max(MAX_QUERY_ARRAY_VALUE);
const anyOfAtoms = z
  .array(queryAtoms)
  .max(MAX_QUERY_ARRAY_VALUE)
  .superRefine((groups, context) => {
    for (const [index, group] of groups.entries()) {
      if (group.length === 0) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "anyOf groups cannot be empty",
        });
      }
    }
  });

const QueryFiltersSchema = z.strictObject({
  documents: z
    .strictObject({
      sourceNames: normalizedList.optional(),
      countries: normalizedList.optional(),
      languages: normalizedList.optional(),
      documentTypes: normalizedList.optional(),
      publishedAt: dateInterval.optional(),
    })
    .optional(),
  chatMessages: z
    .strictObject({
      authors: z
        .array(z.enum(["user", "assistant"]))
        .max(2)
        .superRefine((values, context) => {
          if (new Set(values).size !== values.length) {
            context.addIssue({ code: "custom", message: "authors must be unique" });
          }
        })
        .optional(),
      sentAt: dateInterval.optional(),
    })
    .optional(),
});

export const InternalQuerySchema = z
  .strictObject({
    purpose: normalizedText(MAX_PURPOSE_BYTES),
    scope: z.enum(["documents", "chat_messages"]).optional(),
    all: queryAtoms,
    anyOf: anyOfAtoms,
    not: queryAtoms,
    filters: QueryFiltersSchema,
    order: z.enum(["relevance", "newest", "oldest"]),
  })
  .superRefine((query, context) => {
    const atoms = [...query.all, ...query.anyOf.flat(), ...query.not];
    if (atoms.length > MAX_TOTAL_ATOMS) {
      context.addIssue({ code: "custom", path: ["all"], message: "query has too many atoms" });
    }
    const atomKeys = atoms.map((atom) => atom.text);
    if (new Set(atomKeys).size !== atomKeys.length) {
      context.addIssue({
        code: "custom",
        message: "query atoms must be unique after normalization",
      });
    }
    if (query.all.length === 0 && query.anyOf.length === 0) {
      const hasFilterValue = (value: object | undefined): boolean => {
        if (value === undefined) return false;
        return Object.values(value).some((entry) => {
          if (Array.isArray(entry)) return entry.length > 0;
          if (typeof entry !== "object" || entry === null) return entry !== undefined;
          return Object.values(entry).some((bound) => bound !== undefined);
        });
      };
      const hasDocumentFilter = hasFilterValue(query.filters.documents);
      const hasChatFilter = hasFilterValue(query.filters.chatMessages);
      const hasIndexedFilter =
        query.scope === "documents"
          ? hasDocumentFilter
          : query.scope === "chat_messages"
            ? hasChatFilter
            : hasDocumentFilter && hasChatFilter;
      if (!hasIndexedFilter) {
        context.addIssue({
          code: "custom",
          message: "negative-only query needs a positive indexed filter",
        });
      }
    }
  });

const validateQueryBatch = (
  queries: readonly {
    readonly all: readonly unknown[];
    readonly anyOf: readonly (readonly unknown[])[];
    readonly not: readonly unknown[];
  }[],
  serialized: unknown,
  context: z.RefinementCtx,
): void => {
  const totalAtoms = queries.reduce(
    (total, query) =>
      total +
      query.all.length +
      query.not.length +
      query.anyOf.reduce((n, group) => n + group.length, 0),
    0,
  );
  if (totalAtoms > MAX_TOTAL_ATOMS) {
    context.addIssue({
      code: "custom",
      path: ["queries"],
      message: "query batch has too many atoms",
    });
  }
  const queryKeys = queries.map((query) =>
    JSON.stringify({
      purpose: (query as { readonly purpose?: unknown }).purpose,
      scope: (query as { readonly scope?: unknown }).scope ?? null,
      all: query.all,
      anyOf: query.anyOf,
      not: query.not,
      filters: (query as { readonly filters?: unknown }).filters,
      order: (query as { readonly order?: unknown }).order,
    }),
  );
  if (new Set(queryKeys).size !== queryKeys.length) {
    context.addIssue({ code: "custom", path: ["queries"], message: "queries must be unique" });
  }
  if (utf8Encoder.encode(JSON.stringify(serialized)).byteLength > MAX_QUERY_BYTES) {
    context.addIssue({ code: "custom", message: "query batch exceeds UTF-8 byte bound" });
  }
};

export const InternalQueryPlanSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("skip"), reason: normalizedText(MAX_PURPOSE_BYTES) }),
  z
    .strictObject({
      action: z.literal("search"),
      queries: z.array(InternalQuerySchema).min(1).max(MAX_QUERY_COUNT),
    })
    .superRefine((plan, context) => {
      validateQueryBatch(plan.queries, plan, context);
    }),
]);

export const QueryReviewSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("accept"), reason: z.literal("sufficient_coverage") }),
  z
    .strictObject({
      action: z.literal("replace"),
      reason: z.enum(["missed_concept", "narrow_filter", "wrong_language", "unsupported_branch"]),
      queries: z.array(InternalQuerySchema).min(1).max(MAX_QUERY_COUNT),
    })
    .superRefine((review, context) => {
      validateQueryBatch(review.queries, review, context);
    }),
  z.strictObject({ action: z.literal("no_evidence"), reason: z.literal("no_supporting_evidence") }),
]);

export const BranchCoverageSchema = z
  .strictObject({
    queryOrdinal: z.number().int().finite().safe().min(1),
    branch: z.enum(PHYSICAL_QUERY_BRANCHES),
    status: z.enum(["applicable", "not_applicable"]),
    reason: BranchReasonCodeSchema.optional(),
    hitCount: z.number().int().finite().safe().min(0),
    truncated: z.boolean(),
    cap: z.number().int().finite().safe().positive(),
  })
  .superRefine((branch, context) => {
    if (branch.status === "not_applicable" && branch.reason === undefined) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "not-applicable branch needs a reason",
      });
    }
    if (branch.status === "applicable" && branch.reason !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "applicable branch cannot carry a reason",
      });
    }
    if (branch.hitCount > branch.cap) {
      context.addIssue({ code: "custom", path: ["hitCount"], message: "hit count exceeds cap" });
    }
    if (branch.status === "not_applicable" && (branch.hitCount !== 0 || branch.truncated)) {
      context.addIssue({
        code: "custom",
        message: "not-applicable branch cannot report hits or truncation",
      });
    }
    if (branch.truncated && branch.hitCount < branch.cap) {
      context.addIssue({ code: "custom", message: "truncated branch must reach its cap" });
    }
  });

export const BranchResultHitSchema = z.strictObject({
  resultId: localResultId,
  kind: z.enum(["document", "chat_message"]),
  label: boundedText(MAX_HIT_LABEL_BYTES).nullable(),
  date: boundedText(MAX_HIT_DATE_BYTES).nullable(),
  fullTokenCount: z.number().int().finite().safe().min(0),
  preview: boundedText(MAX_HIT_PREVIEW_BYTES),
});

export const BranchResultSchema = z
  .strictObject({
    queryOrdinal: z.number().int().finite().safe().min(1),
    branch: z.enum(PHYSICAL_QUERY_BRANCHES),
    status: z.enum(["applicable", "not_applicable"]),
    reason: BranchReasonCodeSchema.optional(),
    hitCount: z.number().int().finite().safe().min(0),
    truncated: z.boolean(),
    cap: z.number().int().finite().safe().positive(),
    hits: z.array(BranchResultHitSchema),
  })
  .superRefine((branch, context) => {
    if (branch.status === "not_applicable" && branch.reason === undefined) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "not-applicable branch needs a reason",
      });
    }
    if (branch.status === "applicable" && branch.reason !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "applicable branch cannot carry a reason",
      });
    }
    if (branch.hitCount !== branch.hits.length) {
      context.addIssue({ code: "custom", path: ["hitCount"], message: "hitCount must match hits" });
    }
    if (branch.hits.length > branch.cap) {
      context.addIssue({ code: "custom", path: ["hits"], message: "branch hits exceed cap" });
    }
    if (branch.status === "not_applicable" && branch.hits.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["hits"],
        message: "not-applicable branch cannot contain hits",
      });
    }
    if (branch.status === "not_applicable" && branch.truncated) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "not-applicable branch cannot be truncated",
      });
    }
    if (new Set(branch.hits.map((hit) => hit.resultId)).size !== branch.hits.length) {
      context.addIssue({
        code: "custom",
        path: ["hits"],
        message: "result IDs must be unique within a branch",
      });
    }
    const expectedKind = branch.branch === "chat_messages" ? "chat_message" : "document";
    for (const [index, hit] of branch.hits.entries()) {
      if (hit.kind !== expectedKind) {
        context.addIssue({
          code: "custom",
          path: ["hits", index, "kind"],
          message: "hit kind does not match its physical branch",
        });
      }
    }
    if (branch.truncated && branch.hitCount < branch.cap) {
      context.addIssue({ code: "custom", message: "truncated branch must reach its cap" });
    }
  });

export type QueryAtomValue = z.infer<typeof QueryAtomSchema>;
export type InternalQueryValue = z.infer<typeof InternalQuerySchema>;
export type InternalQueryPlanValue = z.infer<typeof InternalQueryPlanSchema>;
export type QueryReviewValue = z.infer<typeof QueryReviewSchema>;

export const QuerySchema = InternalQuerySchema;
export const QueryPlanSchema = InternalQueryPlanSchema;

