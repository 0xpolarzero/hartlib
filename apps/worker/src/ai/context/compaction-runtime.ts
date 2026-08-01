import { Effect, Ref } from "effect";

import {
  buildCandidatePassageIndex,
  createCompactionGroups,
  mergeGroupCompactionResults,
  validateFallbackContextManifest,
  validateGroupCompactionResult,
  MAX_COMPACTION_GROUPS,
  type CompactionCostOptions,
  type CompactionGroup,
  type CompactionSelection,
  type FallbackContextManifest,
  type GroupCompactionResult,
  type GroupResultEnvelope,
  type InitialContextManifest,
} from "./compaction";
import {
  mapPassageIdsToRanges,
  selectedTextFromRanges,
  type PassageIndex,
  type PassageIndexOptions,
  type PassageView,
} from "./passages";
import type { CandidateLedger, CandidateLedgerEntry } from "../workflow/types";
import { CandidateLocalIdSchema, GroupLocalIdSchema } from "../workflow/types";

type Ledger = CandidateLedger | readonly CandidateLedgerEntry[];
type RuntimeEffect<A, R> = Effect.Effect<A, unknown, R>;

export { MAX_COMPACTION_GROUPS } from "./compaction";

export interface CanonicalCompactionGroupTask {
  readonly prefix: string;
  readonly phase: CompactionPhase;
  readonly ordinal: number;
}

export const parseCompactionGroupTaskId = (
  taskId: string,
  prefixes: readonly string[],
): CanonicalCompactionGroupTask | undefined => {
  const match = /^(.*)-(compact|fallback)-g([0-9]+)$/u.exec(taskId);
  if (match === null) return undefined;
  const prefix = match[1]!;
  const phase = match[2] as CompactionPhase;
  const ordinalText = match[3]!;
  const ordinal = Number(ordinalText);
  if (
    !prefixes.includes(prefix) ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 1 ||
    ordinal > MAX_COMPACTION_GROUPS ||
    ordinalText !== ordinal.toString().padStart(3, "0")
  ) {
    return undefined;
  }
  return { prefix, phase, ordinal };
};
export type CompactionPhase = "compact" | "fallback";

export const compactionGroupTaskId = (
  prefix: string,
  phase: CompactionPhase,
  ordinal: number,
): string => {
  if (prefix.length === 0 || !/^[-_a-zA-Z0-9]+$/u.test(prefix)) {
    throw new Error("compaction task prefix must be non-empty and code-safe");
  }
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > MAX_COMPACTION_GROUPS) {
    throw new Error(`compaction task ordinal must be between 1 and ${MAX_COMPACTION_GROUPS}`);
  }
  return `${prefix}-${phase}-g${String(ordinal).padStart(3, "0")}`;
};
export const MAX_COMPACTION_CONCURRENCY = 3;

export interface CompactionGroupCandidate {
  readonly candidateId: string;
  readonly kind: CandidateLedgerEntry["kind"];
  readonly label: string | null;
  readonly purpose: string;
  readonly date: string | null;
  readonly passages: readonly PassageView[];
}

export interface NormalCompactionRequest {
  readonly taskId: string;
  readonly phase: CompactionPhase;
  readonly question: string;
  readonly group: CompactionGroup;
  readonly candidates: readonly CompactionGroupCandidate[];
  readonly priorResult?: GroupCompactionResult | undefined;
}

export interface SourceToolCompactionRequest {
  readonly taskId: string;
  readonly phase: CompactionPhase;
  readonly question: string;
  readonly group: CompactionGroup;
  readonly candidate: CompactionGroupCandidate;
  readonly priorResult?: GroupCompactionResult | undefined;
}

export interface GroupRepairRequest {
  readonly taskId: string;
  readonly phase: CompactionPhase;
  readonly group: CompactionGroup;
  readonly invalidResult: unknown;
  readonly error: Error;
  readonly request: NormalCompactionRequest | SourceToolCompactionRequest;
}

export interface CompactionRuntimeDependencies<R = never> {
  readonly runNormalGroup: (request: NormalCompactionRequest) => RuntimeEffect<unknown, R>;
  readonly runSourceToolGroup: (request: SourceToolCompactionRequest) => RuntimeEffect<unknown, R>;
  readonly repairGroupResult?:
    | ((request: GroupRepairRequest) => RuntimeEffect<unknown, R>)
    | undefined;
  readonly costOptions?: CompactionCostOptions | undefined;
  readonly planFallback?:
    | ((request: FallbackPlanningRequest) => RuntimeEffect<unknown, R>)
    | undefined;
  readonly measureContext: (
    state: CompactionContextState,
  ) => RuntimeEffect<ExactContextMeasurement, R>;
  readonly taskPrefix?: string | undefined;
}

