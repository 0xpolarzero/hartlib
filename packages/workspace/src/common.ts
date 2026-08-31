import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

export interface WorkspaceIdentity {
  readonly userId: string;
  readonly sessionId: string;
}

export type WorkspaceAuthorizationErrorCode = "forbidden" | "not_found";

export class WorkspaceAuthorizationError extends Error {
  readonly name = "WorkspaceAuthorizationError";

  constructor(readonly code: WorkspaceAuthorizationErrorCode) {
    super(code);
  }
}

const requestIdUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const requestIdForAudit = (request: Request): string | null => {
  const supplied = request.headers.get("x-request-id");
  if (supplied === null) return crypto.randomUUID();
  return requestIdUuidPattern.test(supplied) ? supplied : null;
};

type ExistsRow = { readonly exists: boolean };

export const requireClientCompanyAdmin = (
  identity: WorkspaceIdentity,
  companyId: string,
): Effect.Effect<void, WorkspaceAuthorizationError | SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<ExistsRow>`
      select exists (
        select 1
        from client_company_memberships membership
        join client_companies company on company.id = membership.company_id
        join platform_users users on users.id = membership.user_id
        where membership.company_id = ${companyId}
          and membership.user_id = ${identity.userId}
          and membership.role = 'admin'
          and membership.revoked_at is null
      ) as exists
    `;
    if (rows[0]?.exists !== true) {
      return yield* Effect.fail(new WorkspaceAuthorizationError("forbidden"));
    }
  });

export const boundedAuthorizationReasonCode = (
  error: unknown,
  fallback = "authorization_denied",
): string => {
  const candidate =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : error instanceof Error
        ? error.message
        : fallback;
  return /^[a-z][a-z0-9_]{1,127}$/u.test(candidate) ? candidate : fallback;
};

export const appendAuthorizationAudit = (input: {
  readonly identity: WorkspaceIdentity;
  readonly requestId: string;
  readonly action: string;
  readonly scopeKind: string;
  readonly scopeId: string;
  readonly outcome: "succeeded" | "denied";
  readonly reasonCode?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      insert into platform_authorization_audit_log (
        actor_user_id, session_id, request_id, action, scope_kind, scope_id,
        outcome, reason_code
      ) values (
        ${input.identity.userId}, ${input.identity.sessionId}, ${input.requestId},
        ${input.action}, ${input.scopeKind}, ${input.scopeId}, ${input.outcome},
        ${input.reasonCode ?? null}
      )
      on conflict (request_id, action, scope_kind, scope_id) do nothing
    `;
  });

export const appendDeniedAuthorizationAudit = (input: {
  readonly identity: WorkspaceIdentity;
  readonly requestId: string;
  readonly action: string;
  readonly scopeKind: string;
  readonly scopeId: string;
  readonly error: unknown;
}) =>
  appendAuthorizationAudit({
    identity: input.identity,
    requestId: input.requestId,
    action: input.action,
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    outcome: "denied",
    reasonCode: boundedAuthorizationReasonCode(input.error),
  });

export const auditDeniedThenFail = <E>(
  identity: WorkspaceIdentity,
  requestId: string,
  action: string,
  scopeKind: string,
  scopeId: string,
  error: E,
) =>
  appendDeniedAuthorizationAudit({
    identity,
    requestId,
    action,
    scopeKind,
    scopeId,
    error,
  }).pipe(Effect.andThen(Effect.fail(error)));
