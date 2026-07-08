import { Type } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  Static,
  Usage,
} from "@earendil-works/pi-ai";
import { complete, streamSimple } from "@earendil-works/pi-ai/compat";
import { agentLoop } from "@earendil-works/pi-agent-core";
import type {
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Effect } from "effect";

import { peekDocument, searchDocuments } from "../retrieval/retrieval";
import type { DocumentPeek, DocumentPreview, QuerySpec } from "../retrieval/query-spec";
import type { ManifestEntry, MemoryKind } from "../window/blocks";
import { answerOutputFromMessage, withholdInsufficiencyPrefix } from "./insufficiency";
import { verifyMemoryProposals } from "./memory";
import { resolveZaiModel } from "./models";
import { classifyAssistantMessage } from "./stop-reason";
import type {
  AiCallResult,
  AiClient,
  AnswerStreamEvent,
  MemoryExtractionInput,
  MemoryExtractionOutput,
  PreflightInputs,
  PreflightOutput,
  PreflightToolContext,
  PreflightToolEvent,
  ProposedMemory,
  StreamAnswerInput,
} from "./types";
import { toPiMessages, zeroUsage } from "./types";

const ManifestEntrySchema = Type.Object({
  documentId: Type.String(),
  charStart: Type.Optional(Type.Number()),
  charEnd: Type.Optional(Type.Number()),
});

const SearchDocumentsSchema = Type.Object({
  terms: Type.String(),
  sourceIds: Type.Optional(Type.Array(Type.String())),
  countries: Type.Optional(Type.Array(Type.String())),
  languages: Type.Optional(Type.Array(Type.String())),
  documentTypes: Type.Optional(Type.Array(Type.String())),
  publishedAfter: Type.Optional(Type.String()),
  publishedBefore: Type.Optional(Type.String()),
  orderBy: Type.Optional(Type.Union([Type.Literal("relevance"), Type.Literal("recency")])),
  limit: Type.Optional(Type.Number()),
});

const PeekDocumentSchema = Type.Object({
  documentId: Type.String(),
  offsetChars: Type.Optional(Type.Number()),
  lengthChars: Type.Optional(Type.Number()),
});

const EmitManifestSchema = Type.Object({
  entries: Type.Array(ManifestEntrySchema),
});

const MemoryKindSchema = Type.Union([
  Type.Literal("profile"),
  Type.Literal("preference"),
  Type.Literal("instruction"),
  Type.Literal("fact"),
  Type.Literal("episode"),
]);

const RecordMemoriesSchema = Type.Object({
  memories: Type.Array(
    Type.Object({
      kind: MemoryKindSchema,
      content: Type.String(),
      evidenceQuote: Type.String(),
      targetMemoryId: Type.Optional(Type.String()),
    }),
  ),
});

type SearchDocumentsArgs = Static<typeof SearchDocumentsSchema>;
type PeekDocumentArgs = Static<typeof PeekDocumentSchema>;
type EmitManifestArgs = Static<typeof EmitManifestSchema>;
type RecordMemoriesArgs = Static<typeof RecordMemoriesSchema>;

export interface RetrievalExecutor {
  readonly searchDocuments: (
    spec: QuerySpec,
    options: PreflightToolContext,
  ) => Promise<readonly DocumentPreview[]>;
  readonly peekDocument: (
    documentId: string,
    offsetChars: number | undefined,
    lengthChars: number | undefined,
    options: PreflightToolContext,
  ) => Promise<DocumentPeek | null>;
}

export interface PiBoundary {
  readonly agentLoop?: typeof agentLoop | undefined;
  readonly streamSimple?: typeof streamSimple | undefined;
  readonly complete?: typeof complete | undefined;
  readonly preflightStreamFn?: StreamFn | undefined;
}

export interface PiAiClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string | undefined;
  readonly mainModelId: string;
  readonly fastModelId: string;
  readonly preflightMaxTurns: number;
  readonly preflightMaxSearches: number;
  readonly preflightMaxPeeks: number;
  readonly preflightTimeoutMs: number;
  readonly answerTimeoutMs: number;
  readonly memoryMaxWritesPerTurn: number;
  readonly retrieval?: RetrievalExecutor | undefined;
  readonly boundary?: PiBoundary | undefined;
}

export interface RetrievalEffectRunner {
  <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A>;
}

export const makeEffectRetrievalExecutor = (
  runEffect: RetrievalEffectRunner,
): RetrievalExecutor => ({
  searchDocuments: (spec, context) =>
    runEffect(
      searchDocuments(spec, {
        access: context.access,
        maxLimit: context.maxSearchLimit,
        recencyHalfLifeDays: context.recencyHalfLifeDays,
        now: context.now,
      }),
    ),
  peekDocument: (documentId, offsetChars, lengthChars, context) =>
    runEffect(
      peekDocument(documentId, offsetChars, lengthChars, {
        access: context.access,
      }),
    ),
});

