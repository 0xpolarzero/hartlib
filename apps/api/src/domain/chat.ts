import {
  createUserMessageAndRun,
  effectiveWebPolicy,
  loadChatRuntimeState,
  normalizeDomainAllowlist,
  readAuthorizedAiRunEventsAfter as readAuthorizedAiRunEventsAfterFromDomain,
  readAuthorizedAiRunDebug,
  readRunStreamContext,
  type AiRunEventRow,
  type AuthorizedAiRunEventPoll,
  type RunStreamContext,
} from "@hartlib/backend-domain/chat-runtime";
import {
  deleteVisibleChatMessage,
  editLastUserMessage,
  requestAiRunStop,
} from "@hartlib/backend-domain/chat-mutations";
import { hasActiveDemoSession } from "@hartlib/backend-domain/demo-sessions";
import { chatMessagesResponseFromRows, runDescriptor } from "@hartlib/backend-domain/chat-response";
import {
  AiRunEvent,
  AiRunStopResponse,
  GetChatResponse,
  PublicAiRunDebugResponse,
  SendChatMessageAccepted,
  SendChatMessageRequest,
  type ActiveAiRunConflict,
} from "@hartlib/shared";
import { Effect, Schema } from "effect";

import { resolveRequestIdentity, type RequestIdentity } from "../auth";
import { loadApiConfig, type ApiConfig } from "../config";
import { ApiDatabaseLayer, type ApiDatabaseLayer as ApiDatabaseLayerType } from "../database";
import { corsHeaders, json, jsonFromSchema, type Route } from "../http";

export { chatMessagesResponseFromRows, effectiveWebPolicy, normalizeDomainAllowlist };
export type { AiRunEventRow, RunStreamContext };

export type AiRunEventPoller = (
  userId: string,
  runId: string,
  afterSeq: number,
  databaseLayer: ApiDatabaseLayerType,
  signal?: AbortSignal,
) => Promise<AuthorizedAiRunEventPoll>;

export type ActiveDemoSessionChecker = (
  userId: string,
  databaseLayer: ApiDatabaseLayerType,
  signal?: AbortSignal,
) => Promise<boolean>;

const active = (run: {
  readonly finished_at: Date | null;
  readonly failed_at: Date | null;
  readonly stopped_at: Date | null;
  readonly superseded_at: Date | null;
}) =>
  run.finished_at === null &&
  run.failed_at === null &&
  run.stopped_at === null &&
  run.superseded_at === null;

export const readChat = (
  identity: RequestIdentity,
  config: ApiConfig,
  databaseLayer: ApiDatabaseLayerType,
) =>
  loadChatRuntimeState(identity, config).pipe(
    Effect.provide(databaseLayer),
    Effect.flatMap((loaded) => {
      const current = loaded.runs.find(active) ?? null;
      return Effect.try({
        try: () =>
          ({
            chat: {
              id: loaded.chat.id,
              memoryMode: loaded.chat.memory_mode,
              createdAt: loaded.chat.created_at.toISOString(),
              updatedAt: loaded.chat.updated_at.toISOString(),
            },
            messages: chatMessagesResponseFromRows(
              loaded.messages,
              loaded.runs,
              loaded.sourceRows,
              loaded.useRows,
            ),
            effectiveWebPolicy: loaded.effectivePolicy,
            activeRun: current === null ? null : runDescriptor(current),
            canWrite: loaded.chat.user_id === identity.userId,
          }) satisfies GetChatResponse,
        catch: () => new Error("chat_projection_invalid"),
      });
    }),
  );

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const isUniqueViolation = (error: unknown): boolean => {
  const record = asRecord(error);
  const cause = asRecord(record.cause);
  return record.code === "23505" || cause.code === "23505";
};

const activeRunConflict = (run: {
  readonly id: string;
  readonly started_at: Date | null;
}): Response =>
  json(
    {
      code: "active_ai_run",
      conflictScope: "chat",
      activeRun: runDescriptor(run),
    } satisfies ActiveAiRunConflict,
    { status: 409 },
  );

