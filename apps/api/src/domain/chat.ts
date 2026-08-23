import {
  createUserMessageAndRun,
  creditLimitReached,
  effectiveWebPolicy,
  ensureDemoChat,
  findActiveRunConflict,
  loadAuthorizedChatRuntimeState,
  loadDemoChatRuntimeState,
  loadOwnedChat,
  preflightCredits,
  readAuthorizedAiRunEventsAfter as readAuthorizedAiRunEventsAfterFromDomain,
  readAuthorizedAiRunDebug,
  readRunStreamContext,
  type AiRunEventRow,
  type AuthorizedAiRunEventPoll,
  type ChatRow,
  type RunStreamContext,
} from "@hartlib/backend-domain/chat-runtime";
import { chatMessagesResponseFromRows, runDescriptor } from "@hartlib/backend-domain/chat-response";
import {
  AiRunEvent,
  normalizeDomainAllowlist,
  PublicAiRunDebugResponse,
  type ActiveAiRunConflict,
  GetChatResponse,
  SendChatMessageAccepted,
  SendChatMessageRequest,
} from "@hartlib/shared";
import { WorkspaceAuthorizationError as AuthorizationError } from "@hartlib/workspace";
import { Effect, Schema } from "effect";

import { resolveRequestIdentity, type RequestAuthenticator, type RequestIdentity } from "../auth";
import { loadApiConfig, type ApiConfig } from "../config";
import { ApiDatabaseLayer, type ApiDatabaseLayer as ApiDatabaseLayerType } from "../database";
import { corsHeaders, json, jsonFromSchema, type Route } from "../http";
import { JsonLoggerLayer, serviceLogFields } from "../logging";

export {
  chatMessagesResponseFromRows,
  creditLimitReached,
  effectiveWebPolicy,
  normalizeDomainAllowlist,
  preflightCredits,
};
export type { AiRunEventRow, RunStreamContext };

export type AiRunEventPoller = (
  userId: string,
  organizationId: string | null,
  runId: string,
  afterSeq: number,
  databaseLayer: ApiDatabaseLayerType,
  signal?: AbortSignal,
) => Promise<AuthorizedAiRunEventPoll>;

