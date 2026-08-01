import { z } from "zod";

import {
  CanonicalIdentitySchema,
  canonicalIdentityKey,
  canonicalIdentityTuple,
  ResultLocalIdSchema,
  type CanonicalIdentity,
} from "../workflow/types";
import {
  BranchCoverageSchema,
  BranchReasonCodeSchema,
  PHYSICAL_QUERY_BRANCHES,
  QUERY_CONTRACT_LIMITS,
  isWellFormedUtf16,
  type BranchCoverage,
  type BranchReasonCode,
  type BranchStatus,
  type QueryBranch,
  type QueryOrder,
} from "./query-spec";

export {
  CanonicalIdentitySchema,
  canonicalIdentityKey,
  canonicalIdentityTuple,
  type CanonicalIdentity,
};

export type RetrievalCanonicalIdentity = Extract<
  CanonicalIdentity,
  { readonly kind: "public_document" | "publisher_document" | "chat_message" }
>;

const utf8 = new TextEncoder();

const parseFusionDate = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("fused result date is invalid");
  }
  return date.toISOString();
};

export const compareBytewise = (left: string, right: string): number => {
  const leftBytes = utf8.encode(left);
  const rightBytes = utf8.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
};

const positiveSafeInt = z.number().int().finite().safe().positive();
const boundedUtf8 = (value: string): boolean =>
  isWellFormedUtf16(value) &&
  new TextEncoder().encode(value).byteLength <= QUERY_CONTRACT_LIMITS.maxHitPreviewUtf8Bytes;
const boundedMeta = (value: string, maxBytes: number): boolean =>
  isWellFormedUtf16(value) && new TextEncoder().encode(value).byteLength <= maxBytes;

export const compareCanonicalIdentities = (
  left: RetrievalCanonicalIdentity,
  right: RetrievalCanonicalIdentity,
): number => compareBytewise(canonicalIdentityKey(left), canonicalIdentityKey(right));

export interface RankedBranchHit<T = unknown> {
  readonly queryOrdinal: number;
  readonly branch: QueryBranch;
  readonly rank: number;
  readonly identity: RetrievalCanonicalIdentity;
  readonly value: T;
  readonly date?: string | null | undefined;
}

export interface RankedBranchResult<T = unknown> {
  readonly queryOrdinal: number;
  readonly branch: QueryBranch;
  readonly order?: QueryOrder | undefined;
  readonly status: BranchStatus;
  readonly reason?: BranchReasonCode | undefined;
  readonly hits: readonly RankedBranchHit<T>[];
  readonly cap: number;
  readonly truncated: boolean;
}

export interface FusedProvenance {
  readonly queryOrdinal: number;
  readonly branch: QueryBranch;
  /** The rank in the physical branch list. */
  readonly rank: number;
  /** The rank after stage 2b for this logical query. */
  readonly logicalRank?: number | undefined;
}

export interface FusedResult<T = unknown> {
  readonly resultId: `r${number}`;
  readonly identity: RetrievalCanonicalIdentity;
  readonly identityKey: string;
  readonly value: T;
  readonly score: number;
  readonly rrfK: number;
  readonly bestRank: number;
  readonly date: string | null;
  readonly provenance: readonly FusedProvenance[];
  /** Exact physical identities represented by one logical document result. */
  readonly physicalIdentities?: readonly RetrievalCanonicalIdentity[] | undefined;
  readonly matchedQueryOrdinals: readonly number[];
}

export interface FusionTruncation {
  readonly branch: boolean;
  readonly candidates: boolean;
  readonly hydration: boolean;
}

export interface FusedResultSet<T = unknown> {
  readonly results: readonly FusedResult<T>[];
  readonly coverage: readonly BranchCoverage[];
  readonly candidateCountBeforeCap: number;
  readonly candidateCap: number;
  readonly hydratedBytes: number;
  readonly hydrationByteCap: number | null;
  readonly truncation: FusionTruncation;
}

export interface RrfFusionOptions<T> {
  readonly maxCandidates?: number | undefined;
  readonly maxHydratedBytes?: number | undefined;
  readonly hydrationBytes?: ((value: T) => number) | undefined;
  readonly k?: number | undefined;
  readonly order?: "relevance" | "newest" | "oldest" | undefined;
  readonly queryOrders?: ReadonlyMap<number, QueryOrder> | undefined;
}

const positiveInt = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
};

const coverageEnvelopeError = (
  rows: readonly Pick<BranchCoverage, "queryOrdinal" | "branch">[],
): string | null => {
  if (rows.length === 0) return "branch coverage must not be empty";
  const keys = rows.map((row) => `${row.queryOrdinal}\u0000${row.branch}`);
  if (new Set(keys).size !== keys.length) return "query/branch results must be unique";
  const queryOrdinals = [...new Set(rows.map((row) => row.queryOrdinal))].sort(
    (left, right) => left - right,
  );
  for (const [index, queryOrdinal] of queryOrdinals.entries()) {
    if (queryOrdinal !== index + 1) return "query ordinals must be contiguous from one";
  }
  for (const queryOrdinal of queryOrdinals) {
    for (const branch of PHYSICAL_QUERY_BRANCHES) {
      if (!keys.includes(`${queryOrdinal}\u0000${branch}`)) {
        return `missing branch coverage for query ${queryOrdinal}: ${branch}`;
      }
    }
  }
  return null;
};

