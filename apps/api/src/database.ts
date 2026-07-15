import { databaseUrlRedactedConfig } from "@brief/config";
import { PgClient } from "@effect/sql-pg";
import { Config, Layer } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/** Process-level Effect SQL wiring. Domain packages depend only on the SQL service. */
export type ApiDatabaseLayer = Layer.Layer<
  PgClient.PgClient | SqlClient,
  Config.ConfigError | SqlError,
  never
>;

export type ApiDatabaseService = PgClient.PgClient;

export const ApiDatabaseLayer: ApiDatabaseLayer = PgClient.layerConfig({
  url: databaseUrlRedactedConfig,
  applicationName: Config.succeed("brief-api"),
});
