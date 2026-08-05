import { PgClient } from "@effect/sql-pg";
import {
  canonicalPublicSourceHttpsUrl,
  normalizeDomainAllowlist,
  type HartlibDocumentDescriptor,
  type ClientPublicSourceSetting,
  type ClientSubscriptionAccessDescriptor,
  type DeliveredArchiveResult,
  type NotificationPreferences,
  type PlatformNotificationDescriptor,
} from "@hartlib/shared";
import { Effect } from "effect";

import {
  appendAuthorizationAudit,
  auditDeniedThenFail,
  requireClientCompanyAdmin,
  requireClientCompanyMembership,
  WorkspaceAuthorizationError,
  WorkspaceRuleError,
  type WorkspaceIdentity,
} from "./common";

export const normalizeWorkspaceDomainAllowlist = (
  values: readonly string[] | null,
): ReturnType<typeof normalizeDomainAllowlist> => normalizeDomainAllowlist(values);

export const listClientSubscriptionAccesses = (identity: WorkspaceIdentity, companyId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${companyId}`}))
        `;
        yield* requireClientCompanyMembership(identity, companyId);
        const rows = yield* sql<{
          accessId: string;
          subscriptionId: string;
          subscriptionName: string;
          publisherCompanyId: string;
          publisherName: string;
          state: ClientSubscriptionAccessDescriptor["state"];
          deliveryEndAt: Date | null;
        }>`
      select access.id::text as "accessId",
             subscription.id::text as "subscriptionId",
             subscription.name as "subscriptionName",
             publisher.id::text as "publisherCompanyId",
             publisher.name as "publisherName",
             access.state,
             access.delivery_end_at as "deliveryEndAt"
      from client_subscription_accesses access
      join publisher_subscriptions subscription on subscription.id = access.subscription_id
      join publisher_companies publisher on publisher.id = subscription.publisher_company_id
      where access.client_company_id = ${companyId}
        and access.state in ('active', 'ending', 'paused')
        and (
          exists (
            select 1
            from client_company_memberships membership
            join client_companies company on company.id = membership.company_id
            where membership.company_id = access.client_company_id
              and membership.user_id = ${identity.userId}
              and membership.role = 'admin'
              and membership.revoked_at is null
              and company.recovery_deleted_at is null
              and company.purged_at is null
              and (
                ${identity.organizationId}::text is null
                or company.clerk_organization_id = ${identity.organizationId}
              )
          )
          or exists (
            select 1
            from client_employee_subscription_grants employee_grant
            where employee_grant.access_id = access.id
              and employee_grant.client_company_id = access.client_company_id
              and employee_grant.user_id = ${identity.userId}
              and employee_grant.revoked_at is null
          )
        )
      order by lower(publisher.name), lower(subscription.name), access.id
    `;
        return rows.map(
          (access): ClientSubscriptionAccessDescriptor => ({
            ...access,
            deliveryEndAt: access.deliveryEndAt?.toISOString() ?? null,
          }),
        );
      }),
    );
  });

const selectClientPublicSources = (companyId: string, sourceId: string | null) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql<ClientPublicSourceSetting>`
      select sources.source_id as "sourceId", sources.display_name as "displayName",
             sources.publisher_name as "publisherName", sources.description,
             coalesce(sources.country, '') as country,
             coalesce(sources.language, '') as language,
             coalesce(settings.enabled, false) as enabled
      from public_sources sources
      left join client_company_public_source_settings settings
        on settings.source_id = sources.source_id
       and settings.client_company_id = ${companyId}
      where (${sourceId}::text is null or sources.source_id = ${sourceId})
      order by lower(sources.display_name), sources.source_id
    `;
  });

export const listClientPublicSources = (identity: WorkspaceIdentity, companyId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${companyId}`}))
        `;
        yield* requireClientCompanyMembership(identity, companyId);
        return yield* selectClientPublicSources(companyId, null);
      }),
    );
  });

