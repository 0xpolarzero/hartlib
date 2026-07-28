import { Schema } from "effect";

import { normalizeDomainAllowlist } from "./web-policy";

export type AiProviderServiceId =
  | "zai_coding_plan_official"
  | "deterministic_test"
  | "openai_compatible_custom";

/** Exact provider service and endpoint identity captured at acceptance. */
export type AiProviderEndpointIdentity = string;

export interface RunAcceptanceScope {
  readonly userId: string;
  readonly chatId: string;
  readonly companyId: string;
  readonly subscriptionIds: readonly string[];
  readonly accessIds: readonly string[];
  readonly publicSourceIds: readonly string[];
  readonly memoryMode: "private_owner" | "disabled";
  readonly memoryRevisionIds: readonly string[];
  readonly webRequested: boolean;
  readonly webEnabled: boolean;
  readonly provider: AiProviderServiceId;
  readonly providerEndpointIdentity: AiProviderEndpointIdentity;
  readonly fastModelId: "glm-5-turbo";
  readonly mainModelId: "glm-5-turbo";
  readonly webTransportProvider: "tinyfish" | null;
  readonly allowedDomains: readonly string[] | null;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const acceptanceScopeKeys = new Set([
  "userId",
  "chatId",
  "companyId",
  "subscriptionIds",
  "accessIds",
  "publicSourceIds",
  "memoryMode",
  "memoryRevisionIds",
  "webRequested",
  "webEnabled",
  "provider",
  "providerEndpointIdentity",
  "fastModelId",
  "mainModelId",
  "webTransportProvider",
  "allowedDomains",
]);

const canonicalStrings = (value: unknown, field: string): readonly string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`acceptance scope ${field} must be a non-empty string array`);
  }
  const values = [...(value as readonly string[])];
  const sorted = [...values].sort();
  if (
    new Set(values).size !== values.length ||
    values.some((item, index) => item !== sorted[index])
  ) {
    throw new Error(`acceptance scope ${field} must be sorted and unique`);
  }
  return values;
};

