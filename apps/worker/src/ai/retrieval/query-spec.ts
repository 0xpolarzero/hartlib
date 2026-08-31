import { z } from "zod";

/* Phase B structured retrieval contracts. */

export type QueryAtomMode = "term" | "phrase";
export type QueryOrder = "relevance" | "newest" | "oldest";
export type QueryBranch = "public_documents" | "chat_messages";
export const PHYSICAL_QUERY_BRANCHES = [
  "public_documents",
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

export interface DocumentFilters {
  readonly sourceNames?: readonly string[] | undefined;
  readonly countries?: readonly string[] | undefined;
  readonly languages?: readonly string[] | undefined;
  readonly documentTypes?: readonly string[] | undefined;
  readonly publishedAt?:
    | { readonly after?: string | undefined; readonly before?: string | undefined }
    | undefined;
}

export interface ChatMessageFilters {
  readonly authors?: readonly ("user" | "assistant")[] | undefined;
  readonly sentAt?:
    | { readonly after?: string | undefined; readonly before?: string | undefined }
    | undefined;
}

export type InternalQueryTarget =
  | { readonly kind: "documents"; readonly filters: DocumentFilters }
  | { readonly kind: "chat_messages"; readonly filters: ChatMessageFilters };

export interface InternalQuery {
  readonly purpose: string;
  readonly targets: readonly InternalQueryTarget[];
  readonly all: readonly QueryAtom[];
  readonly anyOf: readonly (readonly QueryAtom[])[];
  readonly not: readonly QueryAtom[];
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

/** Structural provider fields. Semantic normalization and cross-field checks stay below. */
const providerText = (maxBytes: number, minimum = 1) => z.string().min(minimum).max(maxBytes);

const RFC3339_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;
const IsoDateTimeSchema = z.iso.datetime();

/** Exact UTC transport form shared by provider and canonical query filters. */
export const Rfc3339UtcTimestampSchema = z
  .string()
  .max(MAX_HIT_DATE_BYTES)
  .trim()
  .refine(
    (value) => RFC3339_UTC_TIMESTAMP.test(value),
    "timestamp must use RFC 3339 UTC seconds with an optional one-to-six-digit fraction",
  )
  .refine(
    (value) => IsoDateTimeSchema.safeParse(value).success,
    "timestamp must be a real RFC 3339 UTC instant",
  )
  .meta({ format: "date-time" });

const providerTimestamp = Rfc3339UtcTimestampSchema;

const providerTimestampInterval = z.strictObject({
  after: providerTimestamp.optional(),
  before: providerTimestamp.optional(),
});

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

const utcTimestamp = Rfc3339UtcTimestampSchema;

const timestampParts = (value: string): { readonly whole: string; readonly fraction: string } => {
  const withoutZone = value.slice(0, -1);
  const separator = withoutZone.indexOf(".");
  return separator < 0
    ? { whole: withoutZone, fraction: "" }
    : {
        whole: withoutZone.slice(0, separator),
        fraction: withoutZone.slice(separator + 1),
      };
};

const compareUtcTimestamps = (left: string, right: string): number => {
  const leftParts = timestampParts(left);
  const rightParts = timestampParts(right);
  if (leftParts.whole !== rightParts.whole) {
    return leftParts.whole < rightParts.whole ? -1 : 1;
  }
  const width = Math.max(leftParts.fraction.length, rightParts.fraction.length);
  const leftFraction = leftParts.fraction.padEnd(width, "0");
  const rightFraction = rightParts.fraction.padEnd(width, "0");
  if (leftFraction === rightFraction) return 0;
  return leftFraction < rightFraction ? -1 : 1;
};

const timestampInterval = z
  .strictObject({ after: utcTimestamp.optional(), before: utcTimestamp.optional() })
  .superRefine((interval, context) => {
    if (
      interval.after !== undefined &&
      interval.before !== undefined &&
      compareUtcTimestamps(interval.after, interval.before) > 0
    ) {
      context.addIssue({ code: "custom", message: "timestamp interval is reversed" });
    }
  });

export const QueryAtomSchema = z.strictObject({
  text: normalizedText(MAX_ATOM_BYTES),
  mode: z.enum(["term", "phrase"]),
});

const ProviderQueryAtomSchema = z.strictObject({
  text: providerText(MAX_ATOM_BYTES),
  mode: z.enum(["term", "phrase"]),
});

const anyOfAtoms = z
  .array(z.array(QueryAtomSchema).max(MAX_QUERY_ARRAY_VALUE).min(1))
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

const nonEmptyProviderQueryAtoms = z
  .array(ProviderQueryAtomSchema)
  .max(MAX_QUERY_ARRAY_VALUE)
  .min(1);
const providerAnyOfGroups = z.array(nonEmptyProviderQueryAtoms).max(MAX_QUERY_ARRAY_VALUE);
// The provider-facing schema accepts both canonical groups and providers that
// flatten one group. The normalizer restores the canonical grouped form.
const providerAnyOfAtoms = z.array(ProviderQueryAtomSchema).max(MAX_QUERY_ARRAY_VALUE);
const providerAnyOf = z.union([providerAnyOfAtoms, providerAnyOfGroups]);

const authorsSchema = z
  .array(z.enum(["user", "assistant"]))
  .max(2)
  .meta({ uniqueItems: true })
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "authors must be unique" });
    }
  });

