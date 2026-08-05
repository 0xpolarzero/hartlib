import { aiRunErrorCodeForRole, AiRuntimeError } from "../runtime/errors";
import { z } from "zod";
import {
  measureProviderRequest,
  resolveRuntimeModel,
  type AcceptedProviderProfile,
  type ProviderGateLimits,
} from "../runtime/model-registry";
import type { AiProviderEndpointIdentity, AiProviderServiceId } from "@hartlib/shared";
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
  requireLiveProviderRequest,
  stableJson,
} from "../runtime/provider-request";
import {
  currentTaskAbortSignal,
  requireCurrentTaskCoordinates,
  throwIfAborted,
} from "../runtime/task-cancellation";
import { e2eStreamGateIdFromMessage } from "./stream-gate";
import {
  BranchCoverageSchema,
  InternalQueryPlanProviderSchema,
  InternalQueryPlanSchema,
  InternalQuerySchema,
  PHYSICAL_QUERY_BRANCHES,
  QueryReviewProviderSchema,
  QueryReviewSchema,
} from "../retrieval/query-spec";
import {
  FallbackContextManifestSchema,
  GroupCompactionResultSchema,
  InitialContextManifestSchema,
} from "../context/compaction";
import {
  FallbackCompactionProviderInputSchema,
  InitialCompactionProviderInputSchema,
  NormalCompactionProviderInputSchema,
  ReadSourcePassagesArgumentsSchema,
  SearchSourcePassagesArgumentsSchema,
  SourceCompactionToolDefinitions,
  SourceToolCompactionProviderInputSchema,
} from "../context/compaction-provider";
import { ReviewModelFusedResultSchema } from "../retrieval/rank-fusion";

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

const structuredPlanInputSchema = z.strictObject({
  question: z.string().min(1).max(4_096),
  selectedConversation: z.array(
    z.union([
      z.strictObject({ userContent: z.string(), assistantContent: z.string() }),
      z.strictObject({ userContent: z.string(), errorCode: z.string(), retryable: z.boolean() }),
    ]),
  ),
  locale: z.string().min(1).max(128),
  market: z.string().min(1).max(128),
  currentDate: z.string().min(1).max(64),
});

const structuredReviewInputSchema = z.strictObject({
  question: z.string().min(1).max(4_096),
  queries: z.array(InternalQuerySchema).min(1).max(64),
  results: z.array(ReviewModelFusedResultSchema),
  coverage: z.array(BranchCoverageSchema).min(1),
  truncation: z.strictObject({
    branch: z.boolean(),
    candidates: z.boolean(),
    hydration: z.boolean(),
  }),
});

const structuredCoverageBranches = PHYSICAL_QUERY_BRANCHES;

const strictStructuredUser = <T>(
  request: ProviderRequest,
  schema: z.ZodType<T>,
  role: string,
  expectedToolName: string,
  expectedParameters: Readonly<Record<string, unknown>>,
): T => {
  if (request.tools?.length !== 1 || request.tools[0]?.name !== expectedToolName) {
    throw new AiRuntimeError(
      "invalid_workflow_output",
      `${role} request must advertise only ${expectedToolName}`,
      { taskRetryable: false },
    );
  }
  const parameters = request.tools[0]?.parameters;
  if (parameters === undefined || stableJson(parameters) !== stableJson(expectedParameters)) {
    throw new AiRuntimeError(
      "invalid_workflow_output",
      `${role} request advertises a schema different from production ${expectedToolName}`,
      { taskRetryable: false },
    );
  }
  const users = request.messages.filter((message) => message.role === "user");
  if (users.length !== 1) {
    throw new AiRuntimeError(
      "invalid_workflow_output",
      `${role} requires exactly one user request`,
      { taskRetryable: false },
    );
  }
  try {
    return schema.parse(JSON.parse(users[0]!.content)) as T;
  } catch (error) {
    throw new AiRuntimeError(
      "invalid_workflow_output",
      `${role} request does not match its strict schema: ${error instanceof Error ? error.message : String(error)}`,
      { taskRetryable: false },
    );
  }
};