const identityMatchesBranch = (
  branch: QueryBranch,
  identity: RetrievalCanonicalIdentity,
): boolean =>
  (branch === "public_documents" && identity.kind === "public_document") ||
  (branch === "publisher_documents" && identity.kind === "publisher_document") ||
  (branch === "chat_messages" && identity.kind === "chat_message");

const assertBranch = <T>(branch: RankedBranchResult<T>): void => {
  positiveInt(branch.queryOrdinal, "query ordinal");
  positiveInt(branch.cap, "branch cap");
  if (!PHYSICAL_QUERY_BRANCHES.includes(branch.branch)) {
    throw new Error("unknown physical branch");
  }
  if (branch.status !== "applicable" && branch.status !== "not_applicable") {
    throw new Error("unknown branch status");
  }
  if (
    branch.order !== undefined &&
    branch.order !== "relevance" &&
    branch.order !== "newest" &&
    branch.order !== "oldest"
  ) {
    throw new Error("unknown branch order");
  }
  if (branch.status === "not_applicable") {
    if (branch.reason === undefined || !BranchReasonCodeSchema.safeParse(branch.reason).success) {
      throw new Error("not-applicable branches need a reason");
    }
    if (branch.hits.length !== 0 || branch.truncated) {
      throw new Error("not-applicable branches cannot contain hits or truncation");
    }
  } else if (branch.reason !== undefined) {
    throw new Error("applicable branches cannot carry a reason");
  }
  if (branch.hits.length > branch.cap) throw new Error("branch hit count exceeds its cap");
  if (branch.truncated && branch.hits.length !== branch.cap) {
    throw new Error("truncated branches must contain their cap of hits");
  }
  const identities = new Set<string>();
  for (const [index, hit] of branch.hits.entries()) {
    positiveInt(hit.rank, "branch rank");
    if (hit.rank !== index + 1) throw new Error("branch ranks must be sequential");
    if (hit.queryOrdinal !== branch.queryOrdinal || hit.branch !== branch.branch) {
      throw new Error("hit provenance does not match its branch");
    }
    if (!identityMatchesBranch(branch.branch, hit.identity)) {
      throw new Error("hit identity kind does not match its physical branch");
    }
    const key = canonicalIdentityKey(hit.identity);
    if (identities.has(key)) {
      throw new Error("one physical branch cannot repeat a canonical identity");
    }
    identities.add(key);
  }
};

const sameIdentityProof = (
  left: RetrievalCanonicalIdentity,
  right: RetrievalCanonicalIdentity,
): boolean =>
  JSON.stringify(CanonicalIdentitySchema.parse(left)) ===
  JSON.stringify(CanonicalIdentitySchema.parse(right));

const physicalIdentityAnchor = (identity: RetrievalCanonicalIdentity): string => {
  switch (identity.kind) {
    case "public_document":
      return JSON.stringify(["public_document", identity.documentId]);
    case "publisher_document":
      return JSON.stringify(["publisher_document", identity.documentId]);
    case "chat_message":
      return JSON.stringify(["chat_message", identity.messageId]);
  }
};

const stableProof = <T>(value: T): string => JSON.stringify(value) ?? "undefined";

const sameHitProof = <T>(left: RankedBranchHit<T>, right: RankedBranchHit<T>): boolean =>
  sameIdentityProof(left.identity, right.identity) &&
  parseFusionDate(left.date) === parseFusionDate(right.date) &&
  stableProof(left.value) === stableProof(right.value);

const logicalDocumentKey = (identity: RetrievalCanonicalIdentity): string => {
  if (identity.kind === "chat_message") return physicalIdentityAnchor(identity);
  return JSON.stringify(["logical_document", identity.documentId, identity.snapshotId]);
};

const queryOrderFor = <T>(
  queryOrdinal: number,
  branchOrder: QueryOrder | undefined,
  options: RrfFusionOptions<T>,
): QueryOrder =>
  options.queryOrders?.get(queryOrdinal) ?? branchOrder ?? options.order ?? "relevance";

const compareStageResults = (
  left: {
    readonly score: number;
    readonly bestRank: number;
    readonly date: string | null;
    readonly identityKey: string;
  },
  right: {
    readonly score: number;
    readonly bestRank: number;
    readonly date: string | null;
    readonly identityKey: string;
  },
  order: QueryOrder,
): number => {
  const score = right.score - left.score;
  if (score !== 0) return score;
  const rank = left.bestRank - right.bestRank;
  if (rank !== 0) return rank;
  const date =
    order === "oldest"
      ? compareBytewise(left.date ?? "", right.date ?? "")
      : compareBytewise(right.date ?? "", left.date ?? "");
  if (date !== 0) return date;
  return compareBytewise(left.identityKey, right.identityKey);
};

