import type { GetChatResponse } from "@hartlib/shared";

import type { UserScopedConflict } from "./product-chat-stream";

export const chatForRoute = <Chat extends Pick<GetChatResponse, "canWrite">>(
  chatId: string,
  loadedChatId: string | null,
  chat: Chat | null,
): Chat | null => (loadedChatId === chatId ? chat : null);

export const conflictBelongsToRoute = (
  chatId: string,
  conflict: Pick<UserScopedConflict, "chatId"> | null,
): boolean => conflict?.chatId === chatId;