const authenticateDemo = (
  request: Request,
  config: ApiConfig,
  databaseLayer: ApiDatabaseLayerType,
) => resolveRequestIdentity(request, config, { databaseLayer });

const sendMessage = (
  request: Request,
  input: Schema.Schema.Type<typeof SendChatMessageRequest>,
  config: ApiConfig,
  databaseLayer: ApiDatabaseLayerType,
) =>
  Effect.gen(function* () {
    const authentication = yield* authenticateDemo(request, config, databaseLayer);
    if (!authentication.authenticated) return json({ error: "unauthorized" }, { status: 401 });
    const result = yield* createUserMessageAndRun(
      authentication.identity.userId,
      input,
      config,
    ).pipe(
      Effect.provide(databaseLayer),
      Effect.catch((error) => {
        if (!isUniqueViolation(error)) return Effect.fail(error);
        return loadChatRuntimeState(authentication.identity, config).pipe(
          Effect.provide(databaseLayer),
          Effect.flatMap((loaded) => {
            const run = loaded.runs.find(active);
            return run === undefined
              ? Effect.fail(error)
              : Effect.succeed({
                  kind: "conflict",
                  active: run,
                  chat: { id: loaded.chat.id },
                } as const);
          }),
        );
      }),
    );
    if (result.kind === "forbidden") return json({ error: "forbidden" }, { status: 403 });
    if (result.kind === "web_unavailable")
      return json(
        { code: "web_research_unavailable", reason: result.policy.reason },
        { status: 403 },
      );
    if (result.kind === "conflict") return activeRunConflict(result.active);
    return jsonFromSchema(
      SendChatMessageAccepted,
      {
        message: {
          id: result.message.id,
          author: "user",
          content: input.text,
          createdAt: result.message.created_at.toISOString(),
        },
        run: {
          id: result.runId,
          status: "queued",
          streamPath: `/v1/ai-runs/${encodeURIComponent(result.runId)}/stream`,
        },
      },
      { status: 202 },
    );
  });

