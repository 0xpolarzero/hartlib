import { z } from "zod";

import type {
  BeforeProviderRequest,
  ExactPiBoundary,
  PiBoundaryCoordinates,
  PiCompletion,
} from "./pi-boundary";
import type { PiRuntimeBoundary } from "../e2e/deterministic-provider";
import type {
  LiveProviderRequest,
  ProviderMessage,
  ProviderRequest,
  ProviderToolDefinition,
} from "./provider-request";
import { aiRunErrorCodeForRole, toAiRuntimeError } from "./errors";
import { requireCurrentTaskCoordinates } from "./task-cancellation";

export interface StructuredCallInput<Output> {
  readonly requestClass: ProviderRequest["requestClass"];
  readonly model: LiveProviderRequest["model"];
  readonly system: string;
  readonly user: string;
  readonly outputToolName: string;
  readonly outputToolDescription: string;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly validate: (value: unknown) => Output;
  readonly requestedOutputTokens: number;
  readonly reasoning: ProviderRequest["reasoning"];
  readonly coordinates: PiBoundaryCoordinates;
  readonly onBeforeRequest?: BeforeProviderRequest | undefined;
}

export interface ToolLoopTool {
  readonly definition: ProviderToolDefinition;
  /**
   * Validate provider-authored arguments before any sibling tool call runs.
   * Production tools provide their strict Zod parser; the fallback still
   * rejects malformed non-object call arguments at the protocol boundary.
   */
  readonly parseArguments?: (value: unknown) => Readonly<Record<string, unknown>>;
  readonly execute: (
    arguments_: Readonly<Record<string, unknown>>,
    coordinates: PiBoundaryCoordinates,
  ) => Promise<Readonly<Record<string, unknown>>>;
}

export interface ToolLoopInput<Output> {
  readonly requestClass: ProviderRequest["requestClass"];
  readonly model: LiveProviderRequest["model"];
  readonly system: string;
  readonly user: string;
  readonly tools: readonly ToolLoopTool[];
  /**
   * Optionally hide code-owned tools after a successful phase transition. A
   * provider cannot search again after retrieval has completed, but it can
   * still inspect/fetch the already discovered evidence before terminalizing.
   */
  readonly disabledToolsForTurn?: ((providerRequestIndex: number) => readonly string[]) | undefined;
  /**
   * Supplies phase-specific, code-owned guidance when a provider replays a
   * tool that was removed from the advertised tool set.
   */
  readonly disabledToolResult?:
    | ((toolName: string) => Readonly<Record<string, unknown>>)
    | undefined;
  /**
   * Optionally return code-owned correction guidance for a rejected non-terminal
   * tool call so the provider can repair its arguments within the same bounded loop.
   */
  readonly recoverToolError?:
    | ((
        toolName: string,
        arguments_: Readonly<Record<string, unknown>>,
        error: unknown,
        coordinates: PiBoundaryCoordinates,
      ) => Readonly<Record<string, unknown>> | undefined)
    | undefined;
  /**
   * Optionally make a phase transition terminal-only before the final
   * configured turn once the owning operation has enough evidence.
   */
  readonly terminalOnlyForTurn?: ((providerRequestIndex: number) => boolean) | undefined;
  /**
   * Tool names that must occupy a complete provider turn by themselves.
   * This is used for reducer measurement: inspection/search and measurement
   * are separate protocol phases even when the provider emits parallel calls.
   */
  readonly exclusiveToolNames?: readonly string[] | undefined;
  /**
   * Enforce the terminal reservation for providers that may replay a stale
   * terminal call even after it has been removed from the advertised tools.
   */
  readonly enforceTerminalTurn?: boolean | undefined;
  readonly terminalToolName: string;
  readonly validateTerminal: (value: unknown) => Output;
  /**
   * Optionally turn a provider-authored terminal value that needs another
   * retrieval phase into a tool result for the next bounded provider turn.
   */
  readonly recoverTerminal?:
    | ((
        value: unknown,
        error: unknown,
        coordinates: PiBoundaryCoordinates,
      ) => Readonly<Record<string, unknown>> | undefined)
    | undefined;
  readonly maximumTurns: number;
  /**
   * When no incomplete-result continuation remains, expose only the terminal
   * tool on the last bounded provider turn. The provider still authors and
   * validates the terminal value; the runtime only enforces loop cadence.
   */
  readonly reserveFinalTurnForTerminal?: boolean | undefined;
  readonly requestedOutputTokens: number;
  readonly reasoning: ProviderRequest["reasoning"];
  readonly coordinates: Omit<PiBoundaryCoordinates, "loopIteration" | "providerRequestIndex">;
  readonly onBeforeRequest?: BeforeProviderRequest | undefined;
  readonly onTerminal?:
    | ((
        output: Output,
        coordinates: PiBoundaryCoordinates,
        completion: PiCompletion,
      ) => Promise<void> | void)
    | undefined;
}

