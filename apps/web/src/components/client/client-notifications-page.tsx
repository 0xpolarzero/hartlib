import { type Locale, useIntl, useLocale } from "@hartlib/i18n";
import { Button } from "@hartlib/ui";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Check } from "lucide-react";

import {
  WorkspacePage,
  WorkspaceSection,
  WorkspaceState,
} from "@/components/layout/workspace-page";
import {
  getNotificationPreferences,
  listNotifications,
  markNotificationRead,
  updateNotificationPreferences,
} from "@/lib/platform-api";
import { clientNavigation } from "./client-archive-page";

const formatDate = (value: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );

export const notificationEmailLocaleOptions = [
  "fr-FR",
  "en-US",
] as const satisfies readonly Locale[];

export function NotificationEmailLocaleSelect({
  value,
  disabled,
  onChange,
}: {
  readonly value: Locale;
  readonly disabled: boolean;
  readonly onChange: (locale: Locale) => void;
}) {
  const intl = useIntl();
  return (
    <select
      aria-label={intl.formatMessage({ id: "workspace.notifications.emailLocale" })}
      className="rounded-sm border border-rule bg-paper px-2 py-1 text-sm text-ink"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as Locale)}
    >
      {notificationEmailLocaleOptions.map((option) => (
        <option key={option} value={option}>
          {intl.formatMessage({
            id: option === "fr-FR" ? "localeSwitcher.frFR" : "localeSwitcher.enUS",
          })}
        </option>
      ))}
    </select>
  );
}

export function ClientNotificationsPage({ companyId }: { readonly companyId: string }) {
  const intl = useIntl();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const notifications = useInfiniteQuery({
    queryKey: ["notifications", companyId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => listNotifications(companyId, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const preferences = useQuery({
    queryKey: ["notification-preferences", companyId],
    queryFn: () => getNotificationPreferences(companyId),
  });
  const markRead = useMutation({
    mutationFn: markNotificationRead,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["notifications", companyId] }),
  });
  const updatePreferences = useMutation({
    mutationFn: (next: {
      readonly locale: Locale;
      readonly emailIssuePublished: boolean;
      readonly emailDeliveryReminders: boolean;
      readonly emailUsageLimits: boolean;
    }) => updateNotificationPreferences(companyId, next),
    onSuccess: (next) => queryClient.setQueryData(["notification-preferences", companyId], next),
  });
  const rows = notifications.data?.pages.flatMap((page) => page.notifications) ?? [];

  return (
    <WorkspacePage
      eyebrow={intl.formatMessage({ id: "workspace.client.eyebrow" })}
      title={intl.formatMessage({ id: "workspace.client.title" })}
      navigation={clientNavigation(companyId, "notifications", (id) => intl.formatMessage({ id }))}
    >
      <div className="space-y-9">
        <WorkspaceSection
          title={intl.formatMessage({ id: "workspace.notifications.title" })}
          description={intl.formatMessage({ id: "workspace.notifications.description" })}
        >
          {notifications.isPending ? (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
          ) : notifications.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.unavailable" })}
            />
          ) : rows.length === 0 ? (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.notifications.empty" })} />
          ) : (
            <div className="divide-y divide-rule rounded-sm border border-rule bg-paper">
              {rows.map((notification) => (
                <article
                  key={notification.id}
                  className={`flex items-start gap-3 p-4 ${notification.readAt === null ? "bg-accent-soft/35" : ""}`}
                >
                  <Bell
                    className={`mt-0.5 size-4 shrink-0 ${notification.readAt === null ? "text-accent" : "text-faint"}`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">
                      {intl.formatMessage({
                        id: `workspace.notificationKind.${notification.kind}`,
                      })}
                    </p>
                    <p className="mt-1 font-mono text-[11px] text-faint">
                      {formatDate(notification.createdAt, locale)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {notification.issueId === null ? null : (
                      <Button asChild size="sm" variant="ghost">
                        <a
                          href={`/${locale}/client/${encodeURIComponent(companyId)}/issues/${encodeURIComponent(notification.issueId)}`}
                          onClick={() => {
                            if (notification.readAt === null) markRead.mutate(notification.id);
                          }}
                        >
                          {intl.formatMessage({ id: "workspace.notifications.open" })}
                        </a>
                      </Button>
                    )}
                    {notification.readAt === null ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        disabled={markRead.isPending}
                        aria-label={intl.formatMessage({ id: "workspace.notifications.markRead" })}
                        onClick={() => markRead.mutate(notification.id)}
                      >
                        <Check className="size-4" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}
          {notifications.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                disabled={notifications.isFetchingNextPage}
                onClick={() => void notifications.fetchNextPage()}
              >
                {intl.formatMessage({ id: "workspace.loadMore" })}
              </Button>
            </div>
          ) : null}
        </WorkspaceSection>

        <WorkspaceSection
          title={intl.formatMessage({ id: "workspace.notifications.preferencesTitle" })}
          description={intl.formatMessage({ id: "workspace.notifications.preferencesDescription" })}
        >
          {preferences.isPending ? (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
          ) : preferences.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.unavailable" })}
            />
          ) : (
            <div className="space-y-1 rounded-sm border border-rule bg-paper p-2">
              <label className="flex items-center justify-between gap-4 rounded-sm px-3 py-3 text-sm text-ink hover:bg-surface">
                <span>{intl.formatMessage({ id: "workspace.notifications.emailLocale" })}</span>
                <NotificationEmailLocaleSelect
                  value={preferences.data.locale}
                  disabled={updatePreferences.isPending}
                  onChange={(nextLocale) =>
                    updatePreferences.mutate({
                      ...preferences.data,
                      locale: nextLocale,
                    })
                  }
                />
              </label>
              {(
                [
                  ["emailIssuePublished", "workspace.notifications.emailIssuePublished"],
                  ["emailDeliveryReminders", "workspace.notifications.emailDeliveryReminders"],
                  ["emailUsageLimits", "workspace.notifications.emailUsageLimits"],
                ] as const
              ).map(([key, label]) => (
                <label
                  key={key}
                  className="flex items-center justify-between gap-4 rounded-sm px-3 py-3 text-sm text-ink hover:bg-surface"
                >
                  <span>{intl.formatMessage({ id: label })}</span>
                  <input
                    type="checkbox"
                    checked={preferences.data[key]}
                    disabled={updatePreferences.isPending}
                    onChange={(event) =>
                      updatePreferences.mutate({
                        ...preferences.data,
                        [key]: event.target.checked,
                      })
                    }
                  />
                </label>
              ))}
            </div>
          )}
          {updatePreferences.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.actionFailed" })}
            />
          ) : null}
        </WorkspaceSection>
      </div>
    </WorkspacePage>
  );
}
