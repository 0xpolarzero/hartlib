import { estimateTokens } from "../retrieval/query-spec";
import {
  formatBlockId,
  parseBlockNumber,
  renderMemoryBody,
  type BlockKind,
  type DocumentMeta,
  type ManifestEntry,
  type MemoryItem,
} from "./blocks";

export interface WindowBudget {
  readonly blockBudget: number;
  readonly hardCap: number;
  readonly fullDocMaxChars: number;
  readonly memoryInjectAllMaxTokens?: number | undefined;
}

export interface ActiveBlock {
  readonly blockId: string;
  readonly kind: BlockKind;
  readonly content: string;
  readonly tokenEstimate: number;
  readonly documentId: string | null;
  readonly charStart: number | null;
  readonly charEnd: number | null;
  readonly pinned: boolean;
}

export interface PlanWindowInput {
  readonly manifest: readonly ManifestEntry[];
  readonly documents: ReadonlyMap<string, DocumentMeta>;
  readonly activeBlocks: readonly ActiveBlock[];
  readonly nextBlockNumber: number;
  readonly memories: readonly MemoryItem[];
  readonly userMessage?: string | undefined;
  readonly budget: WindowBudget;
}

export interface PlannedDocumentBlock {
  readonly blockId: string;
  readonly documentId: string;
  readonly charStart: number | null;
  readonly charEnd: number | null;
  readonly bodyCharCount: number;
  readonly tokenEstimate: number;
  readonly truncated: boolean;
  readonly meta: DocumentMeta;
}

export interface PlannedMemoryBlock {
  readonly blockId: string;
  readonly content: string;
  readonly tokenEstimate: number;
  readonly memoryIds: readonly string[];
}

export type MemoryPlan =
  | { readonly kind: "none" }
  | { readonly kind: "keep"; readonly blockId: string }
  | { readonly kind: "retire"; readonly retiredBlockId: string }
  | {
      readonly kind: "append";
      readonly block: PlannedMemoryBlock;
      readonly retiredBlockId: string | null;
    };

export interface DroppedManifestEntry {
  readonly documentId: string;
  readonly charStart: number | null;
  readonly charEnd: number | null;
  readonly tokenEstimate: number | null;
  readonly reason: "hard_cap" | "document_not_found";
}

export interface DuplicateManifestEntry {
  readonly documentId: string;
  readonly charStart: number | null;
  readonly charEnd: number | null;
  readonly coveredByBlockId: string | null;
}

export interface Eviction {
  readonly blockId: string;
  readonly reason: "over_budget";
}

export interface WindowPlan {
  readonly memory: MemoryPlan;
  readonly additions: readonly PlannedDocumentBlock[];
  readonly duplicates: readonly DuplicateManifestEntry[];
  readonly dropped: readonly DroppedManifestEntry[];
  readonly evictions: readonly Eviction[];
  readonly totalActiveTokensBeforeEviction: number;
  readonly totalActiveTokensAfterEviction: number;
}

interface NormalizedCandidate {
  readonly documentId: string;
  readonly charStart: number | null;
  readonly charEnd: number | null;
  readonly intervalStart: number;
  readonly intervalEnd: number;
  readonly bodyCharCount: number;
  readonly tokenEstimate: number;
  readonly truncated: boolean;
  readonly meta: DocumentMeta;
}

interface StandingDuplicateRecord {
  readonly kind: "standing";
  readonly manifestIndex: number;
  readonly duplicate: DuplicateManifestEntry;
}

interface IntraManifestDuplicateRecord {
  readonly kind: "intra_manifest";
  readonly manifestIndex: number;
  readonly candidate: NormalizedCandidate;
  readonly coveringCandidate: NormalizedCandidate;
  readonly duplicate: DuplicateManifestEntry;
}

type DuplicateRecord = StandingDuplicateRecord | IntraManifestDuplicateRecord;

const isIntraManifestDuplicateRecord = (
  record: DuplicateRecord,
): record is IntraManifestDuplicateRecord => record.kind === "intra_manifest";

export const remainingBlockBudget = (activeTokens: number, blockBudget: number): number =>
  Math.max(blockBudget - activeTokens, 0);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const isFiniteNumber = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value);

