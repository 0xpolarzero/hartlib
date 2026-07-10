import { PgClient } from "@effect/sql-pg";
import { DEFAULT_MARKET_FOR_LOCALE, isLocale, isMarket } from "@brief/shared";
import { Config, Effect, Layer, Redacted } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { loadApiConfig } from "../config";
import { resolveDemoUserId } from "../demo-user";
import { corsHeaders, json, type Route } from "../http";
import { JsonLoggerLayer, serviceLogFields } from "../logging";

const maxMessageTextLength = 12_000;
export const maxSendMessageBodyBytes = 64 * 1024;
type PgLayer = Layer.Layer<PgClient.PgClient | SqlClient, Config.ConfigError | SqlError, never>;

export interface ChatRow {
  readonly id: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface MessageRow {
  readonly id: string;
  readonly author: "user" | "assistant";
  readonly content: string;
  readonly ai_run_id: string | null;
  readonly created_at: Date;
}

export interface ActiveRunRow {
  readonly id: string;
}

export interface ActiveRunContextRow {
  readonly id: string;
  readonly chat_id: string;
}

export interface RunStreamContext {
  readonly runId: string;
  readonly chatId: string;
}

export interface ContextBlockRow {
  readonly block_id: string;
  readonly kind: "document" | "memory";
  readonly token_estimate: number;
  readonly provenance: unknown;
}

export interface ObservationRow {
  readonly id: string;
  readonly run_id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly created_at: Date;
}

export interface ChatMessageResponse {
  readonly id: string;
  readonly author: "user" | "assistant";
  readonly content: string;
  readonly createdAt: string;
  readonly citations?: readonly CitationResponse[];
  readonly contextBlocks?: readonly ContextBlockResponse[];
}

export interface CitationResponse {
  readonly blockId: string;
  readonly kind: "document" | "memory";
  readonly label: string | null;
  readonly sourceDisplayName: string | null;
  readonly title: string | null;
  readonly canonicalUrl: string | null;
  readonly publishedAt: string | null;
}

export interface ContextBlockResponse {
  readonly blockId: string;
  readonly kind: "document" | "memory";
  readonly label: string | null;
  readonly tokenEstimate: number;
}

const PgLayer = PgClient.layerConfig({
  url: Config.string("DATABASE_URL").pipe(
    Config.withDefault("postgres://brief:brief@localhost:5432/brief"),
    Config.map(Redacted.make),
  ),
  applicationName: Config.succeed("brief-api"),
});

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const stringField = (record: Record<string, unknown>, field: string): string | null =>
  typeof record[field] === "string" ? record[field] : null;

const blockIdNumber = (blockId: string): number | null => {
  const match = /^b(\d+)$/.exec(blockId);
  if (match === null) return null;
  return Number(match[1]);
};

const compareBlockIds = (left: string, right: string): number => {
  const leftNumber = blockIdNumber(left);
  const rightNumber = blockIdNumber(right);
  if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return left.localeCompare(right);
};

const blockLabel = (block: ContextBlockRow): string => {
  if (block.kind === "memory") return block.block_id;
  const provenance = asRecord(block.provenance);
  const source = stringField(provenance, "sourceDisplayName") ?? "source";
  const title = stringField(provenance, "title") ?? block.block_id;
  return `${source}: ${title}`;
};

const citationFromBlock = (block: ContextBlockRow): CitationResponse => {
  if (block.kind === "memory") {
    return {
      blockId: block.block_id,
      kind: "memory",
      label: null,
      sourceDisplayName: null,
      title: null,
      canonicalUrl: null,
      publishedAt: null,
    };
  }

  const provenance = asRecord(block.provenance);
  return {
    blockId: block.block_id,
    kind: "document",
    label: stringField(provenance, "sourceDisplayName") ?? block.block_id,
    sourceDisplayName: stringField(provenance, "sourceDisplayName"),
    title: stringField(provenance, "title"),
    canonicalUrl: stringField(provenance, "canonicalUrl"),
    publishedAt: stringField(provenance, "publishedAt"),
  };
};

const contextBlockFromRow = (block: ContextBlockRow): ContextBlockResponse => ({
  blockId: block.block_id,
  kind: block.kind,
  label: block.kind === "memory" ? null : blockLabel(block),
  tokenEstimate: block.token_estimate,
});

export const chatMessagesResponseFromRows = (
  messages: readonly MessageRow[],
  contextBlocks: readonly ContextBlockRow[],
  observations: readonly ObservationRow[],
): readonly ChatMessageResponse[] => {
  const blocksById = new Map(contextBlocks.map((block) => [block.block_id, block]));
  const observationsByRun = new Map<string, ObservationRow[]>();

  for (const observation of observations) {
    const rows = observationsByRun.get(observation.run_id) ?? [];
    rows.push(observation);
    observationsByRun.set(observation.run_id, rows);
  }

  return [...messages]
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id))
    .map((message) => {
      if (message.author !== "assistant" || message.ai_run_id === null) {
        return {
          id: message.id,
          author: message.author,
          content: message.content,
          createdAt: message.created_at.toISOString(),
        };
      }

      const runObservations = observationsByRun.get(message.ai_run_id) ?? [];
      const citations = runObservations
        .filter((observation) => observation.kind === "citation")
        .map((observation) => {
          const blockId = stringField(asRecord(observation.payload), "blockId");
          return blockId === null ? undefined : blocksById.get(blockId);
        })
        .filter((block): block is ContextBlockRow => block !== undefined)
        .map(citationFromBlock);
      const contextBlocksForMessage = runObservations
        .filter((observation) => observation.kind === "context_window")
        .at(-1);
      const contextWindowPayload = asRecord(contextBlocksForMessage?.payload);
      const contextWindowBlockIds: readonly unknown[] = Array.isArray(contextWindowPayload.blockIds)
        ? contextWindowPayload.blockIds
        : [];
      const contextBlocksFromWindow = contextWindowBlockIds
        .filter((blockId): blockId is string => typeof blockId === "string")
        .map((blockId) => blocksById.get(blockId))
        .filter((block): block is ContextBlockRow => block !== undefined)
        .map(contextBlockFromRow)
        .sort((a, b) => compareBlockIds(a.blockId, b.blockId));

      return {
        id: message.id,
        author: message.author,
        content: message.content,
        createdAt: message.created_at.toISOString(),
        citations,
        contextBlocks: contextBlocksFromWindow,
      };
    });
};

