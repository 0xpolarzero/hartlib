import { Schema } from "effect";

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

export const AiRunEvent = Schema.Union([
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
