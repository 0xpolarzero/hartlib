import { Schema } from "effect";
import * as SchemaGetter from "effect/SchemaGetter";

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

const CitationQuoteText = Schema.String.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.check(Schema.isMaxLength(2_000)),
);

/** Exact server-authorized supporting text. A null value is deliberately
 * content-free and covers every unavailable or unauthorized case. */
export const PublicCitationQuote = Schema.NullOr(
  Schema.Struct({
    text: CitationQuoteText,
  }),
);
export type PublicCitationQuote = Schema.Schema.Type<typeof PublicCitationQuote>;

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

const WebLocatorBase = {
  kind: Schema.Literal("web"),
  title: Schema.String,
  domain: Schema.String,
  url: Schema.String,
  publishedAt: Schema.optional(Schema.String),
  capturedAt: Schema.String,
  ranges: Schema.Tuple([]),
} as const;

const WebSourceLocator = {
  ...WebLocatorBase,
  quote: Schema.String,
} as const;

const CanonicalCitationRecord = Schema.Union([
  Schema.Struct({ ...CitationBase, ...DocumentLocator, quote: PublicCitationQuote }),
  Schema.Struct({ ...CitationBase, ...ChatMessageLocator, quote: PublicCitationQuote }),
  Schema.Struct({ ...CitationBase, ...MemoryLocator, quote: PublicCitationQuote }),
  Schema.Struct({ ...CitationBase, ...WebLocatorBase, quote: PublicCitationQuote }),
]);

const LegacyCitationRecord = Schema.Union([
  Schema.Struct({
    ...CitationBase,
    ...DocumentLocator,
    quote: Schema.optional(PublicCitationQuote),
  }),
  Schema.Struct({
    ...CitationBase,
    ...ChatMessageLocator,
    quote: Schema.optional(PublicCitationQuote),
  }),
  Schema.Struct({
    ...CitationBase,
    ...MemoryLocator,
    quote: Schema.optional(PublicCitationQuote),
  }),
  // Web citations used a required string quote before the canonical citation
  // projection. The compatibility decoder also accepts an omitted or null
  // value so old mixed-version responses normalize to the one null state.
  Schema.Struct({
    ...CitationBase,
    ...WebLocatorBase,
    quote: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, PublicCitationQuote]))),
  }),
]);

type CanonicalCitationRecord = Schema.Schema.Type<typeof CanonicalCitationRecord>;
type LegacyCitationRecord = Schema.Schema.Type<typeof LegacyCitationRecord>;

const normalizeLegacyCitationRecord = (value: LegacyCitationRecord): CanonicalCitationRecord => {
  const quote = value.quote;
  const normalizedQuote =
    quote === undefined || quote === null
      ? null
      : typeof quote === "string"
        ? Schema.decodeUnknownSync(PublicCitationQuote)({ text: quote })
        : quote;
  return { ...value, quote: normalizedQuote } as CanonicalCitationRecord;
};

/**
 * Decode the old omitted/non-object quote fields at the wire boundary. The
 * decoded value is always the required canonical `{ text } | null` shape;
 * encoding a canonical value keeps that shape and never emits a legacy string.
 */
export const PublicCitationRecord = LegacyCitationRecord.pipe(
  Schema.decodeTo(CanonicalCitationRecord, {
    decode: SchemaGetter.transform(normalizeLegacyCitationRecord),
    encode: SchemaGetter.transform((value: CanonicalCitationRecord) => value),
  }),
);
export type PublicCitationRecord = Schema.Schema.Type<typeof PublicCitationRecord>;