const compareFinalResults = (
  left: {
    readonly score: number;
    readonly bestRank: number;
    readonly date: string | null;
    readonly identityKey: string;
  },
  right: {
    readonly score: number;
    readonly bestRank: number;
    readonly date: string | null;
    readonly identityKey: string;
  },
  order: QueryOrder,
): number => {
  const score = right.score - left.score;
  if (score !== 0) return score;
  const rank = left.bestRank - right.bestRank;
  if (rank !== 0) return rank;
  const date =
    order === "oldest"
      ? compareBytewise(left.date ?? "", right.date ?? "")
      : compareBytewise(right.date ?? "", left.date ?? "");
  return date || compareBytewise(left.identityKey, right.identityKey);
};

export const reciprocalRankContribution = (rank: number, k = 60): number => {
  positiveInt(rank, "rank");
  positiveInt(k, "RRF k");
  return 1 / (k + rank);
};

export const RankedBranchHitSchema = z
  .strictObject({
    queryOrdinal: positiveSafeInt,
    branch: z.enum(PHYSICAL_QUERY_BRANCHES),
    rank: positiveSafeInt,
    identity: CanonicalIdentitySchema,
    value: z.unknown(),
    date: z.string().nullable().optional(),
  })
  .superRefine((hit, context) => {
    if (!identityMatchesBranch(hit.branch, hit.identity as RetrievalCanonicalIdentity)) {
      context.addIssue({ code: "custom", path: ["identity"], message: "identity kind mismatch" });
    }
  });

export const RankedBranchResultSchema = z
  .strictObject({
    queryOrdinal: positiveSafeInt,
    branch: z.enum(PHYSICAL_QUERY_BRANCHES),
    order: z.enum(["relevance", "newest", "oldest"]).optional(),
    status: z.enum(["applicable", "not_applicable"]),
    reason: BranchReasonCodeSchema.optional(),
    hits: z.array(RankedBranchHitSchema),
    cap: positiveSafeInt,
    truncated: z.boolean(),
  })
  .superRefine((branch, context) => {
    if (
      branch.status === "not_applicable" &&
      (branch.reason === undefined || branch.hits.length || branch.truncated)
    ) {
      context.addIssue({
        code: "custom",
        message: "not-applicable branch must be empty and explained",
      });
    }
    if (branch.status === "applicable" && branch.reason !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "applicable branch cannot have a reason",
      });
    }
    if (branch.hits.length > branch.cap) {
      context.addIssue({ code: "custom", path: ["hits"], message: "branch hits exceed cap" });
    }
    if (branch.truncated && branch.hits.length !== branch.cap) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "truncated branch must reach cap",
      });
    }
    const identities = new Set<string>();
    for (const [index, hit] of branch.hits.entries()) {
      if (hit.queryOrdinal !== branch.queryOrdinal || hit.branch !== branch.branch) {
        context.addIssue({
          code: "custom",
          path: ["hits", index],
          message: "hit provenance mismatch",
        });
      }
      if (hit.rank !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["hits", index, "rank"],
          message: "ranks must be sequential",
        });
      }
      const key = canonicalIdentityKey(hit.identity as RetrievalCanonicalIdentity);
      if (identities.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["hits", index, "identity"],
          message: "duplicate canonical identity",
        });
      }
      identities.add(key);
    }
  });

