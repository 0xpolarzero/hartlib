import { useIntl, useLocale } from "@brief/i18n";
import type {
  ClientMemberDescriptor,
  ClientSubscriptionAccessDescriptor,
  PublisherMemberDescriptor,
  PublisherSubscriptionDescriptor,
} from "@brief/shared";
import { Button, Input, Label } from "@brief/ui";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { useState } from "react";

import { clientNavigation } from "@/components/client/client-archive-page";
import {
  StateBadge,
  WorkspacePage,
  WorkspaceSection,
  WorkspaceState,
} from "@/components/layout/workspace-page";
import { publisherNavigation } from "@/components/publisher/publisher-workspace-page";
import {
  clientInvitationCollection,
  clientMemberCollection,
  clientSubscriptionAccessCollection,
  publisherInvitationCollection,
  publisherMemberCollection,
  publisherSubscriptionCollection,
} from "@/lib/db";
import {
  deleteClientMember,
  deletePublisherMember,
  inviteClientMember,
  invitePublisherMember,
  setClientMemberSubscriptionGrant,
  updateClientMember,
  updatePublisherMember,
} from "@/lib/platform-api";
import { workspaceRoleLabel, workspaceStateLabel } from "@/lib/workspace-labels";

const toggle = (values: readonly string[], value: string): readonly string[] =>
  values.includes(value) ? values.filter((item) => item !== value) : [...values, value];

const formatDate = (value: string | null, locale: string): string =>
  value === null
    ? "—"
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      );

export function PublisherTeamPage({ companyId }: { readonly companyId: string }) {
  const intl = useIntl();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "manager" | "member">("member");
  const [subscriptionIds, setSubscriptionIds] = useState<readonly string[]>([]);
  const members = useLiveQuery(publisherMemberCollection(companyId));
  const invitations = useLiveQuery(publisherInvitationCollection(companyId));
  const subscriptions = useLiveQuery(publisherSubscriptionCollection(companyId));
  const invite = useMutation({
    mutationFn: () =>
      invitePublisherMember(companyId, {
        email: email.trim().toLowerCase(),
        role,
        subscriptionIds: role === "admin" ? [] : subscriptionIds,
      }),
    onSuccess: () => {
      setEmail("");
      setRole("member");
      setSubscriptionIds([]);
      void queryClient.invalidateQueries({ queryKey: ["publisher-team", companyId] });
    },
  });

  return (
    <WorkspacePage
      eyebrow={intl.formatMessage({ id: "workspace.publisher.eyebrow" })}
      title={intl.formatMessage({ id: "workspace.publisher.title" })}
      navigation={publisherNavigation(companyId, "team", (id) => intl.formatMessage({ id }))}
    >
      <div className="space-y-9">
        <WorkspaceSection
          title={intl.formatMessage({ id: "workspace.team.invite.title" })}
          description={intl.formatMessage({ id: "workspace.team.publisher.description" })}
        >
          <form
            className="grid gap-4 rounded-sm border border-rule bg-paper p-5 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (email.trim() !== "" && (role === "admin" || subscriptionIds.length > 0)) {
                invite.mutate();
              }
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="publisher-invite-email">
                {intl.formatMessage({ id: "workspace.team.email" })}
              </Label>
              <Input
                id="publisher-invite-email"
                type="email"
                value={email}
                maxLength={320}
                required
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <RoleSelect
              id="publisher-invite-role"
              label={intl.formatMessage({ id: "workspace.team.role" })}
              value={role}
              roles={["admin", "manager", "member"]}
              onChange={(value) => {
                setRole(value as typeof role);
                if (value === "admin") setSubscriptionIds([]);
              }}
            />
            {role === "admin" ? (
              <p className="text-sm text-muted sm:col-span-2">
                {intl.formatMessage({ id: "workspace.team.publisher.adminAll" })}
              </p>
            ) : (
              <ScopePicker
                legend={intl.formatMessage({ id: "workspace.team.subscriptions" })}
                items={subscriptions.data ?? []}
                selected={subscriptionIds}
                getId={(item) => item.id}
                getLabel={(item) => item.name}
                onToggle={(id) => setSubscriptionIds(toggle(subscriptionIds, id))}
              />
            )}
            <div className="flex justify-end sm:col-span-2">
              <Button
                type="submit"
                disabled={
                  invite.isPending ||
                  email.trim() === "" ||
                  (role !== "admin" && subscriptionIds.length === 0)
                }
              >
                <UserPlus className="size-4" aria-hidden="true" />
                {intl.formatMessage({ id: "workspace.team.invite.action" })}
              </Button>
            </div>
          </form>
          {invite.isError ? <MutationError /> : null}
        </WorkspaceSection>

        <WorkspaceSection title={intl.formatMessage({ id: "workspace.team.members.title" })}>
          {members.isLoading || invitations.isLoading || subscriptions.isLoading ? (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
          ) : members.isError || invitations.isError || subscriptions.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.unavailable" })}
            />
          ) : members.data.length === 0 ? (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.team.members.empty" })} />
          ) : (
            <div className="space-y-3">
              {members.data.map((member) => (
                <PublisherMemberEditor
                  key={member.userId}
                  companyId={companyId}
                  member={member}
                  subscriptions={subscriptions.data}
                />
              ))}
            </div>
          )}
        </WorkspaceSection>

        <WorkspaceSection title={intl.formatMessage({ id: "workspace.team.invitations.title" })}>
          {invitations.data.length ? (
            <div className="divide-y divide-rule rounded-sm border border-rule bg-paper">
              {invitations.data.map((invitation) => (
                <article key={invitation.id} className="flex flex-wrap justify-between gap-3 p-4">
                  <div>
                    <p className="text-sm font-medium text-ink">{invitation.email}</p>
                    <p className="mt-1 text-xs text-muted">
                      {workspaceRoleLabel(intl, invitation.role)} ·{" "}
                      {invitation.subscriptionIds.length}{" "}
                      {intl.formatMessage({ id: "workspace.team.scopeCount" })}
                    </p>
                    <p className="mt-1 font-mono text-[11px] text-faint">
                      {formatDate(invitation.expiresAt, locale)}
                    </p>
                  </div>
                  <StateBadge
                    state={invitation.state === "failed" ? "failed" : "pending"}
                    label={workspaceStateLabel(intl, invitation.state)}
                  />
                </article>
              ))}
            </div>
          ) : (
            <WorkspaceState
              title={intl.formatMessage({ id: "workspace.team.invitations.empty" })}
            />
          )}
        </WorkspaceSection>
      </div>
    </WorkspacePage>
  );
}