export const PublicSourceRecord = Schema.Union([
  Schema.Struct({ ...SourceBase, ...DocumentLocator }),
  Schema.Struct({ ...SourceBase, ...ChatMessageLocator }),
  Schema.Struct({ ...SourceBase, ...MemoryLocator }),
  Schema.Struct({ ...SourceBase, ...WebSourceLocator }),
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
  /** Run identity is used only to request the owner-authorized debug projection. */
  runId: Schema.optional(Schema.String),
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
    archivedAt: Schema.NullOr(Schema.String),
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
  archivedAt: Schema.NullOr(Schema.String),
  replacedByChatId: Schema.NullOr(Schema.String),
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

const chatIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Lowercase canonical UUID used for chat and replacement identities. */
export const ChatIdUuid = Schema.String.pipe(
  Schema.check(Schema.isPattern(chatIdPattern)),
  Schema.check(Schema.isLowercased()),
);
export type ChatIdUuid = Schema.Schema.Type<typeof ChatIdUuid>;

/**
 * The client generates the replacement UUID before the request. It is both the
 * optimistic identity shown while the reset is pending and the replay key: a
 * retry with the same old id and replacement id returns the same committed row.
 */
export const ResetProductChatRequest = Schema.Struct({
  replacementChatId: ChatIdUuid,
});
export type ResetProductChatRequest = Schema.Schema.Type<typeof ResetProductChatRequest>;

/**
 * The replacement projection is complete so the client never needs a follow-up
 * read. It starts empty and writable with the copied company, memory mode, and
 * source set; the archived predecessor id is returned for lineage.
 */
export const ResetProductChatResponse = Schema.Struct({
  archivedChatId: Schema.String,
  replacement: GetChatResponse.pipe(
    Schema.check(
      Schema.makeFilter<GetChatResponse>((value) =>
        value.chat.archivedAt === null &&
        value.messages.length === 0 &&
        value.activeRun === null &&
        value.canWrite
          ? undefined
          : "reset replacement must be empty, active, and writable",
      ),
    ),
  ),
});
export type ResetProductChatResponse = Schema.Schema.Type<typeof ResetProductChatResponse>;

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

/** Content-free categories used to explain a failed AI attempt. */
export const AiRunActivityErrorCategory = Schema.Literals([
  "provider_transport",
  "provider_response",
  "provider_output",
  "context_budget",
  "validation",
  "authorization",
  "storage",
  "workflow",
  "unknown",
]);
export type AiRunActivityErrorCategory = Schema.Schema.Type<typeof AiRunActivityErrorCategory>;

const SafeRunIdentity = Schema.String.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.check(Schema.isMaxLength(128)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/u)),
);
const SafeActivityTimestamp = Schema.String.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.check(Schema.isMaxLength(64)),
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u)),
);
const SafeActivityCode = Schema.String.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.check(Schema.isMaxLength(96)),
  Schema.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,95}$/u)),
);
const SafeActivityAttempt = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.check(Schema.isLessThanOrEqualTo(100_000)),
);
const SafeActivityMessage = Schema.String.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.check(Schema.isMaxLength(512)),
);
const SafeDebugCount = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.check(Schema.isLessThanOrEqualTo(1_000_000_000)),
);

const publicDebugStageOrder = [
  "understanding",
  "evidence",
  "preparing",
  "writing",
  "finishing",
] as const;

export const AiRunActivityEvent = Schema.Struct({
  type: Schema.Literal("activity"),
  stage: AiRunActivityStage,
  code: AiRunActivityCode,
  status: AiRunActivityStatus,
  topicId: Schema.optional(Schema.Literals(["t1", "t2", "t3"])),
  attempt: Schema.optional(SafeActivityAttempt),
  durationMs: Schema.optional(Schema.Number),
  sourceCount: Schema.optional(Schema.Number),
  resultCount: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.Literals(["search_adjusted", "source_validation_failed"])),
  /** Stable run identity; optional for backwards-compatible replay of old rows. */
  runId: Schema.optional(SafeRunIdentity),
  /** RFC 3339 time at which the worker emitted this transition. */
  occurredAt: Schema.optional(SafeActivityTimestamp),
  /** Normalized terminal code, present on retrying/failed transitions. */
  errorCode: Schema.optional(SafeActivityCode),
  errorCategory: Schema.optional(AiRunActivityErrorCategory),
  /** Bounded, content-free explanation. Never a provider body or stack trace. */
  errorMessage: Schema.optional(SafeActivityMessage),
});
export type AiRunActivityEvent = Schema.Schema.Type<typeof AiRunActivityEvent>;

const PublicAiRunDebugEventStatus = Schema.Union([
  AiRunActivityStatus,
  Schema.Literals(["terminal", "done"]),
]);

