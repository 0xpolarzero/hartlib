/// <reference types="bun" />

import { PgClient } from "@effect/sql-pg";
import { ensureDemoChat } from "@brief/backend-domain/chat-runtime";
import { Effect, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsUrl = new URL("../../../db/migrations/", import.meta.url);
const isBun = typeof process.versions.bun === "string";
const sourceDatabaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const databaseName = `brief_demo_feed_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

const withDatabase = (name: string): string => {
  if (sourceDatabaseUrl === undefined)
    throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
};
const adminUrl = (): string => withDatabase("postgres");
const isolatedUrl = (): string => withDatabase(databaseName);
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const runDb = <A, E>(url: string, effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({ url: Redacted.make(url), applicationName: "brief-demo-feed-test" }),
      ),
    ),
  );

const migrate = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const files = [...new Bun.Glob("*.sql").scanSync({ cwd: migrationsUrl.pathname })].sort();
  yield* sql`
    create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now()
    )
  `;
  for (const file of files) {
    const body = yield* Effect.promise(() => Bun.file(new URL(file, migrationsUrl)).text());
    yield* sql.unsafe(body).raw;
    yield* sql`insert into schema_migrations (name) values (${file})`;
  }
});

describe.skipIf(!isBun || sourceDatabaseUrl === undefined)(
  "ensureDemoChat excludes canonical evaluation fixtures from the demo feed",
  () => {
    beforeAll(async () => {
      await runDb(
        adminUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`).withoutTransform;
        }),
      );
      await runDb(isolatedUrl(), migrate);
      // Seed one real public source plus one canonical evaluation fixture of
      // each discriminating shape (eval-* id and evaluation.invalid URL).
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const sources = [
            {
              id: "real-source-fr",
              name: "Real source",
              publisher: "Real publisher",
              url: "https://real.example/feed.xml",
            },
            {
              id: "eval-v2-fixture",
              name: "Evaluation source fixture",
              publisher: "Brief canonical evaluation",
              url: "https://evaluation.invalid/discovery/eval-v2-fixture",
            },
          ] as const;
          for (const source of sources) {
            yield* sql`
              insert into public_sources (
                source_id, display_name, publisher_name, description, ingestion_method,
                discovery_url, average_chars_per_item, country, language
              ) values (
                ${source.id}, ${source.name}, ${source.publisher}, 'test', 'manual',
                ${source.url}, 1000, 'FR', 'fr-FR'
              )
              on conflict (source_id) do nothing
            `;
          }
        }),
      );
    });

    afterAll(async () => {
      await runDb(
        adminUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName}`;
          yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`)
            .withoutTransform;
        }),
      );
    });

    it("enables real sources but never eval-fixture sources for the demo company", async () => {
      const userId = `demo-eval-exclude-${crypto.randomUUID().toString().slice(0, 8)}`;
      const chat = await runDb(isolatedUrl(), ensureDemoChat(userId));
      const rows = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{ readonly source_id: string }>`
            select source_id from client_company_public_source_settings
            where client_company_id = ${chat.company_id}
          `;
        }),
      );
      const enabled = new Set(rows.map((row) => row.source_id));
      expect(enabled.has("real-source-fr")).toBe(true);
      expect(enabled.has("eval-v2-fixture")).toBe(false);
    });
  },
);
