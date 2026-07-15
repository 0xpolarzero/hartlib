import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

import type { ModelUsage } from "../runtime/types";
import { providerVisibleSourceExposureProofSha256Hex } from "../runtime/provider-request";
import {
  appendAiRunEventInTransaction,
  lockAiRunForMutationInTransaction,
  type AiRunEvent,
} from "./events";

export type SourceKind = "document" | "chat_message" | "memory" | "web";

export interface AiDocumentExposureReconstruction {
  /** The immutable, namespaced source identity used by the document locator. */
  readonly sourceId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  /** SHA-256 hex digest of the immutable stored document text. */
  readonly contentHash: string;
  /** Already normalized, non-overlapping UTF-16 ranges into that text. */
  readonly ranges: readonly { readonly charStart: number; readonly charEnd: number }[];
}

export interface AiSourceExposureInput {
  readonly runId: string;
  readonly taskId: string;
  readonly loopIteration: number;
  readonly attempt: number;
  readonly providerRequestIndex: number;
  /** Digest of the exact normalized request persisted independently by the Pi gate. */
  readonly providerRequestSha256Hex: string;
  readonly sourceKind: SourceKind;
  readonly logicalSourceIdentity: string;
  readonly publisherIssueId?: string | undefined;
  readonly publisherDocumentId?: string | undefined;
  readonly contentItemIdentity: string;
  readonly exposureStage: string;
  readonly visibleTokenCount: number;
  readonly documentReconstruction?: AiDocumentExposureReconstruction | undefined;
}

export interface AiObservationInput {
  readonly runId: string;
  readonly chatId: string;
  readonly emittingTask: string;
  readonly loopIteration: number;
  readonly attempt: number;
  readonly observationKey: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

export interface AiRunUsageInput {
  readonly runId: string;
  readonly taskId: string;
  readonly loopIteration: number;
  readonly attempt: number;
  readonly providerRequestIndex: number;
  readonly agentRole: string;
  readonly modelId: string;
  /** Exact transport implementation, not a caller-declared capture label. */
  readonly providerServiceId:
    | "zai_coding_plan_official"
    | "deterministic_test"
    | "openai_compatible_custom";
  readonly usage: ModelUsage;
}

export interface AiExternalToolUsageInput {
  readonly runId: string;
  readonly taskId: string;
  readonly loopIteration: number;
  readonly attempt: number;
  readonly toolRequestIndex: number;
  readonly providerServiceId: string;
  readonly operation: "web_search" | "web_fetch";
  readonly status: "ok" | "empty" | "failed";
  readonly resultCount: number;
  readonly responseBytes: number;
  readonly billedUnits: number | null;
  readonly durationMs: number;
}

export interface AggregateAiRunUsage {
  readonly model: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedTokens: number;
    readonly reasoningTokens: number;
    readonly totalTokens: number;
    readonly requestCount: number;
  };
  readonly web: {
    readonly searchCount: number;
    readonly fetchCount: number;
    readonly responseBytes: number;
    readonly billedUnits: number | null;
  };
}

interface IdRow {
  readonly id: string;
}

const replayConflict = (table: string, key: string): Error =>
  new Error(`${table} replay conflicts with an existing immutable row (${key})`);

interface AggregateRow {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly requestCount: number;
  readonly searchCount: number;
  readonly fetchCount: number;
  readonly responseBytes: number;
  readonly billedUnits: number | null;
}

const isNonnegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const assertValidModelUsage = (usage: ModelUsage): void => {
  const total = usage.inputTokens + usage.cachedTokens + usage.outputTokens;
  if (
    !isNonnegativeSafeInteger(usage.inputTokens) ||
    !isNonnegativeSafeInteger(usage.cachedTokens) ||
    !isNonnegativeSafeInteger(usage.outputTokens) ||
    !isNonnegativeSafeInteger(usage.reasoningTokens) ||
    !isNonnegativeSafeInteger(usage.totalTokens) ||
    !Number.isSafeInteger(total) ||
    usage.totalTokens !== total ||
    usage.reasoningTokens > usage.outputTokens
  ) {
    throw new Error("provider usage accounting is invalid");
  }
};

