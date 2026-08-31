import {
  displayablePublicSourceMediaType,
  listPublicSources,
  readAuthorizedPublicSourceDocument,
  type RawPublicSourceDocument,
} from "@hartlib/backend-domain/public-sources";
import {
  PublicSourcesResponse,
  type Market,
  type UpdateClientPublicSourceRequest,
} from "@hartlib/shared";
import { Effect } from "effect";

import { resolveRequestIdentity, type RequestIdentityResult } from "../auth";
import { ApiDatabaseLayer, type ApiDatabaseLayer as ApiDatabaseLayerType } from "../database";
import { loadApiConfig, type ApiConfig } from "../config";
import { ensureDemoChat } from "@hartlib/backend-domain/chat-runtime";
import { requestIdForAudit, WorkspaceAuthorizationError } from "@hartlib/workspace/common";
import { updateDemoPublicSource } from "@hartlib/workspace/demo-public-sources";
import { json, jsonFromSchema, type Route } from "../http";
import { withAdministrativeAuditing } from "./administrative-audit";

export { publicSourcesResponseFromRows } from "@hartlib/backend-domain/public-sources";

export const makePublicSourceRoutes = (
  databaseLayer: ApiDatabaseLayerType = ApiDatabaseLayer,
): readonly Route[] => {
  const publicSourcesRoute: Route = {
    method: "GET",
    path: "/v1/public-sources",
    execute: (request, _url, _pathParameters, input) =>
      Effect.gen(function* () {
        const authentication = yield* resolveRequestIdentity(request, yield* loadApiConfig, {
          databaseLayer,
        });
        if (!authentication.authenticated) return json({ error: "unauthorized" }, { status: 401 });
        const market = input.query.market as Market | undefined;
        const chat = yield* ensureDemoChat(authentication.identity.userId).pipe(
          Effect.provide(databaseLayer),
        );
        return yield* listPublicSources(market, chat.company_id).pipe(
          Effect.provide(databaseLayer),
          Effect.map((response) => jsonFromSchema(PublicSourcesResponse, response)),
        );
      }),
  };

  const publicSourceToggleRoute: Route = {
    method: "PUT",
    path: "/v1/public-sources/:sourceId",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const authentication = yield* resolveRequestIdentity(request, yield* loadApiConfig, {
          databaseLayer,
        });
        if (!authentication.authenticated) return json({ error: "unauthorized" }, { status: 401 });
        const sourceId = pathParameters.sourceId!;
        const requestId = requestIdForAudit(request) ?? crypto.randomUUID();
        const market = input.query.market as Market | undefined;
        const chat = yield* ensureDemoChat(authentication.identity.userId).pipe(
          Effect.provide(databaseLayer),
        );
        const body = input.body as UpdateClientPublicSourceRequest;
        const result = yield* updateDemoPublicSource({
          identity: authentication.identity,
          companyId: chat.company_id,
          sourceId,
          enabled: body.enabled,
          ...(market === undefined ? {} : { market }),
          requestId,
        }).pipe(
          Effect.provide(databaseLayer),
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (value) => ({ ok: true as const, value }),
          }),
        );
        if (!result.ok) {
          const error = result.error;
          if (error instanceof WorkspaceAuthorizationError) {
            return json({ code: error.code }, { status: error.code === "forbidden" ? 403 : 404 });
          }
          return yield* Effect.fail(error);
        }
        return yield* listPublicSources(market, chat.company_id).pipe(
          Effect.provide(databaseLayer),
          Effect.map((response) => jsonFromSchema(PublicSourcesResponse, response)),
        );
      }),
  };

  return withAdministrativeAuditing([publicSourcesRoute, publicSourceToggleRoute], databaseLayer);
};

export const publicSourceRoutes = makePublicSourceRoutes();

export const publicSourceDocumentResponseFromRow = (row: RawPublicSourceDocument): Response => {
  const mediaType = displayablePublicSourceMediaType(row.media_type);
  if (mediaType === null) {
    throw new Error("stored public source document has an unsupported media type");
  }
  const headers = new Headers();
  headers.set("cache-control", "private, no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  if (mediaType === "application/pdf") {
    if (!row.body_bytes || row.body_bytes.byteLength === 0) {
      throw new Error("stored public source PDF is missing exact bytes");
    }
    headers.set("content-type", "application/pdf");
    headers.set("content-disposition", 'inline; filename="public-source-document.pdf"');
    return new Response(Uint8Array.from(row.body_bytes).buffer, { headers });
  }

  headers.set("content-type", "text/html; charset=utf-8");
  headers.set(
    "content-security-policy",
    "sandbox; default-src 'none'; script-src 'none'; object-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  headers.set("content-disposition", 'inline; filename="public-source-document.html"');
  return new Response(row.body, { headers });
};

export const makePublicSourceDocumentContentRoute = (
  databaseLayer: ApiDatabaseLayerType = ApiDatabaseLayer,
  resolveIdentity: (
    request: Request,
    config: ApiConfig,
    options?: { readonly databaseLayer?: ApiDatabaseLayerType | undefined },
  ) => Effect.Effect<RequestIdentityResult, Error> = resolveRequestIdentity,
): Route => ({
  method: "GET",
  path: "/public-source-documents/:documentId/content",
  corsPolicy: "explicit-origin",
  execute: (request, _url, pathParameters) =>
    Effect.gen(function* () {
      const authentication = yield* resolveIdentity(request, yield* loadApiConfig, {
        databaseLayer,
      });
      if (!authentication.authenticated) return json({ error: "not_found" }, { status: 404 });
      const demoCompanyId = yield* ensureDemoChat(authentication.identity.userId).pipe(
        Effect.provide(databaseLayer),
        Effect.map((chat) => chat.company_id),
        Effect.catch(() => Effect.succeed(null)),
      );
      if (demoCompanyId === null) return json({ error: "not_found" }, { status: 404 });
      const row = yield* readAuthorizedPublicSourceDocument(
        authentication.identity,
        pathParameters.documentId!,
        demoCompanyId,
      ).pipe(Effect.provide(databaseLayer));
      return row === null
        ? json({ error: "not_found" }, { status: 404 })
        : publicSourceDocumentResponseFromRow(row);
    }),
});

export const publicSourceDocumentContentRoute = makePublicSourceDocumentContentRoute();
