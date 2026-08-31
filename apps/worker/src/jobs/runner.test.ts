import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import { InMemoryPublicSourceIngestionRepositoryLayer } from "../source-ingestion/repository";
import { JobRepository } from "./repository";
import { runWorkerSafeTick, runWorkerTick } from "./runner";
import type { JobRecord } from "./types";

const handleJobMock = vi.hoisted(() => vi.fn());
vi.mock("./handlers", () => ({ handleJob: (...args: unknown[]) => handleJobMock(...args) }));

const layerFor = (job: JobRecord, markCompleted: () => Effect.Effect<void, unknown>) =>
  Layer.mergeAll(
    Layer.succeed(
      JobRepository,
      JobRepository.of({
        lockRenewalIntervalMs: 10,
        enqueue: (input) =>
          Effect.succeed({ id: "enqueued", kind: input.kind, payload: input.payload, attempts: 0 }),
        claimNext: Effect.succeed(job),
        heartbeat: () => Effect.void,
        markCompleted,
        markFailed: () => Effect.void,
      }),
    ),
    InMemoryPublicSourceIngestionRepositoryLayer(),
  );

describe("worker runner", () => {
  it("marks a completed job once", async () => {
    handleJobMock.mockReturnValueOnce(Effect.succeed({ status: "completed" as const }));
    let completed = 0;
    const effect = runWorkerTick.pipe(
      Effect.provide(
        layerFor(
          {
            id: "job-1",
            kind: "ai_chat_run",
            payload: { aiRunId: "run" },
            attempts: 1,
            lockedBy: "worker",
          },
          () =>
            Effect.sync(() => {
              completed += 1;
            }),
        ),
      ),
    );
    await Effect.runPromise(effect);
    expect(completed).toBe(1);
  });

  it("contains a handler failure in the safe tick", async () => {
    handleJobMock.mockReturnValueOnce(Effect.fail(new Error("failure")));
    const effect = runWorkerSafeTick.pipe(
      Effect.provide(
        layerFor(
          {
            id: "job-2",
            kind: "public_source_ingestion",
            payload: { sourceId: "service_public", mode: "poll" },
            attempts: 1,
            lockedBy: "worker",
          },
          () => Effect.void,
        ),
      ),
    );
    await Effect.runPromise(effect);
  });
});
