import {
  makePublicSourceAdapter,
  publicSourceDefinitions,
  type PublicSourceId,
} from "@brief/source-ingestion";
import { Effect } from "effect";
import { runPublicSourceIngestion } from "../source-ingestion/orchestrator";
import type { PublicSourceIngestionRepository } from "../source-ingestion/repository";
import type { PublicSourceIngestionOptions } from "../source-ingestion/types";
import type { JobRecord, JobResult } from "./types";

const publicSourceIds = new Set<string>(publicSourceDefinitions.map((source) => source.id));

type PublicSourceIngestionJobPayload = {
  readonly sourceId: PublicSourceId;
  readonly mode: PublicSourceIngestionOptions["mode"];
  readonly since?: string;
};

const parsePublicSourceIngestionPayload = (payload: unknown): PublicSourceIngestionJobPayload => {
  if (!payload || typeof payload !== "object") {
    throw new Error("public_source_ingestion payload must be an object");
  }

  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.sourceId !== "string" || !publicSourceIds.has(candidate.sourceId)) {
    throw new Error("public_source_ingestion payload has an invalid sourceId");
  }

  if (candidate.mode !== "backfill" && candidate.mode !== "poll") {
    throw new Error("public_source_ingestion payload has an invalid mode");
  }

  if ("since" in candidate && typeof candidate.since !== "string") {
    throw new Error("public_source_ingestion payload has an invalid since value");
  }

  return {
    sourceId: candidate.sourceId as PublicSourceId,
    mode: candidate.mode,
    ...(typeof candidate.since === "string" ? { since: candidate.since } : {}),
  };
};

const handlePublicSourceIngestionJob = (
  job: JobRecord,
): Effect.Effect<JobResult, unknown, PublicSourceIngestionRepository> =>
  Effect.gen(function* () {
    const payload = yield* Effect.try({
      try: () => parsePublicSourceIngestionPayload(job.payload),
      catch: (error) => error,
    });
    const since = payload.since ? new Date(payload.since) : undefined;
    if (payload.since && Number.isNaN(since?.getTime())) {
      return yield* Effect.fail(
        new Error("public_source_ingestion payload has an invalid since date"),
      );
    }

    const stats = yield* runPublicSourceIngestion(makePublicSourceAdapter(payload.sourceId), {
      mode: payload.mode,
      ...(since ? { since } : {}),
    });

    if (stats.failedCount > 0) {
      yield* Effect.logWarning("public source ingestion completed with item failures").pipe(
        Effect.annotateLogs({
          sourceId: stats.sourceId,
          mode: stats.mode,
          failedCount: stats.failedCount,
          storedDocumentCount: stats.storedDocumentCount,
        }),
      );
    }

    return {
      status: "completed",
      message: `public source ingestion completed: ${stats.storedDocumentCount} stored, ${stats.failedCount} failed`,
    } satisfies JobResult;
  });

export const handleJob = (
  job: JobRecord,
): Effect.Effect<JobResult, unknown, PublicSourceIngestionRepository> =>
  Effect.gen(function* () {
    if (job.kind === "public_source_ingestion") {
      return yield* handlePublicSourceIngestionJob(job);
    }

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
