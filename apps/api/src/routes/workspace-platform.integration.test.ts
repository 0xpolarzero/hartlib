import type { WebhookEvent } from "@clerk/backend/webhooks";
import { PgClient } from "@effect/sql-pg";
import { ConfigProvider, Effect, Redacted } from "effect";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPublisherIssue,
  createPublisherSubscription,
  deletePublisherDocument,
  getPublisherAiPullMetrics,
  listPublisherClientAccesses,
  listPublisherIssues,
  PUBLISHER_UPLOAD_STORAGE_TIMEOUT_MS,
  pausePublisherClientAccess,
  uploadPublisherDocument,
  updateNotificationPreferences,
  appendDeniedAuthorizationAudit,
  requireClientCompanyAdmin,
} from "@brief/workspace";
import { acceptClerkWebhook } from "@brief/backend-domain/clerk-webhook";
import { createUserMessageAndRun, ensureDemoChat } from "@brief/backend-domain/chat-runtime";
import { hasProductChatAccess } from "@brief/backend-domain/product-chats";

import { loadApiConfig } from "../config";
import { routeRequest, type Route } from "../http";
import { makeBillingRoutes, type BillingStripeGateway } from "../domain/billing";
import { preflightCredits } from "../domain/chat";
import { makeClerkWebhookRoute } from "../domain/clerk-webhook";
import { makeClientWorkspaceRoutes } from "../domain/client-workspace";
import { makePublicSourceDocumentContentRoute } from "../domain/public-sources";
import {
  makePublisherOnboardingRoute,
  type PublisherOnboardingProvider,
} from "../domain/publisher-onboarding";
import {
  makePublisherWorkspaceRoutes,
  type PublisherClientOnboardingProvider,
} from "../domain/publisher-workspace";
import {
  makeWorkspaceMembershipRoutes,
  type WorkspaceInvitationProvider,
} from "../domain/workspace-memberships";

const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const isBun = typeof process.versions.bun === "string";
const migrationsUrl = new URL("../../../../db/migrations/", import.meta.url);
const databaseName = `brief_workspace_platform_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
const publisherCompanyId = "10000000-0000-4000-8000-000000000001";
const clientCompanyId = "20000000-0000-4000-8000-000000000002";
const subscriptionId = "30000000-0000-4000-8000-000000000003";
const accessId = "40000000-0000-4000-8000-000000000004";

const urlFor = (database: string): string => {
  if (databaseUrl === undefined) throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL required");
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
};
const isolatedUrl = () => urlFor(databaseName);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const namespacedPublisherDocumentIdentity = (
  subscriptionId: string,
  issueId: string,
  documentId: string,
): string =>
  `document:namespace:publisher:${JSON.stringify([
    `publisher:${subscriptionId}`,
    issueId,
    documentId,
    documentId,
  ])}`;
const documentContentItemIdentity = (
  logicalSourceIdentity: string,
  versionId: string,
  ranges: readonly { readonly charStart: number; readonly charEnd: number }[],
): string =>
  `${logicalSourceIdentity}:${versionId}:${createHash("sha256")
    .update(JSON.stringify(ranges), "utf8")
    .digest("base64url")}`;
const runDb = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>, database = databaseName) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(urlFor(database)),
          applicationName: "workspace-platform-integration-test",
        }),
      ),
    ),
  );

const pgLayer = () =>
  PgClient.layer({
    url: Redacted.make(isolatedUrl()),
    applicationName: "workspace-platform-route-test",
  });

const config = (userId = "admin-user", extra: Record<string, string> = {}) =>
  ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: {
        NODE_ENV: "test",
        AUTH_MODE: "demo",
        DEMO_USER_ID: userId,
        CLERK_WEBHOOK_SIGNING_SECRET: "whsec_test",
        CLERK_INVITATION_REDIRECT_URL: "https://brief.test/invitations/accept",
        TINYFISH_API_KEY: "tinyfish-test",
        STRIPE_SECRET_KEY: "stripe-test",
        STRIPE_PRICE_LIGHT: "price_light",
        STRIPE_PRICE_TEAM: "price_team",
        STRIPE_PRICE_INTENSIVE: "price_intensive",
        STRIPE_PRICE_ADDITIONAL_CREDIT: "price_additional",
        STRIPE_CHECKOUT_SUCCESS_URL: "https://brief.test/billing/success",
        STRIPE_CHECKOUT_CANCEL_URL: "https://brief.test/billing/cancel",
        STRIPE_PORTAL_RETURN_URL: "https://brief.test/billing",
        ...extra,
      },
    }),
  );

const call = (
  routes: readonly Route[],
  userId: string,
  method: string,
  path: string,
  body?: unknown,
  options?: { readonly origin?: string; readonly config?: Record<string, string> },
) => {
  const request = new Request(`https://brief.test${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-request-id": crypto.randomUUID(),
      ...(options?.origin === undefined ? {} : { origin: options.origin }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return Effect.runPromise(
    routeRequest(routes, request).pipe(Effect.provide(config(userId, options?.config))),
  );
};

const migrate = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  for (const file of [...new Bun.Glob("*.sql").scanSync({ cwd: migrationsUrl.pathname })].sort()) {
    yield* sql.unsafe(yield* Effect.promise(() => Bun.file(new URL(file, migrationsUrl)).text()))
      .raw;
  }
});

const seed = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  yield* sql`
    insert into platform_users (id, primary_email, display_name, clerk_user_id) values
      ('admin-user', 'admin@example.test', 'Admin', 'clerk-admin'),
      ('member-user', 'member@example.test', 'Member', 'clerk-member'),
      ('platform-admin', 'platform@example.test', 'Platform Admin', 'clerk-platform')
  `;
  yield* sql`
    insert into client_companies (id, name, clerk_organization_id, stripe_customer_id)
    values (${clientCompanyId}, 'Client', 'org_client', 'cus_client')
  `;
  yield* sql`
    insert into client_company_memberships (company_id, user_id, role) values
      (${clientCompanyId}, 'admin-user', 'admin'),
      (${clientCompanyId}, 'member-user', 'member')
  `;
  yield* sql`insert into client_company_ai_settings (company_id) values (${clientCompanyId})`;
  yield* sql`
    insert into publisher_companies (id, name, clerk_organization_id)
    values (${publisherCompanyId}, 'Publisher', 'org_publisher')
  `;
  yield* sql`
    insert into publisher_company_memberships (
      publisher_company_id, user_id, role, accepted_at
    ) values (${publisherCompanyId}, 'admin-user', 'admin', now())
  `;
  yield* sql`
    insert into publisher_subscriptions (id, publisher_company_id, name, created_by_user_id)
    values (${subscriptionId}, ${publisherCompanyId}, 'Daily', 'admin-user')
  `;
  yield* sql`
    insert into client_subscription_accesses (
      id, subscription_id, client_company_id, state, first_admin_email,
      accepted_at, subscribed_at, created_by_user_id
    ) values (
      ${accessId}, ${subscriptionId}, ${clientCompanyId}, 'active', 'admin@example.test',
      now(), now(), 'admin-user'
    )
  `;
  yield* sql`
    insert into client_employee_subscription_grants (
      access_id, client_company_id, user_id, granted_by_user_id
    ) values
      (${accessId}, ${clientCompanyId}, 'admin-user', 'admin-user'),
      (${accessId}, ${clientCompanyId}, 'member-user', 'admin-user')
  `;
  yield* sql`
    insert into client_ai_billing_accounts (
      client_company_id, plan_tier, status, current_period_start, current_period_end
    ) values (${clientCompanyId}, 'team', 'active', now() - interval '1 day', now() + interval '20 days')
  `;
  yield* sql`
    insert into client_credit_lots (
      client_company_id, kind, credits_granted, credits_remaining,
      available_at, expires_at, stripe_payment_id
    ) values (${clientCompanyId}, 'monthly', 100, 100, now() - interval '1 day', now() + interval '20 days', 'seed-lot')
  `;
  yield* sql`insert into platform_admins (user_id, role) values ('platform-admin', 'admin')`;
  yield* sql`
    insert into public_sources (
      source_id, display_name, publisher_name, description, ingestion_method,
      discovery_url, average_chars_per_item, country, language
    ) values (
      'official-marketplace-source', 'Official marketplace source', 'Official publisher',
      'Public source setting fixture', 'rss', 'https://example.test/feed', 1000, 'FR', 'fr-FR'
    ) on conflict (source_id) do nothing
  `;
});

const seedMarketplacePublicDocument = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const artifactId = crypto.randomUUID();
  const documentText = "Public archive evidence ".repeat(20);
  yield* sql`
    insert into public_source_raw_artifacts (
      id, source_id, canonical_url, fetched_at, media_type, body, body_hash
    ) values (
      ${artifactId}, 'official-marketplace-source', 'https://example.test/publication',
      now(), 'text/html', ${`<p>${documentText}</p>`}, ${"a".repeat(64)}
    )
  `;
  yield* sql`
    insert into public_source_documents (
      document_id, source_id, raw_artifact_id, canonical_url, external_id, title,
      text, language, published_at, discovered_at, fetched_at, document_type,
      content_hash, text_char_count
    ) values (
      'public-document-1', 'official-marketplace-source', ${artifactId},
      'https://example.test/publication', 'publication-1', 'Public publication',
      ${documentText}, 'fr-FR', now(), now(), now(), 'publication',
      encode(digest(convert_to(${documentText}, 'UTF8'), 'sha256'), 'hex'), ${documentText.length}
    )
  `;
  yield* sql`
    insert into public_source_items (
      source_id, canonical_url, external_id, title, published_at, discovered_at,
      current_content_hash, latest_document_id, latest_raw_artifact_id,
      last_fetched_at, last_successful_fetch_at
    ) values (
      'official-marketplace-source', 'https://example.test/publication', 'publication-1',
      'Public publication', now(), now(), encode(digest(convert_to(${documentText}, 'UTF8'), 'sha256'), 'hex'), 'public-document-1',
      ${artifactId}, now(), now()
    )
  `;
});

