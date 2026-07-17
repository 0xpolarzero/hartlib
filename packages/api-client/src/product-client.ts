import {
  CreateProductChatResponse,
  GetChatResponse,
  ListMemoriesResponse,
  MemoryRecord,
  MemoryRevisionResponse,
  ProductChatListResponse,
  PublicSourcesResponse,
  SendChatMessageAccepted,
  type CreateProductChatRequest,
  type GetChatResponse as GetChat,
  type MemoryRecord as Memory,
  type MemoryRevisionResponse as MemoryRevisionResult,
  type Market,
  type ProductChatSummary,
  type PublicSourcesResponse as PublicSources,
  type SendChatMessageRequest,
  type SendChatMessageAccepted as AcceptedChatMessage,
} from "@brief/shared";

import { decodeAiRunSse, type AiRunStreamFrame } from "./stream";
import { ApiResponseError, createApiTransport, type ApiTransportOptions } from "./transport";

export type ChatListView = "mine" | "shared";
export type ChatSummary = ProductChatSummary;

export type PublisherDocumentOpenTarget =
  | { readonly kind: "redirected"; readonly url: string }
  | { readonly kind: "direct"; readonly blob: Blob };

export interface CreatedChat {
  readonly id: string;
  readonly memoryMode: "private_owner" | "disabled";
  readonly sourceAccessIds: readonly string[];
  readonly createdAt: string;
}

export interface ProductApiClient {
  readonly fetchPublicSources: (market?: Market) => Promise<PublicSources>;
  readonly setPublicSourceEnabled: (
    sourceId: string,
    enabled: boolean,
    market?: Market,
  ) => Promise<PublicSources>;
  readonly fetchPublisherDocument: (
    issueId: string,
    documentId: string,
  ) => Promise<PublisherDocumentOpenTarget>;
  readonly fetchChats: (view?: ChatListView) => Promise<ChatSummary[]>;
  readonly createChat: (input: CreateProductChatRequest) => Promise<CreatedChat>;
  readonly setChatShared: (chatId: string, shared: boolean) => Promise<void>;
  readonly deleteChat: (chatId: string) => Promise<void>;
  readonly getChat: (chatId?: string) => Promise<GetChat>;
  readonly sendChatMessage: (
    input: SendChatMessageRequest,
    chatId?: string,
  ) => Promise<AcceptedChatMessage>;
  readonly fetchMemories: () => Promise<readonly Memory[]>;
  readonly fetchMemoryRevision: (
    memoryId: string,
    revisionId: string,
  ) => Promise<MemoryRevisionResult>;
  readonly tombstoneMemory: (memoryId: string) => Promise<Memory>;
  readonly revertMemory: (memoryId: string, revisionId: string) => Promise<Memory>;
  readonly streamAiRun: (
    runId: string,
    afterSeq: number,
    signal?: AbortSignal,
  ) => AsyncGenerator<AiRunStreamFrame, void>;
}

