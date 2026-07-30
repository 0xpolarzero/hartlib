import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

import type { ModelUsage } from "../runtime/types";
import {
  providerRequestSourceExposureProofBindingCandidates,
  providerVisibleSourceExposureProofSha256Hex,
  type ProviderVisibleSourceExposureProofBinding,
} from "../runtime/provider-request";
import { namespacedDocumentEvidenceIdentity, sha256Base64Url } from "../runtime/canonicalization";
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
  readonly snapshotId: string;
  /** SHA-256 hex digest of the immutable stored document text. */
  readonly contentHash: string;
  readonly publisherExtractionId?: string | undefined;
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
  /** Exact normalized provider field binding used by a code-owned sidecar. */
  readonly providerSerializationProofBinding?:
    | ProviderVisibleSourceExposureProofBinding
    | undefined;
  readonly requireCanonicalDocumentIdentity?: boolean | undefined;
  readonly documentReconstruction?: AiDocumentExposureReconstruction | undefined;
}

const canonicalRangeHash = (
  ranges: readonly { readonly charStart: number; readonly charEnd: number }[],
): string =>
  sha256Base64Url(
    JSON.stringify(ranges.map((range) => ({ charStart: range.charStart, charEnd: range.charEnd }))),
  );

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

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

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

const sourceExposureAttestationKey = (
  input: AiSourceExposureInput,
  providerSerializationProofSha256Hex: string,
  providerSerializationProofBinding: ProviderVisibleSourceExposureProofBinding,
): string =>
  [
    "source_exposure_attestation",
    input.taskId,
    input.loopIteration,
    input.attempt,
    input.providerRequestIndex,
    createHash("sha256")
      .update(
        stableJson([
          input.sourceKind,
          input.logicalSourceIdentity,
          input.contentItemIdentity,
          input.exposureStage,
          input.visibleTokenCount,
          input.providerRequestSha256Hex,
          providerSerializationProofSha256Hex,
          providerSerializationProofBinding,
          input.documentReconstruction,
        ]),
      )
      .digest("hex"),
  ].join(":");

const sourceExposureAttestationPayloadForProof = (
  input: AiSourceExposureInput,
  providerSerializationProofSha256Hex: string,
  providerSerializationProofBinding: ProviderVisibleSourceExposureProofBinding,
) => ({
  providerRequestIndex: input.providerRequestIndex,
  providerRequestSha256Hex: input.providerRequestSha256Hex,
  sourceKind: input.sourceKind,
  logicalSourceIdentity: input.logicalSourceIdentity,
  contentItemIdentity: input.contentItemIdentity,
  exposureStage: input.exposureStage,
  visibleTokenCount: input.visibleTokenCount,
  providerSerializationProofSha256Hex,
  providerSerializationProofBinding,
  ...(input.documentReconstruction === undefined
    ? {}
    : {
        documentSourceId: input.documentReconstruction.sourceId,
        documentId: input.documentReconstruction.documentId,
        snapshotId: input.documentReconstruction.snapshotId,
        documentContentHash: input.documentReconstruction.contentHash,
        documentRanges: input.documentReconstruction.ranges,
        ...(input.documentReconstruction.publisherExtractionId === undefined
          ? {}
          : { publisherExtractionId: input.documentReconstruction.publisherExtractionId }),
      }),
});

