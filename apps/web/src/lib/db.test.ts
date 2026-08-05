import type { ClientPublicSourceSetting } from "@hartlib/shared";
import { queryOnce } from "@tanstack/react-db";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatSummary } from "@/lib/api";

import {
  archiveCollection,
  archiveCollectionCacheSize,
  createArchiveCollection,
  createChatListCollection,
  createClientPublicSourceCollection,
  chatListCollection,
  cleanupWebCollections,
  decodeArchiveSourceSelection,
  encodeArchiveSourceSelection,
  fetchArchiveWindow,
  invalidateProductChatCollections,
} from "./db";

const client = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });

const chat = (id: string, updatedAt = "2026-07-11T00:00:00.000Z"): ChatSummary => ({
  id,
  companyId: "123e4567-e89b-12d3-a456-426614174001",
  creatorUserId: "user-1",
  memoryMode: "disabled",
  sharedAt: null,
  archivedAt: null,
  replacedByChatId: null,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt,
  sourceCount: 0,
});

const publicArchiveItem = (documentId: string) => ({
  sourceKind: "public" as const,
  sourceId: "official-marketplace-source",
  subscriptionName: "Official marketplace source",
  publisherName: "Official publisher",
  issueTitle: `Publication ${documentId}`,
  publicationAt: "2026-07-11T00:00:00.000Z",
  deliveredAt: "2026-07-11T00:01:00.000Z",
  documentId,
  documentTitle: `Document ${documentId}`,
  snippet: null,
  contentPath: `/public-source-documents/${documentId}/content`,
  mediaType: "text/html" as const,
  canonicalUrl: `https://example.test/${documentId}`,
});

const publicSource = (enabled: boolean): ClientPublicSourceSetting => ({
  sourceId: "official-marketplace-source",
  displayName: "Official marketplace source",
  publisherName: "Official publisher",
  description: "Official publications",
  country: "FR",
  language: "fr-FR",
  enabled,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("archive source selection contract", () => {
  it("round-trips publisher UUIDs and public slugs as different identifier domains", () => {
    const subscriptionId = "123e4567-e89b-12d3-a456-426614174002";
    expect(
      decodeArchiveSourceSelection(
        encodeArchiveSourceSelection({ kind: "publisher", subscriptionId }),
      ),
    ).toEqual({ kind: "publisher", subscriptionId });
    expect(
      decodeArchiveSourceSelection(
        encodeArchiveSourceSelection({
          kind: "public",
          sourceId: "official-marketplace-source",
        }),
      ),
    ).toEqual({ kind: "public", sourceId: "official-marketplace-source" });
    expect(decodeArchiveSourceSelection("")).toBeNull();
  });

  it.each([
    "official-marketplace-source",
    "publisher:not-a-uuid",
    "public:Uppercase",
    "public:public:legacy-prefix",
  ])("rejects invalid or undiscriminated select value %s", (value) => {
    expect(() => decodeArchiveSourceSelection(value)).toThrow("archive_source_selection_invalid");
  });

  it("keeps the public discriminator on every paginated server request", async () => {
    const first = Array.from({ length: 100 }, (_, index) => publicArchiveItem(`document-${index}`));
    const last = publicArchiveItem("document-100");
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: first, nextCursor: "MTAw" })
      .mockResolvedValueOnce({ items: [last], nextCursor: null });

    const items = await fetchArchiveWindow({
      companyId: "company-1",
      filter: {
        query: "regulation",
        source: { kind: "public", sourceId: "official-marketplace-source" },
      },
      limit: 101,
      fetchPage,
    });

    expect(items).toHaveLength(101);
    expect(fetchPage).toHaveBeenNthCalledWith(1, "company-1", {
      query: "regulation",
      source: { kind: "public", sourceId: "official-marketplace-source" },
      cursor: null,
      limit: 100,
    });
    expect(fetchPage).toHaveBeenNthCalledWith(2, "company-1", {
      query: "regulation",
      source: { kind: "public", sourceId: "official-marketplace-source" },
      cursor: "MTAw",
      limit: 1,
    });
  });

  it("fails closed when the server repeats an archive cursor", async () => {
    const fetchPage = vi.fn(async () => ({
      items: [publicArchiveItem(crypto.randomUUID())],
      nextCursor: "same-cursor",
    }));
    await expect(
      fetchArchiveWindow({
        companyId: "company-1",
        filter: { query: "", source: null },
        limit: 3,
        fetchPage,
      }),
    ).rejects.toThrow("archive_cursor_repeated");
  });
});

