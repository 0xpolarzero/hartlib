import { AiRuntimeError } from "../runtime/errors";
import {
  measureProviderRequest,
  resolveRuntimeModel,
  type AcceptedProviderProfile,
  type ProviderGateLimits,
} from "../runtime/model-registry";
import type { AiProviderServiceId } from "@brief/shared";
import type {
  BeforeProviderRequest,
  PiBoundaryCoordinates,
  PiBoundaryHooks,
  PiCompletion,
} from "../runtime/pi-boundary";
import type {
  LiveProviderRequest,
  ProviderMessage,
  ProviderRequest,
  ProviderToolCall,
} from "../runtime/provider-request";
import {
  normalizeProviderRequest,
  providerRequestSha256Hex,
  providerRequestSourceExposureProofs,
  requireLiveProviderRequest,
} from "../runtime/provider-request";
import {
  currentTaskAbortSignal,
  requireCurrentTaskCoordinates,
  throwIfAborted,
} from "../runtime/task-cancellation";
import { e2eStreamGateIdFromMessage } from "./stream-gate";

export interface PiRuntimeBoundary {
  readonly bindAcceptedProviderProfile?: (profile: AcceptedProviderProfile) => void;
  readonly complete: (
    request: LiveProviderRequest,
    coordinates: PiBoundaryCoordinates,
    beforeProviderRequest?: BeforeProviderRequest,
  ) => Promise<PiCompletion>;
  readonly stream: (
    request: LiveProviderRequest,
    coordinates: PiBoundaryCoordinates,
    onDelta: (delta: string, index: number) => Promise<void> | void,
    beforeProviderRequest?: BeforeProviderRequest,
  ) => Promise<PiCompletion>;
}

