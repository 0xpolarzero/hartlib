import { describe, expect, it } from "vitest";

import { createProductApiClient } from "./product-client";

const chat = {
  chat: {
    id: "chat-1",
    memoryMode: "disabled" as const,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    archivedAt: null,
  },
  messages: [],
  effectiveWebPolicy: {
    enabled: false as const,
    reason: "deployment_unavailable" as const,
    allowlistActive: false,
  },
  activeRun: null,
  canWrite: true,
};

const consume = async (client: ReturnType<typeof createProductApiClient>) => {
  const frames = [];
  for await (const frame of client.streamAiRun("run-1", 0)) frames.push(frame);
  return frames;
};

describe("product API client codecs", () => {
  it("queries the exact market-scoped public route", async () => {
    const calls: string[] = [];
    const client = createProductApiClient({
      baseUrl: "https://api.hartlib.example",
      fetch: async (input) => {
        calls.push(String(input));
        return Response.json({ sources: [], publications: [] });
      },
    });
    await expect(client.fetchPublicSources("US")).resolves.toEqual({
      sources: [],
      publications: [],
    });
    expect(calls).toEqual(["https://api.hartlib.example/v1/public-sources?market=US"]);
  });

  it("loads a publisher citation through the API origin and gates the redirected PDF", async () => {
    const calls: Array<{ readonly input: string; readonly init: RequestInit | undefined }> = [];
    const response = new Response("%PDF-1.7", {
      headers: { "content-type": "application/pdf" },
    });
    Object.defineProperty(response, "redirected", { value: true });
    Object.defineProperty(response, "url", {
      value: "https://objects.hartlib.example/document.pdf?expires=300",
    });
    const client = createProductApiClient({
      baseUrl: "https://api.hartlib.example",
      fetch: async (input, init) => {
        calls.push({ input: String(input), init });
        return response;
      },
    });

    await expect(client.fetchPublisherDocument("issue /1", "document /1")).resolves.toEqual({
      kind: "redirected",
      url: "https://objects.hartlib.example/document.pdf?expires=300",
    });
    expect(calls[0]?.input).toBe(
      "https://api.hartlib.example/v1/issues/issue%20%2F1/documents/document%20%2F1/content",
    );
    expect(calls[0]?.init).toMatchObject({ method: "GET", referrerPolicy: "no-referrer" });
    expect(new Headers(calls[0]?.init?.headers).get("accept")).toBe("application/pdf");
  });

  it("rejects a direct PDF because the canonical publisher route declares redirect-only success", async () => {
    const client = createProductApiClient({
      fetch: async () =>
        new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }),
    });
    await expect(client.fetchPublisherDocument("issue-1", "document-1")).rejects.toMatchObject({
      code: "request_200",
    });
  });

  it("rejects a redirected PDF on an unsafe final origin", async () => {
    const response = new Response("%PDF-1.7", {
      headers: { "content-type": "application/pdf" },
    });
    Object.defineProperties(response, {
      redirected: { value: true },
      url: { value: "http://objects.hartlib.example/document.pdf?expires=300" },
    });
    const client = createProductApiClient({ fetch: async () => response });
    await expect(client.fetchPublisherDocument("issue-1", "document-1")).rejects.toMatchObject({
      code: "invalid_response_redirect",
    });
  });
  it("rejects an excess chat response instead of leaking it into application state", async () => {
    const client = createProductApiClient({
      fetch: async () => Response.json({ ...chat, extra: true }),
    });
    await expect(client.getChat()).rejects.toMatchObject({ code: "invalid_response_body" });
  });

  it("fetches the owner-only safe debug projection without accepting extra fields", async () => {
    const safe = { available: false } as const;
    const calls: string[] = [];
    const client = createProductApiClient({
      baseUrl: "https://api.hartlib.example",
      fetch: async (input) => {
        calls.push(String(input));
        return Response.json(safe);
      },
    });
    await expect(client.fetchAiRunDebug("run /1")).resolves.toEqual(safe);
    expect(calls).toEqual(["https://api.hartlib.example/v1/ai-runs/run%20%2F1/debug"]);

    const excess = createProductApiClient({
      fetch: async () => Response.json({ ...safe, prompt: "private" }),
    });
    await expect(excess.fetchAiRunDebug("run-1")).rejects.toMatchObject({
      code: "invalid_response_body",
    });
  });

  it("posts one exact replacement UUID and decodes the complete reset projection", async () => {
    const calls: Array<{ readonly input: string; readonly init: RequestInit | undefined }> = [];
    const reset = {
      archivedChatId: "old-chat",
      replacement: chat,
    };
    const client = createProductApiClient({
      baseUrl: "https://api.hartlib.example",
      fetch: async (input, init) => {
        calls.push({ input: String(input), init });
        return Response.json(reset);
      },
    });
    await expect(
      client.resetChat("old/chat", "11111111-1111-4111-8111-111111111111"),
    ).resolves.toEqual(reset);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://api.hartlib.example/v1/chats/old%2Fchat/reset");
    expect(calls[0]?.init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      replacementChatId: "11111111-1111-4111-8111-111111111111",
    });
    const excess = createProductApiClient({
      fetch: async () =>
        Response.json({
          ...reset,
          replacement: { ...reset.replacement, extra: true },
        }),
    });
    await expect(
      excess.resetChat("old/chat", "11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({ code: "invalid_response_body" });
  });

  it("retains the typed archived conflict body", async () => {
    const conflict = { error: "chat_already_reset", archivedChatId: "old-chat" } as const;
    const client = createProductApiClient({
      fetch: async () => Response.json(conflict, { status: 409 }),
    });
    await expect(
      client.resetChat("old-chat", "11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({ status: 409, code: "chat_already_reset", body: conflict });
  });

  it("fetches and strictly decodes an exact provenance-only memory revision", async () => {
    const response = {
      memoryId: "memory-1",
      revision: {
        id: "revision-1",
        action: "create" as const,
        before: null,
        after: { kind: "fact" as const, content: "Exact model-visible memory", deleted: false },
        createdAt: "2026-07-10T00:00:00.000Z",
      },
    };
    const calls: string[] = [];
    const client = createProductApiClient({
      fetch: async (input) => {
        calls.push(String(input));
        return Response.json(response);
      },
    });

    await expect(client.fetchMemoryRevision("memory /1", "revision /1")).resolves.toEqual(response);
    expect(calls).toEqual(["/v1/memories/memory%20%2F1/revisions/revision%20%2F1"]);
  });

  it("retains only a strictly decoded active-run conflict body", async () => {
    const conflict = {
      code: "active_ai_run" as const,
      conflictScope: "chat" as const,
      activeRun: { id: "run-1", status: "running" as const, streamPath: "/stream" },
    };
    const exact = createProductApiClient({
      fetch: async () => Response.json(conflict, { status: 409 }),
    });
    await expect(
      exact.sendChatMessage({
        text: "question",
        locale: "en-US",
        market: "US",
        webSearchEnabled: false,
      }),
    ).rejects.toMatchObject({ status: 409, code: "active_ai_run", body: conflict });

    const excess = createProductApiClient({
      fetch: async () => Response.json({ ...conflict, extra: true }, { status: 409 }),
    });
    await expect(
      excess.sendChatMessage({
        text: "question",
        locale: "en-US",
        market: "US",
        webSearchEnabled: false,
      }),
    ).rejects.toMatchObject({ status: 409, code: "request_409", body: undefined });
  });

  it("rejects undeclared SSE statuses and wrong stream media types before parsing", async () => {
    const wrongStatus = createProductApiClient({
      fetch: async () =>
        new Response('id: 1\nevent: run_started\ndata: {"type":"run_started"}\n\n', {
          status: 201,
          headers: { "content-type": "text/event-stream" },
        }),
    });
    await expect(consume(wrongStatus)).rejects.toMatchObject({ status: 201, code: "request_201" });

    const wrongMedia = createProductApiClient({
      fetch: async () => new Response("event data", { headers: { "content-type": "text/plain" } }),
    });
    await expect(consume(wrongMedia)).rejects.toMatchObject({
      status: 200,
      code: "invalid_response_media_type",
    });
  });

  it("rejects skipped or replayed durable sequence IDs and stops at terminal", async () => {
    const stream = (body: string) =>
      createProductApiClient({
        fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      });
    const runStarted = 'event: run_started\ndata: {"type":"run_started"}\n\n';

    await expect(consume(stream(`id: 2\n${runStarted}`))).rejects.toMatchObject({
      code: "invalid_sse_sequence",
    });
    await expect(consume(stream(`id: 1\n${runStarted}id: 1\n${runStarted}`))).rejects.toMatchObject(
      { code: "invalid_sse_sequence" },
    );
    await expect(
      consume(
        stream(
          `id: 1\n${runStarted}id: 2\nevent: done\ndata: {"type":"done","assistantMessageId":"message-1"}\n\nid: 3\n${runStarted}`,
        ),
      ),
    ).resolves.toHaveLength(2);
  });
});
