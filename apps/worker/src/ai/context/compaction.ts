import { z } from "zod";

import {
  CandidateLocalIdSchema,
  GroupLocalIdSchema,
  PassageLocalIdSchema,
  isWellFormedUtf16,
} from "../workflow/types";
import type { CandidateLedger, CandidateLedgerEntry, SourceRange } from "../workflow/types";
import { CandidateLedgerSchema } from "../workflow/types";
import {
  buildPassageIndex,
  mapPassageIdsToRanges,
  rangesSubsetOf,
  selectedTextFromRanges,
  type PassageIndexOptions,
} from "./passages";

const localId = (prefix: string) =>
  prefix === "c"
    ? CandidateLocalIdSchema
    : prefix === "g"
      ? GroupLocalIdSchema
      : PassageLocalIdSchema;
const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isWellFormedUtf16, "reason must be well-formed UTF-16")
  .refine((value) => new TextEncoder().encode(value).byteLength <= 4096, "reason is too large");
const positiveInt = z.number().int().finite().safe().positive();

export const MAX_COMPACTION_GROUPS = 999;

export type InitialContextDecision =
  | { readonly candidateId: string; readonly action: "keep"; readonly reason: string }
  | {
      readonly candidateId: string;
      readonly action: "compact";
      readonly groupId: string;
      readonly reason: string;
    }
  | { readonly candidateId: string; readonly action: "omit"; readonly reason: string };

export interface InitialContextManifest {
  readonly decisions: readonly InitialContextDecision[];
  readonly groups: readonly { readonly groupId: string; readonly renderedTokenBudget: number }[];
}

export type FallbackContextDecision =
  | { readonly candidateId: string; readonly action: "retain"; readonly reason: string }
  | {
      readonly candidateId: string;
      readonly action: "compact";
      readonly groupId: string;
      readonly reason: string;
    }
  | {
      readonly candidateId: string;
      readonly action: "tighten";
      readonly groupId: string;
      readonly reason: string;
    }
  | { readonly candidateId: string; readonly action: "omit"; readonly reason: string };

export interface FallbackContextManifest {
  readonly decisions: readonly FallbackContextDecision[];
  readonly groups: readonly { readonly groupId: string; readonly renderedTokenBudget: number }[];
}

export type CompactionGroupMode = "normal" | "source_tool";

export interface CompactionGroup {
  readonly groupId: string;
  readonly candidateIds: readonly string[];
  readonly renderedTokenBudget: number;
  readonly mode: CompactionGroupMode;
}
export interface RenderedGroupSource {
  readonly candidateId: string;
  readonly text: string;
  readonly passageIds: readonly string[];
  readonly ranges: readonly SourceRange[];
}

export interface CompactionGroupMeasurement {
  /** Exact input count for the normal compactor request. */
  readonly inputTokens: number;
  /** Fast-model input allowance for the normal compactor request. */
  readonly usableInputTokens: number;
  /** Exact answer-source cost of the smallest selectable passage. */
  readonly minimumSelectablePassageCost: number;
}

export type CompactionGroupMeasurements =
  | ReadonlyMap<string, CompactionGroupMeasurement>
  | Readonly<Record<string, CompactionGroupMeasurement>>;

export interface CompactionCostOptions {
  /**
   * Count the exact replacement marginal for a group in the canonical answer
   * request. The second argument contains every candidate replaced by the
   * group, including members omitted by the proposed result.
   */
  readonly countRenderedTokens?: (
    sources: readonly RenderedGroupSource[],
    replacedCandidateIds?: readonly string[],
  ) => number;
  readonly groupMeasurements?: CompactionGroupMeasurements | undefined;
}

const asGroupMeasurement = (
  measurements: CompactionGroupMeasurements | undefined,
  groupId: string,
): CompactionGroupMeasurement | undefined => {
  if (measurements === undefined) return undefined;
  if (typeof (measurements as ReadonlyMap<string, CompactionGroupMeasurement>).get === "function") {
    return (measurements as ReadonlyMap<string, CompactionGroupMeasurement>).get(groupId);
  }
  return (measurements as Readonly<Record<string, CompactionGroupMeasurement>>)[groupId];
};

const assertMeasuredCount = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CompactionContractError(`${label} must be a non-negative safe integer`);
  }
  return value;
};

export type GroupSelection =
  | {
      readonly candidateId: string;
      readonly action: "select";
      readonly passageIds: readonly string[];
      readonly reason: string;
    }
  | { readonly candidateId: string; readonly action: "omit"; readonly reason: string };

export interface GroupCompactionResult {
  readonly decisions: readonly GroupSelection[];
}

export interface GroupResultEnvelope {
  readonly groupId: string;
  readonly result: GroupCompactionResult;
  readonly renderedTokenCount: number;
}

export const GroupResultEnvelopeSchema = z.strictObject({
  groupId: localId("g"),
  result: z.lazy(() => GroupCompactionResultSchema),
  renderedTokenCount: z.number().int().finite().safe().min(0),
});

export interface CompactionSelection {
  readonly candidateId: string;
  readonly action: "keep" | "range" | "omit";
  readonly groupId?: string | undefined;
  readonly passageIds: readonly string[];
  readonly ranges: readonly SourceRange[];
}

