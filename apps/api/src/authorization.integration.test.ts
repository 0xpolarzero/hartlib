import { PgClient } from "@effect/sql-pg";
import { createExportRequest } from "@brief/backend-domain/exports";
import { createUserMessageAndRun } from "@brief/backend-domain/chat-runtime";
import {
  selectAuthorizedPublisherDocument,
  withAuthorizedPublisherDocumentLease,
} from "@brief/backend-domain/publisher-documents";
import { listProductChats, mutateProductChat } from "@brief/backend-domain/product-chats";
import { recordRestrictedSupportAccess } from "@brief/backend-domain/platform-support";
import {
  requireChatAccess,
  requireClientCompanyAdmin,
  requireClientCompanyMembership,
  requirePublisherCompanyAdmin,
  requirePublisherCompanyMembership,
  requirePublisherSubscriptionAccess,
  getClientWebPolicy,
  getPublisherIssue,
  listClientSubscriptionAccesses,
  listPublisherIssues,
  markClientNotificationRead,
  requireClientCompanyAdmin as workspaceRequireClientCompanyAdmin,
  requireClientCompanyMembership as workspaceRequireClientCompanyMembership,
  requirePublisherCompanyAdmin as workspaceRequirePublisherCompanyAdmin,
  requirePublisherCompanyMembership as workspaceRequirePublisherCompanyMembership,
  requirePublisherSubscriptionAccess as workspaceRequirePublisherSubscriptionAccess,
  updateClientWebPolicy,
} from "@brief/workspace";
import { ConfigProvider, Effect, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RequestIdentity } from "./auth";
import { routeRequest } from "./http";
import { makeProductChatRoutes } from "./domain/product-chats";
import { makeChatRoutes } from "./domain/chat";
import { makeClientWorkspaceRoutes } from "./domain/client-workspace";
import { makePlatformSupportRoutes } from "./domain/platform-support";
import { makePublisherDocumentContentRoute } from "./domain/publisher-documents";

const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const migrationsUrl = new URL("../../../db/migrations/", import.meta.url);
const isolatedDatabaseName = `brief_authorization_test_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

const databaseUrlFor = (name: string): string => {
  if (databaseUrl === undefined) throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

const runDb = <A, E>(url: string, effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName: "brief-authorization-integration-test",
        }),
      ),
    ),
  );

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const runMigrations = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const files = [...new Bun.Glob("*.sql").scanSync({ cwd: migrationsUrl.pathname })].sort();
  for (const file of files) {
    const body = yield* Effect.promise(() => Bun.file(new URL(file, migrationsUrl)).text());
    yield* sql.unsafe(body).raw;
  }
});

const identity = (
  userId: string,
  mfaVerified = true,
  organizationId: string | null = null,
): RequestIdentity => ({
  userId,
  organizationId,
  sessionId: `session:${userId}`,
  mfaVerified,
  mode: "clerk",
});

const runProductRoute = async (
  userId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> => {
  const url = databaseUrlFor(isolatedDatabaseName);
  const pgLayer = PgClient.layer({
    url: Redacted.make(url),
    applicationName: "brief-product-chat-route-test",
  });
  const routes = makeProductChatRoutes(pgLayer);
  const request = new Request(`https://brief.test${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  return Effect.runPromise(
    routeRequest(routes, request).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { NODE_ENV: "test", AUTH_MODE: "demo", DEMO_USER_ID: userId },
          }),
        ),
      ),
    ),
  );
};

const runPlatformRoute = async (
  userId: string,
  method: string,
  path: string,
  body?: unknown,
  auditIdentity?: { requestId: string | null },
): Promise<Response> => {
  const url = databaseUrlFor(isolatedDatabaseName);
  const pgLayer = PgClient.layer({
    url: Redacted.make(url),
    applicationName: "brief-platform-support-route-test",
  });
  const routes = makePlatformSupportRoutes(
    pgLayer,
    async () => "https://private-storage.test/restricted",
  );
  const request = new Request(`https://brief.test${path}`, {
    method,
    headers: {
      "x-request-id": crypto.randomUUID(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await Effect.runPromise(
    routeRequest(routes, request).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { NODE_ENV: "test", AUTH_MODE: "demo", DEMO_USER_ID: userId },
          }),
        ),
      ),
    ),
  );
  if (auditIdentity !== undefined) {
    auditIdentity.requestId = request.headers.get("x-request-id");
  }
  return response;
};

interface Fixture {
  readonly clientCompanyId: string;
  readonly publisherCompanyId: string;
  readonly subscriptionId: string;
  readonly accessId: string;
  readonly issueId: string;
  readonly documentId: string;
  readonly ownerPrivateChatId: string;
  readonly sharedChatId: string;
  readonly supportGrantId: string;
}

let fixture: Fixture;

