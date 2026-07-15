import type { WebhookEvent } from "@clerk/backend/webhooks";
import { PgClient } from "@effect/sql-pg";
import { ConfigProvider, Effect, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { routeRequest } from "../http";
import { createExportRequest } from "@brief/backend-domain/exports";
import { acceptClerkWebhook } from "@brief/backend-domain/clerk-webhook";
import {
  selectAuthorizedPublisherDocument,
  withAuthorizedPublisherDocumentLease,
} from "@brief/backend-domain/publisher-documents";
import {
  changeIssueRestriction,
  createRestrictedSupportGrant,
  createRestrictedSupportReview,
} from "@brief/backend-domain/platform-support";
import { makeExportRoutes, type ExportArchiveSigner } from "../domain/exports";
import { makeStripeWebhookRoute, type StripeWebhookVerifier } from "../domain/stripe-webhook";

const isBun = typeof process.versions.bun === "string";
const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const databaseName = `brief_platform_api_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
const migrationsUrl = new URL("../../../../db/migrations/", import.meta.url);
const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const publisherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const subscriptionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const accessId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

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

const runDb = <A, E>(url: string, effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({ url: Redacted.make(url), applicationName: "brief-platform-api-test" }),
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

const migrate = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const files = [...new Bun.Glob("*.sql").scanSync({ cwd: migrationsUrl.pathname })].sort();
  yield* sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  for (const file of files) {
    const body = yield* Effect.promise(() => Bun.file(new URL(file, migrationsUrl)).text());
    yield* sql.unsafe(body).raw;
    yield* sql`insert into schema_migrations (name) values (${file})`;
  }
});

const pgLayer = () =>
  PgClient.layer({ url: Redacted.make(isolatedUrl()), applicationName: "brief-platform-api-test" });
const configLayer = ConfigProvider.layer(
  ConfigProvider.fromEnv({
    env: {
      AUTH_MODE: "demo",
      DEMO_USER_ID: "demo-user",
      STRIPE_SECRET_KEY: "stripe-secret",
      STRIPE_WEBHOOK_SECRET: "webhook-secret",
    },
  }),
);
const request = (method: string, path: string, init?: RequestInit) =>
  new Request(`http://brief.test${path}`, { ...init, method });
const jsonBody = <A>(response: Response): Promise<A> => response.json() as Promise<A>;

const completeExportRequest = (exportRequestId: string, expiresInMs = 60 * 60 * 1_000) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const objectKey = `exports/${exportRequestId}/attempt-1.tar`;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          insert into export_object_generations (
            export_request_id, generation, object_key, purge_after, next_delete_attempt_at
          ) values (
            ${exportRequestId}, 1, ${objectKey},
            now() + ${expiresInMs} * interval '1 millisecond',
            now() + ${expiresInMs} * interval '1 millisecond'
          )
        `;
        yield* sql`
          update export_object_generations
          set writer_state = 'in_flight', expected_sha256 = ${"0".repeat(64)},
              byte_size = 0, writer_started_at = now()
          where export_request_id = ${exportRequestId} and generation = 1
        `;
        yield* sql`
          update export_object_generations
          set writer_state = 'succeeded', writer_succeeded_at = now()
          where export_request_id = ${exportRequestId} and generation = 1
        `;
        yield* sql`
          update export_object_generations
          set promoted_at = now()
          where export_request_id = ${exportRequestId} and generation = 1
        `;
        yield* sql`
          update export_requests
          set status = 'completed', object_generation = 1, object_key = ${objectKey},
              completed_at = now(),
              expires_at = now() + ${expiresInMs} * interval '1 millisecond',
              object_purge_after = now() + ${expiresInMs} * interval '1 millisecond'
          where id = ${exportRequestId}
        `;
      }),
    );
    return objectKey;
  });

const seedExportAccess = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  yield* sql`
    insert into platform_users (id, primary_email, display_name, clerk_user_id)
    values ('demo-user', 'demo@example.test', 'Demo User', 'clerk-demo')
  `;
  yield* sql`insert into client_companies (id, name) values (${companyId}, 'Client')`;
  yield* sql`
    insert into client_company_memberships (company_id, user_id, role)
    values (${companyId}, 'demo-user', 'admin')
  `;
  yield* sql`insert into client_company_ai_settings (company_id) values (${companyId})`;
  yield* sql`
    insert into publisher_companies (id, name) values (${publisherId}, 'Publisher')
  `;
  yield* sql`
    insert into publisher_subscriptions (
      id, publisher_company_id, name, created_by_user_id
    ) values (${subscriptionId}, ${publisherId}, 'Subscription', 'publisher-admin')
  `;
  yield* sql`
    insert into client_subscription_accesses (
      id, subscription_id, client_company_id, state, first_admin_email,
      accepted_at, subscribed_at, created_by_user_id
    ) values (
      ${accessId}, ${subscriptionId}, ${companyId}, 'active', 'demo@example.test',
      now(), now(), 'publisher-admin'
    )
  `;
  yield* sql`
    insert into client_employee_subscription_grants (
      access_id, client_company_id, user_id, granted_by_user_id
    ) values (${accessId}, ${companyId}, 'demo-user', 'demo-user')
  `;
  const chats = yield* sql<{ readonly id: string }>`
    insert into chats (company_id, user_id, memory_mode)
    values (${companyId}, 'demo-user', 'private_owner')
    returning id::text
  `;
  yield* sql`
    insert into chat_subscription_sources (chat_id, access_id, client_company_id, subscription_id)
    values (${chats[0]!.id}, ${accessId}, ${companyId}, ${subscriptionId})
  `;
  return chats[0]!.id;
});

describe.skipIf(!isBun || !databaseUrl)("platform webhook and export API", () => {
  beforeAll(async () => {
    await runDb(
      adminUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`).withoutTransform;
      }),
    );
    await runDb(isolatedUrl(), migrate);
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
                         stripe_webhook_events, export_requests,
                         platform_authorization_audit_log, jobs cascade
        `;
      }),
    );
  });

  it("verifies exact raw Stripe bytes and durably deduplicates webhook jobs", async () => {
    const rawBody = '{"exact":"bytes and spacing"}';
    const verifier = vi.fn<StripeWebhookVerifier>(async (input) => {
      expect(input.rawBody).toBe(rawBody);
      expect(input.signature).toBe("valid-signature");
      return {
        id: "evt_platform_api",
        type: "invoice.paid",
        payload: { id: "evt_platform_api", type: "invoice.paid", data: { object: {} } },
      };
    });
    const route = makeStripeWebhookRoute(pgLayer(), verifier);
    const call = () =>
      Effect.runPromise(
        routeRequest(
          [route],
          request("POST", "/v1/billing/stripe/webhook", {
            headers: { "stripe-signature": "valid-signature" },
            body: rawBody,
          }),
        ).pipe(Effect.provide(configLayer)),
      );
    const responses = await Promise.all(Array.from({ length: 6 }, call));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const bodies = await Promise.all(
      responses.map((response) => jsonBody<{ duplicate: boolean }>(response)),
    );
    expect(bodies.filter((body) => !body.duplicate)).toHaveLength(1);
    const counts = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ events: number; jobs: number; signedPayload: string }>`
          select (select count(*)::int from stripe_webhook_events) events,
                 (select count(*)::int from jobs where kind = 'process_stripe_webhook') jobs,
                 (select signed_payload from stripe_webhook_events
                  where stripe_event_id = 'evt_platform_api') as "signedPayload"
        `)[0]!;
      }),
    );
    expect(counts).toEqual({ events: 1, jobs: 1, signedPayload: rawBody });

    const byteConflictRoute = makeStripeWebhookRoute(pgLayer(), async () => ({
      id: "evt_platform_api",
      type: "invoice.paid",
      payload: { id: "evt_platform_api", type: "invoice.paid", data: { object: {} } },
    }));
    const sameParsedDifferentSignedBytes = await Effect.runPromise(
      routeRequest(
        [byteConflictRoute],
        request("POST", "/v1/billing/stripe/webhook", {
          headers: { "stripe-signature": "valid-signature" },
          body: '{ "exact": "bytes and spacing" }',
        }),
      ).pipe(Effect.provide(configLayer)),
    );
    expect(sameParsedDifferentSignedBytes.status).toBe(409);

    const conflictingRoute = makeStripeWebhookRoute(pgLayer(), async () => ({
      id: "evt_platform_api",
      type: "customer.subscription.deleted",
      payload: { id: "evt_platform_api", type: "customer.subscription.deleted" },
    }));
    const conflict = await Effect.runPromise(
      routeRequest(
        [conflictingRoute],
        request("POST", "/v1/billing/stripe/webhook", {
          headers: { "stripe-signature": "valid-signature" },
          body: rawBody,
        }),
      ).pipe(Effect.provide(configLayer)),
    );
    expect(conflict.status).toBe(409);

    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update stripe_webhook_events
          set processed_at = now(), processing_error_code = null
          where stripe_event_id = 'evt_platform_api'
        `;
      }),
    );
    const acceptedAfterProcessing = await call();
    expect(acceptedAfterProcessing.status).toBe(200);
    expect(await jsonBody<{ duplicate: boolean }>(acceptedAfterProcessing)).toEqual({
      received: true,
      duplicate: true,
    });
  });

  it("rejects invalid Stripe signatures without persisting anything", async () => {
    const route = makeStripeWebhookRoute(pgLayer(), async () => {
      throw new Error("signature invalid");
    });
    const response = await Effect.runPromise(
      routeRequest(
        [route],
        request("POST", "/v1/billing/stripe/webhook", {
          headers: { "stripe-signature": "bad" },
          body: "{}",
        }),
      ).pipe(Effect.provide(configLayer)),
    );
    expect(response.status).toBe(400);
    const count = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          count: number;
        }>`select count(*)::int count from stripe_webhook_events`)[0]!.count;
      }),
    );
    expect(count).toBe(0);
  });

  it("captures exact request-time export authorization and idempotently queues one generator", async () => {
    const chatId = await runDb(isolatedUrl(), seedExportAccess);
    const zeroSourceChatId = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly id: string }>`
          insert into chats (company_id, user_id, memory_mode)
          values (${companyId}, 'demo-user', 'private_owner')
          returning id::text
        `)[0]!.id;
      }),
    );
    const acceptedMessageIds = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values
            (${chatId}, 'user', 'Publisher-backed chat at export acceptance'),
            (${zeroSourceChatId}, 'user', 'Public-only chat at export acceptance')
          returning id::text
        `;
      }),
    );
    const routes = makeExportRoutes(pgLayer());
    const input = {
      scopeKind: "user_chats",
      scopeId: "me",
      idempotencyKey: "export-request-0001",
    };
    const call = () =>
      Effect.runPromise(
        routeRequest(
          routes,
          request("POST", "/v1/exports", {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          }),
        ).pipe(Effect.provide(configLayer)),
      );
    const first = await call();
    const replay = await call();
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    const firstBody = await jsonBody<{ export: { id: string }; duplicate: boolean }>(first);
    const replayBody = await jsonBody<{ export: { id: string }; duplicate: boolean }>(replay);
    expect(firstBody.duplicate).toBe(false);
    expect(replayBody).toMatchObject({ export: { id: firstBody.export.id }, duplicate: true });
    const stored = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const requestRow = (yield* sql<{
          snapshot: {
            requesterUserId: string;
            accessIds: string[];
            chatIds: string[];
            chatMessageIds: string[];
            role: string;
          };
        }>`
          select authorization_snapshot snapshot from export_requests where id = ${firstBody.export.id}
        `)[0]!;
        const jobs = (yield* sql<{ count: number }>`
          select count(*)::int count from jobs where kind = 'generate_export'
        `)[0]!.count;
        return { requestRow, jobs };
      }),
    );
    expect(stored).toEqual({
      requestRow: {
        snapshot: expect.objectContaining({
          requesterUserId: "demo-user",
          accessIds: [accessId],
          chatIds: [chatId, zeroSourceChatId].sort(),
          chatMessageIds: acceptedMessageIds.map((message) => message.id).sort(),
          role: "self",
        }),
      },
      jobs: 1,
    });

    const clientCompanyExport = await Effect.runPromise(
      routeRequest(
        routes,
        request("POST", "/v1/exports", {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scopeKind: "client_company",
            scopeId: companyId,
            idempotencyKey: "export-client-company-0001",
          }),
        }),
      ).pipe(Effect.provide(configLayer)),
    );
    expect(clientCompanyExport.status).toBe(202);

    const conflict = await Effect.runPromise(
      routeRequest(
        routes,
        request("POST", "/v1/exports", {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...input, scopeKind: "client_company", scopeId: companyId }),
        }),
      ).pipe(Effect.provide(configLayer)),
    );
    expect(conflict.status).toBe(409);

    const unauthorizedScope = await Effect.runPromise(
      routeRequest(
        routes,
        request("POST", "/v1/exports", {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scopeKind: "publisher_company",
            scopeId: publisherId,
            idempotencyKey: "export-request-forbidden-0001",
          }),
        }),
      ).pipe(Effect.provide(configLayer)),
    );
    expect(unauthorizedScope.status).toBe(403);

    const audits = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{
          outcome: "succeeded" | "denied";
          reasonCode: string | null;
          scopeKind: string;
        }>`
          select outcome, reason_code as "reasonCode", scope_kind as "scopeKind"
          from platform_authorization_audit_log
          where actor_user_id = 'demo-user' and action = 'export.create'
          order by id
        `;
      }),
    );
    expect(audits).toEqual([
      { outcome: "succeeded", reasonCode: null, scopeKind: "user_chats" },
      { outcome: "succeeded", reasonCode: null, scopeKind: "user_chats" },
      { outcome: "succeeded", reasonCode: null, scopeKind: "client_company" },
      { outcome: "denied", reasonCode: "idempotency_conflict", scopeKind: "client_company" },
      { outcome: "denied", reasonCode: "export_forbidden", scopeKind: "publisher_company" },
    ]);
  });

  it("excludes membership-only companies from a grant-backed user chat export", async () => {
    const grantBackedChatId = await runDb(isolatedUrl(), seedExportAccess);
    const fixture = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const membershipOnlyCompanyId = crypto.randomUUID();
        const [grantBackedMessage] = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${grantBackedChatId}, 'user', 'Grant-backed export content')
          returning id::text
        `;
        yield* sql`
          insert into client_companies (id, name)
          values (${membershipOnlyCompanyId}, 'Membership-only client')
        `;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values (${membershipOnlyCompanyId}, 'demo-user', 'member')
        `;
        yield* sql`
          insert into client_company_ai_settings (company_id)
          values (${membershipOnlyCompanyId})
        `;
        const [membershipOnlyChat] = yield* sql<{ readonly id: string }>`
          insert into chats (company_id, user_id, memory_mode)
          values (${membershipOnlyCompanyId}, 'demo-user', 'private_owner')
          returning id::text
        `;
        const [membershipOnlyMessage] = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${membershipOnlyChat!.id}, 'user', 'Must not cross the grant boundary')
          returning id::text
        `;
        return {
          grantBackedMessageId: grantBackedMessage!.id,
          membershipOnlyCompanyId,
          membershipOnlyChatId: membershipOnlyChat!.id,
          membershipOnlyMessageId: membershipOnlyMessage!.id,
        };
      }),
    );
    const accepted = await runDb(
      isolatedUrl(),
      createExportRequest({
        requesterUserId: "demo-user",
        mfaVerified: true,
        organizationId: null,
        request: {
          scopeKind: "user_chats",
          scopeId: "me",
          idempotencyKey: "export-grant-backed-companies-0001",
        },
        auditSucceeded: Effect.void,
      }),
    );
    expect(accepted).toMatchObject({ kind: "accepted", duplicate: false });
    if (accepted.kind !== "accepted") throw new Error("expected accepted export");
    const stored = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly snapshot: {
            readonly clientCompanyIds: string[];
            readonly chatIds: string[];
            readonly chatMessageIds: string[];
          };
          readonly holdScopeKeys: string[];
        }>`
          select authorization_snapshot as snapshot,
                 hold_scope_keys as "holdScopeKeys"
          from export_requests where id = ${accepted.row.id}
        `)[0]!;
      }),
    );
    expect(stored.snapshot).toMatchObject({
      clientCompanyIds: [companyId],
      chatIds: [grantBackedChatId],
      chatMessageIds: [fixture.grantBackedMessageId],
    });
    expect(stored.snapshot.clientCompanyIds).not.toContain(fixture.membershipOnlyCompanyId);
    expect(stored.snapshot.chatIds).not.toContain(fixture.membershipOnlyChatId);
    expect(stored.snapshot.chatMessageIds).not.toContain(fixture.membershipOnlyMessageId);
    expect(stored.holdScopeKeys).toEqual(
      [`chat:${grantBackedChatId}`, `client_company:${companyId}`, "user:demo-user"].sort(),
    );
  });

  it("orders export membership lanes before requester rows during account purge", async () => {
    const chatId = await runDb(isolatedUrl(), seedExportAccess);
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`delete from chats where id = ${chatId}`;
        yield* sql`
          update platform_users
          set recovery_deleted_at = now() - interval '181 days',
              purge_after = now() - interval '1 day'
          where id = 'demo-user'
        `;
      }),
    );
    const jobsModuleUrl = new URL("../../../worker/src/platform/jobs.ts", import.meta.url).href;
    const jobsModule = await import(/* @vite-ignore */ jobsModuleUrl);

    let signalRequesterHeld!: () => void;
    const requesterHeld = new Promise<void>((resolve) => {
      signalRequesterHeld = resolve;
    });
    let releaseRequester!: () => void;
    const requesterReleased = new Promise<void>((resolve) => {
      releaseRequester = resolve;
    });
    const requesterHolder = runDbAs(
      "brief-export-purge-requester-holder",
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`select id from platform_users where id = 'demo-user' for update`;
            yield* Effect.sync(signalRequesterHeld);
            yield* Effect.promise(() => requesterReleased);
          }),
        );
      }),
    );
    await requesterHeld;

    const exporting = runDbAs(
      "brief-export-before-purge-requester",
      Effect.exit(
        createExportRequest({
          requesterUserId: "demo-user",
          mfaVerified: true,
          organizationId: null,
          request: {
            scopeKind: "user_chats",
            scopeId: "me",
            idempotencyKey: "export-account-purge-lock-order-0001",
          },
          auditSucceeded: Effect.void,
        }),
      ),
    );
    await waitForDatabaseLock("brief-export-before-purge-requester");
    const purging = runDbAs(
      "brief-purge-behind-export-membership-lane",
      jobsModule.purgeDeletedAccounts(),
    );
    try {
      await waitForDatabaseLock("brief-purge-behind-export-membership-lane");
    } finally {
      releaseRequester();
    }

    await requesterHolder;
    await expect(exporting).resolves.toMatchObject({ _tag: "Failure" });
    await expect(purging).resolves.toMatchObject({ purgedUsers: 1 });
    const after = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly exportCount: number;
          readonly purged: boolean;
        }>`
          select
            (select count(*)::int from export_requests
             where idempotency_key = 'export-account-purge-lock-order-0001') as "exportCount",
            (select purged_at is not null from platform_users
             where id = 'demo-user') as purged
        `)[0]!;
      }),
    );
    expect(after).toEqual({ exportCount: 0, purged: true });
  });

  it("globally orders mixed client and publisher lanes between PDF reads and account purge", async () => {
    const deletingUserId = `mixed-pdf-purge-${crypto.randomUUID()}`;
    const publisherCompanyId = crypto.randomUUID();
    const publisherSubscriptionId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
            insert into platform_users (
              id, primary_email, display_name, clerk_user_id,
              recovery_deleted_at, purge_after
            ) values (
              ${deletingUserId}, ${`${deletingUserId}@example.test`}, 'Deleting PDF reader',
              ${`clerk-${deletingUserId}`}, now() - interval '181 days', now() - interval '1 day'
            )
          `;
        yield* sql`
            insert into client_companies (id, name) values (${companyId}, 'PDF client')
          `;
        yield* sql`
            insert into publisher_companies (id, name)
            values (${publisherCompanyId}, 'PDF publisher')
          `;
        yield* sql`
            insert into client_company_memberships (company_id, user_id, role)
            values (${companyId}, ${deletingUserId}, 'member')
          `;
        yield* sql`
            insert into publisher_company_memberships (
              publisher_company_id, user_id, role, accepted_at
            ) values (${publisherCompanyId}, ${deletingUserId}, 'member', now())
          `;
        yield* sql`
            insert into publisher_subscriptions (
              id, publisher_company_id, name, created_by_user_id
            ) values (
              ${publisherSubscriptionId}, ${publisherCompanyId}, 'Mixed lane source',
              ${deletingUserId}
            )
          `;
        yield* sql`
            insert into client_subscription_accesses (
              id, subscription_id, client_company_id, state, first_admin_email,
              accepted_at, subscribed_at, created_by_user_id
            ) values (
              ${accessId}, ${publisherSubscriptionId}, ${companyId}, 'active',
              ${`${deletingUserId}@example.test`}, now(), now(), ${deletingUserId}
            )
          `;
        yield* sql`
            insert into publisher_issues (
              id, subscription_id, title, status, created_by_user_id
            ) values (
              ${issueId}, ${publisherSubscriptionId}, 'Mixed lane issue', 'draft',
              ${deletingUserId}
            )
          `;
        yield* sql`
            insert into brief_documents (
              id, issue_id, title, original_file_name, object_key, media_type,
              byte_size, sha256_hex, upload_completed_at, created_by_user_id
            ) values (
              ${documentId}, ${issueId}, 'Mixed lane PDF', 'mixed.pdf',
              ${`issues/${issueId}/mixed.pdf`}, 'application/pdf', 4, ${"a".repeat(64)},
              now(), ${deletingUserId}
            )
          `;
        yield* sql`
            update publisher_issues
            set status = 'published', publication_at = now(), published_at = now()
            where id = ${issueId}
          `;
        yield* sql`
            insert into issue_deliveries (
              issue_id, subscription_id, access_id, client_company_id, historical
            ) values (
              ${issueId}, ${publisherSubscriptionId}, ${accessId}, ${companyId}, false
            )
          `;
      }),
    );
    const jobsModuleUrl = new URL("../../../worker/src/platform/jobs.ts", import.meta.url).href;
    const jobsModule = await import(/* @vite-ignore */ jobsModuleUrl);

    const holdLane = (applicationName: string, lane: string) => {
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
              yield* sql`select pg_advisory_xact_lock(hashtext(${lane}))`;
              yield* Effect.sync(signalHeld);
              yield* Effect.promise(() => released);
            }),
          );
        }),
      );
      return { held, release, done };
    };
    const clientHolder = holdLane(
      "brief-mixed-purge-client-holder",
      `brief:client-members:${companyId}`,
    );
    const publisherHolder = holdLane(
      "brief-mixed-purge-publisher-holder",
      `brief:publisher-members:${publisherCompanyId}`,
    );
    await Promise.all([clientHolder.held, publisherHolder.held]);

    let signed = false;
    const purging = runDbAs("brief-mixed-purge", jobsModule.purgeDeletedAccounts());
    let reading!: Promise<string | null>;
    try {
      await waitForDatabaseLock("brief-mixed-purge");
      reading = runDbAs(
        "brief-mixed-pdf-reader",
        withAuthorizedPublisherDocumentLease(
          { userId: deletingUserId, organizationId: null, mode: "clerk" },
          issueId,
          documentId,
          () =>
            Effect.sync(() => {
              signed = true;
              return "signed";
            }),
        ),
      );
      await waitForDatabaseLock("brief-mixed-pdf-reader");
      // With the old publisher-then-client purge order, releasing this lane
      // lets purge hold publisher while the reader is queued first on client.
      publisherHolder.release();
      await publisherHolder.done;
      await Bun.sleep(25);
      clientHolder.release();
      await clientHolder.done;

      await expect(purging).resolves.toMatchObject({ purgedUsers: 1 });
      await expect(reading).resolves.toBeNull();
      expect(signed).toBe(false);
    } finally {
      publisherHolder.release();
      clientHolder.release();
      await Promise.allSettled([publisherHolder.done, clientHolder.done]);
    }
  }, 20_000);

  it("locks a delivered client lane before signer-pause membership acceptance and revocation", async () => {
    const signerId = `publisher-pdf-race-signer-${crypto.randomUUID()}`;
    const inviteeId = `publisher-pdf-race-invitee-${crypto.randomUUID()}`;
    const publisherCompanyId = crypto.randomUUID();
    const clientCompanyId = crypto.randomUUID();
    const publisherSubscriptionId = crypto.randomUUID();
    const accessId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values
            (${signerId}, ${`${signerId}@example.test`}, 'PDF race signer', ${signerId}),
            (${inviteeId}, ${`${inviteeId}@example.test`}, 'PDF race invitee', ${inviteeId})
        `;
        yield* sql`
          insert into publisher_companies (id, name)
          values (${publisherCompanyId}, 'PDF race publisher')
        `;
        yield* sql`
          insert into client_companies (id, name)
          values (${clientCompanyId}, 'PDF race client')
        `;
        yield* sql`
          insert into publisher_company_memberships (
            publisher_company_id, user_id, role, accepted_at
          ) values (${publisherCompanyId}, ${signerId}, 'admin', now())
        `;
        yield* sql`
          insert into publisher_subscriptions (
            id, publisher_company_id, name, created_by_user_id
          ) values (
            ${publisherSubscriptionId}, ${publisherCompanyId}, 'PDF race source', ${signerId}
          )
        `;
        yield* sql`
          insert into client_subscription_accesses (
            id, subscription_id, client_company_id, state, first_admin_email,
            accepted_at, subscribed_at, created_by_user_id
          ) values (
            ${accessId}, ${publisherSubscriptionId}, ${clientCompanyId}, 'active',
            ${`${inviteeId}@example.test`}, now(), now(), ${signerId}
          )
        `;
        yield* sql`
          insert into publisher_issues (
            id, subscription_id, title, status, created_by_user_id
          ) values (
            ${issueId}, ${publisherSubscriptionId}, 'PDF race issue', 'draft', ${signerId}
          )
        `;
        yield* sql`
          insert into brief_documents (
            id, issue_id, title, original_file_name, object_key, media_type,
            byte_size, sha256_hex, upload_completed_at, created_by_user_id
          ) values (
            ${documentId}, ${issueId}, 'PDF race document', 'race.pdf',
            ${`issues/${issueId}/race.pdf`}, 'application/pdf', 4, ${"a".repeat(64)},
            now(), ${signerId}
          )
        `;
        yield* sql`
          update publisher_issues
          set status = 'published', publication_at = now(), published_at = now()
          where id = ${issueId}
        `;
        yield* sql`
          insert into issue_deliveries (
            issue_id, subscription_id, access_id, client_company_id, historical
          ) values (${issueId}, ${publisherSubscriptionId}, ${accessId}, ${clientCompanyId}, false)
        `;
      }),
    );

    let signalSignerStarted!: () => void;
    const signerStarted = new Promise<void>((resolve) => {
      signalSignerStarted = resolve;
    });
    let releaseSigner!: () => void;
    const signerReleased = new Promise<void>((resolve) => {
      releaseSigner = resolve;
    });
    const signing = runDbAs(
      "brief-pdf-race-reader",
      withAuthorizedPublisherDocumentLease(
        { userId: signerId, organizationId: null, mode: "clerk" },
        issueId,
        documentId,
        () =>
          Effect.gen(function* () {
            yield* Effect.sync(signalSignerStarted);
            yield* Effect.promise(() => signerReleased);
            return "signed";
          }),
      ),
    );
    await signerStarted;

    let signalAcceptanceInserted!: () => void;
    const acceptanceInserted = new Promise<void>((resolve) => {
      signalAcceptanceInserted = resolve;
    });
    let releaseAcceptance!: () => void;
    const acceptanceReleased = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    const acceptance = runDbAs(
      "brief-pdf-race-acceptance",
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(
                hashtext(${`brief:client-members:${clientCompanyId}`})
              )
            `;
            yield* sql`
              insert into client_company_memberships (company_id, user_id, role)
              values (${clientCompanyId}, ${inviteeId}, 'member')
            `;
            yield* sql`
              insert into client_employee_subscription_grants (
                access_id, client_company_id, user_id, granted_by_user_id
              ) values (${accessId}, ${clientCompanyId}, ${inviteeId}, ${signerId})
            `;
            yield* Effect.sync(signalAcceptanceInserted);
            yield* Effect.promise(() => acceptanceReleased);
          }),
        );
      }),
    );
    await waitForDatabaseLock("brief-pdf-race-acceptance");
    let acceptedWhileSignerPaused = false;
    await Promise.race([
      acceptanceInserted.then(() => {
        acceptedWhileSignerPaused = true;
      }),
      Bun.sleep(50),
    ]);
    expect(acceptedWhileSignerPaused).toBe(false);

    releaseSigner();
    await expect(signing).resolves.toBe("signed");
    await acceptanceInserted;
    releaseAcceptance();
    await acceptance;

    await runDbAs(
      "brief-pdf-race-revocation",
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(
                hashtext(${`brief:client-members:${clientCompanyId}`})
              )
            `;
            yield* sql`
              update client_employee_subscription_grants
              set revoked_at = now(), revoked_by_user_id = ${signerId}
              where access_id = ${accessId} and client_company_id = ${clientCompanyId}
                and user_id = ${inviteeId}
            `;
            yield* sql`
              update client_company_memberships
              set revoked_at = now(), revoked_by_user_id = ${signerId}
              where company_id = ${clientCompanyId} and user_id = ${inviteeId}
            `;
          }),
        );
      }),
    );
    await expect(
      runDb(
        isolatedUrl(),
        selectAuthorizedPublisherDocument(
          { userId: inviteeId, organizationId: null, mode: "clerk" },
          issueId,
          documentId,
        ),
      ),
    ).resolves.toBeNull();
  }, 20_000);

  it("holds the live accepted user through invitation membership writes during account purge", async () => {
    const deletingUserId = `invitation-purge-${crypto.randomUUID()}`;
    const deletingEmail = `${deletingUserId}@example.test`;
    const invitationId = crypto.randomUUID();
    const externalInvitationId = `orginv-${crypto.randomUUID()}`;
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
            insert into platform_users (id, primary_email, display_name, clerk_user_id)
            values
              ('invitation-purge-owner', 'invitation-owner@example.test',
               'Invitation owner', 'clerk-invitation-owner'),
              (${deletingUserId}, ${deletingEmail}, 'Invitation target', ${deletingUserId})
          `;
        yield* sql`
            insert into client_companies (id, name, clerk_organization_id)
            values (${companyId}, 'Invitation purge client', 'org_invitation_purge')
          `;
        yield* sql`
            insert into workspace_invitations (
              id, workspace_kind, client_company_id, normalized_email, role,
              clerk_invitation_id, state, invited_by_user_id, expires_at
            ) values (
              ${invitationId}, 'client', ${companyId}, ${deletingEmail}, 'member',
              ${externalInvitationId}, 'pending', 'invitation-purge-owner', ${expiresAt}
            )
          `;
      }),
    );
    const jobsModuleUrl = new URL("../../../worker/src/platform/jobs.ts", import.meta.url).href;
    const jobsModule = await import(/* @vite-ignore */ jobsModuleUrl);

    let signalDeletionHeld!: () => void;
    const deletionHeld = new Promise<void>((resolve) => {
      signalDeletionHeld = resolve;
    });
    let releaseDeletion!: () => void;
    const deletionReleased = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    const deletionHolder = runDbAs(
      "brief-invitation-purge-user-holder",
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`select id from platform_users where id = ${deletingUserId} for update`;
            yield* sql`
                update platform_users
                set recovery_deleted_at = now() - interval '181 days',
                    purge_after = now() - interval '1 day'
                where id = ${deletingUserId}
              `;
            yield* Effect.sync(signalDeletionHeld);
            yield* Effect.promise(() => deletionReleased);
          }),
        );
      }),
    );
    await deletionHeld;

    const accepting = runDbAs(
      "brief-invitation-purge-acceptance",
      Effect.exit(
        acceptClerkWebhook({
          eventId: `evt-${deletingUserId}`,
          eventTimestamp: Math.floor(Date.now() / 1_000),
          payloadHash: "b".repeat(64),
          event: {
            type: "organizationInvitation.accepted",
            data: {
              id: externalInvitationId,
              user_id: deletingUserId,
              organization_id: "org_invitation_purge",
              email_address: deletingEmail,
              role: "org:member",
              private_metadata: { briefWorkspaceInvitationId: invitationId },
              expires_at: expiresAt.getTime(),
            },
          } as unknown as WebhookEvent,
        }),
      ),
    );
    try {
      await waitForDatabaseLock("brief-invitation-purge-acceptance");
    } finally {
      releaseDeletion();
    }
    await deletionHolder;
    const purging = runDbAs("brief-invitation-purge-worker", jobsModule.purgeDeletedAccounts());
    await expect(accepting).resolves.toMatchObject({ _tag: "Failure" });
    await expect(purging).resolves.toMatchObject({ purgedUsers: 1 });
    const after = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly purged: boolean;
          readonly invitationState: string;
          readonly membershipCount: number;
        }>`
            select
              (select purged_at is not null from platform_users
               where id = ${deletingUserId}) as purged,
              (select state from workspace_invitations
               where id = ${invitationId}) as "invitationState",
              (select count(*)::int from client_company_memberships
               where company_id = ${companyId} and user_id = ${deletingUserId})
                as "membershipCount"
          `)[0]!;
      }),
    );
    expect(after).toEqual({ purged: true, invitationState: "pending", membershipCount: 0 });
  }, 20_000);

  it("takes accepted-invitation lanes before user upsert during account purge", async () => {
    const deletingUserId = `upsert-invitation-purge-${crypto.randomUUID()}`;
    const deletingEmail = `${deletingUserId}@example.test`;
    const invitationId = crypto.randomUUID();
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into platform_users (
            id, primary_email, display_name, clerk_user_id,
            recovery_deleted_at, purge_after
          ) values
            ('upsert-invitation-owner', 'upsert-invitation-owner@example.test',
             'Upsert invitation owner', 'clerk-upsert-invitation-owner', null, null),
            (${deletingUserId}, ${deletingEmail}, 'Deleting invited user',
             ${deletingUserId}, now() - interval '181 days', now() - interval '1 day')
        `;
        yield* sql`
          insert into client_companies (id, name)
          values (${companyId}, 'Upsert invitation client')
        `;
        yield* sql`
          insert into client_company_memberships (
            company_id, user_id, role, revoked_at, revoked_by_user_id
          ) values (
            ${companyId}, ${deletingUserId}, 'member', now(), 'upsert-invitation-owner'
          )
        `;
        yield* sql`
          insert into workspace_invitations (
            id, workspace_kind, client_company_id, normalized_email, role,
            clerk_invitation_id, expires_at, state, accepted_user_id, accepted_at,
            invited_by_user_id
          ) values (
            ${invitationId}, 'client', ${companyId}, ${deletingEmail}, 'member',
            ${`orginv-${invitationId}`}, now() + interval '1 day',
            'accepted', ${deletingUserId}, now(), 'upsert-invitation-owner'
          )
        `;
      }),
    );
    const jobsModuleUrl = new URL("../../../worker/src/platform/jobs.ts", import.meta.url).href;
    const jobsModule = await import(/* @vite-ignore */ jobsModuleUrl);

    let signalLaneHeld!: () => void;
    const laneHeld = new Promise<void>((resolve) => {
      signalLaneHeld = resolve;
    });
    let releaseLane!: () => void;
    const laneReleased = new Promise<void>((resolve) => {
      releaseLane = resolve;
    });
    const laneHolder = runDbAs(
      "brief-upsert-invitation-lane-holder",
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(
                hashtext(${`brief:client-members:${companyId}`})
              )
            `;
            yield* Effect.sync(signalLaneHeld);
            yield* Effect.promise(() => laneReleased);
          }),
        );
      }),
    );
    let signalUserHeld!: () => void;
    const userHeld = new Promise<void>((resolve) => {
      signalUserHeld = resolve;
    });
    let releaseUser!: () => void;
    const userReleased = new Promise<void>((resolve) => {
      releaseUser = resolve;
    });
    const userHolder = runDbAs(
      "brief-upsert-invitation-user-holder",
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`select id from platform_users where id = ${deletingUserId} for update`;
            yield* Effect.sync(signalUserHeld);
            yield* Effect.promise(() => userReleased);
          }),
        );
      }),
    );
    await Promise.all([laneHeld, userHeld]);

    const purging = runDbAs("brief-upsert-invitation-purger", jobsModule.purgeDeletedAccounts());
    await waitForDatabaseLock("brief-upsert-invitation-purger");
    const upserting = runDbAs(
      "brief-upsert-invitation-webhook",
      Effect.exit(
        acceptClerkWebhook({
          eventId: `evt-${deletingUserId}`,
          eventTimestamp: Math.floor(Date.now() / 1_000),
          payloadHash: "c".repeat(64),
          event: {
            type: "user.updated",
            data: {
              id: deletingUserId,
              primary_email_address_id: `email-${deletingUserId}`,
              email_addresses: [
                {
                  id: `email-${deletingUserId}`,
                  email_address: deletingEmail,
                  verification: { status: "verified" },
                },
              ],
              first_name: "Must not",
              last_name: "Restore",
              two_factor_enabled: false,
              updated_at: Date.now(),
            },
          } as unknown as WebhookEvent,
        }),
      ),
    );
    try {
      await waitForDatabaseLock("brief-upsert-invitation-webhook");
      releaseUser();
      await userHolder;
      await Bun.sleep(25);
      releaseLane();
      await laneHolder;

      await expect(purging).resolves.toMatchObject({ purgedUsers: 1 });
      await expect(upserting).resolves.toMatchObject({ _tag: "Failure" });
    } finally {
      releaseUser();
      releaseLane();
      await Promise.allSettled([userHolder, laneHolder]);
    }
    const after = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly purged: boolean;
          readonly tombstones: number;
          readonly memberships: number;
        }>`
          select
            (select purged_at is not null from platform_users
             where id = ${deletingUserId}) as purged,
            (select count(*)::int from identity_deletion_tombstones
             where platform_user_id = ${deletingUserId}) as tombstones,
            (select count(*)::int from client_company_memberships
             where user_id = ${deletingUserId}) as memberships
        `)[0]!;
      }),
    );
    expect(after).toEqual({ purged: true, tombstones: 1, memberships: 0 });
  }, 20_000);

  it("rechecks permanent identity tombstones after purge wins the platform-user row", async () => {
    const deletingUserId = `upsert-tombstone-purge-${crypto.randomUUID()}`;
    const originalEmail = `${deletingUserId}@example.test`;
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into platform_users (
            id, primary_email, display_name, clerk_user_id,
            recovery_deleted_at, purge_after
          ) values (
            ${deletingUserId}, ${originalEmail}, 'Deleting identity', ${deletingUserId},
            now() - interval '181 days', now() - interval '1 day'
          )
        `;
      }),
    );
    const jobsModuleUrl = new URL("../../../worker/src/platform/jobs.ts", import.meta.url).href;
    const jobsModule = await import(/* @vite-ignore */ jobsModuleUrl);

    let signalUserHeld!: () => void;
    const userHeld = new Promise<void>((resolve) => {
      signalUserHeld = resolve;
    });
    let releaseUser!: () => void;
    const userReleased = new Promise<void>((resolve) => {
      releaseUser = resolve;
    });
    const userHolder = runDbAs(
      "brief-upsert-tombstone-user-holder",
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`select id from platform_users where id = ${deletingUserId} for update`;
            yield* Effect.sync(signalUserHeld);
            yield* Effect.promise(() => userReleased);
          }),
        );
      }),
    );
    await userHeld;

    const purging = runDbAs("brief-upsert-tombstone-purger", jobsModule.purgeDeletedAccounts());
    await waitForDatabaseLock("brief-upsert-tombstone-purger");
    const upserting = runDbAs(
      "brief-upsert-tombstone-webhook",
      acceptClerkWebhook({
        eventId: `evt-${deletingUserId}`,
        eventTimestamp: Math.floor(Date.now() / 1_000),
        payloadHash: "d".repeat(64),
        event: {
          type: "user.updated",
          data: {
            id: deletingUserId,
            primary_email_address_id: `email-${deletingUserId}`,
            email_addresses: [
              {
                id: `email-${deletingUserId}`,
                email_address: "must-not-restore@example.test",
                verification: { status: "verified" },
              },
            ],
            first_name: "Must not",
            last_name: "Restore",
            two_factor_enabled: true,
            updated_at: Date.now(),
          },
        } as unknown as WebhookEvent,
      }),
    );
    try {
      await waitForDatabaseLock("brief-upsert-tombstone-webhook");
    } finally {
      releaseUser();
    }
    await userHolder;
    await expect(purging).resolves.toMatchObject({ purgedUsers: 1 });
    await expect(upserting).resolves.toBe("processed");
    const after = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly email: string;
          readonly clerkUserId: string;
          readonly purged: boolean;
          readonly tombstones: number;
        }>`
          select primary_email as email, clerk_user_id as "clerkUserId",
                 purged_at is not null as purged,
                 (select count(*)::int from identity_deletion_tombstones
                  where platform_user_id = ${deletingUserId}) as tombstones
          from platform_users where id = ${deletingUserId}
        `)[0]!;
      }),
    );
    expect(after).toEqual({
      email: `deleted+${deletingUserId}@deleted.invalid`,
      clerkUserId: `deleted:${deletingUserId}`,
      purged: true,
      tombstones: 1,
    });
  }, 20_000);

  it("freezes exact chat messages and cited hold identities before a late answer commits", async () => {
    const chatId = await runDb(isolatedUrl(), seedExportAccess);
    const fixture = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const issueId = crypto.randomUUID();
        const documentId = crypto.randomUUID();
        const versionId = crypto.randomUUID();
        yield* sql`
          insert into publisher_issues (
            id, subscription_id, title, status, created_by_user_id
          ) values (${issueId}, ${subscriptionId}, 'Late cited issue', 'draft', 'publisher-admin')
        `;
        yield* sql`
          insert into brief_documents (
            id, issue_id, title, original_file_name, object_key, media_type,
            byte_size, sha256_hex, upload_completed_at, created_by_user_id, language
          ) values (
            ${documentId}, ${issueId}, 'Late cited document', 'late.pdf',
            ${`publisher/${publisherId}/${documentId}.pdf`}, 'application/pdf',
            1, ${"a".repeat(64)}, now(), 'publisher-admin', 'en-US'
          )
        `;
        yield* sql`
          insert into brief_document_versions (
            id, brief_document_id, content_hash, language, canonical_text,
            text_char_count, page_ranges
          ) values (
            ${versionId}, ${documentId}, ${"b".repeat(64)}, 'en-US',
            'Late publisher evidence', 23,
            '[{"pageNumber":1,"charStart":0,"charEnd":23}]'::jsonb
          )
        `;
        yield* sql`
          update brief_documents set current_version_id = ${versionId} where id = ${documentId}
        `;
        const [acceptedMessage] = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${chatId}, 'user', 'Message present at export acceptance')
          returning id::text
        `;
        return { issueId, documentId, versionId, acceptedMessageId: acceptedMessage!.id };
      }),
    );

    let signalSnapshotCaptured!: () => void;
    const snapshotCaptured = new Promise<void>((resolve) => {
      signalSnapshotCaptured = resolve;
    });
    let releaseAcceptance!: () => void;
    const acceptanceReleased = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    const acceptance = runDb(
      isolatedUrl(),
      createExportRequest({
        requesterUserId: "demo-user",
        mfaVerified: true,
        organizationId: null,
        request: {
          scopeKind: "user_chats",
          scopeId: "me",
          idempotencyKey: "export-message-snapshot-race-0001",
        },
        auditSucceeded: Effect.gen(function* () {
          yield* Effect.sync(signalSnapshotCaptured);
          yield* Effect.promise(() => acceptanceReleased);
        }),
      }),
    );
    await snapshotCaptured;

    let lateMessageId: string | undefined;
    let lateInsertError: unknown;
    try {
      lateMessageId = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const [lateMessage] = yield* sql<{ readonly id: string }>`
            insert into chat_messages (chat_id, author, content)
            values (${chatId}, 'assistant', 'Late answer with publisher evidence')
            returning id::text
          `;
          yield* sql`
            insert into assistant_message_sources (
              assistant_message_id, source_key, kind, locator,
              document_version_id, publisher_document_version_id,
              display_label, public_provenance
            ) values (
              ${lateMessage!.id}, 'S1', 'document',
              ${sql.json({
                kind: "document",
                documentVersionId: fixture.versionId,
                contentHash: "b".repeat(64),
                ranges: [{ pageNumber: 1, charStart: 0, charEnd: 23 }],
              })},
              ${fixture.versionId}, ${fixture.versionId}, 'Late publisher evidence',
              ${sql.json({
                citationUrl: `/v1/issues/${fixture.issueId}/documents/${fixture.documentId}/content`,
                documentTitle: "Late publisher evidence",
              })}
            )
          `;
          return lateMessage!.id;
        }),
      );
    } catch (error) {
      lateInsertError = error;
    } finally {
      releaseAcceptance();
    }
    await expect(acceptance).resolves.toMatchObject({ kind: "accepted", duplicate: false });
    if (lateInsertError !== undefined) throw lateInsertError;

    const frozen = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly snapshot: {
            readonly chatMessageIds: string[];
            readonly holdIssueIds: string[];
            readonly holdPublisherCompanyIds: string[];
          };
          readonly holdScopeKeys: string[];
        }>`
          select authorization_snapshot as snapshot,
                 hold_scope_keys as "holdScopeKeys"
          from export_requests
          where idempotency_key = 'export-message-snapshot-race-0001'
        `)[0]!;
      }),
    );
    expect(frozen.snapshot).toMatchObject({
      chatMessageIds: [fixture.acceptedMessageId],
      holdIssueIds: [],
      holdPublisherCompanyIds: [],
    });
    expect(frozen.snapshot.chatMessageIds).not.toContain(lateMessageId);
    expect(frozen.holdScopeKeys).toEqual(
      [`chat:${chatId}`, `client_company:${companyId}`, "user:demo-user"].sort(),
    );
    expect(frozen.holdScopeKeys).not.toContain(`issue:${fixture.issueId}`);
    expect(frozen.holdScopeKeys).not.toContain(`publisher_company:${publisherId}`);
  });

  it("linearizes grant revocation before export authorization snapshot acceptance", async () => {
    await runDb(isolatedUrl(), seedExportAccess);
    const routes = makeExportRoutes(pgLayer());
    let signalHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(hashtext(${`brief:client-members:${companyId}`}))
            `;
            yield* Effect.sync(signalHeld);
            yield* Effect.promise(() => released);
          }),
        );
      }),
    );
    const waitForAdvisoryWaiters = async (expected: number): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const count = await runDb(
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
        if (count >= expected) return;
        await Bun.sleep(5);
      }
      throw new Error(`expected at least ${expected} waiting advisory locks`);
    };

    await held;
    const revocation = runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(hashtext(${`brief:client-members:${companyId}`}))
            `;
            yield* sql`
              update client_employee_subscription_grants
              set revoked_at = now(), revoked_by_user_id = 'demo-user'
              where access_id = ${accessId} and user_id = 'demo-user'
            `;
          }),
        );
      }),
    );
    await waitForAdvisoryWaiters(1);
    const exportResponse = Effect.runPromise(
      routeRequest(
        routes,
        request("POST", "/v1/exports", {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scopeKind: "user_chats",
            scopeId: "me",
            idempotencyKey: "export-revocation-race-0001",
          }),
        }),
      ).pipe(Effect.provide(configLayer)),
    );
    await waitForAdvisoryWaiters(2);
    release();
    await holder;
    await revocation;
    expect((await exportResponse).status).toBe(403);
    const counts = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly exports: number; readonly jobs: number }>`
          select
            (select count(*)::int from export_requests) exports,
            (select count(*)::int from jobs where kind = 'generate_export') jobs
        `)[0]!;
      }),
    );
    expect(counts).toEqual({ exports: 0, jobs: 0 });
  });

  it("linearizes Clerk publisher invitation grants before publisher export acceptance", async () => {
    const inviteeId = "publisher-export-invitee";
    const inviteeEmail = "publisher-export-invitee@example.test";
    const publisherCompanyId = crypto.randomUUID();
    const publisherSubscriptionId = crypto.randomUUID();
    const invitationId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values
            (${inviteeId}, ${inviteeEmail}, 'Publisher invitee', 'clerk-publisher-invitee'),
            ('publisher-export-admin', 'publisher-export-admin@example.test',
             'Publisher export admin', 'clerk-publisher-export-admin')
        `;
        yield* sql`
          insert into publisher_companies (id, name, clerk_organization_id)
          values (${publisherCompanyId}, 'Publisher export race', 'org_publisher_export_race')
        `;
        yield* sql`
          insert into publisher_company_memberships (
            publisher_company_id, user_id, role, accepted_at
          ) values (${publisherCompanyId}, 'publisher-export-admin', 'admin', now())
        `;
        yield* sql`
          insert into publisher_subscriptions (
            id, publisher_company_id, name, created_by_user_id
          ) values (
            ${publisherSubscriptionId}, ${publisherCompanyId}, 'Publisher export source',
            'publisher-export-admin'
          )
        `;
        yield* sql`
          insert into publisher_issues (
            id, subscription_id, title, status, publication_at, published_at,
            created_by_user_id
          ) values (
            ${issueId}, ${publisherSubscriptionId}, 'Publisher export issue', 'published',
            now(), now(), 'publisher-export-admin'
          )
        `;
        yield* sql`
          insert into workspace_invitations (
            id, workspace_kind, publisher_company_id, normalized_email, role,
            publisher_subscription_ids, clerk_invitation_id, state,
            invited_by_user_id, expires_at
          ) values (
            ${invitationId}, 'publisher', ${publisherCompanyId}, ${inviteeEmail}, 'member',
            array[${publisherSubscriptionId}]::uuid[], 'orginv_publisher_export_race', 'pending',
            'publisher-export-admin', ${expiresAt}
          )
        `;
      }),
    );

    let signalHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(
                hashtext(${`brief:publisher-members:${publisherCompanyId}`})
              )
            `;
            yield* Effect.sync(signalHeld);
            yield* Effect.promise(() => released);
          }),
        );
      }),
    );
    const waitForAdvisoryWaiters = async (expected: number): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const count = await runDb(
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
        if (count >= expected) return;
        await Bun.sleep(5);
      }
      throw new Error(`expected at least ${expected} waiting advisory locks`);
    };

    await held;
    const accepted = runDb(
      isolatedUrl(),
      acceptClerkWebhook({
        eventId: "evt_publisher_export_acceptance",
        eventTimestamp: Math.floor(Date.now() / 1_000),
        payloadHash: "a".repeat(64),
        event: {
          type: "organizationInvitation.accepted",
          data: {
            id: "orginv_publisher_export_race",
            user_id: inviteeId,
            organization_id: "org_publisher_export_race",
            email_address: inviteeEmail,
            role: "org:member",
            private_metadata: { briefWorkspaceInvitationId: invitationId },
            expires_at: expiresAt.getTime(),
          },
        } as unknown as WebhookEvent,
      }),
    );
    await waitForAdvisoryWaiters(1);
    const exportAcceptance = runDb(
      isolatedUrl(),
      createExportRequest({
        requesterUserId: inviteeId,
        mfaVerified: true,
        organizationId: "org_publisher_export_race",
        request: {
          scopeKind: "publisher_company",
          scopeId: publisherCompanyId,
          idempotencyKey: "publisher-export-invitation-race-0001",
        },
        auditSucceeded: Effect.void,
      }),
    );
    await waitForAdvisoryWaiters(2);
    release();
    await holder;
    await expect(accepted).resolves.toBe("processed");
    await expect(exportAcceptance).resolves.toMatchObject({ kind: "accepted", duplicate: false });
    const snapshot = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly snapshot: { readonly role: string; readonly issueIds: string[] };
        }>`
          select authorization_snapshot snapshot
          from export_requests
          where idempotency_key = 'publisher-export-invitation-race-0001'
        `)[0]!.snapshot;
      }),
    );
    expect(snapshot).toMatchObject({ role: "member", issueIds: [issueId] });
  });

  it("issues requester-only five-minute export redirects with an exact archive contract", async () => {
    await runDb(isolatedUrl(), seedExportAccess);
    const signedInputs: Parameters<ExportArchiveSigner>[0][] = [];
    const signer: ExportArchiveSigner = async (input) => {
      signedInputs.push(input);
      return "https://private-storage.test/signed-export";
    };
    const routes = makeExportRoutes(pgLayer(), signer);
    const storageConfigLayer = ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: {
          AUTH_MODE: "demo",
          DEMO_USER_ID: "demo-user",
          EXPORT_BUCKET_ENDPOINT: "https://storage.test",
          EXPORT_BUCKET_NAME: "private-exports",
          EXPORT_BUCKET_ACCESS_KEY_ID: "access",
          EXPORT_BUCKET_SECRET_ACCESS_KEY: "secret",
        },
      }),
    );
    const created = await Effect.runPromise(
      routeRequest(
        routes,
        request("POST", "/v1/exports", {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scopeKind: "user_chats",
            scopeId: "me",
            idempotencyKey: "export-download-redirect-0001",
          }),
        }),
      ).pipe(Effect.provide(storageConfigLayer)),
    );
    const createdBody = await jsonBody<{ export: { id: string } }>(created);
    const objectKey = await runDb(isolatedUrl(), completeExportRequest(createdBody.export.id));

    const response = await Effect.runPromise(
      routeRequest(routes, request("GET", `/v1/exports/${createdBody.export.id}/download`)).pipe(
        Effect.provide(storageConfigLayer),
      ),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://private-storage.test/signed-export");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(signedInputs).toEqual([
      expect.objectContaining({
        objectKey,
        fileName: `brief-export-${createdBody.export.id}.tar`,
        expiresInSeconds: 300,
        configuration: expect.objectContaining({
          endpoint: "https://storage.test",
          bucket: "private-exports",
          accessKeyId: "access",
          secretAccessKey: "secret",
        }),
      }),
    ]);

    const otherUserLayer = ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: {
          AUTH_MODE: "demo",
          DEMO_USER_ID: "not-the-requester",
          EXPORT_BUCKET_ENDPOINT: "https://storage.test",
          EXPORT_BUCKET_NAME: "private-exports",
          EXPORT_BUCKET_ACCESS_KEY_ID: "access",
          EXPORT_BUCKET_SECRET_ACCESS_KEY: "secret",
        },
      }),
    );
    const denied = await Effect.runPromise(
      routeRequest(routes, request("GET", `/v1/exports/${createdBody.export.id}/download`)).pipe(
        Effect.provide(otherUserLayer),
      ),
    );
    expect(denied.status).toBe(404);
    expect(signedInputs).toHaveLength(1);

    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update platform_users
          set recovery_deleted_at = now(), purge_after = now() + interval '180 days'
          where id = 'demo-user'
        `;
      }),
    );
    const deletedRequester = await Effect.runPromise(
      routeRequest(routes, request("GET", `/v1/exports/${createdBody.export.id}/download`)).pipe(
        Effect.provide(storageConfigLayer),
      ),
    );
    expect(deletedRequester.status).toBe(404);
    expect(signedInputs).toHaveLength(1);
  });

  it("holds the live requester through export signed capability issuance", async () => {
    await runDb(isolatedUrl(), seedExportAccess);
    let signalSigner!: () => void;
    const signerStarted = new Promise<void>((resolve) => {
      signalSigner = resolve;
    });
    let releaseSigner!: () => void;
    const signerReleased = new Promise<void>((resolve) => {
      releaseSigner = resolve;
    });
    const signer: ExportArchiveSigner = async (input) => {
      expect(input.signal.aborted).toBe(false);
      signalSigner();
      await signerReleased;
      return "https://private-storage.test/signed-export-lease";
    };
    const routes = makeExportRoutes(pgLayer(), signer);
    const storageConfigLayer = ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: {
          AUTH_MODE: "demo",
          DEMO_USER_ID: "demo-user",
          EXPORT_BUCKET_ENDPOINT: "https://storage.test",
          EXPORT_BUCKET_NAME: "private-exports",
          EXPORT_BUCKET_ACCESS_KEY_ID: "access",
          EXPORT_BUCKET_SECRET_ACCESS_KEY: "secret",
        },
      }),
    );
    const created = await Effect.runPromise(
      routeRequest(
        routes,
        request("POST", "/v1/exports", {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scopeKind: "user_chats",
            scopeId: "me",
            idempotencyKey: "export-download-lease-0001",
          }),
        }),
      ).pipe(Effect.provide(storageConfigLayer)),
    );
    const createdBody = await jsonBody<{ export: { id: string } }>(created);
    await runDb(isolatedUrl(), completeExportRequest(createdBody.export.id));
    const download = Effect.runPromise(
      routeRequest(routes, request("GET", `/v1/exports/${createdBody.export.id}/download`)).pipe(
        Effect.provide(storageConfigLayer),
      ),
    );
    await signerStarted;
    let deletionFinished = false;
    const deletion = Effect.runPromise(
      acceptClerkWebhook({
        eventId: "evt_export_requester_deleted",
        eventTimestamp: Math.floor(Date.now() / 1_000),
        payloadHash: "f".repeat(64),
        event: {
          type: "user.deleted",
          data: { id: "clerk-demo", deleted: true },
        } as unknown as WebhookEvent,
      }).pipe(
        Effect.provide(
          PgClient.layer({
            url: Redacted.make(isolatedUrl()),
            applicationName: "brief-export-requester-deletion-race",
          }),
        ),
      ),
    ).then((result) => {
      deletionFinished = true;
      return result;
    });
    let waiting = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      waiting = await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ readonly waiting: boolean }>`
            select exists(
              select 1 from pg_stat_activity
              where datname = current_database()
                and application_name = 'brief-export-requester-deletion-race'
                and wait_event_type = 'Lock'
            ) as waiting
          `)[0]!.waiting;
        }),
      );
      if (waiting) break;
      await Bun.sleep(5);
    }
    expect(waiting).toBe(true);
    expect(deletionFinished).toBe(false);
    releaseSigner();
    const response = await download;
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://private-storage.test/signed-export-lease",
    );
    await expect(deletion).resolves.toBe("processed");
  });

  it("derives descriptor and download expiry from the PostgreSQL clock", async () => {
    await runDb(isolatedUrl(), seedExportAccess);
    let signed = false;
    const routes = makeExportRoutes(pgLayer(), async () => {
      signed = true;
      return "https://private-storage.test/unexpected";
    });
    const storageConfigLayer = ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: {
          AUTH_MODE: "demo",
          DEMO_USER_ID: "demo-user",
          EXPORT_BUCKET_ENDPOINT: "https://storage.test",
          EXPORT_BUCKET_NAME: "private-exports",
          EXPORT_BUCKET_ACCESS_KEY_ID: "access",
          EXPORT_BUCKET_SECRET_ACCESS_KEY: "secret",
        },
      }),
    );
    const created = await Effect.runPromise(
      routeRequest(
        routes,
        request("POST", "/v1/exports", {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scopeKind: "user_chats",
            scopeId: "me",
            idempotencyKey: "export-database-clock-expiry-0001",
          }),
        }),
      ).pipe(Effect.provide(storageConfigLayer)),
    );
    const createdBody = await jsonBody<{ export: { id: string } }>(created);
    await runDb(isolatedUrl(), completeExportRequest(createdBody.export.id, 1));
    await Bun.sleep(5);

    const descriptorResponse = await Effect.runPromise(
      routeRequest(routes, request("GET", `/v1/exports/${createdBody.export.id}`)).pipe(
        Effect.provide(storageConfigLayer),
      ),
    );
    const descriptor = await jsonBody<{ export: { downloadPath: string | null } }>(
      descriptorResponse,
    );
    expect(descriptor.export.downloadPath).toBeNull();
    const download = await Effect.runPromise(
      routeRequest(routes, request("GET", `/v1/exports/${createdBody.export.id}/download`)).pipe(
        Effect.provide(storageConfigLayer),
      ),
    );
    expect(download.status).toBe(404);
    expect(signed).toBe(false);
  });

  it("rolls back administrative state and jobs when a success audit fails", async () => {
    const chatId = await runDb(isolatedUrl(), seedExportAccess);
    const issueId = crypto.randomUUID();
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into platform_admins (user_id, role)
          values ('demo-user', 'admin'), ('support-actor', 'support')
        `;
        yield* sql`
          insert into publisher_issues (
            id, subscription_id, title, status, publication_at, published_at,
            created_by_user_id
          ) values (
            ${issueId}, ${subscriptionId}, 'Atomic restriction', 'published', now(), now(),
            'publisher-admin'
          )
        `;
      }),
    );
    const injectedAuditFailure = () => Effect.fail(new Error("injected_audit_failure"));

    await expect(
      runDb(
        isolatedUrl(),
        createExportRequest({
          requesterUserId: "demo-user",
          mfaVerified: true,
          organizationId: null,
          request: {
            scopeKind: "user_chats",
            scopeId: "me",
            idempotencyKey: "audit-rollback-export-0001",
          },
          auditSucceeded: injectedAuditFailure(),
        }),
      ),
    ).rejects.toThrow("injected_audit_failure");

    await expect(
      runDb(
        isolatedUrl(),
        changeIssueRestriction({
          issueId,
          actorUserId: "demo-user",
          reason: "Atomic audit rollback fixture",
          restrict: true,
          auditSucceeded: injectedAuditFailure(),
        }),
      ),
    ).rejects.toThrow("injected_audit_failure");

    const grantRequest = {
      actorUserId: "support-actor",
      reason: "Atomic grant audit rollback fixture",
      scopeKind: "client_chat" as const,
      scopeId: chatId,
      publisherCompanyId: null,
      clientCompanyId: companyId,
      affectedUserId: "demo-user",
      customerApprovalReference: null,
      approvalSkippedReason: "Security incident",
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    };
    await expect(
      runDb(
        isolatedUrl(),
        createRestrictedSupportGrant({
          request: grantRequest,
          approvalReference: null,
          approvalSkippedReason: "Security incident",
          grantedByUserId: "demo-user",
          expiresAt: new Date(grantRequest.expiresAt),
          auditSucceeded: injectedAuditFailure(),
        }),
      ),
    ).rejects.toThrow("injected_audit_failure");

    const { accessLogId } = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const grantId = yield* createRestrictedSupportGrant({
          request: { ...grantRequest, reason: "Independent review rollback fixture" },
          approvalReference: null,
          approvalSkippedReason: "Security incident",
          grantedByUserId: "demo-user",
          expiresAt: new Date(grantRequest.expiresAt),
          auditSucceeded: Effect.void,
        });
        const access = yield* sql<{ readonly id: string }>`
          insert into restricted_support_access_log (
            grant_id, actor_user_id, reason, scope_kind, scope_id,
            publisher_company_id, client_company_id, affected_user_id,
            customer_approval_reference, approval_skipped_reason
          )
          select id, actor_user_id, reason, scope_kind, scope_id,
                 publisher_company_id, client_company_id, affected_user_id,
                 customer_approval_reference, approval_skipped_reason
          from restricted_support_grants where id = ${grantId}
          returning id::text
        `;
        return { accessLogId: access[0]!.id };
      }),
    );
    await expect(
      runDb(
        isolatedUrl(),
        createRestrictedSupportReview({
          accessLogId,
          reviewerUserId: "demo-user",
          decision: "approved",
          notes: "Independent review notes",
          auditSucceeded: injectedAuditFailure(),
        }),
      ),
    ).rejects.toThrow("injected_audit_failure");

    const state = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly exports: number;
          readonly jobs: number;
          readonly restricted: boolean;
          readonly failedGrants: number;
          readonly reviews: number;
        }>`
          select
            (select count(*)::int from export_requests
             where idempotency_key = 'audit-rollback-export-0001') as exports,
            (select count(*)::int from jobs where kind = 'generate_export') as jobs,
            (select restricted_at is not null from publisher_issues where id = ${issueId})
              as restricted,
            (select count(*)::int from restricted_support_grants
             where reason = 'Atomic grant audit rollback fixture') as "failedGrants",
            (select count(*)::int from restricted_support_access_reviews
             where access_log_id = ${accessLogId}) as reviews
        `)[0]!;
      }),
    );
    expect(state).toEqual({
      exports: 0,
      jobs: 0,
      restricted: false,
      failedGrants: 0,
      reviews: 0,
    });
  });
});