const structuredTermsFor = (question: string, locale?: string): readonly string[] => {
  const normalized = question.toLocaleLowerCase("en-US").normalize("NFC");
  const french = locale?.toLocaleLowerCase("en-US").startsWith("fr") === true;
  const preferred = [
    ["solar", "solaire", "solaires", "solaire"],
    ["storage", "stockage", "stockages"],
    ["wind", "éolien", "éolienne", "éoliennes"],
    ["curtailment", "curtailment"],
    ["market", "marché", "price", "prix"],
  ] as const;
  const terms = preferred.flatMap(([canonical, ...aliases]) => {
    const matched = [canonical, ...aliases].find((alias) => normalized.includes(alias));
    if (matched === undefined) return [];
    return [french ? (aliases[0] ?? canonical) : matched];
  });
  if (terms.length > 0) return [...new Set(terms)];
  const words = normalized.match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  const ignored = new Set(["the", "and", "for", "what", "does", "this", "that", "avec"]);
  return [words.find((word) => !ignored.has(word)) ?? "brief"];
};

const structuredQueriesFor = (question: string, locale?: string) => {
  const purpose = question.trim().normalize("NFC").slice(0, 4_000);
  return structuredTermsFor(question, locale).map((term) => ({
    purpose: `${purpose} (${term})`.slice(0, 4_096),
    all: [{ text: term, mode: "term" as const }],
    anyOf: [],
    not: [],
    filters: {},
    order: "relevance" as const,
  }));
};

const isCompactionCandidate = (candidate: {
  readonly kind: string;
  readonly renderedTokenCount: number;
}): boolean =>
  (candidate.kind === "document" || candidate.kind === "chat_message") &&
  candidate.renderedTokenCount > 1;
const assertUniqueIds = (ids: readonly string[], label: string): void => {
  if (new Set(ids).size !== ids.length) {
    throw new AiRuntimeError("invalid_workflow_output", `${label} contains duplicate IDs`, {
      taskRetryable: false,
    });
  }
};