/** Decode the one strict acceptance snapshot shape used by API, worker, and fixtures. */
export const parseRunAcceptanceScope = (value: unknown): RunAcceptanceScope => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("acceptance scope must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !acceptanceScopeKeys.has(key)) ||
    acceptanceScopeKeys.size !== Object.keys(record).length
  ) {
    throw new Error("acceptance scope has unknown or missing keys");
  }
  if (typeof record.userId !== "string" || record.userId.trim() === "") {
    throw new Error("acceptance scope userId is invalid");
  }
  if (typeof record.chatId !== "string" || !uuidPattern.test(record.chatId)) {
    throw new Error("acceptance scope chatId is invalid");
  }
  if (typeof record.companyId !== "string" || !uuidPattern.test(record.companyId)) {
    throw new Error("acceptance scope companyId is invalid");
  }
  const subscriptionIds = canonicalStrings(record.subscriptionIds, "subscriptionIds");
  if (subscriptionIds.some((item) => !uuidPattern.test(item))) {
    throw new Error("acceptance scope subscriptionIds are invalid");
  }
  const accessIds = canonicalStrings(record.accessIds, "accessIds");
  if (accessIds.some((item) => !uuidPattern.test(item))) {
    throw new Error("acceptance scope accessIds are invalid");
  }
  const publicSourceIds = canonicalStrings(record.publicSourceIds, "publicSourceIds");
  const memoryRevisionIds = canonicalStrings(record.memoryRevisionIds, "memoryRevisionIds");
  if (memoryRevisionIds.some((item) => !uuidPattern.test(item))) {
    throw new Error("acceptance scope memoryRevisionIds are invalid");
  }
  if (record.memoryMode !== "private_owner" && record.memoryMode !== "disabled") {
    throw new Error("acceptance scope memoryMode is invalid");
  }
  if (record.memoryMode === "disabled" && memoryRevisionIds.length > 0) {
    throw new Error("disabled memory cannot carry revisions");
  }
  if (typeof record.webRequested !== "boolean" || typeof record.webEnabled !== "boolean") {
    throw new Error("acceptance scope web state is invalid");
  }
  if (!record.webRequested && record.webEnabled) {
    throw new Error("web cannot be enabled when it was not requested");
  }
  if (
    record.provider !== "zai_coding_plan_official" &&
    record.provider !== "deterministic_test" &&
    record.provider !== "openai_compatible_custom"
  ) {
    throw new Error("acceptance scope provider is invalid");
  }
  if (
    typeof record.providerEndpointIdentity !== "string" ||
    record.providerEndpointIdentity.length === 0 ||
    !record.providerEndpointIdentity.startsWith(`${record.provider}:`)
  ) {
    throw new Error("acceptance scope provider endpoint identity is invalid");
  }
  if (record.fastModelId !== "glm-5-turbo" || record.mainModelId !== "glm-5-turbo") {
    throw new Error("acceptance scope model is invalid");
  }
  const webTransportProvider = record.webTransportProvider;
  const allowedDomains = record.allowedDomains;
  if (record.webEnabled && webTransportProvider !== "tinyfish") {
    throw new Error("enabled web scope requires tinyfish");
  }
  if (!record.webEnabled && webTransportProvider !== null) {
    throw new Error("disabled web scope cannot carry a transport provider");
  }
  if (allowedDomains !== null && !Array.isArray(allowedDomains)) {
    throw new Error("acceptance scope allowedDomains is invalid");
  }
  if (
    allowedDomains !== null &&
    (allowedDomains as readonly unknown[]).some(
      (domain) => typeof domain !== "string" || domain === "",
    )
  ) {
    throw new Error("acceptance scope allowedDomains is invalid");
  }
  if (!record.webEnabled && allowedDomains !== null) {
    throw new Error("disabled web scope cannot carry domains");
  }
  if (allowedDomains !== null) {
    const normalized = normalizeDomainAllowlist(allowedDomains as readonly string[]);
    if (!normalized.ok || JSON.stringify(normalized.domains) !== JSON.stringify(allowedDomains)) {
      throw new Error("acceptance scope allowedDomains must be canonical");
    }
  }
  return {
    userId: record.userId,
    chatId: record.chatId,
    companyId: record.companyId,
    subscriptionIds,
    accessIds,
    publicSourceIds,
    memoryMode: record.memoryMode,
    memoryRevisionIds,
    webRequested: record.webRequested,
    webEnabled: record.webEnabled,
    provider: record.provider,
    providerEndpointIdentity: record.providerEndpointIdentity as AiProviderEndpointIdentity,
    fastModelId: record.fastModelId,
    mainModelId: record.mainModelId,
    webTransportProvider,
    allowedDomains,
  } as RunAcceptanceScope;
};

export const makeRunAcceptanceScope = (args: {
  readonly userId: string;
  readonly chatId: string;
  readonly companyId: string;
  readonly subscriptionIds?: readonly string[];
  readonly accessIds?: readonly string[];
  readonly publicSourceIds?: readonly string[];
  readonly memoryMode?: "private_owner" | "disabled";
  readonly memoryRevisionIds?: readonly string[];
  readonly webRequested?: boolean;
  readonly webEnabled?: boolean;
  readonly provider?: AiProviderServiceId;
  readonly providerEndpointIdentity?: AiProviderEndpointIdentity;
  readonly webTransportProvider?: "tinyfish" | null;
  readonly allowedDomains?: readonly string[] | null;
}): RunAcceptanceScope => {
  const webRequested = args.webRequested ?? false;
  const webEnabled = args.webEnabled ?? false;
  const provider = args.provider ?? "zai_coding_plan_official";
  const providerEndpointIdentity =
    args.providerEndpointIdentity ??
    (provider === "zai_coding_plan_official"
      ? "zai_coding_plan_official:https://api.z.ai/api/coding/paas/v4"
      : provider === "deterministic_test"
        ? "deterministic_test:deterministic"
        : (() => {
            throw new Error(
              "custom provider acceptance scopes must include the exact endpoint identity",
            );
          })());
  return parseRunAcceptanceScope({
    userId: args.userId,
    chatId: args.chatId,
    companyId: args.companyId,
    subscriptionIds: [...(args.subscriptionIds ?? [])].sort(),
    accessIds: [...(args.accessIds ?? [])].sort(),
    publicSourceIds: [...(args.publicSourceIds ?? [])].sort(),
    memoryMode: args.memoryMode ?? "private_owner",
    memoryRevisionIds: [...(args.memoryRevisionIds ?? [])].sort(),
    webRequested,
    webEnabled,
    provider,
    providerEndpointIdentity,
    fastModelId: "glm-5-turbo",
    mainModelId: "glm-5-turbo",
    webTransportProvider: webEnabled ? (args.webTransportProvider ?? "tinyfish") : null,
    allowedDomains: webEnabled ? (args.allowedDomains ?? null) : null,
  });
};