export interface CompactionPassInput {
  readonly phase: CompactionPhase;
  readonly question: string;
  readonly ledger: Ledger;
  readonly groups: readonly CompactionGroup[];
  readonly passageOptions: PassageIndexOptions;
  readonly concurrency: number;
  readonly priorResults?: readonly GroupResultEnvelope[] | undefined;
  readonly tightenCandidateIds?: ReadonlyMap<string, readonly string[]> | undefined;
}

export interface CompactionPassResult {
  readonly phase: CompactionPhase;
  readonly groups: readonly CompactionGroup[];
  readonly taskIds: readonly string[];
  readonly envelopes: readonly GroupResultEnvelope[];
  readonly selections: readonly CompactionSelection[];
  readonly repairUsed: boolean;
}

export interface CompactionRuntimeInput {
  readonly question: string;
  readonly ledger: Ledger;
  readonly initialManifest: InitialContextManifest;
  readonly sourceToolEligibleCandidateIds: readonly string[];
  readonly passageOptions: PassageIndexOptions;
  readonly concurrency: number;
  readonly remainingAnswerTokens?: number | undefined;
  readonly taskPrefix?: string | undefined;
}

export interface CompactionContextState {
  readonly phase: CompactionPhase;
  readonly question: string;
  readonly ledger: Ledger;
  readonly selections: readonly CompactionSelection[];
  readonly groups: readonly CompactionGroup[];
  readonly envelopes: readonly GroupResultEnvelope[];
}

export interface ExactContextMeasurement {
  readonly fits: boolean;
  readonly inputTokens: number;
  readonly usableInputTokens: number;
  readonly overByTokens: number;
}

export interface FallbackPlanningRequest {
  readonly taskId: string;
  readonly question: string;
  readonly ledger: Ledger;
  readonly initialManifest: InitialContextManifest;
  readonly firstPass: CompactionPassResult;
  readonly state: CompactionContextState;
  readonly measurement: ExactContextMeasurement;
}

export interface CompactionRuntimeReady {
  readonly status: "ready";
  readonly context: CompactionContextState;
  readonly measurement: ExactContextMeasurement;
  readonly fallbackRan: boolean;
  readonly repairUsed: boolean;
}

export interface CompactionRuntimeUnfit {
  readonly status: "context_plan_unfit";
  readonly context: CompactionContextState;
  readonly measurement: ExactContextMeasurement;
  readonly fallbackRan: boolean;
  readonly repairUsed: boolean;
}

export type CompactionRuntimeResult = CompactionRuntimeReady | CompactionRuntimeUnfit;

const ledgerEntries = (ledger: Ledger): readonly CandidateLedgerEntry[] =>
  "candidates" in ledger ? ledger.candidates : ledger;

const isPositiveSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const runtimeError = (message: string): Error => new Error(`compaction runtime: ${message}`);

const validatePassInput = (input: CompactionPassInput): void => {
  if (!isPositiveSafeInteger(input.concurrency)) {
    throw runtimeError("concurrency must be a positive safe integer");
  }
  if (input.concurrency > MAX_COMPACTION_CONCURRENCY) {
    throw runtimeError(`concurrency exceeds ${MAX_COMPACTION_CONCURRENCY}`);
  }
  if (input.groups.length > MAX_COMPACTION_GROUPS) {
    throw runtimeError(`group count exceeds ${MAX_COMPACTION_GROUPS}`);
  }
  if (new Set(input.groups.map((group) => group.groupId)).size !== input.groups.length) {
    throw runtimeError("group IDs must be unique");
  }
  const entries = ledgerEntries(input.ledger);
  const ledgerIds = new Set<string>(entries.map((candidate) => candidate.candidateId));
  const assignedIds = new Set<string>();
  for (const group of input.groups) {
    if (!GroupLocalIdSchema.safeParse(group.groupId).success) {
      throw runtimeError(`group ${group.groupId} ID is invalid`);
    }
    if (!Number.isSafeInteger(group.renderedTokenBudget) || group.renderedTokenBudget < 1) {
      throw runtimeError(`group ${group.groupId} budget is invalid`);
    }
    if (group.candidateIds.length === 0) throw runtimeError("groups must not be empty");
    if (new Set(group.candidateIds).size !== group.candidateIds.length) {
      throw runtimeError(`group ${group.groupId} candidate IDs must be unique`);
    }
    if (group.mode !== "normal" && group.mode !== "source_tool") {
      throw runtimeError(`group ${group.groupId} mode is invalid`);
    }
    if (group.mode === "source_tool" && group.candidateIds.length !== 1) {
      throw runtimeError(`source-tool group ${group.groupId} must have one candidate`);
    }
    for (const candidateId of group.candidateIds) {
      if (
        !CandidateLocalIdSchema.safeParse(candidateId as unknown).success ||
        !ledgerIds.has(candidateId)
      ) {
        throw runtimeError(`group ${group.groupId} names an unknown candidate ${candidateId}`);
      }
      if (assignedIds.has(candidateId)) {
        throw runtimeError(`candidate ${candidateId} appears in multiple groups`);
      }
      assignedIds.add(candidateId);
    }
  }
};

