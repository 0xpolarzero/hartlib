import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createClerkClient } from "@clerk/backend";
import { loadObjectStorageConfig } from "@hartlib/config";
import type {
  CreatePublisherIssueRequest,
  CreatePublisherSubscriptionRequest,
  InvitePublisherClientAccessRequest,
  PausePublisherClientAccessRequest,
  SchedulePublisherIssueRequest,
  UpdatePublisherIssueRequest,
} from "@hartlib/shared";
import {
  createPublisherIssue,
  createPublisherSubscription,
  deletePublisherDocument,
  deletePublisherIssue,
  getPublisherAiPullMetrics,
  getPublisherIssue,
  invitePublisherClientAccess,
  listPublisherClientAccesses,
  listPublisherIssues,
  listPublisherSubscriptions,
  pausePublisherClientAccess,
  publishPublisherIssue,
  schedulePublisherIssue,
  updatePublisherIssue,
  uploadPublisherDocument,
  WorkspaceAuthorizationError,
  WorkspaceRuleError,
  type PublisherClientOnboardingProvider,
  type PublisherPdfObjectStore,
} from "@hartlib/workspace";
import { requestIdForAudit } from "@hartlib/workspace";
import { Effect } from "effect";

import { resolveRequestIdentity } from "../auth";
import { loadApiConfig } from "../config";
import {
  ApiDatabaseLayer,
  type ApiDatabaseLayer as ApiDatabaseLayerType,
  type ApiDatabaseService,
} from "../database";
import { json, type Route } from "../http";
import { withAdministrativeAuditing } from "./administrative-audit";
import { createOrRecoverClerkOrganizationInvitation } from "./clerk-invitation-provider";

export { MAX_PUBLISHER_PDF_BYTES } from "@hartlib/workspace";
export type {
  PublisherClientOnboardingProvider,
  PublisherPdfObjectStore,
} from "@hartlib/workspace";

type PgLayer = ApiDatabaseLayerType;
const PgLayer = ApiDatabaseLayer;

const identity = (request: Request) =>
  Effect.gen(function* () {
    const config = yield* loadApiConfig;
    return yield* resolveRequestIdentity(request, config);
  });

const resultOf = <A, E>(effect: Effect.Effect<A, E, ApiDatabaseService>, pgLayer: PgLayer) =>
  effect.pipe(
    Effect.provide(pgLayer),
    Effect.match({
      onFailure: (error) => ({ ok: false as const, error }),
      onSuccess: (value) => ({ ok: true as const, value }),
    }),
  );

const authFailure = (error: unknown): Response | null =>
  error instanceof WorkspaceAuthorizationError
    ? json({ code: error.code }, { status: error.code === "mfa_required" ? 403 : 404 })
    : null;

const ruleFailure = (error: unknown): Response | null => {
  if (!(error instanceof WorkspaceRuleError)) return null;
  if (
    error.code === "invalid_body" ||
    error.code === "upload_metadata_invalid" ||
    error.code === "upload_size_mismatch" ||
    error.code === "upload_hash_mismatch" ||
    error.code === "pdf_signature_invalid"
  ) {
    return json({ code: error.code }, { status: 400 });
  }
  if (
    error.code === "published_issue_immutable" ||
    error.code === "issue_not_schedulable" ||
    error.code === "issue_requires_pdf" ||
    error.code === "historical_publication_time_invalid" ||
    error.code === "client_access_not_active" ||
    error.code === "delivery_end_invalid" ||
    error.code === "client_access_exists" ||
    error.code === "client_company_ambiguous" ||
    error.code === "idempotency_conflict" ||
    error.code === "document_upload_in_progress" ||
    error.code === "invite_conflict" ||
    error.code === "invitation_delivery_in_progress"
  ) {
    return json({ code: error.code }, { status: 409 });
  }
  if (
    error.code === "document_storage_unavailable" ||
    error.code === "document_upload_failed" ||
    error.code === "invitation_provider_unavailable" ||
    error.code === "invitation_delivery_failed"
  ) {
    return json({ code: error.code }, { status: 503 });
  }
  return null;
};

