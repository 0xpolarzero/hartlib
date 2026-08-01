import { z } from "zod";

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

export const GoldenEvaluationSetV3Schema = z
  .object({
    version: z.literal(3),
    cases: z.array(GoldenEvaluationCaseSchema).min(1),
  })
  .strict()
  .superRefine((set, context) => {
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
  });

export type GoldenEvaluationSetV3 = z.infer<typeof GoldenEvaluationSetV3Schema>;

const CaptureFieldsSchema = z
  .object({
    runId: z.uuid(),
    provider: z.literal("zai"),
    modelIds: z
      .array(z.enum(["glm-5.2", "glm-5-turbo"]))
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

const SelectedSourceSchema = z
  .object({
    sourceId: nonEmpty,
    ranges: z.array(EvaluationRangeSchema),
  })
  .strict();

const ReductionDecisionSchema = z.discriminatedUnion("action", [
  z
    .object({ sourceId: nonEmpty, action: z.literal("keep"), ranges: z.array(z.never()).length(0) })
    .strict(),
  z
    .object({
      sourceId: nonEmpty,
      action: z.literal("range"),
      ranges: z.array(EvaluationRangeSchema).min(1),
    })
    .strict(),
  z
    .object({ sourceId: nonEmpty, action: z.literal("omit"), ranges: z.array(z.never()).length(0) })
    .strict(),
]);

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

const CommonTurnResultSchema = z
  .object({
    artifactVersion: z.literal(3),
    goldenSetVersion: z.literal(3),
    caseId: nonEmpty,
    capture: CaptureSchema,
    promptMeasurements: z.array(PromptMeasurementSchema).min(1),
    answer: AnswerEvaluationSchema,
    memoryProposals: z.array(EvaluatedMemoryProposalSchema),
    pulledSourceIds: uniqueStrings,
    serializedSourceIds: uniqueStrings,
    serializedContextTokens: z.number().int().nonnegative(),
    sourceAudit: z.array(SourceAuditSchema),
    timing: TimingSchema,
    usage: UsageSchema,
  })
  .strict();

const ProviderUsageCoordinateSchema = z
  .object({
    taskId: nonEmpty,
    loopIteration: z.number().int().nonnegative(),
    attempt: z.number().int().nonnegative(),
    providerRequestIndex: z.number().int().nonnegative(),
  })
  .strict();

const ProductionConversationBindingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("complete"),
      fixtureTurnId: nonEmpty,
      turnId: z.uuid(),
      userMessageId: z.uuid(),
      assistantMessageId: z.uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("failed"),
      fixtureTurnId: nonEmpty,
      turnId: z.uuid(),
      userMessageId: z.uuid(),
      errorCode: z.string(),
      retryable: z.boolean(),
    })
    .strict(),
]);

const ProductionSourceBindingSchema = z
  .object({
    candidateId: nonEmpty,
    sourceId: nonEmpty,
    sourceKey: z.string().regex(/^k_cn_[A-Za-z0-9_-]{22}_[1-9][0-9]*$/u),
    kind: z.enum(["document", "chat_message", "memory", "web"]),
    purpose: nonEmpty,
    label: z.string().nullable(),
    ranges: z.array(EvaluationRangeSchema),
    contentOverride: z.string().optional(),
  })
  .strict();