export const fuseRankedResults = <T>(
  branches: readonly RankedBranchResult<T>[],
  options: RrfFusionOptions<T> = {},
): FusedResultSet<T> => {
  const k = options.k ?? 60;
  const candidateCap = options.maxCandidates ?? Number.MAX_SAFE_INTEGER;
  positiveInt(k, "RRF k");
  positiveInt(candidateCap, "candidate cap");
  if (options.maxHydratedBytes !== undefined) {
    positiveInt(options.maxHydratedBytes, "hydration byte cap");
    if (options.hydrationBytes === undefined) {
      throw new Error("hydration byte measurement is required with a hydration cap");
    }
  }
  for (const branch of branches) assertBranch(branch);
  const branchKeys = new Set<string>();
  for (const branch of branches) {
    const key = `${branch.queryOrdinal}\u0000${branch.branch}`;
    if (branchKeys.has(key)) throw new Error("query/branch results must be unique");
    branchKeys.add(key);
  }
  const envelopeError = coverageEnvelopeError(branches);
  if (envelopeError !== null) throw new Error(envelopeError);

  type Accumulator = Omit<FusedResult<T>, "resultId">;
  const byIdentity = new Map<string, Accumulator>();
  const proofHits = new Map<string, RankedBranchHit<T>>();
  const orderedHits = branches
    .filter((branch) => branch.status === "applicable")
    .flatMap((branch) => branch.hits)
    .sort(
      (left, right) =>
        left.queryOrdinal - right.queryOrdinal ||
        compareBytewise(left.branch, right.branch) ||
        left.rank - right.rank ||
        compareBytewise(canonicalIdentityKey(left.identity), canonicalIdentityKey(right.identity)),
    );

  for (const hit of orderedHits) {
    const hitDate = parseFusionDate(hit.date);
    const identityKey = physicalIdentityAnchor(hit.identity);
    const contribution = reciprocalRankContribution(hit.rank, k);
    const previous = byIdentity.get(identityKey);
    const previousHit = proofHits.get(identityKey);
    if (previousHit !== undefined && !sameHitProof(previousHit, hit)) {
      throw new Error("canonical identity has conflicting immutable proof fields");
    }
    if (
      previous?.date !== null &&
      previous?.date !== undefined &&
      hitDate !== null &&
      previous.date !== hitDate
    ) {
      throw new Error("canonical identity has conflicting date fields");
    }
    const provenance = [
      ...(previous?.provenance ?? []),
      { queryOrdinal: hit.queryOrdinal, branch: hit.branch, rank: hit.rank },
    ].sort(
      (left, right) =>
        left.queryOrdinal - right.queryOrdinal ||
        compareBytewise(left.branch, right.branch) ||
        left.rank - right.rank,
    );
    byIdentity.set(identityKey, {
      identity: previous?.identity ?? hit.identity,
      identityKey: canonicalIdentityKey(previous?.identity ?? hit.identity),
      value: previous?.value ?? hit.value,
      score: (previous?.score ?? 0) + contribution,
      rrfK: k,
      bestRank: Math.min(previous?.bestRank ?? hit.rank, hit.rank),
      date: previous?.date ?? hitDate,
      provenance,
      matchedQueryOrdinals: [...new Set(provenance.map((item) => item.queryOrdinal))].sort(
        (left, right) => left - right,
      ),
    });
    proofHits.set(identityKey, previousHit ?? hit);
  }

  const order = options.order ?? "relevance";
  if (order !== "relevance" && order !== "newest" && order !== "oldest") {
    throw new Error("unknown fusion order");
  }
  const sorted = [...byIdentity.values()].sort((left, right) =>
    compareFinalResults(left, right, order),
  );

  const candidateLimited = sorted.slice(0, candidateCap);
  const hydrated: Accumulator[] = [];
  let hydratedBytes = 0;
  let hydrationTruncated = false;
  for (const result of candidateLimited) {
    const bytes = options.hydrationBytes?.(result.value) ?? 0;
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("hydration byte measurement must be a non-negative safe integer");
    }
    if (
      options.maxHydratedBytes !== undefined &&
      hydratedBytes + bytes > options.maxHydratedBytes
    ) {
      if (hydrated.length === 0) {
        throw new Error("one candidate exceeds the hydration byte cap");
      }
      hydrationTruncated = true;
      break;
    }
    hydrated.push(result);
    hydratedBytes += bytes;
  }

  const branchOrder = new Map(PHYSICAL_QUERY_BRANCHES.map((branch, index) => [branch, index]));
  const orderedBranches = [...branches].sort(
    (left, right) =>
      left.queryOrdinal - right.queryOrdinal ||
      (branchOrder.get(left.branch) ?? Number.MAX_SAFE_INTEGER) -
        (branchOrder.get(right.branch) ?? Number.MAX_SAFE_INTEGER),
  );

  return {
    results: hydrated.map((result, index) => ({
      ...result,
      resultId: `r${index + 1}` as `r${number}`,
    })),
    coverage: orderedBranches.map((branch) => ({
      queryOrdinal: branch.queryOrdinal,
      branch: branch.branch,
      status: branch.status,
      ...(branch.reason === undefined ? {} : { reason: branch.reason }),
      hitCount: branch.hits.length,
      truncated: branch.truncated,
      cap: branch.cap,
    })),
    candidateCountBeforeCap: sorted.length,
    candidateCap,
    hydratedBytes,
    hydrationByteCap: options.maxHydratedBytes ?? null,
    truncation: {
      branch: branches.some((branch) => branch.truncated),
      candidates: sorted.length > candidateCap,
      hydration: hydrationTruncated,
    },
  };
};

