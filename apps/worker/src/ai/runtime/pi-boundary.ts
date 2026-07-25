import type {
  AssistantMessage,
  Context,
  Message,
  Model,
  Tool,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { completeSimple, streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

import {
  measureProviderRequest,
  resolveRuntimeModel,
  type AcceptedProviderProfile,
  type ProviderGateLimits,
  type RuntimeModelId,
} from "./model-registry";
import {
  aiRunErrorCodeForRole,
  AiRuntimeError,
  isAbortError,
  isRetryableProviderStatus,
  toAiRuntimeError,
} from "./errors";
import {
  normalizeProviderRequest,
  providerRequestSha256Hex,
  providerRequestSourceExposureProofBindings,
  providerRequestSourceExposureProofs,
  requireLiveProviderRequest,
  type ProviderMessage,
  type LiveProviderRequest,
  type ProviderRequest,
  type ProviderRequestSourceExposureProofBinding,
  type ProviderToolCall,
} from "./provider-request";
import type { LiveProviderRequestMeasurement, ModelUsage } from "./types";
import type { AiProviderServiceId } from "@brief/shared";
import { workerProviderSemaphore, type ProviderSemaphore } from "./provider-semaphore";
import { withProviderOriginGuard } from "./provider-origin-guard";
import {
  currentTaskAbortSignal,
  requireCurrentTaskCoordinates,
  throwIfAborted,
} from "./task-cancellation";

export interface PiBoundaryCoordinates {
  readonly taskId: string;
  readonly loopIteration: number;
  readonly attempt: number;
  readonly providerRequestIndex: number;
  readonly agentRole: string;
}

export interface AttestedPiBoundaryCoordinates extends PiBoundaryCoordinates {
  /** Digest of the exact normalized request that passed the local gate. */
  readonly providerRequestSha256Hex: string;
}

export interface PiBoundaryHooks {
  readonly onMeasurement?: (
    coordinates: PiBoundaryCoordinates,
    measurement: LiveProviderRequestMeasurement,
    request: LiveProviderRequest,
    sourceExposureProofSha256Hexes: readonly string[],
    sourceExposureProofBindings: readonly ProviderRequestSourceExposureProofBinding[],
  ) => Promise<void> | void;
  readonly onUsage?: (
    coordinates: PiBoundaryCoordinates,
    modelId: LiveProviderRequest["model"],
    usage: ModelUsage,
  ) => Promise<void> | void;
}

/**
 * Runs only after the exact normalized request passes its local gate and its
 * measurement is durable, while the provider permit is held and before the
 * provider transport starts. Authorization and public event/exposure writes
 * belong here so a rejected gate cannot expose context or announce an answer.
 */
export type BeforeProviderRequest = (
  request: LiveProviderRequest,
  coordinates: AttestedPiBoundaryCoordinates,
  measurement: LiveProviderRequestMeasurement,
) => Promise<void> | void;

export interface PiBoundaryOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  /** Runtime provider identity. Production callers must set this explicitly. */
  readonly providerServiceId?: AiProviderServiceId | undefined;
  /** Runtime model identities captured when the boundary is constructed. */
  readonly fastModelId?: RuntimeModelId | undefined;
  readonly mainModelId?: RuntimeModelId | undefined;
  /** Require load-turn to bind the immutable accepted profile before a call. */
  readonly requireAcceptedProviderProfile?: boolean | undefined;
  /** Resume-safe loader for runs whose load-turn task already completed. */
  readonly loadAcceptedProviderProfile?: (() => Promise<AcceptedProviderProfile>) | undefined;
  readonly fastLimits: ProviderGateLimits;
  readonly mainLimits: ProviderGateLimits;
  readonly fastTimeoutMs: number;
  readonly answerTimeoutMs: number;
  readonly hooks?: PiBoundaryHooks | undefined;
  readonly complete?: typeof completeSimple | undefined;
  readonly stream?: typeof streamSimple | undefined;
  readonly providerSemaphore?: ProviderSemaphore | undefined;
}

export interface PiCompletion {
  readonly text: string;
  readonly toolCalls: readonly ProviderToolCall[];
  readonly usage: ModelUsage;
  readonly stopReason: string;
}

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: zeroCost,
});

