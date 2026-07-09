/** @jsxImportSource smithers-orchestrator */
import type { Usage } from "@earendil-works/pi-ai";
import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import { z } from "zod";

import type { WorkerConfig } from "../../config";
import type {
  AiClient,
  AiCallResult,
  AnswerOutput as LlmAnswerOutput,
  PreflightToolEvent,
  ProposedMemory,
  SourceCatalogSummaryItem,
  StandingWindowBlockSummary,
} from "../llm";
import { zeroUsage } from "../llm";
import type { QuerySpec, SourceAccess } from "../retrieval/query-spec";
import { remainingBlockBudget } from "../window/plan-window";
import type { ContextBlockRow } from "../window/hydrate";
import { hydrateWindow, loadActiveContextBlocks, markBlocksCited } from "../window/hydrate";
import { assembleContextWindow, type ChatHistoryMessage } from "../window/assemble-prompt";
import type {
  BlockProvenance,
  DocumentBlockProvenance,
  ManifestEntry,
  MemoryBlockProvenance,
  MemoryItem,
} from "../window/blocks";
import type { CreateSmithersApi } from "../smithers-interop";
import {
  appendAiRunEventForTask,
  appendAiRunEventOnce,
  appendAiRunEventInTransaction,
  type AiRunEvent,
  insertAiObservation,
  replaceAiRunEventsForTask,
  runAiWorkflowDb,
  withAiRunEventTransaction,
} from "./events";

type SerializedQuerySpec = Omit<
  QuerySpec,
  "sourceIds" | "countries" | "languages" | "documentTypes"
> & {
  sourceIds?: string[] | undefined;
  countries?: string[] | undefined;
  languages?: string[] | undefined;
  documentTypes?: string[] | undefined;
};

type SerializedManifestEntry = ManifestEntry;

type SerializedPreflightToolEvent =
  | {
      readonly type: "search";
      readonly spec: SerializedQuerySpec;
      readonly resultCount: number;
    }
  | {
      readonly type: "peek";
      readonly documentId: string;
      readonly offsetChars: number | null;
      readonly lengthChars: number | null;
      readonly found: boolean;
    }
  | {
      readonly type: "manifest";
      readonly entries: SerializedManifestEntry[];
    }
  | {
      readonly type: "tool_rejected";
      readonly toolName: string;
      readonly reason: string;
    }
  | {
      readonly type: "degraded";
      readonly reason: "forced_manifest" | "empty_delta";
    };

type SerializedMemoryBlockProvenance = Omit<MemoryBlockProvenance, "memoryIds"> & {
  readonly memoryIds: string[];
};
type SerializedBlockProvenance = DocumentBlockProvenance | SerializedMemoryBlockProvenance;
type SerializedContextBlockRow = Omit<ContextBlockRow, "provenance"> & {
  readonly provenance: SerializedBlockProvenance;
};

type SerializedUsage = Omit<Usage, "cacheWrite1h" | "reasoning"> & {
  readonly cacheWrite1h?: number | undefined;
  readonly reasoning?: number | undefined;
};

const UsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cacheWrite1h: z.number().optional(),
  reasoning: z.number().optional(),
  totalTokens: z.number(),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    total: z.number(),
  }),
}) satisfies z.ZodType<SerializedUsage>;
const FailureSchema = z
  .object({
    agent: z.string(),
    kind: z.enum(["overflow", "fatal", "truncated"]),
    code: z.string(),
    message: z.string(),
    usage: UsageSchema,
  })
  .nullable();
const MemoryKindSchema = z.enum(["profile", "preference", "instruction", "fact", "episode"]);
const ManifestEntrySchema = z.object({
  documentId: z.string(),
  charStart: z.number().optional(),
  charEnd: z.number().optional(),
}) satisfies z.ZodType<SerializedManifestEntry>;
const QuerySpecSchema = z.object({
  terms: z.string(),
  sourceIds: z.array(z.string()).optional(),
  countries: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  documentTypes: z.array(z.string()).optional(),
  publishedAfter: z.string().optional(),
  publishedBefore: z.string().optional(),
  orderBy: z.enum(["relevance", "recency"]).optional(),
  limit: z.number().optional(),
}) satisfies z.ZodType<SerializedQuerySpec>;
const PreflightToolEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("search"),
    spec: QuerySpecSchema,
    resultCount: z.number(),
  }),
  z.object({
    type: z.literal("peek"),
    documentId: z.string(),
    offsetChars: z.number().nullable(),
    lengthChars: z.number().nullable(),
    found: z.boolean(),
  }),
  z.object({
    type: z.literal("manifest"),
    entries: z.array(ManifestEntrySchema),
  }),
  z.object({
    type: z.literal("tool_rejected"),
    toolName: z.string(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("degraded"),
    reason: z.enum(["forced_manifest", "empty_delta"]),
  }),
]) satisfies z.ZodType<SerializedPreflightToolEvent>;
const SourceCatalogItemSchema = z.object({
  sourceId: z.string(),
  displayName: z.string(),
  country: z.string(),
  language: z.string(),
  ingestionType: z.string(),
}) satisfies z.ZodType<SourceCatalogSummaryItem>;
const MemoryItemSchema = z.object({
  id: z.string(),
  kind: MemoryKindSchema,
  content: z.string(),
}) satisfies z.ZodType<MemoryItem>;
const HistoryMessageSchema = z.object({
  author: z.enum(["user", "assistant"]),
  content: z.string(),
}) satisfies z.ZodType<ChatHistoryMessage>;
const DocumentBlockProvenanceSchema = z.object({
  documentId: z.string(),
  sourceId: z.string(),
  sourceDisplayName: z.string(),
  canonicalUrl: z.string(),
  title: z.string(),
  publishedAt: z.string().nullable(),
  charStart: z.number().nullable(),
  charEnd: z.number().nullable(),
}) satisfies z.ZodType<DocumentBlockProvenance>;
const MemoryBlockProvenanceSchema = z.object({
  memoryIds: z.array(z.string()),
}) satisfies z.ZodType<SerializedMemoryBlockProvenance>;
const ContextBlockSchema = z.object({
  blockId: z.string(),
  kind: z.enum(["document", "memory"]),
  content: z.string(),
  tokenEstimate: z.number(),
  documentId: z.string().nullable(),
  charStart: z.number().nullable(),
  charEnd: z.number().nullable(),
  provenance: z.union([DocumentBlockProvenanceSchema, MemoryBlockProvenanceSchema]),
  lastCitedRunId: z.string().nullable(),
}) satisfies z.ZodType<SerializedContextBlockRow>;
const BlockSummarySchema = z.object({
  blockId: z.string(),
  label: z.string().nullable(),
  kind: z.enum(["document", "memory"]),
  tokenEstimate: z.number(),
});
const ProposedMemorySchema = z.object({
  kind: MemoryKindSchema,
  content: z.string(),
  evidenceQuote: z.string(),
  targetMemoryId: z.string().optional(),
}) satisfies z.ZodType<ProposedMemory>;
const PreflightOutputSchema = z.object({
  status: z.enum(["ok", "failed"]),
  manifest: z.array(ManifestEntrySchema),
  usage: UsageSchema,
  toolEvents: z.array(PreflightToolEventSchema),
  failure: FailureSchema,
});
const HydrateOutputSchema = z.object({
  status: z.enum(["ok", "failed"]),
  memoryBlock: ContextBlockSchema.nullable(),
  documentBlocks: z.array(ContextBlockSchema),
  blockSummaries: z.array(BlockSummarySchema),
  addedBlockIds: z.array(z.string()),
  evictedBlockIds: z.array(z.string()),
  totalActiveTokens: z.number(),
  failure: FailureSchema,
});
const AnswerOutputSchema = z.object({
  status: z.enum(["ok", "failed"]),
  attempt: z.number(),
  text: z.string(),
  insufficiencyGap: z.string().nullable(),
  usage: UsageSchema,
  failure: FailureSchema,
});