/** Content-free chronological event projection for the owner debug view. */
export const PublicAiRunDebugEvent = Schema.Struct({
  stage: Schema.Union([AiRunActivityStage, Schema.Literal("terminal")]),
  topicId: Schema.NullOr(Schema.Literals(["t1", "t2", "t3"])),
  code: SafeActivityCode,
  status: PublicAiRunDebugEventStatus,
  occurredAt: Schema.NullOr(SafeActivityTimestamp),
  attempt: Schema.NullOr(SafeActivityAttempt),
  durationMs: Schema.NullOr(SafeDebugCount),
  sourceCount: Schema.NullOr(SafeDebugCount),
  resultCount: Schema.NullOr(SafeDebugCount),
  errorCode: Schema.NullOr(SafeActivityCode),
  errorCategory: Schema.NullOr(AiRunActivityErrorCategory),
});
export type PublicAiRunDebugEvent = Schema.Schema.Type<typeof PublicAiRunDebugEvent>;

const PublicAiRunDebugStage = Schema.Struct({
  stage: AiRunActivityStage,
  status: AiRunActivityStatus,
  attempt: Schema.NullOr(SafeActivityAttempt),
  durationMs: Schema.NullOr(SafeDebugCount),
  sourceCount: Schema.NullOr(SafeDebugCount),
  resultCount: Schema.NullOr(SafeDebugCount),
  errorCode: Schema.NullOr(SafeActivityCode),
  errorCategory: Schema.NullOr(AiRunActivityErrorCategory),
});

const PublicAiRunDebugStages = Schema.Array(PublicAiRunDebugStage).pipe(
  Schema.check(
    Schema.makeFilter<readonly Schema.Schema.Type<typeof PublicAiRunDebugStage>[]>((stages) =>
      stages.length === publicDebugStageOrder.length &&
      stages.every((stage, index) => stage.stage === publicDebugStageOrder[index])
        ? undefined
        : "debug stages must contain the five ordered stage entries",
    ),
  ),
);

const PublicAiRunDebugHistory = Schema.Array(PublicAiRunDebugEvent).pipe(
  Schema.check(
    Schema.makeFilter<readonly Schema.Schema.Type<typeof PublicAiRunDebugEvent>[]>((history) =>
      history.length <= 200 ? undefined : "debug history exceeds the 200-row limit",
    ),
  ),
);

export const PublicAiRunDebug = Schema.Struct({
  runId: SafeRunIdentity,
  status: Schema.Literals(["queued", "running", "succeeded", "failed"]),
  startedAt: Schema.NullOr(SafeActivityTimestamp),
  finishedAt: Schema.NullOr(SafeActivityTimestamp),
  failedAt: Schema.NullOr(SafeActivityTimestamp),
  lastSequence: Schema.NullOr(SafeDebugCount),
  stages: PublicAiRunDebugStages,
  history: PublicAiRunDebugHistory,
  sourceSummary: Schema.Struct({
    read: SafeDebugCount,
    cited: SafeDebugCount,
    uncited: SafeDebugCount,
  }),
  context: Schema.Struct({
    compactionRan: Schema.NullOr(Schema.Boolean),
    consumers: SafeDebugCount,
    inputTokens: Schema.NullOr(SafeDebugCount),
    usableInputTokens: Schema.NullOr(SafeDebugCount),
  }),
  memory: Schema.NullOr(
    Schema.Struct({
      created: SafeDebugCount,
      updated: SafeDebugCount,
      discarded: SafeDebugCount,
    }),
  ),
  usage: Schema.NullOr(
    Schema.Struct({
      modelInputTokens: SafeDebugCount,
      modelOutputTokens: SafeDebugCount,
      webSearches: SafeDebugCount,
      webFetches: SafeDebugCount,
      webResponseBytes: SafeDebugCount,
    }),
  ),
  terminalError: Schema.NullOr(
    Schema.Struct({
      code: SafeActivityCode,
      retryable: Schema.Boolean,
      category: Schema.NullOr(AiRunActivityErrorCategory),
      message: Schema.NullOr(SafeActivityMessage),
    }),
  ),
});
export type PublicAiRunDebug = Schema.Schema.Type<typeof PublicAiRunDebug>;

export const PublicAiRunDebugResponse = Schema.Union([
  Schema.Struct({ available: Schema.Literal(true), debug: PublicAiRunDebug }),
  Schema.Struct({ available: Schema.Literal(false) }),
]);
export type PublicAiRunDebugResponse = Schema.Schema.Type<typeof PublicAiRunDebugResponse>;

export const aiRunActivityKey = (code: AiRunActivityCode, topicId?: "t1" | "t2" | "t3"): string =>
  `${code}${topicId === undefined ? "" : `:${topicId}`}`;

