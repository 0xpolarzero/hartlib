import { parseRunAcceptanceScope, type RunAcceptanceScope } from "@brief/shared";
import { z } from "zod";

import type { Locale, Market } from "../runtime/types";

/**
 * The only durable workflow input that carries authorization state.  The
 * scope is decoded once by load-turn and then passed through Smithers output;
 * later tasks must not rebuild it from live settings.
 */
export interface LoadedTurn {
  readonly aiRunId: string;
  readonly chatId: string;
  readonly initiatingUserId: string;
  readonly userMessageId: string;
  readonly userMessage: string;
  readonly locale: Locale;
  readonly market: Market;
  readonly currentDate: string;
  readonly citationNamespace: string;
  readonly memoryMode: "private_owner" | "disabled";
  readonly webRequested: boolean;
  readonly acceptanceScope: RunAcceptanceScope;
}

/** Decode the one strict, server-owned acceptance snapshot at the workflow boundary. */
export const decodeRunAcceptanceScope = (value: unknown): RunAcceptanceScope =>
  parseRunAcceptanceScope(value);

/** Zod boundary used for Smithers' durable output decoder. */
export const RunAcceptanceScopeSchema = z.unknown().transform((value, context) => {
  try {
    return decodeRunAcceptanceScope(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "acceptance scope is invalid",
    });
    return z.NEVER;
  }
});