const sourceExposureAttestationKey = (input: AiSourceExposureInput): string =>
  [
    "source_exposure_attestation",
    input.taskId,
    input.loopIteration,
    input.attempt,
    input.providerRequestIndex,
    createHash("sha256")
      .update(
        JSON.stringify([
          input.sourceKind,
          input.logicalSourceIdentity,
          input.contentItemIdentity,
          input.exposureStage,
          input.visibleTokenCount,
          input.providerRequestSha256Hex,
          input.documentReconstruction,
        ]),
      )
      .digest("hex"),
  ].join(":");

export const sourceExposureAttestationPayload = (input: AiSourceExposureInput) => ({
  providerRequestIndex: input.providerRequestIndex,
  providerRequestSha256Hex: input.providerRequestSha256Hex,
  sourceKind: input.sourceKind,
  logicalSourceIdentity: input.logicalSourceIdentity,
  contentItemIdentity: input.contentItemIdentity,
  exposureStage: input.exposureStage,
  visibleTokenCount: input.visibleTokenCount,
  providerSerializationProofSha256Hex: providerVisibleSourceExposureProofSha256Hex({
    sourceKind: input.sourceKind,
    logicalSourceIdentity: input.logicalSourceIdentity,
    contentItemIdentity: input.contentItemIdentity,
    exposureStage: input.exposureStage,
    visibleTokenCount: input.visibleTokenCount,
  }),
  ...(input.documentReconstruction === undefined
    ? {}
    : {
        documentSourceId: input.documentReconstruction.sourceId,
        documentId: input.documentReconstruction.documentId,
        documentVersionId: input.documentReconstruction.documentVersionId,
        documentContentHash: input.documentReconstruction.contentHash,
        documentRanges: input.documentReconstruction.ranges,
      }),
});

