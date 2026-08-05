import { useIntl, useLocale } from "@hartlib/i18n";
import { useQuery } from "@tanstack/react-query";

import { getCurrentUserWorkspaces } from "@/lib/platform-api";
import { workspaceRoleLabel } from "@/lib/workspace-labels";

export function useCurrentWorkspaces() {
  return useQuery({
    queryKey: ["current-user-workspaces"],
    queryFn: getCurrentUserWorkspaces,
  });
}

export function WorkspaceSwitcher({ pathname }: { readonly pathname: string }) {
  const intl = useIntl();
  const locale = useLocale();
  const workspaces = useCurrentWorkspaces();
  const all = [
    ...(workspaces.data?.publisherWorkspaces ?? []),
    ...(workspaces.data?.clientWorkspaces ?? []),
  ];
  const selected =
    all.find((workspace) => pathname.includes(workspace.landingPath))?.landingPath ?? "";

  if (workspaces.isPending) {
    return (
      <span className="px-2 text-xs text-faint">
        {intl.formatMessage({ id: "workspace.loading" })}
      </span>
    );
  }
  if (workspaces.isError || all.length === 0) return null;
  return (
    <>
      <label className="sr-only" htmlFor="workspace-switcher">
        {intl.formatMessage({ id: "workspace.switcher.label" })}
      </label>
      <select
        id="workspace-switcher"
        className="ml-1 h-8 max-w-52 rounded-sm border border-rule bg-canvas px-2 text-xs text-ink"
        value={selected}
        onChange={(event) => {
          if (event.target.value !== "") {
            window.location.assign(`/${locale}${event.target.value}`);
          }
        }}
      >
        <option value="">{intl.formatMessage({ id: "workspace.switcher.placeholder" })}</option>
        {workspaces.data.publisherWorkspaces.length > 0 ? (
          <optgroup label={intl.formatMessage({ id: "role.publisher" })}>
            {workspaces.data.publisherWorkspaces.map((workspace) => (
              <option key={`publisher:${workspace.companyId}`} value={workspace.landingPath}>
                {workspace.companyName} · {workspaceRoleLabel(intl, workspace.role)}
              </option>
            ))}
          </optgroup>
        ) : null}
        {workspaces.data.clientWorkspaces.length > 0 ? (
          <optgroup label={intl.formatMessage({ id: "role.client" })}>
            {workspaces.data.clientWorkspaces.map((workspace) => (
              <option key={`client:${workspace.companyId}`} value={workspace.landingPath}>
                {workspace.companyName} · {workspaceRoleLabel(intl, workspace.role)}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </>
  );
}
