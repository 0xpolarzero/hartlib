import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { loadExportObjectStorageConfig } from "@brief/config";
import {
  createExportRequest,
  exportDescriptor,
  selectExport,
  withExportDownloadLease,
} from "@brief/backend-domain/exports";
import type { CreateExportRequest } from "@brief/shared";
import {
  appendAuthorizationAudit,
  appendDeniedAuthorizationAudit,
  requestIdForAudit,
} from "@brief/workspace";
import {
  EXPORT_ARCHIVE_FILE_EXTENSION,
  EXPORT_ARCHIVE_MEDIA_TYPE,
} from "@brief/shared/export-contract";
import { Effect } from "effect";

import { resolveRequestIdentity, type RequestIdentity } from "../auth";
import { loadApiConfig } from "../config";
import { ApiDatabaseLayer, type ApiDatabaseLayer as ApiDatabaseLayerType } from "../database";
import { corsHeaders, json, type Route } from "../http";
import { withAdministrativeAuditing } from "./administrative-audit";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{16,200}$/;
export const EXPORT_SIGNED_URL_TTL_SECONDS = 5 * 60;
export const EXPORT_SIGNING_TIMEOUT_MS = 20_000;

interface ExportStorageConfiguration {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export type ExportArchiveSigner = (input: {
  readonly signal: AbortSignal;
  readonly configuration: ExportStorageConfiguration;
  readonly objectKey: string;
  readonly fileName: string;
  readonly expiresInSeconds: number;
}) => Promise<string>;

const signExportArchive: ExportArchiveSigner = async (input) => {
  const client = new S3Client({
    endpoint: input.configuration.endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: {
      accessKeyId: input.configuration.accessKeyId,
      secretAccessKey: input.configuration.secretAccessKey,
    },
  });
  const safeFileName = input.fileName.replace(/["\r\n]/gu, "_");
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: input.configuration.bucket,
      Key: input.objectKey,
      ResponseContentType: EXPORT_ARCHIVE_MEDIA_TYPE,
      ResponseContentDisposition: `attachment; filename="${safeFileName}"`,
    }),
    { expiresIn: input.expiresInSeconds },
  );
};

const auditExport = (
  databaseLayer: ApiDatabaseLayerType,
  identity: RequestIdentity,
  input: {
    readonly requestId: string;
    readonly scopeKind: string;
    readonly scopeId: string;
    readonly outcome: "succeeded" | "denied";
    readonly error?: unknown;
  },
) =>
  (input.outcome === "succeeded"
    ? appendAuthorizationAudit({
        identity,
        requestId: input.requestId,
        action: "export.create",
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        outcome: "succeeded",
      })
    : appendDeniedAuthorizationAudit({
        identity,
        requestId: input.requestId,
        action: "export.create",
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        error: input.error,
      })
  ).pipe(Effect.provide(databaseLayer));

