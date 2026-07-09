import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { routeRequest } from "./http";
import { chatRoutes } from "./routes/chat";

const route = (request: Request) => Effect.runPromise(routeRequest(chatRoutes, request));

describe("routeRequest", () => {
  it("answers CORS preflight for a registered POST route", async () => {
    const response = await route(
      new Request("http://brief.test/v1/chat/messages", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:43111",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe("POST");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "content-type, last-event-id",
    );
    expect(response.headers.get("access-control-max-age")).toBe("86400");
    expect(await response.text()).toBe("");
  });

  it("keeps unknown preflight paths as 404", async () => {
    const response = await route(
      new Request("http://brief.test/v1/unknown", {
        method: "OPTIONS",
      }),
    );

    expect(response.status).toBe(404);
  });
});
