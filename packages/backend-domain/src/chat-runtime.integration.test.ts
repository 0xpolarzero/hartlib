/// <reference types="bun" />

import { PgClient } from "@effect/sql-pg";
import { runMigrations } from "@brief/database/migrations";
import {
  createUserMessageAndRun,
  ensureDemoChat,
  loadAuthorizedChatRuntimeState,
} from "@brief/backend-domain/chat-runtime";
import { resetProductChat } from "@brief/backend-domain/product-chats";
import { Effect, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

const runDb = <A, E>(
  url: string,
  effect: Effect.Effect<A, E, PgClient.PgClient>,
  applicationName = "brief-demo-feed-test",
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url), applicationName }))),
  );

const runtimeConfig = {
  authMode: "demo",
  webResearchProvider: null,
  aiWebMaxDomainFilters: 10,
  aiProviderServiceId: "zai_coding_plan_official",
  aiProviderEndpointIdentity: "zai_coding_plan_official:https://api.z.ai/api/coding/paas/v4",
} as const;

const messageInput = (text: string) => ({
  text,
  locale: "en-US",
  market: "US",
  webSearchEnabled: false,
});

const waitForDatabaseLock = async (applicationName: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly waiting: boolean }>`
          select exists(
            select 1
            from pg_stat_activity
            where datname = current_database()
              and application_name = ${applicationName}
              and wait_event_type = 'Lock'
          ) as waiting
        `)[0]!.waiting;
      }),
    );
    if (waiting) return;
    await Bun.sleep(5);
  }
  throw new Error(`${applicationName} did not wait for a database lock`);
};