const decodeAiRunEvent = Schema.decodeUnknownSync(AiRunEvent, { onExcessProperty: "error" });
const sseHeaders = (): Headers => {
  const headers = corsHeaders();
  headers.set("cache-control", "no-cache");
  headers.set("connection", "keep-alive");
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("x-accel-buffering", "no");
  return headers;
};
const encodeSseEvent = (row: AiRunEventRow): string => {
  const event = decodeAiRunEvent(row.event);
  return `id: ${row.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
};
const parseSeq = (value: string | undefined): number => {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error("invalid_sse_sequence");
  return parsed;
};

const readAuthorizedAiRunEventsAfter: AiRunEventPoller = (
  userId,
  runId,
  afterSeq,
  databaseLayer,
  signal,
) =>
  Effect.runPromise(
    readAuthorizedAiRunEventsAfterFromDomain(userId, runId, afterSeq).pipe(
      Effect.provide(databaseLayer),
    ),
    { signal },
  );

const checkActiveDemoSession: ActiveDemoSessionChecker = (userId, databaseLayer, signal) =>
  Effect.runPromise(hasActiveDemoSession(userId).pipe(Effect.provide(databaseLayer)), { signal });

export const incrementalSse = (args: {
  readonly request: Request;
  readonly runId: string;
  readonly userId: string;
  readonly afterSeq: number;
  readonly pollMs: number;
  readonly keepAliveMs: number;
  readonly databaseLayer: ApiDatabaseLayerType;
  readonly readAuthorizedAiRunEventsAfter: AiRunEventPoller;
  readonly isSessionActive: ActiveDemoSessionChecker;
}) => {
  const encoder = new TextEncoder();
  const streamAbort = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let afterSeq = args.afterSeq;
        let lastWrite = performance.now();
        const close = () => {
          if (closed) return;
          closed = true;
          if (timeout !== undefined) clearTimeout(timeout);
          args.request.signal.removeEventListener("abort", onAbort);
          try {
            controller.close();
          } catch {
            /* terminal close can race cancellation */
          }
        };
        const onAbort = () => {
          streamAbort.abort(args.request.signal.reason);
          close();
        };
        const write = (value: string) => {
          if (!closed) {
            controller.enqueue(encoder.encode(value));
            lastWrite = performance.now();
          }
        };
        const tick = async (): Promise<void> => {
          if (closed || args.request.signal.aborted) return close();
          try {
            if (
              !(await args.isSessionActive(args.userId, args.databaseLayer, streamAbort.signal))
            ) {
              return close();
            }
            const poll = await args.readAuthorizedAiRunEventsAfter(
              args.userId,
              args.runId,
              afterSeq,
              args.databaseLayer,
              streamAbort.signal,
            );
            if (!poll.authorized) return close();
            if (poll.terminal && !poll.replayableTerminal && poll.events.length === 0)
              return close();
            for (const row of poll.events) {
              if (closed) return;
              write(encodeSseEvent(row));
              afterSeq = row.seq;
              const type = decodeAiRunEvent(row.event).type;
              if (type === "done" || type === "error" || type === "stopped") return close();
            }
            if (performance.now() - lastWrite >= args.keepAliveMs) write(": keep-alive\n\n");
            timeout = setTimeout(() => void tick(), args.pollMs);
          } catch (error) {
            if (!closed) {
              closed = true;
              controller.error(error);
            }
          }
        };
        args.request.signal.addEventListener("abort", onAbort, { once: true });
        void tick();
      },
      cancel() {
        streamAbort.abort("stream_cancelled");
        closed = true;
        if (timeout !== undefined) clearTimeout(timeout);
      },
    }),
    { headers: sseHeaders() },
  );
};

export const makeChatRoutes = (
  databaseLayer: ApiDatabaseLayerType = ApiDatabaseLayer,
  options?: {
    readonly readAiRunEventsAfter?: AiRunEventPoller;
    readonly isDemoSessionActive?: ActiveDemoSessionChecker;
  },
): readonly Route[] => [
  {
    method: "GET",
    path: "/v1/chat",
    execute: (request) =>
      Effect.gen(function* () {
        const config = yield* loadApiConfig;
        const authentication = yield* authenticateDemo(request, config, databaseLayer);
        if (!authentication.authenticated) return json({ error: "unauthorized" }, { status: 401 });
        return yield* readChat(authentication.identity, config, databaseLayer).pipe(
          Effect.map((response) => jsonFromSchema(GetChatResponse, response)),
        );
      }),
  },
  {
    method: "POST",
    path: "/v1/chat/messages",
    execute: (request, _url, _path, input) =>
      Effect.gen(function* () {
        const config = yield* loadApiConfig;
        return yield* sendMessage(
          request,
          input.body as Schema.Schema.Type<typeof SendChatMessageRequest>,
          config,
          databaseLayer,
        );
      }),
  },
  {
    method: "PATCH",
    path: "/v1/chat/messages/:messageId",
    execute: (request, _url, path, input) =>
      Effect.gen(function* () {
        const config = yield* loadApiConfig;
        const authentication = yield* authenticateDemo(request, config, databaseLayer);
        if (!authentication.authenticated) return json({ error: "unauthorized" }, { status: 401 });
        const result = yield* editLastUserMessage(
          authentication.identity.userId,
          path.messageId!,
          input.body as Schema.Schema.Type<typeof SendChatMessageRequest>,
          config,
        ).pipe(Effect.provide(databaseLayer));
        if (result.kind === "not_found") return json({ error: "not_found" }, { status: 404 });
        if (result.kind === "forbidden") return json({ error: "forbidden" }, { status: 403 });
        if (result.kind === "web_unavailable")
          return json(
            { code: "web_research_unavailable", reason: result.policy.reason },
            { status: 403 },
          );
        return jsonFromSchema(
          SendChatMessageAccepted,
          {
            message: {
              id: result.messageId,
              author: "user",
              content: (input.body as { text: string }).text,
              createdAt: result.createdAt.toISOString(),
            },
            run: {
              id: result.runId,
              status: "queued",
              streamPath: `/v1/ai-runs/${encodeURIComponent(result.runId)}/stream`,
            },
          },
          { status: 202 },
        );
      }),
  },
  {
    method: "DELETE",
    path: "/v1/chat/messages/:messageId",
    execute: (request, _url, path) =>
      Effect.gen(function* () {
        const config = yield* loadApiConfig;
        const authentication = yield* authenticateDemo(request, config, databaseLayer);
        if (!authentication.authenticated) return json({ error: "unauthorized" }, { status: 401 });
        const result = yield* deleteVisibleChatMessage(
          authentication.identity.userId,
          path.messageId!,
        ).pipe(Effect.provide(databaseLayer));
        if (result.kind === "not_found") return json({ error: "not_found" }, { status: 404 });
        if (result.kind === "forbidden") return json({ error: "forbidden" }, { status: 403 });
        return new Response(null, { status: 204 });
      }),
  },
  {
    method: "POST",
    path: "/v1/ai-runs/:runId/stop",
    execute: (request, _url, path) =>
      Effect.gen(function* () {
        const config = yield* loadApiConfig;
        const authentication = yield* authenticateDemo(request, config, databaseLayer);
        if (!authentication.authenticated) return json({ error: "unauthorized" }, { status: 401 });
        const result = yield* requestAiRunStop(authentication.identity.userId, path.runId!).pipe(
          Effect.provide(databaseLayer),
        );
        if (result.kind === "not_found") return json({ error: "not_found" }, { status: 404 });
        return jsonFromSchema(AiRunStopResponse, { runId: result.runId }, { status: 202 });
      }),
  },
  {
    method: "GET",
    path: "/v1/ai-runs/:runId/stream",
    execute: (request, _url, path, input) =>
      Effect.gen(function* () {
        const config = yield* loadApiConfig;
        const authentication = yield* authenticateDemo(request, config, databaseLayer);
        if (!authentication.authenticated) return json({ error: "unauthorized" }, { status: 401 });
        const context = yield* readRunStreamContext(path.runId!).pipe(
          Effect.provide(databaseLayer),
        );
        if (context === null) return json({ error: "not_found" }, { status: 404 });
        const afterSeq = Math.max(
          parseSeq(input.headers["last-event-id"] as string | undefined),
          parseSeq(input.query.afterSeq as string | undefined),
        );
        const poll = yield* readAuthorizedAiRunEventsAfterFromDomain(
          authentication.identity.userId,
          path.runId!,
          afterSeq,
        ).pipe(Effect.provide(databaseLayer));
        if (!poll.authorized) return json({ error: "not_found" }, { status: 404 });
        if (poll.terminal && !poll.replayableTerminal)
          return json({ error: "terminal_event_unavailable" }, { status: 410 });
        return incrementalSse({
          request,
          runId: path.runId!,
          userId: authentication.identity.userId,
          afterSeq,
          pollMs: config.aiStreamPollMs,
          keepAliveMs: config.aiStreamKeepAliveMs,
          databaseLayer,
          readAuthorizedAiRunEventsAfter:
            options?.readAiRunEventsAfter ?? readAuthorizedAiRunEventsAfter,
          isSessionActive: options?.isDemoSessionActive ?? checkActiveDemoSession,
        });
      }),
  },
  {
    method: "GET",
    path: "/v1/ai-runs/:runId/debug",
    execute: (request, _url, path) =>
      Effect.gen(function* () {
        const config = yield* loadApiConfig;
        const authentication = yield* authenticateDemo(request, config, databaseLayer);
        if (!authentication.authenticated) return json({ error: "unauthorized" }, { status: 401 });
        const result = yield* readAuthorizedAiRunDebug(
          authentication.identity.userId,
          path.runId!,
        ).pipe(Effect.provide(databaseLayer));
        if (result.kind === "unauthorized") return json({ error: "not_found" }, { status: 404 });
        if (result.kind === "unavailable")
          return jsonFromSchema(PublicAiRunDebugResponse, { available: false });
        return jsonFromSchema(PublicAiRunDebugResponse, { available: true, debug: result.debug });
      }),
  },
];

export const chatRoutes = makeChatRoutes();
