import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";

import {
  appendAuthorizationAudit,
  auditDeniedThenFail,
  requireClientCompanyAdmin,
  WorkspaceAuthorizationError,
  type WorkspaceIdentity,
} from "./common";

export interface DemoPublicSourceSetting {
  readonly sourceId: string;
  readonly enabled: boolean;
}

const sourceExists = (sourceId: string, market?: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows =
      market === undefined
        ? yield* sql<{ readonly exists: boolean }>`
          select exists(
            select 1 from public_sources where source_id = ${sourceId}
          ) as exists
        `
        : yield* sql<{ readonly exists: boolean }>`
          select exists(
            select 1 from public_sources
            where source_id = ${sourceId} and country = ${market}
          ) as exists
        `;
    return rows[0]?.exists === true;
  });

/**
 * Toggle one public source in the demo company. Authorization, mutation, and
 * audit share one transaction and one company advisory lock.
 */
export const updateDemoPublicSource = (input: {
  readonly identity: WorkspaceIdentity;
  readonly companyId: string;
  readonly sourceId: string;
  readonly enabled: boolean;
  readonly market?: string;
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
        if (!(yield* sourceExists(input.sourceId, input.market))) {
          return yield* Effect.fail(new WorkspaceAuthorizationError("not_found"));
        }
        const rows = yield* sql<DemoPublicSourceSetting>`
          insert into client_company_public_source_settings (
            client_company_id, source_id, enabled, updated_by_user_id
          ) values (
            ${input.companyId}, ${input.sourceId}, ${input.enabled}, ${input.identity.userId}
          )
          on conflict (client_company_id, source_id) do update set
            enabled = excluded.enabled,
            updated_by_user_id = excluded.updated_by_user_id,
            updated_at = now()
          returning source_id as "sourceId", enabled
        `;
        const row = rows[0];
        if (row === undefined) {
          return yield* Effect.fail(new Error("public_source_toggle_not_persisted"));
        }
        yield* appendAuthorizationAudit({
          identity: input.identity,
          requestId: input.requestId,
          action: "client.public_source.update",
          scopeKind: "public_source",
          scopeId: input.sourceId,
          outcome: "succeeded",
        });
        return row;
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
