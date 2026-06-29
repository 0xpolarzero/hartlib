export type ChatSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

export async function fetchChats(): Promise<Array<ChatSummary>> {
  const response = await fetch("/api/chats");

  if (!response.ok) {
    throw new Error("Failed to fetch chats");
  }

  return response.json() as Promise<Array<ChatSummary>>;
}
