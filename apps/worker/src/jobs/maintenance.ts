import { Duration, Effect, Schedule } from "effect";

import { JobRepository } from "./repository";
import type { JobKind } from "./types";

const hourlyMaintenanceKinds = [
  "purge_ai_runtime",
  "purge_user_memory_tombstones",
] as const satisfies readonly JobKind[];

const utcHourKey = (now: Date): string => now.toISOString().slice(0, 13);

export const enqueueHourlyMaintenanceJobs = (now?: Date) =>
  Effect.gen(function* () {
    const jobs = yield* JobRepository;
    const hour = utcHourKey(now ?? new Date());
    yield* Effect.forEach(
      hourlyMaintenanceKinds,
      (kind) =>
        jobs.enqueue({
          kind,
          payload: {},
          uniqueKey: `maintenance:${kind}:${hour}`,
          priority: -100,
          maxAttempts: 5,
          reviveTerminal: false,
        }),
      { concurrency: 1, discard: true },
    );
  });

const safeHourlyMaintenanceTick = enqueueHourlyMaintenanceJobs().pipe(
  Effect.catch(() =>
    Effect.logError("maintenance enqueue failed").pipe(
      Effect.annotateLogs({
        component: "maintenance_scheduler",
        errorCode: "maintenance_enqueue_failed",
      }),
    ),
  ),
);

export const runMaintenanceScheduler = Effect.gen(function* () {
  yield* safeHourlyMaintenanceTick.pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))));
});
