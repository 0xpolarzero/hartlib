import {
  deleteUserMemory,
  listUserMemories,
  memoryRevisionResponse,
  readUserMemoryWithRevisions,
  revertUserMemory,
  type MemoryMutationResult,
} from "@hartlib/backend-domain/memories";
import {
  ListMemoriesResponse,
  MemoryRecord,
  MemoryRevisionResponse,
  type RevertMemoryRequest as RevertMemoryBody,
} from "@hartlib/shared";
import { Effect } from "effect";

import { resolveRequestIdentity } from "../auth";
import { loadApiConfig } from "../config";
import { ApiDatabaseLayer, type ApiDatabaseLayer as ApiDatabaseLayerType } from "../database";
import { json, jsonFromSchema, type Route } from "../http";

const mutationResponse = (result: MemoryMutationResult): Response => {
  switch (result.status) {
    case "ok":
      return jsonFromSchema(MemoryRecord, result.memory);
    case "not_found":
      return json({ error: "not_found" }, { status: 404 });
    case "active_run":
      return json({ code: "active_ai_run", runId: result.runId }, { status: 409 });
    case "expired":
      return json({ code: "memory_revert_window_expired" }, { status: 410 });
    case "invalid_revision":
      return json({ code: "invalid_memory_revision" }, { status: 400 });
    case "duplicate":
      return json({ code: "memory_duplicate" }, { status: 409 });
  }
};

export const makeMemoryRoutes = (
  databaseLayer: ApiDatabaseLayerType = ApiDatabaseLayer,
): readonly Route[] => [
  {
    method: "GET",
    path: "/v1/memories",
    execute: (request) =>
      Effect.gen(function* () {
        const config = yield* loadApiConfig;
        const authentication = yield* resolveRequestIdentity(request, config, { databaseLayer });
        if (!authentication.authenticated) {
          return json({ error: "unauthorized" }, { status: 401 });
        }
        return yield* listUserMemories(authentication.identity.userId).pipe(
          Effect.provide(databaseLayer),
          Effect.map((response) => jsonFromSchema(ListMemoriesResponse, response)),
        );
      }),
  },
  {
    method: "GET",
    path: "/v1/memories/:memoryId/revisions/:revisionId",
    execute: (request, _url, pathParameters, _input) =>
      Effect.gen(function* () {
        const config = yield* loadApiConfig;
        const authentication = yield* resolveRequestIdentity(request, config, { databaseLayer });
        if (!authentication.authenticated) {
          return json({ error: "unauthorized" }, { status: 401 });
        }
        const memoryId = pathParameters.memoryId!;
        const revisionId = pathParameters.revisionId!;
        const loaded = yield* readUserMemoryWithRevisions(
          authentication.identity.userId,
          memoryId,
        ).pipe(Effect.provide(databaseLayer));
        const revision = loaded?.revisions.find((candidate) => candidate.id === revisionId);
        if (revision === undefined) return json({ error: "not_found" }, { status: 404 });
        return jsonFromSchema(MemoryRevisionResponse, {
          memoryId,
          revision: memoryRevisionResponse(revision),
        });
      }),
  },
  {
    method: "POST",
    path: "/v1/memories/:memoryId/revert",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const config = yield* loadApiConfig;
        const authentication = yield* resolveRequestIdentity(request, config, { databaseLayer });
        if (!authentication.authenticated) {
          return json({ error: "unauthorized" }, { status: 401 });
        }
        const revisionId = (input.body as RevertMemoryBody).revisionId;
        const result = yield* revertUserMemory(
          authentication.identity.userId,
          pathParameters.memoryId!,
          revisionId,
        ).pipe(Effect.provide(databaseLayer));
        return mutationResponse(result);
      }),
  },
  {
    method: "DELETE",
    path: "/v1/memories/:memoryId",
    execute: (request, _url, pathParameters) =>
      Effect.gen(function* () {
        const config = yield* loadApiConfig;
        const authentication = yield* resolveRequestIdentity(request, config, { databaseLayer });
        if (!authentication.authenticated) {
          return json({ error: "unauthorized" }, { status: 401 });
        }
        const result = yield* deleteUserMemory(
          authentication.identity.userId,
          pathParameters.memoryId!,
        ).pipe(Effect.provide(databaseLayer));
        return mutationResponse(result);
      }),
  },
];

export const memoryRoutes = makeMemoryRoutes();
