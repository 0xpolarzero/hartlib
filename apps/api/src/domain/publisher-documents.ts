import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { withAuthorizedPublisherDocumentLease } from "@brief/backend-domain/publisher-documents";
import { loadObjectStorageConfig } from "@brief/config";
import { Effect } from "effect";

import { resolveRequestIdentity } from "../auth";
import { loadApiConfig } from "../config";
import { ApiDatabaseLayer, type ApiDatabaseLayer as ApiDatabaseLayerType } from "../database";
import { json, type Route } from "../http";

export const PUBLISHER_DOCUMENT_SIGNED_URL_TTL_SECONDS = 5 * 60;
export const PUBLISHER_DOCUMENT_SIGNING_TIMEOUT_MS = 20_000;

interface FileStoreConfiguration {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export type PublisherDocumentSigner = (input: {
  readonly signal: AbortSignal;
  readonly configuration: FileStoreConfiguration;
  readonly objectKey: string;
  readonly mediaType: string;
  readonly fileName: string;
  readonly expiresInSeconds: number;
}) => Promise<string>;

const signPublisherDocument: PublisherDocumentSigner = async (input) => {
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
      ResponseContentType: input.mediaType,
      ResponseContentDisposition: `inline; filename="${safeFileName}"`,
    }),
    { expiresIn: input.expiresInSeconds },
  );
};

const loadFileStoreConfiguration = Effect.gen(function* () {
  const storage = yield* loadObjectStorageConfig;
  return storage.configured ? storage : null;
});

export const makePublisherDocumentContentRoute = (
  databaseLayer: ApiDatabaseLayerType = ApiDatabaseLayer,
  signer: PublisherDocumentSigner = signPublisherDocument,
): Route => ({
  method: "GET",
  path: "/v1/issues/:issueId/documents/:documentId/content",
  corsPolicy: "explicit-origin",
  execute: (request, _url, pathParameters) =>
    Effect.gen(function* () {
      const config = yield* loadApiConfig;
      const authentication = yield* resolveRequestIdentity(request, config);
      if (!authentication.authenticated) {
        return json({ error: "unauthorized" }, { status: 401 });
      }
      const issueId = pathParameters.issueId!;
      const documentId = pathParameters.documentId!;
      const signedResult = yield* withAuthorizedPublisherDocumentLease(
        authentication.identity,
        issueId,
        documentId,
        (document) =>
          Effect.gen(function* () {
            const fileStore = yield* loadFileStoreConfiguration;
            if (fileStore === null) return { kind: "storage_unavailable" } as const;
            const url = yield* Effect.tryPromise({
              try: (signal) =>
                signer({
                  signal,
                  configuration: fileStore,
                  objectKey: document.objectKey,
                  mediaType: document.mediaType,
                  fileName: document.fileName,
                  expiresInSeconds: PUBLISHER_DOCUMENT_SIGNED_URL_TTL_SECONDS,
                }),
              catch: (cause) => new Error("publisher document signing failed", { cause }),
            }).pipe(Effect.timeout(`${PUBLISHER_DOCUMENT_SIGNING_TIMEOUT_MS} millis`));
            return { kind: "signed", url } as const;
          }),
      ).pipe(Effect.provide(databaseLayer));
      if (signedResult === null) return json({ error: "not_found" }, { status: 404 });
      if (signedResult.kind === "storage_unavailable") {
        return json({ error: "document_storage_unavailable" }, { status: 503 });
      }
      return new Response(null, {
        status: 302,
        headers: {
          "cache-control": "private, no-store",
          location: signedResult.url,
          "referrer-policy": "no-referrer",
        },
      });
    }),
});

export const publisherDocumentContentRoute = makePublisherDocumentContentRoute();