const ensureDemoChat = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const inserted = yield* sql<ChatRow>`
      insert into chats (user_id)
      values (${userId})
      on conflict (user_id) do nothing
      returning id::text, created_at, updated_at
    `;
    if (inserted[0] !== undefined) return inserted[0];

    const existing = yield* sql<ChatRow>`
      select id::text, created_at, updated_at
      from chats
      where user_id = ${userId}
      limit 1
    `;
    return existing[0]!;
  });

const readChat = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const chat = yield* ensureDemoChat(userId);
    const messages = yield* sql<MessageRow>`
      select id::text, author, content, ai_run_id::text, created_at
      from chat_messages
      where chat_id = ${chat.id}
      order by created_at asc, id asc
    `;
    const activeRuns = yield* sql<ActiveRunRow>`
      select id::text
      from ai_runs
      where chat_id = ${chat.id}
        and finished_at is null
        and failed_at is null
      order by created_at asc
      limit 1
    `;
    const blocks = yield* sql<ContextBlockRow>`
      select block_id, kind, token_estimate, provenance
      from chat_context_blocks
      where chat_id = ${chat.id}
    `;
    const observations = yield* sql<ObservationRow>`
      select id::text, run_id::text, kind, payload, created_at
      from ai_observations
      where chat_id = ${chat.id}
        and kind in ('citation', 'context_window')
      order by created_at asc, id asc
    `;

    return {
      chat: {
        createdAt: chat.created_at.toISOString(),
        updatedAt: chat.updated_at.toISOString(),
      },
      messages: chatMessagesResponseFromRows(messages, blocks, observations),
      activeRunId: activeRuns[0]?.id ?? null,
    };
  });

export const parseSendMessageBody = (body: unknown) => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false as const, error: "invalid_body" };
  }

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "locale" ||
    keys[1] !== "market" ||
    keys[2] !== "text" ||
    typeof record.text !== "string" ||
    typeof record.locale !== "string" ||
    typeof record.market !== "string"
  ) {
    return { ok: false as const, error: "invalid_body" };
  }

  const text = record.text.trim();
  const locale = record.locale;
  const market = record.market;

  if (text.length === 0 || text.length > maxMessageTextLength) {
    return { ok: false as const, error: "invalid_body" };
  }

  if (!isLocale(locale) || !isMarket(market) || DEFAULT_MARKET_FOR_LOCALE[locale] !== market) {
    return { ok: false as const, error: "invalid_locale_market" };
  }

  return { ok: true as const, text, locale, market };
};

