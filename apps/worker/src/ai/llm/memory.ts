import type { ProposedMemory, DiscardedMemoryProposal, ExistingMemory } from "./types";

const normalizeMemoryContent = (content: string): string => content.trim().replace(/\s+/g, " ");

const memoryKey = (memory: Pick<ProposedMemory, "kind" | "content">): string =>
  `${memory.kind}:${normalizeMemoryContent(memory.content).toLocaleLowerCase()}`;

export const verifyMemoryProposals = (
  proposals: readonly ProposedMemory[],
  userText: string,
  existingMemories: readonly ExistingMemory[],
  maxWrites: number,
): {
  readonly accepted: readonly ProposedMemory[];
  readonly discarded: readonly DiscardedMemoryProposal[];
} => {
  const accepted: ProposedMemory[] = [];
  const discarded: DiscardedMemoryProposal[] = [];
  const seen = new Set(existingMemories.map(memoryKey));

  for (const proposal of proposals) {
    const normalizedContent = normalizeMemoryContent(proposal.content);
    const normalizedProposal: ProposedMemory = {
      ...proposal,
      content: normalizedContent,
      evidenceQuote: proposal.evidenceQuote,
    };

    if (normalizedContent.length === 0) {
      discarded.push({ proposal: normalizedProposal, reason: "empty_content" });
      continue;
    }

    if (proposal.evidenceQuote.length === 0 || !userText.includes(proposal.evidenceQuote)) {
      discarded.push({ proposal: normalizedProposal, reason: "invalid_quote" });
      continue;
    }

    const key = memoryKey(normalizedProposal);
    if (seen.has(key)) {
      discarded.push({ proposal: normalizedProposal, reason: "duplicate" });
      continue;
    }

    if (accepted.length >= maxWrites) {
      discarded.push({ proposal: normalizedProposal, reason: "write_cap" });
      continue;
    }

    seen.add(key);
    accepted.push(normalizedProposal);
  }

  return { accepted, discarded };
};