function PublisherMemberEditor({
  companyId,
  member,
  subscriptions,
}: {
  readonly companyId: string;
  readonly member: PublisherMemberDescriptor;
  readonly subscriptions: readonly PublisherSubscriptionDescriptor[];
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [role, setRole] = useState(member.role);
  const [subscriptionIds, setSubscriptionIds] = useState<readonly string[]>(member.subscriptionIds);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["publisher-team", companyId] });
  const save = useMutation({
    mutationFn: () =>
      updatePublisherMember(companyId, member.userId, {
        role,
        subscriptionIds: role === "admin" ? [] : subscriptionIds,
      }),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: () => deletePublisherMember(companyId, member.userId),
    onSettled: refresh,
  });
  return (
    <article className="rounded-sm border border-rule bg-paper p-4">
      <p className="font-mono text-xs text-ink">{member.invitedEmail ?? member.userId}</p>
      <p className="mt-1 font-mono text-[11px] text-faint">{member.userId}</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <RoleSelect
          id={`publisher-role-${member.userId}`}
          label={intl.formatMessage({ id: "workspace.team.role" })}
          value={role}
          roles={["admin", "manager", "member"]}
          onChange={(value) => setRole(value as typeof role)}
        />
        {role === "admin" ? (
          <p className="self-end pb-2 text-sm text-muted">
            {intl.formatMessage({ id: "workspace.team.publisher.adminAll" })}
          </p>
        ) : (
          <ScopePicker
            legend={intl.formatMessage({ id: "workspace.team.subscriptions" })}
            items={subscriptions}
            selected={subscriptionIds}
            getId={(item) => item.id}
            getLabel={(item) => item.name}
            onToggle={(id) => setSubscriptionIds(toggle(subscriptionIds, id))}
          />
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>
          {intl.formatMessage({ id: "action.delete" })}
        </Button>
        <Button
          disabled={save.isPending || (role !== "admin" && subscriptionIds.length === 0)}
          onClick={() => save.mutate()}
        >
          {intl.formatMessage({ id: "workspace.team.save" })}
        </Button>
      </div>
      {save.isError || remove.isError ? <MutationError /> : null}
    </article>
  );
}

export function ClientTeamPage({ companyId }: { readonly companyId: string }) {
  const intl = useIntl();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [accessIds, setAccessIds] = useState<readonly string[]>([]);
  const members = useLiveQuery(clientMemberCollection(companyId));
  const invitations = useLiveQuery(clientInvitationCollection(companyId));
  const accesses = useLiveQuery(clientSubscriptionAccessCollection(companyId));
  const invite = useMutation({
    mutationFn: () =>
      inviteClientMember(companyId, {
        email: email.trim().toLowerCase(),
        role,
        subscriptionAccessIds: accessIds,
      }),
    onSuccess: () => {
      setEmail("");
      setRole("member");
      setAccessIds([]);
      void queryClient.invalidateQueries({ queryKey: ["client-team", companyId] });
    },
  });

  return (
    <WorkspacePage
      eyebrow={intl.formatMessage({ id: "workspace.client.eyebrow" })}
      title={intl.formatMessage({ id: "workspace.client.title" })}
      navigation={clientNavigation(companyId, "team", (id) => intl.formatMessage({ id }))}
    >
      <div className="space-y-9">
        <WorkspaceSection
          title={intl.formatMessage({ id: "workspace.team.invite.title" })}
          description={intl.formatMessage({ id: "workspace.team.client.description" })}
        >
          <form
            className="grid gap-4 rounded-sm border border-rule bg-paper p-5 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (email.trim() !== "") invite.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="client-invite-email">
                {intl.formatMessage({ id: "workspace.team.email" })}
              </Label>
              <Input
                id="client-invite-email"
                type="email"
                value={email}
                maxLength={320}
                required
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <RoleSelect
              id="client-invite-role"
              label={intl.formatMessage({ id: "workspace.team.role" })}
              value={role}
              roles={["admin", "member"]}
              onChange={(value) => setRole(value as typeof role)}
            />
            <ScopePicker
              legend={intl.formatMessage({ id: "workspace.team.subscriptions" })}
              items={accesses.data ?? []}
              selected={accessIds}
              getId={(item) => item.accessId}
              getLabel={(item) => `${item.publisherName} · ${item.subscriptionName}`}
              onToggle={(id) => setAccessIds(toggle(accessIds, id))}
            />
            <div className="flex items-end justify-end sm:col-span-2">
              <Button type="submit" disabled={invite.isPending || email.trim() === ""}>
                <UserPlus className="size-4" aria-hidden="true" />
                {intl.formatMessage({ id: "workspace.team.invite.action" })}
              </Button>
            </div>
          </form>
          {invite.isError ? <MutationError /> : null}
        </WorkspaceSection>

        <WorkspaceSection title={intl.formatMessage({ id: "workspace.team.members.title" })}>
          {members.isLoading || invitations.isLoading || accesses.isLoading ? (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
          ) : members.isError || invitations.isError || accesses.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.unavailable" })}
            />
          ) : members.data.length === 0 ? (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.team.members.empty" })} />
          ) : (
            <div className="space-y-3">
              {members.data.map((member) => (
                <ClientMemberEditor
                  key={member.userId}
                  companyId={companyId}
                  member={member}
                  accesses={accesses.data}
                />
              ))}
            </div>
          )}
        </WorkspaceSection>

        <WorkspaceSection title={intl.formatMessage({ id: "workspace.team.invitations.title" })}>
          {invitations.data.length ? (
            <div className="divide-y divide-rule rounded-sm border border-rule bg-paper">
              {invitations.data.map((invitation) => (
                <article key={invitation.id} className="flex flex-wrap justify-between gap-3 p-4">
                  <div>
                    <p className="text-sm font-medium text-ink">{invitation.email}</p>
                    <p className="mt-1 text-xs text-muted">
                      {workspaceRoleLabel(intl, invitation.role)} ·{" "}
                      {invitation.subscriptionAccessIds.length}{" "}
                      {intl.formatMessage({ id: "workspace.team.scopeCount" })}
                    </p>
                    <p className="mt-1 font-mono text-[11px] text-faint">
                      {formatDate(invitation.expiresAt, locale)}
                    </p>
                  </div>
                  <StateBadge
                    state={invitation.state === "failed" ? "failed" : "pending"}
                    label={workspaceStateLabel(intl, invitation.state)}
                  />
                </article>
              ))}
            </div>
          ) : (
            <WorkspaceState
              title={intl.formatMessage({ id: "workspace.team.invitations.empty" })}
            />
          )}
        </WorkspaceSection>
      </div>
    </WorkspacePage>
  );
}

