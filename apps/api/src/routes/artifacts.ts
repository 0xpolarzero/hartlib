import { Effect } from "effect"
import { json, type Route } from "../http"

const artifactPlaceholder = (operation: string) =>
  json({
    operation,
    status: "placeholder"
  }, { status: 501 })

export const artifactListFilesRoute: Route = {
  method: "GET",
  pattern: /^\/v1\/chats\/[^/]+\/artifacts\/[^/]+\/files$/,
  handle: () => Effect.succeed(artifactPlaceholder("artifact.list_files"))
}

export const artifactReadFileRoute: Route = {
  method: "GET",
  pattern: /^\/v1\/chats\/[^/]+\/artifacts\/[^/]+\/files\/.+$/,
  handle: () => Effect.succeed(artifactPlaceholder("artifact.read_file"))
}

export const artifactApplyPatchRoute: Route = {
  method: "POST",
  pattern: /^\/v1\/chats\/[^/]+\/artifacts\/[^/]+\/apply-patch$/,
  handle: () => Effect.succeed(artifactPlaceholder("artifact.apply_patch"))
}

export const artifactCheckRoute: Route = {
  method: "POST",
  pattern: /^\/v1\/chats\/[^/]+\/artifacts\/[^/]+\/check$/,
  handle: () => Effect.succeed(artifactPlaceholder("artifact.check"))
}