/** Execute the plan's physical-to-logical-to-cross-query rank fusion. */
export const fuseTwoStageRankedResults = <T>(
  branches: readonly RankedBranchResult<T>[],
  options: RrfFusionOptions<T> = {},
): FusedResultSet<T> => {
  const k = options.k ?? 60;
  const candidateCap = options.maxCandidates ?? Number.MAX_SAFE_INTEGER;
  positiveInt(k, "RRF k");
  positiveInt(candidateCap, "candidate cap");
  if (options.maxHydratedBytes !== undefined) {
    positiveInt(options.maxHydratedBytes, "hydration byte cap");
    if (options.hydrationBytes === undefined) {
      throw new Error("hydration byte measurement is required with a hydration cap");
    }
  }
  for (const branch of branches) assertBranch(branch);
  const keys = new Set(branches.map((branch) => `${branch.queryOrdinal}\u0000${branch.branch}`));
  if (keys.size !== branches.length) throw new Error("query/branch results must be unique");
  const envelopeError = coverageEnvelopeError(branches);
  if (envelopeError !== null) throw new Error(envelopeError);

  type PhysicalAccumulator = {
    readonly value: T;
    readonly date: string | null;
  };
  type LogicalAccumulator = {
    readonly identity: RetrievalCanonicalIdentity;
    readonly identityKey: string;
    readonly value: T;
    readonly date: string | null;
    readonly stageOneScore: number;
    readonly bestPhysicalRank: number;
    readonly provenance: readonly FusedProvenance[];
    readonly physicalIdentities: readonly RetrievalCanonicalIdentity[];
  };
  type QueryAccumulator = {
    readonly physical: Map<string, PhysicalAccumulator>;
    readonly logical: Map<string, LogicalAccumulator>;
  };
  const byQuery = new Map<number, QueryAccumulator>();
  const proofHits = new Map<string, RankedBranchHit<T>>();
  const documentSnapshotProof = new Map<string, string>();
  const orderedHits = branches
    .filter((branch) => branch.status === "applicable")
    .flatMap((branch) => branch.hits)
    .sort(
      (left, right) =>
        left.queryOrdinal - right.queryOrdinal ||
        compareBytewise(left.branch, right.branch) ||
        left.rank - right.rank ||
        compareBytewise(canonicalIdentityKey(left.identity), canonicalIdentityKey(right.identity)),
    );
  for (const hit of orderedHits) {
    const hitDate = parseFusionDate(hit.date);
    const identityKey = physicalIdentityAnchor(hit.identity);
    const logicalKey = logicalDocumentKey(hit.identity);
    const queryState =
      byQuery.get(hit.queryOrdinal) ??
      ({
        physical: new Map<string, PhysicalAccumulator>(),
        logical: new Map<string, LogicalAccumulator>(),
      } satisfies QueryAccumulator);
    if (hit.identity.kind !== "chat_message") {
      const documentSnapshotKey = JSON.stringify([
        "document_snapshot",
        hit.identity.documentId,
        hit.identity.snapshotId,
      ]);
      const priorHash = documentSnapshotProof.get(documentSnapshotKey);
      if (priorHash !== undefined && priorHash !== hit.identity.contentHash) {
        throw new Error("canonical identity has conflicting immutable proof fields");
      }
      documentSnapshotProof.set(documentSnapshotKey, hit.identity.contentHash);
    }
    const previousPhysical = proofHits.get(identityKey);
    if (previousPhysical !== undefined && !sameHitProof(previousPhysical, hit)) {
      throw new Error("canonical identity has conflicting immutable proof fields");
    }
    const physical = queryState.physical.get(identityKey);
    if (physical !== undefined) {
      if (physical.date !== hitDate || stableProof(physical.value) !== stableProof(hit.value)) {
        throw new Error("canonical identity has conflicting immutable proof fields");
      }
    } else {
      queryState.physical.set(identityKey, {
        value: hit.value,
        date: hitDate,
      });
    }
    const previous = queryState.logical.get(logicalKey);
    if (previous !== undefined && previous.date !== hitDate) {
      throw new Error("logical document has conflicting date fields");
    }
    const provenance = [
      ...(previous?.provenance ?? []),
      { queryOrdinal: hit.queryOrdinal, branch: hit.branch, rank: hit.rank },
    ].sort(
      (left, right) =>
        left.queryOrdinal - right.queryOrdinal ||
        compareBytewise(left.branch, right.branch) ||
        left.rank - right.rank,
    );
    const physicalIdentities = [...(previous?.physicalIdentities ?? [])];
    if (!physicalIdentities.some((identity) => physicalIdentityAnchor(identity) === identityKey)) {
      physicalIdentities.push(hit.identity);
    }
    const next = {
      identity: previous?.identity ?? hit.identity,
      identityKey: previous?.identityKey ?? canonicalIdentityKey(hit.identity),
      value: previous?.value ?? hit.value,
      date: previous?.date ?? hitDate,
      stageOneScore: (previous?.stageOneScore ?? 0) + reciprocalRankContribution(hit.rank, k),
      bestPhysicalRank: Math.min(previous?.bestPhysicalRank ?? hit.rank, hit.rank),
      provenance,
      physicalIdentities,
    };
    queryState.logical.set(logicalKey, next);
    proofHits.set(identityKey, previousPhysical ?? hit);
    byQuery.set(hit.queryOrdinal, queryState);
  }

  const order = options.order ?? "relevance";
  if (order !== "relevance" && order !== "newest" && order !== "oldest") {
    throw new Error("unknown fusion order");
  }
  const logicalRanks = new Map<
    string,
    {
      readonly identity: RetrievalCanonicalIdentity;
      readonly identityKey: string;
      readonly value: T;
      readonly date: string | null;
      readonly score: number;
      readonly bestRank: number;
      readonly provenance: readonly FusedProvenance[];
      readonly physicalIdentities: readonly RetrievalCanonicalIdentity[];
      readonly matchedQueryOrdinals: readonly number[];
    }
  >();
  const queryOrders = new Map<number, QueryOrder>();
  for (const branch of branches) {
    const prior = queryOrders.get(branch.queryOrdinal);
    if (branch.order !== undefined || prior === undefined) {
      queryOrders.set(
        branch.queryOrdinal,
        queryOrderFor(branch.queryOrdinal, branch.order, options),
      );
    }
  }
  for (const [queryOrdinal, queryState] of [...byQuery.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    const queryOrder = queryOrders.get(queryOrdinal) ?? "relevance";
    const logical = [...queryState.logical.values()].sort((left, right) =>
      compareStageResults(
        {
          score: left.stageOneScore,
          bestRank: left.bestPhysicalRank,
          date: left.date,
          identityKey: left.identityKey,
        },
        {
          score: right.stageOneScore,
          bestRank: right.bestPhysicalRank,
          date: right.date,
          identityKey: right.identityKey,
        },
        queryOrder,
      ),
    );
    for (const [index, item] of logical.entries()) {
      const logicalRank = index + 1;
      const key = logicalDocumentKey(item.identity);
      const prior = logicalRanks.get(key);
      if (prior !== undefined && prior.date !== item.date) {
        throw new Error("logical document has conflicting date fields");
      }
      const provenance = [
        ...(prior?.provenance ?? []),
        ...item.provenance.map((entry) => ({ ...entry, logicalRank })),
      ].sort(
        (left, right) =>
          left.queryOrdinal - right.queryOrdinal ||
          compareBytewise(left.branch, right.branch) ||
          left.rank - right.rank,
      );
      logicalRanks.set(key, {
        identity: prior?.identity ?? item.identity,
        identityKey: prior?.identityKey ?? item.identityKey,
        value: prior?.value ?? item.value,
        date: prior?.date ?? item.date,
        score: (prior?.score ?? 0) + reciprocalRankContribution(logicalRank, k),
        bestRank: Math.min(prior?.bestRank ?? logicalRank, logicalRank),
        provenance,
        physicalIdentities: [
          ...(prior?.physicalIdentities ?? []),
          ...item.physicalIdentities.filter(
            (identity) =>
              !(prior?.physicalIdentities ?? []).some(
                (priorIdentity) =>
                  canonicalIdentityKey(priorIdentity) === canonicalIdentityKey(identity),
              ),
          ),
        ],
        matchedQueryOrdinals: [...new Set(provenance.map((entry) => entry.queryOrdinal))].sort(
          (left, right) => left - right,
        ),
      });
    }
  }

  const distinctOrders = new Set(queryOrders.values());
  const finalOrder =
    distinctOrders.size === 1
      ? ([...distinctOrders][0] ?? options.order ?? "relevance")
      : "relevance";
  const sorted = [...logicalRanks.values()].sort((left, right) =>
    compareFinalResults(left, right, finalOrder),
  );
  const candidateLimited = sorted.slice(0, candidateCap);
  const hydrated: typeof sorted = [];
  let hydratedBytes = 0;
  let hydrationTruncated = false;
  for (const result of candidateLimited) {
    const bytes = options.hydrationBytes?.(result.value) ?? 0;
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("hydration byte measurement must be a non-negative safe integer");
    }
    if (
      options.maxHydratedBytes !== undefined &&
      hydratedBytes + bytes > options.maxHydratedBytes
    ) {
      if (hydrated.length === 0) throw new Error("one candidate exceeds the hydration byte cap");
      hydrationTruncated = true;
      break;
    }
    hydrated.push(result);
    hydratedBytes += bytes;
  }
  const branchOrder = new Map(PHYSICAL_QUERY_BRANCHES.map((branch, index) => [branch, index]));
  const orderedBranches = [...branches].sort(
    (left, right) =>
      left.queryOrdinal - right.queryOrdinal ||
      (branchOrder.get(left.branch) ?? Number.MAX_SAFE_INTEGER) -
        (branchOrder.get(right.branch) ?? Number.MAX_SAFE_INTEGER),
  );
  return {
    results: hydrated.map((result, index) => ({
      ...result,
      rrfK: k,
      resultId: `r${index + 1}` as `r${number}`,
    })),
    coverage: orderedBranches.map((branch) => ({
      queryOrdinal: branch.queryOrdinal,
      branch: branch.branch,
      status: branch.status,
      ...(branch.reason === undefined ? {} : { reason: branch.reason }),
      hitCount: branch.hits.length,
      truncated: branch.truncated,
      cap: branch.cap,
    })),
    candidateCountBeforeCap: sorted.length,
    candidateCap,
    hydratedBytes,
    hydrationByteCap: options.maxHydratedBytes ?? null,
    truncation: {
      branch: branches.some((branch) => branch.truncated),
      candidates: sorted.length > candidateCap,
      hydration: hydrationTruncated,
    },
  };
};

