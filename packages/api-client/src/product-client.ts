import {
  AiRunStopResponse,
  DemoSessionResponse,
  GetChatResponse,
  ListMemoriesResponse,
  MemoryRecord,
  MemoryRevisionResponse,
  PublicAiRunDebugResponse,
  PublicSourcesResponse,
  ResetDemoSessionRequest,
  ResetDemoSessionResponse,
  SendChatMessageAccepted,
  SendChatMessageRequest,
  type ChatMarket,
  type ChatLocale,
  type MemoryRecord as Memory,
} from "@hartlib/shared";
import { Schema } from "effect";
import { decodeAiRunSse, type AiRunStreamFrame } from "./stream";
import { ApiResponseError, createApiTransport, type ApiTransportOptions } from "./transport";

export type Market = ChatMarket;
export type Locale = ChatLocale;

export type PublisherDocumentOpenTarget =
  | { readonly kind: "redirected"; readonly url: string }
  | { readonly kind: "direct"; readonly blob: Blob };

export interface ProductApiClient {
  readonly fetchPublicSources: (
    market?: Market,
  ) => Promise<Schema.Schema.Type<typeof PublicSourcesResponse>>;
  readonly setPublicSourceEnabled: (
    sourceId: string,
    enabled: boolean,
    market?: Market,
  ) => Promise<Schema.Schema.Type<typeof PublicSourcesResponse>>;
  readonly fetchPublisherDocument: (
    issueId: string,
    documentId: string,
  ) => Promise<PublisherDocumentOpenTarget>;
  readonly fetchPublicSourceDocument: (documentId: string) => Promise<PublisherDocumentOpenTarget>;
  readonly createDemoSession: () => Promise<Schema.Schema.Type<typeof DemoSessionResponse>>;
  readonly forceResetDemoSession: (
    resetOperationId: Schema.Schema.Type<typeof ResetDemoSessionRequest>["resetOperationId"],
  ) => Promise<Schema.Schema.Type<typeof ResetDemoSessionResponse>>;
  readonly getChat: () => Promise<Schema.Schema.Type<typeof GetChatResponse>>;
  readonly sendChatMessage: (
    input: Schema.Schema.Type<typeof SendChatMessageRequest>,
  ) => Promise<Schema.Schema.Type<typeof SendChatMessageAccepted>>;
  readonly editChatMessage: (
    messageId: string,
    input: Schema.Schema.Type<typeof SendChatMessageRequest>,
  ) => Promise<Schema.Schema.Type<typeof SendChatMessageAccepted>>;
  readonly deleteChatMessage: (messageId: string) => Promise<void>;
  readonly stopAiRun: (runId: string) => Promise<Schema.Schema.Type<typeof AiRunStopResponse>>;
  readonly fetchMemories: () => Promise<readonly Memory[]>;
  readonly fetchMemoryRevision: (
    memoryId: string,
    revisionId: string,
  ) => Promise<Schema.Schema.Type<typeof MemoryRevisionResponse>>;
  readonly tombstoneMemory: (memoryId: string) => Promise<Memory>;
  readonly revertMemory: (memoryId: string, revisionId: string) => Promise<Memory>;
  readonly streamAiRun: (
    runId: string,
    afterSeq?: number,
    signal?: AbortSignal,
  ) => AsyncGenerator<AiRunStreamFrame, void>;
  readonly fetchAiRunDebug: (
    runId: string,
  ) => Promise<Schema.Schema.Type<typeof PublicAiRunDebugResponse>>;
}

export const createProductApiClient = (options: ApiTransportOptions): ProductApiClient => {
  const transport = createApiTransport(options);
  const targetUrl = (path: string): string =>
    options.baseUrl === undefined || options.baseUrl === ""
      ? path
      : new URL(path, options.baseUrl).toString();
  const sourceQuery = (market?: Market) =>
    market === undefined ? "" : `?market=${encodeURIComponent(market)}`;
  return {
    fetchPublicSources: (market) =>
      transport.json(
        "GET /v1/public-sources",
        `/v1/public-sources${sourceQuery(market)}`,
        PublicSourcesResponse,
      ),
    setPublicSourceEnabled: (sourceId, enabled, market) =>
      transport.json(
        "PUT /v1/public-sources/:sourceId",
        `/v1/public-sources/${encodeURIComponent(sourceId)}${sourceQuery(market)}`,
        PublicSourcesResponse,
        { json: { enabled } },
      ),
    fetchPublisherDocument: async (issueId, documentId) => {
      const response = await transport.redirectedBinary(
        "GET /v1/issues/:issueId/documents/:documentId/content",
        `/v1/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(documentId)}/content`,
        ["application/pdf", "text/html"],
        { referrerPolicy: "no-referrer" },
      );
      const finalUrl = safePublisherDocumentRedirect(response.url);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength === 0)
        throw new ApiResponseError(response.status, "invalid_response_body");
      return { kind: "redirected", url: finalUrl };
    },
    fetchPublicSourceDocument: async (documentId) => {
      const path = `/public-source-documents/${encodeURIComponent(documentId)}/content`;
      const response = await transport.binary(
        "GET /public-source-documents/:documentId/content",
        path,
        { referrerPolicy: "no-referrer" },
      );
      if (response.body !== null) await response.body.cancel("validated authenticated document");
      return { kind: "redirected", url: targetUrl(path) };
    },
    createDemoSession: () =>
      transport.json("POST /v1/demo/session", "/v1/demo/session", DemoSessionResponse),
    forceResetDemoSession: (resetOperationId) =>
      transport.json(
        "POST /v1/demo/session/reset",
        "/v1/demo/session/reset",
        ResetDemoSessionResponse,
        { json: { resetOperationId } },
      ),
    getChat: () => transport.json("GET /v1/chat", "/v1/chat", GetChatResponse),
    sendChatMessage: (input) =>
      transport.json("POST /v1/chat/messages", "/v1/chat/messages", SendChatMessageAccepted, {
        json: input,
      }),
    editChatMessage: (messageId, input) =>
      transport.json(
        "PATCH /v1/chat/messages/:messageId",
        `/v1/chat/messages/${encodeURIComponent(messageId)}`,
        SendChatMessageAccepted,
        { json: input },
      ),
    deleteChatMessage: (messageId) =>
      transport.empty(
        "DELETE /v1/chat/messages/:messageId",
        `/v1/chat/messages/${encodeURIComponent(messageId)}`,
      ),
    stopAiRun: (runId) =>
      transport.json(
        "POST /v1/ai-runs/:runId/stop",
        `/v1/ai-runs/${encodeURIComponent(runId)}/stop`,
        AiRunStopResponse,
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
    streamAiRun: async function* (runId, afterSeq = 0, signal) {
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
        if (frame.seq !== lastSeq + 1)
          throw new ApiResponseError(response.status, "invalid_sse_sequence");
        lastSeq = frame.seq;
        yield frame;
        if (
          frame.event.type === "done" ||
          frame.event.type === "error" ||
          frame.event.type === "stopped"
        )
          return;
      }
    },
    fetchAiRunDebug: (runId) =>
      transport.json(
        "GET /v1/ai-runs/:runId/debug",
        `/v1/ai-runs/${encodeURIComponent(runId)}/debug`,
        PublicAiRunDebugResponse,
      ),
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
  )
    throw new ApiResponseError(0, "invalid_response_redirect");
  return parsed.toString();
};