class RequestBodyTooLarge extends Error {
  constructor() {
    super("request_body_too_large");
  }
}

const contentLengthExceedsLimit = (request: Request, maxBytes: number): boolean => {
  const value = request.headers.get("content-length");
  if (value === null) return false;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > maxBytes;
};

export const requestJsonWithLimit = (request: Request, maxBytes = maxSendMessageBodyBytes) =>
  Effect.tryPromise({
    try: async () => {
      if (contentLengthExceedsLimit(request, maxBytes)) {
        throw new RequestBodyTooLarge();
      }

      if (request.body === null) {
        return JSON.parse("");
      }

      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          void reader.cancel().catch(() => undefined);
          throw new RequestBodyTooLarge();
        }
        chunks.push(value);
      }

      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return JSON.parse(new TextDecoder().decode(body));
    },
    catch: (error) => error,
  });

const isUniqueViolation = (error: unknown): boolean => {
  const record = asRecord(error);
  const cause = asRecord(record.cause);
  return (
    record.code === "23505" ||
    cause.code === "23505" ||
    String(record.message ?? "").includes("unique") ||
    String(cause.message ?? "").includes("unique")
  );
};

const activeRunConflict = json({ error: "run_active" }, { status: 409 });

const logChatInfo = (message: string, fields: Record<string, unknown>) =>
  Effect.logInfo(message).pipe(Effect.annotateLogs({ component: "ai_chat", ...fields }));

const runStreamLogInfo = (message: string, fields: Record<string, unknown>): void => {
  void Effect.runPromise(
    logChatInfo(message, fields).pipe(
      Effect.provide(JsonLoggerLayer),
      Effect.annotateLogs(serviceLogFields),
    ),
  ).catch(() => undefined);
};

const activeRunConflictResponse = (
  fields: Record<string, unknown>,
): Effect.Effect<Response, never> =>
  logChatInfo("ai chat message rejected because run is active", {
    route: "POST /v1/chat/messages",
    status: "conflict",
    ...fields,
  }).pipe(Effect.as(activeRunConflict));

const findActiveRunForUser = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<ActiveRunContextRow>`
      select r.id::text, c.id::text as chat_id
      from chats c
      join ai_runs r on r.chat_id = c.id
      where c.user_id = ${userId}
        and r.finished_at is null
        and r.failed_at is null
      order by r.created_at asc
      limit 1
    `;
    return rows[0] ?? null;
  });