interface DeterministicBoundaryOptions {
  readonly fastLimits: ProviderGateLimits;
  readonly mainLimits: ProviderGateLimits;
  readonly providerServiceId?: AiProviderServiceId | undefined;
  readonly fastModelId?: "glm-5-turbo" | undefined;
  readonly mainModelId?: "glm-5-turbo" | undefined;
  readonly requireAcceptedProviderProfile?: boolean | undefined;
  readonly loadAcceptedProviderProfile?: (() => Promise<AcceptedProviderProfile>) | undefined;
  readonly hooks?: PiBoundaryHooks | undefined;
  readonly waitForStreamGate?:
    | ((gateId: string, signal: AbortSignal | undefined) => Promise<void>)
    | undefined;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const parseJsonRecord = (value: string): Record<string, unknown> => {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
};

const userRecord = (request: ProviderRequest): Record<string, unknown> => {
  const message = [...request.messages].reverse().find((candidate) => candidate.role === "user");
  return message === undefined ? {} : parseJsonRecord(message.content);
};

const toolResults = (
  request: ProviderRequest,
  name: string,
): ReadonlyArray<{
  readonly message: Extract<ProviderMessage, { role: "tool" }>;
  readonly value: Record<string, unknown>;
}> =>
  request.messages.flatMap((message) =>
    message.role === "tool" && message.name === name
      ? [{ message, value: parseJsonRecord(message.content) }]
      : [],
  );

const priorToolArguments = (
  request: ProviderRequest,
  name: string,
): readonly Record<string, unknown>[] =>
  request.messages.flatMap((message) =>
    message.role === "assistant"
      ? (message.toolCalls ?? []).filter((call) => call.name === name).map((call) => call.arguments)
      : [],
  );

const call = (
  coordinates: PiBoundaryCoordinates,
  name: string,
  arguments_: Record<string, unknown>,
  index = 0,
): ProviderToolCall => ({
  id: `e2e-${coordinates.taskId}-${coordinates.attempt}-${coordinates.providerRequestIndex}-${index}`,
  name,
  arguments: arguments_,
});

const keysFrom = (text: string): readonly string[] => [
  ...new Set(text.match(/k_[A-Za-z0-9_-]+_[1-9][0-9]*/gu) ?? []),
];

const outputFor = (
  request: ProviderRequest,
  coordinates: PiBoundaryCoordinates,
): { readonly text: string; readonly toolCalls: readonly ProviderToolCall[] } => {
  const user = userRecord(request);
  const rawUser = request.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  switch (coordinates.agentRole) {
    case "evaluation_general_planner": {
      const currentMessage = String(user.currentMessage ?? "");
      if (currentMessage !== "Compare it with the previous result.") {
        throw new AiRuntimeError(
          "invalid_workflow_output",
          "deterministic general planner supports only the focused clarification fixture",
        );
      }
      return {
        text: "",
        toolCalls: [
          call(coordinates, "emit_general_planner_result", {
            resolution: {
              mode: "clarify",
              question: "Should I compare the wind result or the solar result?",
            },
            selectedSources: [],
            answerContent: "Should I compare the wind result or the solar result?",
            citationSourceIds: [],
            memoryProposals: [],
          }),
        ],
      };
    }
    case "conversation_resolver": {
      const currentMessage = String(user.currentMessage ?? "");
      const entries = Array.isArray(user.entries) ? user.entries : [];
      const completeEntries = entries
        .map(asRecord)
        .filter((entry) => typeof entry.assistantContent === "string");
      const normalizedCurrentMessage = currentMessage.toLocaleLowerCase("en-US");
      const explicitlyNamedCandidateCount = completeEntries.filter((entry) =>
        String(entry.userContent ?? "")
          .toLocaleLowerCase("en-US")
          .split(/[^a-z0-9]+/u)
          .filter((token) => token.length >= 4 && !["what", "result"].includes(token))
          .some((token) => normalizedCurrentMessage.includes(token)),
      ).length;
      const ambiguousComparative =
        /\b(?:compare|contrast)\b/iu.test(currentMessage) &&
        /\b(?:it|that|this|previous|prior|earlier|former|latter|one|result)\b/iu.test(
          currentMessage,
        ) &&
        completeEntries.length >= 2 &&
        explicitlyNamedCandidateCount < 2;
      const competingCandidates = completeEntries.slice(-2).map((entry) => {
        const candidate = String(entry.userContent ?? "prior result")
          .replace(/[?!.]+$/u, "")
          .trim();
        return candidate === "" ? "prior result" : candidate;
      });
      const result =
        currentMessage.includes("[clarify]") || ambiguousComparative
          ? {
              mode: "clarify",
              question: ambiguousComparative
                ? `Which prior results should I compare: ${competingCandidates.join(" or ")}?`
                : "Which market and time horizon should Brief use?",
            }
          : {
              mode: "continue",
              retrievalQuestion: currentMessage,
              selectedTurnIds: entries
                .map((entry) => asRecord(entry).turnId)
                .filter((turnId): turnId is string => typeof turnId === "string"),
            };
      return { text: "", toolCalls: [call(coordinates, "emit_conversation_resolution", result)] };
    }
    case "execution_planner": {
      const question = String(user.resolvedQuestion ?? "");
      const selectedEntries = Array.isArray(user.selectedEntries) ? user.selectedEntries : [];
      const selectedTurnIds = selectedEntries
        .map((entry) => asRecord(entry).turnId)
        .filter((turnId): turnId is string => typeof turnId === "string");
      const result = question.includes("[fanout]")
        ? {
            mode: "fanout",
            reason: "two independent deterministic research topics",
            topics: [
              { question: "What do the solar sources report?", relevantTurnIds: selectedTurnIds },
              { question: "What should grid operators monitor?", relevantTurnIds: selectedTurnIds },
            ],
          }
        : { mode: "single", reason: "one atomic deterministic question" };
      return { text: "", toolCalls: [call(coordinates, "emit_execution_plan", result)] };
    }
    case "memory_extractor": {
      const message = String(user.currentUserMessage ?? "");
      const active = Array.isArray(user.activeMemories) ? user.activeMemories : [];
      const create = /Remember preference:\s*(.+)/iu.exec(message)?.[1]?.trim();
      const update = /Update preference:\s*(.+)/iu.exec(message)?.[1]?.trim();
      const target = asRecord(active[0]).memoryId;
      const proposals =
        create !== undefined
          ? [{ kind: "preference", content: create }]
          : update !== undefined && typeof target === "string"
            ? [{ kind: "preference", content: update, targetMemoryId: target }]
            : [];
      return { text: "", toolCalls: [call(coordinates, "emit_memory_proposals", { proposals })] };
    }
    case "memory_selector": {
      const question = String(user.currentUserMessage ?? user.question ?? "");
      const memories = Array.isArray(user.activeMemories)
        ? user.activeMemories
        : Array.isArray(user.memories)
          ? user.memories
          : [];
      const first = asRecord(memories[0]);
      const entries =
        question.includes("[use-memory]") &&
        typeof first.memoryId === "string" &&
        typeof first.memoryRevisionId === "string"
          ? [{ memoryId: first.memoryId, memoryRevisionId: first.memoryRevisionId }]
          : [];
      return { text: "", toolCalls: [call(coordinates, "emit_memory_manifest", { entries })] };
    }
    case "internal_retrieval": {
      const searches = toolResults(request, "search_internal");
      if (searches.length === 0) {
        return {
          text: "",
          toolCalls: [
            call(coordinates, "search_internal", {
              query: {
                target: "documents",
                // Keep the deterministic boundary compatible with both the
                // French E2E corpus and the canonical evaluation fixture,
                // whose fr-FR evidence text intentionally uses English.
                terms: "solaire OR solar",
                purpose: "ground the deterministic E2E answer",
                countries: ["FR"],
                languages: ["fr-FR"],
                limit: 4,
              },
            }),
          ],
        };
      }
      const inspections = toolResults(request, "inspect_internal");
      if (inspections.length === 0) {
        const items = Array.isArray(searches.at(-1)?.value.items)
          ? (searches.at(-1)?.value.items as unknown[])
          : [];
        const calls = items.slice(0, 2).flatMap((value, index) => {
          const item = asRecord(value);
          if (typeof item.documentId !== "string" || typeof item.documentVersionId !== "string") {
            return [];
          }
          const source =
            item.kind === "publisher" &&
            typeof item.sourceId === "string" &&
            typeof item.issueId === "string"
              ? {
                  kind: "publisher" as const,
                  sourceId: item.sourceId,
                  issueId: item.issueId,
                  documentId: item.documentId,
                }
              : typeof item.sourceId === "string"
                ? { kind: "public" as const, sourceId: item.sourceId }
                : undefined;
          if (source === undefined) return [];
          const textCharCount = typeof item.textCharCount === "number" ? item.textCharCount : 500;
          return [
            call(
              coordinates,
              "inspect_internal",
              {
                reference: {
                  kind: "document",
                  documentId: item.documentId,
                  documentVersionId: item.documentVersionId,
                  source,
                  ranges: [{ charStart: 0, charEnd: Math.min(800, textCharCount) }],
                  purpose: "ground the deterministic E2E answer",
                },
              },
              index,
            ),
          ];
        });
        if (calls.length > 0) return { text: "", toolCalls: calls };
      }
      const entries = priorToolArguments(request, "inspect_internal").flatMap((arguments_) => {
        const reference = asRecord(arguments_.reference);
        return reference.kind === "document" ? [reference] : [];
      });
      return { text: "", toolCalls: [call(coordinates, "emit_internal_manifest", { entries })] };
    }
    case "web_research": {
      const searches = toolResults(request, "web_search");
      if (searches.length === 0) {
        return {
          text: "",
          toolCalls: [call(coordinates, "web_search", { query: "France solar grid outlook" })],
        };
      }
      const fetches = toolResults(request, "web_fetch");
      if (fetches.length === 0) {
        const results = Array.isArray(searches.at(-1)?.value.results)
          ? (searches.at(-1)?.value.results as unknown[])
          : [];
        const url = asRecord(results[0]).url;
        return typeof url === "string"
          ? { text: "", toolCalls: [call(coordinates, "web_fetch", { url })] }
          : { text: "", toolCalls: [call(coordinates, "emit_web_evidence", { entries: [] })] };
      }
      const page = fetches.at(-1)?.value ?? {};
      const text = String(page.text ?? "");
      const entry = {
        url: String(page.url ?? ""),
        title: String(page.title ?? "Deterministic web result"),
        domain: String(page.domain ?? "e2e.example"),
        quote: text.slice(0, Math.min(text.length, 120)).trim(),
        capturedAt: String(page.capturedAt ?? new Date(0).toISOString()),
        purpose: "exercise the required web evidence path",
      };
      return {
        text: "",
        toolCalls: [
          call(coordinates, "emit_web_evidence", { entries: entry.quote === "" ? [] : [entry] }),
        ],
      };
    }
    case "context_reducer": {
      const candidates = Array.isArray(user.candidates) ? user.candidates : [];
      return {
        text: "",
        toolCalls: [
          call(coordinates, "emit_context_plan", {
            decisions: candidates.map((candidate) => ({
              id: String(asRecord(candidate).id ?? ""),
              action: "keep",
              reason: "retain deterministic evidence",
            })),
          }),
        ],
      };
    }
    case "topic_answer": {
      const topicId = /topic-(t[123])-answer/u.exec(coordinates.taskId)?.[1] ?? "t1";
      const sourceKeys = keysFrom(rawUser);
      const packet =
        sourceKeys.length === 0
          ? { topicId, status: "partial", claims: [], gaps: ["No selected evidence"] }
          : {
              topicId,
              status: "answered",
              claims: [
                {
                  text: `Deterministic grounded claim for ${topicId}.`,
                  sourceKeys: [sourceKeys[0]],
                },
              ],
              gaps: [],
            };
      return { text: "", toolCalls: [call(coordinates, "emit_topic_packet", packet)] };
    }
    default:
      throw new AiRuntimeError(
        "invalid_workflow_output",
        `unsupported deterministic role ${coordinates.agentRole}`,
      );
  }
};

export class DeterministicE2eProviderBoundary implements PiRuntimeBoundary {
  private acceptedProviderProfile: AcceptedProviderProfile | undefined;