const toModelUsage = (message: AssistantMessage): ModelUsage => ({
  inputTokens: message.usage.input,
  outputTokens: message.usage.output,
  // Pi's pinned OpenAI-compatible transport subtracts both cache reads and
  // cache writes from `input`, while retaining them in `totalTokens`. Brief's
  // single cached-token field therefore carries their complete sum so no
  // provider-accounted prompt token disappears from durable arithmetic.
  cachedTokens: message.usage.cacheRead + message.usage.cacheWrite,
  reasoningTokens: message.usage.reasoning ?? 0,
  totalTokens: message.usage.totalTokens,
  stopReason: message.stopReason,
});

const toProviderToolCall = (call: ToolCall): ProviderToolCall => ({
  id: call.id,
  name: call.name,
  arguments: call.arguments,
});

const toCompletion = (message: AssistantMessage): PiCompletion => ({
  text: message.content
    .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join(""),
  toolCalls: message.content
    .filter((item): item is ToolCall => item.type === "toolCall")
    .map(toProviderToolCall),
  usage: toModelUsage(message),
  stopReason: message.stopReason,
});

/**
 * Provider usage is durable accounting, not an advisory hint.  Validate the
 * complete arithmetic before the usage hook can persist a row or append its
 * event.  Number.isSafeInteger also keeps the in-memory representation
 * compatible with PostgreSQL integer arithmetic and rejects NaN/Infinity.
 */
const isNonnegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const validateProviderUsage = (usage: ModelUsage, role: string): void => {
  const fields = [
    usage.inputTokens,
    usage.cachedTokens,
    usage.outputTokens,
    usage.reasoningTokens,
    usage.totalTokens,
  ];
  const total = usage.inputTokens + usage.cachedTokens + usage.outputTokens;
  if (
    fields.some((value) => !isNonnegativeSafeInteger(value)) ||
    !Number.isSafeInteger(total) ||
    usage.totalTokens !== total ||
    usage.reasoningTokens > usage.outputTokens
  ) {
    throw new AiRuntimeError(aiRunErrorCodeForRole(role), "provider usage accounting is invalid", {
      taskRetryable: true,
    });
  }
};

const hasKnownUsage = (usage: ModelUsage): boolean =>
  usage.inputTokens > 0 ||
  usage.outputTokens > 0 ||
  usage.cachedTokens > 0 ||
  usage.reasoningTokens > 0 ||
  usage.totalTokens > 0;

const providerFailure = (
  message: AssistantMessage,
  role: string,
  observedStatus?: number,
): AiRuntimeError => {
  return new AiRuntimeError(aiRunErrorCodeForRole(role), "provider request failed", {
    // Provider-authored error text may influence the owning task's bounded
    // retry lane, but never the durable product retryability.  The latter is
    // the canonical role decision unless trusted transport status metadata is
    // available from Pi's response callback.
    taskRetryable: isRetryableAssistantError(message),
    ...(observedStatus === undefined
      ? {}
      : { providerStatus: observedStatus, retryable: isRetryableProviderStatus(observedStatus) }),
  });
};

