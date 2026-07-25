import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";

export interface PublisherDocumentRow {
  readonly objectKey: string;
  readonly mediaType: string;
  readonly fileName: string;
}

export interface PublisherDocumentIdentity {
  readonly userId: string;
  readonly organizationId: string | null;
  readonly mode: "demo" | "clerk";
}

/**
 * Resolve the private file and its request-time authorization from one database
 * snapshot. A delivered publication uses its immutable recipient record;
 * current subscription, grant, and source settings do not revoke it.
 */
export const selectAuthorizedPublisherDocument = (
  identity: PublisherDocumentIdentity,
  issueId: string,
  documentId: string,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<PublisherDocumentRow>`
      select document.object_key as "objectKey",
             document.media_type as "mediaType",
             document.original_file_name as "fileName"
      from brief_documents document
      join publisher_issues issue
        on issue.id = document.issue_id
       and issue.restricted_at is null
       and issue.deleted_at is null
      join publisher_subscriptions issue_subscription
        on issue_subscription.id = issue.subscription_id
      join publisher_companies issue_publisher_company
        on issue_publisher_company.id = issue_subscription.publisher_company_id
      where document.id = ${documentId}
        and document.issue_id = ${issueId}
        and document.deleted_at is null
        and exists (
          select 1
          from platform_users users
          where users.id = ${identity.userId}
            and users.recovery_deleted_at is null
            and users.purged_at is null
        )
        and (
          exists (
            select 1
            from publisher_subscriptions subscription
            join publisher_companies publisher_company
              on publisher_company.id = subscription.publisher_company_id
            join publisher_company_memberships membership
              on membership.publisher_company_id = subscription.publisher_company_id
             and membership.user_id = ${identity.userId}
             and membership.accepted_at is not null
            where subscription.id = issue.subscription_id
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
             and company.recovery_deleted_at is null
             and company.purged_at is null
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
      limit 1
    `;
    return rows[0] ?? null;
  });

/**
 * Keeps the authorization rows and membership lanes stable until the caller
 * finishes issuing the short-lived bearer URL.
 */
export const withAuthorizedPublisherDocumentLease = <A, E, R>(
  identity: PublisherDocumentIdentity,
  issueId: string,
  documentId: string,
  operation: (document: PublisherDocumentRow) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const candidates = yield* sql<{
          readonly publisherCompanyId: string;
        }>`
          select subscription.publisher_company_id::text as "publisherCompanyId"
          from brief_documents document
          join publisher_issues issue on issue.id = document.issue_id
          join publisher_subscriptions subscription on subscription.id = issue.subscription_id
          where document.id = ${documentId} and document.issue_id = ${issueId}
          for share of document, issue
        `;
        const candidate = candidates[0];
        if (candidate === undefined) return null;
        // The delivered-client lanes are part of the document's stable
        // authorization boundary, not a projection of the requester's current
        // membership. Discover every delivered company while the shared issue
        // lock is held, then lock the complete sorted set before rechecking
        // authorization. This prevents a membership acceptance/revocation
        // mutation from committing in the signing gap for a company where the
        // requester was not yet a member at discovery time.
        const clientCompanies = yield* sql<{ readonly id: string }>`
          select distinct delivery.client_company_id::text as id
          from issue_deliveries delivery
          where delivery.issue_id = ${issueId}
          order by delivery.client_company_id::text
        `;
        const clientCompanyIds = clientCompanies.map((company) => company.id);
        const laneKeys = [
          `publisher:${candidate.publisherCompanyId}`,
          ...clientCompanyIds.map((companyId) => `client:${companyId}`),
        ].sort();
        for (const laneKey of laneKeys) {
          const separator = laneKey.indexOf(":");
          const kind = laneKey.slice(0, separator);
          const companyId = laneKey.slice(separator + 1);
          yield* sql`
            select pg_advisory_xact_lock(
              hashtext(${kind === "publisher" ? `brief:publisher-members:${companyId}` : `brief:client-members:${companyId}`})
            )
          `;
        }
        yield* sql`
          select id
          from platform_users
          where id = ${identity.userId}
          for share
        `;
        if (clientCompanyIds.length > 0) {
          yield* sql`
            select id
            from client_companies
            where ${sql.in("id", clientCompanyIds)}
            order by id::text
            for share
          `;
        }
        const authorized = yield* selectAuthorizedPublisherDocument(identity, issueId, documentId);
        if (authorized === null) return null;
        return yield* operation(authorized);
      }),
    );
  });
