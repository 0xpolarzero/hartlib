export type DemoLocale = "en-US" | "fr-FR";
export type DemoMarket = "US" | "FR";
export interface ChatControllerInput {
  text: string;
  locale: DemoLocale;
  market: DemoMarket;
  webSearchEnabled: boolean;
}
export interface ChatControllerClient<Accepted = unknown> {
  sendChatMessage: (input: ChatControllerInput) => Promise<Accepted>;
  editChatMessage: (messageId: string, input: ChatControllerInput) => Promise<Accepted>;
  deleteChatMessage: (messageId: string) => Promise<void>;
  stopAiRun: (runId: string) => Promise<unknown>;
}

/** Keeps browser composition on the singular chat contract. It has no route or storage access. */
export function createChatController<Accepted>(client: ChatControllerClient<Accepted>) {
  return {
    send: (input: ChatControllerInput) => client.sendChatMessage(input),
    edit: (messageId: string, input: ChatControllerInput) =>
      client.editChatMessage(messageId, input),
    deleteMessage: (messageId: string) => client.deleteChatMessage(messageId),
    stop: (runId: string) => client.stopAiRun(runId),
  };
}