describe.skipIf(!isBun || !databaseUrl)("workspace platform APIs", () => {
  beforeAll(async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(`create database ${quote(databaseName)}`).withoutTransform;
      }),
      "postgres",
    );
    await runDb(migrate);
  }, 120_000);

  afterAll(async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName}`;
        yield* sql.unsafe(`drop database if exists ${quote(databaseName)}`).withoutTransform;
      }),
      "postgres",
    );
  }, 60_000);

  beforeEach(async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          truncate table platform_users, platform_admins, publisher_companies, client_companies,
                         platform_authorization_audit_log, public_sources, jobs cascade
        `;
        yield* seed;
      }),
    );
  });

  it("discovers workspaces and links an email-first publisher invitation only after signed acceptance", async () => {
    const invitationExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
    const create = vi.fn<WorkspaceInvitationProvider["create"]>(async () => ({
      externalId: "inv_member",
      expiresAt: invitationExpiry,
    }));
    const routes = makeWorkspaceMembershipRoutes(pgLayer(), { create });
    const workspaces = await call(routes, "admin-user", "GET", "/v1/me/workspaces");
    expect(workspaces.status).toBe(200);
    await expect(workspaces.json()).resolves.toMatchObject({
      publisherWorkspaces: [{ companyId: publisherCompanyId, role: "admin" }],
      clientWorkspaces: [{ companyId: clientCompanyId, role: "admin" }],
    });

    const invited = await call(
      routes,
      "admin-user",
      "POST",
      `/v1/publisher-companies/${publisherCompanyId}/members`,
      { email: "NEW@Example.Test", role: "member", subscriptionIds: [subscriptionId] },
    );
    expect(invited.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
    const invitationId = ((await invited.json()) as { invitation: { id: string } }).invitation.id;
    const webhookTimestamp = Math.floor(Date.now() / 1_000);

    let event = {
      type: "user.created",
      data: {
        id: "new-user",
        primary_email_address_id: "email_new",
        email_addresses: [
          {
            id: "email_new",
            email_address: "new@example.test",
            verification: { status: "verified" },
          },
        ],
        first_name: "New",
        last_name: "User",
        two_factor_enabled: true,
        updated_at: webhookTimestamp * 1_000,
      },
    } as unknown as WebhookEvent;
    const webhook = makeClerkWebhookRoute(pgLayer(), async () => event);
    const webhookCall = (id: string) => {
      const request = new Request("https://brief.test/v1/identity/clerk/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": id,
          "svix-timestamp": String(webhookTimestamp),
        },
        body: "{}",
      });
      return Effect.runPromise(
        webhook
          .execute(
            request,
            new URL(request.url),
            {},
            {
              query: {},
              headers: { "svix-id": id, "svix-timestamp": String(webhookTimestamp) },
              bodyBytes: new TextEncoder().encode("{}"),
            },
          )
          .pipe(Effect.provide(config())),
      );
    };
    expect((await webhookCall("evt_user")).status).toBe(200);
    event = {
      type: "organizationInvitation.accepted",
      data: {
        id: "inv_member",
        user_id: "new-user",
        organization_id: "org_publisher",
        email_address: "new@example.test",
        role: "org:member",
        private_metadata: { briefWorkspaceInvitationId: invitationId },
        expires_at: invitationExpiry.getTime(),
      },
    } as unknown as WebhookEvent;
    expect((await webhookCall("evt_accept")).status).toBe(200);
    expect((await webhookCall("evt_accept")).status).toBe(200);
    const linked = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ members: number; grants: number }>`
          select
            (select count(*)::int from publisher_company_memberships
              where publisher_company_id = ${publisherCompanyId} and user_id = 'new-user') members,
            (select count(*)::int from publisher_membership_subscription_grants
              where publisher_company_id = ${publisherCompanyId} and user_id = 'new-user') grants
        `)[0]!;
      }),
    );
    expect(linked).toEqual({ members: 1, grants: 1 });
  });

  it("leases one durable invitation identity, reconciles ambiguity, and releases uniqueness only at terminal expiry or revocation", async () => {
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
    const remoteByLocalId = new Map<string, string>();
    let failAfterRemoteCreate = true;
    const create = vi.fn<WorkspaceInvitationProvider["create"]>(async (input) => {
      const externalId =
        remoteByLocalId.get(input.invitationId) ?? `orginv_${remoteByLocalId.size + 1}`;
      remoteByLocalId.set(input.invitationId, externalId);
      if (failAfterRemoteCreate) {
        failAfterRemoteCreate = false;
        throw new Error("socket_closed_after_provider_commit");
      }
      return { externalId, expiresAt };
    });
    const routes = makeWorkspaceMembershipRoutes(pgLayer(), { create });
    const body = {
      email: "durable@example.test",
      role: "member" as const,
      subscriptionAccessIds: [accessId],
    };

    const ambiguous = await call(
      routes,
      "admin-user",
      "POST",
      `/v1/client-companies/${clientCompanyId}/members`,
      body,
    );
    expect(ambiguous.status).toBe(503);
    const afterAmbiguity = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          id: string;
          state: string;
          attempts: number;
          leased: boolean;
        }>`
          select id::text, state, delivery_attempt_count as attempts,
                 delivery_lease_token is not null as leased
          from workspace_invitations
          where client_company_id = ${clientCompanyId}
            and normalized_email = 'durable@example.test'
        `)[0]!;
      }),
    );
    expect(afterAmbiguity).toMatchObject({ state: "creating", attempts: 1, leased: false });

    const recovered = await call(
      routes,
      "admin-user",
      "POST",
      `/v1/client-companies/${clientCompanyId}/members`,
      body,
    );
    expect(recovered.status).toBe(201);
    const recoveredInvitation = (await recovered.json()) as { invitation: { id: string } };
    expect(recoveredInvitation.invitation.id).toBe(afterAmbiguity.id);
    expect(new Set(remoteByLocalId.keys())).toEqual(new Set([afterAmbiguity.id]));

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update workspace_invitations set state = 'revoked', updated_at = now()
          where id = ${afterAmbiguity.id}
        `;
      }),
    );
    const reinvited = await call(
      routes,
      "admin-user",
      "POST",
      `/v1/client-companies/${clientCompanyId}/members`,
      body,
    );
    expect(reinvited.status).toBe(201);
    const reinvitedId = ((await reinvited.json()) as { invitation: { id: string } }).invitation.id;
    expect(reinvitedId).not.toBe(afterAmbiguity.id);

    const expiredId = crypto.randomUUID();
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into workspace_invitations (
            id, workspace_kind, client_company_id, normalized_email, role,
            client_subscription_access_ids, clerk_invitation_id, state,
            invited_by_user_id, expires_at
          ) values (
            ${expiredId}, 'client', ${clientCompanyId}, 'expired@example.test', 'member',
            ${[accessId]}::uuid[], 'orginv_expired', 'pending', 'admin-user',
            now() - interval '1 minute'
          )
        `;
      }),
    );
    const afterExpiry = await call(
      routes,
      "admin-user",
      "POST",
      `/v1/client-companies/${clientCompanyId}/members`,
      { ...body, email: "expired@example.test" },
    );
    expect(afterExpiry.status).toBe(201);
    const newExpiryId = ((await afterExpiry.json()) as { invitation: { id: string } }).invitation
      .id;
    expect(newExpiryId).not.toBe(expiredId);
    const expiryStates = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ id: string; state: string }>`
          select id::text, state from workspace_invitations
          where id in (${expiredId}, ${newExpiryId}) order by id
        `;
      }),
    );
    expect(new Map(expiryStates.map((row) => [row.id, row.state]))).toEqual(
      new Map([
        [expiredId, "expired"],
        [newExpiryId, "pending"],
      ]),
    );
  });

  it("reconciles a provider-created webhook before request finalization without duplicating delivery", async () => {
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
    const create = vi.fn<WorkspaceInvitationProvider["create"]>(async (input) => {
      const externalId = "orginv_webhook_first";
      await runDb(
        acceptClerkWebhook({
          eventId: `evt-created-${input.invitationId}`,
          eventTimestamp: Math.floor(Date.now() / 1_000),
          payloadHash: "c".repeat(64),
          event: {
            type: "organizationInvitation.created",
            data: {
              id: externalId,
              organization_id: input.organizationId,
              email_address: input.email,
              role: input.organizationRole,
              private_metadata: { briefWorkspaceInvitationId: input.invitationId },
              expires_at: expiresAt.getTime(),
            },
          } as unknown as WebhookEvent,
        }),
      );
      return { externalId, expiresAt };
    });
    const routes = makeWorkspaceMembershipRoutes(pgLayer(), { create });
    const response = await call(
      routes,
      "admin-user",
      "POST",
      `/v1/client-companies/${clientCompanyId}/members`,
      { email: "webhook-first@example.test", role: "member", subscriptionAccessIds: [accessId] },
    );
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledOnce();
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ state: string; externalId: string; attempts: number }>`
          select state, clerk_invitation_id as "externalId", delivery_attempt_count as attempts
          from workspace_invitations
          where normalized_email = 'webhook-first@example.test'
        `)[0]!;
      }),
    );
    expect(state).toEqual({ state: "pending", externalId: "orginv_webhook_first", attempts: 1 });
  });

  it("projects Clerk user lifecycle in timestamp order and requires a newer create for explicit restore", async () => {
    const base = Math.floor(Date.now() / 1_000);
    const userEvent = (
      type: "user.created" | "user.updated",
      userId: string,
      email: string,
      version: number,
    ) =>
      ({
        type,
        data: {
          id: userId,
          primary_email_address_id: `email-${userId}`,
          email_addresses: [
            {
              id: `email-${userId}`,
              email_address: email,
              verification: { status: "verified" },
            },
          ],
          first_name: userId,
          last_name: null,
          two_factor_enabled: false,
          updated_at: version,
        },
      }) as unknown as WebhookEvent;
    const deletedEvent = (userId: string) =>
      ({ type: "user.deleted", data: { id: userId, deleted: true } }) as unknown as WebhookEvent;
    const project = (
      eventId: string,
      eventTimestamp: number,
      event: WebhookEvent,
      payloadHash = "d".repeat(64),
    ) => runDb(acceptClerkWebhook({ eventId, eventTimestamp, payloadHash, event }));

    await expect(
      project(
        "evt-order-created",
        base + 100,
        userEvent("user.created", "ordered-user", "initial@example.test", (base + 100) * 1_000),
      ),
    ).resolves.toBe("processed");
    await project("evt-order-deleted", base + 300, deletedEvent("ordered-user"));
    await project(
      "evt-order-newer-update",
      base + 400,
      userEvent(
        "user.updated",
        "ordered-user",
        "must-not-restore@example.test",
        (base + 400) * 1_000,
      ),
    );
    await project(
      "evt-order-old-create",
      base + 200,
      userEvent("user.created", "ordered-user", "old-create@example.test", (base + 500) * 1_000),
    );
    const deletedProjection = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          email: string;
          recoveryDeletedAt: Date | null;
          lifecycle: string;
          lifecycleTimestamp: number;
        }>`
          select users.primary_email as email,
                 users.recovery_deleted_at as "recoveryDeletedAt",
                 lifecycle.state as lifecycle,
                 lifecycle.event_timestamp::float8 as "lifecycleTimestamp"
          from platform_users users
          join clerk_user_lifecycle_state lifecycle on lifecycle.clerk_user_id = users.clerk_user_id
          where users.id = 'ordered-user'
        `)[0]!;
      }),
    );
    expect(deletedProjection).toMatchObject({
      email: "initial@example.test",
      lifecycle: "deleted",
      lifecycleTimestamp: base + 300,
    });
    expect(deletedProjection.recoveryDeletedAt).toBeInstanceOf(Date);

    const restoreEvent = userEvent(
      "user.created",
      "ordered-user",
      "restored@example.test",
      (base + 600) * 1_000,
    );
    await expect(project("evt-order-restored", base + 500, restoreEvent)).resolves.toBe(
      "processed",
    );
    await expect(project("evt-order-restored", base + 500, restoreEvent)).resolves.toBe(
      "duplicate",
    );
    await expect(
      project("evt-order-restored", base + 500, restoreEvent, "e".repeat(64)),
    ).resolves.toBe("conflict");

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update platform_users
          set recovery_deleted_at = now(), purge_after = now() + interval '180 days'
          where id = 'ordered-user'
        `;
      }),
    );
    await project(
      "evt-order-create-does-not-clear-product-deletion",
      base + 700,
      userEvent("user.created", "ordered-user", "profile@example.test", (base + 700) * 1_000),
    );

    await project("evt-delete-first-same-time", base + 800, deletedEvent("delete-first-user"));
    await project(
      "evt-create-second-same-time",
      base + 800,
      userEvent(
        "user.created",
        "delete-first-user",
        "delete-first@example.test",
        (base + 800) * 1_000,
      ),
    );
    await project(
      "evt-create-first-same-time",
      base + 900,
      userEvent(
        "user.created",
        "create-first-user",
        "create-first@example.test",
        (base + 900) * 1_000,
      ),
    );
    await project("evt-delete-second-same-time", base + 900, deletedEvent("create-first-user"));

    const final = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          productDeletionRetained: boolean;
          deleteFirstUserExists: boolean;
          deleteFirstState: string;
          createFirstDeleted: boolean;
          createFirstState: string;
        }>`
          select
            (select recovery_deleted_at is not null from platform_users
              where id = 'ordered-user') as "productDeletionRetained",
            exists(select 1 from platform_users where id = 'delete-first-user')
              as "deleteFirstUserExists",
            (select state from clerk_user_lifecycle_state where clerk_user_id = 'delete-first-user')
              as "deleteFirstState",
            (select recovery_deleted_at is not null from platform_users
              where id = 'create-first-user') as "createFirstDeleted",
            (select state from clerk_user_lifecycle_state where clerk_user_id = 'create-first-user')
              as "createFirstState"
        `)[0]!;
      }),
    );
    expect(final).toEqual({
      productDeletionRetained: true,
      deleteFirstUserExists: false,
      deleteFirstState: "deleted",
      createFirstDeleted: true,
      createFirstState: "deleted",
    });
    await expect(
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update clerk_user_lifecycle_state
            set event_timestamp = event_timestamp - 1
            where clerk_user_id = 'ordered-user'
          `;
        }),
      ),
    ).rejects.toThrow();
    await expect(
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`delete from clerk_user_lifecycle_state where clerk_user_id = 'ordered-user'`;
        }),
      ),
    ).rejects.toThrow();
    await expect(
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update platform_users
            set clerk_profile_version = clerk_profile_version - 1
            where id = 'ordered-user'
          `;
        }),
      ),
    ).rejects.toThrow();
  });

  it("serializes late acceptance with expiry and client-company deletion without granting active access", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const insertInvitation = (input: {
      companyId: string;
      organizationId: string;
      invitationId: string;
      externalId: string;
      email: string;
      expiresAt: Date;
    }) =>
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into client_companies (id, name, clerk_organization_id)
            values (${input.companyId}, ${`Race ${input.companyId}`}, ${input.organizationId})
          `;
          yield* sql`
            insert into client_company_ai_settings (company_id) values (${input.companyId})
          `;
          yield* sql`
            insert into workspace_invitations (
              id, workspace_kind, client_company_id, normalized_email, role,
              clerk_invitation_id, state, invited_by_user_id, expires_at
            ) values (
              ${input.invitationId}, 'client', ${input.companyId}, ${input.email}, 'member',
              ${input.externalId}, 'pending', 'admin-user', ${input.expiresAt}
            )
          `;
        }),
      );
    const acceptanceEvent = (input: {
      organizationId: string;
      invitationId: string;
      externalId: string;
      email: string;
      userId: string;
      expiresAt: Date;
    }) =>
      ({
        type: "organizationInvitation.accepted",
        data: {
          id: input.externalId,
          user_id: input.userId,
          organization_id: input.organizationId,
          email_address: input.email,
          role: "org:member",
          private_metadata: { briefWorkspaceInvitationId: input.invitationId },
          expires_at: input.expiresAt.getTime(),
        },
      }) as unknown as WebhookEvent;

    const lateCompanyId = crypto.randomUUID();
    const lateInvitationId = crypto.randomUUID();
    const lateExpiry = new Date((now - 10) * 1_000);
    await insertInvitation({
      companyId: lateCompanyId,
      organizationId: "org_late",
      invitationId: lateInvitationId,
      externalId: "orginv_late",
      email: "member@example.test",
      expiresAt: lateExpiry,
    });
    await runDb(
      acceptClerkWebhook({
        eventId: "evt-late-acceptance",
        eventTimestamp: now,
        payloadHash: "f".repeat(64),
        event: acceptanceEvent({
          organizationId: "org_late",
          invitationId: lateInvitationId,
          externalId: "orginv_late",
          email: "member@example.test",
          userId: "member-user",
          expiresAt: lateExpiry,
        }),
      }),
    );
    const late = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ state: string; members: number }>`
          select
            (select state from workspace_invitations where id = ${lateInvitationId}) state,
            (select count(*)::int from client_company_memberships
              where company_id = ${lateCompanyId}) members
        `)[0]!;
      }),
    );
    expect(late).toEqual({ state: "expired", members: 0 });

    for (let index = 0; index < 8; index += 1) {
      const companyId = crypto.randomUUID();
      const invitationId = crypto.randomUUID();
      const organizationId = `org_delete_race_${index}`;
      const externalId = `orginv_delete_race_${index}`;
      const email = `delete-race-${index}@example.test`;
      const userId = `delete-race-user-${index}`;
      const expiresAt = new Date((now + 3_600) * 1_000);
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into platform_users (id, primary_email, display_name, clerk_user_id)
            values (${userId}, ${email}, ${userId}, ${`clerk-${userId}`})
          `;
        }),
      );
      await insertInvitation({
        companyId,
        organizationId,
        invitationId,
        externalId,
        email,
        expiresAt,
      });
      await Promise.all([
        runDb(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update client_companies
              set recovery_deleted_at = now(), purge_after = now() + interval '180 days'
              where id = ${companyId}
            `;
          }),
        ),
        runDb(
          acceptClerkWebhook({
            eventId: `evt-delete-race-${index}`,
            eventTimestamp: now,
            payloadHash: index.toString(16).padStart(64, "0"),
            event: acceptanceEvent({
              organizationId,
              invitationId,
              externalId,
              email,
              userId,
              expiresAt,
            }),
          }),
        ),
      ]);
      const projection = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ state: string; authorized: boolean }>`
            select invitation.state,
                   exists(
                     select 1 from client_company_memberships membership
                     join client_companies company on company.id = membership.company_id
                     where membership.company_id = ${companyId}
                       and membership.user_id = ${userId}
                       and membership.revoked_at is null
                       and company.recovery_deleted_at is null
                   ) as authorized
            from workspace_invitations invitation where invitation.id = ${invitationId}
          `)[0]!;
        }),
      );
      expect(["accepted", "revoked"]).toContain(projection.state);
      expect(projection.authorized).toBe(false);
    }
  });

  it("counts only live identities for member lists and last-admin protection", async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values
            ('second-admin', 'second-admin@example.test', 'Second Admin', 'clerk-second-admin'),
            ('ghost-admin', 'ghost-admin@example.test', 'Ghost Admin', 'clerk-ghost-admin')
        `;
        yield* sql`
          update platform_users
          set recovery_deleted_at = now(), purge_after = now() + interval '180 days',
              purged_at = now()
          where id = 'ghost-admin'
        `;
        yield* sql`
          insert into publisher_company_memberships (
            publisher_company_id, user_id, role, accepted_at, invited_email
          ) values
            (${publisherCompanyId}, 'second-admin', 'admin', now(), 'second-admin@example.test'),
            (${publisherCompanyId}, 'ghost-admin', 'admin', now(), 'ghost-admin@example.test')
        `;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values
            (${clientCompanyId}, 'second-admin', 'admin'),
            (${clientCompanyId}, 'ghost-admin', 'admin')
        `;
      }),
    );
    const routes = makeWorkspaceMembershipRoutes(pgLayer());

    for (const [kind, companyId] of [
      ["publisher", publisherCompanyId],
      ["client", clientCompanyId],
    ] as const) {
      const listed = await call(
        routes,
        "admin-user",
        "GET",
        `/v1/${kind}-companies/${companyId}/members`,
      );
      expect(listed.status).toBe(200);
      const listedBody = (await listed.json()) as { members: readonly { userId: string }[] };
      expect(listedBody.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ userId: "admin-user" }),
          expect.objectContaining({ userId: "second-admin" }),
        ]),
      );
      expect(listedBody.members).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ userId: "ghost-admin" })]),
      );

      const removedSecond = await call(
        routes,
        "admin-user",
        "DELETE",
        `/v1/${kind}-companies/${companyId}/members/second-admin`,
      );
      expect(removedSecond.status).toBe(204);

      const soleLiveAdmin = await call(
        routes,
        "admin-user",
        "DELETE",
        `/v1/${kind}-companies/${companyId}/members/admin-user`,
      );
      expect(soleLiveAdmin.status).toBe(409);
      await expect(soleLiveAdmin.json()).resolves.toEqual({ code: "last_admin_required" });
    }
  });

  it("revokes a client membership without deleting retained private/shared chat identity under concurrent reads", async () => {
    const chats = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const privateRows = yield* sql<{ id: string }>`
          insert into chats (company_id, user_id, memory_mode)
          values (${clientCompanyId}, 'member-user', 'private_owner') returning id::text
        `;
        const sharedRows = yield* sql<{ id: string }>`
          insert into chats (company_id, user_id, memory_mode, shared_at)
          values (${clientCompanyId}, 'admin-user', 'disabled', now()) returning id::text
        `;
        yield* sql`
          insert into chat_subscription_sources (
            chat_id, access_id, client_company_id, subscription_id
          ) values (
            ${privateRows[0]!.id}, ${accessId}, ${clientCompanyId}, ${subscriptionId}
          )
        `;
        const notificationRows = yield* sql<{ id: string }>`
          insert into platform_notifications (
            client_company_id, user_id, kind, deduplication_key
          ) values (
            ${clientCompanyId}, 'member-user', 'usage_limit_reached',
            ${`membership-revoke-${crypto.randomUUID()}`}
          ) returning id::text
        `;
        return {
          privateId: privateRows[0]!.id,
          sharedId: sharedRows[0]!.id,
          notificationId: notificationRows[0]!.id,
        };
      }),
    );
    const memberIdentity = {
      mode: "clerk" as const,
      userId: "member-user",
      organizationId: "org_client",
    };
    await expect(
      runDb(hasProductChatAccess(memberIdentity, chats.privateId, "read")),
    ).resolves.toBe(true);
    await expect(runDb(hasProductChatAccess(memberIdentity, chats.sharedId, "read"))).resolves.toBe(
      true,
    );

    const routes = makeWorkspaceMembershipRoutes(pgLayer());
    let signalHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    let releaseHolder!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(
                hashtext(${`brief:client-members:${clientCompanyId}`})
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
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return (yield* sql<{ count: number }>`
              select count(*)::int count from pg_locks
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
    let removal!: Promise<Response>;
    let send!: Promise<unknown>;
    try {
      removal = call(
        routes,
        "admin-user",
        "DELETE",
        `/v1/client-companies/${clientCompanyId}/members/member-user`,
      );
      await waitForAdvisoryWaiters(1);
      send = runDb(
        createUserMessageAndRun(
          "member-user",
          {
            text: "Must not be accepted after revocation",
            locale: "en-US",
            market: "US",
            webSearchEnabled: false,
          },
          {
            authMode: "clerk",
            webResearchProvider: null,
            aiWebMaxDomainFilters: 10,
            aiProviderServiceId: "zai_coding_plan_official",
            aiProviderEndpointIdentity: "zai_coding_plan_official:https://api.z.ai/api/coding/paas/v4",
          },
          memberIdentity.organizationId,
          chats.privateId,
        ),
      );
      await waitForAdvisoryWaiters(2);
    } finally {
      releaseHolder();
      await holder;
    }
    expect((await removal).status).toBe(204);
    await expect(send).resolves.toEqual({ kind: "forbidden" });

    await expect(
      runDb(hasProductChatAccess(memberIdentity, chats.privateId, "read")),
    ).resolves.toBe(false);
    await expect(runDb(hasProductChatAccess(memberIdentity, chats.sharedId, "read"))).resolves.toBe(
      false,
    );
    const retained = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          memberships: number;
          activeMemberships: number;
          chats: number;
          activeGrants: number;
          acceptedMessages: number;
          acceptedRuns: number;
        }>`
          select
            (select count(*)::int from client_company_memberships
              where company_id = ${clientCompanyId} and user_id = 'member-user') memberships,
            (select count(*)::int from client_company_memberships
              where company_id = ${clientCompanyId} and user_id = 'member-user'
                and revoked_at is null) "activeMemberships",
            (select count(*)::int from chats
              where company_id = ${clientCompanyId}
                and user_id in ('member-user', 'admin-user')) chats,
            (select count(*)::int from client_employee_subscription_grants
              where client_company_id = ${clientCompanyId} and user_id = 'member-user'
                and revoked_at is null) "activeGrants",
            (select count(*)::int from chat_messages
              where chat_id = ${chats.privateId}) "acceptedMessages",
            (select count(*)::int from ai_runs
              where chat_id = ${chats.privateId}) "acceptedRuns"
        `)[0]!;
      }),
    );
    expect(retained).toEqual({
      memberships: 1,
      activeMemberships: 0,
      chats: 2,
      activeGrants: 0,
      acceptedMessages: 0,
      acceptedRuns: 0,
    });

    const listed = await call(
      routes,
      "admin-user",
      "GET",
      `/v1/client-companies/${clientCompanyId}/members`,
    );
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { members: readonly { userId: string }[] };
    expect(listedBody.members).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: "member-user" })]),
    );

    const clientRoutes = makeClientWorkspaceRoutes(pgLayer());
    const notifications = await call(
      clientRoutes,
      "member-user",
      "GET",
      `/v1/client-companies/${clientCompanyId}/notifications`,
    );
    expect(notifications.status).toBe(404);
    const markRead = await call(
      clientRoutes,
      "member-user",
      "POST",
      `/v1/notifications/${chats.notificationId}/read`,
    );
    expect(markRead.status).toBe(404);
    const billingRead = await call(
      makeBillingRoutes(pgLayer()),
      "member-user",
      "GET",
      `/v1/client-companies/${clientCompanyId}/ai-usage`,
    );
    expect(billingRead.status).toBe(404);
    const notificationReadAt = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readAt: Date | null }>`
          select read_at as "readAt" from platform_notifications where id = ${chats.notificationId}
        `)[0]!.readAt;
      }),
    );
    expect(notificationReadAt).toBeNull();

    const reinvitationId = crypto.randomUUID();
    const reinvitationExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into workspace_invitations (
            id, workspace_kind, client_company_id, normalized_email, role,
            client_subscription_access_ids, clerk_invitation_id, state,
            invited_by_user_id, expires_at
          ) values (
            ${reinvitationId}, 'client', ${clientCompanyId}, 'member@example.test', 'member',
            ${[accessId]}::uuid[], 'orginv_member_reactivation', 'pending',
            'admin-user', ${reinvitationExpiry}
          )
        `;
      }),
    );
    await runDb(
      acceptClerkWebhook({
        eventId: "evt-member-reactivation",
        eventTimestamp: Math.floor(Date.now() / 1_000),
        payloadHash: "9".repeat(64),
        event: {
          type: "organizationInvitation.accepted",
          data: {
            id: "orginv_member_reactivation",
            user_id: "member-user",
            organization_id: "org_client",
            email_address: "member@example.test",
            role: "org:member",
            private_metadata: { briefWorkspaceInvitationId: reinvitationId },
            expires_at: reinvitationExpiry.getTime(),
          },
        } as unknown as WebhookEvent,
      }),
    );
    const reactivated = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ membershipActive: boolean; grantActive: boolean }>`
          select
            exists(
              select 1 from client_company_memberships
              where company_id = ${clientCompanyId} and user_id = 'member-user'
                and revoked_at is null
            ) as "membershipActive",
            exists(
              select 1 from client_employee_subscription_grants
              where client_company_id = ${clientCompanyId} and user_id = 'member-user'
                and access_id = ${accessId} and revoked_at is null
            ) as "grantActive"
        `)[0]!;
      }),
    );
    expect(reactivated).toEqual({ membershipActive: true, grantActive: true });
    await expect(
      runDb(hasProductChatAccess(memberIdentity, chats.privateId, "read")),
    ).resolves.toBe(true);
  });

  it("enforces the publisher content/client/analytics capability matrix and admin-only MFA", async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values
            ('publisher-manager', 'publisher-manager@example.test', 'Manager', 'clerk-manager'),
            ('publisher-member', 'publisher-member@example.test', 'Member', 'clerk-publisher-member')
        `;
        yield* sql`
          insert into publisher_company_memberships (
            publisher_company_id, user_id, role, accepted_at
          ) values
            (${publisherCompanyId}, 'publisher-manager', 'manager', now()),
            (${publisherCompanyId}, 'publisher-member', 'member', now())
        `;
        yield* sql`
          insert into publisher_membership_subscription_grants (
            publisher_company_id, user_id, subscription_id, granted_by_user_id
          ) values
            (${publisherCompanyId}, 'publisher-manager', ${subscriptionId}, 'admin-user'),
            (${publisherCompanyId}, 'publisher-member', ${subscriptionId}, 'admin-user')
        `;
      }),
    );
    const identity = (userId: string, mfaVerified: boolean) => ({
      userId,
      organizationId: null,
      sessionId: `capability-${userId}`,
      mfaVerified,
      mode: "clerk" as const,
    });
    const manager = identity("publisher-manager", false);
    const member = identity("publisher-member", false);
    const adminWithoutMfa = identity("admin-user", false);

    await expect(runDb(listPublisherIssues(member, subscriptionId))).resolves.toEqual([]);
    await expect(
      runDb(
        createPublisherIssue({
          identity: member,
          subscriptionId,
          title: "Assigned member content",
          publicationAt: null,
          historical: false,
          requestId: crypto.randomUUID(),
        }),
      ),
    ).resolves.toMatchObject({ title: "Assigned member content" });
    await expect(runDb(listPublisherClientAccesses(member, subscriptionId))).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(runDb(getPublisherAiPullMetrics(member, subscriptionId))).rejects.toMatchObject({
      code: "forbidden",
    });

    await expect(runDb(listPublisherClientAccesses(manager, subscriptionId))).resolves.toHaveLength(
      1,
    );
    await expect(runDb(getPublisherAiPullMetrics(manager, subscriptionId))).resolves.toEqual({
      metrics: [],
      issueTotals: [],
    });
    await expect(
      runDb(
        createPublisherIssue({
          identity: manager,
          subscriptionId,
          title: "Manager content without MFA",
          publicationAt: null,
          historical: false,
          requestId: crypto.randomUUID(),
        }),
      ),
    ).resolves.toMatchObject({ title: "Manager content without MFA" });
    await expect(
      runDb(
        pausePublisherClientAccess({
          identity: manager,
          accessId,
          deliveryEndAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
          requestId: crypto.randomUUID(),
        }),
      ),
    ).resolves.toMatch(/Z$/u);

    await expect(
      runDb(
        createPublisherIssue({
          identity: adminWithoutMfa,
          subscriptionId,
          title: "Admin content without MFA",
          publicationAt: null,
          historical: false,
          requestId: crypto.randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: "mfa_required" });
  });

  it("rolls back workspace mutations and jobs when their success audit fails", async () => {
    const identity = {
      userId: "admin-user",
      organizationId: null,
      sessionId: "atomic-audit-test",
      mfaVerified: true,
      mode: "demo" as const,
    };
    const auditFailure = () => Effect.fail(new Error("injected_workspace_audit_failure"));

    await expect(
      runDb(
        createPublisherSubscription({
          identity,
          companyId: publisherCompanyId,
          name: "Rollback subscription",
          requestId: crypto.randomUUID(),
          auditSucceeded: () => auditFailure(),
        }),
      ),
    ).rejects.toThrow("injected_workspace_audit_failure");
    await expect(
      runDb(
        createPublisherIssue({
          identity,
          subscriptionId,
          title: "Rollback issue",
          publicationAt: null,
          historical: false,
          requestId: crypto.randomUUID(),
          auditSucceeded: () => auditFailure(),
        }),
      ),
    ).rejects.toThrow("injected_workspace_audit_failure");

    const { draftIssueId, documentId } = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const draftIssueId = crypto.randomUUID();
        const documentId = crypto.randomUUID();
        yield* sql`
          insert into publisher_issues (
            id, subscription_id, title, status, created_by_user_id
          ) values (${draftIssueId}, ${subscriptionId}, 'Draft rollback', 'draft', 'admin-user')
        `;
        yield* sql`
          insert into brief_documents (
            id, issue_id, title, original_file_name, object_key, media_type,
            byte_size, sha256_hex, upload_completed_at, created_by_user_id
          ) values (
            ${documentId}, ${draftIssueId}, 'Rollback PDF', 'rollback.pdf',
            ${`publisher-issues/${draftIssueId}/documents/${documentId}.pdf`},
            'application/pdf', 5, ${"c".repeat(64)}, now(), 'admin-user'
          )
        `;
        return { draftIssueId, documentId };
      }),
    );
    await expect(
      runDb(
        deletePublisherDocument({
          identity,
          issueId: draftIssueId,
          documentId,
          requestId: crypto.randomUUID(),
          auditSucceeded: auditFailure(),
        }),
      ),
    ).rejects.toThrow("injected_workspace_audit_failure");
    await expect(
      runDb(
        updateNotificationPreferences({
          identity,
          companyId: clientCompanyId,
          preferences: {
            locale: "en-US",
            emailIssuePublished: false,
            emailDeliveryReminders: false,
            emailUsageLimits: false,
          },
          requestId: crypto.randomUUID(),
          auditSucceeded: auditFailure(),
        }),
      ),
    ).rejects.toThrow("injected_workspace_audit_failure");

    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly subscriptions: number;
          readonly issues: number;
          readonly documentDeleted: boolean;
          readonly purgeJobs: number;
          readonly preferences: number;
        }>`
          select
            (select count(*)::int from publisher_subscriptions
             where name = 'Rollback subscription') as subscriptions,
            (select count(*)::int from publisher_issues where title = 'Rollback issue') as issues,
            (select deleted_at is not null from brief_documents where id = ${documentId})
              as "documentDeleted",
            (select count(*)::int from jobs where kind = 'purge_deleted_files') as "purgeJobs",
            (select count(*)::int from notification_preferences
             where client_company_id = ${clientCompanyId} and user_id = 'admin-user') as preferences
        `)[0]!;
      }),
    );
    expect(state).toEqual({
      subscriptions: 0,
      issues: 0,
      documentDeleted: false,
      purgeJobs: 0,
      preferences: 0,
    });
  });

  it("returns an immutable issue-detail snapshot after membership is revoked", async () => {
    const issueId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into publisher_issues (
            id, subscription_id, title, status, created_by_user_id
          ) values (
            ${issueId}, ${subscriptionId}, 'Atomic issue detail', 'draft', 'admin-user'
          )
        `;
        yield* sql`
          insert into brief_documents (
            id, issue_id, title, original_file_name, object_key, media_type,
            byte_size, sha256_hex, upload_completed_at, created_by_user_id
          ) values (
            ${documentId}, ${issueId}, 'Atomic document', 'atomic.pdf',
            'atomic/issue-detail.pdf', 'application/pdf', 4, ${"a".repeat(64)}, now(),
            'admin-user'
          )
        `;
        yield* sql`
          update publisher_issues
          set status = 'published', publication_at = now(), published_at = now()
          where id = ${issueId}
        `;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into issue_deliveries (
                issue_id, subscription_id, access_id, client_company_id, historical
              ) values (${issueId}, ${subscriptionId}, ${accessId}, ${clientCompanyId}, false)
            `;
            yield* sql`
              insert into issue_delivery_recipients (
                issue_id, client_company_id, user_id, delivered_at
              )
              select issue_id, client_company_id, 'member-user', delivered_at
              from issue_deliveries
              where issue_id = ${issueId} and client_company_id = ${clientCompanyId}
            `;
          }),
        );
      }),
    );
    const routes = makeClientWorkspaceRoutes(pgLayer());
    const before = await call(routes, "member-user", "GET", `/v1/issues/${issueId}`);
    expect(before.status).toBe(200);
    await expect(before.json()).resolves.toMatchObject({
      issue: { id: issueId, title: "Atomic issue detail" },
      documents: [{ id: documentId, issueId }],
    });

    const reads = Array.from({ length: 20 }, () =>
      call(routes, "member-user", "GET", `/v1/issues/${issueId}`),
    );
    const revocation = runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(hashtext(${`brief:client-members:${clientCompanyId}`}))
            `;
            yield* sql`
              update client_company_memberships
              set revoked_at = now(), revoked_by_user_id = 'admin-user'
              where company_id = ${clientCompanyId} and user_id = 'member-user'
            `;
            yield* sql`
              update client_employee_subscription_grants
              set revoked_at = now(), revoked_by_user_id = 'admin-user'
              where client_company_id = ${clientCompanyId} and user_id = 'member-user'
            `;
          }),
        );
      }),
    );
    const responses = await Promise.all(reads);
    await revocation;
    for (const response of responses) {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        issue: { id: issueId },
        documents: [{ id: documentId, issueId }],
      });
    }
    expect((await call(routes, "member-user", "GET", `/v1/issues/${issueId}`)).status).toBe(200);
  });

  it("recoverably deletes every draft issue object and cancels publication/extraction races", async () => {
    const { issueId, documentIds } = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const issueId = crypto.randomUUID();
        const documentIds = [crypto.randomUUID(), crypto.randomUUID()] as const;
        yield* sql`
          insert into publisher_issues (
            id, subscription_id, title, status, created_by_user_id
          ) values (${issueId}, ${subscriptionId}, 'Concurrent deletion', 'draft', 'admin-user')
        `;
        for (const [index, documentId] of documentIds.entries()) {
          yield* sql`
            insert into brief_documents (
              id, issue_id, title, original_file_name, object_key, media_type,
              byte_size, sha256_hex, upload_completed_at, created_by_user_id
            ) values (
              ${documentId}, ${issueId}, ${`Document ${index}`}, ${`document-${index}.pdf`},
              ${`publisher-issues/${issueId}/documents/${documentId}.pdf`},
              'application/pdf', 5, ${String(index + 1).repeat(64)}, now(), 'admin-user'
            )
          `;
          yield* sql`
            insert into jobs (kind, payload, unique_key)
            values (
              'extract_pdf_text', ${sql.json({ documentId })},
              ${`extract_pdf_text:${documentId}:race`}
            )
          `;
        }
        return { issueId, documentIds };
      }),
    );
    const routes = makePublisherWorkspaceRoutes(pgLayer());
    const [publish, deleted] = await Promise.all([
      call(routes, "admin-user", "POST", `/v1/publisher-issues/${issueId}/publish`),
      call(routes, "admin-user", "DELETE", `/v1/publisher-issues/${issueId}`),
    ]);
    expect([202, 404, 409]).toContain(publish.status);
    expect(deleted.status).toBe(204);

    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly issueRows: number;
          readonly issueDeleted: boolean;
          readonly documents: number;
          readonly deletedDocuments: number;
          readonly cancelledJobs: number;
          readonly purgeJobs: number;
        }>`
          select
            (select count(*)::int from publisher_issues where id = ${issueId}) as "issueRows",
            (select deleted_at is not null from publisher_issues where id = ${issueId})
              as "issueDeleted",
            (select count(*)::int from brief_documents where issue_id = ${issueId}) as documents,
            (select count(*)::int from brief_documents
             where issue_id = ${issueId} and deleted_at is not null) as "deletedDocuments",
            (select count(*)::int from jobs
             where kind in ('extract_pdf_text', 'publish_scheduled_issue')
               and status = 'completed' and last_error = 'cancelled_publisher_issue_deleted')
              as "cancelledJobs",
            (select count(*)::int from jobs where kind = 'purge_deleted_files') as "purgeJobs"
        `)[0]!;
      }),
    );
    expect(state).toEqual({
      issueRows: 1,
      issueDeleted: true,
      documents: documentIds.length,
      deletedDocuments: documentIds.length,
      cancelledJobs: expect.any(Number),
      purgeJobs: 1,
    });
    expect(state.cancelledJobs).toBeGreaterThanOrEqual(documentIds.length);

    const listed = await call(
      routes,
      "admin-user",
      "GET",
      `/v1/publisher-subscriptions/${subscriptionId}/issues`,
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.not.toEqual(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ id: issueId })]),
      }),
    );
  });

  it("replays one issue-scoped publisher upload reservation and rejects changed payloads", async () => {
    const issueId = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const id = crypto.randomUUID();
        yield* sql`
          insert into publisher_issues (id, subscription_id, title, status, created_by_user_id)
          values (${id}, ${subscriptionId}, 'Idempotent upload', 'draft', 'admin-user')
        `;
        return id;
      }),
    );
    const bytes = new TextEncoder().encode("%PDF-idempotent-upload");
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const objects = new Set<string>();
    let puts = 0;
    let releaseFirstPut!: () => void;
    const firstPutReleased = new Promise<void>((resolve) => {
      releaseFirstPut = resolve;
    });
    let firstPutStarted!: () => void;
    const firstPutStartedSignal = new Promise<void>((resolve) => {
      firstPutStarted = resolve;
    });
    let observedClock:
      | { readonly state: string; readonly leaseSeconds: number; readonly reconcileSeconds: number }
      | undefined;
    const store = {
      put: async ({
        objectKey,
        signal,
      }: {
        readonly objectKey: string;
        readonly signal: AbortSignal;
      }) => {
        if (signal.aborted) throw signal.reason;
        puts += 1;
        if (puts === 1) {
          firstPutStarted();
          await firstPutReleased;
        }
        if (observedClock === undefined) {
          observedClock = await runDb(
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              return (yield* sql<{
                readonly state: string;
                readonly leaseSeconds: number;
                readonly reconcileSeconds: number;
              }>`
                select state,
                       extract(epoch from lease_expires_at - now())::float8 as "leaseSeconds",
                       extract(epoch from reconcile_after - now())::float8 as "reconcileSeconds"
                from publisher_document_upload_intents
                where issue_id = ${issueId}
                order by created_at
                limit 1
              `)[0];
            }),
          );
        }
        objects.add(objectKey);
      },
      head: async ({
        objectKey,
        signal,
      }: {
        readonly objectKey: string;
        readonly signal: AbortSignal;
      }) => {
        if (signal.aborted) throw signal.reason;
        return objects.has(objectKey)
          ? { byteSize: bytes.byteLength, sha256Hex: hash, mediaType: "application/pdf" as const }
          : null;
      },
      delete: async ({ signal }: { readonly signal: AbortSignal }) => {
        if (signal.aborted) throw signal.reason;
      },
    };
    const identity = {
      userId: "admin-user",
      organizationId: null,
      sessionId: "upload-idempotency-session",
      mfaVerified: true,
      mode: "demo" as const,
    };
    const uploadVariant = (input: {
      readonly requestId: string;
      readonly title?: string;
      readonly fileName?: string;
      readonly identity?: {
        readonly userId: string;
        readonly organizationId: string | null;
        readonly sessionId: string;
        readonly mfaVerified: boolean;
        readonly mode: "demo";
      };
      readonly body?: Uint8Array;
      readonly expectedHash?: string;
      readonly declaredBytes?: number;
      readonly issueId?: string;
      readonly idempotencyKey?: string;
      readonly store?: typeof store | null;
    }) =>
      runDb(
        uploadPublisherDocument({
          identity: input.identity ?? identity,
          issueId: input.issueId ?? issueId,
          idempotencyKey: input.idempotencyKey ?? "publisher-upload-idempotency-01",
          title: input.title ?? "Stable title",
          fileName: input.fileName ?? "stable.pdf",
          expectedHash: input.expectedHash ?? hash,
          declaredBytes: input.declaredBytes ?? (input.body ?? bytes).byteLength,
          body: input.body ?? bytes,
          requestId: input.requestId,
          store: input.store === undefined ? store : input.store,
        }),
      );
    const upload = (requestId: string, nextTitle = "Stable title") =>
      uploadVariant({ requestId, title: nextTitle });
    const hostNow = Date.now;
    Date.now = () => hostNow() + 365 * 86_400_000;
    let first: Awaited<ReturnType<typeof upload>>;
    let concurrent: Awaited<ReturnType<typeof upload>>;
    try {
      const firstPromise = upload(crypto.randomUUID());
      await firstPutStartedSignal;
      const concurrentPromise = upload(crypto.randomUUID());
      await Bun.sleep(50);
      // The concurrent request is held behind the fresh two-minute lease,
      // even though this sequence is intentionally slower than the former
      // 30-second reservation window.
      releaseFirstPut();
      [first, concurrent] = await Promise.all([firstPromise, concurrentPromise]);
    } finally {
      Date.now = hostNow;
    }
    expect(observedClock?.state).toBe("processing");
    expect(observedClock?.leaseSeconds).toBeGreaterThan(115);
    expect(observedClock?.leaseSeconds).toBeLessThan(125);
    expect(observedClock?.reconcileSeconds).toBeGreaterThan(14 * 60);
    expect(observedClock?.reconcileSeconds).toBeLessThan(16 * 60);
    expect(concurrent.id).toBe(first.id);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update publisher_issues
          set status = 'published', publication_at = now(), published_at = now()
          where id = ${issueId}
        `;
      }),
    );
    await expect(upload(crypto.randomUUID())).resolves.toEqual(first);
    await expect(
      uploadVariant({
        requestId: crypto.randomUUID(),
        body: new Uint8Array(),
        declaredBytes: bytes.byteLength,
      }),
    ).resolves.toEqual(first);
    await expect(
      uploadVariant({
        requestId: crypto.randomUUID(),
        body: new TextEncoder().encode("not a PDF"),
        declaredBytes: bytes.byteLength,
      }),
    ).resolves.toEqual(first);
    await expect(upload(crypto.randomUUID(), "Changed title")).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values ('other-admin', 'other-admin@example.test', 'Other Admin', 'clerk-other-admin')
        `;
        yield* sql`
          insert into publisher_company_memberships (
            publisher_company_id, user_id, role, accepted_at, invited_email
          ) values (${publisherCompanyId}, 'other-admin', 'admin', now(), 'other-admin@example.test')
        `;
      }),
    );
    const changedBytes = new TextEncoder().encode("%PDF-different-payload");
    const changedDigest = await crypto.subtle.digest(
      "SHA-256",
      Uint8Array.from(changedBytes).buffer,
    );
    const changedHash = Array.from(new Uint8Array(changedDigest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const conflictVariants = [
      { variant: { fileName: "different.pdf" }, codes: ["idempotency_conflict"] },
      {
        variant: { expectedHash: changedHash },
        codes: ["idempotency_conflict"],
      },
      {
        variant: { declaredBytes: bytes.byteLength + 1 },
        codes: ["idempotency_conflict"],
      },
      {
        variant: { identity: { ...identity, userId: "other-admin" } },
        codes: ["idempotency_conflict"],
      },
      {
        variant: { identity: { ...identity, sessionId: "different-session" } },
        codes: ["idempotency_conflict"],
      },
      {
        variant: { identity: { ...identity, organizationId: "wrong-org" } },
        codes: ["forbidden"],
      },
    ] as const;
    for (const { variant, codes } of conflictVariants) {
      await expect(
        uploadVariant({ requestId: crypto.randomUUID(), ...variant }),
      ).rejects.toMatchObject({
        code: codes[0],
      });
    }
    await expect(
      uploadVariant({
        requestId: crypto.randomUUID(),
        idempotencyKey: "publisher-new-key-bad-hash-01",
        expectedHash: changedHash,
      }),
    ).rejects.toMatchObject({ code: "published_issue_immutable" });
    const secondIssue = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const id = crypto.randomUUID();
        yield* sql`
          insert into publisher_issues (id, subscription_id, title, status, created_by_user_id)
          values (${id}, ${subscriptionId}, 'Second issue', 'draft', 'admin-user')
        `;
        return id;
      }),
    );
    await expect(
      uploadVariant({
        issueId: secondIssue,
        requestId: crypto.randomUUID(),
        idempotencyKey: "publisher-new-key-bad-hash-02",
        expectedHash: changedHash,
      }),
    ).rejects.toMatchObject({ code: "upload_hash_mismatch" });
    await expect(
      uploadVariant({
        issueId: secondIssue,
        requestId: crypto.randomUUID(),
        idempotencyKey: "publisher-new-key-bad-size-02",
        declaredBytes: bytes.byteLength + 1,
      }),
    ).rejects.toMatchObject({ code: "upload_size_mismatch" });
    const second = await uploadVariant({ issueId: secondIssue, requestId: crypto.randomUUID() });
    expect(second.id).not.toBe(first.id);
    expect(puts).toBe(2);
    expect(objects).toHaveLength(2);
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          documents: number;
          intents: number;
          jobs: number;
          finalized: number;
          successfulAudits: number;
        }>`
          select
            (select count(*)::int from brief_documents where issue_id = ${issueId}) as documents,
            (select count(*)::int from publisher_document_upload_intents where issue_id = ${issueId}) as intents,
            (select count(*)::int from jobs where kind = 'extract_pdf_text'
             and payload->>'documentId' = ${first.id}) as jobs,
            (select count(*)::int from publisher_document_upload_events
             where operation_id = ${first.id} and event_kind = 'finalized') as finalized,
            (select count(*)::int from platform_authorization_audit_log
             where action = 'publisher.document.upload'
               and scope_kind = 'brief_document' and scope_id = ${first.id}
               and outcome = 'succeeded') as "successfulAudits"
        `)[0]!;
      }),
    );
    expect(state).toEqual({ documents: 1, intents: 1, jobs: 1, finalized: 1, successfulAudits: 5 });
    await expect(
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update publisher_document_upload_intents
            set lease_token = gen_random_uuid()
            where issue_id = ${issueId}
          `;
        }),
      ),
    ).rejects.toBeDefined();

    const rawReservation = () => ({
      operationId: crypto.randomUUID(),
      documentId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      leaseToken: crypto.randomUUID(),
      idempotencyKey: `direct-upload-${crypto.randomUUID()}`,
    });
    const insertRawReservation = (
      reservation: ReturnType<typeof rawReservation>,
      state: "processing" | "retryable",
    ) =>
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into publisher_document_upload_intents (
              id, document_id, issue_id, idempotency_key, object_key, expected_sha256_hex,
              byte_size, actor_user_id, actor_organization_id, actor_session_id, actor_mode,
              title, original_file_name, media_type, request_id, attempt, lease_token,
              lease_expires_at, state, created_at, reconcile_after
            ) values (
              ${reservation.operationId}, ${reservation.documentId}, ${secondIssue},
              ${reservation.idempotencyKey},
              ${`publisher-issues/${secondIssue}/documents/${reservation.documentId}.pdf`},
              ${"f".repeat(64)}, 17, 'admin-user', null, 'direct-invariant-session', 'demo',
              'Direct invariant test', 'direct.pdf', 'application/pdf',
              ${reservation.requestId}, 1, ${reservation.leaseToken}, now() + interval '1 minute',
              ${state}, now(), now() + interval '15 minutes'
            )
          `;
        }),
      );

    await expect(insertRawReservation(rawReservation(), "retryable")).rejects.toBeDefined();

    const illegalTransition = rawReservation();
    await insertRawReservation(illegalTransition, "processing");
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update publisher_document_upload_intents
          set state = 'retryable'
          where id = ${illegalTransition.operationId}
        `;
      }),
    );
    await expect(
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update publisher_document_upload_intents
            set state = 'object_put'
            where id = ${illegalTransition.operationId}
          `;
        }),
      ),
    ).rejects.toBeDefined();

    const incompleteFinalization = rawReservation();
    await insertRawReservation(incompleteFinalization, "processing");
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update publisher_document_upload_intents
          set state = 'object_put'
          where id = ${incompleteFinalization.operationId}
        `;
        yield* sql`
          insert into publisher_document_upload_events (operation_id, event_kind)
          values
            (${incompleteFinalization.operationId}, 'object_put'),
            (${incompleteFinalization.operationId}, 'finalized')
        `;
      }),
    );
    await expect(
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update publisher_document_upload_intents
            set state = 'finalized'
            where id = ${incompleteFinalization.operationId}
          `;
        }),
      ),
    ).rejects.toBeDefined();
  });

  it("finalizes a provider-committed upload after the PUT response is lost", async () => {
    const issueId = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const id = crypto.randomUUID();
        yield* sql`
          insert into publisher_issues (id, subscription_id, title, status, created_by_user_id)
          values (${id}, ${subscriptionId}, 'Ambiguous upload', 'draft', 'admin-user')
        `;
        return id;
      }),
    );
    const bytes = new TextEncoder().encode("%PDF-provider-committed");
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const objects = new Map<string, Uint8Array>();
    let puts = 0;
    const store = {
      put: async ({
        objectKey,
        signal,
      }: {
        readonly objectKey: string;
        readonly signal: AbortSignal;
      }) => {
        if (signal.aborted) throw signal.reason;
        puts += 1;
        objects.set(objectKey, bytes);
        throw new Error("response_lost_after_commit");
      },
      head: async ({
        objectKey,
        signal,
      }: {
        readonly objectKey: string;
        readonly signal: AbortSignal;
      }) => {
        if (signal.aborted) throw signal.reason;
        return objects.has(objectKey)
          ? { byteSize: bytes.byteLength, sha256Hex: hash, mediaType: "application/pdf" as const }
          : null;
      },
      delete: async ({ signal }: { readonly signal: AbortSignal }) => {
        if (signal.aborted) throw signal.reason;
      },
    };
    const result = await runDb(
      uploadPublisherDocument({
        identity: {
          userId: "admin-user",
          organizationId: null,
          sessionId: "ambiguous-upload-session",
          mfaVerified: true,
          mode: "demo",
        },
        issueId,
        idempotencyKey: "publisher-upload-ambiguous-01",
        title: "Ambiguous",
        fileName: "ambiguous.pdf",
        expectedHash: hash,
        declaredBytes: bytes.byteLength,
        body: bytes,
        requestId: crypto.randomUUID(),
        store,
      }),
    );
    expect(result.originalFileName).toBe("ambiguous.pdf");
    expect(puts).toBe(1);
    expect(objects).toHaveLength(1);
  });

  it("never finalizes missing or mismatched provider objects", async () => {
    const bytes = new TextEncoder().encode("%PDF-head-mismatch");
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const metadataCases = [
      null,
      { byteSize: bytes.byteLength + 1, sha256Hex: hash, mediaType: "application/pdf" },
      { byteSize: bytes.byteLength, sha256Hex: "0".repeat(64), mediaType: "application/pdf" },
      { byteSize: bytes.byteLength, sha256Hex: hash, mediaType: "text/plain" },
    ] as const;
    for (const [index, metadata] of metadataCases.entries()) {
      const issueId = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const id = crypto.randomUUID();
          yield* sql`
            insert into publisher_issues (id, subscription_id, title, status, created_by_user_id)
            values (${id}, ${subscriptionId}, ${`Head mismatch ${index}`}, 'draft', 'admin-user')
          `;
          return id;
        }),
      );
      let deleted = 0;
      const store = {
        put: async ({ signal }: { readonly signal: AbortSignal }) => {
          if (signal.aborted) throw signal.reason;
          throw new Error("provider_put_failed");
        },
        head: async ({ signal }: { readonly signal: AbortSignal }) => {
          if (signal.aborted) throw signal.reason;
          return metadata;
        },
        delete: async ({ signal }: { readonly signal: AbortSignal }) => {
          if (signal.aborted) throw signal.reason;
          deleted += 1;
        },
      };
      await expect(
        runDb(
          uploadPublisherDocument({
            identity: {
              userId: "admin-user",
              organizationId: null,
              sessionId: `head-mismatch-${index}`,
              mfaVerified: true,
              mode: "demo",
            },
            issueId,
            idempotencyKey: `publisher-head-mismatch-${String(index).padStart(2, "0")}`,
            title: "Head mismatch",
            fileName: "mismatch.pdf",
            expectedHash: hash,
            declaredBytes: bytes.byteLength,
            body: bytes,
            requestId: crypto.randomUUID(),
            store,
          }),
        ),
      ).rejects.toMatchObject({ code: "document_upload_failed" });
      expect(deleted).toBe(metadata === null ? 0 : 1);
    }
  });

  it("fences mismatched cleanup before an expired retry can replace the object", async () => {
    const issueId = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const id = crypto.randomUUID();
        yield* sql`
          insert into publisher_issues (id, subscription_id, title, status, created_by_user_id)
          values (${id}, ${subscriptionId}, 'Mismatched cleanup race', 'draft', 'admin-user')
        `;
        return id;
      }),
    );
    const bytes = new TextEncoder().encode("%PDF-mismatched-cleanup-race");
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const objects = new Set<string>();
    let putCalls = 0;
    let mismatchedHeads = 0;
    let deleteCalls = 0;
    let secondHeadStarted!: () => void;
    const secondHeadStartedSignal = new Promise<void>((resolve) => {
      secondHeadStarted = resolve;
    });
    let releaseSecondHead!: () => void;
    const secondHeadReleased = new Promise<void>((resolve) => {
      releaseSecondHead = resolve;
    });
    let deleteStarted!: () => void;
    const deleteStartedSignal = new Promise<void>((resolve) => {
      deleteStarted = resolve;
    });
    let releaseDelete!: () => void;
    const deleteReleased = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const store = {
      put: async ({
        objectKey,
        signal,
      }: {
        readonly objectKey: string;
        readonly signal: AbortSignal;
      }) => {
        if (signal.aborted) throw signal.reason;
        putCalls += 1;
        if (putCalls <= 2) throw new Error("mismatched_put_failure");
        objects.add(objectKey);
      },
      head: async ({
        objectKey,
        signal,
      }: {
        readonly objectKey: string;
        readonly signal: AbortSignal;
      }) => {
        if (signal.aborted) throw signal.reason;
        if (putCalls <= 2) {
          mismatchedHeads += 1;
          if (mismatchedHeads === 2) {
            secondHeadStarted();
            await secondHeadReleased;
          }
          return {
            byteSize: bytes.byteLength + 1,
            sha256Hex: hash,
            mediaType: "application/pdf" as const,
          };
        }
        return objects.has(objectKey)
          ? { byteSize: bytes.byteLength, sha256Hex: hash, mediaType: "application/pdf" as const }
          : null;
      },
      delete: async ({
        objectKey,
        signal,
      }: {
        readonly objectKey: string;
        readonly signal: AbortSignal;
      }) => {
        if (signal.aborted) throw signal.reason;
        deleteCalls += 1;
        deleteStarted();
        await deleteReleased;
        if (signal.aborted) throw signal.reason;
        // Without the reservation lane, the retry could PUT while this
        // callback is paused and this stale DELETE would remove its object.
        objects.delete(objectKey);
      },
    };
    const identity = {
      userId: "admin-user",
      organizationId: null,
      sessionId: "mismatched-cleanup-race-session",
      mfaVerified: true,
      mode: "demo" as const,
    };
    const upload = () =>
      runDb(
        uploadPublisherDocument({
          identity,
          issueId,
          idempotencyKey: "publisher-mismatched-cleanup-01",
          title: "Mismatched cleanup race",
          fileName: "mismatched-cleanup-race.pdf",
          expectedHash: hash,
          declaredBytes: bytes.byteLength,
          body: bytes,
          requestId: crypto.randomUUID(),
          store,
        }),
      );

    const staleUpload = upload();
    await secondHeadStartedSignal;
    // Keep the owner fresh for the final HEAD fence, then let that lease
    // expire while the fenced DELETE is paused under the reservation lock.
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update publisher_document_upload_intents
          set lease_expires_at = now() + interval '2 seconds'
          where issue_id = ${issueId}
        `;
      }),
    );
    releaseSecondHead();
    await deleteStartedSignal;

    const retryUpload = upload();
    await Bun.sleep(2_500);
    // The retry has been allowed to observe expiry, but its reservation and
    // provider PUT remain behind the stale cleanup's advisory transaction.
    expect(putCalls).toBe(2);
    releaseDelete();

    await expect(staleUpload).rejects.toMatchObject({ code: "document_upload_failed" });
    const retry = await retryUpload;
    expect(retry.originalFileName).toBe("mismatched-cleanup-race.pdf");
    expect(deleteCalls).toBe(1);
    expect(putCalls).toBe(3);
    expect(objects.size).toBe(1);
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly attempt: number; readonly state: string }>`
          select attempt, state
          from publisher_document_upload_intents
          where issue_id = ${issueId}
        `)[0]!;
      }),
    );
    expect(state).toEqual({ attempt: 2, state: "finalized" });
  }, 30_000);

  it(
    "persists attempt-scoped cleanup evidence when mismatched DELETE fails or times out",
    async () => {
      const bytes = new TextEncoder().encode("%PDF-mismatched-delete-evidence");
      const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
      const hash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const identity = {
        userId: "admin-user",
        organizationId: null,
        sessionId: "mismatched-delete-evidence-session",
        mfaVerified: true,
        mode: "demo" as const,
      };
      const createIssue = (title: string) =>
        runDb(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const issueId = crypto.randomUUID();
            yield* sql`
              insert into publisher_issues (id, subscription_id, title, status, created_by_user_id)
              values (${issueId}, ${subscriptionId}, ${title}, 'draft', 'admin-user')
            `;
            return issueId;
          }),
        );
      const readEvidence = (issueId: string) =>
        runDb(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return (yield* sql<{
              readonly state: string;
              readonly attempt: number;
              readonly eventKind: string;
              readonly errorCode: string | null;
            }>`
              select intents.state, intents.attempt,
                     events.event_kind as "eventKind", events.error_code as "errorCode"
              from publisher_document_upload_intents intents
              left join publisher_document_upload_events events
                on events.operation_id = intents.id and events.attempt = intents.attempt
              where intents.issue_id = ${issueId}
            `)[0]!;
          }),
        );
      const runUpload = (
        issueId: string,
        idempotencyKey: string,
        store: {
          readonly put: (input: {
            readonly objectKey: string;
            readonly body: Uint8Array;
            readonly sha256Hex: string;
            readonly signal: AbortSignal;
          }) => Promise<void>;
          readonly head: (input: {
            readonly objectKey: string;
            readonly signal: AbortSignal;
          }) => Promise<{
            readonly byteSize: number;
            readonly sha256Hex: string;
            readonly mediaType: string;
          } | null>;
          readonly delete: (input: {
            readonly objectKey: string;
            readonly signal: AbortSignal;
          }) => Promise<void>;
        },
      ) =>
        runDb(
          uploadPublisherDocument({
            identity,
            issueId,
            idempotencyKey,
            title: "Mismatched delete evidence",
            fileName: "mismatched-delete-evidence.pdf",
            expectedHash: hash,
            declaredBytes: bytes.byteLength,
            body: bytes,
            requestId: crypto.randomUUID(),
            store,
          }),
        );
      const failedIssue = await createIssue("Mismatched DELETE failure");
      const failedStore = {
        put: async () => {
          throw new Error("injected_put_failure");
        },
        head: async () => ({
          byteSize: bytes.byteLength + 1,
          sha256Hex: hash,
          mediaType: "application/pdf",
        }),
        delete: async () => {
          throw new Error("injected_delete_failure");
        },
      };
      await expect(
        runUpload(failedIssue, "mismatched-delete-failure-01", failedStore),
      ).rejects.toMatchObject({ code: "document_upload_failed" });
      await expect(readEvidence(failedIssue)).resolves.toEqual({
        state: "retryable",
        attempt: 1,
        eventKind: "cleanup_required",
        errorCode: "object_delete_failed",
      });

      const timeoutIssue = await createIssue("Mismatched DELETE timeout");
      let deleteAborted = false;
      const timeoutStore = {
        put: async () => {
          throw new Error("injected_put_failure");
        },
        head: async () => ({
          byteSize: bytes.byteLength + 1,
          sha256Hex: hash,
          mediaType: "application/pdf",
        }),
        delete: async ({ signal }: { readonly signal: AbortSignal }) =>
          new Promise<void>((_resolve, reject) => {
            const abort = () => {
              deleteAborted = true;
              reject(new Error("delete_timed_out"));
            };
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          }),
      };
      await expect(
        runUpload(timeoutIssue, "mismatched-delete-timeout-01", timeoutStore),
      ).rejects.toMatchObject({ code: "document_upload_failed" });
      expect(deleteAborted).toBe(true);
      await expect(readEvidence(timeoutIssue)).resolves.toEqual({
        state: "retryable",
        attempt: 1,
        eventKind: "cleanup_required",
        errorCode: "object_delete_failed",
      });
    },
    PUBLISHER_UPLOAD_STORAGE_TIMEOUT_MS + 15_000,
  );

  it("fences a paused owner when lease expiry and cleanup race finalization", async () => {
    const issueId = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const id = crypto.randomUUID();
        yield* sql`
          insert into publisher_issues (id, subscription_id, title, status, created_by_user_id)
          values (${id}, ${subscriptionId}, 'Paused finalization', 'draft', 'admin-user')
        `;
        return id;
      }),
    );
    const bytes = new TextEncoder().encode("%PDF-paused-finalization");
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const objects = new Set<string>();
    let releaseHead!: () => void;
    const headReleased = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    let finalHeadStarted!: () => void;
    const finalHeadStartedSignal = new Promise<void>((resolve) => {
      finalHeadStarted = resolve;
    });
    const store = {
      put: async ({
        objectKey,
        signal,
      }: {
        readonly objectKey: string;
        readonly signal: AbortSignal;
      }) => {
        if (signal.aborted) throw signal.reason;
        objects.add(objectKey);
      },
      head: async ({
        objectKey,
        signal,
      }: {
        readonly objectKey: string;
        readonly signal: AbortSignal;
      }) => {
        if (signal.aborted) throw signal.reason;
        finalHeadStarted();
        await headReleased;
        // Reconciliation's delete wins while the owner is paused at HEAD.
        objects.delete(objectKey);
        return null;
      },
      delete: async ({ signal }: { readonly signal: AbortSignal }) => {
        if (signal.aborted) throw signal.reason;
      },
    };
    const uploadPromise = runDb(
      uploadPublisherDocument({
        identity: {
          userId: "admin-user",
          organizationId: null,
          sessionId: "paused-finalization-session",
          mfaVerified: true,
          mode: "demo",
        },
        issueId,
        idempotencyKey: "publisher-upload-paused-final-01",
        title: "Paused finalization",
        fileName: "paused.pdf",
        expectedHash: hash,
        declaredBytes: bytes.byteLength,
        body: bytes,
        requestId: crypto.randomUUID(),
        store,
      }),
    );
    await finalHeadStartedSignal;
    // Expiry is attempted concurrently with the paused owner. The row lock
    // held by finalization makes this update linearize after the failed HEAD.
    const expirePromise = runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update publisher_document_upload_intents
          set lease_expires_at = created_at
          where issue_id = ${issueId}
        `;
      }),
    );
    releaseHead();
    await expect(uploadPromise).rejects.toMatchObject({ code: "document_upload_failed" });
    await expirePromise;
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const row = (yield* sql<{
          readonly id: string;
          readonly attempt: number;
          readonly state: string;
        }>`
            select id::text, attempt, state
            from publisher_document_upload_intents
            where issue_id = ${issueId}
          `)[0]!;
        yield* sql`
          insert into publisher_document_upload_events (operation_id, attempt, event_kind)
          values (${row.id}, ${row.attempt}, 'object_deleted')
        `;
        return row;
      }),
    );
    expect(state.state).toBe("object_put");
    expect(
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ readonly count: number }>`
              select count(*)::int as count from brief_documents where issue_id = ${issueId}
            `)[0]!.count;
        }),
      ),
    ).toBe(0);
  });

  it("propagates caller cancellation into an in-flight object operation", async () => {
    const issueId = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const id = crypto.randomUUID();
        yield* sql`
          insert into publisher_issues (id, subscription_id, title, status, created_by_user_id)
          values (${id}, ${subscriptionId}, 'Abort upload', 'draft', 'admin-user')
        `;
        return id;
      }),
    );
    const bytes = new TextEncoder().encode("%PDF-abort");
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    let observedAbort = false;
    const store = {
      put: async ({ signal }: { readonly signal: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          const abort = () => {
            observedAbort = true;
            reject(new Error("aborted"));
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      head: async ({ signal }: { readonly signal: AbortSignal }) => {
        if (signal.aborted) throw signal.reason;
        return null;
      },
      delete: async ({ signal }: { readonly signal: AbortSignal }) => {
        if (signal.aborted) throw signal.reason;
      },
    };
    const controller = new AbortController();
    const request = runDb(
      uploadPublisherDocument({
        identity: {
          userId: "admin-user",
          organizationId: null,
          sessionId: "abort-upload-session",
          mfaVerified: true,
          mode: "demo",
        },
        issueId,
        idempotencyKey: "publisher-upload-abort-0001",
        title: "Abort",
        fileName: "abort.pdf",
        expectedHash: hash,
        declaredBytes: bytes.byteLength,
        body: bytes,
        requestId: crypto.randomUUID(),
        requestSignal: controller.signal,
        store,
      }),
    );
    setTimeout(() => controller.abort("caller_cancelled"), 10);
    await expect(request).rejects.toBeDefined();
    expect(observedAbort).toBe(true);
  });

  it("aborts a hung provider PUT at the code-owned storage timeout", async () => {
    const issueId = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const id = crypto.randomUUID();
        yield* sql`
          insert into publisher_issues (id, subscription_id, title, status, created_by_user_id)
          values (${id}, ${subscriptionId}, 'Timeout upload', 'draft', 'admin-user')
        `;
        return id;
      }),
    );
    const bytes = new TextEncoder().encode("%PDF-timeout");
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    let putCalls = 0;
    let providerAborted = false;
    const store = {
      put: async ({ signal }: { readonly signal: AbortSignal }) => {
        putCalls += 1;
        if (putCalls > 1) throw new Error("retry_not_available");
        await new Promise<void>((_resolve, reject) => {
          const abort = () => {
            providerAborted = true;
            reject(new Error("provider_aborted"));
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      },
      head: async ({ signal }: { readonly signal: AbortSignal }) => {
        if (signal.aborted) throw signal.reason;
        return null;
      },
      delete: async ({ signal }: { readonly signal: AbortSignal }) => {
        if (signal.aborted) throw signal.reason;
      },
    };
    await expect(
      runDb(
        uploadPublisherDocument({
          identity: {
            userId: "admin-user",
            organizationId: null,
            sessionId: "timeout-upload-session",
            mfaVerified: true,
            mode: "demo",
          },
          issueId,
          idempotencyKey: "publisher-upload-timeout-01",
          title: "Timeout",
          fileName: "timeout.pdf",
          expectedHash: hash,
          declaredBytes: bytes.byteLength,
          body: bytes,
          requestId: crypto.randomUUID(),
          store,
        }),
      ),
    ).rejects.toMatchObject({ code: "document_upload_failed" });
    expect(providerAborted).toBe(true);
    expect(putCalls).toBe(2);
    await expect(
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{ readonly count: number }>`
            select count(*)::int as count from brief_documents where issue_id = ${issueId}
          `;
        }),
      ),
    ).resolves.toEqual([{ count: 0 }]);
  }, 30_000);

  it("persists retryable upload cleanup when finalization and object deletion fail", async () => {
    const issueId = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const issueId = crypto.randomUUID();
        yield* sql`
          insert into publisher_issues (
            id, subscription_id, title, status, created_by_user_id
          ) values (${issueId}, ${subscriptionId}, 'Orphan upload', 'draft', 'admin-user')
        `;
        return issueId;
      }),
    );
    const bytes = new TextEncoder().encode("%PDF-durable-orphan-cleanup");
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const objects = new Set<string>();
    const store = {
      put: async (input: { readonly objectKey: string; readonly signal: AbortSignal }) => {
        void input.signal;
        objects.add(input.objectKey);
      },
      head: async (input: { readonly objectKey: string; readonly signal: AbortSignal }) => {
        void input.signal;
        return objects.has(input.objectKey)
          ? {
              byteSize: bytes.byteLength,
              sha256Hex: hash,
              mediaType: "application/pdf" as const,
            }
          : null;
      },
      delete: async (input: { readonly objectKey: string; readonly signal: AbortSignal }) => {
        void input;
        throw new Error("injected_object_delete_failure");
      },
    };
    const identity = {
      userId: "admin-user",
      organizationId: null,
      sessionId: "upload-atomic-audit-test",
      mfaVerified: true,
      mode: "demo" as const,
    };
    await expect(
      runDb(
        uploadPublisherDocument({
          identity,
          issueId,
          idempotencyKey: "upload-retry-key-123456",
          title: "Durable orphan",
          fileName: "durable-orphan.pdf",
          expectedHash: hash,
          declaredBytes: bytes.byteLength,
          body: bytes,
          requestId: crypto.randomUUID(),
          store,
          auditSucceeded: () => Effect.fail(new Error("injected_upload_audit_failure")),
        }),
      ),
    ).rejects.toThrow("injected_upload_audit_failure");
    expect(objects.size).toBe(1);

    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly documents: number;
          readonly intents: number;
          readonly objectPut: number;
          readonly cleanupRequired: number;
          readonly reconcileJobs: number;
        }>`
          select
            (select count(*)::int from brief_documents where issue_id = ${issueId}) as documents,
            (select count(*)::int from publisher_document_upload_intents
             where issue_id = ${issueId}) as intents,
            (select count(*)::int from publisher_document_upload_events events
             join publisher_document_upload_intents intents on intents.id = events.operation_id
             where intents.issue_id = ${issueId} and events.event_kind = 'object_put') as "objectPut",
            (select count(*)::int from publisher_document_upload_events events
             join publisher_document_upload_intents intents on intents.id = events.operation_id
             where intents.issue_id = ${issueId} and events.event_kind = 'cleanup_required')
              as "cleanupRequired",
            (select count(*)::int from jobs where kind = 'reconcile_publisher_uploads')
              as "reconcileJobs"
        `)[0]!;
      }),
    );
    expect(state).toEqual({
      documents: 0,
      intents: 1,
      objectPut: 1,
      cleanupRequired: 0,
      reconcileJobs: 1,
    });
  });

  it("normalizes web policy, creates only a support deletion request, and chains success/denied audits", async () => {
    const routes = makeClientWorkspaceRoutes(pgLayer());
    const success = await call(
      routes,
      "admin-user",
      "PUT",
      `/v1/client-companies/${clientCompanyId}/web-policy`,
      { enabled: true, allowedDomains: [" Example.COM. ", "État.fr", "example.com"] },
    );
    expect(success.status).toBe(200);
    await expect(success.json()).resolves.toEqual({
      settings: { enabled: true, allowedDomains: ["example.com", "xn--tat-9la.fr"] },
    });
    const denied = await call(
      routes,
      "member-user",
      "PUT",
      `/v1/client-companies/${clientCompanyId}/web-policy`,
      { enabled: false, allowedDomains: null },
    );
    expect(denied.status).toBe(404);
    const deletion = await call(
      routes,
      "admin-user",
      "POST",
      `/v1/client-companies/${clientCompanyId}/deletion-requests`,
      { reason: "Close the account", idempotencyKey: "company-delete-0001" },
    );
    expect(deletion.status).toBe(201);
    const audit = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{
          outcome: string;
          reasonCode: string | null;
          previousHash: string | null;
          entryHash: string;
        }>`
          select outcome, reason_code as "reasonCode", encode(previous_hash, 'hex') as "previousHash",
                 encode(entry_hash, 'hex') as "entryHash"
          from platform_authorization_audit_log order by id
        `;
        const company = (yield* sql<{ deletedAt: Date | null }>`
          select recovery_deleted_at as "deletedAt" from client_companies where id = ${clientCompanyId}
        `)[0]!;
        return { rows, company };
      }),
    );
    expect(audit.rows.map((row) => [row.outcome, row.reasonCode])).toEqual([
      ["succeeded", null],
      ["denied", "forbidden"],
      ["succeeded", null],
    ]);
    expect(audit.rows[1]!.previousHash).toBe(audit.rows[0]!.entryHash);
    expect(audit.company.deletedAt).toBeNull();
    await expect(
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`update platform_authorization_audit_log set outcome = 'denied' where outcome = 'succeeded'`;
        }),
      ),
    ).rejects.toThrow();

    await runDb(
      Effect.gen(function* () {
        const failed = yield* requireClientCompanyAdmin(
          {
            userId: "admin-user",
            organizationId: null,
            sessionId: "mfa-test",
            mfaVerified: false,
            mode: "clerk",
          },
          clientCompanyId,
        ).pipe(Effect.flip);
        yield* appendDeniedAuthorizationAudit({
          identity: {
            userId: "admin-user",
            organizationId: null,
            sessionId: "mfa-test",
            mfaVerified: false,
            mode: "clerk",
          },
          requestId: crypto.randomUUID(),
          action: "client.web_policy.update",
          scopeKind: "client_company",
          scopeId: clientCompanyId,
          error: failed,
        });
      }),
    );
  });

  it("defaults public marketplace sources off and lets only an MFA admin opt in or out", async () => {
    const routes = makeClientWorkspaceRoutes(pgLayer());
    const initial = await call(
      routes,
      "member-user",
      "GET",
      `/v1/client-companies/${clientCompanyId}/public-sources`,
    );
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({
      sources: [{ sourceId: "official-marketplace-source", enabled: false }],
    });

    const denied = await call(
      routes,
      "member-user",
      "PUT",
      `/v1/client-companies/${clientCompanyId}/public-sources/official-marketplace-source`,
      { enabled: true },
    );
    expect(denied.status).toBe(404);
    const enabled = await call(
      routes,
      "admin-user",
      "PUT",
      `/v1/client-companies/${clientCompanyId}/public-sources/official-marketplace-source`,
      { enabled: true },
    );
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toMatchObject({
      source: { sourceId: "official-marketplace-source", enabled: true },
    });
    await runDb(seedMarketplacePublicDocument);
    const archive = await call(
      routes,
      "member-user",
      "GET",
      `/v1/client-companies/${clientCompanyId}/archive`,
    );
    expect(archive.status).toBe(200);
    await expect(archive.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          sourceKind: "public",
          sourceId: "official-marketplace-source",
          documentId: "public-document-1",
          contentPath: "/public-source-documents/public-document-1/content",
          mediaType: "text/html",
          canonicalUrl: "https://example.test/publication",
        }),
      ],
    });
    const filteredPublicArchive = await call(
      routes,
      "member-user",
      "GET",
      `/v1/client-companies/${clientCompanyId}/archive?sourceKind=public&sourceId=official-marketplace-source`,
    );
    expect(filteredPublicArchive.status).toBe(200);
    await expect(filteredPublicArchive.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          sourceKind: "public",
          sourceId: "official-marketplace-source",
          documentId: "public-document-1",
        }),
      ],
    });
    const legacyPseudoSubscriptionFilter = await call(
      routes,
      "member-user",
      "GET",
      `/v1/client-companies/${clientCompanyId}/archive?subscriptionId=public%3Aofficial-marketplace-source`,
    );
    expect(legacyPseudoSubscriptionFilter.status).toBe(400);
    await expect(legacyPseudoSubscriptionFilter.json()).resolves.toEqual({
      code: "invalid_query",
    });
    const disabled = await call(
      routes,
      "admin-user",
      "PUT",
      `/v1/client-companies/${clientCompanyId}/public-sources/official-marketplace-source`,
      { enabled: false },
    );
    expect(disabled.status).toBe(200);

    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ enabled: boolean; deniedAudits: number }>`
          select settings.enabled,
                 (select count(*)::int from platform_authorization_audit_log
                  where action = 'client.public_source.update' and outcome = 'denied')
                   as "deniedAudits"
          from client_company_public_source_settings settings
          where settings.client_company_id = ${clientCompanyId}
            and settings.source_id = 'official-marketplace-source'
        `)[0]!;
      }),
    );
    expect(state).toEqual({ enabled: false, deniedAudits: 1 });
  });

  it("authorizes hosted public content by the current identity and publication scope", async () => {
    const demoUserId = "public-content-user";
    const demoCompany = await runDb(
      ensureDemoChat(demoUserId).pipe(Effect.map((chat) => chat.company_id)),
    );
    const documentId = "public-content-authorized";
    const staleDocumentId = "stale-public-document";
    const artifactId = crypto.randomUUID();
    const alternateArtifactId = crypto.randomUUID();
    const authorizedText = "Authorized hosted public content ".repeat(10);
    const authorizedContentHash = createHash("sha256").update(authorizedText, "utf8").digest("hex");
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const text = authorizedText;
        yield* sql`
          update client_companies
          set clerk_organization_id = 'org_public_content'
          where id = ${demoCompany}
        `;
        yield* sql`
          insert into public_source_raw_artifacts (
            id, source_id, canonical_url, fetched_at, media_type, body, body_hash
          ) values (
            ${artifactId}, 'official-marketplace-source', 'https://example.test/authorized-content',
            now(), 'text/html', ${`<p>${text}</p>`}, ${"c".repeat(64)}
          )
        `;
        yield* sql`
          insert into public_source_raw_artifacts (
            id, source_id, canonical_url, fetched_at, media_type, body, body_hash
          ) values (
            ${alternateArtifactId}, 'official-marketplace-source',
            'https://example.test/stale-artifact', now(), 'text/html', '<p>stale</p>', ${"f".repeat(64)}
          )
        `;
        yield* sql`
          insert into public_source_documents (
            document_id, source_id, raw_artifact_id, canonical_url, external_id, title,
            text, language, published_at, discovered_at, fetched_at, document_type,
            content_hash, text_char_count
          ) values (
            ${documentId}, 'official-marketplace-source', ${artifactId},
            'https://example.test/authorized-content', 'authorized-content', 'Authorized content',
            ${text}, 'fr-FR', now(), now(), now(), 'publication', encode(digest(convert_to(${text}, 'UTF8'), 'sha256'), 'hex'), ${text.length}
          )
        `;
        yield* sql`
          insert into public_source_documents (
            document_id, source_id, raw_artifact_id, canonical_url, external_id, title,
            text, language, published_at, discovered_at, fetched_at, document_type,
            content_hash, text_char_count
          ) values (
            ${staleDocumentId}, 'official-marketplace-source', ${alternateArtifactId},
            'https://example.test/stale-artifact', 'stale-artifact', 'Stale artifact',
            ${"Stale hosted public content ".repeat(10)}, 'fr-FR', now(), now(), now(), 'publication',
            encode(digest(convert_to(${"Stale hosted public content ".repeat(10)}, 'UTF8'), 'sha256'), 'hex'), ${"Stale hosted public content ".repeat(10).length}
          )
        `;
        yield* sql`
          insert into public_source_items (
            source_id, canonical_url, external_id, title, published_at, discovered_at,
            current_content_hash, latest_document_id, latest_raw_artifact_id,
            last_fetched_at, last_successful_fetch_at
          ) values (
            'official-marketplace-source', 'https://example.test/authorized-content',
            'authorized-content', 'Authorized content', now(), now(), encode(digest(convert_to(${text}, 'UTF8'), 'sha256'), 'hex'),
            ${documentId}, ${artifactId}, now(), now()
          )
        `;
        yield* sql`
          insert into client_company_public_source_settings (
            client_company_id, source_id, enabled, updated_by_user_id
          ) values (${demoCompany}, 'official-marketplace-source', true, ${demoUserId})
          on conflict (client_company_id, source_id) do update set enabled = true
        `;
      }),
    );

    const demoIdentity = {
      authenticated: true as const,
      identity: {
        userId: demoUserId,
        organizationId: null,
        sessionId: "demo-session",
        mfaVerified: true,
        mode: "demo" as const,
      },
    };
    const clerkIdentity = {
      authenticated: true as const,
      identity: {
        ...demoIdentity.identity,
        organizationId: "org_public_content",
        sessionId: "clerk-session",
        mode: "clerk" as const,
      },
    };
    const demoRoute = makePublicSourceDocumentContentRoute(pgLayer(), () =>
      Effect.succeed(demoIdentity),
    );
    const clerkRoute = makePublicSourceDocumentContentRoute(pgLayer(), () =>
      Effect.succeed(clerkIdentity),
    );
    const unauthorizedRoute = makePublicSourceDocumentContentRoute(pgLayer(), () =>
      Effect.succeed({ authenticated: false as const }),
    );
    const path = `/public-source-documents/${documentId}/content`;

    const authorized = await call([demoRoute], demoUserId, "GET", path);
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get("content-security-policy")).toContain("default-src 'none'");
    await expect(authorized.text()).resolves.toContain("Authorized hosted public content");

    const clerkAuthorized = await call([clerkRoute], demoUserId, "GET", path);
    expect(clerkAuthorized.status).toBe(200);

    const allowedOrigin = await call([demoRoute], demoUserId, "GET", path, undefined, {
      origin: "https://web.example",
      config: { CORS_ALLOWED_ORIGINS: "https://web.example" },
    });
    expect(allowedOrigin.status).toBe(200);
    expect(allowedOrigin.headers.get("access-control-allow-origin")).toBe("https://web.example");
    expect(allowedOrigin.headers.get("vary")).toContain("Origin");

    const deniedOrigin = await call([demoRoute], demoUserId, "GET", path, undefined, {
      origin: "https://evil.example",
      config: { CORS_ALLOWED_ORIGINS: "https://web.example" },
    });
    expect(deniedOrigin.status).toBe(200);
    expect(deniedOrigin.headers.get("access-control-allow-origin")).toBeNull();

    // Hosted authenticated content must never expose a wildcard
    // bearer-capability grant, even if a caller omitted explicit CORS config.
    const wildcardOrigin = await call([demoRoute], demoUserId, "GET", path, undefined, {
      origin: "https://web.example",
    });
    expect(wildcardOrigin.status).toBe(200);
    expect(wildcardOrigin.headers.get("access-control-allow-origin")).toBeNull();

    const deniedPreflight = await call([demoRoute], demoUserId, "OPTIONS", path, undefined, {
      origin: "https://evil.example",
      config: { CORS_ALLOWED_ORIGINS: "https://web.example" },
    });
    expect(deniedPreflight.status).toBe(403);
    expect(deniedPreflight.headers.get("access-control-allow-origin")).toBeNull();

    const staleCases = [
      { column: "current_content_hash", value: "e".repeat(64), restored: authorizedContentHash },
      { column: "latest_document_id", value: staleDocumentId, restored: documentId },
      { column: "latest_raw_artifact_id", value: alternateArtifactId, restored: artifactId },
    ] as const;
    for (const { column, value, restored } of staleCases) {
      // The canonical tuple foreign key normally prevents these impossible
      // states. Drop only that invariant for this route-level fail-closed
      // probe, then restore the coherent row and constraint in finally.
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(
            "alter table public_source_items drop constraint public_source_items_latest_document_tuple_fkey",
          ).raw;
        }),
      );
      try {
        await runDb(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            if (column === "current_content_hash") {
              yield* sql`
                update public_source_items
                set current_content_hash = ${value}
                where source_id = 'official-marketplace-source' and external_id = 'authorized-content'
              `;
            } else if (column === "latest_document_id") {
              yield* sql`
                update public_source_items
                set latest_document_id = ${value}
                where source_id = 'official-marketplace-source' and external_id = 'authorized-content'
              `;
            } else {
              yield* sql`
                update public_source_items
                set latest_raw_artifact_id = ${value}
                where source_id = 'official-marketplace-source' and external_id = 'authorized-content'
              `;
            }
          }),
        );
        const stale = await call([demoRoute], demoUserId, "GET", path);
        expect(stale.status).toBe(404);
        await expect(stale.json()).resolves.toEqual({ error: "not_found" });
      } finally {
        await runDb(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            if (column === "current_content_hash") {
              yield* sql`
                update public_source_items
                set current_content_hash = ${restored}
                where source_id = 'official-marketplace-source' and external_id = 'authorized-content'
              `;
            } else if (column === "latest_document_id") {
              yield* sql`
                update public_source_items
                set latest_document_id = ${restored}
                where source_id = 'official-marketplace-source' and external_id = 'authorized-content'
              `;
            } else {
              yield* sql`
                update public_source_items
                set latest_raw_artifact_id = ${restored}
                where source_id = 'official-marketplace-source' and external_id = 'authorized-content'
              `;
            }
          }),
        );
        await runDb(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql.unsafe(
              `alter table public_source_items add constraint public_source_items_latest_document_tuple_fkey
               foreign key (
                 latest_document_id, source_id, canonical_url, current_content_hash, latest_raw_artifact_id
               ) references public_source_documents (
                 document_id, source_id, canonical_url, content_hash, raw_artifact_id
               ) on update cascade`,
            ).raw;
          }),
        );
      }
    }

    const unauthenticated = await call([unauthorizedRoute], demoUserId, "GET", path, undefined, {
      origin: "https://evil.example",
      config: { CORS_ALLOWED_ORIGINS: "https://web.example" },
    });
    expect(unauthenticated.status).toBe(404);
    await expect(unauthenticated.json()).resolves.toEqual({ error: "not_found" });
    expect(unauthenticated.headers.get("access-control-allow-origin")).toBeNull();

    const foreignOrganization = makePublicSourceDocumentContentRoute(pgLayer(), () =>
      Effect.succeed({
        authenticated: true as const,
        identity: { ...clerkIdentity.identity, organizationId: "org_foreign" },
      }),
    );
    const foreign = await call([foreignOrganization], demoUserId, "GET", path);
    expect(foreign.status).toBe(404);

    const unknown = await call(
      [demoRoute],
      demoUserId,
      "GET",
      "/public-source-documents/unknown-content/content",
    );
    expect(unknown.status).toBe(404);

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_public_source_settings
          set enabled = false
          where client_company_id = ${demoCompany}
            and source_id = 'official-marketplace-source'
        `;
      }),
    );
    expect((await call([demoRoute], demoUserId, "GET", path)).status).toBe(404);

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values ('public-content-keeper', 'public-content-keeper@example.test', 'Content Keeper', 'clerk-public-content-keeper')
          on conflict (id) do nothing
        `;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values (${demoCompany}, 'public-content-keeper', 'admin')
          on conflict (company_id, user_id) do update set revoked_at = null, revoked_by_user_id = null
        `;
        yield* sql`
          update client_company_public_source_settings
          set enabled = true
          where client_company_id = ${demoCompany}
            and source_id = 'official-marketplace-source'
        `;
        yield* sql`
          update client_company_memberships
          set revoked_at = now(), revoked_by_user_id = ${demoUserId}
          where company_id = ${demoCompany} and user_id = ${demoUserId}
        `;
      }),
    );
    expect((await call([demoRoute], demoUserId, "GET", path)).status).toBe(404);

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_memberships
          set revoked_at = null, revoked_by_user_id = null
          where company_id = ${demoCompany} and user_id = ${demoUserId}
        `;
        yield* sql`
          update platform_users
          set recovery_deleted_at = now(), purge_after = now() + interval '180 days'
          where id = ${demoUserId}
        `;
      }),
    );
    expect((await call([demoRoute], demoUserId, "GET", path)).status).toBe(404);

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update platform_users
          set recovery_deleted_at = null, purge_after = null
          where id = ${demoUserId}
        `;
        yield* sql`
          update client_companies
          set recovery_deleted_at = now(), purge_after = now() + interval '180 days'
          where id = ${demoCompany}
        `;
      }),
    );
    expect((await call([demoRoute], demoUserId, "GET", path)).status).toBe(404);
  });

  it("keeps delivered publisher archive citations after current delivery changes", async () => {
    const issueId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into publisher_issues (
            id, subscription_id, title, status, publication_at, published_at, created_by_user_id
          ) values (
            ${issueId}, ${subscriptionId}, 'Historical publisher issue', 'draft', null, null,
            'admin-user'
          )
        `;
        yield* sql`
          insert into brief_documents (
            id, issue_id, title, original_file_name, object_key, media_type,
            byte_size, sha256_hex, upload_completed_at, created_by_user_id
          ) values (
            ${documentId}, ${issueId}, 'Historical publisher document', 'historical.pdf',
            ${`publisher/${documentId}.pdf`}, 'application/pdf', 1, ${"a".repeat(64)},
            now(), 'admin-user'
          )
        `;
        yield* sql`
          update publisher_issues
          set status = 'published', publication_at = now(), published_at = now()
          where id = ${issueId}
        `;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into issue_deliveries (
                issue_id, subscription_id, access_id, client_company_id, historical
              ) values (${issueId}, ${subscriptionId}, ${accessId}, ${clientCompanyId}, false)
            `;
            yield* sql`
              insert into issue_delivery_recipients (
                issue_id, client_company_id, user_id, delivered_at
              )
              select issue_id, client_company_id, 'member-user', delivered_at
              from issue_deliveries
              where issue_id = ${issueId} and client_company_id = ${clientCompanyId}
            `;
          }),
        );
      }),
    );

    const routes = makeClientWorkspaceRoutes(pgLayer());
    const before = await call(
      routes,
      "member-user",
      "GET",
      `/v1/client-companies/${clientCompanyId}/archive`,
    );
    expect(before.status).toBe(200);
    await expect(before.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          sourceKind: "publisher",
          subscriptionId,
          issueId,
          documentId,
          contentPath: `/v1/issues/${issueId}/documents/${documentId}/content`,
        }),
      ],
    });

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_subscription_accesses
          set state = 'paused', delivery_end_at = now(), paused_at = now()
          where id = ${accessId}
        `;
        yield* sql`
          update client_employee_subscription_grants
          set revoked_at = now(), revoked_by_user_id = 'admin-user'
          where access_id = ${accessId} and client_company_id = ${clientCompanyId}
            and user_id = 'member-user'
        `;
        yield* sql`
          update publisher_subscriptions set delivery_enabled = false where id = ${subscriptionId}
        `;
        yield* sql`
          update publisher_companies
          set delivery_enabled = false
          where id = (
            select publisher_company_id from publisher_subscriptions
            where id = ${subscriptionId}
          )
        `;
      }),
    );

    const after = await call(
      routes,
      "member-user",
      "GET",
      `/v1/client-companies/${clientCompanyId}/archive`,
    );
    expect(after.status).toBe(200);
    await expect(after.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ issueId, documentId, sourceKind: "publisher" })],
    });
  });

  it("paginates a high-cardinality archive in SQL with a stable bounded window", async () => {
    const routes = makeClientWorkspaceRoutes(pgLayer());
    const enabled = await call(
      routes,
      "admin-user",
      "PUT",
      `/v1/client-companies/${clientCompanyId}/public-sources/official-marketplace-source`,
      { enabled: true },
    );
    expect(enabled.status).toBe(200);

    await runDb(seedMarketplacePublicDocument);

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into public_source_raw_artifacts (
            id, source_id, canonical_url, fetched_at, media_type, body, body_hash
          )
          select gen_random_uuid(),
                 'official-marketplace-source',
                 format('https://example.test/archive/%s', lpad(series::text, 3, '0')),
                 timestamptz '2026-07-01 00:00:00+00',
                 'Text/HTML; charset=UTF-8',
                 repeat('Bounded archive evidence ', 20),
                 encode(digest(repeat('Bounded archive evidence ', 20), 'sha256'), 'hex')
          from generate_series(1, 140) series
        `;
        yield* sql`
          insert into public_source_documents (
            document_id, source_id, raw_artifact_id, canonical_url, external_id, title,
            text, language, published_at, discovered_at, fetched_at, document_type,
            content_hash, text_char_count
          )
          select format('public-page-%s', substring(raw.canonical_url from '[0-9]+$')),
                 raw.source_id,
                 raw.id,
                 raw.canonical_url,
                 format('archive-%s', substring(raw.canonical_url from '[0-9]+$')),
                 format('Archive page %s', substring(raw.canonical_url from '[0-9]+$')),
                 repeat('Bounded archive evidence ', 20),
                 'en-US',
                 timestamptz '2026-07-01 00:00:00+00',
                 timestamptz '2026-07-01 00:00:00+00',
                 timestamptz '2026-07-01 00:00:00+00',
                 'publication',
                 encode(digest(convert_to(repeat('Bounded archive evidence ', 20), 'UTF8'), 'sha256'), 'hex'),
                 length(repeat('Bounded archive evidence ', 20))
          from public_source_raw_artifacts raw
          where raw.source_id = 'official-marketplace-source'
            and raw.canonical_url like 'https://example.test/archive/%'
        `;
        yield* sql`
          insert into public_source_items (
            source_id, canonical_url, external_id, title, published_at, discovered_at,
            current_content_hash, latest_document_id, latest_raw_artifact_id,
            last_fetched_at, last_successful_fetch_at
          )
          select document.source_id,
                 document.canonical_url,
                 document.external_id,
                 document.title,
                 document.published_at,
                 document.discovered_at,
                 document.content_hash,
                 document.document_id,
                 document.raw_artifact_id,
                 document.fetched_at,
                 document.fetched_at
          from public_source_documents document
          where document.source_id = 'official-marketplace-source'
            and document.document_id like 'public-page-%'
        `;
      }),
    );

    const first = await call(
      routes,
      "member-user",
      "GET",
      `/v1/client-companies/${clientCompanyId}/archive?limit=7`,
    );
    expect(first.status).toBe(200);
    const firstPage = (await first.json()) as {
      readonly items: readonly { readonly documentId: string }[];
      readonly nextCursor: string | null;
    };
    expect(firstPage.items.map((item) => item.documentId)).toEqual([
      "public-document-1",
      ...Array.from(
        { length: 6 },
        (_, index) => `public-page-${String(index + 1).padStart(3, "0")}`,
      ),
    ]);
    expect(firstPage.nextCursor).toBe(btoa("7"));

    const second = await call(
      routes,
      "member-user",
      "GET",
      `/v1/client-companies/${clientCompanyId}/archive?limit=7&cursor=${encodeURIComponent(
        firstPage.nextCursor!,
      )}`,
    );
    expect(second.status).toBe(200);
    const secondPage = (await second.json()) as {
      readonly items: readonly { readonly documentId: string }[];
      readonly nextCursor: string | null;
    };
    expect(secondPage.items.map((item) => item.documentId)).toEqual(
      Array.from({ length: 7 }, (_, index) => `public-page-${String(index + 7).padStart(3, "0")}`),
    );
    expect(
      new Set([...firstPage.items, ...secondPage.items].map((item) => item.documentId)).size,
    ).toBe(14);
  });

  it("round-trips the independently selected notification email locale through the API", async () => {
    const routes = makeClientWorkspaceRoutes(pgLayer());
    const path = `/v1/client-companies/${clientCompanyId}/notification-preferences`;
    const initial = await call(routes, "member-user", "GET", path);
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toEqual({
      preferences: {
        locale: "fr-FR",
        emailIssuePublished: false,
        emailDeliveryReminders: true,
        emailUsageLimits: true,
      },
    });

    const updatedPreferences = {
      locale: "en-US",
      emailIssuePublished: true,
      emailDeliveryReminders: false,
      emailUsageLimits: true,
    } as const;
    const updated = await call(routes, "member-user", "PUT", path, updatedPreferences);
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toEqual({ preferences: updatedPreferences });
    const reloaded = await call(routes, "member-user", "GET", path);
    await expect(reloaded.json()).resolves.toEqual({ preferences: updatedPreferences });

    const unsupported = await call(routes, "member-user", "PUT", path, {
      ...updatedPreferences,
      locale: "de-DE",
    });
    expect(unsupported.status).toBe(400);
  });

  it("lists every company source for admins and only active employee grants for members", async () => {
    const secondSubscriptionId = crypto.randomUUID();
    const secondAccessId = crypto.randomUUID();
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values ('scoped-member', 'scoped@example.test', 'Scoped Member', 'clerk-scoped-member')
        `;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values (${clientCompanyId}, 'scoped-member', 'member')
        `;
        yield* sql`
          insert into publisher_subscriptions (
            id, publisher_company_id, name, created_by_user_id
          ) values (${secondSubscriptionId}, ${publisherCompanyId}, 'Unassigned', 'admin-user')
        `;
        yield* sql`
          insert into client_subscription_accesses (
            id, subscription_id, client_company_id, state, first_admin_email,
            accepted_at, subscribed_at, created_by_user_id
          ) values (
            ${secondAccessId}, ${secondSubscriptionId}, ${clientCompanyId}, 'active',
            'admin@example.test', now(), now(), 'admin-user'
          )
        `;
        yield* sql`
          insert into client_employee_subscription_grants (
            access_id, client_company_id, user_id, granted_by_user_id
          ) values (${accessId}, ${clientCompanyId}, 'scoped-member', 'admin-user')
        `;
      }),
    );
    const routes = makeClientWorkspaceRoutes(pgLayer());
    const path = `/v1/client-companies/${clientCompanyId}/subscription-accesses`;
    const adminResponse = await call(routes, "admin-user", "GET", path);
    const memberResponse = await call(routes, "scoped-member", "GET", path);
    expect(adminResponse.status).toBe(200);
    expect(memberResponse.status).toBe(200);
    const admin = (await adminResponse.json()) as { accesses: readonly { accessId: string }[] };
    const member = (await memberResponse.json()) as { accesses: readonly { accessId: string }[] };
    expect(admin.accesses.map((access) => access.accessId).sort()).toEqual(
      [accessId, secondAccessId].sort(),
    );
    expect(member.accesses.map((access) => access.accessId)).toEqual([accessId]);

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_employee_subscription_grants
          set revoked_at = now(), revoked_by_user_id = 'admin-user'
          where access_id = ${accessId} and user_id = 'scoped-member'
        `;
      }),
    );
    const afterRevocation = await call(routes, "scoped-member", "GET", path);
    expect(afterRevocation.status).toBe(200);
    await expect(afterRevocation.json()).resolves.toEqual({ accesses: [] });
  });

  it("creates tax-enabled server-configured Checkout, limits, usage requests, and portal sessions", async () => {
    const ensureCustomer = vi.fn<BillingStripeGateway["ensureCustomer"]>(
      async (input) => input.customerId ?? "cus_created",
    );
    const checkout = vi.fn<BillingStripeGateway["checkout"]>(async () => ({
      sessionId: "cs_workspace",
      url: "https://stripe.test/checkout",
    }));
    const portal = vi.fn<BillingStripeGateway["portal"]>(async () => "https://stripe.test/portal");
    const changeMonthlyPlan = vi.fn<BillingStripeGateway["changeMonthlyPlan"]>(async () => ({
      kind: "upgraded",
      effectiveAt: "2026-07-10T00:00:00.000Z",
      externalOperationId: "subitem_test",
    }));
    const routes = makeBillingRoutes(pgLayer(), {
      ensureCustomer,
      checkout,
      portal,
      changeMonthlyPlan,
    });
    const additional = await call(
      routes,
      "admin-user",
      "POST",
      `/v1/client-companies/${clientCompanyId}/billing/checkout`,
      { kind: "additional", credits: 250, idempotencyKey: "checkout-workspace-additional" },
    );
    expect(additional.status).toBe(201);
    expect(checkout).toHaveBeenCalledWith(
      expect.objectContaining({
        priceId: "price_additional",
        credits: 250,
        automaticTaxEnabled: true,
        billingAddressCollection: "required",
        taxIdCollectionEnabled: true,
        updateExistingCustomerAddress: true,
        successUrl: "https://brief.test/billing/success",
      }),
    );
    for (const status of ["active", "trialing", "past_due", "paused"] as const) {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update client_ai_billing_accounts
            set status = ${status}, stripe_subscription_id = 'sub_previous'
            where client_company_id = ${clientCompanyId}
          `;
        }),
      );
      const blocked = await call(
        routes,
        "admin-user",
        "POST",
        `/v1/client-companies/${clientCompanyId}/billing/checkout`,
        { kind: "monthly", planTier: "light", idempotencyKey: "checkout-workspace-blocked" },
      );
      expect(blocked.status).toBe(409);
      await expect(blocked.json()).resolves.toEqual({ code: "monthly_plan_change_required" });
    }
    expect(checkout).toHaveBeenCalledTimes(1);

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_ai_billing_accounts
          set status = 'cancelled', stripe_subscription_id = 'sub_previous'
          where client_company_id = ${clientCompanyId}
        `;
      }),
    );
    const repurchase = await call(
      routes,
      "admin-user",
      "POST",
      `/v1/client-companies/${clientCompanyId}/billing/checkout`,
      { kind: "monthly", planTier: "light", idempotencyKey: "checkout-workspace-repurchase" },
    );
    expect(repurchase.status).toBe(201);
    expect(checkout).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "monthly",
        planTier: "light",
        credits: null,
        priceId: "price_light",
      }),
    );
    expect(
      (
        await call(
          routes,
          "admin-user",
          "POST",
          `/v1/client-companies/${clientCompanyId}/billing/portal`,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await call(
          routes,
          "admin-user",
          "PUT",
          `/v1/client-companies/${clientCompanyId}/ai-limit`,
          {
            companyMonthlyLimit: 80,
          },
        )
      ).status,
    ).toBe(200);
    const requested = await call(
      routes,
      "member-user",
      "POST",
      `/v1/client-companies/${clientCompanyId}/ai-usage-requests`,
      { requestedCredits: 20, reason: "Research deadline" },
    );
    expect(requested.status).toBe(201);
    const requestId = ((await requested.json()) as { request: { id: string } }).request.id;
    expect(
      (
        await call(
          routes,
          "admin-user",
          "POST",
          `/v1/client-companies/${clientCompanyId}/ai-usage-requests/${requestId}/resolve`,
          { decision: "approved" },
        )
      ).status,
    ).toBe(200);
  });

  it("retains removed employees' current-period usage in the company total", async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const chatId = crypto.randomUUID();
            yield* sql`
              insert into chats (id, user_id, company_id, memory_mode)
              values (${chatId}, 'member-user', ${clientCompanyId}, 'private_owner')
            `;
            const messages = yield* sql<{ readonly id: string }>`
              insert into chat_messages (chat_id, author, content)
              values (${chatId}, 'user', 'Retained usage fixture')
              returning id::text
            `;
            const runs = yield* sql<{ readonly id: string }>`
              insert into ai_runs (
                chat_id, initiating_user_id, user_message_id, locale, market, acceptance_scope, finished_at
              ) values (
                ${chatId}, 'member-user', ${messages[0]!.id}, 'en-US', 'US',
                ${sql.json({
                  userId: "member-user",
                  chatId,
                  companyId: clientCompanyId,
                  subscriptionIds: [],
                  accessIds: [],
                  publicSourceIds: [],
                  memoryMode: "private_owner",
                  memoryRevisionIds: [],
                  webRequested: false,
                  webEnabled: false,
                  provider: "zai_coding_plan_official",
                  fastModelId: "glm-5-turbo",
                  mainModelId: "glm-5-turbo",
                  webTransportProvider: null,
                  allowedDomains: null,
                })},
                now()
              )
              returning id::text
            `;
            const lots = yield* sql<{ readonly id: string }>`
              update client_credit_lots
              set credits_remaining = credits_remaining - 7
              where client_company_id = ${clientCompanyId} and kind = 'monthly'
              returning id::text
            `;
            const usages = yield* sql<{ readonly id: string }>`
              insert into client_credit_usage (
                client_company_id, user_id, ai_run_id, credits,
                calculation_version, calculation_inputs, idempotency_key, created_at
              ) values (
                ${clientCompanyId}, 'member-user', ${runs[0]!.id}, 7,
                'credits-v1', '{}'::jsonb, 'removed-member-current-period', now()
              )
              returning id::text
            `;
            yield* sql`
              insert into client_credit_usage_allocations (
                usage_id, credit_lot_id, client_company_id, credits
              ) values (${usages[0]!.id}, ${lots[0]!.id}, ${clientCompanyId}, 7)
            `;
          }),
        );
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              update client_company_memberships
              set revoked_at = now(), revoked_by_user_id = 'admin-user'
              where company_id = ${clientCompanyId} and user_id = 'member-user'
            `;
            yield* sql`
              update client_employee_subscription_grants
              set revoked_at = now(), revoked_by_user_id = 'admin-user'
              where client_company_id = ${clientCompanyId}
                and user_id = 'member-user'
                and revoked_at is null
            `;
          }),
        );
      }),
    );

    const overview = await call(
      makeBillingRoutes(pgLayer()),
      "admin-user",
      "GET",
      `/v1/client-companies/${clientCompanyId}/ai-usage`,
    );
    expect(overview.status).toBe(200);
    const overviewBody = (await overview.json()) as {
      usage: { employees: readonly { userId: string }[] };
    };
    expect(overviewBody).toMatchObject({
      usage: {
        companyUsedCredits: 7,
        employees: [expect.objectContaining({ userId: "admin-user", usedCredits: 0 })],
      },
    });
    expect(overviewBody.usage.employees).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: "member-user" })]),
    );
  });

  it("fails production chat credit preflight closed without inventing a debit formula", async () => {
    const apiConfig = await Effect.runPromise(
      loadApiConfig.pipe(
        Effect.provide(
          config("admin-user", {
            AUTH_MODE: "clerk",
            CLERK_SECRET_KEY: "secret",
            CLERK_PUBLISHABLE_KEY: "publishable",
          }),
        ),
      ),
    );
    const chat = {
      id: crypto.randomUUID(),
      user_id: "admin-user",
      company_id: clientCompanyId,
      memory_mode: "private_owner" as const,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const before = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly remaining: number; readonly usage: number }>`
          select
            (select sum(credits_remaining)::int from client_credit_lots
             where client_company_id = ${clientCompanyId}) as remaining,
            (select count(*)::int from client_credit_usage
             where client_company_id = ${clientCompanyId}) as usage
        `)[0]!;
      }),
    );
    await expect(runDb(preflightCredits(chat, "admin-user", apiConfig))).resolves.toBe(
      "credit_conversion_undefined",
    );
    const after = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly remaining: number; readonly usage: number }>`
          select
            (select sum(credits_remaining)::int from client_credit_lots
             where client_company_id = ${clientCompanyId}) as remaining,
            (select count(*)::int from client_credit_usage
             where client_company_id = ${clientCompanyId}) as usage
        `)[0]!;
      }),
    );
    expect(after).toEqual(before);

    const demoConfig = await Effect.runPromise(
      loadApiConfig.pipe(Effect.provide(config("admin-user", { AUTH_MODE: "demo" }))),
    );
    await expect(runDb(preflightCredits(chat, "admin-user", demoConfig))).resolves.toBeNull();
    expect(await runDb(preflightCredits(chat, "admin-user", demoConfig))).toBeNull();
  });

  it("defaults publisher pauses to the locked current billing-period end and validates explicit dates", async () => {
    const routes = makePublisherWorkspaceRoutes(pgLayer());
    const identity = {
      userId: "admin-user",
      organizationId: null,
      sessionId: "pause-default-test",
      mfaVerified: true,
      mode: "demo" as const,
    };
    const cases = {
      defaulted: { subscriptionId: crypto.randomUUID(), accessId: crypto.randomUUID() },
      noPeriod: { subscriptionId: crypto.randomUUID(), accessId: crypto.randomUUID() },
      expired: { subscriptionId: crypto.randomUUID(), accessId: crypto.randomUUID() },
      explicitMalformed: { subscriptionId: crypto.randomUUID(), accessId: crypto.randomUUID() },
      explicitPast: { subscriptionId: crypto.randomUUID(), accessId: crypto.randomUUID() },
      explicitFuture: { subscriptionId: crypto.randomUUID(), accessId: crypto.randomUUID() },
    } as const;
    const periodEnd = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        for (const [name, value] of Object.entries(cases)) {
          yield* sql`
            insert into publisher_subscriptions (
              id, publisher_company_id, name, created_by_user_id
            ) values (
              ${value.subscriptionId}, ${publisherCompanyId}, ${`Pause ${name}`}, 'admin-user'
            )
          `;
          yield* sql`
            insert into client_subscription_accesses (
              id, subscription_id, client_company_id, state, first_admin_email,
              accepted_at, subscribed_at, created_by_user_id
            ) values (
              ${value.accessId}, ${value.subscriptionId}, ${clientCompanyId}, 'active',
              'admin@example.test', clock_timestamp(), clock_timestamp(), 'admin-user'
            )
          `;
        }
        const periods = yield* sql<{ readonly periodEnd: Date }>`
          update client_ai_billing_accounts
          set status = 'active', current_period_start = clock_timestamp() - interval '1 day',
              current_period_end = clock_timestamp() + interval '20 days', updated_at = now()
          where client_company_id = ${clientCompanyId}
          returning current_period_end as "periodEnd"
        `;
        return periods[0]!.periodEnd.toISOString();
      }),
    );

    const defaulted = await call(
      routes,
      "admin-user",
      "POST",
      `/v1/client-subscription-accesses/${cases.defaulted.accessId}/pause`,
      { deliveryEndAt: null },
    );
    expect(defaulted.status).toBe(200);
    await expect(defaulted.json()).resolves.toEqual({
      status: "ending",
      deliveryEndAt: periodEnd,
    });
    await expect(
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly state: string;
            readonly deliveryEndAt: Date;
            readonly finalizerAt: Date;
            readonly succeededAudits: number;
          }>`
            select access.state, access.delivery_end_at as "deliveryEndAt",
                   finalizer.available_at as "finalizerAt",
                   (select count(*)::int
                    from platform_authorization_audit_log audit
                    where audit.action = 'publisher.client_access.pause'
                      and audit.scope_id = ${cases.defaulted.accessId}
                      and audit.outcome = 'succeeded') as "succeededAudits"
            from client_subscription_accesses access
            join jobs finalizer
              on finalizer.unique_key = ${`finalize-subscription-pause:${cases.defaulted.accessId}`}
            where access.id = ${cases.defaulted.accessId}
          `)[0]!;
        }),
      ),
    ).resolves.toEqual({
      state: "ending",
      deliveryEndAt: new Date(periodEnd),
      finalizerAt: new Date(periodEnd),
      succeededAudits: 1,
    });

    const noPeriodRequestId = crypto.randomUUID();
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_ai_billing_accounts
          set current_period_start = null, current_period_end = null, updated_at = now()
          where client_company_id = ${clientCompanyId}
        `;
      }),
    );
    await expect(
      runDb(
        pausePublisherClientAccess({
          identity,
          accessId: cases.noPeriod.accessId,
          deliveryEndAt: null,
          requestId: noPeriodRequestId,
        }),
      ),
    ).rejects.toMatchObject({ code: "delivery_end_invalid" });

    const expiredRequestId = crypto.randomUUID();
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_ai_billing_accounts
          set current_period_start = clock_timestamp() - interval '20 days',
              current_period_end = clock_timestamp() - interval '1 day', updated_at = now()
          where client_company_id = ${clientCompanyId}
        `;
      }),
    );
    await expect(
      runDb(
        pausePublisherClientAccess({
          identity,
          accessId: cases.expired.accessId,
          deliveryEndAt: null,
          requestId: expiredRequestId,
        }),
      ),
    ).rejects.toMatchObject({ code: "delivery_end_invalid" });

    const explicitTimes = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly past: Date; readonly future: Date }>`
          select clock_timestamp() - interval '1 minute' as past,
                 clock_timestamp() + interval '30 days' as future
        `)[0]!;
      }),
    );
    const malformed = await call(
      routes,
      "admin-user",
      "POST",
      `/v1/client-subscription-accesses/${cases.explicitMalformed.accessId}/pause`,
      { deliveryEndAt: "2026-08-01" },
    );
    expect(malformed.status).toBe(409);
    await expect(malformed.json()).resolves.toEqual({ code: "delivery_end_invalid" });

    const past = await call(
      routes,
      "admin-user",
      "POST",
      `/v1/client-subscription-accesses/${cases.explicitPast.accessId}/pause`,
      { deliveryEndAt: explicitTimes.past.toISOString() },
    );
    expect(past.status).toBe(409);
    await expect(past.json()).resolves.toEqual({ code: "delivery_end_invalid" });

    const futureEnd = explicitTimes.future.toISOString();
    const future = await call(
      routes,
      "admin-user",
      "POST",
      `/v1/client-subscription-accesses/${cases.explicitFuture.accessId}/pause`,
      { deliveryEndAt: futureEnd },
    );
    expect(future.status).toBe(200);
    await expect(future.json()).resolves.toEqual({
      status: "ending",
      deliveryEndAt: futureEnd,
    });

    const rejected = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly activeAccesses: number;
          readonly pauseJobs: number;
          readonly deniedAudits: number;
        }>`
          select
            (select count(*)::int from client_subscription_accesses
             where id in (
               ${cases.noPeriod.accessId}, ${cases.expired.accessId},
               ${cases.explicitMalformed.accessId}, ${cases.explicitPast.accessId}
             ) and state = 'active' and delivery_end_at is null) as "activeAccesses",
            (select count(*)::int from jobs
             where unique_key in (
               ${`finalize-subscription-pause:${cases.noPeriod.accessId}`},
               ${`finalize-subscription-pause:${cases.expired.accessId}`},
               ${`finalize-subscription-pause:${cases.explicitMalformed.accessId}`},
               ${`finalize-subscription-pause:${cases.explicitPast.accessId}`}
             )) as "pauseJobs",
            (select count(*)::int from platform_authorization_audit_log
             where action = 'publisher.client_access.pause'
               and scope_id in (
                 ${cases.noPeriod.accessId}, ${cases.expired.accessId},
                 ${cases.explicitMalformed.accessId}, ${cases.explicitPast.accessId}
               )
               and outcome = 'denied' and reason_code = 'delivery_end_invalid') as "deniedAudits"
        `)[0]!;
      }),
    );
    expect(rejected).toEqual({ activeAccesses: 4, pauseJobs: 0, deniedAudits: 4 });
  });

  it("onboards the first publisher admin and manages publisher client access/pause contracts", async () => {
    const platformProvider: PublisherOnboardingProvider = {
      ensureOrganization: async () => "org_new_publisher",
      inviteAdmin: async () => ({
        externalId: "inv_first_publisher",
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
    };
    const onboarding = makePublisherOnboardingRoute(pgLayer(), platformProvider);
    const onboarded = await call(
      [onboarding],
      "platform-admin",
      "POST",
      "/v1/platform/publisher-companies",
      {
        companyName: "New Publisher",
        firstAdminEmail: "first@publisher.test",
        idempotencyKey: "publisher-onboard-0001",
      },
    );
    expect(onboarded.status).toBe(201);

    const createClientInvitation = vi.fn<PublisherClientOnboardingProvider["createInvitation"]>(
      async () => ({
        externalId: `inv_client_${crypto.randomUUID()}`,
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
    );
    const clientProvider: PublisherClientOnboardingProvider = {
      ensureOrganization: async (input) => `org_client_${input.companyId}`,
      createInvitation: createClientInvitation,
    };
    const routes = makePublisherWorkspaceRoutes(pgLayer(), undefined, clientProvider);
    const invited = await call(
      routes,
      "admin-user",
      "POST",
      `/v1/publisher-subscriptions/${subscriptionId}/client-accesses`,
      {
        clientCompanyName: "Second Client",
        firstAdminEmail: "first@second-client.test",
        idempotencyKey: "client-access-0001",
      },
    );
    expect(invited.status).toBe(201);
    const replayed = await call(
      routes,
      "admin-user",
      "POST",
      `/v1/publisher-subscriptions/${subscriptionId}/client-accesses`,
      {
        clientCompanyName: "Second Client",
        firstAdminEmail: "first@second-client.test",
        idempotencyKey: "client-access-0001",
      },
    );
    expect(replayed.status).toBe(200);
    for (const changed of [
      {
        clientCompanyName: "Changed Client",
        firstAdminEmail: "first@second-client.test",
      },
      {
        clientCompanyName: "Second Client",
        firstAdminEmail: "changed@second-client.test",
      },
    ]) {
      const conflict = await call(
        routes,
        "admin-user",
        "POST",
        `/v1/publisher-subscriptions/${subscriptionId}/client-accesses`,
        { ...changed, idempotencyKey: "client-access-0001" },
      );
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toEqual({ code: "idempotency_conflict" });
    }

    const competing = await Promise.all([
      call(
        routes,
        "admin-user",
        "POST",
        `/v1/publisher-subscriptions/${subscriptionId}/client-accesses`,
        {
          clientCompanyName: "Concurrent Client A",
          firstAdminEmail: "admin-a@concurrent-client.test",
          idempotencyKey: "client-access-concurrent-0001",
        },
      ),
      call(
        routes,
        "admin-user",
        "POST",
        `/v1/publisher-subscriptions/${subscriptionId}/client-accesses`,
        {
          clientCompanyName: "Concurrent Client B",
          firstAdminEmail: "admin-b@concurrent-client.test",
          idempotencyKey: "client-access-concurrent-0001",
        },
      ),
    ]);
    expect(competing.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(createClientInvitation).toHaveBeenCalledTimes(2);
    const publisherDeliveryEnd = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const paused = await call(
      routes,
      "admin-user",
      "POST",
      `/v1/client-subscription-accesses/${accessId}/pause`,
      { deliveryEndAt: publisherDeliveryEnd },
    );
    expect(paused.status).toBe(200);
    await expect(paused.json()).resolves.toEqual({
      status: "ending",
      deliveryEndAt: publisherDeliveryEnd,
    });
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ state: string; finalizers: number; reminders: number }>`
          select
            (select state from client_subscription_accesses where id = ${accessId}) state,
            (select count(*)::int from jobs where kind = 'finalize_subscription_pause') finalizers,
            (select count(*)::int from jobs where kind = 'send_platform_notification') reminders
        `)[0]!;
      }),
    );
    expect(state).toEqual({ state: "ending", finalizers: 1, reminders: 4 });
    const metricsIssueId = crypto.randomUUID();
    const metricsDocuments = [
      { id: crypto.randomUUID(), text: "Metrics document A evidence" },
      { id: crypto.randomUUID(), text: "Metrics document B evidence" },
    ] as const;
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into publisher_issues (
            id, subscription_id, title, status, created_by_user_id
          ) values (${metricsIssueId}, ${subscriptionId}, 'Metrics issue', 'draft', 'admin-user')
        `;
        for (const document of metricsDocuments) {
          const pdfHash = "a".repeat(64);
          const contentHash = createHash("sha256").update(document.text, "utf8").digest("hex");
          const jobId = crypto.randomUUID();
          const extractionId = crypto.randomUUID();
          const versionId = crypto.randomUUID();
          yield* sql`
            insert into brief_documents (
              id, issue_id, title, original_file_name, object_key, media_type,
              byte_size, sha256_hex, upload_completed_at, created_by_user_id
            ) values (
              ${document.id}, ${metricsIssueId}, ${document.text}, ${`${document.id}.pdf`},
              ${`metrics/${document.id}.pdf`}, 'application/pdf', 1, ${pdfHash}, now(), 'admin-user'
            )
          `;
          yield* sql`
            insert into jobs (id, kind, payload)
            values (${jobId}, 'extract_pdf_text', '{}'::jsonb)
          `;
          yield* sql`
            insert into brief_document_extractions (
              id, brief_document_id, input_sha256_hex, pages, extracted_char_count, created_by_job_id
            ) values (
              ${extractionId}, ${document.id}, ${pdfHash},
              ${JSON.stringify([{ pageNumber: 1, text: document.text }])}::jsonb,
              ${document.text.length}, ${jobId}
            )
          `;
          yield* sql`
            insert into brief_document_versions (
              id, brief_document_id, publisher_extraction_id, content_hash, language,
              canonical_text, text_char_count, page_ranges
            ) values (
              ${versionId}, ${document.id}, ${extractionId}, ${contentHash}, 'en-US',
              ${document.text}, ${document.text.length},
              ${JSON.stringify([{ pageNumber: 1, charStart: 0, charEnd: document.text.length }])}::jsonb
            )
          `;
          yield* sql`
            update brief_documents set current_version_id = ${versionId}
            where id = ${document.id}
          `;
        }
        yield* sql`
          update publisher_issues
          set status = 'published', publication_at = now(), published_at = now()
          where id = ${metricsIssueId}
        `;
        yield* sql`
          insert into issue_deliveries (
            issue_id, subscription_id, access_id, client_company_id, historical
          ) values (${metricsIssueId}, ${subscriptionId}, ${accessId}, ${clientCompanyId}, false)
        `;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values
            (${clientCompanyId}, 'metrics-user-0', 'member'),
            (${clientCompanyId}, 'metrics-user-1', 'member')
        `;
        const runs: string[] = [];
        for (const index of [0, 1]) {
          const chatId = crypto.randomUUID();
          const userId = `metrics-user-${index}`;
          yield* sql`
            insert into chats (id, company_id, user_id, memory_mode)
            values (${chatId}, ${clientCompanyId}, ${userId}, 'private_owner')
          `;
          const messages = yield* sql<{ id: string }>`
            insert into chat_messages (chat_id, author, content)
            values (${chatId}, 'user', ${`Question ${index}`}) returning id::text
          `;
          const inserted = yield* sql<{ id: string }>`
            insert into ai_runs (
              chat_id, initiating_user_id, user_message_id, locale, market,
              acceptance_scope
            ) values (
              ${chatId}, ${userId}, ${messages[0]!.id}, 'fr-FR', 'FR',
              ${sql.json({
                userId,
                chatId,
                companyId: clientCompanyId,
                subscriptionIds: [],
                accessIds: [],
                publicSourceIds: [],
                memoryMode: "private_owner",
                memoryRevisionIds: [],
                webRequested: false,
                webEnabled: false,
                provider: "zai_coding_plan_official",
                fastModelId: "glm-5-turbo",
                mainModelId: "glm-5-turbo",
                webTransportProvider: null,
                allowedDomains: null,
              })}
            ) returning id::text
          `;
          runs.push(inserted[0]!.id);
        }
        for (const exposure of [
          { runId: runs[0]!, requestIndex: 0, document: metricsDocuments[0]!, tokens: 10 },
          { runId: runs[0]!, requestIndex: 1, document: metricsDocuments[0]!, tokens: 20 },
          { runId: runs[0]!, requestIndex: 0, document: metricsDocuments[1]!, tokens: 30 },
          { runId: runs[1]!, requestIndex: 0, document: metricsDocuments[0]!, tokens: 40 },
        ]) {
          const version = yield* sql<{ readonly id: string; readonly extractionId: string }>`
            select id::text, publisher_extraction_id::text as "extractionId"
            from brief_document_versions
            where brief_document_id = ${exposure.document.id}
          `;
          const contentHash = createHash("sha256")
            .update(exposure.document.text, "utf8")
            .digest("hex");
          const logicalSourceIdentity = namespacedPublisherDocumentIdentity(
            subscriptionId,
            metricsIssueId,
            exposure.document.id,
          );
          const ranges = [{ charStart: 0, charEnd: exposure.document.text.length }] as const;
          yield* sql`
            insert into ai_source_exposures (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              source_kind, logical_source_identity, publisher_issue_id,
              publisher_document_id, content_item_identity, exposure_stage,
              visible_token_count, document_source_id, document_id,
              version_id, content_hash, publisher_extraction_id, document_ranges
            ) values (
              ${exposure.runId}, 'single-retrieve-internal', 0, 0, ${exposure.requestIndex}, 'document',
              ${logicalSourceIdentity}, ${metricsIssueId},
              ${exposure.document.id}, ${documentContentItemIdentity(logicalSourceIdentity, version[0]!.id, ranges)}, 'internal_inspection',
              ${exposure.tokens}, ${`publisher:${subscriptionId}`}, ${exposure.document.id},
              ${version[0]!.id}, ${contentHash}, ${version[0]!.extractionId},
              ${JSON.stringify(ranges)}::jsonb
            )
          `;
        }
      }),
    );
    const metrics = await call(
      routes,
      "admin-user",
      "GET",
      `/v1/publisher-subscriptions/${subscriptionId}/ai-pull-metrics`,
    );
    expect(metrics.status).toBe(200);
    const expectedMetrics = [...metricsDocuments]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((document) => ({
        issueId: metricsIssueId,
        documentId: document.id,
        runPullCount: document.id === metricsDocuments[0]!.id ? 2 : 1,
        visibleTokenCount: document.id === metricsDocuments[0]!.id ? 70 : 30,
      }));
    await expect(metrics.json()).resolves.toEqual({
      metrics: expectedMetrics,
      issueTotals: [{ issueId: metricsIssueId, runPullCount: 2 }],
    });
  });

  it("leases publisher onboarding delivery across ambiguous failure, concurrency, and re-invite", async () => {
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
    const remoteByLocalId = new Map<string, string>();
    let ambiguous = true;
    const provider: PublisherOnboardingProvider = {
      ensureOrganization: async (input) => `org_onboarding_${input.companyId}`,
      inviteAdmin: async (input) => {
        const externalId =
          remoteByLocalId.get(input.workspaceInvitationId) ??
          `orginv_onboarding_${remoteByLocalId.size + 1}`;
        remoteByLocalId.set(input.workspaceInvitationId, externalId);
        if (ambiguous) {
          ambiguous = false;
          throw new Error("socket_closed_after_provider_commit");
        }
        return { externalId, expiresAt };
      },
    };
    const route = makePublisherOnboardingRoute(pgLayer(), provider);
    const body = {
      companyName: "Durable Publisher",
      firstAdminEmail: "durable-admin@publisher.test",
      idempotencyKey: "publisher-durable-onboard-0001",
    };
    const first = await call(
      [route],
      "platform-admin",
      "POST",
      "/v1/platform/publisher-companies",
      body,
    );
    expect(first.status).toBe(503);
    const afterAmbiguity = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ id: string; attempts: number; leased: boolean }>`
          select invitation.id::text, invitation.delivery_attempt_count as attempts,
                 invitation.delivery_lease_token is not null as leased
          from workspace_invitations invitation
          join publisher_companies company on company.id = invitation.publisher_company_id
          where company.onboarding_idempotency_key = ${body.idempotencyKey}
        `)[0]!;
      }),
    );
    expect(afterAmbiguity).toMatchObject({ attempts: 1, leased: false });
    const recovered = await call(
      [route],
      "platform-admin",
      "POST",
      "/v1/platform/publisher-companies",
      body,
    );
    expect(recovered.status).toBe(200);
    expect(new Set(remoteByLocalId.keys())).toEqual(new Set([afterAmbiguity.id]));

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`update workspace_invitations set state = 'revoked' where id = ${afterAmbiguity.id}`;
      }),
    );
    const reinvited = await call(
      [route],
      "platform-admin",
      "POST",
      "/v1/platform/publisher-companies",
      body,
    );
    expect(reinvited.status).toBe(200);
    expect(remoteByLocalId.size).toBe(2);

    let releaseProvider!: () => void;
    let providerEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const concurrentProvider: PublisherOnboardingProvider = {
      ensureOrganization: async (input) => `org_concurrent_${input.companyId}`,
      inviteAdmin: async () => {
        providerEntered();
        await release;
        return { externalId: "orginv_concurrent_onboarding", expiresAt };
      },
    };
    const concurrentRoute = makePublisherOnboardingRoute(pgLayer(), concurrentProvider);
    const concurrentBody = {
      companyName: "Concurrent Durable Publisher",
      firstAdminEmail: "concurrent-admin@publisher.test",
      idempotencyKey: "publisher-durable-onboard-0002",
    };
    const winner = call(
      [concurrentRoute],
      "platform-admin",
      "POST",
      "/v1/platform/publisher-companies",
      concurrentBody,
    );
    await entered;
    const loser = await call(
      [concurrentRoute],
      "platform-admin",
      "POST",
      "/v1/platform/publisher-companies",
      concurrentBody,
    );
    expect(loser.status).toBe(409);
    await expect(loser.json()).resolves.toEqual({ code: "invitation_delivery_in_progress" });
    releaseProvider();
    expect((await winner).status).toBe(201);
  });
});