export const updateClientPublicSource = (input: {
  readonly identity: WorkspaceIdentity;
  readonly companyId: string;
  readonly sourceId: string;
  readonly enabled: boolean;
  readonly requestId: string;
}) => {
  const operation = Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${input.companyId}`}))
        `;
        yield* requireClientCompanyAdmin(input.identity, input.companyId);
        const exists = yield* sql<{ exists: boolean }>`
          select exists(select 1 from public_sources where source_id = ${input.sourceId}) exists
        `;
        if (exists[0]?.exists !== true) {
          return yield* Effect.fail(new WorkspaceAuthorizationError("not_found"));
        }
        yield* sql`
          insert into client_company_public_source_settings (
            client_company_id, source_id, enabled, updated_by_user_id
          ) values (
            ${input.companyId}, ${input.sourceId}, ${input.enabled}, ${input.identity.userId}
          )
          on conflict (client_company_id, source_id) do update set
            enabled = excluded.enabled,
            updated_by_user_id = excluded.updated_by_user_id,
            updated_at = now()
        `;
        yield* appendAuthorizationAudit({
          identity: input.identity,
          requestId: input.requestId,
          action: "client.public_source.update",
          scopeKind: "public_source",
          scopeId: input.sourceId,
          outcome: "succeeded",
        });
        const rows = yield* selectClientPublicSources(input.companyId, input.sourceId);
        if (rows[0] === undefined) {
          return yield* Effect.fail(new WorkspaceAuthorizationError("not_found"));
        }
        return rows[0];
      }),
    );
  });
  return operation.pipe(
    Effect.catch((error) =>
      auditDeniedThenFail(
        input.identity,
        input.requestId,
        "client.public_source.update",
        "public_source",
        input.sourceId,
        error,
      ),
    ),
  );
};

export interface ClientWebPolicySettings {
  readonly enabled: boolean;
  readonly allowedDomains: readonly string[] | null;
}

const selectClientWebPolicy = (companyId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<ClientWebPolicySettings>`
      select coalesce(web_search_enabled, false) enabled,
             web_domain_allowlist as "allowedDomains"
      from (select 1) seed
      left join client_company_ai_settings settings
        on settings.company_id = ${companyId}
    `;
    return rows[0]!;
  });

export const getClientWebPolicy = (identity: WorkspaceIdentity, companyId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${companyId}`}))
        `;
        yield* requireClientCompanyMembership(identity, companyId);
        return yield* selectClientWebPolicy(companyId);
      }),
    );
  });

export const updateClientWebPolicy = (input: {
  readonly identity: WorkspaceIdentity;
  readonly companyId: string;
  readonly enabled: boolean;
  readonly allowedDomains: readonly string[] | null;
  readonly deploymentAvailable: boolean;
  readonly requestId: string;
}) => {
  const normalized = normalizeWorkspaceDomainAllowlist(input.allowedDomains);
  const operation = normalized.ok
    ? Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${input.companyId}`}))
            `;
            yield* requireClientCompanyAdmin(input.identity, input.companyId);
            if (input.enabled && !input.deploymentAvailable) {
              return yield* Effect.fail(
                new WorkspaceRuleError("web_research_deployment_unavailable"),
              );
            }
            yield* sql`
              insert into client_company_ai_settings (
                company_id, web_search_enabled, web_domain_allowlist
              ) values (${input.companyId}, ${input.enabled}, ${normalized.domains})
              on conflict (company_id) do update set
                web_search_enabled = excluded.web_search_enabled,
                web_domain_allowlist = excluded.web_domain_allowlist,
                updated_at = now()
            `;
            yield* appendAuthorizationAudit({
              identity: input.identity,
              requestId: input.requestId,
              action: "client.web_policy.update",
              scopeKind: "client_company",
              scopeId: input.companyId,
              outcome: "succeeded",
            });
            return yield* selectClientWebPolicy(input.companyId);
          }),
        );
      })
    : Effect.fail(new WorkspaceRuleError("invalid_body"));
  return operation.pipe(
    Effect.catch((error) =>
      auditDeniedThenFail(
        input.identity,
        input.requestId,
        "client.web_policy.update",
        "client_company",
        input.companyId,
        error,
      ),
    ),
  );
};

export interface CompanyDeletionRequestDescriptor {
  readonly id: string;
  readonly status: "requested" | "approved" | "rejected" | "completed";
  readonly requestedAt: string;
  readonly resolvedAt: string | null;
}

const selectCompanyDeletionRequests = (companyId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{
      id: string;
      status: CompanyDeletionRequestDescriptor["status"];
      requestedAt: Date;
      resolvedAt: Date | null;
    }>`
      select id::text, status, requested_at as "requestedAt", resolved_at as "resolvedAt"
      from company_deletion_requests
      where client_company_id = ${companyId}
      order by requested_at desc, id desc limit 50
    `;
    return rows.map(
      (row): CompanyDeletionRequestDescriptor => ({
        ...row,
        requestedAt: row.requestedAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
      }),
    );
  });

