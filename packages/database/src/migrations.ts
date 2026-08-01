import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { PgClient } from "@effect/sql-pg";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect } from "effect";

const migrationsUrl = new URL("../../../db/migrations/", import.meta.url);

const migrationLoader = Effect.gen(function* () {
  const migrationFiles = yield* Effect.sync(() =>
    readdirSync(migrationsUrl, { encoding: "utf8" })
      .filter((file) => file.endsWith(".sql"))
      .sort(),
  );

  return yield* Migrator.fromRecord(
    Object.fromEntries(
      migrationFiles.map((file) => {
        const migrationId = file.slice(0, file.indexOf("_"));

        // Migrator strips the first numeric prefix from `fromRecord` keys. Keep
        // the original filename as the recorded migration name.
        return [
          `${migrationId}_${file}`,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const body = yield* Effect.promise(() =>
              readFile(new URL(file, migrationsUrl), "utf8"),
            );
            yield* sql.unsafe(body).raw;
          }),
        ];
      }),
    ),
  );
});

const runSqlMigrations = Migrator.make({})({
  loader: migrationLoader,
  table: "schema_migrations",
});

export const runMigrations = Effect.provideServiceEffect(
  runSqlMigrations,
  SqlClient.SqlClient,
  PgClient.PgClient,
).pipe(
  Effect.tap((completed) =>
    Effect.forEach(
      completed,
      ([, migrationName]) =>
        Effect.logInfo("applied database migration").pipe(
          Effect.annotateLogs({
            migration: migrationName,
          }),
        ),
      { discard: true },
    ),
  ),
);
