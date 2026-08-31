import { z } from "zod";
import {
  BranchCoverageSchema,
  InternalQueryPlanSchema,
  QueryReviewSchema,
  StructuredRetrievalTraceSchema,
} from "../retrieval/query-spec";
import {
  ReviewModelFusedResultMetadataSchema,
  ReviewModelFusedResultSchema,
  FusionTruncationSchema,
  canonicalIdentityKey,
} from "../retrieval/rank-fusion";
import {
  FallbackContextManifestSchema,
  GroupResultEnvelopeSchema,
  InitialContextManifestSchema,
} from "../context/compaction";
import {
  CandidateLocalIdSchema,
  CandidateProvenanceSchema,
  CanonicalIdentitySchema,
  GroupLocalIdSchema,
  PassageLocalIdSchema,
  ResultLocalIdSchema,
  SourceRangeSchema,
} from "../workflow/types";
export const EvaluationDimensions = [
  "first_message",
  "follow_up",
  "ambiguous_reference",
  "irrelevant_recent_history",
  "long_history",
  "memory_relevance",
  "document_retrieval",
  "older_chat_retrieval",
  "web_enabled",
  "web_disabled",
  "multilingual",
  "oversized_evidence",
  "cross_cutting",
  "separable_multi_topic",
  "out_of_corpus",
] as const;

export const EvaluationDimensionSchema = z.enum(EvaluationDimensions);
export type EvaluationDimension = z.infer<typeof EvaluationDimensionSchema>;

export const SelectorRoleSchema = z.enum(["A", "B", "W"]);
export type SelectorRole = z.infer<typeof SelectorRoleSchema>;

const nonEmpty = z.string().trim().min(1);
const nonBlankText = z
  .string()
  .min(1)
  .refine((value) => value.trim() !== "", {
    message: "text must contain a non-whitespace character",
  });
const uniqueStrings = z.array(nonEmpty).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "values must be unique" });
  }
});

const orderedTopicIds = (topicIds: readonly string[], context: z.RefinementCtx): void => {
  const expected = ["t1", "t2", "t3"].slice(0, topicIds.length);
  if (topicIds.some((topicId, index) => topicId !== expected[index])) {
    context.addIssue({
      code: "custom",
      message: "fanout topic IDs must be ordered t1, t2, t3",
    });
  }
};

export const EvaluationRangeSchema = z
  .object({
    charStart: z.number().int().nonnegative(),
    charEnd: z.number().int().positive(),
  })
  .strict()
  .superRefine((range, context) => {
    if (range.charEnd <= range.charStart) {
      context.addIssue({ code: "custom", message: "charEnd must be greater than charStart" });
    }
  });

export type EvaluationRange = z.infer<typeof EvaluationRangeSchema>;

const GoldenConversationEntrySchema = z
  .object({
    turnId: nonEmpty,
    userContent: nonBlankText,
    assistantContent: nonBlankText,
  })
  .strict();

const GoldenEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      sourceId: nonEmpty,
      selector: z.literal("A"),
      kind: z.literal("document"),
      content: nonBlankText,
      ranges: z.array(EvaluationRangeSchema),
    })
    .strict(),
  z
    .object({
      sourceId: nonEmpty,
      selector: z.literal("A"),
      kind: z.literal("chat_message"),
      content: nonBlankText,
      ranges: z.array(EvaluationRangeSchema),
    })
    .strict(),
  z
    .object({
      sourceId: nonEmpty,
      selector: z.literal("B"),
      kind: z.literal("memory"),
      content: nonBlankText,
      ranges: z.array(EvaluationRangeSchema),
    })
    .strict(),
  z
    .object({
      sourceId: nonEmpty,
      selector: z.literal("W"),
      kind: z.literal("web"),
      content: nonBlankText,
      ranges: z.array(EvaluationRangeSchema),
      url: z.url(),
      title: nonBlankText,
      domain: nonEmpty,
    })
    .strict(),
]);

const GoldenMemoryProposalSchema = z
  .object({
    action: z.enum(["create", "update"]),
    kind: z.enum(["profile", "preference", "instruction", "fact", "episode"]),
    content: nonBlankText,
    targetMemoryId: nonEmpty.nullable(),
    expectedHeadRevisionId: nonEmpty.nullable(),
  })
  .strict()
  .superRefine((proposal, context) => {
    if (
      (proposal.action === "create" &&
        (proposal.targetMemoryId !== null || proposal.expectedHeadRevisionId !== null)) ||
      (proposal.action === "update" &&
        (proposal.targetMemoryId === null || proposal.expectedHeadRevisionId === null))
    ) {
      context.addIssue({
        code: "custom",
        message: "create proposals have no target/head; update proposals require both",
      });
    }
  });

export type GoldenMemoryProposal = z.infer<typeof GoldenMemoryProposalSchema>;

const PlanTurnGoldenLabelSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("clarify"),
      question: nonEmpty,
      relevantTurnIds: uniqueStrings,
      requiredQuestionTermGroups: z.array(z.array(nonEmpty).min(1)).min(1),
    })
    .strict(),
  z
    .object({
      mode: z.literal("single"),
      question: nonEmpty,
      relevantTurnIds: uniqueStrings,
      requiredTermGroups: z.array(z.array(nonEmpty).min(1)).min(1),
    })
    .strict(),
  z
    .object({
      mode: z.literal("fanout"),
      question: nonEmpty,
      topics: z
        .array(
          z
            .object({
              topicId: z.enum(["t1", "t2", "t3"]),
              question: nonEmpty,
              relevantTurnIds: uniqueStrings,
            })
            .strict(),
        )
        .min(2)
        .max(3)
        .superRefine((topics, context) =>
          orderedTopicIds(
            topics.map((topic) => topic.topicId),
            context,
          ),
        )
        .superRefine((topics, context) => {
          const questions = topics.map((topic) => topic.question);
          if (new Set(questions).size !== questions.length) {
            context.addIssue({ code: "custom", message: "fanout topic questions must be unique" });
          }
          const turnIds = topics.flatMap((topic) => topic.relevantTurnIds);
          if (new Set(turnIds).size !== turnIds.length) {
            context.addIssue({
              code: "custom",
              message: "fanout relevant turn IDs must be unique",
            });
          }
        }),
    })
    .strict(),
]);

export const EvaluationPlanTurnSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("clarify"), question: nonEmpty }).strict(),
  z
    .object({ mode: z.literal("single"), question: nonEmpty, relevantTurnIds: uniqueStrings })
    .strict(),
  z
    .object({
      mode: z.literal("fanout"),
      question: nonEmpty,
      topics: z
        .array(
          z
            .object({
              topicId: z.enum(["t1", "t2", "t3"]),
              question: nonEmpty,
              relevantTurnIds: uniqueStrings,
            })
            .strict(),
        )
        .min(2)
        .max(3)
        .superRefine((topics, context) =>
          orderedTopicIds(
            topics.map((topic) => topic.topicId),
            context,
          ),
        )
        .superRefine((topics, context) => {
          const questions = topics.map((topic) => topic.question);
          if (new Set(questions).size !== questions.length) {
            context.addIssue({ code: "custom", message: "fanout topic questions must be unique" });
          }
          const turnIds = topics.flatMap((topic) => topic.relevantTurnIds);
          if (new Set(turnIds).size !== turnIds.length) {
            context.addIssue({
              code: "custom",
              message: "fanout relevant turn IDs must be unique",
            });
          }
        }),
    })
    .strict(),
]);

