import { z } from "zod";

import type { AiRunActivityErrorCategory } from "@hartlib/shared";

export const AI_RUN_ERROR_CODES = [
  "plan_turn_failed",
  "internal_retrieval_failed",
  "memory_selector_failed",
  "web_research_failed",
  "context_compaction_failed",
  "answer_failed",
  "topic_answer_failed",
  "synthesis_failed",
  "memory_extraction_failed",
  "agent_context_budget_exceeded",
  "context_mandatory_too_large",
  "context_plan_unfit",
  "synthesis_budget_mismatch",
  "context_budget_mismatch",
  "memory_conflict",
  "context_assembly_failed",
  "workflow_resume_incompatible",
  "invalid_workflow_output",
  "finalization_failed",
] as const;

export type AiRunErrorCode = (typeof AI_RUN_ERROR_CODES)[number];

const retryability = {
  plan_turn_failed: true,
  internal_retrieval_failed: true,
  memory_selector_failed: true,
  web_research_failed: true,
  context_compaction_failed: true,
  answer_failed: true,
  topic_answer_failed: true,
  synthesis_failed: true,
  memory_extraction_failed: true,
  agent_context_budget_exceeded: false,
  context_mandatory_too_large: false,
  context_plan_unfit: false,
  synthesis_budget_mismatch: false,
  context_budget_mismatch: false,
  memory_conflict: true,
  context_assembly_failed: true,
  workflow_resume_incompatible: true,
  invalid_workflow_output: true,
  finalization_failed: true,
} as const satisfies Record<AiRunErrorCode, boolean>;

export const isAiRunErrorCode = (value: string): value is AiRunErrorCode =>
  (AI_RUN_ERROR_CODES as readonly string[]).includes(value);

export const isRetryableAiRunError = (code: AiRunErrorCode): boolean => retryability[code];

export const aiRunErrorCodeForRole = (role: string): AiRunErrorCode => {
  switch (role) {
    case "plan_turn":
      return "plan_turn_failed";
    case "internal_retrieval":
      return "internal_retrieval_failed";
    case "memory_selector":
      return "memory_selector_failed";
    case "web_research":
      return "web_research_failed";
    case "context_manifest":
    case "context_compact_group":
    case "context_fallback_manifest":
    case "context_fallback_group":
    case "context_source_tool":
      return "context_compaction_failed";
    case "direct_answer":
      return "answer_failed";
    case "topic_answer":
      return "topic_answer_failed";
    case "synthesis":
      return "synthesis_failed";
    case "memory_extractor":
      return "memory_extraction_failed";
    default:
      return "invalid_workflow_output";
  }
};

export interface AiRuntimeErrorOptions {
  /** Whether the owning Smithers task may consume another attempt. */
  readonly taskRetryable?: boolean | undefined;
  /** Whether the final product error may invite the user to retry. */
  readonly retryable?: boolean | undefined;
  /** Sanitized HTTP status metadata, when Pi exposes one. */
  readonly providerStatus?: number | undefined;
  /** Closed, content-free category used by logs and run diagnostics. */
  readonly category?: AiRunActivityErrorCategory | undefined;
}

export interface AiRuntimeFailureMetadata {
  readonly code: AiRunErrorCode;
  readonly retryable: boolean;
  readonly providerStatus: number | null;
  readonly category: AiRunActivityErrorCategory;
  readonly message: string;
}

const aiRuntimeErrors = new WeakSet<object>();
const DURABLE_AI_RUNTIME_ERROR_JSON_MAX_LENGTH = 131_072;
const DURABLE_AI_RUNTIME_ERROR_MESSAGE_MAX_LENGTH = 2_048;
const DURABLE_AI_RUNTIME_ERROR_STACK_MAX_LENGTH = 65_536;

const runtimeErrorCategoryValues = [
  "provider_transport",
  "provider_response",
  "provider_output",
  "context_budget",
  "validation",
  "authorization",
  "storage",
  "workflow",
  "unknown",
] as const satisfies readonly AiRunActivityErrorCategory[];
const runtimeErrorCategorySchema = z.enum(runtimeErrorCategoryValues);

export const aiRunErrorCategoryForCode = (code: AiRunErrorCode): AiRunActivityErrorCategory => {
  switch (code) {
    case "agent_context_budget_exceeded":
    case "context_mandatory_too_large":
    case "context_plan_unfit":
    case "synthesis_budget_mismatch":
    case "context_budget_mismatch":
      return "context_budget";
    case "invalid_workflow_output":
    case "workflow_resume_incompatible":
      return "validation";
    case "memory_conflict":
      return "storage";
    default:
      return "workflow";
  }
};