export const makeExportRoutes = (
  databaseLayer: ApiDatabaseLayerType = ApiDatabaseLayer,
  signer: ExportArchiveSigner = signExportArchive,
): readonly Route[] =>
  withAdministrativeAuditing(
    [
      {
        method: "POST",
        path: "/v1/exports",
        execute: (request, _url, _pathParameters, input) =>
          Effect.gen(function* () {
            const config = yield* loadApiConfig;
            const identity = yield* resolveRequestIdentity(request, config);
            if (!identity.authenticated) return json({ code: "unauthorized" }, { status: 401 });
            const auditRequestId = requestIdForAudit(request) ?? crypto.randomUUID();
            const body = input.body as CreateExportRequest;
            if (
              body.scopeId.trim().length === 0 ||
              body.scopeId !== body.scopeId.trim() ||
              !idempotencyKeyPattern.test(body.idempotencyKey) ||
              (body.scopeKind !== "user_chats" && !uuidPattern.test(body.scopeId))
            ) {
              yield* auditExport(databaseLayer, identity.identity, {
                requestId: auditRequestId,
                scopeKind: "export_request",
                scopeId: "request",
                outcome: "denied",
                error: new Error("invalid_request"),
              });
              return json({ code: "invalid_request" }, { status: 400 });
            }
            const result = yield* createExportRequest({
              requesterUserId: identity.identity.userId,
              mfaVerified: identity.identity.mfaVerified,
              organizationId: identity.identity.organizationId,
              request: body,
              auditSucceeded: appendAuthorizationAudit({
                identity: identity.identity,
                requestId: auditRequestId,
                action: "export.create",
                scopeKind: body.scopeKind,
                scopeId: body.scopeId,
                outcome: "succeeded",
              }),
            }).pipe(
              Effect.provide(databaseLayer),
              Effect.match({
                onFailure: (error) => ({ ok: false as const, error }),
                onSuccess: (value) => ({ ok: true as const, value }),
              }),
            );
            if (!result.ok) {
              const message =
                result.error instanceof Error ? result.error.message : String(result.error);
              if (
                message === "export_subscription_required" ||
                message === "export_forbidden" ||
                message === "mfa_required"
              ) {
                yield* auditExport(databaseLayer, identity.identity, {
                  requestId: auditRequestId,
                  scopeKind: body.scopeKind,
                  scopeId: body.scopeId,
                  outcome: "denied",
                  error: result.error,
                });
                return json({ code: message }, { status: 403 });
              }
              return yield* Effect.fail(result.error);
            }
            if (result.value.kind === "conflict") {
              yield* auditExport(databaseLayer, identity.identity, {
                requestId: auditRequestId,
                scopeKind: body.scopeKind,
                scopeId: body.scopeId,
                outcome: "denied",
                error: new Error("idempotency_conflict"),
              });
              return json({ code: "idempotency_conflict" }, { status: 409 });
            }
            return json(
              { export: exportDescriptor(result.value.row), duplicate: result.value.duplicate },
              { status: 202 },
            );
          }),
      },
      {
        method: "GET",
        path: "/v1/exports/:exportId",
        execute: (request, _url, pathParameters) =>
          Effect.gen(function* () {
            const config = yield* loadApiConfig;
            const identity = yield* resolveRequestIdentity(request, config);
            if (!identity.authenticated) return json({ code: "unauthorized" }, { status: 401 });
            const id = pathParameters.exportId!;
            const row = yield* selectExport(id, identity.identity.userId).pipe(
              Effect.provide(databaseLayer),
            );
            return row === null
              ? json({ code: "not_found" }, { status: 404 })
              : json({ export: exportDescriptor(row) });
          }),
      },
      {
        method: "GET",
        path: "/v1/exports/:exportId/download",
        execute: (request, _url, pathParameters) =>
          Effect.gen(function* () {
            const config = yield* loadApiConfig;
            const identity = yield* resolveRequestIdentity(request, config);
            if (!identity.authenticated) return json({ code: "unauthorized" }, { status: 401 });
            const id = pathParameters.exportId!;
            const signedResult = yield* withExportDownloadLease(
              id,
              identity.identity.userId,
              (row) =>
                Effect.gen(function* () {
                  const storage = yield* loadExportObjectStorageConfig;
                  if (!storage.configured) return { kind: "storage_unavailable" } as const;
                  const signed = yield* Effect.tryPromise((signal) =>
                    signer({
                      signal,
                      configuration: storage,
                      objectKey: row.objectKey!,
                      fileName: `brief-export-${row.id}${EXPORT_ARCHIVE_FILE_EXTENSION}`,
                      expiresInSeconds: EXPORT_SIGNED_URL_TTL_SECONDS,
                    }),
                  ).pipe(Effect.timeout(`${EXPORT_SIGNING_TIMEOUT_MS} millis`));
                  return { kind: "signed", url: signed } as const;
                }),
            ).pipe(Effect.provide(databaseLayer));
            if (signedResult === null) {
              return json({ code: "export_unavailable" }, { status: 404 });
            }
            if (signedResult.kind === "storage_unavailable") {
              return json({ code: "export_storage_unavailable" }, { status: 503 });
            }
            return new Response(null, {
              status: 302,
              headers: corsHeaders({
                location: signedResult.url,
                "cache-control": "private, no-store",
                "referrer-policy": "no-referrer",
              }),
            });
          }),
      },
    ],
    databaseLayer,
  );

export const exportRoutes = makeExportRoutes();