const isLlmMessage = (
  message: AgentMessage,
): message is Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }> =>
  message.role === "user" || message.role === "assistant" || message.role === "toolResult";

const identityConvertToLlm = (messages: AgentMessage[]): Message[] => messages.filter(isLlmMessage);

const textToolResult = (text: string, details: unknown = null) => ({
  content: [{ type: "text" as const, text }],
  details,
});

const normalizeManifest = (entries: readonly ManifestEntry[]): readonly ManifestEntry[] =>
  entries.map((entry) => ({
    documentId: entry.documentId,
    ...(entry.charStart === undefined ? {} : { charStart: entry.charStart }),
    ...(entry.charEnd === undefined ? {} : { charEnd: entry.charEnd }),
  }));

const extractUsage = (messages: readonly AgentMessage[]): Usage =>
  [...messages]
    .reverse()
    .find(
      (message): message is AssistantMessage => message.role === "assistant" && "usage" in message,
    )?.usage ?? zeroUsage();

const lastAssistantMessage = (messages: readonly AgentMessage[]): AssistantMessage | null =>
  [...messages]
    .reverse()
    .find(
      (message): message is AssistantMessage =>
        message.role === "assistant" && "stopReason" in message,
    ) ?? null;

const makeAbortSignal = (
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly cancel: () => void } => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timeout),
  };
};

const buildPreflightUserPrompt = (input: PreflightInputs): string =>
  [
    `today: ${input.today}`,
    `market: ${input.market}`,
    `locale: ${input.locale}`,
    `remaining_block_budget_tokens: ${input.remainingBlockBudget}`,
    input.insufficiencyGap === undefined ? null : `retry_gap: ${input.insufficiencyGap}`,
    "sources:",
    JSON.stringify(input.sourceCatalog),
    "standing_window:",
    JSON.stringify(input.standingWindow),
    "memories:",
    JSON.stringify(input.memories),
    "current_user_message:",
    input.userMessage,
  ]
    .filter((part): part is string => part !== null)
    .join("\n");

const historyMessages = (input: PreflightInputs): Message[] =>
  input.history.map((message) =>
    message.author === "user"
      ? {
          role: "user",
          content: message.content,
          timestamp: Date.now(),
        }
      : {
          role: "assistant",
          content: [{ type: "text", text: message.content }],
          api: "openai-completions",
          provider: "zai",
          model: "history",
          usage: zeroUsage(),
          stopReason: "stop",
          timestamp: Date.now(),
        },
  );

const toMemoryKind = (kind: string): MemoryKind => kind as MemoryKind;

export class PiAiClient implements AiClient {
  private readonly mainModel: Model<Api>;
  private readonly fastModel: Model<Api>;
  private readonly runAgentLoop: typeof agentLoop;
  private readonly runStreamSimple: typeof streamSimple;
  private readonly runComplete: typeof complete;
  private readonly retrieval: RetrievalExecutor;

  constructor(private readonly options: PiAiClientOptions) {
    this.mainModel = resolveZaiModel({
      modelId: options.mainModelId,
      baseUrl: options.baseUrl,
    });
    this.fastModel = resolveZaiModel({
      modelId: options.fastModelId,
      baseUrl: options.baseUrl,
    });
    this.runAgentLoop = options.boundary?.agentLoop ?? agentLoop;
    this.runStreamSimple = options.boundary?.streamSimple ?? streamSimple;
    this.runComplete = options.boundary?.complete ?? complete;
    this.retrieval =
      options.retrieval ??
      ({
        searchDocuments: async () => {
          throw new Error("PiAiClient requires a retrieval executor");
        },
        peekDocument: async () => {
          throw new Error("PiAiClient requires a retrieval executor");
        },
      } satisfies RetrievalExecutor);
  }