const parseExactlyOneTerminal = <Output>(
  completion: PiCompletion,
  name: string,
  validate: (value: unknown) => Output,
): Output => {
  const calls = completion.toolCalls.filter((call) => call.name === name);
  if (calls.length !== 1 || completion.toolCalls.length !== 1) {
    throw new Error(`expected exactly one ${name} structured output tool call`);
  }
  return validate(calls[0]?.arguments);
};

const toolResultJson = (value: Readonly<Record<string, unknown>>): string => JSON.stringify(value);

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([key]) => key !== "cursor" && key !== "range" && key !== "ranges")
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
};

const exactStableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(exactStableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, exactStableValue(nested)]),
  );
};

const stableJson = (value: unknown): string => JSON.stringify(stableValue(value)) ?? "undefined";
const exactStableJson = (value: unknown): string =>
  JSON.stringify(exactStableValue(value)) ?? "undefined";

const isJsonRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseToolArguments = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isJsonRecord(value)) {
    throw new Error("tool call arguments must be a JSON object");
  }
  return value;
};

interface ParsedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

const parseToolCalls = (
  value: unknown,
  tools: ReadonlyMap<string, ToolLoopTool>,
): readonly ParsedToolCall[] => {
  if (!Array.isArray(value)) {
    throw new Error("assistant tool calls must be an array");
  }
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    if (!isJsonRecord(candidate)) {
      throw new Error(`tool call ${index} must be an object`);
    }
    if (
      Object.keys(candidate).some((key) => key !== "id" && key !== "name" && key !== "arguments") ||
      typeof candidate.id !== "string" ||
      candidate.id.length === 0 ||
      typeof candidate.name !== "string" ||
      candidate.name.length === 0 ||
      !Object.hasOwn(candidate, "arguments")
    ) {
      throw new Error(`tool call ${index} has an invalid shape`);
    }
    if (ids.has(candidate.id)) {
      throw new Error(`tool call ${index} reuses id ${candidate.id}`);
    }
    ids.add(candidate.id);
    const tool = tools.get(candidate.name);
    if (tool === undefined) {
      throw new Error(`unknown tool call ${candidate.name}`);
    }
    const parseArguments = tool.parseArguments ?? parseToolArguments;
    const arguments_ = parseArguments(candidate.arguments);
    if (!isJsonRecord(arguments_)) {
      throw new Error(`tool call ${candidate.name} arguments did not produce an object`);
    }
    return { id: candidate.id, name: candidate.name, arguments: arguments_ };
  });
};

interface ToolContinuationObligation {
  readonly expectedCursor?: unknown;
  readonly narrowerRangeRequired: boolean;
  readonly previousRanges?: readonly (readonly [number, number])[];
}

type RangeSet = readonly (readonly [number, number])[];

const rangeSetFromValue = (value: unknown): RangeSet | undefined => {
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      return [[value[0], value[1]]];
    }
    if (value.length === 0) return undefined;
    const ranges: Array<readonly [number, number]> = [];
    for (const item of value) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
      const record = item as Readonly<Record<string, unknown>>;
      if (typeof record.charStart !== "number" || typeof record.charEnd !== "number") {
        return undefined;
      }
      ranges.push([record.charStart, record.charEnd]);
    }
    return ranges;
  }
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record.charStart === "number" && typeof record.charEnd === "number"
    ? [[record.charStart, record.charEnd]]
    : undefined;
};

