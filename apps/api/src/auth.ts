import { createClerkClient } from "@clerk/backend";
import { Effect } from "effect";

import { DEMO_COOKIE_NAME, readCookie, verifyDemoSessionCookie } from "./demo-session";
import type { ApiConfig } from "./config";

export interface RequestIdentity {
  readonly userId: string;
  readonly organizationId: string | null;
  readonly sessionId: string;
  readonly mfaVerified: boolean;
  readonly mode: "demo" | "clerk";
}

export type RequestIdentityResult =
  | { readonly authenticated: true; readonly identity: RequestIdentity }
  | { readonly authenticated: false };

interface SessionAuth {
  readonly userId: string | null;
  readonly orgId: string | null;
  readonly sessionId: string | null;
  readonly factorVerificationAge: readonly number[] | null;
}

export interface ClerkRequestState {
  readonly isAuthenticated: boolean;
  readonly toAuth: () => SessionAuth | null;
}

export interface RequestAuthenticator {
  readonly authenticateRequest: (
    request: Request,
    options: { readonly authorizedParties?: string[] },
  ) => Promise<ClerkRequestState>;
}

export interface ResolveIdentityOptions {
  readonly authenticator?: RequestAuthenticator | undefined;
}

const secondFactorWasVerified = (ages: readonly number[] | null): boolean => {
  const secondFactorAge = ages?.[1];
  return secondFactorAge !== undefined && secondFactorAge >= 0;
};

export const resolveRequestIdentity = (
  request: Request,
  config: ApiConfig,
  options?: ResolveIdentityOptions,
): Effect.Effect<RequestIdentityResult, Error> => {
  if (config.authMode === "demo") {
    const cookieValue = readCookie(request.headers.get("cookie"), DEMO_COOKIE_NAME);
    const visitorId = verifyDemoSessionCookie(
      cookieValue,
      config.demoSessionSecret,
      config.demoPassword,
    );
    if (visitorId === null) return Effect.succeed({ authenticated: false });
    return Effect.succeed({
      authenticated: true,
      identity: {
        userId: visitorId,
        organizationId: null,
        sessionId: "demo-session",
        mfaVerified: true,
        mode: "demo",
      },
    });
  }

  const clerkClient = createClerkClient({
    secretKey: config.clerkSecretKey,
    publishableKey: config.clerkPublishableKey,
  });
  const authenticator: RequestAuthenticator = options?.authenticator ?? {
    authenticateRequest: async (clerkRequest, authenticateOptions) => {
      const state = await clerkClient.authenticateRequest(clerkRequest, authenticateOptions);
      return state as ClerkRequestState;
    },
  };

  return Effect.tryPromise({
    try: () =>
      authenticator.authenticateRequest(
        request,
        config.clerkAuthorizedParties.length === 0
          ? {}
          : { authorizedParties: [...config.clerkAuthorizedParties] },
      ),
    catch: (cause) =>
      new Error("request authentication failed", {
        cause,
      }),
  }).pipe(
    Effect.map((state): RequestIdentityResult => {
      if (!state.isAuthenticated) return { authenticated: false };
      const auth = state.toAuth();
      if (auth?.userId === null || auth?.userId === undefined || auth.sessionId === null) {
        return { authenticated: false };
      }
      return {
        authenticated: true,
        identity: {
          userId: auth.userId,
          organizationId: auth.orgId,
          sessionId: auth.sessionId,
          mfaVerified: secondFactorWasVerified(auth.factorVerificationAge),
          mode: "clerk",
        },
      };
    }),
  );
};