const blockNumberForOrdering = (blockId: string): number => {
  const blockNumber = parseBlockNumber(blockId);

  return blockNumber ?? Number.POSITIVE_INFINITY;
};

const selectActiveMemory = (activeBlocks: readonly ActiveBlock[]): ActiveBlock | null => {
  const memoryBlocks = activeBlocks.filter((block) => block.kind === "memory");

  if (memoryBlocks.length === 0) {
    return null;
  }

  return memoryBlocks.reduce((selected, block) => {
    const selectedNumber = parseBlockNumber(selected.blockId) ?? -1;
    const blockNumber = parseBlockNumber(block.blockId) ?? -1;

    return blockNumber > selectedNumber ? block : selected;
  });
};

const normalizeCandidate = (
  entry: ManifestEntry,
  meta: DocumentMeta,
  budget: WindowBudget,
): NormalizedCandidate => {
  const finiteCharStart = isFiniteNumber(entry.charStart) ? entry.charStart : undefined;
  const finiteCharEnd = isFiniteNumber(entry.charEnd) ? entry.charEnd : undefined;
  const hasRange = finiteCharStart !== undefined || finiteCharEnd !== undefined;
  const start = clamp(Math.floor(finiteCharStart ?? 0), 0, meta.textCharCount);
  const end = clamp(Math.floor(finiteCharEnd ?? meta.textCharCount), start, meta.textCharCount);
  const rangeValid = hasRange && end > start;

  if (meta.textCharCount <= budget.fullDocMaxChars) {
    return {
      documentId: entry.documentId,
      charStart: null,
      charEnd: null,
      intervalStart: 0,
      intervalEnd: meta.textCharCount,
      bodyCharCount: meta.textCharCount,
      tokenEstimate: estimateTokens(meta.textCharCount),
      truncated: false,
      meta,
    };
  }

  if (rangeValid) {
    const bodyCharCount = end - start;

    return {
      documentId: entry.documentId,
      charStart: start,
      charEnd: end,
      intervalStart: start,
      intervalEnd: end,
      bodyCharCount,
      tokenEstimate: estimateTokens(bodyCharCount),
      truncated: false,
      meta,
    };
  }

  return {
    documentId: entry.documentId,
    charStart: 0,
    charEnd: budget.fullDocMaxChars,
    intervalStart: 0,
    intervalEnd: budget.fullDocMaxChars,
    bodyCharCount: budget.fullDocMaxChars,
    tokenEstimate: estimateTokens(budget.fullDocMaxChars),
    truncated: true,
    meta,
  };
};

const activeBlockCoversCandidate = (
  block: ActiveBlock,
  candidate: NormalizedCandidate,
): boolean => {
  if (block.kind !== "document" || block.documentId !== candidate.documentId) {
    return false;
  }

  if (block.charStart === null && block.charEnd === null) {
    return true;
  }

  if (block.charStart === null || block.charEnd === null) {
    return false;
  }

  return block.charStart <= candidate.intervalStart && candidate.intervalEnd <= block.charEnd;
};

const acceptedCandidateCoversCandidate = (
  accepted: NormalizedCandidate,
  candidate: NormalizedCandidate,
): boolean => {
  if (accepted.documentId !== candidate.documentId) {
    return false;
  }

  if (accepted.charStart === null && accepted.charEnd === null) {
    return true;
  }

  return (
    accepted.intervalStart <= candidate.intervalStart &&
    candidate.intervalEnd <= accepted.intervalEnd
  );
};

const retiredMemoryBlockId = (memory: MemoryPlan): string | null => {
  if (memory.kind === "retire") {
    return memory.retiredBlockId;
  }

  if (memory.kind === "append") {
    return memory.retiredBlockId;
  }

  return null;
};

const appendedMemoryTokenEstimate = (memory: MemoryPlan): number => {
  if (memory.kind !== "append") {
    return 0;
  }

  return memory.block.tokenEstimate;
};

const alwaysInjectedMemoryKinds = new Set(["profile", "preference", "instruction"]);

const termsForOverlap = (text: string): ReadonlySet<string> =>
  new Set(
    text
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((term) => term.length >= 2) ?? [],
  );

