import { BunRuntime } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import { runMigrations } from "@brief/database/migrations";
import { databaseUrlRedactedConfig } from "@brief/config";
import { Config, Effect } from "effect";

const PgLayer = PgClient.layerConfig({
  url: databaseUrlRedactedConfig,
  applicationName: Config.succeed("brief-worker-migrations"),
});

export const DatabaseMigrationLayer = PgLayer;

if (import.meta.main) {
  BunRuntime.runMain(runMigrations.pipe(Effect.provide(PgLayer)));
}