export const AI_WEB_MAX_DOMAIN_FILTERS_DEFAULT = 8;
export const AI_WEB_MAX_DOMAIN_FILTERS_HARD_MAX = 32;

export const ChatLocale = Schema.Literals(["fr-FR", "en-US"]);
export type ChatLocale = Schema.Schema.Type<typeof ChatLocale>;

export const ChatMarket = Schema.Literals(["FR", "US"]);
export type ChatMarket = Schema.Schema.Type<typeof ChatMarket>;

export const WebPolicyDisabledReason = Schema.Literals([
  "deployment_unavailable",
  "company_disabled",
  "allowlist_unsupported",
]);
export type WebPolicyDisabledReason = Schema.Schema.Type<typeof WebPolicyDisabledReason>;

export const EffectiveWebPolicy = Schema.Union([
  Schema.Struct({
    enabled: Schema.Literal(false),
    reason: WebPolicyDisabledReason,
    allowlistActive: Schema.Boolean,
  }),
  Schema.Struct({
    enabled: Schema.Literal(true),
    provider: Schema.Literal("tinyfish"),
    allowedDomains: Schema.NullOr(Schema.Array(Schema.String)),
  }),
]);
export type EffectiveWebPolicy = Schema.Schema.Type<typeof EffectiveWebPolicy>;

export const SourceRange = Schema.Struct({
  pageNumber: Schema.optional(Schema.Number),
  charStart: Schema.Number,
  charEnd: Schema.Number,
});
export type SourceRange = Schema.Schema.Type<typeof SourceRange>;

const CitationBase = {
  sourceKey: Schema.String,
  label: Schema.NullOr(Schema.String),
} as const;

const SourceBase = {
  ...CitationBase,
  tokenCount: Schema.Number,
  topicIds: Schema.Array(Schema.Literals(["t1", "t2", "t3"])),
} as const;

const DocumentLocator = {
  kind: Schema.Literal("document"),
  sourceName: Schema.optional(Schema.String),
  issueTitle: Schema.optional(Schema.String),
  documentTitle: Schema.String,
  url: Schema.String,
  publishedAt: Schema.optional(Schema.String),
  ranges: Schema.Array(SourceRange),
} as const;

const ChatMessageLocator = {
  kind: Schema.Literal("chat_message"),
  messageId: Schema.String,
  ranges: Schema.Tuple([]),
} as const;

const MemoryLocator = {
  kind: Schema.Literal("memory"),
  memoryId: Schema.String,
  memoryRevisionId: Schema.String,
  ranges: Schema.Tuple([]),
} as const;

const WebLocator = {
  kind: Schema.Literal("web"),
  title: Schema.String,
  domain: Schema.String,
  url: Schema.String,
  publishedAt: Schema.optional(Schema.String),
  capturedAt: Schema.String,
  quote: Schema.String,
  ranges: Schema.Tuple([]),
} as const;