const overlapCount = (memory: MemoryItem, userTerms: ReadonlySet<string>): number => {
  if (userTerms.size === 0) {
    return 0;
  }

  const memoryTerms = termsForOverlap(memory.content);
  let count = 0;
  for (const term of memoryTerms) {
    if (userTerms.has(term)) {
      count += 1;
    }
  }
  return count;
};

export const selectMemoriesForInjection = (
  memories: readonly MemoryItem[],
  userMessage: string,
  injectAllMaxTokens: number,
): readonly MemoryItem[] => {
  const stableThreshold =
    Number.isFinite(injectAllMaxTokens) && injectAllMaxTokens > 0
      ? Math.floor(injectAllMaxTokens)
      : 0;
  const retrievable = memories.filter((memory) => !alwaysInjectedMemoryKinds.has(memory.kind));
  const retrievableTokenEstimate = estimateTokens(renderMemoryBody(retrievable).length);

  if (retrievableTokenEstimate <= stableThreshold) {
    return memories;
  }

  const userTerms = termsForOverlap(userMessage);
  let selectedTokens = 0;
  const selectedIds = new Set<string>();

  const scored = retrievable
    .map((memory, index) => ({
      memory,
      index,
      tokenEstimate: estimateTokens(renderMemoryBody([memory]).length),
      score: overlapCount(memory, userTerms) * 1000 + index,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);

  for (const item of scored) {
    if (item.tokenEstimate > stableThreshold - selectedTokens) {
      continue;
    }
    selectedTokens += item.tokenEstimate;
    selectedIds.add(item.memory.id);
  }

  return memories.filter(
    (memory) => alwaysInjectedMemoryKinds.has(memory.kind) || selectedIds.has(memory.id),
  );
};

export const planWindow = (input: PlanWindowInput): WindowPlan => {
  let idCounter = input.nextBlockNumber;
  const activeMemory = selectActiveMemory(input.activeBlocks);
  const injectedMemories = selectMemoriesForInjection(
    input.memories,
    input.userMessage ?? "",
    input.budget.memoryInjectAllMaxTokens ?? 1500,
  );
  const newBody = renderMemoryBody(injectedMemories);
  const memory: MemoryPlan =
    injectedMemories.length === 0
      ? activeMemory === null
        ? { kind: "none" }
        : { kind: "retire", retiredBlockId: activeMemory.blockId }
      : activeMemory !== null && activeMemory.content === newBody
        ? { kind: "keep", blockId: activeMemory.blockId }
        : {
            kind: "append",
            retiredBlockId: activeMemory?.blockId ?? null,
            block: {
              blockId: formatBlockId(idCounter++),
              content: newBody,
              tokenEstimate: estimateTokens(newBody.length),
              memoryIds: injectedMemories.map((memoryItem) => memoryItem.id),
            },
          };

  let duplicateRecords: DuplicateRecord[] = [];
  const dropped: DroppedManifestEntry[] = [];
  const acceptedCandidates: NormalizedCandidate[] = [];
  const protectedBlockIds = new Set<string>();

  for (const [manifestIndex, entry] of input.manifest.entries()) {
    const meta = input.documents.get(entry.documentId);

    if (meta === undefined) {
      dropped.push({
        documentId: entry.documentId,
        charStart: entry.charStart ?? null,
        charEnd: entry.charEnd ?? null,
        tokenEstimate: null,
        reason: "document_not_found",
      });
      continue;
    }

    const candidate = normalizeCandidate(entry, meta, input.budget);
    const coveringActiveBlock = input.activeBlocks.find((block) =>
      activeBlockCoversCandidate(block, candidate),
    );

    if (coveringActiveBlock !== undefined) {
      protectedBlockIds.add(coveringActiveBlock.blockId);
      duplicateRecords.push({
        kind: "standing",
        manifestIndex,
        duplicate: {
          documentId: candidate.documentId,
          charStart: candidate.charStart,
          charEnd: candidate.charEnd,
          coveredByBlockId: coveringActiveBlock.blockId,
        },
      });
      continue;
    }

    const coveringAcceptedCandidate = acceptedCandidates.find((accepted) =>
      acceptedCandidateCoversCandidate(accepted, candidate),
    );

    if (coveringAcceptedCandidate !== undefined) {
      duplicateRecords.push({
        kind: "intra_manifest",
        manifestIndex,
        candidate,
        coveringCandidate: coveringAcceptedCandidate,
        duplicate: {
          documentId: candidate.documentId,
          charStart: candidate.charStart,
          charEnd: candidate.charEnd,
          coveredByBlockId: null,
        },
      });
      continue;
    }

    acceptedCandidates.push(candidate);
  }

  const evictionPool = input.activeBlocks
    .map((block, index) => ({ block, index }))
    .filter(
      ({ block }) =>
        block.kind === "document" && !block.pinned && !protectedBlockIds.has(block.blockId),
    )
    .sort((left, right) => {
      const order =
        blockNumberForOrdering(left.block.blockId) - blockNumberForOrdering(right.block.blockId);

      return order === 0 ? left.index - right.index : order;
    });
  const retiredBlockId = retiredMemoryBlockId(memory);
  const baseTokens =
    input.activeBlocks.reduce(
      (sum, block) => sum + (block.blockId === retiredBlockId ? 0 : block.tokenEstimate),
      0,
    ) + appendedMemoryTokenEstimate(memory);
  let acceptedTokenTotal = acceptedCandidates.reduce(
    (sum, candidate) => sum + candidate.tokenEstimate,
    0,
  );
  const evictableTokens = evictionPool.reduce((sum, { block }) => sum + block.tokenEstimate, 0);
  const floorBase = baseTokens - evictableTokens;

  while (floorBase + acceptedTokenTotal > input.budget.hardCap) {
    const candidate = acceptedCandidates.pop();

    if (candidate === undefined) {
      break;
    }

    acceptedTokenTotal -= candidate.tokenEstimate;
    dropped.push({
      documentId: candidate.documentId,
      charStart: candidate.charStart,
      charEnd: candidate.charEnd,
      tokenEstimate: candidate.tokenEstimate,
      reason: "hard_cap",
    });

    const orphanedRecords = duplicateRecords
      .filter(isIntraManifestDuplicateRecord)
      .filter((record) => record.coveringCandidate === candidate)
      .sort((left, right) => left.manifestIndex - right.manifestIndex);

    for (const record of orphanedRecords) {
      const coveringCandidate = acceptedCandidates.find((accepted) =>
        acceptedCandidateCoversCandidate(accepted, record.candidate),
      );

      if (coveringCandidate !== undefined) {
        duplicateRecords = duplicateRecords.map((currentRecord) =>
          currentRecord === record ? { ...record, coveringCandidate } : currentRecord,
        );
        continue;
      }

      duplicateRecords = duplicateRecords.filter((currentRecord) => currentRecord !== record);
      acceptedCandidates.push(record.candidate);
      acceptedTokenTotal += record.candidate.tokenEstimate;
    }
  }

  const additions: PlannedDocumentBlock[] = acceptedCandidates.map((candidate) => ({
    blockId: formatBlockId(idCounter++),
    documentId: candidate.documentId,
    charStart: candidate.charStart,
    charEnd: candidate.charEnd,
    bodyCharCount: candidate.bodyCharCount,
    tokenEstimate: candidate.tokenEstimate,
    truncated: candidate.truncated,
    meta: candidate.meta,
  }));
  const totalActiveTokensBeforeEviction = baseTokens + acceptedTokenTotal;
  const evictions: Eviction[] = [];
  let totalActiveTokensAfterEviction = totalActiveTokensBeforeEviction;
  const evictionTarget = Math.min(input.budget.blockBudget, input.budget.hardCap);

  if (totalActiveTokensBeforeEviction > evictionTarget) {
    for (const { block } of evictionPool) {
      if (totalActiveTokensAfterEviction <= evictionTarget) {
        break;
      }

      totalActiveTokensAfterEviction -= block.tokenEstimate;
      evictions.push({ blockId: block.blockId, reason: "over_budget" });
    }
  }

  const duplicates = duplicateRecords
    .sort((left, right) => left.manifestIndex - right.manifestIndex)
    .map((record) => record.duplicate);

  return {
    memory,
    additions,
    duplicates,
    dropped,
    evictions,
    totalActiveTokensBeforeEviction,
    totalActiveTokensAfterEviction,
  };
};
