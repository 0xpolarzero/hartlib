import { PgClient } from "@effect/sql-pg";
import { DEFAULT_MARKET_FOR_LOCALE, isLocale, isMarket } from "@brief/shared";
import { Config, Effect, Layer, Redacted } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { loadApiConfig } from "../config";
import { resolveDemoUserId } from "../demo-user";
import { corsHeaders, json, type Route } from "../http";

const maxMessageTextLength = 12_000;
const memoryCitationLabel = "saved-memory";

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

export interface ContextBlockRow {
  readonly block_id: string;
  readonly kind: "document" | "memory";
  readonly token_estimate: number;
  readonly provenance: unknown;
}

export interface ObservationRow {
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
  readonly label: string;
  readonly title: string | null;
  readonly url: string | null;
  readonly publishedAt: string | null;
}

export interface ContextBlockResponse {
  readonly blockId: string;
  readonly kind: "document" | "memory";
  readonly label: string;
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

const blockLabel = (block: ContextBlockRow): string => {
  if (block.kind === "memory") return "saved user memories";
  const provenance = asRecord(block.provenance);
  const source = stringField(provenance, "sourceDisplayName") ?? "source";
  const title = stringField(provenance, "title") ?? block.block_id;
  return `${source}: ${title}`;
};

const citationFromBlock = (block: ContextBlockRow): CitationResponse => {
  if (block.kind === "memory") {
    return {
      blockId: block.block_id,
      label: memoryCitationLabel,
      title: "Saved memory",
      url: null,
      publishedAt: null,
    };
  }

  const provenance = asRecord(block.provenance);
  return {
    blockId: block.block_id,
    label: stringField(provenance, "sourceDisplayName") ?? block.block_id,
    title: stringField(provenance, "title"),
    url: stringField(provenance, "canonicalUrl"),
    publishedAt: stringField(provenance, "publishedAt"),
  };
};

const contextBlockFromObservation = (
  observation: ObservationRow,
  blocksById: ReadonlyMap<string, ContextBlockRow>,
): ContextBlockResponse | null => {
  const payload = asRecord(observation.payload);
  const blockId = stringField(payload, "blockId");
  if (blockId === null) return null;
  const block = blocksById.get(blockId);
  if (block === undefined) return null;
  return {
    blockId,
    kind: block.kind,
    label: stringField(payload, "label") ?? blockLabel(block),
    tokenEstimate:
      typeof payload.tokenEstimate === "number" ? payload.tokenEstimate : block.token_estimate,
  };
};

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
        .filter((observation) => observation.kind === "context_block_added")
        .map((observation) => contextBlockFromObservation(observation, blocksById))
        .filter((block): block is ContextBlockResponse => block !== null);

      return {
        id: message.id,
        author: message.author,
        content: message.content,
        createdAt: message.created_at.toISOString(),
        citations,
        contextBlocks: contextBlocksForMessage,
      };
    });
};

const ensureDemoChat = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const existing = yield* sql<ChatRow>`
      select id::text, created_at, updated_at
      from chats
      where user_id = ${userId}
      order by created_at asc, id asc
      limit 1
    `;

    if (existing[0] !== undefined) return existing[0];

    const inserted = yield* sql<ChatRow>`
      insert into chats (user_id)
      values (${userId})
      returning id::text, created_at, updated_at
    `;
    return inserted[0]!;
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
      select run_id::text, kind, payload, created_at
      from ai_observations
      where chat_id = ${chat.id}
        and kind in ('citation', 'context_block_added')
      order by created_at asc, id asc
    `;

    return {
      chat: {
        id: chat.id,
        createdAt: chat.created_at.toISOString(),
        updatedAt: chat.updated_at.toISOString(),
      },
      messages: chatMessagesResponseFromRows(messages, blocks, observations),
      activeRunId: activeRuns[0]?.id ?? null,
    };
  });

const parseSendMessageBody = (body: unknown) => {
  const record = asRecord(body);
  const text = typeof record.text === "string" ? record.text.trim() : "";
  const locale = typeof record.locale === "string" ? record.locale : "";
  const market = typeof record.market === "string" ? record.market : "";

  if (text.length === 0 || text.length > maxMessageTextLength) {
    return { ok: false as const, error: "invalid_body" };
  }

  if (!isLocale(locale) || !isMarket(market) || DEFAULT_MARKET_FOR_LOCALE[locale] !== market) {
    return { ok: false as const, error: "invalid_locale_market" };
  }

  return { ok: true as const, text, locale, market };
};

const requestJson = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => new Error("invalid_json"),
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

const userHasActiveRun = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly exists: boolean }>`
      select exists(
        select 1
        from chats c
        join ai_runs r on r.chat_id = c.id
        where c.user_id = ${userId}
          and r.finished_at is null
          and r.failed_at is null
      ) as exists
    `;
    return rows[0]?.exists === true;
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
        if (activeRuns[0] !== undefined) return { conflict: true as const };

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
          insert into jobs (kind, payload, unique_key)
          values (
            'ai_chat_run',
            ${sql.json({ aiRunId: runId })},
            ${`ai_chat_run:${runId}`}
          )
          on conflict (unique_key) where unique_key is not null do nothing
        `;

        return { conflict: false as const, messageId, runId };
      }),
    );
  });