  async runPreflight(
    inputs: PreflightInputs,
    toolContext: PreflightToolContext,
  ): Promise<AiCallResult<PreflightOutput>> {
    const toolEvents: PreflightToolEvent[] = [];
    let manifest: readonly ManifestEntry[] | null = null;
    let searches = 0;
    let peeks = 0;
    let turns = 0;
    let capped = false;

    const reject = (toolName: string, reason: string) => {
      toolEvents.push({ type: "tool_rejected", toolName, reason });

      return { block: true, reason };
    };

    const searchTool: AgentTool<typeof SearchDocumentsSchema> = {
      name: "search_documents",
      label: "Search documents",
      description: "Search the public-source corpus and return previews only.",
      parameters: SearchDocumentsSchema,
      execute: async (_toolCallId: string, args: SearchDocumentsArgs) => {
        const results = await this.retrieval.searchDocuments(args, toolContext);

        toolEvents.push({
          type: "search",
          terms: args.terms,
          resultCount: results.length,
        });

        return textToolResult(JSON.stringify(results), { resultCount: results.length });
      },
    };

    const peekTool: AgentTool<typeof PeekDocumentSchema> = {
      name: "peek_document",
      label: "Peek document",
      description: "Read a bounded verbatim slice of one document.",
      parameters: PeekDocumentSchema,
      execute: async (_toolCallId: string, args: PeekDocumentArgs) => {
        const result = await this.retrieval.peekDocument(
          args.documentId,
          args.offsetChars,
          args.lengthChars,
          toolContext,
        );

        toolEvents.push({
          type: "peek",
          documentId: args.documentId,
          offsetChars: args.offsetChars ?? null,
          lengthChars: args.lengthChars ?? null,
          found: result !== null,
        });

        return textToolResult(JSON.stringify(result), { found: result !== null });
      },
    };

    const emitManifestTool: AgentTool<typeof EmitManifestSchema> = {
      name: "emit_manifest",
      label: "Emit manifest",
      description: "Emit the final ordered document manifest and end preflight.",
      parameters: EmitManifestSchema,
      execute: async (_toolCallId: string, args: EmitManifestArgs) => {
        if (manifest === null) {
          manifest = normalizeManifest(args.entries);
          toolEvents.push({ type: "manifest", entries: manifest });
        }

        return textToolResult("manifest recorded", { entries: manifest });
      },
    };

    const config: AgentLoopConfig = {
      model: this.fastModel,
      apiKey: this.options.apiKey,
      reasoning: "medium",
      maxRetries: 0,
      convertToLlm: identityConvertToLlm,
      toolExecution: "parallel",
      beforeToolCall: async (context) => {
        const calls = context.assistantMessage.content.filter(
          (content) => content.type === "toolCall",
        );
        const hasEmitManifest = calls.some((call) => call.name === "emit_manifest");

        if (hasEmitManifest && calls.length > 1) {
          return reject(context.toolCall.name, "emit_manifest cannot be batched with other tools");
        }

        if (
          context.toolCall.name === "search_documents" &&
          searches >= this.options.preflightMaxSearches
        ) {
          capped = true;
          return reject(context.toolCall.name, "search cap reached");
        }

        if (context.toolCall.name === "peek_document" && peeks >= this.options.preflightMaxPeeks) {
          capped = true;
          return reject(context.toolCall.name, "peek cap reached");
        }

        if (context.toolCall.name === "search_documents") {
          searches += 1;
        }

        if (context.toolCall.name === "peek_document") {
          peeks += 1;
        }

        return undefined;
      },
      afterToolCall: async (context) => {
        if (context.toolCall.name === "emit_manifest" && manifest !== null && !context.isError) {
          return { terminate: true };
        }

        return undefined;
      },
      shouldStopAfterTurn: async () => {
        turns += 1;

        if (manifest !== null) {
          return true;
        }

        if (turns >= this.options.preflightMaxTurns) {
          capped = true;
          return true;
        }

        return false;
      },
    };
    const abort = makeAbortSignal(this.options.preflightTimeoutMs);
    let messages: readonly AgentMessage[] = [];

    try {
      const stream = this.runAgentLoop(
        [
          {
            role: "user",
            content: buildPreflightUserPrompt(inputs),
            timestamp: Date.now(),
          },
        ],
        {
          systemPrompt: inputs.systemPrompt,
          messages: historyMessages(inputs),
          tools: [searchTool, peekTool, emitManifestTool],
        },
        config,
        abort.signal,
        this.options.boundary?.preflightStreamFn,
      );

      for await (const _event of stream) {
      }

      messages = await stream.result();
    } catch {
      capped = true;
    } finally {
      abort.cancel();
    }

    if (manifest !== null) {
      return {
        kind: "ok",
        value: {
          manifest,
          usage: extractUsage(messages),
          toolEvents,
        },
      };
    }

    const last = lastAssistantMessage(messages);
    if (last !== null) {
      const classified = classifyAssistantMessage(last, this.fastModel, last);

      if (classified.kind === "overflow") {
        return classified;
      }
    }

    const forced = await this.forceManifest(inputs, toolEvents);

    if (forced !== null) {
      return {
        kind: "ok",
        value: {
          manifest: forced.manifest,
          usage: forced.usage,
          toolEvents,
        },
      };
    }

    if (capped) {
      toolEvents.push({ type: "degraded", reason: "empty_delta" });
    }

    return {
      kind: "ok",
      value: {
        manifest: [],
        usage: zeroUsage(),
        toolEvents,
      },
    };
  }

