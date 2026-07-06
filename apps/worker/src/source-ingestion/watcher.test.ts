import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { JobRepository } from "../jobs/repository";
import type { EnqueueJobInput, JobRecord } from "../jobs/types";
import { runPublicSourceSafePollTick, runPublicSourceStartupBackfill } from "./watcher";

const makeJobLayer = (
  enqueued: EnqueueJobInput[],
  options: { readonly failEnqueue?: boolean } = {},
) =>
  Layer.succeed(
    JobRepository,
    JobRepository.of({
      lockRenewalIntervalMs: 10,
      enqueue: (input) =>
        options.failEnqueue
          ? Effect.fail(new Error("database unavailable"))
          : Effect.sync(() => {
              enqueued.push(input);
              return {
                id: `${enqueued.length}`,
                kind: input.kind,
                payload: input.payload,
                attempts: 0,
              } satisfies JobRecord;
            }),
      claimNext: Effect.succeed(undefined),
      heartbeat: () => Effect.void,
      markCompleted: () => Effect.void,
      markFailed: () => Effect.void,
    }),
  );

describe("public source watcher scheduling", () => {
  it("enqueues one durable startup backfill job per reliable public source", async () => {
    const enqueued: EnqueueJobInput[] = [];

    await Effect.runPromise(
      runPublicSourceStartupBackfill({
        enabled: true,
        pollIntervalMs: 300_000,
        startupBackfillDays: 7,
      }).pipe(Effect.provide(makeJobLayer(enqueued))),
    );

    expect(enqueued).toHaveLength(7);
    expect(enqueued.every((job) => job.kind === "public_source_ingestion")).toBe(true);
    expect(enqueued.every((job) => job.uniqueKey?.endsWith(":backfill"))).toBe(true);
    expect(new Set(enqueued.map((job) => job.uniqueKey)).size).toBe(enqueued.length);
    expect(enqueued.every((job) => (job.payload as { mode: string }).mode === "backfill")).toBe(
      true,
    );
    expect(
      enqueued.every((job) => typeof (job.payload as { since: string }).since === "string"),
    ).toBe(true);
  });

  it("logs and completes a poll tick when enqueue fails", async () => {
    const enqueued: EnqueueJobInput[] = [];

    await Effect.runPromise(
      runPublicSourceSafePollTick.pipe(
        Effect.provide(makeJobLayer(enqueued, { failEnqueue: true })),
      ),
    );

    expect(enqueued).toHaveLength(0);
  });
});