const SupportedClaimSchema = z
  .object({
    claimId: nonEmpty,
    supportingSourceIds: uniqueStrings.min(1),
  })
  .strict();

const ExpectedGapSchema = z
  .object({
    gapId: nonEmpty,
    description: nonEmpty,
  })
  .strict();

const GoldenLabelsSchema = z
  .object({
    relevantTurnIds: uniqueStrings,
    planTurn: PlanTurnGoldenLabelSchema,
    retrievalSelectors: z.array(SelectorRoleSchema).superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: "custom", message: "retrieval selectors must be unique" });
      }
    }),
    requiredSourceIds: uniqueStrings,
    relevantSourceIds: uniqueStrings,
    acceptableOmissionSourceIds: uniqueStrings,
    acceptableRanges: z.record(nonEmpty, z.array(EvaluationRangeSchema).min(1)),
    supportedClaims: z.array(SupportedClaimSchema).superRefine((claims, context) => {
      const ids = claims.map((claim) => claim.claimId);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: "custom", message: "claim ids must be unique" });
      }
    }),
    expectedGaps: z.array(ExpectedGapSchema).superRefine((gaps, context) => {
      const ids = gaps.map((gap) => gap.gapId);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: "custom", message: "gap ids must be unique" });
      }
    }),
    expectedMemoryProposals: z
      .array(GoldenMemoryProposalSchema)
      .superRefine((proposals, context) => {
        const keys = proposals.map((proposal) => JSON.stringify(proposal));
        if (new Set(keys).size !== keys.length) {
          context.addIssue({ code: "custom", message: "memory proposals must be unique" });
        }
      }),
  })
  .strict();

export const GoldenEvaluationCaseSchema = z
  .object({
    id: nonEmpty,
    dimensions: z.array(EvaluationDimensionSchema).min(1),
    locale: z.enum(["fr-FR", "en-US"]),
    market: z.enum(["FR", "US"]),
    currentMessage: nonBlankText,
    conversation: z.array(GoldenConversationEntrySchema),
    evidence: z.array(GoldenEvidenceSchema),
    webRequested: z.boolean(),
    webPolicyEnabled: z.boolean(),
    labels: GoldenLabelsSchema,
  })
  .strict()
  .superRefine((fixture, context) => {
    const dimensions = new Set(fixture.dimensions);
    if (dimensions.size !== fixture.dimensions.length) {
      context.addIssue({ code: "custom", message: "dimensions must be unique" });
    }

    const turnIds = fixture.conversation.map((entry) => entry.turnId);
    if (new Set(turnIds).size !== turnIds.length) {
      context.addIssue({ code: "custom", message: "turn ids must be unique" });
    }
    for (const turnId of fixture.labels.relevantTurnIds) {
      if (!turnIds.includes(turnId)) {
        context.addIssue({ code: "custom", message: `unknown relevant turn ${turnId}` });
      }
    }
    const planTurnIds =
      fixture.labels.planTurn.mode === "clarify"
        ? fixture.labels.planTurn.relevantTurnIds
        : fixture.labels.planTurn.mode === "single"
          ? fixture.labels.planTurn.relevantTurnIds
          : fixture.labels.planTurn.topics.flatMap((topic) => topic.relevantTurnIds);
    for (const turnId of planTurnIds) {
      if (!turnIds.includes(turnId)) {
        context.addIssue({ code: "custom", message: `unknown selected plan turn ${turnId}` });
      }
    }
    if (fixture.labels.planTurn.mode === "fanout") {
      const topicIds = fixture.labels.planTurn.topics.map((topic) => topic.topicId);
      orderedTopicIds(topicIds, context);
      for (const topic of fixture.labels.planTurn.topics) {
        for (const turnId of topic.relevantTurnIds) {
          if (!turnIds.includes(turnId)) {
            context.addIssue({ code: "custom", message: `unknown selected topic turn ${turnId}` });
          }
        }
      }
      const topicTurnIds = fixture.labels.planTurn.topics.flatMap((topic) => topic.relevantTurnIds);
      if (
        new Set(topicTurnIds).size !== topicTurnIds.length ||
        JSON.stringify(topicTurnIds) !== JSON.stringify(fixture.labels.relevantTurnIds)
      ) {
        context.addIssue({
          code: "custom",
          message: "fanout turn selections must match the ordered relevant turn union",
        });
      }
    } else if (
      JSON.stringify(fixture.labels.planTurn.relevantTurnIds) !==
      JSON.stringify(fixture.labels.relevantTurnIds)
    ) {
      context.addIssue({
        code: "custom",
        message: "plan-turn selected turns must exactly match relevantTurnIds",
      });
    }

    const evidenceIds = fixture.evidence.map((source) => source.sourceId);
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      context.addIssue({ code: "custom", message: "evidence source ids must be unique" });
    }
    const evidenceSet = new Set(evidenceIds);
    for (const source of fixture.evidence) {
      if (source.ranges.some((range) => range.charEnd > source.content.length)) {
        context.addIssue({
          code: "custom",
          message: `source ${source.sourceId} has a range outside its content`,
        });
      }
      if (source.kind !== "document" && source.ranges.length > 0) {
        context.addIssue({
          code: "custom",
          message: `non-document source ${source.sourceId} cannot carry character ranges`,
        });
      }
    }
    for (const sourceId of [
      ...fixture.labels.requiredSourceIds,
      ...fixture.labels.relevantSourceIds,
      ...fixture.labels.acceptableOmissionSourceIds,
      ...Object.keys(fixture.labels.acceptableRanges),
      ...fixture.labels.supportedClaims.flatMap((claim) => claim.supportingSourceIds),
    ]) {
      if (!evidenceSet.has(sourceId)) {
        context.addIssue({ code: "custom", message: `unknown labeled source ${sourceId}` });
      }
    }
    for (const [sourceId, ranges] of Object.entries(fixture.labels.acceptableRanges)) {
      const source = fixture.evidence.find((candidate) => candidate.sourceId === sourceId);
      if (source !== undefined && source.kind !== "document") {
        context.addIssue({
          code: "custom",
          message: `acceptable ranges are valid only for document source ${sourceId}`,
        });
      }
      if (source !== undefined && ranges.some((range) => range.charEnd > source.content.length)) {
        context.addIssue({
          code: "custom",
          message: `acceptable range for ${sourceId} is outside its content`,
        });
      }
    }

    const relevantSet = new Set(fixture.labels.relevantSourceIds);
    for (const sourceId of fixture.labels.requiredSourceIds) {
      if (!relevantSet.has(sourceId)) {
        context.addIssue({
          code: "custom",
          message: `required source ${sourceId} must also be relevant`,
        });
      }
    }
    for (const sourceId of fixture.labels.acceptableOmissionSourceIds) {
      if (!relevantSet.has(sourceId) || fixture.labels.requiredSourceIds.includes(sourceId)) {
        context.addIssue({
          code: "custom",
          message: `acceptable omission ${sourceId} must be relevant but not required`,
        });
      }
    }

    const roleBySource = new Map(
      fixture.evidence.map((source) => [source.sourceId, source.selector] as const),
    );
    const expectedSelectors = new Set(
      fixture.labels.relevantSourceIds.map((sourceId) => roleBySource.get(sourceId)),
    );
    for (const selector of fixture.labels.retrievalSelectors) {
      if (!expectedSelectors.has(selector)) {
        context.addIssue({
          code: "custom",
          message: `retrieval selector ${selector} has no labeled relevant source`,
        });
      }
    }
    for (const selector of expectedSelectors) {
      if (selector !== undefined && !fixture.labels.retrievalSelectors.includes(selector)) {
        context.addIssue({
          code: "custom",
          message: `labeled relevant sources require retrieval selector ${selector}`,
        });
      }
    }

    if (
      (!fixture.webRequested || !fixture.webPolicyEnabled) &&
      fixture.labels.retrievalSelectors.includes("W")
    ) {
      context.addIssue({ code: "custom", message: "web-ineligible case cannot require W" });
    }
    if (
      fixture.labels.planTurn.mode === "clarify" &&
      (fixture.labels.relevantTurnIds.length > 0 ||
        fixture.labels.planTurn.relevantTurnIds.length > 0 ||
        fixture.labels.retrievalSelectors.length > 0 ||
        fixture.labels.requiredSourceIds.length > 0 ||
        fixture.labels.relevantSourceIds.length > 0 ||
        fixture.labels.acceptableOmissionSourceIds.length > 0 ||
        Object.keys(fixture.labels.acceptableRanges).length > 0 ||
        fixture.labels.supportedClaims.length > 0 ||
        fixture.labels.expectedGaps.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "clarification stops before retrieval and planning",
      });
    }
  });