export const insertAiSourceExposure = (
  input: AiSourceExposureInput,
): Effect.Effect<boolean, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const documentRangesJson =
      input.documentReconstruction === undefined
        ? null
        : JSON.stringify(input.documentReconstruction.ranges);
    const attestationPayloadJson = JSON.stringify(sourceExposureAttestationPayload(input));
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<IdRow>`
          insert into ai_source_exposures (
            run_id,
            task_id,
            loop_iteration,
            attempt,
            provider_request_index,
            source_kind,
            logical_source_identity,
            publisher_issue_id,
            publisher_document_id,
            content_item_identity,
            exposure_stage,
            visible_token_count,
            document_source_id,
            document_id,
            document_version_id,
            document_content_hash,
            document_ranges
          )
          values (
            ${input.runId},
            ${input.taskId},
            ${input.loopIteration},
            ${input.attempt},
            ${input.providerRequestIndex},
            ${input.sourceKind},
            ${input.logicalSourceIdentity},
            ${input.publisherIssueId ?? null},
            ${input.publisherDocumentId ?? null},
            ${input.contentItemIdentity},
            ${input.exposureStage},
            ${input.visibleTokenCount},
            ${input.documentReconstruction?.sourceId ?? null},
            ${input.documentReconstruction?.documentId ?? null},
            ${input.documentReconstruction?.documentVersionId ?? null},
            ${input.documentReconstruction?.contentHash ?? null},
            ${documentRangesJson}::jsonb
          )
          on conflict (
            run_id,
            task_id,
            loop_iteration,
            attempt,
            provider_request_index,
            exposure_stage,
            content_item_identity
          ) do nothing
          returning id::text
        `;

        if (rows.length === 0) {
          const existing = yield* sql<IdRow>`
            select id::text
            from ai_source_exposures
            where run_id = ${input.runId}
              and task_id = ${input.taskId}
              and loop_iteration = ${input.loopIteration}
              and attempt = ${input.attempt}
              and provider_request_index = ${input.providerRequestIndex}
              and exposure_stage = ${input.exposureStage}
              and content_item_identity = ${input.contentItemIdentity}
            for update
          `;
          if (existing.length !== 1) {
            return yield* Effect.fail(
              replayConflict(
                "ai_source_exposures",
                `${input.runId}:${input.taskId}:${input.loopIteration}:${input.attempt}:${input.providerRequestIndex}:${input.exposureStage}:${input.contentItemIdentity}`,
              ),
            );
          }

          const matching = yield* sql<IdRow>`
            select id::text
            from ai_source_exposures
            where id = ${existing[0]!.id}
              and run_id = ${input.runId}
              and task_id = ${input.taskId}
              and loop_iteration = ${input.loopIteration}
              and attempt = ${input.attempt}
              and provider_request_index = ${input.providerRequestIndex}
              and source_kind = ${input.sourceKind}
              and logical_source_identity = ${input.logicalSourceIdentity}
              and publisher_issue_id is not distinct from ${input.publisherIssueId ?? null}
              and publisher_document_id is not distinct from ${input.publisherDocumentId ?? null}
              and content_item_identity = ${input.contentItemIdentity}
              and exposure_stage = ${input.exposureStage}
              and visible_token_count = ${input.visibleTokenCount}
              and document_source_id is not distinct from ${input.documentReconstruction?.sourceId ?? null}
              and document_id is not distinct from ${input.documentReconstruction?.documentId ?? null}
              and document_version_id is not distinct from ${input.documentReconstruction?.documentVersionId ?? null}
              and document_content_hash is not distinct from ${input.documentReconstruction?.contentHash ?? null}
              and document_ranges is not distinct from ${documentRangesJson}::jsonb
            for update
          `;
          if (matching.length !== 1) {
            return yield* Effect.fail(
              replayConflict(
                "ai_source_exposures",
                `${input.runId}:${input.taskId}:${input.loopIteration}:${input.attempt}:${input.providerRequestIndex}:${input.exposureStage}:${input.contentItemIdentity}`,
              ),
            );
          }
        }

        const attestationPayload = sourceExposureAttestationPayload(input);
        const attestationIdentity = {
          providerRequestIndex: input.providerRequestIndex,
          sourceKind: input.sourceKind,
          logicalSourceIdentity: input.logicalSourceIdentity,
          contentItemIdentity: input.contentItemIdentity,
          exposureStage: input.exposureStage,
        };
        const identityAttestations = yield* sql<IdRow>`
          select id::text
          from ai_observations
          where run_id = ${input.runId}
            and emitting_task = ${input.taskId}
            and loop_iteration = ${input.loopIteration}
            and attempt = ${input.attempt}
            and kind = 'source_exposure_attestation'
            and payload @> ${sql.json(attestationIdentity)}
          for update
        `;
        const exactAttestations = yield* sql<IdRow>`
          select id::text
          from ai_observations
          where run_id = ${input.runId}
            and emitting_task = ${input.taskId}
            and loop_iteration = ${input.loopIteration}
            and attempt = ${input.attempt}
            and kind = 'source_exposure_attestation'
            and payload = ${attestationPayloadJson}::jsonb
          for update
        `;
        if (
          identityAttestations.length > 0 &&
          (identityAttestations.length !== 1 || exactAttestations.length !== 1)
        ) {
          return yield* Effect.fail(
            replayConflict(
              "ai_observations(source_exposure_attestation)",
              `${input.runId}:${input.taskId}:${input.loopIteration}:${input.attempt}:${input.providerRequestIndex}:${input.exposureStage}:${input.contentItemIdentity}`,
            ),
          );
        }

        yield* insertAiObservationInTransaction({
          runId: input.runId,
          chatId:
            (yield* sql<{ readonly chatId: string }>`
            select chat_id::text as "chatId" from ai_runs where id = ${input.runId}
          `)[0]?.chatId ?? "",
          emittingTask: input.taskId,
          loopIteration: input.loopIteration,
          attempt: input.attempt,
          observationKey: sourceExposureAttestationKey(input),
          kind: "source_exposure_attestation",
          payload: attestationPayload,
        });
        // A legacy row may predate its attestation. Replaying it is still
        // idempotent after the missing attestation is repaired in this same
        // transaction.
        return rows.length === 1;
      }),
    );
  });

