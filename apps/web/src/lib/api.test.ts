import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createChat,
  deleteChat,
  fetchMemoryRevision,
  fetchChats,
  fetchMemories,
  revertMemory,
  setChatShared,
  tombstoneMemory,
} from "./api";
import { setApiTokenProvider } from "./api-auth";

describe("product chat API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setApiTokenProvider(async () => null);
  });

  it("uses the exact list and mutation contracts", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ chats: [] }))
      .mockResolvedValueOnce(
        Response.json(
          {
            chat: {
              id: "chat-1",
              memoryMode: "disabled",
              sourceAccessIds: ["access-1"],
              createdAt: "2026-07-10T00:00:00.000Z",
            },
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ status: "shared" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchChats("shared");
    await createChat({
      companyId: "company-1",
      memoryMode: "disabled",
      sourceAccessIds: ["access-1"],
    });
    await setChatShared("chat /1", true);
    await deleteChat("chat /1");

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/v1/chats?view=shared",
      "/v1/chats",
      "/v1/chats/chat%20%2F1/share",
      "/v1/chats/chat%20%2F1",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        companyId: "company-1",
        memoryMode: "disabled",
        sourceAccessIds: ["access-1"],
      }),
    });
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBeUndefined();
    expect(fetchMock.mock.calls[3]?.[1]?.body).toBeUndefined();
  });

  it("surfaces the stable API error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 })),
    );
    await expect(deleteChat("chat-1")).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
  });

  it("uses exact memory list, tombstone, and revert contracts", async () => {
    const memory = {
      id: "memory-1",
      headRevisionId: "revision-1",
      current: { kind: "fact", content: "Prefers concise answers", deleted: false },
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      revisions: [
        {
          id: "revision-1",
          action: "create",
          before: null,
          after: { kind: "fact", content: "Prefers concise answers", deleted: false },
          createdAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    } as const;
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ memories: [memory] }))
      .mockResolvedValueOnce(Response.json({ memoryId: memory.id, revision: memory.revisions[0] }))
      .mockResolvedValueOnce(Response.json(memory))
      .mockResolvedValueOnce(Response.json(memory));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMemories()).resolves.toEqual([memory]);
    await expect(fetchMemoryRevision("memory /1", "revision /1")).resolves.toEqual({
      memoryId: memory.id,
      revision: memory.revisions[0],
    });
    await tombstoneMemory("memory /1");
    await revertMemory("memory /1", "revision /1");

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/v1/memories",
      "/v1/memories/memory%20%2F1/revisions/revision%20%2F1",
      "/v1/memories/memory%20%2F1",
      "/v1/memories/memory%20%2F1/revert",
    ]);
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("DELETE");
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBeUndefined();
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      revisionId: "revision /1",
    });
  });

  it("preserves typed memory conflict and expiry codes", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ code: "active_ai_run" }, { status: 409 }))
      .mockResolvedValueOnce(
        Response.json({ code: "memory_revert_window_expired" }, { status: 410 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(tombstoneMemory("memory-1")).rejects.toMatchObject({
      status: 409,
      code: "active_ai_run",
    });
    await expect(revertMemory("memory-1", "revision-1")).rejects.toMatchObject({
      status: 410,
      code: "memory_revert_window_expired",
    });
  });
});