export const listCompanyDeletionRequests = (identity: WorkspaceIdentity, companyId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${companyId}`}))
        `;
        yield* requireClientCompanyAdmin(identity, companyId);
        return yield* selectCompanyDeletionRequests(companyId);
      }),
    );
  });

export const createCompanyDeletionRequest = (input: {
  readonly identity: WorkspaceIdentity;
  readonly companyId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
}) => {
  const operation = Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${input.companyId}`}))
        `;
        yield* requireClientCompanyAdmin(input.identity, input.companyId);
        const prior = yield* sql<{ id: string; reasonMatches: boolean }>`
          select id::text, reason = ${input.reason} as "reasonMatches"
          from company_deletion_requests
          where client_company_id = ${input.companyId}
            and idempotency_key = ${input.idempotencyKey}
          for update
        `;
        if (prior[0] !== undefined && !prior[0].reasonMatches) {
          return yield* Effect.fail(new WorkspaceRuleError("idempotency_conflict"));
        }
        if (prior[0] === undefined) {
          yield* sql`
            insert into company_deletion_requests (
              client_company_id, requested_by_user_id, reason, idempotency_key
            ) values (
              ${input.companyId}, ${input.identity.userId}, ${input.reason},
              ${input.idempotencyKey}
            )
          `;
          yield* appendAuthorizationAudit({
            identity: input.identity,
            requestId: input.requestId,
            action: "client.company_deletion.request",
            scopeKind: "client_company",
            scopeId: input.companyId,
            outcome: "succeeded",
          });
        }
        return yield* selectCompanyDeletionRequests(input.companyId);
      }),
    );
  });
  return operation.pipe(
    Effect.catch((error) =>
      auditDeniedThenFail(
        input.identity,
        input.requestId,
        "client.company_deletion.request",
        "client_company",
        input.companyId,
        error,
      ),
    ),
  );
};

interface ArchiveRow {
  readonly sourceKind: "publisher" | "public";
  readonly issueId: string | null;
  readonly subscriptionId: string | null;
  readonly sourceId: string | null;
  readonly subscriptionName: string;
  readonly publisherName: string;
  readonly issueTitle: string;
  readonly publicationAt: Date;
  readonly deliveredAt: Date;
  readonly documentId: string;
  readonly documentTitle: string;
  readonly snippet: string | null;
  readonly mediaType: "application/pdf" | "text/html";
  readonly canonicalUrl: string | null;
}

export type DeliveredArchiveSourceFilter =
  | { readonly kind: "publisher"; readonly subscriptionId: string }
  | { readonly kind: "public"; readonly sourceId: string };