export const PublicCitationRecord = Schema.Union([
  Schema.Struct({ ...CitationBase, ...DocumentLocator }),
  Schema.Struct({ ...CitationBase, ...ChatMessageLocator }),
  Schema.Struct({ ...CitationBase, ...MemoryLocator }),
  Schema.Struct({ ...CitationBase, ...WebLocator }),
]);
export type PublicCitationRecord = Schema.Schema.Type<typeof PublicCitationRecord>;

export const PublicSourceRecord = Schema.Union([
  Schema.Struct({ ...SourceBase, ...DocumentLocator }),
  Schema.Struct({ ...SourceBase, ...ChatMessageLocator }),
  Schema.Struct({ ...SourceBase, ...MemoryLocator }),
  Schema.Struct({ ...SourceBase, ...WebLocator }),
]);
export type PublicSourceRecord = Schema.Schema.Type<typeof PublicSourceRecord>;

export const AiRunDescriptor = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["queued", "running"]),
  streamPath: Schema.String,
});
export type AiRunDescriptor = Schema.Schema.Type<typeof AiRunDescriptor>;

export const UserMessageRunOutcome = Schema.Union([
  Schema.Struct({ id: Schema.String, status: Schema.Literal("queued") }),
  Schema.Struct({ id: Schema.String, status: Schema.Literal("running") }),
  Schema.Struct({
    id: Schema.String,
    status: Schema.Literal("succeeded"),
    finishedAt: Schema.String,
  }),
  Schema.Struct({
    id: Schema.String,
    status: Schema.Literal("failed"),
    errorCode: Schema.String,
    retryable: Schema.Boolean,
    failedAt: Schema.String,
  }),
]);
export type UserMessageRunOutcome = Schema.Schema.Type<typeof UserMessageRunOutcome>;

export const UserChatMessage = Schema.Struct({
  id: Schema.String,
  author: Schema.Literal("user"),
  content: Schema.String,
  createdAt: Schema.String,
  run: UserMessageRunOutcome,
});
export type UserChatMessage = Schema.Schema.Type<typeof UserChatMessage>;

export const AssistantChatMessage = Schema.Struct({
  id: Schema.String,
  author: Schema.Literal("assistant"),
  content: Schema.String,
  createdAt: Schema.String,
  citations: Schema.Array(PublicCitationRecord),
  sourcesRead: Schema.Array(PublicSourceRecord),
});
export type AssistantChatMessage = Schema.Schema.Type<typeof AssistantChatMessage>;

export const ChatMessage = Schema.Union([UserChatMessage, AssistantChatMessage]);
export type ChatMessage = Schema.Schema.Type<typeof ChatMessage>;

export const GetChatResponse = Schema.Struct({
  chat: Schema.Struct({
    id: Schema.String,
    memoryMode: Schema.Literals(["private_owner", "disabled"]),
    createdAt: Schema.String,
    updatedAt: Schema.String,
  }),
  messages: Schema.Array(ChatMessage),
  effectiveWebPolicy: EffectiveWebPolicy,
  activeRun: Schema.NullOr(AiRunDescriptor),
  canWrite: Schema.Boolean,
});
export type GetChatResponse = Schema.Schema.Type<typeof GetChatResponse>;

export const SendChatMessageRequest = Schema.Struct({
  text: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter<string>((value) =>
        value.trim().length > 0 ? undefined : "text must contain a non-whitespace character",
      ),
    ),
  ),
  locale: ChatLocale,
  market: ChatMarket,
  webSearchEnabled: Schema.Boolean,
});
export type SendChatMessageRequest = Schema.Schema.Type<typeof SendChatMessageRequest>;

export const SendChatMessageAccepted = Schema.Struct({
  message: Schema.Struct({
    id: Schema.String,
    author: Schema.Literal("user"),
    content: Schema.String,
    createdAt: Schema.String,
  }),
  run: Schema.Struct({
    id: Schema.String,
    status: Schema.Literal("queued"),
    streamPath: Schema.String,
  }),
});
export type SendChatMessageAccepted = Schema.Schema.Type<typeof SendChatMessageAccepted>;