export interface ReviewResultValue {
  readonly kind: "document" | "chat_message";
  readonly label: string | null;
  readonly date: string | null;
  readonly tokenCount: number;
  readonly preview: string;
}

export interface ReviewModelFusedResult extends ReviewResultValue {
  readonly resultId: `r${number}`;
  readonly normalizedFusedScore: number;
  readonly matchedQueryOrdinals: readonly number[];
  readonly branchCoverage: readonly BranchCoverage[];
  readonly truncationFlags: FusionTruncation;
}
export const ReviewModelFusedResultSchema = z.strictObject({
  resultId: ResultLocalIdSchema,
  kind: z.enum(["document", "chat_message"]),
  label: z
    .string()
    .refine((value) => boundedMeta(value, QUERY_CONTRACT_LIMITS.maxHitLabelUtf8Bytes))
    .nullable(),
  date: z
    .string()
    .refine((value) => boundedMeta(value, QUERY_CONTRACT_LIMITS.maxHitDateUtf8Bytes))
    .nullable(),
  tokenCount: z.number().int().finite().safe().min(0),
  preview: z.string().refine(boundedUtf8, "preview is too large"),
  normalizedFusedScore: z.number().finite().min(0).max(1),
  matchedQueryOrdinals: z.array(positiveSafeInt).superRefine((ordinals, context) => {
    for (let index = 1; index < ordinals.length; index += 1) {
      if (ordinals[index]! <= ordinals[index - 1]!) {
        context.addIssue({ code: "custom", message: "query ordinals must be sorted and unique" });
        break;
      }
    }
  }),
  branchCoverage: z.array(BranchCoverageSchema),
  truncationFlags: z.strictObject({
    branch: z.boolean(),
    candidates: z.boolean(),
    hydration: z.boolean(),
  }),
});
export type ReviewModelFusedResultMetadata = Omit<ReviewModelFusedResult, "preview">;

