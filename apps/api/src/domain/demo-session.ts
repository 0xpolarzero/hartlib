import { timingSafeEqual } from "node:crypto";
import { Effect } from "effect";

import { DemoSessionResponse } from "@brief/shared";

import { loadApiConfig } from "../config";
import {
  DEMO_COOKIE_NAME,
  createDemoSession,
  demoSessionCookieAttributes,
} from "../demo-session";
import { json, jsonFromSchema, type Route } from "../http";

const constantTimeEquals = (a: string, b: string): boolean => {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  return bufferA.length === bufferB.length && bufferA.length > 0
    ? timingSafeEqual(bufferA, bufferB)
    : false;
};

/**
 * The demo password gate. A correct password mints a per-browser session
 * cookie; a wrong password is rejected. The route exists only in demo mode, so
 * a production deployment answers 404 and the endpoint never overlaps a real
 * auth provider.
 */
export const makeDemoSessionRoutes = (): readonly Route[] => [
  {
    method: "POST",
    path: "/v1/demo/session",
    execute: (request, _url, _pathParameters, input) =>
      Effect.gen(function* () {
        const config = yield* loadApiConfig;
        if (config.authMode !== "demo") return json({ error: "not_found" }, { status: 404 });
        const body = input.body as { readonly password: string };
        if (!constantTimeEquals(body.password, config.demoPassword)) {
          return json({ error: "unauthorized" }, { status: 401 });
        }
        const session = createDemoSession(config.demoSessionSecret, config.demoPassword);
        const setCookie = `${DEMO_COOKIE_NAME}=${session.cookieValue}; ${demoSessionCookieAttributes(
          config.nodeEnv === "production",
        )}`;
        return jsonFromSchema(DemoSessionResponse, { ok: true }, {
          headers: { "set-cookie": setCookie },
        });
      }),
  },
];

export const demoSessionRoutes = makeDemoSessionRoutes();
