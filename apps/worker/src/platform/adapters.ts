import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Context, Effect, Layer } from "effect";
import { loadExportObjectStorageConfig, loadNotificationConfig } from "@brief/config";
import { Resend } from "resend";

export interface NotificationEmail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly idempotencyKey: string;
}

export interface NotificationEmailAdapter {
  readonly send: (
    email: NotificationEmail,
    options: { readonly signal: AbortSignal },
  ) => Promise<{ readonly providerMessageId: string }>;
}

export class NotificationEmailService extends Context.Service<
  NotificationEmailService,
  NotificationEmailAdapter
>()("brief/worker/NotificationEmailService") {}

export const makeResendEmailAdapter = (options: {
  readonly apiKey: string;
  readonly from: string;
}): NotificationEmailAdapter => {
  const resend = new Resend(options.apiKey);
  return {
    send: async (email, request) => {
      const requestOptions = {
        idempotencyKey: email.idempotencyKey,
        signal: request.signal,
      } as Parameters<typeof resend.emails.send>[1] & { readonly signal: AbortSignal };
      const response = await resend.emails.send(
        {
          from: options.from,
          to: email.to,
          subject: email.subject,
          html: email.html,
          text: email.text,
        },
        requestOptions,
      );
      if (response.error !== null) {
        const error = new Error(response.error.message);
        Object.assign(error, { code: response.error.name });
        throw error;
      }
      if (response.data === null) throw new Error("Resend returned no message ID");
      return { providerMessageId: response.data.id };
    },
  };
};

export const NotificationEmailServiceLive = Layer.effect(
  NotificationEmailService,
  Effect.gen(function* () {
    const { apiKey, from } = yield* loadNotificationConfig;
    if (apiKey.trim() === "" || from.trim() === "") {
      return NotificationEmailService.of({
        send: () => Promise.reject(new Error("RESEND_API_KEY and RESEND_FROM_EMAIL are required")),
      });
    }
    return NotificationEmailService.of(makeResendEmailAdapter({ apiKey, from }));
  }),
);

export interface ExportObjectStore {
  readonly verifyPhysicalDeletionSafety: (options: {
    readonly signal: AbortSignal;
  }) => Promise<void>;
  readonly get: (
    objectKey: string,
    options: { readonly signal: AbortSignal },
  ) => Promise<Uint8Array>;
  readonly head: (
    objectKey: string,
    options: { readonly signal: AbortSignal },
  ) => Promise<{
    readonly byteSize: number;
    readonly sha256Hex: string | null;
    readonly generation: string | null;
  } | null>;
  readonly delete: (objectKey: string, options: { readonly signal: AbortSignal }) => Promise<void>;
  readonly put: (
    input: {
      readonly objectKey: string;
      readonly body: Uint8Array;
      readonly contentType: string;
      readonly sha256Hex: string;
      readonly generation: number;
    },
    options: { readonly signal: AbortSignal },
  ) => Promise<void>;
}

export class ExportObjectStoreService extends Context.Service<
  ExportObjectStoreService,
  ExportObjectStore
>()("brief/worker/ExportObjectStoreService") {}

const bytesFromBody = async (body: unknown): Promise<Uint8Array> => {
  if (
    typeof body === "object" &&
    body !== null &&
    "transformToByteArray" in body &&
    typeof body.transformToByteArray === "function"
  ) {
    return new Uint8Array(await body.transformToByteArray());
  }
  throw new Error("S3 object body cannot be converted to bytes");
};

const isMissingObject = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly name?: unknown;
    readonly Code?: unknown;
    readonly $metadata?: { readonly httpStatusCode?: unknown };
  };
  return (
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey" ||
    candidate.Code === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
};

export const makeS3ExportObjectStore = (options: {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region?: string;
}): ExportObjectStore => {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region ?? "auto",
    forcePathStyle: true,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });
  return {
    verifyPhysicalDeletionSafety: async ({ signal }) => {
      const versioning = await client.send(
        new GetBucketVersioningCommand({ Bucket: options.bucket }),
        { abortSignal: signal },
      );
      if (versioning.Status !== undefined || versioning.MFADelete !== undefined) {
        throw new Error("export_object_bucket_versioning_must_be_disabled");
      }
    },
    get: async (objectKey, { signal }) => {
      const response = await client.send(
        new GetObjectCommand({ Bucket: options.bucket, Key: objectKey }),
        { abortSignal: signal },
      );
      return bytesFromBody(response.Body);
    },
    head: async (objectKey, { signal }) => {
      try {
        const response = await client.send(
          new HeadObjectCommand({ Bucket: options.bucket, Key: objectKey }),
          { abortSignal: signal },
        );
        return {
          byteSize: response.ContentLength ?? 0,
          sha256Hex: response.Metadata?.["brief-sha256"] ?? null,
          generation: response.Metadata?.["brief-generation"] ?? null,
        };
      } catch (error) {
        if (isMissingObject(error)) return null;
        throw error;
      }
    },
    delete: async (objectKey, { signal }) => {
      await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: objectKey }), {
        abortSignal: signal,
      });
    },
    put: async ({ objectKey, body, contentType, sha256Hex, generation }, { signal }) => {
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: objectKey,
          Body: body,
          ContentType: contentType,
          ServerSideEncryption: "AES256",
          IfNoneMatch: "*",
          Metadata: {
            "brief-sha256": sha256Hex,
            "brief-generation": String(generation),
          },
        }),
        { abortSignal: signal },
      );
    },
  };
};

export const ExportObjectStoreServiceLive = Layer.effect(
  ExportObjectStoreService,
  Effect.gen(function* () {
    const { endpoint, bucket, accessKeyId, secretAccessKey, configured } =
      yield* loadExportObjectStorageConfig;
    if (!configured) {
      return ExportObjectStoreService.of({
        verifyPhysicalDeletionSafety: () =>
          Promise.reject(new Error("export object storage is not configured")),
        get: () => Promise.reject(new Error("export object storage is not configured")),
        head: () => Promise.reject(new Error("export object storage is not configured")),
        delete: () => Promise.reject(new Error("export object storage is not configured")),
        put: () => Promise.reject(new Error("export object storage is not configured")),
      });
    }
    return ExportObjectStoreService.of(
      makeS3ExportObjectStore({ endpoint, bucket, accessKeyId, secretAccessKey }),
    );
  }),
);
