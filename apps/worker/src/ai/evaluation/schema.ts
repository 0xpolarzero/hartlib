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

const GoldenEvidenceSchema = z
  .object({
    sourceId: nonEmpty,
    selector: SelectorRoleSchema,
    kind: z.enum(["document", "chat_message", "memory", "web"]),
    content: nonBlankText,
    ranges: z.array(EvaluationRangeSchema),
  })
  .strict();

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

const ContinueResolutionLabelSchema = z
  .object({
    mode: z.literal("continue"),
    canonicalRetrievalQuestion: nonEmpty,
    requiredTermGroups: z.array(z.array(nonEmpty).min(1)).min(1),
  })
  .strict();

const ClarifyResolutionLabelSchema = z
  .object({
    mode: z.literal("clarify"),
    requiredQuestionTermGroups: z.array(z.array(nonEmpty).min(1)).min(1),
  })
  .strict();

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
    resolution: z.discriminatedUnion("mode", [
      ContinueResolutionLabelSchema,
      ClarifyResolutionLabelSchema,
    ]),
    retrievalSelectors: z.array(SelectorRoleSchema).superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: "custom", message: "retrieval selectors must be unique" });
      }
    }),
    requiredSourceIds: uniqueStrings,
    relevantSourceIds: uniqueStrings,
    acceptableOmissionSourceIds: uniqueStrings,
    acceptableRanges: z.record(nonEmpty, z.array(EvaluationRangeSchema).min(1)),
    fanoutSuitability: z.enum(["required", "allowed", "forbidden"]),
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

    const evidenceIds = fixture.evidence.map((source) => source.sourceId);
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      context.addIssue({ code: "custom", message: "evidence source ids must be unique" });
    }
    const evidenceSet = new Set(evidenceIds);
    for (const source of fixture.evidence) {
      const validRole =
        (source.selector === "A" &&
          (source.kind === "document" || source.kind === "chat_message")) ||
        (source.selector === "B" && source.kind === "memory") ||
        (source.selector === "W" && source.kind === "web");
      if (!validRole) {
        context.addIssue({
          code: "custom",
          message: `source ${source.sourceId} has an invalid selector/kind pairing`,
        });
      }
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
      fixture.labels.resolution.mode === "clarify" &&
      (fixture.labels.retrievalSelectors.length > 0 ||
        fixture.labels.requiredSourceIds.length > 0 ||
        fixture.labels.relevantSourceIds.length > 0 ||
        fixture.labels.fanoutSuitability !== "forbidden")
    ) {
      context.addIssue({
        code: "custom",
        message: "clarification stops before retrieval and planning",
      });
    }
  });

export type GoldenEvaluationCase = z.infer<typeof GoldenEvaluationCaseSchema>;

export const GoldenEvaluationSetSchema = z
  .object({
    version: z.literal(2),
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

export type GoldenEvaluationSet = z.infer<typeof GoldenEvaluationSetSchema>;

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
    artifactVersion: z.literal(2),
    goldenSetVersion: z.literal(2),
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
    sourceKey: z.string().regex(/^k_[A-Za-z0-9_-]{22}_[1-9][0-9]*$/u),
    kind: z.enum(["document", "chat_message", "memory", "web"]),
    purpose: nonEmpty,
    label: z.string().nullable(),
    ranges: z.array(EvaluationRangeSchema),
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

const ConversationResolverAttestationSchema = z
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
      resolverRequest: ConversationResolverAttestationSchema,
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
        .max(3),
      synthesis: ProductionTerminalLedgerSchema,
    })
    .strict(),
]);

export const SpecializedEvaluationResultSchema = CommonTurnResultSchema.extend({
  topology: z.literal("specialized"),
  conversationResolution: z.discriminatedUnion("mode", [
    z
      .object({
        mode: z.literal("continue"),
        retrievalQuestion: nonEmpty,
        selectedTurnIds: uniqueStrings,
      })
      .strict(),
    z.object({ mode: z.literal("clarify"), question: nonEmpty }).strict(),
  ]),
  executionPlan: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("single") }).strict(),
    z.object({ mode: z.literal("fanout"), topicCount: z.number().int().min(2).max(3) }).strict(),
  ]),
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
}).strict();

export type SpecializedEvaluationResult = z.infer<typeof SpecializedEvaluationResultSchema>;

export const GeneralPlannerEvaluationResultSchema = CommonTurnResultSchema.extend({
  topology: z.literal("general_planner"),
}).strict();

export type GeneralPlannerEvaluationResult = z.infer<typeof GeneralPlannerEvaluationResultSchema>;

export const SpecializedEvaluationResultsSchema = z.array(SpecializedEvaluationResultSchema);
export const GeneralPlannerEvaluationResultsSchema = z.array(GeneralPlannerEvaluationResultSchema);