const ProductionTopicPacketSchema = z
  .object({
    topicId: z.enum(["t1", "t2", "t3"]),
    status: z.enum(["answered", "partial"]),
    claimCount: z.number().int().nonnegative(),
    gapCount: z.number().int().nonnegative(),
    packetSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

const ProductionLedgerCommon = {
  modelId: z.literal("glm-5-turbo"),
  requestSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
  inputTokens: z.number().int().nonnegative(),
  usableInputTokens: z.number().int().positive(),
  requestedOutputTokens: z.number().int().positive(),
  selectedConversation: z.array(ProductionConversationBindingSchema),
} as const;

const ProductionDirectLedgerSchema = z
  .object({
    ...ProductionLedgerCommon,
    requestKind: z.literal("direct"),
    question: nonEmpty,
    gaps: z.array(z.string()),
    sources: z.array(ProductionSourceBindingSchema),
  })
  .strict();

const ProductionTopicLedgerSchema = z
  .object({
    ...ProductionLedgerCommon,
    requestKind: z.literal("topic"),
    topicId: z.enum(["t1", "t2", "t3"]),
    question: nonEmpty,
    gaps: z.array(z.string()),
    sources: z.array(ProductionSourceBindingSchema),
  })
  .strict();

const ProductionSynthesisLedgerSchema = z
  .object({
    ...ProductionLedgerCommon,
    requestKind: z.literal("synthesis"),
    packets: z.array(ProductionTopicPacketSchema).min(2).max(3),
  })
  .strict();

const ProductionContextLedgerSchema = z.discriminatedUnion("requestKind", [
  ProductionDirectLedgerSchema,
  ProductionTopicLedgerSchema,
  ProductionSynthesisLedgerSchema,
]);

const ProductionTerminalLedgerSchema = z
  .object({
    ledger: ProductionContextLedgerSchema,
    terminalUsageCoordinate: ProviderUsageCoordinateSchema,
    providerInputTokens: z.number().int().nonnegative(),
  })
  .strict();

const ProductionDecisionSchema = z.discriminatedUnion("action", [
  z
    .object({
      candidateId: nonEmpty,
      action: z.literal("keep"),
      ranges: z.array(z.never()).length(0),
    })
    .strict(),
  z
    .object({
      candidateId: nonEmpty,
      action: z.literal("range"),
      ranges: z.array(EvaluationRangeSchema).min(1),
    })
    .strict(),
  z
    .object({
      candidateId: nonEmpty,
      action: z.literal("omit"),
      ranges: z.array(z.never()).length(0),
    })
    .strict(),
]);

const PlanTurnAttestationSchema = z
  .object({
    modelId: z.literal("glm-5-turbo"),
    requestSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
    inputTokens: z.number().int().nonnegative(),
    usableInputTokens: z.number().int().positive(),
    requestedOutputTokens: z.literal(2048),
    currentUserMessageId: z.uuid(),
    currentDate: z.iso.date(),
    conversation: z.array(ProductionConversationBindingSchema),
    terminalUsageCoordinate: ProviderUsageCoordinateSchema,
  })
  .strict();

const ProductionTopologyAttestationSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("clarification"),
      planTurnRequest: PlanTurnAttestationSchema,
      providerInputTokens: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("single_fit"),
      initial: ProductionDirectLedgerSchema,
      terminal: ProductionTerminalLedgerSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("single_reduced"),
      initial: ProductionDirectLedgerSchema,
      terminal: ProductionTerminalLedgerSchema,
      iterations: z.number().int().min(1).max(2),
      decisions: z.array(ProductionDecisionSchema).min(1),
    })
    .strict(),
  z
    .object({
      mode: z.literal("fanout"),
      topics: z
        .array(
          z
            .object({
              topicId: z.enum(["t1", "t2", "t3"]),
              reduced: z.boolean(),
              iterations: z.number().int().min(0).max(2),
              decisions: z.array(ProductionDecisionSchema),
              initial: ProductionTopicLedgerSchema,
              terminal: ProductionTerminalLedgerSchema,
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
        ),
      synthesis: ProductionTerminalLedgerSchema,
    })
    .strict(),
]);