const indexForCandidate = (
  candidate: CandidateLedgerEntry,
  options: PassageIndexOptions,
): PassageIndex => buildCandidatePassageIndex(candidate, options);

const candidatePassageViews = (
  candidate: CandidateLedgerEntry,
  index: PassageIndex,
): readonly PassageView[] => {
  const authorized = candidate.baseRanges;
  return index.passages
    .filter(
      (passage) =>
        authorized.length === 0 ||
        authorized.some(
          (range) =>
            passage.range.charStart >= range.charStart && passage.range.charEnd <= range.charEnd,
        ),
    )
    .map((passage) => ({ passageId: passage.passageId, text: passage.text }));
};

const providerCandidate = (
  candidate: CandidateLedgerEntry,
  options: PassageIndexOptions,
): { readonly candidate: CompactionGroupCandidate; readonly index: PassageIndex } => {
  const index = indexForCandidate(candidate, options);
  return {
    index,
    candidate: {
      candidateId: candidate.candidateId,
      kind: candidate.kind,
      label: candidate.provenance.label,
      purpose: candidate.provenance.purpose,
      date: candidate.provenance.date,
      passages: candidatePassageViews(candidate, index),
    },
  };
};

const priorResultForGroup = (
  group: CompactionGroup,
  priorResults: readonly GroupResultEnvelope[] | undefined,
): GroupCompactionResult | undefined => {
  const envelope = priorResults?.find((candidate) => candidate.groupId === group.groupId);
  if (envelope === undefined) return undefined;
  const members = new Set(group.candidateIds);
  return {
    decisions: envelope.result.decisions.filter((decision) => members.has(decision.candidateId)),
  };
};

const exactGroupMeasure = (
  group: CompactionGroup,
  result: GroupCompactionResult,
  entries: readonly CandidateLedgerEntry[],
  options: PassageIndexOptions,
  costOptions: CompactionCostOptions | undefined,
): number => {
  const sources = group.candidateIds.flatMap((candidateId) => {
    const decision = result.decisions.find((item) => item.candidateId === candidateId);
    if (decision === undefined || decision.action === "omit") return [];
    const candidate = entries.find((item) => item.candidateId === candidateId);
    if (candidate === undefined) throw runtimeError(`unknown group candidate ${candidateId}`);
    const index = indexForCandidate(candidate, options);
    const ranges = mapPassageIdsToRanges(index, decision.passageIds);
    return [
      {
        candidateId,
        text: selectedTextFromRanges(index.text, ranges),
        passageIds: [...decision.passageIds],
        ranges,
      },
    ];
  });
  const count =
    costOptions?.countRenderedTokens === undefined
      ? sources.reduce((total, source) => total + options.countTokens(source.text), 0)
      : costOptions.countRenderedTokens(sources, group.candidateIds);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw runtimeError(`group ${group.groupId} measurement is invalid`);
  }
  return count;
};

const normalizedMeasure = (value: ExactContextMeasurement): ExactContextMeasurement => {
  if (
    typeof value.fits !== "boolean" ||
    !Number.isSafeInteger(value.inputTokens) ||
    value.inputTokens < 0 ||
    !Number.isSafeInteger(value.usableInputTokens) ||
    value.usableInputTokens < 0 ||
    !Number.isSafeInteger(value.overByTokens) ||
    value.overByTokens < 0
  ) {
    throw runtimeError("exact measurement is invalid");
  }
  return value;
};