const toPiMessage = (message: Exclude<ProviderMessage, { role: "system" }>): Message => {
  if (message.role === "user") {
    return { role: "user", content: message.content, timestamp: 0 };
  }
  if (message.role === "tool") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.name,
      content: [{ type: "text", text: message.content }],
      isError: false,
      timestamp: 0,
    };
  }
  return {
    role: "assistant",
    content: [
      ...(message.content === "" ? [] : [{ type: "text" as const, text: message.content }]),
      ...(message.toolCalls ?? []).map((call) => ({
        type: "toolCall" as const,
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    ],
    api: "openai-completions",
    provider: "zai",
    model: "history",
    usage: zeroUsage(),
    stopReason: message.toolCalls?.length ? "toolUse" : "stop",
    timestamp: 0,
  };
};

const toPiContext = (request: LiveProviderRequest): Context => {
  const systems = request.messages.filter((message) => message.role === "system");
  const messages = request.messages.filter(
    (message): message is Exclude<ProviderMessage, { role: "system" }> => message.role !== "system",
  );
  return {
    ...(systems.length === 0
      ? {}
      : { systemPrompt: systems.map((message) => message.content).join("\n\n") }),
    messages: messages.map(toPiMessage),
    ...(request.tools === undefined
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })) as unknown as Tool[],
        }),
  };
};

const resolveModel = (
  request: LiveProviderRequest,
  baseUrl: string,
): Model<"openai-completions"> => ({
  ...getBuiltinModel("zai", request.model),
  baseUrl,
});

const toolChoice = (choice: ProviderRequest["toolChoice"]): unknown =>
  typeof choice === "object" ? { type: "function", function: { name: choice.name } } : choice;

export class ExactPiBoundary {
  private readonly runComplete: typeof completeSimple;
  private readonly runStream: typeof streamSimple;
  private readonly providerSemaphore: ProviderSemaphore;
  private acceptedProviderProfile: AcceptedProviderProfile | undefined;

  constructor(private readonly options: PiBoundaryOptions) {
    this.runComplete = options.complete ?? completeSimple;
    this.runStream = options.stream ?? streamSimple;
    this.providerSemaphore = options.providerSemaphore ?? workerProviderSemaphore;
  }

  bindAcceptedProviderProfile(profile: AcceptedProviderProfile): void {
    const current = this.acceptedProviderProfile;
    if (
      current !== undefined &&
      (current.providerServiceId !== profile.providerServiceId ||
        current.fastModelId !== profile.fastModelId ||
        current.mainModelId !== profile.mainModelId)
    ) {
      throw new AiRuntimeError(
        "invalid_workflow_output",
        "accepted provider profile cannot be rebound",
        { taskRetryable: false },
      );
    }
    if (
      this.options.providerServiceId !== undefined &&
      this.options.providerServiceId !== profile.providerServiceId
    ) {
      throw new AiRuntimeError(
        "invalid_workflow_output",
        "accepted provider service differs from the runtime provider",
        { taskRetryable: false },
      );
    }
    if (
      (this.options.fastModelId !== undefined &&
        this.options.fastModelId !== profile.fastModelId) ||
      (this.options.mainModelId !== undefined && this.options.mainModelId !== profile.mainModelId)
    ) {
      throw new AiRuntimeError(
        "invalid_workflow_output",
        "accepted model differs from the runtime model",
        { taskRetryable: false },
      );
    }
    this.acceptedProviderProfile = profile;
  }

  private assertAcceptedProviderProfile(request: ProviderRequest): void | Promise<void> {
    if (this.acceptedProviderProfile === undefined && this.options.loadAcceptedProviderProfile) {
      return this.options.loadAcceptedProviderProfile().then((profile) => {
        this.bindAcceptedProviderProfile(profile);
        this.assertAcceptedProviderProfile(request);
      });
    }
    const profile = this.acceptedProviderProfile;
    if (profile === undefined) {
      if (this.options.requireAcceptedProviderProfile === true) {
        throw new AiRuntimeError(
          "invalid_workflow_output",
          "provider request is missing its accepted provider profile",
          { taskRetryable: false },
        );
      }
      return;
    }
    const expectedModel =
      request.requestClass === "fast" ? profile.fastModelId : profile.mainModelId;
    if (request.model !== expectedModel) {
      throw new AiRuntimeError(
        "invalid_workflow_output",
        "provider request model differs from the accepted model",
        { taskRetryable: false },
      );
    }
  }

