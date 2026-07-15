import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryPublicSourceIngestionRepositoryLayer } from "../source-ingestion/repository";
import { makeInMemoryPlatformFileStore } from "../platform/file-store";
import { makePdfTextExtractorLayer } from "../platform/pdf-text";
import { ExportObjectStoreService, NotificationEmailService } from "../platform/adapters";
import { JobRepository } from "./repository";
import { runWorkerSafeTick, runWorkerTick } from "./runner";
import type { JobRecord } from "./types";

const handleJobMock = vi.hoisted(() => vi.fn());

vi.mock("./handlers", () => {
  return {
    handleJob: (...args: unknown[]) => handleJobMock(...args),
  };
});

const claimedJob = {
  id: "job-1",
  kind: "ai_chat_run",
  payload: { aiRunId: "test-run" },
  attempts: 1,
  lockedBy: "worker-a",
} satisfies JobRecord;

const platformTestLayers = () =>
  [
    makeInMemoryPlatformFileStore().layer,
    makePdfTextExtractorLayer(() => Effect.succeed([])),
    Layer.succeed(
      NotificationEmailService,
      NotificationEmailService.of({ send: () => Promise.reject(new Error("unused")) }),
    ),
    Layer.succeed(
      ExportObjectStoreService,
      ExportObjectStoreService.of({
        verifyPhysicalDeletionSafety: () => Promise.reject(new Error("unused")),
        get: () => Promise.reject(new Error("unused")),
        head: () => Promise.reject(new Error("unused")),
        delete: () => Promise.reject(new Error("unused")),
        put: () => Promise.reject(new Error("unused")),
      }),
    ),
  ] as const;

const makeLostOwnershipLayer = (completedAttempts: { count: number }) =>
  Layer.succeed(
    JobRepository,
    JobRepository.of({
      lockRenewalIntervalMs: 10,
      enqueue: (input) =>
        Effect.succeed({
          id: "enqueued",
          kind: input.kind,
          payload: input.payload,
          attempts: 0,
        }),
      claimNext: Effect.succeed(claimedJob),
      heartbeat: () => Effect.void,
      markCompleted: () =>
        Effect.sync(() => {
          completedAttempts.count += 1;
        }).pipe(
          Effect.flatMap(() =>
            Effect.fail(new Error("Cannot complete job job-1: lock ownership was lost")),
          ),
        ),
      markFailed: () => Effect.void,
    }),
  );

describe("worker runner", () => {
  beforeEach(() => {
    handleJobMock.mockReset();
    handleJobMock.mockReturnValue(Effect.succeed({ status: "completed" as const }));
  });

  it("surfaces lock ownership loss from a raw worker tick", async () => {
    const completedAttempts = { count: 0 };
    const layer = Layer.mergeAll(
      makeLostOwnershipLayer(completedAttempts),
      InMemoryPublicSourceIngestionRepositoryLayer(),
      ...platformTestLayers(),
    );

    await expect(Effect.runPromise(runWorkerTick.pipe(Effect.provide(layer)))).rejects.toThrow(
      "lock ownership was lost",
    );

    expect(completedAttempts.count).toBe(1);
  });

  it("keeps the worker loop alive when a tick loses job lock ownership", async () => {
    const completedAttempts = { count: 0 };
    const layer = Layer.mergeAll(
      makeLostOwnershipLayer(completedAttempts),
      InMemoryPublicSourceIngestionRepositoryLayer(),
      ...platformTestLayers(),
    );

    await Effect.runPromise(runWorkerSafeTick.pipe(Effect.provide(layer)));

    expect(completedAttempts.count).toBe(1);
  });

  it("surfaces lock ownership loss from the job heartbeat", async () => {
    handleJobMock.mockReturnValueOnce(Effect.never);
    const layer = Layer.mergeAll(
      Layer.succeed(
        JobRepository,
        JobRepository.of({
          lockRenewalIntervalMs: 1,
          enqueue: (input) =>
            Effect.succeed({
              id: "enqueued",
              kind: input.kind,
              payload: input.payload,
              attempts: 0,
            }),
          claimNext: Effect.succeed({
            id: "job-2",
            kind: "public_source_ingestion",
            payload: { sourceId: "service_public", mode: "poll" },
            attempts: 1,
            lockedBy: "worker-a",
          }),
          heartbeat: () =>
            Effect.fail(new Error("Cannot heartbeat job job-2: lock ownership was lost")),
          markCompleted: () => Effect.void,
          markFailed: () =>
            Effect.fail(new Error("Cannot fail job job-2: lock ownership was lost")),
        }),
      ),
      InMemoryPublicSourceIngestionRepositoryLayer(),
      ...platformTestLayers(),
    );

    await expect(Effect.runPromise(runWorkerTick.pipe(Effect.provide(layer)))).rejects.toThrow(
      "lock ownership was lost",
    );
  });
});