export const ActiveAiRunConflict = Schema.Struct({
  code: Schema.Literal("active_ai_run"),
  conflictScope: Schema.Literals(["chat", "user"]),
  activeRun: AiRunDescriptor,
});
export type ActiveAiRunConflict = Schema.Schema.Type<typeof ActiveAiRunConflict>;

export const MemoryKind = Schema.Literals([
  "profile",
  "preference",
  "instruction",
  "fact",
  "episode",
]);
export type MemoryKind = Schema.Schema.Type<typeof MemoryKind>;

export const MemorySnapshot = Schema.Struct({
  kind: MemoryKind,
  content: Schema.String,
  deleted: Schema.Boolean,
});
export type MemorySnapshot = Schema.Schema.Type<typeof MemorySnapshot>;

export const MemoryRevision = Schema.Struct({
  id: Schema.String,
  action: Schema.Literals(["create", "update", "delete", "revert"]),
  before: Schema.NullOr(MemorySnapshot),
  after: MemorySnapshot,
  createdAt: Schema.String,
});
export type MemoryRevision = Schema.Schema.Type<typeof MemoryRevision>;

export const MemoryRecord = Schema.Struct({
  id: Schema.String,
  headRevisionId: Schema.String,
  current: MemorySnapshot,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  revisions: Schema.Array(MemoryRevision),
});
export type MemoryRecord = Schema.Schema.Type<typeof MemoryRecord>;

export const ListMemoriesResponse = Schema.Struct({ memories: Schema.Array(MemoryRecord) });
export type ListMemoriesResponse = Schema.Schema.Type<typeof ListMemoriesResponse>;

export const RevertMemoryRequest = Schema.Struct({ revisionId: Schema.String });
export type RevertMemoryRequest = Schema.Schema.Type<typeof RevertMemoryRequest>;

export const MemoryRevisionResponse = Schema.Struct({
  memoryId: Schema.String,
  revision: MemoryRevision,
});
export type MemoryRevisionResponse = Schema.Schema.Type<typeof MemoryRevisionResponse>;

export const CreateProductChatRequest = Schema.Struct({
  companyId: Schema.String,
  memoryMode: Schema.Literals(["private_owner", "disabled"]),
  sourceAccessIds: Schema.optional(Schema.Array(Schema.String)),
}).pipe(
  Schema.check(
    Schema.makeFilter<{
      readonly companyId: string;
      readonly memoryMode: "private_owner" | "disabled";
      readonly sourceAccessIds?: ReadonlyArray<string> | undefined;
    }>((value) => {
      const ids = value.sourceAccessIds;
      return ids === undefined || new Set(ids).size === ids.length
        ? undefined
        : "sourceAccessIds must be unique";
    }),
  ),
);
export type CreateProductChatRequest = Schema.Schema.Type<typeof CreateProductChatRequest>;

export const ProductChatSummary = Schema.Struct({
  id: Schema.String,
  companyId: Schema.String,
  creatorUserId: Schema.String,
  memoryMode: Schema.Literals(["private_owner", "disabled"]),
  sharedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  sourceCount: Schema.Number,
});
export type ProductChatSummary = Schema.Schema.Type<typeof ProductChatSummary>;

export const ProductChatListResponse = Schema.Struct({
  chats: Schema.Array(ProductChatSummary),
});
export const CreateProductChatResponse = Schema.Struct({
  chat: Schema.Struct({
    id: Schema.String,
    memoryMode: Schema.Literals(["private_owner", "disabled"]),
    sourceAccessIds: Schema.Array(Schema.String),
    createdAt: Schema.String,
  }),
});

export const RequestModelUsage = Schema.Struct({
  scope: Schema.Literal("request"),
  kind: Schema.Literal("model"),
  role: Schema.String,
  attempt: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cachedTokens: Schema.Number,
  reasoningTokens: Schema.Number,
  totalTokens: Schema.Number,
});