export const aiChatSchemas = {
  input: z.object({ aiRunId: z.string() }),
  aiChatLoadTurn: z.object({
    aiRunId: z.string(),
    chatId: z.string(),
    userId: z.string(),
    userMessageId: z.string(),
    userMessage: z.string(),
    locale: z.string(),
    market: z.string(),
    history: z.array(HistoryMessageSchema),
    sourceCatalog: z.array(SourceCatalogItemSchema),
    memories: z.array(MemoryItemSchema),
    activeBlocks: z.array(ContextBlockSchema),
    remainingBlockBudget: z.number(),
  }),
  aiChatPreflight: PreflightOutputSchema,
  aiChatHydrate: HydrateOutputSchema,
  aiChatAnswer: AnswerOutputSchema,
  aiChatPreflight2: z.object({
    status: z.enum(["ok", "failed", "skipped"]),
    manifest: z.array(ManifestEntrySchema),
    usage: UsageSchema,
    toolEvents: z.array(PreflightToolEventSchema),
    failure: FailureSchema,
  }),
  aiChatHydrate2: z.object({
    status: z.enum(["ok", "failed", "skipped"]),
    memoryBlock: ContextBlockSchema.nullable(),
    documentBlocks: z.array(ContextBlockSchema),
    blockSummaries: z.array(BlockSummarySchema),
    addedBlockIds: z.array(z.string()),
    evictedBlockIds: z.array(z.string()),
    totalActiveTokens: z.number(),
    failure: FailureSchema,
  }),
  aiChatAnswer2: z.object({
    status: z.enum(["ok", "failed", "skipped"]),
    attempt: z.number(),
    text: z.string(),
    insufficiencyGap: z.string().nullable(),
    usage: UsageSchema,
    failure: FailureSchema,
  }),
  aiChatMemory: z.object({
    status: z.enum(["ok", "failed", "skipped"]),
    proposals: z.array(ProposedMemorySchema),
    discardedCount: z.number(),
    usage: UsageSchema,
    error: z.string().nullable(),
  }),
  aiChatFinalize: z.object({
    status: z.enum(["done", "failed"]),
    assistantMessageId: z.string().nullable(),
    errorCode: z.string().nullable(),
  }),
};

export type AiChatSchemas = typeof aiChatSchemas;
export type AiChatWorkflow = ReturnType<CreateSmithersApi<AiChatSchemas>["smithers"]>;
type LoadTurnOutput = z.infer<(typeof aiChatSchemas)["aiChatLoadTurn"]>;
type PreflightOutput = z.infer<(typeof aiChatSchemas)["aiChatPreflight"]>;
type HydrateOutput = z.infer<(typeof aiChatSchemas)["aiChatHydrate"]>;
type AnswerOutput = z.infer<(typeof aiChatSchemas)["aiChatAnswer"]>;
type Preflight2Output = z.infer<(typeof aiChatSchemas)["aiChatPreflight2"]>;
type Hydrate2Output = z.infer<(typeof aiChatSchemas)["aiChatHydrate2"]>;
type Answer2Output = z.infer<(typeof aiChatSchemas)["aiChatAnswer2"]>;
type MemoryOutput = z.infer<(typeof aiChatSchemas)["aiChatMemory"]>;

const AI_WORKFLOW_LOCAL_TASK_TIMEOUT_MS = 30_000;

export interface AiChatWorkflowRuntime {
  readonly connectionString: string;
  readonly config: Pick<
    WorkerConfig,
    | "aiSearchMaxLimit"
    | "aiSearchRecencyHalfLifeDays"
    | "aiContextBlockBudget"
    | "aiContextBlockHardCap"
    | "aiFullDocMaxChars"
    | "aiHistoryMaxMessages"
    | "aiPreflightHistoryMessages"
    | "aiPreflightTimeoutMs"
    | "aiAnswerTimeoutMs"
  >;
  readonly aiClient: AiClient;
  readonly now?: () => Date;
}

class RetryableAiTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableAiTaskError";
  }
}

interface LoadTurnRow {
  readonly aiRunId: string;
  readonly chatId: string;
  readonly userId: string;
  readonly userMessageId: string;
  readonly userMessage: string;
  readonly locale: string;
  readonly market: string;
}

interface HistoryRow {
  readonly author: "user" | "assistant";
  readonly content: string;
}

interface SourceCatalogRow {
  readonly sourceId: string;
  readonly displayName: string;
  readonly country: string;
  readonly language: string;
  readonly ingestionType: string;
}

interface MemoryRow {
  readonly id: string;
  readonly kind: MemoryItem["kind"];
  readonly content: string;
}

interface IdRow {
  readonly id: string;
}

interface ExistingMessageRow {
  readonly assistantMessageId: string | null;
}

const sourceAccess: SourceAccess = { kind: "allPublicSources" };

const preflightSystemPrompt =
  "Select the smallest useful evidence manifest for the user's question. Use search_documents and peek_document, then emit_manifest with document ids and optional character ranges only.";

const answerSystemPrompt =
  "You are Brief's editorial assistant. Answer in the user's locale. Ground every factual claim in the provided context blocks. Cite with [[cite:b1]] or [[cite:b1,b2]]. If the window lacks required evidence, reply exactly [[insufficient: one line gap]].";

const retryAnswerSystemPrompt =
  "You are Brief's editorial assistant. This is the only retry after an insufficiency signal. Answer with the available evidence, cite every factual claim, and state remaining gaps plainly.";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const truncateDiagnostic = (value: string): string =>
  value.length > 200 ? `${value.slice(0, 200)}...` : value;