export const assertCanonicalDocumentExposureIdentity = (
  input: Pick<
    AiSourceExposureInput,
    | "sourceKind"
    | "logicalSourceIdentity"
    | "contentItemIdentity"
    | "publisherIssueId"
    | "publisherDocumentId"
    | "providerSerializationProofBinding"
    | "documentReconstruction"
    | "requireCanonicalDocumentIdentity"
  >,
): void => {
  if (input.sourceKind !== "document") return;
  const canonicalRequired =
    input.requireCanonicalDocumentIdentity === true ||
    input.providerSerializationProofBinding?.publicDocumentId !== undefined;
  if (input.documentReconstruction === undefined) {
    if (canonicalRequired) {
      throw new Error("document exposure reconstruction is required");
    }
    return;
  }
  if (!input.logicalSourceIdentity.startsWith("document:namespace:")) {
    if (canonicalRequired) {
      throw new Error("document exposure logical identity is not canonical");
    }
    return;
  }
  if (!canonicalRequired) {
    return;
  }
  const reconstruction = input.documentReconstruction;
  // Mixed public and publisher provenance must fail with the owner error.
  if (
    reconstruction.sourceId.startsWith("public:") &&
    (input.publisherIssueId !== undefined || input.publisherDocumentId !== undefined)
  ) {
    throw new Error("publisher document identity does not match database ownership");
  }
  if (
    !/^(?:public|publisher):[^:\s]+$/u.test(reconstruction.sourceId) ||
    !/^[a-f0-9]{64}$/u.test(reconstruction.contentHash) ||
    reconstruction.ranges.length === 0 ||
    reconstruction.ranges.some(
      (range) =>
        !Number.isSafeInteger(range.charStart) ||
        !Number.isSafeInteger(range.charEnd) ||
        range.charStart < 0 ||
        range.charEnd <= range.charStart,
    )
  ) {
    throw new Error("document exposure reconstruction is not canonical");
  }
  const isPublisherSource = reconstruction.sourceId.startsWith("publisher:");
  if (!isPublisherSource && reconstruction.publisherExtractionId !== undefined) {
    throw new Error("public document exposure cannot carry publisher extraction identity");
  }
  if (isPublisherSource && reconstruction.publisherExtractionId === undefined) {
    throw new Error("publisher document exposure requires its extraction identity");
  }
  if (isPublisherSource && input.publisherDocumentId !== reconstruction.documentId) {
    throw new Error("publisher document identity does not match database ownership");
  }
  for (let index = 1; index < reconstruction.ranges.length; index += 1) {
    if (reconstruction.ranges[index - 1]!.charEnd >= reconstruction.ranges[index]!.charStart) {
      throw new Error("document exposure reconstruction ranges are not canonical");
    }
  }
  const logicalSourceIdentity = reconstruction.sourceId.startsWith("public:")
    ? namespacedDocumentEvidenceIdentity(
        { kind: "public", sourceId: reconstruction.sourceId },
        reconstruction.documentId,
      )
    : input.publisherIssueId !== undefined && input.publisherDocumentId !== undefined
      ? namespacedDocumentEvidenceIdentity(
          {
            kind: "publisher",
            sourceId: reconstruction.sourceId,
            issueId: input.publisherIssueId,
            documentId: input.publisherDocumentId,
          },
          reconstruction.documentId,
        )
      : undefined;
  if (logicalSourceIdentity === undefined) {
    throw new Error("document exposure reconstruction lacks its canonical owner identity");
  }
  if (input.logicalSourceIdentity !== logicalSourceIdentity) {
    if (
      reconstruction.sourceId.startsWith("publisher:") &&
      input.publisherIssueId !== undefined &&
      input.publisherDocumentId !== undefined
    ) {
      throw new Error("publisher document identity does not match database ownership");
    }
    throw new Error("document exposure logical identity differs from its reconstruction");
  }
  if (
    input.providerSerializationProofBinding?.publicDocumentId !== undefined &&
    input.providerSerializationProofBinding.publicDocumentId !== reconstruction.documentId
  ) {
    throw new Error("document exposure provider binding has a different document ID");
  }
  const prefix = `${logicalSourceIdentity}:${reconstruction.snapshotId}:`;
  const suffix = input.contentItemIdentity.startsWith(prefix)
    ? input.contentItemIdentity.slice(prefix.length)
    : "";
  const rangeHash = canonicalRangeHash(reconstruction.ranges);
  if (suffix !== rangeHash) {
    throw new Error("document exposure content identity is not bound to its exact ranges");
  }
};

