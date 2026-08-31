import type { Route } from "../http";

const deniedReasonCodes = [
  "invalid_body",
  "invalid_request",
  "forbidden",
  "not_found",
  "request_failed",
] as const;

export interface AdministrativeMutationAuditPolicy {
  readonly method: Route["method"];
  readonly path: Route["path"];
  readonly actions: readonly [string, ...string[]];
  readonly fallbackAction: string;
  readonly scopeKind: string;
  readonly scopeParam?: string;
  readonly scopeId?: string;
  readonly succeededOutcome: "required";
  readonly deniedReasonCodes: typeof deniedReasonCodes;
}

const policy = (
  method: AdministrativeMutationAuditPolicy["method"],
  path: AdministrativeMutationAuditPolicy["path"],
  actions: AdministrativeMutationAuditPolicy["actions"],
  scopeKind: string,
  scopeParam?: string,
  scopeId?: string,
): AdministrativeMutationAuditPolicy => ({
  method,
  path,
  actions,
  fallbackAction: actions[0],
  scopeKind,
  ...(scopeParam === undefined ? {} : { scopeParam }),
  ...(scopeId === undefined ? {} : { scopeId }),
  succeededOutcome: "required",
  deniedReasonCodes,
});

/** The only administrative mutation retained by the demo product. */
export const administrativeMutationAuditMatrix = [
  policy(
    "PUT",
    "/v1/public-sources/:sourceId",
    ["client.public_source.update"],
    "public_source",
    "sourceId",
  ),
] as const satisfies ReadonlyArray<AdministrativeMutationAuditPolicy>;

export interface AuthenticatedMutationExemption {
  readonly method: Route["method"];
  readonly path: Route["path"];
  readonly reason:
    | "user_chat_content"
    | "personal_memory"
    | "personal_chat_lifecycle"
    | "demo_session";
}

export const authenticatedMutationAuditExemptions = [
  { method: "POST", path: "/v1/chat/messages", reason: "user_chat_content" },
  { method: "PATCH", path: "/v1/chat/messages/:messageId", reason: "user_chat_content" },
  { method: "DELETE", path: "/v1/chat/messages/:messageId", reason: "user_chat_content" },
  { method: "POST", path: "/v1/ai-runs/:runId/stop", reason: "personal_chat_lifecycle" },
  { method: "POST", path: "/v1/memories/:memoryId/revert", reason: "personal_memory" },
  { method: "DELETE", path: "/v1/memories/:memoryId", reason: "personal_memory" },
  { method: "POST", path: "/v1/demo/session", reason: "demo_session" },
  { method: "POST", path: "/v1/demo/session/reset", reason: "demo_session" },
] as const satisfies ReadonlyArray<AuthenticatedMutationExemption>;

export const mutationRouteKey = (method: string, path: string): string => `${method} ${path}`;

const policyByRoute = new Map(
  administrativeMutationAuditMatrix.map((entry) => [
    mutationRouteKey(entry.method, entry.path),
    entry,
  ]),
);

export const administrativeAuditPolicyFor = (
  method: string,
  path: string,
): AdministrativeMutationAuditPolicy | undefined =>
  policyByRoute.get(mutationRouteKey(method, path));