const insertAiObservationInTransaction = (
  input: AiObservationInput,
): Effect.Effect<boolean, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<IdRow>`
      insert into ai_observations (
        run_id,
        chat_id,
        emitting_task,
        loop_iteration,
        attempt,
        observation_key,
        kind,
        payload
      )
      values (
        ${input.runId},
        ${input.chatId},
        ${input.emittingTask},
        ${input.loopIteration},
        ${input.attempt},
        ${input.observationKey},
        ${input.kind},
        ${sql.json(input.payload)}
      )
      on conflict (run_id, observation_key) do nothing
      returning id::text
    `;

    if (rows.length === 1) return true;

    const existing = yield* sql<IdRow>`
      select id::text
      from ai_observations
      where run_id = ${input.runId}
        and observation_key = ${input.observationKey}
      for update
    `;
    if (existing.length !== 1) {
      return yield* Effect.fail(
        replayConflict("ai_observations", `${input.runId}:${input.observationKey}`),
      );
    }

    const matching = yield* sql<IdRow>`
      select id::text
      from ai_observations
      where id = ${existing[0]!.id}
        and run_id = ${input.runId}
        and chat_id = ${input.chatId}
        and emitting_task = ${input.emittingTask}
        and loop_iteration = ${input.loopIteration}
        and attempt = ${input.attempt}
        and observation_key = ${input.observationKey}
        and kind = ${input.kind}
        and payload is not distinct from ${sql.json(input.payload)}
      for update
    `;
    if (matching.length !== 1) {
      return yield* Effect.fail(
        replayConflict("ai_observations", `${input.runId}:${input.observationKey}`),
      );
    }
    return false;
  });

export const insertAiObservation = (
  input: AiObservationInput,
): Effect.Effect<boolean, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(insertAiObservationInTransaction(input));
  });

const modelUsageEvent = (input: AiRunUsageInput): AiRunEvent => ({
  type: "usage",
  scope: "request",
  kind: "model",
  role: input.agentRole,
  attempt: input.attempt,
  inputTokens: input.usage.inputTokens,
  outputTokens: input.usage.outputTokens,
  cachedTokens: input.usage.cachedTokens,
  reasoningTokens: input.usage.reasoningTokens,
  totalTokens: input.usage.totalTokens,
});

export const insertAiRunUsageInTransaction = (
  input: AiRunUsageInput,
): Effect.Effect<boolean, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    // Keep the application boundary strict even when a caller bypasses Pi
    // (for example, a replay or migration test).  This runs before SQL or the
    // usage event so malformed accounting can never become durable evidence.
    assertValidModelUsage(input.usage);
    const sql = yield* PgClient.PgClient;
    yield* lockAiRunForMutationInTransaction(input.runId);
    const rows = yield* sql<IdRow>`
      insert into ai_run_usage (
        run_id,
        task_id,
        loop_iteration,
        attempt,
        provider_request_index,
        agent_role,
        model_id,
        provider_service_id,
        input_tokens,
        output_tokens,
        cached_tokens,
        reasoning_tokens,
        total_tokens,
        stop_reason
      )
      values (
        ${input.runId},
        ${input.taskId},
        ${input.loopIteration},
        ${input.attempt},
        ${input.providerRequestIndex},
        ${input.agentRole},
        ${input.modelId},
        ${input.providerServiceId},
        ${input.usage.inputTokens},
        ${input.usage.outputTokens},
        ${input.usage.cachedTokens},
        ${input.usage.reasoningTokens},
        ${input.usage.totalTokens},
        ${input.usage.stopReason}
      )
      on conflict (run_id, task_id, loop_iteration, attempt, provider_request_index) do nothing
      returning id::text
    `;

    if (rows.length === 0) {
      const existing = yield* sql<IdRow>`
        select id::text
        from ai_run_usage
        where run_id = ${input.runId}
          and task_id = ${input.taskId}
          and loop_iteration = ${input.loopIteration}
          and attempt = ${input.attempt}
          and provider_request_index = ${input.providerRequestIndex}
        for update
      `;
      if (existing.length !== 1) {
        return yield* Effect.fail(
          replayConflict(
            "ai_run_usage",
            `${input.runId}:${input.taskId}:${input.loopIteration}:${input.attempt}:${input.providerRequestIndex}`,
          ),
        );
      }
      const matching = yield* sql<IdRow>`
        select id::text
        from ai_run_usage
        where id = ${existing[0]!.id}
          and run_id = ${input.runId}
          and task_id = ${input.taskId}
          and loop_iteration = ${input.loopIteration}
          and attempt = ${input.attempt}
          and provider_request_index = ${input.providerRequestIndex}
          and agent_role = ${input.agentRole}
          and model_id = ${input.modelId}
          and provider_service_id = ${input.providerServiceId}
          and input_tokens = ${input.usage.inputTokens}
          and output_tokens = ${input.usage.outputTokens}
          and cached_tokens = ${input.usage.cachedTokens}
          and reasoning_tokens = ${input.usage.reasoningTokens}
          and total_tokens = ${input.usage.totalTokens}
          and stop_reason = ${input.usage.stopReason}
        for update
      `;
      if (matching.length !== 1) {
        return yield* Effect.fail(
          replayConflict(
            "ai_run_usage",
            `${input.runId}:${input.taskId}:${input.loopIteration}:${input.attempt}:${input.providerRequestIndex}`,
          ),
        );
      }
    }

    yield* appendAiRunEventInTransaction({
      runId: input.runId,
      emissionKey: `usage:request:model:${input.taskId}:${input.loopIteration}:${input.attempt}:${input.providerRequestIndex}`,
      event: modelUsageEvent(input),
      emittedByTask: input.taskId,
    });

    return rows.length === 1;
  });