const listDeliveredArchiveLocked = (input: {
  readonly identity: WorkspaceIdentity;
  readonly companyId: string;
  readonly query: string;
  readonly sourceFilter: DeliveredArchiveSourceFilter | null;
  readonly offset: number;
  readonly limit: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const includePublisher = input.sourceFilter === null || input.sourceFilter.kind === "publisher";
    const publisherSubscriptionId =
      input.sourceFilter?.kind === "publisher" ? input.sourceFilter.subscriptionId : null;
    const includePublic = input.sourceFilter === null || input.sourceFilter.kind === "public";
    const publicSourceId =
      input.sourceFilter?.kind === "public" ? input.sourceFilter.sourceId : null;
    const rows = yield* sql<ArchiveRow>`
      with publisher_candidates as (
        select issue.id::text as "issueId",
               'publisher'::text as "sourceKind",
               subscription.id::text as "subscriptionId",
               null::text as "sourceId",
               subscription.name as "subscriptionName",
               publisher.name as "publisherName",
               issue.title as "issueTitle",
               issue.publication_at as "publicationAt",
               delivery.delivered_at as "deliveredAt",
               document.id::text as "documentId",
               document.title as "documentTitle",
               'application/pdf'::text as "mediaType",
               null::text as "canonicalUrl",
               version.language as "snippetLanguage",
               case
                 when ${input.query} = '' or version.id is null or not (
                   version.search_vector @@ websearch_to_tsquery(
                     language_to_regconfig(version.language), ${input.query}
                   )
                 ) then null
                 else version.canonical_text
               end as "snippetText"
        from issue_deliveries delivery
        join issue_delivery_recipients recipient
          on recipient.issue_id = delivery.issue_id
         and recipient.client_company_id = delivery.client_company_id
         and recipient.user_id = ${input.identity.userId}
        join publisher_issues issue on issue.id = delivery.issue_id
        join publisher_subscriptions subscription on subscription.id = issue.subscription_id
        join publisher_companies publisher on publisher.id = subscription.publisher_company_id
        join hartlib_documents document on document.issue_id = issue.id and document.deleted_at is null
        left join hartlib_document_versions version on version.id = document.current_version_id
        where delivery.client_company_id = ${input.companyId}
          and ${includePublisher}
          and issue.status = 'published'
          and issue.restricted_at is null and issue.deleted_at is null
          and btrim(lower(split_part(document.media_type, ';', 1))) = 'application/pdf'
          and (${publisherSubscriptionId}::uuid is null or subscription.id = ${publisherSubscriptionId})
          and (
            ${input.query} = ''
            or to_tsvector(
              'simple', coalesce(issue.title, '') || ' ' || coalesce(document.title, '')
            ) @@ websearch_to_tsquery('simple', ${input.query})
            or (
              version.id is not null
              and version.search_vector @@ websearch_to_tsquery(
                language_to_regconfig(version.language), ${input.query}
              )
            )
          )
      ),
      public_candidates as (
        select null::text as "issueId",
               'public'::text as "sourceKind",
               null::text as "subscriptionId",
               sources.source_id as "sourceId",
               sources.display_name as "subscriptionName",
               sources.publisher_name as "publisherName",
               items.title as "issueTitle",
               coalesce(items.published_at, items.discovered_at) as "publicationAt",
               settings.updated_at as "deliveredAt",
               documents.document_id as "documentId",
               documents.title as "documentTitle",
               btrim(lower(split_part(artifacts.media_type, ';', 1))) as "mediaType",
               items.canonical_url as "canonicalUrl",
               documents.language as "snippetLanguage",
               case when ${input.query} = '' then null else documents.text end as "snippetText"
        from client_company_public_source_settings settings
        join public_sources sources on sources.source_id = settings.source_id
        join public_source_items items on items.source_id = sources.source_id
        join public_source_documents documents on documents.document_id = items.latest_document_id
        join public_source_raw_artifacts artifacts on artifacts.id = documents.raw_artifact_id
        where settings.client_company_id = ${input.companyId} and settings.enabled
          and ${includePublic}
          and (${publicSourceId}::text is null or sources.source_id = ${publicSourceId})
          and documents.text_char_count >= 100
          and hartlib_public_source_https_url_allowed(items.canonical_url)
          and btrim(lower(split_part(artifacts.media_type, ';', 1)))
            in ('text/html', 'application/pdf')
          and (
            ${input.query} = ''
            or to_tsvector(
              'simple', coalesce(items.title, '') || ' ' || coalesce(documents.title, '')
            ) @@ websearch_to_tsquery('simple', ${input.query})
            or documents.search_vector @@ websearch_to_tsquery(
              language_to_regconfig(documents.language), ${input.query}
            )
          )
      ),
      candidates as (
        select * from publisher_candidates
        union all
        select * from public_candidates
      ),
      page as (
        select *
        from candidates
        order by "deliveredAt" desc,
                 "sourceKind" asc,
                 coalesce("issueId", "sourceId", "documentId") asc,
                 "documentId" asc
        limit ${input.limit}
        offset ${input.offset}
      )
      select "issueId", "sourceKind", "subscriptionId", "sourceId",
             "subscriptionName", "publisherName", "issueTitle", "publicationAt",
             "deliveredAt", "documentId", "documentTitle", "mediaType", "canonicalUrl",
             case
               when "snippetText" is null or "snippetLanguage" is null then null
               else ts_headline(
                 language_to_regconfig("snippetLanguage"),
                 "snippetText",
                 websearch_to_tsquery(language_to_regconfig("snippetLanguage"), ${input.query}),
                 'MaxWords=35,MinWords=12,ShortWord=2,HighlightAll=false'
               )
             end as snippet
      from page
      order by "deliveredAt" desc,
               "sourceKind" asc,
               coalesce("issueId", "sourceId", "documentId") asc,
               "documentId" asc
    `;
    return rows.map((row): DeliveredArchiveResult => {
      const common = {
        subscriptionName: row.subscriptionName,
        publisherName: row.publisherName,
        issueTitle: row.issueTitle,
        publicationAt: row.publicationAt.toISOString(),
        deliveredAt: row.deliveredAt.toISOString(),
        documentId: row.documentId,
        documentTitle: row.documentTitle,
        snippet: row.snippet,
        mediaType: row.mediaType,
        canonicalUrl:
          row.canonicalUrl === null ? null : canonicalPublicSourceHttpsUrl(row.canonicalUrl),
      };
      if (row.sourceKind === "publisher" && row.subscriptionId !== null && row.issueId !== null) {
        return {
          ...common,
          sourceKind: "publisher",
          subscriptionId: row.subscriptionId,
          issueId: row.issueId,
          contentPath: `/v1/issues/${row.issueId}/documents/${row.documentId}/content`,
        };
      }
      if (row.sourceKind === "public" && row.sourceId !== null) {
        return {
          ...common,
          sourceKind: "public",
          sourceId: row.sourceId,
          contentPath: `/public-source-documents/${encodeURIComponent(row.documentId)}/content`,
        };
      }
      throw new Error("archive_source_shape_invalid");
    });
  });

