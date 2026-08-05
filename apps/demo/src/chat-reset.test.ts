import type { GetChatResponse, ResetProductChatResponse } from "@hartlib/shared";
import { describe, expect, it } from "vitest";

import {
  chatResetReducer,
  createChatResetController,
  initialChatResetState,
  type ChatResetSnapshot,
} from "./chat-reset";

const projection = (id = "old-chat"): GetChatResponse => ({
  chat: {
    id,
    memoryMode: "disabled",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    archivedAt: null,
  },
  messages: [],
  effectiveWebPolicy: { enabled: false, reason: "deployment_unavailable", allowlistActive: false },
  activeRun: null,
  canWrite: true,
});

const response = (id = "new-chat"): ResetProductChatResponse => ({
  archivedChatId: "old-chat",
  replacement: projection(id),
});

const snapshot = (): ChatResetSnapshot<string> => ({
  projection: {
    ...projection(),
    messages: [
      {
        id: "message-1",
        author: "user",
        content: "before reset",
        createdAt: "2026-07-10T00:01:00.000Z",
        run: { id: "run-1", status: "queued" },
      },
    ],
  },
  draft: "typed while waiting",
  activeRunId: "run-1",
  streamGeneration: 3,
  cursor: { runId: "run-1", lastSeq: 8 },
  route: "/fr-FR/client",
});