const documentFiltersShape = <TList extends z.ZodType, TInterval extends z.ZodType>(
  list: TList,
  interval: TInterval,
) => ({
  sourceNames: list.optional(),
  countries: list.optional(),
  languages: list.optional(),
  documentTypes: list.optional(),
  publishedAt: interval.optional(),
});

const chatMessageFiltersShape = <TInterval extends z.ZodType>(interval: TInterval) => ({
  authors: authorsSchema.optional(),
  sentAt: interval.optional(),
});

const makeDocumentFiltersSchema = <TList extends z.ZodType, TInterval extends z.ZodType>(
  list: TList,
  interval: TInterval,
) => z.strictObject(documentFiltersShape(list, interval));

const makeChatMessageFiltersSchema = <TInterval extends z.ZodType>(interval: TInterval) =>
  z.strictObject(chatMessageFiltersShape(interval));

const QueryDocumentFiltersSchema = makeDocumentFiltersSchema(normalizedList, timestampInterval);
const QueryChatMessageFiltersSchema = makeChatMessageFiltersSchema(timestampInterval);

const makeQueryTargetsSchema = <
  TDocumentFilters extends z.ZodType,
  TChatMessageFilters extends z.ZodType,
>(
  documentFilters: TDocumentFilters,
  chatMessageFilters: TChatMessageFilters,
) =>
  z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("documents"), filters: documentFilters }),
        z.strictObject({ kind: z.literal("chat_messages"), filters: chatMessageFilters }),
      ]),
    )
    .min(1)
    .max(2)
    .superRefine((targets, context) => {
      if (new Set(targets.map((target) => target.kind)).size !== targets.length) {
        context.addIssue({ code: "custom", message: "target kinds must be unique" });
      }
    });

const makeQueryShape = <
  TPurpose extends z.ZodType,
  TAtom extends z.ZodType,
  TAnyOf extends z.ZodType,
  TTargets extends z.ZodType,
>(input: {
  readonly purpose: TPurpose;
  readonly atom: TAtom;
  readonly anyOf: TAnyOf;
  readonly targets: TTargets;
}) =>
  z.strictObject({
    purpose: input.purpose,
    targets: input.targets,
    all: z.array(input.atom).max(MAX_QUERY_ARRAY_VALUE),
    anyOf: input.anyOf,
    not: z.array(input.atom).max(MAX_QUERY_ARRAY_VALUE),
    order: z.enum(["relevance", "newest", "oldest"]),
  });

export const InternalQuerySchema = makeQueryShape({
  purpose: normalizedText(MAX_PURPOSE_BYTES),
  atom: QueryAtomSchema,
  anyOf: anyOfAtoms,
  targets: makeQueryTargetsSchema(QueryDocumentFiltersSchema, QueryChatMessageFiltersSchema),
}).superRefine((query, context) => {
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
    const hasFilterValue = (value: object): boolean =>
      Object.values(value).some((entry) => {
        if (Array.isArray(entry)) return entry.length > 0;
        if (typeof entry !== "object" || entry === null) return entry !== undefined;
        return Object.values(entry).some((bound) => bound !== undefined);
      });
    for (const [index, target] of query.targets.entries()) {
      if (!hasFilterValue(target.filters)) {
        context.addIssue({
          code: "custom",
          path: ["targets", index, "filters"],
          message: "negative-only query needs a positive indexed filter for every target",
        });
      }
    }
  }
});

