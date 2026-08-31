import { describe, expect, it, vi } from "vitest";
import { createChatController } from "./chat-controller";

describe("singular chat controller", () => {
  it("forwards send, edit, delete, and stop without a chat id", async () => {
    const client = {
      sendChatMessage: vi.fn(async (input) => ({ input })),
      editChatMessage: vi.fn(async (id, input) => ({ id, input })),
      deleteChatMessage: vi.fn(async () => undefined),
      stopAiRun: vi.fn(async (id) => ({ id })),
    };
    const controller = createChatController(client);
    const input = {
      text: "Question",
      locale: "en-US" as const,
      market: "US" as const,
      webSearchEnabled: true,
    };
    await expect(controller.send(input)).resolves.toEqual({ input });
    await expect(controller.edit("message-1", input)).resolves.toEqual({ id: "message-1", input });
    await controller.deleteMessage("message-1");
    await expect(controller.stop("run-1")).resolves.toEqual({ id: "run-1" });
    expect(client.sendChatMessage).toHaveBeenCalledWith(input);
    expect(client.editChatMessage).toHaveBeenCalledWith("message-1", input);
    expect(client.deleteChatMessage).toHaveBeenCalledWith("message-1");
    expect(client.stopAiRun).toHaveBeenCalledWith("run-1");
  });
});
