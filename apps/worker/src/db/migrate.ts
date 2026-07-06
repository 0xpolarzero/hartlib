import { BunRuntime } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import { Config, Effect, Redacted } from "effect";

const migrationsUrl = new URL("../../../../db/migrations/", import.meta.url);

type AppliedMigrationRow = {
  readonly name: string;
};

export const runMigrations = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const files = [...new Bun.Glob("*.sql").scanSync({ cwd: migrationsUrl.pathname })].sort();

  yield* sql`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `;

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`select pg_advisory_xact_lock(hashtext('brief:schema_migrations'))`;
      const appliedRows = yield* sql<AppliedMigrationRow>`
          select name from schema_migrations
        `;
      const applied = new Set(appliedRows.map((row) => row.name));

      for (const file of files) {
        if (applied.has(file)) {
          continue;
        }

        const body = yield* Effect.promise(() => Bun.file(new URL(file, migrationsUrl)).text());
        yield* sql.unsafe(body).raw;
        yield* sql`
            insert into schema_migrations (name)
            values (${file})
          `;
        yield* Effect.logInfo("applied database migration").pipe(
          Effect.annotateLogs({ migration: file }),
        );
      }
    }),
  );
});

const PgLayer = PgClient.layerConfig({
  url: Config.string("DATABASE_URL").pipe(
    Config.withDefault("postgres://brief:brief@localhost:5432/brief"),
    Config.map(Redacted.make),
  ),
  applicationName: Config.succeed("brief-worker-migrations"),
});

export const DatabaseMigrationLayer = PgLayer;

if (import.meta.main) {
  BunRuntime.runMain(runMigrations.pipe(Effect.provide(PgLayer)));
}