export const listDeliveredArchive = (input: {
  readonly identity: WorkspaceIdentity;
  readonly companyId: string;
  readonly query: string;
  readonly sourceFilter: DeliveredArchiveSourceFilter | null;
  readonly offset: number;
  readonly limit: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${input.companyId}`}))
        `;
        yield* requireClientCompanyMembership(input.identity, input.companyId);
        return yield* listDeliveredArchiveLocked(input);
      }),
    );
  });

export interface ClientIssueDescriptor {
  readonly id: string;
  readonly subscriptionId: string;
  readonly title: string;
  readonly status: "draft" | "scheduled" | "published";
  readonly publicationAt: string | null;
  readonly publishedAt: string | null;
  readonly historical: boolean;
  readonly indexingStatus: "pending" | "extracting" | "indexing" | "ready" | "failed";
  readonly indexingErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const getClientIssue = (identity: WorkspaceIdentity, issueId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const lanes = yield* sql<{ readonly key: string }>`
          select 'publisher:' || subscription.publisher_company_id::text as key
          from publisher_issues issue
          join publisher_subscriptions subscription on subscription.id = issue.subscription_id
          join publisher_company_memberships membership
            on membership.publisher_company_id = subscription.publisher_company_id
           and membership.user_id = ${identity.userId}
          where issue.id = ${issueId}
          union
          select 'client:' || delivery.client_company_id::text as key
          from issue_deliveries delivery
          join client_company_memberships membership
            on membership.company_id = delivery.client_company_id
           and membership.user_id = ${identity.userId}
           and membership.revoked_at is null
          join issue_delivery_recipients recipient
            on recipient.issue_id = delivery.issue_id
           and recipient.client_company_id = delivery.client_company_id
           and recipient.user_id = ${identity.userId}
          where delivery.issue_id = ${issueId}
          order by key
        `;
        for (const lane of lanes) {
          const separator = lane.key.indexOf(":");
          const kind = lane.key.slice(0, separator);
          const companyId = lane.key.slice(separator + 1);
          yield* sql`
            select pg_advisory_xact_lock(
              hashtext(${kind === "publisher" ? `hartlib:publisher-members:${companyId}` : `hartlib:client-members:${companyId}`})
            )
          `;
        }
        const rows = yield* sql<{
          issueId: string;
          subscriptionId: string;
          issueTitle: string;
          issueStatus: ClientIssueDescriptor["status"];
          publicationAt: Date | null;
          publishedAt: Date | null;
          historical: boolean;
          indexingStatus: ClientIssueDescriptor["indexingStatus"];
          indexingErrorCode: string | null;
          issueCreatedAt: Date;
          issueUpdatedAt: Date;
          documentId: string | null;
          documentTitle: string | null;
          originalFileName: string | null;
          mediaType: "application/pdf" | null;
          byteSize: string | number | bigint | null;
          sha256Hex: string | null;
          documentCreatedAt: Date | null;
        }>`
      select issue.id::text as "issueId",
             issue.subscription_id::text as "subscriptionId",
             issue.title as "issueTitle", issue.status as "issueStatus",
             issue.publication_at as "publicationAt", issue.published_at as "publishedAt",
             issue.historical, issue.indexing_status as "indexingStatus",
             issue.indexing_error_code as "indexingErrorCode",
             issue.created_at as "issueCreatedAt", issue.updated_at as "issueUpdatedAt",
             document.id::text as "documentId", document.title as "documentTitle",
             document.original_file_name as "originalFileName",
             document.media_type as "mediaType", document.byte_size as "byteSize",
             document.sha256_hex as "sha256Hex", document.created_at as "documentCreatedAt"
      from publisher_issues issue
      join publisher_subscriptions subscription on subscription.id = issue.subscription_id
      left join hartlib_documents document
        on document.issue_id = issue.id and document.deleted_at is null
      where issue.id = ${issueId}
        and issue.restricted_at is null and issue.deleted_at is null
        and exists (
          select 1 from platform_users users
          where users.id = ${identity.userId}
            and users.recovery_deleted_at is null and users.purged_at is null
        )
        and (
          exists (
            select 1
            from publisher_company_memberships membership
            join publisher_companies publisher_company
              on publisher_company.id = membership.publisher_company_id
            where membership.publisher_company_id = subscription.publisher_company_id
              and membership.user_id = ${identity.userId}
              and membership.accepted_at is not null
              and (
                ${identity.mode} = 'demo'
                or ${identity.organizationId}::text is null
                or publisher_company.clerk_organization_id = ${identity.organizationId}
              )
              and (
                membership.role = 'admin'
                or exists (
                  select 1
                  from publisher_membership_subscription_grants grant_row
                  where grant_row.publisher_company_id = membership.publisher_company_id
                    and grant_row.user_id = membership.user_id
                    and grant_row.subscription_id = subscription.id
                )
              )
          )
          or exists (
            select 1
            from issue_deliveries delivery
            join client_companies company
             on company.id = delivery.client_company_id
             and company.recovery_deleted_at is null and company.purged_at is null
            join client_company_memberships membership
              on membership.company_id = delivery.client_company_id
             and membership.user_id = ${identity.userId}
             and membership.revoked_at is null
            join issue_delivery_recipients recipient
              on recipient.issue_id = delivery.issue_id
             and recipient.client_company_id = delivery.client_company_id
             and recipient.user_id = ${identity.userId}
            where delivery.issue_id = issue.id
              and (
                ${identity.mode} = 'demo'
                or ${identity.organizationId}::text is null
                or company.clerk_organization_id = ${identity.organizationId}
              )
          )
        )
      order by document.created_at nulls last, document.id nulls last
    `;
        const first = rows[0];
        if (first === undefined) {
          return yield* Effect.fail(new WorkspaceAuthorizationError("forbidden"));
        }
        return {
          issue: {
            id: first.issueId,
            subscriptionId: first.subscriptionId,
            title: first.issueTitle,
            status: first.issueStatus,
            publicationAt: first.publicationAt?.toISOString() ?? null,
            publishedAt: first.publishedAt?.toISOString() ?? null,
            historical: first.historical,
            indexingStatus: first.indexingStatus,
            indexingErrorCode: first.indexingErrorCode,
            createdAt: first.issueCreatedAt.toISOString(),
            updatedAt: first.issueUpdatedAt.toISOString(),
          } satisfies ClientIssueDescriptor,
          documents: rows.flatMap((row): readonly HartlibDocumentDescriptor[] =>
            row.documentId === null ||
            row.documentTitle === null ||
            row.originalFileName === null ||
            row.mediaType === null ||
            row.byteSize === null ||
            row.sha256Hex === null ||
            row.documentCreatedAt === null
              ? []
              : [
                  {
                    id: row.documentId,
                    issueId: row.issueId,
                    title: row.documentTitle,
                    originalFileName: row.originalFileName,
                    mediaType: row.mediaType,
                    byteSize: Number(row.byteSize),
                    sha256Hex: row.sha256Hex,
                    createdAt: row.documentCreatedAt.toISOString(),
                  },
                ],
          ),
        };
      }),
    );
  });

