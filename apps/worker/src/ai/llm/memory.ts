import type { ProposedMemory, DiscardedMemoryProposal, ExistingMemory } from "./types";

const normalizeMemoryContent = (content: string): string => content.trim();

const memoryKey = (memory: Pick<ProposedMemory, "kind" | "content">): string =>
  `${memory.kind}\u0000${normalizeMemoryContent(memory.content)}`;

export const prepareMemoryProposals = (
  proposals: readonly ProposedMemory[],
  existingMemories: readonly ExistingMemory[],
): {
  readonly accepted: readonly ProposedMemory[];
  readonly discarded: readonly DiscardedMemoryProposal[];
} => {
  const accepted: ProposedMemory[] = [];
  const discarded: DiscardedMemoryProposal[] = [];
  const seen = new Set(existingMemories.map(memoryKey));
  const existingIds = new Set(existingMemories.map((memory) => memory.id));

  for (const proposal of proposals) {
    const normalizedContent = normalizeMemoryContent(proposal.content);
    const normalizedProposal: ProposedMemory = {
      ...proposal,
      content: normalizedContent,
    };

    if (normalizedContent.length === 0) {
      discarded.push({ proposal: normalizedProposal, reason: "empty_content" });
      continue;
    }

    if (
      normalizedProposal.targetMemoryId !== undefined &&
      !existingIds.has(normalizedProposal.targetMemoryId)
    ) {
      discarded.push({ proposal: normalizedProposal, reason: "unknown_target" });
      continue;
    }

    const key = memoryKey(normalizedProposal);
    if (seen.has(key)) {
      discarded.push({ proposal: normalizedProposal, reason: "duplicate" });
      continue;
    }

    seen.add(key);
    accepted.push(normalizedProposal);
  }

  return { accepted, discarded };
};