export const insertAiRunUsage = (
  input: AiRunUsageInput,
): Effect.Effect<boolean, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(insertAiRunUsageInTransaction(input));
  });

const externalUsageEvent = (input: AiExternalToolUsageInput): AiRunEvent => ({
  type: "usage",
  scope: "request",
  kind: input.operation,
  attempt: input.attempt,
  status: input.status,
  resultCount: input.resultCount,
  responseBytes: input.responseBytes,
  billedUnits: input.billedUnits,
});

export const insertAiExternalToolUsageInTransaction = (
  input: AiExternalToolUsageInput,
): Effect.Effect<boolean, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* lockAiRunForMutationInTransaction(input.runId);
    const rows = yield* sql<IdRow>`
      insert into ai_external_tool_usage (
        run_id,
        task_id,
        loop_iteration,
        attempt,
        tool_request_index,
        provider_service_id,
        operation,
        status,
        result_count,
        response_bytes,
        billed_units,
        duration_ms
      )
      values (
        ${input.runId},
        ${input.taskId},
        ${input.loopIteration},
        ${input.attempt},
        ${input.toolRequestIndex},
        ${input.providerServiceId},
        ${input.operation},
        ${input.status},
        ${input.resultCount},
        ${input.responseBytes},
        ${input.billedUnits},
        ${input.durationMs}
      )
      on conflict (run_id, task_id, loop_iteration, attempt, tool_request_index) do nothing
      returning id::text
    `;

    if (rows.length === 0) {
      const existing = yield* sql<IdRow>`
        select id::text
        from ai_external_tool_usage
        where run_id = ${input.runId}
          and task_id = ${input.taskId}
          and loop_iteration = ${input.loopIteration}
          and attempt = ${input.attempt}
          and tool_request_index = ${input.toolRequestIndex}
        for update
      `;
      if (existing.length !== 1) {
        return yield* Effect.fail(
          replayConflict(
            "ai_external_tool_usage",
            `${input.runId}:${input.taskId}:${input.loopIteration}:${input.attempt}:${input.toolRequestIndex}`,
          ),
        );
      }
      const matching = yield* sql<IdRow>`
        select id::text
        from ai_external_tool_usage
        where id = ${existing[0]!.id}
          and run_id = ${input.runId}
          and task_id = ${input.taskId}
          and loop_iteration = ${input.loopIteration}
          and attempt = ${input.attempt}
          and tool_request_index = ${input.toolRequestIndex}
          and provider_service_id = ${input.providerServiceId}
          and operation = ${input.operation}
          and status = ${input.status}
          and result_count = ${input.resultCount}
          and response_bytes = ${input.responseBytes}
          and billed_units is not distinct from ${input.billedUnits}
          and duration_ms = ${input.durationMs}
        for update
      `;
      if (matching.length !== 1) {
        return yield* Effect.fail(
          replayConflict(
            "ai_external_tool_usage",
            `${input.runId}:${input.taskId}:${input.loopIteration}:${input.attempt}:${input.toolRequestIndex}`,
          ),
        );
      }
    }

    yield* appendAiRunEventInTransaction({
      runId: input.runId,
      emissionKey: `usage:request:${input.operation}:${input.taskId}:${input.loopIteration}:${input.attempt}:${input.toolRequestIndex}`,
      event: externalUsageEvent(input),
      emittedByTask: input.taskId,
    });

    return rows.length === 1;
  });

