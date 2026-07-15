import { PgClient } from "@effect/sql-pg";
import { Effect, Fiber, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXPORT_ARCHIVE_FILE_EXTENSION,
  EXPORT_ARCHIVE_MEDIA_TYPE,
} from "@brief/shared/export-contract";
import { SERVER_NUMERIC_SETTING_HARD_MAXIMA } from "@brief/config";

import { runMigrations } from "../db/migrate";
import type { ExportObjectStore, NotificationEmailAdapter } from "./adapters";
import { consumeCredits, processStripeWebhookEvent } from "./billing";
import {
  buildTarArchive,
  failExportRequest,
  generateExport,
  purgeExpiredExportObjects,
} from "./exports";
import { createPlatformNotification, sendEmailNotification } from "./notifications";
import { purgeDeletedAccounts, purgeDeletedChats } from "./jobs";
import type { PlatformFileStoreShape } from "./file-store";

const isBun = typeof process.versions.bun === "string";
const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const databaseName = `brief_platform_services_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
const memoryDomainModuleUrl = new URL(
  "../../../../packages/backend-domain/src/memories.ts",
  import.meta.url,
).href;
const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "demo-user";
const now = new Date("2026-01-15T12:00:00.000Z");

const sourceUrl = () => {
  if (databaseUrl === undefined) throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  return databaseUrl;
};
const withDatabase = (name: string) => {
  const url = new URL(sourceUrl());
  url.pathname = `/${name}`;
  return url.toString();
};
const adminUrl = () => withDatabase("postgres");
const isolatedUrl = () => withDatabase(databaseName);
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

interface MemoryProjectionRecord {
  readonly id: string;
  readonly headRevisionId: string;
  readonly revisions: readonly { readonly id: string }[];
}

const loadMemoryDomain = async () =>
  (await import(/* @vite-ignore */ memoryDomainModuleUrl)) as {
    readonly listUserMemories: (
      userId: string,
    ) => Effect.Effect<
      { readonly memories: readonly MemoryProjectionRecord[] },
      unknown,
      PgClient.PgClient
    >;
    readonly deleteUserMemory: (
      userId: string,
      memoryId: string,
    ) => Effect.Effect<{ readonly status: string }, unknown, PgClient.PgClient>;
  };
const publisherStoreFrom = (store: ExportObjectStore): PlatformFileStoreShape => ({
  get: (objectKey) =>
    Effect.tryPromise({
      try: () => store.get(objectKey, { signal: new AbortController().signal }),
      catch: (cause) => new Error("publisher fixture read failed", { cause }),
    }),
  delete: (objectKey) =>
    Effect.tryPromise({
      try: () => store.delete(objectKey, { signal: new AbortController().signal }),
      catch: (cause) => new Error("publisher fixture delete failed", { cause }),
    }),
});

const runDb = <A, E>(url: string, effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName: "brief-platform-services-test",
        }),
      ),
    ),
  );

const runDbAs = <A, E>(
  applicationName: string,
  effect: Effect.Effect<A, E, PgClient.PgClient>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(isolatedUrl()),
          applicationName,
        }),
      ),
    ),
  );

const waitForDatabaseLock = async (applicationName: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly waiting: boolean }>`
          select exists(
            select 1 from pg_stat_activity
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

const waitForDatabaseBlocker = async (
  waitingApplicationName: string,
  blockingApplicationName: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const blocked = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly blocked: boolean }>`
            select exists(
              select 1
              from pg_stat_activity waiting
              cross join lateral unnest(pg_blocking_pids(waiting.pid)) blocker_pid
              join pg_stat_activity blocking on blocking.pid = blocker_pid
              where waiting.datname = current_database()
                and waiting.application_name = ${waitingApplicationName}
                and blocking.application_name = ${blockingApplicationName}
            ) as blocked
          `)[0]!.blocked;
      }),
    );
    if (blocked) return;
    await Bun.sleep(5);
  }
  throw new Error(`${waitingApplicationName} was not blocked by ${blockingApplicationName}`);
};

const holdMemoryRevisionTable = (applicationName: string) => {
  let signalHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    signalHeld = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = runDbAs(
    applicationName,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`lock table user_memory_revisions in access exclusive mode`;
          yield* Effect.sync(signalHeld);
          yield* Effect.promise(() => released);
        }),
      );
    }),
  );
  return { held, release, done };
};

const holdMemoryRow = (applicationName: string, memoryId: string) => {
  let signalHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    signalHeld = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = runDbAs(
    applicationName,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`select id from user_memories where id = ${memoryId} for update`;
          yield* Effect.sync(signalHeld);
          yield* Effect.promise(() => released);
        }),
      );
    }),
  );
  return { held, release, done };
};

const seedBase = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  yield* sql`
    insert into platform_users (id, primary_email, display_name, clerk_user_id)
    values (${userId}, 'demo@example.test', 'Demo User', 'clerk-demo')
  `;
  yield* sql`
    insert into client_companies (id, name, stripe_customer_id)
    values (${companyId}, 'Platform test company', 'cus_platform_test')
  `;
  yield* sql`
    insert into client_company_memberships (company_id, user_id, role)
    values (${companyId}, ${userId}, 'admin')
  `;
  yield* sql`
    insert into client_company_ai_settings (company_id)
    values (${companyId})
  `;
  const chats = yield* sql<{ readonly id: string }>`
    insert into chats (company_id, user_id, memory_mode)
    values (${companyId}, ${userId}, 'private_owner')
    returning id::text
  `;
  return chats[0]!.id;
});

const seedDeliveredIssue = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const publisherCompanyId = crypto.randomUUID();
  const subscriptionId = crypto.randomUUID();
  const accessId = crypto.randomUUID();
  const issueId = crypto.randomUUID();
  yield* sql`
    insert into publisher_companies (id, name)
    values (${publisherCompanyId}, 'Notification publisher')
  `;
  yield* sql`
    insert into publisher_subscriptions (id, publisher_company_id, name, created_by_user_id)
    values (${subscriptionId}, ${publisherCompanyId}, 'Notification subscription', ${userId})
  `;
  yield* sql`
    insert into client_subscription_accesses (
      id, subscription_id, client_company_id, state, first_admin_email,
      accepted_at, subscribed_at, created_by_user_id
    ) values (
      ${accessId}, ${subscriptionId}, ${companyId}, 'active', 'demo@example.test',
      now(), now(), ${userId}
    )
  `;
  yield* sql`
    insert into client_employee_subscription_grants (
      access_id, client_company_id, user_id, granted_by_user_id
    ) values (${accessId}, ${companyId}, ${userId}, ${userId})
  `;
  yield* sql`
    insert into publisher_issues (
      id, subscription_id, title, status, publication_at, published_at, created_by_user_id
    ) values (
      ${issueId}, ${subscriptionId}, 'Notification issue', 'published', now(), now(), ${userId}
    )
  `;
  yield* sql`
    insert into issue_deliveries (
      issue_id, subscription_id, access_id, client_company_id, historical
    ) values (${issueId}, ${subscriptionId}, ${accessId}, ${companyId}, false)
  `;
  yield* sql`
    insert into notification_preferences (
      client_company_id, user_id, email_issue_published
    ) values (${companyId}, ${userId}, true)
  `;
  return { issueId, accessId };
});

const createTerminalRun = (chatId: string, content: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const messages = yield* sql<{ readonly id: string }>`
      insert into chat_messages (chat_id, author, content)
      values (${chatId}, 'user', ${content})
      returning id::text
    `;
    const runs = yield* sql<{ readonly id: string }>`
      insert into ai_runs (
        chat_id, initiating_user_id, user_message_id, locale, market, finished_at
      ) values (${chatId}, ${userId}, ${messages[0]!.id}, 'en-US', 'US', ${now})
      returning id::text
    `;
    return runs[0]!.id;
  });