/** Provider tool calls often encode omitted optional filters as JSON null. */
const providerTextList = z.array(providerText(MAX_ATOM_BYTES)).max(MAX_QUERY_ARRAY_VALUE);
const providerOptionalTextList = providerTextList.nullable().optional();
const providerOptionalTimestampInterval = providerTimestampInterval.nullable().optional();
const ProviderDocumentFiltersSchema = z.strictObject({
  sourceNames: providerOptionalTextList,
  countries: providerOptionalTextList,
  languages: providerOptionalTextList,
  documentTypes: providerOptionalTextList,
  publishedAt: providerOptionalTimestampInterval,
});
const ProviderChatMessageFiltersSchema = z.strictObject({
  authors: authorsSchema.nullable().optional(),
  sentAt: providerOptionalTimestampInterval,
});
const ProviderQueryTargetsSchema = makeQueryTargetsSchema(
  ProviderDocumentFiltersSchema,
  ProviderChatMessageFiltersSchema,
);

/** Exact provider-facing shape; canonical parsing performs all normalization below. */
const providerQueryFields = makeQueryShape({
  purpose: providerText(MAX_PURPOSE_BYTES),
  atom: ProviderQueryAtomSchema,
  anyOf: providerAnyOf,
  targets: ProviderQueryTargetsSchema,
});

type InternalQueryProviderValue = z.output<typeof providerQueryFields>;

export const InternalQueryProviderSchema = providerQueryFields;

type QueryBatchEntry = z.output<typeof InternalQuerySchema>;

const validateQueryBatch = (
  queries: readonly QueryBatchEntry[],
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
  const queryKeys = queries.map(({ purpose, targets, all, anyOf, not, order }) =>
    JSON.stringify({
      purpose,
      targets,
      all,
      anyOf,
      not,
      order,
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
export const StructuredRetrievalTraceSchema = z
  .strictObject({
    initialPlan: InternalQueryPlanSchema,
    review: QueryReviewSchema.nullable(),
    replacementPlan: InternalQueryPlanSchema.nullable(),
    outcome: z.enum(["skipped", "accepted", "replaced", "no_evidence"]),
  })
  .superRefine((trace, context) => {
    const addConsistencyIssue = (message: string): void => {
      context.addIssue({ code: "custom", message });
    };
    if (trace.outcome === "skipped") {
      if (
        trace.initialPlan.action !== "skip" ||
        trace.review !== null ||
        trace.replacementPlan !== null
      ) {
        addConsistencyIssue("skipped trace must contain only a skip plan");
      }
      return;
    }
    if (trace.initialPlan.action !== "search") {
      addConsistencyIssue("non-skipped trace must contain an initial search plan");
    }
    if (trace.outcome === "accepted") {
      if (trace.review?.action !== "accept" || trace.replacementPlan !== null) {
        addConsistencyIssue("accepted trace must contain an accept review and no replacement");
      }
      return;
    }
    if (trace.outcome === "no_evidence") {
      if (trace.review?.action !== "no_evidence" || trace.replacementPlan !== null) {
        addConsistencyIssue(
          "no-evidence trace must contain a no-evidence review and no replacement",
        );
      }
      return;
    }
    if (
      trace.review?.action !== "replace" ||
      trace.replacementPlan?.action !== "search" ||
      trace.initialPlan.action !== "search"
    ) {
      addConsistencyIssue("replaced trace must contain complete search plans and a replace review");
      return;
    }
    if (JSON.stringify(trace.review.queries) !== JSON.stringify(trace.replacementPlan.queries)) {
      addConsistencyIssue("replacement plan must exactly match the review queries");
    }
  });

export type StructuredRetrievalTraceValue = z.infer<typeof StructuredRetrievalTraceSchema>;

const providerPlanFields = z
  .strictObject({
    action: z.enum(["skip", "search"]),
    reason: providerText(MAX_PURPOSE_BYTES).optional(),
    queries: z.array(InternalQueryProviderSchema).min(1).max(MAX_QUERY_COUNT).optional(),
  })
  .superRefine((plan, context) => {
    if (plan.action === "skip") {
      if (plan.reason === undefined) {
        context.addIssue({ code: "custom", path: ["reason"], message: "skip needs a reason" });
      }
      if (plan.queries !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["queries"],
          message: "skip cannot have queries",
        });
      }
    } else {
      if (plan.queries === undefined) {
        context.addIssue({ code: "custom", path: ["queries"], message: "search needs queries" });
      }
    }
  });

type InternalQueryPlanProviderValue =
  | { readonly action: "skip"; readonly reason: string }
  | {
      readonly action: "search";
      readonly queries: readonly InternalQueryProviderValue[];
    };

export const InternalQueryPlanProviderSchema =
  providerPlanFields as unknown as z.ZodType<InternalQueryPlanProviderValue>;

const providerReviewFields = z
  .strictObject({
    action: z.enum(["accept", "replace", "no_evidence"]),
    reason: providerText(MAX_PURPOSE_BYTES).optional(),
    queries: z.array(InternalQueryProviderSchema).min(1).max(MAX_QUERY_COUNT).optional(),
  })
  .superRefine((review, context) => {
    if (review.action === "accept") {
      if (review.reason === undefined) {
        context.addIssue({ code: "custom", path: ["reason"], message: "accept needs a reason" });
      }
      if (review.queries !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["queries"],
          message: "accept cannot have queries",
        });
      }
      return;
    }
    if (review.action === "no_evidence") {
      if (review.reason === undefined) {
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: "no_evidence needs a reason",
        });
      }
      if (review.queries !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["queries"],
          message: "no_evidence cannot have queries",
        });
      }
      return;
    }
    if (review.reason === undefined) {
      context.addIssue({ code: "custom", path: ["reason"], message: "replace needs a reason" });
    }
    if (review.queries === undefined) {
      context.addIssue({ code: "custom", path: ["queries"], message: "replace needs queries" });
    }
  });

