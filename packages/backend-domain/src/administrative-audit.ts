import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";

export interface AdministrativeAuditOutcomeRow {
  readonly action: string;
  readonly scopeKind: string;
  readonly scopeId: string;
  readonly outcome: "succeeded" | "denied";
}

export const findAdministrativeAuditOutcomes = (requestId: string, actions: readonly string[]) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql<AdministrativeAuditOutcomeRow>`
      select action, scope_kind as "scopeKind", scope_id as "scopeId", outcome
      from platform_authorization_audit_log
      where request_id = ${requestId} and action = any(${actions}::text[])
      order by id
      limit 2
    `;
  });
