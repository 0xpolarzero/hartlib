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

export const planWindow = (input: PlanWindowInput): WindowPlan => {
  let idCounter = input.nextBlockNumber;
  const activeMemory = selectActiveMemory(input.activeBlocks);
  const newBody = renderMemoryBody(input.memories);
  const memory: MemoryPlan =
    input.memories.length === 0
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
              memoryIds: input.memories.map((memoryItem) => memoryItem.id),
            },
          };

  const duplicates: DuplicateManifestEntry[] = [];
  const dropped: DroppedManifestEntry[] = [];
  const acceptedCandidates: NormalizedCandidate[] = [];

  for (const entry of input.manifest) {
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
      duplicates.push({
        documentId: candidate.documentId,
        charStart: candidate.charStart,
        charEnd: candidate.charEnd,
        coveredByBlockId: coveringActiveBlock.blockId,
      });
      continue;
    }

    const coveredByAcceptedCandidate = acceptedCandidates.some((accepted) =>
      acceptedCandidateCoversCandidate(accepted, candidate),
    );

    if (coveredByAcceptedCandidate) {
      duplicates.push({
        documentId: candidate.documentId,
        charStart: candidate.charStart,
        charEnd: candidate.charEnd,
        coveredByBlockId: null,
      });
      continue;
    }

    acceptedCandidates.push(candidate);
  }

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

  while (baseTokens + acceptedTokenTotal > input.budget.hardCap && acceptedCandidates.length > 0) {
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

  if (totalActiveTokensBeforeEviction > input.budget.blockBudget) {
    const evictionPool = input.activeBlocks
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => block.kind === "document" && !block.pinned)
      .sort((left, right) => {
        const order =
          blockNumberForOrdering(left.block.blockId) - blockNumberForOrdering(right.block.blockId);

        return order === 0 ? left.index - right.index : order;
      });

    for (const { block } of evictionPool) {
      if (totalActiveTokensAfterEviction <= input.budget.blockBudget) {
        break;
      }

      totalActiveTokensAfterEviction -= block.tokenEstimate;
      evictions.push({ blockId: block.blockId, reason: "over_budget" });
    }
  }

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