export const readChat = (identity: RequestIdentity, config: ApiConfig, chatId?: string) =>
  (chatId === undefined
    ? loadDemoChatRuntimeState(identity, config)
    : loadAuthorizedChatRuntimeState(identity, config, chatId)
  ).pipe(
    Effect.flatMap((loaded) => {
      if (loaded === null) return Effect.fail(new AuthorizationError("not_found"));
      const active =
        loaded.runs.find((run) => run.finished_at === null && run.failed_at === null) ?? null;
      return Effect.try({
        try: () =>
          ({
            chat: {
              id: loaded.chat.id,
              memoryMode: loaded.chat.memory_mode,
              createdAt: loaded.chat.created_at.toISOString(),
              updatedAt: loaded.chat.updated_at.toISOString(),
              archivedAt:
                loaded.chat.archived_at === null ? null : loaded.chat.archived_at.toISOString(),
            },
            messages: chatMessagesResponseFromRows(
              loaded.messages,
              loaded.runs,
              loaded.sourceRows,
              loaded.useRows,
            ),
            effectiveWebPolicy: loaded.effectivePolicy,
            activeRun: active === null ? null : runDescriptor(active),
            canWrite: loaded.chat.user_id === identity.userId && loaded.chat.archived_at === null,
          }) satisfies GetChatResponse,
        catch: () => new AuthorizationError("not_found"),
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

const logChatInfo = (message: string, fields: Record<string, unknown>) =>
  Effect.logInfo(message).pipe(Effect.annotateLogs({ component: "ai_chat", ...fields }));

const activeRunConflict = (
  active: Parameters<typeof runDescriptor>[0] & { readonly chat_id: string },
  chatId: string,
): Response =>
  json(
    {
      code: "active_ai_run",
      conflictScope: active.chat_id === chatId ? "chat" : "user",
      activeRun: runDescriptor(active),
    } satisfies ActiveAiRunConflict,
    { status: 409 },
  );

const sendMessage = (
  request: Request,
  input: Schema.Schema.Type<typeof SendChatMessageRequest>,
  config: ApiConfig,
  databaseLayer: ApiDatabaseLayerType,
  chatId?: string,
) =>
  Effect.gen(function* () {
    const authentication = yield* resolveRequestIdentity(request, config);
    if (!authentication.authenticated) return json({ error: "unauthorized" }, { status: 401 });
    const userId = authentication.identity.userId;
    const result = yield* createUserMessageAndRun(
      userId,
      input,
      config,
      authentication.identity.organizationId,
      chatId,
    ).pipe(
      Effect.provide(databaseLayer),
      Effect.catch((error: unknown) => {
        if (!isUniqueViolation(error)) return Effect.fail(error);
        const loadChat: Effect.Effect<ChatRow | null, unknown, never> =
          chatId === undefined
            ? ensureDemoChat(userId).pipe(
                Effect.provide(databaseLayer),
                Effect.map((chat) => chat as ChatRow | null),
              )
            : loadOwnedChat(userId, chatId, authentication.identity.organizationId).pipe(
                Effect.provide(databaseLayer),
              );
        return loadChat.pipe(
          Effect.flatMap((chat) => {
            if (chat === null) return Effect.fail(error);
            return findActiveRunConflict(
              userId,
              chat.id,
              authentication.identity.organizationId,
            ).pipe(
              Effect.provide(databaseLayer),
              Effect.flatMap((active) =>
                active === null
                  ? Effect.fail(error)
                  : Effect.succeed({ kind: "conflict", active, chat } as const),
              ),
            );
          }),
        );
      }),
    );
    if (result.kind === "forbidden") return json({ error: "forbidden" }, { status: 403 });
    if (result.kind === "credit_unavailable") return json({ code: result.code }, { status: 402 });
    if (result.kind === "web_unavailable") {
      return json(
        { code: "web_research_unavailable", reason: result.policy.reason },
        { status: 403 },
      );
    }
    if (result.kind === "conflict") return activeRunConflict(result.active, result.chat.id);
    const response = {
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
    } satisfies SendChatMessageAccepted;
    yield* logChatInfo("ai chat message accepted and enqueued", {
      route: chatId === undefined ? "POST /v1/chat/messages" : "POST /v1/chats/:id/messages",
      userId,
      chatId: result.chat.id,
      messageId: result.message.id,
      runId: result.runId,
    });
    return jsonFromSchema(SendChatMessageAccepted, response, { status: 202 });
  });

const eventType = (event: { readonly type: string }): string => event.type;
// Durable events are untrusted persisted input. Decode with excess-property errors
// enabled so malformed root or nested payload fields cannot be silently stripped
// before they are framed for the SSE client.
const decodeAiRunEvent = Schema.decodeUnknownSync(AiRunEvent, {
  onExcessProperty: "error",
});

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
  return `id: ${row.seq}\nevent: ${eventType(event)}\ndata: ${JSON.stringify(event)}\n\n`;
};

const parseSeq = (value: string | undefined): number => {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("invalid_sse_sequence");
  }
  return parsed;
};

const readAuthorizedAiRunEventsAfter: AiRunEventPoller = (
  userId,
  organizationId,
  runId,
  afterSeq,
  databaseLayer,
  signal,
) =>
  Effect.runPromise(
    readAuthorizedAiRunEventsAfterFromDomain(userId, organizationId, runId, afterSeq).pipe(
      Effect.provide(databaseLayer),
    ),
    { signal },
  );

const streamLog = (message: string, fields: Record<string, unknown>): void => {
  void Effect.runPromise(
    logChatInfo(message, fields).pipe(
      Effect.provide(JsonLoggerLayer),
      Effect.annotateLogs(serviceLogFields),
    ),
  ).catch(() => undefined);
};

const incrementalSse = (args: {
  readonly request: Request;
  readonly runId: string;
  readonly chatId: string;
  readonly userId: string;
  readonly organizationId: string | null;
  readonly afterSeq: number;
  readonly pollMs: number;
  readonly keepAliveMs: number;
  readonly databaseLayer: ApiDatabaseLayerType;
  readonly readAuthorizedAiRunEventsAfter: AiRunEventPoller;
}) => {
  const encoder = new TextEncoder();
  const streamAbort = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let closed = false;
  let close = () => {
    closed = true;
    if (timeout !== undefined) clearTimeout(timeout);
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let afterSeq = args.afterSeq;
        let lastWrite = performance.now();
        const onAbort = () => {
          streamAbort.abort(args.request.signal.reason);
          close();
        };
        close = () => {
          if (closed) return;
          closed = true;
          if (timeout !== undefined) clearTimeout(timeout);
          args.request.signal.removeEventListener("abort", onAbort);
          try {
            controller.close();
          } catch {
            // Cancellation may race with terminal closure.
          }
        };
        const write = (value: string) => {
          if (closed) return;
          controller.enqueue(encoder.encode(value));
          lastWrite = performance.now();
        };
        function runTick(): void {
          const pending = tick();
          inFlight = pending;
          void pending.then(
            () => {
              if (inFlight === pending) inFlight = undefined;
            },
            () => {
              if (inFlight === pending) inFlight = undefined;
            },
          );
        }
        const tick = async () => {
          if (closed || args.request.signal.aborted) return close();
          try {
            const poll = await args.readAuthorizedAiRunEventsAfter(
              args.userId,
              args.organizationId,
              args.runId,
              afterSeq,
              args.databaseLayer,
              streamAbort.signal,
            );
            if (!poll.authorized) {
              streamLog("ai chat stream viewer denied", {
                userId: args.userId,
                chatId: args.chatId,
                runId: args.runId,
              });
              return close();
            }
            if (poll.terminal && !poll.replayableTerminal && poll.events.length === 0) {
              streamLog("ai chat stream terminal event unavailable", {
                userId: args.userId,
                chatId: args.chatId,
                runId: args.runId,
                errorCode: "terminal_event_unavailable",
              });
              return close();
            }
            for (const row of poll.events) {
              if (closed) return;
              write(encodeSseEvent(row));
              afterSeq = row.seq;
              const event = decodeAiRunEvent(row.event);
              if (event.type === "done" || event.type === "error") return close();
            }
            if (performance.now() - lastWrite >= args.keepAliveMs) write(": keep-alive\n\n");
            timeout = setTimeout(runTick, args.pollMs);
          } catch (error) {
            streamLog("ai chat stream failed", {
              userId: args.userId,
              chatId: args.chatId,
              runId: args.runId,
              errorCode: "invalid_or_unavailable_event",
            });
            if (!closed) {
              closed = true;
              controller.error(error);
            }
          }
        };
        args.request.signal.addEventListener("abort", onAbort, { once: true });
        streamLog("ai chat stream opened", {
          userId: args.userId,
          chatId: args.chatId,
          runId: args.runId,
          afterSeq,
        });
        runTick();
      },
      cancel() {
        streamAbort.abort("stream_cancelled");
        close();
        return inFlight;
      },
    }),
    { headers: sseHeaders() },
  );
};

