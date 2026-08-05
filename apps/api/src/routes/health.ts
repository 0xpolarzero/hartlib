import { Effect } from "effect";
import { HealthResponse } from "@hartlib/shared";
import { jsonFromSchema, type Route } from "../http";

export const healthRoute: Route = {
  method: "GET",
  path: "/health",
  execute: () =>
    Effect.succeed(
      jsonFromSchema(HealthResponse, {
        ok: true,
        service: "api",
      }),
    ),
};