export const InitialContextManifestSchema = z
  .strictObject({
    decisions: z.array(
      z.discriminatedUnion("action", [
        z.strictObject({
          candidateId: localId("c"),
          action: z.literal("keep"),
          reason: reasonSchema,
        }),
        z.strictObject({
          candidateId: localId("c"),
          action: z.literal("compact"),
          groupId: localId("g"),
          reason: reasonSchema,
        }),
        z.strictObject({
          candidateId: localId("c"),
          action: z.literal("omit"),
          reason: reasonSchema,
        }),
      ]),
    ),
    groups: z.array(z.strictObject({ groupId: localId("g"), renderedTokenBudget: positiveInt })),
  })
  .superRefine((manifest, context) => {
    const decisionIds = manifest.decisions.map((decision) => decision.candidateId);
    if (new Set(decisionIds).size !== decisionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["decisions"],
        message: "every candidate must appear once",
      });
    }
    const groupIds = manifest.groups.map((group) => group.groupId);
    if (new Set(groupIds).size !== groupIds.length) {
      context.addIssue({ code: "custom", path: ["groups"], message: "group IDs must be unique" });
    }
    const used = new Set(
      manifest.decisions.flatMap((decision) =>
        decision.action === "compact" ? [decision.groupId] : [],
      ),
    );
    for (const decision of manifest.decisions) {
      if (decision.action === "compact" && !groupIds.includes(decision.groupId)) {
        context.addIssue({
          code: "custom",
          path: ["decisions"],
          message: `group ${decision.groupId} is not declared`,
        });
      }
    }
    for (const groupId of groupIds) {
      if (!used.has(groupId))
        context.addIssue({
          code: "custom",
          path: ["groups"],
          message: `group ${groupId} is unused`,
        });
    }
    for (const decision of manifest.decisions) {
      if (decision.action === "compact" && decision.groupId.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["decisions"],
          message: "compact decision needs a group",
        });
      }
    }
  });

export const FallbackContextManifestSchema = z
  .strictObject({
    decisions: z.array(
      z.discriminatedUnion("action", [
        z.strictObject({
          candidateId: localId("c"),
          action: z.literal("retain"),
          reason: reasonSchema,
        }),
        z.strictObject({
          candidateId: localId("c"),
          action: z.literal("compact"),
          groupId: localId("g"),
          reason: reasonSchema,
        }),
        z.strictObject({
          candidateId: localId("c"),
          action: z.literal("tighten"),
          groupId: localId("g"),
          reason: reasonSchema,
        }),
        z.strictObject({
          candidateId: localId("c"),
          action: z.literal("omit"),
          reason: reasonSchema,
        }),
      ]),
    ),
    groups: z.array(z.strictObject({ groupId: localId("g"), renderedTokenBudget: positiveInt })),
  })
  .superRefine((manifest, context) => {
    const ids = manifest.decisions.map((decision) => decision.candidateId);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        path: ["decisions"],
        message: "every candidate must appear once",
      });
    const groupIds = manifest.groups.map((group) => group.groupId);
    if (new Set(groupIds).size !== groupIds.length)
      context.addIssue({ code: "custom", path: ["groups"], message: "group IDs must be unique" });
    const used = new Set(
      manifest.decisions.flatMap((decision) => ("groupId" in decision ? [decision.groupId] : [])),
    );
    for (const decision of manifest.decisions) {
      if (
        (decision.action === "compact" || decision.action === "tighten") &&
        !groupIds.includes(decision.groupId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["decisions"],
          message: `group ${decision.groupId} is not declared`,
        });
      }
    }
    for (const groupId of groupIds) {
      if (!used.has(groupId))
        context.addIssue({
          code: "custom",
          path: ["groups"],
          message: `group ${groupId} is unused`,
        });
    }
  });

const selectionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    candidateId: localId("c"),
    action: z.literal("select"),
    passageIds: z.array(localId("p")).min(1),
    reason: reasonSchema,
  }),
  z.strictObject({ candidateId: localId("c"), action: z.literal("omit"), reason: reasonSchema }),
]);

export const GroupCompactionResultSchema = z
  .strictObject({ decisions: z.array(selectionSchema) })
  .superRefine((result, context) => {
    const selected = result.decisions.map((decision) => decision.candidateId);
    if (new Set(selected).size !== selected.length) {
      context.addIssue({
        code: "custom",
        path: ["decisions"],
        message: "group candidate IDs must be unique",
      });
    }
    for (const [index, decision] of result.decisions.entries()) {
      if (
        decision.action === "select" &&
        new Set(decision.passageIds).size !== decision.passageIds.length
      ) {
        context.addIssue({
          code: "custom",
          path: ["decisions", index, "passageIds"],
          message: "passage IDs must be unique",
        });
      }
    }
  });

export class CompactionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionContractError";
  }
}

type LedgerInput = CandidateLedger | readonly CandidateLedgerEntry[];

const ledgerEntries = (ledger: LedgerInput): readonly CandidateLedgerEntry[] => {
  const parsed = CandidateLedgerSchema.safeParse(
    "candidates" in ledger ? ledger : { candidates: ledger },
  );
  if (!parsed.success) {
    throw new CompactionContractError(`candidate ledger is invalid: ${parsed.error.message}`);
  }
  return parsed.data.candidates as readonly CandidateLedgerEntry[];
};

const candidateMap = (ledger: LedgerInput): Map<string, CandidateLedgerEntry> =>
  new Map(ledgerEntries(ledger).map((candidate) => [candidate.candidateId, candidate]));