const validateResultEffect = (
  value: unknown,
  group: CompactionGroup,
  ledger: Ledger,
  options: PassageIndexOptions,
  priorResult: GroupCompactionResult | undefined,
  tightenCandidateIds: readonly string[] | undefined,
): Effect.Effect<GroupCompactionResult, Error> =>
  Effect.try({
    try: () => {
      const result = validateGroupCompactionResult(value, group, ledger, options);
      if (priorResult === undefined) return result;
      const priorByCandidate = new Map(
        priorResult.decisions.map((decision) => [decision.candidateId, decision]),
      );
      const tighten = new Set(tightenCandidateIds ?? []);
      for (const decision of result.decisions) {
        const previous = priorByCandidate.get(decision.candidateId);
        if (previous === undefined) {
          throw runtimeError(`fallback group ${group.groupId} changed membership`);
        }
        if (!tighten.has(decision.candidateId)) {
          if (
            previous.action !== decision.action ||
            (previous.action === "select" &&
              decision.action === "select" &&
              previous.passageIds.join("\u0000") !== decision.passageIds.join("\u0000"))
          ) {
            throw runtimeError(`fallback retain changed ${decision.candidateId}`);
          }
          continue;
        }
        if (previous.action !== "select" || decision.action !== "select") {
          throw runtimeError(`fallback tighten must retain a selected prior result`);
        }
        const previousIds = new Set(previous.passageIds);
        const nextIds = new Set(decision.passageIds);
        if (
          nextIds.size >= previousIds.size ||
          [...nextIds].some((passageId) => !previousIds.has(passageId))
        ) {
          throw runtimeError(`fallback tighten must select a strict prior subset`);
        }
      }
      return result;
    },
    catch: (error) => (error instanceof Error ? error : runtimeError(String(error))),
  });

const runCompactionGroup = <R>(
  input: CompactionPassInput,
  deps: CompactionRuntimeDependencies<R>,
  group: CompactionGroup,
  ordinal: number,
  repairRef: Ref.Ref<boolean>,
): RuntimeEffect<GroupResultEnvelope, R> =>
  Effect.gen(function* () {
    const entries = ledgerEntries(input.ledger);
    const members = group.candidateIds.map((candidateId) => {
      const candidate = entries.find((item) => item.candidateId === candidateId);
      if (candidate === undefined) throw runtimeError(`unknown group candidate ${candidateId}`);
      return providerCandidate(candidate, input.passageOptions);
    });
    const taskId = compactionGroupTaskId(deps.taskPrefix ?? "single", input.phase, ordinal);
    const priorResult = priorResultForGroup(group, input.priorResults);
    const tightenCandidateIds = input.tightenCandidateIds?.get(group.groupId);
    const request: NormalCompactionRequest | SourceToolCompactionRequest =
      group.mode === "source_tool"
        ? {
            taskId,
            phase: input.phase,
            question: input.question,
            group,
            candidate: members[0]!.candidate,
            ...(priorResult === undefined ? {} : { priorResult }),
          }
        : {
            taskId,
            phase: input.phase,
            question: input.question,
            group,
            candidates: members.map((member) => member.candidate),
            ...(priorResult === undefined ? {} : { priorResult }),
          };
    const invoke =
      group.mode === "source_tool"
        ? deps.runSourceToolGroup(request as SourceToolCompactionRequest)
        : deps.runNormalGroup(request as NormalCompactionRequest);
    const initial = yield* invoke;
    const validated = yield* validateResultEffect(
      initial,
      group,
      input.ledger,
      input.passageOptions,
      priorResult,
      tightenCandidateIds,
    ).pipe(
      Effect.catchEager((error) =>
        Effect.gen(function* () {
          const claimed = yield* Ref.modify(repairRef, (used) => [!used, true] as const);
          if (!claimed || deps.repairGroupResult === undefined) return yield* Effect.fail(error);
          const repaired = yield* deps.repairGroupResult({
            taskId,
            phase: input.phase,
            group,
            invalidResult: initial,
            error,
            request,
          });
          return yield* validateResultEffect(
            repaired,
            group,
            input.ledger,
            input.passageOptions,
            priorResult,
            tightenCandidateIds,
          );
        }),
      ),
    );
    const renderedTokenCount = yield* Effect.try({
      try: () =>
        exactGroupMeasure(group, validated, entries, input.passageOptions, deps.costOptions),
      catch: (error) => (error instanceof Error ? error : runtimeError(String(error))),
    });
    if (!Number.isSafeInteger(renderedTokenCount) || renderedTokenCount < 0) {
      return yield* Effect.fail(runtimeError(`group ${group.groupId} measurement is invalid`));
    }
    if (renderedTokenCount > group.renderedTokenBudget) {
      return yield* Effect.fail(
        runtimeError(`group ${group.groupId} result exceeds its rendered token budget`),
      );
    }
    return {
      groupId: group.groupId,
      result: validated,
      renderedTokenCount,
    } satisfies GroupResultEnvelope;
  });

