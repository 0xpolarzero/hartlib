import { aiRunErrorCodeForRole, AiRuntimeError } from "../runtime/errors";
import {
  measureProviderRequest,
  resolveRuntimeModel,
  type AcceptedProviderProfile,
  type ProviderGateLimits,
} from "../runtime/model-registry";
import type { AiProviderEndpointIdentity, AiProviderServiceId } from "@brief/shared";
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
  providerRequestSourceExposureProofBindings,
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
  readonly providerEndpointIdentity?: AiProviderEndpointIdentity | undefined;
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

const textValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  for (const key of ["content", "text", "message"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return "";
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

const resultIsIncomplete = (value: Readonly<Record<string, unknown>>): boolean =>
  value.complete !== true || value.truncated === true || typeof value.cursor === "number";

const sameRecord = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const referenceIdentity = (value: unknown): string | undefined => {
  const reference = asRecord(value);
  if (reference.kind === "document" && typeof reference.documentId === "string") {
    return `document:${reference.documentId}`;
  }
  if (reference.kind === "chat_message" && typeof reference.messageId === "string") {
    return `chat_message:${reference.messageId}`;
  }
  return undefined;
};

const rangesFrom = (
  value: unknown,
): readonly { readonly charStart: number; readonly charEnd: number }[] => {
  const record = asRecord(value);
  const ranges = Array.isArray(record.ranges)
    ? record.ranges
    : record.range === undefined
      ? []
      : [record.range];
  return ranges.flatMap((range) => {
    const parsed = asRecord(range);
    return typeof parsed.charStart === "number" && typeof parsed.charEnd === "number"
      ? [{ charStart: parsed.charStart, charEnd: parsed.charEnd }]
      : [];
  });
};

const isStrictlyNarrower = (
  previous: readonly { readonly charStart: number; readonly charEnd: number }[],
  next: readonly { readonly charStart: number; readonly charEnd: number }[],
): boolean => {
  if (previous.length === 0 || next.length === 0) return false;
  const previousLength = previous.reduce((sum, range) => sum + range.charEnd - range.charStart, 0);
  const nextLength = next.reduce((sum, range) => sum + range.charEnd - range.charStart, 0);
  return (
    nextLength < previousLength &&
    next.every((nextRange) =>
      previous.some(
        (previousRange) =>
          nextRange.charStart >= previousRange.charStart &&
          nextRange.charEnd <= previousRange.charEnd,
      ),
    )
  );
};

const priorToolArguments = (
  request: ProviderRequest,
  name: string,
): readonly Record<string, unknown>[] =>
  request.messages.flatMap((message) =>
    message.role === "assistant"
      ? (message.toolCalls ?? []).filter((call) => call.name === name).map((call) => call.arguments)
      : [],
  );

const toolHistory = (
  request: ProviderRequest,
  name: string,
): readonly {
  readonly arguments: Record<string, unknown>;
  readonly value: Record<string, unknown>;
}[] => {
  const calls = new Map<string, Record<string, unknown>>();
  for (const message of request.messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (call.name === name) calls.set(call.id, call.arguments);
    }
  }
  return request.messages.flatMap((message) => {
    if (message.role !== "tool" || message.name !== name) return [];
    const arguments_ = calls.get(message.toolCallId);
    return arguments_ === undefined
      ? []
      : [{ arguments: arguments_, value: parseJsonRecord(message.content) }];
  });
};

const memorySearchLedger = (
  searches: ReadonlyArray<{
    readonly value: Record<string, unknown>;
  }>,
): readonly Record<string, unknown>[] => {
  const seenMemoryIds = new Set<string>();
  const ledger: Record<string, unknown>[] = [];
  for (const { value } of searches) {
    if (!Array.isArray(value.items)) continue;
    for (const item of value.items) {
      const record = asRecord(item);
      const memoryId = record.memoryId;
      if (typeof memoryId !== "string" || seenMemoryIds.has(memoryId)) continue;
      seenMemoryIds.add(memoryId);
      ledger.push(record);
    }
  }
  return ledger;
};

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

const synthesisCitation = (sourceKeys: readonly string[]): string =>
  sourceKeys.length === 0 ? "" : ` [[cite:${sourceKeys.join(",")}]]`;

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
      const currentMessage = String(
        user.requestText ?? user.currentMessageText ?? user.currentMessage ?? "",
      );
      const entries = Array.isArray(user.entries)
        ? user.entries
        : Array.isArray(user.conversation)
          ? user.conversation
          : [];
      const relevantTurnIds = entries
        .map(asRecord)
        .map((entry) => entry.turnId)
        .filter((turnId): turnId is string => typeof turnId === "string");
      const planTurn =
        currentMessage === "Compare it with the previous result."
          ? {
              mode: "clarify" as const,
              question: "Should I compare the wind result or the solar result?",
            }
          : currentMessage.includes("[fanout]") ||
              (currentMessage.includes("solar connections") &&
                currentMessage.includes("storage operations"))
            ? {
                mode: "fanout" as const,
                question: currentMessage,
                topics: [
                  {
                    topicId: "t1" as const,
                    question: "What does the first deterministic topic cover?",
                    relevantTurnIds: [],
                  },
                  {
                    topicId: "t2" as const,
                    question: "What does the second deterministic topic cover?",
                    relevantTurnIds: [],
                  },
                  ...(currentMessage.includes("solar connections") &&
                  currentMessage.includes("storage operations")
                    ? [
                        {
                          topicId: "t3" as const,
                          question: "What does the third deterministic topic cover?",
                          relevantTurnIds: [],
                        },
                      ]
                    : []),
                ],
              }
            : {
                mode: "single" as const,
                question: currentMessage,
                relevantTurnIds,
              };
      return {
        text: "",
        toolCalls: [
          call(coordinates, "emit_general_planner_result", {
            planTurn,
            selectedSources: [],
            answerContent:
              planTurn.mode === "clarify"
                ? planTurn.question
                : "Deterministic general-planner answer.",
            citationSourceIds: [],
            memoryProposals: [],
          }),
        ],
      };
    }
    case "plan_turn": {
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
          : currentMessage.includes("[fanout]")
            ? {
                mode: "fanout",
                question: currentMessage,
                topics: [
                  {
                    question: "What does the first deterministic topic cover?",
                    relevantTurnIds: [],
                  },
                  {
                    question: "What does the second deterministic topic cover?",
                    relevantTurnIds: [],
                  },
                ],
              }
            : {
                mode: "single",
                question: currentMessage,
                relevantTurnIds: entries
                  .map((entry) => asRecord(entry).turnId)
                  .filter((turnId): turnId is string => typeof turnId === "string"),
              };
      return { text: "", toolCalls: [call(coordinates, "emit_plan_turn", result)] };
    }
    case "memory_extractor": {
      const message = textValue(user.currentUserMessage);
      const messageSource = [
        message,
        rawUser,
        ...request.messages.map((candidate) => candidate.content),
      ].join("\n");
      const create = /Remember preference:\s*(.+)/iu.exec(messageSource)?.[1]?.trim();
      const update =
        /Update preference:\s*(.+)/iu.exec(messageSource)?.[1]?.trim() ??
        (/\bMWh\b/iu.test(messageSource)
          ? "Prefer concise answers in French and report energy quantities in MWh."
          : undefined);
      const searches = toolResults(request, "search_memories");
      const inspections = toolResults(request, "inspect_memory");
      if (create !== undefined) {
        return {
          text: "",
          toolCalls: [
            call(coordinates, "emit_memory_proposals", {
              proposals: [{ kind: "preference", content: create }],
            }),
          ],
        };
      }
      if (update === undefined) {
        return {
          text: "",
          toolCalls: [call(coordinates, "emit_memory_proposals", { proposals: [] })],
        };
      }
      if (searches.length === 0) {
        return {
          text: "",
          toolCalls: [
            call(coordinates, "search_memories", {
              query: /\bsolar\b/iu.test(messageSource) ? "solar" : "prefer",
            }),
          ],
        };
      }
      const searchHistory = toolHistory(request, "search_memories");
      const pendingSearch = searchHistory.find(({ arguments: arguments_, value }, index) => {
        if (!resultIsIncomplete(value)) return false;
        const cursor = value.cursor;
        return !searchHistory.slice(index + 1).some((later) => {
          return (
            sameRecord(later.arguments.query, arguments_.query) &&
            (typeof cursor !== "number" || later.arguments.cursor === cursor)
          );
        });
      });
      if (pendingSearch !== undefined) {
        const cursor = pendingSearch.value.cursor;
        if (typeof cursor === "number") {
          return {
            text: "",
            toolCalls: [
              call(coordinates, "search_memories", {
                query: pendingSearch.arguments.query ?? "prefer",
                cursor,
              }),
            ],
          };
        }
        throw new AiRuntimeError(
          "invalid_workflow_output",
          "deterministic memory extraction cannot continue an incomplete search without a cursor",
        );
      }
      const ledger = memorySearchLedger(searches);
      if (inspections.length === 0) {
        const memoryId = ledger[0]?.memoryId;
        return typeof memoryId === "string"
          ? { text: "", toolCalls: [call(coordinates, "inspect_memory", { memoryId })] }
          : {
              text: "",
              toolCalls: [call(coordinates, "emit_memory_proposals", { proposals: [] })],
            };
      }
      const targetMemoryId = ledger[0]?.memoryId;
      const inspected =
        inspections.find(
          ({ value }) =>
            targetMemoryId === undefined || asRecord(value.memory).memoryId === targetMemoryId,
        ) ?? inspections[0];
      const memory = asRecord(inspected?.value.memory);
      const inspectedMemoryId = memory.memoryId;
      return {
        text: "",
        toolCalls: [
          call(coordinates, "emit_memory_proposals", {
            proposals:
              typeof inspectedMemoryId === "string"
                ? [{ kind: "preference", content: update, targetMemoryId: inspectedMemoryId }]
                : [],
          }),
        ],
      };
    }
    case "memory_selector": {
      const question = textValue(user.currentUserMessage ?? user.question);
      const searches = toolResults(request, "search_memories");
      const inspections = toolResults(request, "inspect_memory");
      if (
        !question.includes("[use-memory]") &&
        !/\b(?:preference|préférence|MWh)\b/iu.test(question)
      ) {
        return {
          text: "",
          toolCalls: [call(coordinates, "emit_memory_manifest", { entries: [] })],
        };
      }
      if (searches.length === 0) {
        return {
          text: "",
          toolCalls: [
            call(coordinates, "search_memories", {
              query: question.includes("[use-memory]")
                ? "concise"
                : /\bsolar\b/iu.test(question)
                  ? "solar"
                  : "prefer",
            }),
          ],
        };
      }
      const searchHistory = toolHistory(request, "search_memories");
      const pendingSearch = searchHistory.find(({ arguments: arguments_, value }, index) => {
        if (!resultIsIncomplete(value)) return false;
        const cursor = value.cursor;
        return !searchHistory.slice(index + 1).some((later) => {
          return (
            sameRecord(later.arguments.query, arguments_.query) &&
            (typeof cursor !== "number" || later.arguments.cursor === cursor)
          );
        });
      });
      if (pendingSearch !== undefined) {
        const cursor = pendingSearch.value.cursor;
        if (typeof cursor === "number") {
          return {
            text: "",
            toolCalls: [
              call(coordinates, "search_memories", {
                query: pendingSearch.arguments.query ?? "prefer",
                cursor,
              }),
            ],
          };
        }
        throw new AiRuntimeError(
          "invalid_workflow_output",
          "deterministic memory selection cannot continue an incomplete search without a cursor",
        );
      }
      const ledger = memorySearchLedger(searches);
      if (inspections.length === 0) {
        const memoryId = ledger[0]?.memoryId;
        return typeof memoryId === "string"
          ? { text: "", toolCalls: [call(coordinates, "inspect_memory", { memoryId })] }
          : { text: "", toolCalls: [call(coordinates, "emit_memory_manifest", { entries: [] })] };
      }
      const targetMemoryId = ledger[0]?.memoryId;
      const inspected =
        inspections.find(
          ({ value }) =>
            targetMemoryId === undefined || asRecord(value.memory).memoryId === targetMemoryId,
        ) ?? inspections[0];
      const memory = asRecord(inspected?.value.memory);
      return {
        text: "",
        toolCalls: [
          call(coordinates, "emit_memory_manifest", {
            entries:
              typeof memory.memoryId === "string" && typeof memory.memoryRevisionId === "string"
                ? [{ memoryId: memory.memoryId, memoryRevisionId: memory.memoryRevisionId }]
                : [],
          }),
        ],
      };
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
      const searchHistory = toolHistory(request, "search_internal");
      const pendingSearch = searchHistory.find(({ arguments: arguments_, value }, index) => {
        if (!resultIsIncomplete(value)) return false;
        const cursor = value.cursor;
        return !searchHistory
          .slice(index + 1)
          .some(
            (later) =>
              sameRecord(later.arguments.query, arguments_.query) &&
              (typeof cursor !== "number" || later.arguments.cursor === cursor),
          );
      });
      if (pendingSearch !== undefined) {
        const cursor = pendingSearch.value.cursor;
        if (typeof cursor === "number") {
          return {
            text: "",
            toolCalls: [
              call(coordinates, "search_internal", {
                query: pendingSearch.arguments.query,
                cursor,
              }),
            ],
          };
        }
        throw new AiRuntimeError(
          "invalid_workflow_output",
          "deterministic internal retrieval cannot emit a manifest while search is incomplete",
        );
      }
      const inspections = toolResults(request, "inspect_internal");
      const inspectionHistory = toolHistory(request, "inspect_internal");
      const pendingInspection = inspectionHistory.find(
        ({ arguments: arguments_, value }, index) => {
          if (!resultIsIncomplete(value)) return false;
          const identity = referenceIdentity(arguments_.reference);
          if (identity === undefined) return false;
          const resultRanges = rangesFrom(value);
          const referenceRanges = rangesFrom(arguments_.reference);
          const previousRanges =
            resultRanges.length > 0
              ? resultRanges
              : referenceRanges.length > 0
                ? referenceRanges
                : [{ charStart: 0, charEnd: 8_192 }];
          const cursor = value.cursor;
          return !inspectionHistory.slice(index + 1).some((later) => {
            if (referenceIdentity(later.arguments.reference) !== identity) return false;
            if (typeof cursor === "number") return later.arguments.cursor === cursor;
            if (value.narrowerRangeRequired !== true) return false;
            return isStrictlyNarrower(previousRanges, rangesFrom(later.arguments.reference));
          });
        },
      );
      if (pendingInspection !== undefined) {
        const cursor = pendingInspection.value.cursor;
        if (typeof cursor === "number") {
          return {
            text: "",
            toolCalls: [
              call(coordinates, "inspect_internal", {
                ...pendingInspection.arguments,
                cursor,
              }),
            ],
          };
        }
        if (pendingInspection.value.narrowerRangeRequired === true) {
          const previousReference = asRecord(pendingInspection.arguments.reference);
          const previousRanges = rangesFrom(pendingInspection.value);
          const referenceRanges = rangesFrom(previousReference);
          const previousRange = (previousRanges.length > 0 ? previousRanges : referenceRanges)[0];
          const charStart = previousRange?.charStart ?? 0;
          const charEnd = previousRange?.charEnd ?? 2_048;
          const narrowerEnd = Math.max(
            charStart + 1,
            charStart + Math.floor((charEnd - charStart) / 2),
          );
          if (
            previousReference.kind === "document" &&
            typeof previousReference.documentId === "string"
          ) {
            return {
              text: "",
              toolCalls: [
                call(coordinates, "inspect_internal", {
                  reference: {
                    kind: "document",
                    documentId: previousReference.documentId,
                    range: { charStart, charEnd: narrowerEnd },
                    purpose: "ground the deterministic E2E answer",
                  },
                }),
              ],
            };
          }
        }
        throw new AiRuntimeError(
          "invalid_workflow_output",
          "deterministic internal retrieval cannot emit a manifest while inspection is incomplete",
        );
      }
      if (inspections.length === 0) {
        const items = searches.flatMap(({ value }) =>
          Array.isArray(value.items) ? (value.items as unknown[]) : [],
        );
        const calls = items.slice(0, 2).flatMap((value, index) => {
          const item = asRecord(value);
          if (typeof item.documentId === "string") {
            return [
              call(
                coordinates,
                "inspect_internal",
                {
                  reference: {
                    kind: "document",
                    documentId: item.documentId,
                    purpose: "ground the deterministic E2E answer",
                  },
                },
                index,
              ),
            ];
          }
          if (typeof item.messageId === "string") {
            return [
              call(
                coordinates,
                "inspect_internal",
                {
                  reference: {
                    kind: "chat_message",
                    messageId: item.messageId,
                    purpose: "ground the deterministic E2E answer",
                  },
                },
                index,
              ),
            ];
          }
          return [];
        });
        if (calls.length > 0) return { text: "", toolCalls: calls };
      }
      const completed = new Map<string, Record<string, unknown>>();
      for (const { arguments: arguments_, value } of inspectionHistory) {
        if (value.complete !== true || value.found !== true) continue;
        const reference = asRecord(arguments_.reference);
        const key = referenceIdentity(reference);
        if (key === undefined) continue;
        const purpose =
          typeof reference.purpose === "string"
            ? reference.purpose
            : "ground the deterministic E2E answer";
        if (key.startsWith("document:")) {
          const resultRanges = rangesFrom(value);
          const referenceRanges = rangesFrom(reference);
          // A whole-document inspection is complete at the logical document
          // level; its result range describes the returned body but is not an
          // explicit bounded selection. Preserve ranges only when the
          // successful request asked for a bounded window.
          const ranges =
            referenceRanges.length > 0
              ? resultRanges.length > 0
                ? resultRanges
                : referenceRanges
              : [];
          completed.set(key, {
            kind: "document",
            documentId: reference.documentId as string,
            ...(ranges.length > 0 ? { ranges } : {}),
            purpose,
          });
        } else {
          completed.set(key, {
            kind: "chat_message",
            messageId: reference.messageId as string,
            purpose,
          });
        }
      }
      const entries = [...completed.values()];
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
                  sourceKeys,
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
        current.providerEndpointIdentity !== profile.providerEndpointIdentity ||
        current.fastModelId !== profile.fastModelId ||
        current.mainModelId !== profile.mainModelId)
    ) {
      throw new AiRuntimeError(
        "invalid_workflow_output",
        "accepted provider profile cannot be rebound",
        { taskRetryable: false },
      );
    }
    this.acceptedProviderProfile = profile;
  }

  private assertAcceptedProviderProfile(
    request: LiveProviderRequest,
    agentRole: string,
  ): void | Promise<void> {
    if (this.acceptedProviderProfile === undefined && this.options.loadAcceptedProviderProfile) {
      return this.options.loadAcceptedProviderProfile().then((profile) => {
        this.bindAcceptedProviderProfile(profile);
        this.assertAcceptedProviderProfile(request, agentRole);
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
    if (
      profile.providerServiceId !== "deterministic_test" ||
      profile.providerEndpointIdentity === undefined ||
      !profile.providerEndpointIdentity.startsWith("deterministic_test:")
    ) {
      throw new AiRuntimeError(
        aiRunErrorCodeForRole(agentRole),
        "accepted provider adapter is unavailable",
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
    const normalized = normalizeProviderRequest(request);
    if (normalized.model !== "glm-5-turbo") {
      throw new AiRuntimeError(
        "invalid_workflow_output",
        `deterministic E2E provider requires glm-5-turbo; received ${normalized.model}`,
      );
    }
    const normalizedRequest = requireLiveProviderRequest(normalized);
    const model = resolveRuntimeModel(normalizedRequest.model);
    const limits =
      normalizedRequest.requestClass === "main" ? this.options.mainLimits : this.options.fastLimits;
    const measurement = measureProviderRequest(normalizedRequest, model, limits);
    throwIfAborted(signal);
    const proofRequest =
      normalizedRequest.sourceExposureProofs === undefined ||
      normalizedRequest.sourceExposureProofs.length === 0
        ? (() => {
            const { sourceExposureProofs: _sourceExposureProofs, ...requestWithoutProofs } =
              normalizedRequest;
            return requestWithoutProofs;
          })()
        : normalizedRequest;
    const measuredSourceExposureProofSha256Hexes = providerRequestSourceExposureProofs(
      proofRequest,
      (text) => model.countTextTokens(text),
    );
    const measuredSourceExposureProofBindings = providerRequestSourceExposureProofBindings(
      proofRequest,
      (text) => model.countTextTokens(text),
    );
    const sourceExposureProofBindings = measuredSourceExposureProofBindings.filter(
      (candidate, index, bindings) =>
        bindings.findIndex(
          (other) => JSON.stringify(other.marker) === JSON.stringify(candidate.marker),
        ) === index,
    );
    const sourceExposureProofSha256Hexes = sourceExposureProofBindings
      .map(({ providerSerializationProofSha256Hex }) => providerSerializationProofSha256Hex)
      .sort();
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
    const profileCheck = this.assertAcceptedProviderProfile(
      request,
      executionCoordinates.agentRole,
    );
    if (profileCheck !== undefined) await profileCheck;
    const gated = await this.measured(request, executionCoordinates, signal, beforeProviderRequest);
    const { measurement, request: providerRequest } = gated;
    throwIfAborted(signal);
    const user = userRecord(providerRequest);
    const failureMessage = String(
      user.originalMessage ??
        user.requestText ??
        user.currentMessageText ??
        user.currentMessage ??
        "",
    );
    if (failureMessage.includes("[fail]")) {
      throw new AiRuntimeError(
        executionCoordinates.agentRole === "synthesis" ? "synthesis_failed" : "answer_failed",
        "deterministic E2E provider failure",
      );
    }
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
    const profileCheck = this.assertAcceptedProviderProfile(
      request,
      executionCoordinates.agentRole,
    );
    if (profileCheck !== undefined) await profileCheck;
    const gated = await this.measured(request, executionCoordinates, signal, beforeProviderRequest);
    const { measurement, request: providerRequest } = gated;
    throwIfAborted(signal);
    // Failure injection belongs only to the current message. A failed prior turn
    // may be selected as conversation context for an edited resubmission and must
    // not poison that new run.
    const streamUser = userRecord(providerRequest);
    const originalMessage = textValue(streamUser.originalMessage);
    const failureMessage = [
      streamUser.originalMessage,
      streamUser.requestText,
      streamUser.currentMessageText,
      streamUser.currentMessage,
      streamUser.currentUserMessage,
      streamUser.question,
    ]
      .map(textValue)
      .join("\n");
    if (failureMessage.includes("[fail]")) {
      throw new AiRuntimeError(
        executionCoordinates.agentRole === "synthesis" ? "synthesis_failed" : "answer_failed",
        "deterministic E2E provider failure",
      );
    }
    const sourceKeys = keysFrom(
      providerRequest.messages.map((message) => message.content).join("\n"),
    );
    const citeEverySource =
      executionCoordinates.agentRole === "topic_answer" || originalMessage.includes("[cite-all]");
    const streamGateId = e2eStreamGateIdFromMessage(originalMessage);
    const directCitationKeys = citeEverySource ? sourceKeys : sourceKeys.slice(0, 1);
    const text =
      executionCoordinates.agentRole === "synthesis"
        ? `Deterministic fanout synthesis grounded in both topic packets.${synthesisCitation(sourceKeys)}`
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