type QueryReviewProviderValue =
  | { readonly action: "accept"; readonly reason: string }
  | {
      readonly action: "replace";
      readonly reason: string;
      readonly queries: readonly InternalQueryProviderValue[];
    }
  | { readonly action: "no_evidence"; readonly reason: string };

export const QueryReviewProviderSchema =
  providerReviewFields as unknown as z.ZodType<QueryReviewProviderValue>;

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

/**
 * The compiler consumes this normalized, code-owned representation.  It is
 * deliberately separate from the provider schema: provider values are
 * parsed once, then all strings and collections are canonicalized before a
 * physical branch can be built.
 */
export type NormalizedInternalQuery = QueryInternalNormalized;

type QueryInternalNormalized = Omit<InternalQueryValue, "targets"> & {
  readonly targets: readonly InternalQueryTarget[];
};
const normalizeUniqueStrings = (values: readonly string[] | undefined): readonly string[] =>
  values === undefined
    ? []
    : [...new Set(values.map((value) => value.trim().normalize("NFC")))].filter(
        (value) => value.length > 0,
      );

const normalizeTimestampInterval = (
  value: { readonly after?: string | undefined; readonly before?: string | undefined } | undefined,
): { readonly after?: string | undefined; readonly before?: string | undefined } | undefined =>
  value === undefined
    ? undefined
    : {
        ...(value.after === undefined ? {} : { after: value.after }),
        ...(value.before === undefined ? {} : { before: value.before }),
      };

/** Parse and normalize one provider query without changing its meaning. */
export const normalizeInternalQuery = (value: unknown): NormalizedInternalQuery => {
  const parsed = InternalQuerySchema.parse(value);
  return {
    purpose: parsed.purpose,
    targets: parsed.targets.map((target) =>
      target.kind === "documents"
        ? {
            kind: target.kind,
            filters: {
              ...(target.filters.sourceNames === undefined
                ? {}
                : { sourceNames: normalizeUniqueStrings(target.filters.sourceNames) }),
              ...(target.filters.countries === undefined
                ? {}
                : { countries: normalizeUniqueStrings(target.filters.countries) }),
              ...(target.filters.languages === undefined
                ? {}
                : { languages: normalizeUniqueStrings(target.filters.languages) }),
              ...(target.filters.documentTypes === undefined
                ? {}
                : { documentTypes: normalizeUniqueStrings(target.filters.documentTypes) }),
              ...(target.filters.publishedAt === undefined
                ? {}
                : { publishedAt: normalizeTimestampInterval(target.filters.publishedAt) }),
            },
          }
        : {
            kind: target.kind,
            filters: {
              ...(target.filters.authors === undefined
                ? {}
                : { authors: [...new Set(target.filters.authors)] }),
              ...(target.filters.sentAt === undefined
                ? {}
                : { sentAt: normalizeTimestampInterval(target.filters.sentAt) }),
            },
          },
    ),
    all: parsed.all.map((atom) => ({ text: atom.text, mode: atom.mode })),
    anyOf: parsed.anyOf.map((group) => group.map((atom) => ({ text: atom.text, mode: atom.mode }))),
    not: parsed.not.map((atom) => ({ text: atom.text, mode: atom.mode })),
    order: parsed.order,
  };
};