  private async gate(
    request: ProviderRequest,
    coordinates: PiBoundaryCoordinates,
    signal: AbortSignal | undefined,
    beforeProviderRequest: BeforeProviderRequest | undefined,
  ) {
    throwIfAborted(signal);
    const profileCheck = this.assertAcceptedProviderProfile(request);
    if (profileCheck !== undefined) await profileCheck;
    const normalizedRequest = requireLiveProviderRequest(normalizeProviderRequest(request));
    const model = resolveRuntimeModel(normalizedRequest.model);
    const limits =
      normalizedRequest.requestClass === "main" ? this.options.mainLimits : this.options.fastLimits;
    const measurement = measureProviderRequest(normalizedRequest, model, limits);
    const sourceExposureProofSha256Hexes = providerRequestSourceExposureProofs(
      normalizedRequest,
      (text) => model.countTextTokens(text),
    );
    const sourceExposureProofBindings = providerRequestSourceExposureProofBindings(
      normalizedRequest,
      (text) => model.countTextTokens(text),
    );
    throwIfAborted(signal);
    // `passed` is computed before any durable observation, event, exposure, or
    // authorization callback can run. Failed gates retain their measurement but
    // cannot advance to the pre-provider callback.
    await this.options.hooks?.onMeasurement?.(
      coordinates,
      measurement,
      normalizedRequest,
      sourceExposureProofSha256Hexes,
      sourceExposureProofBindings,
    );
    throwIfAborted(signal);
    if (!measurement.passed) {
      throw new AiRuntimeError(
        "agent_context_budget_exceeded",
        `provider request contains ${measurement.inputTokens} tokens but only ${measurement.usableInputTokens} fit`,
      );
    }
    await beforeProviderRequest?.(
      normalizedRequest,
      { ...coordinates, providerRequestSha256Hex: providerRequestSha256Hex(normalizedRequest) },
      measurement,
    );
    throwIfAborted(signal);
    return { model, measurement, request: normalizedRequest };
  }

  async complete(
    request: LiveProviderRequest,
    coordinates: PiBoundaryCoordinates,
    beforeProviderRequest?: BeforeProviderRequest,
  ): Promise<PiCompletion> {
    const signal = currentTaskAbortSignal();
    const executionCoordinates = {
      ...coordinates,
      ...requireCurrentTaskCoordinates(coordinates.taskId),
    };
    let observedStatus: number | undefined;
    try {
      const { message, providerRequest } = await this.providerSemaphore.withPermit(async () => {
        const gated = await this.gate(request, executionCoordinates, signal, beforeProviderRequest);
        const providerRequest = gated.request;
        throwIfAborted(signal);
        const message = await withProviderOriginGuard(this.options.baseUrl, () =>
          this.runComplete(
            resolveModel(providerRequest, this.options.baseUrl),
            toPiContext(providerRequest),
            {
              apiKey: this.options.apiKey,
              maxTokens: providerRequest.requestedOutputTokens,
              reasoning: providerRequest.reasoning,
              maxRetries: 0,
              ...(signal === undefined ? {} : { signal }),
              timeoutMs:
                providerRequest.requestClass === "main"
                  ? this.options.answerTimeoutMs
                  : this.options.fastTimeoutMs,
              onResponse: (response) => {
                observedStatus = response.status;
              },
              ...(providerRequest.toolChoice === undefined
                ? {}
                : { toolChoice: toolChoice(providerRequest.toolChoice) }),
            } as Parameters<typeof completeSimple>[2],
          ),
        );
        return { message, providerRequest };
      }, signal);
      throwIfAborted(signal);
      if (message.stopReason === "aborted") {
        const aborted = new Error("provider request aborted");
        aborted.name = "AbortError";
        throw aborted;
      }
      const completion = toCompletion(message);
      validateProviderUsage(completion.usage, executionCoordinates.agentRole);
      throwIfAborted(signal);
      if (message.stopReason !== "error" || hasKnownUsage(completion.usage)) {
        await this.options.hooks?.onUsage?.(
          executionCoordinates,
          providerRequest.model,
          completion.usage,
        );
      }
      throwIfAborted(signal);
      if (message.stopReason === "error") {
        throw providerFailure(message, executionCoordinates.agentRole, observedStatus);
      }
      return completion;
    } catch (error) {
      throwIfAborted(signal);
      if (isAbortError(error)) throw error;
      throw toAiRuntimeError(
        error,
        aiRunErrorCodeForRole(executionCoordinates.agentRole),
        observedStatus === undefined ? {} : { providerStatus: observedStatus },
      );
    }
  }