export type GoldenEvaluationCase = z.infer<typeof GoldenEvaluationCaseSchema>;

const GoldenEvaluationSetFields = {
  cases: z.array(GoldenEvaluationCaseSchema).min(1),
} as const;

const validateGoldenEvaluationSet = (
  set: { readonly cases: readonly GoldenEvaluationCase[] },
  context: z.RefinementCtx,
): void => {
  const ids = set.cases.map((fixture) => fixture.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "evaluation case ids must be unique" });
  }
  const covered = new Set(set.cases.flatMap((fixture) => fixture.dimensions));
  for (const dimension of EvaluationDimensions) {
    if (!covered.has(dimension)) {
      context.addIssue({ code: "custom", message: `missing dimension ${dimension}` });
    }
  }
};

export const GoldenEvaluationSetSchema = z
  .object({
    version: z.literal(4),
    ...GoldenEvaluationSetFields,
  })
  .strict()
  .superRefine(validateGoldenEvaluationSet);
export type GoldenEvaluationSet = z.infer<typeof GoldenEvaluationSetSchema>;

const CaptureFieldsSchema = z
  .object({
    runId: z.uuid(),
    provider: z.literal("zai"),
    modelIds: z
      .array(z.literal("glm-5-turbo"))
      .min(1)
      .superRefine((values, context) => {
        if (new Set(values).size !== values.length) {
          context.addIssue({ code: "custom", message: "model ids must be unique" });
        }
      }),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
  })
  .strict();

const CaptureSchema = z.discriminatedUnion("origin", [
  CaptureFieldsSchema.extend({
    origin: z.literal("real_provider_turn"),
    attestation: z
      .object({
        sessionId: z.uuid(),
        topology: z.enum(["specialized", "general_planner"]),
        runEvidenceSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
        annotationsSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
        evaluationConfigSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
        providerEndpointIdentity: z.literal(
          "tinyfish_search_official:https://api.search.tinyfish.ai",
        ),
      })
      .strict(),
  }),
  CaptureFieldsSchema.extend({ origin: z.literal("synthetic_fixture") }),
]);

export const EvaluationClaimAnnotationSchema = z
  .object({
    claimId: nonEmpty,
    citedSourceIds: uniqueStrings,
  })
  .strict();

export const EvaluationHumanAnnotationsSchema = z
  .object({
    claims: z.array(EvaluationClaimAnnotationSchema).superRefine((claims, context) => {
      const ids = claims.map((claim) => claim.claimId);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: "custom", message: "claim annotation IDs must be unique" });
      }
    }),
    reportedGapIds: uniqueStrings,
  })
  .strict();

export type EvaluationHumanAnnotations = z.infer<typeof EvaluationHumanAnnotationsSchema>;

const PromptMeasurementSchema = z
  .object({
    requestId: nonEmpty,
    requestSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
    localInputTokens: z.number().int().nonnegative(),
    providerInputTokens: z.number().int().nonnegative(),
    gatePassed: z.boolean(),
  })
  .strict();

const EvaluatedClaimSchema = EvaluationClaimAnnotationSchema;

const EvaluatedMemoryProposalSchema = GoldenMemoryProposalSchema;

const SourceAuditSchema = z
  .object({
    sourceId: nonEmpty,
    authorized: z.boolean(),
    resolvable: z.boolean(),
  })
  .strict();

const TimingSchema = z
  .object({
    timeToFirstTokenMs: z.number().nonnegative(),
    timeToTerminalMs: z.number().positive(),
  })
  .strict()
  .superRefine((timing, context) => {
    if (timing.timeToFirstTokenMs > timing.timeToTerminalMs) {
      context.addIssue({
        code: "custom",
        message: "first token cannot follow terminal completion",
      });
    }
  });

const UsageSchema = z
  .object({
    providerRequestCount: z.number().int().positive(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().positive(),
  })
  .strict();

const AnswerEvaluationSchema = z
  .object({
    claims: z.array(EvaluatedClaimSchema),
    reportedGapIds: uniqueStrings,
    citationSourceIds: uniqueStrings,
    rawCitationTagCount: z.number().int().nonnegative(),
    citationDefectCount: z.number().int().nonnegative(),
  })
  .strict();

export const TaskCoordinateSchema = z.strictObject({
  taskId: nonEmpty,
  loopIteration: z.number().int().finite().safe().nonnegative(),
  attempt: z.number().int().finite().safe().nonnegative(),
});
export type TaskCoordinate = z.infer<typeof TaskCoordinateSchema>;

export const ProviderCoordinateSchema = TaskCoordinateSchema.extend({
  providerRequestIndex: z.number().int().finite().safe().nonnegative(),
}).strict();
export type ProviderCoordinate = z.infer<typeof ProviderCoordinateSchema>;

export const OutputCoordinateSchema = z.strictObject({
  nodeId: nonEmpty,
  iteration: z.number().int().finite().safe().nonnegative(),
});
export type OutputCoordinate = z.infer<typeof OutputCoordinateSchema>;

const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const Base64UrlDigestSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const PositiveIntegerSchema = z.number().int().finite().safe().positive();
const NonNegativeIntegerSchema = z.number().int().finite().safe().nonnegative();
const CandidateIdSchema = CandidateLocalIdSchema;
const PassageIdSchema = PassageLocalIdSchema;
const GroupIdSchema = GroupLocalIdSchema;

const coordinateKey = (coordinate: {
  readonly taskId: string;
  readonly loopIteration: number;
  readonly attempt: number;
  readonly providerRequestIndex?: number;
}): string =>
  [
    coordinate.taskId,
    coordinate.loopIteration,
    coordinate.attempt,
    "providerRequestIndex" in coordinate ? coordinate.providerRequestIndex : "",
  ].join("\u0000");

const outputCoordinateKey = (coordinate: OutputCoordinate): string =>
  `${coordinate.nodeId}\u0000${coordinate.iteration}`;

const uniqueCoordinateRows = (
  rows: readonly {
    readonly coordinate?: ProviderCoordinate | TaskCoordinate;
    readonly outputCoordinate?: OutputCoordinate;
  }[],
  context: z.RefinementCtx,
  path: string,
): void => {
  const keys = rows.map((row) =>
    row.coordinate !== undefined
      ? coordinateKey(row.coordinate)
      : outputCoordinateKey(row.outputCoordinate!),
  );
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: [path], message: "coordinates must be unique" });
  }
};

