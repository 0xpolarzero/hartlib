import { Effect } from "effect";

export const DEMO_USER_ID = "demo-user";

export const resolveDemoUserId = (_request: Request): Effect.Effect<string> =>
  Effect.succeed(DEMO_USER_ID);