const runCompactionPassInternal = <R>(
  input: CompactionPassInput,
  deps: CompactionRuntimeDependencies<R>,
  repairRef: Ref.Ref<boolean>,
): RuntimeEffect<CompactionPassResult, R> =>
  Effect.gen(function* () {
    yield* Effect.try({ try: () => validatePassInput(input), catch: (error) => error });
    const outputs = yield* Effect.all(
      input.groups.map((group, index) =>
        runCompactionGroup(input, deps, group, index + 1, repairRef),
      ),
      { concurrency: input.concurrency },
    );
    const envelopes = input.groups.map(
      (group) => outputs.find((output) => output.groupId === group.groupId)!,
    );
    const selections = yield* Effect.try({
      try: () =>
        mergeGroupCompactionResults(
          input.ledger,
          input.groups,
          envelopes,
          input.passageOptions,
          deps.costOptions,
        ),
      catch: (error) => (error instanceof Error ? error : runtimeError(String(error))),
    });
    const repairUsed = yield* Ref.get(repairRef);
    return {
      phase: input.phase,
      groups: input.groups,
      taskIds: input.groups.map((_, index) =>
        compactionGroupTaskId(deps.taskPrefix ?? "single", input.phase, index + 1),
      ),
      envelopes,
      selections,
      repairUsed,
    } satisfies CompactionPassResult;
  });

export const runCompactionPass = <R = never>(
  input: CompactionPassInput,
  deps: CompactionRuntimeDependencies<R>,
): RuntimeEffect<CompactionPassResult, R> =>
  Effect.gen(function* () {
    const repairRef = yield* Ref.make(false);
    return yield* runCompactionPassInternal(input, deps, repairRef);
  });

const selectionsFromInitial = (
  manifest: InitialContextManifest,
  pass: CompactionPassResult,
  ledger: Ledger,
): readonly CompactionSelection[] => {
  const grouped = new Map(pass.selections.map((selection) => [selection.candidateId, selection]));
  const decisions = new Map(manifest.decisions.map((decision) => [decision.candidateId, decision]));
  return ledgerEntries(ledger).map((candidate) => {
    const decision = decisions.get(candidate.candidateId);
    if (decision === undefined)
      throw runtimeError(`missing manifest decision ${candidate.candidateId}`);
    if (decision.action === "compact") {
      const selection = grouped.get(decision.candidateId);
      if (selection === undefined)
        throw runtimeError(`missing first-pass selection ${decision.candidateId}`);
      return selection;
    }
    return {
      candidateId: decision.candidateId,
      action: decision.action,
      passageIds: [],
      ranges: [],
    } satisfies CompactionSelection;
  });
};

const fallbackGroups = (
  manifest: FallbackContextManifest,
  initialGroups: readonly CompactionGroup[],
  eligible: ReadonlySet<string>,
): readonly CompactionGroup[] => {
  const initialGroupByCandidate = new Map<string, string>(
    initialGroups.flatMap((group) =>
      group.candidateIds.map((candidateId) => [candidateId, group.groupId] as const),
    ),
  );
  return manifest.groups.flatMap((declared) => {
    const members = manifest.decisions
      .filter((decision) => {
        if (decision.action === "compact" || decision.action === "tighten") {
          return decision.groupId === declared.groupId;
        }
        if (decision.action === "retain") {
          return initialGroupByCandidate.get(decision.candidateId) === declared.groupId;
        }
        return false;
      })
      .map((decision) => decision.candidateId);
    const changed = manifest.decisions.some(
      (decision) =>
        (decision.action === "compact" || decision.action === "tighten") &&
        decision.groupId === declared.groupId,
    );
    if (!changed) return [];
    const mode = members.length === 1 && eligible.has(members[0]!) ? "source_tool" : "normal";
    return [
      {
        groupId: declared.groupId,
        candidateIds: members,
        renderedTokenBudget: declared.renderedTokenBudget,
        mode,
      } satisfies CompactionGroup,
    ];
  });
};

