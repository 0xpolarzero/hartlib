import { Effect } from "effect";

import { DemoSessionResponse } from "@hartlib/shared";

import { loadApiConfig } from "../config";
import {
  DEMO_COOKIE_NAME,
  createDemoSession,
  demoSessionCookieAttributes,
  readCookie,
  verifyDemoSessionCookie,
} from "../demo-session";
import { json, jsonFromSchema, type Route } from "../http";

/**
 * Establish a per-browser demo session. A returning visitor with a valid cookie
 * keeps it; a new visitor gets a fresh visitor id set as an httpOnly cookie.
 * There is no password — the cookie's entropy is the only credential.
 */
export const makeDemoSessionRoutes = (): readonly Route[] => [
  {
    method: "POST",
    path: "/v1/demo/session",
    execute: (request) =>
      Effect.gen(function* () {
        const config = yield* loadApiConfig;
        if (config.authMode !== "demo") return json({ error: "not_found" }, { status: 404 });
        const existing = verifyDemoSessionCookie(
          readCookie(request.headers.get("cookie"), DEMO_COOKIE_NAME),
        );
        if (existing !== null) return jsonFromSchema(DemoSessionResponse, { ok: true });
        const session = createDemoSession();
        const setCookie = `${DEMO_COOKIE_NAME}=${session.cookieValue}; ${demoSessionCookieAttributes(
          config.nodeEnv === "production",
        )}`;
        return jsonFromSchema(
          DemoSessionResponse,
          { ok: true },
          {
            headers: { "set-cookie": setCookie },
          },
        );
      }),
  },
];

export const demoSessionRoutes = makeDemoSessionRoutes();
