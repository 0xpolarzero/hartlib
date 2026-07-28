import { Duration, Effect, Schedule } from "effect";
import { captureCause } from "../diagnostic-cause";

import { JobRepository } from "./repository";
import type { JobKind } from "./types";

const hourlyMaintenanceKinds = [
  "purge_ai_runtime",
  "purge_user_memory_tombstones",
  "purge_deleted_chats",
  "purge_deleted_files",
  "reconcile_publisher_uploads",
  "purge_operational_audit_retention",
  "purge_deleted_accounts",
  "reset_monthly_credit_counters",
] as const satisfies readonly JobKind[];

const utcHourKey = (now: Date): string => now.toISOString().slice(0, 13);
const fiveMinuteUtcBucket = (now: Date): number => Math.floor(now.getTime() / (5 * 60 * 1_000));

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

export const enqueueExportGcJob = (now?: Date) =>
  Effect.gen(function* () {
    const jobs = yield* JobRepository;
    const bucket = fiveMinuteUtcBucket(now ?? new Date());
    yield* jobs.enqueue({
      kind: "purge_expired_exports",
      payload: {},
      uniqueKey: `maintenance:purge_expired_exports:${bucket}`,
      priority: -100,
      maxAttempts: 5,
      reviveTerminal: false,
    });
  });

export const enqueueMaintenanceJobs = (now?: Date) =>
  Effect.all([enqueueHourlyMaintenanceJobs(now), enqueueExportGcJob(now)], {
    concurrency: 1,
    discard: true,
  });

const safeHourlyMaintenanceTick = enqueueHourlyMaintenanceJobs().pipe(
  Effect.catch((error) =>
    Effect.sync(() => captureCause("maintenance_enqueue", error)).pipe(
      Effect.andThen(
        Effect.logError("maintenance enqueue failed").pipe(
          Effect.annotateLogs({
            component: "maintenance_scheduler",
            errorCode: "maintenance_enqueue_failed",
          }),
        ),
      ),
    ),
  ),
);

const safeExportGcTick = enqueueExportGcJob().pipe(
  Effect.catch((error) =>
    Effect.sync(() => captureCause("export_gc_enqueue", error)).pipe(
      Effect.andThen(
        Effect.logError("export GC enqueue failed").pipe(
          Effect.annotateLogs({
            component: "export_gc_scheduler",
            errorCode: "export_gc_enqueue_failed",
          }),
        ),
      ),
    ),
  ),
);

export const runMaintenanceScheduler = Effect.gen(function* () {
  yield* Effect.all(
    [
      safeHourlyMaintenanceTick.pipe(Effect.repeat(Schedule.spaced(Duration.hours(1)))),
      safeExportGcTick.pipe(Effect.repeat(Schedule.spaced(Duration.minutes(5)))),
    ],
    { concurrency: "unbounded", discard: true },
  );
});