export const createProductApiClient = (options: ApiTransportOptions): ProductApiClient => {
  const transport = createApiTransport(options);
  return {
    fetchPublicSources: (market) => {
      const query = market === undefined ? "" : `?market=${encodeURIComponent(market)}`;
      return transport.json(
        "GET /v1/public-sources",
        `/v1/public-sources${query}`,
        PublicSourcesResponse,
      );
    },
    setPublicSourceEnabled: (sourceId, enabled, market) => {
      const query = market === undefined ? "" : `?market=${encodeURIComponent(market)}`;
      return transport.json(
        "PUT /v1/public-sources/:sourceId",
        `/v1/public-sources/${encodeURIComponent(sourceId)}${query}`,
        PublicSourcesResponse,
        { json: { enabled } },
      );
    },
    fetchPublisherDocument: async (issueId, documentId) => {
      const response = await transport.redirectedBinary(
        "GET /v1/issues/:issueId/documents/:documentId/content",
        `/v1/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(documentId)}/content`,
        ["application/pdf"],
        { referrerPolicy: "no-referrer" },
      );
      const finalUrl = safePublisherDocumentRedirect(response.url);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength === 0) {
        throw new ApiResponseError(response.status, "invalid_response_body");
      }
      return { kind: "redirected", url: finalUrl };
    },
    fetchChats: async (view = "mine") => [
      ...(
        await transport.json(
          "GET /v1/chats",
          `/v1/chats?view=${encodeURIComponent(view)}`,
          ProductChatListResponse,
        )
      ).chats,
    ],
    createChat: async (input) =>
      (
        await transport.json("POST /v1/chats", "/v1/chats", CreateProductChatResponse, {
          json: input,
        })
      ).chat,
    setChatShared: async (chatId, shared) => {
      const route = shared ? "POST /v1/chats/:chatId/share" : "POST /v1/chats/:chatId/unshare";
      const path = `/v1/chats/${encodeURIComponent(chatId)}/${shared ? "share" : "unshare"}`;
      await transport.jsonUnknown(route, path);
    },
    deleteChat: (chatId) =>
      transport.empty("DELETE /v1/chats/:chatId", `/v1/chats/${encodeURIComponent(chatId)}`),
    getChat: (chatId) =>
      chatId === undefined
        ? transport.json("GET /v1/chat", "/v1/chat", GetChatResponse)
        : transport.json(
            "GET /v1/chats/:chatId",
            `/v1/chats/${encodeURIComponent(chatId)}`,
            GetChatResponse,
          ),
    sendChatMessage: (input, chatId) =>
      chatId === undefined
        ? transport.json("POST /v1/chat/messages", "/v1/chat/messages", SendChatMessageAccepted, {
            json: input,
          })
        : transport.json(
            "POST /v1/chats/:chatId/messages",
            `/v1/chats/${encodeURIComponent(chatId)}/messages`,
            SendChatMessageAccepted,
            { json: input },
          ),
    fetchMemories: async () =>
      (await transport.json("GET /v1/memories", "/v1/memories", ListMemoriesResponse)).memories,
    fetchMemoryRevision: (memoryId, revisionId) =>
      transport.json(
        "GET /v1/memories/:memoryId/revisions/:revisionId",
        `/v1/memories/${encodeURIComponent(memoryId)}/revisions/${encodeURIComponent(revisionId)}`,
        MemoryRevisionResponse,
      ),
    tombstoneMemory: (memoryId) =>
      transport.json(
        "DELETE /v1/memories/:memoryId",
        `/v1/memories/${encodeURIComponent(memoryId)}`,
        MemoryRecord,
      ),
    revertMemory: (memoryId, revisionId) =>
      transport.json(
        "POST /v1/memories/:memoryId/revert",
        `/v1/memories/${encodeURIComponent(memoryId)}/revert`,
        MemoryRecord,
        { json: { revisionId } },
      ),
    streamAiRun: async function* (runId, afterSeq, signal) {
      const query = afterSeq > 0 ? `?afterSeq=${afterSeq}` : "";
      const response = await transport.sse(
        "GET /v1/ai-runs/:runId/stream",
        `/v1/ai-runs/${encodeURIComponent(runId)}/stream${query}`,
        {
          signal,
          headers: afterSeq > 0 ? { "last-event-id": String(afterSeq) } : undefined,
        },
      );
      let lastSeq = afterSeq;
      for await (const frame of decodeAiRunSse(response, signal)) {
        if (frame.seq !== lastSeq + 1) {
          throw new ApiResponseError(response.status, "invalid_sse_sequence");
        }
        lastSeq = frame.seq;
        yield frame;
        if (frame.event.type === "done" || frame.event.type === "error") return;
      }
    },
  };
};

const publisherDocumentLoopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

const safePublisherDocumentRedirect = (raw: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    throw new ApiResponseError(0, "invalid_response_redirect", undefined, { cause });
  }
  const loopbackHttp =
    parsed.protocol === "http:" &&
    publisherDocumentLoopbackHosts.has(parsed.hostname.toLowerCase());
  if (
    (parsed.protocol !== "https:" && !loopbackHttp) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new ApiResponseError(0, "invalid_response_redirect");
  }
  return parsed.toString();
};