type ProviderQueryValue = z.output<typeof providerQueryFields>;

const withoutNullObjectFields = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutNullObjectFields);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== null)
      .map(([key, entry]) => [key, withoutNullObjectFields(entry)]),
  );
};

const normalizeProviderAnyOf = (
  value: ProviderQueryValue["anyOf"],
): readonly (readonly z.output<typeof ProviderQueryAtomSchema>[])[] => {
  if (value.length === 0) return [];
  return Array.isArray(value[0])
    ? (value as readonly (readonly z.output<typeof ProviderQueryAtomSchema>[])[])
    : [value as readonly z.output<typeof ProviderQueryAtomSchema>[]];
};

/** Parse provider query syntax, then restore the canonical grouped anyOf form. */
export const normalizeInternalQueryProvider = (value: unknown): NormalizedInternalQuery => {
  const parsed = providerQueryFields.parse(value);
  return normalizeInternalQuery(
    withoutNullObjectFields({
      ...parsed,
      anyOf: normalizeProviderAnyOf(parsed.anyOf),
    }),
  );
};

/** Parse and normalize the provider transport shape before canonical validation. */
export const normalizeInternalQueryPlanProvider = (value: unknown): InternalQueryPlanValue => {
  const parsed = InternalQueryPlanProviderSchema.parse(value);
  if (parsed.action === "skip") {
    return InternalQueryPlanSchema.parse({ action: parsed.action, reason: parsed.reason });
  }
  return InternalQueryPlanSchema.parse({
    action: parsed.action,
    queries: parsed.queries.map(normalizeInternalQueryProvider),
  });
};

const normalizeProviderReviewReason = (
  value: string,
): "missed_concept" | "narrow_filter" | "wrong_language" | "unsupported_branch" => {
  if (
    value === "missed_concept" ||
    value === "narrow_filter" ||
    value === "wrong_language" ||
    value === "unsupported_branch"
  ) {
    return value;
  }
  const reason = value.toLocaleLowerCase("en-US");
  if (
    reason.includes("unsupported") ||
    reason.includes("not applicable") ||
    reason.includes("non pris en charge")
  ) {
    return "unsupported_branch";
  }
  if (
    reason.includes("language") ||
    reason.includes("langue") ||
    reason.includes("french") ||
    reason.includes("français") ||
    reason.includes("english") ||
    reason.includes("anglais")
  ) {
    return "wrong_language";
  }
  if (reason.includes("narrow") || reason.includes("filter") || reason.includes("filtre")) {
    return "narrow_filter";
  }
  if (
    reason.includes("missed") ||
    reason.includes("manqué") ||
    reason.includes("zero result") ||
    reason.includes("no result") ||
    reason.includes("aucun résultat") ||
    reason.includes("concept")
  ) {
    return "missed_concept";
  }
  throw new Error("provider replacement reason does not map to a closed review code");
};

/** Parse and normalize the provider transport shape before canonical validation. */
export const normalizeQueryReviewProvider = (value: unknown): QueryReviewValue => {
  const parsed = QueryReviewProviderSchema.parse(value);
  if (parsed.action === "accept" || parsed.action === "no_evidence") {
    return QueryReviewSchema.parse({
      action: parsed.action,
      reason: parsed.action === "accept" ? "sufficient_coverage" : "no_supporting_evidence",
    });
  }
  return QueryReviewSchema.parse({
    action: parsed.action,
    reason: normalizeProviderReviewReason(parsed.reason),
    queries: parsed.queries.map(normalizeInternalQueryProvider),
  });
};