/**
 * Builds an attestation only when the caller has the exact normalized field
 * binding. Live inserts resolve that binding from the already-persisted gate
 * measurement before calling the internal proof-aware builder below.
 */
export const sourceExposureAttestationPayload = (input: AiSourceExposureInput) => {
  if (input.providerSerializationProofBinding === undefined) {
    throw new Error("source exposure attestation requires its provider field binding");
  }
  const marker = {
    sourceKind: input.sourceKind,
    logicalSourceIdentity: input.logicalSourceIdentity,
    contentItemIdentity: input.contentItemIdentity,
    exposureStage: input.exposureStage,
    visibleTokenCount: input.visibleTokenCount,
  } as const;
  return sourceExposureAttestationPayloadForProof(
    input,
    providerVisibleSourceExposureProofSha256Hex(marker, input.providerSerializationProofBinding),
    input.providerSerializationProofBinding,
  );
};

export const insertAiSourceExposure = (
  input: AiSourceExposureInput,
): Effect.Effect<boolean, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    // Reject malformed document identities before any database constraint can
    // mask the canonical validation error.
    assertCanonicalDocumentExposureIdentity(input);
    const sql = yield* PgClient.PgClient;
    const documentRangesJson =
      input.documentReconstruction === undefined
        ? null
        : JSON.stringify(input.documentReconstruction.ranges);
    const marker = {
      sourceKind: input.sourceKind,
      logicalSourceIdentity: input.logicalSourceIdentity,
      contentItemIdentity: input.contentItemIdentity,
      exposureStage: input.exposureStage,
      visibleTokenCount: input.visibleTokenCount,
    } as const;
    const providerSerializationProofSha256Hex =
      input.providerSerializationProofBinding === undefined
        ? undefined
        : providerVisibleSourceExposureProofSha256Hex(
            marker,
            input.providerSerializationProofBinding,
          );
    // The table's existing content identity is the unique key. Extend it
    // with the exact provider-field proof only when one exists, so repeated
    // source content at distinct fields stays a durable multiset without a
    // schema change. Attestation payloads keep the canonical identity.
    const storedContentItemIdentity =
      providerSerializationProofSha256Hex === undefined
        ? input.contentItemIdentity
        : `${input.contentItemIdentity}#proof=${providerSerializationProofSha256Hex}`;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const replayKey = `${input.runId}:${input.taskId}:${input.loopIteration}:${input.attempt}:${input.providerRequestIndex}:${input.exposureStage}:${storedContentItemIdentity}`;
        const coordinateLockKey = [
          input.runId,
          input.taskId,
          input.loopIteration,
          input.attempt,
          input.providerRequestIndex,
        ].join(":");
        let inserted = false;
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`brief:source-exposure:${replayKey}`}))
        `;
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`brief:source-exposure-proof:${coordinateLockKey}`}))
        `;
        const baseIdentity = input.contentItemIdentity.replace(/#proof=[0-9a-f]{64}$/u, "");
        const existingSourceKinds = yield* sql<{ readonly sourceKind: string }>`
          select source_kind as "sourceKind"
          from ai_source_exposures
          where run_id = ${input.runId}
            and task_id = ${input.taskId}
            and loop_iteration = ${input.loopIteration}
            and attempt = ${input.attempt}
            and provider_request_index = ${input.providerRequestIndex}
            and exposure_stage = ${input.exposureStage}
            and (
              content_item_identity = ${baseIdentity}
              or content_item_identity like ${`${baseIdentity}#proof=%`}
            )
          for update
        `;
        if (existingSourceKinds.some(({ sourceKind }) => sourceKind !== input.sourceKind)) {
          return yield* Effect.fail(replayConflict("ai_source_exposures", replayKey));
        }
        const callerBoundProof =
          input.providerSerializationProofBinding === undefined
            ? undefined
            : providerVisibleSourceExposureProofSha256Hex(
                marker,
                input.providerSerializationProofBinding,
              );
        if (
          callerBoundProof !== undefined &&
          input.providerSerializationProofBinding !== undefined
        ) {
          const candidateAttestationPayload = sourceExposureAttestationPayloadForProof(
            input,
            callerBoundProof,
            input.providerSerializationProofBinding,
          );
          const sameFieldPayloads = yield* sql<{ readonly id: string }>`
            select id::text
            from ai_observations
            where run_id = ${input.runId}
              and emitting_task = ${input.taskId}
              and loop_iteration = ${input.loopIteration}
              and attempt = ${input.attempt}
              and kind = 'source_exposure_attestation'
              and (payload->>'providerRequestIndex')::int = ${input.providerRequestIndex}
              and payload->>'sourceKind' = ${input.sourceKind}
              and payload->>'exposureStage' = ${input.exposureStage}
              and payload->>'contentItemIdentity' = ${baseIdentity}
              and payload->'providerSerializationProofBinding' = ${JSON.stringify(input.providerSerializationProofBinding)}::jsonb
              and payload <> ${JSON.stringify(candidateAttestationPayload)}::jsonb
            for update
          `;
          if (sameFieldPayloads.length > 0) {
            return yield* Effect.fail(
              replayConflict("ai_observations(source_exposure_attestation)", replayKey),
            );
          }
        }
        const existing = yield* sql<IdRow>`
          select id::text
          from ai_source_exposures
          where run_id = ${input.runId}
            and task_id = ${input.taskId}
            and loop_iteration = ${input.loopIteration}
            and attempt = ${input.attempt}
            and provider_request_index = ${input.providerRequestIndex}
            and exposure_stage = ${input.exposureStage}
            and content_item_identity = ${storedContentItemIdentity}
          for update
        `;
        if (existing.length > 1) {
          return yield* Effect.fail(replayConflict("ai_source_exposures", replayKey));
        }
        if (existing.length === 1) {
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
              and content_item_identity = ${storedContentItemIdentity}
              and exposure_stage = ${input.exposureStage}
              and visible_token_count = ${input.visibleTokenCount}
              and document_source_id is not distinct from ${input.documentReconstruction?.sourceId ?? null}
              and document_id is not distinct from ${input.documentReconstruction?.documentId ?? null}
              and snapshot_id is not distinct from ${input.documentReconstruction?.snapshotId ?? null}
              and content_hash is not distinct from ${input.documentReconstruction?.contentHash ?? null}
              and document_ranges is not distinct from ${documentRangesJson}::jsonb
              and publisher_extraction_id is not distinct from ${input.documentReconstruction?.publisherExtractionId ?? null}
            for update
          `;
          if (matching.length !== 1) {
            return yield* Effect.fail(replayConflict("ai_source_exposures", replayKey));
          }
        } else {
          yield* sql`
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
              snapshot_id,
              content_hash,
              document_ranges,
              publisher_extraction_id
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
              ${storedContentItemIdentity},
              ${input.exposureStage},
              ${input.visibleTokenCount},
              ${input.documentReconstruction?.sourceId ?? null},
              ${input.documentReconstruction?.documentId ?? null},
              ${input.documentReconstruction?.snapshotId ?? null},
              ${input.documentReconstruction?.contentHash ?? null},
              ${documentRangesJson}::jsonb,
              ${input.documentReconstruction === undefined ? null : (input.documentReconstruction.publisherExtractionId ?? null)}
            )
          `;
          inserted = true;
        }

        if (input.sourceKind === "web") return inserted;
        const existingAttestedProofs = yield* sql<{
          readonly proof: string;
          readonly binding: unknown;
          readonly providerRequestSha256Hex: string | null;
        }>`
          select payload->>'providerSerializationProofSha256Hex' as proof,
                 payload->'providerSerializationProofBinding' as binding,
                 payload->>'providerRequestSha256Hex' as "providerRequestSha256Hex"
          from ai_observations
          where run_id = ${input.runId}
            and emitting_task = ${input.taskId}
            and loop_iteration = ${input.loopIteration}
            and attempt = ${input.attempt}
            and kind = 'source_exposure_attestation'
            and (payload->>'providerRequestIndex')::int = ${input.providerRequestIndex}
            and payload->>'sourceKind' = ${input.sourceKind}
            and payload->>'logicalSourceIdentity' = ${input.logicalSourceIdentity}
            and payload->>'contentItemIdentity' = ${input.contentItemIdentity}
            and payload->>'exposureStage' = ${input.exposureStage}
          for update
        `;
        if (
          existingAttestedProofs.some(
            (attestation) =>
              attestation.providerRequestSha256Hex !== null &&
              attestation.providerRequestSha256Hex !== input.providerRequestSha256Hex,
          )
        ) {
          return yield* Effect.fail(
            replayConflict("ai_observations(source_exposure_attestation)", replayKey),
          );
        }
        const measurementRows = yield* sql<{
          readonly proofs: unknown;
          readonly bindings: unknown;
        }>`
          select payload->'sourceExposureProofSha256Hexes' as proofs,
                 payload->'sourceExposureProofBindings' as bindings
          from ai_observations
          where run_id = ${input.runId}
            and emitting_task = ${input.taskId}
            and loop_iteration = ${input.loopIteration}
            and attempt = ${input.attempt}
            and kind = 'provider_request_measurement'
            and (payload->>'providerRequestIndex')::int = ${input.providerRequestIndex}
          for update
        `;
        const measurementProofs = measurementRows[0]?.proofs;
        const measurementBindings = measurementRows[0]?.bindings;
        const isBinding = (value: unknown): value is ProviderVisibleSourceExposureProofBinding =>
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Number.isSafeInteger((value as Record<string, unknown>).messageIndex) &&
          Number.isSafeInteger((value as Record<string, unknown>).sourceOrdinal) &&
          typeof (value as Record<string, unknown>).serializedField === "string" &&
          typeof (value as Record<string, unknown>).orderedSourceDescriptor === "string" &&
          ((value as Record<string, unknown>).characterOffset === undefined ||
            Number.isSafeInteger((value as Record<string, unknown>).characterOffset)) &&
          ((value as Record<string, unknown>).publicDocumentId === undefined ||
            typeof (value as Record<string, unknown>).publicDocumentId === "string");
        const isDurableBindingRow = (
          value: unknown,
        ): value is {
          readonly providerSerializationProofSha256Hex: string;
          readonly providerSerializationProofBinding: ProviderVisibleSourceExposureProofBinding;
        } =>
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          typeof (value as Record<string, unknown>).providerSerializationProofSha256Hex ===
            "string" &&
          /^[0-9a-f]{64}$/u.test(
            (value as Record<string, unknown>).providerSerializationProofSha256Hex as string,
          ) &&
          isBinding((value as Record<string, unknown>).providerSerializationProofBinding);
        let providerSerializationProofSha256Hex: string | undefined;
        let providerSerializationProofBinding:
          | ProviderVisibleSourceExposureProofBinding
          | undefined;
        const existingAttestation = existingAttestedProofs[0];
        if (existingAttestedProofs.length > 1) {
          return yield* Effect.fail(
            replayConflict("ai_observations(source_exposure_attestation)", replayKey),
          );
        }
        if (
          existingAttestation !== undefined &&
          /^[0-9a-f]{64}$/u.test(existingAttestation.proof) &&
          isBinding(existingAttestation.binding)
        ) {
          providerSerializationProofSha256Hex = existingAttestation.proof;
          providerSerializationProofBinding = existingAttestation.binding;
        } else if (existingAttestation !== undefined) {
          return yield* Effect.fail(
            new Error("source exposure attestation lacks its exact provider field binding"),
          );
        }
        if (measurementProofs !== undefined && measurementProofs !== null) {
          if (
            !Array.isArray(measurementProofs) ||
            measurementProofs.some(
              (proof) => typeof proof !== "string" || !/^[0-9a-f]{64}$/u.test(proof),
            )
          ) {
            return yield* Effect.fail(new Error("provider measurement proof set is invalid"));
          }
          if (
            !Array.isArray(measurementBindings) ||
            measurementBindings.some((binding) => !isDurableBindingRow(binding)) ||
            new Set(
              (
                measurementBindings as readonly {
                  readonly providerSerializationProofSha256Hex: string;
                }[]
              ).map((binding) => binding.providerSerializationProofSha256Hex),
            ).size !== measurementBindings.length
          ) {
            return yield* Effect.fail(
              new Error(
                "provider measurement lacks its exact source exposure bindings: provider request measurement source proof bindings are not exact",
              ),
            );
          }
          const expectedProofs = [...measurementProofs].sort();
          const matchingBinding = callerBoundProof;
          if (
            providerSerializationProofSha256Hex !== undefined &&
            !expectedProofs.includes(providerSerializationProofSha256Hex)
          ) {
            return yield* Effect.fail(
              new Error("source exposure attestation differs from its provider measurement"),
            );
          }
          if (matchingBinding !== undefined) {
            if (!expectedProofs.includes(matchingBinding)) {
              return yield* Effect.fail(
                new Error("source exposure binding is absent from its provider measurement"),
              );
            }
            providerSerializationProofSha256Hex = matchingBinding;
            const durableBinding = (
              measurementBindings as readonly {
                readonly providerSerializationProofSha256Hex: string;
                readonly providerSerializationProofBinding: ProviderVisibleSourceExposureProofBinding;
              }[]
            ).find((binding) => binding.providerSerializationProofSha256Hex === matchingBinding);
            if (durableBinding === undefined) {
              return yield* Effect.fail(
                new Error(
                  "source exposure binding is absent from the durable provider measurement",
                ),
              );
            }
            providerSerializationProofBinding = durableBinding.providerSerializationProofBinding;
          } else if (providerSerializationProofSha256Hex === undefined) {
            const markerMatches = (
              measurementBindings as readonly {
                readonly providerSerializationProofSha256Hex: string;
                readonly providerSerializationProofBinding: ProviderVisibleSourceExposureProofBinding;
              }[]
            ).filter((binding) => {
              const computed = providerVisibleSourceExposureProofSha256Hex(
                marker,
                binding.providerSerializationProofBinding,
              );
              return (
                computed === binding.providerSerializationProofSha256Hex &&
                expectedProofs.includes(computed)
              );
            });
            if (markerMatches.length !== 1) {
              return yield* Effect.fail(
                new Error(
                  "source exposure lacks its exact durable provider sidecar binding: source exposure requires its exact provider field binding",
                ),
              );
            }
            providerSerializationProofSha256Hex =
              markerMatches[0]!.providerSerializationProofSha256Hex;
            providerSerializationProofBinding = markerMatches[0]!.providerSerializationProofBinding;
          }
        } else if (providerSerializationProofSha256Hex === undefined) {
          const sidecarBindings = providerRequestSourceExposureProofBindingCandidates(
            input.providerRequestSha256Hex,
            marker,
          );
          if (sidecarBindings.length === 0) {
            if (
              callerBoundProof === undefined ||
              input.providerSerializationProofBinding === undefined
            ) {
              return yield* Effect.fail(
                new Error("source exposure requires its exact provider field binding"),
              );
            }
            providerSerializationProofSha256Hex = callerBoundProof;
            providerSerializationProofBinding = input.providerSerializationProofBinding;
          } else {
            if (sidecarBindings.length !== 1) {
              return yield* Effect.fail(
                new Error("source exposure requires its exact repeated-field binding"),
              );
            }
            providerSerializationProofBinding = sidecarBindings[0]!;
            providerSerializationProofSha256Hex = providerVisibleSourceExposureProofSha256Hex(
              marker,
              providerSerializationProofBinding,
            );
          }
        }
        if (
          providerSerializationProofSha256Hex === undefined ||
          providerSerializationProofBinding === undefined ||
          providerVisibleSourceExposureProofSha256Hex(marker, providerSerializationProofBinding) !==
            providerSerializationProofSha256Hex
        ) {
          return yield* Effect.fail(
            new Error("source exposure provider proof does not match its exact field binding"),
          );
        }
        assertCanonicalDocumentExposureIdentity({
          ...input,
          providerSerializationProofBinding,
        });
        const attestationPayload = {
          ...sourceExposureAttestationPayloadForProof(
            input,
            providerSerializationProofSha256Hex,
            providerSerializationProofBinding,
          ),
        };
        const attestationPayloadJson = JSON.stringify(attestationPayload);
        const sameFieldDivergences = yield* sql<IdRow>`
          select id::text
          from ai_observations
          where run_id = ${input.runId}
            and emitting_task = ${input.taskId}
            and loop_iteration = ${input.loopIteration}
            and attempt = ${input.attempt}
            and kind = 'source_exposure_attestation'
            and (payload->>'providerRequestIndex')::int = ${input.providerRequestIndex}
            and payload->>'sourceKind' = ${input.sourceKind}
            and payload->>'exposureStage' = ${input.exposureStage}
            and payload->>'contentItemIdentity' = ${baseIdentity}
            and payload->'providerSerializationProofBinding' = ${JSON.stringify(providerSerializationProofBinding)}::jsonb
            and payload <> ${attestationPayloadJson}::jsonb
          for update
        `;
        if (sameFieldDivergences.length > 0) {
          return yield* Effect.fail(
            replayConflict(
              "ai_observations(source_exposure_attestation)",
              `${input.runId}:${input.taskId}:${input.loopIteration}:${input.attempt}:${input.providerRequestIndex}:${input.exposureStage}:${input.contentItemIdentity}`,
            ),
          );
        }
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
        if (exactAttestations.length > 1) {
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
          observationKey: sourceExposureAttestationKey(
            input,
            providerSerializationProofSha256Hex,
            providerSerializationProofBinding,
          ),
          kind: "source_exposure_attestation",
          payload: attestationPayload,
        });
        // A legacy row may predate its attestation. Replaying it is still
        // idempotent after the missing attestation is repaired in this same
        // transaction.
        return inserted;
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

    const emissionKey = `usage:request:model:${input.taskId}:${input.loopIteration}:${input.attempt}:${input.providerRequestIndex}`;
    const appended = yield* appendAiRunEventInTransaction({
      runId: input.runId,
      emissionKey,
      event: modelUsageEvent(input),
      emittedByTask: input.taskId,
    });
    if (
      !appended.inserted &&
      (appended.emittedByTask !== input.taskId ||
        stableJson(appended.event) !== stableJson(modelUsageEvent(input)))
    ) {
      return yield* Effect.fail(replayConflict("ai_run_events", `${input.runId}:${emissionKey}`));
    }

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
  durationMs: input.durationMs,
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

    const emissionKey = `usage:request:${input.operation}:${input.taskId}:${input.loopIteration}:${input.attempt}:${input.toolRequestIndex}`;
    const appended = yield* appendAiRunEventInTransaction({
      runId: input.runId,
      emissionKey,
      event: externalUsageEvent(input),
      emittedByTask: input.taskId,
    });
    if (
      !appended.inserted &&
      (appended.emittedByTask !== input.taskId ||
        stableJson(appended.event) !== stableJson(externalUsageEvent(input)))
    ) {
      return yield* Effect.fail(replayConflict("ai_run_events", `${input.runId}:${emissionKey}`));
    }

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
