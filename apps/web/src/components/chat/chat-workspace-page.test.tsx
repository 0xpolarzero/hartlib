import { I18nProvider } from "@hartlib/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatListView, ChatSummary } from "@/lib/api";

const testState = vi.hoisted(() => ({
  chats: {
    mine: [] as unknown[],
    shared: [] as unknown[],
    archived: [] as unknown[],
  },
  collectionViews: [] as string[],
}));

vi.mock("@tanstack/react-db", () => ({
  useLiveQuery: (collection: { readonly kind: string; readonly view?: ChatListView }) =>
    collection.kind === "sources"
      ? { data: [], isError: false, isLoading: false }
      : {
          data: testState.chats[collection.view ?? "mine"],
          isError: false,
          isLoading: false,
        },
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({
    error: null,
    isPending: false,
    mutate: vi.fn(),
  }),
  useQueryClient: () => ({}),
}));

vi.mock("@/lib/db", () => ({
  chatListCollection: (view: ChatListView) => {
    testState.collectionViews.push(view);
    return {
      kind: "chats",
      view,
      utils: { clearError: vi.fn(), lastError: null },
    };
  },
  clientSubscriptionAccessCollection: () => ({
    kind: "sources",
    utils: { clearError: vi.fn(), lastError: null },
  }),
  invalidateProductChatCollections: vi.fn(),
}));

import { ChatWorkspacePage } from "./chat-workspace-page";

const chat = (
  id: string,
  view: ChatListView,
  options: {
    readonly archived?: boolean;
    readonly shared?: boolean;
  } = {},
): ChatSummary => ({
  id,
  companyId: "11111111-1111-4111-8111-111111111111",
  creatorUserId: view === "shared" ? "other-user" : "current-user",
  memoryMode: "disabled",
  sharedAt: options.shared ? "2026-07-10T00:00:00.000Z" : null,
  archivedAt: options.archived ? "2026-07-11T00:00:00.000Z" : null,
  replacedByChatId: options.archived ? "44444444-4444-4444-8444-444444444444" : null,
  createdAt: "2026-07-09T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
  sourceCount: 2,
});

const renderWorkspace = (view: ChatListView): string =>
  renderToStaticMarkup(
    <I18nProvider locale="en-US" market="US">
      <ChatWorkspacePage companyId="11111111-1111-4111-8111-111111111111" initialView={view} />
    </I18nProvider>,
  );

describe("chat workspace tabs", () => {
  beforeEach(() => {
    testState.chats.mine = [];
    testState.chats.shared = [];
    testState.chats.archived = [];
    testState.collectionViews.length = 0;
  });

  it.each(["mine", "shared", "archived"] as const)(
    "renders all tabs and reads only the %s collection",
    (view) => {
      const html = renderWorkspace(view);

      expect(testState.collectionViews).toEqual([view]);
      expect(html).toContain("My chats");
      expect(html).toContain("Shared chats");
      expect(html).toContain("Archived");
    },
  );

  it("renders the archived empty state", () => {
    const html = renderWorkspace("archived");

    expect(html).toContain("No archived chats yet.");
    expect(html).toContain("Archived chats stay available to read and export.");
  });

  it("keeps archived cards openable, allows eligible unshare and delete, and never shares", () => {
    testState.chats.archived = [
      chat("22222222-2222-4222-8222-222222222222", "archived", {
        archived: true,
        shared: true,
      }),
      chat("33333333-3333-4333-8333-333333333333", "archived", {
        archived: true,
      }),
    ];

    const html = renderWorkspace("archived");

    expect(html).toContain("/en-US/chat/22222222-2222-4222-8222-222222222222");
    expect(html).toContain("/en-US/chat/33333333-3333-4333-8333-333333333333");
    expect(html.match(/>Open<\/a>/gu)).toHaveLength(2);
    expect(html.match(/aria-label="Delete"/gu)).toHaveLength(2);
    expect(html.match(/>Make private<\/button>/gu)).toHaveLength(1);
    expect(html).not.toMatch(/>Share<\/button>/u);
  });

  it("keeps shared cards read-only while active owned cards keep their management actions", () => {
    testState.chats.mine = [chat("55555555-5555-4555-8555-555555555555", "mine")];
    const mine = renderWorkspace("mine");
    expect(mine).toMatch(/>Share<\/button>/u);
    expect(mine).toMatch(/aria-label="Delete"/u);

    testState.collectionViews.length = 0;
    testState.chats.shared = [
      chat("66666666-6666-4666-8666-666666666666", "shared", { shared: true }),
    ];
    const shared = renderWorkspace("shared");
    expect(testState.collectionViews).toEqual(["shared"]);
    expect(shared).toContain("/en-US/chat/66666666-6666-4666-8666-666666666666");
    expect(shared).not.toMatch(/>Make private<\/button>|>Share<\/button>|aria-label="Delete"/u);
  });
});