const assertExactIds = (
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void => {
  assertUniqueIds(actual, label);
  assertUniqueIds(expected, label);
  if (
    actual.length !== expected.length ||
    expected.some((id) => !actual.includes(id)) ||
    actual.some((id) => !expected.includes(id))
  ) {
    throw new AiRuntimeError("invalid_workflow_output", `${label} membership changed`, {
      taskRetryable: false,
    });
  }
};

const assertSourceToolRequest = (
  request: ProviderRequest,
  input: z.infer<typeof SourceToolCompactionProviderInputSchema>,
): { readonly terminalOnly: boolean; readonly candidateId: string } => {
  assertExactIds(input.group.candidateIds, [input.candidate.candidateId], "source-tool group");
  const advertised = request.tools?.map((tool) => tool.name) ?? [];
  const expected = SourceCompactionToolDefinitions.map((tool) => tool.name).filter(
    (name) => name !== "emit_compaction_result",
  );
  assertUniqueIds(advertised, "source-tool advertised tools");
  const terminalOnly = advertised.length === 1 && advertised[0] === "emit_compaction_result";
  if (!terminalOnly) assertExactIds(advertised, expected, "source-tool advertised tools");
  return { terminalOnly, candidateId: input.candidate.candidateId };
};

const passageIdsFromToolResults = (
  results: ReadonlyArray<{ readonly value: Record<string, unknown> }>,
  label: string,
): readonly string[] => {
  const ids: string[] = [];
  for (const { value } of results) {
    if (!Array.isArray(value.passages)) continue;
    for (const passage of value.passages) {
      const passageId = asRecord(passage).passageId;
      if (typeof passageId !== "string" || !/^p[1-9][0-9]*$/u.test(passageId)) {
        throw new AiRuntimeError(
          "invalid_workflow_output",
          `${label} returned an invalid passage ID`,
          { taskRetryable: false },
        );
      }
      ids.push(passageId);
    }
  }
  return ids;
};

const initialCompactionManifestFor = (
  input: z.infer<typeof InitialCompactionProviderInputSchema>,
) => {
  const candidateIds = input.candidates.map((candidate) => candidate.candidateId);
  assertUniqueIds(candidateIds, "initial manifest candidates");
  if (input.candidates.length > input.toolBounds.maximumCandidates) {
    throw new AiRuntimeError(
      "invalid_workflow_output",
      "initial manifest exceeds its candidate bound",
      { taskRetryable: false },
    );
  }
  const groups: { groupId: string; renderedTokenBudget: number }[] = [];
  const groupByCandidate = new Map<string, string>();
  let remaining =
    input.allowance -
    input.mandatoryInputCost -
    input.candidates
      .filter((candidate) => !isCompactionCandidate(candidate))
      .reduce((total, candidate) => total + candidate.renderedTokenCount, 0);
  for (const candidate of input.candidates) {
    if (
      !isCompactionCandidate(candidate) ||
      groups.length >= input.toolBounds.maximumGroups ||
      remaining < 1
    ) {
      continue;
    }
    const renderedTokenBudget = Math.min(candidate.renderedTokenCount - 1, remaining);
    if (renderedTokenBudget < 1) continue;
    const groupId = `g${groups.length + 1}`;
    groups.push({ groupId, renderedTokenBudget });
    groupByCandidate.set(candidate.candidateId, groupId);
    remaining -= renderedTokenBudget;
  }
  const decisions = input.candidates.map((candidate) => {
    const groupId = groupByCandidate.get(candidate.candidateId);
    if (groupId !== undefined) {
      return {
        candidateId: candidate.candidateId,
        action: "compact" as const,
        groupId,
        reason: "retain exact evidence passages",
      };
    }
    if (isCompactionCandidate(candidate) && remaining < 1) {
      return {
        candidateId: candidate.candidateId,
        action: "omit" as const,
        reason: "omit the candidate when no compact budget remains",
      };
    }
    return {
      candidateId: candidate.candidateId,
      action: "keep" as const,
      reason: "retain provider-safe evidence",
    };
  });
  return InitialContextManifestSchema.parse({ decisions, groups });
};

const groupCompactionResultFor = (input: z.infer<typeof NormalCompactionProviderInputSchema>) => {
  const candidates = input.candidates;
  const candidateIds = candidates.map((candidate) => candidate.candidateId);
  assertExactIds(candidateIds, input.group.candidateIds, "compaction group candidates");
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const priorById = new Map(
    input.priorResult?.decisions.map((decision) => [decision.candidateId, decision]) ?? [],
  );
  for (const candidate of candidates) {
    assertUniqueIds(
      candidate.passages.map((passage) => passage.passageId),
      `candidate ${candidate.candidateId} passages`,
    );
  }
  if (input.priorResult !== undefined) {
    assertExactIds(
      input.priorResult.decisions.map((decision) => decision.candidateId),
      input.group.candidateIds,
      "prior compaction group candidates",
    );
    for (const decision of input.priorResult.decisions) {
      if (decision.action !== "select") continue;
      const candidate = byId.get(decision.candidateId)!;
      const suppliedPassageIds = candidate.passages.map((passage) => passage.passageId);
      if (decision.passageIds.some((passageId) => !suppliedPassageIds.includes(passageId))) {
        throw new AiRuntimeError(
          "invalid_workflow_output",
          `prior result selects an undisclosed passage for ${decision.candidateId}`,
          { taskRetryable: false },
        );
      }
    }
  }
  let remaining = input.group.renderedTokenBudget;
  const decisions = input.group.candidateIds.map((candidateId) => {
    const candidate = byId.get(candidateId)!;
    const prior = priorById.get(candidateId);
    if (prior?.action === "omit") {
      return { candidateId, action: "omit" as const, reason: "retain the prior omission" };
    }
    const availablePassages =
      prior?.action === "select"
        ? candidate.passages.filter((passage) => prior.passageIds.includes(passage.passageId))
        : candidate.passages;
    const selected = availablePassages.find(
      (passage) => resolveRuntimeModel("glm-5-turbo").countTextTokens(passage.text) <= remaining,
    );
    if (selected === undefined) {
      return {
        candidateId,
        action: "omit" as const,
        reason:
          availablePassages.length === 0
            ? "no selectable passage is supplied"
            : "the exact passage does not fit the group budget",
      };
    }
    const cost = resolveRuntimeModel("glm-5-turbo").countTextTokens(selected.text);
    remaining -= cost;
    return {
      candidateId,
      action: "select" as const,
      passageIds: [selected.passageId],
      reason:
        prior?.action === "select" && prior.passageIds.length > 1
          ? "tighten to one prior exact passage"
          : selected === candidate.passages[0]
            ? "select the first exact passage"
            : "select the first fitting exact passage",
    };
  });
  return GroupCompactionResultSchema.parse({ decisions });
};

const fallbackCompactionManifestFor = (
  input: z.infer<typeof FallbackCompactionProviderInputSchema>,
) => {
  const originalIds = input.originalCandidates.map((candidate) => candidate.candidateId);
  assertUniqueIds(originalIds, "fallback original candidates");
  assertExactIds(
    input.initialManifest.decisions.map((decision) => decision.candidateId),
    originalIds,
    "fallback initial decisions",
  );
  const compactDecisions = input.initialManifest.decisions.filter(
    (decision) => decision.action === "compact",
  );
  const initialGroupIds = input.initialManifest.groups.map((group) => group.groupId);
  assertExactIds(
    compactDecisions.map((decision) => decision.groupId),
    initialGroupIds,
    "fallback initial groups",
  );
  const firstGroupIds = input.firstPass.map((pass) => pass.groupId);
  assertExactIds(firstGroupIds, initialGroupIds, "fallback first-pass groups");
  const firstByGroup = new Map(input.firstPass.map((pass) => [pass.groupId, pass]));
  for (const groupId of initialGroupIds) {
    const expectedMembers = compactDecisions
      .filter((decision) => decision.groupId === groupId)
      .map((decision) => decision.candidateId);
    assertExactIds(
      firstByGroup.get(groupId)!.decisions.map((decision) => decision.candidateId),
      expectedMembers,
      `fallback first-pass group ${groupId}`,
    );
  }
  const initialById = new Map(
    input.initialManifest.decisions.map((decision) => [decision.candidateId, decision]),
  );
  const decisions = input.originalCandidates.map((candidate) => {
    const initial = initialById.get(candidate.candidateId)!;
    if (initial.action === "omit") {
      return {
        candidateId: candidate.candidateId,
        action: "omit" as const,
        reason: "close the fallback without restoring evidence",
      };
    }
    if (initial.action === "keep") {
      return {
        candidateId: candidate.candidateId,
        action: "retain" as const,
        reason: "retain the prior whole candidate",
      };
    }
    const first = firstByGroup.get(initial.groupId)!;
    const selection = first.decisions.find(
      (decision) => decision.candidateId === candidate.candidateId,
    )!;
    if (
      first.actualRenderedTokenCount > 1 &&
      selection.action === "select" &&
      selection.passageIds.length > 1
    ) {
      return {
        candidateId: candidate.candidateId,
        action: "tighten" as const,
        groupId: initial.groupId,
        reason: "tighten to a strict subset of the first pass",
      };
    }
    return {
      candidateId: candidate.candidateId,
      action: "omit" as const,
      reason:
        selection.action === "omit"
          ? "retain the first-pass omission"
          : "omit the first-pass selection when it cannot tighten",
    };
  });
  const groups = input.firstPass.flatMap((pass) => {
    const active = decisions.some(
      (decision) => decision.action === "tighten" && decision.groupId === pass.groupId,
    );
    return active && pass.actualRenderedTokenCount > 1
      ? [
          {
            groupId: pass.groupId,
            renderedTokenBudget: pass.actualRenderedTokenCount - 1,
          },
        ]
      : [];
  });
  return FallbackContextManifestSchema.parse({ decisions, groups });
};

const sourceToolOutputFor = (
  request: ProviderRequest,
  input: z.infer<typeof SourceToolCompactionProviderInputSchema>,
  coordinates: PiBoundaryCoordinates,
) => {
  const { terminalOnly, candidateId } = assertSourceToolRequest(request, input);
  const searches = toolResults(request, "search_source_passages");
  const reads = toolResults(request, "read_source_passages");
  const searchHistory = toolHistory(request, "search_source_passages");
  const lastSearch = searches.at(-1)?.value;
  const lastSearchArguments = searchHistory.at(-1)?.arguments;
  const lastCursor = lastSearch?.cursor;
  if (!terminalOnly && searches.length > 0 && lastSearch?.complete !== true) {
    if (typeof lastCursor !== "string" || lastCursor.length === 0) {
      throw new AiRuntimeError(
        "invalid_workflow_output",
        "source-tool search result is incomplete without a cursor",
        { taskRetryable: false },
      );
    }
    return {
      text: "",
      toolCalls: [
        call(coordinates, "search_source_passages", {
          candidateId,
          query:
            typeof lastSearchArguments?.query === "string"
              ? lastSearchArguments.query
              : (structuredTermsFor(input.question)[0] ?? "evidence"),
          cursor: lastCursor,
        }),
      ],
    };
  }
  if (!terminalOnly && searches.length === 0) {
    const arguments_ = SearchSourcePassagesArgumentsSchema.parse({
      candidateId,
      query: input.question.includes("[no-evidence]")
        ? "__deterministic_no_evidence__"
        : (structuredTermsFor(input.question)[0] ?? "evidence"),
    });
    return { text: "", toolCalls: [call(coordinates, "search_source_passages", arguments_)] };
  }
  const exposedPassageIds = [
    ...passageIdsFromToolResults(searches, "source search"),
    ...passageIdsFromToolResults(reads, "source read"),
  ];
  const uniquePassageIds = [...new Set(exposedPassageIds)];
  if (!terminalOnly && reads.length === 0 && uniquePassageIds.length > 0) {
    const arguments_ = ReadSourcePassagesArgumentsSchema.parse({
      candidateId,
      passageIds: uniquePassageIds.slice(0, 32),
    });
    return { text: "", toolCalls: [call(coordinates, "read_source_passages", arguments_)] };
  }
  const prior = input.priorResult?.decisions.find(
    (decision) => decision.candidateId === candidateId,
  );
  const priorIds = prior?.action === "select" ? prior.passageIds : [];
  const disclosed = new Set(uniquePassageIds);
  const selectedIds =
    priorIds.length > 1
      ? priorIds.filter((passageId) => disclosed.has(passageId)).slice(0, -1)
      : priorIds.length === 1
        ? priorIds.filter((passageId) => disclosed.has(passageId))
        : uniquePassageIds.slice(0, 1);
  const result =
    selectedIds.length === 0
      ? {
          decisions: [
            {
              candidateId,
              action: "omit" as const,
              reason: "no exact passage supports the focused question",
            },
          ],
        }
      : {
          decisions: [
            {
              candidateId,
              action: "select" as const,
              passageIds: selectedIds,
              reason:
                priorIds.length > selectedIds.length
                  ? "tighten to prior disclosed passages"
                  : "select disclosed exact passages",
            },
          ],
        };
  return {
    text: "",
    toolCalls: [
      call(coordinates, "emit_compaction_result", GroupCompactionResultSchema.parse(result)),
    ],
  };
};

const assertStructuredReviewEnvelope = (
  input: z.infer<typeof structuredReviewInputSchema>,
): void => {
  const queryOrdinals = input.queries.map((_, index) => index + 1);
  const branchOrder = new Map(structuredCoverageBranches.map((branch, index) => [branch, index]));
  const expectedCoverage = queryOrdinals.flatMap((queryOrdinal) =>
    structuredCoverageBranches.map((branch) => `${queryOrdinal}\u0000${branch}`),
  );
  const actualCoverage = input.coverage.map((row) => `${row.queryOrdinal}\u0000${row.branch}`);
  if (
    actualCoverage.length !== expectedCoverage.length ||
    actualCoverage.some((key, index) => key !== expectedCoverage[index])
  ) {
    throw new AiRuntimeError(
      "invalid_workflow_output",
      "internal query review coverage must include every store in current order",
      { taskRetryable: false },
    );
  }
  for (const [index, result] of input.results.entries()) {
    if (result.resultId !== `r${index + 1}`) {
      throw new AiRuntimeError(
        "invalid_workflow_output",
        "internal query review result IDs must be sequential",
        { taskRetryable: false },
      );
    }
    if (JSON.stringify(result.branchCoverage) !== JSON.stringify(input.coverage)) {
      throw new AiRuntimeError(
        "invalid_workflow_output",
        "internal query review result coverage does not match the request",
        { taskRetryable: false },
      );
    }
    if (
      JSON.stringify(result.truncationFlags) !== JSON.stringify(input.truncation) ||
      result.matchedQueryOrdinals.some(
        (ordinal, ordinalIndex, ordinals) =>
          !queryOrdinals.includes(ordinal) ||
          (ordinalIndex > 0 && ordinal <= ordinals[ordinalIndex - 1]!),
      )
    ) {
      throw new AiRuntimeError(
        "invalid_workflow_output",
        "internal query review result bounds do not match the request",
        { taskRetryable: false },
      );
    }
  }
  for (const row of input.coverage) {
    if (row.status === "applicable" && branchOrder.get(row.branch) === undefined) {
      throw new AiRuntimeError(
        "invalid_workflow_output",
        "internal query review contains an unknown physical branch",
        { taskRetryable: false },
      );
    }
  }
};

const outputFor = (
  request: ProviderRequest,
  coordinates: PiBoundaryCoordinates,
): { readonly text: string; readonly toolCalls: readonly ProviderToolCall[] } => {
  const user = userRecord(request);
  const rawUser = request.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  const agentRole =
    coordinates.agentRole === "internal_retrieval"
      ? request.tools?.[0]?.name === "emit_internal_query_plan"
        ? "internal_query_plan"
        : request.tools?.[0]?.name === "emit_internal_query_review"
          ? "internal_query_review"
          : coordinates.agentRole
      : coordinates.agentRole;
  switch (agentRole) {
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
                    question: "What do the solar connection sources report?",
                    relevantTurnIds: [],
                  },
                  {
                    topicId: "t2" as const,
                    question: "What do the storage operation sources report?",
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
                : "Which market and time horizon should Hartlib use?",
            }
          : currentMessage.includes("[fanout]")
            ? {
                mode: "fanout",
                question: currentMessage,
                topics: [
                  {
                    question: "What do the solar connection sources report?",
                    relevantTurnIds: [],
                  },
                  {
                    question: "What do the storage operation sources report?",
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
    case "internal_query_plan": {
      const input = strictStructuredUser(
        request,
        structuredPlanInputSchema,
        coordinates.agentRole,
        "emit_internal_query_plan",
        z.toJSONSchema(InternalQueryPlanProviderSchema),
      );
      const queries = structuredQueriesFor(input.question, input.locale);
      const plan = InternalQueryPlanSchema.parse({ action: "search", queries });
      return {
        text: "",
        toolCalls: [call(coordinates, "emit_internal_query_plan", plan)],
      };
    }
    case "internal_query_review": {
      const input = strictStructuredUser(
        request,
        structuredReviewInputSchema,
        coordinates.agentRole,
        "emit_internal_query_review",
        z.toJSONSchema(QueryReviewProviderSchema),
      );
      assertStructuredReviewEnvelope(input);
      const hasEvidence =
        input.results.length > 0 &&
        input.coverage.some((row) => row.status === "applicable" && row.hitCount > 0);
      const forceNoEvidence =
        /\[(?:no[-_ ]evidence|no_supporting_evidence)\]/iu.test(input.question) ||
        /\bno evidence\b/iu.test(input.question);
      const forceReplacement =
        /\[(?:replace|replacement)\]/iu.test(input.question) ||
        /\b(?:missed concept|replace the plan)\b/iu.test(input.question);
      const review = QueryReviewSchema.parse(
        forceNoEvidence || !hasEvidence
          ? { action: "no_evidence", reason: "no_supporting_evidence" }
          : forceReplacement
            ? {
                action: "replace",
                reason: "missed_concept",
                queries: structuredQueriesFor(input.question),
              }
            : { action: "accept", reason: "sufficient_coverage" },
      );
      return {
        text: "",
        toolCalls: [call(coordinates, "emit_internal_query_review", review)],
      };
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
    case "context_manifest": {
      const input = strictStructuredUser(
        request,
        InitialCompactionProviderInputSchema,
        coordinates.agentRole,
        "emit_context_manifest",
        z.toJSONSchema(InitialContextManifestSchema),
      );
      const manifest = initialCompactionManifestFor(input);
      return {
        text: "",
        toolCalls: [call(coordinates, "emit_context_manifest", manifest)],
      };
    }
    case "context_fallback_manifest": {
      const input = strictStructuredUser(
        request,
        FallbackCompactionProviderInputSchema,
        coordinates.agentRole,
        "emit_fallback_context_manifest",
        z.toJSONSchema(FallbackContextManifestSchema),
      );
      const manifest = fallbackCompactionManifestFor(input);
      return {
        text: "",
        toolCalls: [call(coordinates, "emit_fallback_context_manifest", manifest)],
      };
    }
    case "context_source_tool":
    case "context_compact_group":
    case "context_fallback_group": {
      if (
        coordinates.agentRole === "context_source_tool" ||
        request.tools?.some((tool) => tool.name === "search_source_passages")
      ) {
        const users = request.messages.filter((message) => message.role === "user");
        if (users.length !== 1) {
          throw new AiRuntimeError(
            "invalid_workflow_output",
            `${coordinates.agentRole} requires exactly one user request`,
            { taskRetryable: false },
          );
        }
        let input: z.infer<typeof SourceToolCompactionProviderInputSchema>;
        try {
          input = SourceToolCompactionProviderInputSchema.parse(JSON.parse(users[0]!.content));
        } catch (error) {
          throw new AiRuntimeError(
            "invalid_workflow_output",
            `${coordinates.agentRole} request does not match its strict source-tool schema: ${error instanceof Error ? error.message : String(error)}`,
            { taskRetryable: false },
          );
        }
        return sourceToolOutputFor(request, input, coordinates);
      }
      const input = strictStructuredUser(
        request,
        z.lazy(() => NormalCompactionProviderInputSchema),
        coordinates.agentRole,
        "emit_compaction_result",
        z.toJSONSchema(GroupCompactionResultSchema),
      );
      const result = groupCompactionResultFor(input);
      return {
        text: "",
        toolCalls: [call(coordinates, "emit_compaction_result", result)],
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
    const measuredSourceExposureProofBindings = providerRequestSourceExposureProofBindings(
      proofRequest,
      (text) => model.countTextTokens(text),
    );
    const sourceExposureProofBindings = measuredSourceExposureProofBindings;
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
        : `Deterministic direct answer grounded in the selected Hartlib evidence.${directCitationKeys.length === 0 ? "" : ` [[cite:${directCitationKeys.join(",")}]]`}`;
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