const diagnosticJson = (value: unknown): string => {
  try {
    const json = JSON.stringify(value);
    return truncateDiagnostic(json === undefined ? String(value) : json);
  } catch {
    return "[unserializable]";
  }
};

const fullDiagnosticJson = (value: unknown): string => {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return "[unserializable]";
  }
};

const valueAtPath = (value: unknown, path: readonly (string | number | symbol)[]): unknown => {
  let current = value;

  for (const segment of path) {
    if (current === null || current === undefined) {
      return current;
    }

    current = (current as Record<string | number | symbol, unknown>)[segment];
  }

  return current;
};

const formatIssuePath = (path: readonly (string | number | symbol)[]): string =>
  path.length === 0 ? "<root>" : path.map((segment) => String(segment)).join(".");

class TaskOutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskOutputValidationError";
  }
}

function validateTaskOutput<Schema extends z.ZodTypeAny>(
  schemaName: string,
  zodSchema: Schema,
  value: unknown,
): z.infer<Schema> {
  if (process.env.AI_CHAT_TEST_DEBUG === "1") {
    console.error(
      `[AI_CHAT_TEST_DEBUG] validateTaskOutput ${schemaName} payload ${fullDiagnosticJson(value)}`,
    );
  }

  const parsed = zodSchema.safeParse(value);

  if (parsed.success) {
    return parsed.data;
  }

  const issues = parsed.error.issues.map((issue) => {
    const leaf = valueAtPath(value, issue.path);
    return [
      `path=${formatIssuePath(issue.path)}`,
      `code=${issue.code}`,
      `message=${issue.message}`,
      `typeof=${typeof leaf}`,
      `value=${diagnosticJson(leaf)}`,
    ].join(" ");
  });

  throw new TaskOutputValidationError(
    `${schemaName} task output failed validation:\n${issues.join("\n")}`,
  );
}

const addUsage = (left: SerializedUsage, right: SerializedUsage): SerializedUsage => ({
  input: left.input + right.input,
  output: left.output + right.output,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
  ...(left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined
    ? { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }
    : {}),
  ...(left.reasoning !== undefined || right.reasoning !== undefined
    ? { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }
    : {}),
  totalTokens: left.totalTokens + right.totalTokens,
  cost: {
    input: left.cost.input + right.cost.input,
    output: left.cost.output + right.cost.output,
    cacheRead: left.cost.cacheRead + right.cost.cacheRead,
    cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
    total: left.cost.total + right.cost.total,
  },
});

const toSerializedQuerySpec = (spec: QuerySpec): SerializedQuerySpec => ({
  terms: spec.terms,
  ...(spec.sourceIds === undefined ? {} : { sourceIds: [...spec.sourceIds] }),
  ...(spec.countries === undefined ? {} : { countries: [...spec.countries] }),
  ...(spec.languages === undefined ? {} : { languages: [...spec.languages] }),
  ...(spec.documentTypes === undefined ? {} : { documentTypes: [...spec.documentTypes] }),
  ...(spec.publishedAfter === undefined ? {} : { publishedAfter: spec.publishedAfter }),
  ...(spec.publishedBefore === undefined ? {} : { publishedBefore: spec.publishedBefore }),
  ...(spec.orderBy === undefined ? {} : { orderBy: spec.orderBy }),
  ...(spec.limit === undefined ? {} : { limit: spec.limit }),
});

const toSerializedManifestEntry = (entry: ManifestEntry): SerializedManifestEntry => ({
  documentId: entry.documentId,
  ...(entry.charStart === undefined ? {} : { charStart: entry.charStart }),
  ...(entry.charEnd === undefined ? {} : { charEnd: entry.charEnd }),
});

const toSerializedPreflightToolEvent = (
  event: PreflightToolEvent,
): SerializedPreflightToolEvent => {
  if (event.type === "search") {
    return {
      type: "search",
      spec: toSerializedQuerySpec(event.spec),
      resultCount: event.resultCount,
    };
  }

  if (event.type === "peek") {
    return {
      type: "peek",
      documentId: event.documentId,
      offsetChars: event.offsetChars,
      lengthChars: event.lengthChars,
      found: event.found,
    };
  }

  if (event.type === "manifest") {
    return {
      type: "manifest",
      entries: event.entries.map(toSerializedManifestEntry),
    };
  }

  if (event.type === "tool_rejected") {
    return {
      type: "tool_rejected",
      toolName: event.toolName,
      reason: event.reason,
    };
  }

  return {
    type: "degraded",
    reason: event.reason,
  };
};

const toSerializedProvenance = (provenance: BlockProvenance): SerializedBlockProvenance => {
  if ("memoryIds" in provenance) {
    return { memoryIds: [...provenance.memoryIds] };
  }

  return {
    documentId: provenance.documentId,
    sourceId: provenance.sourceId,
    sourceDisplayName: provenance.sourceDisplayName,
    canonicalUrl: provenance.canonicalUrl,
    title: provenance.title,
    publishedAt: provenance.publishedAt,
    charStart: provenance.charStart,
    charEnd: provenance.charEnd,
  };
};

const toSerializedContextBlockRow = (row: ContextBlockRow): SerializedContextBlockRow => ({
  blockId: row.blockId,
  kind: row.kind,
  content: row.content,
  tokenEstimate: row.tokenEstimate,
  documentId: row.documentId,
  charStart: row.charStart,
  charEnd: row.charEnd,
  provenance: toSerializedProvenance(row.provenance),
  lastCitedRunId: row.lastCitedRunId,
});

function terminalFailure<A>(
  agent: string,
  result: Exclude<AiCallResult<A>, { readonly kind: "ok" | "retryable" }>,
): NonNullable<PreflightOutput["failure"]> {
  return {
    agent,
    kind: result.kind,
    code: `ai_${agent}_${result.kind}`,
    message: result.errorMessage,
    usage: result.usage,
  };
}

function requireOkOrThrowRetryable<A>(
  agent: string,
  result: AiCallResult<A>,
):
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly failure: NonNullable<PreflightOutput["failure"]> } {
  if (result.kind === "ok") {
    return { ok: true, value: result.value };
  }

  if (result.kind === "retryable") {
    throw new RetryableAiTaskError(result.errorMessage || `${agent} retryable LLM failure`);
  }

  return { ok: false, failure: terminalFailure(agent, result) };
}

const blockLabel = (
  block: Pick<ContextBlockRow, "kind" | "provenance" | "blockId">,
): string | null => {
  if (block.kind === "memory") {
    return null;
  }

  const provenance = block.provenance as unknown as Record<string, unknown>;
  const title = typeof provenance.title === "string" ? provenance.title : block.blockId;
  const source =
    typeof provenance.sourceDisplayName === "string" ? provenance.sourceDisplayName : "source";

  return `${source}: ${title}`;
};

