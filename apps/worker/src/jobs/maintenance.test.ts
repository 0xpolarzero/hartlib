import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  enqueueExportGcJob,
  enqueueHourlyMaintenanceJobs,
  enqueueMaintenanceJobs,
} from "./maintenance";
import { JobRepository, type JobRepositoryShape } from "./repository";

describe("maintenance scheduler", () => {
  it("enqueues hourly sweeps and export GC with their exact deterministic time buckets", async () => {
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
      enqueueMaintenanceJobs(new Date("2026-07-10T18:42:00.000Z")).pipe(
        Effect.provideService(JobRepository, repository),
      ),
    );

    expect(enqueue.mock.calls.slice(0, -1).map(([input]) => input)).toEqual(
      [
        "purge_ai_runtime",
        "purge_user_memory_tombstones",
        "purge_deleted_chats",
        "purge_deleted_files",
        "reconcile_publisher_uploads",
        "purge_operational_audit_retention",
        "purge_deleted_accounts",
        "reset_monthly_credit_counters",
      ].map((kind) => ({
        kind,
        payload: {},
        uniqueKey: `maintenance:${kind}:2026-07-10T18`,
        priority: -100,
        maxAttempts: 5,
        reviveTerminal: false,
      })),
    );
    expect(enqueue).toHaveBeenLastCalledWith({
      kind: "purge_expired_exports",
      payload: {},
      uniqueKey: `maintenance:purge_expired_exports:${Math.floor(
        new Date("2026-07-10T18:42:00.000Z").getTime() / 300_000,
      )}`,
      priority: -100,
      maxAttempts: 5,
      reviveTerminal: false,
    });
  });

  it("keeps the hourly and five-minute scheduling paths independent", async () => {
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
    const now = new Date("2026-07-10T18:42:00.000Z");

    await Effect.runPromise(
      enqueueHourlyMaintenanceJobs(now).pipe(Effect.provideService(JobRepository, repository)),
    );
    expect(enqueue.mock.calls.some(([input]) => input.kind === "purge_expired_exports")).toBe(
      false,
    );
    enqueue.mockClear();
    await Effect.runPromise(
      enqueueExportGcJob(now).pipe(Effect.provideService(JobRepository, repository)),
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0].uniqueKey).toBe(
      `maintenance:purge_expired_exports:${Math.floor(now.getTime() / 300_000)}`,
    );
  });
});
