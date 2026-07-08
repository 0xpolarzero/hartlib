import { parseBlockNumber, renderBlock, type RenderableBlock } from "./blocks";

export interface ChatHistoryMessage {
  readonly author: "user" | "assistant";
  readonly content: string;
}

export interface AssembleContextWindowInput {
  readonly systemPrompt: string;
  readonly memoryBlock: RenderableBlock | null;
  readonly blocks: readonly RenderableBlock[];
  readonly history: readonly ChatHistoryMessage[];
  readonly userMessage: string;
  readonly historyMaxMessages: number;
}

export interface AssembledPrompt {
  readonly system: string;
  readonly messages: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly content: string;
  }>;
}

const blockNumberForOrdering = (blockId: string): number => {
  const blockNumber = parseBlockNumber(blockId);

  return blockNumber ?? Number.POSITIVE_INFINITY;
};

export const assembleContextWindow = (input: AssembleContextWindowInput): AssembledPrompt => {
  const renderedBlocks = input.blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.kind !== "memory")
    .sort((left, right) => {
      const order =
        blockNumberForOrdering(left.block.blockId) - blockNumberForOrdering(right.block.blockId);

      return order === 0 ? left.index - right.index : order;
    })
    .map(({ block }) => renderBlock(block));
  const systemParts = [
    input.systemPrompt,
    ...(input.memoryBlock === null ? [] : [renderBlock(input.memoryBlock)]),
    ...renderedBlocks,
  ];
  const history =
    input.historyMaxMessages <= 0
      ? []
      : input.history.slice(Math.max(input.history.length - input.historyMaxMessages, 0));
  const messages = [
    ...history.map((message) => ({ role: message.author, content: message.content })),
    { role: "user" as const, content: input.userMessage },
  ];

  return {
    system: systemParts.join("\n\n"),
    messages,
  };
};