const selectionsFromFallback = (
  manifest: FallbackContextManifest,
  initial: readonly CompactionSelection[],
  fallback: CompactionPassResult,
  ledger: Ledger,
): readonly CompactionSelection[] => {
  const previous = new Map(initial.map((selection) => [selection.candidateId, selection]));
  const changed = new Map(
    fallback.selections.map((selection) => [selection.candidateId, selection]),
  );
  const decisions = new Map(manifest.decisions.map((decision) => [decision.candidateId, decision]));
  return ledgerEntries(ledger).map((candidate) => {
    const decision = decisions.get(candidate.candidateId);
    if (decision === undefined)
      throw runtimeError(`missing fallback decision ${candidate.candidateId}`);
    if (decision.action === "omit") {
      return {
        candidateId: decision.candidateId,
        action: "omit" as const,
        passageIds: [],
        ranges: [],
      };
    }
    if (decision.action === "retain") {
      const selection = previous.get(decision.candidateId);
      if (selection === undefined)
        throw runtimeError(`missing retained selection ${decision.candidateId}`);
      return selection;
    }
    const selection = changed.get(decision.candidateId);
    if (selection === undefined)
      throw runtimeError(`missing fallback selection ${decision.candidateId}`);
    return selection;
  });
};
const canonicalFallbackArtifacts = (
  ledger: Ledger,
  initialGroups: readonly CompactionGroup[],
  initialEnvelopes: readonly GroupResultEnvelope[],
  fallbackGroupsToRun: readonly CompactionGroup[],
  fallbackEnvelopes: readonly GroupResultEnvelope[],
): {
  readonly groups: readonly CompactionGroup[];
  readonly envelopes: readonly GroupResultEnvelope[];
} => {
  const initialGroupById = new Map(initialGroups.map((group) => [group.groupId, group]));
  const fallbackGroupById = new Map(fallbackGroupsToRun.map((group) => [group.groupId, group]));
  const initialEnvelopeById = new Map(
    initialEnvelopes.map((envelope) => [envelope.groupId, envelope]),
  );
  const fallbackEnvelopeById = new Map(
    fallbackEnvelopes.map((envelope) => [envelope.groupId, envelope]),
  );
  const ids = [
    ...new Set([
      ...initialGroups.map((group) => group.groupId),
      ...fallbackGroupsToRun.map((group) => group.groupId),
    ]),
  ];
  const ledgerPosition = new Map<string, number>(
    ledgerEntries(ledger).map((candidate, index) => [candidate.candidateId, index]),
  );
  const firstPosition = (groupId: string): number =>
    Math.min(
      ...(
        fallbackGroupById.get(groupId)?.candidateIds ??
        initialGroupById.get(groupId)?.candidateIds ??
        []
      ).map((candidateId) => ledgerPosition.get(candidateId) ?? Number.MAX_SAFE_INTEGER),
    );
  ids.sort((left, right) => firstPosition(left) - firstPosition(right));
  const groups = ids.map((groupId) => {
    const group = fallbackGroupById.get(groupId) ?? initialGroupById.get(groupId);
    if (group === undefined) throw runtimeError(`missing final group ${groupId}`);
    return group;
  });
  const envelopes = ids.map((groupId) => {
    const envelope = fallbackEnvelopeById.get(groupId) ?? initialEnvelopeById.get(groupId);
    if (envelope === undefined) throw runtimeError(`missing final envelope ${groupId}`);
    return envelope;
  });
  return { groups, envelopes };
};

const contextState = (
  phase: CompactionPhase,
  input: CompactionRuntimeInput,
  selections: readonly CompactionSelection[],
  groups: readonly CompactionGroup[],
  envelopes: readonly GroupResultEnvelope[],
): CompactionContextState => ({
  phase,
  question: input.question,
  ledger: input.ledger,
  selections,
  groups,
  envelopes,
});

