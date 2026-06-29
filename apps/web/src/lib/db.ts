import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";

import { fetchChats, type ChatSummary } from "@/lib/api";
import { queryClient } from "@/lib/query-client";

export const chatCollection = createCollection(
  queryCollectionOptions<ChatSummary>({
    queryKey: ["chats"],
    queryFn: fetchChats,
    queryClient,
    getKey: (chat) => chat.id,
  }),
);
