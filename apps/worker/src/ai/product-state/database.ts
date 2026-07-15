import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted, Semaphore } from "effect";

/**
 * Product-state calls intentionally remain independent from Smithers' durable
 * query ordering, but each call owns a short-lived Pg pool. Bound the number
 * of pools that can be opened by concurrent workflow branches so a burst of
 * provider hooks cannot exhaust Postgres before its queries begin.
 */
export const AI_PRODUCT_STATE_MAX_CONCURRENCY = 32;

const productStateSemaphore = Semaphore.makeUnsafe(AI_PRODUCT_STATE_MAX_CONCURRENCY);

export const runAiProductState = <A, E>(
  connectionString: string,
  effect: Effect.Effect<A, E, PgClient.PgClient>,
  options?: { readonly signal?: AbortSignal | undefined },
): Promise<A> =>
  Effect.runPromise(
    productStateSemaphore.withPermit(
      effect.pipe(
        Effect.provide(
          PgClient.layer({
            url: Redacted.make(connectionString),
            applicationName: "brief-ai-runtime",
          }),
        ),
      ),
    ),
    options?.signal === undefined ? undefined : { signal: options.signal },
  );
