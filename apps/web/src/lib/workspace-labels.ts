import { useIntl } from "@hartlib/i18n";

type Intl = ReturnType<typeof useIntl>;

const roleKeys: Readonly<Record<string, string>> = {
  admin: "workspace.role.admin",
  manager: "workspace.role.manager",
  member: "workspace.role.member",
  support: "workspace.role.support",
  security: "workspace.role.security",
  legal: "workspace.role.legal",
};

const stateKeys: Readonly<Record<string, string>> = {
  creating: "workspace.state.creating",
  pending: "workspace.state.pending",
  queued: "workspace.state.queued",
  running: "workspace.state.running",
  accepted: "workspace.state.accepted",
  active: "workspace.state.active",
  invited: "workspace.state.invited",
  ending: "workspace.state.ending",
  trialing: "workspace.state.trialing",
  approved: "workspace.state.approved",
  completed: "workspace.state.completed",
  ready: "workspace.state.ready",
  revoked: "workspace.state.revoked",
  rejected: "workspace.state.rejected",
  denied: "workspace.state.denied",
  failed: "workspace.state.failed",
  flagged: "workspace.state.flagged",
  inactive: "workspace.state.inactive",
  paused: "workspace.state.paused",
  past_due: "workspace.state.pastDue",
  cancelled: "workspace.state.cancelled",
  requested: "workspace.state.requested",
  extracting: "workspace.state.extracting",
  indexing: "workspace.state.indexing",
};

const scopeKeys: Readonly<Record<string, string>> = {
  publisher_file: "workspace.scope.publisherFile",
  publisher_text: "workspace.scope.publisherText",
  client_chat: "workspace.scope.clientChat",
  client_memory: "workspace.scope.clientMemory",
};

const errorKeys: Readonly<Record<string, string>> = {
  document_open_popup_blocked: "workspace.error.popupBlocked",
  support_content_popup_blocked: "workspace.error.popupBlocked",
  export_download_popup_blocked: "workspace.error.popupBlocked",
  document_open_401: "workspace.error.accessDenied",
  document_open_403: "workspace.error.accessDenied",
  document_open_404: "workspace.error.notFound",
  unauthorized: "workspace.error.accessDenied",
  forbidden: "workspace.error.accessDenied",
  mfa_required: "workspace.error.mfaRequired",
  web_research_deployment_unavailable: "workspace.error.webUnavailable",
  billing_unavailable: "workspace.error.billingUnavailable",
  stripe_request_failed: "workspace.error.billingUnavailable",
  last_admin_required: "workspace.error.lastAdmin",
  export_subscription_required: "workspace.error.exportAccess",
};

export const workspaceRoleLabel = (intl: Intl, role: string): string =>
  intl.formatMessage({ id: roleKeys[role] ?? "workspace.value.unknown" });

export const workspaceStateLabel = (intl: Intl, state: string): string =>
  intl.formatMessage({ id: stateKeys[state] ?? "workspace.value.unknown" });

export const workspaceScopeLabel = (intl: Intl, scope: string): string =>
  intl.formatMessage({ id: scopeKeys[scope] ?? "workspace.value.unknown" });

export const workspaceErrorLabel = (intl: Intl, error: unknown): string => {
  const code =
    typeof error === "string"
      ? error
      : typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : error instanceof Error
          ? error.message
          : "";
  return intl.formatMessage({ id: errorKeys[code] ?? "workspace.error.generic" });
};