const liveClientOnboardingProvider = (secretKey: string): PublisherClientOnboardingProvider => {
  const clerk = createClerkClient({ secretKey });
  return {
    ensureOrganization: async (input) => {
      const slug = `hartlib-client-${input.companyId}`;
      try {
        return (await clerk.organizations.getOrganization({ slug })).id;
      } catch {
        try {
          return (
            await clerk.organizations.createOrganization({
              name: input.name,
              slug,
              createdBy: input.creatorUserId,
            })
          ).id;
        } catch (error) {
          try {
            return (await clerk.organizations.getOrganization({ slug })).id;
          } catch {
            throw error;
          }
        }
      }
    },
    createInvitation: async (input) => {
      return createOrRecoverClerkOrganizationInvitation(clerk.organizations, {
        organizationId: input.organizationId,
        email: input.email,
        role: "org:admin",
        inviterUserId: input.inviterUserId,
        redirectUrl: input.redirectUrl,
        workspaceInvitationId: input.workspaceInvitationId,
      });
    },
  };
};

const livePdfStore = (configuration: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): PublisherPdfObjectStore => {
  const client = new S3Client({
    endpoint: configuration.endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: {
      accessKeyId: configuration.accessKeyId,
      secretAccessKey: configuration.secretAccessKey,
    },
  });
  return {
    put: ({ objectKey, body, sha256Hex, signal }) =>
      client
        .send(
          new PutObjectCommand({
            Bucket: configuration.bucket,
            Key: objectKey,
            Body: body,
            ContentType: "application/pdf",
            Metadata: { sha256: sha256Hex },
            ServerSideEncryption: "AES256",
          }),
          { abortSignal: signal },
        )
        .then(() => undefined),
    head: ({ objectKey, signal }) =>
      client
        .send(new HeadObjectCommand({ Bucket: configuration.bucket, Key: objectKey }), {
          abortSignal: signal,
        })
        .then((result) => ({
          byteSize: Number(result.ContentLength ?? -1),
          sha256Hex: result.Metadata?.sha256?.toLowerCase() ?? "",
          mediaType: result.ContentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "",
        }))
        .catch((error: unknown) => {
          const status = (error as { readonly $metadata?: { readonly httpStatusCode?: number } })
            .$metadata?.httpStatusCode;
          if (status === 404 || (error as { readonly name?: string }).name === "NotFound") {
            return null;
          }
          throw error;
        }),
    delete: ({ objectKey, signal }) =>
      client
        .send(new DeleteObjectCommand({ Bucket: configuration.bucket, Key: objectKey }), {
          abortSignal: signal,
        })
        .then(() => undefined),
  };
};

const loadPdfStore = Effect.gen(function* () {
  const storage = yield* loadObjectStorageConfig;
  return storage.configured ? livePdfStore(storage) : null;
});

const mutationResult = <A, E>(effect: Effect.Effect<A, E, ApiDatabaseService>, pgLayer: PgLayer) =>
  resultOf(effect, pgLayer);