export const insertAiExternalToolUsage = (
  input: AiExternalToolUsageInput,
): Effect.Effect<boolean, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(insertAiExternalToolUsageInTransaction(input));
  });

export const deriveAggregateAiRunUsage = (
  runId: string,
): Effect.Effect<AggregateAiRunUsage, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<AggregateRow>`
      select
        coalesce((select sum(input_tokens) from ai_run_usage where run_id = ${runId}), 0)::int as "inputTokens",
        coalesce((select sum(output_tokens) from ai_run_usage where run_id = ${runId}), 0)::int as "outputTokens",
        coalesce((select sum(cached_tokens) from ai_run_usage where run_id = ${runId}), 0)::int as "cachedTokens",
        coalesce((select sum(reasoning_tokens) from ai_run_usage where run_id = ${runId}), 0)::int as "reasoningTokens",
        coalesce((select sum(total_tokens) from ai_run_usage where run_id = ${runId}), 0)::int as "totalTokens",
        (select count(*)::int from ai_run_usage where run_id = ${runId}) as "requestCount",
        (
          select count(*)::int
          from ai_external_tool_usage
          where run_id = ${runId} and operation = 'web_search'
        ) as "searchCount",
        (
          select count(*)::int
          from ai_external_tool_usage
          where run_id = ${runId} and operation = 'web_fetch'
        ) as "fetchCount",
        coalesce((
          select sum(response_bytes)
          from ai_external_tool_usage
          where run_id = ${runId}
        ), 0)::float8 as "responseBytes",
        case
          when not exists (select 1 from ai_external_tool_usage where run_id = ${runId}) then 0::float8
          when exists (
            select 1
            from ai_external_tool_usage
            where run_id = ${runId} and billed_units is null
          ) then null
          else (
            select sum(billed_units)::float8
            from ai_external_tool_usage
            where run_id = ${runId}
          )
        end as "billedUnits"
    `;
    const aggregate = rows[0];

    if (aggregate === undefined) {
      return {
        model: {
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          requestCount: 0,
        },
        web: { searchCount: 0, fetchCount: 0, responseBytes: 0, billedUnits: 0 },
      };
    }

    const aggregateTotal = aggregate.inputTokens + aggregate.cachedTokens + aggregate.outputTokens;
    if (
      ![
        aggregate.inputTokens,
        aggregate.cachedTokens,
        aggregate.outputTokens,
        aggregate.reasoningTokens,
        aggregate.totalTokens,
        aggregate.requestCount,
        aggregate.searchCount,
        aggregate.fetchCount,
      ].every(isNonnegativeSafeInteger) ||
      !Number.isSafeInteger(aggregateTotal) ||
      aggregate.totalTokens !== aggregateTotal ||
      aggregate.reasoningTokens > aggregate.outputTokens
    ) {
      return yield* Effect.fail(new Error("provider usage aggregate is invalid"));
    }

    return {
      model: {
        inputTokens: aggregate.inputTokens,
        outputTokens: aggregate.outputTokens,
        cachedTokens: aggregate.cachedTokens,
        reasoningTokens: aggregate.reasoningTokens,
        totalTokens: aggregate.totalTokens,
        requestCount: aggregate.requestCount,
      },
      web: {
        searchCount: aggregate.searchCount,
        fetchCount: aggregate.fetchCount,
        responseBytes: aggregate.responseBytes,
        billedUnits: aggregate.billedUnits,
      },
    };
  });

export const appendAggregateAiRunUsageInTransaction = (
  runId: string,
  emittedByTask: string,
): Effect.Effect<AggregateAiRunUsage, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const usage = yield* deriveAggregateAiRunUsage(runId);
    yield* appendAiRunEventInTransaction({
      runId,
      emissionKey: "usage:run",
      event: { type: "usage", scope: "run", ...usage },
      emittedByTask,
    });
    return usage;
  });