const CapturedFusionProvenanceSchema = z.strictObject({
  queryOrdinal: PositiveIntegerSchema,
  branch: z.enum(["public_documents", "chat_messages"]),
  rank: PositiveIntegerSchema,
  logicalRank: PositiveIntegerSchema.optional(),
});

export const CapturedFusedCandidateSchema = z
  .strictObject({
    resultId: ResultLocalIdSchema,
    identity: CanonicalIdentitySchema,
    identityKey: nonEmpty,
    score: z.number().finite().positive(),
    rrfK: PositiveIntegerSchema,
    bestRank: PositiveIntegerSchema,
    matchedQueryOrdinals: z.array(PositiveIntegerSchema),
    provenance: z.array(CapturedFusionProvenanceSchema).min(1),
    preview: nonBlankText,
    previewRanges: z.array(SourceRangeSchema),
    previewSha256Hex: DigestSchema,
    fullTokenCount: NonNegativeIntegerSchema,
    fastTokenCount: NonNegativeIntegerSchema,
    mainTokenCount: NonNegativeIntegerSchema,
    contentHash: DigestSchema,
    snapshotId: nonEmpty,
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.identityKey !== canonicalIdentityKey(candidate.identity)) {
      context.addIssue({
        code: "custom",
        path: ["identityKey"],
        message: "identity key is not canonical",
      });
    }
    const ordinals = [...new Set(candidate.provenance.map((entry) => entry.queryOrdinal))].sort(
      (left, right) => left - right,
    );
    if (JSON.stringify(ordinals) !== JSON.stringify(candidate.matchedQueryOrdinals)) {
      context.addIssue({
        code: "custom",
        path: ["matchedQueryOrdinals"],
        message: "query ordinals do not match provenance",
      });
    }
    const expectedBestRank = Math.min(
      ...candidate.provenance.map((entry) => entry.logicalRank ?? entry.rank),
    );
    if (candidate.bestRank !== expectedBestRank) {
      context.addIssue({
        code: "custom",
        path: ["bestRank"],
        message: "best rank does not match provenance",
      });
    }
    const provenanceKeys = candidate.provenance.map(
      (entry) => `${entry.queryOrdinal}\u0000${entry.branch}`,
    );
    if (new Set(provenanceKeys).size !== provenanceKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["provenance"],
        message: "provenance must be unique",
      });
    }
  });

const CapturedReviewPreviewRecordSchema = z.strictObject({
  identity: CanonicalIdentitySchema,
  snapshotId: nonEmpty,
  contentHash: DigestSchema,
  previewRanges: z.array(SourceRangeSchema).min(1),
  previewByteLength: PositiveIntegerSchema,
  previewSha256Hex: DigestSchema,
  fastTokenCount: NonNegativeIntegerSchema,
  mainTokenCount: NonNegativeIntegerSchema,
  recordDigestSha256Hex: DigestSchema,
});

export const CapturedPreviewSchema = z
  .strictObject({
    coordinate: ProviderCoordinateSchema,
    agentRole: z.literal("internal_retrieval"),
    slot: z.enum(["initial", "replacement"]),
    requestSha256Hex: DigestSchema,
    results: z.array(ReviewModelFusedResultMetadataSchema),
    coverage: z.array(BranchCoverageSchema).min(1),
    truncation: FusionTruncationSchema,
    records: z.array(CapturedReviewPreviewRecordSchema),
  })
  .strict()
  .superRefine((preview, context) => {
    const resultIds = preview.results.map((result) => result.resultId);
    if (
      new Set(resultIds).size !== resultIds.length ||
      resultIds.some((resultId, index) => resultId !== `r${index + 1}`)
    ) {
      context.addIssue({
        code: "custom",
        path: ["results"],
        message: "preview results must be ordered r1...",
      });
    }
    if (preview.results.length !== preview.records.length) {
      context.addIssue({
        code: "custom",
        path: ["records"],
        message: "preview records must align with results",
      });
    }
    for (const [index, result] of preview.results.entries()) {
      if (
        JSON.stringify(result.branchCoverage) !== JSON.stringify(preview.coverage) ||
        JSON.stringify(result.truncationFlags) !== JSON.stringify(preview.truncation)
      ) {
        context.addIssue({
          code: "custom",
          path: ["results", index],
          message: "preview result metadata differs from top-level coverage",
        });
      }
      const record = preview.records[index];
      const recordKind = record?.identity.kind === "chat_message" ? "chat_message" : "document";
      if (record !== undefined && result.kind !== recordKind) {
        context.addIssue({
          code: "custom",
          path: ["results", index, "kind"],
          message: "preview result kind does not match record identity",
        });
      }
    }
  });

const CapturedReviewSchema = z
  .strictObject({
    coordinate: ProviderCoordinateSchema,
    inputSha256Hex: DigestSchema,
    decision: QueryReviewSchema,
    results: z.array(ReviewModelFusedResultSchema),
    branchCoverage: z.array(BranchCoverageSchema),
    truncation: FusionTruncationSchema,
  })
  .superRefine((review, context) => {
    const resultIds = review.results.map((result) => result.resultId);
    if (
      new Set(resultIds).size !== resultIds.length ||
      resultIds.some((resultId, index) => resultId !== `r${index + 1}`)
    ) {
      context.addIssue({
        code: "custom",
        path: ["results"],
        message: "review results must be ordered r1...",
      });
    }
    for (const [index, result] of review.results.entries()) {
      if (
        JSON.stringify(result.branchCoverage) !== JSON.stringify(review.branchCoverage) ||
        JSON.stringify(result.truncationFlags) !== JSON.stringify(review.truncation)
      ) {
        context.addIssue({
          code: "custom",
          path: ["results", index],
          message: "review result metadata differs from review coverage",
        });
      }
    }
  });

