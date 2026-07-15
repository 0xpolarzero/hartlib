import type { CreateChatInput } from "./api";

export const buildCreateChatInput = (
  companyId: string,
  memoryMode: "private_owner" | "disabled",
  sourceAccessIds: readonly string[],
): CreateChatInput => {
  if (new Set(sourceAccessIds).size !== sourceAccessIds.length) {
    throw new Error("chat_sources_must_be_unique");
  }
  return { companyId, memoryMode, sourceAccessIds: [...sourceAccessIds] };
};