/** Durable review metadata omits provider-visible source preview text. */
export const ReviewModelFusedResultMetadataSchema = ReviewModelFusedResultSchema.omit({
  preview: true,
}).strict();

export const toReviewModelFusedResults = (
  fused: FusedResultSet<ReviewResultValue>,
): readonly ReviewModelFusedResult[] => {
  const maximumScore = Math.max(0, ...fused.results.map((result) => result.score));
  return fused.results.map((result) => {
    const expectedKind = result.identity.kind === "chat_message" ? "chat_message" : "document";
    if (result.value.kind !== expectedKind) {
      throw new Error("fused value kind does not match canonical identity");
    }
    return {
      resultId: result.resultId,
      kind: result.value.kind,
      label: result.value.label,
      date: result.value.date,
      tokenCount: result.value.tokenCount,
      preview: result.value.preview,
      normalizedFusedScore: maximumScore === 0 ? 0 : result.score / maximumScore,
      matchedQueryOrdinals: result.matchedQueryOrdinals,
      branchCoverage: fused.coverage,
      truncationFlags: fused.truncation,
    };
  });
};

export const FusedResultSchema = z
  .strictObject({
    resultId: ResultLocalIdSchema,
    identity: CanonicalIdentitySchema,
    identityKey: z.string().min(1),
    physicalIdentities: z.array(CanonicalIdentitySchema).min(1).optional(),
    value: z.unknown(),
    score: z.number().finite().positive(),
    rrfK: positiveSafeInt,
    bestRank: positiveSafeInt,
    date: z.string().nullable(),
    provenance: z
      .array(
        z.strictObject({
          queryOrdinal: positiveSafeInt,
          branch: z.enum(PHYSICAL_QUERY_BRANCHES),
          rank: positiveSafeInt,
          logicalRank: positiveSafeInt.optional(),
        }),
      )
      .min(1),
    matchedQueryOrdinals: z.array(positiveSafeInt),
  })
  .superRefine((result, context) => {
    if (result.identityKey !== canonicalIdentityKey(result.identity)) {
      context.addIssue({
        code: "custom",
        path: ["identityKey"],
        message: "identity key is not canonical",
      });
    }
    const ordinals = [...new Set(result.provenance.map((entry) => entry.queryOrdinal))].sort(
      (left, right) => left - right,
    );
    if (JSON.stringify(ordinals) !== JSON.stringify(result.matchedQueryOrdinals)) {
      context.addIssue({
        code: "custom",
        path: ["matchedQueryOrdinals"],
        message: "query ordinals do not match provenance",
      });
    }
    if (
      result.bestRank !==
      Math.min(...result.provenance.map((entry) => entry.logicalRank ?? entry.rank))
    ) {
      context.addIssue({
        code: "custom",
        path: ["bestRank"],
        message: "best rank does not match provenance",
      });
    }
    const provenanceKeys = result.provenance.map(
      (entry) => `${entry.queryOrdinal}\u0000${entry.branch}`,
    );
    if (new Set(provenanceKeys).size !== provenanceKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["provenance"],
        message: "provenance must be unique",
      });
    }
    for (const [index, entry] of result.provenance.entries()) {
      const identities = (result.physicalIdentities ?? [
        result.identity,
      ]) as RetrievalCanonicalIdentity[];
      if (!identities.some((identity) => identityMatchesBranch(entry.branch, identity))) {
        context.addIssue({
          code: "custom",
          path: ["provenance", index, "branch"],
          message: "provenance branch does not match identity kind",
        });
      }
    }
    const logicalContributions = new Set<string>();
    const expectedScore = result.provenance.reduce((total, entry) => {
      const rank = entry.logicalRank ?? entry.rank;
      const key = `${entry.queryOrdinal}\u0000${rank}`;
      if (logicalContributions.has(key)) return total;
      logicalContributions.add(key);
      return total + reciprocalRankContribution(rank, result.rrfK);
    }, 0);
    if (Math.abs(result.score - expectedScore) > Number.EPSILON * Math.max(1, expectedScore) * 8) {
      context.addIssue({
        code: "custom",
        path: ["score"],
        message: "score does not match provenance",
      });
    }
  });

