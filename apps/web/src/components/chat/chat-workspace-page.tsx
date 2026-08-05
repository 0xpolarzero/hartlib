import { useIntl, useLocale } from "@hartlib/i18n";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  ConfirmingDeleteButton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@hartlib/ui";
import { useForm } from "@tanstack/react-form";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LockKeyhole, MessagesSquare, Share2, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  WorkspacePage,
  WorkspaceSection,
  WorkspaceState,
} from "@/components/layout/workspace-page";
import {
  createChat,
  deleteChat,
  setChatShared,
  type ChatListView,
  type ChatSummary,
} from "@/lib/api";
import {
  chatListCollection,
  clientSubscriptionAccessCollection,
  invalidateProductChatCollections,
} from "@/lib/db";
import { buildCreateChatInput } from "@/lib/chat-form";
import { workspaceErrorLabel, workspaceStateLabel } from "@/lib/workspace-labels";

const dateLabel = (value: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );

export function ChatWorkspacePage({
  companyId,
  initialView = "mine",
}: {
  readonly companyId: string;
  readonly initialView?: ChatListView;
}) {
  const intl = useIntl();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [view, setView] = useState<ChatListView>(initialView);
  const chatsCollection = chatListCollection(view);
  const chats = useLiveQuery(chatsCollection);
  const sourcesCollection = clientSubscriptionAccessCollection(companyId);
  const sources = useLiveQuery(sourcesCollection);
  const initializedSources = useRef<string | null>(null);
  const sourceForm = useForm({
    defaultValues: { sourceAccessIds: [] as string[] },
  });
  useEffect(() => {
    if (!sources.isLoading && !sources.isError && initializedSources.current !== companyId) {
      sourceForm.setFieldValue(
        "sourceAccessIds",
        sources.data.map((source) => source.accessId),
      );
      initializedSources.current = companyId;
    }
  }, [companyId, sourceForm, sources.data, sources.isError, sources.isLoading]);
  const refresh = () => invalidateProductChatCollections(queryClient);
  const create = useMutation({
    mutationFn: (input: {
      readonly memoryMode: "private_owner" | "disabled";
      readonly sourceAccessIds: readonly string[];
    }) => createChat(buildCreateChatInput(companyId, input.memoryMode, input.sourceAccessIds)),
    onSuccess: (chat) => {
      void refresh();
      window.location.assign(`/${locale}/chat/${encodeURIComponent(chat.id)}`);
    },
  });
  const share = useMutation({
    mutationFn: ({ chatId, shared }: { readonly chatId: string; readonly shared: boolean }) =>
      setChatShared(chatId, shared),
    onSuccess: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: deleteChat,
    onSuccess: () => void refresh(),
  });
  const mutationError = create.error ?? share.error ?? remove.error;

  return (
    <WorkspacePage
      eyebrow={intl.formatMessage({ id: "workspace.client.eyebrow" })}
      title={intl.formatMessage({ id: "workspace.client.title" })}
      navigation={[
        {
          href: `/client/${companyId}`,
          label: intl.formatMessage({ id: "workspace.nav.archive" }),
        },
        {
          href: `/client/${companyId}/chats`,
          label: intl.formatMessage({ id: "workspace.nav.chats" }),
          active: true,
        },
        {
          href: `/client/${companyId}/notifications`,
          label: intl.formatMessage({ id: "workspace.nav.notifications" }),
        },
        {
          href: `/client/${companyId}/team`,
          label: intl.formatMessage({ id: "workspace.nav.team" }),
        },
        {
          href: `/client/${companyId}/billing`,
          label: intl.formatMessage({ id: "workspace.nav.billing" }),
        },
        {
          href: `/client/${companyId}/settings`,
          label: intl.formatMessage({ id: "workspace.nav.settings" }),
        },
      ]}
    >
      <div className="space-y-8">
        <WorkspaceSection
          title={intl.formatMessage({ id: "workspace.chats.title" })}
          description={intl.formatMessage({ id: "workspace.chats.description" })}
          action={
            <sourceForm.Subscribe selector={(state) => state.values.sourceAccessIds}>
              {(sourceAccessIds) => (
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    variant="outline"
                    disabled={create.isPending || sources.isLoading || sources.isError}
                    onClick={() => create.mutate({ memoryMode: "disabled", sourceAccessIds })}
                  >
                    <Users className="size-4" aria-hidden="true" />
                    {intl.formatMessage({ id: "workspace.chats.createShareable" })}
                  </Button>
                  <Button
                    disabled={create.isPending || sources.isLoading || sources.isError}
                    onClick={() => create.mutate({ memoryMode: "private_owner", sourceAccessIds })}
                  >
                    <LockKeyhole className="size-4" aria-hidden="true" />
                    {intl.formatMessage({ id: "workspace.chats.createPrivate" })}
                  </Button>
                </div>
              )}
            </sourceForm.Subscribe>
          }
        >
          <div className="rounded-sm border border-rule bg-paper p-4">
            <p className="text-sm font-medium text-ink">
              {intl.formatMessage({ id: "workspace.chats.sourcesTitle" })}
            </p>
            <p className="mt-1 text-xs text-muted">
              {intl.formatMessage({ id: "workspace.chats.sourcesDescription" })}
            </p>
            {sources.isLoading ? (
              <p className="mt-3 text-sm text-muted">
                {intl.formatMessage({ id: "workspace.loading" })}
              </p>
            ) : sources.isError ? (
              <WorkspaceState
                tone="danger"
                title={intl.formatMessage({ id: "workspace.unavailable" })}
                action={
                  <Button
                    variant="outline"
                    onClick={() => void sourcesCollection.utils.clearError()}
                  >
                    {intl.formatMessage({ id: "action.retry" })}
                  </Button>
                }
              />
            ) : (
              <sourceForm.Field name="sourceAccessIds">
                {(field) => (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {sources.data.map((source) => {
                      const checked = field.state.value.includes(source.accessId);
                      return (
                        <label
                          key={source.accessId}
                          className="flex cursor-pointer items-start gap-3 rounded-sm border border-rule p-3"
                        >
                          <input
                            className="mt-0.5 size-4"
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              field.handleChange(
                                checked
                                  ? field.state.value.filter((id) => id !== source.accessId)
                                  : [...field.state.value, source.accessId],
                              )
                            }
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-ink">
                              {source.publisherName} · {source.subscriptionName}
                            </span>
                            <span className="mt-0.5 block text-xs text-muted">
                              {workspaceStateLabel(intl, source.state)}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </sourceForm.Field>
            )}
          </div>
          {mutationError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.actionFailed" })}
              body={workspaceErrorLabel(intl, mutationError)}
            />
          ) : null}
          <Tabs value={view} onValueChange={(value) => setView(value as ChatListView)}>
            <TabsList>
              <TabsTrigger value="mine">
                {intl.formatMessage({ id: "workspace.chats.mine" })}
              </TabsTrigger>
              <TabsTrigger value="shared">
                {intl.formatMessage({ id: "workspace.chats.shared" })}
              </TabsTrigger>
              <TabsTrigger value="archived">
                {intl.formatMessage({ id: "workspace.chats.archived" })}
              </TabsTrigger>
            </TabsList>
            {(["mine", "shared", "archived"] as const).map((tab) => (
              <TabsContent key={tab} value={tab} className="mt-4">
                {view !== tab ? null : chats.isLoading ? (
                  <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
                ) : chats.isError ? (
                  <WorkspaceState
                    tone="danger"
                    title={intl.formatMessage({ id: "workspace.unavailable" })}
                    body={workspaceErrorLabel(intl, chatsCollection.utils.lastError)}
                    action={
                      <Button
                        variant="outline"
                        onClick={() => void chatsCollection.utils.clearError()}
                      >
                        {intl.formatMessage({ id: "action.retry" })}
                      </Button>
                    }
                  />
                ) : chats.data.length === 0 ? (
                  <WorkspaceState
                    title={intl.formatMessage({
                      id:
                        tab === "mine"
                          ? "workspace.chats.emptyMine"
                          : tab === "shared"
                            ? "workspace.chats.emptyShared"
                            : "workspace.chats.emptyArchived",
                    })}
                    {...(tab === "archived"
                      ? { body: intl.formatMessage({ id: "workspace.chats.archivedDescription" }) }
                      : {})}
                  />
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {chats.data.map((chat) => (
                      <ChatCard
                        key={chat.id}
                        chat={chat}
                        locale={locale}
                        manageable={tab === "mine" || tab === "archived"}
                        pending={share.isPending || remove.isPending}
                        onShare={(shared) => share.mutate({ chatId: chat.id, shared })}
                        onDelete={() => remove.mutate(chat.id)}
                      />
                    ))}
                  </div>
                )}
              </TabsContent>
            ))}
          </Tabs>
        </WorkspaceSection>
      </div>
    </WorkspacePage>
  );
}

function ChatCard({
  chat,
  locale,
  manageable,
  pending,
  onShare,
  onDelete,
}: {
  readonly chat: ChatSummary;
  readonly locale: string;
  readonly manageable: boolean;
  readonly pending: boolean;
  readonly onShare: (shared: boolean) => void;
  readonly onDelete: () => void;
}) {
  const intl = useIntl();
  const shareable = chat.memoryMode === "disabled";
  const archived = chat.archivedAt !== null;
  return (
    <Card className="shadow-none">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle className="truncate text-sm">
              {intl.formatMessage({ id: "workspace.chats.chatLabel" }, { id: chat.id.slice(0, 8) })}
            </CardTitle>
            <CardDescription className="mt-1">{dateLabel(chat.updatedAt, locale)}</CardDescription>
          </div>
          {chat.sharedAt === null ? (
            <LockKeyhole className="size-4 text-faint" />
          ) : (
            <Share2 className="size-4 text-accent" />
          )}
        </div>
      </CardHeader>
      <CardContent className="text-sm text-muted">
        {intl.formatMessage({ id: "workspace.chats.sourceCount" }, { count: chat.sourceCount })}
      </CardContent>
      <CardFooter className="flex flex-wrap justify-between gap-2 border-t border-rule pt-4">
        <Button asChild size="sm" variant="outline">
          <a href={`/${locale}/chat/${encodeURIComponent(chat.id)}`}>
            <MessagesSquare className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "workspace.chats.open" })}
          </a>
        </Button>
        {manageable ? (
          <div className="flex items-center gap-1">
            {shareable && !archived ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => onShare(chat.sharedAt === null)}
              >
                {intl.formatMessage({
                  id: chat.sharedAt === null ? "workspace.chats.share" : "workspace.chats.unshare",
                })}
              </Button>
            ) : chat.sharedAt !== null && archived ? (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => onShare(false)}>
                {intl.formatMessage({ id: "workspace.chats.unshare" })}
              </Button>
            ) : null}
            <ConfirmingDeleteButton
              idleLabel={intl.formatMessage({ id: "action.delete" })}
              confirmLabel={intl.formatMessage({ id: "action.confirm" })}
              onConfirm={onDelete}
            />
          </div>
        ) : null}
      </CardFooter>
    </Card>
  );
}