describe.skipIf(databaseUrl === undefined)("canonical product authorization", () => {
  beforeAll(async () => {
    const adminUrl = databaseUrlFor("postgres");
    await runDb(
      adminUrl,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(`create database ${quoteIdentifier(isolatedDatabaseName)}`).raw;
      }),
    );
    const url = databaseUrlFor(isolatedDatabaseName);
    await runDb(url, runMigrations);
    fixture = await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const ids = {
          clientCompanyId: crypto.randomUUID(),
          publisherCompanyId: crypto.randomUUID(),
          subscriptionId: crypto.randomUUID(),
          accessId: crypto.randomUUID(),
          issueId: crypto.randomUUID(),
          documentId: crypto.randomUUID(),
          ownerPrivateChatId: crypto.randomUUID(),
          sharedChatId: crypto.randomUUID(),
          supportGrantId: crypto.randomUUID(),
        };
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values
            ('owner', 'owner@example.test', 'Owner', 'clerk_owner'),
            ('viewer', 'viewer@example.test', 'Viewer', 'clerk_viewer'),
            ('never-recipient', 'never-recipient@example.test', 'Never Recipient', 'clerk_never_recipient'),
            ('publisher-admin', 'publisher@example.test', 'Publisher Admin', 'clerk_publisher'),
            ('lifecycle-owner', 'lifecycle@example.test', 'Lifecycle Owner', 'clerk_lifecycle'),
            ('support-user', 'support@example.test', 'Support User', 'clerk_support'),
            ('security-user', 'security@example.test', 'Security User', 'clerk_security'),
            ('legal-user', 'legal@example.test', 'Legal User', 'clerk_legal')
        `;
        yield* sql`
          insert into client_companies (id, name) values (${ids.clientCompanyId}, 'Client')
        `;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values
            (${ids.clientCompanyId}, 'owner', 'admin'),
            (${ids.clientCompanyId}, 'viewer', 'member')
        `;
        yield* sql`
          insert into publisher_companies (id, name)
          values (${ids.publisherCompanyId}, 'Publisher')
        `;
        yield* sql`
          insert into publisher_company_memberships (
            publisher_company_id, user_id, role, accepted_at
          ) values (${ids.publisherCompanyId}, 'publisher-admin', 'admin', now())
        `;
        yield* sql`
          insert into publisher_subscriptions (
            id, publisher_company_id, name, created_by_user_id
          ) values (
            ${ids.subscriptionId}, ${ids.publisherCompanyId}, 'Source', 'publisher-admin'
          )
        `;
        yield* sql`
          insert into client_subscription_accesses (
            id, subscription_id, client_company_id, state, first_admin_email,
            accepted_at, subscribed_at, created_by_user_id
          ) values (
            ${ids.accessId}, ${ids.subscriptionId}, ${ids.clientCompanyId}, 'active',
            'admin@example.test', now(), now(), 'publisher-admin'
          )
        `;
        yield* sql`
          insert into client_employee_subscription_grants (
            access_id, client_company_id, user_id, granted_by_user_id
          ) values
            (${ids.accessId}, ${ids.clientCompanyId}, 'owner', 'owner'),
            (${ids.accessId}, ${ids.clientCompanyId}, 'viewer', 'owner')
        `;
        yield* sql`
          insert into publisher_issues (
            id, subscription_id, title, status, created_by_user_id
          ) values (${ids.issueId}, ${ids.subscriptionId}, 'Issue', 'draft', 'publisher-admin')
        `;
        yield* sql`
          insert into brief_documents (
            id, issue_id, title, original_file_name, object_key, media_type,
            byte_size, sha256_hex, upload_completed_at, created_by_user_id
          ) values (
            ${ids.documentId}, ${ids.issueId}, 'Brief', 'brief.pdf', ${`issues/${ids.issueId}/brief.pdf`},
            'application/pdf', 4, ${"a".repeat(64)}, now(), 'publisher-admin'
          )
        `;
        yield* sql`
          update publisher_issues
          set status = 'published', publication_at = now()
          where id = ${ids.issueId}
        `;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into issue_deliveries (
                issue_id, subscription_id, access_id, client_company_id, historical
              ) values (
                ${ids.issueId}, ${ids.subscriptionId}, ${ids.accessId}, ${ids.clientCompanyId}, false
              )
            `;
            yield* sql`
              insert into issue_delivery_recipients (
                issue_id, client_company_id, user_id, delivered_at
              )
              select delivery.issue_id, delivery.client_company_id, recipients.user_id,
                     delivery.delivered_at
              from issue_deliveries delivery
              cross join (values ('owner'::text), ('viewer'::text)) recipients(user_id)
              where delivery.issue_id = ${ids.issueId}
                and delivery.client_company_id = ${ids.clientCompanyId}
            `;
          }),
        );
        yield* sql`
          insert into chats (id, user_id, company_id, memory_mode)
          values
            (${ids.ownerPrivateChatId}, 'owner', ${ids.clientCompanyId}, 'private_owner'),
            (${ids.sharedChatId}, 'owner', ${ids.clientCompanyId}, 'disabled')
        `;
        yield* sql`
          insert into chat_subscription_sources (
            chat_id, access_id, client_company_id, subscription_id
          ) values
            (${ids.ownerPrivateChatId}, ${ids.accessId}, ${ids.clientCompanyId}, ${ids.subscriptionId}),
            (${ids.sharedChatId}, ${ids.accessId}, ${ids.clientCompanyId}, ${ids.subscriptionId})
        `;
        yield* sql`update chats set shared_at = now() where id = ${ids.sharedChatId}`;
        yield* sql`
          insert into platform_admins (user_id, role)
          values
            ('support-user', 'support'),
            ('security-user', 'security'),
            ('legal-user', 'legal')
        `;
        yield* sql`
          insert into restricted_support_grants (
            id, actor_user_id, reason, scope_kind, scope_id, client_company_id,
            affected_user_id, approval_skipped_reason, granted_by_user_id, expires_at
          ) values (
            ${ids.supportGrantId}, 'support-user', 'Investigate requested chat issue',
            'client_chat', ${ids.sharedChatId}, ${ids.clientCompanyId}, 'owner',
            'Security incident requires prompt access', 'security-user', now() + interval '1 hour'
          )
        `;
        return ids;
      }),
    );
  }, 30_000);

  afterAll(async () => {
    if (databaseUrl === undefined) return;
    const adminUrl = databaseUrlFor("postgres");
    await runDb(
      adminUrl,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${isolatedDatabaseName}`;
        yield* sql.unsafe(`drop database if exists ${quoteIdentifier(isolatedDatabaseName)}`).raw;
      }),
    );
  });

  it("enforces company admin role and MFA", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    await expect(
      runDb(url, requireClientCompanyAdmin(identity("owner"), fixture.clientCompanyId)),
    ).resolves.toBeUndefined();
    await expect(
      runDb(url, requireClientCompanyAdmin(identity("owner", false), fixture.clientCompanyId)),
    ).rejects.toMatchObject({ code: "mfa_required" });
    await expect(
      runDb(url, requireClientCompanyAdmin(identity("viewer"), fixture.clientCompanyId)),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects a wrong active Clerk organization across chat, exports, and workspace helpers", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_companies
          set clerk_organization_id = 'org_client'
          where id = ${fixture.clientCompanyId}
        `;
        yield* sql`
          update publisher_companies
          set clerk_organization_id = 'org_publisher'
          where id = ${fixture.publisherCompanyId}
        `;
      }),
    );

    const wrongClient = identity("owner", true, "org_publisher");
    const correctClient = identity("owner", true, "org_client");
    const wrongPublisher = identity("publisher-admin", true, "org_client");
    const correctPublisher = identity("publisher-admin", true, "org_publisher");

    await expect(
      runDb(url, requireClientCompanyMembership(wrongClient, fixture.clientCompanyId)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      runDb(url, requireClientCompanyAdmin(wrongClient, fixture.clientCompanyId)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      runDb(url, requireClientCompanyMembership(correctClient, fixture.clientCompanyId)),
    ).resolves.toBeUndefined();
    await expect(
      runDb(url, requireClientCompanyAdmin(correctClient, fixture.clientCompanyId)),
    ).resolves.toBeUndefined();

    await expect(
      runDb(url, requirePublisherCompanyMembership(wrongPublisher, fixture.publisherCompanyId)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      runDb(url, requirePublisherCompanyAdmin(wrongPublisher, fixture.publisherCompanyId)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      runDb(
        url,
        requirePublisherSubscriptionAccess(wrongPublisher, fixture.subscriptionId, "read"),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      runDb(url, requirePublisherCompanyMembership(correctPublisher, fixture.publisherCompanyId)),
    ).resolves.toBeUndefined();
    await expect(
      runDb(url, requirePublisherCompanyAdmin(correctPublisher, fixture.publisherCompanyId)),
    ).resolves.toBeUndefined();
    await expect(
      runDb(
        url,
        requirePublisherSubscriptionAccess(correctPublisher, fixture.subscriptionId, "read"),
      ),
    ).resolves.toBeUndefined();

    await expect(
      runDb(url, workspaceRequireClientCompanyMembership(wrongClient, fixture.clientCompanyId)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      runDb(url, workspaceRequireClientCompanyAdmin(wrongClient, fixture.clientCompanyId)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      runDb(
        url,
        workspaceRequirePublisherCompanyMembership(wrongPublisher, fixture.publisherCompanyId),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      runDb(url, workspaceRequirePublisherCompanyAdmin(wrongPublisher, fixture.publisherCompanyId)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      runDb(
        url,
        workspaceRequirePublisherSubscriptionAccess(wrongPublisher, fixture.subscriptionId, "read"),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });

    await expect(
      runDb(
        url,
        createUserMessageAndRun(
          "owner",
          {
            text: "must reject wrong active organization",
            locale: "en-US",
            market: "US",
            webSearchEnabled: false,
          },
          {
            authMode: "clerk",
            webResearchProvider: null,
            aiWebMaxDomainFilters: 10,
            aiProviderServiceId: "zai_coding_plan_official",
            aiProviderEndpointIdentity:
              "zai_coding_plan_official:https://api.z.ai/api/coding/paas/v4",
          },
          "org_publisher",
          fixture.ownerPrivateChatId,
        ),
      ),
    ).resolves.toEqual({ kind: "forbidden" });

    await expect(
      runDb(
        url,
        createExportRequest({
          requesterUserId: "publisher-admin",
          mfaVerified: true,
          organizationId: "org_client",
          request: {
            scopeKind: "publisher_company",
            scopeId: fixture.publisherCompanyId,
            idempotencyKey: "wrong-org-publisher-export-0001",
          },
          auditSucceeded: Effect.void,
        }),
      ),
    ).rejects.toThrow("export_forbidden");
    await expect(
      runDb(
        url,
        createExportRequest({
          requesterUserId: "owner",
          mfaVerified: true,
          organizationId: "org_publisher",
          request: {
            scopeKind: "client_company",
            scopeId: fixture.clientCompanyId,
            idempotencyKey: "wrong-org-client-export-0001",
          },
          auditSucceeded: Effect.void,
        }),
      ),
    ).rejects.toThrow("export_forbidden");

    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_companies
          set clerk_organization_id = null
          where id = ${fixture.clientCompanyId}
        `;
        yield* sql`
          update publisher_companies
          set clerk_organization_id = null
          where id = ${fixture.publisherCompanyId}
        `;
      }),
    );
  });

  it("denies every client membership helper and workspace read or mutation for deleted companies", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    const clientRoutes = makeClientWorkspaceRoutes(
      PgClient.layer({
        url: Redacted.make(url),
        applicationName: "brief-client-lifecycle-route-test",
      }),
    );
    const callClientRoute = (method: string, path: string, body?: unknown) =>
      Effect.runPromise(
        routeRequest(
          clientRoutes,
          new Request(`https://brief.test${path}`, {
            method,
            headers: {
              "x-request-id": crypto.randomUUID(),
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        ).pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  NODE_ENV: "test",
                  AUTH_MODE: "demo",
                  DEMO_USER_ID: "owner",
                  TINYFISH_API_KEY: "test-key",
                  AI_WEB_MAX_DOMAIN_FILTERS: "2",
                },
              }),
            ),
          ),
        ),
      );
    for (const lifecycle of ["recovery_deleted", "purged"] as const) {
      const companyId = crypto.randomUUID();
      const accessId = crypto.randomUUID();
      const organizationId = `org_${lifecycle}_${crypto.randomUUID()}`;
      await runDb(
        url,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into client_companies (id, name, clerk_organization_id)
            values (${companyId}, ${`Lifecycle ${lifecycle}`}, ${organizationId})
          `;
          yield* sql`
            insert into client_company_memberships (company_id, user_id, role)
            values (${companyId}, 'owner', 'admin')
          `;
          yield* sql`
            insert into client_subscription_accesses (
              id, subscription_id, client_company_id, state, first_admin_email,
              accepted_at, subscribed_at, created_by_user_id
            ) values (
              ${accessId}, ${fixture.subscriptionId}, ${companyId}, 'active',
              'owner@example.test', now(), now(), 'owner'
            )
          `;
          yield* sql`
            insert into client_employee_subscription_grants (
              access_id, client_company_id, user_id, granted_by_user_id
            ) values (${accessId}, ${companyId}, 'owner', 'owner')
          `;
          yield* sql`
            insert into client_company_ai_settings (
              company_id, web_search_enabled, web_domain_allowlist
            ) values (${companyId}, true, array['example.com']::text[])
          `;
          yield* sql`
            update client_companies
            set recovery_deleted_at = now() - interval '181 days',
                purge_after = now() - interval '1 day',
                purged_at = ${lifecycle === "purged" ? new Date() : null}
            where id = ${companyId}
          `;
        }),
      );

      const activeIdentity = identity("owner", true, organizationId);
      const deniedOperations: ReadonlyArray<() => Promise<unknown>> = [
        () => runDb(url, requireClientCompanyMembership(activeIdentity, companyId)),
        () => runDb(url, requireClientCompanyAdmin(activeIdentity, companyId)),
        () => runDb(url, workspaceRequireClientCompanyMembership(activeIdentity, companyId)),
        () => runDb(url, workspaceRequireClientCompanyAdmin(activeIdentity, companyId)),
        () => runDb(url, listClientSubscriptionAccesses(activeIdentity, companyId)),
        () => runDb(url, getClientWebPolicy(activeIdentity, companyId)),
        () =>
          runDb(
            url,
            updateClientWebPolicy({
              identity: activeIdentity,
              companyId,
              enabled: false,
              allowedDomains: null,
              deploymentAvailable: true,
              requestId: crypto.randomUUID(),
            }),
          ),
      ];
      for (const operation of deniedOperations) {
        await expect(operation()).rejects.toMatchObject({ code: "forbidden" });
      }
      await expect(
        callClientRoute("GET", `/v1/client-companies/${companyId}/subscription-accesses`),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        callClientRoute("GET", `/v1/client-companies/${companyId}/web-policy`),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        callClientRoute("PUT", `/v1/client-companies/${companyId}/web-policy`, {
          enabled: false,
          allowedDomains: null,
        }),
      ).resolves.toMatchObject({ status: 404 });
      const settings = await runDb(
        url,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly enabled: boolean;
            readonly domains: readonly string[] | null;
          }>`
            select web_search_enabled as enabled, web_domain_allowlist as domains
            from client_company_ai_settings where company_id = ${companyId}
          `)[0]!;
        }),
      );
      expect(settings).toEqual({ enabled: true, domains: ["example.com"] });
      await runDb(
        url,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`set local brief.allow_account_purge = 'on'`;
              yield* sql`
                delete from client_employee_subscription_grants
                where client_company_id = ${companyId}
              `;
              yield* sql`
                delete from client_subscription_accesses
                where client_company_id = ${companyId}
              `;
              yield* sql`
                delete from client_company_memberships where company_id = ${companyId}
              `;
              yield* sql`delete from client_companies where id = ${companyId}`;
            }),
          );
        }),
      );
    }
  });

  it("keeps a notification unread under the wrong active organization", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    const companyId = crypto.randomUUID();
    const organizationId = `org_notification_${crypto.randomUUID()}`;
    const notificationId = await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into client_companies (id, name, clerk_organization_id)
          values (${companyId}, 'Notification organization', ${organizationId})
        `;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values (${companyId}, 'owner', 'admin')
        `;
        const rows = yield* sql<{ readonly id: string }>`
          insert into platform_notifications (
            client_company_id, user_id, kind, deduplication_key
          ) values (
            ${companyId}, 'owner', 'usage_limit_reached', ${`notification-${crypto.randomUUID()}`}
          ) returning id::text
        `;
        return rows[0]!.id;
      }),
    );

    await expect(
      runDb(
        url,
        markClientNotificationRead(
          identity("owner", true, `org_wrong_${crypto.randomUUID()}`),
          notificationId,
        ),
      ),
    ).resolves.toBeNull();
    const unread = await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly readAt: Date | null }>`
          select read_at as "readAt" from platform_notifications where id = ${notificationId}
        `)[0]!.readAt;
      }),
    );
    expect(unread).toBeNull();

    await expect(
      runDb(
        url,
        markClientNotificationRead(identity("owner", true, organizationId), notificationId),
      ),
    ).resolves.toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    const readAt = await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly readAt: Date | null }>`
          select read_at as "readAt" from platform_notifications where id = ${notificationId}
        `)[0]!.readAt;
      }),
    );
    expect(readAt).toBeInstanceOf(Date);
    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`set local brief.allow_account_purge = 'on'`;
            yield* sql`delete from platform_notifications where client_company_id = ${companyId}`;
            yield* sql`delete from client_company_memberships where company_id = ${companyId}`;
            yield* sql`delete from client_companies where id = ${companyId}`;
          }),
        );
      }),
    );
  });

  it("keeps private chats owner-only and shared chats source-authorized", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    await expect(
      runDb(url, requireChatAccess(identity("owner"), fixture.ownerPrivateChatId, "read")),
    ).resolves.toBeUndefined();
    await expect(
      runDb(url, requireChatAccess(identity("viewer"), fixture.ownerPrivateChatId, "read")),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      runDb(url, requireChatAccess(identity("viewer"), fixture.sharedChatId, "read")),
    ).resolves.toBeUndefined();

    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_employee_subscription_grants
          set revoked_at = now(), revoked_by_user_id = 'owner'
          where access_id = ${fixture.accessId} and user_id = 'viewer'
        `;
      }),
    );
    await expect(
      runDb(url, requireChatAccess(identity("viewer"), fixture.sharedChatId, "read")),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("resolves a shared chat policy from the authorized viewer company after creator revocation", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values ('unauthorized-viewer', 'unauthorized-viewer@example.test', 'Unauthorized Viewer', 'clerk-unauthorized-viewer')
          on conflict (id) do nothing
        `;
        yield* sql`
          insert into client_company_ai_settings (company_id, web_search_enabled, web_domain_allowlist)
          values (${fixture.clientCompanyId}, true, null)
          on conflict (company_id) do update set
            web_search_enabled = excluded.web_search_enabled,
            web_domain_allowlist = excluded.web_domain_allowlist
        `;
        yield* sql`
          update client_company_memberships
          set role = 'admin'
          where company_id = ${fixture.clientCompanyId} and user_id = 'viewer'
        `;
        yield* sql`
          update client_employee_subscription_grants
          set revoked_at = null, revoked_by_user_id = null
          where client_company_id = ${fixture.clientCompanyId} and user_id = 'viewer'
        `;
        yield* sql`
          update client_company_memberships
          set revoked_at = now(), revoked_by_user_id = 'owner'
          where company_id = ${fixture.clientCompanyId} and user_id = 'owner'
        `;
      }),
    );

    const chatLayer = PgClient.layer({
      url: Redacted.make(url),
      applicationName: "brief-shared-chat-policy-test",
    });
    const readAs = (userId: string) =>
      Effect.runPromise(
        routeRequest(
          makeChatRoutes(chatLayer),
          new Request(`https://brief.test/v1/chats/${fixture.sharedChatId}`),
        ).pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  NODE_ENV: "test",
                  AUTH_MODE: "demo",
                  DEMO_USER_ID: userId,
                  TINYFISH_API_KEY: "tinyfish-test",
                  AI_WEB_MAX_DOMAIN_FILTERS: "2",
                },
              }),
            ),
          ),
        ),
      );

    try {
      const authorizedViewer = await readAs("viewer");
      expect(authorizedViewer.status).toBe(200);
      const authorizedViewerBody = await authorizedViewer.json();
      expect(authorizedViewerBody).toMatchObject({
        effectiveWebPolicy: { enabled: true, provider: "tinyfish", allowedDomains: null },
        canWrite: false,
      });

      const unauthorizedViewer = await readAs("unauthorized-viewer");
      expect(unauthorizedViewer.status).toBe(404);
    } finally {
      await runDb(
        url,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update client_company_memberships
            set revoked_at = null, revoked_by_user_id = null
            where company_id = ${fixture.clientCompanyId} and user_id = 'owner'
          `;
          yield* sql`
            update client_company_memberships
            set role = 'member'
            where company_id = ${fixture.clientCompanyId} and user_id = 'viewer'
          `;
          yield* sql`
            update client_company_ai_settings
            set web_search_enabled = false, web_domain_allowlist = null
            where company_id = ${fixture.clientCompanyId}
          `;
        }),
      );
    }
  });

  it("records scoped support access only with MFA and an active exact grant", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    await expect(
      runDb(
        url,
        recordRestrictedSupportAccess(identity("support-user", false), {
          grantId: fixture.supportGrantId,
          scopeKind: "client_chat",
          scopeId: fixture.sharedChatId,
        }),
      ),
    ).rejects.toMatchObject({ code: "mfa_required" });
    const logId = await runDb(
      url,
      recordRestrictedSupportAccess(identity("support-user"), {
        grantId: fixture.supportGrantId,
        scopeKind: "client_chat",
        scopeId: fixture.sharedChatId,
      }),
    );
    expect(logId).toMatch(/^[1-9]\d*$/u);
    await expect(
      runDb(
        url,
        recordRestrictedSupportAccess(identity("support-user"), {
          grantId: fixture.supportGrantId,
          scopeKind: "client_chat",
          scopeId: fixture.ownerPrivateChatId,
        }),
      ),
    ).rejects.toMatchObject({ code: "support_grant_required" });
  });

  it("makes support logs tamper-resistant", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    const logId = await runDb(
      url,
      recordRestrictedSupportAccess(identity("support-user"), {
        grantId: fixture.supportGrantId,
        scopeKind: "client_chat",
        scopeId: fixture.sharedChatId,
      }),
    );
    await expect(
      runDb(
        url,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update restricted_support_access_log
            set reason = 'changed'
            where id = ${logId}
          `;
        }),
      ),
    ).rejects.toThrow();
  });

  it("prevents deleting the last client admin", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    await expect(
      runDb(
        url,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update client_company_memberships set role = 'member'
            where company_id = ${fixture.clientCompanyId} and user_id = 'owner'
          `;
        }),
      ),
    ).rejects.toThrow();
  });

  it("creates source-scoped chats, shares only disabled-memory chats, and deletes immediately", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_employee_subscription_grants
          set revoked_at = null, revoked_by_user_id = null
          where access_id = ${fixture.accessId} and user_id = 'viewer'
        `;
      }),
    );

    const createdResponse = await runProductRoute("owner", "POST", "/v1/chats", {
      companyId: fixture.clientCompanyId,
      memoryMode: "disabled",
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      readonly chat: { readonly id: string; readonly sourceAccessIds: readonly string[] };
    };
    expect(created.chat.sourceAccessIds).toEqual([fixture.accessId]);

    const shareResponse = await runProductRoute(
      "owner",
      "POST",
      `/v1/chats/${created.chat.id}/share`,
    );
    expect(shareResponse.status).toBe(200);
    const sharedList = await runProductRoute("viewer", "GET", "/v1/chats?view=shared");
    const shared = (await sharedList.json()) as { readonly chats: readonly ChatListFixture[] };
    expect(shared.chats.map((chat) => chat.id)).toContain(created.chat.id);

    const deleteResponse = await runProductRoute("owner", "DELETE", `/v1/chats/${created.chat.id}`);
    expect(deleteResponse.status).toBe(204);
    const ownerList = await runProductRoute("owner", "GET", "/v1/chats?view=mine");
    const remaining = (await ownerList.json()) as { readonly chats: readonly ChatListFixture[] };
    expect(remaining.chats.map((chat) => chat.id)).not.toContain(created.chat.id);

    const privateCreate = await runProductRoute("owner", "POST", "/v1/chats", {
      companyId: fixture.clientCompanyId,
      memoryMode: "private_owner",
      sourceAccessIds: [fixture.accessId],
    });
    const privateChat = (await privateCreate.json()) as { readonly chat: { readonly id: string } };
    const refusedShare = await runProductRoute(
      "owner",
      "POST",
      `/v1/chats/${privateChat.chat.id}/share`,
    );
    expect(refusedShare.status).toBe(403);
  });

  it("lets a creator retract a chat after source revocation without re-exposing it", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values (${fixture.clientCompanyId}, 'lifecycle-owner', 'member')
        `;
        yield* sql`
          insert into client_employee_subscription_grants (
            access_id, client_company_id, user_id, granted_by_user_id
          ) values (
            ${fixture.accessId}, ${fixture.clientCompanyId}, 'lifecycle-owner', 'owner'
          )
        `;
      }),
    );
    const createdResponse = await runProductRoute("lifecycle-owner", "POST", "/v1/chats", {
      companyId: fixture.clientCompanyId,
      memoryMode: "disabled",
      sourceAccessIds: [fixture.accessId],
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { readonly chat: { readonly id: string } };
    expect(
      (await runProductRoute("lifecycle-owner", "POST", `/v1/chats/${created.chat.id}/share`))
        .status,
    ).toBe(200);

    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_employee_subscription_grants
          set revoked_at = now(), revoked_by_user_id = 'owner'
          where access_id = ${fixture.accessId} and user_id = 'lifecycle-owner'
        `;
      }),
    );
    const mine = await runProductRoute("lifecycle-owner", "GET", "/v1/chats?view=mine");
    const listed = (await mine.json()) as { readonly chats: readonly ChatListFixture[] };
    expect(listed.chats.map((chat) => chat.id)).not.toContain(created.chat.id);
    expect(
      (await runProductRoute("lifecycle-owner", "POST", `/v1/chats/${created.chat.id}/share`))
        .status,
    ).toBe(403);
    expect(
      (await runProductRoute("lifecycle-owner", "POST", `/v1/chats/${created.chat.id}/unshare`))
        .status,
    ).toBe(200);
    expect(
      (await runProductRoute("lifecycle-owner", "DELETE", `/v1/chats/${created.chat.id}`)).status,
    ).toBe(204);
  });

  it("linearizes membership revocation before concurrent chat share and delete mutations", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    const waitForAdvisoryWaiters = async (expected: number): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const count = await runDb(
          url,
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

    for (const operation of ["share", "delete"] as const) {
      const userId = `chat-race-${operation}`;
      await runDb(
        url,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into platform_users (id, primary_email, display_name, clerk_user_id)
            values (
              ${userId}, ${`${userId}@example.test`}, ${userId}, ${`clerk-${userId}`}
            )
          `;
          yield* sql`
            insert into client_company_memberships (company_id, user_id, role)
            values (${fixture.clientCompanyId}, ${userId}, 'member')
          `;
          yield* sql`
            insert into client_employee_subscription_grants (
              access_id, client_company_id, user_id, granted_by_user_id
            ) values (${fixture.accessId}, ${fixture.clientCompanyId}, ${userId}, 'owner')
          `;
        }),
      );
      const createdResponse = await runProductRoute(userId, "POST", "/v1/chats", {
        companyId: fixture.clientCompanyId,
        memoryMode: "disabled",
        sourceAccessIds: [fixture.accessId],
      });
      expect(createdResponse.status).toBe(201);
      const created = (await createdResponse.json()) as { readonly chat: { readonly id: string } };

      let signalHeld!: () => void;
      const held = new Promise<void>((resolve) => {
        signalHeld = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = runDb(
        url,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                select pg_advisory_xact_lock(
                  hashtext(${`brief:client-members:${fixture.clientCompanyId}`})
                )
              `;
              yield* Effect.sync(signalHeld);
              yield* Effect.promise(() => released);
            }),
          );
        }),
      );
      await held;
      const revocation = runDb(
        url,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                select pg_advisory_xact_lock(
                  hashtext(${`brief:client-members:${fixture.clientCompanyId}`})
                )
              `;
              yield* sql`
                update client_company_memberships
                set revoked_at = now(), revoked_by_user_id = 'owner'
                where company_id = ${fixture.clientCompanyId} and user_id = ${userId}
              `;
              yield* sql`
                update client_employee_subscription_grants
                set revoked_at = now(), revoked_by_user_id = 'owner'
                where client_company_id = ${fixture.clientCompanyId} and user_id = ${userId}
              `;
            }),
          );
        }),
      );
      await waitForAdvisoryWaiters(1);
      const mutation = runProductRoute(
        userId,
        operation === "share" ? "POST" : "DELETE",
        `/v1/chats/${created.chat.id}${operation === "share" ? "/share" : ""}`,
      );
      await waitForAdvisoryWaiters(2);
      release();
      await holder;
      await revocation;
      expect((await mutation).status).toBe(403);
      const state = await runDb(
        url,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ readonly sharedAt: Date | null; readonly deletedAt: Date | null }>`
            select shared_at as "sharedAt", deleted_at as "deletedAt"
            from chats where id = ${created.chat.id}
          `)[0]!;
        }),
      );
      expect(state).toEqual({ sharedAt: null, deletedAt: null });
    }
  });

  it("leases chat list and full chat projection against revocation and unsharing", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into chat_messages (chat_id, author, content)
          values (${fixture.sharedChatId}, 'assistant', 'Sensitive shared projection')
        `;
      }),
    );
    const chatLayer = PgClient.layer({
      url: Redacted.make(url),
      applicationName: "brief-chat-read-lease-test",
    });
    const readSharedChat = () =>
      Effect.runPromise(
        routeRequest(
          makeChatRoutes(chatLayer),
          new Request(`https://brief.test/v1/chats/${fixture.sharedChatId}`),
        ).pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  NODE_ENV: "test",
                  AUTH_MODE: "demo",
                  DEMO_USER_ID: "viewer",
                  TINYFISH_API_KEY: "tinyfish-test",
                  AI_WEB_MAX_DOMAIN_FILTERS: "2",
                },
              }),
            ),
          ),
        ),
      );
    const waitForAdvisoryWaiters = async (expected: number): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const count = await runDb(
          url,
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

    let signalMembershipHeld!: () => void;
    const membershipHeld = new Promise<void>((resolve) => {
      signalMembershipHeld = resolve;
    });
    let releaseMembership!: () => void;
    const membershipReleased = new Promise<void>((resolve) => {
      releaseMembership = resolve;
    });
    const membershipHolder = runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(
                hashtext(${`brief:client-members:${fixture.clientCompanyId}`})
              )
            `;
            yield* Effect.sync(signalMembershipHeld);
            yield* Effect.promise(() => membershipReleased);
          }),
        );
      }),
    );
    await membershipHeld;
    const revocation = runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(
                hashtext(${`brief:client-members:${fixture.clientCompanyId}`})
              )
            `;
            yield* sql`
              update client_company_memberships
              set revoked_at = now(), revoked_by_user_id = 'owner'
              where company_id = ${fixture.clientCompanyId} and user_id = 'viewer'
            `;
            yield* sql`
              update client_employee_subscription_grants
              set revoked_at = now(), revoked_by_user_id = 'owner'
              where client_company_id = ${fixture.clientCompanyId} and user_id = 'viewer'
            `;
          }),
        );
      }),
    );
    await waitForAdvisoryWaiters(1);
    const readAfterRevocation = readSharedChat();
    const listAfterRevocation = runDb(url, listProductChats(identity("viewer"), "shared"));
    await waitForAdvisoryWaiters(3);
    releaseMembership();
    await membershipHolder;
    await revocation;
    expect((await readAfterRevocation).status).toBe(404);
    await expect(listAfterRevocation).resolves.toEqual([]);
    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_memberships
          set revoked_at = null, revoked_by_user_id = null
          where company_id = ${fixture.clientCompanyId} and user_id = 'viewer'
        `;
        yield* sql`
          update client_employee_subscription_grants
          set revoked_at = null, revoked_by_user_id = null
          where client_company_id = ${fixture.clientCompanyId} and user_id = 'viewer'
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
    const executionHolder = runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(
                hashtext(${`brief:ai-chat:${fixture.sharedChatId}`})
              )
            `;
            yield* Effect.sync(signalExecutionHeld);
            yield* Effect.promise(() => executionReleased);
          }),
        );
      }),
    );
    await executionHeld;
    const unsharing = runDb(
      url,
      mutateProductChat(identity("owner"), fixture.sharedChatId, "unshare"),
    );
    await waitForAdvisoryWaiters(1);
    const readAfterUnshare = readSharedChat();
    let rowWaiting = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      rowWaiting = await runDb(
        url,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ readonly waiting: boolean }>`
            select exists(
              select 1 from pg_stat_activity
              where datname = current_database()
                and application_name = 'brief-chat-read-lease-test'
                and wait_event_type = 'Lock'
            ) as waiting
          `)[0]!.waiting;
        }),
      );
      if (rowWaiting) break;
      await Bun.sleep(5);
    }
    expect(rowWaiting).toBe(true);
    releaseExecution();
    await executionHolder;
    await expect(unsharing).resolves.toBe("ok");
    expect((await readAfterUnshare).status).toBe(404);
    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`update chats set shared_at = now() where id = ${fixture.sharedChatId}`;
      }),
    );
  });

  it("authorizes publisher document reads and issues only short-lived private redirects", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    const pgLayer = PgClient.layer({
      url: Redacted.make(url),
      applicationName: "brief-publisher-document-route-test",
    });
    const signedInputs: unknown[] = [];
    const route = makePublisherDocumentContentRoute(pgLayer, async (input) => {
      signedInputs.push(input);
      return "https://private-storage.test/signed-document";
    });
    const request = new Request(
      `https://brief.test/v1/issues/${fixture.issueId}/documents/${fixture.documentId}/content`,
    );
    const response = await Effect.runPromise(
      route
        .execute(
          request,
          new URL(request.url),
          {
            issueId: fixture.issueId,
            documentId: fixture.documentId,
          },
          { query: {}, headers: {} },
        )
        .pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  NODE_ENV: "test",
                  AUTH_MODE: "demo",
                  DEMO_USER_ID: "owner",
                  RAILWAY_BUCKET_ENDPOINT: "https://storage.test",
                  RAILWAY_BUCKET_NAME: "private",
                  RAILWAY_BUCKET_ACCESS_KEY_ID: "access",
                  RAILWAY_BUCKET_SECRET_ACCESS_KEY: "secret",
                },
              }),
            ),
          ),
        ),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://private-storage.test/signed-document");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(signedInputs).toEqual([
      expect.objectContaining({
        objectKey: `issues/${fixture.issueId}/brief.pdf`,
        expiresInSeconds: 300,
      }),
    ]);
  });

  it("serves a saved citation after unsubscribe and later source policy changes", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    const pgLayer = PgClient.layer({
      url: Redacted.make(url),
      applicationName: "brief-publisher-citation-route-test",
    });
    const citationUrl =
      `/v1/issues/${fixture.issueId}/documents/${fixture.documentId}/content` as const;
    const route = makePublisherDocumentContentRoute(
      pgLayer,
      async () => "https://private-storage.test/saved-citation",
    );
    const readCitation = (userId: string) => {
      const request = new Request(`https://brief.test${citationUrl}`);
      return Effect.runPromise(
        route
          .execute(
            request,
            new URL(request.url),
            { issueId: fixture.issueId, documentId: fixture.documentId },
            { query: {}, headers: {} },
          )
          .pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: {
                    NODE_ENV: "test",
                    AUTH_MODE: "demo",
                    DEMO_USER_ID: userId,
                    RAILWAY_BUCKET_ENDPOINT: "https://storage.test",
                    RAILWAY_BUCKET_NAME: "private",
                    RAILWAY_BUCKET_ACCESS_KEY_ID: "access",
                    RAILWAY_BUCKET_SECRET_ACCESS_KEY: "secret",
                  },
                }),
              ),
            ),
          ),
      );
    };

    await expect(readCitation("owner")).resolves.toMatchObject({ status: 302 });
    await expect(readCitation("publisher-admin")).resolves.toMatchObject({ status: 302 });
    await expect(readCitation("never-recipient")).resolves.toMatchObject({ status: 404 });

    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_subscription_accesses
          set state = 'paused', delivery_end_at = now(), paused_at = now(), updated_at = now()
          where id = ${fixture.accessId}
        `;
        yield* sql`
          update client_employee_subscription_grants
          set revoked_at = now(), revoked_by_user_id = 'owner'
          where access_id = ${fixture.accessId}
            and client_company_id = ${fixture.clientCompanyId}
            and user_id in ('owner', 'viewer')
        `;
        yield* sql`
          update publisher_companies
          set delivery_enabled = false
          where id = ${fixture.publisherCompanyId}
        `;
        yield* sql`
          update publisher_subscriptions
          set delivery_enabled = false
          where id = ${fixture.subscriptionId}
        `;
      }),
    );

    await expect(readCitation("owner")).resolves.toMatchObject({ status: 302 });
    await expect(readCitation("publisher-admin")).resolves.toMatchObject({ status: 302 });
    await expect(readCitation("never-recipient")).resolves.toMatchObject({ status: 404 });

    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_subscription_accesses
          set state = 'active', delivery_end_at = null, paused_at = null, updated_at = now()
          where id = ${fixture.accessId}
        `;
        yield* sql`
          update client_employee_subscription_grants
          set revoked_at = null, revoked_by_user_id = null
          where access_id = ${fixture.accessId}
            and client_company_id = ${fixture.clientCompanyId}
            and user_id in ('owner', 'viewer')
        `;
        yield* sql`
          update publisher_companies
          set delivery_enabled = true
          where id = ${fixture.publisherCompanyId}
        `;
        yield* sql`
          update publisher_subscriptions
          set delivery_enabled = true
          where id = ${fixture.subscriptionId}
        `;
      }),
    );
  });

  it("uses explicit-origin CORS for publisher document final responses", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    const pgLayer = PgClient.layer({
      url: Redacted.make(url),
      applicationName: "brief-publisher-document-cors-test",
    });
    const route = makePublisherDocumentContentRoute(
      pgLayer,
      async () => "https://private-storage.test/signed-document-cors",
    );
    const request = (origin: string) =>
      new Request(
        `https://brief.test/v1/issues/${fixture.issueId}/documents/${fixture.documentId}/content`,
        { headers: { origin } },
      );
    const run = (
      origin: string,
      corsAllowedOrigins?: string,
      userId = "owner",
      method: "GET" | "OPTIONS" = "GET",
    ) =>
      Effect.runPromise(
        routeRequest(
          [route],
          method === "GET"
            ? request(origin)
            : new Request(
                `https://brief.test/v1/issues/${fixture.issueId}/documents/${fixture.documentId}/content`,
                {
                  method,
                  headers: {
                    origin,
                    "access-control-request-method": "GET",
                  },
                },
              ),
        ).pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  NODE_ENV: "test",
                  AUTH_MODE: "demo",
                  DEMO_USER_ID: userId,
                  RAILWAY_BUCKET_ENDPOINT: "https://storage.test",
                  RAILWAY_BUCKET_NAME: "private",
                  RAILWAY_BUCKET_ACCESS_KEY_ID: "access",
                  RAILWAY_BUCKET_SECRET_ACCESS_KEY: "secret",
                  ...(corsAllowedOrigins === undefined
                    ? {}
                    : { CORS_ALLOWED_ORIGINS: corsAllowedOrigins }),
                },
              }),
            ),
          ),
        ),
      );

    const allowed = await run("https://web.example", "https://web.example");
    expect(allowed.status).toBe(302);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://web.example");
    expect(allowed.headers.get("vary")).toContain("Origin");

    const denied = await run("https://evil.example", "https://web.example");
    expect(denied.status).toBe(302);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();

    const deniedPreflight = await run(
      "https://evil.example",
      "https://web.example",
      "owner",
      "OPTIONS",
    );
    expect(deniedPreflight.status).toBe(403);
    expect(deniedPreflight.headers.get("access-control-allow-origin")).toBeNull();

    const deniedIdentity = await run("https://evil.example", "https://web.example", "unknown-user");
    expect(deniedIdentity.status).toBe(404);
    await expect(deniedIdentity.json()).resolves.toEqual({ error: "not_found" });
    expect(deniedIdentity.headers.get("access-control-allow-origin")).toBeNull();

    // Authenticated document routes must never expose a wildcard
    // bearer-capability CORS grant, even when the caller omits CORS config.
    const wildcard = await run("https://web.example");
    expect(wildcard.status).toBe(302);
    expect(wildcard.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("authorizes historical publisher documents from delivery-time recipient records", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    const neverDeliveredCompanyId = crypto.randomUUID();
    const neverDeliveredUserId = `never-delivered-${crypto.randomUUID()}`;
    const neverDeliveredAccessId = crypto.randomUUID();
    const select = (
      userId: string,
      issueId = fixture.issueId,
      documentId = fixture.documentId,
      organizationId: string | null = null,
    ) =>
      runDb(
        url,
        selectAuthorizedPublisherDocument(
          { userId, organizationId, mode: "clerk" },
          issueId,
          documentId,
        ),
      );
    await expect(select("owner")).resolves.not.toBeNull();
    await expect(select("viewer")).resolves.not.toBeNull();
    await expect(select("publisher-admin")).resolves.not.toBeNull();

    const legacyIssueId = crypto.randomUUID();
    const legacyDocumentId = crypto.randomUUID();
    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into publisher_issues (
            id, subscription_id, title, status, publication_at, published_at, created_by_user_id
          ) values (
            ${legacyIssueId}, ${fixture.subscriptionId}, 'Legacy issue without recipients',
            'draft', null, null, 'publisher-admin'
          )
        `;
        yield* sql`
          insert into brief_documents (
            id, issue_id, title, original_file_name, object_key, media_type,
            byte_size, sha256_hex, upload_completed_at, created_by_user_id
          ) values (
            ${legacyDocumentId}, ${legacyIssueId}, 'Legacy document', 'legacy.pdf',
            ${`issues/${legacyIssueId}/legacy.pdf`}, 'application/pdf', 1, ${"a".repeat(64)},
            now(), 'publisher-admin'
          )
        `;
        yield* sql`
          update publisher_issues
          set status = 'published', publication_at = now(), published_at = now()
          where id = ${legacyIssueId}
        `;
        yield* sql`
          insert into issue_deliveries (
            issue_id, subscription_id, access_id, client_company_id, historical
          ) values (
            ${legacyIssueId}, ${fixture.subscriptionId}, ${fixture.accessId},
            ${fixture.clientCompanyId}, false
          )
        `;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values (${fixture.clientCompanyId}, 'never-recipient', 'member')
        `;
        yield* sql`
          insert into client_employee_subscription_grants (
            access_id, client_company_id, user_id, granted_by_user_id
          ) values (
            ${fixture.accessId}, ${fixture.clientCompanyId}, 'never-recipient', 'owner'
          )
        `;
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values (
            ${neverDeliveredUserId}, ${`${neverDeliveredUserId}@example.test`},
            'Never Delivered', ${`clerk-${neverDeliveredUserId}`}
          )
        `;
        yield* sql`
          insert into client_companies (id, name)
          values (${neverDeliveredCompanyId}, 'Never Delivered Company')
        `;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values (${neverDeliveredCompanyId}, ${neverDeliveredUserId}, 'member')
        `;
        yield* sql`
          insert into client_subscription_accesses (
            id, subscription_id, client_company_id, state, first_admin_email,
            accepted_at, subscribed_at, created_by_user_id
          ) values (
            ${neverDeliveredAccessId}, ${fixture.subscriptionId}, ${neverDeliveredCompanyId},
            'active', ${`${neverDeliveredUserId}@example.test`}, now(), now(), 'owner'
          )
        `;
        yield* sql`
          insert into client_employee_subscription_grants (
            access_id, client_company_id, user_id, granted_by_user_id
          ) values (
            ${neverDeliveredAccessId}, ${neverDeliveredCompanyId},
            ${neverDeliveredUserId}, 'owner'
          )
        `;
        yield* sql`
          update client_subscription_accesses
          set state = 'paused', delivery_end_at = now(), paused_at = now(), updated_at = now()
          where id = ${fixture.accessId}
        `;
        yield* sql`
          update client_employee_subscription_grants
          set revoked_at = now(), revoked_by_user_id = 'owner'
          where access_id = ${fixture.accessId}
            and client_company_id = ${fixture.clientCompanyId}
            and user_id in ('owner', 'viewer')
        `;
        yield* sql`
          update publisher_companies
          set delivery_enabled = false
          where id = (
            select publisher_company_id from publisher_subscriptions
            where id = ${fixture.subscriptionId}
          )
        `;
        yield* sql`
          update publisher_subscriptions
          set delivery_enabled = false
          where id = ${fixture.subscriptionId}
        `;
      }),
    );

    // Unsubscribe, revoke the current grants, and stop future delivery. None
    // of those changes can revoke a user frozen into the delivery snapshot.
    await expect(select("owner")).resolves.not.toBeNull();
    await expect(select("viewer")).resolves.not.toBeNull();
    await expect(select("publisher-admin")).resolves.not.toBeNull();
    await expect(select("never-recipient")).resolves.toBeNull();
    await expect(select(neverDeliveredUserId)).resolves.toBeNull();
    await expect(select("owner", fixture.issueId, legacyDocumentId)).resolves.toBeNull();
    await expect(select("owner", legacyIssueId, fixture.documentId)).resolves.toBeNull();
    await expect(
      select("owner", fixture.issueId, fixture.documentId, "org-foreign"),
    ).resolves.toBeNull();

    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_subscription_accesses
          set state = 'active', delivery_end_at = null, paused_at = null,
              accepted_at = coalesce(accepted_at, now()),
              subscribed_at = coalesce(subscribed_at, now()), updated_at = now()
          where id = ${fixture.accessId}
        `;
        yield* sql`
          update client_employee_subscription_grants
          set revoked_at = null, revoked_by_user_id = null
          where access_id = ${fixture.accessId}
            and client_company_id = ${fixture.clientCompanyId}
            and user_id in ('owner', 'viewer')
        `;
        yield* sql`
          update publisher_companies
          set delivery_enabled = true
          where id = (
            select publisher_company_id from publisher_subscriptions
            where id = ${fixture.subscriptionId}
          )
        `;
        yield* sql`
          update publisher_subscriptions
          set delivery_enabled = true
          where id = ${fixture.subscriptionId}
        `;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`set local brief.allow_account_purge = 'on'`;
            yield* sql`
              delete from client_employee_subscription_grants
              where access_id = ${fixture.accessId}
                and client_company_id = ${fixture.clientCompanyId}
                and user_id = 'never-recipient'
            `;
            yield* sql`
              delete from client_company_memberships
              where company_id = ${fixture.clientCompanyId} and user_id = 'never-recipient'
            `;
            yield* sql`
              delete from client_subscription_accesses
              where id = ${neverDeliveredAccessId}
            `;
            yield* sql`
              delete from client_company_memberships
              where company_id = ${neverDeliveredCompanyId}
                and user_id = ${neverDeliveredUserId}
            `;
            yield* sql`
              delete from client_companies
              where id = ${neverDeliveredCompanyId}
            `;
            yield* sql`
              delete from platform_users
              where id = ${neverDeliveredUserId}
            `;
          }),
        );
      }),
    );
  });

  it("fails closed for a purged delivered company until its state is restored", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    const signed = () =>
      runDb(
        url,
        withAuthorizedPublisherDocumentLease(
          { userId: "owner", organizationId: null, mode: "clerk" },
          fixture.issueId,
          fixture.documentId,
          () => Effect.succeed(true),
        ),
      );

    await expect(signed()).resolves.toBe(true);
    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        // Membership and grant rows intentionally remain present. A stale
        // restored identity must not authorize a bearer URL while the
        // company's permanent purge tombstone is still set.
        yield* sql`
          update client_companies
          set recovery_deleted_at = null, purge_after = null, purged_at = now()
          where id = ${fixture.clientCompanyId}
        `;
      }),
    );
    await expect(
      runDb(
        url,
        selectAuthorizedPublisherDocument(
          { userId: "owner", organizationId: null, mode: "clerk" },
          fixture.issueId,
          fixture.documentId,
        ),
      ),
    ).resolves.toBeNull();
    await expect(signed()).resolves.toBeNull();

    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_companies
          set purged_at = null
          where id = ${fixture.clientCompanyId}
        `;
      }),
    );
    await expect(signed()).resolves.toBe(true);
  });

  it("fails closed for a restricted publisher issue until its state is restored", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    const select = () =>
      runDb(
        url,
        selectAuthorizedPublisherDocument(
          { userId: "publisher-admin", organizationId: null, mode: "clerk" },
          fixture.issueId,
          fixture.documentId,
        ),
      );
    const signed = () =>
      runDb(
        url,
        withAuthorizedPublisherDocumentLease(
          { userId: "publisher-admin", organizationId: null, mode: "clerk" },
          fixture.issueId,
          fixture.documentId,
          () => Effect.succeed(true),
        ),
      );

    await expect(select()).resolves.not.toBeNull();
    await expect(signed()).resolves.toBe(true);
    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update publisher_issues
          set restricted_at = now(),
              restricted_by_user_id = 'publisher-admin',
              restricted_reason = 'test_restriction'
          where id = ${fixture.issueId}
        `;
      }),
    );
    await expect(select()).resolves.toBeNull();
    await expect(signed()).resolves.toBeNull();

    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update publisher_issues
          set restricted_at = null,
              restricted_by_user_id = null,
              restricted_reason = null
          where id = ${fixture.issueId}
        `;
      }),
    );
    await expect(select()).resolves.not.toBeNull();
    await expect(signed()).resolves.toBe(true);
  });

  it("holds publisher-document authorization through signed capability issuance", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    const pgLayer = PgClient.layer({
      url: Redacted.make(url),
      applicationName: "brief-publisher-document-lease-test",
    });
    let signalSigner!: () => void;
    const signerStarted = new Promise<void>((resolve) => {
      signalSigner = resolve;
    });
    let releaseSigner!: () => void;
    const signerReleased = new Promise<void>((resolve) => {
      releaseSigner = resolve;
    });
    const route = makePublisherDocumentContentRoute(pgLayer, async (input) => {
      expect(input.signal.aborted).toBe(false);
      signalSigner();
      await signerReleased;
      return "https://private-storage.test/signed-document-lease";
    });
    const request = new Request(
      `https://brief.test/v1/issues/${fixture.issueId}/documents/${fixture.documentId}/content`,
    );
    const response = Effect.runPromise(
      route
        .execute(
          request,
          new URL(request.url),
          { issueId: fixture.issueId, documentId: fixture.documentId },
          { query: {}, headers: {} },
        )
        .pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  NODE_ENV: "test",
                  AUTH_MODE: "demo",
                  DEMO_USER_ID: "owner",
                  RAILWAY_BUCKET_ENDPOINT: "https://storage.test",
                  RAILWAY_BUCKET_NAME: "private",
                  RAILWAY_BUCKET_ACCESS_KEY_ID: "access",
                  RAILWAY_BUCKET_SECRET_ACCESS_KEY: "secret",
                },
              }),
            ),
          ),
        ),
    );
    await signerStarted;
    let revocationFinished = false;
    const revocation = runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(
                hashtext(${`brief:client-members:${fixture.clientCompanyId}`})
              )
            `;
            yield* sql`
              update client_employee_subscription_grants
              set revoked_at = now(), revoked_by_user_id = 'owner'
              where access_id = ${fixture.accessId} and user_id = 'owner'
            `;
          }),
        );
      }),
    ).then(() => {
      revocationFinished = true;
    });
    let waiting = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const count = await runDb(
        url,
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
      if (count > 0) {
        waiting = true;
        break;
      }
      await Bun.sleep(5);
    }
    expect(waiting).toBe(true);
    expect(revocationFinished).toBe(false);
    releaseSigner();
    expect((await response).status).toBe(302);
    await revocation;
    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_employee_subscription_grants
          set revoked_at = null, revoked_by_user_id = null
          where access_id = ${fixture.accessId} and user_id = 'owner'
        `;
      }),
    );
  });

  it("binds Clerk organization claims to the authorized publisher or client workspace", async () => {
    const url = databaseUrlFor(isolatedDatabaseName);
    await runDb(
      url,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_companies
          set clerk_organization_id = 'org_client'
          where id = ${fixture.clientCompanyId}
        `;
        yield* sql`
          update publisher_companies
          set clerk_organization_id = 'org_publisher'
          where id = ${fixture.publisherCompanyId}
        `;
      }),
    );

    const select = (userId: string, organizationId: string | null) =>
      runDb(
        url,
        selectAuthorizedPublisherDocument(
          { userId, organizationId, mode: "clerk" },
          fixture.issueId,
          fixture.documentId,
        ),
      );
    await expect(select("owner", "org_client")).resolves.not.toBeNull();
    await expect(select("owner", "org_publisher")).resolves.toBeNull();
    await expect(select("publisher-admin", "org_publisher")).resolves.not.toBeNull();
    await expect(select("publisher-admin", "org_client")).resolves.toBeNull();
    await expect(select("owner", null)).resolves.not.toBeNull();
  });

  it("keeps normal platform operations content-free and scopes every support content open", async () => {
    const supportGrantId = crypto.randomUUID();
    const supportOpenAudit = { requestId: null as string | null };
    await runDb(
      databaseUrlFor(isolatedDatabaseName),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          delete from company_deletion_requests
          where client_company_id <> ${fixture.clientCompanyId}
        `;
        yield* sql`delete from client_companies where id <> ${fixture.clientCompanyId}`;
        yield* sql`
          insert into restricted_support_grants (
            id, actor_user_id, reason, scope_kind, scope_id, client_company_id,
            affected_user_id, approval_skipped_reason, granted_by_user_id, expires_at
          ) values (
            ${supportGrantId}, 'support-user', 'Independent operations support review',
            'client_chat', ${fixture.sharedChatId}, ${fixture.clientCompanyId}, 'owner',
            'Security incident requires prompt access', 'security-user', now() + interval '1 hour'
          )
        `;
      }),
    );
    const overviewResponse = await runPlatformRoute(
      "security-user",
      "GET",
      "/v1/platform/operations",
    );
    expect(overviewResponse.status).toBe(200);
    const overview = (await overviewResponse.json()) as {
      readonly role: string;
      readonly overview: Record<string, number>;
    };
    expect(overview.role).toBe("security");
    expect(overview.overview).toMatchObject({ publisherCompanies: 1, clientCompanies: 1 });
    expect(JSON.stringify(overview)).not.toContain('"Issue"');

    const contentResponse = await runPlatformRoute(
      "support-user",
      "GET",
      `/v1/platform/support/grants/${supportGrantId}/content`,
      undefined,
      supportOpenAudit,
    );
    expect(contentResponse.status).toBe(200);
    const content = (await contentResponse.json()) as {
      readonly accessLogId: string;
      readonly scopeKind: string;
      readonly content: { readonly id: string };
    };
    expect(content).toMatchObject({
      scopeKind: "client_chat",
      content: { id: fixture.sharedChatId },
    });

    const review = await runPlatformRoute(
      "security-user",
      "POST",
      `/v1/platform/support/access/${content.accessLogId}/review`,
      { decision: "approved", notes: "Scope and approval basis verified." },
    );
    expect(review.status).toBe(201);

    const state = await runDb(
      databaseUrlFor(isolatedDatabaseName),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly logs: number;
          readonly reviews: number;
          readonly audits: number;
        }>`
          select
            (select count(*)::int from restricted_support_access_log
             where grant_id = ${supportGrantId}) logs,
            (select count(*)::int from restricted_support_access_reviews
             where access_log_id = ${content.accessLogId}) reviews,
            (select count(*)::int from platform_authorization_audit_log
             where request_id = ${supportOpenAudit.requestId}) audits
        `)[0]!;
      }),
    );
    expect(state).toEqual({ logs: 1, reviews: 1, audits: 1 });
  });

  it("records authenticated platform-support role denials without auditing unauthenticated noise", async () => {
    const denied = await runPlatformRoute("support-user", "POST", "/v1/platform/support/grants", {
      actorUserId: "support-user",
      reason: "Investigate an authorized customer support case.",
      scopeKind: "client_chat",
      scopeId: fixture.sharedChatId,
      publisherCompanyId: null,
      clientCompanyId: fixture.clientCompanyId,
      affectedUserId: "chat-owner",
      customerApprovalReference: "approval-test-reference",
      approvalSkippedReason: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    });
    expect(denied.status).toBe(403);

    const audits = await runDb(
      databaseUrlFor(isolatedDatabaseName),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly outcome: string; readonly reasonCode: string | null }>`
          select outcome, reason_code as "reasonCode"
          from platform_authorization_audit_log
          where actor_user_id = 'support-user'
            and action = 'platform.support.grant_create'
          order by id desc
          limit 1
        `;
      }),
    );
    expect(audits).toEqual([{ outcome: "denied", reasonCode: "forbidden" }]);
  });

  it("idempotently approves or rejects company deletion requests and schedules exact recovery", async () => {
    const deletionCompanyId = crypto.randomUUID();
    const approvalRequestId = crypto.randomUUID();
    const rejectionCompanyId = crypto.randomUUID();
    const rejectionRequestId = crypto.randomUUID();
    await runDb(
      databaseUrlFor(isolatedDatabaseName),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into client_companies (id, name)
          values (${deletionCompanyId}, 'Deletion client'), (${rejectionCompanyId}, 'Retained client')
        `;
        yield* sql`
          insert into company_deletion_requests (
            id, client_company_id, requested_by_user_id, reason, idempotency_key
          ) values
            (${approvalRequestId}, ${deletionCompanyId}, 'owner', 'Close the company account',
             'deletion-request-approval-0001'),
            (${rejectionRequestId}, ${rejectionCompanyId}, 'owner', 'Request needs review',
             'deletion-request-rejection-0001')
        `;
      }),
    );

    const approvalBody = {
      decision: "approved",
      idempotencyKey: "deletion-decision-approval-0001",
    };
    const approvals = await Promise.all([
      runPlatformRoute(
        "legal-user",
        "POST",
        `/v1/platform/company-deletion-requests/${approvalRequestId}/decision`,
        approvalBody,
      ),
      runPlatformRoute(
        "legal-user",
        "POST",
        `/v1/platform/company-deletion-requests/${approvalRequestId}/decision`,
        approvalBody,
      ),
    ]);
    expect(approvals.every((response) => response.status === 200)).toBe(true);
    const approvalResponses = await Promise.all(
      approvals.map(
        (response) =>
          response.json() as Promise<{
            readonly duplicate: boolean;
            readonly request: { readonly status: string; readonly purgeAfter: string | null };
          }>,
      ),
    );
    expect(approvalResponses.map((response) => response.duplicate).sort()).toEqual([false, true]);
    expect(approvalResponses.every((response) => response.request.status === "approved")).toBe(
      true,
    );

    const forbidden = await runPlatformRoute(
      "security-user",
      "POST",
      `/v1/platform/company-deletion-requests/${rejectionRequestId}/decision`,
      { decision: "rejected", idempotencyKey: "deletion-decision-rejection-0001" },
    );
    expect(forbidden.status).toBe(403);
    const rejected = await runPlatformRoute(
      "legal-user",
      "POST",
      `/v1/platform/company-deletion-requests/${rejectionRequestId}/decision`,
      { decision: "rejected", idempotencyKey: "deletion-decision-rejection-0001" },
    );
    expect(rejected.status).toBe(200);

    const listed = await runPlatformRoute(
      "legal-user",
      "GET",
      "/v1/platform/company-deletion-requests",
    );
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      readonly requests: readonly { readonly id: string; readonly status: string }[];
    };
    expect(listedBody.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: approvalRequestId, status: "approved" }),
        expect.objectContaining({ id: rejectionRequestId, status: "rejected" }),
      ]),
    );

    const state = await runDb(
      databaseUrlFor(isolatedDatabaseName),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly recoveryDeletedAt: Date;
          readonly purgeAfter: Date;
          readonly retainedRecoveryDeletedAt: Date | null;
          readonly retainedPurgeAfter: Date | null;
          readonly deniedAudits: number;
          readonly succeededAudits: number;
        }>`
          select approved.recovery_deleted_at as "recoveryDeletedAt",
                 approved.purge_after as "purgeAfter",
                 retained.recovery_deleted_at as "retainedRecoveryDeletedAt",
                 retained.purge_after as "retainedPurgeAfter",
                 (select count(*)::int from platform_authorization_audit_log
                  where action = 'platform.company_deletion.resolve' and outcome = 'denied'
                    and actor_user_id = 'security-user') as "deniedAudits",
                 (select count(*)::int from platform_authorization_audit_log
                  where action = 'platform.company_deletion.resolve' and outcome = 'succeeded'
                    and actor_user_id = 'legal-user') as "succeededAudits"
          from client_companies approved, client_companies retained
          where approved.id = ${deletionCompanyId} and retained.id = ${rejectionCompanyId}
        `)[0]!;
      }),
    );
    const recoveryWindowMs = state.purgeAfter.getTime() - state.recoveryDeletedAt.getTime();
    expect(recoveryWindowMs).toBeGreaterThanOrEqual(180 * 86_400_000);
    expect(recoveryWindowMs).toBeLessThan(181 * 86_400_000);
    expect(state).toMatchObject({
      retainedRecoveryDeletedAt: null,
      retainedPurgeAfter: null,
      deniedAudits: 1,
      succeededAudits: 3,
    });
  });

  it("rejects forged support scope relationships and hides restricted issues from normal access", async () => {
    await expect(
      runDb(
        databaseUrlFor(isolatedDatabaseName),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into restricted_support_grants (
              actor_user_id, reason, scope_kind, scope_id, client_company_id,
              affected_user_id, customer_approval_reference, approval_skipped_reason,
              granted_by_user_id, expires_at
            ) values (
              'support-user', 'Missing approval basis must fail', 'client_chat',
              ${fixture.sharedChatId}, ${fixture.clientCompanyId}, 'owner', null, null,
              'security-user', now() + interval '1 hour'
            )
          `;
        }),
      ),
    ).rejects.toThrow();

    await expect(
      runDb(
        databaseUrlFor(isolatedDatabaseName),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into restricted_support_grants (
              actor_user_id, reason, scope_kind, scope_id, client_company_id,
              affected_user_id, approval_skipped_reason, granted_by_user_id, expires_at
            ) values (
              'support-user', 'Attempt forged publisher scope', 'publisher_file',
              ${fixture.documentId}, ${fixture.clientCompanyId}, 'owner',
              'Security incident', 'security-user', now() + interval '1 hour'
            )
          `;
        }),
      ),
    ).rejects.toThrow();

    const restricted = await runPlatformRoute(
      "security-user",
      "POST",
      `/v1/platform/issues/${fixture.issueId}/restriction`,
      { reason: "Confirmed security response containment." },
    );
    expect(restricted.status).toBe(204);

    const pgLayer = PgClient.layer({
      url: Redacted.make(databaseUrlFor(isolatedDatabaseName)),
      applicationName: "brief-restricted-document-test",
    });
    const documentRoute = makePublisherDocumentContentRoute(
      pgLayer,
      async () => "https://private-storage.test/document",
    );
    const request = new Request(
      `https://brief.test/v1/issues/${fixture.issueId}/documents/${fixture.documentId}/content`,
    );
    const denied = await Effect.runPromise(
      documentRoute
        .execute(
          request,
          new URL(request.url),
          {
            issueId: fixture.issueId,
            documentId: fixture.documentId,
          },
          { query: {}, headers: {} },
        )
        .pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { NODE_ENV: "test", AUTH_MODE: "demo", DEMO_USER_ID: "owner" },
              }),
            ),
          ),
        ),
    );
    expect(denied.status).toBe(404);

    const publisherIdentity = identity("publisher-admin");
    await expect(
      runDb(
        databaseUrlFor(isolatedDatabaseName),
        listPublisherIssues(publisherIdentity, fixture.subscriptionId),
      ),
    ).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: fixture.issueId })]),
    );
    await expect(
      runDb(
        databaseUrlFor(isolatedDatabaseName),
        getPublisherIssue(publisherIdentity, fixture.issueId),
      ),
    ).rejects.toThrow("not_found");

    const restored = await runPlatformRoute(
      "security-user",
      "DELETE",
      `/v1/platform/issues/${fixture.issueId}/restriction`,
    );
    expect(restored.status).toBe(204);
  });
});

interface ChatListFixture {
  readonly id: string;
}