export const RequestWebUsage = Schema.Struct({
  scope: Schema.Literal("request"),
  kind: Schema.Literals(["web_search", "web_fetch"]),
  attempt: Schema.Number,
  status: Schema.Literals(["ok", "empty", "failed"]),
  resultCount: Schema.Number,
  responseBytes: Schema.Number,
  billedUnits: Schema.NullOr(Schema.Number),
  durationMs: Schema.Number,
});

export const RunUsage = Schema.Struct({
  scope: Schema.Literal("run"),
  model: Schema.Struct({
    inputTokens: Schema.Number,
    outputTokens: Schema.Number,
    cachedTokens: Schema.Number,
    reasoningTokens: Schema.Number,
    totalTokens: Schema.Number,
    requestCount: Schema.Number,
  }),
  web: Schema.Struct({
    searchCount: Schema.Number,
    fetchCount: Schema.Number,
    responseBytes: Schema.Number,
    billedUnits: Schema.NullOr(Schema.Number),
  }),
});

export const UsageEventPayload = Schema.Union([RequestModelUsage, RequestWebUsage, RunUsage]);
export type UsageEventPayload = Schema.Schema.Type<typeof UsageEventPayload>;

export const PublicContextConsumer = Schema.Struct({
  consumer: Schema.Literals(["direct", "topic", "synthesis"]),
  topicId: Schema.optional(Schema.Literals(["t1", "t2", "t3"])),
  inputTokens: Schema.Number,
  requestedOutputTokens: Schema.Number,
  usableInputTokens: Schema.Number,
});
export type PublicContextConsumer = Schema.Schema.Type<typeof PublicContextConsumer>;

export const AiRunActivityStage = Schema.Literals([
  "understanding",
  "evidence",
  "preparing",
  "writing",
  "finishing",
]);
export type AiRunActivityStage = Schema.Schema.Type<typeof AiRunActivityStage>;

export const AiRunActivityCode = Schema.Literals([
  "request_understanding",
  "internal_sources",
  "saved_context",
  "web_research",
  "context_preparation",
  "answer_generation",
  "finalization",
]);
export type AiRunActivityCode = Schema.Schema.Type<typeof AiRunActivityCode>;

export const AiRunActivityStatus = Schema.Literals([
  "waiting",
  "running",
  "complete",
  "retrying",
  "failed",
  "skipped",
]);
export type AiRunActivityStatus = Schema.Schema.Type<typeof AiRunActivityStatus>;

export const AiRunActivityEvent = Schema.Struct({
  type: Schema.Literal("activity"),
  stage: AiRunActivityStage,
  code: AiRunActivityCode,
  status: AiRunActivityStatus,
  topicId: Schema.optional(Schema.Literals(["t1", "t2", "t3"])),
  attempt: Schema.optional(Schema.Number),
  durationMs: Schema.optional(Schema.Number),
  sourceCount: Schema.optional(Schema.Number),
  resultCount: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.Literals(["search_adjusted", "source_validation_failed"])),
});
export type AiRunActivityEvent = Schema.Schema.Type<typeof AiRunActivityEvent>;

export const aiRunActivityKey = (code: AiRunActivityCode, topicId?: "t1" | "t2" | "t3"): string =>
  `${code}${topicId === undefined ? "" : `:${topicId}`}`;

export const AiRunActivityFailureCode = Schema.Literals([
  "plan_turn_failed",
  "internal_retrieval_failed",
  "memory_selector_failed",
  "web_research_failed",
  "context_assembly_failed",
  "context_reducer_failed",
  "answer_failed",
  "topic_answer_failed",
  "synthesis_failed",
  "memory_extraction_failed",
  "finalization_failed",
  "workflow_resume_incompatible",
]);
export type AiRunActivityFailureCode = Schema.Schema.Type<typeof AiRunActivityFailureCode>;