export const listClientNotifications = (input: {
  readonly identity: WorkspaceIdentity;
  readonly companyId: string;
  readonly offset: number;
  readonly limit: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${input.companyId}`}))
        `;
        yield* requireClientCompanyMembership(input.identity, input.companyId);
        const rows = yield* sql<{
          id: string;
          kind: PlatformNotificationDescriptor["kind"];
          issueId: string | null;
          accessId: string | null;
          createdAt: Date;
          readAt: Date | null;
        }>`
          select id::text, kind, issue_id::text as "issueId", access_id::text as "accessId",
                 created_at as "createdAt", read_at as "readAt"
          from platform_notifications
          where client_company_id = ${input.companyId} and user_id = ${input.identity.userId}
          order by created_at desc, id desc
          limit ${input.limit} offset ${input.offset}
        `;
        return rows.map(
          (row): PlatformNotificationDescriptor => ({
            ...row,
            createdAt: row.createdAt.toISOString(),
            readAt: row.readAt?.toISOString() ?? null,
          }),
        );
      }),
    );
  });

export const markClientNotificationRead = (identity: WorkspaceIdentity, notificationId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const notifications = yield* sql<{ companyId: string }>`
          select client_company_id::text as "companyId"
          from platform_notifications
          where id = ${notificationId} and user_id = ${identity.userId}
        `;
        const companyId = notifications[0]?.companyId;
        if (companyId === undefined) return null;
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${companyId}`}))
        `;
        const rows = yield* sql<{ readAt: Date }>`
          update platform_notifications notification
          set read_at = coalesce(notification.read_at, now())
          where notification.id = ${notificationId} and notification.user_id = ${identity.userId}
            and exists (
              select 1
              from client_company_memberships membership
              join client_companies company on company.id = membership.company_id
              join platform_users users on users.id = membership.user_id
              where membership.company_id = notification.client_company_id
                and membership.user_id = ${identity.userId}
                and membership.revoked_at is null
                and company.recovery_deleted_at is null and company.purged_at is null
                and (
                  ${identity.organizationId}::text is null
                  or company.clerk_organization_id = ${identity.organizationId}
                )
                and users.recovery_deleted_at is null and users.purged_at is null
            )
          returning notification.read_at as "readAt"
        `;
        return rows[0]?.readAt.toISOString() ?? null;
      }),
    );
  });

