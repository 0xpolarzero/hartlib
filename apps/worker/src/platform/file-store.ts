import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Context, Effect, Layer } from "effect";
import { loadObjectStorageConfig } from "@hartlib/config";

export interface PlatformFileStoreShape {
  readonly get: (objectKey: string) => Effect.Effect<Uint8Array, Error>;
  readonly delete: (objectKey: string) => Effect.Effect<void, Error>;
}

export class PlatformFileStore extends Context.Service<PlatformFileStore, PlatformFileStoreShape>()(
  "hartlib/worker/PlatformFileStore",
) {}

const configurationError = () =>
  new Error(
    "RAILWAY_BUCKET_ENDPOINT, RAILWAY_BUCKET_NAME, RAILWAY_BUCKET_ACCESS_KEY_ID, and RAILWAY_BUCKET_SECRET_ACCESS_KEY are required for publisher file jobs",
  );

export const PlatformFileStoreLive = Layer.effect(
  PlatformFileStore,
  Effect.gen(function* () {
    const { endpoint, bucket, accessKeyId, secretAccessKey, configured } =
      yield* loadObjectStorageConfig;
    const client = configured
      ? new S3Client({
          endpoint,
          region: "auto",
          forcePathStyle: true,
          credentials: { accessKeyId, secretAccessKey },
        })
      : null;

    return PlatformFileStore.of({
      get: (objectKey) =>
        client === null
          ? Effect.fail(configurationError())
          : Effect.tryPromise({
              try: async () => {
                const response = await client.send(
                  new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
                );
                if (response.Body === undefined) {
                  throw new Error(`publisher file body is missing: ${objectKey}`);
                }
                return response.Body.transformToByteArray();
              },
              catch: (cause) => new Error(`failed to read publisher file: ${objectKey}`, { cause }),
            }),
      delete: (objectKey) =>
        client === null
          ? Effect.fail(configurationError())
          : Effect.tryPromise({
              try: (signal) =>
                client
                  .send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }), {
                    abortSignal: signal,
                  })
                  .then(() => undefined),
              catch: (cause) =>
                new Error(`failed to delete publisher file: ${objectKey}`, { cause }),
            }),
    });
  }),
);

export interface InMemoryPlatformFileStore {
  readonly files: Map<string, Uint8Array>;
  readonly deletedKeys: string[];
  readonly layer: Layer.Layer<PlatformFileStore>;
}

export const makeInMemoryPlatformFileStore = (
  initial: Readonly<Record<string, Uint8Array>> = {},
): InMemoryPlatformFileStore => {
  const files = new Map(Object.entries(initial));
  const deletedKeys: string[] = [];
  const layer = Layer.succeed(
    PlatformFileStore,
    PlatformFileStore.of({
      get: (objectKey) => {
        const bytes = files.get(objectKey);
        return bytes === undefined
          ? Effect.fail(new Error(`publisher file not found: ${objectKey}`))
          : Effect.succeed(bytes);
      },
      delete: (objectKey) =>
        Effect.sync(() => {
          files.delete(objectKey);
          deletedKeys.push(objectKey);
        }),
    }),
  );
  return { files, deletedKeys, layer };
};
