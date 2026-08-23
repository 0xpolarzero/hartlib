import {
  ApiResponseError,
  createProductApiClient,
  type ChatListView,
  type ChatSummary,
  type CreatedChat,
} from "@hartlib/api-client";
import type { CreateProductChatRequest, MemoryRecord } from "@hartlib/shared";

import { authenticatedFetch } from "./api-auth";

const client = createProductApiClient({ fetch: authenticatedFetch });

export { ApiResponseError };
export type { ChatListView, ChatSummary, CreatedChat };
export type CreateChatInput = CreateProductChatRequest;

export const fetchChats = client.fetchChats;
export const createChat = client.createChat;
export const setChatShared = client.setChatShared;
export const deleteChat = client.deleteChat;
export const getChat = client.getChat;
export const sendChatMessage = client.sendChatMessage;
export const streamAiRun = client.streamAiRun;
export const fetchAiRunDebug = client.fetchAiRunDebug;
export const fetchPublisherDocument = client.fetchPublisherDocument;
export const fetchMemories = client.fetchMemories;
export const fetchMemoryRevision = client.fetchMemoryRevision;
export const tombstoneMemory = client.tombstoneMemory;
export const revertMemory = client.revertMemory;

// Keeps the app-facing return type explicit while the implementation lives in
// the shared authenticated transport package.
export type Memory = MemoryRecord;
