import { describe, expect, it } from "vitest";

import { createProductApiClient } from "./product-client";

describe("product API client", () => {
  it("uses singular chat and reset endpoints", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const client = createProductApiClient({
      baseUrl: "https://api.hartlib.example",
      fetch: async (input, init) => {
        calls.push(init === undefined ? { url: String(input) } : { url: String(input), init });
        if (String(input).endsWith("/v1/chat")) {
          return Response.json({
            chat: {
              id: "chat",
              memoryMode: "private_owner",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            messages: [],
            effectiveWebPolicy: {
              enabled: false,
              reason: "deployment_unavailable",
              allowlistActive: false,
            },
            activeRun: null,
            canWrite: true,
          });
        }
        return Response.json(
          { ok: true },
          String(input).endsWith("/v1/demo/session/reset") ? { status: 202 } : undefined,
        );
      },
    });
    await client.getChat();
    await client.forceResetDemoSession("11111111-1111-4111-8111-111111111111");
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.hartlib.example/v1/chat",
      "https://api.hartlib.example/v1/demo/session/reset",
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      resetOperationId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("sends, edits, deletes, and stops through the final routes", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const client = createProductApiClient({
      fetch: async (input, init) => {
        calls.push(init === undefined ? { url: String(input) } : { url: String(input), init });
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        if (String(input).endsWith("/stop"))
          return Response.json({ runId: "run" }, { status: 202 });
        return Response.json(
          {
            message: {
              id: "message",
              author: "user",
              content: "question",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            run: { id: "run", status: "queued", streamPath: "/v1/ai-runs/run/stream" },
          },
          { status: 202 },
        );
      },
    });
    const input = {
      text: "question",
      locale: "en-US" as const,
      market: "US" as const,
      webSearchEnabled: false,
    };
    await client.sendChatMessage(input);
    await client.editChatMessage("message", input);
    await client.deleteChatMessage("message");
    await client.stopAiRun("run");
    expect(calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`)).toEqual([
      "POST /v1/chat/messages",
      "PATCH /v1/chat/messages/message",
      "DELETE /v1/chat/messages/message",
      "POST /v1/ai-runs/run/stop",
    ]);
  });

  it("covers public sources, secure documents, debug, and memory methods", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const revision = {
      id: "revision-1",
      action: "create" as const,
      before: null,
      after: { kind: "preference", content: "Concise answers", deleted: false },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const memory = {
      id: "memory-1",
      headRevisionId: "revision-1",
      current: revision.after,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      revisions: [revision],
    };
    const redirectedResponse = new Response("pdf", {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });
    Object.defineProperties(redirectedResponse, {
      redirected: { value: true },
      url: { value: "https://documents.hartlib.example/issue-1/document-1.pdf" },
    });
    const client = createProductApiClient({
      baseUrl: "https://api.hartlib.example",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init === undefined ? {} : { init }) });
        if (url.includes("/v1/public-sources"))
          return Response.json({ sources: [], publications: [] });
        if (url.includes("/v1/issues/")) return redirectedResponse;
        if (url.includes("/public-source-documents/"))
          return new Response("document", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        if (url.endsWith("/v1/ai-runs/run-1/debug")) return Response.json({ available: false });
        if (url.endsWith("/v1/memories")) return Response.json({ memories: [memory] });
        if (url.includes("/revisions/")) return Response.json({ memoryId: "memory-1", revision });
        return Response.json(memory);
      },
    });
    await expect(client.fetchPublicSources("US")).resolves.toEqual({
      sources: [],
      publications: [],
    });
    await expect(client.setPublicSourceEnabled("source/1", true, "FR")).resolves.toEqual({
      sources: [],
      publications: [],
    });
    await expect(client.fetchPublisherDocument("issue/1", "document/1")).resolves.toEqual({
      kind: "redirected",
      url: "https://documents.hartlib.example/issue-1/document-1.pdf",
    });
    await expect(client.fetchPublicSourceDocument("document/1")).resolves.toEqual({
      kind: "redirected",
      url: "https://api.hartlib.example/public-source-documents/document%2F1/content",
    });
    await expect(client.fetchAiRunDebug("run-1")).resolves.toEqual({ available: false });
    await expect(client.fetchMemories()).resolves.toEqual([memory]);
    await expect(client.fetchMemoryRevision("memory-1", "revision-1")).resolves.toEqual({
      memoryId: "memory-1",
      revision,
    });
    await expect(client.tombstoneMemory("memory-1")).resolves.toEqual(memory);
    await expect(client.revertMemory("memory-1", "revision-1")).resolves.toEqual(memory);

    expect(calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`)).toEqual([
      "GET https://api.hartlib.example/v1/public-sources?market=US",
      "PUT https://api.hartlib.example/v1/public-sources/source%2F1?market=FR",
      "GET https://api.hartlib.example/v1/issues/issue%2F1/documents/document%2F1/content",
      "GET https://api.hartlib.example/public-source-documents/document%2F1/content",
      "GET https://api.hartlib.example/v1/ai-runs/run-1/debug",
      "GET https://api.hartlib.example/v1/memories",
      "GET https://api.hartlib.example/v1/memories/memory-1/revisions/revision-1",
      "DELETE https://api.hartlib.example/v1/memories/memory-1",
      "POST https://api.hartlib.example/v1/memories/memory-1/revert",
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ enabled: true });
    expect(JSON.parse(String(calls[8]?.init?.body))).toEqual({ revisionId: "revision-1" });
  });
});
