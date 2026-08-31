import { useState } from "react";
import { Bell, CalendarClock, Newspaper } from "lucide-react";
import { Button } from "../ui/button";
import { Badge } from "../ui/atoms";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/overlays";
import { formatDateTime, uiMessage } from "../../lib/format";
export interface PublisherNotification {
  id: string;
  kind: "delivered" | "scheduled" | string;
  publicationTitle: string;
  at: string;
  read?: boolean;
}
export function NotificationBell({
  items = [],
  loading = false,
  locale = "en-US",
  onOpenSettings,
  label,
  emptyLabel,
  defaultOpen = false,
}: {
  items?: readonly PublisherNotification[];
  loading?: boolean;
  locale?: string;
  onOpenSettings?: () => void;
  label?: string;
  emptyLabel?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const resolvedLabel = label ?? uiMessage(locale, "ui.notifications");
  const resolvedEmptyLabel = emptyLabel ?? uiMessage(locale, "ui.noNotifications");
  const unread = items.filter((item) => !item.read).length;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`${resolvedLabel}${unread ? `, ${unread} ${uiMessage(locale, "ui.unread")}` : ""}`}
          aria-busy={loading || undefined}
          className={loading ? "relative animate-pulse-soft" : "relative"}
        >
          <Bell className="size-3.5" />
          {unread > 0 && (
            <span
              aria-hidden="true"
              className="absolute right-1 top-1 size-1.5 rounded-full bg-accent ring-2 ring-paper"
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>
          {resolvedLabel}
          {unread > 0 && (
            <Badge tone="accent" className="ml-2">
              {unread}
            </Badge>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {loading ? (
          <div className="grid gap-2 p-2">
            <div className="h-8 animate-pulse-soft bg-paper-deep" />
            <div className="h-8 animate-pulse-soft bg-paper-deep" />
          </div>
        ) : items.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12.5px] text-ink-2">{resolvedEmptyLabel}</p>
        ) : (
          <ul role="none" className="max-h-72 overflow-y-auto">
            {items.map((item) => (
              <li
                key={item.id}
                role="menuitem"
                aria-disabled="true"
                tabIndex={-1}
                className="flex items-start gap-2.5 px-2 py-2"
              >
                {item.kind === "delivered" ? (
                  <Newspaper className="mt-0.5 size-3.5 text-ink-2" aria-hidden="true" />
                ) : (
                  <CalendarClock className="mt-0.5 size-3.5 text-ink-2" aria-hidden="true" />
                )}
                <div className="min-w-0">
                  <p className="truncate text-[12.5px]">{item.publicationTitle}</p>
                  <p className="font-mono text-[10.5px] text-ink-2">
                    {formatDateTime(locale, item.at)}
                    {!item.read && (
                      <span className="ml-1.5 text-accent">{uiMessage(locale, "ui.new")}</span>
                    )}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {onOpenSettings && (
          <>
            <DropdownMenuSeparator />
            <button
              type="button"
              role="menuitem"
              className="w-full px-2 py-1.5 text-left text-[12px] text-ink-2 hover:bg-paper-deep"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              {uiMessage(locale, "ui.notificationSettings")}
            </button>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