  constructor(private readonly options: DeterministicBoundaryOptions) {}

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

  private assertAcceptedProviderProfile(request: LiveProviderRequest): void | Promise<void> {
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

  private async measured(
    request: LiveProviderRequest,
    coordinates: PiBoundaryCoordinates,
    signal: AbortSignal | undefined,
    beforeProviderRequest: BeforeProviderRequest | undefined,
  ): Promise<{
    readonly measurement: ReturnType<typeof measureProviderRequest>;
    readonly request: LiveProviderRequest;
  }> {
    throwIfAborted(signal);
    const normalizedRequest = requireLiveProviderRequest(normalizeProviderRequest(request));
    const model = resolveRuntimeModel(normalizedRequest.model);
    const limits =
      normalizedRequest.requestClass === "main" ? this.options.mainLimits : this.options.fastLimits;
    const measurement = measureProviderRequest(normalizedRequest, model, limits);
    throwIfAborted(signal);
    await this.options.hooks?.onMeasurement?.(
      coordinates,
      measurement,
      normalizedRequest,
      providerRequestSourceExposureProofs(normalizedRequest, (text) => model.countTextTokens(text)),
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
    return { measurement, request: normalizedRequest };
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
    const profileCheck = this.assertAcceptedProviderProfile(request);
    if (profileCheck !== undefined) await profileCheck;
    const gated = await this.measured(request, executionCoordinates, signal, beforeProviderRequest);
    const { measurement, request: providerRequest } = gated;
    throwIfAborted(signal);
    const output = outputFor(providerRequest, executionCoordinates);
    const outputTokens = Math.max(
      1,
      resolveRuntimeModel(providerRequest.model).countTextTokens(JSON.stringify(output)),
    );
    const usage = {
      inputTokens: measurement.inputTokens,
      outputTokens,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalTokens: measurement.inputTokens + outputTokens,
      stopReason: output.toolCalls.length > 0 ? "toolUse" : "stop",
    };
    throwIfAborted(signal);
    await this.options.hooks?.onUsage?.(executionCoordinates, providerRequest.model, usage);
    throwIfAborted(signal);
    return { ...output, usage, stopReason: usage.stopReason };
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
    const profileCheck = this.assertAcceptedProviderProfile(request);
    if (profileCheck !== undefined) await profileCheck;
    const gated = await this.measured(request, executionCoordinates, signal, beforeProviderRequest);
    const { measurement, request: providerRequest } = gated;
    throwIfAborted(signal);
    // Failure injection belongs only to the current message. A failed prior turn
    // may be selected as conversation context for an edited resubmission and must
    // not poison that new run.
    const originalMessage = String(userRecord(providerRequest).originalMessage ?? "");
    if (originalMessage.includes("[fail]")) {
      throw new AiRuntimeError(
        executionCoordinates.agentRole === "synthesis" ? "synthesis_failed" : "answer_failed",
        "deterministic E2E provider failure",
      );
    }
    const sourceKeys = keysFrom(
      providerRequest.messages.map((message) => message.content).join("\n"),
    );
    const citeEverySource = originalMessage.includes("[cite-all]");
    const streamGateId = e2eStreamGateIdFromMessage(originalMessage);
    const directCitationKeys = citeEverySource ? sourceKeys : sourceKeys.slice(0, 1);
    const text =
      executionCoordinates.agentRole === "synthesis"
        ? `Deterministic fanout synthesis grounded in both topic packets.${sourceKeys.length === 0 ? "" : ` [[cite:${sourceKeys.join(",")}]]`}`
        : `Deterministic direct answer grounded in the selected Brief evidence.${directCitationKeys.length === 0 ? "" : ` [[cite:${directCitationKeys.join(",")}]]`}`;
    const chunks = text.match(/.{1,12}/gu) ?? [text];
    for (const [index, chunk] of chunks.entries()) {
      throwIfAborted(signal);
      await onDelta(chunk, index);
      throwIfAborted(signal);
      if (index === 0 && streamGateId !== null) {
        if (this.options.waitForStreamGate === undefined) {
          throw new AiRuntimeError(
            "invalid_workflow_output",
            "deterministic E2E stream gate is not configured",
          );
        }
        await this.options.waitForStreamGate(streamGateId, signal);
        throwIfAborted(signal);
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      throwIfAborted(signal);
    }
    const outputTokens = resolveRuntimeModel(providerRequest.model).countTextTokens(text);
    const usage = {
      inputTokens: measurement.inputTokens,
      outputTokens,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalTokens: measurement.inputTokens + outputTokens,
      stopReason: "stop",
    };
    throwIfAborted(signal);
    await this.options.hooks?.onUsage?.(executionCoordinates, providerRequest.model, usage);
    throwIfAborted(signal);
    return { text, toolCalls: [], usage, stopReason: "stop" };
  }
}