const CapturedFinalResultSchema = z
  .strictObject({
    outputCoordinate: OutputCoordinateSchema,
    ownerCoordinate: TaskCoordinateSchema,
    result: z
      .strictObject({
        plan: InternalQueryPlanSchema,
        branchCoverage: z.array(BranchCoverageSchema),
        truncation: FusionTruncationSchema,
        candidates: z.array(CapturedFusedCandidateSchema),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((row, context) => {
    if (row.result === null) return;
    const resultIds = row.result.candidates.map((candidate) => candidate.resultId);
    if (resultIds.some((resultId, index) => resultId !== `r${index + 1}`)) {
      context.addIssue({
        code: "custom",
        path: ["result", "candidates"],
        message: "final candidates must be ordered r1...",
      });
    }
    const identityKeys = row.result.candidates.map((candidate) => candidate.identityKey);
    if (new Set(identityKeys).size !== identityKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["result", "candidates"],
        message: "final candidate identities must be unique",
      });
    }
  });

export const RetrievalCaptureSchema = z
  .strictObject({
    traces: z.array(
      z
        .strictObject({
          coordinate: TaskCoordinateSchema,
          trace: StructuredRetrievalTraceSchema,
        })
        .superRefine((row, context) => {
          if (row.trace.review === null && row.trace.replacementPlan !== null) {
            context.addIssue({ code: "custom", message: "replacement requires a review" });
          }
        }),
    ),
    reviews: z.array(CapturedReviewSchema),
    finalResults: z.array(CapturedFinalResultSchema),
    previews: z.array(CapturedPreviewSchema),
  })
  .strict()
  .superRefine((capture, context) => {
    uniqueCoordinateRows(capture.traces, context, "traces");
    uniqueCoordinateRows(capture.reviews, context, "reviews");
    uniqueCoordinateRows(capture.previews, context, "previews");
    const traceByTask = new Map(
      capture.traces.map((row) => [coordinateKey(row.coordinate), row] as const),
    );
    const finalKeys = capture.finalResults.map((row) => outputCoordinateKey(row.outputCoordinate));
    if (new Set(finalKeys).size !== finalKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["finalResults"],
        message: "final output coordinates must be unique",
      });
    }
    if (capture.finalResults.length !== capture.traces.length) {
      context.addIssue({
        code: "custom",
        path: ["finalResults"],
        message: "one final result row is required for every retrieval trace",
      });
    }
    for (const [index, traceRow] of capture.traces.entries()) {
      const matchingFinal = capture.finalResults.find(
        (row) =>
          row.ownerCoordinate.taskId === traceRow.coordinate.taskId &&
          row.ownerCoordinate.loopIteration === traceRow.coordinate.loopIteration &&
          row.ownerCoordinate.attempt === traceRow.coordinate.attempt,
      );
      if (matchingFinal === undefined) {
        context.addIssue({
          code: "custom",
          path: ["traces", index],
          message: "trace lacks final result row",
        });
        continue;
      }
      if (
        matchingFinal.outputCoordinate.nodeId !== matchingFinal.ownerCoordinate.taskId ||
        matchingFinal.outputCoordinate.iteration !== matchingFinal.ownerCoordinate.loopIteration
      ) {
        context.addIssue({
          code: "custom",
          path: ["finalResults"],
          message: "final output coordinate does not identify its owner task",
        });
      }
      const trace = traceRow.trace;
      const nullResultOutcome = trace.outcome === "skipped" || trace.outcome === "no_evidence";
      const expectedResult = nullResultOutcome ? null : matchingFinal.result;
      if (nullResultOutcome && matchingFinal.result !== null) {
        context.addIssue({
          code: "custom",
          path: ["finalResults"],
          message: `${trace.outcome} result must be null`,
        });
      }
      if (!nullResultOutcome && matchingFinal.result === null) {
        context.addIssue({
          code: "custom",
          path: ["finalResults"],
          message: "trace outcome requires a final result",
        });
      }
      if (expectedResult !== null && matchingFinal.result !== null) {
        const expectedPlan =
          trace.outcome === "replaced" ? trace.replacementPlan : trace.initialPlan;
        if (JSON.stringify(matchingFinal.result.plan) !== JSON.stringify(expectedPlan)) {
          context.addIssue({
            code: "custom",
            path: ["finalResults"],
            message: "final plan differs from trace",
          });
        }
      }
      const reviewRows = capture.reviews.filter(
        (row) =>
          row.coordinate.taskId === traceRow.coordinate.taskId &&
          row.coordinate.loopIteration === traceRow.coordinate.loopIteration &&
          row.coordinate.attempt === traceRow.coordinate.attempt,
      );
      if (trace.review === null) {
        if (reviewRows.length !== 0) {
          context.addIssue({
            code: "custom",
            path: ["reviews"],
            message: "skip trace cannot have a review",
          });
        }
      } else {
        if (reviewRows.length !== 1) {
          context.addIssue({
            code: "custom",
            path: ["reviews"],
            message: "trace must have exactly one review",
          });
        } else if (JSON.stringify(reviewRows[0]!.decision) !== JSON.stringify(trace.review)) {
          context.addIssue({
            code: "custom",
            path: ["reviews"],
            message: "review decision differs from trace",
          });
        }
      }
      const matchingPreviews = capture.previews.filter(
        (preview) =>
          preview.coordinate.taskId === traceRow.coordinate.taskId &&
          preview.coordinate.loopIteration === traceRow.coordinate.loopIteration &&
          preview.coordinate.attempt === traceRow.coordinate.attempt,
      );
      if (trace.review === null && matchingPreviews.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["previews"],
          message: "preview requires a review trace",
        });
      }
    }
    for (const [index, review] of capture.reviews.entries()) {
      if (!traceByTask.has(coordinateKey(review.coordinate))) {
        const taskMatch = capture.traces.some(
          (trace) =>
            trace.coordinate.taskId === review.coordinate.taskId &&
            trace.coordinate.loopIteration === review.coordinate.loopIteration &&
            trace.coordinate.attempt === review.coordinate.attempt,
        );
        if (!taskMatch) {
          context.addIssue({
            code: "custom",
            path: ["reviews", index],
            message: "review has no trace owner",
          });
        }
      }
      const matchingPreviews = capture.previews.filter(
        (preview) => coordinateKey(preview.coordinate) === coordinateKey(review.coordinate),
      );
      if (matchingPreviews.length !== 1) {
        context.addIssue({
          code: "custom",
          path: ["reviews", index],
          message: "review must bind exactly one private preview coordinate",
        });
      } else {
        const preview = matchingPreviews[0]!;
        if (preview.slot !== "initial") {
          context.addIssue({
            code: "custom",
            path: ["previews"],
            message: "review preview must be initial",
          });
        }
        if (review.inputSha256Hex !== preview.requestSha256Hex) {
          context.addIssue({
            code: "custom",
            path: ["previews"],
            message: "review and preview request digests differ",
          });
        }
        const previewResults = preview.results.map((result) => ({ ...result }));
        const reviewMetadata = review.results.map(({ preview: _preview, ...result }) => result);
        if (JSON.stringify(previewResults) !== JSON.stringify(reviewMetadata)) {
          context.addIssue({
            code: "custom",
            path: ["previews"],
            message: "preview results differ from review metadata",
          });
        }
        if (
          JSON.stringify(review.branchCoverage) !== JSON.stringify(preview.coverage) ||
          JSON.stringify(review.truncation) !== JSON.stringify(preview.truncation)
        ) {
          context.addIssue({
            code: "custom",
            path: ["previews"],
            message: "preview coverage differs from review",
          });
        }
      }
    }
  });