const summarizeBlocks = (blocks: readonly ContextBlockRow[]) =>
  blocks.map((block) => ({
    blockId: block.blockId,
    label: blockLabel(block),
    kind: block.kind,
    tokenEstimate: block.tokenEstimate,
  }));

const allWindowBlocks = (
  hydrate: HydrateOutput | Hydrate2Output,
): readonly SerializedContextBlockRow[] => [
  ...(hydrate.memoryBlock === null ? [] : [hydrate.memoryBlock]),
  ...hydrate.documentBlocks,
];

const loadTurn = (runtime: AiChatWorkflowRuntime, aiRunId: string): Promise<LoadTurnOutput> =>
  runAiWorkflowDb(
    runtime.connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<LoadTurnRow>`
        select
          runs.id::text as "aiRunId",
          runs.chat_id::text as "chatId",
          chats.user_id as "userId",
          runs.user_message_id::text as "userMessageId",
          messages.content as "userMessage",
          runs.locale,
          runs.market
        from ai_runs runs
        join chats on chats.id = runs.chat_id
        join chat_messages messages on messages.id = runs.user_message_id
        where runs.id = ${aiRunId}
      `;
      const row = rows[0];

      if (row === undefined) {
        throw new Error(`ai run not found: ${aiRunId}`);
      }

      yield* sql`
        update ai_runs
        set started_at = coalesce(started_at, now())
        where id = ${aiRunId}
      `;
      yield* appendAiRunEventOnce(aiRunId, { type: "run_started" });

      const history = yield* sql<HistoryRow>`
        select author, content
        from chat_messages
        where chat_id = ${row.chatId}
          and id <> ${row.userMessageId}
        order by created_at asc, id asc
      `;
      const sourceCatalog = yield* sql<SourceCatalogRow>`
        select
          source_id as "sourceId",
          display_name as "displayName",
          coalesce(country, '') as country,
          coalesce(language, '') as language,
          ingestion_method as "ingestionType"
        from public_sources
        order by display_name asc, source_id asc
      `;
      const memories = yield* sql<MemoryRow>`
        select id::text, kind, content
        from user_memories
        where user_id = ${row.userId}
          and deleted_at is null
        order by created_at asc, id asc
      `;
      const activeBlocks = yield* loadActiveContextBlocks(row.chatId);
      const activeTokens = activeBlocks.reduce((sum, block) => sum + block.tokenEstimate, 0);

      return validateTaskOutput("aiChatLoadTurn", aiChatSchemas.aiChatLoadTurn, {
        aiRunId: row.aiRunId,
        chatId: row.chatId,
        userId: row.userId,
        userMessageId: row.userMessageId,
        userMessage: row.userMessage,
        locale: row.locale,
        market: row.market,
        history: [...history],
        sourceCatalog: [...sourceCatalog],
        memories: [...memories],
        activeBlocks: activeBlocks.map(toSerializedContextBlockRow),
        remainingBlockBudget: remainingBlockBudget(
          activeTokens,
          runtime.config.aiContextBlockBudget,
        ),
      });
    }),
  );

const recordPreflightToolEvents = (
  load: LoadTurnOutput,
  taskId: "preflight" | "preflight-2",
  toolEvents: readonly PreflightToolEvent[],
) =>
  Effect.gen(function* () {
    const streamEvents: AiRunEvent[] = [];

    for (const event of toolEvents) {
      if (event.type === "search") {
        streamEvents.push({
          type: "preflight_search",
          terms: event.spec.terms,
          resultCount: event.resultCount,
        });
      }

      if (event.type === "peek") {
        streamEvents.push({ type: "preflight_peek", documentId: event.documentId });
      }
    }

    yield* replaceAiRunEventsForTask(load.aiRunId, taskId, streamEvents);

    for (const event of toolEvents) {
      if (event.type === "search") {
        yield* insertAiObservation(load.aiRunId, load.chatId, "search", {
          query: event.spec,
          resultCount: event.resultCount,
        });
      }

      if (event.type === "peek") {
        yield* insertAiObservation(load.aiRunId, load.chatId, "peek", {
          documentId: event.documentId,
          offsetChars: event.offsetChars,
          lengthChars: event.lengthChars,
          found: event.found,
        });
      }
    }
  });

const runPreflightTask = async (
  runtime: AiChatWorkflowRuntime,
  load: LoadTurnOutput,
  options: {
    readonly taskId: "preflight" | "preflight-2";
    readonly standingWindow?: LoadTurnOutput["activeBlocks"] | HydrateOutput["blockSummaries"];
    readonly remainingBlockBudget?: number;
    readonly insufficiencyGap?: string;
  },
): Promise<PreflightOutput> => {
  const standingWindow = options.standingWindow ?? load.activeBlocks;
  const standingWindowSummary: readonly StandingWindowBlockSummary[] = (() => {
    if (standingWindow.length > 0 && "label" in standingWindow[0]!) {
      return (standingWindow as readonly StandingWindowBlockSummary[]).map((block) => ({
        blockId: block.blockId,
        label: block.label,
        tokenEstimate: block.tokenEstimate,
      }));
    }

    return summarizeBlocks(standingWindow as LoadTurnOutput["activeBlocks"]);
  })();
  const budget = options.remainingBlockBudget ?? load.remainingBlockBudget;
  const result = requireOkOrThrowRetryable(
    "preflight",
    await runtime.aiClient.runPreflight(
      {
        systemPrompt: preflightSystemPrompt,
        sourceCatalog: load.sourceCatalog,
        today: (runtime.now?.() ?? new Date()).toISOString().slice(0, 10),
        market: load.market,
        locale: load.locale,
        standingWindow: standingWindowSummary,
        memories: load.memories,
        history: load.history.slice(
          Math.max(load.history.length - runtime.config.aiPreflightHistoryMessages, 0),
        ),
        userMessage: load.userMessage,
        remainingBlockBudget: budget,
        ...(options.insufficiencyGap === undefined
          ? {}
          : { insufficiencyGap: options.insufficiencyGap }),
      },
      {
        access: sourceAccess,
        maxSearchLimit: runtime.config.aiSearchMaxLimit,
        recencyHalfLifeDays: runtime.config.aiSearchRecencyHalfLifeDays,
        now: runtime.now?.(),
      },
    ),
  );

  if (!result.ok) {
    await runAiWorkflowDb(
      runtime.connectionString,
      replaceAiRunEventsForTask(load.aiRunId, options.taskId, []),
    );

    return validateTaskOutput("aiChatPreflight", aiChatSchemas.aiChatPreflight, {
      status: "failed",
      manifest: [],
      usage: result.failure.usage,
      toolEvents: [],
      failure: result.failure,
    });
  }

  await runAiWorkflowDb(
    runtime.connectionString,
    Effect.gen(function* () {
      yield* recordPreflightToolEvents(load, options.taskId, result.value.toolEvents);
      yield* appendAiRunEventForTask(load.aiRunId, options.taskId, {
        type: "usage",
        agent: "preflight",
        usage: result.value.usage,
      });
    }),
  );

  return validateTaskOutput("aiChatPreflight", aiChatSchemas.aiChatPreflight, {
    status: "ok",
    manifest: result.value.manifest.map(toSerializedManifestEntry),
    usage: result.value.usage,
    toolEvents: result.value.toolEvents.map(toSerializedPreflightToolEvent),
    failure: null,
  });
};