/** The browser keeps one current item for the compact rail and a unique
 * transition history for the opt-in diagnostics view. */
export interface AiRunActivityProjection {
  readonly activities: readonly AiRunActivityEvent[];
  readonly history: readonly AiRunActivityEvent[];
}

export const emptyAiRunActivityProjection = (): AiRunActivityProjection => ({
  activities: [],
  history: [],
});

export const aiRunActivityTransitionKey = (event: AiRunActivityEvent): string =>
  [
    aiRunActivityKey(event.code, event.topicId),
    event.stage,
    event.status,
    event.attempt ?? "",
    event.durationMs ?? "",
    event.sourceCount ?? "",
    event.resultCount ?? "",
    event.reason ?? "",
    event.runId ?? "",
    event.occurredAt ?? "",
    event.errorCode ?? "",
    event.errorCategory ?? "",
    event.errorMessage ?? "",
  ].join("|");

/** Apply one ordered SSE activity transition without duplicating replayed data. */
export const projectAiRunActivity = (
  projection: AiRunActivityProjection,
  event: AiRunActivityEvent,
): AiRunActivityProjection => {
  const key = aiRunActivityKey(event.code, event.topicId);
  const activities = [...projection.activities];
  const index = activities.findIndex(
    (activity) => aiRunActivityKey(activity.code, activity.topicId) === key,
  );
  if (index === -1) activities.push(event);
  else activities[index] = event;
  const transitionKey = aiRunActivityTransitionKey(event);
  const previous = projection.history[projection.history.length - 1];
  const history =
    previous !== undefined && aiRunActivityTransitionKey(previous) === transitionKey
      ? projection.history
      : [...projection.history, event];
  return { activities, history };
};

/** Mark the latest active item failed when a terminal error races its event. */
export const failActiveAiRunActivity = (
  projection: AiRunActivityProjection,
): AiRunActivityProjection => {
  for (let index = projection.history.length - 1; index >= 0; index -= 1) {
    const latest = projection.history[index];
    if (latest?.status !== "running" && latest?.status !== "retrying") continue;
    const key = aiRunActivityKey(latest.code, latest.topicId);
    const activity = projection.activities.find(
      (candidate) =>
        aiRunActivityKey(candidate.code, candidate.topicId) === key &&
        (candidate.status === "running" || candidate.status === "retrying"),
    );
    if (activity !== undefined)
      return projectAiRunActivity(projection, { ...activity, status: "failed" });
  }
  for (let index = projection.activities.length - 1; index >= 0; index -= 1) {
    const activity = projection.activities[index];
    if (activity?.status !== "running" && activity?.status !== "retrying") continue;
    return projectAiRunActivity(projection, { ...activity, status: "failed" });
  }
  return projection;
};

export const AiRunActivityFailureCode = Schema.Literals([
  "plan_turn_failed",
  "internal_retrieval_failed",
  "memory_selector_failed",
  "web_research_failed",
  "context_assembly_failed",
  "context_compaction_failed",
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
    case "context_compaction_failed":
    case "context_mandatory_too_large":
    case "context_plan_unfit":
    case "context_budget_mismatch":
    case "synthesis_budget_mismatch":
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
    case "fanout_allocation_exact_gate":
    case "synthesis_assembly_exact_gate":
    case "context_compaction_plan":
    case "context_compaction_group_plan":
    case "context_compaction_fallback_group_plan":
    case "context_compaction_group":
    case "context_compaction_fallback_group":
    case "context_compaction_collect":
    case "context_compaction_fallback_collect":
    case "context_compaction_measure":
    case "context_compaction_fallback_measure":
    case "context_compaction_fallback_plan":
    case "context_compaction_select":
    case "context_compaction_final_measure":
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
    compactionRan: Schema.Boolean,
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
    runId: Schema.optional(SafeRunIdentity),
    stage: Schema.optional(AiRunActivityStage),
    attempt: Schema.optional(SafeActivityAttempt),
    occurredAt: Schema.optional(SafeActivityTimestamp),
    errorCategory: Schema.optional(AiRunActivityErrorCategory),
    errorMessage: Schema.optional(SafeActivityMessage),
  }),
]);
export type AiRunEvent = Schema.Schema.Type<typeof AiRunEvent>;
export type AiRunErrorEvent = Extract<AiRunEvent, { readonly type: "error" }>;
