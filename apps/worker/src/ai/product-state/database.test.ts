import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { AI_PRODUCT_STATE_MAX_CONCURRENCY, runAiProductState } from "./database";

const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("AI product-state database lifecycle", () => {
  it("bounds concurrent short-lived pools without serializing product-state work", async () => {
    let active = 0;
    let peak = 0;
    const query = Effect.acquireUseRelease(
      Effect.sync(() => {
        active += 1;
        peak = Math.max(peak, active);
      }),
      () =>
        Effect.gen(function* () {
          yield* Effect.sleep("20 millis");
          const sql = yield* PgClient.PgClient;
          const rows = yield* sql<{ readonly value: number }>`select 1 as value`;
          return rows[0]?.value;
        }),
      () =>
        Effect.sync(() => {
          active -= 1;
        }),
    );

    const values = await Promise.all(
      Array.from({ length: 256 }, () => runAiProductState(databaseUrl!, query)),
    );

    expect(values).toEqual(Array.from({ length: 256 }, () => 1));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(AI_PRODUCT_STATE_MAX_CONCURRENCY);
  }, 30_000);

  it("removes an aborted queued call without consuming a product-state permit", async () => {
    let releaseBlockers!: () => void;
    const blockersReleased = new Promise<void>((resolve) => {
      releaseBlockers = resolve;
    });
    let started = 0;
    const blocker = Effect.acquireUseRelease(
      Effect.sync(() => {
        started += 1;
      }),
      () => Effect.promise(() => blockersReleased),
      () => Effect.void,
    );
    const blockerCalls = Array.from({ length: AI_PRODUCT_STATE_MAX_CONCURRENCY }, () =>
      runAiProductState(databaseUrl!, blocker),
    );
    const deadline = Date.now() + 5_000;
    while (started < AI_PRODUCT_STATE_MAX_CONCURRENCY && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(started).toBe(AI_PRODUCT_STATE_MAX_CONCURRENCY);

    let queuedStarted = false;
    const controller = new AbortController();
    const queued = runAiProductState(
      databaseUrl!,
      Effect.sync(() => {
        queuedStarted = true;
      }),
      { signal: controller.signal },
    );
    controller.abort();
    await expect(queued).rejects.toBeInstanceOf(Error);
    releaseBlockers();
    await Promise.all(blockerCalls);

    expect(queuedStarted).toBe(false);
    await expect(runAiProductState(databaseUrl!, Effect.succeed("later"))).resolves.toBe("later");
  }, 30_000);
});
