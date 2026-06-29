import { Effect } from "effect";
import { json, type Route } from "../http";

export const healthRoute: Route = {
  method: "GET",
  pattern: /^\/health$/,
  handle: () =>
    Effect.succeed(
      json({
        ok: true,
        service: "api",
      }),
    ),
};
