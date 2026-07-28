import {
  createProductChat,
  listProductChats,
  mutateProductChat,
  resetProductChat,
} from "@brief/backend-domain/product-chats";
import {
  ResetProductChatResponse,
  type CreateProductChatRequest,
  type ResetProductChatRequest,
} from "@brief/shared";
import { WorkspaceAuthorizationError } from "@brief/workspace";
import { Effect } from "effect";

import { resolveRequestIdentity } from "../auth";
import { loadApiConfig } from "../config";
import { ApiDatabaseLayer, type ApiDatabaseLayer as ApiDatabaseLayerType } from "../database";
import { json, jsonFromSchema, type Route } from "../http";
import { readChat } from "./chat";

export { CHAT_ACTIVE_PURGE_WINDOW_DAYS } from "@brief/backend-domain/product-chats";

const requireIdentity = (request: Request) =>
  Effect.gen(function* () {
    const config = yield* loadApiConfig;
    return yield* resolveRequestIdentity(request, config);
  });

const unauthorized = () => json({ error: "unauthorized" }, { status: 401 });
const forbidden = () => json({ error: "forbidden" }, { status: 403 });

export const makeProductChatRoutes = (
  databaseLayer: ApiDatabaseLayerType = ApiDatabaseLayer,
): readonly Route[] => [
  {
    method: "GET",
    path: "/v1/chats",
    execute: (request, _url, _pathParameters, input) =>
      Effect.gen(function* () {
        const authentication = yield* requireIdentity(request);
        if (!authentication.authenticated) return unauthorized();
        const view = (input.query.view as "mine" | "shared" | "archived" | undefined) ?? "mine";
        const chats = yield* listProductChats(authentication.identity, view).pipe(
          Effect.provide(databaseLayer),
        );
        return json({ chats });
      }),
  },
  {
    method: "POST",
    path: "/v1/chats",
    execute: (request, _url, _pathParameters, input) =>
      Effect.gen(function* () {
        const authentication = yield* requireIdentity(request);
        if (!authentication.authenticated) return unauthorized();
        const body = input.body as CreateProductChatRequest;
        const result = yield* createProductChat(authentication.identity, body).pipe(
          Effect.provide(databaseLayer),
        );
        if (result.kind === "forbidden") return forbidden();
        return json(
          {
            chat: {
              id: result.chat.id,
              memoryMode: body.memoryMode,
              sourceAccessIds: result.sources.map((source) => source.accessId),
              createdAt: result.chat.createdAt.toISOString(),
            },
          },
          { status: 201 },
        );
      }),
  },
  ...(["share", "unshare"] as const).map(
    (operation): Route => ({
      method: "POST",
      path: `/v1/chats/:chatId/${operation}`,
      execute: (request, _url, pathParameters) =>
        Effect.gen(function* () {
          const authentication = yield* requireIdentity(request);
          if (!authentication.authenticated) return unauthorized();
          const result = yield* mutateProductChat(
            authentication.identity,
            pathParameters.chatId!,
            operation,
          ).pipe(Effect.provide(databaseLayer));
          return result === "ok"
            ? json({ status: operation === "share" ? "shared" : "private" })
            : forbidden();
        }),
    }),
  ),
  {
    method: "DELETE",
    path: "/v1/chats/:chatId",
    execute: (request, _url, pathParameters) =>
      Effect.gen(function* () {
        const authentication = yield* requireIdentity(request);
        if (!authentication.authenticated) return unauthorized();
        const result = yield* mutateProductChat(
          authentication.identity,
          pathParameters.chatId!,
          "delete",
        ).pipe(Effect.provide(databaseLayer));
        return result === "ok" ? new Response(null, { status: 204 }) : forbidden();
      }),
  },
  {
    method: "POST",
    path: "/v1/chats/:chatId/reset",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const authentication = yield* requireIdentity(request);
        if (!authentication.authenticated) return unauthorized();
        const config = yield* loadApiConfig;
        const body = input.body as ResetProductChatRequest;
        const result = yield* resetProductChat(
          authentication.identity,
          pathParameters.chatId!,
          body.replacementChatId,
        ).pipe(Effect.provide(databaseLayer));
        if (result.kind === "forbidden") return forbidden();
        if (result.kind === "already_reset") {
          return json(
            { error: "chat_already_reset", archivedChatId: result.archivedChatId },
            { status: 409 },
          );
        }
        if (result.kind === "replacement_conflict") {
          return json({ error: "replacement_id_conflict" }, { status: 409 });
        }
        const replacement = yield* readChat(
          authentication.identity,
          config,
          result.replacementChatId,
        ).pipe(
          Effect.provide(databaseLayer),
          Effect.catch((error) =>
            error instanceof WorkspaceAuthorizationError && error.code === "not_found"
              ? Effect.succeed(null)
              : Effect.fail(error),
          ),
        );
        if (replacement === null) return forbidden();
        return jsonFromSchema(
          ResetProductChatResponse,
          { archivedChatId: result.archivedChatId, replacement },
          { status: 200 },
        );
      }),
  },
];

export const productChatRoutes = makeProductChatRoutes();