export const SpecializedEvaluationResultV3Schema = CommonTurnResultSchema.extend({
  topology: z.literal("specialized"),
  planTurn: EvaluationPlanTurnSchema,
  selectorSelections: z
    .object({
      A: uniqueStrings,
      B: uniqueStrings,
      W: uniqueStrings,
    })
    .strict(),
  reduction: z
    .object({
      required: z.boolean(),
      iterations: z.number().int().min(0).max(2),
      candidateTokens: z.number().int().nonnegative(),
      serializedTokens: z.number().int().nonnegative(),
      usableInputTokens: z.number().int().nonnegative(),
      candidateSourceIds: uniqueStrings,
      candidateSelections: z.array(SelectedSourceSchema),
      decisions: z.array(ReductionDecisionSchema),
      selections: z.array(SelectedSourceSchema),
    })
    .strict(),
  productionContext: ProductionTopologyAttestationSchema,
})
  .strict()
  .superRefine((result, context) => {
    const conversationTurnIds = (
      conversation: readonly { readonly fixtureTurnId: string }[],
    ): readonly string[] => conversation.map((entry) => entry.fixtureTurnId);
    const sameSequence = (left: readonly string[], right: readonly string[]): boolean =>
      left.length === right.length && left.every((value, index) => value === right[index]);
    const sameUniqueSet = (left: readonly string[], right: readonly string[]): boolean => {
      if (new Set(left).size !== left.length || new Set(right).size !== right.length) return false;
      return left.length === right.length && left.every((value) => right.includes(value));
    };
    const issue = (path: (string | number)[], message: string): void => {
      context.addIssue({ code: "custom", path, message });
    };

    const directPlan = result.planTurn.mode === "single" ? result.planTurn : undefined;
    const fanoutPlan = result.planTurn.mode === "fanout" ? result.planTurn : undefined;
    const production = result.productionContext;

    if (result.planTurn.mode === "clarify") {
      if (production.mode !== "clarification") {
        issue(
          ["productionContext", "mode"],
          "clarification plan-turn requires clarification production",
        );
      }
      return;
    }

    if (directPlan !== undefined) {
      if (production.mode !== "single_fit" && production.mode !== "single_reduced") {
        issue(["productionContext", "mode"], "single plan-turn requires a direct production route");
        return;
      }
      const ledgers = [
        ["initial", production.initial] as const,
        ["terminal", production.terminal.ledger] as const,
      ];
      for (const [name, ledger] of ledgers) {
        if (ledger.requestKind !== "direct") {
          issue(["productionContext", name], "single production ledger must be direct");
          continue;
        }
        if (ledger.question !== directPlan.question) {
          issue(
            ["productionContext", name, "question"],
            "direct ledger differs from plan-turn: question",
          );
        }
        if (
          !sameSequence(
            conversationTurnIds(ledger.selectedConversation),
            directPlan.relevantTurnIds,
          )
        ) {
          issue(
            ["productionContext", name, "selectedConversation"],
            "direct ledger differs from plan-turn: selected conversation",
          );
        }
      }
      return;
    }

    if (fanoutPlan === undefined) return;
    if (production.mode !== "fanout") {
      issue(["productionContext", "mode"], "fanout plan-turn requires fanout production");
      return;
    }

    const expectedTopicIds = fanoutPlan.topics.map((topic) => topic.topicId);
    const actualTopicIds = production.topics.map((topic) => topic.topicId);
    if (!sameSequence(actualTopicIds, expectedTopicIds)) {
      issue(
        ["productionContext", "topics"],
        "fanout production topics must match the complete plan-turn topic sequence",
      );
    }
    for (let index = 0; index < fanoutPlan.topics.length; index += 1) {
      const expected = fanoutPlan.topics[index];
      const actual = production.topics[index];
      if (expected === undefined || actual === undefined) continue;
      if (actual.topicId !== expected.topicId) {
        issue(["productionContext", "topics", index, "topicId"], "topic ID differs from plan-turn");
      }
      for (const [name, ledger] of [
        ["initial", actual.initial] as const,
        ["terminal", actual.terminal.ledger] as const,
      ]) {
        if (ledger.requestKind !== "topic") {
          issue(
            ["productionContext", "topics", index, name],
            "fanout topic ledger must be a topic route",
          );
          continue;
        }
        if (ledger.topicId !== expected.topicId) {
          issue(
            ["productionContext", "topics", index, name, "topicId"],
            "topic ledger differs from plan-turn: topic ID",
          );
        }
        if (ledger.question !== expected.question) {
          issue(
            ["productionContext", "topics", index, name, "question"],
            "topic ledger differs from plan-turn: question",
          );
        }
        if (
          !sameUniqueSet(conversationTurnIds(ledger.selectedConversation), expected.relevantTurnIds)
        ) {
          issue(
            ["productionContext", "topics", index, name, "selectedConversation"],
            "topic ledger differs from plan-turn: selected conversation",
          );
        }
      }
    }

    const synthesis = production.synthesis.ledger;
    if (synthesis.requestKind !== "synthesis") {
      issue(["productionContext", "synthesis", "ledger"], "fanout synthesis ledger is missing");
      return;
    }
    if (
      !sameSequence(
        synthesis.packets.map((packet) => packet.topicId),
        expectedTopicIds,
      )
    ) {
      issue(
        ["productionContext", "synthesis", "ledger", "packets"],
        "synthesis packet IDs must match the complete plan-turn topic sequence",
      );
    }
    const expectedSynthesisTurns = fanoutPlan.topics.flatMap((topic) => topic.relevantTurnIds);
    if (
      !sameSequence(conversationTurnIds(synthesis.selectedConversation), expectedSynthesisTurns)
    ) {
      issue(
        ["productionContext", "synthesis", "ledger", "selectedConversation"],
        "synthesis selected conversation differs from plan-turn",
      );
    }
  });

export type SpecializedEvaluationResultV3 = z.infer<typeof SpecializedEvaluationResultV3Schema>;

export const GeneralPlannerEvaluationResultV3Schema = CommonTurnResultSchema.extend({
  topology: z.literal("general_planner"),
  planTurn: EvaluationPlanTurnSchema,
}).strict();

export type GeneralPlannerEvaluationResultV3 = z.infer<
  typeof GeneralPlannerEvaluationResultV3Schema
>;

export const SpecializedEvaluationResultsV3Schema = z.array(SpecializedEvaluationResultV3Schema);
export const GeneralPlannerEvaluationResultsV3Schema = z.array(
  GeneralPlannerEvaluationResultV3Schema,
);