const createUserMessageAndRun = (
  userId: string,
  input: { readonly text: string; readonly locale: string; readonly market: string },
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`select pg_advisory_xact_lock(hashtext(${`brief:demo-chat:${userId}`}))`;
        const chat = yield* ensureDemoChat(userId);
        const activeRuns = yield* sql<ActiveRunRow>`
          select id::text
          from ai_runs
          where chat_id = ${chat.id}
            and finished_at is null
            and failed_at is null
          limit 1
        `;
        if (activeRuns[0] !== undefined) {
          return {
            conflict: true as const,
            chatId: chat.id,
            runId: activeRuns[0].id,
          };
        }

        const messageRows = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${chat.id}, 'user', ${input.text})
          returning id::text
        `;
        const messageId = messageRows[0]!.id;
        const runRows = yield* sql<{ readonly id: string }>`
          insert into ai_runs (chat_id, user_message_id, locale, market)
          values (${chat.id}, ${messageId}, ${input.locale}, ${input.market})
          returning id::text
        `;
        const runId = runRows[0]!.id;
        yield* sql`
          insert into jobs (kind, payload, unique_key, priority)
          values (
            'ai_chat_run',
            ${sql.json({ aiRunId: runId })},
            ${`ai_chat_run:${runId}`},
            100
          )
          on conflict (unique_key) where unique_key is not null do nothing
        `;

        return { conflict: false as const, chatId: chat.id, messageId, runId };
      }),
    );
  });

const sendMessage = (
  request: Request,
  input: { readonly text: string; readonly locale: string; readonly market: string },
) =>
  Effect.gen(function* () {
    const userId = yield* resolveDemoUserId(request);
    const active = yield* findActiveRunForUser(userId);
    if (active !== null) {
      return yield* activeRunConflictResponse({
        userId,
        chatId: active.chat_id,
        runId: active.id,
      });
    }

    const result = yield* createUserMessageAndRun(userId, input).pipe(
      Effect.catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          return Effect.succeed({
            conflict: true as const,
            chatId: null,
            runId: null,
            conflictSource: "unique_violation",
          });
        }
        return Effect.fail(error);
      }),
    );
    if (result.conflict) {
      return yield* activeRunConflictResponse({
        userId,
        chatId: result.chatId,
        runId: result.runId,
        conflictSource: "conflictSource" in result ? result.conflictSource : "active_run",
      });
    }
    yield* logChatInfo("ai chat message accepted and enqueued", {
      route: "POST /v1/chat/messages",
      status: "enqueued",
      userId,
      chatId: result.chatId,
      messageId: result.messageId,
      runId: result.runId,
    });
    return json({ messageId: result.messageId, runId: result.runId });
  });

export type AiRunEventRow = {
  readonly seq: number;
  readonly event: Record<string, unknown>;
};

export type AiRunEventPoller = (
  runId: string,
  afterSeq: number,
  pgLayer: PgLayer,
) => Promise<readonly AiRunEventRow[]>;

const eventType = (event: Record<string, unknown>): string =>
  typeof event.type === "string" ? event.type : "message";

const sseHeaders = (): Headers => {
  const headers = corsHeaders();
  headers.set("cache-control", "no-cache");
  headers.set("connection", "keep-alive");
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("x-accel-buffering", "no");
  return headers;
};

const encodeSseEvent = (row: AiRunEventRow): string =>
  `id: ${row.seq}\nevent: ${eventType(row.event)}\ndata: ${JSON.stringify(row.event)}\n\n`;

const parseSeq = (value: string | null): number => {
  if (value === null) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const readAiRunEventsAfter = (runId: string, afterSeq: number, pgLayer: PgLayer) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      return yield* sql<AiRunEventRow>`
        select seq, event
        from ai_run_events
        where run_id = ${runId}
          and seq > ${afterSeq}
        order by seq asc
      `;
    }).pipe(Effect.provide(pgLayer)),
  );

const incrementalSse = (args: {
  readonly request: Request;
  readonly runId: string;
  readonly chatId: string;
  readonly userId: string;
  readonly afterSeq: number;
  readonly pollMs: number;
  readonly keepAliveMs: number;
  readonly pgLayer: PgLayer;
  readonly readAiRunEventsAfter: AiRunEventPoller;
}) => {
  const encoder = new TextEncoder();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let closeStream: (
    mode?: "close" | "error" | "silent",
    error?: unknown,
    status?: "closed" | "aborted" | "cancelled" | "error",
  ) => void = () => {
    closed = true;
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };

  const markClosed = () => {
    closed = true;
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let afterSeq = args.afterSeq;
        let lastWrite = Date.now();

        const baseFields = {
          route: "GET /v1/ai-runs/:runId/stream",
          userId: args.userId,
          chatId: args.chatId,
          runId: args.runId,
        } as const;

        runStreamLogInfo("ai chat stream opened", {
          ...baseFields,
          status: args.afterSeq > 0 ? "replayed" : "opened",
          afterSeq: args.afterSeq,
        });

        const onAbort = () => closeStream("close", undefined, "aborted");
        closeStream = (mode = "close", error?: unknown, status = "closed") => {
          if (closed) return;
          markClosed();
          args.request.signal.removeEventListener("abort", onAbort);

          if (status === "error") {
            runStreamLogInfo("ai chat stream error", {
              ...baseFields,
              status,
              afterSeq,
              error: error instanceof Error ? error.message : String(error),
            });
          } else if (status !== "closed" || mode !== "silent") {
            runStreamLogInfo("ai chat stream closed", {
              ...baseFields,
              status,
              afterSeq,
            });
          }

          if (mode === "silent") return;

          try {
            if (mode === "error") {
              controller.error(error);
            } else {
              controller.close();
            }
          } catch {
            // Closing can race with reader cancellation; cleanup must stay idempotent.
          }
        };

        const write = (text: string) => {
          if (closed) return;
          controller.enqueue(encoder.encode(text));
          lastWrite = Date.now();
        };

        const tick = async () => {
          if (closed || args.request.signal.aborted) {
            closeStream("close");
            return;
          }

          try {
            const rows = await args.readAiRunEventsAfter(args.runId, afterSeq, args.pgLayer);
            if (closed || args.request.signal.aborted) {
              closeStream("close");
              return;
            }

            for (const row of rows) {
              if (closed || args.request.signal.aborted) {
                closeStream("close");
                return;
              }
              write(encodeSseEvent(row));
              afterSeq = row.seq;
              const type = eventType(row.event);
              runStreamLogInfo("ai chat stream event forwarded", {
                ...baseFields,
                status: "forwarded",
                eventType: type,
                seq: row.seq,
              });
              if (type === "done" || type === "error") {
                runStreamLogInfo("ai chat stream terminal event", {
                  ...baseFields,
                  status: "terminal",
                  eventType: type,
                  seq: row.seq,
                });
                closeStream("close");
                return;
              }
            }

            if (closed || args.request.signal.aborted) {
              closeStream("close");
              return;
            }

            if (Date.now() - lastWrite >= args.keepAliveMs) {
              write(": keep-alive\n\n");
            }

            if (closed || args.request.signal.aborted) {
              closeStream("close");
              return;
            }

            timeout = setTimeout(tick, args.pollMs);
          } catch (error) {
            if (closed || args.request.signal.aborted) {
              closeStream("close");
              return;
            }
            closeStream("error", error, "error");
          }
        };

        args.request.signal.addEventListener("abort", onAbort, { once: true });

        void tick();
      },
      cancel() {
        closeStream("silent", undefined, "cancelled");
      },
    }),
    { headers: sseHeaders() },
  );
};

const readRunStreamContext = (runId: string, userId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<RunStreamContext>`
      select r.id::text as "runId", c.id::text as "chatId"
      from ai_runs r
      join chats c on c.id = r.chat_id
      where r.id = ${runId}
        and c.user_id = ${userId}
      limit 1
    `;
    return rows[0] ?? null;
  });

const readRunId = (url: URL): string =>
  decodeURIComponent(/^\/v1\/ai-runs\/([^/]+)\/stream\/?$/.exec(url.pathname)?.[1] ?? "");

export const makeChatRoutes = (
  pgLayer: PgLayer = PgLayer,
  options?: {
    readonly readAiRunEventsAfter?: AiRunEventPoller;
  },
): readonly Route[] => [
  {
    method: "GET",
    pattern: /^\/v1\/chat\/?$/,
    handle: (request) =>
      Effect.gen(function* () {
        const userId = yield* resolveDemoUserId(request);
        return yield* readChat(userId).pipe(Effect.provide(pgLayer), Effect.map(json));
      }),
  },
  {
    method: "POST",
    pattern: /^\/v1\/chat\/messages\/?$/,
    handle: (request) =>
      Effect.gen(function* () {
        const bodyResult = yield* requestJsonWithLimit(request).pipe(
          Effect.map((body) => ({ ok: true as const, body })),
          Effect.catch((error: unknown) =>
            Effect.succeed(
              error instanceof RequestBodyTooLarge
                ? ({ ok: false as const, status: 413, error: "request_too_large" } as const)
                : ({ ok: false as const, status: 400, error: "invalid_json" } as const),
            ),
          ),
        );
        if (!bodyResult.ok) {
          return json({ error: bodyResult.error }, { status: bodyResult.status });
        }

        const parsed = parseSendMessageBody(bodyResult.body);
        if (!parsed.ok) return json({ error: parsed.error }, { status: 400 });

        return yield* sendMessage(request, parsed).pipe(Effect.provide(pgLayer));
      }),
  },
  {
    method: "GET",
    pattern: /^\/v1\/ai-runs\/[^/]+\/stream\/?$/,
    handle: (request, url) =>
      Effect.gen(function* () {
        const runId = readRunId(url);
        const userId = yield* resolveDemoUserId(request);
        const streamContext = yield* readRunStreamContext(runId, userId).pipe(
          Effect.provide(pgLayer),
        );
        if (streamContext === null) return json({ error: "not_found" }, { status: 404 });

        const config = yield* loadApiConfig;
        const headerSeq = parseSeq(request.headers.get("last-event-id"));
        const querySeq = parseSeq(url.searchParams.get("afterSeq"));
        return incrementalSse({
          request,
          runId,
          chatId: streamContext.chatId,
          userId,
          afterSeq: Math.max(headerSeq, querySeq),
          pollMs: config.aiStreamPollMs,
          keepAliveMs: config.aiStreamKeepAliveMs,
          pgLayer,
          readAiRunEventsAfter: options?.readAiRunEventsAfter ?? readAiRunEventsAfter,
        });
      }),
  },
];

export const chatRoutes = makeChatRoutes();