describe("chat reset reducer", () => {
  it("clears the transcript before the request resolves and suppresses a second start", () => {
    const initial = initialChatResetState(snapshot());
    const started = chatResetReducer(initial, {
      type: "start",
      chatId: "old-chat",
      replacementChatId: "11111111-1111-4111-8111-111111111111",
      route: "/fr-FR/client",
    });
    expect(started.phase).toBe("pending");
    expect(started.projection.chat.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(started.projection.messages).toEqual([]);
    expect(started.projection.canWrite).toBe(false);
    expect(started.activeRunId).toBeNull();
    expect(
      chatResetReducer(started, {
        type: "start",
        chatId: "old-chat",
        replacementChatId: "22222222-2222-4222-8222-222222222222",
        route: "/fr-FR/client",
      }),
    ).toBe(started);
  });

  it("reconciles success without a follow-up GET and fences old projections", () => {
    const initial = initialChatResetState(snapshot());
    const started = chatResetReducer(initial, {
      type: "start",
      chatId: "old-chat",
      replacementChatId: "11111111-1111-4111-8111-111111111111",
      route: "/fr-FR/client",
    });
    const committed = chatResetReducer(started, {
      type: "success",
      generation: started.generation,
      response: response("11111111-1111-4111-8111-111111111111"),
    });
    expect(committed.projection.chat.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(committed.projection.canWrite).toBe(true);
    expect(committed.cursor).toBeNull();
    expect(
      chatResetReducer(committed, {
        type: "late_projection",
        generation: started.generation - 1,
        projection: projection("old-chat"),
        activeRunId: "old-run",
      }),
    ).toBe(committed);
    expect(
      chatResetReducer(committed, {
        type: "late_stream",
        generation: started.generation - 1,
        streamGeneration: 99,
        cursor: { runId: "old-run", lastSeq: 99 },
      }),
    ).toBe(committed);
    expect(
      chatResetReducer(committed, {
        type: "late_stream",
        generation: committed.generation,
        streamGeneration: committed.streamGeneration - 1,
        cursor: { runId: "old-run", lastSeq: 99 },
      }),
    ).toBe(committed);
  });

  it("rolls back the predecessor while retaining text typed during the attempt", () => {
    const initial = initialChatResetState(snapshot());
    const started = chatResetReducer(initial, {
      type: "start",
      chatId: "old-chat",
      replacementChatId: "11111111-1111-4111-8111-111111111111",
      route: "/fr-FR/client",
    });
    const typed = chatResetReducer(started, { type: "draft", draft: "new text" });
    const failed = chatResetReducer(typed, {
      type: "failure",
      generation: started.generation,
      error: new Error("offline"),
    });
    expect(failed.projection.chat.id).toBe("old-chat");
    expect(failed.projection.messages).toHaveLength(1);
    expect(failed.draft).toBe("new text");
    expect(failed.activeRunId).toBe("run-1");
    expect(failed.cursor).toEqual({ runId: "run-1", lastSeq: 8 });
    expect(failed.retry).toEqual({
      chatId: "old-chat",
      replacementChatId: "11111111-1111-4111-8111-111111111111",
    });
  });
});

describe("chat reset controller", () => {
  it("restores the captured nested route when reset fails", async () => {
    const nestedRoute = "/fr-FR/client/sources/source-public-fr/issue/issue-public-fr-2026-01";
    const visitedRoutes: string[] = [];
    const nestedSnapshot = {
      ...snapshot(),
      route: nestedRoute,
    };
    const controller = createChatResetController({
      initial: nestedSnapshot,
      generateReplacementId: () => "77777777-7777-4777-8777-777777777777",
      api: {
        resetChat: async () => {
          throw new Error("offline");
        },
        getCommittedChat: async () => projection(),
      },
      onStart: () => {
        visitedRoutes.push("/fr-FR/client");
      },
      onFailure: (_error, captured) => {
        visitedRoutes.push(captured.route);
      },
    });

    await controller.reset(nestedSnapshot.projection.chat.id, nestedRoute);

    expect(visitedRoutes).toEqual(["/fr-FR/client", nestedRoute]);
    expect(controller.getState().route).toBe(nestedRoute);
    expect(controller.getState().projection.chat.id).toBe(nestedSnapshot.projection.chat.id);
    expect(controller.getState().activeRunId).toBe(nestedSnapshot.activeRunId);
    expect(controller.getState().cursor).toEqual(nestedSnapshot.cursor);
  });

  it("uses one UUID, suppresses repeat clicks, and retries a lost response with that UUID", async () => {
    let resolveReset: ((value: ResetProductChatResponse) => void) | undefined;
    const calls: string[] = [];
    const controller = createChatResetController({
      initial: snapshot(),
      generateReplacementId: () => "11111111-1111-4111-8111-111111111111",
      api: {
        resetChat: async (_chatId, replacementChatId) => {
          calls.push(replacementChatId);
          return await new Promise<ResetProductChatResponse>((resolve) => {
            resolveReset = resolve;
          });
        },
        getCommittedChat: async () => projection("11111111-1111-4111-8111-111111111111"),
      },
    });

    const first = controller.reset("old-chat", "/fr-FR/client");
    await Promise.resolve();
    await controller.reset("old-chat", "/fr-FR/client");
    expect(calls).toEqual(["11111111-1111-4111-8111-111111111111"]);
    resolveReset?.(response("11111111-1111-4111-8111-111111111111"));
    await first;
    expect(controller.getState().projection.chat.id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("reuses the committed reset identity after a lost response", async () => {
    const calls: string[] = [];
    let attempt = 0;
    const controller = createChatResetController({
      initial: snapshot(),
      generateReplacementId: () => "33333333-3333-4333-8333-333333333333",
      api: {
        resetChat: async (_chatId, replacementChatId) => {
          calls.push(replacementChatId);
          attempt += 1;
          if (attempt === 1) throw new Error("response lost after commit");
          return response(replacementChatId);
        },
        getCommittedChat: async () => projection("33333333-3333-4333-8333-333333333333"),
      },
    });
    await controller.reset("old-chat", "/fr-FR/client");
    expect(controller.getState().retry?.replacementChatId).toBe(
      "33333333-3333-4333-8333-333333333333",
    );
    await controller.retry();
    expect(calls).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "33333333-3333-4333-8333-333333333333",
    ]);
    expect(controller.getState().projection.chat.id).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("adopts the committed replacement when another tab wins", async () => {
    const controller = createChatResetController({
      initial: snapshot(),
      generateReplacementId: () => "44444444-4444-4444-8444-444444444444",
      api: {
        resetChat: async () => {
          throw {
            body: { error: "chat_already_reset", archivedChatId: "old-chat" },
          };
        },
        getCommittedChat: async () => projection("winner-chat"),
      },
    });
    await controller.reset("old-chat", "/fr-FR/client");
    expect(controller.getState().phase).toBe("idle");
    expect(controller.getState().projection.chat.id).toBe("winner-chat");
    expect(controller.getState().rollback).toBeNull();
  });
});
