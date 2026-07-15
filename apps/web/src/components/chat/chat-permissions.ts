import type { GetChatResponse } from "@brief/shared";

export const chatComposerEnabled = (chat: Pick<GetChatResponse, "canWrite"> | null): boolean =>
  chat?.canWrite === true;