const sendMessage = (
  request: Request,
  input: { readonly text: string; readonly locale: string; readonly market: string },
) =>
  Effect.gen(function* () {
    const userId = yield* resolveDemoUserId(request);
    const active = yield* userHasActiveRun(userId);
    if (active) return activeRunConflict;

    const result = yield* createUserMessageAndRun(userId, input);
    if (result.conflict) return activeRunConflict;
    return json({ messageId: result.messageId, runId: result.runId });
  }).pipe(
    Effect.catch((error: unknown) => {
      if (isUniqueViolation(error)) return Effect.succeed(activeRunConflict);
      return Effect.fail(error);
    }),
  );

type AiRunEventRow = {
  readonly seq: number;
  readonly event: Record<string, unknown>;
};

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
  readonly afterSeq: number;
  readonly pollMs: number;
  readonly keepAliveMs: number;
  readonly pgLayer: PgLayer;
}) => {
  const encoder = new TextEncoder();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const clear = () => {
    closed = true;
    if (timeout !== undefined) clearTimeout(timeout);
  };

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let afterSeq = args.afterSeq;
        let lastWrite = Date.now();

        const write = (text: string) => {
          if (closed) return;
          controller.enqueue(encoder.encode(text));
          lastWrite = Date.now();
        };

        const tick = async () => {
          if (closed || args.request.signal.aborted) {
            clear();
            controller.close();
            return;
          }

          try {
            const rows = await readAiRunEventsAfter(args.runId, afterSeq, args.pgLayer);
            for (const row of rows) {
              write(encodeSseEvent(row));
              afterSeq = row.seq;
              const type = eventType(row.event);
              if (type === "done" || type === "error") {
                clear();
                controller.close();
                return;
              }
            }

            if (Date.now() - lastWrite >= args.keepAliveMs) {
              write(": keep-alive\n\n");
            }

            timeout = setTimeout(tick, args.pollMs);
          } catch (error) {
            controller.error(error);
            clear();
          }
        };

        args.request.signal.addEventListener(
          "abort",
          () => {
            clear();
            controller.close();
          },
          { once: true },
        );

        void tick();
      },
      cancel() {
        clear();
      },
    }),
    { headers: sseHeaders() },
  );
};

const runBelongsToUser = (runId: string, userId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly exists: boolean }>`
      select exists(
        select 1
        from ai_runs r
        join chats c on c.id = r.chat_id
        where r.id = ${runId}
          and c.user_id = ${userId}
      ) as exists
    `;
    return rows[0]?.exists === true;
  });

const readRunId = (url: URL): string =>
  decodeURIComponent(/^\/v1\/ai-runs\/([^/]+)\/stream\/?$/.exec(url.pathname)?.[1] ?? "");

export const makeChatRoutes = (pgLayer: PgLayer = PgLayer): readonly Route[] => [
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
        const body = yield* requestJson(request).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
        const parsed = parseSendMessageBody(body);
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
        const belongs = yield* runBelongsToUser(runId, userId).pipe(Effect.provide(pgLayer));
        if (!belongs) return json({ error: "not_found" }, { status: 404 });

        const config = yield* loadApiConfig;
        const headerSeq = parseSeq(request.headers.get("last-event-id"));
        const querySeq = parseSeq(url.searchParams.get("afterSeq"));
        return incrementalSse({
          request,
          runId,
          afterSeq: Math.max(headerSeq, querySeq),
          pollMs: config.aiStreamPollMs,
          keepAliveMs: config.aiStreamKeepAliveMs,
          pgLayer,
        });
      }),
  },
];

export const chatRoutes = makeChatRoutes();