const renderedGroupSources = (
  result: GroupCompactionResult,
  group: CompactionGroup,
  ledger: LedgerInput,
  passageOptions: PassageIndexOptions,
): readonly RenderedGroupSource[] => {
  const candidates = candidateMap(ledger);
  const decisions = new Map(result.decisions.map((decision) => [decision.candidateId, decision]));
  return group.candidateIds.flatMap((candidateId) => {
    const decision = decisions.get(candidateId);
    if (decision === undefined || decision.action === "omit") return [];
    const candidate = candidates.get(candidateId);
    if (candidate === undefined) {
      throw new CompactionContractError(`unknown candidate ${candidateId}`);
    }
    const index = buildCandidatePassageIndex(candidate, passageOptions);
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
};

const exactGroupRenderedTokenCount = (
  result: GroupCompactionResult,
  group: CompactionGroup,
  ledger: LedgerInput,
  passageOptions: PassageIndexOptions,
  costOptions: CompactionCostOptions | undefined,
): number => {
  const sources = renderedGroupSources(result, group, ledger, passageOptions);
  const count =
    costOptions?.countRenderedTokens === undefined
      ? sources.reduce((total, source) => total + passageOptions.countTokens(source.text), 0)
      : costOptions.countRenderedTokens(sources, group.candidateIds);
  return assertMeasuredCount(count, `group ${group.groupId} rendered token count`);
};
const renderedPassageCost = (
  candidateId: string,
  passageId: string,
  text: string,
  range: SourceRange,
  passageOptions: PassageIndexOptions,
  costOptions: CompactionCostOptions | undefined,
  replacedCandidateIds: readonly string[],
): number => {
  const count =
    costOptions?.countRenderedTokens === undefined
      ? passageOptions.countTokens(text)
      : costOptions.countRenderedTokens(
          [{ candidateId, text, passageIds: [passageId], ranges: [range] }],
          replacedCandidateIds,
        );
  return assertMeasuredCount(count, `passage ${passageId} rendered token count`);
};

const minimumSelectablePassageCost = (
  candidate: CandidateLedgerEntry,
  passageOptions: PassageIndexOptions,
  costOptions: CompactionCostOptions | undefined,
  replacedCandidateIds: readonly string[],
): number => {
  const index = buildCandidatePassageIndex(candidate, passageOptions);
  const costs = index.passages.map((passage) =>
    renderedPassageCost(
      candidate.candidateId,
      passage.passageId,
      passage.text,
      passage.range,
      passageOptions,
      costOptions,
      replacedCandidateIds,
    ),
  );
  if (costs.length === 0) {
    throw new CompactionContractError(
      `candidate ${candidate.candidateId} has no selectable authorized passages`,
    );
  }
  return Math.min(...costs);
};

const groupMembersInLedgerOrder = (
  groupCandidateIds: readonly string[],
  ledger: LedgerInput,
): readonly string[] => {
  const members = new Set(groupCandidateIds);
  return ledgerEntries(ledger)
    .map((candidate) => candidate.candidateId)
    .filter((candidateId) => members.has(candidateId));
};

export const buildCandidatePassageIndex = (
  candidate: CandidateLedgerEntry,
  options: PassageIndexOptions,
) => {
  if (options.stripCitations === true) {
    throw new CompactionContractError(
      "candidate passage indexing requires ledger-sanitized text coordinates",
    );
  }
  return buildPassageIndex(candidate.text, {
    ...options,
    authorizedRanges: candidate.baseRanges,
  });
};

const parseOrThrow = <T>(schema: z.ZodType<T>, value: unknown, label: string): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new CompactionContractError(`${label} is invalid: ${parsed.error.message}`);
  return parsed.data;
};

export const validateInitialContextManifest = (
  value: unknown,
  ledger: LedgerInput,
  passageOptions?: PassageIndexOptions,
  costOptions?: CompactionCostOptions,
): InitialContextManifest => {
  const manifest = parseOrThrow(InitialContextManifestSchema, value, "initial context manifest");
  if (manifest.groups.length > MAX_COMPACTION_GROUPS) {
    throw new CompactionContractError(
      `initial context manifest has more than ${MAX_COMPACTION_GROUPS} groups`,
    );
  }
  const candidates = candidateMap(ledger);
  const ids = manifest.decisions.map((decision) => decision.candidateId);
  if (ids.length !== candidates.size || ids.some((id) => !candidates.has(id))) {
    throw new CompactionContractError(
      "initial manifest must account for every ledger candidate exactly once",
    );
  }
  for (const decision of manifest.decisions) {
    const candidate = candidates.get(decision.candidateId)!;
    if (decision.action !== "compact") continue;
    if (candidate.kind !== "document" && candidate.kind !== "chat_message") {
      throw new CompactionContractError(`candidate ${decision.candidateId} cannot be compacted`);
    }
    if (candidate.baseRanges.length === 0) {
      throw new CompactionContractError(
        `candidate ${decision.candidateId} has no authorized passages to compact`,
      );
    }
  }
  for (const group of manifest.groups) {
    const members = manifest.decisions.filter(
      (decision) => decision.action === "compact" && decision.groupId === group.groupId,
    );
    const wholeCost = members.reduce(
      (total, decision) => total + candidates.get(decision.candidateId)!.renderedTokenCount,
      0,
    );
    if (group.renderedTokenBudget >= wholeCost) {
      throw new CompactionContractError(
        `group ${group.groupId} budget must be below its whole cost`,
      );
    }
    const measured = asGroupMeasurement(costOptions?.groupMeasurements, group.groupId);
    if (measured !== undefined) {
      assertMeasuredCount(measured.minimumSelectablePassageCost, "minimum selectable passage cost");
      if (group.renderedTokenBudget < measured.minimumSelectablePassageCost) {
        throw new CompactionContractError(
          `group ${group.groupId} budget is below its measured smallest passage cost`,
        );
      }
    }
    if (passageOptions !== undefined) {
      const minimumCost = Math.min(
        ...members.map((decision) =>
          minimumSelectablePassageCost(
            candidates.get(decision.candidateId)!,
            passageOptions,
            costOptions,
            members.map((member) => member.candidateId),
          ),
        ),
      );
      if (group.renderedTokenBudget < minimumCost) {
        throw new CompactionContractError(
          `group ${group.groupId} budget is below its smallest selectable passage cost`,
        );
      }
      if (measured !== undefined && measured.minimumSelectablePassageCost !== minimumCost) {
        throw new CompactionContractError(
          `group ${group.groupId} minimum passage cost is not exact`,
        );
      }
    }
  }
  return manifest;
};

export const createCompactionGroups = (
  manifest: InitialContextManifest,
  ledger: LedgerInput,
  options: {
    readonly sourceToolEligibleCandidateIds: readonly string[];
    readonly remainingAnswerTokens?: number | undefined;
    readonly passageOptions?: PassageIndexOptions | undefined;
    readonly costOptions?: CompactionCostOptions | undefined;
    readonly groupMeasurements?: CompactionGroupMeasurements | undefined;
  },
): readonly CompactionGroup[] => {
  const costOptions =
    options.groupMeasurements === undefined
      ? options.costOptions
      : { ...options.costOptions, groupMeasurements: options.groupMeasurements };
  const validatedManifest = validateInitialContextManifest(
    manifest,
    ledger,
    options.passageOptions,
    costOptions,
  );
  const candidates = candidateMap(ledger);
  const eligible = new Set(options.sourceToolEligibleCandidateIds);
  if (eligible.size !== options.sourceToolEligibleCandidateIds.length) {
    throw new CompactionContractError("source-tool eligibility IDs must be unique");
  }
  const grouped = new Map<string, string[]>();
  for (const decision of validatedManifest.decisions) {
    if (decision.action !== "compact") continue;
    const members = grouped.get(decision.groupId) ?? [];
    members.push(decision.candidateId);
    grouped.set(decision.groupId, members);
  }
  for (const candidateId of eligible) {
    const candidate = candidates.get(candidateId);
    const groupsForCandidate = [...grouped.values()].filter((members) =>
      members.includes(candidateId),
    );
    if (
      candidate === undefined ||
      (candidate.kind !== "document" && candidate.kind !== "chat_message") ||
      groupsForCandidate.length !== 1 ||
      groupsForCandidate[0]!.length !== 1
    ) {
      throw new CompactionContractError(`invalid source-tool eligibility for ${candidateId}`);
    }
  }
  const groups = validatedManifest.groups.map((group) => {
    const candidateIds = groupMembersInLedgerOrder(grouped.get(group.groupId) ?? [], ledger);
    if (candidateIds.length === 0)
      throw new CompactionContractError(`group ${group.groupId} is empty`);
    const mode: CompactionGroupMode =
      candidateIds.length === 1 && eligible.has(candidateIds[0]!) ? "source_tool" : "normal";
    const wholeCost = candidateIds.reduce(
      (total, candidateId) => total + (candidates.get(candidateId)?.renderedTokenCount ?? 0),
      0,
    );
    if (group.renderedTokenBudget >= wholeCost)
      throw new CompactionContractError(
        `group ${group.groupId} budget must be below its whole cost`,
      );
    if (options.passageOptions !== undefined) {
      const minimumCost = Math.min(
        ...candidateIds.map((candidateId) =>
          minimumSelectablePassageCost(
            candidates.get(candidateId)!,
            options.passageOptions!,
            costOptions,
            candidateIds,
          ),
        ),
      );
      if (group.renderedTokenBudget < minimumCost) {
        throw new CompactionContractError(
          `group ${group.groupId} budget is below its smallest selectable passage cost`,
        );
      }
    }
    const measured = asGroupMeasurement(costOptions?.groupMeasurements, group.groupId);
    if (measured !== undefined && mode === "normal") {
      const inputTokens = assertMeasuredCount(
        measured.inputTokens,
        `group ${group.groupId} normal request input`,
      );
      const allowance = assertMeasuredCount(
        measured.usableInputTokens,
        `group ${group.groupId} normal request allowance`,
      );
      if (inputTokens > allowance) {
        throw new CompactionContractError(
          `normal group ${group.groupId} request does not fit its exact input allowance`,
        );
      }
    }
    return {
      groupId: group.groupId,
      candidateIds,
      renderedTokenBudget: group.renderedTokenBudget,
      mode,
    };
  });
  if (
    options.remainingAnswerTokens !== undefined &&
    (!Number.isSafeInteger(options.remainingAnswerTokens) || options.remainingAnswerTokens < 1)
  ) {
    throw new CompactionContractError("remaining answer budget must be a positive safe integer");
  }
  if (options.remainingAnswerTokens !== undefined) {
    const keptCost = validatedManifest.decisions.reduce((total, decision) => {
      if (decision.action !== "keep") return total;
      return total + (candidates.get(decision.candidateId)?.renderedTokenCount ?? 0);
    }, 0);
    const plannedCost =
      keptCost + groups.reduce((total, group) => total + group.renderedTokenBudget, 0);
    if (plannedCost > options.remainingAnswerTokens) {
      throw new CompactionContractError("manifest cannot fit the remaining answer budget");
    }
  }
  return groups.sort((left, right) => {
    const leftOrdinal = ledgerEntries(ledger).findIndex((candidate) =>
      left.candidateIds.includes(candidate.candidateId),
    );
    const rightOrdinal = ledgerEntries(ledger).findIndex((candidate) =>
      right.candidateIds.includes(candidate.candidateId),
    );
    return leftOrdinal - rightOrdinal;
  });
};

export const validateGroupCompactionResult = (
  value: unknown,
  group: CompactionGroup,
  ledger: LedgerInput,
  passageOptions: PassageIndexOptions,
): GroupCompactionResult => {
  if (
    !isFinite(group.renderedTokenBudget) ||
    !Number.isSafeInteger(group.renderedTokenBudget) ||
    group.renderedTokenBudget < 1 ||
    new Set(group.candidateIds).size !== group.candidateIds.length ||
    group.candidateIds.length === 0 ||
    (group.mode !== "normal" && group.mode !== "source_tool") ||
    (group.mode === "source_tool" && group.candidateIds.length !== 1)
  ) {
    throw new CompactionContractError("compaction group envelope is invalid");
  }
  const result = parseOrThrow(GroupCompactionResultSchema, value, "group compaction result");
  const decisionIds = result.decisions.map((decision) => decision.candidateId);
  if (
    decisionIds.length !== group.candidateIds.length ||
    new Set(decisionIds).size !== group.candidateIds.length ||
    decisionIds.some((id) => !group.candidateIds.includes(id))
  )
    throw new CompactionContractError("group membership changed");
  const candidates = candidateMap(ledger);
  const canonicalDecisions = result.decisions.map((selection) => {
    const candidate = candidates.get(selection.candidateId);
    if (candidate === undefined)
      throw new CompactionContractError(`unknown candidate ${selection.candidateId}`);
    if (selection.action === "select") {
      const index = buildCandidatePassageIndex(candidate, passageOptions);
      try {
        const ranges = mapPassageIdsToRanges(index, selection.passageIds);
        if (!rangesSubsetOf(index.text, ranges, candidate.baseRanges)) {
          throw new CompactionContractError(
            `candidate ${selection.candidateId} selection widens its base ranges`,
          );
        }
      } catch (error) {
        if (error instanceof CompactionContractError) throw error;
        throw new CompactionContractError(error instanceof Error ? error.message : String(error));
      }
    }
    if (selection.action === "omit") return selection;
    const index = buildCandidatePassageIndex(candidate, passageOptions);
    const byId = new Map<string, (typeof index.passages)[number]>(
      index.passages.map((passage) => [passage.passageId, passage]),
    );
    return {
      ...selection,
      passageIds: [...selection.passageIds].sort(
        (left, right) =>
          byId.get(left)!.range.charStart - byId.get(right)!.range.charStart ||
          byId.get(left)!.range.charEnd - byId.get(right)!.range.charEnd,
      ),
    };
  });
  return { decisions: canonicalDecisions };
};
export const validateGroupResultEnvelope = (
  value: unknown,
  group: CompactionGroup,
  ledger: LedgerInput,
  passageOptions: PassageIndexOptions,
  costOptions?: CompactionCostOptions,
): GroupResultEnvelope => {
  const envelope = parseOrThrow(GroupResultEnvelopeSchema, value, "group result envelope");
  if (envelope.groupId !== group.groupId) {
    throw new CompactionContractError("group result envelope has the wrong group ID");
  }
  const result = validateGroupCompactionResult(envelope.result, group, ledger, passageOptions);
  const renderedTokenCount = exactGroupRenderedTokenCount(
    result,
    group,
    ledger,
    passageOptions,
    costOptions,
  );
  if (envelope.renderedTokenCount !== renderedTokenCount) {
    throw new CompactionContractError(
      `group ${group.groupId} rendered token count is not an exact reconstruction`,
    );
  }
  if (renderedTokenCount > group.renderedTokenBudget) {
    throw new CompactionContractError(
      `group ${group.groupId} result exceeds its rendered token budget`,
    );
  }
  return { groupId: group.groupId, result, renderedTokenCount };
};

export const validateTightenedGroupCompactionResult = (
  value: unknown,
  group: CompactionGroup,
  ledger: LedgerInput,
  priorResult: GroupCompactionResult,
  passageOptions: PassageIndexOptions,
): GroupCompactionResult => {
  const result = validateGroupCompactionResult(value, group, ledger, passageOptions);
  const parsedPrior = parseOrThrow(
    GroupCompactionResultSchema,
    priorResult,
    "prior group compaction result",
  );
  const priorByCandidate = new Map(
    parsedPrior.decisions.map((decision) => [decision.candidateId, decision]),
  );
  for (const decision of result.decisions) {
    const prior = priorByCandidate.get(decision.candidateId);
    if (prior === undefined || prior.action !== "select") {
      throw new CompactionContractError(
        `tightening cannot restore omitted candidate ${decision.candidateId}`,
      );
    }
    if (decision.action === "omit") continue;
    const priorIds = new Set(prior.passageIds);
    const nextIds = new Set(decision.passageIds);
    if (
      nextIds.size >= priorIds.size ||
      [...nextIds].some((passageId) => !priorIds.has(passageId))
    ) {
      throw new CompactionContractError(
        `tightening ${decision.candidateId} must select a strict prior subset`,
      );
    }
  }
  return result;
};

const exactSelectedPassageCost = (
  candidate: CandidateLedgerEntry,
  passageIds: readonly string[],
  replacedCandidateIds: readonly string[],
  passageOptions: PassageIndexOptions,
  costOptions: CompactionCostOptions | undefined,
): number => {
  const index = buildCandidatePassageIndex(candidate, passageOptions);
  const ranges = mapPassageIdsToRanges(index, passageIds);
  const text = selectedTextFromRanges(index.text, ranges);
  const count =
    costOptions?.countRenderedTokens === undefined
      ? passageOptions.countTokens(text)
      : costOptions.countRenderedTokens(
          [{ candidateId: candidate.candidateId, text, passageIds, ranges }],
          replacedCandidateIds,
        );
  return assertMeasuredCount(count, `candidate ${candidate.candidateId} selected cost`);
};

const strictPriorSubsetMinimumCost = (
  candidate: CandidateLedgerEntry,
  priorPassageIds: readonly string[],
  replacedCandidateIds: readonly string[],
  passageOptions: PassageIndexOptions,
  costOptions: CompactionCostOptions | undefined,
): number => {
  if (priorPassageIds.length < 2) {
    throw new CompactionContractError(
      `candidate ${candidate.candidateId} has no feasible strict tightened subset`,
    );
  }
  return Math.min(
    ...priorPassageIds.map((passageId) =>
      exactSelectedPassageCost(
        candidate,
        [passageId],
        replacedCandidateIds,
        passageOptions,
        costOptions,
      ),
    ),
  );
};

export const validateFallbackContextManifest = (
  value: unknown,
  initial: InitialContextManifest,
  ledger: LedgerInput,
  firstResults: readonly GroupResultEnvelope[],
  passageOptions?: PassageIndexOptions,
  costOptions?: CompactionCostOptions,
): FallbackContextManifest => {
  const fallback = parseOrThrow(FallbackContextManifestSchema, value, "fallback context manifest");
  const validatedInitial = validateInitialContextManifest(
    initial,
    ledger,
    passageOptions,
    costOptions,
  );
  const candidates = candidateMap(ledger);
  const initialById = new Map(
    validatedInitial.decisions.map((decision) => [decision.candidateId, decision]),
  );
  const expectedGroupIds = validatedInitial.groups.map((group) => group.groupId);
  const parsedFirstResults = firstResults.map((result) =>
    parseOrThrow(GroupResultEnvelopeSchema, result, "first group result envelope"),
  );
  const firstGroupIds = parsedFirstResults.map((result) => result.groupId);
  if (
    firstGroupIds.length !== expectedGroupIds.length ||
    new Set(firstGroupIds).size !== firstGroupIds.length ||
    firstGroupIds.some((groupId) => !expectedGroupIds.includes(groupId))
  ) {
    throw new CompactionContractError(
      "first group result envelopes must cover every declared group exactly once",
    );
  }
  const firstByGroup = new Map<string, GroupResultEnvelope>();
  for (const envelope of parsedFirstResults) {
    const expectedGroup = validatedInitial.groups.find(
      (group) => group.groupId === envelope.groupId,
    )!;
    const expectedMembers = validatedInitial.decisions
      .filter((decision) => decision.action === "compact" && decision.groupId === envelope.groupId)
      .map((decision) => decision.candidateId);
    const group: CompactionGroup = {
      groupId: envelope.groupId,
      candidateIds: groupMembersInLedgerOrder(expectedMembers, ledger),
      renderedTokenBudget: expectedGroup.renderedTokenBudget,
      mode: "normal",
    };
    const validatedEnvelope =
      passageOptions === undefined
        ? envelope
        : validateGroupResultEnvelope(envelope, group, ledger, passageOptions, costOptions);
    if (
      passageOptions === undefined &&
      validatedEnvelope.renderedTokenCount > expectedGroup.renderedTokenBudget
    ) {
      throw new CompactionContractError(
        `first group result ${envelope.groupId} exceeds its rendered token budget`,
      );
    }
    firstByGroup.set(envelope.groupId, validatedEnvelope);
  }
  const ids = fallback.decisions.map((decision) => decision.candidateId);
  if (ids.length !== candidates.size || ids.some((id) => !candidates.has(id)))
    throw new CompactionContractError("fallback must cover the original ledger exactly once");
  for (const decision of validatedInitial.decisions) {
    if (decision.action === "compact" && !firstByGroup.has(decision.groupId)) {
      throw new CompactionContractError(`missing first result for group ${decision.groupId}`);
    }
    if (decision.action === "compact") {
      const envelope = firstByGroup.get(decision.groupId)!;
      const output = envelope.result.decisions.filter(
        (selection) => selection.candidateId === decision.candidateId,
      );
      if (output.length !== 1) {
        throw new CompactionContractError(
          `first result for ${decision.groupId} must name ${decision.candidateId} exactly once`,
        );
      }
    }
  }
  for (const envelope of parsedFirstResults) {
    const expectedMembers = validatedInitial.decisions
      .filter((decision) => decision.action === "compact" && decision.groupId === envelope.groupId)
      .map((decision) => decision.candidateId);
    if (
      envelope.result.decisions.length !== expectedMembers.length ||
      envelope.result.decisions.some((decision) => !expectedMembers.includes(decision.candidateId))
    ) {
      throw new CompactionContractError(`first result for ${envelope.groupId} changed membership`);
    }
  }
  const initialGroups = new Set(validatedInitial.groups.map((group) => group.groupId));
  for (const decision of fallback.decisions) {
    const previous = initialById.get(decision.candidateId)!;
    if (previous.action === "omit" && decision.action !== "omit") {
      throw new CompactionContractError(
        `omitted candidate ${decision.candidateId} cannot be restored`,
      );
    }
    if (previous.action === "compact") {
      const firstSelection = firstByGroup
        .get(previous.groupId)!
        .result.decisions.find((selection) => selection.candidateId === decision.candidateId)!;
      if (firstSelection.action === "omit" && decision.action !== "omit") {
        throw new CompactionContractError(
          `first-pass omission ${decision.candidateId} cannot be restored`,
        );
      }
      if (decision.action === "compact") {
        throw new CompactionContractError("a compacted candidate cannot move to a new group");
      }
      if (decision.action === "tighten" && decision.groupId !== previous.groupId) {
        throw new CompactionContractError("tighten must keep the original group");
      }
      if (decision.action === "retain" && !firstByGroup.has(previous.groupId)) {
        throw new CompactionContractError("retain needs the prior compacted result");
      }
    }
    if (previous.action === "keep" && decision.action === "tighten") {
      throw new CompactionContractError("whole-kept candidates cannot tighten without a group");
    }
    if (decision.action === "compact") {
      const candidate = candidates.get(decision.candidateId)!;
      if (previous.action !== "keep") {
        throw new CompactionContractError(
          `new fallback group ${decision.groupId} may contain only whole-kept candidates`,
        );
      }
      if (candidate.kind !== "document" && candidate.kind !== "chat_message") {
        throw new CompactionContractError(`candidate ${decision.candidateId} cannot be compacted`);
      }
      if (initialGroups.has(decision.groupId)) {
        throw new CompactionContractError(
          "fallback cannot reuse an existing group for a new compacted item",
        );
      }
    }
  }
  for (const group of fallback.groups) {
    const previous = firstByGroup.get(group.groupId);
    if (previous !== undefined) {
      if (group.renderedTokenBudget >= previous.renderedTokenCount) {
        throw new CompactionContractError(`tightened group ${group.groupId} must lower its budget`);
      }
      if (passageOptions !== undefined) {
        const members = validatedInitial.decisions
          .filter((decision) => decision.action === "compact" && decision.groupId === group.groupId)
          .map((decision) => decision.candidateId);
        const activeIds = members.filter(
          (candidateId) =>
            fallback.decisions.find((decision) => decision.candidateId === candidateId)?.action !==
            "omit",
        );
        if (activeIds.length === 0) {
          throw new CompactionContractError(
            `tightened group ${group.groupId} has no active members`,
          );
        }
        const firstResult = previous.result;
        const actualCost = activeIds.reduce((total, candidateId) => {
          const nextDecision = fallback.decisions.find(
            (decision) => decision.candidateId === candidateId,
          )!;
          const priorDecision = firstResult.decisions.find(
            (decision) => decision.candidateId === candidateId,
          )!;
          const candidate = candidates.get(candidateId)!;
          if (nextDecision.action === "retain") {
            if (priorDecision.action !== "select") {
              throw new CompactionContractError(
                `retained candidate ${candidateId} lacks a prior selected passage`,
              );
            }
            return (
              total +
              exactSelectedPassageCost(
                candidate,
                priorDecision.passageIds,
                activeIds,
                passageOptions,
                costOptions,
              )
            );
          }
          if (nextDecision.action !== "tighten" || priorDecision.action !== "select") {
            throw new CompactionContractError(
              `fallback group ${group.groupId} has an invalid member`,
            );
          }
          return (
            total +
            strictPriorSubsetMinimumCost(
              candidate,
              priorDecision.passageIds,
              activeIds,
              passageOptions,
              costOptions,
            )
          );
        }, 0);
        if (actualCost > group.renderedTokenBudget) {
          throw new CompactionContractError(
            `fallback group ${group.groupId} retained selections exceed its budget`,
          );
        }
      }
      continue;
    }
    const members = fallback.decisions.filter(
      (decision) => decision.action === "compact" && decision.groupId === group.groupId,
    );
    const wholeCost = members.reduce(
      (total, decision) => total + candidates.get(decision.candidateId)!.renderedTokenCount,
      0,
    );
    if (group.renderedTokenBudget >= wholeCost) {
      throw new CompactionContractError(
        `new fallback group ${group.groupId} budget must be below its whole cost`,
      );
    }
    if (passageOptions !== undefined) {
      const minimumCost = Math.min(
        ...members.map((decision) =>
          minimumSelectablePassageCost(
            candidates.get(decision.candidateId)!,
            passageOptions,
            costOptions,
            members.map((member) => member.candidateId),
          ),
        ),
      );
      if (group.renderedTokenBudget < minimumCost) {
        throw new CompactionContractError(
          `new fallback group ${group.groupId} budget is below its smallest selectable passage cost`,
        );
      }
    }
  }
  return fallback;
};
export const createFallbackCompactionGroups = (
  fallback: FallbackContextManifest,
  initial: InitialContextManifest,
  ledger: LedgerInput,
  firstResults: readonly GroupResultEnvelope[],
  options: {
    readonly sourceToolEligibleCandidateIds?: readonly string[] | undefined;
    readonly passageOptions?: PassageIndexOptions | undefined;
    readonly costOptions?: CompactionCostOptions | undefined;
  } = {},
): readonly CompactionGroup[] => {
  const validatedFallback = validateFallbackContextManifest(
    fallback,
    initial,
    ledger,
    firstResults,
    options.passageOptions,
    options.costOptions,
  );
  const validatedInitial = validateInitialContextManifest(
    initial,
    ledger,
    options.passageOptions,
    options.costOptions,
  );
  const entries = ledgerEntries(ledger);
  const eligible = new Set(options.sourceToolEligibleCandidateIds ?? []);
  const initialByGroup = new Set(validatedInitial.groups.map((group) => group.groupId));
  const firstByGroup = new Map(firstResults.map((result) => [result.groupId, result] as const));
  const groups = validatedFallback.groups.flatMap((group) => {
    const previous = firstByGroup.get(group.groupId);
    const candidateIds =
      previous === undefined
        ? validatedFallback.decisions
            .filter(
              (decision) => decision.action === "compact" && decision.groupId === group.groupId,
            )
            .map((decision) => decision.candidateId)
        : validatedInitial.decisions
            .filter(
              (decision) =>
                decision.action === "compact" &&
                decision.groupId === group.groupId &&
                validatedFallback.decisions.some(
                  (next) => next.candidateId === decision.candidateId && next.action !== "omit",
                ),
            )
            .map((decision) => decision.candidateId);
    const ordered = groupMembersInLedgerOrder(candidateIds, ledger);
    if (ordered.length === 0) return [];
    const mode: CompactionGroupMode =
      ordered.length === 1 && eligible.has(ordered[0]!) ? "source_tool" : "normal";
    if (previous === undefined && initialByGroup.has(group.groupId)) {
      throw new CompactionContractError(
        `fallback group ${group.groupId} collides with initial group`,
      );
    }
    return [
      {
        groupId: group.groupId,
        candidateIds: ordered,
        renderedTokenBudget: group.renderedTokenBudget,
        mode,
      },
    ];
  });
  return groups.sort((left, right) => {
    const leftOrdinal = entries.findIndex((candidate) =>
      left.candidateIds.includes(candidate.candidateId),
    );
    const rightOrdinal = entries.findIndex((candidate) =>
      right.candidateIds.includes(candidate.candidateId),
    );
    return leftOrdinal - rightOrdinal;
  });
};

export const mergeGroupCompactionResults = (
  ledger: LedgerInput,
  expectedGroups: readonly CompactionGroup[],
  groups: readonly GroupResultEnvelope[],
  passageOptions: PassageIndexOptions,
  costOptions?: CompactionCostOptions,
): readonly CompactionSelection[] => {
  const expectedGroupIds = expectedGroups.map((group) => group.groupId);
  if (
    new Set(expectedGroupIds).size !== expectedGroupIds.length ||
    expectedGroups.some(
      (group) =>
        !GroupLocalIdSchema.safeParse(group.groupId).success ||
        !Number.isSafeInteger(group.renderedTokenBudget) ||
        group.renderedTokenBudget < 1 ||
        group.candidateIds.length === 0 ||
        new Set(group.candidateIds).size !== group.candidateIds.length,
    )
  ) {
    throw new CompactionContractError("expected compaction groups are invalid");
  }
  const resultGroupIds = groups.map((group) => group.groupId);
  if (
    resultGroupIds.length !== expectedGroupIds.length ||
    new Set(resultGroupIds).size !== resultGroupIds.length ||
    resultGroupIds.some((groupId) => !expectedGroupIds.includes(groupId))
  ) {
    throw new CompactionContractError(
      "group result envelopes must cover every expected group exactly once",
    );
  }
  const byCandidate = new Map<string, CompactionSelection>();
  for (const group of groups) {
    const expected = expectedGroups.find((candidate) => candidate.groupId === group.groupId)!;
    const validatedEnvelope = validateGroupResultEnvelope(
      group,
      expected,
      ledger,
      passageOptions,
      costOptions,
    );
    const validatedResult = validatedEnvelope.result;
    const decisionIds = validatedResult.decisions.map((decision) => decision.candidateId);
    if (
      decisionIds.length !== expected.candidateIds.length ||
      decisionIds.some((candidateId) => !expected.candidateIds.includes(candidateId))
    ) {
      throw new CompactionContractError(`group ${group.groupId} result changed membership`);
    }
    for (const selection of validatedResult.decisions) {
      const candidate = ledgerEntries(ledger).find(
        (entry) => entry.candidateId === selection.candidateId,
      );
      if (candidate === undefined) {
        throw new CompactionContractError(`unknown candidate ${selection.candidateId}`);
      }
      const index = buildCandidatePassageIndex(candidate, passageOptions);
      const ranges =
        selection.action === "select" ? mapPassageIdsToRanges(index, selection.passageIds) : [];
      if (byCandidate.has(selection.candidateId)) {
        throw new CompactionContractError(
          `candidate ${selection.candidateId} appears in two group results`,
        );
      }
      byCandidate.set(selection.candidateId, {
        candidateId: selection.candidateId,
        action: selection.action === "omit" ? "omit" : "range",
        groupId: group.groupId,
        passageIds: selection.action === "select" ? selection.passageIds : [],
        ranges,
      });
    }
  }
  const expectedCandidateIds = expectedGroups.flatMap((group) => group.candidateIds);
  if (
    new Set(expectedCandidateIds).size !== expectedCandidateIds.length ||
    expectedCandidateIds.some((candidateId) => !byCandidate.has(candidateId))
  ) {
    throw new CompactionContractError(
      "group outputs must cover every expected candidate exactly once",
    );
  }
  return ledgerEntries(ledger)
    .filter((candidate) => byCandidate.has(candidate.candidateId))
    .map((candidate) => byCandidate.get(candidate.candidateId)!);
};

export const mergeCompactionSelections = (
  ledger: LedgerInput,
  initial: InitialContextManifest,
  groups: readonly GroupResultEnvelope[],
  passageOptions: PassageIndexOptions,
  costOptions?: CompactionCostOptions,
): readonly CompactionSelection[] => {
  const validated = validateInitialContextManifest(initial, ledger, passageOptions, costOptions);
  const compactGroups = createCompactionGroups(validated, ledger, {
    sourceToolEligibleCandidateIds: [],
    passageOptions,
    costOptions,
  });
  const grouped = new Map(
    mergeGroupCompactionResults(ledger, compactGroups, groups, passageOptions, costOptions).map(
      (selection) => [selection.candidateId, selection] as const,
    ),
  );
  return ledgerEntries(ledger).map((candidate) => {
    const decision = validated.decisions.find(
      (entry) => entry.candidateId === candidate.candidateId,
    )!;
    if (decision.action === "keep") {
      return {
        candidateId: candidate.candidateId,
        action: "keep",
        passageIds: [],
        ranges: candidate.baseRanges,
      };
    }
    if (decision.action === "omit") {
      return { candidateId: candidate.candidateId, action: "omit", passageIds: [], ranges: [] };
    }
    const selection = grouped.get(candidate.candidateId);
    if (selection === undefined) {
      throw new CompactionContractError(`missing compacted output ${candidate.candidateId}`);
    }
    return selection;
  });
};