export const makeChatRoutes = (
  databaseLayer: ApiDatabaseLayerType = ApiDatabaseLayer,
  options?: {
    readonly readAiRunEventsAfter?: AiRunEventPoller;
    readonly readAuthenticator?: RequestAuthenticator;
    readonly streamAuthenticator?: RequestAuthenticator;
    readonly debugAuthenticator?: RequestAuthenticator;
  },
): readonly Route[] => [
  {
    method: "GET",
    path: "/v1/chat",
    execute: (request) =>
      Effect.gen(function* () {
        const config = yield* loadApiConfig;
        if (config.authMode !== "demo") return json({ error: "not_found" }, { status: 404 });
        const authentication = yield* resolveRequestIdentity(request, config, {
          authenticator: options?.readAuthenticator,
        });
        if (!authentication.authenticated) return json({ error: "unauthorized" }, { status: 401 });
        return yield* readChat(authentication.identity, config).pipe(
          Effect.provide(databaseLayer),
          Effect.map((response) => jsonFromSchema(GetChatResponse, response)),
        );
      }),
  },
  {
    method: "POST",
    path: "/v1/chat/messages",
    execute: (request, _url, _pathParameters, input) =>
      Effect.gen(function* () {
        const config = yield* loadApiConfig;
        if (config.authMode !== "demo") return json({ error: "not_found" }, { status: 404 });
        return yield* sendMessage(
          request,
          input.body as Schema.Schema.Type<typeof SendChatMessageRequest>,
          config,
          databaseLayer,
        );
      }),
  },
  {
    method: "GET",
    path: "/v1/chats/:chatId",
    execute: (request, _url, pathParameters) =>
      Effect.gen(function* () {
        const config = yield* loadApiConfig;
        const authentication = yield* resolveRequestIdentity(request, config, {
          authenticator: options?.readAuthenticator,
        });
        if (!authentication.authenticated) return json({ error: "unauthorized" }, { status: 401 });
        const chatId = pathParameters.chatId!;
        return yield* readChat(authentication.identity, config, chatId).pipe(
          Effect.provide(databaseLayer),
          Effect.map((response) => jsonFromSchema(GetChatResponse, response)),
          Effect.catch((error) =>
            error instanceof AuthorizationError && error.code === "not_found"
              ? Effect.succeed(json({ error: "not_found" }, { status: 404 }))
              : Effect.fail(error),
          ),
        );
      }),
  },
  {
    method: "POST",
    path: "/v1/chats/:chatId/messages",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const config = yield* loadApiConfig;
        return yield* sendMessage(
          request,
          input.body as Schema.Schema.Type<typeof SendChatMessageRequest>,
          config,
          databaseLayer,
          pathParameters.chatId!,
        );
      }),
  },
  {
    method: "GET",
    path: "/v1/ai-runs/:runId/stream",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const runId = pathParameters.runId!;
        const config = yield* loadApiConfig;
        const authentication = yield* resolveRequestIdentity(request, config, {
          authenticator: options?.streamAuthenticator,
        });
        if (!authentication.authenticated) return json({ error: "unauthorized" }, { status: 401 });
        const context = yield* readRunStreamContext(runId).pipe(Effect.provide(databaseLayer));
        if (context === null) return json({ error: "not_found" }, { status: 404 });
        const afterSeq = Math.max(
          parseSeq(input.headers["last-event-id"] as string | undefined),
          parseSeq(input.query.afterSeq as string | undefined),
        );
        const handshake = yield* readAuthorizedAiRunEventsAfterFromDomain(
          authentication.identity.userId,
          authentication.identity.organizationId,
          runId,
          afterSeq,
        ).pipe(Effect.provide(databaseLayer));
        if (!handshake.authorized) {
          return json({ error: "not_found" }, { status: 404 });
        }
        if (handshake.terminal && !handshake.replayableTerminal) {
          return json({ error: "terminal_event_unavailable" }, { status: 410 });
        }
        return incrementalSse({
          request,
          runId,
          chatId: context.chatId,
          userId: authentication.identity.userId,
          organizationId: authentication.identity.organizationId,
          afterSeq,
          pollMs: config.aiStreamPollMs,
          keepAliveMs: config.aiStreamKeepAliveMs,
          databaseLayer,
          readAuthorizedAiRunEventsAfter:
            options?.readAiRunEventsAfter ?? readAuthorizedAiRunEventsAfter,
        });
      }),
  },
  {
    method: "GET",
    path: "/v1/ai-runs/:runId/debug",
    execute: (request, _url, pathParameters) =>
      Effect.gen(function* () {
        const runId = pathParameters.runId!;
        const config = yield* loadApiConfig;
        const authentication = yield* resolveRequestIdentity(request, config, {
          authenticator: options?.debugAuthenticator,
        });
        if (!authentication.authenticated) return json({ error: "unauthorized" }, { status: 401 });
        const result = yield* readAuthorizedAiRunDebug(
          authentication.identity.userId,
          authentication.identity.organizationId,
          runId,
        ).pipe(Effect.provide(databaseLayer));
        if (result.kind === "unauthorized") return json({ error: "not_found" }, { status: 404 });
        if (result.kind === "unavailable") {
          return jsonFromSchema(PublicAiRunDebugResponse, { available: false });
        }
        return jsonFromSchema(PublicAiRunDebugResponse, {
          available: true,
          debug: result.debug,
        });
      }),
  },
];

export const chatRoutes = makeChatRoutes();