const rangeFromArguments = (
  arguments_: Readonly<Record<string, unknown>>,
): RangeSet | undefined => {
  const reference = arguments_.reference;
  if (reference !== null && typeof reference === "object" && !Array.isArray(reference)) {
    const nested = reference as Readonly<Record<string, unknown>>;
    const ranges = rangeSetFromValue(nested.ranges);
    if (ranges !== undefined) return ranges;
  }
  return rangeSetFromValue(arguments_.ranges) ?? rangeSetFromValue(arguments_.range);
};

const normalizeRangeSet = (ranges: RangeSet): RangeSet | undefined => {
  const ordered = ranges
    .filter(
      ([start, end]) =>
        Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start,
    )
    .toSorted(([left], [right]) => left - right);
  if (ordered.length !== ranges.length) return undefined;
  const normalized: Array<readonly [number, number]> = [];
  for (const [start, end] of ordered) {
    const previous = normalized.at(-1);
    if (previous === undefined || start > previous[1]) {
      normalized.push([start, end]);
    } else {
      normalized[normalized.length - 1] = [previous[0], Math.max(previous[1], end)];
    }
  }
  return normalized;
};

const isStrictlyNarrowerRange = (
  previous: RangeSet | undefined,
  next: RangeSet | undefined,
): boolean => {
  if (previous === undefined || next === undefined) return false;
  const normalizedPrevious = normalizeRangeSet(previous);
  const normalizedNext = normalizeRangeSet(next);
  if (normalizedPrevious === undefined || normalizedNext === undefined) return false;
  const nextLength = normalizedNext.reduce((total, [start, end]) => total + end - start, 0);
  const previousLength = normalizedPrevious.reduce((total, [start, end]) => total + end - start, 0);
  return (
    normalizedNext.every(([nextStart, nextEnd]) =>
      normalizedPrevious.some(
        ([previousStart, previousEnd]) => nextStart >= previousStart && nextEnd <= previousEnd,
      ),
    ) && nextLength < previousLength
  );
};

const rangeFromIncompleteResult = (
  result: Readonly<Record<string, unknown>>,
): RangeSet | undefined => {
  const ranges = rangeSetFromValue(result.ranges) ?? rangeSetFromValue(result.range);
  if (ranges !== undefined) return ranges;
  return typeof result.textCharCount === "number" && Number.isSafeInteger(result.textCharCount)
    ? [[0, result.textCharCount]]
    : undefined;
};

const continuationKey = (name: string, arguments_: Readonly<Record<string, unknown>>): string =>
  `${name}:${stableJson(arguments_)}`;

const resultIsIncomplete = (result: Readonly<Record<string, unknown>>): boolean =>
  result.complete === false || result.truncated === true;

const exactTaskCoordinates = (coordinates: PiBoundaryCoordinates): PiBoundaryCoordinates => ({
  ...coordinates,
  ...requireCurrentTaskCoordinates(coordinates.taskId),
});

/**
 * Provider-authored response-shape failures consume the owning Smithers
 * task's bounded retry budget.  The product retryability remains the role's
 * normal canonical default; boundary-owned typed errors are never routed
 * through this helper and therefore retain their own task classification.
 */
const providerOutputError = (
  error: unknown,
  fallbackCode: ReturnType<typeof aiRunErrorCodeForRole>,
) => toAiRuntimeError(error, fallbackCode, { taskRetryable: true });

export class CanonicalAgentClient {
  constructor(private readonly boundary: ExactPiBoundary | PiRuntimeBoundary) {}

