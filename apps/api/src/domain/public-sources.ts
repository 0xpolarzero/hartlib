import {
  displayablePublicSourceMediaType,
  listPublicSources,
  readAuthorizedPublicSourceDocument,
  type RawPublicSourceDocument,
} from "@brief/backend-domain/public-sources";
import {
  PublicSourcesResponse,
  type Market,
  type UpdateClientPublicSourceRequest,
} from "@brief/shared";
import { Effect } from "effect";

import { resolveRequestIdentity, type RequestIdentityResult } from "../auth";
import { ApiDatabaseLayer, type ApiDatabaseLayer as ApiDatabaseLayerType } from "../database";
import { loadApiConfig, type ApiConfig } from "../config";
import { ensureDemoChat } from "@brief/backend-domain/chat-runtime";
import {
  requestIdForAudit,
  updateClientPublicSource,
  WorkspaceAuthorizationError,
} from "@brief/workspace";
import { json, jsonFromSchema, type Route } from "../http";
import { withAdministrativeAuditing } from "./administrative-audit";

export { publicSourcesResponseFromRows } from "@brief/backend-domain/public-sources";

export const publicSourcesRoute: Route = {
  method: "GET",
  path: "/v1/public-sources",
  execute: (request, _url, _pathParameters, input) =>
    Effect.gen(function* () {
      const authentication = yield* resolveRequestIdentity(request, yield* loadApiConfig);
      if (!authentication.authenticated) return json({ error: "unauthorized" }, { status: 401 });
      if (authentication.identity.mode !== "demo") {
        return json({ error: "not_found" }, { status: 404 });
      }
      const market = input.query.market as Market | undefined;
      // The demo route has no company id in its URL. Resolve the same
      // deterministic workspace used by chat, then project only its enabled
      // public-source settings. Production clients use the company-scoped
      // workspace route instead.
      const chat = yield* ensureDemoChat(authentication.identity.userId).pipe(
        Effect.provide(ApiDatabaseLayer),
      );
      return yield* listPublicSources(market, chat.company_id).pipe(
        Effect.provide(ApiDatabaseLayer),
        Effect.map((response) => jsonFromSchema(PublicSourcesResponse, response)),
      );
    }),
};

export const publicSourceToggleRoute: Route = {
  method: "PUT",
  path: "/v1/public-sources/:sourceId",
  execute: (request, _url, pathParameters, input) =>
    Effect.gen(function* () {
      const authentication = yield* resolveRequestIdentity(request, yield* loadApiConfig);
      if (!authentication.authenticated) return json({ error: "unauthorized" }, { status: 401 });
      if (authentication.identity.mode !== "demo") {
        return json({ error: "not_found" }, { status: 404 });
      }
      const sourceId = pathParameters.sourceId!;
      if (sourceId.trim() === "" || sourceId.length > 200) {
        return json({ code: "invalid_body" }, { status: 400 });
      }
      const requestId = requestIdForAudit(request) ?? crypto.randomUUID();
      const chat = yield* ensureDemoChat(authentication.identity.userId).pipe(
        Effect.provide(ApiDatabaseLayer),
      );
      const body = input.body as UpdateClientPublicSourceRequest;
      const result = yield* updateClientPublicSource({
        identity: authentication.identity,
        companyId: chat.company_id,
        sourceId,
        enabled: body.enabled,
        requestId,
      }).pipe(
        Effect.provide(ApiDatabaseLayer),
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      );
      if (!result.ok) {
        const error = result.error;
        if (error instanceof WorkspaceAuthorizationError) {
          return json({ code: error.code }, { status: error.code === "mfa_required" ? 403 : 404 });
        }
        return yield* Effect.fail(error);
      }
      const market = input.query.market as Market | undefined;
      return yield* listPublicSources(market, chat.company_id).pipe(
        Effect.provide(ApiDatabaseLayer),
        Effect.map((response) => jsonFromSchema(PublicSourcesResponse, response)),
      );
    }),
};

export const publicSourceRoutes: readonly Route[] = withAdministrativeAuditing(
  [publicSourcesRoute, publicSourceToggleRoute],
  ApiDatabaseLayer,
);

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
  ) => Effect.Effect<RequestIdentityResult, Error> = resolveRequestIdentity,
): Route => ({
  method: "GET",
  path: "/public-source-documents/:documentId/content",
  corsPolicy: "explicit-origin",
  execute: (request, _url, pathParameters) =>
    Effect.gen(function* () {
      const authentication = yield* resolveIdentity(request, yield* loadApiConfig);
      if (!authentication.authenticated) return json({ error: "not_found" }, { status: 404 });
      let demoCompanyId: string | null = null;
      if (authentication.identity.mode === "demo") {
        demoCompanyId = yield* ensureDemoChat(authentication.identity.userId).pipe(
          Effect.provide(databaseLayer),
          Effect.map((chat) => chat.company_id),
          Effect.catch(() => Effect.succeed(null)),
        );
      }
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