function ClientMemberEditor({
  companyId,
  member,
  accesses,
}: {
  readonly companyId: string;
  readonly member: ClientMemberDescriptor;
  readonly accesses: readonly ClientSubscriptionAccessDescriptor[];
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [role, setRole] = useState(member.role);
  const [accessIds, setAccessIds] = useState<readonly string[]>(member.subscriptionAccessIds);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["client-team", companyId] });
  const save = useMutation({
    mutationFn: async () => {
      await updateClientMember(companyId, member.userId, role);
      const desired = new Set(accessIds);
      const current = new Set(member.subscriptionAccessIds);
      await Promise.all([
        ...accessIds
          .filter((id) => !current.has(id))
          .map((id) => setClientMemberSubscriptionGrant(companyId, member.userId, id, true)),
        ...member.subscriptionAccessIds
          .filter((id) => !desired.has(id))
          .map((id) => setClientMemberSubscriptionGrant(companyId, member.userId, id, false)),
      ]);
    },
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: () => deleteClientMember(companyId, member.userId),
    onSettled: refresh,
  });
  return (
    <article className="rounded-sm border border-rule bg-paper p-4">
      <p className="font-mono text-xs text-ink">{member.userId}</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <RoleSelect
          id={`client-role-${member.userId}`}
          label={intl.formatMessage({ id: "workspace.team.role" })}
          value={role}
          roles={["admin", "member"]}
          onChange={(value) => setRole(value as typeof role)}
        />
        <ScopePicker
          legend={intl.formatMessage({ id: "workspace.team.subscriptions" })}
          items={accesses}
          selected={accessIds}
          getId={(item) => item.accessId}
          getLabel={(item) => `${item.publisherName} · ${item.subscriptionName}`}
          onToggle={(id) => setAccessIds(toggle(accessIds, id))}
        />
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>
          {intl.formatMessage({ id: "action.delete" })}
        </Button>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {intl.formatMessage({ id: "workspace.team.save" })}
        </Button>
      </div>
      {save.isError || remove.isError ? <MutationError /> : null}
    </article>
  );
}