  async stream(
    request: LiveProviderRequest,
    coordinates: PiBoundaryCoordinates,
    onDelta: (delta: string, index: number) => Promise<void> | void,
    beforeProviderRequest?: BeforeProviderRequest,
  ): Promise<PiCompletion> {
    const signal = currentTaskAbortSignal();
    const executionCoordinates = {
      ...coordinates,
      ...requireCurrentTaskCoordinates(coordinates.taskId),
    };
    let observedStatus: number | undefined;
    try {
      const { final, providerRequest } = await this.providerSemaphore.withPermit(async () => {
        const gated = await this.gate(request, executionCoordinates, signal, beforeProviderRequest);
        const providerRequest = gated.request;
        throwIfAborted(signal);
        const stream = await withProviderOriginGuard(this.options.baseUrl, async () =>
          this.runStream(
            resolveModel(providerRequest, this.options.baseUrl),
            toPiContext(providerRequest),
            {
              apiKey: this.options.apiKey,
              maxTokens: providerRequest.requestedOutputTokens,
              reasoning: providerRequest.reasoning,
              maxRetries: 0,
              ...(signal === undefined ? {} : { signal }),
              timeoutMs:
                providerRequest.requestClass === "main"
                  ? this.options.answerTimeoutMs
                  : this.options.fastTimeoutMs,
              onResponse: (response) => {
                observedStatus = response.status;
              },
            },
          ),
        );
        let streamedFinal: AssistantMessage | undefined;
        let deltaIndex = 0;
        for await (const event of stream) {
          throwIfAborted(signal);
          if (event.type === "text_delta") {
            await onDelta(event.delta, deltaIndex++);
            throwIfAborted(signal);
          } else if (event.type === "done") {
            streamedFinal = event.message;
          } else if (event.type === "error") {
            streamedFinal = event.error;
          }
        }
        throwIfAborted(signal);
        return { final: streamedFinal, providerRequest };
      }, signal);
      throwIfAborted(signal);
      if (final === undefined) throw new Error("provider stream ended without a final message");
      if (final.stopReason === "aborted") {
        const aborted = new Error("provider request aborted");
        aborted.name = "AbortError";
        throw aborted;
      }
      const completion = toCompletion(final);
      validateProviderUsage(completion.usage, executionCoordinates.agentRole);
      throwIfAborted(signal);
      if (final.stopReason !== "error" || hasKnownUsage(completion.usage)) {
        await this.options.hooks?.onUsage?.(
          executionCoordinates,
          providerRequest.model,
          completion.usage,
        );
      }
      throwIfAborted(signal);
      if (final.stopReason === "error") {
        throw providerFailure(final, executionCoordinates.agentRole, observedStatus);
      }
      return completion;
    } catch (error) {
      throwIfAborted(signal);
      if (isAbortError(error)) throw error;
      throw toAiRuntimeError(
        error,
        aiRunErrorCodeForRole(executionCoordinates.agentRole),
        observedStatus === undefined ? {} : { providerStatus: observedStatus },
      );
    }
  }
}