const insertStripeEvent = (id: string, type: string, object: Record<string, unknown>) => {
  const payload = { id, type, data: { object } };
  return Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      insert into stripe_webhook_events (stripe_event_id, event_type, payload, signed_payload)
      values (${id}, ${type}, ${sql.json(payload)}, ${JSON.stringify(payload)})
    `;
  });
};

describe.skipIf(!isBun || !databaseUrl)(
  "canonical platform notification/billing/export services",
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
    }, 120_000);

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
    }, 60_000);

    beforeEach(async () => {
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
          truncate table platform_users, publisher_companies, client_companies,
                         stripe_webhook_events, export_requests, jobs cascade
        `;
        }),
      );
    });

    it("deduplicates the notification outbox, honors default opt-in, and retries Resend idempotently", async () => {
      await runDb(isolatedUrl(), seedBase);
      const input = {
        clientCompanyId: companyId,
        userId,
        kind: "usage_limit_reached" as const,
        deduplicationKey: "usage-limit:2026-01:demo-user",
      };
      const results = await Promise.all(
        Array.from({ length: 6 }, () => runDb(isolatedUrl(), createPlatformNotification(input))),
      );
      expect(new Set(results.map((result) => result.notificationId)).size).toBe(1);
      expect(results.filter((result) => result.inserted)).toHaveLength(1);
      const deliveryId = results.find((result) => result.deliveryId !== null)!.deliveryId!;
      const counts = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ notifications: number; deliveries: number; jobs: number }>`
          select (select count(*)::int from platform_notifications) notifications,
                 (select count(*)::int from email_notification_deliveries) deliveries,
                 (select count(*)::int from jobs where kind = 'send_email_notification') jobs
        `)[0]!;
        }),
      );
      expect(counts).toEqual({ notifications: 1, deliveries: 1, jobs: 1 });

      const sentIdempotencyKeys: string[] = [];
      const failing: NotificationEmailAdapter = {
        send: vi.fn(async (email) => {
          sentIdempotencyKeys.push(email.idempotencyKey);
          throw Object.assign(new Error("do not persist secret sk_live_hostile"), {
            code: "invalid token sk_live_hostile",
          });
        }),
      };
      await expect(
        runDb(
          isolatedUrl(),
          sendEmailNotification({ deliveryId, adapter: failing, appBaseUrl: "https://brief.test" }),
        ),
      ).rejects.toThrow("provider_error");
      const failed = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ readonly errorCode: string }>`
            select last_error_code as "errorCode"
            from email_notification_deliveries where id = ${deliveryId}
          `)[0]!;
        }),
      );
      expect(failed.errorCode).toBe("provider_error");
      const succeeding: NotificationEmailAdapter = {
        send: vi.fn(async (email) => {
          sentIdempotencyKeys.push(email.idempotencyKey);
          return { providerMessageId: "resend-message-1" };
        }),
      };
      await expect(
        runDb(
          isolatedUrl(),
          sendEmailNotification({
            deliveryId,
            adapter: succeeding,
            appBaseUrl: "https://brief.test",
          }),
        ),
      ).resolves.toMatchObject({ status: "sent" });
      await runDb(
        isolatedUrl(),
        sendEmailNotification({
          deliveryId,
          adapter: succeeding,
          appBaseUrl: "https://brief.test",
        }),
      );
      expect(sentIdempotencyKeys).toEqual([
        `brief-email-${deliveryId}`,
        `brief-email-${deliveryId}`,
      ]);
      expect(succeeding.send).toHaveBeenCalledTimes(1);
      expect(succeeding.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "demo@example.test",
          subject: "La limite d’usage de l’IA Brief est atteinte",
          text: expect.stringContaining(
            `https://brief.test/fr-FR/client/${companyId}/notifications`,
          ),
          html: expect.stringContaining(
            `href="https://brief.test/fr-FR/client/${companyId}/notifications"`,
          ),
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const delivery = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            status: string;
            attempts: number;
            providerMessageId: string;
            lastErrorCode: string | null;
          }>`
          select status, attempts, provider_message_id as "providerMessageId",
                 last_error_code as "lastErrorCode"
          from email_notification_deliveries where id = ${deliveryId}
        `)[0]!;
        }),
      );
      expect(delivery).toEqual({
        status: "sent",
        attempts: 2,
        providerMessageId: "resend-message-1",
        lastErrorCode: null,
      });
    });

    it("uses the current email and selected locale for the exact delivered issue route", async () => {
      await runDb(isolatedUrl(), seedBase);
      const { issueId, accessId } = await runDb(isolatedUrl(), seedDeliveredIssue);
      const created = await runDb(
        isolatedUrl(),
        createPlatformNotification({
          clientCompanyId: companyId,
          userId,
          kind: "issue_published",
          issueId,
          accessId,
          deduplicationKey: `issue-published:${companyId}:${issueId}:${userId}`,
        }),
      );
      expect(created.deliveryId).not.toBeNull();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update platform_users
            set primary_email = 'current@example.test', updated_at = now()
            where id = ${userId}
          `;
          yield* sql`
            update notification_preferences
            set locale = 'en-US', updated_at = now()
            where client_company_id = ${companyId} and user_id = ${userId}
          `;
        }),
      );
      const sent: Array<{ readonly text: string; readonly html: string }> = [];
      const adapter: NotificationEmailAdapter = {
        send: vi.fn(async (email) => {
          sent.push(email);
          return { providerMessageId: "resend-issue-link" };
        }),
      };
      await runDb(
        isolatedUrl(),
        sendEmailNotification({
          deliveryId: created.deliveryId!,
          adapter,
          appBaseUrl: "https://brief.test/fr/",
        }),
      );

      const expectedUrl = `https://brief.test/en-US/client/${companyId}/issues/${issueId}`;
      expect(sent).toHaveLength(1);
      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "current@example.test",
          subject: "A new Brief issue is available",
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(sent[0]?.text).toContain(expectedUrl);
      expect(sent[0]?.html).toContain(`href="${expectedUrl}"`);
      expect(sent[0]?.text).not.toContain(`https://brief.test/fr-FR/`);
      expect(sent[0]?.html).not.toContain(`href="https://brief.test/client/`);
    });

    it("terminally cancels a current email opt-out without calling the provider and replays safely", async () => {
      await runDb(isolatedUrl(), seedBase);
      const created = await runDb(
        isolatedUrl(),
        createPlatformNotification({
          clientCompanyId: companyId,
          userId,
          kind: "usage_limit_reached",
          deduplicationKey: "usage-limit:opt-out",
        }),
      );
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into notification_preferences (
              client_company_id, user_id, locale, email_usage_limits
            ) values (${companyId}, ${userId}, 'en-US', false)
          `;
        }),
      );
      const adapter: NotificationEmailAdapter = { send: vi.fn() };
      await expect(
        runDb(
          isolatedUrl(),
          sendEmailNotification({
            deliveryId: created.deliveryId!,
            adapter,
            appBaseUrl: "https://brief.test",
          }),
        ),
      ).resolves.toEqual({ status: "cancelled", reasonCode: "email_opt_out" });
      await expect(
        runDb(
          isolatedUrl(),
          sendEmailNotification({
            deliveryId: created.deliveryId!,
            adapter,
            appBaseUrl: "https://brief.test",
          }),
        ),
      ).resolves.toEqual({ status: "already_cancelled", reasonCode: "email_opt_out" });
      expect(adapter.send).not.toHaveBeenCalled();
      const outcome = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly status: string;
            readonly attempts: number;
            readonly reasonCode: string;
            readonly cancelled: boolean;
          }>`
            select status, attempts, cancellation_reason_code as "reasonCode",
                   cancelled_at is not null as cancelled
            from email_notification_deliveries where id = ${created.deliveryId!}
          `)[0]!;
        }),
      );
      expect(outcome).toEqual({
        status: "cancelled",
        attempts: 0,
        reasonCode: "email_opt_out",
        cancelled: true,
      });
    });

    it("reauthorizes issue and pause-reminder grants at send time", async () => {
      await runDb(isolatedUrl(), seedBase);
      const { issueId, accessId } = await runDb(isolatedUrl(), seedDeliveredIssue);
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update client_subscription_accesses
            set state = 'ending', delivery_end_at = now() + interval '8 days', updated_at = now()
            where id = ${accessId}
          `;
        }),
      );
      const issue = await runDb(
        isolatedUrl(),
        createPlatformNotification({
          clientCompanyId: companyId,
          userId,
          kind: "issue_published",
          issueId,
          accessId,
          deduplicationKey: `issue-published:revocation:${issueId}`,
        }),
      );
      const reminder = await runDb(
        isolatedUrl(),
        createPlatformNotification({
          clientCompanyId: companyId,
          userId,
          kind: "delivery_ends_in_7_days",
          accessId,
          deduplicationKey: `delivery-reminder:revocation:${accessId}`,
        }),
      );
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update client_employee_subscription_grants
            set revoked_at = now(), revoked_by_user_id = ${userId}
            where access_id = ${accessId} and user_id = ${userId}
          `;
        }),
      );
      const adapter: NotificationEmailAdapter = { send: vi.fn() };
      for (const deliveryId of [issue.deliveryId!, reminder.deliveryId!]) {
        await expect(
          runDb(
            isolatedUrl(),
            sendEmailNotification({ deliveryId, adapter, appBaseUrl: "https://brief.test" }),
          ),
        ).resolves.toEqual({ status: "cancelled", reasonCode: "access_grant_revoked" });
      }
      expect(adapter.send).not.toHaveBeenCalled();
    });

    it("localizes every pause-notification branch with the current saved locale", async () => {
      await runDb(isolatedUrl(), seedBase);
      const { accessId } = await runDb(isolatedUrl(), seedDeliveredIssue);
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update notification_preferences
            set locale = 'en-US', email_delivery_reminders = true, updated_at = now()
            where client_company_id = ${companyId} and user_id = ${userId}
          `;
          yield* sql`
            update client_subscription_accesses
            set state = 'ending', delivery_end_at = now() + interval '8 days', updated_at = now()
            where id = ${accessId}
          `;
        }),
      );
      const scheduled = await runDb(
        isolatedUrl(),
        createPlatformNotification({
          clientCompanyId: companyId,
          userId,
          kind: "delivery_end_scheduled",
          accessId,
          deduplicationKey: `delivery-scheduled:localized:${accessId}`,
        }),
      );
      const sevenDays = await runDb(
        isolatedUrl(),
        createPlatformNotification({
          clientCompanyId: companyId,
          userId,
          kind: "delivery_ends_in_7_days",
          accessId,
          deduplicationKey: `delivery-seven-days:localized:${accessId}`,
        }),
      );
      const sent: Array<{ readonly subject: string; readonly text: string }> = [];
      const adapter: NotificationEmailAdapter = {
        send: vi.fn(async (email) => {
          sent.push(email);
          return { providerMessageId: `resend-pause-${sent.length}` };
        }),
      };
      for (const deliveryId of [scheduled.deliveryId!, sevenDays.deliveryId!]) {
        await runDb(
          isolatedUrl(),
          sendEmailNotification({ deliveryId, adapter, appBaseUrl: "https://brief.test" }),
        );
      }
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update client_subscription_accesses
            set state = 'paused', delivery_end_at = now(), paused_at = now(), updated_at = now()
            where id = ${accessId}
          `;
        }),
      );
      const ended = await runDb(
        isolatedUrl(),
        createPlatformNotification({
          clientCompanyId: companyId,
          userId,
          kind: "delivery_ended",
          accessId,
          deduplicationKey: `delivery-ended:localized:${accessId}`,
        }),
      );
      await runDb(
        isolatedUrl(),
        sendEmailNotification({
          deliveryId: ended.deliveryId!,
          adapter,
          appBaseUrl: "https://brief.test",
        }),
      );

      expect(sent.map((email) => email.subject)).toEqual([
        "A Brief delivery end date was scheduled",
        "Brief delivery ends in 7 days",
        "Brief delivery has ended",
      ]);
      for (const email of sent) {
        expect(email.text).toContain(`https://brief.test/en-US/client/${companyId}/notifications`);
      }
    });

    it("cancels a queued issue email when support restricts the issue", async () => {
      await runDb(isolatedUrl(), seedBase);
      const { issueId, accessId } = await runDb(isolatedUrl(), seedDeliveredIssue);
      const created = await runDb(
        isolatedUrl(),
        createPlatformNotification({
          clientCompanyId: companyId,
          userId,
          kind: "issue_published",
          issueId,
          accessId,
          deduplicationKey: `issue-published:restricted:${issueId}`,
        }),
      );
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update publisher_issues
            set restricted_at = now(), restricted_by_user_id = ${userId},
                restricted_reason = 'security response', updated_at = now()
            where id = ${issueId}
          `;
        }),
      );
      const adapter: NotificationEmailAdapter = { send: vi.fn() };
      await expect(
        runDb(
          isolatedUrl(),
          sendEmailNotification({
            deliveryId: created.deliveryId!,
            adapter,
            appBaseUrl: "https://brief.test",
          }),
        ),
      ).resolves.toEqual({ status: "cancelled", reasonCode: "issue_restricted" });
      expect(adapter.send).not.toHaveBeenCalled();
    });

    it("durably cancels stale jobs after membership, user, or company deletion", async () => {
      const scenarios = [
        {
          reasonCode: "membership_removed",
          mutate: Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const replacementUserId = `replacement-${crypto.randomUUID()}`;
            yield* sql`
              insert into platform_users (id, primary_email, display_name, clerk_user_id)
              values (
                ${replacementUserId}, ${`${replacementUserId}@example.test`},
                'Replacement admin', ${`clerk-${replacementUserId}`}
              )
            `;
            yield* sql`
              insert into client_company_memberships (company_id, user_id, role)
              values (${companyId}, ${replacementUserId}, 'admin')
            `;
            yield* sql`
              update client_company_memberships
              set revoked_at = now(), revoked_by_user_id = ${replacementUserId}
              where company_id = ${companyId} and user_id = ${userId}
            `;
          }),
        },
        {
          reasonCode: "user_inactive",
          mutate: Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update platform_users
              set recovery_deleted_at = now(), purge_after = now() + interval '180 days'
              where id = ${userId}
            `;
          }),
        },
        {
          reasonCode: "company_inactive",
          mutate: Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update client_companies
              set recovery_deleted_at = now(), purge_after = now() + interval '180 days'
              where id = ${companyId}
            `;
          }),
        },
      ] as const;

      for (const [index, scenario] of scenarios.entries()) {
        await runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              truncate table platform_users, publisher_companies, client_companies,
                             stripe_webhook_events, export_requests, jobs cascade
            `;
          }),
        );
        await runDb(isolatedUrl(), seedBase);
        const created = await runDb(
          isolatedUrl(),
          createPlatformNotification({
            clientCompanyId: companyId,
            userId,
            kind: "usage_limit_reached",
            deduplicationKey: `usage-limit:stale:${index}`,
          }),
        );
        await runDb(isolatedUrl(), scenario.mutate);
        const adapter: NotificationEmailAdapter = { send: vi.fn() };
        await expect(
          runDb(
            isolatedUrl(),
            sendEmailNotification({
              deliveryId: created.deliveryId!,
              adapter,
              appBaseUrl: "https://brief.test",
            }),
          ),
        ).resolves.toEqual({ status: "cancelled", reasonCode: scenario.reasonCode });
        expect(adapter.send).not.toHaveBeenCalled();
      }
    });

    it("cancels a pause reminder when the ending state changes before delivery", async () => {
      await runDb(isolatedUrl(), seedBase);
      const { accessId } = await runDb(isolatedUrl(), seedDeliveredIssue);
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update client_subscription_accesses
            set state = 'ending', delivery_end_at = now() + interval '8 days', updated_at = now()
            where id = ${accessId}
          `;
        }),
      );
      const created = await runDb(
        isolatedUrl(),
        createPlatformNotification({
          clientCompanyId: companyId,
          userId,
          kind: "delivery_ends_in_7_days",
          accessId,
          deduplicationKey: `delivery-reminder:state:${accessId}`,
        }),
      );
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update client_subscription_accesses
            set state = 'active', delivery_end_at = null, updated_at = now()
            where id = ${accessId}
          `;
        }),
      );
      const adapter: NotificationEmailAdapter = { send: vi.fn() };
      await expect(
        runDb(
          isolatedUrl(),
          sendEmailNotification({
            deliveryId: created.deliveryId!,
            adapter,
            appBaseUrl: "https://brief.test",
          }),
        ),
      ).resolves.toEqual({ status: "cancelled", reasonCode: "delivery_state_changed" });
      expect(adapter.send).not.toHaveBeenCalled();
    });

    it("fails malformed cross-company notification scopes without converting them to revocations", async () => {
      await runDb(isolatedUrl(), seedBase);
      const { accessId } = await runDb(isolatedUrl(), seedDeliveredIssue);
      const deliveryId = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const otherCompanyId = crypto.randomUUID();
          const otherAccessId = crypto.randomUUID();
          const subscriptions = yield* sql<{ readonly id: string }>`
            select subscription_id::text as id
            from client_subscription_accesses where id = ${accessId}
          `;
          yield* sql`
            insert into client_companies (id, name)
            values (${otherCompanyId}, 'Other notification company')
          `;
          yield* sql`
            insert into client_subscription_accesses (
              id, subscription_id, client_company_id, state, first_admin_email,
              accepted_at, subscribed_at, delivery_end_at, created_by_user_id
            ) values (
              ${otherAccessId}, ${subscriptions[0]!.id}, ${otherCompanyId}, 'ending',
              'other@example.test', now(), now(), now() + interval '8 days', ${userId}
            )
          `;
          const notifications = yield* sql<{ readonly id: string }>`
            insert into platform_notifications (
              client_company_id, user_id, kind, access_id, deduplication_key
            ) values (
              ${companyId}, ${userId}, 'delivery_ends_in_7_days', ${otherAccessId},
              ${`malformed-cross-tenant:${otherAccessId}`}
            )
            returning id::text
          `;
          const deliveries = yield* sql<{ readonly id: string }>`
            insert into email_notification_deliveries (notification_id, recipient_email)
            values (${notifications[0]!.id}, 'demo@example.test')
            returning id::text
          `;
          return deliveries[0]!.id;
        }),
      );
      const adapter: NotificationEmailAdapter = { send: vi.fn() };
      await expect(
        runDb(
          isolatedUrl(),
          sendEmailNotification({ deliveryId, adapter, appBaseUrl: "https://brief.test" }),
        ),
      ).rejects.toThrow("notification_scope_tenant_mismatch");
      expect(adapter.send).not.toHaveBeenCalled();
      const state = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ readonly status: string; readonly attempts: number }>`
            select status, attempts from email_notification_deliveries where id = ${deliveryId}
          `)[0]!;
        }),
      );
      expect(state).toEqual({ status: "queued", attempts: 0 });
    });

    it("serializes concurrent delivery replays to one provider call", async () => {
      await runDb(isolatedUrl(), seedBase);
      const created = await runDb(
        isolatedUrl(),
        createPlatformNotification({
          clientCompanyId: companyId,
          userId,
          kind: "usage_limit_reached",
          deduplicationKey: "usage-limit:concurrent-send",
        }),
      );
      const adapter: NotificationEmailAdapter = {
        send: vi.fn(async () => {
          await Promise.resolve();
          return { providerMessageId: "resend-concurrent" };
        }),
      };
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          runDb(
            isolatedUrl(),
            sendEmailNotification({
              deliveryId: created.deliveryId!,
              adapter,
              appBaseUrl: "https://brief.test",
            }),
          ),
        ),
      );
      expect(results.filter((result) => result.status === "sent")).toHaveLength(1);
      expect(results.filter((result) => result.status === "already_sent")).toHaveLength(3);
      expect(adapter.send).toHaveBeenCalledTimes(1);
    });

    it("holds the membership authorization lane through the bounded email provider call", async () => {
      await runDb(isolatedUrl(), seedBase);
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into platform_users (id, primary_email, display_name, clerk_user_id)
            values ('notification-admin-2', 'notification-admin-2@example.test',
                    'Notification Admin 2', 'clerk-notification-admin-2')
          `;
          yield* sql`
            insert into client_company_memberships (company_id, user_id, role)
            values (${companyId}, 'notification-admin-2', 'admin')
          `;
        }),
      );
      const created = await runDb(
        isolatedUrl(),
        createPlatformNotification({
          clientCompanyId: companyId,
          userId,
          kind: "usage_limit_reached",
          deduplicationKey: "usage-limit:membership-provider-race",
        }),
      );
      let signalProvider!: () => void;
      const providerStarted = new Promise<void>((resolve) => {
        signalProvider = resolve;
      });
      let releaseProvider!: () => void;
      const providerReleased = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      const adapter: NotificationEmailAdapter = {
        send: vi.fn(async (_email, options) => {
          expect(options.signal.aborted).toBe(false);
          signalProvider();
          await providerReleased;
          return { providerMessageId: "resend-membership-race" };
        }),
      };
      const sending = runDb(
        isolatedUrl(),
        sendEmailNotification({
          deliveryId: created.deliveryId!,
          adapter,
          appBaseUrl: "https://brief.test",
        }),
      );
      await providerStarted;
      let revocationFinished = false;
      const revocation = runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                select pg_advisory_xact_lock(hashtext(${`brief:client-members:${companyId}`}))
              `;
              yield* sql`
                update client_company_memberships
                set revoked_at = now(), revoked_by_user_id = 'notification-admin-2'
                where company_id = ${companyId} and user_id = ${userId}
              `;
            }),
          );
        }),
      ).then(() => {
        revocationFinished = true;
      });
      let revocationWaiting = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const waiting = await runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return (yield* sql<{ readonly count: number }>`
              select count(*)::int count
              from pg_locks
              where locktype = 'advisory' and granted = false
                and database = (select oid from pg_database where datname = current_database())
            `)[0]!.count;
          }),
        );
        if (waiting > 0) {
          revocationWaiting = true;
          break;
        }
        await Bun.sleep(5);
      }
      expect(revocationWaiting).toBe(true);
      expect(revocationFinished).toBe(false);
      releaseProvider();
      await expect(sending).resolves.toEqual({
        status: "sent",
        providerMessageId: "resend-membership-race",
      });
      await revocation;
      expect(adapter.send).toHaveBeenCalledTimes(1);
    });

    it("holds the live recipient row through email issuance against Clerk user deletion", async () => {
      await runDb(isolatedUrl(), seedBase);
      const created = await runDb(
        isolatedUrl(),
        createPlatformNotification({
          clientCompanyId: companyId,
          userId,
          kind: "usage_limit_reached",
          deduplicationKey: "usage-limit:clerk-user-provider-race",
        }),
      );
      let signalProvider!: () => void;
      const providerStarted = new Promise<void>((resolve) => {
        signalProvider = resolve;
      });
      let releaseProvider!: () => void;
      const providerReleased = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      const adapter: NotificationEmailAdapter = {
        send: vi.fn(async (_email, options) => {
          expect(options.signal.aborted).toBe(false);
          signalProvider();
          await providerReleased;
          return { providerMessageId: "resend-clerk-user-race" };
        }),
      };
      const sending = runDb(
        isolatedUrl(),
        sendEmailNotification({
          deliveryId: created.deliveryId!,
          adapter,
          appBaseUrl: "https://brief.test",
        }),
      );
      await providerStarted;
      let deletionFinished = false;
      const deletion = runDbAs(
        "notification-clerk-user-deletion-race",
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update platform_users
            set recovery_deleted_at = now(), purge_after = now() + interval '180 days',
                updated_at = now()
            where id = ${userId}
          `;
        }),
      ).then(() => {
        deletionFinished = true;
      });
      await waitForDatabaseLock("notification-clerk-user-deletion-race");
      expect(deletionFinished).toBe(false);
      releaseProvider();
      await expect(sending).resolves.toEqual({
        status: "sent",
        providerMessageId: "resend-clerk-user-race",
      });
      await deletion;
      expect(adapter.send).toHaveBeenCalledTimes(1);
    });

    it("holds the live company row through email issuance against approved company deletion", async () => {
      await runDb(isolatedUrl(), seedBase);
      const created = await runDb(
        isolatedUrl(),
        createPlatformNotification({
          clientCompanyId: companyId,
          userId,
          kind: "usage_limit_reached",
          deduplicationKey: "usage-limit:company-deletion-provider-race",
        }),
      );
      let signalProvider!: () => void;
      const providerStarted = new Promise<void>((resolve) => {
        signalProvider = resolve;
      });
      let releaseProvider!: () => void;
      const providerReleased = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      const adapter: NotificationEmailAdapter = {
        send: vi.fn(async (_email, options) => {
          expect(options.signal.aborted).toBe(false);
          signalProvider();
          await providerReleased;
          return { providerMessageId: "resend-company-deletion-race" };
        }),
      };
      const sending = runDb(
        isolatedUrl(),
        sendEmailNotification({
          deliveryId: created.deliveryId!,
          adapter,
          appBaseUrl: "https://brief.test",
        }),
      );
      await providerStarted;
      let deletionFinished = false;
      const deletion = runDbAs(
        "notification-company-deletion-race",
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update client_companies
            set recovery_deleted_at = now(), purge_after = now() + interval '180 days',
                updated_at = now()
            where id = ${companyId}
          `;
        }),
      ).then(() => {
        deletionFinished = true;
      });
      await waitForDatabaseLock("notification-company-deletion-race");
      expect(deletionFinished).toBe(false);
      releaseProvider();
      await expect(sending).resolves.toEqual({
        status: "sent",
        providerMessageId: "resend-company-deletion-race",
      });
      await deletion;
      expect(adapter.send).toHaveBeenCalledTimes(1);
    });

    it("enforces locale, bounded machine outcomes, and immutable cancellation in Postgres", async () => {
      await runDb(isolatedUrl(), seedBase);
      await expect(
        runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into notification_preferences (client_company_id, user_id, locale)
              values (${companyId}, ${userId}, 'de-DE')
            `;
          }),
        ),
      ).rejects.toThrow();
      const created = await runDb(
        isolatedUrl(),
        createPlatformNotification({
          clientCompanyId: companyId,
          userId,
          kind: "usage_limit_reached",
          deduplicationKey: "usage-limit:db-invariants",
        }),
      );
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update email_notification_deliveries
            set status = 'sending', attempts = 1, updated_at = now()
            where id = ${created.deliveryId!}
          `;
        }),
      );
      await expect(
        runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update email_notification_deliveries
              set status = 'failed', last_error_code = 'secret_sk_live_hostile', updated_at = now()
              where id = ${created.deliveryId!}
            `;
          }),
        ),
      ).rejects.toThrow();
      await expect(
        runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update email_notification_deliveries
              set status = 'cancelled', cancellation_reason_code = 'invalid reason',
                  cancelled_at = now(), updated_at = now()
              where id = ${created.deliveryId!}
            `;
          }),
        ),
      ).rejects.toThrow();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update email_notification_deliveries
            set status = 'cancelled', cancellation_reason_code = 'email_opt_out',
                cancelled_at = now(), updated_at = now()
            where id = ${created.deliveryId!}
          `;
        }),
      );
      await expect(
        runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update email_notification_deliveries set attempts = attempts + 1
              where id = ${created.deliveryId!}
            `;
          }),
        ),
      ).rejects.toThrow();
    });

    it("processes signed Stripe state idempotently into monthly and 12-month additional lots", async () => {
      await runDb(isolatedUrl(), seedBase);
      await runDb(
        isolatedUrl(),
        insertStripeEvent("evt-subscription", "customer.subscription.updated", {
          id: "sub_platform",
          customer: "cus_platform_test",
          status: "active",
          metadata: { brief_client_company_id: companyId, brief_plan_tier: "team" },
          items: {
            data: [
              {
                quantity: 1,
                current_period_start: 1767225600,
                current_period_end: 1769904000,
                price: { id: "price_team", metadata: { brief_plan_tier: "team" } },
              },
            ],
          },
        }),
      );
      await runDb(isolatedUrl(), processStripeWebhookEvent("evt-subscription"));
      await runDb(
        isolatedUrl(),
        insertStripeEvent("evt-invoice", "invoice.paid", {
          id: "in_platform",
          customer: "cus_platform_test",
          status: "paid",
          paid: true,
          amount_paid: 2_500,
          billing_reason: "subscription_cycle",
          metadata: { brief_credits: "100" },
          parent: {
            subscription_details: { subscription: "sub_platform", metadata: {} },
          },
          lines: {
            data: [
              {
                metadata: {},
                quantity: 1,
                pricing: { type: "price_details", price_details: { price: "price_team" } },
                period: { start: 1767225600, end: 1769904000 },
              },
            ],
          },
        }),
      );
      const invoiceResults = await Promise.all(
        Array.from({ length: 4 }, () =>
          runDb(isolatedUrl(), processStripeWebhookEvent("evt-invoice")),
        ),
      );
      expect(invoiceResults.filter((result) => result.status === "processed")).toHaveLength(1);
      await runDb(
        isolatedUrl(),
        insertStripeEvent("evt-additional", "checkout.session.completed", {
          id: "cs_platform",
          customer: "cus_platform_test",
          client_reference_id: companyId,
          created: 1768435200,
          status: "complete",
          payment_status: "paid",
          amount_total: 4_000,
          payment_intent: "pi_platform",
          metadata: {
            brief_client_company_id: companyId,
            brief_purchase_kind: "additional_credits",
            brief_credits: "40",
          },
        }),
      );
      await runDb(isolatedUrl(), processStripeWebhookEvent("evt-additional"));
      await runDb(
        isolatedUrl(),
        insertStripeEvent("evt-additional-async", "checkout.session.async_payment_succeeded", {
          id: "cs_platform_async",
          customer: "cus_platform_test",
          client_reference_id: companyId,
          created: 1768435300,
          status: "complete",
          payment_status: "paid",
          amount_total: 2_000,
          payment_intent: "pi_platform_async",
          metadata: {
            brief_client_company_id: companyId,
            brief_purchase_kind: "additional_credits",
            brief_credits: "20",
          },
        }),
      );
      await runDb(isolatedUrl(), processStripeWebhookEvent("evt-additional-async"));
      const state = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const account = (yield* sql<{
            status: string;
            planTier: string;
            subscriptionId: string;
          }>`
          select status, plan_tier as "planTier", stripe_subscription_id as "subscriptionId"
          from client_ai_billing_accounts where client_company_id = ${companyId}
        `)[0]!;
          const lots = yield* sql<{
            kind: string;
            granted: number;
            months: number;
          }>`
          select kind, credits_granted::int as granted,
                 extract(year from age(expires_at, available_at))::int * 12
                   + extract(month from age(expires_at, available_at))::int as months
          from client_credit_lots where client_company_id = ${companyId}
          order by kind desc, credits_granted desc
        `;
          return { account, lots };
        }),
      );
      expect(state.account).toEqual({
        status: "active",
        planTier: "team",
        subscriptionId: "sub_platform",
      });
      expect(state.lots).toEqual([
        { kind: "monthly", granted: 100, months: 1 },
        { kind: "additional", granted: 40, months: 12 },
        { kind: "additional", granted: 20, months: 12 },
      ]);
      const persistedEvent = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ readonly objectId: string; readonly processed: boolean }>`
              select payload #>> '{data,object,id}' as "objectId",
                     processed_at is not null as processed
              from stripe_webhook_events where stripe_event_id = 'evt-additional'
            `)[0]!;
        }),
      );
      expect(persistedEvent).toEqual({ objectId: "cs_platform", processed: true });
    });

    it("defers delayed Checkout payments and rejects unbound or non-invoice-authored grants", async () => {
      await runDb(isolatedUrl(), seedBase);
      await runDb(
        isolatedUrl(),
        insertStripeEvent("evt-invoice-fallback-credits", "invoice.paid", {
          id: "in_fallback_credits",
          customer: "cus_platform_test",
          status: "paid",
          paid: true,
          amount_paid: 2_500,
          billing_reason: "subscription_cycle",
          metadata: {},
          parent: {
            subscription_details: {
              subscription: "sub_platform",
              metadata: { brief_credits: "100" },
            },
          },
          lines: {
            data: [
              {
                metadata: { brief_credits: "100" },
                quantity: 1,
                pricing: { type: "price_details", price_details: { price: "price_team" } },
                period: { start: 1767225600, end: 1769904000 },
              },
            ],
          },
        }),
      );
      await expect(
        runDb(isolatedUrl(), processStripeWebhookEvent("evt-invoice-fallback-credits")),
      ).rejects.toBeDefined();

      await runDb(
        isolatedUrl(),
        insertStripeEvent("evt-additional-unpaid", "checkout.session.completed", {
          id: "cs_unpaid",
          customer: "cus_platform_test",
          client_reference_id: companyId,
          created: 1768435200,
          status: "complete",
          payment_status: "unpaid",
          amount_total: 4_000,
          payment_intent: "pi_unpaid",
          metadata: {
            brief_client_company_id: companyId,
            brief_purchase_kind: "additional_credits",
            brief_credits: "40",
          },
        }),
      );
      await expect(
        runDb(isolatedUrl(), processStripeWebhookEvent("evt-additional-unpaid")),
      ).resolves.toMatchObject({ status: "processed" });
      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-additional-delayed-paid",
          "checkout.session.async_payment_succeeded",
          {
            id: "cs_unpaid",
            customer: "cus_platform_test",
            client_reference_id: companyId,
            created: 1768435200,
            status: "complete",
            payment_status: "paid",
            amount_total: 4_000,
            payment_intent: "pi_unpaid",
            metadata: {
              brief_client_company_id: companyId,
              brief_purchase_kind: "additional_credits",
              brief_credits: "40",
            },
          },
        ),
      );
      await expect(
        runDb(isolatedUrl(), processStripeWebhookEvent("evt-additional-delayed-paid")),
      ).resolves.toMatchObject({ status: "processed" });
      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-additional-reverse-paid",
          "checkout.session.async_payment_succeeded",
          {
            id: "cs_reverse",
            customer: "cus_platform_test",
            client_reference_id: companyId,
            created: 1768435300,
            status: "complete",
            payment_status: "paid",
            amount_total: 3_000,
            payment_intent: "pi_reverse",
            metadata: {
              brief_client_company_id: companyId,
              brief_purchase_kind: "additional_credits",
              brief_credits: "30",
            },
          },
        ),
      );
      await runDb(isolatedUrl(), processStripeWebhookEvent("evt-additional-reverse-paid"));
      await runDb(
        isolatedUrl(),
        insertStripeEvent("evt-additional-reverse-unpaid", "checkout.session.completed", {
          id: "cs_reverse",
          customer: "cus_platform_test",
          client_reference_id: companyId,
          created: 1768435300,
          status: "complete",
          payment_status: "unpaid",
          amount_total: 3_000,
          payment_intent: "pi_reverse",
          metadata: {
            brief_client_company_id: companyId,
            brief_purchase_kind: "additional_credits",
            brief_credits: "30",
          },
        }),
      );
      await expect(
        runDb(isolatedUrl(), processStripeWebhookEvent("evt-additional-reverse-unpaid")),
      ).resolves.toMatchObject({ status: "processed" });
      for (const [eventId, eventType, status] of [
        ["evt-additional-delayed-failed", "checkout.session.async_payment_failed", "complete"],
        ["evt-additional-expired", "checkout.session.expired", "expired"],
      ] as const) {
        await runDb(
          isolatedUrl(),
          insertStripeEvent(eventId, eventType, {
            id: `cs_${eventId}`,
            customer: "cus_platform_test",
            client_reference_id: companyId,
            created: 1768435400,
            status,
            payment_status: "unpaid",
            amount_total: 2_000,
            metadata: {
              brief_client_company_id: companyId,
              brief_purchase_kind: "additional_credits",
              brief_credits: "20",
            },
          }),
        );
        await expect(
          runDb(isolatedUrl(), processStripeWebhookEvent(eventId)),
        ).resolves.toMatchObject({ status: "processed" });
      }

      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`update client_companies set stripe_customer_id = null where id = ${companyId}`;
        }),
      );
      await runDb(
        isolatedUrl(),
        insertStripeEvent("evt-additional-unbound", "checkout.session.completed", {
          id: "cs_unbound",
          customer: "cus_new_untrusted",
          client_reference_id: companyId,
          created: 1768435200,
          status: "complete",
          payment_status: "paid",
          amount_total: 4_000,
          payment_intent: "pi_unbound",
          metadata: {
            brief_client_company_id: companyId,
            brief_purchase_kind: "additional_credits",
            brief_credits: "40",
          },
        }),
      );
      await expect(
        runDb(isolatedUrl(), processStripeWebhookEvent("evt-additional-unbound")),
      ).rejects.toBeDefined();
      const state = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly lots: number;
            readonly granted: number;
            readonly customerId: string | null;
            readonly errors: number;
          }>`
              select
                (select count(*)::int from client_credit_lots
                  where client_company_id = ${companyId}) lots,
                (select coalesce(sum(credits_granted), 0)::int from client_credit_lots
                  where client_company_id = ${companyId}) granted,
                (select stripe_customer_id from client_companies
                  where id = ${companyId}) as "customerId",
                (select count(*)::int from stripe_webhook_events
                  where processing_error_code is not null) errors
            `)[0]!;
        }),
      );
      expect(state).toEqual({ lots: 2, granted: 70, customerId: null, errors: 2 });
    });

    it("requires subscription and price plan metadata to be present and identical", async () => {
      await runDb(isolatedUrl(), seedBase);
      const subscriptionObject = (
        eventId: string,
        subscriptionTier: string | undefined,
        priceTier: string | undefined,
      ) => ({
        id: `sub_${eventId}`,
        customer: "cus_platform_test",
        status: "active",
        metadata: {
          brief_client_company_id: companyId,
          ...(subscriptionTier === undefined ? {} : { brief_plan_tier: subscriptionTier }),
        },
        items: {
          data: [
            {
              quantity: 1,
              current_period_start: 1767225600,
              current_period_end: 1769904000,
              price: {
                id: "price_team",
                metadata: priceTier === undefined ? {} : { brief_plan_tier: priceTier },
              },
            },
          ],
        },
      });
      for (const [eventId, subscriptionTier, priceTier] of [
        ["missing-subscription-tier", undefined, "team"],
        ["missing-price-tier", "team", undefined],
        ["mismatched-tier", "team", "light"],
      ] as const) {
        await runDb(
          isolatedUrl(),
          insertStripeEvent(
            eventId,
            "customer.subscription.updated",
            subscriptionObject(eventId, subscriptionTier, priceTier),
          ),
        );
        await expect(
          runDb(isolatedUrl(), processStripeWebhookEvent(eventId)),
        ).rejects.toBeDefined();
      }
      const state = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ readonly accounts: number; readonly errors: number }>`
              select
                (select count(*)::int from client_ai_billing_accounts
                  where client_company_id = ${companyId}) accounts,
                (select count(*)::int from stripe_webhook_events
                  where processing_error_code is not null) errors
            `)[0]!;
        }),
      );
      expect(state).toEqual({ accounts: 0, errors: 3 });
    });

    it("replaces only a terminal monthly subscription and rejects stale old-subscription events", async () => {
      await runDb(isolatedUrl(), seedBase);
      const subscription = (input: {
        readonly id: string;
        readonly tier: "light" | "team";
        readonly status: string;
        readonly start: number;
        readonly end: number;
        readonly monthlyCheckout?: boolean;
      }) => ({
        id: input.id,
        customer: "cus_platform_test",
        status: input.status,
        metadata: {
          brief_client_company_id: companyId,
          brief_plan_tier: input.tier,
          ...(input.monthlyCheckout ? { brief_purchase_kind: "monthly_plan" } : {}),
        },
        items: {
          data: [
            {
              quantity: 1,
              current_period_start: input.start,
              current_period_end: input.end,
              price: {
                id: `price_${input.tier}`,
                metadata: { brief_plan_tier: input.tier },
              },
            },
          ],
        },
      });
      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-replacement-old-active",
          "customer.subscription.updated",
          subscription({
            id: "sub_replacement_old",
            tier: "team",
            status: "active",
            start: 1767225600,
            end: 1769904000,
          }),
        ),
      );
      await runDb(isolatedUrl(), processStripeWebhookEvent("evt-replacement-old-active"));
      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-replacement-old-deleted",
          "customer.subscription.deleted",
          subscription({
            id: "sub_replacement_old",
            tier: "team",
            status: "canceled",
            start: 1767225600,
            end: 1769904000,
          }),
        ),
      );
      await runDb(isolatedUrl(), processStripeWebhookEvent("evt-replacement-old-deleted"));
      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-replacement-same-id-stale-active",
          "customer.subscription.updated",
          subscription({
            id: "sub_replacement_old",
            tier: "team",
            status: "active",
            start: 1767225600,
            end: 1769904000,
          }),
        ),
      );
      await expect(
        runDb(isolatedUrl(), processStripeWebhookEvent("evt-replacement-same-id-stale-active")),
      ).rejects.toBeDefined();
      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-replacement-new-incomplete",
          "customer.subscription.created",
          subscription({
            id: "sub_replacement_new",
            tier: "light",
            status: "incomplete",
            start: 1769904000,
            end: 1772323200,
            monthlyCheckout: true,
          }),
        ),
      );
      await expect(
        runDb(isolatedUrl(), processStripeWebhookEvent("evt-replacement-new-incomplete")),
      ).resolves.toMatchObject({ status: "processed" });
      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-replacement-new-active",
          "customer.subscription.updated",
          subscription({
            id: "sub_replacement_new",
            tier: "light",
            status: "active",
            start: 1769904000,
            end: 1772323200,
            monthlyCheckout: true,
          }),
        ),
      );
      await runDb(isolatedUrl(), processStripeWebhookEvent("evt-replacement-new-active"));
      for (const [eventId, eventType, status] of [
        ["evt-replacement-stale-old-updated", "customer.subscription.updated", "active"],
        ["evt-replacement-stale-old-deleted", "customer.subscription.deleted", "canceled"],
      ] as const) {
        await runDb(
          isolatedUrl(),
          insertStripeEvent(
            eventId,
            eventType,
            subscription({
              id: "sub_replacement_old",
              tier: "team",
              status,
              start: 1767225600,
              end: 1769904000,
            }),
          ),
        );
        await expect(
          runDb(isolatedUrl(), processStripeWebhookEvent(eventId)),
        ).rejects.toBeDefined();
      }
      const account = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly subscriptionId: string;
            readonly tier: string;
            readonly status: string;
            readonly periodStart: Date;
          }>`
              select stripe_subscription_id as "subscriptionId", plan_tier as tier, status,
                     current_period_start as "periodStart"
              from client_ai_billing_accounts where client_company_id = ${companyId}
            `)[0]!;
        }),
      );
      expect(account).toEqual({
        subscriptionId: "sub_replacement_new",
        tier: "light",
        status: "active",
        periodStart: new Date(1769904000 * 1000),
      });
    });

    it("projects owned downgrade schedules at the next cycle and preserves additional credits", async () => {
      await runDb(isolatedUrl(), seedBase);
      const subscriptionPayload = (tier: "light" | "team", start: number, end: number) => ({
        id: "sub_plan_change",
        customer: "cus_platform_test",
        status: "active",
        metadata: { brief_client_company_id: companyId, brief_plan_tier: tier },
        items: {
          data: [
            {
              quantity: 1,
              current_period_start: start,
              current_period_end: end,
              price: { id: `price_${tier}`, metadata: { brief_plan_tier: tier } },
            },
          ],
        },
      });
      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-plan-subscription-initial",
          "customer.subscription.updated",
          subscriptionPayload("team", 1767225600, 1769904000),
        ),
      );
      await runDb(isolatedUrl(), processStripeWebhookEvent("evt-plan-subscription-initial"));
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into client_ai_plan_change_requests (
              client_company_id, idempotency_key, requested_by_user_id,
              authorization_request_id, authorization_session_id,
              previous_tier, target_tier, stripe_customer_id, stripe_subscription_id,
              previous_price_id, target_price_id, current_period_end, status
            ) values (
              ${companyId}, 'downgrade-plan-0001', ${userId},
              '90000000-0000-4000-8000-000000000010', 'worker-test-session', 'team', 'light',
              'cus_platform_test', 'sub_plan_change', 'price_team', 'price_light',
              to_timestamp(1769904000), 'processing'
            )
          `;
          yield* sql`
            insert into client_credit_lots (
              client_company_id, kind, credits_granted, credits_remaining,
              available_at, expires_at, stripe_payment_id
            ) values (
              ${companyId}, 'additional', 75, 75, '2026-01-01', '2027-01-01',
              'payment:plan-change-additional'
            )
          `;
        }),
      );
      const schedulePayload = (status: string) => ({
        id: "sub_sched_plan_change",
        subscription: "sub_plan_change",
        status,
        current_phase: { start_date: 1767225600, end_date: 1769904000 },
        end_behavior: "release",
        phases: [
          {
            start_date: 1767225600,
            end_date: 1769904000,
            items: [{ price: "price_team", quantity: 1 }],
            proration_behavior: "none",
            metadata: {
              brief_client_company_id: companyId,
              brief_plan_change_key: "downgrade-plan-0001",
              brief_plan_previous_tier: "team",
              brief_plan_tier: "team",
            },
          },
          {
            start_date: 1769904000,
            items: [{ price: "price_light", quantity: 1 }],
            proration_behavior: "none",
            metadata: {
              brief_client_company_id: companyId,
              brief_plan_change_key: "downgrade-plan-0001",
              brief_plan_previous_tier: "team",
              brief_plan_tier: "light",
            },
          },
        ],
        metadata: {
          brief_client_company_id: companyId,
          brief_plan_change_key: "downgrade-plan-0001",
          brief_plan_tier: "light",
        },
      });
      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-plan-schedule-active",
          "subscription_schedule.updated",
          schedulePayload("active"),
        ),
      );
      await runDb(isolatedUrl(), processStripeWebhookEvent("evt-plan-schedule-active"));

      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-plan-subscription-current",
          "customer.subscription.updated",
          subscriptionPayload("team", 1767225600, 1769904000),
        ),
      );
      await runDb(isolatedUrl(), processStripeWebhookEvent("evt-plan-subscription-current"));
      const pending = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            tier: string;
            pendingTier: string | null;
            pendingScheduleId: string | null;
          }>`
            select plan_tier as tier, pending_downgrade_tier as "pendingTier",
                   pending_downgrade_schedule_id as "pendingScheduleId"
            from client_ai_billing_accounts where client_company_id = ${companyId}
          `)[0]!;
        }),
      );
      expect(pending).toEqual({
        tier: "team",
        pendingTier: "light",
        pendingScheduleId: "sub_sched_plan_change",
      });
      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-plan-subscription-target-before-request-success",
          "customer.subscription.updated",
          subscriptionPayload("light", 1769904000, 1772323200),
        ),
      );
      await expect(
        runDb(
          isolatedUrl(),
          processStripeWebhookEvent("evt-plan-subscription-target-before-request-success"),
        ),
      ).rejects.toBeDefined();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update client_ai_plan_change_requests
            set status = 'succeeded', outcome = 'downgrade_scheduled',
                effective_at = to_timestamp(1769904000),
                external_operation_id = 'sub_sched_plan_change'
            where client_company_id = ${companyId}
              and idempotency_key = 'downgrade-plan-0001'
          `;
        }),
      );

      const tamperedTerminalSchedule = schedulePayload("completed");
      tamperedTerminalSchedule.phases[1]!.items[0]!.price = "price_unowned";
      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-plan-schedule-tampered-terminal",
          "subscription_schedule.completed",
          tamperedTerminalSchedule,
        ),
      );
      await expect(
        runDb(isolatedUrl(), processStripeWebhookEvent("evt-plan-schedule-tampered-terminal")),
      ).rejects.toBeDefined();

      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-plan-schedule-completed-first",
          "subscription_schedule.completed",
          schedulePayload("completed"),
        ),
      );
      await runDb(isolatedUrl(), processStripeWebhookEvent("evt-plan-schedule-completed-first"));
      const afterScheduleCompletion = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly tier: string;
            readonly pendingTier: string | null;
            readonly pendingScheduleId: string | null;
          }>`
              select plan_tier as tier, pending_downgrade_tier as "pendingTier",
                     pending_downgrade_schedule_id as "pendingScheduleId"
              from client_ai_billing_accounts where client_company_id = ${companyId}
            `)[0]!;
        }),
      );
      expect(afterScheduleCompletion).toEqual(pending);
      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-plan-subscription-next-cycle",
          "customer.subscription.updated",
          subscriptionPayload("light", 1769904000, 1772323200),
        ),
      );
      await runDb(isolatedUrl(), processStripeWebhookEvent("evt-plan-subscription-next-cycle"));
      const completed = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            tier: string;
            pendingTier: string | null;
            pendingScheduleId: string | null;
            additionalRemaining: number;
          }>`
            select billing.plan_tier as tier,
                   billing.pending_downgrade_tier as "pendingTier",
                   billing.pending_downgrade_schedule_id as "pendingScheduleId",
                   (select credits_remaining::int from client_credit_lots
                    where stripe_payment_id = 'payment:plan-change-additional')
                     as "additionalRemaining"
            from client_ai_billing_accounts billing
            where billing.client_company_id = ${companyId}
          `)[0]!;
        }),
      );
      expect(completed).toEqual({
        tier: "light",
        pendingTier: null,
        pendingScheduleId: null,
        additionalRemaining: 75,
      });
      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-plan-schedule-released-after-transition",
          "subscription_schedule.released",
          schedulePayload("released"),
        ),
      );
      await expect(
        runDb(
          isolatedUrl(),
          processStripeWebhookEvent("evt-plan-schedule-released-after-transition"),
        ),
      ).resolves.toMatchObject({ status: "processed" });
    });

    it("reconciles an owned downgrade cancellation without projecting or blocking a new request", async () => {
      await runDb(isolatedUrl(), seedBase);
      const cancellationCompanyId = crypto.randomUUID();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into client_companies (id, name, stripe_customer_id)
            values (${cancellationCompanyId}, 'Canceled schedule company', 'cus_schedule_cancel')
          `;
          yield* sql`
            insert into client_ai_billing_accounts (
              client_company_id, plan_tier, stripe_subscription_id, stripe_price_id,
              status, current_period_start, current_period_end
            ) values (
              ${cancellationCompanyId}, 'team', 'sub_schedule_cancel', 'price_team',
              'active', to_timestamp(1767225600), to_timestamp(1769904000)
            )
          `;
          yield* sql`
            insert into client_ai_plan_change_requests (
              client_company_id, idempotency_key, requested_by_user_id,
              authorization_request_id, authorization_session_id,
              previous_tier, target_tier, stripe_customer_id, stripe_subscription_id,
              previous_price_id, target_price_id, current_period_end,
              status, outcome, effective_at, external_operation_id
            ) values (
              ${cancellationCompanyId}, 'cancel-downgrade-0001', ${userId},
              '90000000-0000-4000-8000-000000000020', 'cancel-test-session',
              'team', 'light', 'cus_schedule_cancel', 'sub_schedule_cancel',
              'price_team', 'price_light', to_timestamp(1769904000),
              'succeeded', 'downgrade_scheduled', to_timestamp(1769904000),
              'sub_sched_cancel'
            )
          `;
        }),
      );
      const cancellationSchedule = (status: string) => ({
        id: "sub_sched_cancel",
        subscription: "sub_schedule_cancel",
        status,
        current_phase: { start_date: 1767225600, end_date: 1769904000 },
        end_behavior: "release",
        phases: [
          {
            start_date: 1767225600,
            end_date: 1769904000,
            items: [{ price: "price_team", quantity: 1 }],
            proration_behavior: "none",
            metadata: {
              brief_client_company_id: cancellationCompanyId,
              brief_plan_change_key: "cancel-downgrade-0001",
              brief_plan_previous_tier: "team",
              brief_plan_tier: "team",
            },
          },
          {
            start_date: 1769904000,
            items: [{ price: "price_light", quantity: 1 }],
            proration_behavior: "none",
            metadata: {
              brief_client_company_id: cancellationCompanyId,
              brief_plan_change_key: "cancel-downgrade-0001",
              brief_plan_previous_tier: "team",
              brief_plan_tier: "light",
            },
          },
        ],
        metadata: {
          brief_client_company_id: cancellationCompanyId,
          brief_plan_change_key: "cancel-downgrade-0001",
          brief_plan_tier: "light",
        },
      });
      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-schedule-cancel-active",
          "subscription_schedule.updated",
          cancellationSchedule("active"),
        ),
      );
      await runDb(isolatedUrl(), processStripeWebhookEvent("evt-schedule-cancel-active"));
      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-schedule-cancel-terminal",
          "subscription_schedule.canceled",
          cancellationSchedule("canceled"),
        ),
      );
      await expect(
        runDb(isolatedUrl(), processStripeWebhookEvent("evt-schedule-cancel-terminal")),
      ).resolves.toMatchObject({ status: "processed" });
      await expect(
        runDb(isolatedUrl(), processStripeWebhookEvent("evt-schedule-cancel-terminal")),
      ).resolves.toMatchObject({ status: "already_processed" });
      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-schedule-cancel-terminal-copy",
          "subscription_schedule.canceled",
          cancellationSchedule("canceled"),
        ),
      );
      await expect(
        runDb(isolatedUrl(), processStripeWebhookEvent("evt-schedule-cancel-terminal-copy")),
      ).resolves.toMatchObject({ status: "processed" });
      await runDb(
        isolatedUrl(),
        insertStripeEvent("evt-schedule-cancel-unowned-target", "customer.subscription.updated", {
          id: "sub_schedule_cancel",
          customer: "cus_schedule_cancel",
          status: "active",
          metadata: {
            brief_client_company_id: cancellationCompanyId,
            brief_plan_tier: "light",
          },
          items: {
            data: [
              {
                quantity: 1,
                current_period_start: 1769904000,
                current_period_end: 1772323200,
                price: { id: "price_light", metadata: { brief_plan_tier: "light" } },
              },
            ],
          },
        }),
      );
      await expect(
        runDb(isolatedUrl(), processStripeWebhookEvent("evt-schedule-cancel-unowned-target")),
      ).rejects.toBeDefined();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into client_ai_plan_change_requests (
              client_company_id, idempotency_key, requested_by_user_id,
              authorization_request_id, authorization_session_id,
              previous_tier, target_tier, stripe_customer_id, stripe_subscription_id,
              previous_price_id, target_price_id, current_period_end, status
            ) values (
              ${cancellationCompanyId}, 'new-downgrade-0002', ${userId},
              '90000000-0000-4000-8000-000000000021', 'cancel-test-session',
              'team', 'light', 'cus_schedule_cancel', 'sub_schedule_cancel',
              'price_team', 'price_light', to_timestamp(1769904000), 'processing'
            )
          `;
        }),
      );
      const state = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly tier: string;
            readonly pendingTier: string | null;
            readonly pendingScheduleId: string | null;
            readonly reconciliationAudits: number;
            readonly processingRequests: number;
          }>`
              select account.plan_tier as tier,
                     account.pending_downgrade_tier as "pendingTier",
                     account.pending_downgrade_schedule_id as "pendingScheduleId",
                     (select count(*)::int from platform_authorization_audit_log
                      where request_id = '90000000-0000-4000-8000-000000000020'
                        and action = 'client.billing.plan_change.schedule_canceled')
                       as "reconciliationAudits",
                     (select count(*)::int from client_ai_plan_change_requests
                      where client_company_id = ${cancellationCompanyId}
                        and status = 'processing') as "processingRequests"
              from client_ai_billing_accounts account
              where account.client_company_id = ${cancellationCompanyId}
            `)[0]!;
        }),
      );
      expect(state).toEqual({
        tier: "team",
        pendingTier: null,
        pendingScheduleId: null,
        reconciliationAudits: 1,
        processingRequests: 1,
      });
    });

    it("waits for the paid upgrade invoice before reconciling an uncertain API response", async () => {
      await runDb(isolatedUrl(), seedBase);
      const subscription = (tier: "team" | "intensive", planChange: boolean) => ({
        id: "sub_upgrade_recovery",
        customer: "cus_platform_test",
        status: "active",
        metadata: {
          brief_client_company_id: companyId,
          ...(planChange
            ? {
                brief_plan_change_key: "upgrade-recovery-0001",
                brief_plan_previous_tier: "team",
              }
            : {}),
          brief_plan_tier: tier,
        },
        items: {
          data: [
            {
              quantity: 1,
              current_period_start: 1767225600,
              current_period_end: 1769904000,
              price: { id: `price_${tier}`, metadata: { brief_plan_tier: tier } },
            },
          ],
        },
      });
      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-upgrade-subscription-initial",
          "customer.subscription.updated",
          subscription("team", false),
        ),
      );
      await runDb(isolatedUrl(), processStripeWebhookEvent("evt-upgrade-subscription-initial"));
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into client_ai_plan_change_requests (
              client_company_id, idempotency_key, requested_by_user_id,
              authorization_request_id, authorization_session_id,
              previous_tier, target_tier, stripe_customer_id, stripe_subscription_id,
              previous_price_id, target_price_id, current_period_end, status
            ) values (
              ${companyId}, 'upgrade-recovery-0001', ${userId},
              '90000000-0000-4000-8000-000000000014', 'upgrade-recovery-session',
              'team', 'intensive', 'cus_platform_test', 'sub_upgrade_recovery',
              'price_team', 'price_intensive', to_timestamp(1769904000), 'processing'
            )
          `;
          yield* sql`
            insert into client_credit_lots (
              client_company_id, kind, credits_granted, credits_remaining,
              available_at, expires_at, stripe_payment_id
            ) values (
              ${companyId}, 'additional', 55, 55, '2026-01-01', '2027-01-01',
              'payment:upgrade-recovery-additional'
            )
          `;
        }),
      );
      await runDb(
        isolatedUrl(),
        insertStripeEvent(
          "evt-upgrade-subscription-target",
          "customer.subscription.updated",
          subscription("intensive", true),
        ),
      );
      await runDb(isolatedUrl(), processStripeWebhookEvent("evt-upgrade-subscription-target"));
      const beforePayment = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ tier: string; priceId: string }>`
            select plan_tier as tier, stripe_price_id as "priceId"
            from client_ai_billing_accounts where client_company_id = ${companyId}
          `)[0]!;
        }),
      );
      expect(beforePayment).toEqual({ tier: "team", priceId: "price_team" });

      await runDb(
        isolatedUrl(),
        insertStripeEvent("evt-upgrade-invoice-paid", "invoice.paid", {
          id: "in_upgrade_recovery",
          customer: "cus_platform_test",
          status: "paid",
          paid: true,
          amount_paid: 1_500,
          billing_reason: "subscription_update",
          created: 1768000000,
          status_transitions: { paid_at: 1768000001 },
          parent: {
            subscription_details: {
              subscription: "sub_upgrade_recovery",
              metadata: {
                brief_client_company_id: companyId,
                brief_plan_change_key: "upgrade-recovery-0001",
                brief_plan_previous_tier: "team",
                brief_plan_tier: "intensive",
              },
            },
          },
          lines: {
            data: [
              {
                amount: -500,
                period: { start: 1768000000, end: 1769904000 },
                parent: {
                  subscription_item_details: {
                    proration: true,
                    subscription: "sub_upgrade_recovery",
                  },
                },
                pricing: { type: "price_details", price_details: { price: "price_team" } },
              },
              {
                amount: 2_000,
                period: { start: 1768000000, end: 1769904000 },
                parent: {
                  subscription_item_details: {
                    proration: true,
                    subscription: "sub_upgrade_recovery",
                  },
                },
                pricing: {
                  type: "price_details",
                  price_details: { price: "price_intensive" },
                },
              },
            ],
          },
        }),
      );
      await runDb(isolatedUrl(), processStripeWebhookEvent("evt-upgrade-invoice-paid"));
      const reconciled = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            tier: string;
            priceId: string;
            requestStatus: string;
            outcome: string;
            externalOperationId: string;
            additionalRemaining: number;
            succeededAudits: number;
          }>`
            select billing.plan_tier as tier, billing.stripe_price_id as "priceId",
                   request.status as "requestStatus", request.outcome,
                   request.external_operation_id as "externalOperationId",
                   (select credits_remaining::int from client_credit_lots
                    where stripe_payment_id = 'payment:upgrade-recovery-additional')
                     as "additionalRemaining",
                   (select count(*)::int from platform_authorization_audit_log
                    where request_id = '90000000-0000-4000-8000-000000000014'
                      and action = 'client.billing.plan_change.upgraded'
                      and outcome = 'succeeded') as "succeededAudits"
            from client_ai_billing_accounts billing
            join client_ai_plan_change_requests request
              on request.client_company_id = billing.client_company_id
             and request.idempotency_key = 'upgrade-recovery-0001'
            where billing.client_company_id = ${companyId}
          `)[0]!;
        }),
      );
      expect(reconciled).toEqual({
        tier: "intensive",
        priceId: "price_intensive",
        requestStatus: "succeeded",
        outcome: "upgraded",
        externalOperationId: "in_upgrade_recovery",
        additionalRemaining: 55,
        succeededAudits: 1,
      });
    });

    it("atomically consumes monthly before additional, rejects overdraw races, and enforces limits", async () => {
      const chatId = await runDb(isolatedUrl(), seedBase);
      const [runA, runB] = await runDb(
        isolatedUrl(),
        Effect.all([createTerminalRun(chatId, "A"), createTerminalRun(chatId, "B")]),
      );
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
          insert into client_ai_billing_accounts (
            client_company_id, plan_tier, status, current_period_start, current_period_end,
            company_monthly_limit
          ) values (${companyId}, 'team', 'active', '2026-01-01', '2026-02-01', 100)
        `;
          yield* sql`
          insert into client_employee_ai_limits (
            client_company_id, user_id, monthly_limit, updated_by_user_id
          ) values (${companyId}, ${userId}, 100, ${userId})
        `;
          yield* sql`
          insert into client_credit_lots (
            client_company_id, kind, credits_granted, credits_remaining,
            available_at, expires_at, stripe_payment_id
          ) values
            (${companyId}, 'monthly', 5, 5, '2026-01-01', '2026-02-01', 'monthly-test'),
            (${companyId}, 'additional', 10, 10, '2026-01-01', '2027-01-01', 'additional-test')
        `;
        }),
      );
      const spend = (runId: string, idempotencyKey: string) =>
        runDb(
          isolatedUrl(),
          consumeCredits({
            clientCompanyId: companyId,
            userId,
            aiRunId: runId,
            credits: 8,
            calculationVersion: "credits-v1",
            calculationInputs: { inputTokens: 10, outputTokens: 5 },
            idempotencyKey,
            now,
          }),
        );
      const settled = await Promise.allSettled([spend(runA, "usage-a"), spend(runB, "usage-b")]);
      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
      const successfulRun = settled[0]!.status === "fulfilled" ? runA : runB;
      const successfulKey = successfulRun === runA ? "usage-a" : "usage-b";
      await expect(spend(successfulRun, successfulKey)).resolves.toMatchObject({
        idempotent: true,
      });
      const ledger = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const lots = yield* sql<{ kind: string; remaining: number }>`
          select kind, credits_remaining::int as remaining
          from client_credit_lots order by kind desc
        `;
          const totals = (yield* sql<{ usages: number; allocations: number }>`
          select (select count(*)::int from client_credit_usage) usages,
                 (select coalesce(sum(credits), 0)::int from client_credit_usage_allocations) allocations
        `)[0]!;
          return { lots, totals };
        }),
      );
      expect(ledger).toEqual({
        lots: [
          { kind: "monthly", remaining: 0 },
          { kind: "additional", remaining: 7 },
        ],
        totals: { usages: 1, allocations: 8 },
      });
      const unusedRun = successfulRun === runA ? runB : runA;
      await expect(
        runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update client_credit_usage set ai_run_identity = ${unusedRun}
              where idempotency_key = ${successfulKey}
            `;
          }),
        ),
      ).rejects.toBeDefined();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`delete from ai_runs where id = ${successfulRun}`;
        }),
      );
      await expect(spend(successfulRun, successfulKey)).resolves.toMatchObject({
        idempotent: true,
      });
      await expect(spend(unusedRun, successfulKey)).rejects.toThrow("credit_idempotency_conflict");
      const retainedIdentity = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly liveRunId: string | null;
            readonly runIdentity: string;
          }>`
              select ai_run_id::text as "liveRunId",
                     ai_run_identity::text as "runIdentity"
              from client_credit_usage where idempotency_key = ${successfulKey}
            `)[0]!;
        }),
      );
      expect(retainedIdentity).toEqual({ liveRunId: null, runIdentity: successfulRun });

      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
          update client_employee_ai_limits set monthly_limit = 8
          where client_company_id = ${companyId} and user_id = ${userId}
        `;
        }),
      );
      await expect(
        runDb(
          isolatedUrl(),
          consumeCredits({
            clientCompanyId: companyId,
            userId,
            aiRunId: unusedRun,
            credits: 1,
            calculationVersion: "credits-v1",
            calculationInputs: {},
            idempotencyKey: "employee-limit",
            now,
          }),
        ),
      ).rejects.toThrow("employee_limit_reached");

      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
          update client_employee_ai_limits set monthly_limit = 100
          where client_company_id = ${companyId} and user_id = ${userId}
        `;
          yield* sql`
          update client_ai_billing_accounts set company_monthly_limit = 8
          where client_company_id = ${companyId}
        `;
        }),
      );
      await expect(
        runDb(
          isolatedUrl(),
          consumeCredits({
            clientCompanyId: companyId,
            userId,
            aiRunId: unusedRun,
            credits: 1,
            calculationVersion: "credits-v1",
            calculationInputs: {},
            idempotencyKey: "company-limit",
            now,
          }),
        ),
      ).rejects.toThrow("company_limit_reached");

      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
          update client_ai_billing_accounts set status = 'past_due', company_monthly_limit = 100
          where client_company_id = ${companyId}
        `;
        }),
      );
      await expect(
        runDb(
          isolatedUrl(),
          consumeCredits({
            clientCompanyId: companyId,
            userId,
            aiRunId: unusedRun,
            credits: 1,
            calculationVersion: "credits-v1",
            calculationInputs: {},
            idempotencyKey: "inactive-account",
            now,
          }),
        ),
      ).rejects.toThrow("billing_account_inactive");
    });

    it("notifies the initiating user and company admins exactly when a charge reaches a limit", async () => {
      const chatId = await runDb(isolatedUrl(), seedBase);
      const runId = await runDb(isolatedUrl(), createTerminalRun(chatId, "reach exact limit"));
      const otherAdminId = "usage-limit-admin";
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into platform_users (id, primary_email, display_name, clerk_user_id)
            values (
              ${otherAdminId}, 'usage-admin@example.test', 'Usage Admin',
              'clerk-usage-limit-admin'
            )
          `;
          yield* sql`
            insert into client_company_memberships (company_id, user_id, role)
            values (${companyId}, ${otherAdminId}, 'admin')
          `;
          yield* sql`
            insert into client_ai_billing_accounts (
              client_company_id, plan_tier, status, current_period_start, current_period_end,
              company_monthly_limit
            ) values (${companyId}, 'team', 'active', '2026-01-01', '2026-02-01', 5)
          `;
          yield* sql`
            insert into client_employee_ai_limits (
              client_company_id, user_id, monthly_limit, updated_by_user_id
            ) values (${companyId}, ${userId}, 5, ${userId})
          `;
          yield* sql`
            insert into client_credit_lots (
              client_company_id, kind, credits_granted, credits_remaining,
              available_at, expires_at, stripe_payment_id
            ) values (${companyId}, 'monthly', 5, 5, '2026-01-01', '2026-02-01',
              'monthly-limit-notification')
          `;
        }),
      );
      const spend = () =>
        runDb(
          isolatedUrl(),
          consumeCredits({
            clientCompanyId: companyId,
            userId,
            aiRunId: runId,
            credits: 5,
            calculationVersion: "credits-v1",
            calculationInputs: { exactLimit: true },
            idempotencyKey: "usage-limit-notification",
            now,
          }),
        );
      await expect(spend()).resolves.toMatchObject({ idempotent: false });
      await expect(spend()).resolves.toMatchObject({ idempotent: true });
      const state = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const notifications = yield* sql<{ readonly userId: string; readonly kind: string }>`
            select user_id as "userId", kind
            from platform_notifications
            order by user_id
          `;
          const counts = (yield* sql<{ readonly deliveries: number; readonly jobs: number }>`
              select
                (select count(*)::int from email_notification_deliveries) deliveries,
                (select count(*)::int from jobs
                  where kind = 'send_email_notification') jobs
            `)[0]!;
          return { notifications, counts };
        }),
      );
      expect(state).toEqual({
        notifications: [
          { userId, kind: "usage_limit_reached" },
          { userId: otherAdminId, kind: "usage_limit_reached" },
        ].sort((left, right) => left.userId.localeCompare(right.userId)),
        counts: { deliveries: 2, jobs: 2 },
      });
    });

    it("purges expired user recovery data, honors legal holds, and leaves a resurrection tombstone", async () => {
      const chatId = await runDb(isolatedUrl(), seedBase);
      const sharedChatId = crypto.randomUUID();
      const publisherCompanyId = crypto.randomUUID();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into chats (id, company_id, user_id, memory_mode, shared_at)
            values (${sharedChatId}, ${companyId}, ${userId}, 'disabled', now())
          `;
          yield* sql`
            insert into publisher_companies (id, name)
            values (${publisherCompanyId}, 'Deleting user publisher')
          `;
          yield* sql`
            insert into publisher_company_memberships (
              publisher_company_id, user_id, role, invited_email, accepted_at
            ) values (
              ${publisherCompanyId}, ${userId}, 'admin', 'original-private@example.test', now()
            )
          `;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const memoryId = crypto.randomUUID();
              const revisionId = crypto.randomUUID();
              yield* sql`
                insert into user_memories (
                  id, user_id, kind, content, head_revision_id, source_message_id
                ) values (
                  ${memoryId}, ${userId}, 'preference', 'private retained memory', ${revisionId}, null
                )
              `;
              yield* sql`
                insert into user_memory_revisions (
                  id, memory_id, action, state_before, state_after
                ) values (
                  ${revisionId}, ${memoryId}, 'create', null,
                  ${sql.json({ kind: "preference", content: "private retained memory", deleted: false })}
                )
              `;
            }),
          );
          yield* sql`
            update platform_users
            set recovery_deleted_at = now() - interval '181 days', purge_after = now() - interval '1 day'
            where id = ${userId}
          `;
          yield* sql`
            insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
            values ('user', ${userId}, 'litigation', 'legal-admin')
          `;
        }),
      );
      await expect(runDb(isolatedUrl(), purgeDeletedAccounts())).resolves.toMatchObject({
        purgedUsers: 0,
      });
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update legal_holds set released_at = now(), released_by_user_id = 'legal-admin'
            where scope_kind = 'user' and scope_id = ${userId}
          `;
        }),
      );
      const result = await runDb(isolatedUrl(), purgeDeletedAccounts());
      expect(result).toMatchObject({ purgedUsers: 1, purgedChats: 1 });
      const state = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            chats: number;
            memories: number;
            tombstones: number;
            sharedChats: number;
            clientMemberships: number;
            publisherMemberships: number;
            email: string;
            purged: boolean;
          }>`
            select
              (select count(*)::int from chats where id = ${chatId}) chats,
              (select count(*)::int from user_memories where user_id = ${userId}) memories,
              (select count(*)::int from identity_deletion_tombstones
                where platform_user_id = ${userId}) tombstones,
              (select count(*)::int from chats where id = ${sharedChatId}) as "sharedChats",
              (select count(*)::int from client_company_memberships
                where company_id = ${companyId} and user_id = ${userId}) as "clientMemberships",
              (select count(*)::int from publisher_company_memberships
                where publisher_company_id = ${publisherCompanyId}
                  and user_id = ${userId}) as "publisherMemberships",
              (select primary_email from platform_users where id = ${userId}) email,
              (select purged_at is not null from platform_users where id = ${userId}) purged
          `)[0]!;
        }),
      );
      expect(state).toEqual({
        chats: 0,
        memories: 0,
        tombstones: 1,
        sharedChats: 1,
        clientMemberships: 1,
        publisherMemberships: 0,
        email: `deleted+${userId}@deleted.invalid`,
        purged: true,
      });
      await expect(runDb(isolatedUrl(), purgeDeletedAccounts())).resolves.toMatchObject({
        purgedUsers: 0,
      });
    });

    it("holds the user-memory lane through account purge after complete memory projection", async () => {
      await runDb(isolatedUrl(), seedBase);
      const { deleteUserMemory, listUserMemories } = await loadMemoryDomain();
      const deletingUserId = `memory-account-purge-${crypto.randomUUID()}`;
      const memoryId = crypto.randomUUID();
      const revisionId = crypto.randomUUID();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                insert into platform_users (
                  id, primary_email, display_name, clerk_user_id,
                  recovery_deleted_at, purge_after
                ) values (
                  ${deletingUserId}, ${`${deletingUserId}@example.test`}, 'Memory purge target',
                  ${`clerk-${deletingUserId}`}, now() - interval '181 days', now() - interval '1 day'
                )
              `;
              yield* sql`
                insert into client_company_memberships (company_id, user_id, role)
                values (${companyId}, ${deletingUserId}, 'member')
              `;
              yield* sql`
                insert into user_memories (
                  id, user_id, kind, content, head_revision_id, source_message_id
                ) values (
                  ${memoryId}, ${deletingUserId}, 'preference', 'account purge memory',
                  ${revisionId}, null
                )
              `;
              yield* sql`
                insert into user_memory_revisions (
                  id, memory_id, action, state_before, state_after
                ) values (
                  ${revisionId}, ${memoryId}, 'create', null,
                  ${sql.json({
                    kind: "preference",
                    content: "account purge memory",
                    deleted: false,
                  })}
                )
              `;
            }),
          );
        }),
      );

      let signalMembershipHeld!: () => void;
      const membershipHeld = new Promise<void>((resolve) => {
        signalMembershipHeld = resolve;
      });
      let releaseMembership!: () => void;
      const membershipReleased = new Promise<void>((resolve) => {
        releaseMembership = resolve;
      });
      const membershipHolder = runDbAs(
        "brief-memory-account-membership-holder",
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                select pg_advisory_xact_lock(
                  hashtext(${`brief:client-members:${companyId}`})
                )
              `;
              yield* Effect.sync(signalMembershipHeld);
              yield* Effect.promise(() => membershipReleased);
            }),
          );
        }),
      );
      await membershipHeld;

      const revisionBlocker = holdMemoryRevisionTable("brief-memory-account-revision-blocker");
      await revisionBlocker.held;
      const reading = runDbAs("brief-memory-account-reader", listUserMemories(deletingUserId));
      await waitForDatabaseBlocker(
        "brief-memory-account-reader",
        "brief-memory-account-revision-blocker",
      );

      const purging = runDbAs("brief-memory-account-purger", purgeDeletedAccounts());
      await waitForDatabaseBlocker("brief-memory-account-purger", "brief-memory-account-reader");
      revisionBlocker.release();
      await revisionBlocker.done;
      const projection = await reading;

      // The purger was queued first on the memory lane. Once the reader
      // releases it, purge must retain that lane while waiting for the already
      // held membership lane; a later memory writer therefore remains blocked.
      const memoryProbe = runDbAs(
        "brief-memory-account-probe",
        deleteUserMemory(deletingUserId, memoryId),
      );
      await waitForDatabaseBlocker("brief-memory-account-probe", "brief-memory-account-purger");
      expect(projection.memories).toEqual([
        expect.objectContaining({
          id: memoryId,
          headRevisionId: revisionId,
          revisions: [expect.objectContaining({ id: revisionId })],
        }),
      ]);

      releaseMembership();
      await membershipHolder;
      await expect(purging).resolves.toMatchObject({ purgedUsers: 1 });
      await expect(memoryProbe).resolves.toEqual({
        status: "not_found",
      });
      const remaining = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ readonly count: number }>`
              select count(*)::int as count
              from user_memories where user_id = ${deletingUserId}
            `)[0]!.count;
        }),
      );
      expect(remaining).toBe(0);
    });

    it("locks memory provenance owners before chat GC clears source-message and run links", async () => {
      await runDb(isolatedUrl(), seedBase);
      const { deleteUserMemory } = await loadMemoryDomain();

      const runCase = async (provenance: "source_message" | "revision_run") => {
        const suffix = `${provenance}-${crypto.randomUUID()}`;
        const memoryUserId = `memory-chat-gc-${suffix}`;
        const chatId = crypto.randomUUID();
        const memoryId = crypto.randomUUID();
        const revisionId = crypto.randomUUID();
        await runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`
                  insert into platform_users (id, primary_email, display_name, clerk_user_id)
                  values (
                    ${memoryUserId}, ${`${memoryUserId}@example.test`}, 'Chat GC memory owner',
                    ${`clerk-${memoryUserId}`}
                  )
                `;
                yield* sql`
                  insert into chats (id, company_id, user_id, memory_mode)
                  values (${chatId}, ${companyId}, ${userId}, 'private_owner')
                `;
                const messages = yield* sql<{ readonly id: string }>`
                  insert into chat_messages (chat_id, author, content)
                  values (${chatId}, 'user', ${`Chat GC ${provenance}`})
                  returning id::text
                `;
                const runs = yield* sql<{ readonly id: string }>`
                  insert into ai_runs (
                    chat_id, initiating_user_id, user_message_id, locale, market, finished_at
                  ) values (
                    ${chatId}, ${userId}, ${messages[0]!.id}, 'en-US', 'US', now()
                  )
                  returning id::text
                `;
                yield* sql`
                  insert into user_memories (
                    id, user_id, kind, content, head_revision_id, source_message_id
                  ) values (
                    ${memoryId}, ${memoryUserId}, 'preference', ${`Chat GC ${provenance}`},
                    ${revisionId},
                    ${provenance === "source_message" ? messages[0]!.id : null}
                  )
                `;
                yield* sql`
                  insert into user_memory_revisions (
                    id, memory_id, action, state_before, state_after, run_id
                  ) values (
                    ${revisionId}, ${memoryId}, 'create', null,
                    ${sql.json({
                      kind: "preference",
                      content: `Chat GC ${provenance}`,
                      deleted: false,
                    })},
                    ${provenance === "revision_run" ? runs[0]!.id : null}
                  )
                `;
                yield* sql`
                  update chats
                  set deleted_at = now() - interval '31 days',
                      deleted_by_user_id = ${userId},
                      purge_after = now() - interval '1 day'
                  where id = ${chatId}
                `;
              }),
            );
          }),
        );

        const blockerName = `brief-chat-gc-${provenance}-row-blocker`;
        const mutationName = `brief-chat-gc-${provenance}-mutation`;
        const purgerName = `brief-chat-gc-${provenance}-purger`;
        const rowBlocker = holdMemoryRow(blockerName, memoryId);
        await rowBlocker.held;
        const mutation = runDbAs(mutationName, deleteUserMemory(memoryUserId, memoryId));
        await waitForDatabaseBlocker(mutationName, blockerName);

        const purging = runDbAs(purgerName, purgeDeletedChats());
        await waitForDatabaseBlocker(purgerName, mutationName);
        rowBlocker.release();
        await rowBlocker.done;

        await expect(mutation).resolves.toMatchObject({ status: "ok" });
        await expect(purging).resolves.toBe(1);

        const provenanceAfter = await runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return (yield* sql<{
              readonly sourceMessageId: string | null;
              readonly runId: string | null;
            }>`
                select memories.source_message_id::text as "sourceMessageId",
                       revisions.run_id::text as "runId"
                from user_memories memories
                join user_memory_revisions revisions on revisions.id = ${revisionId}
                where memories.id = ${memoryId}
              `)[0]!;
          }),
        );
        expect(provenanceAfter).toEqual({ sourceMessageId: null, runId: null });
      };

      await runCase("source_message");
      await runCase("revision_run");
    });

    it("orders shared-chat reads and user purge without a client-member deadlock", async () => {
      await runDb(isolatedUrl(), seedBase);
      const deletingUserId = `shared-reader-purge-${crypto.randomUUID()}`;
      const sharedChatId = crypto.randomUUID();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into platform_users (
              id, primary_email, display_name, clerk_user_id,
              recovery_deleted_at, purge_after
            ) values (
              ${deletingUserId}, ${`${deletingUserId}@example.test`}, 'Deleting shared reader',
              ${`clerk-${deletingUserId}`}, now() - interval '181 days', now() - interval '1 day'
            )
          `;
          yield* sql`
            insert into client_company_memberships (company_id, user_id, role)
            values (${companyId}, ${deletingUserId}, 'member')
          `;
          yield* sql`
            insert into chats (id, company_id, user_id, memory_mode, shared_at)
            values (${sharedChatId}, ${companyId}, ${userId}, 'disabled', now())
          `;
          yield* sql`
            insert into chat_messages (chat_id, author, content)
            values (${sharedChatId}, 'assistant', 'Shared content protected by lock ordering')
          `;
        }),
      );

      let signalExecutionHeld!: () => void;
      const executionHeld = new Promise<void>((resolve) => {
        signalExecutionHeld = resolve;
      });
      let releaseExecution!: () => void;
      const executionReleased = new Promise<void>((resolve) => {
        releaseExecution = resolve;
      });
      const executionHolder = runDbAs(
        "brief-account-purge-execution-holder",
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                select pg_advisory_xact_lock(hashtext(${`brief:ai-chat:${sharedChatId}`}))
              `;
              yield* Effect.sync(signalExecutionHeld);
              yield* Effect.promise(() => executionReleased);
            }),
          );
        }),
      );
      await executionHeld;

      const reading = runDbAs(
        "brief-account-purge-shared-reader",
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const [chat] = yield* sql<{ readonly companyId: string }>`
                select company_id::text as "companyId"
                from chats where id = ${sharedChatId}
                for share
              `;
              yield* sql`
                select pg_advisory_xact_lock(
                  hashtext(${`brief:client-members:${chat!.companyId}`})
                )
              `;
              yield* sql`
                select pg_advisory_xact_lock(hashtext(${`brief:ai-chat:${sharedChatId}`}))
              `;
              yield* sql`
                select id from platform_users where id = ${deletingUserId} for share
              `;
              yield* sql`
                select id from client_companies where id = ${companyId} for share
              `;
              return (yield* sql<{ readonly authorized: boolean }>`
                select exists (
                  select 1
                  from chats chat
                  join client_company_memberships membership
                    on membership.company_id = chat.company_id
                   and membership.user_id = ${deletingUserId}
                   and membership.revoked_at is null
                  join platform_users users
                    on users.id = membership.user_id
                   and users.recovery_deleted_at is null and users.purged_at is null
                  where chat.id = ${sharedChatId}
                    and chat.shared_at is not null and chat.memory_mode = 'disabled'
                ) as authorized
              `)[0]!.authorized;
            }),
          );
        }),
      );
      await waitForDatabaseLock("brief-account-purge-shared-reader");
      const purging = runDbAs("brief-account-purge-member-lane", purgeDeletedAccounts());
      await waitForDatabaseLock("brief-account-purge-member-lane");
      releaseExecution();

      await expect(reading).resolves.toBe(false);
      await executionHolder;
      await expect(purging).resolves.toMatchObject({ purgedUsers: 1 });
      const after = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly purged: boolean;
            readonly membershipCount: number;
            readonly sharedChatCount: number;
          }>`
            select
              (select purged_at is not null from platform_users
               where id = ${deletingUserId}) as purged,
              (select count(*)::int from client_company_memberships
               where user_id = ${deletingUserId}) as "membershipCount",
              (select count(*)::int from chats where id = ${sharedChatId}) as "sharedChatCount"
          `)[0]!;
        }),
      );
      expect(after).toEqual({ purged: true, membershipCount: 0, sharedChatCount: 1 });
    });

    it("purges an expired client company only after hold release and retains accounting for ten years", async () => {
      await runDb(isolatedUrl(), seedBase);
      const publisherCompanyId = crypto.randomUUID();
      const subscriptionId = crypto.randomUUID();
      const accessId = crypto.randomUUID();
      const issueId = crypto.randomUUID();
      const deliveryId = crypto.randomUUID();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into publisher_companies (id, name)
            values (${publisherCompanyId}, 'Retention publisher')
          `;
          yield* sql`
            insert into publisher_subscriptions (
              id, publisher_company_id, name, created_by_user_id
            ) values (${subscriptionId}, ${publisherCompanyId}, 'Retention source', ${userId})
          `;
          yield* sql`
            insert into client_subscription_accesses (
              id, subscription_id, client_company_id, state, first_admin_email,
              accepted_at, subscribed_at, created_by_user_id
            ) values (
              ${accessId}, ${subscriptionId}, ${companyId}, 'active', 'admin@example.test',
              now(), now(), ${userId}
            )
          `;
          yield* sql`
            insert into publisher_issues (
              id, subscription_id, title, status, publication_at, published_at,
              indexing_status, created_by_user_id
            ) values (
              ${issueId}, ${subscriptionId}, 'Delivered retention issue', 'published',
              now() - interval '1 day', now() - interval '1 day', 'ready', ${userId}
            )
          `;
          yield* sql`
            insert into issue_deliveries (
              id, issue_id, subscription_id, access_id, client_company_id, historical
            ) values (
              ${deliveryId}, ${issueId}, ${subscriptionId}, ${accessId}, ${companyId}, false
            )
          `;
          yield* sql`
            insert into client_ai_billing_accounts (
              client_company_id, plan_tier, status, current_period_start, current_period_end
            ) values (${companyId}, 'team', 'cancelled', '2026-01-01', '2026-02-01')
          `;
          yield* sql`
            update client_companies
            set recovery_deleted_at = now() - interval '181 days', purge_after = now() - interval '1 day'
            where id = ${companyId}
          `;
          yield* sql`
            insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
            values ('client_company', ${companyId}, 'litigation', 'legal-admin')
          `;
        }),
      );
      await expect(
        runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`delete from issue_deliveries where id = ${deliveryId}`;
          }),
        ),
      ).rejects.toBeDefined();
      await expect(runDb(isolatedUrl(), purgeDeletedAccounts())).resolves.toMatchObject({
        purgedCompanies: 0,
      });
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update legal_holds set released_at = now(), released_by_user_id = 'legal-admin'
            where scope_kind = 'client_company' and scope_id = ${companyId}
          `;
        }),
      );
      await expect(runDb(isolatedUrl(), purgeDeletedAccounts())).resolves.toMatchObject({
        purgedCompanies: 1,
      });
      const state = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            memberships: number;
            chats: number;
            billing: number;
            deliveries: number;
            accesses: number;
            tombstones: number;
            purged: boolean;
          }>`
            select
              (select count(*)::int from client_company_memberships where company_id = ${companyId}) memberships,
              (select count(*)::int from chats where company_id = ${companyId}) chats,
              (select count(*)::int from client_ai_billing_accounts where client_company_id = ${companyId}) billing,
              (select count(*)::int from issue_deliveries where client_company_id = ${companyId}) deliveries,
              (select count(*)::int from client_subscription_accesses where client_company_id = ${companyId}) accesses,
              (select count(*)::int from client_company_deletion_tombstones
                where client_company_id = ${companyId}) tombstones,
              (select purged_at is not null from client_companies where id = ${companyId}) purged
          `)[0]!;
        }),
      );
      expect(state).toEqual({
        memberships: 0,
        chats: 0,
        billing: 1,
        deliveries: 0,
        accesses: 0,
        tombstones: 1,
        purged: true,
      });
      await expect(
        runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`delete from client_ai_billing_accounts where client_company_id = ${companyId}`;
          }),
        ),
      ).rejects.toThrow();
    });

    it("purges terminal billing state after ten years, honors holds, and keeps active accounts", async () => {
      await runDb(isolatedUrl(), seedBase);
      const activeCompanyId = crypto.randomUUID();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into client_companies (id, name)
            values (${activeCompanyId}, 'Active retained billing company')
          `;
          yield* sql`
            insert into client_ai_billing_accounts (
              client_company_id, plan_tier, status, current_period_start, current_period_end
            ) values
              (${companyId}, 'team', 'cancelled', '2026-01-01', '2026-02-01'),
              (${activeCompanyId}, 'team', 'active', '2026-01-01', '2026-02-01')
          `;
          yield* sql`
            insert into client_ai_plan_change_requests (
              client_company_id, idempotency_key, requested_by_user_id,
              authorization_request_id, authorization_session_id,
              previous_tier, target_tier, status, outcome
            ) values (
              ${companyId}, 'retention-unchanged-plan', ${userId},
              '92000000-0000-4000-8000-000000000001', 'retention-session',
              'team', 'team', 'succeeded', 'unchanged'
            )
          `;
          yield* sql.unsafe(
            "alter table client_ai_billing_accounts disable trigger client_ai_billing_accounts_retention",
          );
          yield* sql.unsafe(
            "alter table client_ai_plan_change_requests disable trigger client_ai_plan_change_requests_retention",
          );
          yield* sql.unsafe(
            "alter table client_ai_plan_change_requests disable trigger client_ai_plan_change_requests_identity_immutable",
          );
          yield* sql`
            update client_ai_billing_accounts set retained_until = now() - interval '1 second'
            where client_company_id in (${companyId}, ${activeCompanyId})
          `;
          yield* sql`
            update client_ai_plan_change_requests set retained_until = now() - interval '1 second'
            where client_company_id = ${companyId}
          `;
          yield* sql.unsafe(
            "alter table client_ai_billing_accounts enable trigger client_ai_billing_accounts_retention",
          );
          yield* sql.unsafe(
            "alter table client_ai_plan_change_requests enable trigger client_ai_plan_change_requests_retention",
          );
          yield* sql.unsafe(
            "alter table client_ai_plan_change_requests enable trigger client_ai_plan_change_requests_identity_immutable",
          );
          yield* sql`update client_companies set legal_hold = true where id = ${companyId}`;
        }),
      );
      await expect(runDb(isolatedUrl(), purgeDeletedAccounts())).resolves.toMatchObject({
        accounting: { billingAccounts: 0, planChangeRequests: 0 },
      });
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`update client_companies set legal_hold = false where id = ${companyId}`;
        }),
      );
      await expect(runDb(isolatedUrl(), purgeDeletedAccounts())).resolves.toMatchObject({
        accounting: { billingAccounts: 1, planChangeRequests: 1 },
      });
      const state = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly canceledAccounts: number;
            readonly activeAccounts: number;
            readonly planChanges: number;
          }>`
              select
                (select count(*)::int from client_ai_billing_accounts
                  where client_company_id = ${companyId}) as "canceledAccounts",
                (select count(*)::int from client_ai_billing_accounts
                  where client_company_id = ${activeCompanyId}) as "activeAccounts",
                (select count(*)::int from client_ai_plan_change_requests
                  where client_company_id = ${companyId}) as "planChanges"
            `)[0]!;
        }),
      );
      expect(state).toEqual({ canceledAccounts: 0, activeAccounts: 1, planChanges: 0 });
    });

    it("rejects malformed direct ledger writes and serializes concurrent allocation transactions", async () => {
      const chatId = await runDb(isolatedUrl(), seedBase);
      const [runA, runB, runC] = await runDb(
        isolatedUrl(),
        Effect.all([
          createTerminalRun(chatId, "direct A"),
          createTerminalRun(chatId, "direct B"),
          createTerminalRun(chatId, "direct C"),
        ]),
      );
      const lotId = crypto.randomUUID();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
          insert into client_credit_lots (
            id, client_company_id, kind, credits_granted, credits_remaining,
            available_at, expires_at, stripe_payment_id
          ) values (
            ${lotId}, ${companyId}, 'monthly', 10, 10,
            '2026-01-01', '2026-02-01', 'direct-lot'
          )
        `;
        }),
      );

      await expect(
        runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
            insert into client_credit_usage (
              client_company_id, user_id, ai_run_id, credits,
              calculation_version, calculation_inputs, idempotency_key, created_at
            ) values (
              ${companyId}, ${userId}, ${runC}, 1,
              'credits-v1', '{}'::jsonb, 'direct-unallocated', ${now}
            )
          `;
          }),
        ),
      ).rejects.toBeDefined();

      await expect(
        runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`
                update client_credit_lots set credits_remaining = 4 where id = ${lotId}
              `;
                const usages = yield* sql<{ id: string }>`
                insert into client_credit_usage (
                  client_company_id, user_id, ai_run_id, credits,
                  calculation_version, calculation_inputs, idempotency_key, created_at
                ) values (
                  ${companyId}, ${userId}, ${runC}, 5,
                  'credits-v1', '{}'::jsonb, 'direct-over-usage', ${now}
                ) returning id::text
              `;
                yield* sql`
                insert into client_credit_usage_allocations (
                  usage_id, credit_lot_id, client_company_id, credits
                ) values (${usages[0]!.id}, ${lotId}, ${companyId}, 6)
              `;
              }),
            );
          }),
        ),
      ).rejects.toBeDefined();

      const otherCompanyId = crypto.randomUUID();
      const otherLotId = crypto.randomUUID();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`insert into client_companies (id, name) values (${otherCompanyId}, 'Other')`;
          yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values (${otherCompanyId}, ${userId}, 'admin')
        `;
          yield* sql`
          insert into client_company_ai_settings (company_id) values (${otherCompanyId})
        `;
          yield* sql`
          insert into client_credit_lots (
            id, client_company_id, kind, credits_granted, credits_remaining,
            available_at, expires_at, stripe_payment_id
          ) values (
            ${otherLotId}, ${otherCompanyId}, 'monthly', 1, 1,
            '2026-01-01', '2026-02-01', 'other-lot'
          )
        `;
        }),
      );
      await expect(
        runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`
                update client_credit_lots set credits_remaining = 0 where id = ${otherLotId}
              `;
                const usages = yield* sql<{ id: string }>`
                insert into client_credit_usage (
                  client_company_id, user_id, ai_run_id, credits,
                  calculation_version, calculation_inputs, idempotency_key, created_at
                ) values (
                  ${companyId}, ${userId}, ${runC}, 1,
                  'credits-v1', '{}'::jsonb, 'direct-cross-company', ${now}
                ) returning id::text
              `;
                yield* sql`
                insert into client_credit_usage_allocations (
                  usage_id, credit_lot_id, client_company_id, credits
                ) values (${usages[0]!.id}, ${otherLotId}, ${companyId}, 1)
              `;
              }),
            );
          }),
        ),
      ).rejects.toThrow();

      const directSpend = (runId: string, key: string) =>
        runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`
                update client_credit_lots set credits_remaining = 2 where id = ${lotId}
              `;
                const usages = yield* sql<{ id: string }>`
                insert into client_credit_usage (
                  client_company_id, user_id, ai_run_id, credits,
                  calculation_version, calculation_inputs, idempotency_key, created_at
                ) values (
                  ${companyId}, ${userId}, ${runId}, 8,
                  'credits-v1', '{}'::jsonb, ${key}, ${now}
                ) returning id::text
              `;
                yield* sql`
                insert into client_credit_usage_allocations (
                  usage_id, credit_lot_id, client_company_id, credits
                ) values (${usages[0]!.id}, ${lotId}, ${companyId}, 8)
              `;
              }),
            );
          }),
        );
      const concurrent = await Promise.allSettled([
        directSpend(runA, "direct-concurrent-a"),
        directSpend(runB, "direct-concurrent-b"),
      ]);
      expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
      const final = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ usages: number; allocated: number; remaining: number }>`
          select (select count(*)::int from client_credit_usage) usages,
                 (select coalesce(sum(credits), 0)::int from client_credit_usage_allocations) allocated,
                 (select credits_remaining::int from client_credit_lots where id = ${lotId}) remaining
        `)[0]!;
        }),
      );
      expect(final).toEqual({ usages: 1, allocated: 8, remaining: 2 });
    });

    it("excludes deleted issues/documents and security-restricted issues from a snapshotted export", async () => {
      const chatId = await runDb(isolatedUrl(), seedBase);
      const delivered = await runDb(isolatedUrl(), seedDeliveredIssue);
      const deletedIssueId = crypto.randomUUID();
      const restrictedIssueId = crypto.randomUUID();
      const deletedDocumentId = crypto.randomUUID();
      const restrictedDocumentId = crypto.randomUUID();
      const restrictedVersionId = crypto.randomUUID();
      const exportId = crypto.randomUUID();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const subscription = (yield* sql<{
            readonly id: string;
            readonly publisherCompanyId: string;
          }>`
              select issues.subscription_id::text as id,
                     subscriptions.publisher_company_id::text as "publisherCompanyId"
              from publisher_issues issues
              join publisher_subscriptions subscriptions
                on subscriptions.id = issues.subscription_id
              where issues.id = ${delivered.issueId}
            `)[0]!;
          yield* sql`
            insert into publisher_issues (
              id, subscription_id, title, status, created_by_user_id
            ) values
              (
                ${deletedIssueId}, ${subscription.id}, 'Issue with deleted document',
                'draft', ${userId}
              ),
              (
                ${restrictedIssueId}, ${subscription.id}, 'Security restricted issue',
                'draft', ${userId}
              )
          `;
          yield* sql`
            insert into brief_documents (
              id, issue_id, title, original_file_name, object_key, media_type,
              byte_size, sha256_hex, upload_completed_at, deleted_at,
              deleted_by_user_id, purge_after, created_by_user_id
            ) values
              (
                ${deletedDocumentId}, ${deletedIssueId}, 'Deleted export document',
                'deleted.pdf', 'exports-fixture/deleted.pdf', 'application/pdf',
                4, ${"a".repeat(64)}, now(), now(), ${userId},
                now() + interval '30 days', ${userId}
              ),
              (
                ${restrictedDocumentId}, ${restrictedIssueId}, 'Restricted export document',
                'restricted.pdf', 'exports-fixture/restricted.pdf', 'application/pdf',
                4, ${"b".repeat(64)}, now(), null, null, null, ${userId}
              )
          `;
          const restrictedText = "Restricted export text";
          yield* sql`
            insert into brief_document_versions (
              id, brief_document_id, content_hash, language, canonical_text,
              text_char_count, page_ranges
            ) values (
              ${restrictedVersionId}, ${restrictedDocumentId}, ${"d".repeat(64)},
              'fr-FR', ${restrictedText}, ${restrictedText.length},
              ${JSON.stringify([
                { pageNumber: 1, charStart: 0, charEnd: restrictedText.length },
              ])}::jsonb
            )
          `;
          yield* sql`
            update brief_documents set current_version_id = ${restrictedVersionId}
            where id = ${restrictedDocumentId}
          `;
          yield* sql`
            update publisher_issues
            set status = 'published', publication_at = now(), published_at = now()
            where id = ${restrictedIssueId}
          `;
          yield* sql`
            update publisher_issues
            set restricted_at = now(), restricted_by_user_id = 'security-admin',
                restricted_reason = 'security incident'
            where id = ${restrictedIssueId}
          `;
          yield* sql`
            update publisher_issues
            set deleted_at = now(), deleted_by_user_id = ${userId},
                purge_after = now() + interval '30 days'
            where id = ${deletedIssueId}
          `;
          const assistantMessageId = crypto.randomUUID();
          yield* sql`
            insert into chat_messages (id, chat_id, author, content)
            values (${assistantMessageId}, ${chatId}, 'assistant', 'Historical answer.')
          `;
          yield* sql`
            insert into assistant_message_sources (
              assistant_message_id, source_key, kind, locator,
              document_version_id, publisher_document_version_id,
              display_label, public_provenance
            ) values (
              ${assistantMessageId}, 'S1', 'document',
              ${sql.json({
                kind: "document",
                documentVersionId: restrictedVersionId,
                contentHash: "d".repeat(64),
                ranges: [{ pageNumber: 1, charStart: 0, charEnd: restrictedText.length }],
              })},
              ${restrictedVersionId}, ${restrictedVersionId},
              'Restricted citation label',
              ${sql.json({
                citationUrl: `/v1/issues/${restrictedIssueId}/documents/${restrictedDocumentId}/content`,
                documentTitle: "Restricted export document",
                issueTitle: "Security restricted issue",
              })}
            )
          `;
          yield* sql`
            insert into export_requests (
              id, requester_user_id, scope_kind, scope_id,
              authorization_snapshot, idempotency_key
            ) values (
              ${exportId}, ${userId}, 'publisher_company', ${subscription.publisherCompanyId},
              ${sql.json({
                version: 1,
                authorizedAt: now.toISOString(),
                requesterUserId: userId,
                scopeKind: "publisher_company",
                scopeId: subscription.publisherCompanyId,
                role: "admin",
                clientCompanyIds: [],
                accessIds: [],
                issueIds: [deletedIssueId, restrictedIssueId],
                documentIds: [deletedDocumentId, restrictedDocumentId],
                chatIds: [chatId],
                chatMessageIds: [assistantMessageId],
              })},
              'export-security-exclusions'
            )
          `;
        }),
      );
      let getCalls = 0;
      let archive: Uint8Array | undefined;
      const store: ExportObjectStore = {
        verifyPhysicalDeletionSafety: async () => undefined,
        get: async () => {
          getCalls += 1;
          throw new Error("excluded object must not be read");
        },
        head: async () => null,
        delete: async () => undefined,
        put: async (input) => {
          archive = input.body;
        },
      };
      await expect(
        runDb(
          isolatedUrl(),
          generateExport({
            exportRequestId: exportId,
            store,
            publisherStore: publisherStoreFrom(store),
            expiresInMs: SERVER_NUMERIC_SETTING_HARD_MAXIMA.EXPORT_DOWNLOAD_TTL_MS + 1,
          }),
        ),
      ).rejects.toThrow("export_expiry_invalid");
      await expect(
        runDb(
          isolatedUrl(),
          generateExport({
            exportRequestId: exportId,
            store,
            publisherStore: publisherStoreFrom(store),
          }),
        ),
      ).resolves.toMatchObject({ status: "completed" });
      expect(getCalls).toBe(0);
      const archiveText = new TextDecoder().decode(archive);
      expect(archiveText).toContain('"documentCount": 0');
      expect(archiveText).toContain('"issueCount": 0');
      expect(archiveText).toContain('"chatSourceCount": 0');
      expect(archiveText).not.toContain("Issue with deleted document");
      expect(archiveText).not.toContain("Security restricted issue");
      expect(archiveText).not.toContain("Deleted export document");
      expect(archiveText).not.toContain("Restricted export document");
      expect(archiveText).not.toContain("Restricted citation label");
    });

    it("exports issue pull totals independently from document pull totals", async () => {
      const chatId = await runDb(isolatedUrl(), seedBase);
      const delivered = await runDb(isolatedUrl(), seedDeliveredIssue);
      const runOne = await runDb(isolatedUrl(), createTerminalRun(chatId, "Issue pull one"));
      const runTwo = await runDb(isolatedUrl(), createTerminalRun(chatId, "Issue pull two"));
      const exportId = crypto.randomUUID();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const publisher = (yield* sql<{ readonly publisherCompanyId: string }>`
            select subscriptions.publisher_company_id::text as "publisherCompanyId"
            from publisher_issues issues
            join publisher_subscriptions subscriptions
              on subscriptions.id = issues.subscription_id
            where issues.id = ${delivered.issueId}
          `)[0]!;
          yield* sql`
            insert into ai_source_exposures (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              source_kind, logical_source_identity, publisher_issue_id,
              content_item_identity, exposure_stage, visible_token_count
            ) values
              (
                ${runOne}, 'publisher-metric', 0, 0, 0, 'document',
                'document:one', ${delivered.issueId}, 'version:one', 'answer', 10
              ),
              (
                ${runOne}, 'publisher-metric', 0, 0, 0, 'document',
                'document:two', ${delivered.issueId}, 'version:two', 'answer', 12
              ),
              (
                ${runTwo}, 'publisher-metric', 0, 0, 0, 'document',
                'document:three', ${delivered.issueId}, 'version:three', 'answer', 14
              )
          `;
          yield* sql`
            insert into export_requests (
              id, requester_user_id, scope_kind, scope_id,
              authorization_snapshot, idempotency_key
            ) values (
              ${exportId}, ${userId}, 'publisher_company', ${publisher.publisherCompanyId},
              ${sql.json({
                version: 1,
                authorizedAt: now.toISOString(),
                requesterUserId: userId,
                scopeKind: "publisher_company",
                scopeId: publisher.publisherCompanyId,
                role: "admin",
                clientCompanyIds: [],
                accessIds: [],
                issueIds: [delivered.issueId],
                documentIds: [],
                chatIds: [],
                chatMessageIds: [],
              })},
              'publisher-pull-count-export'
            )
          `;
        }),
      );
      let archive: Uint8Array | undefined;
      const store: ExportObjectStore = {
        verifyPhysicalDeletionSafety: async () => undefined,
        get: async () => {
          throw new Error("document object should not be fetched");
        },
        head: async () => null,
        delete: async () => undefined,
        put: async (input) => {
          archive = input.body;
        },
      };
      await expect(
        runDb(
          isolatedUrl(),
          generateExport({
            exportRequestId: exportId,
            store,
            publisherStore: publisherStoreFrom(store),
          }),
        ),
      ).resolves.toMatchObject({ status: "completed" });
      const archiveText = new TextDecoder().decode(archive);
      expect(archiveText).toMatch(
        new RegExp(
          `"issues"\\s*:\\s*\\[\\s*\\{\\s*"issueId"\\s*:\\s*"${delivered.issueId}"\\s*,\\s*"pullCount"\\s*:\\s*2`,
          "u",
        ),
      );
      expect(archiveText).toMatch(/"documents"\s*:\s*\[\s*\]/u);
    });

    it("reads publisher documents only from publisher storage and writes archives only to export storage", async () => {
      await runDb(isolatedUrl(), seedBase);
      const delivered = await runDb(isolatedUrl(), seedDeliveredIssue);
      const exportId = crypto.randomUUID();
      const issueId = crypto.randomUUID();
      const documentId = crypto.randomUUID();
      const documentKey = `publisher-issues/${issueId}/documents/${documentId}.pdf`;
      const documentBytes = new TextEncoder().encode("%PDF-1.4\ndedicated publisher bucket");
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", Uint8Array.from(documentBytes).buffer),
      );
      const documentSha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const publisher = (yield* sql<{
            readonly publisherCompanyId: string;
            readonly subscriptionId: string;
          }>`
            select subscriptions.publisher_company_id::text as "publisherCompanyId",
                   subscriptions.id::text as "subscriptionId"
            from publisher_issues issues
            join publisher_subscriptions subscriptions
              on subscriptions.id = issues.subscription_id
            where issues.id = ${delivered.issueId}
          `)[0]!;
          yield* sql`
            insert into publisher_issues (
              id, subscription_id, title, status, created_by_user_id
            ) values (
              ${issueId}, ${publisher.subscriptionId}, 'Dedicated bucket issue',
              'draft', ${userId}
            )
          `;
          yield* sql`
            insert into brief_documents (
              id, issue_id, title, original_file_name, object_key, media_type,
              byte_size, sha256_hex, upload_completed_at, created_by_user_id
            ) values (
              ${documentId}, ${issueId}, 'Dedicated bucket document',
              'dedicated.pdf', ${documentKey}, 'application/pdf',
              ${documentBytes.byteLength}, ${documentSha256}, now(), ${userId}
            )
          `;
          yield* sql`
            insert into export_requests (
              id, requester_user_id, scope_kind, scope_id,
              authorization_snapshot, idempotency_key
            ) values (
              ${exportId}, ${userId}, 'publisher_company', ${publisher.publisherCompanyId},
              ${sql.json({
                version: 1,
                authorizedAt: new Date().toISOString(),
                requesterUserId: userId,
                scopeKind: "publisher_company",
                scopeId: publisher.publisherCompanyId,
                role: "admin",
                clientCompanyIds: [],
                accessIds: [],
                issueIds: [issueId],
                documentIds: [documentId],
                chatIds: [],
                chatMessageIds: [],
              })},
              'dedicated-export-storage-boundary'
            )
          `;
        }),
      );
      let archive: Uint8Array | undefined;
      let exportReads = 0;
      const store: ExportObjectStore = {
        verifyPhysicalDeletionSafety: async () => undefined,
        get: async () => {
          exportReads += 1;
          throw new Error("export bucket must not serve publisher input");
        },
        head: async () => null,
        delete: async () => undefined,
        put: async (input) => {
          archive = input.body;
        },
      };
      const publisherReads: string[] = [];
      const publisherStore: PlatformFileStoreShape = {
        get: (objectKey) => {
          publisherReads.push(objectKey);
          return objectKey === documentKey
            ? Effect.succeed(documentBytes)
            : Effect.fail(new Error("unexpected publisher key"));
        },
        delete: () => Effect.void,
      };
      await expect(
        runDb(isolatedUrl(), generateExport({ exportRequestId: exportId, store, publisherStore })),
      ).resolves.toMatchObject({ status: "completed" });
      expect(exportReads).toBe(0);
      expect(publisherReads).toEqual([documentKey]);
      expect(new TextDecoder().decode(archive!)).toContain("dedicated publisher bucket");
    });

    it("fences an interrupted writer, retries on a new key, and never certifies a late writer deleted", async () => {
      const chatId = await runDb(isolatedUrl(), seedBase);
      const exportId = crypto.randomUUID();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into export_requests (
              id, requester_user_id, scope_kind, scope_id,
              authorization_snapshot, idempotency_key
            ) values (
              ${exportId}, ${userId}, 'user_chats', 'me',
              ${sql.json({
                version: 1,
                authorizedAt: new Date().toISOString(),
                requesterUserId: userId,
                scopeKind: "user_chats",
                scopeId: "me",
                role: "self",
                clientCompanyIds: [companyId],
                accessIds: [],
                issueIds: [],
                documentIds: [],
                chatIds: [chatId],
                chatMessageIds: [],
              })},
              'export-interrupted-writer'
            )
          `;
        }),
      );

      const objects = new Map<string, Uint8Array>();
      const deletedKeys: string[] = [];
      let writeAttempt = 0;
      let markFirstWriteStarted!: () => void;
      const firstWriteStarted = new Promise<void>((resolve) => {
        markFirstWriteStarted = resolve;
      });
      let firstSignal: AbortSignal | undefined;
      let completeLateWrite!: () => void;
      const store: ExportObjectStore = {
        verifyPhysicalDeletionSafety: async () => undefined,
        get: async () => new Uint8Array(),
        head: async (objectKey) =>
          objects.has(objectKey)
            ? { byteSize: objects.get(objectKey)!.byteLength, sha256Hex: null, generation: null }
            : null,
        delete: async (objectKey) => {
          deletedKeys.push(objectKey);
          objects.delete(objectKey);
        },
        put: async (input, { signal }) => {
          writeAttempt += 1;
          if (writeAttempt > 1) {
            objects.set(input.objectKey, input.body);
            return;
          }
          firstSignal = signal;
          completeLateWrite = () => objects.set(input.objectKey, input.body);
          markFirstWriteStarted();
          await new Promise<void>((_resolve, reject) => {
            const aborted = () => reject(new DOMException("Aborted", "AbortError"));
            if (signal.aborted) aborted();
            else signal.addEventListener("abort", aborted, { once: true });
          });
        },
      };

      const firstFiber = Effect.runFork(
        generateExport({
          exportRequestId: exportId,
          store,
          publisherStore: publisherStoreFrom(store),
        }).pipe(
          Effect.provide(
            PgClient.layer({
              url: Redacted.make(isolatedUrl()),
              applicationName: "brief-export-interrupted-writer",
            }),
          ),
        ),
      );
      await firstWriteStarted;
      await Effect.runPromise(Fiber.interrupt(firstFiber));
      expect(firstSignal?.aborted).toBe(true);

      const interrupted = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly writerState: string;
            readonly objectKey: string;
            readonly deletedAt: Date | null;
          }>`
            select writer_state as "writerState", object_key as "objectKey",
                   deleted_at as "deletedAt"
            from export_object_generations
            where export_request_id = ${exportId} and generation = 1
          `)[0]!;
        }),
      );
      expect(interrupted).toMatchObject({
        writerState: "unknown",
        objectKey: `exports/${exportId}/attempt-1.tar`,
        deletedAt: null,
      });

      // A completed delete+HEAD probe fences the unknown writer and schedules
      // its exact five-minute reprobe before a generator retry advances.
      await expect(runDb(isolatedUrl(), purgeExpiredExportObjects(store))).resolves.toBe(0);
      expect(deletedKeys).toEqual([`exports/${exportId}/attempt-1.tar`]);
      const fencedProbe = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly attempts: number;
            readonly nextDeleteAttemptAt: Date;
          }>`
            select delete_attempts as attempts,
                   next_delete_attempt_at as "nextDeleteAttemptAt"
            from export_object_generations
            where export_request_id = ${exportId} and generation = 1
          `)[0]!;
        }),
      );
      expect(fencedProbe.attempts).toBe(1);

      await expect(
        runDb(
          isolatedUrl(),
          generateExport({
            exportRequestId: exportId,
            store,
            publisherStore: publisherStoreFrom(store),
          }),
        ),
      ).resolves.toMatchObject({
        status: "completed",
        objectKey: `exports/${exportId}/attempt-2.tar`,
      });
      expect(objects.has(`exports/${exportId}/attempt-2.tar`)).toBe(true);
      const afterRetryProbe = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly attempts: number;
            readonly nextDeleteAttemptAt: Date;
          }>`
            select delete_attempts as attempts,
                   next_delete_attempt_at as "nextDeleteAttemptAt"
            from export_object_generations
            where export_request_id = ${exportId} and generation = 1
          `)[0]!;
        }),
      );
      expect(afterRetryProbe).toEqual(fencedProbe);

      await expect(runDb(isolatedUrl(), purgeExpiredExportObjects(store))).resolves.toBe(0);
      expect(deletedKeys).toEqual([`exports/${exportId}/attempt-1.tar`]);
      completeLateWrite();
      expect(objects.has(`exports/${exportId}/attempt-1.tar`)).toBe(true);
      await expect(
        runDb(
          isolatedUrl(),
          purgeExpiredExportObjects(store, new Date(Date.now() + 10 * 60 * 1_000)),
        ),
      ).resolves.toBe(0);
      expect(deletedKeys).toEqual([
        `exports/${exportId}/attempt-1.tar`,
        `exports/${exportId}/attempt-1.tar`,
      ]);
      expect(objects.has(`exports/${exportId}/attempt-1.tar`)).toBe(false);
      expect(objects.has(`exports/${exportId}/attempt-2.tar`)).toBe(true);

      const finalState = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly requestObjectKey: string;
            readonly oldWriterState: string;
            readonly oldDeleteFenced: boolean;
            readonly oldDeletedAt: Date | null;
            readonly oldDeleteAttempts: number;
            readonly oldNextDeleteAttemptAt: Date;
          }>`
            select request.object_key as "requestObjectKey",
                   old.writer_state as "oldWriterState",
                   old.delete_fenced_at is not null as "oldDeleteFenced",
                   old.deleted_at as "oldDeletedAt",
                   old.delete_attempts as "oldDeleteAttempts",
                   old.next_delete_attempt_at as "oldNextDeleteAttemptAt"
            from export_requests request
            join export_object_generations old
              on old.export_request_id = request.id and old.generation = 1
            where request.id = ${exportId}
          `)[0]!;
        }),
      );
      expect(finalState).toEqual({
        requestObjectKey: `exports/${exportId}/attempt-2.tar`,
        oldWriterState: "unknown",
        oldDeleteFenced: true,
        oldDeletedAt: null,
        oldDeleteAttempts: 2,
        oldNextDeleteAttemptAt: expect.any(Date),
      });
      expect(finalState.oldNextDeleteAttemptAt.getTime()).toBeGreaterThanOrEqual(
        fencedProbe.nextDeleteAttemptAt.getTime(),
      );
    });

    it("preserves a fenced unknown reprobe schedule through terminal export failure", async () => {
      const chatId = await runDb(isolatedUrl(), seedBase);
      const exportId = crypto.randomUUID();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into export_requests (
              id, requester_user_id, scope_kind, scope_id,
              authorization_snapshot, idempotency_key
            ) values (
              ${exportId}, ${userId}, 'user_chats', 'me',
              ${sql.json({
                version: 1,
                authorizedAt: new Date().toISOString(),
                requesterUserId: userId,
                scopeKind: "user_chats",
                scopeId: "me",
                role: "self",
                clientCompanyIds: [companyId],
                accessIds: [],
                issueIds: [],
                documentIds: [],
                chatIds: [chatId],
                chatMessageIds: [],
              })},
              'export-fenced-unknown-final-failure'
            )
          `;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                insert into export_object_generations (
                  export_request_id, generation, object_key, purge_after,
                  next_delete_attempt_at
                ) values (
                  ${exportId}, 1, ${`exports/${exportId}/attempt-1.tar`},
                  now() + interval '1 hour', now() + interval '1 hour'
                )
              `;
              yield* sql`
                update export_requests set status = 'running', object_generation = 1
                where id = ${exportId}
              `;
            }),
          );
          yield* sql`
            update export_object_generations
            set writer_state = 'in_flight', expected_sha256 = ${"a".repeat(64)},
                byte_size = 1, writer_started_at = now()
            where export_request_id = ${exportId} and generation = 1
          `;
          yield* sql`
            update export_object_generations
            set writer_state = 'unknown', purge_after = now() - interval '1 second',
                next_delete_attempt_at = now() - interval '1 second'
            where export_request_id = ${exportId} and generation = 1
          `;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`select set_config('brief.allow_export_object_purge', 'on', true)`;
              yield* sql`
                update export_object_generations set delete_fenced_at = now()
                where export_request_id = ${exportId} and generation = 1
              `;
              yield* sql`
                update export_object_generations
                set delete_attempts = delete_attempts + 1,
                    next_delete_attempt_at = now() + interval '5 minutes'
                where export_request_id = ${exportId} and generation = 1
              `;
            }),
          );
        }),
      );
      const before = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ readonly nextDeleteAttemptAt: Date }>`
            select next_delete_attempt_at as "nextDeleteAttemptAt"
            from export_object_generations
            where export_request_id = ${exportId} and generation = 1
          `)[0]!.nextDeleteAttemptAt;
        }),
      );
      await expect(
        runDb(isolatedUrl(), failExportRequest(exportId, new Error("export_final_failure"))),
      ).resolves.toBeUndefined();
      const after = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly status: string;
            readonly attempts: number;
            readonly fenced: boolean;
            readonly nextDeleteAttemptAt: Date;
          }>`
            select request.status, generation.delete_attempts as attempts,
                   generation.delete_fenced_at is not null as fenced,
                   generation.next_delete_attempt_at as "nextDeleteAttemptAt"
            from export_requests request
            join export_object_generations generation
              on generation.export_request_id = request.id and generation.generation = 1
            where request.id = ${exportId}
          `)[0]!;
        }),
      );
      expect(after).toMatchObject({ status: "failed", attempts: 1, fenced: true });
      expect(after.nextDeleteAttemptAt).toEqual(before);
    });

    it("records a completed Delete+HEAD presence probe but not a HEAD network failure", async () => {
      const chatId = await runDb(isolatedUrl(), seedBase);
      const exportId = crypto.randomUUID();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into export_requests (
              id, requester_user_id, scope_kind, scope_id,
              authorization_snapshot, idempotency_key
            ) values (
              ${exportId}, ${userId}, 'user_chats', 'me',
              ${sql.json({
                version: 1,
                authorizedAt: new Date().toISOString(),
                requesterUserId: userId,
                scopeKind: "user_chats",
                scopeId: "me",
                role: "self",
                clientCompanyIds: [companyId],
                accessIds: [],
                issueIds: [],
                documentIds: [],
                chatIds: [chatId],
                chatMessageIds: [],
              })},
              'export-delete-head-evidence'
            )
          `;
        }),
      );
      let headMode: "present" | "network_failure" = "present";
      const store: ExportObjectStore = {
        verifyPhysicalDeletionSafety: async () => undefined,
        get: async () => new Uint8Array(),
        put: async () => undefined,
        delete: async () => undefined,
        head: async () => {
          if (headMode === "network_failure") throw new Error("head network unavailable");
          return { byteSize: 1, sha256Hex: "a".repeat(64), generation: "1" };
        },
      };
      await expect(
        runDb(
          isolatedUrl(),
          generateExport({
            exportRequestId: exportId,
            store,
            publisherStore: publisherStoreFrom(store),
            expiresInMs: 1,
          }),
        ),
      ).resolves.toMatchObject({ status: "completed" });
      await Bun.sleep(5);
      const probeStartedAt = Date.now();
      await expect(runDb(isolatedUrl(), purgeExpiredExportObjects(store))).rejects.toThrow(
        "export_object_delete_unconfirmed",
      );
      const afterPresence = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly attempts: number;
            readonly nextDeleteAttemptAt: Date;
            readonly generationDeletedAt: Date | null;
            readonly requestDeletedAt: Date | null;
          }>`
            select generation.delete_attempts as attempts,
                   generation.next_delete_attempt_at as "nextDeleteAttemptAt",
                   generation.deleted_at as "generationDeletedAt",
                   request.object_deleted_at as "requestDeletedAt"
            from export_object_generations generation
            join export_requests request on request.id = generation.export_request_id
            where generation.export_request_id = ${exportId} and generation.generation = 1
          `)[0]!;
        }),
      );
      expect(afterPresence).toMatchObject({
        attempts: 1,
        generationDeletedAt: null,
        requestDeletedAt: null,
      });
      expect(afterPresence.nextDeleteAttemptAt.getTime()).toBeGreaterThanOrEqual(
        probeStartedAt + 299_000,
      );
      expect(afterPresence.nextDeleteAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 301_000);

      headMode = "network_failure";
      await expect(
        runDb(
          isolatedUrl(),
          purgeExpiredExportObjects(store, new Date(Date.now() + 10 * 60 * 1_000)),
        ),
      ).rejects.toThrow("head network unavailable");
      const afterNetworkFailure = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly attempts: number;
            readonly nextDeleteAttemptAt: Date;
          }>`
            select delete_attempts as attempts,
                   next_delete_attempt_at as "nextDeleteAttemptAt"
            from export_object_generations
            where export_request_id = ${exportId} and generation = 1
          `)[0]!;
        }),
      );
      expect(afterNetworkFailure.attempts).toBe(1);
      expect(afterNetworkFailure.nextDeleteAttemptAt).toEqual(afterPresence.nextDeleteAttemptAt);
    });

    it.each(["success", "failure"] as const)(
      "preserves a fenced in-flight probe schedule when PutObject exits with %s",
      async (putExit) => {
        const chatId = await runDb(isolatedUrl(), seedBase);
        const exportId = crypto.randomUUID();
        await runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into export_requests (
                id, requester_user_id, scope_kind, scope_id,
                authorization_snapshot, idempotency_key
              ) values (
                ${exportId}, ${userId}, 'user_chats', 'me',
                ${sql.json({
                  version: 1,
                  authorizedAt: new Date().toISOString(),
                  requesterUserId: userId,
                  scopeKind: "user_chats",
                  scopeId: "me",
                  role: "self",
                  clientCompanyIds: [companyId],
                  accessIds: [],
                  issueIds: [],
                  documentIds: [],
                  chatIds: [chatId],
                  chatMessageIds: [],
                })},
                ${`export-fenced-put-${putExit}`}
              )
            `;
          }),
        );
        let signalPutStarted!: () => void;
        const putStarted = new Promise<void>((resolve) => {
          signalPutStarted = resolve;
        });
        let resolvePut!: () => void;
        let rejectPut!: (error: Error) => void;
        const putResult = new Promise<void>((resolve, reject) => {
          resolvePut = resolve;
          rejectPut = reject;
        });
        const store: ExportObjectStore = {
          verifyPhysicalDeletionSafety: async () => undefined,
          get: async () => new Uint8Array(),
          put: async () => {
            signalPutStarted();
            return putResult;
          },
          delete: async () => undefined,
          head: async () => null,
        };
        const generation = runDb(
          isolatedUrl(),
          generateExport({
            exportRequestId: exportId,
            store,
            publisherStore: publisherStoreFrom(store),
            expiresInMs: 1,
          }),
        );
        await putStarted;
        await Bun.sleep(5);
        await expect(runDb(isolatedUrl(), purgeExpiredExportObjects(store))).resolves.toBe(0);
        const fenced = await runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return (yield* sql<{
              readonly attempts: number;
              readonly nextDeleteAttemptAt: Date;
            }>`
              select delete_attempts as attempts,
                     next_delete_attempt_at as "nextDeleteAttemptAt"
              from export_object_generations
              where export_request_id = ${exportId} and generation = 1
            `)[0]!;
          }),
        );
        expect(fenced.attempts).toBe(1);

        if (putExit === "success") resolvePut();
        else rejectPut(new Error("put failed after delete fence"));
        await expect(generation).rejects.toThrow(
          putExit === "success" ? "export_state_conflict" : "put failed after delete fence",
        );
        const finalized = await runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return (yield* sql<{
              readonly writerState: string;
              readonly fenced: boolean;
              readonly attempts: number;
              readonly nextDeleteAttemptAt: Date;
            }>`
              select writer_state as "writerState",
                     delete_fenced_at is not null as fenced,
                     delete_attempts as attempts,
                     next_delete_attempt_at as "nextDeleteAttemptAt"
              from export_object_generations
              where export_request_id = ${exportId} and generation = 1
            `)[0]!;
          }),
        );
        expect(finalized).toMatchObject({ writerState: "unknown", fenced: true, attempts: 1 });
        expect(finalized.nextDeleteAttemptAt).toEqual(fenced.nextDeleteAttemptAt);
      },
    );

    it("generates an authorization-snapshotted tar export, excludes later chats, and records final failure", async () => {
      const chatId = await runDb(isolatedUrl(), seedBase);
      await runDb(isolatedUrl(), createTerminalRun(chatId, "Included snapshot message"));
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const assistantMessageId = crypto.randomUUID();
          yield* sql`
            insert into chat_messages (id, chat_id, author, content)
            values (${assistantMessageId}, ${chatId}, 'assistant', 'Answer with a visible source [S1].')
          `;
          yield* sql`
            insert into assistant_message_sources (
              assistant_message_id, source_key, kind, locator,
              display_label, public_provenance
            ) values (
              ${assistantMessageId}, 'S1', 'web',
              ${sql.json({
                kind: "web",
                url: "https://example.test/evidence",
                title: "Exported evidence",
                domain: "example.test",
                quote: "Visible selected evidence",
                quoteHash: "c".repeat(64),
                publishedAt: null,
                capturedAt: now.toISOString(),
              })},
              'Exported evidence',
              ${sql.json({
                citationUrl: "https://example.test/evidence",
                documentTitle: "Exported evidence",
              })}
            )
          `;
          yield* sql`
            insert into assistant_message_source_uses (
              assistant_message_id, source_key, consumer_task_id, topic_id,
              rendered_token_count, context_order, ranges
            ) values (
              ${assistantMessageId}, 'S1', 'direct-answer', null, 12, 0, '[]'::jsonb
            )
          `;
        }),
      );
      const exportId = crypto.randomUUID();
      const authorizedAt = new Date("2026-01-15T12:00:00.000Z").toISOString();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const snapshotMessages = yield* sql<{ readonly id: string }>`
            select id::text
            from chat_messages
            where chat_id = ${chatId}
            order by created_at, id
          `;
          yield* sql`
          insert into export_requests (
            id, requester_user_id, scope_kind, scope_id, authorization_snapshot, idempotency_key
          ) values (
            ${exportId}, ${userId}, 'user_chats', 'me',
            ${sql.json({
              version: 1,
              authorizedAt,
              requesterUserId: userId,
              scopeKind: "user_chats",
              scopeId: "me",
              role: "self",
              clientCompanyIds: [companyId],
              accessIds: [],
              issueIds: [],
              documentIds: [],
              chatIds: [chatId],
              chatMessageIds: snapshotMessages.map((message) => message.id),
            })},
            'export-platform-test'
          )
        `;
        }),
      );
      const lateMessageId = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const [message] = yield* sql<{ readonly id: string }>`
            insert into chat_messages (chat_id, author, content)
            values (${chatId}, 'assistant', 'Late post-acceptance answer [LATE].')
            returning id::text
          `;
          yield* sql`
            insert into assistant_message_sources (
              assistant_message_id, source_key, kind, locator,
              display_label, public_provenance
            ) values (
              ${message!.id}, 'LATE', 'web',
              ${sql.json({
                kind: "web",
                url: "https://late.example.test/evidence",
                title: "Late evidence",
                domain: "late.example.test",
                quote: "Evidence committed after export acceptance",
                quoteHash: "d".repeat(64),
                publishedAt: null,
                capturedAt: now.toISOString(),
              })},
              'Late evidence',
              ${sql.json({
                citationUrl: "https://late.example.test/evidence",
                documentTitle: "Late evidence",
              })}
            )
          `;
          yield* sql`
            insert into assistant_message_source_uses (
              assistant_message_id, source_key, consumer_task_id, topic_id,
              rendered_token_count, context_order, ranges
            ) values (
              ${message!.id}, 'LATE', 'direct-answer', null, 7, 0, '[]'::jsonb
            )
          `;
          return message!.id;
        }),
      );
      const frozenChatMessageIds = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ readonly ids: string[] }>`
            select array(
              select jsonb_array_elements_text(
                authorization_snapshot->'chatMessageIds'
              )
            ) as ids
            from export_requests
            where id = ${exportId}
          `)[0]!.ids;
        }),
      );
      expect(frozenChatMessageIds).toHaveLength(2);
      expect(frozenChatMessageIds).not.toContain(lateMessageId);
      let saved:
        | {
            readonly objectKey: string;
            readonly body: Uint8Array;
            readonly contentType: string;
          }
        | undefined;
      let deleteAttempts = 0;
      const deletedObjectKeys: string[] = [];
      const store: ExportObjectStore = {
        verifyPhysicalDeletionSafety: async () => undefined,
        get: async () => new Uint8Array(),
        head: async () => null,
        delete: async (objectKey) => {
          deleteAttempts += 1;
          if (deleteAttempts === 1) throw new Error("temporary object delete failure");
          deletedObjectKeys.push(objectKey);
        },
        put: async (input) => {
          saved = input;
        },
      };
      await expect(
        runDb(
          isolatedUrl(),
          generateExport({
            exportRequestId: exportId,
            store,
            publisherStore: publisherStoreFrom(store),
            expiresInMs: 1,
          }),
        ),
      ).resolves.toMatchObject({ status: "completed" });
      expect(saved).toMatchObject({
        objectKey: `exports/${exportId}/attempt-1${EXPORT_ARCHIVE_FILE_EXTENSION}`,
        contentType: EXPORT_ARCHIVE_MEDIA_TYPE,
      });
      const archive = saved!.body;
      expect(new TextDecoder().decode(archive.slice(257, 262))).toBe("ustar");
      expect(archive.slice(-1024).every((byte) => byte === 0)).toBe(true);
      const archiveText = new TextDecoder().decode(archive);
      expect(archiveText).toContain("Included snapshot message");
      expect(archiveText).toContain('"formatVersion": 1');
      expect(archiveText).toContain('"chatSourceCount": 1');
      expect(archiveText).toContain('"sourceKey": "S1"');
      expect(archiveText).toContain("https://example.test/evidence");
      expect(archiveText).toContain(
        '"quoteHash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"',
      );
      expect(archiveText).toContain('"ranges": []');
      expect(archiveText).not.toContain("direct-answer");
      expect(archiveText).not.toContain("renderedTokenCount");
      expect(archiveText).not.toContain("Late post-acceptance answer");
      expect(archiveText).not.toContain("https://late.example.test/evidence");

      await expect(
        runDb(
          isolatedUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update export_requests set object_deleted_at = now() where id = ${exportId}
            `;
          }),
        ),
      ).rejects.toBeDefined();
      await Bun.sleep(5);
      await expect(runDb(isolatedUrl(), purgeExpiredExportObjects(store))).rejects.toThrow(
        "temporary object delete failure",
      );
      await expect(runDb(isolatedUrl(), purgeExpiredExportObjects(store))).resolves.toBe(1);
      await expect(runDb(isolatedUrl(), purgeExpiredExportObjects(store))).resolves.toBe(0);
      expect(deletedObjectKeys).toEqual([
        `exports/${exportId}/attempt-1${EXPORT_ARCHIVE_FILE_EXTENSION}`,
      ]);
      const objectDeletedAt = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ readonly objectDeletedAt: Date | null }>`
              select object_deleted_at as "objectDeletedAt"
              from export_requests where id = ${exportId}
            `)[0]!.objectDeletedAt;
        }),
      );
      expect(objectDeletedAt).toBeInstanceOf(Date);

      const failedId = crypto.randomUUID();
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
          insert into export_requests (
            id, requester_user_id, scope_kind, scope_id, authorization_snapshot, idempotency_key
          ) values (
            ${failedId}, ${userId}, 'user_chats', 'me',
            ${sql.json({
              version: 1,
              authorizedAt,
              requesterUserId: userId,
              scopeKind: "user_chats",
              scopeId: "me",
              role: "self",
              clientCompanyIds: [companyId],
              accessIds: [],
              issueIds: [],
              documentIds: [],
              chatIds: [chatId],
              chatMessageIds: frozenChatMessageIds,
            })},
            'export-platform-failure'
          )
        `;
        }),
      );
      const orphanDeletes: string[] = [];
      let orphanStored = false;
      const failureStore: ExportObjectStore = {
        verifyPhysicalDeletionSafety: async () => undefined,
        get: async () => new Uint8Array(),
        head: async () => null,
        put: async () => {
          orphanStored = true;
          await runDb(
            isolatedUrl(),
            failExportRequest(failedId, new Error("object_store_ambiguous")),
          );
        },
        delete: async (objectKey) => {
          orphanDeletes.push(objectKey);
        },
      };
      await expect(
        runDb(
          isolatedUrl(),
          generateExport({
            exportRequestId: failedId,
            store: failureStore,
            publisherStore: publisherStoreFrom(failureStore),
          }),
        ),
      ).rejects.toThrow("export_state_conflict");
      expect(orphanStored).toBe(true);
      const failed = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            status: string;
            errorCode: string;
            completedAt: Date;
            objectKey: string | null;
            objectDeletedAt: Date | null;
          }>`
          select status, error_code as "errorCode", completed_at as "completedAt",
                 object_key as "objectKey", object_deleted_at as "objectDeletedAt"
          from export_requests where id = ${failedId}
        `)[0]!;
        }),
      );
      expect(failed).toMatchObject({
        status: "failed",
        errorCode: "export_generation_failed",
        objectKey: null,
        objectDeletedAt: null,
      });
      expect(failed.completedAt).toBeInstanceOf(Date);
      const afterFailure = new Date(Date.now() + 1_000);
      await expect(
        runDb(isolatedUrl(), purgeExpiredExportObjects(failureStore, afterFailure)),
      ).resolves.toBe(1);
      await expect(
        runDb(isolatedUrl(), purgeExpiredExportObjects(failureStore, afterFailure)),
      ).resolves.toBe(0);
      expect(orphanDeletes).toEqual([
        `exports/${failedId}/attempt-1${EXPORT_ARCHIVE_FILE_EXTENSION}`,
      ]);
    });
  },
);

describe("deterministic tar archive", () => {
  it("uses ustar headers, 512-byte blocks, and two terminal zero blocks", () => {
    const archive = buildTarArchive([
      { name: "manifest.json", body: new TextEncoder().encode("{}\n") },
    ]);
    expect(archive.byteLength % 512).toBe(0);
    expect(new TextDecoder().decode(archive.slice(257, 262))).toBe("ustar");
    expect(archive.slice(-1024).every((byte) => byte === 0)).toBe(true);
  });
});