const CompactionGroupDefinitionSchema = z
  .strictObject({
    groupId: GroupIdSchema,
    candidateIds: z.array(CandidateIdSchema),
    renderedTokenBudget: PositiveIntegerSchema,
    mode: z.enum(["normal", "source_tool"]),
  })
  .superRefine((group, context) => {
    if (new Set(group.candidateIds).size !== group.candidateIds.length) {
      context.addIssue({
        code: "custom",
        path: ["candidateIds"],
        message: "group candidates must be unique",
      });
    }
  });

export const CompactionPlanRowSchema = z.discriminatedUnion("phase", [
  z
    .strictObject({
      phase: z.literal("initial"),
      outputCoordinate: OutputCoordinateSchema,
      providerCoordinate: ProviderCoordinateSchema,
      manifest: InitialContextManifestSchema,
      groups: z.array(CompactionGroupDefinitionSchema),
    })
    .superRefine((row, context) => {
      if (
        row.providerCoordinate.taskId !== row.outputCoordinate.nodeId ||
        row.providerCoordinate.loopIteration !== row.outputCoordinate.iteration
      ) {
        context.addIssue({
          code: "custom",
          message: "plan provider coordinate must own its output",
        });
      }
    }),
  z
    .strictObject({
      phase: z.literal("fallback"),
      outputCoordinate: OutputCoordinateSchema,
      providerCoordinate: ProviderCoordinateSchema,
      manifest: FallbackContextManifestSchema,
      groups: z.array(CompactionGroupDefinitionSchema),
    })
    .superRefine((row, context) => {
      if (
        row.providerCoordinate.taskId !== row.outputCoordinate.nodeId ||
        row.providerCoordinate.loopIteration !== row.outputCoordinate.iteration
      ) {
        context.addIssue({
          code: "custom",
          message: "plan provider coordinate must own its output",
        });
      }
    }),
]);

export const CompactionGroupOutputRowSchema = z
  .strictObject({
    phase: z.enum(["initial", "fallback"]),
    outputCoordinate: OutputCoordinateSchema,
    providerCoordinate: ProviderCoordinateSchema,
    envelope: GroupResultEnvelopeSchema,
  })
  .superRefine((row, context) => {
    if (
      row.providerCoordinate.taskId !== row.outputCoordinate.nodeId ||
      row.providerCoordinate.loopIteration !== row.outputCoordinate.iteration
    ) {
      context.addIssue({
        code: "custom",
        message: "group provider coordinate must own its output",
      });
    }
  });

const CompactionSelectionSchema = z.discriminatedUnion("action", [
  z
    .strictObject({
      candidateId: CandidateIdSchema,
      action: z.literal("keep"),
      passageIds: z.array(PassageIdSchema),
      ranges: z.array(SourceRangeSchema),
      groupId: GroupIdSchema.optional(),
    })
    .strict(),
  z
    .strictObject({
      candidateId: CandidateIdSchema,
      action: z.literal("range"),
      passageIds: z.array(PassageIdSchema).min(1),
      ranges: z.array(SourceRangeSchema).min(1),
      groupId: GroupIdSchema,
    })
    .strict(),
  z
    .strictObject({
      candidateId: CandidateIdSchema,
      action: z.literal("omit"),
      passageIds: z.array(PassageIdSchema),
      ranges: z.array(SourceRangeSchema),
      groupId: GroupIdSchema.optional(),
    })
    .strict(),
]);

export const CompactionCollectRowSchema = z
  .strictObject({
    outputCoordinate: OutputCoordinateSchema,
    phase: z.enum(["initial", "fallback"]),
    groups: z.array(CompactionGroupDefinitionSchema),
    taskIds: z.array(nonEmpty),
    envelopes: z.array(GroupResultEnvelopeSchema),
    selections: z.array(CompactionSelectionSchema),
    repairUsed: z.boolean(),
  })
  .superRefine((row, context) => {
    if (new Set(row.taskIds).size !== row.taskIds.length) {
      context.addIssue({
        code: "custom",
        path: ["taskIds"],
        message: "collect task IDs must be unique",
      });
    }
    const groupIds = row.groups.map((group) => group.groupId);
    const envelopeIds = row.envelopes.map((envelope) => envelope.groupId);
    if (
      new Set(groupIds).size !== groupIds.length ||
      new Set(envelopeIds).size !== envelopeIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["groups"],
        message: "collect group IDs must be unique",
      });
    }
    if (JSON.stringify([...groupIds].sort()) !== JSON.stringify([...envelopeIds].sort())) {
      context.addIssue({
        code: "custom",
        path: ["envelopes"],
        message: "collect envelopes must match groups",
      });
    }
    const selectionIds = row.selections.map((selection) => selection.candidateId);
    if (new Set(selectionIds).size !== selectionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["selections"],
        message: "collect selections must be unique",
      });
    }
  });

const RestrictedRangeSchema = z
  .strictObject({
    charStart: NonNegativeIntegerSchema,
    charEnd: PositiveIntegerSchema,
  })
  .superRefine((range, context) => {
    if (range.charEnd <= range.charStart) {
      context.addIssue({ code: "custom", message: "range end must be greater than start" });
    }
  });

const RestrictedConversationBindingSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("complete"),
      turnId: z.uuid(),
      userMessageId: z.uuid(),
      assistantMessageId: z.uuid(),
    })
    .strict(),
  z
    .strictObject({
      kind: z.literal("failed"),
      turnId: z.uuid(),
      userMessageId: z.uuid(),
      errorCode: nonEmpty,
      retryable: z.boolean(),
    })
    .strict(),
]);
const RestrictedContextLedgerSchema = z.discriminatedUnion("requestKind", [
  z
    .strictObject({
      requestKind: z.literal("direct"),
      modelId: z.literal("glm-5-turbo"),
      requestSha256Hex: DigestSchema,
      inputTokens: NonNegativeIntegerSchema,
      usableInputTokens: PositiveIntegerSchema,
      requestedOutputTokens: PositiveIntegerSchema,
      selectedConversation: z.array(RestrictedConversationBindingSchema),
      question: nonBlankText,
      gaps: z.array(z.string()),
      sources: z.array(
        z
          .strictObject({
            candidateId: nonEmpty,
            sourceKey: nonEmpty,
            kind: z.enum(["document", "chat_message", "memory", "web"]),
            purpose: nonEmpty,
            label: z.string().nullable(),
            ranges: z.array(RestrictedRangeSchema),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .strictObject({
      requestKind: z.literal("topic"),

      modelId: z.literal("glm-5-turbo"),
      requestSha256Hex: DigestSchema,
      inputTokens: NonNegativeIntegerSchema,
      usableInputTokens: PositiveIntegerSchema,
      requestedOutputTokens: PositiveIntegerSchema,
      selectedConversation: z.array(RestrictedConversationBindingSchema),
      topicId: z.enum(["t1", "t2", "t3"]),
      question: nonBlankText,
      gaps: z.array(z.string()),
      sources: z.array(
        z
          .strictObject({
            candidateId: nonEmpty,
            sourceKey: nonEmpty,
            kind: z.enum(["document", "chat_message", "memory", "web"]),
            purpose: nonEmpty,
            label: z.string().nullable(),
            ranges: z.array(RestrictedRangeSchema),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .strictObject({
      requestKind: z.literal("synthesis"),
      modelId: z.literal("glm-5-turbo"),
      requestSha256Hex: DigestSchema,
      inputTokens: NonNegativeIntegerSchema,
      usableInputTokens: PositiveIntegerSchema,
      requestedOutputTokens: PositiveIntegerSchema,
      selectedConversation: z.array(RestrictedConversationBindingSchema),
      packets: z
        .array(
          z
            .strictObject({
              topicId: z.enum(["t1", "t2", "t3"]),
              status: z.enum(["answered", "partial"]),
              claimCount: NonNegativeIntegerSchema,
              gapCount: NonNegativeIntegerSchema,
              packetSha256Hex: DigestSchema,
            })
            .strict(),
        )
        .min(2)
        .max(3),
    })
    .strict(),
]);

export const ContextMeasurementCaptureSchema = z
  .strictObject({
    coordinate: TaskCoordinateSchema,
    consumerTaskId: nonEmpty,
    topicId: z.enum(["t1", "t2", "t3"]).optional(),
    mandatoryInputTokens: NonNegativeIntegerSchema,
    discretionaryInputTokens: NonNegativeIntegerSchema,
    totalInputTokens: NonNegativeIntegerSchema,
    requestedOutputTokens: PositiveIntegerSchema,
    usableInputTokens: PositiveIntegerSchema,
    contextWindow: PositiveIntegerSchema,
    status: z.enum(["ready", "needs_compaction", "failed"]),
    compactionRan: z.boolean(),
    compactionFeedback: z.array(z.string()),
    restrictedContextLedger: RestrictedContextLedgerSchema,
  })
  .strict()
  .superRefine((measurement, context) => {
    if (
      measurement.totalInputTokens !==
      measurement.mandatoryInputTokens + measurement.discretionaryInputTokens
    ) {
      context.addIssue({ code: "custom", message: "context token marginals do not add up" });
    }
    if (measurement.restrictedContextLedger.inputTokens !== measurement.totalInputTokens) {
      context.addIssue({
        code: "custom",
        message: "context ledger input count differs from measurement",
      });
    }
    if (
      measurement.restrictedContextLedger.usableInputTokens !== measurement.usableInputTokens ||
      measurement.restrictedContextLedger.requestedOutputTokens !==
        measurement.requestedOutputTokens
    ) {
      context.addIssue({
        code: "custom",
        message: "context ledger budget differs from measurement",
      });
    }
    const fits = measurement.totalInputTokens <= measurement.usableInputTokens;
    if (
      (measurement.status === "ready" && !fits) ||
      (measurement.status === "needs_compaction" && fits)
    ) {
      context.addIssue({ code: "custom", message: "context status differs from exact fit" });
    }
    if (
      measurement.topicId !== undefined &&
      measurement.restrictedContextLedger.requestKind === "topic" &&
      measurement.restrictedContextLedger.topicId !== measurement.topicId
    ) {
      context.addIssue({ code: "custom", message: "context topic differs from ledger" });
    }
  });
const CandidateLedgerCaptureRowSchema = z
  .strictObject({
    candidateId: CandidateLocalIdSchema,
    kind: z.enum([
      "conversation_entry",
      "document",
      "chat_message",
      "memory",
      "web",
      "topic_packet",
    ]),
    identity: CanonicalIdentitySchema,
    identityKey: nonEmpty,
    provenance: CandidateProvenanceSchema,
    baseRanges: z.array(SourceRangeSchema),
    previewRanges: z.array(SourceRangeSchema),
    previewSha256Hex: DigestSchema,
    renderedTokenCount: NonNegativeIntegerSchema,
    chatRole: z.enum(["user", "assistant", "system"]).optional(),
  })
  .superRefine((row, context) => {
    if (row.identityKey !== canonicalIdentityKey(row.identity)) {
      context.addIssue({
        code: "custom",
        path: ["identityKey"],
        message: "identity key is not canonical",
      });
    }
    const identityCompatible =
      row.kind === "document"
        ? row.identity.kind === "public_document"
        : row.identity.kind === row.kind;
    if (!identityCompatible) {
      context.addIssue({
        code: "custom",
        path: ["identity"],
        message: "identity kind does not match candidate kind",
      });
    }
    if (row.kind === "chat_message" && row.chatRole === undefined) {
      context.addIssue({
        code: "custom",
        path: ["chatRole"],
        message: "chat candidates require a chat role",
      });
    }
    if (row.kind !== "chat_message" && row.chatRole !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["chatRole"],
        message: "chat role is only valid for chat candidates",
      });
    }
    for (const [index, preview] of row.previewRanges.entries()) {
      if (
        !row.baseRanges.some(
          (base) => preview.charStart >= base.charStart && preview.charEnd <= base.charEnd,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["previewRanges", index],
          message: "preview range must be contained by a base range",
        });
      }
    }
  });
export type CandidateLedgerCaptureRow = z.infer<typeof CandidateLedgerCaptureRowSchema>;

export const ContextSummaryRowSchema = z
  .strictObject({
    outputCoordinate: OutputCoordinateSchema,
    stage: z.enum(["initial", "after_initial", "after_fallback"]),
    consumerTaskId: nonEmpty,
    topicId: z.enum(["t1", "t2", "t3"]).optional(),
    status: z.enum(["ready", "needs_compaction", "failed"]),
    inputTokens: NonNegativeIntegerSchema,
    usableInputTokens: PositiveIntegerSchema,
    compactionRan: z.boolean(),
    candidateLedger: z.array(CandidateLedgerCaptureRowSchema),
    selectedCandidateIds: uniqueStrings,
    sourceKeys: uniqueStrings,
    failureCode: z
      .enum([
        "context_mandatory_too_large",
        "context_plan_unfit",
        "context_budget_mismatch",
        "synthesis_budget_mismatch",
      ])
      .optional(),
  })
  .superRefine((row, context) => {
    const ledgerIds = row.candidateLedger.map((candidate) => candidate.candidateId);
    const ledgerIdentityKeys = row.candidateLedger.map((candidate) => candidate.identityKey);
    for (const [index, candidateId] of ledgerIds.entries()) {
      if (candidateId !== `c${index + 1}`) {
        context.addIssue({
          code: "custom",
          path: ["candidateLedger", index, "candidateId"],
          message: "candidate IDs must be sequential in ledger order",
        });
      }
    }
    if (new Set(ledgerIds).size !== ledgerIds.length) {
      context.addIssue({
        code: "custom",
        path: ["candidateLedger"],
        message: "candidate IDs must be unique",
      });
    }
    if (new Set(ledgerIdentityKeys).size !== ledgerIdentityKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["candidateLedger"],
        message: "candidate identities must be unique",
      });
    }
    for (const [index, candidateId] of row.selectedCandidateIds.entries()) {
      if (!ledgerIds.includes(candidateId)) {
        context.addIssue({
          code: "custom",
          path: ["selectedCandidateIds", index],
          message: "selected candidate must exist in ledger",
        });
      }
    }
    if (row.selectedCandidateIds.length !== row.sourceKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["sourceKeys"],
        message: "source keys must match selected candidate cardinality",
      });
    }
    if (row.status === "failed" && row.failureCode === undefined) {
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "failed context needs a failure code",
      });
    }
    if (row.status !== "failed" && row.failureCode !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "successful context cannot fail",
      });
    }
  });