export const FusionTruncationSchema = z.strictObject({
  branch: z.boolean(),
  candidates: z.boolean(),
  hydration: z.boolean(),
});

export const FusedResultSetSchema = z
  .strictObject({
    results: z.array(FusedResultSchema),
    coverage: z.array(BranchCoverageSchema),
    candidateCountBeforeCap: z.number().int().finite().safe().min(0),
    candidateCap: z.number().int().finite().safe().positive(),
    hydratedBytes: z.number().int().finite().safe().min(0),
    hydrationByteCap: z.number().int().finite().safe().positive().nullable(),
    truncation: FusionTruncationSchema,
  })
  .superRefine((set, context) => {
    if (set.candidateCountBeforeCap < set.results.length) {
      context.addIssue({
        code: "custom",
        path: ["candidateCountBeforeCap"],
        message: "candidate count is below results",
      });
    }
    if (set.candidateCap < set.results.length) {
      context.addIssue({
        code: "custom",
        path: ["candidateCap"],
        message: "candidate cap is below results",
      });
    }
    if (set.hydrationByteCap !== null && set.hydratedBytes > set.hydrationByteCap) {
      context.addIssue({
        code: "custom",
        path: ["hydratedBytes"],
        message: "hydrated bytes exceed cap",
      });
    }
    if (set.hydrationByteCap === null && set.truncation.hydration) {
      context.addIssue({
        code: "custom",
        path: ["truncation", "hydration"],
        message: "hydration cannot truncate without a cap",
      });
    }
    const candidateWasTruncated = set.candidateCountBeforeCap > set.candidateCap;
    if (set.truncation.candidates !== candidateWasTruncated) {
      context.addIssue({
        code: "custom",
        path: ["truncation", "candidates"],
        message: "candidate truncation flag is inconsistent",
      });
    }
    if (set.truncation.branch !== set.coverage.some((coverage) => coverage.truncated)) {
      context.addIssue({
        code: "custom",
        path: ["truncation", "branch"],
        message: "branch truncation flag is inconsistent",
      });
    }
    const resultIds = set.results.map((result) => result.resultId);
    for (let index = 0; index < resultIds.length; index += 1) {
      if (resultIds[index] !== `r${index + 1}`) {
        context.addIssue({
          code: "custom",
          path: ["results", index, "resultId"],
          message: "result IDs must be sequential",
        });
      }
    }
    const coverageKeys = set.coverage.map(
      (coverage) => `${coverage.queryOrdinal}\u0000${coverage.branch}`,
    );
    if (new Set(coverageKeys).size !== coverageKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["coverage"],
        message: "coverage branches must be unique",
      });
    }
    for (let index = 1; index < set.coverage.length; index += 1) {
      const previous = set.coverage[index - 1]!;
      const current = set.coverage[index]!;
      if (
        current.queryOrdinal < previous.queryOrdinal ||
        (current.queryOrdinal === previous.queryOrdinal &&
          PHYSICAL_QUERY_BRANCHES.indexOf(current.branch) <
            PHYSICAL_QUERY_BRANCHES.indexOf(previous.branch))
      ) {
        context.addIssue({
          code: "custom",
          path: ["coverage"],
          message: "coverage must be deterministic",
        });
        break;
      }
    }
    const envelopeError = coverageEnvelopeError(set.coverage);
    if (envelopeError !== null) {
      context.addIssue({ code: "custom", path: ["coverage"], message: envelopeError });
    }
  });