export const aiRuntimeDiagnosticMessage = (
  category: AiRunActivityErrorCategory,
  providerStatus: number | null,
): string => {
  switch (category) {
    case "provider_transport":
      return "The model provider did not return a response.";
    case "provider_response":
      return providerStatus === null
        ? "The model provider returned an error response."
        : `The model provider returned an error response (HTTP ${providerStatus}).`;
    case "provider_output":
      return "The model provider returned an unusable structured result.";
    case "context_budget":
      return "The provider request did not fit the available context budget.";
    case "validation":
      return "The workflow returned an invalid result.";
    case "authorization":
      return "The model provider did not authorize the request.";
    case "storage":
      return "The workflow could not save its result.";
    case "workflow":
      return "The workflow operation failed.";
    case "unknown":
      return "The workflow failed at a runtime boundary.";
  }
};

/**
 * Keep diagnostic text code-owned even when it crosses a generic object
 * boundary. The only variable detail we retain is a validated HTTP status.
 */
export const sanitizeAiRuntimeDiagnosticMessage = (
  category: AiRunActivityErrorCategory,
  candidate: string | undefined,
): string => {
  const generic = aiRuntimeDiagnosticMessage(category, null);
  if (candidate === generic) return generic;
  if (category !== "provider_response") return generic;
  const match = /^The model provider returned an error response \(HTTP ([1-5][0-9]{2})\)\.$/u.exec(
    candidate ?? "",
  );
  return match === null ? generic : aiRuntimeDiagnosticMessage(category, Number(match[1]));
};

const durableAiRuntimeErrorSchema = z.strictObject({
  name: z.literal("AiRuntimeError"),
  message: z.string().min(1).max(DURABLE_AI_RUNTIME_ERROR_MESSAGE_MAX_LENGTH),
  stack: z.string().max(DURABLE_AI_RUNTIME_ERROR_STACK_MAX_LENGTH).optional(),
  code: z.string().optional(),
  retryable: z.boolean().optional(),
  providerStatus: z.number().int().nullable().optional(),
  category: runtimeErrorCategorySchema.optional(),
  diagnosticMessage: z.string().max(512).optional(),
});

const durableAiRuntimeErrorMessagePattern =
  /^\[([a-z_]+)\]\[retryable:(true|false)\](?:\[provider_status:([1-5][0-9]{2})\])?(?:\[category:([a-z_]+)\])? ([^\r\n[\]]{1,2048})$/u;

const retryableStatus = (status: number): boolean =>
  status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;

/** Classifies only a trusted numeric transport status, never provider text. */
export const isRetryableProviderStatus = (status: number): boolean => retryableStatus(status);

const isHttpStatus = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599;

export const isAbortError = (error: unknown): error is Error =>
  error instanceof Error && error.name === "AbortError";

export class AiRuntimeError extends Error {
  readonly retryable: boolean;
  readonly providerStatus: number | null;
  readonly category: AiRunActivityErrorCategory;
  readonly diagnosticMessage: string;
  /** Smithers 0.31.0 honors this structural flag without importing its Effect 3 errors. */
  readonly details:
    | { readonly failureRetryable: false; readonly providerStatus?: number }
    | undefined;

  constructor(
    readonly code: AiRunErrorCode,
    message: string,
    options: AiRuntimeErrorOptions = {},
  ) {
    const retryable = options.retryable ?? isRetryableAiRunError(code);
    const providerStatus = isHttpStatus(options.providerStatus) ? options.providerStatus : null;
    const category = options.category ?? aiRunErrorCategoryForCode(code);
    // Smithers may retain only Error.message at its durable JSON boundary.
    // Include stable, content-free terminal metadata without adding provider
    // payloads or prompt text. Its generic Error serializer otherwise drops
    // enumerable code/retryable/details fields.
    super(
      `[${code}][retryable:${retryable}]${providerStatus === null ? "" : `[provider_status:${providerStatus}]`}[category:${category}] ${message}`,
    );
    this.name = "AiRuntimeError";
    this.retryable = retryable;
    this.providerStatus = providerStatus;
    this.category = category;
    this.diagnosticMessage = aiRuntimeDiagnosticMessage(category, providerStatus);
    this.details =
      (options.taskRetryable ?? retryable) === false
        ? {
            failureRetryable: false,
            ...(providerStatus === null ? {} : { providerStatus }),
          }
        : undefined;
    aiRuntimeErrors.add(this);
  }
}

/** Rejects prototype forgeries; only this module's constructor can establish the brand. */
export const isAiRuntimeError = (error: unknown): error is AiRuntimeError => {
  try {
    return error instanceof AiRuntimeError && aiRuntimeErrors.has(error);
  } catch {
    return false;
  }
};