export const CompactionCaptureSchema = z
  .strictObject({
    plans: z.array(CompactionPlanRowSchema),
    groups: z.array(CompactionGroupOutputRowSchema),
    collects: z.array(CompactionCollectRowSchema),
    contexts: z.array(ContextSummaryRowSchema),
    measurements: z.array(ContextMeasurementCaptureSchema),
  })
  .strict()
  .superRefine((capture, context) => {
    uniqueCoordinateRows(capture.plans, context, "plans");
    uniqueCoordinateRows(capture.groups, context, "groups");
    uniqueCoordinateRows(capture.collects, context, "collects");
    uniqueCoordinateRows(capture.contexts, context, "contexts");
    uniqueCoordinateRows(capture.measurements, context, "measurements");
  });

const TerminalSourceMapSchema = z
  .strictObject({
    sourceKey: z.string().regex(/^k_cn_[A-Za-z0-9_-]{22}_[1-9][0-9]*$/u),
    candidateId: CandidateLocalIdSchema.optional(),
    kind: z.enum(["document", "chat_message", "memory", "web"]),
    label: z.string().nullable(),
    ranges: z.array(SourceRangeSchema),
    contentHash: z.union([DigestSchema, Base64UrlDigestSchema]).optional(),
    sourceIdentityDigest: DigestSchema,
  })
  .superRefine((source, context) => {
    const requiresContentHash = source.kind === "document" || source.kind === "web";
    if (requiresContentHash && source.contentHash === undefined) {
      context.addIssue({
        code: "custom",
        path: ["contentHash"],
        message: "document and web sources require content hash",
      });
    }
    if (
      source.kind === "document" &&
      source.contentHash !== undefined &&
      !DigestSchema.safeParse(source.contentHash).success
    ) {
      context.addIssue({
        code: "custom",
        path: ["contentHash"],
        message: "document content hash must be lowercase hexadecimal SHA-256",
      });
    }
    if (
      source.kind === "web" &&
      source.contentHash !== undefined &&
      !Base64UrlDigestSchema.safeParse(source.contentHash).success
    ) {
      context.addIssue({
        code: "custom",
        path: ["contentHash"],
        message: "web quote hash must be base64url SHA-256",
      });
    }
    if (!requiresContentHash && source.contentHash !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["contentHash"],
        message: "chat and memory sources forbid content hash",
      });
    }
  });

export const TerminalRequestSchema = z
  .strictObject({
    coordinate: ProviderCoordinateSchema,
    requestKind: z.enum(["direct", "topic", "synthesis"]),
    consumerTaskId: nonEmpty,
    topicId: z.enum(["t1", "t2", "t3"]).optional(),
    requestSha256Hex: DigestSchema,
    localInputTokens: NonNegativeIntegerSchema,
    providerInputTokens: NonNegativeIntegerSchema,
    requestedOutputTokens: PositiveIntegerSchema,
    usableInputTokens: PositiveIntegerSchema,
    sourceMap: z.array(TerminalSourceMapSchema),
    proofDigests: z.array(DigestSchema),
    evidenceSha256Hex: DigestSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.consumerTaskId !== request.coordinate.taskId) {
      context.addIssue({
        code: "custom",
        path: ["consumerTaskId"],
        message: "request owner differs from coordinate task",
      });
    }
    if (request.localInputTokens > request.usableInputTokens) {
      context.addIssue({
        code: "custom",
        path: ["localInputTokens"],
        message: "answer input exceeds usable allowance",
      });
    }
    if (request.requestKind === "topic" && request.topicId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["topicId"],
        message: "topic request requires topic ID",
      });
    }
    if (request.requestKind !== "topic" && request.topicId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["topicId"],
        message: "non-topic request forbids topic ID",
      });
    }
    const sourceKeys = request.sourceMap.map((source) => source.sourceKey);
    const candidateIds = request.sourceMap.flatMap((source) =>
      source.candidateId === undefined ? [] : [source.candidateId],
    );
    if (new Set(sourceKeys).size !== sourceKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["sourceMap"],
        message: "source keys must be unique",
      });
    }
    if (new Set(candidateIds).size !== candidateIds.length) {
      context.addIssue({
        code: "custom",
        path: ["sourceMap"],
        message: "source candidate IDs must be unique",
      });
    }
    if (request.requestKind === "synthesis") {
      request.sourceMap.forEach((source, index) => {
        if (source.candidateId !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["sourceMap", index, "candidateId"],
            message: "synthesis source cannot have a candidate ID",
          });
        }
      });
    } else {
      request.sourceMap.forEach((source, index) => {
        if (source.candidateId === undefined) {
          context.addIssue({
            code: "custom",
            path: ["sourceMap", index, "candidateId"],
            message: "direct/topic source requires a candidate ID",
          });
        }
      });
    }
    if (new Set(request.proofDigests).size !== request.proofDigests.length) {
      context.addIssue({
        code: "custom",
        path: ["proofDigests"],
        message: "proof digests must be unique",
      });
    }
  });

export const TerminalEvidenceCaptureSchema = z
  .strictObject({ requests: z.array(TerminalRequestSchema) })
  .strict()
  .superRefine((capture, context) => {
    uniqueCoordinateRows(capture.requests, context, "requests");
  });

const CommonTurnResultFields = {
  caseId: nonEmpty,
  capture: CaptureSchema,
  promptMeasurements: z.array(PromptMeasurementSchema).min(1),
  answer: AnswerEvaluationSchema,
  memoryProposals: z.array(EvaluatedMemoryProposalSchema),
  pulledSourceIds: uniqueStrings,
  serializedSourceIds: uniqueStrings,
  serializedContextTokens: NonNegativeIntegerSchema,
  sourceAudit: z.array(SourceAuditSchema),
  timing: TimingSchema,
  usage: UsageSchema,
} as const;

const CommonTurnResultSchema = z.strictObject({
  artifactVersion: z.literal(4),
  goldenSetVersion: z.literal(4),
  ...CommonTurnResultFields,
  retrieval: RetrievalCaptureSchema,
  compaction: CompactionCaptureSchema,
  terminalEvidence: TerminalEvidenceCaptureSchema,
});

export const SpecializedEvaluationResultSchema = CommonTurnResultSchema.extend({
  topology: z.literal("specialized"),
  planTurn: EvaluationPlanTurnSchema,
  selectorSelections: z
    .object({
      A: uniqueStrings,
      B: uniqueStrings,
      W: uniqueStrings,
    })
    .strict(),
}).strict();

export type SpecializedEvaluationResult = z.infer<typeof SpecializedEvaluationResultSchema>;

export const GeneralPlannerEvaluationResultSchema = CommonTurnResultSchema.extend({
  topology: z.literal("general_planner"),
  planTurn: EvaluationPlanTurnSchema,
}).strict();

export type GeneralPlannerEvaluationResult = z.infer<typeof GeneralPlannerEvaluationResultSchema>;

export const SpecializedEvaluationResultsSchema = z.array(SpecializedEvaluationResultSchema);
export const GeneralPlannerEvaluationResultsSchema = z.array(GeneralPlannerEvaluationResultSchema);