  private async forceManifest(
    inputs: PreflightInputs,
    toolEvents: PreflightToolEvent[],
  ): Promise<{ readonly manifest: readonly ManifestEntry[]; readonly usage: Usage } | null> {
    toolEvents.push({ type: "degraded", reason: "forced_manifest" });
    let message: AssistantMessage;

    try {
      message = await this.runComplete(
        this.fastModel,
        {
          systemPrompt: inputs.systemPrompt,
          messages: [
            ...historyMessages(inputs),
            {
              role: "user",
              content: buildPreflightUserPrompt(inputs),
              timestamp: Date.now(),
            },
          ],
          tools: [
            {
              name: "emit_manifest",
              description: "Emit the final ordered document manifest and end preflight.",
              parameters: EmitManifestSchema,
            },
          ],
        },
        {
          apiKey: this.options.apiKey,
          maxRetries: 0,
          timeoutMs: this.options.preflightTimeoutMs,
          reasoningEffort: "medium",
          toolChoice: { type: "function", function: { name: "emit_manifest" } },
        },
      );
    } catch {
      toolEvents.push({ type: "degraded", reason: "empty_delta" });
      return null;
    }
    const toolCall = message.content.find(
      (content) => content.type === "toolCall" && content.name === "emit_manifest",
    );

    if (toolCall?.type !== "toolCall") {
      toolEvents.push({ type: "degraded", reason: "empty_delta" });
      return null;
    }

    const args = toolCall.arguments as Partial<EmitManifestArgs>;

    if (!Array.isArray(args.entries)) {
      toolEvents.push({ type: "degraded", reason: "empty_delta" });
      return null;
    }

    const manifest = normalizeManifest(args.entries);
    toolEvents.push({ type: "manifest", entries: manifest });

    return { manifest, usage: message.usage };
  }

  streamAnswer(input: StreamAnswerInput): AsyncIterable<AnswerStreamEvent> {
    const source = this.rawAnswerEvents(input);

    return withholdInsufficiencyPrefix(source);
  }

  private async *rawAnswerEvents(input: StreamAnswerInput): AsyncIterable<AnswerStreamEvent> {
    const stream = this.runStreamSimple(
      this.mainModel,
      {
        systemPrompt: input.systemPrompt,
        messages: toPiMessages(input.messages),
      },
      {
        apiKey: this.options.apiKey,
        maxRetries: 0,
        timeoutMs: this.options.answerTimeoutMs,
        reasoning: "medium",
      },
    );

    for await (const event of stream) {
      if (event.type === "text_delta") {
        yield { type: "text_delta", delta: event.delta };
      }
    }

    const final = await stream.result();
    const classified = classifyAssistantMessage(final, this.mainModel, final);

    if (classified.kind === "ok") {
      yield {
        type: "result",
        result: {
          kind: "ok",
          value: answerOutputFromMessage(classified.value),
        },
      };
      return;
    }

    yield { type: "result", result: classified };
  }

  async extractMemories(
    input: MemoryExtractionInput,
  ): Promise<AiCallResult<MemoryExtractionOutput>> {
    const context: Context = {
      systemPrompt:
        "Extract only durable memories supported by verbatim quotes from the user's text. Never use assistant or document content.",
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            userText: input.userText,
            existingMemories: input.existingMemories,
          }),
          timestamp: Date.now(),
        },
      ],
      tools: [
        {
          name: "record_memories",
          description: "Record memory proposals with verbatim evidence quotes.",
          parameters: RecordMemoriesSchema,
        },
      ],
    };
    const message = await this.runComplete(this.fastModel, context, {
      apiKey: this.options.apiKey,
      maxRetries: 0,
      timeoutMs: this.options.preflightTimeoutMs,
      reasoningEffort: "medium",
      toolChoice: { type: "function", function: { name: "record_memories" } },
    });
    const classified = classifyAssistantMessage(message, this.fastModel, message);

    if (classified.kind !== "ok") {
      return classified;
    }

    const toolCall = message.content.find(
      (content) => content.type === "toolCall" && content.name === "record_memories",
    );

    if (toolCall?.type !== "toolCall") {
      return {
        kind: "ok",
        value: {
          proposals: [],
          discarded: [],
          usage: message.usage,
        },
      };
    }

    const args = toolCall.arguments as Partial<RecordMemoriesArgs>;
    const proposals: ProposedMemory[] = Array.isArray(args.memories)
      ? args.memories.map((memory) => ({
          kind: toMemoryKind(memory.kind),
          content: memory.content,
          evidenceQuote: memory.evidenceQuote,
          ...(memory.targetMemoryId === undefined ? {} : { targetMemoryId: memory.targetMemoryId }),
        }))
      : [];
    const verified = verifyMemoryProposals(
      proposals,
      input.userText,
      input.existingMemories,
      this.options.memoryMaxWritesPerTurn,
    );

    return {
      kind: "ok",
      value: {
        proposals: verified.accepted,
        discarded: verified.discarded,
        usage: message.usage,
      },
    };
  }
}