const selectNotificationPreferences = (identity: WorkspaceIdentity, companyId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<NotificationPreferences>`
      select coalesce(locale, 'fr-FR') as locale,
             coalesce(email_issue_published, false) as "emailIssuePublished",
             coalesce(email_delivery_reminders, true) as "emailDeliveryReminders",
             coalesce(email_usage_limits, true) as "emailUsageLimits"
      from (select 1) seed
      left join notification_preferences preferences
        on preferences.client_company_id = ${companyId}
       and preferences.user_id = ${identity.userId}
    `;
    return rows[0]!;
  });

export const getNotificationPreferences = (identity: WorkspaceIdentity, companyId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${companyId}`}))
        `;
        yield* requireClientCompanyMembership(identity, companyId);
        return yield* selectNotificationPreferences(identity, companyId);
      }),
    );
  });

export const updateNotificationPreferences = (input: {
  readonly identity: WorkspaceIdentity;
  readonly companyId: string;
  readonly preferences: NotificationPreferences;
  readonly requestId: string;
  readonly auditSucceeded?: Effect.Effect<void, unknown, PgClient.PgClient>;
}) => {
  const operation = Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${input.companyId}`}))
        `;
        yield* requireClientCompanyMembership(input.identity, input.companyId);
        yield* sql`
          insert into notification_preferences (
            client_company_id, user_id, locale, email_issue_published,
            email_delivery_reminders, email_usage_limits
          ) values (
            ${input.companyId}, ${input.identity.userId},
            ${input.preferences.locale},
            ${input.preferences.emailIssuePublished},
            ${input.preferences.emailDeliveryReminders}, ${input.preferences.emailUsageLimits}
          )
          on conflict (client_company_id, user_id) do update set
            locale = excluded.locale,
            email_issue_published = excluded.email_issue_published,
            email_delivery_reminders = excluded.email_delivery_reminders,
            email_usage_limits = excluded.email_usage_limits,
            updated_at = now()
        `;
        yield* (
          input.auditSucceeded ??
            appendAuthorizationAudit({
              identity: input.identity,
              requestId: input.requestId,
              action: "client.notification_preferences.update",
              scopeKind: "client_company",
              scopeId: input.companyId,
              outcome: "succeeded",
            })
        );
        return yield* selectNotificationPreferences(input.identity, input.companyId);
      }),
    );
  });
  return operation.pipe(
    Effect.catch((error) =>
      auditDeniedThenFail(
        input.identity,
        input.requestId,
        "client.notification_preferences.update",
        "client_company",
        input.companyId,
        error,
      ),
    ),
  );
};
