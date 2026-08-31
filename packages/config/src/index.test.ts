import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  AI_WEB_MAX_DOMAIN_FILTERS_DEFAULT,
  LOCAL_CORS_ALLOWED_ORIGINS,
  LOCAL_DATABASE_URL,
  PRODUCTION_DECISIONS_BLOCKER,
  loadApiConfig,
  loadDatabaseResetConfig,
  loadJobRepositoryConfig,
  loadObjectStorageConfig,
  loadPublicSourceAuditConfig,
  loadWorkerConfig,
} from "./index";

const withEnv = <A>(effect: Effect.Effect<A, unknown>, env: Record<string, string>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))),
  );

describe("final server configuration", () => {
  it("loads demo API defaults and explicit CORS origins", async () => {
    await expect(withEnv(loadApiConfig, {})).resolves.toMatchObject({
      host: "0.0.0.0",
      port: 3000,
      corsAllowedOrigins: [...LOCAL_CORS_ALLOWED_ORIGINS],
      aiWebMaxDomainFilters: AI_WEB_MAX_DOMAIN_FILTERS_DEFAULT,
    });
  });

  it("rejects wildcard CORS and unsafe web fanout", async () => {
    await expect(withEnv(loadApiConfig, { CORS_ALLOWED_ORIGINS: "*" })).rejects.toThrow(
      "CORS_ALLOWED_ORIGINS must contain one or more explicit web origins",
    );
    await expect(withEnv(loadApiConfig, { AI_WEB_MAX_DOMAIN_FILTERS: "33" })).rejects.toThrow(
      "AI_WEB_MAX_DOMAIN_FILTERS must be an integer between 1 and 32",
    );
  });

  it("fails closed for production startup", async () => {
    await expect(withEnv(loadApiConfig, { NODE_ENV: "production" })).rejects.toThrow(
      PRODUCTION_DECISIONS_BLOCKER,
    );
  });

  it("loads worker defaults and the canonical model", async () => {
    await expect(withEnv(loadWorkerConfig, {})).resolves.toMatchObject({
      aiMainModel: "glm-5-turbo",
      aiFastModel: "glm-5-turbo",
      publicSourceIngestionEnabled: true,
      runMigrationsOnStartup: true,
      databaseUrl: LOCAL_DATABASE_URL,
    });
  });

  it("validates provider URLs and retrieval bounds", async () => {
    await expect(
      withEnv(loadWorkerConfig, { AI_BASE_URL: "https://api.z.ai/v4?api_key=secret" }),
    ).rejects.toThrow("AI_BASE_URL must be an HTTPS URL");
    await expect(withEnv(loadWorkerConfig, { AI_RETRIEVAL_MAX_QUERIES: "65" })).rejects.toThrow(
      "AI_RETRIEVAL_MAX_QUERIES must be an integer between 1 and 64",
    );
  });

  it("ignores removed publisher storage settings in worker startup", async () => {
    await expect(
      withEnv(loadWorkerConfig, { RAILWAY_BUCKET_ENDPOINT: "not-a-url" }),
    ).resolves.toMatchObject({
      databaseUrl: LOCAL_DATABASE_URL,
    });
  });

  it("keeps public object storage as the only storage capability", async () => {
    await expect(
      withEnv(loadObjectStorageConfig, {
        RAILWAY_BUCKET_ENDPOINT: "https://objects.test",
        RAILWAY_BUCKET_NAME: "hartlib",
        RAILWAY_BUCKET_ACCESS_KEY_ID: "key",
        RAILWAY_BUCKET_SECRET_ACCESS_KEY: "secret",
      }),
    ).resolves.toMatchObject({ configured: true, bucket: "hartlib" });
  });

  it("keeps reset, job, and source-audit configuration bounded", async () => {
    await expect(withEnv(loadDatabaseResetConfig, { NODE_ENV: "test" })).resolves.toEqual({
      nodeEnv: "test",
      allowProductionReset: false,
    });
    await expect(withEnv(loadJobRepositoryConfig, {})).resolves.toMatchObject({
      jobLockTimeoutMs: 900_000,
    });
    await expect(withEnv(loadPublicSourceAuditConfig, {})).resolves.toMatchObject({
      backfillDays: 7,
      fetchMissing: false,
      fetchTimeoutMs: 15_000,
    });
  });
});
