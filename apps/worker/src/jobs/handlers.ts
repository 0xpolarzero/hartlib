import { Effect } from "effect";
import type { JobRecord, JobResult } from "./types";

export const handleJob = (job: JobRecord): Effect.Effect<JobResult> =>
  Effect.gen(function* () {
    yield* Effect.logInfo("handling job placeholder").pipe(
      Effect.annotateLogs({
        jobId: job.id,
        jobKind: job.kind,
      }),
    );

    return {
      status: "completed",
      message: "placeholder",
    } satisfies JobResult;
  });