describe.skipIf(!isBun || sourceDatabaseUrl === undefined)(
  "demo chat runtime discovery and archive fences",
  () => {
    beforeAll(async () => {
      await runDb(
        adminUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`).withoutTransform;
        }),
      );
      await runDb(isolatedUrl(), runMigrations);
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
      try {
        await runDb(
          adminUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName}`;
            yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`)
              .withoutTransform;
          }),
        );
      } catch {
        // Best-effort cleanup: the test database is isolated per process, so a
        // failed teardown (for example a lingering superuser-owned session that
        // a non-superuser role cannot terminate) leaves only an orphan that
        // never affects other runs. All assertions already ran above.
      }
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

    it("discovers the active replacement while retaining explicit archived reads", async () => {
      const userId = `demo-archive-read-${crypto.randomUUID().slice(0, 8)}`;
      const predecessor = await runDb(isolatedUrl(), ensureDemoChat(userId));
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into chat_messages (chat_id, author, content)
            values (${predecessor.id}, 'user', 'Retained predecessor transcript')
          `;
        }),
      );
      const replacementChatId = crypto.randomUUID();
      await expect(
        runDb(
          isolatedUrl(),
          resetProductChat(
            { mode: "demo", userId, organizationId: null },
            predecessor.id,
            replacementChatId,
          ),
        ),
      ).resolves.toEqual({
        kind: "created",
        archivedChatId: predecessor.id,
        replacementChatId,
      });

      const discovered = await runDb(isolatedUrl(), ensureDemoChat(userId));
      expect(discovered.id).toBe(replacementChatId);
      expect(discovered.archived_at).toBeNull();

      const archived = await runDb(
        isolatedUrl(),
        loadAuthorizedChatRuntimeState(
          { mode: "demo", userId, organizationId: null },
          runtimeConfig,
          predecessor.id,
        ),
      );
      expect(archived?.chat.id).toBe(predecessor.id);
      expect(archived?.chat.archived_at).toBeInstanceOf(Date);
      expect(archived?.messages.map((message) => message.content)).toEqual([
        "Retained predecessor transcript",
      ]);

      const linked = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly archivedAt: Date | null;
            readonly replacedByChatId: string | null;
          }>`
            select archived_at as "archivedAt",
                   replaced_by_chat_id::text as "replacedByChatId"
            from chats
            where id = ${predecessor.id}
          `)[0]!;
        }),
      );
      expect(linked).toEqual({
        archivedAt: expect.any(Date),
        replacedByChatId: replacementChatId,
      });
    });

    it("rejects a post-archive message without inserting a message or run", async () => {
      const userId = `demo-archive-reject-${crypto.randomUUID().slice(0, 8)}`;
      const predecessor = await runDb(isolatedUrl(), ensureDemoChat(userId));
      await runDb(
        isolatedUrl(),
        resetProductChat(
          { mode: "demo", userId, organizationId: null },
          predecessor.id,
          crypto.randomUUID(),
        ),
      );

      await expect(
        runDb(
          isolatedUrl(),
          createUserMessageAndRun(
            userId,
            messageInput("Must not be accepted"),
            runtimeConfig,
            null,
            predecessor.id,
          ),
        ),
      ).resolves.toEqual({ kind: "forbidden" });
      const counts = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly messages: number;
            readonly runs: number;
          }>`
            select
              (select count(*)::int from chat_messages where chat_id = ${predecessor.id}) as messages,
              (select count(*)::int from ai_runs where chat_id = ${predecessor.id}) as runs
          `)[0]!;
        }),
      );
      expect(counts).toEqual({ messages: 0, runs: 0 });
    });

    it("orders reset and message acceptance in both controlled lock outcomes", async () => {
      const runRace = async (winner: "message" | "reset") => {
        const userId = `demo-${winner}-first-${crypto.randomUUID().slice(0, 8)}`;
        const predecessor = await runDb(isolatedUrl(), ensureDemoChat(userId));
        const replacementChatId = crypto.randomUUID();
        let signalLaneHeld!: () => void;
        const laneHeld = new Promise<void>((resolve) => {
          signalLaneHeld = resolve;
        });
        let releaseLane!: () => void;
        const laneReleased = new Promise<void>((resolve) => {
          releaseLane = resolve;
        });
        const holder = runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`
                  select pg_advisory_xact_lock(hashtext(${`brief:user-memory:${userId}`}))
                `;
                yield* Effect.sync(signalLaneHeld);
                yield* Effect.promise(() => laneReleased);
              }),
            );
          }),
          `brief-${winner}-first-holder`,
        );
        await laneHeld;

        const message = () =>
          runDb(
            isolatedUrl(),
            createUserMessageAndRun(
              userId,
              messageInput(`${winner} first race`),
              runtimeConfig,
              null,
              predecessor.id,
            ),
            `brief-${winner}-first-message`,
          );
        const reset = () =>
          runDb(
            isolatedUrl(),
            resetProductChat(
              { mode: "demo", userId, organizationId: null },
              predecessor.id,
              replacementChatId,
            ),
            `brief-${winner}-first-reset`,
          );

        let messageResult!: Awaited<ReturnType<typeof message>>;
        let resetResult!: Awaited<ReturnType<typeof reset>>;
        try {
          if (winner === "message") {
            const pendingMessage = message();
            await waitForDatabaseLock(`brief-${winner}-first-message`);
            const pendingReset = reset();
            await waitForDatabaseLock(`brief-${winner}-first-reset`);
            releaseLane();
            [messageResult, resetResult] = await Promise.all([pendingMessage, pendingReset]);
          } else {
            const pendingReset = reset();
            await waitForDatabaseLock(`brief-${winner}-first-reset`);
            const pendingMessage = message();
            await waitForDatabaseLock(`brief-${winner}-first-message`);
            releaseLane();
            [resetResult, messageResult] = await Promise.all([pendingReset, pendingMessage]);
          }
        } finally {
          releaseLane();
          await holder;
        }

        const state = await runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return (yield* sql<{
              readonly messages: number;
              readonly runs: number;
              readonly archivedRuns: number;
            }>`
              select
                (select count(*)::int from chat_messages where chat_id = ${predecessor.id}) as messages,
                (select count(*)::int from ai_runs where chat_id = ${predecessor.id}) as runs,
                (
                  select count(*)::int
                  from ai_runs
                  where chat_id = ${predecessor.id}
                    and failed_at is not null
                    and error_code = 'chat_archived'
                    and retryable = false
                ) as "archivedRuns"
            `)[0]!;
          }),
        );
        return { messageResult, resetResult, state };
      };

      const messageFirst = await runRace("message");
      expect(messageFirst.messageResult.kind).toBe("accepted");
      expect(messageFirst.resetResult.kind).toBe("created");
      expect(messageFirst.state).toEqual({ messages: 1, runs: 1, archivedRuns: 1 });

      const resetFirst = await runRace("reset");
      expect(resetFirst.resetResult.kind).toBe("created");
      expect(resetFirst.messageResult).toEqual({ kind: "forbidden" });
      expect(resetFirst.state).toEqual({ messages: 0, runs: 0, archivedRuns: 0 });
    });
  },
);