const runHydrateTask = (
  runtime: AiChatWorkflowRuntime,
  load: LoadTurnOutput,
  preflight: Pick<PreflightOutput, "status" | "manifest" | "failure">,
  origin: "initial" | "retry",
): Promise<HydrateOutput> => {
  const taskId = origin === "initial" ? "hydrate" : "hydrate-2";

  if (preflight.status === "failed") {
    return runAiWorkflowDb(
      runtime.connectionString,
      replaceAiRunEventsForTask(load.aiRunId, taskId, []),
    ).then(() =>
      validateTaskOutput("aiChatHydrate", aiChatSchemas.aiChatHydrate, {
        status: "failed",
        memoryBlock: null,
        documentBlocks: [],
        blockSummaries: [],
        addedBlockIds: [],
        evictedBlockIds: [],
        totalActiveTokens: 0,
        failure: preflight.failure,
      }),
    );
  }

  return runAiWorkflowDb(
    runtime.connectionString,
    Effect.gen(function* () {
      const standingBlocks = yield* loadActiveContextBlocks(load.chatId);
      const hydrated = yield* hydrateWindow(
        preflight.manifest,
        standingBlocks,
        {
          blockBudget: runtime.config.aiContextBlockBudget,
          hardCap: runtime.config.aiContextBlockHardCap,
          fullDocMaxChars: runtime.config.aiFullDocMaxChars,
        },
        {
          chatId: load.chatId,
          aiRunId: load.aiRunId,
          origin,
          memories: load.memories,
          access: sourceAccess,
        },
      );
      const activeBlocks = [
        ...(hydrated.memoryBlock === null ? [] : [hydrated.memoryBlock]),
        ...hydrated.documentBlocks,
      ];
      const blockSummaries = summarizeBlocks(activeBlocks);

      yield* replaceAiRunEventsForTask(load.aiRunId, taskId, [
        {
          type: "context_window",
          blocks: blockSummaries,
        },
      ]);

      return validateTaskOutput("aiChatHydrate", aiChatSchemas.aiChatHydrate, {
        status: "ok" as const,
        memoryBlock:
          hydrated.memoryBlock === null ? null : toSerializedContextBlockRow(hydrated.memoryBlock),
        documentBlocks: hydrated.documentBlocks.map(toSerializedContextBlockRow),
        blockSummaries,
        addedBlockIds: [...hydrated.addedBlockIds],
        evictedBlockIds: [...hydrated.evictedBlockIds],
        totalActiveTokens: hydrated.totalActiveTokens,
        failure: null,
      });
    }),
  );
};

