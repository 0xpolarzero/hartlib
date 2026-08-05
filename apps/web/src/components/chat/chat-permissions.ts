import type { GetChatResponse } from "@hartlib/shared";

type ChatArchiveProjection = {
  readonly chat: Pick<GetChatResponse["chat"], "archivedAt">;
};

export const chatComposerEnabled = (
  chat: (Pick<GetChatResponse, "canWrite"> & ChatArchiveProjection) | null,
): boolean => chat?.canWrite === true && chat.chat.archivedAt === null;

export const chatIsArchived = (chat: ChatArchiveProjection | null): boolean =>
  chat?.chat.archivedAt !== null && chat?.chat.archivedAt !== undefined;
