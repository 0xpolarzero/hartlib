import { describe, expect, it } from "vitest";

import { makeChatRoutes } from "../domain/chat";

describe("singular chat route surface", () => {
  it("exposes only the singular chat, mutation, stop, stream, and debug paths", () => {
    const paths = makeChatRoutes().map((route) => `${route.method} ${route.path}`);
    expect(paths).toEqual([
      "GET /v1/chat",
      "POST /v1/chat/messages",
      "PATCH /v1/chat/messages/:messageId",
      "DELETE /v1/chat/messages/:messageId",
      "POST /v1/ai-runs/:runId/stop",
      "GET /v1/ai-runs/:runId/stream",
      "GET /v1/ai-runs/:runId/debug",
    ]);
    expect(paths.some((path) => path.includes(":chatId"))).toBe(false);
  });
});