describe("TanStack DB server synchronization", () => {
  it("drops scoped collection identity during auth-session cleanup", async () => {
    const before = chatListCollection("mine");
    await cleanupWebCollections();
    const after = chatListCollection("mine");
    expect(after).not.toBe(before);
    await cleanupWebCollections();
  });

  it("bounds inactive archive-filter collections and releases them on session cleanup", async () => {
    await cleanupWebCollections();
    for (let index = 0; index < 24; index += 1) {
      archiveCollection("company-1", { query: `query-${index}`, source: null });
    }
    expect(archiveCollectionCacheSize()).toBe(16);
    await cleanupWebCollections();
    expect(archiveCollectionCacheSize()).toBe(0);
  });

  it("synchronizes replacement and deletion from the authoritative chat query", async () => {
    let serverRows = [chat("chat-1")];
    const fetch = vi.fn(async () => [...serverRows]);
    const collection = createChatListCollection({ view: "mine", client: client(), fetch });

    await collection.preload();
    expect(collection.toArray.map((row) => row.id)).toEqual(["chat-1"]);

    serverRows = [chat("chat-2", "2026-07-11T01:00:00.000Z")];
    await collection.utils.refetch({ throwOnError: true });
    expect(collection.toArray.map((row) => row.id)).toEqual(["chat-2"]);
    expect(fetch).toHaveBeenCalledWith("mine");

    await collection.cleanup();
  });

  it("surfaces an initial synchronization failure and recovers on explicit retry", async () => {
    let unavailable = true;
    const collection = createChatListCollection({
      view: "mine",
      client: client(),
      fetch: async () => {
        if (unavailable) throw new Error("server_unavailable");
        return [chat("chat-after-retry")];
      },
    });

    await collection.preload();
    expect(collection.utils.isError).toBe(true);
    expect(collection.utils.errorCount).toBe(1);
    unavailable = false;
    await collection.utils.clearError();
    expect(collection.utils.isError).toBe(false);
    expect(collection.toArray.map((row) => row.id)).toEqual(["chat-after-retry"]);

    await collection.cleanup();
  });

  it("isolates mine, shared, and archived chat collections and their query keys", async () => {
    const queryClient = client();
    const fetch = vi.fn(async (view: "mine" | "shared" | "archived") => [
      view === "archived"
        ? {
            ...chat(`${view}-chat`),
            archivedAt: "2026-07-12T00:00:00.000Z",
            replacedByChatId: "123e4567-e89b-12d3-a456-426614174003",
          }
        : chat(`${view}-chat`),
    ]);
    const mine = createChatListCollection({ view: "mine", client: queryClient, fetch });
    const shared = createChatListCollection({ view: "shared", client: queryClient, fetch });
    const archived = createChatListCollection({ view: "archived", client: queryClient, fetch });

    const [mineRows, sharedRows, archivedRows] = await Promise.all([
      queryOnce((query) => query.from({ chat: mine })),
      queryOnce((query) => query.from({ chat: shared })),
      queryOnce((query) => query.from({ chat: archived })),
    ]);
    expect(mineRows.map((row) => row.id)).toEqual(["mine-chat"]);
    expect(sharedRows.map((row) => row.id)).toEqual(["shared-chat"]);
    expect(archivedRows.map((row) => row.id)).toEqual(["archived-chat"]);
    expect(archivedRows[0]).toMatchObject({
      archivedAt: "2026-07-12T00:00:00.000Z",
      replacedByChatId: "123e4567-e89b-12d3-a456-426614174003",
    });
    expect(fetch.mock.calls.map(([view]) => view).sort()).toEqual(["archived", "mine", "shared"]);

    await Promise.all([mine.cleanup(), shared.cleanup(), archived.cleanup()]);
  });

  it("invalidates all chat views without touching unrelated queries", async () => {
    const queryClient = client();
    queryClient.setQueryData(["product-chats", "mine"], [chat("mine-chat")]);
    queryClient.setQueryData(["product-chats", "shared"], [chat("shared-chat")]);
    queryClient.setQueryData(["product-chats", "archived"], [chat("archived-chat")]);
    queryClient.setQueryData(["memories"], []);

    await invalidateProductChatCollections(queryClient);

    expect(queryClient.getQueryState(["product-chats", "mine"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["product-chats", "shared"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["product-chats", "archived"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["memories"])?.isInvalidated).toBe(false);
  });

  it("loads an on-demand archive subset through a live query", async () => {
    const fetchPage = vi.fn(async () => ({
      items: [publicArchiveItem("document-1"), publicArchiveItem("document-2")],
      nextCursor: null,
    }));
    const collection = createArchiveCollection({
      companyId: "company-1",
      filter: {
        query: "policy",
        source: { kind: "public", sourceId: "official-marketplace-source" },
      },
      client: client(),
      fetchPage,
    });

    const rows = await queryOnce((query) =>
      query
        .from({ item: collection })
        .orderBy(({ item }) => item.publicationAt, "desc")
        .limit(2),
    );
    expect(rows.map((row) => row.documentId)).toEqual(["document-1", "document-2"]);
    expect(fetchPage).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        query: "policy",
        source: { kind: "public", sourceId: "official-marketplace-source" },
        limit: 2,
      }),
    );

    await collection.cleanup();
  });

  it("applies public-source edits optimistically and persists through the API handler", async () => {
    let serverRow = publicSource(false);
    const fetch = vi.fn(async () => [serverRow]);
    const update = vi.fn(async (_companyId: string, _sourceId: string, enabled: boolean) => {
      serverRow = publicSource(enabled);
      return serverRow;
    });
    const collection = createClientPublicSourceCollection({
      companyId: "company-1",
      client: client(),
      fetch,
      update,
    });
    await collection.preload();

    const transaction = collection.update("official-marketplace-source", (draft) => {
      draft.enabled = true;
    });
    expect(collection.get("official-marketplace-source")?.enabled).toBe(true);
    await transaction.isPersisted.promise;
    expect(update).toHaveBeenCalledWith("company-1", "official-marketplace-source", true);
    expect(collection.get("official-marketplace-source")?.enabled).toBe(true);

    await collection.cleanup();
  });

  it("rolls back an optimistic public-source edit when persistence fails", async () => {
    const collection = createClientPublicSourceCollection({
      companyId: "company-1",
      client: client(),
      fetch: async () => [publicSource(false)],
      update: async () => {
        throw new Error("persistence_failed");
      },
    });
    await collection.preload();

    const transaction = collection.update("official-marketplace-source", (draft) => {
      draft.enabled = true;
    });
    expect(collection.get("official-marketplace-source")?.enabled).toBe(true);
    await expect(transaction.isPersisted.promise).rejects.toThrow("persistence_failed");
    expect(collection.get("official-marketplace-source")?.enabled).toBe(false);

    await collection.cleanup();
  });
});
