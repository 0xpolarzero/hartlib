import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { InMemoryPublicSourceIngestionRepositoryLayer } from "../source-ingestion/repository";
import { JobRepository } from "./repository";
import { runWorkerSafeTick, runWorkerTick } from "./runner";
import type { JobRecord } from "./types";

const claimedJob = {
  id: "job-1",
  kind: "publish_scheduled_issue",
  payload: {},
  attempts: 1,
  lockedBy: "worker-a",
} satisfies JobRecord;

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
  it("surfaces lock ownership loss from a raw worker tick", async () => {
    const completedAttempts = { count: 0 };
    const layer = Layer.merge(
      makeLostOwnershipLayer(completedAttempts),
      InMemoryPublicSourceIngestionRepositoryLayer(),
    );

    await expect(Effect.runPromise(runWorkerTick.pipe(Effect.provide(layer)))).rejects.toThrow(
      "lock ownership was lost",
    );

    expect(completedAttempts.count).toBe(1);
  });

  it("keeps the worker loop alive when a tick loses job lock ownership", async () => {
    const completedAttempts = { count: 0 };
    const layer = Layer.merge(
      makeLostOwnershipLayer(completedAttempts),
      InMemoryPublicSourceIngestionRepositoryLayer(),
    );

    await Effect.runPromise(runWorkerSafeTick.pipe(Effect.provide(layer)));

    expect(completedAttempts.count).toBe(1);
  });

  it("surfaces lock ownership loss from the job heartbeat", async () => {
    const layer = Layer.merge(
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
            payload: { sourceId: "tresor", mode: "poll" },
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
    );

    await expect(Effect.runPromise(runWorkerTick.pipe(Effect.provide(layer)))).rejects.toThrow(
      "lock ownership was lost",
    );
  });
});