function RoleSelect({
  id,
  label,
  value,
  roles,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly roles: readonly string[];
  readonly onChange: (value: string) => void;
}) {
  const intl = useIntl();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value}
        className="h-9 w-full rounded-sm border border-input bg-canvas px-3 text-sm"
        onChange={(event) => onChange(event.target.value)}
      >
        {roles.map((role) => (
          <option key={role} value={role}>
            {workspaceRoleLabel(intl, role)}
          </option>
        ))}
      </select>
    </div>
  );
}

function ScopePicker<Item>({
  legend,
  items,
  selected,
  getId,
  getLabel,
  onToggle,
}: {
  readonly legend: string;
  readonly items: readonly Item[];
  readonly selected: readonly string[];
  readonly getId: (item: Item) => string;
  readonly getLabel: (item: Item) => string;
  readonly onToggle: (id: string) => void;
}) {
  return (
    <fieldset className="space-y-2 sm:col-span-2">
      <legend className="text-sm font-medium text-ink">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {items.map((item) => {
          const id = getId(item);
          return (
            <label
              key={id}
              className="flex items-center gap-2 rounded-sm border border-rule px-3 py-2 text-sm text-muted"
            >
              <input
                type="checkbox"
                checked={selected.includes(id)}
                onChange={() => onToggle(id)}
              />
              {getLabel(item)}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function MutationError() {
  const intl = useIntl();
  return (
    <WorkspaceState tone="danger" title={intl.formatMessage({ id: "workspace.actionFailed" })} />
  );
}