/** Reads metadata only from an actual in-process, branded runtime failure. */
export const aiRuntimeFailureMetadata = (error: unknown): AiRuntimeFailureMetadata | undefined => {
  if (!isAiRuntimeError(error)) return undefined;
  return {
    code: error.code,
    retryable: error.retryable,
    providerStatus: error.providerStatus,
    category: error.category,
    message: error.diagnosticMessage,
  };
};

/** Strictly decodes one exact `errorToJson(AiRuntimeError)` Smithers record. */
export const aiRuntimeFailureMetadataFromDurableJson = (
  serialized: string,
): AiRuntimeFailureMetadata | undefined => {
  if (serialized.length > DURABLE_AI_RUNTIME_ERROR_JSON_MAX_LENGTH) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized) as unknown;
  } catch {
    return undefined;
  }
  const parsed = durableAiRuntimeErrorSchema.safeParse(decoded);
  if (!parsed.success) return undefined;
  const match = durableAiRuntimeErrorMessagePattern.exec(parsed.data.message);
  const code = match?.[1];
  const retryable = match?.[2];
  const status = match?.[3];
  const markedCategory = match?.[4];
  if (
    code === undefined ||
    !isAiRunErrorCode(code) ||
    (retryable !== "true" && retryable !== "false")
  ) {
    return undefined;
  }
  if (
    markedCategory !== undefined &&
    !(runtimeErrorCategoryValues as readonly string[]).includes(markedCategory)
  ) {
    return undefined;
  }
  const parsedStatus = status === undefined ? null : Number(status);
  const category =
    parsed.data.category ??
    (markedCategory as AiRunActivityErrorCategory | undefined) ??
    aiRunErrorCategoryForCode(code);
  // Smithers normally retains only the generic Error fields. If a richer
  // record survives, require the complete metadata tuple and make sure it
  // agrees with the signed message marker. Reject partial extensions so a
  // hostile record cannot add one plausible field to an otherwise valid one.
  const hasSerializedMetadata =
    parsed.data.code !== undefined ||
    parsed.data.retryable !== undefined ||
    parsed.data.providerStatus !== undefined ||
    parsed.data.category !== undefined ||
    parsed.data.diagnosticMessage !== undefined;
  if (hasSerializedMetadata) {
    const serializedCategory = category;
    const serializedMessage = aiRuntimeDiagnosticMessage(serializedCategory, parsedStatus);
    if (
      parsed.data.code !== code ||
      parsed.data.retryable !== (retryable === "true") ||
      parsed.data.providerStatus !== parsedStatus ||
      (markedCategory !== undefined && markedCategory !== category) ||
      (parsed.data.category !== undefined && parsed.data.diagnosticMessage === undefined) ||
      (parsed.data.diagnosticMessage !== undefined &&
        parsed.data.diagnosticMessage !== serializedMessage
      )
    ) {
      return undefined;
    }
  }
  return {
    code,
    retryable: retryable === "true",
    providerStatus: parsedStatus,
    category,
    message: aiRuntimeDiagnosticMessage(category, parsedStatus),
  };
};

export const toAiRuntimeError = (
  error: unknown,
  fallbackCode: AiRunErrorCode,
  options: AiRuntimeErrorOptions = {},
): Error => {
  if (isAbortError(error) || isAiRuntimeError(error)) return error;
  // Web policy failures already carry a bounded, code-owned type. Preserve
  // that non-retryable decision instead of relabeling it as a retryable
  // web-research task failure at the agent boundary.
  if (
    error !== null &&
    typeof error === "object" &&
    (error as { readonly name?: unknown }).name === "WebBoundaryError" &&
    (error as { readonly code?: unknown }).code === "unsupported_policy" &&
    (error as { readonly retryable?: unknown }).retryable === false
  ) {
    return error as Error;
  }
  const providerStatus = isHttpStatus(options.providerStatus) ? options.providerStatus : undefined;
  // Product retryability is code-owned by default.  Only an explicit
  // in-process option (owned by this boundary) or a trusted numeric transport
  // status may override it; provider/validation text and arbitrary attached
  // `retryable` fields are deliberately ignored.
  const inferredRetryable =
    options.retryable ??
    (providerStatus === undefined ? undefined : retryableStatus(providerStatus));
  const taskRetryable = options.taskRetryable ?? inferredRetryable;
  return new AiRuntimeError(fallbackCode, "runtime boundary failed", {
    ...(providerStatus === undefined ? {} : { providerStatus }),
    ...(options.category === undefined ? {} : { category: options.category }),
    ...(inferredRetryable === undefined
      ? options.taskRetryable === undefined
        ? {}
        : { taskRetryable }
      : {
          retryable: inferredRetryable,
          ...(taskRetryable === undefined ? {} : { taskRetryable }),
        }),
  });
};
