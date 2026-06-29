import { Effect } from "effect"
import { serverSentEvents, type Route } from "../http"

export const chatStreamRoute: Route = {
  method: "POST",
  pattern: /^\/v1\/chats\/[^/]+\/messages\/stream$/,
  handle: (_request, url) =>
    Effect.gen(function*() {
      const chatId = url.pathname.split("/")[3] ?? "unknown"

      yield* Effect.logInfo("starting placeholder chat stream").pipe(
        Effect.annotateLogs({
          chatId,
          route: "POST /v1/chats/:chatId/messages/stream"
        })
      )

      return serverSentEvents([
        {
          event: "run_started",
          data: {
            chatId,
            status: "placeholder"
          }
        },
        {
          event: "text_delta",
          data: {
            text: "AI streaming is not implemented yet."
          }
        },
        {
          event: "done",
          data: {
            status: "completed"
          }
        }
      ])
    })
}