export const runCompaction = <R = never>(
  input: CompactionRuntimeInput,
  deps: CompactionRuntimeDependencies<R>,
): RuntimeEffect<CompactionRuntimeResult, R> =>
  Effect.gen(function* () {
    const repairRef = yield* Ref.make(false);
    const runtimeDeps =
      deps.taskPrefix === undefined && input.taskPrefix !== undefined
        ? { ...deps, taskPrefix: input.taskPrefix }
        : deps;
    const groups = yield* Effect.try({
      try: () =>
        createCompactionGroups(input.initialManifest, input.ledger, {
          sourceToolEligibleCandidateIds: input.sourceToolEligibleCandidateIds,
          remainingAnswerTokens: input.remainingAnswerTokens,
          passageOptions: input.passageOptions,
          costOptions: deps.costOptions,
        }),
      catch: (error) => (error instanceof Error ? error : runtimeError(String(error))),
    });
    const firstPass = yield* runCompactionPassInternal(
      {
        phase: "compact",
        question: input.question,
        ledger: input.ledger,
        groups,
        passageOptions: input.passageOptions,
        concurrency: input.concurrency,
      },
      runtimeDeps,
      repairRef,
    );
    const initialSelections = selectionsFromInitial(input.initialManifest, firstPass, input.ledger);
    const initialState = contextState(
      "compact",
      input,
      initialSelections,
      groups,
      firstPass.envelopes,
    );
    const initialMeasurement = yield* deps.measureContext(initialState).pipe(
      Effect.flatMap((measurement) =>
        Effect.try({
          try: () => normalizedMeasure(measurement),
          catch: (error) => (error instanceof Error ? error : runtimeError(String(error))),
        }),
      ),
    );
    if (initialMeasurement.fits || deps.planFallback === undefined) {
      const repairUsed = yield* Ref.get(repairRef);
      return {
        status: initialMeasurement.fits ? "ready" : "context_plan_unfit",
        context: initialState,
        measurement: initialMeasurement,
        fallbackRan: false,
        repairUsed,
      } satisfies CompactionRuntimeResult;
    }
    const fallbackManifestValue = yield* deps.planFallback({
      taskId: `${deps.taskPrefix ?? input.taskPrefix ?? "single"}-fallback-plan`,
      question: input.question,
      ledger: input.ledger,
      initialManifest: input.initialManifest,
      firstPass,
      state: initialState,
      measurement: initialMeasurement,
    });
    const fallbackManifest = yield* Effect.try({
      try: () =>
        validateFallbackContextManifest(
          fallbackManifestValue,
          input.initialManifest,
          input.ledger,
          firstPass.envelopes,
          input.passageOptions,
          deps.costOptions,
        ),
      catch: (error) => (error instanceof Error ? error : runtimeError(String(error))),
    });
    const fallbackGroupsToRun = fallbackGroups(
      fallbackManifest,
      groups,
      new Set(input.sourceToolEligibleCandidateIds),
    );
    const tightenCandidateIds = new Map(
      fallbackGroupsToRun.map((group) => [
        group.groupId,
        fallbackManifest.decisions
          .filter((decision) => decision.action === "tighten" && decision.groupId === group.groupId)
          .map((decision) => decision.candidateId),
      ]),
    );
    const fallbackPass = yield* runCompactionPassInternal(
      {
        phase: "fallback",
        question: input.question,
        ledger: input.ledger,
        groups: fallbackGroupsToRun,
        passageOptions: input.passageOptions,
        concurrency: input.concurrency,
        priorResults: firstPass.envelopes,
        tightenCandidateIds,
      },
      runtimeDeps,
      repairRef,
    );
    const fallbackSelections = selectionsFromFallback(
      fallbackManifest,
      initialSelections,
      fallbackPass,
      input.ledger,
    );
    const finalArtifacts = canonicalFallbackArtifacts(
      input.ledger,
      groups,
      firstPass.envelopes,
      fallbackGroupsToRun,
      fallbackPass.envelopes,
    );
    const fallbackState = contextState(
      "fallback",
      input,
      fallbackSelections,
      finalArtifacts.groups,
      finalArtifacts.envelopes,
    );
    const finalMeasurement = yield* deps.measureContext(fallbackState).pipe(
      Effect.flatMap((measurement) =>
        Effect.try({
          try: () => normalizedMeasure(measurement),
          catch: (error) => (error instanceof Error ? error : runtimeError(String(error))),
        }),
      ),
    );
    const repairUsed = yield* Ref.get(repairRef);
    return {
      status: finalMeasurement.fits ? "ready" : "context_plan_unfit",
      context: fallbackState,
      measurement: finalMeasurement,
      fallbackRan: true,
      repairUsed,
    } satisfies CompactionRuntimeResult;
  });