export const makePublisherWorkspaceRoutes = (
  pgLayer: PgLayer = PgLayer,
  injectedPdfStore?: PublisherPdfObjectStore,
  injectedClientOnboardingProvider?: PublisherClientOnboardingProvider,
): readonly Route[] => {
  const routes: Route[] = [];

  routes.push({
    method: "GET",
    path: "/v1/publisher-companies/:companyId/subscriptions",
    execute: (request, _url, pathParameters) =>
      Effect.gen(function* () {
        const authenticated = yield* identity(request);
        if (!authenticated.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const result = yield* resultOf(
          listPublisherSubscriptions(authenticated.identity, pathParameters.companyId!),
          pgLayer,
        );
        if (!result.ok) return authFailure(result.error) ?? (yield* Effect.fail(result.error));
        return json({ subscriptions: result.value });
      }),
  });

  routes.push({
    method: "POST",
    path: "/v1/publisher-companies/:companyId/subscriptions",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const authenticated = yield* identity(request);
        if (!authenticated.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const body = input.body as CreatePublisherSubscriptionRequest;
        const result = yield* mutationResult(
          createPublisherSubscription({
            identity: authenticated.identity,
            companyId: pathParameters.companyId!,
            name: body.name,
            requestId,
          }),
          pgLayer,
        );
        if (!result.ok) {
          return (
            authFailure(result.error) ??
            ruleFailure(result.error) ??
            (yield* Effect.fail(result.error))
          );
        }
        return json({ subscription: result.value }, { status: 201 });
      }),
  });

  routes.push({
    method: "GET",
    path: "/v1/publisher-subscriptions/:subscriptionId/issues",
    execute: (request, _url, pathParameters) =>
      Effect.gen(function* () {
        const authenticated = yield* identity(request);
        if (!authenticated.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const result = yield* resultOf(
          listPublisherIssues(authenticated.identity, pathParameters.subscriptionId!),
          pgLayer,
        );
        if (!result.ok) return authFailure(result.error) ?? (yield* Effect.fail(result.error));
        return json({ issues: result.value });
      }),
  });

  routes.push({
    method: "POST",
    path: "/v1/publisher-subscriptions/:subscriptionId/issues",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const authenticated = yield* identity(request);
        if (!authenticated.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const body = input.body as CreatePublisherIssueRequest;
        const publicationAt = body.publicationAt === null ? null : new Date(body.publicationAt);
        const result = yield* mutationResult(
          createPublisherIssue({
            identity: authenticated.identity,
            subscriptionId: pathParameters.subscriptionId!,
            title: body.title,
            publicationAt,
            historical: body.historical,
            requestId,
          }),
          pgLayer,
        );
        if (!result.ok) {
          return (
            authFailure(result.error) ??
            ruleFailure(result.error) ??
            (yield* Effect.fail(result.error))
          );
        }
        return json({ issue: result.value }, { status: 201 });
      }),
  });

  routes.push({
    method: "GET",
    path: "/v1/publisher-issues/:issueId",
    execute: (request, _url, pathParameters) =>
      Effect.gen(function* () {
        const authenticated = yield* identity(request);
        if (!authenticated.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const result = yield* resultOf(
          getPublisherIssue(authenticated.identity, pathParameters.issueId!),
          pgLayer,
        );
        if (!result.ok) return authFailure(result.error) ?? (yield* Effect.fail(result.error));
        return json(result.value);
      }),
  });

  routes.push({
    method: "PATCH",
    path: "/v1/publisher-issues/:issueId",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const authenticated = yield* identity(request);
        if (!authenticated.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const body = input.body as UpdatePublisherIssueRequest;
        const result = yield* mutationResult(
          updatePublisherIssue({
            identity: authenticated.identity,
            issueId: pathParameters.issueId!,
            title: body.title,
            requestId,
          }),
          pgLayer,
        );
        if (!result.ok) {
          return (
            authFailure(result.error) ??
            ruleFailure(result.error) ??
            (yield* Effect.fail(result.error))
          );
        }
        return json({ issue: result.value });
      }),
  });

  routes.push({
    method: "DELETE",
    path: "/v1/publisher-issues/:issueId",
    execute: (request, _url, pathParameters) =>
      Effect.gen(function* () {
        const authenticated = yield* identity(request);
        if (!authenticated.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const result = yield* mutationResult(
          deletePublisherIssue({
            identity: authenticated.identity,
            issueId: pathParameters.issueId!,
            requestId,
          }),
          pgLayer,
        );
        if (!result.ok) {
          return (
            authFailure(result.error) ??
            ruleFailure(result.error) ??
            (yield* Effect.fail(result.error))
          );
        }
        return new Response(null, { status: 204 });
      }),
  });

  routes.push({
    method: "POST",
    path: "/v1/publisher-issues/:issueId/schedule",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const authenticated = yield* identity(request);
        if (!authenticated.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const body = input.body as SchedulePublisherIssueRequest;
        const result = yield* mutationResult(
          schedulePublisherIssue({
            identity: authenticated.identity,
            issueId: pathParameters.issueId!,
            publicationAt: new Date(body.publicationAt),
            requestId,
          }),
          pgLayer,
        );
        if (!result.ok) {
          return (
            authFailure(result.error) ??
            ruleFailure(result.error) ??
            (yield* Effect.fail(result.error))
          );
        }
        return json({ status: "scheduled", publicationAt: result.value }, { status: 202 });
      }),
  });

  routes.push({
    method: "POST",
    path: "/v1/publisher-issues/:issueId/publish",
    execute: (request, _url, pathParameters) =>
      Effect.gen(function* () {
        const authenticated = yield* identity(request);
        if (!authenticated.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const result = yield* mutationResult(
          publishPublisherIssue({
            identity: authenticated.identity,
            issueId: pathParameters.issueId!,
            requestId,
          }),
          pgLayer,
        );
        if (!result.ok) {
          return (
            authFailure(result.error) ??
            ruleFailure(result.error) ??
            (yield* Effect.fail(result.error))
          );
        }
        return json({ status: result.value }, { status: result.value === "published" ? 200 : 202 });
      }),
  });

  routes.push({
    method: "POST",
    path: "/v1/publisher-issues/:issueId/documents",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const authenticated = yield* identity(request);
        if (!authenticated.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const headers = input.headers as {
          readonly "x-hartlib-title": string;
          readonly "x-file-name": string;
          readonly "x-content-sha256": string;
          readonly "idempotency-key": string;
        };
        const body = input.bodyBytes ?? new Uint8Array();
        const store = injectedPdfStore ?? (yield* loadPdfStore);
        const result = yield* mutationResult(
          uploadPublisherDocument({
            identity: authenticated.identity,
            issueId: pathParameters.issueId!,
            idempotencyKey: headers["idempotency-key"],
            title: headers["x-hartlib-title"],
            fileName: headers["x-file-name"],
            expectedHash: headers["x-content-sha256"],
            declaredBytes: input.declaredBodyBytes ?? body.byteLength,
            body,
            requestId,
            requestSignal: request.signal,
            store,
          }),
          pgLayer,
        );
        if (!result.ok) {
          return (
            authFailure(result.error) ??
            ruleFailure(result.error) ??
            (yield* Effect.fail(result.error))
          );
        }
        return json({ document: result.value }, { status: 201 });
      }),
  });

  routes.push({
    method: "DELETE",
    path: "/v1/publisher-issues/:issueId/documents/:documentId",
    execute: (request, _url, pathParameters) =>
      Effect.gen(function* () {
        const authenticated = yield* identity(request);
        if (!authenticated.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const result = yield* mutationResult(
          deletePublisherDocument({
            identity: authenticated.identity,
            issueId: pathParameters.issueId!,
            documentId: pathParameters.documentId!,
            requestId,
          }),
          pgLayer,
        );
        if (!result.ok) {
          return (
            authFailure(result.error) ??
            ruleFailure(result.error) ??
            (yield* Effect.fail(result.error))
          );
        }
        return new Response(null, { status: 204 });
      }),
  });

  routes.push({
    method: "GET",
    path: "/v1/publisher-subscriptions/:subscriptionId/client-accesses",
    execute: (request, _url, pathParameters) =>
      Effect.gen(function* () {
        const authenticated = yield* identity(request);
        if (!authenticated.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const result = yield* resultOf(
          listPublisherClientAccesses(authenticated.identity, pathParameters.subscriptionId!),
          pgLayer,
        );
        if (!result.ok) return authFailure(result.error) ?? (yield* Effect.fail(result.error));
        return json({ accesses: result.value });
      }),
  });

  routes.push({
    method: "POST",
    path: "/v1/publisher-subscriptions/:subscriptionId/client-accesses",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const authenticated = yield* identity(request);
        if (!authenticated.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const body = input.body as InvitePublisherClientAccessRequest;
        const config = yield* loadApiConfig;
        const provider =
          injectedClientOnboardingProvider ??
          (config.clerkSecretKey === ""
            ? null
            : liveClientOnboardingProvider(config.clerkSecretKey));
        const result = yield* mutationResult(
          invitePublisherClientAccess({
            identity: authenticated.identity,
            subscriptionId: pathParameters.subscriptionId!,
            clientCompanyName: body.clientCompanyName,
            firstAdminEmail: body.firstAdminEmail,
            idempotencyKey: body.idempotencyKey,
            requestId,
            provider,
            redirectUrl: config.clerkInvitationRedirectUrl,
          }),
          pgLayer,
        );
        if (!result.ok) {
          return (
            authFailure(result.error) ??
            ruleFailure(result.error) ??
            (yield* Effect.fail(result.error))
          );
        }
        return json(result.value, { status: result.value.duplicate ? 200 : 201 });
      }),
  });

  routes.push({
    method: "POST",
    path: "/v1/client-subscription-accesses/:accessId/pause",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const authenticated = yield* identity(request);
        if (!authenticated.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const body = input.body as PausePublisherClientAccessRequest;
        const result = yield* mutationResult(
          pausePublisherClientAccess({
            identity: authenticated.identity,
            accessId: pathParameters.accessId!,
            deliveryEndAt: body.deliveryEndAt,
            requestId,
          }),
          pgLayer,
        );
        if (!result.ok) {
          return (
            authFailure(result.error) ??
            ruleFailure(result.error) ??
            (yield* Effect.fail(result.error))
          );
        }
        return json({ status: "ending", deliveryEndAt: result.value });
      }),
  });

  routes.push({
    method: "GET",
    path: "/v1/publisher-subscriptions/:subscriptionId/ai-pull-metrics",
    execute: (request, _url, pathParameters) =>
      Effect.gen(function* () {
        const authenticated = yield* identity(request);
        if (!authenticated.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const result = yield* resultOf(
          getPublisherAiPullMetrics(authenticated.identity, pathParameters.subscriptionId!),
          pgLayer,
        );
        if (!result.ok) return authFailure(result.error) ?? (yield* Effect.fail(result.error));
        return json(result.value);
      }),
  });

  return withAdministrativeAuditing(routes, pgLayer);
};

export const publisherWorkspaceRoutes = makePublisherWorkspaceRoutes();