const runAnswerTask = async (
  runtime: AiChatWorkflowRuntime,
  load: LoadTurnOutput,
  hydrate: HydrateOutput | Hydrate2Output,
  attempt: 1 | 2,
): Promise<AnswerOutput> => {
  const taskId = attempt === 1 ? "answer" : "answer-2";

  if (hydrate.status === "failed") {
    await runAiWorkflowDb(
      runtime.connectionString,
      replaceAiRunEventsForTask(load.aiRunId, taskId, []),
    );

    return validateTaskOutput("aiChatAnswer", aiChatSchemas.aiChatAnswer, {
      status: "failed",
      attempt,
      text: "",
      insufficiencyGap: null,
      usage: hydrate.failure?.usage ?? zeroUsage(),
      failure: hydrate.failure,
    });
  }

  await runAiWorkflowDb(
    runtime.connectionString,
    withAiRunEventTransaction(
      load.aiRunId,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          delete from ai_run_events
          where run_id = ${load.aiRunId}
            and emitted_by_task = ${taskId}
        `;
        yield* appendAiRunEventInTransaction(
          load.aiRunId,
          { type: "answer_started", attempt },
          taskId,
        );
      }),
    ),
  );

  const prompt = assembleContextWindow({
    systemPrompt: attempt === 1 ? answerSystemPrompt : retryAnswerSystemPrompt,
    memoryBlock: hydrate.memoryBlock,
    blocks: allWindowBlocks(hydrate),
    history: load.history,
    userMessage: load.userMessage,
    historyMaxMessages: runtime.config.aiHistoryMaxMessages,
  });
  let final: AiCallResult<LlmAnswerOutput> | null = null;

  for await (const event of runtime.aiClient.streamAnswer({
    systemPrompt: prompt.system,
    messages: prompt.messages,
  })) {
    if (event.type === "text_delta") {
      await runAiWorkflowDb(
        runtime.connectionString,
        appendAiRunEventForTask(load.aiRunId, taskId, {
          type: "text_delta",
          delta: event.delta,
        }),
      );
    } else {
      final = event.result;
    }
  }

  if (final === null) {
    return validateTaskOutput("aiChatAnswer", aiChatSchemas.aiChatAnswer, {
      status: "failed",
      attempt,
      text: "",
      insufficiencyGap: null,
      usage: zeroUsage(),
      failure: {
        agent: "answer",
        kind: "fatal",
        code: "ai_answer_missing_result",
        message: "answer stream ended without a final result",
        usage: zeroUsage(),
      },
    });
  }

  const result = requireOkOrThrowRetryable("answer", final);
  if (!result.ok) {
    return validateTaskOutput("aiChatAnswer", aiChatSchemas.aiChatAnswer, {
      status: "failed",
      attempt,
      text: "",
      insufficiencyGap: null,
      usage: result.failure.usage,
      failure: result.failure,
    });
  }

  await runAiWorkflowDb(
    runtime.connectionString,
    Effect.gen(function* () {
      yield* appendAiRunEventForTask(load.aiRunId, taskId, {
        type: "usage",
        agent: "answer",
        usage: result.value.usage,
      });

      if (attempt === 1 && result.value.insufficiencyGap !== null) {
        yield* appendAiRunEventForTask(load.aiRunId, taskId, {
          type: "answer_retry",
          gap: result.value.insufficiencyGap,
        });
        yield* insertAiObservation(load.aiRunId, load.chatId, "insufficient_context", {
          gap: result.value.insufficiencyGap,
        });
      }
    }),
  );

  return validateTaskOutput("aiChatAnswer", aiChatSchemas.aiChatAnswer, {
    status: "ok",
    attempt,
    text: result.value.text,
    insufficiencyGap: result.value.insufficiencyGap,
    usage: result.value.usage,
    failure: null,
  });
};

const runMemoryTask = async (
  runtime: AiChatWorkflowRuntime,
  load: LoadTurnOutput,
  answer: AnswerOutput,
  answer2: Answer2Output,
): Promise<MemoryOutput> => {
  const terminalAnswer = answer2.status === "ok" ? answer2 : answer;
  if (terminalAnswer.status !== "ok" || terminalAnswer.failure !== null) {
    await runAiWorkflowDb(
      runtime.connectionString,
      replaceAiRunEventsForTask(load.aiRunId, "memory", []),
    );

    return validateTaskOutput("aiChatMemory", aiChatSchemas.aiChatMemory, {
      status: "skipped",
      proposals: [],
      discardedCount: 0,
      usage: zeroUsage(),
      error: null,
    });
  }

  try {
    const result = requireOkOrThrowRetryable(
      "memory",
      await runtime.aiClient.extractMemories({
        userText: load.userMessage,
        existingMemories: load.memories.map((memory) => ({
          id: memory.id,
          kind: memory.kind,
          content: memory.content,
        })),
      }),
    );

    if (!result.ok) {
      await runAiWorkflowDb(
        runtime.connectionString,
        replaceAiRunEventsForTask(load.aiRunId, "memory", []),
      );

      return validateTaskOutput("aiChatMemory", aiChatSchemas.aiChatMemory, {
        status: "failed",
        proposals: [],
        discardedCount: 0,
        usage: result.failure.usage,
        error: result.failure.message,
      });
    }

    await runAiWorkflowDb(
      runtime.connectionString,
      replaceAiRunEventsForTask(load.aiRunId, "memory", [
        {
          type: "usage",
          agent: "memory",
          usage: result.value.usage,
        },
      ]),
    );

    return validateTaskOutput("aiChatMemory", aiChatSchemas.aiChatMemory, {
      status: "ok",
      proposals: [...result.value.proposals],
      discardedCount: result.value.discarded.length,
      usage: result.value.usage,
      error: null,
    });
  } catch (error) {
    if (error instanceof TaskOutputValidationError) {
      throw error;
    }

    await runAiWorkflowDb(
      runtime.connectionString,
      replaceAiRunEventsForTask(load.aiRunId, "memory", []),
    );

    return validateTaskOutput("aiChatMemory", aiChatSchemas.aiChatMemory, {
      status: "failed",
      proposals: [],
      discardedCount: 0,
      usage: zeroUsage(),
      error: errorMessage(error),
    });
  }
};

type ParsedCitationToken =
  | { readonly kind: "block"; readonly blockId: string }
  | { readonly kind: "malformed"; readonly token: string };

const citationTokens = (text: string): readonly ParsedCitationToken[] => {
  const tokens: ParsedCitationToken[] = [];
  const tagPattern = /\[\[cite:([^\]\n]+)\]\]/g;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(text)) !== null) {
    const ids = (match[1] ?? "").split(",").map((id) => id.trim());

    for (const id of ids) {
      if (/^b(0|[1-9]\d*)$/.test(id)) {
        tokens.push({ kind: "block", blockId: id });
      } else {
        tokens.push({ kind: "malformed", token: id });
      }
    }
  }

  return tokens;
};

const persistMemoryWrites = (
  load: LoadTurnOutput,
  memory: MemoryOutput,
): Effect.Effect<
  { readonly created: number; readonly updated: number },
  unknown,
  PgClient.PgClient
> =>
  Effect.gen(function* () {
    if (memory.status !== "ok") {
      return { created: 0, updated: 0 };
    }

    const sql = yield* PgClient.PgClient;
    let created = 0;
    let updated = 0;

    for (const proposal of memory.proposals) {
      const duplicateRows = yield* sql<IdRow>`
        select id::text
        from user_memories
        where user_id = ${load.userId}
          and kind = ${proposal.kind}
          and content = ${proposal.content}
          and deleted_at is null
        limit 1
      `;

      if (duplicateRows[0] !== undefined) {
        continue;
      }

      if (proposal.targetMemoryId !== undefined) {
        const beforeRows = yield* sql<{ readonly id: string; readonly content: string }>`
          select id::text, content
          from user_memories
          where id = ${proposal.targetMemoryId}
            and user_id = ${load.userId}
            and deleted_at is null
          for update
        `;
        const before = beforeRows[0];

        if (before !== undefined && before.content !== proposal.content) {
          yield* sql`
            update user_memories
            set kind = ${proposal.kind},
                content = ${proposal.content},
                evidence_quote = ${proposal.evidenceQuote},
                source_message_id = ${load.userMessageId},
                updated_at = now()
            where id = ${before.id}
          `;
          yield* sql`
            insert into user_memory_revisions (
              memory_id,
              action,
              content_before,
              content_after,
              run_id
            )
            values (${before.id}, 'updated', ${before.content}, ${proposal.content}, ${load.aiRunId})
          `;
          yield* insertAiObservation(load.aiRunId, load.chatId, "memory_written", {
            memoryId: before.id,
            action: "updated",
          });
          updated += 1;
          continue;
        }
      }

      const insertedRows = yield* sql<IdRow>`
        insert into user_memories (
          user_id,
          kind,
          content,
          evidence_quote,
          source_message_id
        )
        values (
          ${load.userId},
          ${proposal.kind},
          ${proposal.content},
          ${proposal.evidenceQuote},
          ${load.userMessageId}
        )
        returning id::text
      `;
      const inserted = insertedRows[0];

      if (inserted === undefined) {
        continue;
      }

      yield* sql`
        insert into user_memory_revisions (memory_id, action, content_after, run_id)
        values (${inserted.id}, 'created', ${proposal.content}, ${load.aiRunId})
      `;
      yield* insertAiObservation(load.aiRunId, load.chatId, "memory_written", {
        memoryId: inserted.id,
        action: "created",
      });
      created += 1;
    }

    return { created, updated };
  });

const finalizeRun = (
  runtime: AiChatWorkflowRuntime,
  load: LoadTurnOutput,
  preflight: PreflightOutput,
  hydrate: HydrateOutput,
  answer: AnswerOutput,
  preflight2: Preflight2Output,
  hydrate2: Hydrate2Output,
  answer2: Answer2Output,
  memory: MemoryOutput,
) =>
  runAiWorkflowDb(
    runtime.connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const finalAnswer = answer2.status === "ok" ? answer2 : answer;
      const failure =
        preflight.failure ??
        hydrate.failure ??
        answer.failure ??
        preflight2.failure ??
        hydrate2.failure ??
        answer2.failure ??
        (finalAnswer.status === "ok" ? null : finalAnswer.failure);
      const usage = {
        preflight: addUsage(preflight.usage, preflight2.usage),
        answer: addUsage(answer.usage, answer2.usage),
        memory: memory.usage,
      };

      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`select pg_advisory_xact_lock(hashtext(${`brief:ai-run-finalize:${load.aiRunId}`}))`;
          yield* sql`
            update ai_runs
            set usage = ${sql.json(usage)}
            where id = ${load.aiRunId}
          `;

          if (failure !== null) {
            yield* sql`
              update ai_runs
              set failed_at = coalesce(failed_at, now()),
                  error = ${failure.code}
              where id = ${load.aiRunId}
                and finished_at is null
            `;
            yield* replaceAiRunEventsForTask(load.aiRunId, "finalize", [
              { type: "error", code: failure.code },
            ]);

            return validateTaskOutput("aiChatFinalize", aiChatSchemas.aiChatFinalize, {
              status: "failed" as const,
              assistantMessageId: null,
              errorCode: failure.code,
            });
          }

          const existingRows = yield* sql<ExistingMessageRow>`
            select assistant_message_id::text as "assistantMessageId"
            from ai_runs
            where id = ${load.aiRunId}
            for update
          `;
          let assistantMessageId = existingRows[0]?.assistantMessageId ?? null;

          if (assistantMessageId === null) {
            const insertedRows = yield* sql<IdRow>`
              insert into chat_messages (chat_id, author, content, ai_run_id)
              values (${load.chatId}, 'assistant', ${finalAnswer.text}, ${load.aiRunId})
              returning id::text
            `;
            assistantMessageId = insertedRows[0]?.id ?? null;

            if (assistantMessageId === null) {
              throw new Error(`failed to insert assistant message for run ${load.aiRunId}`);
            }
          }

          yield* sql`
            update ai_runs
            set assistant_message_id = ${assistantMessageId},
                finished_at = coalesce(finished_at, now()),
                error = null
            where id = ${load.aiRunId}
          `;
          yield* sql`
            delete from ai_observations
            where run_id = ${load.aiRunId}
              and kind in ('citation', 'citation_defect')
          `;

          const activeBlocks = [...allWindowBlocks(hydrate), ...allWindowBlocks(hydrate2)];
          const activeBlockIds = new Set(activeBlocks.map((block) => block.blockId));
          const citedTokens = citationTokens(finalAnswer.text);
          const knownCitedIds: string[] = [];

          for (const token of citedTokens) {
            if (token.kind === "malformed") {
              yield* insertAiObservation(load.aiRunId, load.chatId, "citation_defect", {
                token: token.token,
                messageId: assistantMessageId,
                reason: "malformed_block_id",
              });
              continue;
            }

            if (activeBlockIds.has(token.blockId)) {
              knownCitedIds.push(token.blockId);
              yield* insertAiObservation(load.aiRunId, load.chatId, "citation", {
                blockId: token.blockId,
                messageId: assistantMessageId,
              });
            } else {
              yield* insertAiObservation(load.aiRunId, load.chatId, "citation_defect", {
                blockId: token.blockId,
                messageId: assistantMessageId,
                reason: "unknown_block_id",
              });
            }
          }

          yield* markBlocksCited(load.chatId, load.aiRunId, knownCitedIds);
          const memoryCounts = yield* persistMemoryWrites(load, memory);
          yield* replaceAiRunEventsForTask(load.aiRunId, "finalize", [
            {
              type: "memory_updated",
              created: memoryCounts.created,
              updated: memoryCounts.updated,
              discarded: memory.discardedCount,
            },
            {
              type: "done",
              assistantMessageId,
            },
          ]);

          return validateTaskOutput("aiChatFinalize", aiChatSchemas.aiChatFinalize, {
            status: "done" as const,
            assistantMessageId,
            errorCode: null,
          });
        }),
      );
    }),
  );

const skippedPreflight2 = (): Preflight2Output =>
  validateTaskOutput("aiChatPreflight2", aiChatSchemas.aiChatPreflight2, {
    status: "skipped",
    manifest: [],
    usage: zeroUsage(),
    toolEvents: [],
    failure: null,
  });

const skippedHydrate2 = (): Hydrate2Output =>
  validateTaskOutput("aiChatHydrate2", aiChatSchemas.aiChatHydrate2, {
    status: "skipped",
    memoryBlock: null,
    documentBlocks: [],
    blockSummaries: [],
    addedBlockIds: [],
    evictedBlockIds: [],
    totalActiveTokens: 0,
    failure: null,
  });

const skippedAnswer2 = (): Answer2Output =>
  validateTaskOutput("aiChatAnswer2", aiChatSchemas.aiChatAnswer2, {
    status: "skipped",
    attempt: 2,
    text: "",
    insufficiencyGap: null,
    usage: zeroUsage(),
    failure: null,
  });

const runPreflight2Task = async (
  runtime: AiChatWorkflowRuntime,
  load: LoadTurnOutput,
  hydrate: HydrateOutput,
  answer: AnswerOutput,
): Promise<Preflight2Output> => {
  if (answer.status !== "ok" || answer.insufficiencyGap === null) {
    return skippedPreflight2();
  }

  const output = await runPreflightTask(runtime, load, {
    taskId: "preflight-2",
    standingWindow: hydrate.blockSummaries,
    remainingBlockBudget: remainingBlockBudget(
      hydrate.totalActiveTokens,
      runtime.config.aiContextBlockBudget,
    ),
    insufficiencyGap: answer.insufficiencyGap,
  });
  return validateTaskOutput("aiChatPreflight2", aiChatSchemas.aiChatPreflight2, {
    ...output,
    status: output.status,
  });
};

const runHydrate2Task = async (
  runtime: AiChatWorkflowRuntime,
  load: LoadTurnOutput,
  preflight2: Preflight2Output,
): Promise<Hydrate2Output> => {
  if (preflight2.status === "skipped") {
    return skippedHydrate2();
  }

  const output = await runHydrateTask(
    runtime,
    load,
    {
      status: preflight2.status,
      manifest: preflight2.manifest,
      failure: preflight2.failure,
    },
    "retry",
  );
  return validateTaskOutput("aiChatHydrate2", aiChatSchemas.aiChatHydrate2, {
    ...output,
    status: output.status,
  });
};

const runAnswer2Task = async (
  runtime: AiChatWorkflowRuntime,
  load: LoadTurnOutput,
  hydrate2: Hydrate2Output,
): Promise<Answer2Output> => {
  if (hydrate2.status === "skipped") {
    return skippedAnswer2();
  }

  const output = await runAnswerTask(runtime, load, hydrate2, 2);
  return validateTaskOutput("aiChatAnswer2", aiChatSchemas.aiChatAnswer2, {
    ...output,
    status: output.status,
  });
};

const parseWorkflowRunId = (input: unknown): string => {
  const parsed = aiChatSchemas.input.safeParse(input);

  if (!parsed.success) {
    throw new Error("ai-chat workflow input must be { aiRunId: string }");
  }

  return parsed.data.aiRunId;
};

export function buildAiChatWorkflow(
  api: CreateSmithersApi<AiChatSchemas>,
  runtime: AiChatWorkflowRuntime,
): AiChatWorkflow {
  const { Workflow, Task, Sequence, Branch, smithers, outputs } = api;

  return smithers((ctx) => {
    const answer = ctx.outputMaybe(outputs.aiChatAnswer, { nodeId: "answer" });
    const needsSecondPass = answer?.status === "ok" && answer.insufficiencyGap !== null;

    return (
      <Workflow name="ai-chat">
        <Sequence>
          <Task
            id="load-turn"
            output={outputs.aiChatLoadTurn}
            retries={2}
            timeoutMs={AI_WORKFLOW_LOCAL_TASK_TIMEOUT_MS}
          >
            {async () => loadTurn(runtime, parseWorkflowRunId(ctx.input))}
          </Task>
          <Task
            id="preflight"
            output={outputs.aiChatPreflight}
            retries={2}
            timeoutMs={runtime.config.aiPreflightTimeoutMs}
          >
            {async () => {
              const load = ctx.output(outputs.aiChatLoadTurn, { nodeId: "load-turn" });
              return runPreflightTask(runtime, load, { taskId: "preflight" });
            }}
          </Task>
          <Task
            id="hydrate"
            output={outputs.aiChatHydrate}
            retries={2}
            timeoutMs={AI_WORKFLOW_LOCAL_TASK_TIMEOUT_MS}
          >
            {async () => {
              const load = ctx.output(outputs.aiChatLoadTurn, { nodeId: "load-turn" });
              const preflight = ctx.output(outputs.aiChatPreflight, { nodeId: "preflight" });
              return runHydrateTask(runtime, load, preflight, "initial");
            }}
          </Task>
          <Task
            id="answer"
            output={outputs.aiChatAnswer}
            retries={2}
            timeoutMs={runtime.config.aiAnswerTimeoutMs}
          >
            {async () => {
              const load = ctx.output(outputs.aiChatLoadTurn, { nodeId: "load-turn" });
              const hydrate = ctx.output(outputs.aiChatHydrate, { nodeId: "hydrate" });
              return runAnswerTask(runtime, load, hydrate, 1);
            }}
          </Task>
          <Branch
            if={needsSecondPass}
            then={
              <Sequence>
                <Task
                  id="preflight-2"
                  output={outputs.aiChatPreflight2}
                  retries={2}
                  timeoutMs={runtime.config.aiPreflightTimeoutMs}
                >
                  {async () => {
                    const load = ctx.output(outputs.aiChatLoadTurn, { nodeId: "load-turn" });
                    const hydrate = ctx.output(outputs.aiChatHydrate, { nodeId: "hydrate" });
                    const answer = ctx.output(outputs.aiChatAnswer, { nodeId: "answer" });
                    return runPreflight2Task(runtime, load, hydrate, answer);
                  }}
                </Task>
                <Task
                  id="hydrate-2"
                  output={outputs.aiChatHydrate2}
                  retries={2}
                  timeoutMs={AI_WORKFLOW_LOCAL_TASK_TIMEOUT_MS}
                >
                  {async () => {
                    const load = ctx.output(outputs.aiChatLoadTurn, { nodeId: "load-turn" });
                    const preflight2 = ctx.output(outputs.aiChatPreflight2, {
                      nodeId: "preflight-2",
                    });
                    return runHydrate2Task(runtime, load, preflight2);
                  }}
                </Task>
                <Task
                  id="answer-2"
                  output={outputs.aiChatAnswer2}
                  retries={2}
                  timeoutMs={runtime.config.aiAnswerTimeoutMs}
                >
                  {async () => {
                    const load = ctx.output(outputs.aiChatLoadTurn, { nodeId: "load-turn" });
                    const hydrate2 = ctx.output(outputs.aiChatHydrate2, { nodeId: "hydrate-2" });
                    return runAnswer2Task(runtime, load, hydrate2);
                  }}
                </Task>
              </Sequence>
            }
            else={
              <Sequence>
                <Task
                  id="preflight-2"
                  output={outputs.aiChatPreflight2}
                  retries={0}
                  timeoutMs={runtime.config.aiPreflightTimeoutMs}
                >
                  {async () => skippedPreflight2()}
                </Task>
                <Task
                  id="hydrate-2"
                  output={outputs.aiChatHydrate2}
                  retries={0}
                  timeoutMs={AI_WORKFLOW_LOCAL_TASK_TIMEOUT_MS}
                >
                  {async () => skippedHydrate2()}
                </Task>
                <Task
                  id="answer-2"
                  output={outputs.aiChatAnswer2}
                  retries={0}
                  timeoutMs={runtime.config.aiAnswerTimeoutMs}
                >
                  {async () => skippedAnswer2()}
                </Task>
              </Sequence>
            }
          />
          <Task
            id="memory"
            output={outputs.aiChatMemory}
            retries={1}
            continueOnFail={true}
            timeoutMs={runtime.config.aiPreflightTimeoutMs}
          >
            {async () => {
              const load = ctx.output(outputs.aiChatLoadTurn, { nodeId: "load-turn" });
              const answer = ctx.output(outputs.aiChatAnswer, { nodeId: "answer" });
              const answer2 = ctx.output(outputs.aiChatAnswer2, { nodeId: "answer-2" });
              return runMemoryTask(runtime, load, answer, answer2);
            }}
          </Task>
          <Task
            id="finalize"
            output={outputs.aiChatFinalize}
            retries={2}
            timeoutMs={AI_WORKFLOW_LOCAL_TASK_TIMEOUT_MS}
          >
            {async () => {
              const load = ctx.output(outputs.aiChatLoadTurn, { nodeId: "load-turn" });
              const preflight = ctx.output(outputs.aiChatPreflight, { nodeId: "preflight" });
              const hydrate = ctx.output(outputs.aiChatHydrate, { nodeId: "hydrate" });
              const answer = ctx.output(outputs.aiChatAnswer, { nodeId: "answer" });
              const preflight2 = ctx.output(outputs.aiChatPreflight2, { nodeId: "preflight-2" });
              const hydrate2 = ctx.output(outputs.aiChatHydrate2, { nodeId: "hydrate-2" });
              const answer2 = ctx.output(outputs.aiChatAnswer2, { nodeId: "answer-2" });
              const memory = ctx.output(outputs.aiChatMemory, { nodeId: "memory" });

              return finalizeRun(
                runtime,
                load,
                preflight,
                hydrate,
                answer,
                preflight2,
                hydrate2,
                answer2,
                memory,
              );
            }}
          </Task>
        </Sequence>
      </Workflow>
    );
  });
}