export const activityCodeForAiRunError = (code: string): AiRunActivityCode => {
  switch (code) {
    case "plan_turn_failed":
      return "request_understanding";
    case "internal_retrieval_failed":
      return "internal_sources";
    case "memory_selector_failed":
    case "memory_extraction_failed":
      return "saved_context";
    case "web_research_failed":
      return "web_research";
    case "context_assembly_failed":
    case "context_reducer_failed":
      return "context_preparation";
    case "answer_failed":
    case "topic_answer_failed":
    case "synthesis_failed":
      return "answer_generation";
    case "finalization_failed":
    case "workflow_resume_incompatible":
    default:
      return "finalization";
  }
};

export const activityStageForCode = (code: AiRunActivityCode): AiRunActivityStage => {
  switch (code) {
    case "request_understanding":
      return "understanding";
    case "internal_sources":
    case "saved_context":
    case "web_research":
      return "evidence";
    case "context_preparation":
      return "preparing";
    case "answer_generation":
      return "writing";
    case "finalization":
      return "finishing";
  }
};

export const activityCodeForPhase = (phase: string): AiRunActivityCode | undefined => {
  switch (phase) {
    case "load_turn":
    case "plan_turn":
      return "request_understanding";
    case "internal_retrieval":
      return "internal_sources";
    case "memory_selection":
    case "memory_extraction":
      return "saved_context";
    case "web_retrieval":
    case "web_search_call":
    case "web_fetch_call":
      return "web_research";
    case "context_assembly":
    case "context_measurement_exact_gate":
    case "context_freeze_gate":
    case "fanout_source_merge":
    case "context_reduction_plan":
    case "context_reduction_measure":
    case "fanout_allocation_exact_gate":
    case "synthesis_assembly_exact_gate":
      return "context_preparation";
    case "direct_answer_call":
    case "topic_answer_call":
    case "synthesis_call":
    case "answer_stream":
    case "clarification":
      return "answer_generation";
    case "finalization":
      return "finalization";
    default:
      return undefined;
  }
};

export const activityStageForPhase = (phase: string): AiRunActivityStage | undefined => {
  const code = activityCodeForPhase(phase);
  return code === undefined ? undefined : activityStageForCode(code);
};

export const activityCodeForFailure = (code: string): AiRunActivityCode =>
  activityCodeForAiRunError(code);

export const activityFailureReasonForAiRunError = (
  code: string,
): "source_validation_failed" | undefined =>
  code.includes("source") || code.includes("context") ? "source_validation_failed" : undefined;

export const AiRunEvent = Schema.Union([
  AiRunActivityEvent,
  Schema.Struct({ type: Schema.Literal("run_started") }),
  Schema.Struct({
    type: Schema.Literal("context_ready"),
    mode: Schema.Literals(["clarification", "single", "synthesis"]),
    reductionRan: Schema.Boolean,
    sourcesRead: Schema.Array(PublicSourceRecord),
    consumers: Schema.Array(PublicContextConsumer),
  }),
  Schema.Struct({
    type: Schema.Literal("answer_started"),
    mode: Schema.Literals(["clarification", "single", "synthesis"]),
    attempt: Schema.Number,
  }),
  Schema.Struct({ type: Schema.Literal("text_delta"), delta: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("memory_updated"),
    created: Schema.Number,
    updated: Schema.Number,
    discarded: Schema.Number,
  }),
  Schema.Struct({ type: Schema.Literal("usage"), ...RequestModelUsage.fields }),
  Schema.Struct({ type: Schema.Literal("usage"), ...RequestWebUsage.fields }),
  Schema.Struct({ type: Schema.Literal("usage"), ...RunUsage.fields }),
  Schema.Struct({ type: Schema.Literal("done"), assistantMessageId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("error"),
    code: Schema.String,
    retryable: Schema.Boolean,
  }),
]);
export type AiRunEvent = Schema.Schema.Type<typeof AiRunEvent>;
