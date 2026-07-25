import { z } from "zod";

export const AI_RUN_ERROR_CODES = [
  "plan_turn_failed",
  "internal_retrieval_failed",
  "memory_selector_failed",
  "web_research_failed",
  "context_reducer_failed",
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

export type AiAgentRole =
  | "plan_turn"
  | "internal_retrieval"
  | "memory_selector"
  | "web_research"
  | "context_reducer"
  | "direct_answer"
  | "topic_answer"
  | "synthesis"
  | "memory_extractor";

const retryability = {
  plan_turn_failed: true,
  internal_retrieval_failed: true,
  memory_selector_failed: true,
  web_research_failed: true,
  context_reducer_failed: true,
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
  switch (role as AiAgentRole) {
    case "plan_turn":
      return "plan_turn_failed";
    case "internal_retrieval":
      return "internal_retrieval_failed";
    case "memory_selector":
      return "memory_selector_failed";
    case "web_research":
      return "web_research_failed";
    case "context_reducer":
      return "context_reducer_failed";
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
}

export interface AiRuntimeFailureMetadata {
  readonly code: AiRunErrorCode;
  readonly retryable: boolean;
  readonly providerStatus: number | null;
}

const aiRuntimeErrors = new WeakSet<object>();
const DURABLE_AI_RUNTIME_ERROR_JSON_MAX_LENGTH = 131_072;
const DURABLE_AI_RUNTIME_ERROR_MESSAGE_MAX_LENGTH = 2_048;
const DURABLE_AI_RUNTIME_ERROR_STACK_MAX_LENGTH = 65_536;

const durableAiRuntimeErrorSchema = z.strictObject({
  name: z.literal("AiRuntimeError"),
  message: z.string().min(1).max(DURABLE_AI_RUNTIME_ERROR_MESSAGE_MAX_LENGTH),
  stack: z.string().max(DURABLE_AI_RUNTIME_ERROR_STACK_MAX_LENGTH).optional(),
});

const durableAiRuntimeErrorMessagePattern =
  /^\[([a-z_]+)\]\[retryable:(true|false)\](?:\[provider_status:([1-5][0-9]{2})\])? ([^\r\n[\]]{1,2048})$/u;

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
  /** Smithers 0.30.0 honors this structural flag without importing its Effect 3 errors. */
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
    // Smithers may retain only Error.message at its durable JSON boundary.
    // Include stable, content-free terminal metadata without adding provider
    // payloads or prompt text. Its generic Error serializer otherwise drops
    // enumerable code/retryable/details fields.
    super(
      `[${code}][retryable:${retryable}]${providerStatus === null ? "" : `[provider_status:${providerStatus}]`} ${message}`,
    );
    this.name = "AiRuntimeError";
    this.retryable = retryable;
    this.providerStatus = providerStatus;
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
  if (
    code === undefined ||
    !isAiRunErrorCode(code) ||
    (retryable !== "true" && retryable !== "false")
  ) {
    return undefined;
  }
  const parsedStatus = status === undefined ? null : Number(status);
  return {
    code,
    retryable: retryable === "true",
    providerStatus: parsedStatus,
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
