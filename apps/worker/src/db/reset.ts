import { BunRuntime } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import { loadDatabaseResetConfig } from "@brief/config";

import { runMigrations } from "@brief/database/migrations";
import { DatabaseMigrationLayer } from "./migrate";

export const assertResetAllowed = Effect.gen(function* () {
  const { nodeEnv, allowProductionReset } = yield* loadDatabaseResetConfig;

  if (nodeEnv === "production" && !allowProductionReset) {
    yield* Effect.fail(
      new Error(
        "Refusing to reset the database when NODE_ENV=production. Set BRIEF_ALLOW_DB_RESET=true to override.",
      ),
    );
  }
});

const clearDatabaseSchema = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;

  yield* sql.unsafe("drop schema if exists public cascade");
  yield* sql.unsafe("create schema public");
  yield* Effect.logInfo("cleared database schema");
});

export const clearDatabase = assertResetAllowed.pipe(Effect.andThen(clearDatabaseSchema));

export const resetDatabase = assertResetAllowed.pipe(
  Effect.andThen(clearDatabaseSchema),
  Effect.andThen(runMigrations),
);

export const runResetDatabase = assertResetAllowed.pipe(
  Effect.andThen(
    clearDatabaseSchema.pipe(Effect.andThen(runMigrations), Effect.provide(DatabaseMigrationLayer)),
  ),
);

if (import.meta.main) {
  BunRuntime.runMain(runResetDatabase);
}
