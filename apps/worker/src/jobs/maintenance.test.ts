import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { enqueueHourlyMaintenanceJobs } from "./maintenance";
import { JobRepository, type JobRepositoryShape } from "./repository";

describe("maintenance scheduler", () => {
  it("queues only the retained hourly jobs with deterministic keys", async () => {
    const enqueue = vi.fn<JobRepositoryShape["enqueue"]>((input) =>
      Effect.succeed({
        id: `job:${input.kind}`,
        kind: input.kind,
        payload: input.payload,
        attempts: 0,
      }),
    );
    const repository = JobRepository.of({
      enqueue,
      claimNext: Effect.succeed(undefined),
      heartbeat: () => Effect.void,
      lockRenewalIntervalMs: 1_000,
      markCompleted: () => Effect.void,
      markFailed: () => Effect.void,
    });
    await Effect.runPromise(
      enqueueHourlyMaintenanceJobs(new Date("2026-07-10T18:42:00.000Z")).pipe(
        Effect.provideService(JobRepository, repository),
      ),
    );
    expect(enqueue.mock.calls.map(([input]) => input.kind)).toEqual([
      "purge_ai_runtime",
      "purge_user_memory_tombstones",
    ]);
    expect(enqueue.mock.calls.map(([input]) => input.uniqueKey)).toEqual([
      "maintenance:purge_ai_runtime:2026-07-10T18",
      "maintenance:purge_user_memory_tombstones:2026-07-10T18",
    ]);
  });
});