  async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    const request = {
      requestClass: input.requestClass,
      model: input.model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      tools: [
        {
          name: input.outputToolName,
          description: input.outputToolDescription,
          parameters: input.outputSchema,
        },
      ],
      toolChoice: "auto",
      requestedOutputTokens: input.requestedOutputTokens,
      reasoning: input.reasoning,
    } as const satisfies LiveProviderRequest;
    let completion: PiCompletion;
    try {
      completion = await this.boundary.complete(
        request,
        exactTaskCoordinates(input.coordinates),
        input.onBeforeRequest,
      );
    } catch (error) {
      throw toAiRuntimeError(error, aiRunErrorCodeForRole(input.coordinates.agentRole));
    }
    try {
      return parseExactlyOneTerminal(completion, input.outputToolName, input.validate);
    } catch (error) {
      throw providerOutputError(error, aiRunErrorCodeForRole(input.coordinates.agentRole));
    }
  }

  async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    const messages: ProviderMessage[] = [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ];
    const tools = new Map(input.tools.map((tool) => [tool.definition.name, tool]));
    const continuationObligations = new Map<string, ToolContinuationObligation>();
    let forceTerminalNextTurn = false;

    for (let turn = 0; turn < input.maximumTurns; turn += 1) {
      const coordinates = {
        ...input.coordinates,
        ...requireCurrentTaskCoordinates(input.coordinates.taskId),
        providerRequestIndex: turn,
      } satisfies PiBoundaryCoordinates;
      const terminalTurn =
        forceTerminalNextTurn ||
        ((input.terminalOnlyForTurn?.(turn) === true ||
          (input.reserveFinalTurnForTerminal === true && turn === input.maximumTurns - 1)) &&
          continuationObligations.size === 0);
      const enforceTerminalTurn = input.enforceTerminalTurn === true;
      const terminalTool = terminalTurn ? tools.get(input.terminalToolName) : undefined;
      if (terminalTurn && terminalTool === undefined) {
        throw new Error(`terminal tool ${input.terminalToolName} is not defined`);
      }
      const disabledTools = new Set(input.disabledToolsForTurn?.(turn) ?? []);
      const visibleTools = input.tools.filter(
        (tool) =>
          !disabledTools.has(tool.definition.name) &&
          (!enforceTerminalTurn || terminalTurn || tool.definition.name !== input.terminalToolName),
      );
      const visibleToolsByName = new Map(visibleTools.map((tool) => [tool.definition.name, tool]));
      let completion: PiCompletion;
      try {
        completion = await this.boundary.complete(
          {
            requestClass: input.requestClass,
            model: input.model,
            messages: [...messages],
            tools: terminalTurn
              ? [terminalTool!.definition]
              : visibleTools.map((tool) => tool.definition),
            // Z.AI currently supports automatic tool selection only. The
            // prompts and terminal-tool-only turn shape enforce the loop
            // protocol while preserving the provider's supported posture.
            toolChoice: "auto",
            requestedOutputTokens: input.requestedOutputTokens,
            reasoning: input.reasoning,
          },
          coordinates,
          input.onBeforeRequest,
        );
      } catch (error) {
        throw toAiRuntimeError(error, aiRunErrorCodeForRole(input.coordinates.agentRole));
      }
      let toolCalls: readonly ParsedToolCall[];
      try {
        toolCalls = parseToolCalls(completion.toolCalls, tools);
      } catch (error) {
        throw providerOutputError(error, aiRunErrorCodeForRole(input.coordinates.agentRole));
      }
      if (toolCalls.length === 0) {
        // GLM occasionally returns a prose-only turn while it is deciding
        // which bounded tool phase to enter. Preserve that response in the
        // exact conversation and spend the existing loop budget on a
        // code-owned correction instead of failing the whole retrieval task.
        messages.push({
          role: "assistant",
          content: completion.text,
          toolCalls: completion.toolCalls,
        });
        messages.push({
          role: "user",
          content: `Call exactly one advertised tool. The required terminal tool is ${input.terminalToolName}; otherwise use one advertised retrieval tool before terminalizing.`,
        });
        continue;
      }
      const priorContinuationObligations = new Map(continuationObligations);
      const exclusiveToolNames = new Set(input.exclusiveToolNames ?? []);
      const exclusiveCall = toolCalls.find((call) => exclusiveToolNames.has(call.name));
      const hasTerminalCall = toolCalls.some((call) => call.name === input.terminalToolName);
      if (
        (terminalTurn &&
          (toolCalls.length !== 1 || toolCalls[0]?.name !== input.terminalToolName)) ||
        (hasTerminalCall && toolCalls.length !== 1) ||
        (exclusiveCall !== undefined && toolCalls.length !== 1)
      ) {
        throw providerOutputError(
          new Error(
            terminalTurn
              ? "terminal tool call must be the sole call in its complete provider turn"
              : `tool ${exclusiveCall?.name ?? ""} must be the sole call in its complete provider turn`,
          ),
          aiRunErrorCodeForRole(input.coordinates.agentRole),
        );
      }
      const preflightContinuationKeys = new Set<string>();
      for (const call of toolCalls) {
        if (call.name === input.terminalToolName || disabledTools.has(call.name)) continue;
        if (!visibleToolsByName.has(call.name)) {
          throw providerOutputError(
            new Error(`unknown tool call ${call.name}`),
            aiRunErrorCodeForRole(input.coordinates.agentRole),
          );
        }
        const key = continuationKey(call.name, call.arguments);
        const obligation = priorContinuationObligations.get(key);
        if (obligation === undefined) continue;
        if (preflightContinuationKeys.has(key)) {
          throw providerOutputError(
            new Error(`tool continuation ${call.name} was called more than once in one turn`),
            aiRunErrorCodeForRole(input.coordinates.agentRole),
          );
        }
        preflightContinuationKeys.add(key);
        if (
          obligation.expectedCursor !== undefined &&
          exactStableJson(call.arguments.cursor) !== exactStableJson(obligation.expectedCursor)
        ) {
          throw providerOutputError(
            new Error("tool continuation did not use the exact returned cursor"),
            aiRunErrorCodeForRole(input.coordinates.agentRole),
          );
        }
        if (
          obligation.narrowerRangeRequired === true &&
          !isStrictlyNarrowerRange(obligation.previousRanges, rangeFromArguments(call.arguments))
        ) {
          throw providerOutputError(
            new Error("tool continuation did not use a strictly narrower range"),
            aiRunErrorCodeForRole(input.coordinates.agentRole),
          );
        }
      }
      messages.push({
        role: "assistant",
        content: completion.text,
        toolCalls: completion.toolCalls,
      });

      let continuationCreatedInCurrentResponse = false;
      for (const call of toolCalls) {
        if (enforceTerminalTurn && call.name === input.terminalToolName && !terminalTurn) {
          const error = new Error("terminal tool called before its reserved terminal turn");
          const recovery = input.recoverTerminal?.(call.arguments, error, coordinates);
          if (recovery !== undefined) {
            messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: toolResultJson(recovery),
            });
            continue;
          }
          throw providerOutputError(error, aiRunErrorCodeForRole(input.coordinates.agentRole));
        }
        if (call.name === input.terminalToolName) {
          if (toolCalls.length !== 1) {
            throw providerOutputError(
              new Error("terminal tool call must be the only call in its turn"),
              aiRunErrorCodeForRole(input.coordinates.agentRole),
            );
          }
          if (continuationObligations.size > 0 && !forceTerminalNextTurn) {
            throw providerOutputError(
              new Error("terminal tool called with unresolved incomplete tool results"),
              aiRunErrorCodeForRole(input.coordinates.agentRole),
            );
          }
          let output: Output;
          try {
            output = input.validateTerminal(call.arguments);
          } catch (error) {
            if (input.coordinates.agentRole === "context_reducer") {
              console.error("context reducer terminal rejected", error);
            }
            const recovery = input.recoverTerminal?.(call.arguments, error, coordinates);
            if (recovery !== undefined) {
              messages.push({
                role: "tool",
                toolCallId: call.id,
                name: call.name,
                content: toolResultJson(recovery),
              });
              continue;
            }
            throw providerOutputError(error, aiRunErrorCodeForRole(input.coordinates.agentRole));
          }
          try {
            await input.onTerminal?.(output, coordinates, completion);
            return output;
          } catch (error) {
            const recovery = input.recoverTerminal?.(output, error, coordinates);
            if (recovery !== undefined) {
              messages.push({
                role: "tool",
                toolCallId: call.id,
                name: call.name,
                content: toolResultJson(recovery),
              });
              continue;
            }
            throw toAiRuntimeError(error, aiRunErrorCodeForRole(input.coordinates.agentRole));
          }
        }
        const tool = visibleToolsByName.get(call.name);
        if (tool === undefined) {
          if (disabledTools.has(call.name)) {
            // Some providers occasionally replay a stale tool name even after
            // the next-phase request removed it from the advertised schema.
            // Keep the phase transition code-owned without turning that stale
            // call into a task retry; the remaining visible tools and the
            // terminal reservation still bound the provider's recovery.
            messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: toolResultJson(
                input.disabledToolResult?.(call.name) ?? {
                  complete: true,
                  toolDisabled: true,
                  message: `tool ${call.name} is disabled in the current retrieval phase; use an advertised tool`,
                },
              ),
            });
            continue;
          }
          throw providerOutputError(
            new Error(`unknown tool call ${call.name}`),
            aiRunErrorCodeForRole(input.coordinates.agentRole),
          );
        }
        const obligationKey = continuationKey(call.name, call.arguments);
        const obligation = priorContinuationObligations.get(obligationKey);
        if (
          (priorContinuationObligations.size > 0 && obligation === undefined) ||
          continuationCreatedInCurrentResponse
        ) {
          messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: toolResultJson({
              complete: true,
              continuationRequired: true,
              message:
                "Resolve every incomplete tool result with its exact cursor or a strictly narrower range before making unrelated tool calls.",
            }),
          });
          continue;
        }
        let result: Readonly<Record<string, unknown>>;
        if (forceTerminalNextTurn) {
          result = {
            complete: true,
            protocolError: "protocol recovery is terminal-only",
          };
        } else {
          try {
            result = await tool.execute(call.arguments, coordinates);
          } catch (error) {
            if (input.coordinates.agentRole === "context_reducer") {
              console.error("context reducer tool rejected", call.name, error);
            }
            const recovery = input.recoverToolError?.(
              call.name,
              call.arguments,
              error,
              coordinates,
            );
            if (recovery === undefined) {
              throw toAiRuntimeError(error, aiRunErrorCodeForRole(input.coordinates.agentRole));
            }
            result = recovery;
          }
        }
        if (input.coordinates.agentRole === "internal_retrieval") {
          console.error("internal retrieval tool result", call.name, result);
        }
        if (typeof result.protocolError === "string" && result.protocolError.trim() !== "") {
          // Protocol errors are code-owned results. They close all outstanding
          // cursor obligations and force the very next provider turn to emit
          // the terminal manifest; no further search/inspection can run.
          forceTerminalNextTurn = true;
          continuationObligations.clear();
        }
        if (resultIsIncomplete(result)) {
          const expectedCursor = result.cursor;
          const narrowerRangeRequired = result.narrowerRangeRequired === true;
          const previousRanges = narrowerRangeRequired
            ? (rangeFromArguments(call.arguments) ?? rangeFromIncompleteResult(result))
            : undefined;
          if (result.nextItemTooLarge === true || result.itemTooLarge === true) {
            throw toAiRuntimeError(
              new Error("tool result cannot be completed within its exact response bound"),
              aiRunErrorCodeForRole(input.coordinates.agentRole),
            );
          }
          if ((expectedCursor === null || expectedCursor === undefined) && !narrowerRangeRequired) {
            throw toAiRuntimeError(
              new Error("tool returned an incomplete result without a valid continuation"),
              aiRunErrorCodeForRole(input.coordinates.agentRole),
            );
          }
          continuationObligations.set(obligationKey, {
            ...(expectedCursor === null || expectedCursor === undefined ? {} : { expectedCursor }),
            narrowerRangeRequired,
            ...(previousRanges === undefined ? {} : { previousRanges }),
          });
          continuationCreatedInCurrentResponse = true;
        } else if (obligation !== undefined) {
          continuationObligations.delete(obligationKey);
        }
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: toolResultJson(result),
        });
      }
    }
    throw providerOutputError(
      new Error(`tool loop exhausted ${input.maximumTurns} turns without terminal output`),
      aiRunErrorCodeForRole(input.coordinates.agentRole),
    );
  }

  stream(
    request: LiveProviderRequest,
    coordinates: PiBoundaryCoordinates,
    onDelta: (delta: string, index: number) => Promise<void> | void,
    onBeforeRequest?: BeforeProviderRequest,
  ): Promise<PiCompletion> {
    return this.boundary.stream(
      request,
      exactTaskCoordinates(coordinates),
      onDelta,
      onBeforeRequest,
    );
  }
}

export const zodValidator =
  <Schema extends z.ZodTypeAny>(schema: Schema) =>
  (value: unknown): z.infer<Schema> =>
    schema.parse(value);
