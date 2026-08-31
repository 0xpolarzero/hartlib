import { Effect } from "effect";

import { hasActiveDemoSession } from "@hartlib/backend-domain/demo-sessions";
import { ApiDatabaseLayer, type ApiDatabaseLayer as ApiDatabaseLayerType } from "./database";
import { DEMO_COOKIE_NAME, readCookie, verifyDemoSessionCookie } from "./demo-session";
import type { ApiConfig } from "./config";

export interface RequestIdentity {
  readonly userId: string;
  readonly sessionId: string;
}

export type RequestIdentityResult =
  | { readonly authenticated: true; readonly identity: RequestIdentity }
  | { readonly authenticated: false };

export interface ResolveIdentityOptions {
  /** Override the database service in focused route tests. */
  readonly databaseLayer?: ApiDatabaseLayerType | undefined;
}

/** Every product request is authenticated by the active demo-session row. */
export const resolveRequestIdentity = (
  request: Request,
  config: ApiConfig,
  options?: ResolveIdentityOptions,
): Effect.Effect<RequestIdentityResult, Error> => {
  const visitorId = verifyDemoSessionCookie(
    readCookie(request.headers.get("cookie"), DEMO_COOKIE_NAME),
  );
  if (visitorId === null) return Effect.succeed({ authenticated: false });
  return hasActiveDemoSession(visitorId).pipe(
    Effect.provide(options?.databaseLayer ?? ApiDatabaseLayer),
    Effect.map((active) =>
      active
        ? {
            authenticated: true as const,
            identity: {
              userId: visitorId,
              sessionId: visitorId,
            },
          }
        : ({ authenticated: false } as const),
    ),
  );
};