export const EvaluationResultV3Schema = z.union([
  SpecializedEvaluationResultV3Schema,
  GeneralPlannerEvaluationResultV3Schema,
]);
export type EvaluationResultV3 = z.infer<typeof EvaluationResultV3Schema>;
const V3DocumentSourceNamespaceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("public"),
      sourceId: z.string().regex(/^public:[^:\s]+$/u),
    })
    .strict(),
  z
    .object({
      kind: z.literal("publisher"),
      sourceId: z.string().regex(/^publisher:[^:\s]+$/u),
      issueId: z.string().trim().min(1),
      documentId: z.string().trim().min(1),
    })
    .strict(),
]);

const V3SourceBindingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("document"),
      sourceId: z.string().regex(/^(?:public|publisher):[^:\s]+$/u),
      goldenSourceId: z.string().trim().min(1),
      documentId: z.string().trim().min(1),
      snapshotId: z.string().trim().min(1),
      contentHash: z.string().trim().min(1),
      publisherExtractionId: z.uuid().nullable(),
      source: V3DocumentSourceNamespaceSchema,
    })
    .strict()
    .superRefine((binding, context) => {
      if (binding.sourceId !== binding.source.sourceId) {
        context.addIssue({
          code: "custom",
          path: ["sourceId"],
          message: "source namespace mismatch",
        });
      }
      if (
        (binding.source.kind === "publisher" && binding.publisherExtractionId === null) ||
        (binding.source.kind === "public" && binding.publisherExtractionId !== null)
      ) {
        context.addIssue({
          code: "custom",
          path: ["publisherExtractionId"],
          message: "publisher extraction identity must match source namespace",
        });
      }
      if (binding.source.kind === "publisher" && binding.source.documentId !== binding.documentId) {
        context.addIssue({
          code: "custom",
          path: ["documentId"],
          message: "publisher document mismatch",
        });
      }
    }),
  z
    .object({
      kind: z.literal("chat_message"),
      sourceId: z.string().trim().min(1),
      messageId: z.uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("memory"),
      sourceId: z.string().trim().min(1),
      memoryId: z.uuid(),
      memoryRevisionId: z.uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("web"),
      sourceId: z.string().trim().min(1),
      url: z.url(),
      title: z.string().trim().min(1),
      domain: z.string().trim().min(1),
      capturedAt: z.iso.datetime(),
    })
    .strict(),
]);

export const EvaluationSeedManifestV3Schema = z
  .object({
    artifactVersion: z.literal(3),
    goldenSetVersion: z.literal(3),
    sessionId: z.uuid(),
    caseId: z.string().trim().min(1),
    topology: z.enum(["specialized", "general_planner"]),
    userId: z.string().trim().min(1),
    companyId: z.uuid(),
    chatId: z.uuid(),
    userMessageId: z.uuid(),
    aiRunId: z.uuid(),
    turnBindings: z
      .array(
        z
          .object({
            turnId: z.string().trim().min(1),
            aiRunId: z.uuid(),
            userMessageId: z.uuid(),
            assistantMessageId: z.uuid(),
          })
          .strict(),
      )
      .superRefine((bindings, context) => {
        const ids = bindings.map((binding) => binding.turnId);
        if (new Set(ids).size !== ids.length) {
          context.addIssue({ code: "custom", message: "turn binding IDs must be unique" });
        }
      }),
    sourceBindings: z.array(V3SourceBindingSchema),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.caseId.trim() === "") {
      context.addIssue({ code: "custom", path: ["caseId"], message: "case ID is required" });
    }
    const sourceIds = manifest.sourceBindings.map((binding) => binding.sourceId);
    if (new Set(sourceIds).size !== sourceIds.length) {
      context.addIssue({
        code: "custom",
        path: ["sourceBindings"],
        message: "source IDs must be unique",
      });
    }
  });

export type EvaluationSeedManifestV3 = z.infer<typeof EvaluationSeedManifestV3Schema>;

export const EvaluationAnnotationFileV3Schema = z
  .object({
    artifactVersion: z.literal(3),
    goldenSetVersion: z.literal(3),
    sessionId: z.uuid(),
    annotations: z.array(
      z
        .object({
          caseId: z.string().trim().min(1),
          topology: z.enum(["specialized", "general_planner"]),
          claims: EvaluationHumanAnnotationsSchema.shape.claims,
          reportedGapIds: EvaluationHumanAnnotationsSchema.shape.reportedGapIds,
        })
        .strict(),
    ),
  })
  .strict();

export type EvaluationAnnotationFileV3 = z.infer<typeof EvaluationAnnotationFileV3Schema>;
